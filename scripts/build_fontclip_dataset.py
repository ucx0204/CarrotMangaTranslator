#!/usr/bin/env python3
"""Build a conservative, unlabeled FontClip crop dataset from the local library.

Only page-local ``ocr-hints/<pageId>/result.json`` and
``ocr-hints/<pageId>/ocr-bbox-hints.json`` are trusted as OCR sources.  Existing
``fontFamily`` values are deliberately exported as weak metadata; the training
label is always null until a human labels ``label_queue.csv``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import shutil
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
MARKER_NAME = ".fontclip-dataset"
MARKER_CONTENT = "manga-translator-fontclip-dataset:v1\n"
RESULT_PROVENANCE = "ocr-hints/result.json"
BBOX_PROVENANCE = "ocr-hints/ocr-bbox-hints.json"
FALLBACK_PROVENANCE = "chapter-block-fallback"
SPLIT_NAMES = ("train", "val", "test")
DEFAULT_SPLIT_RATIOS = (0.8, 0.1, 0.1)
SAFE_TIER_B_REASONS = frozenset({"ordinary_axis_candidate"})
SUPPORTED_IMAGES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"})


@dataclass(frozen=True)
class WorkRecord:
    id: str
    title: str
    chapter_order: tuple[str, ...]
    directory: Path
    order_index: int


@dataclass(frozen=True)
class ChapterRecord:
    id: str
    work_id: str
    title: str
    page_order: tuple[str, ...]
    pages: tuple[Mapping[str, Any], ...]
    directory: Path
    order_index: int


@dataclass(frozen=True)
class OcrSource:
    provenance: str
    path: Path
    items: tuple[Mapping[str, Any], ...]
    width: int
    height: int


@dataclass(frozen=True)
class CandidateDecision:
    tier: str | None
    reason: str
    text: str = ""
    score: float = 0.0
    bbox: tuple[int, int, int, int] | None = None
    orientation: str | None = None


@dataclass
class ChapterQuality:
    chapter: ChapterRecord
    tier_a: int = 0
    tier_b: int = 0
    score_sum: float = 0.0
    ocr_pages: int = 0
    missing_ocr_pages: int = 0
    rejected: Counter[str] = field(default_factory=Counter)

    @property
    def candidate_count(self) -> int:
        return self.tier_a + self.tier_b

    @property
    def rank(self) -> tuple[int, int, float, int, int]:
        return (
            self.candidate_count,
            self.tier_a,
            round(self.score_sum, 6),
            self.ocr_pages,
            -self.chapter.order_index,
        )


@dataclass(frozen=True)
class SelectedChapter:
    work: WorkRecord
    chapter: ChapterRecord
    quality: ChapterQuality
    segment_index: int
    segment_start: int
    segment_end: int


@dataclass(frozen=True)
class CropPlan:
    work: WorkRecord
    chapter: ChapterRecord
    page: Mapping[str, Any]
    split: str
    tier: str
    provenance: str
    source_path: Path
    text: str
    score: float
    bbox: tuple[int, int, int, int]
    orientation: str
    review_status: str
    review_reasons: tuple[str, ...]
    hint_id: str
    hint_index: int
    weak_font_family: str | None
    weak_font_block_id: str | None
    segment_index: int
    fallback: bool = False


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _finite_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _positive_int(value: Any) -> int | None:
    number = _finite_float(value)
    if number is None or number <= 0:
        return None
    return int(round(number))


def is_path_within(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def load_library(library_root: Path, limit_works: int | None = None) -> list[WorkRecord]:
    """Parse index -> work.json without discovering unindexed works."""
    root = library_root.resolve()
    index_path = root / "index.json"
    raw_index = read_json(index_path)
    work_order = raw_index.get("workOrder") if isinstance(raw_index, dict) else None
    if not isinstance(work_order, list):
        raise ValueError(f"invalid library index (workOrder missing): {index_path}")
    works: list[WorkRecord] = []
    seen: set[str] = set()
    for order_index, raw_id in enumerate(work_order):
        work_id = _string(raw_id)
        if not work_id or work_id in seen or any(ch in work_id for ch in "/\\"):
            continue
        seen.add(work_id)
        directory = root / "works" / work_id
        path = directory / "work.json"
        if not path.is_file():
            continue
        raw = read_json(path)
        if not isinstance(raw, dict) or _string(raw.get("id")) != work_id:
            continue
        chapter_order = raw.get("chapterOrder")
        if not isinstance(chapter_order, list):
            chapter_order = []
        clean_order = tuple(
            chapter_id
            for chapter_id in (_string(value) for value in chapter_order)
            if chapter_id and not any(ch in chapter_id for ch in "/\\")
        )
        works.append(
            WorkRecord(
                id=work_id,
                title=_string(raw.get("title")) or work_id,
                chapter_order=clean_order,
                directory=directory,
                order_index=order_index,
            )
        )
        if limit_works is not None and len(works) >= limit_works:
            break
    return works


def load_chapter(work: WorkRecord, chapter_id: str, order_index: int) -> ChapterRecord | None:
    directory = work.directory / "chapters" / chapter_id
    path = directory / "chapter.json"
    if not path.is_file():
        return None
    try:
        raw = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if (
        not isinstance(raw, dict)
        or _string(raw.get("id")) != chapter_id
        or _string(raw.get("workId")) != work.id
    ):
        return None
    raw_pages = raw.get("pages")
    pages = tuple(page for page in raw_pages if isinstance(page, dict)) if isinstance(raw_pages, list) else ()
    raw_order = raw.get("pageOrder")
    page_order = tuple(_string(value) for value in raw_order) if isinstance(raw_order, list) else ()
    return ChapterRecord(
        id=chapter_id,
        work_id=work.id,
        title=_string(raw.get("title")) or chapter_id,
        page_order=page_order,
        pages=pages,
        directory=directory,
        order_index=order_index,
    )


def ordered_pages(chapter: ChapterRecord) -> list[Mapping[str, Any]]:
    by_id = {_string(page.get("id")): page for page in chapter.pages if _string(page.get("id"))}
    result: list[Mapping[str, Any]] = []
    for page_id in chapter.page_order:
        page = by_id.pop(page_id, None)
        if page is not None:
            result.append(page)
    result.extend(by_id.values())
    return result


def partition_chapter_order(
    chapter_order: Sequence[str], max_chapters: int = 10
) -> list[tuple[int, int, tuple[str, ...]]]:
    """Split the complete order into at most ten contiguous, non-empty ranges."""
    if max_chapters <= 0 or not chapter_order:
        return []
    count = len(chapter_order)
    segment_count = min(max_chapters, count)
    result: list[tuple[int, int, tuple[str, ...]]] = []
    for index in range(segment_count):
        start = (index * count) // segment_count
        end = ((index + 1) * count) // segment_count
        if start < end:
            result.append((start, end, tuple(chapter_order[start:end])))
    return result


def japanese_semantic_count(text: str) -> int:
    count = 0
    for char in text:
        code = ord(char)
        if (
            0x3041 <= code <= 0x309F
            or 0x30A1 <= code <= 0x30FF
            or 0x31F0 <= code <= 0x31FF
            or 0x3400 <= code <= 0x4DBF
            or 0x4E00 <= code <= 0x9FFF
            or 0xF900 <= code <= 0xFAFF
            or 0xFF66 <= code <= 0xFF9D
            or char in "々〆ヵヶ"
        ):
            count += 1
    return count


def contains_meaningful_japanese(text: str, minimum: int = 2) -> bool:
    return japanese_semantic_count(text) >= minimum


def _normalize_ocr_text(value: Any) -> str:
    text = _string(value)
    return " ".join(text.split())


def normalize_bbox(
    item: Mapping[str, Any],
    width: int,
    height: int,
    coordinate_space: str = "pixels",
) -> tuple[int, int, int, int] | None:
    values = tuple(_finite_float(item.get(key)) for key in ("x1", "y1", "x2", "y2"))
    if any(value is None for value in values):
        raw_bbox = item.get("bbox")
        if isinstance(raw_bbox, dict):
            x = _finite_float(raw_bbox.get("x"))
            y = _finite_float(raw_bbox.get("y"))
            w = _finite_float(raw_bbox.get("w"))
            h = _finite_float(raw_bbox.get("h"))
            if None not in (x, y, w, h):
                values = (x, y, x + w, y + h)
    if any(value is None for value in values):
        return None
    x1, y1, x2, y2 = (float(value) for value in values)
    space = coordinate_space.strip().lower()
    if space in {"normalized", "normalized_1", "unit"}:
        x1, x2, y1, y2 = x1 * width, x2 * width, y1 * height, y2 * height
    elif space in {"normalized_1000", "1000"}:
        x1, x2, y1, y2 = x1 * width / 1000.0, x2 * width / 1000.0, y1 * height / 1000.0, y2 * height / 1000.0
    left, top = math.floor(min(x1, x2)), math.floor(min(y1, y2))
    right, bottom = math.ceil(max(x1, x2)), math.ceil(max(y1, y2))
    if left < 0 or top < 0 or right > width or bottom > height or right <= left or bottom <= top:
        return None
    return (left, top, right, bottom)


def infer_orientation(bbox: tuple[int, int, int, int]) -> str:
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    return "vertical" if height > width * 1.15 else "horizontal"


def classify_ocr_candidate(
    item: Mapping[str, Any],
    page_width: int,
    page_height: int,
    *,
    coordinate_space: str = "pixels",
    tier_a_min_score: float = 0.90,
    tier_b_min_score: float = 0.985,
    minimum_semantic_chars: int = 2,
    include_tier_b: bool = True,
) -> CandidateDecision:
    label = _string(item.get("label")).lower()
    if label and label not in {"ocr_textline", "textline", "text"}:
        return CandidateDecision(None, "unsupported_label")
    text = _normalize_ocr_text(item.get("ocrText", item.get("text")))
    if not text or len(text) > 64 or any(unicodedata.category(char) == "Cc" for char in text):
        return CandidateDecision(None, "invalid_text")
    semantic_count = japanese_semantic_count(text)
    if semantic_count < minimum_semantic_chars:
        return CandidateDecision(None, "too_few_japanese_characters", text=text)
    score = _finite_float(item.get("score", item.get("confidence")))
    if score is None or not 0.0 <= score <= 1.0:
        return CandidateDecision(None, "invalid_score", text=text)
    review_status = _string(item.get("reviewStatus")).lower()
    reasons_value = item.get("reviewReasons")
    reasons = {
        _string(reason)
        for reason in reasons_value
        if _string(reason)
    } if isinstance(reasons_value, list) else set()
    tier: str | None = None
    if review_status == "confirmed" and score >= tier_a_min_score:
        tier = "A"
    elif (
        include_tier_b
        and review_status in {"", "unreviewed", "deferred", "pending"}
        and score >= tier_b_min_score
        and (review_status != "deferred" or reasons.issubset(SAFE_TIER_B_REASONS))
    ):
        tier = "B"
    if tier is None:
        return CandidateDecision(None, "tier_threshold", text=text, score=score)
    bbox = normalize_bbox(item, page_width, page_height, coordinate_space)
    if bbox is None:
        return CandidateDecision(None, "invalid_bbox", text=text, score=score)
    crop_width, crop_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
    short_side, long_side = min(crop_width, crop_height), max(crop_width, crop_height)
    area_ratio = (crop_width * crop_height) / float(page_width * page_height)
    if short_side < 12 or long_side < 24 or long_side / short_side > 14.0:
        return CandidateDecision(None, "implausible_dimensions", text=text, score=score, bbox=bbox)
    if short_side > min(page_width, page_height) * 0.22 or area_ratio > 0.20:
        return CandidateDecision(None, "oversized_bbox", text=text, score=score, bbox=bbox)
    orientation = infer_orientation(bbox)
    primary = crop_height if orientation == "vertical" else crop_width
    estimated_pitch = primary / max(1, semantic_count)
    if estimated_pitch < 7.0 or estimated_pitch > 180.0:
        return CandidateDecision(None, "implausible_character_pitch", text=text, score=score, bbox=bbox)
    return CandidateDecision(tier, "accepted", text, score, bbox, orientation)


def _same_image_path(left: Any, right: Path) -> bool:
    text = _string(left)
    if not text:
        return False
    try:
        return Path(text).resolve() == right.resolve()
    except OSError:
        return False


def read_page_ocr_source(chapter: ChapterRecord, page: Mapping[str, Any]) -> tuple[OcrSource | None, str]:
    """Read only the cache directory whose name exactly equals the current page id."""
    page_id = _string(page.get("id"))
    image_path = Path(_string(page.get("imagePath")))
    page_width = _positive_int(page.get("width"))
    page_height = _positive_int(page.get("height"))
    if not page_id or any(ch in page_id for ch in "/\\") or not page_width or not page_height:
        return None, "invalid_page"
    cache_dir = chapter.directory / "ocr-hints" / page_id
    result_path = cache_dir / "result.json"
    bbox_path = cache_dir / "ocr-bbox-hints.json"
    if result_path.is_file():
        try:
            raw = read_json(result_path)
            if (
                isinstance(raw, dict)
                and isinstance(raw.get("hints"), list)
                and _positive_int(raw.get("width")) == page_width
                and _positive_int(raw.get("height")) == page_height
                and _same_image_path(raw.get("imagePath"), image_path)
            ):
                items = tuple(item for item in raw["hints"] if isinstance(item, dict))
                if items or not bbox_path.is_file():
                    return OcrSource(RESULT_PROVENANCE, result_path, items, page_width, page_height), "ok"
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    if bbox_path.is_file():
        try:
            raw = read_json(bbox_path)
            if (
                isinstance(raw, dict)
                and isinstance(raw.get("items"), list)
                and _positive_int(raw.get("width")) == page_width
                and _positive_int(raw.get("height")) == page_height
            ):
                items = tuple(item for item in raw["items"] if isinstance(item, dict))
                return OcrSource(BBOX_PROVENANCE, bbox_path, items, page_width, page_height), "ok"
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    return None, "missing" if not result_path.exists() and not bbox_path.exists() else "invalid"


def evaluate_chapter_quality(
    chapter: ChapterRecord,
    *,
    tier_a_min_score: float,
    tier_b_min_score: float,
    minimum_semantic_chars: int,
    include_tier_b: bool,
) -> ChapterQuality:
    quality = ChapterQuality(chapter)
    for page in ordered_pages(chapter):
        source, state = read_page_ocr_source(chapter, page)
        if source is None:
            quality.missing_ocr_pages += 1
            quality.rejected[f"ocr_{state}"] += 1
            continue
        quality.ocr_pages += 1
        for item in source.items:
            decision = classify_ocr_candidate(
                item,
                source.width,
                source.height,
                tier_a_min_score=tier_a_min_score,
                tier_b_min_score=tier_b_min_score,
                minimum_semantic_chars=minimum_semantic_chars,
                include_tier_b=include_tier_b,
            )
            if decision.tier == "A":
                quality.tier_a += 1
                quality.score_sum += decision.score
            elif decision.tier == "B":
                quality.tier_b += 1
                quality.score_sum += decision.score
            else:
                quality.rejected[decision.reason] += 1
    return quality


def select_chapters_for_work(
    work: WorkRecord,
    qualities: Mapping[str, ChapterQuality],
    max_chapters: int = 10,
) -> list[SelectedChapter]:
    selected: list[SelectedChapter] = []
    for segment_index, (start, end, chapter_ids) in enumerate(
        partition_chapter_order(work.chapter_order, max_chapters)
    ):
        options = [qualities[chapter_id] for chapter_id in chapter_ids if chapter_id in qualities]
        if not options:
            continue
        best = max(options, key=lambda quality: quality.rank)
        selected.append(SelectedChapter(work, best.chapter, best, segment_index, start, end))
    return selected


def _allocate_split_counts(total: int, ratios: Sequence[float]) -> list[int]:
    raw = [total * ratio for ratio in ratios]
    counts = [int(math.floor(value)) for value in raw]
    remainder = total - sum(counts)
    order = sorted(range(len(ratios)), key=lambda i: (raw[i] - counts[i], ratios[i], -i), reverse=True)
    for index in order[:remainder]:
        counts[index] += 1
    if total >= len(ratios):
        for empty_index in [i for i, count in enumerate(counts) if count == 0]:
            donor = max(range(len(counts)), key=lambda i: counts[i])
            if counts[donor] > 1:
                counts[donor] -= 1
                counts[empty_index] += 1
    return counts


def assign_work_splits(
    work_ids: Sequence[str],
    seed: int = 1729,
    ratios: Sequence[float] = DEFAULT_SPLIT_RATIOS,
) -> dict[str, str]:
    if len(ratios) != 3 or any(ratio < 0 for ratio in ratios) or not math.isclose(sum(ratios), 1.0, abs_tol=1e-9):
        raise ValueError("split ratios must be three non-negative values summing to 1")
    unique_ids = sorted(set(work_ids))
    rng = random.Random(seed)
    rng.shuffle(unique_ids)
    counts = _allocate_split_counts(len(unique_ids), ratios)
    result: dict[str, str] = {}
    cursor = 0
    for split, count in zip(SPLIT_NAMES, counts):
        for work_id in unique_ids[cursor : cursor + count]:
            result[work_id] = split
        cursor += count
    return result


def assign_weighted_work_splits(
    work_weights: Mapping[str, int | float],
    seed: int = 1729,
    ratios: Sequence[float] = DEFAULT_SPLIT_RATIOS,
) -> dict[str, str]:
    """Keep works disjoint while balancing their expected sample counts.

    OCR coverage is highly uneven between works, so splitting by work count can
    leave validation or test with only a handful of crops.  This greedy
    deterministic partition minimizes weighted sample-ratio error; zero-weight
    works are then used to improve the work-count balance.
    """
    if (
        len(ratios) != 3
        or any(ratio < 0 for ratio in ratios)
        or not math.isclose(sum(ratios), 1.0, abs_tol=1e-9)
    ):
        raise ValueError("split ratios must be three non-negative values summing to 1")
    normalized = {
        str(work_id): max(0.0, float(weight))
        for work_id, weight in work_weights.items()
    }
    if not normalized:
        return {}
    total_weight = sum(normalized.values())
    if total_weight <= 0:
        return assign_work_splits(list(normalized), seed, ratios)

    rng = random.Random(seed)
    tie_breakers = {work_id: rng.random() for work_id in normalized}
    positive = {
        work_id: weight
        for work_id, weight in normalized.items()
        if weight > 0
    }
    zero_weight_ids = sorted(
        (work_id for work_id, weight in normalized.items() if weight <= 0),
        key=lambda work_id: (tie_breakers[work_id], work_id),
    )
    ordered = sorted(
        positive,
        key=lambda work_id: (-normalized[work_id], tie_breakers[work_id], work_id),
    )
    split_weights = {split: 0.0 for split in SPLIT_NAMES}
    split_counts = {split: 0 for split in SPLIT_NAMES}
    target_counts = dict(
        zip(SPLIT_NAMES, _allocate_split_counts(len(ordered), ratios))
    )
    result: dict[str, str] = {}

    def assignment_loss(split: str, weight: float) -> tuple[float, int]:
        weighted_error = 0.0
        for name, ratio in zip(SPLIT_NAMES, ratios):
            next_weight = split_weights[name] + (weight if name == split else 0.0)
            fraction = next_weight / total_weight
            weighted_error += ((fraction - ratio) ** 2) / max(ratio, 0.05)
        return (round(weighted_error, 12), SPLIT_NAMES.index(split))

    for work_id in ordered:
        weight = normalized[work_id]
        available = [
            name
            for name in SPLIT_NAMES
            if split_counts[name] < target_counts[name]
        ]
        if not available:  # Defensive only; allocated capacities sum to len(ordered).
            available = list(SPLIT_NAMES)
        split = min(available, key=lambda name: assignment_loss(name, weight))
        result[work_id] = split
        split_weights[split] += weight
        split_counts[split] += 1

    overall_targets = dict(
        zip(SPLIT_NAMES, _allocate_split_counts(len(normalized), ratios))
    )
    for work_id in zero_weight_ids:
        split = min(
            SPLIT_NAMES,
            key=lambda name: (
                -(overall_targets[name] - split_counts[name]),
                split_counts[name],
                SPLIT_NAMES.index(name),
            ),
        )
        result[work_id] = split
        split_counts[split] += 1
    return result


def _block_bbox_px(block: Mapping[str, Any], width: int, height: int) -> tuple[int, int, int, int] | None:
    bbox = block.get("bbox")
    if not isinstance(bbox, dict):
        return None
    proxy = {"bbox": bbox}
    space = _string(block.get("bboxSpace")) or "normalized_1000"
    return normalize_bbox(proxy, width, height, space)


def _weak_font_for_bbox(
    page: Mapping[str, Any], bbox: tuple[int, int, int, int], width: int, height: int
) -> tuple[str | None, str | None]:
    blocks = page.get("blocks")
    if not isinstance(blocks, list):
        return None, None
    cx, cy = (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0
    best: tuple[float, str, str] | None = None
    candidate_area = max(1, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    for block in blocks:
        if not isinstance(block, dict):
            continue
        font = _string(block.get("fontFamily"))
        block_id = _string(block.get("id"))
        block_bbox = _block_bbox_px(block, width, height)
        if not font or block_bbox is None:
            continue
        ix1, iy1 = max(bbox[0], block_bbox[0]), max(bbox[1], block_bbox[1])
        ix2, iy2 = min(bbox[2], block_bbox[2]), min(bbox[3], block_bbox[3])
        overlap = max(0, ix2 - ix1) * max(0, iy2 - iy1) / candidate_area
        contains_center = block_bbox[0] <= cx <= block_bbox[2] and block_bbox[1] <= cy <= block_bbox[3]
        rank = overlap + (1.0 if contains_center else 0.0)
        if rank >= 0.5 and (best is None or rank > best[0]):
            best = (rank, font, block_id)
    return (best[1], best[2]) if best else (None, None)


def build_crop_plans(
    selections: Sequence[SelectedChapter],
    splits: Mapping[str, str],
    *,
    library_root: Path,
    tier_a_min_score: float,
    tier_b_min_score: float,
    minimum_semantic_chars: int,
    include_tier_b: bool,
    include_fallback: bool,
    rejection_counts: Counter[str],
) -> tuple[list[CropPlan], list[CropPlan]]:
    plans: list[CropPlan] = []
    fallback_plans: list[CropPlan] = []
    for selected in selections:
        chapter = selected.chapter
        for page in ordered_pages(chapter):
            page_id = _string(page.get("id"))
            width, height = _positive_int(page.get("width")), _positive_int(page.get("height"))
            image_text = _string(page.get("imagePath"))
            image_path = Path(image_text).resolve() if image_text else Path()
            if (
                not page_id
                or not width
                or not height
                or not image_path.is_file()
                or image_path.suffix.lower() not in SUPPORTED_IMAGES
                or not is_path_within(library_root, image_path)
            ):
                rejection_counts["invalid_page_image"] += 1
                continue
            source, source_state = read_page_ocr_source(chapter, page)
            if source is not None:
                coordinate_space = "pixels"
                for hint_index, item in enumerate(source.items):
                    decision = classify_ocr_candidate(
                        item,
                        width,
                        height,
                        coordinate_space=coordinate_space,
                        tier_a_min_score=tier_a_min_score,
                        tier_b_min_score=tier_b_min_score,
                        minimum_semantic_chars=minimum_semantic_chars,
                        include_tier_b=include_tier_b,
                    )
                    if decision.tier is None or decision.bbox is None or decision.orientation is None:
                        rejection_counts[decision.reason] += 1
                        continue
                    weak_font, weak_block = _weak_font_for_bbox(page, decision.bbox, width, height)
                    reasons_value = item.get("reviewReasons")
                    reasons = tuple(
                        _string(reason) for reason in reasons_value if _string(reason)
                    ) if isinstance(reasons_value, list) else ()
                    plans.append(
                        CropPlan(
                            selected.work,
                            chapter,
                            page,
                            splits[selected.work.id],
                            decision.tier,
                            source.provenance,
                            image_path,
                            decision.text,
                            decision.score,
                            decision.bbox,
                            decision.orientation,
                            _string(item.get("reviewStatus")).lower() or "unreviewed",
                            reasons,
                            _string(item.get("id")) or str(hint_index),
                            hint_index,
                            weak_font,
                            weak_block,
                            selected.segment_index,
                        )
                    )
                continue
            rejection_counts[f"ocr_{source_state}"] += 1
            if not include_fallback:
                continue
            blocks = page.get("blocks")
            if not isinstance(blocks, list):
                continue
            for block_index, block in enumerate(blocks):
                if not isinstance(block, dict):
                    continue
                text = _normalize_ocr_text(block.get("sourceText"))
                bbox = _block_bbox_px(block, width, height)
                score = _finite_float(block.get("confidence"))
                if (
                    bbox is None
                    or score is None
                    or score < tier_a_min_score
                    or not contains_meaningful_japanese(text, minimum_semantic_chars)
                ):
                    rejection_counts["fallback_block_filter"] += 1
                    continue
                bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if min(bw, bh) < 12 or bw * bh > width * height * 0.25:
                    rejection_counts["fallback_block_geometry"] += 1
                    continue
                fallback_plans.append(
                    CropPlan(
                        selected.work,
                        chapter,
                        page,
                        splits[selected.work.id],
                        "fallback",
                        FALLBACK_PROVENANCE,
                        image_path,
                        text,
                        score,
                        bbox,
                        _string(block.get("sourceDirection")) or infer_orientation(bbox),
                        "chapter_block",
                        (),
                        _string(block.get("id")) or str(block_index),
                        block_index,
                        _string(block.get("fontFamily")) or None,
                        _string(block.get("id")) or None,
                        selected.segment_index,
                        fallback=True,
                    )
                )
    plans.sort(key=lambda plan: (0 if plan.tier == "A" else 1, plan.work.order_index, plan.chapter.order_index, _string(plan.page.get("name")), plan.hint_index))
    fallback_plans.sort(key=lambda plan: (plan.work.order_index, plan.chapter.order_index, _string(plan.page.get("name")), plan.hint_index))
    return plans, fallback_plans


def adaptive_crop_bbox(
    bbox: tuple[int, int, int, int], image_width: int, image_height: int
) -> tuple[int, int, int, int]:
    width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
    padding = max(4, min(24, int(round(min(width, height) * 0.20))))
    return (
        max(0, bbox[0] - padding),
        max(0, bbox[1] - padding),
        min(image_width, bbox[2] + padding),
        min(image_height, bbox[3] + padding),
    )


def _rgb_image(image: Any) -> Any:
    from PIL import Image

    if image.mode == "RGB":
        return image.copy()
    if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def letterbox_image(image: Any, size: int = 224) -> Any:
    from PIL import Image

    width, height = image.size
    scale = min(size / width, size / height)
    resized_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    resized = image.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def crop_pixel_sha256(image: Any) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(str(image.size[0]).encode("ascii"))
    digest.update(b"x")
    digest.update(str(image.size[1]).encode("ascii"))
    digest.update(b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def _sample_id(plan: CropPlan, pixel_hash: str) -> str:
    identity = "\0".join(
        (
            plan.work.id,
            plan.chapter.id,
            _string(plan.page.get("id")),
            plan.provenance,
            plan.hint_id,
            ",".join(str(value) for value in plan.bbox),
            pixel_hash,
        )
    )
    return "fc_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def _relative_source(path: Path, library_root: Path) -> str:
    try:
        return path.resolve().relative_to(library_root.resolve()).as_posix()
    except ValueError:
        return path.name


def materialize_plans(
    plans: Sequence[CropPlan],
    output_root: Path,
    library_root: Path,
    *,
    letterbox_size: int,
    dry_run: bool,
    seen_hashes: set[str],
    duplicate_counter: Counter[str],
) -> list[dict[str, Any]]:
    from PIL import Image, ImageOps

    records: list[dict[str, Any]] = []
    by_page: dict[Path, list[CropPlan]] = {}
    for plan in plans:
        by_page.setdefault(plan.source_path, []).append(plan)
    for page_path, page_plans in by_page.items():
        try:
            with Image.open(page_path) as opened:
                image = _rgb_image(ImageOps.exif_transpose(opened))
        except (OSError, ValueError):
            duplicate_counter["unreadable_image"] += len(page_plans)
            continue
        expected_width = _positive_int(page_plans[0].page.get("width"))
        expected_height = _positive_int(page_plans[0].page.get("height"))
        if image.size != (expected_width, expected_height):
            duplicate_counter["image_dimension_mismatch"] += len(page_plans)
            continue
        for plan in page_plans:
            crop_bbox = adaptive_crop_bbox(plan.bbox, image.width, image.height)
            crop = image.crop(crop_bbox)
            pixel_hash = crop_pixel_sha256(crop)
            if pixel_hash in seen_hashes:
                duplicate_counter["exact_duplicate"] += 1
                continue
            seen_hashes.add(pixel_hash)
            sample_id = _sample_id(plan, pixel_hash)
            prefix = "fallback/" if plan.fallback else ""
            raw_rel = f"{prefix}images/raw/{plan.split}/{sample_id}.png"
            clip_rel = f"{prefix}images/clip_{letterbox_size}/{plan.split}/{sample_id}.png"
            if not dry_run:
                raw_path, clip_path = output_root / raw_rel, output_root / clip_rel
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                clip_path.parent.mkdir(parents=True, exist_ok=True)
                crop.save(raw_path, format="PNG", optimize=False)
                letterbox_image(crop, letterbox_size).save(clip_path, format="PNG", optimize=False)
            record = {
                "schema_version": SCHEMA_VERSION,
                "id": sample_id,
                "image_path": raw_rel,
                "clip_image_path": clip_rel,
                "source_image_path": _relative_source(plan.source_path, library_root),
                "work_id": plan.work.id,
                "work_title": plan.work.title,
                "chapter_id": plan.chapter.id,
                "chapter_title": plan.chapter.title,
                "page_id": _string(plan.page.get("id")),
                "page_name": _string(plan.page.get("name")),
                "split": plan.split,
                "tier": plan.tier,
                "provenance": plan.provenance,
                "orientation": plan.orientation if plan.orientation in {"horizontal", "vertical"} else infer_orientation(plan.bbox),
                "bbox_px": list(plan.bbox),
                "crop_bbox_px": list(crop_bbox),
                "page_size_px": [image.width, image.height],
                "crop_size_px": [crop.width, crop.height],
                "crop_sha256": pixel_hash,
                "ocr_text": plan.text,
                "ocr_score": round(plan.score, 6),
                "ocr_review_status": plan.review_status,
                "ocr_review_reasons": list(plan.review_reasons),
                "ocr_hint_id": plan.hint_id,
                "segment_index": plan.segment_index,
                "weak_font_family": plan.weak_font_family,
                "weak_font_block_id": plan.weak_font_block_id,
                "weak_font_is_label": False,
                "label": None,
            }
            records.append(record)
    records.sort(key=lambda record: (record["work_id"], record["chapter_id"], record["page_name"], record["bbox_px"], record["id"]))
    return records


def apply_balance_weights(records: Sequence[dict[str, Any]]) -> None:
    """Annotate samples so training can preserve every crop without work skew."""
    if not records:
        return
    work_counts = Counter(str(record["work_id"]) for record in records)
    chapter_counts = Counter(
        (str(record["work_id"]), str(record["chapter_id"])) for record in records
    )
    total = len(records)
    work_total = len(work_counts)
    chapter_total = len(chapter_counts)
    for record in records:
        work_key = str(record["work_id"])
        chapter_key = (work_key, str(record["chapter_id"]))
        record["work_balance_weight"] = round(
            total / (work_total * work_counts[work_key]), 8
        )
        record["chapter_balance_weight"] = round(
            total / (chapter_total * chapter_counts[chapter_key]), 8
        )


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def _write_jsonl(path: Path, records: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")


def _write_label_queue(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    fields = [
        "id", "split", "tier", "image_path", "clip_image_path", "work_id", "work_title",
        "chapter_id", "chapter_title", "page_id", "ocr_text", "ocr_score",
        "orientation", "weak_font_family", "label", "label_status", "notes",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for record in records:
            writer.writerow(
                {
                    **{field: record.get(field, "") for field in fields},
                    "label": "",
                    "label_status": "unlabeled",
                    "notes": "",
                }
            )


def _readme(letterbox_size: int) -> str:
    return f"""# FontClip crop dataset

