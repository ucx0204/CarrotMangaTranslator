# MCP remaining implementation sequence — 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
Starting verified checkpoint: `fbfe656c`. Preserve existing user changes first.
User instruction: implement bundles 1–13 in order, commit/push small units, and
leave an exact resume point when interrupted. Live tests are deferred until ALL
bundles are implemented; do not ask for a live test between development units.
Automatic unit/integration, type, lint, architecture, coverage and build checks
remain enabled. Do not restart the live app, modify user artwork/credentials,
replace approved model assets, merge master or publish a release implicitly.

| Order | Remaining bundle                                                                     | Status                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | C23 independent analysis; selective font/source-size application and exact undo/redo | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 2     | Bubble layout, advanced typography, reusable rules/presets                           | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 3     | Region/multi-block OCR, selected translation, reviewed append and block references   | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 4     | Multi-block erasure, free/protected masks, localized correction/restoration          | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 5     | External image/mask upload, validation and layer incorporation                       | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 6     | Independent sound-effect preparation, text, generation and recovery                  | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 7     | Durable undo and retained output assets                                              | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 8     | Model-grouped sequential jobs, chapter batches and explicit resume                   | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 9     | Context merge/replacement, reference migration and multi-work research               | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 10    | File/web import and library organization                                             | Implemented; automatic checks passed; live deferred                                                                                                                                     |
| 11    | Extra export/exchange formats and attachment/delivery diagnostics                    | Source implemented; PASS — full regression and native exchange/delivery/saved-source/sync markers; real client receipt remains separate                                                 |
| 12    | Composite workflows and bounded automated review                                     | Source implemented; PASS — both native composite markers, seven-stage zero-model chain, explicit recovery and exact retained outputs; fixture host review does not assess model quality |
| 13    | Client compatibility, diagnostics, installation and UI/UX                            | Source implemented; PASS — complete canonical regression and six directly inspected production settings/diagnostics captures                                                            |

Live C23 quality, model cleanup, actual originals, PNG/ZIP attachment reception,
download byte/hash checks, restart/reconnection and end-to-end client acceptance
belong to the final integrated live-test queue, not intermediate completion claims.

## Current authority: bundles 11–13 source and integrated verification

The implementation sequence now includes all thirteen bundles on the existing
branch. Bundle 11 adds saved-source raster selection, native PSD/ZIP/working-file
output, reviewed UTF-8 text/context exchange, delivery evidence and approved output
synchronization. Bundle 12 composes the existing native operations with bounded
review, owned child receipts, explicit restart recovery and retained output reuse.
Bundle 13 adds independent public OAuth/unauthenticated-POST diagnostics, current
client guidance and production permission/diagnostic UI. See
`mcp-composite-workflows.md`, `mcp-testing.md` and `mcp-tailscale-testing.md`.

Final integrated acceptance: PASS — implementation, full regression, fresh build, isolated native and six directly inspected production UI captures; actual user-client acceptance remains separate.
Source publication, a focused test, a complete canonical check, isolated native
acceptance and the logged-in client's actual receipt are distinct evidence.

### Historical source-bound progress before final acceptance

- At `b84bea4c6206b12ad2a00a4fe9b510ece1b46aae`, all 26 canonical stages
  passed: 1,198 test files, 8,975 passing tests, zero failures and 11 inherited
  pending tests, followed by a successful build. All 4,560 source fingerprints
  were unchanged. Its later extended native run did not complete successfully;
  partial markers do not establish native acceptance for bundles 11–13.
- At `33469783740da4f5dfd6688979a6c8c1aed2b1ac`, the bundle-13 selection
  passed 90 tests in five files, including 43 diagnostic cases. The wider focused
  run had 740 passes and two failures in 140 files; it was not a successful full
  run. The two failures were composite context-output fixtures with an invalid
  saved background color.
- At `0bb9547bd6d3b30d88c771b48fabce6d6be3e24a`, the fixture correction
  passed the two affected files, nine tests and zero failures. All 4,675 source
  fingerprints were unchanged. This narrow result is not a complete V8,
  registration, canonical-build, native or UI result.

### Historical full V8 measurement before registration

The unselected V8 measurement at
`0bb9547bd6d3b30d88c771b48fabce6d6be3e24a` completed on 2026-09-23 at
20:44:57 UTC in 330.047 seconds: 1,229 files, 9,167 total tests, 9,155 passes,
**one failure** and 11 inherited pending tests. All 137 bundle-12 cases in 29
files and all 90 bundle-13 cases in five files passed; these are subsets of the
full count. All 4,675 source fingerprints were unchanged.

The failed `productionCleanupCoverageGate` inventory assertion compared 763
registered existing files with 765 in the native inventory. Exit code was 1.
This is an actual coverage measurement, not a successful canonical check or build.
Its coverage SHA-256 is
`da61a9487b4e1a76b3470de5c6bdedf817f3b66830e04c8bc1eabbe3c277ca75`.
The artifact prefix is
`.tmp/mcp-finalfocused12-0bb9547b-full-20260923T203926682662Z`.

| Metric     | Covered / total  | Percentage |
| ---------- | ---------------- | ---------- |
| Lines      | 84,268 / 98,024  | 85.96%     |
| Statements | 89,954 / 106,151 | 84.74%     |
| Functions  | 23,867 / 27,404  | 87.09%     |
| Branches   | 57,386 / 73,851  | 77.70%     |

The subsequent native floor audit of that unchanged coverage artifact also found
**14 inherited metric regressions across seven source files** and 65 missing
measured rows. All 1,870 inherited rows were preserved; none of their floors was
lowered. The measured inventory is 765 existing, 1,170 introduced and 11 deleted
files. The failed Vitest inventory assertion and these additional metric shortfalls
are separate findings, so inventory registration alone is not evidence of recovery.

The source-bound architecture audit measured 2,500 modules and 11,802 dependency
edges with no layer/cycle errors. The registered numeric budgets had 22 measured
gaps. A reviewed candidate for those 22 budget metrics passed the existing budget checker against the same saved graph. That
candidate remained unpublished and was not canonical acceptance.

### Published regression tests at 24a8e9b5 (historical premeasurement checkpoint)

`24a8e9b54bbde14e27a446b6ce8d996b208ff77f` changes seven test files and adds
six cases covering the native behavior exposed by the audit. Production code,
coverage floors and checker thresholds were not changed. Actual repository
Prettier, lint and TypeScript passed (3,537 roots); the seven-suite focused run
passed 27/27 with all 4,675 source fingerprints unchanged. A new full V8
measurement was started at this source. At that checkpoint the 14 inherited
metric shortfalls had not been shown to recover by a new full coverage audit;
the narrow pass alone did not establish that result.

### Full remeasurements at 24a8e9b5 and 037fa1c4 (historical pre-registration results)

The 24a full V8 run completed at 21:07:40 UTC on 2026-09-23 in 324.641 seconds:
1,229 files, 9,173 total tests, 9,161 passes, one inventory assertion failure and
11 inherited pending tests. Its new composite subset passed 139/139 and bundle 13
passed 90/90; all 4,675 source fingerprints matched. Raw coverage SHA-256:
`87bc01a2b429577c288e36e51fde38d7054788bf5fd87bdb644d348967f30e86`.
The subsequent actual floor audit closed 11 of the earlier 14 metric gaps but
retained three in `mcpLibraryImportSession.ts` (lines, statements and branches).
All 1,870 prior rows remained unchanged; this was not complete gate acceptance.

`037fa1c4ecfcc5b8655d3cb1604af162c509f1d2` adds 28 lines to the existing
`tests/mcpLibraryImportSelection.test.ts`. The direct caller missing
`assertJobAuthorized` is rejected before a dialog, job admission or storage write.
The 21-file diagnostic passed all 97 test assertions and met the target module's
four inherited metric floors. Its filtered coverage process still exited 1, so
these target results are not a successful global coverage run. Production source
and thresholds were unchanged.

The unselected 037 V8 run then completed at 21:24:34 UTC in 323.813 seconds:
1,229 files, 9,174 total tests, 9,162 passes, **one inventory assertion failure**
and 11 inherited pending tests. All 139 new composite cases and 90 bundle-13 cases
passed, and all 4,675 source fingerprints were unchanged. The failure still compared
763 registered existing entries with 765 native entries; exit code was 1.
Its raw coverage SHA-256 is
`8dfa06f43290ec555ca0771b2e75f58a6dfed0dbdf61316b72dbf689cd3a45f9`,
with prefix `.tmp/mcp-finalv8-json-037fa1c4-full-20260923T211910136331Z`.

At that checkpoint, the 037 inherited-floor audit and the four registration files
were being assembled. Complete floor recovery was not inferred from the single
Vitest assertion failure. Canonical/build/native/UI acceptance remains governed
by the separate final evidence table. The saved architecture graph remains a
0bb measurement; identical production/collector input objects through 037 establish
continuity without relabeling it as a new graph collection.

### Completed registration at ecab24ad

