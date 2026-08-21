"""Compare stored production bubble fitting with KoharuLayout masks.

This is an inference-only QA harness. It reads existing library chapter files,
never writes to the library, and creates side-by-side overlays plus aggregate
metrics in a new output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import statistics
import time
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import run_koharu_layout_qa_overlay as koharu


SCHEMA_VERSION = "koharu-bubble-layout-ab-v1"
CURRENT_MODEL_PREFIX = "comic-rtdetr-"
DEFAULT_PAGE_COUNT = 300
DEFAULT_PADDING_RATIO = 0.12
BLIND_SOURCE_COVERAGE_THRESHOLD = 0.25


def _bounded_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return value


def _is_detected_layout(block: dict[str, Any]) -> bool:
    layout = block.get("bubbleLayout")
    if not isinstance(layout, dict):
        return False
    if layout.get("origin") == "manual":
        return False
    model_id = str(layout.get("modelId") or "")
    return layout.get("origin") == "detected" or model_id.startswith(
        CURRENT_MODEL_PREFIX
    )


def collect_pages(library_root: Path) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    pattern = "works/*/chapters/*/chapter.json"
    for chapter_path in sorted(library_root.glob(pattern)):
        chapter = _load_json(chapter_path)
        work_id = str(chapter.get("workId") or "")
        chapter_id = str(chapter.get("id") or chapter_path.parent.name)
        for page in chapter.get("pages") or []:
            if not isinstance(page, dict):
                continue
            blocks = [
                block
                for block in page.get("blocks") or []
                if isinstance(block, dict) and _is_detected_layout(block)
            ]
            if not blocks:
                continue
            image_path = Path(str(page.get("imagePath") or ""))
            if not image_path.is_file() or image_path.is_symlink():
                continue
            page_id = str(page.get("id") or "")
            pages.append(
                {
                    "workId": work_id,
                    "chapterId": chapter_id,
                    "chapterTitle": str(chapter.get("title") or ""),
                    "chapterPath": str(chapter_path.resolve()),
                    "pageId": page_id,
                    "pageName": str(page.get("name") or image_path.name),
                    "imagePath": str(image_path.resolve()),
                    "pageWidth": int(page.get("width") or 0),
                    "pageHeight": int(page.get("height") or 0),
                    "blocks": blocks,
                    "selectionKey": _sha256_text(
                        f"{work_id}:{chapter_id}:{page_id}:{image_path}"
                    ),
                }
            )
    return pages


def select_round_robin_pages(
    pages: list[dict[str, Any]], count: int
) -> list[dict[str, Any]]:
    by_work: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for page in pages:
        by_work[page["workId"]].append(page)
    for values in by_work.values():
        values.sort(key=lambda item: item["selectionKey"])
    work_ids = sorted(by_work)
    selected: list[dict[str, Any]] = []
    cursor = 0
    while len(selected) < count:
        added = False
        for work_id in work_ids:
            values = by_work[work_id]
            if cursor < len(values):
                selected.append(values[cursor])
                added = True
                if len(selected) == count:
                    break
        if not added:
            break
        cursor += 1
    if len(selected) < count:
        raise RuntimeError(
            f"Only {len(selected)} fitted pages are available; requested {count}"
        )
    return selected


def _bbox_to_pixels(
    bbox: dict[str, Any],
    space: str | None,
    stored_width: int,
    stored_height: int,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float]:
    x = _bounded_float(bbox.get("x"))
    y = _bounded_float(bbox.get("y"))
    width = max(0.0, _bounded_float(bbox.get("w")))
    height = max(0.0, _bounded_float(bbox.get("h")))
    if space == "pixels":
        return (
            x / max(1, stored_width) * image_width,
            y / max(1, stored_height) * image_height,
            width / max(1, stored_width) * image_width,
            height / max(1, stored_height) * image_height,
        )
    return (
        x / 1000.0 * image_width,
        y / 1000.0 * image_height,
        width / 1000.0 * image_width,
        height / 1000.0 * image_height,
    )


def _clamped_rect(
    bbox: tuple[float, float, float, float], width: int, height: int
) -> tuple[int, int, int, int]:
    x, y, box_width, box_height = bbox
    left = max(0, min(width, int(math.floor(x))))
    top = max(0, min(height, int(math.floor(y))))
    right = max(left, min(width, int(math.ceil(x + box_width))))
    bottom = max(top, min(height, int(math.ceil(y + box_height))))
    return left, top, right, bottom


def rasterize_current_layout(
    block: dict[str, Any],
    stored_width: int,
    stored_height: int,
    image_width: int,
    image_height: int,
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    render_bbox = block.get("renderBbox") or block.get("bbox") or {}
    render_space = block.get("renderBboxSpace") or block.get("bboxSpace")
    bounds = _bbox_to_pixels(
        render_bbox,
        render_space,
        stored_width,
        stored_height,
        image_width,
        image_height,
    )
    left, top, right, bottom = _clamped_rect(bounds, image_width, image_height)
    mask = np.zeros((image_height, image_width), dtype=np.bool_)
    layout = block["bubbleLayout"]
    horizontal = layout.get("direction") == "horizontal"
    box_width = max(1, right - left)
    box_height = max(1, bottom - top)
    for region in layout.get("regions") or []:
        for span in region.get("spans") or []:
            block_start = _bounded_float(span.get("blockStart"))
            block_end = _bounded_float(span.get("blockEnd"))
            inline_start = _bounded_float(span.get("inlineStart"))
            inline_end = _bounded_float(span.get("inlineEnd"))
            if horizontal:
                x0 = left + int(math.floor(inline_start * box_width))
                x1 = left + int(math.ceil(inline_end * box_width))
                y0 = top + int(math.floor(block_start * box_height))
                y1 = top + int(math.ceil(block_end * box_height))
            else:
                x0 = left + int(math.floor(block_start * box_width))
                x1 = left + int(math.ceil(block_end * box_width))
                y0 = top + int(math.floor(inline_start * box_height))
                y1 = top + int(math.ceil(inline_end * box_height))
            x0, y0, x1, y1 = _clamped_rect(
                (x0, y0, x1 - x0, y1 - y0), image_width, image_height
            )
            if x1 > x0 and y1 > y0:
                mask[y0:y1, x0:x1] = True
    return mask, (left, top, right, bottom)


def source_bbox_pixels(
    block: dict[str, Any],
    stored_width: int,
    stored_height: int,
    image_width: int,
    image_height: int,
) -> tuple[int, int, int, int]:
    return _clamped_rect(
        _bbox_to_pixels(
            block.get("bbox") or {},
            block.get("bboxSpace"),
            stored_width,
            stored_height,
            image_width,
            image_height,
        ),
        image_width,
        image_height,
    )


def _mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _effective_outline_width(block: dict[str, Any]) -> float:
    explicit = block.get("outlineWidthPx")
    if isinstance(explicit, (int, float)) and math.isfinite(float(explicit)):
        return min(64.0, max(0.0, float(explicit)))
    font_size = max(1.0, _bounded_float(block.get("fontSizePx"), 16.0))
    scale = max(0.0, _bounded_float(block.get("outlineWidthScale"), 1.0))
    return round(min(4.0, max(0.35, font_size * 0.055)) * 10.0) / 10.0 * scale


def build_koharu_safe_mask(raw_mask: np.ndarray, block: dict[str, Any]) -> np.ndarray:
    binary = raw_mask.astype(np.uint8, copy=False)
    font_size = max(1.0, _bounded_float(block.get("fontSizePx"), 16.0))
    inset = max(3.0, font_size * 0.18, _effective_outline_width(block) * 2.5)
    distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    eroded = distance >= inset
    if not np.any(eroded):
        eroded = raw_mask.copy()
    bounds = _mask_bbox(eroded)
    if bounds is None or DEFAULT_PADDING_RATIO <= 0:
        return eroded
    left, top, right, bottom = bounds
    crop = eroded[top:bottom, left:right].astype(np.uint8)
    scale = 1.0 - DEFAULT_PADDING_RATIO
    new_width = max(1, int(round(crop.shape[1] * scale)))
    new_height = max(1, int(round(crop.shape[0] * scale)))
    resized = cv2.resize(
        crop, (new_width, new_height), interpolation=cv2.INTER_NEAREST
    ).astype(np.bool_)
    output = np.zeros_like(eroded)
    x = left + (crop.shape[1] - new_width) // 2
    y = top + (crop.shape[0] - new_height) // 2
    output[y : y + new_height, x : x + new_width] = resized
    return output


def _safe_ratio(numerator: int | float, denominator: int | float) -> float:
    return float(numerator) / max(1.0, float(denominator))


def _iou(left: np.ndarray, right: np.ndarray) -> float:
    intersection = int(np.count_nonzero(left & right))
    union = int(np.count_nonzero(left | right))
    return _safe_ratio(intersection, union)


def associate_block(
    source_rect: tuple[int, int, int, int],
    current_mask: np.ndarray,
    bubbles: list[dict[str, Any]],
) -> dict[str, Any] | None:
    left, top, right, bottom = source_rect
    rect_area = max(1, (right - left) * (bottom - top))
    center_x = min(current_mask.shape[1] - 1, max(0, (left + right) // 2))
    center_y = min(current_mask.shape[0] - 1, max(0, (top + bottom) // 2))
    current_area = max(1, int(np.count_nonzero(current_mask)))
    best: dict[str, Any] | None = None
    for index, bubble in enumerate(bubbles):
        mask = bubble["mask"]
        source_coverage = _safe_ratio(
            int(np.count_nonzero(mask[top:bottom, left:right])), rect_area
        )
        center_inside = bool(mask[center_y, center_x])
        current_overlap = _safe_ratio(
            int(np.count_nonzero(mask & current_mask)), current_area
        )
        score = source_coverage + (0.5 if center_inside else 0.0)
        candidate = {
            "index": index,
            "score": score,
            "sourceCoverage": source_coverage,
            "centerInside": center_inside,
            "currentContainmentInRaw": current_overlap,
        }
        if best is None or (score, current_overlap, bubble["confidence"]) > (
            best["score"],
            best["currentContainmentInRaw"],
            best["confidence"],
        ):
            best = {**candidate, "confidence": bubble["confidence"]}
    if best is None:
        return None
    best["blindMatched"] = bool(
        best["centerInside"]
        or best["sourceCoverage"] >= BLIND_SOURCE_COVERAGE_THRESHOLD
    )
    return best


def _normalise_bubbles(
    raw_detections: Any, image_width: int, image_height: int
) -> tuple[list[dict[str, Any]], int]:
    arrays = koharu._normalise_detection_arrays(raw_detections)
    raw_count = len(arrays["class_id"])
    keep_mask = koharu.filter_detection_indices(
        arrays["class_id"], arrays["confidence"]
    )
    bubbles: list[dict[str, Any]] = []
    for index in np.flatnonzero(keep_mask):
        if int(arrays["class_id"][index]) != 2:
            continue
        mask = np.asarray(arrays["mask"][index]).astype(np.bool_)
        if mask.shape != (image_height, image_width):
            mask = cv2.resize(
                mask.astype(np.uint8),
                (image_width, image_height),
                interpolation=cv2.INTER_NEAREST,
            ).astype(np.bool_)
        bubbles.append(
            {
                "mask": mask,
                "confidence": float(arrays["confidence"][index]),
                "xyxy": [float(value) for value in arrays["xyxy"][index]],
            }
        )
    return bubbles, raw_count


def _overlay_mask(image: Image.Image, mask: np.ndarray, color: tuple[int, int, int]) -> Image.Image:
    base = image.convert("RGBA")
    alpha = np.where(mask, 92, 0).astype(np.uint8)
    rgba = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = color[0]
    rgba[..., 1] = color[1]
    rgba[..., 2] = color[2]
    rgba[..., 3] = alpha
    return Image.alpha_composite(base, Image.fromarray(rgba, mode="RGBA"))


def _font(size: int) -> ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/malgun.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
    ]
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def _annotate_panel(
    image: Image.Image,
    title: str,
    masks: np.ndarray,
    color: tuple[int, int, int],
    source_rects: list[tuple[tuple[int, int, int, int], bool]],
) -> Image.Image:
    overlay = _overlay_mask(image, masks, color).convert("RGB")
    draw = ImageDraw.Draw(overlay)
    line_width = max(2, round(max(image.size) / 500))
    for (left, top, right, bottom), matched in source_rects:
        draw.rectangle(
            (left, top, right, bottom),
            outline=(255, 220, 40) if matched else (255, 45, 45),
            width=line_width,
        )
    header = max(38, round(image.height * 0.03))
    framed = Image.new("RGB", (image.width, image.height + header), "#101820")
    framed.paste(overlay, (0, header))
    ImageDraw.Draw(framed).text(
        (12, max(2, header // 8)), title, font=_font(max(18, header // 2)), fill="white"
    )
    return framed


def _side_by_side(
    image: Image.Image,
    current_union: np.ndarray,
    koharu_union: np.ndarray,
    source_rects: list[tuple[tuple[int, int, int, int], bool]],
    current_count: int,
    bubble_count: int,
    matched_count: int,
) -> Image.Image:
    current = _annotate_panel(
        image,
        f"A — 기존 앱 (CURRENT)  초록=현재 맞춤  blocks={current_count}",
        current_union,
        (35, 220, 85),
        [(rect, True) for rect, _matched in source_rects],
    )
    candidate = _annotate_panel(
        image,
        f"B — KOHARU 후보  하늘색=새 맞춤  bubbles={bubble_count} matched={matched_count}/{current_count}",
        koharu_union,
        (0, 185, 255),
        source_rects,
    )
    max_panel_width = 640
    if current.width > max_panel_width:
        ratio = max_panel_width / current.width
        size = (max_panel_width, max(1, round(current.height * ratio)))
        current = current.resize(size, Image.Resampling.LANCZOS)
        candidate = candidate.resize(size, Image.Resampling.LANCZOS)
    result = Image.new("RGB", (current.width * 2, current.height), "white")
    result.paste(current, (0, 0))
    result.paste(candidate, (current.width, 0))
    return result


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
    image_width, image_height = image.size
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
    bubbles, raw_detection_count = _normalise_bubbles(
        raw, image_width, image_height
    )

    stored_width = page["pageWidth"] or image_width
    stored_height = page["pageHeight"] or image_height
    current_union = np.zeros((image_height, image_width), dtype=np.bool_)
    koharu_safe_union = np.zeros_like(current_union)
    source_rects: list[tuple[tuple[int, int, int, int], bool]] = []
    block_records: list[dict[str, Any]] = []
    associated_indices: set[int] = set()
    for block in page["blocks"]:
        current_mask, render_rect = rasterize_current_layout(
            block,
            stored_width,
            stored_height,
            image_width,
            image_height,
        )
        source_rect = source_bbox_pixels(
            block,
            stored_width,
            stored_height,
            image_width,
            image_height,
        )
        current_union |= current_mask
        association = associate_block(source_rect, current_mask, bubbles)
        blind_matched = bool(association and association["blindMatched"])
        safe_iou = 0.0
        safe_containment = 0.0
        candidate_safe_area = 0
        if blind_matched and association is not None:
            bubble_index = int(association["index"])
            associated_indices.add(bubble_index)
            candidate_safe = build_koharu_safe_mask(
                bubbles[bubble_index]["mask"], block
            )
            koharu_safe_union |= candidate_safe
            intersection = int(np.count_nonzero(current_mask & candidate_safe))
            current_area = int(np.count_nonzero(current_mask))
            candidate_safe_area = int(np.count_nonzero(candidate_safe))
            safe_containment = _safe_ratio(intersection, current_area)
            safe_iou = _iou(current_mask, candidate_safe)
        source_rects.append((source_rect, blind_matched))
        record = {
            "blockId": str(block.get("id") or ""),
            "sourceText": str(block.get("sourceText") or "")[:200],
            "translatedText": str(block.get("translatedText") or "")[:200],
            "currentModelId": str(
                (block.get("bubbleLayout") or {}).get("modelId") or ""
            ),
            "sourceRectPx": list(source_rect),
            "currentRenderRectPx": list(render_rect),
            "currentSafeArea": int(np.count_nonzero(current_mask)),
            "blindMatched": blind_matched,
            "koharuIndex": int(association["index"])
            if association is not None
            else None,
            "koharuConfidence": round(float(association["confidence"]), 8)
            if association is not None
            else None,
            "sourceCoverage": round(float(association["sourceCoverage"]), 8)
            if association is not None
            else 0.0,
            "sourceCenterInside": bool(association["centerInside"])
            if association is not None
            else False,
            "currentContainmentInRawKoharu": round(
                float(association["currentContainmentInRaw"]), 8
            )
            if association is not None
            else 0.0,
            "currentContainmentInKoharuSafe": round(safe_containment, 8),
            "safeMaskIoU": round(safe_iou, 8),
            "koharuSafeArea": candidate_safe_area,
        }
        block_records.append(record)

    matched_count = sum(1 for record in block_records if record["blindMatched"])
    current_area = int(np.count_nonzero(current_union))
    koharu_area = int(np.count_nonzero(koharu_safe_union))
    intersection = int(np.count_nonzero(current_union & koharu_safe_union))
    current_containment = _safe_ratio(intersection, current_area)
    union_iou = _iou(current_union, koharu_safe_union)
    composite = _side_by_side(
        image,
        current_union,
        koharu_safe_union,
        source_rects,
        len(block_records),
        len(bubbles),
        matched_count,
    )
    relative_path = Path("pages") / f"{index:04d}-{page['pageId']}.jpg"
    composite.save(output_pages.parent / relative_path, quality=88, optimize=True)
    return {
        "index": index,
        "workId": page["workId"],
        "chapterId": page["chapterId"],
        "chapterTitle": page["chapterTitle"],
        "pageId": page["pageId"],
        "pageName": page["pageName"],
        "imagePath": page["imagePath"],
        "imageSha256": _sha256_file(image_path),
        "imageSize": [image_width, image_height],
        "compositePath": relative_path.as_posix(),
        "inferenceSeconds": round(inference_seconds, 8),
        "rawDetectionCount": raw_detection_count,
        "koharuBubbleCount": len(bubbles),
        "currentFitCount": len(block_records),
        "blindMatchedCount": matched_count,
        "blindMatchRate": round(_safe_ratio(matched_count, len(block_records)), 8),
        "allCurrentFitsBlindMatched": matched_count == len(block_records),
        "associatedKoharuBubbleCount": len(associated_indices),
        "unassociatedKoharuBubbleCount": len(bubbles) - len(associated_indices),
        "currentSafeUnionArea": current_area,
        "koharuSafeUnionArea": koharu_area,
        "currentSafeUnionContainment": round(current_containment, 8),
        "safeUnionIoU": round(union_iou, 8),
        "blocks": block_records,
    }


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return float(ordered[index])


def summarise(records: list[dict[str, Any]]) -> dict[str, Any]:
    blocks = [block for page in records for block in page["blocks"]]
    inference = [float(page["inferenceSeconds"]) for page in records]
    match_rates = [float(page["blindMatchRate"]) for page in records]
    containments = [
        float(block["currentContainmentInRawKoharu"])
        for block in blocks
        if block["blindMatched"]
    ]
    safe_ious = [
        float(block["safeMaskIoU"])
        for block in blocks
        if block["blindMatched"]
    ]
    matched = sum(1 for block in blocks if block["blindMatched"])
    high_raw_containment = sum(
        1
        for block in blocks
        if block["blindMatched"]
        and float(block["currentContainmentInRawKoharu"]) >= 0.8
    )
    return {
        "pages": len(records),
        "works": len({page["workId"] for page in records}),
        "chapters": len({page["chapterId"] for page in records}),
        "currentFittedBlocks": len(blocks),
        "koharuBubbleInstances": sum(page["koharuBubbleCount"] for page in records),
        "blindMatchedBlocks": matched,
        "blindMatchedBlockRate": round(_safe_ratio(matched, len(blocks)), 8),
        "pagesWithAllCurrentFitsBlindMatched": sum(
            1 for page in records if page["allCurrentFitsBlindMatched"]
        ),
        "pagesWithAllCurrentFitsBlindMatchedRate": round(
            _safe_ratio(
                sum(1 for page in records if page["allCurrentFitsBlindMatched"]),
                len(records),
            ),
            8,
        ),
        "blocksWithAtLeast80PercentCurrentSafeAreaInsideRawKoharu": high_raw_containment,
        "blocksWithAtLeast80PercentCurrentSafeAreaInsideRawKoharuRate": round(
            _safe_ratio(high_raw_containment, len(blocks)), 8
        ),
        "pageBlindMatchRateMedian": round(statistics.median(match_rates), 8),
        "matchedBlockRawContainmentMedian": round(statistics.median(containments), 8)
        if containments
        else 0.0,
        "matchedBlockSafeMaskIoUMedian": round(statistics.median(safe_ious), 8)
        if safe_ious
        else 0.0,
        "inferenceSecondsTotal": round(sum(inference), 8),
        "inferenceSecondsMean": round(statistics.mean(inference), 8),
        "inferenceSecondsP50": round(_percentile(inference, 0.5), 8),
        "inferenceSecondsP95": round(_percentile(inference, 0.95), 8),
    }


def _contact_sheet(
    title: str,
    records: list[dict[str, Any]],
    output_root: Path,
    output_path: Path,
) -> None:
    thumb_width = 560
    thumbnails: list[Image.Image] = []
    for record in records:
        with Image.open(output_root / record["compositePath"]) as opened:
            image = opened.convert("RGB")
        ratio = thumb_width / image.width
        image = image.resize(
            (thumb_width, max(1, round(image.height * ratio))),
            Image.Resampling.LANCZOS,
        )
        label_height = 54
        tile = Image.new("RGB", (thumb_width, image.height + label_height), "#141414")
        tile.paste(image, (0, label_height))
        text = (
            f"{record['index']:03d} match={record['blindMatchRate']:.2f} "
            f"contain={record['currentSafeUnionContainment']:.2f} "
            f"iou={record['safeUnionIoU']:.2f}"
        )
        draw = ImageDraw.Draw(tile)
        draw.text((10, 4), text, font=_font(20), fill="white")
        draw.text(
            (10, 27),
            f"{record['chapterTitle']} / {record['pageName']}",
            font=_font(16),
            fill="#d6e8ff",
        )
        thumbnails.append(tile)
    columns = 3
    rows = math.ceil(len(thumbnails) / columns)
    row_heights = []
    for row in range(rows):
        row_heights.append(
            max(tile.height for tile in thumbnails[row * columns : (row + 1) * columns])
        )
    title_height = 58
    sheet = Image.new(
        "RGB",
        (thumb_width * columns, title_height + sum(row_heights)),
        "#0b1015",
    )
    ImageDraw.Draw(sheet).text((14, 10), title, font=_font(30), fill="white")
    y = title_height
    for row, row_height in enumerate(row_heights):
        for column in range(columns):
            item = row * columns + column
            if item >= len(thumbnails):
                continue
            sheet.paste(thumbnails[item], (column * thumb_width, y))
        y += row_height
    sheet.save(output_path, quality=90, optimize=True)


def write_gallery(records: list[dict[str, Any]], output_root: Path) -> None:
    cards = []
    for record in records:
        cards.append(
            "<article>"
            f"<h2>#{record['index']:03d} {html.escape(record['chapterTitle'])} / "
            f"{html.escape(record['pageName'])}</h2>"
            f"<p>current={record['currentFitCount']} koharu={record['koharuBubbleCount']} "
            f"matched={record['blindMatchedCount']} ({record['blindMatchRate']:.3f}) "
            f"contain={record['currentSafeUnionContainment']:.3f} "
            f"IoU={record['safeUnionIoU']:.3f}</p>"
            f"<img loading='lazy' src='{html.escape(record['compositePath'])}'>"
            "</article>"
        )
    document = """<!doctype html><meta charset="utf-8">
