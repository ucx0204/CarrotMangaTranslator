#!/usr/bin/env python3
"""Create readable A/B/C page and block panels from production renders."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
LABEL_FONT = Path("C:/Windows/Fonts/malgun.ttf")


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"expected an object: {path}")
    return value


def read_json_value(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def label_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if LABEL_FONT.is_file():
        return ImageFont.truetype(str(LABEL_FONT), size)
    return ImageFont.load_default()


def fit(image: Image.Image, maximum: tuple[int, int]) -> Image.Image:
    result = image.copy().convert("RGB")
    result.thumbnail(maximum, Image.Resampling.LANCZOS)
    return result


def labeled(image: Image.Image, text: str, width: int, height: int) -> Image.Image:
    panel = Image.new("RGB", (width, height + 42), (29, 32, 39))
    preview = fit(image, (width, height))
    panel.paste(preview, ((width - preview.width) // 2, 42 + (height - preview.height) // 2))
    draw = ImageDraw.Draw(panel)
    draw.text((12, 9), text, font=label_font(18), fill=(241, 243, 246))
    return panel


def page_triptych(
    original: Image.Image,
    baseline: Image.Image,
    candidate: Image.Image,
    title: str,
    config_id: str,
) -> Image.Image:
    column_width = 500
    image_height = 720
    heading_height = 58
    canvas = Image.new("RGB", (column_width * 3, image_height + 42 + heading_height), (19, 22, 28))
    draw = ImageDraw.Draw(canvas)
    draw.text((14, 12), title, font=label_font(22), fill=(248, 236, 222))
    panels = (
        labeled(original, "A 원본 일본어", column_width, image_height),
        labeled(baseline, "B 기존 자동 맞춤", column_width, image_height),
        labeled(candidate, f"C 원문 크기 하이브리드 · {config_id}", column_width, image_height),
    )
    for index, panel in enumerate(panels):
        canvas.paste(panel, (index * column_width, heading_height))
    return canvas


def bbox_to_pixels(
    bbox: dict[str, object], space: str, width: int, height: int
) -> tuple[int, int, int, int]:
    scale_x = 1.0 if space == "pixels" else width / 1000.0
    scale_y = 1.0 if space == "pixels" else height / 1000.0
    x = float(bbox.get("x", 0)) * scale_x
    y = float(bbox.get("y", 0)) * scale_y
    box_width = float(bbox.get("w", 0)) * scale_x
    box_height = float(bbox.get("h", 0)) * scale_y
    padding = max(12, round(min(width, height) * 0.012))
    return (
        max(0, math.floor(x - padding)),
        max(0, math.floor(y - padding)),
        min(width, math.ceil(x + box_width + padding)),
        min(height, math.ceil(y + box_height + padding)),
    )


def union_crop_box(block: dict[str, object], width: int, height: int) -> tuple[int, int, int, int]:
    boxes: list[tuple[int, int, int, int]] = []
    bbox = block.get("bbox")
    if isinstance(bbox, dict):
        boxes.append(
            bbox_to_pixels(
                bbox,
                str(block.get("bboxSpace") or "normalized_1000"),
                width,
                height,
            )
        )
    render_bbox = block.get("renderBbox")
    if isinstance(render_bbox, dict):
        boxes.append(
            bbox_to_pixels(
                render_bbox,
                str(block.get("renderBboxSpace") or "normalized_1000"),
                width,
                height,
            )
        )
    if not boxes:
        return 0, 0, width, height
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def block_sheet(
    original: Image.Image,
    baseline: Image.Image,
    candidate: Image.Image,
    candidate_page: dict[str, object],
    applied_ids: set[str],
    config_id: str,
    maximum_blocks: int = 8,
) -> Image.Image | None:
    blocks = candidate_page.get("blocks")
    if not isinstance(blocks, list):
        return None
    selected = [
        block
        for block in blocks
        if isinstance(block, dict) and str(block.get("id") or "") in applied_ids
    ][:maximum_blocks]
    if not selected:
        return None
    row_height = 250
    column_width = 410
    heading = 48
    canvas = Image.new(
        "RGB",
        (column_width * 3, heading + row_height * len(selected)),
        (24, 27, 33),
    )
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (12, 10),
        f"원문 블록별 확대 비교 · {config_id}",
        font=label_font(20),
        fill=(248, 236, 222),
    )
    for row, block in enumerate(selected):
        crop_box = union_crop_box(block, original.width, original.height)
        source = original.crop(crop_box)
        before = baseline.crop(crop_box)
        after = candidate.crop(crop_box)
        block_id = str(block.get("id") or "")[-12:]
        columns = (
            labeled(source, f"A 원문 · {block_id}", column_width, row_height - 42),
            labeled(before, "B 기존", column_width, row_height - 42),
            labeled(after, "C 새 방식", column_width, row_height - 42),
        )
        for column, panel in enumerate(columns):
            canvas.paste(panel, (column * column_width, heading + row * row_height))
    return canvas


def build_overview(path: Path, panels: Sequence[Image.Image]) -> None:
    if not panels:
        return
    tile_width = 900
    tile_height = 520
    columns = 2
    rows = math.ceil(len(panels) / columns)
    overview = Image.new("RGB", (tile_width * columns, tile_height * rows), (16, 18, 23))
    for index, panel in enumerate(panels):
        preview = fit(panel, (tile_width, tile_height))
        x = index % columns * tile_width + (tile_width - preview.width) // 2
        y = index // columns * tile_height + (tile_height - preview.height) // 2
        overview.paste(preview, (x, y))
    overview.save(path)


def run(args: argparse.Namespace) -> int:
    render_root = Path(args.render_root).resolve()
    report = read_json(render_root / "render-report.json")
    manifest_root = Path(args.manifest).resolve().parent
    manifest = read_json(Path(args.manifest).resolve())
    estimates = read_json_value(Path(args.estimates).resolve())
    rows = estimates if isinstance(estimates, list) else []
    manifest_pages = {
        int(page["pageNumber"]): page
        for page in manifest.get("pages", [])
        if isinstance(page, dict)
    }
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    config_ids = args.config or list(report.get("configIds", []))
    for config_id in config_ids:
        overview_panels: list[Image.Image] = []
        for report_page in report.get("pages", []):
            if not isinstance(report_page, dict):
                continue
            page_number = int(report_page["pageNumber"])
            candidate_relative = report_page.get("candidates", {}).get(config_id)
            if not candidate_relative:
                continue
            original = Image.open(Path(str(report_page["originalImagePath"]))).convert("RGB")
            baseline = Image.open(render_root / str(report_page["baseline"])).convert("RGB")
            candidate = Image.open(render_root / str(candidate_relative)).convert("RGB")
            if original.size != baseline.size or baseline.size != candidate.size:
                raise ValueError(f"page {page_number} raster dimensions differ")
            title = f"{page_number:02d} · {report_page.get('workTitle', '')} · {report_page.get('chapterTitle', '')}"
            triptych = page_triptych(original, baseline, candidate, title, config_id)
            triptych_path = output / f"page-{page_number:02d}-ABC-{config_id}.png"
            triptych.save(triptych_path)
            overview_panels.append(triptych)
            manifest_page = manifest_pages[page_number]
            candidate_page_path = manifest_root / str(
                manifest_page.get("candidatePages", {}).get(config_id)
            )
            candidate_page = read_json(candidate_page_path)
            applied_ids = {
                str(row.get("blockId") or "")
                for row in rows
                if isinstance(row, dict)
                and int(row.get("pageNumber") or 0) == page_number
                and str(row.get("configId") or "") == config_id
                and bool(row.get("applied"))
            }
            details = block_sheet(
                original,
                baseline,
                candidate,
                candidate_page,
                applied_ids,
                config_id,
            )
            if details is not None:
                details.save(output / f"page-{page_number:02d}-blocks-{config_id}.png")
        build_overview(output / f"overview-{config_id}.png", overview_panels)
    print(
        json.dumps(
            {"configs": config_ids, "pages": len(report.get("pages", [])), "output": str(output)},
            ensure_ascii=False,
        )
    )
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--estimates", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", action="append", default=[])
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
