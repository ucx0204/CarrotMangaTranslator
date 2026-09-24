# Bundle 3 selected analysis checkpoint - 2026-09-18

Current continuation: `mcp-selection-connected-checkpoint-20260918.md`.
The application/reference source files and six tools have now been added through
GitHub. The old write refusals and missing-tool statements below are historical,
not the current implementation state. Consult the connected checkpoint for the
latest automatic check result and exact resume point. Live acceptance is deferred.

## Historical observation-only checkpoint

Baseline: `623a8838`; continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1 and 2 remained completed.
At this historical checkpoint bundle 3 was IN PROGRESS. Bundles 4-13 were not part
of that continuation. All real user/model/client acceptance remained deferred.

## Implemented and registered observation slice

The actual app composition then registered three strict output contracts, bringing
the output inventory at that checkpoint to 77:

- `carrot_run_selection_ocr`: explicit source blocks or original-image rectangles.
- `carrot_run_selection_translation`: selected saved source strings only.
- `carrot_get_selection_analysis`: owned completed, paginated observation lookup.

One chapter, 1-20 selected pages, 100 targets in total. Native OCR crop rounding,
original pixel selection and result conversion are shared with the existing
single-block OCR path. Regions use native page-crop OCR, while existing blocks
use known-block-crop mode. Existing-source comparison and overlap IDs are returned;
no original, block, translation, layout, mask or image is changed.

Translation reuses the native text-only context/prompt/parser/runtime. It is one
sequential request per eligible block, not joint multi-block/chapter translation.
Expected provider must match the configured provider. Existing translations are
preserved by default; explicitly disable that protection for a proposal to replace
them. Empty-source and generated-image blocks are excluded. The request may select
languages and saved/no context without rewriting app settings or story memory.

External text engines require explicit allowExternal; managed local OCR/Gemma
requires allowAssetDownloads. Installed-only preparation and local compatible HTTP
servers are not exposed by this boundary. No implicit fallback, extra paid retry,
OCR during translation, translation during OCR, erasure, C23 or rendering occurs.

Start tools return a job receipt. Poll carrot_get_job, then use
result.selectionAnalysis.analysisId to read at most ten items per result page.
Cancellation uses the existing carrot_cancel_job and retains page/model ownership
until actual cleanup finishes. Failure/cancellation publishes no partial analysis;
completed earlier model calls may already have consumed resources or provider use.

Every selected page/context/membership and OCR original hash is verified before
publication. Evidence is fixed-lived for 30 minutes, bounded to 16 records and
one million serialized characters per analysis. Repeated reads do not extend it.
Durable receipts retain no evidence; restart never silently reruns an old request.
Owned results require the matching completed operation, not only a guessed UUID.

## Defects found and corrected in the observation slice

Native job entry resets execution settings unless explicitly provided. Selection
analysis now re-enters its captured settings inside that boundary; a regression
changes the surrounding settings between two calls and checks the pinned provider.

OCR release previously followed an unguarded progress callback. Reporting failure
could skip model release and crop cleanup. It is now collected as a failure while
cleanup still runs, and the original single-block adapter suite verifies it.

The old single-block tools remain compatible. Native pipeline, OCR runtime,
bubble detector, package/dependency manifests and approved model assets are unchanged.
Six exact shared-authority consumer/import declarations were recorded; global
limits stay 12 imports / 25 consumers. No duplicate model queue or parser was added.

## Historical missing application work — superseded by connected checkpoint

At the observation-only checkpoint, selection-edit projection creation was refused
by the tool checker. No such source file was installed at that time, and the
unconnected edit contract was removed rather than advertised as functional.

The follow-up implementation addresses that earlier list:

1. Owned analysis-bound selective source/translation application, rechecking the
   original dependencies at every forward commit and preserving unrelated fields.
2. Explicit selected region-discovery append through native block creation/order,
   with overlap review and exact session undo/redo, not blind array replacement.
3. Block character/glossary references: native IDs, enabled/valid targets, explicit
   field clearing, context-change conflicts, and exact optional-field recovery.
4. Corresponding tool registration, native persistence/recovery/HTTP tests and full
   automatic checks before declaring bundle 3 complete or starting bundle 4.

Existing generic edit/create tools still have their own contracts; they do not
implicitly gain the new analysis-bound application/recovery guarantees.

## Historical recorded checkpoints and automated evidence

`1ff6d581`: app/job/output connection. `bf5c9d51`: focused tests, frozen settings,
cleanup and static boundaries. `79bfec3b`: measured coverage registration.
The remote auto-format commit was retained; its single overlapping file was
resolved to the exact already-tested implementation. No force push was used.

MCP scoped regression: 932 tests passed across 128 files. Renderer typecheck,
lint, unused exports and architecture passed. All 1,588 inherited coverage rows,
provenance and deletion entries match baseline; seven measured rows were added.
New-module measurement: 213/218 lines, 228/235 statements, 64/64 functions,
110/119 branches. These are not whole-repository percentages.

Full repository check at `79bfec3b` exited 0 with ALL 26 gates passing.
Vitest/V8: 7,746 passed, zero failed, 11 pre-existing skips; 933 test files
passed and one existing file skipped. All 932 MCP tests / 128 files passed.
The exact production coverage-floor check, Windows build, page-artwork parity,
image-protocol smoke and renderer/preload bundle checks also passed.
The final documentation commit changed no production/test code.
This historical verification covered the observation slice only.
No live app restart, user artwork/library/authentication change, real inference,
model download, ChatGPT/Tailscale call, master merge or release was performed.

Historical logs: `.tmp/mcp-selection-full-check.log`, `.tmp/mcp-selection-all-mcp.log`,
`.tmp/mcp-selection-coverage/coverage-summary.json`, and
`.tmp/mcp-selection-coverage-evidence.json`. The observation boundaries/provenance
are in `mcp-selection-analysis-boundaries-20260918.md` and
`mcp-selection-coverage-20260918.md`. New application evidence and current status
are linked from `mcp-selection-connected-checkpoint-20260918.md`.
