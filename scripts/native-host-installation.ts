import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const NATIVE_HOST_NAME = "com.couch_potato.browser_bridge";
export function nativeHostPaths(home: string) {
  return {
    manifestPath: path.join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}.json`,
    ),
    wrapperPath: path.join(
      home,
      "Library",
      "Application Support",
      "Couch Potato",
      "native-host",
    ),
  };
}
export function deriveChromeExtensionId(manifestKey: string): string {
  const publicKey = Buffer.from(manifestKey, "base64");
  if (
    !publicKey.length ||
    publicKey.toString("base64").replace(/=+$/u, "") !==
      manifestKey.replace(/=+$/u, "")
  )
    throw new Error("Extension manifest key is invalid");
  return [
    ...crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32),
  ]
    .map((character) =>
      String.fromCharCode(97 + Number.parseInt(character, 16)),
    )
    .join("");
}
function validateExtensionId(value: string): void {
  if (!/^[a-p]{32}$/u.test(value))
    throw new Error("Invalid Chrome extension id");
}
function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
async function atomicWrite(
  target: string,
  content: string,
  mode: number,
): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, target);
}
export interface InstallOptions {
  home: string;
  projectRoot: string;
  nodePath: string;
  extensionId?: string;
}
export async function installNativeHost(options: InstallOptions) {
  if (
    ![options.home, options.projectRoot, options.nodePath].every(
      path.isAbsolute,
    )
  )
    throw new Error("Installer paths must be absolute");
  const entrypoint = path.join(
    options.projectRoot,
    "dist",
    "native-host",
    "main.js",
  );
  await readFile(entrypoint);
  let extensionId = options.extensionId;
  if (extensionId === undefined) {
    const manifest = JSON.parse(
      await readFile(
        path.join(options.projectRoot, "dist", "extension", "manifest.json"),
        "utf8",
      ),
    ) as { key?: unknown };
    if (typeof manifest.key !== "string")
      throw new Error("Extension manifest must contain a fixed key");
    extensionId = deriveChromeExtensionId(manifest.key);
  }
  validateExtensionId(extensionId);
  const paths = nativeHostPaths(options.home);
  await mkdir(path.dirname(paths.wrapperPath), {
    recursive: true,
    mode: 0o700,
  });
  await chmod(path.dirname(paths.wrapperPath), 0o700);
  await mkdir(path.dirname(paths.manifestPath), { recursive: true });
  await atomicWrite(
    paths.wrapperPath,
    `#!/bin/sh\nexec ${quote(options.nodePath)} ${quote(entrypoint)}\n`,
    0o700,
  );
  await atomicWrite(
    paths.manifestPath,
    `${JSON.stringify({ name: NATIVE_HOST_NAME, description: "Couch Potato local browser bridge", path: paths.wrapperPath, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2)}\n`,
    0o600,
  );
  return { ...paths, extensionId };
}
async function unlinkExact(target: string): Promise<boolean> {
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function uninstallNativeHost(options: { home: string }) {
  if (!path.isAbsolute(options.home))
    throw new Error("Home path must be absolute");
  const paths = nativeHostPaths(options.home);
  return {
    removedManifest: await unlinkExact(paths.manifestPath),
    removedWrapper: await unlinkExact(paths.wrapperPath),
  };
}
