# Security

Couch Potato can read and change pages in the Chrome profile where its unpacked
extension is installed. Treat it like a local automation tool with the same access
you have while browsing.

## Trust boundary

- The extension only accepts commands from `com.couch_potato.browser_bridge` through
  Chrome Native Messaging.
- The native host exposes a Unix socket owned by the current macOS user. The socket
  directory is mode `0700` and the socket is mode `0600`.
- There is no remote server, analytics, telemetry, update channel, or marketplace
  package.
- Native Messaging `stdout` is reserved for the framed protocol. Couch Potato does
  not log command parameters, page data, evaluated values, screenshots, cookies,
  headers, tokens, or text entered into fields.
- Chrome internal pages, extension pages, `file:` URLs, and Chrome Web Store pages
  are not valid automation targets.

## Important limitations

The `debugger` extension permission is intentionally powerful. Chrome will warn that
the extension can read and change data on websites, and Chrome displays a debugging
banner while a tab is attached. Dismissing that banner detaches the controller.

Automation can still trigger a website's rate limits, fraud controls, account locks,
or terms-of-service enforcement. Scripts should use bounded waits, avoid retry storms,
stop on challenges or authorization failures, and operate only on sites and accounts
the user is authorized to control.

## Reporting

Do not include credentials, cookies, tokens, page HTML, screenshots, or private page
content in a report. Describe the fixed error code and the smallest reproducible
sequence instead.
