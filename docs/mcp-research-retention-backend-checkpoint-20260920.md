# Bundle 9 continuation: native retained research backend

Latest continuation: `mcp-research-evidence-checkpoint-20260920.md`. Research
whole-work evidence and safe job-reference handling pass all gates at `2afa6ccb`;
public retained-proposal wiring and multi-work research still remain. The backend
implementation and historical verification below are preserved.

Status: NATIVE STORAGE/APPLICATION IMPLEMENTED AND AUTOMATICALLY VERIFIED;
PUBLIC TOOL INTEGRATION IS STILL PENDING. Do not mark bundle 9 complete or begin bundle 10. Continue only on
`feat/mcp-app-bridge` in the existing MCP-Review worktree.
Starting checkpoint: `4706def9`.

## Implemented scope

Four native modules implement private retained research reviews, separate from
applied context migrations:

- `src/main/application/mcpResearchProposalState.ts`: strict private record and
  provenance schemas. New entry identities are serialized as tuples so special
  data keys survive reconstruction without prototype-key filtering.
- `src/main/application/mcpResearchProposalPolicy.ts`: existing partial-edit
  planner plus complete saved-work evidence. No replacement researcher or model.
- `src/main/mcp/mcpResearchProposalRepository.ts`: encrypted pending reviews,
  stable preparation replay, ownership, seven-day expiry and paginated inspection.
- `src/main/mcp/mcpResearchProposalApplication.ts`: selected catalog application
  through the existing context migration/recovery boundary.

Publication stages the native catalog change, applied review receipt and context
recovery in one existing library transaction. A trusted native-only publication
callback updates the pending record before the shared retained index is staged
once. Original storage encryption, byte/count limits, authorization and cleanup
remain active. No transport accepts callbacks, raw records or arbitrary file paths.

Research records share the existing seven-day/256-entry/1-GiB catalog. Review
expiry does not delete saved context. Discarding the review does not remove its
separate context recovery. Manual entry provenance, references, unrelated catalog
fields, memories, page dialogue and images remain under the existing policies.

## Reproduced fixes

The prior workflow-expiry test used the child error sink as a parent-settlement
signal. GitHub update `8a93da03` replaces that race with a bounded wait for the
same final `not_found` rejection and verifies zero outputs, one renderer call,
no translation and released activity leases. Production expiry is unchanged.

A new native test reproduced different revisions in the first application receipt
and its persisted replay: final validation recomputed timestamps after staging.
The response now uses the immutable receipt captured at actual publication.
It is compared against the saved native revision as well as historical replay.

A second native test reproduced loss of an own-property `__proto__` change ID
through record-schema parsing. Tuple serialization and native Object.fromEntries
reconstruction preserve the existing planner's exact reviewed entry identity.
The original hashing, ID generation and partial editor were not changed.

## Actual verification boundary

The first corrected native run passed 11 tests in the retention/publication suites,
including encrypted reconstruction, selected application, exact Undo/Redo through
existing tools, stale other-chapter evidence, ownership, one-shot application,
no-op receipts, review discard, authority revocation during encryption, encryption
failure, expiry during publication, and crashes before/after the commit point.
Electron type checking and scoped ESLint also passed. Expanded native coverage
now passes 17 tests across four files, adding simultaneous preparation/application,
read-clone isolation, shutdown, absent anchors/records, strict record/index binding
and late saved-work edits during encryption. Architecture and unused-export checks
also pass. The final complete repository result is recorded below; the earlier focused run remains a separate measurement.

These tests use temporary libraries and the real native library transaction,
retention codec interface, application services, context recovery and existing
discard/recovery tool paths. OS encryption and Electron are fixture boundaries;
no live provider, user manuscript, Tailscale or public-client acceptance is claimed.

## Measured initial coverage for the four new modules

All 1,703 inherited coverage rows, provenance and ten deletion records match
`4706def9` exactly. Four Windows Vitest/V8 measurements bring the inventory to
1,707 rows. No inherited floor or global test limit was lowered.

