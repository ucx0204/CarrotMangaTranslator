from __future__ import annotations

import copy
import unittest
from pathlib import Path

from scripts import build_manga_font_legacy_new7_all160_authority_v1 as all160
from scripts import build_manga_font_legacy_new7_expansion_review_v1 as legacy
from scripts import train_manga_font_student_v6_fontquery as v6


ROOT = Path(__file__).resolve().parents[2]
REVIEW_DIR = ROOT / "artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"
DRAFT_DIR = ROOT / "artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1"
AUTHORITY_DIR = ROOT / "artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1"
OVERLAY_DIR = ROOT / "artifacts/manga-font-legacy15-train-overlay-v1"
REGISTRY = ROOT / "datasets/font-matching-catalog-registry-v2.json"
CACHE_DIR = ROOT / "artifacts/manga-font-student-v6-patch-cache-v1"


class All160AuthorityTest(unittest.TestCase):
    def test_training_authority_requires_explicit_finalization(self) -> None:
        with self.assertRaisesRegex(all160.All160AuthorityError, "confirm-human-finalization"):
            all160.build_authority(
                review_dir=Path("review"),
                draft_dir=Path("draft"),
                legacy_overlay_dir=Path("overlay"),
                catalog_registry=Path("registry"),
                output_dir=Path("output"),
                confirm_human_finalization=False,
                reviewer="reviewer",
            )

    def test_decision_validator_rejects_legacy15_lock_mutation(self) -> None:
        rows = []
        decisions = []
        for rank in range(1, 161):
            sample_id = f"sample-{rank}"
            membership = f"{rank:064x}"
            rows.append(
                {
                    "sample_id": sample_id,
                    "selection_rank": rank,
                    "legacy15_lock": {"membership_sha256": membership},
                }
            )
            decisions.append(
                {
                    "confidence": "high",
                    "legacy15_membership_sha256": membership,
                    "model_reference_visible": True,
                    "new7_tiers": {
                        candidate_id: "unacceptable" for candidate_id in legacy.NEW7_IDS
                    },
                    "sample_id": sample_id,
                    "selection_rank": rank,
                    "visually_reviewed": True,
                }
            )
        all160._validate_decisions(decisions, rows)  # noqa: SLF001
        tampered = copy.deepcopy(decisions)
        tampered[0]["legacy15_membership_sha256"] = "0" * 64
        with self.assertRaisesRegex(all160.All160AuthorityError, "boundary drifted"):
            all160._validate_decisions(tampered, rows)  # noqa: SLF001

    @unittest.skipUnless(
        all(path.exists() for path in (REVIEW_DIR, DRAFT_DIR, AUTHORITY_DIR, OVERLAY_DIR, REGISTRY)),
        "sealed all160 artifacts unavailable",
    )
    def test_published_authority_is_exact_complete_train_only_full22(self) -> None:
        validation = all160.validate_authority(
            AUTHORITY_DIR,
            review_dir=REVIEW_DIR,
            draft_dir=DRAFT_DIR,
            legacy_overlay_dir=OVERLAY_DIR,
            catalog_registry=REGISTRY,
        )
        self.assertEqual(validation["upgraded_record_count"], 160)
        self.assertEqual(validation["new7_visual_judgment_record_count"], 160)
        self.assertEqual(validation["full22_train_rows_after_apply"], 269)
        for name in (
            "old15_membership_mutation_count",
            "fabricated_new7_negative_count",
            "test_overlap_count",
            "val_overlap_count",
            "fresh64_overlap_count",
            "qa40_overlap_count",
        ):
            self.assertEqual(validation[name], 0)

        examples, dispatched = legacy.load_authority_examples(
            AUTHORITY_DIR,
            review_dir=REVIEW_DIR,
            draft_dir=DRAFT_DIR,
            legacy_overlay_dir=OVERLAY_DIR,
            catalog_registry=REGISTRY,
        )
        self.assertEqual(len(examples), 160)
        self.assertEqual(dispatched["upgraded_record_count"], 160)
        self.assertTrue(all(example.split == "train" for example in examples))
        self.assertTrue(
            all(
                set(example.row["font_judgment"]["not_reviewed"]) == set()
                for example in examples
            )
        )

    @unittest.skipUnless(AUTHORITY_DIR.exists() and CACHE_DIR.exists(), "sealed cache unavailable")
    def test_all160_is_disjoint_from_original_strict_full22_train109(self) -> None:
        cache_contract, _arrays = v6._load_cache(CACHE_DIR)  # noqa: SLF001
        cached_ids = {
            str(row["sample_id"]) for row in cache_contract.get("human_train", ())
        }
        examples, _validation = legacy.load_authority_examples(
            AUTHORITY_DIR,
            review_dir=REVIEW_DIR,
            draft_dir=DRAFT_DIR,
            legacy_overlay_dir=OVERLAY_DIR,
            catalog_registry=REGISTRY,
        )
        authority_ids = {example.sample_id for example in examples}
        self.assertEqual(len(cached_ids), 109)
        self.assertEqual(len(authority_ids), 160)
        self.assertFalse(cached_ids & authority_ids)
        self.assertEqual(len(cached_ids | authority_ids), 269)


if __name__ == "__main__":
    unittest.main()
