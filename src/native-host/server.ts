import { chmod } from "node:fs/promises";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  parseBridgeRequest,
  parseBridgeResponse,
  type BridgeErrorCode,
  type BridgeRequest,
  type BridgeResponse,
} from "../shared/protocol.js";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.js";
import {
  prepareSocketEndpoint,
  removeSocketEndpoint,
  type SocketEndpoint,
} from "./endpoint.js";
const MAX_LINE_BYTES = 1024 * 1024;
type Pending = { socket: net.Socket; timer: NodeJS.Timeout };
type FailureReason =
  | "invalid_request"
  | "duplicate_request"
  | "timeout"
  | "disconnected"
  | "invalid_response";
const errorCodes: Record<string, BridgeErrorCode> = {
  invalid_request: "INVALID_REQUEST",
  duplicate_request: "INVALID_REQUEST",
  timeout: "TIMEOUT",
  disconnected: "CDP_ERROR",
  invalid_response: "CDP_ERROR",
};
function errorResponse(id: string, reason: FailureReason): BridgeResponse {
  return {
    protocol: PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code: errorCodes[reason]! },
  };
}
function writeLine(socket: net.Socket, value: BridgeResponse): void {
  socket.write(`${JSON.stringify(value)}\n`);
}
export interface NativeBridgeServerOptions extends SocketEndpoint {
  input: Readable;
  output: Writable;
  requestTimeoutMs?: number;
}
export class NativeBridgeServer {
  readonly socketPath: string;
  private readonly directory: string;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly pendingBySocket = new Map<net.Socket, Set<string>>();
  private readonly sockets = new Set<net.Socket>();
  private readonly decoder = new NativeMessageDecoder();
  private server?: net.Server;
  private stopped = false;
  constructor(options: NativeBridgeServerOptions) {
    this.directory = options.directory;
    this.socketPath = options.socketPath;
    this.input = options.input;
    this.output = options.output;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }
  async start(): Promise<void> {
    if (this.server) throw new Error("Native bridge already started");
    await prepareSocketEndpoint({
      directory: this.directory,
      socketPath: this.socketPath,
    });
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on("error", () => this.failAll("disconnected"));
    this.input.on("data", this.onChromeData);
    this.input.once("end", this.onChromeEnd);
    this.input.once("error", this.onChromeEnd);
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.input.off("data", this.onChromeData);
    this.input.off("end", this.onChromeEnd);
    this.input.off("error", this.onChromeEnd);
    this.failAll("disconnected");
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    await removeSocketEndpoint(this.socketPath);
  }
  private readonly onChromeData = (chunk: Buffer) => {
    try {
      for (const message of this.decoder.push(chunk))
        this.receiveChromeMessage(message);
    } catch {
      this.failAll("invalid_response");
    }
  };
  private readonly onChromeEnd = () => {
    void this.stop();
  };
  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    this.sockets.add(socket);
    this.pendingBySocket.set(socket, new Set());
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
        buffered = "";
        writeLine(socket, errorResponse("invalid", "invalid_request"));
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        this.receiveClientLine(socket, line);
      }
    });
    const remove = () => {
      this.sockets.delete(socket);
      const ids = this.pendingBySocket.get(socket)!;
      for (const id of [...ids]) this.deletePending(id);
      this.pendingBySocket.delete(socket);
    };
    socket.once("close", remove);
    socket.on("error", () => socket.destroy());
  }
  private receiveClientLine(socket: net.Socket, line: string): void {
    let request: BridgeRequest;
    try {
      request = parseBridgeRequest(JSON.parse(line));
    } catch {
      writeLine(socket, errorResponse("invalid", "invalid_request"));
      return;
    }
    if (this.pending.has(request.id)) {
      writeLine(socket, errorResponse(request.id, "duplicate_request"));
      return;
    }
    const timer = setTimeout(() => {
      this.deletePending(request.id);
      writeLine(socket, errorResponse(request.id, "timeout"));
    }, this.timeoutMs);
    this.pending.set(request.id, { socket, timer });
    this.pendingBySocket.get(socket)!.add(request.id);
    this.output.write(encodeNativeMessage(request));
  }
  private receiveChromeMessage(value: unknown): void {
    let response: BridgeResponse;
    try {
      response = parseBridgeResponse(value);
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.deletePending(response.id);
    writeLine(pending.socket, response);
  }
  private deletePending(id: string): void {
    const pending = this.pending.get(id)!;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.pendingBySocket.get(pending.socket)!.delete(id);
  }
  private failAll(reason: FailureReason): void {
    for (const [id, pending] of [...this.pending]) {
      writeLine(pending.socket, errorResponse(id, reason));
      this.deletePending(id);
    }
  }
}
