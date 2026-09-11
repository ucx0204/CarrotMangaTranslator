# Redaction review repair / issue #93

Branch: `fix/redaction-review-and-sfx-93-20260911`
Base: `ede815eba3881cb66117512989f71a38271906ad`

## Resume contract

Each independently completed fix is committed and pushed before starting the next fix. This document records progress and verification, not an assertion that pending work is complete. Do not merge, squash, release, change the version, or modify user originals/library/output. Keep the three existing basic redaction UI smoke tests; use small deterministic policy/storage/transport tests rather than restoring screenshot matrices. Use the ordinary repository checks for final verification.

## Work queue

- [ ] F01: additive mask copy must not erase existing target redactions.
- [ ] F02: explicit cancellation/exit must remain possible when draft storage fails.
- [ ] F03: isolate concurrent draft revisions and safely merge disjoint changes.
- [ ] F04: recover preview failures without hiding source/mask validation errors.
- [ ] F05: preserve review status for no-op selection/transform.
- [ ] F06: bounded per-page and batch undo histories.
- [ ] F07: explicit, consistent copy scaling across aspect ratios.
- [ ] F08: bound native mask display work to the visible region.
- [ ] F09: provide native-resolution detail at inspection zoom.
- [ ] F10: propagate command failure; keep unrelated errors independent.
- [ ] F11: immediate dirty state and explicit draft lifetime across cancellation.
- [ ] F12: partition draft storage and define safe retention/cleanup.
- [ ] F13: share source raster limits across preparation/schema/rendering.
- [ ] F14: move workspace orchestration behind application ports.
- [ ] F15: narrow UI contracts and remove duplicated current-document authority.
- [ ] F16: integrate redaction bindings with the common shortcut machinery.
- [ ] F17: make confirmation mode explicit in trusted pending-job state.
- [ ] F18: wire pre-edit entry points for work/chapter/page selections.
- [ ] F19: consolidate current documentation and remove obsolete branch CI.
- [ ] #93: reproduce and repair SFX JSON/zero-translation handling without fabricated translations.
- [ ] Baseline Windows conditional-batch test failure: identify and repair deterministic readiness.
- [ ] Final: typecheck, lint, architecture, focused regressions, ordinary full checks; record exact results.

## Baseline observations

Issue #93 reports selected SFX translation failing with `Failed to parse model output as JSON.` and later partial runs reporting `0개 번역` under Gemma. No original model response is attached; distinguish reproduced contract failures from unverified model-specific behavior.

The baseline Check run `34556120674` passed macOS and failed Windows in `conditionalBatchEditor.test.tsx` while looking for the favorite recipe button. Do not treat this as proof that redaction caused the failure.

## Completed checkpoints

- Planning: created this branch from the reviewed master commit and recorded the work queue. No product changes yet.
