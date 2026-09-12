# Carrot MCP implementation handoff

Target branch: `feat/mcp-app-bridge`, draft PR #96. Never merge, release, force-push, or replace unrelated work automatically.

## Current requirement and execution path

**Tailscale Funnel only; persistent authentication is required.** Cloudflare is not a prerequisite, fallback or supported launcher. Start the normal desktop app (`npm run dev` for source builds), then use Settings > AI 연결 / MCP. The user guide is [Tailscale MCP 직접 테스트](mcp-tailscale-testing.md).

The desktop owns the loopback MCP listener and one foreground Tailscale CLI process. It refuses conflicting Serve/Funnel HTTPS routes rather than resetting the user's network configuration. The app discovers the HTTPS identity from Tailscale's running node status. It does not read identity from untrusted forwarded headers. Tailscale installation, login and HTTPS/Funnel approval are user-account setup requirements. No Codex allocation or model API is used by connection diagnostics.

## Implemented and reconciled for publication

- Authenticated library/capability/chapter reads; optional source PNG previews through the existing image-redaction guard. No private paths, shell or general-purpose filesystem tools.
- OS-encrypted `mcp-private/authorization.enc`, separate app-private preferences, durable atomic commits and strict snapshot validation. No plaintext fallback, including Linux `basic_text`. Approved OAuth client registrations survive restart; access lasts at most one hour, rotating refresh tokens expire after 90 days without renewal. New, unapproved registrations expire after seven days. Revocation and replay protection survive restart.
- Managed OAuth HTTP response commits before returning registration/token/revocation success. Stop blocks access immediately without erasing the saved authorization. Shutdown drains owned requests before closing authorization state. Corrupt or unavailable storage fails closed.
- App-side five-minute pairing window, browser-cookie and PKCE binding, comparison code, local approve/deny and same-origin completion. The display code is not a password or independent credential. Remote calls cannot approve themselves or enable permissions.
- Settings UI for on/off, image/edit/auto-start opt-ins, stable URL copy, safe diagnostic, pairing requests and saved-connection revocation. Existing UI primitives and trusted IPC are used. Turning off and restarting preserve registration and approval; explicit revocation invalidates access/refresh rights.
- `carrot_get_page_blocks`: safe, paginated existing blocks and current page revision.
- `carrot_update_translations`: strict existing-block `translatedText` changes only, preserving geometry, masks, fonts and all unrelated fields; no OCR, model invocation, erasure or export. Requires read+edit scope and the revision returned by the read tool. Returns previous texts for explicit conditional restoration.
- Edits reuse the existing library facade and transaction. Full revision, block fingerprint and reading-order checks run inside the save transaction. Main/renderer probing rejects dirty pages, active jobs and unresponsive editors. The existing dirty-page-preserving refresh coordinator consumes save notifications. Authorization is rechecked immediately before committing a queued edit.
- Shutdown retains the blocked local listener if owned Funnel termination fails; an explicit stop retry is possible. This avoids another local service inheriting a still-public port.

## Reuse boundaries

| Concern                        | Existing app authority                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Library reads and mutations    | `src/main/library.ts`, library transaction and lock implementation                         |
| Page revision and fingerprints | `shared/pageRevision.ts`, `shared/blockFingerprint.ts`                                     |
| Preview transfer               | `imageRedactionContext.ts`, existing image decoding                                        |
| Editor updates                 | trusted preload bridge, `createLiveChapterRefreshCoordinator`, dirty-page-preserving merge |
| Durable state                  | existing atomic file / fsync storage adapter, Electron `safeStorage`                       |
| Child lifetime                 | existing process-tree termination and exit-receipt helpers                                 |

No protected OCR, font-matching, artwork-rendering or mask algorithms are changed. New grants cover the running library, not per-work restrictions. Tool scopes separate reads, images and existing-translation edits. Turning off image/edit preferences does not expand old grants; enabling additional rights requires a suitably scoped new approval.

## Tests and acceptance boundary

The original local checkpoint passed 173 tests in 19 files. After reconciling the later remote changes and porting its ten additional regressions, **183 tests in 22 files passed**:

```sh
node node_modules/vitest/vitest.mjs run tests/mcp tests/libraryBatchPageSave.test.ts tests/pageRevision.test.ts tests/chapterSync.test.ts tests/liveChapterRefreshCoordinator.test.ts
```

These include actual HTTP, durable-session serialization, injected encryption-port disk I/O, restart/revocation/scope rejection, same-request retries, existing-library transaction conflicts, editor probes and production React component interactions in jsdom. They are not live Tailscale or logged-in ChatGPT tests.

The integrated source passed renderer, Electron and JavaScript typechecks, dependency directions/budgets, error policy, script inventory, mock boundaries, maintainability and duplicate checks. Full lint initially identified three non-null assertions in the ported tests; those were removed and focused lint then passed. The original checkpoint also passed full lint/format and compiled main, preload, page-export and renderer before the repository's unsupported Linux native ONNX packaging guard. No guard was relaxed.

`scripts/mcp-native-authorization.cjs` is wired into the Windows checkpoint. It uses a new fixture directory, fresh service/store instances and real OS encryption to test restore, refresh and offline revocation. CI requires its completion marker, not just exit zero. Native Windows and actual Tailscale/ChatGPT account acceptance must be recorded from the resulting run, not inferred from local port-based tests. UI component interaction tests are not screenshot QA. Knip encountered a WASM parser allocation failure in the editing environment; full `npm run check` is not claimed from that attempt.

## Publication and concurrency record

The six original local checkpoints descend from `0ef7c4edd3767748579db23f25c0476a7a7d227c`. The remote branch had independently advanced to `6c1f563497b742d58a9584dd5eda25431bb4392e`. That exact state was preserved as `backup/mcp-before-publication-20260912` before publication.

The remote source and Git object inventory were retrieved through a read-only, source-only Actions snapshot at `6c04bc099db44db5c8f572a6430b3e547a7e70ed`. Twelve overlapping files were reconciled; duplicate partial services and unapplied checkpoint patches were replaced by the integrated implementation. Ten remote lifecycle/pairing/HTTP tests were retained and ported, not discarded.

Publication uses the connected GitHub Git Data write actions (`create_tree`, `create_commit`, `update_ref`) on `integration/mcp-tailscale-publication-20260912`, with each source tree checked against the local Git tree. These remote writes work. CLI DNS failure must not be described as a lack of GitHub write permission. The final source is to fast-forward the existing feature branch without force, master merge or release. The draft PR records the final publication SHA and exact CI outcome.

## Composition notes

`mcpDesktopRuntime` owns the Tailscale process, durable authorization and library adapters. `application/mcpDesktopService` owns lifecycle behind ports. The existing settings dialog, trusted IPC, chapter session and library facade gain only their actual new consumers; the explicit composition budgets document those dependencies. The shared page revision algorithm is unchanged, and reading-order fingerprint checks run in the existing transaction. Remote tools never expose local consent, permission changes, arbitrary paths or shell execution.

## Remaining product work

Record the Windows/native checkpoint result and perform live Tailscale/ChatGPT acceptance next. Full external-agent block creation, crop analysis, independent OCR/erasure/lettering jobs, rendered output/PNG/ZIP, SFX image generation, web chapter import, context research/replacement and optional MCP Apps viewer remain beyond this checkpoint. Do not advertise these as implemented by the translation-text patch tool.
