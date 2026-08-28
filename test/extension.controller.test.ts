import { describe, expect, it, vi } from "vitest";

import type { TabAdapter } from "../src/extension/chrome-adapter.js";
import { ExtensionController } from "../src/extension/controller.js";
import type { CdpPageService } from "../src/extension/page-service.js";
import type { BridgeRequest } from "../src/shared/protocol.js";

const request = <M extends BridgeRequest["method"]>(
  method: M,
  params: Extract<BridgeRequest, { method: M }>["params"],
): Extract<BridgeRequest, { method: M }> =>
  ({ protocol: "1", id: method, method, params }) as Extract<
    BridgeRequest,
    { method: M }
  >;

describe("extension request controller", () => {
  it("routes every allowlisted method to its narrow service", async () => {
    const tab = {
      id: 3,
      active: true,
      windowId: 1,
      url: "https://example.com",
      title: "Example",
    };
    const tabs: TabAdapter = {
      list: vi.fn(async () => [tab]),
      active: vi.fn(async () => tab),
      open: vi.fn(async () => tab),
      close: vi.fn(async () => ({ closed: true as const })),
      requireWebTab: vi.fn(async () => tab),
    };
    const pages = {
      status: vi.fn(() => ({ attachedTabIds: [3] })),
      attach: vi.fn(async () => ({ attached: true })),
      detach: vi.fn(async () => ({ attached: false })),
      goto: vi.fn(async () => ({ url: tab.url })),
      evaluate: vi.fn(async () => 42),
      content: vi.fn(async () => "<html></html>"),
      screenshot: vi.fn(async () => "data"),
      waitFor: vi.fn(async () => ({ state: "visible" })),
      click: vi.fn(async () => ({ clicked: true })),
      activate: vi.fn(async () => ({ activated: true })),
      fill: vi.fn(async () => ({ filled: true })),
      textContent: vi.fn(async () => "hello"),
      detachAll: vi.fn(async () => undefined),
    } as unknown as CdpPageService;
    const controller = new ExtensionController(tabs, pages);
    const locator = { type: "css", value: "main" } as const;

    expect(await controller.handle(request("bridge.status", {}))).toEqual({
      protocol: "1",
      attachedTabIds: [3],
    });
    expect(await controller.handle(request("browser.listTabs", {}))).toEqual([
      tab,
    ]);
    expect(await controller.handle(request("browser.activeTab", {}))).toEqual(
      tab,
    );
    expect(
      await controller.handle(
        request("browser.openTab", { url: tab.url, active: false }),
      ),
    ).toEqual(tab);
    expect(await controller.handle(request("browser.openTab", {}))).toEqual(
      tab,
    );
    expect(
      await controller.handle(request("page.attach", { tabId: 3 })),
    ).toEqual({ attached: true });
    expect(
      await controller.handle(request("page.detach", { tabId: 3 })),
    ).toEqual({ attached: false });
    expect(
      await controller.handle(request("page.close", { tabId: 3 })),
    ).toEqual({ closed: true });
    expect(
      await controller.handle(
        request("page.goto", {
          tabId: 3,
          url: tab.url,
          waitUntil: "domcontentloaded",
          timeoutMs: 2,
        }),
      ),
    ).toEqual({ url: tab.url });
    expect(
      await controller.handle(
        request("page.evaluate", { tabId: 3, expression: "arg", arg: 42 }),
      ),
    ).toBe(42);
    expect(
      await controller.handle(
        request("page.content", { tabId: 3, frameSelectors: [] }),
      ),
    ).toBe("<html></html>");
    expect(
      await controller.handle(
        request("page.screenshot", {
          tabId: 3,
          frameSelectors: [],
          format: "jpeg",
          quality: 80,
          fullPage: true,
        }),
      ),
    ).toBe("data");
    expect(
      await controller.handle(
        request("locator.waitFor", {
          tabId: 3,
          locator,
          frameSelectors: [],
          state: "visible",
          timeoutMs: 2,
        }),
      ),
    ).toEqual({ state: "visible" });
    expect(
      await controller.handle(
        request("locator.click", { tabId: 3, locator, timeoutMs: 2 }),
      ),
    ).toEqual({ clicked: true });
    expect(
      await controller.handle(
        request("locator.activate", {
          tabId: 3,
          locator,
          frameSelectors: [],
          timeoutMs: 2,
        }),
      ),
    ).toEqual({ activated: true });
    expect(
      await controller.handle(
        request("locator.fill", { tabId: 3, locator, value: "private" }),
      ),
    ).toEqual({ filled: true });
    expect(
      await controller.handle(
        request("locator.textContent", { tabId: 3, locator }),
      ),
    ).toBe("hello");
    await controller.emergencyDisconnect();

    expect(tabs.requireWebTab).toHaveBeenCalledWith(3);
    expect(tabs.open).toHaveBeenNthCalledWith(1, tab.url, false);
    expect(tabs.open).toHaveBeenNthCalledWith(2, undefined, undefined);
    expect(tabs.close).toHaveBeenCalledWith(3);
    expect(pages.detachAll).toHaveBeenCalledOnce();
  });

  it("still closes the owned tab when explicit debugger detach fails", async () => {
    const detach = vi.fn(async () => {
      throw new Error("detached externally");
    });
    const close = vi.fn(async () => ({ closed: true as const }));
    const controller = new ExtensionController(
      { close } as unknown as TabAdapter,
      { detach } as unknown as CdpPageService,
    );

    await expect(
      controller.handle(request("page.close", { tabId: 8 })),
    ).resolves.toEqual({ closed: true });
    expect(detach).toHaveBeenCalledWith(8);
    expect(close).toHaveBeenCalledWith(8);
  });

  it("surfaces a tab-close failure after attempting debugger detach", async () => {
    const failure = new Error("close failed");
    const detach = vi.fn(async () => ({ attached: false as const }));
    const close = vi.fn(async () => {
      throw failure;
    });
    const controller = new ExtensionController(
      { close } as unknown as TabAdapter,
      { detach } as unknown as CdpPageService,
    );

    await expect(
      controller.handle(request("page.close", { tabId: 9 })),
    ).rejects.toBe(failure);
    expect(detach).toHaveBeenCalledWith(9);
  });
});
