#!/usr/bin/env python3
"""Build the sealed MangaFont v8 role/family adapter NPZ.

The dataset deliberately separates authority from availability:

* every master-v3 train crop contributes pixels and a weak role-family target;
* human-final rows are the only human font authority;
* completed A-H visible-five reviews remain ``visual`` pseudo authority;
* ordinary pseudo-only rows have no font masks or font loss weight;
* master test rows are never exported and train/validation works must be disjoint.

The R5 query head and its candidate-query prototype bank are consumed exactly as
sealed.  No OCR text, font name, Gemma output, genre, or page geometry is used.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_manga_font_master_v3_siglip2_hidden_cache as hidden_cache
    from scripts import build_manga_font_student_human_overlay_v1 as human_val_overlay
    from scripts import build_manga_font_visual_pseudo_overlay_v1 as visual_overlay
    from scripts import export_manga_font_student_v7_mass21_runtime_onnx as v7_export
    from scripts import label_manga_font_student_v7_mass21_pass as labeler
    from scripts import refine_manga_font_v2_pseudo_labels as refinement
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_mass21_data as mass21
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_master_v3_siglip2_hidden_cache as hidden_cache
    import build_manga_font_student_human_overlay_v1 as human_val_overlay
    import build_manga_font_visual_pseudo_overlay_v1 as visual_overlay
    import export_manga_font_student_v7_mass21_runtime_onnx as v7_export
    import label_manga_font_student_v7_mass21_pass as labeler
    import refine_manga_font_v2_pseudo_labels as refinement
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_mass21_data as mass21


SCHEMA = "manga-font-student-v8-role-family-dataset-v3"
OWNER = "carrot-manga-translator/manga-font-student-v8-role-family-dataset-v3"
MARKER_FILE = ".manga-font-student-v8-role-family-dataset-v3-owned.json"
DATASET_FILE = "role-family-dataset.npz"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset({MARKER_FILE, DATASET_FILE, MANIFEST_FILE, REPORT_FILE})

QUERY_COUNT = 4
QUERY_DIM = 256
VIEW_COUNT = 3
BODY_FAMILY = 0
VARIANT_FAMILY = 1
FONT_AUTHORITIES = frozenset({"none", "human", "visual"})
NPZ_FIELDS = frozenset(
    {
        "candidate_ids",
        "query_views",
        "prototype_queries",
        "family_labels",
        "family_label_weights",
        "positive_mask",
        "preferred_mask",
        "candidate_eligible_mask",
        "font_supervision_weights",
        "single_day_body_negative",
        "font_authority",
        "sample_ids",
        "work_ids",
        "split",
    }
)

BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
VARIANT_ROLES = frozenset(set(base.ROLE_VALUES) - set(BODY_ROLES))
BODY_ORDINARY_CATEGORIES = frozenset({"ordinary"})
SOURCE_CATEGORY_ROLES: Mapping[str, str] = {
    "ordinary": "dialogue",
    "page_sound": "sfx_impact",
    "text_free": "emphasis_dialogue",
    "bubble_edge": "aside_balloon_edge",
    "ocr_hard": "emphasis_dialogue",
    "ocr_anime_region": "emphasis_dialogue",
    "font_signal_present": "emphasis_dialogue",
}
SOURCE_FAMILY_WEIGHTS: Mapping[str, float] = {
    "ordinary": 0.80,
    "bubble_edge": 0.70,
    "page_sound": 0.90,
    "text_free": 0.65,
    "font_signal_present": 0.45,
    "ocr_hard": 0.35,
    "ocr_anime_region": 0.35,
}
BODY_HOLDOUT_WORK_ID = "959d46a5-2d3e-4bbc-b13c-f7b8510447ce"
SUPPORTED_ADAPTER_VALIDATION_WORKS: Mapping[str, Mapping[str, int]] = {
    BODY_HOLDOUT_WORK_ID: {
        "body_rows": 2_866,
        "human_rows": 46,
        "row_count": 4_815,
        "variant_rows": 1_949,
        "visual_rows": 575,
    }
}


class V8RoleFamilyDatasetError(ValueError):
    """Raised when the dataset would cross an authority or split boundary."""


@dataclass(frozen=True)
class HumanFontLabel:
    sample_id: str
    role: str
    role_confidence: float
    positive_ids: tuple[str, ...]
    preferred_ids: tuple[str, ...]
    eligible_ids: tuple[str, ...]
    work_id: str | None = None


@dataclass(frozen=True)
class PassRow:
    sample_id: str
    work_id: str
    split: str
    role: str
    source_category: str
    master_row_sha256: str


@dataclass(frozen=True)
class VisualFontLabel:
    sample_id: str
    selected_id: str
    acceptable_ids: tuple[str, ...]
    reviewed_ids: tuple[str, ...]
    confidence: float
    decision_kind: str


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise V8RoleFamilyDatasetError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise V8RoleFamilyDatasetError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise V8RoleFamilyDatasetError(f"{location}: expected text")
    return result


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode(
            "utf-8"
        )
    return (_canonical_json(value) + "\n").encode("utf-8")


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = _sha256_bytes(
        _canonical_json(result).encode("utf-8")
    )
    return result


def _validate_record_seal(row: Mapping[str, Any], location: str) -> None:
    expected = row.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise V8RoleFamilyDatasetError(f"{location}: invalid record seal")
    core = {key: value for key, value in row.items() if key != "record_sha256"}
    if _sha256_bytes(_canonical_json(core).encode("utf-8")) != expected:
        raise V8RoleFamilyDatasetError(f"{location}: record seal drifted")


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise V8RoleFamilyDatasetError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise V8RoleFamilyDatasetError(f"{location}: missing or linked file")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise V8RoleFamilyDatasetError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise V8RoleFamilyDatasetError(f"missing regular artifact: {path}")
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": _sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise V8RoleFamilyDatasetError(f"unsafe output directory: {result}")
    return result


def role_family(role: str) -> int:
    if role in BODY_ROLES:
        return BODY_FAMILY
    if role in VARIANT_ROLES:
        return VARIANT_FAMILY
    raise V8RoleFamilyDatasetError(f"unsupported role for family mapping: {role!r}")


def source_category_role(source_category: str) -> str:
    """Return a reporting role without treating R5 role predictions as authority."""

    try:
        return SOURCE_CATEGORY_ROLES[source_category]
    except KeyError as error:
        raise V8RoleFamilyDatasetError(
            f"unsupported source category for family mapping: {source_category!r}"
        ) from error


def validation_slice_counts(arrays: Mapping[str, np.ndarray]) -> Mapping[str, Any]:
    """Describe independent validation slices using the existing NPZ fields."""

    split = arrays["split"].astype(np.int64, copy=False)
    family = arrays["family_labels"].astype(np.int64, copy=False)
    authority = np.asarray([str(value) for value in arrays["font_authority"]])
    positive = arrays["positive_mask"].astype(bool, copy=False)
    val = split == 1
    names = {BODY_FAMILY: "body", VARIANT_FAMILY: "variant"}
    authority_counts = {
        value: int(np.sum(val & (authority == value)))
        for value in sorted(FONT_AUTHORITIES)
    }
    family_counts = {
        name: int(np.sum(val & (family == code))) for code, name in names.items()
    }
    authority_by_family = {
        value: {
            name: int(np.sum(val & (authority == value) & (family == code)))
            for code, name in names.items()
        }
        for value in sorted(FONT_AUTHORITIES)
    }
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    positive_candidate_counts = {
        value: {
            candidate_id: int(
                np.sum(positive[val & (authority == value), candidate_index])
            )
            for candidate_index, candidate_id in enumerate(candidate_ids)
        }
        for value in ("human", "visual")
    }
    return {
        "authority_by_family": authority_by_family,
        "authority_counts": authority_counts,
        "family_counts": family_counts,
        "font_positive_candidate_counts_by_authority": positive_candidate_counts,
        "font_supervised_rows": int(
            np.sum(val & np.isin(authority, ("human", "visual")))
        ),
        "row_count": int(np.sum(val)),
    }


def split_slice_counts(arrays: Mapping[str, np.ndarray]) -> Mapping[str, Any]:
    """Seal train/validation authority×family and Single Day inventories."""

    split = arrays["split"].astype(np.int64, copy=False)
    family = arrays["family_labels"].astype(np.int64, copy=False)
    authority = np.asarray([str(value) for value in arrays["font_authority"]])
    positive = arrays["positive_mask"].astype(bool, copy=False)
    negative = arrays["single_day_body_negative"].astype(bool, copy=False)
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    single_day_positive = positive[:, candidate_ids.index("single-day")]
    names = {BODY_FAMILY: "body", VARIANT_FAMILY: "variant"}
    result: dict[str, Any] = {}
    for split_code, split_name in ((0, "train"), (1, "val")):
        selected = split == split_code
        result[split_name] = {
            "authority_by_family": {
                value: {
                    name: int(
                        np.sum(
                            selected
                            & (authority == value)
                            & (family == family_code)
                        )
                    )
                    for family_code, name in names.items()
                }
                for value in sorted(FONT_AUTHORITIES)
            },
            "authority_counts": {
                value: int(np.sum(selected & (authority == value)))
                for value in sorted(FONT_AUTHORITIES)
            },
            "family_counts": {
                name: int(np.sum(selected & (family == family_code)))
                for family_code, name in names.items()
            },
            "font_supervised_rows": int(
                np.sum(selected & np.isin(authority, ("human", "visual")))
            ),
            "row_count": int(np.sum(selected)),
            "single_day_body_negative_rows": int(np.sum(selected & negative)),
            "single_day_positive_by_authority": {
                value: int(
                    np.sum(selected & (authority == value) & single_day_positive)
                )
                for value in sorted(FONT_AUTHORITIES)
            },
            "single_day_positive_rows": int(
                np.sum(selected & single_day_positive)
            ),
        }
    return result


def partition_master_rows(
    rows: Sequence[Any], adapter_validation_work_ids: Sequence[str]
) -> tuple[tuple[Any, ...], tuple[Any, ...], tuple[Any, ...]]:
    """Move complete supported master-train works into adapter-only val."""

    holdout = tuple(adapter_validation_work_ids)
    if len(holdout) != len(set(holdout)):
        raise V8RoleFamilyDatasetError("adapter validation work IDs are duplicated")
    if len(holdout) > 1:
        raise V8RoleFamilyDatasetError(
            "only one sealed adapter validation work is currently supported"
        )
    unsupported = set(holdout) - set(SUPPORTED_ADAPTER_VALIDATION_WORKS)
    if unsupported:
        raise V8RoleFamilyDatasetError(
            f"unsupported adapter validation work IDs: {sorted(unsupported)}"
        )
    holdout_set = frozenset(holdout)
    moved = tuple(
        row for row in rows if row.split == "train" and row.work_id in holdout_set
    )
    found = {row.work_id for row in moved}
    if found != holdout_set or any(
        row.work_id in holdout_set and row.split != "train" for row in rows
    ):
        raise V8RoleFamilyDatasetError(
            "adapter validation work is absent from or not exclusive to master train"
        )
    train = tuple(
        row
        for row in rows
        if row.split == "train" and row.work_id not in holdout_set
    )
    val = tuple(row for row in rows if row.split == "val") + moved
    return train, val, moved


def validate_dataset_arrays(
    arrays: Mapping[str, np.ndarray],
    *,
    expected_train_rows: int | None = None,
    expected_val_rows: int | None = None,
) -> Mapping[str, Any]:
    """Validate the exact NPZ contract without trusting the manifest."""

    if set(arrays) != NPZ_FIELDS:
        raise V8RoleFamilyDatasetError(
            f"NPZ inventory drifted: {sorted(set(arrays) ^ NPZ_FIELDS)}"
        )
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    candidate_count = len(candidate_ids)
    if (
        candidate_count != mass21.ACTIVE_CANDIDATE_COUNT
        or len(set(candidate_ids)) != candidate_count
        or mass21.RETIRED_FONT_ID in candidate_ids
    ):
        raise V8RoleFamilyDatasetError("candidate inventory is not active21")
    row_count = int(arrays["query_views"].shape[0])
    if arrays["query_views"].shape != (
        row_count,
        VIEW_COUNT,
        QUERY_COUNT,
        QUERY_DIM,
    ):
        raise V8RoleFamilyDatasetError("query_views shape drifted")
    if arrays["prototype_queries"].shape != (
        candidate_count,
        QUERY_COUNT,
        QUERY_DIM,
    ):
        raise V8RoleFamilyDatasetError("prototype_queries shape drifted")
    vector_fields = (
        "family_labels",
        "family_label_weights",
        "font_supervision_weights",
        "single_day_body_negative",
        "font_authority",
        "sample_ids",
        "work_ids",
        "split",
    )
    for name in vector_fields:
        if arrays[name].shape != (row_count,):
            raise V8RoleFamilyDatasetError(f"{name} shape drifted")
    matrix_fields = ("positive_mask", "preferred_mask", "candidate_eligible_mask")
    for name in matrix_fields:
        if arrays[name].shape != (row_count, candidate_count):
            raise V8RoleFamilyDatasetError(f"{name} shape drifted")
    if not np.isfinite(arrays["query_views"]).all() or not np.isfinite(
        arrays["prototype_queries"]
    ).all():
        raise V8RoleFamilyDatasetError("query/prototype arrays contain non-finite values")
    prototype_norms = np.linalg.norm(
        arrays["prototype_queries"].astype(np.float32), axis=-1
    )
    if np.max(np.abs(prototype_norms - 1.0)) > 1e-4:
        raise V8RoleFamilyDatasetError("prototype queries are not unit normalized")

    labels = arrays["family_labels"].astype(np.int64, copy=False)
    if not np.isin(labels, (BODY_FAMILY, VARIANT_FAMILY)).all():
        raise V8RoleFamilyDatasetError("family labels must be body=0 or variant=1")
    family_weights = arrays["family_label_weights"].astype(np.float32, copy=False)
    font_weights = arrays["font_supervision_weights"].astype(np.float32, copy=False)
    if (
        not np.isfinite(family_weights).all()
        or not np.isfinite(font_weights).all()
        or np.any((family_weights <= 0.0) | (family_weights > 1.0))
        or np.any((font_weights < 0.0) | (font_weights > 1.0))
    ):
        raise V8RoleFamilyDatasetError(
            "family weights must be finite in (0,1] and font weights in [0,1]"
        )

    positive = arrays["positive_mask"].astype(bool, copy=False)
    preferred = arrays["preferred_mask"].astype(bool, copy=False)
    eligible = arrays["candidate_eligible_mask"].astype(bool, copy=False)
    if np.any(preferred & ~positive) or np.any(positive & ~eligible):
        raise V8RoleFamilyDatasetError("font masks violate preferred/positive/eligible nesting")
    authorities = np.asarray([str(value) for value in arrays["font_authority"]])
    if not set(authorities.tolist()) <= FONT_AUTHORITIES:
        raise V8RoleFamilyDatasetError("font_authority contains an unsupported value")
    none_rows = authorities == "none"
    if (
        np.any(positive[none_rows])
        or np.any(preferred[none_rows])
        or np.any(eligible[none_rows])
        or np.any(font_weights[none_rows] != 0.0)
    ):
        raise V8RoleFamilyDatasetError("pseudo-only rows carry forbidden font supervision")
    weighted = font_weights > 0.0
    if np.any(weighted & ~positive.any(axis=1)) or np.any(weighted & none_rows):
        raise V8RoleFamilyDatasetError("weighted font row lacks an authorized positive")
    visual_rows = authorities == "visual"
    if np.any(visual_rows & (eligible.sum(axis=1) != 5)):
        raise V8RoleFamilyDatasetError("visual supervision must be masked to shown five")
    single_day_index = candidate_ids.index("single-day")
    negative = arrays["single_day_body_negative"].astype(bool, copy=False)
    if np.any(negative & (labels != BODY_FAMILY)) or np.any(
        negative & positive[:, single_day_index]
    ):
        raise V8RoleFamilyDatasetError("Single Day body-negative contract drifted")

    split = arrays["split"].astype(np.int64, copy=False)
    if not np.isin(split, (0, 1)).all():
        raise V8RoleFamilyDatasetError("split must be train=0 or val=1")
    train_rows = int((split == 0).sum())
    val_rows = int((split == 1).sum())
    if expected_train_rows is not None and train_rows != expected_train_rows:
        raise V8RoleFamilyDatasetError(
            f"train row count {train_rows} != expected {expected_train_rows}"
        )
    if expected_val_rows is not None and val_rows != expected_val_rows:
        raise V8RoleFamilyDatasetError(
            f"val row count {val_rows} != expected {expected_val_rows}"
        )
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    work_ids = np.asarray([str(value) for value in arrays["work_ids"]])
    if len(set(sample_ids)) != row_count:
        raise V8RoleFamilyDatasetError("sample IDs are duplicated")
    train_works = set(work_ids[split == 0].tolist())
    val_works = set(work_ids[split == 1].tolist())
    overlap = train_works & val_works
    if overlap:
        raise V8RoleFamilyDatasetError(
            f"train/val work leakage detected ({len(overlap)} works)"
        )
    return {
        "candidate_count": candidate_count,
        "font_authority_counts": dict(sorted(Counter(authorities.tolist()).items())),
        "row_count": row_count,
        "single_day_body_negative_rows": int(negative.sum()),
        "train_rows": train_rows,
        "train_work_count": len(train_works),
        "val_rows": val_rows,
        "val_work_count": len(val_works),
        "work_overlap_count": 0,
    }


def _human_label_from_example(
    example: Any, candidate_ids: tuple[str, ...]
) -> HumanFontLabel:
    row = _mapping(example.row, f"human {example.sample_id}")
    judgment = _mapping(row.get("font_judgment"), "human font_judgment")
    preferred = tuple(str(value) for value in judgment.get("preferred", ()))
    acceptable = tuple(str(value) for value in judgment.get("acceptable", ()))
    blocked = set(str(value) for value in judgment.get("unrenderable", ())) | set(
        str(value) for value in judgment.get("not_reviewed", ())
    )
    role = _mapping(row.get("role"), "human role")
    confidence = float(role.get("confidence", 1.0))
    if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
        raise V8RoleFamilyDatasetError("human role confidence is invalid")
    return HumanFontLabel(
        sample_id=example.sample_id,
        role=_text(role.get("primary"), "human role.primary"),
        role_confidence=confidence,
        positive_ids=tuple(
            value for value in (*preferred, *acceptable) if value in candidate_ids
        ),
        preferred_ids=tuple(value for value in preferred if value in candidate_ids),
        eligible_ids=tuple(value for value in candidate_ids if value not in blocked),
        work_id=example.work_id,
    )


def _load_human_labels(
    args: argparse.Namespace, candidate_ids: tuple[str, ...]
) -> tuple[dict[str, HumanFontLabel], Mapping[str, Any]]:
    cache_root = args.v6_cache_dir.expanduser().resolve()
    v6.validate_patch_cache(cache_root)
    contract = base.read_json(cache_root / v6.CACHE_CONTRACT, location="v6 cache")
    projection = mass21.candidate_projection(contract.get("candidate_ids", ()))
    if projection.active_ids != candidate_ids:
        raise V8RoleFamilyDatasetError("human cache active21 order drifted")
    human = mass21.load_human_supervision(
        cache_contract=contract,
        authority_dir=args.human_authority_dir,
        review_dir=args.human_review_dir,
        draft_dir=args.human_draft_dir,
        legacy_overlay_dir=args.human_legacy_overlay_dir,
        catalog_registry=args.human_catalog_registry,
        projection=projection,
    )
    labels: dict[str, HumanFontLabel] = {}
    original_rows = tuple(_sequence(contract.get("human_train"), "cache human_train"))
    with np.load(cache_root / v6.CACHE_ARRAYS, allow_pickle=False) as source:
        source_masks = np.asarray(source["human_train_masks"], dtype=np.bool_)
    active_masks = source_masks[:, np.asarray(projection.keep_indices, dtype=np.int64)]
    if len(original_rows) != mass21.ORIGINAL_FULL_ROWS or active_masks.shape != (
        mass21.ORIGINAL_FULL_ROWS,
        mass21.ACTIVE_CANDIDATE_COUNT,
    ):
        raise V8RoleFamilyDatasetError("original human cache inventory drifted")
    for index, raw in enumerate(original_rows):
        row = _mapping(raw, f"cached human {index}")
        sample_id = _text(row.get("sample_id"), "cached human.sample_id")
        preferred = tuple(
            value
            for value in row.get("preferred_candidate_ids", ())
            if value in candidate_ids
        )
        acceptable = tuple(
            value
            for value in row.get("acceptable_candidate_ids", ())
            if value in candidate_ids
        )
        labels[sample_id] = HumanFontLabel(
            sample_id=sample_id,
            role=_text(row.get("role"), "cached human.role"),
            role_confidence=1.0,
            positive_ids=(*preferred, *acceptable),
            preferred_ids=preferred,
            eligible_ids=tuple(
                candidate_ids[position]
                for position in np.flatnonzero(active_masks[index]).tolist()
            ),
            work_id=(str(row["work_id"]) if isinstance(row.get("work_id"), str) else None),
        )
    for example in (*human.addition_examples, *human.retired_only_examples):
        label = _human_label_from_example(example, candidate_ids)
        if label.sample_id in labels:
            raise V8RoleFamilyDatasetError("human label identity duplicated")
        labels[label.sample_id] = label
    if len(labels) != mass21.HUMAN_TRAIN_ROWS or set(labels) != set(human.all_sample_ids):
        raise V8RoleFamilyDatasetError("human authority identity coverage drifted")
    return labels, {
        "active21_font_supervised_rows": mass21.SUPERVISED_HUMAN_ROWS,
        "all_human_train_rows": len(labels),
        "authority_validation": dict(human.authority_validation),
        "source_cache_contract_sha256": _sha256_file(cache_root / v6.CACHE_CONTRACT),
        "source_cache_npz_sha256": _sha256_file(cache_root / v6.CACHE_ARRAYS),
    }


def _load_human_val_labels(
    args: argparse.Namespace, candidate_ids: tuple[str, ...]
) -> tuple[dict[str, HumanFontLabel], Mapping[str, Any]]:
    full22_ids = tuple(mass21.legacy15.FULL22_CANDIDATE_IDS)
    projection = mass21.candidate_projection(full22_ids)
    if projection.active_ids != candidate_ids:
        raise V8RoleFamilyDatasetError("human val active21 projection drifted")
    snapshot, validation = human_val_overlay.apply_overlay(
        overlay_dir=args.human_val_overlay_dir,
        base_export_dir=args.human_val_base_export_dir,
        finals_dir=args.human_val_finals_dir,
        catalog_registry=args.human_catalog_registry,
        candidate_ids=full22_ids,
    )
    labels: dict[str, HumanFontLabel] = {}
    for example in snapshot.val_examples:
        label = _human_label_from_example(example, candidate_ids)
        if label.sample_id in labels:
            raise V8RoleFamilyDatasetError("human val identity duplicated")
        if not label.positive_ids or not label.preferred_ids:
            raise V8RoleFamilyDatasetError(
                f"{label.sample_id}: human val lacks an active21 positive/preferred label"
            )
        labels[label.sample_id] = label
    if len(labels) != 33:
        raise V8RoleFamilyDatasetError("sealed human val33 count drifted")
    resolved = args.human_val_overlay_dir.expanduser().resolve()
    return labels, {
        "authority": "completed_human_final_label",
        "manifest_sha256": _sha256_file(resolved / human_val_overlay.MANIFEST_FILE),
        "report_sha256": _sha256_file(resolved / human_val_overlay.REPORT_FILE),
        "row_count": len(labels),
        "validation": dict(validation),
        "val_samples_sha256": _sha256_file(resolved / human_val_overlay.VAL_FILE),
    }


def _load_visual_decisions(
    root: Path,
) -> tuple[dict[str, Any], tuple[str, ...], Mapping[str, Any]]:
    resolved = root.expanduser().resolve()
    validation = visual_overlay.validate_output(resolved)
    manifest = _read_json(resolved / visual_overlay.MANIFEST_FILE, "visual manifest")
    candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
    paths = tuple(Path(str(row["file"])) for row in manifest.get("decision_sources", ()))
    decisions, sources = visual_overlay._load_decisions(paths)  # noqa: SLF001
    if len(decisions) != int(_mapping(manifest.get("counts"), "visual counts").get(
        "input_visual_rows", -1
    )):
        raise V8RoleFamilyDatasetError("visual decision unique coverage drifted")
    return decisions, candidate_ids, {
        "decision_sources": sources,
        "manifest_sha256": _sha256_file(resolved / visual_overlay.MANIFEST_FILE),
        "report_sha256": _sha256_file(resolved / visual_overlay.REPORT_FILE),
        "validation": dict(validation),
    }


def _visual_font_label(decision: Any) -> VisualFontLabel | None:
    if decision.kind == "review_needed":
        return None
    selected = _text(decision.selected_font_id, "visual selected font")
    confidence = float(decision.confidence)
    if not math.isfinite(confidence) or not 0.0 < confidence <= 1.0:
        raise V8RoleFamilyDatasetError("visual confidence is invalid")
    return VisualFontLabel(
        sample_id=decision.sample_id,
        selected_id=selected,
        acceptable_ids=tuple(decision.acceptable_font_ids),
        reviewed_ids=tuple(decision.reviewed_font_ids),
        confidence=confidence,
        decision_kind=decision.kind,
    )


def _load_refined_pseudo(
    root: Path,
    *,
    candidate_ids: tuple[str, ...],
    decisions: Mapping[str, Any],
) -> tuple[set[str], dict[str, VisualFontLabel], Mapping[str, Any]]:
    resolved = root.expanduser().resolve()
    validation = refinement.validate_output(resolved)
    pseudo_ids: set[str] = set()
    visual_labels: dict[str, VisualFontLabel] = {}
    for row in _iter_jsonl(resolved / refinement.PSEUDO_FILE, "refined pseudo"):
        sample_id = _text(row.get("sample_id"), "refined pseudo.sample_id")
        if sample_id in pseudo_ids:
            raise V8RoleFamilyDatasetError("refined pseudo identity duplicated")
        pseudo_ids.add(sample_id)
        if tuple(str(value) for value in row.get("candidate_ids", ())) != candidate_ids:
            raise V8RoleFamilyDatasetError("refined pseudo candidate order drifted")
        visual = row.get("pseudo_visual_review")
        if visual is None:
            continue
        metadata = _mapping(visual, "pseudo_visual_review")
        decision = decisions.get(sample_id)
        label = _visual_font_label(decision) if decision is not None else None
        if (
            label is None
            or metadata.get("authority") != visual_overlay.AUTHORITY
            or tuple(metadata.get("reviewed_font_ids", ())) != label.reviewed_ids
            or metadata.get("selected_font_id") != label.selected_id
            or tuple(metadata.get("acceptable_font_ids", ())) != label.acceptable_ids
            or metadata.get("decision_kind") != label.decision_kind
        ):
            raise V8RoleFamilyDatasetError(
                f"{sample_id}: refined pseudo/visual decision binding drifted"
            )
        visual_labels[sample_id] = label
    if len(pseudo_ids) != refinement.EXPECTED_PSEUDO_ROWS:
        raise V8RoleFamilyDatasetError("refined pseudo count drifted")
    return pseudo_ids, visual_labels, {
        "manifest_sha256": _sha256_file(resolved / refinement.MANIFEST_FILE),
        "pseudo_sha256": _sha256_file(resolved / refinement.PSEUDO_FILE),
        "report_sha256": _sha256_file(resolved / refinement.REPORT_FILE),
        "train_visual_font_rows": len(visual_labels),
        "validation": dict(validation),
    }


def _load_val_visual_ids(
    root: Path, decisions: Mapping[str, Any]
) -> tuple[tuple[str, ...], dict[str, VisualFontLabel], Mapping[str, int]]:
    ids: list[str] = []
    labels: dict[str, VisualFontLabel] = {}
    counts: Counter[str] = Counter()
    for row in _iter_jsonl(
        root.expanduser().resolve() / visual_overlay.HELDOUT_FILE,
        "heldout visual decisions",
    ):
        if row.get("split") != "val":
            continue
        sample_id = _text(row.get("sample_id"), "heldout visual.sample_id")
        decision = decisions.get(sample_id)
        if decision is None or decision.review_item_sha256 != row.get("review_item_sha256"):
            raise V8RoleFamilyDatasetError("heldout visual/source decision binding drifted")
        ids.append(sample_id)
        counts[f"decision_{decision.kind}"] += 1
        label = _visual_font_label(decision)
        if label is not None:
            labels[sample_id] = label
    if len(ids) != 546 or len(set(ids)) != len(ids):
        raise V8RoleFamilyDatasetError("visual validation identity count drifted")
    return tuple(ids), labels, dict(counts)


def _load_pass_rows(
    root: Path, required_ids: frozenset[str]
) -> tuple[dict[str, PassRow], Mapping[str, Any]]:
    resolved = root.expanduser().resolve()
    validation = labeler.validate_output(resolved)
    result: dict[str, PassRow] = {}
    for row in _iter_jsonl(resolved / labeler.REVIEW_OUTPUT, "R5 pass review"):
        sample_id = str(row.get("sample_id", ""))
        if sample_id not in required_ids:
            continue
        labeler.validate_record_seal(row, location=f"R5 pass review:{sample_id}")
        source_category = _text(row.get("source_category"), "pass source_category")
        result[sample_id] = PassRow(
            sample_id=sample_id,
            work_id=_text(row.get("work_id"), "pass work_id"),
            split=_text(row.get("split"), "pass split"),
            # R5 ``role`` is a prediction object, not label authority.  The
            # category representative is reporting-only; human rows replace it.
            role=source_category_role(source_category),
            source_category=source_category,
            master_row_sha256=_text(
                row.get("master_row_sha256"), "pass master_row_sha256"
            ),
        )
    missing = required_ids - result.keys()
    if missing:
        raise V8RoleFamilyDatasetError(f"R5 pass lacks {len(missing)} target rows")
    return result, {
        "report_sha256": _sha256_file(resolved / labeler.REPORT),
        "review_sha256": _sha256_file(resolved / labeler.REVIEW_OUTPUT),
        "validation": dict(validation),
    }


def _validate_target_master_bindings(
    bindings: Sequence[Any],
    *,
    pass_rows: Mapping[str, PassRow],
    master_manifest: Path,
) -> None:
    with master_manifest.open("rb") as handle:
        for binding in bindings:
            evidence = pass_rows[binding.sample_id]
            handle.seek(binding.byte_offset)
            raw = handle.read(binding.byte_length)
            if (
                _sha256_bytes(raw) != binding.master_line_sha256
                or _sha256_bytes(raw.rstrip(b"\r\n")) != evidence.master_row_sha256
                or evidence.work_id != binding.work_id
                or evidence.split != binding.split
            ):
                raise V8RoleFamilyDatasetError(
                    f"{binding.sample_id}: cache/pass/master binding drifted"
                )


def _load_r5_head_and_prototypes(
    root: Path, *, device_name: str
) -> tuple[Any, Any, np.ndarray, Mapping[str, Any]]:
    source = v7_export._load_fontquery_source(  # noqa: SLF001
        root, allow_r3_fixture_source=False
    )
    if source.fixture_only or source.kind != "v7_mass21_r3_teacher_stable":
        raise V8RoleFamilyDatasetError("query source is not a sealed completed R5/R3 head")
    try:
        import torch
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise V8RoleFamilyDatasetError("torch and safetensors are required") from error
    if device_name == "cuda" and not torch.cuda.is_available():
        raise V8RoleFamilyDatasetError("CUDA was requested but is unavailable")
    device = torch.device(device_name)
    head = v6.build_font_query_head(
        torch, query_count=QUERY_COUNT, query_dim=QUERY_DIM, hidden_size=hidden_cache.HIDDEN_SIZE
    )
    state = dict(load_file(str(source.checkpoint_path), device="cpu"))
    head.load_state_dict(state, strict=True)
    head.requires_grad_(False).eval().to(device=device, dtype=torch.float32)
    prototypes = np.ascontiguousarray(source.prototypes, dtype="<f4")
    return torch, head, prototypes, {
        "candidate_ids": list(source.candidate_ids),
        "checkpoint_sha256": _sha256_file(source.checkpoint_path),
        "kind": source.kind,
        "manifest_sha256": _sha256_file(source.root / source.manifest_name),
        "prototype_sha256": _sha256_file(source.prototype_path),
        "quality_gate_passed": source.quality_gate_passed,
    }


def _extract_query_views(
    *,
    cache_root: Path,
    cache_manifest: Mapping[str, Any],
    bindings: Sequence[Any],
    torch: Any,
    head: Any,
    device_name: str,
    batch_size: int,
) -> np.ndarray:
    if batch_size < 1 or batch_size > 512:
        raise V8RoleFamilyDatasetError("query batch size must be 1..512")
    output = np.empty(
        (len(bindings), VIEW_COUNT, QUERY_COUNT, QUERY_DIM), dtype="<f2"
    )
    ordered = sorted(
        ((int(binding.cache_index), output_index) for output_index, binding in enumerate(bindings)),
        key=lambda value: value[0],
    )
    pointer = 0
    descriptors = tuple(
        _mapping(value, "hidden cache shard") for value in cache_manifest.get("shards", ())
    )
    device = torch.device(device_name)
    if device.type == "cuda":
        torch.set_float32_matmul_precision("high")
    with torch.inference_mode():
        for descriptor in descriptors:
            start = int(descriptor["start_cache_index"])
            stop = int(descriptor["end_cache_index_exclusive"])
            selected: list[tuple[int, int]] = []
            while pointer < len(ordered) and ordered[pointer][0] < stop:
                cache_index, output_index = ordered[pointer]
                if cache_index < start:
                    raise V8RoleFamilyDatasetError("target cache indices are not covered")
                selected.append((cache_index - start, output_index))
                pointer += 1
            if not selected:
                continue
            array_path = (
                cache_root
                / hidden_cache.SHARDS_DIR
                / str(descriptor["directory"])
                / hidden_cache.SHARD_ARRAY
            )
            values = np.load(array_path, mmap_mode="r", allow_pickle=False)
            try:
                local = [value[0] for value in selected]
                positions = [value[1] for value in selected]
                for offset in range(0, len(local), batch_size):
                    local_batch = local[offset : offset + batch_size]
                    position_batch = positions[offset : offset + batch_size]
                    tokens = np.array(values[local_batch], dtype="<f2", copy=True)
                    tensor = torch.from_numpy(tokens).to(device=device, non_blocking=False)
                    embedded, _attention = head.encode(
                        tensor.reshape(-1, hidden_cache.PATCH_COUNT, hidden_cache.HIDDEN_SIZE)
                    )
                    shaped = embedded.reshape(
                        len(local_batch), VIEW_COUNT, QUERY_COUNT, QUERY_DIM
                    )
                    output[position_batch] = shaped.float().cpu().numpy().astype("<f2")
            finally:
                mapped = getattr(values, "_mmap", None)
                if mapped is not None:
                    mapped.close()
    if pointer != len(ordered) or not np.isfinite(output).all():
        raise V8RoleFamilyDatasetError("query extraction coverage/finite check failed")
    return output


def _make_dataset_arrays(args: argparse.Namespace) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    started = time.perf_counter()
    plan = hidden_cache.load_master_plan(
        args.master_dir, catalog_registry=args.master_catalog_registry, max_samples=None
    )
    cache_root = args.hidden_cache_dir.expanduser().resolve()
    cache_validation = hidden_cache.validate_cache_against_plan(cache_root, plan=plan)
    cache_manifest = _read_json(cache_root / hidden_cache.MANIFEST, "hidden manifest")

    decisions, visual_candidate_ids, visual_binding = _load_visual_decisions(
        args.visual_overlay_dir
    )
    val_ids, val_visual, val_visual_counts = _load_val_visual_ids(
        args.visual_overlay_dir, decisions
    )
    val_id_set = frozenset(val_ids)
    adapter_validation_work_ids = tuple(args.adapter_validation_work_id)
    train_bindings, val_bindings, moved_bindings = partition_master_rows(
        plan.rows, adapter_validation_work_ids
    )
    # All master-v3 val rows remain family evaluation rows.  An explicitly
    # supported complete master-train work may additionally move to split=1
    # for adapter-only checkpoint selection; master test is never selected.
    if len(train_bindings) != args.expected_train_rows or len(val_bindings) != args.expected_val_rows:
        raise V8RoleFamilyDatasetError("target train/all-master-val row count drifted")
    val_binding_ids = frozenset(row.sample_id for row in val_bindings)
    if not val_id_set <= val_binding_ids:
        raise V8RoleFamilyDatasetError("visual validation rows escaped master val")
    bindings = (*train_bindings, *val_bindings)
    required_ids = frozenset(row.sample_id for row in bindings)
    pass_rows, pass_binding = _load_pass_rows(args.pass_dir, required_ids)
    _validate_target_master_bindings(
        bindings, pass_rows=pass_rows, master_manifest=plan.manifest_path
    )

    torch, head, prototypes, model_binding = _load_r5_head_and_prototypes(
        args.r5_output_dir, device_name=args.device
    )
    candidate_ids = tuple(str(value) for value in model_binding["candidate_ids"])
    if candidate_ids != visual_candidate_ids:
        raise V8RoleFamilyDatasetError("R5/visual active21 candidate order drifted")
    human_labels, human_binding = _load_human_labels(args, candidate_ids)
    human_val_labels, human_val_binding = _load_human_val_labels(args, candidate_ids)
    pseudo_ids, train_visual, pseudo_binding = _load_refined_pseudo(
        args.refined_pseudo_dir,
        candidate_ids=candidate_ids,
        decisions=decisions,
    )
    master_train_ids = frozenset(
        row.sample_id for row in plan.rows if row.split == "train"
    )
    master_train_human_ids = master_train_ids & human_labels.keys()
    train_ids = frozenset(row.sample_id for row in train_bindings)
    optimizer_train_human_ids = train_ids & human_labels.keys()
    if (
        len(master_train_human_ids) != mass21.HUMAN_MASTER_OVERLAP_ROWS
        or pseudo_ids != master_train_ids - master_train_human_ids
        or set(train_visual) - pseudo_ids
    ):
        raise V8RoleFamilyDatasetError("human/pseudo/master train partition drifted")
    if (
        set(human_val_labels) - val_binding_ids
        or set(human_val_labels) & train_ids
        or set(human_val_labels) & set(human_labels)
    ):
        raise V8RoleFamilyDatasetError("human val33 split/identity boundary drifted")
    binding_by_id = {row.sample_id: row for row in val_bindings}
    if any(
        label.work_id != binding_by_id[sample_id].work_id
        for sample_id, label in human_val_labels.items()
    ):
        raise V8RoleFamilyDatasetError("human val33/master work binding drifted")

    count = len(bindings)
    candidate_index = {value: index for index, value in enumerate(candidate_ids)}
    family_labels = np.empty(count, dtype=np.int8)
    family_weights = np.empty(count, dtype="<f4")
    positive = np.zeros((count, len(candidate_ids)), dtype=np.bool_)
    preferred = np.zeros_like(positive)
    eligible = np.zeros_like(positive)
    font_weights = np.zeros(count, dtype="<f4")
    authority = np.full(count, "none", dtype="<U6")
    single_day_negative = np.zeros(count, dtype=np.bool_)
    source_categories: list[str] = []
    role_counts: Counter[str] = Counter()
    visual_kind_counts: Counter[str] = Counter()

    for index, binding in enumerate(bindings):
        evidence = pass_rows[binding.sample_id]
        human = (
            human_labels.get(binding.sample_id)
            if binding.split == "train"
            else human_val_labels.get(binding.sample_id)
        )
        role = human.role if human is not None else evidence.role
        family_labels[index] = role_family(role)
        family_weights[index] = (
            human.role_confidence
            if human is not None
            else SOURCE_FAMILY_WEIGHTS.get(evidence.source_category, 0.25)
        )
        role_counts[role] += 1
        source_categories.append(evidence.source_category)

        visual = (
            train_visual.get(binding.sample_id)
            if binding.split == "train"
            else val_visual.get(binding.sample_id)
        )
        if human is not None and human.positive_ids:
            label_positive = human.positive_ids
            label_preferred = human.preferred_ids
            label_eligible = human.eligible_ids
            authority[index] = "human"
            font_weights[index] = 1.0
        elif human is not None:
            # Retired-only human rows still authoritatively supply the role
            # family, but have no active21 font target and must not be promoted
            # to visual or pseudo font supervision.
            label_positive = ()
            label_preferred = ()
            label_eligible = ()
        elif visual is not None:
            label_positive = (visual.selected_id, *visual.acceptable_ids)
            label_preferred = (visual.selected_id,)
            label_eligible = visual.reviewed_ids
            authority[index] = "visual"
            font_weights[index] = visual.confidence
            visual_kind_counts[visual.decision_kind] += 1
        else:
            label_positive = ()
            label_preferred = ()
            label_eligible = ()
        for candidate_id in label_positive:
            positive[index, candidate_index[candidate_id]] = True
        for candidate_id in label_preferred:
            preferred[index, candidate_index[candidate_id]] = True
        for candidate_id in label_eligible:
            eligible[index, candidate_index[candidate_id]] = True
        single_day_negative[index] = (
            family_labels[index] == BODY_FAMILY
            and evidence.source_category in BODY_ORDINARY_CATEGORIES
            and not positive[index, candidate_index["single-day"]]
        )

    query_views = _extract_query_views(
        cache_root=cache_root,
        cache_manifest=cache_manifest,
        bindings=bindings,
        torch=torch,
        head=head,
        device_name=args.device,
        batch_size=args.batch_size,
    )
    dataset_split = np.asarray(
        [0] * len(train_bindings) + [1] * len(val_bindings), dtype=np.int8
    )
    arrays = {
        "candidate_ids": np.asarray(candidate_ids, dtype="<U32"),
        "query_views": query_views,
        "prototype_queries": prototypes,
        "family_labels": family_labels,
        "family_label_weights": family_weights,
        "positive_mask": positive,
        "preferred_mask": preferred,
        "candidate_eligible_mask": eligible,
        "font_supervision_weights": font_weights,
        "single_day_body_negative": single_day_negative,
        "font_authority": authority,
        "sample_ids": np.asarray([row.sample_id for row in bindings], dtype="<U40"),
        "work_ids": np.asarray([row.work_id for row in bindings], dtype="<U40"),
        "split": dataset_split,
    }
    validation = validate_dataset_arrays(
        arrays,
        expected_train_rows=args.expected_train_rows,
        expected_val_rows=args.expected_val_rows,
    )
    validation_slices = validation_slice_counts(arrays)
    split_slices = split_slice_counts(arrays)
    moved_ids = frozenset(row.sample_id for row in moved_bindings)
    moved_mask = np.asarray(
        [row.sample_id in moved_ids for row in bindings], dtype=np.bool_
    )
    moved_summary = {
        "authority_counts": dict(
            sorted(Counter(authority[moved_mask].tolist()).items())
        ),
        "body_rows": int(np.sum(moved_mask & (family_labels == BODY_FAMILY))),
        "master_source_split": "train",
        "optimizer_split": "val",
        "row_count": int(np.sum(moved_mask)),
        "variant_rows": int(np.sum(moved_mask & (family_labels == VARIANT_FAMILY))),
        "work_ids": list(adapter_validation_work_ids),
    }
    for work_id in adapter_validation_work_ids:
        expected = SUPPORTED_ADAPTER_VALIDATION_WORKS[work_id]
        if (
            moved_summary["row_count"] != expected["row_count"]
            or moved_summary["body_rows"] != expected["body_rows"]
            or moved_summary["variant_rows"] != expected["variant_rows"]
            or moved_summary["authority_counts"].get("human", 0)
            != expected["human_rows"]
            or moved_summary["authority_counts"].get("visual", 0)
            != expected["visual_rows"]
        ):
            raise V8RoleFamilyDatasetError(
                f"{work_id}: adapter validation fold inventory drifted"
            )
    return arrays, {
        "cache": {
            **dict(cache_validation),
            "build_contract_sha256": _sha256_file(cache_root / hidden_cache.BUILD_CONTRACT),
            "manifest_sha256": _sha256_file(cache_root / hidden_cache.MANIFEST),
            "sample_index_sha256": _sha256_file(cache_root / hidden_cache.SAMPLE_INDEX),
        },
        "counts": {
            **dict(validation),
            "family_body_rows": int((family_labels == BODY_FAMILY).sum()),
            "family_variant_rows": int((family_labels == VARIANT_FAMILY).sum()),
            "human_master_rows": len(master_train_human_ids),
            "optimizer_train_human_rows": len(optimizer_train_human_ids),
            "human_val_rows": len(human_val_labels),
            "pseudo_only_font_rows": int((authority == "none").sum()),
            "master_train_visual_source_rows": len(train_visual),
            "train_visual_font_rows": int(
                np.sum((dataset_split == 0) & (authority == "visual"))
            ),
            "val_visual_completed_source_rows": len(val_visual),
            "val_visual_font_rows": int(
                np.sum((arrays["split"] == 1) & (authority == "visual"))
            ),
            "val_visual_decisions": len(val_ids),
            "visual_decision_kinds": dict(sorted(visual_kind_counts.items())),
            "visual_val_decision_kinds": dict(sorted(val_visual_counts.items())),
        },
        "elapsed_seconds_before_publish": time.perf_counter() - started,
        "adapter_validation_fold": moved_summary,
        "human": human_binding,
        "human_val": human_val_binding,
        "model": model_binding,
        "pass": pass_binding,
        "pseudo": pseudo_binding,
        "role_counts": dict(sorted(role_counts.items())),
        "source_category_counts": dict(sorted(Counter(source_categories).items())),
        "split_slices": split_slices,
        "validation_slices": validation_slices,
        "visual": visual_binding,
    }


def build_dataset(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise V8RoleFamilyDatasetError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        arrays, provenance = _make_dataset_arrays(args)
        np.savez(staging / DATASET_FILE, **arrays)
        array_contract = {
            name: {"dtype": str(value.dtype), "shape": list(value.shape)}
            for name, value in sorted(arrays.items())
        }
        counts = _mapping(provenance.get("counts"), "dataset counts")
        manifest = _seal_record(
            {
                "array_contract": array_contract,
                "authority": {
                    "human": "completed_human_final_label",
                    "none": "pixels_or_pseudo_only_no_font_supervision",
                    "visual": visual_overlay.AUTHORITY,
                    "visual_promoted_to_human_gold": False,
                },
                "candidate_ids": arrays["candidate_ids"].tolist(),
                "counts": dict(counts),
                "dataset": _descriptor(staging / DATASET_FILE, row_count=int(counts["row_count"])),
                "adapter_validation_fold": provenance["adapter_validation_fold"],
                "family_policy": {
                    "body_roles": sorted(BODY_ROLES),
                    "human_family_label_source": "sealed_human_role",
                    "non_human_family_label_source": "sealed_pass_source_category_mapping",
                    "source_category_role_mapping": dict(SOURCE_CATEGORY_ROLES),
                    "source_family_weights": dict(SOURCE_FAMILY_WEIGHTS),
                    "variant_roles": sorted(VARIANT_ROLES),
                },
                "validation_policy": {
                    "adapter_model_selection_uses_validation": bool(
                        provenance["adapter_validation_fold"]["work_ids"]
                    ),
                    "adapter_validation_is_base_encoder_independent": False,
                    "adapter_validation_purpose": "frozen_r5_adapter_model_selection",
                    "family_evaluation_rows": (
                        "all_master_v3_val_rows_plus_explicit_complete_master_train_work"
                    ),
                    "font_evaluation_authorities": ["human", "visual"],
                    "human_overrides_visual_on_same_sample": True,
                    "none_authority_is_family_only": True,
                    "optimizer_uses_validation": False,
                    "test_rows_exported": 0,
                },
                "split_slices": provenance["split_slices"],
                "validation_slices": provenance["validation_slices"],
                "record_type": "manga_font_student_v8_role_family_dataset_manifest",
                "schema_version": SCHEMA,
                "single_day_policy": {
                    "body_ordinary_categories": sorted(BODY_ORDINARY_CATEGORIES),
                    "explicit_human_or_visual_positive_cancels_negative": True,
                },
                "source_code_sha256": _sha256_file(Path(__file__).resolve()),
                "sources": {
                    key: copy.deepcopy(value)
                    for key, value in provenance.items()
                    if key not in {
                        "counts",
                        "elapsed_seconds_before_publish",
                        "adapter_validation_fold",
                        "role_counts",
                        "source_category_counts",
                        "split_slices",
                        "validation_slices",
                    }
                },
            }
        )
        (staging / MANIFEST_FILE).write_bytes(_json_bytes(manifest, pretty=True))
        report = _seal_record(
            {
                "artifacts": {
                    DATASET_FILE: _descriptor(
                        staging / DATASET_FILE, row_count=int(counts["row_count"])
                    ),
                    MANIFEST_FILE: _descriptor(staging / MANIFEST_FILE),
                },
                "adapter_validation_fold": provenance["adapter_validation_fold"],
                "counts": dict(counts),
                "elapsed_seconds": float(provenance["elapsed_seconds_before_publish"]),
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_student_v8_role_family_dataset_report",
                "role_counts": provenance["role_counts"],
                "schema_version": SCHEMA,
                "source_category_counts": provenance["source_category_counts"],
                "split_slices": provenance["split_slices"],
                "validation_slices": provenance["validation_slices"],
            }
        )
        (staging / REPORT_FILE).write_bytes(_json_bytes(report, pretty=True))
        marker = _seal_record(
            {
                "artifacts": {
                    DATASET_FILE: _sha256_file(staging / DATASET_FILE),
                    MANIFEST_FILE: _sha256_file(staging / MANIFEST_FILE),
                    REPORT_FILE: _sha256_file(staging / REPORT_FILE),
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(_json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or {p.name for p in root.iterdir()} != OUTPUT_FILES:
        raise V8RoleFamilyDatasetError("dataset output exact inventory drifted")
    marker = _read_json(root / MARKER_FILE, "dataset marker")
    manifest = _read_json(root / MANIFEST_FILE, "dataset manifest")
    report = _read_json(root / REPORT_FILE, "dataset report")
    for location, row in (("marker", marker), ("manifest", manifest), ("report", report)):
        _validate_record_seal(row, location)
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or manifest.get("source_code_sha256") != _sha256_file(Path(__file__).resolve())
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
    ):
        raise V8RoleFamilyDatasetError("dataset metadata/schema drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    report_artifacts = _mapping(report.get("artifacts"), "report artifacts")
    for name in (DATASET_FILE, MANIFEST_FILE, REPORT_FILE):
        if marker_artifacts.get(name) != _sha256_file(root / name):
            raise V8RoleFamilyDatasetError(f"dataset marker hash drifted: {name}")
    for name in (DATASET_FILE, MANIFEST_FILE):
        descriptor = _mapping(report_artifacts.get(name), f"report artifact {name}")
        if (
            descriptor.get("file") != name
            or descriptor.get("byte_size") != (root / name).stat().st_size
            or descriptor.get("sha256") != _sha256_file(root / name)
        ):
            raise V8RoleFamilyDatasetError(f"dataset descriptor drifted: {name}")
    with np.load(root / DATASET_FILE, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=False) for name in source.files}
        counts = _mapping(manifest.get("counts"), "manifest counts")
        validation = validate_dataset_arrays(
            arrays,
            expected_train_rows=int(counts.get("train_rows", -1)),
            expected_val_rows=int(counts.get("val_rows", -1)),
        )
        contract = {
            name: {"dtype": str(value.dtype), "shape": list(value.shape)}
            for name, value in sorted(arrays.items())
        }
    if contract != manifest.get("array_contract"):
        raise V8RoleFamilyDatasetError("dataset array contract drifted")
    descriptor = _mapping(report_artifacts.get(DATASET_FILE), "dataset descriptor")
    if descriptor.get("row_count") != validation["row_count"]:
        raise V8RoleFamilyDatasetError("dataset descriptor row count drifted")
    return {
        **dict(validation),
        "dataset_file": str(root / DATASET_FILE),
        "output_dir": str(root),
        "status": "validated_manga_font_student_v8_role_family_dataset",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument(
        "--hidden-cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-master-v3-siglip2-hidden-cache-v1"),
    )
    build.add_argument(
        "--master-dir", type=Path, default=Path("datasets/font-matching-master-v3")
    )
    build.add_argument(
        "--master-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    build.add_argument(
        "--r5-output-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-r5-epoch1-qa-v1"),
    )
    build.add_argument(
        "--pass-dir",
        type=Path,
        default=Path("artifacts/manga-font-master-v3-label-pass-r5-epoch1-v1"),
    )
    build.add_argument(
        "--refined-pseudo-dir",
        type=Path,
        default=Path("artifacts/manga-font-v2-pseudo-refinement-r1"),
    )
    build.add_argument(
        "--visual-overlay-dir",
        type=Path,
        default=Path("artifacts/manga-font-v7-mass21-visual-pseudo-overlay-abcdefgh-v1"),
    )
    build.add_argument(
        "--v6-cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-patch-cache-v1"),
    )
    build.add_argument(
        "--human-authority-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1"),
    )
    build.add_argument(
        "--human-review-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"),
    )
    build.add_argument(
        "--human-draft-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1"),
    )
    build.add_argument(
        "--human-legacy-overlay-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy15-train-overlay-v1"),
    )
    build.add_argument(
        "--human-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v2.json"),
    )
    build.add_argument(
        "--human-val-overlay-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-human-overlay-adjudicated-val33-v1"
        ),
    )
    build.add_argument(
        "--human-val-base-export-dir",
        type=Path,
        default=Path("artifacts/font-matching-training-export-full22-strict-v1"),
    )
    build.add_argument(
        "--human-val-finals-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-calibration-gold-val33-v1"),
    )
    build.add_argument(
        "--adapter-validation-work-id",
        action="append",
        default=[],
        help=(
            "move one supported complete master-train work to split=1 for "
            "frozen-R5 adapter model selection; repeat is rejected"
        ),
    )
    build.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    build.add_argument("--batch-size", type=int, default=128)
    build.add_argument("--expected-train-rows", type=int, default=19_664)
    build.add_argument("--expected-val-rows", type=int, default=4_218)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        result = build_dataset(args) if args.command == "build" else validate_output(args.output_dir)
    except (
        V8RoleFamilyDatasetError,
        OSError,
        KeyError,
        ValueError,
        hidden_cache.HiddenStateCacheError,
        visual_overlay.VisualPseudoOverlayError,
        refinement.PseudoRefinementError,
        mass21.MangaFontMass21DataError,
    ) as error:
        raise SystemExit(f"v8 role-family dataset error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
