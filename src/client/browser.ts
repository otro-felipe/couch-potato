import type {
  BridgeMethod,
  JsonValue,
  Locator as LocatorContract,
} from "../shared/protocol.js";
import { BridgeTransport } from "./transport.js";

export interface TabInfo {
  tabId: number;
  title: string;
  url: string;
  active?: boolean;
}
export interface Screenshot {
  base64: string;
  mimeType: string;
}
export interface WaitForOptions {
  state?: "attached" | "visible" | "hidden" | "detached";
  timeoutMs?: number;
}

function parseTab(value: unknown): TabInfo {
  if (!value || typeof value !== "object")
    throw new Error("Bridge returned an invalid tab");
  const tab = value as {
    id?: unknown;
    title?: unknown;
    url?: unknown;
    active?: unknown;
  };
  if (
    !Number.isInteger(tab.id) ||
    typeof tab.title !== "string" ||
    typeof tab.url !== "string"
  )
    throw new Error("Bridge returned an invalid tab");
  return {
    tabId: tab.id as number,
    title: tab.title,
    url: tab.url,
    ...(typeof tab.active === "boolean" ? { active: tab.active } : {}),
  };
}
function parseTabs(value: unknown): TabInfo[] {
  if (!Array.isArray(value))
    throw new Error("Bridge returned an invalid tab list");
  return value.map(parseTab);
}
function parseContent(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Bridge returned invalid page content");
  return value;
}
function role(
  roleName: string,
  options: { name?: string; exact?: boolean },
): LocatorContract {
  const value: { type: "role"; role: string; name?: string; exact?: boolean } =
    { type: "role", role: roleName };
  if (options.name !== undefined) value.name = options.name;
  if (options.exact !== undefined) value.exact = options.exact;
  return value;
}

export class Browser {
  private readonly pages = new Map<number, Page>();
  constructor(private readonly transport: BridgeTransport) {}
  status(): Promise<unknown> {
    return this.transport.request("bridge.status", {});
  }
  async listTabs(): Promise<TabInfo[]> {
    return parseTabs(await this.transport.request("browser.listTabs", {}));
  }
  async activePage(): Promise<Page> {
    return this.attach(
      parseTab(await this.transport.request("browser.activeTab", {})),
    );
  }
  async openPage(
    url?: string,
    options: { active?: boolean } = {},
  ): Promise<Page> {
    const params: Record<string, unknown> = { ...options };
    if (url !== undefined) params.url = url;
    const info = parseTab(
      await this.transport.request("browser.openTab", params),
    );
    try {
      return await this.attach(info);
    } catch (error) {
      try {
        await this.transport.request("page.close", { tabId: info.tabId });
      } catch {
        // Preserve the attachment failure after best-effort owned-tab cleanup.
      }
      throw error;
    }
  }
  async detachAll(): Promise<void> {
    const status = await this.status();
    if (
      !status ||
      typeof status !== "object" ||
      !Array.isArray((status as { attachedTabIds?: unknown }).attachedTabIds)
    )
      throw new Error("Bridge returned an invalid status");
    const ids = (status as { attachedTabIds: unknown[] }).attachedTabIds;
    if (!ids.every((id) => Number.isInteger(id) && (id as number) > 0))
      throw new Error("Bridge returned an invalid status");
    await Promise.all(
      ids.map((tabId) => this.transport.request("page.detach", { tabId })),
    );
    this.pages.clear();
  }
  close(): void {
    this.transport.close();
  }
  private async attach(info: TabInfo): Promise<Page> {
    const existing = this.pages.get(info.tabId);
    if (existing) return existing;
    await this.transport.request("page.attach", { tabId: info.tabId });
    const page = new Page(this.transport, info, () =>
      this.pages.delete(info.tabId),
    );
    this.pages.set(info.tabId, page);
    return page;
  }
}

