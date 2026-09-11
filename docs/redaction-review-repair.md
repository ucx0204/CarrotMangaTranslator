# Redaction review repair / issue #93

Branch: `fix/redaction-review-and-sfx-93-20260911`  
Base: `ede815eba3881cb66117512989f71a38271906ad`

## Resume contract

Each completed fix is committed and pushed separately. Read this queue and the subsequent commit messages before resuming; do not replay old patches. Do not merge, squash, release, change the version, or modify user originals/library/output. Keep the three existing basic redaction UI smoke tests; use small deterministic policy/storage/transport tests, not screenshot matrices. Final verification uses the ordinary repository checks.

## Work queue

- [x] F01: additive mask copy must not erase existing target redactions.
- [x] F02: cancellation/exit when storage fails.
- [ ] F03: disjoint draft revisions and safe conflict handling.
- [ ] F04: recoverable preview failures.
- [x] F05: no-op selection/transform preserves review.
- [ ] F06: bounded per-page and batch undo.
- [ ] F07: consistent copy scaling.
- [ ] F08: bounded visible-region mask display.
- [ ] F09: native-resolution inspection detail.
- [ ] F10: command results and independent error ownership.
- [ ] F11: immediate dirty state and cancellation-safe draft lifetime.
- [ ] F12: partitioned storage and safe retention.
- [ ] F13: shared source raster budgets.
- [ ] F14: workspace application ports.
- [ ] F15: narrow UI contracts and one current-document authority.
- [ ] F16: common shortcut machinery.
- [ ] F17: explicit trusted confirmation mode.
- [ ] F18: work/chapter/page pre-edit entry points.
- [ ] F19: current documentation and obsolete branch CI cleanup.
- [ ] #93: SFX JSON/zero-translation handling.
- [ ] Baseline Windows conditional-batch readiness failure.
- [ ] Final static checks, regressions, ordinary full checks.

## Verification and checkpoints

- Planning commit: `405d0a8`.
- F01 (`378647f`): additive copies are isolated command groups whose completed masks are unioned. Nested copies and subsequent global erasers retain their semantics; old unscoped masks are unchanged. The actual batch application and its preview use the same merge policy. Local Node 22: 20 copy/raster/native-adapter tests passed; focused ESLint passed. Full renderer/shared typecheck also passed.
- F02 (`c85f001`): an explicit no-write exit is offered after an error; it stops new autosaves and cancels the waiting job without requiring disk success. Normal save/rollback/send still require an acknowledged write. Existing in-flight writes are not misrepresented as rolled back. Local exit/draft/locale tests: 20 passed; focused ESLint passed.
- F05: unchanged strokes now return the original session before invalidating its decision. Selection without a transform no longer consumes history or starts a save. Two deterministic model regressions and four raster cases passed; focused ESLint passed. This checkpoint does not claim a full repository check.

## Baseline observations

Issue #93 reports SFX output failing JSON parsing and later partial jobs reporting zero translations under Gemma. The original model response is not attached; do not claim model-specific reproduction without evidence.

Baseline Check `34556120674`: macOS passed; Windows failed in `conditionalBatchEditor.test.tsx` looking for the favorite recipe button. Do not assume redaction caused it.
