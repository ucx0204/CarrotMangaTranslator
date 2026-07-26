from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "src" / "main" / "runtime" / "paddleocr-vl-bboxes.py"
SPEC = importlib.util.spec_from_file_location("paddleocr_vl_bboxes", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load OCR script: {SCRIPT_PATH}")
OCR = importlib.util.module_from_spec(SPEC)
RUNTIME_MODULE_PATH = str(SCRIPT_PATH.parent)
ADDED_RUNTIME_MODULE_PATH = RUNTIME_MODULE_PATH not in sys.path
if ADDED_RUNTIME_MODULE_PATH:
    sys.path.insert(0, RUNTIME_MODULE_PATH)
try:
    SPEC.loader.exec_module(OCR)
finally:
    if ADDED_RUNTIME_MODULE_PATH:
        sys.path.remove(RUNTIME_MODULE_PATH)


def batch_args(progress_path: str) -> argparse.Namespace:
    return argparse.Namespace(progress=progress_path, device="cpu", engine="paddle")


def read_json_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def textline_candidate(text: str, x1: int, y1: int, x2: int, y2: int) -> dict:
    return {
        "label": "ocr_textline",
        "x1": x1,
        "y1": y1,
        "x2": x2,
        "y2": y2,
        "_score": 0.99,
        "_text": text,
    }


def rectangle_poly(x1: int, y1: int, x2: int, y2: int) -> list[list[int]]:
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


class AmbiguousTruthSequence:
    """Small ndarray stand-in that fails if production code tests its truthiness."""

    def __init__(self, items: list[object]) -> None:
        self.items = items

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> object:
        return self.items[index]

    def __bool__(self) -> bool:
        raise ValueError("The truth value of an array is ambiguous")


class CommandLineBehaviorTests(unittest.TestCase):
    def test_default_arguments_keep_the_vl_paddle_contract(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            args = OCR.build_argument_parser().parse_args([])

        self.assertEqual(args.pipeline_version, "v1.5")
        self.assertEqual(args.source_language, "ja")
        self.assertEqual(args.bbox_mode, "vl")
        self.assertEqual(args.engine, "paddle")
        self.assertEqual(args.dtype, "float32")
        self.assertEqual(args.ocr_version, "PP-OCRv6")

    def test_help_is_available_without_optional_ocr_dependencies(self) -> None:
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT_PATH), "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--bbox-mode {vl,ocr}", result.stdout)
        self.assertIn("--engine ENGINE", result.stdout)
        self.assertIn("--progress PROGRESS", result.stdout)


class LanguageAdapterBehaviorTests(unittest.TestCase):
    def test_source_languages_resolve_to_paddle_language_profiles(self) -> None:
        self.assertEqual(OCR.resolve_paddle_ocr_lang("ja-JP"), "japan")
        self.assertEqual(OCR.resolve_paddle_ocr_lang("zh-Hans"), "ch")
        self.assertEqual(OCR.resolve_paddle_ocr_lang("zh-TW"), "chinese_cht")
        self.assertEqual(OCR.resolve_paddle_ocr_lang("unknown"), "en")

    def test_ocr_version_and_configured_model_names_follow_language_support(self) -> None:
        self.assertEqual(OCR.resolve_paddle_ocr_version("ka", "PP-OCRv6"), "PP-OCRv3")
        self.assertEqual(OCR.resolve_paddle_ocr_version("ko", "PP-OCRv6"), "PP-OCRv5")
        self.assertEqual(OCR.resolve_paddle_ocr_version("ja", None), "PP-OCRv6")
        self.assertTrue(
            OCR.should_use_configured_model_names(
                "PP-OCRv6", "PP-OCRv6_small_det", "PP-OCRv6_small_rec"
            )
        )
        self.assertFalse(
            OCR.should_use_configured_model_names(
                "PP-OCRv5", "PP-OCRv6_small_det", "PP-OCRv6_small_rec"
            )
        )
        self.assertTrue(
            OCR.should_use_configured_model_names(
                "PP-OCRv5", "custom-v5-det", "custom-v5-rec"
            )
        )


