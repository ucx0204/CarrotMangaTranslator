#!/usr/bin/env python3
"""Evaluate Koharu layout masks as grouping anchors for existing PaddleOCR.

This is an offline research tool.  It does not replace PaddleOCR and it does
not modify the application library. Koharu text instances are block seeds;
bubble masks are ownership hints only and are never flattened into one block.
The resulting translation blocks are ordinary axis-aligned rectangles around
the assigned Paddle fragments.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps


SCHEMA_VERSION = "koharu-paddle-region-evaluation-v3"
MODEL_REPO = "mayocream/koharu-layout-rfdetr-seg-2xl-1152"
MODEL_REVISION = "aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2"
MODEL_SHA256 = "9bf6d2cbd7793c956d8c857bb1672a396eb7f100eb0682f86830d05e31168efb"
CLASS_NAMES = ("text", "onomatopoeia", "bubble", "panel")
CLASS_THRESHOLDS = {0: 0.25, 1: 0.20, 2: 0.50, 3: 0.50}
MIN_PREDICT_THRESHOLD = min(CLASS_THRESHOLDS.values())
NMS_IOU_THRESHOLD = 0.50
TEXT_IN_BUBBLE_MASK_THRESHOLD = 0.85
PADDLE_IN_TEXT_BOX_THRESHOLD = 0.30
PADDLE_IN_BUBBLE_MASK_THRESHOLD = 0.20
GROUP_ASSIGNMENT_MIN_SUPPORT = 0.45
GROUP_ASSIGNMENT_AMBIGUITY_MARGIN = 0.06
VERTICAL_FRAGMENT_ASPECT_RATIO = 1.50
CANDIDATE_MIN_PADDLE_FRAGMENTS = 8
CANDIDATE_MIN_ANCHOR_COVERAGE = 0.80
DEFAULT_CANDIDATE_COUNT = 36
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})
EXCLUDED_DIRECTORY_NAMES = frozenset(
    {
        ".tmp",
        "inpainted",
        "mask",
        "masks",
        "ocr-hints",
        "output",
        "outputs",
        "result",
        "results",
        "translated",
        "translation",
    }
)
DEFAULT_SEED = "koharu-paddle-region-evaluation-2026-08-31-v1"
MAX_SAMPLE_ASPECT_RATIO = 4.5

Image.MAX_IMAGE_PIXELS = None


class EvaluationError(RuntimeError):
    """Raised when an evaluation contract cannot be proven."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_json(value), encoding="utf-8")


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvaluationError(f"could not read JSON {path}: {error}") from error


def stable_hash(*parts: str) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode("utf-8", errors="surrogatepass"))
        digest.update(b"\0")
    return digest.hexdigest()


def natural_key(value: str) -> tuple[Any, ...]:
    return tuple(int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value))


def resolve_existing_directory(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise EvaluationError(f"{label} is not a directory: {path}")
    return path


def resolve_output_directory(value: str, forbidden_root: Path) -> Path:
    path = Path(value).expanduser().resolve()
    try:
        path.relative_to(forbidden_root)
    except ValueError:
        pass
    else:
        raise EvaluationError("evaluation output must not be created inside the source manga root")
    path.mkdir(parents=True, exist_ok=True)
    return path


def discover_chapter_candidates(manga_root: Path, seed: str) -> list[dict[str, Any]]:
    chapters: dict[Path, list[Path]] = defaultdict(list)
    for directory, child_directories, filenames in os.walk(manga_root, followlinks=False):
        child_directories[:] = [
            name
            for name in child_directories
            if name.casefold() not in EXCLUDED_DIRECTORY_NAMES
            and not (Path(directory) / name).is_symlink()
        ]
        directory_path = Path(directory)
        for filename in filenames:
            path = directory_path / filename
            if path.suffix.casefold() in IMAGE_EXTENSIONS:
                chapters[directory_path].append(path)

    candidates: list[dict[str, Any]] = []
    for directory, pages in chapters.items():
        relative_directory = directory.relative_to(manga_root)
        parts = relative_directory.parts
        if len(parts) < 2:
            continue
        pages.sort(key=lambda path: natural_key(path.name))
        interior = pages[1:-1] if len(pages) >= 5 else pages
        if not interior:
            continue
        selector = int(stable_hash(seed, relative_directory.as_posix())[:16], 16)
        path = interior[selector % len(interior)]
        relative = path.relative_to(manga_root)
        candidates.append(
            {
                "path": path,
                "relativePath": relative.as_posix(),
                "source": parts[0],
                "series": parts[1],
                "chapter": "/".join(parts[2:]) or directory.name,
                "selectionHash": stable_hash(seed, relative.as_posix()),
            }
        )
    return candidates


def choose_diverse_candidates(
    candidates: Sequence[dict[str, Any]], count: int
) -> list[dict[str, Any]]:
    if count <= 0:
        raise EvaluationError("sample count must be positive")
    pools: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        pools[str(candidate["source"])].append(candidate)
    for pool in pools.values():
        pool.sort(key=lambda item: (item["selectionHash"], item["relativePath"]))

    selected: list[dict[str, Any]] = []
    series_counts: Counter[tuple[str, str]] = Counter()
    sources = sorted(pools, key=natural_key)
    while len(selected) < count and any(pools.values()):
        made_progress = False
        for source in sources:
            pool = pools[source]
            if not pool or len(selected) >= count:
                continue
            minimum_series_count = min(
                series_counts[(source, str(candidate["series"]))] for candidate in pool
            )
            index = next(
                index
                for index, candidate in enumerate(pool)
                if series_counts[(source, str(candidate["series"]))]
                == minimum_series_count
            )
            candidate = pool.pop(index)
            selected.append(candidate)
            series_counts[(source, str(candidate["series"]))] += 1
            made_progress = True
        if not made_progress:
            break
    return selected


def inspect_selected_image(candidate: Mapping[str, Any]) -> dict[str, Any] | None:
    path = Path(candidate["path"])
    try:
        with Image.open(path) as image:
            width, height = ImageOps.exif_transpose(image).size
    except (OSError, ValueError):
        return None
    if width < 128 or height < 128:
        return None
    aspect = max(width / height, height / width)
    if aspect > MAX_SAMPLE_ASPECT_RATIO:
        return None
    return {
        **{key: value for key, value in candidate.items() if key != "path"},
        "path": str(path.resolve()),
        "width": width,
        "height": height,
    }


def select_pages(args: argparse.Namespace) -> None:
    manga_root = resolve_existing_directory(args.manga_root, "manga root")
    output_dir = resolve_output_directory(args.output_dir, manga_root)
    candidates = discover_chapter_candidates(manga_root, args.seed)
    ordered = choose_diverse_candidates(candidates, max(args.count * 3, args.count))
    selected: list[dict[str, Any]] = []
    for candidate in ordered:
        inspected = inspect_selected_image(candidate)
        if inspected is None:
            continue
        inspected["id"] = f"P{len(selected) + 1:03d}"
        selected.append(inspected)
        if len(selected) >= args.count:
            break
    if len(selected) < args.count:
        raise EvaluationError(
            f"only {len(selected)} valid pages were available for a requested {args.count}"
        )

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "seed": args.seed,
        "mangaRoot": str(manga_root),
        "sampleCount": len(selected),
        "selectionPolicy": {
            "oneCandidatePerChapter": True,
            "sourceRoundRobin": True,
            "seriesBalancedWithinSource": True,
            "maximumAspectRatio": MAX_SAMPLE_ASPECT_RATIO,
        },
        "items": selected,
    }
    paddle_dir = output_dir / "paddle"
    paddle_dir.mkdir(parents=True, exist_ok=True)
    paddle_batch = {
        "items": [
            {
                "image": item["path"],
                "output": str((paddle_dir / f"{item['id']}.json").resolve()),
            }
            for item in selected
        ]
    }
    write_json(output_dir / "manifest.json", manifest)
    write_json(output_dir / "paddle-batch.json", paddle_batch)
    print(f"[select] {len(selected)} pages -> {output_dir / 'manifest.json'}", flush=True)


