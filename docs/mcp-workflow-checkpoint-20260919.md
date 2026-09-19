# Bundle 8: ordered chapter workflows and explicit resume

Status: IN PROGRESS. Starting verified checkpoint: e30735ef.
Use only feat/mcp-app-bridge and the existing MCP-Review worktree.
Do not restart the live app, alter user artwork/authentication/model assets,
merge master or release. Live acceptance remains deferred.

## Implementation boundary

Reuse the existing MCP operation manager, app jobs, exclusive model ownership,
independent page/selection tools and native encrypted retention transactions.
Add a typed, fixed-target upper-level plan; do not expose arbitrary tool dispatch,
raw snapshots, local paths or credentials. No second GPU scheduler.

Prepare captures chapter order, page/source/context evidence and execution settings.
Run selected stages sequentially, grouping the same stage while preserving page order.
Record each admitted attempt before execution and checkpoint each completed page.
Pause waits at a completed operation boundary; cancel requests native cancellation
and waits for cleanup. Neither means undo. Reconstructed sessions never auto-run.
Resume rechecks current authorization, settings and evidence; completed steps remain
completed. A pending attempt with an uncertain outcome requires durable reconciliation
or explicit retry, never automatic repeat of paid calls. External AI work is a real
waiting state, not an imagined background chat response.

## Work still required

Implement contracts, persistent plan repository, fixed-target executor, lifecycle,
production registration and output schemas. Add real native-storage and scoped HTTP
regressions for partial saves, source/context conflict, restart, duplicate requests,
model cleanup blocking and external waiting. Preserve all inherited coverage floors.
Record exact code commits and completed automatic checks here before completion.
