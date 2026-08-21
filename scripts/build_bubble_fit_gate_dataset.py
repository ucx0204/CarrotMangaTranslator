#!/usr/bin/env python3
"""Build and validate an evidence-only dataset for a future bubble-fit gate.

This tool is deliberately outside the production translation path.  It does
not invent opaque/translucent labels and it does not train a classifier.  It
reruns the pinned INT8 comic RT-DETR on completed full-pipeline QA originals,
then emits one independently inspectable crop bundle per detected bubble.

The validator reruns inference and recreates every image in memory.  This is
intentional: a valid pack is bound to the run report, detector, detection
geometry, crop pixels, and manifest rather than merely being a collection of
decodable PNG files.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError


SCHEMA_VERSION = 1
TOOL_ID = "manga-translator-bubble-fit-gate-dataset"
MANIFEST_NAME = "manifest.json"
SEAL_NAME = "dataset-seal.json"
MODEL_INPUT_SIZE = 640
TRAINING_SIZE = 224
DEFAULT_CONTEXT_RATIO = 0.20
DEFAULT_SCORE_THRESHOLD = 0.35
TEXT_BUBBLE_CONTAINMENT_THRESHOLD = 0.50
CORE_MASK_INSET_RATIO = 0.08
MODEL_LABELS = ("bubble", "text_bubble", "text_free")
EXPECTED_MODEL_SHA256 = (
    "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79"
)
MODEL_REPO = "ogkalu/comic-text-and-bubble-detector"
MODEL_REVISION = "16e8a622f91fabc6b5b65c96d32d1183f8843546"
MODEL_FILE = "detector-v4-s_int8.onnx"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

BBox = tuple[int, int, int, int]


class BubbleFitDatasetError(RuntimeError):
    """Raised when a dataset cannot be built or independently reproduced."""


@dataclass(frozen=True)
class Detection:
    label: str
    score: float
    bbox: BBox


@dataclass(frozen=True)
class AssociatedTextDetection:
    detection: Detection
    containment: float


@dataclass(frozen=True)
class BubbleGroup:
    bubble: Detection
    text_detections: tuple[AssociatedTextDetection, ...]


@dataclass(frozen=True)
class DetectionAssociations:
    bubbles: tuple[BubbleGroup, ...]
    text_bubble_count: int
    unassociated_text_bubble_count: int


@dataclass(frozen=True)
class PageRecord:
    selection_index: int
    source_page_id: str
    source_page_name: str
    source_page_sha256: str
    work_id: str
    work_title: str
    chapter_id: str
    chapter_title: str
    mode: str
    original_path: Path
    cleaned_path: Path


@dataclass(frozen=True)
class BuildOptions:
    report_path: Path
    output_dir: Path
    model_path: Path
    expected_model_sha256: str = EXPECTED_MODEL_SHA256
    score_threshold: float = DEFAULT_SCORE_THRESHOLD
    context_ratio: float = DEFAULT_CONTEXT_RATIO
    quiet: bool = False
    selection_start: int | None = None
    selection_count: int | None = None


class PageDetector(Protocol):
    inference_count: int

    def detect(self, image: Image.Image) -> list[Detection]:
        """Return detections in native source-image pixel coordinates."""


class ComicLayoutDetector:
    """CPU-only wrapper matching the app's pinned RT-DETR tensor contract."""

    def __init__(self, model_path: Path, score_threshold: float) -> None:
        self.model_path = model_path.resolve()
        self.score_threshold = score_threshold
        self.inference_count = 0
        self._model_bytes = self.model_path.read_bytes()
        self._session: Any | None = None

    def _get_session(self) -> Any:
        if self._session is not None:
            return self._session
        try:
            import onnxruntime as ort
        except ImportError as exc:  # pragma: no cover - local runtime dependent
            raise BubbleFitDatasetError(f"onnxruntime is unavailable: {exc}") from exc
        if "CPUExecutionProvider" not in ort.get_available_providers():
            raise BubbleFitDatasetError(
                "onnxruntime CPUExecutionProvider is unavailable"
            )
        try:
            session = ort.InferenceSession(
                self._model_bytes,
                providers=["CPUExecutionProvider"],
            )
        except Exception as exc:  # pragma: no cover - native runtime dependent
            raise BubbleFitDatasetError(
                f"could not open detector with CPUExecutionProvider: {exc}"
            ) from exc
        inputs = {item.name for item in session.get_inputs()}
        outputs = {item.name for item in session.get_outputs()}
        if inputs != {"images", "orig_target_sizes"}:
            raise BubbleFitDatasetError(f"unexpected RT-DETR inputs: {sorted(inputs)}")
        if not {"labels", "boxes", "scores"}.issubset(outputs):
            raise BubbleFitDatasetError(
                f"unexpected RT-DETR outputs: {sorted(outputs)}"
            )
        self._session = session
        return session

    def detect(self, image: Image.Image) -> list[Detection]:
        rgb = _rgb_image(image)
        try:
            width, height = rgb.size
            resized = rgb.resize(
                (MODEL_INPUT_SIZE, MODEL_INPUT_SIZE),
                Image.Resampling.LANCZOS,
            )
            try:
                pixels = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
            finally:
                resized.close()
            images = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None, ...])
            targets = np.asarray([[width, height]], dtype=np.int64)
        finally:
            rgb.close()
        labels, boxes, scores = self._get_session().run(
            ["labels", "boxes", "scores"],
            {"images": images, "orig_target_sizes": targets},
        )
        self.inference_count += 1
        flat_labels = np.asarray(labels).reshape(-1)
        flat_boxes = np.asarray(boxes).reshape(-1, 4)
        flat_scores = np.asarray(scores).reshape(-1)
        count = min(len(flat_labels), len(flat_boxes), len(flat_scores))
        detections: list[Detection] = []
        for index in range(count):
            label_id = int(flat_labels[index])
            score = float(flat_scores[index])
            if (
                not 0 <= label_id < len(MODEL_LABELS)
                or not math.isfinite(score)
                or score < self.score_threshold
                or score > 1.0
            ):
                continue
            bbox = _clamped_bbox(flat_boxes[index], width, height)
            if bbox is not None:
                detections.append(Detection(MODEL_LABELS[label_id], score, bbox))
        return sorted(
            detections,
            key=lambda item: (
                -item.score,
                MODEL_LABELS.index(item.label),
            ),
        )


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise BubbleFitDatasetError(f"could not hash file {path}: {exc}") from exc
    return digest.hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(_canonical_json_bytes(value))


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BubbleFitDatasetError(f"invalid {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise BubbleFitDatasetError(f"{label} must contain a JSON object: {path}")
    return value


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BubbleFitDatasetError(f"missing or empty {field}")
    return value.strip()


def _require_int(value: Any, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise BubbleFitDatasetError(f"{field} must be an integer >= {minimum}")
    return value


def _require_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise BubbleFitDatasetError(f"{field} must be a lowercase SHA-256 digest")
    return value


def _resolve_file(base: Path, raw: Any, field: str) -> Path:
    text = _require_string(raw, field)
    path = Path(text)
    if not path.is_absolute():
        path = base / path
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise BubbleFitDatasetError(f"missing {field}: {path}: {exc}") from exc
    if not resolved.is_file():
        raise BubbleFitDatasetError(f"{field} is not a regular file: {resolved}")
    return resolved


def _load_report(report_path: Path) -> tuple[dict[str, Any], list[PageRecord]]:
    report_path = report_path.resolve()
    report = _read_json(report_path, "run report")
    if report.get("schemaVersion") != 1:
        raise BubbleFitDatasetError("run report schemaVersion must be 1")
    if report.get("status") != "completed":
        raise BubbleFitDatasetError("run report status must be completed")
    for field in ("runId", "cohort", "candidateId"):
        _require_string(report.get(field), f"run report {field}")
    page_count = _require_int(report.get("pageCount"), "run report pageCount", 1)
    raw_pages = report.get("pages")
    if not isinstance(raw_pages, list) or len(raw_pages) != page_count:
        raise BubbleFitDatasetError(
            "run report pages must be a list matching pageCount"
        )
    indexed: list[tuple[int, Mapping[str, Any]]] = []
    for position, raw in enumerate(raw_pages, start=1):
        if not isinstance(raw, dict):
            raise BubbleFitDatasetError(f"run report page {position} is not an object")
        index = _require_int(
            raw.get("selectionIndex"),
            f"run report page {position} selectionIndex",
        )
        indexed.append((index, raw))
    indexed.sort(key=lambda item: item[0])
    actual_indexes = [item[0] for item in indexed]
    if actual_indexes != list(range(page_count)):
        raise BubbleFitDatasetError(
            "run report selectionIndex coverage must be contiguous from zero"
        )

    pages: list[PageRecord] = []
    seen_page_ids: set[str] = set()
    for index, raw in indexed:
        number = index + 1
        if raw.get("status") != "completed" or raw.get("stage") != "done":
            raise BubbleFitDatasetError(
                f"run report page {number} is not completed at stage=done"
            )
        page_id = _require_string(
            raw.get("sourcePageId"), f"page {number} sourcePageId"
        )
        if page_id in seen_page_ids:
            raise BubbleFitDatasetError(f"duplicate sourcePageId: {page_id}")
        seen_page_ids.add(page_id)
        source_sha = _require_sha256(
            raw.get("sourcePageSha256"), f"page {number} sourcePageSha256"
        )
        original = _resolve_file(
            report_path.parent,
            raw.get("stagedOriginalImagePath"),
            f"page {number} stagedOriginalImagePath",
        )
        cleaned_raw = raw.get("cleanedImagePath")
        block_count = raw.get("blockCount")
        if (
            not isinstance(cleaned_raw, str) or not cleaned_raw.strip()
        ) and block_count == 0:
            cleaned = original
        else:
            cleaned = _resolve_file(
                report_path.parent,
                cleaned_raw,
                f"page {number} cleanedImagePath",
            )
        mode_value = raw.get("mode")
        mode = mode_value.strip() if isinstance(mode_value, str) else ""
        pages.append(
            PageRecord(
                selection_index=index,
                source_page_id=page_id,
                source_page_name=_require_string(
                    raw.get("sourcePageName"), f"page {number} sourcePageName"
                ),
                source_page_sha256=source_sha,
                work_id=_require_string(raw.get("workId"), f"page {number} workId"),
                work_title=_require_string(
                    raw.get("workTitle"), f"page {number} workTitle"
                ),
                chapter_id=_require_string(
                    raw.get("chapterId"), f"page {number} chapterId"
                ),
                chapter_title=_require_string(
                    raw.get("chapterTitle"), f"page {number} chapterTitle"
                ),
                mode=mode,
                original_path=original,
                cleaned_path=cleaned,
            )
        )
    return report, pages


def _selection_indices_sha256(pages: Sequence[PageRecord]) -> str:
    return _sha256_json([page.selection_index for page in pages])


def _select_report_pages(
    pages: Sequence[PageRecord],
    selection_start: int | None,
    selection_count: int | None,
) -> tuple[list[PageRecord], dict[str, Any] | None]:
    if selection_start is None and selection_count is None:
        return list(pages), None
    if selection_start is None or selection_count is None:
        raise BubbleFitDatasetError(
            "selection-start and selection-count must be provided together"
        )
    start = _require_int(selection_start, "selection-start")
    count = _require_int(selection_count, "selection-count", 1)
    end_exclusive = start + count
    if end_exclusive > len(pages):
        raise BubbleFitDatasetError(
            "source selection is out of range for the completed run report: "
            f"start={start}, count={count}, pageCount={len(pages)}"
        )
    selected = list(pages[start:end_exclusive])
    expected_indices = list(range(start, end_exclusive))
    actual_indices = [page.selection_index for page in selected]
    if actual_indices != expected_indices:
        raise BubbleFitDatasetError(
            "source selection must resolve to exact contiguous selectionIndex coverage"
        )
    return selected, {
        "start": start,
        "count": count,
        "endExclusive": end_exclusive,
        "indicesSha256": _selection_indices_sha256(selected),
    }


def _apply_manifest_source_selection(
    pages: Sequence[PageRecord], raw_selection: Any
) -> list[PageRecord]:
    if not isinstance(raw_selection, dict):
        raise BubbleFitDatasetError("manifest sourceSelection must be an object")
    expected_fields = {"start", "count", "endExclusive", "indicesSha256"}
    if set(raw_selection) != expected_fields:
        raise BubbleFitDatasetError(
            "manifest sourceSelection must contain exactly start, count, "
            "endExclusive, and indicesSha256"
        )
    start = _require_int(raw_selection.get("start"), "sourceSelection.start")
    count = _require_int(raw_selection.get("count"), "sourceSelection.count", 1)
    end_exclusive = _require_int(
        raw_selection.get("endExclusive"), "sourceSelection.endExclusive", 1
    )
    if end_exclusive != start + count:
        raise BubbleFitDatasetError(
            "sourceSelection.endExclusive must equal start + count"
        )
    if end_exclusive > len(pages):
        raise BubbleFitDatasetError(
            "manifest sourceSelection is out of range for the completed run report"
        )
    selected = list(pages[start:end_exclusive])
    expected_indices = list(range(start, end_exclusive))
    actual_indices = [page.selection_index for page in selected]
    if actual_indices != expected_indices:
        raise BubbleFitDatasetError(
            "manifest sourceSelection does not resolve to contiguous selectionIndex coverage"
        )
    indices_sha256 = _require_sha256(
        raw_selection.get("indicesSha256"), "sourceSelection.indicesSha256"
    )
    if indices_sha256 != _selection_indices_sha256(selected):
        raise BubbleFitDatasetError(
            "sourceSelection.indicesSha256 does not bind the selected report indices"
        )
    return selected


def _rgb_image(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image.copy()
    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        try:
            return Image.alpha_composite(background, rgba).convert("RGB")
        finally:
            rgba.close()
            background.close()
    return image.convert("RGB")


def _open_rgb(path: Path, field: str) -> Image.Image:
    try:
        with Image.open(path) as opened:
            opened.load()
            transposed = ImageOps.exif_transpose(opened)
            try:
                image = _rgb_image(transposed)
            finally:
                if transposed is not opened:
                    transposed.close()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise BubbleFitDatasetError(f"could not decode {field} {path}: {exc}") from exc
    if image.width <= 0 or image.height <= 0:
        image.close()
        raise BubbleFitDatasetError(f"{field} has invalid dimensions: {path}")
    return image


def _clamped_bbox(values: Sequence[Any], width: int, height: int) -> BBox | None:
    if len(values) != 4:
        return None
    try:
        numbers = tuple(float(value) for value in values)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in numbers):
        return None
    x1, y1, x2, y2 = numbers
    left = max(0, math.floor(min(x1, x2)))
    top = max(0, math.floor(min(y1, y2)))
    right = min(width, math.ceil(max(x1, x2)))
    bottom = min(height, math.ceil(max(y1, y2)))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _box_area(bbox: BBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _intersection_area(left: BBox, right: BBox) -> int:
    return max(0, min(left[2], right[2]) - max(left[0], right[0])) * max(
        0, min(left[3], right[3]) - max(left[1], right[1])
    )


def _text_containment(text: BBox, bubble: BBox) -> float:
    area = _box_area(text)
    return _intersection_area(text, bubble) / area if area else 0.0


def _associate_detections(
    detections: Sequence[Detection], width: int, height: int
) -> DetectionAssociations:
    bubbles: list[Detection] = []
    text_bubbles: list[Detection] = []
    for detection in detections:
        if detection.label not in {"bubble", "text_bubble"}:
            continue
        if not math.isfinite(detection.score) or not 0 <= detection.score <= 1:
            raise BubbleFitDatasetError(
                "detector returned a non-finite/out-of-range score"
            )
        bbox = _clamped_bbox(detection.bbox, width, height)
        if bbox is not None and detection.label == "bubble":
            bubbles.append(Detection("bubble", detection.score, bbox))
        elif bbox is not None:
            text_bubbles.append(Detection("text_bubble", detection.score, bbox))
    bubbles = sorted(
        bubbles,
        key=lambda item: (
            -item.score,
            item.bbox[1],
            item.bbox[0],
            item.bbox[3],
            item.bbox[2],
        ),
    )
    associated: list[list[AssociatedTextDetection]] = [[] for _ in bubbles]
    unassociated = 0
    for text in sorted(
        text_bubbles,
        key=lambda item: (
            -item.score,
            item.bbox[1],
            item.bbox[0],
            item.bbox[3],
            item.bbox[2],
        ),
    ):
        best_index: int | None = None
        best_containment = -1.0
        for index, bubble in enumerate(bubbles):
            containment = _text_containment(text.bbox, bubble.bbox)
            if (
                best_index is None
                or containment > best_containment
                or (
                    containment == best_containment
                    and bubble.score > bubbles[best_index].score
                )
            ):
                best_index = index
                best_containment = containment
        if (
            best_index is not None
            and best_containment >= TEXT_BUBBLE_CONTAINMENT_THRESHOLD
        ):
            associated[best_index].append(
                AssociatedTextDetection(text, best_containment)
            )
        else:
            unassociated += 1
    return DetectionAssociations(
        bubbles=tuple(
            BubbleGroup(bubble, tuple(associated[index]))
            for index, bubble in enumerate(bubbles)
        ),
        text_bubble_count=len(text_bubbles),
        unassociated_text_bubble_count=unassociated,
    )


def _crop_geometry(
    bbox: BBox, width: int, height: int, context_ratio: float
) -> tuple[BBox, BBox, int, dict[str, int], list[str]]:
    bubble_width = bbox[2] - bbox[0]
    bubble_height = bbox[3] - bbox[1]
    padding = max(1, math.ceil(max(bubble_width, bubble_height) * context_ratio))
    requested = (
        bbox[0] - padding,
        bbox[1] - padding,
        bbox[2] + padding,
        bbox[3] + padding,
    )
    crop = (
        max(0, requested[0]),
        max(0, requested[1]),
        min(width, requested[2]),
        min(height, requested[3]),
    )
    if crop[2] <= crop[0] or crop[3] <= crop[1]:
        raise BubbleFitDatasetError(f"computed empty crop for detection {bbox}")
    retained = {
        "left": bbox[0] - crop[0],
        "top": bbox[1] - crop[1],
        "right": crop[2] - bbox[2],
        "bottom": crop[3] - bbox[3],
    }
    clamped = [side for side, pixels in retained.items() if pixels < padding]
    return requested, crop, padding, retained, clamped


def _letterbox_224(image: Image.Image) -> Image.Image:
    width, height = image.size
    if width <= 0 or height <= 0:
        raise BubbleFitDatasetError("cannot letterbox an empty crop")
    scale = min(TRAINING_SIZE / width, TRAINING_SIZE / height)
    resized_size = (
        max(1, min(TRAINING_SIZE, round(width * scale))),
        max(1, min(TRAINING_SIZE, round(height * scale))),
    )
    resized = image.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (TRAINING_SIZE, TRAINING_SIZE), (255, 255, 255))
    try:
        canvas.paste(
            resized,
            (
                (TRAINING_SIZE - resized.width) // 2,
                (TRAINING_SIZE - resized.height) // 2,
            ),
        )
    finally:
        resized.close()
    return canvas


def _draw_page_box(
    draw: ImageDraw.ImageDraw,
    bbox: BBox,
    color: tuple[int, int, int],
    width: int,
) -> None:
    draw.rectangle(
        (bbox[0], bbox[1], bbox[2] - 1, bbox[3] - 1),
        outline=color,
        width=width,
    )


def _overlay_image(
    original: Image.Image,
    bbox: BBox,
    crop: BBox,
    prompts: Sequence[BBox],
) -> Image.Image:
    overlay = original.crop(crop)
    draw = ImageDraw.Draw(overlay)
    line_width = max(2, round(min(overlay.size) / 160))
    crop_local = (0, 0, overlay.width, overlay.height)
    bubble_local = (
        bbox[0] - crop[0],
        bbox[1] - crop[1],
        bbox[2] - crop[0],
        bbox[3] - crop[1],
    )
    _draw_page_box(draw, crop_local, (255, 153, 0), line_width)
    _draw_page_box(draw, bubble_local, (0, 191, 255), line_width)
    for prompt in prompts:
        intersection = (
            max(prompt[0], crop[0]),
            max(prompt[1], crop[1]),
            min(prompt[2], crop[2]),
            min(prompt[3], crop[3]),
        )
        if intersection[2] <= intersection[0] or intersection[3] <= intersection[1]:
            continue
        prompt_local = (
            intersection[0] - crop[0],
            intersection[1] - crop[1],
            intersection[2] - crop[0],
            intersection[3] - crop[1],
        )
        _draw_page_box(draw, prompt_local, (255, 0, 191), line_width)
    return overlay


def _core_mask_geometry(bbox: BBox) -> tuple[BBox, int]:
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    maximum_inset = max(0, (min(width, height) - 1) // 2)
    inset = min(
        maximum_inset,
        max(1, math.ceil(min(width, height) * CORE_MASK_INSET_RATIO)),
    )
    core = (
        bbox[0] + inset,
        bbox[1] + inset,
        bbox[2] - inset,
        bbox[3] - inset,
    )
    if core[2] <= core[0] or core[3] <= core[1]:
        return bbox, 0
    return core, inset


def _core_mask_image(crop: BBox, core: BBox) -> Image.Image:
    mask = Image.new("L", (crop[2] - crop[0], crop[3] - crop[1]), 0)
    draw = ImageDraw.Draw(mask)
    local = (
        core[0] - crop[0],
        core[1] - crop[1],
        core[2] - crop[0] - 1,
        core[3] - crop[1] - 1,
    )
    draw.rectangle(local, fill=255)
    return mask


def _cleaned_core_overlay(
    cleaned_crop: Image.Image,
    mask: Image.Image,
    crop: BBox,
    core: BBox,
    prompts: Sequence[BBox],
) -> Image.Image:
    pixels = np.asarray(cleaned_crop, dtype=np.uint8).copy()
    active = np.asarray(mask, dtype=np.uint8) > 0
    tint = np.asarray([0, 220, 96], dtype=np.float32)
    blended = pixels[active].astype(np.float32) * np.float32(0.62) + tint * np.float32(
        0.38
    )
    pixels[active] = np.clip(np.rint(blended), 0, 255).astype(np.uint8)
    overlay = Image.fromarray(pixels)
    draw = ImageDraw.Draw(overlay)
    line_width = max(2, round(min(overlay.size) / 160))
    local_core = (
        core[0] - crop[0],
        core[1] - crop[1],
        core[2] - crop[0],
        core[3] - crop[1],
    )
    _draw_page_box(draw, local_core, (0, 160, 64), line_width)
    for prompt in prompts:
        intersection = (
            max(prompt[0], crop[0]),
            max(prompt[1], crop[1]),
            min(prompt[2], crop[2]),
            min(prompt[3], crop[3]),
        )
        if intersection[2] <= intersection[0] or intersection[3] <= intersection[1]:
            continue
        local_prompt = (
            intersection[0] - crop[0],
            intersection[1] - crop[1],
            intersection[2] - crop[0],
            intersection[3] - crop[1],
        )
        _draw_page_box(draw, local_prompt, (255, 0, 191), line_width)
    return overlay


def _pixel_sha256(image: Image.Image) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(str(image.width).encode("ascii"))
    digest.update(b"x")
    digest.update(str(image.height).encode("ascii"))
    digest.update(b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()


def _artifact_binding(
    relative_path: str, image: Image.Image, data: bytes
) -> dict[str, Any]:
    return {
        "path": relative_path,
        "sha256": _sha256_bytes(data),
        "pixelSha256": _pixel_sha256(image),
        "sizeBytes": len(data),
        "width": image.width,
        "height": image.height,
        "mode": image.mode,
        "format": "PNG",
    }


def _round(value: float) -> float:
    return round(float(value), 8)


def _gray(rgb: np.ndarray) -> np.ndarray:
    values = rgb.astype(np.float32)
    return (
        values[..., 0] * np.float32(0.299)
        + values[..., 1] * np.float32(0.587)
        + values[..., 2] * np.float32(0.114)
    )


def _masked_edge_density(gray: np.ndarray, mask: np.ndarray) -> float:
    horizontal_mask = mask[:, 1:] & mask[:, :-1]
    vertical_mask = mask[1:, :] & mask[:-1, :]
    horizontal = np.abs(gray[:, 1:] - gray[:, :-1]) >= 18.0
    vertical = np.abs(gray[1:, :] - gray[:-1, :]) >= 18.0
    edge_count = int(np.count_nonzero(horizontal & horizontal_mask)) + int(
        np.count_nonzero(vertical & vertical_mask)
    )
    pair_count = int(np.count_nonzero(horizontal_mask)) + int(
        np.count_nonzero(vertical_mask)
    )
    return edge_count / pair_count if pair_count else 0.0


def _masked_stats(rgb: np.ndarray, mask: np.ndarray) -> dict[str, Any] | None:
    count = int(np.count_nonzero(mask))
    if count == 0:
        return None
    gray = _gray(rgb)
    selected_gray = gray[mask]
    selected_rgb = rgb[mask]
    return {
        "pixelCount": count,
        "lumaMean": _round(float(selected_gray.mean())),
        "lumaStd": _round(float(selected_gray.std())),
        "nearWhiteFraction": _round(
            float(np.mean(np.all(selected_rgb >= 242, axis=1)))
        ),
        "darkFraction": _round(float(np.mean(selected_gray <= 64.0))),
        "edgeDensity": _round(_masked_edge_density(gray, mask)),
    }


def _risk_diagnostics(
    original: Image.Image,
    cleaned: Image.Image,
    bbox: BBox,
    crop: BBox,
    clamped_sides: Sequence[str],
) -> dict[str, Any]:
    original_crop_image = original.crop(crop)
    cleaned_crop_image = cleaned.crop(crop)
    try:
        original_crop = np.asarray(original_crop_image, dtype=np.uint8).copy()
        cleaned_crop = np.asarray(cleaned_crop_image, dtype=np.uint8).copy()
    finally:
        original_crop_image.close()
        cleaned_crop_image.close()
    height, width = original_crop.shape[:2]
    interior = np.zeros((height, width), dtype=bool)
    local = (
        bbox[0] - crop[0],
        bbox[1] - crop[1],
        bbox[2] - crop[0],
        bbox[3] - crop[1],
    )
    interior[local[1] : local[3], local[0] : local[2]] = True
    context = ~interior
    original_stats = _masked_stats(original_crop, interior)
    cleaned_stats = _masked_stats(cleaned_crop, interior)
    context_stats = _masked_stats(cleaned_crop, context)
    if original_stats is None or cleaned_stats is None:
        raise BubbleFitDatasetError("bubble interior unexpectedly contains no pixels")
    diff = np.abs(
        original_crop[interior].astype(np.int16)
        - cleaned_crop[interior].astype(np.int16)
    )
    max_channel_diff = diff.max(axis=1)
    context_edge_ratio: float | None = None
    context_luma_delta: float | None = None
    if context_stats is not None:
        denominator = float(context_stats["edgeDensity"])
        if denominator > 0:
            context_edge_ratio = _round(
                float(cleaned_stats["edgeDensity"]) / denominator
            )
        context_luma_delta = _round(
            abs(float(cleaned_stats["lumaMean"]) - float(context_stats["lumaMean"]))
        )
    complexity_proxy = (
        0.40 * min(1.0, float(cleaned_stats["lumaStd"]) / 64.0)
        + 0.35 * min(1.0, float(cleaned_stats["edgeDensity"]) / 0.18)
        + 0.25 * min(1.0, (1.0 - float(cleaned_stats["nearWhiteFraction"])) / 0.70)
    )
    page_area = original.width * original.height
    bubble_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    crop_area = (crop[2] - crop[0]) * (crop[3] - crop[1])
    return {
        "diagnosticOnly": True,
        "trainedDecision": False,
        "originalInterior": original_stats,
        "cleanedInterior": cleaned_stats,
        "cleanedContext": context_stats,
        "cleanedInteriorToContextEdgeRatio": context_edge_ratio,
        "cleanedInteriorContextLumaDelta": context_luma_delta,
        "originalCleanedMeanAbsDifference": _round(float(diff.mean()) / 255.0),
        "originalCleanedChangedPixelFraction": _round(
            float(np.mean(max_channel_diff >= 8))
        ),
        "bubbleAspectRatio": _round((bbox[2] - bbox[0]) / (bbox[3] - bbox[1])),
        "bubblePageAreaFraction": _round(bubble_area / page_area),
        "cropPageAreaFraction": _round(crop_area / page_area),
        "contextClampedSides": list(clamped_sides),
        "untrainedCleanedComplexityReviewProxy": _round(complexity_proxy),
    }


def _file_image_binding(
    path: Path,
    image: Image.Image,
    *,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    try:
        size_bytes = path.stat().st_size
    except OSError as exc:
        raise BubbleFitDatasetError(
            f"could not stat source image {path}: {exc}"
        ) from exc
    digest = _sha256_file(path)
    if expected_sha256 is not None and digest != expected_sha256:
        raise BubbleFitDatasetError(
            f"staged original SHA-256 mismatch: {digest} != {expected_sha256}: {path}"
        )
    return {
        "path": str(path),
        "sha256": digest,
        "sizeBytes": size_bytes,
        "width": image.width,
        "height": image.height,
        "mode": image.mode,
    }


def _candidate_id(
    report_sha256: str,
    model_sha256: str,
    page: PageRecord,
    bubble_index: int,
    detection: Detection,
) -> str:
    payload = {
        "reportSha256": report_sha256,
        "modelSha256": model_sha256,
        "selectionIndex": page.selection_index,
        "sourcePageId": page.source_page_id,
        "sourcePageSha256": page.source_page_sha256,
        "bubbleIndex": bubble_index,
        "bbox": list(detection.bbox),
        "score": _round(detection.score),
    }
    return f"bubble-{_sha256_json(payload)[:24]}"


def _render_candidate(
    *,
    output_dir: Path | None,
    report_sha256: str,
    model_sha256: str,
    page: PageRecord,
    original: Image.Image,
    cleaned: Image.Image,
    bubble_index: int,
    group: BubbleGroup,
    context_ratio: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    detection = group.bubble
    prompts = [item.detection.bbox for item in group.text_detections]
    requested, crop_bbox, padding, retained, clamped = _crop_geometry(
        detection.bbox,
        original.width,
        original.height,
        context_ratio,
    )
    candidate_id = _candidate_id(
        report_sha256, model_sha256, page, bubble_index, detection
    )
    base = f"candidates/{candidate_id}"
    relative_paths = {
        "originalNative": f"{base}/original-native.png",
        "cleanedNative": f"{base}/cleaned-native.png",
        "originalTraining224": f"{base}/original-training-224.png",
        "cleanedTraining224": f"{base}/cleaned-training-224.png",
        "qaSingleCandidateOverlay": f"{base}/qa-single-candidate-overlay.png",
        "candidateCoreMask": f"{base}/candidate-core-mask.png",
        "cleanedCoreMaskOverlay": f"{base}/cleaned-core-mask-overlay.png",
    }
    original_crop = original.crop(crop_bbox)
    cleaned_crop = cleaned.crop(crop_bbox)
    original_training = _letterbox_224(original_crop)
    cleaned_training = _letterbox_224(cleaned_crop)
    core_bbox, core_inset = _core_mask_geometry(detection.bbox)
    core_mask = _core_mask_image(crop_bbox, core_bbox)
    overlay = _overlay_image(original, detection.bbox, crop_bbox, prompts)
    cleaned_mask_overlay = _cleaned_core_overlay(
        cleaned_crop, core_mask, crop_bbox, core_bbox, prompts
    )
    images = {
        "originalNative": original_crop,
        "cleanedNative": cleaned_crop,
        "originalTraining224": original_training,
        "cleanedTraining224": cleaned_training,
        "qaSingleCandidateOverlay": overlay,
        "candidateCoreMask": core_mask,
        "cleanedCoreMaskOverlay": cleaned_mask_overlay,
    }
    artifact_bindings: dict[str, dict[str, Any]] = {}
    inventory: list[dict[str, Any]] = []
    try:
        for kind, image in images.items():
            data = _png_bytes(image)
            relative = relative_paths[kind]
            binding = _artifact_binding(relative, image, data)
            artifact_bindings[kind] = binding
            inventory.append(
                {
                    "path": relative,
                    "sha256": binding["sha256"],
                    "pixelSha256": binding["pixelSha256"],
                    "sizeBytes": binding["sizeBytes"],
                }
            )
            if output_dir is not None:
                destination = output_dir / Path(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
    finally:
        for image in images.values():
            image.close()
    record = {
        "id": candidate_id,
        "selectionIndex": page.selection_index,
        "sourcePageId": page.source_page_id,
        "sourcePageName": page.source_page_name,
        "sourcePageSha256": page.source_page_sha256,
        "workId": page.work_id,
        "workTitle": page.work_title,
        "chapterId": page.chapter_id,
        "chapterTitle": page.chapter_title,
        "bubbleIndex": bubble_index,
        "detectorLabel": "bubble",
        "detectorScore": _round(detection.score),
        "detectionBboxPx": list(detection.bbox),
        "associatedTextBubbleDetections": [
            {
                "bboxPx": list(item.detection.bbox),
                "score": _round(item.detection.score),
                "containment": _round(item.containment),
            }
            for item in group.text_detections
        ],
        "promptBoxesPx": [list(prompt) for prompt in prompts],
        "requestedCropBboxPx": list(requested),
        "cropBboxPx": list(crop_bbox),
        "requestedContextPx": padding,
        "retainedContextPx": retained,
        "contextClampedSides": clamped,
        "candidateCoreMask": {
            "pageBboxPx": list(core_bbox),
            "cropLocalBboxPx": [
                core_bbox[0] - crop_bbox[0],
                core_bbox[1] - crop_bbox[1],
                core_bbox[2] - crop_bbox[0],
                core_bbox[3] - crop_bbox[1],
            ],
            "insetPx": core_inset,
            "insetRatio": CORE_MASK_INSET_RATIO,
            "exactProductionFloodParity": False,
            "purpose": "deterministic rectangular core channel for first-pass QA",
        },
        "riskDiagnostics": _risk_diagnostics(
            original, cleaned, detection.bbox, crop_bbox, clamped
        ),
        "artifacts": artifact_bindings,
    }
    return record, inventory


def _page_manifest_record(
    page: PageRecord,
    original: Image.Image,
    cleaned: Image.Image,
    associations: DetectionAssociations,
) -> dict[str, Any]:
    return {
        "selectionIndex": page.selection_index,
        "sourcePageId": page.source_page_id,
        "sourcePageName": page.source_page_name,
        "sourcePageSha256": page.source_page_sha256,
        "workId": page.work_id,
        "workTitle": page.work_title,
        "chapterId": page.chapter_id,
        "chapterTitle": page.chapter_title,
        "runMode": page.mode,
        "original": _file_image_binding(
            page.original_path,
            original,
            expected_sha256=page.source_page_sha256,
        ),
        "cleaned": _file_image_binding(page.cleaned_path, cleaned),
        "bubbleCount": len(associations.bubbles),
        "textBubbleDetectionCount": associations.text_bubble_count,
        "associatedTextBubbleCount": (
            associations.text_bubble_count - associations.unassociated_text_bubble_count
        ),
        "unassociatedTextBubbleCount": associations.unassociated_text_bubble_count,
    }


def _manifest_base(
    *,
    report_path: Path,
    report: Mapping[str, Any],
    report_sha256: str,
    model_path: Path,
    model_sha256: str,
    model_size: int,
    expected_model_sha256: str,
    score_threshold: float,
    context_ratio: float,
    source_selection: Mapping[str, Any] | None,
) -> dict[str, Any]:
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "toolId": TOOL_ID,
        "purpose": "non-production evidence pack for a future bubble-fit gate",
        "labels": {
            "present": False,
            "note": "risk diagnostics and review proxy are not ground-truth labels",
        },
        "sourceRun": {
            "path": str(report_path),
            "sizeBytes": report_path.stat().st_size,
            "sha256": report_sha256,
            "schemaVersion": report.get("schemaVersion"),
            "runId": report.get("runId"),
            "cohort": report.get("cohort"),
            "cohortDigest": report.get("cohortDigest"),
            "candidateId": report.get("candidateId"),
            "finishedAt": report.get("finishedAt"),
        },
        "detector": {
            "path": str(model_path),
            "file": MODEL_FILE,
            "repo": MODEL_REPO,
            "revision": MODEL_REVISION,
            "sha256": model_sha256,
            "expectedSha256": expected_model_sha256,
            "sizeBytes": model_size,
            "provider": "CPUExecutionProvider",
            "inputSize": [MODEL_INPUT_SIZE, MODEL_INPUT_SIZE],
            "labels": list(MODEL_LABELS),
            "selectedLabel": "bubble",
            "textBubbleAssociation": {
                "method": "intersection over text_bubble area",
                "minimumContainment": TEXT_BUBBLE_CONTAINMENT_THRESHOLD,
                "tieBreak": "higher bubble score",
                "policyReference": "src/main/bubbleLayout/association.ts",
            },
            "scoreThreshold": _round(score_threshold),
            "preprocess": "RGB, direct 640x640 LANCZOS resize, float32 CHW / 255",
        },
        "cropSpec": {
            "contextRatio": _round(context_ratio),
            "contextStrategy": "ceil(major detection side * ratio), isotropic",
            "nativeResolution": True,
            "trainingSize": [TRAINING_SIZE, TRAINING_SIZE],
            "trainingResize": "aspect-preserving LANCZOS with centered white padding",
            "overlayPolicy": "one native context crop and one candidate only; no contact sheets",
        },
        "maskSpec": {
            "kind": "binary rectangular core in native crop coordinates",
            "insideValue": 255,
            "outsideValue": 0,
            "insetRatio": CORE_MASK_INSET_RATIO,
            "exactProductionFloodParity": False,
            "followUp": (
                "port or invoke refineBubbleSafeMask using the persisted prompt boxes; "
                "never treat this core box as a production safe mask"
            ),
        },
        "pages": [],
        "candidates": [],
    }
    if source_selection is not None:
        manifest["sourceSelection"] = dict(source_selection)
    return manifest


def _validate_options(options: BuildOptions) -> tuple[Path, Path, Path, str]:
    report_path = Path(options.report_path).resolve()
    model_path = Path(options.model_path).resolve()
    output_dir = Path(options.output_dir).resolve()
    expected = options.expected_model_sha256.lower()
    if not report_path.is_file():
        raise BubbleFitDatasetError(f"run report is missing: {report_path}")
    if not model_path.is_file():
        raise BubbleFitDatasetError(f"detector model is missing: {model_path}")
    if not SHA256_RE.fullmatch(expected):
        raise BubbleFitDatasetError("expected model SHA-256 is invalid")
    if (
        not math.isfinite(options.score_threshold)
        or not 0 <= options.score_threshold <= 1
    ):
        raise BubbleFitDatasetError("score threshold must be between 0 and 1")
    if not math.isfinite(options.context_ratio) or not 0 < options.context_ratio <= 1:
        raise BubbleFitDatasetError(
            "context ratio must be greater than zero and at most one"
        )
    if output_dir.exists():
        if not output_dir.is_dir():
            raise BubbleFitDatasetError(f"output is not a directory: {output_dir}")
        try:
            next(output_dir.iterdir())
        except StopIteration:
            pass
        else:
            raise BubbleFitDatasetError(
                f"output directory must be new or empty: {output_dir}"
            )
    return report_path, output_dir, model_path, expected


def _progress(message: str, quiet: bool) -> None:
    if not quiet:
        print(message, flush=True)


def build_dataset(
    options: BuildOptions,
    *,
    detector_factory: Callable[[Path, float], PageDetector] = ComicLayoutDetector,
) -> dict[str, Any]:
    report_path, output_dir, model_path, expected_model_sha256 = _validate_options(
        options
    )
    report_sha256 = _sha256_file(report_path)
    model_sha256 = _sha256_file(model_path)
    if model_sha256 != expected_model_sha256:
        raise BubbleFitDatasetError(
            f"detector SHA-256 mismatch: {model_sha256} != {expected_model_sha256}"
        )
    report, all_pages = _load_report(report_path)
    pages, source_selection = _select_report_pages(
        all_pages,
        options.selection_start,
        options.selection_count,
    )
    detector = detector_factory(model_path, options.score_threshold)
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = _manifest_base(
        report_path=report_path,
        report=report,
        report_sha256=report_sha256,
        model_path=model_path,
        model_sha256=model_sha256,
        model_size=model_path.stat().st_size,
        expected_model_sha256=expected_model_sha256,
        score_threshold=options.score_threshold,
        context_ratio=options.context_ratio,
        source_selection=source_selection,
    )
    inventory: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    page_records: list[dict[str, Any]] = []
    associated_text_prompt_count = 0
    for page_offset, page in enumerate(pages, start=1):
        _progress(
            f"[bubble-fit-dataset] infer {page_offset}/{len(pages)}: {page.source_page_name}",
            options.quiet,
        )
        original = _open_rgb(page.original_path, "staged original")
        cleaned = _open_rgb(page.cleaned_path, "cleaned image")
        try:
            if original.size != cleaned.size:
                raise BubbleFitDatasetError(
                    f"source image dimensions differ for page {page.source_page_id}: "
                    f"original={original.size}, cleaned={cleaned.size}"
                )
            associations = _associate_detections(
                detector.detect(original), original.width, original.height
            )
            page_records.append(
                _page_manifest_record(page, original, cleaned, associations)
            )
            for bubble_index, group in enumerate(associations.bubbles):
                record, artifacts = _render_candidate(
                    output_dir=output_dir,
                    report_sha256=report_sha256,
                    model_sha256=model_sha256,
                    page=page,
                    original=original,
                    cleaned=cleaned,
                    bubble_index=bubble_index,
                    group=group,
                    context_ratio=options.context_ratio,
                )
                candidates.append(record)
                inventory.extend(artifacts)
                associated_text_prompt_count += len(group.text_detections)
        finally:
            original.close()
            cleaned.close()
    manifest["pages"] = page_records
    manifest["candidates"] = candidates
    manifest["counts"] = {
        "pages": len(page_records),
        "bubbleCandidates": len(candidates),
        "associatedTextPrompts": associated_text_prompt_count,
        "artifacts": len(inventory),
    }
    manifest["artifactInventorySha256"] = _sha256_json(inventory)
    manifest["manifestBindingSha256"] = _sha256_json(manifest)
    manifest_path = output_dir / MANIFEST_NAME
    _write_json(manifest_path, manifest)
    seal = {
        "schemaVersion": SCHEMA_VERSION,
        "toolId": TOOL_ID,
        "manifestFile": MANIFEST_NAME,
        "manifestSha256": _sha256_file(manifest_path),
        "manifestBindingSha256": manifest["manifestBindingSha256"],
        "artifactInventorySha256": manifest["artifactInventorySha256"],
        "sourceReportSha256": report_sha256,
        "detectorModelSha256": model_sha256,
        "candidateCount": len(candidates),
        "artifactCount": len(inventory),
    }
    _write_json(output_dir / SEAL_NAME, seal)
    return {
        "ok": True,
        "outputDir": str(output_dir),
        "pages": len(page_records),
        "candidates": len(candidates),
        "artifacts": len(inventory),
        "manifestSha256": seal["manifestSha256"],
        "manifestBindingSha256": manifest["manifestBindingSha256"],
        "inferences": detector.inference_count,
    }


def _safe_dataset_file(dataset_dir: Path, relative: Any, field: str) -> Path:
    text = _require_string(relative, field)
    relative_path = Path(text)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise BubbleFitDatasetError(f"unsafe artifact path in {field}: {text}")
    resolved = (dataset_dir / relative_path).resolve()
    try:
        resolved.relative_to(dataset_dir)
    except ValueError as exc:
        raise BubbleFitDatasetError(f"artifact escapes dataset: {text}") from exc
    if not resolved.is_file():
        raise BubbleFitDatasetError(f"missing artifact: {resolved}")
    return resolved


def _verify_artifact(
    dataset_dir: Path,
    kind: str,
    binding: Mapping[str, Any],
    expected: Mapping[str, Any],
) -> str:
    if dict(binding) != dict(expected):
        raise BubbleFitDatasetError(
            f"recomputed {kind} binding does not match manifest"
        )
    path = _safe_dataset_file(dataset_dir, binding.get("path"), kind)
    if _sha256_file(path) != _require_sha256(binding.get("sha256"), f"{kind}.sha256"):
        raise BubbleFitDatasetError(f"artifact SHA-256 mismatch: {path}")
    if path.stat().st_size != _require_int(
        binding.get("sizeBytes"), f"{kind}.sizeBytes", 1
    ):
        raise BubbleFitDatasetError(f"artifact byte size mismatch: {path}")
    try:
        with Image.open(path) as opened:
            opened.load()
            if opened.format != "PNG":
                raise BubbleFitDatasetError(f"artifact is not PNG: {path}")
            image = opened.copy()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise BubbleFitDatasetError(f"could not decode artifact {path}: {exc}") from exc
    try:
        if image.width <= 0 or image.height <= 0:
            raise BubbleFitDatasetError(f"artifact is empty: {path}")
        if [image.width, image.height] != [binding.get("width"), binding.get("height")]:
            raise BubbleFitDatasetError(f"artifact dimensions mismatch: {path}")
        if image.mode != binding.get("mode"):
            raise BubbleFitDatasetError(f"artifact mode mismatch: {path}")
        if _pixel_sha256(image) != _require_sha256(
            binding.get("pixelSha256"), f"{kind}.pixelSha256"
        ):
            raise BubbleFitDatasetError(f"artifact pixel SHA-256 mismatch: {path}")
        if kind in {"originalTraining224", "cleanedTraining224"} and image.size != (
            TRAINING_SIZE,
            TRAINING_SIZE,
        ):
            raise BubbleFitDatasetError(f"training artifact is not 224x224: {path}")
    finally:
        image.close()
    return path.relative_to(dataset_dir).as_posix()


def _manifest_without_binding(manifest: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(manifest)
    value.pop("manifestBindingSha256", None)
    return value


def validate_dataset(
    dataset_dir: Path,
    *,
    detector_factory: Callable[[Path, float], PageDetector] = ComicLayoutDetector,
    quiet: bool = False,
) -> dict[str, Any]:
    dataset_dir = Path(dataset_dir).resolve()
    if not dataset_dir.is_dir():
        raise BubbleFitDatasetError(f"dataset directory is missing: {dataset_dir}")
    manifest_path = dataset_dir / MANIFEST_NAME
    seal_path = dataset_dir / SEAL_NAME
    manifest = _read_json(manifest_path, "dataset manifest")
    seal = _read_json(seal_path, "dataset seal")
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or manifest.get("toolId") != TOOL_ID
    ):
        raise BubbleFitDatasetError("unsupported dataset manifest schema/tool")
    binding = _require_sha256(
        manifest.get("manifestBindingSha256"), "manifestBindingSha256"
    )
    if _sha256_json(_manifest_without_binding(manifest)) != binding:
        raise BubbleFitDatasetError("manifest binding SHA-256 mismatch")
    source_run = manifest.get("sourceRun")
    detector_spec = manifest.get("detector")
    crop_spec = manifest.get("cropSpec")
    if not isinstance(source_run, dict) or not isinstance(detector_spec, dict):
        raise BubbleFitDatasetError("manifest sourceRun/detector must be objects")
    if not isinstance(crop_spec, dict):
        raise BubbleFitDatasetError("manifest cropSpec must be an object")
    mask_spec = manifest.get("maskSpec")
    if (
        not isinstance(mask_spec, dict)
        or mask_spec.get("exactProductionFloodParity") is not False
    ):
        raise BubbleFitDatasetError(
            "manifest must describe the non-production core mask"
        )
    report_path = _resolve_file(Path.cwd(), source_run.get("path"), "sourceRun.path")
    model_path = _resolve_file(Path.cwd(), detector_spec.get("path"), "detector.path")
    report_sha256 = _require_sha256(source_run.get("sha256"), "sourceRun.sha256")
    model_sha256 = _require_sha256(detector_spec.get("sha256"), "detector.sha256")
    if _sha256_file(report_path) != report_sha256:
        raise BubbleFitDatasetError("source run report SHA-256 mismatch")
    if _sha256_file(model_path) != model_sha256:
        raise BubbleFitDatasetError("detector model SHA-256 mismatch")
    if model_sha256 != _require_sha256(
        detector_spec.get("expectedSha256"), "detector.expectedSha256"
    ):
        raise BubbleFitDatasetError("detector no longer matches its expected SHA-256")
    report, all_pages = _load_report(report_path)
    pages = (
        _apply_manifest_source_selection(all_pages, manifest["sourceSelection"])
        if "sourceSelection" in manifest
        else list(all_pages)
    )
    score_threshold = float(detector_spec.get("scoreThreshold"))
    context_ratio = float(crop_spec.get("contextRatio"))
    if not math.isfinite(score_threshold) or not 0 <= score_threshold <= 1:
        raise BubbleFitDatasetError("manifest score threshold is invalid")
    if not math.isfinite(context_ratio) or not 0 < context_ratio <= 1:
        raise BubbleFitDatasetError("manifest context ratio is invalid")
    stored_pages = manifest.get("pages")
    stored_candidates = manifest.get("candidates")
    if not isinstance(stored_pages, list) or not isinstance(stored_candidates, list):
        raise BubbleFitDatasetError("manifest pages/candidates must be arrays")
    stored_pages_by_selection_index: dict[int, Mapping[str, Any]] = {}
    for position, stored_page in enumerate(stored_pages, start=1):
        if not isinstance(stored_page, dict):
            raise BubbleFitDatasetError(
                f"manifest page {position} must be an object"
            )
        selection_index = _require_int(
            stored_page.get("selectionIndex"),
            f"manifest page {position} selectionIndex",
        )
        if selection_index in stored_pages_by_selection_index:
            raise BubbleFitDatasetError(
                f"duplicate manifest page selectionIndex: {selection_index}"
            )
        stored_pages_by_selection_index[selection_index] = stored_page
    expected_page_indices = {page.selection_index for page in pages}
    if set(stored_pages_by_selection_index) != expected_page_indices:
        raise BubbleFitDatasetError(
            "manifest page selectionIndex coverage does not match sourceSelection"
        )
    detector = detector_factory(model_path, score_threshold)
    candidate_offset = 0
    associated_text_prompt_count = 0
    inventory: list[dict[str, Any]] = []
    expected_files = {MANIFEST_NAME, SEAL_NAME}
    for page_offset, page in enumerate(pages, start=1):
        _progress(
            f"[bubble-fit-dataset] validate {page_offset}/{len(pages)}: {page.source_page_name}",
            quiet,
        )
        original = _open_rgb(page.original_path, "staged original")
        cleaned = _open_rgb(page.cleaned_path, "cleaned image")
        try:
            if original.size != cleaned.size:
                raise BubbleFitDatasetError(
                    f"source image dimensions differ for page {page.source_page_id}"
                )
            associations = _associate_detections(
                detector.detect(original), original.width, original.height
            )
            expected_page = _page_manifest_record(page, original, cleaned, associations)
            if stored_pages_by_selection_index[page.selection_index] != expected_page:
                raise BubbleFitDatasetError(
                    f"recomputed page provenance does not match page {page.source_page_id}"
                )
            for bubble_index, group in enumerate(associations.bubbles):
                if candidate_offset >= len(stored_candidates):
                    raise BubbleFitDatasetError(
                        "manifest is missing recomputed candidates"
                    )
                expected_candidate, expected_inventory = _render_candidate(
                    output_dir=None,
                    report_sha256=report_sha256,
                    model_sha256=model_sha256,
                    page=page,
                    original=original,
                    cleaned=cleaned,
                    bubble_index=bubble_index,
                    group=group,
                    context_ratio=context_ratio,
                )
                stored = stored_candidates[candidate_offset]
                if not isinstance(stored, dict) or stored != expected_candidate:
                    raise BubbleFitDatasetError(
                        f"recomputed candidate does not match manifest at index {candidate_offset}"
                    )
                stored_artifacts = stored.get("artifacts")
                if not isinstance(stored_artifacts, dict):
                    raise BubbleFitDatasetError("candidate artifacts must be an object")
                for kind, expected_binding in expected_candidate["artifacts"].items():
                    raw_binding = stored_artifacts.get(kind)
                    if not isinstance(raw_binding, dict):
                        raise BubbleFitDatasetError(f"candidate is missing {kind}")
                    expected_files.add(
                        _verify_artifact(
                            dataset_dir,
                            kind,
                            raw_binding,
                            expected_binding,
                        )
                    )
                inventory.extend(expected_inventory)
                associated_text_prompt_count += len(group.text_detections)
                candidate_offset += 1
        finally:
            original.close()
            cleaned.close()
    if candidate_offset != len(stored_candidates):
        raise BubbleFitDatasetError(
            "manifest has extra candidates not reproduced by detector"
        )
    counts = manifest.get("counts")
    expected_counts = {
        "pages": len(pages),
        "bubbleCandidates": candidate_offset,
        "associatedTextPrompts": associated_text_prompt_count,
        "artifacts": len(inventory),
    }
    if counts != expected_counts:
        raise BubbleFitDatasetError("manifest counts do not match reproduced inventory")
    inventory_sha = _sha256_json(inventory)
    if manifest.get("artifactInventorySha256") != inventory_sha:
        raise BubbleFitDatasetError("artifact inventory SHA-256 mismatch")
    actual_files = {
        path.relative_to(dataset_dir).as_posix()
        for path in dataset_dir.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_files:
        extra = sorted(actual_files - expected_files)
        missing = sorted(expected_files - actual_files)
        raise BubbleFitDatasetError(
            f"dataset file inventory mismatch; extra={extra}, missing={missing}"
        )
    expected_seal = {
        "schemaVersion": SCHEMA_VERSION,
        "toolId": TOOL_ID,
        "manifestFile": MANIFEST_NAME,
        "manifestSha256": _sha256_file(manifest_path),
        "manifestBindingSha256": binding,
        "artifactInventorySha256": inventory_sha,
        "sourceReportSha256": report_sha256,
        "detectorModelSha256": model_sha256,
        "candidateCount": candidate_offset,
        "artifactCount": len(inventory),
    }
    if seal != expected_seal:
        raise BubbleFitDatasetError(
            "dataset seal does not bind the reproduced manifest"
        )
    if source_run.get("runId") != report.get("runId"):
        raise BubbleFitDatasetError("manifest runId no longer matches run report")
    return {
        "ok": True,
        "datasetDir": str(dataset_dir),
        "pages": len(pages),
        "candidates": candidate_offset,
        "artifacts": len(inventory),
        "manifestSha256": expected_seal["manifestSha256"],
        "manifestBindingSha256": binding,
        "inferences": detector.inference_count,
    }


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    default_model = (
        repo_root
        / "models"
        / "bubble-layout"
        / "comic-text-and-bubble-detector"
        / MODEL_FILE
    )
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="mine a new evidence dataset")
    build.add_argument("--run-report", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--model", type=Path, default=default_model)
    build.add_argument("--expected-model-sha256", default=EXPECTED_MODEL_SHA256)
    build.add_argument("--score-threshold", type=float, default=DEFAULT_SCORE_THRESHOLD)
    build.add_argument("--context-ratio", type=float, default=DEFAULT_CONTEXT_RATIO)
    build.add_argument(
        "--selection-start",
        type=int,
        help="zero-based first completed-run selectionIndex to include",
    )
    build.add_argument(
        "--selection-count",
        type=int,
        help="number of contiguous completed-run pages to include",
    )
    build.add_argument("--quiet", action="store_true")
    validate = subparsers.add_parser(
        "validate", help="rerun inference and reproduce every bound artifact"
    )
    validate.add_argument("--dataset", type=Path, required=True)
    validate.add_argument("--quiet", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            result = build_dataset(
                BuildOptions(
                    report_path=args.run_report,
                    output_dir=args.output,
                    model_path=args.model,
                    expected_model_sha256=args.expected_model_sha256,
                    score_threshold=args.score_threshold,
                    context_ratio=args.context_ratio,
                    selection_start=args.selection_start,
                    selection_count=args.selection_count,
                    quiet=args.quiet,
                )
            )
        else:
            result = validate_dataset(args.dataset, quiet=args.quiet)
    except (BubbleFitDatasetError, OSError, ValueError) as exc:
        parser.exit(2, f"error: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
