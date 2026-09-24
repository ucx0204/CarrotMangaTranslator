# Bundle 10 continuation: exact work recovery capacity

Status: IMPLEMENTED AND CONNECTED; ALL 26 GATES AND EXACT-CAPACITY ELECTRON PASSED.
Verified source/tests/configuration: `37fd63313c818bbe5f51d711f7865a63c4dc8d25`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting user-facing checkpoint: `b508a40c`. Bundle 10 remains IN PROGRESS.
Page deletion/recovery and generic incoming/native working-file input remain.
Do not start bundle 11. Live acceptance remains deferred.

## Resumed state and reproduced failure

The interrupted continuation had already saved the journal-owned capacity fix and
its tests through `2c878747`; its checkpoint followed at `81ecfd3d`. These changes
were preserved, not reimplemented. The prior complete run passed its tests but
failed two inherited per-file coverage floors after shared capture/filter code was
removed. This resume added two actual-publication regressions, then completed the
whole-repository and dedicated native runs at the same source.

The original `mcpWorkDeletionStaging.test.ts` reproduced the 2,000-entry rejection
before the capacity source changes. Evidence: `.tmp/mcp-work-capacity-baseline.log`.
The source was within its limit, but restoration introduced a native transaction
owner marker. Previously the work verifier counted that marker before filtering it.
The failing regression remains an ordinary passing test; it was not removed,
skipped, marked expected-failure or given a longer test deadline.

## Connected fix and preserved ownership

`createPublishedDirectory` returns a native-only `verifyOwnership` handle bound to
its real transaction state, journal ID, publication target and staging location.
It reuses the publisher's existing path and owner-marker validation. Sealing,
publication, recovery and cleanup still perform their original checks. No remote
request accepts that handle, a native callback, arbitrary pathname or skip flag.

`captureStagedDeletionTree` obtains this verified identity and checks it again after
capture. Only the exact verified root marker is accounted for separately from source
content. Path validation still precedes the marker decision, and ordinary capture
retains the original 2,000-entry/256-MiB/128-MiB-per-file checks. Extra user entries or
bytes are not excluded. Work restoration retains both immediate and before-publish
content comparisons. Existing chapter movement used the same capture/filter pattern
and now consumes the same staging contract rather than duplicating the fix.

Ordinary source or retained inventories with a root owner-marker name, including a
case alias or directory, are rejected before removal. Such source data is never
silently dropped or overwritten. Nested files with that name remain ordinary data.
Missing, foreign, altered, stale or wrong-location staging ownership is rejected.
This is not a lower-admission workaround or an increase in user-data quotas.

## Boundary and publication verification

Both the exact 2,000-entry and exact 256-MiB tests pass. The 2,001st source entry and
one additional source byte still fail. A native transaction creates the actual root
marker; the test does not fabricate a marker as authority. The byte test uses real
zero-filled filesystem files without allocating a 256-MiB JavaScript buffer. It
checks native staging/publication and subsequent source capture, not a full
256-MiB encrypted public work-deletion trial.

Fixture setup/cleanup use ordinary Vitest lifecycle hooks. Source, staging,
before-publication and after-publication equality assertions remain. Existing
15-second test deadlines and runner defaults are unchanged.

Ownership tests preserve reserved-root source files/directories, retain nested
marker-named data, reject changed identity/target/extra fields or missing markers,
reject stale/wrong-location handles, and detect changes after the first successful
ownership check. Existing transaction path/crash tests are in the complete run.

Two additional tests use the real registered tools and native publication:

- A real staged chapter file is changed at the encryption boundary after Undo
  preparation. Publication rejects the changed inventory; the moved chapter,
  original recovery record and all later retry/restoration behavior remain intact.
- The encrypted retained index names an operation inconsistent with its work
  recovery record. Inspection, Undo and disposal reject it without modifying either
  record or restoring the work. Restoring only the fixture's original index makes
  the existing recovery usable again after client reconstruction.

Internal hashing, staging, ownership and transaction functions are not mocked.
Faults are injected at the existing encryption/filesystem fixture boundaries.
These regressions cover existing defensive branches; no additional production
behavior change was needed in this resume.

