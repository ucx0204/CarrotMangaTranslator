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
| 2     | Bubble layout, advanced typography, reusable rules/presets                           | Implemented; automatic checks passed; live deferred |
| 3     | Region/multi-block OCR, selected translation, reviewed append and block references   | Implemented; automatic checks passed; live deferred |
| 4     | Multi-block erasure, free/protected masks, localized correction/restoration          | Implemented; automatic checks passed; live deferred |
| 5     | External image/mask upload, validation and layer incorporation                       | Implemented; automatic checks passed; live deferred |
| 6     | Independent sound-effect preparation, text, generation and recovery                  | Implemented; automatic checks passed; live deferred |
| 7     | Durable undo and retained output assets                                              | Implemented; automatic checks passed; live deferred |
| 8     | Model-grouped sequential jobs, chapter batches and explicit resume                   | Implemented; automatic checks passed; live deferred |
| 9     | Context merge/replacement, reference migration and multi-work research               | NEXT; not started                                   |
| 10    | File/web import and library organization                                             | Not started                                         |
| 11    | Extra export/exchange formats and attachment/delivery diagnostics                    | Not started                                         |
| 12    | Composite workflows and bounded automated review                                     | Not started                                         |
| 13    | Client compatibility, diagnostics, installation and UI/UX                            | Not started                                         |

Live C23 quality, model cleanup, actual originals, PNG/ZIP attachment reception,
download byte/hash checks, restart/reconnection and end-to-end client acceptance
belong to the final integrated live-test queue, not intermediate completion claims.

## Current authority: verified bundle 8 completion

See `mcp-workflow-connected-checkpoint-20260919.md`, verified source `ac01503f`.
Thirteen tools connect fixed chapter/page plans, five explicit stage kinds,
sequential translation/erasure model residency, durable checkpoints, pause/cancel,
explicit resume, external-result acknowledgement and two-party settled handoff.
Existing native jobs, ownership, settings, transactions and retained storage remain
canonical. OCR keeps its existing per-page pipeline, not a single persistent OCR
model. No arbitrary dispatcher or automatically resumed model work is introduced.

All 26 repository gates passed: 7,971 tests passed, zero failed, 11 existing skips.
All 1,152 MCP cases across 181 files passed. The additional actual Electron workflow
reconstruction/render/output-reissue scenario passed with required markers and
exit code zero. Model/provider boundaries in other tests remain substitutes; no
live model quality, user artwork or public-client acceptance is claimed.

Current-child cancellation and late stale-child abort isolation are verified.
Handoff requires both current approvals, exact evidence/settings and settled
admission. It atomically changes only plan ownership, not historical job/change/
output ownership, and leaves the recipient paused for explicit resume. Crash,
revocation, concurrent control and exact replay are covered by native and HTTP tests.

All 1,677 inherited coverage records and provenance are preserved; five measured
continuation modules bring the inventory to 1,682. Bundle eight adds eighteen
modules over bundle seven. Original workflow checkpoints remain historical only.

NEXT: bundle 9, context merge/replacement, reference migration and multi-work
research. Do not redo bundles 1-8, create a second GPU scheduler or request live
tests between bundles. Full import/research/typography/SFX/ZIP composition remains
in the planned later bundles rather than hidden inside the five-stage core.

## Verified bundle 7 completion

See `mcp-retention-checkpoint-20260919.md`, verified source `09a99b16`.
Eight tools connect restart-persistent native page-change records, exact undo/redo,
retained PNG/ZIP inspection, fresh short-lived file links and explicit owned discard.
Page data, private image copies and encrypted records share the native commit point.
Repeated requests do not execute models or repeat saved actions. Current/leased
images are preserved; only replaced native working copies are retired. No arbitrary
paths, raw snapshots or retrospective UI-history capture are exposed.

All 26 gates passed: 7,893 tests passed, zero failed, 11 existing skips; 1,077 MCP
cases across 159 files. Scoped HTTP and the additional real-Electron OS-encrypted
session-reconstruction/PNG-reissue check passed, with final markers and exit code 0.
All 1,643 inherited floors and provenance remain unchanged; 20 new modules plus one
newly tracked existing file bring the inventory to 1,664 records.

