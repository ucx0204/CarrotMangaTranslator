# Bundle 10: native work-file append integration

Status: COMPLETE WITHIN DOCUMENTED LIMITS; ALL 26 GATES AND NATIVE CHECKS PASSED.
Verified source/tests/configuration: `64beb6beb47707ae35c09034f9db5690f897483c`.
Starting checkpoint: `213ce03e`. Continue only on `feat/mcp-app-bridge`.
Bundle 10 is now implemented and automatically verified; live acceptance remains
in the final integrated queue after bundles 11-13. This is not a claim that every
app operation, every site/codec, or every client attachment transport is implemented.

This continuation closes the remaining architecture/coverage registration. It does
not recreate the already connected append feature, add another tool, or modify the
import algorithm. Code/configuration writes used GitHub; verification used Remote
Desktop Commander in the existing MCP-Review worktree. Output contracts remain 215.

## Reviewed architecture entries

The native append workflow directly reuses the original library snapshot, path,
transaction and membership writer. The MCP append adapter directly reuses the native
read lock, stable hash and typed errors for source/selection/destination evidence.
There is no new importer, locking authority or dependency-hiding forwarding file.

Exact changes to file-specific ceilings:

- `src/main/library/lock.ts`: consumers 44 to 45; `mcpWorkFileAppend.ts`.
- `src/shared/blockFingerprint.ts`: consumers 117 to 119;
  `shareAppendWorkflow.ts` and `mcpWorkFileAppend.ts`.
- `src/main/application/mcpEditPolicy.ts`: consumers 181 to 182;
  `mcpWorkFileAppend.ts`.
- `src/main/libraryStore/libraryPaths.ts`: consumers 29 to 30;
  `shareAppendWorkflow.ts`.
- `src/main/libraryStore/libraryFiles.ts`: consumers 43 to 44;
  `shareAppendWorkflow.ts`.
- `src/main/libraryStore/libraryTransaction.ts`: consumers 30 to 31;
  `shareAppendWorkflow.ts`.
- `src/main/libraryStore/libraryTransactionFiles.ts`: consumers 25 to 26;
  `shareAppendWorkflow.ts`.
- `src/main/libraryStore/shareWorkflow.ts`: runtime imports 13 to 14;
  direct routing to the native append workflow.

The first seven rows are incoming runtime consumers; the final row is outgoing
runtime imports. Six old exception counts change with their historical reasons
preserved. Two receive explicit file-specific reasons. Global ceilings, all legacy
ceilings, unrelated exceptions and dependency rules remain unchanged. Type-only
publication contracts do not contribute runtime coupling. Native preservation,
rollback, scoped HTTP and reconstructed-replay tests characterize these exact edges.
The existing unrelated importPreviewIpc lower-ceiling notice was not changed.

## Measured coverage registration

Measurement source: `fd0e93341903b04dcc70b644471919c84bca0480`.
Artifact: `.tmp/mcp-work-append-final-coverage.json` from the prior FULL Windows/V8
run. SHA-256:
`aff2d941a59afb60d258830a2022ea42720d31b9be34d03093b2ac2fd32636ce`.
That historical run had 8,563 passes, one missing-inventory failure and 11 skips.

Three introduced records were added: `shareAppendWorkflow.ts`,
`shareImportPublication.ts`, and `mcpWorkFileAppend.ts`. All 1,789 inherited records,
provenance and deletion policy remain unchanged. The total is now 1,792:
756 existing and 1,036 introduced records. Every new metric was independently
compared against the saved measurement, including exact covered/total values.
The inventory test differs only in its 1,033 to 1,036 count assertion.
The publication-contract module contains types only; its 0/0 metrics are not
an assertion that executable behavior was exercised.

Before registration, the existing coverage gate compared a temporary proposed
manifest with the saved measurement and passed. After registration, both the direct
coverage gate and the FINAL complete repository check passed all inherited and new
floors. No test was removed/skipped and no existing coverage floor was lowered.

Registration commit: `258bd9f6`. It was written on GitHub using a one-shot workflow
with exact preimage blob checks, fixed file names, retained-record assertions and a
non-force branch comparison. Job `106657238828` / run `35700541505` succeeded.
The one-shot workflow was removed in `9657c0d3`; no existing workflow or application
permission was relaxed, and no recurring registration code remains in the product.