def bbox_area(box: Sequence[float]) -> float:
    return max(0.0, float(box[2]) - float(box[0])) * max(
        0.0, float(box[3]) - float(box[1])
    )


def bbox_intersection(a: Sequence[float], b: Sequence[float]) -> float:
    return max(0.0, min(float(a[2]), float(b[2])) - max(float(a[0]), float(b[0]))) * max(
        0.0, min(float(a[3]), float(b[3])) - max(float(a[1]), float(b[1]))
    )


def bbox_iou(a: Sequence[float], b: Sequence[float]) -> float:
    intersection = bbox_intersection(a, b)
    union = bbox_area(a) + bbox_area(b) - intersection
    return intersection / union if union > 0 else 0.0


def bbox_ioa(subject: Sequence[float], container: Sequence[float]) -> float:
    area = bbox_area(subject)
    return bbox_intersection(subject, container) / area if area > 0 else 0.0


def clip_bbox(box: Sequence[float], width: int, height: int) -> list[float]:
    left = min(max(float(box[0]), 0.0), float(width))
    top = min(max(float(box[1]), 0.0), float(height))
    right = min(max(float(box[2]), left), float(width))
    bottom = min(max(float(box[3]), top), float(height))
    return [left, top, right, bottom]


def union_bbox(boxes: Iterable[Sequence[float]]) -> list[float]:
    materialized = [list(map(float, box)) for box in boxes]
    if not materialized:
        raise EvaluationError("cannot union an empty box list")
    return [
        min(box[0] for box in materialized),
        min(box[1] for box in materialized),
        max(box[2] for box in materialized),
        max(box[3] for box in materialized),
    ]


def padded_bbox(box: Sequence[float], width: int, height: int) -> list[float]:
    padding = min(12.0, max(3.0, min(width, height) * 0.006))
    return clip_bbox(
        [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding],
        width,
        height,
    )


def mask_bbox(mask: np.ndarray) -> list[float] | None:
    rows, columns = np.nonzero(mask)
    if not len(columns):
        return None
    return [
        float(columns.min()),
        float(rows.min()),
        float(columns.max() + 1),
        float(rows.max() + 1),
    ]


def center_in_mask(mask: np.ndarray, box: Sequence[float]) -> bool:
    x = int(round((float(box[0]) + float(box[2])) / 2.0))
    y = int(round((float(box[1]) + float(box[3])) / 2.0))
    return 0 <= x < mask.shape[1] and 0 <= y < mask.shape[0] and bool(mask[y, x])


def rect_mask_coverage(mask: np.ndarray, box: Sequence[float]) -> float:
    left = max(0, int(math.floor(float(box[0]))))
    top = max(0, int(math.floor(float(box[1]))))
    right = min(mask.shape[1], int(math.ceil(float(box[2]))))
    bottom = min(mask.shape[0], int(math.ceil(float(box[3]))))
    if right <= left or bottom <= top:
        return 0.0
    return float(np.count_nonzero(mask[top:bottom, left:right])) / float(
        (right - left) * (bottom - top)
    )


def mask_containment(subject: np.ndarray, container: np.ndarray) -> float:
    subject_area = int(np.count_nonzero(subject))
    if subject_area <= 0:
        return 0.0
    return float(np.count_nonzero(np.logical_and(subject, container))) / float(subject_area)


def split_disconnected_bubble(mask: np.ndarray) -> list[np.ndarray]:
    """Split only clearly disconnected, substantial components of one bubble mask."""

    try:
        from scipy import ndimage
    except ImportError:
        return [mask]
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
    if count <= 1:
        return [mask]
    areas = np.bincount(labels.reshape(-1))[1:]
    total = int(areas.sum())
    minimum = max(64, int(total * 0.08))
    eligible = [index + 1 for index, area in enumerate(areas) if int(area) >= minimum]
    if len(eligible) <= 1:
        return [mask]
    return [labels == label for label in eligible]


def nms_indices(
    boxes: Sequence[Sequence[float]],
    scores: Sequence[float],
    class_ids: Sequence[int],
    threshold: float,
) -> list[int]:
    kept: list[int] = []
    for class_id in sorted(set(int(value) for value in class_ids)):
        pending = sorted(
            [index for index, value in enumerate(class_ids) if int(value) == class_id],
            key=lambda index: (-float(scores[index]), index),
        )
        while pending:
            winner = pending.pop(0)
            kept.append(winner)
            pending = [
                index
                for index in pending
                if bbox_iou(boxes[winner], boxes[index]) <= threshold
            ]
    return sorted(kept)


