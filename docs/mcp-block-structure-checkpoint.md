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

## Current verification status

Implementation, full Windows check (26 gates), 7,436 passing tests and the actual
Electron structural roundtrips are complete. The review app has been normally
restarted and advertises all five new tools. Direct calls from this ChatGPT
conversation await its tool-definition refresh; they are not marked passed.
See `mcp-block-structure-closeout-20260917.md` for exact evidence, restrictions
and the verified 14-file unchanged test-work backup. Earlier dependency-ceiling
failures are resolved by the documented, measured per-file exceptions.
