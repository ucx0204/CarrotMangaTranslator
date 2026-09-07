"""S3 research: align known Hayai text to pixels using character shape evidence.

Reference fonts supply character shapes, not source font labels. All previous
analysis outputs remain immutable. Glyphs must subsequently pass Hayai checking
before they may contribute to a source-source style group.
"""

import argparse
import hashlib
import importlib.util
import json
import math
import re
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

spec = importlib.util.spec_from_file_location("reference_helpers", Path(__file__).with_name("japanese-probe-profile.py"))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)
helpers = reference.helpers

POLICY = {
    "id": "hayai-text-shaped-cut-lattice-v1",
    "scope": "source_extraction_research_not_font_choice",
    "sourceOcr": "existing pinned Hayai line OCR",
    "referenceAuthority": "training-only OFL pack as a character shape transform",
    "cuts": "centers of zero-ink runs plus centers of runs below 0.08 of maximum projection",
    "minimumExtentScale": 0.10,
    "maximumExtentScale": 2.6,
    "styleCharacterMinimumExtentScale": 0.22,
    "boundaryPenalty": 0.12,
    "extentPriorWeight": 0.04,
    "shapeDistance": "minimum over available fonts and 1px shifts of normalized L1 ink distance",
    "compoundTokens": "vertical consecutive ASCII !/? pairs may occupy one cell",
    "requireLaterGlyphHayaiAgreement": True,
    "manualLabelsRead": False,
    "fontChoicesMade": False,
}


class CharacterBank:
    def __init__(self, asset_root):
        manifest_path = asset_root / "artifacts/manga-font-glyphvoice-ofl-source-pack-v2/source-manifest.json"
        manifest = helpers.read_json(manifest_path)
        self.manifest_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        self.fonts, self.cache, self.inventory = [], {}, []
        for row in manifest["sources"]:
            if row.get("locale_hint") not in {"ja", "bridge_candidate"}:
                continue
            path = asset_root / row["font_file"]
            if not row["license"]["training_allowed"] or hashlib.sha256(path.read_bytes()).hexdigest() != row["font_sha256"]:
                raise ValueError("Unverified reference font")
            with TTFont(path, fontNumber=row["face_index"]) as table:
                cmap = table.getBestCmap() or {}
            self.fonts.append((ImageFont.truetype(str(path), 64, index=row["face_index"]), cmap))
            self.inventory.append({"id": row["source_id"], "sha256": row["font_sha256"]})
        self.device = torch.device("cpu")

    def get(self, token, direction):
        key = (token, direction)
        if key in self.cache:
            return self.cache[key]
        tensors, seen = [], set()
        for font, cmap in self.fonts:
            if not all(ord(c) in cmap and cmap[ord(c)] != ".notdef" for c in token):
                continue
            tensor = reference.render_glyph(font, token)
            variants = [tensor]
            if direction == "vertical" and len(token) == 1 and not helpers.is_style_character(token):
                variants.append(np.rot90(tensor).copy())
            for value in variants:
                digest = hashlib.sha256(value.tobytes()).hexdigest()
                if digest not in seen:
                    seen.add(digest)
                    tensors.append(value)
        result = torch.as_tensor(np.stack(tensors), device=self.device) if tensors else None
        self.cache[key] = result
        return result

    def distances(self, queries, token, direction):
        bank = self.get(token, direction)
        if bank is None:
            return np.full(len(queries), 0.8, dtype=np.float32)
        values = []
        with torch.inference_mode():
            for offset in range(0, len(queries), 48):
                batch = torch.as_tensor(np.stack(queries[offset:offset + 48]), device=self.device)
                denominator = (batch.sum(dim=(1, 2))[:, None] + bank.sum(dim=(1, 2))[None]).clamp_min(1)
                best = torch.ones(len(batch), device=self.device)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        shifted = torch.roll(bank, (dy, dx), (1, 2))
                        distance = (batch[:, None] - shifted[None]).abs().sum(dim=(2, 3)) / denominator
                        best = torch.minimum(best, distance.amin(dim=1))
                values.extend(best.cpu().tolist())
        return np.asarray(values)


