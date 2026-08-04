from __future__ import annotations

import unittest

import torch

from scripts import sweep_manga_font_student_v4_role_experts as sweep
from scripts import train_manga_font_student_v1 as base
from scripts import train_manga_font_student_v3 as v3


class SweepMangaFontStudentV4RoleExpertsTest(unittest.TestCase):
    def test_role_families_are_complete_and_one_hot(self) -> None:
        matrix = sweep.role_family_matrix(torch)
        self.assertEqual(tuple(matrix.shape), (len(base.ROLE_VALUES), 4))
        torch.testing.assert_close(matrix.sum(dim=1), torch.ones(len(base.ROLE_VALUES)))
        self.assertEqual(
            sweep.FAMILY_NAMES[sweep.role_family_index("sfx_impact")], "sfx"
        )
        self.assertEqual(
            sweep.FAMILY_NAMES[sweep.role_family_index("dialogue")], "ordinary"
        )

    def test_trial_grid_covers_requested_source_and_partial_levels(self) -> None:
        grid = sweep._trial_grid(8)  # noqa: SLF001
        self.assertEqual(len(grid), 8)
        self.assertEqual({row["full22_fraction"] for row in grid}, {0.75, 0.85})
        self.assertEqual({row["partial_row_weight"] for row in grid}, {0.10, 0.25})
        with self.assertRaisesRegex(sweep.MangaFontV4SweepError, "4..8"):
            sweep._trial_grid(9)  # noqa: SLF001

    def test_source_ratio_sampler_matches_75_and_85_percent(self) -> None:
        mask = torch.tensor([True, True, False, False])
        for fraction, expected in ((0.75, 24), (0.85, 27)):
            indices = sweep.source_ratio_indices(
                torch,
                full22_mask=mask,
                batch_size=32,
                full22_fraction=fraction,
                generator=torch.Generator().manual_seed(8),
            )
            self.assertEqual(int(mask[indices].sum()), expected)

    def test_role_expert_is_bias_free_and_preserves_prototype_score(self) -> None:
        torch.manual_seed(5)
        base_ranker = v3.build_runtime_ranker_v3(
            torch, candidate_count=3, dropout=0.0, residual_scale=0.5
        )
        anchors = torch.randn(3, base.PROJECTION_DIM)
        ranker = sweep.build_role_expert_ranker(
            torch,
            base_ranker=base_ranker,
            candidate_count=3,
            expert_scale=0.5,
            initial_candidate_proxies=anchors,
            role_temperature=1.0,
        )
        views = torch.randn(2, 3, base.PROJECTION_DIM)
        prototypes = torch.randn(6, base.PROJECTION_DIM)
        bags = (torch.tensor([0, 1]), torch.tensor([2, 3]), torch.tensor([4, 5]))
        ranker.eval()
        before = ranker(views, prototypes, bags)
        torch.testing.assert_close(
            before["candidate_scores"],
            base_ranker(views, prototypes, bags)["candidate_scores"]
            + before["role_expert_scores"],
        )
        with torch.no_grad():
            ranker.role_expert_vectors.add_(0.2 * torch.randn_like(ranker.role_expert_vectors))
        after = ranker(views, prototypes, bags)
        torch.testing.assert_close(
            after["prototype_candidate_scores"],
            before["prototype_candidate_scores"],
            rtol=0.0,
            atol=0.0,
        )
        self.assertIsNone(ranker.base_ranker.candidate_residual.bias)
        self.assertFalse(any("bias" in name for name, _ in ranker.named_parameters() if "expert" in name))

    def test_target_gate_requires_both_global_and_variant_targets(self) -> None:
        passed = sweep.target_gate(
            {"preferred_at1": 0.46, "variant_preferred_at1": 0.51}
        )
        failed = sweep.target_gate(
            {"preferred_at1": 0.46, "variant_preferred_at1": 0.49}
        )
        self.assertTrue(passed["passed"])
        self.assertFalse(failed["passed"])


if __name__ == "__main__":
    unittest.main()
