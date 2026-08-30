# Production cleanup scenario ledger

This ledger seals the observable contracts preserved by the August 2026
production cleanup. The sealed snapshot from the completed second-pass gate
documented in `codebase-cleanup-scenario-ledger.md` contains 466 Vitest files
and 3,372 total scenarios (3,370 executable and two macOS-only skips), with no
known failure. The executable snapshot used for exact-pair comparison is
`.tmp/production-cleanup-test-list-baseline.json` (SHA-256
`352a275cde3b1f5b5f34e222775cfd6c4d17522597e4a0c52a19bcca9cebfca4`).
That ignored snapshot is historical provenance, not a required gate input. The
durable reconciliation, the two accepted replacement mappings, and the
coverage floor policy are recorded in this tracked ledger and the tracked
manifest described below.

That snapshot predates the BeeLlama HIP stabilization already present in the
cleanup-start `HEAD` (`c12cd67`). The carry-forward commit added one test file
and ten executable scenarios: two runtime-archive ownership scenarios, two
Metal archive scenarios, four runtime-integrity scenarios, and two scoped ZIP
budget scenarios. They are not cleanup additions. The provenance-corrected
cleanup baseline is therefore 467 files and 3,380 executable scenarios (3,382
total with the same two skips).

No user API, IPC wire shape, stored data shape, migration, error policy, or
security budget may change under this cleanup. Consolidation is accepted only
when the table below names the owning production boundary and the regression
test that still detects the old fault.

