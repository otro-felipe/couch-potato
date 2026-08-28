# Architecture

Couch Potato is a local bridge from deterministic Node scripts to tabs in the
user's existing Google Chrome profile.

```text
Node script / CLI
       │ newline-delimited JSON over a Unix socket
       ▼
Native Messaging host
       │ Chrome's length-prefixed JSON protocol over stdio
       ▼
Manifest V3 service worker
       │ chrome.tabs + chrome.debugger / Chrome DevTools Protocol
       ▼
Existing Chrome tabs and frames
```

## Why Node runs on macOS

Chrome launches a Native Messaging host by an absolute path registered in the
current user's Chrome profile. A Docker container is useful for portable tests, but
it cannot be the production host for a normal macOS Chrome profile without adding a
larger host integration layer. Couch Potato therefore pins Node 22 or newer and runs
the bridge locally.

## Protocol boundaries

All layers use protocol version `1`, correlated request IDs, an allowlist of methods,
strict parameter validation, and fixed error codes. Invalid input is rejected without
reflecting any part of the original message.

The Native Messaging transport uses a four-byte little-endian payload length followed
by UTF-8 JSON. Messages emitted toward Chrome are capped at one MiB. The decoder is
incremental so headers and payloads may arrive in arbitrary chunks.

The Unix socket is a local transport convenience for scripts. It does not expose a
TCP port. Its parent directory is accessible only to the current user, and a stale
socket is removed only after it has been identified as a socket owned by that user.

## Page control

The extension uses `chrome.debugger` as a transport for the Chrome DevTools Protocol.
That provides navigation, execution contexts, DOM resolution, screenshots, and Input
events in the real browser profile. It is intentionally closer to Playwright than
calling DOM `click()` from a content script. Physical CDP input remains the default;
the separate `locator.activate()` operation deliberately provides DOM activation for
components that require it.

Locators are serializable values:

- `{ type: "css", value: "main button" }`
- `{ type: "text", value: "Continue", exact: true }`
- `{ type: "role", role: "button", name: "Continue", exact: true }`

Frame locators are represented as an ordered list of those locator values. The
extension resolves each iframe before resolving the final locator.
`activate()` repeats that resolution in the final top-level or isolated frame context,
requires a connected `HTMLElement`, and returns only an allowlisted boolean result.
`fill()` uses the same fresh frame resolution, accepts only connected HTML inputs and
textareas, applies the appropriate native value setter, and emits framework-compatible
`input` and `change` events without returning field content.

## Deliberate limits

- No cookies API.
- No credential store.
- No proxy or request modification.
- No remote listener or cloud relay.
- No background website polling.
- No automation of Chrome internal pages, local files, extension pages, or the Chrome
  Web Store.
- No attempt to hide Chrome's debugger indicator or bypass a website challenge.

Scripts may evaluate JavaScript because the project is a general browser controller.
That capability is available only through the local bridge and inherits the same
trust boundary as running the script directly on the user's Mac.
