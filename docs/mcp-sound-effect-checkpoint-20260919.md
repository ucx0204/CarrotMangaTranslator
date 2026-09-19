# Bundle 6 sound-effect checkpoint - 2026-09-19

Status: IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES PASSED; LIVE DEFERRED.
Baseline: `f6257058`. Verified production/test code: `d5db3901`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Bundles 1-6 are implemented and automatically verified. Live user artwork, actual
model quality and ChatGPT/Tailscale client acceptance remain in the final queue.
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

Stored candidate inspection and include/exclude/restore/manual geometry use native
review algorithms. Listing does not start a detector. Effective geometry overrides
invalidate old recognized-text anchors while immutable detector evidence remains.
Unmentioned candidates and normal dialogue are preserved. Approved pending text can
become native sound blocks with the resolved-region ledger and reading order kept.
Sound-only source/translation edits and image enable/disable/removal leave backgrounds
unchanged. Stale/blocked images cannot be enabled and remote text/state edits do not
clear native moderation flags. OCR and app text translation reuse bundle-three tools;
selected erasure reuses bundle four; externally generated images reuse bundle five.

## Independent app generation

Generation invokes only the existing foreground lettering engine, not the full-page
image-edit orchestrator. It requires the exact configured supported Codex image
controller, explicit external-processing consent, and image scope in addition to
read/edit/process. Controller discovery does not claim runtime/account/quota readiness
or a particular underlying image backend. Unsupported providers/models do not fall
back. Actual provider calls may use account quota or incur cost.

Saved sound-effect blocks with approved source/translation text are processed
sequentially. Existing images are protected unless replacement is explicit. Native
source cropping, grouping, matte/transparency extraction and layer projection are
reused. Native canvas-padding render-box adjustment requires explicit permission.
No implicit OCR, translation, erasure, C23, geometry replanning, renderer call,
settings write, model-asset download or page save occurs during generation.

Successful and failed items remain distinguishable. Provider refusals do not invoke
another provider or automatic retry. Source/redaction/context checks run around the
remote calls; cleanup finishes before a plan becomes usable. A client cleanup fault
refuses plan publication and blocks further generation in that session.

## Application, recovery and visibility

Preparation and generation return owned bounded plans, not saved page changes.
Explicit application uses native page handoff, activity ownership, work-context
leases and atomic library transactions. Review-only mutations are validated separately
from the normal page revision. Original/cleaned/mask hashes and exact page/review state
are rechecked before changes. No raw page snapshots are accepted from the transport.

Undo/redo restores retained blocks, reading order, review ledger, relevant completion
state and optional-field absence without another model call. Later user edits or
changed source evidence conflict. Undo can recover after context changes; redo still
requires context agreement. An acknowledged save remains undoable after notification
failure and is reported as partial. Cancellation is not automatic rollback.

Metadata polling contains no images, paths or internal snapshots. The separate image
tool returns only a selected reviewed foreground asset with image/redaction and
source/page checks. It is not the final transformed page render. Durable job records
strip usable plan references after restart; generic retry cannot repeat generation.
A new generation request must explicitly review current inputs, while old request or
action IDs do not re-execute work.

One saved page per plan; up to 100 review decisions/manual additions or text/block
changes and 10 generation targets. Native page block limits remain. Preparation
checks a 3 MiB before/after block budget and the existing 4 MiB total plan limit;
large existing pages can be refused before a model starts. Image previews are at
most 1,600 pixels on the long edge and 4 MiB PNG. Recovery retains the shared
30-minute idle, session-only lifetime. Durable recovery remains bundle 7.

## Final automatic verification

The complete repository stage graph at `d5db3901` passed all 26 gates:

| Check                                                                     | Result                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Complete Vitest/V8 suite                                                  | 7,851 passed; zero failures; 11 pre-existing skips                                                                |
| MCP cases in the complete suite                                           | 1,037 passed across 150 files                                                                                     |
| Sound-effect/external-image/output focused suite                          | 29 passed across six files                                                                                        |
| Additional durable sound-effect journal tests                             | Two passed                                                                                                        |
| Real scoped OAuth/HTTP                                                    | Read-only discovery, edit/process apply and undo passed; generation and image transfer denied without image scope |
| Renderer, Electron and JavaScript type projects                           | Passed                                                                                                            |
| Lint, formatting, architecture, duplicate/unused code and mock boundaries | Passed                                                                                                            |
| Exact production coverage-floor gate                                      | Passed                                                                                                            |
| Windows build                                                             | Passed                                                                                                            |
| Existing page-artwork parity, image protocol, renderer/preload boundaries | Passed                                                                                                            |
| Additional model-free native Electron sound-effect check                  | Passed; terminal completion marker and exit code 0                                                                |

The first full stage graph found three unused exports, removed without behavior
changes. The initial complete coverage run found only the 18 new-module inventory
registrations missing. They were added from actual measurement, preserving all
1,625 inherited records, their provenance and ten deletions. Final inventory contains
1,643 rows. The 27-test inventory suite and exact floor command passed, followed by
the passing full rerun. No inherited threshold or global check was weakened.

Canonical timing record: `.tmp/check-timings.json`, started
`2026-09-19T04:53:30.674Z`, completed `2026-09-19T04:56:36.066Z`.
Preserved records: `.tmp/mcp-sfx-final-check-timings.json`,
`.tmp/mcp-sfx-final-evidence.json`, `.tmp/check-results/vitest.json`,
`.tmp/check-logs/`, `.tmp/mcp-sfx-full-check3.log`.
Test digest: `0b45fa82b779d7150a067318be95e838626713776a1f10159a2b57ba0a5bb3ee`.
Coverage digest: `c8d623f0da686afd55cb6539ed52aea3cc921d5b0aa6e2811030bace9d4a7eab`.
Initial measured per-file provenance is in `mcp-sound-effect-coverage-20260919.md`
and `.tmp/mcp-sfx-coverage-evidence.json`.

## Native verification and interpretation

Ran `node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs` with
`CARROT_MCP_SMOKE_PORT=38553` and `CARROT_MCP_SMOKE_TAILSCALE=0`.
Log: `.tmp/mcp-sfx-native-20260919.log` (PowerShell UTF-16).
Raw log SHA-256: `900789b23d0d44e3994aee85e2837ae5b545111b6bc16f530c4b62ef48d24270`.
Exit code was 0. Both required messages were read:
`PASS native sound-effect candidate -> approved text block -> text-only edit -> exact review/block recovery (no inference)`
and `PASS MCP native smoke finished`.

This additional native check uses actual Electron, production MCP tool composition,
manual candidate creation, approved text materialization, text-only edit and exact
review/block recovery in an isolated library. Original bytes and preceding blocks
remain unchanged. It performs no new image-generation model calls. Existing isolated
image, export and authentication regression checks also finished in that run.

Generation unit tests replace only Codex transport and external Electron image API;
native cropping, foreground grouping, matte/transparency and layer projection execute.
Review/append/save/recovery use real isolated native library transactions. These tests
do not prove actual provider quality, quota, user artwork acceptance, chat attachments
or public Tailscale delivery. All live acceptance remains deferred.

Details: `mcp-sound-effect-boundaries-20260919.md`.
NEXT: bundle 7, durable undo and retained output assets. Do not redo bundles 1-6 or
request intermediate live tests. Keep this branch/worktree and frequent checkpoints.
