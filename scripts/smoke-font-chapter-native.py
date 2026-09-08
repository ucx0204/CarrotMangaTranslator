"""Check native imports and deterministic learned-model parity in an installed pack."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--record', action='store_true')
    args = parser.parse_args()
    assets = args.assets.resolve()
    manifest = json.loads((assets / 'ownership.json').read_text('utf-8'))
    spec = importlib.util.spec_from_file_location('font_worker', args.runtime / 'font-chapter-c18/worker.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    worker.validate_assets(assets, manifest)
    sys.path.insert(0, str(assets / 'python-packages'))
    import cv2
    import numpy as np
    import onnxruntime as ort
    from scipy import ndimage
    from fontTools.ttLib import TTFont
    import torch
    from PIL import Image
    torch.set_num_threads(4)
    font = next(row['path'] for row in manifest['files'] if row['path'].endswith('.ttf'))
    with TTFont(assets / font) as face:
        assert face.getBestCmap()
    tile = np.arange(48 * 48, dtype=np.float32).reshape(48, 48) / (48 * 48)
    assert np.asarray(Image.fromarray((tile * 255).astype(np.uint8))).shape == tile.shape
    producer_spec = importlib.util.spec_from_file_location('source_region', assets / 'source-region/executed-source.py')
    producer = importlib.util.module_from_spec(producer_spec)
    producer_spec.loader.exec_module(producer)
    assert np.isfinite(producer.views((tile * 255).astype(np.uint8), 'あいう')).all()
    assert cv2.resize(tile, (24, 24)).shape == (24, 24)
    assert ndimage.gaussian_filter(tile, 1).shape == tile.shape
    result = {}
    for name in ['source-metric', 'source-region']:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        session = ort.InferenceSession(str(assets / name / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        inputs = {}
        for item in session.get_inputs():
            shape = [v if isinstance(v, int) and v > 0 else 1 for v in item.shape]
            value = (np.arange(np.prod(shape), dtype=np.float32) % 251) / 251
            inputs[item.name] = value.reshape(shape)
        result[name] = [value.tolist() for value in session.run(None, inputs)]
    if args.record:
        if args.reference.exists():
            raise ValueError('Do not overwrite native parity references')
        args.reference.write_text(json.dumps(result, indent=2) + '\n', 'utf-8')
    else:
        expected = json.loads(args.reference.read_text('utf-8'))
        assert result.keys() == expected.keys()
        for name, outputs in result.items():
            assert len(outputs) == len(expected[name])
            for output, reference in zip(outputs, expected[name]):
                np.testing.assert_allclose(output, reference, rtol=1e-4, atol=1e-5)
    print(json.dumps({'version': manifest['version'], 'models': list(result),
                      'provider': 'CPUExecutionProvider', 'nativeDependencies': 'ready',
                      'parity': 'recorded' if args.record else 'passed'}))


if __name__ == '__main__':
    main()
