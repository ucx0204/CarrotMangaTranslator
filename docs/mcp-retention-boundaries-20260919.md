# Durable recovery / retained output boundaries - 2026-09-19

Status: implemented core; final automatic verification and remaining cleanup work in progress.
Baseline is bundle-six final `7c3563d4`. Keep the single MCP branch and worktree.

## Authority and native persistence

The existing library transaction owns page, recovery record, retained images and
catalog publication together. An opt-in asynchronous chapter participant observes
only actual saved page-content differences; ordinary UI writes have no participant.
The participant is bound to the initiating MCP connection and existing request/job
checks. No raw snapshots or arbitrary local paths are accepted over MCP.
Native rollback and startup recovery apply to all participants at one commit point.
Durable undo/redo uses the normal app handoff, page/context activity ownership and
library mutation queue. Receipts are published atomically with the restored pages.
Later source, page, review, chapter membership/order changes conflict; redo also
requires context agreement. Runtime jobs and executable model plans never revive.

The public library gateway deliberately adds libraryRecoveryFacade for this native
page/assets/receipt operation; it is not a forwarding barrel for storage access.
The source-specific architecture declarations document measured fan-in at shared
activity, logging, lock, revision, fingerprint, error and library authorities, plus
the two existing MCP composition roots. Default dependency budgets are unchanged.

## Retention and public behavior

Eight tools list/inspect changes and outputs, explicitly undo/redo retained changes,
issue a new output link, or explicitly discard one owned retained record.
Metadata is OS-encrypted and domain/data-profile bound through the existing secure
store. A new unrelated OAuth connection cannot inherit another connection's data.
Image copies use private native library files and content hashes. Original files
are never copied back over or replaced. Returned metadata has no local paths,
source text, image payloads, secrets or internal native transaction IDs.

The catalog is bounded to 256 records / 1 GiB, seven days from creation. Individual
files are at most 128 MiB. A native change holds at most 50 pages and 4 MiB of page
metadata; encrypted envelopes have their existing hard size bounds. Each change
has at most 32 retained action receipts. Expiry denies access immediately; the next
native retained write prunes only indexed expired record directories. Capacity
failure refuses the new page commit instead of silently dropping active history.

Output links remain ten-minute session capabilities, never persisted/revived.
Original evidence is captured before rendering and rechecked at native retention.
Reissuing verifies retained bytes, source/page bindings, permissions and redaction,
without rendering again. Streaming checks file identity and authorization at each
chunk. Explicit record discard affects private copies only, not current page files.
Saved page changes make an old output unavailable rather than silently regenerating it.

## Verification and remaining work

Tests use actual isolated library transactions, temporary PNGs, native ZIP creation,
authenticated test encryption, production tool composition and session reconstruction.
Only external Electron/renderer/model boundaries are substituted. Native transaction
crash points cover before publication, during replacement and after the commit point.
Confirmed repairs include missing catalog rejection, output-file integrity during
inspection and pre-render source binding. Missing/corrupt records fail closed.

The new separate OAuth/HTTP extension test write was not executed by the tool.
A proposed managed-directory/candidate-cleanup extension for recovered working
images was also not executed. Current restored working images deliberately remain
independent of retained record deletion; unused `.mcp-recovered-*` working copies
can accumulate after repeated toggling and are outside the 1 GiB private catalog.
Do not advertise a total disk bound or completed cleanup lifecycle until this is
resolved and verified. Do not delete user working images as a workaround.

Live app/model/user artwork and ChatGPT/Tailscale acceptance remain deferred.
Final automated counts and exact commits belong in the checkpoint, not this draft.
