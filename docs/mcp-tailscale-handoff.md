# MCP Tailscale handoff

Use **only `feat/mcp-app-bridge`**, draft PR #96. Tailscale Funnel only, with OS-encrypted persistent authentication. No Cloudflare fallback, new MCP branch, force-push, master merge or release.

The recovered publication branch was merged, with both histories intact, in `53de254a9c456b316a63409e649418b1505596a5`. The unified source includes desktop controls, app-side pairing, durable clients/grants/revocations and revision-safe existing translation edits. This is actual source publication, not just a ZIP or unapplied patch.

[User guide](mcp-tailscale-testing.md) · [Integration evidence and next actions](mcp-integration-status.md) · [Implementation boundaries](mcp-implementation.md).

The cleanup step in the Windows checkpoint removes only the three explicitly enumerated, already-merged recovery branch references after all preceding checks pass. It validates their expected tips and ancestry first. A changed tip is preserved rather than overwritten. Unrelated branches are never removed.

Actual Tailscale account setup/public reachability and a logged-in ChatGPT session must be tested separately. Do not infer either from synthetic HTTP or OS-encryption tests. Full page OCR/new blocks, erasure, image lettering/SFX, rendered ZIP export and research/import batching remain beyond the current existing-text edit tool.
