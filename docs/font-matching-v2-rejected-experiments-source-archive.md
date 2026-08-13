# Font matching v2 rejected-experiment source archive

## Status and authority

This manifest records source and test files removed from the default branch after
their experiments were rejected in
`docs/font-matching-v2-production-handoff.md` section 5. The archived code is
historical reproduction material only. It is not production-release authority,
human gold, calibration authority, or a v3 training input.

The exact pre-cleanup tree is preserved by Git commit:

`a956915ec6f4a4d88fe72487a02571be1c2d6698`

Do not rewrite or garbage-collect that reachable history. The files were removed
instead of moved under a tracked `archive/` directory so normal type checking,
formatting, linting, test discovery, and repository navigation no longer carry
the rejected implementations.

No model, dataset, runtime, evaluation report, or cache is removed by this source
cleanup. The data-authority and cache-retention rules in the production handoff
remain authoritative.

## Archived inventory

SHA-256 values bind the exact bytes at the base commit. `Lines` is the physical
line count before removal.

| Rejected family                  | Path                                                                        |  Bytes | Lines | SHA-256                                                            |
| -------------------------------- | --------------------------------------------------------------------------- | -----: | ----: | ------------------------------------------------------------------ |
| Page-relative role reroute v1/v2 | `scripts/ablate_manga_font_page_relative_role.cjs`                          | 39,789 | 1,163 | `1988590579c8efc0886d728251b462147b8b50953572320af3b25c8e2e555a71` |
| Page-relative role reroute v1/v2 | `scripts/seal_manga_font_page_relative_role_training_only_diagnostic.cjs`   | 30,459 |   909 | `9edcaf60270b62e4853571c5a67d162e118ce448e5c2cb794e80020ae71a6ba2` |
| Page-relative role reroute v1/v2 | `tests/mangaFontPageRelativeRoleAblation.test.ts`                           |  8,606 |   309 | `77b6896b046e58d3d3fa16740eeda387751627895dd58a75a29b75eb37490838` |
| Page-relative role reroute v1/v2 | `tests/mangaFontPageRelativeRoleTrainingOnlyDiagnostic.test.ts`             |  6,008 |   218 | `ba713aa9b6d3bd6d11f5441a1c8a44cc36d1f7d1d4e69da34e7682fa38367fde` |
| Fixed body override classifier   | `scripts/train_manga_font_r3h_body_override.py`                             | 61,034 | 1,441 | `b974ff296f79db2f65a968ccf40d7b04e4342a7a2345ad843b5adedcce4055c9` |
| Fixed body override classifier   | `tests/python/test_train_manga_font_r3h_body_override.py`                   |  7,456 |   188 | `b93dc1ee0e4e2b9dc8ea969c0c6a99ab788e085d3c92fd09b15b863e8ea98e7b` |
| Token-attention residual v8.2    | `scripts/train_manga_font_student_v82_token_attention_adapter.py`           | 57,076 | 1,293 | `026204c0271fbd739becab33d4bfb9dc89d1f54eafc3496b4be753626c5097c3` |
| Token-attention residual v8.2    | `scripts/ablate_manga_font_student_v82_residual_scales.py`                  | 26,823 |   649 | `ab543e1d2d9bf9515ecf41ac870d7930134cb4e20c19ad8bd9dce4234beed6f2` |
| Token-attention residual v8.2    | `tests/python/test_train_manga_font_student_v82_token_attention_adapter.py` |  3,981 |   109 | `16e8735e3df5953953a3a2ef2e75c8e7cf71cb787d93a008939d9aae62333ac3` |
| Token-attention residual v8.2    | `tests/python/test_ablate_manga_font_student_v82_residual_scales.py`        |  2,581 |    64 | `b41da15d5577257a9655ac04d0d22f202e700342e74a8d4d2e13b1ecc1b7ea8b` |
| v6-r2/hybrid                     | `scripts/analyze_manga_font_student_v6_hybrid.py`                           | 34,326 |   800 | `4d2495fb37a1af06e891017f6ffbb2832066887875772d8a4de152d4e6e61881` |
| v6-r2/hybrid                     | `scripts/export_manga_font_student_hybrid_runtime_onnx.py`                  | 58,008 | 1,233 | `4349329ddfcca8cc2cff3a001d5fadf481346b7d5e36091b06dc9e2d24b01124` |
| v6-r2/hybrid                     | `tests/python/test_analyze_manga_font_student_v6_hybrid.py`                 |  1,574 |    46 | `896d880561ca24d05927c069637fc893f12507174079ea46dde307462d056e48` |
| v6-r2/hybrid                     | `tests/python/test_export_manga_font_student_hybrid_runtime_onnx.py`        |  8,505 |   202 | `17451b43d002ed207dd02333a7e4ea487c5aba354e72803cd9e5e6747b72f08e` |

