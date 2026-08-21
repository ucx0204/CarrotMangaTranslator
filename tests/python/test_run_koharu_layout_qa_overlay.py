from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "run_koharu_layout_qa_overlay.py"
SPEC = importlib.util.spec_from_file_location("run_koharu_layout_qa_overlay", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class KoharuLayoutQaOverlayTests(unittest.TestCase):
    def test_filter_uses_class_specific_thresholds(self) -> None:
        class_ids = np.asarray([0, 0, 1, 1, 2, 3])
        confidences = np.asarray([0.249, 0.25, 0.199, 0.20, 0.50, 0.499])
        keep = MODULE.filter_detection_indices(class_ids, confidences)
        np.testing.assert_array_equal(
            keep, np.asarray([False, True, False, True, True, False])
        )

    def test_overlay_blends_each_class_once_and_preserves_dimensions(self) -> None:
        image = Image.new("RGB", (12, 10), "white")
        masks = np.zeros((3, 10, 12), dtype=bool)
        masks[0, 1:4, 1:4] = True
        masks[1, 1:4, 1:4] = True
        masks[2, 6:9, 7:11] = True
        class_ids = np.asarray([0, 0, 2])
        overlay, class_map, pixels = MODULE.compose_overlay(
            image,
            masks,
            class_ids,
            include_legend=False,
        )
        self.assertEqual(overlay.size, image.size)
        self.assertEqual(class_map.size, image.size)
        self.assertEqual(pixels[0], 9)
        self.assertEqual(pixels[2], 12)
        expected_text = np.rint(
            np.asarray([255, 255, 255]) * (1 - MODULE.CLASS_ALPHAS[0])
            + np.asarray(MODULE.CLASS_COLORS[0]) * MODULE.CLASS_ALPHAS[0]
        ).astype(np.uint8)
        np.testing.assert_array_equal(np.asarray(overlay)[2, 2], expected_text)
        np.testing.assert_array_equal(
            np.asarray(class_map)[2, 2], MODULE.CLASS_COLORS[0]
        )

    def test_config_contract_is_exact_and_hash_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / MODULE.CONFIG_FILENAME
            source = (
                ROOT
                / ".tmp"
                / "koharu-layout-rfdetr-qa-v1"
                / "assets"
                / MODULE.CONFIG_FILENAME
            )
            if not source.is_file():
                self.skipTest("Pinned config is not available locally")
            path.write_bytes(source.read_bytes())
            self.assertEqual(
                MODULE.validate_inference_config(path),
                MODULE.expected_inference_config(),
            )
            data = json.loads(path.read_text(encoding="utf-8"))
            data["resolution"] = 1024
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "config SHA drifted"):
                MODULE.validate_inference_config(path)

    def test_existing_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "existing.png"
            path.write_bytes(b"occupied")
            with self.assertRaisesRegex(FileExistsError, "Refusing to overwrite"):
                MODULE._exclusive_output(path)


if __name__ == "__main__":
    unittest.main()
