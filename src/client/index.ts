import { defaultSocketEndpoint } from "../native-host/endpoint.js";
import { Browser } from "./browser.js";
import { BridgeTransport } from "./transport.js";
export { BridgeError } from "./transport.js";
export { Browser, FrameLocator, Locator, Page } from "./browser.js";
export type { Screenshot, TabInfo, WaitForOptions } from "./browser.js";
export interface ConnectOptions {
  socketPath?: string;
  timeoutMs?: number;
}
export async function connect(options: ConnectOptions = {}): Promise<Browser> {
  return new Browser(
    await BridgeTransport.connect(
      options.socketPath ?? defaultSocketEndpoint().socketPath,
      options.timeoutMs,
    ),
  );
}