def load_layout_model() -> tuple[Any, Any]:
    from huggingface_hub import hf_hub_download

    weights = hf_hub_download(
        repo_id=MODEL_REPO,
        filename="model.safetensors",
        revision=MODEL_REVISION,
    )
    loader_path = hf_hub_download(
        repo_id=MODEL_REPO,
        filename="load_model.py",
        revision=MODEL_REVISION,
    )
    digest = hashlib.sha256(Path(weights).read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        raise EvaluationError(
            f"Koharu layout weight hash mismatch: expected {MODEL_SHA256}, got {digest}"
        )
    spec = importlib.util.spec_from_file_location("koharu_layout_loader", loader_path)
    if spec is None or spec.loader is None:
        raise EvaluationError(f"could not import Koharu loader: {loader_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.load_model(weights)
    model.optimize_for_inference(compile=False)
    return model, module


def normalized_paddle_items(payload: Mapping[str, Any], width: int, height: int) -> list[dict[str, Any]]:
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise EvaluationError("Paddle result does not contain an items array")
    items: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, Mapping):
            continue
        try:
            box = clip_bbox(
                [raw["x1"], raw["y1"], raw["x2"], raw["y2"]], width, height
            )
        except (KeyError, TypeError, ValueError):
            continue
        if bbox_area(box) <= 0:
            continue
        items.append(
            {
                "index": index,
                "id": str(raw.get("reviewFragmentId") or raw.get("id") or index + 1),
                "bbox": box,
                "text": str(raw.get("ocrText") or ""),
                "score": float(raw.get("score") or 0.0),
                "status": str(raw.get("reviewStatus") or "unknown"),
                "reviewFragmentId": str(raw.get("reviewFragmentId") or ""),
                "groupId": str(raw.get("groupId") or raw.get("paddleGroupId") or ""),
                "reasons": [str(value) for value in raw.get("reviewReasons") or []],
            }
        )
    return items


def prepare_layout_detections(result: Any, width: int, height: int) -> list[dict[str, Any]]:
    boxes = np.asarray(result.xyxy, dtype=np.float32)
    class_ids = np.asarray(result.class_id, dtype=np.int64)
    scores = np.asarray(result.confidence, dtype=np.float32)
    masks = np.asarray(result.mask, dtype=bool)
    threshold_keep = np.asarray(
        [float(score) >= CLASS_THRESHOLDS[int(class_id)] for class_id, score in zip(class_ids, scores)],
        dtype=bool,
    )
    boxes = boxes[threshold_keep]
    class_ids = class_ids[threshold_keep]
    scores = scores[threshold_keep]
    masks = masks[threshold_keep]
    keep = nms_indices(boxes, scores, class_ids, NMS_IOU_THRESHOLD)
    detections: list[dict[str, Any]] = []
    for output_index, index in enumerate(keep):
        class_id = int(class_ids[index])
        mask = masks[index]
        box = mask_bbox(mask) or clip_bbox(boxes[index].tolist(), width, height)
        detections.append(
            {
                "id": f"K{output_index + 1:03d}",
                "classId": class_id,
                "class": CLASS_NAMES[class_id],
                "score": float(scores[index]),
                "bbox": clip_bbox(box, width, height),
                "mask": mask,
                "maskArea": int(np.count_nonzero(mask)),
            }
        )
    return detections


def build_anchors(detections: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    bubbles: list[dict[str, Any]] = []
    for detection in detections:
        if detection["class"] != "bubble":
            continue
        components = split_disconnected_bubble(detection["mask"])
        for component_index, component in enumerate(components):
            component_box = mask_bbox(component)
            if component_box is None:
                continue
            bubbles.append(
                {
                    "id": f"B{len(bubbles) + 1:03d}",
                    "bbox": component_box,
                    "mask": component,
                    "score": detection["score"],
                    "sourceDetectionId": detection["id"],
                    "componentIndex": component_index,
                }
            )

    texts = [detection for detection in detections if detection["class"] == "text"]
    text_bubbles: dict[str, dict[str, Any]] = {}
    for text in texts:
        candidates: list[tuple[float, dict[str, Any]]] = []
        for bubble in bubbles:
            containment = mask_containment(text["mask"], bubble["mask"])
            box_containment = bbox_ioa(text["bbox"], bubble["bbox"])
            centered = center_in_mask(bubble["mask"], text["bbox"])
            if containment >= TEXT_IN_BUBBLE_MASK_THRESHOLD or (
                centered and box_containment >= 0.70
            ):
                candidates.append((max(containment, box_containment * 0.9), bubble))
        if candidates:
            _, bubble = max(candidates, key=lambda value: (value[0], value[1]["score"]))
            text_bubbles[text["id"]] = bubble

    anchors: list[dict[str, Any]] = []
    for text in texts:
        bubble = text_bubbles.get(text["id"])
        anchors.append(
            {
                "id": f"T{len(anchors) + 1:03d}",
                "kind": "text",
                "bbox": text["bbox"],
                "mask": text["mask"],
                "score": text["score"],
                "sourceDetectionId": text["id"],
                "bubbleDetectionId": bubble["sourceDetectionId"] if bubble else None,
                "bubbleMask": bubble["mask"] if bubble else None,
                "textDetectionIds": [text["id"]],
                "paddleIndexes": [],
            }
        )
    for sfx in (detection for detection in detections if detection["class"] == "onomatopoeia"):
        anchors.append(
            {
                "id": f"S{sum(anchor['kind'] == 'sfx' for anchor in anchors) + 1:03d}",
                "kind": "sfx",
                "bbox": sfx["bbox"],
                "mask": sfx["mask"],
                "score": sfx["score"],
                "sourceDetectionId": sfx["id"],
                "bubbleDetectionId": None,
                "textDetectionIds": [],
                "paddleIndexes": [],
            }
        )
    return anchors


def anchor_assignment_score(
    anchor: Mapping[str, Any],
    paddle_box: Sequence[float],
    *,
    allow_bbox_only: bool,
) -> float | None:
    bubble_mask = anchor.get("bubbleMask")
    if bubble_mask is not None:
        bubble_coverage = rect_mask_coverage(bubble_mask, paddle_box)
        bubble_centered = center_in_mask(bubble_mask, paddle_box)
        if (
            bubble_coverage < PADDLE_IN_BUBBLE_MASK_THRESHOLD
            and not bubble_centered
        ):
            return None

    coverage = rect_mask_coverage(anchor["mask"], paddle_box)
    centered = center_in_mask(anchor["mask"], paddle_box)
    box_containment = bbox_ioa(paddle_box, anchor["bbox"])
    kind = anchor["kind"]
    if allow_bbox_only:
        if (
            coverage < 0.08
            and box_containment < PADDLE_IN_TEXT_BOX_THRESHOLD
            and not centered
        ):
            return None
    elif coverage < 0.08 and not centered:
        return None
    class_bonus = 0.04 if kind == "text" else 0.0
    return max(coverage, box_containment, 0.70 if centered else 0.0) + class_bonus


def paddle_assignment_group_key(item: Mapping[str, Any], index: int) -> str:
    group_id = str(item.get("groupId") or "").strip()
    status = str(item.get("status") or "").strip().lower()
    if group_id and status == "confirmed":
        return f"group:{group_id}"
    review_fragment_id = str(item.get("reviewFragmentId") or "").strip()
    if review_fragment_id:
        return f"review:{review_fragment_id}"
    return f"single:{index}"


def assign_paddle_items(
    anchors: list[dict[str, Any]], paddle_items: Sequence[dict[str, Any]]
) -> list[int]:
    assignment_groups: dict[str, list[int]] = defaultdict(list)
    for paddle_index, item in enumerate(paddle_items):
        assignment_groups[paddle_assignment_group_key(item, paddle_index)].append(
            paddle_index
        )

    unassigned: list[int] = []
    for paddle_indexes in assignment_groups.values():
        has_confirmed_group = any(
            str(paddle_items[index].get("groupId") or "").strip()
            and str(paddle_items[index].get("status") or "").lower() == "confirmed"
            for index in paddle_indexes
        )
        total_area = sum(
            max(1.0, bbox_area(paddle_items[index]["bbox"]))
            for index in paddle_indexes
        )
        candidates: list[tuple[float, str, dict[str, Any]]] = []
        for anchor in anchors:
            supported_area = 0.0
            weighted_score = 0.0
            for paddle_index in paddle_indexes:
                item_area = max(1.0, bbox_area(paddle_items[paddle_index]["bbox"]))
                score = anchor_assignment_score(
                    anchor,
                    paddle_items[paddle_index]["bbox"],
                    allow_bbox_only=has_confirmed_group,
                )
                if score is None:
                    continue
                supported_area += item_area
                weighted_score += item_area * score
            support_ratio = supported_area / total_area
            if support_ratio < GROUP_ASSIGNMENT_MIN_SUPPORT:
                continue
            aggregate_score = weighted_score / total_area + support_ratio * 0.05
            candidates.append((aggregate_score, str(anchor["id"]), anchor))
        if not candidates:
            unassigned.extend(paddle_indexes)
            continue
        candidates.sort(key=lambda value: (value[0], value[1]), reverse=True)
        winner_score, _, winner = candidates[0]
        if (
            len(candidates) > 1
            and winner_score - candidates[1][0]
            < GROUP_ASSIGNMENT_AMBIGUITY_MARGIN
        ):
            unassigned.extend(paddle_indexes)
            continue
        winner["paddleIndexes"].extend(paddle_indexes)
    return unassigned


def fallback_groups(
    paddle_items: Sequence[dict[str, Any]], unassigned: Sequence[int]
) -> list[list[int]]:
    groups: dict[str, list[int]] = defaultdict(list)
    for index in unassigned:
        item = paddle_items[index]
        groups[paddle_assignment_group_key(item, index)].append(index)
    return list(groups.values())


def build_final_blocks(
    anchors: Sequence[dict[str, Any]],
    paddle_items: Sequence[dict[str, Any]],
    unassigned: Sequence[int],
    width: int,
    height: int,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for anchor in anchors:
        indexes = list(anchor["paddleIndexes"])
        if not indexes:
            continue
        if anchor["kind"] == "text" and anchor.get("bubbleDetectionId"):
            anchor_groups = [indexes]
        else:
            grouped_indexes: dict[str, list[int]] = defaultdict(list)
            for index in indexes:
                grouped_indexes[
                    paddle_assignment_group_key(paddle_items[index], index)
                ].append(index)
            anchor_groups = list(grouped_indexes.values())
        for group in anchor_groups:
            box = padded_bbox(
                union_bbox(paddle_items[index]["bbox"] for index in group),
                width,
                height,
            )
            blocks.append(
                {
                    "id": f"C{len(blocks) + 1:03d}",
                    "kind": anchor["kind"],
                    "bbox": box,
                    "anchorId": anchor["id"],
                    "anchorScore": anchor["score"],
                    "bubbleDetectionId": anchor.get("bubbleDetectionId"),
                    "textDetectionIds": list(anchor["textDetectionIds"]),
                    "paddleIndexes": list(group),
                    "paddleIds": [paddle_items[index]["id"] for index in group],
                    "fragmentCount": len(group),
                    "ocrText": "\n".join(
                        paddle_items[index]["text"]
                        for index in group
                        if paddle_items[index]["text"]
                    ),
                }
            )
    for group in fallback_groups(paddle_items, unassigned):
        box = padded_bbox(union_bbox(paddle_items[index]["bbox"] for index in group), width, height)
        blocks.append(
            {
                "id": f"C{len(blocks) + 1:03d}",
                "kind": "paddle_fallback",
                "bbox": box,
                "anchorId": None,
                "anchorScore": None,
                "bubbleDetectionId": None,
                "textDetectionIds": [],
                "paddleIndexes": list(group),
                "paddleIds": [paddle_items[index]["id"] for index in group],
                "fragmentCount": len(group),
                "ocrText": "\n".join(paddle_items[index]["text"] for index in group if paddle_items[index]["text"]),
            }
        )
    blocks.sort(key=lambda block: (float(block["bbox"][1]), -float(block["bbox"][0])))
    for index, block in enumerate(blocks, 1):
        block["id"] = f"C{index:03d}"
    return blocks


def serializable_detection(detection: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": detection["id"],
        "class": detection["class"],
        "score": round(float(detection["score"]), 6),
        "bbox": [round(float(value), 3) for value in detection["bbox"]],
        "maskArea": int(detection["maskArea"]),
    }


def serializable_anchor(anchor: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": anchor["id"],
        "kind": anchor["kind"],
        "score": round(float(anchor["score"]), 6),
        "bbox": [round(float(value), 3) for value in anchor["bbox"]],
        "sourceDetectionId": anchor["sourceDetectionId"],
        "bubbleDetectionId": anchor.get("bubbleDetectionId"),
        "textDetectionIds": list(anchor["textDetectionIds"]),
        "paddleIndexes": list(anchor["paddleIndexes"]),
    }


def paddle_group_key(item: Mapping[str, Any]) -> str:
    keys = (
        ("groupId", "reviewFragmentId", "id")
        if str(item.get("status") or "").strip().lower() == "confirmed"
        else ("reviewFragmentId", "id")
    )
    for key in keys:
        value = str(item.get(key) or "").strip()
        if value:
            return value
    return f"index:{item.get('index', '?')}"


def candidate_evidence(record: Mapping[str, Any]) -> dict[str, Any]:
    paddle_items = record["paddleItems"]
    cross_group_blocks = 0
    vertical_cross_group_blocks = 0
    involved_groups: set[str] = set()
    involved_fragments: set[int] = set()
    evidence_blocks: list[dict[str, Any]] = []

    for block in record["finalBlocks"]:
        if block["kind"] != "text" or not block.get("bubbleDetectionId"):
            continue
        indexes = [int(value) for value in block["paddleIndexes"]]
        items = [paddle_items[index] for index in indexes]
        group_ids = sorted({paddle_group_key(item) for item in items}, key=natural_key)
        if len(group_ids) < 2:
            continue
        cross_group_blocks += 1
        vertical_indexes = [
            index
            for index, item in zip(indexes, items)
            if float(item["bbox"][3]) - float(item["bbox"][1])
            >= VERTICAL_FRAGMENT_ASPECT_RATIO
            * (float(item["bbox"][2]) - float(item["bbox"][0]))
        ]
        is_vertical_case = len(vertical_indexes) >= 2
        vertical_cross_group_blocks += int(is_vertical_case)
        involved_groups.update(group_ids)
        involved_fragments.update(indexes)
        evidence_blocks.append(
            {
                "blockId": block["id"],
                "groupIds": group_ids,
                "fragmentCount": len(indexes),
                "verticalFragmentCount": len(vertical_indexes),
                "isVerticalCase": is_vertical_case,
                "textDetectionIds": list(block["textDetectionIds"]),
            }
        )

    metrics = record["metrics"]
    eligible = (
        vertical_cross_group_blocks >= 1
        and int(metrics["paddleFragmentCount"]) >= CANDIDATE_MIN_PADDLE_FRAGMENTS
        and float(metrics["anchorCoverage"]) >= CANDIDATE_MIN_ANCHOR_COVERAGE
    )
    score = (
        vertical_cross_group_blocks * 1000
        + cross_group_blocks * 200
        + len(involved_groups) * 20
        + len(involved_fragments) * 5
        + int(metrics["textMergedBlockCount"])
    )
    return {
        "eligible": eligible,
        "score": score,
        "crossGroupTextMergeCount": cross_group_blocks,
        "verticalCrossGroupTextMergeCount": vertical_cross_group_blocks,
        "involvedPaddleGroupCount": len(involved_groups),
        "involvedPaddleFragmentCount": len(involved_fragments),
        "blocks": evidence_blocks,
    }


def attach_candidate_evidence(record: dict[str, Any]) -> None:
    evidence = candidate_evidence(record)
    record["candidateEvidence"] = evidence
    record["metrics"].update(
        {
            "candidateScore": evidence["score"],
            "crossGroupTextMergeCount": evidence["crossGroupTextMergeCount"],
            "verticalCrossGroupTextMergeCount": evidence[
                "verticalCrossGroupTextMergeCount"
            ],
        }
    )


def analyze_page(
    model: Any,
    item: Mapping[str, Any],
    paddle_payload: Mapping[str, Any],
) -> tuple[dict[str, Any], float]:
    path = Path(item["path"])
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    width, height = image.size
    started = time.perf_counter()
    result = model.predict(
        image,
        threshold=MIN_PREDICT_THRESHOLD,
        shape=(1152, 1152),
        include_source_image=False,
    )
    elapsed = time.perf_counter() - started
    detections = prepare_layout_detections(result, width, height)
    paddle_items = normalized_paddle_items(paddle_payload, width, height)
    anchors = build_anchors(detections)
    unassigned = assign_paddle_items(anchors, paddle_items)
    blocks = build_final_blocks(anchors, paddle_items, unassigned, width, height)

    merged_fragments = sum(max(0, int(block["fragmentCount"]) - 1) for block in blocks)
    text_merged_blocks = sum(
        block["kind"] == "text" and int(block["fragmentCount"]) > 1 for block in blocks
    )
    anchored_fragments = len(paddle_items) - len(unassigned)
    detector_only_anchors = sum(not anchor["paddleIndexes"] for anchor in anchors)
    metrics = {
        "paddleFragmentCount": len(paddle_items),
        "finalBlockCount": len(blocks),
        "mergedFragmentCount": merged_fragments,
        "textMergedBlockCount": text_merged_blocks,
        "anchoredFragmentCount": anchored_fragments,
        "fallbackFragmentCount": len(unassigned),
        "anchorCoverage": round(anchored_fragments / max(1, len(paddle_items)), 6),
        "detectorOnlyAnchorCount": detector_only_anchors,
        "koharuTextCount": sum(detection["class"] == "text" for detection in detections),
        "koharuBubbleCount": sum(detection["class"] == "bubble" for detection in detections),
        "koharuSfxCount": sum(detection["class"] == "onomatopoeia" for detection in detections),
        "problemScore": text_merged_blocks * 10 + merged_fragments * 3 + anchored_fragments,
    }
    record = {
        "schemaVersion": SCHEMA_VERSION,
        "id": item["id"],
        "path": item["path"],
        "relativePath": item["relativePath"],
        "source": item["source"],
        "series": item["series"],
        "chapter": item["chapter"],
        "width": width,
        "height": height,
        "paddleSource": paddle_payload.get("source"),
        "paddleItems": paddle_items,
        "koharuDetections": [serializable_detection(value) for value in detections],
        "anchors": [serializable_anchor(value) for value in anchors],
        "finalBlocks": blocks,
        "metrics": metrics,
        "timing": {"koharuDetectionSeconds": round(elapsed, 6)},
    }
    attach_candidate_evidence(record)
    return record, elapsed


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/malgunbd.ttf" if bold else "C:/Windows/Fonts/malgun.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def truncate_text(draw: ImageDraw.ImageDraw, text: str, font: Any, max_width: int) -> str:
    if draw.textlength(text, font=font) <= max_width:
        return text
    suffix = "…"
    value = text
    while value and draw.textlength(value + suffix, font=font) > max_width:
        value = value[:-1]
    return value + suffix


def draw_dashed_rectangle(
    draw: ImageDraw.ImageDraw,
    box: Sequence[float],
    color: tuple[int, int, int, int],
    width: int,
    dash: int = 10,
) -> None:
    left, top, right, bottom = (int(round(value)) for value in box)
    for start in range(left, right, dash * 2):
        draw.line((start, top, min(start + dash, right), top), fill=color, width=width)
        draw.line((start, bottom, min(start + dash, right), bottom), fill=color, width=width)
    for start in range(top, bottom, dash * 2):
        draw.line((left, start, left, min(start + dash, bottom)), fill=color, width=width)
        draw.line((right, start, right, min(start + dash, bottom)), fill=color, width=width)


def transformed_box(box: Sequence[float], scale: float) -> list[float]:
    return [float(value) * scale for value in box]


def draw_box_label(
    draw: ImageDraw.ImageDraw,
    box: Sequence[float],
    label: str,
    color: tuple[int, int, int, int],
    font: Any,
) -> None:
    left, top, _, _ = box
    text_box = draw.textbbox((0, 0), label, font=font)
    width = text_box[2] - text_box[0] + 10
    height = text_box[3] - text_box[1] + 8
    x = max(0, int(left))
    y = max(0, int(top) - height)
    draw.rounded_rectangle((x, y, x + width, y + height), radius=4, fill=color)
    draw.text((x + 5, y + 3), label, font=font, fill=(255, 255, 255, 255))


def render_panel_b(record: Mapping[str, Any], source: Image.Image, scale: float) -> Image.Image:
    panel = source.copy().convert("RGBA")
    draw = ImageDraw.Draw(panel, "RGBA")
    font = load_font(max(14, int(18 * min(1.0, scale))))
    line_width = max(2, int(round(3 / max(scale, 0.25))))
    for index, item in enumerate(record["paddleItems"], 1):
        color = (239, 68, 68, 255) if item["status"] == "confirmed" else (245, 158, 11, 255)
        box = transformed_box(item["bbox"], scale)
        draw.rectangle(box, outline=color, width=line_width)
        draw_box_label(draw, box, f"P{index}", color, font)
    return panel


def render_panel_c(record: Mapping[str, Any], source: Image.Image, scale: float) -> Image.Image:
    panel = source.copy().convert("RGBA")
    draw = ImageDraw.Draw(panel, "RGBA")
    label_font = load_font(max(14, int(18 * min(1.0, scale))), bold=True)
    thin = max(1, int(round(2 / max(scale, 0.25))))
    thick = max(2, int(round(4 / max(scale, 0.25))))
    for detection in record["koharuDetections"]:
        if detection["class"] == "bubble":
            draw_dashed_rectangle(
                draw,
                transformed_box(detection["bbox"], scale),
                (6, 182, 212, 230),
                thin,
            )
        elif detection["class"] == "text":
            draw_dashed_rectangle(
                draw,
                transformed_box(detection["bbox"], scale),
                (59, 130, 246, 220),
                thin,
                dash=7,
            )
    for block in record["finalBlocks"]:
        color = (34, 197, 94, 255) if block["kind"] != "paddle_fallback" else (249, 115, 22, 255)
        box = transformed_box(block["bbox"], scale)
        draw.rounded_rectangle(box, radius=5, outline=color, width=thick)
        draw_box_label(
            draw,
            box,
            f"{block['id']} · {block['fragmentCount']}조각",
            color,
            label_font,
        )
    return panel


def render_composite(record: Mapping[str, Any], output_path: Path) -> None:
    with Image.open(record["path"]) as opened:
        original = ImageOps.exif_transpose(opened).convert("RGB")
    panel_width = 700
    max_panel_height = 1600
    scale = min(panel_width / original.width, max_panel_height / original.height)
    display_size = (
        max(1, int(round(original.width * scale))),
        max(1, int(round(original.height * scale))),
    )
    source = original.resize(display_size, Image.Resampling.LANCZOS)
    panel_a = source.convert("RGBA")
    panel_b = render_panel_b(record, source, scale)
    panel_c = render_panel_c(record, source, scale)

    title_height = 54
    header_height = 104
    gap = 18
    margin = 20
    canvas_width = margin * 2 + display_size[0] * 3 + gap * 2
    canvas_height = margin * 2 + title_height + header_height + display_size[1]
    canvas = Image.new("RGB", (canvas_width, canvas_height), (15, 23, 42))
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(24, bold=True)
    header_font = load_font(25, bold=True)
    small_font = load_font(17)
    title = f"{record['id']} · {record['relativePath']}"
    draw.text(
        (margin, margin + 8),
        truncate_text(draw, title, title_font, canvas_width - margin * 2),
        font=title_font,
        fill=(241, 245, 249),
    )
    headers = [
        ("A · 원문", "박스 없음"),
        (
            f"B · PaddleOCR 원시 조각 ({record['metrics']['paddleFragmentCount']})",
            "빨강=확정 · 주황=검토 필요",
        ),
        (
            f"C · Koharu→번역 블록 ({record['metrics']['finalBlockCount']})",
            "청록 점선=bubble · 파랑 점선=text · 초록=최종 · 주황=Fallback",
        ),
    ]
    panels = [panel_a, panel_b, panel_c]
    image_y = margin + title_height + header_height
    for index, (panel, (heading, detail)) in enumerate(zip(panels, headers)):
        x = margin + index * (display_size[0] + gap)
        draw.rounded_rectangle(
            (x, margin + title_height, x + display_size[0], image_y - 8),
            radius=10,
            fill=(30, 41, 59),
        )
        draw.text((x + 14, margin + title_height + 12), heading, font=header_font, fill=(248, 250, 252))
        detail_text = truncate_text(draw, detail, small_font, display_size[0] - 28)
        draw.text((x + 14, margin + title_height + 54), detail_text, font=small_font, fill=(203, 213, 225))
        canvas.paste(panel.convert("RGB"), (x, image_y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG", compress_level=4)


def choose_diverse_scored_records(
    records: Sequence[Mapping[str, Any]], count: int
) -> list[Mapping[str, Any]]:
    by_source: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for record in records:
        by_source[str(record["source"])].append(record)
    for pool in by_source.values():
        pool.sort(
            key=lambda record: (
                -int(record["metrics"]["candidateScore"]),
                -int(record["metrics"]["problemScore"]),
                stable_hash(str(record["relativePath"])),
            )
        )
    selected: list[Mapping[str, Any]] = []
    series_counts: Counter[tuple[str, str]] = Counter()
    sources = sorted(by_source, key=natural_key)
    while len(selected) < count and any(by_source.values()):
        progressed = False
        for source in sources:
            pool = by_source[source]
            if not pool or len(selected) >= count:
                continue
            preferred = next(
                (
                    index
                    for index, record in enumerate(pool)
                    if series_counts[(source, str(record["series"]))] == 0
                ),
                0,
            )
            record = pool.pop(preferred)
            selected.append(record)
            series_counts[(source, str(record["series"]))] += 1
            progressed = True
        if not progressed:
            break
    return selected


def choose_candidate_pool(
    records: Sequence[Mapping[str, Any]], count: int
) -> list[Mapping[str, Any]]:
    eligible = [record for record in records if record["candidateEvidence"]["eligible"]]
    return choose_diverse_scored_records(eligible, min(count, len(eligible)))


def choose_representatives(
    candidates: Sequence[Mapping[str, Any]], count: int
) -> list[Mapping[str, Any]]:
    return choose_diverse_scored_records(candidates, min(count, len(candidates)))


def build_contact_sheets(
    composite_paths: Sequence[Path], output_dir: Path, title: str
) -> list[Path]:
    outputs: list[Path] = []
    per_sheet = 10
    for sheet_index in range(0, len(composite_paths), per_sheet):
        batch = composite_paths[sheet_index : sheet_index + per_sheet]
        thumbnails: list[Image.Image] = []
        for path in batch:
            with Image.open(path) as opened:
                image = opened.convert("RGB")
            image.thumbnail((900, 760), Image.Resampling.LANCZOS)
            thumbnails.append(image)
        columns = 2
        rows = math.ceil(len(thumbnails) / columns)
        cell_width = 920
        cell_height = 790
        title_height = 72
        sheet = Image.new("RGB", (columns * cell_width + 20, rows * cell_height + title_height + 20), (15, 23, 42))
        draw = ImageDraw.Draw(sheet)
        draw.text(
            (20, 18),
            f"{title} · {sheet_index + 1}–{sheet_index + len(batch)}",
            font=load_font(28, bold=True),
            fill=(241, 245, 249),
        )
        for index, image in enumerate(thumbnails):
            column = index % columns
            row = index // columns
            x = 10 + column * cell_width + (cell_width - image.width) // 2
            y = title_height + row * cell_height + (cell_height - image.height) // 2
            sheet.paste(image, (x, y))
        output_path = output_dir / f"contact-sheet-{sheet_index // per_sheet + 1:02d}.jpg"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output_path, format="JPEG", quality=90, optimize=True)
        outputs.append(output_path)
    return outputs


def aggregate_summary(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    totals: Counter[str] = Counter()
    times: list[float] = []
    by_source: dict[str, Counter[str]] = defaultdict(Counter)
    for record in records:
        metrics = record["metrics"]
        for key in (
            "paddleFragmentCount",
            "finalBlockCount",
            "mergedFragmentCount",
            "textMergedBlockCount",
            "anchoredFragmentCount",
            "fallbackFragmentCount",
            "detectorOnlyAnchorCount",
            "koharuTextCount",
            "koharuBubbleCount",
            "koharuSfxCount",
            "crossGroupTextMergeCount",
            "verticalCrossGroupTextMergeCount",
        ):
            totals[key] += int(metrics[key])
            by_source[str(record["source"])][key] += int(metrics[key])
        times.append(float(record["timing"]["koharuDetectionSeconds"]))
        totals["pagesWithTextMerges"] += int(metrics["textMergedBlockCount"] > 0)
        totals["pagesWithVerticalCrossGroupMerges"] += int(
            metrics["verticalCrossGroupTextMergeCount"] > 0
        )
        by_source[str(record["source"])]["pages"] += 1
    page_count = len(records)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "pageCount": page_count,
        "model": {
            "repo": MODEL_REPO,
            "revision": MODEL_REVISION,
            "sha256": MODEL_SHA256,
            "classThresholds": {CLASS_NAMES[key]: value for key, value in CLASS_THRESHOLDS.items()},
            "nmsIouThreshold": NMS_IOU_THRESHOLD,
        },
        "grouping": {
            "textInBubbleMaskThreshold": TEXT_IN_BUBBLE_MASK_THRESHOLD,
            "paddleInTextBoxThreshold": PADDLE_IN_TEXT_BOX_THRESHOLD,
            "paddleInBubbleMaskThreshold": PADDLE_IN_BUBBLE_MASK_THRESHOLD,
            "groupAssignmentMinSupport": GROUP_ASSIGNMENT_MIN_SUPPORT,
            "groupAssignmentAmbiguityMargin": GROUP_ASSIGNMENT_AMBIGUITY_MARGIN,
        },
        "totals": dict(totals),
        "rates": {
            "pagesWithTextMerges": round(totals["pagesWithTextMerges"] / max(1, page_count), 6),
            "pagesWithVerticalCrossGroupMerges": round(
                totals["pagesWithVerticalCrossGroupMerges"] / max(1, page_count), 6
            ),
            "paddleAnchorCoverage": round(totals["anchoredFragmentCount"] / max(1, totals["paddleFragmentCount"]), 6),
            "fragmentToBlockReduction": round(1.0 - totals["finalBlockCount"] / max(1, totals["paddleFragmentCount"]), 6),
        },
        "timing": {
            "meanKoharuSeconds": round(sum(times) / max(1, len(times)), 6),
            "p50KoharuSeconds": round(float(np.percentile(times, 50)) if times else 0.0, 6),
            "p95KoharuSeconds": round(float(np.percentile(times, 95)) if times else 0.0, 6),
        },
        "bySource": {key: dict(value) for key, value in sorted(by_source.items())},
    }


def write_summary_markdown(
    output_dir: Path,
    summary: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    candidate_contact_sheets: Sequence[Path],
    representatives: Sequence[Mapping[str, Any]],
    representative_contact_sheets: Sequence[Path],
) -> None:
    totals = summary["totals"]
    rates = summary["rates"]
    lines = [
        "# Koharu layout → PaddleOCR block evaluation",
        "",
        "Hayai OCR is intentionally not used. PaddleOCR remains the text recognizer; Koharu layout masks are grouping anchors only.",
        "",
        "## Smoke summary",
        "",
        f"- Pages: {summary['pageCount']}",
        f"- Paddle fragments: {totals.get('paddleFragmentCount', 0)}",
        f"- Final rectangular blocks: {totals.get('finalBlockCount', 0)}",
        f"- Fragments merged away: {totals.get('mergedFragmentCount', 0)}",
        f"- Pages with a multi-fragment Koharu text-region merge: {totals.get('pagesWithTextMerges', 0)} ({rates['pagesWithTextMerges']:.1%})",
        f"- Pages with a vertical cross-Paddle-group text-region merge: {totals.get('pagesWithVerticalCrossGroupMerges', 0)} ({rates['pagesWithVerticalCrossGroupMerges']:.1%})",
        f"- Paddle fragments assigned to a Koharu anchor: {rates['paddleAnchorCoverage']:.1%}",
        f"- Mean Koharu detection time: {summary['timing']['meanKoharuSeconds']:.3f}s/page",
        "",
        "## Preselected candidate pool",
        "",
        f"- Eligible pages found: {summary['candidateSelection']['eligiblePageCount']}",
        f"- Diverse candidates retained before final rendering: {len(candidates)}",
        f"- Final A/B/C comparisons selected from that pool: {len(representatives)}",
        f"- Eligibility: at least one bubble-owned Koharu text region containing two distinct Paddle groups and two vertical fragments; at least {CANDIDATE_MIN_PADDLE_FRAGMENTS} Paddle fragments/page; anchor coverage at least {CANDIDATE_MIN_ANCHOR_COVERAGE:.0%}.",
        "- The cross-group condition targets the reported auto-block split directly; ordinary within-group line merging is not enough to qualify.",
        "- Full candidate inventory: `candidate-pool.json`",
        "",
        "### Candidate contact sheets",
        "",
    ]
    for path in candidate_contact_sheets:
        lines.append(f"- `{path.relative_to(output_dir).as_posix()}`")
    lines.extend([
        "",
        "## Interpretation",
        "",
        "- Green C boxes are ordinary axis-aligned rectangles around Paddle fragments assigned to one Koharu text region.",
        "- Multiple vertical Paddle lines inside the same Koharu text region become one C block.",
        "- Existing confirmed Paddle groups are assigned atomically, so overlapping Koharu text instances cannot split one G-group across two C blocks.",
        "- Bubble masks are membership gates only. A bubble-owned text seed cannot absorb fragments outside that bubble; distinct text instances are never merged and a whole bubble mask is never emitted as one block.",
        "- Only bubble-owned text seeds may merge distinct Paddle groups. Bubbleless text/SFX seeds preserve the existing Paddle group boundary even when one Koharu instance spans a large area.",
        "- Ambiguous assignments and ungrouped/deferred fragments without direct mask evidence stay as Paddle fallbacks.",
        "- Orange C boxes are conservative Paddle fallbacks where Koharu supplied no reliable anchor.",
        "- This is a smoke/visual evaluation without human ground-truth boxes; reduction is not an accuracy claim.",
        "",
        "## Pinned inputs",
        "",
        f"- Koharu layout: `{MODEL_REPO}@{MODEL_REVISION}`",
        f"- Weight SHA-256: `{MODEL_SHA256}`",
        "- Detector classes: text, onomatopoeia, bubble, panel",
        "- Paddle: the installed app's PP-OCRv6 medium Transformers/CUDA runtime",
        "",
        "## Representative pages",
        "",
    ])
    for record in representatives:
        metrics = record["metrics"]
        lines.append(
            f"- `{record['id']}` {record['relativePath']} — Paddle {metrics['paddleFragmentCount']} → blocks {metrics['finalBlockCount']}, cross-group text regions {metrics['crossGroupTextMergeCount']} (vertical {metrics['verticalCrossGroupTextMergeCount']})"
        )
    lines.extend(["", "## Final A/B/C contact sheets", ""])
    for path in representative_contact_sheets:
        lines.append(f"- `{path.relative_to(output_dir).as_posix()}`")
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def analyze_pages(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir).expanduser().resolve()
    manifest = read_json(output_dir / "manifest.json")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise EvaluationError("manifest schema mismatch")
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        raise EvaluationError("manifest has no items")

    print(f"[koharu] loading {MODEL_REPO}@{MODEL_REVISION}", flush=True)
    model, _ = load_layout_model()
    result_dir = output_dir / "results"
    records: list[dict[str, Any]] = []
    for index, item in enumerate(items, 1):
        result_path = result_dir / f"{item['id']}.json"
        if result_path.is_file() and not args.force:
            record = read_json(result_path)
            attach_candidate_evidence(record)
            write_json(result_path, record)
            records.append(record)
            print(f"[koharu] {index}/{len(items)} {item['id']} cached", flush=True)
            continue
        paddle_path = output_dir / "paddle" / f"{item['id']}.json"
        paddle_payload = read_json(paddle_path)
        record, elapsed = analyze_page(model, item, paddle_payload)
        write_json(result_path, record)
        records.append(record)
        metrics = record["metrics"]
        print(
            f"[koharu] {index}/{len(items)} {item['id']} {elapsed:.3f}s "
            f"Paddle={metrics['paddleFragmentCount']} blocks={metrics['finalBlockCount']} "
            f"merged={metrics['mergedFragmentCount']}",
            flush=True,
        )

    candidates = choose_candidate_pool(records, args.candidates)
    representatives = choose_representatives(candidates, args.representatives)
    eligible_count = sum(record["candidateEvidence"]["eligible"] for record in records)
    summary = aggregate_summary(records)
    summary["candidateSelection"] = {
        "eligiblePageCount": eligible_count,
        "candidatePoolCount": len(candidates),
        "representativeCount": len(representatives),
        "criteria": {
            "minimumVerticalCrossGroupTextMerges": 1,
            "minimumPaddleFragments": CANDIDATE_MIN_PADDLE_FRAGMENTS,
            "minimumAnchorCoverage": CANDIDATE_MIN_ANCHOR_COVERAGE,
            "verticalFragmentAspectRatio": VERTICAL_FRAGMENT_ASPECT_RATIO,
        },
    }

    candidate_composites_dir = output_dir / "candidate-composites"
    candidate_composite_paths: list[Path] = []
    for index, record in enumerate(candidates, 1):
        output_path = candidate_composites_dir / f"{index:02d}-{record['id']}.png"
        render_composite(record, output_path)
        candidate_composite_paths.append(output_path)
        print(f"[candidate] {index}/{len(candidates)} {output_path.name}", flush=True)
    candidate_contact_sheets = build_contact_sheets(
        candidate_composite_paths,
        output_dir / "candidate-contact-sheets",
        "사전 선별 후보",
    )

    representative_composites_dir = output_dir / "selected-composites"
    representative_composite_paths: list[Path] = []
    for index, record in enumerate(representatives, 1):
        output_path = representative_composites_dir / f"{index:02d}-{record['id']}.png"
        render_composite(record, output_path)
        representative_composite_paths.append(output_path)
        print(f"[render] {index}/{len(representatives)} {output_path.name}", flush=True)
    representative_contact_sheets = build_contact_sheets(
        representative_composite_paths,
        output_dir / "selected-contact-sheets",
        "최종 A/B/C 비교",
    )
    write_json(output_dir / "summary.json", summary)
    write_json(
        output_dir / "candidate-pool.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "selection": summary["candidateSelection"],
            "items": [
                {
                    "id": record["id"],
                    "relativePath": record["relativePath"],
                    "source": record["source"],
                    "series": record["series"],
                    "metrics": record["metrics"],
                    "candidateEvidence": record["candidateEvidence"],
                    "composite": str(path.relative_to(output_dir)).replace("\\", "/"),
                }
                for record, path in zip(candidates, candidate_composite_paths)
            ],
        },
    )
    write_json(
        output_dir / "representatives.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "items": [
                {
                    "id": record["id"],
                    "relativePath": record["relativePath"],
                    "metrics": record["metrics"],
                    "candidateEvidence": record["candidateEvidence"],
                    "composite": str(path.relative_to(output_dir)).replace("\\", "/"),
                }
                for record, path in zip(representatives, representative_composite_paths)
            ],
        },
    )
    write_summary_markdown(
        output_dir,
        summary,
        candidates,
        candidate_contact_sheets,
        representatives,
        representative_contact_sheets,
    )
    print(f"[done] summary -> {output_dir / 'README.md'}", flush=True)


def run_self_test() -> None:
    height, width = 120, 100
    bubble = np.zeros((height, width), dtype=bool)
    bubble[10:100, 10:90] = True
    merged_text = np.zeros_like(bubble)
    merged_text[20:85, 30:70] = True
    detections = [
        {"id": "K001", "class": "bubble", "score": 0.95, "bbox": [10, 10, 90, 100], "mask": bubble, "maskArea": int(bubble.sum())},
        {"id": "K002", "class": "text", "score": 0.90, "bbox": [30, 20, 70, 85], "mask": merged_text, "maskArea": int(merged_text.sum())},
    ]
    paddle = [
        {"id": "P1", "bbox": [54, 18, 66, 82], "text": "右", "status": "confirmed", "reviewFragmentId": "P1", "groupId": "", "score": 1.0, "reasons": []},
        {"id": "P2", "bbox": [34, 18, 46, 82], "text": "左", "status": "confirmed", "reviewFragmentId": "P2", "groupId": "", "score": 1.0, "reasons": []},
        {"id": "P3", "bbox": [0, 105, 20, 118], "text": "밖", "status": "confirmed", "reviewFragmentId": "P3", "groupId": "", "score": 1.0, "reasons": []},
    ]
    anchors = build_anchors(detections)
    unassigned = assign_paddle_items(anchors, paddle)
    blocks = build_final_blocks(anchors, paddle, unassigned, width, height)
    text_blocks = [block for block in blocks if block["kind"] == "text"]
    fallback_blocks = [block for block in blocks if block["kind"] == "paddle_fallback"]
    if len(text_blocks) != 1 or text_blocks[0]["fragmentCount"] != 2:
        raise EvaluationError("self-test failed: two vertical fragments were not merged in one text instance")
    if len(fallback_blocks) != 1 or fallback_blocks[0]["fragmentCount"] != 1:
        raise EvaluationError("self-test failed: outside fragment was not preserved as fallback")
    evidence = candidate_evidence(
        {
            "paddleItems": paddle,
            "finalBlocks": blocks,
            "metrics": {
                "paddleFragmentCount": len(paddle),
                "anchorCoverage": 2 / 3,
                "textMergedBlockCount": 1,
            },
        }
    )
    if evidence["verticalCrossGroupTextMergeCount"] != 1:
        raise EvaluationError("self-test failed: vertical cross-group candidate was not detected")

    separate_left = np.zeros_like(bubble)
    separate_left[25:85, 20:40] = True
    separate_right = np.zeros_like(bubble)
    separate_right[25:85, 60:80] = True
    separate_anchors = build_anchors(
        [
            {"id": "K101", "class": "bubble", "score": 0.95, "bbox": [10, 10, 90, 100], "mask": bubble, "maskArea": int(bubble.sum())},
            {"id": "K102", "class": "text", "score": 0.90, "bbox": [20, 25, 40, 85], "mask": separate_left, "maskArea": int(separate_left.sum())},
            {"id": "K103", "class": "text", "score": 0.90, "bbox": [60, 25, 80, 85], "mask": separate_right, "maskArea": int(separate_right.sum())},
        ]
    )
    separate_text_anchors = [anchor for anchor in separate_anchors if anchor["kind"] == "text"]
    if len(separate_text_anchors) != 2 or any(
        len(anchor["textDetectionIds"]) != 1 for anchor in separate_text_anchors
    ):
        raise EvaluationError("self-test failed: distinct text instances inside one bubble were over-merged")

    spill_text = np.zeros_like(bubble)
    spill_text[20:90, 30:70] = True
    spill_text[104:116, 40:60] = True
    spill_anchors = build_anchors(
        [
            {"id": "K201", "class": "bubble", "score": 0.95, "bbox": [10, 10, 90, 100], "mask": bubble, "maskArea": int(bubble.sum())},
            {"id": "K202", "class": "text", "score": 0.90, "bbox": [30, 20, 70, 116], "mask": spill_text, "maskArea": int(spill_text.sum())},
        ]
    )
    spill_paddle = [
        {"id": "D1", "bbox": [40, 104, 60, 116], "text": "outside", "status": "deferred", "reviewFragmentId": "D1", "groupId": "", "score": 1.0, "reasons": []},
    ]
    spill_unassigned = assign_paddle_items(spill_anchors, spill_paddle)
    if spill_unassigned != [0]:
        raise EvaluationError(
            "self-test failed: a text mask absorbed a fragment outside its owning bubble"
        )

    atomic_left = np.zeros_like(bubble)
    atomic_left[20:100, 15:55] = True
    atomic_right = np.zeros_like(bubble)
    atomic_right[20:100, 40:90] = True
    atomic_anchors = build_anchors(
        [
            {"id": "K301", "class": "bubble", "score": 0.95, "bbox": [10, 10, 90, 100], "mask": bubble, "maskArea": int(bubble.sum())},
            {"id": "K302", "class": "text", "score": 0.90, "bbox": [15, 20, 55, 100], "mask": atomic_left, "maskArea": int(atomic_left.sum())},
            {"id": "K303", "class": "text", "score": 0.90, "bbox": [40, 20, 90, 100], "mask": atomic_right, "maskArea": int(atomic_right.sum())},
        ]
    )
    atomic_paddle = [
        {"id": "B900", "bbox": [25, 25, 45, 95], "text": "one", "status": "confirmed", "reviewFragmentId": "B900", "groupId": "G900", "score": 1.0, "reasons": []},
        {"id": "B900", "bbox": [50, 25, 65, 95], "text": "two", "status": "confirmed", "reviewFragmentId": "B900", "groupId": "G900", "score": 1.0, "reasons": []},
        {"id": "B900", "bbox": [68, 25, 82, 95], "text": "three", "status": "confirmed", "reviewFragmentId": "B900", "groupId": "G900", "score": 1.0, "reasons": []},
    ]
    atomic_unassigned = assign_paddle_items(atomic_anchors, atomic_paddle)
    atomic_text_anchors = [anchor for anchor in atomic_anchors if anchor["kind"] == "text"]
    if atomic_unassigned or [len(anchor["paddleIndexes"]) for anchor in atomic_text_anchors] != [0, 3]:
        raise EvaluationError(
            "self-test failed: one confirmed Paddle group was split between text instances"
        )

    bubbleless_mask = np.zeros_like(bubble)
    bubbleless_mask[20:100, 10:90] = True
    bubbleless_anchors = build_anchors(
        [
            {"id": "K401", "class": "text", "score": 0.90, "bbox": [10, 20, 90, 100], "mask": bubbleless_mask, "maskArea": int(bubbleless_mask.sum())},
        ]
    )
    bubbleless_paddle = [
        {"id": "B401", "bbox": [15, 25, 30, 95], "text": "left", "status": "confirmed", "reviewFragmentId": "B401", "groupId": "G401", "score": 1.0, "reasons": []},
        {"id": "B402", "bbox": [70, 25, 85, 95], "text": "right", "status": "confirmed", "reviewFragmentId": "B402", "groupId": "G402", "score": 1.0, "reasons": []},
    ]
    bubbleless_unassigned = assign_paddle_items(
        bubbleless_anchors, bubbleless_paddle
    )
    bubbleless_blocks = build_final_blocks(
        bubbleless_anchors,
        bubbleless_paddle,
        bubbleless_unassigned,
        width,
        height,
    )
    if len(bubbleless_blocks) != 2:
        raise EvaluationError(
            "self-test failed: a bubbleless Koharu instance merged distinct Paddle groups"
        )

    disconnected = np.zeros((20, 40), dtype=bool)
    disconnected[2:18, 2:15] = True
    disconnected[2:18, 25:38] = True
    if len(split_disconnected_bubble(disconnected)) != 2:
        raise EvaluationError("self-test failed: disconnected bubble mask was not split")
    print("[self-test] Koharu mask → Paddle rectangle grouping passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    select = subparsers.add_parser("select", help="select deterministic source pages")
    select.add_argument("--manga-root", required=True)
    select.add_argument("--output-dir", required=True)
    select.add_argument("--count", type=int, default=60)
    select.add_argument("--seed", default=DEFAULT_SEED)

    analyze = subparsers.add_parser("analyze", help="run Koharu grouping and render comparisons")
    analyze.add_argument("--output-dir", required=True)
    analyze.add_argument("--candidates", type=int, default=DEFAULT_CANDIDATE_COUNT)
    analyze.add_argument("--representatives", type=int, default=20)
    analyze.add_argument("--force", action="store_true")

    subparsers.add_parser("self-test", help="run synthetic grouping tests")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "select":
        select_pages(args)
    elif args.command == "analyze":
        analyze_pages(args)
    elif args.command == "self-test":
        run_self_test()
    else:
        raise EvaluationError(f"unsupported command: {args.command}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EvaluationError as error:
        print(f"[koharu-region-eval] {error}", file=sys.stderr)
        raise SystemExit(2) from error
