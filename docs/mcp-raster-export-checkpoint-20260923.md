# Bundle 11: explicit raster output, ZIP and retained reissue

Status: RASTER SLICE CONNECTED; ALL 26 GATES AND DEDICATED ELECTRON CHECKS PASSED.
Verified source/tests/configuration: `a309bf8b9148c65bef24e083d3433e8fb2a4f8c4`.
Bundle 11 is NOT complete. PSD, native working-file output, source-format policy,
text/context exchange, dedicated delivery diagnostics and approved output sync remain.
Bundle 12 has not started. Live acceptance is deferred until all requested bundles
are implemented. Continue only on `feat/mcp-app-bridge` in the existing review tree.

Starting reported bundle-10 checkpoint: `714d3e08`. This continuation recovered the
already committed raster implementation at `b7cb40e5` rather than overwriting or
recreating it. Code, test and documentation writes use GitHub; verification uses
Remote Desktop Commander. No user-app restart, real manuscripts, authentication,
model assets, OS/Tailscale settings, extra branch, master merge or release.

## Connected public commands

One new tool, `carrot_export_pages_images`, exports one to fifty explicitly reviewed
pages from ONE chapter as PNG, JPEG or WebP. A one-page selection uses this same tool;
there is no additional registered generic single-page image-export command.
The strict output inventory increases from 215 to 216.

`carrot_preflight_pages_export` accepts an optional `imageExport` object. Its format,
quality and text-omission settings are bound into the returned snapshot together
with the ordered selected pages and revisions. Importing or translating is not part
of preflight. Reuse the exact reviewed options and page/revision pairs when exporting.
Changing options or source state requires a new review instead of silently changing
encoding, quality, page selection or resolution.

Supported options are `format: png | jpeg | webp`, `omitText` (default false), and
`quality` (integer 1-100, REQUIRED for JPEG/WebP and forbidden for PNG). The native
renderer is requested at original resolution; transport limits do not silently
lower resolution or replace the requested format. This is encoding a current saved
render, not copying an original JPEG file unchanged.

The existing `carrot_export_page_png` and `carrot_export_pages_png` retain their old
contracts and request semantics. The PNG batch command does not accept the new
options; the new image-batch command requires them. Existing PNG clients and
historical request/receipt parsing remain supported.

## Text omission has a precise meaning

`omitText: true` renders the already stored inpainted background without saved text
and generated-lettering block overlays. It REQUIRES an existing inpainted image.
It does not invoke erasure, OCR, translation, lettering preparation, research or a
model, and it does not claim to detect or remove every source letter still present
in the background. A page without a cleaned image fails rather than exporting the
original as a pretend cleaned result. The original, block data and saved masks are
not changed by export.

The implementation reuses `McpPageExportService`, the existing native render session,
page input handoff/activity ownership, source checks, artifact store, streaming ZIP
writer and retained-output catalog. No new encoder, renderer, ZIP engine or GPU queue
was introduced. Redaction and image permission are checked before and after rendering
and again through the existing file access and retained reissue paths.

## Files, ZIP and retries

The original `carrot_create_export_zip` now packages successful PNG/JPEG/WebP outputs
without rendering them again. Numbered entries retain the reviewed order and correct
extension. The manifest records explicit image options and partial-output state.
A partially completed source job still needs explicit `allowPartial` approval;
failed and unprocessed pages do not appear as successful files.

`carrot_get_job_file` remains an explicit, scoped retrieval step. It returns matching
MIME/extension metadata and only adds a resource-link attachment when requested.
Job submission, job polling and job lists remain metadata-only: they do not quietly
publish download URLs, binary data or private paths. Invalid MIME/filename combinations
are rejected instead of being converted into attachments.

Same-request replay uses the existing operation identity; it does not render a second
copy. JPEG/WebP outputs and their ZIPs use the existing owned retention catalog.
After MCP client/session reconstruction, `carrot_get_output_file` can issue a fresh
short-lived link to the same preserved bytes, subject to existing source, owner,
permission and redaction checks. No rerender is needed merely because an old link
expired. Revocation, changed source evidence and record disposal retain their normal
blocking behavior. This is not an unlimited archive of freely accessible old revisions.

Retention records/catalog use the existing OS-encrypted storage; output bytes remain
owned private files with recorded hashes. This is not a claim that each image byte
file is itself encrypted. Discarding an output record does not delete user originals.

## Reproduced failures and fixes

The recovered implementation had reproduced missing owned-invocation context for
the new read-only export command: both JPEG and WebP retention failed with
`An owned retained-output invocation is required.` The named new export was added
to the existing retained invocation path, without giving arbitrary read tools write
or recovery privileges. The retained-byte/reconstruction regressions now pass.
Evidence: `.tmp/mcp-raster-owner-baseline.log` and the final raster retention tests.

The legacy unavailable-file diagnostic lost its actionable instruction to export the
current page. The existing regression was preserved and the diagnostic restored;
PNG callers were not made to accept a different interface just to pass tests.

Native verification exposed test-harness defects, not reasons to weaken application
checks. Its imported fixture initially had no cleaned background, then lacked the
renderer handoff acknowledgement required by real page ownership. The scenario now
first verifies an actual failed textless request, supplies a separate synthetic
background through native library publication, and acknowledges only this isolated
fixture's editor handoffs. A timeout cannot satisfy the expected rejection test.

