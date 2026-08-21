"""Render a Koharu-only bubble + text segmentation gallery for a frozen cohort.

The gallery never reads or draws the legacy app detector. It runs the pinned
KoharuLayout model on the original page images and overlays three clearly
separated classes: speech bubbles, text, and onomatopoeia.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import run_koharu_layout_qa_overlay as koharu


SCHEMA_VERSION = "koharu-bubble-text-gallery-v1"
DEFAULT_COUNT = 300
VISIBLE_CLASS_IDS = (2, 0, 1)
CLASS_COLORS = {
    2: (0, 224, 184),  # bubble: turquoise
    0: (255, 48, 180),  # text: magenta
    1: (255, 166, 0),  # SFX: orange
}
CLASS_ALPHAS = {2: 0.18, 0: 0.30, 1: 0.27}
CLASS_LABELS = {2: "BUBBLE / 말풍선", 0: "TEXT / 텍스트", 1: "SFX / 효과음"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_frozen_cohort(path: Path, count: int) -> list[dict[str, Any]]:
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"Cohort must be a regular non-link file: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or len(value) < count:
        raise RuntimeError(
            f"Cohort has {len(value) if isinstance(value, list) else 0}/{count} pages"
        )
    selected: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for raw in value[:count]:
        if not isinstance(raw, dict):
            raise RuntimeError("Cohort entries must be objects")
        image_path = Path(str(raw.get("imagePath") or "")).resolve(strict=True)
        if not image_path.is_file() or image_path.is_symlink():
            raise RuntimeError(
                f"Cohort image must be a regular non-link file: {image_path}"
            )
        resolved = str(image_path)
        if resolved in seen_paths:
            raise RuntimeError(f"Duplicate cohort image: {resolved}")
        seen_paths.add(resolved)
        selected.append({**raw, "imagePath": resolved})
    return selected


def load_font(size: int) -> ImageFont.ImageFont:
    candidates = (
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "malgun.ttf",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    )
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def union_masks(
    masks: np.ndarray,
    class_ids: np.ndarray,
    class_id: int,
    width: int,
    height: int,
) -> np.ndarray:
    union = np.zeros((height, width), dtype=np.bool_)
    for index in np.flatnonzero(class_ids == class_id):
        union |= koharu._resize_mask(masks[int(index)], width, height)
    return union


def compose_overlay(
    image: Image.Image,
    arrays: dict[str, np.ndarray],
) -> tuple[Image.Image, dict[str, Any]]:
    source = image.convert("RGB")
    width, height = source.size
    unions = {
        class_id: union_masks(
            arrays["mask"], arrays["class_id"], class_id, width, height
        )
        for class_id in VISIBLE_CLASS_IDS
    }
    pixels = np.asarray(source, dtype=np.float32).copy()
    for class_id in VISIBLE_CLASS_IDS:
        union = unions[class_id]
        color = np.asarray(CLASS_COLORS[class_id], dtype=np.float32)
        alpha = CLASS_ALPHAS[class_id]
        pixels[union] = pixels[union] * (1 - alpha) + color * alpha
    overlay = Image.fromarray(np.rint(pixels).clip(0, 255).astype(np.uint8)).convert(
        "RGBA"
    )
    edges = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for class_id in VISIBLE_CLASS_IDS:
        binary = Image.fromarray(unions[class_id].astype(np.uint8) * 255)
        expanded = np.asarray(binary.filter(ImageFilter.MaxFilter(5))) > 0
        contracted = np.asarray(binary.filter(ImageFilter.MinFilter(3))) > 0
        edge = expanded ^ contracted
        layer = np.zeros((height, width, 4), dtype=np.uint8)
        layer[edge, :3] = CLASS_COLORS[class_id]
        layer[edge, 3] = 230
        edges = Image.alpha_composite(edges, Image.fromarray(layer, mode="RGBA"))
    overlay = Image.alpha_composite(overlay, edges).convert("RGB")

    header_height = max(54, round(height * 0.043))
    framed = Image.new("RGB", (width, height + header_height), "#101820")
    framed.paste(overlay, (0, header_height))
    draw = ImageDraw.Draw(framed)
    font = load_font(max(16, header_height // 3))
    x = 14
    for class_id in VISIBLE_CLASS_IDS:
        label = CLASS_LABELS[class_id]
        swatch = max(14, header_height // 3)
        y = (header_height - swatch) // 2
        draw.rounded_rectangle(
            (x, y, x + swatch, y + swatch),
            radius=max(2, swatch // 5),
            fill=CLASS_COLORS[class_id],
        )
        x += swatch + 7
        draw.text((x, y - 2), label, font=font, fill="white")
        text_width = draw.textbbox((x, y), label, font=font)[2] - x
        x += text_width + 22

    counts = {
        koharu.CLASS_NAMES[class_id]: int(np.sum(arrays["class_id"] == class_id))
        for class_id in VISIBLE_CLASS_IDS
    }
    union_pixels = {
        koharu.CLASS_NAMES[class_id]: int(unions[class_id].sum())
        for class_id in VISIBLE_CLASS_IDS
    }
    return framed, {"counts": counts, "unionPixels": union_pixels}


def evaluate_page(
    page: dict[str, Any],
    model: Any,
    device: str,
    output_pages: Path,
    index: int,
) -> dict[str, Any]:
    import torch

    image_path = Path(page["imagePath"])
    with Image.open(image_path) as opened:
        image = opened.convert("RGB")
    if device == "cuda":
        torch.cuda.synchronize()
    started = time.perf_counter()
    with torch.inference_mode():
        raw = model.predict(
            image,
            threshold=min(koharu.CLASS_THRESHOLDS.values()),
            shape=(koharu.RESOLUTION, koharu.RESOLUTION),
            include_source_image=False,
        )
    if device == "cuda":
        torch.cuda.synchronize()
    inference_seconds = time.perf_counter() - started
    raw_arrays = koharu._normalise_detection_arrays(raw)
    keep = koharu.filter_detection_indices(
        raw_arrays["class_id"], raw_arrays["confidence"]
    )
    keep &= np.isin(raw_arrays["class_id"], VISIBLE_CLASS_IDS)
    arrays = {name: values[keep] for name, values in raw_arrays.items()}
    overlay, stats = compose_overlay(image, arrays)
    relative = Path("pages") / f"{index:03d}.jpg"
    output_path = output_pages / relative.name
    overlay.save(output_path, format="JPEG", quality=91, optimize=True, subsampling=0)
    return {
        "index": index,
        "workId": str(page.get("workId") or ""),
        "chapterId": str(page.get("chapterId") or ""),
        "pageId": str(page.get("pageId") or ""),
        "pageName": str(page.get("pageName") or image_path.name),
        "imagePath": str(image_path),
        "imageSha256": sha256_file(image_path),
        "width": image.width,
        "height": image.height,
        "overlayPath": relative.as_posix(),
        "overlaySha256": sha256_file(output_path),
        "overlayBytes": output_path.stat().st_size,
        "inferenceSeconds": round(inference_seconds, 8),
        **stats,
    }


def write_contact_sheet(records: list[dict[str, Any]], output_root: Path) -> None:
    sample = records[:24]
    thumb_width = 320
    tiles: list[Image.Image] = []
    for record in sample:
        with Image.open(output_root / record["overlayPath"]) as opened:
            image = opened.convert("RGB")
        ratio = thumb_width / image.width
        image = image.resize(
            (thumb_width, max(1, round(image.height * ratio))),
            Image.Resampling.LANCZOS,
        )
        label_height = 32
        tile = Image.new("RGB", (thumb_width, image.height + label_height), "#111")
        tile.paste(image, (0, label_height))
        ImageDraw.Draw(tile).text(
            (8, 5),
            f"#{record['index']:03d}  {record['pageName']}",
            font=load_font(17),
            fill="white",
        )
        tiles.append(tile)
    columns = 4
    rows = math.ceil(len(tiles) / columns)
    row_heights = [
        max(tile.height for tile in tiles[row * columns : (row + 1) * columns])
        for row in range(rows)
    ]
    sheet = Image.new("RGB", (thumb_width * columns, sum(row_heights)), "#0b1015")
    y = 0
    for row, row_height in enumerate(row_heights):
        for column in range(columns):
            index = row * columns + column
            if index < len(tiles):
                sheet.paste(tiles[index], (column * thumb_width, y))
        y += row_height
    sheet.save(output_root / "contact-sheet-first-24.jpg", quality=89, optimize=True)


def write_gallery(records: list[dict[str, Any]], output_root: Path) -> None:
    cards = []
    for record in records:
        counts = record["counts"]
        cards.append(
            "<article>"
            f"<h2>#{record['index']:03d} {html.escape(record['pageName'])}</h2>"
            f"<p>bubbles={counts['bubble']} text={counts['text']} "
            f"SFX={counts['onomatopoeia']} · infer={record['inferenceSeconds']:.3f}s</p>"
            f"<img loading='lazy' src='{html.escape(record['overlayPath'])}'>"
            "</article>"
        )
    document = (
        """<!doctype html><html lang="ko"><meta charset="utf-8">
