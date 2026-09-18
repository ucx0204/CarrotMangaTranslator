# MCP remaining implementation sequence — 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
Starting verified checkpoint: `fbfe656c`. Preserve existing user changes first.
User instruction: implement bundles 1–13 in order, commit/push small units, and
leave an exact resume point when interrupted. Live tests are deferred until ALL
bundles are implemented; do not ask for a live test between development units.
Automatic unit/integration, type, lint, architecture, coverage and build checks
remain enabled. Do not restart the live app, modify user artwork/credentials,
replace approved model assets, merge master or publish a release implicitly.

| Order | Remaining bundle                                                                     | Status                                              |
| ----- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1     | C23 independent analysis; selective font/source-size application and exact undo/redo | Implemented; automatic checks passed; live deferred |
| 2     | Bubble layout, advanced typography, reusable rules/presets                           | Not started                                         |
| 3     | Remaining region/multi-block OCR, translation and block references                   | Not started                                         |
| 4     | Multi-block erasure, free/protected masks, localized correction/restoration          | Not started                                         |
| 5     | External image/mask upload, validation and layer incorporation                       | Not started                                         |
| 6     | Independent sound-effect preparation, text, generation and recovery                  | Not started                                         |
| 7     | Durable undo and retained output assets                                              | Not started                                         |
| 8     | Model-grouped sequential jobs, chapter batches and explicit resume                   | Not started                                         |
| 9     | Context merge/replacement, reference migration and multi-work research               | Not started                                         |
| 10    | File/web import and library organization                                             | Not started                                         |
| 11    | Extra export/exchange formats and attachment/delivery diagnostics                    | Not started                                         |
| 12    | Composite workflows and bounded automated review                                     | Not started                                         |
| 13    | Client compatibility, diagnostics, installation and UI/UX                            | Not started                                         |

Live C23 quality, model cleanup, actual originals, PNG/ZIP attachment reception,
download byte/hash checks, restart/reconnection and end-to-end client acceptance
belong to the final integrated live-test queue, not intermediate completion claims.

## Current bundle 1 completion and next implementation

Bundle 1 is implemented and its six selection/recovery tools are registered.
All 26 repository gates passed at source `96cc3625`: 7,668 passing tests,
zero failures and 11 pre-existing skips; all 854 MCP cases passed. Previously
blocked source validation, owned-observation binding and static findings are
resolved. See `mcp-typography-connected-checkpoint-20260918.md` for exact scope,
coverage provenance, limitations and verification evidence.

Next: bundle 2, independent bubble layout, advanced typography and reusable
rules/presets. Do not repeat bundle 1 or require an intermediate live test.
Session-only recovery is not durable undo; bundle 7 remains separate.

## Historical bundle 1 checkpoints

The following notes describe the earlier partial implementation before the
connected checkpoint above; they are retained as history, not current blockers.

The observation half is now connected: `carrot_run_typography_analysis` uses
existing C23 analysis or multi-page raster measurement, with explicit permissions,
ordered input snapshots, actual page ownership, expiring job evidence and model
cleanup fencing. No style application is implied by the returned font choices.

Do not start bundle 2 yet. The exact remaining order inside bundle 1 is:

1. Resolve the recorded 86-versus-80 function-length lint finding without changing
   the behavior or weakening the rule; the attempted refactor was not applied.
2. Finish analysis-bound selective font/source-size application using the canonical
   app rules, including manual profile locks and exact omitted-field restoration.
3. Connect inspect/apply/undo/redo with the existing page transaction and recovery
   paths, refusing later page/catalog/context conflicts and duplicate reapplication.
4. Finish automatic gates and update the feature-to-service/tool coverage map.

An application-adapter write and a later small lint refactor were refused by the
tool checker. Neither was retried by a different route. Source observation is a
separate implemented capability, not a claim that application/recovery is complete.
Current automatic verification and published checkpoints are recorded in
`mcp-typography-checkpoint-20260918.md`; final live acceptance remains deferred.

## Latest continuation after bdad659f

The old analysis function-length issue is resolved (`7ac32e96`). The internal
selective application/recovery core is implemented (`4decdbcd`), with shared
batch lifecycle/transactions and canonical font/source-size appliers. The remaining
bundle-1 work is now production evidence validation/owned-job lookup and MCP tool
composition, plus one test-lint finding and two exact architecture declarations.
No new remotely callable application tools have been registered. Do not move to
bundle 2 or request live tests yet. The authoritative details and automated
results are in `mcp-typography-selective-checkpoint-20260918.md`.
