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
SPEC.loader.exec_module(OCR)


def batch_args(progress_path: str) -> argparse.Namespace:
    return argparse.Namespace(progress=progress_path, device="cpu", engine="paddle")


def read_json_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


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
            [sys.executable, str(SCRIPT_PATH), "--help"],
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
