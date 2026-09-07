"""S3: strict Hayai verification, then unchanged S1 same-character grouping.

The shape gate is a deliberately conservative development choice after the four
locked characterization cases, not a learned or independently validated bound.
Reference distances never select a font or supply group membership.
"""

import argparse
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("same_glyph", Path(__file__).with_name("analyze-matched-glyphs.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

POLICY = {
    "id": "verified-alignment-same-glyph-v1",
    "glyphGate": "exact NFC/whitespace-normalized Hayai glyph equality and reference shape distance <= 1/3",
    "maximumShapeDistance": 1 / 3,
    "gateAuthority": "development choice after four known failure cases; not independent confirmation",
    "requireWholeRegionTextAgreement": False,
    "groupingPolicy": helpers.POLICY,
    "manualLabelsRead": False,
    "fontChoicesMade": False,
}


def run(chapter, alignment, output):
    output.mkdir(parents=True, exist_ok=False)
    (output / "glyphs").mkdir()
    source = helpers.read_json(alignment / "alignment.json")
    batches = helpers.read_json(alignment / "batch.json")["items"]
    ocr = {}
    receipts = []
    for batch in batches:
        path = Path(batch["output"])
        result = helpers.read_json(path)
        receipts.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        for row in result["items"]:
            if row["id"] in ocr:
                raise ValueError("Duplicate verification id")
            ocr[row["id"]] = row["ocrText"]
    baseline = helpers.read_json(chapter / "ocr-baseline/baseline-report.json")
    pages = {p["pageId"]: Image.open(chapter / "ocr-baseline" / p["ocrImagePath"] if p.get("ocrImagePath") else Path(p["imagePath"])).convert("RGB") for p in baseline["pages"]}
    blocks, tensors, self_pairs, verification = [], {}, [], []
    for record in source["records"]:
        key = record["key"]
        image = pages[key.split("/")[0]]
        glyphs, by_char = [], {}
        for line in record["lines"]:
            box = line["bbox"]
            gray = np.asarray(image.crop(box).convert("L"))
            _, mask = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            if mask.mean() > 0.5:
                mask = 1 - mask
            for glyph in line["glyphs"]:
                if "verificationId" not in glyph:
                    continue
                actual = ocr[glyph["verificationId"]]
                agreement = helpers.normalize(actual) == glyph["token"]
                accepted = agreement and glyph["shapeDistance"] <= POLICY["maximumShapeDistance"]
                verification.append({"key": key, "lineId": line["lineId"], "characterIndex": glyph["characterIndex"],
                                     "character": glyph["token"], "actual": actual, "ocrAgreement": agreement,
                                     "accepted": accepted, "shapeDistance": glyph["shapeDistance"], "bbox": glyph["bbox"]})
                if not accepted:
                    continue
                x1, y1, x2, y2 = glyph["bbox"]
                tensor = helpers.canonical(mask[y1 - box[1]:y2 - box[1], x1 - box[0]:x2 - box[0]])
                if tensor is None:
                    raise ValueError("Accepted empty glyph")
                name = f"glyphs/{key.replace('/', '-')}-{len(glyphs):03d}-U{ord(glyph['token']):04X}.png"
                Image.fromarray((255 * (1 - tensor)).round().astype(np.uint8)).save(output / name)
                item = {"character": glyph["token"], "lineId": line["lineId"], "characterIndex": glyph["characterIndex"],
                        "bbox": glyph["bbox"], "image": name, "tensor": tensor}
                glyphs.append(item)
                by_char.setdefault(item["character"], []).append(item)
        for char, matches in by_char.items():
            for a, b in itertools.combinations(matches, 2):
                self_pairs.append({"key": key, "character": char, "distance": helpers.glyph_distance(a["tensor"], b["tensor"]),
                                   "leftGlyph": a["image"], "rightGlyph": b["image"]})
        usable = len(glyphs) >= helpers.POLICY["minimumGlyphsPerBlock"]
        agreement = helpers.normalize("".join(l["text"] for l in record["lines"])) == helpers.normalize(record["sourceText"])
        blocks.append({"key": key, "sourceText": record["sourceText"], "textAgreement": agreement, "usable": usable,
                       "glyphs": [{k: v for k, v in g.items() if k != "tensor"} for g in glyphs]})
        if usable:
            tensors[key] = by_char
    pairs = [{"left": a, "right": b, **helpers.pair_evidence(tensors[a], tensors[b])} for a, b in itertools.combinations(sorted(tensors), 2)]
    cutoff = float(np.percentile([p["distance"] for p in self_pairs], 90)) if len(self_pairs) >= 12 else None
    groups = helpers.group_blocks(blocks, pairs, cutoff) if cutoff is not None else []
    summary = {"sourceBlocks": len(blocks), "exactOcrAgreement": sum(b["textAgreement"] for b in blocks),
               "glyphsChecked": len(verification), "glyphOcrAgreement": sum(v["ocrAgreement"] for v in verification),
               "usableBlocks": len(tensors), "glyphs": sum(len(b["glyphs"]) for b in blocks), "selfPairs": len(self_pairs),
               "cutoff": cutoff, "groups": len(groups), "repeatedGroups": sum(len(g["members"]) > 1 for g in groups),
               "groupedBlocks": sum(len(g["members"]) for g in groups if len(g["members"]) > 1)}
    payload = {"policy": POLICY, "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "groupingScriptSha256": hashlib.sha256(Path(helpers.__file__).read_bytes()).hexdigest(),
               "alignmentSha256": hashlib.sha256((alignment / "alignment.json").read_bytes()).hexdigest(),
               "ocrFiles": receipts, "summary": summary, "blocks": blocks, "groups": groups,
               "pairs": pairs, "selfPairs": self_pairs, "verification": verification}
    (output / "analysis.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("chapter", type=Path)
    parser.add_argument("alignment", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    run(args.chapter.resolve(), args.alignment.resolve(), args.output.resolve())
