from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "postprocess_fontclip_hard_candidates.py"
SPEC = importlib.util.spec_from_file_location(
    "postprocess_fontclip_hard_candidates",
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load hard postprocessor: {SCRIPT_PATH}")
POST = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POST
SPEC.loader.exec_module(POST)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(
                row,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class HardFixture:
    def __init__(self, root: Path, *, blank: bool = False) -> None:
        self.root = root
        self.input = root / "input"
        self.library = root / "library"
        self.output = root / "output"
        self.work_id = "work-1"
        self.chapter_id = "chapter-1"
        self.page_id = "page-1"
        self.source = (
            self.library
            / "works"
            / self.work_id
            / "chapters"
            / self.chapter_id
            / "pages"
            / f"001-{self.page_id}.png"
        )
        self.source.parent.mkdir(parents=True)
        self.rows: list[dict] = []
        self._build_source(blank=blank)
        self.add_candidate(
            "fhc-fixture-a",
            bbox=(20, 16, 72, 60),
            crop_bbox=(14, 9, 79, 67),
        )
        self.write_manifest()

    @property
    def manifest(self) -> Path:
        return self.input / "manifest.jsonl"

    def _build_source(self, *, blank: bool) -> None:
        image = Image.new("RGB", (96, 80), (248, 248, 248))
        if not blank:
            draw = ImageDraw.Draw(image)
            # A long panel-like line inside the padded crop but outside the
            # candidate bbox. The processor should not treat it as glyph ink.
            draw.line((14, 10, 78, 10), fill=(210, 20, 20), width=1)
            draw.polygon(
                ((25, 22), (34, 18), (42, 47), (33, 52)),
                fill=(8, 8, 8),
            )
            draw.polygon(
                ((44, 20), (57, 21), (65, 48), (51, 51)),
                fill=(20, 70, 215),
            )
            draw.ellipse((66, 52, 69, 55), fill=(10, 10, 10))
            # Disconnected neighbouring text in padding; it must not seed the
            # selected candidate components.
            draw.rectangle((75, 28, 78, 38), fill=(0, 0, 0))
        image.save(self.source)

    def add_candidate(
        self,
        sample_id: str,
        *,
        bbox: tuple[int, int, int, int],
        crop_bbox: tuple[int, int, int, int],
    ) -> dict:
        source_image = Image.open(self.source).convert("RGB")
        crop = source_image.crop(crop_bbox)
        raw = self.input / "images" / "raw" / "train" / f"{sample_id}.png"
        clip = self.input / "images" / "clip_224" / "train" / f"{sample_id}.png"
        raw.parent.mkdir(parents=True, exist_ok=True)
        clip.parent.mkdir(parents=True, exist_ok=True)
        crop.save(raw, format="PNG")
        letterbox = Image.new("RGB", (224, 224), "white")
        resized = crop.copy()
        resized.thumbnail((224, 224))
        letterbox.paste(
            resized,
            ((224 - resized.width) // 2, (224 - resized.height) // 2),
        )
        letterbox.save(clip, format="PNG")
        source_bytes = self.source.read_bytes()
        row = {
            "schema_version": 1,
            "id": sample_id,
            "image_path": raw.relative_to(self.input).as_posix(),
            "clip_image_path": clip.relative_to(self.input).as_posix(),
            "asset_file_sha256": {
                "image_path": sha256_file(raw),
                "clip_image_path": sha256_file(clip),
            },
            "source_image_path": self.source.relative_to(self.library).as_posix(),
            "source_page_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "source_page_content_signature": {
                "sha256": hashlib.sha256(source_bytes).hexdigest(),
                "size": len(source_bytes),
                "width": 96,
                "height": 80,
            },
            "work_id": self.work_id,
            "work_title": "Work",
            "chapter_id": self.chapter_id,
            "chapter_title": "Chapter",
            "page_id": self.page_id,
            "page_name": self.source.name,
            "page_size_px": [96, 80],
            "declared_page_size_px": [96, 80],
            "source_dimension_mismatch": False,
            "split": "train",
            "tier": "hard_candidate",
            "provenance": "real_mined",
            "primary_category": "page_sound",
            "categories": ["page_sound", "text_free"],
            "candidate_score": 0.91,
            "candidate_evidence": [{"source": "unit_fixture"}],
            "candidate_source_ids": ["fixture-source"],
            "bbox_px": list(bbox),
            "crop_bbox_px": list(crop_bbox),
            "crop_size_px": [crop.width, crop.height],
            "crop_sha256": POST._pixel_sha256(crop),
            "orientation": "horizontal",
            "ocr_text": "ドン",
            "ocr_hints_sha256": None,
            "ocr_coordinate_provenance": {"coordinate_space": "actual_source_pixels"},
            "ocr_metadata_skip_reasons": {},
            "detector_model": {
                "name": "fixture",
                "sha256": "1" * 64,
                "labels": ["bubble", "text_bubble", "text_free"],
            },
            "selection_segment_index": 0,
            "work_balance_weight": 1.0,
            "chapter_balance_weight": 1.0,
            "label": None,
        }
        self.rows.append(row)
        return row

    def write_manifest(self) -> None:
        write_jsonl(self.manifest, self.rows)
        manifest_sha256 = sha256_file(self.manifest)
        signature = {
            "library_root": str(self.library.resolve()),
            "configuration": {"max_chapters_per_work": 20},
            "fixture": True,
            "manifest_sha256": manifest_sha256,
        }
        marker = {
            "tool": POST.INPUT_TOOL_ID,
            "schema_version": 1,
            "output_root": str(self.input.resolve()),
            "owned_outputs": [
                POST.STATE_DIR_NAME,
                "images/raw",
                "images/clip_224",
                POST.MANIFEST_NAME,
                POST.INPUT_REPORT_NAME,
            ],
            "signature": signature,
            "signature_sha256": POST._sha256_json(signature),
        }
        report = {
            "tool": POST.INPUT_TOOL_ID,
            "schema_version": 1,
            "run_signature_sha256": marker["signature_sha256"],
            "candidate_records": len(self.rows),
            "unique_crop_sha256": len({str(row["crop_sha256"]) for row in self.rows}),
            "category_memberships": dict(
                sorted(
                    Counter(
                        category for row in self.rows for category in row["categories"]
                    ).items()
                )
            ),
            "by_split": dict(
                sorted(Counter(str(row["split"]) for row in self.rows).items())
            ),
            "configuration": {"max_chapters_per_work": 20},
            "output_root": str(self.input.resolve()),
            "library_root": str(self.library.resolve()),
        }
        (self.input / POST.INPUT_MARKER_NAME).write_text(
            json.dumps(marker, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        (self.input / POST.INPUT_REPORT_NAME).write_text(
            json.dumps(report, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )

    def args(
        self,
        *,
        dry_run: bool = False,
        overwrite: bool = False,
        no_ctd: bool = True,
    ):
        argv = [
            "--input-root",
            str(self.input),
            "--library-root",
            str(self.library),
            "--output-root",
            str(self.output),
            "--quiet",
            "--minimum-input-candidates",
            "0",
            "--minimum-processed-records",
            "0",
            "--expected-input-manifest-sha256",
            sha256_file(self.manifest),
        ]
        if no_ctd:
            argv.append("--no-ctd")
        if dry_run:
            argv.append("--dry-run")
        if overwrite:
            argv.append("--overwrite")
        return POST.build_argument_parser().parse_args(argv)


@dataclass
class FakeStats:
    source: str = "fake_ctd"


class FakePageMask:
    def extract(self, bbox, *, bbox_format: str):
        if bbox_format != "xyxy":
            raise AssertionError("unexpected bbox format")
        x1, y1, x2, y2 = (int(value) for value in bbox)
        width = x2 - x1
        height = y2 - y1
        mask = np.zeros((height, width), dtype=np.uint8)
        mask[
            max(1, height // 5) : max(2, height * 4 // 5),
            max(1, width // 5) : max(2, width * 4 // 5),
        ] = 255
        return SimpleNamespace(
            empty=False,
            binary_mask=mask,
            ocr_bbox=(x1, y1, x2, y2),
            stats=FakeStats(),
        )


class FakeMasker:
    def __init__(self) -> None:
        self.available = True
        self.inference_count = 0
        self.model_info = {
            "available": True,
            "provider": "CPUExecutionProvider",
            "input_size": [64, 64],
            "segmentation_output_name": "seg",
        }

    def infer_page(
        self,
        _image: np.ndarray,
        *,
        color_order: str,
    ) -> FakePageMask:
        if color_order != "RGB":
            raise AssertionError("unexpected colour order")
        self.inference_count += 1
        return FakePageMask()


class MutatingMasker(FakeMasker):
    def __init__(self, source: Path) -> None:
        super().__init__()
        self.source = source

    def infer_page(
        self,
        image: np.ndarray,
        *,
        color_order: str,
    ) -> FakePageMask:
        result = super().infer_page(image, color_order=color_order)
        Image.new("RGB", (96, 80), "black").save(self.source)
        return result


@dataclass
class EmptyProbabilityStats:
    threshold: float = 0.3
    source: str = "fake_probability"


class EmptyProbabilityPageMask:
    def extract(self, bbox, *, bbox_format: str):
        if bbox_format != "xyxy":
            raise AssertionError("unexpected bbox format")
        x1, y1, x2, y2 = (int(value) for value in bbox)
        width = x2 - x1
        height = y2 - y1
        probability = np.zeros((height, width), dtype=np.float32)
        probability[height // 2, width // 2] = 0.95
        return SimpleNamespace(
            empty=True,
            binary_mask=np.zeros((height, width), dtype=np.uint8),
            probability_mask=probability,
            ocr_bbox=(x1, y1, x2, y2),
            stats=EmptyProbabilityStats(),
        )


class FixedPageMask:
    def __init__(self, mask: np.ndarray) -> None:
        self.mask = np.asarray(mask, dtype=np.uint8)

    def extract(self, bbox, *, bbox_format: str):
        if bbox_format != "xyxy":
            raise AssertionError("unexpected bbox format")
        x1, y1, x2, y2 = (int(value) for value in bbox)
        crop = self.mask[y1:y2, x1:x2]
        return SimpleNamespace(
            empty=not bool(crop.any()),
            binary_mask=crop * np.uint8(255),
            ocr_bbox=(x1, y1, x2, y2),
            stats=FakeStats(),
        )


class FixedMasker(FakeMasker):
    def __init__(self, mask: np.ndarray) -> None:
        super().__init__()
        self.mask = mask

    def infer_page(
        self,
        _image: np.ndarray,
        *,
        color_order: str,
    ) -> FixedPageMask:
        if color_order != "RGB":
            raise AssertionError("unexpected colour order")
        self.inference_count += 1
        return FixedPageMask(self.mask)


class HardPostprocessTests(unittest.TestCase):
    def test_one_pixel_sfx_mark_survives_structural_line_cleanup(self) -> None:
        mask = np.zeros((11, 11), dtype=bool)
        mask[0, :] = True
        mask[6, 6] = True
        cleaned, stats = POST._clean_structural_lines(mask)
        self.assertTrue(cleaned[6, 6])
        self.assertFalse(cleaned[0, :].any())
        self.assertEqual(stats["removed_small_pixels"], 0)
        self.assertEqual(stats["removed_line_pixels"], 11)

    def test_large_balloon_ring_is_removed_but_inner_glyphs_survive(self) -> None:
        width, height = 120, 92
        roi = (15, 15, 105, 77)
        ring_image = Image.new("L", (width, height), 0)
        ImageDraw.Draw(ring_image).ellipse((4, 4, 115, 87), outline=255, width=3)
        glyph_image = Image.new("L", (width, height), 0)
        glyph_draw = ImageDraw.Draw(glyph_image)
        glyph_draw.rectangle((39, 31, 46, 61), fill=255)
        glyph_draw.rectangle((55, 28, 62, 62), fill=255)
        glyph_draw.rectangle((70, 34, 78, 64), fill=255)
        ring = np.asarray(ring_image) > 0
        glyphs = np.asarray(glyph_image) > 0
        source = ring | glyphs
        rgb = np.full((height, width, 3), 255, dtype=np.uint8)
        rgb[source] = 0

        selected, stats = POST._select_candidate_components(
            source,
            roi,
            rgb,
            suppress_enclosures=True,
        )
        ring_overlap = int((selected & ring).sum()) / max(1, int(ring.sum()))
        glyph_recall = int((selected & glyphs).sum()) / max(1, int(glyphs.sum()))
        self.assertLess(ring_overlap, 0.10)
        self.assertGreater(glyph_recall, 0.95)
        self.assertGreater(
            stats["large_enclosure_removed_ratio"],
            POST.SEVERE_ENCLOSURE_INK_RATIO,
        )

    def test_closed_outlined_sfx_inside_roi_is_not_suppressed(self) -> None:
        width, height = 100, 88
        roi = (8, 6, 92, 82)
        image = Image.new("L", (width, height), 0)
        ImageDraw.Draw(image).ellipse((25, 14, 75, 74), outline=255, width=5)
        sfx = np.asarray(image) > 0
        rgb = np.full((height, width, 3), 255, dtype=np.uint8)
        rgb[sfx] = 0
        selected, stats = POST._select_candidate_components(
            sfx,
            roi,
            rgb,
            suppress_enclosures=True,
        )
        recall = int((selected & sfx).sum()) / max(1, int(sfx.sum()))
        self.assertGreater(recall, 0.98)
        self.assertEqual(stats["large_enclosure_removed_pixels"], 0)

    def test_panel_line_is_removed_while_glyph_pixels_survive(self) -> None:
        mask = np.zeros((60, 100), dtype=bool)
        mask[3, :] = True
        mask[20:48, 42:50] = True
        rgb = np.full((60, 100, 3), 255, dtype=np.uint8)
        rgb[mask] = 0
        selected, stats = POST._select_candidate_components(
            mask,
            (35, 15, 58, 53),
            rgb,
        )
        self.assertFalse(selected[3, :].any())
        self.assertTrue(selected[20:48, 42:50].all())
        self.assertEqual(stats["cleanup"]["removed_line_pixels"], 100)

    def test_bubble_edge_prefers_sane_ctd_over_higher_scoring_classical(self) -> None:
        common = {
            "pixels": 120,
            "ink_ratio": 0.12,
            "component_count": 3,
            "mask_inside_text_roi_ratio": 0.9,
            "large_enclosure_ink_ratio": 0.0,
            "large_enclosure_removed_ratio": 0.0,
            "line_contamination_ratio": 0.0,
        }
        classical = POST.MaskOption(
            name="classical_multipolar",
            mask=np.ones((10, 12), dtype=bool),
            stats={**common, "quality_score": 0.99},
            metadata={},
        )
        ctd = POST.MaskOption(
            name="ctd",
            mask=np.ones((10, 12), dtype=bool),
            stats={**common, "quality_score": 0.42},
            metadata={},
        )
        selected, reason = POST._choose_mask(
            [classical, ctd],
            prefer_ctd=True,
        )
        self.assertEqual(selected.name, "ctd")
        self.assertEqual(
            reason,
            "bubble_edge_sane_ctd_preferred_over_classical",
        )
        high_threshold = POST.MaskOption(
            name="ctd",
            mask=np.ones((10, 12), dtype=bool),
            stats={**common, "quality_score": 0.42},
            metadata={
                "raw_probability": {
                    "threshold": 0.99,
                    "maximum": 1.0,
                    "mean_selected": 1.0,
                }
            },
        )
        self.assertTrue(POST._sane_ctd_option(high_threshold))
        tiny_ctd = POST.MaskOption(
            name="ctd",
            mask=np.ones((1, 1), dtype=bool),
            stats={
                **common,
                "pixels": 1,
                "ink_ratio": 0.001,
                "quality_score": 0.42,
            },
            metadata={},
        )
        sound_selected, _ = POST._choose_mask(
            [classical, tiny_ctd],
            prefer_ctd=True,
            sound_like=True,
        )
        self.assertEqual(sound_selected.name, "classical_multipolar")

    def test_ctd_probability_preserves_one_pixel_when_cleaned_result_is_empty(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            items = POST._load_input(
                fixture.manifest,
                input_root=fixture.input.resolve(),
                library_root=fixture.library.resolve(),
            )
            page = POST._verified_page(items)
            raw = POST._verified_raw(items[0], page)
            option = POST._ctd_option(
                items[0],
                raw.rgb,
                EmptyProbabilityPageMask(),
                {"name": "fake"},
            )
            self.assertIsNotNone(option)
            assert option is not None
            self.assertEqual(option.stats["pixels"], 1)

    def test_bubble_only_classical_candidate_is_quarantined(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            image = Image.new("RGB", (96, 80), "white")
            draw = ImageDraw.Draw(image)
            draw.ellipse((3, 3, 92, 76), outline="black", width=3)
            draw.rectangle((34, 25, 41, 57), fill="black")
            draw.rectangle((52, 22, 60, 58), fill="black")
            image.save(fixture.source)
            fixture.rows.clear()
            row = fixture.add_candidate(
                "fhc-bubble-only",
                bbox=(25, 18, 70, 63),
                crop_bbox=(0, 0, 96, 80),
            )
            row["primary_category"] = "bubble_edge"
            row["categories"] = ["bubble_edge"]
            fixture.write_manifest()

            summary = POST.run(fixture.args())
            self.assertEqual(summary["processed_records"], 0)
            self.assertEqual(summary["rejected_records"], 1)
            reject = read_jsonl(fixture.output / POST.REJECTS_NAME)[0]
            self.assertIn(
                "bubble_edge_requires_sane_ctd_or_verified_mask",
                reject["failure_reasons"],
            )

    def test_bubble_only_sane_ctd_excludes_oval_and_preserves_glyphs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            ring_image = Image.new("L", (96, 80), 0)
            ImageDraw.Draw(ring_image).ellipse(
                (3, 3, 92, 76),
                outline=255,
                width=3,
            )
            glyph_image = Image.new("L", (96, 80), 0)
            glyph_draw = ImageDraw.Draw(glyph_image)
            glyph_draw.rectangle((34, 25, 41, 57), fill=255)
            glyph_draw.rectangle((52, 22, 60, 58), fill=255)
            ring = np.asarray(ring_image) > 0
            glyphs = np.asarray(glyph_image) > 0
            source_mask = ring | glyphs
            source = np.full((80, 96, 3), 255, dtype=np.uint8)
            source[source_mask] = 0
            Image.fromarray(source).save(fixture.source)
            fixture.rows.clear()
            row = fixture.add_candidate(
                "fhc-bubble-ctd",
                bbox=(25, 18, 70, 63),
                crop_bbox=(0, 0, 96, 80),
            )
            row["primary_category"] = "bubble_edge"
            row["categories"] = ["bubble_edge"]
            fixture.write_manifest()

            model = fixture.root / "fake-model.onnx"
            config = fixture.root / "fake-config.json"
            preprocessor = fixture.root / "fake-preprocessor.json"
            model.write_bytes(b"fake-model")
            config.write_text("{}", encoding="utf-8")
            preprocessor.write_text("{}", encoding="utf-8")
            args = fixture.args(no_ctd=False)
            args.ctd_model = model
            args.ctd_config = config
            args.ctd_preprocessor = preprocessor
            masker = FixedMasker(glyphs)
            summary = POST.run(
                args,
                masker_factory=lambda *a, **k: masker,
            )
            self.assertEqual(summary["processed_records"], 1)
            self.assertEqual(summary["rejected_records"], 0)
            record = read_jsonl(fixture.output / POST.MANIFEST_NAME)[0]
            self.assertEqual(record["processing"]["mask_method"], "ctd")
            self.assertEqual(
                record["processing"]["mask_selection_reason"],
                "bubble_edge_sane_ctd_preferred_over_classical",
            )

            tight = tuple(record["mask_tight_bbox_px"])
            output_mask = (
                np.asarray(
                    Image.open(fixture.output / record["assets"]["mask"]["path"])
                )
                > 0
            )
            restored = np.zeros((80, 96), dtype=bool)
            restored[tight[1] : tight[3], tight[0] : tight[2]] = output_mask
            ring_overlap = int((restored & ring).sum()) / max(
                1,
                int(ring.sum()),
            )
            glyph_recall = int((restored & glyphs).sum()) / max(
                1,
                int(glyphs.sum()),
            )
            self.assertLess(ring_overlap, 0.10)
            self.assertGreater(glyph_recall, 0.95)

    def test_classical_fallback_preserves_raw_and_writes_real_derivatives(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            summary = POST.run(fixture.args())
            self.assertEqual(summary["processed_records"], 1)
            self.assertEqual(summary["rejected_records"], 0)
            self.assertEqual(summary["synthetic_assets_generated"], 0)
            self.assertGreaterEqual(summary["encoded_asset_files"], 12)
            self.assertGreater(summary["encoded_asset_bytes"], 0)
            self.assertEqual(
                summary["hard_qa_contract"]["max_chapters_per_work"],
                20,
            )

            record = read_jsonl(fixture.output / "manifest.jsonl")[0]
            self.assertEqual(record["provenance"], "real_processed")
            self.assertEqual(record["parent_id"], fixture.rows[0]["id"])
            self.assertEqual(record["root_real_id"], fixture.rows[0]["id"])
            self.assertEqual(record["split"], fixture.rows[0]["split"])
            self.assertEqual(record["work_id"], fixture.rows[0]["work_id"])
            self.assertFalse(record["synthetic"])
            self.assertTrue(record["hard_mask_quality_gate"]["passed_for_human_review"])
            self.assertEqual(
                record["hard_qa_contract"]["max_chapters_per_work"],
                20,
            )
            self.assertEqual(
                record["mask_input_bbox_px"],
                fixture.rows[0]["crop_bbox_px"],
            )

            required = {
                "raw",
                "context",
                "glyph_rgba",
                "mask",
                "black_on_white",
                "white_on_black",
                "color_mask",
                "outline_fill",
                "outline_stroke",
                "outline_outer_ring",
                "glyph_224",
                "context_224",
            }
            self.assertTrue(required.issubset(record["assets"]))
            for descriptor in record["assets"].values():
                asset = fixture.output / descriptor["path"]
                self.assertTrue(asset.is_file())
                self.assertEqual(descriptor["file_sha256"], sha256_file(asset))
                self.assertNotIn("overlay", descriptor["path"].lower())
                self.assertNotIn("preview", descriptor["path"].lower())
                self.assertIn(
                    descriptor["provenance"],
                    {"real_preserved", "real_processed"},
                )
            assets = record["assets"]
            self.assertEqual(
                assets["context"]["parent_asset_id"],
                record["source_page_asset"]["id"],
            )
            self.assertEqual(
                assets["glyph_rgba"]["parent_asset_ids"],
                [assets["raw"]["id"], assets["mask"]["id"]],
            )
            for kind in (
                "black_on_white",
                "white_on_black",
                "outline_fill",
                "outline_stroke",
                "outline_outer_ring",
            ):
                self.assertEqual(
                    assets[kind]["parent_asset_ids"],
                    [assets["mask"]["id"]],
                )
            self.assertEqual(
                assets["glyph_224"]["parent_asset_ids"],
                [assets["glyph_rgba"]["id"]],
            )
            self.assertEqual(
                assets["context_224"]["parent_asset_ids"],
                [assets["context"]["id"]],
            )
            if "deskew_rgba" in assets:
                self.assertEqual(
                    assets["deskew_rgba"]["parent_asset_ids"],
                    [assets["glyph_rgba"]["id"]],
                )

            input_raw = fixture.input / fixture.rows[0]["image_path"]
            output_raw = fixture.output / record["assets"]["raw"]["path"]
            self.assertEqual(input_raw.read_bytes(), output_raw.read_bytes())
            self.assertEqual(record["tier"], "B")
            self.assertEqual(record["crop_sha256"], fixture.rows[0]["crop_sha256"])
            self.assertEqual(record["image_path"], record["raw_image_path"])
            self.assertEqual(
                Image.open(fixture.output / record["clip_image_path"]).size,
                (224, 224),
            )
            with Image.open(fixture.output / assets["glyph_rgba"]["path"]) as opened:
                glyph_rgba = opened.convert("RGBA")
                white = Image.new(
                    "RGBA",
                    glyph_rgba.size,
                    (255, 255, 255, 255),
                )
                composite = Image.alpha_composite(white, glyph_rgba).convert("RGB")
            expected_glyph_224 = POST._letterbox_rgb(composite)
            with Image.open(fixture.output / assets["glyph_224"]["path"]) as opened:
                actual_glyph_224 = opened.convert("RGB")
                self.assertEqual(
                    actual_glyph_224.tobytes(),
                    expected_glyph_224.tobytes(),
                )
            self.assertEqual(
                record["glyph_white_composite_sha256"],
                POST._pixel_sha256(composite),
            )
            mask = np.asarray(
                Image.open(fixture.output / record["assets"]["mask"]["path"])
            )
            color_mask = np.asarray(
                Image.open(fixture.output / record["assets"]["color_mask"]["path"])
            )
            self.assertGreater(int((mask > 0).sum()), 0)
            self.assertGreater(int((color_mask > 0).sum()), 0)

            black = np.asarray(
                Image.open(fixture.output / record["assets"]["black_on_white"]["path"])
            )
            white = np.asarray(
                Image.open(fixture.output / record["assets"]["white_on_black"]["path"])
            )
            self.assertEqual(int(black.min()), 0)
            self.assertEqual(int(black.max()), 255)
            self.assertEqual(int(white.min()), 0)
            self.assertEqual(int(white.max()), 255)
            self.assertTrue(np.array_equal(255 - black, white))

            synthetic_spec = json.loads(
                (fixture.output / POST.SYNTHETIC_SPEC_NAME).read_text(encoding="utf-8")
            )
            self.assertEqual(synthetic_spec["status"], "design_only")
            self.assertFalse(synthetic_spec["generated_by_this_tool"])

    def test_dry_run_is_non_mutating_and_overlay_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            summary = POST.run(fixture.args(dry_run=True))
            self.assertTrue(summary["dry_run"])
            self.assertFalse(fixture.output.exists())

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            fixture.rows[0]["source_image_path"] = (
                "works/work-1/chapters/chapter-1/runs/attempt-1/overlay-preview.png"
            )
            fixture.write_manifest()
            with self.assertRaisesRegex(
                POST.InputValidationError,
                "runs, previews, and overlays are forbidden",
            ):
                POST.run(fixture.args(dry_run=True))
            self.assertFalse(fixture.output.exists())

    def test_preflight_attests_builder_inventory_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            args = fixture.args()
            args.preflight_only = True
            summary = POST.run(args)
            self.assertTrue(summary["preflight_only"])
            self.assertFalse(summary["output_written"])
            self.assertFalse(fixture.output.exists())
            self.assertEqual(
                summary["output_preflight"]["mandatory_png_files_if_all_processed"],
                12,
            )
            self.assertEqual(
                summary["output_preflight"]["maximum_png_files_if_all_processed"],
                13,
            )

            report_path = fixture.input / POST.INPUT_REPORT_NAME
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["candidate_records"] = 2
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                POST.InputValidationError,
                "count/signature",
            ):
                POST.run(args)

    def test_preflight_rejects_manifest_pin_raw_tamper_and_unowned_output(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            args = fixture.args()
            args.preflight_only = True
            fixture.rows[0]["bbox_px"][0] += 1
            write_jsonl(fixture.manifest, fixture.rows)
            with self.assertRaisesRegex(
                POST.InputValidationError,
                "manifest SHA-256",
            ):
                POST.run(args)

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            args = fixture.args()
            args.preflight_only = True
            args.expected_input_manifest_sha256 = "0" * 64
            with self.assertRaisesRegex(
                POST.InputValidationError,
                "operator CLI pin",
            ):
                POST.run(args)

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            raw = fixture.input / fixture.rows[0]["image_path"]
            Image.new("RGB", Image.open(raw).size, "white").save(raw)
            args = fixture.args()
            args.preflight_only = True
            with self.assertRaises(POST.SourceIntegrityError):
                POST.run(args)

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            fixture.output.mkdir()
            (fixture.output / "not-owned.txt").write_text(
                "occupied",
                encoding="utf-8",
            )
            args = fixture.args()
            args.preflight_only = True
            with self.assertRaisesRegex(
                POST.UnsafeOutputError,
                "occupied output",
            ):
                POST.run(args)

    def test_materialization_count_gate_runs_before_output_creation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            args = fixture.args()
            args.minimum_input_candidates = 2
            with self.assertRaisesRegex(
                POST.InputValidationError,
                "below the materialization gate",
            ):
                POST.run(args)
            self.assertFalse(fixture.output.exists())

    def test_processed_record_count_gate_prevents_false_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            args = fixture.args()
            args.minimum_processed_records = 2
            with self.assertRaisesRegex(
                POST.HardPostprocessError,
                "processed record count 1",
            ):
                POST.run(args)

    def test_resume_is_terminal_and_detects_changed_output_asset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            first = POST.run(fixture.args())
            manifest_before = (fixture.output / POST.MANIFEST_NAME).read_bytes()
            self.assertEqual(first["processed_pages_this_run"], 1)
            second = POST.run(fixture.args())
            self.assertEqual(second["processed_pages_this_run"], 0)
            self.assertEqual(second["resumed_pages_this_run"], 1)
            self.assertEqual(
                manifest_before,
                (fixture.output / POST.MANIFEST_NAME).read_bytes(),
            )

            record = read_jsonl(fixture.output / POST.MANIFEST_NAME)[0]
            mask = fixture.output / record["assets"]["mask"]["path"]
            mask.write_bytes(b"tampered")
            with self.assertRaises(POST.ResumeValidationError):
                POST.run(fixture.args())

    def test_new_output_asset_is_rehashed_before_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            original = POST._checkpoint_payload

            def corrupt_after_descriptor(**kwargs: object) -> dict:
                payload = original(**kwargs)
                record = payload["records"][0]
                mask = fixture.output / record["assets"]["mask"]["path"]
                mask.write_bytes(b"corrupted-after-descriptor")
                return payload

            with (
                mock.patch.object(
                    POST,
                    "_checkpoint_payload",
                    side_effect=corrupt_after_descriptor,
                ),
                self.assertRaises(POST.ResumeValidationError),
            ):
                POST.run(fixture.args())

    def test_output_asset_is_rehashed_after_report_construction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            original = POST._report

            def mutate_from_report(**kwargs: object) -> dict:
                summary = original(**kwargs)
                record = kwargs["records"][0]
                mask = fixture.output / record["assets"]["mask"]["path"]
                mask.write_bytes(b"corrupted-from-report-hook")
                return summary

            with (
                mock.patch.object(
                    POST,
                    "_report",
                    side_effect=mutate_from_report,
                ),
                self.assertRaises(POST.ResumeValidationError),
            ):
                POST.run(fixture.args())

    def test_checkpoint_must_cover_each_input_exactly_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            state_path = next((fixture.output / POST.STATE_DIR_NAME).glob("*.json"))
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            payload["records"] = []
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            state_path.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                POST.ResumeValidationError,
                "cover every input exactly once",
            ):
                POST.run(fixture.args())

    def test_aggregate_binds_each_page_shard_to_current_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            state_path = next((fixture.output / POST.STATE_DIR_NAME).glob("*.json"))
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            payload["input_bindings"][0]["id"] = "fhc-substituted"
            payload["records"][0]["parent_id"] = "fhc-substituted"
            payload["input_binding_sha256"] = POST._sha256_json(
                payload["input_bindings"]
            )
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            state_path.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            items = POST._load_input(
                fixture.manifest,
                input_root=fixture.input.resolve(),
                library_root=fixture.library.resolve(),
            )
            with self.assertRaisesRegex(
                POST.ResumeValidationError,
                "bindings do not match current input",
            ):
                POST._aggregate(
                    POST._layout(fixture.output.resolve()),
                    signature_sha256=payload["signature_sha256"],
                    expected_bindings_by_page={
                        items[0].page_key: POST._input_bindings(items)
                    },
                )

    def test_checkpoint_rejects_forged_asset_kind_semantics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            state_path = next((fixture.output / POST.STATE_DIR_NAME).glob("*.json"))
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            payload["records"][0]["assets"]["mask"]["kind"] = "raw"
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            state_path.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                POST.ResumeValidationError,
                "asset semantics",
            ):
                POST.run(fixture.args())

    def test_checkpoint_binds_record_identity_and_root_lineage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            state_path = next((fixture.output / POST.STATE_DIR_NAME).glob("*.json"))
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            record = payload["records"][0]
            record["work_id"] = "forged-work"
            record["root_real_id"] = "forged-root"
            record["variant_group_id"] = "forged-root"
            for descriptor in record["assets"].values():
                descriptor["root_real_id"] = "forged-root"
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            state_path.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                POST.ResumeValidationError,
                "input binding",
            ):
                POST.run(fixture.args())

    def test_checkpoint_revalidates_decoded_asset_pixels_and_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            state_path = next((fixture.output / POST.STATE_DIR_NAME).glob("*.json"))
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            record = payload["records"][0]
            raw_path = fixture.output / record["assets"]["raw"]["path"]
            mask_path = fixture.output / record["assets"]["mask"]["path"]
            mask_path.write_bytes(raw_path.read_bytes())
            changed_sha = sha256_file(mask_path)
            record["assets"]["mask"]["file_sha256"] = changed_sha
            record["assets"]["mask"]["file_size_bytes"] = mask_path.stat().st_size
            record["mask_asset_sha256"]["mask"] = changed_sha
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            state_path.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                POST.ResumeValidationError,
                "pixels do not match",
            ):
                POST.run(fixture.args())

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            state_path = next((fixture.output / POST.STATE_DIR_NAME).glob("*.json"))
            payload = json.loads(state_path.read_text(encoding="utf-8"))
            record = payload["records"][0]
            record["mask_paths"]["mask"] = record["assets"]["context"]["path"]
            record["final_image_paths"]["mask"] = record["assets"]["context"]["path"]
            record["mask_asset_sha256"]["mask"] = "0" * 64
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            state_path.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                POST.ResumeValidationError,
                "alias maps",
            ):
                POST.run(fixture.args())

    def test_signed_source_and_raw_tampering_are_fatal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            Image.new("RGB", (96, 80), "black").save(fixture.source)
            with self.assertRaises(POST.SourceIntegrityError):
                POST.run(fixture.args(dry_run=True))
            self.assertFalse(fixture.output.exists())

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            raw = fixture.input / fixture.rows[0]["image_path"]
            Image.new("RGB", Image.open(raw).size, "white").save(raw)
            with self.assertRaises(POST.SourceIntegrityError):
                POST.run(fixture.args(dry_run=True))
            self.assertFalse(fixture.output.exists())

    def test_final_input_rehash_detects_late_raw_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            raw = fixture.input / fixture.rows[0]["image_path"]
            original = POST._ctd_file_signatures
            calls = 0

            def mutate_on_final_check(args: object) -> dict:
                nonlocal calls
                calls += 1
                signatures = original(args)
                if calls == 3:
                    raw.write_bytes(b"late-tamper")
                return signatures

            with (
                mock.patch.object(
                    POST,
                    "_ctd_file_signatures",
                    side_effect=mutate_on_final_check,
                ),
                self.assertRaises(POST.SourceIntegrityError),
            ):
                POST.run(fixture.args())
            self.assertEqual(calls, 3)

    def test_verified_precomputed_mask_is_an_available_option(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            row = fixture.rows[0]
            bbox = tuple(row["bbox_px"])
            width = bbox[2] - bbox[0]
            height = bbox[3] - bbox[1]
            mask = Image.new("L", (width, height), 0)
            draw = ImageDraw.Draw(mask)
            draw.rectangle((6, 5, width - 8, height - 7), fill=255)
            path = fixture.input / "images" / "masks" / "verified.png"
            path.parent.mkdir(parents=True)
            mask.save(path)
            row["glyph_mask_path"] = path.relative_to(fixture.input).as_posix()
            row["mask_tight_bbox_px"] = list(bbox)
            row["mask_asset_sha256"] = {"mask": sha256_file(path)}
            fixture.write_manifest()

            POST.run(fixture.args())
            record = read_jsonl(fixture.output / POST.MANIFEST_NAME)[0]
            options = record["processing"]["mask_options"]
            self.assertIn("precomputed_verified", options)
            self.assertEqual(
                options["precomputed_verified"]["metadata"]["sha256"],
                sha256_file(path),
            )
            Image.new("L", mask.size, 255).save(path)
            with self.assertRaises(POST.SourceIntegrityError):
                POST.run(fixture.args())

    def test_ctd_runs_once_for_two_candidates_on_the_same_page(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            fixture.add_candidate(
                "fhc-fixture-b",
                bbox=(22, 18, 70, 58),
                crop_bbox=(16, 11, 77, 65),
            )
            fixture.write_manifest()
            fake = FakeMasker()
            model = fixture.root / "fake-model.onnx"
            config = fixture.root / "fake-config.json"
            preprocessor = fixture.root / "fake-preprocessor.json"
            model.write_bytes(b"fake-model")
            config.write_text("{}", encoding="utf-8")
            preprocessor.write_text("{}", encoding="utf-8")
            args = fixture.args(no_ctd=False)
            args.ctd_model = model
            args.ctd_config = config
            args.ctd_preprocessor = preprocessor
            summary = POST.run(args, masker_factory=lambda *a, **k: fake)
            self.assertEqual(fake.inference_count, 1)
            self.assertEqual(summary["ctd_page_inferences_this_run"], 1)
            self.assertEqual(summary["processed_records"], 2)
            records = read_jsonl(fixture.output / POST.MANIFEST_NAME)
            self.assertTrue(
                all("ctd" in record["processing"]["mask_options"] for record in records)
            )

    def test_source_mutation_during_ctd_is_detected_before_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            model = fixture.root / "fake-model.onnx"
            config = fixture.root / "fake-config.json"
            preprocessor = fixture.root / "fake-preprocessor.json"
            model.write_bytes(b"fake-model")
            config.write_text("{}", encoding="utf-8")
            preprocessor.write_text("{}", encoding="utf-8")
            args = fixture.args(no_ctd=False)
            args.ctd_model = model
            args.ctd_config = config
            args.ctd_preprocessor = preprocessor
            mutating = MutatingMasker(fixture.source)
            with self.assertRaises(POST.SourceIntegrityError):
                POST.run(args, masker_factory=lambda *a, **k: mutating)
            state = fixture.output / POST.STATE_DIR_NAME
            self.assertEqual(list(state.glob("*.json")), [])

    def test_empty_mask_page_checkpoint_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary), blank=True)
            first = POST.run(fixture.args())
            self.assertEqual(first["processed_records"], 0)
            self.assertEqual(first["rejected_records"], 1)
            self.assertEqual(first["processed_pages_this_run"], 1)
            second = POST.run(fixture.args())
            self.assertEqual(second["processed_pages_this_run"], 0)
            self.assertEqual(second["resumed_pages_this_run"], 1)
            self.assertEqual(second["rejected_records"], 1)

    def test_overwrite_requires_marker_and_preserves_unowned_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            fixture.output.mkdir()
            unowned = fixture.output / "mine.txt"
            unowned.write_text("keep", encoding="utf-8")
            with self.assertRaises(POST.UnsafeOutputError):
                POST.run(fixture.args(overwrite=True))

        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            unowned = fixture.output / "mine.txt"
            unowned.write_text("keep", encoding="utf-8")
            summary = POST.run(fixture.args(overwrite=True))
            self.assertEqual(summary["processed_records"], 1)
            self.assertEqual(unowned.read_text(encoding="utf-8"), "keep")

    def test_overwrite_verifies_inputs_before_removing_owned_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            POST.run(fixture.args())
            manifest_before = (fixture.output / POST.MANIFEST_NAME).read_bytes()
            record = read_jsonl(fixture.output / POST.MANIFEST_NAME)[0]
            output_mask = fixture.output / record["assets"]["mask"]["path"]
            raw = fixture.input / fixture.rows[0]["image_path"]
            Image.new("RGB", Image.open(raw).size, "white").save(raw)

            with self.assertRaises(POST.SourceIntegrityError):
                POST.run(fixture.args(overwrite=True))
            self.assertEqual(
                (fixture.output / POST.MANIFEST_NAME).read_bytes(),
                manifest_before,
            )
            self.assertTrue(output_mask.is_file())

    def test_owned_link_is_never_followed_during_removal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owned = root / "owned"
            owned.mkdir()
            with mock.patch.object(
                type(owned),
                "is_symlink",
                return_value=True,
            ):
                with self.assertRaises(POST.UnsafeOutputError):
                    POST._remove_owned(owned, root)
            self.assertTrue(owned.is_dir())

    def test_one_work_cannot_cross_splits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            row = fixture.add_candidate(
                "fhc-fixture-b",
                bbox=(22, 18, 70, 58),
                crop_bbox=(16, 11, 77, 65),
            )
            row["split"] = "val"
            fixture.write_manifest()
            with self.assertRaisesRegex(
                POST.InputValidationError,
                "crosses splits",
            ):
                POST.run(fixture.args(dry_run=True))

    def test_rejects_non_builder_hard_candidate_contracts(self) -> None:
        invalid_rows = (
            ("schema", {"schema_version": 2}),
            ("tier", {"tier": "B"}),
            ("split", {"split": "dev"}),
            ("category", {"categories": ["not_a_hard_category"]}),
            (
                "primary_category",
                {"primary_category": "text_free"},
            ),
        )
        for label, changes in invalid_rows:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                fixture = HardFixture(Path(temporary))
                fixture.rows[0].update(changes)
                fixture.write_manifest()
                with self.assertRaises(POST.InputValidationError):
                    POST.run(fixture.args(dry_run=True))

    def test_processing_configuration_changes_record_and_asset_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HardFixture(Path(temporary))
            first_args = fixture.args()
            first_args.output_root = fixture.root / "output-small-padding"
            first_args.context_padding_min = 2
            first_args.context_padding_max = 2
            POST.run(first_args)
            first = read_jsonl(Path(first_args.output_root) / POST.MANIFEST_NAME)[0]

            second_args = fixture.args()
            second_args.output_root = fixture.root / "output-large-padding"
            second_args.context_padding_min = 20
            second_args.context_padding_max = 20
            POST.run(second_args)
            second = read_jsonl(Path(second_args.output_root) / POST.MANIFEST_NAME)[0]

            self.assertNotEqual(first["id"], second["id"])
            self.assertNotEqual(
                first["assets"]["context"]["id"],
                second["assets"]["context"]["id"],
            )
            self.assertNotEqual(
                first["context_bbox_px"],
                second["context_bbox_px"],
            )


if __name__ == "__main__":
    unittest.main()
