# Bundle 6 sound-effect boundaries - 2026-09-19

Implementation scope; final check results belong in the sound-effect checkpoint.
Use only `feat/mcp-app-bridge` and the existing review worktree. Live user/model/
ChatGPT/Tailscale acceptance remains deferred. No release or master merge implied.

## Independent stages

Candidate inspection reads the native stored review and saved sound-role blocks.
It reports effective original-pixel rectangles, pending/excluded/resolved/overlap
states, stored source text and stale/disabled/active artwork metadata. It does not
run a detector. New candidate discovery or rereading uses the existing independent
OCR tools, while an external AI can explicitly add manual review rectangles.
OCR and text translation remain the bundle-three selection tools; selected erasure
remains bundle four. No fake translation or paint command is used to invoke them.

Review decisions reuse native review drafts and restore rules. Immutable detector
regions are retained; changed geometry uses overrides and invalidates the old OCR
anchor as the app does. Unmentioned candidates are preserved. Manual candidates use
deterministic request-bound IDs. Approved text materialization reuses the native
block factory and resolved-region ledger; overlapping materialization is explicit.
Text edits touch only selected saved sound-effect source/translation fields. Image
state edits enable, disable or remove the generated lettering property; stale or
blocked artwork cannot be enabled and moderation flags are not cleared by a text
or image-state command. Normal dialogue is not converted or otherwise changed.

## Generation is not a save

Generation is a distinct job requiring read/edit/process AND image scope, the exact
configured supported Codex image controller, and explicit external-processing
consent. The controller name is not a claim about the underlying image backend's
availability or quota. Runtime/account readiness is checked by the native client;
metadata discovery does not log in, repair settings or run a readiness probe.
Unsupported providers/models are refused rather than silently substituted. External
AI-generated artwork continues through bundle-five validated image uploads.

Only saved, explicitly selected sound blocks with source and translation text are
eligible. Existing layers are protected unless replacement is requested. Blocks run
sequentially through the existing native foreground layer generator, source crop,
matte/transparency and image extraction code. The full page image-edit orchestrator
is NOT invoked: no implicit region replanning, OCR, translation, removal, C23,
automatic layout, renderer call, settings write or asset download occurs. Source
reference transfer uses native redaction checks, rechecked before every remote turn.
Provider refusals produce inspectable failures and native blocked-state proposals;
there is no automatic fallback or retry. Existing refusals are excluded up front.

Native canvas padding can require a render rectangle adjustment. It is accepted
only with explicit allowRenderAdjustment; otherwise the item fails without changing
saved geometry. Source geometry and other block properties remain unchanged. Actual
remote calls are counted, but counts are not a billing or visual-quality claim.
Successful items and failed items are distinct in the plan. Client cleanup and
source/context revalidation finish before any plan becomes applicable. Cleanup
failure refuses publication and fences further generation in this session.

## Applying and recovering

The transport accepts explicit commands, not caller-authored raw page snapshots.
Internally generated before/after state is bounded and owned. Native page handoff,
activity ownership, work-context lease, library transaction and UI notification
are reused. Review state has its own revision and exact fingerprint, because normal
page revision alone does not track every review-only change. Original, cleaned and
mask files are checked before preparation, after remote calls and before applying.

The narrow native sound-effect snapshot transaction writes blocks, effective order,
review ledger and related completion/analysis fields only. Originals, background
artifacts and unrelated pages remain unchanged. A commit is acknowledged before
notification. Notification failure is partial, not an unrecorded save. Cancellation
stops pending work and never pretends to roll back an acknowledged mutation.

Undo/redo restores exact retained snapshots, including originally absent properties,
without another model call. Later edits or changed native source evidence conflict.
Undo can recover after context changes; redo requires current context agreement.
History is session-bound, not permanent bundle-seven recovery. The job journal
persists target and status, strips usable plan capabilities on restart, and disallows
generic retry for sound-effect jobs. A new request must explicitly review current
inputs; old action/request IDs do not repeat generation or native writes.

## Limits and visibility

One saved page per plan. Up to 100 review decisions, 100 manual additions, 100
materialized/text/image-state targets, or 10 image-generation targets per request.
The native 5,000-block page ceiling remains. Before/after block storage is checked
against a 3 MiB preparation budget and the existing 4 MiB total plan limit; large
pre-existing pages can therefore be refused before a model starts. Shared session
plan count, byte budget and 30-minute idle expiry remain enforced.

Metadata polling never contains image data, original file paths or raw snapshots.
An explicit image tool returns only a selected reviewed foreground asset, not a
promise about its final transformed page placement. It requires image permission,
redaction approval and current source/page evidence. The shared native preview
adapter bounds output to a 1,600-pixel long edge and 4 MiB PNG. Use the existing page
renderer after application for composition review. Stored image/text agreement is
metadata validation, not OCR proof of what the generated image actually says.

## Verification interpretation

Unit/integration tests use isolated libraries and real review algorithms, block
creation, source hashes, native transactions, job ownership and OAuth/HTTP. Only the
Electron image boundary and Codex transport are replaced in generation fixtures;
native foreground grouping, cropping, matte extraction and layer projection run.
A model-free isolated Electron script exercises manual candidates, approved text
materialization and exact review/block recovery. Do not claim its result before
reading its terminal completion marker and exit code. Actual model quality, user
artwork and public client file reception are reserved for final integrated testing.