class RecognitionResultAlignmentTests(unittest.TestCase):
    def test_filtered_recognition_rows_stay_attached_to_rec_polys(self) -> None:
        detected = [
            rectangle_poly(10, 10, 30, 80),
            rectangle_poly(40, 10, 60, 80),
            rectangle_poly(70, 10, 90, 80),
        ]
        entries = OCR.collect_recognized_ocr_entries(
            {
                "dt_polys": AmbiguousTruthSequence(detected),
                "rec_polys": AmbiguousTruthSequence([detected[0], detected[2]]),
                "rec_texts": AmbiguousTruthSequence(["A", "C"]),
                "rec_scores": AmbiguousTruthSequence([0.9, 0.8]),
            }
        )

        self.assertEqual([entry[0] for entry in entries], detected)
        self.assertEqual([entry[1] for entry in entries], ["A", "", "C"])
        self.assertEqual([entry[2] for entry in entries], [0.9, None, 0.8])

    def test_present_empty_rec_arrays_keep_all_detector_geometry_blank(self) -> None:
        detected = [
            rectangle_poly(10, 10, 30, 80),
            rectangle_poly(40, 10, 60, 80),
        ]
        entries = OCR.collect_recognized_ocr_entries(
            {
                "dt_polys": AmbiguousTruthSequence(detected),
                "rec_polys": AmbiguousTruthSequence([]),
                "rec_texts": AmbiguousTruthSequence([]),
                "texts": ["stale", "alias"],
                "rec_scores": AmbiguousTruthSequence([]),
                "scores": [0.99, 0.98],
            }
        )

        self.assertEqual([entry[0] for entry in entries], detected)
        self.assertEqual([entry[1] for entry in entries], ["", ""])
        self.assertEqual([entry[2] for entry in entries], [None, None])

    def test_malformed_recognition_lengths_fail_closed(self) -> None:
        detected = [
            rectangle_poly(10, 10, 30, 80),
            rectangle_poly(40, 10, 60, 80),
            rectangle_poly(70, 10, 90, 80),
        ]
        entries = OCR.collect_recognized_ocr_entries(
            {
                "dt_polys": detected,
                "rec_polys": detected,
                "rec_texts": ["A", "C"],
                "rec_scores": [0.9, 0.8],
            }
        )

        self.assertEqual([entry[0] for entry in entries], detected)
        self.assertEqual([entry[1] for entry in entries], ["", "", ""])
        self.assertEqual([entry[2] for entry in entries], [None, None, None])

    def test_polygon_vertex_order_and_duplicates_preserve_recognition_order(self) -> None:
        poly = rectangle_poly(10, 10, 30, 80)
        rotated = poly[1:] + poly[:1]
        reversed_winding = list(reversed(poly))
        entries = OCR.collect_recognized_ocr_entries(
            {
                "dt_polys": [poly, poly],
                "rec_polys": [rotated, reversed_winding],
                "rec_texts": ["first", "second"],
                "rec_scores": [0.9, 0.8],
            }
        )

        self.assertEqual([entry[1] for entry in entries], ["first", "second"])
        self.assertEqual([entry[2] for entry in entries], [0.9, 0.8])

    def test_legacy_vl_auxiliary_results_preserve_index_pairing(self) -> None:
        detected = [
            rectangle_poly(10, 10, 30, 80),
            rectangle_poly(40, 10, 60, 80),
        ]
        aligned = OCR.collect_legacy_indexed_ocr_entries(
            {
                "dt_polys": detected,
                "texts": ["A", "B"],
                "scores": [0.9, 0.8],
            }
        )
        mismatched = OCR.collect_legacy_indexed_ocr_entries(
            {"dt_polys": detected, "texts": ["shifted"], "scores": [0.9]}
        )
        score_mismatched = OCR.collect_legacy_indexed_ocr_entries(
            {"dt_polys": detected, "texts": ["A", "B"], "scores": [0.9]}
        )

        self.assertEqual([entry[1] for entry in aligned], ["A", "B"])
        self.assertEqual([entry[1] for entry in mismatched], ["shifted", ""])
        self.assertEqual([entry[1] for entry in score_mismatched], ["A", "B"])
        self.assertEqual([entry[2] for entry in score_mismatched], [0.9, None])

    def test_vl_auxiliary_detector_keeps_legacy_index_pairing(self) -> None:
        detected = [
            rectangle_poly(10, 10, 50, 110),
            rectangle_poly(300, 10, 340, 110),
            rectangle_poly(600, 10, 640, 110),
        ]

        class FakeLegacyAuxiliaryOcr:
            def predict(self, _image_path: str) -> list[dict]:
                return [
                    {
                        "dt_polys": detected,
                        "rec_polys": [detected[0], detected[2]],
                        "rec_texts": ["右", "左"],
                        "rec_scores": [0.9, 0.8],
                    }
                ]

        with patch.dict(
            os.environ,
            {
                "MANGA_TRANSLATOR_PADDLEOCR_ENGINE": "paddle",
                "MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE": "legacy",
            },
        ):
            items = OCR.collect_textline_candidates(
                image_path=Path("unused.png"),
                existing_items=[],
                width=1000,
                height=1000,
                ocr=FakeLegacyAuxiliaryOcr(),
                args=argparse.Namespace(
                    source_language="ja",
                    text_recognition_model_name="PP-OCRv6_small_rec",
                ),
            )

        items_by_x1 = {item["x1"]: item for item in items}
        self.assertEqual(items_by_x1[10]["ocrText"], "右")
        self.assertEqual(items_by_x1[300]["ocrText"], "左")
        self.assertNotIn("ocrText", items_by_x1[600])


