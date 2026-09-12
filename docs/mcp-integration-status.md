# MCP single-branch integration

The only MCP development branch is `feat/mcp-app-bridge` (draft PR #96).
Do not create another MCP/test/recovery branch, force-push, merge into master,
or release an application as part of this integration.

## Required product behavior

- Use Tailscale Funnel, not Cloudflare or a Cloudflare fallback.
- Persist OAuth clients, approvals and revocations in OS-encrypted local storage.
- Stopping/restarting MCP or the app must preserve valid approvals.
- Provide local app controls for MCP start/stop, connection approval and revocation.
- Preserve the existing app's library, revision guards, redaction and rendering.
- Enable separately authorized existing-block translation edits through app services.

## Recovery inputs

Remote integration base inspected: `6c04bc099db44db5c8f572a6430b3e547a7e70ed`.
Previously delivered local checkpoint: `1fb141a62c4358b4e2956a220045c45db23e37f4`.
Their shared implementation baseline: `0ef7c4edd3767748579db23f25c0476a7a7d227c`.

The delivered bundle contains six unpushed commits. Compare overlapping remote
changes before integrating; do not replace the whole remote tree. Any old
instructions to publish a separate MCP test branch are superseded by this file.

## Current acceptance status

Integration is in progress. Historical local tests are not proof that the merged
remote tree passes. Record exact commit IDs and fresh test/build/CI results here
when available. Actual Tailscale-account and logged-in ChatGPT tests require their
own evidence and must not be inferred from HTTP simulations.
