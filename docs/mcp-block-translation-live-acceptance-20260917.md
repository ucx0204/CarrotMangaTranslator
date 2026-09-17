# Block translation: live acceptance and integration checkpoint

Date: 2026-09-17. Continue on `feat/mcp-app-bridge` only.

## Status

`carrot_run_block_translation` is registered, returns proposals without saving, and was called successfully through the real `망번테스트` connector with the user's configured local Gemma. A Japanese-to-Korean proposal was explicitly applied through `carrot_update_translations`, inspected, and restored.

This is functional acceptance, not an all-gates-passing release. The Windows checkpoint workflow still fails five architecture budgets. The latest input-budget and endpoint-cleanup fixes are committed and tested on GitHub, but their deployment to the user's running app has not been verified. Remote Desktop Commander is offline; do not claim local/remote equality, a clean local worktree, a current local build, or process/VRAM measurements.

## Changes preserved during this continuation

The previously committed proposal service, adapter, context/options, session executor, job persistence, protocol/output contracts and native tests were continued, not recreated.

- `5fd4ccf9`: ten regression cases for proposal budgets and invalid numeric settings.
- `752e63e2`: check source/requested-output headroom even with `contextMode: none`; reserve the requested output allowance when pruning saved context. This uses the existing app estimate, not a provider tokenizer.
- `a399b457`: reject non-positive/non-integer context or output limits and non-finite numeric sampling JSON before a provider request.
- `25c0bf1b`: two endpoint shutdown regressions using the real session and the existing cleanup barrier, with only the stop-server side effect mocked.
- `d0600ec3`: concurrent `ModelEndpointSession.dispose()` callers await the same shutdown. Failed cleanup retains its target for explicit cleanup retry and never reopens the session for inference. A failed first shutdown can no longer be falsely acknowledged by a no-op second disposal.
- `aa84e816`: repository formatting of the new endpoint test only.

No architecture budget, coverage floor, security scope, model setting or fallback policy was relaxed. No batch scheduler, image input, OCR call or automatic application was added.

## Real connector test

Only the existing disposable synthetic fixture was edited:

- Work: `MCP Edge Audit 20260916`, ID `34a026df-b18e-48bc-9996-b22cc471150b`.
- Chapter: `Disposable synthetic pages`, ID `d288a495-0d67-49eb-88a8-62d246ebf897`.
- Page: `render.png`, ID `a0a65dc4-d0bc-4ef6-9c46-5f4d76ec6c5c`.
- First block: `mcp-f8a26f31c5ea0446e5f3a370d177f332`.
- Initial and final page revision: `page-v1:e77b3d32a89a69ec`.

Two generations were run sequentially. Both returned `engine: gemma`, `execution: local`, language pair `ja` to `ko`, and model `Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf`. No provider or language configuration was changed.

### Initial English fixture

Job `9d95417f-b7b0-411a-bae4-ba6fa87ede35`, request `a84b28c9-3246-45c2-ba2c-166052450941`, `contextMode: none`.

The saved source was `HELLO WORLD`. Under the configured Japanese source language, the model returned `HELLO WORLD` and the tool reported `same_as_source`. This was not recorded as a successful semantic translation. The job completed with `pagesChanged: 0`. Full block readback retained both blocks and the initial revision. Repeating the identical request returned the same completed job, not a second generation.

### Japanese fixture, explicit application and restoration

Using the existing scalar editor, the first block's source was temporarily set to `今日はいい天気ですね。`; the existing translation remained `첫 번째 테스트`. The page revision became `page-v1:5923292eaf7a2126`.

Job `f80d1fd3-4980-4359-8aa8-b17dc2bc79e2`, request `88734a2b-43f5-4123-84b8-2bdeb79a55c7`, `contextMode: none`, completed with:

- Source: `今日はいい天気ですね。`.
- Proposed translation: `오늘은 날씨가 좋네요.`.
- Previous translation: `첫 번째 테스트`.
- `pagesChanged: 0`, `requestCount: 1`, `needsReview: true`.

