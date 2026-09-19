# Bundle 8: connected sequential workflows and explicit handoff

Status: IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES PASSED; LIVE DEFERRED.
Verified production/test code: `ac01503f10eaeab72681bd0c2e6328fef90eaac4`.
Bundle-eight starting point: `e30735ef`; this continuation started at `f979cfc4`.
Use only `feat/mcp-app-bridge` and the existing MCP-Review worktree.
This document supersedes the historical remaining-work lists in the original
workflow checkpoint and continuation. Bundles 1-8 are implemented with automatic
verification; bundle 9 is next and has not been started here.

## Connected functionality

Thirteen workflow tools are registered in actual desktop composition, with strict
input and output contracts. There are 133 registered output schemas overall.

| Core tools                        | Handoff tools                          |
| --------------------------------- | -------------------------------------- |
| `carrot_prepare_workflow`         | `carrot_get_workflow_handoff_identity` |
| `carrot_get_workflow`             | `carrot_offer_workflow_handoff`        |
| `carrot_list_workflows`           | `carrot_accept_workflow_handoff`       |
| `carrot_run_workflow`             | `carrot_revoke_workflow_handoff`       |
| `carrot_resume_workflow`          |                                        |
| `carrot_pause_workflow`           |                                        |
| `carrot_cancel_workflow`          |                                        |
| `carrot_accept_workflow_external` |                                        |
| `carrot_discard_workflow`         |                                        |

Preparation captures explicit chapters, canonical page order, source bytes,
page/review/context revisions and the execution-settings fingerprint. It writes
only an encrypted plan. No model, renderer or artwork mutation runs implicitly.
The five stages are empty-page OCR, saved-source translation, native erasure,
PNG export and external-result waiting, in the explicitly supplied order.
All selected pages in one stage settle before the next stage starts.

Translation and erasure stages retain one existing endpoint/engine lease across
sequential children. The native activity gate remains exclusive through physical
cleanup. Children retain their own IDs, page ownership and completion boundaries.
Cleanup failure prevents the next stage. No second GPU scheduler or local-model
parallelism was introduced. OCR deliberately retains its existing native per-page
pipeline and internal model transitions; single-load OCR residency is not claimed.

Each admitted attempt, native child and completed step is checkpointed. Explicit
resume skips completed steps and rechecks permissions, settings, selected pages,
source bytes, chapter membership/order and saved context. Lost checkpoints reconcile
only with exact owned native receipts. Partial erasure and uncertain attempts are
not full completion and are not silently repeated. Pause/cancel do not undo saved
pages. Restart never automatically runs a plan. External steps wait for actual host
AI results and acknowledge exact saved revisions before a separate explicit resume.

## Two-party handoff

A new conversation using the same approved connection can resume directly. Another
approved connection must obtain its own handoff address; the donor offers one settled
workflow to that address and the receiver separately accepts. Both current approvals
and the receiver's permissions for every stage are checked through publication.
Addresses and offer IDs do not grant permissions. Pending offers expire after at most
ten minutes and are invalidated by server restart or revocation.

Run/admission, settled controls, external acknowledgement, discard and handoff share
one exclusion boundary. Active, uncertain/failed and completed workflows cannot be
handed off. Donor revocation remains available during encrypted staging.

Acceptance revalidates all selected evidence and settings. The native transaction
reuses the canonical context snapshot without waiting for its own read lock. Record
and owner index publish atomically; interrupted publication recovers both together.
Exact accepted replay survives restart without another transfer or execution.

Only the settled plan changes owner. Completed steps, original expiry, target order
and consumed budgets remain. Previous native job, page-change and output ownership
is unchanged; those IDs are cleared from the transferred plan. The receiver obtains
paused or external-waiting state, not automatic execution.

## Reproduced fixes and regression boundaries

Current-child cancellation was reproduced as three failing tests. The shared native
resource previously followed only parent cancellation. It now follows the active
child during acquisition/use, detaches that child's handler on return, rejects
already-cancelled acquisition and still waits for physical cleanup. A late abort or
duplicate release from an earlier child cannot interrupt a later borrower.

The existing cancellation regression was updated to cancel during the first request,
then hold physical cleanup independently; group-end cleanup no longer implies that
no previous page was saved. Native inpainting-pool characterization covers Flux,
LaMa and AOT reuse with three sequential children, one acquisition and one disposal.
Nested/mismatched/escaped workloads and an ungrouped external-wait port are tested.

