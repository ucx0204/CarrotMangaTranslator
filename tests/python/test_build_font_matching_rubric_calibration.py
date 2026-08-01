from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_rubric_calibration.py"
SPEC = importlib.util.spec_from_file_location("rubric_calibration", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CALIBRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CALIBRATION)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def master_row(sample_id: str, work_id: str, split: str = "train") -> dict:
    return {
        "id": sample_id,
        "split": split,
        "provenance": {"qa_overlay": False, "synthetic": False},
    }


def inventory_row(
    sample_id: str,
    work_id: str,
    *,
    cohorts: list[str],
    split: str = "train",
    pilot: bool = False,
    calibration: bool = True,
) -> dict:
    batches = {}
    if calibration:
        batches["calibration"] = {"review_order": 1, "selection_reasons": ["x"]}
    if pilot:
        batches["pilot"] = {"review_order": 1, "selection_reasons": ["x"]}
    return {
        "sample_id": sample_id,
        "work_id": work_id,
        "chapter_id": f"chapter-{sample_id}",
        "page_id": f"page-{sample_id}",
        "split": split,
        "cohorts": cohorts,
        "orientation": "horizontal" if "horizontal" in cohorts else "vertical",
        "batches": batches,
        "provenance": {
            "qa_overlay": False,
            "synthetic": False,
            "source_catalog_id": "real",
        },
    }


class RubricCalibrationSelectionTests(unittest.TestCase):
    def test_excludes_frozen_pilot_and_non_calibration_rows(self) -> None:
        rows = [
            inventory_row("kept", "work-a", cohorts=["hard_page_sound"]),
            inventory_row("test", "work-a", cohorts=[], split="test"),
            inventory_row("pilot", "work-a", cohorts=[], pilot=True),
            inventory_row("outside", "work-a", cohorts=[], calibration=False),
        ]

        selected, diagnostics = CALIBRATION.select_rows(
            rows, per_work=2, seed="fixture"
        )

        self.assertEqual(["kept"], [row["sample_id"] for row in selected])
        self.assertEqual(
            {
                "frozen_test": 1,
                "outside_calibration_inventory": 1,
                "pilot_overlap": 1,
            },
            diagnostics["excluded"],
        )

    def test_selection_is_deterministic_and_prefers_quota_coverage(self) -> None:
        rows = [
            inventory_row(
                "ordinary", "work-a", cohorts=["ordinary_dialogue_proxy_control"]
            ),
            inventory_row("sfx", "work-a", cohorts=["hard_page_sound"]),
            inventory_row("fill", "work-a", cohorts=["vertical"]),
        ]

        first, _ = CALIBRATION.select_rows(rows, per_work=2, seed="fixture")
        second, _ = CALIBRATION.select_rows(
            list(reversed(rows)), per_work=2, seed="fixture"
        )

        self.assertEqual(
            [row["sample_id"] for row in first],
            [row["sample_id"] for row in second],
        )
        self.assertEqual({"ordinary", "sfx"}, {row["sample_id"] for row in first})

    def test_explicit_visual_reject_is_replaced_deterministically(self) -> None:
        rows = [
            inventory_row("first", "work-a", cohorts=["hard_page_sound"]),
            inventory_row("replacement", "work-a", cohorts=["hard_page_sound"]),
        ]
        baseline, _ = CALIBRATION.select_rows(rows, per_work=1, seed="fixture")
        rejected_id = baseline[0]["sample_id"]

        selected, diagnostics = CALIBRATION.select_rows(
            rows,
            per_work=1,
            seed="fixture",
            excluded_sample_ids=frozenset({rejected_id}),
        )

        self.assertEqual(1, len(selected))
        self.assertNotEqual(rejected_id, selected[0]["sample_id"])
        self.assertEqual(1, diagnostics["excluded"]["explicit_visual_audit_reject"])

    def test_build_writes_zero_copy_subset_and_hash_bound_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            master = root / "master.jsonl"
            inventory = root / "inventory.jsonl"
            rubric = root / "rubric.md"
            output = root / "output"
            rows = [
                inventory_row(
                    "a", "work-a", cohorts=["ordinary_dialogue_proxy_control"]
                ),
                inventory_row("b", "work-a", cohorts=["hard_page_sound"]),
                inventory_row(
                    "c", "work-b", cohorts=["hard_outline_extreme"], split="val"
                ),
                inventory_row("hidden", "work-b", cohorts=[], split="test"),
            ]
            write_jsonl(
                master,
                [
                    master_row("a", "work-a"),
                    master_row("b", "work-a"),
                    master_row("c", "work-b", "val"),
                    master_row("hidden", "work-b", "test"),
                ],
            )
            write_jsonl(inventory, rows)
            rubric.write_text("frozen rubric\n", encoding="utf-8")

            report = CALIBRATION.build_calibration(
                master_manifest=master,
                inventory=inventory,
                rubric=rubric,
                output_dir=output,
                seed="fixture",
                per_work=2,
                expected_works=2,
                expected_total=3,
            )

            subset = [
                json.loads(line)
                for line in (output / "master.jsonl").read_text().splitlines()
            ]
            selected_inventory = [
                json.loads(line)
                for line in (output / "inventory.jsonl").read_text().splitlines()
            ]
            self.assertEqual({"a", "b", "c"}, {row["id"] for row in subset})
            self.assertEqual(0, report["safety"]["frozen_test_selected"])
            self.assertEqual(
                report["hashes"]["subset_master_manifest_sha256"],
                selected_inventory[0]["master_manifest_sha256"],
            )
            self.assertEqual(
                [1, 2, 3],
                [
                    row["batches"]["calibration"]["review_order"]
                    for row in selected_inventory
                ],
            )

    def test_rejects_overlay_or_synthetic_inventory(self) -> None:
        row = inventory_row("bad", "work-a", cohorts=[])
        row["provenance"]["qa_overlay"] = True
        with self.assertRaisesRegex(
            CALIBRATION.CalibrationSelectionError, "QA overlay"
        ):
            CALIBRATION.select_rows([row], per_work=1, seed="fixture")


if __name__ == "__main__":
    unittest.main()