The subsequent native audit of the 037 coverage artifact passed all inherited
floors by exact ratios: all 14 earlier metric gaps are closed. All 1,870 inherited
serialized rows, metadata and deletion records remain preserved. The registration
adds exactly 65 measured rows (two existing and 63 introduced); its inventory is
765 existing / 1,170 introduced / 11 deleted. No inherited floor or checker was
weakened. This audit does not change the earlier V8 process's exit code of 1.

`ecab24ade4b4a3ec7027a01100edd3f470031ed7` publishes the coverage manifest,
inventory assertion, 22 reviewed architecture ceilings and source-bound
[registration evidence](mcp-composite-gates-20260923.json). The saved graph is still
the actual 0bb measurement: 2,500 modules, 11,802 edges, zero layer/cycle errors.
The registered ceilings pass the unchanged budget checker against that graph.
Production and collector inputs remain identical through 037 and ecab; the
registration commit changes two scripts, one test and one evidence document.
This continuity is not a new dependency-graph collection.

| Published artifact    | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Coverage floors       | `17564062807477308e480a429cab2d9fff6d3f7f98b1f6e05b651f141e413df3` |
| Architecture budgets  | `a1caa9e7da3fbfa76829c5d32fbcc3be163fa1c6c80225f41cebd21c5f6ee1c2` |
| Registration evidence | `605f115e5f104190d3916d95acf01e41470076ebcda91747f9688eed8844c90f` |

The ecab canonical check and fresh build were started with prefix
`.tmp/mcp-bundle12-ecab24ad-20260923`. Their completion, isolated native acceptance
and six-capture UI review are still pending at this checkpoint. The final table
below will record completed integrated results separately from the registration
audit and preserved failed measurements.

Registration and all later canonical/build/native/UI outcomes must be recorded
separately below; the failed measurement is retained unchanged as history.

### Historical canonical check at ecab24ad

The `node scripts/check.cjs` run at
`ecab24ade4b4a3ec7027a01100edd3f470031ed7` passed all 26 stages with exit 0
in 368.304 seconds. V8 took 322.918 seconds: 1,229 physical files, 9,174 total
tests, 9,163 passes, zero failures and 11 inherited skipped assertions. The fresh
build passed in 14.475 seconds with `cacheHit:false`; Electron and renderer were
built, unchanged runtime assets reused, and the missing ONNX output built. The
canonical floor and architecture stages passed. All 4,675 source fingerprints
matched, and source/report digests, counts and the Vitest stage timestamp binding
were independently checked. This actual ecab coverage has the same raw SHA-256 as
the earlier 037 measurement; the registration assertion now passes.

Ecab coverage is lines 84,278/98,024 (85.97%), statements 89,964/106,151 (84.75%),
functions 23,871/27,404 (87.10%) and branches 57,410/73,851 (77.73%). The complete
26-stage timings, artifact hashes and report binding are preserved in
[final acceptance evidence](mcp-final-acceptance-20260923.json). Native and UI
were pending at this canonical checkpoint; the later native failure is recorded
below. Prior failed runs retain their original results.

### Historical ecab native failure and fixture correction

The native run using ecab's successful build completed on 2026-09-23 at
21:52:03 UTC with child exit 1: 16 of 23 required markers passed. Text/context
exchange, delivery, saved-source comparison, approved sync, both composite markers
and the final marker did not pass. The wrapper did not time out. All 4,675 source
fingerprints matched; the advertised listener closed, the owned Electron profile
was removed and no owned native directories remained. These cleanup results do
not change the failed acceptance result.

Inspection found a missing renderer-side acknowledgment in the isolated native
fixture: it creates a real `ActiveJobStore` without an editor, then invokes native
CSV import, which requests a page-edit handoff. The fixture supplied no responder,
so that handoff could not complete before the fixture's own cancellation. The
later upload-unavailable error arose during cleanup. This evidence identifies a
fixture omission; it does not establish a production deadlock.

The correction published at
`ddc43675872629560830b787d252dd6b0faed256` changes only three native fixture scripts. It responds
only to the newly imported fixture's chapter/pages, an active non-aborted
`mcp-edit` job in the `finishing-edits` phase and an absent editor. Native source,
membership, revision, authorization and save guards still run after the response.
The fixture requires an observed acknowledgment, native edit activity and no
remaining jobs/handoffs; cleanup preserves original and cleanup errors. Production
source, model execution, timeouts, worker settings and fixture size are unchanged.
Actual formatting and lint passed; checkJS first found one missing `MangaPage`
JSDoc annotation, which was added before the second checkJS pass. The cold
canonical run (`node scripts/check.cjs --cold`, eight workers) was then started
at ddc. At this publication checkpoint, its completion and native/UI results were pending.
The later failed ddc check is recorded below; final evidence must use the exact
new tested implementation SHA.

### Historical ddc cold canonical failure

The cold canonical check at `ddc43675872629560830b787d252dd6b0faed256`
completed on 2026-09-24 at 05:25:27 UTC with exit 1 after 542.115 seconds.
Twenty of the 26 planned stages ran: 19 passed and `test-coverage` failed.
The actual test stage took 463.835 seconds across 1,229 files: 9,174 total
assertions, 9,162 passed, one failed and 11 inherited skipped. The failure was
`mcpWorkDeletionStaging`'s exactly-full-work restoration/revalidation case,
which reached the existing 15-second timeout (15,004.7904 ms observed).
All 4,675 source fingerprints and report/count/timestamp bindings matched.
No new successful build, native execution or UI capture resulted from this run.

The full fixture combines multiple native capacity contracts and per-entry disk
checks. A narrower separation of those test responsibilities was being reviewed
at this checkpoint, retaining their assertions, capacity, workers and timeouts.
This failed run remains preserved independently of later corrections and passes.

### Published test-contract separation at 99cd9cd8

`99cd9cd822f034316f8c66011fb29d9d6c042bd4` changes only the existing
`tests/mcpWorkDeletionStaging.test.ts`. It separates native staged restoration,
ownership-marker-aware revalidation and publication from published-source
equality and rejection of the 2,001st ordinary entry. The second case awaits the
actual successful publication. Complete preparation, restoration and verification
promises remain owned through teardown, which drains them before closing the
fixture and preserves original, late and cleanup failures.

The source preparation, native operations/order and all capacity assertions are
preserved: 2,000 entries consisting of 1,999 directories and one metadata file,
with the existing mkdir batch of 50. Production source, eight workers, the
15-second case limit and coverage/architecture policies are unchanged. Actual
formatting, lint and TypeScript passed. The candidate diagnostic passed both
cases (9.2652801 s and 1.9570836 s); the process retained exit 1 because unchanged
global and per-file coverage requirements apply to that selected test. This is
not a successful complete coverage run or a claim of lower total runtime.
The published-source cold canonical run was started next; its final result and
native/UI execution were pending at this publication checkpoint.

### Historical 99cd canonical pass and native failure

The cold canonical check at `99cd9cd822f034316f8c66011fb29d9d6c042bd4`
passed all 26 stages with exit 0 in 511.644 seconds. The test stage took
411.742 seconds: 1,229 physical files, 9,175 total assertions, 9,164 passed,
zero failed and 11 inherited skipped. The same-source build passed in 16.155
seconds with `cacheHit:false`; Electron, renderer, runtime assets and ONNX runtime
were built with caching disabled. All 4,675 source fingerprints and actual report
bindings matched. Raw coverage SHA-256 remains
`8dfa06f43290ec555ca0771b2e75f58a6dfed0dbdf61316b72dbf689cd3a45f9`.

Its subsequent isolated native run completed at 05:51:21 UTC on 2026-09-24 with
child exit 1 and 20/23 markers. All four bundle-11 markers passed: native
text/context exchange, retained delivery, saved-source encoder comparison and
approved output sync. Both composite markers and the final smoke marker remained
false. The wrapper did not time out. Source fingerprints matched; the advertised
listener closed, the owned Electron profile was removed and no owned native
directories remained. UI did not run at this source. The composite failure was
under investigation at this checkpoint; these cleanup and partial marker results
are not complete native acceptance. Full canonical/native objects remain in
[acceptance evidence](mcp-final-acceptance-20260923.json), and the final table stays
bound to the later fully verified implementation.

### Published live-observation correction at a4e6ce9a

The 99cd native log preserves a completed work-file-import child, its exact
selection fingerprint and imported-item mapping, while the parent still exposes
`held` / `native-outcome`. That record is a deliberate durable checkpoint before
native receipt/source refresh commits the next parent state. Public get/list
could expose that intermediate checkpoint as a terminal hold even while the
same owner's started execution still owned the refresh.

`a4e6ce9aef7e5b83100302692904039f6cc9aad9` corrects only the returned
clone in `McpCompositeWorkflowService.observe`: a held/native-outcome record with
a completed next-phase outcome is shown as running while its matching owner has
a started active execution. The durable checkpoint is unchanged. Restart without
that execution, failed refresh and explicit control states retain their held or
control behavior. The three-file commit changes that service, the existing
controller fixture and two controller regression cases; it does not add a store,
queue, timer or automatic restart.

