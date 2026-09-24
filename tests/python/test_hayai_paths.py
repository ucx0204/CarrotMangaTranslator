"""Exercise the real Hayai file pipeline without downloading model packages."""
from __future__ import annotations

import argparse
import ast
from contextlib import redirect_stdout
from io import StringIO
import json
import ntpath
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "src/main/runtime/hayai-bboxes.py"


def load_file_pipeline():
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    functions = {
        "main", "parse_args", "runtime_path", "read_batch_items",
        "normalize_batch_item", "read_json", "emit_progress", "process_page",
        "require_regions",
    }
    nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
    nodes.extend(node for node in tree.body if (
        isinstance(node, ast.FunctionDef) and node.name in functions
    ) or isinstance(node, ast.Assign))
    namespace = dict(argparse=argparse, json=json, os=os, Path=Path)
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(SCRIPT), "exec"), namespace)
    return namespace


def fixture_path(path):
    """Create fixtures independently of production path conversion."""
    return Path("\\\\?\\" + str(path)) if os.name == "nt" else path


class ImageFile:
    """Image decoder boundary: require the actual file to be readable."""
    size = (10, 20)
    width, height = size

    def __init__(self, path):
        if Path(path).read_bytes() != b"fixture-image":
            raise ValueError("Invalid test image")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def convert(self, _mode):
        return self


class HayaiPathsTest(unittest.TestCase):
    def setUp(self):
        self.runtime = load_file_pipeline()

    def test_windows_drive_unc_and_existing_namespace(self):
        windows = SimpleNamespace(name="nt", path=ntpath)
        with patch.dict(self.runtime, os=windows):
            convert = self.runtime["runtime_path"]
            suffix = "\\".join(["원문 space" * 8] * 5)
            drive = "C:\\library\\" + suffix + "\\batch.json"
            unc = "\\\\server\\share\\" + suffix + "\\batch.json"
            self.assertEqual(str(convert(drive)), "\\\\?\\" + drive)
            self.assertEqual(str(convert(unc)), "\\\\?\\UNC\\" + unc[2:])
            self.assertEqual(str(convert("\\\\?\\" + drive)), "\\\\?\\" + drive)
            self.assertEqual(str(convert("batch.json")), "batch.json")
            boundary = "C:\\" + "a" * 244
            self.assertEqual(str(convert(boundary)), boundary)
            self.assertEqual(str(convert(boundary + "a")), "\\\\?\\" + boundary + "a")
            forward = drive.replace("\\", "/").replace("/batch.json", "/../batch.json")
            self.assertEqual(str(convert(forward)), "\\\\?\\" + ntpath.abspath(forward))

    def test_posix_paths_are_preserved(self):
        with patch.dict(self.runtime, os=SimpleNamespace(name="posix")):
            path = "/tmp/" + "/".join(["source" * 20] * 3) + "/batch.json"
            self.assertEqual(self.runtime["runtime_path"](path), Path(path))

    def test_long_relative_windows_path_is_made_absolute(self):
        long_root = "C:\\" + "\\".join(["workspace" * 9] * 4)
        windows = SimpleNamespace(name="nt", path=SimpleNamespace(abspath=lambda value: ntpath.join(long_root, value)))
        with patch.dict(self.runtime, os=windows):
            self.assertEqual(str(self.runtime["runtime_path"]("batch.json")), "\\\\?\\" + long_root + "\\batch.json")

    def test_missing_and_invalid_manifests_still_fail(self):
        with tempfile.TemporaryDirectory(prefix="hayai-errors-") as root:
            path = Path(root) / "batch.json"
            args = argparse.Namespace(batch=str(path))
            with self.assertRaises(FileNotFoundError):
                self.runtime["read_batch_items"](args)
            path.write_text('{"items": []}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "contains no items"):
                self.runtime["read_batch_items"](args)
            path.write_text('{"items": [{"image": "page.png"}]}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "requires image, regions, and output"):
                self.runtime["read_batch_items"](args)

    def test_batch_and_single_page_read_and_write_long_paths(self):
        # Includes all five path boundaries: batch, image, regions, output, progress.
        temporary = tempfile.TemporaryDirectory(prefix="hayai-paths-")
        with temporary as root:
            # Cleanup must also work in the deliberately non-long-path-aware
            # Python smoke process; test input paths themselves stay ordinary.
            temporary.name = str(fixture_path(Path(root)))
            directory = Path(root).joinpath(*(["원문 space-" + "a" * 60] * 4))
            fixture_path(directory).mkdir(parents=True)
            image = directory / "block-1.png"
            regions = directory / "hayai-regions.json"
            output = directory / "new-output" / "ocr-bbox-hints.json"
            batch = directory / "ocr-batch.json"
            fixture_path(image).write_bytes(b"fixture-image")
            fixture_path(regions).write_text(json.dumps({
                "schemaVersion": self.runtime["REGION_SCHEMA"],
                "width": 10, "height": 20,
                "dialogueRegions": [], "effectRegions": [],
            }), encoding="utf-8")
            fixture_path(batch).write_text(json.dumps({"items": [{
                "image": str(image), "regions": str(regions), "output": str(output),
            }]}), encoding="utf-8")
            for mode in ("batch", "single"):
                with self.subTest(mode=mode):
                    progress = directory / "new-progress" / (mode + ".jsonl")
                    argv = [str(SCRIPT), "--progress", str(progress)]
                    argv += ["--batch", str(batch)] if mode == "batch" else [
                        "--image", str(image), "--regions", str(regions), "--output", str(output),
                    ]
                    # Only the heavyweight model/decoder boundaries are replaced.
                    with patch.dict(self.runtime, {
                        "load_runtime": lambda _args: (None, None, None, None),
                        "release_gpu_memory": lambda: None,
                        "Image": SimpleNamespace(open=ImageFile),
                        "ImageOps": SimpleNamespace(exif_transpose=lambda image: image),
                    }), patch("sys.argv", argv), redirect_stdout(StringIO()):
                        self.assertEqual(self.runtime["main"](), 0)
                    payload = json.loads(fixture_path(output).read_text(encoding="utf-8"))
                    self.assertEqual(payload["schemaVersion"], self.runtime["OUTPUT_SCHEMA"])
                    self.assertEqual(payload["items"], [])
                    events = [json.loads(line) for line in fixture_path(progress).read_text(encoding="utf-8").splitlines()]
                    self.assertEqual([event["phase"] for event in events], ["start", "done"])


if __name__ == "__main__":
    unittest.main()
