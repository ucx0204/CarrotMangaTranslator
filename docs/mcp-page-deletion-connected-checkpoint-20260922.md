# Bundle 10 continuation: connected page deletion and recovery

Latest continuation: `mcp-incoming-files-checkpoint-20260922.md`. Incoming-byte
transfer and native preview handoff are connected; tests/build/native passed at
`b583c804`, but four architecture integration exceptions remain. Native working-file
input is still pending. The verified page-deletion history below is unchanged.

Status: IMPLEMENTED AND CONNECTED; ALL 26 GATES AND DEDICATED ELECTRON PASSED.
Verified source/tests/configuration: `8252872cd706adbb1fb9dadd3670c40488d0c003`.
Starting completed slice: `0e991f77`. Interrupted page work through `5dcac756` was
preserved, including the locally uncommitted formatting already present upstream.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Bundle 10 remains IN PROGRESS: generic incoming bytes and native working-file input
remain. Do not start bundle 11. Live acceptance stays deferred.

## Registered public behavior

Seven tools are connected to the actual organization session, approved-connection
lifetime, native editor ports and strict input/output schemas. The output inventory
is **205 (198 + 7)**:

- `carrot_preview_page_deletion`
- `carrot_delete_page`
- `carrot_get_page_deletion`
- `carrot_list_page_deletions`
- `carrot_undo_page_deletion`
- `carrot_redo_page_deletion`
- `carrot_discard_page_deletion`

Read-only review/list/inspection require read scope. Mutation requires existing
read+edit+process scopes and editing/processing enabled in the app. No image-transfer
permission is implied. Deletion takes work/chapter/page IDs, the reviewed snapshot,
a new request ID and `confirm: delete-page-with-seven-day-recovery`. Recovery takes
the current inspection snapshot, a new request ID and confirm=true. No native paths,
raw records, callbacks or authority flags are accepted as public inputs.

Preview returns names, page/file/directory/byte totals and memory reconciliation
counts. It does not return private story text, paths, artwork or serialized archives.
It reads/hashes local files but does not save, render, fetch a website or run models.

## Native deletion, memory and exact recovery

The native page planner and transaction are shared with desktop deletion. Only
selected native-owned assets are retired; shared sibling originals and unrelated
run payloads remain. External original source files and linked mirror folders are
not changed. Last-page removal leaves an empty chapter and work. Import-source
history remains the historical input record, not proof of current page membership.

Memory is reconciled using existing policy, not regenerated: deleted-page rows are
removed, surviving page names/positions are reconciled, and existing duplicate/orphan
handling still applies. The exact prior memory, including manual content and any
previous duplicate/orphan rows, is retained for Undo. Originally absent memory stays
absent; a later newly created empty memory file is a change, not an absent file.
No OCR, translation, new summary or automatic resumption of previous jobs occurs.

The WHOLE bounded original chapter inventory is encrypted with the existing chunk
codec and decoded/digest-verified before removal. Page retirement, native metadata,
reconciled memory, recovery archive and catalog publish in one existing transaction.
Undo stages only missing page-owned directories and changed files into the same
replace-file journal; the surviving chapter is never replaced wholesale.

Recorded chapter JSON bytes, memory bytes/presence, original assets and empty
directories are restored. Work metadata values/timestamps are restored through native
JSON serialization; original work.json whitespace is not promised. Filesystem ACLs,
inodes and filesystem creation times are not an exact-restoration contract.

The entire target chapter must be closed even if clean, using the trusted editor
probe. Missing probes fail closed. Existing linked-workspace records, including
disabled links, must be explicitly detached first. Existing activity/ownership locks
are reused. Later chapter/work changes or occupied original locations reject recovery
rather than overwriting later data. Inspection is advisory and publication rechecks
state, ownership, source bytes, record identity and expiry.

Historical requests return prior receipts. A repeated original delete after Undo
does not delete again. Recovery history is not an unbounded queue. Still-deleted page
archives cannot be discarded early through dedicated or generic disposal. Dedicated
disposal requires verified exact restoration and never removes the restored page.
Seven-day expiry may still permanently prune a deleted page's recovery.

## Reproduced bugs and regression coverage

The interrupted native characterization found that deleting a page also deleted an
original still used by its sibling. The shared planner now retains sibling-owned
paths. Tests exercise both desktop deletion and registered MCP recovery with actual
shared source bytes. Baseline/fixed evidence uses
`.tmp/mcp-page-deletion-native-{baseline,fixed}.log`.

Windows case aliases are bound to the actual captured filenames so retirement and
recovery describe the same files. A native reserved owner-marker name inside a
page-artifact subtree is rejected BEFORE deletion, not silently dropped during Undo.
Original path reproduction/fix evidence uses `.tmp/mcp-page-deletion-path-*.log`.

During this resume, a valid encrypted recovery history was replaced between initial
read verification and mutation admission. Disposal incorrectly succeeded. The new
full current-record comparison rejects it with revision_conflict and preserves the
later recovery history. Replacing only the fixture's original record permits normal
disposal after reconstruction. Baseline: `.tmp/mcp-page-deletion-admission-baseline.log`.
The regression remains an ordinary passing test, not removed or expected-failure.

