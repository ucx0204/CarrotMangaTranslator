# Bundle 3 selected analysis checkpoint - 2026-09-18

Baseline: `623a8838`; continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1 and 2 remain completed.
Bundle 3 is IN PROGRESS. Bundles 4-13 are not part of this continuation.
All real user/model/client acceptance remains deferred until all bundles are built.

## Implemented and registered observation slice

The actual app composition now registers three strict output contracts, bringing
the current output inventory to 77:

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

## Defects found and corrected

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

## Not implemented: exact next work within bundle 3

The new selection-edit projection creation was refused by the tool checker in
GitHub after the initial local write refusal. No such source file was installed.
The unconnected edit contract was removed, not exposed as a functional tool.

Still required, in order:

1. Owned analysis-bound selective source/translation application, rechecking the
   original dependencies at every forward commit and preserving unrelated fields.
2. Explicit selected region-discovery append through native block creation/order,
   with overlap review and exact session undo/redo, not blind array replacement.
3. Block character/glossary references: native IDs, enabled/valid targets, explicit
   field clearing, context-change conflicts, and exact optional-field recovery.
4. Corresponding tool registration, native persistence/recovery/HTTP tests and full
   acceptance before declaring bundle 3 complete or starting bundle 4.

Existing generic edit/create tools may accept manually reviewed observations with
fresh revisions; that is NOT the missing analysis-bound application/recovery path.
No source-update, auto-append or reference-edit capability is claimed by these tools.

## Recorded checkpoints and automated evidence

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
The final documentation commit changes no production/test code.
This verifies the observation slice, not the unfinished application/reference work.
No live app restart, user artwork/library/authentication change, real inference,
model download, ChatGPT/Tailscale call, master merge or release was performed.

Logs: `.tmp/mcp-selection-full-check.log`, `.tmp/mcp-selection-all-mcp.log`,
`.tmp/mcp-selection-coverage/coverage-summary.json`, and
`.tmp/mcp-selection-coverage-evidence.json`. The detailed boundary and provenance
are in `mcp-selection-analysis-boundaries-20260918.md` and
`mcp-selection-coverage-20260918.md`.
