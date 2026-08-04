from __future__ import annotations

import unittest
from pathlib import Path

import numpy as np

from scripts import run_manga_font_student_v5_continuation as runner


ROOT = Path(__file__).resolve().parents[2]
SEALED_OUTPUT = (
    ROOT / "artifacts/manga-font-student-v5-continuation-full22-149-v1"
)


def metrics(
    *,
    preferred: int = 14,
    acceptable: int = 21,
    variant_preferred: int = 9,
    variant_acceptable: int = 16,
    share: float = 0.55,
    unique: int = 4,
) -> dict[str, object]:
    return {
        "acceptable_at1": acceptable / 33,
        "acceptable_hit_at3": 0.75,
        "evaluated_positive_rows": 33,
        "preferred_at1": preferred / 33,
        "tiered_gold_loss": 2.0,
        "top1_max_candidate_share": share,
        "top1_unique_candidate_count": unique,
        "variant_acceptable_at1": variant_acceptable / 28,
        "variant_preferred_at1": variant_preferred / 28,
        "variant_val_rows": 28,
    }


class RunMangaFontStudentV5ContinuationTest(unittest.TestCase):
    def test_trial_grid_is_the_exact_four_way_cartesian_product(self) -> None:
        self.assertEqual(
            runner._trial_grid(),  # noqa: SLF001
            (
                {
                    "head_learning_rate": 0.000025,
                    "legacy_partial_loss_weight": 0.0,
                },
                {
                    "head_learning_rate": 0.000025,
                    "legacy_partial_loss_weight": 0.10,
                },
                {
                    "head_learning_rate": 0.00005,
                    "legacy_partial_loss_weight": 0.0,
                },
                {
                    "head_learning_rate": 0.00005,
                    "legacy_partial_loss_weight": 0.10,
                },
            ),
        )

    def test_row_weights_distinguish_partial_existing_and_upgraded(self) -> None:
        full22 = np.asarray([False, True, True, False], dtype=np.bool_)
        upgraded = np.asarray([False, False, True, False], dtype=np.bool_)
        np.testing.assert_array_equal(
            runner.build_train_row_weights(
                full22=full22,
                upgraded=upgraded,
                legacy_partial_loss_weight=0.0,
            ),
            [0.0, 1.0, 1.5, 0.0],
        )
        np.testing.assert_allclose(
            runner.build_train_row_weights(
                full22=full22,
                upgraded=upgraded,
                legacy_partial_loss_weight=0.10,
            ),
            [0.10, 1.0, 1.5, 0.10],
            rtol=0.0,
            atol=1e-7,
        )

    def test_row_weights_reject_upgraded_partial_row(self) -> None:
        with self.assertRaisesRegex(
            runner.MangaFontV5ContinuationError, "row-weight contract"
        ):
            runner.build_train_row_weights(
                full22=np.asarray([False], dtype=np.bool_),
                upgraded=np.asarray([True], dtype=np.bool_),
                legacy_partial_loss_weight=0.0,
            )

    def test_promotion_gate_accepts_exact_boundaries(self) -> None:
        gate = runner.promotion_gate(metrics())
        self.assertTrue(gate["passed"])
        self.assertEqual(
            gate["hits"],
            {
                "acceptable_at1": 21,
                "preferred_at1": 14,
                "variant_acceptable_at1": 16,
                "variant_preferred_at1": 9,
            },
        )

    def test_promotion_gate_rejects_each_accuracy_or_diversity_regression(self) -> None:
        cases = (
            metrics(preferred=13),
            metrics(acceptable=20),
            metrics(variant_preferred=8),
            metrics(variant_acceptable=15),
            metrics(share=0.550001),
            metrics(unique=3),
        )
        for case in cases:
            with self.subTest(case=case):
                self.assertFalse(runner.promotion_gate(case)["passed"])

    def test_fixed_contract_has_no_test_or_deployment_authority(self) -> None:
        contract = runner._fixed_contract(input_bindings={"fixture": "a" * 64})  # noqa: SLF001
        runner._assert_fixed_contract(contract)  # noqa: SLF001
        self.assertFalse(contract["boundaries"]["fresh64_accessed"])
        self.assertEqual(contract["boundaries"]["hidden_test_pixels_opened"], 0)
        self.assertFalse(contract["boundaries"]["library_40qa_accessed"])
        self.assertFalse(contract["candidate_bias_allowed"])
        self.assertEqual(contract["prototype_score_coefficient"], 1.0)

    def test_run_parser_exposes_no_hidden_evaluation_input(self) -> None:
        run_parser = next(
            action.choices["run"]
            for action in runner.build_parser()._actions  # noqa: SLF001
            if getattr(action, "choices", None) and "run" in action.choices
        )
        destinations = {action.dest for action in run_parser._actions}  # noqa: SLF001
        self.assertTrue(
            {"readiness_dir", "cache_dir", "authority_dir", "output_dir"}
            <= destinations
        )
        self.assertFalse(
            {"test_dir", "fresh_dir", "fresh64_dir", "qa_dir", "qa40_dir"}
            & destinations
        )


@unittest.skipUnless(SEALED_OUTPUT.is_dir(), "sealed v5 continuation is unavailable")
class SealedMangaFontStudentV5ContinuationIntegrationTest(unittest.TestCase):
    def test_sealed_output_validates_and_never_authorizes_deployment(self) -> None:
        result = runner.validate(SEALED_OUTPUT)
        self.assertFalse(result["deployment_authorized"])
        self.assertIn(
            result["status"],
            {
                "research_failed_promotion_gate_not_met_not_deployed",
                "validation_gate_passed_research_checkpoint_not_deployed",
            },
        )


if __name__ == "__main__":
    unittest.main()
