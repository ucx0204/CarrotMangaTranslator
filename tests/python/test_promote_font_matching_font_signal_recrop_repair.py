from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


PROMOTION = load_script(
    "font_signal_recrop_promotion",
    "promote_font_matching_font_signal_recrop_repair.py",
)
REGISTRY = load_script(
    "font_matching_catalog_registry_test_helper",
    "build_font_matching_catalog_registry.py",
)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PROMOTION.json_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PROMOTION.jsonl_bytes(rows))


class PromotionFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.library = root / "library"
        self.final = root / "final-v3"
        self.master = root / "master-v2"
        self.catalog = root / "source-hard"
        self.registry_dir = root / "registry"
        self.registry = self.registry_dir / "current.json"
        self.output = root / "published" / "font-signal-delta"
        self.work_id = "work-a"
        self.chapter_id = "chapter-a"
        self.page_id = "page-a"
        self.source_id = "hard-source-a"
        self.catalog_id = "source-hard-v1"
        self.sample_id = PROMOTION._master_id(self.catalog_id, self.source_id)
        self.page_relative = (
            f"works/{self.work_id}/chapters/{self.chapter_id}/pages/page-a.png"
        )
        self.bbox = [18, 15, 72, 78]
        self.context_bbox = [8, 6, 91, 91]
        self._build()

    def _build(self) -> None:
        self.library.mkdir(parents=True)
        page = Image.new("RGB", (120, 100), (247, 244, 238))
        draw = ImageDraw.Draw(page)
        draw.rectangle((20, 18, 68, 72), fill=(255, 255, 255))
        draw.line((31, 23, 31, 65), fill=(20, 20, 20), width=4)
        draw.line((44, 19, 44, 69), fill=(45, 45, 45), width=5)
        draw.line((56, 25, 64, 62), fill=(5, 5, 5), width=4)
        page_path = self.library / Path(*Path(self.page_relative).parts)
        page_path.parent.mkdir(parents=True)
        page.save(page_path, format="PNG", optimize=False)
        page.close()
        page_payload = page_path.read_bytes()
        page_sha = PROMOTION.sha256_bytes(page_payload)

        source_row = {"id": self.source_id, "provenance": "real_processed"}
        self.catalog.mkdir()
        write_jsonl(self.catalog / "manifest.jsonl", [source_row])
        source_line = (self.catalog / "manifest.jsonl").read_bytes().splitlines()[0]
        source_line_sha = PROMOTION.sha256_bytes(source_line)

        parent = {
            "catalog_version": 1,
            "chapter": {"id": self.chapter_id, "title": "Chapter A"},
            "font_label": None,
            "geometry": {
                "bbox_px": [25, 20, 40, 50],
                "crop_bbox_px": [23, 18, 42, 52],
                "final_bbox_px": [20, 15, 45, 55],
                "mask_tight_bbox_px": [25, 20, 40, 50],
                "page_size_px": [120, 100],
            },
            "groups": {
                "normalized_glyph": "glyph-white-sha256:" + "a" * 64,
                "root": f"{self.catalog_id}:root-a",
                "split_component": "component-a",
                "variant": f"{self.catalog_id}:root-a",
            },
            "id": self.sample_id,
            "label_status": "unlabeled",
            "legacy_split": "train",
            "metadata": {"orientation": "horizontal"},
            "page": {
                "id": self.page_id,
                "name": "page-a.png",
                "source_locator": {
                    "file_sha256": page_sha,
                    "path": self.page_relative,
                    "provenance": "real_preserved",
                    "resolution_contract": "resolve against caller-supplied library_root",
                    "size_bytes": len(page_payload),
                    "size_px": [120, 100],
                    "storage_root": "library_root",
                },
                "source_page_sha256": page_sha,
            },
            "provenance": {
                "approval": "exhaustive_manual_visual_review",
                "qa_overlay": False,
                "source_catalog_id": self.catalog_id,
                "source_id": self.source_id,
                "source_kind": "hard",
                "source_line_number": 1,
                "source_line_sha256": source_line_sha,
                "source_lineage": [],
                "source_provenance": "real_processed",
                "source_schema_version": 1,
                "synthetic": False,
            },
            "sample_crop_sha256": "b" * 64,
            "schema_version": PROMOTION.master.MASTER_SCHEMA_VERSION,
            "split": "train",
            "views": {},
            "work": {"id": self.work_id, "title": "Work A"},
            "work_balance_weight": 1.0,
        }
        self.master.mkdir()
        write_jsonl(self.master / "manifest.jsonl", [parent])
        self._refresh_master_report()

        split_map = {
            "schema_version": PROMOTION.master.SPLIT_MAP_SCHEMA_VERSION,
            "work_assignments": {self.work_id: "train"},
        }
        write_json(self.registry_dir / "split-map.json", split_map)
        snapshot = REGISTRY.build_registry_snapshot(
            catalog_specs=[(self.catalog_id, "hard", str(self.catalog))],
            exclusion_ledgers=[],
            parent_master_manifest=None,
            frozen_split_map=self.registry_dir / "split-map.json",
        )
        self.registry_dir.mkdir(exist_ok=True)
        self.registry.write_bytes(snapshot.payload)

        decoded = PROMOTION._decode_rgb(page_payload, "fixture page")
        accepted_crop = decoded.crop(tuple(self.bbox)).convert("RGB")
        context_crop = decoded.crop(tuple(self.context_bbox)).convert("RGB")
        try:
            accepted_payload = PROMOTION._png_bytes(accepted_crop)
            context_payload = PROMOTION._png_bytes(context_crop)
        finally:
            decoded.close()
            accepted_crop.close()
            context_crop.close()
        accepted_path = self.final / "accepted-images" / f"{self.sample_id}.png"
        context_path = self.final / "review-context" / f"{self.sample_id}.png"
        accepted_path.parent.mkdir(parents=True)
        context_path.parent.mkdir(parents=True)
        accepted_path.write_bytes(accepted_payload)
        context_path.write_bytes(context_payload)
        accepted = PROMOTION.seal(
            {
                "acceptance_basis": "double_review_consensus_revision",
                "accepted_bbox_px": copy.deepcopy(self.bbox),
                "accepted_for_downstream_training": True,
                "accepted_image": {
                    "bbox_px": copy.deepcopy(self.bbox),
                    "decoded_mode": "RGB",
                    "file_sha256": PROMOTION.sha256_bytes(accepted_payload),
                    "generated": False,
                    "path": f"accepted-images/{self.sample_id}.png",
                    "pixel_source": "direct_hash_verified_library_page_crop",
                    "qa_overlay": False,
                    "size_px": [
                        self.bbox[2] - self.bbox[0],
                        self.bbox[3] - self.bbox[1],
                    ],
                    "synthetic": False,
                },
                "bindings": {},
                "coordinate_space": "source_page_pixels_xyxy_half_open",
                "merged_into_existing_dataset": False,
                "orientation": "vertical",
                "record_type": "font_signal_accepted_repair",
                "review_consensus": {"primary_secondary_disagreement": False},
                "review_context": {
                    "bbox_px": copy.deepcopy(self.context_bbox),
                    "decoded_mode": "RGB",
                    "file_sha256": PROMOTION.sha256_bytes(context_payload),
                    "generated": False,
                    "path": f"review-context/{self.sample_id}.png",
                    "pixel_source": "direct_hash_verified_library_page_crop",
                    "qa_overlay": False,
                    "size_px": [
                        self.context_bbox[2] - self.context_bbox[0],
                        self.context_bbox[3] - self.context_bbox[1],
                    ],
                    "synthetic": False,
                },
                "sample_id": self.sample_id,
                "schema_version": PROMOTION.FINAL_SCHEMA_VERSION,
                "source_page": {
                    "decoded_mode": "RGB",
                    "file_sha256": page_sha,
                    "path": self.page_relative,
                    "provenance": "real_preserved",
                    "size_bytes": len(page_payload),
                    "size_px": [120, 100],
                    "storage_root": "library_root",
                },
                "source_pixels": "hash_verified_library_page_only",
                "status": "accepted_repair_final",
                "target_semantics": "one_complete_single_style_text_block",
                "training_eligible": True,
            }
        )
        write_jsonl(self.final / PROMOTION.FINAL_ACCEPTED, [accepted])
        write_jsonl(self.final / PROMOTION.FINAL_TERMINAL, [])
        self._refresh_final_metadata()

    def _refresh_master_report(self) -> None:
        rows = [
            json.loads(line)
            for line in (self.master / "manifest.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        write_json(
            self.master / "report.json",
            {
                "outputs": {
                    "master_manifest_sha256": PROMOTION.sha256_file(
                        self.master / "manifest.jsonl"
                    )
                },
                "statistics": {"record_count": len(rows)},
            },
        )

    def _refresh_final_metadata(self) -> None:
        accepted = [
            json.loads(line)
            for line in (self.final / PROMOTION.FINAL_ACCEPTED)
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        terminal = [
            json.loads(line)
            for line in (self.final / PROMOTION.FINAL_TERMINAL)
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        report = PROMOTION.seal(
            {
                "counts": {
                    "accepted_images": len(accepted),
                    "accepted_repairs": len(accepted),
                    "input_targets": len(accepted) + len(terminal),
                    "terminal_exclusions": len(terminal),
                    "unresolved_or_disagreed": 0,
                },
                "outputs": {
                    "accepted_repairs": PROMOTION.FINAL_ACCEPTED,
                    "accepted_repairs_sha256": PROMOTION.sha256_file(
                        self.final / PROMOTION.FINAL_ACCEPTED
                    ),
                    "terminal_exclusions": PROMOTION.FINAL_TERMINAL,
                    "terminal_exclusions_sha256": PROMOTION.sha256_file(
                        self.final / PROMOTION.FINAL_TERMINAL
                    ),
                },
                "record_type": "font_signal_recrop_repair_final_report",
                "schema_version": PROMOTION.FINAL_SCHEMA_VERSION,
            }
        )
        write_json(self.final / PROMOTION.FINAL_REPORT, report)
        managed = {
            path.relative_to(self.final).as_posix(): PROMOTION.sha256_file(path)
            for path in sorted(self.final.rglob("*"))
            if path.is_file() and path.name != PROMOTION.FINAL_MARKER
        }
        write_json(
            self.final / PROMOTION.FINAL_MARKER,
            {
                "declared_root": str(self.final),
                "immutable": True,
                "managed_files": managed,
                "owner": PROMOTION.FINAL_OWNER,
                "safe_replace": False,
                "schema_version": PROMOTION.FINAL_SCHEMA_VERSION,
            },
        )

    def rewrite_accepted(self, mutator: Callable[[list[dict[str, Any]]], None]) -> None:
        rows = [
            json.loads(line)
            for line in (self.final / PROMOTION.FINAL_ACCEPTED)
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        mutator(rows)
        sealed = []
        for row in rows:
            row = copy.deepcopy(row)
            row.pop("record_sha256", None)
            sealed.append(PROMOTION.seal(row))
        write_jsonl(self.final / PROMOTION.FINAL_ACCEPTED, sealed)
        self._refresh_final_metadata()

    def add_overlapping_terminal(self) -> None:
        row = PROMOTION.seal(
            {
                "excluded_from_downstream_training": True,
                "merged_into_existing_dataset": False,
                "record_type": "font_signal_terminal_exclusion",
                "sample_id": self.sample_id,
                "schema_version": PROMOTION.FINAL_SCHEMA_VERSION,
                "status": "terminal_exclusion_final",
                "terminal_category": "promo_overlay",
                "training_eligible": False,
            }
        )
        write_jsonl(self.final / PROMOTION.FINAL_TERMINAL, [row])
        self._refresh_final_metadata()

    def rewrite_master(self, mutator: Callable[[list[dict[str, Any]]], None]) -> None:
        rows = [
            json.loads(line)
            for line in (self.master / "manifest.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        mutator(rows)
        write_jsonl(self.master / "manifest.jsonl", rows)
        self._refresh_master_report()

    def args(
        self,
        command: str,
        *,
        expected_accepted: int = 1,
        expected_terminal: int = 0,
    ) -> list[str]:
        return [
            command,
            "--final-root",
            str(self.final),
            "--source-master-root",
            str(self.master),
            "--catalog-registry",
            str(self.registry),
            "--library-root",
            str(self.library),
            "--output-root",
            str(self.output),
            "--expected-accepted",
            str(expected_accepted),
            "--expected-terminal",
            str(expected_terminal),
        ]


class FontSignalRecropPromotionTests(unittest.TestCase):
    def test_glyph_normalization_handles_dark_and_light_polarities(self) -> None:
        dark_on_light = Image.new("RGB", (96, 72), (250, 250, 250))
        dark_draw = ImageDraw.Draw(dark_on_light)
        dark_draw.line((24, 14, 24, 57), fill=(15, 15, 15), width=7)
        dark_draw.line((24, 18, 65, 18), fill=(20, 20, 20), width=6)
        dark_draw.line((24, 38, 60, 38), fill=(35, 35, 35), width=6)
        dark_source_pixels = dark_on_light.tobytes()
        dark = PROMOTION._normalize_glyph(dark_on_light)
        try:
            self.assertEqual(dark.status, "pass")
            self.assertEqual(dark.statistics["selection"]["polarity"], "dark_on_light")
            self.assertLess(dark.glyph_224.convert("L").getextrema()[0], 40)
            self.assertEqual(dark_source_pixels, dark_on_light.tobytes())
        finally:
            dark.glyph_224.close()
            dark.normalized_native.close()
            dark_on_light.close()

        light_on_dark = Image.new("RGB", (96, 72), (8, 8, 8))
        light_draw = ImageDraw.Draw(light_on_dark)
        light_draw.line((22, 15, 22, 57), fill=(250, 250, 250), width=7)
        light_draw.line((22, 18, 66, 18), fill=(240, 240, 240), width=6)
        light_draw.line((22, 39, 58, 39), fill=(225, 225, 225), width=6)
        light = PROMOTION._normalize_glyph(light_on_dark)
        try:
            self.assertEqual(light.status, "pass")
            self.assertEqual(light.statistics["selection"]["polarity"], "light_on_dark")
            # The inverse source stroke must remain visible after compositing
            # on white, rather than disappearing as source-white RGB.
            self.assertLess(light.glyph_224.convert("L").getextrema()[0], 40)
        finally:
            light.glyph_224.close()
            light.normalized_native.close()
            light_on_dark.close()

    def test_glyph_normalization_preserves_outlined_colored_stroke_evidence(
        self,
    ) -> None:
        image = Image.new("RGB", (104, 80), (252, 252, 248))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle(
            (24, 14, 78, 62),
            radius=9,
            fill=(210, 35, 48),
            outline=(10, 10, 10),
            width=5,
        )
        draw.rectangle((46, 18, 55, 58), fill=(252, 252, 248))
        normalization = PROMOTION._normalize_glyph(image)
        try:
            self.assertEqual(normalization.status, "pass")
            self.assertGreater(
                normalization.statistics["ink"]["color_evidence_pixels"], 0
            )
            self.assertTrue(bool(normalization.mask[20, 30]))
            self.assertTrue(bool(normalization.mask[30, 70]))
            self.assertLess(normalization.glyph_224.convert("L").getextrema()[0], 40)
        finally:
            normalization.glyph_224.close()
            normalization.normalized_native.close()
            image.close()

    def test_manga_screentone_art_contamination_is_review_held(self) -> None:
        image = Image.new("RGB", (128, 96), "white")
        draw = ImageDraw.Draw(image)
        # Dense, disconnected screentone dots spanning the crop and its border
        # can look like strong glyph evidence unless the art gate is fail-closed.
        for y in range(1, 95, 9):
            for x in range(1, 127, 9):
                draw.rectangle((x, y, x + 2, y + 2), fill="black")
        normalization = PROMOTION._normalize_glyph(image)
        try:
            self.assertEqual(normalization.status, "review_hold")
            self.assertIn(
                "high_frequency_art_or_pattern_contamination",
                normalization.reasons,
            )
            self.assertGreaterEqual(
                normalization.statistics["ink"]["component_count"],
                PROMOTION.GLYPH_NORMALIZATION_CONTRACT["automatic_pass_gates"][
                    "art_pattern_minimum_component_count"
                ],
            )
            self.assertGreaterEqual(
                normalization.statistics["ink"]["tight_bbox_coverage_ratio"],
                PROMOTION.GLYPH_NORMALIZATION_CONTRACT["automatic_pass_gates"][
                    "art_pattern_minimum_tight_bbox_coverage_ratio"
                ],
            )
        finally:
            normalization.glyph_224.close()
            normalization.normalized_native.close()
            image.close()

    def test_blank_and_ambiguous_glyphs_are_review_held(self) -> None:
        blank = Image.new("RGB", (80, 60), "white")
        blank_normalization = PROMOTION._normalize_glyph(blank)
        try:
            self.assertEqual(blank_normalization.status, "review_hold")
            self.assertIn(
                "no_usable_polarity_or_color_mask",
                blank_normalization.reasons,
            )
        finally:
            blank_normalization.glyph_224.close()
            blank_normalization.normalized_native.close()
            blank.close()

        ambiguous = Image.new("RGB", (80, 60), "black")
        ImageDraw.Draw(ambiguous).rectangle((40, 0, 79, 59), fill="white")
        ambiguous_normalization = PROMOTION._normalize_glyph(ambiguous)
        try:
            self.assertEqual(ambiguous_normalization.status, "review_hold")
            self.assertTrue(
                {
                    "mid_background_competing_masks_disagree",
                    "unstable_border_background",
                }.intersection(ambiguous_normalization.reasons)
            )
        finally:
            ambiguous_normalization.glyph_224.close()
            ambiguous_normalization.normalized_native.close()
            ambiguous.close()

    def test_glyph_normalization_hashes_are_deterministic(self) -> None:
        image = Image.new("RGB", (91, 67), (248, 248, 244))
        draw = ImageDraw.Draw(image)
        draw.line((18, 13, 18, 54), fill=(20, 20, 20), width=6)
        draw.line((18, 17, 70, 17), fill=(175, 28, 44), width=7)
        draw.line((18, 38, 62, 38), fill=(30, 30, 30), width=5)
        first = PROMOTION._normalize_glyph(image)
        second = PROMOTION._normalize_glyph(image)
        try:
            self.assertEqual(first.status, "pass")
            self.assertEqual(second.status, "pass")
            self.assertEqual(
                PROMOTION._mask_sha256(first.mask),
                PROMOTION._mask_sha256(second.mask),
            )
            self.assertEqual(
                PROMOTION.sha256_bytes(PROMOTION._png_bytes(first.glyph_224)),
                PROMOTION.sha256_bytes(PROMOTION._png_bytes(second.glyph_224)),
            )
            self.assertEqual(first.statistics, second.statistics)
            self.assertEqual(first.transform, second.transform)
        finally:
            first.glyph_224.close()
            first.normalized_native.close()
            second.glyph_224.close()
            second.normalized_native.close()
            image.close()

    def test_preflight_is_read_only_and_reports_glyph_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            self.assertEqual(PROMOTION.main(fixture.args("preflight")), 0)
            self.assertFalse(fixture.output.exists())

    def test_build_validate_and_deterministic_rebuild_are_master_ingestible(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            self.assertEqual(PROMOTION.main(fixture.args("build")), 0)
            self.assertEqual(PROMOTION.main(fixture.args("validate")), 0)
            rows = PROMOTION._read_bound_jsonl(
                fixture.output / PROMOTION.MANIFEST_FILE, "published manifest"
            )
            self.assertEqual(len(rows), 1)
            row = rows[0].row
            self.assertIsNone(row["label"])
            self.assertTrue(row["font_signal_present"])
            self.assertTrue(row["manual_recrop"])
            self.assertEqual(row["font_label_review"]["priority"], "P1")
            self.assertEqual(
                row["font_label_review"]["required_stages"],
                ["blind_primary", "blind_independent_secondary"],
            )
            self.assertEqual(row["glyph_normalization"]["status"], "pass")
            self.assertEqual(
                row["glyph_normalization"]["contract_sha256"],
                PROMOTION.GLYPH_NORMALIZATION_CONTRACT_SHA256,
            )
            self.assertEqual(row["clip_image_path"], row["assets"]["raw_224"]["path"])
            self.assertNotEqual(
                row["assets"]["raw_224"]["file_sha256"],
                row["assets"]["glyph_224"]["file_sha256"],
            )
            crosswalk = PROMOTION._read_bound_jsonl(
                fixture.output / PROMOTION.CROSSWALK_FILE, "crosswalk"
            )[0].row
            self.assertEqual(crosswalk["split"], "train")
            self.assertNotEqual(crosswalk["source_master_line_bytes_sha256"], "0" * 64)
            registry_input = PROMOTION._read_json(
                fixture.output / PROMOTION.REGISTRY_INPUT_FILE,
                "registry successor",
            )
            self.assertFalse(registry_input["commands_executed_by_this_promotion"])
            self.assertIn(
                str(fixture.output / PROMOTION.EXCLUSIONS_FILE),
                registry_input["build_registry_command_argv"],
            )
            registry_argv = registry_input["build_registry_command_argv"][2:]
            self.assertEqual(REGISTRY.main(registry_argv), 0)
            successor_registry = Path(registry_input["successor_registry_output"])
            configuration = PROMOTION.master.load_catalog_registry(successor_registry)
            self.assertIn(
                PROMOTION.DEFAULT_CATALOG_ID,
                {catalog.catalog_id for catalog in configuration.catalogs},
            )
            self.assertEqual(
                configuration.expected_counts[PROMOTION.DEFAULT_CATALOG_ID], 1
            )
            self.assertIn(
                (fixture.catalog_id, fixture.source_id), configuration.exclusions
            )

    def test_tampered_final_or_published_pixels_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            accepted = fixture.final / "accepted-images" / f"{fixture.sample_id}.png"
            accepted.write_bytes(accepted.read_bytes() + b"tamper")
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "managed artifact drifted"
            ):
                PROMOTION.main(fixture.args("build"))

        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            PROMOTION.main(fixture.args("build"))
            raw = next((fixture.output / "images" / "raw").rglob("*.png"))
            raw.write_bytes(raw.read_bytes() + b"tamper")
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "managed artifact drifted"
            ):
                PROMOTION.validate_tree(fixture.output)

    def test_materialization_uses_the_verified_immutable_asset_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            accepted_path = (
                fixture.final / "accepted-images" / f"{fixture.sample_id}.png"
            )
            context_path = fixture.final / "review-context" / f"{fixture.sample_id}.png"
            page_path = fixture.library / Path(*Path(fixture.page_relative).parts)
            accepted_payload = accepted_path.read_bytes()

            original_glyph_preflight = PROMOTION._glyph_preflight_report

            def mutate_live_assets_after_snapshot(final):
                report = original_glyph_preflight(final)
                replacements = (
                    (accepted_path, (54, 63), (255, 0, 255)),
                    (context_path, (83, 85), (0, 255, 255)),
                    (page_path, (120, 100), (255, 255, 0)),
                )
                for path, size, color in replacements:
                    replacement = Image.new("RGB", size, color)
                    try:
                        path.write_bytes(PROMOTION._png_bytes(replacement))
                    finally:
                        replacement.close()
                return report

            with mock.patch.object(
                PROMOTION,
                "_glyph_preflight_report",
                side_effect=mutate_live_assets_after_snapshot,
            ):
                self.assertEqual(PROMOTION.main(fixture.args("build")), 0)

            published_raw = next((fixture.output / "images" / "raw").rglob("*.png"))
            self.assertEqual(published_raw.read_bytes(), accepted_payload)

    def test_label_tier_none_leaks_are_rejected(self) -> None:
        for key, value in (
            ("font_label", "leaked-font"),
            ("font_tiers", {"alias": "preferred"}),
            ("none_acceptable", True),
        ):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                fixture = PromotionFixture(Path(temporary))

                def mutate(rows: list[dict[str, Any]]) -> None:
                    rows[0][key] = value

                fixture.rewrite_accepted(mutate)
                with self.assertRaisesRegex(
                    PROMOTION.FontSignalPromotionError, "font label/tier leak"
                ):
                    PROMOTION.main(fixture.args("build"))

    def test_overlay_synthetic_and_unsafe_paths_are_rejected(self) -> None:
        mutations = (
            (
                "overlay",
                lambda row: row["accepted_image"].__setitem__("qa_overlay", True),
            ),
            (
                "synthetic",
                lambda row: row["accepted_image"].__setitem__("synthetic", True),
            ),
            (
                "unsafe_path",
                lambda row: row["source_page"].__setitem__("path", "../escape.png"),
            ),
        )
        for name, mutation in mutations:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                fixture = PromotionFixture(Path(temporary))

                def mutate(rows: list[dict[str, Any]]) -> None:
                    mutation(rows[0])

                fixture.rewrite_accepted(mutate)
                with self.assertRaises(PROMOTION.FontSignalPromotionError):
                    PROMOTION.main(fixture.args("build"))

        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            args = fixture.args("build")
            output_index = args.index("--output-root") + 1
            args[output_index] = str(fixture.final / "nested-output")
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "separate, non-nested roots"
            ):
                PROMOTION.main(args)

    def test_publication_path_and_catalog_collisions_are_rejected(self) -> None:
        def set_option(args: list[str], name: str, value: Path | str) -> None:
            if name in args:
                args[args.index(name) + 1] = str(value)
            else:
                args.extend([name, str(value)])

        def existing_output(fixture: PromotionFixture, args: list[str]) -> None:
            fixture.output.mkdir(parents=True)

        def existing_registry(fixture: PromotionFixture, args: list[str]) -> None:
            path = fixture.root / "published" / "already-registry.json"
            path.parent.mkdir(parents=True)
            path.write_text("occupied", encoding="utf-8")
            set_option(args, "--successor-registry-output", path)

        def existing_master(fixture: PromotionFixture, args: list[str]) -> None:
            path = fixture.root / "published" / "already-master"
            path.mkdir(parents=True)
            set_option(args, "--successor-master-output", path)

        def registry_inside_library(fixture: PromotionFixture, args: list[str]) -> None:
            set_option(
                args,
                "--successor-registry-output",
                fixture.library / "future-registry.json",
            )

        def master_inside_output(fixture: PromotionFixture, args: list[str]) -> None:
            set_option(
                args,
                "--successor-master-output",
                fixture.output / "future-master",
            )

        def registry_inside_master(fixture: PromotionFixture, args: list[str]) -> None:
            master = fixture.root / "published" / "future-master"
            set_option(args, "--successor-master-output", master)
            set_option(
                args,
                "--successor-registry-output",
                master / "future-registry.json",
            )

        cases = (
            ("existing output", existing_output, "already exists"),
            ("existing registry", existing_registry, "already exists"),
            ("existing master", existing_master, "already exists"),
            (
                "registry inside library",
                registry_inside_library,
                "separate, non-nested roots",
            ),
            (
                "master inside output",
                master_inside_output,
                "separate, non-nested roots",
            ),
            (
                "registry inside master",
                registry_inside_master,
                "separate, non-nested roots",
            ),
        )
        for name, configure, message in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                fixture = PromotionFixture(Path(temporary))
                args = fixture.args("preflight")
                configure(fixture, args)
                with self.assertRaisesRegex(
                    PROMOTION.FontSignalPromotionError, message
                ):
                    PROMOTION.main(args)

        for command in ("preflight", "build"):
            with self.subTest(
                collision="catalog_id", command=command
            ), tempfile.TemporaryDirectory() as temporary:
                fixture = PromotionFixture(Path(temporary))
                args = fixture.args(command)
                args.extend(["--catalog-id", fixture.catalog_id])
                with self.assertRaisesRegex(
                    PROMOTION.FontSignalPromotionError,
                    "catalog_id already exists in current registry",
                ):
                    PROMOTION.main(args)

    def test_duplicate_and_terminal_overlap_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))

            def duplicate(rows: list[dict[str, Any]]) -> None:
                rows.append(copy.deepcopy(rows[0]))

            fixture.rewrite_accepted(duplicate)
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "duplicate sample_id"
            ):
                PROMOTION.main(
                    fixture.args("build", expected_accepted=2, expected_terminal=0)
                )

        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))
            fixture.add_overlapping_terminal()
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "accepted and terminal.*overlap"
            ):
                PROMOTION.main(
                    fixture.args("build", expected_accepted=1, expected_terminal=1)
                )

    def test_parent_ambiguity_and_split_changes_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))

            def duplicate_parent(rows: list[dict[str, Any]]) -> None:
                rows.append(copy.deepcopy(rows[0]))

            fixture.rewrite_master(duplicate_parent)
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "ambiguous parent IDs"
            ):
                PROMOTION.main(fixture.args("build"))

        with tempfile.TemporaryDirectory() as temporary:
            fixture = PromotionFixture(Path(temporary))

            def change_split(rows: list[dict[str, Any]]) -> None:
                rows[0]["split"] = "val"

            fixture.rewrite_master(change_split)
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError,
                "split differs from frozen work assignment",
            ):
                PROMOTION.main(fixture.args("build"))


if __name__ == "__main__":
    unittest.main()
