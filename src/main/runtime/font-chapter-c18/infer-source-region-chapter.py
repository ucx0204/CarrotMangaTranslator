"""CPU-only inference using the S20 producer's exact frozen preprocessing."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
from PIL import Image


def read(p):
    return json.loads(p.read_text('utf-8-sig'))


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def softmax(x):
    v = np.exp(x - x.max())
    return v / v.sum()


def run(chapter, model, output, parity):
    if output.exists():
        raise ValueError('Preserve existing inference')
    receipt = read(model / 'receipt.json')
    if sha(model / 'model.onnx') != receipt['modelSha256'] or sha(model / 'executed-source.py') != receipt['scriptSha256']:
        raise ValueError('Frozen source-region artifact changed')
    spec = importlib.util.spec_from_file_location('frozen_source_region', model / 'executed-source.py')
    producer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(producer)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    pages = read(chapter / 'ocr-baseline/baseline-report.json')['pages']
    included = {(r['pageId'], r['candidateId']) for r in read(chapter / 'translations.json')['records'] if not r['excluded']}
    records = []
    began = time.perf_counter()
    for page in pages:
        source = Path(page['imagePath'])
        if sha(source) != page['sha256']:
            raise ValueError('Source raster changed')
        with Image.open(source) as image:
            gray = np.asarray(image.convert('L'))
        for candidate in page['candidates']:
            if (page['pageId'], candidate['candidateId']) not in included:
                continue
            b = candidate['bbox']
            region = gray[math.floor(b['y1']):math.ceil(b['y2']), math.floor(b['x1']):math.ceil(b['x2'])]
            views = producer.views(region, candidate['sourceText']).astype(np.float32)[None]
            a, w, feature = session.run(None, {'source_views': views})
            ap, wt = softmax(a[0]), softmax(w[0])
            records.append({'key': page['pageId'] + '/' + candidate['candidateId'], 'sourceText': candidate['sourceText'],
                            'class': producer.CLASSES[int(ap.argmax())], 'confidence': float(ap.max()),
                            'weight': producer.WEIGHTS[int(wt.argmax())], 'weightConfidence': float(wt.max()),
                            'probabilities': ap.tolist(), 'weightProbabilities': wt.tolist(), 'embedding': feature[0].tolist()})
    result = {'authority': 'Frozen S20 CPU source-only inference; no Korean labels, training, or choice modifications.',
              'modelSha256': sha(model / 'model.onnx'), 'sourcePreprocessorSha256': sha(model / 'executed-source.py'),
              'entrySha256': sha(Path(__file__)), 'ocrReportSha256': sha(chapter / 'ocr-baseline/baseline-report.json'),
              'providers': session.get_providers(), 'threads': 4, 'seconds': time.perf_counter() - began, 'records': records}
    if parity:
        expected = {r['key']: r for r in read(parity)['records']}
        if set(expected) != {r['key'] for r in records}:
            raise ValueError('Parity inventory differs')
        error = max(float(np.abs(np.array(r['probabilities']) - expected[r['key']]['probabilities']).max()) for r in records)
        result['parity'] = {'referenceSha256': sha(parity), 'maxProbabilityError': error}
        if error > .0001:
            raise ValueError(f'Frozen preprocessing parity failed: {error}')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n', 'utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'records'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['chapter', 'model', 'output']:
        parser.add_argument(name, type=Path)
    parser.add_argument('--parity', type=Path)
    args = parser.parse_args()
    run(args.chapter, args.model, args.output, args.parity)
