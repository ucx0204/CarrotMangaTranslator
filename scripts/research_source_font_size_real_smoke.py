#!/usr/bin/env python3
"""Build a content-page contact sheet for source-apparent size estimation.

The QA artifacts do not retain each PaddleOCR candidate polygon, so this smoke
uses the merged block crop plus candidate count.  Production can do better by
running the same estimator on the original per-line OCR geometry.  The purpose
of this script is to expose false masks and implausible sizes on ordinary manga
dialogue before any production contract is changed.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import research_source_font_size_smoke as synthetic


ROOT = Path(__file__).resolve().parents[1]
FONT_ROOT = ROOT / "src" / "renderer" / "src" / "assets" / "fonts"
CATALOG_PATH = ROOT / "src" / "main" / "builtInFontMatchingCatalog.ts"


@dataclass(frozen=True)
class RealEstimate:
    page_name: str
    page_path: Path
    block_id: str
    bbox: tuple[int, int, int, int]
    crop: Image.Image
    mask: np.ndarray
    source_text: str
    translated_text: str
    direction: str
    candidate_count: int
    selected_font_id: str
    selected_font_path: Path
    bbox_line_cross_px: float
    core_line_cross_px: float
    hybrid_face_px: float
    target_size_px: int
    target_face_px: float
    foreground_ratio: float
    component_count: int
    component_limit: int
    confidence: bool
    warning: str


def read_font_catalog() -> dict[str, Path]:
    source = CATALOG_PATH.read_text(encoding="utf-8")
    pattern = re.compile(
        r'\{\s*id:\s*"([^"]+)"\s*,\s*relativePath:\s*"([^"]+)"\s*,?\s*\}',
        re.DOTALL,
    )
    return {font_id: FONT_ROOT / relative_path for font_id, relative_path in pattern.findall(source)}


def normalized_bbox_to_pixels(
    bbox: dict[str, object],
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    x = float(bbox["x"])
    y = float(bbox["y"])
    box_width = float(bbox["w"])
    box_height = float(bbox["h"])
    x1 = max(0, math.floor(x * width / 1000.0))
    y1 = max(0, math.floor(y * height / 1000.0))
    x2 = min(width, math.ceil((x + box_width) * width / 1000.0))
    y2 = min(height, math.ceil((y + box_height) * height / 1000.0))
    return x1, y1, x2, y2


def contiguous_runs(active: np.ndarray) -> list[tuple[int, int]]:
    padded = np.pad(active.astype(np.int8), (1, 1))
    changes = np.flatnonzero(np.diff(padded))
    return [(int(changes[index]), int(changes[index + 1])) for index in range(0, len(changes), 2)]


def close_projection(profile: np.ndarray, gap: int) -> np.ndarray:
    active = profile > 0
    if gap <= 0 or not active.any():
        return active
    runs = contiguous_runs(active)
    closed = active.copy()
    for (_left_start, left_end), (right_start, _right_end) in zip(runs, runs[1:]):
        if right_start - left_end <= gap:
            closed[left_end:right_start] = True
    return closed


def select_line_bands(
    mask: np.ndarray,
    direction: str,
    expected_lines: int,
) -> list[tuple[int, int]]:
    profile = mask.sum(axis=0 if direction == "vertical" else 1)
    gap = max(1, round(len(profile) * 0.012))
    runs = contiguous_runs(close_projection(profile, gap))
    minimum = max(2, round(len(profile) * 0.025))
    runs = [run for run in runs if run[1] - run[0] >= minimum]
    if not runs:
        return [(0, len(profile))]
    expected_lines = max(1, expected_lines)
    while len(runs) > expected_lines:
        merge_at = min(
            range(len(runs) - 1),
            key=lambda index: runs[index + 1][0] - runs[index][1],
        )
        runs[merge_at : merge_at + 2] = [(runs[merge_at][0], runs[merge_at + 1][1])]
    if len(runs) < expected_lines:
        # The crop artifact lacks individual OCR polygons. Equal-width bands
        # are a safer fallback than pretending the whole multi-column block is
        # one glyph face.
        step = len(profile) / expected_lines
        runs = [
            (round(index * step), round((index + 1) * step))
            for index in range(expected_lines)
        ]
    return runs


def line_core_faces(
    mask: np.ndarray,
    direction: str,
    expected_lines: int,
) -> list[float]:
    faces: list[float] = []
    for start, end in select_line_bands(mask, direction, expected_lines):
        line_mask = mask[:, start:end] if direction == "vertical" else mask[start:end, :]
        if int(line_mask.sum()) < 3:
            continue
        geometry = synthetic.mask_geometry(line_mask, direction)
        if geometry.oriented_cross_px > 0:
            faces.append(geometry.oriented_cross_px)
    return faces


def compact_visible_text(value: object, limit: int = 14) -> str:
    return "".join(synthetic.visible_glyphs(str(value or "")))[:limit]


def selected_font_by_block(inference: dict[str, object]) -> dict[str, str]:
    selected: dict[str, str] = {}
    for value in inference.get("pixelInference", []):
        if not isinstance(value, dict):
            continue
        local = value.get("localEvidence")
        if not isinstance(local, dict):
            continue
        ranked = local.get("rankedCandidates")
        if not isinstance(ranked, list) or not ranked or not isinstance(ranked[0], dict):
            continue
        block_id = str(value.get("blockId") or "")
        font_id = str(ranked[0].get("fontId") or "")
        if block_id and font_id:
            selected[block_id] = font_id
    return selected


def estimate_page(
    page_dir: Path,
    font_catalog: dict[str, Path],
    maximum_blocks: int,
) -> list[RealEstimate]:
    font_input = json.loads((page_dir / "font-input.json").read_text(encoding="utf-8"))
    inference = json.loads((page_dir / "font-inference.json").read_text(encoding="utf-8"))
    page = font_input["page"]
    image = Image.open(page["imagePath"]).convert("RGB")
    width, height = image.size
    selected = selected_font_by_block(inference)
    estimates: list[RealEstimate] = []
    for request in font_input.get("requestBlocks", []):
        item = request.get("item", {})
        source_text = compact_visible_text(item.get("sourceText") or item.get("jp"), 80)
        translated_text = compact_visible_text(item.get("translatedText") or item.get("ko"), 80)
        direction = str(item.get("direction") or "")
        role = str(item.get("textRole") or "")
        bbox = item.get("bbox")
        if (
            role != "ordinary"
            or direction not in {"horizontal", "vertical"}
            or not isinstance(bbox, dict)
            or len(source_text) < 2
            or not translated_text
        ):
            continue
        # Side advertisements and full-page title strips are not representative
        # of the content-dialogue acceptance target.
        if float(bbox.get("w", 0)) > 220 or float(bbox.get("h", 0)) > 320:
            continue
        x1, y1, x2, y2 = normalized_bbox_to_pixels(bbox, width, height)
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        crop = image.crop((x1, y1, x2, y2))
        mask, component_count = synthetic.estimate_core_mask(crop, (0, 0, crop.width, crop.height))
        candidate_ids = (
            request.get("sourceGeometryDirection", {})
            .get("candidateMembership", {})
            .get("originalCandidateIds", item.get("candidateIds", []))
        )
        candidate_count = max(1, len(candidate_ids) if isinstance(candidate_ids, list) else 1)
        line_faces = line_core_faces(mask, direction, candidate_count)
        bbox_line_cross = (
            (crop.width if direction == "vertical" else crop.height) / candidate_count
        )
        core_line_cross = median(line_faces) if line_faces else 0.0
        hybrid_face = min(core_line_cross, bbox_line_cross * 1.08) if core_line_cross else 0.0
        major_extent = crop.height if direction == "vertical" else crop.width
        pitch = major_extent / max(1, len(source_text) / candidate_count)
        agreement = hybrid_face / max(1.0, pitch)
        foreground_ratio = float(mask.sum() / max(1, mask.size))
        component_limit = max(12, len(source_text) * 6)
        confidence = (
            hybrid_face >= 6
            and 0.002 <= foreground_ratio <= 0.48
            and 0 < component_count <= component_limit
            and 0.38 <= agreement <= 1.55
        )
        warning = ""
        if hybrid_face < 6:
            warning = "mask-too-small"
        elif foreground_ratio > 0.48:
            warning = "foreground-too-dense"
        elif component_count > component_limit:
            warning = "background-texture"
        elif not 0.38 <= agreement <= 1.55:
            warning = "geometry-disagrees"

        block_id = str(request.get("blockId") or "")
        font_id = selected.get(block_id, "nanum-gothic")
        font_path = font_catalog.get(font_id, FONT_ROOT / "nanum-gothic-regular.ttf")
        target_probe = compact_visible_text(translated_text)
        target_size = (
            synthetic.calibrated_target_size(font_path, target_probe, direction, hybrid_face)
            if hybrid_face > 0
            else 12
        )
        target_face = synthetic.target_face_px(str(font_path), target_probe, direction, target_size)
        estimates.append(
            RealEstimate(
                page_name=str(page.get("name") or page_dir.name),
                page_path=Path(str(page["imagePath"])).resolve(),
                block_id=block_id,
                bbox=(x1, y1, x2, y2),
                crop=crop,
                mask=mask,
                source_text=source_text,
                translated_text=translated_text,
                direction=direction,
                candidate_count=candidate_count,
                selected_font_id=font_id,
                selected_font_path=font_path,
                bbox_line_cross_px=bbox_line_cross,
                core_line_cross_px=core_line_cross,
                hybrid_face_px=hybrid_face,
                target_size_px=target_size,
                target_face_px=target_face,
                foreground_ratio=foreground_ratio,
                component_count=component_count,
                component_limit=component_limit,
                confidence=confidence,
                warning=warning,
            )
        )
        if len(estimates) >= maximum_blocks:
            break
    return estimates


def target_preview(estimate: RealEstimate, size: tuple[int, int]) -> Image.Image:
    width, height = size
    preview = Image.new("RGB", size, (248, 248, 244))
    font = ImageFont.truetype(str(estimate.selected_font_path), estimate.target_size_px)
    text = compact_visible_text(estimate.translated_text)
    draw = ImageDraw.Draw(preview)
    if estimate.direction == "horizontal":
        bbox = font.getbbox(text)
        x = (width - (bbox[2] - bbox[0])) / 2 - bbox[0]
        y = (height - (bbox[3] - bbox[1])) / 2 - bbox[1]
        draw.text((x, y), text, font=font, fill=(18, 18, 18))
    else:
        glyphs = synthetic.visible_glyphs(text)
        cell = max(estimate.target_size_px, 8)
        start_y = max(4, (height - cell * len(glyphs)) / 2)
        for index, glyph in enumerate(glyphs):
            bbox = font.getbbox(glyph)
            x = (width - (bbox[2] - bbox[0])) / 2 - bbox[0]
            y = start_y + cell * index - bbox[1]
            draw.text((x, y), glyph, font=font, fill=(18, 18, 18))
    return preview


def build_contact_sheet(path: Path, estimates: Sequence[RealEstimate]) -> None:
    columns = 3
    tile_width, tile_height = 410, 300
    rows = math.ceil(len(estimates) / columns)
    sheet = Image.new("RGB", (tile_width * columns, tile_height * rows), (29, 32, 39))
    draw = ImageDraw.Draw(sheet)
    label_font = ImageFont.load_default()
    for index, estimate in enumerate(estimates):
        tile_x = index % columns * tile_width
        tile_y = index // columns * tile_height
        preview_height = 205
        source = estimate.crop.copy()
        source.thumbnail((195, preview_height), Image.Resampling.LANCZOS)
        mask_image = Image.fromarray((estimate.mask * 255).astype(np.uint8)).convert("RGB")
        mask_image.thumbnail((95, 95), Image.Resampling.NEAREST)
        target = target_preview(estimate, (195, preview_height))
        sheet.paste(source, (tile_x + 5 + (195 - source.width) // 2, tile_y + 5))
        sheet.paste(target, (tile_x + 210, tile_y + 5))
        sheet.paste(mask_image, (tile_x + 5, tile_y + 110))
        color = (104, 211, 145) if estimate.confidence else (255, 135, 111)
        draw.rectangle((tile_x + 2, tile_y + 2, tile_x + tile_width - 3, tile_y + tile_height - 3), outline=color, width=2)
        labels = [
            f"{estimate.page_name} {estimate.direction[0]} lines={estimate.candidate_count} {estimate.selected_font_id}",
            f"bbox/line={estimate.bbox_line_cross_px:.1f} core={estimate.core_line_cross_px:.1f} hybrid={estimate.hybrid_face_px:.1f}",
            f"target={estimate.target_size_px}px face={estimate.target_face_px:.1f} cc={estimate.component_count} {'PASS' if estimate.confidence else estimate.warning}",
        ]
        for line_index, label in enumerate(labels):
            draw.text((tile_x + 8, tile_y + 224 + line_index * 20), label, font=label_font, fill=(236, 239, 244))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def write_rows(path: Path, estimates: Sequence[RealEstimate]) -> None:
    fields = [
        "page_name",
        "page_path",
        "block_id",
        "bbox",
        "source_text",
        "translated_text",
        "direction",
        "candidate_count",
        "selected_font_id",
        "bbox_line_cross_px",
        "core_line_cross_px",
        "hybrid_face_px",
        "target_size_px",
        "target_face_px",
        "foreground_ratio",
        "component_count",
        "component_limit",
        "confidence",
        "warning",
    ]
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for estimate in estimates:
            writer.writerow({field: getattr(estimate, field) for field in fields})


def run(args: argparse.Namespace) -> int:
    cv2.setNumThreads(1)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    catalog = read_font_catalog()
    estimates: list[RealEstimate] = []
    for page in args.page_dir:
        page_dir = Path(page).resolve()
        estimates.extend(estimate_page(page_dir, catalog, args.blocks_per_page))
    write_rows(output / "real-page-estimates.csv", estimates)
    build_contact_sheet(output / "real-page-contact-sheet.png", estimates)
    summary = {
        "pages": len(args.page_dir),
        "blocks": len(estimates),
        "confident": sum(estimate.confidence for estimate in estimates),
        "abstained": sum(not estimate.confidence for estimate in estimates),
        "note": "QA artifacts use merged block crops; production should estimate from retained per-line OCR polygons.",
    }
    (output / "real-page-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    print(output / "real-page-contact-sheet.png")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-dir", action="append", required=True)
    parser.add_argument("--blocks-per-page", type=int, default=8)
    parser.add_argument(
        "--output",
        default=str(ROOT / ".tmp" / "source-font-size-real-smoke"),
    )
    args = parser.parse_args(argv)
    if args.blocks_per_page <= 0:
        parser.error("--blocks-per-page must be positive")
    return args


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