Actual candidate-aware formatting, lint, TypeScript, maintainability,
error-handling and mock-boundary checks passed. Seven selected files passed all
39 assertions. The selected coverage process retained exit 1: service coverage
was lines 119/144, statements 122/157, functions 25/27 and branches 43/68, below
its inherited full-run floors in this diagnostic. Neither the assertions nor
these selected metrics establish final coverage acceptance. Preparatory lint and
type issues in the added tests were corrected before the final candidate; the
production correction remained the same. The new cold canonical run was started
from a4e6, with native/UI pending at this publication checkpoint.

The 99cd log also preserves an acceptance/cleanup aggregate and a secondary
fixture-cleanup aggregate. Node collapsed their nested cleanup errors, so the
individual server/session close causes are not known. Source inspection identified
premature close during an owned refresh as a possible explanation; it did not
recover either individual exception. Error aggregation was preserved and no
separate cleanup suppression or semantic change was made. The log identity,
complete held record and review limitations remain in the acceptance evidence.

### Historical a4e6 canonical pass and native cancellation-report failure

The cold canonical check at `a4e6ce9aef7e5b83100302692904039f6cc9aad9`
passed all 26 stages with exit 0 in 476.474 seconds. Every one of the 1,229
physical file results was passed; assertions were 9,166 passed, zero failed and
11 inherited skipped (9,177 total). The test stage took 381.578 seconds. The
same-source build passed in 13.160 seconds, with all four build steps rebuilt
and `cacheHit:false`. All 4,675 source fingerprints and report bindings matched.
The full coverage floor gate, including the changed composite service, passed.
The raw coverage digest is
`eb2f1e0701d568748b7a13fdeae5453ade905a6fe89e3f443e3567b9af2402c0`;
it is separate from earlier sources' coverage artifacts.

The following native run finished at 06:27:17 UTC on 2026-09-24 with child exit
1 and 20/23 markers. The earlier import/held boundary was passed, and the composite
import/context/text/review/image/ZIP/working-file, restart/rebind, cancellation and
invalidation helpers progressed. The final fixture error-list assertion then
found one `AbortError` where it required an empty list. Both composite markers
are emitted after that assertion, so they and the final smoke marker remain
false. Helper progress does not turn this failed run into native acceptance.
Source fingerprints matched; the listener closed, the owned profile was removed,
no owned native directories remained and no wrapper timeout occurred. UI did not
run. The single actual run and its source-bound failure evidence are retained.

Independent inspection distinguishes the exception's creation stack from its
reporter: linked cancellation creates the reason in `McpOperationService`, while
`McpExportBatchService.run` catches and reports its own normal cancellation before
returning the cancelled result. A focused batch-reporting correction was under
review at this checkpoint; no OperationService change or blanket cleanup-error
suppression had been applied. This observed a4e6 error does not identify the
individual nested cleanup errors that the earlier 99cd log collapsed. The native
log identity, actual assertion stack and complete canonical/native objects remain
in [acceptance evidence](mcp-final-acceptance-20260923.json).

### Published cancellation-report correction at f375a37f

`f375a37f50b7ec5e9a655f9b63a791b2f0771bdc` changes one report condition in
`McpExportBatchService.run` and adds four cases in the existing batch test file.
The reporter excludes a thrown value only when the operation's own signal is
aborted and the value is identical to that signal's reason. A different
`AbortError`, cleanup `AggregateError` and an unaborted falsy exception remain
reportable. Batch/per-page outcomes, retained partial output, physical settlement,
journal restoration, OperationService and the strict native fixture assertion
are preserved. No timer, deadline, worker or coverage policy changed.

The candidate's six actual static checks passed. All 85 selected assertions in
18 suites passed, including the four added cases; all 4,675 source fingerprints
were unchanged. Its batch-file coverage exceeded each unchanged floor:
lines 68/70, statements 72/74, functions 21/21 and branches 49/52. The filtered
process still exited 1 because unchanged global and other-file thresholds were
not met; this is not a successful full coverage run. A new cold canonical run
was started at this publication checkpoint with prefix
`.tmp/mcp-bundle12-f375a37f-20260924`; full canonical, native and UI acceptance
were pending. The full publication and diagnostic evidence are retained in
[acceptance evidence](mcp-final-acceptance-20260923.json).

### Final integrated evidence

The following results belong to the exact recorded implementation SHA. A later documentation-only commit is not a new test execution.

| Evidence                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified implementation SHA                                    | `f375a37f50b7ec5e9a655f9b63a791b2f0771bdc`                                                                                                                                                                                                                                                                                                                                                                                                   |
| Complete canonical command, stages and exit                    | PASS — `node scripts/check.cjs --cold`, 26/26 stages, exit 0; 458.451 s; completed 2026-09-24T06:52:57.795Z                                                                                                                                                                                                                                                                                                                                  |
| Full V8 files, passed/failed/pending cases and coverage digest | PASS — all 1,229 physical files passed; 9,181 assertions = 9,170 passed / 0 failed / 11 inherited skipped; coverage SHA-256 `0b9d574fbd9dd8c8438bde764450ab2af10d218ad08236994c337ee2ee41f8de`                                                                                                                                                                                                                                               |
| Preserved coverage floors and measured additions               | PASS — 1,870 inherited serialized rows/metadata/deletions preserved; 65 measured additions; inventory 765/1,170/11; all 14 earlier gaps closed; same-source canonical floor gate passed                                                                                                                                                                                                                                                      |
| Measured architecture edges and registered ceilings            | PASS — 22 reviewed ceilings published at ecab from the saved 0bb graph (2,500 modules / 11,802 edges / 0 layer/cycle errors); same-source canonical architecture stage passed                                                                                                                                                                                                                                                                |
| Build from the same canonical source                           | PASS — same-source cold build, 13.882 s, `cacheHit:false`; exact build-step outcomes retained in acceptance evidence                                                                                                                                                                                                                                                                                                                         |
| Isolated native chain, expected 23 markers and cleanup         | PASS — 23/23 required markers, child exit 0; actual native import/context/review/output/restart boundaries, listener closed, owned profile/native fixtures removed, source and originals preserved                                                                                                                                                                                                                                           |
| Six production UI captures and direct visual inspection        | PASS — six actual production captures, each opened and reviewed; automated layout checks passed; owned entries/profiles/captures removed, no cleanup warnings. Initial wrapper port checks were Windows 10035/undetermined; separate later Node ECONNREFUSED and Windows listener-table observations resolved the same six targets without rerunning QA; original failed wrapper retained. Descendant PIDs were not independently enumerated |
| Source fingerprints and unchanged-worktree evidence            | PASS — 4,675 source fingerprints unchanged through canonical/native/UI; source/report digests, counts and Vitest stage timestamp binding verified                                                                                                                                                                                                                                                                                            |

NEXT: User-session acceptance of refreshed ChatGPT tools, actual image/file receipt, quality on user originals and agreed live restart/reconnection; the branch remains draft and unmerged.

The running user app, user artwork, saved authorization, model assets and Tailscale
configuration remain outside these isolated checks. Actual ChatGPT connection/tool
refresh, image/file receipt in that client, user-original model quality and live
restart/reconnection belong to the final user-acceptance session. They are not
claimed by public diagnostic probes, fixture host review, HTTP byte reconstruction
or screenshots. No live-app restart or model/account operation is implied here.

The earlier a710 bundle-11 subset and all following bundle checkpoints are retained
as history. Their former NEXT instructions do not supersede this section.

## Bundle 11 output slices at a710c0b8 (historical verified subset)

Read `mcp-work-file-export-checkpoint-20260923.md` and
`mcp-export-exchange-checkpoint-20260922.md`. Verified source:
`a710c0b8f4b81b136354b5696bc2ea5ffccd262a`. Raster PNG/JPEG/WebP, native layered
PSD, ZIP and editable `.mgtshare` working-file output are connected to the existing
owned jobs, explicit file delivery and retained reissue. Completed working-file
input/append and earlier library features remain unchanged.

All 26 repository stages passed at that source: 1,150 test files, 8,673 passed
tests, zero failures and 11 inherited pending tests. The fresh build was a cache
miss. Actual Electron then passed all seventeen required markers, including the
registered work-file export/editable roundtrip/HTTP/reconstruction/discard path.
Child and wrapper exited zero, the isolated listener closed, owned fixtures/profile
were removed, and all 4,426 tracked source fingerprints matched throughout.

The current coverage gate passed with 1,801 records: all 1,796 inherited records
remain unchanged, plus five actual measured additions. The earlier `2bafc039`
NodeNext import failure remains historical failed evidence; its corrected source
passed the complete `a710c0b8` run. No GitHub CI or live-client success is inferred.

