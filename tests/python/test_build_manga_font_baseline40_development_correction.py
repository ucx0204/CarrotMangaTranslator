from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_manga_font_baseline40_development_correction.py"
SPEC = importlib.util.spec_from_file_location("baseline40_development_correction", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class Baseline40DevelopmentCorrectionTests(unittest.TestCase):
    def test_blind_payload_rejects_font_identity(self) -> None:
        MODULE._assert_blind_payload(
            {"review_id": "B40D-001", "options": ["option_a", "option_b"]}
        )
        with self.assertRaises(MODULE.CorrectionError):
            MODULE._assert_blind_payload({"font_id": "ridi-batang"})

    def test_page_alias_order_is_deterministic_and_complete(self) -> None:
        first = MODULE._page_alias_order("source-page-1")
        second = MODULE._page_alias_order("source-page-1")
        self.assertEqual(first, second)
        self.assertEqual(set(first), {"baseline", "candidate"})

    def test_direct_review_validator_is_fail_closed(self) -> None:
        template = [{"review_id": "B40D-001"}]
        valid = [
            {
                "review_id": "B40D-001",
                "preference": "option_a",
                "visual_intent": "normal",
                "consistency_intent": "match_page_body",
                "notes": "direct visual decision",
            }
        ]
        MODULE._validate_review_rows(template, valid)
        invalid = copy.deepcopy(valid)
        invalid[0]["visual_intent"] = "mixed"
        with self.assertRaises(MODULE.CorrectionError):
            MODULE._validate_review_rows(template, invalid)

    def test_candidate_label_validator_rejects_overlap(self) -> None:
        valid = {
            "preferred_candidate_ids": ["font-a"],
            "positive_candidate_ids": ["font-a"],
            "rejected_candidate_ids": ["font-b"],
            "none_acceptable": False,
            "pairwise_only": True,
        }
        MODULE._validate_candidate_labels(valid, "row")
        invalid = copy.deepcopy(valid)
        invalid["rejected_candidate_ids"] = ["font-a"]
        with self.assertRaises(MODULE.CorrectionError):
            MODULE._validate_candidate_labels(invalid, "row")

    def test_pairwise_outcome_is_bound_to_deblinded_pair(self) -> None:
        labels = {
            "positive_candidate_ids": ["candidate-font"],
            "none_acceptable": False,
        }
        self.assertEqual(
            MODULE._expected_pairwise_outcome(
                baseline_font="baseline-font",
                candidate_font="candidate-font",
                labels=labels,
            ),
            "candidate_improvement",
        )
        labels = {"positive_candidate_ids": [], "none_acceptable": True}
        self.assertEqual(
            MODULE._expected_pairwise_outcome(
                baseline_font="baseline-font",
                candidate_font="candidate-font",
                labels=labels,
            ),
            "both_bad",
        )

    def test_seal_record_detects_tampering(self) -> None:
        record = MODULE.seal_record({"schema_version": 1, "value": "sealed"})
        MODULE._validate_seal_record(record, "record")
        record["value"] = "tampered"
        with self.assertRaises(MODULE.CorrectionError):
            MODULE._validate_seal_record(record, "record")


if __name__ == "__main__":
    unittest.main()
