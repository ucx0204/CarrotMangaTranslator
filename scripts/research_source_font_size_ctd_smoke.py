#!/usr/bin/env python3
"""Compare cheap threshold masks with one-page CTD masks on manga body text.

This is deliberately a bounded research smoke, not a production migration.  It
pins the process to one logical CPU and asks CTD for one segmentation per page,
then reuses that page result for every ordinary dialogue block.
"""

from __future__ import annotations

import os

# Configure native libraries before importing NumPy, OpenCV, or ONNX Runtime.
for _name in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
):
    os.environ[_name] = "1"

if os.name == "nt":
    import ctypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _process = _kernel32.GetCurrentProcess()
    # One logical CPU plus below-normal scheduling keeps this optional smoke
    # from competing with the editor or the user's main working tree.
    _kernel32.SetProcessAffinityMask(_process, ctypes.c_size_t(1))
    _kernel32.SetPriorityClass(_process, 0x00004000)

import argparse
import csv
import json
import math
import time
from dataclasses import dataclass, replace
from pathlib import Path
from statistics import median
from typing import Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

from fontclip_glyph_mask import ComicTextMasker, GlyphMaskStats
import research_source_font_size_real_smoke as real
import research_source_font_size_smoke as synthetic


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Comparison:
    base: real.RealEstimate
    ctd_mask: np.ndarray
    ctd_face_px: float
    ctd_confidence: bool
    ctd_warning: str
    ctd_stats: GlyphMaskStats
    gated_mask: np.ndarray
    gated_face_px: float
    gated_target_size_px: int
    gated_target_face_px: float
    gated_confidence: bool
    gated_warning: str


def ctd_comparison(
    estimate: real.RealEstimate,
    page_mask: object,
) -> Comparison:
    result = page_mask.extract(estimate.bbox)
    ctd_mask = result.binary_mask > 0
    faces = real.line_core_faces(
        ctd_mask,
        estimate.direction,
        estimate.candidate_count,
    )
    ctd_face = median(faces) if faces else 0.0
    major_extent = (
        estimate.crop.height
        if estimate.direction == "vertical"
        else estimate.crop.width
    )
    source_glyphs = max(1, len(synthetic.visible_glyphs(estimate.source_text)))
    pitch = major_extent / max(1.0, source_glyphs / estimate.candidate_count)
    agreement = ctd_face / max(1.0, pitch)
    component_limit = max(12, source_glyphs * 6)
    stats = result.stats
    confidence = (
        not result.empty
        and ctd_face >= 6
        and 0.002 <= stats.ink_ratio <= 0.55
        and 0 < stats.kept_component_count <= component_limit
        and stats.border_contact_ratio <= 0.35
        and 0.38 <= agreement <= 1.55
    )
    warning = ""
    if result.empty or ctd_face < 6:
        warning = "mask-too-small"
    elif not 0.002 <= stats.ink_ratio <= 0.55:
        warning = "mask-density"
    elif stats.kept_component_count > component_limit:
        warning = "too-many-components"
    elif stats.border_contact_ratio > 0.35:
        warning = "bbox-cuts-text"
    elif not 0.38 <= agreement <= 1.55:
        warning = "geometry-disagrees"

    # CTD deliberately produces a generous text region.  Use it as a semantic
    # gate, not as the final glyph face: retain the cheap high-resolution core
    # mask only where a one-pixel-expanded CTD region says text is plausible.
    ctd_gate = cv2.dilate(
        ctd_mask.astype(np.uint8),
        np.ones((3, 3), dtype=np.uint8),
        iterations=1,
    ) > 0
    gated_mask = estimate.mask & ctd_gate
    gated_faces = real.line_core_faces(
        gated_mask,
        estimate.direction,
        estimate.candidate_count,
    )
    gated_face = median(gated_faces) if gated_faces else 0.0
    gated_ratio = float(gated_mask.sum() / max(1, gated_mask.size))
    gated_components = max(
        0,
        cv2.connectedComponents(gated_mask.astype(np.uint8), connectivity=8)[0] - 1,
    )
    gated_agreement = gated_face / max(1.0, pitch)
    gated_confidence = (
        gated_face >= 6
        and 0.002 <= gated_ratio <= 0.48
        and 0 < gated_components <= component_limit
        and 0.38 <= gated_agreement <= 1.55
    )
    gated_warning = ""
    if gated_face < 6:
        gated_warning = "mask-too-small"
    elif not 0.002 <= gated_ratio <= 0.48:
        gated_warning = "mask-density"
    elif gated_components > component_limit:
        gated_warning = "too-many-components"
    elif not 0.38 <= gated_agreement <= 1.55:
        gated_warning = "geometry-disagrees"

    probe = real.compact_visible_text(estimate.translated_text)
    target_size = (
        synthetic.calibrated_target_size(
            estimate.selected_font_path,
            probe,
            estimate.direction,
            gated_face,
        )
        if gated_face > 0
        else 12
    )
    target_face = synthetic.target_face_px(
        str(estimate.selected_font_path),
        probe,
        estimate.direction,
        target_size,
    )
    return Comparison(
        base=estimate,
        ctd_mask=ctd_mask,
        ctd_face_px=ctd_face,
        ctd_confidence=confidence,
        ctd_warning=warning,
        ctd_stats=stats,
        gated_mask=gated_mask,
        gated_face_px=gated_face,
        gated_target_size_px=target_size,
        gated_target_face_px=target_face,
        gated_confidence=gated_confidence,
        gated_warning=gated_warning,
    )


