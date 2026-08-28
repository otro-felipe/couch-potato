import { describe, expect, it, vi } from "vitest";

import {
  CdpPageService,
  type CdpTransport,
} from "../src/extension/page-service.js";
import { BridgeFault } from "../src/extension/errors.js";
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

  async send(
    tabId: number,
    method: string,
    params: object = {},
  ): Promise<unknown> {
    this.calls.push({ tabId, method, params });
    const queue = this.replies.get(method) ?? [];
    if (queue.length === 0) return {};
    const value = queue.shift();
    if (value instanceof Error) {
      if (value instanceof BridgeFault && value.code === "NOT_ATTACHED")
        this.attached.delete(tabId);
      throw value;
    }
    return value;
  }
}

const css = (value: string): Locator => ({ type: "css", value });
const found = (overrides: object = {}) => ({
  result: {
    value: {
      kind: "found",
      visible: true,
      x: 10,
      y: 20,
      text: "Hola",
      ...overrides,
    },
  },
});

describe("CDP page service", () => {
  it("attaches, detaches, and reports deterministic status", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);

    await expect(page.detach(7)).rejects.toMatchObject({
      code: "NOT_ATTACHED",
    });
    await page.attach(7);
    expect(page.status()).toEqual({ attachedTabIds: [7] });
    await page.detach(7);
    await page.attach(8);
    await page.detachAll();
    expect(page.status()).toEqual({ attachedTabIds: [] });
  });

  it("reports only the failed CDP method and allowlisted code", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(25);
    cdp.enqueue("Runtime.evaluate", new Error("private browser details"));

    await expect(
      page.waitFor(25, css("main"), [], "visible", 1_000),
    ).rejects.toMatchObject({ code: "CDP_ERROR" });
    expect(page.status()).toEqual({
      attachedTabIds: [25],
      lastCdpFailure: { method: "Runtime.evaluate", code: "CDP_ERROR" },
    });
    expect(JSON.stringify(page.status())).not.toContain(
      "private browser details",
    );
  });

  it("cleans up debugger attachment when domain enable fails", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    cdp.enqueue("Page.enable", new Error("private"));
    await expect(page.attach(10)).rejects.toMatchObject({ code: "CDP_ERROR" });
    expect(cdp.isAttached(10)).toBe(false);

    const fault = new (await import("../src/extension/errors.js")).BridgeFault(
      "TIMEOUT",
    );
    cdp.enqueue("Page.enable", fault);
    cdp.detach = vi.fn(async () => {
      throw new Error("detach failed");
    });
    await expect(page.attach(11)).rejects.toBe(fault);
  });

  it("navigates only attached pages and waits for requested readiness", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await expect(
      page.goto(1, "https://example.com", "none", 0),
    ).rejects.toMatchObject({ code: "NOT_ATTACHED" });

    await page.attach(1);
    cdp.enqueue("Page.navigate", { frameId: "main" });
    await expect(
      page.goto(1, "https://example.com", "none", 0),
    ).resolves.toEqual({ url: "https://example.com" });

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
    await expect(
      page.goto(1, "https://example.com/c", "load", 0),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
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
    await expect(page.evaluate(2, "arg", { answer: 42 })).resolves.toEqual({
      answer: 42,
    });
    const evaluation = cdp.calls.find(
      ({ method }) => method === "Runtime.evaluate",
    );
    expect(
      String((evaluation?.params as Record<string, unknown>).expression),
    ).toContain('const arg = {"answer":42}');
    expect(
      String((evaluation?.params as Record<string, unknown>).expression),
    ).toContain("await eval(");
    await expect(
      page.evaluate(2, "throw new Error()", null),
    ).rejects.toMatchObject({ code: "CDP_ERROR" });
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
    await expect(page.content(3, [css("iframe")])).resolves.toBe(
      "<html>frame</html>",
    );
    expect(cdp.calls.at(-1)?.params).toMatchObject({
      contextId: 41,
      returnByValue: true,
    });
  });

  it("runs a role locator in the isolated execution context of a cross-origin frame", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(16);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "cross-origin-frame" } },
      found({ text: "" }),
    );
    cdp.enqueue("DOM.describeNode", { node: { frameId: "remote-child" } });
    cdp.enqueue("DOM.getBoxModel", {
      model: { border: [0, 0, 300, 0, 300, 200, 0, 200] },
    });
    cdp.enqueue("Page.createIsolatedWorld", { executionContextId: 73 });

    await expect(
      page.waitFor(
        16,
        {
          type: "role",
          role: "textbox",
          name: "Account identifier",
          exact: true,
        },
        [css("iframe.remote")],
        "visible",
        0,
      ),
    ).resolves.toEqual({ state: "visible" });

    const evaluations = cdp.calls.filter(
      ({ method }) => method === "Runtime.evaluate",
    );
    expect(evaluations[0]?.params).not.toHaveProperty("contextId");
    expect(evaluations[1]?.params).toMatchObject({
      contextId: 73,
      returnByValue: true,
    });
  });

  it("reattaches and resolves a locator action again after a transient debugger detach", async () => {
    const cdp = new FakeCdp();
    const delay = vi.fn(async () => undefined);
    const page = new CdpPageService(cdp, delay);
    const attach = vi.spyOn(cdp, "attach");
    await page.attach(24);
    cdp.enqueue(
      "Runtime.evaluate",
      new BridgeFault("NOT_ATTACHED"),
      found(),
      found(),
    );

    await expect(page.click(24, css("a.login"), [], 1_000)).resolves.toEqual({
      clicked: true,
    });

    expect(attach).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(100);
    expect(
      cdp.calls.filter(({ method }) => method === "Page.enable"),
    ).toHaveLength(2);
    expect(
      cdp.calls.filter(({ method }) => method === "Runtime.enable"),
    ).toHaveLength(2);
    expect(
      cdp.calls.filter(({ method }) => method === "Input.dispatchMouseEvent"),
    ).toHaveLength(3);
  });

  it("never auto-attaches a tab that was not explicitly authorized", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    const attach = vi.spyOn(cdp, "attach");

    await expect(
      page.waitFor(26, css("main"), [], "visible", 1_000),
    ).rejects.toMatchObject({ code: "NOT_ATTACHED" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("maps an out-of-process iframe owner backend node to its direct child frame", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(20);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "oopif-owner" } },
      found({ text: "" }),
    );
    cdp.enqueue("DOM.describeNode", { node: { backendNodeId: 9_001 } });
    cdp.enqueue("Page.getFrameTree", {
      frameTree: {
        frame: { id: "top" },
        childFrames: [
          { frame: { id: "unrelated", parentId: "top" } },
          { frame: { id: "remote-child", parentId: "top" } },
        ],
      },
    });
    cdp.enqueue(
      "DOM.getFrameOwner",
      { backendNodeId: 8_000 },
      { backendNodeId: 9_001 },
    );
    cdp.enqueue("DOM.getBoxModel", {
      model: { border: [0, 0, 300, 0, 300, 200, 0, 200] },
    });
    cdp.enqueue("Page.createIsolatedWorld", { executionContextId: 75 });

    await expect(
      page.waitFor(
        20,
        {
          type: "role",
          role: "textbox",
          name: "Account identifier",
          exact: true,
        },
        [css("iframe.remote")],
        "visible",
        1_000,
      ),
    ).resolves.toEqual({ state: "visible" });
    expect(
      cdp.calls
        .filter(({ method }) => method === "DOM.getFrameOwner")
        .map(({ params }) => params),
    ).toEqual([{ frameId: "unrelated" }, { frameId: "remote-child" }]);
    expect(
      cdp.calls.filter(({ method }) => method === "DOM.getBoxModel"),
    ).toHaveLength(0);
    expect(cdp.calls.at(-1)?.params).toMatchObject({ contextId: 75 });
  });

  it("scopes nested out-of-process frame-owner matching to the current parent", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(21);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "outer-owner" } },
      { result: { objectId: "inner-owner" } },
      { result: { value: "<html>nested remote</html>" } },
    );
    cdp.enqueue(
      "DOM.describeNode",
      { node: { frameId: "outer", backendNodeId: 100 } },
      { node: { backendNodeId: 222 } },
    );
    cdp.enqueue("Page.getFrameTree", {
      frameTree: {
        frame: { id: "top" },
        childFrames: [
          { frame: { id: "top-sibling", parentId: "top" } },
          {
            frame: { id: "outer", parentId: "top" },
            childFrames: [
              { frame: { id: "inner-sibling", parentId: "outer" } },
              { frame: { id: "inner-remote", parentId: "outer" } },
            ],
          },
        ],
      },
    });
    cdp.enqueue(
      "DOM.getFrameOwner",
      { backendNodeId: 111 },
      { backendNodeId: 222 },
    );
    cdp.enqueue(
      "DOM.getBoxModel",
      { model: { border: [0, 0, 300, 0, 300, 200, 0, 200] } },
      { model: { border: [5, 6, 105, 6, 105, 56, 5, 56] } },
    );
    cdp.enqueue(
      "Page.createIsolatedWorld",
      { executionContextId: 76 },
      { executionContextId: 77 },
    );

    await expect(
      page.content(21, [css("iframe.outer"), css("iframe.inner")]),
    ).resolves.toBe("<html>nested remote</html>");
    expect(
      cdp.calls
        .filter(({ method }) => method === "DOM.getFrameOwner")
        .map(({ params }) => params),
    ).toEqual([{ frameId: "inner-sibling" }, { frameId: "inner-remote" }]);
    expect(
      cdp.calls.filter(({ method }) => method === "DOM.getBoxModel"),
    ).toHaveLength(0);
  });

  it.each([
    [{ frameTree: {} }, []],
    [{ frameTree: { frame: { id: "top" }, childFrames: {} } }, []],
    [{ frameTree: { frame: { id: "top" }, childFrames: [{}] } }, []],
    [{ frameTree: { frame: { id: "top" } } }, []],
    [
      {
        frameTree: {
          frame: { id: "top" },
          childFrames: [{ frame: { id: "other", parentId: "top" } }],
        },
      },
      [{ backendNodeId: 999 }],
    ],
  ])(
    "rejects malformed or unmatched OOPIF metadata %#",
    async (tree, owners) => {
      const cdp = new FakeCdp();
      const page = new CdpPageService(cdp, async () => undefined);
      await page.attach(22);
      cdp.enqueue("Runtime.evaluate", { result: { objectId: "oopif-owner" } });
      cdp.enqueue("DOM.describeNode", { node: { backendNodeId: 123 } });
      cdp.enqueue("Page.getFrameTree", tree);
      if (owners.length > 0) cdp.enqueue("DOM.getFrameOwner", ...owners);
      await expect(
        page.content(22, [css("iframe.remote")]),
      ).rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
    },
  );

  it("rejects a nested OOPIF whose current parent disappeared from the frame tree", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(23);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "outer-owner" } },
      { result: { objectId: "inner-owner" } },
    );
    cdp.enqueue(
      "DOM.describeNode",
      { node: { frameId: "disappeared-parent" } },
      { node: { backendNodeId: 222 } },
    );
    cdp.enqueue("DOM.getBoxModel", {});
    cdp.enqueue("Page.createIsolatedWorld", { executionContextId: 80 });
    cdp.enqueue("Page.getFrameTree", {
      frameTree: { frame: { id: "top" }, childFrames: [] },
    });
    await expect(
      page.content(23, [css("iframe.outer"), css("iframe.inner")]),
    ).rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
  });

  it("retries a frame that exists before Chrome exposes its frame id and isolated world", async () => {
    const cdp = new FakeCdp();
    const delay = vi.fn(async () => undefined);
    const page = new CdpPageService(cdp, delay);
    await page.attach(17);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "early-frame" } },
      { result: { objectId: "early-world" } },
      { result: { objectId: "ready-frame" } },
      found({ text: "" }),
    );
    cdp.enqueue(
      "DOM.describeNode",
      { node: {} },
      { node: { frameId: "early-child" } },
      { node: { frameId: "ready-child" } },
    );
    cdp.enqueue(
      "DOM.getBoxModel",
      { model: { border: [0, 0, 300, 0, 300, 200, 0, 200] } },
      { model: { border: [0, 0, 300, 0, 300, 200, 0, 200] } },
    );
    cdp.enqueue("Page.createIsolatedWorld", {}, { executionContextId: 74 });

    await expect(
      page.waitFor(
        17,
        {
          type: "role",
          role: "textbox",
          name: "Account identifier",
          exact: true,
        },
        [css("iframe.remote")],
        "visible",
        1_000,
      ),
    ).resolves.toEqual({ state: "visible" });
    expect(delay).toHaveBeenCalledTimes(2);
    expect(
      cdp.calls.filter(({ method }) => method === "DOM.describeNode"),
    ).toHaveLength(3);
  });

  it("turns an unresolved transient frame into a locator timeout at its deadline", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(18);
    cdp.enqueue("Runtime.evaluate", { result: { objectId: "early-frame" } });
    cdp.enqueue("DOM.describeNode", { node: {} });
    await expect(
      page.waitFor(18, css("input"), [css("iframe.remote")], "visible", 0),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("does not retry a non-transient CDP failure while resolving a frame", async () => {
    const cdp = new FakeCdp();
    const delay = vi.fn(async () => undefined);
    const page = new CdpPageService(cdp, delay);
    await page.attach(19);
    cdp.enqueue("Runtime.evaluate", new Error("private transport detail"));
    await expect(
      page.waitFor(19, css("input"), [css("iframe.remote")], "visible", 1_000),
    ).rejects.toMatchObject({ code: "CDP_ERROR" });
    expect(delay).not.toHaveBeenCalled();
  });

  it("resolves nested frames with cumulative offsets", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(13);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "outer" } },
      { result: { value: { x: 5, y: 6, width: 100, height: 50 } } },
      { result: { objectId: "inner" } },
      { result: { value: { x: 7, y: 8, width: 40, height: 20 } } },
    );
    cdp.enqueue(
      "DOM.describeNode",
      { node: { frameId: "outer-frame" } },
      { node: { frameId: "inner-frame" } },
    );
    cdp.enqueue(
      "Page.createIsolatedWorld",
      { executionContextId: 20 },
      { executionContextId: 21 },
    );
    cdp.enqueue("Page.captureScreenshot", { data: "nested" });
    await expect(
      page.screenshot(13, [css("iframe.outer"), css("iframe.inner")]),
    ).resolves.toBe("nested");
    expect(cdp.calls.at(-1)?.params).toMatchObject({
      clip: { x: 12, y: 14, width: 40, height: 20, scale: 1 },
    });
  });

  it("returns an explicit frame error for missing or non-frame elements", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(4);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { value: null } },
      { result: { objectId: "not-frame" } },
    );
    await expect(
      page.content(4, [css("iframe.missing")]),
    ).rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
    cdp.enqueue("DOM.describeNode", { node: {} });
    await expect(page.content(4, [css("div")])).rejects.toMatchObject({
      code: "FRAME_NOT_FOUND",
    });
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "frame" } },
      { result: { value: { x: 5, y: 6, width: 100, height: 50 } } },
    );
    cdp.enqueue("DOM.describeNode", { node: { frameId: "child" } });
    cdp.enqueue("DOM.getBoxModel", {});
    cdp.enqueue("Page.createIsolatedWorld", {});
    await expect(page.content(4, [css("iframe")])).rejects.toMatchObject({
      code: "FRAME_NOT_FOUND",
    });
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
    cdp.enqueue("Page.getLayoutMetrics", {
      cssContentSize: { width: 900, height: 1200 },
    });
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "frame" } },
      { result: { value: { x: 5, y: 6, width: 100, height: 50 } } },
    );
    cdp.enqueue("DOM.describeNode", { node: { frameId: "frame-id" } });
    cdp.enqueue("DOM.getBoxModel", {
      model: { border: [5, 6, 105, 6, 105, 56, 5, 56] },
    });
    cdp.enqueue("Page.createIsolatedWorld", { executionContextId: 11 });

    await expect(page.screenshot(5, [], "png", undefined, false)).resolves.toBe(
      "viewport",
    );
    await expect(page.screenshot(5, [], "jpeg", 80, true)).resolves.toBe(
      "full",
    );
    await expect(
      page.screenshot(5, [css("iframe")], "png", undefined, false),
    ).resolves.toBe("frame");
    expect(
      cdp.calls
        .filter(({ method }) => method === "Page.captureScreenshot")
        .at(-1)?.params,
    ).toMatchObject({
      clip: { x: 5, y: 6, width: 100, height: 50, scale: 1 },
    });
    cdp.enqueue("Page.captureScreenshot", {});
    await expect(page.screenshot(5)).rejects.toMatchObject({
      code: "CDP_ERROR",
    });
  });

  it.each([
    {},
    { x: "bad", y: 0, width: 1, height: 1 },
    { x: 0, y: "bad", width: 1, height: 1 },
    { x: 0, y: 0, width: "bad", height: 1 },
    { x: 0, y: 0, width: 1, height: "bad" },
    { x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
    { x: 0, y: 0, width: Number.NaN, height: 1 },
    { x: 0, y: 0, width: 1, height: Number.NEGATIVE_INFINITY },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: 0, y: 0, width: 1, height: -1 },
  ])("rejects malformed frame geometry %#", async (bounds) => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(27);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "frame" } },
      { result: { value: bounds } },
    );
    cdp.enqueue("DOM.describeNode", { node: { frameId: "child" } });

    await expect(page.screenshot(27, [css("iframe")])).rejects.toMatchObject({
      code: "FRAME_NOT_FOUND",
    });
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

    await expect(
      page.waitFor(6, css("#ready"), [], "visible", 20),
    ).resolves.toEqual({ state: "visible" });
    await expect(
      page.waitFor(6, css("#hidden"), [], "hidden", 0),
    ).resolves.toEqual({ state: "hidden" });
    await expect(
      page.waitFor(6, css("#gone"), [], "detached", 0),
    ).resolves.toEqual({ state: "detached" });
    await expect(
      page.waitFor(6, css("#attached"), [], "attached", 0),
    ).resolves.toEqual({ state: "attached" });
    await expect(
      page.waitFor(6, css("#never"), [], "visible", 0),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(delay).toHaveBeenCalled();
  });

  it("uses the bounded production polling delay by default", async () => {
    vi.useFakeTimers();
    try {
      const cdp = new FakeCdp();
      const page = new CdpPageService(cdp);
      await page.attach(15);
      cdp.enqueue(
        "Runtime.evaluate",
        { result: { value: { kind: "missing" } } },
        found(),
      );
      const pending = page.waitFor(15, css("#later"), [], "visible", 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ state: "visible" });
    } finally {
      vi.useRealTimers();
    }
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
    await expect(page.textContent(9, css(".balance"), [], 0)).resolves.toBe(
      " Saldo ",
    );

    expect(
      cdp.calls.filter(({ method }) => method === "Input.dispatchMouseEvent"),
    ).toHaveLength(6);
    expect(
      cdp.calls.filter(({ method }) => method === "Input.dispatchKeyEvent"),
    ).toHaveLength(4);
    expect(
      cdp.calls.find(({ method }) => method === "Input.insertText")?.params,
    ).toEqual({ text: "secret-value" });
  });

  it("translates frame-local click coordinates into the top-level viewport", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(14);
    cdp.enqueue(
      "Runtime.evaluate",
      { result: { objectId: "frame-one" } },
      found(),
      { result: { objectId: "frame-two" } },
      { result: { value: { x: 5, y: 6, width: 100, height: 50 } } },
      found(),
    );
    cdp.enqueue(
      "DOM.describeNode",
      { node: { frameId: "child" } },
      { node: { frameId: "child" } },
    );
    cdp.enqueue(
      "DOM.getBoxModel",
      { model: { border: [5, 6, 105, 6, 105, 56, 5, 56] } },
      { model: { border: [5, 6, 105, 6, 105, 56, 5, 56] } },
    );
    cdp.enqueue(
      "Page.createIsolatedWorld",
      { executionContextId: 31 },
      { executionContextId: 31 },
    );
    await page.click(14, css("button"), [css("iframe")], 0);
    expect(
      cdp.calls.find(({ method }) => method === "Input.dispatchMouseEvent")
        ?.params,
    ).toMatchObject({
      x: 15,
      y: 26,
    });
  });

  it("maps malformed probes, changing locators, and transport failures safely", async () => {
    const cdp = new FakeCdp();
    const page = new CdpPageService(cdp, async () => undefined);
    await page.attach(12);
    cdp.enqueue("Runtime.evaluate", { result: { value: null } });
    await expect(
      page.waitFor(12, css("#bad"), [], "visible", 0),
    ).rejects.toMatchObject({ code: "CDP_ERROR" });

    cdp.enqueue("Runtime.evaluate", found(), {
      result: { value: { kind: "missing" } },
    });
    await expect(
      page.textContent(12, css("#changing"), [], 0),
    ).rejects.toMatchObject({ code: "LOCATOR_NOT_FOUND" });

    cdp.enqueue("Runtime.evaluate", found(), {
      result: { value: { kind: "missing" } },
    });
    await expect(page.click(12, css("#changing"), [], 0)).rejects.toMatchObject(
      { code: "LOCATOR_NOT_FOUND" },
    );

    const fault = new (await import("../src/extension/errors.js")).BridgeFault(
      "TIMEOUT",
    );
    cdp.enqueue("Page.navigate", fault, new Error("private"));
    await expect(page.goto(12, "https://example.test", "none", 0)).rejects.toBe(
      fault,
    );
    await expect(
      page.goto(12, "https://example.test", "none", 0),
    ).rejects.toMatchObject({ code: "CDP_ERROR" });

    cdp.enqueue("Runtime.evaluate", { exceptionDetails: {} });
    await expect(page.content(12)).rejects.toMatchObject({ code: "CDP_ERROR" });
    cdp.enqueue("Runtime.evaluate", { result: { value: 4 } });
    await expect(page.content(12)).rejects.toMatchObject({ code: "CDP_ERROR" });
  });
});
