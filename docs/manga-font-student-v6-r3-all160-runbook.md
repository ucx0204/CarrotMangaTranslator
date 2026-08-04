# MangaFont v6 r3 all160 bounded runbook

Status: blocked on the remaining 120 completed visual judgments. Only the
sealed first40 authority exists today. Do not synthesize or pseudo-promote the
missing labels.

## Immutable input gate

The r3 trainer must call
`build_manga_font_legacy_new7_expansion_review_v1.load_authority_examples`
before opening pixels and require all of the following:

- `upgraded_record_count == 160`
- `new7_visual_judgment_record_count == 160`
- `completed_human_visual_provenance == true`
- `old15_membership_mutation_count == 0`
- `fabricated_new7_negative_count == 0`
- `test_overlap_count == fresh64_overlap_count == qa40_overlap_count == val_overlap_count == 0`
- all 160 identities are train-only, complete-full22, distinct from the strict
  full22 109, producing exactly 269 real full22 train rows

If any check fails, exit before loading SigLIP2 or opening any image.

## Minimal continuation

Keep r1 and r2 source/artifacts immutable. Create a separate
`train_manga_font_student_v6_fontquery_r3.py` schema by copying only the r2
authority-append/training boundary and changing:

- expected authority rows: `40 -> 160`
- expected complete-full22 train rows: `149 -> 269`
- schema/owner/marker: `r2-first40 -> r3-all160`
- output must be new and must never replace r1/r2
- train trials remain 4 queries x 256 dimensions; center the bounded grid on
  the r2 winner and include one r2 warm start
- evaluate/early-stop on val33 only; do not deserialize/open test30, fresh64,
  or any library QA cohort
- strict target: variant preferred@1 >= 0.50, global preferred@1 >= 0.45,
  acceptable@1 >= 0.60, variant acceptable@1 >= 0.60, unique top1 >= 4,
  max top1 share <= 0.55

The r3 cache may reuse the sealed r1 synthetic/reference/val patch arrays. It
must encode the 160 authority train rows with the same pinned base SigLIP2
encoder and append them to the original 109 full22 rows. Re-encoding first40
is allowed and avoids depending on an unsealed intermediate cache.

## Exact command after all160 authority exists

```powershell
python scripts/train_manga_font_student_v6_fontquery_r3.py train `
  --cache-dir artifacts/manga-font-student-v6-patch-cache-v1 `
  --r2-output-dir artifacts/manga-font-student-v6-fontquery-r2-first40-v1 `
  --authority-dir artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1 `
  --review-dir artifacts/manga-font-legacy-new7-expansion-review-variant160-v1 `
  --draft-dir artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1 `
  --legacy-overlay-dir artifacts/manga-font-legacy15-train-overlay-v1 `
  --catalog-registry datasets/font-matching-catalog-registry-v2.json `
  --output-dir artifacts/manga-font-student-v6-fontquery-r3-all160-v1 `
  --epochs 14 --patience 4 --synthetic-batch-size 40 `
  --human-batch-size 24 --encode-batch-size 20 --seed 20260803
```

The future validator must be separate and permanent:

```powershell
python scripts/train_manga_font_student_v6_fontquery_r3.py validate `
  --output-dir artifacts/manga-font-student-v6-fontquery-r3-all160-v1
```

Do not run either command until the all160 draft and authority paths exist and
their authority validator passes.
