#!/usr/bin/env python3
"""Build one labeled A/B/C comparison image for every selected manga page."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


PANEL_COLORS = ("#262626", "#174c85", "#17653b")
KOREAN_FONT_CANDIDATES = (
    Path(r"C:\Windows\Fonts\malgunbd.ttf"),
    Path(r"C:\Windows\Fonts\malgun.ttf"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--baseline-run", required=True, type=Path)
    parser.add_argument("--qat-run", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default="Gemma 4 12B 번역 비교 · 14화")
    parser.add_argument("--baseline-label", default="B · 기존 Gemma 4 12B")
    parser.add_argument("--qat-label", default="C · 신규 QAT 12B + MTP")
    return parser.parse_args()


def read_manifest(path: Path) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise ValueError(f"Empty comparison manifest: {path}")
    return rows


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in KOREAN_FONT_CANDIDATES:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rendered_path(run_dir: Path, page_number: int) -> Path:
    return run_dir / "pages" / f"{page_number:02d}" / "rendered.png"


def normalized_panel(image: Image.Image, width: int, height: int) -> Image.Image:
    result = Image.new("RGB", (width, height), "white")
    fitted = ImageOps.contain(image.convert("RGB"), (width, height), Image.Resampling.LANCZOS)
    result.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
    return result


def build_composite(
    images: list[Image.Image],
    *,
    title: str,
    panel_labels: tuple[str, str, str],
    page_number: int,
    page_count: int,
) -> Image.Image:
    panel_width = max(image.width for image in images)
    panel_height = max(image.height for image in images)
    outer_padding = 18
    separator = 10
    title_height = 82
    label_height = 92
    canvas_width = outer_padding * 2 + panel_width * 3 + separator * 2
    canvas_height = outer_padding * 2 + title_height + label_height + panel_height
    canvas = Image.new("RGB", (canvas_width, canvas_height), "#e8e8e8")
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(31)
    label_font = load_font(34)
    detail_font = load_font(24)

    title_y = outer_padding + (title_height - 38) // 2
    draw.text((outer_padding + 8, title_y), title, fill="#171717", font=title_font)
    page_text = f"{page_number:03d} / {page_count:03d}"
    page_box = draw.textbbox((0, 0), page_text, font=detail_font)
    draw.text(
        (canvas_width - outer_padding - 8 - (page_box[2] - page_box[0]), title_y + 5),
        page_text,
        fill="#444444",
        font=detail_font,
    )

    content_y = outer_padding + title_height
    image_y = content_y + label_height
    for index, (image, label, color) in enumerate(
        zip(images, panel_labels, PANEL_COLORS, strict=True)
    ):
        x = outer_padding + index * (panel_width + separator)
        draw.rectangle((x, content_y, x + panel_width - 1, content_y + label_height - 1), fill=color)
        label_box = draw.textbbox((0, 0), label, font=label_font)
        label_x = x + (panel_width - (label_box[2] - label_box[0])) // 2
        label_y = content_y + (label_height - (label_box[3] - label_box[1])) // 2 - label_box[1]
        draw.text((label_x, label_y), label, fill="white", font=label_font)
        canvas.paste(normalized_panel(image, panel_width, panel_height), (x, image_y))
        draw.rectangle(
            (x, image_y, x + panel_width - 1, image_y + panel_height - 1),
            outline="#bcbcbc",
            width=2,
        )
    return canvas


def build_contact_sheet(composites: list[Path], output: Path) -> None:
    columns = 4
    thumb_width = 640
    gap = 22
    caption_height = 48
    font = load_font(25)
    thumbnails: list[Image.Image] = []
    for composite_path in composites:
        with Image.open(composite_path) as image:
            thumbnail = image.convert("RGB")
            thumbnail.thumbnail((thumb_width, 460), Image.Resampling.LANCZOS)
            thumbnails.append(thumbnail.copy())
    cell_height = max(image.height for image in thumbnails) + caption_height
    rows = (len(thumbnails) + columns - 1) // columns
    sheet_width = gap + columns * (thumb_width + gap)
    sheet_height = gap + rows * (cell_height + gap)
    sheet = Image.new("RGB", (sheet_width, sheet_height), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    for index, thumbnail in enumerate(thumbnails):
        row, column = divmod(index, columns)
        cell_x = gap + column * (thumb_width + gap)
        cell_y = gap + row * (cell_height + gap)
        image_x = cell_x + (thumb_width - thumbnail.width) // 2
        sheet.paste(thumbnail, (image_x, cell_y))
        caption = f"{index + 1:03d} 페이지"
        box = draw.textbbox((0, 0), caption, font=font)
        draw.text(
            (cell_x + (thumb_width - (box[2] - box[0])) // 2, cell_y + thumbnail.height + 8),
            caption,
            fill="#222222",
            font=font,
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="JPEG", quality=92, subsampling=0, optimize=True)


def main() -> int:
    args = parse_args()
    rows = read_manifest(args.manifest.resolve())
    baseline_run = args.baseline_run.resolve()
    qat_run = args.qat_run.resolve()
    output_dir = args.output.resolve()
    panel_labels = ("A · 원본", args.baseline_label, args.qat_label)
    pages_dir = output_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    inventory: list[dict] = []
    composite_paths: list[Path] = []
    for index, row in enumerate(rows, start=1):
        original = Path(row["page"]["imagePath"]).resolve()
        baseline = rendered_path(baseline_run, index)
        qat = rendered_path(qat_run, index)
        inputs = [original, baseline, qat]
        missing = [str(path) for path in inputs if not path.is_file()]
        if missing:
            raise FileNotFoundError(f"Missing comparison input(s) for page {index}: {missing}")
        with Image.open(original) as a, Image.open(baseline) as b, Image.open(qat) as c:
            composite = build_composite(
                [a.copy(), b.copy(), c.copy()],
                title=args.title,
                panel_labels=panel_labels,
                page_number=index,
                page_count=len(rows),
            )
        output_path = pages_dir / f"{index:03d}.jpg"
        composite.save(output_path, format="JPEG", quality=94, subsampling=0, optimize=True)
        composite_paths.append(output_path)
        inventory.append(
            {
                "page": index,
                "sourceName": row["page"]["name"],
                "inputs": {
                    "A_original": {"path": str(original), "sha256": sha256(original)},
                    "B_baseline": {"path": str(baseline), "sha256": sha256(baseline)},
                    "C_candidate": {"path": str(qat), "sha256": sha256(qat)},
                },
                "comparison": {
                    "path": str(output_path),
                    "sha256": sha256(output_path),
                    "width": composite.width,
                    "height": composite.height,
                },
            }
        )
        print(f"[comparison] {index:03d}/{len(rows):03d} -> {output_path}", flush=True)

    contact_sheet = output_dir / "contact-sheet.jpg"
    build_contact_sheet(composite_paths, contact_sheet)
    manifest = {
        "schemaVersion": 1,
        "title": args.title,
        "labels": list(panel_labels),
        "sourceManifest": str(args.manifest.resolve()),
        "baselineRun": str(baseline_run),
        "qatRun": str(qat_run),
        "pages": inventory,
        "contactSheet": {"path": str(contact_sheet), "sha256": sha256(contact_sheet)},
    }
    manifest_path = output_dir / "comparison-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[comparison] contact sheet -> {contact_sheet}")
    print(f"[comparison] manifest -> {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
