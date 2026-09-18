# Selective typography core coverage - 2026-09-18

Three new modules were measured with the full Windows Vitest/V8 run. Existing
1,566 floor records, their provenance and deletion records are unchanged.
Only three measured introduced rows and the exact inventory assertion (813 to
816 introduced files) are added. Global thresholds remain unchanged.

Measurement archive (exact original bytes):
`.tmp/mcp-typography-apply-first-coverage-summary.json`

Original manifest SHA-256:
`60f3a67afcdccf0b3f50dd7f90f550373b12ccacbb11b5abdd2e6faa69396678`
Measurement SHA-256:
`37614a67b3939a9d31a3ac5720924a9bde13fc83b7feaf32793a7c8d04a35374`

Covered/total: lines, statements, functions, branches.

```text
src/main/application/mcpTypographyBatchPolicy.ts   68/72, 76/80, 34/34, 58/63
src/main/mcp/mcpTypographyApplyProjection.ts       23/23, 26/26,   5/5, 32/36
src/shared/mcpTypographyBatch.ts                    9/9,   9/9,   2/2,   2/2
```

The initial full run passed 7,648 tests with one failure: the exact introduced
source inventory still expected 813 records while the three new files made 816.
That assertion and registration were updated; the coverage inventory tests and
production floor checker then passed without changing existing floor ratios.

This measurement covers internal selection/projection, exact restoration and the
shared batch/page mutation paths. It is not production file freshness validation,
remote application-tool registration, actual C23 inference or live client testing.
The temporary fixture's external validation callback must not be copied into the
production adapter. Final live acceptance remains deferred by user instruction.

Current inventory: 753 original floor files, 816 introduced files, 10 unchanged
deletions. The inherited provenance still identifies its original baseline; this
note identifies only the three additions. Exact original floor records were
compared before writing the new manifest.

Known independent static failures remain documented in
`mcp-typography-selective-checkpoint-20260918.md`: one test non-null assertion and
two canonical module consumer ceilings. Coverage success does not imply those
checks pass. No attempted fix rejected by the tool checker was applied elsewhere.
