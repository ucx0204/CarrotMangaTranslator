from __future__ import annotations

import unittest
from types import MappingProxyType

import numpy as np

from scripts import diagnose_manga_font_student_v1 as diagnosis
from scripts import train_manga_font_student_v1 as trainer


CANDIDATES = ("font-a", "font-b", "font-c", "font-d", "font-e")


def human_example(
    sample_id: str,
    *,
    preferred: tuple[str, ...],
    acceptable: tuple[str, ...],
    role: str,
) -> trainer.HumanExample:
    index = {value: offset for offset, value in enumerate(CANDIDATES)}
    positives = (*preferred, *acceptable)
    return trainer.HumanExample(
        sample_id=sample_id,
        work_id=f"work-{sample_id}",
        split="val",
        positive_indices=tuple(index[value] for value in positives),
        eligible_indices=tuple(range(len(CANDIDATES))),
        none_target=0.0,
        role_index=trainer.ROLE_VALUES.index(role),
        style_values=tuple(0.0 for _ in trainer.STYLE_FIELDS),
        style_mask=tuple(False for _ in trainer.STYLE_FIELDS),
        treatment_indices=tuple(0 for _ in trainer.TREATMENT_VALUES),
        row=MappingProxyType(
            {
                "font_judgment": {
                    "preferred": list(preferred),
                    "acceptable": list(acceptable),
                }
            }
        ),
    )


class DiagnoseMangaFontStudentV1Test(unittest.TestCase):
    def setUp(self) -> None:
        first = human_example(
            "sample-1",
            preferred=("font-a",),
            acceptable=("font-b", "font-c", "font-d"),
            role="sfx_impact",
        )
        second = human_example(
            "sample-2",
            preferred=("font-e",),
            acceptable=(),
            role="dialogue",
        )
        self.rows = (
            diagnosis.ValidationScores(
                example=first,
                runtime_scores=np.asarray([4.0, 3.0, 2.0, 1.0, 5.0]),
                direct_scores=np.asarray([5.0, 3.0, 2.0, 1.0, 4.0]),
            ),
            diagnosis.ValidationScores(
                example=second,
                runtime_scores=np.asarray([1.0, 2.0, 0.0, -1.0, 5.0]),
                direct_scores=np.asarray([1.0, 5.0, 0.0, -1.0, 4.0]),
            ),
        )

    def test_stable_eligible_order_masks_and_breaks_ties_by_candidate_order(
        self,
    ) -> None:
        order = diagnosis.stable_eligible_order(
            np.asarray([1.0, 5.0, 5.0, 99.0, 2.0]),
            (0, 1, 2, 4),
            candidate_count=5,
        )
        self.assertEqual(order, (1, 2, 4, 0))

    def test_hit_at3_is_not_misreported_as_full_set_recall(self) -> None:
        result = diagnosis.summarize_method(
            self.rows, candidate_ids=CANDIDATES, score_source="runtime"
        )
        self.assertEqual(result["acceptable_at1"], 0.5)
        self.assertEqual(result["preferred_at1"], 0.5)
        self.assertEqual(result["acceptable_hit_at3"], 1.0)
        self.assertEqual(result["preferred_hit_at3"], 1.0)
        # Row 1 retrieves 2/4 acceptable candidates; row 2 retrieves 1/1.
        self.assertEqual(result["acceptable_set_recall_at3"], 0.75)
        self.assertEqual(result["by_variant_group"]["variant"]["sample_count"], 1)
        self.assertEqual(result["by_variant_group"]["ordinary"]["sample_count"], 1)

    def test_paired_comparison_exposes_complementary_head_wins(self) -> None:
        runtime = diagnosis.summarize_method(
            self.rows, candidate_ids=CANDIDATES, score_source="runtime"
        )
        direct = diagnosis.summarize_method(
            self.rows, candidate_ids=CANDIDATES, score_source="direct"
        )
        paired = diagnosis.paired_comparison(
            runtime, direct, self.rows, candidate_ids=CANDIDATES
        )
        self.assertEqual(
            paired["acceptable_top1_outcomes"],
            {"both": 0, "runtime_only": 1, "direct_only": 1, "neither": 0},
        )
        self.assertEqual(paired["either_head_acceptable_oracle_at1"], 1.0)
        self.assertEqual(paired["disagreement_rate"], 1.0)

    def test_label_statistics_preserve_preferred_and_acceptable_tiers(self) -> None:
        statistics = diagnosis.label_statistics(
            tuple(row.example for row in self.rows), CANDIDATES
        )
        self.assertEqual(statistics["sample_count"], 2)
        self.assertEqual(statistics["preferred_set_mean_size"], 1.0)
        self.assertEqual(statistics["combined_positive_set_mean_size"], 2.5)
        self.assertEqual(
            statistics["acceptable_only_set_size_histogram"], {"0": 1, "3": 1}
        )

    def test_constant_baseline_exposes_broad_label_shortcut(self) -> None:
        baselines = diagnosis.constant_candidate_baselines(
            tuple(row.example for row in self.rows), CANDIDATES
        )
        self.assertEqual(baselines["all"]["best_constant_acceptable_at1"], 0.5)
        self.assertEqual(
            baselines["all"]["best_constant_acceptable_candidate_id"], "font-a"
        )
        self.assertEqual(baselines["variant"]["sample_count"], 1)
        self.assertEqual(baselines["ordinary"]["sample_count"], 1)

    def test_fusion_is_explicitly_weighted_after_per_row_standardization(self) -> None:
        result = diagnosis.summarize_method(
            self.rows,
            candidate_ids=CANDIDATES,
            score_source="fusion",
            fusion_runtime_weight=0.25,
        )
        self.assertEqual(result["fusion_runtime_weight"], 0.25)
        self.assertEqual(result["sample_count"], 2)

    def test_direct_view_scores_support_fixed_and_runtime_gate_weights(self) -> None:
        rows = tuple(
            diagnosis.ValidationScores(
                example=row.example,
                runtime_scores=row.runtime_scores,
                direct_scores=row.direct_scores,
                direct_view_scores=np.stack(
                    (
                        row.direct_scores,
                        row.direct_scores + 1.0,
                        row.direct_scores - 1.0,
                    )
                ),
                view_gate_weights=np.asarray([0.5, 0.25, 0.25]),
            )
            for row in self.rows
        )
        raw = diagnosis.reweight_direct_rows(rows, fixed_weights=(1.0, 0.0, 0.0))
        gated = diagnosis.reweight_direct_rows(rows, use_runtime_view_gate=True)
        np.testing.assert_allclose(raw[0].direct_scores, self.rows[0].direct_scores)
        np.testing.assert_allclose(gated[0].direct_scores, self.rows[0].direct_scores)
        with self.assertRaisesRegex(
            diagnosis.StudentDiagnosisError, "fixed direct-view weights"
        ):
            diagnosis.reweight_direct_rows(rows, fixed_weights=(0.6, 0.6, -0.2))


if __name__ == "__main__":
    unittest.main()
