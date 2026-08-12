from __future__ import annotations

import unittest

import numpy as np
import torch

from scripts import train_manga_font_student_v82_token_attention_adapter as v82


class MangaFontV82TokenAttentionAdapterTests(unittest.TestCase):
    def test_fixed_projection_is_reproducible_and_orthogonal(self) -> None:
        first = v82.deterministic_orthogonal_projection(64, 16, 123)
        second = v82.deterministic_orthogonal_projection(64, 16, 123)

        np.testing.assert_array_equal(first, second)
        np.testing.assert_allclose(
            first.T @ first, np.eye(16, dtype=np.float32), atol=2e-5
        )

    def test_fixed_sketch_module_is_zero_initialized_and_bounded(self) -> None:
        model = v82.build_token_attention_residual(
            torch,
            candidate_count=3,
            input_mode="fixed_sketch",
            rank=16,
            attention_queries=2,
            hidden_dim=24,
            dropout=0.0,
            maximum_candidate_residual=0.4,
            maximum_family_residual=0.3,
        )
        tokens = torch.randn(2, 3, 196, 16)

        initial = model(tokens)
        self.assertEqual((2, 2, 3), tuple(initial["candidate_residual"].shape))
        self.assertEqual((2, 2), tuple(initial["family_residual"].shape))
        self.assertEqual((2, 3, 2, 196), tuple(initial["attention"].shape))
        self.assertTrue(torch.equal(initial["candidate_residual"], torch.zeros(2, 2, 3)))
        self.assertTrue(torch.equal(initial["family_residual"], torch.zeros(2, 2)))

        with torch.no_grad():
            model.candidate_head.bias.fill_(100.0)
            model.family_head.bias.fill_(-100.0)
        bounded = model(tokens)
        self.assertLessEqual(
            float(bounded["candidate_residual"].detach().abs().max()), 0.400001
        )
        self.assertLessEqual(
            float(bounded["family_residual"].detach().abs().max()), 0.300001
        )

    def test_trainable_raw_adds_only_low_rank_projection(self) -> None:
        fixed = v82.build_token_attention_residual(
            torch,
            candidate_count=2,
            input_mode="fixed_sketch",
            rank=16,
            attention_queries=2,
            hidden_dim=24,
            dropout=0.1,
            maximum_candidate_residual=0.5,
            maximum_family_residual=0.5,
        )
        raw = v82.build_token_attention_residual(
            torch,
            candidate_count=2,
            input_mode="trainable_raw",
            rank=16,
            attention_queries=2,
            hidden_dim=24,
            dropout=0.1,
            maximum_candidate_residual=0.5,
            maximum_family_residual=0.5,
        )
        raw_count = sum(value.numel() for value in raw.parameters())
        fixed_count = sum(value.numel() for value in fixed.parameters())

        self.assertEqual(
            v82.RAW_DIM * 16 + 2 * (v82.RAW_DIM - 16),
            raw_count - fixed_count,
        )
        output = raw(torch.randn(1, 3, 196, v82.RAW_DIM))
        self.assertEqual((1, 2, 2), tuple(output["candidate_residual"].shape))

    def test_composite_keeps_base_and_exposes_residual_for_regularization(self) -> None:
        base_outputs = {
            "body_candidate_scores": torch.ones(2, 3),
            "variant_candidate_scores": torch.full((2, 3), 2.0),
            "family_logits": torch.zeros(2, 2),
        }
        residual = {
            "candidate_residual": torch.full((2, 2, 3), 0.25),
            "family_residual": torch.full((2, 2), -0.1),
        }

        combined = v82.combine_with_base(base_outputs, residual)

        self.assertTrue(
            torch.equal(combined["body_candidate_scores"], torch.full((2, 3), 1.25))
        )
        self.assertTrue(
            torch.equal(combined["variant_candidate_scores"], torch.full((2, 3), 2.25))
        )
        self.assertIs(combined["sample_candidate_residual"], residual["candidate_residual"])


if __name__ == "__main__":
    unittest.main()
