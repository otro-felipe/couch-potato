import { describe, expect, it, vi } from "vitest";

import type { ExtensionController } from "../src/extension/controller.js";
import { BridgeFault } from "../src/extension/errors.js";
import {
  NativeBridge,
  type NativePort,
  type NativeRuntime,
} from "../src/extension/native-bridge.js";
import type { BridgeResponse } from "../src/shared/protocol.js";

class FakePort implements NativePort {
  readonly responses: BridgeResponse[] = [];
  messageListener: ((message: unknown) => void) | undefined;
  disconnectListener: (() => void) | undefined;
  disconnect = vi.fn(() => undefined);
  onMessage = {
    addListener: (listener: (message: unknown) => void) =>
      (this.messageListener = listener),
  };
  onDisconnect = {
    addListener: (listener: () => void) => (this.disconnectListener = listener),
  };
  postMessage(message: BridgeResponse): void {
    this.responses.push(message);
  }
}

const flush = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("native extension bridge", () => {
  it("uses the fixed native host and emits correlated versioned responses", async () => {
    const port = new FakePort();
    const runtime: NativeRuntime = { connectNative: vi.fn(() => port) };
    const controller = {
      handle: vi.fn(async () => ({ attachedTabIds: [] })),
    } as unknown as ExtensionController;
    const bridge = new NativeBridge(runtime, controller);
    bridge.start();
    port.messageListener?.({
      protocol: "1",
      id: "status-1",
      method: "bridge.status",
      params: {},
    });
    await flush();

    expect(runtime.connectNative).toHaveBeenCalledWith(
      "com.couch_potato.browser_bridge",
    );
    expect(port.responses).toEqual([
      {
        protocol: "1",
        id: "status-1",
        ok: true,
        result: { attachedTabIds: [] },
      },
    ]);
    bridge.stop();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("never reflects invalid inputs or internal errors", async () => {
    const port = new FakePort();
    const controller = {
      handle: vi
        .fn()
        .mockRejectedValueOnce(new BridgeFault("TIMEOUT"))
        .mockRejectedValueOnce(new Error("private result")),
    } as unknown as ExtensionController;
    const bridge = new NativeBridge({ connectNative: () => port }, controller);
    bridge.start();
    port.messageListener?.({ secret: "must-not-be-reflected" });
    port.messageListener?.({
      protocol: "1",
      id: "one",
      method: "bridge.status",
      params: {},
    });
    port.messageListener?.({
      protocol: "1",
      id: "two",
      method: "bridge.status",
      params: {},
    });
    await flush();

    expect(port.responses).toEqual([
      {
        protocol: "1",
        id: "invalid-request",
        ok: false,
        error: { code: "INVALID_REQUEST" },
      },
      { protocol: "1", id: "one", ok: false, error: { code: "TIMEOUT" } },
      {
        protocol: "1",
        id: "two",
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      },
    ]);
  });

  it("reconnects once after failure or disconnection and ignores stale ports", () => {
    const first = new FakePort();
    const second = new FakePort();
    const scheduled: Array<() => void> = [];
    const runtime: NativeRuntime = {
      connectNative: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("host absent");
        })
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    };
    const bridge = new NativeBridge(
      runtime,
      { handle: vi.fn() } as unknown as ExtensionController,
      (callback) => scheduled.push(callback),
    );
    bridge.start();
    expect(scheduled).toHaveLength(1);
    bridge.start();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    first.disconnectListener?.();
    first.disconnectListener?.();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    first.disconnectListener?.();
    expect(scheduled).toHaveLength(0);
    second.disconnectListener?.();
    expect(scheduled).toHaveLength(1);
    bridge.stop();
    scheduled.shift()?.();
    expect(runtime.connectNative).toHaveBeenCalledTimes(3);
  });

  it("does not duplicate a pending reconnect when start is called repeatedly", () => {
    const scheduled: Array<() => void> = [];
    const runtime: NativeRuntime = {
      connectNative: vi.fn(() => {
        throw new Error("host absent");
      }),
    };
    const bridge = new NativeBridge(
      runtime,
      { handle: vi.fn() } as unknown as ExtensionController,
      (callback) => scheduled.push(callback),
    );
    bridge.start();
    bridge.start();
    bridge.start();
    expect(runtime.connectNative).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    bridge.stop();
    scheduled.shift()?.();
    expect(runtime.connectNative).toHaveBeenCalledOnce();
  });

  it("does not reconnect when native disconnect fires during an explicit stop", () => {
    const port = new FakePort();
    port.disconnect = vi.fn(() => port.disconnectListener?.());
    const scheduled: Array<() => void> = [];
    const bridge = new NativeBridge(
      { connectNative: () => port },
      { handle: vi.fn() } as unknown as ExtensionController,
      (callback) => scheduled.push(callback),
    );
    bridge.start();
    bridge.stop();
    expect(scheduled).toHaveLength(0);
  });
});
