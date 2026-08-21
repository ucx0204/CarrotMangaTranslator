#!/usr/bin/env python3
"""Train the isolated R1 shared-hidden family residual diagnostic.

R1 keeps the production r3h adapter byte-exact and trains the same two-tensor,
65-parameter scalar sidecar as R0.  Its training contract is different and is
therefore deliberately versioned separately: base preservation can exclude all
sealed direct rows, direct supervision can be balanced by work and family,
anchor KL is legal only in the base phase, a zero page weight means no page
optimizer step, and every selectable state is captured after the base phase.

The artifact is experimental, QA-only, nonpromotable, and not consumable by the
application or existing exporters.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_v3_shared_hidden_family_residual as r0
except ImportError:  # pragma: no cover - direct script execution
    import train_manga_font_v3_shared_hidden_family_residual as r0


SCHEMA_VERSION = "manga-font-v3-shared-hidden-family-residual-r1-v1"
OWNER = "carrot-manga-translator/manga-font-v3-shared-hidden-family-residual-r1-v1"
SIDECAR_FILE = "family-margin-residual-r1.safetensors"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-shared-hidden-family-residual-r1-v1-owned.json"
OUTPUT_FILES = frozenset({SIDECAR_FILE, MANIFEST_FILE, MARKER_FILE})

BASE_SUPERVISION_MODES = ("overridden_all", "non_direct_preservation")
DIRECT_BALANCE_MODES = ("work", "work_family")
ANCHOR_KL_SCOPE = "base_only"
EXPECTED_REAL_COUNTS = {
    "all_base_train_rows": 12_923,
    "direct_train_rows": 1_042,
    "non_direct_base_rows": 11_881,
    "page_train_rows": 197,
    "page_train_groups": 91,
    "train_works": 10,
    "work_family_strata": 20,
}

EXPECTED_AUTHORITY = dict(r0.EXPECTED_AUTHORITY)
EXPECTED_RUNTIME_BOUNDARY = {
    **r0.EXPECTED_RUNTIME_BOUNDARY,
    "keyed_artifact_authenticity": False,
    "phase_transcript": "sealed_producer_attestation_only",
    "training_contract": "r1_partitioned_base_last",
    "trajectory_replay_authority": False,
}
EXPECTED_CONFIGURATION_KEYS = frozenset(
    {
        *r0.EXPECTED_CONFIGURATION_KEYS,
        "anchor_kl_scope",
        "base_supervision_mode",
        "direct_balance_mode",
    }
)
EXPECTED_MANIFEST_KEYS = frozenset(
    {
        "anchor",
        "architecture",
        "authority",
        "base_dataset",
        "base_metrics",
        "candidate_ids",
        "candidate_score_invariance",
        "configuration",
        "development_diagnostics",
        "diagnostic_worth",
        "direct_family_metrics",
        "family_override",
        "files",
        "history",
        "objective_contract",
        "overlay",
        "overlay_metrics",
        "partition",
        "record_sha256",
        "record_type",
        "runtime_boundary",
        "schema_version",
        "selection",
        "source_query_head",
        "trainable_parameters",
        "training_seconds",
    }
)
EXPECTED_SELECTION_KEYS = frozenset(
    {
        "anchor_fallback_selected",
        "base_gradient_rows",
        "best_epoch",
        "development_eval_consulted_during_checkpoint_selection",
        "development_eval_gradient_rows",
        "development_eval_label_rows_consulted_during_checkpoint_selection",
        "direct_family_gradient_rows",
        "hard_diagnostic_gate_required_for_nonzero_epoch",
        "model_selection_label_sources",
        "page_consistency_gradient_groups",
        "page_consistency_gradient_rows",
        "page_consistency_metric_groups",
        "page_consistency_metric_rows",
        "selectable_state_boundary",
        "selection_key_order",
    }
)
CHECKPOINT_SELECTION_INPUTS = (
    "base_r3_validation_quality_and_regression_gates",
    "direct_family_train_work_macro_balanced_body_variant_and_worst_work_gates",
    "direct_family_train_row_metrics_for_tie_break",
    "page_consistency_train_runtime_nonregression_gate_only_not_tie_break",
    "family_margin_magnitude_and_saturation_for_tie_break",
)
MODEL_SELECTION_LABEL_SOURCES = (
    "base_r3_validation",
    "direct_family_training_only_non_human_visual",
    "page_consistency_training_only_runtime_metrics_for_nonregression_gate",
)
SELECTION_KEY_ORDER = (
    "anchor_or_hard_diagnostic_candidate",
    "hard_diagnostic_gate_passed_for_nonzero_epoch",
    "base_v8_quality_gate",
    "base_no_material_regression",
    "direct_family_train_work_macro_balanced_accuracy",
    "direct_family_train_work_macro_body_accuracy",
    "direct_family_train_work_macro_variant_accuracy",
    "direct_family_train_row_balanced_accuracy",
    "direct_family_train_row_body_accuracy",
    "negative_mean_absolute_family_margin",
    "negative_family_margin_saturation_rate",
    "base_r3_validation_score",
    "negative_epoch_for_earlier_tie_break",
)


class R1TrainingError(ValueError):
    """Raised when the sealed R1 diagnostic contract is violated."""


def canonical_json(value: Any) -> str:
    return r0.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return r0.json_bytes(value, pretty=pretty)


def sha256_file(path: Path) -> str:
    return r0.sha256_file(path)


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    return r0.seal_record(core)


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R1TrainingError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise R1TrainingError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _assert_nested_close(actual: Any, expected: Any, location: str) -> None:
    try:
        r0._assert_nested_close(actual, expected, location)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R1TrainingError(str(error)) from error


def _validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    try:
        r0.validate_record_seal(record, location)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R1TrainingError(str(error)) from error


def _safe_new_output(path: Path) -> Path:
    try:
        return r0._safe_new_output(path)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R1TrainingError(str(error)) from error


def _validate_options(args: argparse.Namespace) -> None:
    try:
        r0._validate_options(args)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R1TrainingError(str(error)) from error
    if args.base_supervision_mode not in BASE_SUPERVISION_MODES:
        raise R1TrainingError("base supervision mode drifted")
    if args.direct_balance_mode not in DIRECT_BALANCE_MODES:
        raise R1TrainingError("direct balance mode drifted")
    if args.anchor_kl_scope != ANCHOR_KL_SCOPE:
        raise R1TrainingError("R1 anchor KL scope must be base_only")


def _load_context(args: argparse.Namespace, torch: Any) -> Mapping[str, Any]:
    try:
        return r0._load_context(args, torch)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R1TrainingError(str(error)) from error


def _inventory_sha256(
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    labels: np.ndarray,
    weights: np.ndarray,
) -> str:
    digest = hashlib.sha256()
    sample_ids = arrays["sample_ids"].astype(str)
    for index in np.asarray(indices, dtype=np.int64):
        position = int(index)
        digest.update(str(position).encode("utf-8"))
        digest.update(b"\0")
        digest.update(sample_ids[position].encode("utf-8"))
        digest.update(b"\0")
        digest.update(np.asarray(labels[position], dtype="<i8").tobytes())
        digest.update(np.asarray(weights[position], dtype="<f4").tobytes())
    return digest.hexdigest()


def _index_sha256(indices: np.ndarray) -> str:
    return hashlib.sha256(
        np.asarray(indices, dtype="<i8").tobytes(order="C")
    ).hexdigest()


def _aligned_inventory_sha256(
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    labels: np.ndarray,
    weights: np.ndarray,
) -> str:
    if not (len(indices) == len(labels) == len(weights)):
        raise R1TrainingError("aligned inventory length drifted")
    digest = hashlib.sha256()
    sample_ids = arrays["sample_ids"].astype(str)
    for index, label, weight in zip(indices, labels, weights, strict=True):
        position = int(index)
        digest.update(str(position).encode("utf-8"))
        digest.update(b"\0")
        digest.update(sample_ids[position].encode("utf-8"))
        digest.update(b"\0")
        digest.update(np.asarray(label, dtype="<i8").tobytes())
        digest.update(np.asarray(weight, dtype="<f4").tobytes())
    return digest.hexdigest()


def _build_training_partition(
    context: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    enforce_expected_counts: bool = True,
) -> Mapping[str, Any]:
    arrays = context["arrays"]
    groups = context["groups"]
    development_work_ids = context["overlay_binding"]["development_eval_work_ids"]
    all_base_indices = r0._base_train_indices(arrays, development_work_ids)
    direct_indices, direct_labels, direct_weights, direct_work_ids = r0._direct_arrays(
        groups["direct_family"]["train"]
    )
    page_indices, page_labels, page_weights, page_work_ids = r0._page_body_arrays(
        groups["train"]
    )
    override_labels, override_weights, family_override = (
        r0.page_v3.build_family_override_contract(
            arrays,
            groups["direct_family"],
            development_eval_work_ids=development_work_ids,
        )
    )
    direct_set = set(int(value) for value in direct_indices)
    all_base_set = set(int(value) for value in all_base_indices)
    page_set = set(int(value) for value in page_indices)
    if (
        len(direct_set) != len(direct_indices)
        or len(all_base_set) != len(all_base_indices)
        or len(page_set) != len(page_indices)
        or direct_set - all_base_set
        or page_set - direct_set
    ):
        raise R1TrainingError("overlay rows escaped the exact base/direct partition")

    original_labels = arrays["family_labels"].astype(np.int64, copy=False)
    original_weights = arrays["family_label_weights"].astype(np.float32, copy=False)
    non_direct_indices = np.asarray(
        [value for value in all_base_indices if int(value) not in direct_set],
        dtype=np.int64,
    )
    if args.base_supervision_mode == "overridden_all":
        base_indices = all_base_indices
        base_labels = override_labels
        base_weights = override_weights
        base_target_source = "r3_targets_with_sealed_direct_train_override"
    elif args.base_supervision_mode == "non_direct_preservation":
        base_indices = non_direct_indices
        base_labels = original_labels
        base_weights = original_weights
        base_target_source = "original_r3_targets_and_weights_unmodified"
    else:  # pragma: no cover - options validation owns the enum
        raise R1TrainingError("unsupported base supervision mode")

    base_set = set(int(value) for value in base_indices)
    non_direct_set = set(int(value) for value in non_direct_indices)
    base_direct_intersection = base_set & direct_set
    train_work_ids = tuple(sorted(set(direct_work_ids.astype(str).tolist())))
    strata = tuple(
        sorted(
            {
                (str(work_id), int(family))
                for work_id, family in zip(
                    direct_work_ids.tolist(), direct_labels.tolist(), strict=True
                )
            }
        )
    )
    if enforce_expected_counts:
        expected_base_rows = (
            EXPECTED_REAL_COUNTS["all_base_train_rows"]
            if args.base_supervision_mode == "overridden_all"
            else EXPECTED_REAL_COUNTS["non_direct_base_rows"]
        )
        expected_intersection = (
            EXPECTED_REAL_COUNTS["direct_train_rows"]
            if args.base_supervision_mode == "overridden_all"
            else 0
        )
        checks = {
            "all_base": len(all_base_indices)
            == EXPECTED_REAL_COUNTS["all_base_train_rows"],
            "base": len(base_indices) == expected_base_rows,
            "direct": len(direct_indices) == EXPECTED_REAL_COUNTS["direct_train_rows"],
            "direct_body": int(np.sum(direct_labels == r0.v8.BODY_FAMILY_INDEX)) == 667,
            "direct_variant": int(np.sum(direct_labels == r0.v8.VARIANT_FAMILY_INDEX))
            == 375,
            "intersection": len(base_direct_intersection) == expected_intersection,
            "page_groups": len(groups["train"])
            == EXPECTED_REAL_COUNTS["page_train_groups"],
            "page_rows": len(page_indices) == EXPECTED_REAL_COUNTS["page_train_rows"],
            "strata": len(strata) == EXPECTED_REAL_COUNTS["work_family_strata"],
            "works": len(train_work_ids) == EXPECTED_REAL_COUNTS["train_works"],
            "development_direct": len(groups["direct_family"]["development_eval"])
            == 305,
            "development_page_groups": len(groups["development_eval"]) == 32,
            "development_page_rows": sum(
                len(group["row_indices"]) for group in groups["development_eval"]
            )
            == 65,
            "development_works": len(development_work_ids) == 3,
        }
        if not all(checks.values()):
            raise R1TrainingError(f"real R1 partition count drifted: {checks}")
    if args.base_supervision_mode == "non_direct_preservation" and (
        base_direct_intersection or base_set | direct_set != all_base_set
    ):
        raise R1TrainingError("non-direct preservation partition is not exact")

    development_direct_rows = groups["direct_family"]["development_eval"]
    development_page_groups = groups["development_eval"]
    development_direct_indices = np.asarray(
        [int(row["row_index"]) for row in development_direct_rows], dtype=np.int64
    )
    development_page_indices = np.concatenate(
        [group["row_indices"] for group in development_page_groups]
    ).astype(np.int64, copy=False)
    development_page_rows = sum(
        len(group["row_indices"]) for group in development_page_groups
    )
    development_work_set = set(str(value) for value in development_work_ids)
    base_work_values = arrays["work_ids"].astype(str, copy=False)
    gradient_work_set = {
        *(str(value) for value in base_work_values[base_indices]),
        *train_work_ids,
        *(str(value) for value in page_work_ids),
    }
    gradient_row_set = base_set | direct_set | page_set
    development_row_set = {
        *(int(value) for value in development_direct_indices),
        *(int(value) for value in development_page_indices),
    }
    if (
        development_work_set & gradient_work_set
        or development_row_set & gradient_row_set
    ):
        raise R1TrainingError("development data entered the gradient partition")

    contract = {
        "all_base_train_index_sha256": _index_sha256(all_base_indices),
        "all_base_train_rows": int(len(all_base_indices)),
        "all_base_union_is_exact_non_direct_plus_direct": bool(
            not (non_direct_set & direct_set)
            and non_direct_set | direct_set == all_base_set
        ),
        "base_direct_intersection_rows": int(len(base_direct_intersection)),
        "base_index_sha256": _index_sha256(base_indices),
        "base_inventory_sha256": _inventory_sha256(
            arrays, base_indices, base_labels, base_weights
        ),
        "base_rows": int(len(base_indices)),
        "base_supervision_mode": str(args.base_supervision_mode),
        "base_target_source": base_target_source,
        "development_eval_direct_rows": int(len(development_direct_rows)),
        "development_eval_direct_index_sha256": _index_sha256(
            development_direct_indices
        ),
        "development_eval_gradient_rows": 0,
        "development_eval_page_groups": int(len(development_page_groups)),
        "development_eval_page_index_sha256": _index_sha256(development_page_indices),
        "development_eval_page_rows": int(development_page_rows),
        "development_eval_work_ids": sorted(development_work_set),
        "development_gradient_row_intersection_count": 0,
        "development_gradient_work_intersection_count": 0,
        "direct_index_sha256": _index_sha256(direct_indices),
        "direct_inventory_sha256": _aligned_inventory_sha256(
            arrays, direct_indices, direct_labels, direct_weights
        ),
        "direct_body_rows": int(np.sum(direct_labels == r0.v8.BODY_FAMILY_INDEX)),
        "direct_rows": int(len(direct_indices)),
        "direct_target_source": "sealed_r2_training_only_direct_family_labels",
        "direct_variant_rows": int(np.sum(direct_labels == r0.v8.VARIANT_FAMILY_INDEX)),
        "gradient_work_ids": sorted(gradient_work_set),
        "non_direct_base_index_sha256": _index_sha256(non_direct_indices),
        "non_direct_base_inventory_sha256": _inventory_sha256(
            arrays, non_direct_indices, original_labels, original_weights
        ),
        "non_direct_base_rows": int(len(non_direct_indices)),
        "non_direct_target_source": "original_r3_targets_and_weights_unmodified",
        "page_index_sha256": _index_sha256(page_indices),
        "page_is_direct_subset": page_set <= direct_set,
        "page_groups": int(len(groups["train"])),
        "page_rows": int(len(page_indices)),
        "train_work_ids": list(train_work_ids),
        "work_family_strata": [
            {"family_label": family, "work_id": work_id} for work_id, family in strata
        ],
    }
    r1_family_override = {
        "base_phase_direct_override_rows": (
            int(len(direct_indices))
            if args.base_supervision_mode == "overridden_all"
            else 0
        ),
        "base_phase_target_contract": base_target_source,
        "development_eval_overrides_applied": 0,
        "direct_phase_sealed_target_rows": int(len(direct_indices)),
        "source_override_contract": family_override,
    }
    return {
        "all_base_indices": all_base_indices,
        "base_indices": base_indices,
        "base_labels": base_labels,
        "base_weights": base_weights,
        "contract": contract,
        "direct_indices": direct_indices,
        "direct_labels": direct_labels,
        "direct_weights": direct_weights,
        "direct_work_ids": direct_work_ids,
        "family_override": r1_family_override,
        "non_direct_indices": non_direct_indices,
        "page_indices": page_indices,
        "page_labels": page_labels,
        "page_weights": page_weights,
        "page_work_ids": page_work_ids,
    }


def _correct_float32_sum_to_one(
    values: np.ndarray, *, correction_offset: int
) -> np.ndarray:
    result = np.asarray(values, dtype=np.float32).copy()
    if (
        not len(result)
        or correction_offset < 0
        or correction_offset >= len(result)
        or not np.isfinite(result).all()
        or bool((result <= 0).any())
    ):
        raise R1TrainingError("work-family supervision weights are invalid")
    result /= np.sum(result, dtype=np.float32)
    # NumPy's pairwise float32 reduction can remain one ULP from 1.0 after a
    # single residual addition.  Move only the canonical highest-base-row
    # element by deterministic float32 ULPs until the exact sealed sum is 1.
    for _step in range(4096):
        current = np.sum(result, dtype=np.float32)
        if current == np.float32(1.0):
            break
        direction = np.float32(np.inf if current < 1.0 else -np.inf)
        result[correction_offset] = np.nextafter(
            result[correction_offset], direction, dtype=np.float32
        )
    if (
        not np.isfinite(result).all()
        or bool((result <= 0).any())
        or np.sum(result, dtype=np.float32) != np.float32(1.0)
    ):
        raise R1TrainingError("work-family weight normalization drifted")
    return result


def _direct_balanced_schedule(
    row_indices: np.ndarray,
    work_ids: np.ndarray,
    family_labels: np.ndarray,
    supervision_weights: np.ndarray,
    *,
    balance_mode: str,
    batch_size: int,
    seed: int,
) -> tuple[Sequence[np.ndarray], np.ndarray, Mapping[str, Any]]:
    rows = np.asarray(row_indices, dtype=np.int64)
    works = np.asarray(work_ids).astype(str)
    families = np.asarray(family_labels, dtype=np.int64)
    source_weights = np.asarray(supervision_weights, dtype=np.float32)
    if not (len(rows) == len(works) == len(families) == len(source_weights)) or not len(
        works
    ):
        raise R1TrainingError("work-family schedule input inventory drifted")
    ordering_strata = tuple(
        sorted(set(zip(works.tolist(), families.tolist(), strict=True)))
    )
    if any(
        family not in (r0.v8.BODY_FAMILY_INDEX, r0.v8.VARIANT_FAMILY_INDEX)
        for _, family in ordering_strata
    ):
        raise R1TrainingError("work-family schedule family inventory drifted")
    if batch_size < len(ordering_strata):
        raise R1TrainingError("batch size must cover every work-family stratum")

    if balance_mode == "work":
        balance_strata: tuple[tuple[str, int | None], ...] = tuple(
            (work_id, None) for work_id in sorted(set(works.tolist()))
        )
    elif balance_mode == "work_family":
        balance_strata = tuple(
            (work_id, int(family)) for work_id, family in ordering_strata
        )
    else:
        raise R1TrainingError("unsupported direct balance mode")

    normalized = np.zeros(len(works), dtype=np.float32)
    queues: dict[tuple[str, int], np.ndarray] = {}
    for work_id, family in ordering_strata:
        positions = np.flatnonzero((works == work_id) & (families == family)).astype(
            np.int64, copy=False
        )
        if not len(positions):  # pragma: no cover - constructed from observed strata
            raise R1TrainingError("empty work-family stratum")
        permutation = np.array(positions, copy=True)
        np.random.default_rng(
            r0._stable_schedule_seed(seed, f"{work_id}\0{family}", 0)
        ).shuffle(permutation)
        queues[(work_id, family)] = permutation

    descriptors: list[Mapping[str, Any]] = []
    for work_id, family in balance_strata:
        mask = works == work_id
        if family is not None:
            mask &= families == family
        positions = np.flatnonzero(mask).astype(np.int64, copy=False)
        correction_position = int(positions[np.argmax(rows[positions])])
        correction_offset = int(np.flatnonzero(positions == correction_position)[0])
        normalized_values = _correct_float32_sum_to_one(
            source_weights[positions], correction_offset=correction_offset
        )
        normalized[positions] = normalized_values
        descriptors.append(
            {
                "family_label": None if family is None else int(family),
                "normalization_correction_base_row_index": int(
                    rows[correction_position]
                ),
                "normalization_correction_weight_f32_hex": np.asarray(
                    normalized[correction_position], dtype="<f4"
                )
                .tobytes()
                .hex(),
                "position_sha256": _index_sha256(positions),
                "row_count": int(len(positions)),
                "scheduled_weight_sum": float(
                    np.sum(normalized_values, dtype=np.float32)
                ),
                "source_weight_sum": float(
                    np.sum(source_weights[positions], dtype=np.float64)
                ),
                "work_id": str(work_id),
            }
        )

    # Both balance modes consume exactly the same rows, order, batches, and one
    # optimizer call.  Only the sealed loss weights and fixed denominator differ.
    stratum_order = list(ordering_strata)
    np.random.default_rng(seed).shuffle(stratum_order)
    cursors = {stratum: 0 for stratum in ordering_strata}
    ordered: list[int] = []
    while len(ordered) < len(works):
        progressed = False
        for stratum in stratum_order:
            cursor = cursors[stratum]
            queue = queues[stratum]
            if cursor < len(queue):
                ordered.append(int(queue[cursor]))
                cursors[stratum] = cursor + 1
                progressed = True
        if not progressed:  # pragma: no cover - defensive
            raise R1TrainingError("work-family round robin stalled")
    ordered_array = np.asarray(ordered, dtype=np.int64)
    if set(ordered) != set(range(len(works))) or len(ordered) != len(works):
        raise R1TrainingError("work-family schedule did not consume each row once")
    batches = tuple(
        ordered_array[start : start + batch_size]
        for start in range(0, len(ordered_array), batch_size)
    )
    digest = hashlib.sha256()
    digest.update(rows[ordered_array].astype("<i8", copy=False).tobytes(order="C"))
    digest.update(normalized.astype("<f4", copy=False).tobytes(order="C"))
    weight_inventory_digest = hashlib.sha256()
    for position in np.argsort(rows, kind="stable"):
        weight_inventory_digest.update(
            np.asarray(rows[position], dtype="<i8").tobytes()
        )
        weight_inventory_digest.update(
            np.asarray(normalized[position], dtype="<f4").tobytes()
        )
    contract = {
        "algorithm": "unique_rows_sealed_family_round_robin_fixed_weight_v1",
        "balance_mode": balance_mode,
        "batch_count": len(batches),
        "batch_sizes": [int(len(batch)) for batch in batches],
        "effective_rows": int(len(ordered_array)),
        "loss_denominator": int(len(balance_strata)),
        "optimizer_calls": 1,
        "ordering_family_label_source": "sealed_direct_family_label",
        "ordering_stratum_count": len(ordering_strata),
        "oversampled_rows": 0,
        "schedule_sha256": digest.hexdigest(),
        "strata": descriptors,
        "stratum_count": len(balance_strata),
        "stratum_target_total_weight": 1.0,
        "supervision_weight_normalization": (
            "sealed_weight_divided_by_epoch_stratum_sealed_weight_sum"
        ),
        "row_weight_inventory_sha256": weight_inventory_digest.hexdigest(),
        "schedule_seed": int(seed),
        "scheduled_weight_sum_across_strata": float(
            sum(float(row["scheduled_weight_sum"]) for row in descriptors)
        ),
        "unique_rows": int(len(works)),
        "work_count": len(set(works.tolist())),
        "weighted_surrogate_not_metric_estimator": True,
    }
    return batches, normalized, contract


def _direct_batches(
    partition: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    epoch: int,
) -> tuple[Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]], Mapping[str, Any]]:
    indices = partition["direct_indices"]
    labels = partition["direct_labels"]
    weights = partition["direct_weights"]
    work_ids = partition["direct_work_ids"]
    seed = args.seed + epoch * 10_003 + 2
    position_batches, normalized, contract = _direct_balanced_schedule(
        indices,
        work_ids,
        labels,
        weights,
        balance_mode=args.direct_balance_mode,
        batch_size=args.batch_size,
        seed=seed,
    )
    batches = tuple(
        (indices[positions], labels[positions], normalized[positions])
        for positions in position_batches
    )
    row_digest = hashlib.sha256()
    for batch in batches:
        row_digest.update(batch[0].astype("<i8", copy=False).tobytes(order="C"))
    return batches, {
        **contract,
        "ordered_base_row_index_sha256": row_digest.hexdigest(),
    }


def _phase_order(args: argparse.Namespace) -> list[str]:
    phases = ["direct_family"]
    if float(args.page_body_ce_weight) > 0:
        phases.append("page_body")
    phases.append("base_preservation")
    return phases


def _objective_contract(
    args: argparse.Namespace, partition: Mapping[str, Any]
) -> Mapping[str, Any]:
    return {
        "anchor_kl_denominator": "mean_over_current_base_batch_rows_only",
        "anchor_kl_scope": ANCHOR_KL_SCOPE,
        "base_anchor_kl_rows": int(len(partition["base_indices"])),
        "base_anchor_kl_rows_that_are_direct": int(
            partition["contract"]["base_direct_intersection_rows"]
        ),
        "base_family_ce_mode": (
            "class_balanced_original_r3"
            if args.base_supervision_mode == "non_direct_preservation"
            else "class_balanced_original_r3_with_sealed_direct_override"
        ),
        "base_mode_ablation_bundles_ce_targets_kl_rows_and_base_step_count": True,
        "base_phase_is_last": True,
        "base_supervision_mode": str(args.base_supervision_mode),
        "candidate_score_parameters_frozen": True,
        "direct_anchor_kl_weight": 0.0,
        "direct_balance_mode": str(args.direct_balance_mode),
        "direct_family_ce_reduction": "fixed_epoch_stratum_denominator",
        "direct_optimizer_calls_per_epoch": 1,
        "direct_balance_ablation_holds_unique_rows_order_batches_and_optimizer_calls_constant": True,
        "direct_surrogate_metrics_are_unweighted": True,
        "direct_weighted_surrogate_claim": (
            "sealed_weight_divided_by_stratum_sealed_weight_sum_then_divided_by_stratum_count"
        ),
        "optimizer_phase_order": _phase_order(args),
        "page_anchor_kl_weight": 0.0,
        "page_optimizer_steps_enabled": float(args.page_body_ce_weight) > 0,
        "page_diagnostic_groups": int(partition["contract"]["page_groups"]),
        "page_diagnostic_rows": int(len(partition["page_indices"])),
        "page_zero_weight_behavior": "metric_only_no_optimizer_step",
        "partition_record_sha256": hashlib.sha256(
            canonical_json(partition["contract"]).encode("utf-8")
        ).hexdigest(),
        "residual_l2_scope": "every_executed_optimizer_step",
        "selectable_state_boundary": "after_base_preservation_only",
        "trajectory_phase_transcript_authority": "sealed_producer_attestation_only",
        "trajectory_replayed_by_strict_validator": False,
    }


def _configuration(args: argparse.Namespace) -> Mapping[str, Any]:
    return {
        "anchor_kl_scope": str(args.anchor_kl_scope),
        "anchor_kl_weight": float(args.anchor_kl_weight),
        "base_family_ce_weight": float(args.base_family_ce_weight),
        "base_supervision_mode": str(args.base_supervision_mode),
        "batch_size": int(args.batch_size),
        "device": str(args.device),
        "direct_balance_mode": str(args.direct_balance_mode),
        "direct_family_ce_weight": float(args.direct_family_ce_weight),
        "epochs": int(args.epochs),
        "evaluation_batch_size": int(args.evaluation_batch_size),
        "gradient_clip": float(args.gradient_clip),
        "learning_rate": float(args.learning_rate),
        "maximum_acceptable_regression": float(args.maximum_acceptable_regression),
        "maximum_family_regression": float(args.maximum_family_regression),
        "maximum_margin": float(args.maximum_margin),
        "maximum_preferred_regression": float(args.maximum_preferred_regression),
        "minimum_diagnostic_work_macro_improvement": float(
            args.minimum_diagnostic_work_macro_improvement
        ),
        "page_body_ce_weight": float(args.page_body_ce_weight),
        "residual_l2_weight": float(args.residual_l2_weight),
        "seed": int(args.seed),
        "weight_decay": float(args.weight_decay),
    }


def _candidate_invariance(cache: Mapping[str, Any]) -> Mapping[str, Any]:
    score_sha256 = r0._candidate_score_sha256(cache)
    return {
        "anchor_three_output_sha256": score_sha256,
        "body_candidate_scores_byte_exact": True,
        "internal_soft_gate_candidate_scores_byte_exact": True,
        "internal_soft_gate_candidate_scores_evaluated": False,
        "public_onnx_candidate_scores_contract": (
            "candidate_scores_is_body_candidate_scores_alias"
        ),
        "strict_metrics_use_hard_family_route": True,
        "three_output_sha256": score_sha256,
        "variant_candidate_scores_byte_exact": True,
    }


def _subgroup_margin_flip_diagnostics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
) -> Mapping[str, Any]:
    arrays = context["arrays"]
    original_labels = arrays["family_labels"].astype(np.int64, copy=False)
    validation_indices = np.flatnonzero(
        arrays["split"].astype(np.int64, copy=False) == 1
    )
    direct_indices = partition["direct_indices"]
    direct_labels = partition["direct_labels"]
    non_direct = partition["non_direct_indices"]
    definitions = {
        "direct_body": direct_indices[direct_labels == r0.v8.BODY_FAMILY_INDEX],
        "direct_variant": direct_indices[direct_labels == r0.v8.VARIANT_FAMILY_INDEX],
        "non_direct_body": non_direct[
            original_labels[non_direct] == r0.v8.BODY_FAMILY_INDEX
        ],
        "non_direct_variant": non_direct[
            original_labels[non_direct] == r0.v8.VARIANT_FAMILY_INDEX
        ],
        "page_body": partition["page_indices"],
        "validation_body": validation_indices[
            original_labels[validation_indices] == r0.v8.BODY_FAMILY_INDEX
        ],
        "validation_variant": validation_indices[
            original_labels[validation_indices] == r0.v8.VARIANT_FAMILY_INDEX
        ],
    }
    result: dict[str, Any] = {}
    for name, indices in definitions.items():
        if not len(indices):
            raise R1TrainingError(f"empty subgroup diagnostic: {name}")
        positions = torch.as_tensor(
            indices, dtype=torch.long, device=cache["hidden"].device
        )
        residual = model.residual_from_hidden(cache["hidden"][positions])
        candidate_logits = (
            cache["family_logits"][positions] + residual["family_logit_adjustment"]
        )
        anchor_top1 = cache["family_logits"][positions].argmax(dim=1)
        candidate_top1 = candidate_logits.argmax(dim=1)
        margin = residual["family_margin_delta"].detach().float()
        result[name] = {
            "anchor_body_rate": float(
                (anchor_top1 == r0.v8.BODY_FAMILY_INDEX).float().mean().item()
            ),
            "body_from_variant_flip_count": int(
                (
                    (anchor_top1 == r0.v8.VARIANT_FAMILY_INDEX)
                    & (candidate_top1 == r0.v8.BODY_FAMILY_INDEX)
                )
                .sum()
                .item()
            ),
            "candidate_body_rate": float(
                (candidate_top1 == r0.v8.BODY_FAMILY_INDEX).float().mean().item()
            ),
            "changed_family_count": int((anchor_top1 != candidate_top1).sum().item()),
            "mean_family_margin": float(margin.mean().item()),
            "positive_margin_rate": float((margin > 0).float().mean().item()),
            "row_count": int(len(indices)),
            "variant_from_body_flip_count": int(
                (
                    (anchor_top1 == r0.v8.BODY_FAMILY_INDEX)
                    & (candidate_top1 == r0.v8.VARIANT_FAMILY_INDEX)
                )
                .sum()
                .item()
            ),
        }
    return result


def _architecture_contract(maximum_margin: float) -> Mapping[str, Any]:
    return {
        "anchor_tensor_count": r0.EXPECTED_ANCHOR_TENSOR_COUNT,
        "family_logit_adjustment": "+margin/2 body, -margin/2 variant",
        "family_margin_formula": "B*tanh(raw_margin/B)",
        "hidden_dimension": r0.EXPECTED_HIDDEN_DIM,
        "hidden_source": "frozen_sample_candidate_norm_then_Linear1024x64_then_GELU",
        "maximum_margin": float(maximum_margin),
        "sidecar_parameter_count": r0.EXPECTED_TRAINABLE_PARAMETER_COUNT,
        "sidecar_tensor_count": len(r0.EXPECTED_SIDECAR_TENSORS),
        "zero_initialization_exact_anchor": True,
    }


def _trainable_contract(model: Any) -> Mapping[str, Any]:
    return {
        "anchor_parameter_count": sum(
            value.numel() for value in model.anchor_model.parameters()
        ),
        "anchor_parameter_names": sorted(
            name for name, _value in model.anchor_model.named_parameters()
        ),
        "anchor_parameters_frozen": True,
        "sidecar_parameter_count": r0.EXPECTED_TRAINABLE_PARAMETER_COUNT,
        "sidecar_parameter_names": sorted(r0.EXPECTED_SIDECAR_TENSORS),
    }


def _direct_accumulated_optimization_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    batches: Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]],
    fixed_denominator: int,
    family_ce_weight: float,
    residual_l2_weight: float,
    gradient_clip: float,
) -> Mapping[str, float]:
    if fixed_denominator < 1 or not batches:
        raise R1TrainingError("work-family loss denominator drifted")
    expected_rows = sum(len(batch[0]) for batch in batches)
    family_ce = None
    residual_l2 = None
    for indices, labels, row_weights in batches:
        outputs = r0._head_outputs_for_indices(torch, model, cache, indices)
        device = cache["hidden"].device
        label_tensor = torch.from_numpy(labels.astype(np.int64, copy=False)).to(device)
        weight_tensor = torch.from_numpy(row_weights.astype(np.float32, copy=False)).to(
            device
        )
        per_row = torch.nn.functional.cross_entropy(
            outputs["family_logits"].float(), label_tensor, reduction="none"
        )
        partial_ce = (per_row * weight_tensor).sum() / float(fixed_denominator)
        partial_l2 = outputs["family_margin_delta"].float().square().sum() / float(
            expected_rows
        )
        family_ce = partial_ce if family_ce is None else family_ce + partial_ce
        residual_l2 = partial_l2 if residual_l2 is None else residual_l2 + partial_l2
    if family_ce is None or residual_l2 is None:  # pragma: no cover - guarded above
        raise R1TrainingError("direct accumulated loss is empty")
    anchor_kl = family_ce * 0.0
    loss = float(family_ce_weight) * family_ce + float(residual_l2_weight) * residual_l2
    if not bool(torch.isfinite(loss)):
        raise R1TrainingError("work-family training loss became non-finite")
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(
        tuple(model.family_margin_head.parameters()), float(gradient_clip)
    )
    optimizer.step()
    return {
        "anchor_kl": float(anchor_kl.detach().item()),
        "family_ce": float(family_ce.detach().item()),
        "residual_l2": float(residual_l2.detach().item()),
        "total": float(loss.detach().item()),
    }


def _mean_losses(values: Sequence[Mapping[str, float]]) -> Mapping[str, float]:
    return r0._mean_losses(values)


def _diagnostic_checks(
    *,
    anchor_train: Mapping[str, Any],
    candidate_train: Mapping[str, Any],
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    minimum_improvement: float,
    candidate_outputs_exact: bool,
) -> Mapping[str, bool]:
    anchor_work = anchor_train["direct_family"]["work_macro"]
    candidate_work = candidate_train["direct_family"]["work_macro"]
    anchor_page = anchor_train["page_consistency"]
    candidate_page = candidate_train["page_consistency"]
    anchor_per_work = anchor_work["per_work"]
    candidate_per_work = candidate_work["per_work"]
    if set(anchor_per_work) != set(candidate_per_work):
        raise R1TrainingError("work-macro diagnostic inventory drifted")
    worst_per_work_balanced_delta = min(
        float(candidate_per_work[work_id]["balanced_accuracy"])
        - float(anchor_per_work[work_id]["balanced_accuracy"])
        for work_id in sorted(anchor_per_work)
    )
    return {
        "base_no_material_regression": all(base_regression.values()),
        "base_quality_gate_passed": bool(base_metrics["quality_gate_passed"]),
        "candidate_outputs_exact_anchor": bool(candidate_outputs_exact),
        "page_common_positive_top1_nonregression": float(
            candidate_page["all_rows_top1_in_common_positive_rate"]
        )
        >= float(anchor_page["all_rows_top1_in_common_positive_rate"]),
        "page_top1_all_agree_nonregression": float(
            candidate_page["top1_all_agree_rate"]
        )
        >= float(anchor_page["top1_all_agree_rate"]),
        "train_work_macro_balanced_accuracy_improved_by_required_margin": float(
            candidate_work["balanced_accuracy"]
        )
        >= float(anchor_work["balanced_accuracy"]) + float(minimum_improvement),
        "train_work_macro_body_accuracy_improved_by_required_margin": float(
            candidate_work["body_accuracy"]
        )
        >= float(anchor_work["body_accuracy"]) + float(minimum_improvement),
        "train_work_macro_variant_accuracy_delta_at_least_negative_0_005": float(
            candidate_work["variant_accuracy"]
        )
        >= float(anchor_work["variant_accuracy"]) - 0.005,
        "worst_per_work_balanced_accuracy_delta_at_least_negative_0_05": (
            worst_per_work_balanced_delta >= -0.05
        ),
    }


def _selection_key(
    *,
    epoch: int,
    diagnostic_passed: bool,
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    train_metrics: Mapping[str, Any],
) -> tuple[float, ...]:
    anchor_or_worthy = epoch == 0 or diagnostic_passed
    direct = _mapping(train_metrics["direct_family"], "direct train metrics")
    row = _mapping(direct["row"], "direct row metrics")
    work = _mapping(direct["work_macro"], "direct work-macro metrics")
    margin = _mapping(train_metrics["margin"], "margin diagnostics")
    return (
        float(anchor_or_worthy),
        float(epoch > 0 and diagnostic_passed),
        float(base_metrics["quality_gate_passed"]),
        float(all(base_regression.values())),
        float(work["balanced_accuracy"]),
        float(work["body_accuracy"]),
        float(work["variant_accuracy"]),
        float(row["balanced_accuracy"]),
        float(row["body_accuracy"]),
        -float(margin["mean_absolute_margin"]),
        -float(margin["saturation_rate_at_95pct_budget"]),
        r0.page_v3._base_selection_score(base_metrics),
        -float(epoch),
    )


def _zero_consumption(partition: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        "anchor_kl_base_rows": 0,
        "anchor_kl_direct_rows": 0,
        "anchor_kl_page_rows": 0,
        "base_batches": 0,
        "base_optimizer_calls": 0,
        "base_rows": 0,
        "base_schedule": None,
        "development_eval_rows": 0,
        "direct_batches": 0,
        "direct_optimizer_calls": 0,
        "direct_rows": 0,
        "direct_schedule": None,
        "optimizer_phase_order": [],
        "page_batches": 0,
        "page_optimizer_calls": 0,
        "page_rows": 0,
        "page_schedule": None,
        "selectable_state_boundary": "anchor_initialization",
    }


def _batch_consumption(
    partition: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    epoch: int,
) -> Mapping[str, Any]:
    if epoch == 0:
        return _zero_consumption(partition)
    direct_batches, direct_schedule = _direct_batches(partition, args, epoch=epoch)
    base_seed = args.seed + epoch * 10_003 + 1
    base_batches = r0._batches(
        partition["base_indices"],
        batch_size=args.batch_size,
        seed=base_seed,
    )
    base_order = np.concatenate(base_batches).astype(np.int64, copy=False)
    base_schedule = {
        "algorithm": "deterministic_unique_shuffle_v1",
        "batch_sizes": [int(len(batch)) for batch in base_batches],
        "ordered_base_row_index_sha256": _index_sha256(base_order),
        "schedule_seed": int(base_seed),
        "unique_rows": int(len(set(int(value) for value in base_order))),
    }
    if float(args.page_body_ce_weight) > 0:
        page_position_batches, page_schedule = r0._work_balanced_batches(
            partition["page_work_ids"],
            batch_size=args.batch_size,
            seed=args.seed + epoch * 10_003 + 3,
        )
        page_batches = len(page_position_batches)
        page_rows = sum(len(batch) for batch in page_position_batches)
        page_schedule = {**page_schedule, "balance_mode": "work"}
        page_optimizer_calls = page_batches
    else:
        page_batches = 0
        page_rows = 0
        page_schedule = None
        page_optimizer_calls = 0
    return {
        "anchor_kl_base_rows": int(sum(len(batch) for batch in base_batches)),
        "anchor_kl_direct_rows": 0,
        "anchor_kl_page_rows": 0,
        "base_batches": len(base_batches),
        "base_optimizer_calls": len(base_batches),
        "base_rows": int(sum(len(batch) for batch in base_batches)),
        "base_schedule": base_schedule,
        "development_eval_rows": 0,
        "direct_batches": len(direct_batches),
        "direct_optimizer_calls": 1,
        "direct_rows": int(sum(len(batch[0]) for batch in direct_batches)),
        "direct_schedule": direct_schedule,
        "optimizer_phase_order": _phase_order(args),
        "page_batches": int(page_batches),
        "page_optimizer_calls": int(page_optimizer_calls),
        "page_rows": int(page_rows),
        "page_schedule": page_schedule,
        "selectable_state_boundary": "after_base_preservation_only",
    }


def _epoch_record(
    torch: Any,
    model: Any,
    *,
    epoch: int,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
    anchor_base_metrics: Mapping[str, Any],
    anchor_train_metrics: Mapping[str, Any] | None,
    args: argparse.Namespace,
    mean_train_losses: Mapping[str, Any] | None,
    batch_consumption: Mapping[str, Any],
    candidate_outputs_exact: bool,
) -> Mapping[str, Any]:
    base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    train_metrics = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    reference_train = (
        train_metrics if anchor_train_metrics is None else anchor_train_metrics
    )
    checks = _diagnostic_checks(
        anchor_train=reference_train,
        candidate_train=train_metrics,
        base_metrics=base_metrics,
        base_regression=regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        candidate_outputs_exact=candidate_outputs_exact,
    )
    state_payload = r0._state_payload(r0._sidecar_state(model))
    record: dict[str, Any] = {
        "base_metrics": base_metrics,
        "base_no_material_regression": all(regression.values()),
        "base_regression_checks": regression,
        "batch_consumption": dict(batch_consumption),
        "checkpoint_selection_inputs": list(CHECKPOINT_SELECTION_INPUTS),
        "development_eval_consulted": False,
        "diagnostic_checks": checks,
        "diagnostic_worth_passed": epoch > 0 and all(checks.values()),
        "epoch": int(epoch),
        "sidecar_state": state_payload,
        "sidecar_state_sha256": hashlib.sha256(
            canonical_json(state_payload).encode("utf-8")
        ).hexdigest(),
        "subgroup_margin_flip_diagnostics": _subgroup_margin_flip_diagnostics(
            torch,
            model,
            cache=cache,
            context=context,
            partition=partition,
        ),
        "training_only_selection_metrics": train_metrics,
    }
    if mean_train_losses is not None:
        record["mean_train_losses"] = dict(mean_train_losses)
    return record


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R1TrainingError("PyTorch is required") from error
    _validate_options(args)
    context = _load_context(args, torch)
    partition = _build_training_partition(context, args)
    model = r0.build_shared_hidden_family_residual(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
    ).cpu()
    cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
    )
    all_rows = np.arange(cache["hidden"].shape[0], dtype=np.int64)
    outputs = r0._family_outputs_from_cache(model, cache, all_rows)
    if not torch.equal(outputs["family_logits"], cache["family_logits"]):
        raise R1TrainingError("zero-init family logits are not exact anchor")
    if float(outputs["family_margin_delta"].abs().max().item()) != 0.0:
        raise R1TrainingError("zero-init residual is not exact zero")
    consumption = _batch_consumption(partition, args, epoch=1)
    return {
        "anchor_tensor_count": len(context["model"].state_dict()),
        "base_row_count": int(len(context["arrays"]["split"])),
        "candidate_score_invariance": _candidate_invariance(cache),
        "context": r0._context_contract(context, args),
        "epoch1_batch_consumption": consumption,
        "family_override": partition["family_override"],
        "objective_contract": _objective_contract(args, partition),
        "partition": partition["contract"],
        "sidecar_parameter_count": r0.EXPECTED_TRAINABLE_PARAMETER_COUNT,
        "status": "ready_for_isolated_r1_shared_hidden_family_residual_training",
        "zero_init_exact_anchor": True,
    }


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R1TrainingError("PyTorch and safetensors are required") from error
    _validate_options(args)
    output = _safe_new_output(args.output_dir)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise R1TrainingError("CUDA was requested but is unavailable")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)

    started = time.monotonic()
    context = _load_context(args, torch)
    partition = _build_training_partition(context, args)
    candidate_ids = tuple(context["candidate_ids"])
    model = r0.build_shared_hidden_family_residual(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
    ).cpu()
    cpu_cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
    )
    candidate_invariance = _candidate_invariance(cpu_cache)
    model.to(device)
    cache = {
        name: value.to(device) if device.type != "cpu" else value
        for name, value in cpu_cache.items()
    }
    optimizer = torch.optim.AdamW(
        tuple(model.family_margin_head.parameters()),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    anchor_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    epoch0 = _epoch_record(
        torch,
        model,
        epoch=0,
        cache=cache,
        context=context,
        partition=partition,
        candidate_ids=candidate_ids,
        anchor_base_metrics=anchor_base_metrics,
        anchor_train_metrics=None,
        args=args,
        mean_train_losses=None,
        batch_consumption=_zero_consumption(partition),
        candidate_outputs_exact=True,
    )
    anchor_train_metrics = epoch0["training_only_selection_metrics"]
    history: list[Mapping[str, Any]] = [epoch0]
    best_record = epoch0
    best_state = r0._sidecar_state(model)
    best_key = _selection_key(
        epoch=0,
        diagnostic_passed=False,
        base_metrics=epoch0["base_metrics"],
        base_regression=epoch0["base_regression_checks"],
        train_metrics=epoch0["training_only_selection_metrics"],
    )

    for epoch in range(1, args.epochs + 1):
        model.train()
        model.anchor_model.eval()

        # Direct supervision is the first phase.  Both balance modes consume
        # the same 1,042 unique rows and make exactly one accumulated Adam step.
        direct_batches, direct_schedule = _direct_batches(partition, args, epoch=epoch)
        direct_loss = _direct_accumulated_optimization_step(
            torch,
            model,
            optimizer,
            cache=cache,
            batches=direct_batches,
            fixed_denominator=int(direct_schedule["loss_denominator"]),
            family_ce_weight=args.direct_family_ce_weight,
            residual_l2_weight=args.residual_l2_weight,
            gradient_clip=args.gradient_clip,
        )

        # A zero page weight is metric-only: no scheduler, no backward, no
        # optimizer.step, and therefore no AdamW weight-decay mutation.
        page_losses: list[Mapping[str, float]] = []
        if float(args.page_body_ce_weight) > 0:
            page_position_batches, _page_schedule = r0._work_balanced_batches(
                partition["page_work_ids"],
                batch_size=args.batch_size,
                seed=args.seed + epoch * 10_003 + 3,
            )
            for positions in page_position_batches:
                batch_indices, batch_labels, batch_weights = r0._batch_from_positions(
                    partition["page_indices"],
                    partition["page_labels"],
                    partition["page_weights"],
                    partition["page_work_ids"],
                    positions,
                )
                page_losses.append(
                    r0._optimization_step(
                        torch,
                        model,
                        optimizer,
                        cache=cache,
                        indices=batch_indices,
                        labels=batch_labels,
                        row_weights=batch_weights,
                        family_ce_weight=args.page_body_ce_weight,
                        anchor_kl_weight=0.0,
                        residual_l2_weight=args.residual_l2_weight,
                        class_balanced=False,
                        gradient_clip=args.gradient_clip,
                    )
                )

        # Base preservation is always last.  No post-base optimizer step may
        # occur before this epoch state is evaluated for checkpoint selection.
        base_losses: list[Mapping[str, float]] = []
        base_batches = r0._batches(
            partition["base_indices"],
            batch_size=args.batch_size,
            seed=args.seed + epoch * 10_003 + 1,
        )
        for batch in base_batches:
            base_losses.append(
                r0._optimization_step(
                    torch,
                    model,
                    optimizer,
                    cache=cache,
                    indices=batch,
                    labels=partition["base_labels"][batch],
                    row_weights=partition["base_weights"][batch],
                    family_ce_weight=args.base_family_ce_weight,
                    anchor_kl_weight=args.anchor_kl_weight,
                    residual_l2_weight=args.residual_l2_weight,
                    class_balanced=True,
                    gradient_clip=args.gradient_clip,
                )
            )
        mean_losses = {
            "base": _mean_losses(base_losses),
            "direct_family": direct_loss,
            "page_body": _mean_losses(page_losses) if page_losses else None,
        }
        record = _epoch_record(
            torch,
            model,
            epoch=epoch,
            cache=cache,
            context=context,
            partition=partition,
            candidate_ids=candidate_ids,
            anchor_base_metrics=anchor_base_metrics,
            anchor_train_metrics=anchor_train_metrics,
            args=args,
            mean_train_losses=mean_losses,
            batch_consumption=_batch_consumption(partition, args, epoch=epoch),
            candidate_outputs_exact=True,
        )
        history.append(record)
        key = _selection_key(
            epoch=epoch,
            diagnostic_passed=bool(record["diagnostic_worth_passed"]),
            base_metrics=record["base_metrics"],
            base_regression=record["base_regression_checks"],
            train_metrics=record["training_only_selection_metrics"],
        )
        if key > best_key:
            best_key = key
            best_record = record
            best_state = r0._sidecar_state(model)

    r0._apply_sidecar_state(model, best_state)
    selected_epoch = int(best_record["epoch"])
    selected_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    selected_base_regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        selected_base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    selected_train_metrics = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    development_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    development_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    anchor_state = r0._state_from_payload(torch, epoch0["sidecar_state"])
    selected_state = r0._sidecar_state(model)
    r0._apply_sidecar_state(model, anchor_state)
    anchor_development_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    anchor_development_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    r0._apply_sidecar_state(model, selected_state)
    selected_checks = _diagnostic_checks(
        anchor_train=anchor_train_metrics,
        candidate_train=selected_train_metrics,
        base_metrics=selected_base_metrics,
        base_regression=selected_base_regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        candidate_outputs_exact=True,
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        sidecar_path = staging / SIDECAR_FILE
        save_file(
            {name: value.contiguous() for name, value in selected_state.items()},
            str(sidecar_path),
        )
        context_contract = r0._context_contract(context, args)
        page_gradients_enabled = float(args.page_body_ce_weight) > 0
        selection = {
            "anchor_fallback_selected": selected_epoch == 0,
            "base_gradient_rows": int(len(partition["base_indices"])),
            "best_epoch": selected_epoch,
            "development_eval_consulted_during_checkpoint_selection": False,
            "development_eval_gradient_rows": 0,
            "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
            "direct_family_gradient_rows": int(len(partition["direct_indices"])),
            "hard_diagnostic_gate_required_for_nonzero_epoch": True,
            "model_selection_label_sources": list(MODEL_SELECTION_LABEL_SOURCES),
            "page_consistency_gradient_groups": (
                int(partition["contract"]["page_groups"])
                if page_gradients_enabled
                else 0
            ),
            "page_consistency_gradient_rows": (
                int(len(partition["page_indices"])) if page_gradients_enabled else 0
            ),
            "page_consistency_metric_groups": int(partition["contract"]["page_groups"]),
            "page_consistency_metric_rows": int(len(partition["page_indices"])),
            "selectable_state_boundary": "after_base_preservation_only",
            "selection_key_order": list(SELECTION_KEY_ORDER),
        }
        manifest = seal_record(
            {
                "anchor": context_contract["anchor"],
                "architecture": _architecture_contract(args.maximum_margin),
                "authority": dict(EXPECTED_AUTHORITY),
                "base_dataset": context_contract["base_dataset"],
                "base_metrics": {
                    "anchor": anchor_base_metrics,
                    "candidate": selected_base_metrics,
                    "regression_checks": selected_base_regression,
                },
                "candidate_ids": list(candidate_ids),
                "candidate_score_invariance": candidate_invariance,
                "configuration": _configuration(args),
                "development_diagnostics": {
                    "consulted_after_winner_selection_only": True,
                    "direct_family": {
                        "anchor": anchor_development_direct,
                        "candidate": development_direct,
                    },
                    "gradient_rows": 0,
                    "page_consistency": {
                        "anchor": anchor_development_page,
                        "candidate": development_page,
                    },
                    "used_for_checkpoint_selection": False,
                },
                "diagnostic_worth": {
                    "checks": selected_checks,
                    "passed": selected_epoch > 0 and all(selected_checks.values()),
                    "promotion_authority": False,
                },
                "direct_family_metrics": {
                    "anchor_train": anchor_train_metrics["direct_family"],
                    "candidate_train": selected_train_metrics["direct_family"],
                    "metrics_are_unweighted": True,
                },
                "family_override": partition["family_override"],
                "files": {
                    SIDECAR_FILE: {
                        "byte_size": sidecar_path.stat().st_size,
                        "sha256": sha256_file(sidecar_path),
                        "tensor_inventory": r0._tensor_inventory(selected_state),
                    }
                },
                "history": history,
                "objective_contract": _objective_contract(args, partition),
                "overlay": context_contract["overlay"],
                "overlay_metrics": {
                    "anchor_train": anchor_train_metrics["page_consistency"],
                    "candidate_train": selected_train_metrics["page_consistency"],
                    "metric_only_when_page_weight_zero": not page_gradients_enabled,
                },
                "partition": partition["contract"],
                "record_type": (
                    "manga_font_v3_shared_hidden_family_residual_r1_manifest"
                ),
                "runtime_boundary": dict(EXPECTED_RUNTIME_BOUNDARY),
                "schema_version": SCHEMA_VERSION,
                "selection": selection,
                "source_query_head": context_contract["source_query_head"],
                "trainable_parameters": _trainable_contract(model),
                "training_seconds": max(float(time.monotonic() - started), 1e-9),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    MANIFEST_FILE: sha256_file(manifest_path),
                    SIDECAR_FILE: sha256_file(sidecar_path),
                },
                "owner": OWNER,
                "safe_replace": False,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def _configuration_args(
    manifest: Mapping[str, Any], configuration: Mapping[str, Any]
) -> argparse.Namespace:
    anchor = _mapping(manifest["anchor"], "manifest anchor")
    base = _mapping(manifest["base_dataset"], "manifest base dataset")
    overlay = _mapping(manifest["overlay"], "manifest overlay")
    source = _mapping(manifest["source_query_head"], "manifest source query head")
    values = dict(configuration)
    values.update(
        {
            "anchor_adapter_dir": Path(str(anchor["directory"])),
            "base_npz": Path(str(base["file"])),
            "overlay_dir": Path(str(overlay["directory"])),
            "source_query_head": Path(str(source["file"])),
        }
    )
    return argparse.Namespace(**values)


def _validate_loss_mapping(value: Any, location: str) -> None:
    fields = _mapping(value, location)
    if set(fields) != {"anchor_kl", "family_ce", "residual_l2", "total"}:
        raise R1TrainingError(f"{location}: loss inventory drifted")
    if any(
        isinstance(number, bool)
        or not isinstance(number, (int, float))
        or not math.isfinite(float(number))
        or float(number) < 0
        for number in fields.values()
    ):
        raise R1TrainingError(f"{location}: invalid loss")


def _validate_mean_losses(
    value: Any, location: str, *, page_optimizer_enabled: bool
) -> None:
    losses = _mapping(value, location)
    if set(losses) != {"base", "direct_family", "page_body"}:
        raise R1TrainingError(f"{location}: objective inventory drifted")
    _validate_loss_mapping(losses["base"], f"{location}.base")
    _validate_loss_mapping(losses["direct_family"], f"{location}.direct_family")
    if float(losses["direct_family"]["anchor_kl"]) != 0.0:
        raise R1TrainingError(f"{location}: direct anchor KL is not zero")
    if page_optimizer_enabled:
        _validate_loss_mapping(losses["page_body"], f"{location}.page_body")
        if float(losses["page_body"]["anchor_kl"]) != 0.0:
            raise R1TrainingError(f"{location}: page anchor KL is not zero")
    elif losses["page_body"] is not None:
        raise R1TrainingError(f"{location}: metric-only page loss must be null")


def _strict_history_recompute(
    torch: Any,
    *,
    manifest: Mapping[str, Any],
    configuration: Mapping[str, Any],
    args: argparse.Namespace,
    model: Any,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    anchor_base_metrics: Mapping[str, Any],
) -> tuple[int, Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    history = manifest.get("history")
    epochs = int(configuration["epochs"])
    if (
        not isinstance(history, Sequence)
        or isinstance(history, (str, bytes))
        or len(history) != epochs + 1
    ):
        raise R1TrainingError("history inventory drifted")
    candidate_ids = tuple(context["candidate_ids"])
    anchor_train_metrics: Mapping[str, Any] | None = None
    best_index = 0
    best_key: tuple[float, ...] | None = None
    selected_state: Mapping[str, Any] | None = None
    selected_record: Mapping[str, Any] | None = None
    for expected_epoch, raw_record in enumerate(history):
        record = _mapping(raw_record, f"history[{expected_epoch}]")
        expected_keys = {
            "base_metrics",
            "base_no_material_regression",
            "base_regression_checks",
            "batch_consumption",
            "checkpoint_selection_inputs",
            "development_eval_consulted",
            "diagnostic_checks",
            "diagnostic_worth_passed",
            "epoch",
            "sidecar_state",
            "sidecar_state_sha256",
            "subgroup_margin_flip_diagnostics",
            "training_only_selection_metrics",
        }
        if expected_epoch > 0:
            expected_keys.add("mean_train_losses")
        if set(record) != expected_keys or record.get("epoch") != expected_epoch:
            raise R1TrainingError(f"history[{expected_epoch}] inventory drifted")
        if (
            record.get("checkpoint_selection_inputs")
            != list(CHECKPOINT_SELECTION_INPUTS)
            or record.get("development_eval_consulted") is not False
        ):
            raise R1TrainingError(
                f"history[{expected_epoch}] consulted forbidden diagnostics"
            )
        expected_consumption = _batch_consumption(partition, args, epoch=expected_epoch)
        if record.get("batch_consumption") != expected_consumption:
            raise R1TrainingError(
                f"history[{expected_epoch}] batch consumption drifted"
            )
        if expected_epoch > 0:
            _validate_mean_losses(
                record.get("mean_train_losses"),
                f"history[{expected_epoch}].mean_train_losses",
                page_optimizer_enabled=float(configuration["page_body_ce_weight"]) > 0,
            )
        payload = _mapping(
            record.get("sidecar_state"), f"history[{expected_epoch}].sidecar_state"
        )
        state_sha256 = hashlib.sha256(
            canonical_json(payload).encode("utf-8")
        ).hexdigest()
        if record.get("sidecar_state_sha256") != state_sha256:
            raise R1TrainingError(
                f"history[{expected_epoch}] sidecar state seal drifted"
            )
        state = r0._state_from_payload(torch, payload)
        if expected_epoch == 0 and any(
            bool(torch.count_nonzero(value)) for value in state.values()
        ):
            raise R1TrainingError("epoch zero sidecar is not exact zero")
        r0._apply_sidecar_state(model, state)
        base_metrics = r0._evaluate_base_from_cache(
            torch,
            model,
            cache=cache,
            arrays=context["arrays"],
            candidate_ids=candidate_ids,
        )
        regression = r0.page_v3.base_regression_checks(
            anchor_base_metrics,
            base_metrics,
            maximum_acceptable_regression=float(
                configuration["maximum_acceptable_regression"]
            ),
            maximum_preferred_regression=float(
                configuration["maximum_preferred_regression"]
            ),
            maximum_family_regression=float(configuration["maximum_family_regression"]),
        )
        train_metrics = r0._training_metrics(
            torch,
            model,
            cache=cache,
            groups=context["groups"],
            candidate_ids=candidate_ids,
            margin_indices=partition["all_base_indices"],
        )
        if anchor_train_metrics is None:
            anchor_train_metrics = train_metrics
        checks = _diagnostic_checks(
            anchor_train=anchor_train_metrics,
            candidate_train=train_metrics,
            base_metrics=base_metrics,
            base_regression=regression,
            minimum_improvement=float(
                configuration["minimum_diagnostic_work_macro_improvement"]
            ),
            candidate_outputs_exact=True,
        )
        expected_passed = expected_epoch > 0 and all(checks.values())
        _assert_nested_close(
            record.get("base_metrics"),
            base_metrics,
            f"history[{expected_epoch}].base_metrics",
        )
        if (
            record.get("base_regression_checks") != regression
            or record.get("base_no_material_regression") is not all(regression.values())
            or record.get("diagnostic_checks") != checks
            or record.get("diagnostic_worth_passed") is not expected_passed
        ):
            raise R1TrainingError(
                f"history[{expected_epoch}] hard diagnostic claim drifted"
            )
        _assert_nested_close(
            record.get("training_only_selection_metrics"),
            train_metrics,
            f"history[{expected_epoch}].training_only_selection_metrics",
        )
        subgroup = _subgroup_margin_flip_diagnostics(
            torch,
            model,
            cache=cache,
            context=context,
            partition=partition,
        )
        _assert_nested_close(
            record.get("subgroup_margin_flip_diagnostics"),
            subgroup,
            f"history[{expected_epoch}].subgroup_margin_flip_diagnostics",
        )
        key = _selection_key(
            epoch=expected_epoch,
            diagnostic_passed=expected_passed,
            base_metrics=base_metrics,
            base_regression=regression,
            train_metrics=train_metrics,
        )
        if best_key is None or key > best_key:
            best_key = key
            best_index = expected_epoch
            selected_state = state
            selected_record = record
    if (
        selected_state is None
        or selected_record is None
        or anchor_train_metrics is None
    ):
        raise R1TrainingError("history selection failed")
    return best_index, selected_state, selected_record, anchor_train_metrics


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R1TrainingError("PyTorch is required") from error
    expanded = output_dir.expanduser().absolute()
    if r0.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R1TrainingError("output cannot be linked or reparsed")
    root = expanded.resolve()
    if (
        not root.is_dir()
        or r0.overlay_v3._contains_link_or_reparse(root)
        or {path.name for path in root.iterdir()} != OUTPUT_FILES
    ):
        raise R1TrainingError("output inventory drifted")
    marker_path = root / MARKER_FILE
    manifest_path = root / MANIFEST_FILE
    sidecar_path = root / SIDECAR_FILE
    marker = _read_json(marker_path, "ownership marker")
    manifest = _read_json(manifest_path, "manifest")
    _validate_record_seal(marker, "ownership marker")
    _validate_record_seal(manifest, "manifest")
    if set(marker) != {
        "artifacts",
        "owner",
        "record_sha256",
        "safe_replace",
        "schema_version",
    }:
        raise R1TrainingError("ownership marker inventory drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not False
        or set(marker_artifacts) != {MANIFEST_FILE, SIDECAR_FILE}
        or marker_artifacts.get(MANIFEST_FILE) != sha256_file(manifest_path)
        or marker_artifacts.get(SIDECAR_FILE) != sha256_file(sidecar_path)
    ):
        raise R1TrainingError("ownership marker binding drifted")
    if (
        set(manifest) != EXPECTED_MANIFEST_KEYS
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v3_shared_hidden_family_residual_r1_manifest"
        or manifest.get("authority") != EXPECTED_AUTHORITY
        or manifest.get("runtime_boundary") != EXPECTED_RUNTIME_BOUNDARY
    ):
        raise R1TrainingError("manifest authority or schema drifted")
    training_seconds = manifest.get("training_seconds")
    if (
        isinstance(training_seconds, bool)
        or not isinstance(training_seconds, (int, float))
        or not math.isfinite(float(training_seconds))
        or float(training_seconds) <= 0
    ):
        raise R1TrainingError("training seconds drifted")
    configuration = _mapping(manifest.get("configuration"), "configuration")
    if set(configuration) != EXPECTED_CONFIGURATION_KEYS:
        raise R1TrainingError("configuration inventory drifted")
    args = _configuration_args(manifest, configuration)
    _validate_options(args)
    if configuration.get("device") not in {"cpu", "cuda"}:
        raise R1TrainingError("training device claim drifted")

    files = _mapping(manifest.get("files"), "manifest files")
    if set(files) != {SIDECAR_FILE}:
        raise R1TrainingError("manifest file inventory drifted")
    descriptor = _mapping(files[SIDECAR_FILE], "sidecar descriptor")
    if set(descriptor) != {"byte_size", "sha256", "tensor_inventory"} or (
        descriptor.get("byte_size") != sidecar_path.stat().st_size
        or descriptor.get("sha256") != sha256_file(sidecar_path)
    ):
        raise R1TrainingError("sidecar descriptor drifted")
    checkpoint_state = r0._load_sidecar_state(torch, sidecar_path)
    if descriptor.get("tensor_inventory") != r0._tensor_inventory(checkpoint_state):
        raise R1TrainingError("sidecar tensor inventory drifted")

    context = _load_context(args, torch)
    expected_context = r0._context_contract(context, args)
    for key in ("anchor", "base_dataset", "overlay", "source_query_head"):
        if manifest.get(key) != expected_context[key]:
            raise R1TrainingError(f"{key} binding drifted")
    candidate_ids = tuple(context["candidate_ids"])
    if manifest.get("candidate_ids") != list(candidate_ids):
        raise R1TrainingError("candidate IDs drifted")
    if manifest.get("architecture") != _architecture_contract(
        float(configuration["maximum_margin"])
    ):
        raise R1TrainingError("residual architecture drifted")
    model = r0.build_shared_hidden_family_residual(
        torch,
        anchor_model=context["model"],
        maximum_margin=float(configuration["maximum_margin"]),
    ).cpu()
    if manifest.get("trainable_parameters") != _trainable_contract(model) or any(
        parameter.requires_grad for parameter in model.anchor_model.parameters()
    ):
        raise R1TrainingError("trainable parameter boundary drifted")
    partition = _build_training_partition(context, args)
    if manifest.get("partition") != partition["contract"]:
        raise R1TrainingError("training partition drifted")
    if manifest.get("family_override") != partition["family_override"]:
        raise R1TrainingError("family override contract drifted")
    if manifest.get("objective_contract") != _objective_contract(args, partition):
        raise R1TrainingError("objective contract drifted")
    cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(configuration["evaluation_batch_size"]),
    )
    candidate_invariance = _candidate_invariance(cache)
    if manifest.get("candidate_score_invariance") != candidate_invariance:
        raise R1TrainingError("candidate score invariance drifted")
    anchor_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    best_epoch, selected_state, selected_record, anchor_train_metrics = (
        _strict_history_recompute(
            torch,
            manifest=manifest,
            configuration=configuration,
            args=args,
            model=model,
            cache=cache,
            context=context,
            partition=partition,
            anchor_base_metrics=anchor_base_metrics,
        )
    )
    page_gradients_enabled = float(configuration["page_body_ce_weight"]) > 0
    expected_selection = {
        "anchor_fallback_selected": best_epoch == 0,
        "base_gradient_rows": int(len(partition["base_indices"])),
        "best_epoch": best_epoch,
        "development_eval_consulted_during_checkpoint_selection": False,
        "development_eval_gradient_rows": 0,
        "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
        "direct_family_gradient_rows": int(len(partition["direct_indices"])),
        "hard_diagnostic_gate_required_for_nonzero_epoch": True,
        "model_selection_label_sources": list(MODEL_SELECTION_LABEL_SOURCES),
        "page_consistency_gradient_groups": (
            int(partition["contract"]["page_groups"]) if page_gradients_enabled else 0
        ),
        "page_consistency_gradient_rows": (
            int(len(partition["page_indices"])) if page_gradients_enabled else 0
        ),
        "page_consistency_metric_groups": int(partition["contract"]["page_groups"]),
        "page_consistency_metric_rows": int(len(partition["page_indices"])),
        "selectable_state_boundary": "after_base_preservation_only",
        "selection_key_order": list(SELECTION_KEY_ORDER),
    }
    selection = _mapping(manifest.get("selection"), "selection")
    if set(selection) != EXPECTED_SELECTION_KEYS or selection != expected_selection:
        raise R1TrainingError("selection claim drifted")
    if r0._state_payload(checkpoint_state) != r0._state_payload(selected_state):
        raise R1TrainingError("exported sidecar is not the selected history state")
    if best_epoch == 0 and any(
        bool(torch.count_nonzero(value)) for value in checkpoint_state.values()
    ):
        raise R1TrainingError("anchor fallback sidecar is not exact zero")

    r0._apply_sidecar_state(model, selected_state)
    selected_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    selected_regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        selected_base_metrics,
        maximum_acceptable_regression=float(
            configuration["maximum_acceptable_regression"]
        ),
        maximum_preferred_regression=float(
            configuration["maximum_preferred_regression"]
        ),
        maximum_family_regression=float(configuration["maximum_family_regression"]),
    )
    selected_train = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    zero_state = r0._state_from_payload(torch, manifest["history"][0]["sidecar_state"])
    r0._apply_sidecar_state(model, zero_state)
    anchor_dev_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    anchor_dev_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    r0._apply_sidecar_state(model, selected_state)
    selected_dev_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    selected_dev_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    _assert_nested_close(
        manifest.get("base_metrics"),
        {
            "anchor": anchor_base_metrics,
            "candidate": selected_base_metrics,
            "regression_checks": selected_regression,
        },
        "base metrics",
    )
    _assert_nested_close(
        manifest.get("direct_family_metrics"),
        {
            "anchor_train": anchor_train_metrics["direct_family"],
            "candidate_train": selected_train["direct_family"],
            "metrics_are_unweighted": True,
        },
        "direct-family metrics",
    )
    _assert_nested_close(
        manifest.get("overlay_metrics"),
        {
            "anchor_train": anchor_train_metrics["page_consistency"],
            "candidate_train": selected_train["page_consistency"],
            "metric_only_when_page_weight_zero": not page_gradients_enabled,
        },
        "overlay metrics",
    )
    expected_development = {
        "consulted_after_winner_selection_only": True,
        "direct_family": {
            "anchor": anchor_dev_direct,
            "candidate": selected_dev_direct,
        },
        "gradient_rows": 0,
        "page_consistency": {
            "anchor": anchor_dev_page,
            "candidate": selected_dev_page,
        },
        "used_for_checkpoint_selection": False,
    }
    _assert_nested_close(
        manifest.get("development_diagnostics"),
        expected_development,
        "development diagnostics",
    )
    selected_checks = _diagnostic_checks(
        anchor_train=anchor_train_metrics,
        candidate_train=selected_train,
        base_metrics=selected_base_metrics,
        base_regression=selected_regression,
        minimum_improvement=float(
            configuration["minimum_diagnostic_work_macro_improvement"]
        ),
        candidate_outputs_exact=True,
    )
    expected_worth = {
        "checks": selected_checks,
        "passed": best_epoch > 0 and all(selected_checks.values()),
        "promotion_authority": False,
    }
    if manifest.get("diagnostic_worth") != expected_worth:
        raise R1TrainingError("diagnostic-worth claim drifted")
    if selected_record["diagnostic_worth_passed"] is not expected_worth["passed"]:
        raise R1TrainingError("selected history worth claim drifted")
    return {
        "best_epoch": best_epoch,
        "candidate_score_sha256": candidate_invariance["three_output_sha256"],
        "diagnostic_worth": bool(expected_worth["passed"]),
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(manifest_path),
        "output_dir": str(root),
        "read_only_recomputation": True,
        "schema_version": SCHEMA_VERSION,
        "sidecar_sha256": sha256_file(sidecar_path),
        "status": "valid_nonpromotable_r1_shared_hidden_family_residual",
        "trajectory_replay_authority": False,
    }


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    validation = validate_output(args.output_dir)
    return {
        **validation,
        "evaluation_authority": False,
        "note": "strict CPU metric recomputation; CUDA trajectory is producer-attested only",
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
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--evaluation-batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--base-family-ce-weight", type=float, default=0.35)
    parser.add_argument("--direct-family-ce-weight", type=float, default=0.10)
    parser.add_argument("--page-body-ce-weight", type=float, default=0.0)
    parser.add_argument("--anchor-kl-weight", type=float, default=5.0)
    parser.add_argument("--residual-l2-weight", type=float, default=0.01)
    parser.add_argument(
        "--maximum-margin", type=float, choices=r0.MAX_MARGIN_CHOICES, default=1.0
    )
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument(
        "--minimum-diagnostic-work-macro-improvement", type=float, default=0.02
    )
    parser.add_argument("--seed", type=int, default=20260820)
    parser.add_argument(
        "--base-supervision-mode",
        choices=BASE_SUPERVISION_MODES,
        default="non_direct_preservation",
    )
    parser.add_argument(
        "--direct-balance-mode",
        choices=DIRECT_BALANCE_MODES,
        default="work_family",
    )
    parser.add_argument(
        "--anchor-kl-scope", choices=(ANCHOR_KL_SCOPE,), default=ANCHOR_KL_SCOPE
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    _add_shared_arguments(preflight_parser)
    preflight_parser.set_defaults(device="cpu")
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
    args = build_parser().parse_args()
    if args.command == "preflight":
        result = preflight(args)
    elif args.command == "train":
        result = train(args)
    elif args.command == "validate":
        result = validate_output(args.output_dir)
    elif args.command == "evaluate":
        result = evaluate(args)
    else:  # pragma: no cover - argparse owns choices
        raise R1TrainingError(f"unsupported command: {args.command}")
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
