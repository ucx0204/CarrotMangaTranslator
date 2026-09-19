# External image coverage evidence - 2026-09-19

Baseline: `a59eab89`. Initial measured production/test code: `cc8f93fb`.
The first complete Windows Vitest/V8 run passed 7,821 cases with one new-module
inventory-registration failure and 11 existing skips. The failing test was
`production cleanup coverage floor gate tracks every coverage-eligible source
touched since cleanup start`; its difference listed the 13 new production modules.
No image operation or previous regression failed in that run.

All 1,610 inherited coverage records, provenance and ten deletions were compared
with the baseline and preserved exactly. Only the 13 actually measured new modules
were added: 753 original plus 870 introduced entries, 1,623 total. The inventory
count was updated to match these actual paths. No global coverage threshold or
existing module floor was reduced. The exact coverage-floor command and the
27-test inventory suite passed after registration.

Initial coverage-summary SHA-256:
`6639f7a09eb6bcfb15017c03c990235d1b2c0b79ce7d4e41c09f240f3a8a4768`.
Inherited manifest SHA-256:
`feb66ddffc69e0eaefc4152d6f04d3a5c1c68c5921d90951d78fdfffad566d49`.
The per-module metrics and comparison record are in
`.tmp/mcp-external-coverage-evidence.json` in the existing worktree.
First report/log: `.tmp/mcp-external-full-vitest.json` and
`.tmp/mcp-external-full-vitest.log`. Do not confuse these with the final rerun.

The focused upload/external-layer/native-image/output suite passed 31 tests across
six files. Store-limit/cleanup refinement retained the ten existing upload/layer
guard cases and passed its own lint check. The attempted additional dedicated
chunk-limit/reservation-failure test write was refused and was not applied; do not
claim a new limit-exhaustion regression was executed.

## Exact public-authority declarations

Global runtime-import and direct-consumer ceilings remain 12 and 25. Exact measured
exceptions were added only to existing public authorities/composition roots:

| Authority                 | Count              | Reason                                                                  |
| ------------------------- | ------------------ | ----------------------------------------------------------------------- |
| shared/blockFingerprint   | 47 consumers       | Four direct upload/candidate/snapshot consumers reuse canonical hashing |
| application/mcpEditPolicy | 96 consumers       | Ten new external-input boundaries reuse typed errors                    |
| main/library              | 58 consumers       | Native upload reservation and lettering persistence composition         |
| mcpOutputSchemas          | 19 runtime imports | Two strict contract families registered directly                        |
| mcpPageOperationSession   | 26 runtime imports | One external-image session lifecycle connection                         |

The architecture budget and unused-export checks passed after exact declaration
and removal of two unused exports. Existing image-persistence implementation is
unchanged. Remaining function complexity/length lint and the HTTP fixture type
error are NOT resolved by these declarations. No full 26-stage pass is claimed.

## Test interpretation

Actual PNG bytes, mask application, protected/outside pixels, native block saving,
page/context ownership, exact recovery and OAuth/HTTP run in isolated fixtures.
Electron image I/O is substituted at its external boundary; no new live native
smoke, user artwork, model execution or ChatGPT/Tailscale acceptance is claimed.
Final full-suite result, code SHA and exact next work belong in the checkpoint.
