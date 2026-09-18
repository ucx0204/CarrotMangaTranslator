# Bundle 3 connected selection checkpoint - 2026-09-18

Status: IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES PASSED; LIVE DEFERRED.
Baseline: `06b1a73c`. Verified full-check code: `10472c97`.
Continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. User/model/client acceptance is deferred
until all roadmap bundles are implemented. This record supersedes the earlier
observation-only selection checkpoint for the application/reference slice.

## Connected implementation

The existing selected OCR/translation observations now have six application tools:

- `carrot_preview_selection_batch`
- `carrot_get_selection_batch`
- `carrot_apply_selection_batch`
- `carrot_undo_selection_batch`
- `carrot_redo_selection_batch`
- `carrot_cancel_selection_batch`

All six are wired into the actual app composition and strict output contracts.
The output schema inventory is 83. Editing and processing must both be enabled
locally; preview/mutations require read/edit/process, while owned inspection uses
read scope. Existing observation tools and generic edit tools remain compatible.

The bounded target is one chapter, 1-20 pages and 100 explicit changes total.
Analysis application accepts only owned completed observation item IDs with the
matching page, mode and revision. The server derives source/translation text from
that record; transport cannot supply raw blocks or arbitrary replacement text.
Empty OCR/translation observations do not clear saved text. Generated lettering
is excluded. Source-only changes keep typography/masks and warn that retained
source measurements may need review; no implicit analysis is triggered.

Reviewed region discoveries use native block creation and containing-pixel bounds.
Overlaps require explicit approval, source strings exceeding the native creation
limit are rejected rather than truncated, and insertion may be at the beginning,
after a named existing block, or at the end. Other blocks keep their relative
reading order. This is not blind page replacement or automatic addition of every
region. New-block defaults use the existing public settings snapshot and canonical
normalizer without settings migration, writes or secret hydration.

Reference commands are separate from analysis commands. They validate native
unique enabled character/glossary IDs belonging to the current work. Omitted fields
are preserved; null removes a field; [] stores an empty glossary list. Saved block
reads expose only the reference IDs. No glossary, character or memory is rewritten.

## Native commit and exact recovery

The existing page-batch service and native page transaction are reused. Forward
commits recheck all observation dependencies, not only selected write targets:
page revisions, membership, context and OCR source hashes. Non-waiting dependency
read leases are acquired after native target handoff. Evidence has a fixed deadline
and is checked again at authorization before persistence. External filesystem
races are not claimed impossible.

A first conflict, failure or cancellation stops future saves. Earlier committed
pages remain explicit partial results, even if a later UI notification fails.
Historical action IDs never reapply. Cancellation is not rollback.
Undo restores the exact changed block snapshots, optional reference-field absence,
and original reading-order absence or legacy partial order; it removes only the
owned appended blocks. Later user edits conflict. Undo does not need an expired
observation or deleted context entry; forward redo still validates those inputs.
The native save may invalidate derived workflow status; this is block/order recovery,
not an arbitrary whole-page metadata rollback. History is session-only with a
30-minute idle lifetime. Permanent recovery remains bundle 7.

## Verified automatic results

Full repository check at `10472c97` completed successfully:

| Check                                                                           | Result                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Repository stage graph                                                          | All 26 stages passed, every exitCode 0           |
| Complete Vitest/V8 suite                                                        | 7,772 passed; zero failed; 11 pre-existing skips |
| Focused selection and structured-output regressions                             | 37 tests across seven files passed               |
| Renderer, Electron and JavaScript types                                         | Passed                                           |
| Lint, formatting, architecture, duplication, unused exports and mock boundaries | Passed                                           |
| Exact production coverage-floor gate                                            | Passed                                           |
| Windows build                                                                   | Passed                                           |
| Existing page-artwork parity, image protocol, renderer/preload bundle checks    | Passed                                           |

Canonical completion record: `.tmp/check-timings.json`, started at
`2026-09-18T15:41:13.486Z`, completed at `2026-09-18T15:44:27.736Z`.
The complete test results are `.tmp/check-results/vitest.json`; individual stage
logs are in `.tmp/check-logs/`. The terminal wrapper log is
`.tmp/mcp-selection-edit-full-check.log`.
The test digest is
`50f4ceea0055d0503f582c1e3a8b56c7bbbc52282326f026a132f820f75a9183`.
The complete coverage digest is
`2d5b12b24d0587395db79f15c0a3e6ec8477b53d81435e93581b4e8162738c21`.

The first full measurement had one inventory-registration failure, which was
resolved by registering the six actually measured new modules and updating the
inventory count. All 1,595 inherited floor rows, provenance and ten deletions were
retained; the manifest now has 1,601 records. No global coverage/architecture
threshold was disabled or lowered. See `mcp-selection-edit-coverage-20260918.md`
for exact initial metrics/hashes and the earlier MCP-only measurement limitations.

## Test boundaries and next implementation

The regressions cover actual native persistence, source/translation-only preservation,
discovery order, exact optional-field restoration, foreign ownership, changed
unselected dependencies, empty observations, cancellation, partial commits,
expiry, deleted context and real scoped OAuth/HTTP behavior. A repeated action
receipt does not reapply after undo. A later user edit blocks stale undo.

External OCR/translation inference and native raster boundaries are substituted;
actual library, source hashes, coordinate conversion, block creation, page/context
ownership, atomic persistence, recovery and OAuth/HTTP are executed in isolated
fixtures. These are not live model quality or user/client acceptance tests.
No live app restart, user artwork/library/authentication change, model download,
ChatGPT/Tailscale call, master merge or release was performed.

Bundles 1, 2 and 3 are now implemented with automatic checks passed and live tests
deferred. NEXT: bundle 4, multi-block erasure, free/protected masks and localized
correction/restore. Bundles 4-13 were not implemented in this continuation.
Detailed contract and architecture decisions: `mcp-selection-edit-boundaries-20260918.md`.
