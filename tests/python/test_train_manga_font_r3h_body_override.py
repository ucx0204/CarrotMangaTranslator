from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts import train_manga_font_r3h_body_override as override


class R3hBodyOverrideTests(unittest.TestCase):
    def test_projection_is_deterministic_and_finite(self) -> None:
        first = override.fixed_gaussian_projection(16, 4, seed=7)
        second = override.fixed_gaussian_projection(16, 4, seed=7)
        self.assertTrue(np.array_equal(first, second))
        self.assertTrue(np.isfinite(first).all())
        self.assertTrue(np.allclose(np.linalg.norm(first, axis=0), 1.0))

    def test_percentile_uses_train_empirical_cdf(self) -> None:
        result = override.percentile_score(
            np.asarray([0.0, 1.0, 2.0, 3.0]),
            np.asarray([-1.0, 0.0, 1.5, 3.0, 4.0]),
        )
        np.testing.assert_allclose(result, [0.0, 0.25, 0.5, 1.0, 1.0])

    def test_override_is_strictly_variant_to_body(self) -> None:
        logits = np.asarray([[3.0, 1.0], [1.0, 3.0], [0.0, 2.0]], dtype=np.float32)
        result, changed = override.apply_variant_to_body_override(
            logits,
            np.asarray([1.0, 0.99, 0.99]),
            threshold=0.95,
            maximum_variant_probability=0.90,
        )
        self.assertFalse(changed[0])
        self.assertTrue(changed[1])
        self.assertTrue(changed[2])
        self.assertEqual(0, int(result[0].argmax()))
        self.assertEqual(0, int(result[1].argmax()))
        self.assertEqual(0, int(result[2].argmax()))

    def test_variant_confidence_guard_abstains(self) -> None:
        logits = np.asarray([[0.0, 8.0]], dtype=np.float32)
        result, changed = override.apply_variant_to_body_override(
            logits,
            np.asarray([1.0]),
            threshold=0.5,
            maximum_variant_probability=0.80,
        )
        self.assertFalse(changed[0])
        self.assertTrue(np.array_equal(result, logits))

    def test_precision_first_selection_beats_larger_lower_precision_candidate(self) -> None:
        def record(candidate_id: str, precision: float, true_positive: int) -> dict:
            return {
                "candidate_id": candidate_id,
                "gate_passed": True,
                "operating_point": {
                    "override_metrics": {
                        "covered_work_count": 8,
                        "intentional_variant_retention": 1.0,
                        "macro_work_override_precision": precision,
                        "override_precision": precision,
                        "true_positive": true_positive,
                    },
                    "selection_variant_retention": 0.999,
                    "visual_variant_retention": 0.999,
                },
            }

        selected = override.choose_precision_first_candidate(
            [
                record("sk64-c001-a025", 1.0, 10),
                record("sk64cos-c010-a050", 0.95, 50),
            ]
        )
        self.assertIsNotNone(selected)
        self.assertEqual("sk64-c001-a025", selected["candidate_id"])

    def test_fresh_and_holdout_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for forbidden in (
                "library-full-pipeline-font-qa-v10",
                "fresh-gemma",
                "holdout40",
            ):
                with self.assertRaises(override.BodyOverrideError):
                    override._reject_forbidden_input_path(  # noqa: SLF001
                        root / forbidden, "test"
                    )

    def test_override_metrics_are_work_macro_and_exact(self) -> None:
        metrics = override._override_metrics(  # noqa: SLF001
            direct_override=np.asarray([True, True, True, False]),
            direct_actual=np.asarray([0, 0, 1, 1]),
            direct_eligible=np.asarray([True, True, True, True]),
            direct_work_ids=np.asarray(["a", "a", "b", "b"]),
        )
        self.assertEqual(2, metrics["true_positive"])
        self.assertEqual(1, metrics["false_positive"])
        self.assertAlmostEqual(2 / 3, metrics["override_precision"])
        self.assertAlmostEqual(0.5, metrics["macro_work_override_precision"])
        self.assertAlmostEqual(0.5, metrics["intentional_variant_retention"])

    def test_heldout_override_metrics_distinguish_precision_from_abstention(self) -> None:
        measured = override._heldout_override_metrics(  # noqa: SLF001
            np.asarray([True, True, False, True]),
            np.asarray([0, 1, 0, 0]),
            np.asarray([0, 1, 2, 3]),
        )
        self.assertEqual(2, measured["true_positive"])
        self.assertEqual(1, measured["false_positive"])
        self.assertAlmostEqual(2 / 3, measured["override_precision"])
        self.assertEqual("measured", measured["precision_gate_state"])
        self.assertFalse(override._heldout_precision_passed(measured))  # noqa: SLF001

        neutral = override._heldout_override_metrics(  # noqa: SLF001
            np.asarray([False, False]),
            np.asarray([0, 1]),
            np.asarray([0, 1]),
        )
        self.assertEqual(0, neutral["override_rows"])
        self.assertIsNone(neutral["override_precision"])
        self.assertEqual("neutral_no_override", neutral["precision_gate_state"])
        self.assertTrue(override._heldout_precision_passed(neutral))  # noqa: SLF001

    def test_route_checks_reject_heldout_precision_and_family_regression(self) -> None:
        baseline = {
            "acceptable_at1": 0.70,
            "family_accuracy": 0.98,
            "preferred_at1": 0.60,
            "single_day_body_false_top1_count": 0,
            "single_day_predicted_count": 0,
        }
        candidate = {**baseline, "family_accuracy": 0.97}
        poor_precision = {
            "false_positive": 1,
            "override_precision": 0.5,
            "override_rows": 2,
            "precision_gate_state": "measured",
            "true_positive": 1,
        }
        checks = override._route_checks(  # noqa: SLF001
            baseline,
            baseline,
            candidate,
            candidate,
            poor_precision,
            poor_precision,
        )
        self.assertFalse(checks["all_family_accuracy_non_decreasing"])
        self.assertFalse(
            checks["all_heldout_override_precision_at_least_0_90_or_neutral"]
        )
        self.assertFalse(checks["visual_family_accuracy_non_decreasing"])
        self.assertFalse(
            checks["visual_heldout_override_precision_at_least_0_90_or_neutral"]
        )

    def test_route_checks_accept_neutral_abstention_without_regression(self) -> None:
        metrics = {
            "acceptable_at1": 0.70,
            "family_accuracy": 0.98,
            "preferred_at1": 0.60,
            "single_day_body_false_top1_count": 0,
            "single_day_predicted_count": 0,
        }
        neutral = {
            "false_positive": 0,
            "override_precision": None,
            "override_rows": 0,
            "precision_gate_state": "neutral_no_override",
            "true_positive": 0,
        }
        checks = override._route_checks(  # noqa: SLF001
            metrics,
            metrics,
            metrics,
            metrics,
            neutral,
            neutral,
        )
        self.assertTrue(all(checks.values()))


if __name__ == "__main__":
    unittest.main()
