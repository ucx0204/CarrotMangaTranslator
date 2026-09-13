# MCP first-page coverage inventory evidence

Continue only on `feat/mcp-app-bridge` / draft PR #96. This checkpoint changes neither application behavior nor the coverage checker. It completes the missing touched-file inventory for the already implemented first-page tools.

## Measurement source

- Windows `Check` run: `34733472515`, job `103660524853`, source head `421922d56f3d6cb00936cb90753442082a94b407` (PR merge checkout).
- Artifact: `check-Windows-34733472515-1`, ID `10309718485`.
- Downloaded ZIP SHA-256: `ac050bf572526a9b7aabc782bb2c8c19a2848d4de747617230220985c21ff46b`.
- Its `coverage/coverage-summary.json` SHA-256: `f0877b1d181d6eee3c0dc8cd4ef2fb4fc6b1a13ce34b06e4121361bec99e39ca`.
- The run executed 6826 passing tests, one failing coverage-inventory test, and 11 skipped tests. The measured report is not presented as a passing full check.

## Additive inventory repair

The first failing assertion identified three newly touched existing sources: `libraryPageBlockMutations.ts`, `libraryTransaction.ts`, and `shareTypes.ts`. The next inventory comparison also required 65 introduced MCP modules/contracts. Their exact lines/statements/functions/branches records are added from the report above, omitting only the summary's `skipped` field.

Existing floor entries, historical provenance, deleted-file records and the checker remain unchanged. No old percentage or fraction is reduced. This evidence is an appendix for the 68 newly tracked rows, not a claim that they came from the older historical baseline artifacts. No measurement is inferred from a mock or from an unexecuted native model.

The branch scope captured by workbench run `34734316555` is exactly 715 existing and 651 introduced coverage-eligible files. The PR merge also includes master changes and is checked independently. Entries with zero executed Vitest statements retain their observed values; native Electron composition/renderer checks are separate evidence, not fabricated V8 coverage.

The expected manifest blob after applying the checkpoint is `2dbc78e8abb70f92dc72b47165d17f7be03134f0`. The compact Git binary delta is transport only: the resulting tracked file remains ordinary formatted JSON. The patch was applied to a separate local Git index and its destination blob verified before submission.

## Bridge regression repair

`tests/mcpPreloadBridge.test.ts` exercises the actual preload and domain gateway: valid editor probes/page-change notifications, invalid payload refusal, listener removal, validated dirty-editor reports, and inert test-only defaults. It mocks no application module. These tests restore the existing preload/gateway coverage floors instead of lowering them.

Local focused bridge coverage: 24 tests pass; the single all-IPC registration test is excluded only in that local command because the supplied offline dependency kit omits the Linux ONNX binding. No repository test is disabled. Windows CI executes it normally. Local preload coverage is 96.42% lines / 96.55% statements / 95.23% functions / 100% branches; gateway function coverage is 100%.

The first-page Windows MCP checkpoint at `421922d5`, run `34733470908`, already passed before this repair. Final full-check results for the new source must be read from Actions and recorded in PR #96; do not substitute that older focused success for a new full-check result.

## Pinned upstream reconciliation

Upstream `f06499b0c73923dbbcd9a3e14922e8eacb541142` and the MCP branch changed only disjoint coverage rows. The sole merge conflict was resolved by validating that every shared metric is identical, then retaining both complete inventories. The upstream introduced-artifact SHA-256 `cde57ff3d4ae28e8cbae3d9deeca3802d1bbf078f1db4267f50be3ab50867927` remains the historical provenance; the 68 MCP rows retain the separate Windows evidence above. No existing metric was reduced. This merge updates only `feat/mcp-app-bridge`, never master.
