# Bundle 10 continuation: verified cross-work chapter movement

Status: IMPLEMENTED AND CONNECTED; ALL 26 REPOSITORY GATES AND DEDICATED ELECTRON PASSED.
Verified source/tests/configuration: `8e5fe8c9491e47469928c8da85b7894547f0fe65`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Bundle 10 remains IN PROGRESS. Work/page deletion and general incoming file/working-file
input are NOT implemented by this slice. Do not start bundle 11.

## Actual resumed state

The previous user-facing checkpoint was page ordering at `e1a57949`, but the actual
repository had already completed chapter deletion at `3aaed10f` (verified source
`447c2e7e`) and contained an interrupted chapter-movement implementation. Read
`mcp-chapter-deletion-connected-checkpoint-20260921.md` for that completed scope.
It was not rebuilt or discarded.

The worktree was in a rebase with one test conflict: invalid `before-move` versus
an ISO datetime in a font-continuity fixture. Only that conflict was resolved,
keeping the valid datetime and all production validation. Local implementation and
remote changes were integrated without force-push, branch creation or master merge.
The originally unconnected native draft had been deleted. This continuation adds
and actually connects a separately verified movement scenario.

## Registered independent tools

Six tools are connected to actual desktop composition, permission enforcement and
strict input/output contracts; output inventory is **191 (185 + 6)**:

- `carrot_preview_chapter_move`
- `carrot_move_chapter`
- `carrot_get_chapter_move`
- `carrot_list_chapter_moves`
- `carrot_undo_chapter_move`
- `carrot_redo_chapter_move`

Review/inspection/list use the existing read scope. Movement/recovery require the
existing read, edit and process scopes; image-transfer permission is not implied.
The public request names two existing works, one chapter and optionally a destination
insertion anchor and explicit glossary/character mappings. It never accepts arbitrary
filesystem paths, serialized native records or authority-changing callbacks.
Publication requires the reviewed snapshot, plan fingerprint, new request ID and
`confirm: move-chapter-between-existing-works`.

## What movement changes and preserves

The chapter is moved, not duplicated, between two distinct existing works. The
chapter/page IDs, original images, masks, saved blocks, source-import history and
supported memory are preserved. Destination naming uses the existing unique-name
policy. Placement is before the selected destination chapter or at the end. The
source work remains even when its last chapter moves. No image recompression,
OCR, translation, research, network or model execution is introduced.

Preview reports actual resulting title/orders, file/page/byte counts, memory
presence, reference issues and checkpoint invalidation. It reads and hashes local
source files but does not transmit their bytes or return paths, raw memory summaries
or native records. The snapshot binds both works, source tree/location, guide-file
presence and hashes, sibling titles and reviewed intent.

Moving is NOT a catalog merge. Unmapped referenced IDs need identical substantive
definitions in the destination, ignoring catalog timestamps. Missing/different
references make the plan ineligible. Explicit mappings target existing destination
IDs and update both blocks and supported memory rows, including orphan memory.
Neither work's glossary/character catalog is overwritten. Existing summary text
and manual scene descriptions are preserved, not regenerated. Destination rules
and reading direction govern future processing.

Internal translation-checkpoint and font-continuity pointers are invalidated using
the existing native artifact policy. Their underlying run files remain in the
copied chapter and verified backup. Undo restores the original metadata/pointers.
Earlier jobs, proposals, outputs and histories stay bound to their original work;
movement does not transfer approval or silently resume those operations.

A linked-workspace record blocks movement even when disabled; detach it explicitly
through the existing app first. External mirror directories are never retargeted.
The chapter must be closed, even if clean. Fresh trusted editor probes, lifetime
cancellation and both works' structure/context/content ownership remain enforced.
Missing works, occupied paths and later edits prevent forced publication/recovery.

## Atomic publication and exact recovery

The existing profile codec retains the source directory as encrypted chunks and
verifies decoded bytes/digests. Backup, recovery record/index, source retirement,
destination directory and both work orders publish in ONE existing library
transaction. Written recovery metadata, encrypted parts and current source/destination
state are rechecked before commit. Failure before commit rolls the group back.

Undo/Redo restores exact recorded directory file contents and work metadata, including
original memory bytes and timestamps. It does not promise filesystem inode/ACL or
creation-time restoration. Replayed requests return historical receipts, even when
the original movement request is repeated after Undo. No duplicate move is performed.

Existing typed metadata notifications are sent for both works after commit. A
notification error adds `notification_failed_after_commit` without undoing the saved
result or rerunning the operation. Generic retained-record disposal removes only
the movement recovery archive; the ordinary moved/restored chapter remains.
This differs from the protected disposal policy for an unrestored chapter DELETION.

