# Bundle 7 coverage provenance - 2026-09-19

Initial complete Vitest/V8 measurement: `6634f57f9febebfbeea85fb4b6033d1d44da74b6`.
Report SHA-256: `20fad8fc6a9c5f2f209867e65d8bf21d8a3de36bf6abec2cef092bb8aaf819e8`.

All 1,643 inherited rows, provenance fields and ten deletion records are unchanged.
Nineteen new modules receive their actual first measured floors. One existing source
(`libraryTransactionFiles.ts`) enters the tracked change inventory for the first time.
Its initial tracked floor is 100% in every metric, the maximum possible ratio; this
is a current measurement, not a claimed historical pre-change coverage artifact.
The old external baseline artifacts are not available in this worktree and are not
fabricated or replaced. No existing threshold is reduced.

| Module                                             | Lines           | Statements       | Functions      | Branches       |
| -------------------------------------------------- | --------------- | ---------------- | -------------- | -------------- |
| `src/main/libraryStore/libraryTransactionFiles.ts` | 14/14 (100%)    | 14/14 (100%)     | 5/5 (100%)     | 0/0 (100%)     |
| `src/main/library/libraryRecoveryFacade.ts`        | 8/8 (100%)      | 10/10 (100%)     | 6/6 (100%)     | 0/0 (100%)     |
| `src/main/libraryStore/libraryChapterHistory.ts`   | 3/3 (100%)      | 3/3 (100%)       | 2/2 (100%)     | 0/0 (100%)     |
| `src/main/libraryStore/libraryPageRecovery.ts`     | 58/61 (95.08%)  | 60/66 (90.9%)    | 11/11 (100%)   | 29/38 (76.31%) |
| `src/main/mcp/mcpArtifactStream.ts`                | 20/20 (100%)    | 20/20 (100%)     | 3/3 (100%)     | 6/6 (100%)     |
| `src/main/mcp/mcpArtifactTypes.ts`                 | 0/0 (100%)      | 0/0 (100%)       | 0/0 (100%)     | 0/0 (100%)     |
| `src/main/mcp/mcpAuthorizationScope.ts`            | 15/15 (100%)    | 15/15 (100%)     | 3/3 (100%)     | 2/2 (100%)     |
| `src/main/mcp/mcpRecoveryApplication.ts`           | 93/102 (91.17%) | 103/116 (88.79%) | 30/31 (96.77%) | 45/58 (77.58%) |
| `src/main/mcp/mcpRecoveryCapture.ts`               | 61/65 (93.84%)  | 63/69 (91.3%)    | 22/22 (100%)   | 24/32 (75%)    |
| `src/main/mcp/mcpRecoveryInspection.ts`            | 24/28 (85.71%)  | 25/29 (86.2%)    | 5/5 (100%)     | 13/18 (72.22%) |
| `src/main/mcp/mcpRetainedContext.ts`               | 2/2 (100%)      | 2/2 (100%)       | 1/1 (100%)     | 0/0 (100%)     |
| `src/main/mcp/mcpRetainedOutputs.ts`               | 65/72 (90.27%)  | 68/75 (90.66%)   | 21/21 (100%)   | 30/37 (81.08%) |
| `src/main/mcp/mcpRetentionCatalog.ts`              | 53/53 (100%)    | 54/54 (100%)     | 22/22 (100%)   | 29/32 (90.62%) |
| `src/main/mcp/mcpRetentionEvidence.ts`             | 45/49 (91.83%)  | 46/50 (92%)      | 10/10 (100%)   | 34/38 (89.47%) |
| `src/main/mcp/mcpRetentionRecords.ts`              | 18/18 (100%)    | 19/19 (100%)     | 2/2 (100%)     | 0/0 (100%)     |
| `src/main/mcp/mcpRetentionSession.ts`              | 18/18 (100%)    | 19/19 (100%)     | 10/10 (100%)   | 0/0 (100%)     |
| `src/main/mcp/mcpRetentionStorage.ts`              | 65/73 (89.04%)  | 72/81 (88.88%)   | 19/19 (100%)   | 41/50 (82%)    |
| `src/main/mcp/mcpRetentionTools.ts`                | 16/16 (100%)    | 16/16 (100%)     | 8/8 (100%)     | 6/8 (75%)      |
| `src/shared/mcpRetention.ts`                       | 12/12 (100%)    | 12/12 (100%)     | 0/0 (100%)     | 0/0 (100%)     |
| `src/shared/pageRecoverySnapshot.ts`               | 7/7 (100%)      | 8/8 (100%)       | 4/4 (100%)     | 0/0 (100%)     |

The preceding table preserves the initial measured registration. It is not a reset
of inherited thresholds. Final verification and cleanup-module provenance follow.

## Resumed cleanup registration and final verification

Initial cleanup measurement source: `c68b28747b8a23826ed47351af8ebd3c6c0e4e79`.
Report SHA-256: `a3d581f56a75c28f20c12426182fef83a04af8686b2541dad586808ea3cb4af4`.

The resumed work adds only this measured module, preserving all 1,663 previous
records, their provenance fields and deletion records.

| Module                                             | Lines          | Statements     | Functions  | Branches       |
| -------------------------------------------------- | -------------- | -------------- | ---------- | -------------- |
| `src/main/libraryStore/recoveredImageArtifacts.ts` | 36/38 (94.73%) | 37/39 (94.87%) | 8/8 (100%) | 26/31 (83.87%) |

Across bundle 7, all 1,643 inherited records remain unchanged. Twenty new modules
and one previously existing file newly tracked yield 1,664 records (754 existing +
910 introduced); ten recorded deletions are unchanged.

Final verification source: `09a99b16cddaf380e2f2f3c07466da9b8a0d7caa`. All 26 gates
passed: 7,893 tests passed, zero failed, 11 existing skips; 1,077 MCP tests across
159 files. Artifact error-path tests restore the original PNG/ZIP floors without
reducing them. The native recovery code retains whole-chapter final-reference
validation without a redundant deep-copy lookup.

These final measurements are evidence, not replacements for existing floors:

| Module                                             | Lines            | Statements       | Functions    | Branches       |
| -------------------------------------------------- | ---------------- | ---------------- | ------------ | -------------- |
| `src/main/libraryStore/libraryPageRecovery.ts`     | 61/64 (95.31%)   | 64/70 (91.42%)   | 12/12 (100%) | 29/38 (76.31%) |
| `src/main/libraryStore/recoveredImageArtifacts.ts` | 38/38 (100%)     | 39/39 (100%)     | 8/8 (100%)   | 29/31 (93.54%) |
| `src/main/libraryStore/inpaintedArtifacts.ts`      | 42/42 (100%)     | 45/45 (100%)     | 13/13 (100%) | 35/36 (97.22%) |
| `src/main/mcp/mcpArtifactStore.ts`                 | 156/157 (99.36%) | 172/176 (97.72%) | 31/31 (100%) | 71/75 (94.66%) |
| `src/main/mcp/mcpArtifactZip.ts`                   | 21/21 (100%)     | 23/23 (100%)     | 6/6 (100%)   | 7/7 (100%)     |

Final coverage SHA-256: `0060a41207eaf9a2f1b925cfbfe887ee416c562c431d60eef1565682999eeb71`.
Evidence: `.tmp/mcp-retention-cleanup-coverage-evidence.json`,
`.tmp/mcp-retention-final-evidence.json` and
`.tmp/mcp-retention-final-coverage-summary.json`.
