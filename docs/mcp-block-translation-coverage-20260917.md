# Block translation coverage registration — 2026-09-17

Measured on the user's Windows PC at source commit `29f2b11436e3a782a1ca8b00eaed21a87f2450b3` using `npm run test:coverage` (Vitest/V8 4.1.9). The initial run completed with 7,338 passing tests, 11 skipped and one inventory failure: the six new production translation modules were not registered. No application behavior test failed.

The untouched measurement is `.tmp/mcp-translation-final-20260917T050544Z/coverage-summary.json`; its SHA-256 is `2576a4ef618fe9d903392b05f8e6d637071642d98b9f856365a780dbd1d19ec3`. `new-module-measurements.json` in the same directory records the six extracted entries. No existing floor, introduced floor, historical provenance or global threshold was lowered.

| Newly registered module                   | Lines | Statements | Functions | Branches |
| ----------------------------------------- | ----- | ---------- | --------- | -------- |
| application/mcpBlockTranslationService.ts | 35/36 | 37/38      | 7/8       | 29/30    |
| mcp/mcpBlockTranslationAdapter.ts         | 50/52 | 52/54      | 8/9       | 21/25    |
| mcp/mcpBlockTranslationContext.ts         | 15/19 | 15/19      | 1/3       | 9/11     |
| mcp/mcpBlockTranslationOptions.ts         | 23/23 | 25/25      | 5/5       | 31/31    |
| mcp/mcpBlockTranslationSession.ts         | 10/10 | 10/10      | 4/4       | 1/2      |
| shared/mcpBlockTranslation.ts             | 4/4   | 4/4        | 1/1       | 0/0      |

The first five paths are under `src/main`; the schema is under `src/shared`. The exact inventory expectation increases from 756 to 762 introduced files. The complete file-list equality assertion and all exact-ratio regression checks remain enabled. The floor checker compares the existing 753 files, the 762 introduced records and 10 recorded deletions.

Five narrowly scoped architecture exceptions were documented at `b8aef6e0` for direct reuse of page revision, language, library and MCP error contracts and the existing composition root. Default import limits remain unchanged. No forwarding wrappers or duplicate domain logic were introduced to hide dependencies.

This registration is a checkpoint, not a claim that the final full gate has already passed. The subsequent whole-repository and native results are recorded in the final closeout document.
