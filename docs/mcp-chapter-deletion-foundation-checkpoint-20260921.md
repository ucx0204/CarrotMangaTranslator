# Bundle 10 continuation: chapter deletion recovery foundation

Status: FOUNDATION IMPLEMENTED; FOCUSED CHECKS PASS; FULL VERIFICATION PENDING.
Public chapter-deletion tools are NOT connected. Bundle 10 is NOT complete.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting verified checkpoint: `e1a57949` (verified production source `143a4be9`).

## Implemented and tested foundation

Four new modules define prospective chapter deletion/recovery contracts, private
record binding, native chapter-removal staging and encrypted filesystem recovery.
The native staging helper uses the existing work/chapter readers, stageWorkFile
and transactional directory retirement. The EXISTING desktop deleteChapter entry
has not been rewired; its original behavior and existing tests remain unchanged.

The recovery adapter inventories a bounded chapter directory, including empty
subdirectories and all ordinary files. It rejects links, nonportable/traversing
paths, missing parents, case-insensitive collisions and oversized inputs. Content
fingerprints use the existing bounded native evidence reader. Recovery COPY is
streamed in 1-MiB chunks; inspection uses the existing per-file SHA reader, not a
new claim of streaming every metadata/evidence read.

Each chunk is encrypted through the existing profile-bound retention codec before
being staged. Identical chunks in one record share a content-addressed asset.
Private chapter metadata, story memory, dialogue and image bytes are not stored
as plaintext recovery assets. All chunks are length/hash checked after decoding;
staged restore uses the same decoder and full-file digest as verification. Exact
source bytes and empty directories can be restored without reconstructing or
normalizing chapter metadata. File handles close on failure and cancellation.

The private record binds the input request and snapshot to work membership,
original/changed work metadata, source inventory and alternating recovery actions.
Pending public contracts require an explicit seven-day recovery acknowledgement.
These schemas are preparation for integration, NOT newly callable MCP tools.

## Actual validation so far

The existing native deletion transaction suite passed seven cases before this
work and again alongside the foundation. The combined focused run passed **19
cases across four files**: twelve new cases and the seven existing cases. Scoped
lint, native Electron TypeScript and architecture checks passed after corrections.
Evidence: `.tmp/mcp-chapter-deletion-native-baseline.log`,
`.tmp/mcp-chapter-deletion-focused.log`, type-2.log, lint-2.log and
architecture-2.log with the same chapter-deletion prefix.

The isolated fixture stages encrypted chunks and native chapter removal in one
real library transaction, reconstructs its client fixture, deserializes its saved
record, and restores exact file bytes/empty directories. It does NOT synthesize a
new retention-index entry, register a deletion tool or claim the production
application's restart orchestration works. Native filesystem/transactions and
image inputs are real; the OS-encryption port is substituted by the existing test
fixture. There is no dedicated actual-Electron deletion scenario or live test.

Failure cases include encryption failure, tampered ciphertext, authenticated but
incorrect chunk bytes, truncated part arrays, occupied restore paths, changed
source contents, cancellation during copying, symlinks, oversized files and path
collisions. External fixture originals are checked unchanged. The first draft's
invalid Unicode-regexp escape was reproduced and corrected. Non-null assertion
and excessive nesting were removed by explicit bounded traversal and per-file
handle ownership, not lint suppression.

## Unapplied integration and withdrawn drafts

A Remote Desktop Commander request to prepare the existing native entrypoint,
retention kind/discard handling and output registration edits was blocked by the
tool safety check BEFORE execution. None of those edits applied. The same request
was not reapplied through another tool. Existing libraryMutations, retention index,
generic discard, output registry, organization session and editor probe remain
unchanged from the starting checkpoint. Output inventory remains **178**.

The initial repository/application/tool drafts needed that integration and caused
native type errors for an unregistered `chapter-deletion` kind. They were withdrawn
from the active tree rather than loosening types or publishing half-connected
mutation tools. Their unverified source remains in Git history around `db33952f`;
it is not certified implementation and must be reviewed before reuse.

The existing four-module foundation, its behavioral tests and precise missing
composition are retained. No authentication, grant, runtime tool permission,
retention pruning policy or existing deletion behavior has been expanded.

## Limits and exact next work

Current foundation limits: 50 pages in the prospective contract, 2,000 filesystem
entries, 128 MiB per ordinary file, 256 MiB source bytes, 1 MiB per encrypted chunk.
The proposed seven-day recovery / shared catalog / 32-action policy is NOT active
for a new deletion tool because there is no registered tool or catalog kind yet.

Next: connect a separately reviewed deletion application to the native transaction
and encrypted catalog; retain the complete directory BEFORE deleting it; recheck
source inventory/ownership/expiry immediately before publication; implement a
fresh trusted closed-editor probe and protective discard behavior; register the
input/output contracts and session lifecycle. Then verify real OAuth/HTTP,
late revocation, filesystem crash recovery, restart replay and actual Electron.
Do not recreate completed import, source matching, names or page ordering.

After chapter deletion is connected and verified, continue separately reviewed
moves, work/page deletion and their recovery, then general incoming file bytes and
working-file input. Do not advance to bundle 11 yet. Real artwork/library,
authentication, model assets, Tailscale and the running user app were not modified
or restarted. All mutations in this continuation are confined to isolated fixtures.

## Quality preservation

All 1,747 inherited coverage records/provenance/deletion entries must remain intact.
Register the four new modules only from actual V8 measurements before declaring
full verification. Four measured single-consumer additions directly reuse the
existing fingerprint/error/library/file authorities; their documented per-module
consumer counts increase by one, with no global ceiling change or forwarding
wrapper. No production renderer or layout was changed.
