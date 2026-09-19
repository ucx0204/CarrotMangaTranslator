# External image coverage evidence - 2026-09-19

Final implementation/verification status is recorded separately in
`mcp-external-image-checkpoint-20260919.md`. Measurements below preserve the actual
initial floors rather than replacing them with later passing percentages.

## Original upload and lettering measurement

Baseline: `a59eab89`. Initial measured production/test code: `cc8f93fb`.
The first complete Windows Vitest/V8 run passed 7,821 cases with one new-module
inventory-registration failure and 11 existing skips. The failing inventory test
listed exactly the 13 new production modules. No image operation failed in that run.

All 1,610 inherited coverage records, provenance and ten deletions were compared
with the baseline and preserved exactly. Thirteen measured modules were added:
753 original plus 870 introduced entries, 1,623 total. The inventory count was
updated to match the actual paths. No threshold or existing floor was reduced.
The exact coverage-floor command and 27-test inventory suite passed at that point.

Initial coverage-summary SHA-256:
`6639f7a09eb6bcfb15017c03c990235d1b2c0b79ce7d4e41c09f240f3a8a4768`.
Inherited manifest SHA-256:
`feb66ddffc69e0eaefc4152d6f04d3a5c1c68c5921d90951d78fdfffad566d49`.
Per-module record: `.tmp/mcp-external-coverage-evidence.json`.
Initial report/log: `.tmp/mcp-external-full-vitest.json` and
`.tmp/mcp-external-full-vitest.log`. These are not the final run.

The original focused suite passed 31 tests across six files. A dedicated
chunk-limit/reservation-failure test write was refused at that point; no exhaustive
limit-exhaustion result was inferred. Later tests described below cover additional
malformed PNG, native decoder and filesystem cleanup boundaries, not every limit.
The previous complexity/length and HTTP fixture findings were resolved during the
continuation by decomposition, preserving caught causes and a real fixture error sink.

## Connected background measurement

Measured source: `5b217715`. The resumed full suite passed 7,828 tests with one
inventory-registration failure for the two new background modules and 11 existing
skips. That measurement supplied these new floors:

| Module | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| mcpExternalImageArtifact.ts | 23/27 | 23/28 | 2/2 | 6/11 |
| mcpExternalImageBackground.ts | 32/35 | 33/36 | 13/13 | 10/13 |

Coverage-summary SHA-256:
`a2e7340b2b6e41b43a156b98441c5c3ad5d282af352a596704d2c0c3991ce5d9`.
Pre-addition manifest SHA-256:
`88497996d1bc7f73cb1e953789848fc2c83e35c467334611ddf9d13f814fbc14`.
Exact comparison/metrics: `.tmp/mcp-external-background-coverage-evidence.json`.
All 1,623 preceding rows, provenance and deletions were retained. The manifest now
has 753 original plus 872 introduced entries, 1,625 total. This is 15 newly measured
modules relative to the completed bundle-four baseline.

The first post-registration floor check detected insufficient coverage in the
refactored pixel composer, session cleanup and PNG framing code. No floors were
lowered. New tests execute native decoder empty/size disagreement, failed staging
cleanup with saved-image preservation, and truncated/animated/duplicate-header/
overflowing PNG containers. Those additional ten focused cases passed. The other
resumed background/layer/HTTP/image/output regressions passed 39 cases in seven files.
Final complete-suite/floor/build results belong in the connected checkpoint.

## Exact public-authority declarations

Global runtime-import and direct-consumer ceilings remain 12 and 25. Exact measured
exceptions are limited to existing public authorities and composition roots:

| Authority | Current count | Reason |
| --- | --- | --- |
| shared/blockFingerprint | 47 consumers | Canonical upload/candidate/snapshot fingerprints |
| application/mcpEditPolicy | 98 consumers | Typed external-input, staging and publication failures |
| main/library | 59 consumers | Native upload, lettering and background composition |
| mcpOutputSchemas | 19 runtime imports | Two strict contract families registered directly |
| mcpPageOperationSession | 26 runtime imports | One external-image session lifecycle connection |

The shared image publication request is narrowed to its actual consumed evidence,
recovery and outcome fields. Runtime image authorization, revision/hash/pixel checks,
native atomic publication and history are retained rather than duplicated.

## Test interpretation

Actual PNG bytes, masks, protected/outside pixels, native block/image persistence,
page/context ownership, exact recovery and OAuth/HTTP run in isolated fixtures.
Unit/integration tests substitute Electron image I/O at its external boundary.
The separate native smoke uses actual Electron decoding and native history; its
completion marker and exit status must be recorded only after execution.
No user artwork, model quality, live ChatGPT/Tailscale or attachment acceptance is
claimed by these automatic measurements. Durable recovery remains a later bundle.
