from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "build_font_matching_pilot.py"
SPEC = importlib.util.spec_from_file_location("build_font_matching_pilot", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load pilot builder: {SCRIPT_PATH}")
PILOT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PILOT
SPEC.loader.exec_module(PILOT)

BASE_CATALOG_ID = "fixture-base"
HARD_CATALOG_ID = "fixture-hard"
DELTA_HARD_CATALOG_ID = "fixture-hard-delta"


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


def write_master_report(
    master: Path, rows: list[dict], *, path: Path | None = None
) -> Path:
    catalog_counts = Counter(row["provenance"]["source_catalog_id"] for row in rows)
    catalog_kinds: dict[str, str] = {}
    for row in rows:
        provenance = row["provenance"]
        catalog_id = provenance["source_catalog_id"]
        source_kind = provenance["source_kind"]
        previous = catalog_kinds.setdefault(catalog_id, source_kind)
        if previous != source_kind:
            raise AssertionError("fixture catalog has mixed source kinds")
    report = {
        "inputs": {
            "catalogs": {
                catalog_id: {
                    "catalog_id": catalog_id,
                    "record_count": catalog_counts[catalog_id],
                    "source_kind": catalog_kinds[catalog_id],
                }
                for catalog_id in sorted(catalog_counts)
            }
        },
        "outputs": {
            "master_manifest_sha256": hashlib.sha256(master.read_bytes()).hexdigest()
        },
        "statistics": {
            "chapter_count": len(
                {(row["work"]["id"], row["chapter"]["id"]) for row in rows}
            ),
            "record_count": len(rows),
            "work_balance": {"work_count": len({row["work"]["id"] for row in rows})},
        },
        "tool": PILOT.MASTER_TOOL_ID,
    }
    output = path or master.with_name("report.json")
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return output


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
    catalog_id: str = HARD_CATALOG_ID,
    source_kind: str = "hard",
    orientation: str = "vertical",
    categories: list[str] | None = None,
    primary: str | None = None,
    signals: dict | None = None,
    split: str = "train",
) -> dict:
    is_base = source_kind == "base"
    return {
        "chapter": {"id": chapter_id, "title": chapter_id},
        "id": sample_id,
        "metadata": {
            "candidate_categories": [] if is_base else (categories or ["bubble_edge"]),
            "candidate_primary_category": (
                None if is_base else (primary or "bubble_edge")
            ),
            "cohort_signals": (
                base_signals() if is_base else (signals or hard_signals())
            ),
            "orientation": orientation,
        },
        "page": {"id": page_id},
        "provenance": {
            "qa_overlay": False,
            "source_catalog_id": catalog_id,
            "source_kind": source_kind,
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
                            catalog_id=BASE_CATALOG_ID,
                            source_kind="base",
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
        master_report = write_master_report(master, rows)
        bundle = PILOT.build_bundle(
            master,
            config=PILOT.BuildConfig(pilot_size=pilot_size, seed="unit-test"),
            master_report=master_report,
        )
        return rows, master, bundle

    def test_deterministic_pilot_covers_all_chapters_and_manual_recrops(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows, master, first = self.build_fixture(root)
            second = PILOT.build_bundle(
                master,
                config=PILOT.BuildConfig(pilot_size=60, seed="unit-test"),
                master_report=master.with_name("report.json"),
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
            master_report_hash = hashlib.sha256(
                master.with_name("report.json").read_bytes()
            ).hexdigest()
            self.assertEqual(
                first.report["inputs"]["master_report_sha256"], master_report_hash
            )
            self.assertEqual(
                first.report["inputs"]["master_report_contract"]["chapter_count"], 12
            )
            self.assertTrue(
                all(
                    row["master_report_sha256"] == master_report_hash
                    for row in first.inventory_rows
                )
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
            self.assertTrue(
                all(
                    row["provenance"]["source_kind"] in {"base", "hard"}
                    for row in inventory
                )
            )
            self.assertEqual(
                bundle.report["selection"]["source"]["by_source_kind"],
                {"base": 48, "hard": 96},
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
            self.assertEqual(diagnostics["test_holdout_count"], 48)
            self.assertEqual(diagnostics["test_manual_recrop_holdout_count"], 1)
            targets = diagnostics["ordinary_target_by_chapter"]
            self.assertTrue(targets)
            self.assertTrue(all(4 <= value <= 6 for value in targets.values()))
            split_by_id = {
                row["sample_id"]: row["split"] for row in bundle.inventory_rows
            }
            self.assertTrue(
                all(
                    split_by_id[sample_id] != "test"
                    for sample_id in bundle.calibration_ids
                )
            )
            risk_ids = {
                row["sample_id"]
                for row in bundle.inventory_rows
                if "hard_risk_union" in row["cohorts"]
                and row["split"] in {"train", "val"}
            }
            self.assertTrue(risk_ids <= set(bundle.calibration_ids))
            self.assertEqual(
                bundle.report["coverage"]["calibration_test_holdout_count"], 48
            )
            self.assertEqual(
                bundle.report["coverage"][
                    "calibration_test_manual_recrop_holdout_count"
                ],
                1,
            )

    def test_accepts_third_hard_catalog_from_dynamic_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            delta_ids = set()
            for row in rows[:6]:
                row["provenance"]["source_catalog_id"] = DELTA_HARD_CATALOG_ID
                row["provenance"]["source_kind"] = "hard"
                delta_ids.add(row["id"])
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            master_report = write_master_report(master, rows)
            report = json.loads(master_report.read_text(encoding="utf-8"))
            report["inputs"]["catalogs"]["fixture-empty-hard-delta"] = {
                "catalog_id": "fixture-empty-hard-delta",
                "record_count": 0,
                "source_kind": "hard",
            }
            report["statistics"]["by_catalog"] = dict(
                sorted(
                    Counter(
                        row["provenance"]["source_catalog_id"] for row in rows
                    ).items()
                )
            )
            report["statistics"]["by_source_kind"] = dict(
                sorted(
                    Counter(row["provenance"]["source_kind"] for row in rows).items()
                )
            )
            master_report.write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            bundle = PILOT.build_bundle(
                master,
                config=PILOT.BuildConfig(pilot_size=60, seed="unit-test"),
                master_report=master_report,
            )
            self.assertEqual(
                bundle.report["inputs"]["catalogs"][DELTA_HARD_CATALOG_ID],
                {
                    "catalog_id": DELTA_HARD_CATALOG_ID,
                    "record_count": 6,
                    "source_kind": "hard",
                },
            )
            self.assertEqual(
                bundle.report["inputs"]["catalogs"]["fixture-empty-hard-delta"][
                    "record_count"
                ],
                0,
            )
            selected_delta = {
                row["sample_id"]
                for row in bundle.inventory_rows
                if row["provenance"]["source_catalog_id"] == DELTA_HARD_CATALOG_ID
            }
            self.assertTrue(selected_delta)
            self.assertTrue(selected_delta <= delta_ids)
            self.assertTrue(
                all(
                    row["provenance"]["source_kind"] == "hard"
                    for row in bundle.inventory_rows
                    if row["sample_id"] in selected_delta
                )
            )

    def test_rejects_catalog_source_kind_mismatch_and_missing_row_kind(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            report_path = write_master_report(master, rows)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["inputs"]["catalogs"][HARD_CATALOG_ID]["source_kind"] = "base"
            report_path.write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                PILOT.PilotInventoryError, "source_kind mismatch"
            ):
                PILOT.build_bundle(
                    master,
                    config=PILOT.BuildConfig(pilot_size=60),
                    master_report=report_path,
                )

            del rows[0]["provenance"]["source_kind"]
            write_jsonl(master, rows)
            with self.assertRaisesRegex(
                PILOT.PilotInventoryError,
                r"provenance\.source_kind: expected a non-empty string",
            ):
                PILOT.build_bundle(
                    master,
                    config=PILOT.BuildConfig(pilot_size=60),
                    expected_rows=len(rows),
                    expected_works=3,
                    expected_chapters=12,
                )

    def test_dynamic_master_report_counts_and_hash_are_sealed(self) -> None:
        mutations = (
            (
                "chapter count",
                lambda report: report["statistics"].update(
                    {"chapter_count": report["statistics"]["chapter_count"] + 1}
                ),
                "chapters",
            ),
            (
                "catalog count",
                lambda report: report["inputs"]["catalogs"][HARD_CATALOG_ID].update(
                    {
                        "record_count": report["inputs"]["catalogs"][HARD_CATALOG_ID][
                            "record_count"
                        ]
                        + 1
                    }
                ),
                "catalog counts",
            ),
            (
                "manifest hash",
                lambda report: report["outputs"].update(
                    {"master_manifest_sha256": "0" * 64}
                ),
                "manifest hash",
            ),
        )
        for label, mutate, message in mutations:
            with (
                self.subTest(label=label),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                rows = make_fixture_rows()
                master = root / "manifest.jsonl"
                write_jsonl(master, rows)
                report_path = write_master_report(master, rows)
                report = json.loads(report_path.read_text(encoding="utf-8"))
                mutate(report)
                report_path.write_text(
                    json.dumps(report, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(PILOT.PilotInventoryError, message):
                    PILOT.build_bundle(
                        master,
                        config=PILOT.BuildConfig(pilot_size=60),
                        master_report=report_path,
                    )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            report_path = write_master_report(master, rows)
            with self.assertRaisesRegex(
                PILOT.PilotInventoryError, "disagrees with master report"
            ):
                PILOT.build_bundle(
                    master,
                    config=PILOT.BuildConfig(pilot_size=60),
                    master_report=report_path,
                    expected_rows=len(rows) + 1,
                )

    def test_direct_api_legacy_fixture_uses_optional_expected_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            bundle = PILOT.build_bundle(
                master,
                config=PILOT.BuildConfig(pilot_size=60, seed="legacy-fixture"),
                expected_rows=len(rows),
                expected_works=3,
                expected_chapters=12,
                expected_manual_recrops=3,
            )
            self.assertIsNone(bundle.report["inputs"]["master_report_sha256"])
            self.assertTrue(
                all(
                    row["master_report_sha256"] is None for row in bundle.inventory_rows
                )
            )

    def test_reports_ordinary_proxy_shortfall_without_inventing_a_role(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = make_fixture_rows()
            affected = ("work-0", "chapter-0-0")
            for row in rows:
                if (row["work"]["id"], row["chapter"]["id"]) == affected:
                    row["provenance"]["source_catalog_id"] = HARD_CATALOG_ID
                    row["provenance"]["source_kind"] = "hard"
                    row["metadata"]["candidate_categories"] = ["page_sound"]
                    row["metadata"]["candidate_primary_category"] = "page_sound"
                    row["metadata"]["cohort_signals"] = hard_signals()
            # Preserve the fixture-wide contract of exactly three recrops.
            rows[4]["metadata"]["cohort_signals"]["manual_recrop"] = True
            master = root / "manifest.jsonl"
            write_jsonl(master, rows)
            master_report = write_master_report(master, rows)
            bundle = PILOT.build_bundle(
                master,
                config=PILOT.BuildConfig(pilot_size=60, seed="unit-test"),
                master_report=master_report,
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
            (output / "inventory.jsonl").write_bytes(bundle.inventory_bytes)
            master_report = master.with_name("report.json")
            report = json.loads(master_report.read_text(encoding="utf-8"))
            report["tampered"] = True
            master_report.write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                PILOT.PilotInventoryError, "master report hash"
            ):
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
        parsed = PILOT.build_parser().parse_args(["validate"])
        self.assertIsNone(parsed.master_report)
        self.assertIsNone(parsed.expected_master_count)
        self.assertIsNone(parsed.expected_work_count)
        self.assertIsNone(parsed.expected_chapter_count)
        self.assertIsNone(parsed.expected_manual_recrop_count)


if __name__ == "__main__":
    unittest.main()
