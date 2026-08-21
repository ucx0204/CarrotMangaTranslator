#!/usr/bin/env python3
"""Train the isolated R2.3 candidate tri-state work-LOGO diagnostic.

This experiment reopens the exact blind A--G decisions bound by the sealed
1,347 training-only labels.  It changes only how *reviewed marginal* candidate
scores enter the existing multi-positive set-NLL denominator.  Preferred and
acceptable candidates remain positive, explicit unacceptable candidates keep
unit negative strength, and ordinary unreviewed candidates remain masked.
Single Day is the sole safety exception: the production body policy and the
existing supervised Single Day hard-negative remain fixed in every cell.

Only ``sample_candidate_residual.2.{weight,bias}`` of the exact production r3h
15-tensor adapter are trainable.  The family route is byte-exact and runtime
parameter/MAC counts are unchanged.  This is a training-only, nonpromotable
diagnostic; it performs no page rendering or production integration.
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
from collections import defaultdict
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_v3_family_residual_r21_logo as r21
except ImportError:  # pragma: no cover - direct script execution
    import train_manga_font_v3_family_residual_r21_logo as r21


r2 = r21.r2
r1 = r21.r1
r0 = r21.r0
v8 = r0.v8
overlay_v3 = r0.overlay_v3

SCHEMA_VERSION = "manga-font-v3-candidate-tristate-r23-logo-v1"
OWNER = "carrot-manga-translator/manga-font-v3-candidate-tristate-r23-logo-v1"
RECORD_TYPE = "manga_font_v3_candidate_tristate_r23_logo_manifest"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-candidate-tristate-r23-logo-v1-owned.json"
PRODUCER_FILE_NAME = "train_manga_font_v3_candidate_tristate_r23_logo.py"
SIDECAR_TEMPLATE = "fold-{fold_index:02d}-candidate-final-r23.safetensors"

DEFAULT_LABEL_DIR = Path(
    "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-1600-training-only-r1"
)
DEFAULT_PAGE_OVERLAY_DIR = r0.DEFAULT_OVERLAY_DIR
DECISION_DIRECTORIES = (
    "manga-font-v2-high-value-blind-review-agent-001-200-r1",
    "manga-font-v2-high-value-blind-review-agent-201-400-r1",
    "manga-font-v2-high-value-blind-review-agent-401-600-r1",
    "manga-font-v2-high-value-blind-review-agent-601-800-r1",
    "manga-font-v2-high-value-blind-review-agent-801-1000-public-only-r1",
    "manga-font-v2-high-value-blind-review-agent-1001-1200-public-only-r1",
    "manga-font-v2-high-value-blind-review-agent-1201-1400-public-only-r1",
    "manga-font-v2-high-value-blind-review-agent-1401-1600-public-only-r1",
)
PRIVATE_BINDING_DIRECTORIES = (
    "manga-font-v2-high-value-supervised-queue-r1-800",
    "manga-font-v2-high-value-supervised-queue-r2-801-1600-training-only-r1",
)
EXPECTED_DECISION_FILES = {
    "manga-font-v2-high-value-blind-review-agent-001-200-r1": (
        288_915,
        "fe3f359ef89a711c0bd311465f6af3890cefd33fe8b54fb9fed4328c942dac7d",
    ),
    "manga-font-v2-high-value-blind-review-agent-201-400-r1": (
        288_682,
        "833ad34536ffb5eaedda49f21c7dc065d292461723de6fcc5a26ea969eed3bba",
    ),
    "manga-font-v2-high-value-blind-review-agent-401-600-r1": (
        284_270,
        "5039af8b7e94c7b58d1cd53c3df5ebf92f26d01e88ad115e604a201d67805ae2",
    ),
    "manga-font-v2-high-value-blind-review-agent-601-800-r1": (
        282_222,
        "e890edbe521f960f22686d86bf4f18fcd23a2a294d3862ec1828f6134e2fc747",
    ),
    "manga-font-v2-high-value-blind-review-agent-801-1000-public-only-r1": (
        291_937,
        "654396b834b3202cf7118ef9ddc9d285bc76ec0536ef2e7f9d54e53641c37782",
    ),
    "manga-font-v2-high-value-blind-review-agent-1001-1200-public-only-r1": (
        296_274,
        "9e35bb13e31668ed1cfc57b1f814076e3f4110829a73c416d5e4b2770e61fef9",
    ),
    "manga-font-v2-high-value-blind-review-agent-1201-1400-public-only-r1": (
        296_031,
        "e4e77406f89664d7975d7070d6f428f5d0eb0ca1d082e67c2b5b24081759f499",
    ),
    "manga-font-v2-high-value-blind-review-agent-1401-1600-public-only-r1": (
        296_661,
        "7752fa72dcbaa86d15bda3bb99c2608a5d9c39ac8fd9f2aa09e9b56d3a9a368d",
    ),
}
EXPECTED_PRIVATE_BINDING_FILES = {
    "manga-font-v2-high-value-supervised-queue-r1-800": (
        3_839_002,
        "6f73d3830e8a00c0dd5380b61f6b4d967a93d0d7f668d979c60764efaccaf5cf",
    ),
    "manga-font-v2-high-value-supervised-queue-r2-801-1600-training-only-r1": (
        3_835_032,
        "2fb447cd758eb06e3174e05bd026a6f730d87c92a1749613f4f121f1e0855c1c",
    ),
}
SOURCE_LABEL_FILE = "training-labels.jsonl"
SOURCE_MANIFEST_FILE = "manifest.json"
DECISION_FILE = "decisions-public-blind.jsonl"
PRIVATE_BINDING_FILE = "private-bindings.jsonl"

EXPECTED_LABEL_SHA256 = (
    "513a5e9597273f0aa7ecbc195ac67332f4628a31be600f679998583a008c0d9a"
)
EXPECTED_LABEL_MANIFEST_SHA256 = (
    "27f467f915f4048472e8b63acb00dd46ac29e555509028673e782e37ca04388a"
)
EXPECTED_BASE_SHA256 = (
    "901ee8a0f6e72d42ee917a6827bc76009245ebeda0c479e9e02feb4238107f83"
)
EXPECTED_ANCHOR_CHECKPOINT_SHA256 = (
    "ff580ef87c949d9b5cc8f4552490015cb621814d6cd5c122018def415792f3de"
)

TRAINABLE_NAMES = (
    "sample_candidate_residual.2.bias",
    "sample_candidate_residual.2.weight",
)
TRAINABLE_PARAMETER_COUNT = 42 + 42 * 64
ANCHOR_TENSOR_COUNT = 15
PRODUCTION_PARAMETER_COUNT = 74_528
PRODUCTION_MACS_PER_ROW = 91_776
FOLD_COUNT = 10
INITIAL_SEED = 20260820
MARGINAL_MODES = {
    "isolated_lambda1_control": 1.0,
    "marginal_ignore": 0.0,
    "marginal_weak_negative_0_25": 0.25,
}
CHALLENGER_MINIMUM_JOINT_IMPROVEMENT = 0.005
PREFERENCE_WEIGHT = 0.65
SAFE_WEIGHT = 0.35
SINGLE_DAY_HARD_NEGATIVE_MARGIN = 0.25
SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT = 0.35
SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT = 1.0
METRIC_EPSILON = 1e-9
METRIC_GATE_ABSOLUTE_TOLERANCE = 1e-12
EPOCH_ZERO_PROBE_SIZES = (1, 7, 29, 128)

PRECOMMITTED_CONFIGURATION = {
    "anchor_kl_weight": 5.0,
    "base_residual_l2_weight": 0.005,
    "batch_size": 128,
    "direct_candidate_weight": 1.0,
    "direct_residual_l2_weight": 0.0,
    "epochs": 8,
    "evaluation_batch_size": 512,
    "gradient_clip": 1.0,
    "learning_rate": 1e-4,
    "maximum_acceptable_regression": 0.005,
    "maximum_family_regression": 0.0025,
    "maximum_preferred_regression": 0.005,
    "page_js_weight": 0.0,
    "weight_decay": 0.0,
}

FROZEN_DEPENDENCY_INVENTORY = {
    "build_manga_font_v3_page_consistency_overlay.py": (
        59_610,
        "3a9d9aa9c265dec90fcc7799202a913468706eefbde91a832e2c0b9fc7aef08e",
    ),
    "train_manga_font_student_v8_role_family_adapter.py": (
        102_058,
        "9ce1b3ed524cdad4be7a43cd485ea6cb88c19b5c53ae1a39509633a7bc1be8ae",
    ),
    "train_manga_font_v3_family_residual_r21_logo.py": (
        113_083,
        "deca641485fa0d655b370b99151ea9524f74715195fff84a1b239ef38068d268",
    ),
    "train_manga_font_v3_page_consistency_adapter.py": (
        151_732,
        "acb9302f920026593fccf85a023588de7453d8d9e21eebcf350a0fb79618179b",
    ),
    "train_manga_font_v3_shared_hidden_family_residual.py": (
        94_435,
        "9321dcc2372bd26e0567f1ec1e7d78332d71fc4b53b14ee7f3b8f27768a14b15",
    ),
    "train_manga_font_v3_shared_hidden_family_residual_r1.py": (
        91_152,
        "ce48ab76ab9278746ee9c42d83b4603daa8808d692aae688101a4f9e9393dd4c",
    ),
    "train_manga_font_v3_shared_hidden_family_residual_r2.py": (
        97_726,
        "4893376f98c1d55bedf5f2066cb02f129e4c76e9e16881921c0be6a5c4e2712a",
    ),
}

EXPECTED_TIER_COUNTS = {
    "all": {
        "rows": 1347,
        "works": 13,
        "raw_preferred_cells": 3452,
        "raw_acceptable_cells": 3767,
        "raw_marginal_cells": 1701,
        "raw_unacceptable_cells": 509,
        "raw_unreviewed_cells": 18858,
        "effective_safe_cells": 7044,
        "mutable_marginal_cells": 1568,
        "fixed_negative_cells": 817,
        "single_day_negative_rows": 1218,
        "single_day_unreviewed_negative_rows": 892,
    },
    "train": {
        "rows": 1042,
        "works": 10,
        "raw_preferred_cells": 2699,
        "raw_acceptable_cells": 2892,
        "raw_marginal_cells": 1316,
        "raw_unacceptable_cells": 387,
        "raw_unreviewed_cells": 14588,
        "effective_safe_cells": 5448,
        "mutable_marginal_cells": 1211,
        "fixed_negative_cells": 635,
        "single_day_negative_rows": 929,
        "single_day_unreviewed_negative_rows": 668,
    },
    "development_eval": {
        "rows": 305,
        "works": 3,
        "raw_preferred_cells": 753,
        "raw_acceptable_cells": 875,
        "raw_marginal_cells": 385,
        "raw_unacceptable_cells": 122,
        "raw_unreviewed_cells": 4270,
        "effective_safe_cells": 1596,
        "mutable_marginal_cells": 357,
        "fixed_negative_cells": 182,
        "single_day_negative_rows": 289,
        "single_day_unreviewed_negative_rows": 224,
    },
}

EXPECTED_AUTHORITY = {
    "automatic_label_promotion_allowed": False,
    "automatic_release_authority": False,
    "calibration_eligible": False,
    "evaluation_eligible": False,
    "human_gold": False,
    "promotion_authority": False,
    "training_eligible": True,
    "training_only": True,
    "trajectory_authenticity_keyed": False,
    "trajectory_replayed_by_strict_validator": False,
}


class R23TrainingError(ValueError):
    """Raised when the R2.3 sealed diagnostic contract is violated."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(core)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def _validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    body = dict(record)
    expected = body.pop("record_sha256", None)
    if (
        not isinstance(expected, str)
        or sha256_bytes(canonical_json(body).encode("utf-8")) != expected
    ):
        raise R23TrainingError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R23TrainingError(f"{location}: expected object")
    return value