## Final whole-repository verification

All **26 gates passed with actual process exit code 0** at the verified source:
**8,455 tests passed, zero failures, 11 inherited skips**. The MCP subset passed
**1,607 cases across 288 files**. Work-deletion and recovery-staging tests passed
**46 cases across 12 files**. These counts overlap; do not add them together.

Renderer/Electron/JavaScript types, formatting, lint, error handling, test boundaries,
architecture/maintainability, duplicate/dead-code checks, exact coverage inventory
and floors, Windows build, artwork parity, image protocol and renderer/preload gates
all passed in the same sequence. Supported process-local eight-worker execution was
used. No default, timeout, inherited skip, global threshold or exclusion was relaxed.
Gate interval: `2026-09-21T14:19:52.906Z` through `2026-09-21T14:25:04.556Z`.

The full coverage-floor manifest is byte-identical to `b508a40c`: all **1,772 records**,
provenance and deletion entries remain unchanged. No new production module is added.
The movement file now measures 100% in all four metrics. The work repository measures
98.07% lines, 98.14% statements, 100% functions and 95.65% branches, above the unchanged
floors. Only the previously recorded native transaction consumer count, 28 to 29,
changed; no global architecture ceiling changed.

The earlier whole-run coverage failure at `2c878747` is separately preserved under
`.tmp/mcp-work-capacity-prior-2c878747-*`. The 74-case focused diagnostic run passed
all test assertions, but its partial-source coverage command exited 1 against the
whole-repository thresholds; it is not a whole-gate pass. The two added cases then
passed focused tests/types/lint before the successful complete run above.

## Dedicated actual-Electron maximum-capacity result

The maximum-capacity fixture is actually called by the existing work-deletion native
scenario. It fills ONLY the smoke-owned two-chapter work to exactly **2,000 files and
directories combined**, using known empty directories for the remaining entries.
The original public-tool deletion/Undo/Redo/replay/protected-disposal scenario runs
with actual native storage, transaction publication and operating-system encryption.

MCP clients are reconstructed between recovery steps. Original tree digests and
library order are checked after restoration. Known empty fixture directories are
removed individually ONLY after exact restoration. Ordinary source files remain.
The complete native runner then performs its existing isolated-profile cleanup.

All **ten required completion markers** were present, the actual Electron child
exit was **0**, and its isolated listener on **61238** was closed. The native run
used the SAME verified source as all 26 gates and included the existing import,
deduplication, organization, page-order, chapter-deletion and movement regressions.

File selection, browser responses and renderer-state replies are fixture boundaries.
This is not a restart of the user's live app, a live model/website test, ChatGPT file
transfer or `망번테스트` acceptance. No renderer production layout changed and no new
screenshot result is claimed.

## Preserved public contracts and next work

No new MCP tool or output field was added by this fix. The seven work-removal tools
remain connected; the output inventory remains **198**. Limits remain one work,
ten chapters and fifty pages TOTAL, 2,000 entries, 128 MiB per file and 256 MiB source.
Recovery retains the same profile/approved owner, seven days, shared 256-record/1-GiB
catalog and 32 recovery actions. It is not permanent trash. Expiry may remove a
removed work's recovery; a restored ordinary work does not expire with the record.

Evidence: `.tmp/mcp-work-capacity-{source,check-result,final-evidence}.json`,
`full-check.log`, `final-{vitest,coverage,timings}.json`, `native.log`,
`native-result.json`, baseline/ownership/boundary logs and resume publication logs.
All **11 changed source/test/configuration hashes** matched after verification.
Final documentation-only commits must remain identical for `src`, `tests`, `scripts`.

Next: bundle 10 page deletion/recovery, then generic incoming file bytes and native
working-file input. Do not repeat completed work/chapter deletion, movement,
imports/source history, naming/orders or editor synchronization. Do not start 11.
The live app, user library/artwork, credentials, approved models, Tailscale and OS
security settings were not modified or restarted. No new branch, master merge or
release. Integrated live acceptance stays deferred until implementation is complete.
