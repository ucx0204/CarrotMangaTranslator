"""Prepare an OCR-only diagnostic of source lines; never changes product output.

Input is the frozen Hayai baseline. No visual reference labels or Korean font
decisions are read. Reuse source-size estimates only as a physical scale hint.
"""
import argparse
import hashlib
import json
import math
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import binary_closing


POLICY = {
    "id": "line-projection-hayai-probe-v1",
    "purpose": "diagnostic_only_not_a_product_font_candidate",
    "closingGapFaceRatio": 0.12,
    "minimumLineWidthFaceRatio": 0.4,
    "maximumLineWidthFaceRatio": 1.8,
    "minimumLineLengthFaceRatio": 1.5,
    "minimumOccupiedRowsFaceRatio": 0.8,
    "maximumLines": 8,
    "labelsRead": False,
    "translationsModified": False,
}


def runs(active):
    padded = np.pad(active.astype(np.int8), (1, 1))
    changes = np.diff(padded)
    return list(zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1)))


def source_lines(image, candidate):
    box = candidate["bbox"]
    left, top = max(0, math.floor(box["x1"])), max(0, math.floor(box["y1"]))
    right, bottom = min(image.width, math.ceil(box["x2"])), min(image.height, math.ceil(box["y2"]))
    face = float((candidate.get("estimate") or {}).get("facePx") or 0)
    if face < 6 or right <= left or bottom <= top:
        return [], "insufficient_scale"
    gray = np.array(image.crop((left, top, right, bottom)).convert("L"))
    _, mask = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if mask.mean() > 0.5:
        mask = 1 - mask
    vertical = candidate["direction"] == "vertical"
    oriented = mask if vertical else mask.T
    # Require repeated occupied positions so a small ruby or isolated artifact
    # does not become a full dialogue line. No expected OCR line count is used.
    active = oriented.sum(axis=0) >= max(2, face * 0.25)
    gap = max(1, round(face * POLICY["closingGapFaceRatio"]))
    # Pad before closing: scipy's default zero boundary would shave the edges.
    active = binary_closing(np.pad(active, gap), structure=np.ones(gap + 1))[gap:-gap]
    boxes = []
    rejected = 0
    for start, end in runs(active):
        if not face * 0.4 <= end - start <= face * 1.8:
            rejected += 1
            continue
        a, z = max(0, int(start) - 1), min(oriented.shape[1], int(end) + 1)
        occupied = np.flatnonzero(oriented[:, a:z].any(axis=1))
        if len(occupied) < face * 0.8 or occupied[-1] - occupied[0] + 1 < face * 1.5:
            rejected += 1
            continue
        low, high = max(0, int(occupied[0]) - 1), min(oriented.shape[0], int(occupied[-1]) + 2)
        rectangle = [left + a, top + low, left + z, top + high] if vertical else [left + low, top + a, left + high, top + z]
        boxes.append(rectangle)
    if vertical:
        boxes.reverse()
    if not 1 <= len(boxes) <= POLICY["maximumLines"]:
        return [], "no_reliable_lines"
    return boxes, "partial_geometry" if rejected else "geometry_available"


def short_box_scale(candidate):
    """A geometry-only OCR probe hint; never a product font-size estimate."""
    if float((candidate.get("estimate") or {}).get("facePx") or 0) >= 6:
        return None
    text = unicodedata.normalize("NFC", candidate["sourceText"])
    count = sum("\u3041" <= c <= "\u30fa" or "\u4e00" <= c <= "\u9fff" for c in text)
    if not 2 <= count <= 4 or candidate["direction"] not in {"vertical", "horizontal"}:
        return None
    box = candidate["bbox"]
    width, height = box["x2"] - box["x1"], box["y2"] - box["y1"]
    along, across = (height, width) if candidate["direction"] == "vertical" else (width, height)
    if across <= 0 or not 1.2 <= along / across <= 4.5:
        return None
    face = min(across, along / count)
    return face if face >= 6 else None


def build(chapter, output, repair_missing_scale=False):
    output.mkdir(parents=True, exist_ok=False)
    baseline_path = chapter / "ocr-baseline/baseline-report.json"
    report = json.loads(baseline_path.read_text(encoding="utf-8"))
    policy = {**POLICY, "id": "short-box-scale-hayai-probe-s11", "scope": "Only missing-scale blocks with 2-4 Japanese characters and compatible bbox aspect. Geometry hint proposes an OCR probe; it is not a font measurement or evidence acceptance."} if repair_missing_scale else POLICY
    manifest = {"policy": policy, "baselineSha256": hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
                "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "blocks": []}
    batches = []
    for entry in report["pages"]:
        pid = entry["pageId"]
        image_path = chapter / "ocr-baseline" / entry["ocrImagePath"] if entry.get("ocrImagePath") else Path(entry["imagePath"])
        image = Image.open(image_path).convert("RGB")
        overlay = image.copy()
        draw = ImageDraw.Draw(overlay)
        regions = []
        for candidate in entry["candidates"]:
            hint = short_box_scale(candidate) if repair_missing_scale else None
            if repair_missing_scale:
                if hint is None:
                    continue
                candidate = {**candidate, "estimate": {**(candidate.get("estimate") or {}), "facePx": hint}}
            boxes, reason = source_lines(image, candidate)
            record = {"key": pid + "/" + candidate["candidateId"], "sourceText": candidate["sourceText"],
                      "direction": candidate["direction"], "reason": reason, "lines": []}
            if hint is not None:
                record["sourceScaleHint"] = hint
                record["sourceScaleHintAuthority"] = "short bbox geometry; research OCR probe only"
            for i, box in enumerate(boxes):
                numeric_id = len(regions) + 1
                regions.append({"id": numeric_id, "regionId": f"line-{numeric_id}", "kind": "dialogue",
                                "bbox": box, "detectorConfidence": 0, "sourceDetectionIds": []})
                record["lines"].append({"id": numeric_id, "bbox": box, "ordinal": i})
                draw.rectangle(box, outline="#d12648", width=1)
            manifest["blocks"].append(record)
        if regions:
            region_path = output / f"{pid}-regions.json"
            region_path.write_text(json.dumps({"schemaVersion": "hayai-dialogue-effect-separated-v1",
                                              "width": image.width, "height": image.height,
                                              "dialogueRegions": regions, "effectRegions": []}), encoding="utf-8")
            batches.append({"image": str(image_path), "regions": str(region_path), "output": str(output / f"{pid}-hayai.json")})
        if regions or not repair_missing_scale:
            overlay.save(output / f"{pid}-lines.png")
    (output / "line-map.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "batch.json").write_text(json.dumps({"items": batches}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"pages": len(batches), "blocks": len(manifest["blocks"]),
                      "blocksWithLines": sum(bool(b["lines"]) for b in manifest["blocks"]),
                      "lines": sum(len(b["lines"]) for b in manifest["blocks"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("chapter", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--repair-missing-scale", action="store_true")
    args = parser.parse_args()
    build(args.chapter.resolve(), args.output.resolve(), args.repair_missing_scale)
