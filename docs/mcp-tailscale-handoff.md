# MCP Tailscale implementation checkpoint

Branch: `feat/mcp-app-bridge`, draft PR #96. Do not merge, release, or force-push.

## Confirmed user requirements

The user explicitly rejected **Cloudflare**, not persistent authentication. The chosen external connection is **Tailscale Funnel**. Persistent authentication **is required**. Do not reintroduce Workers, Cloudflare Tunnel or another provider as the default, prerequisite, or automatic fallback.

The goal is one-time ChatGPT registration, OS-encrypted persistent client/grant records, app-owned MCP on/off, app-side explicit pairing approval without terminal passwords, connection/restart/revocation diagnostics, and the first useful translation-block read/edit/save tools through existing app services. Keep image redaction protection and library conflict checks. A stable URL does not make access tokens immortal: rotate short-lived tokens while retaining the user's approval until explicitly revoked.

## Ordered recovery checklist

- [ ] Remove Cloudflare execution from the MCP CI and supported user entrypoints.
- [ ] Tailscale Funnel adapter: inspect installation/login/hostname, retain one stable HTTPS origin, refuse occupied routes, own foreground tunnel process only, never reset Tailscale or stop another application's route.
- [ ] Durable OAuth: OS-encrypted atomic storage, persistent client identity and approval, refresh rotation/replay and revocation across restart, fail closed on corruption or unavailable encryption.
- [ ] App control: trusted IPC and settings UI for server on/off, images/edit permissions, diagnostics, stable address, pairing window and connected clients.
- [ ] App pairing: cookie-bound browser transaction, visible matching code, local approve/deny, short-lived callback completion, no terminal-password workflow.
- [ ] First edits: existing page blocks with revision, translation-text-only patches, field preservation, conflict detection, no silent OCR/model invocation.
- [ ] Automated tests: repeated/idle requests, stop/start, persistent grants and revocation, browser approval, protected images, existing UI save notifications, supported-platform build/static checks.
- [ ] Update Korean test guide with exact verified entrypoints and remaining live-account acceptance boundaries.

## Evidence boundary

The existing local and web read/preview baseline was confirmed by the user. Do not claim that a live Tailscale tailnet, the user's ChatGPT account, or the new desktop UI has been tested until the corresponding checks actually run. CI fixtures must never use existing user libraries or account credentials. Save each coherent implementation checkpoint to this branch; record exact failures rather than silently skipping gates.
