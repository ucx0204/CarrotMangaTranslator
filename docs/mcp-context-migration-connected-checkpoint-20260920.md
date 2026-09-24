# Bundle 9: connected context migration and durable recovery

Current continuation: `mcp-memory-refresh-checkpoint-20260920.md` supersedes the
remaining-memory work below. Memory inspection/selected refresh is now implemented,
registered and automatically/native verified at `e6495aa1`. This document preserves
the original catalog migration results. Bundle 9 still needs multi-work research
and durable pending research proposals; do not begin bundle 10.

Status: THIS SUB-BUNDLE IMPLEMENTED AND REGISTERED; AUTOMATIC CHECKS PASSED.
Bundle 9 overall remains IN PROGRESS: memory freshness/selected refresh and
multi-work research are not implemented by this continuation. Do not begin bundle 10.
Verified production/test/script code: `74c6dd525b26bc73defa664edc420129067ef6f8`.
Use only `feat/mcp-app-bridge` and the existing MCP-Review worktree.

This document supersedes `mcp-context-migration-checkpoint-20260920.md` for the
current state. The authorized desktop was available again. The unfinished retention
contract was preserved first in `30bfc25e`; prior reference/preview code was reused.
Bundles 1-8 remain complete and were not reimplemented.

## Connected functionality

The seven actual tool registrations are:

| Read/preview                       | Apply/recovery                   |
| ---------------------------------- | -------------------------------- |
| `carrot_get_context_references`    | `carrot_apply_context_migration` |
| `carrot_preview_context_migration` | `carrot_undo_context_migration`  |
| `carrot_list_context_migrations`   | `carrot_redo_context_migration`  |
| `carrot_get_context_migration`     |                                  |

The first two read tools were connected before this continuation; the remaining
five are now composed through the native retention session. All have strict input
and output schemas. There are 140 registered output contracts overall.
Read tools require `carrot.read`; mutation also requires `carrot.edit` and
`carrot.process`. Turning editing off removes mutations while retaining owned
metadata inspection. No image permission, provider credentials or model call is
needed for these context operations.

Supported explicit intents are glossary/character merge, deletion and full
replacement of either catalog. Manual and legacy entries are protected by default.
IDs are exact, not inferred from names. Source aliases are copied only when
requested. A referenced deletion needs an enabled surviving ID mapping or explicit
unlinking. A replacement cannot silently break existing references.

All declared chapters, pages and raw story-memory rows are inspected, including
orphaned and duplicate memory rows. Only the selected catalog and affected block
speaker/glossary or memory character/glossary IDs change. Dialogue, source text,
summary/digests, visual summaries, formatting, geometry, reading order, generated
lettering and image bytes are preserved. No OCR, translation, internet research,
image generation or rendering is executed by these tools.

Preview stores no executable plan and changes no files. Application repeats the
strict intent with its unfiltered work snapshot, plan fingerprint and request ID;
the server recomputes the change instead of accepting a raw page/record snapshot.

## Atomic publication and exact recovery

Existing native job/activity ownership, per-page editor handoff, library locking
and transactions are reused. Dirty affected pages are rejected before publication.
Catalog files, affected chapter reference fields, story-memory links and the
mandatory encrypted recovery record share one transaction. The complete work
snapshot, original metadata bytes/file absence and current authority are rechecked
before its commit point. These are metadata checks, not image-pixel inspection.

Owned records survive MCP-session reconstruction. Undo/Redo restore exact catalog
content, reference-property absence and an originally absent catalog file without
creating unrelated memory files. Subsequent page/context/membership edits conflict
instead of being overwritten. Existing generic page/output history is unchanged.

Repeated apply/recovery requests return historical receipts without repeating the
write, even after Undo or restart. Changed requests cannot reuse an ID. No-op
intents get a receipt but do not rewrite page/catalog data or offer meaningless
Undo. Notification failure after commit returns the saved receipt with a warning.
Explicit retained discard removes recovery data only, not the saved work.

Records share existing seven-day, 256-record, 1-GiB retention and 8-MiB metadata
bounds. Each record permits 32 Undo/Redo actions. Context records allow 0-1,000
affected pages; existing page-change/output/workflow records still require 1-50.
Whole-work inspection bounds remain 100 chapters, 1,000 pages, 100,000 blocks and
200,000 reference/memory rows. Oversized input fails instead of being truncated.

## Reproduced integration fix

The first native multi-chapter tests failed because the generic page-history
wrapper and the context transaction both staged `.mcp-retained/index.json`.
The wrapper now excludes exactly the three context mutation tools, whose own
mandatory context record shares the native commit. This is not an unrecorded write
path. The same failing cases now pass, including restart and rollback.

The inherited whole-work reader coverage regression was fixed with real native
budget, cross-work identity and invalid-transform tests, not reduced floors.
A 32-transaction retention stress test passed independently but hit its 15-second
case deadline under the complete parallel coverage suite. Only that case now has
a 60-second test deadline; all 32 actual transactions remain, and production/global
timeouts and safeguards are unchanged.

