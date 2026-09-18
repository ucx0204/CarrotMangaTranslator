# MCP typography implementation checkpoint - 2026-09-18

## Latest continuation: selective application core

Current resume authority: `mcp-typography-selective-checkpoint-20260918.md`.
The analysis function-length issue below is historical and was resolved in
`7ac32e96`. The internal selective font/source-size projection, guarded snapshot
mutation and exact batch undo/redo core were published as `4decdbcd`.

Bundle 1 is still IN PROGRESS. Original-file/catalog/profile freshness and owned
observation lookup must be connected before registering remote application tools.
No new application tool has been exposed. One new test-lint finding and two
architecture consumer declarations remain after a tool request was refused.
Do not copy the synthetic validation callback from fixtures into production.

The latest automated results, coverage measurements and exact next tasks are in
the selective checkpoint and `mcp-typography-selective-coverage-20260918.md`.
Do not treat the older test counts or older unresolved production lint below as
current. Bundles 2-13 and all live acceptance remain deferred as instructed.

---

## Historical independent-analysis checkpoint

## Current continuation: bundle 1 observations connected

The 1-13 order and deferred-live-test requirement are fixed in
`mcp-remaining-roadmap-20260918.md`. Bundle 1 is IN PROGRESS. Bundles 2-13 have
not started. Never count font observation as style application.

Published this continuation: `c2e42e16` roadmap, `c9e494e1` C23 cleanup fence,
`4f396dcd` independent C23/multi-page source-size observation implementation, and
`f2a26596` final automatic-test, cancellation/stage-reporting and coverage checkpoint.
The existing font list, typography preflight and single-page source measurement
remain. `carrot_run_typography_analysis` is registered in app composition and the
strict output contract (60 registered output schemas).

Its explicit scope contains 1-50 ordered pages, at most 1,000 saved blocks,
current revisions and preflight/catalog snapshots. Size-only mode never invokes
OCR/models/downloads. Font modes use the existing C23 Japanese-to-Korean port
and require explicit OCR and app-managed asset-download permission. Installed-only
C23 preparation is not exposed yet. No translation, erasure, rendering, font
application, page save or file attachment is performed by this observation tool.

Raw font observations are NOT approved style changes. Manual profile locks must
still be checked at the later application boundary. Source face pixels are NOT
nominal fontSizePx. Observations bind original hashes, chapter/context identity,
profile/catalog/runtime descriptors and expire after 30 minutes or restart.
Only receipts survive; status never silently reruns an expired analysis.

Canonical C23 inference/assets are unchanged. Shared model cleanup must settle
before completion or new model admission; combined inference/cleanup failures
retain both causes. App jobs, page handoffs and the existing journal are reused.
Automatic fixtures substitute the C23 engine/native raster loader boundary, not
the source-size math, library transactions, leases or HTTP authorization.

## Remaining implementation and current caveats

Selective font/source-size application, omitted-field restoration, work-profile
lock handling and exact Undo/Redo are NOT implemented. An application-adapter
write was refused by the tool safety checker; no application helper was installed
and no alternative route was used for that rejected request.

One lint finding remains: McpTypographyAnalysisService.run has 86 nonblank code
lines against the existing limit of 80 after truthful performed-stage reporting.
The attempted refactor was also refused and was not applied. Do not disable or
increase the rule or remove the behavior to claim success. Resume with that small
function split, then the missing selective application/recovery work.

## Current automatic verification

The final full Vitest/V8 run exited 0: 7,623 passed, zero failed, 11 existing
skips (914 test files passed, one existing file skipped). All 809 MCP tests in
109 files passed. The earlier scoped new-module measurement passed 818 tests
across 112 files, including the C23 lifecycle/pipeline/application regressions.

The production coverage gate passed: 753 baseline and 813 introduced records,
10 unchanged deletions. All 1,558 inherited records and original provenance were
compared directly with fbfe656c and retained unchanged. Eight measured new rows
were added. A one-page executor rejection regression preserves the original
source-size adapter coverage floor after shared geometry projection extraction.

