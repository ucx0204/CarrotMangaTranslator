# Bundle 5 external image/mask checkpoint - 2026-09-19

Baseline: `a59eab89`. Continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1-4 remain completed with
automatic checks; live user/model/client acceptance stays deferred.

Status: IN PROGRESS. No external upload/application capability is complete yet.

## Implementation boundaries

Receive bounded PNG chunks through authenticated MCP calls without raising the
existing 64 KiB request-body limit. Validate exact length, digest, dimensions,
PNG structure and explicit binary-mask semantics before issuing a ready file ID.
Uploads are session-owned, bounded and expiring. Never fetch caller URLs or read
caller paths; do not treat a filename or client file reference as received bytes.

Separate receipt, validation, preview, explicit application and recovery.
Bind external outputs to the selected saved page and original/cleaned/mask evidence.
Reuse native page ownership, library transactions, image history and generated
lettering representation. Preserve originals, text and nonselected pixels.
Whole-page replacement, masked/cropped background correction and existing-block
lettering incorporation are distinct explicit commands. No implicit model, OCR,
translation, erasure, asset download or settings/authentication change.

Keep exact retry receipts, stale/foreign input rejection, bounded cleanup and
native undo/redo. Session recovery is not bundle 7 permanent recovery.
Record tests and exact resume point before reporting completion; do not publish a
release, merge master, restart the live app or request intermediate live tests.