## Final verification

All 26 repository gates passed for the exact verified code above, exit code zero.

| Check                                                               | Observed result                                |
| ------------------------------------------------------------------- | ---------------------------------------------- |
| Complete Vitest/V8 suite                                            | 8,065 passed; zero failures; 11 existing skips |
| MCP tests within the suite                                          | 1,246 passed across 192 files                  |
| Native context/retention/HTTP focused cases                         | 32 passed across 6 files                       |
| Renderer/Electron/JavaScript type projects                          | Passed                                         |
| Lint, format, architecture, duplication, dead code, mock boundaries | Passed                                         |
| Exact coverage-floor and inventory gate                             | Passed                                         |
| Windows build, artwork parity, image protocol and bundle boundaries | Passed                                         |
| Additional isolated real-Electron context scenario                  | Required markers and actual child exit zero    |

The inherited 1,682 coverage records, exact counts, provenance and ten deletion
records are unchanged. Fifteen modules were registered from actual Windows V8
measurement, bringing the total to 1,697. Source-specific direct shared-consumer
counts are documented; global architecture/complexity limits are unchanged.
See `mcp-context-migration-coverage-20260920.md` and
`mcp-context-migration-boundaries-20260920.md`.

Native tests cover multi-chapter application, orphan memories, absent fields/files,
old-request replay, no-op writes, wrong owner, later dialogue edits, dirty editor,
real OAuth/HTTP scopes, revocation during encryption, concurrent raw metadata
changes, retained expiry/discard/capacity and crash recovery before/after commit.

## Real Electron evidence

The existing smoke harness creates a separate temporary library. The new scenario
imports two fixture chapters into a new fixture work and uses actual Electron OS
encryption, native storage, page ownership and registered migration tools. It merges
character references across both chapters and an orphan memory, reconstructs the
MCP session, performs Undo/Redo/Undo, reconstructs again, replays the original request
without changing restored content and discards only its retained record. Original
image bytes are compared unchanged. Both markers were observed:

`PASS native OS-encrypted whole-work context migration -> reconstructed exact reference/memory undo/redo -> historical replay -> retained discard; originals preserved`

`PASS MCP native smoke finished`

Actual child exit: `0`, signal `None`.
The test used isolated port 38568 and `CARROT_MCP_SMOKE_TAILSCALE=0`.
The first direct PowerShell GUI launch produced no observable output and is NOT
accepted evidence; its empty `mcp-context-migration-native.log` is historical only.
The verified launch used Node child-process observation, explicit stdout/stderr
capture and desktop Electron mode in that child, with no global environment changes.

Authoritative evidence is in `.tmp/mcp-context-migration-final-evidence.json`,
`mcp-context-migration-final-timings.json`, `mcp-context-migration-final-vitest.json`,
`mcp-context-migration-final-coverage.json`, `mcp-context-migration-check-final2.log`,
`mcp-context-migration-native-captured.log` and `mcp-context-migration-native-exit.json`.
Gate interval: `2026-09-20T03:15:46.376Z` through `2026-09-20T03:19:22.757Z`.
Native log SHA-256: `e0c644352feaf481fb2f63c869955b803dd549f7adb30a23b40cf8f3767f9b48`.

## Exact next work: continue bundle 9

1. Implement stale-memory inspection and selected refresh. Reuse the existing
   `storyMemoryBuilder.ts`, `workContextPageMemory.ts` and analysis boundaries.
   `sourceDigest`/`translatedDigest` are compact text excerpts, not full hashes:
   matching truncated excerpts cannot prove that the entire page is unchanged.
   `buildMergedPageMemory` preserves an existing summary ahead of a new suggestion;
   rerunning it alone is not proof that an old summary was refreshed. Preserve
   manual visual summaries, define explicit summary replacement and track the
   actual input evidence for the content being refreshed. Do not stamp old unknown
   memory as current merely by updating its timestamp or excerpts.
2. Connect multi-work research with fixed work/title scope, ambiguity holds,
   explicit external-processing limits, partial failures and resume. Reuse
   `McpContextResearchService`, the existing native research adapter and bundle-eight
   checkpoint/ownership infrastructure, not a second GPU scheduler. Existing
   `McpContextProposalService` proposals still live in memory for 30 minutes (128
   proposals); durable migration records do NOT retroactively retain those results.
   Resolve research-result retention and exact per-work application before claiming
   restart-safe multi-work research. Internet facts are not read-chapter events.

The user's running app was not restarted. User artwork/library, credentials, model
assets, Tailscale and Windows security settings were not changed. New fixture data
was confined to isolated temporary libraries. No master merge or release occurred.
Live models, public MCP/client calls and actual user-app restart acceptance remain
deferred until all thirteen implementation bundles are complete.
