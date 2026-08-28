import {
  BRIDGE_ERROR_CODES,
  BRIDGE_METHODS,
  PROTOCOL_VERSION,
  type BridgeErrorCode,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type JsonValue,
  type Locator,
} from "./protocol.js";

const REQUEST_ID_MAX_LENGTH = 128;
const WAIT_UNTIL = new Set(["none", "domcontentloaded", "load"]);
const LOCATOR_STATES = new Set(["attached", "visible", "hidden", "detached"]);

export class ProtocolValidationError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode) {
    super("Bridge protocol validation failed");
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}

function fail(code: BridgeErrorCode): never {
  throw new ProtocolValidationError(code);
}

const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
};

const isRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= REQUEST_ID_MAX_LENGTH;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
};

const isJsonValue = (
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : isObject(value) &&
      Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
};

const isLocator = (value: unknown): value is Locator => {
  if (!isObject(value) || typeof value.type !== "string") return false;
  if (value.type === "css") {
    return (
      hasExactKeys(value, ["type", "value"]) && isNonEmptyString(value.value)
    );
  }
  if (value.type === "text") {
    return (
      hasExactKeys(value, ["type", "value"], ["exact"]) &&
      isNonEmptyString(value.value) &&
      (!hasOwn(value, "exact") || typeof value.exact === "boolean")
    );
  }
  if (value.type === "role") {
    return (
      hasExactKeys(value, ["type", "role"], ["name", "exact"]) &&
      isNonEmptyString(value.role) &&
      (!hasOwn(value, "name") || typeof value.name === "string") &&
      (!hasOwn(value, "exact") ||
        (typeof value.exact === "boolean" && hasOwn(value, "name")))
    );
  }
  return false;
};

const hasFrameSelectors = (params: Record<string, unknown>): boolean =>
  !hasOwn(params, "frameSelectors") ||
  (Array.isArray(params.frameSelectors) &&
    params.frameSelectors.every(isLocator));

const hasTabId = (params: Record<string, unknown>): boolean =>
  isPositiveInteger(params.tabId);

const hasTimeout = (params: Record<string, unknown>): boolean =>
  !hasOwn(params, "timeoutMs") || isNonNegativeNumber(params.timeoutMs);

const validateEmpty = (params: Record<string, unknown>): boolean =>
  hasExactKeys(params, []);

const validateTab = (params: Record<string, unknown>): boolean =>
  hasExactKeys(params, ["tabId"]) && hasTabId(params);

const validateFrame = (params: Record<string, unknown>): boolean =>
  hasExactKeys(params, ["tabId"], ["frameSelectors"]) &&
  hasTabId(params) &&
  hasFrameSelectors(params);

const validateLocator = (
  params: Record<string, unknown>,
  extraRequired: readonly string[] = [],
  extraOptional: readonly string[] = [],
): boolean =>
  hasExactKeys(
    params,
    ["tabId", "locator", ...extraRequired],
    ["frameSelectors", "timeoutMs", ...extraOptional],
  ) &&
  hasTabId(params) &&
  isLocator(params.locator) &&
  hasFrameSelectors(params) &&
  hasTimeout(params);

const validateParams = (
  method: BridgeMethod,
  params: Record<string, unknown>,
): boolean => {
  switch (method) {
    case "bridge.status":
    case "browser.listTabs":
    case "browser.activeTab":
      return validateEmpty(params);
    case "browser.openTab":
      return (
        hasExactKeys(params, [], ["url", "active"]) &&
        (!hasOwn(params, "url") || isHttpUrl(params.url)) &&
        (!hasOwn(params, "active") || typeof params.active === "boolean")
      );
    case "page.attach":
    case "page.detach":
      return validateTab(params);
    case "page.goto":
      return (
        hasExactKeys(params, ["tabId", "url"], ["waitUntil", "timeoutMs"]) &&
        hasTabId(params) &&
        isHttpUrl(params.url) &&
        (!hasOwn(params, "waitUntil") ||
          (typeof params.waitUntil === "string" &&
            WAIT_UNTIL.has(params.waitUntil))) &&
        hasTimeout(params)
      );
    case "page.evaluate":
      return (
        hasExactKeys(params, ["tabId", "expression"], ["arg"]) &&
        hasTabId(params) &&
        isNonEmptyString(params.expression) &&
        (!hasOwn(params, "arg") || isJsonValue(params.arg))
      );
    case "page.content":
      return validateFrame(params);
    case "page.screenshot": {
      const format = hasOwn(params, "format") ? params.format : "png";
      return (
        hasExactKeys(
          params,
          ["tabId"],
          ["frameSelectors", "format", "quality", "fullPage"],
        ) &&
        hasTabId(params) &&
        hasFrameSelectors(params) &&
        (format === "png" || format === "jpeg") &&
        (!hasOwn(params, "quality") ||
          (format === "jpeg" &&
            typeof params.quality === "number" &&
            Number.isInteger(params.quality) &&
            params.quality >= 0 &&
            params.quality <= 100)) &&
        (!hasOwn(params, "fullPage") || typeof params.fullPage === "boolean")
      );
    }
    case "locator.waitFor":
      return (
        validateLocator(params, [], ["state"]) &&
        (!hasOwn(params, "state") ||
          (typeof params.state === "string" &&
            LOCATOR_STATES.has(params.state)))
      );
    case "locator.click":
    case "locator.textContent":
      return validateLocator(params);
    case "locator.fill":
      return (
        validateLocator(params, ["value"]) && typeof params.value === "string"
      );
  }
};

export const parseBridgeRequest = (value: unknown): BridgeRequest => {
  if (!isObject(value)) fail("INVALID_REQUEST");
  if (!hasExactKeys(value, ["protocol", "id", "method", "params"]))
    fail("INVALID_REQUEST");
  if (value.protocol !== PROTOCOL_VERSION) fail("UNSUPPORTED_PROTOCOL");
  if (!isRequestId(value.id)) fail("INVALID_REQUEST");
  if (
    typeof value.method !== "string" ||
    !BRIDGE_METHODS.includes(value.method as BridgeMethod)
  ) {
    fail("METHOD_NOT_FOUND");
  }
  if (!isObject(value.params)) fail("INVALID_PARAMS");
  if (!validateParams(value.method as BridgeMethod, value.params))
    fail("INVALID_PARAMS");
  return value as BridgeRequest;
};

export const parseBridgeResponse = (value: unknown): BridgeResponse => {
  if (!isObject(value)) fail("INVALID_REQUEST");
  if (value.protocol !== PROTOCOL_VERSION) fail("UNSUPPORTED_PROTOCOL");
  if (!isRequestId(value.id) || typeof value.ok !== "boolean")
    fail("INVALID_REQUEST");
  if (value.ok) {
    if (
      !hasExactKeys(value, ["protocol", "id", "ok", "result"]) ||
      !isJsonValue(value.result)
    ) {
      fail("INVALID_REQUEST");
    }
    return value as BridgeResponse;
  }
  if (
    !hasExactKeys(value, ["protocol", "id", "ok", "error"]) ||
    !isObject(value.error) ||
    !hasExactKeys(value.error, ["code"]) ||
    typeof value.error.code !== "string" ||
    !BRIDGE_ERROR_CODES.includes(value.error.code as BridgeErrorCode)
  ) {
    fail("INVALID_REQUEST");
  }
  return value as BridgeResponse;
};
