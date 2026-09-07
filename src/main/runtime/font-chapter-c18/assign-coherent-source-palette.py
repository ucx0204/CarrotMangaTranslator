"""C18: retain source families, pool weight, corroborate short impressions."""
import argparse
from collections import defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np
from PIL import Image


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


base = module('source_palette', 'assign-source-region-palette.py')
glyph = module('source_glyphs', 'analyze-matched-glyphs.py')
POLICY = {
    'id': 'c18-coherent-source-palette',
    'scope': 'Fifth actual candidate on development confirmation-010 (C13,C14,C16,C17,C18). Freeze before rendering; then rotate to unused chapters. No label or named-block override.',
    'family': 'Retain S6 source groups and S20 group appearance aggregation. One Korean family per original source group.',
    'weight': 'One regular/heavy decision per source group, equal vote per distinct source string. Use the existing .70 heavy threshold on group-average source probability, not a local block outlier. Exact 400/700 reaches the renderer. Native display/hand faces are not synthetically emboldened.',
    'shortEvidence': 'For unresolved groups with at most three actual Japanese letters, compare intact projected source glyphs against verified same-character observations elsewhere in this chapter. Existing pixel cutoff only. Require at least two witnesses with distinct source strings and unanimous target family. This attaches a palette observation, not an asserted exact Japanese font identity or a training label.',
    'ambiguousShort': 'Without corroboration, a short handwritten prediction below .70 is unresolved; select among printed categories from the same source posterior. Rounded print still requires native-heavy source support, preventing Jua from becoming a generic fallback. Report these unresolved cases explicitly.',
    'punctuation': 'Reuse is_style_character, whose Japanese letter ranges exclude middle dots, long dashes, and punctuation. A punctuation-only region has no handwriting/weight evidence.',
    'protected': 'Frozen HayaiOCR/direct translation/erasure/balloon masks; current measured source size. No v2.5.0 baseline mutation. Size, emphasis, handwriting, group consistency and overflow receive separate visual review.',
    'limits': 'S20 weak-label generalization remains limited. No medium/heavy brush support claim. One-glyph corroboration is weaker than a multi-character group and is recorded separately.',
}


def read(p):
    return json.loads(p.read_text('utf-8-sig'))


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def letters(text):
    return [c for c in glyph.normalize(text) if glyph.is_style_character(c)]


def select_kind(score, weights):
    score = score.copy()
    score[[base.CLASSES.index(c) for c in ['medium_brush', 'heavy_brush', 'other']]] = 0
    kind = base.CLASSES[int(score.argmax())]
    if kind == 'decorative_serif' and score.max() < .75:
        kind = 'ordinary_serif'
    if kind == 'rounded_print' and weights[3] < .25 and score.max() < .65:
        kind = 'regular_sans'
    return kind


