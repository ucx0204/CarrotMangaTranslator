# MCP source-size observation coverage — 2026-09-18

Three new source-size observation modules are registered from measured Windows
Vitest/coverage-v8 4.1.9 results at code revision `7a16c436`.
The existing 1,555 coverage records, provenance and deletion policies are unchanged.
No global threshold, coverage gate or source inventory rule was modified.

Measurement: `.tmp/mcp-source-size-new-coverage/coverage-summary.json`.
The scoped measurement ran 37 tests across five files and exited 0. Only the three
new source modules were included in this initial measurement; this is not a full
repository coverage result. The existing configured thresholds remained enabled.

Manifest before additions SHA-256:
`c8fd01a80eaa01fcb79e108fc2d83d4ac4cffee063dbd931a0bde9ed10c56c5d`
Measurement SHA-256:
`8632804273f023d6062cd1043475da23c446278cccd47e6dbf348a353977a59e`

Covered/total counts: lines, statements, functions, branches.

```text
mcpSourceSizeService.ts 53/54, 58/59, 10/10, 36/37
mcpSourceSizeAdapter.ts 13/17, 13/17, 4/7, 4/4
mcpSourceSize.ts         3/3, 3/3, 0/0, 0/0
```

The native executor composition is covered separately by the real Electron harness.
It uses actual library, page ownership, original PNG and the canonical raster
estimator. Native evidence is not presented as 100% Vitest adapter coverage.
Inventory after additions: 753 existing, 805 introduced, 10 deleted files.
Latest complete-check results belong in `mcp-typography-checkpoint-20260918.md`.
