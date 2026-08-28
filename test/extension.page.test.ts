import { describe, expect, it, vi } from "vitest";

import { CdpPageService, type CdpTransport } from "../src/extension/page-service.js";
import type { Locator } from "../src/shared/protocol.js";

class FakeCdp implements CdpTransport {
  readonly calls: Array<{ tabId: number; method: string; params: object }> = [];
  readonly replies = new Map<string, unknown[]>();
  readonly attached = new Set<number>();

  enqueue(method: string, ...values: unknown[]): void {
    this.replies.set(method, values);
  }

  async attach(tabId: number): Promise<void> {
    this.attached.add(tabId);
  }

  async detach(tabId: number): Promise<void> {
    this.attached.delete(tabId);
  }

  async detachAll(): Promise<void> {
    this.attached.clear();
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  attachedTabIds(): number[] {
    return [...this.attached];
  }

  async send(tabId: number, method: string, params: object = {}): Promise<unknown> {
    this.calls.push({ tabId, method, params });
    const queue = this.replies.get(method) ?? [];
    if (queue.length === 0) return {};
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value;
  }
}

const css = (value: string): Locator => ({ type: "css", value });
const found = (overrides: object = {}) => ({
  result: { value: { kind: "found", visible: true, x: 10, y: 20, text: "Hola", ...overrides } },
});

describe("CDP page service", () => {
  it("attaches, detaches, and reports deterministic status", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);

    await page.attach(7);
    expect(page.status()).toEqual({ attachedTabIds: [7] });
    await page.detach(7);
    await page.attach(8);
    await page.detachAll();
    expect(page.status()).toEqual({ attachedTabIds: [] });
  });

