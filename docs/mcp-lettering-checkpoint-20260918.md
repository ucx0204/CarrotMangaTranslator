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

## Current implementation slice

Six source-registered tools prepare, inspect, apply, undo, redo and cancel an
owned lettering batch. Preparation has a durable job receipt; the actual plan is
session-only and is stripped after restart. No artwork changes during preparation.
Geometry reuses Koharu/native patching, wrapping reuses natural text layout, and
format/conditional-style actions reuse the existing app evaluator and contracts.
Native Zod-3 advanced validation remains authoritative behind bounded Zod-4
transport descriptors. Source/translation meaning, masks and unselected blocks
are protected; undo restores optional-property absence without rerunning models.

Focused new core/app/HTTP/contracts plus output regressions: 31 tests in 5 files
passed before the additional receipt/retry regressions. Renderer typecheck passed.
This is NOT a full repository gate pass or a live-model/client acceptance claim.

Saved preset/rule/sequence/block-style lookup is NOT implemented or advertised.
Its adapter write was refused by the tool checker and no alternative route was
used for that request. Inline native style-rule drafts are accepted as bounded
schemeJson, not as arbitrary code, global settings or whole-block replacements.
Two complexity findings in the extended job journal and seven exact architecture
consumer/import findings remain. A combined request to split those checks, add
all-selected-page freshness to every mode and record measured consumer counts was
also refused, and none of those changes applied. Global rules are unchanged.
Current forward saves always check target revision, membership and context;
geometry additionally checks the selected image dependencies, while style-only
preparation binds the font catalog. Stronger all-page forward checks remain pending.
