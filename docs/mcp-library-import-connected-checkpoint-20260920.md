# Bundle 10 continuation: reviewed native-file and single-URL image import

Latest continuation: `mcp-chapter-discovery-checkpoint-20260920.md`. Bounded
chapter-link discovery, retained owned reviews and explicit selected-link scanning
are implemented and pass all 26 gates at `0af2ce58`. Multi-URL execution/resume,
fresh-preview source deduplication, library organization and attachment exchange
remain. The original slice and its historical verification below are preserved.

Status: REVIEWED IMPORT SLICE IMPLEMENTED, REGISTERED AND AUTOMATIC/NATIVE
VERIFICATION PASSED. Bundle 10 as a whole is NOT complete. Continue on
`feat/mcp-app-bridge` in the existing MCP-Review worktree. Bundles 1-9 are preserved.
Final verified source/test/configuration: `f4ea5e0c034f561946eada8364ed9f5f5e25a18f`.
The remaining multi-URL/library-management/input-exchange scope is listed below.

## Implemented surface

Seven tools are connected through the existing app page-operation composition:
`carrot_choose_import_files`, `carrot_scan_import_url`,
`carrot_get_import_preview`, `carrot_get_import_target`,
`carrot_import_chapters`, `carrot_get_import_receipt`, and
`carrot_discard_import_preview`. Input/output validation, OAuth scopes, operation
journal kinds and session teardown are connected. The strict output inventory
is 159, compared with 152 before bundle 10.

Native file input opens the existing Electron file/directory picker. Only selected
files enter preview preparation. Remote payloads cannot supply filesystem paths,
another UI preview ID, callbacks or a serialized native import request. Supported
native preparation dispatch covers image files, folders, chapter containers,
ZIP/CBZ, RAR/CBR and PDF. Native parser/runtime preparation requires explicit
permission where applicable. A real client must complete the local picker; this
is not chat attachment upload or unattended access to arbitrary PC files.

Single-URL web input uses the existing WebImportSessionManager and its URL,
redirect, private-address and download controls. The manager has a separate
MCP-owned temporary root, never the UI's web-import directory. It prepares image
candidates and reports truncation/skipped counts; this is NOT work-table-of-contents
or exhaustive chapter discovery. No login/CAPTCHA bypass or cookies are accepted.
The current web path prepares candidate images before the user selects the subset.
The public preview is paginated names/order/IDs and warnings, not an image gallery.

The preview fixes selected source bytes in owned temporary copies. SHA-256, size,
regular-file and no-symlink checks run during capture and again before publication.
Shared ZIP/container sources are copied and budgeted once, not once per member.
Changes to external original files after preview do not alter reviewed copies;
changing a captured copy rejects the import. Originals are not rewritten.

Create imports only chosen draft/page IDs in explicit order through the original
library importer, image validator, archive reader and publication transaction.
New-work or existing-work destination is explicit; existing-work metadata must
still match its reviewed snapshot. Authorization, cancellation and source checks
are repeated at native publication. Imported library data and its encrypted receipt
join the SAME transaction. No OCR, translation, inpainting or research is executed.

A preview is one-shot. An identical creation request returns its historical receipt,
including after session reconstruction. A different request cannot import the same
used preview again. An encrypted receipt saved before a lost response can be found
by requestId; no silent duplicate chapter is created. Separate, freshly prepared
previews of identical files/URLs are NOT yet persistent source-deduplicated.

## Fixed regressions and verification boundaries

The inherited selected-web import preserved original storageStem values after
subsetting/reordering. The native importer correctly rejected noncontiguous numbers.
Selection now clones each selected page and renumbers only native storageStem in
final order; original names, frozen review and source evidence stay unchanged.
Both reverse-order and one-page subset tests verify bytes and 1.png/2.png naming.
The original failure remains in `.tmp/mcp-import-continuation-fixes.log`.

If web-session retirement failed after captured input was ready, the caller received
an error but the frozen directory remained outside the preview owner/budget. The
failing regression in `.tmp/mcp-import-cleanup-repro.log` reproduced that leftover.
Native session cleanup now finishes before exposure; failures release captured input.
Cleanup still preserves original source files and UI staging.

Focused native-library, publication, source and staging tests passed 24 cases across
six files. Two additional journal tests and eight structured-output tests passed.
They verify exact expiry, replay identity, malformed receipt rejection, current
work preservation, cancellation, post-commit crash, private URL rejection,
source/selection boundaries and real OAuth/HTTP grant revocation at publication.
The HTTP restart fixture serializes/restores the actual test provider state rather
than incorrectly reusing a disposed provider. This was a fixture issue, not a new
production authorization exception.

Only established external boundaries are substituted in unit integration tests:
Electron/picker, test OS-encryption codec, image decoder and web provider. Native
library files, header/ZIP validation, activity leases, staging, transactions,
retention storage, job journal, tool contracts and OAuth/HTTP execute real code.
The added actual-Electron scenario automates only native test-file selection and
must verify real image validation, OS-encrypted receipt, reconstruction/replay,
receipt disposal and original preservation before it is marked successful.

## Limits and distinctions

