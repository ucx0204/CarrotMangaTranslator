# Codebase cleanup scenario ledger

This ledger records where behavioural responsibility moved during the 2026-08
cleanup. A removed test is acceptable only when its production implementation
was unreachable or its assertions remain in the active contract named below.
Coverage threshold values and the complete `npm run check` gate remain in
force. The worker-client threshold path was corrected from its stale pre-move
location, so the intended per-file gate is now enforced rather than skipped.

| Removed or consolidated suite                                          | Disposition                                                      | Active contract that owns the scenario                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customFontMatchingCatalog.test.ts`                                    | Removed with the unreachable v1 custom auto-match cache/catalog  | `automaticFontMatchingV2.test.ts`, `autoMatchActiveCatalog.test.ts`, and `builtInFontMatchingCatalog.test.ts` keep the sealed built-in vocabulary, reject unverified custom auto-apply, and retain manual custom-font coverage separately.                                                                                                                                                                                  |
| `automaticFontMatching.test.ts`                                        | Removed with the unreachable title/genre v1 matcher and profiles | `automaticFontMatchingV2.test.ts`, `autoMatchActiveCatalog.test.ts`, and `builtInFontMatchingCatalog.test.ts` own active selection, locale/script/punctuation coverage, deterministic candidates, abstention, and fallback. The old title-regex policy is intentionally not part of production v2.                                                                                                                          |
| `fontMatchingSelectionConfidence.test.ts`                              | Removed with the superseded confidence policy                    | `fontMatchingSelectionCalibration.test.ts`, `fontMatchingSelectionCalibrationV2.test.ts`, and `automaticFontMatchingV2.test.ts` own corroboration, cohort calibration, role-family conflict, thresholds, and fail-closed abstention.                                                                                                                                                                                        |
| `chapterHistoryStack.test.ts`                                          | Removed with the unreachable chapter-only stack                  | `workspaceHistory.test.ts` owns undo/redo chronology, merge-window coalescing, bounded history, selection/block restoration, resource release, and failed async replay. The active 60-entry policy replaces the old 100-entry default.                                                                                                                                                                                      |
| `shareImportTrash.test.ts`                                             | Removed with the unused compatibility facade                     | `legacyShareTrashRecovery.test.ts`, `libraryTransactionArchitecture.test.ts`, and `mainProcessLifecycleArchitecture.test.ts` keep the persisted startup recovery implementation and lifecycle registration.                                                                                                                                                                                                                 |
| `sharePackageScale.test.ts`                                            | Consolidated into one production archive round trip              | `shareExportScale.test.ts` still exports and previews all `MAX_SHARE_CHAPTERS` entries through the production streaming ZIP path and asserts count, first/last ID, complete order, and reader order. `shareImportSelectedChapters.test.ts`, `workShare.test.ts`, `shareStreamingZip.test.ts`, and `zipSafety.test.ts` keep selective reads, real wiring, atomicity, cancellation, traversal, entry-count, and byte budgets. |
| live repository case in `reexportBoundariesCheck.test.ts`              | Removed as a duplicate execution                                 | `npm run check:reexports` remains the canonical full-repository gate; the Vitest suite keeps the parser and rule micro-cases.                                                                                                                                                                                                                                                                                               |
| generic framing/lifecycle cases in `inpaintingWorkerProtocol.test.ts`  | Moved to the generic client suite                                | `jsonLinesWorkerClient.test.ts` owns malformed/missing/unknown responses, oversized lines, absolute deadline/noise, abort ownership, disposal, spawn failure, and process-tree shutdown. Adapter tests keep backend launch paths, request mapping, large writes, backend error translation, and actual-process smoke.                                                                                                       |
| filesystem-backed pure cases in `inpaintingRevisionStore.test.ts`      | Moved to lower-cost focused suites                               | `inpaintingImageIO.test.ts`, `inpaintingLayoutState.test.ts`, and `inpaintingRevisionStoreState.test.ts` own path generation, layout capture/apply, no-op, completion, conflict, and direct-revert transitions. The original integration suite retains atomic multi-chapter replay, stale/path validation, artifact GC, rollback/retry, and post-commit cleanup failure.                                                    |
| locale, GPU, and bubble-padding settings form suites                   | Consolidated by shared form persistence boundary                 | `settingsFormPersistence.test.ts` preserves every normalization, default, explicit-selection, omission, and unrelated-field preservation scenario under separate feature `describe` blocks.                                                                                                                                                                                                                                 |
| `shortcutWheelCapture.test.tsx`                                        | Consolidated with the same rendered settings panel               | `shortcutsSettingsPanel.test.tsx` retains modified-wheel capture, non-zoom rejection, readable token rendering, canonical labels, aliases, and conflict preservation in one jsdom lifecycle.                                                                                                                                                                                                                                |
| packaged tar and ZIP runtime loader suites                             | Consolidated as a format table                                   | `packagedArchiveRuntime.test.ts` runs the same development lookup, packaged `app.asar` fallback, and unrelated-initialization-error scenarios independently for both `tar` and `yauzl`.                                                                                                                                                                                                                                     |
| page-relative offline ablation and training-only diagnostic suites     | Archived as rejected experiments                                 | `fontMatchingPageRelativeRoleQa.test.ts`, its consistency guard, and the library QA audit retain the production-default-off/QA-only boundary. Exact source hashes and restoration commands are in `font-matching-v2-rejected-experiments-source-archive.md`.                                                                                                                                                                |
| rejected fixed-body, v8.2 token-attention, and v6 hybrid Python suites | Archived as rejected experiments                                 | Current v7/v8 runtime exporters, runtime artifact/status tests, v10/v11 seals, v3 builders, and the production handoff remain authoritative. The archive manifest records hashes, authority, replacements, and restore commands.                                                                                                                                                                                            |

## Contracts that must never be removed for timing

- IPC schema/channel uniqueness and exactly-one main handler registration.
- Settings defaults, migrations, hardware/provider routing, and platform policy.
- Library transaction crash recovery, rollback, publication, locking, path safety,
  and quit cleanup.
- Share traversal and zip-bomb budgets, streaming atomicity, cancellation, trash
  recovery, and reference remapping.
- JSON-lines absolute deadlines, request-specific abort ownership, and process-tree
  termination.
- Production font runtime artifact binding, acceptance/status checks, QA-only
  fail-closed policy, and platform packaging/runtime identity.

## Second-pass performance baseline

The second cleanup pass starts from the last successful complete Windows gate,
not from an individual focused run:

- 462 Vitest files and 3,324 tests (3,322 passed, two macOS-only skips).
- The sorted `(file, full test name, status)` manifest has SHA-256
  `5fbe13044e397c8a1716923cde031471af6d2b0115727db8fd0be3b3c463280b`.
- Global coverage: 78.57% lines, 77.64% statements, 79.26% functions,
  and 69.44% branches.
- Warm complete-gate wall time: 204.87 seconds, including 137.61 seconds for
  coverage, 23.83 seconds for formatting, and 12.19 seconds for the build.

This pass does not delete another existing scenario. JSON-lines worker,
download retry, and font-runtime checks may replace real waits or repeated
hashing with injected clocks/transports and verified receipts, but the test
names and the externally observable contracts remain mapped one-for-one.

The following optimizations are explicitly rejected because they weaken the
gate or failed the measured suite: changed-tests-only coverage, coverage result
reuse, disabled Vitest isolation, the experimental filesystem module cache,
and an unvalidated global worker-count increase.

## Second-pass mutation obligations

The lower-cost tests must still fail when any of these faults are introduced:

- worker output noise extends an absolute request deadline;
- one request's abort is reported as `AbortError` for another request;
- disposal resolves before the child process exits or skips tree termination;
- a retry is omitted, or a permanent HTTP failure is retried;
- bytes with the wrong checksum are committed;
- a verified font artifact receipt is reused for different or tampered bytes.

Any future test deletion requires a separate ledger row naming the stronger
replacement gate and evidence that the replacement detects the corresponding
fault. Runtime alone is not sufficient evidence for deletion.

## Second-pass verification result

The completed pass retains every baseline scenario as a multiset, including
table-driven cases with duplicate display names:

- baseline: 462 files / 3,324 tests;
- final: 466 files / 3,372 tests (3,370 passed and two macOS-only skips);
- missing baseline scenarios: zero; newly added safety scenarios: 48;
- final sorted `(repository-relative file, full test name, status)` manifest,
  encoded as one compact JSON object per LF-terminated line, has SHA-256
  `23ca4d3f97e88952972f5b9aee3bf84c030b227bfbc9cb57756053cd292d45ba`.

The three complete warm gates took 179.68, 181.85, and 178.26 seconds. Their
179.68-second median is 25.19 seconds (12.29%) below the 204.87-second
baseline. Formatting fell from 23.83 seconds to roughly 8 seconds and the
check-only build from 12.19 seconds to roughly 8.2 seconds. After review added
the Electron-specific Node/CommonJS typecheck that seals the `--noCheck`
precondition, a normal build and the check build still produced the same 1,455
paths and 761,122,421 bytes. The canonical output manifest (sorted path, byte
size, and per-file SHA-256 records) has SHA-256
`25e01c62770b41fa28161a4215889f15498d1b0fce5f030531aa7faf10ed1b90`.

The build snapshot cache is implemented and remains fail-closed and opt-in.
It is deliberately not used by the default check: planning plus a verified
761 MB restore took about 14.38 seconds, versus roughly 8.2 seconds for a real
check build, so it failed the required five-second net-saving criterion. CI
and `check:cold` always bypass it. Vitest worker profiles likewise remain
diagnostic-only; CI and all default runs stay at four workers until peak RSS,
handle, temporary-I/O, and orphan-process measurements are available.

The final post-review cache-bypassed cold gate passed all 21 stages in 258.19
seconds, including 195.82 seconds for the cold coverage run; it is recorded as
a correctness gate rather than compared with the warm baseline above. Global
coverage is 78.62% lines, 77.69% statements, 79.32% functions, and 69.50%
branches. Existing second-pass production files meet or exceed every baseline
metric; newly extracted retry and installed-asset helpers are covered by their
production-default and fail-closed contracts.