<title>Koharu bubble + text segmentation · 300 pages</title>
<style>
body{font-family:system-ui;background:#0c1117;color:#eef2f7;margin:20px}header{position:sticky;top:0;z-index:2;background:#0c1117ee;padding:10px 0 16px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,560px),1fr));gap:22px}article{padding:14px;background:#171d25;border-radius:12px}img{display:block;width:100%;height:auto;border-radius:6px}h1{margin:0 0 8px}h2{font-size:16px;margin:0 0 6px}p{color:#c8d1dc;margin:4px 0 10px}.b{color:#00e0b8}.t{color:#ff30b4}.s{color:#ffa600}
</style>
<header><h1>KOHARU ONLY — 말풍선 + 텍스트 세그먼테이션</h1>
<p><b class="b">청록 = 말풍선</b> · <b class="t">자홍 = 텍스트</b> · <b class="s">주황 = 효과음</b><br>
기존 앱 말풍선 감지 결과는 이 갤러리에 전혀 포함하지 않았습니다.</p></header><main>"""
        + "\n".join(cards)
        + "</main></html>"
    )
    (output_root / "gallery.html").write_text(document, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-cohort",
        default="artifacts/koharu-bubble-layout-ab-300-v1/cohort.json",
    )
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--cache-dir", default=".tmp/koharu-layout-rfdetr-qa-v1/assets")
    parser.add_argument("--no-download", action="store_true")
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.count < 200:
        raise RuntimeError("The gallery must contain at least 200 pages")
    source_cohort = Path(args.source_cohort).resolve(strict=True)
    selected = load_frozen_cohort(source_cohort, args.count)
    output_root = Path(args.output).resolve()
    if output_root.exists():
        raise FileExistsError(f"Refusing to overwrite gallery output: {output_root}")
    output_root.mkdir(parents=True)
    output_pages = output_root / "pages"
    output_pages.mkdir()
    (output_root / "cohort.json").write_text(
        json.dumps(selected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    assets = koharu.ensure_assets(
        Path(args.cache_dir), allow_download=not args.no_download
    )
    model, runtime = koharu._load_model(Path(assets["weights"]["path"]), args.device)
    records: list[dict[str, Any]] = []
    started = time.perf_counter()
    for index, page in enumerate(selected, start=1):
        record = evaluate_page(page, model, args.device, output_pages, index)
        records.append(record)
        print(
            f"[koharu-overlay] {index}/{len(selected)} "
            f"bubble={record['counts']['bubble']} text={record['counts']['text']} "
            f"sfx={record['counts']['onomatopoeia']} infer={record['inferenceSeconds']:.3f}s",
            flush=True,
        )
    write_contact_sheet(records, output_root)
    write_gallery(records, output_root)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "completed",
        "libraryMutation": False,
        "legacyBubbleDetectorRendered": False,
        "pageCount": len(records),
        "sourceCohort": {
            "path": str(source_cohort),
            "sha256": sha256_file(source_cohort),
        },
        "koharu": {"assets": assets, "runtime": runtime},
        "rendering": {
            "visibleClasses": [koharu.CLASS_NAMES[item] for item in VISIBLE_CLASS_IDS],
            "colorsRgb": {
                koharu.CLASS_NAMES[key]: list(value)
                for key, value in CLASS_COLORS.items()
            },
            "alphas": {
                koharu.CLASS_NAMES[key]: value for key, value in CLASS_ALPHAS.items()
            },
            "panelClassRendered": False,
        },
        "wallSeconds": round(time.perf_counter() - started, 8),
        "pages": records,
    }
    report_path = output_root / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    marker = {
        "schemaVersion": SCHEMA_VERSION,
        "report": "report.json",
        "reportSha256": sha256_file(report_path),
        "pageCount": len(records),
    }
    (output_root / "result.json").write_text(
        json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main(argv: Sequence[str] | None = None) -> int:
    report = run(build_parser().parse_args(argv))
    print(
        json.dumps(
            {
                "ok": True,
                "pageCount": report["pageCount"],
                "wallSeconds": report["wallSeconds"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
