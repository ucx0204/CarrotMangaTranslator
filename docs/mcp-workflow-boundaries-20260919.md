# Bundle 8: ordered workflows, shared model lifetimes and explicit handoff

Implementation and registration complete; all 26 automatic gates and the isolated
Electron workflow check passed. Exact evidence is in the connected checkpoint. Use only `feat/mcp-app-bridge` and the existing MCP-Review worktree.
No live application restart, user artwork changes or public-client acceptance are
implied. Those tests remain deferred until all implementation bundles are built.

## Fixed targets and independent stages

Nine core tools prepare, inspect/list, explicitly run/resume, pause, cancel,
acknowledge saved external results and discard an owned plan. Preparation writes
only an encrypted plan, never artwork, model output or a renderer result.

The five stage kinds are empty-page OCR, saved-source translation, native erasure,
PNG export and external-result waiting. Stage order is explicit. All selected pages
of one stage settle before the next stage; pages follow their saved chapter order.
Chapter/page-qualified IDs prevent collisions. New pages never enter implicitly.

OCR preserves existing blocks; translation preserves nonempty translations by
default, uses native reading order, excludes generated-image text, and avoids a
save for identical proposals. Erasure retains native masks, protection, history
and partial outcomes. Partial/cancelled/failed work is not promoted to completion.
General import/research/typography/SFX/ZIP composition remains a later bundle;
existing independent tools remain available and are not implicitly executed here.

## Native model lifetime and cancellation

Translation and erasure stages reuse `ActiveJobStore.runModelGroup` and the native
`modelWorkload` lifetime. One fixed endpoint or erasure-engine lease is retained
across sequential children and physically released once before switching stages.
Native page ownership, execution settings and the cleanup failure barrier remain
authoritative. No second GPU scheduler or transport-supplied activity owner exists.

The group keeps exclusive model activity between children and through physical
cleanup. Each child keeps its own ID and completion lease. Duplicate releases cannot
release a later borrow; overlapping, nested and escaped group ownership is rejected.
Parent cancellation reaches the owned resource. Current-child cancellation/timeout
also reaches resource preparation, while a returned child's late cancellation is
detached and cannot abort a later page. Already-cancelled children acquire nothing.
Physical cleanup is still awaited and work/cleanup errors are both retained.

OCR retains the existing native per-page pipeline and its internal model changes.
This is not a claim that the entire OCR stage uses one persistent model session.
Outside explicit native groups, original per-operation resource lifetimes remain.

## Saved evidence and restart

Plans share the existing encrypted retention catalog and native transactions.
Only one workflow runs per session. Several plans can be prepared, but they are
not an automatically executed FIFO queue. Each attempt and admitted native job ID
is checkpointed. Completed steps are skipped; exact requests replay admission.

Targets bind page/review revisions, source bytes, chapter membership/order and
saved context. Execution settings are fixed in memory, with only a fingerprint
retained. Changed settings after reconstruction refuse resume instead of choosing
a different provider. Credentials and executable model state are never serialized.
Context is read, not regenerated or synthesized from an earlier page.

Lost checkpoints reconcile only against exact owned native change/output receipts.
Erasure also requires its exact completed native job receipt, zero unfinished
blocks and successful cleanup. Inconclusive attempts require explicit review and
retry permission; they are not silently rerun after disconnection.

Pause lets the active child settle then stops. Cancel signals owned work and waits
for cleanup; neither is undo. Active inspection/control never waits behind the
library write lock needed by that child. Session shutdown drains admission and
native completion. Restart never automatically starts a saved workflow.

External stages wait for the host AI to use existing edit/upload tools, then
acknowledge exact saved revisions. Acceptance changes only the plan and leaves it
paused for explicit resume. The app never imagines the disconnected AI continuing.
Completed internal selection plans are released without discarding independent
user plans or durable change history.

## Explicit two-party handoff

Four additional tools expose this connection's non-secret handoff address, offer
one settled plan to an explicitly addressed recipient, accept it, or revoke a
pending offer. Knowing an address, workflow ID or offer ID grants no authority.
Both connections must already be approved, and their current approvals are checked
through publication. The receiver needs permission for every stage, including
images for PNG export. Same-connection new-chat resume needs no handoff.

Offers last at most ten minutes and are lost on MCP restart. Active/admitting,
failed/uncertain attempts and completed workflows cannot be handed off. Run,
settled controls, external acknowledgement, discard and handoff share one admission
boundary. Revoking pending consent deliberately remains possible during staging.

Acceptance revalidates settings and every selected page/source/context. Under the
native write lock it reuses the canonical unlocked context snapshot, not a nested
read lock or a weakened evidence check. The encrypted record and owner index are
published in one native transaction, with another evidence/approval check before
publication. Crash recovery restores both together. Exact accepted replay survives
restart; pending offers do not.

Only the plan changes owner. Completed steps, target order, budgets/counters and
original expiry remain. Existing native job/change/output records stay with the
old owner and their IDs are removed from the transferred plan. The receiver sees
paused or external-waiting state and must explicitly resume. Neither transfer nor
replay edits artwork, renders images or invokes models.

## Limits and test interpretation

At most ten chapters, fifty total pages, five distinct stages and 250 page/stage
steps per plan. There are 128 action receipts, at most 500 page attempts and 5,000
reserved translation requests; defaults remain 200 and 100. Translation has at most
100 eligible blocks per page. Counters are not token or monetary cost estimates.
Existing native timeouts, image/metadata limits and user permissions still apply.

Plans share seven-day retention, 256 catalog entries and 1 GiB with retained changes
and outputs. Full capacity rejects new work rather than evicting unrelated history,
truncating the target or changing image resolution. Discarding a plan is not undo.

Automated tests use isolated real native storage, snapshots, original hashes,
OAuth/HTTP and crash recovery. Model/provider transport boundaries are deterministic
substitutes. Separate real-Electron tests use OS encryption and actual PNG rendering
with session reconstruction. Neither is live model-quality or chat/Tailscale
acceptance. Exact verified commits, counts and log digests belong in the checkpoint.
