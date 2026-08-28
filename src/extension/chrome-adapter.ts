/// <reference types="chrome" />

import { BridgeFault } from "./errors.js";
import type { CdpTransport } from "./page-service.js";
import { requireWebUrl } from "./security.js";

export type SafeTab = {
  id: number;
  active: boolean;
  windowId: number;
  url: string;
  title: string;
};

export interface TabAdapter {
  list(): Promise<SafeTab[]>;
  active(): Promise<SafeTab>;
  open(url?: string, active?: boolean): Promise<SafeTab>;
  requireWebTab(tabId: number): Promise<SafeTab>;
}

export class ChromeTabAdapter implements TabAdapter {
  async list(): Promise<SafeTab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.flatMap((tab) => {
      const safe = this.safeTab(tab);
      return safe === undefined ? [] : [safe];
    });
  }

  async active(): Promise<SafeTab> {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const safe = tabs[0] === undefined ? undefined : this.safeTab(tabs[0]);
    if (safe === undefined) throw new BridgeFault("TAB_NOT_FOUND");
    return safe;
  }

  async open(url?: string, active = true): Promise<SafeTab> {
    const target = url === undefined ? "about:blank" : requireWebUrl(url);
    const tab = await chrome.tabs.create({ active, url: target });
    const safe = this.safeTab(tab, target, true);
    if (safe === undefined) throw new BridgeFault("TAB_NOT_FOUND");
    return safe;
  }

  async requireWebTab(tabId: number): Promise<SafeTab> {
    try {
      const tab = await chrome.tabs.get(tabId);
      const safe = this.safeTab(tab);
      if (safe === undefined) throw new BridgeFault("TAB_NOT_FOUND");
      return safe;
    } catch (error) {
      if (error instanceof BridgeFault) throw error;
      throw new BridgeFault("TAB_NOT_FOUND");
    }
  }

  private safeTab(tab: chrome.tabs.Tab, fallbackUrl?: string, allowTransient = false): SafeTab | undefined {
    if (tab.id === undefined) return undefined;
    const url = tab.url ?? fallbackUrl;
    if (url === undefined) return undefined;
    if (!(allowTransient && url === "about:blank")) {
      try {
        requireWebUrl(url);
      } catch {
        return undefined;
      }
    }
    return {
      id: tab.id,
      active: tab.active,
      windowId: tab.windowId,
      url,
      title: tab.title ?? "",
    };
  }
}

export class ChromeCdpTransport implements CdpTransport {
  private readonly attached = new Set<number>();

  constructor() {
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.attached.delete(source.tabId);
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.attached.add(tabId);
    } catch {
      throw new BridgeFault("CDP_ERROR");
    }
  }

  async detach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId });
      this.attached.delete(tabId);
    } catch {
      throw new BridgeFault("CDP_ERROR");
    }
  }

  async detachAll(): Promise<void> {
    const tabIds = [...this.attached];
    let failed = false;
    for (const tabId of tabIds) {
      try {
        await this.detach(tabId);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new BridgeFault("CDP_ERROR");
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  attachedTabIds(): number[] {
    return [...this.attached];
  }

  async send(tabId: number, method: string, params: object = {}): Promise<unknown> {
    if (!this.attached.has(tabId)) throw new BridgeFault("NOT_ATTACHED");
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>);
    } catch {
      throw new BridgeFault("CDP_ERROR");
    }
  }
}
