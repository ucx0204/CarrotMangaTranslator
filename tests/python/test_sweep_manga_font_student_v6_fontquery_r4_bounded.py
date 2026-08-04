from __future__ import annotations

import types
import unittest

from scripts import sweep_manga_font_student_v6_fontquery_r4_bounded as sweep


class BoundedR4SweepTest(unittest.TestCase):
    def test_four_trials_are_all_r2_anchored_and_bounded(self) -> None:
        grid = sweep._trial_grid()  # noqa: SLF001
        self.assertEqual(len(grid), 4)
        self.assertTrue(all(1e-5 <= row["head_lr"] <= 3e-5 for row in grid))
        self.assertTrue(all(row["distill_weight"] >= 2.0 for row in grid))

    def test_subset_is_first40_plus_remaining_high60(self) -> None:
        examples = []
        for index in range(160):
            confidence = "high" if index < 100 else "medium"
            examples.append(
                types.SimpleNamespace(
                    row={"visual_judgment_confidence": confidence},
                    sample_id=f"sample-{index}",
                )
            )
        selected = sweep._selected_authority_indices(examples)  # noqa: SLF001
        self.assertEqual(len(selected), 100)
        self.assertEqual(selected[:40], tuple(range(40)))
        self.assertEqual(selected[-1], 99)

    def test_exact_train_counts_are_sealed(self) -> None:
        self.assertEqual(sweep.ORIGINAL_ROWS, 109)
        self.assertEqual(sweep.R2_ANCHOR_ROWS, 149)
        self.assertEqual(sweep.SELECTED_AUTHORITY_ROWS, 100)
        self.assertEqual(sweep.SELECTED_TRAIN_ROWS, 209)


if __name__ == "__main__":
    unittest.main()