| Module                            | Lines | Statements | Functions | Branches |
| --------------------------------- | ----- | ---------- | --------- | -------- |
| mcpResearchProposalState.ts       | 25/25 | 29/29      | 11/11     | 35/35    |
| mcpResearchProposalPolicy.ts      | 14/14 | 15/15      | 3/3       | 10/10    |
| mcpResearchProposalRepository.ts  | 67/68 | 70/71      | 18/18     | 36/37    |
| mcpResearchProposalApplication.ts | 26/34 | 29/37      | 5/6       | 11/16    |

Source: `.tmp/mcp-research-retention-coverage-final/coverage-summary.json`.
SHA-256: `bc624b080caa47900e36c17189185bc21983b80db2ff22b0eddfac8f83953f33`. These are measured initial floors, not a claim
that every invariant/contended recovery branch has full coverage.

Source-specific direct-consumer declarations are native lock 33, canonical hash
77 and typed MCP errors 141. The repository/application add two lock/hash callers;
the native policy adds the third typed-error caller. Global ceilings, algorithms
and authority checks are unchanged.

## Final repository verification

Verified code/test/configuration: `98e3fa06beaa9b616116c2c4d5cf39e0f9decd81`. All 26 repository gates
passed with exit code zero. Full Vitest/V8 suite: **8,115 passed, zero failures,
11 inherited skips**. MCP subset: **1,296 passed across 202 files**.

Renderer, Electron and JavaScript type projects, lint, formatting, architecture,
duplicate/dead-code rules, test boundaries, exact coverage/inventory, Windows
application build, existing native artwork parity, image protocol and renderer/
preload boundaries all passed in that same sequence.

The prior workflow expiry/reconciliation test passed within the complete suite,
not only alone. The new retained research suites passed 17 cases across four files.
The new backend does not yet have a registered-tool OAuth/HTTP or standalone actual
Electron research scenario; these remain part of the public integration work.
The existing artwork-parity gate is not substituted for that missing research check.

Two preliminary complete-check attempts stopped first on one source-format issue
and then on unsorted new coverage keys. They were fixed by formatting and ordering
only; no algorithm, coverage value or existing assertion was weakened. Those failed
logs remain `.tmp/mcp-research-retention-format-failure.log` and
`.tmp/mcp-research-retention-inventory-failure.log`, with the latter test/timing JSON
saved separately. They are not treated as successful full checks.

Final interval: `2026-09-20T07:56:04.196Z` through
`2026-09-20T08:00:05.990Z`. Evidence: `.tmp/mcp-research-retention-check-verified.log`,
`.tmp/mcp-research-retention-final-evidence.json`,
`.tmp/mcp-research-retention-final-vitest.json` and
`.tmp/mcp-research-retention-final-timings.json`.

The existing public proposal service, context tools/session, page-session
composition and job journal are byte-identical to `4706def9`. This confirms the
blocked integration request was not partially applied. Further final checkpoint
updates change documentation only; no user app, artwork, credentials, model assets,
Tailscale, master or release settings were changed.

## Unapplied integration and next work

The multi-file request that routed McpContextProposalService and the desktop
composition to this backend was rejected by the tool safety check before execution.
It was not reapplied through another tool. The unregistered research-session tool
factory was removed. Current public output-contract count remains 143.

Consequently, current public `carrot_preview_context_research`,
`carrot_run_context_research`, `carrot_get_context_proposal` and
`carrot_apply_context_proposal` STILL use the old session-local proposal service.
The existing research-gap characterization remains intentionally unchanged.
Native backend success is not a claim that those tools retain reviews yet.

Next, connect the native backend to the existing proposal service and composition,
register strict owned listing/inspection contracts, and persist only safe stable
proposal references in the job journal. Carry app research title/engine/usage and
whole-work evidence through the existing researcher, including the interval after
engine cleanup and before proposal publication. Then verify full OAuth/HTTP and
real Electron reconstruction through those actual registered tools.

Only after that, add fixed multi-work selection, ambiguity/spoiler holds, bounded
sequential research, per-work failures, cancellation and explicit resume. Keep
completed proposals without rerunning searches; never turn internet findings into
page-read memory. Existing merge/replacement/reference migration and memory refresh
remain verified and must not be rebuilt.

No user app restart, credential/model changes, live artwork processing, new branch,
master merge or release belong to this continuation.
