#!/usr/bin/env python3
"""Prepare source-aware auto-fit variants for production A/B/C rendering.

The experimental estimator combines deterministic OCR-box geometry, a
foreground/core mask, actual target-font raster calibration, and a tiny learned
correction trained only on synthetic Japanese text.  It never trains on the
real development or holdout pages.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import random
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median
from typing import Sequence

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import cv2
import numpy as np
from PIL import Image
from sklearn.ensemble import ExtraTreesRegressor

import research_source_font_size_real_smoke as real
import research_source_font_size_smoke as synthetic


ROOT = Path(__file__).resolve().parents[1]
FONT_ROOT = ROOT / "src" / "renderer" / "src" / "assets" / "fonts"
MARKUP_RE = re.compile(r"\[(?:/?size(?:=[^\]]+)?)\]|[*_]", re.IGNORECASE)


@dataclass(frozen=True)
class HybridConfig:
    id: str
    face_scale: float
    learned_blend: float
    quantize_px: int
    maximum_line_dispersion: float


CONFIGS = (
    HybridConfig("r01-s090-raw-q1", 0.90, 0.00, 1, 0.45),
    HybridConfig("r02-s094-raw-q1", 0.94, 0.00, 1, 0.45),
    HybridConfig("r03-s098-raw-q1", 0.98, 0.00, 1, 0.45),
    HybridConfig("r04-s102-raw-q1", 1.02, 0.00, 1, 0.45),
    HybridConfig("r05-s090-ml35-q1", 0.90, 0.35, 1, 0.40),
    HybridConfig("r06-s094-ml35-q1", 0.94, 0.35, 1, 0.40),
    HybridConfig("r07-s098-ml35-q1", 0.98, 0.35, 1, 0.40),
    HybridConfig("r08-s102-ml35-q1", 1.02, 0.35, 1, 0.40),
    HybridConfig("r09-s094-ml65-q1", 0.94, 0.65, 1, 0.35),
    HybridConfig("r10-s098-ml65-q1", 0.98, 0.65, 1, 0.35),
    HybridConfig("r11-s098-ml35-q2", 0.98, 0.35, 2, 0.40),
    HybridConfig("r12-s098-ml35-q5", 0.98, 0.35, 5, 0.40),
)


@dataclass(frozen=True)
class SourceEstimate:
    block_id: str
    direction: str
    glyph_count: int
    expected_lines: int
    bbox_cross_px: float
    bbox_major_px: float
    pitch_px: float
    raw_face_px: float
    line_dispersion: float
    foreground_ratio: float
    component_count: int
    feature_vector: tuple[float, ...]
    confident: bool
    warning: str


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


def locate_page(chapter: dict[str, object], page_id: str) -> dict[str, object]:
    pages = chapter.get("pages")
    if not isinstance(pages, list):
        raise ValueError("chapter has no pages")
    for page in pages:
        if isinstance(page, dict) and str(page.get("id") or "") == page_id:
            return page
    raise KeyError(f"page not found: {page_id}")


def bbox_to_pixels(
    block: dict[str, object], page_width: int, page_height: int
) -> tuple[int, int, int, int]:
    bbox = block.get("bbox")
    if not isinstance(bbox, dict):
        return 0, 0, 0, 0
    try:
        x = float(bbox.get("x", 0))
        y = float(bbox.get("y", 0))
        width = float(bbox.get("w", 0))
        height = float(bbox.get("h", 0))
    except (TypeError, ValueError):
        return 0, 0, 0, 0
    if str(block.get("bboxSpace") or "normalized_1000") == "pixels":
        scale_x = scale_y = 1.0
    else:
        scale_x = page_width / 1000.0
        scale_y = page_height / 1000.0
    return (
        max(0, math.floor(x * scale_x)),
        max(0, math.floor(y * scale_y)),
        min(page_width, math.ceil((x + width) * scale_x)),
        min(page_height, math.ceil((y + height) * scale_y)),
    )


def compact_text(value: object) -> str:
    return "".join(synthetic.visible_glyphs(MARKUP_RE.sub("", str(value or ""))))


def expected_line_count(glyph_count: int, cross: float, major: float) -> int:
    if glyph_count <= 1 or cross <= 0 or major <= 0:
        return 1
    estimate = math.sqrt(glyph_count * cross / major)
    maximum = max(1, min(12, math.ceil(glyph_count / 2)))
    return max(1, min(maximum, round(estimate)))


def relative_dispersion(values: Sequence[float]) -> float:
    positive = [value for value in values if value > 0]
    if len(positive) < 2:
        return 0.0
    center = median(positive)
    return median(abs(value - center) for value in positive) / max(1.0, center)


def feature_vector(
    *,
    raw_face: float,
    bbox_cross: float,
    bbox_major: float,
    pitch: float,
    foreground_ratio: float,
    component_count: int,
    glyph_count: int,
    expected_lines: int,
    line_dispersion: float,
    direction: str,
) -> tuple[float, ...]:
    return (
        raw_face / max(1.0, bbox_cross / max(1, expected_lines)),
        raw_face / max(1.0, pitch),
        bbox_cross / max(1.0, bbox_major),
        foreground_ratio,
        component_count / max(1, glyph_count),
        math.log1p(glyph_count),
        float(expected_lines),
        line_dispersion,
        1.0 if direction == "vertical" else 0.0,
    )


def estimate_source_block(
    image: Image.Image, block: dict[str, object]
) -> SourceEstimate:
    block_id = str(block.get("id") or "")
    source = compact_text(block.get("sourceText"))
    direction = str(block.get("sourceDirection") or "")
    role = str(block.get("textRole") or "ordinary")
    if role != "ordinary":
        return abstained(block_id, direction, len(source), "non-ordinary")
    if direction not in {"horizontal", "vertical"}:
        return abstained(block_id, direction, len(source), "unknown-direction")
    if not 2 <= len(source) <= 160:
        return abstained(block_id, direction, len(source), "unsupported-length")
    if block.get("autoFitText") is False:
        return abstained(block_id, direction, len(source), "manual-size")
    if any(block.get(key) for key in ("curveLayout", "perspectiveTransform", "warpTransform")):
        return abstained(block_id, direction, len(source), "transformed")
    if abs(float(block.get("rotationDeg") or 0)) > 3:
        return abstained(block_id, direction, len(source), "rotated")
    x1, y1, x2, y2 = bbox_to_pixels(block, image.width, image.height)
    if x2 - x1 < 8 or y2 - y1 < 8:
        return abstained(block_id, direction, len(source), "tiny-box")
    crop = image.crop((x1, y1, x2, y2))
    mask, components = synthetic.estimate_core_mask(
        crop, (0, 0, crop.width, crop.height)
    )
    bbox_cross = float(crop.width if direction == "vertical" else crop.height)
    bbox_major = float(crop.height if direction == "vertical" else crop.width)
    lines = expected_line_count(len(source), bbox_cross, bbox_major)
    faces = real.line_core_faces(mask, direction, lines)
    core_face = median(faces) if faces else 0.0
    line_cross = bbox_cross / max(1, lines)
    glyphs_per_line = max(1.0, len(source) / max(1, lines))
    pitch = bbox_major / glyphs_per_line
    raw_face = min(core_face, line_cross * 1.06, pitch * 1.08) if core_face else 0.0
    foreground = float(mask.sum() / max(1, mask.size))
    dispersion = relative_dispersion(faces)
    agreement = raw_face / max(1.0, pitch)
    component_limit = max(20, len(source) * 8)
    warning = ""
    if raw_face < 6:
        warning = "mask-too-small"
    elif not 0.003 <= foreground <= 0.47:
        warning = "foreground-density"
    elif components > component_limit:
        warning = "background-texture"
    elif not 0.34 <= agreement <= 1.30:
        warning = "pitch-disagrees"
    elif not 0.24 <= raw_face / max(1.0, line_cross) <= 1.08:
        warning = "line-width-disagrees"
    features = feature_vector(
        raw_face=raw_face,
        bbox_cross=bbox_cross,
        bbox_major=bbox_major,
        pitch=pitch,
        foreground_ratio=foreground,
        component_count=components,
        glyph_count=len(source),
        expected_lines=lines,
        line_dispersion=dispersion,
        direction=direction,
    )
    return SourceEstimate(
        block_id=block_id,
        direction=direction,
        glyph_count=len(source),
        expected_lines=lines,
        bbox_cross_px=bbox_cross,
        bbox_major_px=bbox_major,
        pitch_px=pitch,
        raw_face_px=raw_face,
        line_dispersion=dispersion,
        foreground_ratio=foreground,
        component_count=components,
        feature_vector=features,
        confident=not warning,
        warning=warning,
    )


def abstained(
    block_id: str, direction: str, glyph_count: int, warning: str
) -> SourceEstimate:
    return SourceEstimate(
        block_id=block_id,
        direction=direction,
        glyph_count=glyph_count,
        expected_lines=0,
        bbox_cross_px=0.0,
        bbox_major_px=0.0,
        pitch_px=0.0,
        raw_face_px=0.0,
        line_dispersion=0.0,
        foreground_ratio=0.0,
        component_count=0,
        feature_vector=(0.0,) * 9,
        confident=False,
        warning=warning,
    )


def synthetic_fonts() -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    train = list(synthetic.SOURCE_FONTS)
    validation = [
        ("dela-gothic", FONT_ROOT / "ja" / "dela-gothic-one.ttf"),
        ("reggae", FONT_ROOT / "ja" / "reggae-one.ttf"),
    ]
    return train, [(name, path) for name, path in validation if path.is_file()]


def synthetic_row(
    font_path: Path,
    text: str,
    size: int,
    direction: str,
    variant: str,
    seed: int,
) -> tuple[tuple[float, ...], float] | None:
    rendered = synthetic.render_source_line(
        font_path, text, size, direction, variant, seed
    )
    x1, y1, x2, y2 = rendered.detector_bbox
    crop = rendered.image.crop((x1, y1, x2, y2))
    mask, components = synthetic.estimate_core_mask(
        crop, (0, 0, crop.width, crop.height)
    )
    faces = real.line_core_faces(mask, direction, 1)
    core_face = median(faces) if faces else 0.0
    bbox_cross = float(crop.width if direction == "vertical" else crop.height)
    bbox_major = float(crop.height if direction == "vertical" else crop.width)
    glyph_count = max(1, len(synthetic.visible_glyphs(text)))
    pitch = bbox_major / glyph_count
    raw_face = min(core_face, bbox_cross * 1.06, pitch * 1.08) if core_face else 0.0
    if raw_face < 3 or rendered.true_face_px <= 0:
        return None
    features = feature_vector(
        raw_face=raw_face,
        bbox_cross=bbox_cross,
        bbox_major=bbox_major,
        pitch=pitch,
        foreground_ratio=float(mask.sum() / max(1, mask.size)),
        component_count=components,
        glyph_count=glyph_count,
        expected_lines=1,
        line_dispersion=0.0,
        direction=direction,
    )
    correction = math.log(rendered.true_face_px / raw_face)
    return features, correction


def train_correction_model() -> tuple[ExtraTreesRegressor, dict[str, object]]:
    train_fonts, validation_fonts = synthetic_fonts()
    texts = [pair[0] for pair in synthetic.TEXT_PAIRS] + [
        "これは秘密です",
        "本当に大丈夫？",
        "勇者の冒険",
        "そんな馬鹿な",
    ]
    sizes = (16, 22, 30, 40, 54, 72, 92)
    rows: list[tuple[tuple[float, ...], float, str]] = []
    seed = 8142
    for split, fonts in (("train", train_fonts), ("validation", validation_fonts)):
        for font_name, font_path in fonts:
            for text in texts:
                for size in sizes:
                    for direction in synthetic.DIRECTIONS:
                        for variant in synthetic.VARIANTS:
                            row = synthetic_row(
                                font_path,
                                text,
                                size,
                                direction,
                                variant,
                                seed,
                            )
                            seed += 1
                            if row is not None:
                                rows.append((row[0], row[1], split))
    train_rows = [row for row in rows if row[2] == "train"]
    validation_rows = [row for row in rows if row[2] == "validation"]
    model = ExtraTreesRegressor(
        n_estimators=64,
        max_depth=6,
        min_samples_leaf=5,
        random_state=20260825,
        n_jobs=1,
    )
    model.fit(
        np.asarray([row[0] for row in train_rows], dtype=np.float32),
        np.asarray([row[1] for row in train_rows], dtype=np.float32),
    )

    def errors(values: Sequence[tuple[tuple[float, ...], float, str]]) -> dict[str, float]:
        if not values:
            return {"samples": 0, "rawMedianPct": 0.0, "modelMedianPct": 0.0}
        features = np.asarray([row[0] for row in values], dtype=np.float32)
        targets = np.asarray([row[1] for row in values], dtype=np.float64)
        predictions = np.clip(model.predict(features), -0.25, 0.25)
        raw = np.abs(np.exp(-targets) - 1.0) * 100
        corrected = np.abs(np.exp(predictions - targets) - 1.0) * 100
        return {
            "samples": float(len(values)),
            "rawMedianPct": round(float(np.median(raw)), 3),
            "rawP90Pct": round(float(np.quantile(raw, 0.9)), 3),
            "modelMedianPct": round(float(np.median(corrected)), 3),
            "modelP90Pct": round(float(np.quantile(corrected, 0.9)), 3),
        }

    report = {
        "model": "ExtraTreesRegressor-64xdepth6",
        "trainingFonts": [name for name, _path in train_fonts],
        "validationFonts": [name for name, _path in validation_fonts],
        "training": errors(train_rows),
        "fontDisjointValidation": errors(validation_rows),
    }
    return model, report


def selected_configs(config_ids: Sequence[str]) -> list[HybridConfig]:
    if not config_ids or config_ids == ["all"]:
        return list(CONFIGS)
    by_id = {config.id: config for config in CONFIGS}
    missing = [config_id for config_id in config_ids if config_id not in by_id]
    if missing:
        raise ValueError(f"unknown configs: {missing}")
    return [by_id[config_id] for config_id in config_ids]


def quantize(value: int, step: int) -> int:
    return max(4, min(200, int(round(value / step) * step)))


def prepare_page_variants(
    *,
    page: dict[str, object],
    page_number: int,
    config_values: Sequence[HybridConfig],
    model: ExtraTreesRegressor,
    font_catalog: dict[str, Path],
    output: Path,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    image = Image.open(Path(str(page["imagePath"]))).convert("RGB")
    blocks = page.get("blocks")
    if not isinstance(blocks, list):
        raise ValueError("page blocks are missing")
    estimates = {
        str(block.get("id") or ""): estimate_source_block(image, block)
        for block in blocks
        if isinstance(block, dict)
    }
    baseline_path = output / "pages" / f"{page_number:02d}" / "baseline.json"
    write_json(baseline_path, page)
    config_paths: dict[str, str] = {}
    detail_rows: list[dict[str, object]] = []
    for config in config_values:
        candidate = copy.deepcopy(page)
        candidate_blocks = candidate.get("blocks")
        assert isinstance(candidate_blocks, list)
        applied = 0
        for block in candidate_blocks:
            if not isinstance(block, dict):
                continue
            block_id = str(block.get("id") or "")
            estimate = estimates[block_id]
            confident = estimate.confident and estimate.line_dispersion <= config.maximum_line_dispersion
            target_font_id = str(block.get("fontFamily") or "nanum-gothic")
            font_path = font_catalog.get(
                target_font_id, FONT_ROOT / "nanum-gothic-regular.ttf"
            )
            target_text = compact_text(block.get("translatedText"))
            predicted_log = 0.0
            cap = None
            corrected_face = estimate.raw_face_px
            if confident and target_text and font_path.is_file():
                predicted_log = float(
                    np.clip(
                        model.predict(
                            np.asarray([estimate.feature_vector], dtype=np.float32)
                        )[0],
                        -0.20,
                        0.20,
                    )
                )
                corrected_face = (
                    estimate.raw_face_px
                    * math.exp(predicted_log * config.learned_blend)
                    * config.face_scale
                )
                nominal = synthetic.calibrated_target_size(
                    font_path,
                    target_text[:80],
                    estimate.direction,
                    corrected_face,
                )
                cap = quantize(nominal, config.quantize_px)
                block["sourceFontFacePx"] = round(corrected_face, 3)
                block["sourceFontSizeConfidence"] = 0.9
                block["sourceFontSizeMethod"] = "raster-core-v1"
                applied += 1
            detail_rows.append(
                {
                    "pageNumber": page_number,
                    "configId": config.id,
                    "blockId": block_id,
                    "sourceText": str(block.get("sourceText") or ""),
                    "translatedText": str(block.get("translatedText") or ""),
                    "fontFamily": target_font_id,
                    "storedFontSizePx": block.get("fontSizePx"),
                    "resolvedNominalFontSizePx": cap,
                    "sourceFontFacePx": round(corrected_face, 3),
                    "predictedLogCorrection": round(predicted_log, 6),
                    "correctedFacePx": round(corrected_face, 3),
                    "applied": cap is not None,
                    **asdict(estimate),
                    "feature_vector": list(estimate.feature_vector),
                }
            )
        candidate_path = (
            output / "pages" / f"{page_number:02d}" / f"candidate-{config.id}.json"
        )
        write_json(candidate_path, candidate)
        config_paths[config.id] = str(candidate_path.relative_to(output))
    entry = {
        "pageNumber": page_number,
        "pageId": page.get("id"),
        "pageName": page.get("name"),
        "originalImagePath": page.get("imagePath"),
        "inpaintedImagePath": page.get("inpaintedImagePath"),
        "baselinePage": str(baseline_path.relative_to(output)),
        "candidatePages": config_paths,
        "blocks": len(blocks),
        "eligibleEstimates": sum(estimate.confident for estimate in estimates.values()),
    }
    return entry, detail_rows


def run(args: argparse.Namespace) -> int:
    cv2.setNumThreads(1)
    random.seed(20260825)
    manifest = read_json(Path(args.cohorts).resolve())
    cohort = manifest.get(args.cohort)
    if not isinstance(cohort, list):
        raise ValueError(f"cohort not found: {args.cohort}")
    output = Path(args.output).resolve() / args.cohort
    output.mkdir(parents=True, exist_ok=True)
    configs = selected_configs(args.config)
    model, model_report = train_correction_model()
    write_json(output / "model-report.json", model_report)
    font_catalog = real.read_font_catalog()
    pages: list[dict[str, object]] = []
    details: list[dict[str, object]] = []
    for index, item in enumerate(cohort, start=1):
        if not isinstance(item, dict):
            continue
        snapshot_path = str(item.get("page_snapshot_path") or "")
        if snapshot_path:
            page = copy.deepcopy(read_json(Path(snapshot_path)))
        else:
            chapter = read_json(Path(str(item["chapter_path"])))
            page = copy.deepcopy(locate_page(chapter, str(item["page_id"])))
        entry, rows = prepare_page_variants(
            page=page,
            page_number=index,
            config_values=configs,
            model=model,
            font_catalog=font_catalog,
            output=output,
        )
        entry["workId"] = item.get("work_id")
        entry["workTitle"] = item.get("work_title")
        entry["chapterTitle"] = item.get("chapter_title")
        pages.append(entry)
        details.extend(rows)
    render_manifest = {
        "schemaVersion": 1,
        "cohort": args.cohort,
        "configs": [asdict(config) for config in configs],
        "pages": pages,
    }
    write_json(output / "render-manifest.json", render_manifest)
    write_json(output / "block-estimates.json", details)
    summary = {
        "cohort": args.cohort,
        "pages": len(pages),
        "configs": len(configs),
        "blocks": len({(row["pageNumber"], row["blockId"]) for row in details}),
        "manifest": str(output / "render-manifest.json"),
        "model": model_report,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cohorts", required=True)
    parser.add_argument("--cohort", choices=("development", "holdout"), required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", action="append", default=[])
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
