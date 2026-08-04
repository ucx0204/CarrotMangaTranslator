# MangaFont hybrid runtime v2

This is a sealed, non-default base runtime for the exact v3-body/v6-r2-variant
hybrid. It is intentionally not deployable until a supervised calibration is
rebuilt from the same role-routed score that the application will consume.

## Why the encoder is 1280-D

The strongest v3 head consumes the fine-tuned v2 SigLIP2 pooler followed by
the learned 256-D projection. The v6-r2 head was trained on patch tokens from
the pinned, unmodified SigLIP2 tower. Sharing either tower changes one model's
input distribution, and averaging per-view v6 logits is also not equivalent to
v6's three-view query aggregation.

`encoder.onnx` therefore contains both frozen branches and emits:

- `image_features[:, 0:256]`: exact v3 legacy embedding.
- `image_features[:, 256:1280]`: exact four-by-256 v6 query embeddings.

The packed prototype bank keeps all 352 legacy rows in the first 256 columns.
The first 22 rows additionally carry one v6 candidate's four query prototypes
in the last 1024 columns. The remaining variant columns are zero and validated.

`ranker.onnx` retains `candidate_scores` as an exact alias of
`body_candidate_scores`, and adds `variant_candidate_scores`. The application
must combine the translated/OCR item role and v3 pixel role before selecting
one score row:

- dialogue, narration, thought: body score;
- every other known role: variant score;
- unresolved/unknown: sealed variant fallback.

There are no sample-specific routing rules.

The successor also seals the exact parity-qualified runtime batching:
encoder batch size `2`, ranker batch size `16`. The application must consume
these values from `runtime_batching`; using the legacy encoder batch size is
not part of the qualified v2 contract.

## Reproducible commands

PowerShell source setup:

```powershell
$encoderSource = Get-ChildItem -Path $env:USERPROFILE\.cache\huggingface\hub\models--google--siglip2-base-patch16-224\snapshots -Directory |
  Where-Object { $_.Name -eq '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2' } |
  Select-Object -First 1 -ExpandProperty FullName
```

Shared source arguments used below:

```text
--student-output artifacts/manga-font-student-full22-v2
--active-catalog artifacts/manga-font-full22-active-catalog-v2/auto-match-active-catalog.json
--encoder-source-dir $encoderSource
--v3-cache-dir artifacts/manga-font-student-v3-embedding-cache-legacy727-v2
--v3-readiness-dir artifacts/manga-font-student-v5-readiness-v1
--v3-head artifacts/manga-font-student-v5-readiness-v1/strongest-head.safetensors
--v6-output-dir artifacts/manga-font-student-v6-fontquery-r2-first40-v1
--hybrid-diagnostic-dir artifacts/manga-font-student-v6-hybrid-diagnostic-v2
```

Run `preflight`, then `build`, then the independent `validate` command with
those arguments. The build-specific suffix is:

```text
--output-dir artifacts/manga-font-student-hybrid-runtime-v2-base
--electron-path node_modules/electron/dist/electron.exe
--parity-samples 32
--parity-seed 20260803
--wasm-timeout-seconds 7200
```

The current sealed artifact is
`artifacts/manga-font-student-hybrid-runtime-v2-base`. Its contract SHA-256 is
`307c3f06ac969d8e506ecc765ade7627ae2b328d80485a76a1e0d40f1f133e39`.

## Parity evidence

Parity uses 32 deterministic synthetic rows only. Test30, fresh64, library QA,
and their labels/pixels are not accessed.

- CPU ORT: encoder max absolute error `2.28e-6`, ranker `7.63e-6`.
- Electron WASM: encoder max absolute error `1.63e-6`, ranker `6.20e-6`.
- Body, variant, role, and none decisions: `1.0` agreement.
- `candidate_scores` versus `body_candidate_scores`: exact zero error.

## Calibration boundary

Do not attach an old selection calibration. Its ranker hash is different, and
the existing builder evaluates only the legacy `candidate_scores` body alias.
The sealed val manifest also lacks the application item-role binding needed to
reconstruct `resolveCombinedAutomaticFontRole(item.fontRole, pixelRole)`.

A valid hybrid calibration becomes possible only when its calibration rows
contain the same app item/OCR role fields used in production, or when a frozen
app-pipeline trace supplies the resolved combined role per row. The builder
must select body/variant scores first and use that selected score for every
calibration feature and operating-family estimate. Until then the missing
`selection-calibration.json` intentionally keeps automatic mutation disabled.