  it("cleans up debugger attachment when domain enable fails", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    cdp.enqueue("Page.enable", new Error("private"));
    await expect(page.attach(10)).rejects.toMatchObject({ code: "CDP_ERROR" });
    expect(cdp.isAttached(10)).toBe(false);

    const fault = new (await import("../src/extension/errors.js")).BridgeFault("TIMEOUT");
    cdp.enqueue("Page.enable", fault);
    cdp.detach = vi.fn(async () => {
      throw new Error("detach failed");
    });
    await expect(page.attach(11)).rejects.toBe(fault);
  });

  it("navigates only attached pages and waits for requested readiness", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await expect(page.goto(1, "https://example.com", "none", 0)).rejects.toMatchObject({ code: "NOT_ATTACHED" });

    await page.attach(1);
    cdp.enqueue("Page.navigate", { frameId: "main" });
    await expect(page.goto(1, "https://example.com", "none", 0)).resolves.toEqual({ url: "https://example.com" });

    cdp.enqueue(
      "Page.navigate",
      { frameId: "main" },
      { frameId: "main" },
      { frameId: "main" },
    );
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { value: "loading" } },
      { result: { value: "interactive" } },
      { result: { value: "complete" } },
    );
    await page.goto(1, "https://example.com/a", "domcontentloaded", 10);
    await page.goto(1, "https://example.com/b", "load", 10);
    await expect(page.goto(1, "https://example.com/c", "load", 0)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("evaluates JSON values and rejects CDP exceptions", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(2);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { value: { answer: 42 } } },
      { exceptionDetails: {} },
    );
    await expect(page.evaluate(2, "arg", { answer: 42 })).resolves.toEqual({ answer: 42 });
    const evaluation = cdp.calls.find(({ method }) => method === "Runtime.evaluate");
    expect(String((evaluation?.params as Record<string, unknown>).expression)).toContain('const arg = {"answer":42}');
    expect(String((evaluation?.params as Record<string, unknown>).expression)).toContain("await eval(");
    await expect(page.evaluate(2, "throw new Error()", null)).rejects.toMatchObject({ code: "CDP_ERROR" });
    cdp.enqueue("Runtime.evaluate", { result: {} });
    await expect(page.evaluate(2, "undefined")).resolves.toBeNull();
  });

  it("reads page and resolved cross-origin frame content without exposing it to logs", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(3);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { value: "<html>main</html>" } },
      { result: { objectId: "frame-object" } },
      { result: { value: "<html>frame</html>" } },
    );
    cdp.enqueue("DOM.describeNode", { node: { frameId: "child-frame" } });
    cdp.enqueue("Page.createIsolatedWorld", { executionContextId: 41 });

    await expect(page.content(3)).resolves.toBe("<html>main</html>");
    await expect(page.content(3, [css("iframe")])).resolves.toBe("<html>frame</html>");
    expect(cdp.calls.at(-1)?.params).toMatchObject({ contextId: 41, returnByValue: true });
  });

  it("returns an explicit frame error for missing or non-frame elements", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(4);
    cdp.enqueue("Runtime.evaluate", { result: { value: null } }, { result: { objectId: "not-frame" } });
    await expect(page.content(4, [css("iframe.missing")])).rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
    cdp.enqueue("DOM.describeNode", { node: {} });
    await expect(page.content(4, [css("div")])).rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
    cdp.enqueue("Runtime.evaluate", { result: { objectId: "frame" } });
    cdp.enqueue("DOM.describeNode", { node: { frameId: "child" } });
    cdp.enqueue("DOM.getBoxModel", {});
    cdp.enqueue("Page.createIsolatedWorld", {});
    await expect(page.content(4, [css("iframe")])).rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
  });

  it("captures viewport, full-page, and framed screenshots", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(5);
    cdp.enqueue(
      "Page.captureScreenshot",
      { data: "viewport" },
      { data: "full" },
      { data: "frame" },
    );
    cdp.enqueue("Page.getLayoutMetrics", { cssContentSize: { width: 900, height: 1200 } });
    cdp.enqueue("Runtime.evaluate", { result: { objectId: "frame" } });
    cdp.enqueue("DOM.describeNode", { node: { frameId: "frame-id" } });
    cdp.enqueue("DOM.getBoxModel", { model: { border: [5, 6, 105, 6, 105, 56, 5, 56] } });
    cdp.enqueue("Page.createIsolatedWorld", { executionContextId: 11 });

    await expect(page.screenshot(5, [], "png", undefined, false)).resolves.toBe("viewport");
    await expect(page.screenshot(5, [], "jpeg", 80, true)).resolves.toBe("full");
    await expect(page.screenshot(5, [css("iframe")], "png", undefined, false)).resolves.toBe("frame");
    expect(cdp.calls.filter(({ method }) => method === "Page.captureScreenshot").at(-1)?.params).toMatchObject({
      clip: { x: 5, y: 6, width: 100, height: 50, scale: 1 },
    });
    cdp.enqueue("Page.captureScreenshot", {});
    await expect(page.screenshot(5)).rejects.toMatchObject({ code: "CDP_ERROR" });
  });

  it("waits across states and reports locator timeouts", async () => {
    const cdp = new FakeCdp();
    const delay = vi.fn(async () => undefined);
    const page = new CdpPageService(cdp, delay);
    await page.attach(6);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { value: { kind: "missing" } } },
      found(),
      found({ visible: false }),
      { result: { value: { kind: "missing" } } },
      found({ visible: false }),
      { result: { value: { kind: "missing" } } },
    );

    await expect(page.waitFor(6, css("#ready"), [], "visible", 20)).resolves.toEqual({ state: "visible" });
    await expect(page.waitFor(6, css("#hidden"), [], "hidden", 0)).resolves.toEqual({ state: "hidden" });
    await expect(page.waitFor(6, css("#gone"), [], "detached", 0)).resolves.toEqual({ state: "detached" });
    await expect(page.waitFor(6, css("#attached"), [], "attached", 0)).resolves.toEqual({ state: "attached" });
    await expect(page.waitFor(6, css("#never"), [], "visible", 0)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(delay).toHaveBeenCalled();
  });

  it("clicks and fills through CDP Input, and returns text", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(9);
    cdp.enqueue(
      "Runtime.evaluate",
      found(),
      found(),
      found(),
      found(),
      found({ text: " Saldo " }),
      found({ text: " Saldo " }),
    );

    await page.click(9, css("button"), [], 0);
    await page.fill(9, css("input"), [], "secret-value", 0);
    await expect(page.textContent(9, css(".balance"), [], 0)).resolves.toBe(" Saldo ");

    expect(cdp.calls.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(6);
    expect(cdp.calls.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(4);
    expect(cdp.calls.find(({ method }) => method === "Input.insertText")?.params).toEqual({ text: "secret-value" });
  });

  it("maps malformed probes, changing locators, and transport failures safely", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(12);
    cdp.enqueue("Runtime.evaluate", { result: { value: null } });
    await expect(page.waitFor(12, css("#bad"), [], "visible", 0)).rejects.toMatchObject({ code: "CDP_ERROR" });

    cdp.enqueue("Runtime.evaluate", found(), { result: { value: { kind: "missing" } } });
    await expect(page.textContent(12, css("#changing"), [], 0)).rejects.toMatchObject({ code: "LOCATOR_NOT_FOUND" });

    cdp.enqueue("Runtime.evaluate", found(), { result: { value: { kind: "missing" } } });
    await expect(page.click(12, css("#changing"), [], 0)).rejects.toMatchObject({ code: "LOCATOR_NOT_FOUND" });

    const fault = new (await import("../src/extension/errors.js")).BridgeFault("TIMEOUT");
    cdp.enqueue("Page.navigate", fault, new Error("private"));
    await expect(page.goto(12, "https://example.test", "none", 0)).rejects.toBe(fault);
    await expect(page.goto(12, "https://example.test", "none", 0)).rejects.toMatchObject({ code: "CDP_ERROR" });

    cdp.enqueue("Runtime.evaluate", { exceptionDetails: {} });
    await expect(page.content(12)).rejects.toMatchObject({ code: "CDP_ERROR" });
    cdp.enqueue("Runtime.evaluate", { result: { value: 4 } });
    await expect(page.content(12)).rejects.toMatchObject({ code: "CDP_ERROR" });
  });
});
