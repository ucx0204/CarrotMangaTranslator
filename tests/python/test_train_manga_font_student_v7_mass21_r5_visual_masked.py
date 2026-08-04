from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import torch

from scripts import train_manga_font_student_v7_mass21_r5_visual_masked as r5


class MangaFontV7Mass21R5VisualMaskedTests(unittest.TestCase):
    @staticmethod
    def _loss(logits: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        visible = torch.zeros((1, 21), dtype=torch.bool)
        visible[0, :5] = True
        acceptable = torch.zeros_like(visible)
        acceptable[0, 1] = True
        loss, _, _ = r5.masked_visual_review_loss(
            torch,
            logits,
            visible,
            torch.tensor([0]),
            acceptable,
            torch.ones(1),
            denominator=1,
        )
        return loss, visible

    def test_invisible_sixteen_candidates_have_exactly_zero_gradient(self) -> None:
        logits = torch.randn((1, 21), requires_grad=True)
        loss, visible = self._loss(logits)
        loss.backward()
        self.assertEqual(0.0, float(logits.grad[~visible].abs().max()))
        self.assertGreater(float(logits.grad[visible].abs().sum()), 0.0)

    def test_selected_candidate_is_preferred(self) -> None:
        baseline = torch.zeros((1, 21))
        raised = baseline.clone()
        raised[0, 0] = 2.0
        baseline_loss, _ = self._loss(baseline)
        raised_loss, _ = self._loss(raised)
        self.assertLess(float(raised_loss), float(baseline_loss))

    def test_acceptable_candidate_is_auxiliary_positive(self) -> None:
        baseline = torch.zeros((1, 21))
        baseline[0, 0] = 2.0
        raised = baseline.clone()
        raised[0, 1] = 0.5
        baseline_loss, _ = self._loss(baseline)
        raised_loss, _ = self._loss(raised)
        self.assertLess(float(raised_loss), float(baseline_loss))

    def test_cli_defaults_are_conservative_and_oversampling_is_forbidden(self) -> None:
        args = r5.build_parser().parse_args(
            ["train", "--visual-review-overlay-dir", "overlay"]
        )
        r5._validate_cli_configuration(args)
        self.assertEqual(0.25, args.visual_review_weight)
        self.assertEqual(0, args.visual_review_oversampling)
        unsafe = r5.build_parser().parse_args(
            [
                "train",
                "--visual-review-overlay-dir",
                "overlay",
                "--visual-review-oversampling",
                "1",
            ]
        )
        with self.assertRaises(r5.MangaFontV7Mass21R5Error):
            r5._validate_cli_configuration(unsafe)

    def test_runtime_patch_restores_r3_functions(self) -> None:
        original = r5.r3.v7._compute_losses
        with r5._patched_runtime():
            self.assertIs(r5._compute_losses, r5.r3.v7._compute_losses)
        self.assertIs(original, r5.r3.v7._compute_losses)

    def test_epoch_checkpoint_writes_qa_only_safetensors_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = {
                "candidate_ids": [f"font-{index}" for index in range(21)],
                "history": [{"epoch": 1}],
                "model_state": {
                    "weight": torch.zeros((21, 3)),
                    "bias": torch.zeros(21),
                },
                "next_step": 0,
            }
            with (
                mock.patch.object(r5, "_BASE_WRITE_RUN_CHECKPOINT"),
                r5._activated_qa_snapshot_dir(root),
            ):
                r5._write_run_checkpoint(
                    torch=torch, run_state_dir=root / "state", payload=payload
                )
            self.assertTrue((root / "epoch-001-head.safetensors").is_file())


if __name__ == "__main__":
    unittest.main()
