from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_manga_font_glyphvoice_bridge_corpus.py"
SPEC = importlib.util.spec_from_file_location(
    "build_manga_font_glyphvoice_bridge_corpus_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
CORPUS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORPUS
SPEC.loader.exec_module(CORPUS)


def _glyph_box(seed: int):
    pen = TTGlyphPen(None)
    inset = 40 + seed % 90
    top = 660 - seed % 70
    pen.moveTo((inset, 40))
    pen.lineTo((560 - inset // 2, 40))
    pen.lineTo((560 - inset // 2, top))
    pen.lineTo((inset, top))
    pen.closePath()
    if seed % 3 == 0:
        pen.moveTo((inset + 70, 120))
        pen.lineTo((inset + 140, 120))
        pen.lineTo((inset + 140, 260))
        pen.lineTo((inset + 70, 260))
        pen.closePath()
    return pen.glyph()


def _write_test_font(path: Path, characters: str, *, family: str) -> None:
    unique = tuple(
        dict.fromkeys(character for character in characters if not character.isspace())
    )
    glyph_order = [".notdef", *[f"g{ord(character):04x}" for character in unique]]
    glyphs = {".notdef": _glyph_box(997)}
    cmap: dict[int, str] = {}
    for index, character in enumerate(unique, start=1):
        name = f"g{ord(character):04x}"
        cmap[ord(character)] = name
        glyphs[name] = _glyph_box(index)
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(glyph_order)
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (620, 20) for name in glyph_order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable(
        {
            "familyName": family,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"GlyphVoiceTest-{family}",
            "fullName": f"{family} Regular",
            "psName": f"GlyphVoiceTest-{family.replace(' ', '')}",
            "version": "Version 1.0",
        }
    )
    builder.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=800,
        usWinDescent=200,
    )
    builder.setupPost()
    builder.setupMaxp()
    builder.save(path)


class GlyphVoiceBridgeCorpusTest(unittest.TestCase):
    def setUp(self) -> None:
        (ROOT / ".tmp").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(
            prefix="glyphvoice-corpus-test-", dir=ROOT / ".tmp"
        )
        self.root = Path(self.temporary.name)
        self.license_path = self.root / "OFL.txt"
        self.license_path.write_text(
            "SIL Open Font License Version 1.1\n", encoding="utf-8"
        )
        all_japanese = "".join(row[1] for row in CORPUS.SENTENCE_PAIRS)
        all_korean = "".join(row[2] for row in CORPUS.SENTENCE_PAIRS)
        self.bridge_font = self.root / "bridge.ttf"
        self.japanese_font = self.root / "japanese.ttf"
        self.korean_font = self.root / "korean.ttf"
        _write_test_font(
            self.bridge_font,
            all_japanese + all_korean,
            family="Synthetic Bridge",
        )
        _write_test_font(self.japanese_font, all_japanese, family="Synthetic Japanese")
        _write_test_font(self.korean_font, all_korean, family="Synthetic Korean")
        self.source_manifest = self.root / "sources.json"
        sources = []
        for source_id, family_id, label, locale, path in (
            ("bridge", "bridge-family", "Synthetic Bridge", "multi", self.bridge_font),
            (
                "japanese",
                "japanese-family",
                "Synthetic Japanese",
                "ja",
                self.japanese_font,
            ),
            ("korean", "korean-family", "Synthetic Korean", "ko", self.korean_font),
        ):
            sources.append(
                {
                    "face_index": 0,
                    "family_id": family_id,
                    "font_file": path.relative_to(ROOT).as_posix(),
                    "font_sha256": CORPUS.sha256_file(path),
                    "label": label,
                    "license": {
                        "id": "OFL-1.1",
                        "source_url": "https://openfontlicense.org",
                        "text_file": self.license_path.relative_to(ROOT).as_posix(),
                        "text_sha256": CORPUS.sha256_file(self.license_path),
                        "training_allowed": True,
                    },
                    "locale_hint": locale,
                    "source_id": source_id,
                }
            )
        source_record = CORPUS.seal_record(
            {
                "authority": CORPUS.EXPECTED_AUTHORITY,
                "counts": {"face_count": 3, "family_count": 3},
                "inputs": {},
                "producer": CORPUS._producer_descriptor(ROOT),
                "record_type": CORPUS.SOURCE_RECORD_TYPE,
                "schema_version": CORPUS.SOURCE_SCHEMA_VERSION,
                "sources": sources,
            }
        )
        self.source_manifest.write_bytes(CORPUS.json_bytes(source_record, pretty=True))
        self.output = self.root / "corpus"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _build(self):
        return CORPUS.build_corpus(
            source_manifest=self.source_manifest,
            output_dir=self.output,
            repo_root=ROOT,
            split_seed="unit-test",
        )

    def test_glyph_validation_rejects_missing_script_instead_of_trusting_cmap_coverage(
        self,
    ) -> None:
        source = CORPUS.SourceFace(
            source_id="korean",
            family_id="korean-family",
            label="Synthetic Korean",
            locale_hint="ko",
            font_path=self.korean_font,
            font_file=self.korean_font.relative_to(ROOT).as_posix(),
            font_sha256=CORPUS.sha256_file(self.korean_font),
            face_index=0,
            license_id="OFL-1.1",
            license_text_file=self.license_path.relative_to(ROOT).as_posix(),
            license_text_sha256=CORPUS.sha256_file(self.license_path),
            source_url="https://openfontlicense.org",
        )
        evidence = CORPUS.inspect_glyphs(source, ("こ", "이"))
        self.assertFalse(evidence["こ"].valid)
        self.assertEqual(evidence["こ"].rejection_reason, "cmap_missing")
        self.assertTrue(evidence["이"].valid)

    def test_real_jua_false_japanese_support_is_rejected(self) -> None:
        path = ROOT / "src" / "renderer" / "src" / "assets" / "fonts" / "ko" / "jua.ttf"
        source = CORPUS.SourceFace(
            source_id="jua",
            family_id="jua",
            label="JUA",
            locale_hint="ko",
            font_path=path,
            font_file=path.relative_to(ROOT).as_posix(),
            font_sha256=CORPUS.sha256_file(path),
            face_index=0,
            license_id="OFL-1.1",
            license_text_file="third_party/fonts/jua/OFL.txt",
            license_text_sha256=CORPUS.sha256_file(
                ROOT / "third_party/fonts/jua/OFL.txt"
            ),
            source_url="https://font.woowahan.com/jua/",
        )
        evidence = CORPUS.inspect_glyphs(source, ("こ", "가"))
        self.assertFalse(evidence["こ"].valid)
        self.assertTrue(evidence["가"].valid)

    def test_build_separates_exact_bridge_and_monolingual_faces(self) -> None:
        result = self._build()
        self.assertEqual(result["face_count"], 3)
        self.assertEqual(result["bridge_pair_count"], 8)
        self.assertEqual(result["sentence_sample_count"], 32)
        self.assertEqual(result["asset_count"], 40)
        faces = [
            json.loads(line)
            for line in (self.output / CORPUS.FACES_FILE)
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        categories = {row["face_id"]: row["category"] for row in faces}
        self.assertEqual(categories["bridge-face0"], "cross_script_bridge")
        self.assertEqual(categories["japanese-face0"], "japanese_only")
        self.assertEqual(categories["korean-face0"], "korean_only")
        self.assertEqual({row["split"] for row in faces}, {"train"})
        pairs = [
            json.loads(line)
            for line in (self.output / CORPUS.PAIRS_FILE)
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertTrue(all(row["face_id"] == "bridge-face0" for row in pairs))
        self.assertTrue(
            all(
                row["visual_review_contract"]["candidate_count_per_image"] == 1
                for row in pairs
            )
        )
        review_path = self.output / pairs[0]["review_asset"]["file"]
        with Image.open(review_path) as review:
            self.assertEqual(review.size, (1600, 620))
            self.assertEqual(review.mode, "RGB")
        self.assertFalse(
            any("contact" in path.name.lower() for path in self.output.rglob("*"))
        )

    def test_bridge_families_are_stratified_into_train_validation_and_test(
        self,
    ) -> None:
        inspected = []
        for index in range(5):
            source = CORPUS.SourceFace(
                source_id=f"bridge-{index}",
                family_id=f"bridge-family-{index}",
                label=f"Bridge {index}",
                locale_hint="multi",
                font_path=self.bridge_font,
                font_file=self.bridge_font.relative_to(ROOT).as_posix(),
                font_sha256=CORPUS.sha256_file(self.bridge_font),
                face_index=0,
                license_id="OFL-1.1",
                license_text_file=self.license_path.relative_to(ROOT).as_posix(),
                license_text_sha256=CORPUS.sha256_file(self.license_path),
                source_url="https://openfontlicense.org",
            )
            inspected.append({"category": "cross_script_bridge", "source": source})
        split_map, strata = CORPUS._stratified_family_splits(inspected, "unit-test")
        self.assertEqual(set(split_map.values()), CORPUS.VALID_SPLITS)
        self.assertEqual(set(strata.values()), {"cross_script_bridge"})

    def test_review_tamper_is_rejected(self) -> None:
        self._build()
        review = next((self.output / CORPUS.ASSET_DIR / "reviews").glob("*.png"))
        review.write_bytes(review.read_bytes() + b"tamper")
        with self.assertRaisesRegex(CORPUS.GlyphVoiceCorpusError, "descriptor drifted"):
            CORPUS.validate_corpus(self.output, repo_root=ROOT)

    def test_source_font_drift_is_rejected_during_validation(self) -> None:
        self._build()
        original = self.bridge_font.read_bytes()
        self.bridge_font.write_bytes(original + b"drift")
        try:
            with self.assertRaisesRegex(
                CORPUS.GlyphVoiceCorpusError, "font hash drifted"
            ):
                CORPUS.validate_corpus(self.output, repo_root=ROOT)
        finally:
            self.bridge_font.write_bytes(original)

    def test_third_party_inventory_is_license_bound_and_deterministic(self) -> None:
        rows_a = CORPUS._third_party_sources(ROOT)
        rows_b = CORPUS._third_party_sources(ROOT)
        self.assertEqual(rows_a, rows_b)
        self.assertGreaterEqual(len(rows_a), 40)
        self.assertTrue(
            all(row["license"]["id"] in CORPUS.ALLOWED_LICENSES for row in rows_a)
        )
        self.assertEqual(
            len({(row["font_sha256"], row["face_index"]) for row in rows_a}),
            len(rows_a),
        )


if __name__ == "__main__":
    unittest.main()
