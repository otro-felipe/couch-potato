import { describe, expect, it } from "vitest";

import {
  BRIDGE_ERROR_CODES,
  BRIDGE_METHODS,
  PROTOCOL_VERSION,
  parseBridgeRequest as parseBridgeRequestFromProtocol,
  type BridgeErrorResponse,
  type BridgeRequest,
  type BridgeSuccessResponse,
  type Locator,
} from "../src/shared/protocol.js";
import {
  ProtocolValidationError,
  parseBridgeRequest,
  parseBridgeResponse,
} from "../src/shared/validation.js";

const request = (method: string, params: Record<string, unknown> = {}) => ({
  protocol: "1",
  id: "request-1",
  method,
  params,
});

describe("the versioned bridge protocol", () => {
  it("publishes a stable version, method allowlist, and error allowlist", () => {
    expect(PROTOCOL_VERSION).toBe("1");
    expect(BRIDGE_METHODS).toEqual([
      "bridge.status",
      "browser.listTabs",
      "browser.activeTab",
      "browser.openTab",
      "page.attach",
      "page.detach",
      "page.goto",
      "page.evaluate",
      "page.content",
      "page.screenshot",
      "locator.waitFor",
      "locator.click",
      "locator.fill",
      "locator.textContent",
    ]);
    expect(BRIDGE_ERROR_CODES).toEqual([
      "INVALID_REQUEST",
      "UNSUPPORTED_PROTOCOL",
      "METHOD_NOT_FOUND",
      "INVALID_PARAMS",
      "TAB_NOT_FOUND",
      "NOT_ATTACHED",
      "FRAME_NOT_FOUND",
      "LOCATOR_NOT_FOUND",
      "TIMEOUT",
      "CDP_ERROR",
      "INTERNAL_ERROR",
    ]);
  });

  it("models locators and correlated success/error responses", () => {
    const locator: Locator = { type: "role", role: "button", name: "Continue" };
    const typedRequest: BridgeRequest<"locator.click"> = {
      protocol: "1",
      id: "click-1",
      method: "locator.click",
      params: { tabId: 8, locator, frameSelectors: [{ type: "css", value: "iframe" }] },
    };
    const success: BridgeSuccessResponse = {
      protocol: "1",
      id: typedRequest.id,
      ok: true,
      result: { clicked: true },
    };
    const failure: BridgeErrorResponse = {
      protocol: "1",
      id: typedRequest.id,
      ok: false,
      error: { code: "LOCATOR_NOT_FOUND" },
    };

    expect(parseBridgeRequest(typedRequest)).toEqual(typedRequest);
    expect(parseBridgeRequestFromProtocol(typedRequest)).toEqual(typedRequest);
    expect(parseBridgeResponse(success)).toEqual(success);
    expect(parseBridgeResponse(failure)).toEqual(failure);
  });
});