| Area                                         | Consolidated responsibility                                                                                                                                                                                                                            | Preserved and added regression contracts                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic OCR barriers                        | Four route-local copies now call `pairCrossesDistinctRegionBarrier` in the canonical group-only review plan.                                                                                                                                           | Existing anime/group-only golden suites retain the two-lobe, singleton-fragment, merge rejection, lineage, adjacent-column, and ruby routes. `semanticOcrGeometry.test.ts` adds forward/reverse, same-side, malformed, and unrecognized-relation cases.                                                                                                                         |
| Semantic OCR geometry                        | Axis length/gap/center/overlap, area/intersection, and box union live in the semantic-OCR `box-geometry` leaf; candidate and recovery policy remain at their callers.                                                                                  | Existing group-review golden suites remain unchanged. `semanticOcrGeometry.test.ts` seals one-pixel boxes, touching boxes, zero overlap/intersection, full-axis overlap, and pair/multi-box union.                                                                                                                                                                              |
| Settings aliases                             | Shared canonicalizers own alias tables; IPC and runtime/stored surfaces explicitly retain their different empty, `auto`, Apple-Metal, and fallback behavior.                                                                                           | `settingsAliasSurfaces.test.ts` maps every accepted Gemma, Llama, ROCm, Flux, inpainting, Koharu, and OCR alias across both surfaces. It also seals IPC-only aliases, unknown rejection, runtime fallback, and empty-value behavior.                                                                                                                                            |
| IPC page shapes                              | Renderer and stored page schemas compose common path/content shapes while retaining independent IDs, `.strict()`, renderer `dataUrl`, and stored-page `dataUrl` rejection.                                                                             | Existing `ipcSchemas.test.ts` strict/union fixtures remain. `bubbleLayoutModel.test.ts` seals renderer-required and stored-rejected `dataUrl` behavior.                                                                                                                                                                                                                         |
| File traversal                               | TS and CJS boundaries remain separate; each now has one internal breadth-first traversal core.                                                                                                                                                         | `fileProbeTraversal.test.ts` seals depth, ignored directories, directory predicates, result limits, exact-name matching, and predicate matching.                                                                                                                                                                                                                                |
| Settings pair codec                          | Generation validation, JSON-object parsing, and stable pretty serialization live in a settings-pair leaf shared by public and secret storage.                                                                                                          | Existing settings commit/recovery/generation tests remain. `settingsPairCodec.test.ts` seals UUIDv4-only generations, exact newline serialization, malformed JSON, and non-object rejection.                                                                                                                                                                                    |
| Work context, Gemma types, and job terminals | Existing same-domain leaves own string normalization, the shared Gemma field type, and terminal status projection.                                                                                                                                     | Existing work-context merge and runtime profile/default tests remain; typecheck seals the type-only Gemma change. Job main/render/dispatch suites remain and the eight-status matrix seals exactly four terminal values.                                                                                                                                                        |
| ZIP extraction                               | The diagnostic extractor and filesystem collector seams were removed. Full yauzl preflight and staging extraction remain, and selected files are published by same-volume rename.                                                                      | `runtimeArchivePolicy.test.ts` uses real ZIPs for no-match, archive ordering, duplicate replacement, ROCm paths, exclusions, traversal, link/special entry, budgets, deadline, and cleanup. Existing ownership/publish tests retain old-runtime rollback. The source contract asserts zero selected-file `copyFile` calls.                                                      |
| Llama runtime allowlist                      | Exact executables and `LICENSE` remain explicit; DLL/SO/dylib/Metal files use the existing extension rule and ROCm kernels retain their path-scoped rule.                                                                                              | `runtimeModelLaunch.pipeline.test.ts` accepts the exact executable/license and extension/kernel matrix while rejecting unrelated data, executables, and documentation. macOS archive/runtime tests remain.                                                                                                                                                                      |
| Download completion                          | The CJS downloader validates the request contract before I/O and returns a frozen receipt. Same-destination work joins only under the same URL/SHA/expected/minimum-size contract. The TS caller trusts a current receipt and otherwise rehashes.      | Download budget/fallback suites seal malformed SHA, size bounds, contract mismatch, immutable shared receipt, checksum/partial cleanup, retry, cancellation, and metadata publication. `modelDownloadsReceiptFallback.test.ts` seals missing-receipt compatibility; `fluxDownloads.test.ts` seals stat drift/tamper fallback and removal of payload plus both metadata markers. |
| Font page consistency                        | Neutral-row grouping and vetted morphology projection/median are shared; route-specific sample counts, artifact validity, thresholds, candidate ordering, and missing-morphology policy remain local.                                                  | The 43 existing page-consistency and dominant-ordinary scenarios retain identical inputs and expected candidates, scores, and application results.                                                                                                                                                                                                                              |
| Typography controls                          | Gather mixed/touched state and Settings preset/default state remain separate adapters over shared presentational font, size, toggle, emphasis, alignment, and direction controls.                                                                      | Existing gather modal, format defaults, block-style preset, and style-preset editing suites retain mixed/default restoration, touched state, size bounds, size-to-auto-fit disable, emphasis, direction, and preset guards. Production-component QA at 1,440×1,200 and 760×1,400 verified focus, mixed/touched indicators, stacking, clipping, and scoped table overflow.       |
| Style Guide lists                            | Character and glossary rows remain domain-specific; section/toolbar/empty rendering and generic add/update/remove/bulk-delete actions are shared.                                                                                                      | `styleGuideUsageManagement.test.tsx` retains sort/search/filter, stable-ID edits, individual deletion, bulk cancel/confirm, usage-unavailable behavior, and selection pruning. Work-context usage/merge suites remain unchanged.                                                                                                                                                |
| Inpainting dirty-save                        | Only the save `try/catch` and failure callback are shared. Pending states, confirmation, translation keys, and execution order remain in each action.                                                                                                  | Selection save rejection retains its localized failed title/detail/status. Unified, bubble-layout, selection-job, and workspace UX suites retain all action-specific flows.                                                                                                                                                                                                     |
| Windows runtime paths                        | Runtime extraction/publication uses fixed-size same-volume sibling names, and legacy Windows paths are rejected before multi-gigabyte I/O when any selected, final, backup, integrity-sidecar, or claimed-archive path would reach the safety ceiling. | Runtime, ZIP, Flux CUDA, and download suites seal the pinned archive maxima, short managed root fallback, legacy-root discovery, `.s`/`.z`/`.b` sibling paths, claimed-archive budgeting, final-output validation, exact 252-character rejection, and explicit extended-length-path compatibility.                                                                              |

## Executable-scenario reconciliation

