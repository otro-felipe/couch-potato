import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNativeHost } from "./native-host-installation.js";
export function parseExtensionId(args: string[]): string | undefined {
  const index = args.indexOf("--extension-id");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("--extension-id requires a value");
  return value;
}
/* v8 ignore start -- executable installer wiring */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const extensionId = parseExtensionId(args);
  const result = await installNativeHost({
    home: os.homedir(),
    projectRoot,
    nodePath: process.execPath,
    ...(extensionId === undefined ? {} : { extensionId }),
  });
  process.stdout.write(`native_host_installed ${result.extensionId}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(() => {
    process.stderr.write("native_host_install_failed\n");
    process.exitCode = 1;
  });
/* v8 ignore stop */
