# MCP selective typography implementation checkpoint - 2026-09-18

Continue only in the existing review worktree on `feat/mcp-app-bridge`.
Bundle 1 remains in progress. Bundles 2-13 are not started. Live/model/client
acceptance remains deferred until the requested implementation sequence is built.
This checkpoint does NOT register remotely callable typography application tools.

## Implemented internal behavior

The previous analysis-service function-length finding was fixed without changing
stage semantics, verified and published as `7ac32e96`.

The internal application path now composes the existing C23 decision/applier and
source-size intent applier. Font-only and size-only selections preserve the other
fields. Measured source face pixels are never copied to nominal fontSizePx.
Generated/sound blocks and absent evidence are excluded; manual size is protected
unless explicitly overridden using available measurement evidence.

Both exact block locks and saved-role user locks veto automatic font replacement.
The saved semantic role is only a manual-lock veto, never automatic-selection
input; the existing pixel-only resolver and model/asset algorithms are unchanged.

The existing page batch lifecycle accepts asynchronous planning with owner/guard
context and duplicate-request race checks. A typed plan retains analysis metadata
once, rather than duplicating it in every block. Forward dependencies use the
original observation revisions updated ONLY by this plan's acknowledged commits.

Typography commits share the existing native page edit transaction. The internal
snapshot validator rejects text, source/display geometry, images and unrequested
fields. Undo restores the exact prior state, including absence of optional fields.

## Not connected / blocked requests

The source-file freshness adapter write was refused by the tool safety checker.
The combined request also included exporting the shared context-lease adapter;
neither change was applied. `mcpTypographySourceEvidence.ts` does not exist.
No alternate tool or route was used for the refused operation.

Production observation ownership lookup, original-file/catalog/profile freshness
checks during preview and immediately before apply/redo, and the final MCP
application-tool composition remain unfinished. Do not substitute a permissive
validation callback or expose the internal snapshot setter remotely.

A later request to fix a non-null assertion in a new test and record two exact
architecture consumer counts was refused as well. Those edits were not applied.
Known remaining static findings are one test non-null assertion and canonical
fingerprint/error consumer counts (33 versus 32 and 62 versus 61). No rule or
coverage floor has been disabled or lowered. The old production function-length
finding is resolved, not merely suppressed.

## Automatic verification scope

Core/selective lifecycle plus existing format/text batch regressions passed:
77 tests in 10 files. This includes exact apply/undo/redo, partial commits,
notification failure, cancellation, async preview races, revocation, expired
history, unchanged plans and later user/dependency edits.

The C23 inference and production freshness boundary are NOT exercised by these
new core fixtures. The fixture projects fixed observations through the actual
font/size appliers and page mutation service; its external validation callback is
explicitly synthetic and must never be used in production composition.
Existing text/format HTTP integration tests still cover real page handoffs,
context leases and atomic storage after the shared-service refactor.

Verified separately: Renderer/Electron/JavaScript type checks, test mock-boundary
rules, error-handling rules, duplicate checks and the normal Windows build pass.
The implementation/test checkpoint is published as `4decdbcd`.
The full Vitest/V8 result and new-module coverage registration follow below once
that run completes. Current known static findings above remain, so this is not a
full-check success claim.

## Resume order

1. Resolve the recorded single test-lint finding and exact architecture counts.
2. Finish the production source/catalog/profile validation and owned-observation
   lookup before registering any of the six new selection/recovery tools.
3. Exercise those adapters with isolated storage/HTTP tests; never bypass the
   missing validation with a permissive callback.
4. Finish bundle 1 gates and its feature/service/tool map; then start bundle 2.
5. Keep live acceptance deferred. No user app restart, artwork/library/auth change,
   actual C23 execution, Tailscale client call or download test was performed.

## Final observed checks for this continuation

The complete Vitest/V8 rerun finished with exit code 0, followed by the production
coverage-floor checker with exit code 0. The first run's inventory-only failure
was resolved by measured registration, not by omitting tests. Final artifacts:
`.tmp/mcp-typography-apply-final-tests.json`
`.tmp/mcp-typography-apply-final-coverage.log`
`.tmp/mcp-typography-apply-final-floors.log`

The final totals were not re-summarized after the extra metadata-read request was
refused. The successful completed process receipts and saved logs are the evidence;
do not reuse the first run's failed total as the final result.

Formatting passed. Renderer/Electron/JavaScript type checks, dependency analysis,
unused-export analysis, mock boundaries, error-handling, duplicate checks and the
normal Windows build passed. Lint still reports the single non-null assertion in
mcpTypographyBatchLifecycle.test.ts; architecture budgets still report the two
consumer-count findings. Therefore the overall check command is NOT all green.

Published milestones: `7ac32e96` analysis refactor, `4decdbcd` selective core and
regressions, `4f00cae1` measured coverage registration. The next resume remains the
production evidence/owner adapter and remote tool composition, plus these static
findings. No application tools were registered or user artwork mutated.
