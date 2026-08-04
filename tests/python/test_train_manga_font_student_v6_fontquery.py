from __future__ import annotations

import unittest
from types import MappingProxyType

import torch

from scripts import train_manga_font_student_v1 as base
from scripts import train_manga_font_student_v6_fontquery as trainer


class TrainMangaFontStudentV6FontQueryTest(unittest.TestCase):
    def test_font_queries_pool_patch_tokens_and_score_reference_candidates(
        self,
    ) -> None:
        torch.manual_seed(3)
        model = trainer.build_font_query_head(
            torch, query_count=4, query_dim=128, hidden_size=12
        )
        views = torch.randn(2, 3, 7, 12)
        references = torch.randn(6, 7, 12)
        labels = torch.tensor([0, 0, 1, 1, 2, 2])
        result = model(views, references, labels, 3)
        self.assertEqual(result["candidate_scores"].shape, (2, 3))
        self.assertEqual(result["attention"].shape, (2, 3, 4, 7))
        self.assertEqual(result["candidate_prototypes"].shape, (3, 4, 128))
        torch.testing.assert_close(
            result["attention"].sum(dim=-1), torch.ones((2, 3, 4))
        )

    def test_candidate_scorer_has_no_candidate_bias_parameter(self) -> None:
        model = trainer.build_font_query_head(
            torch, query_count=2, query_dim=128, hidden_size=8
        )
        names = set(dict(model.named_parameters()))
        self.assertFalse(any("candidate" in name and "bias" in name for name in names))

    def test_view_invariance_is_zero_for_identical_normalized_views(self) -> None:
        values = torch.nn.functional.normalize(torch.randn(3, 2, 5), dim=-1)
        views = values[:, None].repeat(1, len(base.VIEW_NAMES), 1, 1)
        self.assertAlmostEqual(
            float(trainer.view_invariance_loss(torch, views)), 0.0, places=6
        )

    def test_attention_diversity_penalizes_identical_queries(self) -> None:
        identical = torch.tensor([[[[1.0, 0.0], [1.0, 0.0]]]])
        distinct = torch.tensor([[[[1.0, 0.0], [0.0, 1.0]]]])
        self.assertGreater(
            float(trainer.attention_diversity_loss(torch, identical)),
            float(trainer.attention_diversity_loss(torch, distinct)),
        )

    def test_research_gate_requires_global_variant_and_diversity(self) -> None:
        passing = {
            "acceptable_at1": 0.61,
            "preferred_at1": 0.46,
            "top1_max_candidate_share": 0.40,
            "top1_unique_candidate_count": 8,
            "variant_acceptable_at1": 0.61,
            "variant_preferred_at1": 0.51,
        }
        self.assertTrue(trainer.research_gate(passing)["passed"])
        failing = dict(passing, variant_preferred_at1=0.49)
        self.assertFalse(trainer.research_gate(failing)["passed"])

    def test_complete_full22_train_rows_rejects_partial_and_wrong_count(self) -> None:
        candidates = ("a", "b", "new")

        def example(index: int, *, partial: bool) -> base.HumanExample:
            return base.HumanExample(
                sample_id=f"sample-{index}",
                work_id="work",
                split="train",
                positive_indices=(0,),
                eligible_indices=(0, 1) if partial else (0, 1, 2),
                none_target=0.0,
                role_index=0,
                style_values=tuple(0.0 for _ in base.STYLE_FIELDS),
                style_mask=tuple(False for _ in base.STYLE_FIELDS),
                treatment_indices=tuple(0 for _ in base.TREATMENT_VALUES),
                row=MappingProxyType(
                    {
                        "font_judgment": {
                            "acceptable": [],
                            "not_reviewed": ["new"] if partial else [],
                            "preferred": ["a"],
                            "unrenderable": [],
                        }
                    }
                ),
            )

        rows = tuple(example(index, partial=False) for index in range(108)) + (
            example(108, partial=True),
        )
        with self.assertRaises(trainer.MangaFontV6FontQueryError):
            trainer.complete_full22_train_rows(rows, candidates)


if __name__ == "__main__":
    unittest.main()