## Final Windows verification

At `64beb6be`, the COMPLETE repository orchestrator passed all 26 stages in one final
execution, exit 0, in 322.71 seconds. The new documentation's initial formatting
failure was corrected before this final run; its failed log remains separately saved.

Full suite: 8,564 passed, ZERO failures, 11 inherited skips (8,575 total cases).
MCP: 1,710 passed across 316 files. Work-file tests: 40 passed across 13 files.
These counts overlap. This continuation did not add new behavioral test cases; the
previous coverage-inventory failure is now passing rather than being excluded.

The complete run includes all three type projects, format/lint, error handling,
mock boundaries, architecture, maintainability, duplication/reexports, generated/CSS/
script checks, unused code/exports, full V8 tests and exact coverage, Windows build,
artwork parity, image protocol and renderer/preload bundle checks. The existing
process-local eight-worker option was used; default concurrency/timeouts are unchanged.
All 4,369 tracked source/test/script hashes matched after the full test run.

## Actual Electron verification at the same source

The isolated scenario was started only after that exact full check and its build
completed successfully. Source: `64beb6be`; actual child exit 0. All FOURTEEN required
completion markers were present, and isolated listener 63961 was confirmed closed.
This uses the final built code, not a prior native result substituted for this run.

The work-file flow exports editable trial content, sends actual owned bytes,
reviews and imports into a new work, then separately reviews append into an existing
work. Append uses native image validation, library storage/transaction and OS-encrypted
receipt storage. The upload is disposed, MCP clients are reconstructed, identical
requests replay without duplicate chapters, and receipt disposal preserves both old
and newly imported content. Original chapter bytes and destination guide presence /
bytes remain unchanged. The source package is preserved.

The same run also completed selected/grouped import, persistent source history,
name/order organization, page-order memory reconciliation, page/chapter/work deletion
and recovery, chapter movement and exact-2,000-entry work restoration.
Required markers include `PASS native work-file append -> existing chapters and context preserved`
and `PASS MCP native smoke finished`.

Native storage, image validation and OS encryption are real. Browser/picker/editor
responses and expensive-model boundaries use isolated fixtures. No live user-app
restart, real manuscripts, live models, public-site acceptance or actual chat
attachment / `망번테스트` acceptance was performed. No renderer layout was changed;
no new screen-capture claim is made. Full maximum-byte and every-codec benchmarks
remain outside this verification.

## Preserved feature boundaries

Existing-work append adds selected complete chapters at the end. It does not replace
existing chapters or merge the package guide. Destination context remains authoritative;
missing or conflicting incoming character/glossary references need explicit mapping.
Source/selection/destination snapshots, cancellation, expiry, authorization and encrypted
receipt checks remain active. New-work commands and historical receipt replay stay
compatible. A fresh upload of identical bytes is an explicit additional copy, not
global working-file deduplication.

The live upload is necessary until work-file import settles. Native v1 does not
carry all source memory, local masks or editing history. Existing destination files
are preserved, but absent source data is not manufactured. Package bounds remain ten
chapters/fifty pages/2,000 file entries/256 MiB expanded; input transport remains
128 MiB per file and thirty-minute session lifetime. Destination membership after
append is bounded at 2,000 chapters. Seven-day receipt expiry/disposal never deletes
imported chapters. The detailed command contract remains in the append checkpoint.

## Resume point

Bundle 10 registration/integration is complete. Do not repeat completed file/web
import, discovery/grouped publication/source-history, naming/order, movement,
delete/recovery, incoming-byte input or native new/append work-file integration.

NEXT: bundle 11, additional export/exchange formats and attachment/delivery
diagnostics, reusing existing exporters and retained-output delivery. Bundles 12
and 13 follow in order. No bundle-11 implementation was started in this continuation.
Live tests remain deferred until all requested implementation bundles are complete.
No user app, real library, authentication, model assets or Tailscale settings were
changed or restarted. No master merge, release or additional MCP branch was created.

Evidence prefix: `.tmp/mcp-append-integration-verified-` for source/hashes,
check/result/timings, Vitest/coverage/summary and native log/result. The initial
formatting failure is `mcp-append-integration-initial-format-failed.log`.
Final handoff must recheck all tracked hashes, document-only post-verification
changes, clean worktree and local/remote branch equality.