export class Page {
  readonly tabId: number;
  readonly initialTitle: string;
  readonly initialUrl: string;
  private detached = false;
  private closed = false;
  private released = false;
  constructor(
    private readonly transport: BridgeTransport,
    info: TabInfo,
    private readonly onDetach: () => void,
  ) {
    this.tabId = info.tabId;
    this.initialTitle = info.title;
    this.initialUrl = info.url;
  }
  goto(
    url: string,
    options: {
      waitUntil?: "none" | "domcontentloaded" | "load";
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    return this.command("page.goto", { url, ...options });
  }
  evaluate(expression: string, arg?: JsonValue): Promise<unknown> {
    const params: Record<string, unknown> = { expression };
    if (arg !== undefined) params.arg = arg;
    return this.command("page.evaluate", params);
  }
  async content(): Promise<string> {
    return parseContent(await this.command("page.content", {}));
  }
  async screenshot(
    options: {
      format?: "png" | "jpeg";
      quality?: number;
      fullPage?: boolean;
    } = {},
  ): Promise<Screenshot> {
    const result = await this.command("page.screenshot", options);
    if (typeof result !== "string")
      throw new Error("Bridge returned an invalid screenshot");
    return {
      base64: result,
      mimeType: options.format === "jpeg" ? "image/jpeg" : "image/png",
    };
  }
  locator(selector: string): Locator {
    return new Locator(this, { type: "css", value: selector }, []);
  }
  getByText(value: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { type: "text", value, ...options }, []);
  }
  getByRole(
    roleName: string,
    options: { name?: string; exact?: boolean } = {},
  ): Locator {
    return new Locator(this, role(roleName, options), []);
  }
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this, [{ type: "css", value: selector }]);
  }
  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    try {
      await this.transport.request("page.detach", { tabId: this.tabId });
    } finally {
      this.release();
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detached = true;
    try {
      await this.transport.request("page.close", { tabId: this.tabId });
    } finally {
      this.release();
    }
  }
  command(
    method: BridgeMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Page is closed"));
    if (this.detached) return Promise.reject(new Error("Page is detached"));
    return this.transport.request(method, { tabId: this.tabId, ...params });
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.onDetach();
  }
}

export class FrameLocator {
  constructor(
    private readonly page: Page,
    private readonly frames: LocatorContract[],
  ) {}
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.page, [
      ...this.frames,
      { type: "css", value: selector },
    ]);
  }
  async content(): Promise<string> {
    return parseContent(
      await this.page.command("page.content", {
        frameSelectors: this.frames,
      }),
    );
  }
  locator(selector: string): Locator {
    return new Locator(
      this.page,
      { type: "css", value: selector },
      this.frames,
    );
  }
  getByText(value: string, options: { exact?: boolean } = {}): Locator {
    return new Locator(
      this.page,
      { type: "text", value, ...options },
      this.frames,
    );
  }
  getByRole(
    roleName: string,
    options: { name?: string; exact?: boolean } = {},
  ): Locator {
    return new Locator(this.page, role(roleName, options), this.frames);
  }
}

export class Locator {
  constructor(
    private readonly page: Page,
    private readonly target: LocatorContract,
    private readonly frames: LocatorContract[],
  ) {}
  waitFor(options: WaitForOptions = {}): Promise<unknown> {
    return this.invoke("locator.waitFor", { ...options });
  }
  click(options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.invoke("locator.click", options);
  }
  activate(options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.invoke("locator.activate", options);
  }
  fill(value: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.invoke("locator.fill", { value, ...options });
  }
  textContent(options: { timeoutMs?: number } = {}): Promise<string | null> {
    return this.invoke("locator.textContent", options) as Promise<
      string | null
    >;
  }
  private invoke(
    method: BridgeMethod,
    options: Record<string, unknown>,
  ): Promise<unknown> {
    return this.page.command(method, {
      locator: this.target,
      ...(this.frames.length ? { frameSelectors: this.frames } : {}),
      ...options,
    });
  }
}
