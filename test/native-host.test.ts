import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSocketEndpoint,
  prepareSocketEndpoint,
  removeSocketEndpoint,
} from "../src/native-host/endpoint.js";
import { NativeBridgeServer } from "../src/native-host/server.js";
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from "../src/native-host/framing.js";
import "../src/native-host/main.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function line(socket: net.Socket): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data;
      const at = buffered.indexOf("\n");
      if (at >= 0) resolve(JSON.parse(buffered.slice(0, at)));
    });
    socket.once("error", reject);
  });
}
async function setup(timeout = 1000) {
  const directory = await mkdtemp(path.join(tmpdir(), "cp-host-"));
  const socketPath = path.join(directory, "bridge.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  const bridge = new NativeBridgeServer({
    directory,
    socketPath,
    input,
    output,
    requestTimeoutMs: timeout,
  });
  await bridge.start();
  cleanup.push(() => bridge.stop());
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) =>
    socket.once("connect", resolve).once("error", reject),
  );
  return { bridge, socket, input, output };
}

describe("private socket endpoint", () => {
  it("uses the macOS application support location", () => {
    expect(defaultSocketEndpoint("/home").socketPath).toBe(
      "/home/Library/Application Support/Couch Potato/bridge.sock",
    );
    expect(defaultSocketEndpoint().socketPath).toContain(
      "Library/Application Support",
    );
  });
  it("sets private modes and removes a stale socket", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cp-stale-"));
    await chmod(directory, 0o755);
    const socketPath = path.join(directory, "bridge.sock");
    const stale = spawn(process.execPath, [
      "-e",
      "require('net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",
      socketPath,
    ]);
    await new Promise<void>((resolve) =>
      stale.stdout.once("data", () => resolve()),
    );
    stale.kill("SIGKILL");
    await new Promise<void>((resolve) => stale.once("exit", () => resolve()));
    await prepareSocketEndpoint({ directory, socketPath });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses active sockets and non-sockets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cp-safe-"));
    const socketPath = path.join(directory, "bridge.sock");
    await writeFile(socketPath, "keep");
    await expect(
      prepareSocketEndpoint({ directory, socketPath }),
    ).rejects.toThrow("not a socket");
    expect(await removeSocketEndpoint(socketPath)).toBe(false);
    const activePath = path.join(directory, "active.sock");
    const active = net.createServer();
    cleanup.push(() => new Promise((resolve) => active.close(() => resolve())));
    await new Promise<void>((resolve) => active.listen(activePath, resolve));
    await expect(
      prepareSocketEndpoint({ directory, socketPath: activePath }),
    ).rejects.toThrow("already running");
    expect(await removeSocketEndpoint(path.join(directory, "missing"))).toBe(
      false,
    );
    const removablePath = path.join(directory, "removable.sock");
    const removable = net.createServer();
    cleanup.push(
      () => new Promise((resolve) => removable.close(() => resolve())),
    );
    await new Promise<void>((resolve) =>
      removable.listen(removablePath, resolve),
    );
    expect(await removeSocketEndpoint(removablePath)).toBe(true);
  });
  it("rejects unsafe ownership, symlinks and unexpected filesystem errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cp-owner-"));
    const real = path.join(root, "real");
    await mkdir(real);
    const linked = path.join(root, "linked");
    await symlink(real, linked);
    await expect(
      prepareSocketEndpoint({
        directory: linked,
        socketPath: path.join(linked, "bridge.sock"),
      }),
    ).rejects.toThrow("unsafe");
    const getuid = process.getuid!;
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => getuid() + 1,
    });
    await expect(
      prepareSocketEndpoint({
        directory: real,
        socketPath: path.join(real, "bridge.sock"),
      }),
    ).rejects.toThrow("another user");
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: getuid,
    });
    const tooLong = path.join(root, "x".repeat(2048));
    await expect(
      prepareSocketEndpoint({ directory: real, socketPath: tooLong }),
    ).rejects.toBeDefined();
    await expect(removeSocketEndpoint(tooLong)).rejects.toBeDefined();
  });
});

