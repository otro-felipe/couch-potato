import {
  PROTOCOL_VERSION,
  type BridgeRequest,
  type JsonValue,
} from "../shared/protocol.js";
import type { TabAdapter } from "./chrome-adapter.js";
import { CdpPageService } from "./page-service.js";
import { requireWebUrl } from "./security.js";

export class ExtensionController {
  constructor(
    private readonly tabs: TabAdapter,
    private readonly pages: CdpPageService,
  ) {}

  async handle(request: BridgeRequest): Promise<JsonValue> {
    switch (request.method) {
      case "bridge.status":
        return { protocol: PROTOCOL_VERSION, ...this.pages.status() };
      case "browser.listTabs":
        return await this.tabs.list();
      case "browser.activeTab":
        return await this.tabs.active();
      case "browser.openTab": {
        const url =
          request.params.url === undefined
            ? undefined
            : requireWebUrl(request.params.url);
        return await this.tabs.open(url, request.params.active);
      }
      case "page.attach":
        await this.tabs.requireWebTab(request.params.tabId);
        return await this.pages.attach(request.params.tabId);
      case "page.detach":
        return await this.pages.detach(request.params.tabId);
      case "page.close": {
        try {
          await this.pages.detach(request.params.tabId);
        } catch {
          // Removing an owned tab also releases any remaining debugger session.
        }
        return await this.tabs.close(request.params.tabId);
      }
      case "page.goto":
        return await this.pages.goto(
          request.params.tabId,
          request.params.url,
          request.params.waitUntil,
          request.params.timeoutMs,
        );
      case "page.evaluate":
        return await this.pages.evaluate(
          request.params.tabId,
          request.params.expression,
          request.params.arg,
        );
      case "page.content":
        return await this.pages.content(
          request.params.tabId,
          request.params.frameSelectors,
        );
      case "page.screenshot":
        return await this.pages.screenshot(
          request.params.tabId,
          request.params.frameSelectors,
          request.params.format,
          request.params.quality,
          request.params.fullPage,
        );
      case "locator.waitFor":
        return await this.pages.waitFor(
          request.params.tabId,
          request.params.locator,
          request.params.frameSelectors,
          request.params.state,
          request.params.timeoutMs,
        );
      case "locator.click":
        return await this.pages.click(
          request.params.tabId,
          request.params.locator,
          request.params.frameSelectors,
          request.params.timeoutMs,
        );
      case "locator.activate":
        return await this.pages.activate(
          request.params.tabId,
          request.params.locator,
          request.params.frameSelectors,
          request.params.timeoutMs,
        );
      case "locator.fill":
        return await this.pages.fill(
          request.params.tabId,
          request.params.locator,
          request.params.frameSelectors,
          request.params.value,
          request.params.timeoutMs,
        );
      case "locator.textContent":
        return await this.pages.textContent(
          request.params.tabId,
          request.params.locator,
          request.params.frameSelectors,
          request.params.timeoutMs,
        );
    }
  }

  async emergencyDisconnect(): Promise<void> {
    await this.pages.detachAll();
  }
}