Generated by `scripts/build_fontclip_dataset.py` (schema {SCHEMA_VERSION}).

- `manifest.jsonl` and `manifests/{{all,train,val,test}}.jsonl` contain conservative OCR crops.
- `images/raw/<split>` contains untouched-colour, adaptively padded native-size PNG crops.
- `images/clip_{letterbox_size}/<split>` contains aspect-preserving {letterbox_size}x{letterbox_size} white-letterboxed PNGs.
- `fallback/` is isolated from the main dataset and contains chapter-block crops only for pages with no valid page-local OCR cache.
- splits are assigned at work level, so a work never crosses train/val/test.
- work-level splits are weighted by expected crop count to avoid nearly empty validation/test sets.
- `work_balance_weight` and `chapter_balance_weight` preserve all crops while allowing balanced sampling.
- Tier A is confirmed OCR with score >= the configured threshold. Tier B is stricter high-confidence deferred/unreviewed OCR.
- `fontFamily` is exported only as `weak_font_family`. It is not ground truth. Every `label` is null.
- exact duplicates are removed globally using a SHA-256 over mode, dimensions, and decoded crop pixels.

Fill `label_queue.csv` with reviewed Korean font labels before training.
"""


def prepare_output(output_root: Path, library_root: Path, *, overwrite: bool, dry_run: bool) -> None:
    output = output_root.resolve()
    library = library_root.resolve()
    dangerous = {Path(output.anchor).resolve(), Path.home().resolve(), Path.cwd().resolve(), library}
    if (
        output in dangerous
        or is_path_within(output, library)
        or is_path_within(library, output)
    ):
        raise ValueError(f"unsafe output path: {output}")
    if dry_run:
        return
    if output.exists() and any(output.iterdir()):
        if not overwrite:
            raise FileExistsError(f"output is not empty; pass --overwrite: {output}")
        marker = output / MARKER_NAME
        if not marker.is_file() or marker.read_text(encoding="utf-8") != MARKER_CONTENT:
            raise RuntimeError(f"refusing overwrite without the exact dataset marker: {marker}")
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / MARKER_NAME).write_text(MARKER_CONTENT, encoding="utf-8", newline="\n")


def parse_split_ratios(value: str) -> tuple[float, float, float]:
    try:
        values = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("ratios must be comma-separated numbers") from error
    if len(values) != 3 or any(part < 0 for part in values) or not math.isclose(sum(values), 1.0, abs_tol=1e-9):
        raise argparse.ArgumentTypeError("ratios must be train,val,test and sum to 1")
    return values  # type: ignore[return-value]


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-root", "--library", type=Path, default=repo_root / "library")
    parser.add_argument("--output-root", "--output", type=Path, default=repo_root / "fontclip_dataset")
    parser.add_argument("--max-chapters-per-work", type=int, default=10)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument("--split-ratios", type=parse_split_ratios, default=DEFAULT_SPLIT_RATIOS)
    parser.add_argument("--tier-a-min-score", type=float, default=0.90)
    parser.add_argument("--tier-b-min-score", type=float, default=0.985)
    parser.add_argument("--minimum-semantic-chars", type=int, default=2)
    parser.add_argument("--letterbox-size", type=int, default=224)
    parser.add_argument("--limit-works", type=int)
    parser.add_argument("--no-tier-b", action="store_true")
    parser.add_argument("--no-fallback", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser


def _progress(message: str, quiet: bool) -> None:
    if not quiet:
        print(message, flush=True)


def run(args: argparse.Namespace) -> dict[str, Any]:
    library_root = args.library_root.resolve()
    output_root = args.output_root.resolve()
    if args.max_chapters_per_work < 1 or args.max_chapters_per_work > 10:
        raise ValueError("--max-chapters-per-work must be between 1 and 10")
    if not 0 <= args.tier_a_min_score <= 1 or not 0 <= args.tier_b_min_score <= 1:
        raise ValueError("score thresholds must be between 0 and 1")
    if args.minimum_semantic_chars < 1 or args.letterbox_size < 1:
        raise ValueError("semantic character and letterbox sizes must be positive")
    prepare_output(output_root, library_root, overwrite=args.overwrite, dry_run=args.dry_run)
    works = load_library(library_root, args.limit_works)
    if not works:
        raise RuntimeError(f"no indexed works found in {library_root}")
    selections: list[SelectedChapter] = []
    scan_rejections: Counter[str] = Counter()
    for work_index, work in enumerate(works, 1):
        _progress(f"[scan {work_index}/{len(works)}] {work.title}", args.quiet)
        qualities: dict[str, ChapterQuality] = {}
        for chapter_index, chapter_id in enumerate(work.chapter_order):
            chapter = load_chapter(work, chapter_id, chapter_index)
            if chapter is None:
                scan_rejections["invalid_chapter"] += 1
                continue
            quality = evaluate_chapter_quality(
                chapter,
                tier_a_min_score=args.tier_a_min_score,
                tier_b_min_score=args.tier_b_min_score,
                minimum_semantic_chars=args.minimum_semantic_chars,
                include_tier_b=not args.no_tier_b,
            )
            qualities[chapter_id] = quality
            scan_rejections.update(quality.rejected)
        chosen = select_chapters_for_work(work, qualities, args.max_chapters_per_work)
        selections.extend(chosen)
        _progress(
            f"[select] {work.title}: {len(chosen)} chapters, "
            f"{sum(item.quality.candidate_count for item in chosen)} candidates",
            args.quiet,
        )
    expected_work_weights = {
        work.id: sum(
            item.quality.candidate_count
            for item in selections
            if item.work.id == work.id
        )
        for work in works
    }
    splits = assign_weighted_work_splits(
        expected_work_weights, args.seed, args.split_ratios
    )
    extraction_rejections: Counter[str] = Counter()
    main_plans, fallback_plans = build_crop_plans(
        selections,
        splits,
        library_root=library_root,
        tier_a_min_score=args.tier_a_min_score,
        tier_b_min_score=args.tier_b_min_score,
        minimum_semantic_chars=args.minimum_semantic_chars,
        include_tier_b=not args.no_tier_b,
        include_fallback=not args.no_fallback,
        rejection_counts=extraction_rejections,
    )
    _progress(f"[extract] {len(main_plans)} OCR plans, {len(fallback_plans)} fallback plans", args.quiet)
    duplicate_counts: Counter[str] = Counter()
    seen_hashes: set[str] = set()
    main_records = materialize_plans(
        main_plans,
        output_root,
        library_root,
        letterbox_size=args.letterbox_size,
        dry_run=args.dry_run,
        seen_hashes=seen_hashes,
        duplicate_counter=duplicate_counts,
    )
    fallback_records = materialize_plans(
        fallback_plans,
        output_root,
        library_root,
        letterbox_size=args.letterbox_size,
        dry_run=args.dry_run,
        seen_hashes=seen_hashes,
        duplicate_counter=duplicate_counts,
    )
    apply_balance_weights(main_records)
    apply_balance_weights(fallback_records)
    selected_payload = [
        {
            "work_id": item.work.id,
            "work_title": item.work.title,
            "split": splits[item.work.id],
            "chapter_id": item.chapter.id,
            "chapter_title": item.chapter.title,
            "chapter_order_index": item.chapter.order_index,
            "segment_index": item.segment_index,
            "segment_start_inclusive": item.segment_start,
            "segment_end_exclusive": item.segment_end,
            "tier_a_candidates": item.quality.tier_a,
            "tier_b_candidates": item.quality.tier_b,
            "candidate_count": item.quality.candidate_count,
            "ocr_pages": item.quality.ocr_pages,
            "missing_ocr_pages": item.quality.missing_ocr_pages,
        }
        for item in selections
    ]
    def record_counts(records: Sequence[Mapping[str, Any]], key: str) -> dict[str, int]:
        counts = Counter(str(record.get(key, "")) for record in records)
        return dict(sorted(counts.items()))
    stats = {
        "schema_version": SCHEMA_VERSION,
        "dry_run": bool(args.dry_run),
        "seed": args.seed,
        "library_root": str(library_root),
        "output_root": str(output_root),
        "works": len(works),
        "work_splits": dict(sorted(Counter(splits.values()).items())),
        "selected_chapters": len(selections),
        "main_plans": len(main_plans),
        "main_samples": len(main_records),
        "main_by_split": record_counts(main_records, "split"),
        "main_by_tier": record_counts(main_records, "tier"),
        "main_by_orientation": record_counts(main_records, "orientation"),
        "fallback_plans": len(fallback_plans),
        "fallback_samples": len(fallback_records),
        "fallback_by_split": record_counts(fallback_records, "split"),
        "duplicates_and_image_errors": dict(sorted(duplicate_counts.items())),
        "scan_rejections": dict(sorted(scan_rejections.items())),
        "extraction_rejections": dict(sorted(extraction_rejections.items())),
        "configuration": {
            "max_chapters_per_work": args.max_chapters_per_work,
            "tier_a_min_score": args.tier_a_min_score,
            "tier_b_min_score": args.tier_b_min_score,
            "minimum_semantic_chars": args.minimum_semantic_chars,
            "include_tier_b": not args.no_tier_b,
            "include_fallback": not args.no_fallback,
            "letterbox_size": args.letterbox_size,
            "split_ratios": list(args.split_ratios),
        },
    }
    if not args.dry_run:
        _write_jsonl(output_root / "manifest.jsonl", main_records)
        _write_jsonl(output_root / "manifests" / "all.jsonl", main_records)
        for split in SPLIT_NAMES:
            _write_jsonl(
                output_root / "manifests" / f"{split}.jsonl",
                (record for record in main_records if record["split"] == split),
            )
        _write_jsonl(output_root / "fallback" / "manifest.jsonl", fallback_records)
        for split in SPLIT_NAMES:
            _write_jsonl(
                output_root / "fallback" / "manifests" / f"{split}.jsonl",
                (record for record in fallback_records if record["split"] == split),
            )
        _write_json(output_root / "selected_chapters.json", selected_payload)
        _write_jsonl(output_root / "selected_chapters.jsonl", selected_payload)
        _write_json(output_root / "stats.json", stats)
        _write_label_queue(output_root / "label_queue.csv", main_records)
        (output_root / "README.md").write_text(_readme(args.letterbox_size), encoding="utf-8", newline="\n")
    _progress(
        f"[done] main={len(main_records)} fallback={len(fallback_records)} "
        f"duplicates={duplicate_counts['exact_duplicate']} dry_run={bool(args.dry_run)}",
        args.quiet,
    )
    return stats


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(2, f"error: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
