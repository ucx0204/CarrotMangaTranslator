#!/usr/bin/env python3
"""Low-cost smoke test for source-apparent CJK text-size estimation.

This is a research harness, not production inference.  It renders a small,
deterministic Japanese corpus with known core glyph masks, estimates the
apparent character-face size from only the raster and a line detector box, and
then asks how closely several Korean fonts can reproduce that face size.

The test deliberately separates the dark/light glyph core from outline and
background effects.  That distinction is important: matching an OCR polygon or
effect envelope directly makes thick outlined manga text systematically large.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import random
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from statistics import median
from typing import Iterable, Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
FONT_ROOT = ROOT / "src" / "renderer" / "src" / "assets" / "fonts"

SOURCE_FONTS = (
    ("dot-gothic", FONT_ROOT / "ja" / "dot-gothic-16.ttf"),
    ("yusei-magic", FONT_ROOT / "ja" / "yusei-magic.ttf"),
    ("mochiy-pop", FONT_ROOT / "ja" / "mochiy-pop-one.ttf"),
    ("hachi-maru", FONT_ROOT / "ja" / "hachi-maru-pop.ttf"),
)
CORE_TARGET_FONTS = (
    ("nanum-gothic", FONT_ROOT / "nanum-gothic-regular.ttf"),
    ("nanum-myeongjo", FONT_ROOT / "nanum-myeongjo-regular.ttf"),
    ("jua", FONT_ROOT / "ko" / "jua.ttf"),
    ("black-han-sans", FONT_ROOT / "ko" / "black-han-sans.ttf"),
)
ALL_TARGET_FONTS = (
    ("mongtori", FONT_ROOT / "mongtori.ttf"),
    ("chosun-gungseo", FONT_ROOT / "chosun-gungseo.ttf"),
    ("griun-pol-sensibility", FONT_ROOT / "griun-pol-sensibility.ttf"),
    ("nanum-gothic", FONT_ROOT / "nanum-gothic-regular.ttf"),
    ("nanum-myeongjo", FONT_ROOT / "nanum-myeongjo-regular.ttf"),
    ("nanum-barun-gothic", FONT_ROOT / "nanum-barun-gothic-regular.ttf"),
    ("seoul-namsan", FONT_ROOT / "seoul-namsan-regular.ttf"),
    ("seoul-namsan-vertical", FONT_ROOT / "seoul-namsan-vertical.ttf"),
    ("seoul-hangang", FONT_ROOT / "seoul-hangang-regular.ttf"),
    ("dohyeon", FONT_ROOT / "ko" / "dohyeon.ttf"),
    ("ridi-batang", FONT_ROOT / "ko" / "ridi-batang.otf"),
    ("cafe24-gowoonbam", FONT_ROOT / "ko" / "cafe24-gowoonbam.ttf"),
    ("start-over", FONT_ROOT / "ko" / "start-over.ttf"),
    ("jua", FONT_ROOT / "ko" / "jua.ttf"),
    ("gaegu", FONT_ROOT / "ko" / "gaegu-regular.ttf"),
    ("black-and-white-picture", FONT_ROOT / "ko" / "black-and-white-picture.ttf"),
    ("black-han-sans", FONT_ROOT / "ko" / "black-han-sans.ttf"),
    ("gasoek-one", FONT_ROOT / "ko" / "gasoek-one.ttf"),
    ("kirang-haerang", FONT_ROOT / "ko" / "kirang-haerang.ttf"),
    ("nanum-brush-script", FONT_ROOT / "ko" / "nanum-brush-script.ttf"),
    ("single-day", FONT_ROOT / "ko" / "single-day.ttf"),
)
TEXT_PAIRS = (
    ("愛してる", "사랑해"),
    ("ありがとう", "고마워"),
    ("魔王さま", "마왕님"),
    ("ドキドキ", "두근두근"),
)
SIZES = (20, 32, 48, 72)
DIRECTIONS = ("horizontal", "vertical")
VARIANTS = ("plain", "outline", "jpeg-noise", "rotated-outline", "inverse-outline")


@dataclass(frozen=True)
class RenderedLine:
    image: Image.Image
    core_mask: np.ndarray
    effect_mask: np.ndarray
    detector_bbox: tuple[int, int, int, int]
    true_face_px: float
    source_nominal_px: int


@dataclass(frozen=True)
class MaskGeometry:
    axis_cross_px: float
    oriented_cross_px: float
    oriented_major_px: float
    foreground_ratio: float
    component_count: int


def visible_glyphs(text: str) -> list[str]:
    return [character for character in text if not character.isspace()]


def _font_bbox(font: ImageFont.FreeTypeFont, text: str, stroke_width: int = 0) -> tuple[int, int, int, int]:
    left, top, right, bottom = font.getbbox(text, stroke_width=stroke_width)
    return int(left), int(top), int(right), int(bottom)


def _draw_horizontal(
    layer: Image.Image,
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: int | tuple[int, int, int],
    stroke_width: int = 0,
    stroke_fill: int | tuple[int, int, int] | None = None,
) -> None:
    bbox = _font_bbox(font, text, stroke_width=stroke_width)
    padding = max(18, stroke_width + 10)
    origin = (padding - bbox[0], padding - bbox[1])
    ImageDraw.Draw(layer).text(
        origin,
        text,
        font=font,
        fill=fill,
        stroke_width=stroke_width,
        stroke_fill=stroke_fill,
    )


def _vertical_layout(
    text: str,
    font: ImageFont.FreeTypeFont,
    stroke_width: int,
) -> tuple[list[tuple[str, float, float]], int, int]:
    glyphs = visible_glyphs(text)
    boxes = [_font_bbox(font, glyph, stroke_width=stroke_width) for glyph in glyphs]
    maximum_width = max((box[2] - box[0] for box in boxes), default=1)
    maximum_height = max((box[3] - box[1] for box in boxes), default=1)
    cell = max(font.size, maximum_width, maximum_height) + max(1, round(font.size * 0.08))
    padding = max(18, stroke_width + 10)
    width = maximum_width + padding * 2
    height = cell * len(glyphs) + padding * 2
    center_x = width / 2
    placements: list[tuple[str, float, float]] = []
    for index, (glyph, box) in enumerate(zip(glyphs, boxes, strict=True)):
        center_y = padding + cell * (index + 0.5)
        x = center_x - (box[0] + box[2]) / 2
        y = center_y - (box[1] + box[3]) / 2
        placements.append((glyph, x, y))
    return placements, width, height


def _new_layers(
    text: str,
    font: ImageFont.FreeTypeFont,
    direction: str,
    stroke_width: int,
) -> tuple[Image.Image, Image.Image, tuple[int, int], list[tuple[str, float, float]] | None]:
    if direction == "horizontal":
        effect_box = _font_bbox(font, text, stroke_width=stroke_width)
        padding = max(18, stroke_width + 10)
        size = (
            max(1, effect_box[2] - effect_box[0] + padding * 2),
            max(1, effect_box[3] - effect_box[1] + padding * 2),
        )
        return Image.new("L", size, 0), Image.new("L", size, 0), size, None
    placements, width, height = _vertical_layout(text, font, stroke_width)
    size = (width, height)
    return Image.new("L", size, 0), Image.new("L", size, 0), size, placements


def _draw_mask_layers(
    text: str,
    font: ImageFont.FreeTypeFont,
    direction: str,
    stroke_width: int,
) -> tuple[Image.Image, Image.Image]:
    core, effect, _size, placements = _new_layers(text, font, direction, stroke_width)
    if direction == "horizontal":
        _draw_horizontal(core, text, font, 255)
        _draw_horizontal(effect, text, font, 255, stroke_width, 255)
        return core, effect
    assert placements is not None
    core_draw = ImageDraw.Draw(core)
    effect_draw = ImageDraw.Draw(effect)
    for glyph, x, y in placements:
        core_draw.text((x, y), glyph, font=font, fill=255)
        effect_draw.text(
            (x, y),
            glyph,
            font=font,
            fill=255,
            stroke_width=stroke_width,
            stroke_fill=255,
        )
    return core, effect


def _draw_colored_line(
    size: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    direction: str,
    background: int,
    fill: int,
    stroke_width: int,
    stroke_fill: int,
) -> Image.Image:
    image = Image.new("RGB", size, (background, background, background))
    if direction == "horizontal":
        _draw_horizontal(image, text, font, (fill,) * 3, stroke_width, (stroke_fill,) * 3)
        return image
    placements, _width, _height = _vertical_layout(text, font, stroke_width)
    draw = ImageDraw.Draw(image)
    for glyph, x, y in placements:
        draw.text(
            (x, y),
            glyph,
            font=font,
            fill=(fill,) * 3,
            stroke_width=stroke_width,
            stroke_fill=(stroke_fill,) * 3,
        )
    return image


def _mask_bbox(mask: np.ndarray, padding: int = 0) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return 0, 0, mask.shape[1], mask.shape[0]
    return (
        max(0, int(xs.min()) - padding),
        max(0, int(ys.min()) - padding),
        min(mask.shape[1], int(xs.max()) + 1 + padding),
        min(mask.shape[0], int(ys.max()) + 1 + padding),
    )


def _rotate_layers(
    image: Image.Image,
    core: Image.Image,
    effect: Image.Image,
    angle: float,
    background: int,
) -> tuple[Image.Image, Image.Image, Image.Image]:
    return (
        image.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=(background,) * 3),
        core.rotate(angle, expand=True, resample=Image.Resampling.NEAREST, fillcolor=0),
        effect.rotate(angle, expand=True, resample=Image.Resampling.NEAREST, fillcolor=0),
    )


def render_source_line(
    font_path: Path,
    text: str,
    nominal_size: int,
    direction: str,
    variant: str,
    seed: int,
) -> RenderedLine:
    font = ImageFont.truetype(str(font_path), nominal_size)
    stroke_width = 0 if variant == "plain" else max(1, round(nominal_size * 0.075))
    inverse = variant == "inverse-outline"
    background = 55 if inverse else (225 if variant == "plain" else 188)
    fill = 246 if inverse else 18
    stroke_fill = 12 if inverse else 250
    core, effect = _draw_mask_layers(text, font, direction, stroke_width)
    image = _draw_colored_line(
        core.size,
        text,
        font,
        direction,
        background,
        fill,
        stroke_width,
        stroke_fill,
    )
    unrotated_core = np.asarray(core, dtype=np.uint8) > 0
    true_face = mask_geometry(unrotated_core, direction).oriented_cross_px
    if variant == "rotated-outline":
        image, core, effect = _rotate_layers(image, core, effect, 9.0, background)

    if variant == "jpeg-noise":
        rng = np.random.default_rng(seed)
        pixels = np.asarray(image, dtype=np.int16)
        noise = rng.normal(0.0, 5.0, size=pixels.shape[:2])[:, :, None]
        pixels = np.clip(pixels + noise, 0, 255).astype(np.uint8)
        noisy = Image.fromarray(pixels)
        buffer = io.BytesIO()
        noisy.save(buffer, format="JPEG", quality=70, subsampling=2)
        buffer.seek(0)
        image = Image.open(buffer).convert("RGB")

    core_array = np.asarray(core, dtype=np.uint8) > 0
    effect_array = np.asarray(effect, dtype=np.uint8) > 0
    detector_bbox = _mask_bbox(effect_array, padding=max(2, round(nominal_size * 0.04)))
    return RenderedLine(
        image=image,
        core_mask=core_array,
        effect_mask=effect_array,
        detector_bbox=detector_bbox,
        true_face_px=true_face,
        source_nominal_px=nominal_size,
    )


def _remove_small_and_enclosing_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    height, width = mask.shape
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    cleaned = np.zeros_like(mask, dtype=np.uint8)
    kept = 0
    for label in range(1, count):
        x, y, component_width, component_height, area = (int(value) for value in stats[label])
        if area < 3:
            continue
        touches = int(x == 0) + int(y == 0) + int(x + component_width >= width) + int(y + component_height >= height)
        if touches >= 3 and area / max(1, width * height) > 0.08:
            continue
        cleaned[labels == label] = 1
        kept += 1
    return cleaned.astype(bool), kept


def estimate_core_mask(image: Image.Image, bbox: tuple[int, int, int, int]) -> tuple[np.ndarray, int]:
    crop = np.asarray(image.crop(bbox).convert("L"), dtype=np.uint8)
    threshold, _ = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = crop <= threshold
    light = crop > threshold
    selected = dark if int(dark.sum()) <= int(light.sum()) else light
    return _remove_small_and_enclosing_components(selected)


def mask_geometry(mask: np.ndarray, direction: str) -> MaskGeometry:
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return MaskGeometry(0.0, 0.0, 0.0, 0.0, 0)
    low_x, high_x = np.quantile(xs, (0.005, 0.995))
    low_y, high_y = np.quantile(ys, (0.005, 0.995))
    axis_cross = (high_y - low_y + 1.0) if direction == "horizontal" else (high_x - low_x + 1.0)
    points = np.column_stack((xs, ys)).astype(np.float32)
    _center, (rect_width, rect_height), _angle = cv2.minAreaRect(points)
    oriented_cross = min(float(rect_width), float(rect_height)) + 1.0
    oriented_major = max(float(rect_width), float(rect_height)) + 1.0
    _clean, component_count = _remove_small_and_enclosing_components(mask)
    return MaskGeometry(
        axis_cross_px=float(axis_cross),
        oriented_cross_px=oriented_cross,
        oriented_major_px=oriented_major,
        foreground_ratio=float(xs.size / mask.size),
        component_count=component_count,
    )


@lru_cache(maxsize=16_384)
def target_face_px(font_path: str, text: str, direction: str, nominal_size: int) -> float:
    font = ImageFont.truetype(font_path, nominal_size)
    core, _effect = _draw_mask_layers(text, font, direction, 0)
    return mask_geometry(np.asarray(core, dtype=np.uint8) > 0, direction).oriented_cross_px


def calibrated_target_size(
    font_path: Path,
    text: str,
    direction: str,
    desired_face_px: float,
) -> int:
    low, high = 4, 200
    best_size = low
    best_error = math.inf
    while low <= high:
        candidate = (low + high) // 2
        face = target_face_px(str(font_path), text, direction, candidate)
        error = abs(face - desired_face_px)
        if error < best_error:
            best_size, best_error = candidate, error
        if face < desired_face_px:
            low = candidate + 1
        else:
            high = candidate - 1
    for candidate in range(max(4, best_size - 2), min(200, best_size + 2) + 1):
        error = abs(target_face_px(str(font_path), text, direction, candidate) - desired_face_px)
        if error < best_error:
            best_size, best_error = candidate, error
    return best_size


def relative_error(actual: float, expected: float) -> float:
    return abs(actual - expected) / max(1e-6, expected)


def percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        return 0.0
    return float(np.quantile(np.asarray(values, dtype=np.float64), quantile))


def summarize_rows(rows: Sequence[dict[str, object]]) -> dict[str, object]:
    methods = sorted({str(row["method"]) for row in rows})
    variants = sorted({str(row["variant"]) for row in rows})
    overall: dict[str, object] = {}
    by_variant: dict[str, object] = {}
    for method in methods:
        errors = [float(row["relative_error"]) for row in rows if row["method"] == method]
        overall[method] = {
            "samples": len(errors),
            "median_abs_percent_error": round(median(errors) * 100, 3),
            "p90_abs_percent_error": round(percentile(errors, 0.9) * 100, 3),
        }
        by_variant[method] = {}
        for variant in variants:
            subset = [
                float(row["relative_error"])
                for row in rows
                if row["method"] == method and row["variant"] == variant
            ]
            by_variant[method][variant] = {
                "samples": len(subset),
                "median_abs_percent_error": round(median(subset) * 100, 3) if subset else None,
                "p90_abs_percent_error": round(percentile(subset, 0.9) * 100, 3) if subset else None,
            }
    return {"overall": overall, "by_variant": by_variant}


def write_csv(path: Path, rows: Sequence[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def write_markdown(path: Path, summary: dict[str, object], case_count: int) -> None:
    overall = summary["overall"]
    assert isinstance(overall, dict)
    ranked = sorted(
        overall.items(),
        key=lambda item: float(item[1]["median_abs_percent_error"]),
    )
    lines = [
        "# Source apparent-size smoke",
        "",
        f"Synthetic source cases: {case_count}",
        "",
        "| Method | Median absolute error | P90 absolute error | Samples |",
        "|---|---:|---:|---:|",
    ]
    for method, metrics in ranked:
        lines.append(
            f"| {method} | {metrics['median_abs_percent_error']:.2f}% | "
            f"{metrics['p90_abs_percent_error']:.2f}% | {metrics['samples']} |"
        )
    lines.extend(
        [
            "",
            "Errors compare the rendered Korean core-glyph cross size with the known Japanese core-glyph cross size.",
            "`detector-box-nominal` mirrors the common OCR-box thickness heuristic; calibrated methods use the actual target font renderer.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def contact_sheet(path: Path, examples: Sequence[tuple[RenderedLine, str]]) -> None:
    if not examples:
        return
    tile_width, tile_height = 320, 190
    columns = 3
    rows = math.ceil(len(examples) / columns)
    sheet = Image.new("RGB", (tile_width * columns, tile_height * rows), (30, 33, 40))
    draw = ImageDraw.Draw(sheet)
    label_font = ImageFont.load_default()
    for index, (rendered, label) in enumerate(examples):
        x = (index % columns) * tile_width
        y = (index // columns) * tile_height
        preview = rendered.image.copy()
        preview.thumbnail((tile_width - 20, tile_height - 48), Image.Resampling.LANCZOS)
        preview_x = x + (tile_width - preview.width) // 2
        preview_y = y + 8
        sheet.paste(preview, (preview_x, preview_y))
        draw.rectangle(
            (
                preview_x + rendered.detector_bbox[0] * preview.width / rendered.image.width,
                preview_y + rendered.detector_bbox[1] * preview.height / rendered.image.height,
                preview_x + rendered.detector_bbox[2] * preview.width / rendered.image.width,
                preview_y + rendered.detector_bbox[3] * preview.height / rendered.image.height,
            ),
            outline=(255, 153, 0),
            width=1,
        )
        draw.text((x + 8, y + tile_height - 32), label, font=label_font, fill=(235, 238, 244))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def build_cases(max_cases: int, seed: int) -> list[tuple[str, Path, str, str, int, str, str]]:
    cases = [
        (font_name, font_path, source_text, target_text, size, direction, variant)
        for font_name, font_path in SOURCE_FONTS
        for source_text, target_text in TEXT_PAIRS
        for size in SIZES
        for direction in DIRECTIONS
        for variant in VARIANTS
    ]
    random.Random(seed).shuffle(cases)
    return cases[:max_cases]


def run(args: argparse.Namespace) -> int:
    cv2.setNumThreads(1)
    target_fonts = ALL_TARGET_FONTS if args.target_set == "all" else CORE_TARGET_FONTS
    missing = [str(path) for _name, path in (*SOURCE_FONTS, *target_fonts) if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing fonts: {missing}")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases = build_cases(args.max_cases, args.seed)
    result_rows: list[dict[str, object]] = []
    source_rows: list[dict[str, object]] = []
    examples: list[tuple[RenderedLine, str]] = []

    for case_index, (source_font, source_path, source_text, target_text, size, direction, variant) in enumerate(cases):
        rendered = render_source_line(
            source_path,
            source_text,
            size,
            direction,
            variant,
            args.seed + case_index,
        )
        estimated_mask, component_count = estimate_core_mask(rendered.image, rendered.detector_bbox)
        estimated_geometry = mask_geometry(estimated_mask, direction)
        x1, y1, x2, y2 = rendered.detector_bbox
        detector_axis_cross = float(y2 - y1 if direction == "horizontal" else x2 - x1)
        glyph_count = max(1, len(visible_glyphs(source_text)))
        detector_major = float(x2 - x1 if direction == "horizontal" else y2 - y1)
        pitch = detector_major / glyph_count
        hybrid_face = min(
            estimated_geometry.oriented_cross_px,
            pitch * 1.08,
        )
        confidence = (
            0.002 <= estimated_geometry.foreground_ratio <= 0.55
            and component_count > 0
            and 0.45 <= estimated_geometry.oriented_cross_px / max(1.0, pitch) <= 1.45
        )
        source_rows.append(
            {
                "source_font": source_font,
                "source_text": source_text,
                "source_nominal_px": size,
                "direction": direction,
                "variant": variant,
                "true_face_px": round(rendered.true_face_px, 4),
                "detector_axis_cross_px": round(detector_axis_cross, 4),
                "otsu_axis_cross_px": round(estimated_geometry.axis_cross_px, 4),
                "otsu_oriented_cross_px": round(estimated_geometry.oriented_cross_px, 4),
                "pitch_px": round(pitch, 4),
                "hybrid_face_px": round(hybrid_face, 4),
                "foreground_ratio": round(estimated_geometry.foreground_ratio, 6),
                "component_count": component_count,
                "confidence": confidence,
            }
        )
        if len(examples) < 15 and (case_index % max(1, len(cases) // 15) == 0):
            examples.append(
                (
                    rendered,
                    f"{source_font} {size}px {direction[:1]} {variant} true={rendered.true_face_px:.1f} est={estimated_geometry.oriented_cross_px:.1f}",
                )
            )

        desired_faces = {
            "detector-box-calibrated": detector_axis_cross,
            "otsu-axis-calibrated": estimated_geometry.axis_cross_px,
            "otsu-oriented-calibrated": estimated_geometry.oriented_cross_px,
            "hybrid-calibrated": hybrid_face,
            "oracle-core-calibrated": rendered.true_face_px,
        }
        for target_font, target_path in target_fonts:
            nominal_face = target_face_px(str(target_path), target_text, direction, size)
            result_rows.append(
                {
                    "source_font": source_font,
                    "target_font": target_font,
                    "source_text": source_text,
                    "target_text": target_text,
                    "source_nominal_px": size,
                    "direction": direction,
                    "variant": variant,
                    "method": "same-nominal-oracle",
                    "predicted_target_px": size,
                    "desired_face_px": round(rendered.true_face_px, 4),
                    "rendered_target_face_px": round(nominal_face, 4),
                    "relative_error": relative_error(nominal_face, rendered.true_face_px),
                    "confidence": confidence,
                }
            )
            detector_nominal_face = target_face_px(
                str(target_path), target_text, direction, max(4, min(200, round(detector_axis_cross)))
            )
            result_rows.append(
                {
                    "source_font": source_font,
                    "target_font": target_font,
                    "source_text": source_text,
                    "target_text": target_text,
                    "source_nominal_px": size,
                    "direction": direction,
                    "variant": variant,
                    "method": "detector-box-nominal",
                    "predicted_target_px": max(4, min(200, round(detector_axis_cross))),
                    "desired_face_px": round(rendered.true_face_px, 4),
                    "rendered_target_face_px": round(detector_nominal_face, 4),
                    "relative_error": relative_error(detector_nominal_face, rendered.true_face_px),
                    "confidence": confidence,
                }
            )
            for method, desired_face in desired_faces.items():
                target_size = calibrated_target_size(target_path, target_text, direction, desired_face)
                actual_face = target_face_px(str(target_path), target_text, direction, target_size)
                result_rows.append(
                    {
                        "source_font": source_font,
                        "target_font": target_font,
                        "source_text": source_text,
                        "target_text": target_text,
                        "source_nominal_px": size,
                        "direction": direction,
                        "variant": variant,
                        "method": method,
                        "predicted_target_px": target_size,
                        "desired_face_px": round(rendered.true_face_px, 4),
                        "rendered_target_face_px": round(actual_face, 4),
                        "relative_error": relative_error(actual_face, rendered.true_face_px),
                        "confidence": confidence,
                    }
                )
        if (case_index + 1) % 32 == 0 or case_index + 1 == len(cases):
            print(f"processed {case_index + 1}/{len(cases)} source cases", flush=True)

    summary = summarize_rows(result_rows)
    summary["source_cases"] = len(cases)
    summary["target_font_count"] = len(target_fonts)
    summary["low_confidence_source_cases"] = sum(not bool(row["confidence"]) for row in source_rows)
    write_csv(output / "source-estimates.csv", source_rows)
    write_csv(output / "target-match-results.csv", result_rows)
    (output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_markdown(output / "report.md", summary, len(cases))
    contact_sheet(output / "contact-sheet.png", examples)
    print(output / "report.md")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default=str(ROOT / ".tmp" / "source-font-size-smoke"),
        help="Output directory (default: %(default)s)",
    )
    parser.add_argument("--max-cases", type=int, default=160)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--target-set", choices=("core", "all"), default="core")
    args = parser.parse_args(argv)
    if args.max_cases <= 0:
        parser.error("--max-cases must be positive")
    return args


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