Handoff tests cover actual scoped OAuth/HTTP, missing identities, narrower grants,
wrong recipient, stale settings/page/source, expiry, restart, exact replay,
revocation after the original HTTP response and during encryption, concurrent
run/control/discard/acknowledgement, and preservation of old output ownership.
Native crash injection tests cover before and after the transaction commit point.

## Final automatic verification

The exact code above passed all 26 repository gates, exit code zero.

| Check                                                                | Result                                         |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Complete Vitest/V8 suite                                             | 7,971 passed; zero failures; 11 existing skips |
| MCP tests within that suite                                          | 1,152 passed across 181 files                  |
| Renderer/Electron/JavaScript type projects                           | Passed                                         |
| Lint, format, architecture, duplicates, dead code, mock boundaries   | Passed                                         |
| Exact coverage-floor and inventory gate                              | Passed                                         |
| Windows app build                                                    | Passed                                         |
| Existing artwork parity, image protocol, renderer/preload boundaries | Passed                                         |
| Additional isolated real-Electron workflow scenario                  | Required markers and exit code zero            |

All 1,677 inherited coverage rows, provenance and ten deletion records are unchanged.
Five modules were registered from the actual first connected V8 measurement, bringing
the inventory to 1,682. Bundle eight as a whole adds 18 modules over bundle seven.
Initial coverage gaps were closed with genuine behavioral regressions, not reduced
floors. Global architecture/complexity limits are unchanged; exact new common-service
consumers and output composition are documented as source-specific declarations.

## Real Electron evidence and protected state

Executed the existing `scripts/mcp-electron-smoke.cjs` with isolated port 38559 and
`CARROT_MCP_SMOKE_TAILSCALE=0`. The workflow scenario uses real Electron, OS encryption,
native transactions and the app renderer. It reconstructs external-wait state,
acknowledges exact saved revisions, explicitly resumes PNG stages, reconstructs
again and verifies exact replay plus byte-identical retained outputs. Original
bytes and saved content are preserved. Both required markers were observed:

`PASS native workflow prepare -> reconstructed external wait -> explicit saved-revision acknowledgements -> real PNG stages -> reconstructed exact replay and byte-identical retained outputs`

`PASS MCP native smoke finished`

Process exit code was zero. Model/provider transport tests use deterministic external
boundaries; they do not prove live OCR, translation or model quality. No user app
restart, live MCP/Tailscale call, authentication change, model-asset modification,
master merge or release was performed. Live acceptance stays in the final integrated
queue after all thirteen bundles are implemented.

## Bounds and next work

At most ten chapters and fifty total pages; five distinct stages and 250 steps.
128 action receipts, at most 500 page attempts and 5,000 reserved translation requests;
defaults remain 200 and 100. These are request counters, not token/money estimates.
Plans share seven-day retention, 256 entries and 1 GiB with changes and outputs.
Native file/metadata limits still apply. Full capacity refuses new work rather than
silently discarding history, truncating targets or shrinking original images.

Automatic typography, SFX, research/import and ZIP composition are not hidden inside
this five-stage core. Existing independent tools remain reusable by later composite
workflows. Context is read, not automatically regenerated between pages.

Evidence: `.tmp/mcp-workflow-connected-final-evidence.json`,
`.tmp/mcp-workflow-connected-final-timings.json`,
`.tmp/mcp-workflow-connected-final-vitest.json`,
`.tmp/mcp-workflow-connected-final-coverage.json`,
`.tmp/mcp-workflow-connected-check-final3.log`,
`.tmp/mcp-workflow-connected-native.log` and `.tmp/check-logs/`.
Final gate interval: `2026-09-19T14:42:00.502Z` to `2026-09-19T14:46:42.496Z`.
Native log SHA-256: `789237720a2dd34be71a61208b121fd97578780dca1d2c1e71035265d94b2a5b`.

NEXT: bundle 9, context merge/replacement, reference migration and multi-work research.
Reuse the existing context services, durable records and workflow execution. Do not
redo bundles 1-8, create another scheduler or request intermediate live tests.
Details: `mcp-workflow-boundaries-20260919.md` and
`mcp-workflow-connected-coverage-20260919.md`.