def _assert_no_private_review_fields(value: Any, location: str = "output") -> None:
    forbidden = (
        "candidate_slots",
        "information_sampling",
        "model_probability",
        "model_prediction",
        "model_score",
        "notes",
        "selection_reason",
    )
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if any(part in str(key).lower() for part in forbidden):
                raise R23TrainingError(
                    f"{location}: private review field escaped: {key}"
                )
            _assert_no_private_review_fields(nested, f"{location}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, nested in enumerate(value):
            _assert_no_private_review_fields(nested, f"{location}[{index}]")


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise R23TrainingError(f"{location}: expected array")
    return value


def _descriptor(path: Path) -> Mapping[str, Any]:
    expanded = path.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R23TrainingError(f"linked or reparsed path rejected: {expanded}")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise R23TrainingError(f"required file is missing: {resolved}")
    return {
        "byte_size": int(resolved.stat().st_size),
        "file": str(resolved),
        "sha256": sha256_file(resolved),
    }


def _producer_binding() -> Mapping[str, Any]:
    descriptor = _descriptor(Path(__file__))
    if Path(str(descriptor["file"])).name != PRODUCER_FILE_NAME:
        raise R23TrainingError("producer file name drifted")
    modules = (
        overlay_v3,
        v8,
        r21,
        r0.page_v3,
        r0,
        r1,
        r2,
    )
    dependencies: dict[str, Mapping[str, Any]] = {}
    for module in modules:
        source = Path(str(module.__file__))
        name = source.name
        if name not in FROZEN_DEPENDENCY_INVENTORY or name in dependencies:
            raise R23TrainingError("frozen producer dependency inventory drifted")
        value = _descriptor(source)
        expected_size, expected_sha = FROZEN_DEPENDENCY_INVENTORY[name]
        if value["byte_size"] != expected_size or value["sha256"] != expected_sha:
            raise R23TrainingError(f"frozen producer dependency drifted: {name}")
        dependencies[name] = {
            "byte_size": int(value["byte_size"]),
            "file_name": name,
            "sha256": str(value["sha256"]),
        }
    if set(dependencies) != set(FROZEN_DEPENDENCY_INVENTORY):
        raise R23TrainingError("frozen producer dependency set drifted")
    return {
        "byte_size": descriptor["byte_size"],
        "file_name": PRODUCER_FILE_NAME,
        "frozen_dependencies": dict(sorted(dependencies.items())),
        "sha256": descriptor["sha256"],
    }


def _safe_new_output(path: Path) -> Path:
    try:
        return r21._safe_new_output(path)
    except r21.R21TrainingError as error:
        raise R23TrainingError(str(error)) from error


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise R23TrainingError(f"{location}: unreadable JSON") from error
    return _mapping(value, location)


def _read_jsonl(path: Path, location: str) -> list[Mapping[str, Any]]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise R23TrainingError(f"{location}: unreadable JSONL") from error
    rows: list[Mapping[str, Any]] = []
    for line_number, line in enumerate(raw.splitlines(), 1):
        try:
            decoded = line.decode("utf-8")
            value = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise R23TrainingError(f"{location}:{line_number}: invalid JSON") from error
        row = _mapping(value, f"{location}:{line_number}")
        if decoded != canonical_json(row):
            raise R23TrainingError(f"{location}:{line_number}: noncanonical JSONL")
        _validate_record_seal(row, f"{location}:{line_number}")
        rows.append(row)
    return rows


def _mask(candidate_ids: Sequence[str], values: set[str]) -> np.ndarray:
    unknown = values - set(candidate_ids)
    if unknown:
        raise R23TrainingError(f"tier candidates escaped active21: {sorted(unknown)}")
    return np.asarray(
        [candidate in values for candidate in candidate_ids], dtype=np.bool_
    )


def _inventory_sha256(rows: Sequence[Mapping[str, Any]]) -> str:
    return sha256_bytes(canonical_json(list(rows)).encode("utf-8"))


def _split_counts(
    rows: Sequence[Mapping[str, Any]], candidate_count: int
) -> Mapping[str, int]:
    counts = {
        "rows": len(rows),
        "works": len({str(row["work_id"]) for row in rows}),
        "raw_preferred_cells": 0,
        "raw_acceptable_cells": 0,
        "raw_marginal_cells": 0,
        "raw_unacceptable_cells": 0,
        "raw_unreviewed_cells": 0,
        "effective_safe_cells": 0,
        "mutable_marginal_cells": 0,
        "fixed_negative_cells": 0,
        "single_day_negative_rows": 0,
        "single_day_unreviewed_negative_rows": 0,
    }
    for row in rows:
        for key in ("preferred", "acceptable", "marginal", "unacceptable"):
            counts[f"raw_{key}_cells"] += int(np.sum(row[f"raw_{key}_mask"]))
        counts["raw_unreviewed_cells"] += candidate_count - int(
            np.sum(row["raw_eligible_mask"])
        )
        counts["effective_safe_cells"] += int(np.sum(row["safe_mask"]))
        counts["mutable_marginal_cells"] += int(np.sum(row["marginal_mask"]))
        counts["fixed_negative_cells"] += int(np.sum(row["unacceptable_mask"]))
        counts["single_day_negative_rows"] += bool(row["single_day_safety_negative"])
        counts["single_day_unreviewed_negative_rows"] += bool(
            row["single_day_safety_negative"] and row["single_day_raw_unreviewed"]
        )
    return counts


def reconstruct_tier_ledger(
    source_label_dir: Path,
    context: Mapping[str, Any],
    *,
    enforce_real: bool = True,
) -> Mapping[str, Any]:
    """Reopen exact blind decisions/private slots and rebuild four reviewed tiers."""

    label_root = source_label_dir.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(label_root):
        raise R23TrainingError("source label path is linked or reparsed")
    label_root = label_root.resolve()
    artifact_root = label_root.parent
    label_path = label_root / SOURCE_LABEL_FILE
    label_manifest_path = label_root / SOURCE_MANIFEST_FILE
    label_descriptor = _descriptor(label_path)
    label_manifest_descriptor = _descriptor(label_manifest_path)
    if enforce_real and (
        label_descriptor["sha256"] != EXPECTED_LABEL_SHA256
        or label_manifest_descriptor["sha256"] != EXPECTED_LABEL_MANIFEST_SHA256
    ):
        raise R23TrainingError("sealed training-label source bytes drifted")
    label_manifest = _read_json(label_manifest_path, "source label manifest")
    _validate_record_seal(label_manifest, "source label manifest")
    labels = _read_jsonl(label_path, "source training labels")

    decisions: dict[str, Mapping[str, Any]] = {}
    bindings: dict[str, Mapping[str, Any]] = {}
    source_files: list[Mapping[str, Any]] = [
        {"role": "sealed_labels", **label_descriptor},
        {"role": "sealed_label_manifest", **label_manifest_descriptor},
    ]
    for directory in DECISION_DIRECTORIES:
        path = artifact_root / directory / DECISION_FILE
        descriptor = _descriptor(path)
        expected_size, expected_sha = EXPECTED_DECISION_FILES[directory]
        if enforce_real and (
            descriptor["byte_size"] != expected_size
            or descriptor["sha256"] != expected_sha
        ):
            raise R23TrainingError(f"blind decision source drifted: {directory}")
        source_files.append({"role": "blind_decisions", **descriptor})
        for row in _read_jsonl(path, f"blind decisions {directory}"):
            record_sha = str(row["record_sha256"])
            if record_sha in decisions:
                raise R23TrainingError("duplicate blind-decision record")
            decisions[record_sha] = row
    for directory in PRIVATE_BINDING_DIRECTORIES:
        path = artifact_root / directory / PRIVATE_BINDING_FILE
        descriptor = _descriptor(path)
        expected_size, expected_sha = EXPECTED_PRIVATE_BINDING_FILES[directory]
        if enforce_real and (
            descriptor["byte_size"] != expected_size
            or descriptor["sha256"] != expected_sha
        ):
            raise R23TrainingError(f"private binding source drifted: {directory}")
        source_files.append({"role": "private_bindings", **descriptor})
        for row in _read_jsonl(path, f"private bindings {directory}"):
            record_sha = str(row["record_sha256"])
            if record_sha in bindings:
                raise R23TrainingError("duplicate private-binding record")
            bindings[record_sha] = row
    if enforce_real and (len(decisions), len(bindings), len(labels)) != (
        1600,
        1600,
        1347,
    ):
        raise R23TrainingError("source decision/binding inventory drifted")

    arrays = context["arrays"]
    candidate_ids = tuple(str(value) for value in context["candidate_ids"])
    sample_to_index = {
        str(sample_id): index
        for index, sample_id in enumerate(arrays["sample_ids"].astype(str).tolist())
    }
    split_contract = _mapping(context["overlay_binding"], "overlay split contract")
    train_works = set(str(value) for value in split_contract["train_work_ids"])
    development_works = set(
        str(value) for value in split_contract["development_eval_work_ids"]
    )
    if train_works & development_works:
        raise R23TrainingError("direct work split overlaps")
    single_day_index = candidate_ids.index("single-day")
    tier_rows: list[Mapping[str, Any]] = []
    seen_indices: set[int] = set()
    for label in labels:
        binding_contract = _mapping(label.get("review_binding"), "label review binding")
        decision_sha = str(binding_contract.get("blind_decision_record_sha256"))
        private_sha = str(binding_contract.get("private_binding_record_sha256"))
        decision = decisions.get(decision_sha)
        private = bindings.get(private_sha)
        if decision is None or private is None:
            raise R23TrainingError("label-bound decision/private record is missing")
        if (
            str(decision.get("record_sha256")) != decision_sha
            or str(private.get("record_sha256")) != private_sha
            or decision.get("review_id") != private.get("review_id")
            or decision.get("sample_id") != label.get("sample_id")
            or private.get("sample_id") != label.get("sample_id")
        ):
            raise R23TrainingError("label/decision/private identity drifted")
        slots: dict[str, str] = {}
        for value in _sequence(
            private.get("candidate_slots"), "private candidate slots"
        ):
            slot = _mapping(value, "private candidate slot")
            slots[str(slot["slot"])] = str(slot["candidate_id"])
        if tuple(sorted(slots)) != tuple("ABCDEFG") or len(set(slots.values())) != 7:
            raise R23TrainingError("private A-G candidate binding drifted")
        tiers: dict[str, set[str]] = {}
        used_slots: list[str] = []
        for name in ("preferred", "acceptable", "marginal", "unacceptable"):
            selected_slots = [str(value) for value in decision[f"{name}_slots"]]
            used_slots.extend(selected_slots)
            tiers[name] = {slots[value] for value in selected_slots}
        unrenderable_slots = [str(value) for value in decision["unrenderable_slots"]]
        used_slots.extend(unrenderable_slots)
        if sorted(used_slots) != list("ABCDEFG") or len(set(used_slots)) != 7:
            raise R23TrainingError("blind tier decision is not an exact A-G partition")
        if unrenderable_slots or not tiers["preferred"]:
            raise R23TrainingError("sealed direct row tier boundary drifted")
        raw_eligible = set().union(*tiers.values())
        candidate_labels = _mapping(label.get("candidate_labels"), "candidate labels")
        if (
            raw_eligible != set(candidate_labels["eligible_candidate_ids"])
            or tiers["preferred"] != set(candidate_labels["preferred_candidate_ids"])
            or tiers["preferred"] | tiers["acceptable"]
            != set(candidate_labels["positive_candidate_ids"])
        ):
            raise R23TrainingError("reopened tier partition does not reproduce seal")
        sample_id = str(label["sample_id"])
        index = sample_to_index.get(sample_id)
        if index is None or index in seen_indices:
            raise R23TrainingError("tier row does not map uniquely to base NPZ")
        seen_indices.add(index)
        identity = _mapping(label.get("identity"), "label identity")
        work_id = str(identity["work_id"])
        if (
            str(arrays["work_ids"][index]) != work_id
            or int(arrays["split"][index]) != 0
        ):
            raise R23TrainingError("tier row escaped base-train work binding")
        split = (
            "train"
            if work_id in train_works
            else "development_eval"
            if work_id in development_works
            else None
        )
        if split is None:
            raise R23TrainingError("tier row escaped sealed 10/3 work split")
        family_label = (
            v8.BODY_FAMILY_INDEX
            if label["family"] == "body"
            else v8.VARIANT_FAMILY_INDEX
        )
        raw_masks = {
            name: _mask(candidate_ids, values) for name, values in tiers.items()
        }
        raw_eligible_mask = np.logical_or.reduce(tuple(raw_masks.values()))
        preferred = raw_masks["preferred"].copy()
        acceptable = raw_masks["acceptable"].copy()
        marginal = raw_masks["marginal"].copy()
        unacceptable = raw_masks["unacceptable"].copy()
        if family_label == v8.BODY_FAMILY_INDEX:
            preferred[single_day_index] = False
            acceptable[single_day_index] = False
        safe = preferred | acceptable
        single_day_positive = bool(safe[single_day_index])
        single_day_safety_negative = not single_day_positive
        # Single Day never participates in mutable marginal lambda.  Reviewed
        # nonpositive Single Day becomes a fixed negative; unreviewed Single
        # Day remains outside set-NLL and is handled by the safety auxiliary.
        marginal[single_day_index] = False
        if raw_eligible_mask[single_day_index] and single_day_safety_negative:
            unacceptable[single_day_index] = True
        else:
            unacceptable[single_day_index] = False
        if bool(
            (safe & marginal).any()
            or (safe & unacceptable).any()
            or (marginal & unacceptable).any()
        ):
            raise R23TrainingError("effective candidate tiers overlap")
        if not bool(safe.any()):
            raise R23TrainingError("effective direct row lost every safe candidate")
        authority = _mapping(label.get("authority"), "label authority")
        if not (
            authority.get("training_only") is True
            and authority.get("training_eligible") is True
            and authority.get("human_gold") is False
            and authority.get("evaluation_eligible") is False
        ):
            raise R23TrainingError("tier label authority drifted")
        tier_rows.append(
            {
                "acceptable_mask": acceptable,
                "family_label": int(family_label),
                "marginal_mask": marginal,
                "preferred_mask": preferred,
                "raw_acceptable_mask": raw_masks["acceptable"],
                "raw_eligible_mask": raw_eligible_mask,
                "raw_marginal_mask": raw_masks["marginal"],
                "raw_preferred_mask": raw_masks["preferred"],
                "raw_unacceptable_mask": raw_masks["unacceptable"],
                "record_sha256": str(label["record_sha256"]),
                "row_index": int(index),
                "safe_mask": safe,
                "sample_id": sample_id,
                "single_day_raw_unreviewed": not bool(
                    raw_eligible_mask[single_day_index]
                ),
                "single_day_safety_negative": bool(single_day_safety_negative),
                "split": split,
                "supervision_weight": float(label["supervision_weight"]),
                "unacceptable_mask": unacceptable,
                "work_id": work_id,
            }
        )
    tier_rows.sort(key=lambda row: int(row["row_index"]))
    partitions = {
        "train": [row for row in tier_rows if row["split"] == "train"],
        "development_eval": [
            row for row in tier_rows if row["split"] == "development_eval"
        ],
        "all": tier_rows,
    }
    counts = {
        name: _split_counts(selected, len(candidate_ids))
        for name, selected in partitions.items()
    }
    if enforce_real and counts != EXPECTED_TIER_COUNTS:
        raise R23TrainingError(f"tri-state tier ledger count drifted: {counts}")
    serializable_inventory = [
        {
            "family_label": row["family_label"],
            "record_sha256": row["record_sha256"],
            "row_index": row["row_index"],
            "sample_id": row["sample_id"],
            "split": row["split"],
            "supervision_weight_f32_hex": np.asarray(
                row["supervision_weight"], dtype="<f4"
            )
            .tobytes()
            .hex(),
            "work_id": row["work_id"],
            **{
                f"{name}_candidate_ids": [
                    candidate_ids[index]
                    for index in np.flatnonzero(row[f"{name}_mask"])
                ]
                for name in (
                    "acceptable",
                    "marginal",
                    "preferred",
                    "safe",
                    "unacceptable",
                )
            },
            "single_day_raw_unreviewed": row["single_day_raw_unreviewed"],
            "single_day_safety_negative": row["single_day_safety_negative"],
        }
        for row in tier_rows
    ]
    return {
        "candidate_ids": candidate_ids,
        "contract": {
            "authority": dict(EXPECTED_AUTHORITY),
            "counts": counts,
            "decision_record_count": len(decisions),
            "inventory_sha256": _inventory_sha256(serializable_inventory),
            "private_binding_record_count": len(bindings),
            "single_day_policy": {
                "body_positive_and_preferred_removed_before_loss": True,
                "candidate_distribution_excess_weight": 0.0,
                "direct_residual_regularizer_weight": 0.0,
                "marginal_lambda_applies_to_single_day": False,
                "ordinary_unreviewed_candidate_score_gradient_zero_except_single_day_safety": True,
                "ordinary_unreviewed_excluded_from_tier_set_nll": True,
                "single_day_is_only_unreviewed_hard_negative_exception": True,
            },
            "source_files": sorted(source_files, key=lambda value: str(value["file"])),
        },
        "development_eval": tuple(partitions["development_eval"]),
        "rows": tuple(tier_rows),
        "train": tuple(partitions["train"]),
    }


def _weighted_logsumexp(
    torch: Any, scores: Any, masks: Sequence[tuple[Any, float]]
) -> Any:
    weighted_parts: list[Any] = []
    negative_infinity = torch.finfo(scores.dtype).min
    for mask, weight in masks:
        if weight == 0.0:
            continue
        shifted = scores.float() + float(math.log(weight))
        weighted_parts.append(shifted.masked_fill(~mask.bool(), negative_infinity))
    if not weighted_parts:
        raise R23TrainingError("weighted set-NLL denominator is empty")
    combined = torch.stack(weighted_parts, dim=0).max(dim=0).values
    return torch.logsumexp(combined, dim=1)


def weighted_candidate_set_loss(
    torch: Any,
    scores: Any,
    *,
    preferred_mask: Any,
    safe_mask: Any,
    marginal_mask: Any,
    unacceptable_mask: Any,
    single_day_safety_negative: Any,
    marginal_weight: float,
    row_weights: Any,
) -> tuple[Any, Mapping[str, Any]]:
    """Core current set-NLL with only marginal denominator strength changed."""

    if marginal_weight not in set(MARGINAL_MODES.values()):
        raise R23TrainingError("unsupported marginal lambda")
    if scores.ndim != 2:
        raise R23TrainingError("candidate score shape drifted")
    masks = tuple(
        value.bool()
        for value in (preferred_mask, safe_mask, marginal_mask, unacceptable_mask)
    )
    if any(mask.shape != scores.shape for mask in masks):
        raise R23TrainingError("candidate tier mask shape drifted")
    preferred, safe, marginal, unacceptable = masks
    if not bool(
        safe.any(dim=1).all()
        and (preferred <= safe).all()
        and not (safe & marginal).any()
        and not (safe & unacceptable).any()
        and not (marginal & unacceptable).any()
    ):
        raise R23TrainingError("candidate tier masks overlap or lack safe target")
    safety = single_day_safety_negative.bool()
    if safety.shape != (scores.shape[0],):
        raise R23TrainingError("Single Day safety mask shape drifted")
    weights = row_weights.float()
    if weights.shape != safety.shape or not bool(
        torch.isfinite(weights).all() and (weights > 0).all()
    ):
        raise R23TrainingError("candidate row weights drifted")
    denominator = _weighted_logsumexp(
        torch,
        scores,
        ((safe, 1.0), (marginal, float(marginal_weight)), (unacceptable, 1.0)),
    )
    negative_infinity = torch.finfo(scores.dtype).min
    safe_log_mass = torch.logsumexp(
        scores.float().masked_fill(~safe, negative_infinity), dim=1
    )
    safe_losses = denominator - safe_log_mass
    safe_loss = (safe_losses * weights).sum() / weights.sum().clamp_min(1e-12)
    preferred_rows = preferred.any(dim=1)
    if bool(preferred_rows.any()):
        preferred_log_mass = torch.logsumexp(
            scores.float().masked_fill(~preferred, negative_infinity), dim=1
        )
        preferred_losses = (denominator - preferred_log_mass)[preferred_rows]
        preferred_weights = weights[preferred_rows]
        preferred_loss = (
            preferred_losses * preferred_weights
        ).sum() / preferred_weights.sum().clamp_min(1e-12)
    else:
        preferred_loss = scores.sum() * 0.0
    total = SAFE_WEIGHT * safe_loss + PREFERENCE_WEIGHT * preferred_loss
    return total, {
        "candidate_distribution_excess": scores.sum() * 0.0,
        "core_set_nll": total,
        "marginal_lambda": float(marginal_weight),
        "preferred_set_nll": preferred_loss,
        "safe_set_nll": safe_loss,
        "single_day_safety_negative_rows": safety.sum(),
    }


def _single_day_safety_losses(
    torch: Any,
    outputs: Mapping[str, Any],
    *,
    safe_mask: Any,
    family_labels: Any,
    safety_negative: Any,
    row_weights: Any,
    single_day_index: int,
) -> Mapping[str, Any]:
    body = outputs["body_candidate_scores"].float()
    variant = outputs["variant_candidate_scores"].float()
    safe = safe_mask.bool()
    labels = family_labels.long()
    negative = safety_negative.bool()
    weights = row_weights.float()
    if body.shape != variant.shape or safe.shape != body.shape:
        raise R23TrainingError("Single Day safety tensor shape drifted")
    negative_infinity = torch.finfo(body.dtype).min
    body_best = body.masked_fill(~safe, negative_infinity).max(dim=1).values
    variant_best = variant.masked_fill(~safe, negative_infinity).max(dim=1).values
    supervised_losses = 0.5 * (
        torch.relu(
            body[:, single_day_index] - body_best + SINGLE_DAY_HARD_NEGATIVE_MARGIN
        )
        + torch.relu(
            variant[:, single_day_index]
            - variant_best
            + SINGLE_DAY_HARD_NEGATIVE_MARGIN
        )
    )
    supervised = (supervised_losses[negative] * weights[negative]).sum() / weights[
        negative
    ].sum().clamp_min(1e-12)
    body_negative = negative & (labels == v8.BODY_FAMILY_INDEX)
    routed = torch.where(labels[:, None] == v8.BODY_FAMILY_INDEX, body, variant)
    routed_best = routed.masked_fill(~safe, negative_infinity).max(dim=1).values
    body_losses = torch.relu(
        routed[:, single_day_index] - routed_best + SINGLE_DAY_HARD_NEGATIVE_MARGIN
    )
    body_loss = (body_losses[body_negative] * weights[body_negative]).sum() / weights[
        body_negative
    ].sum().clamp_min(1e-12)
    return {
        "body_hard_negative": body_loss,
        "body_negative_rows": body_negative.sum(),
        "supervised_hard_negative": supervised,
        "supervised_negative_rows": negative.sum(),
    }


def _index_sha256(values: np.ndarray) -> str:
    return sha256_bytes(np.ascontiguousarray(values, dtype="<i8").tobytes(order="C"))


def _string_sha256(values: Sequence[str]) -> str:
    digest = hashlib.sha256()
    for value in values:
        digest.update(str(value).encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _payload_sha256(value: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def _sidecar_name(fold_index: int) -> str:
    if isinstance(fold_index, bool) or not isinstance(fold_index, int):
        raise R23TrainingError("fold index must be an integer")
    if not 0 <= fold_index < FOLD_COUNT:
        raise R23TrainingError("fold index escaped LOGO inventory")
    return SIDECAR_TEMPLATE.format(fold_index=fold_index)


def _sidecar_spec() -> Mapping[str, tuple[tuple[int, ...], str]]:
    return {
        "sample_candidate_residual.2.bias": ((42,), "float32"),
        "sample_candidate_residual.2.weight": ((42, 64), "float32"),
    }


def configure_candidate_final_head(model: Any) -> Any:
    """Freeze the exact adapter except its existing 64->42 final projection."""

    model.requires_grad_(False).eval()
    named = dict(model.named_parameters())
    if set(TRAINABLE_NAMES) - set(named):
        raise R23TrainingError("candidate final head is absent from anchor")
    for name in TRAINABLE_NAMES:
        named[name].requires_grad_(True)
    trainable = {
        name for name, value in model.named_parameters() if value.requires_grad
    }
    count = sum(value.numel() for value in model.parameters() if value.requires_grad)
    if trainable != set(TRAINABLE_NAMES) or count != TRAINABLE_PARAMETER_COUNT:
        raise R23TrainingError("trainable candidate head inventory drifted")
    return model


def build_candidate_model(context: Mapping[str, Any], device: Any) -> Any:
    model = copy.deepcopy(context["model"]).to(device)
    if len(model.state_dict()) != ANCHOR_TENSOR_COUNT:
        raise R23TrainingError("anchor tensor inventory drifted")
    return configure_candidate_final_head(model)


def _sidecar_state(model: Any) -> Mapping[str, Any]:
    spec = _sidecar_spec()
    named = dict(model.named_parameters())
    trainable = {name for name, value in named.items() if value.requires_grad}
    if trainable != set(spec):
        raise R23TrainingError("candidate sidecar trainable inventory drifted")
    return {
        name: named[name].detach().cpu().float().contiguous().clone()
        for name in sorted(spec)
    }


def _state_payload(state: Mapping[str, Any]) -> Mapping[str, Any]:
    spec = _sidecar_spec()
    if set(state) != set(spec):
        raise R23TrainingError("candidate sidecar state inventory drifted")
    payload: dict[str, Any] = {}
    for name, (shape, dtype) in sorted(spec.items()):
        source = np.asarray(state[name].detach().cpu().numpy())
        if tuple(source.shape) != shape or source.dtype != np.dtype(dtype):
            raise R23TrainingError(f"candidate sidecar tensor drifted: {name}")
        array = np.asarray(source, dtype="<f4")
        if not np.isfinite(array).all():
            raise R23TrainingError(f"candidate sidecar tensor non-finite: {name}")
        payload[name] = {
            "data_hex_little_endian_float32": array.tobytes(order="C").hex(),
            "dtype": dtype,
            "shape": list(shape),
        }
    return payload


def _state_from_payload(torch: Any, payload: Mapping[str, Any]) -> Mapping[str, Any]:
    spec = _sidecar_spec()
    if set(payload) != set(spec):
        raise R23TrainingError("candidate sidecar payload inventory drifted")
    result: dict[str, Any] = {}
    for name, (shape, dtype) in sorted(spec.items()):
        descriptor = _mapping(payload[name], f"candidate sidecar payload {name}")
        if set(descriptor) != {
            "data_hex_little_endian_float32",
            "dtype",
            "shape",
        } or (descriptor.get("dtype"), descriptor.get("shape")) != (
            dtype,
            list(shape),
        ):
            raise R23TrainingError(f"candidate sidecar payload drifted: {name}")
        encoded = descriptor["data_hex_little_endian_float32"]
        if not isinstance(encoded, str):
            raise R23TrainingError(f"candidate sidecar bytes missing: {name}")
        try:
            raw = bytes.fromhex(encoded)
        except ValueError as error:
            raise R23TrainingError(
                f"candidate sidecar bytes invalid: {name}"
            ) from error
        if len(raw) != int(np.prod(shape, dtype=np.int64)) * 4:
            raise R23TrainingError(f"candidate sidecar byte size drifted: {name}")
        array = np.frombuffer(raw, dtype="<f4").reshape(shape).copy()
        if not np.isfinite(array).all():
            raise R23TrainingError(f"candidate sidecar is non-finite: {name}")
        result[name] = torch.from_numpy(array)
    return result


def _apply_sidecar_state(model: Any, state: Mapping[str, Any]) -> None:
    spec = _sidecar_spec()
    if set(state) != set(spec):
        raise R23TrainingError("candidate sidecar state inventory drifted")
    named = dict(model.named_parameters())
    import torch

    with torch.no_grad():
        for name, (shape, _dtype) in spec.items():
            value = state[name].to(device=named[name].device, dtype=named[name].dtype)
            if tuple(value.shape) != shape:
                raise R23TrainingError(f"candidate sidecar shape drifted: {name}")
            named[name].copy_(value)


def _load_sidecar_state(torch: Any, path: Path) -> Mapping[str, Any]:
    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover
        raise R23TrainingError("safetensors is required") from error
    try:
        arrays = load_file(str(path))
    except Exception as error:  # noqa: BLE001
        raise R23TrainingError("candidate sidecar is unreadable") from error
    spec = _sidecar_spec()
    if set(arrays) != set(spec):
        raise R23TrainingError("candidate sidecar checkpoint inventory drifted")
    result: dict[str, Any] = {}
    for name, (shape, dtype) in spec.items():
        array = np.asarray(arrays[name])
        if (
            tuple(array.shape) != shape
            or str(array.dtype) != dtype
            or not np.isfinite(array).all()
        ):
            raise R23TrainingError(f"candidate sidecar checkpoint drifted: {name}")
        result[name] = torch.from_numpy(np.array(array, copy=True))
    return result


def _tensor_inventory(state: Mapping[str, Any]) -> Mapping[str, Any]:
    result: dict[str, Any] = {}
    for name, value in sorted(state.items()):
        array = value.detach().cpu().float().contiguous().numpy()
        result[name] = {
            "dtype": str(array.dtype),
            "sha256": sha256_bytes(array.tobytes(order="C")),
            "shape": list(array.shape),
        }
    return result


def _frozen_tensor_inventory(model: Any) -> Mapping[str, Any]:
    state = {
        name: value
        for name, value in model.state_dict().items()
        if name not in TRAINABLE_NAMES
    }
    if len(state) != ANCHOR_TENSOR_COUNT - len(TRAINABLE_NAMES):
        raise R23TrainingError("frozen candidate tensor inventory drifted")
    return _tensor_inventory(state)


def build_candidate_cache(
    torch: Any,
    *,
    context: Mapping[str, Any],
    device: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    try:
        cache = dict(
            r0._build_frozen_cache(
                torch,
                context=context,
                device=device,
                batch_size=int(batch_size),
            )
        )
    except r0.SharedHiddenFamilyResidualError as error:
        raise R23TrainingError(str(error)) from error
    anchor = context["model"].to(device).eval()
    final = anchor.sample_candidate_residual[2]
    with torch.inference_mode():
        gates = torch.softmax(cache["family_logits"].float(), dim=1)
    cache.update(
        {
            "anchor_final_bias": final.bias.detach().clone(),
            "anchor_final_weight": final.weight.detach().clone(),
            "candidate_ids": tuple(str(value) for value in context["candidate_ids"]),
            "family_gate_probabilities": gates.detach(),
        }
    )
    return cache


def build_training_cache(
    torch: Any,
    *,
    context: Mapping[str, Any],
    device: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    """Preserve CPU anchor outputs while moving the frozen cache to training device."""

    cpu_cache = build_candidate_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(batch_size),
    )
    return transfer_candidate_cache(torch, cache=cpu_cache, device=device)


def transfer_candidate_cache(
    torch: Any, *, cache: Mapping[str, Any], device: Any
) -> Mapping[str, Any]:
    return {
        name: value.to(device) if torch.is_tensor(value) else value
        for name, value in cache.items()
    }


def candidate_outputs_from_cache(
    torch: Any,
    model: Any,
    cache: Mapping[str, Any],
    indices: np.ndarray,
) -> Mapping[str, Any]:
    rows = np.asarray(indices, dtype=np.int64)
    positions = torch.as_tensor(rows, dtype=torch.long, device=cache["hidden"].device)
    hidden = cache["hidden"][positions].float()
    final = model.sample_candidate_residual[2]
    candidate_count = int(cache["body_candidate_scores"].shape[1])
    anchor_weight = cache["anchor_final_weight"]
    anchor_bias = cache["anchor_final_bias"]
    anchor_linear = torch.nn.functional.linear(hidden, anchor_weight, anchor_bias)
    anchor_residual = torch.tanh(anchor_linear).reshape(
        len(rows), len(v8.FAMILY_VALUES), candidate_count
    ) * float(model.maximum_sample_residual)
    residual = torch.tanh(
        torch.nn.functional.linear(hidden, final.weight, final.bias)
    ).reshape(len(rows), len(v8.FAMILY_VALUES), candidate_count) * float(
        model.maximum_sample_residual
    )
    delta = residual - anchor_residual
    body = cache["body_candidate_scores"][positions] + delta[:, v8.BODY_FAMILY_INDEX]
    variant = (
        cache["variant_candidate_scores"][positions] + delta[:, v8.VARIANT_FAMILY_INDEX]
    )
    gates = cache["family_gate_probabilities"][positions]
    deployed = (
        cache["candidate_scores"][positions]
        + gates[:, v8.BODY_FAMILY_INDEX, None] * delta[:, v8.BODY_FAMILY_INDEX]
        + gates[:, v8.VARIANT_FAMILY_INDEX, None] * delta[:, v8.VARIANT_FAMILY_INDEX]
    )
    return {
        "body_candidate_scores": body,
        "candidate_scores": deployed,
        "family_logits": cache["family_logits"][positions],
        "sample_candidate_residual": residual,
        "sample_candidate_residual_delta": delta,
        "variant_candidate_scores": variant,
    }


def assert_epoch0_exact(
    torch: Any,
    model: Any,
    cache: Mapping[str, Any],
) -> None:
    row_count = int(cache["hidden"].shape[0])
    probe_sizes = sorted(
        {row_count}
        | {min(size, row_count) for size in EPOCH_ZERO_PROBE_SIZES if row_count > 0}
    )
    for probe_size in probe_sizes:
        indices = np.arange(probe_size, dtype=np.int64)
        outputs = candidate_outputs_from_cache(torch, model, cache, indices)
        for name in (
            "body_candidate_scores",
            "candidate_scores",
            "family_logits",
            "variant_candidate_scores",
        ):
            if not torch.equal(outputs[name], cache[name][:probe_size]):
                raise R23TrainingError(
                    f"epoch-zero candidate output drifted: {name} rows={probe_size}"
                )
        if int(torch.count_nonzero(outputs["sample_candidate_residual_delta"])) != 0:
            raise R23TrainingError(
                f"epoch-zero sample residual delta is nonzero: rows={probe_size}"
            )


def _load_context(args: argparse.Namespace, torch: Any) -> Mapping[str, Any]:
    try:
        context = r21._load_context(args, torch)
    except r21.R21TrainingError as error:
        raise R23TrainingError(str(error)) from error
    if tuple(context["candidate_ids"]) != tuple(r0.page_v3.EXPECTED_CANDIDATE_IDS):
        raise R23TrainingError("active candidate inventory drifted")
    return context


def _exact_int(value: Any, name: str, *, positive: bool = True) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise R23TrainingError(f"{name} must be an exact integer")
    if (positive and value < 1) or (not positive and value < 0):
        raise R23TrainingError(f"{name} is outside its numeric domain")
    return int(value)


def _exact_number(value: Any, name: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise R23TrainingError(f"{name} must be an exact non-bool number")
    number = float(value)
    if not math.isfinite(number) or (positive and number <= 0.0):
        raise R23TrainingError(f"{name} is outside its numeric domain")
    return number


def _validate_options(args: argparse.Namespace) -> None:
    if args.marginal_mode not in MARGINAL_MODES:
        raise R23TrainingError("marginal mode drifted")
    _exact_int(args.seed, "seed", positive=False)
    if int(args.seed) != INITIAL_SEED:
        raise R23TrainingError("R2.3 first screen permits only seed 20260820")
    for name in ("epochs", "batch_size", "evaluation_batch_size"):
        actual = _exact_int(getattr(args, name), name)
        if actual != int(PRECOMMITTED_CONFIGURATION[name]):
            raise R23TrainingError(f"precommitted integer option drifted: {name}")
    for name in (
        "anchor_kl_weight",
        "base_residual_l2_weight",
        "direct_candidate_weight",
        "direct_residual_l2_weight",
        "gradient_clip",
        "learning_rate",
        "maximum_acceptable_regression",
        "maximum_family_regression",
        "maximum_preferred_regression",
        "page_js_weight",
        "weight_decay",
    ):
        actual = _exact_number(
            getattr(args, name),
            name,
            positive=name
            in {
                "anchor_kl_weight",
                "direct_candidate_weight",
                "gradient_clip",
                "learning_rate",
            },
        )
        if actual != float(PRECOMMITTED_CONFIGURATION[name]):
            raise R23TrainingError(f"precommitted numeric option drifted: {name}")
    if args.device not in {"cpu", "cuda"}:
        raise R23TrainingError("device must be cpu or cuda")
    if args.page_js_weight != 0.0:
        raise R23TrainingError("first screen requires metric-only page consistency")
    if (
        args.control_dir is not None
        and args.marginal_mode == "isolated_lambda1_control"
    ):
        raise R23TrainingError(
            "lambda1 control cannot consume another control artifact"
        )


def _configuration(args: argparse.Namespace) -> Mapping[str, Any]:
    return {
        "anchor_kl_scope": "non_direct_base_preservation_only",
        "anchor_kl_weight": float(args.anchor_kl_weight),
        "base_residual_l2_weight": float(args.base_residual_l2_weight),
        "batch_size": int(args.batch_size),
        "candidate_distribution_excess_weight": 0.0,
        "device": str(args.device),
        "direct_balance_mode": "work_family",
        "direct_candidate_weight": float(args.direct_candidate_weight),
        "direct_residual_l2_weight": float(args.direct_residual_l2_weight),
        "epochs": int(args.epochs),
        "evaluation_batch_size": int(args.evaluation_batch_size),
        "experiment_cell_id": f"r23-{args.marginal_mode}-seed{args.seed}",
        "gradient_clip": float(args.gradient_clip),
        "learning_rate": float(args.learning_rate),
        "marginal_lambda": float(MARGINAL_MODES[args.marginal_mode]),
        "marginal_mode": str(args.marginal_mode),
        "maximum_acceptable_regression": float(args.maximum_acceptable_regression),
        "maximum_family_regression": float(args.maximum_family_regression),
        "maximum_preferred_regression": float(args.maximum_preferred_regression),
        "page_js_weight": float(args.page_js_weight),
        "page_optimizer_calls": 0,
        "seed": int(args.seed),
        "single_day_body_hard_negative_weight": SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT,
        "single_day_supervised_hard_negative_weight": (
            SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
        ),
        "weight_decay": float(args.weight_decay),
    }


def _discriminative_groups(
    groups: Sequence[Mapping[str, Any]],
) -> tuple[Mapping[str, Any], ...]:
    selected = tuple(
        group
        for group in groups
        if bool(
            (
                np.asarray(group["shared_reviewed_eligible_mask"], dtype=np.bool_)
                & ~np.asarray(group["common_positive_mask"], dtype=np.bool_)
            ).any()
        )
    )
    return selected


def _fold_contract(
    *,
    fold_index: int,
    heldout_work_id: str,
    train_rows: Sequence[Mapping[str, Any]],
    heldout_rows: Sequence[Mapping[str, Any]],
    base_indices: np.ndarray,
    all_gradient_indices: np.ndarray,
    heldout_base_indices: np.ndarray,
    train_page_groups: Sequence[Mapping[str, Any]],
    heldout_page_groups: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    direct_indices = np.asarray(
        [row["row_index"] for row in train_rows], dtype=np.int64
    )
    direct_set = set(direct_indices.tolist())
    base_set = set(np.asarray(base_indices, dtype=np.int64).tolist())
    all_set = set(np.asarray(all_gradient_indices, dtype=np.int64).tolist())
    if base_set & direct_set or base_set | direct_set != all_set:
        raise R23TrainingError("fold direct/base partition algebra drifted")
    strata = sorted(
        {(str(row["work_id"]), int(row["family_label"])) for row in train_rows}
    )
    page_indices = np.concatenate(
        [
            np.asarray(group["row_indices"], dtype=np.int64)
            for group in train_page_groups
        ]
    )
    heldout_page_indices = np.concatenate(
        [
            np.asarray(group["row_indices"], dtype=np.int64)
            for group in heldout_page_groups
        ]
    )
    if len(strata) != 18:
        raise R23TrainingError("LOGO fold must contain 18 work-family strata")
    return {
        "active_work_family_strata": [
            {"family_label": family, "work_id": work} for work, family in strata
        ],
        "active_work_family_strata_count": len(strata),
        "all_gradient_index_sha256": _index_sha256(all_gradient_indices),
        "all_gradient_rows": int(len(all_gradient_indices)),
        "base_index_sha256": _index_sha256(base_indices),
        "base_rows": int(len(base_indices)),
        "development_rows_consulted": 0,
        "direct_index_sha256": _index_sha256(direct_indices),
        "direct_inventory_sha256": _inventory_sha256(
            [
                {
                    "family_label": int(row["family_label"]),
                    "record_sha256": str(row["record_sha256"]),
                    "row_index": int(row["row_index"]),
                    "supervision_weight_f32_hex": np.asarray(
                        row["supervision_weight"], dtype="<f4"
                    )
                    .tobytes()
                    .hex(),
                    "work_id": str(row["work_id"]),
                }
                for row in train_rows
            ]
        ),
        "direct_rows": int(len(train_rows)),
        "fold_index": int(fold_index),
        "heldout_base_index_sha256": _index_sha256(heldout_base_indices),
        "heldout_base_rows": int(len(heldout_base_indices)),
        "heldout_direct_index_sha256": _index_sha256(
            np.asarray([row["row_index"] for row in heldout_rows], dtype=np.int64)
        ),
        "heldout_direct_rows": int(len(heldout_rows)),
        "heldout_page_group_count": int(len(heldout_page_groups)),
        "heldout_page_index_sha256": _index_sha256(heldout_page_indices),
        "heldout_page_rows": int(len(heldout_page_indices)),
        "heldout_work_id": str(heldout_work_id),
        "page_metric_group_count": int(len(train_page_groups)),
        "page_metric_index_sha256": _index_sha256(page_indices),
        "page_metric_rows": int(len(page_indices)),
        "page_optimizer_calls": 0,
        "train_work_ids": sorted({str(row["work_id"]) for row in train_rows}),
    }


def build_logo_folds(
    context: Mapping[str, Any],
    ledger: Mapping[str, Any],
    *,
    enforce_real: bool = True,
) -> tuple[Mapping[str, Any], ...]:
    arrays = context["arrays"]
    development_works = tuple(
        str(value) for value in context["overlay_binding"]["development_eval_work_ids"]
    )
    all_base = r0._base_train_indices(arrays, development_works)
    direct_rows = tuple(ledger["train"])
    direct_indices = np.asarray(
        [row["row_index"] for row in direct_rows], dtype=np.int64
    )
    direct_set = set(direct_indices.tolist())
    non_direct = np.asarray(
        [index for index in all_base.tolist() if int(index) not in direct_set],
        dtype=np.int64,
    )
    if enforce_real and (len(all_base), len(direct_rows), len(non_direct)) != (
        12_923,
        1_042,
        11_881,
    ):
        raise R23TrainingError("global tri-state partition inventory drifted")
    universe = tuple(sorted({str(row["work_id"]) for row in direct_rows}))
    if enforce_real and len(universe) != FOLD_COUNT:
        raise R23TrainingError("LOGO direct work universe drifted")
    array_work_ids = arrays["work_ids"].astype(str, copy=False)
    discriminative = _discriminative_groups(context["groups"]["train"])
    development_discriminative = _discriminative_groups(
        context["groups"]["development_eval"]
    )
    if enforce_real and (
        len(discriminative),
        sum(len(group["row_indices"]) for group in discriminative),
        len(development_discriminative),
    ) != (68, 148, 23):
        raise R23TrainingError("discriminative page metric inventory drifted")
    folds: list[Mapping[str, Any]] = []
    for fold_index, heldout_work_id in enumerate(universe):
        train_rows = tuple(
            row for row in direct_rows if str(row["work_id"]) != heldout_work_id
        )
        heldout_rows = tuple(
            row for row in direct_rows if str(row["work_id"]) == heldout_work_id
        )
        base_indices = non_direct[array_work_ids[non_direct] != heldout_work_id]
        heldout_base_indices = non_direct[array_work_ids[non_direct] == heldout_work_id]
        train_page = tuple(
            group
            for group in discriminative
            if str(group["work_id"]) != heldout_work_id
        )
        heldout_page = tuple(
            group
            for group in discriminative
            if str(group["work_id"]) == heldout_work_id
        )
        all_gradient = np.sort(
            np.concatenate(
                (
                    base_indices,
                    np.asarray(
                        [row["row_index"] for row in train_rows], dtype=np.int64
                    ),
                )
            )
        )
        contract = _fold_contract(
            fold_index=fold_index,
            heldout_work_id=heldout_work_id,
            train_rows=train_rows,
            heldout_rows=heldout_rows,
            base_indices=base_indices,
            all_gradient_indices=all_gradient,
            heldout_base_indices=heldout_base_indices,
            train_page_groups=train_page,
            heldout_page_groups=heldout_page,
        )
        folds.append(
            {
                "all_gradient_indices": all_gradient,
                "base_indices": base_indices,
                "contract": contract,
                "heldout_base_indices": heldout_base_indices,
                "heldout_page_groups": heldout_page,
                "heldout_rows": heldout_rows,
                "heldout_work_id": heldout_work_id,
                "train_page_groups": train_page,
                "train_rows": train_rows,
            }
        )
    return tuple(folds)


def _schedule_seed(*, seed: int, heldout_work_id: str, epoch: int, phase: str) -> int:
    digest = hashlib.sha256(
        f"manga-font-r23-logo\0{seed}\0{heldout_work_id}\0{epoch}\0{phase}".encode(
            "utf-8"
        )
    ).digest()
    return int.from_bytes(digest[:8], "big", signed=False)


def _direct_schedule(
    fold: Mapping[str, Any], args: argparse.Namespace, *, epoch: int
) -> tuple[np.ndarray, np.ndarray, Mapping[str, Any]]:
    rows = tuple(fold["train_rows"])
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    works = np.asarray([row["work_id"] for row in rows]).astype(str)
    labels = np.asarray([row["family_label"] for row in rows], dtype=np.int64)
    weights = np.asarray([row["supervision_weight"] for row in rows], dtype=np.float32)
    seed = _schedule_seed(
        seed=int(args.seed),
        heldout_work_id=str(fold["heldout_work_id"]),
        epoch=int(epoch),
        phase="direct",
    )
    try:
        batches, normalized, source = r1._direct_balanced_schedule(
            indices,
            works,
            labels,
            weights,
            balance_mode="work_family",
            batch_size=int(args.batch_size),
            seed=seed,
        )
    except r1.R1TrainingError as error:
        raise R23TrainingError(str(error)) from error
    order = np.concatenate(batches).astype(np.int64, copy=False)
    if sorted(order.tolist()) != list(range(len(rows))):
        raise R23TrainingError("direct schedule does not consume every row once")
    ordered_indices = indices[order]
    ordered_weights = normalized[order]
    strata = sorted(set(zip(works.tolist(), labels.tolist(), strict=True)))
    stratum_sums = [
        float(
            np.sum(normalized[(works == work) & (labels == family)], dtype=np.float32)
        )
        for work, family in strata
    ]
    if (
        int(source["stratum_count"]) != 18
        or len(strata) != 18
        or any(value != 1.0 for value in stratum_sums)
        or float(np.sum(normalized, dtype=np.float32)) != 18.0
    ):
        raise R23TrainingError("work-family normalized weight inventory drifted")
    contract = {
        **source,
        "active_fold_denominator": 18,
        "optimizer_calls": 1,
        "ordered_base_row_index_sha256": _index_sha256(ordered_indices),
        "schedule_seed": int(seed),
        "unique_rows": int(len(ordered_indices)),
    }
    return order, ordered_weights, contract


def _base_schedule(
    fold: Mapping[str, Any], args: argparse.Namespace, *, epoch: int
) -> tuple[np.ndarray, Mapping[str, Any]]:
    indices = np.asarray(fold["base_indices"], dtype=np.int64)
    ordered = np.array(indices, copy=True)
    seed = _schedule_seed(
        seed=int(args.seed),
        heldout_work_id=str(fold["heldout_work_id"]),
        epoch=int(epoch),
        phase="base",
    )
    np.random.default_rng(seed).shuffle(ordered)
    return ordered, {
        "algorithm": "logo_non_direct_unique_shuffle_single_accumulated_step_v1",
        "optimizer_calls": 1,
        "ordered_base_row_index_sha256": _index_sha256(ordered),
        "schedule_seed": int(seed),
        "unique_rows": int(len(ordered)),
    }


def _tier_tensors(
    torch: Any,
    rows: Sequence[Mapping[str, Any]],
    *,
    device: Any,
) -> Mapping[str, Any]:
    if not rows:
        raise R23TrainingError("candidate tier row batch is empty")
    return {
        "family_labels": torch.as_tensor(
            [row["family_label"] for row in rows], dtype=torch.long, device=device
        ),
        "marginal_mask": torch.as_tensor(
            np.stack([row["marginal_mask"] for row in rows]),
            dtype=torch.bool,
            device=device,
        ),
        "preferred_mask": torch.as_tensor(
            np.stack([row["preferred_mask"] for row in rows]),
            dtype=torch.bool,
            device=device,
        ),
        "safe_mask": torch.as_tensor(
            np.stack([row["safe_mask"] for row in rows]),
            dtype=torch.bool,
            device=device,
        ),
        "single_day_safety_negative": torch.as_tensor(
            [row["single_day_safety_negative"] for row in rows],
            dtype=torch.bool,
            device=device,
        ),
        "unacceptable_mask": torch.as_tensor(
            np.stack([row["unacceptable_mask"] for row in rows]),
            dtype=torch.bool,
            device=device,
        ),
    }


def _routed_scores(outputs: Mapping[str, Any], family_labels: Any) -> Any:
    return __import__("torch").where(
        family_labels[:, None] == v8.BODY_FAMILY_INDEX,
        outputs["body_candidate_scores"],
        outputs["variant_candidate_scores"],
    )


def candidate_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    outputs = candidate_outputs_from_cache(torch, model, cache, indices)
    tensors = _tier_tensors(torch, rows, device=cache["hidden"].device)
    scores = _routed_scores(outputs, tensors["family_labels"])
    top1 = scores.argmax(dim=1)
    safe_hit = tensors["safe_mask"].gather(1, top1[:, None]).squeeze(1)
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred_hit = tensors["preferred_mask"].gather(1, top1[:, None]).squeeze(1)
    marginal_hit = tensors["marginal_mask"].gather(1, top1[:, None]).squeeze(1)
    unacceptable_hit = tensors["unacceptable_mask"].gather(1, top1[:, None]).squeeze(1)
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    unreviewed_hit = ~reviewed.gather(1, top1[:, None]).squeeze(1)
    single_day_index = tuple(candidate_ids).index("single-day")
    unreviewed_hit = unreviewed_hit & (top1 != single_day_index)
    unsafe = tensors["single_day_safety_negative"]
    unsafe_sd_hit = unsafe & (top1 == single_day_index)

    def summarize(positions: Any) -> Mapping[str, Any]:
        count = int(positions.sum().item())
        if count < 1:
            raise R23TrainingError("candidate metric slice is empty")
        selected_preferred = preferred_rows & positions
        preferred_count = int(selected_preferred.sum().item())
        return {
            "marginal_top1_rate": float(marginal_hit[positions].float().mean().item()),
            "ordinary_unreviewed_top1_rate": float(
                unreviewed_hit[positions].float().mean().item()
            ),
            "preferred_row_count": preferred_count,
            "preferred_top1_accuracy": float(
                preferred_hit[selected_preferred].float().mean().item()
            )
            if preferred_count
            else 0.0,
            "row_count": count,
            "safe_top1_accuracy": float(safe_hit[positions].float().mean().item()),
            "single_day_unsafe_top1_rate": float(
                unsafe_sd_hit[positions].sum().item()
                / max(1, int(unsafe[positions].sum().item()))
            ),
            "unacceptable_top1_rate": float(
                unacceptable_hit[positions].float().mean().item()
            ),
        }

    all_positions = torch.ones(len(rows), dtype=torch.bool, device=top1.device)
    row_metrics = summarize(all_positions)
    works: dict[str, list[int]] = defaultdict(list)
    for position, row in enumerate(rows):
        works[str(row["work_id"])].append(position)
    per_work: dict[str, Mapping[str, Any]] = {}
    for work_id, positions in sorted(works.items()):
        selected = torch.zeros(len(rows), dtype=torch.bool, device=top1.device)
        selected[torch.as_tensor(positions, dtype=torch.long, device=top1.device)] = (
            True
        )
        per_work[work_id] = summarize(selected)
    macro_keys = (
        "marginal_top1_rate",
        "ordinary_unreviewed_top1_rate",
        "preferred_top1_accuracy",
        "safe_top1_accuracy",
        "single_day_unsafe_top1_rate",
        "unacceptable_top1_rate",
    )
    work_macro = {
        key: float(np.mean([value[key] for value in per_work.values()]))
        for key in macro_keys
    }
    work_macro.update({"per_work": per_work, "work_count": len(per_work)})
    return {"row": row_metrics, "work_macro": work_macro}


def _page_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    groups: Sequence[Mapping[str, Any]],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    if not groups:
        raise R23TrainingError("page metric group slice is empty")
    indices = np.concatenate([group["row_indices"] for group in groups]).astype(
        np.int64, copy=False
    )
    outputs = candidate_outputs_from_cache(torch, model, cache, indices)
    try:
        full = r0.page_v3.overlay_metrics(
            torch,
            {
                name: outputs[name]
                for name in (
                    "body_candidate_scores",
                    "family_logits",
                    "variant_candidate_scores",
                )
            },
            groups=groups,
            candidate_ids=candidate_ids,
        )
    except r0.page_v3.PageConsistencyTrainingError as error:
        raise R23TrainingError(str(error)) from error
    return {
        key: full[key]
        for key in (
            "all_rows_top1_in_common_positive_rate",
            "group_count",
            "mean_body_probability",
            "mean_common_positive_mass",
            "mean_js",
            "predicted_body_rate",
            "row_count",
            "top1_all_agree_rate",
        )
    }


def evaluate_base_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    indices = np.flatnonzero(arrays["split"].astype(np.int64, copy=False) == 1)
    outputs = candidate_outputs_from_cache(torch, model, cache, indices)
    device = cache["hidden"].device
    labels = torch.as_tensor(
        arrays["family_labels"][indices].astype(np.int64), device=device
    )
    positives = torch.as_tensor(arrays["positive_mask"][indices], device=device)
    preferred = torch.as_tensor(arrays["preferred_mask"][indices], device=device)
    weights = torch.as_tensor(
        arrays["font_supervision_weights"][indices].astype(np.float32), device=device
    )
    negative = torch.as_tensor(
        arrays["single_day_body_negative"][indices], device=device
    )
    metric_outputs = {
        name: outputs[name]
        for name in (
            "body_candidate_scores",
            "family_logits",
            "variant_candidate_scores",
        )
    }
    metrics = v8.compute_metrics(
        torch,
        metric_outputs,
        family_labels=labels,
        positive_mask=positives,
        preferred_mask=preferred,
        font_supervision_weights=weights,
        single_day_body_negative=negative,
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )
    authorities = arrays["font_authority"][indices].astype(str)
    visual_positions = np.flatnonzero(authorities == "visual")
    selected = torch.as_tensor(visual_positions, dtype=torch.long, device=device)
    visual_outputs = {name: value[selected] for name, value in metric_outputs.items()}
    visual = v8.compute_metrics(
        torch,
        visual_outputs,
        family_labels=labels[selected],
        positive_mask=positives[selected],
        preferred_mask=preferred[selected],
        font_supervision_weights=weights[selected],
        single_day_body_negative=negative[selected],
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )
    checks = v8.build_quality_gate_checks(metrics, visual)
    return {
        "all": dict(metrics),
        "quality_checks": checks,
        "quality_gate_passed": bool(all(checks.values())),
        "visual": dict(visual),
    }


def _head_delta_metrics(
    model: Any, anchor_state: Mapping[str, Any]
) -> Mapping[str, Any]:
    current = _sidecar_state(model)
    deltas = [
        (current[name] - anchor_state[name]).float().reshape(-1)
        for name in TRAINABLE_NAMES
    ]
    flattened = __import__("torch").cat(deltas)
    return {
        "l2": float(flattened.square().sum().sqrt().item()),
        "maximum_absolute": float(flattened.abs().max().item()),
        "mean_absolute": float(flattened.abs().mean().item()),
        "parameter_count": int(flattened.numel()),
    }


def _candidate_kl(torch: Any, candidate_scores: Any, anchor_scores: Any) -> Any:
    return torch.nn.functional.kl_div(
        torch.log_softmax(candidate_scores.float(), dim=1),
        torch.softmax(anchor_scores.float(), dim=1),
        reduction="batchmean",
    )


def _direct_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    fold: Mapping[str, Any],
    args: argparse.Namespace,
    epoch: int,
) -> Mapping[str, Any]:
    order, normalized_weights, schedule = _direct_schedule(fold, args, epoch=epoch)
    source_rows = tuple(fold["train_rows"])
    rows = tuple(source_rows[int(position)] for position in order.tolist())
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    outputs = candidate_outputs_from_cache(torch, model, cache, indices)
    device = cache["hidden"].device
    tensors = _tier_tensors(torch, rows, device=device)
    row_weights = torch.as_tensor(
        normalized_weights, dtype=torch.float32, device=device
    )
    routed = _routed_scores(outputs, tensors["family_labels"])
    candidate_loss, parts = weighted_candidate_set_loss(
        torch,
        routed,
        preferred_mask=tensors["preferred_mask"],
        safe_mask=tensors["safe_mask"],
        marginal_mask=tensors["marginal_mask"],
        unacceptable_mask=tensors["unacceptable_mask"],
        single_day_safety_negative=tensors["single_day_safety_negative"],
        marginal_weight=MARGINAL_MODES[args.marginal_mode],
        row_weights=row_weights,
    )
    safety = _single_day_safety_losses(
        torch,
        outputs,
        safe_mask=tensors["safe_mask"],
        family_labels=tensors["family_labels"],
        safety_negative=tensors["single_day_safety_negative"],
        row_weights=row_weights,
        single_day_index=tuple(cache["candidate_ids"]).index("single-day"),
    )
    residual_l2 = outputs["sample_candidate_residual_delta"].float().square().mean()
    total = (
        float(args.direct_candidate_weight) * candidate_loss
        + SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT * safety["body_hard_negative"]
        + SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
        * safety["supervised_hard_negative"]
        + float(args.direct_residual_l2_weight) * residual_l2
    )
    if not bool(torch.isfinite(total)):
        raise R23TrainingError("direct candidate loss became non-finite")
    optimizer.zero_grad(set_to_none=True)
    total.backward()
    torch.nn.utils.clip_grad_norm_(
        tuple(value for value in model.parameters() if value.requires_grad),
        float(args.gradient_clip),
    )
    optimizer.step()
    return {
        "loss": {
            "candidate_core": float(candidate_loss.detach().item()),
            "candidate_distribution_excess": 0.0,
            "preferred_set_nll": float(parts["preferred_set_nll"].detach().item()),
            "residual_delta_l2": float(residual_l2.detach().item()),
            "safe_set_nll": float(parts["safe_set_nll"].detach().item()),
            "single_day_body_hard_negative": float(
                safety["body_hard_negative"].detach().item()
            ),
            "single_day_supervised_hard_negative": float(
                safety["supervised_hard_negative"].detach().item()
            ),
            "total": float(total.detach().item()),
        },
        "schedule": schedule,
    }


def _base_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    fold: Mapping[str, Any],
    args: argparse.Namespace,
    epoch: int,
) -> Mapping[str, Any]:
    indices, schedule = _base_schedule(fold, args, epoch=epoch)
    outputs = candidate_outputs_from_cache(torch, model, cache, indices)
    positions = torch.as_tensor(
        indices, dtype=torch.long, device=cache["hidden"].device
    )
    body_kl = _candidate_kl(
        torch,
        outputs["body_candidate_scores"],
        cache["body_candidate_scores"][positions],
    ).clamp_min(0.0)
    variant_kl = _candidate_kl(
        torch,
        outputs["variant_candidate_scores"],
        cache["variant_candidate_scores"][positions],
    ).clamp_min(0.0)
    anchor_kl = 0.5 * (body_kl + variant_kl)
    residual_l2 = outputs["sample_candidate_residual_delta"].float().square().mean()
    total = (
        float(args.anchor_kl_weight) * anchor_kl
        + float(args.base_residual_l2_weight) * residual_l2
    )
    if not bool(torch.isfinite(total)):
        raise R23TrainingError("base candidate preservation loss became non-finite")
    optimizer.zero_grad(set_to_none=True)
    total.backward()
    torch.nn.utils.clip_grad_norm_(
        tuple(value for value in model.parameters() if value.requires_grad),
        float(args.gradient_clip),
    )
    optimizer.step()
    return {
        "loss": {
            "anchor_candidate_kl": float(anchor_kl.detach().item()),
            "body_candidate_kl": float(body_kl.detach().item()),
            "residual_delta_l2": float(residual_l2.detach().item()),
            "total": float(total.detach().item()),
            "variant_candidate_kl": float(variant_kl.detach().item()),
        },
        "schedule": schedule,
    }


def _training_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    fold: Mapping[str, Any],
    candidate_ids: Sequence[str],
    anchor_state: Mapping[str, Any],
) -> Mapping[str, Any]:
    return {
        "candidate": candidate_metrics(
            torch,
            model,
            cache=cache,
            rows=fold["train_rows"],
            candidate_ids=candidate_ids,
        ),
        "head_delta": _head_delta_metrics(model, anchor_state),
        "page_consistency": _page_metrics(
            torch,
            model,
            cache=cache,
            groups=fold["train_page_groups"],
            candidate_ids=candidate_ids,
        ),
    }


def _base_regression(
    anchor: Mapping[str, Any],
    candidate: Mapping[str, Any],
    args: argparse.Namespace,
) -> Mapping[str, bool]:
    try:
        return r0.page_v3.base_regression_checks(
            anchor,
            candidate,
            maximum_acceptable_regression=float(args.maximum_acceptable_regression),
            maximum_preferred_regression=float(args.maximum_preferred_regression),
            maximum_family_regression=float(args.maximum_family_regression),
        )
    except r0.page_v3.PageConsistencyTrainingError as error:
        raise R23TrainingError(str(error)) from error


def _metric_at_least(value: float, threshold: float) -> bool:
    return float(value) > float(threshold) or math.isclose(
        float(value),
        float(threshold),
        rel_tol=0.0,
        abs_tol=METRIC_GATE_ABSOLUTE_TOLERANCE,
    )


def _metric_at_most(value: float, threshold: float) -> bool:
    return float(value) < float(threshold) or math.isclose(
        float(value),
        float(threshold),
        rel_tol=0.0,
        abs_tol=METRIC_GATE_ABSOLUTE_TOLERANCE,
    )


def _training_deltas(
    anchor: Mapping[str, Any], candidate: Mapping[str, Any]
) -> Mapping[str, float]:
    anchor_work = anchor["candidate"]["work_macro"]
    candidate_work = candidate["candidate"]["work_macro"]
    return {
        key: float(candidate_work[key]) - float(anchor_work[key])
        for key in (
            "preferred_top1_accuracy",
            "safe_top1_accuracy",
            "single_day_unsafe_top1_rate",
            "unacceptable_top1_rate",
        )
    }


def _diagnostic_checks(
    *,
    anchor_training: Mapping[str, Any],
    candidate_training: Mapping[str, Any],
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    family_logits_exact: bool,
    frozen_tensors_exact: bool,
) -> Mapping[str, bool]:
    delta = _training_deltas(anchor_training, candidate_training)
    anchor_page = anchor_training["page_consistency"]
    candidate_page = candidate_training["page_consistency"]
    return {
        "base_no_material_regression": bool(all(base_regression.values())),
        "base_quality_gate_passed": bool(base_metrics["quality_gate_passed"]),
        "family_logits_exact_anchor": bool(family_logits_exact),
        "frozen_13_tensor_inventory_exact_anchor": bool(frozen_tensors_exact),
        "page_common_positive_top1_nonregression": _metric_at_least(
            float(candidate_page["all_rows_top1_in_common_positive_rate"]),
            float(anchor_page["all_rows_top1_in_common_positive_rate"]),
        ),
        "page_top1_all_agree_nonregression": _metric_at_least(
            float(candidate_page["top1_all_agree_rate"]),
            float(anchor_page["top1_all_agree_rate"]),
        ),
        "train_preferred_top1_nonregression": _metric_at_least(
            delta["preferred_top1_accuracy"], 0.0
        ),
        "train_safe_top1_nonregression": _metric_at_least(
            delta["safe_top1_accuracy"], 0.0
        ),
        "train_single_day_unsafe_top1_nonincrease": _metric_at_most(
            delta["single_day_unsafe_top1_rate"], 0.0
        ),
        "train_unacceptable_top1_nonincrease": _metric_at_most(
            delta["unacceptable_top1_rate"], 0.0
        ),
    }


def _selection_key(record: Mapping[str, Any]) -> tuple[float, ...]:
    epoch = int(record["epoch"])
    deltas = record["training_only_deltas"]
    joint = min(
        float(deltas["safe_top1_accuracy"]),
        float(deltas["preferred_top1_accuracy"]),
    )
    eligible = epoch == 0 or bool(record["diagnostic_gate_passed"] and joint > 0.0)
    candidate = record["training_only_metrics"]["candidate"]["work_macro"]
    return (
        float(eligible),
        float(joint),
        float(deltas["safe_top1_accuracy"]),
        float(deltas["preferred_top1_accuracy"]),
        -float(candidate["single_day_unsafe_top1_rate"]),
        -float(candidate["unacceptable_top1_rate"]),
        float(r0.page_v3._base_selection_score(record["base_metrics"])),
        -float(record["training_only_metrics"]["head_delta"]["mean_absolute"]),
        -float(epoch),
    )


SELECTION_KEY_ORDER = (
    "eligible_epoch0_or_positive_joint_with_all_safety",
    "training_work_macro_joint_min_safe_preferred_delta",
    "training_work_macro_safe_top1_delta",
    "training_work_macro_preferred_top1_delta",
    "negative_training_work_macro_single_day_unsafe_top1_rate",
    "negative_training_work_macro_unacceptable_top1_rate",
    "external_r3_base_validation_score",
    "negative_mean_absolute_final_head_delta",
    "earlier_epoch",
)


def _snapshot_record(
    torch: Any,
    model: Any,
    *,
    epoch: int,
    phase_boundary: str,
    selectable: bool,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    fold: Mapping[str, Any],
    candidate_ids: Sequence[str],
    anchor_state: Mapping[str, Any],
    anchor_frozen_inventory: Mapping[str, Any],
    anchor_base: Mapping[str, Any],
    anchor_training: Mapping[str, Any],
    args: argparse.Namespace,
    phase_losses: Mapping[str, Any] | None,
    consumption: Mapping[str, Any],
) -> Mapping[str, Any]:
    base = evaluate_base_metrics(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    regression = _base_regression(anchor_base, base, args)
    training = _training_metrics(
        torch,
        model,
        cache=cache,
        fold=fold,
        candidate_ids=candidate_ids,
        anchor_state=anchor_state,
    )
    indices = np.asarray(fold["all_gradient_indices"], dtype=np.int64)
    outputs = candidate_outputs_from_cache(torch, model, cache, indices)
    positions = torch.as_tensor(
        indices, dtype=torch.long, device=cache["hidden"].device
    )
    family_exact = torch.equal(
        outputs["family_logits"], cache["family_logits"][positions]
    )
    frozen_exact = _frozen_tensor_inventory(model) == anchor_frozen_inventory
    checks = _diagnostic_checks(
        anchor_training=anchor_training,
        candidate_training=training,
        base_metrics=base,
        base_regression=regression,
        family_logits_exact=family_exact,
        frozen_tensors_exact=frozen_exact,
    )
    deltas = _training_deltas(anchor_training, training)
    payload = _state_payload(_sidecar_state(model))
    record: dict[str, Any] = {
        "base_metrics": base,
        "base_no_material_regression": bool(all(regression.values())),
        "base_regression_checks": regression,
        "batch_consumption": dict(consumption),
        "checkpoint_selection_inputs": (
            [
                "fold_train_candidate_tiers",
                "fold_train_discriminative_page_metrics",
                "external_r3_base_validation",
            ]
            if selectable
            else []
        ),
        "development_eval_consulted": False,
        "diagnostic_checks": checks,
        "diagnostic_gate_passed": bool(all(checks.values())),
        "epoch": int(epoch),
        "family_logits_exact_anchor": bool(family_exact),
        "frozen_13_tensor_inventory_exact_anchor": bool(frozen_exact),
        "heldout_work_consulted": False,
        "phase_boundary": str(phase_boundary),
        "selectable_for_checkpoint": bool(selectable),
        "sidecar_state": payload,
        "sidecar_state_sha256": _payload_sha256(payload),
        "training_only_deltas": deltas,
        "training_only_metrics": training,
    }
    if phase_losses is not None:
        record["phase_losses"] = dict(phase_losses)
    record["selection_key"] = list(_selection_key(record)) if selectable else None
    return record


def _zero_consumption() -> Mapping[str, Any]:
    return {
        "base_optimizer_calls": 0,
        "base_rows": 0,
        "base_schedule": None,
        "development_rows": 0,
        "direct_optimizer_calls": 0,
        "direct_rows": 0,
        "direct_schedule": None,
        "heldout_rows_consulted": 0,
        "optimizer_phase_order_completed": [],
        "page_optimizer_calls": 0,
        "page_rows": 0,
    }


def _phase_consumption(
    fold: Mapping[str, Any],
    *,
    direct: Mapping[str, Any],
    base: Mapping[str, Any] | None = None,
) -> Mapping[str, Any]:
    base_complete = base is not None
    return {
        "base_optimizer_calls": int(base_complete),
        "base_rows": int(len(fold["base_indices"])) if base_complete else 0,
        "base_schedule": dict(base["schedule"]) if base_complete else None,
        "development_rows": 0,
        "direct_optimizer_calls": 1,
        "direct_rows": int(len(fold["train_rows"])),
        "direct_schedule": dict(direct["schedule"]),
        "heldout_rows_consulted": 0,
        "optimizer_phase_order_completed": (
            ["direct_candidate", "base_preservation"]
            if base_complete
            else ["direct_candidate"]
        ),
        "page_optimizer_calls": 0,
        "page_rows": 0,
    }


def _heldout_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    fold: Mapping[str, Any],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    return {
        "candidate": candidate_metrics(
            torch,
            model,
            cache=cache,
            rows=fold["heldout_rows"],
            candidate_ids=candidate_ids,
        ),
        "page_consistency": _page_metrics(
            torch,
            model,
            cache=cache,
            groups=fold["heldout_page_groups"],
            candidate_ids=candidate_ids,
        ),
    }


def _heldout_report(
    *,
    fold: Mapping[str, Any],
    selected_epoch: int,
    anchor: Mapping[str, Any],
    candidate: Mapping[str, Any],
    selected_record: Mapping[str, Any],
) -> Mapping[str, Any]:
    anchor_work = anchor["candidate"]["work_macro"]
    candidate_work = candidate["candidate"]["work_macro"]
    deltas = {
        key: float(candidate_work[key]) - float(anchor_work[key])
        for key in (
            "preferred_top1_accuracy",
            "safe_top1_accuracy",
            "single_day_unsafe_top1_rate",
            "unacceptable_top1_rate",
        )
    }
    anchor_page = anchor["page_consistency"]
    candidate_page = candidate["page_consistency"]
    checks = {
        "base_no_material_regression": bool(
            selected_record["base_no_material_regression"]
        ),
        "base_quality_gate_passed": bool(
            selected_record["base_metrics"]["quality_gate_passed"]
        ),
        "family_logits_exact_anchor": bool(
            selected_record["family_logits_exact_anchor"]
        ),
        "frozen_13_tensor_inventory_exact_anchor": bool(
            selected_record["frozen_13_tensor_inventory_exact_anchor"]
        ),
        "heldout_page_common_positive_nonregression": _metric_at_least(
            float(candidate_page["all_rows_top1_in_common_positive_rate"]),
            float(anchor_page["all_rows_top1_in_common_positive_rate"]),
        ),
        "heldout_page_top1_all_agree_nonregression": _metric_at_least(
            float(candidate_page["top1_all_agree_rate"]),
            float(anchor_page["top1_all_agree_rate"]),
        ),
        "heldout_single_day_unsafe_top1_nonincrease": _metric_at_most(
            deltas["single_day_unsafe_top1_rate"], 0.0
        ),
        "heldout_unacceptable_top1_nonincrease": _metric_at_most(
            deltas["unacceptable_top1_rate"], 0.0
        ),
    }
    return {
        "anchor": anchor,
        "candidate": candidate,
        "checks": checks,
        "deltas": deltas,
        "fold_index": int(fold["contract"]["fold_index"]),
        "heldout_consulted_after_fold_winner_only": True,
        "heldout_used_for_fold_epoch_selection": False,
        "heldout_work_id": str(fold["heldout_work_id"]),
        "selected_epoch": int(selected_epoch),
    }


def _train_one_fold(
    torch: Any,
    *,
    context: Mapping[str, Any],
    fold: Mapping[str, Any],
    cache: Mapping[str, Any],
    evaluation_cache: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    candidate_ids = tuple(context["candidate_ids"])
    model = build_candidate_model(context, cache["hidden"].device)
    evaluation_model = build_candidate_model(context, evaluation_cache["hidden"].device)
    assert_epoch0_exact(torch, model, cache)
    assert_epoch0_exact(torch, evaluation_model, evaluation_cache)
    anchor_state = _sidecar_state(model)
    if _state_payload(anchor_state) != _state_payload(_sidecar_state(evaluation_model)):
        raise R23TrainingError("training and evaluation anchor states drifted")
    anchor_frozen = _frozen_tensor_inventory(evaluation_model)
    anchor_base = evaluate_base_metrics(
        torch,
        evaluation_model,
        cache=evaluation_cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    anchor_training = _training_metrics(
        torch,
        evaluation_model,
        cache=evaluation_cache,
        fold=fold,
        candidate_ids=candidate_ids,
        anchor_state=anchor_state,
    )
    history = [
        _snapshot_record(
            torch,
            evaluation_model,
            epoch=0,
            phase_boundary="exact_anchor_sentinel",
            selectable=True,
            cache=evaluation_cache,
            context=context,
            fold=fold,
            candidate_ids=candidate_ids,
            anchor_state=anchor_state,
            anchor_frozen_inventory=anchor_frozen,
            anchor_base=anchor_base,
            anchor_training=anchor_training,
            args=args,
            phase_losses=None,
            consumption=_zero_consumption(),
        )
    ]
    phase_diagnostics: list[Mapping[str, Any]] = []
    optimizer = torch.optim.AdamW(
        [value for value in model.parameters() if value.requires_grad],
        lr=float(args.learning_rate),
        weight_decay=float(args.weight_decay),
    )
    for epoch in range(1, int(args.epochs) + 1):
        direct = _direct_step(
            torch,
            model,
            optimizer,
            cache=cache,
            fold=fold,
            args=args,
            epoch=epoch,
        )
        _apply_sidecar_state(evaluation_model, _sidecar_state(model))
        direct_record = _snapshot_record(
            torch,
            evaluation_model,
            epoch=epoch,
            phase_boundary="after_direct_candidate_diagnostic_only",
            selectable=False,
            cache=evaluation_cache,
            context=context,
            fold=fold,
            candidate_ids=candidate_ids,
            anchor_state=anchor_state,
            anchor_frozen_inventory=anchor_frozen,
            anchor_base=anchor_base,
            anchor_training=anchor_training,
            args=args,
            phase_losses={"direct": direct["loss"]},
            consumption=_phase_consumption(fold, direct=direct),
        )
        phase_diagnostics.append(direct_record)
        base = _base_step(
            torch,
            model,
            optimizer,
            cache=cache,
            fold=fold,
            args=args,
            epoch=epoch,
        )
        _apply_sidecar_state(evaluation_model, _sidecar_state(model))
        history.append(
            _snapshot_record(
                torch,
                evaluation_model,
                epoch=epoch,
                phase_boundary="after_base_preservation_selectable",
                selectable=True,
                cache=evaluation_cache,
                context=context,
                fold=fold,
                candidate_ids=candidate_ids,
                anchor_state=anchor_state,
                anchor_frozen_inventory=anchor_frozen,
                anchor_base=anchor_base,
                anchor_training=anchor_training,
                args=args,
                phase_losses={"base": base["loss"], "direct": direct["loss"]},
                consumption=_phase_consumption(fold, direct=direct, base=base),
            )
        )
    best_index = 0
    best_key = _selection_key(history[0])
    for index, record in enumerate(history[1:], 1):
        key = _selection_key(record)
        if key > best_key:
            best_index, best_key = index, key
    selected = history[best_index]
    selected_epoch = int(selected["epoch"])
    selected_state = _state_from_payload(torch, selected["sidecar_state"])
    _apply_sidecar_state(evaluation_model, anchor_state)
    anchor_heldout = _heldout_metrics(
        torch,
        evaluation_model,
        cache=evaluation_cache,
        fold=fold,
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(evaluation_model, selected_state)
    selected_heldout = _heldout_metrics(
        torch,
        evaluation_model,
        cache=evaluation_cache,
        fold=fold,
        candidate_ids=candidate_ids,
    )
    report = _heldout_report(
        fold=fold,
        selected_epoch=selected_epoch,
        anchor=anchor_heldout,
        candidate=selected_heldout,
        selected_record=selected,
    )
    return (
        {
            "anchor_base_metrics": anchor_base,
            "anchor_training_metrics": anchor_training,
            "heldout_postselection": report,
            "history": history,
            "partition": fold["contract"],
            "phase_diagnostics": phase_diagnostics,
            "selected_base_metrics": selected["base_metrics"],
            "selected_epoch": selected_epoch,
            "selected_training_metrics": selected["training_only_metrics"],
            "selection": {
                "anchor_fallback_selected": selected_epoch == 0,
                "best_epoch": selected_epoch,
                "development_eval_consulted": False,
                "heldout_consulted_for_selection": False,
                "page_optimizer_calls": 0,
                "post_base_states_only_selectable": True,
                "selection_key": list(best_key),
                "selection_key_order": list(SELECTION_KEY_ORDER),
            },
            "sidecar_file": _sidecar_name(int(fold["contract"]["fold_index"])),
            "trajectory_replayed_by_strict_validator": False,
        },
        selected_state,
    )


def _aggregate_logo_metrics(
    reports: Sequence[Mapping[str, Any]],
    *,
    control_contract: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    ordered = sorted(reports, key=lambda value: int(value["fold_index"]))
    if len(ordered) != FOLD_COUNT or [
        int(value["fold_index"]) for value in ordered
    ] != list(range(FOLD_COUNT)):
        raise R23TrainingError("LOGO heldout report inventory drifted")
    delta_keys = (
        "preferred_top1_accuracy",
        "safe_top1_accuracy",
        "single_day_unsafe_top1_rate",
        "unacceptable_top1_rate",
    )
    macro = {
        key: float(np.mean([float(report["deltas"][key]) for report in ordered]))
        for key in delta_keys
    }
    worst_safe = min(
        float(report["deltas"]["safe_top1_accuracy"]) for report in ordered
    )
    safety_checks = {
        "all_fold_base_page_family_and_frozen_checks_passed": all(
            all(bool(value) for value in report["checks"].values())
            for report in ordered
        ),
        "oof_single_day_unsafe_top1_nonincrease": _metric_at_most(
            macro["single_day_unsafe_top1_rate"], 0.0
        ),
        "oof_unacceptable_top1_nonincrease": _metric_at_most(
            macro["unacceptable_top1_rate"], 0.0
        ),
        "worst_heldout_work_safe_top1_delta_at_least_negative_0_05": (
            _metric_at_least(worst_safe, -0.05)
        ),
    }
    absolute_checks = {
        **safety_checks,
        "heldout_work_macro_preferred_top1_improved_by_0_02": _metric_at_least(
            macro["preferred_top1_accuracy"], 0.02
        ),
        "heldout_work_macro_safe_top1_improved_by_0_02": _metric_at_least(
            macro["safe_top1_accuracy"], 0.02
        ),
    }
    joint = min(macro["preferred_top1_accuracy"], macro["safe_top1_accuracy"])
    continuation: Mapping[str, Any] | None
    if control_contract is None:
        continuation = None
    else:
        control_joint = float(control_contract["oof_joint_minimum"])
        improvement = float(joint - control_joint)
        continuation_checks = {
            **safety_checks,
            "joint_minimum_improved_over_isolated_lambda1_control_by_0_005": (
                _metric_at_least(improvement, CHALLENGER_MINIMUM_JOINT_IMPROVEMENT)
            ),
        }
        continuation = {
            "candidate_joint_minimum": float(joint),
            "checks": continuation_checks,
            "control_joint_minimum": control_joint,
            "control_manifest_record_sha256": control_contract[
                "manifest_record_sha256"
            ],
            "joint_minimum_improvement_over_control": improvement,
            "minimum_required_improvement": CHALLENGER_MINIMUM_JOINT_IMPROVEMENT,
            "passed": bool(all(continuation_checks.values())),
        }
    return {
        "checks": absolute_checks,
        "fold_count": FOLD_COUNT,
        "heldout_work_macro_delta": macro,
        "joint_minimum_safe_preferred_delta": float(joint),
        "logo_diagnostic_worth": bool(all(absolute_checks.values())),
        "pilot_continuation": continuation,
        "promotion_authority": False,
        "worst_heldout_work_safe_top1_delta": float(worst_safe),
    }


def _architecture_contract(
    model: Any, anchor_state: Mapping[str, Any]
) -> Mapping[str, Any]:
    trainable = _sidecar_state(model)
    return {
        "anchor_tensor_count": ANCHOR_TENSOR_COUNT,
        "candidate_branch_formula": (
            "anchor_branch_scores_plus_same_shape_tanh_current_linear_minus_tanh_frozen_anchor_linear"
        ),
        "cpu_runtime_benchmark_required_before_any_promotion": False,
        "family_logits_and_all_family_tensors_exact_anchor": True,
        "head_initialization": "exact_production_r3h_final_projection_not_zero",
        "nonzero_current_branch_exact_direct_replacement_formula": True,
        "runtime_added_multiply_accumulates_per_row": 0,
        "runtime_added_parameters": 0,
        "runtime_multiply_accumulate_ratio": 1.0,
        "runtime_parameter_ratio": 1.0,
        "sidecar_semantics": "replacement_bytes_for_existing_runtime_projection",
        "sidecar_tensor_count": len(trainable),
        "trainable_parameter_count": TRAINABLE_PARAMETER_COUNT,
        "trainable_tensor_names": list(TRAINABLE_NAMES),
        "training_cache_hidden": (
            "frozen_sample_candidate_norm_then_existing_Linear1024x64_then_GELU"
        ),
        "training_cache_anchor_outputs": "cpu_authority_then_tensor_transfer",
        "training_gradient_device": "sealed_configuration_device",
        "training_metric_and_checkpoint_selection_device": "cpu_authority",
        "training_epoch_zero_exact_probe_sizes": list(EPOCH_ZERO_PROBE_SIZES)
        + ["full"],
        "training_residual_parameterization": (
            "same_shape_device_direct_current_and_frozen_anchor_linear"
        ),
        "epoch0_state_sha256": _payload_sha256(_state_payload(anchor_state)),
    }


def _objective_contract(
    args: argparse.Namespace,
    ledger: Mapping[str, Any],
    folds: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    return {
        "base_preservation": {
            "candidate_kl_weight": float(args.anchor_kl_weight),
            "candidate_kl_scope": "fold_non_direct_base_rows_only",
            "direct_row_intersection": 0,
            "one_accumulated_optimizer_call_per_epoch": True,
            "residual_delta_l2_weight": float(args.base_residual_l2_weight),
        },
        "candidate_distribution_excess": {
            "enabled": False,
            "weight": 0.0,
        },
        "direct_candidate": {
            "fixed_single_day_body_hard_negative_weight": (
                SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT
            ),
            "fixed_single_day_supervised_hard_negative_weight": (
                SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
            ),
            "formula": (
                "0.35*setNLL(safe,D_lambda)+0.65*setNLL(preferred,D_lambda)_preferred_rows_only"
            ),
            "marginal_lambda": float(MARGINAL_MODES[args.marginal_mode]),
            "marginal_mode": str(args.marginal_mode),
            "one_accumulated_optimizer_call_per_epoch": True,
            "residual_delta_l2_weight": float(args.direct_residual_l2_weight),
            "work_family_active_strata_per_fold": [
                int(fold["contract"]["active_work_family_strata_count"])
                for fold in folds
            ],
        },
        "ledger": dict(ledger["contract"]),
        "optimizer_phase_order": ["direct_candidate", "base_preservation"],
        "page": {
            "discriminative_metric_only_group_count": 68,
            "discriminative_metric_only_row_count": 148,
            "js_weight": 0.0,
            "optimizer_calls": 0,
            "future_js_0_01_requires_all_seed_confirmation": True,
        },
    }


def _experiment_contract() -> Mapping[str, Any]:
    return {
        "application_integration_allowed": False,
        "development_diagnostics": {
            "development_cache_outputs_paired_with_tiers": False,
            "development_candidate_metrics_computed": False,
            "development_outputs_used_for_checkpoint_selection": False,
            "development_outputs_used_for_gradient": False,
            "frozen_anchor_cache_materialized_for_all_base_rows": True,
            "gradient_rows": 0,
            "sealed_rows": 305,
            "sealed_works": 3,
            "tier_sources_reconstructed_for_exact_inventory_only": True,
        },
        "first_screen": {
            "allowed_cells": list(MARGINAL_MODES),
            "page_js_weight": 0.0,
            "schedule_seed": INITIAL_SEED,
        },
        "later_confirmation": {
            "all_seeds_must_pass_before_page_js_0_01": True,
            "allowed_only_after_seed20260820_challenger_pass": True,
            "future_schedule_seeds": [20260821, 20260822],
        },
        "logo_scope_limitation": (
            "residual_supervision_logo_only_frozen_r3h_anchor_was_pretrained_on_base_npz_and_is_not_work_unseen"
        ),
        "metric_and_checkpoint_selection_cpu_authority": True,
        "page_render_or_replay_performed": False,
        "promotion_authority": False,
        "runtime_integration_performed": False,
        "ten_fold_sidecars_are_not_deployable_full_data_refits": True,
        "trajectory_authenticity_keyed": False,
        "trajectory_phase_transcript_authority": "sealed_producer_attestation_only",
        "trajectory_replayed_by_strict_validator": False,
    }


def _global_partition_contract(
    context: Mapping[str, Any],
    ledger: Mapping[str, Any],
    folds: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    development_works = tuple(
        str(value) for value in context["overlay_binding"]["development_eval_work_ids"]
    )
    all_base = r0._base_train_indices(context["arrays"], development_works)
    direct = np.asarray([row["row_index"] for row in ledger["train"]], dtype=np.int64)
    direct_set = set(direct.tolist())
    non_direct = np.asarray(
        [value for value in all_base.tolist() if int(value) not in direct_set],
        dtype=np.int64,
    )
    return {
        "all_base_index_sha256": _index_sha256(all_base),
        "all_base_rows": int(len(all_base)),
        "development_direct_rows": int(len(ledger["development_eval"])),
        "development_gradient_rows": 0,
        "direct_index_sha256": _index_sha256(direct),
        "direct_rows": int(len(direct)),
        "fold_count": int(len(folds)),
        "non_direct_index_sha256": _index_sha256(non_direct),
        "non_direct_intersection_direct": 0,
        "non_direct_rows": int(len(non_direct)),
        "non_direct_union_direct_equals_all_base": bool(
            set(non_direct.tolist()) | direct_set == set(all_base.tolist())
        ),
        "work_universe": [str(fold["heldout_work_id"]) for fold in folds],
    }


def _output_inventory_descriptor(root: Path) -> Mapping[str, Any]:
    files = sorted(path for path in root.iterdir() if path.is_file())
    return {
        path.name: {"byte_size": int(path.stat().st_size), "sha256": sha256_file(path)}
        for path in files
    }


def _load_control_contract(control_dir: Path | None) -> Mapping[str, Any]:
    if control_dir is None:
        raise R23TrainingError("challenger requires exact isolated lambda1 control")
    expanded = control_dir.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R23TrainingError("control path is linked or reparsed")
    root = expanded.resolve()
    validation = validate_output(root)
    manifest = _read_json(root / MANIFEST_FILE, "lambda1 control manifest")
    configuration = _mapping(manifest["configuration"], "lambda1 control config")
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("producer") != _producer_binding()
        or configuration.get("marginal_mode") != "isolated_lambda1_control"
        or int(configuration.get("seed", -1)) != INITIAL_SEED
        or manifest["logo_aggregate"].get("pilot_continuation") is not None
    ):
        raise R23TrainingError("isolated lambda1 comparison control drifted")
    delta = manifest["logo_aggregate"]["heldout_work_macro_delta"]
    return {
        "artifact_role": "read_only_isolated_lambda1_comparison_control",
        "directory": str(root),
        "file_inventory": _output_inventory_descriptor(root),
        "manifest_record_sha256": str(manifest["record_sha256"]),
        "manifest_sha256": str(validation["manifest_sha256"]),
        "oof_joint_minimum": min(
            float(delta["preferred_top1_accuracy"]),
            float(delta["safe_top1_accuracy"]),
        ),
        "producer": dict(_producer_binding()),
        "schema_version": SCHEMA_VERSION,
    }


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise R23TrainingError("PyTorch is required") from error
    _validate_options(args)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise R23TrainingError("CUDA was requested but is unavailable")
    context = _load_context(args, torch)
    ledger = reconstruct_tier_ledger(args.source_label_dir, context, enforce_real=True)
    folds = build_logo_folds(context, ledger, enforce_real=True)
    evaluation_cache = build_candidate_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(args.evaluation_batch_size),
    )
    cache = transfer_candidate_cache(torch, cache=evaluation_cache, device=device)
    model = build_candidate_model(context, device)
    assert_epoch0_exact(torch, model, cache)
    anchor_state = _sidecar_state(model)
    order, weights, schedule = _direct_schedule(folds[0], args, epoch=1)
    base_order, base_schedule = _base_schedule(folds[0], args, epoch=1)
    return {
        "architecture": _architecture_contract(model, anchor_state),
        "configuration": _configuration(args),
        "control_artifact_required_at_train_time": (
            args.marginal_mode != "isolated_lambda1_control"
        ),
        "development_boundary": {
            "development_cache_outputs_paired_with_tiers": False,
            "development_candidate_metrics_computed": False,
            "development_outputs_used_for_checkpoint_selection": False,
            "development_outputs_used_for_gradient": False,
            "direct_rows": int(len(ledger["development_eval"])),
            "frozen_anchor_cache_materialized_for_all_base_rows": True,
            "gradient_rows": 0,
            "tier_sources_reconstructed_for_exact_inventory_only": True,
            "works": 3,
        },
        "experiment_contract": _experiment_contract(),
        "fold_partitions": [fold["contract"] for fold in folds],
        "global_partition": _global_partition_contract(context, ledger, folds),
        "objective_contract": _objective_contract(args, ledger, folds),
        "producer": _producer_binding(),
        "sample_fold_epoch1": {
            "base_order_sha256": _index_sha256(base_order),
            "base_schedule": base_schedule,
            "direct_order_sha256": _index_sha256(order),
            "direct_schedule": schedule,
            "direct_weight_sum": float(np.sum(weights, dtype=np.float32)),
        },
        "status": "ready_for_nonpromotable_r23_tristate_logo_training",
        "zero_epoch_exact_anchor": True,
    }


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover
        raise R23TrainingError("PyTorch and safetensors are required") from error
    _validate_options(args)
    output = _safe_new_output(args.output_dir)
    producer = _producer_binding()
    control = (
        None
        if args.marginal_mode == "isolated_lambda1_control"
        else _load_control_contract(args.control_dir)
    )
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise R23TrainingError("CUDA was requested but is unavailable")
    torch.manual_seed(int(args.seed))
    np.random.seed(int(args.seed))
    if device.type == "cuda":
        torch.cuda.manual_seed_all(int(args.seed))
    started = time.monotonic()
    context = _load_context(args, torch)
    ledger = reconstruct_tier_ledger(args.source_label_dir, context, enforce_real=True)
    folds = build_logo_folds(context, ledger, enforce_real=True)
    evaluation_cache = build_candidate_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(args.evaluation_batch_size),
    )
    cache = transfer_candidate_cache(torch, cache=evaluation_cache, device=device)
    probe = build_candidate_model(context, torch.device("cpu"))
    anchor_state = _sidecar_state(probe)
    architecture = _architecture_contract(probe, anchor_state)
    anchor_tensor_inventory = r0._anchor_tensor_inventory(context["model"])
    frozen_inventory = _frozen_tensor_inventory(probe)
    fold_records: list[Mapping[str, Any]] = []
    fold_states: list[Mapping[str, Any]] = []
    for fold in folds:
        record, state = _train_one_fold(
            torch,
            context=context,
            fold=fold,
            cache=cache,
            evaluation_cache=evaluation_cache,
            args=args,
        )
        fold_records.append(record)
        fold_states.append(state)
    if (
        r0._anchor_tensor_inventory(context["model"]) != anchor_tensor_inventory
        or _frozen_tensor_inventory(probe) != frozen_inventory
    ):
        raise R23TrainingError("anchor or frozen tensor bytes changed during training")
    aggregate = _aggregate_logo_metrics(
        [record["heldout_postselection"] for record in fold_records],
        control_contract=control,
    )
    if _producer_binding() != producer:
        raise R23TrainingError("producer bytes changed during training")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        file_descriptors: dict[str, Any] = {}
        for fold_index, state in enumerate(fold_states):
            name = _sidecar_name(fold_index)
            path = staging / name
            save_file(
                {key: value.contiguous() for key, value in state.items()}, str(path)
            )
            file_descriptors[name] = {
                "byte_size": int(path.stat().st_size),
                "sha256": sha256_file(path),
                "tensor_inventory": _tensor_inventory(state),
            }
        context_contract = r0._context_contract(context, args)
        manifest = seal_record(
            {
                "anchor": context_contract["anchor"],
                "anchor_tensor_inventory": anchor_tensor_inventory,
                "architecture": architecture,
                "authority": dict(EXPECTED_AUTHORITY),
                "base_dataset": context_contract["base_dataset"],
                "candidate_ids": list(context["candidate_ids"]),
                "comparison_control": control,
                "configuration": _configuration(args),
                "development_boundary": {
                    "development_cache_outputs_paired_with_tiers": False,
                    "development_candidate_metrics_computed": False,
                    "development_outputs_used_for_checkpoint_selection": False,
                    "development_outputs_used_for_gradient": False,
                    "frozen_anchor_cache_materialized_for_all_base_rows": True,
                    "gradient_rows": 0,
                    "label_rows": int(len(ledger["development_eval"])),
                    "tier_sources_reconstructed_for_exact_inventory_only": True,
                    "work_ids": sorted(
                        str(value)
                        for value in context["overlay_binding"][
                            "development_eval_work_ids"
                        ]
                    ),
                },
                "experiment_contract": _experiment_contract(),
                "files": file_descriptors,
                "folds": fold_records,
                "frozen_13_tensor_inventory": frozen_inventory,
                "global_partition": _global_partition_contract(context, ledger, folds),
                "logo_aggregate": aggregate,
                "objective_contract": _objective_contract(args, ledger, folds),
                "overlay": context_contract["overlay"],
                "producer": producer,
                "record_type": RECORD_TYPE,
                "runtime_boundary": {
                    "application_integration": False,
                    "family_logits_exact": True,
                    "runtime_added_parameters": 0,
                    "runtime_ratio": 1.0,
                    "sidecars_are_fold_diagnostics_not_deployable": True,
                },
                "schema_version": SCHEMA_VERSION,
                "source_query_head": context_contract["source_query_head"],
                "source_label_directory": str(
                    args.source_label_dir.expanduser().absolute().resolve()
                ),
                "source_tier_ledger": ledger["contract"],
                "training_seconds": max(float(time.monotonic() - started), 1e-9),
                "work_universe": [str(fold["heldout_work_id"]) for fold in folds],
            }
        )
        _assert_no_private_review_fields(manifest, "manifest")
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        artifacts = {
            MANIFEST_FILE: sha256_file(manifest_path),
            **{
                _sidecar_name(index): sha256_file(staging / _sidecar_name(index))
                for index in range(FOLD_COUNT)
            },
        }
        marker = seal_record(
            {
                "artifacts": artifacts,
                "owner": OWNER,
                "producer": producer,
                "safe_replace": False,
                "schema_version": SCHEMA_VERSION,
            }
        )
        _assert_no_private_review_fields(marker, "marker")
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def _assert_nested_close(
    actual: Any,
    expected: Any,
    location: str,
    *,
    absolute_tolerance: float = 1e-6,
    relative_tolerance: float = 1e-5,
) -> None:
    if isinstance(actual, Mapping) and isinstance(expected, Mapping):
        if set(actual) != set(expected):
            raise R23TrainingError(f"{location}: key inventory drifted")
        for key in actual:
            _assert_nested_close(
                actual[key],
                expected[key],
                f"{location}.{key}",
                absolute_tolerance=absolute_tolerance,
                relative_tolerance=relative_tolerance,
            )
        return
    if (
        isinstance(actual, Sequence)
        and not isinstance(actual, (str, bytes))
        and isinstance(expected, Sequence)
        and not isinstance(expected, (str, bytes))
    ):
        if len(actual) != len(expected):
            raise R23TrainingError(f"{location}: length drifted")
        for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
            _assert_nested_close(
                left,
                right,
                f"{location}[{index}]",
                absolute_tolerance=absolute_tolerance,
                relative_tolerance=relative_tolerance,
            )
        return
    if isinstance(actual, bool) or isinstance(expected, bool):
        if actual is not expected:
            raise R23TrainingError(f"{location}: boolean drifted")
        return
    numeric = (int, float, np.integer, np.floating)
    if isinstance(actual, numeric) and isinstance(expected, numeric):
        if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
            raise R23TrainingError(f"{location}: non-finite value")
        if isinstance(actual, (int, np.integer)) and isinstance(
            expected, (int, np.integer)
        ):
            if int(actual) != int(expected):
                raise R23TrainingError(f"{location}: integer drifted")
        elif not math.isclose(
            float(actual),
            float(expected),
            abs_tol=absolute_tolerance,
            rel_tol=relative_tolerance,
        ):
            raise R23TrainingError(f"{location}: numeric drifted")
        return
    if actual != expected:
        raise R23TrainingError(f"{location}: value drifted")


def _configuration_args(manifest: Mapping[str, Any]) -> argparse.Namespace:
    configuration = _mapping(manifest["configuration"], "configuration")
    required = {
        "anchor_kl_scope",
        "anchor_kl_weight",
        "base_residual_l2_weight",
        "batch_size",
        "candidate_distribution_excess_weight",
        "device",
        "direct_balance_mode",
        "direct_candidate_weight",
        "direct_residual_l2_weight",
        "epochs",
        "evaluation_batch_size",
        "experiment_cell_id",
        "gradient_clip",
        "learning_rate",
        "marginal_lambda",
        "marginal_mode",
        "maximum_acceptable_regression",
        "maximum_family_regression",
        "maximum_preferred_regression",
        "page_js_weight",
        "page_optimizer_calls",
        "seed",
        "single_day_body_hard_negative_weight",
        "single_day_supervised_hard_negative_weight",
        "weight_decay",
    }
    if set(configuration) != required:
        raise R23TrainingError("configuration inventory drifted")
    sealed_device = configuration["device"]
    if not isinstance(sealed_device, str) or sealed_device not in {"cpu", "cuda"}:
        raise R23TrainingError("configuration device drifted")
    args = argparse.Namespace(
        anchor_adapter_dir=Path(str(manifest["anchor"]["directory"])),
        anchor_kl_weight=configuration["anchor_kl_weight"],
        base_npz=Path(str(manifest["base_dataset"]["file"])),
        base_residual_l2_weight=configuration["base_residual_l2_weight"],
        batch_size=configuration["batch_size"],
        control_dir=(
            None
            if manifest.get("comparison_control") is None
            else Path(str(manifest["comparison_control"]["directory"]))
        ),
        device="cpu",
        direct_candidate_weight=configuration["direct_candidate_weight"],
        direct_residual_l2_weight=configuration["direct_residual_l2_weight"],
        epochs=configuration["epochs"],
        evaluation_batch_size=configuration["evaluation_batch_size"],
        gradient_clip=configuration["gradient_clip"],
        learning_rate=configuration["learning_rate"],
        marginal_mode=configuration["marginal_mode"],
        maximum_acceptable_regression=configuration["maximum_acceptable_regression"],
        maximum_family_regression=configuration["maximum_family_regression"],
        maximum_preferred_regression=configuration["maximum_preferred_regression"],
        overlay_dir=Path(str(manifest["overlay"]["directory"])),
        page_js_weight=configuration["page_js_weight"],
        seed=configuration["seed"],
        source_label_dir=Path(str(manifest["source_label_directory"])),
        source_query_head=Path(str(manifest["source_query_head"]["file"])),
        weight_decay=configuration["weight_decay"],
    )
    _validate_options(args)
    expected = dict(_configuration(args))
    expected["device"] = sealed_device
    if configuration != expected:
        raise R23TrainingError("configuration values drifted")
    return args


def _validate_direct_loss(
    value: Any, args: argparse.Namespace, location: str
) -> Mapping[str, Any]:
    loss = _mapping(value, location)
    names = {
        "candidate_core",
        "candidate_distribution_excess",
        "preferred_set_nll",
        "residual_delta_l2",
        "safe_set_nll",
        "single_day_body_hard_negative",
        "single_day_supervised_hard_negative",
        "total",
    }
    if set(loss) != names or any(
        isinstance(number, bool)
        or not isinstance(number, (int, float))
        or not math.isfinite(float(number))
        or float(number) < 0.0
        for number in loss.values()
    ):
        raise R23TrainingError(f"{location}: direct loss inventory drifted")
    expected_core = SAFE_WEIGHT * float(
        loss["safe_set_nll"]
    ) + PREFERENCE_WEIGHT * float(loss["preferred_set_nll"])
    expected_total = (
        float(args.direct_candidate_weight) * float(loss["candidate_core"])
        + SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT
        * float(loss["single_day_body_hard_negative"])
        + SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
        * float(loss["single_day_supervised_hard_negative"])
        + float(args.direct_residual_l2_weight) * float(loss["residual_delta_l2"])
    )
    if (
        float(loss["candidate_distribution_excess"]) != 0.0
        or not math.isclose(
            float(loss["candidate_core"]), expected_core, rel_tol=1e-6, abs_tol=1e-7
        )
        or not math.isclose(
            float(loss["total"]), expected_total, rel_tol=1e-6, abs_tol=1e-7
        )
    ):
        raise R23TrainingError(f"{location}: direct loss algebra drifted")
    return loss


def _validate_base_loss(
    value: Any, args: argparse.Namespace, location: str
) -> Mapping[str, Any]:
    loss = _mapping(value, location)
    names = {
        "anchor_candidate_kl",
        "body_candidate_kl",
        "residual_delta_l2",
        "total",
        "variant_candidate_kl",
    }
    if set(loss) != names or any(
        isinstance(number, bool)
        or not isinstance(number, (int, float))
        or not math.isfinite(float(number))
        or float(number) < 0.0
        for number in loss.values()
    ):
        raise R23TrainingError(f"{location}: base loss inventory drifted")
    expected_kl = 0.5 * (
        float(loss["body_candidate_kl"]) + float(loss["variant_candidate_kl"])
    )
    expected_total = float(args.anchor_kl_weight) * expected_kl + float(
        args.base_residual_l2_weight
    ) * float(loss["residual_delta_l2"])
    if not math.isclose(
        float(loss["anchor_candidate_kl"]), expected_kl, rel_tol=1e-6, abs_tol=1e-7
    ) or not math.isclose(
        float(loss["total"]), expected_total, rel_tol=1e-6, abs_tol=1e-7
    ):
        raise R23TrainingError(f"{location}: base loss algebra drifted")
    return loss


def _validate_output_root(output_dir: Path) -> Path:
    expanded = output_dir.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R23TrainingError("output path is linked or reparsed")
    root = expanded.resolve()
    if not root.is_dir() or overlay_v3._contains_link_or_reparse(root):
        raise R23TrainingError("output directory is missing, linked, or reparsed")
    expected = {MANIFEST_FILE, MARKER_FILE} | {
        _sidecar_name(index) for index in range(FOLD_COUNT)
    }
    if {path.name for path in root.iterdir()} != expected:
        raise R23TrainingError("output inventory drifted")
    return root


def validate_output(
    output_dir: Path, *, require_external_sources: bool = True
) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise R23TrainingError("PyTorch is required") from error
    root = _validate_output_root(output_dir)
    manifest_path = root / MANIFEST_FILE
    marker_path = root / MARKER_FILE
    manifest = _read_json(manifest_path, "R2.3 manifest")
    marker = _read_json(marker_path, "R2.3 marker")
    _validate_record_seal(manifest, "R2.3 manifest")
    _validate_record_seal(marker, "R2.3 marker")
    _assert_no_private_review_fields(manifest, "manifest")
    _assert_no_private_review_fields(marker, "marker")
    if set(marker) != {
        "artifacts",
        "owner",
        "producer",
        "record_sha256",
        "safe_replace",
        "schema_version",
    }:
        raise R23TrainingError("marker inventory drifted")
    expected_top_level = {
        "anchor",
        "anchor_tensor_inventory",
        "architecture",
        "authority",
        "base_dataset",
        "candidate_ids",
        "comparison_control",
        "configuration",
        "development_boundary",
        "experiment_contract",
        "files",
        "folds",
        "frozen_13_tensor_inventory",
        "global_partition",
        "logo_aggregate",
        "objective_contract",
        "overlay",
        "producer",
        "record_sha256",
        "record_type",
        "runtime_boundary",
        "schema_version",
        "source_label_directory",
        "source_query_head",
        "source_tier_ledger",
        "training_seconds",
        "work_universe",
    }
    if set(manifest) != expected_top_level:
        raise R23TrainingError("manifest top-level inventory drifted")
    producer = _producer_binding()
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type") != RECORD_TYPE
        or manifest.get("producer") != producer
        or manifest.get("authority") != EXPECTED_AUTHORITY
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("producer") != producer
        or marker.get("safe_replace") is not False
    ):
        raise R23TrainingError("manifest/marker authority or producer drifted")
    training_seconds = manifest["training_seconds"]
    if (
        isinstance(training_seconds, bool)
        or not isinstance(training_seconds, (int, float))
        or not math.isfinite(float(training_seconds))
        or float(training_seconds) <= 0.0
    ):
        raise R23TrainingError("training_seconds drifted")
    artifacts = _mapping(marker["artifacts"], "marker artifacts")
    expected_artifact_names = {MANIFEST_FILE} | {
        _sidecar_name(index) for index in range(FOLD_COUNT)
    }
    if set(artifacts) != expected_artifact_names:
        raise R23TrainingError("marker artifact inventory drifted")
    for name in expected_artifact_names:
        if artifacts[name] != sha256_file(root / name):
            raise R23TrainingError(f"marker artifact hash drifted: {name}")
    args = _configuration_args(manifest)
    context = _load_context(args, torch)
    ledger = reconstruct_tier_ledger(
        args.source_label_dir, context, enforce_real=require_external_sources
    )
    folds = build_logo_folds(context, ledger, enforce_real=require_external_sources)
    context_contract = r0._context_contract(context, args)
    for name in ("anchor", "base_dataset", "overlay", "source_query_head"):
        _assert_nested_close(
            manifest[name],
            context_contract[name],
            f"manifest.{name}",
            absolute_tolerance=0.0,
            relative_tolerance=0.0,
        )
    expected_anchor_inventory = r0._anchor_tensor_inventory(context["model"])
    if manifest["anchor_tensor_inventory"] != expected_anchor_inventory:
        raise R23TrainingError("anchor tensor inventory drifted")
    model = build_candidate_model(context, torch.device("cpu"))
    anchor_state = _sidecar_state(model)
    anchor_frozen = _frozen_tensor_inventory(model)
    if manifest["frozen_13_tensor_inventory"] != anchor_frozen:
        raise R23TrainingError("frozen 13-tensor inventory drifted")
    cache = build_candidate_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(args.evaluation_batch_size),
    )
    assert_epoch0_exact(torch, model, cache)
    _assert_nested_close(
        manifest["architecture"],
        _architecture_contract(model, anchor_state),
        "manifest.architecture",
        absolute_tolerance=0.0,
        relative_tolerance=0.0,
    )
    _assert_nested_close(
        manifest["source_tier_ledger"],
        ledger["contract"],
        "manifest.source_tier_ledger",
        absolute_tolerance=0.0,
        relative_tolerance=0.0,
    )
    _assert_nested_close(
        manifest["global_partition"],
        _global_partition_contract(context, ledger, folds),
        "manifest.global_partition",
        absolute_tolerance=0.0,
        relative_tolerance=0.0,
    )
    _assert_nested_close(
        manifest["objective_contract"],
        _objective_contract(args, ledger, folds),
        "manifest.objective_contract",
        absolute_tolerance=0.0,
        relative_tolerance=0.0,
    )
    if manifest["experiment_contract"] != _experiment_contract():
        raise R23TrainingError("experiment contract drifted")
    development = manifest["development_boundary"]
    if development != {
        "development_cache_outputs_paired_with_tiers": False,
        "development_candidate_metrics_computed": False,
        "development_outputs_used_for_checkpoint_selection": False,
        "development_outputs_used_for_gradient": False,
        "frozen_anchor_cache_materialized_for_all_base_rows": True,
        "gradient_rows": 0,
        "label_rows": int(len(ledger["development_eval"])),
        "tier_sources_reconstructed_for_exact_inventory_only": True,
        "work_ids": sorted(
            str(value)
            for value in context["overlay_binding"]["development_eval_work_ids"]
        ),
    }:
        raise R23TrainingError("development boundary drifted")
    files = _mapping(manifest["files"], "manifest files")
    if set(files) != {_sidecar_name(index) for index in range(FOLD_COUNT)}:
        raise R23TrainingError("sidecar descriptor inventory drifted")
    fold_records = _sequence(manifest["folds"], "manifest folds")
    if len(fold_records) != FOLD_COUNT:
        raise R23TrainingError("manifest fold count drifted")
    recomputed_reports: list[Mapping[str, Any]] = []
    for fold_index, (fold, sealed_fold_value) in enumerate(
        zip(folds, fold_records, strict=True)
    ):
        sealed_fold = _mapping(sealed_fold_value, f"fold[{fold_index}]")
        if sealed_fold.get("partition") != fold["contract"]:
            raise R23TrainingError(f"fold[{fold_index}] partition drifted")
        _apply_sidecar_state(model, anchor_state)
        anchor_base = evaluate_base_metrics(
            torch,
            model,
            cache=cache,
            arrays=context["arrays"],
            candidate_ids=context["candidate_ids"],
        )
        anchor_training = _training_metrics(
            torch,
            model,
            cache=cache,
            fold=fold,
            candidate_ids=context["candidate_ids"],
            anchor_state=anchor_state,
        )
        _assert_nested_close(
            sealed_fold["anchor_base_metrics"],
            anchor_base,
            f"fold[{fold_index}].anchor_base",
        )
        _assert_nested_close(
            sealed_fold["anchor_training_metrics"],
            anchor_training,
            f"fold[{fold_index}].anchor_training",
        )
        history = _sequence(sealed_fold["history"], f"fold[{fold_index}].history")
        diagnostics = _sequence(
            sealed_fold["phase_diagnostics"], f"fold[{fold_index}].phase_diagnostics"
        )
        if len(history) != int(args.epochs) + 1 or len(diagnostics) != int(args.epochs):
            raise R23TrainingError(f"fold[{fold_index}] history inventory drifted")
        recomputed_history: list[Mapping[str, Any]] = []
        for epoch, sealed_record_value in enumerate(history):
            sealed_record = _mapping(
                sealed_record_value, f"fold[{fold_index}].history[{epoch}]"
            )
            if int(sealed_record.get("epoch", -1)) != epoch:
                raise R23TrainingError("history epoch drifted")
            state = _state_from_payload(torch, sealed_record["sidecar_state"])
            _apply_sidecar_state(model, state)
            if epoch == 0:
                if _state_payload(state) != _state_payload(anchor_state):
                    raise R23TrainingError("epoch-zero state is not exact anchor")
                losses = None
                consumption = _zero_consumption()
                phase = "exact_anchor_sentinel"
            else:
                direct_order, _direct_weights, direct_schedule = _direct_schedule(
                    fold, args, epoch=epoch
                )
                _ = direct_order
                _base_order, base_schedule = _base_schedule(fold, args, epoch=epoch)
                direct_stub = {"schedule": direct_schedule}
                base_stub = {"schedule": base_schedule}
                consumption = _phase_consumption(
                    fold, direct=direct_stub, base=base_stub
                )
                phase_losses = _mapping(
                    sealed_record["phase_losses"],
                    f"fold[{fold_index}].history[{epoch}].phase_losses",
                )
                if set(phase_losses) != {"base", "direct"}:
                    raise R23TrainingError("post-base phase loss inventory drifted")
                _validate_direct_loss(
                    phase_losses["direct"], args, "post-base direct loss"
                )
                _validate_base_loss(phase_losses["base"], args, "post-base base loss")
                losses = phase_losses
                phase = "after_base_preservation_selectable"
            recomputed = _snapshot_record(
                torch,
                model,
                epoch=epoch,
                phase_boundary=phase,
                selectable=True,
                cache=cache,
                context=context,
                fold=fold,
                candidate_ids=context["candidate_ids"],
                anchor_state=anchor_state,
                anchor_frozen_inventory=anchor_frozen,
                anchor_base=anchor_base,
                anchor_training=anchor_training,
                args=args,
                phase_losses=losses,
                consumption=consumption,
            )
            _assert_nested_close(
                sealed_record, recomputed, f"fold[{fold_index}].history[{epoch}]"
            )
            recomputed_history.append(recomputed)
            if epoch > 0:
                diagnostic = _mapping(
                    diagnostics[epoch - 1],
                    f"fold[{fold_index}].phase_diagnostics[{epoch - 1}]",
                )
                diagnostic_state = _state_from_payload(
                    torch, diagnostic["sidecar_state"]
                )
                _apply_sidecar_state(model, diagnostic_state)
                phase_losses = _mapping(
                    diagnostic["phase_losses"], "direct phase losses"
                )
                if set(phase_losses) != {"direct"}:
                    raise R23TrainingError("post-direct phase loss inventory drifted")
                _validate_direct_loss(phase_losses["direct"], args, "post-direct loss")
                direct_order, _weights, direct_schedule = _direct_schedule(
                    fold, args, epoch=epoch
                )
                _ = direct_order
                expected_diag = _snapshot_record(
                    torch,
                    model,
                    epoch=epoch,
                    phase_boundary="after_direct_candidate_diagnostic_only",
                    selectable=False,
                    cache=cache,
                    context=context,
                    fold=fold,
                    candidate_ids=context["candidate_ids"],
                    anchor_state=anchor_state,
                    anchor_frozen_inventory=anchor_frozen,
                    anchor_base=anchor_base,
                    anchor_training=anchor_training,
                    args=args,
                    phase_losses=phase_losses,
                    consumption=_phase_consumption(
                        fold, direct={"schedule": direct_schedule}
                    ),
                )
                _assert_nested_close(
                    diagnostic,
                    expected_diag,
                    f"fold[{fold_index}].phase_diagnostics[{epoch - 1}]",
                )
        best_index = 0
        best_key = _selection_key(recomputed_history[0])
        for index, record in enumerate(recomputed_history[1:], 1):
            key = _selection_key(record)
            if key > best_key:
                best_index, best_key = index, key
        selected = recomputed_history[best_index]
        selected_epoch = int(selected["epoch"])
        if int(
            sealed_fold.get("selected_epoch", -1)
        ) != selected_epoch or sealed_fold.get("selection") != {
            "anchor_fallback_selected": selected_epoch == 0,
            "best_epoch": selected_epoch,
            "development_eval_consulted": False,
            "heldout_consulted_for_selection": False,
            "page_optimizer_calls": 0,
            "post_base_states_only_selectable": True,
            "selection_key": list(best_key),
            "selection_key_order": list(SELECTION_KEY_ORDER),
        }:
            raise R23TrainingError(f"fold[{fold_index}] selection drifted")
        _assert_nested_close(
            sealed_fold["selected_base_metrics"],
            selected["base_metrics"],
            f"fold[{fold_index}].selected_base",
        )
        _assert_nested_close(
            sealed_fold["selected_training_metrics"],
            selected["training_only_metrics"],
            f"fold[{fold_index}].selected_training",
        )
        sidecar_name = _sidecar_name(fold_index)
        if sealed_fold.get("sidecar_file") != sidecar_name:
            raise R23TrainingError("fold sidecar name drifted")
        sidecar_state = _load_sidecar_state(torch, root / sidecar_name)
        if _state_payload(sidecar_state) != selected["sidecar_state"]:
            raise R23TrainingError("fold sidecar state does not match selected state")
        descriptor = _mapping(files[sidecar_name], f"files.{sidecar_name}")
        expected_descriptor = {
            "byte_size": int((root / sidecar_name).stat().st_size),
            "sha256": sha256_file(root / sidecar_name),
            "tensor_inventory": _tensor_inventory(sidecar_state),
        }
        if descriptor != expected_descriptor:
            raise R23TrainingError("fold sidecar descriptor drifted")
        _apply_sidecar_state(model, anchor_state)
        anchor_heldout = _heldout_metrics(
            torch,
            model,
            cache=cache,
            fold=fold,
            candidate_ids=context["candidate_ids"],
        )
        _apply_sidecar_state(model, sidecar_state)
        selected_heldout = _heldout_metrics(
            torch,
            model,
            cache=cache,
            fold=fold,
            candidate_ids=context["candidate_ids"],
        )
        report = _heldout_report(
            fold=fold,
            selected_epoch=selected_epoch,
            anchor=anchor_heldout,
            candidate=selected_heldout,
            selected_record=selected,
        )
        _assert_nested_close(
            sealed_fold["heldout_postselection"],
            report,
            f"fold[{fold_index}].heldout_postselection",
        )
        if sealed_fold.get(
            "trajectory_replayed_by_strict_validator"
        ) is not False or set(sealed_fold) != {
            "anchor_base_metrics",
            "anchor_training_metrics",
            "heldout_postselection",
            "history",
            "partition",
            "phase_diagnostics",
            "selected_base_metrics",
            "selected_epoch",
            "selected_training_metrics",
            "selection",
            "sidecar_file",
            "trajectory_replayed_by_strict_validator",
        }:
            raise R23TrainingError("fold record inventory drifted")
        recomputed_reports.append(report)
    if args.marginal_mode == "isolated_lambda1_control":
        control = None
        if manifest.get("comparison_control") is not None:
            raise R23TrainingError("lambda1 control unexpectedly binds a control")
    else:
        control = _load_control_contract(args.control_dir)
        if manifest.get("comparison_control") != control:
            raise R23TrainingError("challenger comparison control drifted")
    aggregate = _aggregate_logo_metrics(recomputed_reports, control_contract=control)
    _assert_nested_close(
        manifest["logo_aggregate"], aggregate, "manifest.logo_aggregate"
    )
    if tuple(manifest["candidate_ids"]) != tuple(context["candidate_ids"]):
        raise R23TrainingError("manifest candidate IDs drifted")
    if manifest["work_universe"] != [str(fold["heldout_work_id"]) for fold in folds]:
        raise R23TrainingError("manifest work universe drifted")
    if manifest["runtime_boundary"] != {
        "application_integration": False,
        "family_logits_exact": True,
        "runtime_added_parameters": 0,
        "runtime_ratio": 1.0,
        "sidecars_are_fold_diagnostics_not_deployable": True,
    }:
        raise R23TrainingError("runtime boundary drifted")
    return {
        "logo_diagnostic_worth": bool(aggregate["logo_diagnostic_worth"]),
        "manifest_record_sha256": str(manifest["record_sha256"]),
        "manifest_sha256": sha256_file(manifest_path),
        "marginal_mode": str(args.marginal_mode),
        "nonpromotable": True,
        "output_dir": str(root),
        "pilot_continuation_worth": bool(
            aggregate["pilot_continuation"] is not None
            and aggregate["pilot_continuation"]["passed"]
        ),
        "producer": producer,
        "schema_version": SCHEMA_VERSION,
        "status": "validated_nonpromotable_r23_tristate_logo",
    }


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    result = validate_output(args.output_dir)
    return {
        **result,
        "development_candidate_metrics_computed": False,
        "development_tier_sources_reconstructed_for_inventory": True,
        "evaluation_authority": False,
        "status": "evaluated_nonpromotable_r23_tristate_logo_without_development_metrics",
    }


def _add_shared_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-npz", type=Path, default=r0.DEFAULT_BASE_NPZ)
    parser.add_argument("--overlay-dir", type=Path, default=r0.DEFAULT_OVERLAY_DIR)
    parser.add_argument(
        "--anchor-adapter-dir", type=Path, default=r0.DEFAULT_ANCHOR_DIR
    )
    parser.add_argument(
        "--source-query-head", type=Path, default=r0.DEFAULT_SOURCE_QUERY_HEAD
    )
    parser.add_argument("--source-label-dir", type=Path, default=DEFAULT_LABEL_DIR)
    parser.add_argument("--marginal-mode", choices=tuple(MARGINAL_MODES), required=True)
    parser.add_argument("--control-dir", type=Path)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--evaluation-batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--direct-candidate-weight", type=float, default=1.0)
    parser.add_argument("--direct-residual-l2-weight", type=float, default=0.0)
    parser.add_argument("--anchor-kl-weight", type=float, default=5.0)
    parser.add_argument("--base-residual-l2-weight", type=float, default=0.005)
    parser.add_argument("--page-js-weight", type=float, default=0.0)
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument("--seed", type=int, default=INITIAL_SEED)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    _add_shared_arguments(preflight_parser)
    preflight_parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    train_parser = commands.add_parser("train")
    _add_shared_arguments(train_parser)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    train_parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    evaluate_parser = commands.add_parser("evaluate")
    evaluate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "preflight":
            result = preflight(args)
        elif args.command == "train":
            result = train(args)
        elif args.command == "validate":
            result = validate_output(args.output_dir)
        elif args.command == "evaluate":
            result = evaluate(args)
        else:  # pragma: no cover
            parser.error("unsupported command")
    except R23TrainingError as error:
        parser.error(str(error))
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
