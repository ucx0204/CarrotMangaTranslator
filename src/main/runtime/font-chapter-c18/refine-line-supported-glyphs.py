"""Body-line selection and independent contextual evidence for broken glyphs."""
import argparse
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location('same_glyph', Path(__file__).with_name('analyze-matched-glyphs.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
POLICY = {
    'id': 'body-line-context-consensus-s11b',
    'bodyLine': 'Keep previously verified glyphs unless their kana-only narrow line is adjacent on the ruby side of an overlapping wider line containing kanji. Region-line substring agreement is required only for new context support.',
    'amendment': 'S11a removed genuine body glyphs when line order or small kana differed from region OCR. Rejected that removal gate after inspecting removed crops; do not loosen glyph OCR on unrelated lines.',
    'strictGate': 'Original exact glyph Hayai and shape distance <=1/3.',
    'contextGate': 'A failed glyph OCR may supply explicitly context-supported evidence only with a source-matching line of >=2 characters, shape distance <=1/3, and two other blocks with distinct line texts forming a complete passing pixel triangle for the proposed character. At least one line has >=4 characters.',
    'pixelGate': 'Preexisting within-block pixel cutoff, without retuning; no named character, page, group, font, user label or Korean choice.',
    'authority': 'Context-supported is weaker than glyph OCR agreement. Preserve original OCR and witness records. Not human gold, automatically training labels or font choices.',
    'reject': 'Incorrect glyph crops gain support, real body lines disappear excessively, or source grouping gets worse. Audit recovered and removed crops before Korean rendering.',
}

def letters(text):
    return ''.join(c for c in helpers.normalize(text) if helpers.is_style_character(c))

def ruby_line(line, lines, vertical):
    text = letters(line['text'])
    if not text or any('\u4e00' <= c <= '\u9fff' for c in text):
        return False
    x1,y1,x2,y2 = line['bbox']
    extent = x2-x1 if vertical else y2-y1
    for peer in lines:
        if peer is line or not any('\u4e00' <= c <= '\u9fff' for c in peer['text']):
            continue
        a,b,c,d = peer['bbox']
        other = c-a if vertical else d-b
        if extent >= other*.6:
            continue
        overlap = max(0,min(y2,d)-max(y1,b))/max(1,y2-y1) if vertical else max(0,min(x2,c)-max(x1,a))/max(1,x2-x1)
        side = x1 >= c-other*.15 and x1-c <= other*.75 if vertical else y2 <= b+other*.15 and b-y2 <= other*.75
        if side and overlap >= .5:
            return True
    return False

def collect(aligned, verified, pages):
    items, line_audit = [], []
    for block in aligned['records']:
        text = letters(block['sourceText'])
        for line in block['lines']:
            line_text = letters(line['text'])
            body = not ruby_line(line,block['lines'],block['direction']=='vertical')
            context_allowed = bool(line_text and line_text in text)
            line_audit.append({'key': block['key'], 'lineId': line['lineId'], 'text': line['text'], 'body': body, 'contextAllowed': context_allowed, 'bbox': line['bbox']})
            if not body:
                continue
            box = line['bbox']
            gray = np.asarray(pages[block['key'].split('/')[0]].crop(box))
            _, mask = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            if mask.mean() > .5:
                mask = 1 - mask
            for g in line['glyphs']:
                identity = (block['key'], line['lineId'], g['characterIndex'])
                v = verified.get(identity)
                if v is None or g['shapeDistance'] > 1 / 3 or (not v['accepted'] and not context_allowed):
                    continue
                x1, y1, x2, y2 = g['bbox']
                tile = helpers.canonical(mask[y1-box[1]:y2-box[1], x1-box[0]:x2-box[0]])
                if tile is None:
                    continue
                items.append({'key': block['key'], 'character': g['token'], 'lineId': line['lineId'], 'lineText': line_text,
                              'contextAllowed': context_allowed,
                              'characterIndex': g['characterIndex'], 'bbox': g['bbox'], 'tensor': tile,
                              'actualOcr': v['actual'], 'glyphOcrAgreement': v['ocrAgreement'], 'accepted': v['accepted'],
                              'authority': 'strict_glyph_ocr' if v['accepted'] else 'pending_context', 'support': []})
    return items, line_audit

def corroborate(items, cutoff):
    # A short selection may have fewer than 12 within-block repeated pairs.
    # Keep strict OCR evidence, but do not invent a threshold for recovery.
    if cutoff is None:
        return
    by_char, distances = {}, {}
    for i, item in enumerate(items):
        by_char.setdefault(item['character'], []).append(i)
    def distance(i, j):
        pair = tuple(sorted((i, j)))
        if pair not in distances:
            distances[pair] = helpers.glyph_distance(items[i]['tensor'], items[j]['tensor'])
        return distances[pair]
    for i, item in enumerate(items):
        if item['accepted'] or len(item['lineText']) < 2:
            continue
        neighbors = [j for j in by_char[item['character']] if items[j]['contextAllowed'] and items[j]['key'] != item['key']
                     and items[j]['lineText'] != item['lineText'] and len(items[j]['lineText']) >= 2 and distance(i,j) <= cutoff]
        for a,b in itertools.combinations(neighbors, 2):
            if items[a]['key'] == items[b]['key'] or items[a]['lineText'] == items[b]['lineText']:
                continue
            if max(len(items[k]['lineText']) for k in (i,a,b)) < 4 or distance(a,b) > cutoff:
                continue
            item['accepted'] = True
            item['authority'] = 'line_context_and_pixel_triangle'
            item['support'] = [{'key': items[j]['key'], 'lineId': items[j]['lineId'], 'characterIndex': items[j]['characterIndex'],
                                'lineText': items[j]['lineText'], 'distance': distance(i,j)} for j in (a,b)]
            break

def run(chapter, alignment, original, output):
    output.mkdir(parents=True, exist_ok=False)
    (output / 'glyphs').mkdir()
    (output / 'executed-source.py').write_bytes(Path(__file__).read_bytes())
    (output / 'protocol.json').write_text(json.dumps(POLICY, indent=2), encoding='utf-8')
    prior = helpers.read_json(original / 'analysis.json')
    aligned = helpers.read_json(alignment / 'alignment.json')
    verified = {(v['key'], v['lineId'], v['characterIndex']): v for v in prior['verification']}
    cutoff = prior['summary']['cutoff']
    baseline = helpers.read_json(chapter / 'ocr-baseline/baseline-report.json')
    pages = {p['pageId']: Image.open(chapter / 'ocr-baseline' / p['ocrImagePath'] if p.get('ocrImagePath') else Path(p['imagePath'])).convert('L') for p in baseline['pages']}
    items, line_audit = collect(aligned, verified, pages)
    corroborate(items, cutoff)
    selected, tensors, blocks, audit = {}, {}, [], []
    for item in items:
        audit.append({k:v for k,v in item.items() if k != 'tensor'})
        if not item['accepted']:
            continue
        key = item['key']
        glyphs = selected.setdefault(key, [])
        name = f"glyphs/{key.replace('/', '-')}-{len(glyphs):03d}-U{ord(item['character']):04X}.png"
        Image.fromarray((255*(1-item['tensor'])).round().astype(np.uint8)).save(output / name)
        glyph = {k:item[k] for k in ('character','lineId','characterIndex','bbox','authority','glyphOcrAgreement','actualOcr','support')}
        glyph['image'] = name
        glyphs.append(glyph)
        tensors.setdefault(key, {}).setdefault(item['character'], []).append({**glyph, 'tensor':item['tensor']})
    for block in prior['blocks']:
        glyphs = selected.get(block['key'], [])
        blocks.append({**block, 'glyphs':glyphs, 'usable':len(glyphs)>=helpers.POLICY['minimumGlyphsPerBlock']})
    usable = {b['key']:tensors[b['key']] for b in blocks if b['usable']}
    pairs = [{'left':a, 'right':b, **helpers.pair_evidence(usable[a],usable[b])} for a,b in itertools.combinations(sorted(usable),2)]
    groups = helpers.group_blocks(blocks, pairs, cutoff) if cutoff is not None else []
    strict = sum(i['authority']=='strict_glyph_ocr' for i in items)
    recovered = sum(i['authority']=='line_context_and_pixel_triangle' for i in items)
    summary = {'blocks':len(blocks), 'glyphs':strict+recovered, 'strictGlyphs':strict, 'contextSupportedGlyphs':recovered,
               'removedStrictGlyphs':prior['summary']['glyphs']-strict, 'cutoff':cutoff, 'usableBlocks':len(usable)}
    payload = {'policy':POLICY, 'summary':summary, 'blocks':blocks, 'pairs':pairs, 'groups':groups, 'verification':audit, 'lineAudit':line_audit,
               'originalAnalysisSha256':hashlib.sha256((original/'analysis.json').read_bytes()).hexdigest(),
               'alignmentSha256':hashlib.sha256((alignment/'alignment.json').read_bytes()).hexdigest()}
    (output/'analysis.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for arg in ('chapter','alignment','original','output'):
        parser.add_argument(arg,type=Path)
    a=parser.parse_args()
    run(a.chapter.resolve(),a.alignment.resolve(),a.original.resolve(),a.output.resolve())