describe("request validation", () => {
  it.each([
    ["bridge.status", {}],
    ["browser.listTabs", {}],
    ["browser.activeTab", {}],
    ["browser.openTab", {}],
    ["browser.openTab", { url: "https://example.test", active: false }],
    ["page.attach", { tabId: 1 }],
    ["page.detach", { tabId: 1 }],
    ["page.goto", { tabId: 1, url: "https://example.test", waitUntil: "load", timeoutMs: 5_000 }],
    ["page.evaluate", { tabId: 1, expression: "document.title", arg: { nested: [1, true, null] } }],
    ["page.content", { tabId: 1, frameSelectors: [{ type: "text", value: "Account", exact: true }] }],
    ["page.screenshot", { tabId: 1 }],
    ["page.screenshot", { tabId: 1, format: "jpeg", quality: 80, fullPage: true }],
    ["locator.waitFor", { tabId: 1, locator: { type: "css", value: "main" }, state: "hidden", timeoutMs: 1 }],
    ["locator.click", { tabId: 1, locator: { type: "text", value: "Continue" }, timeoutMs: 0 }],
    ["locator.fill", { tabId: 1, locator: { type: "role", role: "textbox", name: "Email", exact: false }, value: "private" }],
    ["locator.textContent", { tabId: 1, locator: { type: "css", value: "h1" }, frameSelectors: [] }],
  ])("accepts valid %s parameters", (method, params) => {
    expect(parseBridgeRequest(request(method, params))).toEqual(request(method, params));
  });

  it.each([
    [null, "INVALID_REQUEST"],
    [[], "INVALID_REQUEST"],
    [{ ...request("bridge.status"), protocol: "2" }, "UNSUPPORTED_PROTOCOL"],
    [{ ...request("bridge.status"), id: "" }, "INVALID_REQUEST"],
    [{ ...request("bridge.status"), id: "x".repeat(129) }, "INVALID_REQUEST"],
    [{ ...request("bridge.status"), method: "page.cookies" }, "METHOD_NOT_FOUND"],
    [{ ...request("bridge.status"), params: [] }, "INVALID_PARAMS"],
    [{ ...request("bridge.status"), params: new Date(0) }, "INVALID_PARAMS"],
    [{ ...request("bridge.status"), extra: true }, "INVALID_REQUEST"],
  ])("rejects an invalid envelope without reflecting its content", (input, code) => {
    expect(() => parseBridgeRequest(input)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    ["bridge.status", { unexpected: true }],
    ["browser.openTab", { url: 5 }],
    ["browser.openTab", { url: "not a url" }],
    ["browser.openTab", { url: "javascript:alert(1)" }],
    ["browser.openTab", { active: "yes" }],
    ["page.attach", { tabId: 0 }],
    ["page.detach", { tabId: 1.5 }],
    ["page.goto", { tabId: 1, url: "file:///private/file" }],
    ["page.goto", { tabId: 1, url: "https://example.test", waitUntil: "sometimes" }],
    ["page.goto", { tabId: 1, url: "https://example.test", timeoutMs: -1 }],
    ["page.evaluate", { tabId: 1, expression: "" }],
    ["page.evaluate", { tabId: 1, expression: "1", arg: undefined }],
    ["page.evaluate", { tabId: 1, expression: "1", arg: Number.NaN }],
    ["page.content", { tabId: 1, frameSelectors: "iframe" }],
    ["page.screenshot", { tabId: 1, format: "gif" }],
    ["page.screenshot", { tabId: 1, format: "png", quality: 80 }],
    ["page.screenshot", { tabId: 1, format: "jpeg", quality: 101 }],
    ["locator.waitFor", { tabId: 1, locator: { type: "css", value: "main" }, state: "gone" }],
    ["locator.click", { tabId: 1, locator: { type: "xpath", value: "//main" } }],
    ["locator.click", { tabId: 1, locator: {} }],
    ["locator.click", { tabId: 1, locator: { type: "text", value: "" } }],
    ["locator.click", { tabId: 1, locator: { type: "text", value: "x", exact: "yes" } }],
    ["locator.fill", { tabId: 1, locator: { type: "role", role: "", name: "Email" }, value: "x" }],
    ["locator.fill", { tabId: 1, locator: { type: "role", role: "textbox", name: 5 }, value: "x" }],
    ["locator.fill", { tabId: 1, locator: { type: "role", role: "textbox", exact: true }, value: "x" }],
    ["locator.fill", { tabId: 1, locator: { type: "css", value: "input", extra: true }, value: "x" }],
    ["locator.fill", { tabId: 1, locator: { type: "css", value: "input" }, value: 5 }],
    ["locator.textContent", { tabId: 1, locator: { type: "css", value: "h1" }, frameSelectors: [{ type: "css", value: "" }] }],
  ])("rejects invalid %s parameters", (method, params) => {
    expect(() => parseBridgeRequest(request(method, params))).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: "INVALID_PARAMS" }),
    );
  });

  it("rejects cyclic evaluation arguments", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      parseBridgeRequest(request("page.evaluate", { tabId: 1, expression: "value", arg: cyclic })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PARAMS" }));
  });
});

describe("response validation", () => {
  it.each([
    [null, "INVALID_REQUEST"],
    [{ protocol: "2", id: "r", ok: true, result: null }, "UNSUPPORTED_PROTOCOL"],
    [{ protocol: "1", id: "", ok: true, result: null }, "INVALID_REQUEST"],
    [{ protocol: "1", id: "r", ok: true }, "INVALID_REQUEST"],
    [{ protocol: "1", id: "r", ok: true, result: undefined }, "INVALID_REQUEST"],
    [{ protocol: "1", id: "r", ok: true, result: new Date(0) }, "INVALID_REQUEST"],
    [{ protocol: "1", id: "r", ok: false, error: { code: "NOPE" } }, "INVALID_REQUEST"],
    [{ protocol: "1", id: "r", ok: false, error: { code: "TIMEOUT", message: "reflected content" } }, "INVALID_REQUEST"],
    [{ protocol: "1", id: "r", ok: false, error: { code: "TIMEOUT" }, result: null }, "INVALID_REQUEST"],
  ])("rejects invalid responses", (input, code) => {
    expect(() => parseBridgeResponse(input)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("uses a fixed safe validation error message", () => {
    try {
      parseBridgeRequest({ secret: "must-not-be-reflected" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolValidationError);
      expect((error as Error).message).toBe("Bridge protocol validation failed");
      expect((error as Error).message).not.toContain("must-not-be-reflected");
    }
  });
});
