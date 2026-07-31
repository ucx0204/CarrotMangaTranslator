from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "build_fontclip_hard_candidates.py"
SPEC = importlib.util.spec_from_file_location(
    "build_fontclip_hard_candidates",
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load hard-candidate script: {SCRIPT_PATH}")
HARD = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = HARD
SPEC.loader.exec_module(HARD)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


class FakeDetector:
    def __init__(self, calls: dict[str, int]) -> None:
        self.calls = calls
        self.inference_count = 0

    def detect(self, image: Image.Image) -> list:
        self.calls["count"] += 1
        self.inference_count += 1
        return [
            HARD.Detection("bubble", 0.95, (4, 4, 40, 40)),
            HARD.Detection("text_free", 0.90, (10, 10, 30, 30)),
        ]


class LibraryFixture:
    def __init__(self, root: Path) -> None:
        self.library = root / "library"
        self.work_id = "work-1"
        self.chapter_id = "chapter-1"
        self.page_id = "page-1"
        self.work_dir = self.library / "works" / self.work_id
        self.chapter_dir = self.work_dir / "chapters" / self.chapter_id
        self.page_path = self.chapter_dir / "pages" / f"001-{self.page_id}.png"
        self._build()

    def _build(self) -> None:
        write_json(self.library / "index.json", {"workOrder": [self.work_id]})
        write_json(
            self.work_dir / "work.json",
            {
                "id": self.work_id,
                "title": "Work",
                "chapterOrder": [self.chapter_id],
            },
        )
        self.page_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (64, 64), (245, 245, 245)).save(self.page_path)
        write_json(
            self.chapter_dir / "chapter.json",
            {
                "id": self.chapter_id,
                "workId": self.work_id,
                "title": "Chapter",
                "pageOrder": [self.page_id],
                "pages": [
                    {
                        "id": self.page_id,
                        "name": "001.png",
                        "imagePath": str(self.page_path),
                        "width": 64,
                        "height": 64,
                        "blocks": [
                            {
                                "id": "sound-1",
                                "textRole": "sound",
                                "sourceText": "ドン",
                                "confidence": 0.99,
                                "bboxSpace": "pixels",
                                "bbox": {"x": 10, "y": 10, "w": 20, "h": 20},
                            }
                        ],
                    }
                ],
            },
        )


