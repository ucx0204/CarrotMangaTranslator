# MCP Tailscale publication handoff

Target: `feat/mcp-app-bridge`, draft PR #96. **Tailscale Funnel only; persistent authentication is required.** No Cloudflare fallback, master merge, release or force-push.

Implementation and evidence: [mcp-implementation.md](mcp-implementation.md). User guide: [mcp-tailscale-testing.md](mcp-tailscale-testing.md).

## Implemented

- Owned foreground Funnel, stable running-node identity, occupied-route refusal and bounded child cleanup.
- OS-encrypted durable clients/grants, rotating tokens, replay detection and persistent offline revocation.
- Trusted desktop settings, on/off, image/edit opt-ins, diagnostics and stable URL copy.
- App-side approval with matching browser code, HttpOnly cookie and PKCE; no terminal password in the normal path.
- Existing block reads and translation-text-only patches through app transactions and the existing editor merge.
- Shutdown blocks immediately but retains the local port until the owned public route is closed.
- Concurrent remote source reconciled; ten remote tests retained. Integrated focused run: 183 tests in 22 files passed.

## Publication recovery

The earlier remote state is preserved at `backup/mcp-before-publication-20260912` (`6c1f563497b742d58a9584dd5eda25431bb4392e`). Source publication is in small native GitHub API commits on `integration/mcp-tailscale-publication-20260912`, based on `6c04bc099db44db5c8f572a6430b3e547a7e70ed`. Final publication must fast-forward `feat/mcp-app-bridge`; never replace another writer's later commit. Each generated Git tree is compared with the tested local source. Native GitHub remote write access is available and has been used successfully.

The original six local commits are preserved in the earlier delivery bundle. They are not to be cherry-picked blindly over the reconciled remote branch. The incorporated code and tests are published as source, not merely as an unapplied patch or ZIP.

## Acceptance still to record

Windows build, real OS encrypted authorization smoke, full static checks and exact tested commit are recorded in PR #96 after the checkpoint completes. Do not infer full repository checks from focused tests. The local Knip run hit a WASM allocation error. Actual browser screenshots, Tailscale account setup, live public requests, ChatGPT pairing, idle/repeated calls and off/on/restart/revocation require separate evidence. No logged-in account session is claimed by scripted HTTP tests.

Full page analysis/new block creation, OCR/erasure/lettering jobs, rendered export/ZIP, web import and research/context batch work remain beyond the current existing-text editor.
