"""Experimental source-style profile using same-character Japanese font probes.

The font files form a reference transform, never evaluation labels. Only source
kana are compared so the antique-kana/gothic-kanji mixture does not masquerade
as a different font. This does not select a Korean output font.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import cv2
import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

spec = importlib.util.spec_from_file_location("matched_glyph_helpers", Path(__file__).with_name("analyze-matched-glyphs.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

POLICY = {
    "id": "japanese-kana-reference-profile-v1",
    "purpose": "source_representation_diagnostic_not_korean_font_selection",
    "referenceFaces": "all verified ja and bridge_candidate faces in the existing OFL source pack",
    "referenceAuthority": "training_only_reference_transform_not_evaluation_gold",
    "query": "aligned source kana only, at least 3 distinct kana",
    "rasterPpem": 64,
    "sameCharacterDistance": "best 1px shift normalized absolute ink difference",
    "perCharacterNormalization": "subtract median over faces, divide by max(IQR,0.05)",
    "aggregation": "median repeated glyphs per character; mean over distinct characters",
    "groupingControl": "unchanged C2 PCA8/GMM diagonal BIC mechanism",
    "manualLabelsRead": False,
    "fontChoiceMade": False,
}


def render_glyph(font, character, *, binary_ink=False):
    bounds = font.getbbox(character)
    image = Image.new("L", (max(1, bounds[2] - bounds[0]) + 8, max(1, bounds[3] - bounds[1]) + 8), 0)
    ImageDraw.Draw(image).text((4 - bounds[0], 4 - bounds[1]), character, font=font, fill=255)
    ink = np.array(image, dtype=np.float32) / 255
    if binary_ink:
        # Match the source extractor before canonical scaling and Gaussian blur.
        _, ink = cv2.threshold(np.array(image), 0, 1, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if not np.any(ink > 0):
        raise ValueError("Empty reference glyph")
    return helpers.canonical(ink)


def build(asset_root, source, output):
    output.mkdir(parents=True, exist_ok=False)
    source_manifest_path = asset_root / "artifacts/manga-font-glyphvoice-ofl-source-pack-v2/source-manifest.json"
    manifest = helpers.read_json(source_manifest_path)
    analysis = helpers.read_json(source / "analysis.json")
    characters = sorted({g["character"] for b in analysis["blocks"] for g in b["glyphs"] if "\u3041" <= g["character"] <= "\u30fa"})
    faces, arrays, seen = [], [], set()
    for row in manifest["sources"]:
        if row.get("locale_hint") not in {"ja", "bridge_candidate"}:
            continue
        font_path = asset_root / row["font_file"]
        if not row["license"]["training_allowed"]:
            raise ValueError("Reference font does not permit training")
        if hashlib.sha256(font_path.read_bytes()).hexdigest() != row["font_sha256"]:
            raise ValueError("Reference font hash mismatch")
        with TTFont(font_path, fontNumber=row["face_index"]) as table:
            cmap = table.getBestCmap() or {}
            if not all(ord(c) in cmap and cmap[ord(c)] != ".notdef" for c in characters):
                continue
        font = ImageFont.truetype(str(font_path), POLICY["rasterPpem"], index=row["face_index"])
        bank = np.stack([render_glyph(font, c) for c in characters])
        digest = hashlib.sha256(bank.tobytes()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        faces.append({"id": row["source_id"], "familyId": row["family_id"], "fontSha256": row["font_sha256"], "renderSha256": digest})
        arrays.append(bank)
    if len(faces) < 10:
        raise ValueError("Insufficient complete reference faces")
    bank = np.stack(arrays)
    # Reject visually identical .notdef-like boxes across this varied kana set.
    for index in range(len(faces)):
        if len({hashlib.sha256(g.tobytes()).hexdigest() for g in bank[index]}) < len(characters) * 0.8:
            raise ValueError("Reference face failed glyph diversity check")
    character_index = {char: i for i, char in enumerate(characters)}
    rows = []
    for block in analysis["blocks"]:
        per_character = {}
        raw_per_character = {}
        for glyph in block["glyphs"]:
            char = glyph["character"]
            if char not in character_index:
                continue
            query = 1 - np.array(Image.open(source / glyph["image"]), dtype=np.float32) / 255
            candidates = bank[:, character_index[char]]
            denominator = np.maximum(1, query.sum() + candidates.sum(axis=(1, 2)))
            distances = np.min(np.stack([np.abs(query[None] - np.roll(candidates, (dy, dx), axis=(1, 2))).sum(axis=(1, 2)) / denominator
                                        for dy in (-1, 0, 1) for dx in (-1, 0, 1)]), axis=0)
            spread = max(0.05, float(np.percentile(distances, 75) - np.percentile(distances, 25)))
            per_character.setdefault(char, []).append((distances - np.median(distances)) / spread)
            raw_per_character.setdefault(char, []).append(distances)
        if len(per_character) < 3:
            continue
        profile = np.mean([np.median(v, axis=0) for v in per_character.values()], axis=0)
        raw = np.mean([np.median(v, axis=0) for v in raw_per_character.values()], axis=0)
        ranked = np.argsort(raw)
        pid, cid = block["key"].split("/")
        rows.append({"key": block["key"], "pageId": pid, "candidateId": cid, "blockId": block["key"],
                     "glyphCount": len(per_character), "style": profile.tolist(),
                     "nearestReferences": [{"faceId": faces[i]["id"], "distance": float(raw[i])} for i in ranked[:5]]})
    seal = {"policy": POLICY, "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "sourceAnalysisSha256": hashlib.sha256((source / "analysis.json").read_bytes()).hexdigest(),
            "sourcePackSha256": hashlib.sha256(source_manifest_path.read_bytes()).hexdigest(),
            "faces": faces, "characters": characters, "rows": rows}
    (output / "singleton-evidence.json").write_text(json.dumps(seal, ensure_ascii=False, indent=2), encoding="utf-8")
    np.savez_compressed(output / "reference-glyphs.npz", glyphs=bank)
    print(json.dumps({"sourceBlocks": len(analysis["blocks"]), "usableBlocks": len(rows), "faces": len(faces), "characters": len(characters)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("asset_root", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.asset_root.resolve(), args.source.resolve(), args.output.resolve())
