# Bundle 10 continuation: reviewed library names and chapter order

Latest continuation: `mcp-library-synchronization-checkpoint-20260921.md`. Metadata
notifications, Undo display correction, dedicated native organization and production
UI QA now pass with all 26 gates at `273c5ece`. The prior pending native/UI notes
below are historical; resume at page ordering and remaining bundle 10 input/moves.

Status: IMPLEMENTED, REGISTERED, ALL 26 REPOSITORY GATES PASSED.
The existing Electron regression also passed. A new positive organization-specific
Electron scenario is NOT connected or claimed. Bundle 10 as a whole is NOT complete.
Verified source/tests/configuration: `d694f439a276db3d9e0199f29300a741231091f1`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting reported checkpoint: `1338a350`. Preserve completed import/source identity.

## Connected public behavior

Six tools are registered in the production page-operation composition, preferences,
OAuth scope checks and strict output contract inventory (172 -> 178):

- `carrot_preview_library_change`
- `carrot_apply_library_change`
- `carrot_get_library_change`
- `carrot_list_library_changes`
- `carrot_undo_library_change`
- `carrot_redo_library_change`

The supported intentions are work rename, chapter rename and complete chapter
ordering inside one work. A preview returns actual before/after names or chapter
IDs, the current saved-state snapshot and a plan fingerprint. It neither saves a
preview record nor changes the library. The native title rules trim names and
resolve duplicate chapter titles; the resulting unique name is visible before apply.
The MCP chapter order must contain every current chapter exactly once. It cannot
silently drop, add or move chapters. Native desktop partial-order behavior remains
compatible and has its own before/after characterization test.

Apply uses the reviewed intent, snapshot, plan fingerprint and a new request ID.
Changes to the saved target between review and publication reject the command.
Original images, page blocks, masks, imported source history and saved story memory
are not edited by these commands. Chapter order can affect future context ordering;
it does not rewrite existing memories, rerun research or translate pages.

This slice does NOT expose page reordering, moves, deletion, general incoming
attachments or working-file import. It changes no renderer component or UI layout.
Immediate refresh of an already-open library pane is not separately wired or
certified here; include renderer synchronization in the remaining organization/UI
acceptance work rather than assuming that successful disk publication proves it.

## Reused native behavior and atomic recovery

The existing `renameWorkUnlocked`, `renameChapterUnlocked` and
`reorderChaptersUnlocked` now share `libraryStore/libraryOrganization.ts` with MCP.
It reuses the original normalization, unique-name and ordering algorithms, native
file validation, chapter-history-aware staging and existing library transactions.
Work rename/order now also use native transactional publication rather than an
uncoupled work-file write. Page order/deletion implementations remain unchanged.
The pre-extraction characterization passed and continues to pass after extraction.

A metadata change and its encrypted recovery record publish in ONE transaction.
Late encryption failure, expiry, permission revocation or session shutdown cannot
leave the name/order saved without its required record. The existing library
activity gate, read/write locks, mutation tracking and shutdown ownership are reused.
No second library, importer, GPU scheduler, renderer or authentication flow exists.

Recovery stores only work title/order/timestamps, the selected chapter's title/time,
canonical state fingerprints, request identity and bounded action history. Raw
chapter text, image paths and bytes do not enter this record. The ordinary work and
chapter files remain in their existing format and storage location.

MCP reconstruction restores the ability to inspect and Undo/Redo using the retained
ID. Undo restores the exact prior metadata, including its timestamps, rather than
running an inverse rename with newly chosen values. Redo uses the same record.
The current work, selected chapter and sibling names for a chapter rename must
still match the recorded state. Conflicting later saved edits are rejected, and a
missing target is not silently recreated. The record does not certify current image
bytes or perceptual/content correctness.

Repeated apply/Undo/Redo request IDs return historical receipts. In particular,
replaying the original apply after Undo does NOT apply it again. Changing the
payload or direction under an old request ID is rejected. A no-op records the
request without changing metadata timestamps and offers no meaningless recovery.
Discarding an owned record with existing `carrot_discard_retained` removes only
recovery, never the ordinary work, chapter or original images.

Read-only review/list/inspection requires `carrot.read`. Apply/Undo/Redo retain
`carrot.read carrot.edit carrot.process` and both editing/processing preferences.
Image transfer permission is not required. Retained records remain isolated to the
approved connection and data profile; public callers cannot supply native state,
filesystem paths or arbitrary patch objects.

## Regression found and fixed

The first corruption regression replaced a saved record's prior title while leaving
its state fingerprint intact. Actual recovery rejected the inconsistency, but the
availability lookup incorrectly returned `canUndo: true`. The failed run is
`.tmp/mcp-library-organization-failure-repro.log` (five cases passed, one failed).
Lookup and actual recovery now share bidirectional restoration verification: the
restored target and round trip must both match the saved native fingerprints.
The original failing case now passes; invalid metadata is not treated as available.