class TextlineReadingOrderTests(unittest.TestCase):
    def semantic_texts(
        self,
        candidates: list[dict],
        width: int,
        height: int,
    ) -> list[str]:
        fragments = OCR.merge_textline_candidates(
            candidates,
            width,
            height,
            mode="semantic",
            source_language="ja",
        )
        ordered = sorted(fragments, key=lambda item: item.get("orderInGroup", 9999))
        return [str(item.get("_text") or "") for item in ordered]

    def test_japanese_vertical_columns_ignore_y_jitter_and_input_order(self) -> None:
        candidates = [
            textline_candidate("それを", 600, 30, 660, 230),
            textline_candidate("未然に", 520, 10, 580, 210),
            textline_candidate("ふせぐのが", 440, 60, 500, 260),
            textline_candidate("きみの", 360, 50, 420, 250),
            textline_candidate("役目や", 280, 40, 340, 240),
            textline_candidate("ないかア", 200, 20, 260, 220),
        ]
        expected = ["それを", "未然に", "ふせぐのが", "きみの", "役目や", "ないかア"]
        permutations = [
            candidates,
            list(reversed(candidates)),
            candidates[2:] + candidates[:2],
        ]

        for permutation in permutations:
            with self.subTest(order=[item["_text"] for item in permutation]):
                self.assertEqual(
                    self.semantic_texts(permutation, 844, 1200),
                    expected,
                )

    def test_short_middle_column_stays_in_right_to_left_order(self) -> None:
        candidates = [
            textline_candidate("私は", 600, 30, 650, 220),
            textline_candidate("ワッ", 540, 15, 590, 150),
            textline_candidate("雲名です", 480, 35, 530, 215),
        ]

        self.assertEqual(
            self.semantic_texts(candidates, 844, 1200),
            ["私は", "ワッ", "雲名です"],
        )

    def test_vertical_columns_keep_same_column_fragments_top_down(self) -> None:
        candidates = [
            textline_candidate("右上", 600, 20, 640, 120),
            textline_candidate("右下", 603, 125, 643, 230),
            textline_candidate("。", 610, 235, 635, 260),
            textline_candidate("左上", 545, 40, 585, 150),
            textline_candidate("左下", 548, 155, 588, 260),
        ]

        self.assertEqual(
            self.semantic_texts(list(reversed(candidates)), 1000, 1000),
            ["右上", "右下", "左上", "左下", "。"],
        )

    def test_overlapping_same_column_fragments_stay_top_down(self) -> None:
        candidates = [
            textline_candidate("上", 600, 0, 640, 150),
            textline_candidate("下", 603, 60, 643, 210),
        ]

        self.assertEqual(
            self.semantic_texts(list(reversed(candidates)), 1000, 1000),
            ["上", "下"],
        )

    def test_same_column_x_jitter_stays_top_down(self) -> None:
        candidates = [
            textline_candidate("上", 600, 20, 640, 120),
            textline_candidate("下", 609, 125, 649, 230),
        ]

        self.assertTrue(
            OCR.should_merge_textline_boxes_semantic(
                candidates[0], candidates[1], 1000, 1000
            )
        )
        self.assertEqual(
            self.semantic_texts(list(reversed(candidates)), 1000, 1000),
            ["上", "下"],
        )

    def test_overlapping_neighbor_columns_stay_separate(self) -> None:
        candidates = [
            textline_candidate("右列", 600, 30, 660, 230),
            textline_candidate("左列", 575, 10, 635, 210),
        ]

        self.assertEqual(
            self.semantic_texts(candidates, 1000, 1000),
            ["右列", "左列"],
        )

    def test_staggered_neighbor_columns_stay_separate(self) -> None:
        candidates = [
            textline_candidate("右列", 600, 130, 660, 250),
            textline_candidate("左列", 570, 0, 640, 120),
        ]

        self.assertEqual(
            self.semantic_texts(candidates, 844, 1200),
            ["左列", "右列"],
        )

    def test_wide_staggered_neighbor_columns_stay_separate(self) -> None:
        candidates = [
            textline_candidate("右列", 600, 130, 700, 250),
            textline_candidate("左列", 580, 0, 680, 120),
        ]

        self.assertEqual(
            self.semantic_texts(candidates, 844, 1200),
            ["右列", "左列"],
        )

    def test_conservative_mode_preserves_legacy_document_order(self) -> None:
        candidates = [
            textline_candidate("右列", 600, 30, 660, 230),
            textline_candidate("左列", 520, 10, 580, 210),
        ]

        merged = OCR.merge_textline_candidates(
            candidates,
            1000,
            1000,
            mode="conservative",
            source_language="ja",
        )

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["_texts"], ["左列", "右列"])

    def test_ocr_adapter_writes_filtered_vertical_columns_in_reading_order(self) -> None:
        recognized = [
            ("未然に", rectangle_poly(520, 10, 580, 210)),
            ("ないかア", rectangle_poly(200, 20, 260, 220)),
            ("それを", rectangle_poly(600, 30, 660, 230)),
            ("役目や", rectangle_poly(280, 40, 340, 240)),
            ("きみの", rectangle_poly(360, 50, 420, 250)),
            ("ふせぐのが", rectangle_poly(440, 60, 500, 260)),
        ]
        rejected_poly = rectangle_poly(120, 35, 180, 235)
        detected = [
            recognized[0][1],
            recognized[1][1],
            recognized[2][1],
            rejected_poly,
            recognized[3][1],
            recognized[4][1],
            recognized[5][1],
        ]

        class FakeOcr:
            def predict(self, _image_path: str) -> list[dict]:
                return [
                    {
                        "dt_polys": detected,
                        "rec_polys": [poly for _text, poly in recognized],
                        "rec_texts": [text for text, _poly in recognized],
                        "rec_scores": [0.99] * len(recognized),
                    }
                ]

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "page.png"
            output_path = Path(temp_dir) / "result.json"
            OCR.Image.new("RGB", (844, 1200), "white").save(image_path)

            OCR.write_page_bboxes_from_ocr(
                image_path=image_path,
                output_path=output_path,
                ocr=FakeOcr(),
                source="paddleocr-ppocrv6-transformers",
                merge_mode="semantic",
                args=argparse.Namespace(
                    source_language="ja",
                    text_recognition_model_name="PP-OCRv6_mobile_rec",
                ),
            )
            payload = json.loads(output_path.read_text(encoding="utf-8"))

        # The raw detector-only row has no Japanese text, so axis-v4 excludes
        # it instead of emitting an empty prompt candidate.
        self.assertEqual(len(payload["items"]), 6)
        recognized_items = [item for item in payload["items"] if item.get("ocrText")]
        self.assertEqual(
            [item["ocrText"] for item in recognized_items],
            ["それを", "未然に", "ふせぐのが", "きみの", "役目や", "ないかア"],
        )
        self.assertTrue(
            all(item["reviewStatus"] == "confirmed" for item in recognized_items)
        )

    def test_static_ocr_adapter_writes_semantic_group_metadata(self) -> None:
        detected = [
            rectangle_poly(520, 10, 580, 210),
            rectangle_poly(200, 20, 260, 220),
            rectangle_poly(600, 30, 660, 230),
            rectangle_poly(280, 40, 340, 240),
            rectangle_poly(360, 50, 420, 250),
            rectangle_poly(440, 60, 500, 260),
        ]

        class FakeStaticOcr:
            def predict(self, _image_path: str) -> list[dict]:
                return [
                    {
                        "dt_polys": detected,
                        "rec_texts": [
                            "未然に",
                            "ないかア",
                            "それを",
                            "役目や",
                            "きみの",
                            "ふせぐのが",
                        ],
                        "rec_scores": [0.99] * len(detected),
                    }
                ]

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "page.png"
            output_path = Path(temp_dir) / "result.json"
            OCR.Image.new("RGB", (844, 1200), "white").save(image_path)

            OCR.write_page_bboxes_from_ocr(
                image_path=image_path,
                output_path=output_path,
                ocr=FakeStaticOcr(),
                source="paddleocr-ppocrv6",
                merge_mode="semantic",
                args=argparse.Namespace(
                    source_language="ja",
                    text_recognition_model_name="PP-OCRv6_small_rec",
                ),
            )
            payload = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["source"], "paddleocr-ppocrv6")
        self.assertEqual(len(payload["items"]), 6)
        self.assertEqual(
            {item["groupId"] for item in payload["items"]},
            {"G001", "G002"},
        )
        self.assertEqual({item["groupSize"] for item in payload["items"]}, {2, 4})
        # The preliminary Paddle graph put all six rows in one group. axis-v4
        # is authoritative, while the old grouping survives only as evidence.
        self.assertEqual(
            {item["paddleGroupId"] for item in payload["items"]},
            {"G001"},
        )
        self.assertEqual(
            {item["paddleGroupSize"] for item in payload["items"]},
            {6},
        )
        self.assertTrue(all(item["semanticGroup"] is True for item in payload["items"]))
        self.assertEqual(
            [item["ocrText"] for item in payload["items"]],
            ["それを", "未然に", "ふせぐのが", "きみの", "役目や", "ないかア"],
        )

    def test_static_semantic_adapter_aligns_filtered_and_nan_rows_by_rec_poly(self) -> None:
        detected = [
            rectangle_poly(10, 10, 50, 110),
            rectangle_poly(300, 10, 340, 110),
            rectangle_poly(600, 10, 640, 110),
        ]

        class FakeStaticOcr:
            def predict(self, _image_path: str) -> list[dict]:
                return [
                    {
                        "dt_polys": detected,
                        "rec_polys": [detected[0], detected[2]],
                        "rec_texts": ["右", "左"],
                        "rec_scores": [0.9, float("nan")],
                    }
                ]

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "page.png"
            output_path = Path(temp_dir) / "result.json"
            OCR.Image.new("RGB", (1000, 1000), "white").save(image_path)

            OCR.write_page_bboxes_from_ocr(
                image_path=image_path,
                output_path=output_path,
                ocr=FakeStaticOcr(),
                source="paddleocr-ppocrv6",
                merge_mode="semantic",
                args=argparse.Namespace(
                    source_language="ja",
                    text_recognition_model_name="PP-OCRv6_small_rec",
                ),
            )
            payload = json.loads(output_path.read_text(encoding="utf-8"))

        items_by_x1 = {item["x1"]: item for item in payload["items"]}
        self.assertEqual(items_by_x1[10]["ocrText"], "右")
        self.assertEqual(items_by_x1[10]["score"], 0.9)
        self.assertNotIn(300, items_by_x1)
        self.assertEqual(items_by_x1[600]["ocrText"], "左")
        self.assertNotIn("score", items_by_x1[600])

    def test_semantic_adapter_partitions_finalized_raw_rows_and_preserves_ids(self) -> None:
        detected = [
            rectangle_poly(600, 100, 632, 250),
            rectangle_poly(400, 100, 430, 250),
            rectangle_poly(558, 100, 590, 250),
            rectangle_poly(100, 500, 300, 532),
        ]

        class FakeStaticOcr:
            def predict(self, _image_path: str) -> list[dict]:
                return [
                    {
                        "dt_polys": detected,
                        "rec_texts": ["右側本文", "123", "左側本文", "横書き本文"],
                        "rec_scores": [0.91, 0.99, 0.92, 0.93],
                    }
                ]

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "page.png"
            output_path = Path(temp_dir) / "result.json"
            OCR.Image.new("RGB", (1000, 1000), "white").save(image_path)

            OCR.write_page_bboxes_from_ocr(
                image_path=image_path,
                output_path=output_path,
                ocr=FakeStaticOcr(),
                source="paddleocr-ppocrv6",
                merge_mode="semantic",
                args=argparse.Namespace(
                    source_language="ja",
                    text_recognition_model_name="PP-OCRv6_small_rec",
                ),
            )
            payload = json.loads(output_path.read_text(encoding="utf-8"))

        # The ASCII row becomes id 1 in the established semantic Paddle order
        # and is then excluded. Retained rows keep their resulting sparse ids,
        # boxes, strings, and scores rather than being unioned.
        self.assertEqual([item["id"] for item in payload["items"]], [3, 2, 4])
        self.assertEqual(
            [
                (
                    item["x1"],
                    item["y1"],
                    item["x2"],
                    item["y2"],
                    item["ocrText"],
                    item["score"],
                )
                for item in payload["items"]
            ],
            [
                (600, 100, 632, 250, "右側本文", 0.91),
                (558, 100, 590, 250, "左側本文", 0.92),
                (100, 500, 300, 532, "横書き本文", 0.93),
            ],
        )
        self.assertEqual(
            [
                (
                    item["reviewFragmentId"],
                    item["reviewStatus"],
                    item["reviewOrder"],
                    item["reviewReasons"],
                )
                for item in payload["items"]
            ],
            [
                ("B001", "confirmed", 1, []),
                ("B001", "confirmed", 2, []),
                (
                    "D001",
                    "deferred",
                    1,
                    ["ordinary_axis_candidate"],
                ),
            ],
        )
        confirmed = payload["items"][:2]
        self.assertEqual({item["groupId"] for item in confirmed}, {"G001"})
        self.assertEqual({item["groupSize"] for item in confirmed}, {2})
        self.assertEqual(
            [
                (
                    item["paddleGroupId"],
                    item["paddleOrder"],
                    item["paddleGroupSize"],
                )
                for item in confirmed
            ],
            [("G001", 1, 2), ("G001", 2, 2)],
        )
        self.assertTrue(all(item["semanticGroup"] is True for item in confirmed))
        self.assertTrue(all("groupId" not in item for item in payload["items"][2:]))

    def test_semantic_mode_preserves_ordered_fragments_for_gemma(self) -> None:
        candidates = [
            textline_candidate("未然に", 520, 10, 580, 210),
            textline_candidate("ないかア", 200, 20, 260, 220),
            textline_candidate("それを", 600, 30, 660, 230),
            textline_candidate("役目や", 280, 40, 340, 240),
            textline_candidate("きみの", 360, 50, 420, 250),
            textline_candidate("ふせぐのが", 440, 60, 500, 260),
        ]

        fragments = OCR.merge_textline_candidates(
            candidates,
            844,
            1200,
            mode="semantic",
            source_language="ja",
        )
        ordered = sorted(fragments, key=lambda item: item["orderInGroup"])

        self.assertEqual(len(fragments), 6)
        self.assertEqual({item["groupId"] for item in fragments}, {"G001"})
        self.assertEqual({item["groupSize"] for item in fragments}, {6})
        self.assertEqual(
            [item["_text"] for item in ordered],
            ["それを", "未然に", "ふせぐのが", "きみの", "役目や", "ないかア"],
        )
        self.assertTrue(
            all(item["containerType"] == "same_text_container" for item in fragments)
        )
        self.assertTrue(all(item["semanticGroup"] is True for item in fragments))

    def test_semantic_mode_does_not_group_wide_sfx_below_dialogue(self) -> None:
        candidates = [
            textline_candidate("確かにな……", 959, 486, 999, 659),
            textline_candidate("き", 927, 650, 1029, 801),
        ]
        candidates[1]["_score"] = 0.1249

        fragments = OCR.merge_textline_candidates(
            candidates,
            1125,
            1600,
            mode="semantic",
            source_language="ja",
        )

        self.assertEqual(len(fragments), 2)
        self.assertTrue(all("groupId" not in item for item in fragments))

    def test_semantic_mode_does_not_group_wide_sfx_above_dialogue(self) -> None:
        candidates = [
            textline_candidate("干子", 5, 586, 114, 749),
            textline_candidate("ああ……！", 79, 770, 116, 912),
        ]
        candidates[0]["_score"] = 0.7249

        fragments = OCR.merge_textline_candidates(
            candidates,
            1125,
            1600,
            mode="semantic",
            source_language="ja",
        )

        self.assertEqual(len(fragments), 2)
        self.assertTrue(all("groupId" not in item for item in fragments))

    def test_semantic_mode_does_not_attach_square_sfx_to_dialogue_column(self) -> None:
        candidates = [
            textline_candidate("ミシュリーヌ様は", 1012, 62, 1048, 281),
            textline_candidate("あ0", 966, 286, 1015, 335),
        ]
        candidates[1]["_score"] = 0.242

        fragments = OCR.merge_textline_candidates(
            candidates,
            1126,
            1600,
            mode="semantic",
            source_language="ja",
        )

        self.assertEqual(len(fragments), 2)
        self.assertTrue(all("groupId" not in item for item in fragments))

    def test_semantic_mode_does_not_attach_wide_sfx_beside_vertical_dialogue(self) -> None:
        candidates = [
            textline_candidate("ぶんぶん", 475, 569, 650, 667),
            textline_candidate("いやいや", 655, 596, 697, 704),
        ]

        fragments = OCR.merge_textline_candidates(
            candidates,
            984,
            1400,
            mode="semantic",
            source_language="ja",
        )

        self.assertEqual(len(fragments), 2)
        self.assertTrue(all("groupId" not in item for item in fragments))

    def test_semantic_mode_keeps_same_scale_same_column_fragments(self) -> None:
        candidates = [
            textline_candidate("右上", 600, 20, 640, 120),
            textline_candidate("右下", 603, 125, 643, 230),
        ]

        fragments = OCR.merge_textline_candidates(
            candidates,
            1000,
            1000,
            mode="semantic",
            source_language="ja",
        )

        self.assertEqual(len(fragments), 2)
        self.assertEqual({item["groupId"] for item in fragments}, {"G001"})

    def test_horizontal_japanese_and_non_japanese_keep_document_order(self) -> None:
        horizontal = [
            textline_candidate("右", 115, 100, 215, 130),
            textline_candidate("左", 10, 100, 110, 130),
        ]
        vertical_english = [
            textline_candidate("later-y", 115, 100, 155, 270),
            textline_candidate("earlier-y", 60, 60, 100, 230),
        ]

        horizontal_result = OCR.merge_textline_candidates(
            horizontal,
            1000,
            1000,
            mode="conservative",
            source_language="ja",
        )
        english_result = OCR.merge_textline_candidates(
            vertical_english,
            1000,
            1000,
            mode="conservative",
            source_language="en",
        )

        self.assertEqual(horizontal_result[0]["_texts"], ["左", "右"])
        self.assertEqual(english_result[0]["_texts"], ["earlier-y", "later-y"])


