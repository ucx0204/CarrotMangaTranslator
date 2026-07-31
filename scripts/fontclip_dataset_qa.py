#!/usr/bin/env python3
"""Audit a generated FontCLIP crop dataset and build visual QA artifacts.

The canonical dataset layout is::

    manifest.jsonl
    images/raw/<split>/<id>.png
    images/clip_224/<split>/<id>.png

The auditor deliberately has no project-runtime dependency.  Its only
third-party dependency is Pillow, which is also used to force a complete
decode of every referenced generated image.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import warnings
from collections import Counter, OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError
except ImportError as exc:  # pragma: no cover - exercised only without Pillow
    print(
        "fontclip_dataset_qa.py requires Pillow (pip install Pillow).",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


REPORT_SCHEMA_VERSION = 1
MAX_CHAPTERS_PER_WORK = 10
DEFAULT_SAMPLE_SIZE = 256
DEFAULT_CONTACT_SHEET_SIZE = 64
DEFAULT_AUDIT_ALL_SHEET_SIZE = 12
MAX_ISSUE_DETAILS = 2000
EXPECTED_CLIP_SIZE = (224, 224)
MASK_MANIFEST_NAME = "manifest_masked.jsonl"
MASK_HIGH_PRECISION_NAME = "manifest_masked_high_precision.jsonl"
MASK_REJECTS_NAME = "mask_rejects.jsonl"
MASK_ASSET_CONTRACT = {
    "context": ("RGB", False),
    "glyph_rgba": ("RGBA", False),
    "mask": ("L", False),
    # schema v1 used transparent RGBA; schema v2 uses a white-composited RGB
    # image that matches the actual FontCLIP visual input.
    "glyph_224": (None, True),
    "context_224": ("RGB", True),
}

CANONICAL_FIELDS = (
    "id",
    "image_path",
    "clip_image_path",
    "work_id",
    "work_title",
    "chapter_id",
    "chapter_title",
    "page_id",
    "split",
    "tier",
    "provenance",
    "orientation",
    "bbox_px",
    "crop_bbox_px",
    "crop_sha256",
)

FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "id": ("sample_id", "crop_id", "uid"),
    "image_path": (
        "raw_image_path",
        "raw_path",
        "crop_image_path",
        "native_crop_path",
    ),
    "clip_image_path": (
        "clip_path",
        "clip_224_path",
        "model_image_path",
        "cropped_image_path",
    ),
    "work_id": ("work", "series_id", "manga_id"),
    "work_title": ("series_title", "manga_title"),
    "chapter_id": ("chapter", "episode_id", "episode"),
    "chapter_title": ("episode_title",),
    "page_id": ("page", "page_index", "source_page_id"),
    "split": ("partition", "subset"),
    "tier": ("quality_tier", "confidence_tier"),
    "provenance": ("crop_provenance", "detection_source"),
    "orientation": ("text_orientation", "writing_direction", "direction"),
    "bbox_px": ("bbox", "text_bbox_px", "source_bbox_px"),
    "crop_bbox_px": ("crop_bbox", "expanded_bbox_px", "padded_bbox_px"),
    "crop_sha256": ("sha256", "image_sha256", "raw_sha256"),
}

DIMENSION_FIELD_PAIRS: dict[str, tuple[tuple[str, str], ...]] = {
    "image": (
        ("image_width", "image_height"),
        ("raw_width", "raw_height"),
        ("crop_width", "crop_height"),
    ),
    "clip": (
        ("clip_width", "clip_height"),
        ("clip_image_width", "clip_image_height"),
    ),
}

HEX_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
CANVAS_RE = re.compile(r"^(\d+)[xX](\d+)$")


@dataclass
class IssueCollector:
    counts: Counter[str] = field(default_factory=Counter)
    details: list[dict[str, Any]] = field(default_factory=list)
    omitted_details: int = 0

    def add(
        self,
        severity: str,
        code: str,
        message: str,
        *,
        row: "RowState | None" = None,
        line: int | None = None,
        sample_id: str | None = None,
        path: str | None = None,
        manifest: str | None = None,
    ) -> None:
        severity = severity.lower()
        self.counts[f"{severity}:{code}"] += 1
        if row is not None:
            if severity == "error":
                row.error_codes.add(code)
            else:
                row.warning_codes.add(code)
            line = row.line
            sample_id = row.sample_id or sample_id
            manifest = row.manifest_name
        if len(self.details) >= MAX_ISSUE_DETAILS:
            self.omitted_details += 1
            return
        detail: dict[str, Any] = {
            "severity": severity,
            "code": code,
            "message": message,
        }
        for key, value in (
            ("manifest", manifest),
            ("line", line),
            ("sample_id", sample_id),
            ("path", path),
        ):
            if value is not None:
                detail[key] = value
        self.details.append(detail)

    @property
    def error_count(self) -> int:
        return sum(
            count
            for key, count in self.counts.items()
            if key.startswith("error:")
        )

    @property
    def warning_count(self) -> int:
        return sum(
            count
            for key, count in self.counts.items()
            if key.startswith("warning:")
        )

    def summary_by_code(self, severity: str) -> dict[str, int]:
        prefix = f"{severity}:"
        return dict(
            sorted(
                (
                    (key[len(prefix) :], count)
                    for key, count in self.counts.items()
                    if key.startswith(prefix)
                ),
                key=lambda item: item[0],
            )
        )


@dataclass
class AssetInfo:
    path: Path
    relative_path: str
    exists: bool = False
    decodable: bool = False
    width: int | None = None
    height: int | None = None
    mode: str | None = None
    image_format: str | None = None
    sha256: str | None = None
    pixel_sha256: str | None = None
    plane_sha256: str | None = None
    alpha_sha256: str | None = None
    unique_values: tuple[int, ...] | None = None
    error: str | None = None

    @property
    def size(self) -> tuple[int, int] | None:
        if self.width is None or self.height is None:
            return None
        return self.width, self.height


@dataclass
class RowState:
    line: int
    manifest_name: str
    raw: dict[str, Any]
    values: dict[str, Any] = field(default_factory=dict)
    aliases_used: dict[str, str] = field(default_factory=dict)
    bbox: tuple[int, int, int, int] | None = None
    crop_bbox: tuple[int, int, int, int] | None = None
    image_asset_key: str | None = None
    clip_asset_key: str | None = None
    error_codes: set[str] = field(default_factory=set)
    warning_codes: set[str] = field(default_factory=set)
    mask_join: "MaskJoin | None" = None

    @property
    def sample_id(self) -> str:
        return scalar_text(self.values.get("id"))

    @property
    def work_id(self) -> str:
        return scalar_text(self.values.get("work_id"))

    @property
    def chapter_id(self) -> str:
        return scalar_text(self.values.get("chapter_id"))

    @property
    def split(self) -> str:
        return scalar_text(self.values.get("split"))

    @property
    def tier(self) -> str:
        return scalar_text(self.values.get("tier"))

    @property
    def provenance(self) -> str:
        return scalar_text(self.values.get("provenance"))

    @property
    def orientation(self) -> str:
        return scalar_text(self.values.get("orientation"))


@dataclass(frozen=True)
class ContactSheetSpec:
    max_items: int
    canvas_size: tuple[int, int] | None = None


@dataclass(frozen=True)
class DatasetContract:
    max_chapters_per_work: int = MAX_CHAPTERS_PER_WORK
    clip_size: tuple[int, int] = EXPECTED_CLIP_SIZE


@dataclass
class MaskJoin:
    record: dict[str, Any] | None = None
    reject: dict[str, Any] | None = None
    high_precision: bool = False
    asset_keys: dict[str, str] = field(default_factory=dict)
    page_path: Path | None = None
    boxes: dict[str, tuple[int, int, int, int]] = field(default_factory=dict)

    @property
    def status(self) -> str:
        if self.record is not None:
            return "MASKED"
        return "NO MASK"


@dataclass
class MaskReviewResult:
    masked_count: int
    high_precision_count: int
    reject_count: int
    extraction_reject_count: int
    assets: dict[str, AssetInfo]
    manifest_signatures: dict[str, str]


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a FontCLIP JSONL dataset and write qa/report.json, "
            "qa/audit_sample.csv, and stratified contact sheets."
        )
    )
    parser.add_argument(
        "--dataset",
        required=True,
        type=Path,
        help="Dataset directory, or the primary JSONL manifest path.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        help=(
            "Primary manifest relative to --dataset (for example "
            "fallback/manifest.jsonl). The default is manifest.jsonl."
        ),
    )
    parser.add_argument(
        "--mask-review",
        action="store_true",
        help=(
            "Join manifest.jsonl to manifest_masked.jsonl and "
            "mask_rejects.jsonl, validate all mask assets, and render the "
            "six-panel crop review layout."
        ),
    )
    parser.add_argument(
        "--library",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "library",
        help=(
            "Library root used to load source-page patches in --mask-review "
            "(default: repository library/)."
        ),
    )
    parser.add_argument(
        "--sample-size",
        type=positive_int,
        default=DEFAULT_SAMPLE_SIZE,
        help=(
            "Maximum number of deterministically stratified rows in the visual "
            f"audit sample (default: {DEFAULT_SAMPLE_SIZE})."
        ),
    )
    parser.add_argument(
        "--audit-all",
        action="store_true",
        help=(
            "Put every crop in this shard into one numbered visual-review "
            "sequence instead of selecting a sample."
        ),
    )
    parser.add_argument(
        "--shard-index",
        type=nonnegative_int,
        default=0,
        help="Zero-based deterministic visual-audit shard index (default: 0).",
    )
    parser.add_argument(
        "--shard-count",
        type=positive_int,
        default=1,
        help="Total number of deterministic visual-audit shards (default: 1).",
    )
    parser.add_argument(
        "--contact-sheet-size",
        default=None,
        metavar="N|WIDTHxHEIGHT",
        help=(
            "Either the maximum cells per sheet (integer), or a fixed canvas "
            "size such as 2400x1800. Defaults to 64 for sampled QA and 12 for "
            "--audit-all. WIDTHxHEIGHT derives the cell capacity while keeping "
            "labels readable."
        ),
    )
    args = parser.parse_args(argv)
    if args.shard_index >= args.shard_count:
        parser.error("--shard-index must be smaller than --shard-count")
    contact_size = args.contact_sheet_size
    if contact_size is None:
        contact_size = str(
            DEFAULT_AUDIT_ALL_SHEET_SIZE
            if args.audit_all
            else DEFAULT_CONTACT_SHEET_SIZE
        )
    try:
        args.contact_sheet_spec = parse_contact_sheet_spec(contact_size)
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    return args


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def nonnegative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def parse_contact_sheet_spec(value: str) -> ContactSheetSpec:
    text = str(value).strip()
    match = CANVAS_RE.fullmatch(text)
    if match:
        width, height = int(match.group(1)), int(match.group(2))
        if width < 640 or height < 480:
            raise argparse.ArgumentTypeError(
                "contact-sheet canvas must be at least 640x480"
            )
        # Each cell gets at least ~240x190 px, and one sheet is capped to avoid
        # turning a visual audit into an unreadable wall of thumbnails.
        capacity = max(1, min(64, (width // 240) * (height // 190)))
        return ContactSheetSpec(capacity, (width, height))
    return ContactSheetSpec(positive_int(text))


def scalar_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def portable_path(value: Any) -> str:
    return scalar_text(value).replace("\\", "/")


def field_value(
    raw: Mapping[str, Any], canonical: str
) -> tuple[bool, Any, str | None]:
    if canonical in raw:
        return True, raw[canonical], canonical
    for alias in FIELD_ALIASES.get(canonical, ()):
        if alias in raw:
            value = raw[alias]
            if canonical in {"work_id", "chapter_id"} and isinstance(value, Mapping):
                value = value.get("id", value.get("key", value.get("title")))
            return True, value, alias
    return False, None, None


def iter_jsonl(
    path: Path, issues: IssueCollector, manifest_name: str
) -> Iterator[tuple[int, dict[str, Any]]]:
    try:
        stream = path.open("rb")
    except OSError as exc:
        issues.add(
            "error",
            "manifest_unreadable",
            f"Could not open manifest: {exc}",
            path=str(path),
            manifest=manifest_name,
        )
        return
    with stream:
        for line_number, encoded in enumerate(stream, 1):
            if not encoded.strip():
                continue
            try:
                line = encoded.decode("utf-8-sig" if line_number == 1 else "utf-8")
            except UnicodeDecodeError as exc:
                issues.add(
                    "error",
                    "manifest_invalid_utf8",
                    f"Line is not valid UTF-8: {exc}",
                    line=line_number,
                    manifest=manifest_name,
                )
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                issues.add(
                    "error",
                    "manifest_invalid_json",
                    f"Invalid JSON: {exc.msg} at column {exc.colno}",
                    line=line_number,
                    manifest=manifest_name,
                )
                continue
            if not isinstance(value, dict):
                issues.add(
                    "error",
                    "manifest_row_not_object",
                    "Each JSONL row must be an object.",
                    line=line_number,
                    manifest=manifest_name,
                )
                continue
            yield line_number, value


def normalize_primary_rows(
    path: Path, issues: IssueCollector, manifest_name: str
) -> list[RowState]:
    rows: list[RowState] = []
    for line, raw in iter_jsonl(path, issues, manifest_name):
        row = RowState(line=line, manifest_name=manifest_name, raw=raw)
        for canonical in CANONICAL_FIELDS:
            present, value, source_key = field_value(raw, canonical)
            if not present:
                issues.add(
                    "error",
                    "missing_required_key",
                    f"Missing required key '{canonical}'.",
                    row=row,
                )
                continue
            row.values[canonical] = value
            if source_key != canonical and source_key is not None:
                row.aliases_used[canonical] = source_key

        for key in (
            "id",
            "image_path",
            "clip_image_path",
            "work_id",
            "chapter_id",
            "page_id",
            "split",
            "tier",
            "provenance",
            "orientation",
            "crop_sha256",
        ):
            if key in row.values and not scalar_text(row.values[key]):
                issues.add(
                    "error",
                    "empty_required_value",
                    f"Required value '{key}' is empty.",
                    row=row,
                )

        row.bbox = parse_bbox(row.values.get("bbox_px"), "bbox_px", row, issues)
        row.crop_bbox = parse_bbox(
            row.values.get("crop_bbox_px"), "crop_bbox_px", row, issues
        )
        if row.bbox is not None and row.crop_bbox is not None:
            if not bbox_contains(row.crop_bbox, row.bbox):
                issues.add(
                    "error",
                    "bbox_outside_crop",
                    "bbox_px must be fully contained by crop_bbox_px.",
                    row=row,
                )

        sha = scalar_text(row.values.get("crop_sha256")).lower()
        row.values["crop_sha256"] = sha
        if sha and not HEX_SHA256_RE.fullmatch(sha):
            issues.add(
                "error",
                "invalid_crop_sha256",
                "crop_sha256 must contain exactly 64 hexadecimal characters.",
                row=row,
            )

        tier = row.tier.upper()
        if tier and tier not in {"A", "B"}:
            issues.add(
                "warning",
                "unexpected_tier",
                f"Unexpected tier '{row.tier}' (expected A or B).",
                row=row,
            )
        orientation = row.orientation.lower()
        if orientation and orientation not in {"horizontal", "vertical"}:
            issues.add(
                "warning",
                "unexpected_orientation",
                (
                    f"Unexpected orientation '{row.orientation}' "
                    "(expected horizontal or vertical)."
                ),
                row=row,
            )
        rows.append(row)
    if not rows:
        issues.add(
            "error",
            "manifest_empty",
            "Primary manifest has no valid JSON object rows.",
            manifest=manifest_name,
        )
    return rows


def parse_bbox(
    value: Any, name: str, row: RowState, issues: IssueCollector
) -> tuple[int, int, int, int] | None:
    coords: Sequence[Any] | None = None
    if isinstance(value, (list, tuple)) and len(value) == 4:
        coords = value
    elif isinstance(value, Mapping):
        if all(key in value for key in ("x1", "y1", "x2", "y2")):
            coords = [value["x1"], value["y1"], value["x2"], value["y2"]]
        elif all(key in value for key in ("left", "top", "right", "bottom")):
            coords = [
                value["left"],
                value["top"],
                value["right"],
                value["bottom"],
            ]
        elif all(key in value for key in ("x", "y", "w", "h")):
            try:
                coords = [
                    value["x"],
                    value["y"],
                    float(value["x"]) + float(value["w"]),
                    float(value["y"]) + float(value["h"]),
                ]
            except (TypeError, ValueError):
                coords = None
    if coords is None:
        if value is not None:
            issues.add(
                "error",
                "invalid_bbox_shape",
                (
                    f"{name} must be [x1,y1,x2,y2] or an equivalent "
                    "coordinate object."
                ),
                row=row,
            )
        return None

    parsed: list[int] = []
    for coordinate in coords:
        if isinstance(coordinate, bool):
            parsed = []
            break
        try:
            number = float(coordinate)
        except (TypeError, ValueError):
            parsed = []
            break
        if not math.isfinite(number) or not number.is_integer():
            parsed = []
            break
        parsed.append(int(number))
    if len(parsed) != 4:
        issues.add(
            "error",
            "invalid_bbox_coordinate",
            f"{name} coordinates must be finite integer pixel values.",
            row=row,
        )
        return None
    x1, y1, x2, y2 = parsed
    if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
        issues.add(
            "error",
            "invalid_bbox_geometry",
            (
                f"{name} must have non-negative origin and positive area; "
                f"received [{x1},{y1},{x2},{y2}]."
            ),
            row=row,
        )
        return None
    return x1, y1, x2, y2


def bbox_contains(
    outer: tuple[int, int, int, int], inner: tuple[int, int, int, int]
) -> bool:
    return (
        outer[0] <= inner[0]
        and outer[1] <= inner[1]
        and outer[2] >= inner[2]
        and outer[3] >= inner[3]
    )


def resolve_asset(
    dataset_root: Path,
    value: Any,
    field_name: str,
    row: RowState,
    issues: IssueCollector,
) -> tuple[str, Path] | None:
    text = portable_path(value)
    if not text:
        return None
    candidate = Path(text)
    if candidate.is_absolute():
        issues.add(
            "error",
            "absolute_asset_path",
            f"{field_name} must be relative to the dataset directory.",
            row=row,
            path=text,
        )
        return None
    try:
        resolved = (dataset_root / candidate).resolve()
        resolved.relative_to(dataset_root.resolve())
    except (OSError, ValueError):
        issues.add(
            "error",
            "asset_path_outside_dataset",
            f"{field_name} escapes the dataset directory.",
            row=row,
            path=text,
        )
        return None
    return resolved.as_posix().casefold(), resolved


def inspect_asset(path: Path, relative_path: str) -> AssetInfo:
    info = AssetInfo(path=path, relative_path=relative_path)
    if not path.is_file():
        info.error = "file does not exist or is not a regular file"
        return info
    info.exists = True
    try:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        info.sha256 = digest.hexdigest()
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                info.width, info.height = image.size
                info.mode = image.mode
                info.image_format = image.format
                image.verify()
            # verify() checks the container, while load() forces pixel decode.
            with Image.open(path) as image:
                image.load()
                pixel_digest = hashlib.sha256()
                pixel_digest.update(image.mode.encode("ascii", "strict"))
                pixel_digest.update(b"\0")
                pixel_digest.update(str(image.size[0]).encode("ascii"))
                pixel_digest.update(b"x")
                pixel_digest.update(str(image.size[1]).encode("ascii"))
                pixel_digest.update(b"\0")
                pixel_digest.update(image.tobytes())
                info.pixel_sha256 = pixel_digest.hexdigest()
                if image.mode == "L":
                    plane = image.tobytes()
                    info.plane_sha256 = hashlib.sha256(plane).hexdigest()
                    colors = image.getcolors(maxcolors=257)
                    if colors is not None:
                        info.unique_values = tuple(
                            sorted(int(value) for _, value in colors)
                        )
                elif image.mode == "RGBA":
                    alpha = image.getchannel("A").tobytes()
                    info.alpha_sha256 = hashlib.sha256(alpha).hexdigest()
        if not info.width or not info.height:
            info.error = "decoded image has zero width or height"
            return info
        info.decodable = True
    except (
        OSError,
        ValueError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        info.error = f"{type(exc).__name__}: {exc}"
    return info


def collect_and_inspect_assets(
    dataset_root: Path, rows: Sequence[RowState], issues: IssueCollector
) -> dict[str, AssetInfo]:
    requested: dict[str, tuple[Path, str]] = {}
    users: defaultdict[str, list[tuple[RowState, str]]] = defaultdict(list)
    for row in rows:
        for field_name, attribute in (
            ("image_path", "image_asset_key"),
            ("clip_image_path", "clip_asset_key"),
        ):
            resolved = resolve_asset(
                dataset_root, row.values.get(field_name), field_name, row, issues
            )
            if resolved is None:
                continue
            key, path = resolved
            setattr(row, attribute, key)
            relative = path.relative_to(dataset_root.resolve()).as_posix()
            requested[key] = (path, relative)
            users[key].append((row, field_name))

    assets: dict[str, AssetInfo] = {}
    worker_count = min(8, max(1, (os.cpu_count() or 2)))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_key = {
            executor.submit(inspect_asset, path, relative): key
            for key, (path, relative) in requested.items()
        }
        for future in as_completed(future_to_key):
            key = future_to_key[future]
            try:
                assets[key] = future.result()
            except Exception as exc:  # defensive isolation for one bad decoder
                path, relative = requested[key]
                assets[key] = AssetInfo(
                    path=path,
                    relative_path=relative,
                    error=f"unexpected inspection failure: {type(exc).__name__}: {exc}",
                )

    for key, asset in assets.items():
        if asset.decodable:
            continue
        first_row, field_name = users[key][0]
        code = "asset_missing" if not asset.exists else "asset_decode_failed"
        issues.add(
            "error",
            code,
            f"{field_name}: {asset.error}",
            row=first_row,
            path=asset.relative_path,
        )
        for row, _ in users[key][1:]:
            row.error_codes.add(code)
    return assets


def validate_row_assets(
    rows: Sequence[RowState],
    assets: Mapping[str, AssetInfo],
    issues: IssueCollector,
    contract: DatasetContract,
) -> None:
    for row in rows:
        raw_asset = assets.get(row.image_asset_key or "")
        clip_asset = assets.get(row.clip_asset_key or "")
        if raw_asset is not None and raw_asset.decodable and row.crop_bbox is not None:
            x1, y1, x2, y2 = row.crop_bbox
            expected = x2 - x1, y2 - y1
            if raw_asset.size != expected:
                issues.add(
                    "error",
                    "raw_crop_size_mismatch",
                    (
                        f"Decoded raw crop is {format_size(raw_asset.size)}, but "
                        f"crop_bbox_px requires {expected[0]}x{expected[1]}."
                    ),
                    row=row,
                    path=raw_asset.relative_path,
                )
        if clip_asset is not None and clip_asset.decodable:
            if clip_asset.size != contract.clip_size:
                issues.add(
                    "error",
                    "clip_size_mismatch",
                    (
                        f"CLIP image must be {format_size(contract.clip_size)}; decoded "
                        f"{format_size(clip_asset.size)}."
                    ),
                    row=row,
                    path=clip_asset.relative_path,
                )

        validate_declared_dimensions(row, raw_asset, "image", issues)
        validate_declared_dimensions(row, clip_asset, "clip", issues)

        declared_sha = scalar_text(row.values.get("crop_sha256")).lower()
        if declared_sha and HEX_SHA256_RE.fullmatch(declared_sha):
            actual_pixel_hash = (
                raw_asset.pixel_sha256 if raw_asset is not None else None
            )
            if actual_pixel_hash and declared_sha != actual_pixel_hash:
                issues.add(
                    "error",
                    "crop_sha256_mismatch",
                    (
                        "crop_sha256 does not match the native crop's decoded "
                        "mode, dimensions, and pixel bytes."
                    ),
                    row=row,
                )

        validate_page_and_crop_sizes(row, raw_asset, issues)


def validate_declared_dimensions(
    row: RowState,
    asset: AssetInfo | None,
    asset_kind: str,
    issues: IssueCollector,
) -> None:
    if asset is None or not asset.decodable:
        return
    for width_key, height_key in DIMENSION_FIELD_PAIRS[asset_kind]:
        if width_key not in row.raw and height_key not in row.raw:
            continue
        try:
            declared = int(row.raw[width_key]), int(row.raw[height_key])
        except (KeyError, TypeError, ValueError):
            issues.add(
                "error",
                "invalid_declared_image_size",
                f"{width_key}/{height_key} must be integer dimensions.",
                row=row,
            )
            continue
        if asset.size != declared:
            issues.add(
                "error",
                "declared_image_size_mismatch",
                (
                    f"{width_key}/{height_key} says {declared[0]}x{declared[1]}, "
                    f"but the image decodes as {format_size(asset.size)}."
                ),
                row=row,
                path=asset.relative_path,
            )


def validate_page_and_crop_sizes(
    row: RowState,
    raw_asset: AssetInfo | None,
    issues: IssueCollector,
) -> None:
    crop_size = parse_size_pair(row.raw.get("crop_size_px"))
    if "crop_size_px" in row.raw and crop_size is None:
        issues.add(
            "error",
            "invalid_crop_size_px",
            "crop_size_px must be [width,height] with positive integers.",
            row=row,
        )
    elif crop_size is not None:
        if raw_asset is not None and raw_asset.decodable and raw_asset.size != crop_size:
            issues.add(
                "error",
                "crop_size_px_mismatch",
                (
                    f"crop_size_px says {format_size(crop_size)}, but the raw "
                    f"crop decodes as {format_size(raw_asset.size)}."
                ),
                row=row,
                path=raw_asset.relative_path,
            )
        if row.crop_bbox is not None:
            x1, y1, x2, y2 = row.crop_bbox
            bbox_size = x2 - x1, y2 - y1
            if crop_size != bbox_size:
                issues.add(
                    "error",
                    "crop_size_bbox_mismatch",
                    (
                        f"crop_size_px is {format_size(crop_size)}, but "
                        f"crop_bbox_px spans {format_size(bbox_size)}."
                    ),
                    row=row,
                )

    page_size = parse_size_pair(row.raw.get("page_size_px"))
    if "page_size_px" in row.raw and page_size is None:
        issues.add(
            "error",
            "invalid_page_size_px",
            "page_size_px must be [width,height] with positive integers.",
            row=row,
        )
    elif page_size is not None:
        for name, bbox in (("bbox_px", row.bbox), ("crop_bbox_px", row.crop_bbox)):
            if bbox is not None and (bbox[2] > page_size[0] or bbox[3] > page_size[1]):
                issues.add(
                    "error",
                    "bbox_outside_page",
                    (
                        f"{name} extends outside page_size_px "
                        f"{format_size(page_size)}."
                    ),
                    row=row,
                )


def parse_size_pair(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    if any(isinstance(part, bool) for part in value):
        return None
    try:
        width, height = int(value[0]), int(value[1])
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    try:
        if float(value[0]) != width or float(value[1]) != height:
            return None
    except (TypeError, ValueError):
        return None
    return width, height


def format_size(size: tuple[int, int] | None) -> str:
    return "unknown" if size is None else f"{size[0]}x{size[1]}"


def validate_dataset_relations(
    rows: Sequence[RowState],
    assets: Mapping[str, AssetInfo],
    issues: IssueCollector,
    contract: DatasetContract,
) -> None:
    ids: defaultdict[str, list[RowState]] = defaultdict(list)
    image_paths: defaultdict[str, list[RowState]] = defaultdict(list)
    clip_paths: defaultdict[str, list[RowState]] = defaultdict(list)
    declared_hashes: defaultdict[str, list[RowState]] = defaultdict(list)
    actual_raw_hashes: defaultdict[str, list[RowState]] = defaultdict(list)
    chapters_by_work: defaultdict[str, set[str]] = defaultdict(set)
    splits_by_work: defaultdict[str, set[str]] = defaultdict(set)

    for row in rows:
        if row.sample_id:
            ids[row.sample_id].append(row)
        image_key = row.image_asset_key or portable_path(
            row.values.get("image_path")
        ).casefold()
        if image_key:
            image_paths[image_key].append(row)
            asset = assets.get(row.image_asset_key)
            if asset and asset.pixel_sha256:
                actual_raw_hashes[asset.pixel_sha256].append(row)
        clip_key = row.clip_asset_key or portable_path(
            row.values.get("clip_image_path")
        ).casefold()
        if clip_key:
            clip_paths[clip_key].append(row)
        sha = scalar_text(row.values.get("crop_sha256")).lower()
        if HEX_SHA256_RE.fullmatch(sha):
            declared_hashes[sha].append(row)
        if row.work_id and row.chapter_id:
            chapters_by_work[row.work_id].add(row.chapter_id)
        if row.work_id and row.split:
            splits_by_work[row.work_id].add(row.split)

    report_duplicate_groups(ids, "duplicate_id", "sample id", issues)
    report_duplicate_groups(
        image_paths, "duplicate_image_path", "native crop path", issues
    )
    report_duplicate_groups(
        clip_paths, "duplicate_clip_image_path", "CLIP image path", issues
    )
    report_duplicate_groups(
        declared_hashes, "duplicate_crop_sha256", "declared crop SHA-256", issues
    )
    # This catches duplicate crop bytes even when one row's declared digest is
    # incorrect or uses the CLIP representation's digest.
    report_duplicate_groups(
        actual_raw_hashes,
        "duplicate_raw_image_content",
        "decoded native crop content",
        issues,
    )

    for work_id, chapters in sorted(chapters_by_work.items()):
        if len(chapters) > contract.max_chapters_per_work:
            issues.add(
                "error",
                "work_chapter_limit_exceeded",
                (
                    f"Work '{work_id}' contains {len(chapters)} chapters; "
                    f"the maximum is {contract.max_chapters_per_work}."
                ),
                sample_id=work_id,
            )
    for work_id, splits in sorted(splits_by_work.items()):
        if len(splits) > 1:
            issues.add(
                "error",
                "work_split_leakage",
                (
                    f"Work '{work_id}' appears in multiple splits: "
                    f"{', '.join(sorted(splits))}."
                ),
                sample_id=work_id,
            )


def report_duplicate_groups(
    groups: Mapping[str, Sequence[RowState]],
    code: str,
    label: str,
    issues: IssueCollector,
) -> None:
    for value, duplicate_rows in sorted(groups.items()):
        if len(duplicate_rows) <= 1:
            continue
        lines = ", ".join(str(row.line) for row in duplicate_rows[:8])
        if len(duplicate_rows) > 8:
            lines += ", ..."
        issues.add(
            "error",
            code,
            f"Duplicate {label} '{value}' on manifest lines {lines}.",
            row=duplicate_rows[0],
        )
        for row in duplicate_rows[1:]:
            row.error_codes.add(code)


def discover_auxiliary_manifests(
    dataset_root: Path, primary_path: Path
) -> list[Path]:
    manifests: list[Path] = []
    for path in sorted(dataset_root.rglob("*.jsonl"), key=lambda item: item.as_posix()):
        if path.resolve() == primary_path.resolve():
            continue
        try:
            relative = path.relative_to(dataset_root)
        except ValueError:
            continue
        if "qa" in {part.casefold() for part in relative.parts}:
            continue
        manifests.append(path)
    return manifests


def validate_auxiliary_manifests(
    dataset_root: Path,
    primary_path: Path,
    rows: Sequence[RowState],
    issues: IssueCollector,
    *,
    skip_names: set[str] | None = None,
) -> list[dict[str, Any]]:
    primary_by_id = {row.sample_id: row for row in rows if row.sample_id}
    primary_ids = set(primary_by_id)
    primary_relative = primary_path.relative_to(dataset_root).as_posix().casefold()
    primary_is_fallback = "fallback" in primary_relative
    primary_rank = manifest_specificity_rank(primary_path)
    skipped = {name.casefold() for name in (skip_names or set())}
    summaries: list[dict[str, Any]] = []
    for path in discover_auxiliary_manifests(dataset_root, primary_path):
        name = path.relative_to(dataset_root).as_posix()
        if name.casefold() in skipped or path.name.casefold() in skipped:
            continue
        parsed = list(iter_jsonl(path, issues, name))
        summary: dict[str, Any] = {"path": name, "rows": len(parsed)}
        sample_like = [
            (line, raw)
            for line, raw in parsed
            if field_value(raw, "id")[0]
            and (
                field_value(raw, "image_path")[0]
                or field_value(raw, "clip_image_path")[0]
            )
        ]
        if not sample_like:
            summary["kind"] = "metadata"
            summaries.append(summary)
            continue

        lowered = name.casefold()
        is_fallback = "fallback" in Path(lowered).parts or "fallback" in lowered
        if primary_is_fallback != is_fallback:
            summary["kind"] = "out_of_scope_sample_manifest"
            summary["unique_ids"] = len(
                {
                    scalar_text(field_value(raw, "id")[1])
                    for _, raw in sample_like
                    if scalar_text(field_value(raw, "id")[1])
                }
            )
            summaries.append(summary)
            continue
        summary["kind"] = "fallback" if is_fallback else "subset"
        auxiliary_rank = manifest_specificity_rank(path)
        allow_auxiliary_extras = (
            primary_rank is not None
            and auxiliary_rank is not None
            and auxiliary_rank < primary_rank
        )
        ids: list[str] = []
        seen: set[str] = set()
        for line, raw in sample_like:
            _, raw_id, _ = field_value(raw, "id")
            sample_id = scalar_text(raw_id)
            ids.append(sample_id)
            if not sample_id:
                issues.add(
                    "error",
                    "auxiliary_missing_id",
                    "Sample-like auxiliary manifest row has an empty id.",
                    line=line,
                    manifest=name,
                )
                continue
            if sample_id in seen:
                issues.add(
                    "error",
                    "auxiliary_duplicate_id",
                    f"Duplicate id '{sample_id}' in auxiliary manifest.",
                    line=line,
                    sample_id=sample_id,
                    manifest=name,
                )
            seen.add(sample_id)
            if sample_id not in primary_ids and not allow_auxiliary_extras:
                issues.add(
                    "error",
                    "auxiliary_unknown_id",
                    f"Auxiliary manifest references unknown id '{sample_id}'.",
                    line=line,
                    sample_id=sample_id,
                    manifest=name,
                )
            elif sample_id in primary_ids:
                check_auxiliary_row_matches_primary(
                    raw, primary_by_id[sample_id], line, name, issues
                )

        id_set = {sample_id for sample_id in ids if sample_id}
        file_stem = path.stem.casefold()
        if (
            allow_auxiliary_extras
            and file_stem in {"manifest", "manifest_masked"}
            and not primary_ids.issubset(id_set)
        ):
            issues.add(
                "error",
                "auxiliary_superset_missing_primary_ids",
                (
                    f"{name} should be a superset of the selected primary "
                    f"manifest but is missing {len(primary_ids - id_set)} id(s)."
                ),
                manifest=name,
            )
        if (
            primary_rank == 0
            and file_stem in {"all", "manifest_all"}
            and id_set != primary_ids
        ):
            issues.add(
                "error",
                "all_manifest_membership_mismatch",
                (
                    f"{name} does not contain exactly the primary manifest ids "
                    f"(missing={len(primary_ids - id_set)}, "
                    f"extra={len(id_set - primary_ids)})."
                ),
                manifest=name,
            )
        split_name = file_stem.removeprefix("manifest_")
        if (
            primary_rank == 0
            and split_name in {"train", "val", "validation", "test"}
        ):
            normalized_split = "val" if split_name == "validation" else split_name
            expected = {
                row.sample_id
                for row in rows
                if row.split.casefold() == normalized_split and row.sample_id
            }
            if id_set != expected:
                issues.add(
                    "error",
                    "split_manifest_membership_mismatch",
                    (
                        f"{name} membership differs from split "
                        f"'{normalized_split}' (missing={len(expected - id_set)}, "
                        f"extra={len(id_set - expected)})."
                    ),
                    manifest=name,
                )
        if file_stem == "manifest_high_precision":
            non_a = [
                sample_id
                for sample_id in id_set
                if primary_by_id.get(sample_id)
                and primary_by_id[sample_id].tier.upper() != "A"
            ]
            if non_a:
                issues.add(
                    "error",
                    "high_precision_contains_non_a",
                    (
                        f"{name} contains {len(non_a)} sample(s) outside tier A."
                    ),
                    manifest=name,
                )
        summary["unique_ids"] = len(id_set)
        summaries.append(summary)
    return summaries


def manifest_specificity_rank(path: Path) -> int | None:
    stem = path.stem.casefold()
    if stem == "manifest_masked_high_precision":
        return 2
    if stem == "manifest_masked":
        return 1
    if stem == "manifest" or stem in {
        "all",
        "manifest_all",
        "train",
        "val",
        "validation",
        "test",
    }:
        return 0
    return None


def check_auxiliary_row_matches_primary(
    raw: Mapping[str, Any],
    primary: RowState,
    line: int,
    manifest: str,
    issues: IssueCollector,
) -> None:
    for canonical in (
        "image_path",
        "clip_image_path",
        "work_id",
        "chapter_id",
        "split",
        "tier",
        "orientation",
        "crop_sha256",
    ):
        present, value, _ = field_value(raw, canonical)
        if not present:
            continue
        left = portable_path(value) if canonical.endswith("_path") else scalar_text(value)
        right_value = primary.values.get(canonical)
        right = (
            portable_path(right_value)
            if canonical.endswith("_path")
            else scalar_text(right_value)
        )
        if canonical == "crop_sha256":
            left, right = left.lower(), right.lower()
        if left != right:
            issues.add(
                "error",
                "auxiliary_row_mismatch",
                (
                    f"Field '{canonical}' for id '{primary.sample_id}' differs "
                    "from the primary manifest."
                ),
                line=line,
                sample_id=primary.sample_id,
                manifest=manifest,
            )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_id_manifest(
    path: Path,
    dataset_root: Path,
    issues: IssueCollector,
    *,
    code_prefix: str,
) -> tuple[dict[str, dict[str, Any]], str]:
    name = path.relative_to(dataset_root).as_posix()
    if not path.is_file():
        issues.add(
            "error",
            f"{code_prefix}_manifest_missing",
            f"Required mask-review manifest is missing: {name}",
            path=name,
            manifest=name,
        )
        return {}, ""
    try:
        signature = file_sha256(path)
    except OSError as exc:
        issues.add(
            "error",
            f"{code_prefix}_manifest_unreadable",
            f"Could not hash {name}: {exc}",
            path=name,
            manifest=name,
        )
        signature = ""
    records: dict[str, dict[str, Any]] = {}
    for line, raw in iter_jsonl(path, issues, name):
        sample_id = scalar_text(raw.get("id"))
        if not sample_id:
            issues.add(
                "error",
                f"{code_prefix}_missing_id",
                "Mask manifest row has no id.",
                line=line,
                manifest=name,
            )
            continue
        if sample_id in records:
            issues.add(
                "error",
                f"{code_prefix}_duplicate_id",
                f"Duplicate id '{sample_id}'.",
                line=line,
                sample_id=sample_id,
                manifest=name,
            )
            continue
        records[sample_id] = raw
    return records, signature


def load_reject_manifest(
    path: Path,
    dataset_root: Path,
    issues: IssueCollector,
) -> tuple[dict[str, dict[str, Any]], str, int]:
    name = path.relative_to(dataset_root).as_posix()
    if not path.is_file():
        issues.add(
            "error",
            "mask_rejects_manifest_missing",
            f"Required mask-review manifest is missing: {name}",
            path=name,
            manifest=name,
        )
        return {}, "", 0
    try:
        signature = file_sha256(path)
    except OSError as exc:
        issues.add(
            "error",
            "mask_rejects_manifest_unreadable",
            f"Could not hash {name}: {exc}",
            path=name,
            manifest=name,
        )
        signature = ""
    records: dict[str, dict[str, Any]] = {}
    unidentified = 0
    for line, raw in iter_jsonl(path, issues, name):
        nested = raw.get("row")
        sample_id = scalar_text(nested.get("id")) if isinstance(nested, Mapping) else ""
        if not sample_id:
            unidentified += 1
            issues.add(
                "error",
                "mask_reject_without_input_id",
                "Reject row cannot be joined to a primary manifest id.",
                line=line,
                manifest=name,
            )
            continue
        if sample_id in records:
            issues.add(
                "error",
                "mask_reject_duplicate_id",
                f"More than one reject row exists for id '{sample_id}'.",
                line=line,
                sample_id=sample_id,
                manifest=name,
            )
            continue
        records[sample_id] = raw
    return records, signature, unidentified


def validate_mask_review(
    dataset_root: Path,
    library_root: Path,
    rows: Sequence[RowState],
    validation_rows: Sequence[RowState],
    issues: IssueCollector,
) -> MaskReviewResult:
    masked_path = dataset_root / MASK_MANIFEST_NAME
    hp_path = dataset_root / MASK_HIGH_PRECISION_NAME
    rejects_path = dataset_root / MASK_REJECTS_NAME
    masked, masked_signature = load_id_manifest(
        masked_path, dataset_root, issues, code_prefix="masked"
    )
    high_precision, hp_signature = load_id_manifest(
        hp_path, dataset_root, issues, code_prefix="mask_high_precision"
    )
    rejects, rejects_signature, unidentified_rejects = load_reject_manifest(
        rejects_path, dataset_root, issues
    )
    signatures = {
        MASK_MANIFEST_NAME: masked_signature,
        MASK_HIGH_PRECISION_NAME: hp_signature,
        MASK_REJECTS_NAME: rejects_signature,
    }
    if not all(path.is_file() for path in (masked_path, hp_path, rejects_path)):
        for row in rows:
            row.mask_join = MaskJoin()
        return MaskReviewResult(
            masked_count=len(masked),
            high_precision_count=len(high_precision),
            reject_count=len(rejects) + unidentified_rejects,
            extraction_reject_count=0,
            assets={},
            manifest_signatures=signatures,
        )

    primary_by_id = {row.sample_id: row for row in rows if row.sample_id}
    primary_ids = set(primary_by_id)
    masked_ids = set(masked)
    hp_ids = set(high_precision)
    reject_ids = set(rejects)

    report_membership_difference(
        masked_ids - primary_ids,
        "masked_unknown_id",
        "masked manifest",
        issues,
    )
    report_membership_difference(
        hp_ids - masked_ids,
        "mask_high_precision_not_masked",
        "high-precision manifest",
        issues,
    )
    report_membership_difference(
        reject_ids - primary_ids,
        "mask_reject_unknown_id",
        "mask reject manifest",
        issues,
    )

    for sample_id in sorted(hp_ids & masked_ids):
        if high_precision[sample_id] != masked[sample_id]:
            issues.add(
                "error",
                "mask_high_precision_row_mismatch",
                (
                    f"High-precision row '{sample_id}' is not byte-semantically "
                    "identical to its masked record."
                ),
                sample_id=sample_id,
                manifest=MASK_HIGH_PRECISION_NAME,
            )

    extraction_reject_count = 0
    for row in rows:
        sample_id = row.sample_id
        if not sample_id:
            continue
        masked_record = masked.get(sample_id)
        hp_record = high_precision.get(sample_id)
        reject = rejects.get(sample_id)
        stage = scalar_text(reject.get("stage")) if reject else ""
        extraction_reject = stage in {
            "input",
            "page_inference",
            "mask_extraction",
        }
        if extraction_reject:
            extraction_reject_count += 1

        row.mask_join = MaskJoin(
            record=masked_record,
            reject=reject,
            high_precision=hp_record is not None,
        )

        if (masked_record is not None) == extraction_reject:
            issues.add(
                "error",
                "mask_input_output_not_one_to_one",
                (
                    "Each primary row must produce exactly one masked record "
                    "or one input/page/mask extraction reject."
                ),
                row=row,
            )
        if (hp_record is not None) == (reject is not None):
            issues.add(
                "error",
                "mask_hp_reject_not_one_to_one",
                (
                    "Each primary row must appear in exactly one of the "
                    "high-precision or reject manifests."
                ),
                row=row,
            )
        if masked_record is not None and hp_record is None and stage != "high_precision_gate":
            issues.add(
                "error",
                "masked_non_hp_missing_gate_reject",
                "A masked non-HP row must have one high_precision_gate reject.",
                row=row,
            )
        if hp_record is not None:
            gate = hp_record.get("mask_quality_gate")
            if (
                hp_record.get("mask_high_precision") is not True
                or not isinstance(gate, Mapping)
                or gate.get("passed") is not True
            ):
                issues.add(
                    "error",
                    "mask_hp_gate_inconsistent",
                    "High-precision row does not record a passed quality gate.",
                    row=row,
                )
        if reject is not None:
            try:
                reject_line = int(reject.get("line_number"))
            except (TypeError, ValueError):
                reject_line = -1
            if reject_line != row.line:
                issues.add(
                    "error",
                    "mask_reject_line_mismatch",
                    (
                        f"Reject line_number is {reject_line}, expected "
                        f"primary line {row.line}."
                    ),
                    row=row,
                )
        if masked_record is not None:
            validate_mask_record_metadata(
                row, masked_record, library_root, issues
            )
        else:
            resolve_mask_source_page(row, None, library_root, issues)

    if len(high_precision) + len(rejects) + unidentified_rejects != len(rows):
        issues.add(
            "error",
            "mask_manifest_total_mismatch",
            (
                "high-precision plus reject row count must equal the primary "
                f"manifest ({len(high_precision)} + {len(rejects) + unidentified_rejects} "
                f"!= {len(rows)})."
            ),
        )
    if len(masked) + extraction_reject_count != len(rows):
        issues.add(
            "error",
            "mask_extraction_total_mismatch",
            (
                "masked plus extraction-reject count must equal the primary "
                f"manifest ({len(masked)} + {extraction_reject_count} "
                f"!= {len(rows)})."
            ),
        )

    validate_mask_model_contract(masked, issues)
    assets = inspect_mask_review_assets(
        dataset_root, validation_rows, issues
    )
    validate_mask_asset_contracts(validation_rows, assets, issues)
    validate_review_source_pages(validation_rows, library_root, issues)
    return MaskReviewResult(
        masked_count=len(masked),
        high_precision_count=len(high_precision),
        reject_count=len(rejects) + unidentified_rejects,
        extraction_reject_count=extraction_reject_count,
        assets=assets,
        manifest_signatures=signatures,
    )


def validate_mask_model_contract(
    masked: Mapping[str, Mapping[str, Any]],
    issues: IssueCollector,
) -> None:
    v2_records: list[tuple[str, Mapping[str, Any]]] = []
    for sample_id, record in masked.items():
        try:
            schema = int(record.get("mask_schema_version", 1))
        except (TypeError, ValueError):
            schema = 1
        if schema >= 2:
            v2_records.append((sample_id, record))
    if not v2_records:
        return
    first_id, first = v2_records[0]
    first_model = first.get("mask_model")
    if not isinstance(first_model, Mapping):
        issues.add(
            "error",
            "mask_model_metadata_missing",
            "Schema v2 masked rows require mask_model metadata.",
            sample_id=first_id,
        )
        return
    baseline = json.dumps(
        first_model, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    for sample_id, record in v2_records[1:]:
        model = record.get("mask_model")
        serialized = (
            json.dumps(
                model,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            if isinstance(model, Mapping)
            else ""
        )
        if serialized != baseline:
            issues.add(
                "error",
                "mask_model_metadata_inconsistent",
                "mask_model metadata differs between masked rows.",
                sample_id=sample_id,
            )
            break

    signatures = first_model.get("content_signatures")
    if not isinstance(signatures, Mapping):
        issues.add(
            "error",
            "mask_model_signatures_missing",
            "mask_model.content_signatures is required for schema v2.",
            sample_id=first_id,
        )
        return
    aliases = {
        "model": "model_sha256",
        "config": "config_sha256",
        "preprocessor": "preprocessor_sha256",
    }
    for kind, alias in aliases.items():
        signature = signatures.get(kind)
        if signature is None and kind != "model":
            if first_model.get(alias) is not None:
                issues.add(
                    "error",
                    "mask_model_signature_alias_mismatch",
                    f"{alias} must be null when {kind} signature is absent.",
                    sample_id=first_id,
                )
            continue
        if not isinstance(signature, Mapping):
            issues.add(
                "error",
                "mask_model_signature_invalid",
                f"Invalid {kind} content signature.",
                sample_id=first_id,
            )
            continue
        path_text = scalar_text(signature.get("path"))
        expected_hash = scalar_text(signature.get("sha256")).lower()
        try:
            expected_size = int(signature.get("size"))
        except (TypeError, ValueError):
            expected_size = -1
        path = Path(path_text).expanduser().resolve() if path_text else Path()
        if (
            not path_text
            or not path.is_file()
            or not HEX_SHA256_RE.fullmatch(expected_hash)
            or expected_size < 0
        ):
            issues.add(
                "error",
                "mask_model_signature_target_invalid",
                f"Invalid or missing {kind} signature target.",
                sample_id=first_id,
                path=path_text or None,
            )
            continue
        try:
            actual_hash = file_sha256(path)
            actual_size = path.stat().st_size
        except OSError as exc:
            issues.add(
                "error",
                "mask_model_signature_read_failed",
                f"Could not verify {kind} signature: {exc}",
                sample_id=first_id,
                path=str(path),
            )
            continue
        if (
            actual_hash != expected_hash
            or actual_size != expected_size
            or scalar_text(first_model.get(alias)).lower() != expected_hash
        ):
            issues.add(
                "error",
                "mask_model_signature_mismatch",
                f"{kind} content signature or alias hash is mismatched.",
                sample_id=first_id,
                path=str(path),
            )


def report_membership_difference(
    ids: set[str],
    code: str,
    label: str,
    issues: IssueCollector,
) -> None:
    if not ids:
        return
    preview = ", ".join(sorted(ids)[:8])
    suffix = f", ... (+{len(ids) - 8})" if len(ids) > 8 else ""
    issues.add(
        "error",
        code,
        f"{label} contains {len(ids)} unknown id(s): {preview}{suffix}",
    )


def validate_mask_record_metadata(
    row: RowState,
    record: Mapping[str, Any],
    library_root: Path,
    issues: IssueCollector,
) -> None:
    for key in (
        "image_path",
        "clip_image_path",
        "work_id",
        "chapter_id",
        "page_id",
        "split",
        "tier",
        "orientation",
        "crop_sha256",
    ):
        left = (
            portable_path(record.get(key))
            if key.endswith("_path")
            else scalar_text(record.get(key))
        )
        right = (
            portable_path(row.values.get(key))
            if key.endswith("_path")
            else scalar_text(row.values.get(key))
        )
        if left != right:
            issues.add(
                "error",
                "masked_primary_row_mismatch",
                f"Masked field '{key}' differs from the primary manifest.",
                row=row,
            )

    join = row.mask_join
    if join is None:
        return
    box_fields = (
        "raw_bbox_px",
        "source_crop_bbox_px",
        "ctd_ocr_bbox_px",
        "ctd_tight_bbox_px",
        "mask_tight_bbox_px",
        "ctd_tight_bbox_local_px",
        "masked_context_bbox_px",
        "final_bbox_px",
    )
    for name in box_fields:
        if name not in record:
            issues.add(
                "error",
                "masked_missing_bbox",
                f"Masked record is missing '{name}'.",
                row=row,
            )
            continue
        parsed = parse_bbox(record.get(name), name, row, issues)
        if parsed is not None:
            join.boxes[name] = parsed

    raw_bbox = join.boxes.get("raw_bbox_px")
    source_crop = join.boxes.get("source_crop_bbox_px")
    ocr_bbox = join.boxes.get("ctd_ocr_bbox_px")
    tight = join.boxes.get("ctd_tight_bbox_px")
    tight_alias = join.boxes.get("mask_tight_bbox_px")
    tight_local = join.boxes.get("ctd_tight_bbox_local_px")
    context = join.boxes.get("masked_context_bbox_px")
    final = join.boxes.get("final_bbox_px")
    if raw_bbox is not None and row.bbox is not None and raw_bbox != row.bbox:
        issues.add(
            "error",
            "masked_raw_bbox_mismatch",
            "raw_bbox_px differs from primary bbox_px.",
            row=row,
        )
    if (
        source_crop is not None
        and row.crop_bbox is not None
        and source_crop != row.crop_bbox
    ):
        issues.add(
            "error",
            "masked_source_crop_bbox_mismatch",
            "source_crop_bbox_px differs from primary crop_bbox_px.",
            row=row,
        )
    if tight is not None and tight_alias is not None and tight != tight_alias:
        issues.add(
            "error",
            "masked_tight_bbox_alias_mismatch",
            "ctd_tight_bbox_px and mask_tight_bbox_px differ.",
            row=row,
        )
    if context is not None and final is not None and context != final:
        issues.add(
            "error",
            "masked_context_bbox_alias_mismatch",
            "masked_context_bbox_px and final_bbox_px differ.",
            row=row,
        )
    if ocr_bbox is not None and tight is not None and not bbox_contains(
        ocr_bbox, tight
    ):
        issues.add(
            "error",
            "masked_tight_outside_ocr",
            "CTD tight bbox must be contained by the CTD OCR bbox.",
            row=row,
        )
    if tight is not None and context is not None and not bbox_contains(
        context, tight
    ):
        issues.add(
            "error",
            "masked_tight_outside_context",
            "CTD tight bbox must be contained by the masked context bbox.",
            row=row,
        )
    if ocr_bbox is not None and tight is not None and tight_local is not None:
        expected_local = (
            tight[0] - ocr_bbox[0],
            tight[1] - ocr_bbox[1],
            tight[2] - ocr_bbox[0],
            tight[3] - ocr_bbox[1],
        )
        if tight_local != expected_local:
            issues.add(
                "error",
                "masked_local_bbox_mismatch",
                "ctd_tight_bbox_local_px is not relative to ctd_ocr_bbox_px.",
                row=row,
            )

    glyph_size = parse_size_pair(record.get("glyph_size_px"))
    if glyph_size is None:
        issues.add(
            "error",
            "masked_invalid_glyph_size",
            "glyph_size_px must be a positive [width,height] pair.",
            row=row,
        )
    elif tight is not None and glyph_size != (
        tight[2] - tight[0],
        tight[3] - tight[1],
    ):
        issues.add(
            "error",
            "masked_glyph_bbox_size_mismatch",
            "glyph_size_px differs from the tight bbox extent.",
            row=row,
        )

    page_size = parse_size_pair(row.raw.get("page_size_px"))
    if page_size is not None:
        for name, box in join.boxes.items():
            if name.endswith("_local_px"):
                continue
            if box[2] > page_size[0] or box[3] > page_size[1]:
                issues.add(
                    "error",
                    "masked_bbox_outside_page",
                    f"{name} extends outside page_size_px.",
                    row=row,
                )
        if tight is not None and context is not None:
            expected_padding = max(
                2, min(8, int(round((tight[3] - tight[1]) * 0.08)))
            )
            try:
                declared_padding = int(record.get("masked_context_padding_px"))
            except (TypeError, ValueError):
                declared_padding = -1
            expected_context = (
                max(0, tight[0] - expected_padding),
                max(0, tight[1] - expected_padding),
                min(page_size[0], tight[2] + expected_padding),
                min(page_size[1], tight[3] + expected_padding),
            )
            if declared_padding != expected_padding or context != expected_context:
                issues.add(
                    "error",
                    "masked_context_padding_mismatch",
                    (
                        "masked context bbox/padding does not match the "
                        "tight-bbox expansion contract."
                    ),
                    row=row,
                )
    resolve_mask_source_page(row, record, library_root, issues)


def resolve_mask_source_page(
    row: RowState,
    record: Mapping[str, Any] | None,
    library_root: Path,
    issues: IssueCollector,
) -> None:
    join = row.mask_join
    if join is None:
        return
    relative = portable_path(
        (record or {}).get("source_page_path")
        or row.raw.get("source_image_path")
    )
    if not relative:
        issues.add(
            "error",
            "mask_source_page_missing",
            "No library-relative source page path is available.",
            row=row,
        )
        return
    candidate = Path(relative)
    if candidate.is_absolute():
        issues.add(
            "error",
            "mask_source_page_not_relative",
            "Source page path must be relative to --library.",
            row=row,
            path=relative,
        )
        return
    resolved = (library_root / candidate).resolve()
    try:
        resolved.relative_to(library_root.resolve())
    except ValueError:
        issues.add(
            "error",
            "mask_source_page_outside_library",
            "Source page path escapes --library.",
            row=row,
            path=relative,
        )
        return
    join.page_path = resolved


def inspect_mask_review_assets(
    dataset_root: Path,
    rows: Sequence[RowState],
    issues: IssueCollector,
) -> dict[str, AssetInfo]:
    requested: dict[str, tuple[Path, str]] = {}
    users: defaultdict[str, list[tuple[RowState, str]]] = defaultdict(list)
    path_owners: defaultdict[str, list[tuple[RowState, str]]] = defaultdict(list)
    for row in rows:
        join = row.mask_join
        if join is None or join.record is None:
            continue
        record = join.record
        mask_paths = record.get("mask_paths")
        final_paths = record.get("final_image_paths")
        if not isinstance(mask_paths, Mapping):
            issues.add(
                "error",
                "mask_paths_invalid",
                "mask_paths must be an object with all five assets.",
                row=row,
            )
            continue
        if not isinstance(final_paths, Mapping) or dict(final_paths) != dict(mask_paths):
            issues.add(
                "error",
                "final_mask_paths_mismatch",
                "final_image_paths must exactly equal mask_paths.",
                row=row,
            )
        aliases = {
            "context": "masked_context_path",
            "glyph_rgba": "glyph_rgba_path",
            "mask": "glyph_mask_path",
            "glyph_224": "glyph_224_path",
            "context_224": "context_224_path",
        }
        for kind in MASK_ASSET_CONTRACT:
            if kind not in mask_paths:
                issues.add(
                    "error",
                    "mask_asset_path_missing",
                    f"mask_paths is missing '{kind}'.",
                    row=row,
                )
                continue
            value = mask_paths[kind]
            if portable_path(record.get(aliases[kind])) != portable_path(value):
                issues.add(
                    "error",
                    "mask_asset_alias_mismatch",
                    f"{aliases[kind]} differs from mask_paths.{kind}.",
                    row=row,
                )
            resolved = resolve_asset(
                dataset_root,
                value,
                f"mask_paths.{kind}",
                row,
                issues,
            )
            if resolved is None:
                continue
            key, path = resolved
            join.asset_keys[kind] = key
            relative = path.relative_to(dataset_root.resolve()).as_posix()
            requested[key] = (path, relative)
            users[key].append((row, kind))
            path_owners[key].append((row, kind))

    for key, owners in path_owners.items():
        if len(owners) > 1:
            first, kind = owners[0]
            issues.add(
                "error",
                "mask_asset_path_reused",
                (
                    f"Mask asset path for '{kind}' is reused by "
                    f"{len(owners)} records."
                ),
                row=first,
                path=requested[key][1],
            )
            for row, _ in owners[1:]:
                row.error_codes.add("mask_asset_path_reused")

    assets: dict[str, AssetInfo] = {}
    worker_count = min(8, max(1, os.cpu_count() or 2))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_key = {
            executor.submit(inspect_asset, path, relative): key
            for key, (path, relative) in requested.items()
        }
        for future in as_completed(future_to_key):
            key = future_to_key[future]
            try:
                assets[key] = future.result()
            except Exception as exc:
                path, relative = requested[key]
                assets[key] = AssetInfo(
                    path=path,
                    relative_path=relative,
                    error=f"{type(exc).__name__}: {exc}",
                )
    for key, asset in assets.items():
        if asset.decodable:
            continue
        first, kind = users[key][0]
        code = "mask_asset_missing" if not asset.exists else "mask_asset_decode_failed"
        issues.add(
            "error",
            code,
            f"{kind}: {asset.error}",
            row=first,
            path=asset.relative_path,
        )
        for row, _ in users[key][1:]:
            row.error_codes.add(code)
    return assets


def validate_mask_asset_contracts(
    rows: Sequence[RowState],
    assets: Mapping[str, AssetInfo],
    issues: IssueCollector,
) -> None:
    for row in rows:
        join = row.mask_join
        if join is None or join.record is None:
            continue
        record = join.record
        resolved = {
            kind: assets.get(join.asset_keys.get(kind, ""))
            for kind in MASK_ASSET_CONTRACT
        }
        try:
            mask_schema_version = int(record.get("mask_schema_version", 1))
        except (TypeError, ValueError):
            mask_schema_version = 1
        declared_asset_hashes = record.get("mask_asset_sha256")
        if mask_schema_version >= 2 and not isinstance(
            declared_asset_hashes, Mapping
        ):
            issues.add(
                "error",
                "mask_asset_hashes_missing",
                "Schema v2 requires mask_asset_sha256 for all five assets.",
                row=row,
            )
            declared_asset_hashes = {}
        for kind, (expected_mode, is_letterboxed) in MASK_ASSET_CONTRACT.items():
            asset = resolved[kind]
            if asset is None or not asset.decodable:
                continue
            if kind == "glyph_224":
                expected_mode = "RGB" if mask_schema_version >= 2 else "RGBA"
            if asset.image_format != "PNG":
                issues.add(
                    "error",
                    "mask_asset_not_png",
                    f"{kind} must be PNG, decoded format is {asset.image_format}.",
                    row=row,
                    path=asset.relative_path,
                )
            if expected_mode is not None and asset.mode != expected_mode:
                issues.add(
                    "error",
                    "mask_asset_mode_mismatch",
                    f"{kind} must use mode {expected_mode}, decoded {asset.mode}.",
                    row=row,
                    path=asset.relative_path,
                )
            if is_letterboxed and asset.size != EXPECTED_CLIP_SIZE:
                issues.add(
                    "error",
                    "mask_asset_224_size_mismatch",
                    f"{kind} must be 224x224, decoded {format_size(asset.size)}.",
                    row=row,
                    path=asset.relative_path,
                )
            if mask_schema_version >= 2:
                expected_file_hash = scalar_text(
                    (declared_asset_hashes or {}).get(kind)
                ).lower()
                if not HEX_SHA256_RE.fullmatch(expected_file_hash):
                    issues.add(
                        "error",
                        "mask_asset_file_hash_invalid",
                        f"mask_asset_sha256.{kind} is not a SHA-256.",
                        row=row,
                    )
                elif asset.sha256 != expected_file_hash:
                    issues.add(
                        "error",
                        "mask_asset_file_hash_mismatch",
                        f"File hash differs for mask asset '{kind}'.",
                        row=row,
                        path=asset.relative_path,
                    )

        tight = join.boxes.get("ctd_tight_bbox_px")
        context_box = join.boxes.get("masked_context_bbox_px")
        glyph_size = parse_size_pair(record.get("glyph_size_px"))
        context = resolved["context"]
        glyph = resolved["glyph_rgba"]
        mask = resolved["mask"]
        if context_box is not None and context is not None and context.decodable:
            expected = (
                context_box[2] - context_box[0],
                context_box[3] - context_box[1],
            )
            if context.size != expected:
                issues.add(
                    "error",
                    "masked_context_size_mismatch",
                    "Native masked context size differs from final_bbox_px.",
                    row=row,
                    path=context.relative_path,
                )
        if glyph_size is not None:
            for kind, asset in (("glyph_rgba", glyph), ("mask", mask)):
                if asset is not None and asset.decodable and asset.size != glyph_size:
                    issues.add(
                        "error",
                        "masked_glyph_asset_size_mismatch",
                        f"{kind} size differs from glyph_size_px.",
                        row=row,
                        path=asset.relative_path,
                    )
        if tight is not None and glyph_size is not None:
            if glyph_size != (tight[2] - tight[0], tight[3] - tight[1]):
                row.error_codes.add("masked_glyph_bbox_size_mismatch")

        if mask is not None and mask.decodable:
            if (
                mask.unique_values is None
                or not set(mask.unique_values).issubset({0, 255})
                or 255 not in mask.unique_values
            ):
                issues.add(
                    "error",
                    "mask_not_nonempty_binary",
                    "Mask pixels must be nonempty and contain only 0/255.",
                    row=row,
                    path=mask.relative_path,
                )
        if (
            mask is not None
            and glyph is not None
            and mask.decodable
            and glyph.decodable
            and mask.plane_sha256 != glyph.alpha_sha256
        ):
            issues.add(
                "error",
                "mask_alpha_mismatch",
                "Binary mask pixels differ from glyph_rgba alpha.",
                row=row,
            )

        declared_hash = scalar_text(record.get("glyph_sha256")).lower()
        if not HEX_SHA256_RE.fullmatch(declared_hash):
            issues.add(
                "error",
                "glyph_sha256_invalid",
                "glyph_sha256 must be 64 lowercase hexadecimal characters.",
                row=row,
            )
        elif glyph is not None and glyph.pixel_sha256 != declared_hash:
            issues.add(
                "error",
                "glyph_sha256_mismatch",
                "glyph_sha256 differs from decoded RGBA glyph pixels.",
                row=row,
                path=glyph.relative_path,
            )
        declared_dhash = scalar_text(record.get("glyph_dhash")).lower()
        if glyph is not None and glyph.decodable:
            actual_dhash = glyph_difference_hash(glyph.path)
            if not re.fullmatch(r"[0-9a-f]{16}", declared_dhash):
                issues.add(
                    "error",
                    "glyph_dhash_invalid",
                    "glyph_dhash must be 16 lowercase hexadecimal characters.",
                    row=row,
                )
            elif actual_dhash != declared_dhash:
                issues.add(
                    "error",
                    "glyph_dhash_mismatch",
                    "glyph_dhash differs from the decoded RGBA glyph.",
                    row=row,
                    path=glyph.relative_path,
                )
            if mask_schema_version >= 2:
                validate_v2_glyph_visual_contract(
                    row,
                    record,
                    glyph,
                    resolved["glyph_224"],
                    issues,
                )

        if glyph_size is not None:
            expected_axis = (
                ("height", glyph_size[1])
                if row.orientation.casefold() == "horizontal"
                else ("width", glyph_size[0])
            )
            try:
                axis_size = int(record.get("font_axis_size_px"))
            except (TypeError, ValueError):
                axis_size = -1
            if (
                scalar_text(record.get("font_axis")) != expected_axis[0]
                or axis_size != expected_axis[1]
            ):
                issues.add(
                    "error",
                    "font_axis_size_mismatch",
                    (
                        "font_axis/font_axis_size_px does not match orientation "
                        "and glyph_size_px."
                    ),
                    row=row,
                )


def glyph_difference_hash(path: Path) -> str:
    with Image.open(path) as opened:
        glyph = opened.convert("RGBA")
        white = Image.new("RGBA", glyph.size, (255, 255, 255, 255))
        composite = Image.alpha_composite(white, glyph).convert("L")
        resized = composite.resize((9, 8), lanczos_filter())
        pixels = list(resized.getdata())
    result = 0
    for y in range(8):
        offset = y * 9
        for x in range(8):
            result = (result << 1) | int(
                pixels[offset + x + 1] > pixels[offset + x]
            )
    return f"{result:016x}"


def image_pixel_sha256(image: Image.Image, mode: str) -> str:
    converted = image if image.mode == mode else image.convert(mode)
    digest = hashlib.sha256()
    digest.update(mode.encode("ascii"))
    digest.update(b"\0")
    digest.update(f"{converted.width}x{converted.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(converted.tobytes())
    return digest.hexdigest()


def validate_v2_glyph_visual_contract(
    row: RowState,
    record: Mapping[str, Any],
    glyph_asset: AssetInfo,
    glyph_224_asset: AssetInfo | None,
    issues: IssueCollector,
) -> None:
    try:
        with Image.open(glyph_asset.path) as opened:
            rgba = opened.convert("RGBA")
            rgba.load()
        raw = rgba.tobytes()
        transparent_rgb_nonzero = any(
            raw[index + 3] == 0
            and (raw[index] != 0 or raw[index + 1] != 0 or raw[index + 2] != 0)
            for index in range(0, len(raw), 4)
        )
        if transparent_rgb_nonzero:
            issues.add(
                "error",
                "glyph_transparent_rgb_not_normalized",
                "Transparent glyph pixels must have zero RGB channels.",
                row=row,
                path=glyph_asset.relative_path,
            )
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        composite = Image.alpha_composite(white, rgba).convert("RGB")
        declared_white_hash = scalar_text(
            record.get("glyph_white_composite_sha256")
        ).lower()
        actual_white_hash = image_pixel_sha256(composite, "RGB")
        if (
            not HEX_SHA256_RE.fullmatch(declared_white_hash)
            or declared_white_hash != actual_white_hash
        ):
            issues.add(
                "error",
                "glyph_white_composite_sha256_mismatch",
                "White-composited glyph pixel hash is invalid or mismatched.",
                row=row,
            )
        if glyph_224_asset is not None and glyph_224_asset.decodable:
            expected_224 = letterbox_rgb(composite, EXPECTED_CLIP_SIZE[0])
            with Image.open(glyph_224_asset.path) as opened:
                actual_224 = opened.convert("RGB")
                actual_224.load()
            if actual_224.size != expected_224.size or (
                actual_224.tobytes() != expected_224.tobytes()
            ):
                issues.add(
                    "error",
                    "glyph_224_render_mismatch",
                    (
                        "glyph_224 is not the exact white-composited, "
                        "aspect-preserving LANCZOS letterbox."
                    ),
                    row=row,
                    path=glyph_224_asset.relative_path,
                )
            actual_224.close()
            expected_224.close()
        composite.close()
        rgba.close()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        issues.add(
            "error",
            "glyph_visual_contract_decode_failed",
            f"Could not validate v2 glyph visual contract: {exc}",
            row=row,
            path=glyph_asset.relative_path,
        )


def letterbox_rgb(image: Image.Image, size: int) -> Image.Image:
    source = image.convert("RGB")
    scale = min(size / source.width, size / source.height)
    resized_size = (
        max(1, int(round(source.width * scale))),
        max(1, int(round(source.height * scale))),
    )
    resized = source.resize(resized_size, lanczos_filter())
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(
        resized,
        (
            (size - resized.width) // 2,
            (size - resized.height) // 2,
        ),
    )
    resized.close()
    if source is not image:
        source.close()
    return canvas


def validate_review_source_pages(
    rows: Sequence[RowState],
    library_root: Path,
    issues: IssueCollector,
) -> None:
    page_users: defaultdict[Path, list[RowState]] = defaultdict(list)
    for row in rows:
        join = row.mask_join
        if join is not None and join.page_path is not None:
            page_users[join.page_path].append(row)
    for path, users in page_users.items():
        first = users[0]
        if not path.is_file():
            issues.add(
                "error",
                "mask_source_page_missing_file",
                "Source page does not exist under --library.",
                row=first,
                path=str(path),
            )
            for row in users[1:]:
                row.error_codes.add("mask_source_page_missing_file")
            continue
        try:
            with Image.open(path) as opened:
                decoded = ImageOps.exif_transpose(opened)
                decoded.load()
                size = decoded.size
        except (OSError, RuntimeError, ValueError, UnidentifiedImageError) as exc:
            issues.add(
                "error",
                "mask_source_page_decode_failed",
                f"Could not decode source page: {exc}",
                row=first,
                path=str(path),
            )
            for row in users[1:]:
                row.error_codes.add("mask_source_page_decode_failed")
            continue
        expected = parse_size_pair(first.raw.get("page_size_px"))
        if expected is not None and size != expected:
            issues.add(
                "error",
                "mask_source_page_size_mismatch",
                (
                    f"Source page decodes as {format_size(size)}, expected "
                    f"{format_size(expected)}."
                ),
                row=first,
                path=str(path),
            )
            for row in users[1:]:
                row.error_codes.add("mask_source_page_size_mismatch")
        try:
            source_hash = file_sha256(path)
            source_bytes = path.stat().st_size
        except OSError as exc:
            issues.add(
                "error",
                "mask_source_page_hash_failed",
                f"Could not hash source page: {exc}",
                row=first,
                path=str(path),
            )
            continue
        for row in users:
            join = row.mask_join
            record = join.record if join is not None else None
            if not isinstance(record, Mapping):
                continue
            try:
                schema = int(record.get("mask_schema_version", 1))
            except (TypeError, ValueError):
                schema = 1
            if schema < 2:
                continue
            signature = record.get("source_page_content_signature")
            signature_path = (
                Path(scalar_text(signature.get("path"))).resolve()
                if isinstance(signature, Mapping)
                and scalar_text(signature.get("path"))
                else None
            )
            try:
                signature_size = int(signature.get("size"))  # type: ignore[union-attr]
            except (AttributeError, TypeError, ValueError):
                signature_size = -1
            signature_hash = (
                scalar_text(signature.get("sha256")).lower()
                if isinstance(signature, Mapping)
                else ""
            )
            if (
                scalar_text(record.get("source_page_sha256")).lower()
                != source_hash
                or signature_hash != source_hash
                or signature_size != source_bytes
                or signature_path != path.resolve()
            ):
                issues.add(
                    "error",
                    "source_page_signature_mismatch",
                    (
                        "source_page_sha256/content signature differs from "
                        "the current library page."
                    ),
                    row=row,
                    path=str(path),
                )


def stable_hash(*parts: str) -> str:
    payload = "\0".join(parts).encode("utf-8", errors="surrogatepass")
    return hashlib.sha256(payload).hexdigest()


def deterministic_stratified_sample(
    rows: Sequence[RowState], limit: int
) -> list[RowState]:
    displayable = [
        row
        for row in rows
        if row.image_asset_key is not None
        and "asset_missing" not in row.error_codes
        and "asset_decode_failed" not in row.error_codes
    ]
    limit = min(limit, len(displayable))

    by_work: defaultdict[str, list[RowState]] = defaultdict(list)
    for row in displayable:
        by_work[row.work_id or "(missing-work)"].append(row)
    for candidates in by_work.values():
        candidates.sort(key=row_stable_key)

    works = sorted(
        by_work,
        key=lambda work: stable_hash("fontclip-qa-work-v1", work),
    )
    selected: list[RowState] = []
    selected_ids: set[int] = set()
    tier_counts: Counter[str] = Counter()
    orientation_counts: Counter[str] = Counter()
    stratum_counts: Counter[tuple[str, str, str]] = Counter()

    while len(selected) < limit:
        made_progress = False
        for work in works:
            candidates = [
                row for row in by_work[work] if id(row) not in selected_ids
            ]
            if not candidates:
                continue
            candidates.sort(
                key=lambda row: (
                    tier_counts[row.tier],
                    orientation_counts[row.orientation],
                    stratum_counts[(row.work_id, row.tier, row.orientation)],
                    row_stable_key(row),
                )
            )
            chosen = candidates[0]
            selected.append(chosen)
            selected_ids.add(id(chosen))
            tier_counts[chosen.tier] += 1
            orientation_counts[chosen.orientation] += 1
            stratum_counts[
                (chosen.work_id, chosen.tier, chosen.orientation)
            ] += 1
            made_progress = True
            if len(selected) >= limit:
                break
        if not made_progress:
            break
    return selected


def rows_in_audit_shard(
    rows: Sequence[RowState], shard_index: int, shard_count: int
) -> list[RowState]:
    if shard_count == 1:
        return list(rows)
    selected: list[RowState] = []
    for row in rows:
        identity = row.sample_id or portable_path(row.values.get("image_path"))
        bucket = int(
            stable_hash("fontclip-qa-shard-v1", identity)[:16], 16
        ) % shard_count
        if bucket == shard_index:
            selected.append(row)
    return selected


def exhaustive_mask_audit_order(rows: Sequence[RowState]) -> list[RowState]:
    """Keep all items while grouping source pages for efficient visual rendering."""

    return sorted(
        rows,
        key=lambda row: (
            row.work_id.casefold(),
            row.chapter_id.casefold(),
            (
                row.mask_join.page_path.as_posix().casefold()
                if row.mask_join is not None
                and row.mask_join.page_path is not None
                else portable_path(row.raw.get("source_image_path")).casefold()
            ),
            row.bbox or (0, 0, 0, 0),
            row.tier.casefold(),
            row.orientation.casefold(),
            row.sample_id,
        ),
    )


def row_stable_key(row: RowState) -> tuple[str, str, int]:
    identity = row.sample_id or portable_path(row.values.get("image_path"))
    return (
        stable_hash(
            "fontclip-qa-row-v1",
            row.work_id,
            row.tier,
            row.orientation,
            identity,
        ),
        identity,
        row.line,
    )


def write_audit_csv(
    path: Path,
    rows: Sequence[RowState],
    assets: Mapping[str, AssetInfo],
) -> bool:
    fields = [
        "audit_index",
        *(field for field in CANONICAL_FIELDS if field != "bbox_px"),
        "original_bbox_px",
        "raw_width",
        "raw_height",
        "clip_width",
        "clip_height",
        "validation_status",
        "error_codes",
        "warning_codes",
        "decision",
        "reject_reason",
        "recrop_bbox_px",
        "padding_px",
        "reviewer",
        "reviewed_at",
        "notes",
    ]
    output_rows: list[dict[str, Any]] = []
    for index, row in enumerate(rows, 1):
        raw_asset = assets.get(row.image_asset_key or "")
        clip_asset = assets.get(row.clip_asset_key or "")
        output = {
            key: json_cell(row.values.get(key))
            for key in CANONICAL_FIELDS
            if key != "bbox_px"
        }
        output.update(
            {
                "audit_index": index,
                "original_bbox_px": json_cell(row.values.get("bbox_px")),
                "raw_width": raw_asset.width if raw_asset else "",
                "raw_height": raw_asset.height if raw_asset else "",
                "clip_width": clip_asset.width if clip_asset else "",
                "clip_height": clip_asset.height if clip_asset else "",
                "mask_status": (
                    row.mask_join.status if row.mask_join is not None else ""
                ),
                "validation_status": "ERROR" if row.error_codes else "OK",
                "error_codes": "|".join(sorted(row.error_codes)),
                "warning_codes": "|".join(sorted(row.warning_codes)),
                "decision": "",
                "reject_reason": "",
                "recrop_bbox_px": "",
                "padding_px": "",
                "reviewer": "",
                "reviewed_at": "",
                "notes": "",
            }
        )
        output_rows.append(output)
    if "mask_status" not in fields:
        fields.insert(fields.index("validation_status"), "mask_status")
    expected_ids = [row.sample_id for row in rows]
    if existing_ledger_has_review(path, expected_ids):
        return True
    atomic_write_csv(path, fields, output_rows)
    return False


REVIEW_LEDGER_FIELDS = (
    "decision",
    "reject_reason",
    "recrop_bbox_px",
    "padding_px",
    "reviewer",
    "reviewed_at",
    "notes",
)


def existing_ledger_has_review(path: Path, expected_ids: Sequence[str]) -> bool:
    if not path.exists():
        return False
    if not path.is_file():
        raise ValueError(f"review ledger path is not a file: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames is None or "id" not in reader.fieldnames:
            raise ValueError(f"existing review ledger has no id column: {path}")
        rows = list(reader)
    ids = [scalar_text(row.get("id")) for row in rows]
    if not ids or any(not sample_id for sample_id in ids):
        raise ValueError(f"existing review ledger has an empty id: {path}")
    if len(ids) != len(set(ids)):
        raise ValueError(f"existing review ledger has duplicate ids: {path}")
    if set(ids) != set(expected_ids):
        raise ValueError(
            f"existing review ledger id set differs from this audit: {path}"
        )
    return any(
        scalar_text(row.get(field))
        for row in rows
        for field in REVIEW_LEDGER_FIELDS
    )


def ledger_contains_review(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            return any(
                scalar_text(row.get(field))
                for row in reader
                for field in REVIEW_LEDGER_FIELDS
            )
    except (OSError, csv.Error):
        return True


def atomic_write_csv(
    path: Path,
    fieldnames: Sequence[str],
    rows: Sequence[Mapping[str, Any]],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = temporary_sibling(path)
    try:
        with temporary.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=list(fieldnames),
                extrasaction="ignore",
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def temporary_sibling(path: Path) -> Path:
    descriptor, name = tempfile.mkstemp(
        prefix=f".{path.stem}-",
        suffix=path.suffix,
        dir=path.parent,
    )
    os.close(descriptor)
    return Path(name)


def json_cell(value: Any) -> str:
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "" if value is None else str(value)


@lru_cache(maxsize=32)
def find_label_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = []
    if os.name == "nt":
        candidates.extend(
            [
                Path(os.environ.get("WINDIR", r"C:\Windows"))
                / "Fonts"
                / ("malgunbd.ttf" if bold else "malgun.ttf"),
                Path(os.environ.get("WINDIR", r"C:\Windows"))
                / "Fonts"
                / ("arialbd.ttf" if bold else "arial.ttf"),
            ]
        )
    candidates.extend(
        [
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/System/Library/Fonts/AppleSDGothicNeo.ttc"),
        ]
    )
    for candidate in candidates:
        try:
            if candidate.is_file():
                return ImageFont.truetype(str(candidate), size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def build_audit_state(
    *,
    primary_path: Path,
    primary_name: str,
    sampled: Sequence[RowState],
    audit_all: bool,
    mask_review: bool,
    shard_index: int,
    shard_count: int,
    spec: ContactSheetSpec,
    mask_signatures: Mapping[str, str],
) -> dict[str, Any]:
    ids = [row.sample_id for row in sampled]
    sorted_ids = sorted(ids)
    id_set_signature = hashlib.sha256(
        "\n".join(sorted_ids).encode("utf-8")
    ).hexdigest()
    ordered_signature = hashlib.sha256(
        "\n".join(ids).encode("utf-8")
    ).hexdigest()
    return {
        "schema_version": 1,
        "primary_manifest": primary_name,
        "primary_manifest_sha256": file_sha256(primary_path),
        "mask_manifest_sha256": dict(sorted(mask_signatures.items())),
        "audit_all": bool(audit_all),
        "mask_review": bool(mask_review),
        "shard_index": shard_index,
        "shard_count": shard_count,
        "contact_sheet": {
            "max_items": spec.max_items,
            "canvas_size": (
                list(spec.canvas_size) if spec.canvas_size is not None else None
            ),
        },
        "item_count": len(ids),
        "id_set_sha256": id_set_signature,
        "ordered_ids_sha256": ordered_signature,
        "ids": sorted_ids,
    }


def validate_existing_audit_state(
    state_path: Path,
    expected: Mapping[str, Any],
    *,
    ledger_candidates: Iterable[Path],
) -> bool:
    if not state_path.exists():
        reviewed = [
            path for path in ledger_candidates if ledger_contains_review(path)
        ]
        if reviewed:
            preview = ", ".join(path.name for path in reviewed[:5])
            raise ValueError(
                "review decisions exist without a matching audit state; "
                f"refusing to overwrite: {preview}"
            )
        return False
    try:
        current = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"existing audit state is unreadable: {state_path}") from exc
    if current != expected:
        raise ValueError(
            "manifest signature, audit ID set, shard, or sheet configuration "
            f"differs from existing state: {state_path}"
        )
    return True


def create_contact_sheets(
    qa_dir: Path,
    sampled: Sequence[RowState],
    assets: Mapping[str, AssetInfo],
    spec: ContactSheetSpec,
    issues: IssueCollector,
    *,
    audit_all: bool,
    shard_tag: str,
    mask_review: bool = False,
    mask_assets: Mapping[str, AssetInfo] | None = None,
) -> list[dict[str, Any]]:
    file_prefix = f"fontclip_{'audit' if audit_all else 'contact'}_{shard_tag}"
    artifacts: list[dict[str, Any]] = []
    page_cache = SourcePageCache()
    audit_indices = {id(row): index for index, row in enumerate(sampled, 1)}
    dimensions = ("audit",) if audit_all else ("work", "tier", "orientation")
    for dimension in dimensions:
        ordered = order_sample_for_dimension(sampled, dimension)
        for page_index, start in enumerate(
            range(0, len(ordered), spec.max_items), 1
        ):
            page_rows = ordered[start : start + spec.max_items]
            output = (
                qa_dir
                / f"{file_prefix}_{dimension}_{page_index:05d}.png"
            )
            try:
                ledger_csv = output.with_suffix(".csv")
                preserve_ledger = existing_ledger_has_review(
                    ledger_csv, [row.sample_id for row in page_rows]
                )
                temporary = temporary_sibling(output)
                try:
                    render_contact_sheet(
                        temporary,
                        page_rows,
                        assets,
                        dimension,
                        spec,
                        audit_indices,
                        mask_review=mask_review,
                        mask_assets=mask_assets or {},
                        page_cache=page_cache,
                    )
                    temporary.replace(output)
                finally:
                    if temporary.exists():
                        temporary.unlink()
                ledger_json, ledger_csv = write_sheet_ledgers(
                    output,
                    page_rows,
                    audit_indices,
                    dimension,
                    preserve_csv=preserve_ledger,
                )
            except (OSError, ValueError) as exc:
                issues.add(
                    "error",
                    "contact_sheet_write_failed",
                    f"Could not create contact sheet: {exc}",
                    path=str(output),
                )
                continue
            artifacts.append(
                {
                    "dimension": dimension,
                    "path": output.relative_to(qa_dir.parent).as_posix(),
                    "samples": len(page_rows),
                    "first_audit_index": min(
                        audit_indices[id(row)] for row in page_rows
                    ),
                    "last_audit_index": max(
                        audit_indices[id(row)] for row in page_rows
                    ),
                    "item_order_json": ledger_json.relative_to(
                        qa_dir.parent
                    ).as_posix(),
                    "review_ledger_csv": ledger_csv.relative_to(
                        qa_dir.parent
                    ).as_posix(),
                }
            )
    return artifacts


def order_sample_for_dimension(
    rows: Sequence[RowState], dimension: str
) -> list[RowState]:
    def group_value(row: RowState) -> str:
        if dimension == "audit":
            return ""
        if dimension == "work":
            return row.work_id
        if dimension == "tier":
            return row.tier
        return row.orientation

    if dimension == "audit":
        return list(rows)
    return sorted(
        rows,
        key=lambda row: (
            group_value(row).casefold(),
            row.work_id.casefold(),
            row.tier.casefold(),
            row.orientation.casefold(),
            row_stable_key(row),
        ),
    )


def render_contact_sheet(
    output: Path,
    rows: Sequence[RowState],
    assets: Mapping[str, AssetInfo],
    dimension: str,
    spec: ContactSheetSpec,
    audit_indices: Mapping[int, int],
    *,
    mask_review: bool,
    mask_assets: Mapping[str, AssetInfo],
    page_cache: "SourcePageCache",
) -> None:
    if not rows:
        return
    count = len(rows)
    if spec.canvas_size is None:
        if mask_review:
            columns = min(3, count)
        else:
            columns = max(1, math.ceil(math.sqrt(count * 1.25)))
        rows_count = math.ceil(count / columns)
        if mask_review:
            cell_width, cell_height = 780, 570
        elif spec.max_items <= DEFAULT_AUDIT_ALL_SHEET_SIZE:
            cell_width, cell_height = 460, 350
        else:
            cell_width, cell_height = 330, 250
        margin, header_height = 24, 62
        canvas_width = margin * 2 + columns * cell_width
        canvas_height = margin * 2 + header_height + rows_count * cell_height
    else:
        canvas_width, canvas_height = spec.canvas_size
        margin, header_height = 18, 54
        usable_width = canvas_width - 2 * margin
        usable_height = canvas_height - 2 * margin - header_height
        target_ratio = usable_width / max(1, usable_height)
        columns = max(1, math.ceil(math.sqrt(count * target_ratio)))
        rows_count = math.ceil(count / columns)
        cell_width = max(1, usable_width // columns)
        cell_height = max(1, usable_height // rows_count)

    sheet = Image.new("RGB", (canvas_width, canvas_height), (241, 243, 246))
    draw = ImageDraw.Draw(sheet)
    title_font = find_label_font(max(17, min(26, header_height // 2)), bold=True)
    label_font = find_label_font(max(11, min(16, cell_height // 16)))
    small_font = find_label_font(max(10, min(14, cell_height // 19)))
    draw.text(
        (margin, margin),
        f"FontCLIP audit — stratified by {dimension} — {count} samples",
        fill=(18, 24, 34),
        font=title_font,
    )
    top = margin + header_height
    for index, row in enumerate(rows):
        column = index % columns
        row_index = index // columns
        x = margin + column * cell_width
        y = top + row_index * cell_height
        if mask_review:
            render_mask_review_cell(
                sheet,
                draw,
                (x, y, cell_width, cell_height),
                row,
                assets,
                mask_assets,
                page_cache,
                label_font,
                small_font,
                audit_indices[id(row)],
            )
        else:
            render_contact_cell(
                sheet,
                draw,
                (x, y, cell_width, cell_height),
                row,
                assets,
                dimension,
                label_font,
                small_font,
                audit_indices[id(row)],
            )
    sheet.save(output, format="PNG", optimize=True)


def render_contact_cell(
    sheet: Image.Image,
    draw: ImageDraw.ImageDraw,
    bounds: tuple[int, int, int, int],
    row: RowState,
    assets: Mapping[str, AssetInfo],
    dimension: str,
    label_font: ImageFont.ImageFont,
    small_font: ImageFont.ImageFont,
    audit_index: int,
) -> None:
    x, y, width, height = bounds
    inset = max(5, width // 50)
    label_height = max(58, min(78, height // 3))
    image_box = (
        x + inset,
        y + inset,
        x + width - inset,
        y + height - label_height - inset,
    )
    border = color_for_label(
        row.work_id if dimension == "work" else (
            row.tier if dimension == "tier" else row.orientation
        )
    )
    draw.rounded_rectangle(
        (x + 2, y + 2, x + width - 3, y + height - 3),
        radius=7,
        fill=(255, 255, 255),
        outline=(190, 45, 45) if row.error_codes else border,
        width=3,
    )

    asset = assets.get(row.image_asset_key or "")
    if asset and asset.decodable:
        with Image.open(asset.path) as source:
            source = ImageOps.exif_transpose(source).convert("RGB")
            available = (
                max(1, image_box[2] - image_box[0] - 8),
                max(1, image_box[3] - image_box[1] - 8),
            )
            source.thumbnail(available, resample=lanczos_filter())
            px = image_box[0] + (image_box[2] - image_box[0] - source.width) // 2
            py = image_box[1] + (image_box[3] - image_box[1] - source.height) // 2
            sheet.paste(source, (px, py))
    else:
        draw.text(
            (image_box[0] + 10, image_box[1] + 10),
            "IMAGE ERROR",
            fill=(180, 20, 20),
            font=label_font,
        )

    badge_font = find_label_font(max(17, min(28, width // 12)), bold=True)
    badge_text = f"#{audit_index:06d}"
    badge_bbox = draw.textbbox((0, 0), badge_text, font=badge_font)
    badge_width = badge_bbox[2] - badge_bbox[0] + 14
    badge_height = badge_bbox[3] - badge_bbox[1] + 10
    draw.rounded_rectangle(
        (
            image_box[0] + 4,
            image_box[1] + 4,
            image_box[0] + 4 + badge_width,
            image_box[1] + 4 + badge_height,
        ),
        radius=5,
        fill=(18, 24, 34),
    )
    draw.text(
        (image_box[0] + 11, image_box[1] + 7),
        badge_text,
        fill=(255, 255, 255),
        font=badge_font,
    )

    label_y = y + height - label_height + 3
    status = "ERROR" if row.error_codes else "OK"
    lines = [
        f"[{status}] work={row.work_id or '?'}",
        f"tier={row.tier or '?'}  orientation={row.orientation or '?'}",
        (
            f"id={row.sample_id or '?'}  ch={row.chapter_id or '?'}  "
            f"page={scalar_text(row.values.get('page_id')) or '?'}"
        ),
    ]
    for line_index, text_value in enumerate(lines):
        font = label_font if line_index == 0 else small_font
        clipped = fit_text(draw, text_value, font, width - 2 * inset)
        draw.text(
            (x + inset, label_y + line_index * max(16, label_height // 4)),
            clipped,
            fill=(25, 30, 38),
            font=font,
        )


class SourcePageCache:
    def __init__(self, capacity: int = 6) -> None:
        self.capacity = capacity
        self._images: "OrderedDict[Path, Image.Image]" = OrderedDict()

    def get(self, path: Path) -> Image.Image:
        cached = self._images.pop(path, None)
        if cached is None:
            with Image.open(path) as opened:
                cached = ImageOps.exif_transpose(opened).convert("RGB")
                cached.load()
            while len(self._images) >= self.capacity:
                _, evicted = self._images.popitem(last=False)
                evicted.close()
        self._images[path] = cached
        return cached


def render_mask_review_cell(
    sheet: Image.Image,
    draw: ImageDraw.ImageDraw,
    bounds: tuple[int, int, int, int],
    row: RowState,
    base_assets: Mapping[str, AssetInfo],
    mask_assets: Mapping[str, AssetInfo],
    page_cache: SourcePageCache,
    label_font: ImageFont.ImageFont,
    small_font: ImageFont.ImageFont,
    audit_index: int,
) -> None:
    x, y, width, height = bounds
    inset = max(6, width // 100)
    label_height = max(82, min(102, height // 5))
    content = (
        x + inset,
        y + inset,
        x + width - inset,
        y + height - label_height - inset,
    )
    status = row.mask_join.status if row.mask_join is not None else "NO MASK"
    border = (
        (190, 45, 45)
        if row.error_codes
        else ((45, 132, 82) if status == "MASKED" else (210, 120, 24))
    )
    draw.rounded_rectangle(
        (x + 2, y + 2, x + width - 3, y + height - 3),
        radius=8,
        fill=(255, 255, 255),
        outline=border,
        width=4,
    )

    gap = max(4, width // 160)
    panel_width = max(1, (content[2] - content[0] - gap * 2) // 3)
    panel_height = max(1, (content[3] - content[1] - gap) // 2)
    panels = []
    for panel_index in range(6):
        column = panel_index % 3
        panel_row = panel_index // 3
        left = content[0] + column * (panel_width + gap)
        top = content[1] + panel_row * (panel_height + gap)
        panels.append((left, top, left + panel_width, top + panel_height))

    join = row.mask_join
    page_patch = build_overlay_page_patch(row, page_cache)
    raw_image = load_asset_for_display(
        base_assets.get(row.image_asset_key or ""), "RGB"
    )
    render_labeled_panel(
        sheet,
        draw,
        panels[0],
        "DISPLAY OVERLAY — NOT TRAINING DATA  OCR=Y  TIGHT=R  CONTEXT=C",
        page_patch,
        small_font,
    )
    render_labeled_panel(
        sheet, draw, panels[1], "BASE RAW CROP", raw_image, small_font
    )

    if join is not None and join.record is not None:
        context = load_mask_asset_for_display(join, mask_assets, "context")
        binary_mask = load_mask_asset_for_display(join, mask_assets, "mask")
        glyph = load_mask_asset_for_display(
            join, mask_assets, "glyph_rgba", composite_rgba=True
        )
        context_224 = load_mask_asset_for_display(
            join, mask_assets, "context_224"
        )
        render_labeled_panel(
            sheet, draw, panels[2], "MASKED CONTEXT", context, small_font
        )
        render_labeled_panel(
            sheet, draw, panels[3], "BINARY MASK", binary_mask, small_font
        )
        render_labeled_panel(
            sheet, draw, panels[4], "GLYPH ON WHITE", glyph, small_font
        )
        render_labeled_panel(
            sheet, draw, panels[5], "ACTUAL CONTEXT_224", context_224, small_font
        )
    else:
        reason = mask_reject_reason(row)
        for panel_index, title in enumerate(
            (
                "MASKED CONTEXT",
                "BINARY MASK",
                "GLYPH ON WHITE",
                "ACTUAL CONTEXT_224",
            ),
            2,
        ):
            render_labeled_panel(
                sheet,
                draw,
                panels[panel_index],
                title,
                None,
                small_font,
                missing_text=f"NO MASK\n{reason}",
            )

    label_top = y + height - label_height + 4
    badge_font = find_label_font(max(16, min(21, width // 36)), bold=True)
    badge = f"#{audit_index:06d}"
    badge_bounds = draw.textbbox((0, 0), badge, font=badge_font)
    badge_width = badge_bounds[2] - badge_bounds[0] + 14
    badge_height = badge_bounds[3] - badge_bounds[1] + 8
    badge_left = x + width - inset - badge_width
    draw.rounded_rectangle(
        (
            badge_left,
            label_top,
            badge_left + badge_width,
            label_top + badge_height,
        ),
        radius=5,
        fill=(16, 22, 32),
    )
    draw.text(
        (badge_left + 7, label_top + 4),
        badge,
        fill=(255, 255, 255),
        font=badge_font,
    )

    hp = bool(join and join.high_precision)
    validation = "ERROR" if row.error_codes else "OK"
    lines = (
        f"[{validation}] [{status}] HP={'Y' if hp else 'N'}  id={row.sample_id}",
        (
            f"work={row.work_id}  ch={row.chapter_id}  "
            f"page={scalar_text(row.values.get('page_id'))}"
        ),
        (
            f"tier={row.tier}  orientation={row.orientation}  "
            f"OCR={scalar_text(row.raw.get('ocr_text'))}"
        ),
    )
    line_step = max(19, label_height // 4)
    for line_index, text_value in enumerate(lines):
        font = label_font if line_index == 0 else small_font
        available_width = (
            badge_left - x - inset - 8
            if line_index == 0
            else width - inset * 2
        )
        draw.text(
            (x + inset, label_top + line_index * line_step),
            fit_text(draw, text_value, font, max(1, available_width)),
            fill=(24, 30, 38),
            font=font,
        )


def build_overlay_page_patch(
    row: RowState,
    page_cache: SourcePageCache,
) -> Image.Image | None:
    join = row.mask_join
    if join is None or join.page_path is None or not join.page_path.is_file():
        return None
    try:
        page = page_cache.get(join.page_path)
    except (OSError, ValueError, UnidentifiedImageError):
        return None
    boxes: list[tuple[str, tuple[int, int, int, int], tuple[int, int, int]]] = []
    ocr = join.boxes.get("ctd_ocr_bbox_px") or row.bbox
    tight = join.boxes.get("ctd_tight_bbox_px")
    context = join.boxes.get("masked_context_bbox_px")
    if ocr is not None:
        boxes.append(("OCR", ocr, (255, 196, 0)))
    if tight is not None:
        boxes.append(("TIGHT", tight, (230, 45, 55)))
    if context is not None:
        boxes.append(("CONTEXT", context, (0, 180, 210)))
    if not boxes:
        return None
    x1 = min(box[0] for _, box, _ in boxes)
    y1 = min(box[1] for _, box, _ in boxes)
    x2 = max(box[2] for _, box, _ in boxes)
    y2 = max(box[3] for _, box, _ in boxes)
    box_width, box_height = x2 - x1, y2 - y1
    margin_x = max(36, int(round(box_width * 0.30)))
    margin_y = max(36, int(round(box_height * 0.50)))
    crop_box = (
        max(0, x1 - margin_x),
        max(0, y1 - margin_y),
        min(page.width, x2 + margin_x),
        min(page.height, y2 + margin_y),
    )
    patch = page.crop(crop_box)
    overlay = ImageDraw.Draw(patch)
    line_width = max(2, min(7, max(patch.size) // 180))
    for _, box, color in boxes:
        translated = (
            box[0] - crop_box[0],
            box[1] - crop_box[1],
            box[2] - crop_box[0] - 1,
            box[3] - crop_box[1] - 1,
        )
        overlay.rectangle(translated, outline=color, width=line_width)
    return patch


def load_asset_for_display(
    asset: AssetInfo | None,
    output_mode: str = "RGB",
) -> Image.Image | None:
    if asset is None or not asset.decodable:
        return None
    try:
        with Image.open(asset.path) as opened:
            image = ImageOps.exif_transpose(opened).convert(output_mode)
            image.load()
        return image
    except (OSError, ValueError, UnidentifiedImageError):
        return None


def load_mask_asset_for_display(
    join: MaskJoin,
    assets: Mapping[str, AssetInfo],
    kind: str,
    *,
    composite_rgba: bool = False,
) -> Image.Image | None:
    asset = assets.get(join.asset_keys.get(kind, ""))
    if asset is None or not asset.decodable:
        return None
    try:
        with Image.open(asset.path) as opened:
            if composite_rgba:
                glyph = opened.convert("RGBA")
                white = Image.new("RGBA", glyph.size, (255, 255, 255, 255))
                image = Image.alpha_composite(white, glyph).convert("RGB")
            elif kind == "mask":
                image = opened.convert("L").convert("RGB")
            else:
                image = opened.convert("RGB")
            image.load()
        return image
    except (OSError, ValueError, UnidentifiedImageError):
        return None


def render_labeled_panel(
    sheet: Image.Image,
    draw: ImageDraw.ImageDraw,
    bounds: tuple[int, int, int, int],
    title: str,
    image: Image.Image | None,
    font: ImageFont.ImageFont,
    *,
    missing_text: str = "IMAGE ERROR",
) -> None:
    left, top, right, bottom = bounds
    draw.rectangle(bounds, fill=(246, 247, 249), outline=(178, 184, 193), width=1)
    title_height = max(18, min(26, (bottom - top) // 7))
    draw.rectangle(
        (left, top, right, top + title_height),
        fill=(27, 34, 45),
    )
    draw.text(
        (left + 5, top + 2),
        fit_text(draw, title, font, max(1, right - left - 10)),
        fill=(255, 255, 255),
        font=font,
    )
    image_box = (
        left + 4,
        top + title_height + 4,
        right - 4,
        bottom - 4,
    )
    if image is None:
        color = (178, 34, 34) if "NO MASK" in missing_text else (110, 30, 30)
        lines = missing_text.splitlines()[:3]
        for line_index, line in enumerate(lines):
            draw.text(
                (
                    image_box[0] + 8,
                    image_box[1] + 8 + line_index * max(18, title_height),
                ),
                fit_text(draw, line, font, max(1, image_box[2] - image_box[0] - 16)),
                fill=color,
                font=font,
            )
        return
    available = (
        max(1, image_box[2] - image_box[0]),
        max(1, image_box[3] - image_box[1]),
    )
    image.thumbnail(available, resample=lanczos_filter())
    paste_x = image_box[0] + (available[0] - image.width) // 2
    paste_y = image_box[1] + (available[1] - image.height) // 2
    sheet.paste(image, (paste_x, paste_y))
    image.close()


def mask_reject_reason(row: RowState) -> str:
    join = row.mask_join
    if join is None or join.reject is None:
        return "unmatched"
    reasons = join.reject.get("reasons")
    if isinstance(reasons, list):
        text_value = ",".join(scalar_text(reason) for reason in reasons)
        if text_value:
            return text_value
    return scalar_text(join.reject.get("stage")) or "rejected"


def write_sheet_ledgers(
    image_path: Path,
    rows: Sequence[RowState],
    audit_indices: Mapping[int, int],
    dimension: str,
    *,
    preserve_csv: bool,
) -> tuple[Path, Path]:
    json_path = image_path.with_suffix(".json")
    csv_path = image_path.with_suffix(".csv")
    items: list[dict[str, Any]] = []
    for cell_index, row in enumerate(rows, 1):
        items.append(
            {
                "cell_index": cell_index,
                "audit_index": audit_indices[id(row)],
                "id": row.sample_id,
                "image_path": portable_path(row.values.get("image_path")),
                "work_id": row.work_id,
                "chapter_id": row.chapter_id,
                "page_id": scalar_text(row.values.get("page_id")),
                "tier": row.tier,
                "orientation": row.orientation,
                "mask_status": (
                    row.mask_join.status if row.mask_join is not None else ""
                ),
                "mask_high_precision": bool(
                    row.mask_join and row.mask_join.high_precision
                ),
                "mask_reject_reasons": (
                    mask_reject_reason(row)
                    if row.mask_join is not None
                    and row.mask_join.record is None
                    else ""
                ),
                "decision": "",
                "reject_reason": "",
                "recrop_bbox_px": "",
                "padding_px": "",
                "reviewer": "",
                "notes": "",
            }
        )
    payload = {
        "schema_version": 1,
        "sheet": image_path.name,
        "stratified_by": dimension,
        "decision_values": ["pass", "reject", "recrop"],
        "merge_key": "id",
        "items": items,
    }
    safe_write_report(json_path, payload)
    fieldnames = list(items[0]) if items else []
    if not preserve_csv:
        atomic_write_csv(csv_path, fieldnames, items)
    return json_path, csv_path


def lanczos_filter() -> int:
    resampling = getattr(Image, "Resampling", Image)
    return resampling.LANCZOS


def fit_text(
    draw: ImageDraw.ImageDraw,
    text_value: str,
    font: ImageFont.ImageFont,
    max_width: int,
) -> str:
    if draw.textbbox((0, 0), text_value, font=font)[2] <= max_width:
        return text_value
    suffix = "…"
    low, high = 0, len(text_value)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = text_value[:middle] + suffix
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            low = middle
        else:
            high = middle - 1
    return text_value[:low] + suffix


def color_for_label(value: str) -> tuple[int, int, int]:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return (
        70 + digest[0] % 120,
        70 + digest[1] % 120,
        70 + digest[2] % 120,
    )


def build_distributions(rows: Sequence[RowState]) -> dict[str, Any]:
    def counts(values: Iterable[str]) -> dict[str, int]:
        return dict(sorted(Counter(value or "(missing)" for value in values).items()))

    chapters: defaultdict[str, set[str]] = defaultdict(set)
    combinations: Counter[str] = Counter()
    for row in rows:
        chapters[row.work_id or "(missing)"].add(row.chapter_id or "(missing)")
        key = " | ".join(
            (
                row.work_id or "(missing)",
                row.tier or "(missing)",
                row.orientation or "(missing)",
            )
        )
        combinations[key] += 1
    return {
        "work": counts(row.work_id for row in rows),
        "tier": counts(row.tier for row in rows),
        "provenance": counts(row.provenance for row in rows),
        "orientation": counts(row.orientation for row in rows),
        "split": counts(row.split for row in rows),
        "chapter_count_by_work": dict(
            sorted((work, len(chapter_ids)) for work, chapter_ids in chapters.items())
        ),
        "work_tier_orientation": dict(sorted(combinations.items())),
    }


def load_dataset_contract(dataset_root: Path) -> DatasetContract:
    stats_path = dataset_root / "stats.json"
    if not stats_path.is_file():
        return DatasetContract()
    try:
        payload = json.loads(stats_path.read_text(encoding="utf-8"))
        configuration = payload.get("configuration", {})
        configured_max = int(
            configuration.get("max_chapters_per_work", MAX_CHAPTERS_PER_WORK)
        )
        letterbox_size = int(
            configuration.get("letterbox_size", EXPECTED_CLIP_SIZE[0])
        )
        if not 1 <= configured_max <= MAX_CHAPTERS_PER_WORK:
            configured_max = MAX_CHAPTERS_PER_WORK
        if letterbox_size <= 0:
            letterbox_size = EXPECTED_CLIP_SIZE[0]
        return DatasetContract(
            max_chapters_per_work=configured_max,
            clip_size=(letterbox_size, letterbox_size),
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return DatasetContract()


def find_primary_manifest(
    dataset_arg: Path, manifest_arg: Path | None = None
) -> tuple[Path, Path]:
    supplied = dataset_arg.expanduser().resolve()
    if supplied.is_file():
        if manifest_arg is not None:
            raise FileNotFoundError(
                "--manifest cannot be combined with a manifest passed as --dataset"
            )
        return supplied.parent, supplied
    if not supplied.is_dir():
        raise FileNotFoundError(f"Dataset does not exist: {supplied}")
    if manifest_arg is not None:
        requested = (
            manifest_arg.expanduser().resolve()
            if manifest_arg.is_absolute()
            else (supplied / manifest_arg).resolve()
        )
        try:
            requested.relative_to(supplied)
        except ValueError as exc:
            raise FileNotFoundError(
                "--manifest must resolve inside the dataset directory"
            ) from exc
        if not requested.is_file():
            raise FileNotFoundError(f"Manifest does not exist: {requested}")
        return supplied, requested
    candidates = (
        supplied / "manifest.jsonl",
        supplied / "manifests" / "all.jsonl",
        supplied / "metadata.jsonl",
    )
    for candidate in candidates:
        if candidate.is_file():
            return supplied, candidate
    discovered = sorted(supplied.glob("*.jsonl"), key=lambda path: path.name.casefold())
    if len(discovered) == 1:
        return supplied, discovered[0]
    if not discovered:
        raise FileNotFoundError(
            f"No primary JSONL manifest found under dataset: {supplied}"
        )
    raise FileNotFoundError(
        "Could not choose a primary manifest; add manifest.jsonl or pass a "
        "manifest file directly."
    )


def safe_write_report(path: Path, report: Mapping[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(
            report,
            stream,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        stream.write("\n")
    temporary.replace(path)


def run(args: argparse.Namespace) -> int:
    try:
        dataset_root, primary_path = find_primary_manifest(
            args.dataset, args.manifest
        )
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    qa_dir = dataset_root / "qa"
    try:
        qa_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"ERROR: could not create QA directory {qa_dir}: {exc}", file=sys.stderr)
        return 2

    issues = IssueCollector()
    contract = load_dataset_contract(dataset_root)
    manifest_name = primary_path.relative_to(dataset_root).as_posix()
    rows = normalize_primary_rows(primary_path, issues, manifest_name)
    shard_rows = rows_in_audit_shard(
        rows, args.shard_index, args.shard_count
    )
    validation_rows = rows if args.shard_count == 1 else shard_rows
    assets = collect_and_inspect_assets(dataset_root, validation_rows, issues)
    validate_row_assets(validation_rows, assets, issues, contract)
    validate_dataset_relations(rows, assets, issues, contract)

    mask_result: MaskReviewResult | None = None
    if args.mask_review:
        canonical_primary = (dataset_root / "manifest.jsonl").resolve()
        if primary_path.resolve() != canonical_primary:
            issues.add(
                "error",
                "mask_review_requires_raw_primary",
                (
                    "--mask-review must use the dataset's raw primary "
                    "manifest.jsonl."
                ),
                manifest=manifest_name,
            )
        library_root = args.library.expanduser().resolve()
        if not library_root.is_dir():
            issues.add(
                "error",
                "mask_review_library_missing",
                f"--library is not a directory: {library_root}",
                path=str(library_root),
            )
        mask_result = validate_mask_review(
            dataset_root,
            library_root,
            rows,
            validation_rows,
            issues,
        )

    auxiliary_skip = (
        {MASK_MANIFEST_NAME, MASK_HIGH_PRECISION_NAME, MASK_REJECTS_NAME}
        if args.mask_review
        else set()
    )
    auxiliary = validate_auxiliary_manifests(
        dataset_root,
        primary_path,
        rows,
        issues,
        skip_names=auxiliary_skip,
    )

    if args.audit_all:
        sample = (
            exhaustive_mask_audit_order(shard_rows)
            if args.mask_review
            else sorted(shard_rows, key=row_stable_key)
        )
    else:
        sample = deterministic_stratified_sample(
            shard_rows, args.sample_size
        )
    shard_tag = (
        "all"
        if args.shard_count == 1
        else f"shard-{args.shard_index:03d}-of-{args.shard_count:03d}"
    )
    audit_csv = qa_dir / (
        "audit_sample.csv"
        if args.shard_count == 1
        else f"audit_sample_{shard_tag}.csv"
    )
    file_prefix = f"fontclip_{'audit' if args.audit_all else 'contact'}_{shard_tag}"
    state_path = qa_dir / (
        "audit_state.json"
        if args.shard_count == 1
        else f"audit_state_{shard_tag}.json"
    )
    state_safe = True
    state_payload: dict[str, Any] = {}
    try:
        state_payload = build_audit_state(
            primary_path=primary_path,
            primary_name=manifest_name,
            sampled=sample,
            audit_all=args.audit_all,
            mask_review=args.mask_review,
            shard_index=args.shard_index,
            shard_count=args.shard_count,
            spec=args.contact_sheet_spec,
            mask_signatures=(
                mask_result.manifest_signatures
                if mask_result is not None
                else {}
            ),
        )
        validate_existing_audit_state(
            state_path,
            state_payload,
            ledger_candidates=[
                audit_csv,
                *qa_dir.glob(f"{file_prefix}_*.csv"),
            ],
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        state_safe = False
        issues.add(
            "error",
            "audit_state_mismatch",
            str(exc),
            path=str(state_path),
        )

    audit_csv_preserved = False
    audit_csv_ok = False
    contact_sheets: list[dict[str, Any]] = []
    if state_safe:
        try:
            audit_csv_preserved = write_audit_csv(
                audit_csv, sample, assets
            )
            audit_csv_ok = True
        except (OSError, ValueError, csv.Error) as exc:
            issues.add(
                "error",
                "audit_csv_write_failed",
                f"Could not safely write audit sample CSV: {exc}",
                path=str(audit_csv),
            )
        contact_sheets = create_contact_sheets(
            qa_dir,
            sample,
            assets,
            args.contact_sheet_spec,
            issues,
            audit_all=args.audit_all,
            shard_tag=shard_tag,
            mask_review=args.mask_review,
            mask_assets=(
                mask_result.assets if mask_result is not None else {}
            ),
        )
        dimensions = 1 if args.audit_all else 3
        expected_sheet_count = (
            dimensions
            * math.ceil(len(sample) / args.contact_sheet_spec.max_items)
            if sample
            else 0
        )
        if audit_csv_ok and len(contact_sheets) == expected_sheet_count:
            try:
                safe_write_report(state_path, state_payload)
            except OSError as exc:
                issues.add(
                    "error",
                    "audit_state_write_failed",
                    f"Could not atomically write audit state: {exc}",
                    path=str(state_path),
                )

    asset_counts = {
        "unique_referenced": len(assets),
        "existing": sum(asset.exists for asset in assets.values()),
        "decodable": sum(asset.decodable for asset in assets.values()),
        "native_crop": len(
            {
                row.image_asset_key
                for row in validation_rows
                if row.image_asset_key
            }
        ),
        "clip_224": len(
            {
                row.clip_asset_key
                for row in validation_rows
                if row.clip_asset_key
            }
        ),
        "validation_scope": (
            "full" if args.shard_count == 1 else "audit_shard"
        ),
    }
    mask_review_report: dict[str, Any] | None = None
    if mask_result is not None:
        mask_review_report = {
            "enabled": True,
            "masked_rows": mask_result.masked_count,
            "high_precision_rows": mask_result.high_precision_count,
            "reject_rows": mask_result.reject_count,
            "extraction_reject_rows": mask_result.extraction_reject_count,
            "no_mask_rows_in_audit_scope": sum(
                row.mask_join is not None
                and row.mask_join.record is None
                for row in shard_rows
            ),
            "mask_assets_referenced_in_validation_scope": len(
                mask_result.assets
            ),
            "mask_assets_decodable": sum(
                asset.decodable for asset in mask_result.assets.values()
            ),
            "manifest_signatures": mask_result.manifest_signatures,
        }
    report: dict[str, Any] = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "status": "fail" if issues.error_count else "pass",
        "dataset": str(dataset_root),
        "primary_manifest": manifest_name,
        "constraints": {
            "max_chapters_per_work": contract.max_chapters_per_work,
            "clip_image_size": list(contract.clip_size),
            "required_fields": list(CANONICAL_FIELDS),
        },
        "summary": {
            "manifest_rows": len(rows),
            "valid_rows": sum(not row.error_codes for row in rows),
            "rows_with_errors": sum(bool(row.error_codes) for row in rows),
            "sampled_rows": len(sample),
            "audit_scope_rows": len(shard_rows),
            "asset_validation_rows": len(validation_rows),
            "error_count": issues.error_count,
            "warning_count": issues.warning_count,
        },
        "assets": asset_counts,
        "mask_review": mask_review_report,
        "distributions": build_distributions(rows),
        "auxiliary_manifests": auxiliary,
        "audit_artifacts": {
            "audit_sample_csv": audit_csv.relative_to(dataset_root).as_posix(),
            "contact_sheets": contact_sheets,
            "stratification": ["work_id", "tier", "orientation"],
            "audit_all": bool(args.audit_all),
            "mask_review": bool(args.mask_review),
            "shard_index": args.shard_index,
            "shard_count": args.shard_count,
            "decision_values": ["pass", "reject", "recrop"],
            "ledger_merge_key": "id",
            "audit_state": state_path.relative_to(dataset_root).as_posix(),
            "audit_csv_preserved": audit_csv_preserved,
        },
        "error_counts": issues.summary_by_code("error"),
        "warning_counts": issues.summary_by_code("warning"),
        "issues": issues.details,
        "omitted_issue_details": issues.omitted_details,
    }
    report_path = qa_dir / (
        "report.json"
        if args.shard_count == 1
        else f"report_{shard_tag}.json"
    )
    try:
        safe_write_report(report_path, report)
    except OSError as exc:
        print(f"ERROR: could not write JSON report {report_path}: {exc}", file=sys.stderr)
        return 2

    print(
        (
            f"FontCLIP dataset QA: {report['status'].upper()} — "
            f"{len(rows)} rows, {issues.error_count} errors, "
            f"{issues.warning_count} warnings"
        ).replace(" — ", " - ")
    )
    print(f"Report: {report_path}")
    print(f"Audit sample: {audit_csv}")
    if contact_sheets:
        print(f"Contact sheets: {len(contact_sheets)} under {qa_dir}")
    return 1 if issues.error_count else 0


def main(argv: Sequence[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
