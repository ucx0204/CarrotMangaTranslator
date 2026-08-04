from __future__ import annotations

import inspect
import unittest
from pathlib import Path

from scripts import train_manga_font_student_v6_fontquery_r3 as trainer


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "artifacts/manga-font-student-v6-fontquery-r3-all160-v1"


class TrainMangaFontStudentV6FontQueryR3Test(unittest.TestCase):
    def test_grid_is_bounded_four_by_256_with_one_r2_warm_start(self) -> None:
        grid = trainer._trial_grid()  # noqa: SLF001
        self.assertEqual(len(grid), 3)
        self.assertTrue(all(row["query_count"] == 4 for row in grid))
        self.assertTrue(all(row["query_dim"] == 256 for row in grid))
        self.assertEqual(sum(bool(row["warm_r2"]) for row in grid), 1)
        self.assertTrue(all(5e-5 <= row["head_lr"] <= 1e-4 for row in grid))
        self.assertTrue(all(5.0 <= row["human_weight"] <= 7.0 for row in grid))

    def test_counts_and_inventory_are_exact_successor_contract(self) -> None:
        self.assertEqual(trainer.AUTHORITY_ROWS, 160)
        self.assertEqual(trainer.ORIGINAL_FULL22_ROWS, 109)
        self.assertEqual(trainer.FULL22_ROWS, 269)
        self.assertEqual(trainer.VAL_ROWS, 33)
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

    def test_authority_gate_precedes_dependency_and_pixel_loading(self) -> None:
        source = inspect.getsource(trainer.train)
        self.assertLess(source.index("_authority_gate"), source.index("_load_training_dependencies"))
        self.assertLess(source.index("_authority_gate"), source.index("load_authority_and_encode"))
        parser = trainer.build_parser()
        args = parser.parse_args(
            [
                "train",
                "--cache-dir", "cache",
                "--r2-output-dir", "r2",
                "--authority-dir", "authority",
                "--review-dir", "review",
                "--draft-dir", "draft",
                "--legacy-overlay-dir", "overlay",
                "--catalog-registry", "registry",
                "--output-dir", "output",
            ]
        )
        self.assertEqual(args.r2_output_dir, Path("r2"))
        self.assertFalse(hasattr(args, "test_dir"))
        self.assertFalse(hasattr(args, "fresh_dir"))
        self.assertFalse(hasattr(args, "qa_dir"))

    @unittest.skipUnless(OUTPUT_DIR.exists(), "sealed r3 output unavailable")
    def test_published_output_passes_permanent_validator(self) -> None:
        result = trainer.validate_output(OUTPUT_DIR)
        self.assertEqual(result["status"], "sealed_research_only")
        self.assertIsInstance(result["quality_gate_passed"], bool)


if __name__ == "__main__":
    unittest.main()
