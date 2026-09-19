# Bundle 8 coverage provenance - 2026-09-19

Continuation coverage and final inventory: `mcp-workflow-connected-coverage-20260919.md`.
The original thirteen-module measurement below is retained; five further measured
modules bring bundle eight to eighteen additions and the total inventory to 1,682.
Final full-gate evidence is in `mcp-workflow-connected-checkpoint-20260919.md`.

Initial complete Vitest/V8 measurement: `f7eb4fcec6ea30a37f14dc0825ff1a162233966c`.
Report SHA-256: `2dd80d84dbd9c16fc93aa612657e20add19150d2a2461a281722b648ddcb5646`.

All 1,664 inherited floor records, provenance metadata and deletion records remain
unchanged. Thirteen newly tracked modules receive only their actual measured
counts below. No historical artifact was replaced and no threshold was lowered.
The introduced inventory grows from 910 to 923; 754 existing records are unchanged,
for 1,677 total records. The initial run passed 7,925 tests and failed only the
unregistered-inventory case, with 11 existing skips. Final gate results are recorded
in `mcp-workflow-checkpoint-20260919.md`, not inferred from this first measurement.

| Module                                         | Lines            | Statements       | Functions    | Branches       |
| ---------------------------------------------- | ---------------- | ---------------- | ------------ | -------------- |
| `src/main/application/mcpOperationSnapshot.ts` | 2/2 (100%)       | 3/3 (100%)       | 2/2 (100%)   | 2/2 (100%)     |
| `src/main/application/mcpWorkflowPolicy.ts`    | 30/32 (93.75%)   | 32/34 (94.11%)   | 19/19 (100%) | 40/42 (95.23%) |
| `src/main/application/mcpWorkflowRunner.ts`    | 82/85 (96.47%)   | 86/89 (96.62%)   | 8/8 (100%)   | 36/40 (90%)    |
| `src/main/application/mcpWorkflowService.ts`   | 133/141 (94.32%) | 139/147 (94.55%) | 25/25 (100%) | 65/74 (87.83%) |
| `src/main/mcp/mcpWorkflowCalls.ts`             | 39/44 (88.63%)   | 42/48 (87.5%)    | 9/9 (100%)   | 17/21 (80.95%) |
| `src/main/mcp/mcpWorkflowEvidence.ts`          | 33/38 (86.84%)   | 39/44 (88.63%)   | 10/10 (100%) | 16/21 (76.19%) |
| `src/main/mcp/mcpWorkflowReconciliation.ts`    | 26/29 (89.65%)   | 29/33 (87.87%)   | 6/6 (100%)   | 32/36 (88.88%) |
| `src/main/mcp/mcpWorkflowRepository.ts`        | 47/53 (88.67%)   | 49/55 (89.09%)   | 23/23 (100%) | 24/30 (80%)    |
| `src/main/mcp/mcpWorkflowRuntime.ts`           | 40/44 (90.9%)    | 44/48 (91.66%)   | 10/10 (100%) | 26/34 (76.47%) |
| `src/main/mcp/mcpWorkflowSession.ts`           | 5/5 (100%)       | 5/5 (100%)       | 3/3 (100%)   | 2/2 (100%)     |
| `src/main/mcp/mcpWorkflowTools.ts`             | 27/32 (84.37%)   | 28/35 (80%)      | 12/12 (100%) | 8/14 (57.14%)  |
| `src/main/mcp/mcpWorkflowTranslation.ts`       | 34/38 (89.47%)   | 35/40 (87.5%)    | 6/6 (100%)   | 22/27 (81.48%) |
| `src/shared/mcpWorkflow.ts`                    | 27/27 (100%)     | 28/28 (100%)     | 5/5 (100%)   | 8/8 (100%)     |

The existing page-batch lifecycle floors are protected separately, including
pre-aborted native waits and release refusal while a save remains active. New
workflow runner floors are also retained across later implementation changes.
Repeated execution is not evidence of a deterministic branch test; missing error
or cancellation paths must be exercised directly, not excluded or discounted.

Initial reports remain in `.tmp/mcp-workflow-initial-coverage-summary.json`,
`.tmp/mcp-workflow-initial-vitest.json` and `.tmp/mcp-workflow-coverage-evidence.json`.
