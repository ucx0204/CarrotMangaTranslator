# Bundle 5 external image boundaries - 2026-09-19

This is a partial bundle-five checkpoint, not completed background incorporation.
Work only on feat/mcp-app-bridge in the existing review worktree. No release,
master merge, live app restart or user/model/client acceptance is implied.

## Receiving real bytes

The native HTTP request limit remains 64 KiB. An approved read/edit/process
connection reserves a page/context-version-bound PNG, appends canonical base64
chunks of at most 32 KiB of decoded bytes, then explicitly validates completion.
The receipt is receiving until exact byte count, SHA-256, dimensions and PNG
structure/CRC are checked. Filenames, URLs, paths and connector file handles are
not accepted as bytes. There is no server-side URL fetch or arbitrary local file
reader and no guarantee that a particular chat host can supply actual bytes.

Supported input is one complete, nonanimated 8-bit PNG. Dimensions are checked
before raster inflation, with at most 16 million pixels. Binary masks must contain
only opaque black/white pixels; white selects and black preserves. Protection
subtracts from selection. Alpha is not interpreted as a binary mask implicitly.
Trailing content and APNG chunks are rejected. There is no hidden rescaling.

Limits: 32 MiB per upload, 128 MiB reserved and 32 active files per session,
256 begin receipts, and 4,096 distinct chunk offsets per file. Exact chunk retries
remain valid at the chunk-count limit. A fixed 30-minute expiry is not extended
by inspection. Expiry revokes use; staging files are removed by explicit discard
or session close, not an automatic background garbage collector in this slice.
Staging discard cannot delete incorporated block images or native page assets.
Concurrent consumers hold their own leases and close waits for active consumers.
A reservation failure only removes a file that request successfully created.

## Distinct output kinds

Existing-block LETTERING incorporation is connected. It preserves all source and
translation strings, block coordinates, order, typography and other blocks. It
uses the existing generatedLettering data shape, including optional decorations.
Replacing an existing layer requires an explicit flag; preserving or clearing
its decorations is explicit. Asset-space binary/protection masks become transparent
pixels, not page-background erasure. The asset fits the current native block
geometry; the asset preview does not claim to be the final transformed renderer.
Incoming normalized lettering PNG is limited to 2 MiB and the shared 4 MiB plan
budget also applies to retained before/after snapshots. Large replacements may
therefore be rejected below the individual asset limit.

BACKGROUND replacement and cropped patch candidates are preview-only. A patch
must exactly match its declared original-pixel rectangle; a full candidate must
match the page dimensions. Selected background pixels must be opaque. Native
outside-pixel restoration preserves unselected and protected content. The resulting
candidate is not saved: plans explicitly have canApply=false and exclusion
background_application_not_connected. There is no fabricated paint command or
alternate background writer to bypass the unfinished native publication boundary.

The existing mcpImageEditPersistence module was not changed. A requested request-type
separation was refused by the tool checker and no equivalent modification was
routed through another tool. Native background publication/history is a remaining
implementation item, not a completed feature.

## Authorization, evidence and recovery

Every asset is owned by its originating connection and bound to saved chapter,
page revision, work-context revision and original/cleaned/mask fingerprints.
All images and masks for a candidate must agree on that binding and dimensions.
Application rechecks ready uploads and their evidence under the existing native
page/context ownership, and the upload's deadline is checked again at persistence.
No remote raw block object or unvalidated replacement text is accepted.

Lettering saves use McpPageEditService.commitSnapshotBatch, the native library
transaction and the existing page-batch request/recovery lifecycle. A receipt is
recorded before UI notification. Historical action IDs do not reapply. Cancellation
stops pending work, not already committed saves. Undo/redo restore retained exact
block snapshots, including optional-field absence, without another upload/model.
Later user edits and changed original assets conflict. Undo tolerates expired or
discarded staging uploads; redo still checks native page/context evidence. Session
history is not durable recovery, which remains bundle 7.

Candidate PNG transfer requires image scope and honors redaction before and after
preparation. Transfer is bounded to a 1,600-pixel long edge and 4 MiB. No source
path, internal snapshot or data URL is included in metadata-only inspections.
No model, OCR, translation, erasure, settings write or asset download is implicit.

## Verification boundary

Tests use real PNG bytes, native library persistence, source hashes, page/context
ownership and real OAuth/HTTP. Electron native image I/O is substituted at its
external boundary. They are not live user artwork, inference quality, public
Tailscale delivery or chat attachment acceptance tests. Exact counts and remaining
static/coverage findings belong in mcp-external-image-checkpoint-20260919.md.