Action lifetime and current-record comparison are shared deletion invariants rather
than copied work/page branches. Domain-specific schema/owner/archive verification
remains in each repository. Parsed work/page recovery uses the existing guarded
journal writer; no second store, codec, filesystem transaction engine or GPU queue.
The duplicate baseline remains 32 known clones with zero new clones. Only measured
direct dependencies were recorded; the native mutation import ceiling was tightened
from 14 to 13. Global architecture and test thresholds remain unchanged.

Tests include absent/last page, exact memory and binary bytes, shared sources, other
owners, request signatures, stale snapshots, open/missing probes, disabled links,
concurrent work activity, occupied paths, later sibling/memory/work edits, archive
and catalog mismatch, and protected disposal. Injected late encryption, revocation,
expiry, session stop, editor reopening and source edits preserve originals. Corrupt
restored artifacts and failed action-record publication leave Undo unpublished and
recovery usable. Existing journal interruption/recovery tests remain enabled; these
are deterministic crash injections, not arbitrary OS process-kill experiments.

## Final complete verification

All **26 repository gates passed with actual process exit code 0** at the verified
source: **8,497 passed, zero failures, 11 inherited skips** (8,508 total).
MCP tests: **1,643 passed across 297 files**.
Page-deletion tests: **36 passed across nine files**.
The focused run adds the existing three native desktop compatibility cases and three
byte-journal cases: **42 passed across 11 files**. These counts overlap.

Renderer/Electron/JavaScript types, formatting, lint, error handling, mock boundaries,
architecture/maintainability, duplicates, re-exports/generated/CSS/script checks,
dead-code checks, exact coverage inventory/floors, Windows build, artwork parity,
image protocol and renderer/preload boundaries passed in the SAME sequence.
Gate interval: `2026-09-21T16:23:25.694Z` through `2026-09-21T16:28:25.178Z`.
The supported process-local eight-worker setting was used; runner defaults, original
skips, deadlines and global thresholds were not relaxed.

All **1,772 inherited coverage records**, provenance and deletion entries remain
unchanged. Nine modules were added using actual Windows/V8 measurements, bringing
the inventory to **1,781 (756 historical + 1,025 introduced)**. No inherited floor
was lowered. Measurement source: `243885c77a257dc43c6d16760f5f37612c532fbf`.
Its whole test run passed 8,496 and failed ONLY the then-unregistered new-module
inventory; that failure is separately preserved, not described as a full pass.
A first quoted-wildcard focused command selected only other test files; its 17 passes
are not counted as page coverage. The corrected prefix run selected actual page tests.

## Dedicated actual-Electron result

The NEW page-deletion scenario is actually invoked by the existing organization
smoke. It uses only the enclosing fixture's imported single-page chapter. It tests
both originally absent memory and fixture-created manual memory: reviewed last-page
removal, real native storage/OS-encrypted archive, MCP client reconstruction,
Undo/Redo, historical action/deletion replay, protected disposal and exact restoration.
The empty chapter remains; original content and memory presence are checked. The
one fixture-created memory file is removed only after verified exact restoration.

All **11 required completion markers** were present, the actual Electron child exit
was **0**, and its isolated listener **59211** was closed. The SAME verified source
also passed existing import/deduplication/organization/page-order/chapter-deletion/
movement/work-deletion and exact-2,000-entry work-recovery native regressions.

Native storage, transaction publication, image validation and OS encryption are real.
File selection, browser collection and editor-state replies are fixture boundaries.
This is not a restart of the user's live app, real-manuscript/model/website quality
validation, ChatGPT attachment transfer or `망번테스트` acceptance. No production
renderer layout changed and no new screenshot result is claimed.

## Limits, evidence and next work

One selected page in a chapter of at most 50 pages; the WHOLE archived chapter must
fit 2,000 entries, 128 MiB/file and 256 MiB total. Same-profile/approved-owner seven-day
recovery, shared 256-record/1-GiB catalog and at most 32 recovery actions remain.
Not permanent trash. Expiry of an archive does not remove an ordinary restored page.
Ordinary desktop deletion does not automatically create MCP recovery records.

Evidence uses `.tmp/mcp-page-deletion-`: final-source/result/evidence.json,
final-check.log, final-vitest/coverage/timings.json, final-native.log/native-result.json,
coverage-registration.json and measurement artifacts. Reproduction and focused logs
are preserved separately. All **38 changed source/test/configuration hashes** matched
after complete/native verification. Final documentation-only commits must remain
identical to the verified source for `src`, `tests`, `scripts`.

Next: generic incoming attachment bytes and native working-file import within bundle 10. Do not redo completed page/work/chapter deletion, movement, imports/source matching,
naming/orders or synchronization. Do not start bundle 11. User app/library/artwork,
authentication, approved models, Tailscale and OS security settings were not modified
or restarted. No new branch, master merge or release. Live acceptance remains deferred.
