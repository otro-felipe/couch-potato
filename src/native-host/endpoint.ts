import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
export interface SocketEndpoint {
  directory: string;
  socketPath: string;
}
export function defaultSocketEndpoint(home = os.homedir()): SocketEndpoint {
  const directory = path.join(
    home,
    "Library",
    "Application Support",
    "Couch Potato",
  );
  return { directory, socketPath: path.join(directory, "bridge.sock") };
}
async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
export async function prepareSocketEndpoint(
  endpoint: SocketEndpoint,
): Promise<void> {
  await mkdir(endpoint.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(endpoint.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Socket directory is unsafe");
  if (
    typeof process.getuid === "function" &&
    directory.uid !== process.getuid()
  )
    throw new Error("Socket directory belongs to another user");
  await chmod(endpoint.directory, 0o700);
  let existing;
  try {
    existing = await lstat(endpoint.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket())
    throw new Error("Refusing to replace a path that is not a socket");
  if (await socketIsActive(endpoint.socketPath))
    throw new Error("Couch Potato is already running");
  await unlink(endpoint.socketPath);
  return;
}
export async function removeSocketEndpoint(
  socketPath: string,
): Promise<boolean> {
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) return false;
    await unlink(socketPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
