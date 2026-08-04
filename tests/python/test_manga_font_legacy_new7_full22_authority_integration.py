from __future__ import annotations

import re
import unittest
from pathlib import Path

import numpy as np

from scripts import build_manga_font_legacy_new7_expansion_review_v1 as authority
from scripts import prepare_manga_font_student_v5 as student_v5
from scripts import sweep_manga_font_student_v3_heads as sweep_v3


ROOT = Path(__file__).resolve().parents[2]
AUTHORITY_DIR = (
    ROOT / "artifacts/manga-font-legacy-new7-expansion-full22-authority-first40-v1"
)
REVIEW_DIR = ROOT / "artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"
DRAFT_DIR = (
    ROOT / "artifacts/manga-font-legacy-new7-expansion-visual-draft-first40-v1"
)
LEGACY_OVERLAY_DIR = ROOT / "artifacts/manga-font-legacy15-train-overlay-v1"
CATALOG_REGISTRY = ROOT / "datasets/font-matching-catalog-registry-v2.json"
CACHE_DIR = ROOT / "artifacts/manga-font-student-v3-embedding-cache-legacy727-v2"


@unittest.skipUnless(
    AUTHORITY_DIR.is_dir() and CACHE_DIR.is_dir(),
    "repository-local sealed authority/cache artifacts are unavailable",
)
class LegacyNew7Full22AuthorityIntegrationTest(unittest.TestCase):
    def test_sealed_authority_applies_to_v3_cache_without_mutating_old15(self) -> None:
        examples, validation = authority.load_authority_examples(
            AUTHORITY_DIR,
            review_dir=REVIEW_DIR,
            draft_dir=DRAFT_DIR,
            legacy_overlay_dir=LEGACY_OVERLAY_DIR,
            catalog_registry=CATALOG_REGISTRY,
        )
        self.assertEqual(
            student_v5.validate_upgrade_authority(
                validation,
                expected_new7=authority.NEW7_IDS,
            ),
            40,
        )
        for field in ("base_partial_record_sha256", "legacy15_membership_sha256"):
            self.assertRegex(str(validation[field]), re.compile(r"^[0-9a-f]{64}$"))

        contract, arrays = sweep_v3._load_cache_arrays(CACHE_DIR)  # noqa: SLF001
        untouched = {name: np.array(value, copy=True) for name, value in arrays.items()}
        full22_before = int(np.count_nonzero(arrays["human_train_full22"]))
        upgraded, audit = student_v5.apply_full22_upgrade_examples_to_cache(
            contract=contract,
            arrays=arrays,
            examples=examples,
            candidate_ids=authority.FULL22_IDS,
            authority_validation=validation,
        )

        self.assertEqual(audit["upgraded_record_count"], 40)
        self.assertEqual(audit["old15_positive_tier_mutation_count"], 0)
        self.assertEqual(audit["fabricated_new7_negative_count"], 0)
        self.assertEqual(
            int(np.count_nonzero(upgraded["human_train_full22"])),
            full22_before + 40,
        )
        for name, original in untouched.items():
            np.testing.assert_array_equal(arrays[name], original)


if __name__ == "__main__":
    unittest.main()