The next native run exposed the test's PNG/JPEG NativeImage decoder being used for
WebP. Actual output format is now checked by the existing header probe, and all three
formats are decoded by real sandboxed Chromium without network. The PNG textless
result is compared pixel-for-pixel against the prepared background. Finally, native
setter results can contain transient undefined-valued properties that are absent
from saved JSON. The preservation baseline now reads the saved chapter and also
compares exact chapter-file bytes; it does not loosen production schemas or remove
preservation assertions.

All these unsuccessful native attempts retain failed exit codes and separate logs.
They are not counted as successful raster verification.

## Automated verification

At `a309bf8b`, the complete repository orchestrator passed all 26 stages in ONE final
execution, actual exit 0, in 311.95 seconds. Full V8 suite: 8,592 passed, zero failures,
11 inherited skips (8,603 total cases). MCP: 1,738 passed across 322 files. Raster,
artifact-file and disclosure tests: 36 passed across seven files. Counts overlap.
Relative to the completed bundle-10 source, 28 behavior cases were added across this
raster slice; seven of those were added in this continuation.

The new continuation tests execute real native export preflight, job ownership,
editor handoff and library reads with the encoder as an external test boundary.
They cover legacy/explicit PNG, JPEG, WebP, no implicit PNG fallback when a raster
adapter is unavailable, and mismatched MIME/filename metadata. Earlier raster tests
cover strict quality/options, selection snapshots, unchanged inputs, sequential
partial results, exact ZIP bytes/options, HTTP GET/HEAD/MIME/attachment behavior,
redaction/revocation, owned reissue, corruption and protected disposal.

All inherited coverage floors remain. Two Windows/V8 measured records were added:
`src/main/mcp/mcpArtifactFiles.ts` and `src/shared/mcpOutputFormats.ts`.
All 1,792 inherited records/provenance/deletion policy are unchanged, bringing the
total to 1,794 (756 original and 1,038 introduced records). The inventory assertion
changes only 1,036 to 1,038. The final full run passes every old and new floor.
The architecture baseline is byte-identical to the bundle-10 checkpoint; no dependency
ceiling was raised for this slice. No tests were removed or newly skipped, and no
concurrency/timeout defaults were changed. The existing process-local eight-worker
option was used.

Registration measurement: full Windows/V8 source `b7cb40e5`, artifact
`.tmp/mcp-raster-measured-coverage.json`, SHA-256
`bb85d37f2658c0d68f730ff4dcebded8b237a5db0700ceda6345c482101cdd09`.
That earlier full run had 8,583 passes and two failures (diagnostic compatibility and
missing coverage inventory), not a passing suite. Exact measured metrics were checked
against the registered records. GitHub registration commit `fbd79878` preserves all
preexisting values; its one-shot workflow was removed in `55bc78bd`.

The final gate includes all three type projects, format/lint, error handling, mock
boundaries, architecture, maintainability, duplicate/reexport/generated/CSS/script
checks, unused code, full V8 tests and exact coverage, Windows build, artwork pixel
parity, image protocol, and renderer/preload boundaries. Source/test/script inventory:
4,378 tracked hashes, rechecked after testing and before final handoff.

## Dedicated actual Electron result

The existing native harness invokes the raster scenario, not a disconnected test draft.
It ran AFTER the successful final check using that exact source/build. All FIFTEEN
required completion markers were present, actual child exit 0, isolated listener
54090 closed. The final marker includes:
`PASS native raster export -> actual PNG JPEG WebP and textless pixels -> ZIP -> reconstructed retained byte-identical reissue`.

The scenario exports actual PNG/JPEG/WebP bytes, validates the encoded format and
Chromium decoding/original dimensions, compares textless PNG pixels, checks each ZIP's
contained bytes and manifest, reconstructs MCP clients, reissues every retained image
and ZIP without reencoding, disposes the output records, and checks exact saved
chapter/original/background preservation. Native renderer, encoder, library storage,
artifact files and encrypted record storage are real. The tiny prepared background
and editor replies are synthetic fixtures, not real model-inpainting quality evidence.
Earlier import, persistent source-history, work-file new/append, organization,
page/chapter/work recovery, chapter movement and exact-2,000-entry restoration
scenarios passed in the same run.

HTTP tests separately use a real scoped server with fixture encoder bytes. The native
scenario reads actual artifact bytes through their owned access path. Neither is a
claim that the real ChatGPT attachment UI, a public Tailscale download, live models,
all maximum-size inputs or a user-app restart were tested. No renderer layout change
or new UI screenshot is claimed. Live acceptance remains deferred.

## Limits and exact next step

One reviewed chapter and one to fifty selected pages per raster job, with one explicit
format/options set. Individual images remain bounded at 64 MiB, ZIP at 128 MiB and
session output at 256 MiB. Short-lived links use the existing ten-minute policy and
may be invalidated earlier. Retention uses the existing same-profile/approved-owner
seven-day, shared 256-record/1-GiB limits; this is not permanent storage or unlimited
image transfer. No maximum-byte performance benchmark is claimed.

NEXT within bundle 11: PSD and native editable working-file OUTPUT using existing
exporters, then reviewed text/context exchange, explicit source-format selection,
dedicated attachment/delivery diagnostics and approved output synchronization.
Native working-file INPUT was completed in bundle 10 and must not be rebuilt.
Do not repeat the verified raster/ZIP/reissue paths or start bundle 12 yet.

Evidence prefix: `.tmp/mcp-raster-final-` for source/hash inventory, check exit/log,
timings, full Vitest/coverage and native log/result. Earlier owner, unavailable-file,
format/type and native fixture failures remain separately preserved. Final handoff
requires clean local/remote equality and document-only changes after this verified
source. No actual user library or connection configuration was modified.
