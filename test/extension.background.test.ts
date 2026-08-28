import { afterEach, describe, expect, it, vi } from "vitest";

type Port = {
  message?: (value: unknown) => void;
  responses: unknown[];
};

function installChrome(detachFails = false): {
  port: Port;
  runtimeMessage: (
    message: unknown,
    response: (value: unknown) => void,
  ) => boolean;
} {
  const port: Port = { responses: [] };
  let runtimeMessage: (
    message: unknown,
    sender: unknown,
    response: (value: unknown) => void,
  ) => boolean = () => false;
  const chrome = {
    tabs: {
      get: vi.fn(async () => ({
        id: 1,
        active: true,
        windowId: 1,
        url: "https://example.test",
      })),
      query: vi.fn(async () => []),
      create: vi.fn(),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: detachFails
        ? vi.fn(async () => {
            throw new Error();
          })
        : vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
    },
    runtime: {
      connectNative: vi.fn(() => ({
        postMessage: (value: unknown) => port.responses.push(value),
        disconnect: vi.fn(),
        onMessage: {
          addListener: (listener: (value: unknown) => void) =>
            (port.message = listener),
        },
        onDisconnect: { addListener: vi.fn() },
      })),
      onMessage: {
        addListener: (listener: typeof runtimeMessage) =>
          (runtimeMessage = listener),
      },
    },
  };
  Object.defineProperty(globalThis, "chrome", {
    value: chrome,
    writable: true,
    configurable: true,
  });
  return {
    port,
    runtimeMessage: (message, response) =>
      runtimeMessage(message, {}, response),
  };
}

const flush = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("MV3 background worker", () => {
  afterEach(() => vi.resetModules());

  it("ignores unrelated messages and performs emergency detach", async () => {
    const state = installChrome();
    await import("../src/extension/background.js");
    expect(state.runtimeMessage(null, vi.fn())).toBe(false);
    expect(state.runtimeMessage({}, vi.fn())).toBe(false);
    expect(state.runtimeMessage({ type: "other" }, vi.fn())).toBe(false);

    state.port.message?.({
      protocol: "1",
      id: "attach",
      method: "page.attach",
      params: { tabId: 1 },
    });
    await flush();
    const response = vi.fn();
    expect(
      state.runtimeMessage({ type: "emergency-disconnect" }, response),
    ).toBe(true);
    await flush();
    expect(response).toHaveBeenCalledWith({ ok: true });
  });

  it("reports a fixed failure when emergency detach cannot complete", async () => {
    const state = installChrome(true);
    await import("../src/extension/background.js");
    state.port.message?.({
      protocol: "1",
      id: "attach",
      method: "page.attach",
      params: { tabId: 1 },
    });
    await flush();
    const response = vi.fn();
    expect(
      state.runtimeMessage({ type: "emergency-disconnect" }, response),
    ).toBe(true);
    await flush();
    expect(response).toHaveBeenCalledWith({ ok: false });
  });
});
