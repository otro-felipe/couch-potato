/// <reference types="chrome" />

import { ChromeCdpTransport, ChromeTabAdapter } from "./chrome-adapter.js";
import { ExtensionController } from "./controller.js";
import { NativeBridge } from "./native-bridge.js";
import { CdpPageService } from "./page-service.js";

const pages = new CdpPageService(new ChromeCdpTransport());
const controller = new ExtensionController(new ChromeTabAdapter(), pages);
const bridge = new NativeBridge(chrome.runtime, controller);

bridge.start();

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "emergency-disconnect"
    ) {
      return false;
    }
    void controller.emergencyDisconnect().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  },
);