class HardCandidateClassificationTests(unittest.TestCase):
    def test_layout_categories_cover_free_near_and_bubble_edge(self) -> None:
        detections = [
            HARD.Detection("bubble", 0.99, (10, 10, 100, 100)),
            HARD.Detection("text_bubble", 0.91, (12, 30, 40, 60)),
            HARD.Detection("text_free", 0.88, (103, 30, 130, 60)),
            HARD.Detection("text_free", 0.80, (160, 160, 190, 190)),
        ]
        candidates = HARD.classify_layout_candidates(
            detections,
            200,
            200,
            bubble_edge_ratio=0.10,
            near_bubble_ratio=0.05,
        )
        categories = [candidate.categories for candidate in candidates]
        self.assertIn({"bubble_edge"}, categories)
        self.assertIn({"text_free", "free_near_bubble"}, categories)
        self.assertIn({"text_free"}, categories)

    def test_metadata_sources_merge_categories_without_duplicate_crop(self) -> None:
        page = HARD.PageRecord(
            id="page",
            name="page.png",
            source_path=Path("page.png"),
            width=100,
            height=100,
            blocks=(
                {
                    "id": "block",
                    "textRole": "sound",
                    "sourceText": "ドン",
                    "confidence": 0.95,
                    "bboxSpace": "pixels",
                    "bbox": {"x": 10, "y": 10, "w": 30, "h": 30},
                },
            ),
            order_index=0,
        )
        sound = HARD.page_sound_candidates(page, 100, 100)
        ocr = HARD.ocr_metadata_candidates(
            page,
            [
                {
                    "id": "hint",
                    "x1": 10,
                    "y1": 10,
                    "x2": 40,
                    "y2": 40,
                    "score": 0.8,
                    "ocrText": "ドン",
                    "rolePrior": "oversized_sfx",
                    "reviewReasons": ["oversized_uncertain_sfx"],
                    "containerType": "text_free",
                    "animeTextRegionId": "anime-1",
                    "animeTextRegionScore": 0.9,
                }
            ],
            100,
            100,
        )
        merged = HARD.deduplicate_candidates(sound + ocr, 0.5)
        self.assertEqual(len(merged), 1)
        self.assertEqual(
            merged[0].categories,
            {
                "page_sound",
                "ocr_sound_prior",
                "ocr_hard",
                "ocr_free_container",
                "ocr_anime_region",
            },
        )
        self.assertEqual(len(merged[0].evidence), 2)

    def test_sound_block_union_uses_actual_size_for_normalized_bboxes(
        self,
    ) -> None:
        base_bbox = {"x": 100, "y": 200, "w": 100, "h": 200}
        blocks = (
            {
                "id": "by-text-role",
                "textRole": "sound",
                "type": "nonsolid",
                "bboxSpace": "normalized_1000",
                "bbox": base_bbox,
            },
            {
                "id": "by-type",
                "type": "sfx",
                "bboxSpace": "pixels",
                "bbox": {"x": 50, "y": 10, "w": 10, "h": 20},
            },
            {
                "id": "by-sound-effect",
                "type": "sound-effect",
                "bboxSpace": "pixels",
                "bbox": {"x": 70, "y": 10, "w": 10, "h": 20},
            },
            {
                "id": "by-role",
                "role": "onomatopoeia",
                "bboxSpace": "pixels",
                "bbox": {"x": 90, "y": 10, "w": 10, "h": 20},
            },
            {
                "id": "ordinary",
                "textRole": "dialogue",
                "type": "speech",
                "bboxSpace": "pixels",
                "bbox": {"x": 110, "y": 10, "w": 10, "h": 20},
            },
        )
        page = HARD.PageRecord(
            "page",
            "page.png",
            Path("page.png"),
            1000,
            1400,
            blocks,
            0,
        )
        candidates = HARD.page_sound_candidates(page, 200, 100)
        self.assertEqual(len(candidates), 4)
        by_id = {candidate.evidence[0]["id"]: candidate for candidate in candidates}
        self.assertEqual(by_id["by-text-role"].bbox, (20, 20, 40, 40))
        self.assertEqual(
            by_id["by-sound-effect"].evidence[0]["sound_match_fields"],
            ["type"],
        )
        self.assertEqual(
            by_id["by-role"].evidence[0]["role"],
            "onomatopoeia",
        )

    def test_page_nms_and_accepted_iou_are_class_aware_then_page_aware(
        self,
    ) -> None:
        detections = [
            HARD.Detection("text_free", 0.9, (10, 10, 40, 40)),
            HARD.Detection("text_free", 0.8, (11, 11, 41, 41)),
            HARD.Detection("bubble", 0.99, (10, 10, 40, 40)),
        ]
        kept = HARD.nms_detections(detections, 0.5)
        self.assertEqual(
            [(item.label, item.score) for item in kept],
            [("bubble", 0.99), ("text_free", 0.9)],
        )
        index = HARD.AcceptedBoxIndex()
        index.add(
            {
                "id": "approved",
                "source_image_path": "works/w/chapters/c/pages/p.png",
                "work_id": "w",
                "chapter_id": "c",
                "page_id": "p",
                "bbox_px": [10, 10, 40, 40],
            }
        )
        work = HARD.WorkRecord("w", "W", ("c",), Path(), "a" * 64, 0)
        page = HARD.PageRecord("p", "p.png", Path(), 100, 100, (), 0)
        chapter = HARD.ChapterRecord("c", "C", "w", Path(), (page,), "b" * 64, 0)
        selection = HARD.SelectedChapter(work, chapter, 0, 0, 1)
        frozen = HARD.FrozenPage(
            selection=selection,
            page=page,
            source_sha256="c" * 64,
            source_size_bytes=1,
            actual_width=100,
            actual_height=100,
            source_dimension_mismatch=False,
            ocr_hints=(),
            ocr_hints_sha256=None,
            ocr_coordinate_provenance={"state": "missing"},
            ocr_metadata_skip_reasons={},
        )
        match = index.high_iou_match(
            frozen,
            (11, 11, 39, 39),
            0.7,
            Path(),
        )
        self.assertEqual(match[0], "approved")