class HeuristicTextlinePartitionTests(unittest.TestCase):
    def grouped_texts(self, candidates: list[dict]) -> list[set[str]]:
        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=1200,
            height=1800,
            source_language="ja",
        )
        structural_groups = list(result["groups"]) + [
            entry["items"] for entry in result["deferred"]
        ]
        return [
            {str(item.get("_text") or "") for item in group}
            for group in structural_groups
        ]

    def test_diagonal_visual_clusters_do_not_chain(self) -> None:
        fixtures = [
            (
                [
                    textline_candidate("エメリーン", 203, 71, 242, 205),
                    textline_candidate("単刀直入に", 137, 153, 177, 293),
                    textline_candidate("言う", 105, 153, 142, 219),
                ],
                [{"エメリーン"}, {"単刀直入に", "言う"}],
            ),
            (
                [
                    textline_candidate("分かり", 146, 1121, 187, 1215),
                    textline_candidate("ました…", 114, 1122, 153, 1243),
                    textline_candidate("大切に", 62, 1163, 104, 1254),
                    textline_candidate("します", 30, 1163, 70, 1256),
                ],
                [{"分かり", "ました…"}, {"大切に", "します"}],
            ),
            (
                [
                    textline_candidate("まあいいや", 878, 1137, 916, 1290),
                    textline_candidate("飯食いながら", 772, 1203, 812, 1384),
                    textline_candidate("話聞かせて", 734, 1199, 780, 1356),
                    textline_candidate("くれよ", 701, 1201, 739, 1298),
                ],
                [{"まあいいや"}, {"飯食いながら", "話聞かせて", "くれよ"}],
            ),
        ]

        for candidates, expected in fixtures:
            with self.subTest(texts=[item["_text"] for item in candidates]):
                actual = self.grouped_texts(candidates)
                self.assertCountEqual(actual, expected)

    def test_low_score_oversized_sfx_cannot_bridge_dialogue(self) -> None:
        sfx = textline_candidate("新", 507, 17, 653, 186)
        sfx["_score"] = 0.2323
        candidates = [
            sfx,
            textline_candidate("重っ…", 634, 90, 668, 158),
            textline_candidate("何者だお前！？", 506, 155, 535, 277),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=836,
            height=1200,
            source_language="ja",
        )

        self.assertCountEqual(
            [
                {str(item.get("_text") or "") for item in group}
                for group in result["groups"]
            ],
            [{"重っ…"}, {"何者だお前！？"}],
        )
        self.assertEqual(
            [
                item["_text"]
                for entry in result["deferred"]
                for item in entry["items"]
                if item["_text"] == "新"
            ],
            ["新"],
        )

    def test_stacked_vertical_clusters_remain_separate(self) -> None:
        candidates = [
            textline_candidate("步兵三十", 963, 365, 989, 450),
            textline_candidate("騎士二十", 933, 364, 958, 450),
            textline_candidate("専業魔法師が五", 901, 363, 928, 509),
            textline_candidate("この辺は", 910, 525, 934, 609),
            textline_candidate("問題ねぇんですが", 877, 523, 904, 687),
            textline_candidate("敵の大将がやべぇ", 844, 523, 874, 687),
        ]

        self.assertCountEqual(
            self.grouped_texts(candidates),
            [
                {"步兵三十", "騎士二十", "専業魔法師が五"},
                {"この辺は", "問題ねぇんですが", "敵の大将がやべぇ"},
            ],
        )

    def test_small_reading_aids_attach_after_main_cluster(self) -> None:
        candidates = [
            textline_candidate("騎士団長", 100, 100, 130, 250),
            textline_candidate("敵勢力は？", 70, 100, 100, 250),
            textline_candidate("きしだんちょう", 122, 110, 134, 205),
            textline_candidate("てきせいりょく", 92, 110, 104, 205),
        ]

        self.assertEqual(
            self.grouped_texts(candidates),
            [{"騎士団長", "敵勢力は？", "きしだんちょう", "てきせいりょく"}],
        )

    def test_overlapping_horizontal_fragments_join(self) -> None:
        candidates = [
            textline_candidate("賢いと思われ", 416, 13, 704, 124),
            textline_candidate("のは嬉しい", 420, 74, 642, 166),
        ]

        self.assertEqual(
            self.grouped_texts(candidates),
            [{"賢いと思われ", "のは嬉しい"}],
        )

    def test_sparse_high_confidence_single_characters_are_not_dropped(self) -> None:
        candidates = [
            textline_candidate("死", 611, 82, 712, 233),
            textline_candidate("グ", 850, 84, 1072, 334),
            textline_candidate("あ？", 198, 381, 249, 462),
        ]
        candidates[1]["_score"] = 0.90
        candidates[2]["_score"] = 0.93

        self.assertCountEqual(
            self.grouped_texts(candidates),
            [{"死"}, {"グ"}, {"あ？"}],
        )

    def test_dense_page_isolated_single_glyph_is_held_out(self) -> None:
        candidates = [
            textline_candidate("普通の台詞", 900, 100, 932, 250),
            textline_candidate("別の本文", 700, 400, 732, 550),
            textline_candidate("まだ続く", 500, 700, 532, 850),
            textline_candidate("もう一文", 300, 1000, 332, 1150),
            textline_candidate("米", 100, 1200, 165, 1285),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=1200,
            height=1800,
            source_language="ja",
        )

        self.assertNotIn({"米"}, self.grouped_confirmed_texts(result))
        self.assertEqual(
            [
                item["_text"]
                for entry in result["deferred"]
                for item in entry["items"]
            ],
            ["米"],
        )

    def grouped_confirmed_texts(self, result: dict) -> list[set[str]]:
        return [
            {str(item.get("_text") or "") for item in group}
            for group in result["groups"]
        ]

    def test_staggered_confirmed_components_become_review_question_only(self) -> None:
        candidates = [
            textline_candidate("大丈夫か??", 156, 614, 220, 869),
            textline_candidate("だいじょう", 208, 623, 231, 735),
            textline_candidate("妙だが…", 86, 756, 118, 854),
            textline_candidate("受け答えが", 120, 756, 151, 874),
            textline_candidate("離れた本文", 800, 1200, 835, 1370),
            textline_candidate("さらに本文", 600, 1450, 635, 1620),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=960,
            height=1800,
            source_language="ja",
        )

        confirmed = self.grouped_confirmed_texts(result)
        self.assertIn({"大丈夫か??", "だいじょう"}, confirmed)
        self.assertIn({"妙だが…", "受け答えが"}, confirmed)
        edge = next(
            edge
            for edge in result["reviewEdges"]
            if {
                frozenset(component)
                for component in edge["componentCandidateIds"]
            }
            == {frozenset({1, 2}), frozenset({3, 4})}
        )
        self.assertEqual(edge["reason"], "staggered_vertical_components")

    def test_three_and_four_staggered_columns_share_one_serialized_review_context(self) -> None:
        fixtures = [
            [
                textline_candidate("右の本文", 700, 200, 732, 390),
                textline_candidate("中の本文", 660, 220, 692, 430),
                textline_candidate("左の本文", 620, 252, 652, 462),
            ],
            [
                textline_candidate("右の本文", 700, 200, 732, 390),
                textline_candidate("中右本文", 660, 220, 692, 430),
                textline_candidate("中左本文", 620, 252, 652, 462),
                textline_candidate("左の本文", 580, 286, 612, 476),
            ],
        ]

        for candidates in fixtures:
            for candidate_id, candidate in enumerate(candidates, start=1):
                candidate["id"] = candidate_id
            partition = OCR.partition_textline_candidates_heuristic(
                candidates,
                width=1200,
                height=1800,
                source_language="ja",
            )
            items = OCR.materialize_textline_heuristic_partition(partition)

            with self.subTest(column_count=len(candidates)):
                self.assertGreaterEqual(len(partition["groups"]), 2)
                self.assertGreaterEqual(len(partition["reviewEdges"]), 1)
                self.assertEqual(
                    {item.get("reviewContextId") for item in items},
                    {"RC001"},
                )
                self.assertEqual(
                    sorted(item["id"] for item in items),
                    list(range(1, len(candidates) + 1)),
                )

    def test_review_context_projection_rejects_unknown_candidate_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown candidate"):
            OCR.build_textline_review_context_ids(
                {
                    "groups": [[{"id": 1}]],
                    "deferred": [],
                    "reviewEdges": [
                        {
                            "componentCandidateIds": [[1], [2]],
                        }
                    ],
                }
            )

    def test_review_context_projection_is_transitive_stable_and_edge_scoped(self) -> None:
        partition = {
            "groups": [
                [{"id": 8}, {"id": 3}],
                [{"id": 5}],
                [{"id": 40}],
            ],
            "deferred": [
                {"items": [{"id": 21}]},
                {"items": [{"id": 13}]},
            ],
            "reviewEdges": [
                {"componentCandidateIds": [[21], [13]]},
                {"componentCandidateIds": [[5], [3]]},
                {"componentCandidateIds": [[8], [5]]},
            ],
        }

        expected = {
            3: "RC001",
            5: "RC001",
            8: "RC001",
            13: "RC002",
            21: "RC002",
        }
        self.assertEqual(
            OCR.build_textline_review_context_ids(partition),
            expected,
        )
        self.assertEqual(
            OCR.build_textline_review_context_ids(
                {
                    **partition,
                    "reviewEdges": list(reversed(partition["reviewEdges"])),
                }
            ),
            expected,
        )

    def test_review_context_projection_rejects_invalid_partition_candidate_ids(self) -> None:
        invalid_partitions = {
            "duplicate": {
                "groups": [[{"id": 1}]],
                "deferred": [{"items": [{"id": 1}]}],
            },
            "zero": {
                "groups": [[{"id": 1}, {"id": 0}]],
                "deferred": [],
            },
            "boolean": {
                "groups": [[{"id": 1}, {"id": True}]],
                "deferred": [],
            },
        }
        edge = {"componentCandidateIds": [[1], [1]]}

        for name, partition in invalid_partitions.items():
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "unique positive ids"):
                    OCR.build_textline_review_context_ids(
                        {**partition, "reviewEdges": [edge]}
                    )

    def test_review_context_projection_rejects_malformed_edge_components(self) -> None:
        malformed_components = [
            [[1]],
            [[], [2]],
            [[1], "not-a-list"],
        ]

        for component_ids in malformed_components:
            with self.subTest(component_ids=component_ids):
                with self.assertRaisesRegex(
                    ValueError,
                    "needs two candidate components",
                ):
                    OCR.build_textline_review_context_ids(
                        {
                            "groups": [[{"id": 1}], [{"id": 2}]],
                            "deferred": [],
                            "reviewEdges": [
                                {"componentCandidateIds": component_ids}
                            ],
                        }
                    )

    def test_review_context_projection_empty_edges_remain_a_noop(self) -> None:
        self.assertEqual(
            OCR.build_textline_review_context_ids(
                {
                    "groups": "not-validated-without-review-edges",
                    "deferred": None,
                    "reviewEdges": [],
                }
            ),
            {},
        )

    def test_review_questions_never_include_low_confidence_sfx(self) -> None:
        sfx = textline_candidate("新", 507, 17, 653, 186)
        sfx["_score"] = 0.2323
        candidates = [
            sfx,
            textline_candidate("重っ…", 634, 90, 668, 158),
            textline_candidate("何者だお前！？", 506, 155, 535, 277),
            textline_candidate("離れた本文", 100, 800, 135, 980),
            textline_candidate("さらに本文", 800, 1300, 835, 1480),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=836,
            height=1600,
            source_language="ja",
        )

        reviewed_ids = {
            candidate_id
            for edge in result["reviewEdges"]
            for component in edge["componentCandidateIds"]
            for candidate_id in component
        }
        self.assertNotIn(1, reviewed_ids)

    def test_distant_components_do_not_create_review_cartesian_product(self) -> None:
        candidates = [
            textline_candidate("右上本文", 900, 100, 935, 260),
            textline_candidate("左上本文", 100, 100, 135, 260),
            textline_candidate("右下本文", 900, 1300, 935, 1460),
            textline_candidate("左下本文", 100, 1300, 135, 1460),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=1200,
            height=1800,
            source_language="ja",
        )

        self.assertEqual(result["reviewEdges"], [])

    def test_ascii_mixed_fake_ruby_is_not_attached(self) -> None:
        candidates = [
            textline_candidate("俺の言葉に？", 295, 1130, 326, 1273),
            textline_candidate("おれ", 320, 1134, 335, 1165),
            textline_candidate("12は", 321, 1177, 335, 1224),
            textline_candidate("別の本文", 700, 100, 732, 250),
            textline_candidate("さらに文", 500, 400, 532, 550),
        ]
        candidates[2]["_score"] = 0.605

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=1200,
            height=1800,
            source_language="ja",
        )

        self.assertIn({"俺の言葉に？", "おれ"}, self.grouped_confirmed_texts(result))
        self.assertEqual(
            [entry["item"]["_text"] for entry in result["excluded"]],
            ["12は"],
        )

    def test_punctuated_short_utterance_is_not_treated_as_single_glyph(self) -> None:
        candidates = [
            textline_candidate("やはり", 200, 300, 232, 390),
            textline_candidate("怖がっていない", 166, 300, 198, 470),
            textline_candidate("……か", 132, 300, 164, 380),
            textline_candidate("別の本文", 800, 800, 832, 950),
            textline_candidate("さらに文", 500, 1200, 532, 1350),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=1200,
            height=1800,
            source_language="ja",
        )

        self.assertIn(
            {"やはり", "怖がっていない", "……か"},
            self.grouped_confirmed_texts(result),
        )

    def test_episode_footer_is_deferred_without_affecting_dialogue(self) -> None:
        candidates = [
            textline_candidate("まあいいや", 878, 1137, 916, 1290),
            textline_candidate("飯食いながら", 772, 1203, 812, 1384),
            textline_candidate("話聞かせて", 734, 1199, 780, 1356),
            textline_candidate("くれよ", 701, 1201, 739, 1298),
            textline_candidate("●4日目につづく", 20, 1200, 55, 1450),
        ]

        result = OCR.partition_textline_candidates_heuristic(
            candidates,
            width=1200,
            height=1800,
            source_language="ja",
        )

        self.assertCountEqual(
            self.grouped_confirmed_texts(result),
            [{"まあいいや"}, {"飯食いながら", "話聞かせて", "くれよ"}],
        )
        self.assertEqual(
            [
                item["_text"]
                for entry in result["deferred"]
                for item in entry["items"]
            ],
            ["●4日目につづく"],
        )

    def test_local_reading_aid_does_not_steal_neighbour_edge(self) -> None:
        candidates = [
            textline_candidate("冒険者だよ！", 103, 399, 161, 658),
            textline_candidate("ぼうけんしゃ", 149, 403, 178, 531),
            textline_candidate("別の台詞", 500, 50, 529, 180),
            textline_candidate("もう一つ", 800, 800, 829, 930),
            textline_candidate("離れた文", 200, 1100, 229, 1230),
        ]

        self.assertCountEqual(
            self.grouped_texts(candidates),
            [
                {"冒険者だよ！", "ぼうけんしゃ"},
                {"別の台詞"},
                {"もう一つ"},
                {"離れた文"},
            ],
        )

    def test_oversized_display_lines_can_join_only_each_other(self) -> None:
        candidates = [
            textline_candidate("おりますん！", 673, 443, 746, 788),
            textline_candidate("存じて", 742, 444, 814, 626),
            textline_candidate("普通の台詞", 100, 100, 132, 240),
            textline_candidate("別の普通文", 900, 1000, 932, 1140),
            textline_candidate("さらに本文", 400, 1300, 432, 1440),
        ]

        self.assertCountEqual(
            self.grouped_texts(candidates),
            [
                {"おりますん！", "存じて"},
                {"普通の台詞"},
                {"別の普通文"},
                {"さらに本文"},
            ],
        )

    def test_ruby_cannot_split_mutual_neighbours_in_one_paragraph(self) -> None:
        candidates = [
            textline_candidate("早いわけだ", 172, 1313, 203, 1432),
            textline_candidate("敵の侵攻が", 207, 1314, 235, 1431),
            textline_candidate("はや", 196, 1315, 213, 1350),
            textline_candidate("てきしんこう", 231, 1317, 245, 1412),
            textline_candidate("どうりで", 245, 1317, 266, 1409),
        ]

        self.assertEqual(
            self.grouped_texts(candidates),
            [{"早いわけだ", "敵の侵攻が", "はや", "てきしんこう", "どうりで"}],
        )


