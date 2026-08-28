export const PROTOCOL_VERSION = "1" as const;

export const BRIDGE_METHODS = [
  "bridge.status",
  "browser.listTabs",
  "browser.activeTab",
  "browser.openTab",
  "page.attach",
  "page.detach",
  "page.goto",
  "page.evaluate",
  "page.content",
  "page.screenshot",
  "locator.waitFor",
  "locator.click",
  "locator.fill",
  "locator.textContent",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export const BRIDGE_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL",
  "METHOD_NOT_FOUND",
  "INVALID_PARAMS",
  "TAB_NOT_FOUND",
  "NOT_ATTACHED",
  "FRAME_NOT_FOUND",
  "LOCATOR_NOT_FOUND",
  "TIMEOUT",
  "CDP_ERROR",
  "INTERNAL_ERROR",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type CssLocator = Readonly<{
  type: "css";
  value: string;
}>;

export type TextLocator = Readonly<{
  type: "text";
  value: string;
  exact?: boolean;
}>;

export type RoleLocator = Readonly<{
  type: "role";
  role: string;
  name?: string;
  exact?: boolean;
}>;

export type Locator = CssLocator | TextLocator | RoleLocator;

export type FrameSelectors = readonly Locator[];

type EmptyParams = Readonly<Record<string, never>>;
type TabParams = Readonly<{ tabId: number }>;
type FrameParams = Readonly<{ tabId: number; frameSelectors?: FrameSelectors }>;
type LocatorParams = FrameParams &
  Readonly<{
    locator: Locator;
    timeoutMs?: number;
  }>;

export interface BridgeParamsByMethod {
  "bridge.status": EmptyParams;
  "browser.listTabs": EmptyParams;
  "browser.activeTab": EmptyParams;
  "browser.openTab": Readonly<{ url?: string; active?: boolean }>;
  "page.attach": TabParams;
  "page.detach": TabParams;
  "page.goto": Readonly<{
    tabId: number;
    url: string;
    waitUntil?: "none" | "domcontentloaded" | "load";
    timeoutMs?: number;
  }>;
  "page.evaluate": Readonly<{
    tabId: number;
    expression: string;
    arg?: JsonValue;
  }>;
  "page.content": FrameParams;
  "page.screenshot": FrameParams &
    Readonly<{
      format?: "png" | "jpeg";
      quality?: number;
      fullPage?: boolean;
    }>;
  "locator.waitFor": LocatorParams &
    Readonly<{
      state?: "attached" | "visible" | "hidden" | "detached";
    }>;
  "locator.click": LocatorParams;
  "locator.fill": LocatorParams & Readonly<{ value: string }>;
  "locator.textContent": LocatorParams;
}

export type BridgeRequest<M extends BridgeMethod = BridgeMethod> = M extends BridgeMethod
  ? Readonly<{
      protocol: typeof PROTOCOL_VERSION;
      id: string;
      method: M;
      params: BridgeParamsByMethod[M];
    }>
  : never;

export type BridgeSuccessResponse = Readonly<{
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  result: JsonValue;
}>;

export type BridgeErrorResponse = Readonly<{
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  ok: false;
  error: Readonly<{ code: BridgeErrorCode }>;
}>;

export type BridgeResponse = BridgeSuccessResponse | BridgeErrorResponse;

export {
  ProtocolValidationError,
  parseBridgeRequest,
  parseBridgeResponse,
} from "./validation.js";
