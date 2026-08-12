from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "blind_pool", SCRIPTS / "build_manga_font_v2_blind_calibration_pool.py"
)
assert SPEC and SPEC.loader
blind_pool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(blind_pool)


def row(
    sample_id: str,
    *,
    work: str = "w1",
    page: str | None = None,
    category: str | None = None,
    orientation: str = "vertical",
    bbox: list[int] | None = None,
    outline: float = 0.0,
    score: float = 0.5,
) -> dict:
    return {
        "id": sample_id,
        "work": {"id": work},
        "chapter": {"id": f"ch-{work}"},
        "page": {"source_page_sha256": (page or (sample_id * 64))[:64]},
        "geometry": {
            "final_bbox_px": bbox or [10, 10, 70, 150],
            "page_size_px": [1000, 1500],
        },
        "metadata": {
            "candidate_primary_category": category,
            "candidate_score": score,
            "orientation": orientation,
            "style_metrics": {"outline_structure_ratio": outline},
        },
    }


class BlindPoolTests(unittest.TestCase):
    def test_candidate_panels_are_deterministic_complete_sevens(self) -> None:
        candidates = [f"font-{index:02d}" for index in range(21)]
        first = blind_pool.deterministic_candidate_panels("fm_abc", candidates)
        second = blind_pool.deterministic_candidate_panels("fm_abc", candidates)
        self.assertEqual(first, second)
        self.assertEqual([len(panel) for panel in first], [7, 7, 7])
        self.assertEqual(set().union(*map(set, first)), set(candidates))
        self.assertEqual(sum(len(panel) for panel in first), 21)

    def test_role_bucket_predicates_are_sampling_only(self) -> None:
        self.assertTrue(blind_pool.bucket_eligible(row("s", category="page_sound"), "sfx"))
        self.assertTrue(
            blind_pool.bucket_eligible(
                row(
                    "t",
                    category="text_free",
                    orientation="horizontal",
                    bbox=[10, 10, 210, 70],
                ),
                "sign_title",
            )
        )
        self.assertTrue(
            blind_pool.bucket_eligible(row("b", category="bubble_edge"), "aside_whisper")
        )
        self.assertTrue(blind_pool.bucket_eligible(row("o"), "dialogue"))
        self.assertTrue(blind_pool.bucket_eligible(row("o"), "narration"))
        self.assertFalse(blind_pool.bucket_eligible(row("o"), "sfx"))

    def test_public_row_rejects_identity_or_model_leak(self) -> None:
        panels = [
            {
                "panel_number": panel,
                "sheet": {
                    "file": f"contact-sheets/panel-{panel}/sheet-001.png",
                    "row_index": 0,
                    "sha256": "a" * 64,
                },
                "slots": [f"P{panel}-{chr(ord('A') + index)}" for index in range(7)],
            }
            for panel in range(1, 4)
        ]
        core = {
            "authority": {
                "automatic_label_promotion_allowed": False,
                "calibration_eligible": False,
                "evaluation_eligible": False,
                "label_authority": "none_pending_blind_review",
                "model_scores_visible": False,
                "training_eligible": False,
            },
            "binding_id": "binding",
            "chapter_token": "chapter",
            "orientation": "vertical",
            "page_token": "page",
            "panels": panels,
            "record_type": blind_pool.RECORD_TYPE,
            "review_id": "review",
            "role_sampling": {
                "bucket": "dialogue",
                "confidence": 0.55,
                "must_be_human_verified": True,
                "source": "layout_metadata_sampling_hint_not_label",
            },
            "sample_id": "fm_fixture",
            "schema_version": blind_pool.SCHEMA_VERSION,
            "source": {"geometry": {}, "views": {}},
            "source_identity_sha256": "b" * 64,
            "split": "test",
            "work_token": "work",
        }
        blind_pool.validate_public_row(blind_pool.seal_record(core))
        leaky = dict(core)
        leaky["font_id"] = "secret-font"
        with self.assertRaisesRegex(blind_pool.BlindPoolError, "leaks"):
            blind_pool.validate_public_row(blind_pool.seal_record(leaky))

    def test_work_assignment_separates_purposes(self) -> None:
        rows = []
        for work, sfx, ordinary in (
            ("wa", 20, 2),
            ("wb", 5, 0),
            ("wc", 0, 100),
            ("wd", 0, 50),
            ("we", 0, 10),
        ):
            rows.extend(
                row(f"{work}-sfx-{index}", work=work, category="page_sound")
                for index in range(sfx)
            )
            rows.extend(row(f"{work}-o-{index}", work=work) for index in range(ordinary))
        assigned = blind_pool.assign_purpose_works(rows)
        self.assertEqual(len(assigned["calibration"]), 3)
        self.assertEqual(len(assigned["evaluation"]), 2)
        self.assertFalse(set(assigned["calibration"]) & set(assigned["evaluation"]))
        self.assertIn("wa", assigned["calibration"])
        self.assertIn("wb", assigned["evaluation"])
        self.assertIn("wc", assigned["evaluation"])

    def test_review_needed_only_tracks_uncertain_sampling_roles(self) -> None:
        base = {
            "record_sha256": "c" * 64,
            "review_id": "r",
            "sample_id": "s",
        }
        uncertain = {**base, "role_sampling": {"confidence": 0.55}}
        confident = {**base, "role_sampling": {"confidence": 0.95}}
        self.assertIsNotNone(blind_pool._review_needed_row(uncertain))
        self.assertIsNone(blind_pool._review_needed_row(confident))


if __name__ == "__main__":
    unittest.main()
