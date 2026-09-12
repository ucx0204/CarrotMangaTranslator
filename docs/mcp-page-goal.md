# MCP first complete page milestone

Only branch: `feat/mcp-app-bridge`, draft PR #96. Tailscale only; preserve durable authorization. No UI redesign, releases, force pushes or extra branches. Commit every independently testable increment, not only the final feature.

[User test instructions](mcp-page-testing.md) · [Connection setup](mcp-tailscale-testing.md)

## Implemented acceptance route

A previously unprocessed page can be read by the connected AI, or optionally recognized by the app's local OCR. External reading/translation is saved as editable app blocks, originals are erased only when requested with the app's existing local engine/masks, and the existing app renderer produces both a reduced preview and original-resolution PNG. No Codex or paid-engine fallback occurs in this route.

- [x] Render current saved page and return a bounded result preview, distinct from source preview.
- [x] Read saved work overview, glossary, characters and memory without running research or translation.
- [x] Read guarded source crops with original-pixel coordinates and returned-image mapping.
- [x] Append external reading/translation blocks through revision-checked app transactions, preserving old blocks and exact retry semantics.
- [x] Run the configured local OCR independently on a block-free page and save untranslated readings.
- [x] Run local erasure independently through the existing page-pattern job, masks, image history and commit checks. Preserve text/styles and do not recalculate bubble layout.
- [x] Export original-resolution PNG and return bounded, expiring single-file access.
- [x] Exercise external readings, real app mask construction/erasure composition/storage, actual renderer, PNG dimensions/lettering and revoked-file refusal in native Electron. Heavy inference alone uses a deterministic test engine.

Every function remains separately callable. Rendering uses current block defaults/styles; it is not an AI font-matching or SFX generation job. Translation in this route is performed by the connected AI and submitted to the app; a separate app text-model translation tool is not yet exposed.

## Tools and ownership

`carrot_get_work_context`, `carrot_get_page_crop`, `carrot_create_page_blocks`, `carrot_render_page_preview`, `carrot_run_page_ocr`, `carrot_run_page_erasure`, `carrot_export_page_png`, `carrot_get_job`, `carrot_cancel_job` join the existing library/source-preview/block-reading/translation-edit tools.

Source/crop/render/export require image permission; external creation and local processing require `carrot.process`; changing existing translations requires `carrot.edit`. A local preference change never silently expands an old approval. Model assets may be downloaded by the existing app, but no model account is required by the transport itself.

Long operations return a request-deduplicated, OAuth-grant-owned job ID. Their executors acquire the existing application activity lease. Stop cancels owned work and invalidates outputs; a late cancel does not falsely promise rollback of a committed page. Receipt retention is session-local, about one hour after completion; app restart preserves authorization/page data, not an in-memory work queue. Reread the page after interruption before retrying.

Output links contain random single-file capabilities, not OAuth tokens or local paths. They last at most ten minutes, 64 MiB per file and 256 MiB per session, and recheck grant/revision/redaction on download. Anyone holding an authorized, unexpired link can fetch that one file. Derived images fail closed while redaction is enabled. Source/crop adapters recheck the existing redaction review gate before returning encoded images.

## Existing authorities reused

- Saved work context: `library/libraryContextFacade`.
- Pixel geometry/default formatting: shared bbox, block-format and block-geometry contracts.
- Block writes: public `savePageBlocks`, full revision/fingerprint/order check and original library transaction.
- OCR: `prepareOcrHintsForPages` and the existing configured OCR runtime, with no translation endpoint.
- Erasure: `startInpaintingJob` plus `productionInpaintingJobRuntime`; commit authority is passed into the existing inpainting transaction.
- Render: `createPageExportRenderSession`, original-resolution mode, existing renderer CSS/fonts and image protocol.
- Jobs: the same `ActiveJobStore` and app activity gate used by the desktop, not a second GPU queue.

Direct composition import/fan-in budgets are documented in `scripts/architecture-budget-baseline.json` for the public revision/library boundaries and MCP composition roots. Generic limits are unchanged, no algorithm was copied/moved, and no quality rule was disabled.

## Verification and recovery checkpoints

Resumed from `12e57bca9cfb4a0986bea15e9b6afe727b1a51aa`, which already held render/crop/context/external-reading implementations. The early isolated suite passed 206 tests. This continuation publishes actual source in small commits on the same branch, including receipts `e42222f`, artifacts `749b037`, native OCR/erasure/export adapters, commit-time regressions and the final assembled runtime. Patch checkpoints were applied and removed by the branch-local workflow, not left as unexecuted deliveries.

Code tree `aad980251775072b08ea9bdaf494088fdd1e4666` at remote `eb341246e260942e9f34ff4a178c289e49db849b` was compared byte-for-byte with the tested local tree. Windows run `34709944550` passed all 233 focused tests, full build and static checks but exposed a missing renderer stylesheet in the isolated native fixture. `8cf7814` copies the compiled renderer assets into that fixture; no production rendering fallback was added. Run `34710442007` at `f65750a` then passed the full native page chain and OS-encrypted auth smoke, before being superseded during static checks by the disclosure hardening checkpoint. Its overall status is cancelled, not success.

Additional disclosure/reading-layout regressions pass locally: **238 tests in 36 files**, three typechecks, focused lint, error handling, architecture budget and duplicate checks. The editing container uses `TMPDIR=/dev/shm` for real test fsync and cannot run Knip's WASM parser due a memory allocation error; Windows CI is authoritative for that gate. Read the latest same-branch checkpoint for final Windows acceptance of the newest source.

Actual OCR/model quality, live Tailscale traffic and the logged-in user's new-tool interaction remain separate from deterministic automated tests. The user had already confirmed the connection/auth/existing editor baseline. This milestone does not claim full repository `npm run check`, all platforms, GPU model quality or every advanced translation feature.

## Next functional work

Preserve these independent tools while extending app text-model execution, reading/geometry/style patches, per-region masks, dedicated lettering/font matching, SFX images, derived-layer review, durable multi-page jobs/ZIP and import/research/context mutation. Do not silently broaden the current first-page tool contracts or replace the existing app algorithms.
