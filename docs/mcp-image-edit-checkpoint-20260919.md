# Bundle 4 image editing checkpoint - 2026-09-19

Baseline: `25bbe155`. Work only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1-3 are completed with automatic
checks; all live model/user/client acceptance remains deferred.

Status: IMPLEMENTED AND REGISTERED; FOCUSED CHECKS PASSED; FINAL CHECK RUNNING.
Current code checkpoint: `32d76f3f`. Do not claim the final gate or native smoke
has passed until their completion records have been read.

## Connected scope

Eight strict-contract tools are in real app composition (output inventory 91):
`carrot_preview_image_edit`, `carrot_get_image_edit`, `carrot_apply_image_edit`,
`carrot_undo_image_edit`, `carrot_redo_image_edit`, `carrot_cancel_image_edit`,
`carrot_get_image_edit_mask`, `carrot_sample_page_color`.

One explicitly versioned page per image edit, up to 100 selected blocks and
16 million original pixels. Native glyph/region masks, freehand erasure masks,
explicit protected stroke/rectangle/ellipse geometry, model-free paint and
original-pixel restoration, mask inspection and color sampling are connected.
Block mode automatically protects unselected source boxes; freehand mode uses
only its explicit geometry/protection. Native tiny-component exclusions and mask
counts are reported rather than silently enlarged. Source and current cleaned
images remain distinct. Text, geometry, reading order and formatting are preserved.

The existing native model lease, page handoff, library transaction and image history
are reused. Erasure alone may prepare the configured local engine with explicit
asset-download consent; no OCR, translation, C23, layout or hosted image service is
implicit. Model cleanup completes before persistence. Paint is an explicit command,
not a substitute erasure engine. Preview computes masks and fingerprints only,
without model calls, page/settings writes or artifact creation.

Image output and color sampling require image permission and honor redaction.
Owned planning/apply/recovery require read/edit/process. Mask previews are at most
1,600 pixels on the long edge and 4 MiB; full dimensions/counts remain metadata.

## Conflicts, partial results and recovery

Original/cleaned/mask hashes and current page, chapter membership and work context
are checked before forward changes. No-op pixel results save nothing. Incomplete
native mask components produce a saved partial result; changed-pixel counts do not
prove successful text removal or visual quality. UI notification failure does not
lose an acknowledged save. Cancellation waits for actual cleanup and is not rollback.

Undo/redo use retained native images/masks without inference and refuse later page
edits or changed artifacts. Original optional image/mask/provenance/completion values
are recovered. Orphan mask metadata is rejected before planning rather than silently
normalized into an unrecoverable edit. Work context changes block redo, not undo.
Plans have 30-minute idle lifetime; at most 64 native image history references remain
in the owning session until close. Closing releases only this session's references.
Durable recovery remains bundle 7; multi-page orchestration is bundle 8.
External uploaded image/mask incorporation remains bundle 5.

## Confirmed tests and exact remaining validation

At `cef9bf12`, all 48 focused tests across nine files passed: 33 new image-edit
cases plus 15 existing native-mask, retouch and output-schema regressions.
The full measurement passed 7,804 tests with one expected missing-new-module
inventory failure and 11 pre-existing skips. Nine measured coverage rows were then
registered without modifying any of the 1,601 inherited rows/provenance/deletions;
the exact production coverage-floor command passed with 1,610 total rows.

The first full stage graph found only one unused exported type, removed in
`32d76f3f`. The next full stage graph has passed its static checks and is running
coverage/build. Read `.tmp/mcp-image-full-check.log`, `.tmp/check-timings.json` and
`.tmp/check-results/vitest.json` for the terminal result.

The existing isolated real-Electron smoke was extended by
`scripts/mcp-native-image-edit.cjs` and its invocation in `mcp-native-page.cjs`.
It verifies real native PNG masks, protected paint, color sample, original restore
and exact history without model calls. Run it after the build, with a separate
smoke port and CARROT_MCP_SMOKE_TAILSCALE=0; its result is not confirmed yet.

Unit/integration fixtures substitute Electron image I/O and heavy inference only.
Native masks, coordinate conversion, retouch, page/model ownership, actual isolated
library writes, image history and OAuth/HTTP are exercised. Tests include wrong
owners/permissions, bad geometry/IDs, stale sources/context, no-op/partial output,
cancellation cleanup, failed cleanup and revoked authorization before save.

No live app restart, user artwork/library/authentication changes, model asset
replacement/download, live ChatGPT/Tailscale call, master merge or release occurred.
Do not start bundle 5 until final validation and this checkpoint are complete.
Detailed boundaries: `mcp-image-edit-boundaries-20260919.md`.
Coverage provenance: `mcp-image-edit-coverage-20260919.md`.
