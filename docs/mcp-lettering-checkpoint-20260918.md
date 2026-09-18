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

## Final observed automatic checks for this continuation

Verified source checkpoint: `2db68450` (implementation `1aa7e6c0`).
The full Vitest/V8 suite exited 0: 7,694 passed, zero failed, 11 existing skips.
All 880 MCP tests across 118 files passed. The production coverage checker exited
0: 753 baseline plus 830 introduced records, with 10 unchanged deletion records.
Every one of the 1,572 inherited floor records, provenance and deletion entries
was compared directly against `c3b9d1a1` and preserved; 11 measured rows were added.
The normal Windows build exited 0. Renderer/Electron/JavaScript type checks,
dependency direction/cycle checks, unused exports, test-mock boundaries and
error-handling checks passed. The protected pipeline, bubble-detector and runtime
source trees and dependency manifests have no changes against that baseline.

This is NOT an all-26-gates pass. Lint has two job-journal functions at complexity
13 versus the existing maximum 12. Architecture budgets still report seven exact
consumer/import findings. Their attempted combined cleanup was not applied.
The rules and global limits remain unchanged, and those findings are not waived.

Actual model inference, live-user artwork, ChatGPT/Tailscale calls and downloads
were not tested. New tests use isolated temporary libraries and real native
style/wrap functions, source hashes, page/context transactions and OAuth/HTTP;
Koharu inference and its cleanup boundary are substituted. No live app restart,
user-library/auth change, real-model asset download, master merge or release.

Evidence: `.tmp/mcp-lettering-final-tests.json`, `mcp-lettering-full-tests.log`,
`mcp-lettering-final-floors.log`, `mcp-lettering-build.log`, `mcp-lettering-lint.log`,
`mcp-lettering-arch.log`, and `mcp-lettering-coverage-evidence.json` under `.tmp`.

## Registered feature map and exact resume point

| Capability                             | Existing or connected authority                                    | Tool                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Geometry / wrap / combined preparation | Native Koharu runner and natural text layout                       | carrot_prepare_lettering_batch                                                           |
| Advanced styles and inline emphasis    | Native conditional evaluator and Zod-3 transform/effect validators | carrot_prepare_lettering_batch                                                           |
| Owned, paginated plan inspection       | Existing bounded page-batch history                                | carrot_get_lettering_batch                                                               |
| Native page commits / exact recovery   | Existing page handoff, context lease and atomic page edit          | carrot_apply_lettering_batch / carrot_undo_lettering_batch / carrot_redo_lettering_batch |
| Active-action cancellation             | Existing batch action UUID and lifetime handling                   | carrot_cancel_lettering_batch                                                            |

Preparation returns a job receipt, not a completed edit. Poll carrot_get_job, then
inspect result.letteringPlan.batchId. Preparation cancellation uses carrot_cancel_job.
Only the explicit apply action saves. History is session-only with a 30-minute idle
window, and durable job receipts do not recreate it after restart. Font files,
images, arbitrary paths and raw replacement block objects are not remote inputs.

Resume within bundle 2, not bundle 3:

1. Resolve the recorded job-journal complexity and architecture findings without
   disabling global rules, copying canonical authorities or hiding dependencies.
2. Add the pending consistent all-selected-page forward freshness check in every
   mode, with a regression for a changed non-current selected page.
3. Finish saved preset/rule/sequence/block-library style lookup and explicit
   version-bound reuse through native stores. Do not substitute an always-valid
   resource verifier or expose global settings/embedded image bytes.
4. Complete the saved-resource tests and bundle-2 repository gates. Keep final
   actual-model/client/user-artwork acceptance deferred as requested.
