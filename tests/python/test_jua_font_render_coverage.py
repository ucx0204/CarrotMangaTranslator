"""Keep Jua's mapped-but-unpainted glyphs from swallowing fallback text."""

from pathlib import Path
import re
import unittest

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[2]


class JuaRenderCoverageTest(unittest.TestCase):
    def test_css_keeps_every_outline_and_space_but_excludes_empty_visible_glyphs(self):
        source = (ROOT / "src/renderer/src/styles/fonts.css").read_text("utf-8")
        faces = re.findall(r"@font-face\s*\{([^}]+)\}", source)
        jua = [face for face in faces if 'font-family: "MGT Jua";' in face]
        self.assertEqual(len(jua), 1)
        descriptor = re.search(r"unicode-range:\s*([^;]+);", jua[0])
        self.assertIsNotNone(descriptor)
        covered = set()
        for item in descriptor.group(1).split(","):
            bounds = item.strip().removeprefix("U+").split("-")
            covered.update(range(int(bounds[0], 16), int(bounds[-1], 16) + 1))

        font_path = ROOT / "src/renderer/src/assets/fonts/ko/jua.ttf"
        with TTFont(font_path) as font:
            glyph_set = font.getGlyphSet()
            expected = set()
            for codepoint, glyph_name in font.getBestCmap().items():
                pen = BoundsPen(glyph_set)
                glyph_set[glyph_name].draw(pen)
                if pen.bounds is not None or chr(codepoint).isspace() or codepoint < 32:
                    expected.add(codepoint)
        self.assertEqual(covered, expected)
        self.assertTrue(all(ord(char) in covered for char in "주아 가나다 ABC 123!?…"))
        self.assertTrue(all(ord(char) not in covered for char in "—―─·「」갂힣"))
        self.assertTrue(all(ord(char) in covered for char in " \t\n\u00a0\u3000"))


if __name__ == "__main__":
    unittest.main()