NEXT: finish bundle 11 source-format selection, reviewed text/context exchange and
delivery diagnostics/approved synchronization, then implement bundles 12 and 13 in
order. Live acceptance remains deferred until all bundles are implemented. Do not
recreate completed raster/PSD/work-file output, bundle-10 imports or prior features.
The bundle-10 record below and its former next-step instructions are historical.

## Bundle 10 implemented and automatically verified (historical completed baseline)

Read `mcp-work-file-append-integration-checkpoint-20260922.md`. Verified source
`64beb6beb47707ae35c09034f9db5690f897483c`. All 26 repository stages passed in the
final execution, exit zero: 8,564 tests passed, zero failures, 11 inherited skips;
1,710 MCP cases / 316 files; 40 work-file cases / 13 files. Counts overlap.

Eight measured file-specific architecture entries and three measured coverage
records are registered. Global/legacy ceilings, unrelated exceptions and every
1,789 inherited coverage record/provenance/deletion policy remain unchanged.
Coverage now contains 1,792 records. The inventory test changed only 1,033 to 1,036.
The existing append implementation and 215 output contracts were not rebuilt.

Actual Electron used the build from that exact full check: all fourteen required
markers passed, actual child exit zero, isolated listener 63961 closed. It covers
new-work import and existing-work append, upload disposal, OS-encrypted receipts,
client reconstruction and replay without duplicate chapters, preserving original
chapters/context. Earlier import/history/organization/movement/recovery scenarios
also passed. All 4,369 tracked source/test/script hashes matched after full checks.
This remains isolated development validation, not live site/model/chat acceptance.

NEXT: bundle 11, extra export/exchange formats and attachment/delivery diagnostics.
Do not repeat completed bundle-10 features or run live tests. The documented input,
retention, mapping and v1 limitations remain; implementation of bundles 11-13 is
still outstanding. The following append registration failure is historical.

## Native append before registration (historical starting point)

Read `mcp-work-file-append-checkpoint-20260922.md`. Latest tested source `fd0e9334`.
The separate append review and existing work-file importer now preserve destination
chapters/files/context while adding selected editable chapters at the end. Explicit
reference mappings reuse chapter movement policy; the source guide is not merged.
New-work imports and retained receipt replay remain supported. Output inventory: 215.

Focused checks: 48 cases / 14 files passed, including 40 work-file cases / 13 files.
Full final V8 run: 8,563 passed, ONE coverage-inventory failure, 11 inherited skips.
The actual Electron append scenario passed with all fourteen required markers,
child exit zero and listener 63997 closed. Its native/build source was `4c77e72b`;
subsequent implementation changes were formatting only plus boundary tests.
All 4,369 tracked source/test/script hashes matched across the final full test run.

DO NOT mark the complete check or bundle 10 passed. The orchestrator stops at eight
architecture dependency-budget mismatches; the coverage inventory lacks three
introduced files, listed with exact measured edges and evidence in the checkpoint.
All old architecture/coverage files remain unchanged. Register measured additions
without weakening inherited criteria, then rerun full gates and native verification.
Do not recreate append or prior library features, start bundle 11 or run live tests.

## Native new-work import (historical starting point)

Read `mcp-work-file-import-checkpoint-20260922.md`. Verified source `eae62c68`.
Three connected tools review/import/read receipts for owned `.mgtshare` v1 inputs.
Native editable blocks, supported formatting, original/processed images, selected
chapter order and optional style guide are preserved with new IDs and mapped block
references. Output inventory: 214. No flattening or implicit model execution.
V1 memory/mask/runtime/history limitations require explicit acknowledgment; the live
upload is necessary until import settles. Existing works are not replaced.

All 26 gates passed together: 8,545 tests, zero failures, 11 inherited skips;
1,691 MCP cases / 311 files; 21 work-file cases / eight files. All 1,785 inherited
coverage records remain, with four measured additions totaling 1,789. Reading-order
and duplicate-page identity defects are corrected; legacy incomplete order remains.
Actual Electron passed thirteen required markers, child exit zero and closed listener
54248, including native share export/upload/import/encryption/reconstructed replay.
All 4,359 tracked source/test/script hashes matched. Fixtures are not live acceptance.

NEXT: reviewed existing-work append, preserving current chapters and explicitly
handling context/reference conflicts. The old native existing-work share path
replaces its complete chapter list; do not expose it as implicit append. Continue
bundle 10, do not start 11, redo completed features, restart the user app or run
live tests. The completed incoming-file checkpoint below is historical.

## Incoming-file integration (historical starting point)

Read `mcp-incoming-files-integration-checkpoint-20260922.md`.
Verified source: `8f6dea11`. The four measured composition exceptions were recorded
through GitHub. All 26 repository gates passed together with actual exit zero:
8,524 tests, zero failures, 11 inherited skips; 1,670 MCP cases across 303 files.
All 1,785 coverage records and the entire coverage manifest remain unchanged.
The actual Electron recheck passed all twelve required markers, child exit zero
and isolated-listener cleanup. All 4,345 tracked source/test/script hashes matched.
The six transfer/preparation tools and 211 output contracts are unchanged.

Next: native `.mgtshare` working-file input via the existing share workflow.
It is not yet implemented; do not flatten editable data or discard context.
Do not begin bundle 11 or live acceptance. The following failed-check report is
historical, not the current integration status.

## Incoming files before architecture integration (historical starting point)

Read `mcp-incoming-files-checkpoint-20260922.md`. Examined/verified code `b583c804`.
Six registered transfer/preparation tools accept actual owned bytes and feed the
existing frozen-preview/native import path. Output contracts: 211. No local picker,
URL or opaque attachment-handle fetching; filename alone is not attachment transfer.
Ready verifies byte length/SHA-256, not importability. Explicit native preparation,
preview selection, duplicate rejection and atomic encrypted import receipts remain.
Uploads are session-only; frozen previews own separate copies, and imported chapters
and retained receipts survive upload disposal/client reconstruction.

The FULL test suite passed 8,524 cases, zero failures and 11 inherited skips;
1,670 MCP cases across 303 files. This continuation adds 27 tests across six files.
All 1,781 inherited coverage records/provenance remain; four measured modules bring
the total to 1,785. A provider-close failure that leaked an upload and decoded-raster
retention introduced during lifecycle extraction were reproduced and fixed. Existing
page-bound PNG/mask input validation and limits remain intact.

The complete 26-gate command still FAILS architecture: journal imports 16/15,
common batch-tool consumers 35/34, output composition imports 37/36 and import-session
imports 15/12. Recording those exact exceptions was blocked before execution;
the architecture manifest is unchanged. Do not claim an all-gates pass or hide the
new direct dependencies. Types/lint/other static checks pass; full V8 tests, exact
coverage, Windows build and image/artwork/renderer/preload checks pass separately.

The new actual-Electron PNG upload -> frozen preview -> upload disposal -> native
import/OS-encrypted receipt -> reconstructed replay -> original preservation passed.
All twelve required markers, actual waited child exit zero and closed isolated
listener 55062 were checked at the same source. The earlier empty-marker PowerShell
attempt is unverified, not a successful native run. All 23 source/test/configuration
hashes match. Native storage/encryption are real; existing provider/editor/picker
boundaries are fixtures, not live client/model tests. No UI layout was changed.

General input: 128 MiB/file, 16 files/256 MiB reserved session, 32-KiB chunks,
4,096 chunks/file, 256 request receipts and fixed thirty-minute/session expiry.
PNG/ZIP selection succeeded; full JPEG/WebP/PDF/RAR conversion and full-size 128-MiB
transmission were not independently demonstrated. Ready is not malware validation.

Next: resolve the four architecture integration exceptions and rerun ALL gates;
then native `.mgtshare` working-file import via the existing share workflow. That
editable working-file input is NOT implemented yet. Do not start bundle 11, redo
completed library functions, restart the user app or modify real data/auth/models/
Tailscale/OS settings. Live acceptance stays deferred.

## Verified page deletion and exact recovery (historical starting point)

Read `mcp-page-deletion-connected-checkpoint-20260922.md`. Verified source `8252872c`.
Seven tools review/delete/get/list/Undo/Redo/protected-discard one selected page.
Output inventory: 205. Native page deletion/memory policies, encrypted chapter archive,
source retirement and metadata/catalog publication share the existing transaction.
Sibling/shared files and external originals remain. Undo restores exact archived
chapter/memory/assets and native work metadata, never replaces surviving directories.
Later changes, occupied paths, linked workspaces, open/missing trusted editor probes,
changed grants and expiry reject publication. Last-page removal leaves an empty
chapter; absent memory stays absent. No model or automatic job resumption occurs.

Shared-source deletion was reproduced and fixed in the native planner. Case-aliased
paths and reserved artifact-root markers are checked before removal. A new admission
regression reproduced disposal of replaced recovery history; the full current-record
comparison now rejects that race and preserves later records. Common deletion action
checks remove copied branches without adding another store/codec/transaction engine.

