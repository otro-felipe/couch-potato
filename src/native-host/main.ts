import { fileURLToPath } from "node:url";
import { defaultSocketEndpoint } from "./endpoint.js";
import { NativeBridgeServer } from "./server.js";
/* v8 ignore start -- executable lifecycle wiring */
export async function runNativeHost(): Promise<NativeBridgeServer> {
  const server = new NativeBridgeServer({
    ...defaultSocketEndpoint(),
    input: process.stdin,
    output: process.stdout,
  });
  await server.start();
  const shutdown = () => {
    void server.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  runNativeHost().catch(() => {
    process.stderr.write("couch-potato: native_host_start_failed\n");
    process.exitCode = 1;
  });
/* v8 ignore stop */