def contain(image: Image.Image, size: tuple[int, int], *, nearest: bool = False) -> Image.Image:
    method = Image.Resampling.NEAREST if nearest else Image.Resampling.LANCZOS
    return ImageOps.contain(image, size, method=method)


def paste_center(
    target: Image.Image,
    image: Image.Image,
    box: tuple[int, int, int, int],
) -> None:
    x1, y1, x2, y2 = box
    target.paste(
        image,
        (x1 + (x2 - x1 - image.width) // 2, y1 + (y2 - y1 - image.height) // 2),
    )


def build_contact_sheet(path: Path, comparisons: Sequence[Comparison]) -> None:
    columns = 2
    tile_width, tile_height = 970, 310
    rows = math.ceil(len(comparisons) / columns)
    sheet = Image.new("RGB", (tile_width * columns, tile_height * rows), (27, 30, 37))
    draw = ImageDraw.Draw(sheet)
    label_font = ImageFont.load_default()
    panel_width, panel_height = 185, 205

    for index, comparison in enumerate(comparisons):
        estimate = comparison.base
        tile_x = index % columns * tile_width
        tile_y = index // columns * tile_height
        panels = [
            contain(estimate.crop.convert("RGB"), (panel_width, panel_height)),
            contain(
                Image.fromarray((estimate.mask * 255).astype(np.uint8)).convert("RGB"),
                (panel_width, panel_height),
                nearest=True,
            ),
            contain(
                Image.fromarray((comparison.ctd_mask * 255).astype(np.uint8)).convert("RGB"),
                (panel_width, panel_height),
                nearest=True,
            ),
            contain(
                Image.fromarray((comparison.gated_mask * 255).astype(np.uint8)).convert("RGB"),
                (panel_width, panel_height),
                nearest=True,
            ),
        ]
        target_estimate = replace(
            estimate,
            mask=comparison.gated_mask,
            hybrid_face_px=comparison.gated_face_px,
            target_size_px=comparison.gated_target_size_px,
            target_face_px=comparison.gated_target_face_px,
        )
        panels.append(real.target_preview(target_estimate, (panel_width, panel_height)))
        for panel_index, panel in enumerate(panels):
            left = tile_x + 5 + panel_index * (panel_width + 8)
            paste_center(
                sheet,
                panel,
                (left, tile_y + 25, left + panel_width, tile_y + 25 + panel_height),
            )
        for panel_index, title in enumerate(("source", "Otsu", "CTD", "gated core", "Korean")):
            draw.text(
                (tile_x + 8 + panel_index * (panel_width + 8), tile_y + 7),
                title,
                font=label_font,
                fill=(216, 221, 231),
            )
        rescued = not estimate.confidence and comparison.gated_confidence
        color = (92, 214, 145) if comparison.gated_confidence else (255, 132, 111)
        draw.rectangle(
            (tile_x + 2, tile_y + 2, tile_x + tile_width - 3, tile_y + tile_height - 3),
            outline=color,
            width=2,
        )
        labels = [
            f"{estimate.page_name} {estimate.source_text[:18]} / {estimate.selected_font_id}",
            f"Otsu face={estimate.hybrid_face_px:.1f} ({'PASS' if estimate.confidence else estimate.warning})  "
            f"CTD face={comparison.ctd_face_px:.1f} ({'PASS' if comparison.ctd_confidence else comparison.ctd_warning})",
            f"gated face={comparison.gated_face_px:.1f} ({'PASS' if comparison.gated_confidence else comparison.gated_warning})  "
            f"Korean size={comparison.gated_target_size_px}px face={comparison.gated_target_face_px:.1f}  "
            f"components={comparison.ctd_stats.kept_component_count}"
            + ("  RESCUED" if rescued else ""),
        ]
        for line_index, label in enumerate(labels):
            draw.text(
                (tile_x + 8, tile_y + 240 + line_index * 20),
                label,
                font=label_font,
                fill=(237, 240, 246),
            )

    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def write_csv(path: Path, comparisons: Sequence[Comparison]) -> None:
    fields = (
        "page_name",
        "source_text",
        "direction",
        "selected_font_id",
        "otsu_face_px",
        "otsu_confidence",
        "otsu_warning",
        "ctd_face_px",
        "ctd_confidence",
        "ctd_warning",
        "gated_face_px",
        "gated_target_size_px",
        "gated_target_face_px",
        "gated_confidence",
        "gated_warning",
        "ctd_ink_ratio",
        "ctd_components",
        "ctd_border_contact_ratio",
    )
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for comparison in comparisons:
            estimate = comparison.base
            writer.writerow(
                {
                    "page_name": estimate.page_name,
                    "source_text": estimate.source_text,
                    "direction": estimate.direction,
                    "selected_font_id": estimate.selected_font_id,
                    "otsu_face_px": estimate.hybrid_face_px,
                    "otsu_confidence": estimate.confidence,
                    "otsu_warning": estimate.warning,
                    "ctd_face_px": comparison.ctd_face_px,
                    "ctd_confidence": comparison.ctd_confidence,
                    "ctd_warning": comparison.ctd_warning,
                    "gated_face_px": comparison.gated_face_px,
                    "gated_target_size_px": comparison.gated_target_size_px,
                    "gated_target_face_px": comparison.gated_target_face_px,
                    "gated_confidence": comparison.gated_confidence,
                    "gated_warning": comparison.gated_warning,
                    "ctd_ink_ratio": comparison.ctd_stats.ink_ratio,
                    "ctd_components": comparison.ctd_stats.kept_component_count,
                    "ctd_border_contact_ratio": comparison.ctd_stats.border_contact_ratio,
                }
            )


def run(args: argparse.Namespace) -> int:
    cv2.setNumThreads(1)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    catalog = real.read_font_catalog()
    masker = ComicTextMasker(
        args.model,
        config_path=args.config,
        preprocessor_path=args.preprocessor,
        providers=("CPUExecutionProvider",),
        threshold=args.threshold,
        min_component_pixels=args.min_component_pixels,
        strict=True,
    )
    comparisons: list[Comparison] = []
    inference_seconds: list[float] = []
    for page_value in args.page_dir:
        page_dir = Path(page_value).resolve()
        estimates = real.estimate_page(page_dir, catalog, args.blocks_per_page)
        if not estimates:
            continue
        started = time.perf_counter()
        page_mask = masker.infer_page(estimates[0].page_path)
        inference_seconds.append(time.perf_counter() - started)
        comparisons.extend(ctd_comparison(estimate, page_mask) for estimate in estimates)

    write_csv(output / "ctd-comparison.csv", comparisons)
    build_contact_sheet(output / "ctd-comparison.png", comparisons)
    summary = {
        "pages": len(inference_seconds),
        "blocks": len(comparisons),
        "ctd_inference_seconds": inference_seconds,
        "ctd_inference_median_seconds": median(inference_seconds) if inference_seconds else None,
        "otsu_confident": sum(item.base.confidence for item in comparisons),
        "ctd_confident": sum(item.ctd_confidence for item in comparisons),
        "gated_confident": sum(item.gated_confidence for item in comparisons),
        "rescued_by_ctd": sum(
            not item.base.confidence and item.ctd_confidence for item in comparisons
        ),
        "rejected_by_ctd": sum(
            item.base.confidence and not item.ctd_confidence for item in comparisons
        ),
        "rescued_by_gated_core": sum(
            not item.base.confidence and item.gated_confidence for item in comparisons
        ),
        "rejected_by_gated_core": sum(
            item.base.confidence and not item.gated_confidence for item in comparisons
        ),
        "provider": masker.model_info.get("provider"),
        "cpu_limit": "one logical CPU, below-normal priority",
    }
    (output / "ctd-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    print(output / "ctd-comparison.png")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-dir", action="append", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--config")
    parser.add_argument("--preprocessor")
    parser.add_argument("--blocks-per-page", type=int, default=8)
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--min-component-pixels", type=int, default=3)
    parser.add_argument(
        "--output",
        default=str(ROOT / ".tmp" / "source-font-size-ctd-smoke"),
    )
    args = parser.parse_args(argv)
    if args.blocks_per_page <= 0:
        parser.error("--blocks-per-page must be positive")
    return args


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
