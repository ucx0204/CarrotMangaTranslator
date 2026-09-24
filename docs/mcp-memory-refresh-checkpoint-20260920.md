# Bundle 9 continuation: selected memory refresh

Status: MEMORY SUB-BUNDLE IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES AND
ISOLATED NATIVE CHECKS PASSED; LIVE ACCEPTANCE DEFERRED.
Verified production/test source: `e6495aa126a9d1d3df0a45fa7cbd53a98291ebf4`.
Starting point: `45898497`. Use only `feat/mcp-app-bridge` in the existing
MCP-Review worktree. Bundle 9 is NOT complete: multi-work research and durable
pending research proposals remain. Do not begin bundle 10 or redo prior bundles.

## Connected independent tools

| Tool                            | Actual behavior                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `carrot_get_memory_status`      | Read full saved-text evidence; distinguish current/stale/unknown/missing/duplicate/orphan memories in one work. |
| `carrot_preview_memory_refresh` | Preview selected native excerpts or caller-reviewed page-only summaries without writing anything.               |
| `carrot_apply_memory_refresh`   | Publish the exact reviewed intent with mandatory encrypted context recovery and current whole-work checks.      |

The real desktop composition and strict input/output schemas register all three.
There are 143 registered output contracts overall. Reads need only read scope;
application additionally requires the existing edit/process scopes and enabled
editing/processing. Closing a session blocks new reads and waits for admitted writes.

## Freshness is full saved input, not a quality claim

Compare complete source/translated strings, stored block order and speaker/glossary
references using the existing canonical hash. Root guide timestamps are not content;
actual guide changes conservatively stale memory. Bind the current summary, excerpts
and memory reference lists to their own fingerprint. Later summary edits cannot
silently retain the previous proof.

Legacy compact sourceDigest/translatedDigest fields are excerpts, not full-input
fingerprints. Legacy rows therefore report unknown, even when timestamps or visible
excerpts match. Current means the saved text/context evidence still matches; it does
not certify OCR accuracy, visual facts or semantic summary quality. Manual visual
descriptions remain preserved and explicitly unverified by these text-only tools.

## Selected refresh and exact restoration

Select at most 50 saved pages in one inspected work. Use either the existing native
story-memory excerpt builder or a caller-reviewed page summary of at most 1,200
characters. The native option is deterministic excerpt generation, not AI inference.
The reviewed option must describe the saved page, not newly researched web facts.
No OCR, translation, image processing, renderer, search engine or model is invoked.

Existing nonempty summaries require explicit replaceExistingSummary permission.
Keeping an obsolete summary while updating excerpts/timestamps is not considered
a successful refresh. Duplicate memory rows reject refresh; orphan rows remain
untouched. Empty saved text rejects rather than treating image-only observations as
verified page-text memory. Unselected rows, manual visuals, existing references,
work catalogs, dialogue, page geometry, masks and original images are preserved.

The native context application accepts a trusted internal preparation callback,
never a transport-supplied delta/snapshot or executable code. Whole-work evidence,
metadata bytes and file presence, existing activity ownership, transactions and
encrypted recovery share the original native publication boundary. An identical
refresh is a no-op; request replay returns its historical receipt without applying
again, including after restart and Undo.

Use the existing context-migration get/list/Undo/Redo tools for these receipts.
Newly created memory files restore to true absence. Availability and publication
both reject a manually recreated empty memory/catalog file, rather than displaying
canRedo=true for an operation that must fail. Pre-presence legacy recovery records
remain usable. Retention stays seven days, 256 entries and 1 GiB, with at most 32
recovery actions per record. These limits apply to recovery, not to saved memories.

## Reproduced fixes

Two failing cases showed that speaker/glossary-reference-only edits were initially
missing from new freshness evidence. Including those native block references fixes
both without changing the existing hash algorithm. A separate failing native case
showed availability incorrectly reporting Redo possible after a user recreated an
empty file; inspection and publication now share the actual file-presence checker.
The equivalent originally absent catalog case and legacy record reconstruction are
also covered. Old native summary-merge behavior is unchanged and cannot manufacture
new full-text evidence for a retained obsolete summary.

## Final automatic verification

The exact source above passed all 26 repository gates with exit code zero.

| Check                                                                | Result                                         |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Complete Vitest/V8 suite                                             | 8,087 passed; zero failures; 11 existing skips |
| MCP tests within that suite                                          | 1,268 passed across 196 files                  |
| Renderer/Electron/JavaScript type projects                           | Passed                                         |
| Lint, format, architecture, duplicate/dead-code and test boundaries  | Passed                                         |
| Exact coverage-floor and inventory checks                            | Passed                                         |
| Windows application build                                            | Passed                                         |
| Existing artwork parity, image protocol, renderer/preload boundaries | Passed                                         |
| Additional isolated real Electron memory and context scenario        | Required markers and actual child exit zero    |

All 1,697 inherited coverage records, provenance and deletion records are unchanged
from 45898497. Five modules were registered from actual Windows V8 counters, bringing
the inventory to 1,702. The original first run failed only missing inventory; that
run is not substituted for this final complete success. Global limits and existing
floors were not lowered. Specific direct-consumer declarations and their measured
rationale are recorded in the boundary document.

## Native evidence and protected state

The existing Electron smoke harness ran with isolated port 38575 and Tailscale
disabled, using only its temporary library. The memory scenario used real Electron,
OS encryption, native publication, the existing excerpt builder and registered tools:

missing memory -> read/preview without writes -> explicit refresh -> current proof
-> reconstructed session -> Undo restores missing file -> exact historical replay
-> Redo restores saved memory -> Undo/discard -> original text and pixels unchanged.

Both the memory-specific PASS marker and `PASS MCP native smoke finished` were
observed, along with the actual child exit code zero. A prior PowerShell invocation
produced the markers but lost its child exit-code property, so its wrapper exit was
not treated as proof; the final process was tracked by its actual subprocess handle.
Other model-dependent smoke paths use test boundaries, not live provider quality.

Gate interval: `2026-09-20T05:00:07.435Z` through `2026-09-20T05:04:29.516Z`.
Evidence: `.tmp/mcp-memory-final-evidence.json`, final timings/Vitest/coverage JSON,
`.tmp/mcp-memory-check-final.log`, `.tmp/mcp-memory-native-final-stdout.log`,
`.tmp/mcp-memory-native-final-stderr.log` and `.tmp/check-logs/`.
The running user app, artwork, credentials, model assets, Tailscale and Windows
security settings were not changed. No new branch, master merge or release.

## Exact next implementation: remaining bundle 9 research

Existing single-work research proposals still live in McpContextProposalService's
session-local maps (30 minutes/128 entries). Existing research service/native adapter
already handle app research, saved-context checks, ownership and engine cleanup.
Reuse them rather than adding another researcher or GPU queue.

First retain pending reviewed research proposals, stable identities, evidence,
options and per-work results in encrypted storage. An unapplied proposal is not an
applied context-change record; catalog kinds/readers must retain strict consistent
schemas. Preserve owner/expiry, manual information and replay through reconstruction.

Then connect explicit work/anchor/title/engine/context selection to sequential
multi-work research, per-work hold/failure, cancellation and explicit resume using
existing job/activity/model boundaries. Keep completed proposals instead of querying
again after restart. Apply selected changes through native context migration/recovery
with reference continuity. Ambiguous titles, conflicting sources and spoiler bounds
must be reported; internet knowledge never becomes page-read memory.

Bundle 9 remains in progress. Catalog migration plus memory refresh are verified;
multi-work research and durable pending proposals are the next work, not bundle 10.
