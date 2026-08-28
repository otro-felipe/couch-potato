import { describe, expect, it } from "vitest";

import { BridgeFault } from "../src/extension/errors.js";
import { requireWebUrl } from "../src/extension/security.js";

describe("extension URL boundary", () => {
  it.each(["https://example.com/path", "http://localhost:3000/"])(
    "accepts web URL %s",
    (url) => expect(requireWebUrl(url)).toBe(url),
  );

  it.each([
    "chrome://settings",
    "chrome-extension://abc/page.html",
    "file:///tmp/private",
    "https://chromewebstore.google.com/detail/example",
    "not a URL",
  ])("rejects privileged URL %s", (url) => {
    expect(() => requireWebUrl(url)).toThrowError(
      expect.objectContaining<Partial<BridgeFault>>({ code: "INVALID_PARAMS" }),
    );
  });
});
