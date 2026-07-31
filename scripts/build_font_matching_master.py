#!/usr/bin/env python3
"""Build the zero-copy, leakage-safe font-matching master manifest.

The two reviewed FontClip corpora use different schemas and retain their own
assets.  This tool does *not* copy those assets.  Instead it emits a compact
catalog/path contract with exactly three model views::

    raw_224      unmasked 224x224 crop, when the source corpus has one
    context_224  masked 224x224 context crop
    glyph_224    white-composited 224x224 glyph crop

Every view has an explicit ``available``, ``derivable``, or ``unavailable``
status.  In the hard corpus ``clip_image_path`` aliases ``glyph_224_path``; it
is therefore not misrepresented as a raw view.  ``raw_224`` remains nullable
while its signed native source and deterministic letterbox recipe are kept.

Legacy per-corpus splits are discarded.  Works connected by a lineage group
or normalized glyph duplicate are placed in one deterministic component and
assigned globally, so work, root, variant, and glyph duplicate groups cannot
cross train/validation/test boundaries.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


TOOL_ID = "manga-translator-font-matching-master-builder"
ALGORITHM_VERSION = "font-matching-master-v1"
MASTER_SCHEMA_VERSION = 1
CATALOG_SCHEMA_VERSION = 1
SPLIT_MAP_SCHEMA_VERSION = 1
REPORT_SCHEMA_VERSION = 1
EXPECTED_BASE_ROWS = 8_763
EXPECTED_HARD_ROWS = 19_352
EXPECTED_TOTAL_ROWS = 28_115
DEFAULT_SPLIT_RATIOS = {"train": 0.70, "val": 0.15, "test": 0.15}
DEFAULT_WORK_TARGETS = {"train": 15, "val": 4, "test": 5}
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
OVERLAY_PATH_PARTS = frozenset(
    {
        "contact-sheet",
        "contact-sheets",
        "contact_sheet",
        "contact_sheets",
        "diagnostic",
        "diagnostics",
        "overlay",
        "overlays",
        "qa-overlay",
        "qa-overlays",
        "qa_overlay",
        "qa_overlays",
    }
)
EXPLICIT_OVERLAY_FLAGS = frozenset(
    {
        "contains_qa_overlay",
        "diagnostic_overlay_written",
        "is_diagnostic_overlay",
        "is_qa_overlay",
        "overlay_baked_into_asset",
        "qa_overlay_in_training_asset",
    }
)


class MasterManifestError(ValueError):
    """Raised when reviewed inputs or a generated master violate the contract."""


@dataclass(frozen=True)
class SourceCatalog:
    catalog_id: str
    source_kind: str
    root: Path
    manifest_name: str = "manifest.jsonl"

    @property
    def manifest_path(self) -> Path:
        return self.root / self.manifest_name


@dataclass
class CatalogReadResult:
    catalog: SourceCatalog
    records: list[dict[str, Any]]
    manifest_sha256: str
    row_count: int


@dataclass
class BuildBundle:
    records: list[dict[str, Any]]
    manifest_bytes: bytes
    split_map: dict[str, Any]
    split_map_bytes: bytes
    report: dict[str, Any]
    report_bytes: bytes


class UnionFind:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        while parent != self.parent[parent]:
            self.parent[parent] = self.parent[self.parent[parent]]
            parent = self.parent[parent]
        while value != parent:
            next_value = self.parent[value]
            self.parent[value] = parent
            value = next_value
        return parent

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        # Lexicographic parent choice makes the component representation stable.
        if left_root < right_root:
            self.parent[right_root] = left_root
        else:
            self.parent[left_root] = right_root


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


@lru_cache(maxsize=None)
def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def valid_sha256(value: Any, *, location: str) -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    if not HEX_SHA256.fullmatch(normalized):
        raise MasterManifestError(f"{location}: expected a lowercase SHA-256")
    return normalized


def optional_sha256(value: Any, *, location: str) -> str | None:
    if value is None or value == "":
        return None
    return valid_sha256(value, location=location)


def text(value: Any, *, location: str, required: bool = True) -> str | None:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        if required:
            raise MasterManifestError(f"{location}: expected a non-empty string")
        return None
    return normalized


def safe_relative_path(value: Any, *, location: str) -> str:
    raw = text(value, location=location)
    assert raw is not None
    normalized = raw.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    pure = PurePosixPath(normalized)
    if (
        pure.is_absolute()
        or not pure.parts
        or any(part in {"", ".", ".."} for part in pure.parts)
        or ":" in pure.parts[0]
    ):
        raise MasterManifestError(f"{location}: unsafe relative path {value!r}")
    return pure.as_posix()


def resolve_inside(root: Path, relative: str, *, location: str) -> Path:
    pure = PurePosixPath(relative)
    candidate = root.joinpath(*pure.parts).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise MasterManifestError(
            f"{location}: asset path escaped catalog root: {relative}"
        ) from error
    return candidate


def nested(mapping: Mapping[str, Any], *keys: str) -> Any:
    value: Any = mapping
    for key in keys:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def _is_true_overlay_flag(value: Any, *, key: str = "") -> bool:
    if key in EXPLICIT_OVERLAY_FLAGS and value is True:
        return True
    if isinstance(value, Mapping):
        return any(
            _is_true_overlay_flag(child, key=str(child_key).lower())
            for child_key, child in value.items()
        )
    if isinstance(value, list):
        return any(_is_true_overlay_flag(child, key=key) for child in value)
    return False


def _path_looks_like_overlay(relative: str) -> bool:
    parts = {part.lower() for part in PurePosixPath(relative).parts}
    return bool(parts & OVERLAY_PATH_PARTS)


def assert_real_approved_record(
    catalog: SourceCatalog,
    row: Mapping[str, Any],
    *,
    line_number: int,
) -> None:
    location = f"{catalog.catalog_id}:{line_number}"
    if catalog.source_kind == "base":
        if row.get("audit_status") != "accepted":
            raise MasterManifestError(f"{location}: row is not accepted")
        history = row.get("audit_history")
        if not isinstance(history, list) or not any(
            isinstance(item, Mapping) and item.get("decision") == "pass"
            for item in history
        ):
            raise MasterManifestError(
                f"{location}: accepted base row lacks a manual pass event"
            )
    elif catalog.source_kind == "hard":
        if nested(row, "review", "status") != "accepted":
            raise MasterManifestError(f"{location}: hard row is not accepted")
        if nested(row, "adjudication", "exhaustive_visual_review_passed") is not True:
            raise MasterManifestError(
                f"{location}: hard row lacks exhaustive visual-review proof"
            )
        # ``quality.status == review`` is intentionally retained on some rows
        # whose conservative CV gate escalated them to a human.  The final
        # accepted ledger and exhaustive adjudication supersede that earlier
        # machine status, so it must not discard manually approved examples.
    else:  # pragma: no cover - guarded when catalogs are constructed
        raise MasterManifestError(
            f"{location}: unsupported source kind {catalog.source_kind!r}"
        )

    synthetic = row.get("synthetic") is True
    synthetic = synthetic or nested(row, "adjudication", "synthetic") is True
    synthetic = synthetic or row.get("synthetic_provenance") not in {None, False, ""}
    provenance = str(row.get("provenance") or "").lower()
    synthetic = synthetic or "synthetic" in provenance or "generative" in provenance
    if synthetic:
        raise MasterManifestError(f"{location}: synthetic records are forbidden")
    if _is_true_overlay_flag(row):
        raise MasterManifestError(
            f"{location}: QA/diagnostic overlays are forbidden in training assets"
        )


def _view_path(
    catalog: SourceCatalog,
    row: Mapping[str, Any],
    view_name: str,
) -> tuple[str | None, str | None]:
    glyph_path = row.get("glyph_224_path") or nested(row, "assets", "glyph_224", "path")
    if view_name == "glyph_224":
        candidate = glyph_path
    elif view_name == "context_224":
        candidate = row.get("context_224_path") or nested(
            row, "assets", "context_224", "path"
        )
    elif view_name == "raw_224":
        candidate = row.get("clip_image_path")
        if catalog.source_kind == "hard" and candidate and glyph_path:
            candidate_normalized = str(candidate).replace("\\", "/")
            glyph_normalized = str(glyph_path).replace("\\", "/")
            if candidate_normalized == glyph_normalized:
                return None, "source_clip_aliases_glyph_224"
    else:  # pragma: no cover - internal programming error
        raise AssertionError(view_name)
    if candidate in {None, ""}:
        return None, "missing_from_source_catalog"
    return str(candidate), None


def _declared_view_hash(row: Mapping[str, Any], view_name: str) -> str | None:
    asset_kind = view_name
    if view_name == "raw_224":
        # The base catalog has no signed clip hash.  Hard raw_224 is unavailable.
        candidates = [nested(row, "asset_file_sha256", "clip_image_path")]
    else:
        candidates = [
            nested(row, "assets", asset_kind, "file_sha256"),
            nested(row, "mask_asset_sha256", asset_kind),
        ]
    for candidate in candidates:
        if candidate not in {None, ""}:
            return valid_sha256(candidate, location=f"{view_name}.declared_sha256")
    return None


def _declared_view_metadata(
    row: Mapping[str, Any], view_name: str
) -> tuple[list[int] | None, str | None]:
    asset = nested(row, "assets", view_name)
    if isinstance(asset, Mapping):
        size = asset.get("size_px")
        mode = asset.get("mode")
        if (
            isinstance(size, list)
            and len(size) == 2
            and all(isinstance(value, int) for value in size)
        ):
            declared_size: list[int] | None = list(size)
        else:
            declared_size = None
        return declared_size, mode if isinstance(mode, str) else None
    if view_name == "glyph_224":
        mode = row.get("glyph_224_mode")
        return [224, 224], mode if isinstance(mode, str) else None
    return [224, 224], None


def build_raw_224_derivation(
    catalog: SourceCatalog,
    row: Mapping[str, Any],
    *,
    location: str,
    verify_assets: bool,
) -> dict[str, Any] | None:
    """Describe the hard corpus' native raw asset and exact 224 recipe.

    The accepted hard dataset intentionally stores the reviewed native crop but
    does not materialize a second raw letterbox.  Keeping this as a derivation
    contract avoids both a silent glyph alias and 19,352 copied PNGs.
    """

    candidate = (
        row.get("raw_image_path")
        or nested(row, "assets", "raw", "path")
        or row.get("image_path")
    )
    if candidate in {None, ""}:
        return None
    relative = safe_relative_path(candidate, location=f"{location}.raw_native.path")
    if _path_looks_like_overlay(relative):
        raise MasterManifestError(
            f"{location}.raw_native: QA/diagnostic asset path is forbidden"
        )
    physical = resolve_inside(
        catalog.root,
        relative,
        location=f"{location}.raw_native.path",
    )
    if not physical.is_file():
        raise MasterManifestError(
            f"{location}.raw_native: referenced asset does not exist: {relative}"
        )
    declared_hash = nested(row, "assets", "raw", "file_sha256") or nested(
        row, "asset_file_sha256", "image_path"
    )
    declared_hash = optional_sha256(
        declared_hash, location=f"{location}.raw_native.file_sha256"
    )
    actual_hash: str | None = None
    if declared_hash is None or verify_assets:
        actual_hash = sha256_file(physical)
    if (
        declared_hash is not None
        and actual_hash is not None
        and declared_hash != actual_hash
    ):
        raise MasterManifestError(f"{location}.raw_native: file hash mismatch")
    file_hash = declared_hash or actual_hash
    assert file_hash is not None

    declared_size = nested(row, "assets", "raw", "size_px") or row.get("crop_size_px")
    if not (
        isinstance(declared_size, list)
        and len(declared_size) == 2
        and all(isinstance(value, int) and value > 0 for value in declared_size)
    ):
        declared_size = None
    declared_mode = nested(row, "assets", "raw", "mode")
    if verify_assets:
        verify_native_image(physical, location=f"{location}.raw_native")
    source_native: dict[str, Any] = {
        "catalog_id": catalog.catalog_id,
        "file_sha256": file_hash,
        "hash_scope": "file_bytes",
        "path": relative,
        "provenance": nested(row, "assets", "raw", "provenance") or "real_preserved",
        "status": "available",
    }
    if declared_size is not None:
        source_native["declared_size_px"] = list(declared_size)
    if isinstance(declared_mode, str) and declared_mode:
        source_native["declared_mode"] = declared_mode
    return {
        "catalog_id": catalog.catalog_id,
        "expected_size_px": [224, 224],
        "file_sha256": None,
        "materialization_recipe": {
            "algorithm": "fontclip-letterbox-rgb-v1",
            "canvas_color_rgb": [255, 255, 255],
            "convert_mode": "RGB",
            "operation": "aspect_preserving_letterbox",
            "placement": "center_floor",
            "resize_filter": "lanczos",
            "rounding": "python_round_then_minimum_1px",
            "target_size_px": [224, 224],
        },
        "path": None,
        "reason": "raw_224_not_materialized_in_source_catalog",
        "source_native": source_native,
        "status": "derivable",
    }


def build_view_contract(
    catalog: SourceCatalog,
    row: Mapping[str, Any],
    view_name: str,
    *,
    location: str,
    verify_assets: bool,
) -> dict[str, Any]:
    candidate, unavailable_reason = _view_path(catalog, row, view_name)
    if candidate is None:
        if (
            view_name == "raw_224"
            and catalog.source_kind == "hard"
            and unavailable_reason == "source_clip_aliases_glyph_224"
        ):
            derivation = build_raw_224_derivation(
                catalog,
                row,
                location=location,
                verify_assets=verify_assets,
            )
            if derivation is not None:
                return derivation
        return {
            "catalog_id": catalog.catalog_id,
            "expected_size_px": [224, 224],
            "file_sha256": None,
            "path": None,
            "reason": unavailable_reason,
            "status": "unavailable",
        }

    relative = safe_relative_path(candidate, location=f"{location}.{view_name}.path")
    if _path_looks_like_overlay(relative):
        raise MasterManifestError(
            f"{location}.{view_name}: QA/diagnostic asset path is forbidden: {relative}"
        )
    physical = resolve_inside(
        catalog.root,
        relative,
        location=f"{location}.{view_name}.path",
    )
    if not physical.is_file():
        raise MasterManifestError(
            f"{location}.{view_name}: referenced asset does not exist: {relative}"
        )

    declared_hash = _declared_view_hash(row, view_name)
    actual_hash: str | None = None
    if declared_hash is None or verify_assets:
        actual_hash = sha256_file(physical)
    if (
        declared_hash is not None
        and actual_hash is not None
        and declared_hash != actual_hash
    ):
        raise MasterManifestError(
            f"{location}.{view_name}: declared file hash does not match {relative}"
        )
    file_hash = declared_hash or actual_hash
    assert file_hash is not None

    declared_size, declared_mode = _declared_view_metadata(row, view_name)
    if declared_size is not None and declared_size != [224, 224]:
        raise MasterManifestError(
            f"{location}.{view_name}: declared size is not 224x224: {declared_size}"
        )
    if verify_assets:
        verify_224_image(physical, location=f"{location}.{view_name}")

    result: dict[str, Any] = {
        "catalog_id": catalog.catalog_id,
        "expected_size_px": [224, 224],
        "file_sha256": file_hash,
        "hash_scope": "file_bytes",
        "path": relative,
        "reason": None,
        "status": "available",
    }
    if declared_mode:
        result["declared_mode"] = declared_mode
    return result


def verify_224_image(path: Path, *, location: str) -> None:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:  # pragma: no cover - environment setup failure
        raise MasterManifestError(
            "--verify-assets requires Pillow (pip install Pillow)"
        ) from error
    try:
        with Image.open(path) as image:
            image.load()
            if image.size != (224, 224):
                raise MasterManifestError(
                    f"{location}: decoded size is {image.size}, expected (224, 224)"
                )
    except (OSError, UnidentifiedImageError) as error:
        raise MasterManifestError(
            f"{location}: image decode failed: {error}"
        ) from error


def verify_native_image(path: Path, *, location: str) -> None:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:  # pragma: no cover - environment setup failure
        raise MasterManifestError(
            "--verify-assets requires Pillow (pip install Pillow)"
        ) from error
    try:
        with Image.open(path) as image:
            image.load()
            if image.width <= 0 or image.height <= 0:
                raise MasterManifestError(f"{location}: decoded image is empty")
    except (OSError, UnidentifiedImageError) as error:
        raise MasterManifestError(
            f"{location}: image decode failed: {error}"
        ) from error


@lru_cache(maxsize=None)
def decoded_image_size(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:  # pragma: no cover - environment setup failure
        raise MasterManifestError(
            "--verify-assets requires Pillow (pip install Pillow)"
        ) from error
    try:
        with Image.open(path) as image:
            image.load()
            return image.size
    except (OSError, UnidentifiedImageError) as error:
        raise MasterManifestError(
            f"source page decode failed: {path}: {error}"
        ) from error


def _copy_list(value: Any) -> list[Any] | None:
    return list(value) if isinstance(value, (list, tuple)) else None


def _master_id(catalog_id: str, source_id: str) -> str:
    digest = sha256_bytes(f"{catalog_id}\0{source_id}".encode("utf-8"))
    return f"fm_{digest[:24]}"


def build_source_page_locator(
    catalog: SourceCatalog,
    row: Mapping[str, Any],
    *,
    location: str,
    page_hash: str,
) -> dict[str, Any]:
    if catalog.source_kind == "hard":
        candidate = nested(row, "source_page_asset", "path") or row.get(
            "source_image_path"
        )
        storage_root = (
            nested(row, "source_page_asset", "storage_root") or "library_root"
        )
        provenance = nested(row, "source_page_asset", "provenance") or "real_preserved"
        size_px = nested(row, "source_page_asset", "size_px") or row.get("page_size_px")
    else:
        candidate = row.get("source_image_path") or row.get("source_page_path")
        storage_root = "library_root"
        provenance = "real_preserved"
        size_px = row.get("page_size_px")
    relative = safe_relative_path(
        candidate, location=f"{location}.source_page_locator.path"
    )
    if _path_looks_like_overlay(relative):
        raise MasterManifestError(
            f"{location}.source_page_locator: QA/diagnostic path is forbidden"
        )
    if storage_root != "library_root":
        raise MasterManifestError(
            f"{location}.source_page_locator: unsupported storage root {storage_root!r}"
        )
    declared_hash = optional_sha256(
        nested(row, "source_page_asset", "file_sha256"),
        location=f"{location}.source_page_locator.file_sha256",
    )
    if declared_hash is not None and declared_hash != page_hash:
        raise MasterManifestError(
            f"{location}.source_page_locator: source-page hashes disagree"
        )
    size_bytes = nested(row, "source_page_content_signature", "size")
    if not isinstance(size_bytes, int) or size_bytes < 0:
        size_bytes = None
    if not (
        isinstance(size_px, list)
        and len(size_px) == 2
        and all(isinstance(value, int) and value > 0 for value in size_px)
    ):
        size_px = None
    return {
        "file_sha256": page_hash,
        "path": relative,
        "provenance": provenance,
        "resolution_contract": "resolve against caller-supplied library_root",
        "size_bytes": size_bytes,
        "size_px": list(size_px) if size_px is not None else None,
        "storage_root": "library_root",
    }


def build_cohort_signals(row: Mapping[str, Any]) -> dict[str, Any]:
    style = row.get("style_metrics")
    style = style if isinstance(style, Mapping) else {}
    outline_keys = (
        "outline_fill_pixels",
        "outline_outer_ring_pixels",
        "outline_stroke_pixels",
        "outline_structure_ratio",
    )
    outline_values = {key: style.get(key) for key in outline_keys if key in style}
    outline_present = any(
        isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
        for value in outline_values.values()
    )
    return {
        "color_mask_overlap_ratio": style.get("color_mask_overlap_ratio"),
        "inverse_likelihood": style.get("inverse_likelihood"),
        "manual_recrop": nested(row, "adjudication", "manual_recrop") is True,
        "outline_metrics": outline_values,
        "outline_signal_present": outline_present,
        "quality_status": nested(row, "quality", "status"),
        "review_decision": nested(row, "review", "decision"),
        "review_status": nested(row, "review", "status") or row.get("audit_status"),
    }


def compact_source_row(
    catalog: SourceCatalog,
    row: Mapping[str, Any],
    *,
    line_number: int,
    source_line_sha256: str,
    verify_assets: bool,
) -> dict[str, Any]:
    assert_real_approved_record(catalog, row, line_number=line_number)
    location = f"{catalog.catalog_id}:{line_number}"
    source_id = text(row.get("id"), location=f"{location}.id")
    work_id = text(row.get("work_id"), location=f"{location}.work_id")
    chapter_id = text(row.get("chapter_id"), location=f"{location}.chapter_id")
    page_id = text(row.get("page_id"), location=f"{location}.page_id")
    assert source_id and work_id and chapter_id and page_id
    crop_hash = valid_sha256(row.get("crop_sha256"), location=f"{location}.crop_sha256")
    glyph_hash = valid_sha256(
        row.get("glyph_white_composite_sha256"),
        location=f"{location}.glyph_white_composite_sha256",
    )
    page_hash = valid_sha256(
        row.get("source_page_sha256")
        or nested(row, "source_page_content_signature", "sha256"),
        location=f"{location}.source_page_sha256",
    )

    source_root = row.get("root_real_id") or source_id
    source_variant = row.get("variant_group_id") or source_root
    source_root = text(source_root, location=f"{location}.root_real_id")
    source_variant = text(source_variant, location=f"{location}.variant_group_id")
    assert source_root and source_variant
    root_group = f"{catalog.catalog_id}:{source_root}"
    variant_group = f"{catalog.catalog_id}:{source_variant}"

    views = {
        view_name: build_view_contract(
            catalog,
            row,
            view_name,
            location=location,
            verify_assets=verify_assets,
        )
        for view_name in VIEW_NAMES
    }
    candidate_metadata = row.get("candidate_metadata")
    candidate_metadata = (
        candidate_metadata if isinstance(candidate_metadata, Mapping) else None
    )
    candidate_categories = (
        candidate_metadata.get("categories")
        if isinstance(candidate_metadata, Mapping)
        else None
    )
    if not (
        isinstance(candidate_categories, list)
        and all(isinstance(value, str) for value in candidate_categories)
    ):
        candidate_categories = []
    candidate_primary_category = (
        candidate_metadata.get("primary_category")
        if isinstance(candidate_metadata, Mapping)
        else None
    )
    if not isinstance(candidate_primary_category, str):
        candidate_primary_category = None
    candidate_score = (
        candidate_metadata.get("candidate_score")
        if isinstance(candidate_metadata, Mapping)
        else None
    )
    if not (
        isinstance(candidate_score, (int, float))
        and not isinstance(candidate_score, bool)
        and math.isfinite(float(candidate_score))
    ):
        candidate_score = None
    source_locator = build_source_page_locator(
        catalog,
        row,
        location=location,
        page_hash=page_hash,
    )

    record: dict[str, Any] = {
        "catalog_version": CATALOG_SCHEMA_VERSION,
        "chapter": {
            "id": chapter_id,
            "title": text(
                row.get("chapter_title"),
                location=f"{location}.chapter_title",
                required=False,
            ),
        },
        "font_label": None,
        "geometry": {
            "bbox_px": _copy_list(row.get("bbox_px")),
            "crop_bbox_px": _copy_list(row.get("crop_bbox_px")),
            "final_bbox_px": _copy_list(row.get("final_bbox_px")),
            "mask_tight_bbox_px": _copy_list(row.get("mask_tight_bbox_px")),
            "page_size_px": _copy_list(row.get("page_size_px")),
        },
        "groups": {
            "normalized_glyph": f"glyph-white-sha256:{glyph_hash}",
            "root": root_group,
            "split_component": None,
            "variant": variant_group,
        },
        "id": _master_id(catalog.catalog_id, source_id),
        "label_status": "unlabeled",
        "legacy_split": text(
            row.get("split"), location=f"{location}.split", required=False
        ),
        "metadata": {
            "candidate_categories": list(candidate_categories),
            "candidate_category": candidate_primary_category,
            "candidate_metadata": candidate_metadata,
            "candidate_primary_category": candidate_primary_category,
            "candidate_score": candidate_score,
            "cohort_signals": build_cohort_signals(row),
            "ocr_text": row.get("ocr_text")
            if isinstance(row.get("ocr_text"), str)
            else None,
            "orientation": row.get("orientation")
            if isinstance(row.get("orientation"), str)
            else None,
            "style_metrics": row.get("style_metrics")
            if isinstance(row.get("style_metrics"), Mapping)
            else None,
            "tier": row.get("tier") if isinstance(row.get("tier"), str) else None,
            "visual_review_trace": {
                "adjudication": row.get("adjudication")
                if isinstance(row.get("adjudication"), Mapping)
                else None,
                "audit_history": row.get("audit_history")
                if isinstance(row.get("audit_history"), list)
                else None,
                "audit_status": row.get("audit_status"),
                "review": row.get("review")
                if isinstance(row.get("review"), Mapping)
                else None,
            },
        },
        "page": {
            "id": page_id,
            "name": text(
                row.get("page_name"),
                location=f"{location}.page_name",
                required=False,
            ),
            "source_locator": source_locator,
            "source_page_sha256": page_hash,
        },
        "provenance": {
            "approval": "exhaustive_manual_visual_review",
            "qa_overlay": False,
            "source_catalog_id": catalog.catalog_id,
            "source_id": source_id,
            "source_line_number": line_number,
            "source_line_sha256": source_line_sha256,
            "source_lineage": row.get("lineage")
            if isinstance(row.get("lineage"), list)
            else None,
            "source_provenance": row.get("provenance"),
            "source_schema_version": row.get("schema_version"),
            "synthetic": False,
        },
        "sample_crop_sha256": crop_hash,
        "schema_version": MASTER_SCHEMA_VERSION,
        "split": None,
        "views": views,
        "work": {
            "id": work_id,
            "title": text(
                row.get("work_title"),
                location=f"{location}.work_title",
                required=False,
            ),
        },
        "work_balance_weight": None,
    }
    return record


def read_catalog(
    catalog: SourceCatalog,
    *,
    verify_assets: bool,
) -> CatalogReadResult:
    if not catalog.manifest_path.is_file():
        raise MasterManifestError(
            f"{catalog.catalog_id}: manifest does not exist: {catalog.manifest_path}"
        )
    digest = hashlib.sha256()
    records: list[dict[str, Any]] = []
    with catalog.manifest_path.open("rb") as handle:
        for physical_line, payload in enumerate(handle, start=1):
            digest.update(payload)
            stripped = payload.rstrip(b"\r\n")
            if not stripped.strip():
                continue
            try:
                row = json.loads(stripped)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise MasterManifestError(
                    f"{catalog.catalog_id}:{physical_line}: invalid JSON: {error}"
                ) from error
            if not isinstance(row, Mapping):
                raise MasterManifestError(
                    f"{catalog.catalog_id}:{physical_line}: expected a JSON object"
                )
            records.append(
                compact_source_row(
                    catalog,
                    row,
                    line_number=physical_line,
                    source_line_sha256=sha256_bytes(stripped),
                    verify_assets=verify_assets,
                )
            )
    return CatalogReadResult(
        catalog=catalog,
        records=records,
        manifest_sha256=digest.hexdigest(),
        row_count=len(records),
    )


def validate_unique_source_rows(records: Sequence[Mapping[str, Any]]) -> None:
    seen_ids: dict[str, str] = {}
    seen_sources: dict[tuple[str, str], str] = {}
    seen_crops: dict[str, str] = {}
    for record in records:
        item_id = str(record["id"])
        source_key = (
            str(nested(record, "provenance", "source_catalog_id")),
            str(nested(record, "provenance", "source_id")),
        )
        crop_hash = str(record["sample_crop_sha256"])
        for label, key, seen in (
            ("master id", item_id, seen_ids),
            ("source row", repr(source_key), seen_sources),
            ("crop SHA-256", crop_hash, seen_crops),
        ):
            previous = seen.get(key)  # type: ignore[arg-type]
            if previous is not None:
                raise MasterManifestError(
                    f"duplicate {label} {key!r}: {previous} and {item_id}"
                )
            seen[key] = item_id  # type: ignore[index]


def _component_id(work_ids: Sequence[str]) -> str:
    digest = sha256_bytes("\n".join(sorted(work_ids)).encode("utf-8"))
    return f"wgc_{digest[:24]}"


def build_work_components(
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    work_counts = Counter(str(nested(record, "work", "id")) for record in records)
    union = UnionFind(work_counts)
    group_owner: dict[tuple[str, str], str] = {}
    for record in records:
        work_id = str(nested(record, "work", "id"))
        groups = record.get("groups")
        assert isinstance(groups, Mapping)
        for group_kind in ("root", "variant", "normalized_glyph"):
            group_id = str(groups[group_kind])
            key = (group_kind, group_id)
            owner = group_owner.setdefault(key, work_id)
            union.union(owner, work_id)

    members: dict[str, list[str]] = defaultdict(list)
    for work_id in sorted(work_counts):
        members[union.find(work_id)].append(work_id)
    components: list[dict[str, Any]] = []
    for work_ids in members.values():
        work_ids.sort()
        components.append(
            {
                "id": _component_id(work_ids),
                "sample_count": sum(work_counts[work_id] for work_id in work_ids),
                "work_count": len(work_ids),
                "work_ids": work_ids,
            }
        )
    components.sort(key=lambda item: item["id"])
    return components


def validate_ratios(ratios: Mapping[str, float]) -> dict[str, float]:
    if set(ratios) != set(DEFAULT_SPLIT_RATIOS):
        raise MasterManifestError("split ratios must define train, val, and test")
    result = {name: float(ratios[name]) for name in DEFAULT_SPLIT_RATIOS}
    if any(not math.isfinite(value) or value <= 0 for value in result.values()):
        raise MasterManifestError("all split ratios must be positive finite numbers")
    total = sum(result.values())
    if not math.isclose(total, 1.0, abs_tol=1e-9):
        raise MasterManifestError(f"split ratios must sum to 1.0, got {total}")
    return result


def derive_work_targets(
    total_works: int, ratios: Mapping[str, float]
) -> dict[str, int]:
    ratios = validate_ratios(ratios)
    raw = {split: total_works * ratio for split, ratio in ratios.items()}
    targets = {split: math.floor(value) for split, value in raw.items()}
    remainder = total_works - sum(targets.values())
    order = sorted(
        ratios,
        key=lambda split: (-(raw[split] - targets[split]), list(ratios).index(split)),
    )
    for split in order[:remainder]:
        targets[split] += 1
    return targets


def validate_work_targets(
    targets: Mapping[str, int], *, total_works: int
) -> dict[str, int]:
    if set(targets) != set(DEFAULT_SPLIT_RATIOS):
        raise MasterManifestError("work targets must define train, val, and test")
    result: dict[str, int] = {}
    for split in DEFAULT_SPLIT_RATIOS:
        value = targets[split]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise MasterManifestError("work targets must be non-negative integers")
        result[split] = value
    if sum(result.values()) != total_works:
        raise MasterManifestError(
            f"work targets sum to {sum(result.values())}, expected {total_works}"
        )
    return result


def _assignment_score(
    assignment: Mapping[str, str],
    components: Sequence[Mapping[str, Any]],
    ratios: Mapping[str, float],
    work_targets: Mapping[str, int],
) -> float:
    total_rows = sum(int(component["sample_count"]) for component in components)
    rows = Counter()
    works = Counter()
    component_counts = Counter()
    for component in components:
        split = assignment[str(component["id"])]
        rows[split] += int(component["sample_count"])
        works[split] += int(component["work_count"])
        component_counts[split] += 1
    score = 0.0
    for split, ratio in ratios.items():
        row_target = total_rows * ratio
        score += ((rows[split] - row_target) / max(row_target, 1.0)) ** 2
        if works[split] != work_targets[split]:
            score += 1_000_000.0 + abs(works[split] - work_targets[split])
        if work_targets[split] > 0 and component_counts[split] == 0:
            score += 100.0
    return score


def assign_components(
    components: Sequence[Mapping[str, Any]],
    *,
    ratios: Mapping[str, float],
    work_targets: Mapping[str, int],
    seed: str,
) -> dict[str, str]:
    ratios = validate_ratios(ratios)
    split_names = tuple(ratios)
    total_rows = sum(int(item["sample_count"]) for item in components)
    total_works = sum(int(item["work_count"]) for item in components)
    work_targets = validate_work_targets(work_targets, total_works=total_works)
    rows = Counter()
    works = Counter()
    assignment: dict[str, str] = {}

    def order_key(component: Mapping[str, Any]) -> tuple[int, int, str]:
        tie = sha256_bytes(f"{seed}\0{component['id']}".encode("utf-8"))
        return (-int(component["sample_count"]), -int(component["work_count"]), tie)

    ordered = sorted(components, key=order_key)
    component_work_sizes = tuple(int(item["work_count"]) for item in ordered)

    @lru_cache(maxsize=None)
    def feasible(
        index: int, train_capacity: int, val_capacity: int, test_capacity: int
    ) -> bool:
        capacities = {
            "train": train_capacity,
            "val": val_capacity,
            "test": test_capacity,
        }
        if index == len(ordered):
            return all(value == 0 for value in capacities.values())
        weight = component_work_sizes[index]
        for split in split_names:
            if capacities[split] < weight:
                continue
            child = dict(capacities)
            child[split] -= weight
            if feasible(index + 1, child["train"], child["val"], child["test"]):
                return True
        return False

    for index, component in enumerate(ordered):
        candidates: list[tuple[float, str, str]] = []
        component_work_count = int(component["work_count"])
        for split in split_names:
            if works[split] + component_work_count > work_targets[split]:
                continue
            remaining_capacity = {
                name: work_targets[name] - works[name] for name in split_names
            }
            remaining_capacity[split] -= component_work_count
            if not feasible(
                index + 1,
                remaining_capacity["train"],
                remaining_capacity["val"],
                remaining_capacity["test"],
            ):
                continue
            row_target = total_rows * ratios[split]
            prospective_rows = rows[split] + int(component["sample_count"])
            load = (prospective_rows / max(row_target, 1.0)) ** 2
            tie = sha256_bytes(f"{seed}\0{component['id']}\0{split}".encode("utf-8"))
            candidates.append((load, tie, split))
        if not candidates:
            raise MasterManifestError(
                "work-component sizes cannot satisfy the requested split targets"
            )
        _, _, chosen = min(candidates)
        assignment[str(component["id"])] = chosen
        rows[chosen] += int(component["sample_count"])
        works[chosen] += int(component["work_count"])

    # Deterministic local search improves row/work balance without breaking a
    # connected component.  Only strict improvements are accepted.
    component_by_id = {str(item["id"]): item for item in components}
    for _ in range(100):
        current = _assignment_score(assignment, components, ratios, work_targets)
        best: tuple[float, str, str, str] | None = None
        counts = Counter(assignment.values())
        for component_id in sorted(assignment):
            old_split = assignment[component_id]
            if counts[old_split] <= 1 and len(components) >= len(ratios):
                continue
            for new_split in split_names:
                if new_split == old_split:
                    continue
                trial = dict(assignment)
                trial[component_id] = new_split
                score = _assignment_score(trial, components, ratios, work_targets)
                candidate = (score, "move", component_id, new_split)
                if score + 1e-12 < current and (best is None or candidate < best):
                    best = candidate
        component_ids = sorted(component_by_id)
        for left_index, left in enumerate(component_ids):
            for right in component_ids[left_index + 1 :]:
                if assignment[left] == assignment[right]:
                    continue
                trial = dict(assignment)
                trial[left], trial[right] = trial[right], trial[left]
                score = _assignment_score(trial, components, ratios, work_targets)
                candidate = (score, "swap", left, right)
                if score + 1e-12 < current and (best is None or candidate < best):
                    best = candidate
        if best is None:
            break
        _, operation, left, right = best
        if operation == "move":
            assignment[left] = right
        else:
            assignment[left], assignment[right] = assignment[right], assignment[left]
    return assignment


def apply_global_splits(
    records: list[dict[str, Any]],
    *,
    ratios: Mapping[str, float],
    work_targets: Mapping[str, int] | None,
    seed: str,
) -> dict[str, Any]:
    components = build_work_components(records)
    total_works = sum(int(component["work_count"]) for component in components)
    effective_work_targets = (
        derive_work_targets(total_works, ratios)
        if work_targets is None
        else validate_work_targets(work_targets, total_works=total_works)
    )
    component_assignment = assign_components(
        components,
        ratios=ratios,
        work_targets=effective_work_targets,
        seed=seed,
    )
    work_assignment: dict[str, str] = {}
    work_component: dict[str, str] = {}
    for component in components:
        component_id = str(component["id"])
        split = component_assignment[component_id]
        component["split"] = split
        for work_id in component["work_ids"]:
            work_assignment[str(work_id)] = split
            work_component[str(work_id)] = component_id

    work_counts = Counter(str(nested(record, "work", "id")) for record in records)
    for record in records:
        work_id = str(nested(record, "work", "id"))
        record["split"] = work_assignment[work_id]
        record["groups"]["split_component"] = work_component[work_id]
        record["work_balance_weight"] = round(1.0 / work_counts[work_id], 12)

    link_signature = [
        {
            "id": component["id"],
            "sample_count": component["sample_count"],
            "work_ids": component["work_ids"],
        }
        for component in sorted(components, key=lambda item: item["id"])
    ]
    return {
        "algorithm": {
            "id": "deterministic-grouped-work-balance",
            "ratios": dict(ratios),
            "seed": seed,
            "version": 1,
            "work_targets": effective_work_targets,
        },
        "catalog_version": CATALOG_SCHEMA_VERSION,
        "components": sorted(components, key=lambda item: item["id"]),
        "constraint_signature_sha256": sha256_bytes(json_bytes(link_signature)),
        "schema_version": SPLIT_MAP_SCHEMA_VERSION,
        "tool": TOOL_ID,
        "work_assignments": dict(sorted(work_assignment.items())),
    }


def _group_statistics(
    records: Sequence[Mapping[str, Any]], group_name: str
) -> dict[str, Any]:
    groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for record in records:
        groups[str(nested(record, "groups", group_name))].append(record)
    duplicate_groups = [items for items in groups.values() if len(items) > 1]
    return {
        "affected_row_count": sum(len(items) for items in duplicate_groups),
        "cross_catalog_group_count": sum(
            len(
                {str(nested(item, "provenance", "source_catalog_id")) for item in items}
            )
            > 1
            for items in groups.values()
        ),
        "cross_work_group_count": sum(
            len({str(nested(item, "work", "id")) for item in items}) > 1
            for items in groups.values()
        ),
        "duplicate_group_count": len(duplicate_groups),
        "duplicate_extra_row_count": sum(len(items) - 1 for items in duplicate_groups),
        "group_count": len(groups),
        "maximum_group_size": max((len(items) for items in groups.values()), default=0),
    }


def summarize_records(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    by_catalog = Counter(
        str(nested(record, "provenance", "source_catalog_id")) for record in records
    )
    by_split = Counter(str(record["split"]) for record in records)
    by_work = Counter(str(nested(record, "work", "id")) for record in records)
    work_splits: dict[str, set[str]] = defaultdict(set)
    view_statuses: dict[str, Counter[str]] = {name: Counter() for name in VIEW_NAMES}
    split_works: dict[str, set[str]] = defaultdict(set)
    split_weights = Counter()
    catalog_page_ids: dict[str, set[str]] = defaultdict(set)
    catalog_page_hashes: dict[str, set[str]] = defaultdict(set)
    catalog_page_pairs: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for record in records:
        catalog_id = str(nested(record, "provenance", "source_catalog_id"))
        work_id = str(nested(record, "work", "id"))
        split = str(record["split"])
        page_id = str(nested(record, "page", "id"))
        page_hash = str(nested(record, "page", "source_page_sha256"))
        catalog_page_ids[catalog_id].add(page_id)
        catalog_page_hashes[catalog_id].add(page_hash)
        catalog_page_pairs[catalog_id].add((page_id, page_hash))
        work_splits[work_id].add(split)
        split_works[split].add(work_id)
        split_weights[split] += float(record["work_balance_weight"])
        for view_name in VIEW_NAMES:
            view_statuses[view_name][
                str(nested(record, "views", view_name, "status"))
            ] += 1
    work_sizes = sorted(by_work.values())
    overlap: dict[str, Any] = {}
    catalog_ids = sorted(catalog_page_ids)
    for left_index, left in enumerate(catalog_ids):
        for right in catalog_ids[left_index + 1 :]:
            overlap[f"{left}__{right}"] = {
                "identical_page_id_and_sha256_count": len(
                    catalog_page_pairs[left] & catalog_page_pairs[right]
                ),
                "shared_page_id_count": len(
                    catalog_page_ids[left] & catalog_page_ids[right]
                ),
                "shared_source_page_sha256_count": len(
                    catalog_page_hashes[left] & catalog_page_hashes[right]
                ),
            }
    return {
        "by_catalog": dict(sorted(by_catalog.items())),
        "by_split": dict(sorted(by_split.items())),
        "group_statistics": {
            name: _group_statistics(records, name)
            for name in ("root", "variant", "normalized_glyph")
        },
        "record_count": len(records),
        "source_page_overlap": overlap,
        "view_statuses": {
            name: dict(sorted(counts.items())) for name, counts in view_statuses.items()
        },
        "work_balance": {
            "maximum_samples_per_work": max(work_sizes, default=0),
            "minimum_samples_per_work": min(work_sizes, default=0),
            "policy": "inverse_samples_per_work",
            "split_effective_work_weight": {
                split: round(weight, 8)
                for split, weight in sorted(split_weights.items())
            },
            "split_work_count": {
                split: len(work_ids) for split, work_ids in sorted(split_works.items())
            },
            "work_count": len(by_work),
            "work_split_violations": sum(
                len(splits) != 1 for splits in work_splits.values()
            ),
        },
    }


def build_verification_statistics(
    records: Sequence[Mapping[str, Any]],
    *,
    verify_assets: bool,
    library_root: Path | None,
) -> dict[str, Any]:
    available_views: set[tuple[str, str]] = set()
    derivable_native: set[tuple[str, str]] = set()
    unavailable_view_references = 0
    catalog_page_paths: set[tuple[str, str]] = set()
    library_pages: dict[str, tuple[str, int | None, tuple[int, int] | None]] = {}
    source_page_references = 0

    for record in records:
        item_id = str(record["id"])
        for view_name in VIEW_NAMES:
            view = nested(record, "views", view_name)
            assert isinstance(view, Mapping)
            status = view.get("status")
            if status == "available":
                available_views.add((str(view["catalog_id"]), str(view["path"])))
            elif status == "derivable":
                source_native = view.get("source_native")
                assert isinstance(source_native, Mapping)
                derivable_native.add(
                    (
                        str(source_native["catalog_id"]),
                        str(source_native["path"]),
                    )
                )
            else:
                unavailable_view_references += 1

        validate_source_page_locator(record, item_id=item_id)
        locator = nested(record, "page", "source_locator")
        assert isinstance(locator, Mapping)
        source_page_references += 1
        catalog_id = str(nested(record, "provenance", "source_catalog_id"))
        relative = str(locator["path"])
        catalog_page_paths.add((catalog_id, relative))
        size_px_value = locator.get("size_px")
        size_px = (
            (int(size_px_value[0]), int(size_px_value[1]))
            if isinstance(size_px_value, list) and len(size_px_value) == 2
            else None
        )
        signature = (
            str(locator["file_sha256"]),
            locator.get("size_bytes")
            if isinstance(locator.get("size_bytes"), int)
            else None,
            size_px,
        )
        previous = library_pages.setdefault(relative, signature)
        if previous != signature:
            raise MasterManifestError(
                f"library page locator has conflicting signatures: {relative}"
            )

    verified_library_paths = 0
    verified_size_bytes = 0
    verified_size_px = 0
    if verify_assets:
        if library_root is None:
            raise MasterManifestError(
                "--verify-assets requires a caller-supplied library_root"
            )
        resolved_library = library_root.resolve()
        if not resolved_library.is_dir():
            raise MasterManifestError(
                f"library_root does not exist: {resolved_library}"
            )
        for relative, (expected_hash, expected_bytes, expected_px) in sorted(
            library_pages.items()
        ):
            physical = resolve_inside(
                resolved_library,
                relative,
                location="source_page_locator.path",
            )
            if not physical.is_file():
                raise MasterManifestError(f"missing source page: {relative}")
            if sha256_file(physical) != expected_hash:
                raise MasterManifestError(f"source page hash mismatch: {relative}")
            verified_library_paths += 1
            if expected_bytes is not None:
                if physical.stat().st_size != expected_bytes:
                    raise MasterManifestError(
                        f"source page byte size mismatch: {relative}"
                    )
                verified_size_bytes += 1
            decoded_size = decoded_image_size(physical)
            if expected_px is not None:
                if decoded_size != expected_px:
                    raise MasterManifestError(
                        f"source page pixel size mismatch: {relative}"
                    )
                verified_size_px += 1

    return {
        "available_224": {
            "unique_catalog_paths": len(available_views),
            "verified_file_hash_and_decode_count": len(available_views)
            if verify_assets
            else 0,
        },
        "derivable_raw_native": {
            "unique_catalog_paths": len(derivable_native),
            "verified_file_hash_and_decode_count": len(derivable_native)
            if verify_assets
            else 0,
        },
        "source_page_locators": {
            "reference_count": source_page_references,
            "unique_catalog_path_count": len(catalog_page_paths),
            "unique_library_path_count": len(library_pages),
            "verified_byte_size_count": verified_size_bytes,
            "verified_file_hash_and_decode_count": verified_library_paths,
            "verified_pixel_size_count": verified_size_px,
        },
        "unavailable_view_reference_count": unavailable_view_references,
        "verification_requested": verify_assets,
    }


def build_bundle(
    catalogs: Sequence[SourceCatalog],
    *,
    expected_counts: Mapping[str, int] | None,
    expected_total: int | None,
    split_ratios: Mapping[str, float] = DEFAULT_SPLIT_RATIOS,
    work_targets: Mapping[str, int] | None = None,
    split_seed: str = ALGORITHM_VERSION,
    verify_assets: bool = False,
    library_root: Path | None = None,
) -> BuildBundle:
    ratios = validate_ratios(split_ratios)
    reads = [read_catalog(catalog, verify_assets=verify_assets) for catalog in catalogs]
    if expected_counts is not None:
        for read in reads:
            expected = expected_counts.get(read.catalog.catalog_id)
            if expected is not None and read.row_count != expected:
                raise MasterManifestError(
                    f"{read.catalog.catalog_id}: expected {expected} approved rows, "
                    f"found {read.row_count}"
                )
    records = [record for read in reads for record in read.records]
    if expected_total is not None and len(records) != expected_total:
        raise MasterManifestError(
            f"expected {expected_total} approved rows, found {len(records)}"
        )
    validate_unique_source_rows(records)
    split_map = apply_global_splits(
        records,
        ratios=ratios,
        work_targets=work_targets,
        seed=split_seed,
    )
    records.sort(key=lambda record: str(record["id"]))
    verification_statistics = build_verification_statistics(
        records,
        verify_assets=verify_assets,
        library_root=library_root,
    )
    manifest_payload = jsonl_bytes(records)
    split_map_payload = json_bytes(split_map, pretty=True)
    input_catalogs = {
        read.catalog.catalog_id: {
            "asset_resolution": "resolve paths against caller-supplied catalog root",
            "catalog_id": read.catalog.catalog_id,
            "manifest_name": read.catalog.manifest_name,
            "manifest_sha256": read.manifest_sha256,
            "record_count": read.row_count,
            "source_kind": read.catalog.source_kind,
        }
        for read in reads
    }
    report = {
        "algorithm_version": ALGORITHM_VERSION,
        "asset_verification": verification_statistics,
        "catalog_schema_version": CATALOG_SCHEMA_VERSION,
        "inputs": {
            "catalogs": dict(sorted(input_catalogs.items())),
            "storage_root_contracts": {
                "library_root": (
                    "caller-supplied manga library root; distinct from every "
                    "source catalog asset root"
                )
            },
        },
        "outputs": {
            "asset_files_copied": 0,
            "master_manifest": "manifest.jsonl",
            "master_manifest_sha256": sha256_bytes(manifest_payload),
            "split_map": "split_map.json",
            "split_map_sha256": sha256_bytes(split_map_payload),
        },
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "statistics": summarize_records(records),
        "tool": TOOL_ID,
    }
    report_payload = json_bytes(report, pretty=True)
    return BuildBundle(
        records=records,
        manifest_bytes=manifest_payload,
        split_map=split_map,
        split_map_bytes=split_map_payload,
        report=report,
        report_bytes=report_payload,
    )


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def write_bundle(output_dir: Path, bundle: BuildBundle) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    unknown = [
        path
        for path in output_dir.iterdir()
        if path.name not in {"manifest.jsonl", "split_map.json", "report.json"}
    ]
    if unknown:
        raise MasterManifestError(
            f"output directory contains unmanaged files: {unknown[0]}"
        )
    _atomic_write(output_dir / "manifest.jsonl", bundle.manifest_bytes)
    _atomic_write(output_dir / "split_map.json", bundle.split_map_bytes)
    _atomic_write(output_dir / "report.json", bundle.report_bytes)


def read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MasterManifestError(f"could not read {path}: {error}") from error
    if not isinstance(value, dict):
        raise MasterManifestError(f"{path}: expected a JSON object")
    return value


def validate_view_contract(
    view: Any,
    *,
    view_name: str,
    item_id: str,
    catalogs: Mapping[str, SourceCatalog],
    verify_assets: bool,
) -> None:
    location = f"{item_id}.views.{view_name}"
    if not isinstance(view, Mapping):
        raise MasterManifestError(f"{location}: expected an object")
    if view.get("expected_size_px") != [224, 224]:
        raise MasterManifestError(f"{location}: missing 224x224 contract")
    status = view.get("status")
    catalog_id = view.get("catalog_id")
    if catalog_id not in catalogs:
        raise MasterManifestError(f"{location}: unknown catalog {catalog_id!r}")
    if status == "derivable":
        if view_name != "raw_224":
            raise MasterManifestError(
                f"{location}: only raw_224 may use the derivable contract"
            )
        if view.get("path") is not None or view.get("file_sha256") is not None:
            raise MasterManifestError(
                f"{location}: derivable view must have null materialized path and hash"
            )
        if not isinstance(view.get("reason"), str) or not view.get("reason"):
            raise MasterManifestError(f"{location}: derivable view must state a reason")
        source_native = view.get("source_native")
        if not isinstance(source_native, Mapping):
            raise MasterManifestError(f"{location}: missing native source contract")
        if source_native.get("status") != "available":
            raise MasterManifestError(f"{location}: native source is not available")
        if source_native.get("catalog_id") != catalog_id:
            raise MasterManifestError(f"{location}: native source catalog mismatch")
        native_relative = safe_relative_path(
            source_native.get("path"), location=f"{location}.source_native.path"
        )
        if _path_looks_like_overlay(native_relative):
            raise MasterManifestError(f"{location}: native overlay path is forbidden")
        native_hash = valid_sha256(
            source_native.get("file_sha256"),
            location=f"{location}.source_native.file_sha256",
        )
        native_path = resolve_inside(
            catalogs[str(catalog_id)].root,
            native_relative,
            location=f"{location}.source_native.path",
        )
        if not native_path.is_file():
            raise MasterManifestError(
                f"{location}: missing native source {native_relative}"
            )
        expected_recipe = {
            "algorithm": "fontclip-letterbox-rgb-v1",
            "canvas_color_rgb": [255, 255, 255],
            "convert_mode": "RGB",
            "operation": "aspect_preserving_letterbox",
            "placement": "center_floor",
            "resize_filter": "lanczos",
            "rounding": "python_round_then_minimum_1px",
            "target_size_px": [224, 224],
        }
        if view.get("materialization_recipe") != expected_recipe:
            raise MasterManifestError(f"{location}: invalid materialization recipe")
        if verify_assets:
            if sha256_file(native_path) != native_hash:
                raise MasterManifestError(f"{location}: native source hash mismatch")
            verify_native_image(native_path, location=f"{location}.source_native")
        return
    if status == "unavailable":
        if view.get("path") is not None or view.get("file_sha256") is not None:
            raise MasterManifestError(
                f"{location}: unavailable view must have null path and hash"
            )
        if not isinstance(view.get("reason"), str) or not view.get("reason"):
            raise MasterManifestError(
                f"{location}: unavailable view must state a reason"
            )
        return
    if status != "available":
        raise MasterManifestError(f"{location}: invalid status {status!r}")
    if view.get("reason") is not None:
        raise MasterManifestError(f"{location}: available view must have null reason")
    relative = safe_relative_path(view.get("path"), location=f"{location}.path")
    if _path_looks_like_overlay(relative):
        raise MasterManifestError(f"{location}: overlay asset path is forbidden")
    expected_hash = valid_sha256(
        view.get("file_sha256"), location=f"{location}.file_sha256"
    )
    physical = resolve_inside(
        catalogs[str(catalog_id)].root,
        relative,
        location=f"{location}.path",
    )
    if not physical.is_file():
        raise MasterManifestError(f"{location}: missing asset {relative}")
    if verify_assets:
        if sha256_file(physical) != expected_hash:
            raise MasterManifestError(f"{location}: asset hash mismatch")
        verify_224_image(physical, location=location)


def validate_source_page_locator(record: Mapping[str, Any], *, item_id: str) -> None:
    locator = nested(record, "page", "source_locator")
    location = f"{item_id}.page.source_locator"
    if not isinstance(locator, Mapping):
        raise MasterManifestError(f"{location}: expected an object")
    if locator.get("storage_root") != "library_root":
        raise MasterManifestError(f"{location}: must use library_root")
    if locator.get("resolution_contract") != (
        "resolve against caller-supplied library_root"
    ):
        raise MasterManifestError(f"{location}: invalid resolution contract")
    relative = safe_relative_path(locator.get("path"), location=f"{location}.path")
    if _path_looks_like_overlay(relative):
        raise MasterManifestError(f"{location}: overlay path is forbidden")
    locator_hash = valid_sha256(
        locator.get("file_sha256"), location=f"{location}.file_sha256"
    )
    if locator_hash != nested(record, "page", "source_page_sha256"):
        raise MasterManifestError(f"{location}: page hash mismatch")
    size_bytes = locator.get("size_bytes")
    if size_bytes is not None and (
        not isinstance(size_bytes, int)
        or isinstance(size_bytes, bool)
        or size_bytes < 0
    ):
        raise MasterManifestError(f"{location}: invalid size_bytes")
    size_px = locator.get("size_px")
    if size_px is not None and not (
        isinstance(size_px, list)
        and len(size_px) == 2
        and all(isinstance(value, int) and value > 0 for value in size_px)
    ):
        raise MasterManifestError(f"{location}: invalid size_px")


def read_master_records(path: Path) -> tuple[list[dict[str, Any]], str]:
    digest = hashlib.sha256()
    records: list[dict[str, Any]] = []
    try:
        handle = path.open("rb")
    except OSError as error:
        raise MasterManifestError(f"could not read {path}: {error}") from error
    with handle:
        for line_number, payload in enumerate(handle, start=1):
            digest.update(payload)
            if not payload.strip():
                continue
            try:
                row = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise MasterManifestError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(row, dict):
                raise MasterManifestError(f"{path}:{line_number}: expected object")
            records.append(row)
    return records, digest.hexdigest()


def validate_master(
    master_dir: Path,
    catalogs: Sequence[SourceCatalog],
    *,
    expected_total: int | None,
    verify_assets: bool,
    library_root: Path | None = None,
) -> dict[str, Any]:
    catalog_map = {catalog.catalog_id: catalog for catalog in catalogs}
    manifest_path = master_dir / "manifest.jsonl"
    split_map_path = master_dir / "split_map.json"
    report_path = master_dir / "report.json"
    records, manifest_hash = read_master_records(manifest_path)
    split_map = read_json_object(split_map_path)
    report = read_json_object(report_path)
    if expected_total is not None and len(records) != expected_total:
        raise MasterManifestError(
            f"master expected {expected_total} rows, found {len(records)}"
        )
    if report.get("tool") != TOOL_ID:
        raise MasterManifestError("report tool/ownership marker is invalid")
    if report.get("report_schema_version") != REPORT_SCHEMA_VERSION:
        raise MasterManifestError("unsupported report schema version")
    if split_map.get("schema_version") != SPLIT_MAP_SCHEMA_VERSION:
        raise MasterManifestError("unsupported split-map schema version")
    if nested(report, "outputs", "master_manifest_sha256") != manifest_hash:
        raise MasterManifestError("manifest hash does not match report")
    split_payload = split_map_path.read_bytes()
    if nested(report, "outputs", "split_map_sha256") != sha256_bytes(split_payload):
        raise MasterManifestError("split-map hash does not match report")

    seen_ids: set[str] = set()
    seen_sources: set[tuple[str, str]] = set()
    seen_crops: set[str] = set()
    work_splits: dict[str, set[str]] = defaultdict(set)
    group_splits: dict[tuple[str, str], set[str]] = defaultdict(set)
    assignments = split_map.get("work_assignments")
    if not isinstance(assignments, Mapping):
        raise MasterManifestError("split map lacks work_assignments")
    declared_work_targets = nested(split_map, "algorithm", "work_targets")
    if not isinstance(declared_work_targets, Mapping):
        raise MasterManifestError("split map lacks frozen work targets")
    effective_work_targets = validate_work_targets(
        declared_work_targets, total_works=len(assignments)
    )
    observed_work_targets = Counter(str(value) for value in assignments.values())
    if dict(observed_work_targets) != effective_work_targets:
        raise MasterManifestError(
            "split-map work assignments do not satisfy frozen work targets"
        )
    for record in records:
        item_id = text(record.get("id"), location="master.id")
        assert item_id
        if item_id in seen_ids:
            raise MasterManifestError(f"duplicate master id {item_id}")
        seen_ids.add(item_id)
        if record.get("schema_version") != MASTER_SCHEMA_VERSION:
            raise MasterManifestError(f"{item_id}: unsupported schema version")
        if record.get("catalog_version") != CATALOG_SCHEMA_VERSION:
            raise MasterManifestError(f"{item_id}: unsupported catalog version")
        if nested(record, "provenance", "synthetic") is not False:
            raise MasterManifestError(f"{item_id}: synthetic provenance is forbidden")
        if nested(record, "provenance", "qa_overlay") is not False:
            raise MasterManifestError(f"{item_id}: QA overlay provenance is forbidden")
        catalog_id = text(
            nested(record, "provenance", "source_catalog_id"),
            location=f"{item_id}.source_catalog_id",
        )
        source_id = text(
            nested(record, "provenance", "source_id"),
            location=f"{item_id}.source_id",
        )
        assert catalog_id and source_id
        if catalog_id not in catalog_map:
            raise MasterManifestError(f"{item_id}: unknown source catalog {catalog_id}")
        source_key = (catalog_id, source_id)
        if source_key in seen_sources:
            raise MasterManifestError(f"duplicate source row {source_key}")
        seen_sources.add(source_key)
        crop_hash = valid_sha256(
            record.get("sample_crop_sha256"),
            location=f"{item_id}.sample_crop_sha256",
        )
        if crop_hash in seen_crops:
            raise MasterManifestError(f"duplicate crop SHA-256 {crop_hash}")
        seen_crops.add(crop_hash)
        views = record.get("views")
        if not isinstance(views, Mapping) or set(views) != set(VIEW_NAMES):
            raise MasterManifestError(f"{item_id}: views must be exactly {VIEW_NAMES}")
        for view_name in VIEW_NAMES:
            validate_view_contract(
                views[view_name],
                view_name=view_name,
                item_id=item_id,
                catalogs=catalog_map,
                verify_assets=verify_assets,
            )
        validate_source_page_locator(record, item_id=item_id)
        work_id = text(nested(record, "work", "id"), location=f"{item_id}.work.id")
        split = text(record.get("split"), location=f"{item_id}.split")
        assert work_id and split
        if split not in DEFAULT_SPLIT_RATIOS:
            raise MasterManifestError(f"{item_id}: unsupported split {split}")
        if assignments.get(work_id) != split:
            raise MasterManifestError(
                f"{item_id}: split does not match global work assignment"
            )
        work_splits[work_id].add(split)
        groups = record.get("groups")
        if not isinstance(groups, Mapping):
            raise MasterManifestError(f"{item_id}: missing groups")
        for group_name in ("root", "variant", "normalized_glyph"):
            group_id = text(
                groups.get(group_name), location=f"{item_id}.groups.{group_name}"
            )
            assert group_id
            group_splits[(group_name, group_id)].add(split)
    leaking_works = [work for work, splits in work_splits.items() if len(splits) != 1]
    if leaking_works:
        raise MasterManifestError(f"work split leakage: {leaking_works[0]}")
    leaking_groups = [key for key, splits in group_splits.items() if len(splits) != 1]
    if leaking_groups:
        raise MasterManifestError(f"group split leakage: {leaking_groups[0]}")

    observed_statistics = summarize_records(records)
    if report.get("statistics") != observed_statistics:
        raise MasterManifestError("report statistics do not match manifest")
    observed_verification = build_verification_statistics(
        records,
        verify_assets=verify_assets,
        library_root=library_root,
    )
    reported_verification = report.get("asset_verification")
    if not isinstance(reported_verification, Mapping):
        raise MasterManifestError("report lacks asset verification statistics")
    invariant_paths = (
        ("available_224", "unique_catalog_paths"),
        ("derivable_raw_native", "unique_catalog_paths"),
        ("source_page_locators", "reference_count"),
        ("source_page_locators", "unique_catalog_path_count"),
        ("source_page_locators", "unique_library_path_count"),
        ("unavailable_view_reference_count",),
    )
    for path in invariant_paths:
        reported_value: Any = reported_verification
        observed_value: Any = observed_verification
        for part in path:
            reported_value = (
                reported_value.get(part)
                if isinstance(reported_value, Mapping)
                else None
            )
            observed_value = (
                observed_value.get(part)
                if isinstance(observed_value, Mapping)
                else None
            )
        if reported_value != observed_value:
            raise MasterManifestError(
                f"report verification count mismatch: {'.'.join(path)}"
            )
    if verify_assets:
        if reported_verification.get("verification_requested") is not True:
            raise MasterManifestError(
                "master was not built with exhaustive asset verification"
            )
        if reported_verification != observed_verification:
            raise MasterManifestError(
                "asset verification report does not match exhaustive recheck"
            )
    reported_catalogs = nested(report, "inputs", "catalogs")
    if not isinstance(reported_catalogs, Mapping):
        raise MasterManifestError("report lacks source catalog hashes")
    for catalog in catalogs:
        reported = reported_catalogs.get(catalog.catalog_id)
        if not isinstance(reported, Mapping):
            raise MasterManifestError(f"report lacks catalog {catalog.catalog_id}")
        current_hash = sha256_file(catalog.manifest_path)
        if reported.get("manifest_sha256") != current_hash:
            raise MasterManifestError(f"source manifest changed: {catalog.catalog_id}")
    return {
        "manifest_sha256": manifest_hash,
        "record_count": len(records),
        "split_map_sha256": sha256_bytes(split_payload),
        "status": "valid",
    }


def parse_ratios(value: str) -> dict[str, float]:
    try:
        parts = dict(
            (name.strip(), float(ratio))
            for name, ratio in (
                item.split("=", 1) for item in value.split(",") if item.strip()
            )
        )
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(
            "expected train=0.70,val=0.15,test=0.15"
        ) from error
    try:
        return validate_ratios(parts)
    except MasterManifestError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def positive_or_zero(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a non-negative integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("expected a non-negative integer")
    return parsed


def parse_work_targets(value: str) -> dict[str, int]:
    try:
        parts = dict(
            (name.strip(), int(count))
            for name, count in (
                item.split("=", 1) for item in value.split(",") if item.strip()
            )
        )
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("expected train=15,val=4,test=5") from error
    if set(parts) != set(DEFAULT_WORK_TARGETS) or any(
        value < 0 for value in parts.values()
    ):
        raise argparse.ArgumentTypeError(
            "work targets must define non-negative train, val, and test counts"
        )
    return parts


def add_source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--base-root",
        type=Path,
        default=Path("datasets/fontclip-accepted-v1"),
    )
    parser.add_argument(
        "--hard-root",
        type=Path,
        default=Path("datasets/fontclip-hard-accepted-v2"),
    )
    parser.add_argument("--library-root", type=Path, default=Path("library"))
    parser.add_argument("--verify-assets", action="store_true")


def catalogs_from_args(args: argparse.Namespace) -> list[SourceCatalog]:
    return [
        SourceCatalog("fontclip-accepted-v1", "base", args.base_root.resolve()),
        SourceCatalog("fontclip-hard-accepted-v2", "hard", args.hard_root.resolve()),
    ]


def expected_counts_from_args(args: argparse.Namespace) -> dict[str, int]:
    return {
        "fontclip-accepted-v1": args.expected_base,
        "fontclip-hard-accepted-v2": args.expected_hard,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("build", "report"):
        sub = subparsers.add_parser(command)
        add_source_arguments(sub)
        sub.add_argument(
            "--expected-base", type=positive_or_zero, default=EXPECTED_BASE_ROWS
        )
        sub.add_argument(
            "--expected-hard", type=positive_or_zero, default=EXPECTED_HARD_ROWS
        )
        sub.add_argument(
            "--expected-total", type=positive_or_zero, default=EXPECTED_TOTAL_ROWS
        )
        sub.add_argument(
            "--split-ratios",
            type=parse_ratios,
            default=dict(DEFAULT_SPLIT_RATIOS),
        )
        sub.add_argument(
            "--work-targets",
            type=parse_work_targets,
            default=dict(DEFAULT_WORK_TARGETS),
            help="frozen work counts; default guarantees five unseen test works",
        )
        sub.add_argument("--split-seed", default=ALGORITHM_VERSION)
        if command == "build":
            sub.add_argument(
                "--output-dir",
                type=Path,
                default=Path("datasets/font-matching-master-v1"),
            )
            sub.add_argument(
                "--dry-run",
                action="store_true",
                help="validate and report without creating the output directory",
            )

    validate_parser = subparsers.add_parser("validate")
    add_source_arguments(validate_parser)
    validate_parser.add_argument(
        "--master-dir",
        type=Path,
        default=Path("datasets/font-matching-master-v1"),
    )
    validate_parser.add_argument(
        "--expected-total", type=positive_or_zero, default=EXPECTED_TOTAL_ROWS
    )
    return parser


def _compact_summary(report: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "asset_files_copied": nested(report, "outputs", "asset_files_copied"),
        "by_catalog": nested(report, "statistics", "by_catalog"),
        "by_split": nested(report, "statistics", "by_split"),
        "manifest_sha256": nested(report, "outputs", "master_manifest_sha256"),
        "record_count": nested(report, "statistics", "record_count"),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        catalogs = catalogs_from_args(args)
        if args.command in {"build", "report"}:
            bundle = build_bundle(
                catalogs,
                expected_counts=expected_counts_from_args(args),
                expected_total=args.expected_total,
                split_ratios=args.split_ratios,
                work_targets=args.work_targets,
                split_seed=args.split_seed,
                verify_assets=args.verify_assets,
                library_root=args.library_root.resolve(),
            )
            if args.command == "report" or args.dry_run:
                print(bundle.report_bytes.decode("utf-8"), end="")
                return 0
            write_bundle(args.output_dir.resolve(), bundle)
            print(canonical_json(_compact_summary(bundle.report)))
            return 0
        result = validate_master(
            args.master_dir.resolve(),
            catalogs,
            expected_total=args.expected_total,
            verify_assets=args.verify_assets,
            library_root=args.library_root.resolve(),
        )
        print(canonical_json(result))
        return 0
    except (MasterManifestError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
