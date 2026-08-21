#!/usr/bin/env python3
"""Build a sealed, training-only same-page dialogue overlay for manga-font v3.

The source labels are the 1,347 direct visual labels retained by the v2
handoff.  They are *not* human gold and must never acquire calibration,
release, or locked-evaluation authority here.  This builder only derives
same-page groups whose ordinary dialogue rows share at least one reviewed
positive font after removing ``single-day``.

The first three works in ``SHA256(seed NUL work_id)`` order form a
development-only diagnostic split.  Every row from those works is excluded
from v3 gradients and checkpoint selection by the companion trainer.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
import stat
import tempfile
from collections import defaultdict
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import train_manga_font_student_v8_role_family_adapter as v8
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v8_role_family_adapter as v8


SCHEMA_VERSION = "manga-font-v3-page-consistency-overlay-v1"
SOURCE_SCHEMA_VERSION = "manga-font-v2-high-value-supervised-labels-v1"
OWNER = "carrot-manga-translator/manga-font-v3-page-consistency-overlay-v1"
OVERLAY_FILE = "page-consistency-overlay.jsonl"
DIRECT_FAMILY_FILE = "direct-family-overlay.jsonl"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-page-consistency-overlay-v1-owned.json"
OUTPUT_FILES = frozenset({OVERLAY_FILE, DIRECT_FAMILY_FILE, MANIFEST_FILE, MARKER_FILE})
EXPECTED_MARKER_KEYS = frozenset(
    {"artifacts", "owner", "record_sha256", "safe_replace", "schema_version"}
)
EXPECTED_MANIFEST_KEYS = frozenset(
    {
        "artifacts",
        "authority",
        "base_dataset",
        "counts",
        "direct_family_record_inventory_sha256",
        "direct_family_source_record_inventory_sha256",
        "groups",
        "overlay_record_inventory_sha256",
        "record_sha256",
        "record_type",
        "schema_version",
        "source_label_record_inventory_sha256",
        "source_labels",
        "split",
    }
)
EXPECTED_DIRECT_ROW_KEYS = frozenset(
    {
        "authority",
        "base_binding",
        "family",
        "identity",
        "record_sha256",
        "record_type",
        "role",
        "sample_id",
        "schema_version",
        "source_label_record_sha256",
        "split",
        "supervision_weight",
    }
)
EXPECTED_PAGE_ROW_KEYS = frozenset(
    {
        "authority",
        "base_binding",
        "candidate_labels",
        "group_id",
        "group_position",
        "group_size",
        "identity",
        "record_sha256",
        "record_type",
        "sample_id",
        "schema_version",
        "source_label_record_sha256",
        "split",
        "supervision_weight",
    }
)
SOURCE_LABEL_FILE = "training-labels.jsonl"
SOURCE_MANIFEST_FILE = "manifest.json"
SOURCE_REPORT_FILE = "report.json"
SOURCE_MARKER_FILE = ".manga-font-v2-high-value-supervised-labels-v1-owned.json"
SOURCE_FILES = frozenset(
    {
        SOURCE_LABEL_FILE,
        SOURCE_MANIFEST_FILE,
        SOURCE_REPORT_FILE,
        SOURCE_MARKER_FILE,
    }
)
DEFAULT_SEED = "11"
DEFAULT_EVAL_WORK_COUNT = 3
PRODUCTION_SOURCE_ROWS = 1_347
PRODUCTION_SOURCE_LABEL_SHA256 = (
    "513a5e9597273f0aa7ecbc195ac67332f4628a31be600f679998583a008c0d9a"
)
PRODUCTION_SOURCE_MANIFEST_SHA256 = (
    "27f467f915f4048472e8b63acb00dd46ac29e555509028673e782e37ca04388a"
)
PRODUCTION_BASE_NPZ_SHA256 = (
    "901ee8a0f6e72d42ee917a6827bc76009245ebeda0c479e9e02feb4238107f83"
)
EXPECTED_OVERLAY_AUTHORITY = {
    "automatic_label_promotion_allowed": False,
    "automatic_release_authority": False,
    "calibration_eligible": False,
    "development_eval_is_locked_holdout": False,
    "development_eval_is_model_selection_authority": False,
    "development_eval_purpose": "post_selection_diagnostic_only",
    "human_gold": False,
    "source_authority_preserved_as_training_only": True,
    "training_only": True,
}
EXPECTED_SOURCE_MANIFEST_AUTHORITY = {
    "automatic_label_promotion_allowed": False,
    "automatic_release_authority": False,
    "calibration_eligible": False,
    "evaluation_eligible": False,
    "human_gold": False,
    "review_authority": "codex_agent_direct_visual_supervision",
    "training_eligible": True,
    "training_only": True,
}
EXPECTED_SOURCE_ROW_AUTHORITY = {
    **EXPECTED_SOURCE_MANIFEST_AUTHORITY,
    "label_authority": "blind_agent_visual_supervision_deblinded_after_review",
}
PRODUCTION_COUNTS = {
    "group_count": 123,
    "row_count": 262,
    "work_count": 13,
    "development_eval_group_count": 32,
    "development_eval_row_count": 65,
    "development_eval_work_count": 3,
    "direct_family_development_eval_body_rows": 202,
    "direct_family_development_eval_rows": 305,
    "direct_family_development_eval_variant_rows": 103,
    "direct_family_row_count": 1_347,
    "direct_family_train_body_rows": 667,
    "direct_family_train_rows": 1_042,
    "direct_family_train_variant_rows": 375,
    "discriminative_shared_support_group_count": 91,
    "discriminative_shared_support_row_count": 194,
    "js_capable_group_count": 119,
    "js_capable_row_count": 253,
    "train_group_count": 91,
    "train_row_count": 197,
    "train_work_count": 10,
    "unique_shared_positive_group_count": 42,
    "unique_shared_positive_row_count": 92,
}

DEFAULT_SOURCE_LABEL_DIR = Path(
    "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-1600-"
    "training-only-r1"
)
DEFAULT_BASE_NPZ = Path(
    "artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout/"
    "role-family-dataset.npz"
)


class PageConsistencyOverlayError(ValueError):
    """Raised when an overlay or one of its training-only sources drifts."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_link_or_reparse(path: Path) -> bool:
    """Reject symlinks and Windows junction/reparse points without resolving first."""

    try:
        if path.is_symlink():
            return True
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _contains_link_or_reparse(root: Path) -> bool:
    try:
        return any(_is_link_or_reparse(path) for path in root.iterdir())
    except OSError:
        return True