A fresh block read confirmed that generating the proposal had not applied it. Applying with the obsolete initial revision was rejected with `revision_conflict`. Applying with the proposal revision succeeded, changed only the first translation, and returned `page-v1:f3b8028c60b185ce`.

The first source and translation were then explicitly restored to `HELLO WORLD` and `첫 번째 테스트`. Full readback confirmed the initial revision and unchanged second block (`TEST PAGE 123` / `두 번째 테스트 😀`), stored typography, source/display rectangles and reading order. Modification timestamps and job receipts are not claimed to be rolled back.

### Additional live rejection checks

- Reusing the first request ID with the second block returned `invalid_edit` before a new generation.
- Retrying the already completed first job with a new request ID returned `invalid_edit`.
- Proposal/job responses contained no image attachment, file resource or download URL.
- No live OCR, erasure, rendering, export or image-file retrieval was called in this acceptance test.

## GitHub Windows verification

Final inspected run: `35182637720`, job `105077941931`; trigger commit `d0600ec3`, formatted checked tree `aa84e816`. The full job log and final step conclusions were retrieved after completion.

- Focused MCP and existing library behavior suite: **564 tests in 72 files passed**.
- Included translation service 10, adapter 14, budget 10, HTTP 3, and endpoint cleanup 2 tests.
- Windows application build: passed.
- Real Electron MCP smoke: passed to `PASS MCP native smoke finished`.
- Native hostile HTTP matrix: **203 checks across 29 production tools**.
- Native proposal case confirmed unchanged generation snapshot, one request/release, duplicate receipt reuse, translation-only apply/restore, raster change on application and restoration afterward, and intact source/erasure images.
- Synthetic settings layout assertions: wide, narrow, pairing and error scenarios passed.
- TypeScript checks (renderer, Electron and JavaScript), format, dependency-direction rules, error-handling lint, test mock-boundary policy, lint, unused exports, script inventory, maintainability and duplicate-code checks passed.

The workflow conclusion is **failure**, not success, because `arch:budget` reported:

- `src/shared/translationLanguages.ts`: runtimeImportedBy 31, limit 30.
- `src/shared/pageRevision.ts`: runtimeImportedBy 44, limit 43.
- `src/main/application/mcpEditPolicy.ts`: runtimeImportedBy 31, limit 27.
- `src/main/library.ts`: runtimeImportedBy 36, limit 34.
- `src/main/mcp/mcpPageOperationSession.ts`: runtimeImports 17, limit 16.

These same five failures were present in the preceding inspected run `35182106477` on `a399b457`, which passed 562 tests in 71 files before the endpoint regressions were added. No gate was disabled or hidden to report success.

The GitHub fixture generation replies are synthetic. Only the two live connector jobs above establish actual configured-Gemma execution. No live Codex/API provider, saved-context generation, restart expiration, cancellation, or complete model-quality matrix was tested in this acceptance session.

## Remaining integration work

1. Resolve the five architecture integration findings by a legitimate review/refactor. Keep the prior denied allow-list edit unapplied; do not hide dependencies in pass-through wrappers or change routes to bypass a denied write.
2. Retrieve/re-run the full repository coverage gate and reconcile the new module inventory with fresh measurements. The checkpoint workflow is a focused suite, not a fresh run of all repository tests or full coverage.
3. Restore Remote Desktop Commander connectivity and inspect local changes before fast-forwarding. Its device `4090desktop` repeatedly timed out and then reported offline with last_seen `2026-09-17T04:08:46.908+00:00`.
4. Build and apply the latest input-budget and endpoint-cleanup fixes after preserving user edits and normal shutdown. The live tool already worked, but this session did not update/restart the normal app, inspect its exact running commit, or verify actual process cleanup/VRAM.

The real acceptance used no ordinary user work. Synthetic source/translation content was restored through authorized app tools. Authentication and model settings were not changed. Do not recreate this feature because older notes still say live testing was unavailable.