## Additional verification and fixes in this continuation

The interrupted coordination test accidentally called a deletion fixture's `command`
instead of the inherited import command. The fixture now explicitly exposes
`importCommand`, and the actual linked-workspace test executes its intended native
import. Missing image-path assumptions were made explicit instead of non-null
assertions. An unused export of the internal intent schema was removed; public
validation is unchanged. Exact registered-tool counts remain checked.

Two added real-filesystem regressions verify that a destination guide created during
archive preparation prevents movement and remains intact, and that disposing a
movement archive while the chapter is still moved preserves its files/library state
across reconstruction. The first case succeeds only after a fresh review of the new
context. These are additional guards verified against actual publication, not claims
that a previously demonstrated production bug was fixed in those two cases.

## Final whole-repository result

At the verified source, **all 26 gates passed with actual process exit zero**:
**8,407 tests passed, zero failures, 11 inherited skips**. The MCP subset passed
**1,561 cases across 276 files**. The eight movement test files contain **30 passing
cases**. Earlier focused runs passed 37 cases across eight files and eight cases
across two files; these overlap the final complete suite.

Renderer/Electron/JavaScript types, formatting, lint, error handling, test boundaries,
architecture/maintainability, duplicate/dead-code checks, exact coverage inventory
and floors, Windows build, artwork parity, image protocol and renderer/preload gates
passed in one sequence. Supported process-local eight-worker execution was used;
no default, timeout, inherited skip, global threshold or test exclusion was relaxed.
Gate interval: `2026-09-21T08:25:02.710Z` through `2026-09-21T08:30:22.686Z`.

Initial static failures are preserved in resume-check-1/2 logs and resolved. The
first complete measurement passed 8,406 tests and failed only the unregistered new
source inventory; that failed run is not represented as a pass. Exactly ten new
modules were registered from that Windows V8 measurement at `d552aac5`.
Measurement SHA-256: `e70d436243e25e4c63f9dbf971eb05f1d2594fd7b6cdb5502719f2bc340f2517`.

All **1,754 inherited coverage records, provenance and deletion entries remain
unchanged** from `3aaed10f`. The exact inventory is now **1,764 records: 756 historical
and 1,008 introduced**. Existing floors were not lowered. Measured native authority
consumer counts documented in the earlier movement checkpoint were registered only
for those affected modules; global architecture ceilings are unchanged.

## Dedicated actual-Electron result

The NEW movement scenario and existing native regressions passed at the SAME verified
source. A freshly imported smoke-owned chapter moves to a new fixture destination;
manual story memory is preserved under the new work ID. Actual image validation,
files, transaction publication, profile encryption and registered tool contracts run.

MCP clients are reconstructed between inspection/Undo/Redo; repeated move/recovery
requests remain historical. Original tree digests, metadata and memory are restored,
then archive disposal leaves ordinary data intact. Only fixture-owned temporary
memory and an empty destination are removed, after exact restoration, without
recursive cleanup. Native editor nonce validation executes with synthetic renderer
replies; file selection/browser responses in the enclosing importer are fixtures.

All **eight required completion markers** were present; actual Electron child exit
was **0**, and the isolated listener on **56073** closed. This is not a restart of the
user's running app, live model quality, a live website or public MCP-client acceptance.
No renderer production/layout was changed and no new screenshot result is claimed.

## Evidence and next work

Evidence is under `.tmp/mcp-chapter-move-resume-*`: final-check.log,
final-evidence.json, final-source.json, final-vitest.json, final-coverage.json,
final-timings.json, coverage-registration.json, measured source/coverage/test/timing
files, native.log/native-result.json and build.log. Failed initial runs remain
separate. All **31 changed source/test/configuration hashes** matched after checks.
Final documentation must remain identical for `src`, `tests` and `scripts`.

Limits: one chapter, at most 50 pages, 2,000 filesystem entries, 128 MiB per source
file and 256 MiB source tree. Each work has at most 2,000 chapters and mappings at
most 2,000 distinct source references. Same-profile/approved-owner seven-day recovery,
256-record/1-GiB shared catalog and 32 recovery actions remain. Encryption overhead
counts toward quota. Ordinary moved chapters do not expire with recovery records.

Next: separately reviewed work/page deletion and recovery, then general incoming
file bytes and native working-file input. Do not recreate completed chapter deletion,
movement, imports/source history, names/orders or synchronization. Do not start
bundle 11. User app/library, artwork, credentials, approved models, Tailscale and OS
security settings were not changed or restarted. No new branch, master merge or
release. Live acceptance remains deferred until all implementation bundles are ready.
