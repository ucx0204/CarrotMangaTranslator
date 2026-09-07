"""Chapter C18 execution adapter. All learned inference and shape matching use CPU.

Frozen algorithm modules retain producer receipts. Hayai is the only OCR engine;
its existing installed runtime/cache/device is supplied by the application.
The worker writes only its new job directory, never source pages or the library.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parent


def read(path):
    return json.loads(Path(path).read_text('utf-8-sig'))


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), 'utf-8')


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def validate_assets(assets, manifest):
    files = manifest['files']
    # First bind the dependency inventory itself, then validate its contents.
    for item in files:
        path = (assets / item['path']).resolve()
        if not path.is_relative_to(assets) or not path.is_file() or path.is_symlink():
            raise ValueError('Invalid C18 asset path')
        if path.stat().st_size != item['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('C18 asset bytes differ: ' + item['path'])
    for item in read(assets / 'python-inventory.json')['files']:
        path = (assets / item['path']).resolve()
        if not path.is_relative_to(assets) or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('C18 dependency bytes differ: ' + item['path'])
    for item in manifest['runtimeSources']:
        if hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('C18 algorithm bytes differ: ' + item['path'])


def make_chapter(request, chapter):
    pages = request['pages']
    seen = set()
    translations = []
    for page in pages:
        if page['pageId'] in seen:
            raise ValueError('Duplicate source page identity')
        seen.add(page['pageId'])
        if not page['pageId'].isalnum():
            raise ValueError('Unsafe source page identity')
        if hashlib.sha256(Path(page['imagePath']).read_bytes()).hexdigest() != page['sha256']:
            raise ValueError('Source raster changed during chapter preparation')
        inputs = []
        for candidate in page['candidates']:
            inputs.append({'candidate': candidate})
            translations.append({'pageId': page['pageId'], 'candidateId': candidate['candidateId'], 'excluded': False})
        write(chapter / 'baseline' / page['pageId'] / 'font-page.json', {'inputs': inputs})
    write(chapter / 'ocr-baseline/baseline-report.json', {'pages': pages})
    # Inventory only. No translated words or Korean rendered pixels enter inference.
    write(chapter / 'translations.json', {'records': translations})


def hayai(batch, request):
    if not read(batch)['items']:
        return
    args = [sys.executable, '-u', request['hayaiScript'], '--batch', str(batch),
            '--device', request['ocrDevice'], '--batch-size', '8', '--max-new-tokens', '96']
    env = dict(os.environ)
    env['PYTHONPATH'] = env.get('C18_HAYAI_PYTHONPATH', env.get('PYTHONPATH', ''))
    subprocess.run(args, check=True, stdout=sys.stderr, stderr=sys.stderr, env=env,
                   cwd=request['workingDir'], creationflags=0x08000000 if os.name == 'nt' else 0)


def execute(request):
    assets = Path(request['assets']).resolve()
    manifest = read(request['manifest'])
    validate_assets(assets, manifest)
    # Embedded Python intentionally ignores PYTHONPATH. Add only this verified
    # owned dependency directory, after its complete inventory passes binding.
    sys.path.insert(0, str(assets / 'python-packages'))
    import torch
    torch.set_num_threads(4)
    chapter = Path(request['output']).resolve()
    chapter.mkdir(parents=True, exist_ok=False)
    make_chapter(request, chapter)
    module('prepare-line-probe').build(chapter, chapter / 'line-probe')
    hayai(chapter / 'line-probe/batch.json', request)
    module('align-hayai-glyphs').run(chapter, chapter / 'line-probe', assets, chapter / 'aligned-glyphs', [])
    hayai(chapter / 'aligned-glyphs/batch.json', request)
    module('group-verified-glyphs').run(chapter, chapter / 'aligned-glyphs', chapter / 'verified-glyphs')
    module('refine-line-supported-glyphs').run(chapter, chapter / 'aligned-glyphs', chapter / 'verified-glyphs', chapter / 'line-supported')
    supported = recover_source_evidence(chapter, assets, request)
    module('group-source-metric').run(chapter, supported, assets / 'source-metric', chapter / 'source-groups-s5')
    module('pool-source-groups').run(chapter / 'source-groups-s5', supported, chapter / 'source-groups-s6')
    prediction = chapter / 'source-region-predictions.json'
    module('infer-source-region-chapter').run(chapter, assets / 'source-region', prediction, None)
    module('assign-coherent-source-palette').run(chapter, prediction, chapter / 'source-groups-s6/groups.json', supported, chapter / 'selected')
    return {'choices': read(chapter / 'selected/choices.json')['choices'], 'version': manifest['version'], 'output': str(chapter)}


def recover_source_evidence(chapter, assets, request):
    supported = chapter / 'line-supported'
    zero_keys = {b['key'] for b in read(supported / 'analysis.json')['blocks'] if not b['glyphs']}
    if not zero_keys:
        return supported
    recovery = chapter / 'recovery'
    module('prepare-line-probe').build(chapter, recovery / 'line-probe', only_keys=zero_keys, dark_core=True)
    hayai(recovery / 'line-probe/batch.json', request)
    module('align-hayai-glyphs').run(chapter, recovery / 'line-probe', assets, recovery / 'aligned', [])
    hayai(recovery / 'aligned/batch.json', request)
    module('group-verified-glyphs').run(chapter, recovery / 'aligned', recovery / 'verified')
    module('recover-zero-glyph-evidence').run(chapter, recovery / 'aligned', recovery / 'verified', recovery / 'line-supported')
    return recovery / 'line-supported'


def serve():
    for line in sys.stdin:
        command = json.loads(line)
        if command.get('type') == 'shutdown':
            return
        started = time.perf_counter()
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = execute(read(command['request']))
            response = {'id': command['id'], 'ok': True, 'result': result}
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            response = {'id': command['id'], 'ok': False, 'error': str(error)}
        response['elapsed_ms'] = round((time.perf_counter() - started) * 1000)
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    serve()
