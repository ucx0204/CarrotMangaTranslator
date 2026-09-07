"""C23 source recovery, approved by the user after whole-chapter review.

Preserve every existing supported glyph and the original pixel cutoff. Only
zero-glyph regions can receive strict raw-Hayai evidence. Korean choices and
evaluation labels are never read. Grouping and palette selection belong to the
existing worker stages, not this evidence merger.
"""
import argparse
import copy
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image


def read(path):
    return json.loads(path.read_text('utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(chapter, aligned, verified, output):
    original = chapter / 'line-supported'
    old = read(original / 'analysis.json')
    new = read(verified / 'analysis.json')
    alignment = read(aligned / 'alignment.json')
    output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location(
        'c23_source_glyphs', Path(__file__).with_name('analyze-matched-glyphs.py'))
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)

    def letters(text):
        return ''.join(c for c in helpers.normalize(text) if helpers.is_style_character(c))

    lines = {(b['key'], line['lineId']): line for b in alignment['records'] for line in b['lines']}
    by_key = {b['key']: b for b in new['blocks']}
    result = copy.deepcopy(old)
    additions, tensors = [], {}
    for block in result['blocks']:
        key = block['key']
        original_count = len(block['glyphs'])
        for glyph in block['glyphs']:
            destination = output / glyph['image']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original / glyph['image'], destination)
        if original_count == 0:
            for glyph in by_key[key]['glyphs']:
                line = lines[(key, glyph['lineId'])]
                text = letters(line['text'])
                if len(text) < 2 or text not in letters(block['sourceText']):
                    continue
                if any(glyph['bbox'] == other['bbox'] for other in block['glyphs']):
                    continue
                relative = Path('recovered') / Path(glyph['image']).name
                destination = output / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(verified / glyph['image'], destination)
                glyph = {**glyph, 'image': relative.as_posix(),
                         'authority': 'strict_raw_glyph_ocr_with_region_line_agreement',
                         'glyphOcrAgreement': True, 'actualOcr': glyph['character'], 'support': []}
                block['glyphs'].append(glyph)
                additions.append({'key': key, **glyph, 'rawLineText': line['text'],
                                  'rawLineBbox': line['bbox']})
        block['usable'] = len(block['glyphs']) >= helpers.POLICY['minimumGlyphsPerBlock']
        by_character = {}
        for glyph in block['glyphs']:
            tensor = 1 - np.asarray(Image.open(output / glyph['image']).convert('L'), np.float32) / 255
            by_character.setdefault(glyph['character'], []).append({**glyph, 'tensor': tensor})
        if block['usable']:
            tensors[key] = by_character
    result['pairs'] = [
        {'left': a, 'right': b, **helpers.pair_evidence(tensors[a], tensors[b])}
        for a, b in itertools.combinations(sorted(tensors), 2)
    ]
    result['c23Recovery'] = {
        'scope': 'Only previously zero-glyph blocks; old glyph bytes and cutoff are preserved. '
                 'New lines need at least two Japanese style characters and contiguous region-text '
                 'agreement, after exact raw-glyph Hayai and the unchanged shape gate.',
        'sourceAnalysisSha256': sha(original / 'analysis.json'),
        'newVerificationSha256': sha(verified / 'analysis.json'),
        'alignmentSha256': sha(aligned / 'alignment.json'),
        'additions': additions, 'scriptSha256': sha(Path(__file__)),
    }
    result['summary'].update(
        glyphs=sum(len(b['glyphs']) for b in result['blocks']), usableBlocks=len(tensors),
        strictGlyphs=old['summary']['strictGlyphs'] + len(additions),
        c23AddedStrictGlyphs=len(additions),
        c23RecoveredBlocks=len({a['key'] for a in additions}))
    (output / 'analysis.json').write_text(
        json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2) + '\n', 'utf-8')
    print(json.dumps({'c23AddedStrictGlyphs': len(additions),
                      'c23RecoveredBlocks': result['summary']['c23RecoveredBlocks']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['chapter', 'aligned', 'verified', 'output']:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    run(args.chapter.resolve(), args.aligned.resolve(), args.verified.resolve(), args.output.resolve())
