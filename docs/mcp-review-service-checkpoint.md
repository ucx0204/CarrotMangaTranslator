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
