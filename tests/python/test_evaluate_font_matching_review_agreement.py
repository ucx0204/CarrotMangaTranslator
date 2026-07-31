from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "evaluate_font_matching_review_agreement.py"
SPEC = importlib.util.spec_from_file_location("review_agreement", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT}")
AGREEMENT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = AGREEMENT
SPEC.loader.exec_module(AGREEMENT)


CANDIDATES = ("font-a", "font-b", "font-c", "font-d")


def review(
    sample_id: str,
    work_id: str,
    stage: str,
    reviewer: str,
    *,
    role: str = "dialogue",
    preferred: tuple[str, ...] = ("font-a",),
    acceptable: tuple[str, ...] = ("font-b",),
    marginal: tuple[str, ...] = ("font-c",),
) -> dict:
    judged = set(preferred) | set(acceptable) | set(marginal)
    return {
        "sample_id": sample_id,
        "work_id": work_id,
        "role": {"primary": role},
        "font_judgment": {
            "preferred": list(preferred),
            "acceptable": list(acceptable),
            "marginal": list(marginal),
            "unacceptable": [item for item in CANDIDATES if item not in judged],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": not preferred and not acceptable,
        },
        "review": {"stage": stage, "reviewer": reviewer},
    }


class ReviewAgreementTest(unittest.TestCase):
    def test_perfect_agreement_passes_all_frozen_gates(self) -> None:
        rows = []
        for index in range(4):
            sample_id = f"sample-{index}"
            work_id = f"work-{index % 2}"
            rows.extend(
                [
                    review(sample_id, work_id, "primary", f"p-{index}"),
                    review(sample_id, work_id, "secondary", f"s-{index}"),
                ]
            )
        report = AGREEMENT.evaluate_agreement(rows)
        self.assertTrue(report["all_gates_pass"])
        self.assertEqual(1.0, report["overall"]["role_macro_f1"])
        self.assertEqual(1.0, report["overall"]["tier_pairwise_agreement"])
        self.assertEqual(1.0, report["overall"]["acceptable_set_jaccard"])
        self.assertEqual(2, report["work_count"])

    def test_ties_order_reversal_and_safe_set_disagreement_are_distinct(self) -> None:
        primary = review("sample", "work", "primary", "reviewer-a")
        secondary = review(
            "sample",
            "work",
            "secondary",
            "reviewer-b",
            preferred=("font-b",),
            acceptable=("font-a", "font-c"),
            marginal=(),
        )
        report = AGREEMENT.evaluate_agreement([primary, secondary])
        self.assertFalse(report["all_gates_pass"])
        self.assertEqual(1.0, report["overall"]["role_macro_f1"])
        self.assertLess(report["overall"]["tier_pairwise_agreement"], 1.0)
        self.assertEqual(2 / 3, report["overall"]["acceptable_set_jaccard"])

    def test_skipped_candidates_are_excluded_from_pairwise_comparison(self) -> None:
        primary = review("sample", "work", "primary", "reviewer-a")
        secondary = review("sample", "work", "secondary", "reviewer-b")
        secondary["font_judgment"]["unacceptable"].remove("font-d")
        secondary["font_judgment"]["unrenderable"] = ["font-d"]
        report = AGREEMENT.evaluate_agreement([primary, secondary])
        self.assertEqual(3, report["overall"]["tier_pair_count"])
        self.assertEqual(1.0, report["overall"]["tier_pairwise_agreement"])

    def test_role_macro_f1_penalizes_rare_role_disagreement(self) -> None:
        rows = [
            review("a", "work", "primary", "p-a", role="dialogue"),
            review("a", "work", "secondary", "s-a", role="dialogue"),
            review("b", "work", "primary", "p-b", role="sfx_impact"),
            review("b", "work", "secondary", "s-b", role="dialogue"),
        ]
        report = AGREEMENT.evaluate_agreement(rows)
        self.assertAlmostEqual(1 / 3, report["overall"]["role_macro_f1"])
        self.assertFalse(report["gates"]["role_macro_f1"])

    def test_duplicate_stage_and_same_reviewer_are_rejected(self) -> None:
        primary = review("sample", "work", "primary", "same")
        with self.assertRaisesRegex(AGREEMENT.AgreementError, "duplicate primary"):
            AGREEMENT.evaluate_agreement([primary, primary])
        secondary = review("sample", "work", "secondary", "same")
        with self.assertRaisesRegex(AGREEMENT.AgreementError, "not independent"):
            AGREEMENT.evaluate_agreement([primary, secondary])

    def test_cli_require_gates_returns_two_for_valid_but_failing_report(self) -> None:
        rows = [
            review("sample", "work", "primary", "reviewer-a", role="dialogue"),
            review("sample", "work", "secondary", "reviewer-b", role="thought"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            reviews = Path(temporary) / "reviews.jsonl"
            output = Path(temporary) / "report.json"
            reviews.write_text(
                "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
            )
            self.assertEqual(
                2,
                AGREEMENT.main(
                    [
                        "--reviews",
                        str(reviews),
                        "--output",
                        str(output),
                        "--require-gates",
                    ]
                ),
            )
            self.assertFalse(json.loads(output.read_text())["all_gates_pass"])


if __name__ == "__main__":
    unittest.main()