def _path_or_ancestor_is_link_or_reparse(path: Path) -> bool:
    return any(_is_link_or_reparse(value) for value in (path, *path.parents))


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    expected = record.get("record_sha256")
    if not _is_sha256(expected):
        raise PageConsistencyOverlayError(f"{location}: invalid record seal")
    body = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(body).encode("utf-8")) != expected:
        raise PageConsistencyOverlayError(f"{location}: record seal drifted")


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PageConsistencyOverlayError(f"{location}: expected object")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise PageConsistencyOverlayError(f"{location}: expected nonempty text")
    return value


def _string_sequence(value: Any, location: str) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise PageConsistencyOverlayError(f"{location}: expected string array")
    result = tuple(_text(item, f"{location}[]") for item in value)
    if len(result) != len(set(result)):
        raise PageConsistencyOverlayError(f"{location}: duplicate values")
    return result


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PageConsistencyOverlayError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _read_canonical_jsonl(path: Path, location: str) -> list[Mapping[str, Any]]:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise PageConsistencyOverlayError(f"{location}: unreadable JSONL") from error
    if payload and not payload.endswith(b"\n"):
        raise PageConsistencyOverlayError(f"{location}: final newline is required")
    rows: list[Mapping[str, Any]] = []
    for line_number, raw in enumerate(payload.splitlines(), start=1):
        try:
            decoded = raw.decode("utf-8")
            value = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PageConsistencyOverlayError(
                f"{location}:{line_number}: invalid JSON"
            ) from error
        row = _mapping(value, f"{location}:{line_number}")
        if decoded != canonical_json(row):
            raise PageConsistencyOverlayError(
                f"{location}:{line_number}: JSONL is not canonical"
            )
        rows.append(row)
    return rows


def _artifact_descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _verify_descriptor(
    path: Path, descriptor: Mapping[str, Any], *, row_count: int | None = None
) -> None:
    if (
        descriptor.get("file") != path.name
        or descriptor.get("byte_size") != path.stat().st_size
        or descriptor.get("sha256") != sha256_file(path)
        or (row_count is not None and descriptor.get("row_count") != row_count)
    ):
        raise PageConsistencyOverlayError(f"artifact descriptor drifted: {path.name}")


def validate_source_labels(
    source_dir: Path, *, expected_row_count: int | None = PRODUCTION_SOURCE_ROWS
) -> tuple[list[Mapping[str, Any]], Mapping[str, Any]]:
    expanded = source_dir.expanduser().absolute()
    if _path_or_ancestor_is_link_or_reparse(expanded):
        raise PageConsistencyOverlayError("source label directory is linked")
    root = expanded.resolve()
    if not root.is_dir() or _contains_link_or_reparse(root):
        raise PageConsistencyOverlayError("source label directory is missing or linked")
    if {path.name for path in root.iterdir()} != SOURCE_FILES:
        raise PageConsistencyOverlayError("source label exact inventory drifted")
    marker = _read_json(root / SOURCE_MARKER_FILE, "source label marker")
    manifest = _read_json(root / SOURCE_MANIFEST_FILE, "source label manifest")
    report = _read_json(root / SOURCE_REPORT_FILE, "source label report")
    for record, label in (
        (marker, "source label marker"),
        (manifest, "source label manifest"),
        (report, "source label report"),
    ):
        validate_record_seal(record, label)
    marker_artifacts = _mapping(marker.get("artifacts"), "source marker artifacts")
    if (
        marker.get("owner")
        != "carrot-manga-translator/manga-font-v2-high-value-supervised-labels-v1"
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SOURCE_SCHEMA_VERSION
        or set(marker_artifacts)
        != {SOURCE_LABEL_FILE, SOURCE_MANIFEST_FILE, SOURCE_REPORT_FILE}
    ):
        raise PageConsistencyOverlayError("source label marker contract drifted")
    for name in marker_artifacts:
        if marker_artifacts[name] != sha256_file(root / name):
            raise PageConsistencyOverlayError(
                f"source label marker hash drifted: {name}"
            )
    if (
        manifest.get("schema_version") != SOURCE_SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v2_high_value_supervised_labels_manifest"
        or report.get("schema_version") != SOURCE_SCHEMA_VERSION
        or report.get("record_type")
        != "manga_font_v2_high_value_supervised_labels_report"
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
    ):
        raise PageConsistencyOverlayError(
            "source label manifest/report contract drifted"
        )
    authority = _mapping(manifest.get("authority"), "source authority")
    if dict(authority) != EXPECTED_SOURCE_MANIFEST_AUTHORITY:
        raise PageConsistencyOverlayError("source label authority was elevated")
    rows = _read_canonical_jsonl(root / SOURCE_LABEL_FILE, "source labels")
    if expected_row_count is not None and len(rows) != expected_row_count:
        raise PageConsistencyOverlayError(
            f"expected {expected_row_count} source labels, found {len(rows)}"
        )
    if expected_row_count == PRODUCTION_SOURCE_ROWS and (
        sha256_file(root / SOURCE_LABEL_FILE) != PRODUCTION_SOURCE_LABEL_SHA256
        or sha256_file(root / SOURCE_MANIFEST_FILE) != PRODUCTION_SOURCE_MANIFEST_SHA256
    ):
        raise PageConsistencyOverlayError(
            "source is not the exact sealed 1,347-label production input"
        )
    if expected_row_count == PRODUCTION_SOURCE_ROWS:
        try:
            from scripts import (
                seal_manga_font_v2_high_value_supervised_labels_range_v6 as source_v6,
            )
        except ImportError:  # pragma: no cover - direct execution from scripts/
            import seal_manga_font_v2_high_value_supervised_labels_range_v6 as source_v6

        validation = source_v6.validate_output(root)
        if (
            validation.get("training_label_rows") != PRODUCTION_SOURCE_ROWS
            or validation.get("status")
            != "validated_training_only_high_value_supervision"
            or validation.get("recrop_ruby_split_positive_promotions") != 0
            or validation.get("recrop_ruby_split_negative_promotions") != 0
        ):
            raise PageConsistencyOverlayError(
                "full sealed 1,347-label validation did not pass"
            )
    label_descriptor = _mapping(manifest.get("labels"), "source labels descriptor")
    report_artifacts = _mapping(report.get("artifacts"), "source report artifacts")
    _verify_descriptor(root / SOURCE_LABEL_FILE, label_descriptor, row_count=len(rows))
    _verify_descriptor(
        root / SOURCE_LABEL_FILE,
        _mapping(report_artifacts.get(SOURCE_LABEL_FILE), "source report labels"),
        row_count=len(rows),
    )
    _verify_descriptor(
        root / SOURCE_MANIFEST_FILE,
        _mapping(report_artifacts.get(SOURCE_MANIFEST_FILE), "source report manifest"),
    )
    sample_ids: set[str] = set()
    for index, row in enumerate(rows):
        location = f"source labels row {index + 1}"
        validate_record_seal(row, location)
        row_authority = _mapping(row.get("authority"), f"{location}.authority")
        if (
            row.get("schema_version") != SOURCE_SCHEMA_VERSION
            or row.get("record_type") != "manga_font_v2_high_value_training_label"
            or dict(row_authority) != EXPECTED_SOURCE_ROW_AUTHORITY
        ):
            raise PageConsistencyOverlayError(f"{location}: authority drifted")
        sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in sample_ids:
            raise PageConsistencyOverlayError("source sample IDs are duplicated")
        sample_ids.add(sample_id)
    return rows, {
        "candidate_ids": list(
            _string_sequence(manifest.get("candidate_ids"), "source candidate_ids")
        ),
        "directory": str(root),
        "labels": _artifact_descriptor(root / SOURCE_LABEL_FILE, row_count=len(rows)),
        "manifest": {
            **_artifact_descriptor(root / SOURCE_MANIFEST_FILE),
            "record_sha256": manifest["record_sha256"],
        },
        "marker": _artifact_descriptor(root / SOURCE_MARKER_FILE),
        "report": {
            **_artifact_descriptor(root / SOURCE_REPORT_FILE),
            "record_sha256": report["record_sha256"],
        },
        "row_count": len(rows),
    }