class BatchFailureBehaviorTests(unittest.TestCase):
    def test_first_oom_page_aborts_without_retrying_or_skipping(self) -> None:
        items = [
            {"image": f"page-{index}.png", "output": f"page-{index}.json"}
            for index in range(1, 4)
        ]
        calls: list[str] = []

        def fail_page(item: dict) -> dict:
            calls.append(item["output"])
            raise RuntimeError("HIPErrorOutOfMemory")

        with tempfile.TemporaryDirectory() as temp_dir:
            progress_path = Path(temp_dir) / "progress.jsonl"
            with (
                patch.object(OCR, "release_gpu_memory"),
                redirect_stdout(StringIO()),
                redirect_stderr(StringIO()),
            ):
                with self.assertRaisesRegex(RuntimeError, "HIPErrorOutOfMemory"):
                    OCR.run_batch_pages(batch_args(str(progress_path)), items, fail_page)

            progress = read_json_lines(progress_path)

        self.assertEqual(
            [entry["phase"] for entry in progress],
            ["start", "error"],
        )
        self.assertEqual([entry["index"] for entry in progress], [1, 1])
        self.assertTrue(all(entry["total"] == 3 for entry in progress))
        self.assertEqual(calls, ["page-1.json"])

    def test_successes_before_failure_are_reported_but_later_pages_do_not_run(self) -> None:
        items = [
            {"image": f"page-{index}.png", "output": f"page-{index}.json"}
            for index in range(1, 5)
        ]
        calls: list[str] = []

        def process_page(item: dict) -> dict:
            output = item["output"]
            calls.append(output)
            if output == "page-2.json":
                raise RuntimeError("GPU out of memory")
            return {"output": output, "count": 2}

        with tempfile.TemporaryDirectory() as temp_dir:
            progress_path = Path(temp_dir) / "nested" / "progress.jsonl"
            with (
                patch.object(OCR, "release_gpu_memory"),
                redirect_stdout(StringIO()),
                redirect_stderr(StringIO()),
            ):
                with self.assertRaisesRegex(RuntimeError, "GPU out of memory"):
                    OCR.run_batch_pages(batch_args(str(progress_path)), items, process_page)

            progress = read_json_lines(progress_path)

        self.assertEqual(
            [entry["phase"] for entry in progress],
            ["start", "done", "start", "error"],
        )
        self.assertEqual(calls, ["page-1.json", "page-2.json"])


