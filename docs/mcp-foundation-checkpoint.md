# MCP foundation checkpoint

Work only on `feat/mcp-app-bridge` in the existing desktop review worktree.
Starting source: `41574c63`. The running app and all user data stay untouched.

## Scope selected for this checkpoint

1. Machine-readable tool output contracts and accurate per-tool annotations.
2. 2026-07-28 stateless discovery, request metadata/header validation and complete results.
3. Non-secret server/data-profile identity so a new worktree is distinguishable from a restart.
4. Durable job receipts, owned listing, explicit safe retry after interruption; no second GPU scheduler.

Other-client OAuth callbacks are explicitly deferred by the user. No conversion wizard, old-data migration or alternative tunnel is being built. The current ChatGPT wire entry must not be removed without an actual replacement test. No new sampling dependency.

## Verified normative references (2026-09-15)

- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration

## Status

Implementation in progress. This document is not evidence of completed tests. Commit each executable slice with tests and replace this section with actual results. Preserve existing coverage floors and test boundaries.
