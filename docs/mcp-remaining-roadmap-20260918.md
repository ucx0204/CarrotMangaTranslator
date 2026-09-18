# MCP remaining implementation sequence — 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
Starting verified checkpoint: `fbfe656c`. Preserve existing user changes first.
User instruction: implement bundles 1–13 in order, commit/push small units, and
leave an exact resume point when interrupted. Live tests are deferred until ALL
bundles are implemented; do not ask for a live test between development units.
Automatic unit/integration, type, lint, architecture, coverage and build checks
remain enabled. Do not restart the live app, modify user artwork/credentials,
replace approved model assets, merge master or publish a release implicitly.

| Order | Remaining bundle | Status |
| --- | --- | --- |
| 1 | C23 independent analysis; selective font/source-size application and exact undo/redo | Implemented; automatic checks passed; live deferred |
| 2 | Bubble layout, advanced typography, reusable rules/presets | Implemented; automatic checks passed; live deferred |
| 3 | Region/multi-block OCR, selected translation, reviewed append and block references | Implemented; automatic checks passed; live deferred |
| 4 | Multi-block erasure, free/protected masks, localized correction/restoration | NEXT; not started |
| 5 | External image/mask upload, validation and layer incorporation | Not started |
| 6 | Independent sound-effect preparation, text, generation and recovery | Not started |
| 7 | Durable undo and retained output assets | Not started |
| 8 | Model-grouped sequential jobs, chapter batches and explicit resume | Not started |
| 9 | Context merge/replacement, reference migration and multi-work research | Not started |
| 10 | File/web import and library organization | Not started |
| 11 | Extra export/exchange formats and attachment/delivery diagnostics | Not started |
| 12 | Composite workflows and bounded automated review | Not started |
| 13 | Client compatibility, diagnostics, installation and UI/UX | Not started |

Live C23 quality, model cleanup, actual originals, PNG/ZIP attachment reception,
download byte/hash checks, restart/reconnection and end-to-end client acceptance
belong to the final integrated live-test queue, not intermediate completion claims.

## Current authority: verified bundle 3 completion

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

NEXT: bundle 4, multi-block erasure, free/protected masks and localized correction
or original-pixel restoration. Do not redo bundles 1-3 or request intermediate
live acceptance. Keep the same branch/worktree, frequent commits and exact resume
records. Bundles 4-13 remain unstarted; permanent recovery is still bundle 7.

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
