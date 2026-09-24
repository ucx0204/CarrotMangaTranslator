# Bundle 10 continuation: reviewed cross-work chapter movement

Latest completion: `mcp-chapter-move-connected-checkpoint-20260921.md`. All 26
repository gates and the now-connected actual-Electron movement scenario passed
at `8e5fe8c9`; 8,407 tests, zero failures, 11 inherited skips. This earlier
implementation checkpoint below is retained as historical context.

Status: IMPLEMENTED AND CONNECTED; final whole-repository and native checks pending.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting verified checkpoint: `3aaed10f` (chapter deletion already completed).
Bundle 10 remains in progress; no bundle 11 work is included.

## Connected behavior

Six tools independently review, move, list, inspect, Undo and Redo a chapter between
two existing works. The chapter ID, page IDs, source artwork, masks, block data,
import provenance and supported memory remain. Both source and destination orders,
verified source backup, changed directory and encrypted recovery publish in the
existing native transaction. The empty source work is retained. Destination chapter
name uniqueness follows the existing native naming policy; insertion is before a
specified destination chapter or at its end. No image recompression or model calls.

The preview exposes actual resulting names/order, file totals, memory presence,
reference issues and checkpoint invalidation. It never sends local paths, images,
summary text or raw stored records. Its snapshot binds both works, raw guide hashes
and absence, sibling titles, exact source tree and current location. The apply call
requires that snapshot, plan fingerprint, new request ID and explicit confirmation.
The existing read/edit/process scopes, lifetime cancellation, activity gate and
closed-editor probe are reused, not relaxed. Both works receive existing typed
metadata notifications only after commit; notification failure preserves the receipt.

Moving is NOT a glossary/character merge. Unmapped referenced IDs need an identical
substantive definition at the destination; otherwise review is ineligible. Explicit
source-to-destination mappings can resolve missing/different references without
changing either catalog. Both block references and all supported memory rows are
mapped, including orphan rows. Summaries and manual scene descriptions are not
regenerated. Destination rules and reading direction apply to future operations.

Translation-checkpoint and font-continuity pointers are invalidated using the
existing native artifact-stripping policy. Underlying run files remain copied and
backed up; original pointers and exact original metadata are restored by Undo.
Earlier jobs, proposals, outputs and recovery records remain bound to the original
work. They are not transferred, automatically resumed or reauthorized.

A chapter with any linked-workspace record is rejected until explicitly detached
using the existing app; movement does not modify external mirror directories or
silently change their ownership. The chapter must be closed even when clean.
Missing works, occupied destination/original directories and later edits reject
mutation/recovery rather than recreating or forcibly overwriting user data.

The original chapter tree is retained through the existing chunked profile codec;
only its decoder parameter type was narrowed to the fields it actually consumes.
Its path, size, symlink, chunk, digest and re-read checks are unchanged. Undo restores
original raw bytes. Redo uses the same record. Request replay remains historical
after Undo. Generic retained-record disposal removes only this recovery archive,
never the ordinary moved/restored chapter. Expiry has the same distinction.

## Verification in progress

Initial connected real-library tests passed three cases (movement/restart/replay,
manual memory, stale state and ownership). Expanded tests cover explicit references,
late publication failure, corrupt archive and metadata, actual OAuth/HTTP, linked
workspace holds, concurrent activities and simulated transaction interruption.
The initial expanded run passed 22 and failed one invalid datetime in the fixture;
production datetime validation remains unchanged. Final results must replace this
section only after actual verification.

Snapshot capture and move planning are separate native responsibilities; each new
module stays inside the default import budget. Measured additional direct consumers
reuse existing authorities: activity 33->34, logger 44->45, app paths 28->29,
library lock 40->41, fingerprint 97->104, edit errors 166->171, library paths 25->26,
native library files 37->40, transactions 26->27 and batch-tool factory 31->32.
The output registry directly composes one additional contract (33->34 imports).
These are explicit composition/authority-consumer counts, not global ceiling
changes, forwarding wrappers or copied algorithms. Existing coverage floors,
provenance, skips, timeouts and global test configuration are preserved.

## Limits and remaining work

One chapter, at most 50 pages, 2,000 file/directory entries, 128 MiB per source file,
256 MiB source tree. Each work has at most 2,000 chapters and mappings at most 2,000
unique source references. Existing seven-day/256-record/1-GiB shared retention and
32-action recovery limits apply. Ordinary moved chapters do not expire.

Work/page deletion and recovery, general incoming file bytes and native working-file
input remain separate bundle 10 work. Do not redo imports, discovery, duplicate
checks, names/orders, metadata synchronization or completed chapter deletion.
All tests use isolated profiles. The user's app, real library, credentials, model
assets, Tailscale and OS settings are not changed or restarted. Live acceptance is
deferred until all implementation bundles are complete. No branch, merge or release.