A preview has a fixed thirty-minute session-only lifetime, at most ten chapters
and 500 candidate pages. Captured source files are limited to 128 MiB each and
256 MiB in total. The session permits at most ten previews sharing 256 MiB.
Creation selects at most ten chapters and fifty distinct pages per call.
There is no quiet truncation or resolution reduction to turn an excess into success.

Receipts use the existing shared seven-day/256-record/1-GiB encrypted retention
policy. The imported works/chapters are ordinary library data and do NOT expire
with that receipt. Discarding a preview or receipt never deletes imported chapters.
Receipt availability reports existing chapter IDs, not equality with their original
content and not permission to undo. Destructive rollback is not implemented here.

## Remaining bundle 10 work

1. Chapter-link discovery, reviewed bounded multi-URL execution, per-URL failures
   and explicit resume using the existing importer, not a second import engine.
2. Persistent source URL/content identity and duplicate detection across fresh
   previews, including new-chapters-only import and source history.
3. Existing library naming/order commands plus separately reviewed moves/deletions
   with original-file preservation and explicit recovery semantics. Existing native
   mutation code needs a trusted publication guard/receipt boundary, not raw remote
   IPC dispatch or a parallel library store.
4. Incoming file-byte IDs/attachment exchange and the app's working-file format.
   Bundle 5 image-result upload is not yet wired as general file/archive import.
5. Remaining container/native browser and final client acceptance tests. Automated
   PNG/ZIP fixtures are not evidence that every PDF/RAR/site/attachment was tested.

Do not start bundle 11. Do not redo completed context migration/research or create
another GPU queue, storage layer, renderer or archive implementation.

The running user app, real artwork/library, credentials, model assets and Tailscale
are not modified or restarted. No master merge, release, new branch, live website
or user-manuscript test is part of this continuation. Final integrated live testing
remains deferred until all bundles are implemented.

## Final verification

All 26 repository gates passed with actual process exit code zero at
`f4ea5e0c034f561946eada8364ed9f5f5e25a18f`. **8,188 tests passed, zero failures and
11 inherited skips**. The MCP subset passed **1,369 cases across
221 files**; reviewed-import-specific tests passed **32 cases across 8 files**.

Renderer/Electron/JavaScript type projects, lint, formatting, error handling,
dependency/structure, duplicate/dead-code checks, test boundary checks, exact
coverage inventory/floors, Windows build, native artwork parity, image protocol,
renderer and preload checks all passed in the same sequence. The run used the
existing process-local eight-worker option. Checked-in worker defaults, the
15-second test timeout and existing coverage thresholds were not changed.

The initial full run at `45b3fda4` passed 8,181 tests and failed only the then-missing
six-module coverage registration. Its log/V8 artifacts remain separate; the passing
final suite is the completion evidence, not that earlier failure. The later picker
cancellation test initially expected a completed job containing a cancelled result;
the actual operation boundary correctly returned a cancelled job. The test now
asserts cancellation directly without changing production cancellation behavior.

All **1,714 inherited coverage records, provenance and deletion records remain
identical** to `d7b86ebf`. Only six new production modules were registered from
measured V8 totals/covered counts, bringing the manifest to **1,720 records**.
The initial measurements were enforced successfully against the final passing run;
no inherited floor was reduced. Artifact and SHA-256:
`.tmp/mcp-import-initial-coverage.json`,
`bacb4d22c72b550d98a4af90f2c1fbe630a0ead3eb595a222d9aa8e6b62545ff`.
The per-module ratios and initial source are in
`.tmp/mcp-import-coverage-registration.json`. Seven measured direct dependency
counts were recorded with their canonical use; global architecture limits remain.

Full-gate interval: `2026-09-20T12:49:48.352Z` through `2026-09-20T12:55:13.091Z`.
The added actual-Electron scenario passed with **actual child exit code zero**,
`PASS native selected import -> real image validation` and
`PASS MCP native smoke finished`. It used the same verified implementation.
Only native test-file selection was automated in this scenario; the image validator,
ordinary library importer and OS-encrypted retention path were real. It verified
single selected PNG input, atomic receipt, session reconstruction, historical replay,
receipt disposal and original/imported-file preservation. Port 38694 was confirmed
closed after the child exited. No running user app or public tunnel was restarted.

Source/test/script hashes were recorded before the final full check and rechecked
after native completion. Subsequent documentation commits must compare identical
against `f4ea5e0c` for those paths before final publication is certified.

Evidence in the review worktree:
`.tmp/mcp-import-whole-check-2.log`, `.tmp/mcp-import-final-evidence.json`,
`.tmp/mcp-import-final-vitest.json`, `.tmp/mcp-import-final-coverage.json`,
`.tmp/mcp-import-final-timings.json`, `.tmp/mcp-import-verified-source.json`,
`.tmp/mcp-import-native.log`, `.tmp/mcp-import-native-result.json`, and earlier
focused/reproduction logs. Native folders/ZIP member selection were tested in the
real-library integration fixtures. PDF/RAR/chapter-container permission denial was
tested, but successful conversion of every container type or a live website was
NOT covered by this native PNG scenario. No chat attachment transfer or live-client
acceptance is claimed. Continue bundle 10, not bundle 11.
