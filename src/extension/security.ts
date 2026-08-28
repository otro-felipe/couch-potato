import { BridgeFault } from "./errors.js";

const BLOCKED_HTTPS_HOSTS = new Set([
  "chromewebstore.google.com",
  "chrome.google.com",
]);

export function requireWebUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeFault("INVALID_PARAMS");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    BLOCKED_HTTPS_HOSTS.has(url.hostname)
  ) {
    throw new BridgeFault("INVALID_PARAMS");
  }
  return value;
}
