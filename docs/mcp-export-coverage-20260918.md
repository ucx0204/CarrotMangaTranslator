# MCP export coverage provenance — 2026-09-18

The seven new output modules are added to the existing exact-ratio manifest.
No existing floor, source inventory rule, platform policy or global threshold is lowered.
The coverage gate implementation remains unchanged.

## Measurement

- Code revision: `2005d216d2bc8a9dd0a9662bbae5e5aaf46ac9a5`.
- Platform: Windows; Node `26.7.0`, V8 `14.6.202.34-node.28`.
- Vitest and coverage-v8: `4.1.9`.
- Existing manifest SHA-256: `6ca22cc8e4fcf5450773c3fe7953550c6f8207921b65842dbb4d34d8528c80b7`.
- Full measurement: `coverage/coverage-summary.json`.
- Measurement SHA-256: `a66a84d6378e35cd3efdaaf213e6da1aeee78a2d74ae6a17df8fa4602e91a289`.
- That run had 7,524 passing tests, 11 existing skips and one failing inventory test.
  Coverage was still collected by the existing `reportOnFailure` policy. This is
  initial measurement provenance, not a claim that that run passed the full gate.
- Later tests cover ZIP journal restoration, filesystem inspection/cleanup failures,
  and real HTTP disconnect/read-error behavior. Their purpose includes preserving
  existing 100% journal and transport requirements rather than reducing those floors.

## Initial introduced records

Counts are covered / total, with the exact reported percentage in parentheses.

| Module | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| `application/mcpExportBatchService.ts` | 60/64 (93.75) | 63/67 (94.02) | 15/17 (88.23) | 20/26 (76.92) |
| `application/mcpExportSelection.ts` | 19/19 (100) | 20/20 (100) | 8/8 (100) | 19/19 (100) |
| `application/mcpOperationOutputs.ts` | 16/17 (94.11) | 18/19 (94.73) | 5/5 (100) | 24/25 (96) |
| `mcp/mcpArtifactZip.ts` | 13/13 (100) | 14/14 (100) | 2/2 (100) | 0/0 (100) |
| `mcp/mcpExportBatchAdapter.ts` | 0/8 (0) | 0/9 (0) | 0/7 (0) | 0/0 (100) |
| `mcp/mcpExportBatchTools.ts` | 23/24 (95.83) | 24/28 (85.71) | 9/9 (100) | 7/11 (63.63) |
| `shared/mcpExportBatch.ts` | 12/12 (100) | 12/12 (100) | 0/0 (100) | 0/0 (100) |

The first six paths are relative to `src/main`; the last is relative to `src`.
The adapter has no Vitest executable coverage in this measurement. Its actual
application composition, page handoff and renderer are exercised by
`scripts/mcp-native-export-batch.cjs` through the registered production tools.
Do not describe that native evidence as 100% Vitest coverage.

## Native evidence

`compile:electron` and the isolated Electron smoke harness completed successfully.
`.tmp/mcp-export-github-native.log` records two original-resolution PNGs with zero
pixel differences versus individual export, byte-identical PNG entries in an ordered
ZIP, actual HTTP GET/HEAD, and refusal after enabling the real fixture redaction gate.
Saved fixture chapters and original image bytes remained unchanged. User data was not used.

## Registration method

A minimal additive JSON patch is submitted through the repository's existing
`mcp-submit.yml` workflow using the GitHub plugin. That workflow performs indexed
patch validation, validates allowed paths and refuses a concurrently moved branch;
it does not force-push. Remote Desktop Commander only reads, syncs and tests the result.
The exact added inventory becomes 798; the 753 existing records and 10 deleted-file
records remain unchanged. Final verification status is in the export checkpoint.
