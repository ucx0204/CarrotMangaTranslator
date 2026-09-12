# Carrot MCP implementation handoff

**Only development branch: `feat/mcp-app-bridge`, draft PR #96.** Do not create additional MCP/recovery branches, force-push, merge to master or release automatically. The recovered source and both histories were consolidated in `53de254a9c456b316a63409e649418b1505596a5`.

[Current user guide](mcp-tailscale-testing.md) · [Exact verification and integration record](mcp-integration-status.md).

## Product contract

Tailscale Funnel only. Persistent authentication is required. Cloudflare is neither a prerequisite nor a fallback. Start the normal desktop app (`npm run dev` for source builds), then use Settings > AI 연결 / MCP. Connection diagnostics do not use Codex allocation or any model API.

Expose the existing app, not a second translator. Desktop UI and MCP share the library facade, transaction/revision checks, image-redaction rules and editor refresh behavior. Remote tools do not expose shell, arbitrary paths, credentials, local permission changes or self-approval.

## Implemented source

- Authenticated library/capability/chapter reads and optional bounded source PNGs through the existing image-redaction guard.
- One owned foreground Tailscale process and loopback listener. Running node DNS status owns the HTTPS identity. Existing Serve/Funnel routes are not reset or made public by accident. Tailscale installation/login and account-level HTTPS/Funnel approval remain user setup.
- Durable OS-encrypted `mcp-private/authorization.enc` with strict snapshot validation and the existing atomic/fsync adapter. No plaintext fallback, including Linux `basic_text`. Approved clients persist across restart; pending registrations expire after seven days. Access lasts at most one hour; rotating refresh tokens expire after 90 days without renewal. Revocation and replay protection persist.
- Authorization mutations commit before returning OAuth registration/token/revocation success. Stopping rejects new requests and queued unauthorized edits, drains owned work, and preserves stored approvals. Corrupt or unavailable storage fails closed.
- App-side pairing window, browser-cookie and S256 PKCE binding, comparison code, local approve/deny and same-origin completion. The display code alone is not a credential. No pairing password file is needed in the normal user flow.
- App settings controls for on/off, image/edit/auto-start opt-ins, stable URL copy, diagnostics, pending approvals and connection revocation. Preferences never silently expand an old grant.
- `carrot_get_page_blocks`: safe paginated existing blocks and current revision.
- `carrot_update_translations`: existing `translatedText` fields only, preserving geometry, masks, fonts and unrelated data. Requires edit scope, matching revision and writable editor. Returns previous texts for conditional restoration; exact retries are idempotent.
- Existing library transaction validates full revision, block fingerprint and reading order. Nonce-bound renderer probes reject dirty or unresponsive editors and busy jobs. Existing dirty-page-preserving refresh consumes successful edit notifications. Permission is checked again at commit time.
- A failed Funnel shutdown keeps the blocked listener bound, preventing another local service inheriting an exposed port. A user may retry stop; the app never kills the system Tailscale daemon or clears unrelated routes.

## Composition and protected boundaries

`mcpDesktopRuntime` composes the Tailscale, authorization and library adapters. `application/mcpDesktopService` owns lifecycle behind ports. The trusted local IPC and existing settings primitives expose controls; no raw remote IPC is registered.

The session root consumes `useMcpEditorSync` and its existing refresh coordinator. Its import budget is 18. `pageRevision.ts` has two additional real consumers for edit validation and compare-and-set inside the existing transaction (fan-in 28). The trusted IPC consumer ceiling is 26. Budgets reflect actual composition consumers, not alias wrappers or disabled rules. Reading-order changes are fingerprinted even when timestamps match.

No protected OCR, font-matching, artwork-rendering or mask algorithm is moved or changed. Permissions currently cover the running library rather than individual works. Reads, image transfer and edits have separate scopes.

## Verification and continuation

Use the exact commit/run recorded in [integration status](mcp-integration-status.md); do not infer current success from older runs. The focused suite includes MCP HTTP, durable authorization, permissions, lifecycle/pairing, existing library save/revision/refresh tests and production React interactions. Native Windows smoke checks OS encryption/restore/refresh/offline revocation with a new fixture directory and requires explicit completion markers.

`scripts/mcp-ui-qa.cjs` reuses the repository UI QA runner with production components/styles and synthetic state for wide/narrow, approval and error captures. Temporary entries are removed; artifacts contain screenshots, never user libraries or secrets. Visually inspect captures before claiming layout acceptance. Account-level Funnel and logged-in ChatGPT tests are separate from synthetic probes.

## Remaining product work

Live Tailscale/ChatGPT acceptance remains to be recorded. New external-agent blocks, crop analysis, independent OCR/erasure/lettering jobs, rendered PNG/ZIP, SFX image generation, web chapter import, research/context replacement and optional MCP Apps viewer are not implemented by the existing-text edit tool. Continue these incrementally on this same branch, preserving app authorities and committing frequently.
