#!/usr/bin/env python3
"""Render four-page visual QA for the meaning-free cross-script font proxy.

The font decision path receives only source pixels. OCR text is used only by
the existing renderer after a candidate has been chosen.  Ordinary blocks are
clustered by learned style codes into one or two page voices; sound effects and
other roles remain byte-for-byte from the R33 rendered page.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import math
import re
import shutil
import sys
from collections import Counter
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from safetensors.torch import load_file
from torch import Tensor


SCRIPT_DIR = Path(__file__).resolve().parent
PROXY_SCRIPT = SCRIPT_DIR / "train_manga_font_crossscript_proxy_v1.py"
SPEC = importlib.util.spec_from_file_location("crossscript_proxy_v2", PROXY_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load cross-script proxy trainer")
proxy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = proxy
SPEC.loader.exec_module(proxy)


SCHEMA = "manga-font-crossscript-proxy-page-qa-v2"
DEFAULT_PROXY = Path("artifacts/manga-font-crossscript-proxy-v2-r1")
DEFAULT_RUNTIME = Path("src/main/runtime/font-matching-crossscript-proxy")
DEFAULT_RENDER_BANK = Path("datasets/fontclip-font-render-bank-v2")
DEFAULT_OUTPUT = Path("artifacts/manga-font-crossscript-proxy-page-qa-v1")
DEFAULT_REPORTS = (
    Path(
        "artifacts/library-full-pipeline-font-qa-v10/runs/baseline40/"
        "r33-page-majority-semantic-qa-v4/dense4-pages01-04-20260821-r1/run-report.json"
    ),
    Path(
        "artifacts/library-full-pipeline-font-qa-v10/runs/baseline40/"
        "r33-page-majority-semantic-qa-v4/single-page-07-20260821-r1/run-report.json"
    ),
    Path(
        "artifacts/library-full-pipeline-font-qa-v10/runs/baseline40/"
        "r33-page-majority-semantic-qa-v4/single-page-09-20260821-r1/run-report.json"
    ),
    Path(
        "artifacts/library-full-pipeline-font-qa-v10/runs/baseline40/"
        "r33-page-majority-semantic-qa-v4/single-page-12-20260821-r1/run-report.json"
    ),
)
TARGET_SELECTION_INDICES = {1, 6, 8, 11}


class PageQaError(RuntimeError):
    pass


def _read_json(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise PageQaError(f"JSON root is not an object: {path}")
    return value


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _bbox_pixels(
    bbox: Mapping[str, Any], width: int, height: int, *, padding: int = 0
) -> tuple[int, int, int, int]:
    x = float(bbox["x"]) * width / 1000.0
    y = float(bbox["y"]) * height / 1000.0
    w = float(bbox["w"]) * width / 1000.0
    h = float(bbox["h"]) * height / 1000.0
    return (
        max(0, math.floor(x) - padding),
        max(0, math.floor(y) - padding),
        min(width, math.ceil(x + w) + padding),
        min(height, math.ceil(y + h) + padding),
    )


def _canonical_component(mask: np.ndarray) -> Tensor:
    coordinates = np.argwhere(mask > 0)
    if coordinates.size == 0:
        raise PageQaError("empty source glyph component")
    minimum_y, minimum_x = coordinates.min(axis=0)
    maximum_y, maximum_x = coordinates.max(axis=0) + 1
    cropped = mask[minimum_y:maximum_y, minimum_x:maximum_x]
    target = round(proxy.IMAGE_SIZE * 0.76)
    scale = min(target / cropped.shape[1], target / cropped.shape[0])
    resized = cv2.resize(
        cropped,
        (
            max(1, round(cropped.shape[1] * scale)),
            max(1, round(cropped.shape[0] * scale)),
        ),
        interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC,
    )
    canvas = np.zeros((proxy.IMAGE_SIZE, proxy.IMAGE_SIZE), dtype=np.float32)
    y = (proxy.IMAGE_SIZE - resized.shape[0]) // 2
    x = (proxy.IMAGE_SIZE - resized.shape[1]) // 2
    canvas[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
    canvas = cv2.GaussianBlur(canvas, (3, 3), 0.55)
    maximum = float(canvas.max())
    if maximum > 0:
        canvas /= maximum
    return torch.from_numpy(canvas)[None]


def extract_support(
    image: Image.Image,
    bbox: Mapping[str, Any],
    direction: str,
    expected_count: int,
) -> Tensor:
    grayscale = np.asarray(image.convert("L"), dtype=np.uint8)
    left, top, right, bottom = _bbox_pixels(bbox, image.width, image.height, padding=2)
    crop = grayscale[top:bottom, left:right]
    if crop.size == 0:
        raise PageQaError("empty source block crop")
    _, binary = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # OCR contributes only the number of glyph cells and writing geometry, not
    # character identities.  Equal cells preserve disconnected kana/kanji
    # strokes that connected-component extraction would tear apart.
    cell_components: list[Tensor] = []
    if expected_count >= 2:
        axis_size = crop.shape[0] if direction == "vertical" else crop.shape[1]
        boundaries = np.linspace(0, axis_size, expected_count + 1).round().astype(int)
        for index in range(expected_count):
            start = int(boundaries[index])
            stop = int(boundaries[index + 1])
            if stop <= start:
                continue
            cell = (
                binary[start:stop, :]
                if direction == "vertical"
                else binary[:, start:stop]
            )
            ink_fraction = float((cell > 0).mean())
            if ink_fraction < 0.008 or ink_fraction > 0.58:
                continue
            try:
                cell_components.append(
                    _canonical_component((cell > 0).astype(np.float32))
                )
            except PageQaError:
                continue
    if len(cell_components) >= min(3, expected_count):
        if len(cell_components) > proxy.SUPPORT_COUNT:
            positions = (
                np.linspace(0, len(cell_components) - 1, proxy.SUPPORT_COUNT)
                .round()
                .astype(int)
            )
            cell_components = [cell_components[index] for index in positions]
        seed_components = list(cell_components)
        while len(cell_components) < proxy.SUPPORT_COUNT:
            cell_components.append(
                seed_components[len(cell_components) % len(seed_components)].clone()
            )
        return torch.stack(cell_components[: proxy.SUPPORT_COUNT])
    # Join strokes within a glyph while keeping the larger inter-glyph gaps.
    joined = cv2.morphologyEx(
        binary,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    crop_area = crop.shape[0] * crop.shape[1]
    minimum_area = max(4, round(crop_area * 0.00045))
    candidates: list[tuple[int, int, int, int, int]] = []
    for label in range(1, count):
        x, y, w, h, area = (int(value) for value in stats[label])
        if area < minimum_area or area > crop_area * 0.28:
            continue
        if w < 2 or h < 2 or max(w / max(h, 1), h / max(w, 1)) > 7.0:
            continue
        touches = x <= 0 or y <= 0 or x + w >= crop.shape[1] or y + h >= crop.shape[0]
        if touches and area > crop_area * 0.02:
            continue
        candidates.append((area, x, y, w, h))
    if not candidates:
        candidates = [(int((binary > 0).sum()), 0, 0, crop.shape[1], crop.shape[0])]
    # Prefer substantial components, then restore page order only for stable display.
    candidates = sorted(candidates, reverse=True)[: max(proxy.SUPPORT_COUNT * 2, 12)]
    candidates.sort(key=lambda row: (row[2], row[1]))
    if len(candidates) > proxy.SUPPORT_COUNT:
        positions = (
            np.linspace(0, len(candidates) - 1, proxy.SUPPORT_COUNT).round().astype(int)
        )
        candidates = [candidates[index] for index in positions]
    components: list[Tensor] = []
    for _, x, y, w, h in candidates:
        component = (binary[y : y + h, x : x + w] > 0).astype(np.float32)
        components.append(_canonical_component(component))
    while len(components) < proxy.SUPPORT_COUNT:
        components.append(components[len(components) % len(components)].clone())
    return torch.stack(components[: proxy.SUPPORT_COUNT])


def _hint_glyph_size(hint: Mapping[str, Any], direction: str) -> float:
    width = max(1.0, float(hint["x2"]) - float(hint["x1"]))
    height = max(1.0, float(hint["y2"]) - float(hint["y1"]))
    glyph_count = max(
        1,
        sum(1 for character in str(hint.get("ocrText", "")) if not character.isspace()),
    )
    along = height if direction == "vertical" else width
    across = width if direction == "vertical" else height
    return min(across, along / glyph_count)


def extract_support_from_ocr_lines(
    image: Image.Image,
    candidate_ids: list[Any],
    hints_by_id: Mapping[int, Mapping[str, Any]],
    direction: str,
    fallback_bbox: Mapping[str, Any],
    fallback_count: int,
) -> Tensor:
    hints = [
        hints_by_id[int(candidate_id)]
        for candidate_id in candidate_ids
        if isinstance(candidate_id, int) and int(candidate_id) in hints_by_id
    ]
    if not hints:
        return extract_support(image, fallback_bbox, direction, fallback_count)
    maximum_size = max(_hint_glyph_size(hint, direction) for hint in hints)
    # Semantic OCR may associate furigana with the same block.  Retain the
    # dominant print scale and discard visibly smaller ruby without reading its
    # character identity.
    hints = [
        hint
        for hint in hints
        if _hint_glyph_size(hint, direction) >= maximum_size * 0.65
    ]
    grayscale = np.asarray(image.convert("L"), dtype=np.uint8)
    components: list[Tensor] = []
    for hint in hints:
        left = max(0, math.floor(float(hint["x1"])) - 2)
        top = max(0, math.floor(float(hint["y1"])) - 2)
        right = min(image.width, math.ceil(float(hint["x2"])) + 2)
        bottom = min(image.height, math.ceil(float(hint["y2"])) + 2)
        crop = grayscale[top:bottom, left:right]
        if crop.size == 0:
            continue
        _, binary = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        glyph_count = max(
            1,
            sum(
                1
                for character in str(hint.get("ocrText", ""))
                if not character.isspace()
            ),
        )
        axis_size = crop.shape[0] if direction == "vertical" else crop.shape[1]
        boundaries = np.linspace(0, axis_size, glyph_count + 1).round().astype(int)
        for index in range(glyph_count):
            start = int(boundaries[index])
            stop = int(boundaries[index + 1])
            if stop <= start:
                continue
            cell = (
                binary[start:stop, :]
                if direction == "vertical"
                else binary[:, start:stop]
            )
            ink_fraction = float((cell > 0).mean())
            if ink_fraction < 0.01 or ink_fraction > 0.62:
                continue
            try:
                components.append(_canonical_component((cell > 0).astype(np.float32)))
            except PageQaError:
                continue
    if len(components) < 3:
        return extract_support(image, fallback_bbox, direction, fallback_count)
    if len(components) > proxy.SUPPORT_COUNT:
        positions = (
            np.linspace(0, len(components) - 1, proxy.SUPPORT_COUNT).round().astype(int)
        )
        components = [components[index] for index in positions]
    seed_components = list(components)
    while len(components) < proxy.SUPPORT_COUNT:
        components.append(components[len(components) % len(seed_components)].clone())
    return torch.stack(components[: proxy.SUPPORT_COUNT])


def _load_ocr_hints(
    font_input_path: Path, chapter_id: str, page_id: str
) -> Mapping[int, Mapping[str, Any]]:
    run_root = font_input_path.resolve().parents[2]
    result_path = (
        run_root / "analysis" / chapter_id / "ocr-hints" / page_id / "result.json"
    )
    result = _read_json(result_path)
    hints = result.get("hints")
    if not isinstance(hints, list):
        raise PageQaError(f"OCR hint inventory missing: {result_path}")
    output: dict[int, Mapping[str, Any]] = {}
    for hint in hints:
        if not isinstance(hint, Mapping) or not isinstance(hint.get("id"), int):
            continue
        output[int(hint["id"])] = hint
    return output


def _kmeans(styles: Tensor, clusters: int, *, merge_singletons: bool = True) -> Tensor:
    normalized = torch.nn.functional.normalize(styles.float(), dim=1)
    if clusters == 1:
        return torch.zeros(len(styles), dtype=torch.long)
    # Deterministic farthest-point initialization.
    centroids = [normalized[0]]
    while len(centroids) < clusters:
        current = torch.stack(centroids)
        distance = 1.0 - normalized @ current.T
        index = int(distance.amin(dim=1).argmax().item())
        centroids.append(normalized[index])
    centroid_tensor = torch.stack(centroids)
    assignments = torch.zeros(len(styles), dtype=torch.long)
    for _ in range(20):
        updated = (1.0 - normalized @ centroid_tensor.T).argmin(dim=1)
        if torch.equal(updated, assignments) and _ > 0:
            break
        assignments = updated
        rows: list[Tensor] = []
        for cluster in range(clusters):
            members = normalized[assignments == cluster]
            rows.append(
                torch.nn.functional.normalize(members.mean(dim=0), dim=0)
                if len(members)
                else centroid_tensor[cluster]
            )
        centroid_tensor = torch.stack(rows)
    if not merge_singletons:
        return assignments
    # A one-row exception is too fragile for the legacy page policy; merge it.
    for cluster in range(clusters):
        if int((assignments == cluster).sum()) != 1:
            continue
        member_index = int((assignments == cluster).nonzero()[0].item())
        other = (
            1 - cluster
            if clusters == 2
            else int(
                (1.0 - normalized[member_index] @ centroid_tensor.T)
                .masked_fill(torch.arange(clusters) == cluster, math.inf)
                .argmin()
                .item()
            )
        )
        assignments[member_index] = other
    return assignments


def _render_candidate_glyphs(root: Path, candidate: Mapping[str, Any]) -> Tensor:
    path = (root / str(candidate["source_file"])).resolve()
    values = np.stack(
        [
            proxy._render_glyph(path, 0, character)
            for character in proxy.KOREAN_PROXY_GLYPHS
        ]
    )
    return torch.from_numpy(values)[:, None]


def _candidate_score(prediction: Tensor, candidate: Tensor) -> float:
    l1 = (prediction - candidate).abs().mean()
    edge = (proxy._sobel(prediction) - proxy._sobel(candidate)).abs().mean()
    projection = 0.5 * (
        (prediction.mean(dim=2) - candidate.mean(dim=2)).abs().mean()
        + (prediction.mean(dim=3) - candidate.mean(dim=3)).abs().mean()
    )
    return float((l1 + 0.35 * edge + 0.5 * projection).item())


def _fit_lines(
    text: str, font: ImageFont.FreeTypeFont, maximum_width: int
) -> list[str]:
    explicit = text.splitlines() or [text]
    lines: list[str] = []
    for source_line in explicit:
        if not source_line:
            lines.append("")
            continue
        current = ""
        for character in source_line:
            candidate = current + character
            if current and font.getlength(candidate) > maximum_width:
                lines.append(current.rstrip())
                current = character.lstrip()
            else:
                current = candidate
        if current:
            lines.append(current.rstrip())
    return lines or [text]


def _fit_text(
    text: str, font_path: Path, face_index: int, width: int, height: int
) -> tuple[ImageFont.FreeTypeFont, list[str], int, int]:
    maximum = max(8, min(96, round(height * 0.75), round(width * 0.65)))
    for size in range(maximum, 7, -1):
        font = ImageFont.truetype(str(font_path), size=size, index=face_index)
        lines = _fit_lines(text, font, max(4, width - 4))
        spacing = max(1, round(size * 0.12))
        line_height = max(font.getbbox("가")[3] - font.getbbox("가")[1], size)
        total_height = len(lines) * line_height + max(0, len(lines) - 1) * spacing
        if total_height <= height - 2 and all(
            font.getlength(line) <= width - 2 for line in lines
        ):
            return font, lines, spacing, line_height
    font = ImageFont.truetype(str(font_path), size=8, index=face_index)
    return font, _fit_lines(text, font, max(4, width - 2)), 1, 8


def _draw_replacement(
    canvas: Image.Image,
    cleaned: Image.Image,
    bbox: Mapping[str, Any],
    text: str,
    font_path: Path,
    outline_scale: float,
) -> None:
    left, top, right, bottom = _bbox_pixels(bbox, canvas.width, canvas.height)
    padding = max(3, round(max(right - left, bottom - top) * 0.035))
    erase = (
        max(0, left - padding),
        max(0, top - padding),
        min(canvas.width, right + padding),
        min(canvas.height, bottom + padding),
    )
    canvas.paste(cleaned.crop(erase), erase[:2])
    width = max(1, right - left)
    height = max(1, bottom - top)
    font, lines, spacing, line_height = _fit_text(text, font_path, 0, width, height)
    stroke = max(1, round(font.size * 0.045 * max(0.5, outline_scale)))
    total_height = len(lines) * line_height + max(0, len(lines) - 1) * spacing
    y = top + (height - total_height) / 2
    draw = ImageDraw.Draw(canvas)
    for line in lines:
        line_width = float(font.getlength(line))
        x = left + (width - line_width) / 2
        draw.text(
            (round(x), round(y)),
            line,
            font=font,
            fill="#111111",
            stroke_width=stroke,
            stroke_fill="#ffffff",
        )
        y += line_height + spacing


def _label_font(root: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(
        str(root / "src/renderer/src/assets/fonts/nanum-gothic-bold.ttf"), size=size
    )


def _write_panel(root: Path, old: Image.Image, new: Image.Image, path: Path) -> None:
    target_height = 1050
    scale = min(target_height / old.height, 1.0)
    size = (round(old.width * scale), round(old.height * scale))
    old_small = old.resize(size, Image.Resampling.LANCZOS)
    new_small = new.resize(size, Image.Resampling.LANCZOS)
    header = 66
    gap = 18
    panel = Image.new("RGB", (size[0] * 2 + gap, size[1] + header), "#ececec")
    panel.paste(old_small, (0, header))
    panel.paste(new_small, (size[0] + gap, header))
    draw = ImageDraw.Draw(panel)
    font = _label_font(root, 28)
    draw.text((20, 17), "A · 기존 R33", fill="#111111", font=font)
    draw.text(
        (size[0] + gap + 20, 17),
        "B · 신형 의미-차단 생성/검색",
        fill="#111111",
        font=font,
    )
    panel.save(path)
    old_small.close()
    new_small.close()
    panel.close()


def _write_voice_detail(
    root: Path,
    supports: Tensor,
    generated: Tensor,
    candidate: Tensor,
    candidate_label: str,
    path: Path,
) -> None:
    canvas = Image.new("RGB", (1040, 420), "white")
    draw = ImageDraw.Draw(canvas)
    small = _label_font(root, 20)
    large = _label_font(root, 27)
    draw.text((20, 14), "실제 일본어 픽셀 조각 8개", fill="black", font=small)
    for index in range(proxy.SUPPORT_COUNT):
        glyph = proxy._ink_to_pil(supports[index, 0], 72)
        canvas.paste(glyph, (20 + index * 78, 48))
        glyph.close()
    draw.text((100, 158), "AI 생성 ‘가’", fill="black", font=large)
    draw.text(
        (590, 158), f"검색 1위 ‘가’ · {candidate_label}", fill="black", font=large
    )
    left = proxy._ink_to_pil(generated, 200)
    right = proxy._ink_to_pil(candidate, 200)
    canvas.paste(left, (125, 204))
    canvas.paste(right, (640, 204))
    left.close()
    right.close()
    canvas.save(path)
    canvas.close()


def _production_page_input(
    page_object: Mapping[str, Any],
    decisions: list[Any],
    cleaned_path: Path,
) -> dict[str, Any]:
    page = copy.deepcopy(dict(page_object))
    blocks = page.get("blocks")
    if not isinstance(blocks, list) or len(blocks) != len(decisions):
        raise PageQaError("production page/decision block inventory drifted")
    page["imagePath"] = str(cleaned_path.resolve())
    page["inpaintedImagePath"] = str(cleaned_path.resolve())
    page["dataUrl"] = ""
    for index, (block, decision) in enumerate(zip(blocks, decisions, strict=True)):
        if not isinstance(block, dict) or not isinstance(decision, Mapping):
            raise PageQaError(f"invalid production block decision at {index}")
        if decision.get("blockIndex") != index or decision.get("blockId") != block.get(
            "id"
        ):
            raise PageQaError(f"production block decision identity drifted at {index}")
        block["bbox"] = copy.deepcopy(decision["bbox"])
        block["translatedText"] = str(decision.get("translatedText", ""))
        effective_font = decision.get("effectiveFontFamily")
        if isinstance(effective_font, str) and effective_font:
            block["fontFamily"] = effective_font
        effective_outline = decision.get("effectiveOutlineWidthScale")
        if isinstance(effective_outline, (int, float)) and math.isfinite(
            float(effective_outline)
        ):
            block["outlineWidthScale"] = float(effective_outline)
        effective_text_color = decision.get("effectiveTextColor")
        if isinstance(effective_text_color, str) and effective_text_color:
            block["textColor"] = effective_text_color
        effective_outline_color = decision.get("effectiveOutlineColor")
        if isinstance(effective_outline_color, str) and effective_outline_color:
            block["outlineColor"] = effective_outline_color
        role = decision.get("role")
        if isinstance(role, str) and role:
            block["fontRole"] = role
    return page


def _candidate_bold(candidate: Mapping[str, Any]) -> bool:
    match = re.search(r"/w(\d+)/", str(candidate.get("display_id", "")))
    return bool(match and int(match.group(1)) >= 600)


def _load_weight_calibration(runtime_dir: Path) -> Mapping[str, float]:
    manifest = _read_json(runtime_dir / "runtime-manifest.json")
    if (
        manifest.get("schema_version") != "manga-font-crossscript-proxy-runtime-v2"
        or manifest.get("owner")
        != "carrot-manga-translator/manga-font-crossscript-proxy-runtime-v2"
    ):
        raise PageQaError("weight-calibrated runtime identity drifted")
    raw = manifest.get("weight_calibration")
    if not isinstance(raw, Mapping):
        raise PageQaError("runtime weight calibration is missing")
    if (
        raw.get("kind") != "paired_cross_script_linear_ink_mass_v1"
        or raw.get("input") != "mean_canonical_japanese_support_ink"
        or raw.get("target") != "mean_canonical_korean_probe_ink"
        or raw.get("face_selection")
        != "family_rank_from_glyph_generator_then_nearest_learned_ink_mass"
    ):
        raise PageQaError("runtime weight calibration contract drifted")
    intercept = raw.get("intercept")
    slope = raw.get("slope")
    if (
        isinstance(intercept, bool)
        or not isinstance(intercept, (int, float))
        or not math.isfinite(float(intercept))
        or isinstance(slope, bool)
        or not isinstance(slope, (int, float))
        or not math.isfinite(float(slope))
        or float(slope) <= 0
    ):
        raise PageQaError("runtime weight calibration coefficients drifted")
    return {"intercept": float(intercept), "slope": float(slope)}


def _select_weight_calibrated_winner(
    ranking: list[tuple[float, Mapping[str, Any], Tensor]],
    predicted_ink_mass: float,
) -> tuple[float, Mapping[str, Any], Tensor]:
    """Preserve the learned family rank, then choose its closest learned weight."""
    if not ranking:
        raise PageQaError("candidate ranking is empty")
    family_score, family_winner, _family_glyphs = ranking[0]
    winning_family = str(family_winner.get("font_id", ""))
    family_faces = [
        row for row in ranking if str(row[1].get("font_id", "")) == winning_family
    ]
    if not family_faces:
        raise PageQaError("winning font family has no candidate faces")
    _face_score, winner, winner_glyphs = min(
        family_faces,
        key=lambda row: (
            abs(float(row[2].mean().item()) - predicted_ink_mass),
            row[0],
            int(re.search(r"/w(\d+)/", str(row[1].get("display_id", ""))).group(1))
            if re.search(r"/w(\d+)/", str(row[1].get("display_id", "")))
            else 400,
            str(row[1].get("display_id", "")),
        ),
    )
    return family_score, winner, winner_glyphs


def run(args: argparse.Namespace) -> None:
    root = Path.cwd().resolve()
    target_selection_indices = {
        int(value.strip())
        for value in str(args.target_selection_indices).split(",")
        if value.strip()
    }
    if not target_selection_indices:
        raise PageQaError("at least one target selection index is required")
    output = Path(args.output_dir).expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise PageQaError(f"output already exists: {output}")
    staging = output.with_name(output.name + ".staging")
    if staging.exists() or staging.is_symlink():
        raise PageQaError(f"staging already exists: {staging}")
    staging.mkdir(parents=True)
    try:
        proxy_dir = (root / args.proxy_dir).resolve()
        runtime_dir = (root / args.runtime_dir).resolve()
        weight_calibration = _load_weight_calibration(runtime_dir)
        state = load_file(str(proxy_dir / proxy.CHECKPOINT), device="cpu")
        model = proxy.CrossScriptProxy()
        model.load_state_dict(state, strict=True)
        device = torch.device(args.device)
        model.to(device).eval()
        faces = proxy.load_faces(root, proxy.DEFAULT_CORPUS)
        neutral_face = next(
            face
            for face in faces
            if face.face_id == "gf-notosanskr-notosanskr-instance-wght400-face0"
        )
        _, _, neutral = proxy.build_raster_cache(faces, neutral_face)
        render_manifest = _read_json(
            (root / args.render_bank / "manifest.json").resolve()
        )
        raw_candidates = render_manifest.get("candidates")
        if not isinstance(raw_candidates, list):
            raise PageQaError("render bank candidates missing")
        candidates: list[tuple[Mapping[str, Any], Tensor]] = []
        for candidate in raw_candidates:
            if not isinstance(candidate, Mapping):
                continue
            try:
                glyphs = _render_candidate_glyphs(root, candidate)
            except (OSError, ValueError, proxy.ProxyTrainingError):
                continue
            candidates.append((candidate, glyphs))
        if len(candidates) != 41:
            raise PageQaError(f"expected 41 candidate faces, got {len(candidates)}")
        page_entries: list[Mapping[str, Any]] = []
        for report_name in args.run_report:
            report_path = (root / report_name).resolve()
            report = _read_json(report_path)
            pages = report.get("pages")
            if not isinstance(pages, list):
                raise PageQaError("run report pages missing")
            for page in pages:
                if (
                    isinstance(page, Mapping)
                    and int(page.get("selectionIndex", -1)) in target_selection_indices
                ):
                    page_entries.append(page)
        if len(page_entries) != len(target_selection_indices):
            raise PageQaError(
                f"expected {len(target_selection_indices)} QA pages, got {len(page_entries)}"
            )
        summary: list[dict[str, Any]] = []
        for page in sorted(page_entries, key=lambda row: int(row["selectionIndex"])):
            page_number = int(page["selectionIndex"]) + 1
            original_path = Path(str(page["stagedOriginalImagePath"]))
            cleaned_path = Path(str(page["cleanedImagePath"]))
            rendered_path = Path(str(page["renderedImagePath"]))
            font_input_path = Path(str(page["fontInputPath"]))
            font_input = _read_json(font_input_path)
            page_object = font_input.get("page")
            if not isinstance(page_object, Mapping) or not isinstance(
                page_object.get("blocks"), list
            ):
                raise PageQaError("font input page blocks missing")
            blocks = page_object["blocks"]
            request_blocks = font_input.get("requestBlocks")
            if not isinstance(request_blocks, list) or len(request_blocks) != len(
                blocks
            ):
                raise PageQaError("font request block inventory drifted")
            hints_by_id = _load_ocr_hints(
                font_input_path,
                str(page["chapterId"]),
                str(page["sourcePageId"]),
            )
            decisions = page.get("fontDecisions")
            if not isinstance(decisions, list):
                raise PageQaError("font decisions missing")
            original = Image.open(original_path).convert("RGB")
            cleaned = Image.open(cleaned_path).convert("RGB")
            ordinary_indices = [
                index
                for index, block in enumerate(blocks)
                if isinstance(block, Mapping) and block.get("textRole") == "ordinary"
            ]
            if not ordinary_indices:
                raise PageQaError(f"page {page_number} has no ordinary blocks")
            supports = []
            for index in ordinary_indices:
                block = blocks[index]
                request_block = request_blocks[index]
                if (
                    not isinstance(request_block, Mapping)
                    or request_block.get("blockId") != block.get("id")
                    or not isinstance(request_block.get("item"), Mapping)
                ):
                    raise PageQaError(f"font request identity drifted at block {index}")
                source_text = str(block.get("sourceText", ""))
                expected_count = max(
                    1, sum(1 for character in source_text if not character.isspace())
                )
                supports.append(
                    extract_support_from_ocr_lines(
                        original,
                        list(request_block["item"].get("candidateIds", [])),
                        hints_by_id,
                        str(block.get("sourceDirection", "vertical")),
                        block["bbox"],
                        expected_count,
                    )
                )
            support_batch = torch.stack(supports).to(device)
            with torch.no_grad():
                styles = model.encode_style(support_batch).cpu()
            cluster_count = (
                int(args.voice_count)
                if int(args.voice_count) > 0
                else (2 if len(ordinary_indices) >= 6 else 1)
            )
            cluster_count = min(cluster_count, len(ordinary_indices))
            assignments = _kmeans(
                styles,
                cluster_count,
                merge_singletons=int(args.voice_count) == 0,
            )
            block_diagnostics: list[dict[str, Any]] = []
            with torch.no_grad():
                for ordinary_position, block_index in enumerate(ordinary_indices):
                    generated_block = torch.sigmoid(
                        model.decode(
                            neutral.to(device),
                            styles[ordinary_position : ordinary_position + 1]
                            .to(device)
                            .expand(len(proxy.KOREAN_PROXY_GLYPHS), -1),
                        )
                    ).cpu()
                    block_ranking = sorted(
                        (
                            (_candidate_score(generated_block, glyphs), candidate)
                            for candidate, glyphs in candidates
                        ),
                        key=lambda row: (row[0], str(row[1]["display_id"])),
                    )
                    block_diagnostics.append(
                        {
                            "block_index": block_index,
                            "assigned_voice": int(assignments[ordinary_position].item())
                            + 1,
                            "top_candidates": [
                                {
                                    "font_id": str(candidate["font_id"]),
                                    "display_id": str(candidate["display_id"]),
                                    "score": score,
                                }
                                for score, candidate in block_ranking[:5]
                            ],
                        }
                    )
            cluster_candidates: dict[int, tuple[Mapping[str, Any], Tensor, Tensor]] = {}
            cluster_rows: list[dict[str, Any]] = []
            for cluster in sorted(set(assignments.tolist())):
                member_rows = (assignments == cluster).nonzero().flatten()
                mean_style = styles[member_rows].mean(dim=0, keepdim=True).to(device)
                source_ink_mass = float(
                    torch.stack(
                        [supports[int(row)] for row in member_rows.tolist()]
                    ).mean()
                )
                predicted_ink_mass = min(
                    1.0,
                    max(
                        0.0,
                        weight_calibration["intercept"]
                        + weight_calibration["slope"] * source_ink_mass,
                    ),
                )
                with torch.no_grad():
                    generated = torch.sigmoid(
                        model.decode(
                            neutral.to(device),
                            mean_style.expand(len(proxy.KOREAN_PROXY_GLYPHS), -1),
                        )
                    ).cpu()
                ranking = sorted(
                    (
                        (
                            _candidate_score(generated, glyphs),
                            candidate,
                            glyphs,
                        )
                        for candidate, glyphs in candidates
                    ),
                    key=lambda row: (row[0], str(row[1]["display_id"])),
                )
                score, winner, winner_glyphs = _select_weight_calibrated_winner(
                    ranking, predicted_ink_mass
                )
                cluster_candidates[cluster] = (winner, winner_glyphs, generated)
                member_block_indices = [
                    ordinary_indices[int(row)] for row in member_rows.tolist()
                ]
                old_fonts = [
                    str(decisions[index].get("effectiveFontFamily"))
                    for index in member_block_indices
                ]
                detail_path = (
                    staging / f"page-{page_number:02d}-voice-{cluster + 1}.png"
                )
                _write_voice_detail(
                    root,
                    supports[int(member_rows[0])],
                    generated[0, 0],
                    winner_glyphs[0, 0],
                    str(winner["display_id"]),
                    detail_path,
                )
                cluster_rows.append(
                    {
                        "voice": cluster + 1,
                        "block_indices": member_block_indices,
                        "old_fonts": dict(Counter(old_fonts)),
                        "new_candidate_display_id": winner["display_id"],
                        "new_font_id": winner["font_id"],
                        "score": score,
                        "source_ink_mass": source_ink_mass,
                        "predicted_korean_ink_mass": predicted_ink_mass,
                        "selected_candidate_ink_mass": float(
                            winner_glyphs.mean().item()
                        ),
                        "top_candidates": [
                            {
                                "font_id": str(candidate["font_id"]),
                                "display_id": str(candidate["display_id"]),
                                "score": candidate_score,
                            }
                            for candidate_score, candidate, _glyphs in ranking[:5]
                        ],
                        "detail": detail_path.name,
                    }
                )
            baseline_page = _production_page_input(page_object, decisions, cleaned_path)
            proxy_page = copy.deepcopy(baseline_page)
            proxy_blocks = proxy_page["blocks"]
            for ordinary_position, block_index in enumerate(ordinary_indices):
                cluster = int(assignments[ordinary_position].item())
                winner = cluster_candidates[cluster][0]
                proxy_block = proxy_blocks[block_index]
                proxy_block["fontFamily"] = str(winner["font_id"])
                proxy_block["bold"] = _candidate_bold(winner)
                proxy_block["italic"] = "/italic" in str(winner.get("display_id", ""))
            baseline_input_path = staging / f"page-{page_number:02d}-r33-input.json"
            proxy_input_path = staging / f"page-{page_number:02d}-proxy-input.json"
            baseline_input_path.write_text(
                _canonical_json(baseline_page) + "\n", encoding="utf-8"
            )
            proxy_input_path.write_text(
                _canonical_json(proxy_page) + "\n", encoding="utf-8"
            )
            summary.append(
                {
                    "page_number": page_number,
                    "ordinary_block_count": len(ordinary_indices),
                    "voice_count": len(cluster_rows),
                    "voices": cluster_rows,
                    "block_diagnostics": block_diagnostics,
                    "baseline_render_input": baseline_input_path.name,
                    "proxy_render_input": proxy_input_path.name,
                    "expected_baseline_rendered_path": str(rendered_path.resolve()),
                }
            )
            original.close()
            cleaned.close()
        report = {
            "schema_version": SCHEMA,
            "status": "experimental_visual_qa_completed",
            "production_connected": False,
            "render_contract": (
                "page inputs preserve R33 geometry/text/color/outline; only ordinary "
                "fontFamily/bold/italic differ in proxy inputs"
            ),
            "font_decision_inputs": ["source_block_pixels", "learned_style_code"],
            "semantic_inputs_to_font_decision": [],
            "segmentation_inputs": [
                "semantic_ocr_line_geometry",
                "writing_direction",
                "glyph_count_only",
            ],
            "page_policy": "one-or-two learned voices; ordinary blocks only; R33 retained elsewhere",
            "weight_calibration": {
                "runtime_manifest": str(
                    (runtime_dir / "runtime-manifest.json").resolve()
                ),
                **weight_calibration,
            },
            "target_selection_indices": sorted(target_selection_indices),
            "pages": summary,
        }
        (staging / "report.json").write_text(
            _canonical_json(report) + "\n", encoding="utf-8"
        )
        staging.replace(output)
        print(
            _canonical_json(
                {"ok": True, "output": output.as_posix(), "pages": len(summary)}
            )
        )
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proxy-dir", default=str(DEFAULT_PROXY))
    parser.add_argument("--runtime-dir", default=str(DEFAULT_RUNTIME))
    parser.add_argument("--render-bank", default=str(DEFAULT_RENDER_BANK))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument(
        "--voice-count",
        type=int,
        choices=range(0, 7),
        default=0,
        help="Diagnostic fixed visual voice count; 0 preserves the legacy policy.",
    )
    parser.add_argument(
        "--target-selection-indices",
        default=",".join(str(value) for value in sorted(TARGET_SELECTION_INDICES)),
        help="Comma-separated zero-based frozen selection indices.",
    )
    parser.add_argument(
        "--run-report",
        action="append",
        default=[str(path) for path in DEFAULT_REPORTS],
    )
    return parser


if __name__ == "__main__":
    run(build_parser().parse_args())
