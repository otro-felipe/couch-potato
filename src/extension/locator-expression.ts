import type { Locator } from "../shared/protocol.js";

function serialized(locator: Locator): string {
  return JSON.stringify(locator).replaceAll("<", "\\u003c");
}

const resolverSource = String.raw`
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const implicitRole = (element) => {
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (!["hidden", "file", "image", "range", "color"].includes(type)) return "textbox";
  }
  return "";
};
const accessibleName = (element) => {
  const labelledBy = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ");
  const associatedLabels = Array.from(element.labels || [])
    .map((label) => label.textContent || "")
    .join(" ");
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "").toLowerCase();
  const inputButtonValue = tag === "input" && ["button", "submit", "reset"].includes(type) ? element.value : "";
  return normalize(
    labelledBy ||
    element.getAttribute("aria-label") ||
    associatedLabels ||
    element.getAttribute("placeholder") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    inputButtonValue ||
    element.textContent
  );
};
const matches = (actual, expected, exact) => exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
const locate = (locator) => {
  if (locator.type === "css") return document.querySelector(locator.value);
  const elements = Array.from(document.querySelectorAll("*"));
  if (locator.type === "text") {
    const matching = elements.filter((element) => matches(normalize(element.textContent), normalize(locator.value), locator.exact === true));
    return matching.find((element) => !matching.some((candidate) => candidate !== element && element.contains(candidate))) || null;
  }
  return elements.find((element) => {
    const role = element.getAttribute("role") || implicitRole(element);
    if (role !== locator.role) return false;
    return locator.name === undefined || matches(accessibleName(element), normalize(locator.name), locator.exact === true);
  }) || null;
};`;

export function locatorObjectExpression(locator: Locator): string {
  return `(() => { ${resolverSource} return locate(${serialized(locator)}); })()`;
}

export function locatorBoxExpression(locator: Locator): string {
  return `(() => { ${resolverSource} const element = locate(${serialized(locator)}); if (!element || !element.isConnected) return null; const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; })()`;
}

export function locatorProbeExpression(locator: Locator): string {
  return `(() => { ${resolverSource} const element = locate(${serialized(locator)}); if (!element || !element.isConnected) return { kind: "missing" }; const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0; return { kind: "found", visible, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: element.textContent }; })()`;
}

export function locatorActivationExpression(locator: Locator): string {
  return `(() => { ${resolverSource} const element = locate(${serialized(locator)}); if (!(element instanceof HTMLElement) || !element.isConnected) return false; element.click(); return true; })()`;
}
