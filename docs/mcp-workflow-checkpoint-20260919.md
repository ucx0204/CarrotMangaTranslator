# Bundle 8: ordered chapter workflows and explicit resume

Current authority: `mcp-workflow-connected-checkpoint-20260919.md`.
The implementation/remaining-work statements below are historical checkpoints,
not the current resume instructions.

Current continuation: `mcp-workflow-continuation-20260919.md` supersedes this
historical checkpoint's remaining-work list. Bundle 8 remains in progress.

Status: CORE IMPLEMENTED AND REGISTERED; BUNDLE 8 REMAINS IN PROGRESS.
Starting verified bundle-seven checkpoint: `e30735ef`.
Use only `feat/mcp-app-bridge` and the existing MCP-Review worktree.
Do not restart the live app, alter user artwork/authentication/model assets,
merge master, release, or start bundle 9. Live acceptance remains deferred.

## Connected core

Nine tools are registered in the actual desktop composition and strict output schemas:

- `carrot_prepare_workflow`
- `carrot_get_workflow`
- `carrot_list_workflows`
- `carrot_run_workflow`
- `carrot_resume_workflow`
- `carrot_pause_workflow`
- `carrot_cancel_workflow`
- `carrot_accept_workflow_external`
- `carrot_discard_workflow`

Preparation captures explicit chapter/page order, original-byte evidence,
page/review/context revisions and the execution-settings fingerprint. It writes
only an encrypted plan. It does not execute a model, renderer or artwork mutation.
Stage order is supplied explicitly. All selected pages in one stage settle before
starting the next stage; pages follow their saved chapter order. IDs are qualified
by chapter so equal page IDs in different chapters do not collide.

The connected stages are empty-page OCR, saved-source translation, native page
erasure, current PNG export and external-result waiting. Existing OCR blocks and
nonempty translations are protected by default. Translation uses the existing
selection analysis, reading order and native apply path. Generated image text is
excluded. An identical translation result does not produce an empty apply plan.
No implicit typography, SFX generation, context rewriting or ZIP packing occurs.
Those already independent tools remain separate from this five-stage workflow.

## Checkpoints, controls and native ownership

Each attempt is stored before execution, its admitted child job ID is recorded,
and each finished page/stage is checkpointed. Existing app jobs, native page/content
ownership, execution settings and model-cleanup barriers remain authoritative.
No second GPU scheduler, storage backend, arbitrary IPC/tool dispatcher or remote
path interface is introduced. There is one active workflow per session; other
prepared plans are not an automatic FIFO queue.

Pause finishes the current child and then stops before the next step. Cancel
signals the owned child and stays running until native cleanup settles. Neither
undoes already saved content. Active status, duplicate run admission and control
must not wait behind the library read lock held up by a native save/handoff.
They now inspect the same owned active record and still reject another owner.
Session shutdown waits for pending admission and actual child completion.

Restart never automatically executes a plan. Explicit resume revalidates current
permission, settings, all selected pages, source bytes, chapter membership/order
and context. Completed steps are not repeated. Exact request replay returns the
previous admission. Changed settings reject resume rather than silently changing
engines; only a fingerprint is retained, not credentials or an executable model.
A new chat on the same approved connection can continue; a different connection
cannot take over merely by knowing the workflow ID.

A lost workflow checkpoint is reconciled only against exact owned native page or
output receipts. Useful partial erasure is not full erasure completion. Erasure
reconciliation additionally requires a matching completed native job receipt with
zero unfinished blocks and successful cleanup. Missing or inconclusive receipts
remain review-required, never an automatic repeat of model calls. Post-save UI
notification failures preserve the saved step and do not retranslate it on resume.

External steps wait for the host AI. The AI uses existing edit/upload tools and
acknowledges the exact saved page/review revisions; acknowledgement changes only
the plan and leaves it paused for explicit resume. The server does not invoke or
imagine a chat model continuing after disconnection. Saved context is read, not
regenerated or silently updated from the previous page.

## Bugs repaired during continuation

- Active cancellation/status and duplicate admission no longer queue behind a
  native edit handoff that itself needs cancellation to finish.
- Identical translation proposals finish without trying an ineligible empty apply.
- Completed internal selection child plans are released after native completion,
  preventing the 32-plan editor limit from stopping long runs. Independent user
  plans and durable page-change history are not discarded by this release.
- Partial/cancelled/failed native outcomes, unfinished blocks and cleanup failures
  no longer count as a completed workflow stage.
- Erasure restart reconciliation uses both native job completion and saved-content
  evidence; a page-save receipt alone is insufficient.
- Fifty external pages require 101 acknowledgement/run receipts. The old 64-entry
  workflow limit was reproduced as a failure and replaced by a single 128-entry
  workflow contract. The explicit 129-entry rejection remains tested.

## Bounds

1-10 chapters, at most 50 pages total, 1-5 distinct stages and 250 page/stage steps.
128 action receipts; at most 500 admitted page attempts and 5,000 reserved block
translation requests. Defaults remain 200 page attempts and 100 translation
requests. These are execution counters, not token or monetary cost estimates.
Translation supports at most 100 eligible blocks per page. Existing child timeouts,
file sizes, metadata limits and image permissions still apply.

Workflow plans share seven-day retention, 256 entries and 1 GiB with retained
page changes and outputs. Full storage rejects work instead of silently deleting
another owner's history, truncating targets or changing image resolution.
Discarding a plan does not undo pages or delete retained outputs/history.

## Verification

The complete check at `b73a93f1` passed all 26 gates: 7,931 tests passed,
zero failures and 11 existing skips. The later 50-page test reproduced the
64-receipt bug. Its corrected 128-receipt version passed both full-flow and
128/129-boundary tests. The full rerun on `85313189` is not yet confirmed;
read `.tmp/mcp-workflow-full-check5.log` and the process exit before claiming it.

The independent Windows build and existing native Electron regression passed
at `c78beb57`, with `PASS MCP native smoke finished` and exit code 0. The isolated
port was 38558, Tailscale disabled. This is regression coverage of existing native
page/image/history/output paths, not the attempted new workflow-specific scenario.

Workflow integration tests use actual isolated native transactions, evidence,
OAuth/HTTP, selection editing and encrypted records. Model/renderer transport
boundaries are substituted. Live app/model/client quality is not claimed.
All 1,664 inherited coverage records/provenance/deletions remain unchanged, adding
13 measured modules for 1,677 records. Exact final evidence will be saved separately.

## Exact remaining bundle-eight work

1. Retain one existing native model/resource lease across a complete same-model
   stage group, with trusted child ownership and group cleanup before switching.
   Current children intentionally still acquire/release through their existing
   lifecycle. Stage-major sequential order is not one-load model residency.
2. Add explicit authorized handoff to another approved connection. Same-connection
   new-chat resume is already supported; cross-connection ownership is not widened.
3. Add the extra workflow-specific real-Electron reconstruction/render scenario.
   A write extending `scripts/mcp-native-retention.cjs` was not executed by the tool.
   The existing native regression is successful, but is not that new scenario.

Do not mark bundle 8 complete, proceed to bundle 9, suppress native cleanup hooks,
weaken ownership checks or replace deferred live tests with mocked-quality claims.
Next work starts with group-owned model lifetime over the existing app runtime.
Details: `mcp-workflow-boundaries-20260919.md` and
`mcp-workflow-coverage-20260919.md`.
