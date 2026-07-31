#!/usr/bin/env python3
"""Post-process real hard-style FontClip candidates without altering originals.

The input contract is the JSONL manifest emitted by
``build_fontclip_hard_candidates.py``.  This tool verifies both the original
library page and the miner's raw crop before producing immutable raw/context
copies and deterministic, source-derived assets:

* a tight glyph mask and source-colour RGBA glyph;
* black-on-white and white-on-black polarity normalizations;
* an independently measured LAB/HSV colour mask;
* fill, stroke, and outer-ring structural masks; and
* an optional deskewed RGBA view (the source geometry is always retained).

ComicTextMasker is used once per source page when its model and runtime are
available.  A conservative multi-polarity classical-CV path is always
available for non-balloon hard styles.  Sane CTD is preferred for text on or
near balloons; bubble-only candidates without sane CTD or a signed, clean
precomputed mask are quarantined rather than materialized.  Large enclosing
rings, open structural arcs, panel lines, crop-border contamination, and
mask-vs-text ROI coverage are measured for every option.  Severe masks are
rejected and ambiguous masks are marked for review.

The default materialization gate requires at least 5,000 candidates.
``--preflight-only`` attests the builder marker/report and reports the expected
301k+ asset count and a storage range without creating the output root.  No
diagnostic boxes, overlays, translated pages, or synthetic glyphs are written.
Completed pages are atomic, signed resume units.

Legacy builder outputs whose marker does not sign ``manifest_sha256`` require
``--expected-input-manifest-sha256`` so a row or bbox edit cannot pass a
count-only attestation.

Synthetic provenance is documented in ``SYNTHETIC_PROVENANCE_SPEC`` and in the
generated ``synthetic_provenance_schema.json``.  This tool never creates a
synthetic asset.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import shutil
import sys
import uuid
from collections import Counter, defaultdict, deque
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping, Sequence

import numpy as np
import PIL
from PIL import Image, ImageOps

try:
    import cv2
except Exception:  # pragma: no cover - exercised in minimal fallback runtimes
    cv2 = None  # type: ignore[assignment]

try:
    from fontclip_glyph_mask import (
        DEFAULT_CONFIG_PATH,
        DEFAULT_MODEL_PATH,
        DEFAULT_PREPROCESSOR_PATH,
        ComicTextMasker,
    )
except ImportError:  # Supports ``python -m scripts...``.
    from scripts.fontclip_glyph_mask import (  # type: ignore[no-redef]
        DEFAULT_CONFIG_PATH,
        DEFAULT_MODEL_PATH,
        DEFAULT_PREPROCESSOR_PATH,
        ComicTextMasker,
    )


TOOL_ID = "manga-translator-fontclip-hard-postprocessor"
INPUT_TOOL_ID = "manga-translator-fontclip-hard-candidates"
SCHEMA_VERSION = 1
ALGORITHM_VERSION = "hard-cv-v2"
INPUT_MARKER_NAME = ".fontclip-hard-candidates.json"
INPUT_REPORT_NAME = "report.json"
MARKER_NAME = ".fontclip-hard-postprocess.json"
STATE_DIR_NAME = ".fontclip-hard-postprocess-pages"
MANIFEST_NAME = "manifest.jsonl"
REJECTS_NAME = "rejects.jsonl"
REPORT_NAME = "report.json"
SYNTHETIC_SPEC_NAME = "synthetic_provenance_schema.json"
SUPPORTED_IMAGES = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
)
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_COMPONENT = re.compile(r"^[^/\\\x00]+$")
ALLOWED_INPUT_SPLITS = frozenset({"train", "val", "test"})
HARD_CATEGORY_PRIORITY = {
    "page_sound": 0,
    "ocr_sound_prior": 1,
    "bubble_edge": 2,
    "text_free": 3,
    "free_near_bubble": 4,
    "ocr_hard": 5,
    "ocr_anime_region": 6,
    "ocr_free_container": 7,
}
LARGE_ENCLOSURE_MIN_ROI_SPAN = 0.70
LARGE_ENCLOSURE_MIN_HOLE_ROI_COVERAGE = 0.35
LARGE_ENCLOSURE_MAX_BBOX_FILL = 0.40
LARGE_ENCLOSURE_MIN_OUTSIDE_ROI = 0.20
SEVERE_ENCLOSURE_INK_RATIO = 0.45
MODERATE_ENCLOSURE_INK_RATIO = 0.25
SEVERE_LINE_CONTAMINATION_RATIO = 0.65
MODERATE_LINE_CONTAMINATION_RATIO = 0.20

ASSET_DIRECTORIES = {
    "raw": "images/raw",
    "context": "images/context",
    "glyph_rgba": "images/glyph_rgba",
    "mask": "images/mask",
    "black_on_white": "images/polarity_black_on_white",
    "white_on_black": "images/polarity_white_on_black",
    "color_mask": "images/color_mask",
    "outline_fill": "images/outline_fill",
    "outline_stroke": "images/outline_stroke",
    "outline_outer_ring": "images/outline_outer_ring",
    "glyph_224": "images/glyph_224",
    "context_224": "images/context_224",
    "deskew_rgba": "images/deskew_rgba",
}
OWNED_OUTPUTS = (
    STATE_DIR_NAME,
    *ASSET_DIRECTORIES.values(),
    MANIFEST_NAME,
    REJECTS_NAME,
    REPORT_NAME,
    SYNTHETIC_SPEC_NAME,
)

SYNTHETIC_PROVENANCE_SPEC: dict[str, Any] = {
    "schema_version": 1,
    "status": "design_only",
    "generated_by_this_tool": False,
    "required_provenance": "synthetic_composite",
    "required_parentage": {
        "root_real_id": "nullable only for a fully synthetic background plate",
        "parent_ids": "all real and generated inputs in deterministic order",
        "lineage": "complete ordered transformation lineage",
    },
    "korean_glyph_policy": {
        "glyph_source": "real_font_render",
        "generative_glyphs_forbidden": True,
        "required_fields": [
            "font_id",
            "font_file_sha256",
            "face_index",
            "weight",
            "license_id",
            "render_engine",
            "render_engine_version",
            "exact_text",
            "unicode_coverage_verified",
        ],
    },
    "generated_plate_policy": {
        "allowed_scopes": ["background_only", "effect_plate_only"],
        "required_fields": [
            "model",
            "model_revision",
            "prompt_sha256",
            "seed",
            "plate_sha256",
            "text_detector_pass",
            "human_review_status",
        ],
        "accidental_generated_text_forbidden": True,
    },
    "split_policy": (
        "Every synthetic or processed child must remain in the same work-level "
        "split as every real parent."
    ),
}

LOADED_PROCESSOR_PATH = Path(__file__).resolve()
_LOADED_PROCESSOR_BYTES = LOADED_PROCESSOR_PATH.read_bytes()
LOADED_PROCESSOR_SIGNATURE = {
    "path": str(LOADED_PROCESSOR_PATH),
    "exists": True,
    "sha256": hashlib.sha256(_LOADED_PROCESSOR_BYTES).hexdigest(),
    "size": len(_LOADED_PROCESSOR_BYTES),
}
del _LOADED_PROCESSOR_BYTES

BBox = tuple[int, int, int, int]


class HardPostprocessError(RuntimeError):
    """Expected command-line, input, or processing error."""


class InputValidationError(HardPostprocessError):
    """Raised when the candidate manifest does not satisfy the strict contract."""


class SourceIntegrityError(HardPostprocessError):
    """Raised when a signed original page or raw crop has changed."""


class UnsafeOutputError(HardPostprocessError):
    """Raised when output ownership or path containment cannot be proven."""


class ResumeValidationError(HardPostprocessError):
    """Raised when a completed shard or one of its assets was changed."""


class RecoverableMaskError(HardPostprocessError):
    """A per-candidate failure that may be written to the reject ledger."""


@dataclass(frozen=True)
class PrecomputedMask:
    path: Path
    relative_path: str
    expected_sha256: str
    bbox_px: BBox


@dataclass(frozen=True)
class InputCandidate:
    line_number: int
    row: dict[str, Any]
    row_sha256: str
    sample_id: str
    split: str
    work_id: str
    chapter_id: str
    page_id: str
    source_relative: str
    source_path: Path
    raw_relative: str
    raw_path: Path
    bbox_px: BBox
    crop_bbox_px: BBox
    precomputed_mask: PrecomputedMask | None
    precomputed_notice: str | None

    @property
    def page_key(self) -> str:
        return self.source_relative

    @property
    def deterministic_key(self) -> tuple[Any, ...]:
        return (
            self.work_id,
            self.chapter_id,
            self.page_id,
            self.bbox_px,
            self.sample_id,
        )


@dataclass(frozen=True)
class OutputLayout:
    root: Path
    marker: Path
    state_dir: Path
    manifest: Path
    rejects: Path
    report: Path
    synthetic_spec: Path
    asset_dirs: dict[str, Path]

    @property
    def owned_paths(self) -> tuple[Path, ...]:
        return (
            self.state_dir,
            *self.asset_dirs.values(),
            self.manifest,
            self.rejects,
            self.report,
            self.synthetic_spec,
        )


@dataclass(frozen=True)
class VerifiedPage:
    rgb: np.ndarray
    file_sha256: str
    size_bytes: int
    width: int
    height: int


@dataclass(frozen=True)
class VerifiedRaw:
    rgb: np.ndarray
    file_bytes: bytes
    file_sha256: str
    pixel_sha256: str


@dataclass(frozen=True)
class Component:
    label: int
    area: int
    bbox: BBox
    touches_border: bool


@dataclass(frozen=True)
class MaskOption:
    name: str
    mask: np.ndarray
    stats: dict[str, Any]
    metadata: dict[str, Any]
    preference_bonus: float = 0.0

    @property
    def effective_score(self) -> float:
        return float(self.stats["quality_score"]) + self.preference_bonus


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(_canonical_json(value).encode("utf-8"))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _pixel_sha256(image: Image.Image) -> str:
    canonical = image
    if canonical.mode not in {"RGB", "RGBA", "L"}:
        canonical = canonical.convert("RGB")
    digest = hashlib.sha256()
    digest.update(canonical.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(f"{canonical.width}x{canonical.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(canonical.tobytes())
    return digest.hexdigest()


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _read_jsonl(path: Path) -> list[tuple[int, dict[str, Any]]]:
    records: list[tuple[int, dict[str, Any]]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise InputValidationError(
                    f"invalid JSONL at {path}:{line_number}: {exc}"
                ) from exc
            if not isinstance(value, dict):
                raise InputValidationError(
                    f"expected a JSON object at {path}:{line_number}"
                )
            records.append((line_number, value))
    return records


def _atomic_write_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_write_json(path: Path, value: Any) -> None:
    encoded = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    _atomic_write_bytes(path, encoded)


def _atomic_write_jsonl(
    path: Path,
    records: Iterable[Mapping[str, Any]],
) -> None:
    payload = "".join(f"{_canonical_json(record)}\n" for record in records)
    _atomic_write_bytes(path, payload.encode("utf-8"))


def _encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def _is_within(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _safe_component(value: Any, label: str) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or text in {".", ".."} or not SAFE_COMPONENT.fullmatch(text):
        raise InputValidationError(f"unsafe or empty {label}: {value!r}")
    return text


def _relative_path(
    value: Any,
    *,
    label: str,
) -> tuple[str, PurePosixPath]:
    if not isinstance(value, str) or not value.strip():
        raise InputValidationError(f"missing {label}")
    normalized = value.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    pure = PurePosixPath(normalized)
    if (
        pure.is_absolute()
        or not pure.parts
        or any(part in {"", ".", ".."} for part in pure.parts)
        or ":" in pure.parts[0]
    ):
        raise InputValidationError(f"unsafe {label}: {value!r}")
    return pure.as_posix(), pure


def _bbox(value: Any, label: str) -> BBox:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 4
        or any(isinstance(item, bool) or not isinstance(item, int) for item in value)
    ):
        raise InputValidationError(f"{label} must contain four integer coordinates")
    x1, y1, x2, y2 = (int(item) for item in value)
    if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
        raise InputValidationError(f"invalid {label}: {value!r}")
    return x1, y1, x2, y2


def _valid_sha256(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if HEX_SHA256.fullmatch(normalized):
            return normalized
    return None


def _resolve_inside(root: Path, relative: PurePosixPath, label: str) -> Path:
    candidate = root.joinpath(*relative.parts).resolve()
    if not _is_within(root, candidate):
        raise InputValidationError(f"{label} escaped its root: {relative}")
    return candidate


def _strict_source_path(
    row: Mapping[str, Any],
    library_root: Path,
) -> tuple[str, Path]:
    normalized, pure = _relative_path(
        row.get("source_image_path"),
        label="source_image_path",
    )
    parts = pure.parts
    work_id = _safe_component(row.get("work_id"), "work_id")
    chapter_id = _safe_component(row.get("chapter_id"), "chapter_id")
    if (
        len(parts) != 6
        or parts[0] != "works"
        or parts[1] != work_id
        or parts[2] != "chapters"
        or parts[3] != chapter_id
        or parts[4] != "pages"
        or Path(parts[5]).suffix.lower() not in SUPPORTED_IMAGES
    ):
        raise InputValidationError(
            "source_image_path must be an original "
            "works/<work>/chapters/<chapter>/pages/<image> path; "
            "runs, previews, and overlays are forbidden"
        )
    path = _resolve_inside(library_root, pure, "source_image_path")
    physical_page_root = (
        library_root / "works" / work_id / "chapters" / chapter_id / "pages"
    ).resolve()
    if not _is_within(physical_page_root, path) or path.parent != physical_page_root:
        raise InputValidationError(
            "source_image_path resolves outside the original pages directory; "
            "overlay symlinks are forbidden"
        )
    if not path.is_file():
        raise InputValidationError(f"source page is missing: {path}")
    return normalized, path


def _strict_raw_path(
    row: Mapping[str, Any],
    input_root: Path,
    *,
    sample_id: str,
    split: str,
) -> tuple[str, Path]:
    normalized, pure = _relative_path(row.get("image_path"), label="image_path")
    parts = pure.parts
    if (
        len(parts) != 4
        or parts[0] != "images"
        or parts[1] != "raw"
        or parts[2] != split
        or Path(parts[3]).suffix.lower() != ".png"
        or Path(parts[3]).stem != sample_id
    ):
        raise InputValidationError(
            "image_path must be the miner's exact images/raw/<split>/<id>.png; "
            "clip, preview, and overlay images are forbidden"
        )
    path = _resolve_inside(input_root, pure, "image_path")
    physical_raw_root = (input_root / "images" / "raw" / split).resolve()
    if not _is_within(physical_raw_root, path) or path.parent != physical_raw_root:
        raise InputValidationError(
            "image_path resolves outside its raw split directory; "
            "preview symlinks are forbidden"
        )
    if not path.is_file():
        raise InputValidationError(f"raw candidate crop is missing: {path}")
    return normalized, path


def _precomputed_mask(
    row: Mapping[str, Any],
    input_root: Path,
) -> tuple[PrecomputedMask | None, str | None]:
    path_value = row.get("glyph_mask_path")
    mask_paths = row.get("mask_paths")
    if not path_value and isinstance(mask_paths, Mapping):
        path_value = mask_paths.get("mask")
    if not path_value:
        return None, None

    hashes = row.get("mask_asset_sha256")
    expected = hashes.get("mask") if isinstance(hashes, Mapping) else None
    expected_sha = _valid_sha256(expected)
    if expected_sha is None:
        return None, "precomputed_mask_unverified"

    normalized, pure = _relative_path(path_value, label="glyph_mask_path")
    path = _resolve_inside(input_root, pure, "glyph_mask_path")
    if not path.is_file() or path.suffix.lower() != ".png":
        return None, "precomputed_mask_missing"

    bbox_value = (
        row.get("mask_tight_bbox_px")
        or row.get("ctd_tight_bbox_px")
        or row.get("final_bbox_px")
    )
    try:
        mask_bbox = _bbox(bbox_value, "precomputed mask bbox")
    except InputValidationError:
        return None, "precomputed_mask_bbox_missing"
    return (
        PrecomputedMask(
            path=path,
            relative_path=normalized,
            expected_sha256=expected_sha,
            bbox_px=mask_bbox,
        ),
        None,
    )


def _load_input(
    manifest: Path,
    *,
    input_root: Path,
    library_root: Path,
) -> list[InputCandidate]:
    rows = _read_jsonl(manifest)
    if not rows:
        raise InputValidationError(f"candidate manifest is empty: {manifest}")

    seen_ids: set[str] = set()
    work_splits: dict[str, str] = {}
    work_chapters: dict[str, set[str]] = defaultdict(set)
    result: list[InputCandidate] = []
    for line_number, row in rows:
        sample_id = _safe_component(row.get("id"), f"id at line {line_number}")
        if sample_id in seen_ids:
            raise InputValidationError(f"duplicate candidate id: {sample_id}")
        seen_ids.add(sample_id)
        if (
            type(row.get("schema_version")) is not int
            or row["schema_version"] != SCHEMA_VERSION
        ):
            raise InputValidationError(
                f"{sample_id} is not a schema-v{SCHEMA_VERSION} hard candidate"
            )
        if row.get("tier") != "hard_candidate":
            raise InputValidationError(
                f"{sample_id} does not have the hard_candidate tier"
            )
        if row.get("provenance") != "real_mined":
            raise InputValidationError(
                f"{sample_id} is not a real_mined hard candidate"
            )
        split = _safe_component(row.get("split"), f"split for {sample_id}")
        if split not in ALLOWED_INPUT_SPLITS:
            raise InputValidationError(
                f"{sample_id} has unsupported split {split!r}; "
                "expected train, val, or test"
            )
        categories_value = row.get("categories")
        if not isinstance(categories_value, list) or not categories_value:
            raise InputValidationError(
                f"{sample_id} lacks a non-empty hard-candidate categories list"
            )
        if any(
            not isinstance(value, str) or value not in HARD_CATEGORY_PRIORITY
            for value in categories_value
        ):
            raise InputValidationError(
                f"{sample_id} has an unsupported hard-candidate category"
            )
        expected_categories = sorted(
            set(categories_value),
            key=lambda value: (HARD_CATEGORY_PRIORITY[value], value),
        )
        if categories_value != expected_categories:
            raise InputValidationError(
                f"{sample_id} categories are duplicated or not canonically ordered"
            )
        if row.get("primary_category") != expected_categories[0]:
            raise InputValidationError(
                f"{sample_id} primary_category does not match its categories"
            )
        work_id = _safe_component(row.get("work_id"), f"work_id for {sample_id}")
        chapter_id = _safe_component(
            row.get("chapter_id"),
            f"chapter_id for {sample_id}",
        )
        page_id = _safe_component(row.get("page_id"), f"page_id for {sample_id}")
        previous_split = work_splits.setdefault(work_id, split)
        if previous_split != split:
            raise InputValidationError(
                f"work {work_id} crosses splits: {previous_split} and {split}"
            )
        work_chapters[work_id].add(chapter_id)
        if len(work_chapters[work_id]) > 20:
            raise InputValidationError(
                f"work {work_id} exceeds the hard QA limit of 20 chapters"
            )

        source_relative, source_path = _strict_source_path(row, library_root)
        raw_relative, raw_path = _strict_raw_path(
            row,
            input_root,
            sample_id=sample_id,
            split=split,
        )
        bbox_px = _bbox(row.get("bbox_px"), f"bbox_px for {sample_id}")
        crop_bbox_px = _bbox(
            row.get("crop_bbox_px"),
            f"crop_bbox_px for {sample_id}",
        )
        if not (
            crop_bbox_px[0] <= bbox_px[0] < bbox_px[2] <= crop_bbox_px[2]
            and crop_bbox_px[1] <= bbox_px[1] < bbox_px[3] <= crop_bbox_px[3]
        ):
            raise InputValidationError(
                f"candidate bbox escapes crop bbox for {sample_id}"
            )

        source_sha = _valid_sha256(row.get("source_page_sha256"))
        crop_sha = _valid_sha256(row.get("crop_sha256"))
        asset_hashes = row.get("asset_file_sha256")
        raw_sha = (
            _valid_sha256(asset_hashes.get("image_path"))
            if isinstance(asset_hashes, Mapping)
            else None
        )
        if source_sha is None or crop_sha is None or raw_sha is None:
            raise InputValidationError(
                f"{sample_id} lacks signed source/raw/crop SHA-256 values"
            )

        precomputed, notice = _precomputed_mask(row, input_root)
        result.append(
            InputCandidate(
                line_number=line_number,
                row=dict(row),
                row_sha256=_sha256_json(row),
                sample_id=sample_id,
                split=split,
                work_id=work_id,
                chapter_id=chapter_id,
                page_id=page_id,
                source_relative=source_relative,
                source_path=source_path,
                raw_relative=raw_relative,
                raw_path=raw_path,
                bbox_px=bbox_px,
                crop_bbox_px=crop_bbox_px,
                precomputed_mask=precomputed,
                precomputed_notice=notice,
            )
        )
    result.sort(key=lambda item: item.deterministic_key)
    return result


def _attest_input_dataset(
    *,
    input_root: Path,
    library_root: Path,
    manifest: Path,
    manifest_sha256: str,
    items: Sequence[InputCandidate],
    expected_manifest_sha256: str | None,
) -> dict[str, Any]:
    marker_path = input_root / INPUT_MARKER_NAME
    report_path = input_root / INPUT_REPORT_NAME
    if not marker_path.is_file() or not report_path.is_file():
        raise InputValidationError(
            "hard-candidate builder marker/report attestation is missing"
        )
    try:
        marker = _read_json(marker_path)
        report = _read_json(report_path)
    except (OSError, json.JSONDecodeError) as exc:
        raise InputValidationError(
            "cannot read hard-candidate builder attestation"
        ) from exc
    if (
        not isinstance(marker, Mapping)
        or marker.get("tool") != INPUT_TOOL_ID
        or marker.get("schema_version") != SCHEMA_VERSION
        or not isinstance(marker.get("signature"), Mapping)
        or _valid_sha256(marker.get("signature_sha256")) is None
        or marker.get("signature_sha256") != _sha256_json(marker["signature"])
    ):
        raise InputValidationError("hard-candidate builder marker is invalid")
    marker_signature = marker["signature"]
    builder_manifest_sha256 = (
        _valid_sha256(marker_signature.get("manifest_sha256"))
        if isinstance(marker_signature, Mapping)
        else None
    )
    operator_manifest_sha256 = _valid_sha256(expected_manifest_sha256)
    if builder_manifest_sha256 is None and operator_manifest_sha256 is None:
        raise InputValidationError(
            "the builder marker does not sign manifest_sha256; pass "
            "--expected-input-manifest-sha256 to pin the audited manifest"
        )
    if (
        builder_manifest_sha256 is not None
        and manifest_sha256 != builder_manifest_sha256
    ):
        raise InputValidationError(
            "input manifest SHA-256 does not match the builder marker signature"
        )
    if (
        operator_manifest_sha256 is not None
        and manifest_sha256 != operator_manifest_sha256
    ):
        raise InputValidationError(
            "input manifest SHA-256 does not match the operator CLI pin"
        )
    try:
        marked_root = Path(str(marker.get("output_root"))).resolve()
    except (OSError, ValueError) as exc:
        raise InputValidationError(
            "hard-candidate builder marker has an invalid output root"
        ) from exc
    owned_outputs = marker.get("owned_outputs")
    if (
        marked_root != input_root
        or not isinstance(owned_outputs, list)
        or any(not isinstance(value, str) for value in owned_outputs)
        or not {
            MANIFEST_NAME,
            INPUT_REPORT_NAME,
            "images/raw",
        }.issubset(set(owned_outputs))
    ):
        raise InputValidationError(
            "hard-candidate builder marker does not own this input dataset"
        )
    if (
        not isinstance(report, Mapping)
        or report.get("tool") != INPUT_TOOL_ID
        or report.get("schema_version") != SCHEMA_VERSION
        or report.get("run_signature_sha256") != marker["signature_sha256"]
        or report.get("candidate_records") != len(items)
    ):
        raise InputValidationError(
            "hard-candidate builder report count/signature does not attest the manifest"
        )
    try:
        reported_root = Path(str(report.get("output_root"))).resolve()
        reported_library = Path(str(report.get("library_root"))).resolve()
    except (OSError, ValueError) as exc:
        raise InputValidationError(
            "hard-candidate builder report contains invalid roots"
        ) from exc
    if reported_root != input_root or reported_library != library_root:
        raise InputValidationError(
            "hard-candidate builder report roots do not match this run"
        )
    configuration = report.get("configuration")
    maximum_chapters = (
        configuration.get("max_chapters_per_work")
        if isinstance(configuration, Mapping)
        else None
    )
    if type(maximum_chapters) is not int or not 1 <= maximum_chapters <= 20:
        raise InputValidationError(
            "hard-candidate builder report has an invalid chapter limit"
        )
    expected_splits = dict(sorted(Counter(item.split for item in items).items()))
    expected_categories = dict(
        sorted(
            Counter(
                category for item in items for category in item.row["categories"]
            ).items()
        )
    )
    if (
        report.get("by_split") != expected_splits
        or report.get("category_memberships") != expected_categories
        or report.get("unique_crop_sha256")
        != len({str(item.row["crop_sha256"]) for item in items})
    ):
        raise InputValidationError(
            "hard-candidate builder report inventory does not match the manifest"
        )
    return {
        "tool": INPUT_TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "marker_path": str(marker_path),
        "marker_sha256": _sha256_file(marker_path),
        "report_path": str(report_path),
        "report_sha256": _sha256_file(report_path),
        "builder_signature_sha256": marker["signature_sha256"],
        "manifest_path": str(manifest),
        "manifest_sha256": manifest_sha256,
        "manifest_rows": len(items),
        "max_chapters_per_work": maximum_chapters,
        "count_signature_attested": True,
        "exact_manifest_sha256_attested": True,
        "manifest_sha256_binding": (
            "builder_marker_signature+operator_cli_pin"
            if builder_manifest_sha256 is not None
            and operator_manifest_sha256 is not None
            else (
                "builder_marker_signature"
                if builder_manifest_sha256 is not None
                else "operator_cli_pin"
            )
        ),
    }


def _output_forecast(
    items: Sequence[InputCandidate],
    *,
    context_padding_max: int,
    minimum_processed_records: int,
) -> dict[str, Any]:
    """Return a conservative, no-materialization storage preflight."""

    raw_copy_bytes = 0
    derived_uncompressed_bytes = 0
    fixed_letterbox_bytes = 2 * 224 * 224 * 3
    for item in items:
        raw_copy_bytes += item.raw_path.stat().st_size
        crop_width = item.crop_bbox_px[2] - item.crop_bbox_px[0]
        crop_height = item.crop_bbox_px[3] - item.crop_bbox_px[1]
        crop_area = crop_width * crop_height
        page_size = item.row["page_size_px"]
        bbox_width = item.bbox_px[2] - item.bbox_px[0]
        bbox_height = item.bbox_px[3] - item.bbox_px[1]
        context_width = min(
            int(page_size[0]),
            bbox_width + 2 * context_padding_max,
        )
        context_height = min(
            int(page_size[1]),
            bbox_height + 2 * context_padding_max,
        )
        context_area = max(1, context_width * context_height)
        # Worst-case planning proxy before PNG compression: context RGB;
        # glyph RGBA; five L masks; two RGB polarities; and two fixed RGB
        # letterboxes. Tight assets are bounded by the signed raw crop.
        derived_uncompressed_bytes += (
            context_area * 3 + crop_area * (4 + 5 + 6) + fixed_letterbox_bytes
        )
    records = len(items)
    mandatory_files = records * 12
    optional_deskew_files = records
    planning_low = raw_copy_bytes + round(derived_uncompressed_bytes * 0.08)
    planning_high = raw_copy_bytes + derived_uncompressed_bytes
    return {
        "candidate_records": records,
        "minimum_processed_records_required": minimum_processed_records,
        "mandatory_png_files_if_all_processed": mandatory_files,
        "optional_deskew_png_files_at_most": optional_deskew_files,
        "maximum_png_files_if_all_processed": (mandatory_files + optional_deskew_files),
        "known_raw_copy_bytes": raw_copy_bytes,
        "derived_uncompressed_pixel_payload_bytes": (derived_uncompressed_bytes),
        "planning_png_bytes_range": [planning_low, planning_high],
        "planning_note": (
            "PNG size is content-dependent; the range uses 8%-100% of "
            "uncompressed derived pixel payload plus exact raw-copy bytes. "
            "The completed report records exact encoded bytes."
        ),
        "raw_storage_strategy": {
            "mode": "byte_exact_copy",
            "hardlinks_enabled": False,
            "external_references_enabled": False,
            "reason": (
                "Hardlinks would couple input/output mutation and external "
                "references would make the dataset non-self-contained."
            ),
        },
    }


def _assert_input_attestation_unchanged(
    attestation: Mapping[str, Any],
) -> None:
    for kind in ("marker", "report"):
        path = Path(str(attestation[f"{kind}_path"]))
        expected = attestation[f"{kind}_sha256"]
        if _sha256_file(path) != expected:
            raise SourceIntegrityError(
                f"input builder {kind} changed during processing: {path}"
            )


def _inspect_preflight_output(layout: OutputLayout) -> dict[str, Any]:
    if not layout.root.exists():
        return {
            "state": "absent",
            "owned": False,
            "output_written": False,
        }
    if not layout.root.is_dir():
        raise UnsafeOutputError(
            f"preflight output root is not a directory: {layout.root}"
        )
    marker = _load_marker(layout.marker)
    existing = any(layout.root.iterdir())
    if existing and marker is None:
        raise UnsafeOutputError(
            "preflight found occupied output without the exact ownership "
            f"marker: {layout.root}"
        )
    if marker is not None:
        _validate_marker(marker, layout)
        return {
            "state": "owned_existing",
            "owned": True,
            "output_written": False,
            "marker_sha256": _sha256_file(layout.marker),
            "run_signature_sha256": marker.get("signature_sha256"),
        }
    return {
        "state": "empty_directory",
        "owned": False,
        "output_written": False,
    }


def _preflight_verify_signed_inputs(
    items: Sequence[InputCandidate],
    *,
    quiet: bool,
) -> dict[str, Any]:
    groups: dict[str, list[InputCandidate]] = defaultdict(list)
    for item in items:
        groups[item.page_key].append(item)
    ordered_groups = sorted(
        groups.items(),
        key=lambda entry: min(item.deterministic_key for item in entry[1]),
    )
    source_bytes = 0
    raw_bytes = 0
    precomputed_masks = 0
    for index, (_page_key, page_items) in enumerate(ordered_groups, 1):
        page_items.sort(key=lambda item: item.deterministic_key)
        page = _verified_page(page_items)
        source_bytes += page.size_bytes
        for item in page_items:
            raw = _verified_raw(item, page)
            raw_bytes += len(raw.file_bytes)
            if item.precomputed_mask is not None:
                precomputed_masks += 1
        _assert_page_inputs_unchanged(page, page_items)
        if index == 1 or index % 100 == 0 or index == len(ordered_groups):
            _progress(
                "[preflight verify] "
                f"pages={index}/{len(ordered_groups)} "
                f"candidates={sum(len(group) for _, group in ordered_groups[:index])}",
                quiet,
            )
    _assert_all_inputs_unchanged(items)
    return {
        "verified_source_pages": len(ordered_groups),
        "verified_source_bytes": source_bytes,
        "verified_raw_crops": len(items),
        "verified_raw_bytes": raw_bytes,
        "verified_precomputed_masks": precomputed_masks,
        "source_file_sha256_verified": True,
        "raw_file_and_pixel_sha256_verified": True,
        "source_crop_pixel_equality_verified": True,
        "final_all_input_rehash_verified": True,
    }


def _validate_output_root(
    output_root: Path,
    *,
    input_root: Path,
    library_root: Path,
    repo_root: Path,
) -> Path:
    output = output_root.expanduser().resolve()
    protected = {
        Path(output.anchor).resolve(),
        Path.home().resolve(),
        Path.cwd().resolve(),
        input_root.resolve(),
        library_root.resolve(),
        repo_root.resolve(),
    }
    if output in protected or not output.name:
        raise UnsafeOutputError(f"unsafe output root: {output}")
    for root in (input_root.resolve(), library_root.resolve()):
        if _is_within(root, output) or _is_within(output, root):
            raise UnsafeOutputError(
                f"output must be separate and non-nested from {root}: {output}"
            )
    return output


def _layout(root: Path) -> OutputLayout:
    return OutputLayout(
        root=root,
        marker=root / MARKER_NAME,
        state_dir=root / STATE_DIR_NAME,
        manifest=root / MANIFEST_NAME,
        rejects=root / REJECTS_NAME,
        report=root / REPORT_NAME,
        synthetic_spec=root / SYNTHETIC_SPEC_NAME,
        asset_dirs={
            name: root / relative for name, relative in ASSET_DIRECTORIES.items()
        },
    )


def _load_marker(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        raise UnsafeOutputError(f"cannot verify ownership marker: {path}") from exc
    if (
        not isinstance(value, dict)
        or value.get("tool") != TOOL_ID
        or value.get("schema_version") != SCHEMA_VERSION
    ):
        raise UnsafeOutputError(f"unrecognized ownership marker: {path}")
    return value


def _validate_marker(marker: Mapping[str, Any], layout: OutputLayout) -> None:
    signature = marker.get("signature")
    if (
        marker.get("output_root") != str(layout.root)
        or marker.get("owned_outputs") != list(OWNED_OUTPUTS)
        or not isinstance(signature, dict)
        or marker.get("signature_sha256") != _sha256_json(signature)
    ):
        raise UnsafeOutputError("ownership marker does not match this output")


def _remove_owned(path: Path, root: Path) -> None:
    is_junction = getattr(path, "is_junction", lambda: False)
    if path.is_symlink() or bool(is_junction()):
        raise UnsafeOutputError(
            f"refusing to remove replaced owned link or junction: {path}"
        )
    resolved = path.resolve()
    if not _is_within(root, resolved) or resolved == root.resolve():
        raise UnsafeOutputError(f"refusing to remove unsafe owned path: {resolved}")
    if resolved.is_dir():
        shutil.rmtree(resolved)
    else:
        resolved.unlink(missing_ok=True)


def _prepare_output(
    layout: OutputLayout,
    *,
    signature: Mapping[str, Any],
    overwrite: bool,
    dry_run: bool,
) -> bool:
    if layout.root.exists() and not layout.root.is_dir():
        raise UnsafeOutputError(f"output root is not a directory: {layout.root}")
    marker = _load_marker(layout.marker)
    if marker is not None:
        _validate_marker(marker, layout)
    existing = layout.root.exists() and any(layout.root.iterdir())

    if overwrite:
        if existing and marker is None:
            raise UnsafeOutputError(
                f"refusing overwrite without exact marker: {layout.marker}"
            )
        if dry_run:
            return False
        if marker is not None:
            for path in layout.owned_paths:
                _remove_owned(path, layout.root)
            layout.marker.unlink(missing_ok=True)
        marker = None
    elif marker is None and existing:
        raise UnsafeOutputError(
            f"output is not empty and has no ownership marker: {layout.root}"
        )
    elif marker is not None and marker.get("signature") != dict(signature):
        raise UnsafeOutputError(
            "output signature changed; pass --overwrite for a guarded rebuild"
        )

    resumed = marker is not None
    if dry_run:
        return resumed
    layout.root.mkdir(parents=True, exist_ok=True)
    if marker is None:
        marker_payload = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "created_at": _utc_now(),
            "output_root": str(layout.root),
            "owned_outputs": list(OWNED_OUTPUTS),
            "signature": dict(signature),
            "signature_sha256": _sha256_json(signature),
        }
        _atomic_write_json(layout.marker, marker_payload)
    layout.state_dir.mkdir(parents=True, exist_ok=True)
    return resumed


def _content_signature(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"path": str(path), "exists": False, "sha256": None, "size": None}
    return {
        "path": str(path),
        "exists": True,
        "sha256": _sha256_file(path),
        "size": path.stat().st_size,
    }


def _verified_page(items: Sequence[InputCandidate]) -> VerifiedPage:
    first = items[0]
    source_bytes = first.source_path.read_bytes()
    source_sha = _sha256_bytes(source_bytes)
    for item in items:
        expected = _valid_sha256(item.row.get("source_page_sha256"))
        if item.source_path != first.source_path or expected != source_sha:
            raise SourceIntegrityError(
                f"source page SHA-256 changed for {item.sample_id}: "
                f"{source_sha} != {expected}"
            )
        signature = item.row.get("source_page_content_signature")
        if isinstance(signature, Mapping):
            signature_sha = _valid_sha256(signature.get("sha256"))
            signature_size = signature.get("size")
            if signature_sha not in {None, source_sha}:
                raise SourceIntegrityError(
                    f"source content signature disagrees for {item.sample_id}"
                )
            if isinstance(signature_size, int) and signature_size != len(source_bytes):
                raise SourceIntegrityError(
                    f"source byte size changed for {item.sample_id}"
                )
    try:
        with Image.open(io.BytesIO(source_bytes)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
    except (OSError, ValueError) as exc:
        raise SourceIntegrityError(
            f"cannot decode signed source page: {first.source_path}"
        ) from exc
    rgb = np.ascontiguousarray(np.asarray(image, dtype=np.uint8))
    width, height = image.size
    for item in items:
        page_size = item.row.get("page_size_px")
        if (
            not isinstance(page_size, (list, tuple))
            or len(page_size) != 2
            or [width, height] != list(page_size)
        ):
            raise SourceIntegrityError(
                f"actual source dimensions changed for {item.sample_id}: "
                f"{width}x{height} != {page_size!r}"
            )
        signature = item.row.get("source_page_content_signature")
        if isinstance(signature, Mapping):
            signed_width = signature.get("width")
            signed_height = signature.get("height")
            if (
                isinstance(signed_width, int)
                and isinstance(signed_height, int)
                and (signed_width, signed_height) != (width, height)
            ):
                raise SourceIntegrityError(
                    f"signed source dimensions changed for {item.sample_id}"
                )
        for label, box in (
            ("bbox_px", item.bbox_px),
            ("crop_bbox_px", item.crop_bbox_px),
        ):
            if box[2] > width or box[3] > height:
                raise SourceIntegrityError(
                    f"{label} exceeds the signed page for {item.sample_id}"
                )
    return VerifiedPage(
        rgb=rgb,
        file_sha256=source_sha,
        size_bytes=len(source_bytes),
        width=width,
        height=height,
    )


def _verified_raw(item: InputCandidate, page: VerifiedPage) -> VerifiedRaw:
    raw_bytes = item.raw_path.read_bytes()
    raw_file_sha = _sha256_bytes(raw_bytes)
    asset_hashes = item.row.get("asset_file_sha256")
    expected_file_sha = (
        _valid_sha256(asset_hashes.get("image_path"))
        if isinstance(asset_hashes, Mapping)
        else None
    )
    if raw_file_sha != expected_file_sha:
        raise SourceIntegrityError(
            f"raw crop file changed for {item.sample_id}: "
            f"{raw_file_sha} != {expected_file_sha}"
        )
    try:
        with Image.open(io.BytesIO(raw_bytes)) as opened:
            raw_image = opened.convert("RGB")
    except (OSError, ValueError) as exc:
        raise SourceIntegrityError(
            f"cannot decode signed raw crop: {item.raw_path}"
        ) from exc
    expected_size = (
        item.crop_bbox_px[2] - item.crop_bbox_px[0],
        item.crop_bbox_px[3] - item.crop_bbox_px[1],
    )
    if raw_image.size != expected_size:
        raise SourceIntegrityError(
            f"raw crop size changed for {item.sample_id}: "
            f"{raw_image.size} != {expected_size}"
        )
    pixel_sha = _pixel_sha256(raw_image)
    expected_pixel_sha = _valid_sha256(item.row.get("crop_sha256"))
    if pixel_sha != expected_pixel_sha:
        raise SourceIntegrityError(
            f"raw crop pixels changed for {item.sample_id}: "
            f"{pixel_sha} != {expected_pixel_sha}"
        )
    x1, y1, x2, y2 = item.crop_bbox_px
    source_crop = Image.fromarray(page.rgb[y1:y2, x1:x2])
    if _pixel_sha256(source_crop) != expected_pixel_sha:
        raise SourceIntegrityError(f"source crop no longer reproduces {item.sample_id}")
    raw_rgb = np.ascontiguousarray(np.asarray(raw_image, dtype=np.uint8))
    if not np.array_equal(raw_rgb, np.asarray(source_crop, dtype=np.uint8)):
        raise SourceIntegrityError(
            f"raw crop and original source pixels disagree for {item.sample_id}"
        )
    return VerifiedRaw(
        rgb=raw_rgb,
        file_bytes=raw_bytes,
        file_sha256=raw_file_sha,
        pixel_sha256=pixel_sha,
    )


def _assert_page_inputs_unchanged(
    page: VerifiedPage,
    items: Sequence[InputCandidate],
) -> None:
    source_path = items[0].source_path
    if _sha256_file(source_path) != page.file_sha256:
        raise SourceIntegrityError(
            f"source page changed during processing: {source_path}"
        )
    for item in items:
        expected_raw = item.row["asset_file_sha256"]["image_path"]
        if _sha256_file(item.raw_path) != expected_raw:
            raise SourceIntegrityError(
                f"raw crop changed during processing: {item.raw_path}"
            )
        spec = item.precomputed_mask
        if spec is not None and _sha256_file(spec.path) != spec.expected_sha256:
            raise SourceIntegrityError(
                f"precomputed mask changed during processing: {spec.path}"
            )


def _assert_all_inputs_unchanged(items: Sequence[InputCandidate]) -> None:
    """Rehash every signed input immediately before final aggregation."""

    source_hashes: dict[Path, str] = {}
    for item in sorted(items, key=lambda value: value.deterministic_key):
        source_sha = source_hashes.get(item.source_path)
        if source_sha is None:
            source_sha = _sha256_file(item.source_path)
            source_hashes[item.source_path] = source_sha
        expected_source = item.row["source_page_sha256"]
        if source_sha != expected_source:
            raise SourceIntegrityError(
                f"source page changed before final aggregation: {item.source_path}"
            )
        expected_raw = item.row["asset_file_sha256"]["image_path"]
        if _sha256_file(item.raw_path) != expected_raw:
            raise SourceIntegrityError(
                f"raw crop changed before final aggregation: {item.raw_path}"
            )
        spec = item.precomputed_mask
        if spec is not None and _sha256_file(spec.path) != spec.expected_sha256:
            raise SourceIntegrityError(
                f"precomputed mask changed before final aggregation: {spec.path}"
            )


def _connected_components(mask: np.ndarray) -> tuple[np.ndarray, list[Component]]:
    binary = np.asarray(mask, dtype=bool)
    height, width = binary.shape
    if cv2 is not None:
        count, labels, statistics, _centroids = cv2.connectedComponentsWithStats(
            binary.astype(np.uint8),
            connectivity=8,
        )
        components = []
        for label in range(1, int(count)):
            x = int(statistics[label, cv2.CC_STAT_LEFT])
            y = int(statistics[label, cv2.CC_STAT_TOP])
            component_width = int(statistics[label, cv2.CC_STAT_WIDTH])
            component_height = int(statistics[label, cv2.CC_STAT_HEIGHT])
            area = int(statistics[label, cv2.CC_STAT_AREA])
            components.append(
                Component(
                    label=label,
                    area=area,
                    bbox=(x, y, x + component_width, y + component_height),
                    touches_border=(
                        x == 0
                        or y == 0
                        or x + component_width == width
                        or y + component_height == height
                    ),
                )
            )
        return np.ascontiguousarray(labels, dtype=np.int32), components
    labels = np.zeros((height, width), dtype=np.int32)
    components: list[Component] = []
    next_label = 0
    for y, x in np.argwhere(binary):
        if labels[y, x]:
            continue
        next_label += 1
        queue: deque[tuple[int, int]] = deque([(int(y), int(x))])
        labels[y, x] = next_label
        area = 0
        min_x = max_x = int(x)
        min_y = max_y = int(y)
        touches = False
        while queue:
            cy, cx = queue.popleft()
            area += 1
            min_x = min(min_x, cx)
            max_x = max(max_x, cx)
            min_y = min(min_y, cy)
            max_y = max(max_y, cy)
            touches = touches or cx in {0, width - 1} or cy in {0, height - 1}
            for dy, dx in (
                (-1, -1),
                (-1, 0),
                (-1, 1),
                (0, -1),
                (0, 1),
                (1, -1),
                (1, 0),
                (1, 1),
            ):
                ny, nx = cy + dy, cx + dx
                if (
                    0 <= ny < height
                    and 0 <= nx < width
                    and binary[ny, nx]
                    and labels[ny, nx] == 0
                ):
                    labels[ny, nx] = next_label
                    queue.append((ny, nx))
        components.append(
            Component(
                label=next_label,
                area=area,
                bbox=(min_x, min_y, max_x + 1, max_y + 1),
                touches_border=touches,
            )
        )
    return labels, components


def _binary_dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    result = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return result.copy()
    padded = np.pad(result, radius, mode="constant", constant_values=False)
    height, width = result.shape
    output = np.zeros_like(result)
    for dy in range(radius * 2 + 1):
        for dx in range(radius * 2 + 1):
            output |= padded[dy : dy + height, dx : dx + width]
    return output


def _binary_erode(mask: np.ndarray, radius: int) -> np.ndarray:
    result = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return result.copy()
    padded = np.pad(result, radius, mode="constant", constant_values=False)
    height, width = result.shape
    output = np.ones_like(result)
    for dy in range(radius * 2 + 1):
        for dx in range(radius * 2 + 1):
            output &= padded[dy : dy + height, dx : dx + width]
    return output


def _clean_structural_lines(
    mask: np.ndarray,
) -> tuple[np.ndarray, dict[str, int]]:
    binary = np.asarray(mask, dtype=bool)
    height, width = binary.shape
    labels, components = _connected_components(binary)
    total = max(1, height * width)
    # Hard-style SFX often contains legitimate one-pixel dots, kana marks, and
    # broken brush tips.  Preserve them for human review; suppression below is
    # deliberately structural rather than a generic minimum-area deletion.
    minimum = 1
    kept = np.zeros_like(binary)
    removed_small = 0
    removed_lines = 0
    removed_dense = 0
    for component in components:
        x1, y1, x2, y2 = component.bbox
        component_width = x2 - x1
        component_height = y2 - y1
        horizontal_line = component_width >= width * 0.78 and component_height <= max(
            2, int(round(height * 0.05))
        )
        vertical_line = component_height >= height * 0.78 and component_width <= max(
            2, int(round(width * 0.05))
        )
        aspect = max(
            component_width / max(1, component_height),
            component_height / max(1, component_width),
        )
        border_rule = component.touches_border and aspect >= 18
        if component.area < minimum:
            removed_small += component.area
        elif horizontal_line or vertical_line or border_rule:
            removed_lines += component.area
        elif component.area / total > 0.78:
            removed_dense += component.area
        else:
            kept |= labels == component.label
    return kept, {
        "removed_small_pixels": removed_small,
        "removed_line_pixels": removed_lines,
        "removed_dense_pixels": removed_dense,
    }


def _mask_bbox(mask: np.ndarray) -> BBox | None:
    rows, columns = np.nonzero(mask)
    if not len(rows):
        return None
    return (
        int(columns.min()),
        int(rows.min()),
        int(columns.max()) + 1,
        int(rows.max()) + 1,
    )


def _bbox_area(bbox: BBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _bbox_intersection_area(left: BBox, right: BBox) -> int:
    return max(0, min(left[2], right[2]) - max(left[0], right[0])) * max(
        0,
        min(left[3], right[3]) - max(left[1], right[1]),
    )


def _largest_component_hole(
    component_mask: np.ndarray,
    *,
    origin_x: int,
    origin_y: int,
) -> tuple[int, BBox | None]:
    """Return the largest background hole enclosed by one foreground component."""

    padded = np.pad(
        np.asarray(component_mask, dtype=bool),
        1,
        mode="constant",
        constant_values=False,
    )
    labels, components = _connected_components(~padded)
    holes = [component for component in components if not component.touches_border]
    if not holes:
        return 0, None
    largest = max(holes, key=lambda component: (component.area, component.label))
    x1, y1, x2, y2 = largest.bbox
    return largest.area, (
        origin_x + x1 - 1,
        origin_y + y1 - 1,
        origin_x + x2 - 1,
        origin_y + y2 - 1,
    )


def _component_contamination(
    labels: np.ndarray,
    component: Component,
    *,
    roi: BBox,
) -> dict[str, Any]:
    x1, y1, x2, y2 = component.bbox
    component_width = x2 - x1
    component_height = y2 - y1
    bbox_area = max(1, component_width * component_height)
    roi_width = max(1, roi[2] - roi[0])
    roi_height = max(1, roi[3] - roi[1])
    roi_area = max(1, roi_width * roi_height)
    component_mask = labels[y1:y2, x1:x2] == component.label
    rx1 = max(x1, roi[0])
    ry1 = max(y1, roi[1])
    rx2 = min(x2, roi[2])
    ry2 = min(y2, roi[3])
    inside_roi = 0
    if rx2 > rx1 and ry2 > ry1:
        inside_roi = int((labels[ry1:ry2, rx1:rx2] == component.label).sum())
    outside_ratio = (component.area - inside_roi) / max(1, component.area)
    bbox_fill = component.area / bbox_area
    possible_enclosure = (
        component_width >= roi_width * 0.65
        and component_height >= roi_height * 0.65
        and bbox_fill <= 0.50
        and outside_ratio >= 0.15
    )
    if possible_enclosure:
        hole_area, hole_bbox = _largest_component_hole(
            component_mask,
            origin_x=x1,
            origin_y=y1,
        )
    else:
        hole_area, hole_bbox = 0, None
    hole_span_x = 0.0
    hole_span_y = 0.0
    hole_roi_coverage = 0.0
    if hole_bbox is not None:
        hole_span_x = (hole_bbox[2] - hole_bbox[0]) / roi_width
        hole_span_y = (hole_bbox[3] - hole_bbox[1]) / roi_height
        hole_roi_coverage = _bbox_intersection_area(hole_bbox, roi) / roi_area
    is_large_enclosure = (
        hole_bbox is not None
        and hole_span_x >= LARGE_ENCLOSURE_MIN_ROI_SPAN
        and hole_span_y >= LARGE_ENCLOSURE_MIN_ROI_SPAN
        and hole_roi_coverage >= LARGE_ENCLOSURE_MIN_HOLE_ROI_COVERAGE
        and bbox_fill <= LARGE_ENCLOSURE_MAX_BBOX_FILL
        and outside_ratio >= LARGE_ENCLOSURE_MIN_OUTSIDE_ROI
    )

    crop_height, crop_width = labels.shape
    spans_crop_axis = (
        component_width >= crop_width * 0.70 or component_height >= crop_height * 0.70
    )
    dwarfs_roi_axis = (
        component_width >= roi_width * 1.25 or component_height >= roi_height * 1.25
    )
    possible_thin_long = (
        (spans_crop_axis or dwarfs_roi_axis)
        and bbox_fill <= 0.30
        and outside_ratio >= 0.25
    )
    if possible_thin_long:
        eroded_pixels = int(_binary_erode(component_mask, 1).sum())
        erode_survival = eroded_pixels / max(1, component.area)
    else:
        erode_survival = 1.0
    is_thin_long = (
        (spans_crop_axis or dwarfs_roi_axis)
        and bbox_fill <= 0.22
        and erode_survival <= 0.25
        and outside_ratio >= 0.35
    )
    return {
        "label": component.label,
        "pixels": component.area,
        "bbox_px": list(component.bbox),
        "touches_crop_border": component.touches_border,
        "bbox_fill_ratio": bbox_fill,
        "inside_roi_pixels": inside_roi,
        "outside_roi_pixels": component.area - inside_roi,
        "outside_roi_ratio": outside_ratio,
        "largest_hole_pixels": hole_area,
        "largest_hole_bbox_px": list(hole_bbox) if hole_bbox is not None else [],
        "largest_hole_roi_span_x": hole_span_x,
        "largest_hole_roi_span_y": hole_span_y,
        "largest_hole_roi_coverage_ratio": hole_roi_coverage,
        "erode_1px_survival_ratio": erode_survival,
        "is_large_enclosure": is_large_enclosure,
        "is_thin_long": is_thin_long,
    }


def _mask_geometry_metrics(mask: np.ndarray, roi: BBox) -> dict[str, Any]:
    binary = np.asarray(mask, dtype=bool)
    labels, components = _connected_components(binary)
    total_pixels = int(binary.sum())
    x1, y1, x2, y2 = roi
    roi_area = max(1, (x2 - x1) * (y2 - y1))
    inside_roi = int(binary[y1:y2, x1:x2].sum())
    mask_bbox = _mask_bbox(binary)
    mask_bbox_iou = 0.0
    if mask_bbox is not None:
        intersection = _bbox_intersection_area(mask_bbox, roi)
        union = _bbox_area(mask_bbox) + roi_area - intersection
        mask_bbox_iou = intersection / max(1, union)

    details = [
        _component_contamination(labels, component, roi=roi) for component in components
    ]
    enclosure_details = [detail for detail in details if detail["is_large_enclosure"]]
    thin_long_details = [detail for detail in details if detail["is_thin_long"]]
    enclosure_pixels = sum(int(detail["pixels"]) for detail in enclosure_details)
    thin_long_pixels = sum(int(detail["pixels"]) for detail in thin_long_details)
    largest_hole_coverage = max(
        (float(detail["largest_hole_roi_coverage_ratio"]) for detail in details),
        default=0.0,
    )
    enclosure_outside = max(
        (float(detail["outside_roi_ratio"]) for detail in enclosure_details),
        default=0.0,
    )
    border_component_outside_pixels = sum(
        int(detail["outside_roi_pixels"])
        for detail in details
        if detail["touches_crop_border"]
    )
    height, width = binary.shape
    corner_band = max(1, int(round(min(height, width) * 0.03)))
    corner_contact_count = sum(
        bool(patch.any())
        for patch in (
            binary[:corner_band, :corner_band],
            binary[:corner_band, -corner_band:],
            binary[-corner_band:, :corner_band],
            binary[-corner_band:, -corner_band:],
        )
    )
    border_pixels = int(binary[0, :].sum())
    if height > 1:
        border_pixels += int(binary[-1, :].sum())
    if width > 1 and height > 2:
        border_pixels += int(binary[1:-1, 0].sum())
        border_pixels += int(binary[1:-1, -1].sum())
    border_perimeter = max(1, 2 * width + 2 * height - 4)
    return {
        "text_roi_px": list(roi),
        "text_roi_area_pixels": roi_area,
        "mask_pixels_in_text_roi": inside_roi,
        "mask_inside_text_roi_ratio": round(
            inside_roi / max(1, total_pixels),
            8,
        ),
        "text_roi_ink_coverage_ratio": round(inside_roi / roi_area, 8),
        "mask_bbox_text_roi_iou": round(mask_bbox_iou, 8),
        "large_enclosure_component_count": len(enclosure_details),
        "large_enclosure_ink_pixels": enclosure_pixels,
        "large_enclosure_ink_ratio": round(
            enclosure_pixels / max(1, total_pixels),
            8,
        ),
        "large_enclosure_outside_roi_ratio": round(enclosure_outside, 8),
        "largest_enclosed_hole_roi_coverage_ratio": round(
            largest_hole_coverage,
            8,
        ),
        "thin_long_component_count": len(thin_long_details),
        "thin_long_component_pixels": thin_long_pixels,
        "line_contamination_ratio": round(
            thin_long_pixels / max(1, total_pixels),
            8,
        ),
        "crop_border_perimeter_coverage_ratio": round(
            border_pixels / border_perimeter,
            8,
        ),
        "crop_corner_contact_count": corner_contact_count,
        "border_component_outside_roi_pixels": border_component_outside_pixels,
        "border_component_outside_mask_ratio": round(
            border_component_outside_pixels / max(1, total_pixels),
            8,
        ),
    }


def _suppress_large_enclosures(
    mask: np.ndarray,
    *,
    roi: BBox,
) -> tuple[np.ndarray, dict[str, Any]]:
    binary = np.asarray(mask, dtype=bool)
    labels, components = _connected_components(binary)
    details = [
        _component_contamination(labels, component, roi=roi) for component in components
    ]
    removed_labels = {
        int(detail["label"]) for detail in details if detail["is_large_enclosure"]
    }
    if removed_labels:
        retained = binary & ~np.isin(labels, list(removed_labels))
    else:
        retained = binary.copy()
    removed_pixels = int(binary.sum()) - int(retained.sum())
    return np.ascontiguousarray(retained), {
        "large_enclosure_removed_component_count": len(removed_labels),
        "large_enclosure_removed_pixels": removed_pixels,
        "pre_enclosure_suppression_pixels": int(binary.sum()),
        "large_enclosure_removed_ratio": round(
            removed_pixels / max(1, int(binary.sum())),
            8,
        ),
    }


def _border_values(array: np.ndarray) -> np.ndarray:
    height, width = array.shape[:2]
    band = max(1, min(height, width) // 10)
    if array.ndim == 2:
        return np.concatenate(
            (
                array[:band, :].reshape(-1),
                array[-band:, :].reshape(-1),
                array[band:-band, :band].reshape(-1),
                array[band:-band, -band:].reshape(-1),
            )
        )
    return np.concatenate(
        (
            array[:band, :, :].reshape(-1, array.shape[2]),
            array[-band:, :, :].reshape(-1, array.shape[2]),
            array[band:-band, :band, :].reshape(-1, array.shape[2]),
            array[band:-band, -band:, :].reshape(-1, array.shape[2]),
        ),
        axis=0,
    )


def _luminance(rgb: np.ndarray) -> np.ndarray:
    pixels = np.asarray(rgb, dtype=np.float32)
    return (
        pixels[..., 0] * np.float32(0.2126)
        + pixels[..., 1] * np.float32(0.7152)
        + pixels[..., 2] * np.float32(0.0722)
    )


def _otsu_threshold(values: np.ndarray) -> int:
    samples = np.clip(np.rint(values), 0, 255).astype(np.uint8)
    histogram = np.bincount(samples.reshape(-1), minlength=256).astype(np.float64)
    total = float(histogram.sum())
    if total <= 0:
        return 127
    probability = histogram / total
    omega = np.cumsum(probability)
    means = np.cumsum(probability * np.arange(256, dtype=np.float64))
    global_mean = means[-1]
    denominator = omega * (1.0 - omega)
    between = np.zeros(256, dtype=np.float64)
    valid = denominator > 1e-12
    between[valid] = (global_mean * omega[valid] - means[valid]) ** 2 / denominator[
        valid
    ]
    return int(np.argmax(between))


def _rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    srgb = np.asarray(rgb, dtype=np.float32) / np.float32(255.0)
    linear = np.where(
        srgb <= np.float32(0.04045),
        srgb / np.float32(12.92),
        ((srgb + np.float32(0.055)) / np.float32(1.055)) ** np.float32(2.4),
    )
    xyz = (
        linear
        @ np.asarray(
            (
                (0.4124564, 0.3575761, 0.1804375),
                (0.2126729, 0.7151522, 0.0721750),
                (0.0193339, 0.1191920, 0.9503041),
            ),
            dtype=np.float32,
        ).T
    )
    xyz /= np.asarray((0.95047, 1.0, 1.08883), dtype=np.float32)
    delta = np.float32(6.0 / 29.0)
    transformed = np.where(
        xyz > delta**3,
        np.cbrt(xyz),
        xyz / (np.float32(3.0) * delta**2) + np.float32(4.0 / 29.0),
    )
    lightness = np.float32(116.0) * transformed[..., 1] - np.float32(16.0)
    axis_a = np.float32(500.0) * (transformed[..., 0] - transformed[..., 1])
    axis_b = np.float32(200.0) * (transformed[..., 1] - transformed[..., 2])
    return np.stack((lightness, axis_a, axis_b), axis=-1)


def _saturation(rgb: np.ndarray) -> np.ndarray:
    normalized = np.asarray(rgb, dtype=np.float32) / np.float32(255.0)
    maximum = normalized.max(axis=-1)
    minimum = normalized.min(axis=-1)
    difference = maximum - minimum
    return np.divide(
        difference,
        maximum,
        out=np.zeros_like(difference),
        where=maximum > 1e-6,
    )


def _mask_statistics(
    mask: np.ndarray,
    rgb: np.ndarray,
    *,
    roi: BBox,
    cleanup: Mapping[str, int] | None = None,
    outside_roi_suppressed: int = 0,
    enclosure_suppression: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    binary = np.asarray(mask, dtype=bool)
    height, width = binary.shape
    total = max(1, height * width)
    pixels = int(binary.sum())
    labels, components = _connected_components(binary)
    del labels
    border = np.zeros_like(binary)
    border[0, :] = True
    border[-1, :] = True
    border[:, 0] = True
    border[:, -1] = True
    border_pixels = int((binary & border).sum())
    ratio = pixels / total
    lum = _luminance(rgb)
    background_lum = float(np.median(_border_values(lum)))
    if pixels:
        ink_lum = float(lum[binary].mean())
        contrast = float(abs(ink_lum - background_lum) / 255.0)
    else:
        ink_lum = 0.0
        contrast = 0.0
    occupancy_score = max(0.0, 1.0 - abs(ratio - 0.18) / 0.42)
    border_ratio = border_pixels / max(1, pixels)
    component_score = min(1.0, len(components) / 3.0) if components else 0.0
    density_penalty = max(0.0, (ratio - 0.66) * 2.5)
    geometry = _mask_geometry_metrics(binary, roi)
    outside_text_ratio = 1.0 - float(geometry["mask_inside_text_roi_ratio"])
    enclosure_ratio = float(geometry["large_enclosure_ink_ratio"])
    line_ratio = float(geometry["line_contamination_ratio"])
    border_perimeter_coverage = float(geometry["crop_border_perimeter_coverage_ratio"])
    border_outside_ratio = float(geometry["border_component_outside_mask_ratio"])
    removed_enclosure_ratio = float(
        (enclosure_suppression or {}).get(
            "large_enclosure_removed_ratio",
            0.0,
        )
    )
    contamination_penalty = (
        enclosure_ratio * 0.90
        + line_ratio * 0.60
        + removed_enclosure_ratio * 0.55
        + max(0.0, outside_text_ratio - 0.50) * 0.35
        + max(0.0, border_perimeter_coverage - 0.35) * border_outside_ratio * 0.50
    )
    score = (
        contrast * 0.45
        + occupancy_score * 0.30
        + component_score * 0.15
        + (1.0 - min(1.0, border_ratio)) * 0.10
        - density_penalty
        - contamination_penalty
    )
    return {
        "width": width,
        "height": height,
        "pixels": pixels,
        "ink_ratio": round(ratio, 8),
        "component_count": len(components),
        "border_contact_pixels": border_pixels,
        "border_contact_ratio": round(border_ratio, 8),
        "mean_ink_luminance": round(ink_lum, 6),
        "background_luminance": round(background_lum, 6),
        "luminance_contrast": round(contrast, 8),
        "tight_bbox_local_px": list(_mask_bbox(binary) or ()),
        "outside_roi_suppressed_pixels": int(outside_roi_suppressed),
        "cleanup": dict(cleanup or {}),
        **geometry,
        **dict(enclosure_suppression or {}),
        "quality_score": round(max(0.0, min(1.0, score)), 8),
    }


def _roi_in_raw(item: InputCandidate) -> BBox:
    return (
        item.bbox_px[0] - item.crop_bbox_px[0],
        item.bbox_px[1] - item.crop_bbox_px[1],
        item.bbox_px[2] - item.crop_bbox_px[0],
        item.bbox_px[3] - item.crop_bbox_px[1],
    )


def _select_candidate_components(
    mask: np.ndarray,
    roi: BBox,
    crop_rgb: np.ndarray,
    *,
    suppress_enclosures: bool = False,
) -> tuple[np.ndarray, dict[str, Any]]:
    cleaned, cleanup = _clean_structural_lines(mask)
    x1, y1, x2, y2 = roi
    labels, components = _connected_components(cleaned)
    selected_labels = {
        component.label
        for component in components
        if np.any((labels == component.label)[y1:y2, x1:x2])
    }
    selected = np.isin(labels, list(selected_labels))

    # Grow from components that intersect the detector/OCR bbox into the
    # miner's padded raw crop.  This retains connected outlines and nearby
    # detached SFX marks while excluding unrelated neighbouring text.
    radius = max(2, int(round(min(x2 - x1, y2 - y1) * 0.06)))
    for _ in range(2):
        support = _binary_dilate(selected, radius)
        additions = {
            component.label
            for component in components
            if component.label not in selected_labels
            and np.any((labels == component.label) & support)
        }
        if not additions:
            break
        selected_labels.update(additions)
        selected = np.isin(labels, list(selected_labels))
    suppressed = int(cleaned.sum()) - int(selected.sum())
    if suppress_enclosures:
        selected, enclosure_suppression = _suppress_large_enclosures(
            selected,
            roi=roi,
        )
    else:
        enclosure_suppression = {
            "large_enclosure_removed_component_count": 0,
            "large_enclosure_removed_pixels": 0,
            "pre_enclosure_suppression_pixels": int(selected.sum()),
            "large_enclosure_removed_ratio": 0.0,
        }
    stats = _mask_statistics(
        selected,
        crop_rgb,
        roi=roi,
        cleanup=cleanup,
        outside_roi_suppressed=max(0, suppressed),
        enclosure_suppression=enclosure_suppression,
    )
    return np.ascontiguousarray(selected), stats


def _attach_touching(
    base: np.ndarray, extra: np.ndarray, radius: int = 2
) -> np.ndarray:
    result = np.asarray(base, dtype=bool).copy()
    labels, components = _connected_components(extra)
    support = _binary_dilate(result, radius)
    for component in components:
        component_mask = labels == component.label
        if np.any(component_mask & support):
            result |= component_mask
    return result


def _classical_options(
    item: InputCandidate,
    raw: VerifiedRaw,
) -> tuple[list[MaskOption], dict[str, np.ndarray]]:
    rgb = raw.rgb
    roi = _roi_in_raw(item)
    luminance = _luminance(rgb)
    threshold = _otsu_threshold(luminance)
    background_lum = float(np.median(_border_values(luminance)))
    dark_limit = min(float(threshold), background_lum - 8.0)
    bright_limit = max(float(threshold), background_lum + 8.0)
    dark_full = luminance <= dark_limit
    bright_full = luminance >= bright_limit

    lab = _rgb_to_lab(rgb)
    background_lab = np.median(_border_values(lab), axis=0)
    delta_e = np.linalg.norm(lab - background_lab.reshape(1, 1, 3), axis=-1)
    saturation = _saturation(rgb)
    background_saturation = float(np.median(_border_values(saturation)))
    color_full = (delta_e >= 18.0) & (
        (saturation >= 0.18) | (np.abs(saturation - background_saturation) >= 0.12)
    )

    raw_masks = {
        "classical_dark": dark_full,
        "classical_bright": bright_full,
        "classical_color": color_full,
    }
    suppress_enclosures = item.row.get("primary_category") == "bubble_edge"
    target_masks: dict[str, np.ndarray] = {}
    stats_by_name: dict[str, dict[str, Any]] = {}
    for name, full_mask in raw_masks.items():
        target_masks[name], stats_by_name[name] = _select_candidate_components(
            full_mask,
            roi,
            rgb,
            suppress_enclosures=suppress_enclosures,
        )

    mixed_dark = _attach_touching(
        target_masks["classical_dark"],
        target_masks["classical_color"],
    )
    mixed_bright = _attach_touching(
        target_masks["classical_bright"],
        target_masks["classical_color"],
    )
    mixed_polarity = _attach_touching(
        target_masks["classical_dark"],
        target_masks["classical_bright"],
    )
    for name, mask, source_names in (
        (
            "classical_dark_color",
            mixed_dark,
            ("classical_dark", "classical_color"),
        ),
        (
            "classical_bright_color",
            mixed_bright,
            ("classical_bright", "classical_color"),
        ),
        (
            "classical_multipolar",
            mixed_polarity,
            ("classical_dark", "classical_bright"),
        ),
    ):
        cleaned, cleanup = _clean_structural_lines(mask)
        if suppress_enclosures:
            cleaned, enclosure_suppression = _suppress_large_enclosures(
                cleaned,
                roi=roi,
            )
        else:
            enclosure_suppression = {
                "large_enclosure_removed_component_count": 0,
                "large_enclosure_removed_pixels": 0,
                "pre_enclosure_suppression_pixels": int(cleaned.sum()),
                "large_enclosure_removed_ratio": 0.0,
            }
        target_masks[name] = cleaned
        stats = _mask_statistics(
            cleaned,
            rgb,
            roi=roi,
            cleanup=cleanup,
            enclosure_suppression=enclosure_suppression,
        )
        upstream_ratio = max(
            float(
                stats_by_name[source_name].get(
                    "large_enclosure_removed_ratio",
                    0.0,
                )
            )
            for source_name in source_names
        )
        if upstream_ratio > float(stats["large_enclosure_removed_ratio"]):
            stats["upstream_large_enclosure_removed_ratio"] = round(
                upstream_ratio,
                8,
            )
            stats["large_enclosure_removed_ratio"] = round(upstream_ratio, 8)
            stats["quality_score"] = round(
                max(
                    0.0,
                    float(stats["quality_score"]) - upstream_ratio * 0.55,
                ),
                8,
            )
        stats_by_name[name] = stats

    metadata = {
        "otsu_threshold": threshold,
        "border_background_luminance": round(background_lum, 6),
        "dark_limit": round(dark_limit, 6),
        "bright_limit": round(bright_limit, 6),
        "lab_delta_e_threshold": 18.0,
        "hsv_saturation_threshold": 0.18,
        "border_background_saturation": round(background_saturation, 6),
        "line_and_neighbour_suppression": {
            "method": "structural_component_filter_then_hard_candidate_roi_clip",
            "candidate_roi_px_in_raw": list(roi),
            "diagnostic_overlay_written": False,
        },
    }
    options = [
        MaskOption(
            name=name,
            mask=mask,
            stats=stats_by_name[name],
            metadata=metadata,
        )
        for name, mask in sorted(target_masks.items())
    ]
    auxiliary = {
        "dark": target_masks["classical_dark"],
        "bright": target_masks["classical_bright"],
        "color": target_masks["classical_color"],
    }
    return options, auxiliary


def _map_precomputed_mask(
    item: InputCandidate,
    crop_rgb: np.ndarray,
) -> MaskOption | None:
    spec = item.precomputed_mask
    if spec is None:
        return None
    actual_sha = _sha256_file(spec.path)
    if actual_sha != spec.expected_sha256:
        raise SourceIntegrityError(
            f"precomputed mask changed for {item.sample_id}: "
            f"{actual_sha} != {spec.expected_sha256}"
        )
    try:
        with Image.open(spec.path) as opened:
            mask_image = opened.convert("L")
    except (OSError, ValueError) as exc:
        raise SourceIntegrityError(
            f"cannot decode precomputed mask for {item.sample_id}"
        ) from exc
    expected_size = (
        spec.bbox_px[2] - spec.bbox_px[0],
        spec.bbox_px[3] - spec.bbox_px[1],
    )
    if mask_image.size != expected_size:
        raise SourceIntegrityError(
            f"precomputed mask geometry changed for {item.sample_id}"
        )
    source = np.asarray(mask_image, dtype=np.uint8) >= 128
    target_width = item.crop_bbox_px[2] - item.crop_bbox_px[0]
    target_height = item.crop_bbox_px[3] - item.crop_bbox_px[1]
    target = np.zeros((target_height, target_width), dtype=bool)
    ix1 = max(item.crop_bbox_px[0], spec.bbox_px[0])
    iy1 = max(item.crop_bbox_px[1], spec.bbox_px[1])
    ix2 = min(item.crop_bbox_px[2], spec.bbox_px[2])
    iy2 = min(item.crop_bbox_px[3], spec.bbox_px[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return None
    target[
        iy1 - item.crop_bbox_px[1] : iy2 - item.crop_bbox_px[1],
        ix1 - item.crop_bbox_px[0] : ix2 - item.crop_bbox_px[0],
    ] = source[
        iy1 - spec.bbox_px[1] : iy2 - spec.bbox_px[1],
        ix1 - spec.bbox_px[0] : ix2 - spec.bbox_px[0],
    ]
    cleaned, stats = _select_candidate_components(
        target,
        _roi_in_raw(item),
        crop_rgb,
    )
    return MaskOption(
        name="precomputed_verified",
        mask=cleaned,
        stats=stats,
        metadata={
            "path": spec.relative_path,
            "sha256": spec.expected_sha256,
            "bbox_px": list(spec.bbox_px),
        },
        preference_bonus=0.12,
    )


def _ctd_option(
    item: InputCandidate,
    crop_rgb: np.ndarray,
    page_mask: Any,
    masker_metadata: Mapping[str, Any],
) -> MaskOption | None:
    if page_mask is None:
        return None
    try:
        result = page_mask.extract(item.crop_bbox_px, bbox_format="xyxy")
    except Exception as exc:
        raise RecoverableMaskError(
            f"ctd_extract_failed:{type(exc).__name__}:{exc}"
        ) from exc
    probability = getattr(result, "probability_mask", None)
    threshold = getattr(result.stats, "threshold", None)
    probability_metadata: dict[str, Any] | None = None
    if (
        probability is not None
        and isinstance(threshold, (int, float))
        and np.asarray(probability).shape == np.asarray(result.binary_mask).shape
        and np.all(np.isfinite(np.asarray(probability)))
    ):
        probability_array = np.asarray(probability, dtype=np.float32)
        mask = probability_array >= float(threshold)
        probability_metadata = {
            "threshold": float(threshold),
            "shape": list(probability_array.shape),
            "sha256": _sha256_bytes(np.ascontiguousarray(probability_array).tobytes()),
            "minimum": round(float(probability_array.min()), 8),
            "maximum": round(float(probability_array.max()), 8),
            "mean": round(float(probability_array.mean()), 8),
            "mean_selected": round(
                float(probability_array[mask].mean()) if np.any(mask) else 0.0,
                8,
            ),
            "small_components_preserved_before_structural_filter": True,
        }
    else:
        if result.empty:
            return None
        mask = np.asarray(result.binary_mask, dtype=np.uint8) >= 128
    if not np.any(mask):
        return None
    cleaned, stats = _select_candidate_components(
        mask,
        _roi_in_raw(item),
        crop_rgb,
    )
    metadata = {
        "model": dict(masker_metadata),
        "ocr_bbox_px": list(result.ocr_bbox),
        "ctd_stats": asdict(result.stats),
        "raw_probability": probability_metadata,
    }
    return MaskOption(
        name="ctd",
        mask=cleaned,
        stats=stats,
        metadata=metadata,
        preference_bonus=0.08,
    )


def _broad_border_contamination(
    stats: Mapping[str, Any],
    *,
    severe: bool,
) -> bool:
    coverage = float(stats.get("crop_border_perimeter_coverage_ratio", 0.0))
    corners = int(stats.get("crop_corner_contact_count", 0))
    outside = float(stats.get("border_component_outside_mask_ratio", 0.0))
    if severe:
        return coverage >= 0.65 and corners >= 3 and outside >= 0.45
    return coverage >= 0.18 and corners >= 2 and outside >= 0.35


def _usable_option(option: MaskOption) -> bool:
    ratio = float(option.stats["ink_ratio"])
    pixels = int(option.stats["pixels"])
    enclosure_ratio = max(
        float(option.stats.get("large_enclosure_ink_ratio", 0.0)),
        float(option.stats.get("large_enclosure_removed_ratio", 0.0)),
    )
    line_ratio = float(option.stats.get("line_contamination_ratio", 0.0))
    return (
        pixels > 0
        and ratio <= 0.86
        and enclosure_ratio < SEVERE_ENCLOSURE_INK_RATIO
        and line_ratio < SEVERE_LINE_CONTAMINATION_RATIO
        and not _broad_border_contamination(option.stats, severe=True)
    )


def _sane_ctd_option(option: MaskOption) -> bool:
    if option.name != "ctd" or not _usable_option(option):
        return False
    stats = option.stats
    if not 0.001 <= float(stats["ink_ratio"]) <= 0.65:
        return False
    if int(stats["component_count"]) > 80:
        return False
    if float(stats.get("mask_inside_text_roi_ratio", 0.0)) < 0.35:
        return False
    if (
        float(stats.get("large_enclosure_ink_ratio", 0.0))
        >= MODERATE_ENCLOSURE_INK_RATIO
        or float(stats.get("large_enclosure_removed_ratio", 0.0))
        >= MODERATE_ENCLOSURE_INK_RATIO
        or float(stats.get("line_contamination_ratio", 0.0)) >= 0.50
        or _broad_border_contamination(stats, severe=False)
    ):
        return False
    probability = option.metadata.get("raw_probability")
    if isinstance(probability, Mapping):
        threshold = float(probability.get("threshold", 1.0))
        required_peak = threshold + 0.15 * max(0.0, 1.0 - threshold)
        required_mean = threshold + 0.03 * max(0.0, 1.0 - threshold)
        if float(probability.get("maximum", 0.0)) < required_peak:
            return False
        if float(probability.get("mean_selected", 0.0)) < required_mean:
            return False
    return True


def _sane_precomputed_option(option: MaskOption) -> bool:
    if option.name != "precomputed_verified" or not _usable_option(option):
        return False
    stats = option.stats
    return (
        float(stats.get("mask_inside_text_roi_ratio", 0.0)) >= 0.35
        and float(stats.get("large_enclosure_ink_ratio", 0.0))
        < MODERATE_ENCLOSURE_INK_RATIO
        and float(stats.get("line_contamination_ratio", 0.0)) < 0.50
        and not _broad_border_contamination(stats, severe=False)
    )


def _choose_mask(
    options: Sequence[MaskOption],
    *,
    prefer_ctd: bool = False,
    sound_like: bool = False,
) -> tuple[MaskOption, str]:
    usable = [option for option in options if _usable_option(option)]
    if not usable:
        raise RecoverableMaskError("empty_or_implausible_all_masks")
    verified = [option for option in usable if _sane_precomputed_option(option)]
    if verified:
        return (
            max(
                verified,
                key=lambda option: (
                    option.effective_score,
                    int(option.stats["pixels"]),
                    option.name,
                ),
            ),
            "verified_precomputed_mask_preferred",
        )
    if prefer_ctd:
        sane_ctd = [option for option in usable if _sane_ctd_option(option)]
        if sane_ctd:
            selected_ctd = max(
                sane_ctd,
                key=lambda option: (
                    option.effective_score,
                    int(option.stats["pixels"]),
                    option.name,
                ),
            )
            comparable_classical = [
                option for option in usable if option.name.startswith("classical_")
            ]
            ctd_is_tiny_fragment = False
            if sound_like and comparable_classical:
                largest_comparable_classical = max(
                    int(option.stats["pixels"]) for option in comparable_classical
                )
                ctd_is_tiny_fragment = (
                    int(selected_ctd.stats["pixels"]) * 5 < largest_comparable_classical
                )
            if not ctd_is_tiny_fragment:
                return (
                    selected_ctd,
                    "bubble_edge_sane_ctd_preferred_over_classical",
                )
    selected = max(
        usable,
        key=lambda option: (
            option.effective_score,
            int(option.stats["pixels"]),
            option.name,
        ),
    )
    return selected, "highest_effective_clean_mask_score"


def _quality_assessment(
    option: MaskOption,
    *,
    tight_bbox: BBox,
) -> tuple[str, list[str]]:
    stats = option.stats
    ratio = float(stats["ink_ratio"])
    enclosure_ratio = float(stats.get("large_enclosure_ink_ratio", 0.0))
    removed_enclosure_ratio = float(stats.get("large_enclosure_removed_ratio", 0.0))
    line_ratio = float(stats.get("line_contamination_ratio", 0.0))
    inside_roi_ratio = float(stats.get("mask_inside_text_roi_ratio", 0.0))
    reasons: list[str] = []
    reject_reasons: list[str] = []
    if max(enclosure_ratio, removed_enclosure_ratio) >= (SEVERE_ENCLOSURE_INK_RATIO):
        reject_reasons.append("enclosure_dominant_mask_rejected")
    if line_ratio >= SEVERE_LINE_CONTAMINATION_RATIO:
        reject_reasons.append("line_dominant_mask_rejected")
    if _broad_border_contamination(stats, severe=True):
        reject_reasons.append("broad_crop_border_contamination_rejected")
    if reject_reasons:
        return "reject", reject_reasons
    if max(enclosure_ratio, removed_enclosure_ratio) >= (MODERATE_ENCLOSURE_INK_RATIO):
        reasons.append("large_enclosure_contamination_review")
    elif removed_enclosure_ratio > 0.0:
        reasons.append("large_enclosure_removed_review")
    if line_ratio >= MODERATE_LINE_CONTAMINATION_RATIO:
        reasons.append("line_contamination_review")
    if _broad_border_contamination(stats, severe=False):
        reasons.append("broad_crop_border_contamination_review")
    if inside_roi_ratio < 0.50:
        reasons.append("low_text_roi_ink_fraction_review")
    if float(stats.get("mask_bbox_text_roi_iou", 0.0)) < 0.08:
        reasons.append("low_mask_bbox_text_roi_iou_review")
    if ratio < 0.005:
        reasons.append("very_sparse_mask")
    if ratio > 0.62:
        reasons.append("dense_mask_review")
    if float(stats["border_contact_ratio"]) > 0.28:
        reasons.append("high_border_contact_review")
    if float(stats["luminance_contrast"]) < 0.045:
        reasons.append("low_luminance_contrast_review")
    if int(stats["component_count"]) > 80:
        reasons.append("many_components_review")
    if tight_bbox[2] - tight_bbox[0] < 2 or tight_bbox[3] - tight_bbox[1] < 2:
        reasons.append("tiny_tight_crop_review")
    return ("review" if reasons else "pass"), reasons


def _expand_bbox(
    bbox: BBox,
    *,
    page_width: int,
    page_height: int,
    ratio: float,
    minimum: int,
    maximum: int,
) -> tuple[BBox, int]:
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    padding = min(maximum, max(minimum, int(round(max(width, height) * ratio))))
    return (
        max(0, bbox[0] - padding),
        max(0, bbox[1] - padding),
        min(page_width, bbox[2] + padding),
        min(page_height, bbox[3] + padding),
    ), padding


def _estimate_deskew_angle(
    mask: np.ndarray,
    orientation: str,
    *,
    minimum_angle: float,
    maximum_angle: float,
) -> tuple[float | None, dict[str, Any]]:
    rows, columns = np.nonzero(mask)
    if len(rows) < 12:
        return None, {"reason": "insufficient_mask_pixels", "pixels": len(rows)}
    coordinates = np.column_stack((columns, rows)).astype(np.float64)
    covariance = np.cov(coordinates, rowvar=False)
    values, vectors = np.linalg.eigh(covariance)
    major_index = int(np.argmax(values))
    minor_index = 1 - major_index
    major = float(values[major_index])
    minor = float(max(values[minor_index], 1e-9))
    anisotropy = major / minor
    vector = vectors[:, major_index]
    angle = math.degrees(math.atan2(float(vector[1]), float(vector[0])))
    while angle >= 90.0:
        angle -= 180.0
    while angle < -90.0:
        angle += 180.0
    if orientation == "vertical":
        delta = angle - (90.0 if angle >= 0 else -90.0)
    else:
        delta = angle
    while delta > 45.0:
        delta -= 90.0
    while delta < -45.0:
        delta += 90.0
    metadata = {
        "major_axis_angle_degrees": round(angle, 6),
        "deskew_delta_degrees": round(delta, 6),
        "anisotropy": round(anisotropy, 6),
        "orientation_reference": orientation,
    }
    if anisotropy < 1.25:
        metadata["reason"] = "low_axis_anisotropy"
        return None, metadata
    if abs(delta) < minimum_angle:
        metadata["reason"] = "below_minimum_angle"
        return None, metadata
    if abs(delta) > maximum_angle:
        metadata["reason"] = "above_maximum_angle"
        return None, metadata
    metadata["reason"] = "applied"
    return delta, metadata


def _normalized_rgba(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    alpha = np.asarray(mask, dtype=np.uint8) * np.uint8(255)
    rgba = np.concatenate(
        (np.asarray(rgb, dtype=np.uint8), alpha[..., None]),
        axis=2,
    )
    rgba[rgba[..., 3] == 0, :3] = 0
    return np.ascontiguousarray(rgba)


def _asset_id(processed_id: str, kind: str) -> str:
    identity = {
        "processed_id": processed_id,
        "kind": kind,
        "algorithm_version": ALGORITHM_VERSION,
    }
    return "fhpa_" + _sha256_json(identity)[:24]


def _source_page_asset_id(item: InputCandidate, page: VerifiedPage) -> str:
    identity = {
        "kind": "source_page",
        "source_image_path": item.source_relative,
        "source_page_sha256": page.file_sha256,
        "provenance": "real_preserved",
    }
    return "fhps_" + _sha256_json(identity)[:24]


def _processed_id(
    item: InputCandidate,
    processor_source_sha256: str,
    derivation_signature_sha256: str,
) -> str:
    identity = {
        "parent_id": item.sample_id,
        "parent_record_sha256": item.row_sha256,
        "source_page_sha256": item.row["source_page_sha256"],
        "crop_sha256": item.row["crop_sha256"],
        "algorithm_version": ALGORITHM_VERSION,
        "processor_source_sha256": processor_source_sha256,
        "derivation_signature_sha256": derivation_signature_sha256,
        "provenance": "real_processed",
    }
    return "fhp_" + _sha256_json(identity)[:24]


def _asset_relative(kind: str, split: str, processed_id: str) -> str:
    return f"{ASSET_DIRECTORIES[kind]}/{split}/{processed_id}.png"


def _asset_descriptor(
    *,
    layout: OutputLayout,
    processed_id: str,
    split: str,
    kind: str,
    image: Image.Image,
    transform: Mapping[str, Any],
    dry_run: bool,
    provenance: str = "real_processed",
) -> dict[str, Any]:
    relative = _asset_relative(kind, split, processed_id)
    encoded = _encode_png(image)
    if not dry_run:
        _atomic_write_bytes(layout.root / relative, encoded)
    return {
        "id": _asset_id(processed_id, kind),
        "kind": kind,
        "path": relative,
        "file_sha256": _sha256_bytes(encoded),
        "file_size_bytes": len(encoded),
        "pixel_sha256": _pixel_sha256(image),
        "mode": image.mode,
        "size_px": [image.width, image.height],
        "provenance": provenance,
        "parent_sample_id": processed_id,
        "transform": dict(transform),
    }


def _raw_asset_descriptor(
    *,
    layout: OutputLayout,
    item: InputCandidate,
    verified: VerifiedRaw,
    processed_id: str,
    dry_run: bool,
) -> dict[str, Any]:
    relative = _asset_relative("raw", item.split, processed_id)
    if not dry_run:
        _atomic_write_bytes(layout.root / relative, verified.file_bytes)
    return {
        "id": _asset_id(processed_id, "raw"),
        "kind": "raw",
        "path": relative,
        "file_sha256": verified.file_sha256,
        "file_size_bytes": len(verified.file_bytes),
        "pixel_sha256": verified.pixel_sha256,
        "mode": "RGB",
        "size_px": [verified.rgb.shape[1], verified.rgb.shape[0]],
        "provenance": "real_preserved",
        "parent_sample_id": item.sample_id,
        "transform": {
            "operation": "byte_exact_verified_copy",
            "diagnostic_overlay_written": False,
        },
    }


def _rotate_rgba(rgba: np.ndarray, delta: float) -> Image.Image:
    image = Image.fromarray(rgba)
    rotated = image.rotate(
        -delta,
        resample=Image.Resampling.BICUBIC,
        expand=True,
        fillcolor=(0, 0, 0, 0),
    )
    pixels = np.asarray(rotated, dtype=np.uint8).copy()
    pixels[pixels[..., 3] == 0, :3] = 0
    return Image.fromarray(pixels)


def _letterbox_rgb(image: Image.Image, size: int = 224) -> Image.Image:
    source = image.convert("RGB")
    scale = min(size / source.width, size / source.height)
    resized_size = (
        max(1, round(source.width * scale)),
        max(1, round(source.height * scale)),
    )
    resized = source.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), "white")
    canvas.paste(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    return canvas


def _build_processed_record(
    item: InputCandidate,
    *,
    page: VerifiedPage,
    raw: VerifiedRaw,
    layout: OutputLayout,
    page_mask: Any,
    masker_metadata: Mapping[str, Any],
    ctd_page_error: str | None,
    processor_source_sha256: str,
    run_signature_sha256: str,
    derivation_signature_sha256: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    crop_x1, crop_y1, _, _ = item.crop_bbox_px
    target_rgb = raw.rgb
    classical, auxiliary = _classical_options(item, raw)
    options = list(classical)
    notices: list[str] = []
    if item.precomputed_notice:
        notices.append(item.precomputed_notice)
    precomputed = _map_precomputed_mask(item, target_rgb)
    if precomputed is not None:
        options.append(precomputed)
    if ctd_page_error:
        notices.append(ctd_page_error)
    try:
        ctd = _ctd_option(item, target_rgb, page_mask, masker_metadata)
    except RecoverableMaskError as exc:
        notices.append(str(exc))
        ctd = None
    if ctd is not None:
        options.append(ctd)
    categories = {
        str(value) for value in item.row.get("categories", ()) if isinstance(value, str)
    }
    near_balloon = bool(categories.intersection({"bubble_edge", "free_near_bubble"}))
    sound_like = bool(categories.intersection({"page_sound", "ocr_sound_prior"}))
    bubble_only = item.row.get(
        "primary_category"
    ) == "bubble_edge" and not categories.intersection(
        {"page_sound", "ocr_sound_prior"}
    )
    selected, selection_reason = _choose_mask(
        options,
        prefer_ctd=near_balloon,
        sound_like=sound_like,
    )
    if bubble_only and not (
        (selected.name == "precomputed_verified" and _sane_precomputed_option(selected))
        or (selected.name == "ctd" and _sane_ctd_option(selected))
    ):
        raise RecoverableMaskError("bubble_edge_requires_sane_ctd_or_verified_mask")
    tight_local = _mask_bbox(selected.mask)
    if tight_local is None:
        raise RecoverableMaskError("selected_mask_is_empty")
    quality_status, quality_reasons = _quality_assessment(
        selected,
        tight_bbox=tight_local,
    )
    if quality_status == "reject":
        raise RecoverableMaskError("hard_mask_gate_reject:" + ",".join(quality_reasons))
    tx1, ty1, tx2, ty2 = tight_local
    tight_page = (
        crop_x1 + tx1,
        crop_y1 + ty1,
        crop_x1 + tx2,
        crop_y1 + ty2,
    )
    tight_rgb = np.ascontiguousarray(target_rgb[ty1:ty2, tx1:tx2])
    tight_mask = np.ascontiguousarray(selected.mask[ty1:ty2, tx1:tx2])
    tight_color = np.ascontiguousarray(auxiliary["color"][ty1:ty2, tx1:tx2])
    rgba = _normalized_rgba(tight_rgb, tight_mask)
    glyph_rgba_image = Image.fromarray(rgba)
    white_rgba = Image.new("RGBA", glyph_rgba_image.size, (255, 255, 255, 255))
    glyph_white_composite = Image.alpha_composite(
        white_rgba,
        glyph_rgba_image,
    ).convert("RGB")

    black_on_white = np.full((*tight_mask.shape, 3), 255, dtype=np.uint8)
    black_on_white[tight_mask] = 0
    white_on_black = np.zeros((*tight_mask.shape, 3), dtype=np.uint8)
    white_on_black[tight_mask] = 255
    fill = _binary_erode(tight_mask, 1)
    stroke = tight_mask & ~fill
    padded_outline = np.pad(tight_mask, 2, mode="constant", constant_values=False)
    outer_ring = _binary_dilate(padded_outline, 2) & ~_binary_dilate(
        padded_outline,
        1,
    )

    context_bbox, context_padding = _expand_bbox(
        tight_page,
        page_width=page.width,
        page_height=page.height,
        ratio=float(args.context_padding_ratio),
        minimum=int(args.context_padding_min),
        maximum=int(args.context_padding_max),
    )
    cx1, cy1, cx2, cy2 = context_bbox
    context_rgb = np.ascontiguousarray(page.rgb[cy1:cy2, cx1:cx2])
    if context_rgb.size == 0:
        raise RecoverableMaskError("empty_context")

    processed_id = _processed_id(
        item,
        processor_source_sha256,
        derivation_signature_sha256,
    )
    assets: dict[str, dict[str, Any]] = {}
    assets["raw"] = _raw_asset_descriptor(
        layout=layout,
        item=item,
        verified=raw,
        processed_id=processed_id,
        dry_run=bool(args.dry_run),
    )
    image_assets: dict[str, tuple[Image.Image, dict[str, Any]]] = {
        "context": (
            Image.fromarray(context_rgb),
            {
                "operation": "source_context_crop",
                "bbox_px": list(context_bbox),
                "padding_px": context_padding,
            },
        ),
        "glyph_rgba": (
            glyph_rgba_image,
            {
                "operation": "source_rgb_with_selected_mask_alpha",
                "tight_bbox_px": list(tight_page),
                "mask_method": selected.name,
            },
        ),
        "mask": (
            Image.fromarray(tight_mask.astype(np.uint8) * 255),
            {
                "operation": "tight_selected_binary_mask",
                "mask_method": selected.name,
            },
        ),
        "black_on_white": (
            Image.fromarray(black_on_white),
            {"operation": "binary_polarity_normalization", "polarity": "dark"},
        ),
        "white_on_black": (
            Image.fromarray(white_on_black),
            {"operation": "binary_polarity_normalization", "polarity": "light"},
        ),
        "color_mask": (
            Image.fromarray(tight_color.astype(np.uint8) * 255),
            {
                "operation": "lab_hsv_colour_outlier_mask",
                "lab_delta_e_threshold": 18.0,
                "hsv_saturation_threshold": 0.18,
            },
        ),
        "outline_fill": (
            Image.fromarray(fill.astype(np.uint8) * 255),
            {"operation": "binary_erosion_fill", "radius_px": 1},
        ),
        "outline_stroke": (
            Image.fromarray(stroke.astype(np.uint8) * 255),
            {"operation": "mask_minus_eroded_fill", "radius_px": 1},
        ),
        "outline_outer_ring": (
            Image.fromarray(outer_ring.astype(np.uint8) * 255),
            {
                "operation": "dilation_annulus",
                "inner_radius_px": 1,
                "outer_radius_px": 2,
                "padding_px": 2,
            },
        ),
        "glyph_224": (
            _letterbox_rgb(glyph_white_composite),
            {
                "operation": "aspect_preserving_letterbox",
                "size_px": 224,
                "source": "white_composited_glyph_rgba",
                "background": "white",
            },
        ),
        "context_224": (
            _letterbox_rgb(Image.fromarray(context_rgb)),
            {
                "operation": "aspect_preserving_letterbox",
                "size_px": 224,
                "source": "context",
                "background": "white",
            },
        ),
    }
    for kind, (image, transform) in image_assets.items():
        assets[kind] = _asset_descriptor(
            layout=layout,
            processed_id=processed_id,
            split=item.split,
            kind=kind,
            image=image,
            transform=transform,
            dry_run=bool(args.dry_run),
        )

    orientation = str(item.row.get("orientation") or "horizontal").lower()
    if orientation not in {"horizontal", "vertical"}:
        orientation = "horizontal"
    deskew_delta, deskew_metadata = _estimate_deskew_angle(
        tight_mask,
        orientation,
        minimum_angle=float(args.deskew_min_angle),
        maximum_angle=float(args.deskew_max_angle),
    )
    if deskew_delta is not None:
        assets["deskew_rgba"] = _asset_descriptor(
            layout=layout,
            processed_id=processed_id,
            split=item.split,
            kind="deskew_rgba",
            image=_rotate_rgba(rgba, deskew_delta),
            transform={
                "operation": "auxiliary_deskew",
                "rotation_degrees": round(-deskew_delta, 6),
                "source_geometry_replaced": False,
                **deskew_metadata,
            },
            dry_run=bool(args.dry_run),
        )
    root_real_id = item.row.get("root_real_id") or item.sample_id
    source_page_asset = {
        "id": _source_page_asset_id(item, page),
        "kind": "source_page",
        "path": item.source_relative,
        "file_sha256": page.file_sha256,
        "mode": "RGB",
        "size_px": [page.width, page.height],
        "provenance": "real_preserved",
        "storage_root": "library_root",
    }
    assets["raw"]["root_real_id"] = root_real_id
    parent_ids_by_kind = {
        "context": [source_page_asset["id"]],
        "mask": [assets["raw"]["id"]],
        "color_mask": [assets["raw"]["id"]],
        "glyph_rgba": [assets["raw"]["id"], assets["mask"]["id"]],
        "black_on_white": [assets["mask"]["id"]],
        "white_on_black": [assets["mask"]["id"]],
        "outline_fill": [assets["mask"]["id"]],
        "outline_stroke": [assets["mask"]["id"]],
        "outline_outer_ring": [assets["mask"]["id"]],
        "glyph_224": [assets["glyph_rgba"]["id"]],
        "context_224": [assets["context"]["id"]],
        "deskew_rgba": [assets["glyph_rgba"]["id"]],
    }
    for kind, descriptor in assets.items():
        descriptor["root_real_id"] = root_real_id
        parent_ids = parent_ids_by_kind.get(kind, [])
        descriptor["parent_asset_ids"] = parent_ids
        descriptor["parent_asset_id"] = parent_ids[0] if parent_ids else None

    color_overlap = int((tight_color & tight_mask).sum()) / max(
        1,
        int(tight_mask.sum()),
    )
    fill_pixels = int(fill.sum())
    stroke_pixels = int(stroke.sum())
    outer_pixels = int(outer_ring.sum())
    style_metrics = {
        "inverse_likelihood": round(
            max(
                0.0,
                (
                    float(selected.stats["mean_ink_luminance"])
                    - float(selected.stats["background_luminance"])
                )
                / 255.0,
            ),
            8,
        ),
        "color_mask_overlap_ratio": round(color_overlap, 8),
        "outline_fill_pixels": fill_pixels,
        "outline_stroke_pixels": stroke_pixels,
        "outline_outer_ring_pixels": outer_pixels,
        "outline_structure_ratio": round(
            stroke_pixels / max(1, fill_pixels + stroke_pixels),
            8,
        ),
    }

    carried_fields = {
        key: item.row.get(key)
        for key in (
            "work_title",
            "chapter_title",
            "page_name",
            "declared_page_size_px",
            "source_dimension_mismatch",
            "ocr_coordinate_provenance",
            "ocr_metadata_skip_reasons",
            "work_balance_weight",
            "chapter_balance_weight",
            "selection_segment_index",
            "ocr_hints_sha256",
        )
        if key in item.row
    }
    candidate_metadata = {
        key: item.row.get(key)
        for key in (
            "tier",
            "primary_category",
            "categories",
            "candidate_score",
            "candidate_evidence",
            "candidate_source_ids",
            "ocr_text",
            "detector_model",
        )
        if key in item.row
    }
    option_stats = {
        option.name: {
            **option.stats,
            "effective_score": round(option.effective_score, 8),
            "selected": option.name == selected.name,
            "metadata": option.metadata,
        }
        for option in sorted(options, key=lambda value: value.name)
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "hard_postprocess_schema_version": SCHEMA_VERSION,
        "id": processed_id,
        "provenance": "real_processed",
        "parent_id": item.sample_id,
        "root_real_id": root_real_id,
        "variant_group_id": root_real_id,
        "parent_record_sha256": item.row_sha256,
        "input_line_number": item.line_number,
        "lineage": [
            {
                "id": item.sample_id,
                "provenance": "real_mined",
                "source_page_sha256": page.file_sha256,
                "crop_sha256": raw.pixel_sha256,
            },
            {
                "id": processed_id,
                "provenance": "real_processed",
                "tool": TOOL_ID,
                "algorithm_version": ALGORITHM_VERSION,
                "processor_source_sha256": processor_source_sha256,
                "run_signature_sha256": run_signature_sha256,
                "derivation_signature_sha256": derivation_signature_sha256,
            },
        ],
        "work_id": item.work_id,
        "chapter_id": item.chapter_id,
        "page_id": item.page_id,
        "split": item.split,
        # Base QA compatibility: tier B means reviewable but not accepted as
        # the ordinary strict tier-A dataset. The original hard-candidate tier
        # remains in candidate_metadata.
        "tier": "B",
        **carried_fields,
        "source_image_path": item.source_relative,
        "source_page_asset": source_page_asset,
        "source_page_sha256": page.file_sha256,
        "source_page_content_signature": {
            "sha256": page.file_sha256,
            "size": page.size_bytes,
        },
        "page_size_px": [page.width, page.height],
        "bbox_px": list(item.bbox_px),
        "crop_bbox_px": list(item.crop_bbox_px),
        "raw_bbox_px": list(item.bbox_px),
        "source_crop_bbox_px": list(item.crop_bbox_px),
        "crop_size_px": [raw.rgb.shape[1], raw.rgb.shape[0]],
        "crop_sha256": raw.pixel_sha256,
        "mask_input_bbox_px": list(item.crop_bbox_px),
        "tight_bbox_px": list(tight_page),
        "context_bbox_px": list(context_bbox),
        "orientation": orientation,
        "candidate_metadata": candidate_metadata,
        "assets": assets,
        "image_path": assets["raw"]["path"],
        "clip_image_path": assets["glyph_224"]["path"],
        "asset_file_sha256": {
            "image_path": assets["raw"]["file_sha256"],
            "clip_image_path": assets["glyph_224"]["file_sha256"],
        },
        "raw_image_path": assets["raw"]["path"],
        "context_image_path": assets["context"]["path"],
        "glyph_rgba_path": assets["glyph_rgba"]["path"],
        "glyph_mask_path": assets["mask"]["path"],
        "glyph_224_path": assets["glyph_224"]["path"],
        "context_224_path": assets["context_224"]["path"],
        "masked_context_path": assets["context"]["path"],
        "mask_paths": {
            key: assets[key]["path"]
            for key in (
                "context",
                "glyph_rgba",
                "mask",
                "glyph_224",
                "context_224",
            )
        },
        "final_image_paths": {
            key: assets[key]["path"]
            for key in (
                "context",
                "glyph_rgba",
                "mask",
                "glyph_224",
                "context_224",
            )
        },
        "mask_asset_sha256": {
            key: assets[key]["file_sha256"]
            for key in (
                "context",
                "glyph_rgba",
                "mask",
                "glyph_224",
                "context_224",
            )
        },
        "mask_tight_bbox_px": list(tight_page),
        "masked_context_bbox_px": list(context_bbox),
        "final_bbox_px": list(context_bbox),
        "glyph_size_px": [tight_mask.shape[1], tight_mask.shape[0]],
        "glyph_white_composite_sha256": _pixel_sha256(glyph_white_composite),
        "masked_letterbox_size_px": 224,
        "mask_schema_version": 3,
        "mask_stats": selected.stats,
        "mask_model": (
            selected.metadata.get("model")
            if isinstance(selected.metadata.get("model"), Mapping)
            else {
                "name": selected.name,
                "algorithm_version": ALGORITHM_VERSION,
                "classical_cv_backend": (
                    "opencv" if cv2 is not None else "numpy_python_fallback"
                ),
            }
        ),
        "hard_mask_reviewable": True,
        "needs_mask_enrichment": False,
        "mask_enrichment_status": "complete",
        "processing": {
            "tool": TOOL_ID,
            "algorithm_version": ALGORITHM_VERSION,
            "processor_source_sha256": processor_source_sha256,
            "run_signature_sha256": run_signature_sha256,
            "derivation_signature_sha256": derivation_signature_sha256,
            "mask_method": selected.name,
            "mask_selection_reason": selection_reason,
            "mask_options": option_stats,
            "notices": sorted(set(notices)),
            "panel_balloon_neighbour_suppression": (
                "structural lines removed; padded-crop components are retained "
                "only when they intersect or attach to the signed candidate bbox"
            ),
            "diagnostic_overlay_written": False,
            "source_geometry_replaced": False,
            "deskew": deskew_metadata,
        },
        "style_metrics": style_metrics,
        "quality": {
            "status": quality_status,
            "failure_reasons": quality_reasons,
            "selected_mask_stats": selected.stats,
        },
        "hard_mask_quality_gate": {
            "contract": "hard_style_reviewable_v2",
            "passed_for_human_review": True,
            "blocking_failure_count": 0,
            "bubble_only_requires": ("sane_ctd_or_signed_clean_precomputed_mask"),
            "thresholds": {
                "moderate_enclosure_ink_ratio": (MODERATE_ENCLOSURE_INK_RATIO),
                "severe_enclosure_ink_ratio": (SEVERE_ENCLOSURE_INK_RATIO),
                "moderate_line_contamination_ratio": (
                    MODERATE_LINE_CONTAMINATION_RATIO
                ),
                "severe_line_contamination_ratio": (SEVERE_LINE_CONTAMINATION_RATIO),
            },
            "does_not_require_tier_a": True,
            "does_not_require_ocr_score": True,
            "allows_single_character": True,
            "allows_high_border_contact_with_review_flag": True,
        },
        "hard_qa_contract": {
            "max_chapters_per_work": 20,
            "work_split_must_be_unique": True,
            "all_variants_keep_parent_split": True,
        },
        "review": {
            "status": "pending",
            "allowed_decisions": ["pass", "reject", "recrop"],
            "notes": None,
        },
        "mask_review": {
            "status": "pending",
            "allowed_decisions": ["pass", "reject", "recrop"],
            "recrop_bbox_px": None,
            "notes": None,
        },
        "synthetic": False,
        "synthetic_provenance": None,
        "label": None,
    }


def _reject_record(
    item: InputCandidate,
    *,
    reasons: Sequence[str],
    stage: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "id": item.sample_id,
        "parent_id": item.sample_id,
        "provenance": "real_mined",
        "work_id": item.work_id,
        "chapter_id": item.chapter_id,
        "page_id": item.page_id,
        "split": item.split,
        "source_image_path": item.source_relative,
        "bbox_px": list(item.bbox_px),
        "crop_bbox_px": list(item.crop_bbox_px),
        "stage": stage,
        "failure_reasons": sorted(set(reasons)),
        "input_line_number": item.line_number,
        "parent_record_sha256": item.row_sha256,
        "synthetic": False,
    }


def _page_state_path(layout: OutputLayout, page_key: str) -> Path:
    return layout.state_dir / f"{_sha256_bytes(page_key.encode('utf-8'))}.json"


def _input_bindings(
    items: Sequence[InputCandidate],
    *,
    processor_source_sha256: str | None = None,
    derivation_signature_sha256: str | None = None,
) -> list[dict[str, Any]]:
    bindings: list[dict[str, Any]] = []
    for item in items:
        binding = {
            "line_number": item.line_number,
            "id": item.sample_id,
            "row_sha256": item.row_sha256,
            "source_page_sha256": item.row["source_page_sha256"],
            "crop_sha256": item.row["crop_sha256"],
            "raw_file_sha256": item.row["asset_file_sha256"]["image_path"],
            "work_id": item.work_id,
            "chapter_id": item.chapter_id,
            "page_id": item.page_id,
            "split": item.split,
            "source_image_path": item.source_relative,
            "bbox_px": list(item.bbox_px),
            "crop_bbox_px": list(item.crop_bbox_px),
            "expected_root_real_id": (item.row.get("root_real_id") or item.sample_id),
            "precomputed_mask_sha256": (
                item.precomputed_mask.expected_sha256
                if item.precomputed_mask is not None
                else None
            ),
        }
        if (
            processor_source_sha256 is not None
            and derivation_signature_sha256 is not None
        ):
            binding["expected_processed_id"] = _processed_id(
                item,
                processor_source_sha256,
                derivation_signature_sha256,
            )
        bindings.append(binding)
    return bindings


def _validate_checkpoint_coverage(
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    bindings: Sequence[Mapping[str, Any]],
    *,
    label: str,
) -> None:
    expected_ids = [binding.get("id") for binding in bindings]
    if any(not isinstance(value, str) for value in expected_ids) or len(
        expected_ids
    ) != len(set(expected_ids)):
        raise ResumeValidationError(f"checkpoint has invalid input bindings: {label}")
    observed: Counter[str] = Counter()
    binding_by_id = {
        str(binding["id"]): binding
        for binding in bindings
        if isinstance(binding.get("id"), str)
    }
    for record in records:
        parent_id = record.get("parent_id")
        if not isinstance(parent_id, str):
            raise ResumeValidationError(f"checkpoint record lacks a parent id: {label}")
        observed[parent_id] += 1
        binding = binding_by_id.get(parent_id)
        if (
            binding is None
            or record.get("parent_record_sha256") != binding.get("row_sha256")
            or record.get("source_page_sha256") != binding.get("source_page_sha256")
            or record.get("crop_sha256") != binding.get("crop_sha256")
            or record.get("id") != binding.get("expected_processed_id")
            or record.get("root_real_id") != binding.get("expected_root_real_id")
            or record.get("variant_group_id") != binding.get("expected_root_real_id")
            or record.get("input_line_number") != binding.get("line_number")
            or any(
                record.get(field) != binding.get(field)
                for field in (
                    "work_id",
                    "chapter_id",
                    "page_id",
                    "split",
                    "source_image_path",
                    "bbox_px",
                    "crop_bbox_px",
                )
            )
        ):
            raise ResumeValidationError(
                f"checkpoint record does not match its input binding: {label}"
            )
    for reject in rejects:
        parent_id = reject.get("parent_id") or reject.get("id")
        if not isinstance(parent_id, str):
            raise ResumeValidationError(f"checkpoint reject lacks a parent id: {label}")
        observed[parent_id] += 1
        binding = binding_by_id.get(parent_id)
        if (
            binding is None
            or reject.get("parent_record_sha256") != binding.get("row_sha256")
            or any(
                reject.get(field) != binding.get(field)
                for field in (
                    "work_id",
                    "chapter_id",
                    "page_id",
                    "split",
                    "source_image_path",
                    "bbox_px",
                    "crop_bbox_px",
                )
            )
        ):
            raise ResumeValidationError(
                f"checkpoint reject does not match its input binding: {label}"
            )
    expected = Counter(str(value) for value in expected_ids)
    if observed != expected:
        raise ResumeValidationError(
            "checkpoint records and rejects do not cover every input exactly "
            f"once: {label}"
        )


def _record_asset_descriptors(
    record: Mapping[str, Any],
) -> Iterable[Mapping[str, Any]]:
    assets = record.get("assets")
    if isinstance(assets, Mapping):
        for descriptor in assets.values():
            if isinstance(descriptor, Mapping):
                yield descriptor


def _validate_asset_parent_dag(record: Mapping[str, Any]) -> None:
    assets = record.get("assets")
    source_page = record.get("source_page_asset")
    if not isinstance(assets, Mapping) or not isinstance(source_page, Mapping):
        raise ResumeValidationError("checkpoint record lacks its asset DAG")
    asset_ids = {
        kind: descriptor.get("id")
        for kind, descriptor in assets.items()
        if isinstance(kind, str) and isinstance(descriptor, Mapping)
    }
    if (
        len(asset_ids) != len(assets)
        or any(not isinstance(value, str) for value in asset_ids.values())
        or len(set(asset_ids.values())) != len(asset_ids)
        or not isinstance(source_page.get("id"), str)
    ):
        raise ResumeValidationError("checkpoint record has invalid asset IDs")
    source_identity = {
        "kind": "source_page",
        "source_image_path": record.get("source_image_path"),
        "source_page_sha256": record.get("source_page_sha256"),
        "provenance": "real_preserved",
    }
    expected_source_id = "fhps_" + _sha256_json(source_identity)[:24]
    if (
        source_page.get("id") != expected_source_id
        or source_page.get("path") != record.get("source_image_path")
        or source_page.get("file_sha256") != record.get("source_page_sha256")
        or source_page.get("provenance") != "real_preserved"
        or source_page.get("storage_root") != "library_root"
    ):
        raise ResumeValidationError(
            "checkpoint record has an invalid source-page asset"
        )
    required_kinds = {
        "raw",
        "context",
        "mask",
        "color_mask",
        "glyph_rgba",
        "black_on_white",
        "white_on_black",
        "outline_fill",
        "outline_stroke",
        "outline_outer_ring",
        "glyph_224",
        "context_224",
    }
    if not required_kinds.issubset(asset_ids):
        raise ResumeValidationError("checkpoint record asset DAG is incomplete")
    processed_id = record.get("id")
    split = record.get("split")
    root_real_id = record.get("root_real_id")
    parent_id = record.get("parent_id")
    if not all(
        isinstance(value, str)
        for value in (processed_id, split, root_real_id, parent_id)
    ):
        raise ResumeValidationError(
            "checkpoint record lacks deterministic asset identity fields"
        )
    for kind, descriptor_value in assets.items():
        descriptor = descriptor_value
        expected_provenance = "real_preserved" if kind == "raw" else "real_processed"
        expected_parent_sample = parent_id if kind == "raw" else processed_id
        if (
            descriptor.get("kind") != kind
            or descriptor.get("id") != _asset_id(processed_id, kind)
            or descriptor.get("path") != _asset_relative(kind, split, processed_id)
            or descriptor.get("provenance") != expected_provenance
            or descriptor.get("parent_sample_id") != expected_parent_sample
            or descriptor.get("root_real_id") != root_real_id
        ):
            raise ResumeValidationError(
                f"checkpoint record has invalid {kind} asset semantics"
            )
    expected: dict[str, list[str]] = {
        "raw": [],
        "context": [str(source_page["id"])],
        "mask": [str(asset_ids["raw"])],
        "color_mask": [str(asset_ids["raw"])],
        "glyph_rgba": [
            str(asset_ids["raw"]),
            str(asset_ids["mask"]),
        ],
        "black_on_white": [str(asset_ids["mask"])],
        "white_on_black": [str(asset_ids["mask"])],
        "outline_fill": [str(asset_ids["mask"])],
        "outline_stroke": [str(asset_ids["mask"])],
        "outline_outer_ring": [str(asset_ids["mask"])],
        "glyph_224": [str(asset_ids["glyph_rgba"])],
        "context_224": [str(asset_ids["context"])],
    }
    if "deskew_rgba" in asset_ids:
        expected["deskew_rgba"] = [str(asset_ids["glyph_rgba"])]
    if set(asset_ids) != set(expected):
        raise ResumeValidationError("checkpoint record asset DAG is incomplete")
    for kind, parent_ids in expected.items():
        descriptor = assets[kind]
        if descriptor.get("parent_asset_ids") != parent_ids or descriptor.get(
            "parent_asset_id"
        ) != (parent_ids[0] if parent_ids else None):
            raise ResumeValidationError(
                f"checkpoint record has an invalid {kind} parent edge"
            )
    if (
        record.get("image_path") != assets["raw"].get("path")
        or record.get("raw_image_path") != assets["raw"].get("path")
        or record.get("clip_image_path") != assets["glyph_224"].get("path")
        or record.get("context_image_path") != assets["context"].get("path")
        or record.get("glyph_224_path") != assets["glyph_224"].get("path")
        or record.get("context_224_path") != assets["context_224"].get("path")
        or record.get("glyph_rgba_path") != assets["glyph_rgba"].get("path")
        or record.get("glyph_mask_path") != assets["mask"].get("path")
        or record.get("masked_context_path") != assets["context"].get("path")
        or assets["raw"].get("pixel_sha256") != record.get("crop_sha256")
    ):
        raise ResumeValidationError(
            "checkpoint record asset aliases do not match its DAG"
        )
    compatibility_kinds = (
        "context",
        "glyph_rgba",
        "mask",
        "glyph_224",
        "context_224",
    )
    expected_paths = {kind: assets[kind].get("path") for kind in compatibility_kinds}
    expected_hashes = {
        kind: assets[kind].get("file_sha256") for kind in compatibility_kinds
    }
    if (
        record.get("mask_paths") != expected_paths
        or record.get("final_image_paths") != expected_paths
        or record.get("mask_asset_sha256") != expected_hashes
        or record.get("asset_file_sha256")
        != {
            "image_path": assets["raw"].get("file_sha256"),
            "clip_image_path": assets["glyph_224"].get("file_sha256"),
        }
    ):
        raise ResumeValidationError(
            "checkpoint record path/hash alias maps do not match its DAG"
        )


def _validate_record_assets(record: Mapping[str, Any], layout: OutputLayout) -> None:
    if record.get("provenance") != "real_processed" or record.get("synthetic"):
        raise ResumeValidationError("checkpoint contains invalid provenance")
    descriptors = list(_record_asset_descriptors(record))
    if not descriptors:
        raise ResumeValidationError("checkpoint record has no asset inventory")
    _validate_asset_parent_dag(record)
    for descriptor in descriptors:
        try:
            relative, pure = _relative_path(
                descriptor.get("path"),
                label="checkpoint asset path",
            )
        except InputValidationError as exc:
            raise ResumeValidationError(
                "checkpoint contains an unsafe asset path"
            ) from exc
        del relative
        path = _resolve_inside(layout.root, pure, "checkpoint asset path")
        if not path.is_file():
            raise ResumeValidationError(f"checkpoint asset is missing: {path}")
        expected = _valid_sha256(descriptor.get("file_sha256"))
        if expected is None or _sha256_file(path) != expected:
            raise ResumeValidationError(f"checkpoint asset changed: {path}")
        if descriptor.get("file_size_bytes") != path.stat().st_size:
            raise ResumeValidationError(f"checkpoint asset size changed: {path}")
        try:
            with Image.open(path) as opened:
                opened.load()
                actual_mode = opened.mode
                actual_size = [opened.width, opened.height]
                actual_pixel_sha256 = _pixel_sha256(opened)
        except (OSError, ValueError) as exc:
            raise ResumeValidationError(
                f"checkpoint asset cannot be decoded: {path}"
            ) from exc
        if (
            descriptor.get("mode") != actual_mode
            or descriptor.get("size_px") != actual_size
            or descriptor.get("pixel_sha256") != actual_pixel_sha256
        ):
            raise ResumeValidationError(
                f"checkpoint asset pixels do not match its descriptor: {path}"
            )
        if descriptor.get("provenance") not in {
            "real_preserved",
            "real_processed",
        }:
            raise ResumeValidationError(
                f"checkpoint asset has forbidden provenance: {path}"
            )


def _checkpoint_payload(
    *,
    signature_sha256: str,
    page_key: str,
    bindings: Sequence[Mapping[str, Any]],
    source_page_sha256: str,
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    _validate_checkpoint_coverage(
        records,
        rejects,
        bindings,
        label=page_key,
    )
    core = {
        "signature_sha256": signature_sha256,
        "page_key": page_key,
        "input_bindings": list(bindings),
        "input_binding_sha256": _sha256_json(bindings),
        "source_page_sha256": source_page_sha256,
        "records": list(records),
        "rejects": list(rejects),
    }
    return {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "completed_at": _utc_now(),
        **core,
        "checkpoint_sha256": _sha256_json(core),
    }


def _load_checkpoint(
    path: Path,
    *,
    signature_sha256: str,
    page_key: str,
    bindings: Sequence[Mapping[str, Any]],
    source_page_sha256: str,
    layout: OutputLayout,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]] | None:
    if not path.is_file():
        return None
    try:
        payload = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        raise ResumeValidationError(f"cannot read checkpoint: {path}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("tool") != TOOL_ID
        or payload.get("schema_version") != SCHEMA_VERSION
    ):
        raise ResumeValidationError(f"unrecognized checkpoint: {path}")
    core = {
        "signature_sha256": payload.get("signature_sha256"),
        "page_key": payload.get("page_key"),
        "input_bindings": payload.get("input_bindings"),
        "input_binding_sha256": payload.get("input_binding_sha256"),
        "source_page_sha256": payload.get("source_page_sha256"),
        "records": payload.get("records"),
        "rejects": payload.get("rejects"),
    }
    if payload.get("checkpoint_sha256") != _sha256_json(core):
        raise ResumeValidationError(f"checkpoint signature changed: {path}")
    if (
        core["signature_sha256"] != signature_sha256
        or core["page_key"] != page_key
        or core["input_bindings"] != list(bindings)
        or core["input_binding_sha256"] != _sha256_json(bindings)
        or core["source_page_sha256"] != source_page_sha256
        or not isinstance(core["records"], list)
        or not isinstance(core["rejects"], list)
    ):
        raise ResumeValidationError(f"checkpoint inputs changed: {path}")
    records = core["records"]
    rejects = core["rejects"]
    if any(not isinstance(record, dict) for record in records + rejects):
        raise ResumeValidationError(f"checkpoint rows are malformed: {path}")
    _validate_checkpoint_coverage(
        records,
        rejects,
        bindings,
        label=str(path),
    )
    for record in records:
        _validate_record_assets(record, layout)
    return records, rejects


def _process_page(
    items: Sequence[InputCandidate],
    *,
    page: VerifiedPage,
    layout: OutputLayout,
    masker: Any | None,
    masker_metadata: Mapping[str, Any],
    processor_source_sha256: str,
    run_signature_sha256: str,
    derivation_signature_sha256: str,
    args: argparse.Namespace,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    page_mask = None
    ctd_page_error: str | None = None
    inference_delta = 0
    if masker is not None:
        before = int(getattr(masker, "inference_count", 0))
        try:
            page_mask = masker.infer_page(page.rgb, color_order="RGB")
        except Exception as exc:
            ctd_page_error = f"ctd_page_fallback:{type(exc).__name__}:{exc}"
        after = int(getattr(masker, "inference_count", before))
        inference_delta = after - before
        if inference_delta > 1:
            raise HardPostprocessError(
                f"CTD performed {inference_delta} inferences for one page"
            )

    records: list[dict[str, Any]] = []
    rejects: list[dict[str, Any]] = []
    for item in items:
        raw = _verified_raw(item, page)
        try:
            record = _build_processed_record(
                item,
                page=page,
                raw=raw,
                layout=layout,
                page_mask=page_mask,
                masker_metadata=masker_metadata,
                ctd_page_error=ctd_page_error,
                processor_source_sha256=processor_source_sha256,
                run_signature_sha256=run_signature_sha256,
                derivation_signature_sha256=derivation_signature_sha256,
                args=args,
            )
        except RecoverableMaskError as exc:
            rejects.append(
                _reject_record(
                    item,
                    reasons=[str(exc)],
                    stage="mask_generation",
                )
            )
            continue
        records.append(record)
    records.sort(
        key=lambda record: (
            record["work_id"],
            record["chapter_id"],
            record["page_id"],
            record["bbox_px"],
            record["id"],
        )
    )
    rejects.sort(
        key=lambda record: (
            record["work_id"],
            record["chapter_id"],
            record["page_id"],
            record["bbox_px"],
            record["id"],
        )
    )
    return records, rejects, inference_delta


def _aggregate(
    layout: OutputLayout,
    *,
    signature_sha256: str,
    expected_bindings_by_page: Mapping[
        str,
        Sequence[Mapping[str, Any]],
    ],
    dry_run_records: Sequence[Mapping[str, Any]] | None = None,
    dry_run_rejects: Sequence[Mapping[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    if dry_run_records is not None and dry_run_rejects is not None:
        records = [dict(record) for record in dry_run_records]
        rejects = [dict(record) for record in dry_run_rejects]
        page_count = 0
    else:
        records = []
        rejects = []
        page_count = 0
        seen_page_keys: set[str] = set()
        for path in sorted(layout.state_dir.glob("*.json")):
            payload = _read_json(path)
            if (
                not isinstance(payload, dict)
                or payload.get("tool") != TOOL_ID
                or payload.get("schema_version") != SCHEMA_VERSION
                or payload.get("signature_sha256") != signature_sha256
            ):
                raise ResumeValidationError(f"invalid aggregate shard: {path}")
            core = {
                "signature_sha256": payload.get("signature_sha256"),
                "page_key": payload.get("page_key"),
                "input_bindings": payload.get("input_bindings"),
                "input_binding_sha256": payload.get("input_binding_sha256"),
                "source_page_sha256": payload.get("source_page_sha256"),
                "records": payload.get("records"),
                "rejects": payload.get("rejects"),
            }
            if payload.get("checkpoint_sha256") != _sha256_json(core):
                raise ResumeValidationError(
                    f"aggregate shard signature changed: {path}"
                )
            page_key = payload.get("page_key")
            if not isinstance(page_key, str) or page_key in seen_page_keys:
                raise ResumeValidationError(
                    f"duplicate or invalid aggregate page key: {path}"
                )
            seen_page_keys.add(page_key)
            expected_bindings = expected_bindings_by_page.get(page_key)
            if expected_bindings is None:
                raise ResumeValidationError(
                    f"aggregate shard has an unexpected page key: {path}"
                )
            if (
                payload.get("input_bindings") != list(expected_bindings)
                or payload.get("input_binding_sha256")
                != _sha256_json(expected_bindings)
                or payload.get("source_page_sha256")
                != expected_bindings[0].get("source_page_sha256")
            ):
                raise ResumeValidationError(
                    f"aggregate shard bindings do not match current input: {path}"
                )
            shard_records = payload.get("records")
            shard_rejects = payload.get("rejects")
            if not isinstance(shard_records, list) or not isinstance(
                shard_rejects,
                list,
            ):
                raise ResumeValidationError(f"malformed aggregate shard: {path}")
            if any(
                not isinstance(record, Mapping)
                for record in shard_records + shard_rejects
            ):
                raise ResumeValidationError(f"malformed aggregate row: {path}")
            shard_bindings = payload.get("input_bindings")
            if not isinstance(shard_bindings, list) or any(
                not isinstance(binding, Mapping) for binding in shard_bindings
            ):
                raise ResumeValidationError(f"malformed aggregate bindings: {path}")
            _validate_checkpoint_coverage(
                shard_records,
                shard_rejects,
                shard_bindings,
                label=str(path),
            )
            for record in shard_records:
                _validate_record_assets(record, layout)
                records.append(dict(record))
            rejects.extend(dict(record) for record in shard_rejects)
            page_count += 1
        if seen_page_keys != set(expected_bindings_by_page):
            raise ResumeValidationError(
                "completed checkpoint inventory does not match input pages"
            )

    record_ids = [record.get("id") for record in records]
    if any(not isinstance(value, str) for value in record_ids) or len(
        record_ids
    ) != len(set(record_ids)):
        raise ResumeValidationError("aggregate processed IDs are not unique")
    asset_ids: list[str] = []
    asset_paths: list[str] = []
    for record in records:
        for descriptor in _record_asset_descriptors(record):
            asset_id = descriptor.get("id")
            asset_path = descriptor.get("path")
            if not isinstance(asset_id, str) or not isinstance(asset_path, str):
                raise ResumeValidationError(
                    "aggregate contains an invalid asset identity"
                )
            asset_ids.append(asset_id)
            asset_paths.append(asset_path)
    if len(asset_ids) != len(set(asset_ids)) or len(asset_paths) != len(
        set(asset_paths)
    ):
        raise ResumeValidationError(
            "aggregate asset IDs or paths are not globally unique"
        )

    def record_key(record: Mapping[str, Any]) -> tuple[Any, ...]:
        return (
            record.get("work_id"),
            record.get("chapter_id"),
            record.get("page_id"),
            record.get("bbox_px"),
            record.get("id"),
        )

    records.sort(key=record_key)
    rejects.sort(key=record_key)
    return records, rejects, page_count


def _report(
    *,
    args: argparse.Namespace,
    input_root: Path,
    library_root: Path,
    manifest: Path,
    manifest_sha256: str,
    layout: OutputLayout,
    input_rows: int,
    pages: int,
    processed_pages: int,
    resumed_pages: int,
    page_inferences: int,
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    masker_metadata: Mapping[str, Any],
    resumed_invocation: bool,
    input_attestation: Mapping[str, Any],
    output_forecast: Mapping[str, Any],
) -> dict[str, Any]:
    methods = Counter(
        str(record.get("processing", {}).get("mask_method"))
        for record in records
        if isinstance(record.get("processing"), Mapping)
    )
    quality = Counter(
        str(record.get("quality", {}).get("status"))
        for record in records
        if isinstance(record.get("quality"), Mapping)
    )
    failure_reasons: Counter[str] = Counter()
    categories: Counter[str] = Counter()
    by_split: Counter[str] = Counter()
    by_work: Counter[str] = Counter()
    for record in records:
        by_split[str(record.get("split"))] += 1
        by_work[str(record.get("work_id"))] += 1
        quality_value = record.get("quality")
        if isinstance(quality_value, Mapping):
            reasons = quality_value.get("failure_reasons")
            if isinstance(reasons, list):
                failure_reasons.update(str(reason) for reason in reasons)
        metadata = record.get("candidate_metadata")
        if isinstance(metadata, Mapping):
            values = metadata.get("categories")
            if isinstance(values, list):
                categories.update(str(value) for value in values)
    for record in rejects:
        reasons = record.get("failure_reasons")
        if isinstance(reasons, list):
            failure_reasons.update(str(reason) for reason in reasons)
    descriptors = [
        descriptor
        for record in records
        for descriptor in _record_asset_descriptors(record)
    ]
    return {
        "ok": True,
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "completed_at": _utc_now(),
        "dry_run": bool(args.dry_run),
        "resumed_invocation": resumed_invocation,
        "input_root": str(input_root),
        "library_root": str(library_root),
        "input_manifest": str(manifest),
        "input_manifest_sha256": manifest_sha256,
        "input_builder_attestation": dict(input_attestation),
        "output_root": str(layout.root),
        "output_preflight": dict(output_forecast),
        "input_rows": input_rows,
        "source_pages": pages,
        "processed_pages_this_run": processed_pages,
        "resumed_pages_this_run": resumed_pages,
        "ctd_page_inferences_this_run": page_inferences,
        "processed_records": len(records),
        "rejected_records": len(rejects),
        "encoded_asset_files": len(descriptors),
        "encoded_asset_bytes": sum(
            int(descriptor.get("file_size_bytes", 0)) for descriptor in descriptors
        ),
        "by_mask_method": dict(sorted(methods.items())),
        "by_quality_status": dict(sorted(quality.items())),
        "by_split": dict(sorted(by_split.items())),
        "by_work": dict(sorted(by_work.items())),
        "category_memberships": dict(sorted(categories.items())),
        "failure_reasons": dict(sorted(failure_reasons.items())),
        "ctd_runtime": dict(masker_metadata),
        "synthetic_assets_generated": 0,
        "hard_qa_contract": {
            "max_chapters_per_work": 20,
            "quality_gate": "hard_style_reviewable_v2",
            "general_tier_a_gate_used": False,
        },
        "synthetic_provenance_spec": (
            None if args.dry_run else str(layout.synthetic_spec)
        ),
        "outputs": {
            "manifest": None if args.dry_run else str(layout.manifest),
            "rejects": None if args.dry_run else str(layout.rejects),
            "report": None if args.dry_run else str(layout.report),
        },
    }


def _create_masker(
    args: argparse.Namespace,
    *,
    masker_factory: Callable[..., Any],
) -> tuple[Any | None, dict[str, Any]]:
    if args.no_ctd:
        return None, {
            "mode": "disabled",
            "available": False,
            "fallback": "classical_multi_polarity",
        }
    masker = masker_factory(
        args.ctd_model,
        config_path=args.ctd_config or None,
        preprocessor_path=args.ctd_preprocessor or None,
        providers=["CPUExecutionProvider"],
        threshold=float(args.ctd_threshold),
        min_component_pixels=int(args.ctd_min_component_pixels),
        border_band=int(args.ctd_border_band),
        verify_model_hash=bool(args.verify_ctd_model_hash),
        eager=True,
        strict=False,
    )
    metadata = dict(getattr(masker, "model_info", {}))
    metadata["mode"] = "ctd_with_classical_fallback"
    metadata["fallback"] = "classical_multi_polarity"
    runtime_versions: dict[str, str | None] = {}
    for package in ("onnxruntime", "opencv-python", "opencv-python-headless"):
        try:
            runtime_versions[package] = version(package)
        except PackageNotFoundError:
            runtime_versions[package] = None
    metadata["runtime_versions"] = runtime_versions
    if not bool(getattr(masker, "available", False)):
        return None, metadata
    return masker, metadata


def _ctd_file_signatures(args: argparse.Namespace) -> dict[str, Any]:
    if args.no_ctd:
        return {"enabled": False}
    return {
        "enabled": True,
        "model": _content_signature(Path(args.ctd_model).resolve()),
        "config": _content_signature(Path(args.ctd_config).resolve()),
        "preprocessor": _content_signature(Path(args.ctd_preprocessor).resolve()),
    }


def _signature(
    *,
    args: argparse.Namespace,
    input_root: Path,
    library_root: Path,
    manifest: Path,
    manifest_sha256: str,
    masker_metadata: Mapping[str, Any],
    processor_signature: Mapping[str, Any],
    ctd_file_signatures: Mapping[str, Any],
    input_attestation: Mapping[str, Any],
) -> dict[str, Any]:
    runtime_signature = {
        key: masker_metadata.get(key)
        for key in (
            "mode",
            "available",
            "provider",
            "input_size",
            "segmentation_output_name",
            "fallback",
            "runtime_versions",
        )
    }
    return {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "algorithm_version": ALGORITHM_VERSION,
        "processor_source": dict(processor_signature),
        "input_root": str(input_root),
        "library_root": str(library_root),
        "manifest": str(manifest),
        "manifest_sha256": manifest_sha256,
        "input_builder_attestation": dict(input_attestation),
        "configuration": {
            "context_padding_ratio": float(args.context_padding_ratio),
            "context_padding_min": int(args.context_padding_min),
            "context_padding_max": int(args.context_padding_max),
            "deskew_min_angle": float(args.deskew_min_angle),
            "deskew_max_angle": float(args.deskew_max_angle),
            "ctd_threshold": float(args.ctd_threshold),
            "ctd_min_component_pixels": int(args.ctd_min_component_pixels),
            "ctd_border_band": int(args.ctd_border_band),
            "verify_ctd_model_hash": bool(args.verify_ctd_model_hash),
            "minimum_processed_records": int(args.minimum_processed_records),
            "classical_cv_backend": (
                {
                    "name": "opencv",
                    "version": str(getattr(cv2, "__version__", "unknown")),
                }
                if cv2 is not None
                else {"name": "numpy_python_fallback", "version": "1"}
            ),
        },
        "ctd_files": dict(ctd_file_signatures),
        "ctd_runtime": runtime_signature,
        "runtime_versions": {
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "pillow": PIL.__version__,
        },
        "synthetic_generation": False,
    }


def _derivation_signature(signature: Mapping[str, Any]) -> dict[str, Any]:
    raw_ctd_files = signature.get("ctd_files")
    ctd_content: dict[str, Any] = {}
    if isinstance(raw_ctd_files, Mapping):
        ctd_content["enabled"] = bool(raw_ctd_files.get("enabled"))
        for kind in ("model", "config", "preprocessor"):
            value = raw_ctd_files.get(kind)
            if isinstance(value, Mapping):
                ctd_content[kind] = {
                    "exists": bool(value.get("exists")),
                    "sha256": value.get("sha256"),
                    "size": value.get("size"),
                }
    return {
        "algorithm_version": signature.get("algorithm_version"),
        "processor_source_sha256": (
            signature.get("processor_source", {}).get("sha256")
            if isinstance(signature.get("processor_source"), Mapping)
            else None
        ),
        "configuration": signature.get("configuration"),
        "ctd_content": ctd_content,
        "ctd_runtime": signature.get("ctd_runtime"),
        "runtime_versions": signature.get("runtime_versions"),
        "synthetic_generation": False,
    }


def _progress(message: str, quiet: bool) -> None:
    if not quiet:
        print(message, file=sys.stderr, flush=True)


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input-root",
        "--dataset",
        type=Path,
        default=repo_root / "datasets" / "fontclip-hard-candidates-v1",
    )
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
        default=repo_root / "datasets" / "fontclip-hard-processed-v1",
    )
    parser.add_argument(
        "--manifest",
        default=MANIFEST_NAME,
        help="input JSONL relative to --input-root",
    )
    parser.add_argument(
        "--expected-input-manifest-sha256",
        help=(
            "required when the builder marker predates manifest hash signing; "
            "pins the exact audited input JSONL"
        ),
    )
    parser.add_argument("--ctd-model", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--ctd-config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument(
        "--ctd-preprocessor",
        type=Path,
        default=DEFAULT_PREPROCESSOR_PATH,
    )
    parser.add_argument("--ctd-threshold", type=float, default=0.3)
    parser.add_argument("--ctd-min-component-pixels", type=int, default=3)
    parser.add_argument("--ctd-border-band", type=int, default=1)
    parser.add_argument("--verify-ctd-model-hash", action="store_true")
    parser.add_argument("--no-ctd", action="store_true")
    parser.add_argument("--context-padding-ratio", type=float, default=0.35)
    parser.add_argument("--context-padding-min", type=int, default=6)
    parser.add_argument("--context-padding-max", type=int, default=64)
    parser.add_argument("--deskew-min-angle", type=float, default=2.0)
    parser.add_argument("--deskew-max-angle", type=float, default=25.0)
    parser.add_argument("--minimum-input-candidates", type=int, default=5000)
    parser.add_argument("--minimum-processed-records", type=int, default=5000)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser


def _validate_args(args: argparse.Namespace) -> None:
    if not 0.0 <= float(args.ctd_threshold) <= 1.0:
        raise ValueError("--ctd-threshold must be between 0 and 1")
    if int(args.ctd_min_component_pixels) < 1:
        raise ValueError("--ctd-min-component-pixels must be positive")
    if int(args.ctd_border_band) < 1:
        raise ValueError("--ctd-border-band must be positive")
    if not 0.0 <= float(args.context_padding_ratio) <= 2.0:
        raise ValueError("--context-padding-ratio must be between 0 and 2")
    if int(args.context_padding_min) < 0 or int(args.context_padding_max) < int(
        args.context_padding_min
    ):
        raise ValueError("context padding bounds are invalid")
    if (
        float(args.deskew_min_angle) < 0
        or float(args.deskew_max_angle) < float(args.deskew_min_angle)
        or float(args.deskew_max_angle) > 45
    ):
        raise ValueError("deskew angle bounds are invalid")
    if int(args.minimum_input_candidates) < 0:
        raise ValueError("--minimum-input-candidates cannot be negative")
    if int(args.minimum_processed_records) < 0:
        raise ValueError("--minimum-processed-records cannot be negative")
    if (
        args.expected_input_manifest_sha256 is not None
        and _valid_sha256(args.expected_input_manifest_sha256) is None
    ):
        raise ValueError(
            "--expected-input-manifest-sha256 must be 64 lowercase hex digits"
        )
    if args.preflight_only and (args.overwrite or args.dry_run):
        raise ValueError(
            "--preflight-only cannot be combined with --overwrite or --dry-run"
        )


def run(
    args: argparse.Namespace,
    *,
    masker_factory: Callable[..., Any] = ComicTextMasker,
) -> dict[str, Any]:
    _validate_args(args)
    repo_root = Path(__file__).resolve().parents[1]
    input_root = Path(args.input_root).expanduser().resolve()
    library_root = Path(args.library_root).expanduser().resolve()
    if not input_root.is_dir():
        raise InputValidationError(f"input dataset is missing: {input_root}")
    if not library_root.is_dir():
        raise InputValidationError(f"library is missing: {library_root}")
    if (
        input_root == library_root
        or _is_within(input_root, library_root)
        or _is_within(library_root, input_root)
    ):
        raise InputValidationError(
            "input dataset and library must be separate, non-nested directories"
        )
    manifest_value = Path(args.manifest)
    manifest = (
        manifest_value.resolve()
        if manifest_value.is_absolute()
        else (input_root / manifest_value).resolve()
    )
    if not _is_within(input_root, manifest) or not manifest.is_file():
        raise InputValidationError(
            f"manifest must be a file inside --input-root: {manifest}"
        )
    output_root = _validate_output_root(
        Path(args.output_root),
        input_root=input_root,
        library_root=library_root,
        repo_root=repo_root,
    )
    layout = _layout(output_root)
    preflight_output_occupancy = (
        _inspect_preflight_output(layout) if args.preflight_only else None
    )
    manifest_sha256 = _sha256_file(manifest)
    items = _load_input(
        manifest,
        input_root=input_root,
        library_root=library_root,
    )
    if len(items) < int(args.minimum_input_candidates):
        raise InputValidationError(
            f"input candidate count {len(items)} is below the materialization "
            f"gate of {int(args.minimum_input_candidates)}"
        )
    input_attestation = _attest_input_dataset(
        input_root=input_root,
        library_root=library_root,
        manifest=manifest,
        manifest_sha256=manifest_sha256,
        items=items,
        expected_manifest_sha256=args.expected_input_manifest_sha256,
    )
    output_forecast = _output_forecast(
        items,
        context_padding_max=int(args.context_padding_max),
        minimum_processed_records=int(args.minimum_processed_records),
    )
    _progress(
        "[preflight] "
        f"candidates={len(items)} "
        f"png_files={output_forecast['mandatory_png_files_if_all_processed']}"
        f"..{output_forecast['maximum_png_files_if_all_processed']} "
        f"planning_bytes={output_forecast['planning_png_bytes_range']}",
        args.quiet,
    )
    if args.preflight_only:
        input_verification = _preflight_verify_signed_inputs(
            items,
            quiet=bool(args.quiet),
        )
        if _sha256_file(manifest) != manifest_sha256:
            raise SourceIntegrityError("input manifest changed during preflight")
        _assert_input_attestation_unchanged(input_attestation)
        return {
            "ok": True,
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "preflight_only": True,
            "dry_run": False,
            "input_root": str(input_root),
            "library_root": str(library_root),
            "output_root": str(output_root),
            "input_builder_attestation": input_attestation,
            "input_verification": input_verification,
            "output_preflight": output_forecast,
            "output_occupancy": preflight_output_occupancy,
            "output_written": False,
        }
    ctd_file_signatures = _ctd_file_signatures(args)
    masker, masker_metadata = _create_masker(
        args,
        masker_factory=masker_factory,
    )
    if _ctd_file_signatures(args) != ctd_file_signatures:
        raise SourceIntegrityError("CTD model or metadata changed while loading")
    processor_path = LOADED_PROCESSOR_PATH
    processor_signature = dict(LOADED_PROCESSOR_SIGNATURE)
    processor_source_sha256 = str(processor_signature["sha256"])
    if _content_signature(processor_path) != processor_signature:
        raise SourceIntegrityError("processor source changed after module import")
    signature = _signature(
        args=args,
        input_root=input_root,
        library_root=library_root,
        manifest=manifest,
        manifest_sha256=manifest_sha256,
        masker_metadata=masker_metadata,
        processor_signature=processor_signature,
        ctd_file_signatures=ctd_file_signatures,
        input_attestation=input_attestation,
    )
    signature_sha256 = _sha256_json(signature)
    derivation_signature_sha256 = _sha256_json(_derivation_signature(signature))
    if args.overwrite and not args.dry_run:
        _preflight_verify_signed_inputs(
            items,
            quiet=bool(args.quiet),
        )
        if _sha256_file(manifest) != manifest_sha256:
            raise SourceIntegrityError("input manifest changed before overwrite")
        _assert_input_attestation_unchanged(input_attestation)
        if _sha256_file(processor_path) != processor_source_sha256:
            raise SourceIntegrityError("processor source changed before overwrite")
        if _ctd_file_signatures(args) != ctd_file_signatures:
            raise SourceIntegrityError("CTD model or metadata changed before overwrite")
    resumed_invocation = _prepare_output(
        layout,
        signature=signature,
        overwrite=bool(args.overwrite),
        dry_run=bool(args.dry_run),
    )

    groups: dict[str, list[InputCandidate]] = defaultdict(list)
    for item in items:
        groups[item.page_key].append(item)
    ordered_groups = sorted(
        groups.items(),
        key=lambda entry: min(item.deterministic_key for item in entry[1]),
    )
    processed_pages = 0
    resumed_pages = 0
    page_inferences = 0
    dry_records: list[dict[str, Any]] = []
    dry_rejects: list[dict[str, Any]] = []
    for page_index, (page_key, page_items) in enumerate(ordered_groups, 1):
        page_items.sort(key=lambda item: item.deterministic_key)
        page = _verified_page(page_items)
        _assert_page_inputs_unchanged(page, page_items)
        bindings = _input_bindings(
            page_items,
            processor_source_sha256=processor_source_sha256,
            derivation_signature_sha256=derivation_signature_sha256,
        )
        state_path = _page_state_path(layout, page_key)
        checkpoint = None
        if not args.dry_run:
            checkpoint = _load_checkpoint(
                state_path,
                signature_sha256=signature_sha256,
                page_key=page_key,
                bindings=bindings,
                source_page_sha256=page.file_sha256,
                layout=layout,
            )
        if checkpoint is not None:
            for item in page_items:
                _verified_raw(item, page)
            resumed_pages += 1
            _progress(
                f"[page {page_index}/{len(ordered_groups)}] resume {page_key}",
                args.quiet,
            )
            continue
        records, rejects, inference_count = _process_page(
            page_items,
            page=page,
            layout=layout,
            masker=masker,
            masker_metadata=masker_metadata,
            processor_source_sha256=processor_source_sha256,
            run_signature_sha256=signature_sha256,
            derivation_signature_sha256=derivation_signature_sha256,
            args=args,
        )
        _assert_page_inputs_unchanged(page, page_items)
        page_inferences += inference_count
        processed_pages += 1
        if args.dry_run:
            dry_records.extend(records)
            dry_rejects.extend(rejects)
        else:
            payload = _checkpoint_payload(
                signature_sha256=signature_sha256,
                page_key=page_key,
                bindings=bindings,
                source_page_sha256=page.file_sha256,
                records=records,
                rejects=rejects,
            )
            _atomic_write_json(state_path, payload)
        _progress(
            f"[page {page_index}/{len(ordered_groups)}] "
            f"processed={len(records)} rejected={len(rejects)} "
            f"ctd_inference={inference_count} {page_key}",
            args.quiet,
        )

    if _sha256_file(manifest) != manifest_sha256:
        raise SourceIntegrityError("input manifest changed during processing")
    if _sha256_file(processor_path) != processor_source_sha256:
        raise SourceIntegrityError("processor source changed during processing")
    if _ctd_file_signatures(args) != ctd_file_signatures:
        raise SourceIntegrityError("CTD model or metadata changed during processing")
    _assert_input_attestation_unchanged(input_attestation)
    _assert_all_inputs_unchanged(items)
    records, rejects, completed_shards = _aggregate(
        layout,
        signature_sha256=signature_sha256,
        expected_bindings_by_page={
            page_key: _input_bindings(
                page_items,
                processor_source_sha256=processor_source_sha256,
                derivation_signature_sha256=derivation_signature_sha256,
            )
            for page_key, page_items in ordered_groups
        },
        dry_run_records=dry_records if args.dry_run else None,
        dry_run_rejects=dry_rejects if args.dry_run else None,
    )
    if len(records) < int(args.minimum_processed_records):
        raise HardPostprocessError(
            f"processed record count {len(records)} is below the required "
            f"minimum of {int(args.minimum_processed_records)}"
        )
    summary = _report(
        args=args,
        input_root=input_root,
        library_root=library_root,
        manifest=manifest,
        manifest_sha256=manifest_sha256,
        layout=layout,
        input_rows=len(items),
        pages=len(ordered_groups),
        processed_pages=processed_pages,
        resumed_pages=resumed_pages,
        page_inferences=page_inferences,
        records=records,
        rejects=rejects,
        masker_metadata=masker_metadata,
        resumed_invocation=resumed_invocation,
        input_attestation=input_attestation,
        output_forecast=output_forecast,
    )
    summary["completed_page_shards"] = completed_shards
    if not args.dry_run:
        for record in records:
            _validate_record_assets(record, layout)
        _atomic_write_jsonl(layout.manifest, records)
        _atomic_write_jsonl(layout.rejects, rejects)
        _atomic_write_json(layout.synthetic_spec, SYNTHETIC_PROVENANCE_SPEC)
        summary["outputs"].update(
            {
                "manifest_sha256": _sha256_file(layout.manifest),
                "rejects_sha256": _sha256_file(layout.rejects),
                "synthetic_provenance_spec_sha256": _sha256_file(layout.synthetic_spec),
            }
        )
        _atomic_write_json(layout.report, summary)
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        summary = run(args)
    except (HardPostprocessError, OSError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