The initial tool-composition factory exceeded the eighty-line function limit.
Read-only and mutation tool construction are now separated by responsibility in
the same module, retaining the same authorization/lifetime wrapper. No suppression
was added. The first full repository run also caught an existing native file-policy
header displaced by a newly inserted import; its original header position was
restored without changing the policy baseline or adding a new exemption.

## Final automatic verification

All 26 repository gates passed with actual process exit code zero at the verified
source. The full suite passed **8,299 tests, zero failures and 11 inherited skips**.
The MCP subset passed **1,456 cases across 251 files**.
Five new test files contribute **16 passing cases**. The final focused run, including
existing strict-output tests, passed **24 cases across six files**.

Renderer/Electron/JavaScript type projects, formatting, lint, error handling,
architecture/maintainability, duplicate/dead-code checks, test boundaries, exact
coverage inventory/floors, Windows build, native artwork parity, image protocol,
renderer and preload checks passed in the same complete sequence. The supported
process-local eight-worker option was used; defaults, timeouts and skips are unchanged.

Tests use real native library reads, naming/order rules, transactions, encrypted
record plumbing, registered tool result validation and local OAuth/HTTP. Only the
established native image-decoder and OS-encryption boundaries are substituted in
these unit integrations. Cases include exact reconstruction and Undo/Redo, no-op,
original apply replay after Undo, owner/scope isolation, strict parameters, complete
order checks, native compatibility, later edits, activity contention, post-encryption
external file changes, late revocation/expiry/stop, corrupt recovery, action cap and
record expiry/disposal preserving ordinary metadata and original images.

All **1,739 inherited coverage records, provenance and deletion entries are unchanged**.
Only six new modules were added from actual V8 totals/covered counts, bringing the
inventory to **1,745**. Initial measurement source: `942ece30`. Artifact SHA-256:
`0381dffe2b5900fd1e61465ee61bd80cbc8d921cbfc07498fe188b5d4a42c0d5`.
The final suite enforces the same old and new floors. No excluded source or lower
historical floor was introduced. The coverage inventory's own 27 tests also passed.

Eight direct dependency counts were measured/documented: appActivityTypes fan-in 32,
library lock 39, blockFingerprint 93, mcpEditPolicy 163, libraryFiles 35, mcpBatchTool
30, output composition runtime imports 32 and page-session composition imports 33.
They reflect direct reuse by the native publisher, record policy/repository/application
and tool composition, not copied authorities, dependency-hiding aliases or a global
ceiling increase.

The second full run passed 8,298 tests and failed only the six-module coverage
inventory before its registration. That failed result and measurement remain separate
from the final passing run. Final gate interval: `2026-09-20T23:18:10.367Z` through
`2026-09-20T23:23:06.443Z`.

Evidence in the review worktree: `.tmp/mcp-library-organization-full-check-3.log`,
final-evidence.json, final-vitest.json, final-coverage.json, final-timings.json,
verified-source.json and coverage-registration.json with the same prefix. All 21
changed source/test/configuration file hashes matched before and after verification.
Subsequent documentation commits must compare identical for src/tests/scripts.

## Actual Electron regression and explicitly unverified work

The UNCHANGED existing Electron MCP harness passed at the same verified source:
actual child exit zero, all four required markers and isolated port 38700 closed.
It rechecked selected imports, grouped publication, persistent source identity,
OS-encrypted records, reconstruction and existing page/render/export behavior.
Evidence: `.tmp/mcp-library-organization-legacy-native.log` and
`.tmp/mcp-library-organization-legacy-native-result.json`.

A request to wire a NEW library-organization scenario into that harness was rejected
by the tool safety check before execution. That request was not reapplied through
another tool. The unconnected new scenario file was removed; no missing import,
unused script entrypoint or positive organization-specific Electron claim remains.
The legacy pass and build/parity gates do NOT substitute for that pending scenario.
Likewise no live-site, real user manuscript, user-app restart, actual chat attachment
or `망번테스트` acceptance was performed. No UI screenshot or immediate-refresh
acceptance is claimed for this metadata slice.

## Limits and exact resume point

One command targets one work or one chapter in it. Input titles are at most 240
characters; chapter order is at most 2,000 distinct current IDs. The shared native
reader's bounds still apply. Records use the existing seven-day/256-entry/1-GiB
catalog, same profile and approved owner, and at most 32 successful recovery actions.
Ordinary renamed/reordered library content does NOT expire with the record.

Resume bundle 10 with the outstanding dedicated native/renderer synchronization
verification, then page ordering and its saved-memory effects; separately reviewed
moves/deletions/recovery; general incoming attachment bytes and working-file input.
Do not recreate completed metadata review/publication, import/source matching or
advance to bundle 11 while these items remain.

The running user app was not explicitly stopped/restarted. Real user artwork/library,
credentials, model assets, Tailscale and operating-system security settings were not
edited by this work. All test mutations used isolated fixtures. No new branch, master
merge or release. Live acceptance remains deferred until all bundles are implemented.
