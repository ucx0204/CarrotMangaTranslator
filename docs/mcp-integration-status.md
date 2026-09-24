# MCP single-branch integration

The only MCP development branch is **`feat/mcp-app-bridge`**, draft PR #96. Do not create additional MCP/test/recovery branches, force-push, merge into master or release automatically. Tailscale Funnel only; encrypted persistent authorization is required. No Cloudflare fallback.

[First-page user test](mcp-page-testing.md) · [Connection guide](mcp-tailscale-testing.md) · [Functional contracts](mcp-page-goal.md) · [Coverage evidence](mcp-page-coverage-evidence.md)

## Current integration status — bundles 1–13

The first-page bridge has been extended through the thirteen-bundle roadmap using
the existing native storage, renderer, model execution and job ownership. Bundles
1–10 include typography and layout, selected OCR/translation/erasure, external
images, sound effects, durable history and outputs, sequential chapter jobs,
context/research and reviewed imports/library organization. Bundle 11 adds native
export formats, text/context exchange, explicit delivery evidence and approved
output synchronization. Bundle 12 adds bounded composite workflows and review.
Bundle 13 adds client diagnostics, connection guidance and the permission/results
UI. Source is published on this branch; final integrated acceptance is
PASS — implementation, full regression, fresh build, isolated native and six directly inspected production UI captures; actual user-client acceptance remains separate.

Read the [current roadmap](mcp-remaining-roadmap-20260918.md) and
[composite workflow contract](mcp-composite-workflows.md). The first-page sections
below are historical scope and evidence. Their old lists of future features and
session-only outputs do not describe the current retained-output/composite APIs.

| Final evidence                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified implementation source                | `f375a37f50b7ec5e9a655f9b63a791b2f0771bdc`                                                                                                                                                                                                                                                                                                                                                                                                   |
| Canonical stages and exact-source test result | PASS — `node scripts/check.cjs --cold`, 26/26 stages, exit 0; 458.451 s; completed 2026-09-24T06:52:57.795Z; PASS — all 1,229 physical files passed; 9,181 assertions = 9,170 passed / 0 failed / 11 inherited skipped; coverage SHA-256 `0b9d574fbd9dd8c8438bde764450ab2af10d218ad08236994c337ee2ee41f8de`                                                                                                                                  |
| Coverage and architecture registration        | PASS — 1,870 inherited serialized rows/metadata/deletions preserved; 65 measured additions; inventory 765/1,170/11; all 14 earlier gaps closed; same-source canonical floor gate passed; PASS — 22 reviewed ceilings published at ecab from the saved 0bb graph (2,500 modules / 11,802 edges / 0 layer/cycle errors); same-source canonical architecture stage passed                                                                       |
| Same-source build and source fingerprints     | PASS — same-source cold build, 13.882 s, `cacheHit:false`; exact build-step outcomes retained in acceptance evidence; PASS — 4,675 source fingerprints unchanged through canonical/native/UI; source/report digests, counts and Vitest stage timestamp binding verified                                                                                                                                                                      |
| Isolated native acceptance and cleanup        | PASS — 23/23 required markers, child exit 0; actual native import/context/review/output/restart boundaries, listener closed, owned profile/native fixtures removed, source and originals preserved                                                                                                                                                                                                                                           |
| Six actual production UI captures, all opened | PASS — six actual production captures, each opened and reviewed; automated layout checks passed; owned entries/profiles/captures removed, no cleanup warnings. Initial wrapper port checks were Windows 10035/undetermined; separate later Node ECONNREFUSED and Windows listener-table observations resolved the same six targets without rerunning QA; original failed wrapper retained. Descendant PIDs were not independently enumerated |

### Historical results before final registration

Intermediate results remain bound to their source: `b84bea4c` passed 26 canonical
stages with 8,975 tests and 11 inherited pending cases, but its extended native run
was not successful. At `33469783740da4f5dfd6688979a6c8c1aed2b1ac`, all 90
bundle-13 cases passed while the wider 742-case selection still had two failures.
The affected two-file/nine-case fixture regression passed at
`0bb9547bd6d3b30d88c771b48fabce6d6be3e24a`. Its subsequent full V8
measurement completed with 9,155 passes, one coverage-inventory failure and 11
inherited pending tests across 1,229 files; all 137 bundle-12 and 90 bundle-13
cases passed. The inventory assertion compared 763 registered existing files with
765 native entries. The later native floor audit additionally found 14 inherited
metric regressions across seven files and 65 missing measured rows, with all 1,870
inherited rows preserved. Its inventory was 765 existing / 1,170 introduced / 11
deleted files. All 4,675 source fingerprints matched. The 0bb architecture graph
had 2,500 modules and 11,802 edges with no layer/cycle errors; a reviewed 22-metric
budget candidate passed the same-graph checker but remained unpublished.

