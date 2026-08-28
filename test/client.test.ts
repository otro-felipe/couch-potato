import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, resolveSocketPath } from "../src/client/index.js";
import { createCliConnector, runCli } from "../src/client/cli.js";
import type { Browser } from "../src/client/browser.js";

const servers: net.Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function bridge(handler: (request: any) => any) {
  const root = await mkdtemp(path.join(tmpdir(), "cp-client-"));
  const socketPath = path.join(root, "bridge.sock");
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data;
      for (;;) {
        const at = buffered.indexOf("\n");
        if (at < 0) break;
        const request = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        const response = handler(request);
        if (response !== undefined)
          socket.write(
            `${JSON.stringify({ protocol: "1", id: request.id, ...response })}\n`,
          );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe("Playwright-like client", () => {
  it("drives browser, pages, nested frames and locators", async () => {
    const calls: any[] = [];
    const socketPath = await bridge((request) => {
      calls.push(request);
      const method = request.method;
      if (method === "browser.listTabs")
        return {
          ok: true,
          result: [{ id: 1, title: "A", url: "https://a.test", active: true }],
        };
      if (method === "browser.activeTab")
        return {
          ok: true,
          result: { id: 1, title: "A", url: "https://a.test" },
        };
      if (method === "browser.openTab")
        return {
          ok: true,
          result: { id: 2, title: "B", url: request.params.url },
        };
      if (method === "page.screenshot") return { ok: true, result: "cGl4ZWxz" };
      if (method === "page.content")
        return { ok: true, result: "<html></html>" };
      if (method === "bridge.status")
        return { ok: true, result: { attachedTabIds: [1] } };
      if (method === "locator.textContent")
        return { ok: true, result: "Ready" };
      return { ok: true, result: null };
    });
    const browser = await connect({ socketPath });
    expect(await browser.listTabs()).toHaveLength(1);
    const page = await browser.activePage();
    expect(await browser.activePage()).toBe(page);
    const opened = await browser.openPage("https://b.test", { active: false });
    await page.goto("https://a.test/home", { waitUntil: "load" });
    await page.evaluate("value", { key: "x" });
    await page.evaluate("document.title");
    await page.content();
    expect(await page.screenshot({ format: "png", fullPage: true })).toEqual({
      base64: "cGl4ZWxz",
      mimeType: "image/png",
    });
    expect(await page.screenshot({ format: "jpeg" })).toEqual({
      base64: "cGl4ZWxz",
      mimeType: "image/jpeg",
    });
    await page.locator("#name").fill("private");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await page.getByText("Done").waitFor();
    const nested = opened.frameLocator("iframe.one").frameLocator("iframe.two");
    await expect(nested.content()).resolves.toBe("<html></html>");
    await nested.locator(".save").click({ timeoutMs: 2 });
    await nested.getByText("Ready", { exact: true }).textContent();
    await nested.getByRole("button").click();
    await opened.detach();
    await opened.detach();
    await browser.detachAll();
    browser.close();
    expect(
      calls.find((call) => call.method === "locator.fill").params.value,
    ).toBe("private");
    expect(
      calls.find((call) => call.params?.locator?.value === ".save").params
        .frameSelectors,
    ).toHaveLength(2);
    expect(
      calls.find(
        (call) => call.method === "page.content" && call.params?.frameSelectors,
      ).params.frameSelectors,
    ).toHaveLength(2);
  });
  it("surfaces protocol errors and invalid results", async () => {
    const errorPath = await bridge(() => ({
      ok: false,
      error: { code: "TAB_NOT_FOUND" },
    }));
    const errored = await connect({ socketPath: errorPath });
    await expect(errored.activePage()).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    errored.close();
    const invalidPath = await bridge(() => ({ ok: true, result: null }));
    const invalid = await connect({ socketPath: invalidPath });
    await expect(invalid.listTabs()).rejects.toThrow("tab list");
    await expect(invalid.activePage()).rejects.toThrow("invalid tab");
    invalid.close();
  });
  it("times out safely and rejects work after close", async () => {
    vi.useFakeTimers();
    const socketPath = await bridge(() => undefined);
    const browserPromise = connect({ socketPath, timeoutMs: 5 });
    await vi.runAllTimersAsync();
    const browser = await browserPromise;
    const pending = browser.status();
    const timedOut = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(6);
    await timedOut;
    browser.close();
    browser.close();
    await expect(browser.status()).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
  });
  it("fails closed for malformed, oversized and disconnected responses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cp-invalid-"));
    const malformedPath = path.join(root, "malformed.sock");
    const malformed = net.createServer((socket) =>
      socket.once("data", () => socket.write("not-json\n")),
    );
    servers.push(malformed);
    await new Promise<void>((resolve) =>
      malformed.listen(malformedPath, resolve),
    );
    const first = await connect({ socketPath: malformedPath });
    await expect(first.status()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    first.close();
    const largePath = path.join(root, "large.sock");
    const large = net.createServer((socket) =>
      socket.once("data", (data) => {
        const id = JSON.parse(data.toString().trim()).id;
        socket.write(
          `${JSON.stringify({ protocol: "1", id: "unknown", ok: true, result: null })}\n${"x".repeat(1024 * 1024 + 1)}`,
        );
      }),
    );
    servers.push(large);
    await new Promise<void>((resolve) => large.listen(largePath, resolve));
    const second = await connect({ socketPath: largePath });
    await expect(second.status()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    second.close();
    const closedPath = path.join(root, "closed.sock");
    const closed = net.createServer((socket) =>
      socket.once("data", () => socket.destroy()),
    );
    servers.push(closed);
    await new Promise<void>((resolve) => closed.listen(closedPath, resolve));
    const third = await connect({ socketPath: closedPath });
    await expect(third.status()).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
    third.close();
    await expect(
      connect({ socketPath: path.join(root, "missing.sock") }),
    ).rejects.toBeDefined();
    expect(resolveSocketPath({}, root)).toBe(
      path.join(
        root,
        "Library",
        "Application Support",
        "Couch Potato",
        "bridge.sock",
      ),
    );
    expect(resolveSocketPath({ socketPath: closedPath }, root)).toBe(
      closedPath,
    );
  });
  it("supports blank pages and rejects commands after detach", async () => {
    const socketPath = await bridge((request) =>
      request.method === "browser.openTab"
        ? { ok: true, result: { id: 9, title: "", url: "about:blank" } }
        : { ok: true, result: null },
    );
    const browser = await connect({ socketPath });
    const page = await browser.openPage();
    page.getByRole("button");
    await page.detach();
    await expect(page.locator("x").click()).rejects.toThrow("detached");
    browser.close();
  });
  it("validates status, tab and screenshot result shapes", async () => {
    for (const result of [
      null,
      {},
      { attachedTabIds: "bad" },
      { attachedTabIds: [0] },
    ]) {
      const socketPath = await bridge((request) =>
        request.method === "bridge.status"
          ? { ok: true, result }
          : { ok: true, result: null },
      );
      const browser = await connect({ socketPath });
      await expect(browser.detachAll()).rejects.toThrow("invalid status");
      browser.close();
    }
    const tabPath = await bridge((request) =>
      request.method === "browser.listTabs"
        ? {
            ok: true,
            result: [
              { id: 3, title: "A", url: "https://a.test", active: "invalid" },
            ],
          }
        : request.method === "browser.activeTab"
          ? { ok: true, result: { id: 3, title: 4, url: "x" } }
          : request.method === "page.screenshot"
            ? { ok: true, result: null }
            : { ok: true, result: null },
    );
    const browser = await connect({ socketPath: tabPath });
    expect(await browser.listTabs()).toEqual([
      { tabId: 3, title: "A", url: "https://a.test" },
    ]);
    await expect(browser.activePage()).rejects.toThrow("invalid tab");
    const pagePath = await bridge((request) =>
      request.method === "browser.openTab"
        ? { ok: true, result: { id: 4, title: "", url: "https://a.test" } }
        : request.method === "page.screenshot"
          ? { ok: true, result: null }
          : { ok: true, result: null },
    );
    const second = await connect({ socketPath: pagePath });
    const page = await second.openPage();
    await expect(page.screenshot()).rejects.toThrow("invalid screenshot");
    await expect(page.content()).rejects.toThrow("invalid page content");
    await expect(page.frameLocator("iframe").content()).rejects.toThrow(
      "invalid page content",
    );
    second.close();
    browser.close();
  });
});

describe("safe CLI", () => {
  it("prints only allowlisted status codes", async () => {
    const lines: string[] = [];
    expect(await runCli("unknown", (line) => lines.push(line))).toBe(2);
    expect(lines[0]).toContain("usage:");
    const browser = {
      status: vi.fn().mockResolvedValue({ sensitive: "not printed" }),
      detachAll: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    } as unknown as Browser;
    const connectBrowser = vi.fn().mockResolvedValue(browser);
    await expect(createCliConnector(connectBrowser)()).resolves.toBe(browser);
    expect(connectBrowser).toHaveBeenCalledWith({ timeoutMs: 5_000 });
    createCliConnector();
    expect(
      await runCli(
        "status",
        (line) => lines.push(line),
        async () => browser,
      ),
    ).toBe(0);
    expect(
      await runCli(
        "doctor",
        (line) => lines.push(line),
        async () => browser,
      ),
    ).toBe(0);
    expect(
      await runCli(
        "detach-all",
        (line) => lines.push(line),
        async () => browser,
      ),
    ).toBe(0);
    expect(lines).toContain("bridge_connected");
    expect(lines).toContain("doctor_ok");
    expect(lines).toContain("detach_all_ok");
    expect(lines.join(" ")).not.toContain("sensitive");
    expect(
      await runCli(
        "doctor",
        (line) => lines.push(line),
        async () => {
          throw new Error("secret");
        },
      ),
    ).toBe(1);
    expect(
      await runCli(
        "status",
        (line) => lines.push(line),
        async () => {
          throw new Error("secret");
        },
      ),
    ).toBe(1);
    const failingBrowser = {
      status: vi.fn().mockRejectedValue(new Error("secret")),
      close: vi.fn(),
    } as unknown as Browser;
    expect(
      await runCli(
        "status",
        (line) => lines.push(line),
        async () => failingBrowser,
      ),
    ).toBe(1);
    expect(failingBrowser.close).toHaveBeenCalled();
    expect(lines).toContain("doctor_failed");
    expect(lines).toContain("bridge_unavailable");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runCli("unknown")).toBe(2);
    stdout.mockRestore();
    expect(
      await runCli(
        "status",
        (line) => lines.push(line),
        async () => {
          throw new Error("unavailable");
        },
      ),
    ).toBe(1);
  });
});
