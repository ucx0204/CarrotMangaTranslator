from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load_script():
    path = ROOT / "scripts" / "seal_library_full_pipeline_v11_manual_visual_review.py"
    spec = importlib.util.spec_from_file_location(
        "seal_library_full_pipeline_v11_manual_visual_review_test_target", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SEALER = load_script()


class ManualVisualReviewSealTests(unittest.TestCase):
    def test_verdicts_partition_and_reproduce_fixed_summary(self) -> None:
        SEALER.validate_fixed_review()
        reviews = [
            {"verdict": SEALER.verdict_for_page(page_number)}
            for page_number in range(1, 41)
        ]
        summary = SEALER.aggregate_page_reviews(reviews)
        self.assertEqual(summary["reviewedPages"], 40)
        self.assertEqual(summary["bodyFontQualityJudgedPages"], 30)
        self.assertEqual(
            summary["verdictCounts"],
            {"good": 10, "acceptable": 15, "bad": 5, "notApplicable": 10},
        )
        self.assertEqual(summary["judgedPageRates"]["goodPercent"], 33.33)
        self.assertEqual(summary["judgedPageRates"]["acceptablePercent"], 50.0)
        self.assertEqual(summary["judgedPageRates"]["badPercent"], 16.67)
        self.assertEqual(
            summary["judgedPageRates"]["usableGoodOrAcceptablePercent"], 83.33
        )

    def test_every_page_has_a_fixed_reason(self) -> None:
        reasons = {page: SEALER.reason_for_page(page) for page in range(1, 41)}
        self.assertTrue(all(reasons.values()))
        self.assertEqual(
            {page: reasons[page] for page in SEALER.PAGE_VERDICTS["bad"]},
            SEALER.BAD_PAGE_REASONS,
        )
        for page in SEALER.PAGE_VERDICTS["not_applicable"]:
            self.assertIn("excluded", reasons[page])

    def test_source_distribution_constants_cover_all_blocks(self) -> None:
        self.assertEqual(sum(SEALER.EXPECTED_ROLE_COUNTS.values()), 375)
        self.assertEqual(sum(SEALER.EXPECTED_SELECTED_FONT_COUNTS.values()), 375)
        self.assertEqual(SEALER.EXPECTED_SELECTED_FONT_COUNTS["__not_selected__"], 38)
        self.assertEqual(SEALER.EXPECTED_APPLIED, 337)
        self.assertEqual(SEALER.EXPECTED_SELECTED_FONT_COUNTS["single-day"], 4)
        self.assertEqual(len(SEALER.EXPECTED_SINGLE_DAY_KEYS), 4)

    def test_authority_is_strictly_evaluation_only(self) -> None:
        authority = SEALER.AUTHORITY
        self.assertEqual(authority["mode"], "evaluation_only")
        self.assertIs(authority["evaluation_only"], True)
        for key in (
            "human_gold",
            "training",
            "training_label_authority",
            "calibration",
            "calibration_label_authority",
            "pseudo_labeling",
            "pseudo_label_authority",
            "automatic_label_promotion",
            "release",
            "release_authority",
            "automatic_release_authority",
        ):
            self.assertIs(authority[key], False, key)

    def test_exact_source_hashes_are_fixed(self) -> None:
        self.assertEqual(
            SEALER.EXPECTED_RUN_REPORT["sha256"],
            "61570016f17039e982c05afb066c92bf649a5ac837d3e8254b847b96bb2d11cb",
        )
        self.assertEqual(
            SEALER.EXPECTED_VISUAL_INDEX["sha256"],
            "5155436a1bf25e2e5694c4cc88d1f65092245e6bc80743484e604ef7984593ad",
        )

    def test_content_hash_form_is_json_round_trip_stable(self) -> None:
        payload = {
            "badPages": {
                str(page_number): reason
                for page_number, reason in sorted(SEALER.BAD_PAGE_REASONS.items())
            }
        }
        round_tripped = json.loads(json.dumps(payload))
        self.assertEqual(
            SEALER.sha256_bytes(SEALER.canonical_json_bytes(payload)),
            SEALER.sha256_bytes(SEALER.canonical_json_bytes(round_tripped)),
        )

    def test_exclusive_writer_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "manual-visual-review.json"
            SEALER.write_json_exclusive(output, {"first": True})
            with self.assertRaisesRegex(SEALER.ManualVisualReviewError, "Refusing to overwrite"):
                SEALER.write_json_exclusive(output, {"second": True})
            self.assertIn('"first": true', output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