class GpuSelectionBehaviorTests(unittest.TestCase):
    def test_default_gpu_selection_uses_the_device_with_most_vram(self) -> None:
        selected_devices: list[int] = []
        memory_by_device = [2_000, 12_000, 6_000]

        class FakeCuda:
            @staticmethod
            def device_count() -> int:
                return len(memory_by_device)

            @staticmethod
            def get_device_properties(index: int) -> object:
                return types.SimpleNamespace(total_memory=memory_by_device[index])

            @staticmethod
            def set_device(index: int) -> None:
                selected_devices.append(index)

        fake_torch = types.ModuleType("torch")
        fake_torch.cuda = FakeCuda()
        args = argparse.Namespace(device="gpu:0")
        visible_device_variables = {
            "HIP_VISIBLE_DEVICES": "",
            "ROCR_VISIBLE_DEVICES": "",
            "CUDA_VISIBLE_DEVICES": "",
            "GPU_DEVICE_ORDINAL": "",
        }

        OCR.SELECTED_CUDA_DEVICE_INDEX = None
        with (
            patch.dict(sys.modules, {"torch": fake_torch}),
            patch.dict(os.environ, visible_device_variables),
            redirect_stderr(StringIO()),
        ):
            selected = OCR.select_preferred_cuda_device(args)

        self.assertEqual(selected, 1)
        self.assertEqual(selected_devices, [1])
        self.assertEqual(OCR.resolve_engine_device_id("gpu:0"), 1)


