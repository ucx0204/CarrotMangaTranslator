#!/usr/bin/env python3
"""Render full-page Koharu onomatopoeia masks and connected components."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy import ndimage

import evaluate_koharu_region_boxes as base


COLORS = (
    (236, 72, 153),
    (6, 182, 212),
    (249, 115, 22),
    (139, 92, 246),
    (34, 197, 94),
    (234, 179, 8),
)


def component_records(mask: np.ndarray) -> list[dict[str, Any]]:
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
    records: list[dict[str, Any]] = []
    for label in range(1, count + 1):
        component = labels == label
        area = int(np.count_nonzero(component))
        box = base.mask_bbox(component)
        if box is None:
            continue
        box_area = base.bbox_area(box)
        records.append(
            {
                "componentId": label,
                "area": area,
                "bbox": [round(float(value), 3) for value in box],
                "bboxArea": round(box_area, 3),
                "density": round(area / max(1.0, box_area), 6),
            }
        )
    records.sort(key=lambda value: (-int(value["area"]), int(value["componentId"])))
    return records


def run(args: argparse.Namespace) -> None:
    record = base.read_json(Path(args.record).resolve())
    with Image.open(record["path"]) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    model, _ = base.load_layout_model()
    prediction = model.predict(
        image,
        threshold=base.MIN_PREDICT_THRESHOLD,
        shape=(1152, 1152),
        include_source_image=False,
    )
    detections = base.prepare_layout_detections(prediction, image.width, image.height)
    requested = set(args.detection_id or [])
    effects = [
        value
        for value in detections
        if value["class"] == "onomatopoeia"
        and (not requested or str(value["id"]) in requested)
    ]
    if requested - {str(value["id"]) for value in effects}:
        missing = sorted(requested - {str(value["id"]) for value in effects})
        raise base.EvaluationError(f"effect detections not found: {missing}")

    rgba = np.asarray(image.convert("RGBA")).copy()
    output_items: list[dict[str, Any]] = []
    for index, detection in enumerate(effects):
        color = np.asarray(COLORS[index % len(COLORS)], dtype=np.float32)
        mask = np.asarray(detection["mask"], dtype=bool)
        rgba[mask, :3] = (0.58 * rgba[mask, :3] + 0.42 * color).astype(np.uint8)
        components = component_records(mask)
        output_items.append(
            {
                "id": str(detection["id"]),
                "score": round(float(detection["score"]), 6),
                "bbox": [round(float(value), 3) for value in detection["bbox"]],
                "maskArea": int(detection["maskArea"]),
                "componentCount": len(components),
                "components": components,
            }
        )

    diagnostic = Image.fromarray(rgba, mode="RGBA").convert("RGB")
    draw = ImageDraw.Draw(diagnostic)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/malgunbd.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    line_width = max(3, int(round(min(image.size) * 0.004)))
    for index, (detection, item) in enumerate(zip(effects, output_items)):
        color = COLORS[index % len(COLORS)]
        draw.rectangle(tuple(detection["bbox"]), outline=color, width=line_width)
        label = f"{item['id']} score={item['score']:.3f} cc={item['componentCount']}"
        origin = (float(detection["bbox"][0]) + 4, float(detection["bbox"][1]) + 4)
        draw.text(
            origin,
            label,
            fill=color,
            font=font,
            stroke_width=2,
            stroke_fill=(255, 255, 255),
        )

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    page_id = str(record.get("id", Path(args.record).stem))
    diagnostic.save(output_dir / f"{page_id}-effect-masks.png", optimize=True)
    output = {
        "schemaVersion": "koharu-effect-mask-components-v1",
        "pageId": page_id,
        "path": str(record["path"]),
        "width": image.width,
        "height": image.height,
        "items": output_items,
    }
    base.write_json(output_dir / f"{page_id}-effect-masks.json", output)
    print(json.dumps(output, ensure_ascii=True, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--detection-id", action="append")
    return parser


if __name__ == "__main__":
    try:
        run(build_parser().parse_args())
    except base.EvaluationError as error:
        print(f"[koharu-effect-mask] {error}")
        raise SystemExit(2) from error
