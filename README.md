# Couch Potato

Couch Potato gives local Node.js scripts a small Playwright-like API for tabs in
your existing Google Chrome profile. It does not launch a separate browser and it
does not require MCP.

It is intentionally a developer tool distributed as an unpacked Manifest V3
extension. There is no Chrome Web Store package, remote control server, telemetry,
or cloud account.

> **Powerful by design:** Couch Potato uses Chrome's `debugger` permission. An
> attached script can read and change the current page with your browser session.
> Install code you trust, keep the local bridge private, and automate only sites and
> accounts you are authorized to control.

## Requirements

- macOS
- Google Chrome
- Node.js 22 or newer
- npm 10 or newer

Node runs directly on macOS because Chrome Native Messaging requires an executable
registered with an absolute host path. Docker can run tests, but it is not a sensible
runtime for controlling a normal macOS Chrome profile.

## Download and build

```bash
git clone https://github.com/otro-felipe/couch-potato.git
cd couch-potato
npm ci
npm run check
```

`npm run check` runs TypeScript, the complete test suite with 100% coverage, and the
production build. The unpacked extension is generated at `dist/extension`.

## Register the local host

```bash
npm run install:host
```

This installs two private files for the current macOS user:

- the native host wrapper under `~/Library/Application Support/Couch Potato/`;
- Chrome's host manifest under
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.

The installer derives the stable extension ID from the public key bundled in the
extension manifest. It does not need administrator privileges.

## Load the extension in development mode

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the absolute `couch-potato/dist/extension` directory.
5. If Chrome was already open while the native host was installed, press **Reload**
   on the Couch Potato extension once.

Chrome launches the native host automatically when the extension connects. There is
no daemon command to keep running in another terminal.

Verify the connection:

```bash
npm run doctor
npm run status
```

Expected output is respectively `doctor_ok` and `bridge_connected`. These commands
print fixed status codes only.

## Write a script

Build first, then import the local client:

```js
import { connect } from "./dist/client/index.js";

const browser = await connect();

try {
  const page = await browser.openPage("https://example.com/");
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });

  const heading = page.locator("h1");
  await heading.waitFor({ state: "visible" });

  console.log(await heading.textContent());
  console.log(await page.evaluate("document.title"));

  await page.detach();
} finally {
  browser.close();
}
```

Run the included example from the repository root:

```bash
node examples/basic.mjs
```

### Existing tabs

```js
const tabs = await browser.listTabs();
const page = await browser.activePage();
```

Calling `activePage()` attaches Couch Potato to the current tab. Chrome displays its
standard debugging indicator while attached. Dismissing that indicator detaches the
controller.

### Locators and frames

```js
await page.locator("input[name=email]").fill("hello@example.com");
await page.getByText("Continue", { exact: true }).click();
await page.getByRole("button", { name: "Save" }).click();
await page.locator(".menu-action").activate();

const frame = page.frameLocator("iframe.checkout");
await frame.getByRole("button", { name: "Pay" }).click();
```

CSS, text, and role locators can be nested through multiple frame locators. `click()`
is dispatched through the Chrome DevTools Protocol Input domain. `fill()` resolves a
connected input or textarea inside its final frame, applies its native value setter,
and dispatches bubbling, composed `input` and `change` events for controlled fields.
`activate()` is the explicit semantic alternative: after resolving the locator again
inside its final frame, it accepts only a connected `HTMLElement` and invokes that
element's DOM `click()` method. It does not replace the physical-click default.

### Evaluation

```js
const result = await page.evaluate(
  "({ title: document.title, label: arg.label })",
  { label: "demo" },
);
```

`evaluate()` intentionally executes JavaScript in the attached page. Do not evaluate
untrusted input.

## CLI

```bash
npm run status
npm run doctor
node dist/client/cli.js detach-all
```

`detach-all` releases every tab currently attached by Couch Potato.

## Rebuild during development

```bash
npm run build
```

After rebuilding, open `chrome://extensions` and press **Reload** on Couch Potato.
The stable manifest key keeps the extension ID unchanged, so the Native Messaging
registration remains valid.

## Uninstall

1. Remove the unpacked extension from `chrome://extensions`.
2. Remove the exact local host files:

```bash
npm run uninstall:host
```

The uninstall command does not remove the repository, Chrome profile, browser data,
or unrelated Native Messaging hosts.

## Troubleshooting

### `bridge_unavailable`

- Confirm Chrome is running.
- Confirm the unpacked extension is enabled.
- Run `npm run build` and `npm run install:host` again after moving the repository.
- Reload the extension from `chrome://extensions`.

The native host wrapper contains absolute Node and repository paths. Re-run the host
installer whenever Node or the repository moves.

### Chrome detaches the page

Chrome ends the session when the tab closes, the extension reloads, or the debugging
indicator is dismissed. Ask the client for the active page again to create a new
attachment.

### A website rejects automation

Couch Potato operates the real browser profile, but it does not hide the debugger or
bypass challenges. Stop retries, complete any required user interaction manually,
and keep scripts slow and bounded.

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
trust model and internal protocol.
