import type {
  BridgeErrorCode,
  JsonValue,
  Locator,
} from "../shared/protocol.js";
import { BridgeFault } from "./errors.js";
import {
  locatorActivationExpression,
  locatorBoxExpression,
  locatorObjectExpression,
  locatorProbeExpression,
} from "./locator-expression.js";
import { requireWebUrl } from "./security.js";

export interface CdpTransport {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  detachAll(): Promise<void>;
  isAttached(tabId: number): boolean;
  attachedTabIds(): number[];
  send(tabId: number, method: string, params?: object): Promise<unknown>;
}

type WaitState = "attached" | "visible" | "hidden" | "detached";
type Probe =
  | { kind: "missing" }
  | {
      kind: "found";
      visible: boolean;
      x: number;
      y: number;
      text: string | null;
    };

type FrameContext = {
  contextId?: number;
  clip?: { x: number; y: number; width: number; height: number; scale: 1 };
};

type FrameTreeNode = {
  frameId: string;
  children: FrameTreeNode[];
};

const fixedDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function resultObject(value: unknown): Record<string, unknown> {
  return record(record(value).result);
}

function resultValue(value: unknown): unknown {
  return resultObject(value).value;
}

function cdpError(): BridgeFault {
  return new BridgeFault("CDP_ERROR");
}

function frameTreeNode(value: unknown): FrameTreeNode | undefined {
  const tree = record(value);
  const frameId = record(tree.frame).id;
  if (typeof frameId !== "string") return undefined;
  const rawChildren = tree.childFrames;
  if (rawChildren !== undefined && !Array.isArray(rawChildren))
    return undefined;
  const children: FrameTreeNode[] = [];
  for (const rawChild of rawChildren ?? []) {
    const child = frameTreeNode(rawChild);
    if (child === undefined) return undefined;
    children.push(child);
  }
  return { frameId, children };
}

function findFrameTreeNode(
  tree: FrameTreeNode,
  frameId: string,
): FrameTreeNode | undefined {
  if (tree.frameId === frameId) return tree;
  for (const child of tree.children) {
    const found = findFrameTreeNode(child, frameId);
    if (found !== undefined) return found;
  }
  return undefined;
}

export class CdpPageService {
  private readonly authorizedTabs = new Set<number>();
  private lastCdpFailure?: { method: string; code: BridgeErrorCode };

  constructor(
    private readonly cdp: CdpTransport,
    private readonly delay: (
      milliseconds: number,
    ) => Promise<void> = fixedDelay,
  ) {}

  async attach(tabId: number): Promise<{ attached: true }> {
    await this.cdp.attach(tabId);
    try {
      await this.cdp.send(tabId, "Page.enable");
      await this.cdp.send(tabId, "Runtime.enable");
      this.authorizedTabs.add(tabId);
      return { attached: true };
    } catch (error) {
      this.authorizedTabs.delete(tabId);
      try {
        await this.cdp.detach(tabId);
      } catch {
        // The original enable failure is the most useful allowlisted outcome.
      }
      if (error instanceof BridgeFault) throw error;
      throw cdpError();
    }
  }

  async detach(tabId: number): Promise<{ attached: false }> {
    if (!this.authorizedTabs.delete(tabId))
      throw new BridgeFault("NOT_ATTACHED");
    if (this.cdp.isAttached(tabId)) await this.cdp.detach(tabId);
    return { attached: false };
  }

  async detachAll(): Promise<void> {
    this.authorizedTabs.clear();
    await this.cdp.detachAll();
  }

  status(): {
    attachedTabIds: number[];
    lastCdpFailure?: { method: string; code: BridgeErrorCode };
  } {
    const status: {
      attachedTabIds: number[];
      lastCdpFailure?: { method: string; code: BridgeErrorCode };
    } = {
      attachedTabIds: this.cdp
        .attachedTabIds()
        .sort((left, right) => left - right),
    };
    if (this.lastCdpFailure !== undefined)
      status.lastCdpFailure = this.lastCdpFailure;
    return status;
  }

  async goto(
    tabId: number,
    rawUrl: string,
    waitUntil: "none" | "domcontentloaded" | "load" = "load",
    timeoutMs = 30_000,
  ): Promise<{ url: string }> {
    this.requireAttached(tabId);
    const url = requireWebUrl(rawUrl);
    await this.send(tabId, "Page.navigate", { url });
    if (waitUntil !== "none")
      await this.waitForReadyState(tabId, waitUntil, timeoutMs);
    return { url };
  }

