from __future__ import annotations

import argparse
import unittest

from scripts import select_manga_font_v2_r10_conservative_sweep as sweep


def metrics(**changes: float | int) -> dict[str, float | int]:
    result: dict[str, float | int] = {
        "acceptable_at1": 0.68,
        "family_accuracy": 0.98,
        "preferred_at1": 0.60,
        "single_day_body_false_top1_count": 0,
        "single_day_positive_precision": 0.0,
        "single_day_predicted_count": 0,
        "top1_max_candidate_share": 0.51,
    }
    result.update(changes)
    return result


class ConservativeR10SweepTests(unittest.TestCase):
    def test_target_parser_accepts_only_precommitted_ids(self) -> None:
        trial_id, path = sweep.parse_target("full-uniform-e1=artifact")
        self.assertEqual("full-uniform-e1", trial_id)
        self.assertEqual("artifact", str(path))
        with self.assertRaises(argparse.ArgumentTypeError):
            sweep.parse_target("surprise=artifact")

    def test_gate_rejects_new_single_day_prediction(self) -> None:
        baseline = metrics()
        checks = sweep.quality_gate_checks(
            metrics(single_day_predicted_count=1, single_day_positive_precision=1.0),
            metrics(),
            baseline,
            baseline,
        )
        self.assertFalse(checks["all_single_day_no_new_predictions"])

    def test_gate_is_relative_to_r3h_not_only_absolute_thresholds(self) -> None:
        baseline = metrics()
        checks = sweep.quality_gate_checks(
            metrics(acceptable_at1=0.67), metrics(), baseline, baseline
        )
        self.assertFalse(checks["all_acceptable_retained"])

    def test_candidate_requires_gain_and_ties_choose_lower_alpha(self) -> None:
        all_metrics = metrics()
        visual_metrics = metrics()
        baseline_score = sweep.selection_score(all_metrics, visual_metrics)
        records = [
            {
                "all_metrics": all_metrics,
                "alpha": 0.0,
                "quality_gate_passed": True,
                "selection_score": baseline_score,
                "trial_id": "r3h-baseline",
                "trial_order": 0,
                "visual_metrics": visual_metrics,
            },
            {
                "all_metrics": all_metrics,
                "alpha": 0.20,
                "quality_gate_passed": True,
                "selection_score": baseline_score + 0.001,
                "trial_id": "full-uniform-e1",
                "trial_order": 1,
                "visual_metrics": visual_metrics,
            },
            {
                "all_metrics": all_metrics,
                "alpha": 0.10,
                "quality_gate_passed": True,
                "selection_score": baseline_score + 0.001,
                "trial_id": "full-uniform-e1",
                "trial_order": 1,
                "visual_metrics": visual_metrics,
            },
        ]
        selected = sweep.choose_candidate(records, baseline_score=baseline_score)
        self.assertEqual(0.10, selected["alpha"])

    def test_no_gain_falls_back_to_sealed_r3h(self) -> None:
        all_metrics = metrics()
        visual_metrics = metrics()
        baseline_score = sweep.selection_score(all_metrics, visual_metrics)
        records = [
            {
                "all_metrics": all_metrics,
                "alpha": 0.0,
                "quality_gate_passed": True,
                "selection_score": baseline_score,
                "trial_id": "r3h-baseline",
                "trial_order": 0,
                "visual_metrics": visual_metrics,
            },
            {
                "all_metrics": all_metrics,
                "alpha": 0.10,
                "quality_gate_passed": True,
                "selection_score": baseline_score + 0.0001,
                "trial_id": "full-human2-e1",
                "trial_order": 3,
                "visual_metrics": visual_metrics,
            },
        ]
        selected = sweep.choose_candidate(records, baseline_score=baseline_score)
        self.assertEqual("r3h-baseline", selected["trial_id"])


if __name__ == "__main__":
    unittest.main()
