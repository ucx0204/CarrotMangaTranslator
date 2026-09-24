# Bundle 10 continuation: reviewed whole-work deletion

Current result: the capacity defect is resolved and all 26 gates plus exact-capacity
Electron passed at `37fd6331`. Read `mcp-work-capacity-checkpoint-20260921.md` for
current implementation, 8,455 passing tests and the remaining bundle-10 work.
The earlier failed result and reproduction below remain as historical evidence.

Historical status at the examined source below: CONNECTED; ORDINARY PATHS VERIFIED;
CAPACITY REGRESSION BLOCKED COMPLETION.
Examined source/tests/configuration: `98ef11a447b57507c99006582ccff44c81b93975`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting verified checkpoint: `f23d8300`. Bundle 10 is NOT complete.
Do not treat this work-deletion slice as ready for real-library deletion.

## Registered implementation

Seven independent tools are connected to the real app composition, existing
permissions, lifetime and output contracts. Output inventory is 198 (191 + 7):

- `carrot_preview_work_deletion`
- `carrot_delete_work`
- `carrot_get_work_deletion`
- `carrot_list_work_deletions`
- `carrot_undo_work_deletion`
- `carrot_redo_work_deletion`
- `carrot_discard_work_deletion`

Read-only review/list/inspection remain separate from read+edit+process mutation
scopes. No image-transfer permission is implied. The request contains a work ID,
review snapshot, new request ID and explicit `delete-work-with-seven-day-recovery`
acknowledgement, not native filesystem paths or stored objects.

The existing desktop work-deletion preparation/staging is shared after two original
native behavior tests passed. This is one work transaction, not repeated chapter
removal. It does not change ordinary desktop deletion into automatic MCP recovery.

The work directory, INCLUDING its library originals, chapters, context, memory and
run files, is retired only with a decoded/digest-verified encrypted recovery copy.
Source retirement, original library index, encrypted archive/record and retained
index publish through the SAME existing native transaction. External source files
and linked mirror folders are not changed. No OCR, translation, model or network
operation is introduced.

Preview returns included chapters and file/page/byte totals, not paths, raw memory
or image bytes. Every chapter must be closed using the trusted nonce-correlated
editor probe; missing probes fail closed. Linked workspaces must be explicitly
detached, including disabled records. Existing library/context/content ownership
is respected; no alternate store, encryption implementation or GPU queue is added.

The existing encrypted chunk verifier now supports a named work.json root while
legacy chapter/movement calls default to chapter.json. One verified byte-stream
implementation supplies both restoration and bounded native JSON decoding. Archived
work/chapter identities and summaries are recomputed from the actual decoded files,
not trusted merely because the record was successfully encrypted.

Undo/Redo restores recorded directory bytes, empty directories, original JSON
metadata and the original library work order. It does not promise filesystem ACL,
inode or filesystem creation-time restoration. Later index/order changes, occupied
paths or reused chapter identities prevent forced restoration. Native metadata
notifications are emitted only after new committed changes; failure leaves the
saved receipt intact. Historical requests never repeat deletion after Undo.

Unrestored recovery cannot be discarded early through dedicated or generic disposal.
Dedicated disposal requires exact prior restoration and preserves the ordinary work.
Seven-day expiry may still permanently prune recovery. This is NOT permanent trash.

## Reproduced and fixed identity bug

After deleting a work, another remaining work can acquire one of the removed chapter
IDs without changing the top-level work order. The initial restoration snapshot
missed that situation and created a duplicate global chapter identity. A real-library
regression first reproduced successful Undo instead of rejection.

Mutation and recovery inspection now check the recorded chapter IDs against other
native work catalogs under the existing library boundary. They reject the conflict
and preserve the later work rather than duplicating IDs. The original failing
reproduction is `.tmp/mcp-work-deletion-identity-repro.log`; the fixed case passes in
focused and final complete runs.

## Unresolved restoration-capacity boundary

`tests/mcpWorkDeletionStaging.test.ts` remains a FAILING regression, not skipped,
marked expected-failure, or removed. A source inventory of exactly 2,000 entries is
accepted by the shared capture limit. Native restoration adds its root ownership
marker; the current restoration verifier captures the directory BEFORE filtering
that marker for comparison. The capture therefore rejects 2,001 entries.

The regression builds real bounded filesystem entries and reproduces the actual
capture/compare sequence. It does not delete a real user's work or claim a complete
2,000-entry public-client deletion trial. Ordinary smaller-fixture success below
must not be used as proof that this maximum boundary is resolved. Byte-limit staging
headroom and reserved-root filename handling also require review with this fix.

A proposed change to handle owned staging metadata was rejected by the tool safety
check before execution. A separate stricter-source-admission proposal was also
rejected before execution. Neither runtime change was applied. A partially posted
1,999-entry/255-MiB OUTPUT-only contract was reverted because the matching admission
checks were absent; those lower limits are NOT implemented. Both rejected temporary
script paths were confirmed absent. Existing marker/capture security checks remain.

