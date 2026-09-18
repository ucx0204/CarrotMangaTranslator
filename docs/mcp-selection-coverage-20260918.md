# Selected analysis coverage - 2026-09-18

Baseline: `623a8838`. This measures only the seven new independent observation
modules, not the unfinished selected-application/reference-editing boundary.
The scoped Windows Vitest/V8 run exited 0: 932 MCP tests in 128 files.

Measured new-module totals: lines 213/218; statements 228/235; functions 64/64;
branches 110/119. Existing full-repository percentages are not inferred from these.

Source measurement: `.tmp/mcp-selection-coverage/coverage-summary.json`.
Measurement SHA-256:
`16a4fc5f739c151359758efcaf76ab5d63eef5947ffc64134c7e0472ebd6ad88`
Inherited manifest SHA-256 before additions:
`f01a1ff566928e63a8cd00d90fbf25d954504c7c9830594239b1bf9d7acc9372`

All 1,588 inherited floor records, provenance and deletion entries were preserved.
Only seven actually measured rows were added; introduced-file inventory moves
from 835 to 842. The 753 original baseline entries and 10 deletions are unchanged.
Evidence and exact per-file ratios: `.tmp/mcp-selection-coverage-evidence.json`.

The source crop/observation extraction reuses the existing single-block behavior;
its original tests remain active and share only the external native PNG fixture.
A new progress-reporting failure regression verifies actual model release and
crop cleanup even when the reporting callback throws.

Native model transport/raster boundaries are substituted. Real source hashing,
crop coordinates, page/context ownership, saved library reads, job persistence,
OAuth/HTTP and output validation are executed. Live model/user/client acceptance
is deferred; final whole-repository verification is recorded in the checkpoint.
