# Bundle 9: native whole-work context migration boundaries

Bundle 9 remains in progress. This sub-bundle connects explicit catalog/reference
migration and retained recovery. Stale-memory inspection/refresh and multi-work
research are separate remaining work; do not advance to bundle 10.
Use only `feat/mcp-app-bridge` in the existing MCP-Review worktree.

## Inputs and preserved data

The existing whole-work reference reader inspects every declared chapter, its
pages and raw story memories, including orphaned and duplicate memory rows.
Preview supports glossary/character merge, explicit deletion and full replacement
of either catalog. IDs are exact and separately namespaced; matching names do not
imply identity. Manual and legacy entries are protected by default. Destination
fields remain authoritative; copying source aliases is explicit. Removing a
referenced entry requires a surviving enabled destination or explicit unlinking.

The read-only preview never saves an executable plan. Application repeats the same
strict intent with its unfiltered reference snapshot, plan fingerprint and request
ID. The server recomputes its delta; arbitrary page snapshots, paths, scripts and
raw retained records are never accepted. Preview pagination remains read-only.

Only the selected catalog and block speaker/glossary or memory character/glossary
IDs are changed. Mapped duplicate destinations are coalesced; unrelated duplicate
links remain. Dialogue, source text, summaries, digests, rich text, formatting,
geometry, reading order, generated lettering and image bytes are not rewritten.
No OCR, translation, research, image model or renderer is executed.

## Atomic native publication

The existing native activity gate owns work-context writes, structure reads and
per-page editor handoff. Dirty editor checks precede publication. The library write
lock encloses a single existing transaction containing context files, affected
chapter reference fields, normal chapter staging and an encrypted context receipt.
The original work/chapter/context metadata bytes, including file absence, and all
whole-work evidence are rechecked before publication. Metadata hashes do not claim
to inspect image pixels, which this operation neither consumes nor modifies.

Context migrations own their recovery record, like existing durable page recovery.
The generic page-capture wrapper excludes exactly their three mutation tools to
avoid independently staging the same retained index twice. This is not a bypass:
context publication requires its encrypted receipt to succeed in the same commit.
A reproduced duplicate-index failure is covered by actual multi-chapter tests.

Repeated apply/recovery requests return historical receipts, not current-state
claims. Changed inputs cannot reuse a request ID. A no-op retains its explicit
request receipt without rewriting page/catalog content and offers no meaningless
Undo. Notification failures after saving preserve the committed receipt and warn.

## Recovery, ownership and lifetime

Five new tools are registered only through a native session with a retention codec:
`carrot_apply_context_migration`, `carrot_get_context_migration`,
`carrot_list_context_migrations`, `carrot_undo_context_migration`, and
`carrot_redo_context_migration`. Reads require `carrot.read`; mutations also require
`carrot.edit` and `carrot.process`. No image permission or provider call is needed.
The disabled-editing composition keeps read tools but omits mutation tools.

Records are owned by the approved connection and profile. Exact whole-work matching
is required for recovery: subsequent dialogue, catalog, memory, target or membership
changes are not forcefully overwritten. Undo restores optional reference-property
absence and an originally absent catalog file. Unchanged absent memory files remain
absent. Redo validates the expected catalog-file presence again. Other owners cannot
retrieve or apply these receipts. Current authorization and expiry are rechecked
through publication; shutdown cancels pending work and waits for its settlement.

Records share existing seven-day, 256-record, 1-GiB retention; metadata remains capped
at 8 MiB and each record allows 32 Undo/Redo actions. Explicit retained discard removes
only the recovery record, not the current catalog or pages. Context records permit
zero through 1,000 affected pages. Existing page-change/output/workflow records still
require 1 through 50 pages. This does not silently widen their prior limits.

## Direct dependency declarations

Existing shared authorities are reused, not copied or hidden behind forwarding
wrappers. Global architecture/complexity limits remain unchanged. Measured direct
consumer ceilings for this sub-bundle are:

| Existing authority             | Specific limit | Native consumers/reason                                     |
| ------------------------------ | -------------- | ----------------------------------------------------------- |
| `appActivityTypes.ts`          | 31 incoming    | Context transaction and native migration scope              |
| `logger.ts`                    | 41 incoming    | Post-publication notification diagnostics                   |
| `library/lock.ts`              | 31 incoming    | Migration adapter and atomic context facade                 |
| `pageRevision.ts`              | 68 incoming    | Whole-work reference snapshot                               |
| `blockFingerprint.ts`          | 72 incoming    | Catalog/reference/delta/recovery/metadata/receipt identity  |
| `ipcSchemaPrimitives.ts`       | 30 incoming    | Existing speaker/glossary field contract in retained deltas |
| `mcpEditPolicy.ts`             | 136 incoming   | Existing typed conflict/permission/invalid-record authority |
| `library.ts`                   | 68 incoming    | Native per-page ownership reads                             |
| `libraryStore/libraryFiles.ts` | 32 incoming    | Work-wide context reads and reference staging               |
| `mcpAppTools.ts`               | 21 outgoing    | Actual read-only reference and preview composition          |
| `mcpOutputSchemas.ts`          | 25 outgoing    | Strict reference and migration output families              |

The native transaction still rejects overlapping targets and invalid paths. No
parallel library, GPU scheduler, credential store or page-revision algorithm was
introduced. Live user data, app restart, provider quality and public MCP acceptance
remain deferred until all thirteen implementation bundles are complete.
