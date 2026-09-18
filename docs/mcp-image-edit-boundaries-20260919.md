# Bundle 4 image editing boundaries - 2026-09-19

## Scope and native authorities

One explicitly versioned page per plan, up to 100 selected source blocks. Chapter
orchestration is bundle 8, external raster/mask upload is bundle 5, and durable
recovery is bundle 7. The new tools do not replace these later bundles.

- Block erasure reuses buildPatternPageMask, with pixel source boxes projected by
  normalizeBboxTo1000 into the native mask contract. No saved geometry changes.
- Free masks and protected geometry reuse rasterMasks stroke, rectangle and ellipse
  rasterizers. Protection subtracts from erasure, and unselected source boxes are
  protected in block-selection mode. Freehand mode is an explicit independent mask.
- Reviewed erasure enters the existing drawn-mask engine with the prepared binary
  mask, zero feather and exact final outside-mask restoration. It may use multiple
  native component windows per block; it is not a promise of one inference per ID.
- Paint and original-pixel restore reuse applyInpaintingRetouch. Explicit paint is
  not an erasure fallback. Source and current cleaned images stay distinct.
- The native image/mask transaction and InpaintingRevisionStore retain exact image,
  mask, provenance and completion states. Text, geometry, order and formatting are
  checked as unchanged. Orphan mask metadata is rejected, not silently repaired.

## Review, permissions and bounded execution

Preview calculates only a mask and file fingerprints; it runs no model and writes
no page, settings or artifact. Inspect before a separate apply action. The owned
plan holds metadata, not full raster buffers. The page limit is 16 million pixels;
geometry is bounded to 200 erase strokes, 50 explicit protected shapes, 1,200 points
per stroke, 12,000 total points and 128 million estimated geometry work units.
Selected block rectangles are additionally bounded to 64 million summed pixels.
Small erasure components below the native 12-pixel threshold are reported as
omitted, not silently expanded. Fully protected or empty masks cannot execute.

Editing and processing must both be enabled locally. Preview/apply/recovery require
read/edit/process scopes. Mask PNG and color sampling also require image scope and
honor redaction review. The mask PNG is reduced to at most 1,600 pixels on its long
edge and 4 MiB; original dimensions/counts remain in the metadata. Color samples
never silently substitute the original for a missing cleaned image.

Only explicit supported local engine selection is exposed, and it must match the
configured engine before acquisition. Approved asset preparation requires explicit
allowAssetDownloads. No implicit OCR, translation, C23, layout, external image API,
settings mutation or second model queue is introduced. Engine options are captured
once inside native page/model ownership. Cleanup is awaited before publication.

The existing page-batch service owns request IDs, asynchronous actions and expiry.
Native page handoff precedes the work-context lease. Revision, membership, source,
cleaned image and current mask are checked before forward execution/publication.
Final output RGBA differences outside the reviewed mask cause rejection. This does
not claim arbitrary external filesystem races are impossible.

## Partial completion and recovery

Native changed-component and pixel counts are not proof of OCR/text removal or
visual quality. Zero changed pixels save nothing. Incomplete erasure components
produce an explicit saved partial outcome rather than an automatic model retry.
A receipt is recorded before UI notification, so a failed notification cannot cause
a duplicated edit. Cancellation waits for native cleanup and is not rollback.

Undo/redo use retained images and masks without inference. Current revision and
artifact hashes remain mandatory. Undo may ignore changed work context, but never
later page edits; redo checks the original context. History is session-only. Plans
expire after 30 idle minutes; up to 64 native image references are retained by this
session and released at session close. Closing this connection does not release
another connection's or the app's unrelated image history. Current saved images
are preserved by the native artifact ownership rules.

## Exact direct-consumer declarations

The existing global architecture limits remain 12 runtime imports / 25 consumers.
Only established public authorities and composition roots receive exact measured
consumer ceilings for this implementation:

| Authority | Ceiling | New direct consumers / reason |
| --- | --- | --- |
| shared/pageRevision | 57 | Image evidence and native publication/recovery |
| shared/blockFingerprint | 43 | Mask binding and immutable page-field comparison |
| application/mcpEditPolicy | 86 | Six image adapter boundaries share typed failures |
| main/library | 56 | Evidence, publication and page-owned image composition |
| main/inpainting | 16 imports | Reuse canonical protected-pixel restoration |
| mcpOutputSchemas | 17 imports | Register the image-edit output contract family |
| mcpPageOperationSession | 25 imports | Connect the image-edit session to real app composition |

No hashing, raster geometry, revision algorithm or engine is copied to evade the
budgets. Automated evidence and final completion status belong in the checkpoint,
not in this design record. Live model/user/client tests remain deferred.