All 26 gates passed with exit zero: 8,497 tests, zero failures, 11 inherited skips;
1,643 MCP cases across 297 files. Page tests: 36 across nine files; with native page
compatibility and byte-journal cases, 42 across 11 files. All 1,772 inherited coverage
records/provenance remain unchanged; nine measured modules bring the total to 1,781.
Windows build, image/artwork parity, strict output registration and all static checks
passed in the same sequence. All 38 source/test/configuration hashes matched afterward.

The new native page scenario passed absent/manual-memory deletion, reconstructed
Undo/Redo/replay and protected disposal. Eleven required completion markers, actual
Electron child exit zero and closed isolated listener 59211 were verified at the
same source, including prior exact-2,000-entry work recovery. Native storage/encryption
are real; editor/input/browser replies are fixtures, not live-client acceptance.

One page in a chapter of at most 50 pages. The whole archived chapter must fit
2,000 entries/128 MiB per file/256 MiB total. Shared same-profile/approved-owner
seven-day/256-record/1-GiB recovery and 32 actions remain; not permanent trash.

Next: generic incoming file/attachment bytes and native working-file input. Do not
redo completed page/work/chapter deletion, movement, imports/source history, names,
orders or synchronization. Do not start bundle 11. User app/library/artwork/auth,
approved models, Tailscale and OS settings remain untouched; live tests deferred.

## Verified whole-work deletion and exact recovery capacity (historical starting point)

Read `mcp-work-capacity-checkpoint-20260921.md`. Verified source `37fd6331`.
The earlier 2,000-entry restoration failure is resolved using the existing native
transaction's journal-bound ownership handle. Only its verified root marker is
separate from source inventory; the 2,000-entry/256-MiB limits are unchanged.
Ownership is checked before and after capture. Reserved source-root markers reject
removal rather than being dropped; nested marker-named data remains preserved.
Existing chapter movement consumes the same corrected staging inventory.

All 26 gates passed with exit zero: 8,455 tests, zero failures, 11 inherited skips;
1,607 MCP cases across 288 files. Work-deletion/recovery-staging: 46 cases across
12 files. All 1,772 coverage records and the entire floor manifest remain unchanged.
Two real-publication regressions cover staged movement-byte corruption and encrypted
catalog/record disagreement; no floor was lowered to compensate for refactoring.

The exact 2,000-entry two-chapter work passed actual-Electron deletion, reconstructed
Undo/Redo, replay, protected disposal and exact original tree/order preservation.
Ten required markers, actual child exit zero and closed isolated listener 61238 were
verified at the same source. The 256-MiB boundary uses actual native staging and
filesystem files in automated tests, not a full 256-MiB encrypted native deletion.
Native storage/OS encryption are real; editor/input/browser replies are fixtures.
All 11 changed source/test/configuration hashes matched after checks.

The seven existing work-deletion tools and 198 output contracts are unchanged.
One work/ten chapters/fifty pages TOTAL, 128 MiB per file, same-profile/owner seven-day
recovery, shared 256-record/1-GiB catalog and 32 recovery actions remain. This is not
permanent trash. Restored ordinary data does not expire with its recovery archive.
The failed historical run remains in `mcp-work-deletion-checkpoint-20260921.md` and
separate evidence logs; it is not mislabeled as a passing run.

Next: page deletion/recovery, then generic incoming file bytes/native working-file
input. Do not redo completed work/chapter deletion/movement, imports/source matching,
naming/orders or synchronization. Do not begin bundle 11. User app/library/artwork,
authentication, models and Tailscale remain untouched; live acceptance is deferred.

## Verified bundle 10 cross-work chapter movement (historical starting point)

Read `mcp-chapter-move-connected-checkpoint-20260921.md`. Verified source `8e5fe8c9`.
Six registered tools review/move/list/inspect/Undo/Redo one closed, unlinked chapter
between two existing works. Both work orders, moved directory and verified encrypted
originals/recovery publish atomically. Chapter/page IDs, artwork, masks, block data,
source history and supported memory are preserved. Explicit reference mappings do
not merge catalogs. Native checkpoint pointers are invalidated; exact Undo restores
the originals. Historical requests do not repeat movement. Output inventory: 191.

All 26 gates passed: 8,407 tests, zero failures, 11 inherited skips; 1,561 MCP cases
across 276 files. Eight movement files contain 30 passing cases. All 1,754 inherited
coverage records/provenance remain unchanged; ten measured modules bring the total
to 1,764. The new actual-Electron movement scenario and all existing native regressions
passed at the same source, with eight required markers, child exit zero and a closed
isolated listener. Native storage/OS encryption are real; renderer replies and input
selection are fixtures, not live user-app or public-client acceptance.

One chapter/50 pages/2,000 filesystem entries/128 MiB per file/256 MiB source;
shared seven-day/256-record/1-GiB catalog and 32 recovery actions remain. Movement
archive disposal never deletes the ordinary moved chapter; its retention is not
permanent trash. Destination rules govern future processing, while older jobs,
proposals and histories remain bound to their original work.

Next: separately reviewed work/page deletion recovery, generic incoming file bytes
and native working-file input. Do not redo completed chapter deletion/movement,
imports/source matching, naming/orders or synchronization. Do not begin bundle 11.
User app/library/auth/model assets/Tailscale remain untouched; live tests deferred.

## Verified bundle 10 chapter deletion and exact recovery (historical starting point)

Read `mcp-chapter-deletion-connected-checkpoint-20260921.md`. Verified source `447c2e7e`.
Seven registered tools provide reviewed chapter deletion, retained lookup/list,
Undo/Redo and protected disposal. The directory includes library originals/memory/run
files; only verified encrypted recovery allows removal. Native metadata/directory,
backup and index publish atomically. External originals are untouched. An open
chapter is rejected even when clean; trusted editor probes and ownership remain.
Replay never repeats deletion after Undo. Output inventory: 185.

This is bounded seven-day recovery, NOT permanent trash. After acknowledged expiry,
the backup can be pruned. No early purge of an unrestored chapter is exposed. One
chapter/50 pages/2000 entries/128 MiB per file/256 MiB source; shared catalog limits
and 32 recovery actions remain. Later edits/occupied targets prevent forced restore.

All 26 gates passed: 8,377 tests, zero failures, 11 inherited skips; 1,531 MCP cases
across 268 files. The new actual-Electron deletion scenario passed with real native
storage and OS encryption, seven completion markers, actual child exit zero and a
closed isolated listener. Renderer-state replies and import selection are fixtures,
not a live user-app/public-client test. All 1,747 old coverage records are preserved;
seven measured modules bring the inventory to 1,754. No threshold or skip changed.

Three injected recovery-metadata failures now preserve original files. An existing
PNG timeout cancellation failure was separately reproduced with native GC and fixed
by observing the actual operation signal; the original security tests are unchanged.

Next: reviewed movement, work/page deletion recovery as applicable, general incoming
file bytes and native working-file input. Do not redo completed chapter recovery,
imports/source history or names/page ordering; do not begin bundle 11. User app/data,
auth, model assets and Tailscale remain untouched. Live acceptance is deferred.

## Verified bundle 10 page order and memory recovery (historical starting point)

Read `mcp-page-order-checkpoint-20260921.md`. Verified source `143a4be9`.
The six existing library-change tools now accept reviewed complete page ordering
inside one chapter, reusing native order/status/memory reconciliation. Review shows
page IDs and memory layout, not private summaries or image paths. Chapter/work
metadata, reconciled memory and encrypted recovery publish atomically. Exact
Undo/Redo restores record order, original memory rows/content/timestamps and file
presence; later edits prevent forced recovery. Historical request replay is inert.
Existing names/chapter-order formats and renderer synchronization remain intact.
Output inventory stays 178; at most 2,000 current page IDs per command.

All 26 gates passed: 8,335 tests, zero failures, 11 inherited skips; 1,490 MCP cases
across 257 files. Twenty-five cases were added. All 1,746 inherited coverage records
and provenance remain identical; one measured native module brings the total to
1,747. The dedicated actual-Electron page-order scenario and existing regressions
passed with actual child exit zero, six completion markers and a closed listener.
Native storage/OS encryption are real; no live user artwork, models, website or
chat-client acceptance is claimed. No renderer source or layout changed this time.

Next: separately reviewed moves/deletions/recovery, generic incoming file bytes
and working-file input. Do not recreate imports/deduplication, names/chapter/page
ordering or synchronization; do not start bundle 11 yet. User app/library/auth,
model assets and Tailscale remain untouched. Live acceptance is still deferred.

## Verified bundle 10 metadata synchronization (historical starting point)

Read `mcp-library-synchronization-checkpoint-20260921.md`. Verified source `273c5ece`.
The six existing organization tools now notify the desktop after successful new
apply/Undo/Redo commits. Typed metadata-only events refresh the library list and
affected open chapter. Coalesced reads reject superseded results; dirty page input
is preserved. A reproduced older-timestamp Undo display bug is fixed without
changing normal page-refresh semantics. Output inventory stays 178.

