from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "promote_font_matching_recrop_repair.py"
SPEC = importlib.util.spec_from_file_location("font_matching_recrop_promotion", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PROMOTION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PROMOTION
SPEC.loader.exec_module(PROMOTION)


def review_decision(value: str) -> SimpleNamespace:
    return SimpleNamespace(
        item_id="fhp-child",
        decision=value,
        reject_reason="bad mask" if value == "reject" else "",
        recrop_bbox_px=(10, 20, 30, 40) if value == "recrop" else None,
        padding_px=0,
        reviewer="reviewer",
        reviewed_at="2026-08-01T01:02:03Z",
        notes="directly checked",
        shard_tag="shard-000-of-004",
        sheet="sheet.png",
        cell_index=2,
        ledger_path="ledger.csv",
        ledger_sha256="a" * 64,
    )


def parent_row() -> dict[str, object]:
    return {
        "id": "fm-parent",
        "split": "train",
        "provenance": {
            "source_catalog_id": "fontclip-hard-accepted-v2",
            "source_id": "fhp-old",
            "source_line_number": 42,
            "source_line_sha256": "b" * 64,
        },
    }


def intake_row() -> dict[str, object]:
    return {
        "parent_master_record_sha256": "c" * 64,
        "parent_source_catalog_id": "fontclip-hard-accepted-v2",
        "parent_source_id": "fhp-old",
        "successor_candidate_id": "fhcr-candidate",
        "successor_candidate_record_sha256": "d" * 64,
        "invalidated_final_ids": ["final-old"],
    }


class RecropPromotionTests(unittest.TestCase):
    def test_crosswalk_forecasts_new_master_id_and_excludes_parent(self) -> None:
        decision = review_decision("pass")
        processed = {"id": "fhp-child"}
        row = PROMOTION._crosswalk_row(
            catalog_id="fontclip-recrop-accepted-v1",
            parent=parent_row(),
            intake=intake_row(),
            proposal={"record_sha256": "e" * 64},
            status="recheck_pass",
            terminal_record=processed,
            decision=decision,
        )
        self.assertTrue(row["parent_excluded"])
        self.assertTrue(row["accepted_successor"])
        self.assertEqual(row["promoted_source_id"], "fhp-child")
        self.assertEqual(
            row["expected_new_master_id"],
            PROMOTION._master_id("fontclip-recrop-accepted-v1", "fhp-child"),
        )
        self.assertEqual(row["invalidated_final_ids"], ["final-old"])
        PROMOTION.repair.validate_seal(row, "crosswalk")

    def test_exclusion_is_training_blocking_for_every_terminal_status(self) -> None:
        crosswalk = PROMOTION._crosswalk_row(
            catalog_id="fontclip-recrop-accepted-v1",
            parent=parent_row(),
            intake=intake_row(),
            proposal={"record_sha256": "e" * 64},
            status="recheck_reject",
            terminal_record={"id": "fhp-child"},
            decision=review_decision("reject"),
        )
        exclusion = PROMOTION._exclusion_row(crosswalk)
        self.assertTrue(exclusion["excluded_from_training"])
        self.assertTrue(exclusion["excluded_from_font_review"])
        self.assertIsNone(exclusion["successor_source_id"])
        self.assertTrue(exclusion["prior_final_labels_invalidated"])
        PROMOTION.repair.validate_seal(exclusion, "exclusion")

    def test_decorated_pass_has_exact_parent_candidate_child_chain(self) -> None:
        processed = {
            "id": "fhp-child",
            "provenance": "real_processed",
            "synthetic": False,
            "synthetic_provenance": None,
            "label": None,
            "lineage": [
                {"id": "fhcr-candidate", "provenance": "real_mined"},
                {"id": "fhp-child", "provenance": "real_processed"},
            ],
            "processing": {
                "tool": "postprocessor",
                "diagnostic_overlay_written": False,
            },
        }
        decorated = PROMOTION._decorate_accepted(
            record=processed,
            decision=review_decision("pass"),
            parent=parent_row(),
            intake=intake_row(),
            proposal={"record_sha256": "e" * 64},
            queue_row={
                "id": "fhcr-candidate",
                "bbox_px": [10, 20, 30, 40],
                "crop_sha256": "f" * 64,
                "source_page_sha256": "1" * 64,
                "manual_recrop": {"padding_px": 0},
            },
        )
        self.assertEqual(
            [event["id"] for event in decorated["lineage"]],
            ["fm-parent", "fhcr-candidate", "fhp-child"],
        )
        self.assertTrue(decorated["adjudication"]["exhaustive_visual_review_passed"])
        self.assertTrue(decorated["adjudication"]["manual_recrop"])
        self.assertFalse(decorated["adjudication"]["synthetic"])
        self.assertEqual(decorated["review"]["status"], "accepted")

    def test_preflight_blocks_recrop(self) -> None:
        contract = {
            "queue_rows": {"fhcr-candidate": {}},
            "queue_manifest_sha256": "a" * 64,
        }
        terminal = {
            "audit": SimpleNamespace(decisions={"fhp-child": review_decision("recrop")})
        }
        with (
            mock.patch.object(
                PROMOTION.revision,
                "_load_repair_contract",
                return_value=contract,
            ),
            mock.patch.object(
                PROMOTION.revision,
                "_load_terminal_outcomes",
                return_value=terminal,
            ),
        ):
            with self.assertRaisesRegex(
                PROMOTION.RecropPromotionError, "blocked by unresolved"
            ):
                PROMOTION._preflight(
                    repair_root=Path("repair"),
                    processed_root=Path("processed"),
                    library_root=Path("library"),
                    ledgers=[Path(f"ledger-{index}.csv") for index in range(4)],
                )

    def test_main_does_not_create_output_when_preflight_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repair_root = root / "repair"
            processed_root = root / "processed"
            library_root = root / "library"
            output_root = root / "promotion"
            for path in (repair_root, processed_root, library_root):
                path.mkdir()
            with mock.patch.object(
                PROMOTION,
                "_preflight",
                side_effect=PROMOTION.RecropPromotionError("unresolved recrop"),
            ):
                with self.assertRaisesRegex(
                    PROMOTION.RecropPromotionError, "unresolved recrop"
                ):
                    PROMOTION.main(
                        [
                            "build",
                            "--repair-root",
                            str(repair_root),
                            "--processed-root",
                            str(processed_root),
                            "--library-root",
                            str(library_root),
                            "--ledger",
                            str(root / "ledger.csv"),
                            "--output-root",
                            str(output_root),
                        ]
                    )
            self.assertFalse(output_root.exists())


if __name__ == "__main__":
    unittest.main()