Seven days / 256 entries / 1 GiB bounds the private catalog, not all artwork or
unlimited permanent storage. Old analysis/batch plans do not become executable
again. Same-profile/owner, page/source, permission and redaction checks remain.
The running user app, artwork, authentication and model assets were not modified.
Live app/model/client acceptance stays deferred until all bundles are implemented.

Bundle 7 remains complete. Continue the bundle-eight checkpoint at the top.
Reuse existing jobs, model ownership and retained data; do not introduce another
GPU queue or redo completed bundles 1-7. Context migration remains bundle 9.

## Verified bundle 6 completion

See `mcp-sound-effect-checkpoint-20260919.md`, verified source `d5db3901`.
Nine tools connect stored candidate inspection, native include/exclude/restore/manual
review, approved-text materialization, sound-only text/image-state edits, explicit
native foreground image generation, guarded image inspection and exact recovery.
Generation is a separate remote/account-consuming job requiring image permission,
explicit consent and the exact configured supported controller. No automatic OCR,
translation, erasure, C23, region replanning or rendering is implied. Those existing
independent tools and bundle-five external image input remain reusable.

All 26 repository gates passed: 7,851 tests passed, zero failed, 11 existing skips.
All 1,037 MCP cases across 150 files passed. Eighteen measured modules were added
while preserving all 1,625 inherited coverage records, provenance and deletions.
The added model-free real-Electron candidate/text/materialization/recovery check
also passed with its completion marker and exit code 0. Generation fixtures use
native foreground processing but substitute Codex transport and external Electron
image calls; no live model quality or user/client acceptance is claimed.

Bundle 6 remains completed. Follow the current authority at the top,
not its historical next-step recommendation.

## Verified bundle 5 completion

See `mcp-external-image-checkpoint-20260919.md`, verified source `0af0ba95`.
Twelve tools connect actual bounded PNG receipt, content/dimension/hash validation,
owned candidate review, native full background replacement or exact-size patches,
existing-block generated lettering and exact native undo/redo. Masks and explicit
protection preserve unselected current pixels. No model, erasure, OCR, translation,
URL fetch or arbitrary PC path is implicit. Only actual bytes are accepted; a chat
host's file handle or claimed filename is not a received image.

All 26 repository gates passed: 7,833 tests passed, zero failed, 11 existing skips.
All 1,019 MCP cases across 145 files passed. Fifteen measured modules were added
across this bundle while preserving all 1,610 inherited floors/provenance/deletions.
The additional isolated real-Electron uploaded-PNG/background/lettering/history
checks also passed with the explicit completion marker and exit code 0. Current
ChatGPT attachment reception, public Tailscale delivery and model quality remain
in the final live-test queue, not implied by these isolated tests.

Bundle 5 remains completed. Continue from the current authority at the top,
not its historical next-step recommendation. Permanent recovery remains bundle 7.

## Verified bundle 4 completion

See `mcp-image-edit-checkpoint-20260919.md`, verified code `32d76f3f`.
Eight image-edit tools are connected: native multi-block/freehand erasure,
explicit protected geometry, model-free paint and original-pixel restore,
mask preview, color sampling and exact native image undo/redo. One versioned
page per plan, up to 100 selected blocks and 16 million original pixels.
Originals, text, geometry and formatting are preserved. Erasure requires the
configured supported local engine and explicit asset-preparation consent;
no implicit OCR, translation, C23, layout or hosted image call occurs.

All 26 repository gates passed: 7,805 tests passed, zero failed, 11 existing
skips. All 991 MCP tests across 139 files passed. Nine measured coverage rows
were added while preserving all 1,601 inherited rows/provenance/deletions.
The extra isolated real-Electron mask/protected-RGBA/color/restore/history smoke
also passed with its terminal marker and exit code 0. Actual model quality,
user artwork and live ChatGPT/Tailscale delivery remain untested by this run.

Bundle 4 remains complete. Continue from the current bundle-five checkpoint above.
Durable recovery, chapter orchestration and live file acceptance remain separate.

## Verified bundle 3 completion

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

Bundle 3 remains completed. Continue from the current checkpoint
above, not from its historical next-step recommendation. Permanent recovery
remains bundle 7.

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