<title>Koharu bubble layout A/B</title>
<style>
body{font-family:system-ui;background:#111;color:#eee;margin:20px}article{margin:0 0 32px;padding:16px;background:#1d1d1d;border-radius:10px}img{width:min(100%,1280px);height:auto}h2{font-size:18px;margin:0 0 8px}p{color:#cbd5e1}
</style>
<h1>말풍선 맞춤 A/B — 왼쪽 A는 기존 앱, 오른쪽 B는 Koharu 후보</h1>
<p><b style="color:#23dc55">A 초록</b> = 기존 앱의 저장된 맞춤 영역 ·
<b style="color:#00b9ff">B 하늘색</b> = Koharu가 새로 제안한 맞춤 영역 ·
노랑 박스 = Koharu와 연결됨 · 빨강 박스 = 연결 실패</p>""" + "\n".join(cards)
    (output_root / "gallery.html").write_text(document, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-root", default="library")
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=DEFAULT_PAGE_COUNT)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument(
        "--cache-dir", default=".tmp/koharu-layout-rfdetr-qa-v1/assets"
    )
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument(
        "--allow-small-smoke",
        action="store_true",
        help="Permit fewer than 200 pages for local harness smoke testing only",
    )
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.count < 200 and not args.allow_small_smoke:
        raise RuntimeError("The requested A/B cohort must contain at least 200 pages")
    library_root = Path(args.library_root).resolve(strict=True)
    output_root = Path(args.output).resolve()
    if output_root.exists():
        raise FileExistsError(f"Refusing to overwrite A/B output: {output_root}")
    output_root.mkdir(parents=True)
    output_pages = output_root / "pages"
    output_pages.mkdir()

    available = collect_pages(library_root)
    selected = select_round_robin_pages(available, args.count)
    cohort = [
        {
            key: page[key]
            for key in (
                "workId",
                "chapterId",
                "pageId",
                "pageName",
                "imagePath",
                "selectionKey",
            )
        }
        | {"currentFitCount": len(page["blocks"])}
        for page in selected
    ]
    (output_root / "cohort.json").write_text(
        json.dumps(cohort, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
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
            f"[koharu-ab] {index}/{len(selected)} "
            f"fits={record['currentFitCount']} bubbles={record['koharuBubbleCount']} "
            f"matched={record['blindMatchedCount']} infer={record['inferenceSeconds']:.3f}s",
            flush=True,
        )
    summary = summarise(records)
    summary["wallSeconds"] = round(time.perf_counter() - started, 8)

    ordered = sorted(
        records,
        key=lambda item: (
            item["blindMatchRate"],
            item["currentSafeUnionContainment"],
            item["safeUnionIoU"],
        ),
    )
    sample_count = min(12, len(ordered))
    worst = ordered[:sample_count]
    best = list(reversed(ordered[-sample_count:]))
    middle_start = max(0, len(ordered) // 2 - sample_count // 2)
    median = ordered[middle_start : middle_start + sample_count]
    _contact_sheet(
        "LOWEST AGREEMENT — inspect for Koharu misses",
        worst,
        output_root,
        output_root / "contact-sheet-worst.jpg",
    )
    _contact_sheet(
        "MEDIAN AGREEMENT",
        median,
        output_root,
        output_root / "contact-sheet-median.jpg",
    )
    _contact_sheet(
        "HIGHEST AGREEMENT",
        best,
        output_root,
        output_root / "contact-sheet-best.jpg",
    )
    write_gallery(records, output_root)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "purpose": "read-only replacement feasibility A/B: stored production bubble fitting vs KoharuLayout masks",
        "libraryMutation": False,
        "cohort": {
            "availableFittedPages": len(available),
            "selectedPages": len(selected),
            "selection": "deterministic per-work round robin over SHA-256 page keys",
            "cohortSha256": _sha256_file(output_root / "cohort.json"),
        },
        "current": {
            "modelPrefix": CURRENT_MODEL_PREFIX,
            "geometry": "stored renderBbox + bubbleLayout spans",
            "manualLayoutsExcluded": True,
        },
        "koharu": {
            "assets": assets,
            "runtime": runtime,
            "bubbleClassId": 2,
            "bubbleThreshold": koharu.CLASS_THRESHOLDS[2],
            "resolution": koharu.RESOLUTION,
            "safeMaskApproximation": "raw instance mask eroded with current balanced inset formula, then 12% centered padding",
            "association": "source block bbox coverage or source center inside; current geometry is evaluation-only",
        },
        "summary": summary,
        "pages": records,
    }
    report_path = output_root / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    marker = {
        "schemaVersion": SCHEMA_VERSION,
        "report": "report.json",
        "reportSha256": _sha256_file(report_path),
        "pageCount": len(records),
        "currentFittedBlocks": summary["currentFittedBlocks"],
    }
    (output_root / "result.json").write_text(
        json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = run(args)
    print(json.dumps({"ok": True, **report["summary"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
