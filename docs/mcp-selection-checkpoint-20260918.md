# Bundle 3: selected OCR, translation and references - 2026-09-18

Baseline: `623a8838`, existing `feat/mcp-app-bridge` review worktree only.
Bundles 1 and 2 are implemented and automatically verified. This continuation
implements bundle 3; bundles 4-13 and final live acceptance remain separate.

## Scope

- Local OCR observations for explicit saved blocks and original-image rectangles.
- Independent translation proposals for explicit saved blocks, using the existing
  text-only model boundary and bounded task-local language/context permissions.
- Owned paginated analysis, then explicit source/translation application; region
  discoveries may be appended through native reading/block-order contracts.
- Explicit character/glossary block references with native validation and exact
  session undo/redo using existing page batch ownership and save transactions.
- Source/page/context freshness, manual/previous text protection, duplicate request
  handling, cancellation and cleanup, no hidden OCR/translation/image work.

Existing single-block tools remain compatible. No new general GPU queue, renderer,
translation provider, token store, arbitrary file path or shell tool is introduced.
No real user artwork, live app restart, authentication or approved model asset
change is part of automatic development tests. Live tests stay deferred until
all thirteen bundles are implemented as requested.
