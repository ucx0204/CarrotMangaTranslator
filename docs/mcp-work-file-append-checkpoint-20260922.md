# Bundle 10: append native working files

> Current status: integration complete. Read
> `mcp-work-file-append-integration-checkpoint-20260922.md` for the final all-gates
> and actual Electron pass. The failure/registration notes below are historical.

Status: CONNECTED; FOCUSED AND ACTUAL ELECTRON CHECKS PASSED; REPOSITORY GATES INCOMPLETE.
Latest tested source/tests: `fd0e93341903b04dcc70b644471919c84bca0480`.
Native/build source: `4c77e72b09953650b5f578b09b057ea1d8b1960b`.
Starting checkpoint: `adda5145`. Keep `feat/mcp-app-bridge` only.
Code and tests were written through GitHub and verified in the existing MCP-Review
worktree through Remote Desktop Commander. Do not declare bundle 10 complete or
start bundle 11 before closing the integration gates below. Live acceptance remains
deferred; no live app restart, real library/manuscript, authentication, model asset,
Tailscale or OS-setting changes, additional branch, master merge or release.

## Connected behavior

The new read-only `carrot_preview_work_file_append` inspects selected COMPLETE
chapters from an owned live `.mgtshare` upload against one existing destination.
It returns a target snapshot, effective allocated titles, preserved chapter count,
reference problems and eligibility. The existing `carrot_import_work_file` now
accepts that explicit `target.mode: append` as well as its prior new-work mode.
The strict output inventory increases from 214 to 215. No replacement mode is
exposed through the MCP command; the native UI replacement workflow remains separate.

Append means adding the selected chapters at the END in their requested order.
It does not retire, rewrite, retitle or reorder existing chapters. Existing chapter
metadata, original files, masks, memory and other sidecars are preserved. The native
title allocator resolves collisions; later chapter reordering is a separate tool.
Original/processed images, editable blocks, supported formatting and block reading /
completion references use the existing share materializer with new native identities.
The new work-file receipt reports only the newly created chapter IDs.

The native append workflow reuses library structural ownership, the library mutation
boundary, native image validation/materialization and the existing transaction.
New chapter directories, destination membership and the existing encrypted receipt
commit or roll back together. No second uploader, ZIP reader, importer, retention
catalog, renderer, model queue or context-merging engine was introduced.
The publication type is shared below both native workflows to avoid a dependency cycle.

## Destination context and references

`contextPolicy: preserve-destination` is explicit and currently the only append
policy. The destination guide, rules and reading direction remain authoritative;
the package guide is NOT merged into them. This differs from new-work import, which
can copy the package's supported guide into its new work. Use the already existing
context-editing tools for an explicitly reviewed destination catalog change.

The existing chapter-movement reference planner is reused. Referenced glossary and
character IDs with matching definitions can remain unchanged. Missing or different
destination definitions require explicit mappings to existing destination IDs.
Mappings modify incoming blocks only; no existing chapter or catalog is rewritten.
Unresolved mappings make the review ineligible and publication fails before decoding.
Mappings unused across the WHOLE selected group are rejected. A mapping used by one
selected chapter is not incorrectly rejected just because another chapter lacks it.
Definitions are not automatically guessed by similar names.

The target snapshot binds the input upload/source snapshot, selected chapter IDs,
requested titles/order, mapping policy, destination membership/title allocation and
semantic guide content. An absent native guide has transient default timestamps;
those timestamps do not create false revision conflicts or cause a new guide file.
Source integrity and destination state are rechecked at native publication. Later
context/title/membership changes cause rejection rather than overwriting user edits.

## Correct command flow

First obtain the ordinary source review using `carrot_preview_work_file`.
Call `carrot_preview_work_file_append` with that source snapshot, the ORIGINAL
requested chapter selection/titles and the destination policy/mappings.
Then reuse those same original chapter arguments and root source snapshot in
`carrot_import_work_file`, adding the returned `target`, a requestId, and the existing
`allowNativePreparation: true` / `acknowledgeV1Limitations: true` acknowledgments.

Do not substitute the destination snapshot for the root source snapshot. The
append review's chapter titles show allocated destination names; do not replace the
original requested titles with those names under the old target snapshot. Changing
selection, titles or mappings requires a fresh append review.

## Lifetime, failure and compatibility

A live owned upload is required until import settles. Review does not promise an
independent copied work file. Active consumers retain their source lease; disposal,
expiry, cancellation, source tampering and revocation are checked by existing upload
and operation boundaries. Encryption or pre-commit failures leave no partial append.

Same-request replay returns the original historical completion after upload disposal
or MCP session reconstruction, including reconstruction without the job journal.
Receipt disposal does not remove imported chapters or reset a live upload's consumed
state. Receipt work identity must agree with its original append destination.
A fresh upload of identical bytes remains an explicit additional copy; this is not
cross-upload/global working-file deduplication or automatic new-chapter detection.
Existing new-work commands and receipts remain supported.

Native v1 limitations remain: its normal export does not include chapter memory
files, local masks, model checkpoints or full editing history. Append preserves the
DESTINATION's existing files; it does not manufacture those missing SOURCE assets.
OCR, translation, research, summary generation, output sync and model execution are
not implicit in review or import. No new renderer layout or live UI refresh claim.

## Checks and corrections

The initial append timestamp calculation failed on legacy/test metadata containing
a non-date update marker. It now uses the existing native monotonic timestamp helper,
which already handles invalid historic timestamps. The library's stored-data schema
was not relaxed. Tests also required a real persisted destination guide and a valid
native tone enum, rather than malformed test-only context values.
The installed schema-library version lacked the initially assumed safeExtend API;
base-shape extension followed by the same mapping refinement fixes that compatibility
issue without changing dependencies. Formatter races were handled without force
updates or discarding concurrent commits. Source/fixture formatting now passes.