def work_split(
    work_ids: Sequence[str], *, seed: str, eval_work_count: int
) -> Mapping[str, Any]:
    unique = tuple(sorted(set(work_ids)))
    if not seed or eval_work_count < 1 or len(unique) <= eval_work_count:
        raise PageConsistencyOverlayError("work split needs train and eval works")
    ordered = tuple(
        sorted(
            unique,
            key=lambda work_id: (
                hashlib.sha256(
                    seed.encode("utf-8") + b"\0" + work_id.encode("utf-8")
                ).hexdigest(),
                work_id,
            ),
        )
    )
    return {
        "development_eval_work_ids": list(ordered[:eval_work_count]),
        "hash_contract": "SHA256(UTF8(seed) || NUL || UTF8(work_id))",
        "ordered_work_ids": list(ordered),
        "seed": seed,
        "train_work_ids": list(ordered[eval_work_count:]),
    }


def select_page_groups(
    source_rows: Sequence[Mapping[str, Any]],
    *,
    candidate_ids: Sequence[str],
    seed: str = DEFAULT_SEED,
    eval_work_count: int = DEFAULT_EVAL_WORK_COUNT,
) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    candidates = tuple(candidate_ids)
    if len(candidates) != len(set(candidates)) or "single-day" not in candidates:
        raise PageConsistencyOverlayError("candidate inventory is invalid")
    candidate_set = set(candidates)
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for source_row in source_rows:
        if source_row.get("family") != "body" or source_row.get("role") != "dialogue":
            continue
        identity = _mapping(source_row.get("identity"), "source identity")
        labels = _mapping(source_row.get("candidate_labels"), "candidate labels")
        positives = set(
            _string_sequence(
                labels.get("positive_candidate_ids"), "positive candidates"
            )
        )
        eligible = set(
            _string_sequence(
                labels.get("eligible_candidate_ids"), "eligible candidates"
            )
        )
        preferred = set(
            _string_sequence(
                labels.get("preferred_candidate_ids"), "preferred candidates"
            )
        )
        if (
            not positives
            or not positives <= eligible
            or not preferred <= positives
            or not eligible <= candidate_set
        ):
            raise PageConsistencyOverlayError("source candidate masks are inconsistent")
        positives.discard("single-day")
        eligible.discard("single-day")
        preferred.discard("single-day")
        grouped[
            (
                _text(identity.get("work_id"), "identity.work_id"),
                _text(identity.get("page_id"), "identity.page_id"),
            )
        ].append(
            {
                "eligible": eligible,
                "positive": positives,
                "preferred": preferred,
                "source": source_row,
            }
        )
    selected: list[dict[str, Any]] = []
    for (work_id, page_id), rows in grouped.items():
        if len(rows) < 2 or any(not row["positive"] for row in rows):
            continue
        common = set.intersection(*(row["positive"] for row in rows))
        shared_reviewed = set.intersection(*(row["eligible"] for row in rows))
        if not common:
            continue
        if not common <= shared_reviewed:
            raise PageConsistencyOverlayError(
                "common positive escaped shared reviewed eligibility"
            )
        selected.append(
            {
                "common_positive_candidate_ids": [
                    candidate for candidate in candidates if candidate in common
                ],
                "group_id": "pcg_"
                + sha256_bytes(f"{work_id}\0{page_id}".encode("utf-8"))[:24],
                "page_id": page_id,
                "rows": sorted(rows, key=lambda row: str(row["source"]["sample_id"])),
                "shared_reviewed_eligible_candidate_ids": [
                    candidate
                    for candidate in candidates
                    if candidate in shared_reviewed
                ],
                "work_id": work_id,
            }
        )
    if not selected:
        raise PageConsistencyOverlayError("no page-consistency groups survived")
    if len({group["group_id"] for group in selected}) != len(selected):
        raise PageConsistencyOverlayError("derived group IDs collided")
    split = work_split(
        [str(group["work_id"]) for group in selected],
        seed=seed,
        eval_work_count=eval_work_count,
    )
    eval_works = set(split["development_eval_work_ids"])
    for group in selected:
        group["split"] = (
            "development_eval" if group["work_id"] in eval_works else "train"
        )
    selected.sort(
        key=lambda group: (
            0 if group["split"] == "train" else 1,
            str(group["work_id"]),
            str(group["page_id"]),
        )
    )
    return selected, split


