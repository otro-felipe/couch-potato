import crypto from "node:crypto";
import net from "node:net";
import {
  PROTOCOL_VERSION,
  parseBridgeResponse,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
} from "../shared/protocol.js";

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class BridgeTransport {
  private readonly pending = new Map<string, Pending>();
  private buffered = "";
  private closed = false;
  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.once("close", () => this.failAll(new BridgeError("DISCONNECTED")));
    socket.once("error", () => this.failAll(new BridgeError("DISCONNECTED")));
  }
  static async connect(
    socketPath: string,
    timeoutMs = 30_000,
  ): Promise<BridgeTransport> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new BridgeTransport(socket, timeoutMs);
  }
  request(
    method: BridgeMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new BridgeError("DISCONNECTED"));
    const id = crypto.randomUUID();
    const request = {
      protocol: PROTOCOL_VERSION,
      id,
      method,
      params,
    } as BridgeRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.failAll(new BridgeError("DISCONNECTED"));
  }
  private receive(chunk: string): void {
    this.buffered += chunk;
    if (Buffer.byteLength(this.buffered) > 1024 * 1024) {
      this.closeWith(new BridgeError("INVALID_RESPONSE"));
      return;
    }
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      let response: BridgeResponse;
      try {
        response = parseBridgeResponse(JSON.parse(line));
      } catch {
        this.closeWith(new BridgeError("INVALID_RESPONSE"));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new BridgeError(response.error.code));
    }
  }
  private closeWith(error: BridgeError): void {
    this.closed = true;
    this.socket.destroy();
    this.failAll(error);
  }
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
