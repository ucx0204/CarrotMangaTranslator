from __future__ import annotations

import importlib.util
import random
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageStat


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_manga_font_synthetic_v1.py"
SPEC = importlib.util.spec_from_file_location("build_manga_font_synthetic_v1_tested", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
SYNTH = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SYNTH
SPEC.loader.exec_module(SYNTH)


class MangaFontSyntheticTest(unittest.TestCase):
    def test_role_distribution_is_balanced_and_variant_heavy(self) -> None:
        total = sum(weight for _, weight in SYNTH.ROLE_WEIGHTS)
        variant = sum(
            weight
            for role, weight in SYNTH.ROLE_WEIGHTS
            if role in SYNTH.VARIANT_ROLES
        )
        self.assertAlmostEqual(total, 1.0)
        self.assertGreater(variant, 0.6)
        self.assertLess(variant, 0.75)

    def test_long_text_is_constrained_for_legible_crop(self) -> None:
        text = "이 문장은 자동 폰트 맞춤 학습용 이미지에서 지나치게 작아지면 안 됩니다"
        horizontal = SYNTH.constrain_text_for_crop(
            text, role="dialogue", orientation="horizontal", rng=random.Random(3)
        )
        vertical = SYNTH.constrain_text_for_crop(
            text, role="dialogue", orientation="vertical", rng=random.Random(3)
        )
        self.assertLessEqual(len(horizontal), 18)
        self.assertLessEqual(len(vertical), 9)
        self.assertGreaterEqual(len(horizontal), 2)
        self.assertGreaterEqual(len(vertical), 2)

    def test_all_22_catalog_faces_resolve_to_real_font_bytes(self) -> None:
        fonts = SYNTH.load_font_faces(
            ROOT / "datasets" / "fontclip-font-catalog-v2" / "manifest.json", ROOT
        )
        self.assertEqual(len(fonts), 22)
        self.assertEqual(len({row["font_id"] for row in fonts}), 22)
        self.assertTrue(all(row["font_path"].is_file() for row in fonts))

    def test_split_is_deterministic_and_nonempty(self) -> None:
        counts = {"train": 0, "val": 0, "test": 0}
        for index in range(600):
            counts[SYNTH._split_for_index(index, 600)] += 1
        self.assertEqual(counts, {"train": 520, "val": 40, "test": 40})

    def test_inverse_treatment_never_produces_blank_light_views(self) -> None:
        mask = Image.new("L", (96, 64), 255)
        inverse_views = None
        try:
            for seed in range(256):
                views, metadata = SYNTH.make_views(
                    mask=mask,
                    rng=random.Random(seed),
                    real_backgrounds=[],
                )
                if metadata["inverse"]:
                    inverse_views = views
                    break
                for image in views.values():
                    image.close()
            self.assertIsNotNone(inverse_views)
            assert inverse_views is not None
            for key in ("raw_224", "context_224"):
                grayscale = inverse_views[key].convert("L")
                try:
                    self.assertGreater(ImageStat.Stat(grayscale).stddev[0], 8.0)
                finally:
                    grayscale.close()
        finally:
            mask.close()
            if inverse_views is not None:
                for image in inverse_views.values():
                    image.close()


if __name__ == "__main__":
    unittest.main()