def run(chapter, prediction, groups, verified, output):
    output.mkdir(parents=True, exist_ok=False)
    (output / 'protocol.json').write_text(json.dumps(POLICY, ensure_ascii=False, indent=2), 'utf-8')
    (output / 'executed-source.py').write_bytes(Path(__file__).read_bytes())
    rows = {r['key']: r for r in read(prediction)['records']}
    original = read(groups)
    analysis = read(verified / 'analysis.json')
    cutoff = analysis['summary']['cutoff']
    selections = {}
    group_records = []
    for group in original['groups']:
        unique = {rows[k]['sourceText']: rows[k] for k in group['members']}
        score = np.mean([r['probabilities'] for r in unique.values()], 0)
        weights = np.mean([r['weightProbabilities'] for r in unique.values()], 0)
        kind = select_kind(score, weights)
        group_records.append({**group, 'kind': kind, 'probabilities': score.tolist(), 'weightProbabilities': weights.tolist()})
        for key in group['members']:
            selected = kind if letters(rows[key]['sourceText']) else 'ordinary_serif'
            selections[key] = {'key': key, 'groupId': group['id'], 'fontId': base.FONTS[selected],
                               'fontWeight': 700 if selected in {'ordinary_serif', 'regular_sans'} and weights[3] >= .70 else 400,
                               'italic': False, 'type': selected, 'status': 'research_source_selection'}
    # Corroboration only uses preexisting verified observations and frozen S6
    # choices. New short attachments cannot vote for the next attachment.
    references = defaultdict(list)
    for block in analysis['blocks']:
        if block['key'] not in selections:
            continue
        for g in block['glyphs']:
            if not g.get('glyphOcrAgreement'):
                continue
            tensor = 1 - np.asarray(Image.open(verified / g['image']).convert('L'), np.float32) / 255
            references[g['character']].append((block['key'], block['sourceText'], tensor))
    pages = {p['pageId']: p for p in read(chapter / 'ocr-baseline/baseline-report.json')['pages']}
    candidates = {}
    for page_id in pages:
        p = chapter / 'baseline' / page_id / 'font-page.json'
        if p.exists():
            candidates.update({page_id + '/' + r['candidate']['candidateId']: r['candidate'] for r in read(p)['inputs']})
    audit = []
    attachments = {}
    for group in original['groups']:
        if len(group['members']) != 1:
            continue
        key = group['members'][0]
        text = rows[key]['sourceText']
        if not 1 <= len(letters(text)) <= 3:
            continue
        candidate = candidates[key]
        box = candidate['bbox']
        with Image.open(pages[key.split('/')[0]]['imagePath']) as source:
            extracted = glyph.extract_line(source, {'id': 0, 'bbox': [box['x1'], box['y1'], box['x2'], box['y2']]}, text, candidate['direction'])
        witnesses = {}
        for observed in extracted:
            for other_key, other_text, tensor in references[observed['character']]:
                if other_key == key or other_text == text:
                    continue
                distance = glyph.glyph_distance(observed['tensor'], tensor)
                if cutoff is not None and distance <= cutoff:
                    match = {'key': other_key, 'sourceText': other_text, 'character': observed['character'], 'distance': distance,
                             'fontId': selections[other_key]['fontId'], 'fontWeight': selections[other_key]['fontWeight']}
                    if other_text not in witnesses or distance < witnesses[other_text]['distance']:
                        witnesses[other_text] = match
        families = {(w['fontId'], w['fontWeight']) for w in witnesses.values()}
        record = {'key': key, 'sourceText': text, 'extractedCharacters': [g['character'] for g in extracted], 'witnesses': list(witnesses.values()), 'corroborated': len(witnesses) >= 2 and len(families) == 1}
        if record['corroborated']:
            family, weight = next(iter(families))
            exemplar = next(s for s in selections.values() if s['fontId'] == family and s['fontWeight'] == weight)
            attachments[key] = {**selections[key], 'fontId': family, 'fontWeight': weight, 'type': exemplar['type'], 'reason': 'same_character_chapter_corroboration'}
        elif selections[key]['type'] in {'light_hand', 'rough_hand', 'interrupted_hand'} and max(rows[key]['probabilities']) < .70:
            score = np.array(rows[key]['probabilities'])
            score[[base.CLASSES.index(c) for c in ['light_hand', 'rough_hand', 'interrupted_hand']]] = 0
            kind = select_kind(score, rows[key]['weightProbabilities'])
            attachments[key] = {**selections[key], 'fontId': base.FONTS[kind], 'fontWeight': 400, 'type': kind, 'reason': 'unresolved_short_printed_posterior'}
            record['unresolved'] = True
        audit.append(record)
    selections.update(attachments)
    if set(selections) != set(rows):
        raise ValueError('Incomplete chapter inventory')
    payload = {'authority': POLICY, 'sourcePredictionSha256': sha(prediction), 'sourceGroupSha256': sha(groups),
               'glyphAnalysisSha256': sha(verified / 'analysis.json'), 'pixelCutoff': cutoff,
               'groups': group_records, 'shortEvidence': audit, 'choices': list(selections.values())}
    (output / 'choices.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), 'utf-8')
    (output / 'palette.json').write_text(json.dumps({'fontIds': sorted({c['fontId'] for c in selections.values()})}), 'utf-8')
    print(json.dumps({'choices': len(selections), 'attachments': attachments, 'corroborated': sum(a['corroborated'] for a in audit)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['chapter', 'prediction', 'groups', 'verified', 'output']:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    run(args.chapter, args.prediction, args.groups, args.verified, args.output)
