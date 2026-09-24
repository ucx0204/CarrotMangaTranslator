# Single-block translation proposals

Status: implemented, connected, and tested through the actual connector with the user's configured local Gemma. See `mcp-block-translation-live-acceptance-20260917.md` for the proposal/apply/restore evidence. Five architecture budgets, full coverage verification and deployment of the latest safeguards remain open; this is not an all-gates-passing release. `mcp-block-translation-checkpoint-20260917.md` identifies the continuation point.

## Scope

`carrot_run_block_translation` proposes a translation for exactly one existing saved block. It does not run OCR, prepare or transmit images, erase text, alter typography, save page content, update story memory, or export files. It uses the existing app model transport, page handoff, job manager, and local model cleanup barrier.

The request contains `chapterId`, `pageId`, `blockId`, the current `revision`, a new UUID `requestId`, and optional `contextMode` (`saved` by default, or `none`). Do not send a path, API key, replacement source string, or provider override.

Proposal generation requires `carrot.read` and `carrot.process`. Applying a proposal uses the existing translation editor and its editing approval. Image-transfer approval is not required for this text-only operation.

## User workflow

1. Read `carrot_get_page_blocks` and identify the exact saved block and revision.
2. Run `carrot_run_block_translation` once with a new request ID.
3. Poll `carrot_get_job` with that job ID, leaving a few seconds between calls. A receipt is not a completed translation.
4. On `completed`, inspect `result.status` and `result.blockTranslation`. Empty source produces `no_source` without inference, not a translation proposal.
5. Compare `sourceText`, `previousTranslatedText`, and `translatedText`. Preserve the returned proposal revision.
6. Only when application is requested, call `carrot_update_translations` for that block using the proposal revision. Do not fetch a newer revision merely to force an old proposal through.
7. Inspect the saved page. Explicit restoration uses the previous translated text and the current revision, not an automatic undo or another model request.

Example requests in conversation:

> Translate this saved dialogue with the app's configured engine and compare it with the old translation. Do not save yet.

> Apply the proposed translation only. Preserve source text, rectangles, styles, masks, images and the other blocks.

If the user already requested generation and application, these are still separate tool stages, but no redundant confirmation is required within that approved scope.

## Context and privacy

`saved` selects bounded saved work rules, glossary and relevant character information, plus earlier-page memory using the existing app formatter and budget. It does not research the web or create new memory. `none` sends only the selected source string and required translation instructions/identifiers. An external provider receives that text and permitted context and may charge for the request.

Both modes check the source/requested-output budget before starting a provider. The budget is the existing app estimate, not an exact provider tokenizer. Invalid configured limits or a request that cannot reserve its output budget are rejected rather than silently changing settings. Sampling JSON may contain only supported finite scalar values.

The proposal records the actual language pair, provider/model label, execution type, context mode and context revision. Context is rechecked before returning the proposal. Generic translation editing checks the page revision; it does not atomically validate the context revision at application time. Reinspect relevant saved context before applying an old proposal. A context warning is not an automatic retry.

Proposal text remains in the in-memory owned job result. The durable job journal excludes source text, prior/new translation and context evidence. After restart, metadata can survive but `proposalExpired: true` means that the proposal must not be assumed recoverable.

No status, list or proposal response adds a file attachment or download URL.

## Model behavior

Supported routes are the existing app-managed Gemma runtime, existing Codex text transport, and configured externally hosted HTTPS-compatible APIs. Unmanaged local API servers are rejected in this first version because the tool has no verified unload contract for them. This is a deliberate first-version limitation, not permission to start another local server or switch providers.

The task uses one generation attempt, no API-key rotation, no repair generation and no paid/model fallback. A transport failure with uncertain completion is not automatically resent. Reusing the identical request ID and arguments returns the existing job, not another generation. A deliberate retry needs a new request ID and the original target revision under the existing retry rules.

Local execution shares the app's exclusive model resource. The page remains owned while generation/cleanup is in flight. The model is released before the user reviews the proposal. Application is a separate lightweight page edit. Cleanup failure prevents successful proposal publication; it is not silently ignored. Concurrent endpoint-disposal callers await the same actual shutdown. A failed shutdown retains its cleanup target for explicit retry but does not reopen the endpoint for inference or silently clear the cleanup barrier.

## Output and limitations

The model must return strict JSON for the exact requested block ID and one nonempty bounded `translatedText`. Wrong IDs, extra geometry/style fields, malformed responses, empty text and excessive output are rejected rather than saved. Text identical to the source is flagged for review, not invented as a translation failure or success-quality judgment.

Existing generated lettering is retained; changing its fallback translation does not redraw that image. Review the warning and regenerate/replace it explicitly in a separate supported workflow. Stored typography and display geometry are preserved on application, but the changed text can legitimately wrap or fit differently.

This feature does not add batch translation, image context, OCR correction, automatic glossary updates, another provider, permanent undo, or a new model scheduler.

## Automated verification

Focused translation tests are `mcpBlockTranslation.test.ts`, `mcpBlockTranslationAdapter.test.ts`, `mcpBlockTranslationBudget.test.ts`, `mcpBlockTranslationHttp.test.ts`, `mcpTranslationEndpointCleanup.test.ts`, and the relevant cases in `mcpStructuredOutputs.test.ts`. They exercise real app policies/storage and mock only external boundaries.

`scripts/mcp-native-block-translation.cjs` is called by the existing isolated Electron page smoke. It checks an unchanged proposal-time chapter/raster, one request and release, exact retry reuse, translation-only application, visibly different rendering after application, identical rendering after restoration, and unchanged original/erased images. Its model reply is synthetic; it does not establish real provider compatibility or translation quality.

The real-provider acceptance used the existing disposable block, unchanged configured Gemma/language settings, two sequential generations, no automatic application, and explicit restoration. It validates that configured local route only, not every model, Codex, externally hosted API, or saved-context generation. Deployment and actual process/VRAM inspection of subsequent GitHub-only safeguards remain separate from that live result.
