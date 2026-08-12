import unittest

import numpy as np

from scripts import ablate_manga_font_student_v82_residual_scales as module


class MangaFontV82ResidualScaleAblationTests(unittest.TestCase):
    def test_candidate_and_family_scales_are_independent(self) -> None:
        body = np.zeros((2, 3), dtype=np.float32)
        variant = np.ones((2, 3), dtype=np.float32)
        family = np.zeros((2, 2), dtype=np.float32)
        candidate = np.full((2, 2, 3), 2.0, dtype=np.float32)
        family_residual = np.full((2, 2), 4.0, dtype=np.float32)
        output = module.scaled_outputs(
            body_scores=body,
            variant_scores=variant,
            family_logits=family,
            candidate_residual=candidate,
            family_residual=family_residual,
            candidate_alpha=0.25,
            family_alpha=0.5,
        )
        np.testing.assert_allclose(output["body_candidate_scores"], 0.5)
        np.testing.assert_allclose(output["variant_candidate_scores"], 1.5)
        np.testing.assert_allclose(output["family_logits"], 2.0)

    def test_alpha_grid_is_bounded_and_unique(self) -> None:
        self.assertEqual(module.parse_alpha_grid("0,.25,1.25"), (0.0, 0.25, 1.25))
        for invalid in ("", "0,.25,.25", "-1,0", "0,1.5", "x"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(module.ResidualScaleAblationError):
                    module.parse_alpha_grid(invalid)

    def test_selection_is_val33_blind_and_requires_gate_pass(self) -> None:
        def record(passed: bool, acceptable: float, preferred: float):
            return {
                "base_mode": "r3h",
                "candidate_residual_alpha": 0.0,
                "family_residual_alpha": 0.0,
                "quality_passed": passed,
                "visual_metrics": {
                    "acceptable_at1": acceptable,
                    "preferred_at1": preferred,
                    "top1_max_candidate_share": 0.5,
                },
                "r3_holdout_metrics": {
                    "family_accuracy": 0.9,
                    "single_day_all_top1_rate": 0.0,
                },
            }

        winner = module.select_r3_winner(
            [record(False, 0.99, 0.99), record(True, 0.66, 0.57)]
        )
        self.assertTrue(winner["quality_passed"])
        leaking = record(True, 0.7, 0.6)
        leaking["val33_diagnostic_after_selection"] = {}
        with self.assertRaises(module.ResidualScaleAblationError):
            module.select_r3_winner([leaking])


if __name__ == "__main__":
    unittest.main()
