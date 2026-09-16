# Single-block source rectangle: implementation checkpoint

## Status

**Not yet exposed as an MCP tool. Do not report this feature as usable.**
The original implementation checkpoint is `35803ef1`, based on `2c98012d`.
Only a strict contract, pure policy and policy tests have been added. The running
app, library, credentials and model settings were not changed or restarted.

A Remote Desktop Commander request to add `updateSourceRect` to
`McpPageEditService` was rejected before execution: the tool could not determine
the request's security status. The same write was not retried through another
transport. Verification confirmed that the existing service file is unchanged.

## Implemented and checked

- `shared/mcpSourceRect.ts`: one existing block, current page revision, source
  rectangle in original-image pixels. Fractional pixels allow exact round trips.
  No arbitrary file paths, image data, extra fields or multi-block input.
- `application/mcpSourceRectPolicy.ts`: uses the app's bbox normalization, rich
  text parser and existing render geometry. Off-page bounds and rectangles that
  the app would silently expand to its minimum normalized extent are rejected.
- Explicit render boxes are preserved. For legacy blocks lacking one, the old
  effective text frame (or active image-lettering frame) is made explicit before
  changing source geometry. Other blocks, fields, image bytes and masks are not
  altered by the pure policy.
- Returns previous/applied pixel bounds, normalized source bounds, frame-pinning
  information and warning codes, not source text, paths or attachments.
- Existing OCR text, inpainting/masks, generated lettering, font evidence and
  bubble layouts are retained; warnings do not trigger processing or validation.

On the connected Windows development PC:

- `vitest run tests/mcpSourceRectPolicy.test.ts`: 14 passed.
- Renderer and Electron TypeScript checks: exit 0.
- ESLint on the three added files: exit 0.
- Existing test-mock boundary check and `git diff --check`: exit 0.
- No UI, native renderer or new-tool live-call acceptance has been performed.

## Remaining work before exposing the tool

1. Add a narrow method to the existing `McpPageEditService`, using its existing
   `mutate`/page ownership and `savePageBlocks` transaction boundary. Require the
   current revision even for no-ops; after a lost response, re-read instead of
   blindly overwriting later edits. Preserve existing tools' retry contracts.
2. Register `carrot_update_block_source_rect` with read + edit + process scopes,
   the strict input schema and `McpSourceRectResultSchema`. No images scope is
   needed for a metadata-only edit. Keep this operation separate from formatting.
3. Add service/HTTP tests for stale/no-op retries, missing targets, handoff,
   revocation at commit, competing writes, shutdown, and metadata-only responses.
4. Test the real library's existing `translationCompletion` invalidation. Do not
   disable it to claim unchanged metadata: source changes may correctly make a
   saved completion receipt pending while retaining image files.
5. Characterize source-derived font behavior before claiming pixel invariance.
   `renderer/src/lib/sourceFontSizeMatching.ts` uses source geometry in reliable
   measurement/peer fallback selection. Preserving stored font fields alone is
   not proof that all automatic source-matched rendering stays pixel-identical.
   Avoid changing font algorithms or unrelated blocks to make this test pass.
6. Run native save/readback + rendered parity cases, including absent render
   boxes, rich text, image lettering, source-matched fonts, page edges, small
   rectangles and restoration using returned previous coordinates.
7. Register measured coverage and update the exact tool inventory. Current gates
   report `geometry.ts` fan-in 37 > 36 and `richTextMarkup.ts` fan-in 30 > 29.
   The new output schema is unused until tool registration. Resolve legitimate
   consumers specifically; do not lower coverage or hide imports/unused exports.
8. Full check, build and native acceptance, then only authorized live testing on
   a disposable page. Do not claim live availability from capability text alone.

No batch scheduler, OCR, erasure, model loading, generic undo, block split/merge
or mask regeneration belongs to this feature checkpoint.