Renderer, Electron and JavaScript type checks passed, architecture and formatting
checks passed, and the normal Windows build exited 0. This is NOT an all-26-gates pass: the
function-length lint finding described above remains. No lint/coverage rule was
weakened. New actual-model/native/client acceptance was not run.

The initial full test pass found the new fixture incorrectly persisting a runtime
`dataUrl` field; the fixture was corrected to match the existing strict stored
schema. Production storage validation was not changed. Cancellation keeps the
actual app job and all selected-page leases until the external engine settles.

Logs:
`.tmp/mcp-typography-analysis-final-tests.json`
`.tmp/mcp-typography-analysis-final-coverage.log`
`.tmp/mcp-typography-analysis-final-floors.log`
`.tmp/mcp-typography-analysis-build.log`
`.tmp/mcp-typography-analysis-full-lint.log`

See `mcp-typography-analysis-coverage-20260918.md` and
`mcp-typography-analysis-boundaries-20260918.md` for exact scope and limitations.

No live app restart, user-library/original/auth change, real C23 inference,
model asset replacement, Tailscale/ChatGPT call, file-delivery retest, new branch,
master merge or release is part of this continuation. Live acceptance is deferred
until all bundles are implemented as explicitly requested by the user.

---

## Historical checkpoint before this continuation (fbfe656c)

The section below describes the previously verified source-size/read checkpoint,
not the current connected analysis tool or current full-check status.

### Historical status

Font inventory, typography preparation and one-page source-size observation are
implemented, registered and verified. This is a PARTIAL typography bundle:
independent C23 font-model analysis and selective source-match application/undo
are not implemented. Do not call the full typography bundle complete.

Verified code: `af9dcbae` on `feat/mcp-app-bridge`, in the existing review worktree.
No new branch, master merge, release, live application restart, user-library edit,
credential change or model-asset replacement was performed.

## Registered capabilities

- `carrot_list_fonts`: reads actual app catalog/registry metadata, with search,
  pagination and a metadata snapshot. No legacy font migration, directory creation,
  font installation, model work or font-file transfer. Requires `carrot.read`.
- `carrot_preflight_typography`: returns explicit ordered pages, current revisions,
  source-size/font eligibility, exclusions, OCR requirements and limitations.
  It does not reserve execution or start processing. Requires `carrot.read`.
- `carrot_run_page_source_size`: measures the original raster of ONE saved page
  using the existing app `estimatePageSourceFontSizes` implementation. Requires
  `carrot.read` and `carrot.process`, not image-transfer permission. Returns a job
  receipt; poll `carrot_get_job` until terminal. No attachments or output files.

The source-size operation runs no OCR, model, download, translation, erasure,
rendering or page save. It returns source glyph face pixels, confidence, method,
per-block exclusions and the original image SHA-256. It inspects at most 1,000
saved blocks; generated lettering, sound/SFX, empty source and manual-size blocks
are excluded. There is no manual-size override or multi-page source-size job yet.
Insufficient raster evidence is reported as null, never a guessed font size.

Preflight advertises `analysisToolAvailable` and `analysisTool` only when the
source-size executor is actually registered and the request selects one page,
size-only mode and manual-size preservation. Font, combined, multi-page and
manual-override requests do not advertise an implemented analysis executor.
`inputs_available` is NOT model/file/lock readiness. Font analysis preparation
still describes the existing C23 Japanese-to-Korean and explicit OCR conditions.

Catalog snapshots bind registry metadata, not font bytes. Base face metadata is
not a complete face inventory or per-string glyph-coverage guarantee. Missing or
unsafe custom files follow the existing registry policy; uninspectable registered
custom files are marked. No font binaries or local paths are exposed.

## Observation, execution and restoration boundaries

Source measurement uses the existing app job and page ownership/handoff path.
It validates strict opaque IDs, unique blocks, original-image geometry and the
saved page revision before processing. It rechecks page revision, chapter
membership/order, authorization and original-file hash before returning evidence.
Exact repeated requests return the original job; changed input under the same
request ID is rejected. Existing job cancellation and ownership remain enforced.

Observations expire after 30 minutes or server restart. The existing seven-day
job journal keeps the receipt but removes measurement payloads and marks them
expired on restoration. Restart never silently remeasures or restores a stale
observation. Status remains metadata-only and does not create attachments.