The regression was adjusted to use the existing THREE-argument production signature
instead of an unimplemented fourth argument. It still fails on the real 2,000-entry
limit; no TypeScript error or weakened assertion is being used to disguise the bug.

Next fix must make public admission and actual staged restoration agree, preserve
ownership verification and source safety, and prove exact boundary behavior. Do not
remove this test to obtain a green run. Do not deploy this slice for real deletion
before that is fixed and the full suite passes.

## Final verification at the examined source

The final complete test run is NOT successful: **8,442 tests passed, ONE failed,
11 inherited skips**. The single failure is the capacity regression above. The MCP
subset has **1,594 passed, one failed across 285 files**. The nine work-deletion
files have **33 passed, one failed**. Two additional native desktop characterization
cases pass. Thirty-five new cases pass, and the remaining new boundary case fails.

All nineteen preceding repository gates passed, including renderer/Electron/JavaScript
types, formatting, lint, error handling, mock boundaries, architecture, maintainability,
duplicates, re-exports/generated/CSS/script rules, dead-code checks and native test
preparation. The twenty-six-gate runner stops at the failed test-coverage stage;
its subsequent gates were NOT completed in that sequence.

The exact coverage-floor gate was then run separately and passed. Windows application
build was also run separately and passed with actual exit zero. This does not turn
the failed complete run into a pass. The existing supported process-local eight-worker
option was used; defaults, deadlines, original skips and global thresholds are unchanged.
Final test interval: `2026-09-21T10:05:20.321Z` to `2026-09-21T10:10:35.540Z`.

All 1,764 inherited coverage records, provenance and deletion entries remain unchanged.
Eight measured modules were added: the seven work-removal modules plus the extracted
existing job-output contract. The exact inventory is **1,772 (756 historical and
1,016 introduced)**. The job receipt definition was compared exactly during extraction;
existing output fields and validation were not widened to fit the registry size limit.
Coverage measurement source: `ea70fbe1743eb944ef0e5c4696cd1ae1dd7b9dbd`.
The initial measured suite passed 8,441 and failed only the then-unregistered inventory;
that run is separately preserved and is not called a pass.

Focused runs passed 23 cases across four files and later 33 across eight (including
existing movement HTTP cases). Tests cover real OAuth scopes/revocation, actual native
storage, strict confirmation, empty/multiple chapters, arbitrary retained private
context, occupied paths, index changes, replay, expiry, missing probes and linked
workspaces. Existing movement HTTP assertions now reuse the same real HTTP fixture.

Injected late record encryption, valid encryption of wrong metadata, revoked grants,
expiry, session stop, editor reopening and source edits preserve the original work.
Staged restored-file corruption and failed Undo-record publication leave restoration
unpublished; the original recovery remains usable. Four existing native transaction
crash points were exercised. These are deterministic injected interruptions, not
arbitrary process-kill experiments. No claim is made that OS encryption naturally
produced the injected corrupt values.

## Dedicated actual-Electron ordinary-path result

The NEW whole-work deletion scenario passed at the SAME examined source together
with existing native regressions: **nine required completion markers, real child
exit 0, isolated listener port 59375 closed**.

A freshly imported two-chapter work and fixture-owned manual-memory file are reviewed,
removed with real native storage/profile encryption, and restored through reconstructed
MCP clients. Undo/Redo, historical request replay, protected disposal, exact work tree
and library order, and source preservation are checked. Only the fixture-created
memory file is removed after exact restoration. No user app or real library is used.

Native storage, transactions, image validation and OS encryption are actual app code.
Editor-state replies, file selection and browser collection are fixture boundaries.
This is not a user-app restart, live model/website test, ChatGPT attachment test or
`망번테스트` acceptance. The successful ordinary scenario does NOT cover or fix the
maximum-capacity case. No renderer production layout changed; no new screenshot claim.

## Evidence and exact resume point

Evidence uses the `.tmp/mcp-work-deletion-` prefix: source.json, final-evidence.json,
final-source/vitest/coverage/timings.json, full-check-final.log, build.log,
native.log/native-result.json, coverage-registration.json and measured artifacts.
The identity and staging reproductions and earlier failed static/measurement runs
remain separate. All 34 changed source/test/configuration hashes were revalidated.
Final documentation changes must compare identical for src/tests/scripts.

Current declared limits remain one work, ten chapters/fifty pages TOTAL, 2,000
filesystem entries, 128 MiB per file, 256 MiB source; the exact entry maximum is
known NOT to round-trip yet. Same-profile/owner seven-day, shared 256-record/1-GiB
catalog and 32 recovery actions remain. No lower-admission workaround is claimed.

Resume at the unresolved work-restoration capacity boundary, then rerun complete and
native checks. Page deletion/recovery and generic incoming attachment/native working-
file input remain after that. Do not repeat completed chapter deletion/movement,
imports/deduplication, naming/order or synchronization. Do not start bundle 11.
User app/library/artwork, authentication, models, Tailscale and OS settings were not
modified or restarted. No extra branch, master merge or release. Live tests remain
deferred until all implementation bundles are ready.