The test-only follow-up `24a8e9b54bbde14e27a446b6ce8d996b208ff77f` changes
seven test files and adds six cases. Actual Prettier/lint/TypeScript passed (3,537
roots), and the focused seven-suite run passed 27/27 with 4,675 source fingerprints
unchanged. Production source and thresholds were not changed. Its full V8
remeasurement was started; coverage recovery and final registration still require
actual results. These historical measurements and narrow passes do not replace the
final evidence table, and no GitHub CI result is inferred from a remote local run.

The completed 24a full remeasurement recorded 9,161 passes / one inventory
assertion failure / 11 pending across 1,229 files. Its actual native audit closed
11 inherited metric gaps and left three in `mcpLibraryImportSession.ts`.
`037fa1c4ecfcc5b8655d3cb1604af162c509f1d2` adds one 28-line regression to
the existing selection tests for a direct caller without `assertJobAuthorized`.
The diagnostic's 97 assertions and the target's four metric floors passed; the
filtered coverage process retained exit 1 and is not global acceptance. Its later
unselected V8 run recorded 9,162 passes / one inventory assertion failure / 11
pending in 1,229 files (9,174 total), with all 4,675 source fingerprints unchanged.
The raw coverage digest and exact timestamps are in the roadmap. At this historical
checkpoint the fresh floor audit and registration were still pending; a lone
inventory assertion failure did not establish that all inherited floors passed.

### Completed registration; integrated acceptance still pending

The actual 037 floor audit subsequently closed all 14 inherited metric gaps by
exact ratios, preserving all 1,870 serialized rows, metadata and deletions. It
adds 65 measured rows with inventory 765 existing / 1,170 introduced / 11 deleted.
`ecab24ade4b4a3ec7027a01100edd3f470031ed7` publishes this registration,
the inventory assertion and 22 reviewed architecture ceilings. The unchanged
budget checker passes against the saved 0bb graph (2,500 modules, 11,802 edges,
zero layer/cycle errors); unchanged production/collector inputs through ecab
establish continuity, not a fresh graph collection. See the
[registration evidence](mcp-composite-gates-20260923.json) for exact source bindings
and manifest hashes. The earlier V8 exit-1 results remain historical failures.
At this registration checkpoint, canonical/build/native/UI results were still pending; their subsequent source-bound outcomes follow below.

### Historical ecab canonical check

The ecab canonical command passed all 26 stages (exit 0) in 368.304 seconds, with
1,229 physical test files, 9,163 passes, zero failures and 11 inherited skipped
assertions. The same-source build passed in 14.475 seconds with `cacheHit:false`;
4,675 source fingerprints matched. Full timings, hashes and exact report bindings
are preserved in [final acceptance evidence](mcp-final-acceptance-20260923.json).
The preceding pending statements describe their historical checkpoints. Native
and all six UI captures had not yet completed at this canonical checkpoint; the
subsequent native failure and fixture correction are recorded below.

### Historical ecab native failure

Ecab's isolated native run exited 1 at 21:52:03 UTC on 2026-09-23, with 16/23
markers. All 4,675 source fingerprints matched, the advertised listener closed,
the owned Electron profile was removed and no owned native directories remained;
the wrapper did not time out. The isolated fixture had no editor and no responder
for the page-edit handoff requested by native CSV import. The three-script fixture
correction published at `ddc43675872629560830b787d252dd6b0faed256` supplies that acknowledgment only for its own pages and live native
edit job, while preserving native validation and original/cleanup errors. This
failure remains in the [acceptance evidence](mcp-final-acceptance-20260923.json).
At this correction-publication checkpoint, the final table awaited new canonical,
native and UI results from the corrected implementation. Ecab's earlier successful
check was not reused as that new run.

### Historical ddc cold canonical failure

The corrected fixture source ddc subsequently failed its cold canonical check
(exit 1, 542.115 s): 1,229 files, 9,162 passes, one existing 15-second timeout
in the exactly-full-work restoration/revalidation test, and 11 inherited skipped
assertions. The test stage took 463.835 s; all 4,675 source fingerprints and report
bindings matched. Nineteen stages passed before this failed test stage, and the
remaining build/native/UI work did not run. The complete failure is preserved in
[acceptance evidence](mcp-final-acceptance-20260923.json). At this failed checkpoint, final values were left pending the next source-bound
execution; neither timeouts nor worker limits were increased.

### Published test-contract separation

