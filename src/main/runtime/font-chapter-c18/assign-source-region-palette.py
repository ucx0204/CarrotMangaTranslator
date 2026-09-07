"""Development C16: source groups own the family; source observations own weight."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np

CLASSES = ['ordinary_serif', 'regular_sans', 'rounded_print', 'light_hand', 'rough_hand', 'interrupted_hand', 'medium_brush', 'heavy_brush', 'heavy_sans', 'decorative_serif', 'other']
FONTS = {'ordinary_serif': 'ridi-batang', 'regular_sans': 'nanum-gothic',
         'rounded_print': 'jua', 'light_hand': 'start-over',
         'rough_hand': 'geummyeon-seongsil', 'interrupted_hand': 'kkubulim',
         'medium_brush': 'shilla-culture', 'heavy_brush': 'griun-pol-sensibility',
         'heavy_sans': 'dohyeon', 'decorative_serif': 'shilla-culture'}
POLICY = {
    'id': 'c16-source-region-group-palette',
    'scope': 'Existing confirmation-010 is development, second actual product candidate after C14. No source ID/font overrides and no new-chapter success claim.',
    'family': 'Reuse frozen S6 source-only relationships. Aggregate intact-region S20 appearance evidence once per group, with at most one vote per distinct source string. Singletons keep their own source evidence; no preserve-baseline font fallback.',
    'weight': 'Normal families use regular unless local source heavy probability >= .70. Naturally heavy/handwritten display families are not made synthetically bold. Unknown source class falls back within the printed candidates, never to an old generated Korean proxy choice.',
    'unsupported': 'Medium/heavy brush have no sufficient training support, so they are excluded from automatic routing. Decorative serif selects Shilla only with strong local/group decorative evidence; ambiguous forms use Ridi. Broken-hand validation support is only one and remains unproven.',
    'punctuation': 'Punctuation-only strings cannot supply evidence for handwriting/brush/weight classification. Use an ordinary printed face without fabricated style evidence.',
    'protected': 'Same frozen HayaiOCR, direct translation, erasure and balloon geometry. Font and layout are rendered through application functions. Inspect lost emphasis, wrong hand/round assignments, small text and overflow as independent failures.',
}


def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def run(chapter, prediction, groups, output):
    output.mkdir(parents=True, exist_ok=False)
    (output / 'protocol.json').write_text(json.dumps(POLICY, ensure_ascii=False, indent=2), encoding='utf-8')
    source = read(prediction)
    by_key = {r['key']: r for r in source['records']}
    group_data = read(groups)
    choices = []
    decisions = []
    for group in group_data['groups']:
        members = [by_key[k] for k in group['members']]
        unique = {r['sourceText']: r for r in members}
        score = np.mean([r['probabilities'] for r in unique.values()], axis=0)
        score[[CLASSES.index(c) for c in ['medium_brush', 'heavy_brush', 'other']]] = 0
        kind = CLASSES[int(score.argmax())]
        if kind == 'decorative_serif' and score.max() < .75:
            kind = 'ordinary_serif'
        # Jua's native face is already heavy. Ambiguous round/sans evidence is
        # resolved by source strength rather than making every sans text heavy.
        if kind == 'rounded_print':
            heavy = np.mean([r['weightProbabilities'][3] for r in unique.values()])
            if heavy < .25 and score.max() < .65:
                kind = 'regular_sans'
        decisions.append({'groupId': group['id'], 'members': group['members'], 'kind': kind, 'probabilities': score.tolist()})
        for row in members:
            letters = [c for c in row['sourceText'] if '\u3040' <= c <= '\u30ff' or '\u4e00' <= c <= '\u9fff']
            selected = kind if letters else 'ordinary_serif'
            bold = len(letters) >= 2 and selected in {'ordinary_serif', 'regular_sans'} and row['weightProbabilities'][3] >= .70
            choices.append({'key': row['key'], 'groupId': group['id'], 'fontId': FONTS[selected], 'fontWeight': 700 if bold else 400, 'italic': False, 'type': selected, 'status': 'research_source_selection'})
    if {r['key'] for r in choices} != set(by_key):
        raise ValueError('Incomplete chapter inventory')
    payload = {'authority': POLICY, 'sourcePredictionSha256': sha(prediction), 'sourceGroupSha256': sha(groups), 'groups': decisions, 'choices': choices}
    (output / 'choices.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'palette.json').write_text(json.dumps({'fontIds': sorted({c['fontId'] for c in choices})}), encoding='utf-8')
    print(json.dumps({'choices': len(choices), 'fonts': sorted({c['fontId'] for c in choices})}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['chapter', 'prediction', 'groups', 'output']:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    run(args.chapter, args.prediction, args.groups, args.output)