class HardCandidateSelectionAndSafetyTests(unittest.TestCase):
    def test_chapter_selection_spans_the_full_timeline_and_caps_at_twenty(
        self,
    ) -> None:
        chapter_ids = tuple(f"chapter-{index:02d}" for index in range(50))
        work = HARD.WorkRecord(
            "work",
            "Work",
            chapter_ids,
            Path(),
            "a" * 64,
            0,
        )
        chapters = tuple(
            HARD.ChapterRecord(
                chapter_id,
                chapter_id,
                "work",
                Path(),
                (),
                "b" * 64,
                index,
            )
            for index, chapter_id in enumerate(chapter_ids)
        )
        selected = HARD.select_chapters_evenly(work, chapters, 20)
        indices = [item.chapter.order_index for item in selected]
        self.assertEqual(len(indices), 20)
        self.assertEqual(indices[0], 0)
        self.assertEqual(indices[-1], 49)
        self.assertEqual(indices, sorted(set(indices)))
        self.assertLessEqual(max(b - a for a, b in zip(indices, indices[1:])), 3)
        with self.assertRaises(ValueError):
            HARD.select_chapters_evenly(work, chapters, 21)

    def test_output_path_and_page_source_escape_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            library = repo / "library"
            library.mkdir(parents=True)
            with self.assertRaises(HARD.UnsafeOutputError):
                HARD.validate_output_path(
                    library / "dataset",
                    library_root=library,
                    repo_root=repo,
                )
            safe = HARD.validate_output_path(
                repo / "datasets" / "hard",
                library_root=library,
                repo_root=repo,
            )
            self.assertEqual(safe, (repo / "datasets" / "hard").resolve())

            outside = root / "outside.png"
            Image.new("RGB", (8, 8), "white").save(outside)
            write_json(library / "index.json", {"workOrder": ["work"]})
            write_json(
                library / "works" / "work" / "work.json",
                {
                    "id": "work",
                    "chapterOrder": ["chapter"],
                },
            )
            chapter = library / "works" / "work" / "chapters" / "chapter"
            (chapter / "pages").mkdir(parents=True)
            write_json(
                chapter / "chapter.json",
                {
                    "id": "chapter",
                    "workId": "work",
                    "pageOrder": ["page"],
                    "pages": [
                        {
                            "id": "page",
                            "name": "outside.png",
                            "imagePath": str(outside),
                            "width": 8,
                            "height": 8,
                            "blocks": [],
                        }
                    ],
                },
            )
            with self.assertRaises(HARD.LibraryValidationError):
                HARD.load_library(library)

    def test_overwrite_requires_the_exact_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            output.mkdir()
            (output / "unowned.txt").write_text("mine", encoding="utf-8")
            with self.assertRaises(HARD.UnsafeOutputError):
                HARD.prepare_output(
                    output,
                    signature={"test": True},
                    overwrite=True,
                    dry_run=False,
                )