`99cd9cd822f034316f8c66011fb29d9d6c042bd4` separates two native capacity
contracts in one existing test file, preserving source preparation, native call
order, all 2,000 entries, publication dependence, full-promise cleanup and every
capacity assertion. Production, workers, timeouts and gate policies are unchanged.
Actual formatting/lint/TypeScript passed; both selected assertions passed, but
the diagnostic process exited 1 on unchanged selected-run coverage requirements.
That narrow result does not establish full coverage or total-runtime improvement.
The next cold canonical check is bound to the published 99cd source.

### Historical 99cd canonical pass and native failure

The 99cd cold canonical check passed all 26 stages: 1,229 files, 9,164 passes,
zero failures and 11 inherited skipped assertions, followed by a fresh same-source
build with `cacheHit:false`. All 4,675 source fingerprints and report bindings
matched. Its native run then exited 1 with 20/23 markers: all four bundle-11
exchange/delivery/saved-source/sync markers passed, while both composite markers
and the final marker remained false. Source preservation, listener closure and
owned profile/native-directory cleanup passed; there was no wrapper timeout.
No UI capture was executed. At this checkpoint the composite failure remained unresolved. These results stay
historical; the final table requires complete verification of the corrected
implementation.

### Published live-observation correction

`a4e6ce9aef7e5b83100302692904039f6cc9aad9` fixes the public view of a
completed child's durable native-outcome checkpoint while the same owner still
has a started execution refreshing its receipt/source. Only the returned clone
is shown as running. Durable recovery, restart without its active execution, failed refresh
and control states remain unchanged. The commit changes one service and two
existing test files. Candidate-aware static checks passed, and seven selected
files passed 39 assertions; the process remained exit 1 under unchanged global
and per-file coverage policies. Full source-bound coverage/native/UI acceptance
was still pending at this publication checkpoint.

The earlier cleanup aggregate remains preserved. Its nested errors were collapsed
in the native log; their individual causes were not recovered. The correction
retains error aggregation and does not modify or suppress cleanup failures.

### Historical a4e6 canonical pass and native failure

A4e6 passed all 26 cold canonical stages. Its 1,229 physical file results were
all passed; assertions were 9,166 passed, zero failed and 11 inherited skipped,
with a fresh 13.160-second build and 4,675 unchanged source fingerprints. The
full floor gate, including the changed composite service, passed. Native then
failed at 20/23 after the composite helpers progressed: the fixture's final
empty-error-list assertion received a normal cancellation `AbortError`. The two
composite markers and final smoke marker therefore remain false. Source and owned
cleanup checks passed; no UI capture was executed.

`McpOperationService` in the stack is the cancellation reason's creation site.
The actual reporting path is `McpExportBatchService.run`, which reported its own
cancel reason while returning the normal cancelled result. A focused correction
was under review at this checkpoint. This distinct failure does not recover the
unknown nested cleanup causes from the 99cd run; both records remain separate.

### Published batch cancellation-report correction

`f375a37f50b7ec5e9a655f9b63a791b2f0771bdc` changes only the batch report
condition and four added cases in its existing test file. It excludes the exact
own-signal reason only after that signal is aborted. Distinct abort exceptions,
cleanup failures and unaborted falsy errors remain reported; physical cleanup,
partial outputs, journal recovery, OperationService and native assertions remain
unchanged. Six static checks and 85/85 selected assertions passed; the changed
batch file exceeded its four floors, with all 4,675 source fingerprints unchanged.
The filtered process still exited 1 under unchanged global/other-file thresholds.
At publication, the new cold canonical run was active and native/UI had not run;
these selected results do not establish final acceptance.

Current-client acceptance remains separate: the logged-in user's refreshed tool
inventory, actual images/files received in that client, original artwork and model
quality, and live restart/reconnection require that final user session. Isolated
native HTTP byte checks, synthetic host review, metadata diagnostics and UI captures
do not establish those outcomes. Keep this PR draft on the same branch; no merge,
release, live-app restart, dependency reinstall or model change is implied.

## Current pairing and preference behavior

All four first-use preferences are checked: images, translation edits, local processing and auto-start. Existing saved choices and OAuth scopes are preserved. Enrollment is always available while MCP is online, without a five-minute enrollment button. Desktop code comparison and explicit approve/deny are still required; each browser transaction expires, requests are bounded, and stopping the server closes enrollment. This supersedes earlier timed-pairing instructions. See [connection guide](mcp-tailscale-testing.md).

## Historical deliverable: first complete page — September 2026

Source reads and crops, saved work context, external reading/translation block creation, optional local OCR-only processing, standalone local erasure, current-state app rendering and original-resolution PNG are implemented and published as source. Each is separately callable. The connected AI supplies the translation in this route; no Codex or paid text-model fallback is invoked.

