import { describe, expect, it } from "vitest";

import { BridgeFault, asBridgeFault } from "../src/extension/errors.js";
import {
  locatorObjectExpression,
  locatorProbeExpression,
} from "../src/extension/locator-expression.js";

describe("locator expressions", () => {
  it("builds CSS, text, and role resolvers without embedding raw tag delimiters", () => {
    const css = locatorObjectExpression({ type: "css", value: "main<script>" });
    const text = locatorProbeExpression({
      type: "text",
      value: "Continue",
      exact: true,
    });
    const role = locatorProbeExpression({
      type: "role",
      role: "button",
      name: "Continue",
      exact: false,
    });
    expect(css).toContain("document.querySelector");
    expect(css).toContain("main\\u003cscript>");
    expect(css).not.toContain("main<script>");
    expect(text).toContain('"type":"text"');
    expect(text).toContain("element.contains(candidate)");
    expect(role).toContain("accessibleName");
  });
});

describe("safe bridge faults", () => {
  it("preserves allowlisted faults and maps unknown failures", () => {
    const timeout = new BridgeFault("TIMEOUT");
    expect(asBridgeFault(timeout)).toBe(timeout);
    expect(asBridgeFault(new Error("private"))).toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(timeout.message).toBe("Couch Potato bridge operation failed");
  });
});
