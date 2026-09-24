# Bundle 4 image editing checkpoint - 2026-09-19

Status: IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES PASSED; LIVE DEFERRED.
Baseline: `25bbe155`. Verified production/test code: `32d76f3f`.
Continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1-4 are implemented with automatic
checks complete. Live model/user/client acceptance stays deferred until all bundles
are implemented. This record closes the previously interrupted bundle-four work.

## Connected scope

Eight strict-contract tools are in real app composition (output inventory 91):

- `carrot_preview_image_edit`
- `carrot_get_image_edit`
- `carrot_apply_image_edit`
- `carrot_undo_image_edit`
- `carrot_redo_image_edit`
- `carrot_cancel_image_edit`
- `carrot_get_image_edit_mask`
- `carrot_sample_page_color`

One explicitly versioned page per image edit, up to 100 selected blocks and
16 million original pixels. Native glyph/region masks, freehand erasure masks,
explicit protected stroke/rectangle/ellipse geometry, model-free paint and
original-pixel restoration, mask inspection and color sampling are connected.
Block mode automatically protects unselected source boxes; freehand mode uses
only its explicit geometry/protection. Native tiny-component exclusions and mask
counts are reported rather than silently enlarged. Source and current cleaned
images remain distinct. Text, geometry, reading order and formatting are preserved.

The existing native model lease, page handoff, library transaction and image history
are reused. Erasure alone may prepare the configured supported local engine with
explicit asset-download consent; no OCR, translation, C23, layout or hosted image
service is implicit. Model cleanup completes before persistence. Paint is an explicit
command, not a substitute erasure engine. Preview computes masks and fingerprints
only, without model calls, page/settings writes or output artifact creation.

Image output and color sampling require image permission and honor redaction.
Owned planning/apply/recovery require read/edit/process. Mask previews are at most
1,600 pixels on the long edge and 4 MiB; full dimensions/counts remain metadata.
Protection is bound to the explicit edit, not a new permanent page-wide policy.

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

## Verified automatic results

Full repository check at `32d76f3f` completed successfully. All later changes in
this continuation are documentation only, not production/test code.

| Check                                                                        | Result                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------- |
| Repository stage graph                                                       | All 26 stages passed, every exitCode 0             |
| Complete Vitest/V8 suite                                                     | 7,805 passed; zero failed; 11 pre-existing skips   |
| MCP cases within the complete suite                                          | 991 passed across 139 files; zero failed           |
| Focused image and existing native/output regressions                         | 48 passed across nine files                        |
| Renderer, Electron and JavaScript types                                      | Passed                                             |
| Lint, formatting, architecture, duplication, unused exports, mock boundaries | Passed                                             |
| Exact production coverage-floor gate                                         | Passed                                             |
| Windows build                                                                | Passed                                             |
| Existing page-artwork parity, image protocol, renderer/preload bundle checks | Passed                                             |
| Extra real-Electron MCP/native image smoke                                   | Passed; explicit completion marker and exit code 0 |

Canonical full-check record: `.tmp/check-timings.json`, started at
`2026-09-18T16:45:38.351Z`, completed at `2026-09-18T16:48:41.195Z`.
Complete test results: `.tmp/check-results/vitest.json`; individual stage logs:
`.tmp/check-logs/`; wrapper log: `.tmp/mcp-image-full-check.log`.
Test digest: `e6fe38390c7ef9f4f87cc7fcdcb61a6a5904d485ace39dc57a8a42ce159624c8`.
Coverage digest: `c0d21abf1f5ef92450516e19c789c0beb25f26124ab6a453dfc005912c548025`.

The initial measurement had one new-module inventory-registration failure. Nine
actually measured rows were then added without changing any of the 1,601 inherited
rows, provenance or ten deletions; the final manifest contains 1,610 rows. The first
stage graph also found an unused exported type, removed in `32d76f3f`. Neither
failure remains in the passing final check. No coverage threshold was weakened.
Exact per-file provenance is in `mcp-image-edit-coverage-20260919.md`.

## Real Electron verification and test boundaries

The continuation ran `node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs`
with `CARROT_MCP_SMOKE_PORT=38549` and `CARROT_MCP_SMOKE_TAILSCALE=0`.
Log: `.tmp/mcp-image-native-cli-20260919.log`. Exit code was 0 and the log ended with
`PASS MCP native smoke finished`. The new check explicitly reported
`PASS native image mask -> protected RGBA paint -> color sample -> original restore -> exact undo/redo (no model)`.
The earlier direct GUI executable attempt returned an empty log and was not counted
as validation. Use the Node CLI wrapper and require the completion marker.

The extra script uses actual Electron image decoding, PNG mask pixels, native
retouch, page ownership, library persistence and native history. It checks every
outside/protected RGBA pixel, the requested sampled color, full original-pixel
restoration and exact revision recovery. It runs no models for these new checks.
Existing isolated native checks for rendering, two-page PNG/ZIP bytes, encrypted
authorization, redaction and shutdown also completed; these are not live delivery
claims for the user's ChatGPT connection.

Unit/integration fixtures substitute Electron image I/O and heavy inference only.
Native masks, coordinate conversion, retouch, page/model ownership, actual isolated
library writes, image history and OAuth/HTTP are exercised. Adversarial inference
tries to modify every pixel, and the actual composite/publication boundary preserves
or rejects changes outside the reviewed mask. Tests cover wrong owners/permissions,
bad geometry/IDs, stale sources/context, no-op/partial output, cancellation cleanup,
failed cleanup and revoked authorization before save.

No live app restart, user artwork/library/authentication changes, model asset
replacement/download, live ChatGPT/Tailscale call, master merge or release occurred.
Detailed boundaries: `mcp-image-edit-boundaries-20260919.md`.
NEXT: bundle 5, external image/mask upload, validation and layer incorporation.
Do not repeat bundles 1-4 or request intermediate live acceptance.
