#!/usr/bin/env python3
"""Select reproducible Tachidesk body pages and build manual-review sheets.

The sampler deliberately avoids the first/last pages of each chapter.  It is a
research helper, not a training-data producer: the JSON manifest remains the
authority for every selected source path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
PAGE_FRACTIONS = (0.27, 0.53, 0.76)

TARGETS = (
    ("Manga Mura (JA)", "捕虜英雄~捨て胸にされた剣奴は敵国で成り上がる~"),
    (
        "Manga Mura (JA)",
        "転生しました、サラナ・キンジェです。ごきげんよう。 ～優雅なスローライフで大忙し～ "
        "転生しました、サラナ・キンジェです。ごきげんよう。 ～婚約破棄されたので田舎で"
        "気ままに暮らしたいと思います～",
    ),
    ("Raw Otaku (JA)", "俺だけレベルが上がる世界で悪徳領主になっていた"),
    (
        "Raw1001 (JA)",
        "灰の世界は神の眼で彩づく ～俺だけ見えるステータスで、最弱から最強へ駆け上がる～",
    ),
    (
        "Raw1001 (JA)",
        "大草原の小さな領主 ～元廃ゲーマーな転生幼女の楽しいハードモード辺境開拓記～",
    ),
    ("RawINU (JA)", "TENSEI RENKIN SHOUJO NO SLOW LIFE"),
    (
        "RawINU (JA)",
        "_TEIKOKU-UCHUUGUN_ SHOZOKU NO ORE DESUGA, MIKAI NO WAKUSEI NI "
        "SOUNAN SHIMASHITA. - RAW",
    ),
    ("Rawkuma (JA)", "Twin Reincarnation"),
    ("Rawkuma (JA)", "Shuuen no Majo to Sekai no Tabi"),
)


@dataclass(frozen=True)
class Sample:
    sample_id: str
    provider: str
    work: str
    chapter: str
    page_name: str
    page_index: int
    chapter_page_count: int
    image_path: Path
    width: int
    height: int
    sha256: str


def natural_key(value: str) -> list[object]:
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", value)
    ]


def image_files(directory: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.casefold() in IMAGE_SUFFIXES
        ),
        key=lambda path: natural_key(path.name),
    )


def select_chapter(work_directory: Path) -> tuple[Path, list[Path]]:
    eligible: list[tuple[Path, list[Path]]] = []
    for chapter in sorted(
        (path for path in work_directory.iterdir() if path.is_dir()),
        key=lambda path: natural_key(path.name),
    ):
        pages = image_files(chapter)
        if len(pages) >= 12:
            eligible.append((chapter, pages))
    if not eligible:
        raise RuntimeError(f"No chapter with at least 12 images: {work_directory}")
    # The median chapter avoids both volume-opening material and the newest tail.
    return eligible[len(eligible) // 2]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def select_samples(root: Path) -> list[Sample]:
    samples: list[Sample] = []
    for work_index, (provider, work) in enumerate(TARGETS, start=1):
        work_directory = root / provider / work
        chapter, pages = select_chapter(work_directory)
        # Reserve three pages at the front and two at the back.  This excludes
        # covers, credits, next-chapter cards, and most chapter-title splashes.
        body_pages = pages[3:-2]
        chosen_indexes: list[int] = []
        for fraction in PAGE_FRACTIONS:
            body_index = min(
                len(body_pages) - 1, round((len(body_pages) - 1) * fraction)
            )
            page = body_pages[body_index]
            page_index = pages.index(page)
            if page_index in chosen_indexes:
                continue
            chosen_indexes.append(page_index)
            with Image.open(page) as image:
                width, height = image.size
            sample_number = len(chosen_indexes)
            samples.append(
                Sample(
                    sample_id=f"W{work_index:02d}-P{sample_number:02d}",
                    provider=provider,
                    work=work,
                    chapter=chapter.name,
                    page_name=page.name,
                    page_index=page_index + 1,
                    chapter_page_count=len(pages),
                    image_path=page.resolve(),
                    width=width,
                    height=height,
                    sha256=sha256_file(page),
                )
            )
    return samples


def materialize_analysis_rasters(
    samples: list[Sample], output_directory: Path
) -> dict[str, Path]:
    raster_directory = output_directory / "analysis-rasters"
    raster_directory.mkdir(parents=True, exist_ok=True)
    rasters: dict[str, Path] = {}
    for sample in samples:
        destination = raster_directory / f"{sample.sample_id}.png"
        with Image.open(sample.image_path) as source:
            # Keep the raw pixel orientation because OCR coordinates are bound
            # to that same decoded frame.  PNG is only a lossless decoder bridge
            # for Electron builds that cannot decode every Tachidesk WebP file.
            source.convert("RGB").save(destination, optimize=True)
        rasters[sample.sample_id] = destination.resolve()
    return rasters


def write_manifest(
    samples: list[Sample],
    rasters: dict[str, Path],
    output: Path,
    source_root: Path,
) -> None:
    records = [
        {
            "sampleId": sample.sample_id,
            "provider": sample.provider,
            "work": sample.work,
            "chapter": sample.chapter,
            "pageName": sample.page_name,
            "pageIndex": sample.page_index,
            "chapterPageCount": sample.chapter_page_count,
            "imagePath": str(sample.image_path),
            "analysisRasterPath": str(rasters[sample.sample_id]),
            "width": sample.width,
            "height": sample.height,
            "sha256": sample.sha256,
            "coverPolicy": "chapter_pages_4_through_penultimate_2_only",
        }
        for sample in samples
    ]
    payload = {
        "schemaVersion": 1,
        "sourceRoot": str(source_root.resolve()),
        "selectionPolicy": {
            "works": "explicit_cross_provider_holdout",
            "chapter": "median_chapter_with_at_least_12_images",
            "pages": "27_53_76_percent_after_dropping_first_3_and_last_2",
            "covers": "excluded_and_manually_reviewed",
        },
        "sampleCount": len(records),
        "samples": records,
    }
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def draw_sheet(samples: list[Sample], output: Path, panel_index: int) -> None:
    cell_width = 390
    cell_height = 560
    label_height = 54
    columns = 3
    rows = 3
    canvas = Image.new("RGB", (cell_width * columns, cell_height * rows), "#eeeeee")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=18)
    for index, sample in enumerate(samples):
        column = index % columns
        row = index // columns
        x = column * cell_width
        y = row * cell_height
        with Image.open(sample.image_path) as source:
            source = ImageOps.exif_transpose(source).convert("RGB")
            preview = ImageOps.contain(
                source,
                (cell_width - 16, cell_height - label_height - 16),
                Image.Resampling.LANCZOS,
            )
        preview_x = x + (cell_width - preview.width) // 2
        preview_y = (
            y + label_height + (cell_height - label_height - preview.height) // 2
        )
        canvas.paste(preview, (preview_x, preview_y))
        label = (
            f"{sample.sample_id}  {sample.provider}  "
            f"page {sample.page_index}/{sample.chapter_page_count}"
        )
        draw.text((x + 8, y + 8), label, fill="#111111", font=font)
        draw.text((x + 8, y + 30), sample.page_name, fill="#555555", font=font)
        draw.rectangle(
            (x, y, x + cell_width - 1, y + cell_height - 1), outline="#b0b0b0"
        )
    canvas.save(output, optimize=True)
    print(f"panel {panel_index}: {output}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    samples = select_samples(args.root)
    rasters = materialize_analysis_rasters(samples, args.output)
    manifest_path = args.output / "tachidesk-body-samples.json"
    write_manifest(samples, rasters, manifest_path, args.root)
    for offset in range(0, len(samples), 9):
        panel_index = offset // 9 + 1
        draw_sheet(
            samples[offset : offset + 9],
            args.output / f"tachidesk-body-panel-{panel_index:02d}.png",
            panel_index,
        )
    print(json.dumps({"samples": len(samples), "manifest": str(manifest_path)}))


if __name__ == "__main__":
    main()