def cut_positions(profile):
    candidates = {0, len(profile)}
    maximum = max(1, float(profile.max()))
    for fraction in (0, 0.08):
        active = profile <= maximum * fraction
        boundaries = np.flatnonzero(np.diff(np.pad(active.astype(np.int8), (1, 1))))
        for start, end in zip(boundaries[::2], boundaries[1::2]):
            candidates.add(round((int(start) + int(end)) / 2))
    return sorted(candidates)


def token_options(text, index, direction):
    values = [text[index]]
    if direction == "vertical" and index + 1 < len(text) and all(c in "!?" for c in text[index:index + 2]):
        values.append(text[index:index + 2])
    return values


def align_line(image, line, text, direction, scale, bank):
    text = helpers.normalize(text)
    box = list(map(int, line["bbox"]))
    gray = np.asarray(image.crop(box).convert("L"))
    _, mask = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if mask.mean() > 0.5:
        mask = 1 - mask
    oriented = mask if direction == "vertical" else mask.T
    profile = oriented.sum(axis=1)
    cuts = cut_positions(profile)
    maximum = max(1, float(profile.max()))
    segments, lookup, queries = [], {}, []
    for left, start in enumerate(cuts):
        for right in range(left + 1, len(cuts)):
            end = cuts[right]
            if not max(2, scale * 0.1) <= end - start <= scale * 2.6:
                continue
            part = oriented[start:end]
            if not np.any(part):
                continue
            tensor = helpers.canonical(part if direction == "vertical" else part.T)
            lookup[(left, right)] = len(segments)
            segments.append((left, right, start, end))
            queries.append(tensor)
    if not queries or not text:
        return {"status": "no_segments", "glyphs": []}
    tokens = sorted({token for i in range(len(text)) for token in token_options(text, i, direction)})
    costs = {token: bank.distances(queries, token, direction) for token in tokens}
    states = {(0, 0): (0.0, [])}
    for index in range(len(text)):
        for left in range(len(cuts) - 1):
            previous = states.get((index, left))
            if previous is None:
                continue
            for token in token_options(text, index, direction):
                for right in range(left + 1, len(cuts)):
                    slot = lookup.get((left, right))
                    if slot is None:
                        continue
                    _, _, start, end = segments[slot]
                    if helpers.is_style_character(token[0]) and end - start < scale * 0.22:
                        continue
                    boundary = 0 if right == len(cuts) - 1 else float(profile[max(0, end - 1):end + 1].mean()) / maximum
                    extent_prior = 0.04 * (math.log(max(0.1, (end - start) / scale))) ** 2
                    shape_cost = float(costs[token][slot])
                    cost = previous[0] + (shape_cost + extent_prior + 0.12 * boundary) * len(token)
                    state = (index + len(token), right)
                    if state not in states or cost < states[state][0]:
                        record = {"token": token, "characterIndex": index, "start": start, "end": end, "shapeDistance": shape_cost}
                        states[state] = (cost, previous[1] + [record])
    complete = states.get((len(text), len(cuts) - 1))
    if complete is None:
        return {"status": "no_complete_alignment", "glyphs": [], "cutCount": len(cuts)}
    glyphs = []
    for record in complete[1]:
        start, end = record["start"], record["end"]
        rect = [box[0], box[1] + start, box[2], box[1] + end] if direction == "vertical" else [box[0] + start, box[1], box[0] + end, box[3]]
        glyphs.append({**record, "bbox": rect, "lineId": line["id"], "isStyleCharacter": len(record["token"]) == 1 and helpers.is_style_character(record["token"])})
    return {"status": "aligned_pending_glyph_ocr", "glyphs": glyphs, "cutCount": len(cuts), "shapeCostPerCharacter": complete[0] / len(text)}