The final pre-cold-gate collection contains 474 files and 3,432 executable
scenarios (3,434 total with the same two skips). Its manifest is
`.tmp/production-cleanup-test-list-final.json` (SHA-256
`8a99dfc0f22f3b085bc7c44126db4a50f787e893c5254244ad7462a3479ece4a`).
After excluding the ten `c12cd67` carry-forward scenarios, comparing exact
`(file, full test name)` pairs with the provenance-corrected 467-file/3,380
baseline produces 54 cleanup additions and only the following two absent
baseline pairs. Both are deliberate contract-preserving moves from an injected
filesystem seam to stronger real-archive coverage; there are no unmapped
removals or unexplained renames.

| Baseline scenario                                                                                      | Replacement scenario                                                                                     | Preserved detection                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llamaRuntimePaths.test.ts` — `preserves ROCm kernel library directories when selecting runtime files` | `runtimeArchivePolicy.test.ts` — `renames selected files, preserves ROCm paths, and keeps archive order` | The replacement creates real ZIPs and verifies both `rocblas/library/*.dat` and `hipblaslt/library/*.hsaco` survive extraction at the exact relative paths, while excluded documentation stays absent. It additionally seals sequential-archive replacement and rename publication.                                                          |
| `llamaRuntimePaths.test.ts` — `includes extraction diagnostics when no runtime files match`            | `runtimeArchivePolicy.test.ts` — `rejects a real ZIP with no selected runtime files`                     | The replacement drives yauzl against a real no-match ZIP, preserves the `No runtime files matched`/archive-path/method diagnostics, proves an existing output remains intact, and proves the extraction staging directory is removed. Removed PowerShell-attempt and directory-list fields belonged only to the deleted test injection path. |

The 54 cleanup additions cover settings aliases/pair codecs (thirteen),
download/receipt contracts (thirteen), Windows path safety (eleven), real ZIP
replacement coverage (two), file BFS (two), Semantic OCR geometry/barriers
(two), IPC stored/renderer page separation (one), job terminal projection
(eight), and typography mixed/direct auto-fit behavior (two). The final cold
gate must retain these two mappings and report zero additional missing baseline
pairs; a changed count requires regenerating this comparison rather than
editing the totals by hand.

## Tracked touched-file coverage enforcement

- `scripts/production-cleanup-coverage-floors.json` is the persistent schema-2
  authority. It records cleanup base commit
  `01768a05a2e74666c1fd38f2b22e4efb1cf9822b`, `baselinePlatform=win32`, the V8
  JSON-summary provider, Vitest/coverage-v8 4.1.9, and the SHA-256
  `a0e1199f46a80734d228ff1772b99d1fde2f700321346da77abf9c29795e4c0a` of the
  ignored Node 22 baseline capture. The capture is provenance only; CI does not
  need it. Node 22/V8 12.4, Node 24/V8 13.6, and Node 26/V8 14.6 are the
  accepted runtime families. The review-04 outline-control capture on Node
  24/V8 13.6 extended
  the sealed scope. The v1.16.1 GPU compatibility pass extended that ignored
  Node 24 artifact to SHA-256
  `6f35a61cb6556ff31b4589913cdb79bb04faedab7c18228eac61ead3b2ad9157`.
  The stage-5 rich-text editor pass extended it again to SHA-256
  `67a7bc7478c11b299f75528fd69f2d7e96c467d6556b5abfbcbec2e1f92cbf61`.
  The multi-GPU detection pass extended it to SHA-256
  `2ddbe6e55074a92c6fd426591da5bfe4a788f8266a351894b819162090584933`.
  The Vertex AI service-account authentication pass extended it to SHA-256
  `acaa78c5367da5fa3584026c25287838c7f72a93fe37284024bfd1c48c9846bb`.
  The bubble-layout and residual-diagnostics pass extended it to SHA-256
  `5158abe8b85695337e8a9855eb4dee6c2acd786060d18f0388fb2da5e640bf5a`.
  The confidence-bound layout contract and split residual-diagnostics pass
  extended it to SHA-256
  `ced2e2f98095f7ae1153e0ff5b1ba56228cb1d7de6d0cee66b07c7ed5126e919`.
  The shared block-library pass extended the accepted Node 26 artifact to
  SHA-256
  `afc6c5a5931fe48dcacfee1dddc19a660726014ba334541d4bfb5f57c7000e0f`.
  The direct-input workspace zoom and temporary-hand pass extended it to
  SHA-256
  `b413467bb5a6f61953c79364a4924e6a53ce37031226d035af2632857f78c547`.
  The grouped retouch-toolbar and rectangle-restore pass extended that
  accepted Node 26 artifact again to SHA-256
  `9a874c66919ba8535edc9f04283d24b706e2b347c3dfe5a6a6f1ebb69f312a1f`.
  The linked automatic-result saving, export, mask, and output-control pass
  extended the accepted Node 26 artifact to SHA-256
  `088e4635662eec9c614faa223ca179ba2e653764003abd72aef46cc898db2080`.
  The renderer control consolidation and multilingual UI QA pass extended it
  to SHA-256
  `dd758d3ed51eaabbefd4476d6b03531a73bb8aa84e594fca0501b4404de7a834`.
  The Gemma VRAM placement and settings pass extended it to SHA-256
  `c889ab0c393d0e5664034fa5a830cd807262efc4cd0a292d2675ccf1cc302312`.
  The source-artwork font-size matching pass extended it to SHA-256
  `fc297c21bbba1d6e84e9ccaf6191e4e4d569c1c3975b0243411519a999c98132`.
  The Gemma speed-runtime and chapter typography scheduling pass extended it
  to SHA-256
  `aaec09cd2d708383846e36a1707f27377f54bbfef6cd5c273b30269785f1cb7a`.
  The page timing, cumulative-context detail, and VRAM warning pass extended
  the accepted Node 26 artifact to SHA-256
  `b93d3ca26db18942be260a93c20435f3bf439c7b2c464af1875ab1185c731d3b`.
  The official Codex App Server integration and dynamic model catalog pass
  extended it to SHA-256
  `182f6c68370827d3fc5b1713fbfa610cde1249ab26eef1b8d4daa5000f2f23a1`.
  The two-mode 120 MP tiled page-export pass extended it to SHA-256
  `7ce9d0dcab2d1ca9fdbe079727d1452b9e7f33006be06eef62a5240745fed769`.
  The page-processing timing checkpoint pass extended the accepted Node 26
  artifact to SHA-256
  `5c82e155cf67e81761352cfa7198f841200317d92dd8de660d5ada11ef26a87c`.
- The manifest pins the exact Windows covered/total counts and the diagnostic
  percentage for lines/statements/functions/branches in all 560 existing
  coverage-eligible `src/**` files changed since cleanup start. The 202 new
  eligible source files have their accepted post-refactor Windows ratios sealed
  as `introducedFloors`; they cannot regress to a merely present 0% record. The
  seven removed source files are recorded explicitly in `deletedFiles`.
- `scripts/check-production-cleanup-coverage.cjs` derives the eligible modified,
  added, deleted, and untracked source scope from Git on every run. A missing or
  stale manifest entry, unrecorded deletion, unsupported source status, missing
  source or coverage record, unvalidated Node/V8 or coverage-tool version,
  damaged JSON/schema/metric, count/percentage mismatch, or lower Windows floor
  fails closed. This makes a future touched file omitted from the manifest a gate
  failure instead of silently losing coverage. Floor comparison uses an
  exact cross-product of covered/total counts, so two ratios truncated to the
  same two-decimal percentage cannot hide a regression; a zero-total 100%
  baseline requires any newly instrumented items to remain fully covered, and
  a previously non-empty baseline cannot be bypassed by a zero-total current
  record.
- The canonical `npm run check` runs this gate immediately after fresh V8
  coverage. Windows compares all four exact ratios to both the pre-change and
  introduced Windows floors. macOS validates the immutable Windows manifest,
  current source scope, records, and metric integrity without treating
  platform-dependent execution as a cross-platform ratio regression. A native
  Darwin floor map is not claimed or silently substituted for the canonical
  Windows floors.
- The direct-input workspace zoom and temporary-hand capture passed all 518 Vitest
  files: 3,941 tests passed and the two expected platform-specific tests were
  skipped. Its aggregate V8 coverage was 79.44% lines, 78.37% statements,
  80.49% functions, and 70.80% branches.
- The Gemma speed-runtime and chapter typography scheduling capture passed all
  554 Vitest files: 4,187 tests passed and the two expected platform-specific
  tests were skipped. Aggregate V8 coverage was 80.23% lines, 79.08%
  statements, 81.50% functions, and 71.63% branches. The complete
  `npm run check` also passed build, page-artwork pixel parity with zero
  mismatched pixels, image-protocol smoke, and bundle guards in 210.53 seconds.
- The official Codex App Server integration and dynamic model catalog capture
  passed 560 Vitest files: 4,227 tests passed and the two expected
  platform-specific tests were skipped. Aggregate V8 coverage was 80.45%
  lines, 79.26% statements, 81.68% functions, and 71.84% branches.
- The page-processing timing checkpoint capture passed 580 Vitest files: 4,519
  tests passed and the two expected platform-specific tests were skipped.
  Aggregate V8 coverage was 80.98% lines, 79.72% statements, 82.30% functions,
  and 72.38% branches.

## Fail-closed obligations

- A malformed optional Semantic OCR relation is ignored, but a qualified hard
  barrier can never be bypassed in either direction.
- IPC-only aliases never leak into stored/runtime parsing, and unknown IPC
  fields remain rejected by strict schemas.
- ZIP central-directory policy is evaluated before selection; rename
  publication never weakens traversal, duplicate, size, ratio, deadline, or
  rollback checks.
- A downloader waiter with a different URL, SHA, expected byte count, or
  minimum byte count never inherits another request's bytes.
- A receipt is trusted only when it is frozen and its byte count, SHA, size,
  and final `mtimeMs` match the committed file. Missing or stale receipts use
  the original SHA verification path.
- Font consistency thresholds, candidate order, missing-morphology policy,
  mixed/touched formatting state, preset guards, selection pruning, and each
  inpainting action's localized failure message remain caller-owned.

## Windows path-length invariant

- No cleanup source path exceeds 77 repository-relative characters (108
  characters in the audit checkout). Packaged source names do not consume the
  user-data runtime path budget.
- Runtime staging, ZIP extraction, rollback, and metadata publication use fixed
  19-character `.s-<16 hex>`, `.z-<16 hex>`, `.b-<16 hex>`, and
  `.m-<16 hex>` basenames beside their final destination, preserving same-volume
  rename without repeating a long runtime or metadata filename.
- Ordinary Windows runtime paths fail closed at 252 characters, before archive
  extraction or download begins. ZIP preflight checks the extraction root,
  immediate output, outer final output, and both rollback roots for every
  selected entry. Explicit `\\?\` extended-length paths keep their existing
  Node workflow.
- Pinned llama archives carry audited maximum relative-path lengths. If the
  normal data-root tools directory is unsafe, the managed runtime uses the
  compact data-root-isolated `%LOCALAPPDATA%\MGT\d-<16 hex>` root. The old
  unnamespaced `%LOCALAPPDATA%\MGT\tools` root remains safe discovery-only; an
  explicit or fallback root that is still unsafe is rejected.
  Preflight includes the eventual `.mgt-llama-archive-<32 hex>` claim name, not
  only the shorter source archive and integrity marker.
- Hugging Face destinations continue to use compact content keys. The payload,
  partial file, metadata, and integrity sidecar paths are checked together;
  receipts and coalescing add no path segment.
- Existing Windows MAX_PATH tests for managed model/runtime paths, installer
  extraction, image protocol, page export, and inpainting remain mandatory, and
  the cleanup adds exact ZIP/download/final-CUDA path-budget faults.

## Production LOC accounting

Physical lines are counted from cleanup-start `HEAD` to the worktree across
`src/**`, including comments and blank lines and including new files. Shared
files are split by hunk: ZIP selection/rename, Llama allowlist removal,
download receipts, and BFS consolidation stay in their cleanup areas, while
only the later path-budget/compact-staging hunks are charged to Windows path
hardening.

| Area                                                     |     Added |   Removed |      Net |
| -------------------------------------------------------- | --------: | --------: | -------: |
| Semantic OCR barrier/geometry SSOT                       |       199 |       422 |     −223 |
| Settings aliases, IPC shapes, BFS, pair codec            |       403 |       673 |     −270 |
| ZIP cleanup and Llama allowlist                          |         7 |       160 |     −153 |
| Download receipt, coalescing, fallback, registry loading |       397 |       123 |     +274 |
| Font page-consistency pure helpers                       |       120 |       186 |      −66 |
| Typography dumb primitives and route adapters            |       551 |       603 |      −52 |
| Style Guide shared chrome/actions                        |       177 |       177 |        0 |
| Inpainting dirty-save helper                             |        67 |        52 |      +15 |
| Small terminal/projection/normalizer consolidation       |        24 |        67 |      −43 |
| **Original cleanup subtotal**                            | **1,945** | **2,463** | **−518** |
| Windows path hardening added after the user warning      |       534 |        57 |     +477 |
| **Final production total**                               | **2,479** | **2,520** |  **−41** |

The original −750 to −1,050 estimate is therefore not met. SSOT and UI
consolidation remove substantially more code than they add, but the receipt
contract and the mandatory Windows fail-closed path work deliberately retain
explicit validation, error metadata, fallback discovery, and regression-safe
publication logic. The ledger records the miss rather than counting test or
documentation deletion as production reduction.

## Verification results recorded before the tracked floor gate

- The pre-floor-gate `npm run check:cold` passed in 207,482 ms. All 474 Vitest
  files completed
  with 3,432 executable scenarios and the two expected macOS-only skips;
  architecture (1,310 modules/4,968 dependencies), mock-boundary, re-export,
  Knip, build, page-artwork parity, image-protocol, renderer-bundle, and
  preload-bundle gates all passed.
- Full V8 coverage passed every configured threshold: 78.96% lines, 78.04%
  statements, 79.65% functions, and 69.99% branches. Those are post-change
  verification totals, not the source of the pre-change floors: the sealed
  Node 22 baseline capture above is the source for existing-file ratios, while
  a fresh canonical run enforces the tracked manifest without reading either
  ignored provenance artifact.
- After adding the tracked floor gate, restoring the remaining contracts, and
  closing issue #65's unsupported-AMD OCR routing mismatch, a fresh Windows
  Node 22 run passed at 79.21% lines, 78.31% statements, 79.97% functions, and
  70.35% branches. The gate then compared all 80 pre-existing files and all
  eight introduced files without a lower exact ratio. The new
  `ocrRuntimeOverrides.ts` helper is sealed at 100% for all four metrics rather
  than a placeholder presence-only floor.
- Three complete warm `npm run check` runs passed in 197,573 ms, 198,937 ms,
  and 185,184 ms (197,573 ms median). No coverage result, changed-test gate, or
  disabled isolation was used.
- `npm run verify:hf-assets` verified all 27 pinned Hugging Face assets.
- `npm run dist:win` produced the v1.13.1 installer and verified an exact
  262-file, 751.7 MiB unpacked app-runtime payload. The installer inventory had
  282 ASCII-safe entries and a 79-character longest relative path; packaged
  OAuth, ONNX, and WebP runtime smokes passed.
- The destructive local installer smoke was intentionally not forced because
  this workstation has a production v1.12.2 installation registered. Its
  fail-safe refused the run before mutation. Apple Silicon Metal and macOS
  package gates require their macOS CI runner and are not claimed from this
  Windows verification.
- Production-component UI QA was completed at 1,440×1,200 and 760×1,400 for
  mixed/touched formatting, size-to-auto-fit behavior, focus/ARIA, preset
  guards, stacked narrow layout, and scoped table overflow. Temporary QA files
  and captures were removed after inspection.
