import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts import ablate_manga_font_v2_candidate_score_ensembles as ablation


class CandidateScoreEnsembleAblationTest(unittest.TestCase):
    def test_route_keeps_family_fixed_and_masks_single_day_like_typescript(self) -> None:
        body = np.asarray([[0.0, 9.0, 1.0], [0.0, 1.0, 2.0]], dtype=np.float32)
        variant = np.asarray([[0.0, 9.0, 1.0], [0.0, 1.0, 3.0]], dtype=np.float32)
        family = np.asarray([[8.0, 0.0], [0.0, 8.0]], dtype=np.float32)
        routed = ablation.production_route(
            body_scores=body,
            variant_scores=variant,
            family_logits=family,
            single_day_index=1,
        )
        self.assertEqual(routed["predicted_family"].tolist(), [0, 1])
        self.assertEqual(routed["single_day_allowed"].tolist(), [False, False])
        self.assertLess(routed["deployed_scores"][0, 1], 0.0)
        self.assertLess(routed["deployed_scores"][1, 1], 0.0)

    def test_variant_single_day_requires_confidence_and_ln2_margin(self) -> None:
        scores = np.asarray([[0.0, math.log(2.0) + 0.01, 0.0]], dtype=np.float32)
        family = np.asarray([[0.0, 2.0]], dtype=np.float32)
        routed = ablation.production_route(
            body_scores=scores,
            variant_scores=scores,
            family_logits=family,
            single_day_index=1,
        )
        self.assertTrue(bool(routed["single_day_allowed"][0]))
        self.assertEqual(int(routed["deployed_scores"].argmax(axis=1)[0]), 1)

    def test_blends_are_fixed_and_bounded(self) -> None:
        anchor = np.asarray([[4.0, 0.0]], dtype=np.float32)
        other = np.asarray([[0.0, 4.0]], dtype=np.float32)
        blended = ablation.convex_probability_blend(anchor, other, 0.15)
        self.assertEqual(int(blended.argmax(axis=1)[0]), 0)
        with self.assertRaises(ablation.ScoreAblationError):
            ablation.convex_probability_blend(anchor, other, 0.5)

    def test_metrics_report_top3_and_single_day_without_selection(self) -> None:
        scores = np.asarray([[3.0, 2.0, 1.0], [1.0, 2.0, 3.0]], dtype=np.float32)
        routed = {
            "deployed_scores": scores,
            "predicted_family": np.asarray([0, 1], dtype=np.int8),
            "single_day_allowed": np.asarray([False, True]),
        }
        metrics = ablation.cohort_metrics(
            routed=routed,
            family_labels=np.asarray([0, 1], dtype=np.int8),
            positive_mask=np.asarray([[False, True, False], [False, True, False]]),
            preferred_mask=np.asarray([[False, True, False], [False, True, False]]),
            font_supervision_weights=np.ones(2, dtype=np.float32),
            single_day_body_negative=np.asarray([True, False]),
            single_day_index=2,
        )
        self.assertEqual(metrics["acceptable_at1"], 0.0)
        self.assertEqual(metrics["acceptable_hit_at3"], 1.0)
        self.assertEqual(metrics["family_accuracy"], 1.0)
        self.assertEqual(metrics["single_day_predicted_count"], 1)

    def test_val33_identity_resolver_reads_no_model_scores(self) -> None:
        sample_ids = np.asarray([f"id-{index}" for index in range(33)])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "finals.jsonl"
            path.write_text(
                "".join(
                    json.dumps({"sample_id": value, "font_judgment": {}}) + "\n"
                    for value in sample_ids.tolist()
                ),
                encoding="utf-8",
            )
            resolved = ablation.val33_indices(sample_ids, path)
        np.testing.assert_array_equal(resolved, np.arange(33))


if __name__ == "__main__":
    unittest.main()
