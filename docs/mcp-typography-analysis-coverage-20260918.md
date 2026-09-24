# Independent typography observation coverage — 2026-09-18

Eight new modules are registered from a successful scoped Windows Vitest/V8
measurement. Existing 1,558 floor records, provenance and deleted-file entries
are unchanged. Global thresholds and exact source-inventory checks remain enabled.
Only the introduced-file assertion changes from 805 to 813.

Measurement: `.tmp/mcp-typography-analysis-coverage/coverage-summary.json`.
The scoped command ran MCP regression tests plus the existing C23 pipeline/apply
and new cleanup-lifecycle tests. It exited 0 with 818 tests in 112 files.
It measures the eight new modules, not full repository coverage or live quality.

Manifest before additions SHA-256:
`5defc7983904ce118d3cf1338fd7bb4b89903d0873184de3a22cc9173b56ab57`
Measurement SHA-256:
`c32ef3d1c1847c982c25d8c9a8dee1bcdd2b565b835628f6cdaf460e208f0210`

Covered/total: lines, statements, functions, branches.

```text
mcpTypographyAnalysisService.ts 56/56, 63/63, 20/20, 30/30
mcpSourceTypographyItem.ts       1/1,   1/1,   1/1,   0/0
mcpTypographyAnalysisAdapter.ts 58/62, 61/66, 16/16, 34/41
mcpTypographyAnalysisSession.ts 15/16, 17/18,   5/5,   4/6
mcpTypographyAnalysisTool.ts    12/12, 13/13,   4/4,   7/7
mcpTypographyFontRuntime.ts     20/24, 22/27,   5/7,  8/10
fontChapterC18Lifecycle.ts     11/11, 13/13,   2/2,   4/4
mcpTypographyAnalysis.ts         9/9,   9/9,   0/0,   0/0
```

The synthetic C23 engine boundary is substituted; real raster math, original
file reads, page handoffs, operation ownership and HTTP/output validation remain.
No real user data, live MCP client, model-download or inference test was run.
Selective style application and undo/redo are not provided by this observation.

Inventory after additions: 753 existing, 813 introduced, 10 deleted files.
The inherited manifest provenance continues to identify its original baseline;
this document and the scoped measurement identify only the eight additions.
The configured floor ratios are not lowered or substituted for old entries.

The latest full-check status must be read from the typography checkpoint. At this
registration point there is still one max-lines-per-function lint finding in
McpTypographyAnalysisService.run (86 versus 80); its attempted small refactor was
not applied because the tool safety checker refused that request. The lint rule
has NOT been disabled or increased. Scoped test success does not mean all gates pass.
