from __future__ import annotations

import unittest

from scripts import train_manga_font_student_v6_fontquery_r2 as trainer


class TrainMangaFontStudentV6FontQueryR2Test(unittest.TestCase):
    def test_grid_is_bounded_and_centered_on_four_query_r1(self) -> None:
        grid = trainer._trial_grid()  # noqa: SLF001
        self.assertEqual(len(grid), 3)
        self.assertTrue(all(row["query_count"] == 4 for row in grid))
        self.assertTrue(all(row["query_dim"] == 256 for row in grid))
        self.assertEqual(sum(bool(row["warm_r1"]) for row in grid), 1)

    def test_output_inventory_is_exact(self) -> None:
        self.assertEqual(
            trainer.FILES,
            {
                trainer.MARKER,
                trainer.REPORT,
                trainer.CHECKPOINT,
                trainer.PROTOTYPES,
                trainer.PREDICTIONS,
            },
        )


if __name__ == "__main__":
    unittest.main()