class TransformersDetectorImportTests(unittest.TestCase):
    @staticmethod
    def args() -> argparse.Namespace:
        return argparse.Namespace(
            device="gpu:0",
            engine="transformers",
            dtype="float32",
            source_language="ja",
            ocr_version="PP-OCRv6",
            text_detection_model_name=None,
            text_recognition_model_name=None,
        )

    def test_required_detector_preserves_transformers_dependency_failure(self) -> None:
        fake_paddleocr = types.ModuleType("paddleocr")
        fake_paddleocr.PaddleOCR = unittest.mock.Mock()
        error = OSError("torchvision image extension DLL could not be loaded")

        with (
            patch.dict(sys.modules, {"paddleocr": fake_paddleocr}),
            patch.object(OCR, "configure_torch_for_transformers_ocr"),
            patch.object(OCR, "verify_transformers_textline_imports", side_effect=error),
            redirect_stderr(StringIO()) as stderr,
        ):
            with self.assertRaisesRegex(OSError, "torchvision image extension DLL"):
                OCR.create_textline_detector(self.args(), required=True)

        self.assertIn("torchvision image extension DLL", stderr.getvalue())
        fake_paddleocr.PaddleOCR.assert_not_called()

    def test_optional_detector_can_still_be_disabled_after_import_failure(self) -> None:
        fake_paddleocr = types.ModuleType("paddleocr")
        fake_paddleocr.PaddleOCR = unittest.mock.Mock()

        with (
            patch.dict(sys.modules, {"paddleocr": fake_paddleocr}),
            patch.object(OCR, "configure_torch_for_transformers_ocr"),
            patch.object(
                OCR,
                "verify_transformers_textline_imports",
                side_effect=ImportError("AutoImageProcessor dependency failed"),
            ),
            redirect_stderr(StringIO()),
        ):
            detector = OCR.create_textline_detector(self.args())

        self.assertIsNone(detector)
        fake_paddleocr.PaddleOCR.assert_not_called()


