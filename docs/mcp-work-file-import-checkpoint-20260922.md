# Bundle 10: native working-file input

> Current continuation: `mcp-work-file-append-checkpoint-20260922.md`.
> Existing-work append is now connected and native-tested; repository integration
> gates remain pending. The following records the prior completed new-work slice.

Status: NEW-WORK IMPORT CONNECTED; ALL 26 GATES AND DEDICATED ELECTRON SCENARIO PASSED.
Verified source/tests/configuration: `eae62c688fe7013797fc999b6061e526608675ce`.
Starting completed checkpoint: `64c26d98`; this continuation recovered the intervening
implementation at `f82b01b3` and preserved it. Bundle 10 is NOT complete: native
working-file append into an existing work and its context/reference handling remain.
Continue only on `feat/mcp-app-bridge`. Code, tests and documentation are written
through GitHub; verification uses Remote Desktop Commander in the existing review
worktree. No live acceptance, user-app restart, real library/auth/model/Tailscale/OS
changes, new branch, release or master merge.

## Connected tools and existing authorities

Three tools are registered in the actual application composition and strict output
inventory, increasing the inventory from 211 to 214:

- `carrot_preview_work_file`: inspect an owned ready `.mgtshare` v1 upload, return
  its snapshot, source hash, complete chapter IDs/titles/counts, style-guide presence,
  archive sizes and format limitations. Reading only; no image decoding or import.
- `carrot_import_work_file`: import explicitly selected COMPLETE chapters, in the
  requested order and with reviewed titles, into one NEW work. Returns a normal
  operation job; its completion contains the durable working-file receipt.
- `carrot_get_work_file_import`: read the owning connection's historical receipt
  by original requestId, including after MCP client/session reconstruction.

Review/receipt reads require read scope. Import uses the existing read/edit/process
permission and local editing/processing preferences; image-transfer permission is
not implied or required. The existing generic upload tools deliver the bytes.
Neither an opaque chat attachment reference nor a local path substitutes for actual
file transfer. Names and package text are untrusted data, not instructions.

The implementation reuses the native v1 share reader, image materializer, public
share facade, canonical library mutation/transaction and encrypted retention store.
It does not implement a second importer, ZIP unpacker, publication journal or GPU
scheduler. The job journal directly registers the strict working-file command and
receipt identity, and its existing schema dispatch is shared rather than duplicated.
The existing metadata-record publisher supports the receipt's actual page count;
all older record kinds retain their previous count and quota behavior.

The normal image/archive importer explicitly refuses `.mgtshare` input rather than
flattening editable working files into pictures. Upload `ready` still only verifies
bytes; successful metadata review does not guarantee subsequent image decoding.

## What is preserved, and what v1 does not contain

Native import retains original and processed images, editable source/translation
blocks, supported block formatting, chapter/page order and the optional work style
guide contained in the package. New work/chapter/page/block IDs are generated.
Explicit reading-order and completion references are mapped to the generated block
IDs. No fixed reading-order property is manufactured when the package had none.

The native v1 format is NOT a full profile backup. Its normal export does not carry
chapter memory files, local masks, model checkpoints or complete editing history.
Review and tool descriptions state this, and import requires both
`allowNativePreparation: true` and `acknowledgeV1Limitations: true`. Missing context
or memory is not synthesized. OCR, translation, summarization, internet research and
model execution are not part of importing the file. Only the selected chapters are
materialized; unselected chapters and unrelated archive entries are not extra input.

The source package and pre-existing works remain unchanged. The optional style guide
is copied to the new work with its native identity/timestamp adjustment, not merged
into another work. This is a new editable copy, not an identity-preserving restore of
an old profile. A receipt describes past completion, not current work existence.

## Lifetime, atomicity and retries

Unlike ordinary frozen image previews, work-file review REQUIRES the live upload
until import settles. There is no independent copied work-file preview. Discarding
or expiring the upload first prevents import. Active upload leases protect an input
being consumed, and source length/hash/identity are checked before and after review
and again at native publication. Raw local paths are never accepted by the tools.

The native transaction stages the new work, catalog and encrypted receipt together.
Authorization, cancellation, expiry and source changes are rechecked before commit.
Pre-commit failure rolls back the whole new work and receipt; no partial chapter
list is published. Failed receipt encryption leaves the reviewed input usable for
an explicitly retried operation.

Replaying the same request returns its original retained completion after upload
disposal or MCP session reconstruction, including when the independent job journal
is absent. Changing request titles/selection under the same requestId is rejected.
Another request cannot consume the same upload twice; disposing only the receipt
does not reset a live session's consumed-upload state. Uploads themselves do not
survive reconstruction. A FRESH upload of identical bytes is an explicit new copy,
not global content deduplication.

Receipt expiry or disposal never deletes the imported work. Existing same-profile,
approved-owner, seven-day retention and shared 256-record/1-GiB capacity policies
apply. This does not extend to permanent restoration or automatically re-create a
work that the user later deleted.

## Reproduced defects and compatibility corrections

The recovered implementation had already reproduced a native reading-order bug:
block IDs were regenerated, but blockOrder still referred to the old IDs. The saved
baseline failed with `[b,a]` instead of the new destination IDs. The canonical order
resolver and the existing ID map now preserve that order; absent-order behavior is
unchanged. Both unit and real Electron working-file checks exercise this correction.
Evidence: `.tmp/mcp-work-file-order-baseline.log`.

