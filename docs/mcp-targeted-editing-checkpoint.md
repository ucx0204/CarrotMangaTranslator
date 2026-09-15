# MCP targeted editing checkpoint

Use only `feat/mcp-app-bridge` in the existing review worktree. Starting source: `4cb5c352`.

Already present: structured outputs, 2026 stateless discovery, server/profile identity and durable owned job history/retry. Do not reimplement these.

Current connection probe: the chat connector returned OAuth token-request 503 and no app listener or review-worktree Electron process was running. Do not erase authentication or pretend this is a successful live-app test.

## This increment

1. Optional selected-block erasure using the existing local page-pattern job, preserving selection across journal persistence/retry and refusing target broadening.
2. Revision-checked existing-block text/style/render-position edits through the existing app editing/geometry contracts and block transaction.
3. Explicit complete reading-order changes, independent of image/model operations.

Validate contracts, unauthorized requests, conflict/no-op paths, native adapters and stored receipts. Leave original user pages unchanged during deterministic tests. Record every source checkpoint and exact checks below. No UI redesign, extra branch or release.

## Status

- `cbb3e5ee`: selected-block erasure is passed to the existing native page-pattern job and preserved in durable receipts/retries. Missing/excluded IDs fail rather than becoming full-page operations. 24 focused tests passed.
- `dd681477`: added `carrot_update_page_blocks` and `carrot_set_page_reading_order`, using the existing field-edit engine and guarded block transaction. The original text-only tool is preserved. New tools require read + edit + process scopes and local edit/processing preferences. 301 MCP tests in 40 files, renderer/Electron typechecks and focused lint passed.
- Native verification uses two synthetic source regions. Updating the first block preserves its source box and the second block; reading-order edits preserve both blocks; erasure changes only the selected original pixels; actual app renderer/export then renders the stored changes. Windows build and native smoke passed. Heavy inference is a deterministic test boundary; no real account/model quality is claimed.
- Architecture reuses `geometry.ts` directly. Its actual consumer count becomes 36 (previous 35). Only that named public boundary budget changes; no aliases, moved algorithms or generic limits are introduced.
- Logs: `.tmp/mcp-targeted-editing-20260915/`. Full repository/coverage acceptance is still to be completed; these focused successes are not a full-check claim.

## Contract and remaining work

`carrot_update_page_blocks` accepts existing IDs, current revision, optional scalar `fields` and/or `renderRect` in original-image integer pixels. It retains source geometry, inpainting masks, generated images and all unselected blocks; actual constrained display bounds are returned. Generated image lettering may still be visible: inspect the rendering after editing its text/style fallback.

`carrot_set_page_reading_order` requires all current IDs exactly once and returns the prior effective order for explicit restoration with the new revision. No implicit destructive undo is exposed.

Single-block erasure is optional `blockId` on the existing `carrot_run_page_erasure`; omitting it preserves the page-wide contract. OCR/PNG reject block selectors.

Next independent capabilities still pending: source-geometry editing, splitting/merging/deletion, area OCR, app text-model execution, mask/history controls, automatic lettering/font matching, context writes/research, chapter batching/ZIP and imports. Server/profile identity, modern protocol and durable receipts/retry were already implemented and were not recreated.

## Coverage evidence

Three new production modules have first measured floors from the Windows V8 run in `.tmp/mcp-targeted-editing-20260915/new-module-coverage/coverage-summary.json`. SHA-256: `53f5448a1a76c29b8a44c5ab2ffbe402336f67cd0ca76ddce53a1af94be222bd`. The focused run passed 37 tests; combined new-module coverage was 100% lines/statements/functions and 97.56% branches. No pre-existing ratio or provenance was changed. The exact added-source inventory increases from 737 to 740. Full check is still pending at this checkpoint.
