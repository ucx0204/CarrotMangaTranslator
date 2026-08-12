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
    "blind_review_shard", SCRIPTS / "materialize_manga_font_v2_blind_review_shard.py"
)
assert SPEC and SPEC.loader
review_shard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review_shard)


def public_item(*, bucket: str = "dialogue") -> dict:
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
    return review_shard.pool_contract.seal_record(
        {
            "panels": panels,
            "record_type": review_shard.pool_contract.RECORD_TYPE,
            "review_id": "review-1",
            "role_sampling": {
                "bucket": bucket,
                "confidence": 0.55,
                "must_be_human_verified": True,
                "source": "layout_metadata_sampling_hint_not_label",
            },
            "sample_id": "fm_fixture",
        }
    )


def decision(**overrides: object) -> dict:
    result = {
        "queue_row": 1,
        "sample_id": "fm_fixture",
        "decision_status": "completed",
        "crop_quality": "pass",
        "verified_role": "dialogue",
        "verified_role_confidence": 0.9,
        "font_match_confidence": 0.8,
        "preferred_slots": ["P1-A"],
        "acceptable_slots": ["P2-B"],
        "marginal_slots": ["P3-C"],
        "notes": "fixture judgment",
    }
    result.update(overrides)
    return result


class BlindReviewShardTests(unittest.TestCase):
    def test_completed_record_partitions_all_21_slots(self) -> None:
        rows, cross = review_shard.materialize_records(
            [decision()],
            [public_item()],
            start_row=1,
            end_row=1,
            shard_id="shard",
            reviewer="agent",
            reviewed_at="2026-08-11T00:00:00+09:00",
        )
        self.assertEqual(cross, [])
        self.assertEqual(len(rows), 1)
        panels = rows[0]["panel_decisions"]
        classified = [
            slot
            for panel in panels
            for key in (
                "preferred_slots",
                "acceptable_slots",
                "marginal_slots",
                "unacceptable_slots",
                "unrenderable_slots",
            )
            for slot in panel[key]
        ]
        self.assertEqual(len(classified), 21)
        self.assertEqual(len(set(classified)), 21)
        self.assertTrue(all(panel["review_complete"] for panel in panels))
        self.assertFalse(rows[0]["authority"]["training_eligible"])
        self.assertFalse(rows[0]["blindness"]["private_bindings_read"])

    def test_deferred_record_remains_partial_and_enters_cross_review(self) -> None:
        rows, cross = review_shard.materialize_records(
            [
                decision(
                    decision_status="review_needed",
                    crop_quality="review_needed",
                    verified_role_confidence=0.6,
                    font_match_confidence=0.4,
                    preferred_slots=[],
                    acceptable_slots=[],
                    marginal_slots=["P1-B"],
                )
            ],
            [public_item()],
            start_row=1,
            end_row=1,
            shard_id="shard",
            reviewer="agent",
            reviewed_at="2026-08-11T00:00:00+09:00",
        )
        self.assertFalse(any(panel["review_complete"] for panel in rows[0]["panel_decisions"]))
        self.assertFalse(
            any(panel["unacceptable_slots"] for panel in rows[0]["panel_decisions"])
        )
        self.assertEqual([row["queue_row"] for row in cross], [1])
        self.assertIn("blind_reviewer_deferred", cross[0]["reason_codes"])
        self.assertIn("low_font_match_confidence", cross[0]["reason_codes"])

    def test_rejects_slot_list_overlap(self) -> None:
        with self.assertRaisesRegex(review_shard.ReviewShardError, "multiple judgments"):
            review_shard.materialize_records(
                [decision(acceptable_slots=["P1-A"])],
                [public_item()],
                start_row=1,
                end_row=1,
                shard_id="shard",
                reviewer="agent",
                reviewed_at="2026-08-11T00:00:00+09:00",
            )

    def test_role_correction_is_relative_to_sampling_hint(self) -> None:
        rows, _ = review_shard.materialize_records(
            [decision(verified_role="narration")],
            [public_item(bucket="dialogue")],
            start_row=1,
            end_row=1,
            shard_id="shard",
            reviewer="agent",
            reviewed_at="2026-08-11T00:00:00+09:00",
        )
        self.assertTrue(rows[0]["role_corrected_from_sampling_hint"])

    def test_identity_scan_rejects_private_font_key(self) -> None:
        with self.assertRaisesRegex(review_shard.ReviewShardError, "forbidden identity key"):
            review_shard._identity_key_scan({"font_name": "leak"})


if __name__ == "__main__":
    unittest.main()