def _count_groups(groups: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts = {
        "group_count": len(groups),
        "row_count": sum(len(group["rows"]) for group in groups),
        "work_count": len({str(group["work_id"]) for group in groups}),
    }
    for split in ("train", "development_eval"):
        selected = [group for group in groups if group["split"] == split]
        counts[f"{split}_group_count"] = len(selected)
        counts[f"{split}_row_count"] = sum(len(group["rows"]) for group in selected)
        counts[f"{split}_work_count"] = len(
            {str(group["work_id"]) for group in selected}
        )
    support_slices = {
        "discriminative_shared_support": lambda group: bool(
            set(group["shared_reviewed_eligible_candidate_ids"])
            - set(group["common_positive_candidate_ids"])
        ),
        "js_capable": lambda group: (
            len(group["shared_reviewed_eligible_candidate_ids"]) > 1
        ),
        "unique_shared_positive": lambda group: (
            len(group["common_positive_candidate_ids"]) == 1
        ),
    }
    for name, predicate in support_slices.items():
        selected = [group for group in groups if predicate(group)]
        counts[f"{name}_group_count"] = len(selected)
        counts[f"{name}_row_count"] = sum(len(group["rows"]) for group in selected)
    return counts


def _direct_family_counts(rows: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts = {"direct_family_row_count": len(rows)}
    for split in ("train", "development_eval"):
        selected = [row for row in rows if row["split"] == split]
        counts[f"direct_family_{split}_rows"] = len(selected)
        for family in ("body", "variant"):
            counts[f"direct_family_{split}_{family}_rows"] = sum(
                row["family"] == family for row in selected
            )
    return counts


def _assert_counts(counts: Mapping[str, int], expected: Mapping[str, int]) -> None:
    drift = {
        key: {"expected": value, "actual": counts.get(key)}
        for key, value in expected.items()
        if counts.get(key) != value
    }
    if drift:
        raise PageConsistencyOverlayError(f"derived production counts drifted: {drift}")


def _safe_new_output(path: Path) -> Path:
    output = path.expanduser().absolute()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}
    if output in forbidden or len(output.parts) < 3 or len(output.name) < 3:
        raise PageConsistencyOverlayError(f"unsafe output directory: {output}")
    if output.exists() or _is_link_or_reparse(output):
        raise PageConsistencyOverlayError("output directory must be new and absent")
    if _path_or_ancestor_is_link_or_reparse(output):
        raise PageConsistencyOverlayError("output parent cannot be linked")
    return output


def _ordered_candidates(values: set[str], candidate_ids: Sequence[str]) -> list[str]:
    return [candidate_id for candidate_id in candidate_ids if candidate_id in values]


def _expected_row_authority(split: str) -> Mapping[str, Any]:
    return {
        "automatic_release_authority": False,
        "calibration_eligible": False,
        "development_diagnostic_only": split == "development_eval",
        "human_gold": False,
        "optimizer_gradient_eligible": split == "train",
        "source_training_only": True,
        "training_only": True,
    }


def build_overlay(
    *,
    source_label_dir: Path,
    base_npz: Path,
    output_dir: Path,
    seed: str = DEFAULT_SEED,
    eval_work_count: int = DEFAULT_EVAL_WORK_COUNT,
    expected_source_rows: int | None = PRODUCTION_SOURCE_ROWS,
    expected_counts: Mapping[str, int] | None = PRODUCTION_COUNTS,
    expected_base_npz_sha256: str | None = PRODUCTION_BASE_NPZ_SHA256,
) -> Mapping[str, Any]:
    output = _safe_new_output(output_dir)
    source_rows, source_binding = validate_source_labels(
        source_label_dir, expected_row_count=expected_source_rows
    )
    base_input = base_npz.expanduser().absolute()
    if _path_or_ancestor_is_link_or_reparse(base_input):
        raise PageConsistencyOverlayError("base NPZ cannot be linked")
    dataset_path, arrays, base_inventory = v8._load_training_npz(base_input)
    base_sha256 = sha256_file(dataset_path)
    if expected_base_npz_sha256 is not None and base_sha256 != expected_base_npz_sha256:
        raise PageConsistencyOverlayError(
            "base NPZ is not the exact production r3 dataset"
        )
    candidate_ids = tuple(str(value) for value in base_inventory["candidate_ids"])
    if tuple(source_binding["candidate_ids"]) != candidate_ids:
        raise PageConsistencyOverlayError("source/base candidate IDs drifted")
    groups, split = select_page_groups(
        source_rows,
        candidate_ids=candidate_ids,
        seed=seed,
        eval_work_count=eval_work_count,
    )
    sample_to_index = {
        str(sample_id): index for index, sample_id in enumerate(arrays["sample_ids"])
    }
    if len(sample_to_index) != len(arrays["sample_ids"]):
        raise PageConsistencyOverlayError("base NPZ sample IDs are duplicated")
    eval_works = set(split["development_eval_work_ids"])
    direct_family_rows: list[dict[str, Any]] = []
    for source_row in sorted(source_rows, key=lambda row: str(row["sample_id"])):
        sample_id = _text(source_row.get("sample_id"), "direct-family sample_id")
        if sample_id not in sample_to_index:
            raise PageConsistencyOverlayError(
                f"direct-family sample is absent from base NPZ: {sample_id}"
            )
        base_index = sample_to_index[sample_id]
        identity = _mapping(source_row.get("identity"), "direct-family identity")
        work_id = _text(identity.get("work_id"), "direct-family work_id")
        family = _text(source_row.get("family"), "direct-family family")
        if family not in {"body", "variant"}:
            raise PageConsistencyOverlayError("direct-family target is not binary")
        if str(arrays["work_ids"][base_index]) != work_id:
            raise PageConsistencyOverlayError("direct-family/base work ID drifted")
        row_split = "development_eval" if work_id in eval_works else "train"
        direct_family_rows.append(
            seal_record(
                {
                    "authority": dict(_expected_row_authority(row_split)),
                    "base_binding": {
                        "base_npz_sha256": base_sha256,
                        "base_row_index": base_index,
                        "sample_id": sample_id,
                        "work_id": work_id,
                    },
                    "family": family,
                    "identity": copy.deepcopy(dict(identity)),
                    "record_type": "manga_font_v3_direct_family_overlay_row",
                    "role": _text(source_row.get("role"), "direct-family role"),
                    "sample_id": sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "source_label_record_sha256": _text(
                        source_row.get("record_sha256"),
                        "direct-family source record seal",
                    ),
                    "split": row_split,
                    "supervision_weight": float(source_row["supervision_weight"]),
                }
            )
        )
    counts = {**_count_groups(groups), **_direct_family_counts(direct_family_rows)}
    if expected_counts is not None:
        _assert_counts(counts, expected_counts)
    overlay_rows: list[dict[str, Any]] = []
    group_manifest: list[dict[str, Any]] = []
    for group in groups:
        row_seals: list[str] = []
        source_seals: list[str] = []
        common = set(group["common_positive_candidate_ids"])
        for group_position, selected in enumerate(group["rows"]):
            source_row = selected["source"]
            sample_id = _text(source_row.get("sample_id"), "selected sample_id")
            if sample_id not in sample_to_index:
                raise PageConsistencyOverlayError(
                    f"selected sample is absent from base NPZ: {sample_id}"
                )
            base_index = sample_to_index[sample_id]
            if str(arrays["work_ids"][base_index]) != group["work_id"]:
                raise PageConsistencyOverlayError("source/base work ID drifted")
            identity = _mapping(source_row.get("identity"), "selected identity")
            source_seal = _text(
                source_row.get("record_sha256"), "selected source record seal"
            )
            row = seal_record(
                {
                    "authority": dict(_expected_row_authority(group["split"])),
                    "base_binding": {
                        "base_npz_sha256": base_sha256,
                        "base_row_index": base_index,
                        "sample_id": sample_id,
                        "work_id": str(arrays["work_ids"][base_index]),
                    },
                    "candidate_labels": {
                        "common_positive_candidate_ids": list(
                            group["common_positive_candidate_ids"]
                        ),
                        "eligible_candidate_ids": _ordered_candidates(
                            set(selected["eligible"]), candidate_ids
                        ),
                        "positive_candidate_ids": _ordered_candidates(
                            set(selected["positive"]), candidate_ids
                        ),
                        "preferred_candidate_ids": _ordered_candidates(
                            set(selected["preferred"]), candidate_ids
                        ),
                        "shared_reviewed_eligible_candidate_ids": list(
                            group["shared_reviewed_eligible_candidate_ids"]
                        ),
                    },
                    "group_id": group["group_id"],
                    "group_position": group_position,
                    "group_size": len(group["rows"]),
                    "identity": {
                        "chapter_id": _text(
                            identity.get("chapter_id"), "identity.chapter_id"
                        ),
                        "master_row_sha256": _text(
                            identity.get("master_row_sha256"),
                            "identity.master_row_sha256",
                        ),
                        "page_id": group["page_id"],
                        "source_page_sha256": _text(
                            identity.get("source_page_sha256"),
                            "identity.source_page_sha256",
                        ),
                        "work_id": group["work_id"],
                    },
                    "record_type": "manga_font_v3_page_consistency_overlay_row",
                    "sample_id": sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "source_label_record_sha256": source_seal,
                    "split": group["split"],
                    "supervision_weight": float(source_row["supervision_weight"]),
                }
            )
            if not common <= set(row["candidate_labels"]["positive_candidate_ids"]):
                raise PageConsistencyOverlayError(
                    "common positive escaped a source row"
                )
            overlay_rows.append(row)
            row_seals.append(row["record_sha256"])
            source_seals.append(source_seal)
        group_manifest.append(
            {
                "common_positive_candidate_ids": list(
                    group["common_positive_candidate_ids"]
                ),
                "group_id": group["group_id"],
                "overlay_record_sha256s": row_seals,
                "page_id": group["page_id"],
                "row_count": len(group["rows"]),
                "shared_reviewed_eligible_candidate_ids": list(
                    group["shared_reviewed_eligible_candidate_ids"]
                ),
                "source_label_record_sha256s": source_seals,
                "split": group["split"],
                "work_id": group["work_id"],
            }
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        overlay_path = staging / OVERLAY_FILE
        direct_family_path = staging / DIRECT_FAMILY_FILE
        overlay_path.write_bytes(
            b"".join(json_bytes(row, pretty=False) for row in overlay_rows)
        )
        direct_family_path.write_bytes(
            b"".join(json_bytes(row, pretty=False) for row in direct_family_rows)
        )
        manifest = seal_record(
            {
                "artifacts": {
                    DIRECT_FAMILY_FILE: _artifact_descriptor(
                        direct_family_path, row_count=len(direct_family_rows)
                    ),
                    OVERLAY_FILE: _artifact_descriptor(
                        overlay_path, row_count=len(overlay_rows)
                    ),
                },
                "authority": dict(EXPECTED_OVERLAY_AUTHORITY),
                "base_dataset": {
                    "candidate_ids": list(candidate_ids),
                    "file": str(dataset_path),
                    "row_count": int(base_inventory["row_count"]),
                    "sha256": base_sha256,
                },
                "counts": counts,
                "direct_family_record_inventory_sha256": sha256_bytes(
                    canonical_json(
                        [row["record_sha256"] for row in direct_family_rows]
                    ).encode("utf-8")
                ),
                "direct_family_source_record_inventory_sha256": sha256_bytes(
                    canonical_json(
                        [
                            row["source_label_record_sha256"]
                            for row in direct_family_rows
                        ]
                    ).encode("utf-8")
                ),
                "groups": group_manifest,
                "overlay_record_inventory_sha256": sha256_bytes(
                    canonical_json(
                        [row["record_sha256"] for row in overlay_rows]
                    ).encode("utf-8")
                ),
                "record_type": "manga_font_v3_page_consistency_overlay_manifest",
                "schema_version": SCHEMA_VERSION,
                "source_label_record_inventory_sha256": sha256_bytes(
                    canonical_json(
                        [row["source_label_record_sha256"] for row in overlay_rows]
                    ).encode("utf-8")
                ),
                "source_labels": source_binding,
                "split": split,
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    DIRECT_FAMILY_FILE: sha256_file(direct_family_path),
                    MANIFEST_FILE: sha256_file(manifest_path),
                    OVERLAY_FILE: sha256_file(overlay_path),
                },
                "owner": OWNER,
                "safe_replace": False,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(
            staging,
            require_sources=True,
            expected_counts=expected_counts,
            expected_base_npz_sha256=expected_base_npz_sha256,
        )
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(
        output,
        require_sources=True,
        expected_counts=expected_counts,
        expected_base_npz_sha256=expected_base_npz_sha256,
    )


def validate_output(
    output_dir: Path,
    *,
    require_sources: bool = True,
    expected_counts: Mapping[str, int] | None = PRODUCTION_COUNTS,
    expected_base_npz_sha256: str | None = PRODUCTION_BASE_NPZ_SHA256,
) -> Mapping[str, Any]:
    expanded = output_dir.expanduser().absolute()
    if _path_or_ancestor_is_link_or_reparse(expanded):
        raise PageConsistencyOverlayError("overlay directory is linked")
    root = expanded.resolve()
    if not root.is_dir() or _contains_link_or_reparse(root):
        raise PageConsistencyOverlayError("overlay directory is missing or linked")
    if {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise PageConsistencyOverlayError("overlay exact inventory drifted")
    marker = _read_json(root / MARKER_FILE, "overlay marker")
    manifest = _read_json(root / MANIFEST_FILE, "overlay manifest")
    validate_record_seal(marker, "overlay marker")
    validate_record_seal(manifest, "overlay manifest")
    marker_artifacts = _mapping(marker.get("artifacts"), "overlay marker artifacts")
    if (
        set(marker) != EXPECTED_MARKER_KEYS
        or set(manifest) != EXPECTED_MANIFEST_KEYS
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not False
        or marker.get("schema_version") != SCHEMA_VERSION
        or set(marker_artifacts) != {DIRECT_FAMILY_FILE, OVERLAY_FILE, MANIFEST_FILE}
        or marker_artifacts.get(DIRECT_FAMILY_FILE)
        != sha256_file(root / DIRECT_FAMILY_FILE)
        or marker_artifacts.get(OVERLAY_FILE) != sha256_file(root / OVERLAY_FILE)
        or marker_artifacts.get(MANIFEST_FILE) != sha256_file(root / MANIFEST_FILE)
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v3_page_consistency_overlay_manifest"
    ):
        raise PageConsistencyOverlayError("overlay marker/manifest contract drifted")
    authority = _mapping(manifest.get("authority"), "overlay authority")
    if dict(authority) != EXPECTED_OVERLAY_AUTHORITY:
        raise PageConsistencyOverlayError("overlay authority was elevated")
    rows = _read_canonical_jsonl(root / OVERLAY_FILE, "overlay rows")
    direct_family_rows = _read_canonical_jsonl(
        root / DIRECT_FAMILY_FILE, "direct-family rows"
    )
    artifacts = _mapping(manifest.get("artifacts"), "overlay artifacts")
    if set(artifacts) != {DIRECT_FAMILY_FILE, OVERLAY_FILE}:
        raise PageConsistencyOverlayError("overlay manifest artifact inventory drifted")
    _verify_descriptor(
        root / DIRECT_FAMILY_FILE,
        _mapping(artifacts.get(DIRECT_FAMILY_FILE), "direct-family descriptor"),
        row_count=len(direct_family_rows),
    )
    _verify_descriptor(
        root / OVERLAY_FILE,
        _mapping(artifacts.get(OVERLAY_FILE), "overlay descriptor"),
        row_count=len(rows),
    )
    base = _mapping(manifest.get("base_dataset"), "base dataset binding")
    candidate_ids = _string_sequence(base.get("candidate_ids"), "base candidate_ids")
    if (
        "single-day" not in candidate_ids
        or not _is_sha256(base.get("sha256"))
        or (
            expected_base_npz_sha256 is not None
            and base.get("sha256") != expected_base_npz_sha256
        )
    ):
        raise PageConsistencyOverlayError("base dataset binding drifted")
    direct_samples: set[str] = set()
    for index, row in enumerate(direct_family_rows):
        location = f"direct-family row {index + 1}"
        validate_record_seal(row, location)
        authority_row = _mapping(row.get("authority"), f"{location}.authority")
        binding = _mapping(row.get("base_binding"), f"{location}.base_binding")
        sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
        split_value = row.get("split")
        if (
            set(row) != EXPECTED_DIRECT_ROW_KEYS
            or row.get("schema_version") != SCHEMA_VERSION
            or row.get("record_type") != "manga_font_v3_direct_family_overlay_row"
            or row.get("family") not in {"body", "variant"}
            or split_value not in {"train", "development_eval"}
            or dict(authority_row) != _expected_row_authority(str(split_value))
            or binding.get("sample_id") != sample_id
            or binding.get("base_npz_sha256") != base.get("sha256")
            or not isinstance(binding.get("base_row_index"), int)
            or binding["base_row_index"] < 0
            or not _is_sha256(row.get("source_label_record_sha256"))
            or not math.isfinite(float(row.get("supervision_weight", math.nan)))
            or not 0 < float(row["supervision_weight"]) <= 1
        ):
            raise PageConsistencyOverlayError(f"{location}: row contract drifted")
        if sample_id in direct_samples:
            raise PageConsistencyOverlayError("direct-family sample IDs are duplicated")
        direct_samples.add(sample_id)
    group_rows: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    seen_samples: set[str] = set()
    for index, row in enumerate(rows):
        location = f"overlay row {index + 1}"
        validate_record_seal(row, location)
        row_authority = _mapping(row.get("authority"), f"{location}.authority")
        split = row.get("split")
        labels = _mapping(row.get("candidate_labels"), f"{location}.candidate_labels")
        positive = set(
            _string_sequence(
                labels.get("positive_candidate_ids"), f"{location}.positive"
            )
        )
        preferred = set(
            _string_sequence(
                labels.get("preferred_candidate_ids"), f"{location}.preferred"
            )
        )
        eligible = set(
            _string_sequence(
                labels.get("eligible_candidate_ids"), f"{location}.eligible"
            )
        )
        common = set(
            _string_sequence(
                labels.get("common_positive_candidate_ids"), f"{location}.common"
            )
        )
        shared_reviewed = set(
            _string_sequence(
                labels.get("shared_reviewed_eligible_candidate_ids"),
                f"{location}.shared_reviewed_eligible",
            )
        )
        binding = _mapping(row.get("base_binding"), f"{location}.base_binding")
        sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
        if (
            set(row) != EXPECTED_PAGE_ROW_KEYS
            or row.get("schema_version") != SCHEMA_VERSION
            or row.get("record_type") != "manga_font_v3_page_consistency_overlay_row"
            or split not in {"train", "development_eval"}
            or dict(row_authority) != _expected_row_authority(str(split))
            or not positive
            or not common
            or not shared_reviewed
            or not preferred <= positive
            or not common <= positive
            or not common <= shared_reviewed
            or not shared_reviewed <= eligible
            or not positive <= eligible
            or "single-day" in positive | preferred | eligible | common
            or not eligible <= set(candidate_ids)
            or binding.get("sample_id") != sample_id
            or binding.get("base_npz_sha256") != base.get("sha256")
            or not isinstance(binding.get("base_row_index"), int)
            or binding["base_row_index"] < 0
            or not _is_sha256(row.get("source_label_record_sha256"))
        ):
            raise PageConsistencyOverlayError(f"{location}: row contract drifted")
        if sample_id in seen_samples:
            raise PageConsistencyOverlayError("overlay sample IDs are duplicated")
        seen_samples.add(sample_id)
        group_rows[_text(row.get("group_id"), f"{location}.group_id")].append(row)
    groups = manifest.get("groups")
    if not isinstance(groups, Sequence) or isinstance(groups, (str, bytes)):
        raise PageConsistencyOverlayError("manifest groups must be an array")
    if len(groups) != len(group_rows):
        raise PageConsistencyOverlayError("manifest group inventory drifted")
    rebuilt_counts_input: list[dict[str, Any]] = []
    seen_group_ids: set[str] = set()
    for raw_group in groups:
        group = _mapping(raw_group, "manifest group")
        group_id = _text(group.get("group_id"), "manifest group_id")
        selected = group_rows.get(group_id, [])
        if group_id in seen_group_ids or len(selected) < 2:
            raise PageConsistencyOverlayError(
                "group IDs duplicate or group is too small"
            )
        seen_group_ids.add(group_id)
        selected.sort(key=lambda row: int(row["group_position"]))
        common = list(selected[0]["candidate_labels"]["common_positive_candidate_ids"])
        shared_reviewed = list(
            selected[0]["candidate_labels"]["shared_reviewed_eligible_candidate_ids"]
        )
        if (
            [int(row["group_position"]) for row in selected]
            != list(range(len(selected)))
            or any(int(row["group_size"]) != len(selected) for row in selected)
            or any(row["split"] != group.get("split") for row in selected)
            or any(
                row["identity"]["work_id"] != group.get("work_id") for row in selected
            )
            or any(
                row["identity"]["page_id"] != group.get("page_id") for row in selected
            )
            or any(
                list(row["candidate_labels"]["common_positive_candidate_ids"]) != common
                for row in selected
            )
            or any(
                list(row["candidate_labels"]["shared_reviewed_eligible_candidate_ids"])
                != shared_reviewed
                for row in selected
            )
            or group.get("common_positive_candidate_ids") != common
            or group.get("shared_reviewed_eligible_candidate_ids") != shared_reviewed
            or group.get("row_count") != len(selected)
            or group.get("overlay_record_sha256s")
            != [row["record_sha256"] for row in selected]
            or group.get("source_label_record_sha256s")
            != [row["source_label_record_sha256"] for row in selected]
        ):
            raise PageConsistencyOverlayError(f"group binding drifted: {group_id}")
        rebuilt_counts_input.append(
            {
                "common_positive_candidate_ids": common,
                "rows": selected,
                "shared_reviewed_eligible_candidate_ids": shared_reviewed,
                "split": group["split"],
                "work_id": group["work_id"],
            }
        )
    counts = {
        **_count_groups(rebuilt_counts_input),
        **_direct_family_counts(direct_family_rows),
    }
    if manifest.get("counts") != counts:
        raise PageConsistencyOverlayError("overlay counts drifted")
    if expected_counts is not None:
        _assert_counts(counts, expected_counts)
    if manifest.get("overlay_record_inventory_sha256") != sha256_bytes(
        canonical_json([row["record_sha256"] for row in rows]).encode("utf-8")
    ) or manifest.get("source_label_record_inventory_sha256") != sha256_bytes(
        canonical_json([row["source_label_record_sha256"] for row in rows]).encode(
            "utf-8"
        )
    ):
        raise PageConsistencyOverlayError("overlay record inventory seal drifted")
    if manifest.get("direct_family_record_inventory_sha256") != sha256_bytes(
        canonical_json([row["record_sha256"] for row in direct_family_rows]).encode(
            "utf-8"
        )
    ) or manifest.get("direct_family_source_record_inventory_sha256") != sha256_bytes(
        canonical_json(
            [row["source_label_record_sha256"] for row in direct_family_rows]
        ).encode("utf-8")
    ):
        raise PageConsistencyOverlayError("direct-family record inventory seal drifted")
    split = _mapping(manifest.get("split"), "overlay split")
    train_works = set(_string_sequence(split.get("train_work_ids"), "train works"))
    eval_works = set(
        _string_sequence(split.get("development_eval_work_ids"), "eval works")
    )
    if train_works & eval_works or train_works | eval_works != {
        str(group["work_id"]) for group in rebuilt_counts_input
    }:
        raise PageConsistencyOverlayError("overlay work split drifted")
    expected_split = work_split(
        sorted(train_works | eval_works),
        seed=_text(split.get("seed"), "overlay split seed"),
        eval_work_count=len(eval_works),
    )
    if dict(split) != expected_split:
        raise PageConsistencyOverlayError("overlay deterministic work split drifted")
    for group in rebuilt_counts_input:
        expected_group_split = (
            "development_eval" if group["work_id"] in eval_works else "train"
        )
        if group["split"] != expected_group_split:
            raise PageConsistencyOverlayError("overlay group split membership drifted")
    for row in direct_family_rows:
        expected_row_split = (
            "development_eval" if row["identity"]["work_id"] in eval_works else "train"
        )
        if row["split"] != expected_row_split:
            raise PageConsistencyOverlayError("direct-family split membership drifted")
    if require_sources:
        source = _mapping(manifest.get("source_labels"), "source label binding")
        source_rows, source_binding = validate_source_labels(
            Path(_text(source.get("directory"), "source label directory")),
            expected_row_count=int(source.get("row_count", -1)),
        )
        if source_binding != source:
            raise PageConsistencyOverlayError("source label binding drifted")
        base_input = (
            Path(_text(base.get("file"), "base dataset file")).expanduser().absolute()
        )
        if _path_or_ancestor_is_link_or_reparse(base_input):
            raise PageConsistencyOverlayError("base NPZ binding cannot be linked")
        dataset_path, arrays, inventory = v8._load_training_npz(base_input)
        if (
            sha256_file(dataset_path) != base.get("sha256")
            or tuple(inventory["candidate_ids"]) != candidate_ids
            or int(inventory["row_count"]) != base.get("row_count")
        ):
            raise PageConsistencyOverlayError("base NPZ binding drifted")
        source_by_sample = {str(row["sample_id"]): row for row in source_rows}
        if len(source_by_sample) != len(source_rows) or set(direct_samples) != set(
            source_by_sample
        ):
            raise PageConsistencyOverlayError(
                "direct-family/source sample inventory drifted"
            )
        recomputed_groups, recomputed_split = select_page_groups(
            source_rows,
            candidate_ids=candidate_ids,
            seed=_text(split.get("seed"), "overlay split seed"),
            eval_work_count=len(eval_works),
        )
        if recomputed_split != split:
            raise PageConsistencyOverlayError("source-derived work split drifted")
        expected_page_rows: dict[tuple[str, str], Mapping[str, Any]] = {}
        for expected_group in recomputed_groups:
            for position, selected_source in enumerate(expected_group["rows"]):
                source_row = selected_source["source"]
                expected_page_rows[
                    (str(expected_group["group_id"]), str(source_row["sample_id"]))
                ] = {
                    "common": list(expected_group["common_positive_candidate_ids"]),
                    "eligible": _ordered_candidates(
                        set(selected_source["eligible"]), candidate_ids
                    ),
                    "group_position": position,
                    "group_size": len(expected_group["rows"]),
                    "positive": _ordered_candidates(
                        set(selected_source["positive"]), candidate_ids
                    ),
                    "preferred": _ordered_candidates(
                        set(selected_source["preferred"]), candidate_ids
                    ),
                    "shared": list(
                        expected_group["shared_reviewed_eligible_candidate_ids"]
                    ),
                    "source": source_row,
                    "split": expected_group["split"],
                }
        if set(expected_page_rows) != {
            (str(row["group_id"]), str(row["sample_id"])) for row in rows
        }:
            raise PageConsistencyOverlayError(
                "source-derived page row inventory drifted"
            )
        for row in direct_family_rows:
            source_row = source_by_sample[str(row["sample_id"])]
            binding = row["base_binding"]
            base_index = int(binding["base_row_index"])
            expected_row_split = (
                "development_eval"
                if source_row["identity"]["work_id"] in eval_works
                else "train"
            )
            if (
                row["source_label_record_sha256"] != source_row["record_sha256"]
                or row["family"] != source_row["family"]
                or row["role"] != source_row["role"]
                or row["identity"] != source_row["identity"]
                or float(row["supervision_weight"])
                != float(source_row["supervision_weight"])
                or row["split"] != expected_row_split
                or base_index >= len(arrays["sample_ids"])
                or str(arrays["sample_ids"][base_index]) != row["sample_id"]
                or str(arrays["work_ids"][base_index])
                != source_row["identity"]["work_id"]
            ):
                raise PageConsistencyOverlayError(
                    "direct-family row/source binding drifted"
                )
        for row in rows:
            binding = row["base_binding"]
            base_index = int(binding["base_row_index"])
            expected = expected_page_rows[(str(row["group_id"]), str(row["sample_id"]))]
            source_row = expected["source"]
            labels = row["candidate_labels"]
            if (
                base_index >= len(arrays["sample_ids"])
                or str(arrays["sample_ids"][base_index]) != row["sample_id"]
                or str(arrays["work_ids"][base_index]) != binding["work_id"]
                or row["source_label_record_sha256"] != source_row["record_sha256"]
                or row["identity"] != source_row["identity"]
                or float(row["supervision_weight"])
                != float(source_row["supervision_weight"])
                or row["split"] != expected["split"]
                or int(row["group_position"]) != expected["group_position"]
                or int(row["group_size"]) != expected["group_size"]
                or labels["positive_candidate_ids"] != expected["positive"]
                or labels["preferred_candidate_ids"] != expected["preferred"]
                or labels["eligible_candidate_ids"] != expected["eligible"]
                or labels["common_positive_candidate_ids"] != expected["common"]
                or labels["shared_reviewed_eligible_candidate_ids"]
                != expected["shared"]
            ):
                raise PageConsistencyOverlayError(
                    "overlay/source/base row binding drifted"
                )
    return {
        "candidate_ids": list(candidate_ids),
        "counts": counts,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(root / MANIFEST_FILE),
        "output_dir": str(root),
        "direct_family_sha256": sha256_file(root / DIRECT_FAMILY_FILE),
        "overlay_sha256": sha256_file(root / OVERLAY_FILE),
        "schema_version": SCHEMA_VERSION,
        "status": "valid_training_only_page_consistency_overlay",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument(
        "--source-label-dir", type=Path, default=DEFAULT_SOURCE_LABEL_DIR
    )
    build.add_argument("--base-npz", type=Path, default=DEFAULT_BASE_NPZ)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--seed", default=DEFAULT_SEED)
    build.add_argument("--eval-work-count", type=int, default=DEFAULT_EVAL_WORK_COUNT)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "build":
        result = build_overlay(
            source_label_dir=args.source_label_dir,
            base_npz=args.base_npz,
            output_dir=args.output_dir,
            seed=args.seed,
            eval_work_count=args.eval_work_count,
        )
    elif args.command == "validate":
        result = validate_output(args.output_dir)
    else:  # pragma: no cover - argparse owns command choices
        raise PageConsistencyOverlayError(f"unsupported command: {args.command}")
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
