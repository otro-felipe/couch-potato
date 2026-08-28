import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChromeCdpTransport,
  ChromeTabAdapter,
} from "../src/extension/chrome-adapter.js";

type Listener<T> = (value: T) => void;

const installChrome = (value: unknown) => {
  Object.defineProperty(globalThis, "chrome", {
    value,
    writable: true,
    configurable: true,
  });
};

describe("Chrome tab adapter", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns only controllable web tabs and finds the active tab", async () => {
    const tabs = [
      {
        id: 1,
        active: true,
        windowId: 2,
        url: "https://example.com",
        title: "Example",
      },
      {
        id: 2,
        active: false,
        windowId: 2,
        url: "chrome://settings",
        title: "Settings",
      },
      { active: false, windowId: 2, url: "https://missing-id.test" },
      { id: 4, active: false, windowId: 2 },
    ];
    installChrome({
      tabs: {
        query: vi.fn(async (query) => ("active" in query ? [tabs[0]] : tabs)),
      },
    });
    const adapter = new ChromeTabAdapter();
    await expect(adapter.list()).resolves.toEqual([tabs[0]]);
    await expect(adapter.active()).resolves.toEqual(tabs[0]);
  });

  it("opens a safe explicit page or a transient blank tab", async () => {
    const create = vi.fn(async ({ url, active }) => ({
      id: 5,
      windowId: 1,
      active,
      url,
    }));
    installChrome({ tabs: { create } });
    const adapter = new ChromeTabAdapter();
    await expect(
      adapter.open("https://example.test", false),
    ).resolves.toMatchObject({ id: 5, active: false });
    await expect(adapter.open()).resolves.toMatchObject({
      url: "about:blank",
      active: true,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports missing, privileged, and failed tab lookups without reflecting details", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        id: 1,
        active: true,
        windowId: 1,
        url: "file:///private",
      })
      .mockRejectedValueOnce(new Error("private browser failure"));
    installChrome({
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({
          active: true,
          windowId: 1,
          url: "https://example.test",
        })),
        get,
      },
    });
    const adapter = new ChromeTabAdapter();
    await expect(adapter.active()).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    await expect(adapter.open("https://example.test")).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    await expect(adapter.requireWebTab(1)).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    await expect(adapter.requireWebTab(2)).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
    });
    get.mockResolvedValueOnce({
      id: 3,
      active: true,
      windowId: 1,
      url: "https://example.test",
    });
    await expect(adapter.requireWebTab(3)).resolves.toMatchObject({ id: 3 });
  });
});

describe("Chrome debugger transport", () => {
  it("tracks attachment, sends commands, and observes external detach", async () => {
    let onDetach: Listener<{ tabId?: number }> = () => undefined;
    const api = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({ result: true })),
      onDetach: {
        addListener: (listener: Listener<{ tabId?: number }>) =>
          (onDetach = listener),
      },
    };
    installChrome({ debugger: api });
    const transport = new ChromeCdpTransport();
    await transport.attach(2);
    await transport.attach(2);
    await expect(transport.send(2, "Page.enable")).resolves.toEqual({
      result: true,
    });
    expect(transport.attachedTabIds()).toEqual([2]);
    onDetach({});
    expect(transport.isAttached(2)).toBe(true);
    onDetach({ tabId: 2 });
    expect(transport.isAttached(2)).toBe(false);
    await expect(transport.send(2, "Page.enable")).rejects.toMatchObject({
      code: "NOT_ATTACHED",
    });
    expect(api.attach).toHaveBeenCalledOnce();
  });

  it("detaches all tracked tabs and maps browser failures", async () => {
    const api = {
      attach: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error()),
      detach: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error()),
      sendCommand: vi.fn().mockRejectedValue(new Error()),
      onDetach: { addListener: vi.fn() },
    };
    installChrome({ debugger: api });
    const transport = new ChromeCdpTransport();
    await transport.attach(1);
    await transport.attach(2);
    await expect(transport.send(1, "Runtime.enable")).rejects.toMatchObject({
      code: "CDP_ERROR",
    });
    await transport.detachAll();
    expect(transport.attachedTabIds()).toEqual([]);
    await expect(transport.attach(3)).rejects.toMatchObject({
      code: "CDP_ERROR",
    });
    Object.defineProperty(transport, "attached", {
      value: new Set([4]),
      configurable: true,
    });
    await expect(transport.detach(4)).rejects.toMatchObject({
      code: "CDP_ERROR",
    });
  });

  it("continues emergency detach after one tab fails", async () => {
    const api = {
      attach: vi.fn(async () => undefined),
      detach: vi
        .fn()
        .mockRejectedValueOnce(new Error())
        .mockResolvedValueOnce(undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
    };
    installChrome({ debugger: api });
    const transport = new ChromeCdpTransport();
    await transport.attach(1);
    await transport.attach(2);
    await expect(transport.detachAll()).rejects.toMatchObject({
      code: "CDP_ERROR",
    });
    expect(api.detach).toHaveBeenCalledTimes(2);
    expect(transport.attachedTabIds()).toEqual([1]);
  });
});
