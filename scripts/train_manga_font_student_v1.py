#!/usr/bin/env python3
"""Train the application-specific 22-font SigLIP2 student.

The trainer joins balanced three-view synthetic examples with sealed human-gold
train/validation rows.  Human test rows are recognized with a byte-level
top-level ``split`` scanner and are never JSON-deserialized; their views are
therefore impossible to resolve from this process.  The local pinned SigLIP2
vision tower is frozen except for its final four encoder blocks.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import math
import os
import random
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping, Sequence

import numpy as np


MODEL_ID = "google/siglip2-base-patch16-224"
MODEL_REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
PROCESSOR_USE_FAST = False
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
CANDIDATE_COUNT = 22
PROJECTION_DIM = 256
TRAINABLE_VISION_BLOCKS = 4

SYNTHETIC_SCHEMA = "manga-font-synthetic-v1"
SYNTHETIC_REPORT_SCHEMA = "manga-font-synthetic-report-v1"
HUMAN_EXPORT_SCHEMA = "font-matching-training-export-v1"
HUMAN_EXPORT_REPORT_SCHEMA = "font-matching-training-export-report-v1"
HUMAN_SAMPLE_SCHEMA = "font-matching-training-sample-v1"
HUMAN_EXPORT_OWNER = "carrot-manga-translator/font-matching-training-export"
HUMAN_EXPORT_MARKER = ".font-matching-training-export-owned.json"

OUTPUT_SCHEMA = "manga-font-student-v1"
MODEL_CONTRACT_SCHEMA = "manga-font-student-model-contract-v1"
TRAINING_REPORT_SCHEMA = "manga-font-student-training-report-v1"
PREDICTION_SCHEMA = "manga-font-student-val-prediction-v1"
OUTPUT_OWNER = "carrot-manga-translator/manga-font-student-v1"
OUTPUT_MARKER = ".manga-font-student-v1-owned.json"
CHECKPOINT_FILE = "checkpoint.safetensors"
CONTRACT_FILE = "model-contract.json"
REPORT_FILE = "report.json"
PREDICTIONS_FILE = "predictions-val.jsonl"
PROTOTYPE_FILE = "prototype-features.f32"
OUTPUT_FILES = frozenset(
    {
        OUTPUT_MARKER,
        CHECKPOINT_FILE,
        CONTRACT_FILE,
        REPORT_FILE,
        PREDICTIONS_FILE,
        PROTOTYPE_FILE,
    }
)
OUTPUT_ARTIFACTS = (
    CHECKPOINT_FILE,
    CONTRACT_FILE,
    REPORT_FILE,
    PREDICTIONS_FILE,
    PROTOTYPE_FILE,
)

ROLE_VALUES = (
    "dialogue",
    "narration",
    "thought",
    "whisper",
    "aside_balloon_edge",
    "emphasis_dialogue",
    "shout",
    "sfx_impact",
    "sfx_motion",
    "sfx_ambient",
    "sfx_emotion",
    "sfx_comic",
    "sign_ui_title",
    "other",
)
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
TREATMENT_VALUES: Mapping[str, tuple[str, ...]] = {
    "orientation": ("horizontal", "vertical", "mixed", "unknown"),
    "outline": ("none", "single", "double", "multiple", "unknown"),
    "shadow": ("none", "hard", "soft", "multiple", "unknown"),
    "fill": ("solid", "gradient", "pattern", "inverse", "transparent", "unknown"),
    "distortion": (
        "none",
        "slant",
        "perspective",
        "warp",
        "wave",
        "jitter",
        "other",
        "unknown",
    ),
}

HUMAN_JUDGMENT_KEYS = frozenset(
    {
        "preferred",
        "acceptable",
        "marginal",
        "unacceptable",
        "unrenderable",
        "not_reviewed",
        "none_acceptable",
    }
)
HUMAN_TIERS = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
    "not_reviewed",
)
SYNTHETIC_ROW_KEYS = frozenset(
    {
        "augmentation",
        "font_id",
        "font_label",
        "font_sha256",
        "orientation",
        "record_sha256",
        "role",
        "sample_id",
        "schema_version",
        "seed",
        "split",
        "synthetic",
        "text",
        "variant_role",
        "views",
    }
)
SHA_CHARS = frozenset("0123456789abcdef")


class MangaFontStudentError(ValueError):
    """Raised when the training boundary or owned output is invalid."""


@dataclass(frozen=True)
class SyntheticExample:
    sample_id: str
    split: str
    font_id: str
    label_index: int
    views: Mapping[str, Mapping[str, Any]]


@dataclass(frozen=True)
class HumanExample:
    sample_id: str
    work_id: str
    split: str
    positive_indices: tuple[int, ...]
    eligible_indices: tuple[int, ...]
    none_target: float
    role_index: int
    style_values: tuple[float, ...]
    style_mask: tuple[bool, ...]
    treatment_indices: tuple[int, ...]
    row: Mapping[str, Any]


@dataclass(frozen=True)
class SyntheticSnapshot:
    root: Path
    candidate_ids: tuple[str, ...]
    train_examples: tuple[SyntheticExample, ...]
    manifest_sha256: str
    report_sha256: str
    record_count: int


@dataclass(frozen=True)
class HumanSnapshot:
    root: Path
    train_examples: tuple[HumanExample, ...]
    val_examples: tuple[HumanExample, ...]
    skipped_test_rows: int
    marker_sha256: str
    manifest_sha256: str
    report_sha256: str
    samples_sha256: str


@dataclass(frozen=True)
class EpochBatch:
    synthetic_indices: tuple[int, ...]
    human_indices: tuple[int, ...]


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output["record_sha256"] = sha256_bytes(canonical_json(core).encode("utf-8"))
    return output


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    declared = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != declared:
        raise MangaFontStudentError(f"{location}: record seal mismatch")
    return actual


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontStudentError(f"{location}: expected object")
    return value


def require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise MangaFontStudentError(f"{location}: expected list")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MangaFontStudentError(f"{location}: expected non-empty text")
    return value.strip()


def require_sha(value: Any, location: str) -> str:
    text = require_text(value, location).lower()
    if len(text) != 64 or any(character not in SHA_CHARS for character in text):
        raise MangaFontStudentError(f"{location}: expected SHA-256")
    return text


def require_nonnegative_int(value: Any, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MangaFontStudentError(f"{location}: expected non-negative integer")
    return value


def require_probability(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MangaFontStudentError(f"{location}: expected probability")
    result = float(value)
    if not math.isfinite(result) or result < 0.0 or result > 1.0:
        raise MangaFontStudentError(f"{location}: probability outside [0, 1]")
    return result


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise MangaFontStudentError(f"{location}: missing or linked file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MangaFontStudentError(f"{location}: invalid JSON: {error}") from error
    return dict(require_mapping(value, location))


def safe_relative_path(value: Any, *, location: str) -> Path:
    text = require_text(value, location)
    pure = PurePosixPath(text)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise MangaFontStudentError(f"{location}: unsafe relative path")
    if ":" in pure.parts[0] or "\\" in text:
        raise MangaFontStudentError(f"{location}: unsafe relative path")
    return Path(*pure.parts)


def resolve_inside(root: Path, relative: Path, *, location: str) -> Path:
    unresolved = root / relative
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise MangaFontStudentError(f"{location}: linked path component")
    resolved = unresolved.resolve()
    if root != resolved and root not in resolved.parents:
        raise MangaFontStudentError(f"{location}: path escapes input root")
    if resolved.is_symlink() or not resolved.is_file():
        raise MangaFontStudentError(f"{location}: missing or linked asset")
    return resolved


def assert_exact_root_inventory(
    root: Path, expected: set[str], *, location: str
) -> None:
    if root.is_symlink() or not root.is_dir():
        raise MangaFontStudentError(f"{location}: missing or linked directory")
    names = {path.name for path in root.iterdir()}
    if names != expected:
        raise MangaFontStudentError(
            f"{location}: inventory mismatch missing={sorted(expected - names)} "
            f"extra={sorted(names - expected)}"
        )


def _skip_json_whitespace(payload: bytes, offset: int) -> int:
    while offset < len(payload) and payload[offset] in b" \t\r\n":
        offset += 1
    return offset


def _scan_json_string_end(payload: bytes, offset: int) -> int:
    if offset >= len(payload) or payload[offset] != 0x22:
        raise MangaFontStudentError("human sample is not a JSON object")
    offset += 1
    escaped = False
    while offset < len(payload):
        byte = payload[offset]
        if escaped:
            escaped = False
        elif byte == 0x5C:
            escaped = True
        elif byte == 0x22:
            return offset + 1
        offset += 1
    raise MangaFontStudentError("unterminated JSON string in human sample")


def _skip_json_value(payload: bytes, offset: int) -> int:
    offset = _skip_json_whitespace(payload, offset)
    if offset >= len(payload):
        raise MangaFontStudentError("missing JSON value in human sample")
    if payload[offset] == 0x22:
        return _scan_json_string_end(payload, offset)
    if payload[offset] in (0x7B, 0x5B):
        closing_stack = [0x7D if payload[offset] == 0x7B else 0x5D]
        offset += 1
        while offset < len(payload) and closing_stack:
            byte = payload[offset]
            if byte == 0x22:
                offset = _scan_json_string_end(payload, offset)
                continue
            if byte == 0x7B:
                closing_stack.append(0x7D)
            elif byte == 0x5B:
                closing_stack.append(0x5D)
            elif byte in (0x7D, 0x5D):
                if byte != closing_stack[-1]:
                    raise MangaFontStudentError(
                        "mismatched JSON container in human sample"
                    )
                closing_stack.pop()
            offset += 1
        if closing_stack:
            raise MangaFontStudentError("unterminated JSON value in human sample")
        return offset
    while offset < len(payload) and payload[offset] not in b",}]":
        offset += 1
    return offset


def top_level_string_field_without_deserializing(
    payload: bytes, field: str
) -> str:
    """Read one top-level string while treating every other value as opaque bytes."""

    offset = _skip_json_whitespace(payload, 0)
    if offset >= len(payload) or payload[offset] != 0x7B:
        raise MangaFontStudentError("human sample must be a JSON object")
    offset += 1
    found: str | None = None
    while True:
        offset = _skip_json_whitespace(payload, offset)
        if offset >= len(payload):
            raise MangaFontStudentError("unterminated human sample JSON")
        if payload[offset] == 0x7D:
            break
        key_end = _scan_json_string_end(payload, offset)
        try:
            key = json.loads(payload[offset:key_end])
        except json.JSONDecodeError as error:
            raise MangaFontStudentError("invalid human sample key") from error
        offset = _skip_json_whitespace(payload, key_end)
        if offset >= len(payload) or payload[offset] != 0x3A:
            raise MangaFontStudentError("human sample key lacks colon")
        value_start = _skip_json_whitespace(payload, offset + 1)
        value_end = _skip_json_value(payload, value_start)
        if key == field:
            if found is not None or payload[value_start : value_start + 1] != b'"':
                raise MangaFontStudentError(f"human sample has invalid {field}")
            try:
                value = json.loads(payload[value_start:value_end])
            except json.JSONDecodeError as error:
                raise MangaFontStudentError(f"human sample has invalid {field}") from error
            if not isinstance(value, str):
                raise MangaFontStudentError(f"human sample has non-string {field}")
            found = value
        offset = _skip_json_whitespace(payload, value_end)
        if offset < len(payload) and payload[offset] == 0x2C:
            offset += 1
            continue
        if offset < len(payload) and payload[offset] == 0x7D:
            break
        raise MangaFontStudentError("human sample object separator is invalid")
    if found is None:
        raise MangaFontStudentError(f"human sample is missing top-level {field}")
    return found


def _validate_synthetic_view(
    root: Path, value: Any, *, split: str, font_id: str, location: str
) -> Mapping[str, Any]:
    descriptor = require_mapping(value, location)
    if set(descriptor) != {"byte_size", "path", "sha256", "size_px"}:
        raise MangaFontStudentError(f"{location}: descriptor schema drifted")
    if descriptor.get("size_px") != [224, 224]:
        raise MangaFontStudentError(f"{location}: expected 224x224")
    expected_size = require_nonnegative_int(descriptor.get("byte_size"), f"{location}.byte_size")
    expected_sha = require_sha(descriptor.get("sha256"), f"{location}.sha256")
    relative = safe_relative_path(descriptor.get("path"), location=f"{location}.path")
    if relative.parts[:3] != ("images", split, font_id):
        raise MangaFontStudentError(f"{location}: split/font path binding drifted")
    physical = resolve_inside(root, relative, location=f"{location}.path")
    if physical.stat().st_size != expected_size or expected_size < 1:
        raise MangaFontStudentError(f"{location}: byte-size binding drifted")
    # Pixels are verified lazily when and only when a train example is consumed.
    return {**dict(descriptor), "sha256": expected_sha, "_physical_path": str(physical)}


def validate_synthetic_input(
    synthetic_dir: Path, *, catalog_registry_sha256: str
) -> SyntheticSnapshot:
    root = synthetic_dir.expanduser().resolve()
    assert_exact_root_inventory(
        root,
        {"images", "manifests", "manifest.jsonl", "report.json"},
        location="synthetic input",
    )
    for directory in (root / "images", root / "manifests"):
        if directory.is_symlink() or not directory.is_dir():
            raise MangaFontStudentError("synthetic image/manifest root is unsafe")
    report_path = root / "report.json"
    manifest_path = root / "manifest.jsonl"
    report = read_json(report_path, location="synthetic report")
    validate_record_seal(report, location="synthetic report")
    if report.get("schema_version") != SYNTHETIC_REPORT_SCHEMA:
        raise MangaFontStudentError("synthetic report schema is unsupported")
    candidate_ids = tuple(
        require_text(value, f"synthetic report.candidate_ids[{index}]")
        for index, value in enumerate(
            require_list(report.get("candidate_ids"), "synthetic report.candidate_ids")
        )
    )
    if (
        len(candidate_ids) != CANDIDATE_COUNT
        or len(candidate_ids) != len(set(candidate_ids))
        or report.get("candidate_count") != CANDIDATE_COUNT
    ):
        raise MangaFontStudentError("synthetic candidate inventory must be exact 22")
    bindings = require_mapping(report.get("bindings"), "synthetic report.bindings")
    if bindings.get("catalog_registry_sha256") != catalog_registry_sha256:
        raise MangaFontStudentError("synthetic input binds another catalog registry")
    manifest_sha = sha256_file(manifest_path)
    if report.get("manifest_sha256") != manifest_sha:
        raise MangaFontStudentError("synthetic manifest hash binding failed")

    candidate_index = {candidate_id: index for index, candidate_id in enumerate(candidate_ids)}
    counts: dict[str, int] = {candidate_id: 0 for candidate_id in candidate_ids}
    split_counts: dict[str, int] = {split: 0 for split in ("train", "val", "test")}
    train_examples: list[SyntheticExample] = []
    record_count = 0
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = require_mapping(json.loads(line), f"synthetic row {line_number}")
            except json.JSONDecodeError as error:
                raise MangaFontStudentError(
                    f"synthetic row {line_number}: invalid JSON"
                ) from error
            if set(row) != SYNTHETIC_ROW_KEYS:
                raise MangaFontStudentError(
                    f"synthetic row {line_number}: schema drifted"
                )
            validate_record_seal(row, location=f"synthetic row {line_number}")
            if row.get("schema_version") != SYNTHETIC_SCHEMA or row.get("synthetic") is not True:
                raise MangaFontStudentError(
                    f"synthetic row {line_number}: provenance drifted"
                )
            split = require_text(row.get("split"), f"synthetic row {line_number}.split")
            if split not in split_counts:
                raise MangaFontStudentError("synthetic split is unsupported")
            font_id = require_text(row.get("font_id"), f"synthetic row {line_number}.font_id")
            if font_id not in candidate_index:
                raise MangaFontStudentError("synthetic row names an unknown font")
            views = require_mapping(row.get("views"), f"synthetic row {line_number}.views")
            if set(views) != set(VIEW_NAMES):
                raise MangaFontStudentError("synthetic row requires all three views")
            validated_views = {
                view_name: _validate_synthetic_view(
                    root,
                    views.get(view_name),
                    split=split,
                    font_id=font_id,
                    location=f"synthetic row {line_number}.views.{view_name}",
                )
                for view_name in VIEW_NAMES
            }
            record_count += 1
            counts[font_id] += 1
            split_counts[split] += 1
            if split == "train":
                train_examples.append(
                    SyntheticExample(
                        sample_id=require_text(
                            row.get("sample_id"), f"synthetic row {line_number}.sample_id"
                        ),
                        split=split,
                        font_id=font_id,
                        label_index=candidate_index[font_id],
                        views=validated_views,
                    )
                )
    if record_count != report.get("record_count") or split_counts != {
        key: int(value) for key, value in require_mapping(
            report.get("split_counts"), "synthetic report.split_counts"
        ).items()
    }:
        raise MangaFontStudentError("synthetic manifest/report counts drifted")
    expected_per_font = report.get("samples_per_font")
    if not isinstance(expected_per_font, int) or any(
        count != expected_per_font for count in counts.values()
    ):
        raise MangaFontStudentError("synthetic font balance drifted")
    if not train_examples:
        raise MangaFontStudentError("synthetic train split is empty")
    return SyntheticSnapshot(
        root=root,
        candidate_ids=candidate_ids,
        train_examples=tuple(train_examples),
        manifest_sha256=manifest_sha,
        report_sha256=sha256_file(report_path),
        record_count=record_count,
    )


def _artifact_descriptor(
    manifest: Mapping[str, Any], name: str, *, location: str
) -> Mapping[str, Any]:
    artifacts = require_mapping(manifest.get("artifacts"), f"{location}.artifacts")
    descriptor = require_mapping(artifacts.get(name), f"{location}.artifacts.{name}")
    if descriptor.get("file") != name:
        raise MangaFontStudentError(f"{location}: artifact file binding drifted")
    return descriptor


def _validate_human_row(
    row: Mapping[str, Any],
    *,
    split: str,
    candidate_ids: tuple[str, ...],
    catalog_registry_sha256: str,
    location: str,
) -> HumanExample:
    validate_record_seal(row, location=location)
    if row.get("schema_version") != HUMAN_SAMPLE_SCHEMA or row.get("split") != split:
        raise MangaFontStudentError(f"{location}: schema/split drifted")
    provenance = require_mapping(row.get("provenance"), f"{location}.provenance")
    if (
        provenance.get("approval") != "completed_human_final_label"
        or provenance.get("synthetic") is not False
        or provenance.get("qa_overlay") is not False
    ):
        raise MangaFontStudentError(f"{location}: not completed human gold")
    input_bindings = require_mapping(row.get("input_bindings"), f"{location}.input_bindings")
    if input_bindings.get("catalog_registry_sha256") != catalog_registry_sha256:
        raise MangaFontStudentError(f"{location}: catalog registry binding drifted")
    source = require_mapping(row.get("source"), f"{location}.source")
    views = require_mapping(source.get("views"), f"{location}.source.views")
    if set(views) != set(VIEW_NAMES):
        raise MangaFontStudentError(f"{location}: requires all three views")
    judgment = require_mapping(row.get("font_judgment"), f"{location}.font_judgment")
    if set(judgment) != HUMAN_JUDGMENT_KEYS:
        raise MangaFontStudentError(f"{location}: judgment schema drifted")
    tier_values: dict[str, tuple[str, ...]] = {}
    flattened: list[str] = []
    for tier in HUMAN_TIERS:
        values = tuple(
            require_text(value, f"{location}.font_judgment.{tier}[{index}]")
            for index, value in enumerate(
                require_list(judgment.get(tier), f"{location}.font_judgment.{tier}")
            )
        )
        if len(values) != len(set(values)):
            raise MangaFontStudentError(f"{location}: duplicate candidate in {tier}")
        tier_values[tier] = values
        flattened.extend(values)
    if len(flattened) != len(candidate_ids) or set(flattened) != set(candidate_ids):
        raise MangaFontStudentError(f"{location}: tiers do not partition 22 fonts")
    if tier_values["not_reviewed"]:
        raise MangaFontStudentError(f"{location}: human label is incomplete")
    positives = (*tier_values["preferred"], *tier_values["acceptable"])
    none_acceptable = judgment.get("none_acceptable")
    if not isinstance(none_acceptable, bool) or none_acceptable == bool(positives):
        raise MangaFontStudentError(f"{location}: none/acceptable semantics drifted")
    candidate_index = {candidate_id: index for index, candidate_id in enumerate(candidate_ids)}
    unrenderable = set(tier_values["unrenderable"])
    eligible = tuple(
        index for index, candidate_id in enumerate(candidate_ids) if candidate_id not in unrenderable
    )
    role = require_mapping(row.get("role"), f"{location}.role")
    primary_role = require_text(role.get("primary"), f"{location}.role.primary")
    if primary_role not in ROLE_VALUES:
        raise MangaFontStudentError(f"{location}: unsupported role {primary_role!r}")
    source_style = require_mapping(row.get("source_style"), f"{location}.source_style")
    unknown_style_fields = set(
        require_list(
            source_style.get("unknown_fields"),
            f"{location}.source_style.unknown_fields",
        )
    )
    if not unknown_style_fields <= set(STYLE_FIELDS):
        raise MangaFontStudentError(f"{location}: unknown style field name")
    style_values: list[float] = []
    style_mask: list[bool] = []
    for field in STYLE_FIELDS:
        value = source_style.get(field)
        known = field not in unknown_style_fields and value is not None
        if known:
            style_values.append(
                require_probability(value, f"{location}.source_style.{field}")
            )
        else:
            if field not in unknown_style_fields or value is not None:
                raise MangaFontStudentError(
                    f"{location}: style unknown mask/value mismatch"
                )
            style_values.append(0.0)
        style_mask.append(known)
    treatment = require_mapping(row.get("treatment"), f"{location}.treatment")
    if set(treatment) != set(TREATMENT_VALUES):
        raise MangaFontStudentError(f"{location}: treatment schema drifted")
    treatment_indices: list[int] = []
    for field, values in TREATMENT_VALUES.items():
        treatment_value = require_text(
            treatment.get(field), f"{location}.treatment.{field}"
        )
        if treatment_value not in values:
            raise MangaFontStudentError(
                f"{location}: unsupported {field} treatment {treatment_value!r}"
            )
        treatment_indices.append(values.index(treatment_value))
    return HumanExample(
        sample_id=require_text(row.get("sample_id"), f"{location}.sample_id"),
        work_id=require_text(row.get("work_id"), f"{location}.work_id"),
        split=split,
        positive_indices=tuple(candidate_index[value] for value in positives),
        eligible_indices=eligible,
        none_target=float(none_acceptable),
        role_index=ROLE_VALUES.index(primary_role),
        style_values=tuple(style_values),
        style_mask=tuple(style_mask),
        treatment_indices=tuple(treatment_indices),
        row=copy.deepcopy(dict(row)),
    )


def validate_human_input(
    human_export_dir: Path,
    *,
    candidate_ids: tuple[str, ...],
    catalog_registry_sha256: str,
) -> HumanSnapshot:
    root = human_export_dir.expanduser().resolve()
    marker_path = root / HUMAN_EXPORT_MARKER
    manifest_path = root / "manifest.json"
    report_path = root / "report.json"
    samples_path = root / "samples.jsonl"
    marker = read_json(marker_path, location="human export marker")
    manifest = read_json(manifest_path, location="human export manifest")
    report = read_json(report_path, location="human export report")
    if set(marker) != {
        "manifest_sha256",
        "owner",
        "report_sha256",
        "safe_replace",
        "schema_version",
    } or (
        marker.get("owner") != HUMAN_EXPORT_OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != HUMAN_EXPORT_SCHEMA
    ):
        raise MangaFontStudentError("human export ownership marker is invalid")
    manifest_sha = sha256_file(manifest_path)
    report_sha = sha256_file(report_path)
    if (
        marker.get("manifest_sha256") != manifest_sha
        or marker.get("report_sha256") != report_sha
        or report.get("manifest_sha256") != manifest_sha
    ):
        raise MangaFontStudentError("human export metadata hash binding failed")
    if (
        manifest.get("schema_version") != HUMAN_EXPORT_SCHEMA
        or report.get("schema_version") != HUMAN_EXPORT_REPORT_SCHEMA
        or manifest.get("candidate_count") != len(candidate_ids)
        or len(candidate_ids) != CANDIDATE_COUNT
    ):
        raise MangaFontStudentError("human export schema/candidate count drifted")
    registry = require_mapping(manifest.get("registry_exclusions"), "human manifest.registry_exclusions")
    if registry.get("catalog_registry_sha256") != catalog_registry_sha256:
        raise MangaFontStudentError("human export binds another catalog registry")
    contracts = require_mapping(manifest.get("contracts"), "human manifest.contracts")
    source_contract = require_mapping(contracts.get("source_inputs"), "human contracts.source_inputs")
    isolation = require_mapping(contracts.get("augmentation_isolation"), "human contracts.augmentation_isolation")
    evaluation = require_mapping(contracts.get("evaluation"), "human contracts.evaluation")
    if (
        source_contract.get("review_card_pixels_allowed") is not False
        or source_contract.get("required_views") != list(VIEW_NAMES)
        or isolation.get("core_files_accept_synthetic") is not False
        or isolation.get("evaluation_splits_accept_generated") is not False
        or evaluation.get("generated_examples_allowed") is not False
        or evaluation.get("qa_overlay_examples_allowed") is not False
    ):
        raise MangaFontStudentError("human export source/evaluation contract is unsafe")
    checks = require_mapping(report.get("checks"), "human report.checks")
    for key in ("core_qa_overlay_count", "core_synthetic_count", "generated_evaluation_count"):
        if checks.get(key) != 0:
            raise MangaFontStudentError(f"human export report check failed: {key}")

    artifacts = require_mapping(manifest.get("artifacts"), "human manifest.artifacts")
    artifact_names = {require_text(name, "human artifact name") for name in artifacts}
    assert_exact_root_inventory(
        root,
        {HUMAN_EXPORT_MARKER, "manifest.json", "report.json", *artifact_names},
        location="human export",
    )
    report_outputs = require_mapping(report.get("outputs"), "human report.outputs")
    for name in sorted(artifact_names):
        descriptor = _artifact_descriptor(manifest, name, location="human manifest")
        if set(descriptor) != {"byte_size", "file", "record_count", "sha256"}:
            raise MangaFontStudentError(f"human artifact {name}: descriptor drifted")
        path = resolve_inside(root, Path(name), location=f"human artifact {name}")
        if (
            require_nonnegative_int(descriptor.get("byte_size"), f"{name}.byte_size")
            != path.stat().st_size
            or require_sha(descriptor.get("sha256"), f"{name}.sha256")
            != sha256_file(path)
            or report_outputs.get(name) != descriptor
        ):
            raise MangaFontStudentError(f"human artifact {name}: hash binding drifted")

    samples_descriptor = _artifact_descriptor(manifest, "samples.jsonl", location="human manifest")
    digest = hashlib.sha256()
    row_count = 0
    skipped_test = 0
    train_rows: list[HumanExample] = []
    val_rows: list[HumanExample] = []
    train_works: set[str] = set()
    val_works: set[str] = set()
    with samples_path.open("rb") as handle:
        for raw_line in handle:
            digest.update(raw_line)
            if not raw_line.strip():
                continue
            row_count += 1
            split = top_level_string_field_without_deserializing(raw_line, "split")
            if split == "test":
                skipped_test += 1
                continue
            if split not in {"train", "val"}:
                raise MangaFontStudentError(f"human sample has unsupported split {split!r}")
            try:
                row = require_mapping(json.loads(raw_line), f"human {split} row {row_count}")
            except json.JSONDecodeError as error:
                raise MangaFontStudentError(f"human {split} row {row_count}: invalid JSON") from error
            example = _validate_human_row(
                row,
                split=split,
                candidate_ids=candidate_ids,
                catalog_registry_sha256=catalog_registry_sha256,
                location=f"human {split} row {row_count}",
            )
            if split == "train":
                train_rows.append(example)
                train_works.add(example.work_id)
            else:
                val_rows.append(example)
                val_works.add(example.work_id)
    if train_works & val_works:
        raise MangaFontStudentError("human train/val work leakage detected")
    if not train_rows or not val_rows:
        raise MangaFontStudentError("human train and val rows are both required")
    if (
        digest.hexdigest() != samples_descriptor.get("sha256")
        or row_count != samples_descriptor.get("record_count")
        or samples_path.stat().st_size != samples_descriptor.get("byte_size")
        or manifest.get("real_sample_count") != row_count
    ):
        raise MangaFontStudentError("human samples artifact binding drifted")
    return HumanSnapshot(
        root=root,
        train_examples=tuple(train_rows),
        val_examples=tuple(val_rows),
        skipped_test_rows=skipped_test,
        marker_sha256=sha256_file(marker_path),
        manifest_sha256=manifest_sha,
        report_sha256=report_sha,
        samples_sha256=digest.hexdigest(),
    )


def build_epoch_batches(
    *,
    synthetic_count: int,
    human_count: int,
    batch_size: int,
    human_fraction: float,
    seed: int,
) -> tuple[EpochBatch, ...]:
    if synthetic_count < 1 or human_count < 1:
        raise MangaFontStudentError("mixed training requires synthetic and human rows")
    if batch_size < 4 or not 0.05 <= human_fraction <= 0.5:
        raise MangaFontStudentError("invalid mixed-batch configuration")
    human_per_batch = max(1, round(batch_size * human_fraction))
    synthetic_per_batch = batch_size - human_per_batch
    if synthetic_per_batch < 1:
        raise MangaFontStudentError("mixed batch has no synthetic rows")
    rng = random.Random(seed)
    synthetic_indices = list(range(synthetic_count))
    rng.shuffle(synthetic_indices)
    output: list[EpochBatch] = []
    for offset in range(0, synthetic_count, synthetic_per_batch):
        synthetic_batch = tuple(synthetic_indices[offset : offset + synthetic_per_batch])
        human_batch = tuple(rng.randrange(human_count) for _ in range(human_per_batch))
        output.append(EpochBatch(synthetic_batch, human_batch))
    return tuple(output)


def soft_target_and_mask(
    *,
    candidate_count: int,
    positive_indices: Sequence[int],
    eligible_indices: Sequence[int],
) -> tuple[tuple[float, ...], tuple[bool, ...]]:
    positives = tuple(dict.fromkeys(int(value) for value in positive_indices))
    eligible = frozenset(int(value) for value in eligible_indices)
    if any(value < 0 or value >= candidate_count for value in (*positives, *eligible)):
        raise MangaFontStudentError("soft target index outside vocabulary")
    if any(value not in eligible for value in positives):
        raise MangaFontStudentError("positive font is masked as unrenderable")
    mass = 1.0 / len(positives) if positives else 0.0
    target = tuple(mass if index in positives else 0.0 for index in range(candidate_count))
    mask = tuple(index in eligible for index in range(candidate_count))
    return target, mask


def metric_priority_key(metrics: Mapping[str, Any]) -> tuple[float, float, float]:
    return (
        require_probability(metrics.get("acceptable_at1"), "metrics.acceptable_at1"),
        require_probability(metrics.get("recall_at3"), "metrics.recall_at3"),
        -float(metrics.get("soft_listwise_loss", math.inf)),
    )


def is_better_metrics(
    candidate: Mapping[str, Any], best: Mapping[str, Any] | None, *, min_delta: float
) -> bool:
    if best is None:
        return True
    left = metric_priority_key(candidate)
    right = metric_priority_key(best)
    if left[0] > right[0] + min_delta:
        return True
    if abs(left[0] - right[0]) <= min_delta and left[1] > right[1] + min_delta:
        return True
    return (
        abs(left[0] - right[0]) <= min_delta
        and abs(left[1] - right[1]) <= min_delta
        and left[2] > right[2] + min_delta
    )


def configure_last_vision_blocks(vision_encoder: Any, *, block_count: int = 4) -> tuple[int, ...]:
    vision_encoder.requires_grad_(False)
    vision_model = getattr(vision_encoder, "vision_model", None)
    encoder = getattr(vision_model, "encoder", None)
    layers = getattr(encoder, "layers", None)
    if layers is None or len(layers) < block_count:
        raise MangaFontStudentError("SigLIP2 vision block inventory is unsupported")
    start = len(layers) - block_count
    for layer in layers[start:]:
        layer.requires_grad_(True)
    trainable = tuple(index for index, layer in enumerate(layers) if any(
        parameter.requires_grad for parameter in layer.parameters()
    ))
    expected = tuple(range(start, len(layers)))
    if trainable != expected:
        raise MangaFontStudentError("vision freeze boundary drifted")
    return expected


def _load_training_dependencies() -> tuple[Any, Any, Any, Callable[..., Any]]:
    try:
        import torch
        from safetensors.torch import save_file
        from transformers import AutoImageProcessor, SiglipVisionModel
    except (ImportError, OSError) as error:  # pragma: no cover - environment setup
        raise MangaFontStudentError(
            "training requires torch, transformers, Pillow, and safetensors"
        ) from error
    return torch, AutoImageProcessor, SiglipVisionModel, save_file


def _configure_reproducibility(torch: Any, *, seed: int) -> None:
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    if hasattr(torch.backends.cuda.matmul, "allow_tf32"):
        torch.backends.cuda.matmul.allow_tf32 = False
    if hasattr(torch.backends.cudnn, "allow_tf32"):
        torch.backends.cudnn.allow_tf32 = False


def build_student_model(
    torch: Any,
    *,
    vision_encoder: Any,
    candidate_count: int,
) -> tuple[Any, tuple[int, ...]]:
    trainable_blocks = configure_last_vision_blocks(
        vision_encoder, block_count=TRAINABLE_VISION_BLOCKS
    )
    hidden_size = int(getattr(vision_encoder.config, "hidden_size", 0))
    if hidden_size < 1:
        raise MangaFontStudentError("SigLIP2 hidden size is invalid")

    class RuntimePrototypeRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.view_norm = torch.nn.LayerNorm(PROJECTION_DIM)
            self.view_gate = torch.nn.Linear(PROJECTION_DIM, 1)
            self.sample_projection = torch.nn.Sequential(
                torch.nn.Linear(PROJECTION_DIM * 4, PROJECTION_DIM),
                torch.nn.GELU(),
                torch.nn.Dropout(0.10),
                torch.nn.LayerNorm(PROJECTION_DIM),
            )
            self.prototype_projection = torch.nn.Sequential(
                torch.nn.LayerNorm(PROJECTION_DIM),
                torch.nn.Linear(PROJECTION_DIM, PROJECTION_DIM, bias=False),
            )
            self.logit_scale = torch.nn.Parameter(torch.tensor(0.0))
            self.none_head = torch.nn.Linear(PROJECTION_DIM, 1)
            self.role_head = torch.nn.Linear(PROJECTION_DIM, len(ROLE_VALUES))
            self.style_head = torch.nn.Linear(PROJECTION_DIM, len(STYLE_FIELDS))
            self.treatment_heads = torch.nn.ModuleDict(
                {
                    field: torch.nn.Linear(PROJECTION_DIM, len(values))
                    for field, values in TREATMENT_VALUES.items()
                }
            )

        def forward(
            self, views: Any, prototypes: Any, candidate_bags: Sequence[Any]
        ) -> Mapping[str, Any]:
            if views.ndim != 3 or tuple(views.shape[1:]) != (
                len(VIEW_NAMES),
                PROJECTION_DIM,
            ):
                raise MangaFontStudentError("runtime ranker view shape drifted")
            if prototypes.ndim != 2 or prototypes.shape[1] != PROJECTION_DIM:
                raise MangaFontStudentError("runtime prototype shape drifted")
            if len(candidate_bags) != candidate_count or any(
                int(bag.numel()) < 1 for bag in candidate_bags
            ):
                raise MangaFontStudentError("runtime candidate bags are incomplete")
            normalized_views = self.view_norm(views.float())
            gate_logits = self.view_gate(normalized_views).squeeze(-1)
            gate_weights = torch.softmax(gate_logits, dim=1)
            gated = (normalized_views * gate_weights.unsqueeze(-1)).sum(dim=1)
            concatenated = normalized_views.reshape(views.shape[0], -1)
            sample_hidden = self.sample_projection(
                torch.cat([gated, concatenated], dim=-1)
            )
            prototype_hidden = self.prototype_projection(prototypes.float())
            sample_unit = torch.nn.functional.normalize(sample_hidden, p=2, dim=-1)
            prototype_unit = torch.nn.functional.normalize(
                prototype_hidden, p=2, dim=-1
            )
            prototype_scores = (
                sample_unit @ prototype_unit.transpose(0, 1)
            ) * self.logit_scale.exp().clamp(max=100.0)
            candidate_scores = torch.stack(
                [
                    torch.logsumexp(prototype_scores[:, bag], dim=1)
                    - math.log(int(bag.numel()))
                    for bag in candidate_bags
                ],
                dim=1,
            )
            return {
                "candidate_scores": candidate_scores,
                "none_logits": self.none_head(sample_hidden).squeeze(-1),
                "role_logits": self.role_head(sample_hidden),
                "style_logits": self.style_head(sample_hidden),
                "treatment_logits": {
                    field: head(sample_hidden)
                    for field, head in self.treatment_heads.items()
                },
                "view_gate_weights": gate_weights,
            }

    class MangaFontStudent(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.vision_encoder = vision_encoder
            self.projection = torch.nn.Sequential(
                torch.nn.Linear(hidden_size, PROJECTION_DIM),
                torch.nn.GELU(),
                torch.nn.LayerNorm(PROJECTION_DIM),
            )
            self.font_head = torch.nn.Linear(PROJECTION_DIM, candidate_count)
            self.runtime_ranker = RuntimePrototypeRanker()
            self._trainable_block_indices = trainable_blocks

        def train(self, mode: bool = True) -> Any:
            super().train(mode)
            # Frozen blocks stay deterministic; only the final four blocks use
            # their training behavior and receive gradients.
            self.vision_encoder.eval()
            if mode:
                layers = self.vision_encoder.vision_model.encoder.layers
                for index in self._trainable_block_indices:
                    layers[index].train(True)
                self.projection.train(True)
                self.font_head.train(True)
                self.runtime_ranker.train(True)
            return self

        def forward(self, pixel_values: Any) -> tuple[Any, Any]:
            output = self.vision_encoder(pixel_values=pixel_values)
            projected = self.projection(output.pooler_output)
            embedding = torch.nn.functional.normalize(projected.float(), p=2, dim=-1)
            logits = self.font_head(embedding)
            return embedding, logits

        def runtime_forward(
            self, views: Any, prototypes: Any, candidate_bags: Sequence[Any]
        ) -> Mapping[str, Any]:
            return self.runtime_ranker(views, prototypes, candidate_bags)

    student = MangaFontStudent()
    if any(
        parameter.requires_grad
        for index, layer in enumerate(vision_encoder.vision_model.encoder.layers)
        if index not in trainable_blocks
        for parameter in layer.parameters()
    ):
        raise MangaFontStudentError("a frozen SigLIP2 block remains trainable")
    return student, trainable_blocks


def _open_synthetic_view(example: SyntheticExample, view_name: str) -> Any:
    try:
        from PIL import Image
    except ImportError as error:  # pragma: no cover - environment setup
        raise MangaFontStudentError("Pillow is required for training") from error
    descriptor = example.views[view_name]
    path = Path(require_text(descriptor.get("_physical_path"), "synthetic physical path"))
    payload = path.read_bytes()
    if (
        len(payload) != descriptor.get("byte_size")
        or sha256_bytes(payload) != descriptor.get("sha256")
    ):
        raise MangaFontStudentError(
            f"synthetic {example.sample_id}/{view_name}: image hash drifted"
        )
    with Image.open(io.BytesIO(payload)) as opened:
        opened.load()
        image = opened.convert("RGB")
    if image.size != (224, 224):
        image.close()
        raise MangaFontStudentError(
            f"synthetic {example.sample_id}/{view_name}: expected 224x224"
        )
    return image


def _open_synthetic_views(example: SyntheticExample) -> list[Any]:
    images: list[Any] = []
    try:
        for view_name in VIEW_NAMES:
            images.append(_open_synthetic_view(example, view_name))
        return images
    except BaseException:
        for image in images:
            image.close()
        raise


def select_prototype_examples(
    examples: Sequence[SyntheticExample],
    *,
    candidate_ids: tuple[str, ...],
    per_font: int,
) -> tuple[tuple[SyntheticExample, ...], tuple[dict[str, Any], ...]]:
    if per_font < 1:
        raise MangaFontStudentError("prototypes-per-font must be positive")
    grouped: dict[str, list[SyntheticExample]] = {value: [] for value in candidate_ids}
    for example in examples:
        grouped.get(example.font_id, []).append(example)
    selected: list[SyntheticExample] = []
    bags: list[dict[str, Any]] = []
    for candidate_id in candidate_ids:
        rows = sorted(grouped[candidate_id], key=lambda value: value.sample_id)
        if len(rows) < per_font:
            raise MangaFontStudentError(
                f"{candidate_id}: insufficient deterministic prototype examples"
            )
        start = len(selected)
        selected.extend(rows[:per_font])
        bags.append({"candidate_id": candidate_id, "count": per_font, "start": start})
    return tuple(selected), tuple(bags)


def _encode_prototype_bank(
    *,
    torch: Any,
    student: Any,
    processor: Any,
    examples: Sequence[SyntheticExample],
    batch_size: int,
) -> Any:
    features: list[Any] = []
    student.eval()
    with torch.inference_mode():
        for offset in range(0, len(examples), batch_size):
            rows = examples[offset : offset + batch_size]
            images = [_open_synthetic_view(row, "glyph_224") for row in rows]
            try:
                processed = processor(
                    images=images,
                    return_tensors="pt",
                    do_resize=False,
                    do_convert_rgb=True,
                )
            finally:
                for image in images:
                    image.close()
            pixels = processed["pixel_values"].to("cuda", non_blocking=False)
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                embedding, _logits = student(pixels)
            features.append(embedding.detach().float())
    result = torch.cat(features, dim=0)
    if result.shape != (len(examples), PROJECTION_DIM) or not bool(
        torch.isfinite(result).all()
    ):
        raise MangaFontStudentError("re-encoded prototype bank is invalid")
    return result


def _open_human_views(example: HumanExample, resolver: Any) -> list[Any]:
    if example.split not in {"train", "val"}:
        raise MangaFontStudentError("attempted to open a non-development human row")
    images: list[Any] = []
    try:
        for view_name in VIEW_NAMES:
            with resolver.resolve_sample_view(example.row, view_name) as resolved:
                if resolved.mode != "RGB" or resolved.size != (224, 224):
                    raise MangaFontStudentError(
                        f"human {example.sample_id}/{view_name}: invalid pixels"
                    )
                images.append(resolved.image.copy())
        return images
    except BaseException:
        for image in images:
            image.close()
        raise


def _materialize_batch(
    *,
    torch: Any,
    processor: Any,
    resolver: Any,
    synthetic_examples: Sequence[SyntheticExample],
    human_examples: Sequence[HumanExample],
    candidate_count: int,
) -> dict[str, Any]:
    images: list[Any] = []
    try:
        for example in synthetic_examples:
            images.extend(_open_synthetic_views(example))
        for example in human_examples:
            images.extend(_open_human_views(example, resolver))
        processed = processor(
            images=images,
            return_tensors="pt",
            do_resize=False,
            do_convert_rgb=True,
        )
        pixel_values = processed["pixel_values"]
        expected = (len(synthetic_examples) + len(human_examples)) * len(VIEW_NAMES)
        if pixel_values.shape[0] != expected or tuple(pixel_values.shape[-2:]) != (224, 224):
            raise MangaFontStudentError("SigLIP2 processor changed the 224x224 batch")
        targets: list[tuple[float, ...]] = []
        masks: list[tuple[bool, ...]] = []
        for example in human_examples:
            target, mask = soft_target_and_mask(
                candidate_count=candidate_count,
                positive_indices=example.positive_indices,
                eligible_indices=example.eligible_indices,
            )
            targets.append(target)
            masks.append(mask)
        return {
            "pixel_values": pixel_values,
            "synthetic_labels": torch.tensor(
                [example.label_index for example in synthetic_examples], dtype=torch.long
            ),
            "human_targets": torch.tensor(targets, dtype=torch.float32)
            if targets
            else torch.empty((0, candidate_count), dtype=torch.float32),
            "human_masks": torch.tensor(masks, dtype=torch.bool)
            if masks
            else torch.empty((0, candidate_count), dtype=torch.bool),
            "human_none_targets": torch.tensor(
                [example.none_target for example in human_examples], dtype=torch.float32
            ),
            "human_role_targets": torch.tensor(
                [example.role_index for example in human_examples], dtype=torch.long
            ),
            "human_style_targets": torch.tensor(
                [example.style_values for example in human_examples], dtype=torch.float32
            )
            if human_examples
            else torch.empty((0, len(STYLE_FIELDS)), dtype=torch.float32),
            "human_style_masks": torch.tensor(
                [example.style_mask for example in human_examples], dtype=torch.bool
            )
            if human_examples
            else torch.empty((0, len(STYLE_FIELDS)), dtype=torch.bool),
            "human_treatment_targets": torch.tensor(
                [example.treatment_indices for example in human_examples],
                dtype=torch.long,
            )
            if human_examples
            else torch.empty((0, len(TREATMENT_VALUES)), dtype=torch.long),
        }
    finally:
        for image in images:
            image.close()


def _human_soft_listwise_loss(torch: Any, logits: Any, targets: Any, masks: Any) -> Any:
    if logits.shape != targets.shape or masks.shape != logits.shape:
        raise MangaFontStudentError("human soft-listwise tensor shape drifted")
    active = targets.sum(dim=-1) > 0
    if not bool(active.any()):
        return logits.sum() * 0.0
    masked_logits = logits.masked_fill(~masks, torch.finfo(logits.dtype).min)
    log_probability = torch.nn.functional.log_softmax(masked_logits.float(), dim=-1)
    return -(targets[active] * log_probability[active]).sum(dim=-1).mean()


def _human_auxiliary_loss(
    *,
    torch: Any,
    outputs: Mapping[str, Any],
    none_targets: Any,
    role_targets: Any,
    style_targets: Any,
    style_masks: Any,
    treatment_targets: Any,
) -> tuple[Any, Mapping[str, Any]]:
    none_loss = torch.nn.functional.binary_cross_entropy_with_logits(
        outputs["none_logits"].float(), none_targets
    )
    role_loss = torch.nn.functional.cross_entropy(
        outputs["role_logits"].float(), role_targets
    )
    raw_style = torch.nn.functional.smooth_l1_loss(
        torch.sigmoid(outputs["style_logits"].float()),
        style_targets,
        reduction="none",
    )
    style_loss = (raw_style * style_masks).sum() / style_masks.sum().clamp(min=1)
    treatment_parts = []
    for field_index, field in enumerate(TREATMENT_VALUES):
        treatment_parts.append(
            torch.nn.functional.cross_entropy(
                outputs["treatment_logits"][field].float(),
                treatment_targets[:, field_index],
            )
        )
    treatment_loss = torch.stack(treatment_parts).mean()
    total = (none_loss + role_loss + style_loss + treatment_loss) / 4.0
    return total, {
        "none": none_loss,
        "role": role_loss,
        "style": style_loss,
        "treatment": treatment_loss,
    }


def _three_view_consistency(torch: Any, embeddings: Any) -> Any:
    if embeddings.ndim != 3 or embeddings.shape[1] != len(VIEW_NAMES):
        raise MangaFontStudentError("three-view embedding tensor shape drifted")
    similarities = (
        (embeddings[:, 0] * embeddings[:, 1]).sum(dim=-1)
        + (embeddings[:, 0] * embeddings[:, 2]).sum(dim=-1)
        + (embeddings[:, 1] * embeddings[:, 2]).sum(dim=-1)
    ) / 3.0
    return (1.0 - similarities).mean()


def _evaluate_human_val(
    *,
    torch: Any,
    student: Any,
    processor: Any,
    resolver: Any,
    examples: Sequence[HumanExample],
    candidate_ids: tuple[str, ...],
    prototype_tensor: Any,
    candidate_bags: Sequence[Any],
    batch_size: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    student.eval()
    predictions: list[dict[str, Any]] = []
    loss_sum = 0.0
    loss_rows = 0
    top1_hits = 0
    recall_sum = 0.0
    positive_rows = 0
    with torch.inference_mode():
        for offset in range(0, len(examples), batch_size):
            batch_examples = list(examples[offset : offset + batch_size])
            materialized = _materialize_batch(
                torch=torch,
                processor=processor,
                resolver=resolver,
                synthetic_examples=(),
                human_examples=batch_examples,
                candidate_count=len(candidate_ids),
            )
            pixels = materialized["pixel_values"].to("cuda", non_blocking=False)
            targets = materialized["human_targets"].to("cuda")
            masks = materialized["human_masks"].to("cuda")
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                flat_embedding, _direct_logits = student(pixels)
                view_embedding = flat_embedding.reshape(
                    len(batch_examples), len(VIEW_NAMES), -1
                )
                runtime_outputs = student.runtime_forward(
                    view_embedding, prototype_tensor, candidate_bags
                )
                logits = runtime_outputs["candidate_scores"]
            masked_logits = logits.float().masked_fill(~masks, -torch.inf)
            probabilities = torch.softmax(masked_logits, dim=-1)
            active = targets.sum(dim=-1) > 0
            if bool(active.any()):
                batch_loss = _human_soft_listwise_loss(torch, logits, targets, masks)
                active_count = int(active.sum().item())
                loss_sum += float(batch_loss.item()) * active_count
                loss_rows += active_count
            for index, example in enumerate(batch_examples):
                eligible = set(example.eligible_indices)
                order = sorted(
                    eligible,
                    key=lambda candidate_index: (
                        -float(probabilities[index, candidate_index].item()),
                        candidate_index,
                    ),
                )
                positive = set(example.positive_indices)
                top1 = bool(positive and order and order[0] in positive)
                recall3 = (
                    len(positive & set(order[:3])) / len(positive) if positive else None
                )
                if positive:
                    positive_rows += 1
                    top1_hits += int(top1)
                    recall_sum += float(recall3)
                core = {
                    "acceptable_at1": top1 if positive else None,
                    "candidate_probabilities": [
                        {
                            "candidate_id": candidate_ids[candidate_index],
                            "probability": float(probabilities[index, candidate_index].item()),
                        }
                        for candidate_index in order
                    ],
                    "positive_candidate_ids": [candidate_ids[value] for value in example.positive_indices],
                    "ranked_candidate_ids": [candidate_ids[value] for value in order],
                    "recall_at3": recall3,
                    "sample_id": example.sample_id,
                    "schema_version": PREDICTION_SCHEMA,
                    "split": "val",
                    "work_id": example.work_id,
                }
                predictions.append(seal_record(core))
    if positive_rows < 1 or loss_rows < 1:
        raise MangaFontStudentError("human val has no acceptable-set supervision")
    metrics = {
        "acceptable_at1": top1_hits / positive_rows,
        "evaluated_positive_rows": positive_rows,
        "recall_at3": recall_sum / positive_rows,
        "soft_listwise_loss": loss_sum / loss_rows,
        "total_val_rows": len(examples),
    }
    predictions.sort(key=lambda row: str(row["sample_id"]))
    return metrics, predictions


def _count_parameters(parameters: Iterable[Any]) -> int:
    return sum(int(parameter.numel()) for parameter in parameters)


def _train_student(
    *,
    args: argparse.Namespace,
    synthetic: SyntheticSnapshot,
    human: HumanSnapshot,
    catalog_registry: Path,
) -> dict[str, Any]:
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    torch, processor_class, vision_class, save_file = _load_training_dependencies()
    if not torch.cuda.is_available():
        raise MangaFontStudentError("manga font student training requires CUDA")
    if not torch.cuda.is_bf16_supported():
        raise MangaFontStudentError("manga font student training requires CUDA bf16")
    _configure_reproducibility(torch, seed=args.seed)
    try:
        from font_matching_catalog_assets import CatalogAssetResolver
    except ImportError:  # pragma: no cover - repository-root import
        from scripts.font_matching_catalog_assets import CatalogAssetResolver

    resolver = CatalogAssetResolver(catalog_registry)
    processor = processor_class.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        use_fast=PROCESSOR_USE_FAST,
        local_files_only=True,
    )
    vision_encoder = vision_class.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    )
    student, trainable_blocks = build_student_model(
        torch,
        vision_encoder=vision_encoder,
        candidate_count=len(synthetic.candidate_ids),
    )
    student.to("cuda")
    encoder_parameters = [
        parameter for parameter in vision_encoder.parameters() if parameter.requires_grad
    ]
    head_parameters = [
        *student.projection.parameters(),
        *student.font_head.parameters(),
        *student.runtime_ranker.parameters(),
    ]
    if {id(value) for value in encoder_parameters} & {id(value) for value in head_parameters}:
        raise MangaFontStudentError("optimizer parameter groups overlap")
    optimizer = torch.optim.AdamW(
        [
            {"params": encoder_parameters, "lr": args.encoder_lr},
            {"params": head_parameters, "lr": args.head_lr},
        ],
        weight_decay=args.weight_decay,
        betas=(0.9, 0.999),
        eps=1e-8,
        foreach=False,
    )
    human_train = tuple(human.train_examples)
    if not human_train:
        raise MangaFontStudentError("human train is empty")
    prototype_examples, candidate_bag_records = select_prototype_examples(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        per_font=args.prototypes_per_font,
    )
    candidate_bags = tuple(
        torch.arange(
            record["start"],
            record["start"] + record["count"],
            dtype=torch.long,
            device="cuda",
        )
        for record in candidate_bag_records
    )
    prototype_tensor = _encode_prototype_bank(
        torch=torch,
        student=student,
        processor=processor,
        examples=prototype_examples,
        batch_size=args.eval_batch_size,
    )
    history: list[dict[str, Any]] = []
    best_metrics: dict[str, Any] | None = None
    best_epoch = 0
    best_state: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    epochs_without_improvement = 0
    realized_synthetic = 0
    realized_human = 0
    for epoch in range(1, args.epochs + 1):
        batches = build_epoch_batches(
            synthetic_count=len(synthetic.train_examples),
            human_count=len(human_train),
            batch_size=args.batch_size,
            human_fraction=args.human_fraction,
            seed=args.seed + epoch,
        )
        student.train(True)
        epoch_loss = 0.0
        epoch_synthetic_ce = 0.0
        epoch_human_loss = 0.0
        epoch_auxiliary_loss = 0.0
        epoch_consistency = 0.0
        for batch in batches:
            synthetic_rows = [synthetic.train_examples[index] for index in batch.synthetic_indices]
            human_rows = [human_train[index] for index in batch.human_indices]
            materialized = _materialize_batch(
                torch=torch,
                processor=processor,
                resolver=resolver,
                synthetic_examples=synthetic_rows,
                human_examples=human_rows,
                candidate_count=len(synthetic.candidate_ids),
            )
            pixels = materialized["pixel_values"].to("cuda", non_blocking=False)
            synthetic_labels = materialized["synthetic_labels"].to("cuda")
            human_targets = materialized["human_targets"].to("cuda")
            human_masks = materialized["human_masks"].to("cuda")
            human_none_targets = materialized["human_none_targets"].to("cuda")
            human_role_targets = materialized["human_role_targets"].to("cuda")
            human_style_targets = materialized["human_style_targets"].to("cuda")
            human_style_masks = materialized["human_style_masks"].to("cuda")
            human_treatment_targets = materialized["human_treatment_targets"].to(
                "cuda"
            )
            synthetic_count = len(synthetic_rows)
            human_count = len(human_rows)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                flat_embedding, flat_logits = student(pixels)
                embedding = flat_embedding.reshape(
                    synthetic_count + human_count, len(VIEW_NAMES), -1
                )
                logits = flat_logits.reshape(
                    synthetic_count + human_count, len(VIEW_NAMES), -1
                )
                runtime_outputs = student.runtime_forward(
                    embedding, prototype_tensor, candidate_bags
                )
                direct_synthetic_ce = torch.nn.functional.cross_entropy(
                    logits[:synthetic_count].reshape(
                        -1, len(synthetic.candidate_ids)
                    ),
                    synthetic_labels.repeat_interleave(len(VIEW_NAMES)),
                )
                runtime_synthetic_ce = torch.nn.functional.cross_entropy(
                    runtime_outputs["candidate_scores"][:synthetic_count],
                    synthetic_labels,
                )
                synthetic_ce = (direct_synthetic_ce + runtime_synthetic_ce) / 2.0
                consistency = _three_view_consistency(
                    torch, embedding[:synthetic_count]
                )
                direct_human_loss = _human_soft_listwise_loss(
                    torch,
                    logits[synthetic_count:].mean(dim=1),
                    human_targets,
                    human_masks,
                )
                runtime_human_outputs = {
                    "candidate_scores": runtime_outputs["candidate_scores"][
                        synthetic_count:
                    ],
                    "none_logits": runtime_outputs["none_logits"][synthetic_count:],
                    "role_logits": runtime_outputs["role_logits"][synthetic_count:],
                    "style_logits": runtime_outputs["style_logits"][synthetic_count:],
                    "treatment_logits": {
                        field: values[synthetic_count:]
                        for field, values in runtime_outputs[
                            "treatment_logits"
                        ].items()
                    },
                    "view_gate_weights": runtime_outputs["view_gate_weights"][
                        synthetic_count:
                    ],
                }
                runtime_human_loss = _human_soft_listwise_loss(
                    torch,
                    runtime_human_outputs["candidate_scores"],
                    human_targets,
                    human_masks,
                )
                human_loss = (direct_human_loss + runtime_human_loss) / 2.0
                auxiliary_loss, _auxiliary_parts = _human_auxiliary_loss(
                    torch=torch,
                    outputs=runtime_human_outputs,
                    none_targets=human_none_targets,
                    role_targets=human_role_targets,
                    style_targets=human_style_targets,
                    style_masks=human_style_masks,
                    treatment_targets=human_treatment_targets,
                )
                classification = (
                    synthetic_ce * synthetic_count + human_loss * human_count
                ) / (synthetic_count + human_count)
                loss = (
                    classification
                    + args.consistency_weight * consistency
                    + args.auxiliary_weight * auxiliary_loss
                )
            if not bool(torch.isfinite(loss)):
                raise MangaFontStudentError("training loss became non-finite")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                [*encoder_parameters, *head_parameters], args.gradient_clip
            )
            optimizer.step()
            epoch_loss += float(loss.detach().item())
            epoch_synthetic_ce += float(synthetic_ce.detach().item())
            epoch_human_loss += float(human_loss.detach().item())
            epoch_auxiliary_loss += float(auxiliary_loss.detach().item())
            epoch_consistency += float(consistency.detach().item())
            realized_synthetic += synthetic_count
            realized_human += human_count
        prototype_tensor = _encode_prototype_bank(
            torch=torch,
            student=student,
            processor=processor,
            examples=prototype_examples,
            batch_size=args.eval_batch_size,
        )
        val_metrics, predictions = _evaluate_human_val(
            torch=torch,
            student=student,
            processor=processor,
            resolver=resolver,
            examples=human.val_examples,
            candidate_ids=synthetic.candidate_ids,
            prototype_tensor=prototype_tensor,
            candidate_bags=candidate_bags,
            batch_size=args.eval_batch_size,
        )
        epoch_record = {
            "epoch": epoch,
            "train_auxiliary_semantics": epoch_auxiliary_loss / len(batches),
            "train_consistency": epoch_consistency / len(batches),
            "train_human_soft_listwise": epoch_human_loss / len(batches),
            "train_loss": epoch_loss / len(batches),
            "train_synthetic_exact_ce": epoch_synthetic_ce / len(batches),
            "val": copy.deepcopy(val_metrics),
        }
        history.append(epoch_record)
        print(
            canonical_json(
                {
                    "event": "epoch_complete",
                    "epoch": epoch,
                    "train_loss": epoch_record["train_loss"],
                    "val": epoch_record["val"],
                }
            ),
            flush=True,
        )
        if is_better_metrics(val_metrics, best_metrics, min_delta=args.min_delta):
            best_metrics = copy.deepcopy(val_metrics)
            best_epoch = epoch
            best_state = {
                name: parameter.detach().cpu().clone()
                for name, parameter in student.named_parameters()
                if parameter.requires_grad
            }
            best_predictions = copy.deepcopy(predictions)
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= args.patience:
                break
    if best_state is None or best_metrics is None or best_predictions is None:
        raise MangaFontStudentError("training did not produce a best checkpoint")
    named_parameters = dict(student.named_parameters())
    with torch.no_grad():
        for name, value in best_state.items():
            named_parameters[name].copy_(value.to("cuda"))
    prototype_tensor = _encode_prototype_bank(
        torch=torch,
        student=student,
        processor=processor,
        examples=prototype_examples,
        batch_size=args.eval_batch_size,
    )
    # Re-evaluate after restoring to make the persisted predictions an exact
    # consequence of the persisted checkpoint.
    restored_metrics, restored_predictions = _evaluate_human_val(
        torch=torch,
        student=student,
        processor=processor,
        resolver=resolver,
        examples=human.val_examples,
        candidate_ids=synthetic.candidate_ids,
        prototype_tensor=prototype_tensor,
        candidate_bags=candidate_bags,
        batch_size=args.eval_batch_size,
    )
    if metric_priority_key(restored_metrics) != metric_priority_key(best_metrics):
        raise MangaFontStudentError("restored best-checkpoint metrics drifted")
    if [row["record_sha256"] for row in restored_predictions] != [
        row["record_sha256"] for row in best_predictions
    ]:
        raise MangaFontStudentError("restored best-checkpoint predictions drifted")
    trainable_state = {
        name: parameter.detach().cpu().contiguous()
        for name, parameter in student.named_parameters()
        if parameter.requires_grad
    }
    return {
        "best_epoch": best_epoch,
        "best_metrics": best_metrics,
        "candidate_ids": synthetic.candidate_ids,
        "checkpoint_metadata": {
            "base_model_id": MODEL_ID,
            "base_model_revision": MODEL_REVISION,
            "format": OUTPUT_SCHEMA,
            "kind": "trainable_delta_against_pinned_local_base",
        },
        "history": history,
        "optimizer": {
            "class": "AdamW",
            "encoder_lr": args.encoder_lr,
            "head_lr": args.head_lr,
            "weight_decay": args.weight_decay,
            "betas": [0.9, 0.999],
            "eps": 1e-8,
        },
        "parameter_counts": {
            "encoder_trainable": _count_parameters(encoder_parameters),
            "projection_and_head_trainable": _count_parameters(head_parameters),
            "saved_trainable": sum(int(value.numel()) for value in trainable_state.values()),
        },
        "prototype_bags": candidate_bag_records,
        "prototype_features": prototype_tensor.detach().cpu().float().contiguous(),
        "prototype_sample_ids": tuple(value.sample_id for value in prototype_examples),
        "predictions": restored_predictions,
        "processor_config_sha256": sha256_bytes(
            canonical_json(processor.to_dict()).encode("utf-8")
        ),
        "realized_batch_counts": {
            "human": realized_human,
            "synthetic": realized_synthetic,
            "human_fraction": realized_human / (realized_human + realized_synthetic),
        },
        "save_file": save_file,
        "state": trainable_state,
        "trainable_blocks": trainable_blocks,
        "total_vision_blocks": len(vision_encoder.vision_model.encoder.layers),
    }


def _file_descriptor(path: Path, *, file_name: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontStudentError(f"output artifact is missing or empty: {file_name}")
    return {
        "byte_size": path.stat().st_size,
        "file": file_name,
        "sha256": sha256_file(path),
    }


def _safe_output_path(path: Path) -> Path:
    output = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}
    if output in forbidden or len(output.parts) < 3 or len(output.name) < 3:
        raise MangaFontStudentError(f"unsafe output directory: {output}")
    return output


def _write_owned_output(
    *,
    output_dir: Path,
    args: argparse.Namespace,
    training: Mapping[str, Any],
    synthetic: SyntheticSnapshot,
    human: HumanSnapshot,
    catalog_registry_sha256: str,
    catalog_registry_record_sha256: str,
) -> Mapping[str, Any]:
    output = _safe_output_path(output_dir)
    if output.exists():
        raise MangaFontStudentError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        checkpoint_path = staging / CHECKPOINT_FILE
        save_file = training["save_file"]
        save_file(
            dict(training["state"]),
            checkpoint_path,
            metadata={key: str(value) for key, value in training["checkpoint_metadata"].items()},
        )
        checkpoint_descriptor = _file_descriptor(
            checkpoint_path, file_name=CHECKPOINT_FILE
        )
        checkpoint_descriptor["state_contract"] = [
            {
                "dtype": str(value.dtype).replace("torch.", ""),
                "name": name,
                "shape": list(value.shape),
            }
            for name, value in sorted(training["state"].items())
        ]
        predictions = list(training["predictions"])
        predictions_payload = b"".join(
            (canonical_json(record) + "\n").encode("utf-8") for record in predictions
        )
        if not predictions_payload:
            raise MangaFontStudentError("validation predictions are empty")
        predictions_path = staging / PREDICTIONS_FILE
        predictions_path.write_bytes(predictions_payload)
        predictions_descriptor = _file_descriptor(
            predictions_path, file_name=PREDICTIONS_FILE
        )
        predictions_descriptor["record_count"] = len(predictions)
        prototype_features = np.asarray(
            training["prototype_features"].numpy(), dtype="<f4"
        )
        if (
            prototype_features.ndim != 2
            or prototype_features.shape[1] != PROJECTION_DIM
            or not np.isfinite(prototype_features).all()
        ):
            raise MangaFontStudentError("persisted prototype bank is invalid")
        prototype_path = staging / PROTOTYPE_FILE
        prototype_path.write_bytes(prototype_features.tobytes(order="C"))
        prototype_descriptor = _file_descriptor(
            prototype_path, file_name=PROTOTYPE_FILE
        )
        prototype_descriptor.update(
            {
                "candidate_bags": copy.deepcopy(list(training["prototype_bags"])),
                "feature_dim": PROJECTION_DIM,
                "prototype_count": int(prototype_features.shape[0]),
                "sample_ids_sha256": sha256_bytes(
                    ("\n".join(training["prototype_sample_ids"]) + "\n").encode(
                        "utf-8"
                    )
                ),
            }
        )

        contract = seal_record(
            {
                "architecture": {
                    "candidate_count": CANDIDATE_COUNT,
                    "embedding_normalization": "l2",
                    "font_head": "linear_256_to_22",
                    "projection": "linear_gelu_layernorm",
                    "projection_dim": PROJECTION_DIM,
                    "runtime_candidate_scoring": (
                        "three-view-gated-concat-projection-to-prototype-dot-"
                        "conditional-logmeanexp-bag-v1"
                    ),
                    "three_view_direct_head_aggregation": "arithmetic_mean",
                    "view_names": list(VIEW_NAMES),
                },
                "checkpoint": {
                    **checkpoint_descriptor,
                    "kind": "trainable_delta_against_pinned_local_base",
                    "metadata": dict(training["checkpoint_metadata"]),
                },
                "encoder": {
                    "class": "SiglipVisionModel",
                    "local_files_only": True,
                    "model_id": MODEL_ID,
                    "revision": MODEL_REVISION,
                    "total_vision_blocks": training["total_vision_blocks"],
                    "trainable_block_count": TRAINABLE_VISION_BLOCKS,
                    "trainable_block_indices": list(training["trainable_blocks"]),
                    "all_other_vision_parameters_frozen": True,
                },
                "inputs": {
                    "catalog_registry_record_sha256": catalog_registry_record_sha256,
                    "catalog_registry_sha256": catalog_registry_sha256,
                    "human_export_manifest_sha256": human.manifest_sha256,
                    "human_export_marker_sha256": human.marker_sha256,
                    "human_export_report_sha256": human.report_sha256,
                    "human_samples_sha256": human.samples_sha256,
                    "synthetic_manifest_sha256": synthetic.manifest_sha256,
                    "synthetic_report_sha256": synthetic.report_sha256,
                },
                "objectives": {
                    "human_auxiliary_semantics": {
                        "none": "binary_cross_entropy",
                        "role": "cross_entropy",
                        "style": "masked_smooth_l1_after_sigmoid",
                        "treatment": "mean_field_cross_entropy",
                        "weight": args.auxiliary_weight,
                    },
                    "human": "uniform_acceptable_set_soft_listwise_cross_entropy",
                    "human_batch_fraction_target": args.human_fraction,
                    "human_unrenderable_masked": True,
                    "synthetic": "exact_font_cross_entropy_all_three_views",
                    "synthetic_three_view_embedding_consistency": "mean_one_minus_pairwise_cosine",
                    "synthetic_three_view_embedding_consistency_weight": args.consistency_weight,
                },
                "optimizer": copy.deepcopy(dict(training["optimizer"])),
                "preprocessing": {
                    "image_mode": "RGB",
                    "image_size_px": [224, 224],
                    "processor_class": "AutoImageProcessor",
                    "processor_config_sha256": training["processor_config_sha256"],
                    "use_fast": PROCESSOR_USE_FAST,
                },
                "record_type": "manga_font_student_model_contract",
                "prototype_bank": prototype_descriptor,
                "runtime_export_adapter": {
                    "candidate_bags_source": "prototype_bank.candidate_bags",
                    "candidate_scores_authority": "runtime_ranker",
                    "checkpoint_prefixes": {
                        "direct_classifier": "font_head.",
                        "encoder": "vision_encoder.",
                        "projection": "projection.",
                        "ranker": "runtime_ranker.",
                    },
                    "encoder_onnx_output": {
                        "name": "image_features",
                        "normalization": "l2",
                        "shape": [None, PROJECTION_DIM],
                    },
                    "ranker_onnx_inputs": [
                        {"name": "views", "shape": [None, 3, PROJECTION_DIM]},
                        {
                            "name": "prototype_features",
                            "shape": [None, PROJECTION_DIM],
                        },
                    ],
                    "ranker_onnx_outputs": [
                        "candidate_scores",
                        "none_logits",
                        "role_logits",
                        "style_logits",
                        *(
                            f"treatment_{field}_logits"
                            for field in sorted(TREATMENT_VALUES)
                        ),
                        "view_gate_weights",
                    ],
                    "schema_version": "manga-font-student-onnx-adapter-v1",
                },
                "schema_version": MODEL_CONTRACT_SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
                "validation_predictions": predictions_descriptor,
                "vocabulary": {
                    "candidate_ids": list(training["candidate_ids"]),
                    "roles": list(ROLE_VALUES),
                    "style_fields": list(STYLE_FIELDS),
                    "treatments": {
                        field: list(values)
                        for field, values in TREATMENT_VALUES.items()
                    },
                },
            }
        )
        contract_path = staging / CONTRACT_FILE
        contract_path.write_bytes(json_bytes(contract, pretty=True))
        report = seal_record(
            {
                "best_epoch": training["best_epoch"],
                "best_human_val": copy.deepcopy(dict(training["best_metrics"])),
                "checks": {
                    "bf16_cuda": True,
                    "catalog_registry_bound": True,
                    "human_gold_only": True,
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "human_train_used_for_optimizer": True,
                    "human_val_used_for_early_stop": True,
                    "local_model_only": True,
                    "prototype_bank_reencoded_with_best_encoder": True,
                    "runtime_ranker_outputs_compatible": True,
                    "synthetic_test_pixels_opened": 0,
                    "synthetic_train_used_for_optimizer": True,
                },
                "early_stopping": {
                    "metric_priority": ["human_val_acceptable_at1", "human_val_recall_at3"],
                    "min_delta": args.min_delta,
                    "patience": args.patience,
                },
                "history": copy.deepcopy(list(training["history"])),
                "human_boundary": {
                    "skipped_test_row_count": human.skipped_test_rows,
                    "train_positive_row_count": sum(
                        bool(value.positive_indices) for value in human.train_examples
                    ),
                    "train_row_count": len(human.train_examples),
                    "val_positive_row_count": sum(
                        bool(value.positive_indices) for value in human.val_examples
                    ),
                    "val_row_count": len(human.val_examples),
                },
                "model_contract_sha256": sha256_file(contract_path),
                "parameter_counts": copy.deepcopy(dict(training["parameter_counts"])),
                "predictions_val": predictions_descriptor,
                "realized_batch_counts": copy.deepcopy(
                    dict(training["realized_batch_counts"])
                ),
                "record_type": "manga_font_student_training_report",
                "schema_version": TRAINING_REPORT_SCHEMA,
                "seed": args.seed,
                "synthetic_boundary": {
                    "record_count": synthetic.record_count,
                    "train_row_count": len(synthetic.train_examples),
                },
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: sha256_file(staging / name) for name in OUTPUT_ARTIFACTS
            },
            "owner": OUTPUT_OWNER,
            "safe_replace": True,
            "schema_version": OUTPUT_SCHEMA,
        }
        (staging / OUTPUT_MARKER).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging)
        if output.exists():
            raise MangaFontStudentError("output directory appeared during training")
        os.rename(staging, output)
        published = True
        return validate_output(output)
    except BaseException:
        if not published and staging.exists():
            shutil.rmtree(staging)
        elif published and output.exists():
            shutil.rmtree(output)
        raise


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    assert_exact_root_inventory(root, set(OUTPUT_FILES), location="student output")
    for path in root.iterdir():
        if path.is_symlink() or not path.is_file():
            raise MangaFontStudentError("student output contains a linked/non-file entry")
    marker = read_json(root / OUTPUT_MARKER, location="student output marker")
    if set(marker) != {"artifacts", "owner", "safe_replace", "schema_version"} or (
        marker.get("owner") != OUTPUT_OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != OUTPUT_SCHEMA
    ):
        raise MangaFontStudentError("student output ownership marker is invalid")
    marker_artifacts = require_mapping(marker.get("artifacts"), "student marker.artifacts")
    if set(marker_artifacts) != set(OUTPUT_ARTIFACTS):
        raise MangaFontStudentError("student marker artifact inventory drifted")
    for name in OUTPUT_ARTIFACTS:
        if require_sha(marker_artifacts.get(name), f"student marker.{name}") != sha256_file(
            root / name
        ):
            raise MangaFontStudentError(f"student marker hash mismatch: {name}")
    contract = read_json(root / CONTRACT_FILE, location="student model contract")
    report = read_json(root / REPORT_FILE, location="student training report")
    validate_record_seal(contract, location="student model contract")
    validate_record_seal(report, location="student training report")
    if (
        contract.get("schema_version") != MODEL_CONTRACT_SCHEMA
        or contract.get("record_type") != "manga_font_student_model_contract"
        or report.get("schema_version") != TRAINING_REPORT_SCHEMA
        or report.get("record_type") != "manga_font_student_training_report"
    ):
        raise MangaFontStudentError("student output schema is unsupported")
    encoder = require_mapping(contract.get("encoder"), "student contract.encoder")
    if (
        encoder.get("model_id") != MODEL_ID
        or encoder.get("revision") != MODEL_REVISION
        or encoder.get("local_files_only") is not True
        or encoder.get("trainable_block_count") != TRAINABLE_VISION_BLOCKS
        or encoder.get("all_other_vision_parameters_frozen") is not True
    ):
        raise MangaFontStudentError("student encoder contract drifted")
    vocabulary = require_mapping(contract.get("vocabulary"), "student contract.vocabulary")
    candidate_ids = tuple(
        require_text(value, f"student candidate[{index}]")
        for index, value in enumerate(
            require_list(vocabulary.get("candidate_ids"), "student candidate ids")
        )
    )
    if len(candidate_ids) != CANDIDATE_COUNT or len(set(candidate_ids)) != CANDIDATE_COUNT:
        raise MangaFontStudentError("student vocabulary is not exact 22")
    checkpoint = require_mapping(contract.get("checkpoint"), "student contract.checkpoint")
    if (
        checkpoint.get("file") != CHECKPOINT_FILE
        or checkpoint.get("sha256") != sha256_file(root / CHECKPOINT_FILE)
        or checkpoint.get("byte_size") != (root / CHECKPOINT_FILE).stat().st_size
        or checkpoint.get("kind") != "trainable_delta_against_pinned_local_base"
    ):
        raise MangaFontStudentError("student checkpoint descriptor drifted")
    state_contract = require_list(checkpoint.get("state_contract"), "student checkpoint.state_contract")
    if not state_contract:
        raise MangaFontStudentError("student checkpoint state contract is empty")
    state_names = {
        require_text(
            require_mapping(row, "student checkpoint state row").get("name"),
            "student checkpoint state name",
        )
        for row in state_contract
    }
    for prefix in ("vision_encoder.", "projection.", "font_head.", "runtime_ranker."):
        if not any(name.startswith(prefix) for name in state_names):
            raise MangaFontStudentError(
                f"student checkpoint omits required state prefix {prefix}"
            )
    prototype = require_mapping(contract.get("prototype_bank"), "student contract.prototype_bank")
    prototype_path = root / PROTOTYPE_FILE
    prototype_count = require_nonnegative_int(
        prototype.get("prototype_count"), "student prototype count"
    )
    if (
        prototype.get("file") != PROTOTYPE_FILE
        or prototype.get("sha256") != sha256_file(prototype_path)
        or prototype.get("byte_size") != prototype_path.stat().st_size
        or prototype.get("feature_dim") != PROJECTION_DIM
        or prototype_count < CANDIDATE_COUNT
        or prototype_path.stat().st_size != prototype_count * PROJECTION_DIM * 4
    ):
        raise MangaFontStudentError("student prototype-bank descriptor drifted")
    require_sha(prototype.get("sample_ids_sha256"), "student prototype sample ids")
    bags = require_list(prototype.get("candidate_bags"), "student prototype bags")
    if len(bags) != CANDIDATE_COUNT:
        raise MangaFontStudentError("student prototype candidate bags drifted")
    next_start = 0
    for candidate_id, raw_bag in zip(candidate_ids, bags, strict=True):
        bag = require_mapping(raw_bag, "student prototype bag")
        count = require_nonnegative_int(bag.get("count"), "student prototype bag.count")
        if (
            set(bag) != {"candidate_id", "count", "start"}
            or bag.get("candidate_id") != candidate_id
            or bag.get("start") != next_start
            or count < 1
        ):
            raise MangaFontStudentError("student prototype bag order drifted")
        next_start += count
    if next_start != prototype_count:
        raise MangaFontStudentError("student prototype bags do not cover the bank")
    adapter = require_mapping(
        contract.get("runtime_export_adapter"), "student contract.runtime_export_adapter"
    )
    expected_runtime_outputs = [
        "candidate_scores",
        "none_logits",
        "role_logits",
        "style_logits",
        *(f"treatment_{field}_logits" for field in sorted(TREATMENT_VALUES)),
        "view_gate_weights",
    ]
    if (
        adapter.get("schema_version") != "manga-font-student-onnx-adapter-v1"
        or adapter.get("candidate_scores_authority") != "runtime_ranker"
        or adapter.get("ranker_onnx_outputs") != expected_runtime_outputs
    ):
        raise MangaFontStudentError("student runtime export adapter drifted")
    predictions_descriptor = require_mapping(
        contract.get("validation_predictions"), "student contract.validation_predictions"
    )
    predictions_path = root / PREDICTIONS_FILE
    if (
        predictions_descriptor.get("file") != PREDICTIONS_FILE
        or predictions_descriptor.get("sha256") != sha256_file(predictions_path)
        or predictions_descriptor.get("byte_size") != predictions_path.stat().st_size
    ):
        raise MangaFontStudentError("student prediction descriptor drifted")
    predictions: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    with predictions_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                prediction = require_mapping(
                    json.loads(line), f"student prediction {line_number}"
                )
            except json.JSONDecodeError as error:
                raise MangaFontStudentError("student prediction JSON is invalid") from error
            validate_record_seal(prediction, location=f"student prediction {line_number}")
            if (
                prediction.get("schema_version") != PREDICTION_SCHEMA
                or prediction.get("split") != "val"
            ):
                raise MangaFontStudentError("student predictions contain non-val data")
            sample_id = require_text(
                prediction.get("sample_id"), f"student prediction {line_number}.sample_id"
            )
            if sample_id in seen:
                raise MangaFontStudentError("student prediction sample is duplicated")
            seen.add(sample_id)
            ranking = require_list(
                prediction.get("ranked_candidate_ids"),
                f"student prediction {line_number}.ranked_candidate_ids",
            )
            if not ranking or len(ranking) != len(set(ranking)) or not set(ranking) <= set(
                candidate_ids
            ):
                raise MangaFontStudentError("student prediction ranking drifted")
            predictions.append(prediction)
    if not predictions or len(predictions) != predictions_descriptor.get("record_count"):
        raise MangaFontStudentError("student prediction count drifted")
    checks = require_mapping(report.get("checks"), "student report.checks")
    if (
        checks.get("human_test_labels_deserialized") != 0
        or checks.get("human_test_pixels_opened") != 0
        or checks.get("synthetic_test_pixels_opened") != 0
        or checks.get("bf16_cuda") is not True
        or checks.get("local_model_only") is not True
        or checks.get("prototype_bank_reencoded_with_best_encoder") is not True
        or checks.get("runtime_ranker_outputs_compatible") is not True
    ):
        raise MangaFontStudentError("student report leakage/runtime checks failed")
    if (
        report.get("model_contract_sha256") != sha256_file(root / CONTRACT_FILE)
        or require_mapping(report.get("predictions_val"), "student report.predictions_val")
        != predictions_descriptor
    ):
        raise MangaFontStudentError("student report output binding drifted")
    return {
        "best_epoch": report.get("best_epoch"),
        "candidate_count": len(candidate_ids),
        "model_contract_sha256": sha256_file(root / CONTRACT_FILE),
        "output_dir": str(root),
        "prediction_count": len(predictions),
        "status": "ready",
    }


def train_command(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output_path(args.output_dir)
    if output.exists():
        raise MangaFontStudentError("output directory already exists")
    if (
        args.epochs < 1
        or args.patience < 1
        or args.batch_size < 4
        or args.eval_batch_size < 1
    ):
        raise MangaFontStudentError(
            "epochs, patience, and batch sizes must be positive"
        )
    if (
        args.consistency_weight < 0.0
        or args.auxiliary_weight < 0.0
        or args.gradient_clip <= 0.0
        or args.prototypes_per_font < 1
        or args.min_delta < 0.0
        or not 0.05 <= args.human_fraction <= 0.5
        or not all(
            math.isfinite(value)
            for value in (
                args.consistency_weight,
                args.auxiliary_weight,
                args.gradient_clip,
                args.min_delta,
                args.human_fraction,
                args.encoder_lr,
                args.head_lr,
                args.weight_decay,
            )
        )
    ):
        raise MangaFontStudentError("loss/gradient configuration is invalid")
    if args.encoder_lr <= 0.0 or args.head_lr <= 0.0 or args.weight_decay < 0.0:
        raise MangaFontStudentError("optimizer configuration is invalid")
    registry_path = args.catalog_registry.expanduser().resolve()
    registry = read_json(registry_path, location="catalog registry")
    registry_record_sha = validate_record_seal(registry, location="catalog registry")
    registry_sha = sha256_file(registry_path)
    synthetic = validate_synthetic_input(
        args.synthetic_dir, catalog_registry_sha256=registry_sha
    )
    human = validate_human_input(
        args.human_export_dir,
        candidate_ids=synthetic.candidate_ids,
        catalog_registry_sha256=registry_sha,
    )
    training = _train_student(
        args=args,
        synthetic=synthetic,
        human=human,
        catalog_registry=registry_path,
    )
    return _write_owned_output(
        output_dir=output,
        args=args,
        training=training,
        synthetic=synthetic,
        human=human,
        catalog_registry_sha256=registry_sha,
        catalog_registry_record_sha256=registry_record_sha,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    train = subparsers.add_parser("train")
    train.add_argument("--synthetic-dir", type=Path, required=True)
    train.add_argument("--human-export-dir", type=Path, required=True)
    train.add_argument("--catalog-registry", type=Path, required=True)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--epochs", type=int, default=8)
    train.add_argument("--patience", type=int, default=3)
    train.add_argument("--batch-size", type=int, default=16)
    train.add_argument("--eval-batch-size", type=int, default=16)
    train.add_argument("--human-fraction", type=float, default=0.25)
    train.add_argument("--encoder-lr", type=float, default=2e-5)
    train.add_argument("--head-lr", type=float, default=1e-4)
    train.add_argument("--weight-decay", type=float, default=0.01)
    train.add_argument("--consistency-weight", type=float, default=0.1)
    train.add_argument("--auxiliary-weight", type=float, default=0.2)
    train.add_argument("--prototypes-per-font", type=int, default=4)
    train.add_argument("--gradient-clip", type=float, default=1.0)
    train.add_argument("--min-delta", type=float, default=1e-4)
    train.add_argument("--seed", type=int, default=20260803)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = train_command(args) if args.command == "train" else validate_output(
            args.output_dir
        )
    except MangaFontStudentError as error:
        raise SystemExit(str(error)) from error
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
