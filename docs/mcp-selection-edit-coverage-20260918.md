# Selection application coverage - 2026-09-18

Implementation baseline: `06b1a73c`. Measured code: `df0ed53c`.
Source: `coverage/coverage-summary.json` from the complete Windows Vitest/V8 suite.
The measurement run had 7,771 passing tests, one inventory-registration failure,
and 11 existing skips. The inventory failure was the six new modules missing from
the unchanged manifest; their actual measurements below were then registered.
This measurement is not by itself a claim that the final full check passed.
Final verification belongs to the connected checkpoint.

Source summary SHA-256:
`f08fd81404a5588269dda139c5f946147343b663a0807b26ffb42d42fa6e1333`
Inherited manifest SHA-256:
`92a409b3e66b0551afe4dec6cd45bfd611042bb8db9d9638d06b3ca1ba12a091`

| New module | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| `src/shared/mcpSelectionEditing.ts` | 9/9 | 9/9 | 0/0 | 0/0 |
| `src/main/application/mcpSelectionEditProjection.ts` | 69/79 | 73/84 | 13/13 | 69/83 |
| `src/main/application/mcpSelectionEditPolicy.ts` | 75/85 | 84/95 | 31/31 | 64/75 |
| `src/main/application/mcpSelectionEditSnapshots.ts` | 61/64 | 70/73 | 16/16 | 73/78 |
| `src/main/mcp/mcpSelectionEditAdapter.ts` | 33/35 | 38/40 | 11/11 | 20/22 |
| `src/main/mcp/mcpSelectionEditSession.ts` | 20/20 | 20/20 | 10/10 | 0/0 |
| Total | 267/292 | 294/321 | 81/81 | 226/258 |

These are exact new-module counts, not whole-repository coverage percentages.
The zero-denominator schema counters follow the existing coverage metric policy.
All 1,595 inherited records (753 baseline plus 842 introduced), provenance and ten
deletions are byte-value equivalent to the baseline JSON. Only the six measured
introduced entries were added, making 848 introduced rows and 1,601 records total.
The inventory regression expectation moves from 842 to 848; thresholds do not move.
The production floor checker passed against the complete measurement after registration.
Full evidence including exact ratios: `.tmp/mcp-selection-edit-coverage-evidence.json`.

An earlier MCP-only coverage run failed global thresholds because it intentionally
did not execute the rest of the application. It is not used as a global pass;
coverage configuration, thresholds and inherited floors were never disabled or
lowered. That run also caught a typo in the new OAuth test fixture (allowEdits),
which was corrected without changing production permissions.

The tests exercise native saved-page/context reads, source hashing, page handoff,
atomic persistence, exact undo/redo, original-pixel discovery conversion, canonical
block creation and order, OAuth/HTTP and structured public outputs. External model
transport and native raster boundaries are substituted as in the existing fixture.
No live model quality, user artwork, real client, attachment or download acceptance
is claimed. Live acceptance remains deferred until the roadmap is implemented.
