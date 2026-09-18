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
