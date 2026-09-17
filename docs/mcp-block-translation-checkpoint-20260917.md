# Block translation checkpoint — 2026-09-17

## Current status

Implemented and registered: `carrot_run_block_translation`, one saved text block, proposal only. Application reuses `carrot_update_translations`. This is not a full acceptance closeout: the full repository gate and a real configured-provider/live-connector trial remain outstanding.

Continue on `feat/mcp-app-bridge` only. Do not restart implementation from the earlier `c937fcec` planning reference. At the beginning of this continuation both remote and PC were clean at `dcdad86a71939d7b76a7d15e78224aae1e60cf7a`, with the service, adapter, context/options, executor, job journal, tool/output contracts and initial tests already committed.

## Saved changes in this continuation

- `43353b41`: fixed discriminated result/PageRevision typing, reduced journal/composition complexity without changing semantics, and fixed cleanup being skipped when the release-progress callback throws. Pushed from the PC successfully.
- `87227e79`: added the isolated native proposal/apply/restore test through GitHub.
- `b389b54c`: corrected the native test's page type to the canonical chapter snapshot element.
- `18e21fd0`: connected that test to the existing Electron page smoke.
- `mcp-block-translation-testing.md` documents scope, permissions, privacy, provider restrictions and explicit application.

A regression was first observed failing: throwing while reporting `releasing_model` resulted in zero calls to session disposal. The adapter now separately collects progress and disposal failures, always attempts disposal, and preserves multiple failures. The regression passed after the fix.

## Confirmed results

| Check                                            | Observed result                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Focused service/adapter/HTTP/output suite        | 35 tests in 4 files passed, exit 0                                       |
| Renderer TypeScript check after fixes            | Exit 0                                                                   |
| Focused lint for the seven changed TS/test files | Exit 0                                                                   |
| JavaScript type check for the native integration | Exit 0                                                                   |
| Native script lint                               | Exit 0                                                                   |
| Windows application build                        | Exit 0                                                                   |
| Separate Electron MCP native smoke               | Process 51136 returned `NATIVE_EXIT=0`, process exit 0, about 34 seconds |

The native invocation included the new translation helper and its call from `mcp-native-page.cjs` in the local working tree. Those changes were subsequently preserved via the GitHub commits above when the remote PC stopped responding. The detailed final native-log tail was not retrieved after that loss of connectivity; do not invent an individual assertion count.

Native and HTTP translation model replies were synthetic. The tests use real app context selection, prompt/reply processing, page ownership, save transactions and native raster rendering, but do NOT prove real model translation quality, API availability, billing behavior or actual GPU unloading.

## Still outstanding

1. Retrieve the result of the full coverage test invocation (process 2868) from the log/exit file below. It was started and observed progressing, but its final count and exit status were not retrieved. Do not report the old suite count or an inferred count as a completed run.
2. Complete the repository architecture integration review. The initial `npm run check` failed with the following actual direct-consumer counts: language contract 31/30; page revision 44/43; typed edit errors 31/27; library facade 36/34; page-operation composition imports 17/16. The attempted scoped allow-list update was not applied because its tool request was rejected. The general limits and current allow-list are unchanged. Do not bypass this with hidden wrappers, copied domain logic, disabling checks, or a different route to a denied write.
3. Check the production coverage inventory against the new translation modules using fresh measured results. No coverage floors or historical provenance were lowered or rewritten. The full coverage gate has not been confirmed.
4. Reconcile the remote worktree with GitHub using a reviewed fast-forward workflow. The last confirmed local HEAD was `87227e79` with two native-file edits; GitHub now also contains those changes and documentation. Do not claim final local/remote equality or a clean worktree until checked. Preserve any new user edits; do not reset/clean indiscriminately.
5. Verify the actual configured provider with a bounded disposable-block request, then the updated live MCP tool. The production app was not restarted. The last successful `망번테스트` capability response still had `translation: false` and no new tool. Do not replace the missing live tool with an unrelated whole-page translation/OCR call.

## Logs on the user PC

Worktree: `C:\Users\sam40\Downloads\CarrotMangaTranslator-MCP-Review`.

Relative directory: `.tmp/mcp-block-translation-finish-20260917/`.

- `check-initial.log`, `check-initial.exit`: initial whole-gate failure; result typing and complexity issues were subsequently fixed.
- `release-regression-red.log`: reproduces the disposal omission before the fix.
- `focused-initial.log`: 35 passing tests after the fix.
- `typecheck.log`, `lint-focused.log`: successful focused static checks.
- `typecheck-js.log`, `lint-native.log`, `build.log`: successful native-script/static/build checks.
- `native.log`, `native.exit`: completed native smoke; exit 0 was directly observed.
- `coverage-full.log`, `coverage-full.exit`: full coverage run; final result still needs to be read.

Remote Desktop Commander subsequently returned device-response timeouts for log reads and ping, even though device discovery still reported online. Treat this as unconfirmed connectivity, not a Windows permission failure or proof that tests failed. No production processes were forcibly stopped or restarted.

## Data and security boundaries

This continuation did not modify the real user library, originals, authentication or model settings. Tests used disposable isolated library roots. No real provider generation/API calls were performed. No model key or auth token was exposed. Proposal generation has no page-write port, does not send images, and the journal strips private proposal text on persistence. After context changes during generation the proposal is discarded; applying later through the generic editor checks page revision and requires a separate context review, not an atomic context-version guarantee.

Keep existing local-model exclusivity, page handoff, cancellation and disposal barriers. No batch runner or new provider was introduced.
