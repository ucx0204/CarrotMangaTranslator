# Historical bundle 2 slice coverage - 2026-09-18

Current completion and measured new resource-module coverage are recorded in
`mcp-lettering-connected-checkpoint-20260918.md`. This earlier evidence retains
the original eleven-module measurement; its pending findings are historical and
were resolved before all 26 gates passed at `55199412`.

This measurement covers the independent layout/advanced-style slice, not complete
saved-resource integration or real-model/client acceptance.

The scoped Vitest/V8 run exited 0 with 880 MCP tests in 118 files. Eleven new
source modules were measured from `.tmp/mcp-lettering-coverage/coverage-summary.json`:
lettering policy/projection, source binding, native layout, page preparation,
model lifetime, batch adapter, prepare tool, session and two transport contracts.

New-module totals only (not whole-repository coverage):

| Metric     | Covered | Total |
| ---------- | ------- | ----- |
| Lines      | 320     | 343   |
| Statements | 347     | 375   |
| Functions  | 104     | 106   |
| Branches   | 196     | 228   |

All 1,572 inherited floor records, provenance and deletion entries were retained.
Only 11 measured new rows were added. The introduced-file inventory changes from
819 to 830; the original 753 baseline rows are unchanged. No threshold, test or
safety check was disabled to establish this measurement.

Inherited manifest SHA-256:
`db16f1a882daf56b6f76d6c335ffb8f832f820e2463f3eac595188a16c4155a6`

Measurement SHA-256:
`a9c9f8c8aaae7d55faeb4f3c1472f67954edfa226ebb83953610940a0b951ebb`

The tests use temporary libraries, actual page/context leases and transactions,
real source-file hashing, native style appliers/natural wrapping, and real local
OAuth/HTTP/result-schema paths. Koharu inference and its external cleanup boundary
are substituted. They do not read or change user artwork, credentials or model
assets, and they are not ChatGPT/Tailscale or real-model quality tests.

The two job-journal complexity findings, architecture consumer declarations,
saved-resource lookup and stronger all-page forward checks remain recorded in
`mcp-lettering-checkpoint-20260918.md`. Scoped coverage success is NOT an all-gates
pass. The final full-suite/build outcome is recorded separately in that checkpoint.