  async evaluate(
    tabId: number,
    expression: string,
    arg: JsonValue = null,
  ): Promise<JsonValue> {
    this.requireAttached(tabId);
    const source = `(async () => { const arg = ${JSON.stringify(arg).replaceAll("<", "\\u003c")}; return await eval(${JSON.stringify(expression).replaceAll("<", "\\u003c")}); })()`;
    const response = await this.send(tabId, "Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
    });
    if (record(response).exceptionDetails !== undefined) throw cdpError();
    const value = resultValue(response);
    if (value === undefined) return null;
    return value as JsonValue;
  }

  async content(
    tabId: number,
    frameSelectors: readonly Locator[] = [],
  ): Promise<string> {
    this.requireAttached(tabId);
    const frame = await this.resolveFrame(tabId, frameSelectors, false);
    const response = await this.evaluateInContext(
      tabId,
      "document.documentElement.outerHTML",
      frame.contextId,
      true,
    );
    const value = resultValue(response);
    if (typeof value !== "string") throw cdpError();
    return value;
  }

  async screenshot(
    tabId: number,
    frameSelectors: readonly Locator[] = [],
    format: "png" | "jpeg" = "png",
    quality?: number,
    fullPage = false,
  ): Promise<string> {
    this.requireAttached(tabId);
    const frame = await this.resolveFrame(
      tabId,
      frameSelectors,
      frameSelectors.length > 0,
    );
    let clip = frame.clip;
    if (fullPage && frameSelectors.length === 0) {
      const metrics = record(await this.send(tabId, "Page.getLayoutMetrics"));
      const size = record(metrics.cssContentSize);
      clip = {
        x: 0,
        y: 0,
        width: Number(size.width),
        height: Number(size.height),
        scale: 1,
      };
    }
    const params: Record<string, unknown> = {
      format,
      captureBeyondViewport: true,
    };
    if (quality !== undefined) params.quality = quality;
    if (clip !== undefined) params.clip = clip;
    const response = record(
      await this.send(tabId, "Page.captureScreenshot", params),
    );
    if (typeof response.data !== "string") throw cdpError();
    return response.data;
  }

  async waitFor(
    tabId: number,
    locator: Locator,
    frameSelectors: readonly Locator[] = [],
    state: WaitState = "visible",
    timeoutMs = 30_000,
  ): Promise<{ state: WaitState }> {
    const deadline = Date.now() + timeoutMs;
    let context: FrameContext | undefined;
    for (;;) {
      if (!this.cdp.isAttached(tabId) && !this.authorizedTabs.has(tabId))
        throw new BridgeFault("NOT_ATTACHED");
      try {
        if (!this.cdp.isAttached(tabId)) {
          await this.attach(tabId);
          context = undefined;
        }
        context ??= await this.resolveFrameUntil(
          tabId,
          frameSelectors,
          deadline,
        );
        const probe = await this.probe(tabId, locator, context.contextId);
        if (this.matchesState(probe, state)) return { state };
      } catch (error) {
        if (!(error instanceof BridgeFault) || error.code !== "NOT_ATTACHED")
          throw error;
        context = undefined;
      }
      if (Date.now() >= deadline) throw new BridgeFault("TIMEOUT");
      await this.delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }

  async click(
    tabId: number,
    locator: Locator,
    frameSelectors: readonly Locator[] = [],
    timeoutMs = 30_000,
  ): Promise<{ clicked: true }> {
    const point = await this.visiblePoint(
      tabId,
      locator,
      frameSelectors,
      timeoutMs,
    );
    await this.mouse(tabId, "mouseMoved", point.x, point.y);
    await this.mouse(tabId, "mousePressed", point.x, point.y, 1);
    await this.mouse(tabId, "mouseReleased", point.x, point.y, 1);
    return { clicked: true };
  }

  async activate(
    tabId: number,
    locator: Locator,
    frameSelectors: readonly Locator[] = [],
    timeoutMs = 30_000,
  ): Promise<{ activated: true }> {
    await this.waitFor(tabId, locator, frameSelectors, "attached", timeoutMs);
    const context = await this.resolveFrame(tabId, frameSelectors, false);
    const response = await this.evaluateInContext(
      tabId,
      locatorActivationExpression(locator),
      context.contextId,
      true,
    );
    if (resultValue(response) !== true)
      throw new BridgeFault("LOCATOR_NOT_FOUND");
    return { activated: true };
  }

  async fill(
    tabId: number,
    locator: Locator,
    frameSelectors: readonly Locator[] = [],
    value: string,
    timeoutMs = 30_000,
  ): Promise<{ filled: true }> {
    const point = await this.visiblePoint(
      tabId,
      locator,
      frameSelectors,
      timeoutMs,
    );
    await this.mouse(tabId, "mouseMoved", point.x, point.y);
    await this.mouse(tabId, "mousePressed", point.x, point.y, 1);
    await this.mouse(tabId, "mouseReleased", point.x, point.y, 1);
    await this.key(tabId, "rawKeyDown", "a", "KeyA", 4);
    await this.key(tabId, "keyUp", "a", "KeyA", 4);
    await this.key(tabId, "rawKeyDown", "Backspace", "Backspace", 0);
    await this.key(tabId, "keyUp", "Backspace", "Backspace", 0);
    await this.send(tabId, "Input.insertText", { text: value });
    return { filled: true };
  }

  async textContent(
    tabId: number,
    locator: Locator,
    frameSelectors: readonly Locator[] = [],
    timeoutMs = 30_000,
  ): Promise<string | null> {
    await this.waitFor(tabId, locator, frameSelectors, "attached", timeoutMs);
    const context = await this.resolveFrame(tabId, frameSelectors, false);
    const probe = await this.probe(tabId, locator, context.contextId);
    if (probe.kind === "missing") throw new BridgeFault("LOCATOR_NOT_FOUND");
    return probe.text;
  }

  private requireAttached(tabId: number): void {
    if (!this.cdp.isAttached(tabId)) throw new BridgeFault("NOT_ATTACHED");
  }

  private async send(
    tabId: number,
    method: string,
    params: object = {},
  ): Promise<unknown> {
    try {
      return await this.cdp.send(tabId, method, params);
    } catch (error) {
      const fault = error instanceof BridgeFault ? error : cdpError();
      this.lastCdpFailure = { method, code: fault.code };
      throw fault;
    }
  }

  private async waitForReadyState(
    tabId: number,
    waitUntil: "domcontentloaded" | "load",
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await this.evaluateInContext(
        tabId,
        "document.readyState",
        undefined,
        true,
      );
      const state = resultValue(response);
      if (
        state === "complete" ||
        (waitUntil === "domcontentloaded" && state === "interactive")
      )
        return;
      if (Date.now() >= deadline) throw new BridgeFault("TIMEOUT");
      await this.delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }

  private async resolveFrame(
    tabId: number,
    selectors: readonly Locator[],
    includeClip: boolean,
  ): Promise<FrameContext> {
    let contextId: number | undefined;
    let clip: FrameContext["clip"];
    let parentFrameId: string | undefined;
    let frameTree: FrameTreeNode | undefined;
    for (const selector of selectors) {
      const response = await this.evaluateInContext(
        tabId,
        locatorObjectExpression(selector),
        contextId,
        false,
      );
      const objectId = resultObject(response).objectId;
      if (typeof objectId !== "string")
        throw new BridgeFault("FRAME_NOT_FOUND");
      const description = record(
        await this.send(tabId, "DOM.describeNode", { objectId }),
      );
      const node = record(description.node);
      const backendNodeId = node.backendNodeId;
      let frameId: string;
      if (typeof node.frameId === "string") {
        frameId = node.frameId;
      } else {
        if (typeof backendNodeId !== "number")
          throw new BridgeFault("FRAME_NOT_FOUND");
        if (frameTree === undefined) {
          const treeResponse = record(
            await this.send(tabId, "Page.getFrameTree"),
          );
          frameTree = frameTreeNode(treeResponse.frameTree);
        }
        if (frameTree === undefined) throw new BridgeFault("FRAME_NOT_FOUND");
        const parent =
          parentFrameId === undefined
            ? frameTree
            : findFrameTreeNode(frameTree, parentFrameId);
        if (parent === undefined) throw new BridgeFault("FRAME_NOT_FOUND");
        const resolvedFrameId = await this.frameIdForOwner(
          tabId,
          parent.children,
          backendNodeId,
        );
        if (resolvedFrameId === undefined)
          throw new BridgeFault("FRAME_NOT_FOUND");
        frameId = resolvedFrameId;
      }
      if (includeClip) {
        const bounds = record(
          resultValue(
            await this.evaluateInContext(
              tabId,
              locatorBoxExpression(selector),
              contextId,
              true,
            ),
          ),
        );
        if (
          typeof bounds.x !== "number" ||
          typeof bounds.y !== "number" ||
          typeof bounds.width !== "number" ||
          typeof bounds.height !== "number" ||
          !Number.isFinite(bounds.x) ||
          !Number.isFinite(bounds.y) ||
          !Number.isFinite(bounds.width) ||
          !Number.isFinite(bounds.height) ||
          bounds.width < 0 ||
          bounds.height < 0
        )
          throw new BridgeFault("FRAME_NOT_FOUND");
        clip = {
          x: bounds.x + (clip?.x ?? 0),
          y: bounds.y + (clip?.y ?? 0),
          width: bounds.width,
          height: bounds.height,
          scale: 1,
        };
      }
      const world = record(
        await this.send(tabId, "Page.createIsolatedWorld", {
          frameId,
          worldName: "couch-potato",
          grantUniveralAccess: false,
        }),
      );
      if (typeof world.executionContextId !== "number")
        throw new BridgeFault("FRAME_NOT_FOUND");
      contextId = world.executionContextId;
      parentFrameId = frameId;
    }
    const output: FrameContext = {};
    if (contextId !== undefined) output.contextId = contextId;
    if (clip !== undefined) output.clip = clip;
    return output;
  }

  private async frameIdForOwner(
    tabId: number,
    candidates: readonly FrameTreeNode[],
    backendNodeId: number,
  ): Promise<string | undefined> {
    for (const candidate of candidates) {
      const owner = record(
        await this.send(tabId, "DOM.getFrameOwner", {
          frameId: candidate.frameId,
        }),
      );
      if (owner.backendNodeId === backendNodeId) return candidate.frameId;
    }
    return undefined;
  }

  private async resolveFrameUntil(
    tabId: number,
    selectors: readonly Locator[],
    deadline: number,
  ): Promise<FrameContext> {
    for (;;) {
      try {
        return await this.resolveFrame(tabId, selectors, false);
      } catch (error) {
        if (!(error instanceof BridgeFault) || error.code !== "FRAME_NOT_FOUND")
          throw error;
        if (Date.now() >= deadline) throw new BridgeFault("TIMEOUT");
        await this.delay(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    }
  }

  private async evaluateInContext(
    tabId: number,
    expression: string,
    contextId: number | undefined,
    returnByValue: boolean,
  ): Promise<unknown> {
    const params: Record<string, unknown> = {
      expression,
      returnByValue,
      awaitPromise: true,
    };
    if (contextId !== undefined) params.contextId = contextId;
    const response = await this.send(tabId, "Runtime.evaluate", params);
    if (record(response).exceptionDetails !== undefined) throw cdpError();
    return response;
  }

  private async probe(
    tabId: number,
    locator: Locator,
    contextId?: number,
  ): Promise<Probe> {
    const response = await this.evaluateInContext(
      tabId,
      locatorProbeExpression(locator),
      contextId,
      true,
    );
    const value = resultValue(response);
    if (typeof value !== "object" || value === null) throw cdpError();
    return value as Probe;
  }

  private matchesState(probe: Probe, state: WaitState): boolean {
    if (state === "detached") return probe.kind === "missing";
    if (state === "hidden") return probe.kind === "missing" || !probe.visible;
    if (state === "attached") return probe.kind === "found";
    return probe.kind === "found" && probe.visible;
  }

  private async visiblePoint(
    tabId: number,
    locator: Locator,
    frames: readonly Locator[],
    timeoutMs: number,
  ): Promise<{ x: number; y: number }> {
    await this.waitFor(tabId, locator, frames, "visible", timeoutMs);
    const context = await this.resolveFrame(tabId, frames, true);
    const probe = await this.probe(tabId, locator, context.contextId);
    if (probe.kind === "missing" || !probe.visible)
      throw new BridgeFault("LOCATOR_NOT_FOUND");
    const offsetX = context.clip?.x ?? 0;
    const offsetY = context.clip?.y ?? 0;
    return { x: probe.x + offsetX, y: probe.y + offsetY };
  }

  private async mouse(
    tabId: number,
    type: string,
    x: number,
    y: number,
    clickCount?: number,
  ): Promise<void> {
    const params: Record<string, unknown> = { type, x, y, button: "left" };
    if (clickCount !== undefined) params.clickCount = clickCount;
    await this.send(tabId, "Input.dispatchMouseEvent", params);
  }

  private async key(
    tabId: number,
    type: string,
    key: string,
    code: string,
    modifiers: number,
  ): Promise<void> {
    await this.send(tabId, "Input.dispatchKeyEvent", {
      type,
      key,
      code,
      modifiers,
    });
  }
}
