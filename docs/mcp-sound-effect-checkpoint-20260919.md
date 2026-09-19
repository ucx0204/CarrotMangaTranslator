# Bundle 6 sound-effect checkpoint - 2026-09-19

Status: IMPLEMENTED AND REGISTERED; FINAL AUTOMATIC VERIFICATION IN PROGRESS.
Baseline: `f6257058`. Current production/test code: `1984d8ac`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Bundles 1-5 remain completed; live user/model/client acceptance remains deferred.
No live app restart, user artwork/authentication/model change, release or master merge.

## Connected scope

Nine tools are in real app composition and strict output schemas (112 outputs):

- `carrot_get_sound_effects`
- `carrot_prepare_sound_effect_batch`
- `carrot_generate_sound_effects`
- `carrot_get_sound_effect_batch`
- `carrot_get_sound_effect_image`
- `carrot_apply_sound_effect_batch`
- `carrot_undo_sound_effect_batch`
- `carrot_redo_sound_effect_batch`
- `carrot_cancel_sound_effect_batch`

Stored candidate discovery and include/exclude/restore/manual geometry use native
review algorithms. Approved pending text can become native sound blocks, with the
resolved-region ledger preserved. Sound-only source/translation edits and generated
image enable/disable/removal leave dialogue and backgrounds unchanged. OCR and app
text translation use existing bundle-three tools; erasure uses bundle four.

Generation uses only the existing foreground lettering engine, not the full page
image-edit orchestrator. It requires exact configured supported Codex controller,
explicit external-processing consent and image scope. It is sequential and holds
native job/page/context ownership; source, review and context are rechecked around
remote calls. Existing images are protected unless replacement is explicit. Native
canvas adjustment requires permission; refusals and failed items never cause an
automatic provider fallback or re-execution of successful images. External files
continue through bundle-five validated uploads.

Preparation and generation publish owned bounded plans, not saved page changes.
Application/recovery use native atomic library transactions and commit acknowledgments
before notification. Review-only mutations are checked separately from normal page
revisions. Exact before/after snapshots preserve optional property absence, candidate
ledger, text, order and relevant completion fields. Later user edits conflict.
Metadata has no images/paths; explicit asset inspection uses the shared bounded PNG
projection and image/redaction checks. Durable job records remove usable session
plan references after restart and generic job retry cannot repeat generation.

## Completed focused verification

The sound-effect, existing external-image and output-contract suite passed 29 tests
across six files. Two additional durable journal tests passed. Actual scoped HTTP
also verified read-only discovery, edit/process application and undo, and denied
image generation/transfer without image permission. All three type projects,
changed-file lint and exact architecture checks passed before the final stage graph.

Generation tests replace only Codex transport and the external Electron image API;
native source cropping, foreground grouping, matte/transparency and layer projection
run. Review/append/save/recovery use actual isolated native library transactions.
These are not live model quality, user artwork or ChatGPT/Tailscale acceptance.

## Exact resume point

The first full stage graph found three unused exports; removed without changing
behavior in `1984d8ac`. The rerun `.tmp/mcp-sfx-full-check2.log` is at full Vitest/V8
coverage. Read its terminal output, register the 18 new measured production modules
while preserving every one of the 1,625 inherited coverage records and provenance,
and repair any actual regressions with behavioral tests rather than lower floors.
Then complete all 26 gates and the isolated model-free sound-effect Electron script
registered in `scripts/mcp-native-page.cjs`. Require the completion marker and exit
code, update the evidence/boundary documents and advance the roadmap only afterwards.
Do not start bundle 7 or request intermediate live acceptance before this is done.

Details and supported bounds: `mcp-sound-effect-boundaries-20260919.md`.
