#!/usr/bin/env python3
"""Measure and visualize V3 OCR-geometry repair candidates.

The input is produced by research_source_font_size_v3_geometry_audit.cjs.
It reuses the production-v2 research estimator and sealed r08 calibration,
then creates a source/inpaint contact sheet for manual review.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import unicodedata
from dataclasses import asdict
from pathlib import Path
from statistics import median
from typing import Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import research_source_font_size_hybrid as hybrid
import research_source_font_size_real_smoke as real
import research_source_font_size_smoke as synthetic


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"expected an object: {path}")
    return value


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def normalized_bbox(
    bbox: dict[str, object], width: int, height: int
) -> dict[str, float]:
    return {
        "x": float(bbox["x"]) / width * 1000,
        "y": float(bbox["y"]) / height * 1000,
        "w": float(bbox["w"]) / width * 1000,
        "h": float(bbox["h"]) / height * 1000,
    }


def estimator_block(
    row: dict[str, object], bbox: dict[str, object], image: Image.Image
) -> dict[str, object]:
    return {
        "id": row["blockId"],
        "bbox": normalized_bbox(bbox, image.width, image.height),
        "bboxSpace": "normalized_1000",
        "sourceText": row.get("sourceText", ""),
        "translatedText": row.get("translatedText", ""),
        "sourceDirection": row.get("direction", ""),
        "textRole": row.get("textRole", "ordinary"),
        "autoFitText": True,
        "rotationDeg": 0,
    }


def calibrated_result(
    estimate: hybrid.SourceEstimate,
    model: object,
    row: dict[str, object],
    config: hybrid.HybridConfig,
    font_catalog: dict[str, Path],
) -> dict[str, object]:
    confident = (
        estimate.confident
        and estimate.line_dispersion <= config.maximum_line_dispersion
    )
    corrected_face = estimate.raw_face_px
    predicted_log = 0.0
    nominal = None
    if confident:
        predicted_log = float(
            np.clip(
                model.predict(np.asarray([estimate.feature_vector], dtype=np.float32))[
                    0
                ],
                -0.20,
                0.20,
            )
        )
        corrected_face = (
            estimate.raw_face_px
            * math.exp(predicted_log * config.learned_blend)
            * config.face_scale
        )
        target_text = hybrid.compact_text(row.get("translatedText"))
        font_id = str(row.get("fontFamily") or "nanum-gothic")
        font_path = font_catalog.get(
            font_id, hybrid.FONT_ROOT / "nanum-gothic-regular.ttf"
        )
        if target_text and font_path.is_file():
            nominal = synthetic.calibrated_target_size(
                font_path,
                target_text[:80],
                estimate.direction,
                corrected_face,
            )
    return {
        "confident": confident,
        "warning": estimate.warning,
        "rawFacePx": round(estimate.raw_face_px, 3),
        "correctedFacePx": round(corrected_face, 3),
        "nominalTargetCapPx": nominal,
        "predictedLogCorrection": round(predicted_log, 6),
        "estimate": asdict(estimate),
    }


def normalized_glyph_text(value: object) -> str:
    return "".join(
        character.lower()
        for character in unicodedata.normalize("NFKC", str(value or ""))
        if character.isalnum()
    )


def containment_ratio(inner: dict[str, object], outer: dict[str, object]) -> float:
    x1 = max(float(inner["x1"]), float(outer["x1"]))
    y1 = max(float(inner["y1"]), float(outer["y1"]))
    x2 = min(float(inner["x2"]), float(outer["x2"]))
    y2 = min(float(inner["y2"]), float(outer["y2"]))
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    inner_area = max(
        1.0,
        (float(inner["x2"]) - float(inner["x1"]))
        * (float(inner["y2"]) - float(inner["y1"])),
    )
    return intersection / inner_area


def envelope_line_hints(row: dict[str, object]) -> list[dict[str, object]]:
    result = read_json(Path(str(row["resultPath"])))
    request = result.get("requestSummary")
    if not isinstance(request, dict):
        return []
    hints = request.get("ocrBboxHints")
    if not isinstance(hints, list):
        return []
    source = normalized_glyph_text(row.get("sourceText"))
    raw = row["rawModelBboxPx"]
    assert isinstance(raw, dict)
    padding = max(6.0, float(row.get("fontSizePx") or 12) * 0.5)
    envelope = {
        "x1": float(raw["x"]) - padding,
        "y1": float(raw["y"]) - padding,
        "x2": float(raw["x"]) + float(raw["w"]) + padding,
        "y2": float(raw["y"]) + float(raw["h"]) + padding,
    }
    selected: list[dict[str, object]] = []
    for raw_hint in hints:
        if not isinstance(raw_hint, dict):
            continue
        try:
            hint = {
                **raw_hint,
                "x1": float(raw_hint["x1"]),
                "y1": float(raw_hint["y1"]),
                "x2": float(raw_hint["x2"]),
                "y2": float(raw_hint["y2"]),
            }
        except (KeyError, TypeError, ValueError):
            continue
        text = normalized_glyph_text(hint.get("ocrText"))
        if text and text in source and containment_ratio(hint, envelope) >= 0.72:
            selected.append(hint)
    return selected


def line_geometry_result(
    row: dict[str, object],
    image: Image.Image,
    model: object,
    config: hybrid.HybridConfig,
    font_catalog: dict[str, Path],
) -> dict[str, object]:
    line_rows: list[dict[str, object]] = []
    for hint in envelope_line_hints(row):
        bbox = {
            "x": hint["x1"],
            "y": hint["y1"],
            "w": float(hint["x2"]) - float(hint["x1"]),
            "h": float(hint["y2"]) - float(hint["y1"]),
        }
        line_row = {**row, "sourceText": hint.get("ocrText", "")}
        estimate = hybrid.estimate_source_block(
            image,
            estimator_block(line_row, bbox, image),
        )
        calibrated = calibrated_result(estimate, model, row, config, font_catalog)
        line_rows.append(
            {
                "candidateId": hint.get("id"),
                "ocrText": hint.get("ocrText"),
                "bboxPx": bbox,
                **calibrated,
            }
        )
    reliable_faces = [
        float(line["correctedFacePx"])
        for line in line_rows
        if line.get("confident") is True
    ]
    return {
        "hintCount": len(line_rows),
        "reliableLineCount": len(reliable_faces),
        "medianFacePx": round(median(reliable_faces), 3)
        if len(reliable_faces) >= 2
        else None,
        "lines": line_rows,
    }


def box_edges(bbox: dict[str, object]) -> tuple[float, float, float, float]:
    x1 = float(bbox["x"])
    y1 = float(bbox["y"])
    return x1, y1, x1 + float(bbox["w"]), y1 + float(bbox["h"])


def crop_bounds(
    row: dict[str, object], image: Image.Image
) -> tuple[int, int, int, int]:
    boxes = [
        row["rawModelBboxPx"],
        row["persistedBboxPx"],
        row["currentLockBboxPx"],
    ]
    edges = [box_edges(box) for box in boxes if isinstance(box, dict)]
    x1 = max(0, math.floor(min(edge[0] for edge in edges) - 28))
    y1 = max(0, math.floor(min(edge[1] for edge in edges) - 28))
    x2 = min(image.width, math.ceil(max(edge[2] for edge in edges) + 28))
    y2 = min(image.height, math.ceil(max(edge[3] for edge in edges) + 28))
    return x1, y1, x2, y2


def draw_bbox(
    draw: ImageDraw.ImageDraw,
    bbox: dict[str, object],
    crop: tuple[int, int, int, int],
    color: tuple[int, int, int],
    width: int,
) -> None:
    x1, y1, x2, y2 = box_edges(bbox)
    draw.rectangle(
        (x1 - crop[0], y1 - crop[1], x2 - crop[0], y2 - crop[1]),
        outline=color,
        width=width,
    )


def fit_panel(image: Image.Image, width: int, height: int) -> Image.Image:
    result = Image.new("RGB", (width, height), "white")
    scale = min(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    result.paste(
        resized, ((width - resized.width) // 2, (height - resized.height) // 2)
    )
    return result


def load_label_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        Path(r"C:\Windows\Fonts\malgun.ttf"),
        Path(r"C:\Windows\Fonts\arial.ttf"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def contact_sheet(
    rows: list[dict[str, object]], output: Path, columns: int = 2
) -> None:
    cell_width = 660
    cell_height = 350
    image_height = 250
    rows_count = math.ceil(len(rows) / columns)
    sheet = Image.new(
        "RGB", (cell_width * columns, cell_height * rows_count), "#ececec"
    )
    font = load_label_font(16)
    small_font = load_label_font(14)
    for index, row in enumerate(rows):
        original = Image.open(Path(str(row["imagePath"]))).convert("RGB")
        bounds = crop_bounds(row, original)
        source_crop = original.crop(bounds)
        source_draw = ImageDraw.Draw(source_crop)
        draw_bbox(
            source_draw,
            row["persistedBboxPx"],
            bounds,
            (220, 32, 32),
            3,
        )
        draw_bbox(
            source_draw,
            row["currentLockBboxPx"],
            bounds,
            (0, 170, 70),
            3,
        )
        inpaint_path = Path(str(row.get("inpaintedImagePath") or ""))
        if inpaint_path.is_file():
            inpaint = Image.open(inpaint_path).convert("RGB").crop(bounds)
        else:
            inpaint = Image.new("RGB", source_crop.size, "white")
        left = fit_panel(source_crop, 315, image_height)
        right = fit_panel(inpaint, 315, image_height)
        cell_x = (index % columns) * cell_width
        cell_y = (index // columns) * cell_height
        sheet.paste(left, (cell_x + 10, cell_y + 88))
        sheet.paste(right, (cell_x + 335, cell_y + 88))
        draw = ImageDraw.Draw(sheet)
        before = row.get("sourceFontFacePx")
        after = row.get("fixedEstimate", {}).get("correctedFacePx")
        title = (
            f"#{index + 1:02d} p{row['pageNumber']} id{row['itemId']}  "
            f"face {before} -> {after}  area x{row['geometryExpansionRatio']}"
        )
        draw.text((cell_x + 10, cell_y + 8), title, fill="black", font=font)
        work_title = str(row.get("workTitle") or "")
        draw.text(
            (cell_x + 10, cell_y + 34),
            work_title[:44],
            fill="#222222",
            font=small_font,
        )
        draw.text(
            (cell_x + 10, cell_y + 58),
            "original: red=persisted, green=V3     |     inpaint",
            fill="#333333",
            font=small_font,
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output)


def run(args: argparse.Namespace) -> int:
    cv2.setNumThreads(1)
    random.seed(20260825)
    report = read_json(Path(args.audit).resolve())
    candidate_rows = report.get("topGeometryExpansions")
    if not isinstance(candidate_rows, list):
        raise ValueError("audit report has no topGeometryExpansions")
    rows = [dict(row) for row in candidate_rows if isinstance(row, dict)]
    if args.limit > 0:
        rows = rows[: args.limit]
    model, model_report = hybrid.train_correction_model()
    config = next(config for config in hybrid.CONFIGS if config.id == args.config)
    font_catalog = real.read_font_catalog()
    for row in rows:
        image = Image.open(Path(str(row["imagePath"]))).convert("RGB")
        stored = hybrid.estimate_source_block(
            image,
            estimator_block(row, row["persistedBboxPx"], image),
        )
        fixed = hybrid.estimate_source_block(
            image,
            estimator_block(row, row["currentLockBboxPx"], image),
        )
        row["storedEstimate"] = calibrated_result(
            stored, model, row, config, font_catalog
        )
        row["fixedEstimate"] = calibrated_result(
            fixed, model, row, config, font_catalog
        )
        row["lineGeometryEstimate"] = line_geometry_result(
            row, image, model, config, font_catalog
        )
    output = Path(args.output).resolve()
    write_json(
        output,
        {
            "schemaVersion": 1,
            "audit": str(Path(args.audit).resolve()),
            "config": asdict(config),
            "model": model_report,
            "rows": rows,
        },
    )
    panel = Path(args.panel).resolve()
    contact_sheet(rows, panel)
    print(
        json.dumps(
            {"rows": len(rows), "output": str(output), "panel": str(panel)},
            ensure_ascii=False,
        )
    )
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--panel", required=True)
    parser.add_argument("--config", default="r08-s102-ml35-q1")
    parser.add_argument("--limit", type=int, default=100)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