This continuation reproduced duplicate page identities being accepted by review.
The native record ordering uses an ID map, so duplicate IDs can collapse records
instead of preserving the reviewed page inventory. The native share reader now
rejects those ambiguous chapters before review/publication. The regression failed
at `b6b57d37` before the parser correction and passes afterward. Legacy incomplete
pageOrder with unique page IDs remains supported and retains every page in the
canonical order; it is not unnecessarily rejected.
Evidence: `.tmp/mcp-work-file-page-identity-baseline.log`.

A native-only fixture initially used the unsupported stored color name `transparent`.
Actual library validation rejected fixture creation and the native child exited 1.
The fixture was corrected to a valid hex color; no storage validator was relaxed.
The failed run is preserved as `mcp-work-file-native-fixture-failed*`, and is not
counted as a successful working-file run. The final run below reached its new marker.

The existing-work publication guard has a direct native regression: it rejects before
opening a package, staging a receipt or changing any existing chapter. This also
covers the new guard branch without lowering the inherited share-workflow coverage.

## Final verification

At the verified source the COMPLETE repository check passed all 26 stages, exit 0,
in 345.54 seconds. This includes all three type projects, lint/format, architecture,
error handling, mock boundaries, maintainability, duplicate/re-export/generated/CSS/
script checks, unused code, full V8 tests, exact coverage, Windows build, artwork
pixel parity, image protocol and renderer/preload boundaries.

- Full suite: 8,545 passed, zero failures, 11 inherited skips; 8,556 total cases.
- MCP: 1,691 passed across 311 files.
- Working-file-specific tests: 21 passed across eight files. Counts overlap.
- All 4,359 tracked source/test/script hashes matched after full and native checks.

The working-file checks cover editable contents and original/processed PNG bytes,
reading order, selected multi-chapter order, exact optional style guide, absent
context/memory, duplicate IDs, incomplete legacy order, exact 2,000 file-entry review
and overflow, wrong snapshots/kinds/owners, explicit acknowledgments, cancellation,
expiry, source tampering, encryption failure, revocation while the encrypted catalog
is staged, malformed receipts, historical replay, receipt disposal and actual
OAuth/HTTP publication without image-transfer permission.

All 1,785 inherited coverage records, provenance and deletion policy are unchanged.
Four actual Windows/V8 measured modules were added, totaling 1,789 records. Their
measurement source is `994b4dc6`, with 8,543 passing cases and the ONLY failure being
the then-unregistered coverage inventory. The final run validates every new floor.
The inherited native shareWorkflow line/statement floors were initially missed;
the direct existing-work guard regression restores coverage without lowering them.
The coverage inventory test differs from the inherited test only in 1,029 -> 1,033.
No existing tests were disabled and default concurrency/timeouts were not changed;
the existing process-local eight-worker option was used.

## Dedicated actual Electron result

The working-file scenario is invoked by the existing native library-import harness,
not an unconnected test draft. It uses native share export, actual uploaded PNG-based
package bytes, metadata review without the picker, real image validation and native
publication, OS-encrypted receipt storage, MCP client reconstruction, historical
replay and protected source/imported-content checks after receipt disposal.

All THIRTEEN required markers were present, including:
`PASS native working file -> native share export and byte upload` and
`PASS MCP native smoke finished`. Actual child exit: 0. Isolated listener 54248:
closed. Previous incoming-file, import/source-history, organization, page-order,
page/chapter/work deletion, chapter movement and exact-2,000-entry work recovery
markers also passed in that run.

The native source is identical to the separately built `994b4dc6` source; only tests
and coverage registration changed afterward. The complete final check also rebuilt
successfully at `eae62c68`. Native storage, image validation and OS encryption are
real. Existing browser/picker/editor and expensive-model boundaries remain fixtures.
This is not live model/site quality, a user-app restart or actual chat attachment /
`망번테스트` acceptance. No new renderer layout or screenshot is claimed.
The native work-file scenario uses PNG; full maximum-byte benchmarks and all other
image codecs were not independently exercised here.

## Limits and exact resume point

One owned `.mgtshare` v1 file per import. The WHOLE reviewed package must fit at most
ten chapters, fifty pages, 2,000 file entries and 256 MiB expanded, with each entry
bounded at 128 MiB. The transport remains 128 MiB/file, sixteen files/256 MiB reserved
session bytes, 32-KiB chunks, 4,096 chunks/file and fixed thirty-minute session expiry.
Actual 2,000-entry review is not a claim of 2,000 pages or a full-size transfer test.

Evidence prefix: `.tmp/mcp-work-file-verified-` for source/result/evidence, check log,
timings/Vitest/coverage and native log/result. Measurement uses `mcp-work-file-measured-`;
registration is `mcp-work-file-coverage-registration.json`. Earlier failed baselines
and malformed native-fixture evidence remain separately preserved.

NEXT: native working-file append into an EXISTING work, with a reviewed target
snapshot, existing chapter preservation and explicit style-guide/reference handling.
The older native existing-work share flow replaces the complete chapter list and
must not be exposed as unreviewed append. Reuse native materialization and mutation
contracts; do not rebuild the completed uploader, import, library organization,
movement, deletion/recovery or source-history features. Do not start bundle 11.
Live tests remain deferred until all implementation bundles are complete.