At `fd0e9334`, all 48 focused work-file/output-contract cases across 14 files passed.
This includes 40 work-file cases across 13 files: 21 prior cases and 19 new cases.
New checks cover append preservation, collision titles, editable blocks/images,
explicit reference mappings across one/multiple chapters, unresolved/duplicate/unused
mappings, destination changes, input tampering/expiry, cancellation and active leases,
encryption failure, revocation during encrypted catalog staging, historic replay,
foreign OAuth ownership, read-only import refusal, receipt work rebinding and opaque
existing sidecar preservation. The memory-sidecar test deliberately verifies byte
preservation without parsing/repairing legacy memory; it is not a memory-quality test.

The final full V8 suite ran at `fd0e9334`: 8,563 passed, ONE failed, 11 inherited skips
(8,575 total). The sole failure is the coverage inventory test, which correctly finds
three not-yet-registered introduced source files (1,033 registered vs 1,036 expected).
All 4,369 tracked source/test/script hashes matched before and after that full run.
This is NOT a passing full suite or complete repository check.

The complete 26-stage orchestrator stopped on architecture: 18 of the 19 executed
stages passed, including all three type projects, format/lint, error handling, mock
boundaries, duplicate/re-export/generated/CSS/script checks and unused code.
It did not reach its full-suite/build/parity tail. Windows build and native checks
were run separately and must not be substituted for a passing complete orchestrator.
Existing architecture and all 1,789 coverage records have not been weakened or removed.

## Actual Electron evidence

The append scenario is connected to the existing native work-file/library harness.
It exports and uploads actual editable PNG-based work-file bytes, reviews a target,
appends through native image/storage/transaction/OS-encryption code, disposes the
upload, reconstructs the MCP client, replays without duplicate chapters, discards
the receipt and checks original chapter bytes, guide presence/bytes and work count.

Actual child exit: 0. All FOURTEEN required completion markers were present,
including `PASS native work-file append -> existing chapters and context preserved`
and `PASS MCP native smoke finished`. Isolated listener 63997 was confirmed closed.
The prior thirteen import, source-history, organization, page/chapter/work recovery,
chapter movement and exact-2,000-entry work-recovery markers also passed.
Native/build source is `4c77e72b`; later implementation changes were formatting only,
with four additional boundary cases covered by the final focused and full runs.
Native storage, image validation and OS encryption are real; existing browser/picker/
editor and expensive-model boundaries remain isolated fixtures, not live acceptance.

## Limits

Whole reviewed package: at most ten chapters, fifty pages, 2,000 file entries,
256 MiB expanded and 128 MiB per entry. Destination membership after append: at most
2,000 chapters. Existing upload transport remains 128 MiB per file, sixteen files /
256 MiB per session, 32-KiB chunks, 4,096 chunks and fixed thirty-minute expiry.
Receipts use existing same-profile/approved-owner seven-day retention with shared
256-record/1-GiB quotas. Receipt expiry does not delete imported chapters.
This run is not a maximum-byte transfer benchmark or every-codec/live-site test.

## Exact remaining integration work

Do NOT rebuild append, the uploader, new-work import, references or prior library
features. Complete the following registration/integration work and rerun checks.

Architecture currently reports eight measured dependency-budget mismatches:

- `src/main/library/lock.ts`: consumers 45 / recorded 44.
- `src/shared/blockFingerprint.ts`: consumers 119 / recorded 117.
- `src/main/application/mcpEditPolicy.ts`: consumers 182 / recorded 181.
- `src/main/libraryStore/libraryPaths.ts`: consumers 30 / recorded 29.
- `src/main/libraryStore/libraryFiles.ts`: consumers 44 / recorded 43.
- `src/main/libraryStore/libraryTransaction.ts`: consumers 31 / recorded 30.
- `src/main/libraryStore/libraryTransactionFiles.ts`: consumers 26 / recorded 25.
- `src/main/libraryStore/shareWorkflow.ts`: runtime imports 14 / recorded 13.

Review the concrete native append and target-review consumers, preserve all global
and unrelated rules, and document any justified file-specific changes. Do not hide
edges behind forwarding wrappers. The earlier circular type dependency is fixed.

Coverage registration is missing for exactly:

- `src/main/libraryStore/shareAppendWorkflow.ts`.
- `src/main/libraryStore/shareImportPublication.ts`.
- `src/main/mcp/mcpWorkFileAppend.ts`.

Use the retained full Windows/V8 measurements to register actual metrics, preserving
all old records/provenance; update the exact inventory assertion from 1,033 to 1,036.
Then run the existing coverage gate and address any inherited regressions with tests,
not reduced floors. The current missing-record failure prevents a claim that the
inherited coverage comparison itself has finished. Rerun all 26 stages and native
checks at the final source before marking this unit or bundle 10 complete.

Evidence prefix: `.tmp/mcp-work-append-`. Final source/hash inventory, full suite
log/result/Vitest/coverage, focused-final log/JSON, check-final log and native
log/result are preserved. Earlier invalid-schema, timestamp, malformed-fixture and
format failures remain historical evidence, not rewritten as successful runs.
Two combined REPL inspection/format-preview requests were stopped by tool safety
before execution; no configuration write was reported as successful on that basis.
Final handoff must verify a clean worktree and local/remote equality, and keep all
post-verification edits documentation-only. Live `망번테스트` acceptance stays deferred.