def run(chapter, probe, asset_root, output, keys):
    output.mkdir(parents=True, exist_ok=False)
    start_time = time.perf_counter()
    bank = CharacterBank(asset_root)
    mapping = helpers.read_json(probe / "line-map.json")
    baseline = helpers.read_json(chapter / "ocr-baseline/baseline-report.json")
    pages = {}
    candidates = {}
    for page in baseline["pages"]:
        path = chapter / "ocr-baseline" / page["ocrImagePath"] if page.get("ocrImagePath") else Path(page["imagePath"])
        pages[page["pageId"]] = Image.open(path).convert("RGB")
        candidates.update({page["pageId"] + "/" + c["candidateId"]: c for c in page["candidates"]})
    records, tiles = [], []
    for block in mapping["blocks"]:
        if keys and block["key"] not in keys:
            continue
        pid = block["key"].split("/")[0]
        ocr_path = probe / (pid + "-hayai.json")
        ocr = {r["id"]: r["ocrText"] for r in helpers.read_json(ocr_path)["items"]} if ocr_path.exists() else {}
        estimate = candidates[block["key"]].get("estimate") or {}
        scale = float(estimate.get("facePx") or block.get("sourceScaleHint") or 0)
        lines = []
        for line in block["lines"] if scale >= 6 else []:
            text = ocr.get(line["id"], "")
            result = align_line(pages[pid], line, text, block["direction"], scale, bank)
            for glyph in result["glyphs"]:
                if not glyph["isStyleCharacter"]:
                    continue
                glyph["verificationId"] = len(tiles) + 1
                crop = pages[pid].crop(glyph["bbox"])
                tile = Image.new("RGB", (128, 128), "white")
                factor = 104 / max(crop.size)
                scaled = crop.resize((max(1, round(crop.width * factor)), max(1, round(crop.height * factor))), Image.Resampling.LANCZOS)
                tile.paste(scaled, ((128 - scaled.width) // 2, (128 - scaled.height) // 2))
                tiles.append(tile)
            lines.append({"lineId": line["id"], "bbox": line["bbox"], "text": text, **result})
        record = {"key": block["key"], "sourceText": block["sourceText"], "direction": block["direction"], "scaleHint": scale, "lines": lines}
        records.append(record)
        print(json.dumps({"block": block["key"], "lines": len(lines), "complete": sum(l["status"] == "aligned_pending_glyph_ocr" for l in lines)}), flush=True)
    batches = []
    for offset in range(0, len(tiles), 128):
        page_tiles = tiles[offset:offset + 128]
        atlas = Image.new("RGB", (8 * 128, math.ceil(len(page_tiles) / 8) * 128), "white")
        regions = []
        name = f"glyph-atlas-{offset // 128 + 1:03d}"
        for index, tile in enumerate(page_tiles):
            x, y = (index % 8) * 128, (index // 8) * 128
            atlas.paste(tile, (x, y))
            regions.append({"id": offset + index + 1, "regionId": str(offset + index + 1), "kind": "dialogue", "bbox": [x, y, x + 128, y + 128], "sourceDetectionIds": [], "detectorConfidence": 0})
        atlas.save(output / (name + ".png"))
        (output / (name + "-regions.json")).write_text(json.dumps({"schemaVersion": "hayai-dialogue-effect-separated-v1", "width": atlas.width, "height": atlas.height, "dialogueRegions": regions, "effectRegions": []}), encoding="utf-8")
        batches.append({"image": str(output / (name + ".png")), "regions": str(output / (name + "-regions.json")), "output": str(output / (name + "-hayai.json"))})
    elapsed = time.perf_counter() - start_time
    result = {"policy": POLICY, "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "sourceMapSha256": hashlib.sha256((probe / "line-map.json").read_bytes()).hexdigest(), "referenceManifestSha256": bank.manifest_sha, "referenceFonts": bank.inventory, "selectedKeys": keys, "records": records, "glyphsPendingVerification": len(tiles), "alignmentWallSeconds": elapsed}
    (output / "alignment.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "batch.json").write_text(json.dumps({"items": batches}, indent=2), encoding="utf-8")
    print(json.dumps({"records": len(records), "glyphsPendingVerification": len(tiles), "alignmentWallSeconds": elapsed}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("chapter", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("asset_root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--keys", nargs="*", default=[])
    args = parser.parse_args()
    run(args.chapter.resolve(), args.probe.resolve(), args.asset_root.resolve(), args.output.resolve(), args.keys)
