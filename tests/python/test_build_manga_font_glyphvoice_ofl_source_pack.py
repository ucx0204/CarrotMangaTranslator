from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_manga_font_glyphvoice_ofl_source_pack.py"
SPEC = importlib.util.spec_from_file_location(
    "build_manga_font_glyphvoice_ofl_source_pack_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
PACK = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PACK
SPEC.loader.exec_module(PACK)


METADATA_PB = b"""name: "Synthetic Family"
designer: "Test"
license: "OFL"
category: "SANS_SERIF"
fonts {
  name: "Synthetic Family"
  style: "normal"
  weight: 700
  filename: "SyntheticFamily-Bold.ttf"
}
fonts {
  name: "Synthetic Family"
  style: "normal"
  weight: 400
  filename: "SyntheticFamily-Regular.ttf"
  axes {
    tag: "wght"
    min_value: 100.0
    max_value: 900.0
  }
}
"""


class GlyphVoiceOflSourcePackTest(unittest.TestCase):
    def setUp(self) -> None:
        (ROOT / ".tmp").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="glyphvoice-ofl-pack-test-", dir=ROOT / ".tmp"
        )
        self.root = Path(self.temporary.name)
        self.output = self.root / "pack"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_metadata_parser_selects_normal_weight_400_with_nested_axis(self) -> None:
        license_id, fonts = PACK._parse_google_metadata(METADATA_PB)
        self.assertEqual(license_id, "OFL-1.1")
        self.assertEqual(len(fonts), 2)
        selected = PACK._pick_representative_font(fonts)
        self.assertEqual(selected["filename"], "SyntheticFamily-Regular.ttf")

    def test_family_selection_uses_open_japanese_and_korean_only(self) -> None:
        document = {
            "familyMetadataList": [
                {
                    "family": "Japanese Open",
                    "isOpenSource": True,
                    "primaryScript": "Hira",
                    "subsets": ["japanese"],
                },
                {
                    "family": "Korean Open",
                    "isOpenSource": True,
                    "primaryScript": "Kore",
                    "subsets": ["korean"],
                },
                {
                    "family": "Closed Japanese",
                    "isOpenSource": False,
                    "primaryScript": "Hira",
                    "subsets": ["japanese"],
                },
                {
                    "family": "Latin Open",
                    "isOpenSource": True,
                    "primaryScript": "Latn",
                    "subsets": ["latin"],
                },
            ]
        }
        self.assertEqual(
            PACK._google_family_selection(document, max_japanese=0, max_korean=0),
            [("Japanese Open", "ja"), ("Korean Open", "ko")],
        )

    def test_real_variable_font_is_materialized_at_regular_weight_when_available(
        self,
    ) -> None:
        variable = Path("C:/Windows/Fonts/NotoSansKR-VF.ttf")
        if not variable.is_file():
            self.skipTest("Windows Noto Sans KR variable fixture is unavailable")
        output, record = PACK._materialize_representative_font(variable.read_bytes())
        self.assertTrue(record["materialized_static_instance"])
        self.assertEqual(record["axis_coordinates"]["wght"], 400.0)
        path = self.root / "materialized.ttf"
        path.write_bytes(output)
        with TTFont(str(path), lazy=False) as font:
            self.assertNotIn("fvar", font)

    def _build_mock_pack(self) -> dict[str, object]:
        metadata = {
            "familyMetadataList": [
                {
                    "family": "Japanese Open",
                    "isOpenSource": True,
                    "primaryScript": "Hira",
                    "subsets": ["japanese"],
                },
                {
                    "family": "Korean Open",
                    "isOpenSource": True,
                    "primaryScript": "Kore",
                    "subsets": ["korean"],
                },
            ]
        }

        def downloaded(family: str, locale: str, *, commit: str):
            slug = PACK._slug(family)
            fixture = (
                ROOT
                / "src"
                / "renderer"
                / "src"
                / "assets"
                / "fonts"
                / "ko"
                / ("jua.ttf" if locale == "ja" else "dohyeon.ttf")
            )
            original = fixture.read_bytes()
            font_payload, materialization = PACK._materialize_representative_font(
                original
            )
            return {
                "directory": f"ofl/{slug}",
                "family": family,
                "font_filename": f"{slug}.ttf",
                "font_payload": font_payload,
                "license_filename": "OFL.txt",
                "license_id": "OFL-1.1",
                "license_payload": b"SIL Open Font License 1.1\n",
                "license_source_path": f"ofl/{slug}/OFL.txt",
                "locale_hint": locale,
                "materialization": materialization,
                "materialized_filename": f"{slug}.ttf",
                "metadata_payload": METADATA_PB,
                "original_font_payload": original,
                "selected_font": {
                    "filename": f"{slug}.ttf",
                    "style": "normal",
                    "weight": 400,
                },
                "slug": slug,
            }

        with (
            mock.patch.object(PACK, "_github_main_commit", return_value="a" * 40),
            mock.patch.object(
                PACK,
                "_fetch_bytes",
                return_value=json.dumps(metadata).encode("utf-8"),
            ),
            mock.patch.object(PACK, "_download_google_family", side_effect=downloaded),
        ):
            return dict(
                PACK.build_pack(
                    output_dir=self.output,
                    repo_root=ROOT,
                    base_source_manifest=None,
                    max_japanese=0,
                    max_korean=0,
                    include_noto=False,
                    workers=2,
                )
            )

    def test_mock_pack_builds_final_paths_and_strictly_validates(self) -> None:
        result = self._build_mock_pack()
        self.assertEqual(result["face_count"], 2)
        source = json.loads(
            (self.output / PACK.SOURCE_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(len(source["sources"]), 2)
        self.assertTrue(
            all(".staging-" not in row["font_file"] for row in source["sources"])
        )
        self.assertTrue(
            all((ROOT / row["font_file"]).is_file() for row in source["sources"])
        )
        validated = PACK.validate_pack(self.output, repo_root=ROOT)
        self.assertEqual(
            validated["status"], "validated_open_font_training_source_pack"
        )

    def test_download_tamper_is_rejected(self) -> None:
        self._build_mock_pack()
        font = next((self.output / PACK.UPSTREAM_DIR).rglob("*.ttf"))
        font.write_bytes(font.read_bytes() + b"tamper")
        with self.assertRaisesRegex(PACK.GlyphVoiceSourcePackError, "identity drifted"):
            PACK.validate_pack(self.output, repo_root=ROOT)

    def test_unsupported_license_is_rejected(self) -> None:
        payload = METADATA_PB.replace(b'license: "OFL"', b'license: "UNKNOWN"')
        with self.assertRaisesRegex(
            PACK.GlyphVoiceSourcePackError, "license is missing or unsupported"
        ):
            PACK._parse_google_metadata(payload)


if __name__ == "__main__":
    unittest.main()
