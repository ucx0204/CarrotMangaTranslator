from __future__ import annotations

import copy
import unittest

import numpy as np

from scripts import ablate_manga_font_v2_targeted_correction as correction


class TargetedCorrectionTest(unittest.TestCase):
    @staticmethod
    def arrays() -> dict[str, np.ndarray]:
        return {
            "sample_ids": np.asarray(["hv-a", "old", "val33"], dtype="U8"),
            "split": np.asarray([0, 0, 1], dtype=np.int64),
            "font_authority": np.asarray(["human", "visual", "human"], dtype="U8"),
            "font_supervision_weights": np.asarray([1.0, 1.0, 1.0], dtype=np.float32),
        }

    @staticmethod
    def label_manifest() -> dict:
        return {
            "authority": {
                "automatic_label_promotion_allowed": False,
                "automatic_release_authority": False,
                "calibration_eligible": False,
                "evaluation_eligible": False,
                "human_gold": False,
                "review_authority": "codex_agent_direct_visual_supervision",
                "training_eligible": True,
                "training_only": True,
            },
            "counts": {"training_label_rows": 1},
            "overlap": {key: 0 for key in correction.EXPECTED_OVERLAP_KEYS},
        }

    @staticmethod
    def dataset_manifest() -> dict:
        return {
            "authority": {
                "automatic_release_authority": False,
                "human_gold": False,
                "npz_authority_encoding": "human_for_weighting_compatibility_only",
                "review_authority": "codex_agent_direct_visual_supervision",
                "training_only": True,
            },
            "counts": {"high_value_overlay_rows": 1},
            "split_policy": {
                "test_rows_exported": 0,
                "train_only_overlay": True,
                "validation_rows_modified": 0,
            },
        }

    def test_boundary_accepts_exact_train_only_identity(self) -> None:
        result = correction.validate_high_value_boundary(
            self.arrays(),
            label_ids=("hv-a",),
            label_manifest=self.label_manifest(),
            dataset_manifest=self.dataset_manifest(),
            val33_ids=("val33",),
        )
        self.assertEqual(result["high_value_rows"], 1)
        self.assertEqual(result["high_value_positions"].tolist(), [0])

    def test_boundary_rejects_any_sealed_overlap(self) -> None:
        manifest = self.label_manifest()
        manifest["overlap"]["qa_pages"] = 1
        with self.assertRaises(correction.TargetedCorrectionError):
            correction.validate_high_value_boundary(
                self.arrays(),
                label_ids=("hv-a",),
                label_manifest=manifest,
                dataset_manifest=self.dataset_manifest(),
                val33_ids=("val33",),
            )

    def test_boundary_rejects_val_or_val33_identity(self) -> None:
        manifest = self.label_manifest()
        with self.assertRaises(correction.TargetedCorrectionError):
            correction.validate_high_value_boundary(
                self.arrays(),
                label_ids=("val33",),
                label_manifest=manifest,
                dataset_manifest=self.dataset_manifest(),
                val33_ids=("val33",),
            )

    def test_anchor_is_zero_for_teacher_identity_and_positive_for_drift(self) -> None:
        import torch

        teacher = {
            "body_candidate_scores": torch.tensor([[1.0, 0.0]]),
            "variant_candidate_scores": torch.tensor([[0.0, 1.0]]),
            "family_logits": torch.tensor([[1.0, -1.0]]),
        }
        zero, _ = correction.anchor_distillation_loss(torch, teacher, teacher)
        self.assertAlmostEqual(float(zero), 0.0, places=7)
        student = copy.deepcopy(teacher)
        student["body_candidate_scores"] = student["body_candidate_scores"] + 1.0
        drift, _ = correction.anchor_distillation_loss(torch, student, teacher)
        self.assertGreater(float(drift), 0.0)

    def test_selection_score_has_no_high_value_or_val33_input(self) -> None:
        all_metrics = {
            "acceptable_at1": 0.7,
            "preferred_at1": 0.6,
            "family_accuracy": 0.9,
        }
        visual = {"acceptable_at1": 0.65, "preferred_at1": 0.55}
        self.assertAlmostEqual(correction.selection_score(all_metrics, visual), 0.655)


if __name__ == "__main__":
    unittest.main()
