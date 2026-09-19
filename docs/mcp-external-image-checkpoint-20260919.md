# Bundle 5 external image/mask checkpoint - 2026-09-19

Baseline: `a59eab89`. Continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1-4 remain complete with automatic
checks. User artwork, actual models and live client acceptance remain deferred.

Status: IMPLEMENTED AND REGISTERED; FINAL AUTOMATIC VERIFICATION IN PROGRESS.
Connected source checkpoint: `5b217715`. Do not report a full-check or native-smoke
pass until its terminal result has been read. This continuation replaces the older
preview-only background limitation; existing native image guards were retained.

## Receiving actual files

Five upload tools are connected: `carrot_begin_image_upload`,
`carrot_write_image_upload`, `carrot_finish_image_upload`,
`carrot_get_image_upload`, and `carrot_discard_image_upload`.
They accept complete nonanimated 8-bit PNG files as bounded canonical base64 chunks,
not filenames, remote URLs, arbitrary PC paths or opaque client file handles.
The existing 64 KiB HTTP body limit is unchanged. Each decoded chunk is at most
32 KiB; an upload is at most 32 MiB and 16 million pixels. The session reserves
at most 128 MiB across 32 files, with 256 begin receipts and 4,096 chunk offsets
per file. Exact existing chunk retries remain valid at the chunk limit.

A receiving receipt is not a validated asset. Finish verifies exact received length,
SHA-256, PNG framing/CRC and declared dimensions. Binary masks require opaque black
and white pixels, with white selected and black preserved. No threshold, implicit
alpha mask or rescaling is performed. Uploads have a fixed 30-minute expiry;
inspection does not extend it. Explicit discard and session close clean staging.
Incorporated artwork and native history do not depend on staging staying present.

## Review and separate application

Seven tools provide review, image inspection and recovery:
`carrot_preview_external_image`, `carrot_get_external_image`,
`carrot_get_external_image_preview`, `carrot_apply_external_image`,
`carrot_undo_external_image`, `carrot_redo_external_image`,
`carrot_cancel_external_image`.

Commands distinguish full background replacement, exact-size original-pixel patches
and lettering on one existing block. Uploaded images and optional selected/protected
masks must belong to the same connection and saved page/context snapshot. Protection
wins; unselected background pixels retain the current cleaned image. Selected
background pixels must be opaque. Originals and text/layout/block order are preserved.
Preview does not save a page or produce native background artifacts.

Background application now uses the existing image publication transaction and
InpaintingRevisionStore. Its internal request type was narrowed to the evidence,
recovery and outcome fields actually consumed; no runtime authorization, revision,
source hash, pixel-boundary or history guard was removed. The staged image uses
canonical native artifact naming and retouch difference-mask calculation. That
mask retains the native difference tolerance and retouch-updated provenance, not
an assertion that all original text is gone. Existing workflow completion becomes
pending on background modification and is restored by native history.

Lettering uses native generatedLettering and exact block snapshot commits. Existing
layers require explicit replacement; decorations can be preserved or cleared.
Source/translation strings, coordinates, other formatting and other blocks remain
unchanged. Asset preview is not the final transformed renderer. Normalized lettering
is bounded to 2 MiB per PNG and the shared 4 MiB retained-plan budget also applies.

Apply checks source/cleaned/mask evidence, page/context membership and uploaded bytes
under native page ownership, including upload expiry at persistence. Image previews
require image scope and honor redaction. No model, OCR, translation, erasure, remote
fetch, asset download or authentication/settings mutation is implicit.

## Recovery and limits

No-change plans are excluded. Saved output is acknowledged before UI notification;
a later notification failure is an explicit partial result, not an unrecorded save.
Cancellation stops pending publication and is not rollback. A cancelled plan needs
a new review before a new apply; old action receipts never repeat a mutation.
Undo/redo use retained native images/masks or block snapshots, not another upload
or model call. Later user edits and changed native artifacts conflict. Undo permits
changed context; redo still rechecks context. Background references are capped at
64 per owning session and released at close without deleting current saved assets.
Recovery is session-only with the shared 30-minute idle plan lifetime; durable
recovery is bundle 7, and chapter orchestration remains bundle 8.

## Verification and exact resume point

The resumed focused suite passed 39 cases across seven files, including new native
background saves/recovery and scoped HTTP upload-to-application tests. Existing
upload-store cases are also included in the full suite. Image decoding is replaced
only at the external Electron boundary in these unit/integration tests.
The prior upload PNG/compose complexity findings and missing caught-error cause
were refactored without disabling lint. The HTTP fixture now owns its error sink.

Current full run: `.tmp/mcp-external-final-check2.log`, `.tmp/check-timings.json`,
and `.tmp/check-results/vitest.json`. Two new native background modules need actual
coverage measurement and inventory registration, preserving all inherited floors.
After the build, run the isolated `scripts/mcp-electron-smoke.cjs` through Node's
Electron CLI on an unused port with CARROT_MCP_SMOKE_TAILSCALE=0. Its new external
PNG/background/lettering assertions must produce the terminal completion marker.
Update this checkpoint, the boundaries/coverage records and the roadmap only after
reading those results. Do not start bundle 6 or request intermediate live tests yet.

No live app restart, user artwork/library/authentication change, model download,
master merge or release was performed. Current chat attachment reception and public
Tailscale file delivery have not been tested in this continuation.
