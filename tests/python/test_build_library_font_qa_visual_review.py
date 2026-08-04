from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]


def load_script():
    path = ROOT / "scripts" / "build_library_font_qa_visual_review.py"
    spec = importlib.util.spec_from_file_location(
        "build_library_font_qa_visual_review_test_target", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


REVIEW = load_script()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


class CompletedRunFixture:
    def __init__(self, root: Path, page_count: int = 2) -> None:
        self.root = root
        self.run_dir = root / "실제 보관함 런"
        self.report_path = self.run_dir / "run-report.json"
        self.pages: list[dict[str, Any]] = []
        for index in range(page_count):
            self.pages.append(self._build_page(index))
        self.report: dict[str, Any] = {
            "schemaVersion": 1,
            "status": "completed",
            "startedAt": "2026-08-03T00:00:00.000Z",
            "finishedAt": "2026-08-03T00:01:00.000Z",
            "runId": "fixture-run-한글",
            "cohort": "baseline40",
            "cohortDigest": "c" * 64,
            "candidateId": "fixture-candidate",
            "pageCount": page_count,
            "pages": self.pages,
        }
        self.write_report()

    def _image(self, path: Path, index: int, rendered: bool) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (320, 460), (246, 244, 238))
        draw = ImageDraw.Draw(image)
        draw.rectangle((22, 30, 298, 170), fill=(232, 234, 239), outline=(45, 48, 55), width=3)
        draw.ellipse((45, 205, 275, 405), fill=(255, 255, 255), outline=(60, 60, 60), width=3)
        if rendered:
            draw.rectangle((72, 88, 246, 117), fill=(40 + index * 10, 82, 132))
            draw.rectangle((100, 278, 224, 309), fill=(168, 56 + index * 10, 56))
        else:
            draw.line((73, 101, 245, 101), fill=(25, 25, 25), width=8)
            draw.line((102, 292, 223, 292), fill=(25, 25, 25), width=7)
        image.save(path, format="PNG")
        image.close()

    def _build_page(self, index: int) -> dict[str, Any]:
        page_number = index + 1
        page_dir = self.run_dir / "pages" / f"{page_number:02d}" / "한글 경로"
        original = page_dir / "원본.png"
        cleaned = page_dir / "인페인트.png"
        rendered = page_dir / "최종 렌더.png"
        font_input = page_dir / "font-input.json"
        font_inference = page_dir / "font-inference.json"
        self._image(original, index, rendered=False)
        self._image(cleaned, index, rendered=False)
        self._image(rendered, index, rendered=True)
        decisions = [
            {
                "blockIndex": 0,
                "blockId": f"block-{page_number}-대사",
                "bbox": {"x": 205, "y": 166, "w": 565, "h": 118},
                "sourceText": "これは台詞です",
                "translatedText": "이것은 대사입니다",
                "applied": True,
                "selectedFontId": "nanum-gothic",
                "effectiveFontFamily": "나눔고딕",
                "role": "dialogue",
                "confidence": 0.81,
                "effectiveOutlineColor": "#ffffff",
                "effectiveOutlineContrastRatio": 18.883060964595,
                "effectiveOutlineWidthScale": 1,
                "effectiveTextColor": "#111111",
                "source": "pixel_runtime",
                "selectionCalibration": {"version": 1},
                "noneAcceptable": False,
                "localConfidence": 0.79,
                "top5": [
                    {
                        "fontId": "nanum-gothic",
                        "confidence": 0.81,
                        "totalScore": 1.2,
                        "styleFit": 0.8,
                        "reasonCodes": ["visual_match"],
                    }
                ],
            },
            {
                "blockIndex": 1,
                "blockId": f"block-{page_number}-효과음",
                "bbox": {"x": 300, "y": 570, "w": 400, "h": 130},
                "sourceText": "ドン",
                "translatedText": "쾅",
                "applied": True,
                "selectedFontId": "gasoek-one",
                "effectiveFontFamily": "가속 원",
                "role": "sound_effect",
                "confidence": 0.74,
                "effectiveOutlineColor": "#111111",
                "effectiveOutlineContrastRatio": 18.883060964595,
                "effectiveOutlineWidthScale": 1.75,
                "effectiveTextColor": "#ffffff",
                "source": "pixel_runtime",
                "selectionCalibration": {"version": 1},
                "noneAcceptable": False,
                "localConfidence": 0.72,
                "top5": [
                    {
                        "fontId": "gasoek-one",
                        "confidence": 0.74,
                        "totalScore": 1.1,
                        "styleFit": 0.85,
                        "reasonCodes": ["sfx"],
                    }
                ],
            },
        ]
        page_id = f"page-{page_number}-한글"
        source_sha = sha256_file(original)
        write_json(
            font_input,
            {
                "schemaVersion": 1,
                "sourcePageId": page_id,
                "sourcePageSha256": source_sha,
                "page": {"blocks": [{"id": row["blockId"]} for row in decisions]},
                "requestBlocks": [
                    {"blockId": row["blockId"], "item": {}} for row in decisions
                ],
            },
        )
        write_json(font_inference, {"schemaVersion": 1, "pixelInference": []})
        # Exercise both absolute Unicode paths and run-relative Unicode paths.
        relative_cleaned = cleaned.relative_to(self.run_dir).as_posix()
        relative_font_input = font_input.relative_to(self.run_dir).as_posix()
        return {
            "selectionIndex": index,
            "sourcePageId": page_id,
            "sourcePageName": f"페이지-{page_number}.png",
            "sourcePageSha256": source_sha,
            "workId": f"work-{page_number}",
            "workTitle": f"서로 다른 작품 {page_number}",
            "chapterId": f"chapter-{page_number}",
            "chapterTitle": f"제{page_number}화",
            "status": "completed",
            "stage": "done",
            "mode": "full-pipeline",
            "blockCount": len(decisions),
            "blocksErased": len(decisions),
            "blocksIncomplete": 0,
            "stagedOriginalImagePath": str(original.resolve()),
            "cleanedImagePath": relative_cleaned,
            "renderedImagePath": str(rendered.resolve()),
            "renderedImageSha256": sha256_file(rendered),
            "fontInputPath": relative_font_input,
            "fontInferencePath": str(font_inference.resolve()),
            "fontDecisions": decisions,
        }

    def write_report(self) -> None:
        write_json(self.report_path, self.report)

    def file_snapshot(self) -> dict[str, str]:
        return {
            path.relative_to(self.run_dir).as_posix(): sha256_file(path)
            for path in self.run_dir.rglob("*")
            if path.is_file()
        }


class LibraryFontQaVisualReviewTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "유니코드 테스트"
        self.fixture = CompletedRunFixture(self.root)
        self.output = self.root / "육안 검수 팩"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def build(self, **changes: Any) -> dict[str, Any]:
        values = {
            "report_path": self.fixture.report_path,
            "output_dir": self.output,
            "expected_pages": 2,
            "pair_page_max_width": 420,
            "pair_page_max_height": 620,
            "blocks_per_sheet": 1,
            "crop_padding_ratio": 0.25,
        }
        values.update(changes)
        return REVIEW.build_review(REVIEW.BuildOptions(**values))

    def test_builds_complete_unicode_pack_without_mutating_run(self) -> None:
        before = self.fixture.file_snapshot()
        result = self.build()
        after = self.fixture.file_snapshot()

        self.assertEqual(before, after)
        self.assertTrue(result["ok"])
        self.assertEqual(result["pages"], 2)
        self.assertEqual(result["blocks"], 4)
        self.assertEqual(result["inspectionAssets"], 6)
        self.assertEqual(REVIEW.validate_review(self.output)["indexSha256"], result["indexSha256"])

        index = json.loads(
            (self.output / REVIEW.INDEX_NAME).read_text(encoding="utf-8")
        )
        self.assertEqual([row["pageNumber"] for row in index["pages"]], [1, 2])
        self.assertIn("서로 다른 작품 1", json.dumps(index, ensure_ascii=False))
        order = (self.output / REVIEW.ORDER_NAME).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(order), 6)
        self.assertTrue(all(Path(path).is_file() for path in order))
        with Image.open(order[0]) as pair:
            pair.load()
            self.assertGreater(pair.width, pair.height)
        rows = [
            json.loads(line)
            for line in (self.output / REVIEW.DECISIONS_NAME)
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]["translatedText"], "이것은 대사입니다")
        self.assertIsNone(rows[0]["manualVerdict"])

    def test_zero_block_page_falls_back_to_and_deduplicates_original_image(
        self,
    ) -> None:
        page = self.fixture.report["pages"][0]
        page["cleanedImagePath"] = ""
        page["blockCount"] = 0
        page["blocksErased"] = 0
        page["fontDecisions"] = []
        page["fontInferencePath"] = None
        font_input = self.fixture.run_dir / page["fontInputPath"]
        font_input_value = json.loads(font_input.read_text(encoding="utf-8"))
        font_input_value["page"]["blocks"] = []
        font_input_value["requestBlocks"] = []
        write_json(font_input, font_input_value)
        self.fixture.write_report()

        result = self.build()

        self.assertTrue(result["ok"])
        index = json.loads(
            (self.output / REVIEW.INDEX_NAME).read_text(encoding="utf-8")
        )
        inputs = index["pages"][0]["inputs"]
        self.assertEqual(inputs["original"]["path"], inputs["cleaned"]["path"])
        self.assertEqual("staged_original_image", inputs["original"]["kind"])
        self.assertEqual("cleaned_image", inputs["cleaned"]["kind"])
        sealed_paths = [row["path"] for row in index["binding"]["inputs"]]
        self.assertEqual(1, sealed_paths.count(inputs["original"]["path"]))

    def test_duplicate_input_path_rejects_sha_or_size_conflicts(self) -> None:
        base = {
            "kind": "staged_original_image",
            "path": str((self.root / "shared.png").resolve()),
            "sha256": "a" * 64,
            "size": 123,
        }
        for field, value in (("sha256", "b" * 64), ("size", 124)):
            with self.subTest(field=field), self.assertRaisesRegex(
                REVIEW.ReviewError, "Conflicting bindings for input"
            ):
                REVIEW._unique_input_bindings(
                    [
                        {"inputs": {"original": base}},
                        {
                            "inputs": {
                                "cleaned": {
                                    **base,
                                    "kind": "cleaned_image",
                                    field: value,
                                }
                            }
                        },
                    ]
                )

    def test_validation_detects_generated_png_tampering(self) -> None:
        self.build()
        target = self.output / "pages" / "page-001-pair.png"
        target.write_bytes(target.read_bytes() + b"tampered")
        with self.assertRaisesRegex(REVIEW.ReviewError, "size changed|SHA-256 changed"):
            REVIEW.validate_review(self.output)

    def test_validation_detects_source_run_drift(self) -> None:
        self.build()
        source = Path(self.fixture.pages[0]["stagedOriginalImagePath"])
        source.write_bytes(source.read_bytes() + b"changed")
        with self.assertRaisesRegex(REVIEW.ReviewError, "Sealed file size changed|SHA-256"):
            REVIEW.validate_review(self.output)

    def test_validation_detects_index_tampering(self) -> None:
        self.build()
        index_path = self.output / REVIEW.INDEX_NAME
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["reviewStatus"] = "accepted_without_review"
        write_json(index_path, index)
        with self.assertRaisesRegex(REVIEW.ReviewError, "does not match its SHA-256 seal"):
            REVIEW.validate_review(self.output)

    def test_rejects_partial_or_missing_page_before_creating_output(self) -> None:
        self.fixture.report["pages"][1]["status"] = "failed"
        self.fixture.report["pages"][1]["stage"] = "translation"
        self.fixture.write_report()
        with self.assertRaisesRegex(REVIEW.ReviewError, "missing, partial"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_incomplete_font_input_coverage(self) -> None:
        page = self.fixture.report["pages"][0]
        font_input = self.fixture.run_dir / page["fontInputPath"]
        value = json.loads(font_input.read_text(encoding="utf-8"))
        value["requestBlocks"].pop()
        write_json(font_input, value)
        with self.assertRaisesRegex(REVIEW.ReviewError, "block coverage is incomplete"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_unsafe_applied_font_outline_contract(self) -> None:
        cases = (
            (
                "missing width",
                lambda decision: decision.pop("effectiveOutlineWidthScale"),
                "effectiveOutlineWidthScale must be a finite number > 0",
            ),
            (
                "zero width",
                lambda decision: decision.__setitem__(
                    "effectiveOutlineWidthScale", 0
                ),
                "effectiveOutlineWidthScale must be a finite number > 0",
            ),
            (
                "nonfinite width",
                lambda decision: decision.__setitem__(
                    "effectiveOutlineWidthScale", float("nan")
                ),
                "effectiveOutlineWidthScale must be a finite number > 0",
            ),
            (
                "invalid color",
                lambda decision: decision.__setitem__(
                    "effectiveOutlineColor", "transparent"
                ),
                "effectiveOutlineColor must be a six-digit hex color",
            ),
            (
                "low contrast",
                lambda decision: decision.update(
                    {
                        "effectiveTextColor": "#777777",
                        "effectiveOutlineColor": "#888888",
                    }
                ),
                "effective text/outline contrast .* is below the required 3",
            ),
        )
        for case_index, (label, mutate, message) in enumerate(cases):
            with self.subTest(case=label):
                fixture = CompletedRunFixture(
                    self.root / f"외곽선-실패-{case_index}"
                )
                decision = fixture.report["pages"][0]["fontDecisions"][0]
                mutate(decision)
                fixture.write_report()
                output = fixture.root / "출력"
                with self.assertRaisesRegex(REVIEW.ReviewError, message):
                    REVIEW.build_review(
                        REVIEW.BuildOptions(
                            fixture.report_path,
                            output,
                            expected_pages=2,
                        )
                    )
                self.assertFalse(output.exists())

    def test_rejects_bad_render_hash_and_invalid_bbox(self) -> None:
        with self.subTest("render hash"):
            fixture = CompletedRunFixture(self.root / "해시 실패")
            output = fixture.root / "출력"
            fixture.report["pages"][0]["renderedImageSha256"] = "0" * 64
            fixture.write_report()
            with self.assertRaisesRegex(REVIEW.ReviewError, "rendered_image SHA-256 mismatch"):
                REVIEW.build_review(
                    REVIEW.BuildOptions(fixture.report_path, output, expected_pages=2)
                )
            self.assertFalse(output.exists())
        with self.subTest("bbox"):
            fixture = CompletedRunFixture(self.root / "좌표 실패")
            output = fixture.root / "출력"
            fixture.report["pages"][0]["fontDecisions"][0]["bbox"]["w"] = 900
            fixture.write_report()
            with self.assertRaisesRegex(REVIEW.ReviewError, "exceeds normalized_1000"):
                REVIEW.build_review(
                    REVIEW.BuildOptions(fixture.report_path, output, expected_pages=2)
                )
            self.assertFalse(output.exists())

    def test_rejects_output_inside_source_run_and_existing_output(self) -> None:
        inside = self.fixture.run_dir / "review"
        with self.assertRaisesRegex(REVIEW.ReviewError, "outside the source run"):
            self.build(output_dir=inside)
        self.output.mkdir(parents=True)
        with self.assertRaisesRegex(REVIEW.ReviewError, "Refusing to overwrite"):
            self.build()

    def test_expected_page_count_is_exact(self) -> None:
        with self.assertRaisesRegex(REVIEW.ReviewError, "Expected exactly 40"):
            self.build(expected_pages=40)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
