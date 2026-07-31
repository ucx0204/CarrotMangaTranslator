from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "build_font_matching_pilot.py"
SPEC = importlib.util.spec_from_file_location("build_font_matching_pilot", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load pilot builder: {SCRIPT_PATH}")
PILOT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PILOT
SPEC.loader.exec_module(PILOT)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def hard_signals(
    *,
    inverse: float = 0.0,
    color: float = 0.0,
    outline: float = 0.4,
    quality: str = "pass",
    manual_recrop: bool = False,
) -> dict:
    return {
        "color_mask_overlap_ratio": color,
        "inverse_likelihood": inverse,
        "manual_recrop": manual_recrop,
        "outline_metrics": {
            "outline_fill_pixels": 10,
            "outline_outer_ring_pixels": 5,
            "outline_stroke_pixels": 5,
            "outline_structure_ratio": outline,
        },
        "outline_signal_present": True,
        "quality_status": quality,
        "review_decision": "pass",
        "review_status": "accepted",
    }


def base_signals() -> dict:
    return {
        "color_mask_overlap_ratio": None,
        "inverse_likelihood": None,
        "manual_recrop": False,
        "outline_metrics": {},
        "outline_signal_present": False,
        "quality_status": None,
        "review_decision": None,
        "review_status": "accepted",
    }


def make_row(
    sample_id: str,
    work_id: str,
    chapter_id: str,
    page_id: str,
    *,
    catalog_id: str = PILOT.HARD_CATALOG_ID,
    orientation: str = "vertical",
    categories: list[str] | None = None,
    primary: str | None = None,
    signals: dict | None = None,
    split: str = "train",
) -> dict:
    is_base = catalog_id == PILOT.BASE_CATALOG_ID
    return {
        "chapter": {"id": chapter_id, "title": chapter_id},
        "id": sample_id,
        "metadata": {
            "candidate_categories": [] if is_base else (categories or ["bubble_edge"]),
            "candidate_primary_category": None
            if is_base
            else (primary or "bubble_edge"),
            "cohort_signals": base_signals()
            if is_base
            else (signals or hard_signals()),
            "orientation": orientation,
        },
        "page": {"id": page_id},
        "provenance": {
            "qa_overlay": False,
            "source_catalog_id": catalog_id,
            "synthetic": False,
        },
        "sample_crop_sha256": digest(f"crop:{sample_id}"),
        "schema_version": 1,
        "split": split,
        "work": {"id": work_id, "title": work_id},
    }


def make_fixture_rows() -> list[dict]:
    rows: list[dict] = []
    serial = 0
    category_specs = (
        (["page_sound"], "page_sound", hard_signals()),
        (["ocr_hard"], "ocr_hard", hard_signals()),
        (
            ["ocr_anime_region"],
            "ocr_anime_region",
            hard_signals(quality="review"),
        ),
        (["text_free", "free_near_bubble"], "text_free", hard_signals()),
        (["bubble_edge"], "bubble_edge", hard_signals()),
        (["bubble_edge"], "bubble_edge", hard_signals(inverse=0.5)),
        (["bubble_edge"], "bubble_edge", hard_signals(color=0.4)),
        (["bubble_edge"], "bubble_edge", hard_signals(outline=0.8)),
    )
    for work_index in range(3):
        work_id = f"work-{work_index}"
        split = ("train", "val", "test")[work_index]
        for chapter_index in range(4):
            chapter_id = f"chapter-{work_index}-{chapter_index}"
            for row_index in range(12):
                sample_id = f"sample-{serial:04d}"
                serial += 1
                orientation = "horizontal" if row_index in {0, 1} else "vertical"
                if row_index < len(category_specs):
                    categories, primary, signals = category_specs[row_index]
                    signals = copy.deepcopy(signals)
                    if row_index == 4 and chapter_index == 0:
                        signals["manual_recrop"] = True
                    rows.append(
                        make_row(
                            sample_id,
                            work_id,
                            chapter_id,
                            f"page-{work_index}-{chapter_index}-{row_index // 2}",
                            orientation=orientation,
                            categories=list(categories),
                            primary=primary,
                            signals=signals,
                            split=split,
                        )
                    )
                else:
                    rows.append(
                        make_row(
                            sample_id,
                            work_id,
                            chapter_id,
                            f"page-{work_index}-{chapter_index}-{row_index // 2}",
                            catalog_id=PILOT.BASE_CATALOG_ID,
                            orientation=orientation,
                            split=split,
                        )
                    )
    return rows


class FontMatchingPilotTests(unittest.TestCase):
    def build_fixture(self, root: Path, *, pilot_size: int = 60):
        master = root / "manifest.jsonl"
        rows = make_fixture_rows()
        write_jsonl(master, rows)
        bundle = PILOT.build_bundle(
            master,
            config=PILOT.BuildConfig(pilot_size=pilot_size, seed="unit-test"),
            expected_rows=len(rows),
            expected_works=3,
            expected_chapters=12,
            expected_manual_recrops=3,
        )
        return rows, master, bundle

    def test_deterministic_pilot_covers_all_chapters_and_manual_recrops(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows, master, first = self.build_fixture(root)
            second = PILOT.build_bundle(
                master,
                config=PILOT.BuildConfig(pilot_size=60, seed="unit-test"),
                expected_rows=len(rows),
                expected_works=3,
                expected_chapters=12,
                expected_manual_recrops=3,
            )
            self.assertEqual(first.inventory_bytes, second.inventory_bytes)
            self.assertEqual(first.report_bytes, second.report_bytes)
            self.assertEqual(len(first.pilot_ids), 60)
            self.assertEqual(len(set(first.pilot_ids)), 60)
            self.assertTrue(first.report["coverage"]["pilot_all_chapters_covered"])
            self.assertTrue(first.report["coverage"]["pilot_all_works_covered"])
            self.assertTrue(
                first.report["coverage"]["pilot_all_manual_recrops_included"]
            )
            self.assertGreaterEqual(
                first.report["selection"]["pilot"]["summary"]["horizontal_rate"],
                0.25,
            )

    def test_cohort_membership_overlaps_but_inventory_rows_are_unique(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            rows, _, bundle = self.build_fixture(Path(temporary))
            inventory = bundle.inventory_rows
            self.assertEqual(
                len(inventory), len({row["sample_id"] for row in inventory})
            )
            overlapping = [
                row
                for row in inventory
                if {"pilot", "calibration"} <= set(row["batches"])
            ]
            self.assertTrue(overlapping)
            source_splits = {row["id"]: row["split"] for row in rows}
            self.assertTrue(
                all(
                    row["split"] == source_splits[row["sample_id"]] for row in inventory
                )
            )
            text_free = next(
                row
                for row in inventory
                if "hard_text_free" in row["cohorts"]
                and "hard_inverse_extreme" not in row["cohorts"]
                and "hard_color_extreme" not in row["cohorts"]
                and "hard_outline_extreme" not in row["cohorts"]
            )
            self.assertNotIn("hard_risk_union", text_free["cohorts"])

    def test_calibration_uses_all_risk_and_four_to_six_controls_per_chapter(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _, _, bundle = self.build_fixture(Path(temporary))
            calibration = bundle.report["selection"]["calibration"]
            diagnostics = calibration["diagnostics"]
            self.assertFalse(diagnostics["ordinary_chapter_shortfalls"])
            targets = diagnostics["ordinary_target_by_chapter"]
            self.assertTrue(targets)
            self.assertTrue(all(4 <= value <= 6 for value in targets.values()))
            risk_ids = {
                row["sample_id"]
                for row in bundle.inventory_rows
                if "hard_risk_union" in row["cohorts"]
            }
            self.assertTrue(risk_ids <= set(bundle.calibration_ids))

    def test_reports_ordinary_proxy_shortfall_without_inventing_a_role(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            affected = ("work-0", "chapter-0-0")
            for row in rows:
                if (row["work"]["id"], row["chapter"]["id"]) == affected:
                    row["provenance"]["source_catalog_id"] = PILOT.HARD_CATALOG_ID
                    row["metadata"]["candidate_categories"] = ["page_sound"]
                    row["metadata"]["candidate_primary_category"] = "page_sound"
                    row["metadata"]["cohort_signals"] = hard_signals()
            # Preserve the fixture-wide contract of exactly three recrops.
            rows[4]["metadata"]["cohort_signals"]["manual_recrop"] = True
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            bundle = PILOT.build_bundle(
                master,
                config=PILOT.BuildConfig(pilot_size=60, seed="unit-test"),
                expected_rows=len(rows),
                expected_works=3,
                expected_chapters=12,
                expected_manual_recrops=3,
            )
            shortfalls = bundle.report["selection"]["calibration"]["diagnostics"][
                "ordinary_chapter_shortfalls"
            ]
            self.assertTrue(
                any(
                    item["work_id"] == affected[0]
                    and item["chapter_id"] == affected[1]
                    and item["available"] == 0
                    for item in shortfalls
                )
            )
            self.assertIn(
                "ordinary_proxy_shortfall", bundle.report["coverage"]["flags"]
            )

    def test_missing_hard_signal_is_an_explicit_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            del rows[0]["metadata"]["cohort_signals"]["inverse_likelihood"]
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            with self.assertRaisesRegex(
                PILOT.PilotInventoryError,
                r"cohort_signals\.inverse_likelihood: required field is missing",
            ):
                PILOT.build_bundle(
                    master,
                    config=PILOT.BuildConfig(pilot_size=60),
                    expected_rows=len(rows),
                    expected_works=3,
                    expected_chapters=12,
                    expected_manual_recrops=3,
                )

    def test_rejects_synthetic_overlay_and_duplicate_ids(self) -> None:
        mutations = (
            lambda rows: rows[0]["provenance"].update({"synthetic": True}),
            lambda rows: rows[0]["provenance"].update({"qa_overlay": True}),
            lambda rows: rows[1].update({"id": rows[0]["id"]}),
        )
        for mutate in mutations:
            with (
                self.subTest(mutate=mutate),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                rows = make_fixture_rows()
                mutate(rows)
                master = root / "manifest.jsonl"
                write_jsonl(master, rows)
                with self.assertRaises(PILOT.PilotInventoryError):
                    PILOT.build_bundle(
                        master,
                        config=PILOT.BuildConfig(pilot_size=60),
                        expected_rows=len(rows),
                        expected_works=3,
                        expected_chapters=12,
                        expected_manual_recrops=3,
                    )

    def test_written_bundle_rebuild_validation_detects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows, master, bundle = self.build_fixture(root)
            output = root / "output"
            PILOT.write_bundle(output, bundle)
            result = PILOT.validate_bundle(
                output,
                master,
                expected_rows=len(rows),
                expected_works=3,
                expected_chapters=12,
                expected_manual_recrops=3,
            )
            self.assertEqual(result["status"], "valid")
            with (output / "inventory.jsonl").open("ab") as handle:
                handle.write(b"\n")
            with self.assertRaisesRegex(PILOT.PilotInventoryError, "hash"):
                PILOT.validate_bundle(
                    output,
                    master,
                    expected_rows=len(rows),
                    expected_works=3,
                    expected_chapters=12,
                    expected_manual_recrops=3,
                )

    def test_production_cli_rejects_out_of_range_pilot_size(self) -> None:
        with self.assertRaises(Exception):
            PILOT.production_pilot_size("999")
        self.assertEqual(PILOT.production_pilot_size("1200"), 1200)


if __name__ == "__main__":
    unittest.main()
