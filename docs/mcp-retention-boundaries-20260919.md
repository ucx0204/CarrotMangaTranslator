# Durable recovery / retained output boundaries - 2026-09-19

Status: implemented and registered; all automatic gates passed; live acceptance deferred.
Baseline is bundle-six final `7c3563d4`. Verified code is `09a99b16`.
Keep the single MCP branch and existing review worktree.

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
requires context agreement. Executable model plans never revive.

Read-only PNG/page-batch/ZIP exports preserve the initiating invocation owner
through asynchronous job admission without adding write scopes or change snapshots.
This fixes the native export-owner failure found in the interrupted checkpoint.
The public library gateway deliberately adds libraryRecoveryFacade for native
page/assets/receipt operations; it is not a forwarding barrel for storage access.
Default dependency budgets and all inherited coverage floors are unchanged.

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

## Working-image ownership and cleanup

Recovered working files use the exact native `.mcp-recovered-UUID` directory and
`inpaintedImagePath.png` / `inpaintMaskPath.png` filenames. After projecting all
updates, the recovery transaction compares the before pages with the complete final
chapter. Only replaced, unreferenced, unleased candidates are retired in that same
transaction. Originals, current references, other pages and native history leases
survive. A directory containing unrelated files is not recursively deleted: only
known unused candidate files are retired. Startup rollback restores retired files
before the commit point; committed recovery keeps the replacement and its receipt.

Normal artifact-history release recognizes the same exact working files and removes
an empty containing directory only after the file is unreferenced. Symlink paths are
refused. Unexpected cleanup errors propagate; retry also works if the image itself
was already removed. There is no chapter-wide/library-wide deletion sweep, no
retroactive deletion of unknown directories and no weakening of native leases.
The additional direct canonical storage-helper consumer is documented at fan-in 29
(previously 28), without adding another storage authority or changing global limits.

Private-record discard never deletes a current recovered working image. The 1 GiB
quota is not a cap on original artwork or all ordinary app history. New MCP saves
are captured after activation; old session-only undo is not reconstructed. Work
context migration and resumable model workflows remain separate later bundles.

## Verification interpretation

The complete repository run at `09a99b16` passed all 26 gates: 7,893 passing cases,
zero failures, 11 existing skips. All 1,077 MCP cases across 159 files also passed.
Scoped OAuth/HTTP tests cover reconstructed sessions, ownership, read-only denial,
exact action replay, HEAD/GET byte equality, redaction, revocation and explicit
discard. Authorization is reconstructed from saved state, not a closed session object.

Tests use real isolated transactions, PNGs/ZIPs, authenticated test metadata encryption
and production tools. Simulated process-loss injection checks durable state after
startup transaction recovery. The real Electron check additionally uses OS encryption,
the native renderer and session reconstruction, with byte-identical PNG reissue and
its explicit completion marker/exit code 0. Detailed evidence is in the checkpoint.

No actual model/provider inference, live user artwork, live app restart, chat attachment
reception or public Tailscale acceptance is claimed. Those remain in the final queue.
