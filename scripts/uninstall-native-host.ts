import os from "node:os";
import { fileURLToPath } from "node:url";
import { uninstallNativeHost } from "./native-host-installation.js";
/* v8 ignore start -- executable installer wiring */
export async function main(): Promise<void> {
  const result = await uninstallNativeHost({ home: os.homedir() });
  process.stdout.write(
    result.removedManifest || result.removedWrapper
      ? "native_host_uninstalled\n"
      : "native_host_not_installed\n",
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(() => {
    process.stderr.write("native_host_uninstall_failed\n");
    process.exitCode = 1;
  });
/* v8 ignore stop */