All 26 gates passed: 8,310 tests, zero failures, 11 inherited skips;
1,467 MCP cases across 254 files. Dedicated real-Electron names/order recovery
passed with OS encryption, session reconstruction, exact restoration and closed
test listener. Production LibraryTree/hook/CSS wide/narrow QA passed and captures
were visually reviewed. UI event/read boundaries are synthetic, not live-client
acceptance. All 1,745 inherited coverage records are preserved; one original
historical refresh-coordinator floor brings the exact inventory to 1,746.

Next: page ordering with saved-memory consistency and exact recovery; separately
reviewed moves/deletion/recovery; generic attachment and working-file input.
Page ordering was inspected but is not implemented here. Do not redo completed
import, deduplication or names/chapter-order work; do not start bundle 11.
The live app/user data/models/auth/Tailscale are untouched; live tests remain deferred.

## Verified bundle 10 names and chapter order (historical starting point)

Read `mcp-library-organization-checkpoint-20260921.md`. Verified source `d694f439`.
Six registered tools review/apply/list/get/Undo/Redo work/chapter names and complete
chapter ordering using the original native title/order policies and transactions.
Metadata and encrypted recovery publish together; original pages/source history
remain unchanged. Current-state checks, exact recovery, historical request replay,
no-op behavior, owner/scopes, late failures and bounded action history are verified.
Output inventory: 178. Page ordering, movement and deletion are not yet connected.

All 26 gates passed: 8,299 tests, zero failures, 11 inherited skips; 1,456 MCP cases
across 251 files. Five new test files cover 16 cases. All 1,739 inherited coverage
records/provenance remain unchanged; six measured modules bring the total to 1,745.
The unchanged existing Electron regression passed with actual child exit zero, four
required markers and a closed isolated listener. The NEW organization-native harness
connection request was blocked before execution and remains unapplied; its unconnected
draft was removed. No positive organization-specific Electron or live-client claim.

Next: dedicated native organization and already-open renderer synchronization
verification; page order and saved-memory effects; separately reviewed moves/deletes/
recovery; general attachments and working-file input. Do not redo metadata changes
or import/source matching, start bundle 11 or restart the live app. Live acceptance
stays deferred until all bundles are implemented.

## Verified bundle 10 persistent source identity (historical starting point)

Read `mcp-import-source-history-checkpoint-20260921.md`. Verified source `0d77b62a`.
Registered read-only `carrot_get_import_duplicates` compares selected captured input
with native chapter history. Existing standalone/grouped publication accepts optional
`reject-known`, rechecking content/URL/group collisions at commit. Explicitly omit
known items to publish only unseen chapters; no silent skipping or new network/model
work. Output inventory: 172. Legacy omitted policy and receipt replay are preserved.

Native provenance survives receipt/plan expiry and ordinary native naming/order/
processing-state saves. History is not current image integrity; deleted chapters
leave no hidden archive. Older untracked chapters and one-work scope remain explicit.
Read-only source reservations now report checking rather than importing in batch views.

All 26 gates passed: 8,283 tests, zero failures, 11 inherited skips; 1,441 MCP cases
across 247 files. Nine new source-history files cover 17 cases. All 1,734 inherited
coverage records/provenance remain unchanged; four new measured modules plus one
historically measured existing module bring the inventory to 1,739. The dedicated
actual-Electron source-history and existing regressions passed at the same source,
with four required markers, actual child exit zero and the isolated listener closed.
Native storage, validation and OS encryption are real; browser collection is synthetic.

Next: library naming/order with current-state and recovery checks, then separately
reviewed moves/deletions/recovery and general attachment/working-file input. Reuse
libraryMutationFacade/libraryMutations, now characterized for source preservation.
Do not redo import/source matching, start bundle 11 or restart the user's live app.

## Verified bundle 10 reviewed multi-URL publication (historical starting point)

Read `mcp-import-publication-checkpoint-20260921.md`. Verified source `933f5d5f`.
The new `carrot_import_batch_chapters` publishes explicitly reviewed current
item/preview/draft/page IDs to one new or existing work through the original native
importer. It preserves supplied order and omitted URLs. Total per call: ten chapters
and fifty pages. Chapter files, grouped receipt mapping and parent batch progression
share one native transaction; cancellation before commit rolls back the whole group.
Source bytes, current permissions, batch version and destination snapshot are checked
at publication. Same-request replay does not import again; parent progress survives
separate receipt disposal. Existing source preparation and individual imports remain.

All 26 gates passed: 8,266 tests, zero failures, 11 inherited skips;
1,424 MCP cases across 238 files. Seven new test files cover 18 cases.
All 1,732 inherited coverage records/provenance remain unchanged; two measured new
modules bring the inventory to 1,734. Output contracts total 171. The added actual
Electron grouped-publication scenario passed with mandatory markers, actual child
exit zero and a closed isolated listener. Browser collection is synthetic; native
image validation, OS-encrypted storage, publication and MCP reconstruction are real.
There is still no new positive live-site/discovery-browser or user-client claim.

Next: persistent source URL/content identity and fresh-preview/new-chapters-only
deduplication, then library naming/order/move/delete/recovery and general attachment/
working-file input. This is NOT all of bundle 10. Do not redo batch preparation,
start bundle 11, or restart the live app. Final live acceptance remains deferred.

## Verified bundle 10 multi-URL preparation (historical starting point)

Read `mcp-import-batch-checkpoint-20260921.md`. Verified source `065306c9`.
Seven registered tools fix 1-10 URLs or owned discovered links, sequentially prepare
image previews, retain per-item progress, pause/cancel and explicitly retry/rescan.
Existing atomic import receipts are checked before rescan. No browsing in prepare,
lookup or replay; the retained run ledger also handles lost separate job history.
Output inventory is 170. Image previews remain thirty-minute session-only inputs;
plan metadata lasts seven days. Review pages and use existing carrot_import_chapters.

All 26 repository gates passed with actual process exit zero: **8,248 tests passed, zero failures and 11 inherited skips**. The MCP subset passed **1,406 cases across 231 files**. The 5 new batch files passed 16 cases.
All 1,726 inherited floors remain unchanged; six measured modules bring the total
to 1,732. Existing Electron regression also passed with actual child exit zero and
closed isolated listener, but no new positive real-browser discovery/batch or live
client test is claimed. Full source/test/configuration hashes were rechecked.

Next: reviewed multi-URL library publication/destination progression, durable source
URL/content identity and new-chapters-only deduplication; library naming/order/move/
delete/recovery; general attachment and working-file input. Do not redo the connected
preview batch, start bundle 11, or restart the user's app for live testing.

## Verified bundle 10 chapter-link discovery (historical starting point)

Read `mcp-chapter-discovery-checkpoint-20260920.md`. Verified source `0af2ce58`.
Four additional registered tools discover bounded top-document same-origin link
candidates, preserve immutable owned IDs/snapshots in the existing encrypted
catalog, list/read them after restart without browsing again, and explicitly scan
one selected stored link through the existing image-import preview service.
The strict output inventory is 163. The existing seven import tools are preserved.

Discovery is not exhaustive chapter validation: no iframe/shadow/pagination traversal,
no automatic candidate visits/import, no source deduplication across fresh previews
and no durable multi-URL execution yet. Candidates retain DOM order and distinct
query identities; fragments deduplicate. Maximum 200 candidates (default 100),
25 per lookup; the shared seven-day/256-record/1-GiB metadata policy applies.
Image previews remain thirty-minute session-only inputs with separate page review.

All 26 gates passed: 8,232 tests, zero failures, 11 inherited skips;
1,390 MCP cases across 226 files. All 1,720 inherited coverage records and provenance
remain unchanged; six measured new modules bring the inventory to 1,726.
Existing research and discovery now share canonical metadata publication without
weakening research work verification. Page-only retries reject non-page imports/
discovery with typed errors rather than raw schema failures or repeated execution.

The additional actual-Electron discovery-harness edit was blocked before execution,
not resubmitted through another tool, and its unconnected draft was removed.
No successful actual-Electron discovery scenario is claimed. The unchanged existing
MCP Electron regression suite separately passed at the same verified source with
actual child exit zero, mandatory selected-import/completion markers and a closed
port 38695. This legacy native pass and Windows build/artwork parity do not replace
the pending positive discovery-browser scenario or live-client acceptance.

Next: the isolated discovery-native scenario plus bounded sequential multi-URL
execution, per-URL failure and explicit resume using the connected importer;
persistent source history/content identity and new-chapters-only deduplication;
library naming/order/move/delete/recovery; general attachment/working-file exchange.
Do not start bundle 11, redo bundles 1-9 or restart the user's running app.

## Verified bundle 10 native-file/single-URL slice (historical starting point)

Read `mcp-library-import-connected-checkpoint-20260920.md`. Verified source:
`f4ea5e0c`. Seven registered tools connect native-picker and single-URL
image discovery, owned frozen review, selected new-work/new-chapter creation,
current destination evidence and encrypted historical receipts through the existing
native import service. Same request/same preview cannot silently create duplicates.
Original files and existing work data are preserved. This is not general attachment
upload, exhaustive chapter discovery, source deduplication across fresh previews or
full library organization. Bundle 10 is not complete.

