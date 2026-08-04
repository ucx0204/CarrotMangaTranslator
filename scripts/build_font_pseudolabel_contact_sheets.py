#!/usr/bin/env python3
"""Build font-grouped contact sheets and correction indexes for pseudo labels.

The existing fast labelers remain the source of model predictions.  This tool
joins one pseudo-label JSONL with the sealed font-matching master manifest,
resolves the real 224px crop views through ``CatalogAssetResolver``, and emits:

* contact sheets grouped by coarse Korean font family and predicted font;
* one JSONL correction index with nested audit evidence;
* one UTF-8 CSV correction index for quick spreadsheet editing; and
* a hash-bound report that can be validated independently.

Rows are review aids only.  They remain ``pseudo_not_gold`` and are never made
training-eligible by this tool.  Within every predicted-font group, model
disagreements, low relative top-1 margin, and visual feature outliers are shown
first so a reviewer can correct the most suspicious assignments quickly.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from contextlib import AbstractContextManager
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    from scripts import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - direct execution from scripts/
    import font_matching_catalog_assets as catalog_assets  # type: ignore[no-redef]


SCHEMA_VERSION = "font-pseudolabel-contact-sheets-v1"
INDEX_SCHEMA_VERSION = "font-pseudolabel-correction-index-v1"
OWNER = "carrot-manga-translator/font-pseudolabel-contact-sheets-v1"
REPORT_FILE = "report.json"
INDEX_JSONL_FILE = "correction-index.jsonl"
INDEX_CSV_FILE = "correction-index.csv"
README_FILE = "README.txt"
MARKER_FILE = ".font-pseudolabel-contact-sheets-owned.json"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_SEGMENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# Coarse families deliberately describe Korean output faces, not source roles.
# Keep the inventory explicit: decorative faces must never silently become body
# faces merely because their SFNT metadata says sans-serif.
FONT_FAMILY_BY_ID: Mapping[str, str] = {
    "nanum-gothic": "body-sans",
    "nanum-barun-gothic": "body-sans",
    "seoul-namsan": "body-sans",
    "seoul-namsan-vertical": "body-sans",
    "nanum-myeongjo": "body-serif",
    "seoul-hangang": "body-serif",
    "ridi-batang": "body-serif",
    "dohyeon": "display",
    "jua": "display",
    "black-han-sans": "display",
    "gasoek-one": "display",
    "gugi": "display",
    "mongtori": "handwritten",
    "griun-pol-sensibility": "handwritten",
    "cafe24-gowoonbam": "handwritten",
    "start-over": "handwritten",
    "gaegu": "handwritten",
    "kirang-haerang": "handwritten",
    "single-day": "handwritten",
    "chosun-gungseo": "brush",
    "nanum-brush-script": "brush",
    "black-and-white-picture": "effect",
}
RETIRED_FONT_IDS = frozenset({"gugi"})
STYLE_FIELDS = (
    "serifness",
    "weight",
    "width",
    "roundness",
    "stroke_contrast",
    "handwritten",
    "angularity",
    "irregularity",
    "slant",
    "energy",
)
CSV_FIELDS = (
    "review_order",
    "font_review_order",
    "sheet_file",
    "sheet_cell",
    "sample_id",
    "predicted_font_id",
    "predicted_family",
    "retired_font",
    "confidence",
    "top1_probability",
    "top1_margin",
    "relative_margin",
    "font_outlier_score",
    "review_priority_score",
    "prediction_disagreement",
    "view_disagreement_score",
    "role",
    "role_confidence",
    "source_category",
    "split",
    "work_id",
    "work_title",
    "chapter_id",
    "chapter_title",
    "page_id",
    "page_name",
    "view_name",
    "source_row_index",
    "verdict",
    "corrected_font_id",
    "corrected_family",
    "notes",
)


class ContactSheetError(ValueError):
    """Raised when input contracts or output seals drift."""


class ResolvedView(Protocol):
    image: Image.Image


class ViewResolver(Protocol):
    def resolve_sample_view(
        self, sample: Mapping[str, Any], view_name: str
    ) -> AbstractContextManager[ResolvedView]: ...


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iter_jsonl(path: Path, *, location: str) -> Iterable[tuple[int, dict[str, Any]]]:
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ContactSheetError(f"{location}:{line_number}: invalid JSON") from error
            if not isinstance(value, dict):
                raise ContactSheetError(f"{location}:{line_number}: expected object")
            yield line_number, value


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContactSheetError(f"{location}: invalid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ContactSheetError(f"{location}: expected object")
    return value


def mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContactSheetError(f"{location}: expected object")
    return value


def text(value: Any, *, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise ContactSheetError(f"{location}: expected text")
    return result


def finite(value: Any, *, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(core)
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or not SHA_RE.fullmatch(expected):
        raise ContactSheetError(f"{location}: invalid record_sha256")
    core = dict(record)
    core.pop("record_sha256", None)
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise ContactSheetError(f"{location}: record seal drift")
    return actual


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise ContactSheetError(f"unsafe output directory: {result}")
    return result


def _safe_relative(value: Any, *, location: str) -> PurePosixPath:
    raw = text(value, location=location)
    if "\\" in raw:
        raise ContactSheetError(f"{location}: POSIX relative path required")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or ".." in relative.parts or "." in relative.parts:
        raise ContactSheetError(f"{location}: unsafe relative path")
    return relative


def _inside(root: Path, relative: PurePosixPath, *, location: str) -> Path:
    path = root.joinpath(*relative.parts).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise ContactSheetError(f"{location}: path escapes output root") from error
    return path


def _font_family(font_id: str) -> str:
    family = FONT_FAMILY_BY_ID.get(font_id)
    if family is None:
        raise ContactSheetError(f"unknown predicted font id: {font_id}")
    return family


def _ranker_top5(row: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    ranker = row.get("ranker")
    raw = ranker.get("top5") if isinstance(ranker, Mapping) else row.get("top5")
    if not isinstance(raw, list) or not raw:
        raise ContactSheetError(f"{row.get('sample_id')}: missing ranker top5")
    result = [mapping(value, location="ranker.top5") for value in raw]
    return sorted(result, key=lambda value: int(value.get("rank", 999)))


def _role(row: Mapping[str, Any]) -> tuple[str, float]:
    raw_role = row.get("role")
    if not isinstance(raw_role, Mapping):
        return "unknown", 0.0
    role = raw_role
    top3 = role.get("top3")
    if not isinstance(top3, list) or not top3:
        return "unknown", 0.0
    first = mapping(top3[0], location="role.top3[0]")
    return str(first.get("role") or "unknown"), clamp01(finite(first.get("confidence")))


def _style_vector(row: Mapping[str, Any]) -> np.ndarray:
    style = mapping(row.get("style") or {}, location="style")
    return np.asarray(
        [finite(style.get(field), default=0.5) for field in STYLE_FIELDS],
        dtype=np.float32,
    )


def compact_prediction(row: Mapping[str, Any], *, source_line_number: int) -> dict[str, Any]:
    sample_id = text(row.get("sample_id"), location="pseudo.sample_id")
    selected_font_id = text(row.get("selected_font_id"), location=f"{sample_id}.selected_font_id")
    family = _font_family(selected_font_id)
    top5 = _ranker_top5(row)
    top1 = top5[0]
    top2 = top5[1] if len(top5) > 1 else None
    top1_probability = clamp01(finite(top1.get("probability")))
    top2_probability = clamp01(finite(top2.get("probability"))) if top2 else 0.0
    top1_margin = max(0.0, top1_probability - top2_probability)
    relative_margin = clamp01(top1_margin / max(top1_probability, 1e-8))
    role, role_confidence = _role(row)
    direct = row.get("direct_reference")
    direct_font_id = (
        str(direct.get("selected_font_id"))
        if isinstance(direct, Mapping) and direct.get("selected_font_id")
        else None
    )
    disagreement = direct_font_id is not None and direct_font_id != selected_font_id
    view_disagreement = row.get("view_disagreement")
    view_disagreement_score = clamp01(
        finite(view_disagreement.get("top1_disagreement"))
        if isinstance(view_disagreement, Mapping)
        else 0.0
    )
    disagreement = disagreement or view_disagreement_score > 0.0
    # Confidence is a separation score, not the raw 22-way softmax probability.
    confidence = (
        clamp01(finite(row.get("confidence")))
        if "confidence" in row
        else relative_margin * (0.85 if disagreement else 1.0)
    )
    return {
        "sample_id": sample_id,
        "predicted_font_id": selected_font_id,
        "predicted_family": family,
        "retired_font": selected_font_id in RETIRED_FONT_IDS,
        "confidence": clamp01(confidence),
        "top1_probability": top1_probability,
        "top1_margin": top1_margin,
        "relative_margin": relative_margin,
        "prediction_disagreement": disagreement,
        "view_disagreement_score": view_disagreement_score,
        "direct_reference_font_id": direct_font_id,
        "role": role,
        "role_confidence": role_confidence,
        "source_category": str(row.get("source_category") or "unknown"),
        "split": str(row.get("split") or "unknown"),
        "source_row_index": int(row.get("source_row_index", source_line_number - 1)),
        "style_vector": _style_vector(row),
        "pseudo_record_sha256": row.get("record_sha256"),
    }


def load_predictions(path: Path) -> dict[str, dict[str, Any]]:
    predictions: dict[str, dict[str, Any]] = {}
    for line_number, row in iter_jsonl(path, location="pseudo labels"):
        prediction = compact_prediction(row, source_line_number=line_number)
        sample_id = prediction["sample_id"]
        if sample_id in predictions:
            raise ContactSheetError(f"duplicate pseudo-label sample id: {sample_id}")
        predictions[sample_id] = prediction
    if not predictions:
        raise ContactSheetError("pseudo-label input is empty")
    return predictions


def load_master_samples(
    path: Path, predictions: Mapping[str, Mapping[str, Any]]
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    found: set[str] = set()
    for line_number, row in iter_jsonl(path, location="master manifest"):
        sample_id = str(row.get("id") or "")
        prediction = predictions.get(sample_id)
        if prediction is None:
            continue
        if sample_id in found:
            raise ContactSheetError(f"duplicate master sample id: {sample_id}")
        found.add(sample_id)
        work = mapping(row.get("work"), location=f"master:{line_number}.work")
        chapter = mapping(row.get("chapter"), location=f"master:{line_number}.chapter")
        page = mapping(row.get("page"), location=f"master:{line_number}.page")
        views = mapping(row.get("views"), location=f"master:{line_number}.views")
        result.append(
            {
                **prediction,
                "work_id": str(work.get("id") or ""),
                "work_title": str(work.get("title") or ""),
                "chapter_id": str(chapter.get("id") or ""),
                "chapter_title": str(chapter.get("title") or ""),
                "page_id": str(page.get("id") or ""),
                "page_name": str(page.get("name") or ""),
                "views": dict(views),
            }
        )
    missing = set(predictions) - found
    if missing:
        first_missing = sorted(missing)[0]
        raise ContactSheetError(
            f"{len(missing)} pseudo-label samples are absent from master; "
            f"first={first_missing}"
        )
    return result


def _normalized_mean_features(values: np.ndarray) -> np.ndarray:
    if values.ndim != 3 or values.shape[1] != 3:
        raise ContactSheetError(f"feature shard must have shape [N,3,D], found {values.shape}")
    values = values.astype(np.float32, copy=False)
    view_norms = np.linalg.norm(values, axis=2, keepdims=True).clip(min=1e-8)
    mean = np.mean(values / view_norms, axis=1)
    return mean / np.linalg.norm(mean, axis=1, keepdims=True).clip(min=1e-8)


def _feature_shards(feature_manifest_path: Path) -> list[tuple[Path, list[str]]]:
    manifest = read_json(feature_manifest_path, location="feature manifest")
    shards = manifest.get("shards")
    if not isinstance(shards, list) or not shards:
        raise ContactSheetError("feature manifest has no shards")
    result: list[tuple[Path, list[str]]] = []
    for index, raw in enumerate(shards):
        shard = mapping(raw, location=f"feature shard {index}")
        feature_path = feature_manifest_path.parent / text(
            shard.get("feature_file"), location=f"feature shard {index}.feature_file"
        )
        index_path = feature_manifest_path.parent / text(
            shard.get("index_file"), location=f"feature shard {index}.index_file"
        )
        if shard.get("feature_sha256") != sha256_file(feature_path):
            raise ContactSheetError(f"feature shard hash drift: {feature_path}")
        if shard.get("index_sha256") != sha256_file(index_path):
            raise ContactSheetError(f"feature index hash drift: {index_path}")
        sample_ids = [
            text(row.get("sample_id"), location=f"{index_path}:{line_number}.sample_id")
            for line_number, row in iter_jsonl(index_path, location="feature index")
        ]
        result.append((feature_path, sample_ids))
    return result


def compute_feature_outliers(
    rows: Sequence[Mapping[str, Any]], feature_manifest_path: Path
) -> dict[str, float]:
    by_id = {str(row["sample_id"]): str(row["predicted_font_id"]) for row in rows}
    sums: dict[str, np.ndarray] = {}
    counts: Counter[str] = Counter()
    shards = _feature_shards(feature_manifest_path)
    seen: set[str] = set()
    for feature_path, sample_ids in shards:
        features = np.load(feature_path, mmap_mode="r", allow_pickle=False)
        if len(features) != len(sample_ids):
            raise ContactSheetError(f"feature/index row count mismatch: {feature_path}")
        vectors = _normalized_mean_features(np.asarray(features))
        for index, sample_id in enumerate(sample_ids):
            font_id = by_id.get(sample_id)
            if font_id is None:
                continue
            vector = vectors[index]
            if vector is None:
                raise ContactSheetError("feature vector inventory drift")
            sums[font_id] = sums.get(font_id, np.zeros_like(vector)) + vector
            counts[font_id] += 1
            seen.add(sample_id)
    missing = set(by_id) - seen
    if missing:
        first_missing = sorted(missing)[0]
        raise ContactSheetError(
            f"{len(missing)} selected samples are absent from feature cache; "
            f"first={first_missing}"
        )
    centroids = {
        font_id: value / max(float(np.linalg.norm(value)), 1e-8)
        for font_id, value in sums.items()
    }
    outliers: dict[str, float] = {}
    for feature_path, sample_ids in shards:
        features = np.load(feature_path, mmap_mode="r", allow_pickle=False)
        vectors = _normalized_mean_features(np.asarray(features))
        for index, sample_id in enumerate(sample_ids):
            font_id = by_id.get(sample_id)
            if font_id is None:
                continue
            if counts[font_id] < 3:
                outliers[sample_id] = 0.0
                continue
            cosine = float(np.dot(vectors[index], centroids[font_id]))
            outliers[sample_id] = clamp01((1.0 - cosine) / 0.5)
    return outliers


def compute_style_outliers(rows: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    grouped: dict[str, list[np.ndarray]] = defaultdict(list)
    for row in rows:
        grouped[str(row["predicted_font_id"])].append(np.asarray(row["style_vector"]))
    centers: dict[str, np.ndarray] = {}
    scales: dict[str, np.ndarray] = {}
    for font_id, values in grouped.items():
        matrix = np.stack(values)
        center = np.median(matrix, axis=0)
        mad = np.median(np.abs(matrix - center), axis=0)
        centers[font_id] = center
        scales[font_id] = np.maximum(mad * 1.4826, 0.08)
    result: dict[str, float] = {}
    for row in rows:
        font_id = str(row["predicted_font_id"])
        if len(grouped[font_id]) < 3:
            result[str(row["sample_id"])] = 0.0
            continue
        z = np.abs(np.asarray(row["style_vector"]) - centers[font_id]) / scales[font_id]
        result[str(row["sample_id"])] = clamp01(float(np.mean(np.minimum(z, 4.0))) / 4.0)
    return result


def attach_review_priority(
    rows: Sequence[dict[str, Any]], outliers: Mapping[str, float]
) -> None:
    for row in rows:
        outlier = clamp01(finite(outliers.get(str(row["sample_id"]))))
        disagreement = 1.0 if row["prediction_disagreement"] else 0.0
        retired = 1.0 if row["retired_font"] else 0.0
        priority = (
            0.48 * (1.0 - finite(row["confidence"]))
            + 0.32 * outlier
            + 0.12 * disagreement
            + 0.08 * retired
        )
        row["font_outlier_score"] = outlier
        row["review_priority_score"] = clamp01(priority)


def review_sort_key(row: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        -finite(row.get("review_priority_score")),
        finite(row.get("confidence")),
        -finite(row.get("font_outlier_score")),
        str(row.get("sample_id")),
    )


def _annotation_font(project_root: Path, size: int) -> ImageFont.ImageFont:
    candidates = (
        project_root / "src/renderer/src/assets/fonts/nanum-gothic-regular.ttf",
        Path("C:/Windows/Fonts/malgun.ttf"),
    )
    for candidate in candidates:
        if candidate.is_file():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                pass
    try:
        return ImageFont.load_default(size=max(10, size))
    except TypeError:  # Pillow < 10
        return ImageFont.load_default()


def _fit_annotation_text(
    draw: ImageDraw.ImageDraw,
    value: str,
    *,
    font: ImageFont.ImageFont,
    maximum_width: int,
) -> str:
    """Return a single-line label that cannot bleed into the next review cell."""
    if draw.textlength(value, font=font) <= maximum_width:
        return value
    suffix = "..."
    low, high = 0, len(value)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = value[:middle] + suffix
        if draw.textlength(candidate, font=font) <= maximum_width:
            low = middle
        else:
            high = middle - 1
    return value[:low] + suffix


def _fit_paste(canvas: Image.Image, source: Image.Image, box: tuple[int, int, int, int]) -> None:
    converted = source.convert("RGB")
    try:
        fitted = ImageOps.contain(
            converted,
            (max(1, box[2] - box[0]), max(1, box[3] - box[1])),
            Image.Resampling.LANCZOS,
        )
        try:
            x = box[0] + (box[2] - box[0] - fitted.width) // 2
            y = box[1] + (box[3] - box[1] - fitted.height) // 2
            canvas.paste(fitted, (x, y))
        finally:
            fitted.close()
    finally:
        converted.close()


def _resolve_crop(
    resolver: ViewResolver, row: Mapping[str, Any], view_name: str
) -> Image.Image:
    sample = {
        "sample_id": row["sample_id"],
        "source": {"views": row["views"]},
    }
    try:
        with resolver.resolve_sample_view(sample, view_name) as resolved:
            return resolved.image.copy().convert("RGB")
    except catalog_assets.CatalogAssetError as error:
        raise ContactSheetError(str(error)) from error


def _sheet_group_path(family: str, font_id: str, sheet_number: int) -> str:
    if not SAFE_SEGMENT_RE.fullmatch(family) or not SAFE_SEGMENT_RE.fullmatch(font_id):
        raise ContactSheetError("unsafe font/family output segment")
    return f"sheets/{family}/{font_id}/sheet-{sheet_number:04d}.png"


def render_contact_sheets(
    rows: Sequence[dict[str, Any]],
    *,
    output_dir: Path,
    resolver: ViewResolver,
    project_root: Path,
    view_name: str,
    items_per_sheet: int,
    columns: int,
) -> list[dict[str, Any]]:
    if view_name not in VIEW_NAMES:
        raise ContactSheetError(f"unsupported view: {view_name}")
    if not 4 <= items_per_sheet <= 64:
        raise ContactSheetError("items_per_sheet must be inside [4,64]")
    if not 2 <= columns <= 8:
        raise ContactSheetError("columns must be inside [2,8]")
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row["predicted_family"]), str(row["predicted_font_id"]))].append(row)
    title_font = _annotation_font(project_root, 22)
    small_font = _annotation_font(project_root, 12)
    cell_width, cell_height, header_height = 252, 294, 62
    sheets: list[dict[str, Any]] = []
    global_order = 0
    for family, font_id in sorted(grouped):
        group = sorted(grouped[(family, font_id)], key=review_sort_key)
        for font_order, row in enumerate(group, 1):
            row["font_review_order"] = font_order
        for sheet_number, start in enumerate(range(0, len(group), items_per_sheet), 1):
            chunk = group[start : start + items_per_sheet]
            sheet_rows = math.ceil(len(chunk) / columns)
            canvas = Image.new(
                "RGB",
                (cell_width * columns, header_height + cell_height * sheet_rows),
                (239, 242, 247),
            )
            draw = ImageDraw.Draw(canvas)
            draw.text(
                (14, 8),
                f"{family} / {font_id}  sheet {sheet_number}  n={len(chunk)}",
                fill=(15, 23, 42),
                font=title_font,
            )
            draw.text(
                (14, 36),
                "order: low confidence + disagreement + visual outlier first",
                fill=(71, 85, 105),
                font=small_font,
            )
            relative = _sheet_group_path(family, font_id, sheet_number)
            for cell_index, row in enumerate(chunk, 1):
                grid_row, grid_column = divmod(cell_index - 1, columns)
                left = grid_column * cell_width
                top = header_height + grid_row * cell_height
                right, bottom = left + cell_width, top + cell_height
                priority = finite(row["review_priority_score"])
                border = (
                    (196, 52, 52)
                    if priority >= 0.75
                    else (217, 119, 6)
                    if priority >= 0.55
                    else (71, 85, 105)
                )
                draw.rectangle(
                    (left + 3, top + 3, right - 4, bottom - 4),
                    fill=(255, 255, 255),
                    outline=border,
                    width=3,
                )
                global_order += 1
                row["review_order"] = global_order
                row["sheet_file"] = relative
                row["sheet_cell"] = cell_index
                sample_label = _fit_annotation_text(
                    draw,
                    f"id={row['sample_id']}",
                    font=small_font,
                    maximum_width=cell_width - 20,
                )
                draw.text((left + 9, top + 8), sample_label, fill=(17, 24, 39), font=small_font)
                draw.text(
                    (left + 9, top + 30),
                    f"c={row['confidence']:.3f} p={row['top1_probability']:.3f} "
                    f"out={row['font_outlier_score']:.3f}",
                    fill=(153, 27, 27) if priority >= 0.65 else (30, 64, 175),
                    font=small_font,
                )
                flag = " !disagree" if row["prediction_disagreement"] else ""
                if row["retired_font"]:
                    flag += " !retired"
                role_label = _fit_annotation_text(
                    draw,
                    f"role={row['role'][:24]}{flag}",
                    font=small_font,
                    maximum_width=cell_width - 20,
                )
                draw.text(
                    (left + 9, top + 49),
                    role_label,
                    fill=(75, 85, 99),
                    font=small_font,
                )
                crop = _resolve_crop(resolver, row, view_name)
                _fit_paste(canvas, crop, (left + 10, top + 73, right - 10, bottom - 12))
                crop.close()
            target = output_dir.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(target, format="PNG", compress_level=6)
            width, height = canvas.size
            canvas.close()
            sheets.append(
                {
                    "family": family,
                    "file": relative,
                    "font_id": font_id,
                    "height": height,
                    "row_count": len(chunk),
                    "sha256": sha256_file(target),
                    "width": width,
                }
            )
    return sheets


def _index_record(row: Mapping[str, Any], *, view_name: str) -> dict[str, Any]:
    return seal_record(
        {
            "audit": {
                "confidence": round(finite(row["confidence"]), 8),
                "direct_reference_font_id": row.get("direct_reference_font_id"),
                "font_outlier_score": round(finite(row["font_outlier_score"]), 8),
                "prediction_disagreement": bool(row["prediction_disagreement"]),
                "pseudo_record_sha256": row.get("pseudo_record_sha256"),
                "relative_margin": round(finite(row["relative_margin"]), 8),
                "review_priority_score": round(finite(row["review_priority_score"]), 8),
                "role": row["role"],
                "role_confidence": round(finite(row["role_confidence"]), 8),
                "top1_margin": round(finite(row["top1_margin"]), 8),
                "top1_probability": round(finite(row["top1_probability"]), 8),
                "view_disagreement_score": round(
                    finite(row.get("view_disagreement_score")), 8
                ),
            },
            "chapter": {"id": row["chapter_id"], "title": row["chapter_title"]},
            "correction": {
                "corrected_family": "",
                "corrected_font_id": "",
                "notes": "",
                "verdict": "",
            },
            "font_review_order": int(row["font_review_order"]),
            "label_authority": "pseudo_not_gold",
            "page": {"id": row["page_id"], "name": row["page_name"]},
            "prediction": {
                "family": row["predicted_family"],
                "font_id": row["predicted_font_id"],
                "retired_font": bool(row["retired_font"]),
            },
            "review_order": int(row["review_order"]),
            "sample_id": row["sample_id"],
            "schema_version": INDEX_SCHEMA_VERSION,
            "sheet": {"cell": int(row["sheet_cell"]), "file": row["sheet_file"]},
            "source": {
                "category": row["source_category"],
                "pseudo_row_index": int(row["source_row_index"]),
                "split": row["split"],
                "view_name": view_name,
            },
            "training_eligible": False,
            "work": {"id": row["work_id"], "title": row["work_title"]},
        }
    )


def _csv_record(record: Mapping[str, Any]) -> dict[str, Any]:
    audit = mapping(record["audit"], location="index.audit")
    prediction = mapping(record["prediction"], location="index.prediction")
    correction = mapping(record["correction"], location="index.correction")
    source = mapping(record["source"], location="index.source")
    sheet = mapping(record["sheet"], location="index.sheet")
    work = mapping(record["work"], location="index.work")
    chapter = mapping(record["chapter"], location="index.chapter")
    page = mapping(record["page"], location="index.page")
    return {
        "review_order": record["review_order"],
        "font_review_order": record["font_review_order"],
        "sheet_file": sheet["file"],
        "sheet_cell": sheet["cell"],
        "sample_id": record["sample_id"],
        "predicted_font_id": prediction["font_id"],
        "predicted_family": prediction["family"],
        "retired_font": str(bool(prediction["retired_font"])).lower(),
        "confidence": audit["confidence"],
        "top1_probability": audit["top1_probability"],
        "top1_margin": audit["top1_margin"],
        "relative_margin": audit["relative_margin"],
        "font_outlier_score": audit["font_outlier_score"],
        "review_priority_score": audit["review_priority_score"],
        "prediction_disagreement": str(bool(audit["prediction_disagreement"])).lower(),
        "view_disagreement_score": audit["view_disagreement_score"],
        "role": audit["role"],
        "role_confidence": audit["role_confidence"],
        "source_category": source["category"],
        "split": source["split"],
        "work_id": work["id"],
        "work_title": work["title"],
        "chapter_id": chapter["id"],
        "chapter_title": chapter["title"],
        "page_id": page["id"],
        "page_name": page["name"],
        "view_name": source["view_name"],
        "source_row_index": source["pseudo_row_index"],
        "verdict": correction["verdict"],
        "corrected_font_id": correction["corrected_font_id"],
        "corrected_family": correction["corrected_family"],
        "notes": correction["notes"],
    }


def write_indexes(
    output_dir: Path,
    rows: Sequence[dict[str, Any]],
    *,
    view_name: str,
) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=lambda row: int(row["review_order"]))
    records = [_index_record(row, view_name=view_name) for row in ordered]
    jsonl_path = output_dir / INDEX_JSONL_FILE
    with jsonl_path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(canonical_json(record) + "\n")
    csv_path = output_dir / INDEX_CSV_FILE
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="raise")
        writer.writeheader()
        for record in records:
            writer.writerow(_csv_record(record))
    return records


def _limit_rows(rows: Sequence[dict[str, Any]], maximum: int) -> list[dict[str, Any]]:
    if maximum <= 0 or maximum >= len(rows):
        return list(rows)
    # Preserve font coverage before filling the remaining global priority slots.
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["predicted_font_id"])].append(row)
    chosen: list[dict[str, Any]] = []
    for font_id in sorted(grouped):
        if len(chosen) >= maximum:
            break
        chosen.append(sorted(grouped[font_id], key=review_sort_key)[0])
    chosen_ids = {str(row["sample_id"]) for row in chosen}
    remaining = sorted(
        (row for row in rows if str(row["sample_id"]) not in chosen_ids),
        key=review_sort_key,
    )
    chosen.extend(remaining[: max(0, maximum - len(chosen))])
    return chosen


def build_bundle(
    *,
    master_manifest_path: Path,
    pseudo_labels_path: Path,
    catalog_registry_path: Path,
    output_dir: Path,
    project_root: Path,
    feature_manifest_path: Path | None = None,
    view_name: str = "glyph_224",
    items_per_sheet: int = 36,
    columns: int = 6,
    max_samples: int = 0,
    replace_owned_output: bool = False,
    resolver: ViewResolver | None = None,
) -> dict[str, Any]:
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise ContactSheetError("output exists; pass --replace-owned-output")
        validate_bundle(target)
    predictions = load_predictions(pseudo_labels_path)
    rows = load_master_samples(master_manifest_path, predictions)
    outliers = (
        compute_feature_outliers(rows, feature_manifest_path)
        if feature_manifest_path is not None
        else compute_style_outliers(rows)
    )
    attach_review_priority(rows, outliers)
    rows = _limit_rows(rows, max_samples)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    try:
        active_resolver = resolver or catalog_assets.CatalogAssetResolver(catalog_registry_path)
        sheets = render_contact_sheets(
            rows,
            output_dir=staging,
            resolver=active_resolver,
            project_root=project_root,
            view_name=view_name,
            items_per_sheet=items_per_sheet,
            columns=columns,
        )
        records = write_indexes(staging, rows, view_name=view_name)
        family_counts = Counter(str(row["predicted_family"]) for row in rows)
        font_counts = Counter(str(row["predicted_font_id"]) for row in rows)
        readme = (
            "FONT PSEUDO-LABEL CONTACT SHEETS (pseudo_not_gold)\n\n"
            "Open sheets/<family>/<font>/ in lexical order. Cells with red/orange "
            "borders are reviewed first.\n"
            "Edit a COPY of correction-index.csv or correction-index.jsonl. Use "
            "verdict=accept/correct/reject.\n"
            "For corrections, fill corrected_font_id and corrected_family; never "
            "treat untouched pseudo labels as gold.\n"
        )
        (staging / README_FILE).write_text(readme, encoding="utf-8", newline="\n")
        report = seal_record(
            {
                "artifacts": {
                    "correction_csv": {
                        "file": INDEX_CSV_FILE,
                        "sha256": sha256_file(staging / INDEX_CSV_FILE),
                    },
                    "correction_jsonl": {
                        "file": INDEX_JSONL_FILE,
                        "record_count": len(records),
                        "sha256": sha256_file(staging / INDEX_JSONL_FILE),
                    },
                    "readme": {"file": README_FILE, "sha256": sha256_file(staging / README_FILE)},
                    "sheets": sheets,
                },
                "boundary": {
                    "label_authority": "pseudo_not_gold",
                    "model_suggestions_visible": True,
                    "training_eligible_rows": 0,
                },
                "configuration": {
                    "columns": columns,
                    "feature_outliers": feature_manifest_path is not None,
                    "items_per_sheet": items_per_sheet,
                    "max_samples": max_samples,
                    "view_name": view_name,
                },
                "inputs": {
                    "catalog_registry_sha256": sha256_file(catalog_registry_path),
                    "feature_manifest_sha256": (
                        sha256_file(feature_manifest_path) if feature_manifest_path else None
                    ),
                    "master_manifest_sha256": sha256_file(master_manifest_path),
                    "pseudo_labels_sha256": sha256_file(pseudo_labels_path),
                },
                "record_type": "font_pseudolabel_contact_sheet_report",
                "schema_version": SCHEMA_VERSION,
                "stats": {
                    "family_counts": dict(sorted(family_counts.items())),
                    "font_counts": dict(sorted(font_counts.items())),
                    "record_count": len(records),
                    "retired_font_rows": sum(bool(row["retired_font"]) for row in rows),
                    "sheet_count": len(sheets),
                },
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = {
            "owner": OWNER,
            "report_sha256": sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_bundle(staging)
        if target.exists():
            validate_bundle(target)
            shutil.rmtree(target)
        os.replace(staging, target)
        return validate_bundle(target)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def validate_bundle(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = read_json(root / REPORT_FILE, location="report")
    validate_record_seal(report, location="report")
    if report.get("schema_version") != SCHEMA_VERSION:
        raise ContactSheetError("report schema drift")
    boundary = mapping(report.get("boundary"), location="report.boundary")
    if (
        boundary.get("label_authority") != "pseudo_not_gold"
        or boundary.get("training_eligible_rows") != 0
    ):
        raise ContactSheetError("authority boundary drift")
    marker = read_json(root / MARKER_FILE, location="marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("report_sha256") != sha256_file(root / REPORT_FILE)
    ):
        raise ContactSheetError("owned-output marker drift")
    artifacts = mapping(report.get("artifacts"), location="report.artifacts")
    for key in ("correction_csv", "correction_jsonl", "readme"):
        descriptor = mapping(artifacts.get(key), location=f"artifacts.{key}")
        relative = _safe_relative(descriptor.get("file"), location=f"{key}.file")
        path = _inside(root, relative, location=key)
        if descriptor.get("sha256") != sha256_file(path):
            raise ContactSheetError(f"{key} hash drift")
    sheet_files: set[str] = set()
    sheet_cells: dict[str, int] = {}
    sheets = artifacts.get("sheets")
    if not isinstance(sheets, list):
        raise ContactSheetError("report sheets must be an array")
    for raw in sheets:
        descriptor = mapping(raw, location="sheet")
        relative = _safe_relative(descriptor.get("file"), location="sheet.file")
        path = _inside(root, relative, location="sheet")
        if descriptor.get("sha256") != sha256_file(path):
            raise ContactSheetError(f"sheet hash drift: {relative}")
        if relative.as_posix() in sheet_files:
            raise ContactSheetError(f"duplicate sheet: {relative}")
        sheet_files.add(relative.as_posix())
        sheet_cells[relative.as_posix()] = int(descriptor.get("row_count", 0))
    index_path = root / INDEX_JSONL_FILE
    sample_ids: set[str] = set()
    seen_cells: Counter[str] = Counter()
    record_count = 0
    for line_number, record in iter_jsonl(index_path, location="correction index"):
        validate_record_seal(record, location=f"correction index:{line_number}")
        if (
            record.get("schema_version") != INDEX_SCHEMA_VERSION
            or record.get("training_eligible") is not False
        ):
            raise ContactSheetError("correction index boundary drift")
        sample_id = text(record.get("sample_id"), location="index.sample_id")
        if sample_id in sample_ids:
            raise ContactSheetError(f"duplicate correction sample: {sample_id}")
        sample_ids.add(sample_id)
        sheet = mapping(record.get("sheet"), location="index.sheet")
        sheet_file = str(sheet.get("file"))
        cell = int(sheet.get("cell", 0))
        if sheet_file not in sheet_files or not 1 <= cell <= sheet_cells[sheet_file]:
            raise ContactSheetError("correction index sheet binding drift")
        seen_cells[sheet_file] += 1
        record_count += 1
    stats = mapping(report.get("stats"), location="report.stats")
    expected = int(stats.get("record_count", -1))
    sheet_inventory_drift = any(
        seen_cells[path] != count for path, count in sheet_cells.items()
    )
    if record_count != expected or sheet_inventory_drift:
        raise ContactSheetError("correction index inventory drift")
    return {
        "output_dir": str(root),
        "record_count": record_count,
        "sheet_count": len(sheet_files),
        "status": "ready_for_grouped_pseudolabel_correction",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build")
    build.add_argument("--master-manifest", type=Path, required=True)
    build.add_argument("--pseudo-labels", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--feature-manifest", type=Path)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--project-root", type=Path, default=Path("."))
    build.add_argument("--view", choices=VIEW_NAMES, default="glyph_224")
    build.add_argument("--items-per-sheet", type=int, default=36)
    build.add_argument("--columns", type=int, default=6)
    build.add_argument("--max-samples", type=int, default=0)
    build.add_argument("--replace-owned-output", action="store_true")
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "build":
        result = build_bundle(
            master_manifest_path=args.master_manifest.resolve(),
            pseudo_labels_path=args.pseudo_labels.resolve(),
            catalog_registry_path=args.catalog_registry.resolve(),
            feature_manifest_path=(
                args.feature_manifest.resolve() if args.feature_manifest else None
            ),
            output_dir=args.output_dir,
            project_root=args.project_root.resolve(),
            view_name=args.view,
            items_per_sheet=args.items_per_sheet,
            columns=args.columns,
            max_samples=args.max_samples,
            replace_owned_output=args.replace_owned_output,
        )
    else:
        result = validate_bundle(args.output_dir)
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ContactSheetError as error:
        raise SystemExit(f"font-pseudolabel-contact-sheet error: {error}") from error
