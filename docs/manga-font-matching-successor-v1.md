# MangaFont-22 successor contract

## Product objective

Automatic font matching must normally make the choice itself. Keeping the
current font is an exceptional outcome for an unusable crop, missing glyph
coverage, or a genuinely unsupported style—not a confidence shortcut.

The release gate is measured on real library crops:

- normal/renderable automatic coverage: at least 90%, target 95%+
- overall Acceptable@1 at the selected operating point: target 90%+ for the
  first successor, then 95%+
- variant-role Acceptable@1: must be reported separately and may not be hidden
  by ordinary dialogue volume
- Recall@3: target 98%+
- every useful one of the 22 bundled Korean fonts remains eligible; zero usage
  is a failure to investigate, not automatic evidence that the font is useless
- episode consistency is a weak prior after local visual matching, never a
  reason to erase a real emphasis/effect-font change

## Evidence from the current runtime

The legacy runtime was exercised on five real works and 65 text blocks. It
applied zero font changes: 54 low-confidence decisions and 11
no-acceptable-candidate decisions. Thick/angular sound effects repeatedly
ranked `griun-pol-sensibility` ahead of visually closer bold display faces.

The full 28,096-crop pass-1 bootstrap exposed a second failure:

- 100% of crops received a provisional top-1 label
- median top-1 probability margin was only about 0.006
- ranker and direct synthetic-reference retrieval disagreed on about 98% of
  crops
- only 10 of 22 candidates were ever selected

Pass 1 is therefore retained as a review baseline with `pseudo_not_gold`
provenance. It must not be promoted directly into supervised truth.

## Research decisions

The successor follows four findings:

1. FontCLIP shows that font attributes and cross-language style retrieval are
   useful, but its simple crop/rotation augmentation is not sufficient for
   noisy manga effects. <https://arxiv.org/abs/2403.06453>
2. DeepFont shows that explicit synthetic-to-real domain adaptation and noise,
   spacing, and aspect-ratio augmentation materially reduce the real-image
   gap. <https://arxiv.org/abs/1507.03196>
3. FontVLM shows that sentence-level content, visual-interference augmentation,
   learnable font queries, and per-font synthetic reference banks are all
   important for open-set noisy font recognition. Its reference experiment
   uses 600 training renders and 60 reference renders per font.
   <https://openaccess.thecvf.com/content/CVPR2026F/html/Zhou_Towards_Universal_Open-Set_Visual_Font_Recognition_Via_Augmented_Synthetic_Similarity_CVPRF_2026_paper.html>
4. Generic VLM reading ability is not the same as typography understanding, so
   a generic chat/VLM answer alone cannot be treated as a font label.
   <https://arxiv.org/abs/2603.08497>

## Data authority tiers

| Tier              | Data                                                   | Use                                                      |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Gold              | finalized human font rankings                          | supervised fit, validation, calibration                  |
| Synthetic exact   | the real 22 bundled fonts rendered with known identity | encoder/font-query learning and reference banks          |
| Real unlabeled    | 28,096 visually accepted library crops                 | view consistency, domain alignment, pass-2 inference     |
| Pseudo pass       | model rankings with model/version/margin provenance    | review ordering and teacher distillation only            |
| Frozen evaluation | held-out works/crops                                   | final reporting only; never optimizer or threshold input |

Pseudo labels never silently become gold. A reviewed correction records its
parent pass, reviewer/round, candidates considered, and final acceptable set.

## Immediate student model

The first deployable successor uses the already cached
`google/siglip2-base-patch16-224` encoder so it can still be exported to the
application's ONNX runtime.

- unfreeze the final four vision blocks
- project the three runtime views into a 256-dimensional normalized font-style
  embedding
- train an exact 22-way synthetic identity loss
- train cross-view consistency across raw/context/glyph views
- oversample gold real crops to about 25% of supervised batches
- train gold labels as acceptable-set/listwise targets rather than forcing one
  arbitrary font when several are valid
- select checkpoints by real human-validation Acceptable@1 and Recall@3, not
  synthetic accuracy
- never open test pixels during training or checkpoint selection

The balanced synthetic v1 set contains 600 samples per font (13,200 samples,
39,600 runtime-format views). Roughly two thirds are variant roles. Every font
receives the same role distribution to prevent role or genre from becoming a
font-identity shortcut. Treatments include real blurred library backgrounds,
paper noise, outline, shadow, inverse fill, color, slant, rotation, and vertical
layout.

## Teacher escalation

If the compact student plateaus below the real variant target, train an offline
MangaFontVLM teacher using a 3B–4B vision-language backbone and FontVLM-style
learnable font-query embeddings. The teacher is not the app runtime. It produces
soft 22-font rankings and style explanations for disagreement/review queues;
the corrected results are distilled back into the compact ONNX student.

This keeps the app fast while allowing a much larger model to mediate hard
effects, handwriting, and cross-script style comparisons during dataset
construction.

## Multi-pass labeling loop

1. Pass 1: cover all 28,096 crops quickly with 22-font top-5 rankings.
2. Pass 2: rerun all crops with the synthetic+gold-trained student.
3. Queue priority: variant role/category, pass disagreement, low margin,
   student/reference disagreement, then episode-level ordinary outliers.
4. Review with work/chapter/page context visible; this stage is intentionally
   not blind.
5. Promote only reviewed corrections/acceptable sets to gold.
6. Retrain and repeat until the real-library gates pass without candidate-usage
   collapse.

## Runtime decision order

1. Local pixels produce a 22-font ranking and role/style/treatment evidence.
2. A supervised top-three calibrator may rerank only when its sealed operating
   point is met.
3. Below the calibrated threshold, preserve the base model order/confidence;
   do not fabricate confidence and do not force the current font.
4. Only severe invalid input, true none-acceptable, no renderable candidate, or
   missing translated-glyph coverage may abstain.
5. Apply a weak episode prior to ordinary dialogue after local selection.
6. Variant/emphasis/effect evidence overrides the episode prior.

## Current artifacts

- `artifacts/font-matching-fast-label-full28k-v1`: three-view features and
  pass-1 rankings for 28,096 crops
- `artifacts/manga-font-synthetic-full22-v1`: balanced noisy 22-font synthetic
  set
- `artifacts/font-matching-selection-calibration-legacy15-v1.json`: interim
  gold-only calibrator
- `artifacts/font-matching-runtime-legacy15-calibrated-v2`: immutable interim
  runtime bundle with the calibrator attached
