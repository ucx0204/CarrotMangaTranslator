# Bundle 8: fixed-target sequential workflow boundaries

Bundle 8 remains IN PROGRESS. The connected orchestration core is not the same
as completion of the original model-residency and handoff plan. Preserve the one
`feat/mcp-app-bridge` branch and existing MCP-Review worktree. Live-user, actual
model and public Tailscale acceptance remain deferred until all bundles are built.

## Implemented orchestration

Nine registered tools prepare, inspect/list, explicitly run/resume, pause, cancel,
acknowledge saved external results and discard an owned workflow. Preparation
writes only an encrypted plan, never artwork and never starts a model or renderer.

A plan has 1-10 explicit chapters, at most 50 pages in total and 1-5 distinct stages:
empty-page OCR, saved-source selected translation, native page erasure, PNG export,
or external-result waiting. Chapter order is explicit; pages follow their saved
chapter order. Page IDs are qualified by chapter. No discovered page is added later.
Stages are executed in supplied order; every page in one stage settles before the
next stage begins. There is no local-model parallelism and no arbitrary tool-name,
IPC, path, raw snapshot, credential or code execution input.

OCR preserves nonempty pages. Translation preserves nonempty translations by default
and uses the existing block reading order and selection-analysis/apply paths. An
explicit retranslation can still yield identical text: such a result completes
without an empty apply attempt or page rewrite. Generated image text is excluded.
Erasure uses the existing local app job; a partial/cancelled/failed result, unfinished
blocks or incomplete cleanup are not promoted to completed workflow steps. Saved
partial content remains saved and requires inspection, not implicit undo or retry.

## Ownership, checkpoints and reconstruction

The workflow uses the existing encrypted retention catalog and native transactions.
It does not introduce another GPU scheduler, library, image store or OAuth identity.
Only one workflow is active in the session. Multiple plans may be prepared, but this
is not an automatic FIFO admission queue. Every native child uses existing app job,
page ownership, cancellation, save and model-cleanup boundaries.

Targets bind page/review revisions, original bytes, chapter membership/order and
saved context. Execution uses a captured settings snapshot. Only its fingerprint
is persisted: after reconstruction, changed settings refuse resume; the user must
restore settings or explicitly prepare a new plan for the remaining targets.
Context is read, not regenerated. Previous-page story memory is not synthesized.

Each admitted attempt and child job ID is checkpointed. Completed steps are skipped.
Same request IDs replay their prior admission instead of starting new work. Lost
post-save workflow checkpoints can be reconciled against exact owned native change
or output receipts. Erasure receipts alone do not prove full completion: an uncertain
erasure which saved content remains review-required instead of being reexecuted or
silently treated as success. Explicit retry also requires matching saved pre-state.

Pause lets the current child settle, then starts no next step. Cancel signals only
the owned child and remains running until native cleanup settles. Active status,
replay and control use the owned active record rather than waiting behind a library
read lock held up by that child. Other owners are still rejected. Session shutdown
waits for pending admission and native completion; reopening never auto-runs a plan.

An external step waits for the host AI. The AI uses existing editing/upload tools
and then acknowledges the exact current page/review revisions. Acknowledgement
changes only the checkpoint and leaves the plan paused. The app never assumes the
chat AI continues thinking after disconnection. A new chat using the same approved
OAuth connection may resume; an unrelated connection cannot take over.

Completed internal selection child plans are released after their actual native
save settles, so the 32-plan in-memory editor limit does not truncate long runs.
Independent user-created plans retain their normal lifetime. Durable page-change
history is separate and remains available after child-plan release.

## Limits

Plans share seven-day retention, 256 catalog entries and 1 GiB with retained changes
and outputs. Native metadata/envelope and output limits still apply. A plan has at
most 250 page/stage steps, 64 action receipts, 500 admitted page attempts and 5,000
reserved block translation requests. Defaults are 200 attempts and 100 translation
requests. These counters are not token or monetary estimates. Capacity errors stop
new work rather than evicting another owner, silently truncating targets or resizing.
A translation page is limited to 100 eligible blocks. Existing child timeouts apply.

## Remaining original bundle-eight work

- Hold one existing native model/resource lease across a same-model stage group,
  with trusted child ownership and complete group cleanup before switching models.
  Current code intentionally retains each existing child's load/release cycle;
  it does not claim one model load for the whole group or suppress cleanup hooks.
- Explicit authorized cross-connection handoff, without treating knowledge of a
  workflow ID as authority. Same-connection new-chat resume is already supported.
- Complete additional native workflow acceptance and the final automatic coverage
  inventory. Record actual terminal results in the checkpoint before claiming gates.

General import/research/typography/SFX/ZIP composition remains in later planned
bundles; those independent tools are not silently included in this five-stage core.
No live app restart, model asset change, authentication reset or user artwork edit
is part of this implementation work.
