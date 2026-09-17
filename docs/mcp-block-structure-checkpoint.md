# MCP block structure checkpoint

Scope: one-page ordinary-block split 1-to-2, adjacent merge 2-to-1, delete one,
and session-local preview/apply/undo/redo. AI interprets vague feedback using
source/rendered pages and block metadata; the user is not asked to supply pixels.
See `mcp-agent-editing-contract.md` for the intent-driven workflow.

Implementation checkpoint: `743df38c` on `feat/mcp-app-bridge`.
Five tools are registered through the existing page editing composition:
`carrot_preview_block_structure_edit`, `carrot_get_block_structure_edit`,
`carrot_apply_block_structure_edit`, `carrot_undo_block_structure_edit`,
`carrot_redo_block_structure_edit`.

Preview/get expose only public text/geometry/style/order and ID mapping. They
never attach images/files. Apply/undo/redo use the existing page handoff, current
revision, authorization guard and atomic library transaction. The original and
inpainted raster/mask paths are never changed. Explicit image tools verify output.
No OCR, translation, inpainting inference, research or paid fallback is invoked.

Precise arguments are AI-authored. Wording is preserved unless an intentional
replacement is explicitly requested. Generated lettering, geometry-dependent
automatic typography and blocks referenced by SFX review are conservatively
refused instead of discarding assets or disabling user settings.

History: session only, 30 minutes since preview/latest successful action;
64 entries, 32 MiB and 32 actions per entry. Undo restores blocks/order/rendering,
but the app may retain a pending workflow completion status. No stale completed
model receipt is manufactured. Subsequent page or SFX ledger edits conflict.
Old identical action retries are historical receipts with zero new page changes.

## Verification in progress

Initial policy, lifecycle and output checks: 44 passed. New real HTTP storage
and permission tests plus cross-plan request-ID race tests: 35 passed. The race
was first reproduced (1 failed / 3 passed), then fixed by reserving in-flight
request IDs before waiting for page ownership. Renderer notification failure
cannot lose an already committed receipt or cause the edit to be replayed.

Four new coverage records were measured on Windows and registered without
changing any older floor or provenance. Full coverage/build/native/live checks
are still pending at this checkpoint; focused-run global coverage is not a full
suite result. Native tests exercise production storage and actual pixel output.

Architecture checks currently report direct-consumer ceilings at pageRevision,
ipcSchemaPrimitives, geometry and mcpEditPolicy. The attempted ceiling update
was blocked before execution; the budget file remains unchanged. Do not claim
that the aggregate check has passed or hide this by aliases/copied algorithms.

Temporary logs: `.tmp/mcp-structure-20260917/` in the existing review worktree.
Normal user library, authentication and model settings have not been modified.
