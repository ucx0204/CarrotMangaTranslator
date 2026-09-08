"""Package the approved model bytes and platform dependencies without retraining.

The original owned pack is read-only. Each ZIP has the exact runtime paths at its
root; ownership binds the shipped algorithms, fonts, models and Python inventory.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text('utf-8-sig'))


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def record(name, data):
    return {'path': name, 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def source_bytes(root, row):
    path = root / row['path']
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Unsafe source path: ' + row['path'])
    data = path.read_bytes()
    if record(row['path'], data) != row:
        raise ValueError('Source binding changed: ' + row['path'])
    return data


def licenses(source, manifest, roots):
    source_manifest = read(source / manifest['files'][0]['path'])
    used = {r['path'] for r in manifest['files']}
    result = {}
    for row in source_manifest['sources']:
        if row['font_file'] not in used:
            continue
        license = row['license']
        name = license['text_file']
        path = next((root / name for root in roots if (root / name).is_file()), None)
        if path is None:
            raise ValueError('Missing font license: ' + name)
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != license['text_sha256']:
            raise ValueError('Font license binding changed: ' + name)
        result[name] = data
    return result


def mac_dependencies(wheels):
    files = {}
    receipts = []
    for wheel in sorted(wheels.glob('*.whl')):
        receipts.append(record(wheel.name, wheel.read_bytes()))
        with zipfile.ZipFile(wheel) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                name = info.filename
                if name.startswith('/') or '..' in Path(name).parts or '\\' in name:
                    raise ValueError('Unsafe wheel entry')
                if '.data/' in name:
                    prefix, rest = name.split('.data/', 1)
                    scheme, relative = rest.split('/', 1)
                    if scheme not in ('purelib', 'platlib'):
                        continue
                    name = relative
                key = 'python-packages/' + name
                if key in files:
                    raise ValueError('Overlapping wheel entry: ' + key)
                files[key] = archive.read(info)
    if len(receipts) != 8:
        raise ValueError('Expected eight pinned dependency wheels')
    return files, receipts


def runtime_dependency(name):
    parts = Path(name).parts
    return (not any(part in ('tests', 'test', '__pycache__') for part in parts)
            and not name.endswith(('.pyc', '.pyo'))
            and not name.startswith(('python-packages/bin/', 'python-packages/share/')))


def package(output, name, files):
    archive_path = output / name
    with zipfile.ZipFile(archive_path, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for key, data in sorted(files.items()):
            info = zipfile.ZipInfo(key, (2026, 9, 9, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    # Verify the actual archive, not only the input directory.
    with zipfile.ZipFile(archive_path) as archive:
        if archive.namelist() != sorted(files):
            raise ValueError('Archive inventory mismatch')
        for key, data in files.items():
            if archive.read(key) != data:
                raise ValueError('Archive bytes mismatch: ' + key)
            info = archive.getinfo(key)
            if info.file_size > 0 and info.file_size / max(1, info.compress_size) > 100:
                raise ValueError('Archive exceeds the application compression ratio: ' + key)
    return record(name, archive_path.read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--license-root', type=Path, required=True)
    parser.add_argument('--mac-wheels', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('local_pack', ROOT / 'scripts/install-font-chapter-c18-local.py')
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    original = read(args.source / 'ownership.json')
    validator.verify(args.source, original)
    current = read(ROOT / 'src/main/pipeline/fontChapterC18Manifest.json')
    if current['files'] != original['files'] or current['version'] != original['version']:
        raise ValueError('The approved training assets changed')
    for row in current['runtimeSources']:
        data = (ROOT / 'src/main/runtime/font-chapter-c18' / row['path']).read_bytes()
        if hashlib.sha256(data).hexdigest() != row['sha256']:
            raise ValueError('Packaged algorithm binding changed')
    license_data = licenses(args.source, current, [ROOT, args.license_root])
    license_rows = [record(k, v) for k, v in sorted(license_data.items())]
    common = {r['path']: source_bytes(args.source, r) for r in current['files'] if r['path'] != 'python-inventory.json'}
    common.update(license_data)
    descriptor = {'tag': args.tag, 'assetRoot': 'models/fc23-r2',
                  'licenseFiles': license_rows, 'platforms': {}}
    inventories = {}
    for platform in ('win32-x64', 'darwin-arm64'):
        if platform == 'win32-x64':
            rows = read(args.source / 'python-inventory.json')['files']
            deps = {r['path']: source_bytes(args.source, r) for r in rows}
        else:
            deps, wheels = mac_dependencies(args.mac_wheels)
            (args.output / 'mac-wheels.json').write_bytes(encoded(wheels))
        deps = {name: data for name, data in deps.items() if runtime_dependency(name)}
        inventory_data = encoded({'files': [record(k, v) for k, v in sorted(deps.items())]})
        inventory = record('python-inventory.json', inventory_data)
        owned = {**current, 'assetDirectory': descriptor['assetRoot'] + '/' + platform,
                 'files': [r for r in current['files'] if r['path'] != 'python-inventory.json'] + license_rows + [inventory]}
        files = {**common, **deps, 'python-inventory.json': inventory_data, 'ownership.json': encoded(owned)}
        archive = package(args.output, 'font-chapter-c23-' + platform + '.zip', files)
        descriptor['platforms'][platform] = {'archive': archive, 'pythonInventory': inventory}
        inventories[platform] = [record(k, v) for k, v in sorted(files.items())]
        print(json.dumps({'platform': platform, 'archive': archive, 'files': len(files)}), flush=True)
    (args.output / 'release-manifest.json').write_bytes(encoded(descriptor))
    (args.output / 'archive-inventories.json').write_bytes(encoded(inventories))
    (args.output / 'producer-binding.json').write_bytes(encoded({
        'originalOwnership': record('ownership.json', (args.source / 'ownership.json').read_bytes()),
        'currentManifest': record('fontChapterC18Manifest.json', (ROOT / 'src/main/pipeline/fontChapterC18Manifest.json').read_bytes()),
        'modelFilesUnchanged': True, 'runtimeSources': current['runtimeSources']}))


if __name__ == '__main__':
    main()
