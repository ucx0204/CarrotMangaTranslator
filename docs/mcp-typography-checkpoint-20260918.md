# MCP independent typography checkpoint — 2026-09-18

## Current status

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
