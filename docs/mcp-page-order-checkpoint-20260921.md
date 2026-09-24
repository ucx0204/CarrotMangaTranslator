# Bundle 10 continuation: reviewed page ordering and exact memory recovery

Latest continuation: `mcp-chapter-deletion-connected-checkpoint-20260921.md`.
Reviewed chapter deletion and exact recovery passed all 26 gates and dedicated
Electron verification at `447c2e7e`. Movement, work/page deletion and general input
remain; historical page-order implementation and verification below are preserved.

Status: IMPLEMENTED, CONNECTED; ALL 26 REPOSITORY GATES AND DEDICATED ELECTRON CHECK PASSED.
Verified source/tests/configuration: `143a4be97048f52e3f00634b1633bb467c8e6442`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting verified checkpoint: `eb85ae79`. Bundle 10 is NOT complete.

## Connected behavior

The existing six library-change tools accept `intent.kind: reorder-pages`, with
work ID, chapter ID and the complete ordered page-ID list. No additional public
tool is created; the output inventory remains 178. Existing rename/chapter-order
contracts and format-1 retained records remain compatible.

Preview returns the actual before/after page IDs and memory row layout (page ID,
index and name), including whether a memory file exists. It reads only native
metadata, does not publish a record, read image bytes or run any model. It does
not return raw summary text, visual descriptions, source digests or image paths.
MCP requires every current page exactly once; missing/extra/duplicate/foreign IDs
and inconsistent saved inventories are rejected. Maximum list length: 2,000.

Apply requires the reviewed intent, current snapshot, plan fingerprint and a new
request ID. Chapter/work metadata, reconciled story memory and the encrypted
recovery record publish in ONE existing native transaction. Page payloads, original
images, masks, block IDs/content, source-import history and other chapters remain.
The existing native partial-order algorithm, status calculation and story-memory
reconciliation are shared, not reimplemented as a parallel MCP library.

Memory reconciliation reindexes/renames rows and follows the existing native policy:
the last duplicate for a page is kept, and rows for absent pages are omitted. This
is visible in the review and warning; it is not new summary generation. The full
supported before/after memory is retained privately for exact Undo, including
manual descriptions, references, text evidence, timestamps, duplicates and orphan
rows. Public callers cannot supply native saved-memory or filesystem objects.

An absent memory file stays absent; an unchanged empty file is not rewritten.
The snapshot distinguishes absence from a subsequently created empty file. Recovery
rejects later memory/content/order edits rather than removing or overwriting them.
Undo restores original metadata timestamps as well as native record order and
memory; Redo uses the same record. Historical retries do not repeat the mutation,
including replaying the original apply after Undo. Record disposal removes recovery,
not the ordinary chapter, its memory or source images.

The existing work/chapter structure gate and work-context ownership protect page
ordering and recovery. Existing typed post-commit metadata notifications update the
library and affected open chapter using the prior dirty-page-preserving merge.
No new polling, renderer, image processing, research or translation was added.

## Regressions and compatibility

Before extraction, two real-library characterization cases passed against the
original desktop reorder. They fix native partial-order behavior, last-duplicate
memory reconciliation, orphan removal, source preservation and absent/empty file
behavior. They also pass against the shared publisher.

A new edge test exposed a false rejection for an unchanged page order when the
physical record-array order differs from the canonical page order. Native stored
data permits this distinction. The first implementation's retained validator
wrongly demanded identical arrays even for a no-op. The fix checks identical
unique inventories while retaining both actual arrays, so unchanged requests stay
unchanged and exact Undo can restore original record order. Failed reproduction:
`.tmp/mcp-page-order-noop-repro.log`. No existing timeout or test skip was changed.

Checks cover real tool registration/output parsing, review immutability,
reconstruction, manual memory preservation, private-content exclusion, no-op,
strict inventories, stale memory, corrupted recovery, late encryption/revocation/
expiry/session-stop/external-memory changes, and existing metadata operations.
The tests also replace a real retained record between read/write admission and
verify that exchanged recovery identity cannot mutate the chapter or memory.
Actual OAuth/HTTP tests retain read-only review, separate edit/process permission,
owner isolation, strict inputs and revoked-access checks.

## Final whole-repository verification

All 26 repository gates passed with actual process exit zero at the verified
source: **8,335 tests passed, zero failures and 11 inherited skips**. The MCP subset
passed **1,490 cases across 257 files**. Four new test files contain 23 cases, with
two more cases added to existing HTTP and renderer files: 25 additional cases total.
The focused implementation run passed 27 cases across six files before the final
identity-race case; the final boundary/inventory run passed 36 cases across two files.

