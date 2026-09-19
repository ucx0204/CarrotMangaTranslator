# Bundle 8 continuation coverage provenance - 2026-09-19

First complete connected Vitest/V8 measurement: `a90255e0d86d36d39ecdbe79b11ba9daeb0a2e15`.
Artifact: `.tmp/mcp-workflow-connected-initial-coverage.json`.
SHA-256: `313142d04381139ddcccf547edb83fa9607767334cb4c08cbd0052e1f1ee929f`.

The complete run contained 7,959 passing cases, one missing-inventory registration
failure and 11 existing skips. All behavior tests, including native transaction
crash recovery and actual scoped HTTP handoff, passed. This records the first
measurement, not the final completion claim; later cancellation tests and fixes
require a fresh complete check.

All 1,677 inherited rows (754 original and 923 introduced), provenance fields and
ten deletion records are unchanged. Five previously unregistered source modules
receive their exact first measured ratios below. The inventory is now 1,682 rows.
No inherited floor, provenance hash, deletion record or global threshold changed.
Bundle eight as a whole adds 18 source modules over bundle seven's 1,664 rows.

| Module | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| `src/main/application/mcpWorkflowHandoffService.ts` | 75/78 (96.15%) | 77/80 (96.25%) | 19/19 (100%) | 44/47 (93.61%) |
| `src/main/mcp/mcpWorkflowAuthorization.ts` | 3/7 (42.85%) | 4/8 (50%) | 2/2 (100%) | 3/6 (50%) |
| `src/main/mcp/mcpWorkflowHandoffTools.ts` | 17/18 (94.44%) | 18/20 (90%) | 8/8 (100%) | 4/6 (66.66%) |
| `src/main/runtimeSupport/modelWorkload.ts` | 50/53 (94.33%) | 55/58 (94.82%) | 7/8 (87.5%) | 21/24 (87.5%) |
| `src/shared/mcpWorkflowHandoff.ts` | 6/6 (100%) | 6/6 (100%) | 0/0 (100%) | 0/0 (100%) |

Subsequent tests exercise missing-identity and legacy scope validation, current-child
cancellation during resource creation, stale child cancellation isolation, native
inpainting-pool reuse and physical group disposal. These strengthen coverage; they
do not retroactively change the first-measurement evidence or lower any floor.

The exact source-specific architecture declarations cover one extra canonical hash
consumer, three canonical typed-error consumers and the strict handoff output family
at the existing composition root. There is no duplicate hash/error authority, forwarding
barrel or relaxed global budget. The canonical context snapshot is reused under the
existing native write boundary instead of reacquiring its own read lock.

Final counts, source commit, full-gate results and isolated Electron evidence belong
in the connected workflow checkpoint. Live model/client acceptance remains deferred.
