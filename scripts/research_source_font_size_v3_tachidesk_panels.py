#!/usr/bin/env python3
"""Render held-out Tachidesk source-size changes for manual visual review."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        Path(r"C:\Windows\Fonts\meiryo.ttc"),
        Path(r"C:\Windows\Fonts\malgun.ttf"),
        Path(r"C:\Windows\Fonts\arial.ttf"),
    ):
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


def crop_bounds(
    row: dict[str, object], image: Image.Image
) -> tuple[int, int, int, int]:
    box = row["bboxPx"]
    if not isinstance(box, dict):
        raise ValueError("row is missing bboxPx")
    x1 = float(box["x1"])
    y1 = float(box["y1"])
    x2 = float(box["x2"])
    y2 = float(box["y2"])
    width = x2 - x1
    height = y2 - y1
    padding_x = max(70, width * 0.6)
    padding_y = max(70, height * 0.35)
    return (
        max(0, math.floor(x1 - padding_x)),
        max(0, math.floor(y1 - padding_y)),
        min(image.width, math.ceil(x2 + padding_x)),
        min(image.height, math.ceil(y2 + padding_y)),
    )


def fit_panel(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = min(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    panel = Image.new("RGB", (width, height), "white")
    panel.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return panel


def decorate_rows(report: dict[str, object]) -> list[dict[str, object]]:
    pages = report.get("pages")
    if not isinstance(pages, list):
        raise ValueError("report is missing pages")
    rows: list[dict[str, object]] = []
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("groups"), list):
            continue
        for group in page["groups"]:
            if not isinstance(group, dict):
                continue
            rows.append(
                {
                    **group,
                    "sampleId": page.get("sampleId"),
                    "provider": page.get("provider"),
                    "work": page.get("work"),
                    "pageIndex": page.get("pageIndex"),
                    "imagePath": page.get("analysisRasterPath")
                    or page.get("imagePath"),
                }
            )
    return rows


def face(row: dict[str, object], key: str) -> float | None:
    value = row.get(key)
    if not isinstance(value, dict):
        return None
    try:
        return float(value["facePx"])
    except (KeyError, TypeError, ValueError):
        return None


def write_panel(rows: list[dict[str, object]], output: Path, columns: int = 2) -> None:
    if not rows:
        return
    cell_width = 700
    cell_height = 430
    image_height = 315
    row_count = math.ceil(len(rows) / columns)
    sheet = Image.new("RGB", (cell_width * columns, cell_height * row_count), "#ececec")
    title_font = load_font(18)
    text_font = load_font(15)
    for index, row in enumerate(rows):
        source = Image.open(Path(str(row["imagePath"]))).convert("RGB")
        bounds = crop_bounds(row, source)
        crop = source.crop(bounds)
        box = row["bboxPx"]
        draw_crop = ImageDraw.Draw(crop)
        draw_crop.rectangle(
            (
                round(float(box["x1"]) - bounds[0]),
                round(float(box["y1"]) - bounds[1]),
                round(float(box["x2"]) - bounds[0]),
                round(float(box["y2"]) - bounds[1]),
            ),
            outline="#00a850",
            width=4,
        )
        panel = fit_panel(crop, cell_width - 20, image_height)
        cell_x = (index % columns) * cell_width
        cell_y = (index // columns) * cell_height
        sheet.paste(panel, (cell_x + 10, cell_y + 105))
        draw = ImageDraw.Draw(sheet)
        old_face = face(row, "oldEstimate")
        new_face = face(row, "newEstimate")
        ratio = row.get("ratio")
        title = (
            f"#{index + 1:02d} {row['sampleId']} p{row['pageIndex']} "
            f"lines {row['lineCount']}/{row['evidenceLineCount']}  "
            f"{old_face:.2f} -> {new_face:.2f}px  x{float(ratio):.2f}"
        )
        draw.text((cell_x + 10, cell_y + 8), title, fill="#111111", font=title_font)
        source_text = str(row.get("sourceText") or "").replace("\n", " / ")
        draw.text(
            (cell_x + 10, cell_y + 38),
            source_text[:68],
            fill="#202020",
            font=text_font,
        )
        draw.text(
            (cell_x + 10, cell_y + 66),
            str(row.get("work") or "")[:70],
            fill="#555555",
            font=text_font,
        )
        draw.rectangle(
            (cell_x, cell_y, cell_x + cell_width - 1, cell_y + cell_height - 1),
            outline="#aaaaaa",
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, optimize=True)


def write_pages(
    rows: list[dict[str, object]], output: Path, prefix: str, page_size: int
) -> list[str]:
    paths: list[str] = []
    for offset in range(0, len(rows), page_size):
        target = output / f"{prefix}-{offset // page_size + 1:02d}.png"
        write_panel(rows[offset : offset + page_size], target)
        paths.append(str(target))
    return paths


def run(args: argparse.Namespace) -> int:
    report = read_json(Path(args.report).resolve())
    rows = decorate_rows(report)
    valid = [
        row for row in rows if face(row, "oldEstimate") and face(row, "newEstimate")
    ]
    increases = sorted(
        valid, key=lambda row: float(row.get("ratio") or 1), reverse=True
    )[: args.count]
    decreases = sorted(valid, key=lambda row: float(row.get("ratio") or 1))[
        : args.count
    ]
    low = sorted(
        (row for row in valid if (face(row, "newEstimate") or math.inf) <= 14),
        key=lambda row: face(row, "newEstimate") or math.inf,
    )
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    write_panel(increases, output / "largest-increases.png")
    write_panel(decreases, output / "largest-decreases.png")
    low_paths = write_pages(low, output, "all-low", args.count)
    summary = {
        "rows": len(valid),
        "lowRows": len(low),
        "increasePanel": str(output / "largest-increases.png"),
        "decreasePanel": str(output / "largest-decreases.png"),
        "lowPanels": low_paths,
    }
    (output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=12)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