All 26 gates passed: 8,188 tests, zero failures, 11 inherited skips;
1,369 MCP cases in 221 files and 32 import cases in 8 files.
The added actual-Electron selected PNG/native validation/OS-encrypted receipt/
reconstruction/disposal scenario passed with required markers, child exit zero and
closed isolated listener. All 1,714 inherited coverage records remain identical;
six measured modules bring the inventory to 1,720. Global test/architecture limits
were not lowered. Live testing remains deferred.

Next: chapter-link discovery and reviewed bounded multi-URL execution/resume;
persistent source identities and new-chapters-only deduplication; existing library
naming/order plus separately reviewed moves/deletions/recovery; general incoming
file-byte/working-file exchange. Reuse the connected importer and retention rather
than rebuilding them. Native picker requires local selection; single-URL scan is
not an authenticated website crawler. Do not start bundle 11 or restart the live app.

## Verified bundle 9 completion (historical starting point)

Read `mcp-research-batch-checkpoint-20260920.md` for the complete multi-work
research continuation. Verified source: `1e5c8de6`. Eight registered tools prepare
one to ten fixed works, retain title/spoiler holds, sequentially run the existing
native researcher, preserve per-work results/usage and explicitly pause, cancel,
resolve or resume. Completed retained reviews and no-change outcomes are not
researched again. Parent-checkpoint loss is reconciled from native child records
and exact retained proposal provenance before any explicitly allowed retry.

Research results remain independent from application. Use the existing proposal
lookup/selected application and context migration/Undo/Redo paths. Internet
research is never automatically page-read memory or a catalog replacement.
Titles are caller-confirmed, not automatically disambiguated. Spoiler-limited
work remains held because the current researcher reads the whole saved work.
The shared seven-day/256-record/1-GiB policy applies; total work attempts are
explicitly bounded at one to thirty. A changed setting at resume requires
restoration or a new remaining-work plan, not silent model substitution.

All 26 repository gates passed with actual exit zero: 8,156 tests passed,
zero failures and 11 inherited skips; 1,337 MCP cases across 213 files.
The final run used the existing process-local eight-worker option, unchanged
15-second test limits/assertions, and no concurrent build/native verification.
The initial twelve-worker timeout failures remain in separate logs; the final
full run, not merely a focused rerun, passed every test and coverage floor.
All 1,707 inherited coverage records/provenance remain identical; seven measured
new modules bring the inventory to 1,714. Global architecture limits are unchanged.

The additional actual-Electron two-work held-plan/OS-encrypted reconstruction/
explicit resolution/disposal scenario passed with mandatory completion markers
and actual child exit zero. Its code is identical to the final verified source.
The isolated listener was confirmed closed. This native scenario does not invoke
research or models; provider execution tests use synthetic external responses.
Real manuscripts, model quality and ChatGPT/Tailscale acceptance remain deferred.

The preceding `mcp-research-connected-checkpoint-20260920.md` documents already
completed single-work retained research and selected application/recovery. Its
old multi-work remaining-work note is historical, superseded by this checkpoint.
Do not redo bundles 1-9. Next implement bundle 10, file/web import and library
organization through the existing native services; do not expand into bundles
11-13 or restart the running user app as part of a verification shortcut.

## Historical bundle 9 checkpoints before public retention integration

The notes below preserve earlier verification and blocked-work history. Their
public-wiring blockers are superseded by the current connected checkpoint above.

Latest continuation at that stage: `mcp-research-evidence-checkpoint-20260920.md`, verified
source `2afa6ccb`. Existing app research now rechecks complete saved-work
evidence before engine execution, after cleanup and after proposal-queue admission.
Two non-anchor chapter source/reference regressions fail against the prior source
and pass with the fix. The job journal supports safe retained proposal lookup IDs,
not proposal text or sources, and validates reconstruction/replay and expiry.
This does NOT connect the still-session-local public proposal service to storage.

All 26 gates passed: 8,124 tests, zero failures, 11 inherited skips;
1,305 MCP cases across 204 files. All 1,707 inherited coverage rows and
the full manifest remain unchanged. Windows build and existing native parity passed;
no standalone actual-Electron research reconstruction or live acceptance is claimed.
The current service-injection edit was blocked before execution and was not reapplied
through another tool. No new public tool or output contract was added. Resume at
public retained-review wiring, then multi-work research; do not start bundle 10.

Earlier backend checkpoint: `mcp-research-retention-backend-checkpoint-20260920.md`.
The native retained-research backend is implemented separately from applied context
changes and uses the existing encrypted catalog and atomic recovery publication.
Reviewed entry IDs, source evidence, selected application and exact native Undo/Redo
survive reconstruction in isolated tests. The prior workflow-expiry test now waits
for actual parent settlement; production expiry remains unchanged.

PUBLIC INTEGRATION WAS STILL PENDING AT THAT CHECKPOINT: the existing research tools
continued to use McpContextProposalService's session-local maps. The request to
connect the service, public tools and desktop composition was blocked before
execution. The unused research-session factory was removed; output contract count
remained 143. This historical limitation is now superseded by the connected checkpoint.

Verified code `98e3fa06` passed all 26 repository gates: 8,115 tests
passed, zero failures and 11 inherited skips; 1,296 MCP cases across 202 files.
Windows build and existing native artwork/image-protocol checks passed. All 1,703
inherited coverage rows and provenance remain unchanged; four measured backend
modules bring the inventory to 1,707. New backend tests use synthetic Electron/OS
encryption boundaries; no public research-tool or live model acceptance is claimed.
Connect this implemented backend rather than rebuilding its storage or recovery.

See `mcp-memory-refresh-checkpoint-20260920.md`, verified source `e6495aa1`.
The existing work-wide catalog/reference migration and durable recovery are preserved.
Three new registered tools inspect complete saved-page text evidence, preview selected
memory refresh and explicitly publish it with mandatory encrypted context recovery.
Legacy compact excerpts/timestamps report unknown rather than certifying freshness.
Manual visual summaries, unrelated rows, catalog, dialogue and images stay unchanged.
Native excerpts are deterministic app text; reviewed summaries come from the caller.
This feature does not invoke an AI summarizer or research engine.

All 26 gates passed: 8,087 tests passed, zero failures, 11 existing skips; 1,268 MCP
cases across 196 files. The additional actual Electron memory-refresh/reconstruction/
exact file-absence Undo/Redo scenario passed with required markers and actual child
exit 0. All 1,697 inherited coverage rows and provenance remain identical; five
measured modules bring the inventory to 1,702. Live acceptance remains deferred.

The original migration completion is recorded separately in
`mcp-context-migration-connected-checkpoint-20260920.md` (source `74c6dd52`). Do not
redo its catalog merge/delete/replacement, reference continuity or recovery.

At those earlier checkpoints bundle 9 still required public retained-review wiring
and multi-work research. The former is now implemented. Continue from the current
authority above, not the historical wiring blockers. Internet research must not
become page-read memory. Continue bundle 9, not 10.

## Verified bundle 8 completion

See `mcp-workflow-connected-checkpoint-20260919.md`, verified source `ac01503f`.
Thirteen tools connect fixed chapter/page plans, five explicit stage kinds,
sequential translation/erasure model residency, durable checkpoints, pause/cancel,
explicit resume, external-result acknowledgement and two-party settled handoff.
Existing native jobs, ownership, settings, transactions and retained storage remain
canonical. OCR keeps its existing per-page pipeline, not a single persistent OCR
model. No arbitrary dispatcher or automatically resumed model work is introduced.

All 26 repository gates passed: 7,971 tests passed, zero failed, 11 existing skips.
All 1,152 MCP cases across 181 files passed. The additional actual Electron workflow
reconstruction/render/output-reissue scenario passed with required markers and
exit code zero. Model/provider boundaries in other tests remain substitutes; no
live model quality, user artwork or public-client acceptance is claimed.

Current-child cancellation and late stale-child abort isolation are verified.
Handoff requires both current approvals, exact evidence/settings and settled
admission. It atomically changes only plan ownership, not historical job/change/
output ownership, and leaves the recipient paused for explicit resume. Crash,
revocation, concurrent control and exact replay are covered by native and HTTP tests.

All 1,677 inherited coverage records and provenance are preserved; five measured
continuation modules bring the inventory to 1,682. Bundle eight adds eighteen
modules over bundle seven. Original workflow checkpoints remain historical only.

NEXT: bundle 9, context merge/replacement, reference migration and multi-work
research. Do not redo bundles 1-8, create a second GPU scheduler or request live
tests between bundles. Full import/research/typography/SFX/ZIP composition remains
in the planned later bundles rather than hidden inside the five-stage core.

## Verified bundle 7 completion