class TinyRecognizerFilterBehaviorTests(unittest.TestCase):
    @staticmethod
    def args(source_language: str, model_name: str = "PP-OCRv5_mobile_tiny_rec") -> argparse.Namespace:
        return argparse.Namespace(
            source_language=source_language,
            text_recognition_model_name=model_name,
        )

    def test_non_tiny_model_does_not_apply_tiny_confidence_filter(self) -> None:
        args = self.args("ja", "PP-OCRv6_server_rec")
        self.assertEqual(OCR.filter_candidate_ocr_text("こんにちは", 0.01, args), "こんにちは")

    def test_japanese_tiny_model_enforces_score_and_script_boundaries(self) -> None:
        args = self.args("ja")

        self.assertEqual(OCR.filter_candidate_ocr_text("こんにちは", 0.549, args), "")
        self.assertEqual(OCR.filter_candidate_ocr_text("こんにちは", 0.55, args), "こんにちは")
        self.assertEqual(OCR.filter_candidate_ocr_text("東京", 0.929, args), "")
        self.assertEqual(OCR.filter_candidate_ocr_text("東京", 0.93, args), "東京")
        self.assertEqual(OCR.filter_candidate_ocr_text("hello", 0.99, args), "")

    def test_non_japanese_tiny_model_keeps_valid_source_script_text(self) -> None:
        english_args = self.args("en-US")
        chinese_args = self.args("zh-Hans")

        self.assertEqual(OCR.filter_candidate_ocr_text("hello", 0.55, english_args), "hello")
        self.assertEqual(OCR.filter_candidate_ocr_text("hello", 0.549, english_args), "")
        self.assertEqual(OCR.filter_candidate_ocr_text("这是", 0.9, chinese_args), "这是")


if __name__ == "__main__":
    unittest.main(verbosity=2)
