#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { connect, type Browser } from "./index.js";
export async function runCli(
  command: string | undefined,
  write: (line: string) => unknown = (line) =>
    process.stdout.write(`${line}\n`),
  connector: () => Promise<Browser> = () => connect({ timeoutMs: 5_000 }),
): Promise<number> {
  if (
    command !== "status" &&
    command !== "doctor" &&
    command !== "detach-all"
  ) {
    write("usage: couch-potato <status|doctor|detach-all>");
    return 2;
  }
  const failure = {
    status: "bridge_unavailable",
    doctor: "doctor_failed",
    "detach-all": "bridge_unavailable",
  }[command];
  let browser: Browser;
  try {
    browser = await connector();
  } catch {
    write(failure);
    return 1;
  }
  try {
    if (command === "detach-all") {
      await browser.detachAll();
      write("detach_all_ok");
    } else {
      await browser.status();
      write(command === "doctor" ? "doctor_ok" : "bridge_connected");
    }
    browser.close();
    return 0;
  } catch {
    browser.close();
    write(failure);
    return 1;
  }
}
// Executable entrypoint; runCli itself is exercised directly by the tests.
/* v8 ignore next 3 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv[2]);
}
