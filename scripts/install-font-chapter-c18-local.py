"""Verify or copy the exact local C18 asset pack; never rebuild or reseal it.

This Windows x64 pack uses the application's installed Hayai interpreter.
It is not a public asset downloader or a macOS package.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'src/main/pipeline/fontChapterC18Manifest.json'


def read(path):
    return json.loads(path.read_text('utf-8-sig'))


def verify_file(root, item):
    relative = Path(item['path'])
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Unsafe asset inventory path')
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Linked asset is not an owned file')
    if path.stat().st_size != item['bytes']:
        raise ValueError('Asset size mismatch: ' + str(relative))
    if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Asset digest mismatch: ' + str(relative))
    return path


def verify(root, manifest):
    if read(root / 'ownership.json') != manifest:
        raise ValueError('Asset pack ownership does not match this app')
    files = list(manifest['files'])
    for row in files:
        verify_file(root, row)
    dependencies = read(root / 'python-inventory.json')['files']
    for row in dependencies:
        verify_file(root, row)
    return files + dependencies


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--data-root', type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    manifest = read(MANIFEST)
    files = verify(source, manifest)
    target = (args.data_root.resolve() / manifest['assetDirectory']
              if args.data_root else source)
    if target != source:
        if target.exists():
            verify(target, manifest)
        else:
            target.mkdir(parents=True, exist_ok=False)
            for row in sorted(files, key=lambda row: row['path']):
                destination = target / row['path']
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(verify_file(source, row), destination)
            # Publish ownership only after all asset bytes have been copied.
            shutil.copyfile(source / 'ownership.json', target / 'ownership.json')
            verify(target, manifest)
    print(json.dumps({'version': manifest['version'], 'files': len(files),
                      'bytes': sum(row['bytes'] for row in files),
                      'target': str(target), 'verified': True}))


if __name__ == '__main__':
    main()
