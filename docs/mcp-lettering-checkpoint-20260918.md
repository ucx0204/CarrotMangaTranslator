# Bundle 2: independent lettering - 2026-09-18

Baseline: `c3b9d1a1` on `feat/mcp-app-bridge`, existing review worktree only.
Bundle 1 is implemented and automatically verified; do not repeat it.
Bundle 2 is in progress. Live/model/client acceptance is deferred until the
complete 1-13 implementation sequence, as requested by the user.

## Implementation slices

1. Reuse native bubble-layout and natural-wrap functions independently of OCR,
   translation, erasure, C23 matching and rendering. Plan before application.
2. Add bounded advanced text effects/transforms and safe partial-rich-text style
   changes using existing contracts and rule evaluator, not another renderer.
3. Read stored style presets, conditional rules/sequences and block-library style
   metadata, then apply explicit selected resources through the same plan history.
4. Bind plans to page/context/resource snapshots, preserve manual state by default,
   validate before forward saves, and use existing exact undo/redo and cancellation.
5. Register actual tools and strict outputs, run automatic regression and repository
   gates, commit/push frequently, then record the precise remaining work here.

No user artwork, live app restart, authentication change, model-asset replacement,
master merge or release is authorized by this development task. Do not use tests
that alter the real library. Resource query must not expose image/font bytes,
private paths, credentials, or silently run a model/install a missing asset.