See `mcp-retention-checkpoint-20260919.md`, verified source `09a99b16`.
Eight tools connect restart-persistent native page-change records, exact undo/redo,
retained PNG/ZIP inspection, fresh short-lived file links and explicit owned discard.
Page data, private image copies and encrypted records share the native commit point.
Repeated requests do not execute models or repeat saved actions. Current/leased
images are preserved; only replaced native working copies are retired. No arbitrary
paths, raw snapshots or retrospective UI-history capture are exposed.

All 26 gates passed: 7,893 tests passed, zero failed, 11 existing skips; 1,077 MCP
cases across 159 files. Scoped HTTP and the additional real-Electron OS-encrypted
session-reconstruction/PNG-reissue check passed, with final markers and exit code 0.
All 1,643 inherited floors and provenance remain unchanged; 20 new modules plus one
newly tracked existing file bring the inventory to 1,664 records.

Seven days / 256 entries / 1 GiB bounds the private catalog, not all artwork or
unlimited permanent storage. Old analysis/batch plans do not become executable
again. Same-profile/owner, page/source, permission and redaction checks remain.
The running user app, artwork, authentication and model assets were not modified.
Live app/model/client acceptance stays deferred until all bundles are implemented.

Bundle 7 remains complete. Follow the current authority at the top.
Reuse existing jobs, model ownership and retained data; do not introduce another
GPU queue or redo completed bundles 1-7. Context migration remains bundle 9.

## Verified bundle 6 completion

See `mcp-sound-effect-checkpoint-20260919.md`, verified source `d5db3901`.
Nine tools connect stored candidate inspection, native include/exclude/restore/manual
review, approved-text materialization, sound-only text/image-state edits, explicit
native foreground image generation, guarded image inspection and exact recovery.
Generation is a separate remote/account-consuming job requiring image permission,
explicit consent and the exact configured supported controller. No automatic OCR,
translation, erasure, C23, region replanning or rendering is implied. Those existing
independent tools and bundle-five external image input remain reusable.

All 26 repository gates passed: 7,851 tests passed, zero failed, 11 existing skips.
All 1,037 MCP cases across 150 files passed. Eighteen measured modules were added
while preserving all 1,625 inherited coverage records, provenance and deletions.
The added model-free real-Electron candidate/text/materialization/recovery check
also passed with its completion marker and exit code 0. Generation fixtures use
native foreground processing but substitute Codex transport and external Electron
image calls; no live model quality or user/client acceptance is claimed.

Bundle 6 remains completed. Follow the current authority at the top,
not its historical next-step recommendation.

## Verified bundle 5 completion

See `mcp-external-image-checkpoint-20260919.md`, verified source `0af0ba95`.
Twelve tools connect actual bounded PNG receipt, content/dimension/hash validation,
owned candidate review, native full background replacement or exact-size patches,
existing-block generated lettering and exact native undo/redo. Masks and explicit
protection preserve unselected current pixels. No model, erasure, OCR, translation,
URL fetch or arbitrary PC path is implicit. Only actual bytes are accepted; a chat
host's file handle or claimed filename is not a received image.

All 26 repository gates passed: 7,833 tests passed, zero failed, 11 existing skips.
All 1,019 MCP cases across 145 files passed. Fifteen measured modules were added
across this bundle while preserving all 1,610 inherited floors/provenance/deletions.
The additional isolated real-Electron uploaded-PNG/background/lettering/history
checks also passed with the explicit completion marker and exit code 0. Current
ChatGPT attachment reception, public Tailscale delivery and model quality remain
in the final live-test queue, not implied by these isolated tests.

Bundle 5 remains completed. Continue from the current authority at the top,
not its historical next-step recommendation. Permanent recovery remains bundle 7.

## Verified bundle 4 completion

See `mcp-image-edit-checkpoint-20260919.md`, verified code `32d76f3f`.
Eight image-edit tools are connected: native multi-block/freehand erasure,
explicit protected geometry, model-free paint and original-pixel restore,
mask preview, color sampling and exact native image undo/redo. One versioned
page per plan, up to 100 selected blocks and 16 million original pixels.
Originals, text, geometry and formatting are preserved. Erasure requires the
configured supported local engine and explicit asset-preparation consent;
no implicit OCR, translation, C23, layout or hosted image call occurs.

All 26 repository gates passed: 7,805 tests passed, zero failed, 11 existing
skips. All 991 MCP tests across 139 files passed. Nine measured coverage rows
were added while preserving all 1,601 inherited rows/provenance/deletions.
The extra isolated real-Electron mask/protected-RGBA/color/restore/history smoke
also passed with its terminal marker and exit code 0. Actual model quality,
user artwork and live ChatGPT/Tailscale delivery remain untested by this run.

Bundle 4 remains complete. Continue from the current authority at the top.
Durable recovery, chapter orchestration and live file acceptance remain separate.

## Verified bundle 3 completion

See `mcp-selection-connected-checkpoint-20260918.md`.
The selected OCR/translation observations now connect to explicit reviewed source
or translation application, native discovery append with overlap review and reading
position, native character/glossary reference edits, and exact session undo/redo.
Six editing tools are registered in the app composition and strict output contracts.
All analysis dependencies, native page/context ownership, source evidence, fixed
expiry, partial saves and historical request IDs remain enforced. Empty observations
never erase saved text; generated lettering is excluded. No arbitrary model text
or raw blocks are accepted by the analysis-bound application contract.

All 26 repository gates passed at `10472c97`: 7,772 tests passed, zero failed,
11 existing skips. The focused selection/output suite passed 37 tests across seven
files. Types, lint, architecture, coverage-floor gate, Windows build, existing
page-artwork parity and image-protocol/bundle checks all passed. Six measured
modules were added while preserving all 1,595 inherited coverage rows/provenance.
The connected checkpoint records exact evidence, stage timestamps and limitations.

Bundle 3 remains completed. Continue from the current checkpoint
above, not from its historical next-step recommendation. Permanent recovery
remains bundle 7.

## Verified bundle 2 completion

Authority: `mcp-lettering-connected-checkpoint-20260918.md`.
Bundle 2 includes independent native geometry/wrap/style preparation, saved
preset/rule/sequence/block-style discovery and version-bound reuse, exact owned
apply/undo/redo/cancel, and full selected-page freshness before forward saves.
Read-only metadata lookup never migrates/repairs settings or decrypts credentials.
Resource queries use read scope; mutations retain edit/process permissions,
native page/context ownership and atomic transactions.

All 26 repository gates passed at `55199412`: 7,717 tests passed, zero failed,
11 existing skips; 903 MCP tests across 123 files passed. The previous two lint
and seven architecture findings were resolved. All 1,583 inherited coverage rows
and provenance were retained, adding five actually measured modules.

## Verified bundle 1 completion

Bundle 1 is implemented and its six selection/recovery tools are registered.
All 26 repository gates passed at source `96cc3625`: 7,668 passing tests,
zero failures and 11 pre-existing skips; all 854 MCP cases passed. Previously
blocked source validation, owned-observation binding and static findings are
resolved. See `mcp-typography-connected-checkpoint-20260918.md` for exact scope,
coverage provenance, limitations and verification evidence.
Session-only recovery is not durable undo; bundle 7 remains separate.

## Historical bundle 1 checkpoints

The following notes describe the earlier partial implementation before the
connected checkpoint; they are retained as history, not current blockers.

The observation half was connected as `carrot_run_typography_analysis`, using
existing C23 analysis or multi-page raster measurement, explicit permissions,
ordered input snapshots, actual page ownership, expiring evidence and cleanup
fencing. At that time no style application was implied by returned font choices.
The remaining sequence then was function-length cleanup, canonical selective
application, exact undo/redo connection and complete automatic verification.
An application-adapter write and a later lint refactor were refused at that point.
Those historical gaps were subsequently resolved by the connected checkpoint.
Original evidence remains in `mcp-typography-checkpoint-20260918.md`.

## Historical continuation after bdad659f

The old analysis function-length issue was resolved at `7ac32e96`. Internal
selective application/recovery was implemented at `4decdbcd`, reusing native
transactions and font/source-size appliers. Evidence validation, job ownership,
tool composition, one test-lint finding and two exact architecture declarations
were still outstanding then. These are no longer current blockers.
Original evidence: `mcp-typography-selective-checkpoint-20260918.md`.

## Historical bundle 3 observation-only continuation

The observation-only authority was `mcp-selection-checkpoint-20260918.md`, source
`79bfec3b`. Selected saved-block/region OCR, text-only selected translation and
owned paginated analysis passed all 26 gates with 7,746 tests passed, zero failed,
11 existing skips; 932 MCP tests passed across 128 files. No page changes occur
during analysis. Language/provider/context options are task-local and explicitly
permitted. Existing single-block functions remain compatible.

At that checkpoint the application projection write was refused, so reviewed
apply/append/reference editing and exact recovery were not registered. Those
missing parts are now implemented in the current connected checkpoint above.
No live acceptance was performed or inferred from either automatic test run.
