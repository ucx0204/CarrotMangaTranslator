"""Source-only diagnostic: align Hayai characters and compare identical glyphs.

This is not font-selection gold and does not read the visual reference labels.
It leaves blocks without reliable, overlapping characters unassigned.
"""
import argparse
import hashlib
import itertools
import json
import math
import re
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


POLICY = {
    "id": "same-glyph-observed-complete-link-v1",
    "stage": "source_group_diagnostic_only",
    "ocr": "pinned_hayai_v2_line_probe",
    "requireWholeRegionTextAgreement": True,
    "minimumDistinctSharedCharacters": 2,
    "minimumGlyphsPerBlock": 4,
    "threshold": "90th percentile of within-block repeated-character distances",
    "minimumSelfPairs": 12,
    "distance": "median per-character best-shift normalized absolute ink difference",
    "shiftPixels": [-1, 0, 1],
    "merge": "all observed cross-group pairs must pass; every member needs a passing cross-group neighbor",
    "manualLabelsRead": False,
    "fontChoiceMade": False,
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def normalize(text):
    # Hayai normalizes an ellipsis to three ASCII periods; restore its one-cell
    # representation for alignment without changing the frozen translation.
    return re.sub(r"\s+", "", re.sub(r"\.{3}", "…", unicodedata.normalize("NFC", text)))


def is_style_character(char):
    return "\u3041" <= char <= "\u30fa" or "\u4e00" <= char <= "\u9fff"


def boundaries(mask, count):
    length = mask.shape[0]
    if count < 1 or length < count * 3:
        return None
    pitch = length / count
    profile = mask.sum(axis=1).astype(float)
    maximum = max(1, float(profile.max()))
    states = {0: (0.0, [0])}
    for i in range(1, count + 1):
        targets = [length] if i == count else range(max(i * 3, round((i - 0.38) * pitch)), min(length - (count - i) * 3, round((i + 0.38) * pitch)) + 1)
        following = {}
        for end in targets:
            cut = 0 if end == length else (profile[end - 1] + profile[end]) / (2 * maximum)
            choices = [(cost + cut + 0.2 * ((end - start) / pitch - 1) ** 2, prior + [end])
                       for start, (cost, prior) in states.items() if end - start >= max(3, pitch * 0.45)]
            if choices:
                following[end] = min(choices, key=lambda row: row[0])
        states = following
    return states.get(length, (None, None))[1]


def canonical(mask):
    positions = np.argwhere(mask)
    if not len(positions):
        return None
    y1, x1 = positions.min(axis=0)
    y2, x2 = positions.max(axis=0) + 1
    cropped = mask[y1:y2, x1:x2].astype(np.float32)
    scale = 48 / max(cropped.shape)
    width, height = max(1, round(cropped.shape[1] * scale)), max(1, round(cropped.shape[0] * scale))
    scaled = cv2.resize(cropped, (width, height), interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros((64, 64), dtype=np.float32)
    top, left = (64 - height) // 2, (64 - width) // 2
    canvas[top:top + height, left:left + width] = scaled
    return cv2.GaussianBlur(canvas, (3, 3), 0.5)


def glyph_distance(left, right):
    denominator = max(1, float(left.sum() + right.sum()))
    return min(float(np.abs(left - np.roll(right, (dy, dx), axis=(0, 1))).sum()) / denominator
               for dy in POLICY["shiftPixels"] for dx in POLICY["shiftPixels"])


def extract_line(image, line, text, direction):
    chars = list(normalize(text))
    box = list(map(int, line["bbox"]))
    crop = np.array(image.crop(box).convert("L"))
    _, mask = cv2.threshold(crop, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if mask.mean() > 0.5:
        mask = 1 - mask
    oriented = mask if direction == "vertical" else mask.T
    cuts = boundaries(oriented, len(chars))
    if cuts is None:
        return []
    profile = oriented.sum(axis=1)
    maximum = max(1, int(profile.max()))
    output = []
    for index, char in enumerate(chars):
        if not is_style_character(char):
            continue
        start, end = cuts[index:index + 2]
        boundary_ink = max((profile[start - 1] + profile[start]) / (2 * maximum) if start else 0,
                           (profile[end - 1] + profile[end]) / (2 * maximum) if end < len(profile) else 0)
        if boundary_ink > 0.25:
            continue
        part = oriented[start:end]
        if not 0.025 <= part.mean() <= 0.6:
            continue
        tensor = canonical(part if direction == "vertical" else part.T)
        if tensor is not None:
            glyph_box = [box[0], box[1] + start, box[2], box[1] + end] if direction == "vertical" else [box[0] + start, box[1], box[0] + end, box[3]]
            output.append({"character": char, "lineId": line["id"], "characterIndex": index,
                           "bbox": glyph_box, "tensor": tensor})
    return output


def pair_evidence(left, right):
    common = sorted(set(left) & set(right))
    evidence = []
    for char in common:
        matches = [(glyph_distance(a["tensor"], b["tensor"]), a, b) for a in left[char] for b in right[char]]
        matches.sort(key=lambda row: row[0])
        distance = float(np.median([m[0] for m in matches]))
        representative = min(matches, key=lambda m: abs(m[0] - distance))
        evidence.append({"character": char, "distance": distance,
                         "leftGlyph": representative[1]["image"], "rightGlyph": representative[2]["image"]})
    return {"commonCount": len(common), "distance": float(np.median([e["distance"] for e in evidence])) if evidence else None,
            "evidence": evidence}


def group_blocks(blocks, pairs, cutoff):
    groups = [{b["key"]} for b in blocks if b["usable"]]
    lookup = {tuple(sorted((p["left"], p["right"]))): p for p in pairs if p["commonCount"] >= 2}
    def passes(a, b):
        pair = lookup.get(tuple(sorted((a, b))))
        return pair is not None and pair["distance"] <= cutoff
    for edge in sorted(lookup.values(), key=lambda p: (p["distance"], p["left"], p["right"])):
        if edge["distance"] > cutoff:
            break
        left = next(g for g in groups if edge["left"] in g)
        right = next(g for g in groups if edge["right"] in g)
        if left is right:
            continue
        observed = [lookup.get(tuple(sorted((a, b)))) for a in left for b in right]
        if any(p is not None and p["distance"] > cutoff for p in observed):
            continue
        if not all(any(passes(a, b) for b in right) for a in left):
            continue
        if not all(any(passes(a, b) for a in left) for b in right):
            continue
        groups.remove(left)
        groups.remove(right)
        groups.append(left | right)
    return [{"id": "S-" + hashlib.sha256("|".join(sorted(g)).encode()).hexdigest()[:8], "members": sorted(g)}
            for g in sorted(groups, key=lambda g: (-len(g), sorted(g)))]


def run(chapter, probe, output):
    output.mkdir(parents=True, exist_ok=False)
    (output / "glyphs").mkdir()
    mapping = read_json(probe / "line-map.json")
    report = read_json(chapter / "ocr-baseline/baseline-report.json")
    pages = {p["pageId"]: Image.open(chapter / "ocr-baseline" / p["ocrImagePath"]).convert("RGB") for p in report["pages"]}
    ocr = {p.stem[:4]: {r["id"]: r["ocrText"] for r in read_json(p)["items"]} for p in probe.glob("P*-hayai.json")}
    blocks, tensors = [], {}
    self_pairs = []
    for block in mapping["blocks"]:
        key, pid = block["key"], block["key"].split("/")[0]
        lines = [(line, ocr.get(pid, {}).get(line["id"], "")) for line in block["lines"]]
        agreement = normalize("".join(t for _, t in lines)) == normalize(block["sourceText"])
        glyphs = [g for line, text in lines for g in extract_line(pages[pid], line, text, block["direction"])] if agreement else []
        by_char = {}
        for i, glyph in enumerate(glyphs):
            name = f"glyphs/{key.replace('/', '-')}-{i:03d}-U{ord(glyph['character']):04X}.png"
            glyph["image"] = name
            Image.fromarray((255 * (1 - glyph["tensor"])).round().astype(np.uint8)).save(output / name)
            by_char.setdefault(glyph["character"], []).append(glyph)
        for char, matches in by_char.items():
            for a, b in itertools.combinations(matches, 2):
                self_pairs.append({"key": key, "character": char, "distance": glyph_distance(a["tensor"], b["tensor"]),
                                   "leftGlyph": a["image"], "rightGlyph": b["image"]})
        usable = len(glyphs) >= POLICY["minimumGlyphsPerBlock"]
        blocks.append({"key": key, "sourceText": block["sourceText"], "textAgreement": agreement,
                       "usable": usable, "glyphs": [{k: v for k, v in g.items() if k != "tensor"} for g in glyphs]})
        if usable:
            tensors[key] = by_char
    pairs = [{"left": a, "right": b, **pair_evidence(tensors[a], tensors[b])} for a, b in itertools.combinations(sorted(tensors), 2)]
    cutoff = float(np.percentile([p["distance"] for p in self_pairs], 90)) if len(self_pairs) >= 12 else None
    groups = group_blocks(blocks, pairs, cutoff) if cutoff is not None else []
    summary = {"sourceBlocks": len(blocks), "exactOcrAgreement": sum(b["textAgreement"] for b in blocks),
               "usableBlocks": len(tensors), "glyphs": sum(len(b["glyphs"]) for b in blocks), "selfPairs": len(self_pairs),
               "cutoff": cutoff, "groups": len(groups), "repeatedGroups": sum(len(g["members"]) > 1 for g in groups),
               "groupedBlocks": sum(len(g["members"]) for g in groups if len(g["members"]) > 1)}
    payload = {"policy": POLICY, "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "probeMapSha256": hashlib.sha256((probe / "line-map.json").read_bytes()).hexdigest(),
               "summary": summary, "blocks": blocks, "groups": groups, "pairs": pairs, "selfPairs": self_pairs}
    (output / "analysis.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("chapter", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    run(args.chapter.resolve(), args.probe.resolve(), args.output.resolve())
