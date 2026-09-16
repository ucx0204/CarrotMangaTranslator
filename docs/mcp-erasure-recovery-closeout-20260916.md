# Selected erasure recovery: implementation and verification

## Current scope

The three recovery tools are implemented and registered in the MCP page-operation composition on `feat/mcp-app-bridge`. This supersedes the incomplete attempt at `7372214c`; that historical record is not the current feature inventory. [User instructions](mcp-selected-erasure-recovery.md).

- `carrot_get_erasure_recovery`: metadata-only inspection of an owned completed single-block erasure.
- `carrot_undo_erasure`: explicit undo with current revision and action request ID.
- `carrot_redo_erasure`: explicit redo with current revision and a different action request ID.

Native `InpaintingRevisionStore`, artifact retention, page handoff/ownership and the atomic library transaction remain the authorities. Replay acquires no OCR, translation or inpainting model and does not return files/images/URLs. Exact retries are cached and cannot toggle the page again after the opposite action. Later manual edits are refused as conflicts, not merged or overwritten. MCP/app restart or native history release can make recovery unavailable. This is not durable undo or multi-page recovery.

## Resumed from the actual branch

The resumed branch already contained implementation and fixture commits through `8ead7e0622788491faf4eadd420cc484911fa6dd`. No draft patch was blindly reapplied. Production code and native scripts remained unchanged throughout the final test/inventory/documentation closeout.

Fresh additions were shutdown/handoff, page drift, cached receipt revocation, defensive copies, association bounds and receipt-capacity regressions. The three new output schemas were added to the expected inventory. A literal-type issue in the new test fixture was corrected without changing production behavior.

## Fresh Windows verification

Verified source/test checkpoint: `4d32813bba327ee7cfe69a72afd05a0f3f8d5f56`.

`npm run check` completed with exit code 0: **all 26 gates passed**, **7,224 tests passed, 0 failed, 11 existing skips**, 860 test files in the JSON report. The run includes the three typechecks, lint, error-handling, mock-boundary and architecture checks, existing coverage floors, Windows build, real page-artwork pixel parity, image protocol smoke, and renderer/preload bundle checks.

Evidence in the Review worktree:

- `.tmp/mcp-recovery-closeout-20260916/final-check.log`
- `.tmp/check-results/vitest.json`
- `.tmp/check-timings.json`
- `.tmp/mcp-recovery-closeout-20260916/focused.log`: 33 recovery/history/HTTP/erasure tests.
- `.tmp/mcp-recovery-closeout-20260916/lifecycle.log`: 13 lifecycle/output-contract tests.

The current OAuth HTTP suite executes the real recovery session, page lease and library transactions for lookup -> undo -> redo. It checks other-owner refusal, read-only write refusal, invalid input, unchanged unauthorized data, idempotent retries, structured/text agreement and absence of private history IDs, local paths or attachments. Native-history tests include missing/empty/directory artifacts and revocation at the actual commit point with no compensating write.

## Coverage registration

Five new source modules were missing from the introduced-file inventory; their initial Windows measured coverage was added. Existing per-file floors, provenance and deleted-file records were preserved exactly. The introduced-file count is 750, existing-file count 753 and deleted-file count 10.

Initial measurement: `.tmp/mcp-recovery-closeout-20260916/coverage-initial.json`.
SHA-256: `eeb2fb127272acb50dc2704547eb5d84be37b14859f9bedd3fc1c4635fcae913`.
The subsequent full check passed the unchanged coverage comparison rules.

## Historical native acceptance versus attempted rerun

The pre-existing `.tmp/recovery-native.log`, timestamped 2026-09-16 10:09 UTC, was read and contains the full successful native sequence, including:

```text
PASS native selected erasure -> availability -> undo -> redo; exact pixels, unchanged blocks, no extra model, retry and manual-edit protection
PASS native hostile HTTP matrix: 182 checks across 26 production tools; Unicode roundtrip and original data preserved
PASS MCP native smoke finished
```

The native fixture compares pre-erasure bytes, restored bytes and redone bytes, preserves original/blocks/order and asserts only one engine acquisition (the original erasure). Heavy inference uses a deterministic fixture, not an installed GPU model.

That is a **previous run**, not a fresh execution in this closeout. A requested standalone Electron rerun on a separate port was blocked before process launch by the tool's security check; it was not retried through another command, port or tool. No new native run or live recovery invocation is claimed. Relative to integration commit `4cb79615`, the production changes before the fresh full check were helper extraction in `mcpErasureAdapter` and `mcpPageOperationSession`; the recovery service, history policy and native recovery fixture are unchanged. The existing native log is retained as historical evidence, not proof that a blocked rerun happened.

## Live app and activation

The existing `망번테스트2` capabilities request succeeded. Its running server did not list the three recovery tools, and this conversation still had the old connector definitions. The user's normal app was not restarted and its authorization was not modified. Save any edits and normally restart the same Review app, then refresh the connector tool definitions before testing a newly completed selected-block erasure. Old erasures from before this MCP session cannot be assumed recoverable.

No user artwork, library records, model settings or authentication files were changed. No master update, release, extra branch, general batch engine or permanent recovery store was introduced.