Keep existing source/geometry/masks/styles and library transactions authoritative. New-block writes require current page revisions. The same activity/job gate protects local heavy operations. A second inference queue, renderer, OCR algorithm or library is not introduced.

Permissions remain separate: `carrot.read`, `carrot.images`, `carrot.edit`, and the new `carrot.process`. Enable local processing in app settings and explicitly authorize that scope. Existing grants are not expanded by a preference change. Valid connections retain their Tailscale address and OS-encrypted authorization after normal stop/restart.

## Verified first-page baseline

**Commit `421922d56f3d6cb00936cb90753442082a94b407`, Windows MCP run `34733470908`, completed successfully on 2026-09-13.** That checkpoint ran the focused suite, full Windows app build, real Electron page-chain and encrypted authorization smoke, production settings captures, and static gates including test-mock boundaries.

The native page chain executes real block persistence, mask construction, inpainting composition/history, renderer assets/fonts, original-resolution PNG and file-access revocation. Only the expensive model inference boundary is deterministic. This is not evidence of real OCR/model accuracy or a logged-in user's new-tool session.

## Resumed regression checkpoints

- `27f2027c` exports the exact source and coverage scope on this same branch. Source restoration matched the remote Git tree; no obsolete archive was treated as current source.
- `1c766a4b` adds three real preload/gateway regressions: validated MCP events, listener cleanup, dirty-editor reports, and inert test defaults. No application module is mocked and no coverage floor is lowered.
- `b01ca6f4` permits only the exact coverage JSON path in the existing source-checkpoint delivery workflow. It does not modify the coverage checker or thresholds.
- Checkpoint `e4b46d2e` was applied by the branch-local workflow. The destination coverage manifest blob is verified as `2dbc78e8abb70f92dc72b47165d17f7be03134f0`; 68 newly tracked rows use actual Windows measurements, while every previously recorded floor stays unchanged. The patch is removed after application, not left as the implementation.
- `085982c0` records the measurement run, artifact IDs and SHA-256 values in the coverage evidence document.
- Checkpoint `1ba5aabf` was applied in `789e5bc3`: native readback now proves crops still contain original text after erasure, crop-to-page coordinates are correct, the saved-context tool resolves the same work, and rendered previews contain translated lettering. The verified script blob is `fba38ab3661e2a202ac73992829114ef4f640ece`.

The previous PR-wide `Check` run `34733472515` had **6826 passing tests, one coverage-inventory assertion failure and 11 skipped tests**. It must not be reported as success. The inventory assertion exposed newly touched existing files and newly introduced MCP files missing from the existing coverage manifest. The follow-up preserves the checker, old floors and mock restrictions, adds measured rows, and covers the preload callbacks that had lowered existing ratios.

Locally the available focused suite passes **245 tests in 36 files** with `TMPDIR=/dev/shm`. The four erasure cases require an ONNX binding omitted from the offline Linux dependency kit; they remain enabled and must run in Windows CI. The new preload-focused run passes 24 tests; its single excluded all-IPC registration case has the same local binary limitation, not a source-level skip. CheckJS and focused ESLint pass for the native readback change. Final Windows MCP and full PR `Check` results must be read from the exact final run and recorded in PR #96 after completion; no pending job is a successful check.

## Publication and branch history

`53de254a` consolidated the original MCP branch and recovered source history. Three exact, already merged recovery references were removed after ancestry checks. Their commits remain reachable. No unrelated branch or user data was deleted. Users update the original clone with `git pull --ff-only`; old ZIP, patch import and additional-branch instructions are obsolete.

The user confirmed Tailscale/ChatGPT connection, persistent authorization and existing-text editing before this first-page milestone. Historical baseline `baf2df76` / run `34683291856` passed 183 focused tests, Windows build, native auth/preview and settings captures. It is not a substitute for current first-page verification.

## Historical first-page acceptance and then-remaining scope

Test one public, block-free page first. Read saved context and source/crops, submit the connected AI's reading/translation as editable blocks, request local erasure separately, then render and export. OCR-only is optional and does not translate. See the Korean first-page guide for prompts and job polling.

Derived output is currently blocked when external-image redaction is enabled; source/crops still follow the existing review guard. Do not disable protection for private material merely to pass a test. PNG links are single-file capabilities lasting ten minutes, invalidated by stop, revocation or relevant page changes. Session receipts/output links do not survive restart; stored page data and valid authorization do.

Actual model quality and the logged-in user's new-tool experience remain separate from deterministic tests. Independent app text-model execution, AI font matching, existing geometry/style/mask editing, SFX image generation, derived-layer review, durable multi-page jobs/ZIP, imports and research/context replacement remain future work. Do not describe this milestone as all app functions being exposed.
