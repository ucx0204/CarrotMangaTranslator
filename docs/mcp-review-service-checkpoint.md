# MCP saved-page review checkpoint (not yet exposed as tools)

Branch: `feat/mcp-app-bridge`. Starting commit: `2fd76d48`.
Worktree: the existing MCP Review worktree; no new branch or data-profile change.

## Implemented in this checkpoint

- `McpReviewService`: chapter-wide saved-metadata counts and filtered pagination.
- Filters: all, attention, untranslated, unreviewed, failed, no-blocks.
- Stable snapshot rejects mixing pagination results across chapter edits.
- Enabled generated lettering is checked with the existing app text/artwork contract.
- Single-page export preflight accepts the existing app's preflight through a port.
- Public projections omit source text, artwork bytes, local paths and raw errors.
- Preflight rechecks the saved page after asynchronous work and reports unchecked runtime conditions explicitly.
- Strict output schemas and eight isolated service regression tests.

## Not implemented / blocked

The attempted history-apply guard change and a later new MCP tool-registration file write were rejected by OpenAI tool safety checks. Neither rejected write was applied. No bypass, authentication change, history mutation or user-page edit was performed.

`carrot_get_chapter_review` and `carrot_preflight_page_export` are RESERVED schema names, not callable tools in this checkpoint. The app composition and `mcpOutputSchemas` registry are unchanged. The export-preflight production adapter and MCP authorization/contract tests are still required. Do not describe this service checkpoint as a live feature.

## Resume

After authorized tool writes are available, connect the service to the existing public library facade and `preflightPageImageExport`, register the two read-only tools and output schemas, then verify live metadata access. No new image/model processing is needed. Preserve the existing scope checks, data root and current tool set. History undo/redo remains a separate future increment requiring parity/commit-time authority tests.

## Verified here

- MCP suite: 309 tests in 41 files passed, including eight new review tests.
- Renderer and Electron TypeScript checks passed; focused lint and mock-boundary policy passed.
- Architecture gate identifies one additional real `pageRevision.ts` consumer (41 versus the current 40 budget). Integration must document this composition use and reconcile the specific budget; no existing authority or generic limit was changed here.
- Full check, production tool registration, native integration and live invocation of the new schema names are NOT complete. The existing running app and user data were left unchanged.

## Integration continuation (2026-09-16)

The formerly reserved names now have production registrations in `mcpReviewTools.ts`, wired by `mcpAppTools.ts` and registered in `mcpOutputSchemas`. They require only `carrot.read`; image/processing/edit permissions are not silently elevated.

The adapter calls the unchanged `preflightPageImageExport` with exactly one selected page, PNG and translated text included. It pins the originally inspected chapter, then the service rechecks current saved data. No output executor, image decoder, file destination, model or live editor reservation is invoked. Later review pages require the snapshot returned by the first page.

Contract/service/output and real HTTP tests: 41 passed in four files. These include app-rule parity, snapshot conflict, unsupported input, private-result omission, read-only grant and revocation during a pending read. Renderer/Electron typechecks and focused lint passed before adding the HTTP tests; rerun the full gates after the next native increment.

Only named composition budgets change: the existing review service is the 41st direct `pageRevision.ts` consumer (40 before), and tool composition directly imports the new tool factory (14 versus 13). No algorithms, generic limits or mock allowlists change.

Native isolated validation, coverage inventory/floors and the full repository check remain pending at this checkpoint. Direct use of the chat connector was refused with `FORBIDDEN: This conversation does not support developer MCPs`; do not describe native fixture verification as a successful live chat call. Existing user data, authorization and running app are unchanged.

## Native and coverage checkpoint

`0068bce1` is the first published production-tool integration. The same branch then adds `mcp-native-review.cjs`, invoked on the existing isolated native fixture both before block creation and after the two-block edit/erasure chain. Image, edit and processing preferences are disabled for this inspection composition. Actual library reads, tool-result validation and existing app preflight execute; no write lease or saved notification is allowed. Page data and original bytes remain identical.

Windows build and native MCP smoke passed, including both `PASS native read-only chapter review and app PNG preflight` markers, encrypted auth, existing targeted editing, original crops, rendered lettering, PNG and durable job-history regressions. Only the pre-existing heavy inference test boundary is synthetic; no live user account/content was inspected through a substituted authorization path.

All 334 MCP tests in 43 files passed. The 33 review-focused tests measure all three new production modules at 100% statements/branches/functions/lines (90/90, 50/50, 22/22, 80/80). Evidence: `.tmp/mcp-review-acceptance-20260916/coverage/coverage-summary.json`, SHA-256 `7333f23ae593e614df9bb81c82ed5ede429863911b90405ec4684a9be030ad4b`. The 750 prior existing and 740 prior added-file floors/provenance are unchanged; only the three first measured entries and exact added-source inventory (743) are appended. Full repository acceptance is the next gate.
