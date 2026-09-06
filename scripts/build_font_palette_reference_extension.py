"""Reproduce the Korean palette extension from unmodified licensed font files.

This renders reference glyphs; it neither trains nor relabels the sealed R33 model.
Run with --check to verify the shipped bank and nonempty-outline coverage.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import re
from pathlib import Path

import numpy as np
from fontTools.ttLib import TTFont
from train_manga_font_crossscript_proxy_v1 import KOREAN_PROXY_GLYPHS, _render_glyph

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / "src/main/pipeline/fontCatalogReferenceExtension.json"
FONT_ROOT = ROOT / "src/renderer/src/assets/fonts"


def nonempty_ranges(path: Path) -> list[list[int]]:
    with TTFont(path) as font:
        points = sorted(
            point for point, glyph in font.getBestCmap().items()
            if chr(point).isspace() or font["glyf"][glyph].numberOfContours != 0
        )
    ranges: list[list[int]] = []
    for point in points:
        if ranges and point == ranges[-1][1] + 1:
            ranges[-1][1] = point
        else:
            ranges.append([point, point])
    return ranges


def produce(original: dict) -> dict:
    faces, rows = [], []
    for face in original["faces"]:
        path = FONT_ROOT / face["file"]
        data = path.read_bytes()
        if len(data) != face["byteSize"] or hashlib.sha256(data).hexdigest() != face["sha256"]:
            raise ValueError(f"Source font identity drift: {path}")
        glyphs = np.stack([_render_glyph(path, 0, c) for c in KOREAN_PROXY_GLYPHS])
        row = np.rint(glyphs * 255).astype(np.uint8).tobytes()
        faces.append({**face, "bankByteOffset": sum(map(len, rows)),
                      "bankByteLength": len(row), "unicodeRanges": nonempty_ranges(path)})
        rows.append(row)
    bank = b"".join(rows)
    return {**original, "glyphs": "".join(KOREAN_PROXY_GLYPHS), "faces": faces,
            "bankByteSize": len(bank), "bankSha256": hashlib.sha256(bank).hexdigest(),
            "bankGzipBase64": base64.b64encode(gzip.compress(bank, mtime=0)).decode("ascii")}


def check_css_coverage(faces: list[dict]) -> None:
    css = (ROOT / "src/renderer/src/styles/fonts.css").read_text(encoding="utf-8")
    rules = re.findall(r"@font-face\s*\{([^}]+)\}", css)
    for face in faces:
        rule = next(rule for rule in rules if f'mgt-font:///{face["file"]}' in rule)
        match = re.search(r"unicode-range:\s*([^;]+);", rule)
        if not match:
            raise ValueError(f"Missing CSS coverage: {face['file']}")
        ranges = []
        for value in match[1].split(","):
            bounds = [int(part, 16) for part in value.strip().removeprefix("U+").split("-")]
            ranges.append([bounds[0], bounds[-1]])
        if ranges != face["unicodeRanges"]:
            raise ValueError(f"CSS coverage drift: {face['file']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    original = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    result = produce(original)
    check_css_coverage(result["faces"])
    if args.check:
        # Different Python/zlib versions may encode identical bytes differently.
        for record in (original, result):
            record["bankGzipBase64"] = gzip.decompress(base64.b64decode(record["bankGzipBase64"])).hex()
        if original != result:
            raise ValueError("Font reference bank or glyph coverage drift")
    else:
        ARTIFACT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"faces": len(result["faces"]), "bankSha256": result["bankSha256"],
                      "bankByteSize": result["bankByteSize"], "checked": args.check}))


if __name__ == "__main__":
    main()