Renderer/Electron/JavaScript types, formatting, lint, error handling, test boundaries,
architecture/maintainability, duplicate/dead-code checks, exact coverage inventory
and floors, Windows build, artwork parity, image protocol and renderer/preload gates
passed in one complete run. The supported process-local eight-worker option was
used; defaults, timeouts, inherited skips and global thresholds are unchanged.
Gate interval: `2026-09-21T01:33:27.673Z` through `2026-09-21T01:38:35.611Z`.

The initial complete suite passed 8,333 tests and failed only the not-yet-registered
new source inventory. That measurement is retained separately, not called a pass.
The exact floor check then found the existing organization adapter at 92/99 branches
versus its original 66/71 floor. The real retained-record replacement test raised
coverage to **93/99 (93.93%)**, preserving the old floor. A narrower coverage-diagnostic
command measured only organization tests and failed global coverage thresholds;
it is not presented as a successful whole-suite run. No threshold was relaxed.

All **1,746 inherited coverage records, provenance and deletion entries remain
identical** to `eb85ae79`. Only `libraryPageOrdering.ts` was registered, bringing
the inventory to **1,747: 756 historical and 991 introduced records**.
Its measurement source is `7721872ce411844a3f4d427f92281a200bafd93a`; V8 summary SHA-256:
`a310e1c22e465fc009b9bfbb0a4d63e1aedf1eb3a4257f9c90bdd163c78b4297`.
Registered metrics: lines 23/25 (92%), statements 24/26 (92.30%), functions 8/8
(100%), branches 22/24 (91.66%). Final complete verification enforces every floor.

Two measured additional dependency consumers (storage 29 to 30 and fingerprint
93 to 94) reflect direct reuse by this one native adapter, not global ceiling
changes, copied authorities or forwarding wrappers.

## Dedicated actual-Electron acceptance

The NEW page-order scenario passed at the same verified source, together with
existing native regressions. It uses only a freshly imported chapter in the
smoke-owned profile, creates a second page fixture, and exercises registered
review/apply, actual native reconciliation/storage and OS-encrypted recovery.

It reconstructs MCP sessions between exact Undo/Redo operations, checks historical
request replay and record disposal, and restores duplicate/orphan memory rows,
manual descriptions and timestamps. A second scenario confirms missing memory
remains missing through apply, reconstruction and recovery. Original image bytes
and native chapter/source metadata are preserved. No model generates the memory.

All six required completion markers were present; actual child exit was zero
and the isolated listener on port **61566** closed. This is not a restart of the
user's running app, a live website, real model quality or public-client acceptance.
External file selection/browser collection in the enclosing import harness use
synthetic boundaries; native storage, image validation and OS encryption are real.

No renderer production source or UI layout changed in this continuation. The added
renderer test verifies the existing explicit metadata refresh restores page order
while retaining dirty page text and selection; no new screenshot claim is made.

Evidence: `.tmp/mcp-page-order-full-check-2.log`, final-evidence.json,
final-source.json, final-vitest.json, final-coverage.json, final-timings.json,
coverage-registration.json and native.log/native-result.json under the same
mcp-page-order prefix. The failed initial full run and no-op reproduction remain
separate. All nineteen changed source/test/configuration hashes were rechecked.
A final documentation REPL transport error briefly rewrote one test with an older
in-memory buffer; it was restored byte-for-byte from the verified commit and all
nineteen hashes were revalidated. No unverified source/test change is retained.
Subsequent documentation commits must compare identical for src/tests/scripts.

## Limits and exact resume point

No moves, deletions, general attachment bytes or working-file input were added.
The shared seven-day/256-record/1-GiB retained catalog and 32 recovery-action limit
remain; ordinary reordered chapters do NOT expire with the record. Native metadata
schema and retained-record size limits also apply. No visual similarity or model
quality guarantee is implied by any metadata fingerprint.

Continue bundle 10 with separately reviewed moves/deletions/recovery and general
incoming file bytes/working-file input. Do not recreate completed import/source
history, names/chapter/page ordering or synchronization, and do not start bundle 11.
All test mutations use isolated fixtures. User artwork/library, credentials,
model assets, Tailscale and OS security settings were not modified or restarted.
No new branch, master merge or release. Live acceptance remains deferred until
all implementation bundles are ready.
