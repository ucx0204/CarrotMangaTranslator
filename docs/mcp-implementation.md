# Carrot MCP implementation handoff

**Only development branch: `feat/mcp-app-bridge`, draft PR #96.** Do not create additional MCP/recovery branches, force-push, merge to master or release automatically. The recovered source and both histories were consolidated in `53de254a9c456b316a63409e649418b1505596a5`.

[Connection guide](mcp-tailscale-testing.md) · [First-page tools and tests](mcp-page-testing.md) · [Exact verification and integration record](mcp-integration-status.md).

## Product contract

Tailscale Funnel only. Persistent authentication is required. Cloudflare is neither a prerequisite nor a fallback. Start the normal desktop app (`npm run dev` for source builds), then use Settings > AI 연결 / MCP. Connection diagnostics do not use Codex allocation or any model API.

Expose the existing app, not a second translator. Desktop UI and MCP share the library facade, transaction/revision checks, image-redaction rules and editor refresh behavior. Remote tools do not expose shell, arbitrary paths, credentials, local permission changes or self-approval.

## Implemented source

- Authenticated library/capability/chapter reads and optional bounded source PNGs through the existing image-redaction guard.
- One owned foreground Tailscale process and loopback listener. Running node DNS status owns the HTTPS identity. Existing Serve/Funnel routes are not reset or made public by accident. Tailscale installation/login and account-level HTTPS/Funnel approval remain user setup.
- Durable OS-encrypted `mcp-private/authorization.enc` with strict snapshot validation and the existing atomic/fsync adapter. No plaintext fallback, including Linux `basic_text`. Approved clients persist across restart; pending registrations expire after seven days. Access lasts at most one hour; rotating refresh tokens expire after 90 days without renewal. Revocation and replay protection persist.
- Authorization mutations commit before returning OAuth registration/token/revocation success. Stopping rejects new requests and queued unauthorized edits, drains owned work, and preserves stored approvals. Corrupt or unavailable storage fails closed.
- App-side pairing window, browser-cookie and S256 PKCE binding, comparison code, local approve/deny and same-origin completion. The display code alone is not a credential. No pairing password file is needed in the normal user flow.
- App settings controls for on/off, image/edit/processing/auto-start opt-ins, stable URL copy, diagnostics, pending approvals and connection revocation. Preferences never silently expand an old grant.
- `carrot_get_page_blocks`: safe paginated existing blocks and current revision.
- `carrot_update_translations`: existing `translatedText` fields only, preserving geometry, masks, fonts and unrelated data. Requires edit scope, matching revision and writable editor. Returns previous texts for conditional restoration; exact retries are idempotent.
- Existing library transaction validates full revision, block fingerprint and reading order. Nonce-bound renderer probes reject dirty or unresponsive editors and busy jobs. Existing dirty-page-preserving refresh consumes successful edit notifications. Permission is checked again at commit time.
- A failed Funnel shutdown keeps the blocked listener bound, preventing another local service inheriting an exposed port. A user may retry stop; the app never kills the system Tailscale daemon or clears unrelated routes.

## First-page processing tools

The first-page implementation now adds saved-page rendering, pixel-coordinate crops, paginated saved work context, external-agent block creation, optional OCR-only execution, standalone local erasure and original-resolution PNG. See [page goal](mcp-page-goal.md) for exact verification and [Korean page testing](mcp-page-testing.md) for user instructions.

- `carrot_get_work_context` returns saved overview/glossary/characters/memory; it does not research or rewrite memory.
- `carrot_get_page_crop` returns an approved source crop and original-pixel mapping; `carrot_render_page_preview` uses the actual app renderer, not a second typesetter.
- `carrot_create_page_blocks` appends editable readings/translation through the existing transaction and default-format contract. Original/render rectangles are integer original-image pixels. Existing blocks are never replaced. Exact retries preserve IDs; modified text, geometry or direction conflicts.
- `carrot_run_page_ocr` uses the configured local OCR preparation without a translation endpoint. Currently it requires a block-free page and saves untranslated readings; effect-review candidates are reported separately.
- `carrot_run_page_erasure` uses the existing page-pattern inpainting job, masks, image history and commit guard. It does not invoke OCR, translate, use Codex or recalculate bubble layout.
- `carrot_export_page_png` uses original-resolution app rendering and returns a job receipt. `carrot_get_job` / `carrot_cancel_job` operate only on the owning OAuth grant; token refresh retains that owner.
- Heavy operations acquire the application's existing exclusive activity/job lease. MCP owns only bounded session receipts and temporary output files. Receipts are not a durable batch queue: stop cancels work and restart requires rereading stored page state.
- PNG access is an unguessable ten-minute single-file capability link, limited to 64 MiB/file and 256 MiB/session. Download rechecks current grant, revision and redaction; stop revokes links. It never reveals a local path or OAuth secret. Holders can fetch that one file while authorized, so links should not be made public.
- Images, existing translation edits, and new blocks/local processing have separate scopes. Old grants never gain `carrot.process` automatically. Derived output is blocked while redaction is enabled; source/crop disclosure rechecks the existing review guard after image work.

## Composition and protected boundaries

`mcpDesktopRuntime` composes the Tailscale, authorization and library adapters. `application/mcpDesktopService` owns lifecycle behind ports. The trusted local IPC and existing settings primitives expose controls; no raw remote IPC is registered.

The session root consumes `useMcpEditorSync` and its existing refresh coordinator. Its import budget is 18. `pageRevision.ts` is shared by editing, image rendering, external readings, OCR, erasure and export (fan-in 33). The trusted IPC consumer ceiling is 26. Budgets reflect actual composition consumers, not alias wrappers or disabled rules. Reading-order changes are fingerprinted even when timestamps match.

No protected OCR, font-matching, artwork-rendering or mask algorithm is moved or changed. Permissions currently cover the running library rather than individual works. Reads, image transfer, existing translation edits and local processing have separate scopes. Direct composition budgets are recorded with reasons in `scripts/architecture-budget-baseline.json`; generic complexity/dependency limits are unchanged.

## Verification and continuation

Use the exact commit/run recorded in [integration status](mcp-integration-status.md); do not infer current success from older runs. The focused suite includes MCP HTTP, durable authorization, permissions, lifecycle/pairing, existing library save/revision/refresh tests and production React interactions. Native Windows smoke checks OS encryption/restore/refresh/offline revocation with a new fixture directory and requires explicit completion markers.

`scripts/mcp-ui-qa.cjs` reuses the repository UI QA runner with production components/styles and synthetic state for wide/narrow, approval and error captures. Temporary entries are removed; artifacts contain screenshots, never user libraries or secrets. Visually inspect captures before claiming layout acceptance. Account-level Funnel and logged-in ChatGPT tests are separate from synthetic probes.

## Remaining product work

The user confirmed the Tailscale/ChatGPT connection and existing editor worked before this milestone. Acceptance of the new page tools in the user's logged-in session and actual model-quality checks remains separate from automated tests. App text-model translation, AI font matching, editable masks/geometry, SFX image generation, derived-layer redaction approval, durable multi-page jobs/ZIP, web chapter import, research/context replacement and optional MCP Apps UI remain future work. Continue independently callable tools on this same branch, preserving app authorities and committing frequently.
