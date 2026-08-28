import {
  PROTOCOL_VERSION,
  type BridgeErrorCode,
  type BridgeResponse,
} from "../shared/protocol.js";
import {
  ProtocolValidationError,
  parseBridgeRequest,
} from "../shared/validation.js";
import { ExtensionController } from "./controller.js";
import { asBridgeFault } from "./errors.js";

export type MessageEvent<T> = {
  addListener(listener: (message: T) => void): void;
};
export type DisconnectEvent = { addListener(listener: () => void): void };

export type NativePort = {
  postMessage(message: BridgeResponse): void;
  disconnect(): void;
  onMessage: MessageEvent<unknown>;
  onDisconnect: DisconnectEvent;
};

export type NativeRuntime = {
  connectNative(hostName: string): NativePort;
};

type Scheduler = (callback: () => void, delayMs: number) => unknown;

export class NativeBridge {
  private port: NativePort | undefined;
  private reconnectPending = false;
  private stopped = false;

  constructor(
    private readonly runtime: NativeRuntime,
    private readonly controller: ExtensionController,
    private readonly schedule: Scheduler = setTimeout,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.port !== undefined || this.reconnectPending) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.port?.disconnect();
    this.port = undefined;
  }

  private connect(): void {
    if (this.stopped || this.port !== undefined) return;
    let port: NativePort;
    try {
      port = this.runtime.connectNative("com.couch_potato.browser_bridge");
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => void this.receive(port, message));
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = undefined;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectPending) return;
    this.reconnectPending = true;
    this.schedule(() => {
      this.reconnectPending = false;
      this.connect();
    }, 1_000);
  }

  private async receive(port: NativePort, message: unknown): Promise<void> {
    let id = "invalid-request";
    try {
      const request = parseBridgeRequest(message);
      id = request.id;
      const result = await this.controller.handle(request);
      this.post(port, { protocol: PROTOCOL_VERSION, id, ok: true, result });
    } catch (error) {
      const code: BridgeErrorCode =
        error instanceof ProtocolValidationError
          ? error.code
          : asBridgeFault(error).code;
      this.post(port, {
        protocol: PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code },
      });
    }
  }

  private post(port: NativePort, response: BridgeResponse): void {
    if (this.port === port) port.postMessage(response);
  }
}