## Why each family stays retired

- Page-relative role reroute corrected some labels but did not improve selected
  fonts or rendered pages consistently. Production remains disabled by default.
- The fixed body override produced 27/27 false positives on the sealed non-val33
  cohort and 2/2 false positives on the visual cohort.
- The v6-r2/hybrid and large score-blend path regressed the r3 holdout and Single
  Day safety.
- The bounded v8.2 token-attention candidate passed its local gate but did not
  beat the r3h base in the alpha sweep.

These conclusions come from the production handoff, not from file-reference
counts. A future experiment should start from the v3 priorities and fresh
work-disjoint authority rather than restoring these implementations into the
default branch.

## Replacement contracts that remain active

Archiving the experiment implementations must not remove the product safety
contracts that their failures established:

- Page-relative rerouting stays opt-in, auditable, and consistency-guarded in
  `tests/fontMatchingPageRelativeRoleQa.test.ts`,
  `tests/fontMatchingPageRelativeRoleQaConsistencyGuard.test.ts`, and
  `tests/libraryFullPipelinePageRelativeRoleQaAudit.test.ts`.
- Intentional body changes still require a safe anchor-replacement margin and a
  strict role palette in `tests/fontMatchingDecisionV2.test.ts`.
- Single Day remains masked for body roles in
  `tests/fontMatchingPixelCandidateEligibility.test.ts` and
  `tests/fontMatchingPagePixelInference.test.ts`; release acceptance still
  requires zero body-role Single Day selections in
  `tests/fontMatchingRuntimeArtifactStatus.test.ts`.
- The deployed artifact inventory, loader boundary, and final-release evidence
  remain covered by `tests/mangaFontV7RuntimeArtifact.test.ts`,
  `tests/fontMatchingRuntimeAssets.test.ts`, and
  `tests/fontMatchingRuntimeArtifactStatus.test.ts`.

The v6 exporter also contained the runtime-v2 envelope constants used by the
active v7-to-v8 reproduction chain. Those shared serialization contracts remain
in the active v7 exporter; only the rejected v6 model analysis/export path is
archived. Serialized file names, output names, routing metadata, batching, and
test-data boundaries must remain byte-contract compatible.

The generic adapter interpolation utility is not part of this archive. The
current r10 conservative selector imports it, so rejected r4a25/r7a35 artifacts
do not make that shared utility dead.

## Exact restoration

Restore only the family needed for historical reproduction. Each command reads
the exact bytes from the base commit without changing other working-tree files.

Page-relative role reroute:

```powershell
git restore --source=a956915ec6f4a4d88fe72487a02571be1c2d6698 -- `
  scripts/ablate_manga_font_page_relative_role.cjs `
  scripts/seal_manga_font_page_relative_role_training_only_diagnostic.cjs `
  tests/mangaFontPageRelativeRoleAblation.test.ts `
  tests/mangaFontPageRelativeRoleTrainingOnlyDiagnostic.test.ts
```

Fixed body override:

```powershell
git restore --source=a956915ec6f4a4d88fe72487a02571be1c2d6698 -- `
  scripts/train_manga_font_r3h_body_override.py `
  tests/python/test_train_manga_font_r3h_body_override.py
```

Token-attention residual v8.2:

```powershell
git restore --source=a956915ec6f4a4d88fe72487a02571be1c2d6698 -- `
  scripts/train_manga_font_student_v82_token_attention_adapter.py `
  scripts/ablate_manga_font_student_v82_residual_scales.py `
  tests/python/test_train_manga_font_student_v82_token_attention_adapter.py `
  tests/python/test_ablate_manga_font_student_v82_residual_scales.py
```

v6-r2/hybrid:

```powershell
git restore --source=a956915ec6f4a4d88fe72487a02571be1c2d6698 -- `
  scripts/analyze_manga_font_student_v6_hybrid.py `
  scripts/export_manga_font_student_hybrid_runtime_onnx.py `
  tests/python/test_analyze_manga_font_student_v6_hybrid.py `
  tests/python/test_export_manga_font_student_hybrid_runtime_onnx.py
```

After restoration, compare every file with the SHA-256 table before running it.
Use the historical environment and artifact bindings recorded by the restored
scripts. Restoration is for isolated reproduction only; it does not authorize
promotion, training-label reuse, or a production default change.
