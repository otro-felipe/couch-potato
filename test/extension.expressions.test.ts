import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";

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

  type AccessibleNameFixture = {
    labels?: Array<{ textContent: string }>;
    placeholder?: string;
    labelledBy?: string;
    labelledText?: string;
  };

  it.each<readonly [AccessibleNameFixture, string]>([
    [{ labels: [{ textContent: "Account identifier" }] }, "Account identifier"],
    [{ placeholder: "Account identifier" }, "Account identifier"],
    [
      { labelledBy: "account-label", labelledText: "Account identifier" },
      "Account identifier",
    ],
  ])(
    "resolves a textbox name from generic HTML accessible-name sources %#",
    (fixture, expectedName) => {
      const attributes = new Map<string, string>([["type", "text"]]);
      if (fixture.placeholder !== undefined)
        attributes.set("placeholder", fixture.placeholder);
      if (fixture.labelledBy !== undefined)
        attributes.set("aria-labelledby", fixture.labelledBy);
      const element = {
        tagName: "INPUT",
        isConnected: true,
        labels: fixture.labels ?? [],
        textContent: "",
        value: "",
        getAttribute: (name: string) => attributes.get(name) ?? null,
        hasAttribute: (name: string) => attributes.has(name),
        getBoundingClientRect: () => ({
          width: 200,
          height: 44,
          left: 10,
          top: 20,
        }),
      };
      const result = runInNewContext(
        locatorProbeExpression({
          type: "role",
          role: "textbox",
          name: expectedName,
          exact: true,
        }),
        {
          document: {
            getElementById: (id: string) =>
              id === fixture.labelledBy
                ? { textContent: fixture.labelledText }
                : null,
            querySelectorAll: () => [element],
          },
          getComputedStyle: () => ({
            visibility: "visible",
            display: "block",
            opacity: "1",
          }),
        },
      );
      expect(result).toMatchObject({ kind: "found", visible: true });
    },
  );
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
