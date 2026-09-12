# MCP first complete page milestone

Only branch: `feat/mcp-app-bridge`, draft PR #96. Tailscale only; preserve durable authorization. No UI redesign, releases, force pushes or extra branches.

The user confirmed the desktop/web connection works and requested implementation, not another proposal. Each feature below must remain independently callable. Commit tested increments frequently and record exact verification boundaries here.

## Acceptance target

A previously unprocessed page can be read by the connected AI or the app OCR, stored as editable app blocks, erased with the app's existing engine when requested, rendered with the existing app renderer and returned as a PNG. No implicit Codex or paid-engine fallback. Original artwork, masks, revisions, redaction policy and manual edits remain authoritative.

## Ordered implementation checkpoints

- [ ] Render current saved page and return bounded result preview, distinct from source preview.
- [ ] Read applicable work context without running research or translation.
- [ ] Read redaction-safe page crops with explicit original pixel coordinates.
- [ ] Create external-agent reading/translation blocks through revision-checked app transactions; preserve existing blocks and exact retry semantics.
- [ ] Run page OCR independently, without translation or image processing.
- [ ] Run app erasure independently and render existing text; reuse engine and mask authorities.
- [ ] Export original-resolution PNG and provide authorized bounded artifact access.
- [ ] Exercise the composed external-agent route with an isolated synthetic page in native Electron; retain independent tools.

## Safety and compatibility

Image output requires image permission and the existing redaction guard. Writes require editing permission and commit-time authorization/revision checks. Never expose raw filesystem paths, shell execution or secrets. Page crops and final images must not bypass redaction through alternate layers. Long operations need bounded ownership, cancellation and cleanup. Original-size output and inline previews have separate byte limits.

## Resume record

Starting code: `a91e6c9c1909a957509a7c23055d40f2d201c43c` (user-confirmed Tailscale/persistent-auth baseline). Existing source-only workbench is refreshed to synchronize the exact remote tree into the isolated editor; it does not copy any user library or secrets. No new page-processing feature is complete at this checkpoint.
