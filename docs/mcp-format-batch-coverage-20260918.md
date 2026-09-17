# Format batch coverage registration

The Windows Vitest V8 summary at
`.tmp/mcp-format-batch-20260918/measured-coverage-summary.json`
has SHA-256 `763103f9b9698dea1424dfee778131551f073e4cacb1d2bdb8b377242221e4ab`.

Seven newly introduced production files use their first measured metrics. The
renamed `mcpPageBatchService.ts` retains all four original floors from
`mcpTranslationBatchService.ts` verbatim. The shared lifecycle now reports
115/118 lines, 126/132 statements, 34/34 functions, 83/90 branches, meeting the
retained historical floors. Existing floor values and historical provenance are
unchanged. Scope remains 753 pre-existing files, 791 introduced and 10 deleted.

This measurement run passed 7495 tests but failed two inventory assertions: the
old 47-tool count and the renamed coverage source entry. Both inventories were
updated to reflect the six actual new tools and exact source paths; no test,
coverage floor or runtime safeguard was disabled. Final full-gate results are
recorded in the format batch closeout after a fresh run.

New files: `src/main/application/mcpFormatBatchPolicy.ts`, `src/main/application/mcpPageBatchPolicy.ts`, `src/main/application/mcpPageBatchTypes.ts`, `src/main/mcp/mcpBatchTool.ts`, `src/main/mcp/mcpFormatBatchTools.ts`, `src/shared/mcpFormatBatch.ts`, `src/shared/mcpFormatEditing.ts`.
