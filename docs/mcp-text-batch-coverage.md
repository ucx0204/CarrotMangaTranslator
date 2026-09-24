# Chapter text batch coverage evidence

Measured on the connected Windows development PC with repository Vitest/V8.
Full suite: 7,469 passed, zero failed, 11 existing skipped (7,480 total).
The seven new production modules are added to introducedFloors; every previous
floor and the original provenance are preserved. Exact added-file inventory is
784 rather than 777. No test or check is disabled.

| New module                             | Lines | Statements | Functions | Branches |
| -------------------------------------- | ----: | ---------: | --------: | -------: |
| shared/mcpTranslationBatch             |   100 |        100 |       100 |      100 |
| application/mcpChapterTextSearch       |  97.4 |      94.25 |       100 |    93.47 |
| application/mcpTranslationBatchPolicy  |    95 |      95.45 |       100 |    94.73 |
| application/mcpTranslationBatchRunner  |   100 |        100 |       100 |      100 |
| application/mcpTranslationBatchService | 97.43 |      95.41 |       100 |    92.22 |
| mcp/mcpTranslationBatchAdapter         |   100 |        100 |       100 |      100 |
| mcp/mcpTranslationBatchTools           |   100 |        100 |       100 |      100 |

The extended existing page editor measured 100/100/100/96.87; its older floor
was not lowered or replaced. The actual native-commit generated-lettering guard
is covered by a regression, not a mocked application service.

Local raw summary: `.tmp/mcp-text-batch-20260917/coverage-final.json`.
SHA-256: `02c24e0970dddb26c315169ea5203333189a97134317d5f8f879f1602fcc2748`.
Raw data and full logs remain local; this note records the supplemental evidence
without pretending the historical baseline was regenerated.