Source face pixels are NOT nominal `fontSizePx`. Do not copy a measured value
blindly into an ordinary format edit. The existing `applySizeOptions` contract
stores source face/confidence/method separately and preserves source-match/manual
intent; that application and exact-state undo/redo boundary is the next work.
The current tool deliberately has no page mutation port.

## Verification completed

Final `node scripts/check.cjs` exited 0: all 26 repository gates passed, including
types, formatting, lint, error handling, test boundaries, architecture, dead code,
exact coverage inventory, Windows build and existing renderer/protocol checks.

- Full tests: 7,578 passed, zero failed, 11 existing skips.
- Within that full run: all 768 MCP tests in 105 files passed.
- Focused source-size/read tests: 37 across five files passed with a scoped V8
  measurement of the three new source-size modules; configured thresholds stayed on.
- Real HTTP: read-only callers cannot invoke the processing tool; read+process
  works without image-transfer permission. Unknown arguments are rejected, results
  are structured text only, polling completes and exact retries do not reexecute.
- Isolated Electron: actual font registry and read-only preflight passed without
  changing saved pages or originals. Actual registered source-size execution matched
  direct canonical raster-estimator output on identical input, with nonzero evidence,
  exact source hash, duplicate reuse and stale-revision rejection.
- Final native smoke exited 0 and also retained existing edit/undo, PNG/ZIP, actual
  renderer and authorization regression checks. Original and saved fixture data
  remained unchanged during the new observation operation.

The new raster/native checks do not use an inference stub for source measurement.
They use synthetic test artwork in an isolated library, not the user's originals.
Other existing native OCR/erasure checks still replace their expensive inference
boundaries. No new C23 model-quality or live ChatGPT/Tailscale invocation is claimed.
The running user app was not restarted; its exposed tools are not verified here.

Coverage provenance is in `mcp-typography-read-coverage-20260918.md` and
`mcp-source-size-coverage-20260918.md`. The 1,551 pre-read and subsequently 1,555
pre-source-size records were compared and retained unchanged. Seven measured rows
were added in total; current inventory is 753 existing, 805 introduced, 10 deleted.
Native adapter acceptance is not misreported as 100% Vitest adapter coverage.

Local logs and evidence:

```text
.tmp/mcp-typography-source-size-final-check.log
.tmp/check-results/vitest.json
.tmp/mcp-typography-source-size-final-native.log
.tmp/mcp-source-size-new-coverage/coverage-summary.json
.tmp/mcp-source-size-coverage-evidence.json
.tmp/mcp-typography-read-coverage-evidence.json
```

## Saved units and next implementation

`49c8f7fd` and `1a9dc101` preserved the earlier read-only implementation.
This continuation added `b5a10c31` native read verification, `f1afb8d1` read coverage,
`7a16c436` independent source-size execution, `9ec1dc55` source-size coverage and
`af9dcbae` internal-schema cleanup. Each was committed and pushed to the same branch.

Next: connect the existing C23 chapter font port as explicit bounded analysis,
keeping analysis scope distinct from the blocks selected for application. Preserve
manual font/profile locks, language/OCR permissions, original evidence identity,
model/asset identity, runtime cleanup and the shared model-exclusivity boundary.
Do not retrain or replace the approved C23 algorithms/assets, and do not add a
second general model queue. The existing port may require OCR and asset preparation;
these must remain explicit rather than being hidden behind a no-OCR promise.

Then bind inspected analysis results to a selective application plan, recheck
revisions and font availability, and reuse existing format-batch/page-save behavior.
Only extend it for the source measurement and font-size intent fields that ordinary
format patches cannot represent. Preserve omitted properties and exact before/after
state for undo/redo; never force fresh revisions into stale proposals.

Bubble layout/newline changes, advanced effects, permanent undo/output storage,
external generated images and UI redesign remain separate later bundles.
The earlier general analysis-result store was not created after a rejected tool
request. Its unused draft remains outside source in `.tmp`; it is not a registered
capability. The implemented raster-only operation instead uses the existing job
observation projection and does not represent completion of that broader plan.
