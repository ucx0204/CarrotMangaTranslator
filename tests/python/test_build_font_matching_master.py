from __future__ import annotations

import copy
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "build_font_matching_master.py"
SPEC = importlib.util.spec_from_file_location("build_font_matching_master", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load master builder: {SCRIPT_PATH}")
MASTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MASTER
SPEC.loader.exec_module(MASTER)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def write_view(root: Path, relative: str, color: tuple[int, int, int]) -> str:
    path = root / Path(*Path(relative).parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (224, 224), color).save(path, format="PNG", optimize=False)
    return file_digest(path)


def write_native(
    root: Path,
    relative: str,
    color: tuple[int, int, int],
    size: tuple[int, int],
) -> str:
    path = root / Path(*Path(relative).parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path, format="PNG", optimize=False)
    return file_digest(path)


class MasterFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.base = root / "base"
        self.hard = root / "hard"
        self.library = root / "library"
        self.output = root / "master"
        self.base_rows: list[dict] = []
        self.hard_rows: list[dict] = []

    def add_base(
        self,
        item_id: str,
        work_id: str,
        *,
        glyph_group: str | None = None,
        split: str = "train",
        crop_hash: str | None = None,
    ) -> dict:
        raw = f"images/clip_224/{split}/{item_id}.png"
        context = f"images/masked_context_224/{split}/{item_id}.png"
        glyph = f"images/masked_glyph_224/{split}/{item_id}.png"
        source_path = f"works/{work_id}/chapters/chapter-{work_id}/pages/{item_id}.png"
        write_view(self.base, raw, (220, 220, 220))
        context_sha = write_view(self.base, context, (180, 180, 180))
        glyph_sha = write_view(self.base, glyph, (20, 20, 20))
        page_sha = write_native(self.library, source_path, (70, 80, 90), (10, 14))
        page_bytes = (self.library / Path(*Path(source_path).parts)).stat().st_size
        row = {
            "audit_history": [{"decision": "pass", "reviewer": "unit-test"}],
            "audit_status": "accepted",
            "bbox_px": [1, 2, 30, 40],
            "chapter_id": f"chapter-{work_id}",
            "chapter_title": "Chapter",
            "clip_image_path": raw,
            "context_224_path": context,
            "crop_bbox_px": [0, 0, 32, 42],
            "crop_sha256": crop_hash or digest(f"crop:{item_id}"),
            "final_bbox_px": [1, 1, 31, 41],
            "glyph_224_mode": "RGB",
            "glyph_224_path": glyph,
            "glyph_white_composite_sha256": glyph_group or digest(f"glyph:{item_id}"),
            "id": item_id,
            "mask_asset_sha256": {
                "context_224": context_sha,
                "glyph_224": glyph_sha,
            },
            "mask_tight_bbox_px": [2, 2, 30, 40],
            "ocr_text": "テスト",
            "orientation": "horizontal",
            "page_id": f"page-{item_id}",
            "page_name": "001.png",
            "page_size_px": [10, 14],
            "provenance": "ocr-hints/result.json",
            "schema_version": 1,
            "source_image_path": source_path,
            "source_page_content_signature": {
                "sha256": page_sha,
                "size": page_bytes,
            },
            "source_page_sha256": page_sha,
            "split": split,
            "tier": "A",
            "work_id": work_id,
            "work_title": f"Work {work_id}",
        }
        self.base_rows.append(row)
        return row

    def add_hard(
        self,
        item_id: str,
        work_id: str,
        *,
        glyph_group: str | None = None,
        split: str = "train",
        root_group: str | None = None,
        variant_group: str | None = None,
        crop_hash: str | None = None,
    ) -> dict:
        context = f"images/context_224/{split}/{item_id}.png"
        glyph = f"images/glyph_224/{split}/{item_id}.png"
        raw = f"images/raw/{split}/{item_id}.png"
        source_path = f"works/{work_id}/chapters/chapter-{work_id}/pages/{item_id}.png"
        context_sha = write_view(self.hard, context, (160, 160, 160))
        glyph_sha = write_view(self.hard, glyph, (10, 10, 10))
        raw_sha = write_native(self.hard, raw, (90, 90, 90), (96, 72))
        page_sha = write_native(self.library, source_path, (40, 50, 60), (10, 14))
        page_bytes = (self.library / Path(*Path(source_path).parts)).stat().st_size
        root_group = root_group or f"root-{item_id}"
        variant_group = variant_group or root_group
        row = {
            "adjudication": {
                "exhaustive_visual_review_passed": True,
                "synthetic": False,
            },
            "assets": {
                "raw": {
                    "file_sha256": raw_sha,
                    "kind": "raw",
                    "mode": "RGB",
                    "path": raw,
                    "provenance": "real_preserved",
                    "size_px": [96, 72],
                },
                "context_224": {
                    "file_sha256": context_sha,
                    "kind": "context_224",
                    "mode": "RGB",
                    "path": context,
                    "size_px": [224, 224],
                },
                "glyph_224": {
                    "file_sha256": glyph_sha,
                    "kind": "glyph_224",
                    "mode": "RGB",
                    "path": glyph,
                    "size_px": [224, 224],
                },
            },
            "bbox_px": [5, 6, 50, 80],
            "chapter_id": f"chapter-{work_id}",
            "chapter_title": "Chapter",
            # The real hard catalog exposes glyph_224 under this legacy alias.
            "clip_image_path": glyph,
            "context_224_path": context,
            "crop_bbox_px": [4, 5, 51, 81],
            "crop_sha256": crop_hash or digest(f"crop:{item_id}"),
            "final_bbox_px": [5, 6, 50, 80],
            "glyph_224_path": glyph,
            "glyph_white_composite_sha256": glyph_group or digest(f"glyph:{item_id}"),
            "id": item_id,
            "mask_tight_bbox_px": [6, 7, 49, 79],
            "orientation": "vertical",
            "page_id": f"page-{item_id}",
            "page_name": "002.png",
            "page_size_px": [10, 14],
            "processing": {"diagnostic_overlay_written": False},
            "provenance": "real_processed",
            "quality": {"status": "pass"},
            "review": {"status": "accepted"},
            "root_real_id": root_group,
            "raw_image_path": raw,
            "schema_version": 1,
            "source_image_path": source_path,
            "source_page_asset": {
                "file_sha256": page_sha,
                "path": source_path,
                "provenance": "real_preserved",
                "size_px": [10, 14],
                "storage_root": "library_root",
            },
            "source_page_content_signature": {
                "sha256": page_sha,
                "size": page_bytes,
            },
            "source_page_sha256": page_sha,
            "split": split,
            "style_metrics": {"inverse_likelihood": 0.2},
            "synthetic": False,
            "synthetic_provenance": None,
            "tier": "B",
            "variant_group_id": variant_group,
            "work_id": work_id,
            "work_title": f"Work {work_id}",
        }
        self.hard_rows.append(row)
        return row

    def save(self) -> None:
        write_jsonl(self.base / "manifest.jsonl", self.base_rows)
        write_jsonl(self.hard / "manifest.jsonl", self.hard_rows)

    def catalogs(self):
        return [
            MASTER.SourceCatalog("fontclip-accepted-v1", "base", self.base),
            MASTER.SourceCatalog("fontclip-hard-accepted-v2", "hard", self.hard),
        ]

    def build(self, *, verify_assets: bool = False):
        self.save()
        return MASTER.build_bundle(
            self.catalogs(),
            expected_counts={
                "fontclip-accepted-v1": len(self.base_rows),
                "fontclip-hard-accepted-v2": len(self.hard_rows),
            },
            expected_total=len(self.base_rows) + len(self.hard_rows),
            split_ratios={"train": 0.6, "val": 0.2, "test": 0.2},
            split_seed="unit-test",
            verify_assets=verify_assets,
            library_root=self.library,
        )


class FontMatchingMasterTests(unittest.TestCase):
    def make_fixture(self, root: Path) -> MasterFixture:
        fixture = MasterFixture(root)
        shared = digest("shared-normalized-glyph")
        fixture.add_base("base-a1", "work-a", glyph_group=shared, split="test")
        fixture.add_base("base-a2", "work-a", split="train")
        fixture.add_base("base-b1", "work-b", split="val")
        reviewed = fixture.add_hard(
            "hard-c1", "work-c", glyph_group=shared, split="val"
        )
        reviewed["quality"] = {
            "failure_reasons": ["many_components_review"],
            "status": "review",
        }
        reviewed["candidate_metadata"] = {
            "candidate_evidence": [{"kind": "layout_detection", "score": 0.91}],
            "candidate_score": 0.91,
            "categories": ["text_free", "free_near_bubble"],
            "primary_category": "text_free",
        }
        reviewed["adjudication"]["manual_recrop"] = True
        reviewed["style_metrics"] = {
            "color_mask_overlap_ratio": 0.25,
            "inverse_likelihood": 0.75,
            "outline_fill_pixels": 10,
            "outline_outer_ring_pixels": 4,
            "outline_stroke_pixels": 6,
            "outline_structure_ratio": 0.4,
        }
        fixture.add_hard("hard-d1", "work-d", split="train")
        fixture.add_hard("hard-e1", "work-e", split="test")
        return fixture

    def test_builds_zero_copy_three_view_contract_and_validates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.make_fixture(Path(temporary))
            bundle = fixture.build(verify_assets=True)
            MASTER.write_bundle(fixture.output, bundle)
            self.assertEqual(
                {path.name for path in fixture.output.iterdir()},
                {"manifest.jsonl", "split_map.json", "report.json"},
            )
            rows = read_jsonl(fixture.output / "manifest.jsonl")
            self.assertEqual(len(rows), 6)
            self.assertEqual(len({row["id"] for row in rows}), 6)
            self.assertEqual(len({row["sample_crop_sha256"] for row in rows}), 6)
            self.assertTrue(
                all(set(row["views"]) == set(MASTER.VIEW_NAMES) for row in rows)
            )

            base_rows = [
                row
                for row in rows
                if row["provenance"]["source_catalog_id"] == "fontclip-accepted-v1"
            ]
            hard_rows = [
                row
                for row in rows
                if row["provenance"]["source_catalog_id"] == "fontclip-hard-accepted-v2"
            ]
            self.assertTrue(
                all(
                    row["views"]["raw_224"]["status"] == "available"
                    for row in base_rows
                )
            )
            self.assertTrue(
                all(
                    row["views"]["raw_224"]["status"] == "derivable"
                    for row in hard_rows
                )
            )
            self.assertTrue(
                all(row["views"]["raw_224"]["path"] is None for row in hard_rows)
            )
            self.assertTrue(
                all(
                    row["views"]["raw_224"]["source_native"]["path"].startswith(
                        "images/raw/"
                    )
                    for row in hard_rows
                )
            )
            self.assertTrue(
                all(
                    row["views"]["raw_224"]["materialization_recipe"]["operation"]
                    == "aspect_preserving_letterbox"
                    for row in hard_rows
                )
            )
            self.assertTrue(
                all(
                    row["page"]["source_locator"]["storage_root"] == "library_root"
                    for row in rows
                )
            )
            reviewed = next(
                row for row in hard_rows if row["provenance"]["source_id"] == "hard-c1"
            )
            self.assertEqual(
                reviewed["metadata"]["candidate_categories"],
                ["text_free", "free_near_bubble"],
            )
            self.assertEqual(
                reviewed["metadata"]["candidate_metadata"]["candidate_evidence"],
                [{"kind": "layout_detection", "score": 0.91}],
            )
            self.assertEqual(
                reviewed["metadata"]["candidate_primary_category"], "text_free"
            )
            self.assertEqual(reviewed["metadata"]["candidate_score"], 0.91)
            self.assertTrue(reviewed["metadata"]["cohort_signals"]["manual_recrop"])
            self.assertTrue(
                reviewed["metadata"]["cohort_signals"]["outline_signal_present"]
            )
            self.assertEqual(bundle.report["outputs"]["asset_files_copied"], 0)
            self.assertEqual(
                bundle.report["asset_verification"]["available_224"][
                    "verified_file_hash_and_decode_count"
                ],
                15,
            )
            self.assertEqual(
                bundle.report["asset_verification"]["derivable_raw_native"][
                    "verified_file_hash_and_decode_count"
                ],
                3,
            )
            self.assertEqual(
                bundle.report["asset_verification"]["source_page_locators"][
                    "verified_file_hash_and_decode_count"
                ],
                6,
            )
            result = MASTER.validate_master(
                fixture.output,
                fixture.catalogs(),
                expected_total=6,
                verify_assets=True,
                library_root=fixture.library,
            )
            self.assertEqual(result["status"], "valid")

    def test_global_split_replaces_legacy_splits_and_groups_cross_work_duplicates(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.make_fixture(Path(temporary))
            bundle = fixture.build()
            rows = bundle.records
            work_splits: dict[str, set[str]] = {}
            for row in rows:
                work_splits.setdefault(row["work"]["id"], set()).add(row["split"])
            self.assertTrue(all(len(splits) == 1 for splits in work_splits.values()))
            self.assertEqual(work_splits["work-a"], work_splits["work-c"])
            self.assertEqual(
                bundle.report["statistics"]["group_statistics"]["normalized_glyph"][
                    "cross_work_group_count"
                ],
                1,
            )
            self.assertEqual(
                bundle.report["statistics"]["work_balance"]["work_split_violations"],
                0,
            )
            self.assertEqual(
                bundle.report["statistics"]["work_balance"]["split_work_count"],
                {"test": 1, "train": 3, "val": 1},
            )
            glyph_stats = bundle.report["statistics"]["group_statistics"]
            glyph_stats = glyph_stats["normalized_glyph"]
            self.assertEqual(glyph_stats["duplicate_extra_row_count"], 1)
            self.assertEqual(glyph_stats["affected_row_count"], 2)
            self.assertEqual(
                sum(
                    bundle.report["statistics"]["work_balance"][
                        "split_effective_work_weight"
                    ].values()
                ),
                5.0,
            )

    def test_default_24_work_gate_is_exact_with_connected_pair(self) -> None:
        components = [
            {
                "id": "connected-pair",
                "sample_count": 720,
                "work_count": 2,
                "work_ids": ["work-00", "work-01"],
            }
        ]
        components.extend(
            {
                "id": f"component-{index:02d}",
                "sample_count": 100 + index * 17,
                "work_count": 1,
                "work_ids": [f"work-{index + 2:02d}"],
            }
            for index in range(22)
        )
        assignment = MASTER.assign_components(
            components,
            ratios=MASTER.DEFAULT_SPLIT_RATIOS,
            work_targets=MASTER.DEFAULT_WORK_TARGETS,
            seed="unit-test-24",
        )
        observed = {"train": 0, "val": 0, "test": 0}
        for component in components:
            observed[assignment[component["id"]]] += component["work_count"]
        self.assertEqual(observed, {"train": 15, "val": 4, "test": 5})

    def test_output_is_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.make_fixture(Path(temporary))
            first = fixture.build()
            MASTER.sha256_file.cache_clear()
            second = fixture.build()
            self.assertEqual(first.manifest_bytes, second.manifest_bytes)
            self.assertEqual(first.split_map_bytes, second.split_map_bytes)
            self.assertEqual(first.report_bytes, second.report_bytes)

    def test_rejects_synthetic_and_overlay_records(self) -> None:
        mutations = (
            lambda row: row.update({"synthetic": True}),
            lambda row: row.update(
                {"processing": {"diagnostic_overlay_written": True}}
            ),
            lambda row: row.update(
                {
                    "glyph_224_path": "images/qa-overlay/item.png",
                    "clip_image_path": "images/qa-overlay/item.png",
                }
            ),
        )
        for mutate in mutations:
            with (
                self.subTest(mutation=mutate),
                tempfile.TemporaryDirectory() as temporary,
            ):
                fixture = MasterFixture(Path(temporary))
                row = fixture.add_hard("hard-a", "work-a")
                mutate(row)
                fixture.save()
                with self.assertRaises(MASTER.MasterManifestError):
                    fixture.build()

    def test_rejects_duplicate_source_ids_and_crop_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MasterFixture(Path(temporary))
            shared_crop = digest("same-crop")
            fixture.add_base("base-a", "work-a", crop_hash=shared_crop)
            fixture.add_hard("hard-a", "work-b", crop_hash=shared_crop)
            fixture.save()
            with self.assertRaisesRegex(
                MASTER.MasterManifestError, "duplicate crop SHA-256"
            ):
                fixture.build()

        with tempfile.TemporaryDirectory() as temporary:
            fixture = MasterFixture(Path(temporary))
            first = fixture.add_base("base-a", "work-a")
            duplicate = copy.deepcopy(first)
            duplicate["crop_sha256"] = digest("different-crop")
            fixture.base_rows.append(duplicate)
            fixture.save()
            with self.assertRaisesRegex(
                MASTER.MasterManifestError, "duplicate master id"
            ):
                fixture.build()

    def test_validator_rejects_invalid_nullable_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.make_fixture(Path(temporary))
            bundle = fixture.build()
            MASTER.write_bundle(fixture.output, bundle)
            rows = read_jsonl(fixture.output / "manifest.jsonl")
            hard = next(
                row
                for row in rows
                if row["provenance"]["source_catalog_id"] == "fontclip-hard-accepted-v2"
            )
            hard["views"]["raw_224"]["path"] = "images/raw/fake.png"
            payload = MASTER.jsonl_bytes(rows)
            (fixture.output / "manifest.jsonl").write_bytes(payload)
            report = json.loads(
                (fixture.output / "report.json").read_text(encoding="utf-8")
            )
            report["outputs"]["master_manifest_sha256"] = MASTER.sha256_bytes(payload)
            (fixture.output / "report.json").write_bytes(
                MASTER.json_bytes(report, pretty=True)
            )
            with self.assertRaisesRegex(
                MASTER.MasterManifestError,
                "derivable view must have null materialized path",
            ):
                MASTER.validate_master(
                    fixture.output,
                    fixture.catalogs(),
                    expected_total=6,
                    verify_assets=False,
                )

    def test_rejects_unsafe_source_page_locator(self) -> None:
        for unsafe in ("../escape.png", "works/qa-overlay/page.png"):
            with self.subTest(path=unsafe), tempfile.TemporaryDirectory() as temporary:
                fixture = MasterFixture(Path(temporary))
                row = fixture.add_base("base-a", "work-a")
                row["source_image_path"] = unsafe
                fixture.save()
                with self.assertRaises(MASTER.MasterManifestError):
                    fixture.build()

    def test_cli_dry_run_and_report_create_no_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.make_fixture(Path(temporary))
            fixture.save()
            target = Path(temporary) / "must-not-exist"
            common = [
                "--base-root",
                str(fixture.base),
                "--hard-root",
                str(fixture.hard),
                "--library-root",
                str(fixture.library),
                "--expected-base",
                "3",
                "--expected-hard",
                "3",
                "--expected-total",
                "6",
                "--work-targets",
                "train=3,val=1,test=1",
            ]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = MASTER.main(
                    ["build", *common, "--output-dir", str(target), "--dry-run"]
                )
            self.assertEqual(code, 0)
            self.assertFalse(target.exists())
            self.assertEqual(
                json.loads(output.getvalue())["statistics"]["record_count"], 6
            )

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = MASTER.main(["report", *common])
            self.assertEqual(code, 0)
            self.assertFalse(target.exists())
            self.assertEqual(
                json.loads(output.getvalue())["statistics"]["record_count"], 6
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
