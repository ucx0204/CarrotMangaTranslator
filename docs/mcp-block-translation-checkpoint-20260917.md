# Block translation checkpoint — 2026-09-17

## Current closeout

Completed on 2026-09-17: all 26 repository gates, 7,339 tests, a fresh native smoke and real Gemma saved-context apply/restore passed. The synchronized application was gracefully restarted; source and translation were restored. The five architecture exceptions and six measured coverage registrations are resolved. See `mcp-block-translation-closeout-20260917.md` for exact scope, evidence, preserved local changes and final deployment.

## Historical status before closeout

Implemented, registered and exercised through the actual `망번테스트` connector: `carrot_run_block_translation` proposes one saved block's translation without saving. Explicit application reuses `carrot_update_translations`. A real configured-Gemma Japanese-to-Korean proposal was applied, read back and restored on the existing synthetic fixture.

See `mcp-block-translation-live-acceptance-20260917.md` for exact live job IDs, restored page revision, new regression fixes and the completed Windows CI results. This supersedes the earlier statement that the live tool was unavailable.

This is **not a full integration closeout**. Five architecture budgets still fail. The full repository coverage run remains unverified. Remote Desktop Commander is offline, so deployment of the newest GitHub safeguards and final PC worktree synchronization have not been verified. Do not report a clean local tree or a fresh all-repository test count without checking.

Continue on `feat/mcp-app-bridge` only; do not recreate the implementation from the earlier planning commit.

## Latest verified continuation

- `5fd4ccf9`, `752e63e2`, `a399b457`: input/output budget regressions and fixes, including context-free mode and non-finite sampling values. No provider starts when the configured request cannot fit the app's estimate.
- `25c0bf1b`, `d0600ec3`: concurrent endpoint disposal awaits actual shutdown; failed cleanup retains its target for explicit cleanup retry without reopening inference. Regressions cover the real session and model cleanup barrier.
- `aa84e816`: formatting-only endpoint-test change.
- GitHub run `35182637720`, job `105077941931`: 564 tests / 72 files, Windows build, complete Electron smoke, 203 hostile checks / 29 tools, and settings layout checks passed. The job nevertheless concluded failure due to the five architecture budgets below. All other static checks executed by that workflow passed.
- Live `contextMode: none` jobs used the user's existing local Gemma, sequentially. `今日はいい天気ですね。` produced `오늘은 날씨가 좋네요.`. Proposal generation left the saved translation unchanged; explicit apply succeeded, stale apply failed, and the synthetic page returned to `page-v1:e77b3d32a89a69ec` after restoration.

The GitHub test model replies are synthetic. The live Gemma results are separate evidence, not proof that the latest remote-only safeguards are already deployed on the PC or that every provider/model is validated.

## Historical integration checklist (now closed)

1. Resolve architecture integration without bypassing the existing ratchets: `translationLanguages.ts` runtimeImportedBy 31/30; `pageRevision.ts` 44/43; `mcpEditPolicy.ts` 31/27; `library.ts` 36/34; `mcpPageOperationSession.ts` runtimeImports 17/16. A prior scoped allow-list write was rejected and remains unapplied. Do not hide dependencies in pass-through wrappers, duplicate domain logic, disable checks, or change routes to a denied write.
2. Retrieve the earlier full coverage result or rerun it after synchronization, then validate production module inventory against fresh measured coverage. No floor or historical provenance was lowered.
3. Reconnect Remote Desktop Commander. `4090desktop` last reported offline; it is not a GitHub write-permission or Windows-administrator failure. Inspect local status and preserve user changes before a reviewed fast-forward. Do not reset/clean indiscriminately.
4. Build and deploy the latest source after safe normal shutdown, then verify actual process cleanup. The live app was not restarted during this continuation; no new-code deployment or VRAM measurement is claimed.

## Earlier implementation history (not new verification)

At an earlier continuation both remote and PC were clean at `dcdad86a71939d7b76a7d15e78224aae1e60cf7a`, with the service, adapter, context/options, executor, job journal, tool/output contracts and initial tests committed.

- `43353b41`: result/PageRevision typing, journal/composition complexity, and disposal even when reporting `releasing_model` throws. A failing regression was observed before the fix and passed afterward.
- `87227e79`: isolated native proposal/apply/restore helper.
- `b389b54c`: native page type corrected to the canonical chapter snapshot element.
- `18e21fd0`: native helper connected to the existing Electron smoke.

Earlier PC checks observed 35 tests / 4 files, focused lint, renderer and JavaScript type checks, Windows build, and native process 51136 returning `NATIVE_EXIT=0`. Do not confuse these older PC checks with the later fully retrieved GitHub workflow log.

## Earlier logs on the user PC

Worktree: `C:\Users\sam40\Downloads\CarrotMangaTranslator-MCP-Review`.

Relative directory: `.tmp/mcp-block-translation-finish-20260917/`.

- `check-initial.log`, `check-initial.exit`: initial whole-gate failure; result typing and complexity were subsequently fixed.
- `release-regression-red.log`: disposal omission before its fix.
- `focused-initial.log`, `typecheck.log`, `lint-focused.log`: earlier passing focused checks.
- `typecheck-js.log`, `lint-native.log`, `build.log`: earlier native-script/static/build checks.
- `native.log`, `native.exit`: earlier native smoke completion.
- `coverage-full.log`, `coverage-full.exit`: full coverage invocation, process 2868; final result has not been retrieved.

No new local log retrieval, build, process inspection or code synchronization was performed while Remote Desktop Commander was offline.

## Data and security boundaries

The latest real test temporarily changed and restored only source/translation text in the existing disposable synthetic page. Final block readback preserved its other block, typography, source/display rectangles and reading order. Modification timestamps and job receipts may remain. Ordinary works, authentication and model settings were not changed.

Proposal generation has no page-write port, sends no images, and persistent jobs strip private proposal text. Context changes during generation discard the proposal. Later application through the generic editor checks page revision and requires separate context review, not an atomic context-version guarantee. Keep existing model exclusivity, page handoff, cancellation and disposal barriers. No batch runner, new provider or fallback was introduced.
