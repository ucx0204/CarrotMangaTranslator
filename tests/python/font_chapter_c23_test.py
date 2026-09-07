"""Run with the owned runtime dependencies or a Python with numpy/Pillow/OpenCV."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2] / 'src/main/runtime/font-chapter-c18'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), 'utf-8')


class SourceRecovery(unittest.TestCase):
    def test_short_selection_without_pixel_cutoff_keeps_strict_evidence(self):
        refine = load('refine-line-supported-glyphs')
        items = [
            {'accepted': True, 'authority': 'strict_glyph_ocr'},
            {'accepted': False, 'authority': 'pending_context'},
        ]
        refine.corroborate(items, None)
        self.assertEqual([i['accepted'] for i in items], [True, False])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chapter, aligned, verified, output = [root / name for name in ['chapter', 'aligned', 'verified', 'output']]
            image = Image.new('L', (30, 40), 255)
            ImageDraw.Draw(image).rectangle((10, 5, 15, 34), fill=0)
            image.save(root / 'source.png')
            write(chapter / 'ocr-baseline/baseline-report.json', {'pages': [{'pageId': 'P1', 'imagePath': str(root / 'source.png')}]})
            glyph = {'characterIndex': 0, 'bbox': [8, 3, 18, 37], 'token': 'あ', 'shapeDistance': 0.1}
            write(aligned / 'alignment.json', {'records': [{'key': 'P1/D1', 'sourceText': 'あ', 'direction': 'vertical', 'lines': [
                {'lineId': 1, 'text': 'あ', 'bbox': [8, 3, 18, 37], 'glyphs': [glyph]}]}]})
            write(verified / 'analysis.json', {'summary': {'cutoff': None, 'glyphs': 1}, 'blocks': [{'key': 'P1/D1'}],
                'verification': [{'key': 'P1/D1', 'lineId': 1, 'characterIndex': 0, 'accepted': True, 'actual': 'あ', 'ocrAgreement': True}]})
            refine.run(chapter, aligned, verified, output)
            result = json.loads((output / 'analysis.json').read_text('utf-8'))
            self.assertIsNone(result['summary']['cutoff'])
            self.assertEqual(result['summary']['strictGlyphs'], 1)
            self.assertEqual(result['summary']['contextSupportedGlyphs'], 0)
            self.assertEqual(result['groups'], [])
            self.assertEqual(result['blocks'][0]['glyphs'][0]['authority'], 'strict_glyph_ocr')

    def test_preserves_existing_evidence_and_rejects_mismatched_or_single_letter_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chapter, aligned, verified, output = [root / name for name in ['chapter', 'aligned', 'verified', 'output']]
            old_glyph = {'character': 'あ', 'lineId': 1, 'characterIndex': 0,
                         'bbox': [0, 0, 10, 10], 'image': 'glyphs/old.png',
                         'glyphOcrAgreement': True}
            old = {'summary': {'glyphs': 1, 'strictGlyphs': 1, 'contextSupportedGlyphs': 0,
                               'removedStrictGlyphs': 0, 'cutoff': 0.123},
                   'blocks': [{'key': 'P1/D1', 'sourceText': 'あいう', 'glyphs': [old_glyph]},
                              {'key': 'P1/D2', 'sourceText': 'あいう', 'glyphs': []}],
                   'pairs': [], 'groups': []}
            write(chapter / 'line-supported/analysis.json', old)
            old_file = chapter / 'line-supported' / old_glyph['image']
            old_file.parent.mkdir()
            image = Image.new('L', (48, 48), 255)
            ImageDraw.Draw(image).rectangle((10, 8, 15, 39), fill=0)
            image.save(old_file)
            old_bytes = old_file.read_bytes()
            glyphs = [dict(old_glyph, image='glyphs/new-a.png'),
                      dict(old_glyph, character='い', bbox=[0, 12, 10, 22], image='glyphs/new-i.png'),
                      dict(old_glyph, character='え', lineId=2, bbox=[12, 0, 22, 10], image='glyphs/mismatch.png'),
                      dict(old_glyph, character='う', lineId=3, bbox=[24, 0, 34, 10], image='glyphs/single.png')]
            # A duplicate bbox must not inflate the matching evidence.
            glyphs.append(dict(glyphs[0]))
            write(verified / 'analysis.json', {'blocks': [
                {'key': 'P1/D1', 'glyphs': glyphs}, {'key': 'P1/D2', 'glyphs': glyphs}]})
            (verified / 'glyphs').mkdir()
            for glyph in glyphs:
                image.save(verified / glyph['image'])
            write(aligned / 'alignment.json', {'records': [{'key': 'P1/D2', 'lines': [
                {'lineId': 1, 'text': 'あい', 'bbox': [0, 0, 10, 22]},
                {'lineId': 2, 'text': 'えお', 'bbox': [12, 0, 22, 22]},
                {'lineId': 3, 'text': 'う', 'bbox': [24, 0, 34, 10]}]}]})
            load('recover-zero-glyph-evidence').run(chapter, aligned, verified, output)
            result = json.loads((output / 'analysis.json').read_text('utf-8'))
            self.assertEqual(result['blocks'][0]['glyphs'], [old_glyph])
            self.assertEqual((output / old_glyph['image']).read_bytes(), old_bytes)
            self.assertEqual([g['character'] for g in result['blocks'][1]['glyphs']], ['あ', 'い'])
            self.assertEqual(result['summary']['cutoff'], 0.123)
            self.assertEqual(result['summary']['strictGlyphs'], 3)
            self.assertEqual(result['summary']['glyphs'], 3)
            self.assertEqual(result['summary']['contextSupportedGlyphs'], 0)
            self.assertEqual(result['summary']['c23RecoveredBlocks'], 1)
            self.assertEqual(old_file.read_bytes(), old_bytes)

    def test_no_missing_regions_skips_extra_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            chapter = Path(directory)
            write(chapter / 'line-supported/analysis.json', {'blocks': [{'glyphs': [{}]}]})
            worker = load('worker')
            worker.hayai = lambda *_: self.fail('Unnecessary Hayai recovery call')
            self.assertEqual(worker.recover_source_evidence(chapter, None, None), chapter / 'line-supported')
            self.assertFalse((chapter / 'recovery').exists())


if __name__ == '__main__':
    unittest.main()
