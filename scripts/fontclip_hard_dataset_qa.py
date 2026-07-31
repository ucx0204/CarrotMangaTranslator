#!/usr/bin/env python3
"""Exhaustively validate and visually audit FontClip hard-style assets.

This verifier is deliberately independent from the hard postprocessor.  It
rehashes the completed output, reconstructs semantic asset relationships, and
only then emits recorder-compatible exhaustive contact sheets.  The contact
sheets are review artifacts; none of their cyan/yellow annotations are written
back into training assets.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import sys
import tempfile
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError


POSTPROCESS_TOOL_ID = "manga-translator-fontclip-hard-postprocessor"
QA_TOOL_ID = "manga-translator-fontclip-hard-dataset-qa"
SCHEMA_VERSION = 1
ALGORITHM_VERSION = "hard-cv-v2"
MARKER_NAME = ".fontclip-hard-postprocess.json"
STATE_DIR_NAME = ".fontclip-hard-postprocess-pages"
MANIFEST_NAME = "manifest.jsonl"
REJECTS_NAME = "rejects.jsonl"
REPORT_NAME = "report.json"
SYNTHETIC_SPEC_NAME = "synthetic_provenance_schema.json"
MAX_CHAPTERS_PER_WORK = 20
DEFAULT_CONTACT_SHEET_SIZE = 12
ALLOWED_SPLITS = frozenset({"train", "val", "test"})
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_COMPONENT = re.compile(r"^[^/\\\x00]+$")
SUPPORTED_IMAGES = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
)
PROCESSED_ID_RE = re.compile(r"^fhp_[0-9a-f]{24}$")
ASSET_ID_RE = re.compile(r"^fhpa_[0-9a-f]{24}$")
SOURCE_ASSET_ID_RE = re.compile(r"^fhps_[0-9a-f]{24}$")
SHARD_HASH_NAMESPACE = "fontclip-qa-shard-v1"

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
REQUIRED_ASSET_KINDS = frozenset(
    {
        "raw",
        "context",
        "glyph_rgba",
        "mask",
        "black_on_white",
        "white_on_black",
        "color_mask",
        "outline_fill",
        "outline_stroke",
        "outline_outer_ring",
        "glyph_224",
        "context_224",
    }
)
EXPECTED_MODES = {
    "raw": "RGB",
    "context": "RGB",
    "glyph_rgba": "RGBA",
    "mask": "L",
    "black_on_white": "RGB",
    "white_on_black": "RGB",
    "color_mask": "L",
    "outline_fill": "L",
    "outline_stroke": "L",
    "outline_outer_ring": "L",
    "glyph_224": "RGB",
    "context_224": "RGB",
    "deskew_rgba": "RGBA",
}
EXPECTED_OPERATIONS = {
    "raw": "byte_exact_verified_copy",
    "context": "source_context_crop",
    "glyph_rgba": "source_rgb_with_selected_mask_alpha",
    "mask": "tight_selected_binary_mask",
    "black_on_white": "binary_polarity_normalization",
    "white_on_black": "binary_polarity_normalization",
    "color_mask": "lab_hsv_colour_outlier_mask",
    "outline_fill": "binary_erosion_fill",
    "outline_stroke": "mask_minus_eroded_fill",
    "outline_outer_ring": "dilation_annulus",
    "glyph_224": "aspect_preserving_letterbox",
    "context_224": "aspect_preserving_letterbox",
    "deskew_rgba": "auxiliary_deskew",
}
QA_CONTEXT_COLOR = (0, 190, 220)
QA_TIGHT_COLOR = (255, 205, 0)
QA_OVERLAY_COLORS = (QA_CONTEXT_COLOR, QA_TIGHT_COLOR)
REVIEW_FIELDS = (
    "decision",
    "reject_reason",
    "recrop_bbox_px",
    "padding_px",
    "reviewer",
    "reviewed_at",
    "notes",
)


@dataclass
class IssueCollector:
    """Count all findings while bounding the materialized report size."""

    detail_limit: int = 20_000
    counts: Counter[str] = field(default_factory=Counter)
    details: list[dict[str, Any]] = field(default_factory=list)

    def add(
        self,
        code: str,
        message: str,
        *,
        sample_id: str | None = None,
        path: Path | str | None = None,
    ) -> None:
        self.counts[code] += 1
        if len(self.details) < self.detail_limit:
            detail: dict[str, Any] = {"code": code, "message": message}
            if sample_id:
                detail["id"] = sample_id
            if path is not None:
                detail["path"] = str(path)
            self.details.append(detail)

    @property
    def error_count(self) -> int:
        return sum(self.counts.values())


@dataclass(frozen=True)
class PageInfo:
    path: Path
    relative: str
    file_sha256: str
    size_bytes: int
    image: Image.Image


class SourcePageCache:
    """A small deterministic LRU cache for signed source-page pixels."""

    def __init__(self, library_root: Path, limit: int = 4) -> None:
        self.library_root = library_root
        self.limit = max(1, limit)
        self._cache: OrderedDict[str, PageInfo] = OrderedDict()

    def get(self, relative: str) -> PageInfo:
        cached = self._cache.pop(relative, None)
        if cached is not None:
            self._cache[relative] = cached
            return cached
        pure = safe_relative_path(relative, "source_image_path")
        path = resolve_inside(self.library_root, pure, "source_image_path")
        payload = path.read_bytes()
        with Image.open(io.BytesIO(payload)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.load()
        info = PageInfo(
            path=path,
            relative=relative,
            file_sha256=sha256_bytes(payload),
            size_bytes=len(payload),
            image=image,
        )
        self._cache[relative] = info
        while len(self._cache) > self.limit:
            _, evicted = self._cache.popitem(last=False)
            evicted.image.close()
        return info

    def close(self) -> None:
        for info in self._cache.values():
            info.image.close()
        self._cache.clear()


@dataclass
class ValidationResult:
    records: list[dict[str, Any]]
    rejects: list[dict[str, Any]]
    marker: dict[str, Any]
    report: dict[str, Any]
    manifest_sha256: str
    rejects_sha256: str
    report_sha256: str
    marker_sha256: str
    synthetic_spec_sha256: str
    global_ids: list[str]


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pixel_sha256(image: Image.Image) -> str:
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


def valid_sha256(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if HEX_SHA256.fullmatch(normalized):
            return normalized
    return None


def hash_ids(ids: Iterable[str], *, sort_items: bool) -> str:
    values = list(ids)
    if sort_items:
        values.sort()
    return sha256_bytes("\n".join(values).encode("utf-8"))


def is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def safe_component(value: Any, label: str) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or text in {".", ".."} or not SAFE_COMPONENT.fullmatch(text):
        raise ValueError(f"unsafe or empty {label}: {value!r}")
    return text


def safe_relative_path(value: Any, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"missing {label}")
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
        raise ValueError(f"unsafe {label}: {value!r}")
    return pure


def resolve_inside(root: Path, relative: PurePosixPath, label: str) -> Path:
    candidate = root.joinpath(*relative.parts).resolve()
    if not is_within(root, candidate):
        raise ValueError(f"{label} escaped its root: {relative}")
    return candidate


def parse_bbox(value: Any, label: str) -> tuple[int, int, int, int]:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 4
        or any(isinstance(item, bool) or not isinstance(item, int) for item in value)
    ):
        raise ValueError(f"{label} must contain four integer coordinates")
    x1, y1, x2, y2 = (int(item) for item in value)
    if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
        raise ValueError(f"invalid {label}: {value!r}")
    return x1, y1, x2, y2


def bbox_contains(
    outer: tuple[int, int, int, int],
    inner: tuple[int, int, int, int],
) -> bool:
    return (
        outer[0] <= inner[0]
        and outer[1] <= inner[1]
        and outer[2] >= inner[2]
        and outer[3] >= inner[3]
    )


def read_json_object(
    path: Path,
    issues: IssueCollector,
    code: str,
) -> dict[str, Any]:
    if not path.is_file():
        issues.add(code, f"required JSON file is missing: {path}", path=path)
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        issues.add(code, f"cannot read JSON object: {exc}", path=path)
        return {}
    if not isinstance(value, dict):
        issues.add(code, "expected a JSON object", path=path)
        return {}
    return value


def read_jsonl(
    path: Path,
    issues: IssueCollector,
    *,
    missing_code: str,
    invalid_code: str,
) -> list[dict[str, Any]]:
    if not path.is_file():
        issues.add(missing_code, f"required JSONL file is missing: {path}", path=path)
        return []
    try:
        payload = path.read_bytes()
        text = payload.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        issues.add(invalid_code, f"cannot read UTF-8 JSONL: {exc}", path=path)
        return []
    if payload and not payload.endswith(b"\n"):
        issues.add(invalid_code, "JSONL must end with LF", path=path)
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line:
            issues.add(
                invalid_code,
                f"blank JSONL line at {line_number}",
                path=path,
            )
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            issues.add(
                invalid_code,
                f"invalid JSON at line {line_number}: {exc}",
                path=path,
            )
            continue
        if not isinstance(value, dict):
            issues.add(
                invalid_code,
                f"line {line_number} is not an object",
                path=path,
            )
            continue
        if line != canonical_json(value):
            issues.add(
                "jsonl_noncanonical",
                f"line {line_number} is not canonical compact JSON",
                path=path,
            )
        records.append(value)
    return records


def add_if(
    issues: IssueCollector,
    condition: bool,
    code: str,
    message: str,
    *,
    sample_id: str | None = None,
    path: Path | str | None = None,
) -> None:
    if condition:
        issues.add(code, message, sample_id=sample_id, path=path)


def expected_asset_id(processed_id: str, kind: str) -> str:
    identity = {
        "processed_id": processed_id,
        "kind": kind,
        "algorithm_version": ALGORITHM_VERSION,
    }
    return "fhpa_" + sha256_json(identity)[:24]


def expected_source_asset_id(record: Mapping[str, Any]) -> str:
    identity = {
        "kind": "source_page",
        "source_image_path": record.get("source_image_path"),
        "source_page_sha256": record.get("source_page_sha256"),
        "provenance": "real_preserved",
    }
    return "fhps_" + sha256_json(identity)[:24]


def expected_processed_id(record: Mapping[str, Any]) -> str | None:
    processing = record.get("processing")
    if not isinstance(processing, Mapping):
        return None
    values = {
        "parent_id": record.get("parent_id"),
        "parent_record_sha256": record.get("parent_record_sha256"),
        "source_page_sha256": record.get("source_page_sha256"),
        "crop_sha256": record.get("crop_sha256"),
        "algorithm_version": ALGORITHM_VERSION,
        "processor_source_sha256": processing.get("processor_source_sha256"),
        "derivation_signature_sha256": processing.get("derivation_signature_sha256"),
        "provenance": "real_processed",
    }
    if any(value is None for value in values.values()):
        return None
    return "fhp_" + sha256_json(values)[:24]


def derivation_signature(signature: Mapping[str, Any]) -> dict[str, Any]:
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
    processor_source = signature.get("processor_source")
    processor_sha = (
        processor_source.get("sha256")
        if isinstance(processor_source, Mapping)
        else None
    )
    return {
        "algorithm_version": signature.get("algorithm_version"),
        "processor_source_sha256": processor_sha,
        "configuration": signature.get("configuration"),
        "ctd_content": ctd_content,
        "ctd_runtime": signature.get("ctd_runtime"),
        "runtime_versions": signature.get("runtime_versions"),
        "synthetic_generation": False,
    }


def validate_content_signature(
    signature: Any,
    issues: IssueCollector,
    *,
    label: str,
) -> None:
    if not isinstance(signature, Mapping):
        issues.add("signature_invalid", f"{label} is not an object")
        return
    exists = signature.get("exists")
    path_value = signature.get("path")
    if exists is False:
        if signature.get("sha256") is not None or signature.get("size") is not None:
            issues.add(
                "signature_invalid",
                f"{label} declares a missing file with content metadata",
            )
        return
    if exists is not True or not isinstance(path_value, str):
        issues.add("signature_invalid", f"{label} lacks an existing file path")
        return
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        issues.add("signed_file_missing", f"{label} is missing", path=path)
        return
    actual_sha = sha256_file(path)
    actual_size = path.stat().st_size
    if signature.get("sha256") != actual_sha or signature.get("size") != actual_size:
        issues.add("signed_file_changed", f"{label} content changed", path=path)


def validate_marker_and_report(
    dataset_root: Path,
    library_root: Path,
    marker: Mapping[str, Any],
    report: Mapping[str, Any],
    issues: IssueCollector,
) -> tuple[str | None, str | None, str | None]:
    signature = marker.get("signature")
    add_if(
        issues,
        marker.get("tool") != POSTPROCESS_TOOL_ID
        or marker.get("schema_version") != SCHEMA_VERSION,
        "marker_contract_invalid",
        "ownership marker tool/schema is invalid",
    )
    add_if(
        issues,
        marker.get("output_root") != str(dataset_root),
        "marker_output_root_mismatch",
        "ownership marker output_root does not match the audited dataset",
    )
    add_if(
        issues,
        marker.get("owned_outputs") != list(OWNED_OUTPUTS),
        "marker_owned_outputs_mismatch",
        "ownership marker owned_outputs is not exact",
    )
    marker_signature_sha = (
        marker.get("signature_sha256")
        if isinstance(marker.get("signature_sha256"), str)
        else None
    )
    add_if(
        issues,
        not isinstance(signature, Mapping)
        or valid_sha256(marker_signature_sha) is None
        or marker_signature_sha != sha256_json(signature),
        "marker_signature_invalid",
        "ownership marker signature hash is invalid",
    )
    if isinstance(signature, Mapping):
        add_if(
            issues,
            signature.get("tool") != POSTPROCESS_TOOL_ID
            or signature.get("schema_version") != SCHEMA_VERSION
            or signature.get("algorithm_version") != ALGORITHM_VERSION
            or signature.get("synthetic_generation") is not False,
            "marker_signature_contract_invalid",
            "run signature tool, algorithm, or synthetic policy is invalid",
        )
        add_if(
            issues,
            signature.get("library_root") != str(library_root),
            "marker_library_root_mismatch",
            "run signature library_root does not match --library-root",
        )
        manifest_path_value = signature.get("manifest")
        manifest_sha = valid_sha256(signature.get("manifest_sha256"))
        if isinstance(manifest_path_value, str) and manifest_sha is not None:
            manifest_path = Path(manifest_path_value).expanduser().resolve()
            if not manifest_path.is_file():
                issues.add(
                    "signed_input_manifest_missing",
                    "signed hard-candidate manifest is missing",
                    path=manifest_path,
                )
            elif sha256_file(manifest_path) != manifest_sha:
                issues.add(
                    "signed_input_manifest_changed",
                    "signed hard-candidate manifest content changed",
                    path=manifest_path,
                )
        else:
            issues.add(
                "marker_signature_contract_invalid",
                "run signature lacks a valid input manifest signature",
            )
        validate_content_signature(
            signature.get("processor_source"),
            issues,
            label="processor_source",
        )
        ctd_files = signature.get("ctd_files")
        if isinstance(ctd_files, Mapping) and ctd_files.get("enabled"):
            for kind in ("model", "config", "preprocessor"):
                validate_content_signature(
                    ctd_files.get(kind),
                    issues,
                    label=f"ctd_{kind}",
                )
        processor_source = signature.get("processor_source")
        processor_source_sha = (
            valid_sha256(processor_source.get("sha256"))
            if isinstance(processor_source, Mapping)
            else None
        )
    else:
        processor_source_sha = None

    add_if(
        issues,
        report.get("ok") is not True
        or report.get("tool") != POSTPROCESS_TOOL_ID
        or report.get("schema_version") != SCHEMA_VERSION
        or report.get("dry_run") is not False,
        "report_contract_invalid",
        "postprocess report tool/schema/completion contract is invalid",
    )
    add_if(
        issues,
        report.get("output_root") != str(dataset_root),
        "report_output_root_mismatch",
        "postprocess report output_root does not match the audited dataset",
    )
    if isinstance(signature, Mapping):
        add_if(
            issues,
            report.get("input_root") != signature.get("input_root")
            or report.get("library_root") != signature.get("library_root")
            or report.get("input_manifest") != signature.get("manifest")
            or report.get("input_manifest_sha256") != signature.get("manifest_sha256")
            or report.get("input_builder_attestation")
            != signature.get("input_builder_attestation"),
            "report_signature_binding_mismatch",
            "report upstream bindings differ from the ownership signature",
        )
    report_contract = report.get("hard_qa_contract")
    add_if(
        issues,
        not isinstance(report_contract, Mapping)
        or report_contract.get("max_chapters_per_work") != MAX_CHAPTERS_PER_WORK
        or report_contract.get("quality_gate") != "hard_style_reviewable_v2"
        or report_contract.get("general_tier_a_gate_used") is not False,
        "report_hard_contract_invalid",
        "postprocess report does not declare the exact hard QA contract",
    )
    add_if(
        issues,
        report.get("synthetic_assets_generated") != 0,
        "synthetic_asset_forbidden",
        "real hard-style output must not contain generated synthetic assets",
    )
    outputs = report.get("outputs")
    if not isinstance(outputs, Mapping):
        issues.add("report_outputs_invalid", "report outputs is not an object")
    else:
        expected_paths = {
            "manifest": dataset_root / MANIFEST_NAME,
            "rejects": dataset_root / REJECTS_NAME,
            "report": dataset_root / REPORT_NAME,
        }
        for key, expected_path in expected_paths.items():
            add_if(
                issues,
                outputs.get(key) != str(expected_path),
                "report_output_path_mismatch",
                f"report output path for {key} is not exact",
                path=expected_path,
            )
    return (
        marker_signature_sha,
        (
            sha256_json(derivation_signature(signature))
            if isinstance(signature, Mapping)
            else None
        ),
        processor_source_sha,
    )


def strict_source_relative(
    row: Mapping[str, Any],
    library_root: Path,
) -> tuple[str, Path]:
    pure = safe_relative_path(row.get("source_image_path"), "source_image_path")
    work_id = safe_component(row.get("work_id"), "work_id")
    chapter_id = safe_component(row.get("chapter_id"), "chapter_id")
    if (
        len(pure.parts) != 6
        or pure.parts[0] != "works"
        or pure.parts[1] != work_id
        or pure.parts[2] != "chapters"
        or pure.parts[3] != chapter_id
        or pure.parts[4] != "pages"
        or Path(pure.parts[5]).suffix.lower() not in SUPPORTED_IMAGES
    ):
        raise ValueError(
            "source_image_path must be an original "
            "works/<work>/chapters/<chapter>/pages/<image> path"
        )
    path = resolve_inside(library_root, pure, "source_image_path")
    expected_parent = (
        library_root / "works" / work_id / "chapters" / chapter_id / "pages"
    ).resolve()
    if path.parent != expected_parent or not path.is_file():
        raise ValueError("source page is absent or resolves outside pages/")
    return pure.as_posix(), path


def inspect_asset(
    path: Path,
    descriptor: Mapping[str, Any],
    kind: str,
    issues: IssueCollector,
    sample_id: str,
) -> Image.Image | None:
    if not path.is_file():
        issues.add(
            "asset_missing",
            f"{kind} asset is missing",
            sample_id=sample_id,
            path=path,
        )
        return None
    try:
        payload = path.read_bytes()
        with Image.open(io.BytesIO(payload)) as opened:
            opened.load()
            image = opened.copy()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        issues.add(
            "asset_decode_failed",
            f"{kind} asset cannot be decoded: {exc}",
            sample_id=sample_id,
            path=path,
        )
        return None
    actual_file_sha = sha256_bytes(payload)
    actual_pixel_sha = pixel_sha256(image)
    add_if(
        issues,
        descriptor.get("file_sha256") != actual_file_sha,
        "asset_file_sha256_mismatch",
        f"{kind} file SHA-256 does not match its descriptor",
        sample_id=sample_id,
        path=path,
    )
    add_if(
        issues,
        descriptor.get("file_size_bytes") != len(payload),
        "asset_file_size_mismatch",
        f"{kind} byte size does not match its descriptor",
        sample_id=sample_id,
        path=path,
    )
    add_if(
        issues,
        descriptor.get("pixel_sha256") != actual_pixel_sha,
        "asset_pixel_sha256_mismatch",
        f"{kind} pixel SHA-256 does not match its descriptor",
        sample_id=sample_id,
        path=path,
    )
    add_if(
        issues,
        descriptor.get("mode") != image.mode
        or descriptor.get("size_px") != [image.width, image.height],
        "asset_decode_contract_mismatch",
        f"{kind} decoded mode/size does not match its descriptor",
        sample_id=sample_id,
        path=path,
    )
    add_if(
        issues,
        image.mode != EXPECTED_MODES.get(kind),
        "asset_mode_invalid",
        f"{kind} must use mode {EXPECTED_MODES.get(kind)}",
        sample_id=sample_id,
        path=path,
    )
    return image


def has_true_diagnostic_overlay(value: Any) -> bool:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if key == "diagnostic_overlay_written" and child is not False:
                return True
            if has_true_diagnostic_overlay(child):
                return True
    elif isinstance(value, list):
        return any(has_true_diagnostic_overlay(child) for child in value)
    return False


def expected_letterbox(image: Image.Image, size: int = 224) -> Image.Image:
    source = image.convert("RGB")
    scale = min(size / source.width, size / source.height)
    resized_size = (
        max(1, round(source.width * scale)),
        max(1, round(source.height * scale)),
    )
    resized = source.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    resized.close()
    return canvas


def image_arrays_equal(first: Image.Image, second: Image.Image) -> bool:
    return (
        first.mode == second.mode
        and first.size == second.size
        and first.tobytes() == second.tobytes()
    )


def binary_dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    binary = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return binary.copy()
    padded = np.pad(binary, radius, mode="constant", constant_values=False)
    height, width = binary.shape
    output = np.zeros_like(binary)
    for delta_y in range(radius * 2 + 1):
        for delta_x in range(radius * 2 + 1):
            output |= padded[
                delta_y : delta_y + height,
                delta_x : delta_x + width,
            ]
    return output


def binary_erode(mask: np.ndarray, radius: int) -> np.ndarray:
    binary = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return binary.copy()
    padded = np.pad(binary, radius, mode="constant", constant_values=False)
    height, width = binary.shape
    output = np.ones_like(binary)
    for delta_y in range(radius * 2 + 1):
        for delta_x in range(radius * 2 + 1):
            output &= padded[
                delta_y : delta_y + height,
                delta_x : delta_x + width,
            ]
    return output


def estimate_deskew_angle(
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
    metadata: dict[str, Any] = {
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


def validate_record_contract(
    record: Mapping[str, Any],
    *,
    dataset_root: Path,
    library_root: Path,
    page_cache: SourcePageCache,
    marker_signature_sha: str | None,
    derivation_signature_sha: str | None,
    processor_source_sha: str | None,
    context_padding_ratio: float,
    context_padding_min: int,
    context_padding_max: int,
    deskew_min_angle: float,
    deskew_max_angle: float,
    issues: IssueCollector,
) -> None:
    sample_id = record.get("id") if isinstance(record.get("id"), str) else ""
    if not sample_id:
        issues.add("record_id_invalid", "processed record has no string id")
        return
    add_if(
        issues,
        PROCESSED_ID_RE.fullmatch(sample_id) is None,
        "record_id_invalid",
        "processed id does not match fhp_<24hex>",
        sample_id=sample_id,
    )
    parent_id = record.get("parent_id")
    root_real_id = record.get("root_real_id")
    split = record.get("split")
    add_if(
        issues,
        record.get("schema_version") != SCHEMA_VERSION
        or record.get("hard_postprocess_schema_version") != SCHEMA_VERSION,
        "record_schema_invalid",
        "processed record schema versions are invalid",
        sample_id=sample_id,
    )
    add_if(
        issues,
        record.get("provenance") != "real_processed"
        or record.get("synthetic") is not False
        or record.get("synthetic_provenance") is not None
        or record.get("label") is not None,
        "record_provenance_invalid",
        "processed record must remain unsigned real_processed data",
        sample_id=sample_id,
    )
    add_if(
        issues,
        not isinstance(parent_id, str)
        or not parent_id
        or not isinstance(root_real_id, str)
        or not root_real_id
        or record.get("variant_group_id") != root_real_id,
        "record_lineage_invalid",
        "processed parent/root/variant identity is invalid",
        sample_id=sample_id,
    )
    add_if(
        issues,
        not isinstance(split, str) or split not in ALLOWED_SPLITS,
        "record_split_invalid",
        "processed split must be train, val, or test",
        sample_id=sample_id,
    )
    add_if(
        issues,
        record.get("tier") != "B",
        "record_tier_invalid",
        "hard processed rows must remain review tier B",
        sample_id=sample_id,
    )
    add_if(
        issues,
        valid_sha256(record.get("parent_record_sha256")) is None,
        "record_parent_hash_invalid",
        "processed record has no valid parent_record_sha256",
        sample_id=sample_id,
    )
    add_if(
        issues,
        expected_processed_id(record) != sample_id,
        "record_id_derivation_mismatch",
        "processed id is not reproducible from its signed lineage",
        sample_id=sample_id,
    )

    lineage = record.get("lineage")
    if not isinstance(lineage, list) or len(lineage) != 2:
        issues.add(
            "record_lineage_invalid",
            "processed lineage must contain exactly real_mined and real_processed",
            sample_id=sample_id,
        )
    else:
        first, second = lineage
        add_if(
            issues,
            not isinstance(first, Mapping)
            or first.get("id") != parent_id
            or first.get("provenance") != "real_mined"
            or first.get("source_page_sha256") != record.get("source_page_sha256")
            or first.get("crop_sha256") != record.get("crop_sha256"),
            "record_lineage_invalid",
            "real_mined lineage node is inconsistent",
            sample_id=sample_id,
        )
        processing = record.get("processing")
        add_if(
            issues,
            not isinstance(second, Mapping)
            or second.get("id") != sample_id
            or second.get("provenance") != "real_processed"
            or second.get("tool") != POSTPROCESS_TOOL_ID
            or second.get("algorithm_version") != ALGORITHM_VERSION
            or (
                isinstance(processing, Mapping)
                and (
                    second.get("processor_source_sha256")
                    != processing.get("processor_source_sha256")
                    or second.get("run_signature_sha256")
                    != processing.get("run_signature_sha256")
                    or second.get("derivation_signature_sha256")
                    != processing.get("derivation_signature_sha256")
                )
            ),
            "record_lineage_invalid",
            "real_processed lineage node is inconsistent",
            sample_id=sample_id,
        )

    processing = record.get("processing")
    add_if(
        issues,
        not isinstance(processing, Mapping)
        or processing.get("tool") != POSTPROCESS_TOOL_ID
        or processing.get("algorithm_version") != ALGORITHM_VERSION
        or processing.get("run_signature_sha256") != marker_signature_sha
        or processing.get("derivation_signature_sha256") != derivation_signature_sha
        or processing.get("processor_source_sha256") != processor_source_sha
        or processing.get("diagnostic_overlay_written") is not False
        or processing.get("source_geometry_replaced") is not False,
        "record_processing_invalid",
        "processing signature or no-overlay/source-geometry contract is invalid",
        sample_id=sample_id,
    )
    add_if(
        issues,
        has_true_diagnostic_overlay(record),
        "diagnostic_overlay_forbidden",
        "training manifest contains a non-false diagnostic overlay marker",
        sample_id=sample_id,
    )
    hard_contract = record.get("hard_qa_contract")
    add_if(
        issues,
        not isinstance(hard_contract, Mapping)
        or hard_contract.get("max_chapters_per_work") != MAX_CHAPTERS_PER_WORK
        or hard_contract.get("work_split_must_be_unique") is not True
        or hard_contract.get("all_variants_keep_parent_split") is not True,
        "record_hard_contract_invalid",
        "row-level hard QA contract is not exact",
        sample_id=sample_id,
    )
    review = record.get("review")
    mask_review = record.get("mask_review")
    allowed = ["pass", "reject", "recrop"]
    add_if(
        issues,
        not isinstance(review, Mapping)
        or review.get("status") != "pending"
        or review.get("allowed_decisions") != allowed
        or not isinstance(mask_review, Mapping)
        or mask_review.get("status") != "pending"
        or mask_review.get("allowed_decisions") != allowed
        or mask_review.get("recrop_bbox_px") is not None,
        "record_review_contract_invalid",
        "review fields are not in an unreviewed pass/reject/recrop state",
        sample_id=sample_id,
    )
    gate = record.get("hard_mask_quality_gate")
    add_if(
        issues,
        record.get("hard_mask_reviewable") is not True
        or record.get("needs_mask_enrichment") is not False
        or record.get("mask_enrichment_status") != "complete"
        or record.get("mask_schema_version") != 3
        or not isinstance(gate, Mapping)
        or gate.get("contract") != "hard_style_reviewable_v2"
        or gate.get("passed_for_human_review") is not True
        or gate.get("blocking_failure_count") != 0,
        "record_mask_contract_invalid",
        "hard mask completion/quality gate is invalid",
        sample_id=sample_id,
    )

    work_id = record.get("work_id")
    chapter_id = record.get("chapter_id")
    page_id = record.get("page_id")
    try:
        safe_component(work_id, "work_id")
        safe_component(chapter_id, "chapter_id")
        safe_component(page_id, "page_id")
        source_relative, source_path = strict_source_relative(record, library_root)
    except ValueError as exc:
        issues.add(
            "source_path_invalid",
            str(exc),
            sample_id=sample_id,
            path=record.get("source_image_path"),
        )
        return
    try:
        page = page_cache.get(source_relative)
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        issues.add(
            "source_page_decode_failed",
            f"signed source page cannot be loaded: {exc}",
            sample_id=sample_id,
            path=source_path,
        )
        return
    page_size = [page.image.width, page.image.height]
    source_sha = valid_sha256(record.get("source_page_sha256"))
    source_signature = record.get("source_page_content_signature")
    add_if(
        issues,
        source_sha is None
        or source_sha != page.file_sha256
        or record.get("page_size_px") != page_size
        or source_signature
        != {
            "sha256": page.file_sha256,
            "size": page.size_bytes,
        },
        "source_page_signature_mismatch",
        "source page file hash, size, or dimensions changed",
        sample_id=sample_id,
        path=source_path,
    )

    source_asset = record.get("source_page_asset")
    add_if(
        issues,
        not isinstance(source_asset, Mapping)
        or source_asset.get("id") != expected_source_asset_id(record)
        or SOURCE_ASSET_ID_RE.fullmatch(str(source_asset.get("id", ""))) is None
        or source_asset.get("kind") != "source_page"
        or source_asset.get("path") != source_relative
        or source_asset.get("file_sha256") != page.file_sha256
        or source_asset.get("mode") != "RGB"
        or source_asset.get("size_px") != page_size
        or source_asset.get("provenance") != "real_preserved"
        or source_asset.get("storage_root") != "library_root",
        "source_asset_invalid",
        "source_page_asset descriptor is not reproducible",
        sample_id=sample_id,
        path=source_path,
    )

    try:
        bbox = parse_bbox(record.get("bbox_px"), "bbox_px")
        crop_bbox = parse_bbox(record.get("crop_bbox_px"), "crop_bbox_px")
        tight_bbox = parse_bbox(record.get("tight_bbox_px"), "tight_bbox_px")
        context_bbox = parse_bbox(record.get("context_bbox_px"), "context_bbox_px")
    except ValueError as exc:
        issues.add("bbox_invalid", str(exc), sample_id=sample_id)
        return
    page_bbox = (0, 0, page.image.width, page.image.height)
    tight_width = tight_bbox[2] - tight_bbox[0]
    tight_height = tight_bbox[3] - tight_bbox[1]
    expected_context_padding = min(
        context_padding_max,
        max(
            context_padding_min,
            int(round(max(tight_width, tight_height) * context_padding_ratio)),
        ),
    )
    expected_context_bbox = (
        max(0, tight_bbox[0] - expected_context_padding),
        max(0, tight_bbox[1] - expected_context_padding),
        min(page.image.width, tight_bbox[2] + expected_context_padding),
        min(page.image.height, tight_bbox[3] + expected_context_padding),
    )
    add_if(
        issues,
        not bbox_contains(page_bbox, crop_bbox)
        or not bbox_contains(crop_bbox, bbox)
        or not bbox_contains(crop_bbox, tight_bbox)
        or not bbox_contains(page_bbox, context_bbox)
        or not bbox_contains(context_bbox, tight_bbox)
        or context_bbox != expected_context_bbox,
        "bbox_relationship_invalid",
        (
            "page/crop/candidate/tight/context bbox containment or signed "
            "context-padding derivation is invalid"
        ),
        sample_id=sample_id,
    )
    expected_crop_size = [
        crop_bbox[2] - crop_bbox[0],
        crop_bbox[3] - crop_bbox[1],
    ]
    expected_glyph_size = [
        tight_bbox[2] - tight_bbox[0],
        tight_bbox[3] - tight_bbox[1],
    ]
    expected_context_size = [
        context_bbox[2] - context_bbox[0],
        context_bbox[3] - context_bbox[1],
    ]
    bbox_aliases = (
        ("raw_bbox_px", bbox),
        ("source_crop_bbox_px", crop_bbox),
        ("mask_input_bbox_px", crop_bbox),
        ("mask_tight_bbox_px", tight_bbox),
        ("masked_context_bbox_px", context_bbox),
        ("final_bbox_px", context_bbox),
    )
    for field_name, expected_value in bbox_aliases:
        add_if(
            issues,
            record.get(field_name) != list(expected_value),
            "bbox_alias_mismatch",
            f"{field_name} does not match its canonical bbox",
            sample_id=sample_id,
        )
    add_if(
        issues,
        record.get("crop_size_px") != expected_crop_size
        or record.get("glyph_size_px") != expected_glyph_size
        or record.get("masked_letterbox_size_px") != 224,
        "bbox_size_mismatch",
        "crop/glyph/letterbox sizes are inconsistent",
        sample_id=sample_id,
    )

    assets_value = record.get("assets")
    if not isinstance(assets_value, Mapping):
        issues.add(
            "asset_dag_invalid",
            "assets must be an object",
            sample_id=sample_id,
        )
        return
    assets = {
        str(kind): descriptor
        for kind, descriptor in assets_value.items()
        if isinstance(kind, str) and isinstance(descriptor, Mapping)
    }
    expected_kinds = set(REQUIRED_ASSET_KINDS)
    if "deskew_rgba" in assets:
        expected_kinds.add("deskew_rgba")
    add_if(
        issues,
        set(assets) != expected_kinds or len(assets) != len(assets_value),
        "asset_dag_invalid",
        "asset inventory must contain every required kind and only optional deskew",
        sample_id=sample_id,
    )
    if not REQUIRED_ASSET_KINDS.issubset(assets):
        return
    source_asset_id = (
        source_asset.get("id") if isinstance(source_asset, Mapping) else None
    )
    asset_ids = {kind: descriptor.get("id") for kind, descriptor in assets.items()}
    add_if(
        issues,
        any(
            not isinstance(asset_id, str) or ASSET_ID_RE.fullmatch(asset_id) is None
            for asset_id in asset_ids.values()
        )
        or len(set(asset_ids.values())) != len(asset_ids),
        "asset_dag_invalid",
        "asset ids are missing, malformed, or duplicated",
        sample_id=sample_id,
    )
    expected_parents = {
        "raw": [],
        "context": [source_asset_id],
        "mask": [asset_ids.get("raw")],
        "color_mask": [asset_ids.get("raw")],
        "glyph_rgba": [asset_ids.get("raw"), asset_ids.get("mask")],
        "black_on_white": [asset_ids.get("mask")],
        "white_on_black": [asset_ids.get("mask")],
        "outline_fill": [asset_ids.get("mask")],
        "outline_stroke": [asset_ids.get("mask")],
        "outline_outer_ring": [asset_ids.get("mask")],
        "glyph_224": [asset_ids.get("glyph_rgba")],
        "context_224": [asset_ids.get("context")],
    }
    if "deskew_rgba" in assets:
        expected_parents["deskew_rgba"] = [asset_ids.get("glyph_rgba")]

    mask_method = (
        processing.get("mask_method") if isinstance(processing, Mapping) else None
    )
    canonical_transforms: dict[str, dict[str, Any]] = {
        "raw": {
            "operation": "byte_exact_verified_copy",
            "diagnostic_overlay_written": False,
        },
        "context": {
            "operation": "source_context_crop",
            "bbox_px": list(context_bbox),
            "padding_px": expected_context_padding,
        },
        "glyph_rgba": {
            "operation": "source_rgb_with_selected_mask_alpha",
            "tight_bbox_px": list(tight_bbox),
            "mask_method": mask_method,
        },
        "mask": {
            "operation": "tight_selected_binary_mask",
            "mask_method": mask_method,
        },
        "black_on_white": {
            "operation": "binary_polarity_normalization",
            "polarity": "dark",
        },
        "white_on_black": {
            "operation": "binary_polarity_normalization",
            "polarity": "light",
        },
        "color_mask": {
            "operation": "lab_hsv_colour_outlier_mask",
            "lab_delta_e_threshold": 18.0,
            "hsv_saturation_threshold": 0.18,
        },
        "outline_fill": {
            "operation": "binary_erosion_fill",
            "radius_px": 1,
        },
        "outline_stroke": {
            "operation": "mask_minus_eroded_fill",
            "radius_px": 1,
        },
        "outline_outer_ring": {
            "operation": "dilation_annulus",
            "inner_radius_px": 1,
            "outer_radius_px": 2,
            "padding_px": 2,
        },
        "glyph_224": {
            "operation": "aspect_preserving_letterbox",
            "size_px": 224,
            "source": "white_composited_glyph_rgba",
            "background": "white",
        },
        "context_224": {
            "operation": "aspect_preserving_letterbox",
            "size_px": 224,
            "source": "context",
            "background": "white",
        },
    }
    asset_images: dict[str, Image.Image] = {}
    try:
        for kind, descriptor in assets.items():
            if kind not in ASSET_DIRECTORIES:
                issues.add(
                    "asset_dag_invalid",
                    f"unknown/forbidden asset kind: {kind}",
                    sample_id=sample_id,
                )
                continue
            expected_relative = f"{ASSET_DIRECTORIES[kind]}/{split}/{sample_id}.png"
            expected_provenance = (
                "real_preserved" if kind == "raw" else "real_processed"
            )
            expected_parent_sample = parent_id if kind == "raw" else sample_id
            transform = descriptor.get("transform")
            add_if(
                issues,
                descriptor.get("kind") != kind
                or descriptor.get("id") != expected_asset_id(sample_id, kind)
                or descriptor.get("path") != expected_relative,
                "asset_dag_invalid",
                f"{kind} id/kind/path semantics are invalid",
                sample_id=sample_id,
            )
            add_if(
                issues,
                descriptor.get("provenance") != expected_provenance
                or descriptor.get("parent_sample_id") != expected_parent_sample
                or descriptor.get("root_real_id") != root_real_id,
                "asset_provenance_invalid",
                f"{kind} provenance or sample/root parent is invalid",
                sample_id=sample_id,
            )
            expected_parent_ids = expected_parents.get(kind, [])
            add_if(
                issues,
                descriptor.get("parent_asset_ids") != expected_parent_ids
                or descriptor.get("parent_asset_id")
                != (expected_parent_ids[0] if expected_parent_ids else None),
                "asset_dag_invalid",
                f"{kind} parent DAG edge is invalid",
                sample_id=sample_id,
            )
            add_if(
                issues,
                not isinstance(transform, Mapping)
                or (
                    kind != "deskew_rgba"
                    and dict(transform) != canonical_transforms.get(kind)
                )
                or (
                    kind == "deskew_rgba"
                    and (
                        transform.get("operation") != EXPECTED_OPERATIONS[kind]
                        or transform.get("source_geometry_replaced") is not False
                    )
                )
                or has_true_diagnostic_overlay(transform),
                "asset_transform_invalid",
                f"{kind} transform or diagnostic-overlay contract is invalid",
                sample_id=sample_id,
            )
            try:
                pure = safe_relative_path(descriptor.get("path"), f"{kind} path")
                path = resolve_inside(dataset_root, pure, f"{kind} path")
            except ValueError as exc:
                issues.add(
                    "asset_path_invalid",
                    str(exc),
                    sample_id=sample_id,
                )
                continue
            expected_parent_path = (
                dataset_root / ASSET_DIRECTORIES[kind] / str(split)
            ).resolve()
            add_if(
                issues,
                path.parent != expected_parent_path,
                "asset_path_invalid",
                f"{kind} resolves outside its exact training-asset directory",
                sample_id=sample_id,
                path=path,
            )
            image = inspect_asset(path, descriptor, kind, issues, sample_id)
            if image is not None:
                asset_images[kind] = image

        validate_asset_aliases(record, assets, issues, sample_id)
        validate_asset_dimensions(
            asset_images,
            expected_crop_size=expected_crop_size,
            expected_glyph_size=expected_glyph_size,
            expected_context_size=expected_context_size,
            issues=issues,
            sample_id=sample_id,
        )
        validate_asset_pixels(
            record,
            asset_images,
            page.image,
            crop_bbox=crop_bbox,
            tight_bbox=tight_bbox,
            context_bbox=context_bbox,
            context_padding_ratio=context_padding_ratio,
            context_padding_min=context_padding_min,
            context_padding_max=context_padding_max,
            deskew_min_angle=deskew_min_angle,
            deskew_max_angle=deskew_max_angle,
            issues=issues,
            sample_id=sample_id,
        )
    finally:
        for image in asset_images.values():
            image.close()


def validate_asset_aliases(
    record: Mapping[str, Any],
    assets: Mapping[str, Mapping[str, Any]],
    issues: IssueCollector,
    sample_id: str,
) -> None:
    alias_to_kind = {
        "image_path": "raw",
        "raw_image_path": "raw",
        "clip_image_path": "glyph_224",
        "context_image_path": "context",
        "glyph_224_path": "glyph_224",
        "context_224_path": "context_224",
        "glyph_rgba_path": "glyph_rgba",
        "glyph_mask_path": "mask",
        "masked_context_path": "context",
    }
    for alias, kind in alias_to_kind.items():
        add_if(
            issues,
            record.get(alias) != assets[kind].get("path"),
            "asset_alias_mismatch",
            f"{alias} does not point to the canonical {kind} asset",
            sample_id=sample_id,
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
    add_if(
        issues,
        record.get("mask_paths") != expected_paths
        or record.get("final_image_paths") != expected_paths
        or record.get("mask_asset_sha256") != expected_hashes,
        "asset_alias_mismatch",
        "mask/final path or hash alias maps are inconsistent",
        sample_id=sample_id,
    )
    add_if(
        issues,
        record.get("asset_file_sha256")
        != {
            "image_path": assets["raw"].get("file_sha256"),
            "clip_image_path": assets["glyph_224"].get("file_sha256"),
        },
        "asset_alias_mismatch",
        "legacy raw/clip file hash aliases are inconsistent",
        sample_id=sample_id,
    )
    add_if(
        issues,
        assets["raw"].get("pixel_sha256") != record.get("crop_sha256"),
        "asset_alias_mismatch",
        "raw pixel SHA-256 must equal crop_sha256",
        sample_id=sample_id,
    )


def validate_asset_dimensions(
    images: Mapping[str, Image.Image],
    *,
    expected_crop_size: list[int],
    expected_glyph_size: list[int],
    expected_context_size: list[int],
    issues: IssueCollector,
    sample_id: str,
) -> None:
    expected_sizes: dict[str, list[int]] = {
        "raw": expected_crop_size,
        "context": expected_context_size,
        "glyph_rgba": expected_glyph_size,
        "mask": expected_glyph_size,
        "black_on_white": expected_glyph_size,
        "white_on_black": expected_glyph_size,
        "color_mask": expected_glyph_size,
        "outline_fill": expected_glyph_size,
        "outline_stroke": expected_glyph_size,
        "outline_outer_ring": [
            expected_glyph_size[0] + 4,
            expected_glyph_size[1] + 4,
        ],
        "glyph_224": [224, 224],
        "context_224": [224, 224],
    }
    for kind, expected_size in expected_sizes.items():
        image = images.get(kind)
        if image is not None:
            add_if(
                issues,
                [image.width, image.height] != expected_size,
                "asset_semantic_size_invalid",
                f"{kind} size is inconsistent with source bboxes",
                sample_id=sample_id,
            )


def validate_asset_pixels(
    record: Mapping[str, Any],
    images: Mapping[str, Image.Image],
    source_page: Image.Image,
    *,
    crop_bbox: tuple[int, int, int, int],
    tight_bbox: tuple[int, int, int, int],
    context_bbox: tuple[int, int, int, int],
    context_padding_ratio: float,
    context_padding_min: int,
    context_padding_max: int,
    deskew_min_angle: float,
    deskew_max_angle: float,
    issues: IssueCollector,
    sample_id: str,
) -> None:
    required = REQUIRED_ASSET_KINDS
    if not required.issubset(images):
        return
    raw = images["raw"].convert("RGB")
    context = images["context"].convert("RGB")
    source_crop = source_page.crop(crop_bbox).convert("RGB")
    source_context = source_page.crop(context_bbox).convert("RGB")
    try:
        add_if(
            issues,
            not image_arrays_equal(raw, source_crop),
            "raw_source_pixels_mismatch",
            "raw training crop is not pixel-identical to the signed source crop",
            sample_id=sample_id,
        )
        add_if(
            issues,
            not image_arrays_equal(context, source_context),
            "context_source_pixels_mismatch",
            "context asset is not pixel-identical to its signed source bbox",
            sample_id=sample_id,
        )
    finally:
        raw.close()
        context.close()
        source_crop.close()
        source_context.close()

    mask_array = np.asarray(images["mask"], dtype=np.uint8)
    color_array = np.asarray(images["color_mask"], dtype=np.uint8)
    fill_array = np.asarray(images["outline_fill"], dtype=np.uint8)
    stroke_array = np.asarray(images["outline_stroke"], dtype=np.uint8)
    outer_array = np.asarray(images["outline_outer_ring"], dtype=np.uint8)
    binary_arrays = {
        "mask": mask_array,
        "color_mask": color_array,
        "outline_fill": fill_array,
        "outline_stroke": stroke_array,
        "outline_outer_ring": outer_array,
    }
    for kind, values in binary_arrays.items():
        add_if(
            issues,
            not set(np.unique(values).tolist()).issubset({0, 255}),
            "asset_binary_invalid",
            f"{kind} contains non-binary pixels",
            sample_id=sample_id,
        )
    glyph_shape = mask_array.shape
    same_shape_kinds = (
        "color_mask",
        "outline_fill",
        "outline_stroke",
        "black_on_white",
        "white_on_black",
        "glyph_rgba",
    )
    incompatible = any(
        images[kind].size != (glyph_shape[1], glyph_shape[0])
        for kind in same_shape_kinds
    )
    incompatible = incompatible or images["outline_outer_ring"].size != (
        glyph_shape[1] + 4,
        glyph_shape[0] + 4,
    )
    if incompatible:
        issues.add(
            "asset_semantic_size_invalid",
            "mask-derived assets do not share the required semantic dimensions",
            sample_id=sample_id,
        )
        return
    mask_bool = mask_array == 255
    add_if(
        issues,
        not bool(mask_bool.any()),
        "mask_empty",
        "binary glyph mask is empty",
        sample_id=sample_id,
    )
    if mask_bool.any():
        touches = (
            bool(mask_bool[0, :].any())
            and bool(mask_bool[-1, :].any())
            and bool(mask_bool[:, 0].any())
            and bool(mask_bool[:, -1].any())
        )
        add_if(
            issues,
            not touches,
            "mask_not_tight",
            "mask does not touch every edge of its declared tight bbox",
            sample_id=sample_id,
        )
    expected_fill = binary_erode(mask_bool, 1)
    expected_stroke = mask_bool & ~expected_fill
    padded_mask = np.pad(mask_bool, 2, mode="constant", constant_values=False)
    expected_outer = binary_dilate(padded_mask, 2) & ~binary_dilate(padded_mask, 1)
    add_if(
        issues,
        not np.array_equal(fill_array == 255, expected_fill)
        or not np.array_equal(stroke_array == 255, expected_stroke),
        "outline_partition_invalid",
        "outline fill/stroke are not the exact radius-1 mask transforms",
        sample_id=sample_id,
    )
    add_if(
        issues,
        not np.array_equal(outer_array == 255, expected_outer),
        "outer_ring_invalid",
        "outer ring is not the exact padded radius-1/2 dilation annulus",
        sample_id=sample_id,
    )
    mask_stats = record.get("mask_stats")
    style_metrics = record.get("style_metrics")
    if isinstance(mask_stats, Mapping) and isinstance(style_metrics, Mapping):
        try:
            inverse_likelihood = round(
                max(
                    0.0,
                    (
                        float(mask_stats["mean_ink_luminance"])
                        - float(mask_stats["background_luminance"])
                    )
                    / 255.0,
                ),
                8,
            )
        except (KeyError, TypeError, ValueError):
            inverse_likelihood = None
            issues.add(
                "style_metrics_invalid",
                "mask_stats luminance fields are missing or nonnumeric",
                sample_id=sample_id,
            )
        fill_pixels = int(expected_fill.sum())
        stroke_pixels = int(expected_stroke.sum())
        outer_pixels = int(expected_outer.sum())
        expected_style_metrics = {
            "inverse_likelihood": inverse_likelihood,
            "color_mask_overlap_ratio": round(
                int(np.logical_and(color_array == 255, mask_bool).sum())
                / max(1, int(mask_bool.sum())),
                8,
            ),
            "outline_fill_pixels": fill_pixels,
            "outline_stroke_pixels": stroke_pixels,
            "outline_outer_ring_pixels": outer_pixels,
            "outline_structure_ratio": round(
                stroke_pixels / max(1, fill_pixels + stroke_pixels),
                8,
            ),
        }
        add_if(
            issues,
            dict(style_metrics) != expected_style_metrics,
            "style_metrics_invalid",
            "style metrics are not reproducible from mask/style assets",
            sample_id=sample_id,
        )
    else:
        issues.add(
            "style_metrics_invalid",
            "mask_stats/style_metrics must be objects",
            sample_id=sample_id,
        )

    black_on_white = np.asarray(images["black_on_white"], dtype=np.uint8)
    white_on_black = np.asarray(images["white_on_black"], dtype=np.uint8)
    expected_bow = np.full((*mask_bool.shape, 3), 255, dtype=np.uint8)
    expected_bow[mask_bool] = 0
    expected_wob = np.zeros((*mask_bool.shape, 3), dtype=np.uint8)
    expected_wob[mask_bool] = 255
    add_if(
        issues,
        not np.array_equal(black_on_white, expected_bow)
        or not np.array_equal(white_on_black, expected_wob),
        "polarity_pixels_invalid",
        "black/white polarity assets are not exact transforms of the mask",
        sample_id=sample_id,
    )

    glyph = images["glyph_rgba"].convert("RGBA")
    glyph_array = np.asarray(glyph, dtype=np.uint8)
    crop_x1, crop_y1, _, _ = crop_bbox
    tx1 = tight_bbox[0] - crop_x1
    ty1 = tight_bbox[1] - crop_y1
    tx2 = tight_bbox[2] - crop_x1
    ty2 = tight_bbox[3] - crop_y1
    raw_rgb = images["raw"].convert("RGB")
    raw_tight = np.asarray(raw_rgb, dtype=np.uint8)[ty1:ty2, tx1:tx2]
    add_if(
        issues,
        not np.array_equal(glyph_array[..., 3], mask_array)
        or bool((glyph_array[~mask_bool, :3] != 0).any())
        or (
            glyph_array.shape[:2] == raw_tight.shape[:2]
            and bool((glyph_array[mask_bool, :3] != raw_tight[mask_bool]).any())
        ),
        "glyph_rgba_semantics_invalid",
        "RGBA alpha/RGB pixels do not preserve the original masked glyph",
        sample_id=sample_id,
    )
    white = Image.new("RGBA", glyph.size, (255, 255, 255, 255))
    composite = Image.alpha_composite(white, glyph).convert("RGB")
    expected_glyph_224 = expected_letterbox(composite)
    expected_context_224 = expected_letterbox(images["context"])
    try:
        add_if(
            issues,
            record.get("glyph_white_composite_sha256") != pixel_sha256(composite),
            "glyph_composite_hash_mismatch",
            "glyph_white_composite_sha256 is not reproducible",
            sample_id=sample_id,
        )
        add_if(
            issues,
            not image_arrays_equal(expected_glyph_224, images["glyph_224"]),
            "glyph_224_semantics_invalid",
            "style-preserving glyph_224 is not the canonical white letterbox",
            sample_id=sample_id,
        )
        add_if(
            issues,
            not image_arrays_equal(expected_context_224, images["context_224"]),
            "context_224_semantics_invalid",
            "context_224 is not the canonical source-context letterbox",
            sample_id=sample_id,
        )
    finally:
        raw_rgb.close()
        white.close()
        glyph.close()
        composite.close()
        expected_glyph_224.close()
        expected_context_224.close()

    orientation = str(record.get("orientation", "horizontal"))
    expected_delta, expected_deskew_metadata = estimate_deskew_angle(
        mask_bool,
        orientation,
        minimum_angle=deskew_min_angle,
        maximum_angle=deskew_max_angle,
    )
    processing = record.get("processing")
    add_if(
        issues,
        not isinstance(processing, Mapping)
        or processing.get("deskew") != expected_deskew_metadata,
        "deskew_semantics_invalid",
        "processing deskew metadata is not reproducible from the glyph mask",
        sample_id=sample_id,
    )
    assets = record.get("assets")
    descriptor = assets.get("deskew_rgba") if isinstance(assets, Mapping) else None
    add_if(
        issues,
        (expected_delta is None) != (descriptor is None),
        "deskew_semantics_invalid",
        "optional deskew asset presence disagrees with the signed thresholds",
        sample_id=sample_id,
    )
    if expected_delta is not None and isinstance(descriptor, Mapping):
        transform = descriptor.get("transform")
        expected_transform = {
            "operation": "auxiliary_deskew",
            "rotation_degrees": round(-expected_delta, 6),
            "source_geometry_replaced": False,
            **expected_deskew_metadata,
        }
        add_if(
            issues,
            not isinstance(transform, Mapping) or dict(transform) != expected_transform,
            "deskew_semantics_invalid",
            "deskew transform metadata is not canonical",
            sample_id=sample_id,
        )
        deskew_image = images.get("deskew_rgba")
        if deskew_image is not None:
            source_glyph = images["glyph_rgba"].convert("RGBA")
            rotated = source_glyph.rotate(
                -expected_delta,
                resample=Image.Resampling.BICUBIC,
                expand=True,
                fillcolor=(0, 0, 0, 0),
            )
            rotated_pixels = np.asarray(rotated, dtype=np.uint8).copy()
            rotated_pixels[rotated_pixels[..., 3] == 0, :3] = 0
            expected_deskew = Image.fromarray(rotated_pixels)
            try:
                add_if(
                    issues,
                    not image_arrays_equal(expected_deskew, deskew_image),
                    "deskew_semantics_invalid",
                    "deskew RGBA pixels are not reproducible from glyph_rgba",
                    sample_id=sample_id,
                )
            finally:
                source_glyph.close()
                rotated.close()
                expected_deskew.close()


def validate_reject_contract(
    reject: Mapping[str, Any],
    *,
    library_root: Path,
    page_cache: SourcePageCache,
    upstream_binding: Mapping[str, Any] | None,
    issues: IssueCollector,
) -> None:
    parent_id = reject.get("parent_id")
    sample_id = parent_id if isinstance(parent_id, str) else ""
    add_if(
        issues,
        reject.get("schema_version") != SCHEMA_VERSION
        or not sample_id
        or reject.get("id") != sample_id
        or reject.get("provenance") != "real_mined"
        or reject.get("synthetic") is not False,
        "reject_contract_invalid",
        "reject identity/schema/provenance is invalid",
        sample_id=sample_id,
    )
    add_if(
        issues,
        not isinstance(reject.get("split"), str)
        or reject.get("split") not in ALLOWED_SPLITS
        or valid_sha256(reject.get("parent_record_sha256")) is None
        or isinstance(reject.get("input_line_number"), bool)
        or not isinstance(reject.get("input_line_number"), int)
        or int(reject.get("input_line_number", 0)) < 1,
        "reject_contract_invalid",
        "reject split, parent hash, or input line is invalid",
        sample_id=sample_id,
    )
    reasons = reject.get("failure_reasons")
    add_if(
        issues,
        not isinstance(reasons, list)
        or not reasons
        or any(not isinstance(reason, str) or not reason for reason in reasons)
        or reasons != sorted(set(reasons))
        or not isinstance(reject.get("stage"), str)
        or not reject.get("stage"),
        "reject_contract_invalid",
        "reject stage/failure_reasons are absent or noncanonical",
        sample_id=sample_id,
    )
    try:
        safe_component(reject.get("work_id"), "work_id")
        safe_component(reject.get("chapter_id"), "chapter_id")
        safe_component(reject.get("page_id"), "page_id")
        source_relative, source_path = strict_source_relative(reject, library_root)
        bbox = parse_bbox(reject.get("bbox_px"), "bbox_px")
        crop_bbox = parse_bbox(reject.get("crop_bbox_px"), "crop_bbox_px")
        page = page_cache.get(source_relative)
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        issues.add(
            "reject_source_invalid",
            str(exc),
            sample_id=sample_id,
            path=reject.get("source_image_path"),
        )
        return
    page_bbox = (0, 0, page.image.width, page.image.height)
    add_if(
        issues,
        not bbox_contains(page_bbox, crop_bbox) or not bbox_contains(crop_bbox, bbox),
        "reject_bbox_invalid",
        "reject bbox/crop does not fit the original source page",
        sample_id=sample_id,
        path=source_path,
    )
    if upstream_binding is None:
        issues.add(
            "reject_source_signature_mismatch",
            "reject has no signed upstream source binding",
            sample_id=sample_id,
            path=source_path,
        )
        return
    content_signature = upstream_binding.get("source_page_content_signature")
    add_if(
        issues,
        upstream_binding.get("source_page_sha256") != page.file_sha256
        or not isinstance(content_signature, Mapping)
        or content_signature.get("sha256") != page.file_sha256
        or content_signature.get("size") != page.size_bytes
        or content_signature.get("width") != page.image.width
        or content_signature.get("height") != page.image.height
        or upstream_binding.get("page_size_px")
        != [page.image.width, page.image.height],
        "reject_source_signature_mismatch",
        "reject-only source page hash, size, or dimensions changed",
        sample_id=sample_id,
        path=source_path,
    )


def validate_upstream_bindings(
    signature: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    issues: IssueCollector,
) -> dict[str, dict[str, Any]]:
    manifest_value = signature.get("manifest")
    if not isinstance(manifest_value, str):
        return {}
    manifest_path = Path(manifest_value).expanduser().resolve()
    if not manifest_path.is_file():
        return {}
    upstream = read_jsonl(
        manifest_path,
        issues,
        missing_code="signed_input_manifest_missing",
        invalid_code="signed_input_manifest_invalid",
    )
    binding_fields = (
        "work_id",
        "chapter_id",
        "page_id",
        "split",
        "source_image_path",
        "bbox_px",
        "crop_bbox_px",
        "crop_sha256",
        "orientation",
        "root_real_id",
        "asset_file_sha256",
        "source_page_sha256",
        "source_page_content_signature",
        "page_size_px",
    )
    by_id: dict[str, dict[str, Any]] = {}
    for row in upstream:
        row_id = row.get("id")
        if not isinstance(row_id, str) or not row_id:
            issues.add(
                "upstream_binding_invalid",
                "hard-candidate input row has no id",
                path=manifest_path,
            )
            continue
        if row_id in by_id:
            issues.add(
                "upstream_binding_duplicate",
                "hard-candidate input id is duplicated",
                sample_id=row_id,
                path=manifest_path,
            )
        by_id[row_id] = {
            "row_sha256": sha256_json(row),
            **{field_name: row.get(field_name) for field_name in binding_fields},
        }
    upstream_count = len(upstream)
    del upstream
    observed: list[str] = []
    shared_fields = binding_fields[:7]
    for row in [*records, *rejects]:
        parent_id = row.get("parent_id")
        if not isinstance(parent_id, str):
            continue
        observed.append(parent_id)
        parent = by_id.get(parent_id)
        if parent is None:
            issues.add(
                "upstream_binding_missing",
                "processed/rejected parent is absent from signed input manifest",
                sample_id=parent_id,
            )
            continue
        parent_source_signature = parent.get("source_page_content_signature")
        parent_page_size = parent.get("page_size_px")
        add_if(
            issues,
            not isinstance(parent_source_signature, Mapping)
            or parent_source_signature.get("sha256") != parent.get("source_page_sha256")
            or isinstance(parent_source_signature.get("size"), bool)
            or not isinstance(parent_source_signature.get("size"), int)
            or parent_source_signature.get("size", 0) <= 0
            or not isinstance(parent_page_size, list)
            or len(parent_page_size) != 2
            or parent_source_signature.get("width") != parent_page_size[0]
            or parent_source_signature.get("height") != parent_page_size[1],
            "upstream_binding_mismatch",
            "signed input source content signature is internally invalid",
            sample_id=parent_id,
        )
        add_if(
            issues,
            row.get("parent_record_sha256") != parent.get("row_sha256")
            or any(row.get(field) != parent.get(field) for field in shared_fields),
            "upstream_binding_mismatch",
            "processed/rejected row no longer matches its signed input row",
            sample_id=parent_id,
        )
        if row.get("provenance") == "real_processed":
            expected_root_real_id = parent.get("root_real_id") or parent_id
            assets = row.get("assets")
            raw_descriptor = assets.get("raw") if isinstance(assets, Mapping) else None
            upstream_asset_hashes = parent.get("asset_file_sha256")
            upstream_raw_file_sha = (
                upstream_asset_hashes.get("image_path")
                if isinstance(upstream_asset_hashes, Mapping)
                else None
            )
            add_if(
                issues,
                row.get("crop_sha256") != parent.get("crop_sha256")
                or row.get("orientation") != parent.get("orientation")
                or row.get("source_page_sha256") != parent.get("source_page_sha256")
                or row.get("page_size_px") != parent.get("page_size_px")
                or row.get("root_real_id") != expected_root_real_id
                or row.get("variant_group_id") != expected_root_real_id
                or not isinstance(raw_descriptor, Mapping)
                or raw_descriptor.get("file_sha256") != upstream_raw_file_sha,
                "upstream_binding_mismatch",
                (
                    "processed crop/orientation/root lineage or byte-exact raw "
                    "file differs from its signed input"
                ),
                sample_id=parent_id,
            )
    add_if(
        issues,
        upstream_count != len(observed) or set(by_id) != set(observed),
        "upstream_coverage_mismatch",
        "processed and rejected rows do not cover signed input exactly once",
        path=manifest_path,
    )
    return by_id


def validate_checkpoint_contract(
    dataset_root: Path,
    *,
    marker_signature_sha: str | None,
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    expected_count: Any,
    issues: IssueCollector,
) -> None:
    state_dir = dataset_root / STATE_DIR_NAME
    if not state_dir.is_dir():
        issues.add(
            "checkpoint_state_missing",
            "postprocess checkpoint directory is missing",
            path=state_dir,
        )
        return
    state_files = sorted(
        (path for path in state_dir.iterdir() if path.is_file()),
        key=lambda path: path.name,
    )
    add_if(
        issues,
        any(path.suffix.lower() != ".json" for path in state_files),
        "checkpoint_state_invalid",
        "checkpoint directory contains non-JSON files",
        path=state_dir,
    )
    json_files = [path for path in state_files if path.suffix.lower() == ".json"]
    add_if(
        issues,
        not isinstance(expected_count, int)
        or isinstance(expected_count, bool)
        or expected_count != len(json_files),
        "checkpoint_count_mismatch",
        "completed_page_shards does not match checkpoint files",
        path=state_dir,
    )
    manifest_rows = {
        row.get("id"): sha256_json(row)
        for row in records
        if isinstance(row.get("id"), str)
    }
    reject_rows = {
        row.get("parent_id"): sha256_json(row)
        for row in rejects
        if isinstance(row.get("parent_id"), str)
    }
    seen_records: Counter[str] = Counter()
    seen_rejects: Counter[str] = Counter()
    seen_page_keys: set[str] = set()
    for path in json_files:
        payload = read_json_object(path, issues, "checkpoint_state_invalid")
        if not payload:
            continue
        page_key = payload.get("page_key")
        bindings = payload.get("input_bindings")
        checkpoint_records = payload.get("records")
        checkpoint_rejects = payload.get("rejects")
        if (
            not isinstance(page_key, str)
            or not page_key
            or not isinstance(bindings, list)
            or not isinstance(checkpoint_records, list)
            or not isinstance(checkpoint_rejects, list)
        ):
            issues.add(
                "checkpoint_state_invalid",
                "checkpoint core fields are missing",
                path=path,
            )
            continue
        expected_name = sha256_bytes(page_key.encode("utf-8")) + path.suffix.lower()
        add_if(
            issues,
            path.name != expected_name or page_key in seen_page_keys,
            "checkpoint_identity_invalid",
            "checkpoint filename/page_key is invalid or duplicated",
            path=path,
        )
        seen_page_keys.add(page_key)
        add_if(
            issues,
            payload.get("tool") != POSTPROCESS_TOOL_ID
            or payload.get("schema_version") != SCHEMA_VERSION
            or payload.get("signature_sha256") != marker_signature_sha
            or payload.get("input_binding_sha256") != sha256_json(bindings),
            "checkpoint_signature_invalid",
            "checkpoint tool/signature/input binding hash is invalid",
            path=path,
        )
        core = {
            "signature_sha256": payload.get("signature_sha256"),
            "page_key": page_key,
            "input_bindings": bindings,
            "input_binding_sha256": payload.get("input_binding_sha256"),
            "source_page_sha256": payload.get("source_page_sha256"),
            "records": checkpoint_records,
            "rejects": checkpoint_rejects,
        }
        add_if(
            issues,
            payload.get("checkpoint_sha256") != sha256_json(core),
            "checkpoint_signature_invalid",
            "checkpoint core hash is invalid",
            path=path,
        )
        binding_ids: list[str] = []
        for binding in bindings:
            if not isinstance(binding, Mapping) or not isinstance(
                binding.get("id"), str
            ):
                issues.add(
                    "checkpoint_binding_invalid",
                    "checkpoint input binding lacks an id",
                    path=path,
                )
                continue
            binding_ids.append(str(binding["id"]))
        page_parent_ids: list[str] = []
        for row in checkpoint_records:
            if not isinstance(row, Mapping):
                issues.add(
                    "checkpoint_record_invalid",
                    "checkpoint records contains a non-object",
                    path=path,
                )
                continue
            row_id = row.get("id")
            parent_id = row.get("parent_id")
            if isinstance(row_id, str):
                seen_records[row_id] += 1
                add_if(
                    issues,
                    manifest_rows.get(row_id) != sha256_json(row),
                    "checkpoint_record_mismatch",
                    "checkpoint record differs from manifest.jsonl",
                    sample_id=row_id,
                    path=path,
                )
            if isinstance(parent_id, str):
                page_parent_ids.append(parent_id)
        for row in checkpoint_rejects:
            if not isinstance(row, Mapping):
                issues.add(
                    "checkpoint_reject_invalid",
                    "checkpoint rejects contains a non-object",
                    path=path,
                )
                continue
            parent_id = row.get("parent_id")
            if isinstance(parent_id, str):
                seen_rejects[parent_id] += 1
                page_parent_ids.append(parent_id)
                add_if(
                    issues,
                    reject_rows.get(parent_id) != sha256_json(row),
                    "checkpoint_reject_mismatch",
                    "checkpoint reject differs from rejects.jsonl",
                    sample_id=parent_id,
                    path=path,
                )
        add_if(
            issues,
            len(binding_ids) != len(set(binding_ids))
            or sorted(binding_ids) != sorted(page_parent_ids),
            "checkpoint_coverage_mismatch",
            "checkpoint bindings do not cover page outputs exactly once",
            path=path,
        )
    add_if(
        issues,
        seen_records != Counter(manifest_rows.keys()),
        "checkpoint_coverage_mismatch",
        "checkpoint union does not cover every processed id exactly once",
        path=state_dir,
    )
    add_if(
        issues,
        seen_rejects != Counter(reject_rows.keys()),
        "checkpoint_coverage_mismatch",
        "checkpoint union does not cover every rejected parent exactly once",
        path=state_dir,
    )


def validate_report_aggregates(
    dataset_root: Path,
    report: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    *,
    manifest_sha: str,
    rejects_sha: str,
    synthetic_spec_sha: str,
    issues: IssueCollector,
) -> None:
    outputs = report.get("outputs")
    if isinstance(outputs, Mapping):
        expected_hashes = {
            "manifest_sha256": manifest_sha,
            "rejects_sha256": rejects_sha,
            "synthetic_provenance_spec_sha256": synthetic_spec_sha,
        }
        for key, expected in expected_hashes.items():
            add_if(
                issues,
                outputs.get(key) != expected,
                "report_hash_mismatch",
                f"report {key} does not match output bytes",
                path=dataset_root / REPORT_NAME,
            )
    descriptors = [
        descriptor
        for record in records
        if isinstance(record.get("assets"), Mapping)
        for descriptor in record["assets"].values()
        if isinstance(descriptor, Mapping)
    ]
    encoded_asset_bytes = 0
    for descriptor in descriptors:
        size_value = descriptor.get("file_size_bytes")
        if (
            isinstance(size_value, bool)
            or not isinstance(size_value, int)
            or size_value < 0
        ):
            issues.add(
                "asset_file_size_invalid",
                "asset descriptor file_size_bytes must be a non-negative integer",
                sample_id=(
                    str(descriptor.get("parent_sample_id"))
                    if descriptor.get("parent_sample_id") is not None
                    else None
                ),
                path=descriptor.get("path"),
            )
            continue
        encoded_asset_bytes += size_value
    add_if(
        issues,
        report.get("processed_records") != len(records)
        or report.get("rejected_records") != len(rejects)
        or report.get("input_rows") != len(records) + len(rejects)
        or report.get("encoded_asset_files") != len(descriptors)
        or report.get("encoded_asset_bytes") != encoded_asset_bytes,
        "report_count_mismatch",
        "report record/asset counts do not match exhaustive manifests",
    )
    page_paths = {str(row.get("source_image_path")) for row in [*records, *rejects]}
    add_if(
        issues,
        report.get("source_pages") != len(page_paths),
        "report_count_mismatch",
        "report source_pages does not match unique source paths",
    )
    processed_pages = report.get("processed_pages_this_run")
    resumed_pages = report.get("resumed_pages_this_run")
    add_if(
        issues,
        not isinstance(processed_pages, int)
        or isinstance(processed_pages, bool)
        or not isinstance(resumed_pages, int)
        or isinstance(resumed_pages, bool)
        or processed_pages + resumed_pages != len(page_paths),
        "report_count_mismatch",
        "processed+resumed page counts do not cover every source page",
    )

    def counter_by(field_name: str) -> dict[str, int]:
        return dict(
            sorted(Counter(str(row.get(field_name, "")) for row in records).items())
        )

    methods = Counter()
    quality = Counter()
    categories = Counter()
    failures = Counter()
    for record in records:
        processing = record.get("processing")
        if isinstance(processing, Mapping):
            methods[str(processing.get("mask_method"))] += 1
        quality_value = record.get("quality")
        if isinstance(quality_value, Mapping):
            quality[str(quality_value.get("status"))] += 1
            quality_reasons = quality_value.get("failure_reasons")
            if isinstance(quality_reasons, list):
                failures.update(str(item) for item in quality_reasons)
        metadata = record.get("candidate_metadata")
        if isinstance(metadata, Mapping) and isinstance(
            metadata.get("categories"), list
        ):
            categories.update(str(item) for item in metadata["categories"])
    for reject in rejects:
        if isinstance(reject.get("failure_reasons"), list):
            failures.update(str(item) for item in reject["failure_reasons"])
    expected_maps = {
        "by_mask_method": dict(sorted(methods.items())),
        "by_quality_status": dict(sorted(quality.items())),
        "by_split": counter_by("split"),
        "by_work": counter_by("work_id"),
        "category_memberships": dict(sorted(categories.items())),
        "failure_reasons": dict(sorted(failures.items())),
    }
    for field_name, expected in expected_maps.items():
        add_if(
            issues,
            report.get(field_name) != expected,
            "report_distribution_mismatch",
            f"report {field_name} is not reproducible",
        )


def validate_global_contracts(
    records: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    issues: IssueCollector,
) -> None:
    processed_ids = [
        str(row.get("id")) for row in records if isinstance(row.get("id"), str)
    ]
    parent_ids = [
        str(row.get("parent_id"))
        for row in [*records, *rejects]
        if isinstance(row.get("parent_id"), str)
    ]
    reject_ids = [
        str(row.get("id")) for row in rejects if isinstance(row.get("id"), str)
    ]
    add_if(
        issues,
        len(processed_ids) != len(records)
        or len(processed_ids) != len(set(processed_ids)),
        "processed_id_duplicate",
        "processed manifest contains missing, non-string, or duplicate ids",
    )
    add_if(
        issues,
        len(parent_ids) != len(records) + len(rejects)
        or len(parent_ids) != len(set(parent_ids)),
        "parent_coverage_duplicate",
        (
            "a signed parent is missing/non-string or appears more than once "
            "across processed/rejected outputs"
        ),
    )
    add_if(
        issues,
        len(reject_ids) != len(rejects) or len(reject_ids) != len(set(reject_ids)),
        "reject_id_duplicate",
        "reject manifest contains missing, non-string, or duplicate ids",
    )
    add_if(
        issues,
        bool(set(processed_ids).intersection(parent_ids)),
        "lineage_namespace_collision",
        "processed ids collide with real-mined parent ids",
    )
    input_lines = [row.get("input_line_number") for row in [*records, *rejects]]
    add_if(
        issues,
        any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in input_lines
        )
        or sorted(input_lines) != list(range(1, len(input_lines) + 1)),
        "input_line_coverage_mismatch",
        "input_line_number values do not cover 1..N exactly once",
    )

    work_chapters: defaultdict[str, set[str]] = defaultdict(set)
    work_splits: defaultdict[str, set[str]] = defaultdict(set)
    root_splits: defaultdict[str, set[str]] = defaultdict(set)
    for row in [*records, *rejects]:
        work_id = str(row.get("work_id", ""))
        work_chapters[work_id].add(str(row.get("chapter_id", "")))
        work_splits[work_id].add(str(row.get("split", "")))
    for row in records:
        root_splits[str(row.get("root_real_id", ""))].add(str(row.get("split", "")))
    for work_id, chapters in sorted(work_chapters.items()):
        add_if(
            issues,
            len(chapters) > MAX_CHAPTERS_PER_WORK,
            "max_chapters_per_work_exceeded",
            f"work {work_id!r} uses {len(chapters)} chapters; maximum is 20",
        )
    for work_id, splits in sorted(work_splits.items()):
        add_if(
            issues,
            len(splits) != 1 or not splits.issubset(ALLOWED_SPLITS),
            "work_split_not_unique",
            f"work {work_id!r} spans multiple or invalid splits",
        )
    for root_real_id, splits in sorted(root_splits.items()):
        add_if(
            issues,
            len(splits) != 1,
            "variant_split_not_unique",
            f"root_real_id {root_real_id!r} spans multiple splits",
        )


def validate_synthetic_spec(
    path: Path,
    spec: Mapping[str, Any],
    issues: IssueCollector,
) -> None:
    glyph_policy = spec.get("korean_glyph_policy")
    add_if(
        issues,
        spec.get("schema_version") != SCHEMA_VERSION
        or spec.get("status") != "design_only"
        or spec.get("generated_by_this_tool") is not False
        or spec.get("required_provenance") != "synthetic_composite"
        or not isinstance(glyph_policy, Mapping)
        or glyph_policy.get("generative_glyphs_forbidden") is not True,
        "synthetic_spec_invalid",
        "synthetic provenance spec does not segregate generated composites",
        path=path,
    )


def validate_dataset(
    dataset_root: Path,
    library_root: Path,
    issues: IssueCollector,
    *,
    shard_index: int,
    shard_count: int,
) -> ValidationResult:
    marker_path = dataset_root / MARKER_NAME
    manifest_path = dataset_root / MANIFEST_NAME
    rejects_path = dataset_root / REJECTS_NAME
    report_path = dataset_root / REPORT_NAME
    synthetic_path = dataset_root / SYNTHETIC_SPEC_NAME
    marker = read_json_object(marker_path, issues, "marker_missing_or_invalid")
    report = read_json_object(report_path, issues, "report_missing_or_invalid")
    synthetic_spec = read_json_object(
        synthetic_path,
        issues,
        "synthetic_spec_missing_or_invalid",
    )
    records = read_jsonl(
        manifest_path,
        issues,
        missing_code="manifest_missing",
        invalid_code="manifest_invalid",
    )
    rejects = read_jsonl(
        rejects_path,
        issues,
        missing_code="rejects_missing",
        invalid_code="rejects_invalid",
    )
    manifest_sha = sha256_file(manifest_path) if manifest_path.is_file() else ""
    rejects_sha = sha256_file(rejects_path) if rejects_path.is_file() else ""
    report_sha = sha256_file(report_path) if report_path.is_file() else ""
    marker_sha = sha256_file(marker_path) if marker_path.is_file() else ""
    synthetic_sha = sha256_file(synthetic_path) if synthetic_path.is_file() else ""
    (
        marker_signature_sha,
        derivation_signature_sha,
        processor_source_sha,
    ) = validate_marker_and_report(
        dataset_root,
        library_root,
        marker,
        report,
        issues,
    )
    validate_synthetic_spec(synthetic_path, synthetic_spec, issues)
    validate_report_aggregates(
        dataset_root,
        report,
        records,
        rejects,
        manifest_sha=manifest_sha,
        rejects_sha=rejects_sha,
        synthetic_spec_sha=synthetic_sha,
        issues=issues,
    )
    validate_global_contracts(records, rejects, issues)
    signature = marker.get("signature")
    upstream_bindings: dict[str, dict[str, Any]] = {}
    configuration = (
        signature.get("configuration") if isinstance(signature, Mapping) else None
    )
    try:
        if not isinstance(configuration, Mapping):
            raise TypeError("configuration is not an object")
        context_padding_ratio = float(configuration["context_padding_ratio"])
        context_padding_min = int(configuration["context_padding_min"])
        context_padding_max = int(configuration["context_padding_max"])
        deskew_min_angle = float(configuration["deskew_min_angle"])
        deskew_max_angle = float(configuration["deskew_max_angle"])
        if (
            not 0.0 <= context_padding_ratio <= 2.0
            or context_padding_min < 0
            or context_padding_max < context_padding_min
            or deskew_min_angle < 0.0
            or deskew_max_angle < deskew_min_angle
            or deskew_max_angle > 45.0
        ):
            raise ValueError("configuration values are out of range")
    except (KeyError, TypeError, ValueError):
        issues.add(
            "marker_signature_contract_invalid",
            "run signature has invalid context/deskew configuration",
        )
        context_padding_ratio = 0.35
        context_padding_min = 6
        context_padding_max = 64
        deskew_min_angle = 2.0
        deskew_max_angle = 25.0
    if isinstance(signature, Mapping):
        upstream_bindings = validate_upstream_bindings(
            signature,
            records,
            rejects,
            issues,
        )

    page_cache = SourcePageCache(library_root)
    try:
        for record in records:
            sample_id = record.get("id")
            if not isinstance(sample_id, str) or (
                shard_bucket(sample_id, shard_count) != shard_index
            ):
                continue
            validate_record_contract(
                record,
                dataset_root=dataset_root,
                library_root=library_root,
                page_cache=page_cache,
                marker_signature_sha=marker_signature_sha,
                derivation_signature_sha=derivation_signature_sha,
                processor_source_sha=processor_source_sha,
                context_padding_ratio=context_padding_ratio,
                context_padding_min=context_padding_min,
                context_padding_max=context_padding_max,
                deskew_min_angle=deskew_min_angle,
                deskew_max_angle=deskew_max_angle,
                issues=issues,
            )
        for reject in rejects:
            parent_id = reject.get("parent_id")
            if not isinstance(parent_id, str) or (
                shard_bucket(parent_id, shard_count) != shard_index
            ):
                continue
            validate_reject_contract(
                reject,
                library_root=library_root,
                page_cache=page_cache,
                upstream_binding=upstream_bindings.get(parent_id),
                issues=issues,
            )
    finally:
        page_cache.close()
    validate_checkpoint_contract(
        dataset_root,
        marker_signature_sha=marker_signature_sha,
        records=records,
        rejects=rejects,
        expected_count=report.get("completed_page_shards"),
        issues=issues,
    )
    global_ids = [
        str(record["id"]) for record in records if isinstance(record.get("id"), str)
    ]
    return ValidationResult(
        records=records,
        rejects=rejects,
        marker=marker,
        report=report,
        manifest_sha256=manifest_sha,
        rejects_sha256=rejects_sha,
        report_sha256=report_sha,
        marker_sha256=marker_sha,
        synthetic_spec_sha256=synthetic_sha,
        global_ids=global_ids,
    )


def shard_bucket(sample_id: str, shard_count: int) -> int:
    digest = hashlib.sha256(
        f"{SHARD_HASH_NAMESPACE}\0{sample_id}".encode("utf-8")
    ).hexdigest()
    return int(digest[:16], 16) % shard_count


def record_order_key(record: Mapping[str, Any]) -> tuple[Any, ...]:
    bbox_value = record.get("tight_bbox_px") or record.get("bbox_px")
    try:
        bbox = parse_bbox(bbox_value, "audit bbox")
    except ValueError:
        bbox = (0, 0, 0, 0)
    return (
        str(record.get("work_id", "")).casefold(),
        str(record.get("chapter_id", "")).casefold(),
        str(record.get("source_image_path", "")).casefold(),
        bbox,
        str(record.get("tier", "")).casefold(),
        str(record.get("orientation", "")).casefold(),
        str(record.get("id", "")),
    )


def shard_tag(shard_index: int, shard_count: int) -> str:
    if shard_count == 1:
        return "all"
    return f"shard-{shard_index:03d}-of-{shard_count:03d}"


def report_name_for_shard(shard_index: int, shard_count: int) -> str:
    if shard_count == 1:
        return "hard_dataset_qa_report.json"
    return f"hard_dataset_qa_report_{shard_tag(shard_index, shard_count)}.json"


def state_name_for_shard(shard_index: int, shard_count: int) -> str:
    if shard_count == 1:
        return "audit_state.json"
    return f"audit_state_{shard_tag(shard_index, shard_count)}.json"


def audit_csv_name_for_shard(shard_index: int, shard_count: int) -> str:
    if shard_count == 1:
        return "audit_sample.csv"
    return f"audit_sample_{shard_tag(shard_index, shard_count)}.csv"


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.stem}-",
        suffix=path.suffix,
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def csv_cell(value: Any) -> str:
    if isinstance(value, (dict, list, tuple)):
        return canonical_json(value)
    return "" if value is None else str(value)


def csv_bytes(
    fieldnames: Sequence[str],
    rows: Sequence[Mapping[str, Any]],
) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=list(fieldnames),
        extrasaction="ignore",
        lineterminator="\n",
    )
    writer.writeheader()
    for row in rows:
        writer.writerow({key: csv_cell(row.get(key)) for key in fieldnames})
    return stream.getvalue().encode("utf-8")


def csv_contains_review(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            return any(
                str(row.get(field_name, "")).strip()
                for row in reader
                for field_name in REVIEW_FIELDS
            )
    except (OSError, csv.Error, UnicodeDecodeError):
        return True


def qa_contains_review(qa_dir: Path) -> bool:
    if any(qa_dir.rglob("*.jsonl")) or any(qa_dir.rglob("*.ndjson")):
        return True
    return any(csv_contains_review(path) for path in qa_dir.rglob("*.csv"))


def invalidate_existing_audit_states(qa_dir: Path) -> list[str]:
    """Atomically hide stale states so the recorder cannot finalize them."""

    invalidated: list[str] = []
    for state_path in sorted(qa_dir.glob("audit_state*.json")):
        if (
            not state_path.is_file()
            or state_path.parent.resolve() != qa_dir.resolve()
            or not is_within(qa_dir, state_path)
        ):
            continue
        payload = state_path.read_bytes()
        backup = state_path.with_name(
            f".{state_path.name}.invalid-{sha256_bytes(payload)[:12]}"
        )
        if backup.exists() and (not backup.is_file() or backup.read_bytes() != payload):
            raise ValueError(
                f"cannot preserve stale audit state at existing path: {backup}"
            )
        if backup.is_file():
            state_path.unlink()
        else:
            os.replace(state_path, backup)
        invalidated.append(backup.name)
    return invalidated


def guarded_write(
    path: Path,
    payload: bytes,
    *,
    reviews_exist: bool,
) -> None:
    if path.is_file():
        current = path.read_bytes()
        if current == payload:
            return
        if reviews_exist:
            raise ValueError(
                "review decisions/journal already exist and this audit artifact "
                f"would change: {path}"
            )
    elif path.exists():
        raise ValueError(f"audit artifact path is not a file: {path}")
    atomic_write_bytes(path, payload)


@lru_cache(maxsize=32)
def find_label_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates: list[Path] = []
    if os.name == "nt":
        windows = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
        candidates.extend(
            [
                windows / ("malgunbd.ttf" if bold else "malgun.ttf"),
                windows / ("arialbd.ttf" if bold else "arial.ttf"),
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


def fit_text(
    draw: ImageDraw.ImageDraw,
    value: str,
    font: ImageFont.ImageFont,
    max_width: int,
) -> str:
    if draw.textbbox((0, 0), value, font=font)[2] <= max_width:
        return value
    suffix = "…"
    low, high = 0, len(value)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = value[:middle] + suffix
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            low = middle
        else:
            high = middle - 1
    return value[:low] + suffix


def load_record_asset(
    dataset_root: Path,
    record: Mapping[str, Any],
    kind: str,
) -> Image.Image | None:
    assets = record.get("assets")
    if not isinstance(assets, Mapping):
        return None
    descriptor = assets.get(kind)
    if not isinstance(descriptor, Mapping):
        return None
    try:
        pure = safe_relative_path(descriptor.get("path"), f"{kind} path")
        path = resolve_inside(dataset_root, pure, f"{kind} path")
        with Image.open(path) as opened:
            opened.load()
            return opened.copy()
    except (OSError, ValueError, UnidentifiedImageError):
        return None


def checkerboard(size: tuple[int, int], block: int = 12) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size, (238, 238, 238, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, height, block):
        for x in range(0, width, block):
            if ((x // block) + (y // block)) % 2:
                draw.rectangle(
                    (x, y, min(width, x + block), min(height, y + block)),
                    fill=(198, 202, 208, 255),
                )
    return image


def rgba_on_checker(image: Image.Image | None) -> Image.Image | None:
    if image is None:
        return None
    glyph = image.convert("RGBA")
    background = checkerboard(glyph.size)
    composed = Image.alpha_composite(background, glyph).convert("RGB")
    background.close()
    glyph.close()
    return composed


def source_context_panel(
    page: Image.Image,
    record: Mapping[str, Any],
) -> Image.Image:
    tight = parse_bbox(record.get("tight_bbox_px"), "tight_bbox_px")
    context = parse_bbox(record.get("context_bbox_px"), "context_bbox_px")
    union = (
        min(tight[0], context[0]),
        min(tight[1], context[1]),
        max(tight[2], context[2]),
        max(tight[3], context[3]),
    )
    width = union[2] - union[0]
    height = union[3] - union[1]
    margin_x = max(24, round(width * 0.25))
    margin_y = max(24, round(height * 0.35))
    crop = (
        max(0, union[0] - margin_x),
        max(0, union[1] - margin_y),
        min(page.width, union[2] + margin_x),
        min(page.height, union[3] + margin_y),
    )
    panel = page.crop(crop).convert("RGB")
    draw = ImageDraw.Draw(panel)
    line_width = max(2, min(7, max(panel.size) // 160))
    for box, color in (
        (context, QA_CONTEXT_COLOR),
        (tight, QA_TIGHT_COLOR),
    ):
        translated = (
            box[0] - crop[0],
            box[1] - crop[1],
            box[2] - crop[0] - 1,
            box[3] - crop[1] - 1,
        )
        draw.rectangle(translated, outline=color, width=line_width)
    return panel


def mask_on_raw_panel(
    raw: Image.Image | None,
    mask: Image.Image | None,
    record: Mapping[str, Any],
) -> Image.Image | None:
    if raw is None or mask is None:
        return None
    output = raw.convert("RGBA")
    overlay = Image.new("RGBA", output.size, (0, 0, 0, 0))
    crop = parse_bbox(record.get("crop_bbox_px"), "crop_bbox_px")
    tight = parse_bbox(record.get("tight_bbox_px"), "tight_bbox_px")
    local = (tight[0] - crop[0], tight[1] - crop[1])
    alpha = mask.convert("L").point(lambda value: 112 if value else 0)
    color = Image.new("RGBA", mask.size, (*QA_CONTEXT_COLOR, 0))
    color.putalpha(alpha)
    overlay.alpha_composite(color, dest=local)
    composed = Image.alpha_composite(output, overlay).convert("RGB")
    output.close()
    overlay.close()
    alpha.close()
    color.close()
    return composed


def metadata_panel(record: Mapping[str, Any]) -> Image.Image:
    image = Image.new("RGB", (640, 420), (246, 247, 249))
    draw = ImageDraw.Draw(image)
    font = find_label_font(23)
    small = find_label_font(20)
    processing = record.get("processing")
    method = (
        str(processing.get("mask_method", ""))
        if isinstance(processing, Mapping)
        else ""
    )
    candidate = record.get("candidate_metadata")
    categories = (
        ",".join(str(value) for value in candidate.get("categories", []))
        if isinstance(candidate, Mapping)
        else ""
    )
    quality = record.get("quality")
    quality_status = (
        str(quality.get("status", "")) if isinstance(quality, Mapping) else ""
    )
    lines = (
        f"id: {record.get('id', '')}",
        f"parent: {record.get('parent_id', '')}",
        f"method: {method}  quality: {quality_status}",
        f"categories: {categories}",
        f"candidate: {record.get('bbox_px')}",
        f"crop: {record.get('crop_bbox_px')}",
        f"tight: {record.get('tight_bbox_px')}",
        f"context: {record.get('context_bbox_px')}",
        "overlay: CYAN=context  YELLOW=tight",
        "recrop coordinates: SOURCE PAGE XYXY",
    )
    for index, line in enumerate(lines):
        draw.text(
            (12, 10 + index * 39),
            fit_text(draw, line, font if index < 2 else small, 615),
            fill=(24, 30, 38),
            font=font if index < 2 else small,
        )
    return image


def render_panel(
    sheet: Image.Image,
    draw: ImageDraw.ImageDraw,
    bounds: tuple[int, int, int, int],
    title: str,
    image: Image.Image | None,
    font: ImageFont.ImageFont,
) -> None:
    left, top, right, bottom = bounds
    draw.rectangle(bounds, fill=(246, 247, 249), outline=(174, 181, 191), width=1)
    title_height = 24
    draw.rectangle((left, top, right, top + title_height), fill=(27, 34, 45))
    draw.text(
        (left + 5, top + 3),
        fit_text(draw, title, font, right - left - 10),
        fill=(255, 255, 255),
        font=font,
    )
    if image is None:
        draw.text(
            (left + 8, top + title_height + 10),
            "NOT AVAILABLE",
            fill=(62, 68, 78),
            font=font,
        )
        return
    display = image.convert("RGB")
    available = (max(1, right - left - 8), max(1, bottom - top - title_height - 8))
    display.thumbnail(available, Image.Resampling.LANCZOS)
    x = left + 4 + (available[0] - display.width) // 2
    y = top + title_height + 4 + (available[1] - display.height) // 2
    sheet.paste(display, (x, y))
    display.close()


def render_audit_cell(
    sheet: Image.Image,
    draw: ImageDraw.ImageDraw,
    *,
    origin: tuple[int, int],
    cell_size: tuple[int, int],
    record: Mapping[str, Any],
    audit_index: int,
    dataset_root: Path,
    page_cache: SourcePageCache,
) -> None:
    x, y = origin
    width, height = cell_size
    draw.rectangle(
        (x, y, x + width - 1, y + height - 1),
        fill=(235, 238, 242),
        outline=(118, 127, 140),
        width=2,
    )
    title_font = find_label_font(18, bold=True)
    small_font = find_label_font(14)
    sample_id = str(record.get("id", ""))
    header = (
        f"#{audit_index:06d}  {sample_id}  "
        f"{record.get('work_id', '')}/{record.get('chapter_id', '')}/"
        f"{record.get('page_id', '')}"
    )
    draw.text(
        (x + 9, y + 8),
        fit_text(draw, header, title_font, width - 18),
        fill=(18, 24, 33),
        font=title_font,
    )

    source_relative = str(record.get("source_image_path", ""))
    source_panel: Image.Image | None = None
    try:
        source_panel = source_context_panel(
            page_cache.get(source_relative).image,
            record,
        )
    except (OSError, ValueError, UnidentifiedImageError):
        source_panel = None
    loaded = {
        kind: load_record_asset(dataset_root, record, kind)
        for kind in (
            "raw",
            "context",
            "glyph_rgba",
            "mask",
            "glyph_224",
            "context_224",
            "black_on_white",
            "white_on_black",
            "color_mask",
            "outline_fill",
            "outline_stroke",
            "outline_outer_ring",
            "deskew_rgba",
        )
    }
    derived: list[Image.Image] = []
    glyph_checker = rgba_on_checker(loaded["glyph_rgba"])
    if glyph_checker is not None:
        derived.append(glyph_checker)
    mask_raw = mask_on_raw_panel(loaded["raw"], loaded["mask"], record)
    if mask_raw is not None:
        derived.append(mask_raw)
    deskew_checker = rgba_on_checker(loaded["deskew_rgba"])
    if deskew_checker is not None:
        derived.append(deskew_checker)
    metadata = metadata_panel(record)
    derived.append(metadata)
    panels = (
        ("SOURCE CONTEXT", source_panel),
        ("RAW EXACT CROP", loaded["raw"]),
        ("CONTEXT", loaded["context"]),
        ("RGBA ORIGINAL / CHECKER", glyph_checker),
        ("BINARY MASK", loaded["mask"]),
        ("MASK ON RAW / CYAN", mask_raw),
        ("STYLE GLYPH_224", loaded["glyph_224"]),
        ("CONTEXT_224", loaded["context_224"]),
        ("BLACK ON WHITE", loaded["black_on_white"]),
        ("WHITE ON BLACK", loaded["white_on_black"]),
        ("COLOR MASK", loaded["color_mask"]),
        ("OUTLINE FILL", loaded["outline_fill"]),
        ("OUTLINE STROKE", loaded["outline_stroke"]),
        ("OUTER RING", loaded["outline_outer_ring"]),
        ("OPTIONAL DESKEW", deskew_checker),
        ("PROVENANCE / RECROP", metadata),
    )
    grid_top = y + 40
    footer_height = 74
    grid_height = height - 40 - footer_height - 8
    gap = 5
    panel_width = (width - 18 - gap * 3) // 4
    panel_height = (grid_height - gap * 3) // 4
    for panel_index, (title, image) in enumerate(panels):
        column = panel_index % 4
        row_index = panel_index // 4
        left = x + 9 + column * (panel_width + gap)
        top = grid_top + row_index * (panel_height + gap)
        render_panel(
            sheet,
            draw,
            (left, top, left + panel_width, top + panel_height),
            title,
            image,
            small_font,
        )
    processing = record.get("processing")
    method = (
        str(processing.get("mask_method", ""))
        if isinstance(processing, Mapping)
        else ""
    )
    candidate = record.get("candidate_metadata")
    categories = (
        ",".join(str(value) for value in candidate.get("categories", []))
        if isinstance(candidate, Mapping)
        and isinstance(candidate.get("categories"), list)
        else ""
    )
    footer_lines = (
        f"method={method}  orientation={record.get('orientation', '')}  "
        f"categories={categories}",
        f"parent={record.get('parent_id', '')}  "
        f"source={record.get('source_image_path', '')}",
        "Review: pass / reject / recrop. Recrop bbox is source-page XYXY.",
    )
    footer_top = y + height - footer_height
    for index, line in enumerate(footer_lines):
        draw.text(
            (x + 10, footer_top + index * 22),
            fit_text(draw, line, small_font, width - 20),
            fill=(30, 37, 48),
            font=small_font,
        )
    if source_panel is not None:
        source_panel.close()
    for image in loaded.values():
        if image is not None:
            image.close()
    for image in derived:
        image.close()


def render_contact_sheet(
    records: Sequence[Mapping[str, Any]],
    *,
    dataset_root: Path,
    library_root: Path,
    shard_label: str,
    first_audit_index: int,
) -> Image.Image:
    count = len(records)
    columns = max(1, min(3 if count <= DEFAULT_CONTACT_SHEET_SIZE else 4, count))
    rows_count = math.ceil(count / columns)
    margin = 18
    header_height = 62
    cell_size = (960, 880)
    canvas = Image.new(
        "RGB",
        (
            margin * 2 + columns * cell_size[0],
            margin * 2 + header_height + rows_count * cell_size[1],
        ),
        (222, 226, 232),
    )
    draw = ImageDraw.Draw(canvas)
    header_font = find_label_font(27, bold=True)
    draw.text(
        (margin, margin),
        (
            f"FontClip HARD exhaustive audit | {shard_label} | "
            f"items {first_audit_index}–{first_audit_index + count - 1}"
        ),
        fill=(18, 24, 33),
        font=header_font,
    )
    draw.text(
        (margin, margin + 32),
        "CYAN=context, YELLOW=tight. These overlays exist only in QA sheets.",
        fill=(36, 45, 58),
        font=find_label_font(17),
    )
    page_cache = SourcePageCache(library_root)
    try:
        for local_index, record in enumerate(records):
            column = local_index % columns
            row_index = local_index // columns
            render_audit_cell(
                canvas,
                draw,
                origin=(
                    margin + column * cell_size[0],
                    margin + header_height + row_index * cell_size[1],
                ),
                cell_size=cell_size,
                record=record,
                audit_index=first_audit_index + local_index,
                dataset_root=dataset_root,
                page_cache=page_cache,
            )
    finally:
        page_cache.close()
    return canvas


def inventory_item(
    record: Mapping[str, Any],
    *,
    cell_index: int,
    audit_index: int,
) -> dict[str, Any]:
    processing = record.get("processing")
    method = (
        str(processing.get("mask_method", ""))
        if isinstance(processing, Mapping)
        else ""
    )
    assets = record.get("assets")
    asset_hashes = (
        {
            str(kind): {
                "file_sha256": descriptor.get("file_sha256"),
                "pixel_sha256": descriptor.get("pixel_sha256"),
            }
            for kind, descriptor in sorted(assets.items())
            if isinstance(descriptor, Mapping)
        }
        if isinstance(assets, Mapping)
        else {}
    )
    parent_id = str(record.get("parent_id", ""))
    recrop_contract = {
        "allowed_decisions": ["pass", "reject", "recrop"],
        "coordinate_space": "source_page_pixels_xyxy",
        "current_processed_id": record.get("id"),
        "current_source_crop_bbox_px": record.get("source_crop_bbox_px"),
        "current_tight_bbox_px": record.get("tight_bbox_px"),
        "page_size_px": record.get("page_size_px"),
        "parent_record_sha256": record.get("parent_record_sha256"),
        "reprocess_parent_id": parent_id,
        "reprocess_tool": "scripts/postprocess_fontclip_hard_candidates.py",
        "source_image_path": record.get("source_image_path"),
    }
    return {
        "cell_index": cell_index,
        "audit_index": audit_index,
        "id": record.get("id"),
        "image_path": record.get("image_path"),
        "work_id": record.get("work_id"),
        "chapter_id": record.get("chapter_id"),
        "page_id": record.get("page_id"),
        "tier": record.get("tier"),
        "orientation": record.get("orientation"),
        "mask_status": "processed_reviewable",
        "mask_high_precision": method in {"ctd", "precomputed_verified"},
        "mask_reject_reasons": "",
        "decision": "",
        "reject_reason": "",
        "recrop_bbox_px": "",
        "padding_px": "",
        "reviewer": "",
        "notes": "",
        "source_image_path": record.get("source_image_path"),
        "source_page_sha256": record.get("source_page_sha256"),
        "page_size_px": record.get("page_size_px"),
        "bbox_px": record.get("bbox_px"),
        "source_crop_bbox_px": record.get("source_crop_bbox_px"),
        "tight_bbox_px": record.get("tight_bbox_px"),
        "context_bbox_px": record.get("context_bbox_px"),
        "parent_id": parent_id,
        "parent_record_sha256": record.get("parent_record_sha256"),
        "root_real_id": record.get("root_real_id"),
        "reprocess_parent_id": parent_id,
        "recrop_contract": recrop_contract,
        "reprocess_linkage": {
            "current_processed_id": record.get("id"),
            "parent_record_sha256": record.get("parent_record_sha256"),
            "reprocess_parent_id": parent_id,
            "root_real_id": record.get("root_real_id"),
        },
        "asset_sha256": asset_hashes,
        "style_metrics": record.get("style_metrics"),
        "quality": record.get("quality"),
    }


def remove_stale_sheet_artifacts(
    qa_dir: Path,
    *,
    prefix: str,
    expected: set[Path],
    reviews_exist: bool,
) -> None:
    stale = {
        path for path in qa_dir.glob(f"{prefix}_audit_*.png") if path not in expected
    }
    stale.update(
        path for path in qa_dir.glob(f"{prefix}_audit_*.json") if path not in expected
    )
    stale.update(
        path for path in qa_dir.glob(f"{prefix}_audit_*.csv") if path not in expected
    )
    if stale and reviews_exist:
        names = ", ".join(path.name for path in sorted(stale)[:5])
        raise ValueError(
            "stale exhaustive artifacts exist beside review data; refusing "
            f"to invalidate the journal: {names}"
        )
    for path in sorted(stale):
        if not is_within(qa_dir, path) or path.parent.resolve() != qa_dir.resolve():
            raise ValueError(f"unsafe stale audit artifact: {path}")
        path.unlink()


def build_exhaustive_audit(
    records: Sequence[Mapping[str, Any]],
    *,
    dataset_root: Path,
    library_root: Path,
    qa_dir: Path,
    validation: ValidationResult,
    shard_index: int,
    shard_count: int,
    contact_sheet_size: int,
) -> list[dict[str, Any]]:
    tag = shard_tag(shard_index, shard_count)
    ordered_global = sorted(records, key=record_order_key)
    selected = [
        record
        for record in ordered_global
        if shard_bucket(str(record.get("id", "")), shard_count) == shard_index
    ]
    ordered_ids = [str(record.get("id", "")) for record in selected]
    global_ids = [str(record.get("id", "")) for record in ordered_global]
    prefix = f"fontclip_audit_{tag}"
    reviews_exist = qa_contains_review(qa_dir)
    expected_paths: set[Path] = set()
    expected_sheet_count = math.ceil(len(selected) / contact_sheet_size)
    for sheet_index in range(1, expected_sheet_count + 1):
        stem = f"{prefix}_audit_{sheet_index:05d}"
        expected_paths.update(
            {
                qa_dir / f"{stem}.png",
                qa_dir / f"{stem}.json",
                qa_dir / f"{stem}.csv",
            }
        )
    remove_stale_sheet_artifacts(
        qa_dir,
        prefix=prefix,
        expected=expected_paths,
        reviews_exist=reviews_exist,
    )

    artifacts: list[dict[str, Any]] = []
    all_inventory_items: list[dict[str, Any]] = []
    for sheet_index, start in enumerate(
        range(0, len(selected), contact_sheet_size),
        1,
    ):
        page_records = selected[start : start + contact_sheet_size]
        stem = f"{prefix}_audit_{sheet_index:05d}"
        png_path = qa_dir / f"{stem}.png"
        json_path = qa_dir / f"{stem}.json"
        csv_path = qa_dir / f"{stem}.csv"
        items = [
            inventory_item(
                record,
                cell_index=cell_index,
                audit_index=start + cell_index,
            )
            for cell_index, record in enumerate(page_records, 1)
        ]
        inventory = {
            "schema_version": 1,
            "sheet": png_path.name,
            "stratified_by": "audit",
            "decision_values": ["pass", "reject", "recrop"],
            "merge_key": "id",
            "items": items,
        }
        sheet = render_contact_sheet(
            page_records,
            dataset_root=dataset_root,
            library_root=library_root,
            shard_label=tag,
            first_audit_index=start + 1,
        )
        try:
            encoded_png = png_bytes(sheet)
        finally:
            sheet.close()
        encoded_json = json_bytes(inventory)
        fieldnames = list(items[0]) if items else []
        encoded_csv = csv_bytes(fieldnames, items)
        sheet_reviewed = csv_contains_review(csv_path)
        guarded_write(
            png_path,
            encoded_png,
            reviews_exist=reviews_exist or sheet_reviewed,
        )
        guarded_write(
            json_path,
            encoded_json,
            reviews_exist=reviews_exist or sheet_reviewed,
        )
        if not sheet_reviewed:
            guarded_write(
                csv_path,
                encoded_csv,
                reviews_exist=reviews_exist,
            )
        artifact = {
            "sheet_index": sheet_index,
            "png": png_path.relative_to(dataset_root).as_posix(),
            "json": json_path.relative_to(dataset_root).as_posix(),
            "csv": csv_path.relative_to(dataset_root).as_posix(),
            "item_count": len(items),
            "first_audit_index": start + 1,
            "last_audit_index": start + len(items),
            "png_sha256": sha256_bytes(encoded_png),
            "json_sha256": sha256_bytes(encoded_json),
            "ordered_ids_sha256": hash_ids(
                [str(item["id"]) for item in items],
                sort_items=False,
            ),
        }
        artifacts.append(artifact)
        all_inventory_items.extend(items)

    audit_csv_path = qa_dir / audit_csv_name_for_shard(shard_index, shard_count)
    audit_rows = [{**item, "reviewed_at": ""} for item in all_inventory_items]
    audit_fields = (
        list(audit_rows[0])
        if audit_rows
        else [
            "cell_index",
            "audit_index",
            "id",
            *REVIEW_FIELDS,
        ]
    )
    if "reviewed_at" not in audit_fields:
        audit_fields.append("reviewed_at")
    audit_csv_payload = csv_bytes(audit_fields, audit_rows)
    if not csv_contains_review(audit_csv_path):
        guarded_write(
            audit_csv_path,
            audit_csv_payload,
            reviews_exist=reviews_exist,
        )

    state = {
        "schema_version": 1,
        "primary_manifest": MANIFEST_NAME,
        "primary_manifest_sha256": validation.manifest_sha256,
        "mask_manifest_sha256": {
            "ownership_marker": validation.marker_sha256,
            "postprocess_report": validation.report_sha256,
            "rejects": validation.rejects_sha256,
            "synthetic_provenance_schema": validation.synthetic_spec_sha256,
        },
        "audit_all": True,
        "mask_review": True,
        "shard_index": shard_index,
        "shard_count": shard_count,
        "contact_sheet": {
            "max_items": contact_sheet_size,
            "canvas_size": None,
        },
        "item_count": len(ordered_ids),
        "id_set_sha256": hash_ids(ordered_ids, sort_items=True),
        "ordered_ids_sha256": hash_ids(ordered_ids, sort_items=False),
        "ids": sorted(ordered_ids),
        "hard_qa": {
            "tool": QA_TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "max_chapters_per_work": MAX_CHAPTERS_PER_WORK,
            "global_item_count": len(global_ids),
            "global_id_set_sha256": hash_ids(global_ids, sort_items=True),
            "global_ordered_ids_sha256": hash_ids(global_ids, sort_items=False),
            "shard_algorithm": (
                "int(sha256('fontclip-qa-shard-v1\\0' + id)[:16],16)%shard_count"
            ),
            "asset_validation_scope": {
                "shard_index": shard_index,
                "shard_count": shard_count,
                "processed_item_count": len(ordered_ids),
                "four_shard_union_rehashes_every_processed_asset_once": (
                    shard_count == 4
                ),
            },
            "qa_context_overlay_colors": {
                "context_cyan_rgb": list(QA_CONTEXT_COLOR),
                "tight_yellow_rgb": list(QA_TIGHT_COLOR),
                "red_used": False,
            },
            "training_assets_modified": False,
            "recrop_coordinate_space": "source_page_pixels_xyxy",
            "sheet_artifacts": [
                {
                    "sheet_index": artifact["sheet_index"],
                    "png": Path(str(artifact["png"])).name,
                    "json": Path(str(artifact["json"])).name,
                    "item_count": artifact["item_count"],
                    "png_sha256": artifact["png_sha256"],
                    "json_sha256": artifact["json_sha256"],
                    "ordered_ids_sha256": artifact["ordered_ids_sha256"],
                }
                for artifact in artifacts
            ],
        },
    }
    state_path = qa_dir / state_name_for_shard(shard_index, shard_count)
    guarded_write(
        state_path,
        json_bytes(state),
        reviews_exist=reviews_exist,
    )
    return artifacts


def build_qa_report(
    *,
    dataset_root: Path,
    library_root: Path,
    qa_dir: Path,
    validation: ValidationResult,
    issues: IssueCollector,
    audit_all: bool,
    shard_index: int,
    shard_count: int,
    contact_sheet_size: int,
    sheet_artifacts: Sequence[Mapping[str, Any]],
    invalidated_audit_states: Sequence[str],
) -> dict[str, Any]:
    shard_ids = [
        str(record.get("id", ""))
        for record in sorted(validation.records, key=record_order_key)
        if shard_bucket(str(record.get("id", "")), shard_count) == shard_index
    ]
    shard_reject_ids = [
        str(reject.get("parent_id", ""))
        for reject in validation.rejects
        if shard_bucket(str(reject.get("parent_id", "")), shard_count) == shard_index
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "tool": QA_TOOL_ID,
        "ok": issues.error_count == 0,
        "dataset_root": str(dataset_root),
        "library_root": str(library_root),
        "qa_dir": str(qa_dir),
        "audit_all": bool(audit_all),
        "mask_review": bool(audit_all),
        "processed_records": len(validation.records),
        "rejected_records": len(validation.rejects),
        "max_chapters_per_work": MAX_CHAPTERS_PER_WORK,
        "source_signatures": {
            "manifest_sha256": validation.manifest_sha256,
            "rejects_sha256": validation.rejects_sha256,
            "report_sha256": validation.report_sha256,
            "ownership_marker_sha256": validation.marker_sha256,
            "synthetic_provenance_schema_sha256": (validation.synthetic_spec_sha256),
        },
        "validation": {
            "validation_attempted": True,
            "shard_rows_and_assets_rehashed": issues.error_count == 0,
            "all_rows_and_assets_rehashed": (
                issues.error_count == 0 and shard_count == 1
            ),
            "global_asset_validation_requires_all_shards": shard_count > 1,
            "validated_processed_records": len(shard_ids),
            "validated_rejected_records": len(shard_reject_ids),
            "source_crop_pixel_equality_verified": issues.error_count == 0,
            "asset_semantic_dag_verified": issues.error_count == 0,
            "checkpoint_union_verified": issues.error_count == 0,
            "work_split_and_max20_verified": issues.error_count == 0,
            "diagnostic_overlays_forbidden_in_training_assets": True,
            "qa_overlay_palette": {
                "context_cyan_rgb": list(QA_CONTEXT_COLOR),
                "tight_yellow_rgb": list(QA_TIGHT_COLOR),
                "red_used": False,
            },
        },
        "shard": {
            "tag": shard_tag(shard_index, shard_count),
            "index": shard_index,
            "count": shard_count,
            "item_count": len(shard_ids),
            "id_set_sha256": hash_ids(shard_ids, sort_items=True),
            "ordered_ids_sha256": hash_ids(shard_ids, sort_items=False),
            "global_item_count": len(validation.global_ids),
            "global_id_set_sha256": hash_ids(
                validation.global_ids,
                sort_items=True,
            ),
            "algorithm_namespace": SHARD_HASH_NAMESPACE,
        },
        "contact_sheet": {
            "max_items": contact_sheet_size,
            "panel_count_per_item": 16,
            "panels": [
                "source_context",
                "raw",
                "context",
                "glyph_rgba_checker",
                "binary_mask",
                "mask_on_raw",
                "glyph_224",
                "context_224",
                "black_on_white",
                "white_on_black",
                "color_mask",
                "outline_fill",
                "outline_stroke",
                "outline_outer_ring",
                "deskew_rgba_optional",
                "provenance_recrop",
            ],
        },
        "review_contract": {
            "decision_values": ["pass", "reject", "recrop"],
            "unmentioned_cells_default_to_pass": True,
            "recrop_coordinate_space": "source_page_pixels_xyxy",
            "recrop_requires_bbox_before_finalize": True,
            "reprocess_tool": "scripts/postprocess_fontclip_hard_candidates.py",
            "recorder": "scripts/record_fontclip_sheet_review.py",
            "inventory_merge_key": "id",
        },
        "sheet_artifacts": list(sheet_artifacts),
        "invalidated_audit_states": list(invalidated_audit_states),
        "recorder_finalization_blocked_on_failure": bool(
            issues.error_count and not any(qa_dir.glob("audit_state*.json"))
        ),
        "error_count": issues.error_count,
        "issue_counts": dict(sorted(issues.counts.items())),
        "issues": issues.details,
        "issues_truncated": issues.error_count > len(issues.details),
    }


def validate_arguments(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    dataset_root = args.dataset.expanduser().resolve()
    library_root = args.library_root.expanduser().resolve()
    if not dataset_root.is_dir():
        raise ValueError(f"dataset directory does not exist: {dataset_root}")
    if not library_root.is_dir():
        raise ValueError(f"library directory does not exist: {library_root}")
    if (
        dataset_root == library_root
        or is_within(dataset_root, library_root)
        or is_within(library_root, dataset_root)
    ):
        raise ValueError(
            "--dataset and --library-root must be separate, non-nested roots"
        )
    qa_dir = (
        args.qa_dir.expanduser().resolve()
        if args.qa_dir is not None
        else dataset_root / "qa"
    )
    if qa_dir == dataset_root or not is_within(dataset_root, qa_dir):
        raise ValueError("--qa-dir must be a child directory inside --dataset")
    if (
        isinstance(args.shard_count, bool)
        or args.shard_count < 1
        or isinstance(args.shard_index, bool)
        or not 0 <= args.shard_index < args.shard_count
    ):
        raise ValueError("--shard-index must satisfy 0 <= index < --shard-count")
    if (
        isinstance(args.contact_sheet_size, bool)
        or not 1 <= args.contact_sheet_size <= 64
    ):
        raise ValueError("--contact-sheet-size must be between 1 and 64")
    return dataset_root, library_root, qa_dir


def failed_validation_result(dataset_root: Path) -> ValidationResult:
    def signature(name: str) -> str:
        path = dataset_root / name
        try:
            return sha256_file(path) if path.is_file() else ""
        except OSError:
            return ""

    return ValidationResult(
        records=[],
        rejects=[],
        marker={},
        report={},
        manifest_sha256=signature(MANIFEST_NAME),
        rejects_sha256=signature(REJECTS_NAME),
        report_sha256=signature(REPORT_NAME),
        marker_sha256=signature(MARKER_NAME),
        synthetic_spec_sha256=signature(SYNTHETIC_SPEC_NAME),
        global_ids=[],
    )


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=repo_root / "datasets" / "fontclip-hard-processed-v1",
        help="Completed hard postprocess output root.",
    )
    parser.add_argument(
        "--library-root",
        type=Path,
        default=repo_root / "library",
        help="Original immutable manga library root.",
    )
    parser.add_argument(
        "--qa-dir",
        type=Path,
        help="Audit output directory inside --dataset (default: <dataset>/qa).",
    )
    parser.add_argument(
        "--audit-all",
        action="store_true",
        help="Render every processed id in recorder-compatible exhaustive sheets.",
    )
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument(
        "--contact-sheet-size",
        type=int,
        default=DEFAULT_CONTACT_SHEET_SIZE,
        help="Items per exhaustive sheet (1-64; default: 12).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress progress messages; final JSON is still printed.",
    )
    return parser


def run(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    dataset_root, library_root, qa_dir = validate_arguments(args)
    qa_dir.mkdir(parents=True, exist_ok=True)
    issues = IssueCollector()
    if not args.quiet:
        print(
            "[hard-qa] validating signed manifests, checkpoints, source pages, "
            "and every asset",
            file=sys.stderr,
            flush=True,
        )
    try:
        validation = validate_dataset(
            dataset_root,
            library_root,
            issues,
            shard_index=args.shard_index,
            shard_count=args.shard_count,
        )
    except (
        ArithmeticError,
        IndexError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        issues.add(
            "qa_validation_exception",
            f"{type(exc).__name__}: {exc}",
            path=dataset_root,
        )
        validation = failed_validation_result(dataset_root)
    artifacts: list[dict[str, Any]] = []
    invalidated_states: list[str] = []
    if issues.error_count == 0 and args.audit_all:
        if not args.quiet:
            print(
                "[hard-qa] validation passed; rendering exhaustive 16-panel sheets",
                file=sys.stderr,
                flush=True,
            )
        try:
            artifacts = build_exhaustive_audit(
                validation.records,
                dataset_root=dataset_root,
                library_root=library_root,
                qa_dir=qa_dir,
                validation=validation,
                shard_index=args.shard_index,
                shard_count=args.shard_count,
                contact_sheet_size=args.contact_sheet_size,
            )
        except (OSError, ValueError, UnidentifiedImageError) as exc:
            issues.add("audit_render_failed", str(exc), path=qa_dir)
    if issues.error_count:
        try:
            invalidated_states = invalidate_existing_audit_states(qa_dir)
        except (OSError, ValueError) as exc:
            issues.add("audit_state_invalidation_failed", str(exc), path=qa_dir)
    report = build_qa_report(
        dataset_root=dataset_root,
        library_root=library_root,
        qa_dir=qa_dir,
        validation=validation,
        issues=issues,
        audit_all=bool(args.audit_all),
        shard_index=args.shard_index,
        shard_count=args.shard_count,
        contact_sheet_size=args.contact_sheet_size,
        sheet_artifacts=artifacts,
        invalidated_audit_states=invalidated_states,
    )
    report_path = qa_dir / report_name_for_shard(
        args.shard_index,
        args.shard_count,
    )
    atomic_write_bytes(report_path, json_bytes(report))
    return (0 if issues.error_count == 0 else 1), report


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        code, report = run(args)
    except (
        ArithmeticError,
        IndexError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        print(
            canonical_json(
                {
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            ),
            file=sys.stderr,
        )
        return 2
    print(canonical_json(report))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