class HardCandidateDimensionMismatchTests(unittest.TestCase):
    def _stale_fixture(
        self,
        root: Path,
    ) -> tuple[LibraryFixture, Path]:
        fixture = LibraryFixture(root)
        chapter_path = fixture.chapter_dir / "chapter.json"
        chapter = json.loads(chapter_path.read_text(encoding="utf-8"))
        chapter["pages"][0]["width"] = 100
        chapter["pages"][0]["height"] = 140
        write_json(chapter_path, chapter)
        ocr_path = fixture.chapter_dir / "ocr-hints" / fixture.page_id / "result.json"
        write_json(
            ocr_path,
            {
                "imagePath": str(fixture.page_path),
                "width": 100,
                "height": 140,
                "hints": [
                    {
                        "id": 7,
                        "x1": 10,
                        "y1": 14,
                        "x2": 30,
                        "y2": 42,
                        "score": 0.8,
                        "ocrText": "ドン",
                        "reviewReasons": ["oversized_uncertain_sfx"],
                    }
                ],
            },
        )
        return fixture, ocr_path

    def test_stale_declared_and_ocr_sizes_scale_to_actual_and_are_signed(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture, _ = self._stale_fixture(root)
            inventory = HARD.load_library(fixture.library)
            work, chapters = inventory[0]
            selection = HARD.select_chapters_evenly(work, chapters, 20)
            frozen = HARD.freeze_selected_pages(selection)[0]
            self.assertEqual((frozen.page.width, frozen.page.height), (100, 140))
            self.assertEqual(
                (frozen.actual_width, frozen.actual_height),
                (64, 64),
            )
            self.assertTrue(frozen.source_dimension_mismatch)
            self.assertEqual(
                frozen.ocr_coordinate_provenance["coordinate_basis"],
                "declared_pixels_scaled_to_actual",
            )
            self.assertEqual(
                [frozen.ocr_hints[0][key] for key in ("x1", "y1", "x2", "y2")],
                [6, 6, 20, 20],
            )

            output = root / "output"
            model = root / "model.onnx"
            model.write_bytes(b"fake-model-for-dimension-test")
            model_sha = hashlib.sha256(model.read_bytes()).hexdigest()
            args = HARD.build_argument_parser().parse_args(
                [
                    "--library",
                    str(fixture.library),
                    "--output",
                    str(output),
                    "--model",
                    str(model),
                    "--expected-model-sha256",
                    model_sha,
                    "--no-accepted-dedup",
                    "--minimum-candidates",
                    "0",
                    "--quiet",
                ]
            )
            report = HARD.run(
                args,
                detector_factory=lambda _path, _score: FakeDetector({"count": 0}),
            )
            self.assertEqual(report["source_dimension_mismatch_pages"], 1)
            records = HARD._read_jsonl(output / "manifest.jsonl")
            self.assertGreaterEqual(len(records), 1)
            for record in records:
                self.assertEqual(record["declared_page_size_px"], [100, 140])
                self.assertEqual(record["page_size_px"], [64, 64])
                self.assertTrue(record["source_dimension_mismatch"])
            page_report = HARD._read_jsonl(output / "report.jsonl")[0]
            self.assertEqual(page_report["declared_page_size_px"], [100, 140])
            self.assertEqual(page_report["page_size_px"], [64, 64])
            self.assertTrue(page_report["source_dimension_mismatch"])
            checkpoint = HARD._read_json(
                next((output / HARD.STATE_DIR_NAME).glob("*.json"))
            )
            self.assertEqual(
                checkpoint["page_signature"]["declared_page_size_px"],
                [100, 140],
            )
            self.assertEqual(
                checkpoint["page_signature"]["actual_page_size_px"],
                [64, 64],
            )
            self.assertTrue(checkpoint["page_signature"]["source_dimension_mismatch"])

    def test_ambiguous_ocr_coordinate_dimensions_skip_only_metadata_candidate(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture, ocr_path = self._stale_fixture(root)
            payload = json.loads(ocr_path.read_text(encoding="utf-8"))
            payload["width"] = 80
            payload["height"] = 160
            write_json(ocr_path, payload)
            work, chapters = HARD.load_library(fixture.library)[0]
            selection = HARD.select_chapters_evenly(work, chapters, 20)
            frozen = HARD.freeze_selected_pages(selection)[0]
            self.assertEqual(frozen.ocr_hints, ())
            self.assertEqual(
                frozen.ocr_metadata_skip_reasons,
                {"ocr_dimension_basis_ambiguous": 1},
            )
            self.assertEqual(
                frozen.ocr_coordinate_provenance["state"],
                "skipped",
            )
            candidates = HARD.build_page_candidates(
                [HARD.Detection("text_free", 0.9, (10, 10, 30, 30))],
                frozen,
                HARD.MiningConfig(0.35, 0.6, 0.55, 0.18, 0.035, 0.7, 0.1, 2, 24),
            )
            self.assertTrue(
                any("text_free" in candidate.categories for candidate in candidates)
            )

    def test_zero_or_invalid_declared_dimensions_keep_decoded_actual_size(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = LibraryFixture(root)
            chapter_path = fixture.chapter_dir / "chapter.json"
            chapter = json.loads(chapter_path.read_text(encoding="utf-8"))
            chapter["pages"][0]["width"] = 0
            chapter["pages"][0]["height"] = "invalid"
            write_json(chapter_path, chapter)
            work, chapters = HARD.load_library(fixture.library)[0]
            selection = HARD.select_chapters_evenly(work, chapters, 20)
            frozen = HARD.freeze_selected_pages(selection)[0]
            self.assertEqual((frozen.page.width, frozen.page.height), (0, None))
            self.assertEqual(
                (frozen.actual_width, frozen.actual_height),
                (64, 64),
            )
            self.assertTrue(frozen.source_dimension_mismatch)


class HardCandidateResumeTests(unittest.TestCase):
    def test_dry_run_does_not_create_output_or_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = LibraryFixture(root)
            output = root / "dry-output"
            model = root / "model.onnx"
            model.write_bytes(b"fake-model-for-dry-run")
            model_sha = hashlib.sha256(model.read_bytes()).hexdigest()
            args = HARD.build_argument_parser().parse_args(
                [
                    "--library",
                    str(fixture.library),
                    "--output",
                    str(output),
                    "--model",
                    str(model),
                    "--expected-model-sha256",
                    model_sha,
                    "--no-accepted-dedup",
                    "--minimum-candidates",
                    "0",
                    "--dry-run",
                    "--quiet",
                ]
            )
            calls = {"count": 0}
            report = HARD.run(
                args,
                detector_factory=lambda _path, _score: FakeDetector(calls),
            )
            self.assertTrue(report["dry_run"])
            self.assertEqual(report["candidate_records"], 1)
            self.assertEqual(calls["count"], 1)
            self.assertFalse(output.exists())

    def test_completed_page_resumes_without_a_second_inference(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = LibraryFixture(root)
            output = root / "output"
            model = root / "model.onnx"
            model.write_bytes(b"fake-model-for-unit-test")
            model_sha = hashlib.sha256(model.read_bytes()).hexdigest()
            args = HARD.build_argument_parser().parse_args(
                [
                    "--library",
                    str(fixture.library),
                    "--output",
                    str(output),
                    "--model",
                    str(model),
                    "--expected-model-sha256",
                    model_sha,
                    "--no-accepted-dedup",
                    "--minimum-candidates",
                    "0",
                    "--quiet",
                ]
            )
            calls = {"count": 0}

            def factory(_path: Path, _score: float) -> FakeDetector:
                return FakeDetector(calls)

            first = HARD.run(args, detector_factory=factory)
            self.assertEqual(first["new_page_inferences"], 1)
            self.assertEqual(first["resumed_pages"], 0)
            self.assertEqual(first["candidate_records"], 1)
            self.assertEqual(calls["count"], 1)
            record = HARD._read_jsonl(output / "manifest.jsonl")[0]
            self.assertEqual(record["provenance"], "real_mined")
            self.assertEqual(
                set(record["categories"]),
                {"page_sound", "text_free", "free_near_bubble"},
            )
            self.assertTrue((output / record["image_path"]).is_file())
            self.assertTrue((output / record["clip_image_path"]).is_file())

            second = HARD.run(args, detector_factory=factory)
            self.assertEqual(second["new_page_inferences"], 0)
            self.assertEqual(second["resumed_pages"], 1)
            self.assertEqual(second["candidate_records"], 1)
            self.assertEqual(calls["count"], 1)

            raw_path = output / record["image_path"]
            original_raw = raw_path.read_bytes()
            raw_path.write_bytes(b"tampered")
            with self.assertRaises(HARD.ResumeValidationError):
                HARD.run(args, detector_factory=factory)
            self.assertEqual(calls["count"], 1)
            raw_path.write_bytes(original_raw)

            Image.new("RGB", (64, 64), (1, 2, 3)).save(fixture.page_path)
            with self.assertRaises(HARD.ResumeValidationError):
                HARD.run(args, detector_factory=factory)
            self.assertEqual(calls["count"], 1)


if __name__ == "__main__":
    unittest.main()
