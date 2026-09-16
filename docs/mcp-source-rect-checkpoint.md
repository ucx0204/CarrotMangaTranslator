# Single-block source rectangle: integration and acceptance

## Current status

`carrot_update_block_source_rect` is registered in the existing block-editing
composition, connected to `McpPageEditService.updateSourceRect`, and included in
the structured output inventory. The earlier policy-only checkpoint is historical;
this feature is no longer waiting for its service or tool registration.

Implementation/inventory baseline: `322e2d0c`.
Final tested code: `673644b5`, including the tool-description clarification.
Branch: `feat/mcp-app-bridge`; no additional branch or app release was created.

## Completed behavior

- One existing block and a fresh page revision; source rectangle coordinates are
  ORIGINAL IMAGE PIXELS. Fractional pixels support exact coordinate round trips.
- The existing page handoff/ownership and `savePageBlocks` transaction are used.
  Dirty/running pages, stale revisions, concurrent saves and revoked permission
  cannot be overwritten. Even an unchanged rectangle needs a fresh revision.
- Read + edit + process scopes are required. Image-transfer scope is not required.
  Both local edit and processing preferences must expose the tool.
- Only source geometry changes. Text, stored typography, reading order, unrelated
  blocks, source image, inpainting and mask assets are retained. Legacy blocks
  without an explicit render box have their previous effective frame pinned.
- Off-page, malformed, non-finite and below-normalization-minimum rectangles are
  rejected, never silently clipped or enlarged.
- Results contain previous/applied pixel rectangles, normalized source bounds,
  the new revision, frame-pinning information and review warning codes. No paths,
  source text, images, download links or file attachments are returned.
- OCR, model inference, erasure, automatic layout, mask regeneration and export
  are not started. Existing library completion invalidation remains authoritative:
  changing source evidence can mark a previous completion receipt pending.

## Typography restriction

A real layout regression reproduced that source geometry can change the renderer's
font-size decision even when all stored font fields are preserved. Changes to a
block with a generated bubble layout and source-font evidence/source-match intent
are therefore rejected before saving. No-op inspection is still allowed.
Do not bypass this restriction by disabling automatic typography without an
explicit separate user request. Preserving this coupled layout while editing its
source geometry is outside this initial feature.

For accepted edits, existing source text, masks, generated lettering, font metrics
and bubble layouts are retained with advisory warnings. They are not newly
validated or recomputed. A warning is not an automatic follow-up operation.
Restoring `previousSourceRect` with the current revision is a new edit, not an Undo
transaction or a promise to restore old timestamps/legacy serialization exactly.

## Verification performed on 2026-09-16

On the connected Windows development PC:

- Source policy, service/ownership, renderer-layout and OAuth HTTP tests:
  **36 tests passed across four files** in this continuation.
- Final `npm run check` on `673644b5`: **26/26 gates passed**, **7,260 tests
  passed**, zero failed, 11 existing skipped; exit 0. Renderer/Electron/JS types,
  lint, architecture, unused exports, coverage, Windows build and artwork parity
  passed. The final run completed at 2026-09-16T13:54:59Z in 179.10 seconds.
- Build after `673644b5`: exit 0.
- Fresh isolated Electron smoke after that build: **exit 0**, with the explicit
  source-rectangle edit/readback/restore PASS marker and final smoke PASS marker.
  The source edit roundtrip compares actual renderer bitmaps and original bytes,
  retains other blocks and rejects stale/off-page edits. The complete smoke also
  passed 189 hostile-input checks across its 27 production tools.
- The surrounding erasure smoke uses a synthetic inference boundary. No actual
  local OCR/inpainting model was needed for the source-rectangle feature.
- A first shell launch returned without usable native logs and was NOT accepted
  as evidence. Acceptance uses the waited Electron child process and its separate
  stdout/stderr logs, not a shell exit code alone.

Evidence under `.tmp/mcp-source-rect-finish-20260916/`:
`full-check.log`, `full-check-final.log`, `full-check-final.exit`, `build.log`,
`native-stdout.log`, `native-stderr.log`, `native-confirmed.exit`.
Repository test details are also in `.tmp/check-timings.json`.

## Live-client boundary and preserved user data

This continuation could not load the `망번테스트` namespace through tool discovery;
plugin-directory search also returned no matching plugin. No new source edit was
sent to the user's live library. Do not report a ChatGPT live invocation from the
successful isolated HTTP/native tests or from the static tool inventory.

The normal app was not restarted, and user library/images, authorization and model
settings were not modified. Native fixtures use their own temporary data root.
After normal app restart and tool-definition refresh, the remaining live acceptance
is an explicitly selected disposable page: read -> source edit -> re-read -> restore
with the new revision. No connection deletion or authorization reset is prescribed.

Usage and exact input contract: `docs/mcp-source-rect-testing.md`.
Historical policy-only checkpoints: `35803ef1` and `220cd14a`.
