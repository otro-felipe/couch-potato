# Couch Potato engineering contract

- Build a generic, local-only Chrome automation bridge. Do not add site-specific selectors, credentials, banking references, telemetry, or remote control services.
- Use BDD and integration-first tests. Keep the enforced coverage threshold at 100% for statements, branches, functions, and lines.
- The Chrome extension, native host, and client must communicate through explicit versioned JSON contracts.
- Never log page content, typed values, cookies, headers, tokens, screenshots, evaluated results, or native-message payloads. Status logs must use fixed allowlisted codes only.
- Native Messaging stdout is protocol-only. Diagnostics go to stderr and must remain secret-safe.
- Restrict the local IPC endpoint to the current macOS user and clean stale sockets safely.
- Keep controllers thin. CDP transport, locator resolution, native framing, IPC routing, client API, installation, and UI belong in separate modules.
- Do not copy Forger source code or depend on Forger at runtime. Couch Potato is an independent implementation.
- The unpacked extension is the supported distribution model. Do not add Chrome Web Store publication workflows.
- Node runs natively on macOS for production. Docker may be used only for portable tests and build checks.

