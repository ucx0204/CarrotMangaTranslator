#!/usr/bin/env python3
"""Mine real, visually unusual text crops for a later FontCLIP review pass.

The miner deliberately does not invent labels and never renders diagnostic
overlays into training images.  It selects at most twenty chapters per work
across the full chapter timeline, runs the bundled comic RT-DETR exactly once
per selected page, and combines layout detections with page-block and OCR-hint
metadata.  Every persisted page is an independently signed resume unit.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence

import numpy as np
from PIL import Image, ImageOps


SCHEMA_VERSION = 1
TOOL_ID = "manga-translator-fontclip-hard-candidates"
MARKER_NAME = ".fontclip-hard-candidates.json"
STATE_DIR_NAME = ".fontclip-hard-pages"
MODEL_INPUT_SIZE = 640
LETTERBOX_SIZE = 224
MODEL_LABELS = ("bubble", "text_bubble", "text_free")
EXPECTED_MODEL_SHA256 = (
    "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79"
)
SUPPORTED_IMAGES = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
)
OWNED_OUTPUTS = (
    STATE_DIR_NAME,
    "images/raw",
    f"images/clip_{LETTERBOX_SIZE}",
    "manifest.jsonl",
    "selected_chapters.json",
    "selected_chapters.jsonl",
    "report.json",
    "report.jsonl",
)
HARD_OCR_REASONS = frozenset(
    {
        "ambiguous_low_confidence_shape",
        "dense_page_single_glyph",
        "kept_separate",
        "low_confidence_no_bridge",
        "low_confidence_short_text",
        "oversized_display_text",
        "oversized_uncertain_sfx",
        "small_low_confidence_text",
        "unattached_auxiliary",
    }
)
CATEGORY_PRIORITY = {
    "page_sound": 0,
    "ocr_sound_prior": 1,
    "bubble_edge": 2,
    "text_free": 3,
    "free_near_bubble": 4,
    "ocr_hard": 5,
    "ocr_anime_region": 6,
    "ocr_free_container": 7,
}
SAFE_COMPONENT = re.compile(r"^[^/\\\x00]+$")


class HardCandidateError(RuntimeError):
    """Base error for a guarded hard-candidate build."""


class LibraryValidationError(HardCandidateError):
    """Raised when indexed library metadata cannot be trusted."""


class UnsafeOutputError(HardCandidateError):
    """Raised when output ownership or path containment is unsafe."""


class ResumeValidationError(HardCandidateError):
    """Raised when a page checkpoint no longer matches its signed inputs."""


BBox = tuple[int, int, int, int]


@dataclass(frozen=True)
class WorkRecord:
    id: str
    title: str
    chapter_order: tuple[str, ...]
    directory: Path
    manifest_sha256: str
    order_index: int


@dataclass(frozen=True)
class PageRecord:
    id: str
    name: str
    source_path: Path
    # Chapter metadata is useful provenance, but source bytes are authoritative.
    width: int | None
    height: int | None
    blocks: tuple[Mapping[str, Any], ...]
    order_index: int


@dataclass(frozen=True)
class ChapterRecord:
    id: str
    title: str
    work_id: str
    directory: Path
    pages: tuple[PageRecord, ...]
    manifest_sha256: str
    order_index: int


@dataclass(frozen=True)
class SelectedChapter:
    work: WorkRecord
    chapter: ChapterRecord
    segment_index: int
    segment_start: int
    segment_end: int


@dataclass(frozen=True)
class FrozenPage:
    selection: SelectedChapter
    page: PageRecord
    source_sha256: str
    source_size_bytes: int
    actual_width: int
    actual_height: int
    source_dimension_mismatch: bool
    ocr_hints: tuple[Mapping[str, Any], ...]
    ocr_hints_sha256: str | None
    ocr_coordinate_provenance: Mapping[str, Any]
    ocr_metadata_skip_reasons: Mapping[str, int]

    @property
    def work(self) -> WorkRecord:
        return self.selection.work

    @property
    def chapter(self) -> ChapterRecord:
        return self.selection.chapter


@dataclass(frozen=True)
class Detection:
    label: str
    score: float
    bbox: BBox


@dataclass
class Candidate:
    bbox: BBox
    score: float
    categories: set[str]
    evidence: list[dict[str, Any]]
    source_ids: set[str] = field(default_factory=set)
    text: str = ""


@dataclass(frozen=True)
class MiningConfig:
    score_threshold: float
    detector_nms_iou: float
    dedup_iou: float
    bubble_edge_ratio: float
    near_bubble_ratio: float
    accepted_iou: float
    crop_padding_ratio: float
    crop_padding_min: int
    crop_padding_max: int


class PageDetector(Protocol):
    inference_count: int

    def detect(self, image: Image.Image) -> list[Detection]:
        """Return layout detections in original source-image coordinates."""


@dataclass
class AcceptedBoxIndex:
    by_source: dict[str, list[tuple[str, BBox]]] = field(
        default_factory=lambda: defaultdict(list)
    )
    by_page: dict[tuple[str, str, str], list[tuple[str, BBox]]] = field(
        default_factory=lambda: defaultdict(list)
    )

    def add(self, record: Mapping[str, Any]) -> None:
        item_id = _string(record.get("id")) or "accepted"
        bbox = _record_bbox(record)
        if bbox is None:
            return
        source = _normalize_relative_path(
            record.get("source_image_path") or record.get("source_page_path")
        )
        if source:
            self.by_source[source].append((item_id, bbox))
        page_key = (
            _string(record.get("work_id")),
            _string(record.get("chapter_id")),
            _string(record.get("page_id")),
        )
        if all(page_key):
            self.by_page[page_key].append((item_id, bbox))

    def high_iou_match(
        self,
        page: FrozenPage,
        bbox: BBox,
        threshold: float,
        library_root: Path,
    ) -> tuple[str, float] | None:
        source = _relative_source(page.page.source_path, library_root)
        values = list(self.by_source.get(source, ()))
        page_key = (page.work.id, page.chapter.id, page.page.id)
        values.extend(self.by_page.get(page_key, ()))
        best: tuple[str, float] | None = None
        seen: set[tuple[str, BBox]] = set()
        for item_id, accepted_bbox in values:
            key = (item_id, accepted_bbox)
            if key in seen:
                continue
            seen.add(key)
            overlap = bbox_iou(bbox, accepted_bbox)
            if overlap >= threshold and (best is None or overlap > best[1]):
                best = (item_id, overlap)
        return best


class ComicLayoutDetector:
    """Small Python wrapper around the pinned RT-DETR used by the app."""

    def __init__(self, model_path: Path, score_threshold: float) -> None:
        self.model_path = model_path.resolve()
        self.score_threshold = score_threshold
        self.inference_count = 0
        self._session: Any | None = None
        self._model_bytes = self.model_path.read_bytes()
        self.model_sha256 = _sha256_bytes(self._model_bytes)

    def _get_session(self) -> Any:
        if self._session is not None:
            return self._session
        try:
            import onnxruntime as ort
        except ImportError as exc:  # pragma: no cover - depends on local runtime
            raise HardCandidateError(f"onnxruntime is unavailable: {exc}") from exc
        providers = ort.get_available_providers()
        if "CPUExecutionProvider" not in providers:
            raise HardCandidateError("onnxruntime CPUExecutionProvider is unavailable")
        self._session = ort.InferenceSession(
            self._model_bytes,
            providers=["CPUExecutionProvider"],
        )
        inputs = {value.name: value for value in self._session.get_inputs()}
        outputs = {value.name: value for value in self._session.get_outputs()}
        if set(inputs) != {"images", "orig_target_sizes"}:
            raise HardCandidateError(f"unexpected RT-DETR inputs: {sorted(inputs)}")
        if not {"labels", "boxes", "scores"}.issubset(outputs):
            raise HardCandidateError(f"unexpected RT-DETR outputs: {sorted(outputs)}")
        return self._session

    def detect(self, image: Image.Image) -> list[Detection]:
        image = _rgb_image(image)
        width, height = image.size
        resized = image.resize(
            (MODEL_INPUT_SIZE, MODEL_INPUT_SIZE),
            Image.Resampling.LANCZOS,
        )
        pixels = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
        images = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None, ...])
        target_sizes = np.asarray([[width, height]], dtype=np.int64)
        session = self._get_session()
        labels, boxes, scores = session.run(
            ["labels", "boxes", "scores"],
            {"images": images, "orig_target_sizes": target_sizes},
        )
        self.inference_count += 1
        flat_labels = np.asarray(labels).reshape(-1)
        flat_scores = np.asarray(scores).reshape(-1)
        flat_boxes = np.asarray(boxes).reshape(-1, 4)
        count = min(len(flat_labels), len(flat_scores), len(flat_boxes))
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
            raw = flat_boxes[index]
            if not all(math.isfinite(float(value)) for value in raw):
                continue
            bbox = _clamped_bbox(raw, width, height)
            if bbox is None:
                continue
            detections.append(Detection(MODEL_LABELS[label_id], score, bbox))
        return detections


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _identifier(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return str(int(value))
    return ""


def _finite_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _positive_int(value: Any) -> int | None:
    number = _finite_float(value)
    if number is None or number <= 0 or not float(number).is_integer():
        return None
    return int(number)


def _declared_dimension(value: Any) -> int | None:
    """Preserve zero/stale integer metadata without trusting it for pixels."""

    number = _finite_float(value)
    if number is None or number < 0 or not float(number).is_integer():
        return None
    return int(number)


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(_canonical_json(value).encode("utf-8"))


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise HardCandidateError(
                    f"invalid JSONL at {path}:{line_number}: {exc}"
                ) from exc
            if not isinstance(value, dict):
                raise HardCandidateError(f"expected an object at {path}:{line_number}")
            records.append(value)
    return records


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_write_jsonl(path: Path, records: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(_canonical_json(record))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_save_png(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        image.save(temporary, format="PNG", optimize=False)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _is_within(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _safe_component(value: Any, label: str) -> str:
    result = _string(value)
    if not result or result in {".", ".."} or not SAFE_COMPONENT.fullmatch(result):
        raise LibraryValidationError(f"unsafe or empty {label}: {value!r}")
    return result


def _require_unique_components(values: Any, label: str) -> tuple[str, ...]:
    if not isinstance(values, list):
        raise LibraryValidationError(f"{label} must be a list")
    result = tuple(_safe_component(value, label) for value in values)
    if len(result) != len(set(result)):
        raise LibraryValidationError(f"{label} contains duplicates")
    return result


def _resolve_page_source(
    page_dir: Path,
    page_id: str,
    image_path_value: Any,
) -> Path:
    page_root = page_dir.resolve()
    image_text = _string(image_path_value)
    supplied = Path(image_text).expanduser() if image_text else None
    if supplied is not None:
        try:
            resolved = supplied.resolve()
        except OSError:
            resolved = supplied.absolute()
        if (
            resolved.is_file()
            and resolved.suffix.lower() in SUPPORTED_IMAGES
            and _is_within(page_root, resolved)
        ):
            return resolved

    matches = sorted(
        (
            candidate.resolve()
            for candidate in page_root.iterdir()
            if candidate.is_file()
            and candidate.suffix.lower() in SUPPORTED_IMAGES
            and candidate.stem.endswith(f"-{page_id}")
        ),
        key=lambda path: path.name,
    )
    if supplied is not None and len(matches) == 1:
        # A moved library can retain an obsolete absolute root.  Recovery is
        # allowed only when the exact physical filename still matches.
        if supplied.name != matches[0].name:
            matches = []
    if len(matches) != 1 or not _is_within(page_root, matches[0]):
        raise LibraryValidationError(
            f"page {page_id} does not resolve to one safe local image"
        )
    return matches[0]


def load_library(
    library_root: Path,
    *,
    limit_works: int | None = None,
) -> list[tuple[WorkRecord, tuple[ChapterRecord, ...]]]:
    """Load only the indexed inventory and fail closed on malformed metadata."""

    root = library_root.resolve()
    index_path = root / "index.json"
    if not index_path.is_file():
        raise LibraryValidationError(f"missing library index: {index_path}")
    raw_index = _read_json(index_path)
    if not isinstance(raw_index, dict):
        raise LibraryValidationError(f"library index is not an object: {index_path}")
    work_ids = _require_unique_components(raw_index.get("workOrder"), "work id")
    if limit_works is not None:
        if limit_works < 1:
            raise ValueError("--limit-works must be positive")
        work_ids = work_ids[:limit_works]

    inventory: list[tuple[WorkRecord, tuple[ChapterRecord, ...]]] = []
    for work_index, work_id in enumerate(work_ids):
        work_dir = (root / "works" / work_id).resolve()
        if not _is_within(root / "works", work_dir):
            raise LibraryValidationError(f"unsafe work directory: {work_dir}")
        work_path = work_dir / "work.json"
        if not work_path.is_file():
            raise LibraryValidationError(f"missing indexed work: {work_path}")
        work_bytes = work_path.read_bytes()
        raw_work = json.loads(work_bytes.decode("utf-8-sig"))
        if not isinstance(raw_work, dict) or _string(raw_work.get("id")) != work_id:
            raise LibraryValidationError(f"work id mismatch: {work_path}")
        chapter_ids = _require_unique_components(
            raw_work.get("chapterOrder"), f"chapter order for {work_id}"
        )
        work = WorkRecord(
            id=work_id,
            title=_string(raw_work.get("title")) or work_id,
            chapter_order=chapter_ids,
            directory=work_dir,
            manifest_sha256=_sha256_bytes(work_bytes),
            order_index=work_index,
        )
        chapters: list[ChapterRecord] = []
        for chapter_index, chapter_id in enumerate(chapter_ids):
            chapter_dir = (work_dir / "chapters" / chapter_id).resolve()
            if not _is_within(work_dir / "chapters", chapter_dir):
                raise LibraryValidationError(f"unsafe chapter directory: {chapter_dir}")
            chapter_path = chapter_dir / "chapter.json"
            if not chapter_path.is_file():
                raise LibraryValidationError(f"missing indexed chapter: {chapter_path}")
            chapter_bytes = chapter_path.read_bytes()
            raw_chapter = json.loads(chapter_bytes.decode("utf-8-sig"))
            if (
                not isinstance(raw_chapter, dict)
                or _string(raw_chapter.get("id")) != chapter_id
                or _string(raw_chapter.get("workId")) != work_id
            ):
                raise LibraryValidationError(
                    f"chapter identity mismatch: {chapter_path}"
                )
            page_order = _require_unique_components(
                raw_chapter.get("pageOrder"),
                f"page order for {work_id}/{chapter_id}",
            )
            raw_pages = raw_chapter.get("pages")
            if not isinstance(raw_pages, list) or any(
                not isinstance(page, dict) for page in raw_pages
            ):
                raise LibraryValidationError(
                    f"chapter pages must be objects: {chapter_path}"
                )
            page_by_id: dict[str, Mapping[str, Any]] = {}
            for raw_page in raw_pages:
                page_id = _safe_component(
                    raw_page.get("id"), f"page id in {chapter_id}"
                )
                if page_id in page_by_id:
                    raise LibraryValidationError(
                        f"duplicate page {page_id}: {chapter_path}"
                    )
                page_by_id[page_id] = raw_page
            if set(page_order) != set(page_by_id):
                raise LibraryValidationError(
                    f"pageOrder/pages inventory mismatch: {chapter_path}"
                )
            pages: list[PageRecord] = []
            page_dir = chapter_dir / "pages"
            if not page_dir.is_dir():
                raise LibraryValidationError(f"missing page directory: {page_dir}")
            for page_index, page_id in enumerate(page_order):
                raw_page = page_by_id[page_id]
                width = _declared_dimension(raw_page.get("width"))
                height = _declared_dimension(raw_page.get("height"))
                source_path = _resolve_page_source(
                    page_dir,
                    page_id,
                    raw_page.get("imagePath"),
                )
                raw_blocks = raw_page.get("blocks")
                if raw_blocks is None:
                    blocks: tuple[Mapping[str, Any], ...] = ()
                elif isinstance(raw_blocks, list) and all(
                    isinstance(block, dict) for block in raw_blocks
                ):
                    blocks = tuple(raw_blocks)
                else:
                    raise LibraryValidationError(f"invalid blocks for page {page_id}")
                pages.append(
                    PageRecord(
                        id=page_id,
                        name=_string(raw_page.get("name")) or source_path.name,
                        source_path=source_path,
                        width=width,
                        height=height,
                        blocks=blocks,
                        order_index=page_index,
                    )
                )
            chapters.append(
                ChapterRecord(
                    id=chapter_id,
                    title=_string(raw_chapter.get("title")) or chapter_id,
                    work_id=work_id,
                    directory=chapter_dir,
                    pages=tuple(pages),
                    manifest_sha256=_sha256_bytes(chapter_bytes),
                    order_index=chapter_index,
                )
            )
        inventory.append((work, tuple(chapters)))
    return inventory


def select_chapters_evenly(
    work: WorkRecord,
    chapters: Sequence[ChapterRecord],
    max_chapters: int,
) -> list[SelectedChapter]:
    """Choose timeline-spanning chapters without favoring one dense period."""

    if not 1 <= max_chapters <= 20:
        raise ValueError("--max-chapters-per-work must be between 1 and 20")
    if len(chapters) != len(work.chapter_order):
        raise LibraryValidationError(f"chapter inventory mismatch for work {work.id}")
    count = len(chapters)
    if count == 0:
        return []
    selected_count = min(max_chapters, count)
    if selected_count == 1:
        indices = [count // 2]
    elif selected_count == count:
        indices = list(range(count))
    else:
        indices = [
            round(index * (count - 1) / (selected_count - 1))
            for index in range(selected_count)
        ]
    if len(indices) != len(set(indices)):
        raise AssertionError("even chapter selection produced duplicate indices")
    selected: list[SelectedChapter] = []
    for segment_index, chapter_index in enumerate(indices):
        start = (segment_index * count) // selected_count
        end = ((segment_index + 1) * count) // selected_count
        selected.append(
            SelectedChapter(
                work,
                chapters[chapter_index],
                segment_index,
                start,
                end,
            )
        )
    return selected


def _same_page_identity(value: Any, source_path: Path) -> bool:
    text = _string(value)
    if not text:
        return False
    candidate = Path(text).expanduser()
    try:
        if candidate.resolve() == source_path.resolve():
            return True
    except OSError:
        pass
    return candidate.name == source_path.name


def _ocr_metadata_categories(hint: Mapping[str, Any]) -> set[str]:
    reasons_value = hint.get("reviewReasons")
    reasons = (
        {_string(reason) for reason in reasons_value if _string(reason)}
        if isinstance(reasons_value, list)
        else set()
    )
    categories: set[str] = set()
    if reasons & HARD_OCR_REASONS:
        categories.add("ocr_hard")
    if _soundish(hint.get("rolePrior")):
        categories.add("ocr_sound_prior")
    if _string(hint.get("containerType")).lower() in {
        "free",
        "none",
        "outside_bubble",
        "text_free",
        "unattached",
    }:
        categories.add("ocr_free_container")
    anime_id = _identifier(hint.get("animeTextRegionId"))
    anime_score = _finite_float(hint.get("animeTextRegionScore"))
    if anime_id and (anime_score is None or anime_score >= 0.25):
        categories.add("ocr_anime_region")
    return categories


def _strict_ocr_bbox(
    hint: Mapping[str, Any],
    width: int,
    height: int,
) -> tuple[float, float, float, float] | None:
    values = tuple(_finite_float(hint.get(key)) for key in ("x1", "y1", "x2", "y2"))
    if any(value is None for value in values):
        raw_bbox = hint.get("bbox")
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
    left, right = min(x1, x2), max(x1, x2)
    top, bottom = min(y1, y2), max(y1, y2)
    if (
        left < 0
        or top < 0
        or right > width
        or bottom > height
        or right <= left
        or bottom <= top
    ):
        return None
    return left, top, right, bottom


def _load_ocr_hints(
    chapter: ChapterRecord,
    page: PageRecord,
    *,
    actual_width: int,
    actual_height: int,
) -> tuple[
    tuple[Mapping[str, Any], ...],
    str | None,
    dict[str, Any],
    dict[str, int],
]:
    path = chapter.directory / "ocr-hints" / page.id / "result.json"
    if not path.exists():
        return (
            (),
            None,
            {
                "state": "missing",
                "payload_size_px": None,
                "coordinate_basis": None,
                "scale_xy": None,
            },
            {},
        )
    if not path.is_file() or not _is_within(chapter.directory, path):
        return (
            (),
            None,
            {
                "state": "skipped",
                "payload_size_px": None,
                "coordinate_basis": None,
                "scale_xy": None,
            },
            {"ocr_unsafe_path": 1},
        )
    raw_bytes = path.read_bytes()
    hints_sha256 = _sha256_bytes(raw_bytes)
    try:
        payload = json.loads(raw_bytes.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return (
            (),
            hints_sha256,
            {
                "state": "skipped",
                "payload_size_px": None,
                "coordinate_basis": None,
                "scale_xy": None,
            },
            {"ocr_invalid_json": 1},
        )
    if not isinstance(payload, dict) or not isinstance(payload.get("hints"), list):
        return (
            (),
            hints_sha256,
            {
                "state": "skipped",
                "payload_size_px": None,
                "coordinate_basis": None,
                "scale_xy": None,
            },
            {"ocr_invalid_payload": 1},
        )
    raw_hints = [item for item in payload["hints"] if isinstance(item, dict)]
    skip_reasons: Counter[str] = Counter()
    invalid_items = len(payload["hints"]) - len(raw_hints)
    if invalid_items:
        skip_reasons["ocr_invalid_item"] += invalid_items
    eligible_count = sum(bool(_ocr_metadata_categories(item)) for item in raw_hints)
    if not _same_page_identity(payload.get("imagePath"), page.source_path):
        if eligible_count:
            skip_reasons["ocr_image_identity_mismatch"] += eligible_count
        return (
            (),
            hints_sha256,
            {
                "state": "skipped",
                "payload_size_px": [
                    _declared_dimension(payload.get("width")),
                    _declared_dimension(payload.get("height")),
                ],
                "coordinate_basis": None,
                "scale_xy": None,
            },
            dict(sorted(skip_reasons.items())),
        )

    ocr_width = _positive_int(payload.get("width"))
    ocr_height = _positive_int(payload.get("height"))
    if ocr_width is None or ocr_height is None:
        if eligible_count:
            skip_reasons["ocr_invalid_dimensions"] += eligible_count
        return (
            (),
            hints_sha256,
            {
                "state": "skipped",
                "payload_size_px": [
                    _declared_dimension(payload.get("width")),
                    _declared_dimension(payload.get("height")),
                ],
                "coordinate_basis": None,
                "scale_xy": None,
            },
            dict(sorted(skip_reasons.items())),
        )

    actual_size = (actual_width, actual_height)
    declared_size = (page.width, page.height)
    payload_size = (ocr_width, ocr_height)
    if payload_size == actual_size:
        coordinate_basis = "actual_pixels"
    elif (
        page.width is not None
        and page.width > 0
        and page.height is not None
        and page.height > 0
        and payload_size == declared_size
    ):
        coordinate_basis = "declared_pixels_scaled_to_actual"
    else:
        payload_aspect = ocr_width / ocr_height
        actual_aspect = actual_width / actual_height
        relative_aspect_error = abs(payload_aspect / actual_aspect - 1.0)
        if relative_aspect_error > 0.02:
            if eligible_count:
                skip_reasons["ocr_dimension_basis_ambiguous"] += eligible_count
            return (
                (),
                hints_sha256,
                {
                    "state": "skipped",
                    "payload_size_px": list(payload_size),
                    "coordinate_basis": None,
                    "scale_xy": None,
                    "relative_aspect_error": round(relative_aspect_error, 8),
                },
                dict(sorted(skip_reasons.items())),
            )
        coordinate_basis = "payload_pixels_scaled_to_actual"

    scale_x = actual_width / ocr_width
    scale_y = actual_height / ocr_height
    transformed: list[Mapping[str, Any]] = []
    for hint in raw_hints:
        if not _ocr_metadata_categories(hint):
            continue
        original_bbox = _strict_ocr_bbox(hint, ocr_width, ocr_height)
        if original_bbox is None:
            skip_reasons["ocr_candidate_bbox_out_of_bounds"] += 1
            continue
        transformed_bbox = _clamped_bbox(
            (
                original_bbox[0] * scale_x,
                original_bbox[1] * scale_y,
                original_bbox[2] * scale_x,
                original_bbox[3] * scale_y,
            ),
            actual_width,
            actual_height,
        )
        if transformed_bbox is None:
            skip_reasons["ocr_candidate_bbox_transform_empty"] += 1
            continue
        transformed.append(
            {
                **hint,
                "x1": transformed_bbox[0],
                "y1": transformed_bbox[1],
                "x2": transformed_bbox[2],
                "y2": transformed_bbox[3],
                "_fontclip_ocr_coordinate_provenance": {
                    "basis": coordinate_basis,
                    "payload_size_px": list(payload_size),
                    "actual_size_px": list(actual_size),
                    "scale_xy": [round(scale_x, 10), round(scale_y, 10)],
                    "original_bbox_px": [round(value, 6) for value in original_bbox],
                },
            }
        )
    return (
        tuple(transformed),
        hints_sha256,
        {
            "state": "loaded",
            "payload_size_px": list(payload_size),
            "coordinate_basis": coordinate_basis,
            "scale_xy": [round(scale_x, 10), round(scale_y, 10)],
            "eligible_metadata_hints": eligible_count,
            "usable_metadata_hints": len(transformed),
        },
        dict(sorted(skip_reasons.items())),
    )


def freeze_selected_pages(
    selections: Sequence[SelectedChapter],
) -> list[FrozenPage]:
    """Sign source pages and OCR metadata before inference begins."""

    frozen: list[FrozenPage] = []
    for selection in selections:
        for page in selection.chapter.pages:
            source_bytes = page.source_path.read_bytes()
            source_sha256 = _sha256_bytes(source_bytes)
            try:
                with Image.open(io.BytesIO(source_bytes)) as opened:
                    image = _rgb_image(ImageOps.exif_transpose(opened))
            except (OSError, ValueError) as exc:
                raise LibraryValidationError(
                    f"cannot decode source page: {page.source_path}"
                ) from exc
            actual_width, actual_height = image.size
            if actual_width <= 0 or actual_height <= 0:
                raise LibraryValidationError(
                    f"source page has non-positive dimensions: {page.source_path}"
                )
            source_dimension_mismatch = (
                page.width != actual_width or page.height != actual_height
            )
            (
                hints,
                hints_sha,
                ocr_coordinate_provenance,
                ocr_metadata_skip_reasons,
            ) = _load_ocr_hints(
                selection.chapter,
                page,
                actual_width=actual_width,
                actual_height=actual_height,
            )
            frozen.append(
                FrozenPage(
                    selection=selection,
                    page=page,
                    source_sha256=source_sha256,
                    source_size_bytes=len(source_bytes),
                    actual_width=actual_width,
                    actual_height=actual_height,
                    source_dimension_mismatch=source_dimension_mismatch,
                    ocr_hints=hints,
                    ocr_hints_sha256=hints_sha,
                    ocr_coordinate_provenance=ocr_coordinate_provenance,
                    ocr_metadata_skip_reasons=ocr_metadata_skip_reasons,
                )
            )
    return frozen


def normalize_bbox(
    value: Mapping[str, Any],
    width: int,
    height: int,
    coordinate_space: str = "pixels",
) -> BBox | None:
    values = tuple(_finite_float(value.get(key)) for key in ("x1", "y1", "x2", "y2"))
    if any(item is None for item in values):
        bbox = value.get("bbox")
        if isinstance(bbox, dict):
            x = _finite_float(bbox.get("x"))
            y = _finite_float(bbox.get("y"))
            w = _finite_float(bbox.get("w"))
            h = _finite_float(bbox.get("h"))
            if None not in (x, y, w, h):
                values = (x, y, x + w, y + h)
    if any(item is None for item in values):
        return None
    x1, y1, x2, y2 = (float(item) for item in values)
    space = coordinate_space.strip().lower()
    if space in {"normalized", "normalized_1", "unit"}:
        x1, x2 = x1 * width, x2 * width
        y1, y2 = y1 * height, y2 * height
    elif space in {"normalized_1000", "1000"}:
        x1, x2 = x1 * width / 1000.0, x2 * width / 1000.0
        y1, y2 = y1 * height / 1000.0, y2 * height / 1000.0
    elif space not in {"pixels", "pixel", "px"}:
        return None
    return _clamped_bbox((x1, y1, x2, y2), width, height)


def _clamped_bbox(values: Sequence[Any], width: int, height: int) -> BBox | None:
    if len(values) != 4:
        return None
    numbers = tuple(_finite_float(value) for value in values)
    if any(value is None for value in numbers):
        return None
    x1, y1, x2, y2 = (float(value) for value in numbers)
    left = max(0, math.floor(min(x1, x2)))
    top = max(0, math.floor(min(y1, y2)))
    right = min(width, math.ceil(max(x1, x2)))
    bottom = min(height, math.ceil(max(y1, y2)))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def bbox_area(bbox: BBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def bbox_intersection(left: BBox, right: BBox) -> int:
    width = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    return width * height


def bbox_iou(left: BBox, right: BBox) -> float:
    intersection = bbox_intersection(left, right)
    union = bbox_area(left) + bbox_area(right) - intersection
    return intersection / union if union > 0 else 0.0


def bbox_containment(inner: BBox, outer: BBox) -> float:
    area = bbox_area(inner)
    return bbox_intersection(inner, outer) / area if area > 0 else 0.0


def bbox_distance(left: BBox, right: BBox) -> float:
    dx = max(left[0] - right[2], right[0] - left[2], 0)
    dy = max(left[1] - right[3], right[1] - left[3], 0)
    return math.hypot(dx, dy)


def _edge_distance(text: BBox, bubble: BBox) -> float:
    return min(
        abs(text[0] - bubble[0]),
        abs(text[1] - bubble[1]),
        abs(text[2] - bubble[2]),
        abs(text[3] - bubble[3]),
    )


def nms_detections(
    detections: Sequence[Detection],
    iou_threshold: float,
) -> list[Detection]:
    kept: list[Detection] = []
    for detection in sorted(
        detections,
        key=lambda item: (
            -item.score,
            MODEL_LABELS.index(item.label),
            item.bbox,
        ),
    ):
        if any(
            current.label == detection.label
            and bbox_iou(current.bbox, detection.bbox) >= iou_threshold
            for current in kept
        ):
            continue
        kept.append(detection)
    return kept


def classify_layout_candidates(
    detections: Sequence[Detection],
    page_width: int,
    page_height: int,
    *,
    bubble_edge_ratio: float,
    near_bubble_ratio: float,
) -> list[Candidate]:
    bubbles = [item for item in detections if item.label == "bubble"]
    page_diagonal = math.hypot(page_width, page_height)
    near_threshold = near_bubble_ratio * page_diagonal
    candidates: list[Candidate] = []
    for detection in detections:
        if detection.label == "text_free":
            categories = {"text_free"}
            nearest = min(
                (bbox_distance(detection.bbox, bubble.bbox) for bubble in bubbles),
                default=math.inf,
            )
            if nearest <= near_threshold:
                categories.add("free_near_bubble")
            candidates.append(
                Candidate(
                    detection.bbox,
                    detection.score,
                    categories,
                    [
                        {
                            "kind": "layout_detection",
                            "label": detection.label,
                            "score": round(detection.score, 8),
                            "bbox_px": list(detection.bbox),
                            "nearest_bubble_distance_px": (
                                round(nearest, 4) if math.isfinite(nearest) else None
                            ),
                        }
                    ],
                    {f"detector:{detection.label}:{detection.bbox}"},
                )
            )
            continue
        if detection.label != "text_bubble":
            continue
        associations = [
            (
                bbox_containment(detection.bbox, bubble.bbox),
                bubble.score,
                bubble,
            )
            for bubble in bubbles
        ]
        if not associations:
            continue
        containment, _, bubble = max(
            associations,
            key=lambda item: (item[0], item[1], item[2].bbox),
        )
        bubble_short = min(
            bubble.bbox[2] - bubble.bbox[0],
            bubble.bbox[3] - bubble.bbox[1],
        )
        edge_threshold = max(1.0, bubble_short * bubble_edge_ratio)
        edge_distance = _edge_distance(detection.bbox, bubble.bbox)
        if containment <= 0.0 or edge_distance > edge_threshold:
            continue
        candidates.append(
            Candidate(
                detection.bbox,
                detection.score,
                {"bubble_edge"},
                [
                    {
                        "kind": "layout_detection",
                        "label": detection.label,
                        "score": round(detection.score, 8),
                        "bbox_px": list(detection.bbox),
                        "bubble_bbox_px": list(bubble.bbox),
                        "bubble_score": round(bubble.score, 8),
                        "bubble_text_containment": round(containment, 8),
                        "bubble_edge_distance_px": round(edge_distance, 4),
                    }
                ],
                {f"detector:{detection.label}:{detection.bbox}"},
            )
        )
    return candidates


def _metadata_text(value: Any) -> str:
    text = _string(value)
    return " ".join(text.split())[:256]


def _normalized_sound_role(value: Any) -> str:
    return re.sub(r"[\s-]+", "_", _string(value).lower())


def page_sound_candidates(
    page: PageRecord,
    page_width: int,
    page_height: int,
) -> list[Candidate]:
    candidates: list[Candidate] = []
    for index, block in enumerate(page.blocks):
        original_fields = {
            "textRole": _string(block.get("textRole")),
            "type": _string(block.get("type")),
            "role": _string(block.get("role")),
        }
        matched_fields = sorted(
            key
            for key, value in original_fields.items()
            if _normalized_sound_role(value)
            in {"sound", "sfx", "sound_effect", "onomatopoeia"}
        )
        if not matched_fields:
            continue
        bbox = normalize_bbox(
            block,
            page_width,
            page_height,
            _string(block.get("bboxSpace")) or "normalized_1000",
        )
        if bbox is None:
            continue
        score = _finite_float(block.get("confidence"))
        if score is None or not 0 <= score <= 1:
            score = 1.0
        block_id = _string(block.get("id")) or str(index)
        candidates.append(
            Candidate(
                bbox,
                score,
                {"page_sound"},
                [
                    {
                        "kind": "page_block",
                        "id": block_id,
                        "text_role": original_fields["textRole"] or None,
                        "type": original_fields["type"] or None,
                        "role": original_fields["role"] or None,
                        "sound_match_fields": matched_fields,
                        "confidence": round(score, 8),
                        "bbox_px": list(bbox),
                    }
                ],
                {f"block:{block_id}"},
                _metadata_text(block.get("sourceText")),
            )
        )
    return candidates


def _soundish(value: Any) -> bool:
    text = _string(value).lower().replace("-", "_")
    return any(token in text for token in ("sound", "sfx", "onomatop"))


def ocr_metadata_candidates(
    page: PageRecord,
    hints: Sequence[Mapping[str, Any]],
    page_width: int,
    page_height: int,
) -> list[Candidate]:
    candidates: list[Candidate] = []
    for index, hint in enumerate(hints):
        bbox = normalize_bbox(hint, page_width, page_height, "pixels")
        if bbox is None:
            continue
        reasons_value = hint.get("reviewReasons")
        reasons = (
            {_string(reason) for reason in reasons_value if _string(reason)}
            if isinstance(reasons_value, list)
            else set()
        )
        categories = _ocr_metadata_categories(hint)
        hard_reasons = sorted(reasons & HARD_OCR_REASONS)
        role_prior = _string(hint.get("rolePrior"))
        container_type = _string(hint.get("containerType")).lower()
        anime_id = _identifier(hint.get("animeTextRegionId"))
        anime_score = _finite_float(hint.get("animeTextRegionScore"))
        if not categories:
            continue
        score = _finite_float(hint.get("score"))
        if score is None or not 0 <= score <= 1:
            score = 0.0
        hint_id = _identifier(hint.get("id")) or str(index)
        candidates.append(
            Candidate(
                bbox,
                score,
                categories,
                [
                    {
                        "kind": "ocr_hint",
                        "id": hint_id,
                        "score": round(score, 8),
                        "review_status": _string(hint.get("reviewStatus")) or None,
                        "review_reasons": sorted(reasons),
                        "hard_review_reasons": hard_reasons,
                        "role_prior": role_prior or None,
                        "container_type": container_type or None,
                        "anime_text_region_id": anime_id or None,
                        "anime_text_region_score": anime_score,
                        "group_id": _string(hint.get("groupId")) or None,
                        "review_fragment_id": (
                            _string(hint.get("reviewFragmentId")) or None
                        ),
                        "coordinate_provenance": hint.get(
                            "_fontclip_ocr_coordinate_provenance"
                        ),
                        "bbox_px": list(bbox),
                    }
                ],
                {f"ocr:{hint_id}"},
                _metadata_text(hint.get("ocrText")),
            )
        )
    return candidates


def _candidate_sort_key(candidate: Candidate) -> tuple[Any, ...]:
    priority = min(
        (CATEGORY_PRIORITY.get(value, 999) for value in candidate.categories),
        default=999,
    )
    return (
        -candidate.score,
        priority,
        candidate.bbox,
        tuple(sorted(candidate.source_ids)),
    )


def deduplicate_candidates(
    candidates: Sequence[Candidate],
    iou_threshold: float,
) -> list[Candidate]:
    """Class-agnostic page NMS that preserves all merged category evidence."""

    kept: list[Candidate] = []
    for candidate in sorted(candidates, key=_candidate_sort_key):
        matches = [
            (bbox_iou(candidate.bbox, current.bbox), index)
            for index, current in enumerate(kept)
        ]
        overlap, match_index = max(matches, default=(0.0, -1))
        if overlap < iou_threshold:
            kept.append(candidate)
            continue
        current = kept[match_index]
        current.categories.update(candidate.categories)
        current.source_ids.update(candidate.source_ids)
        current.evidence.extend(candidate.evidence)
        current.score = max(current.score, candidate.score)
        if not current.text and candidate.text:
            current.text = candidate.text
    for candidate in kept:
        candidate.evidence.sort(
            key=lambda item: (
                _string(item.get("kind")),
                _string(item.get("id")),
                _canonical_json(item),
            )
        )
    return sorted(kept, key=_candidate_sort_key)


def build_page_candidates(
    detections: Sequence[Detection],
    page: FrozenPage,
    config: MiningConfig,
) -> list[Candidate]:
    clean_detections = nms_detections(
        detections,
        config.detector_nms_iou,
    )
    candidates = classify_layout_candidates(
        clean_detections,
        page.actual_width,
        page.actual_height,
        bubble_edge_ratio=config.bubble_edge_ratio,
        near_bubble_ratio=config.near_bubble_ratio,
    )
    candidates.extend(
        page_sound_candidates(
            page.page,
            page.actual_width,
            page.actual_height,
        )
    )
    candidates.extend(
        ocr_metadata_candidates(
            page.page,
            page.ocr_hints,
            page.actual_width,
            page.actual_height,
        )
    )
    return deduplicate_candidates(candidates, config.dedup_iou)


def adaptive_crop_bbox(
    bbox: BBox,
    image_width: int,
    image_height: int,
    *,
    ratio: float,
    minimum: int,
    maximum: int,
) -> BBox:
    short_side = min(bbox[2] - bbox[0], bbox[3] - bbox[1])
    padding = max(minimum, min(maximum, round(short_side * ratio)))
    return (
        max(0, bbox[0] - padding),
        max(0, bbox[1] - padding),
        min(image_width, bbox[2] + padding),
        min(image_height, bbox[3] + padding),
    )


def _rgb_image(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image.copy()
    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def letterbox_image(
    image: Image.Image,
    size: int = LETTERBOX_SIZE,
) -> Image.Image:
    width, height = image.size
    scale = min(size / width, size / height)
    resized_size = (
        max(1, round(width * scale)),
        max(1, round(height * scale)),
    )
    resized = image.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    return canvas


def crop_pixel_sha256(image: Image.Image) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(f"{image.width}x{image.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def _sample_id(
    page: FrozenPage,
    candidate: Candidate,
    crop_bbox: BBox,
    crop_sha256: str,
) -> str:
    identity = {
        "work_id": page.work.id,
        "chapter_id": page.chapter.id,
        "page_id": page.page.id,
        "provenance": "real_mined",
        "categories": sorted(candidate.categories),
        "bbox_px": list(candidate.bbox),
        "crop_bbox_px": list(crop_bbox),
        "crop_sha256": crop_sha256,
    }
    return "fhc_" + _sha256_json(identity)[:24]


def _relative_source(path: Path, library_root: Path) -> str:
    try:
        return path.resolve().relative_to(library_root.resolve()).as_posix()
    except ValueError as exc:
        raise LibraryValidationError(
            f"source page escaped library root: {path}"
        ) from exc


def _normalize_relative_path(value: Any) -> str:
    text = _string(value).replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text


def _record_bbox(record: Mapping[str, Any]) -> BBox | None:
    for key in ("bbox_px", "crop_bbox_px"):
        value = record.get(key)
        if (
            isinstance(value, list)
            and len(value) == 4
            and all(isinstance(item, int) for item in value)
        ):
            left, top, right, bottom = value
            if left >= 0 and top >= 0 and right > left and bottom > top:
                return left, top, right, bottom
    return None


def load_accepted_index(
    manifest_path: Path | None,
) -> tuple[AcceptedBoxIndex, dict[str, Any]]:
    index = AcceptedBoxIndex()
    if manifest_path is None:
        return index, {"state": "disabled", "path": None, "sha256": None, "rows": 0}
    path = manifest_path.resolve()
    if not path.is_file():
        return index, {
            "state": "missing",
            "path": str(path),
            "sha256": None,
            "rows": 0,
        }
    rows = _read_jsonl(path)
    for row in rows:
        index.add(row)
    return index, {
        "state": "loaded",
        "path": str(path),
        "sha256": _sha256_file(path),
        "rows": len(rows),
    }


def assign_work_splits(
    work_ids: Sequence[str],
    *,
    seed: int,
    ratios: Sequence[float],
) -> dict[str, str]:
    if (
        len(ratios) != 3
        or any(value < 0 for value in ratios)
        or not math.isclose(sum(ratios), 1.0, abs_tol=1e-9)
    ):
        raise ValueError("split ratios must contain train,val,test and sum to 1")
    names = ("train", "val", "test")
    ordered = sorted(set(work_ids))
    random.Random(seed).shuffle(ordered)
    raw = [len(ordered) * value for value in ratios]
    counts = [math.floor(value) for value in raw]
    for index in sorted(
        range(3),
        key=lambda item: (raw[item] - counts[item], ratios[item], -item),
        reverse=True,
    )[: len(ordered) - sum(counts)]:
        counts[index] += 1
    result: dict[str, str] = {}
    cursor = 0
    for name, count in zip(names, counts):
        for work_id in ordered[cursor : cursor + count]:
            result[work_id] = name
        cursor += count
    return result


def apply_balance_weights(records: Sequence[dict[str, Any]]) -> None:
    if not records:
        return
    work_counts = Counter(str(record["work_id"]) for record in records)
    chapter_counts = Counter(
        (str(record["work_id"]), str(record["chapter_id"])) for record in records
    )
    total = len(records)
    for record in records:
        work_id = str(record["work_id"])
        chapter_key = (work_id, str(record["chapter_id"]))
        record["work_balance_weight"] = round(
            total / (len(work_counts) * work_counts[work_id]),
            8,
        )
        record["chapter_balance_weight"] = round(
            total / (len(chapter_counts) * chapter_counts[chapter_key]),
            8,
        )


def validate_output_path(
    output_root: Path,
    *,
    library_root: Path,
    repo_root: Path,
) -> Path:
    output = output_root.resolve()
    library = library_root.resolve()
    repository = repo_root.resolve()
    dangerous = {
        Path(output.anchor).resolve(),
        Path.home().resolve(),
        Path.cwd().resolve(),
        library,
        repository,
    }
    if (
        output in dangerous
        or _is_within(library, output)
        or _is_within(output, library)
    ):
        raise UnsafeOutputError(f"unsafe output path: {output}")
    return output


def _load_marker(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise UnsafeOutputError(f"cannot verify ownership marker: {path}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("tool") != TOOL_ID
        or payload.get("schema_version") != SCHEMA_VERSION
    ):
        raise UnsafeOutputError(f"unrecognized ownership marker: {path}")
    return payload


def _validate_marker(
    marker: Mapping[str, Any],
    *,
    output_root: Path,
) -> None:
    if (
        marker.get("output_root") != str(output_root)
        or marker.get("owned_outputs") != list(OWNED_OUTPUTS)
        or not isinstance(marker.get("signature"), dict)
        or not isinstance(marker.get("signature_sha256"), str)
        or marker.get("signature_sha256") != _sha256_json(marker.get("signature"))
    ):
        raise UnsafeOutputError("ownership marker does not match this output")


def _remove_owned(path: Path, output_root: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.resolve() == output_root or not _is_within(output_root, path):
        raise UnsafeOutputError(f"refusing to remove unsafe path: {path}")
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def prepare_output(
    output_root: Path,
    *,
    signature: Mapping[str, Any],
    overwrite: bool,
    dry_run: bool,
) -> bool:
    """Create or validate ownership; return whether this is an exact resume."""

    marker_path = output_root / MARKER_NAME
    marker = _load_marker(marker_path)
    if marker is not None:
        _validate_marker(marker, output_root=output_root)
    existing = list(output_root.iterdir()) if output_root.is_dir() else []

    if overwrite:
        if existing and marker is None:
            raise UnsafeOutputError(
                f"refusing overwrite without exact ownership marker: {marker_path}"
            )
        if dry_run:
            return False
        if marker is not None:
            for relative in OWNED_OUTPUTS:
                _remove_owned(output_root / relative, output_root)
            marker_path.unlink(missing_ok=True)
        marker = None
    elif marker is None and existing:
        raise UnsafeOutputError(
            f"output is not empty and has no ownership marker: {output_root}"
        )
    elif marker is not None and marker.get("signature") != dict(signature):
        raise ResumeValidationError(
            "run inputs changed since the existing checkpoint; "
            "pass --overwrite for a guarded rebuild"
        )

    resumed = marker is not None
    if dry_run:
        return resumed
    output_root.mkdir(parents=True, exist_ok=True)
    if marker is None:
        marker_payload = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "created_at": _utc_now(),
            "output_root": str(output_root),
            "owned_outputs": list(OWNED_OUTPUTS),
            "signature": dict(signature),
            "signature_sha256": _sha256_json(signature),
        }
        _atomic_write_json(marker_path, marker_payload)
    (output_root / STATE_DIR_NAME).mkdir(parents=True, exist_ok=True)
    return resumed


def _page_key(page: FrozenPage) -> str:
    identity = "\0".join((page.work.id, page.chapter.id, page.page.id))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]


def _page_signature(
    page: FrozenPage,
    *,
    model_sha256: str,
    run_signature_sha256: str,
) -> dict[str, Any]:
    payload = {
        "work_id": page.work.id,
        "work_manifest_sha256": page.work.manifest_sha256,
        "chapter_id": page.chapter.id,
        "chapter_manifest_sha256": page.chapter.manifest_sha256,
        "page_id": page.page.id,
        "source_page_sha256": page.source_sha256,
        "source_size_bytes": page.source_size_bytes,
        "declared_page_size_px": [page.page.width, page.page.height],
        "actual_page_size_px": [page.actual_width, page.actual_height],
        "source_dimension_mismatch": page.source_dimension_mismatch,
        "ocr_hints_sha256": page.ocr_hints_sha256,
        "ocr_coordinate_provenance": dict(page.ocr_coordinate_provenance),
        "ocr_metadata_skip_reasons": dict(page.ocr_metadata_skip_reasons),
        "model_sha256": model_sha256,
        "run_signature_sha256": run_signature_sha256,
    }
    return {
        **payload,
        "signature_sha256": _sha256_json(payload),
    }


def _load_page_checkpoint(
    path: Path,
    *,
    expected_signature: Mapping[str, Any],
    output_root: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    if not path.exists():
        return None
    if not path.is_file() or not _is_within(output_root, path):
        raise ResumeValidationError(f"unsafe page checkpoint: {path}")
    try:
        payload = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ResumeValidationError(f"invalid page checkpoint: {path}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("tool") != TOOL_ID
        or payload.get("schema_version") != SCHEMA_VERSION
        or payload.get("page_signature") != dict(expected_signature)
        or not isinstance(payload.get("records"), list)
        or any(not isinstance(row, dict) for row in payload["records"])
        or not isinstance(payload.get("report"), dict)
    ):
        raise ResumeValidationError(f"page checkpoint signature mismatch: {path}")
    signed_payload = {
        "page_signature": payload["page_signature"],
        "records": payload["records"],
        "report": payload["report"],
    }
    if payload.get("checkpoint_sha256") != _sha256_json(signed_payload):
        raise ResumeValidationError(f"page checkpoint content mismatch: {path}")
    for record in payload["records"]:
        asset_hashes = record.get("asset_file_sha256")
        if not isinstance(asset_hashes, dict):
            raise ResumeValidationError(f"checkpoint asset hashes are missing: {path}")
        for key in ("image_path", "clip_image_path"):
            relative = _normalize_relative_path(record.get(key))
            expected_hash = asset_hashes.get(key)
            candidate = (output_root / relative).resolve()
            if (
                not relative
                or not isinstance(expected_hash, str)
                or not _is_within(output_root, candidate)
                or not candidate.is_file()
                or _sha256_file(candidate) != expected_hash
            ):
                raise ResumeValidationError(
                    f"checkpoint asset mismatch for {key}: {candidate}"
                )
    return list(payload["records"]), dict(payload["report"])


def _primary_category(categories: Iterable[str]) -> str:
    values = sorted(
        set(categories),
        key=lambda value: (CATEGORY_PRIORITY.get(value, 999), value),
    )
    return values[0] if values else "unknown"


def _orientation(bbox: BBox) -> str:
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    return "vertical" if height > width * 1.15 else "horizontal"


def process_page(
    page: FrozenPage,
    *,
    detector: PageDetector,
    config: MiningConfig,
    accepted_index: AcceptedBoxIndex,
    library_root: Path,
    output_root: Path,
    split: str,
    model_sha256: str,
    run_signature_sha256: str,
    seen_crop_hashes: set[str],
    dry_run: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    signature = _page_signature(
        page,
        model_sha256=model_sha256,
        run_signature_sha256=run_signature_sha256,
    )
    state_path = output_root / STATE_DIR_NAME / f"{_page_key(page)}.json"
    if not dry_run:
        checkpoint = _load_page_checkpoint(
            state_path,
            expected_signature=signature,
            output_root=output_root,
        )
        if checkpoint is not None:
            records, report = checkpoint
            for record in records:
                crop_hash = _string(record.get("crop_sha256"))
                if not crop_hash or crop_hash in seen_crop_hashes:
                    raise ResumeValidationError(
                        f"checkpoint crop inventory conflict: {state_path}"
                    )
                seen_crop_hashes.add(crop_hash)
            return records, {**report, "resumed": True}

    source_bytes = page.page.source_path.read_bytes()
    if _sha256_bytes(source_bytes) != page.source_sha256:
        raise ResumeValidationError(
            f"source page changed after inventory freeze: {page.page.source_path}"
        )
    try:
        with Image.open(io.BytesIO(source_bytes)) as opened:
            image = _rgb_image(ImageOps.exif_transpose(opened))
    except (OSError, ValueError) as exc:
        raise LibraryValidationError(
            f"cannot decode source page: {page.page.source_path}"
        ) from exc
    if image.size != (page.actual_width, page.actual_height):
        raise ResumeValidationError(
            f"source page dimensions changed: {page.page.source_path}"
        )

    inference_before = detector.inference_count
    detections = detector.detect(image)
    if detector.inference_count != inference_before + 1:
        raise HardCandidateError(
            "detector must perform exactly one inference for each new page"
        )
    candidates = build_page_candidates(detections, page, config)
    records: list[dict[str, Any]] = []
    exclusions: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()
    source_relative = _relative_source(page.page.source_path, library_root)
    for candidate in candidates:
        accepted = accepted_index.high_iou_match(
            page,
            candidate.bbox,
            config.accepted_iou,
            library_root,
        )
        if accepted is not None:
            exclusions["accepted_manifest_iou"] += 1
            continue
        crop_bbox = adaptive_crop_bbox(
            candidate.bbox,
            image.width,
            image.height,
            ratio=config.crop_padding_ratio,
            minimum=config.crop_padding_min,
            maximum=config.crop_padding_max,
        )
        crop = image.crop(crop_bbox)
        crop_sha = crop_pixel_sha256(crop)
        if crop_sha in seen_crop_hashes:
            exclusions["global_crop_sha256"] += 1
            continue
        seen_crop_hashes.add(crop_sha)
        sample_id = _sample_id(page, candidate, crop_bbox, crop_sha)
        raw_relative = f"images/raw/{split}/{sample_id}.png"
        clip_relative = f"images/clip_{LETTERBOX_SIZE}/{split}/{sample_id}.png"
        raw_path = output_root / raw_relative
        clip_path = output_root / clip_relative
        if not dry_run:
            _atomic_save_png(raw_path, crop)
            _atomic_save_png(clip_path, letterbox_image(crop))
            asset_hashes = {
                "image_path": _sha256_file(raw_path),
                "clip_image_path": _sha256_file(clip_path),
            }
        else:
            raw_buffer = io.BytesIO()
            clip_buffer = io.BytesIO()
            crop.save(raw_buffer, format="PNG", optimize=False)
            letterbox_image(crop).save(
                clip_buffer,
                format="PNG",
                optimize=False,
            )
            asset_hashes = {
                "image_path": _sha256_bytes(raw_buffer.getvalue()),
                "clip_image_path": _sha256_bytes(clip_buffer.getvalue()),
            }
        categories = sorted(
            candidate.categories,
            key=lambda value: (CATEGORY_PRIORITY.get(value, 999), value),
        )
        category_counts.update(categories)
        record = {
            "schema_version": SCHEMA_VERSION,
            "id": sample_id,
            "image_path": raw_relative,
            "clip_image_path": clip_relative,
            "asset_file_sha256": asset_hashes,
            "source_image_path": source_relative,
            "source_page_sha256": page.source_sha256,
            "source_page_content_signature": {
                "sha256": page.source_sha256,
                "size": page.source_size_bytes,
                "width": page.actual_width,
                "height": page.actual_height,
            },
            "work_id": page.work.id,
            "work_title": page.work.title,
            "chapter_id": page.chapter.id,
            "chapter_title": page.chapter.title,
            "page_id": page.page.id,
            "page_name": page.page.name,
            "page_size_px": [page.actual_width, page.actual_height],
            "declared_page_size_px": [page.page.width, page.page.height],
            "source_dimension_mismatch": page.source_dimension_mismatch,
            "split": split,
            "tier": "hard_candidate",
            "provenance": "real_mined",
            "primary_category": _primary_category(categories),
            "categories": categories,
            "candidate_score": round(candidate.score, 8),
            "candidate_evidence": candidate.evidence,
            "candidate_source_ids": sorted(candidate.source_ids),
            "bbox_px": list(candidate.bbox),
            "crop_bbox_px": list(crop_bbox),
            "crop_size_px": [crop.width, crop.height],
            "crop_sha256": crop_sha,
            "orientation": _orientation(candidate.bbox),
            "ocr_text": candidate.text or None,
            "ocr_hints_sha256": page.ocr_hints_sha256,
            "ocr_coordinate_provenance": dict(page.ocr_coordinate_provenance),
            "ocr_metadata_skip_reasons": dict(page.ocr_metadata_skip_reasons),
            "detector_model": {
                "name": "comic-text-and-bubble-detector/detector-v4-s_int8",
                "sha256": model_sha256,
                "labels": list(MODEL_LABELS),
            },
            "selection_segment_index": page.selection.segment_index,
            "label": None,
        }
        records.append(record)
    records.sort(
        key=lambda record: (
            record["bbox_px"],
            record["primary_category"],
            record["id"],
        )
    )
    report = {
        "work_id": page.work.id,
        "chapter_id": page.chapter.id,
        "page_id": page.page.id,
        "page_name": page.page.name,
        "source_page_sha256": page.source_sha256,
        "page_size_px": [page.actual_width, page.actual_height],
        "declared_page_size_px": [page.page.width, page.page.height],
        "source_dimension_mismatch": page.source_dimension_mismatch,
        "ocr_hints_sha256": page.ocr_hints_sha256,
        "ocr_coordinate_provenance": dict(page.ocr_coordinate_provenance),
        "ocr_metadata_skip_reasons": dict(page.ocr_metadata_skip_reasons),
        "detections": len(detections),
        "candidate_groups": len(candidates),
        "written_candidates": len(records),
        "category_memberships": dict(sorted(category_counts.items())),
        "exclusions": dict(sorted(exclusions.items())),
        "resumed": False,
        "inferences": 1,
    }
    if not dry_run:
        checkpoint_payload = {
            "page_signature": signature,
            "records": records,
            "report": report,
        }
        _atomic_write_json(
            state_path,
            {
                "tool": TOOL_ID,
                "schema_version": SCHEMA_VERSION,
                "completed_at": _utc_now(),
                **checkpoint_payload,
                "checkpoint_sha256": _sha256_json(checkpoint_payload),
            },
        )
    return records, report


def _selected_payload(
    selections: Sequence[SelectedChapter],
    splits: Mapping[str, str],
) -> list[dict[str, Any]]:
    return [
        {
            "work_id": item.work.id,
            "work_title": item.work.title,
            "work_manifest_sha256": item.work.manifest_sha256,
            "split": splits[item.work.id],
            "chapter_id": item.chapter.id,
            "chapter_title": item.chapter.title,
            "chapter_manifest_sha256": item.chapter.manifest_sha256,
            "chapter_order_index": item.chapter.order_index,
            "segment_index": item.segment_index,
            "segment_start_inclusive": item.segment_start,
            "segment_end_exclusive": item.segment_end,
            "page_count": len(item.chapter.pages),
        }
        for item in selections
    ]


def _frozen_inventory_payload(
    pages: Sequence[FrozenPage],
    library_root: Path,
) -> list[dict[str, Any]]:
    return [
        {
            "work_id": page.work.id,
            "work_manifest_sha256": page.work.manifest_sha256,
            "chapter_id": page.chapter.id,
            "chapter_manifest_sha256": page.chapter.manifest_sha256,
            "page_id": page.page.id,
            "source_image_path": _relative_source(
                page.page.source_path,
                library_root,
            ),
            "source_page_sha256": page.source_sha256,
            "source_size_bytes": page.source_size_bytes,
            "declared_page_size_px": [page.page.width, page.page.height],
            "actual_page_size_px": [page.actual_width, page.actual_height],
            "source_dimension_mismatch": page.source_dimension_mismatch,
            "ocr_hints_sha256": page.ocr_hints_sha256,
            "ocr_coordinate_provenance": dict(page.ocr_coordinate_provenance),
            "ocr_metadata_skip_reasons": dict(page.ocr_metadata_skip_reasons),
        }
        for page in pages
    ]


def parse_split_ratios(value: str) -> tuple[float, float, float]:
    try:
        result = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "ratios must be comma-separated numbers"
        ) from exc
    if (
        len(result) != 3
        or any(part < 0 for part in result)
        or not math.isclose(sum(result), 1.0, abs_tol=1e-9)
    ):
        raise argparse.ArgumentTypeError(
            "ratios must contain train,val,test and sum to 1"
        )
    return result  # type: ignore[return-value]


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--library-root",
        "--library",
        type=Path,
        default=repo_root / "library",
    )
    parser.add_argument(
        "--output-root",
        "--output",
        type=Path,
        default=repo_root / "datasets" / "fontclip-hard-candidates-v1",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=repo_root
        / "models"
        / "bubble-layout"
        / "comic-text-and-bubble-detector"
        / "detector-v4-s_int8.onnx",
    )
    parser.add_argument(
        "--expected-model-sha256",
        default=EXPECTED_MODEL_SHA256,
        help="required SHA-256 for the pinned detector",
    )
    parser.add_argument(
        "--accepted-manifest",
        type=Path,
        help=(
            "approved manifest used for IoU exclusion "
            "(default: datasets/fontclip-accepted-v1/manifest_masked.jsonl)"
        ),
    )
    parser.add_argument("--no-accepted-dedup", action="store_true")
    parser.add_argument("--accepted-iou-threshold", type=float, default=0.70)
    parser.add_argument("--score-threshold", type=float, default=0.35)
    parser.add_argument("--detector-nms-iou-threshold", type=float, default=0.60)
    parser.add_argument("--dedup-iou-threshold", type=float, default=0.55)
    parser.add_argument("--bubble-edge-ratio", type=float, default=0.18)
    parser.add_argument("--near-bubble-ratio", type=float, default=0.035)
    parser.add_argument("--crop-padding-ratio", type=float, default=0.10)
    parser.add_argument("--crop-padding-min", type=int, default=2)
    parser.add_argument("--crop-padding-max", type=int, default=24)
    parser.add_argument("--max-chapters-per-work", type=int, default=20)
    parser.add_argument("--minimum-candidates", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument(
        "--split-ratios",
        type=parse_split_ratios,
        default=(0.8, 0.1, 0.1),
    )
    parser.add_argument("--limit-works", type=int)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser


def _validate_unit_interval(name: str, value: float) -> None:
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be between 0 and 1")


def _progress(message: str, quiet: bool) -> None:
    if not quiet:
        print(message, flush=True)


def run(
    args: argparse.Namespace,
    *,
    detector_factory: Callable[[Path, float], PageDetector] = ComicLayoutDetector,
) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[1]
    library_root = Path(args.library_root).resolve()
    output_root = validate_output_path(
        Path(args.output_root),
        library_root=library_root,
        repo_root=repo_root,
    )
    model_path = Path(args.model).resolve()
    if not model_path.is_file():
        raise HardCandidateError(f"detector model is missing: {model_path}")
    model_sha256 = _sha256_file(model_path)
    expected_model_sha256 = _string(args.expected_model_sha256).lower()
    if (
        not re.fullmatch(r"[0-9a-f]{64}", expected_model_sha256)
        or model_sha256 != expected_model_sha256
    ):
        raise HardCandidateError(
            f"detector SHA-256 mismatch: {model_sha256} != {expected_model_sha256}"
        )
    if not 1 <= args.max_chapters_per_work <= 20:
        raise ValueError("--max-chapters-per-work must be between 1 and 20")
    if args.minimum_candidates < 0:
        raise ValueError("--minimum-candidates cannot be negative")
    for name in (
        "score_threshold",
        "detector_nms_iou_threshold",
        "dedup_iou_threshold",
        "bubble_edge_ratio",
        "near_bubble_ratio",
        "accepted_iou_threshold",
        "crop_padding_ratio",
    ):
        _validate_unit_interval(
            f"--{name.replace('_', '-')}", float(getattr(args, name))
        )
    if args.crop_padding_min < 0 or args.crop_padding_max < args.crop_padding_min:
        raise ValueError("crop padding bounds are invalid")

    config = MiningConfig(
        score_threshold=float(args.score_threshold),
        detector_nms_iou=float(args.detector_nms_iou_threshold),
        dedup_iou=float(args.dedup_iou_threshold),
        bubble_edge_ratio=float(args.bubble_edge_ratio),
        near_bubble_ratio=float(args.near_bubble_ratio),
        accepted_iou=float(args.accepted_iou_threshold),
        crop_padding_ratio=float(args.crop_padding_ratio),
        crop_padding_min=int(args.crop_padding_min),
        crop_padding_max=int(args.crop_padding_max),
    )
    inventory = load_library(library_root, limit_works=args.limit_works)
    selections = [
        selection
        for work, chapters in inventory
        for selection in select_chapters_evenly(
            work,
            chapters,
            args.max_chapters_per_work,
        )
    ]
    if not selections:
        raise HardCandidateError("the indexed library contains no chapters")
    frozen_pages = freeze_selected_pages(selections)
    if not frozen_pages:
        raise HardCandidateError("the selected chapters contain no pages")
    splits = assign_work_splits(
        [work.id for work, _ in inventory],
        seed=args.seed,
        ratios=args.split_ratios,
    )

    default_accepted = (
        repo_root / "datasets" / "fontclip-accepted-v1" / "manifest_masked.jsonl"
    )
    accepted_path: Path | None
    if args.no_accepted_dedup:
        accepted_path = None
    elif args.accepted_manifest is None:
        accepted_path = default_accepted
    else:
        accepted_path = Path(args.accepted_manifest)
        if not accepted_path.resolve().is_file():
            raise HardCandidateError(
                f"explicit accepted manifest is missing: {accepted_path.resolve()}"
            )
    accepted_index, accepted_info = load_accepted_index(accepted_path)
    selected_payload = _selected_payload(selections, splits)
    frozen_payload = _frozen_inventory_payload(frozen_pages, library_root)
    signature = {
        "library_root": str(library_root),
        "model_path": str(model_path),
        "model_sha256": model_sha256,
        "accepted_manifest": accepted_info,
        "configuration": {
            "max_chapters_per_work": args.max_chapters_per_work,
            "seed": args.seed,
            "split_ratios": list(args.split_ratios),
            "score_threshold": config.score_threshold,
            "detector_nms_iou_threshold": config.detector_nms_iou,
            "dedup_iou_threshold": config.dedup_iou,
            "bubble_edge_ratio": config.bubble_edge_ratio,
            "near_bubble_ratio": config.near_bubble_ratio,
            "accepted_iou_threshold": config.accepted_iou,
            "crop_padding_ratio": config.crop_padding_ratio,
            "crop_padding_min": config.crop_padding_min,
            "crop_padding_max": config.crop_padding_max,
            "letterbox_size": LETTERBOX_SIZE,
        },
        "selected_chapters_sha256": _sha256_json(selected_payload),
        "frozen_page_inventory_sha256": _sha256_json(frozen_payload),
        "frozen_page_count": len(frozen_payload),
    }
    run_signature_sha256 = _sha256_json(signature)
    resumed_invocation = prepare_output(
        output_root,
        signature=signature,
        overwrite=bool(args.overwrite),
        dry_run=bool(args.dry_run),
    )
    if _sha256_file(model_path) != model_sha256:
        raise ResumeValidationError(
            f"detector model changed after signature freeze: {model_path}"
        )
    detector = detector_factory(model_path, config.score_threshold)
    runtime_model_sha256 = getattr(detector, "model_sha256", model_sha256)
    if runtime_model_sha256 != model_sha256:
        raise ResumeValidationError(
            "detector runtime bytes do not match the signed model SHA-256"
        )
    seen_crop_hashes: set[str] = set()
    all_records: list[dict[str, Any]] = []
    page_reports: list[dict[str, Any]] = []
    for page_index, page in enumerate(frozen_pages, 1):
        _progress(
            f"[page {page_index}/{len(frozen_pages)}] "
            f"{page.work.title} / {page.chapter.title} / {page.page.name}",
            args.quiet,
        )
        records, page_report = process_page(
            page,
            detector=detector,
            config=config,
            accepted_index=accepted_index,
            library_root=library_root,
            output_root=output_root,
            split=splits[page.work.id],
            model_sha256=model_sha256,
            run_signature_sha256=run_signature_sha256,
            seen_crop_hashes=seen_crop_hashes,
            dry_run=bool(args.dry_run),
        )
        all_records.extend(records)
        page_reports.append(page_report)

    all_records.sort(
        key=lambda record: (
            record["work_id"],
            record["chapter_id"],
            record["page_name"],
            record["bbox_px"],
            record["id"],
        )
    )
    apply_balance_weights(all_records)
    category_counts = Counter(
        category for record in all_records for category in record.get("categories", ())
    )
    warnings: list[str] = []
    if accepted_info["state"] == "missing":
        warnings.append(
            "default approved manifest is absent; no approved-crop IoU "
            "exclusion was applied"
        )
    if len(all_records) < args.minimum_candidates:
        warnings.append(
            f"candidate total {len(all_records)} is below requested minimum "
            f"{args.minimum_candidates}"
        )
    report = {
        "schema_version": SCHEMA_VERSION,
        "tool": TOOL_ID,
        "dry_run": bool(args.dry_run),
        "resumed_invocation": resumed_invocation,
        "library_root": str(library_root),
        "output_root": str(output_root),
        "model_path": str(model_path),
        "model_sha256": model_sha256,
        "run_signature_sha256": run_signature_sha256,
        "accepted_manifest": accepted_info,
        "works": len(inventory),
        "selected_chapters": len(selections),
        "selected_pages": len(frozen_pages),
        "source_dimension_mismatch_pages": sum(
            page.source_dimension_mismatch for page in frozen_pages
        ),
        "ocr_metadata_skip_reasons": dict(
            sorted(
                sum(
                    (Counter(page.ocr_metadata_skip_reasons) for page in frozen_pages),
                    Counter(),
                ).items()
            )
        ),
        "new_page_inferences": detector.inference_count,
        "resumed_pages": sum(bool(item.get("resumed")) for item in page_reports),
        "candidate_records": len(all_records),
        "unique_crop_sha256": len(seen_crop_hashes),
        "category_memberships": dict(sorted(category_counts.items())),
        "by_split": dict(
            sorted(Counter(record["split"] for record in all_records).items())
        ),
        "by_orientation": dict(
            sorted(Counter(record["orientation"] for record in all_records).items())
        ),
        "page_exclusions": dict(
            sorted(
                sum(
                    (Counter(item.get("exclusions", {})) for item in page_reports),
                    Counter(),
                ).items()
            )
        ),
        "warnings": warnings,
        "configuration": signature["configuration"],
        "selected_chapters_sha256": signature["selected_chapters_sha256"],
        "frozen_page_inventory_sha256": signature["frozen_page_inventory_sha256"],
    }
    if not args.dry_run:
        _atomic_write_jsonl(output_root / "manifest.jsonl", all_records)
        _atomic_write_json(
            output_root / "selected_chapters.json",
            selected_payload,
        )
        _atomic_write_jsonl(
            output_root / "selected_chapters.jsonl",
            selected_payload,
        )
        _atomic_write_json(output_root / "report.json", report)
        _atomic_write_jsonl(output_root / "report.jsonl", page_reports)
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    _progress(
        f"[done] candidates={len(all_records)} pages={len(frozen_pages)} "
        f"new_inferences={detector.inference_count} "
        f"resumed_pages={report['resumed_pages']} "
        f"dry_run={bool(args.dry_run)}",
        args.quiet,
    )
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        report = run(args)
    except (
        HardCandidateError,
        OSError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        parser.exit(2, f"error: {exc}\n")
    if args.quiet:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