describe("native host relay", () => {
  it("frames requests and routes responses by id", async () => {
    const { socket, input, output } = await setup();
    const decoder = new NativeMessageDecoder();
    const received = new Promise<any>((resolve) =>
      output.once("data", (data) => resolve(decoder.push(data)[0])),
    );
    const request = {
      protocol: "1",
      id: "one",
      method: "bridge.status",
      params: {},
    };
    socket.write(`${JSON.stringify(request)}\n`);
    expect(await received).toEqual(request);
    const response = {
      protocol: "1",
      id: "one",
      ok: true,
      result: { connected: true },
    };
    input.write(encodeNativeMessage(response));
    expect(await line(socket)).toEqual(response);
  });
  it("returns safe validation, duplicate, timeout and disconnect errors", async () => {
    const { socket } = await setup(15);
    socket.write("bad\n");
    expect(await line(socket)).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    const request = {
      protocol: "1",
      id: "same",
      method: "bridge.status",
      params: {},
    };
    socket.write(`${JSON.stringify(request)}\n${JSON.stringify(request)}\n`);
    expect(await line(socket)).toMatchObject({
      id: "same",
      error: { code: "INVALID_REQUEST" },
    });
    expect(await line(socket)).toMatchObject({
      id: "same",
      error: { code: "TIMEOUT" },
    });
    const disconnected = await setup();
    disconnected.socket.write(
      `${JSON.stringify({ ...request, id: "pending" })}\n`,
    );
    const closed = new Promise<void>((resolve) =>
      disconnected.socket.once("close", resolve),
    );
    disconnected.input.end();
    await closed;
    await expect(lstat(disconnected.bridge.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects oversized client lines and ignores unmatched or invalid Chrome responses", async () => {
    const { socket, input, output } = await setup();
    socket.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
    expect(await line(socket)).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    input.write(encodeNativeMessage({ nope: true }));
    input.write(
      encodeNativeMessage({
        protocol: "1",
        id: "unknown",
        ok: true,
        result: null,
      }),
    );
    const forwarded = new Promise<void>((resolve) =>
      output.once("data", () => resolve()),
    );
    socket.write(
      `${JSON.stringify({ protocol: "1", id: "framing", method: "bridge.status", params: {} })}\n`,
    );
    await forwarded;
    const failed = line(socket);
    input.write(Buffer.from([0, 0, 0, 0]));
    expect(await failed).toMatchObject({
      id: "framing",
      error: { code: "CDP_ERROR" },
    });
  });
  it("guards lifecycle idempotently", async () => {
    const running = await setup();
    await expect(running.bridge.start()).rejects.toThrow("already started");
    const decoder = new NativeMessageDecoder();
    let forwarded = 0;
    const bothForwarded = new Promise<void>((resolve) =>
      running.output.on("data", (data) => {
        forwarded += decoder.push(data).length;
        if (forwarded >= 2) resolve();
      }),
    );
    running.socket.write(
      `${JSON.stringify({ protocol: "1", id: "kept", method: "bridge.status", params: {} })}\n`,
    );
    const second = net.createConnection(running.bridge.socketPath);
    await new Promise<void>((resolve) => second.once("connect", resolve));
    second.write(
      `${JSON.stringify({ protocol: "1", id: "closed", method: "bridge.status", params: {} })}\n`,
    );
    await bothForwarded;
    const internals = running.bridge as unknown as {
      pendingBySocket: Map<net.Socket, Set<string>>;
    };
    const serverSide = [...internals.pendingBySocket].find(([, ids]) =>
      ids.has("closed"),
    )![0];
    const secondClosed = new Promise<void>((resolve) =>
      second.once("close", resolve),
    );
    serverSide.emit("error", new Error("test transport failure"));
    await secondClosed;
    await running.bridge.stop();
    await running.bridge.stop();
    const root = await mkdtemp(path.join(tmpdir(), "cp-never-started-"));
    const neverStarted = new NativeBridgeServer({
      directory: root,
      socketPath: path.join(root, "bridge.sock"),
      input: new PassThrough(),
      output: new PassThrough(),
    });
    await neverStarted.stop();
  });
});
