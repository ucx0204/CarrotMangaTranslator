from __future__ import annotations

import unittest

import torch

from scripts import analyze_manga_font_student_v6_hybrid as hybrid


class AnalyzeMangaFontStudentV6HybridTest(unittest.TestCase):
    def test_role_route_is_row_independent(self) -> None:
        v3 = torch.tensor([[0.9, 0.1], [0.8, 0.2]])
        v6 = torch.tensor([[0.2, 0.8], [0.1, 0.9]])
        result = hybrid.combine_role_route(
            torch=torch,
            ordinary_mask=torch.tensor([True, False]),
            v3_probabilities=v3,
            v6_probabilities=v6,
        )
        torch.testing.assert_close(result, torch.tensor([[0.9, 0.1], [0.1, 0.9]]))

    def test_global_blend_uses_one_fixed_alpha_for_every_row(self) -> None:
        v3 = torch.tensor([[0.8, 0.2], [0.2, 0.8]])
        v6 = torch.tensor([[0.4, 0.6], [0.6, 0.4]])
        result = hybrid.combine_global_scores(
            torch=torch,
            v3_probabilities=v3,
            v6_probabilities=v6,
            alpha=0.5,
            mode="arithmetic_probability",
        )
        torch.testing.assert_close(result, torch.tensor([[0.6, 0.4], [0.4, 0.6]]))

    def test_alpha_outside_sealed_grid_is_rejected(self) -> None:
        with self.assertRaises(hybrid.MangaFontV6HybridError):
            hybrid.combine_global_scores(
                torch=torch,
                v3_probabilities=torch.ones((1, 2)) / 2,
                v6_probabilities=torch.ones((1, 2)) / 2,
                alpha=0.33,
                mode="arithmetic_probability",
            )


if __name__ == "__main__":
    unittest.main()
