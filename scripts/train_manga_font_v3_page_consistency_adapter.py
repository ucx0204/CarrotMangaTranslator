#!/usr/bin/env python3
"""Train an experimental, production-unwired page-consistency v3 adapter.

The deployable architecture and state dictionary remain byte-contract
compatible with the production r3h v8 adapter.  The exact r3h artifact is both
the initialization and a frozen anchor.  A sealed work-disjoint overlay adds
only low-weight, reviewed-support losses for ordinary same-page dialogue.

The overlay development split is never used by gradients or checkpoint
selection.  It is opened exactly once after a checkpoint has been selected by
base-r3 validation plus overlay-*train* objectives.  A failed candidate is
sealed as rejected without exporting checkpoint bytes.
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
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_manga_font_v3_page_consistency_overlay as overlay_v3
    from scripts import train_manga_font_student_v8_role_family_adapter as v8
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_v3_page_consistency_overlay as overlay_v3
    import train_manga_font_student_v8_role_family_adapter as v8


SCHEMA_VERSION = "manga-font-v3-page-consistency-adapter-v1"
OWNER = "carrot-manga-translator/manga-font-v3-page-consistency-adapter-v1"
CHECKPOINT_FILE = "role-family-adapter.safetensors"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-page-consistency-adapter-v1-owned.json"
EXPECTED_MARKER_KEYS = frozenset(
    {"artifacts", "owner", "record_sha256", "safe_replace", "schema_version"}
)
EXPECTED_MANIFEST_KEYS = frozenset(
    {
        "anchor",
        "architecture",
        "authority",
        "base_dataset",
        "base_metrics",
        "candidate_ids",
        "candidate_weighting",
        "configuration",
        "development_diagnostics",
        "diagnostics",
        "direct_family_metrics",
        "export_decision",
        "family_override",
        "files",
        "history",
        "overlay",
        "overlay_metrics",
        "record_sha256",
        "record_type",
        "runtime_architecture_unchanged",
        "schema_version",
        "selection",
        "source_query_head",
        "trainable_parameters",
        "training_seconds",
    }
)

EXPECTED_ANCHOR_CHECKPOINT_SHA256 = (
    "ff580ef87c949d9b5cc8f4552490015cb621814d6cd5c122018def415792f3de"
)
EXPECTED_ANCHOR_MANIFEST_SHA256 = (
    "4512537525d09443d15506af17204aff498a0bab4b803eeff6680acfeeff1bba"
)
EXPECTED_ANCHOR_MANIFEST_RECORD_SHA256 = (
    "0bc05d1d29280a82be733f3b293aa7fb8e551bfd7ea67fab6ff3c3614fb746df"
)
EXPECTED_BASE_NPZ_SHA256 = (
    "901ee8a0f6e72d42ee917a6827bc76009245ebeda0c479e9e02feb4238107f83"
)
EXPECTED_SOURCE_QUERY_HEAD_SHA256 = (
    "40dc710c863994bd4d66ba15d6c5fb025e2ccc4001b47bf0b2d02efb3cf1fffb"
)

DEFAULT_BASE_NPZ = overlay_v3.DEFAULT_BASE_NPZ
DEFAULT_OVERLAY_DIR = Path(
    "artifacts/manga-font-v3-page-consistency-overlay-training-only-v1"
)
DEFAULT_ANCHOR_DIR = Path(
    "artifacts/manga-font-student-v81-role-family-adapter-production-r3h"
)
DEFAULT_SOURCE_QUERY_HEAD = Path(
    "artifacts/manga-font-student-v7-mass21-r5-epoch1-qa-v1/"
    "best-fontquery-head.safetensors"
)

FAMILY_LOGIT_SHIFT_GRID = (0.0, 1.0, 2.0, 3.0, 4.0)
CANDIDATE_DELTA_BUDGET_GRID = (0.0, 0.1, 0.2, 0.35)
FAMILY_TRAINABLE_PREFIXES = ("family_head.", "family_norm.")
MODEL_SELECTION_LABEL_SOURCES = (
    "base_r3_validation",
    "direct_family_train_only_balanced_and_body_accuracy",
    "page_consistency_train_only_runtime_metrics",
)
CHECKPOINT_SELECTION_INPUTS = (
    "base_r3_validation",
    "direct_family_train_balanced_accuracy",
    "direct_family_train_body_accuracy",
    "page_consistency_train_runtime_metrics",
)
EXPECTED_DEVELOPMENT_EVAL_WORK_IDS = (
    "24c7fa20-0a86-4110-950d-b219afda0105",
    "c4f9c4dc-2149-4501-965b-38f39a1f1f4f",
    "c7b6d90a-ea16-401b-9287-0bdc448bdd80",
)
EXPECTED_AUTHORITY = {
    "automatic_release_authority": False,
    "development_eval_is_locked_holdout": False,
    "development_eval_is_post_selection_diagnostic_only": True,
    "evaluation_authority": False,
    "experimental_qa_only": True,
    "human_gold": False,
    "production_integration_allowed": False,
    "training_label_authority": "training_only_non_human_visual",
}
EXPECTED_BASE_REGRESSION_CHECKS = frozenset(
    {
        "all_acceptable_nonmaterial_regression",
        "all_family_nonmaterial_regression",
        "all_preferred_nonmaterial_regression",
        "all_single_day_body_false_zero",
        "visual_acceptable_nonmaterial_regression",
        "visual_family_nonmaterial_regression",
        "visual_preferred_nonmaterial_regression",
        "visual_single_day_body_false_zero",
    }
)
EXPECTED_SELECTION_KEYS = frozenset(
    {
        "anchor_fallback_selected",
        "base_gradient_rows",
        "best_epoch",
        "development_eval_consulted_during_checkpoint_selection",
        "development_eval_excluded_work_ids",
        "development_eval_gradient_rows",
        "development_eval_label_rows_consulted_during_checkpoint_selection",
        "direct_family_gradient_rows",
        "model_selection_label_sources",
        "page_consistency_gradient_groups",
        "page_consistency_gradient_rows",
        "selection_key_order",
    }
)
EXPECTED_CONFIGURATION_KEYS = frozenset(
    {
        "anchor_output_weight",
        "anchor_parameter_weight",
        "base_loss_weight",
        "batch_size",
        "bias_l2_weight",
        "candidate_distribution_slack",
        "candidate_distribution_temperature",
        "candidate_distribution_weight",
        "candidate_parameter_lr_multiplier",
        "common_positive_mass_weight",
        "consistency_js_weight",
        "device",
        "direct_body_ce_weight",
        "direct_family_batch_size",
        "direct_family_ce_weight",
        "effective_overlay_weights",
        "epochs",
        "evaluation_batch_size",
        "family_weight",
        "gradient_clip",
        "learning_rate",
        "maximum_acceptable_regression",
        "maximum_body_rate_regression",
        "maximum_candidate_score_delta",
        "maximum_family_regression",
        "maximum_preferred_regression",
        "minimum_overlay_js_improvement",
        "minimum_overlay_rate_improvement",
        "overlay_groups_per_batch",
        "rare_class_weight_cap",
        "sample_residual_l2_weight",
        "seed",
        "single_day_hard_negative_margin",
        "single_day_hard_negative_weight",
        "supervised_single_day_hard_negative_weight",
        "trainable_scope",
        "weight_decay",
    }
)
EXPECTED_FAMILY_PARAMETER_NAMES = (
    "family_norm.weight",
    "family_norm.bias",
    "family_head.weight",
    "family_head.bias",
)
EXPECTED_CANDIDATE_PARAMETER_NAMES = (
    "body_query_weight_logits",
    "variant_query_weight_logits",
    "body_logit_scale",
    "variant_logit_scale",
    "family_candidate_bias_logits",
    "sample_candidate_norm.weight",
    "sample_candidate_norm.bias",
    "sample_candidate_residual.0.weight",
    "sample_candidate_residual.0.bias",
    "sample_candidate_residual.2.weight",
    "sample_candidate_residual.2.bias",
)
EXPECTED_FAMILY_PARAMETER_COUNT = 4_098
EXPECTED_CANDIDATE_PARAMETER_COUNT = 70_430
SELECTION_KEY_ORDER = (
    "base_v8_quality_gate",
    "base_no_material_regression",
    "direct_family_train_balanced_accuracy",
    "direct_family_train_body_accuracy",
    "direct_family_train_variant_accuracy",
    "page_train_all_rows_top1_in_common_positive_rate",
    "page_train_top1_all_agree_rate",
    "page_train_negative_mean_js",
    "page_train_mean_common_positive_mass",
    "base_r3_validation_score",
)
EXPECTED_EXPORT_CHECKS = frozenset(
    {
        "base_all_acceptable_nonmaterial_regression",
        "base_all_family_nonmaterial_regression",
        "base_all_preferred_nonmaterial_regression",
        "base_all_single_day_body_false_zero",
        "base_validation_candidate_score_delta_within_bound",
        "base_v8_quality_gate_passed",
        "base_visual_acceptable_nonmaterial_regression",
        "base_visual_family_nonmaterial_regression",
        "base_visual_preferred_nonmaterial_regression",
        "base_visual_single_day_body_false_zero",
        "development_eval_gradient_rows_zero",
        "runtime_architecture_unchanged",
    }
)
EXPECTED_OVERLAY_IMPROVEMENT_CHECKS = frozenset(
    {
        "all_rows_common_positive_rate_nonregression",
        "body_prediction_rate_nonregression",
        "body_probability_nonregression",
        "mean_js_improved",
        "top1_agreement_or_common_positive_improved",
        "top1_all_agree_rate_nonregression",
    }
)
EXPECTED_CANDIDATE_IDS = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
    "black-and-white-picture",
    "black-han-sans",
    "gasoek-one",
    "kirang-haerang",
    "nanum-brush-script",
    "single-day",
)
EXPECTED_FAMILY_OVERRIDE_COUNTS = {
    "base_train_rows": 12_923,
    "direct_development_eval_body_to_variant_conflicts": 3,
    "direct_development_eval_conflicts": 191,
    "direct_development_eval_rows": 305,
    "direct_development_eval_unchanged": 114,
    "direct_development_eval_variant_to_body_conflicts": 188,
    "direct_train_body_targets": 667,
    "direct_train_body_to_variant_conflicts": 16,
    "direct_train_conflicts": 630,
    "direct_train_rows": 1_042,
    "direct_train_unchanged": 412,
    "direct_train_variant_targets": 375,
    "direct_train_variant_to_body_conflicts": 614,
    "non_direct_base_train_rows": 11_881,
}


class PageConsistencyTrainingError(ValueError):
    """Raised when an experimental v3 training boundary is unsafe."""


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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_new_output(path: Path) -> Path:
    try:
        return overlay_v3._safe_new_output(path)
    except overlay_v3.PageConsistencyOverlayError as error:
        raise PageConsistencyTrainingError(str(error)) from error


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = hashlib.sha256(
        canonical_json(result).encode("utf-8")
    ).hexdigest()
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise PageConsistencyTrainingError(f"{location}: invalid record seal")
    body = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    if actual != expected:
        raise PageConsistencyTrainingError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PageConsistencyTrainingError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PageConsistencyTrainingError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _assert_nested_close(
    actual: Any,
    expected: Any,
    location: str,
    *,
    absolute_tolerance: float = 5e-6,
    relative_tolerance: float = 5e-5,
) -> None:
    if isinstance(actual, Mapping) and isinstance(expected, Mapping):
        if set(actual) != set(expected):
            raise PageConsistencyTrainingError(f"{location}: key inventory drifted")
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
            raise PageConsistencyTrainingError(f"{location}: length drifted")
        for index, (actual_value, expected_value) in enumerate(
            zip(actual, expected, strict=True)
        ):
            _assert_nested_close(
                actual_value,
                expected_value,
                f"{location}[{index}]",
                absolute_tolerance=absolute_tolerance,
                relative_tolerance=relative_tolerance,
            )
        return
    if isinstance(actual, bool) or isinstance(expected, bool):
        if actual is not expected:
            raise PageConsistencyTrainingError(f"{location}: boolean drifted")
        return
    numeric = (int, float, np.integer, np.floating)
    if isinstance(actual, numeric) and isinstance(expected, numeric):
        if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
            raise PageConsistencyTrainingError(f"{location}: non-finite value")
        if isinstance(actual, (int, np.integer)) and isinstance(
            expected, (int, np.integer)
        ):
            if int(actual) != int(expected):
                raise PageConsistencyTrainingError(f"{location}: integer drifted")
        elif not math.isclose(
            float(actual),
            float(expected),
            abs_tol=absolute_tolerance,
            rel_tol=relative_tolerance,
        ):
            raise PageConsistencyTrainingError(f"{location}: numeric drifted")
        return
    if actual != expected:
        raise PageConsistencyTrainingError(f"{location}: value drifted")


def _json_contract_value(value: Any) -> Any:
    """Normalize runtime-only tuple containers to their sealed JSON representation."""

    return json.loads(canonical_json(value))


def effective_overlay_weights(
    *,
    trainable_scope: str,
    direct_body_ce_weight: float,
    direct_family_ce_weight: float,
    consistency_js_weight: float,
    common_positive_mass_weight: float,
) -> Mapping[str, Any]:
    requested = {
        "common_positive_mass": float(common_positive_mass_weight),
        "consistency_js": float(consistency_js_weight),
        "direct_body_ce": float(direct_body_ce_weight),
        "direct_family_ce": float(direct_family_ce_weight),
    }
    if trainable_scope == "family-head-only":
        return {
            "candidate_objectives_disabled": True,
            "disable_reason": "candidate_parameters_frozen_by_family_head_only_scope",
            "effective": {
                "common_positive_mass": 0.0,
                "consistency_js": 0.0,
                "direct_body_ce": requested["direct_body_ce"],
                "direct_family_ce": requested["direct_family_ce"],
            },
            "requested": requested,
        }
    if trainable_scope != "all":
        raise PageConsistencyTrainingError("unsupported trainable scope")
    return {
        "candidate_objectives_disabled": False,
        "disable_reason": None,
        "effective": requested,
        "requested": requested,
    }


def page_consistency_losses(
    torch: Any,
    body_scores: Any,
    *,
    family_logits: Any,
    positive_mask: Any,
    eligible_mask: Any,
    shared_reviewed_eligible_mask: Any,
    common_positive_mask: Any,
    group_indices: Any,
    row_weights: Any | None = None,
) -> Mapping[str, Any]:
    """Return overlay losses without treating unreviewed fonts as negatives."""

    if body_scores.ndim != 2:
        raise PageConsistencyTrainingError(
            "body scores must have shape [rows,candidates]"
        )
    shape = body_scores.shape
    masks = (
        positive_mask.bool(),
        eligible_mask.bool(),
        shared_reviewed_eligible_mask.bool(),
        common_positive_mask.bool(),
    )
    if any(mask.shape != shape for mask in masks):
        raise PageConsistencyTrainingError("page-consistency mask shape drifted")
    positive, eligible, shared, common = masks
    groups = group_indices.long()
    if groups.ndim != 1 or groups.shape[0] != shape[0]:
        raise PageConsistencyTrainingError("group index shape drifted")
    if not bool(
        positive.any(dim=1).all()
        and eligible.any(dim=1).all()
        and shared.any(dim=1).all()
        and common.any(dim=1).all()
        and (positive <= eligible).all()
        and (common <= positive).all()
        and (common <= shared).all()
        and (shared <= eligible).all()
    ):
        raise PageConsistencyTrainingError("page-consistency masks are inconsistent")
    weights = (
        torch.ones(shape[0], device=body_scores.device, dtype=torch.float32)
        if row_weights is None
        else row_weights.float()
    )
    if weights.shape != (shape[0],) or not bool(
        torch.isfinite(weights).all() and (weights > 0).all()
    ):
        raise PageConsistencyTrainingError("overlay row weights must be positive")
    direct = v8.multi_positive_candidate_loss(
        torch,
        body_scores,
        positive,
        eligible_mask=eligible,
        row_weights=weights,
    )
    if family_logits.shape != (shape[0], len(v8.FAMILY_VALUES)):
        raise PageConsistencyTrainingError("overlay family-logit shape drifted")
    family_losses = torch.nn.functional.cross_entropy(
        family_logits.float(),
        torch.full(
            (shape[0],),
            v8.BODY_FAMILY_INDEX,
            dtype=torch.long,
            device=body_scores.device,
        ),
        reduction="none",
    )
    direct_body_ce = (family_losses * weights).sum() / weights.sum().clamp_min(1e-6)
    unique_groups = torch.unique(groups, sorted=True)
    js_parts: list[Any] = []
    mass_parts: list[Any] = []
    js_capable = 0
    for group_index in unique_groups.tolist():
        selected = groups == int(group_index)
        if int(selected.sum().item()) < 2:
            raise PageConsistencyTrainingError("every consistency group needs two rows")
        group_shared = shared[selected]
        group_common = common[selected]
        if not bool(
            (group_shared == group_shared[0]).all()
            and (group_common == group_common[0]).all()
        ):
            raise PageConsistencyTrainingError("group-level masks are not identical")
        support = group_shared[0]
        scores = (
            body_scores[selected]
            .float()
            .masked_fill(~support[None, :], torch.finfo(torch.float32).min)
        )
        probabilities = torch.softmax(scores, dim=1)
        mixture = probabilities.mean(dim=0, keepdim=True)
        log_probabilities = torch.log(probabilities.clamp_min(1e-12))
        log_mixture = torch.log(mixture.clamp_min(1e-12))
        if int(support.sum().item()) > 1:
            js_capable += 1
            js_parts.append(
                (probabilities * (log_probabilities - log_mixture)).sum(dim=1).mean()
            )
        else:
            js_parts.append(probabilities.sum() * 0.0)
        common_mass = probabilities[:, group_common[0]].sum(dim=1).clamp_min(1e-12)
        group_weights = weights[selected]
        mass_parts.append(
            (-torch.log(common_mass) * group_weights).sum()
            / group_weights.sum().clamp_min(1e-6)
        )
    zero = body_scores.sum() * 0.0
    return {
        "common_positive_mass": (
            torch.stack(mass_parts).mean() if mass_parts else zero
        ),
        "consistency_js": torch.stack(js_parts).mean() if js_parts else zero,
        "direct_body_ce": direct_body_ce,
        "group_count": len(unique_groups),
        "js_capable_group_count": js_capable,
        "reviewed_candidate_set_ce_diagnostic": direct,
        "row_count": int(shape[0]),
    }


def direct_family_loss(
    torch: Any, family_logits: Any, *, family_labels: Any, row_weights: Any
) -> Any:
    labels = family_labels.long()
    weights = row_weights.float()
    if (
        family_logits.ndim != 2
        or family_logits.shape[1] != len(v8.FAMILY_VALUES)
        or labels.shape != (family_logits.shape[0],)
        or weights.shape != labels.shape
        or not bool(
            (
                (labels == v8.BODY_FAMILY_INDEX) | (labels == v8.VARIANT_FAMILY_INDEX)
            ).all()
            and torch.isfinite(weights).all()
            and (weights > 0).all()
        )
    ):
        raise PageConsistencyTrainingError("direct-family CE inputs drifted")
    losses = torch.nn.functional.cross_entropy(
        family_logits.float(), labels, reduction="none"
    )
    return (losses * weights).sum() / weights.sum().clamp_min(1e-6)


def base_family_training_loss(
    torch: Any, family_logits: Any, *, family_labels: Any, family_label_weights: Any
) -> Any:
    """Mirror the v8 base family CE after sealed direct-train target overrides."""

    labels = family_labels.long()
    weights = family_label_weights.float()
    if (
        family_logits.ndim != 2
        or family_logits.shape[1] != len(v8.FAMILY_VALUES)
        or labels.shape != (family_logits.shape[0],)
        or weights.shape != labels.shape
        or not bool(
            (
                (labels == v8.BODY_FAMILY_INDEX) | (labels == v8.VARIANT_FAMILY_INDEX)
            ).all()
            and torch.isfinite(weights).all()
            and (weights > 0).all()
        )
    ):
        raise PageConsistencyTrainingError("base family CE inputs drifted")
    counts = torch.bincount(
        labels, weights=weights, minlength=len(v8.FAMILY_VALUES)
    ).float()
    class_weights = counts.sum() / counts.clamp_min(1.0)
    class_weights = class_weights / class_weights.mean()
    losses = torch.nn.functional.cross_entropy(
        family_logits.float(), labels, weight=class_weights, reduction="none"
    )
    return (losses * weights).sum() / weights.sum().clamp_min(1e-6)


def build_family_override_contract(
    arrays: Mapping[str, np.ndarray],
    direct_family: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    development_eval_work_ids: Sequence[str],
    expected_counts: Mapping[str, int] | None = EXPECTED_FAMILY_OVERRIDE_COUNTS,
) -> tuple[np.ndarray, np.ndarray, Mapping[str, Any]]:
    """Override only base-family targets; preserve r3 candidate routing labels."""

    labels = arrays["family_labels"].astype(np.int64, copy=True)
    weights = arrays["family_label_weights"].astype(np.float32, copy=True)
    work_ids = arrays["work_ids"].astype(str)
    split = arrays["split"].astype(np.int64)
    eval_works = set(str(value) for value in development_eval_work_ids)
    base_train_mask = (split == 0) & ~np.isin(work_ids, list(eval_works))
    seen: set[int] = set()
    counts = {
        "base_train_rows": int(base_train_mask.sum()),
        "direct_development_eval_body_to_variant_conflicts": 0,
        "direct_development_eval_conflicts": 0,
        "direct_development_eval_rows": 0,
        "direct_development_eval_unchanged": 0,
        "direct_development_eval_variant_to_body_conflicts": 0,
        "direct_train_body_targets": 0,
        "direct_train_body_to_variant_conflicts": 0,
        "direct_train_conflicts": 0,
        "direct_train_rows": 0,
        "direct_train_unchanged": 0,
        "direct_train_variant_targets": 0,
        "direct_train_variant_to_body_conflicts": 0,
        "non_direct_base_train_rows": 0,
    }
    override_inventory: list[Mapping[str, Any]] = []
    for split_name in ("train", "development_eval"):
        for row in direct_family[split_name]:
            index = int(row["row_index"])
            target = int(row["family_label"])
            supervision_weight = float(row["supervision_weight"])
            if (
                index in seen
                or not 0 <= index < len(labels)
                or target not in {v8.BODY_FAMILY_INDEX, v8.VARIANT_FAMILY_INDEX}
                or not math.isfinite(supervision_weight)
                or supervision_weight <= 0
            ):
                raise PageConsistencyTrainingError(
                    "direct-family override inventory drifted"
                )
            seen.add(index)
            source = int(arrays["family_labels"][index])
            work_id = str(work_ids[index])
            is_conflict = source != target
            if split_name == "train":
                if not bool(base_train_mask[index]) or work_id in eval_works:
                    raise PageConsistencyTrainingError(
                        "direct-train family override escaped base-train rows"
                    )
                counts["direct_train_rows"] += 1
                counts[
                    "direct_train_body_targets"
                    if target == v8.BODY_FAMILY_INDEX
                    else "direct_train_variant_targets"
                ] += 1
                if is_conflict:
                    counts["direct_train_conflicts"] += 1
                    counts[
                        "direct_train_variant_to_body_conflicts"
                        if source == v8.VARIANT_FAMILY_INDEX
                        else "direct_train_body_to_variant_conflicts"
                    ] += 1
                else:
                    counts["direct_train_unchanged"] += 1
                labels[index] = target
                weights[index] = supervision_weight
                override_inventory.append(
                    {
                        "base_family_label": source,
                        "base_row_index": index,
                        "sample_id": str(arrays["sample_ids"][index]),
                        "sealed_family_label": target,
                        "sealed_supervision_weight": supervision_weight,
                    }
                )
            else:
                if work_id not in eval_works or split[index] != 0:
                    raise PageConsistencyTrainingError(
                        "direct development diagnostic split drifted"
                    )
                counts["direct_development_eval_rows"] += 1
                if is_conflict:
                    counts["direct_development_eval_conflicts"] += 1
                    counts[
                        "direct_development_eval_variant_to_body_conflicts"
                        if source == v8.VARIANT_FAMILY_INDEX
                        else "direct_development_eval_body_to_variant_conflicts"
                    ] += 1
                else:
                    counts["direct_development_eval_unchanged"] += 1
    counts["non_direct_base_train_rows"] = (
        counts["base_train_rows"] - counts["direct_train_rows"]
    )
    if expected_counts is not None and counts != dict(expected_counts):
        raise PageConsistencyTrainingError(
            f"sealed direct/base family conflict contract drifted: {counts}"
        )
    inventory_sha256 = hashlib.sha256(
        canonical_json(override_inventory).encode("utf-8")
    ).hexdigest()
    return (
        labels,
        weights,
        {
            "base_candidate_and_single_day_route_labels_unchanged": True,
            "base_family_ce_contract": (
                "base_r3_targets_except_sealed_direct_train_target_and_weight_override"
            ),
            "counts": counts,
            "development_eval_overrides_applied": 0,
            "direct_train_overrides_applied": counts["direct_train_rows"],
            "direct_train_override_inventory_sha256": inventory_sha256,
            "direct_train_supervision_authority": "training_only_non_human_visual",
            "family_ce_implementation": "v8_equivalent_class_balanced_weighted_ce",
        },
    )


def direct_family_metrics(
    torch: Any,
    family_logits: Any,
    *,
    direct_rows: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    if family_logits.shape != (len(direct_rows), len(v8.FAMILY_VALUES)):
        raise PageConsistencyTrainingError("direct-family metric shape drifted")
    labels = torch.as_tensor(
        [int(row["family_label"]) for row in direct_rows],
        dtype=torch.long,
        device=family_logits.device,
    )
    probabilities = torch.softmax(family_logits.float(), dim=1)
    predicted = probabilities.argmax(dim=1)
    result: dict[str, Any] = {
        "accuracy": float((predicted == labels).float().mean().item()),
        "mean_body_probability": float(
            probabilities[:, v8.BODY_FAMILY_INDEX].mean().item()
        ),
        "predicted_body_rate": float(
            (predicted == v8.BODY_FAMILY_INDEX).float().mean().item()
        ),
        "row_count": len(direct_rows),
    }
    for family_name, family_index in (
        ("body", v8.BODY_FAMILY_INDEX),
        ("variant", v8.VARIANT_FAMILY_INDEX),
    ):
        mask = labels == family_index
        result[f"{family_name}_accuracy"] = float(
            (predicted[mask] == labels[mask]).float().mean().item()
        )
        result[f"{family_name}_rows"] = int(mask.sum().item())
    result["balanced_accuracy"] = 0.5 * (
        float(result["body_accuracy"]) + float(result["variant_accuracy"])
    )
    return result


def anchor_output_loss(
    torch: Any, outputs: Mapping[str, Any], anchor_probabilities: Mapping[str, Any]
) -> Any:
    pairs = (
        ("body_candidate_scores", "body_candidate_probabilities"),
        ("variant_candidate_scores", "variant_candidate_probabilities"),
        ("family_logits", "family_probabilities"),
    )
    losses: list[Any] = []
    for score_name, probability_name in pairs:
        scores = outputs[score_name].float()
        target = anchor_probabilities[probability_name].float().detach()
        if scores.shape != target.shape:
            raise PageConsistencyTrainingError("anchor output shape drifted")
        losses.append(
            torch.nn.functional.kl_div(
                torch.log_softmax(scores, dim=1), target, reduction="batchmean"
            )
        )
    return sum(losses) / len(losses)


def _mask_from_ids(candidate_ids: Sequence[str], values: Sequence[str]) -> np.ndarray:
    selected = set(values)
    unknown = selected - set(candidate_ids)
    if unknown:
        raise PageConsistencyTrainingError(f"overlay candidates are unknown: {unknown}")
    return np.asarray([candidate_id in selected for candidate_id in candidate_ids])


def load_overlay_groups(
    overlay_dir: Path,
    *,
    arrays: Mapping[str, np.ndarray],
    base_npz_sha256: str,
    candidate_ids: Sequence[str],
    expected_counts: Mapping[str, int] | None = overlay_v3.PRODUCTION_COUNTS,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    validation = overlay_v3.validate_output(
        overlay_dir, require_sources=True, expected_counts=expected_counts
    )
    root = overlay_dir.expanduser().resolve()
    manifest = _read_json(root / overlay_v3.MANIFEST_FILE, "overlay manifest")
    base = _mapping(manifest.get("base_dataset"), "overlay base binding")
    if base.get("sha256") != base_npz_sha256 or tuple(
        str(value) for value in base.get("candidate_ids", ())
    ) != tuple(candidate_ids):
        raise PageConsistencyTrainingError("overlay/base training binding drifted")
    rows = overlay_v3._read_canonical_jsonl(
        root / overlay_v3.OVERLAY_FILE, "overlay rows"
    )
    direct_rows = overlay_v3._read_canonical_jsonl(
        root / overlay_v3.DIRECT_FAMILY_FILE, "direct-family rows"
    )
    sample_to_index = {
        str(sample_id): index for index, sample_id in enumerate(arrays["sample_ids"])
    }
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        sample_id = str(row["sample_id"])
        if sample_id not in sample_to_index:
            raise PageConsistencyTrainingError("overlay row is absent from base NPZ")
        base_index = sample_to_index[sample_id]
        if (
            int(row["base_binding"]["base_row_index"]) != base_index
            or int(arrays["split"][base_index]) != 0
            or str(arrays["work_ids"][base_index]) != row["identity"]["work_id"]
        ):
            raise PageConsistencyTrainingError("overlay base-row binding drifted")
        enriched = dict(row)
        enriched["resolved_base_row_index"] = base_index
        grouped.setdefault(str(row["group_id"]), []).append(enriched)
    result: dict[str, list[Mapping[str, Any]]] = {
        "development_eval": [],
        "train": [],
    }
    for group_id, group_rows in grouped.items():
        group_rows.sort(key=lambda row: int(row["group_position"]))
        split = str(group_rows[0]["split"])
        if split not in result or any(row["split"] != split for row in group_rows):
            raise PageConsistencyTrainingError(
                f"overlay group split drifted: {group_id}"
            )
        result[split].append(
            {
                "common_positive_mask": _mask_from_ids(
                    candidate_ids,
                    group_rows[0]["candidate_labels"]["common_positive_candidate_ids"],
                ),
                "group_id": group_id,
                "page_id": group_rows[0]["identity"]["page_id"],
                "row_indices": np.asarray(
                    [row["resolved_base_row_index"] for row in group_rows],
                    dtype=np.int64,
                ),
                "row_masks": [
                    {
                        "eligible": _mask_from_ids(
                            candidate_ids,
                            row["candidate_labels"]["eligible_candidate_ids"],
                        ),
                        "positive": _mask_from_ids(
                            candidate_ids,
                            row["candidate_labels"]["positive_candidate_ids"],
                        ),
                    }
                    for row in group_rows
                ],
                "row_weights": np.asarray(
                    [float(row["supervision_weight"]) for row in group_rows],
                    dtype=np.float32,
                ),
                "shared_reviewed_eligible_mask": _mask_from_ids(
                    candidate_ids,
                    group_rows[0]["candidate_labels"][
                        "shared_reviewed_eligible_candidate_ids"
                    ],
                ),
                "split": split,
                "work_id": group_rows[0]["identity"]["work_id"],
            }
        )
    for groups in result.values():
        groups.sort(key=lambda group: str(group["group_id"]))
    train_works = {str(group["work_id"]) for group in result["train"]}
    eval_works = {str(group["work_id"]) for group in result["development_eval"]}
    if train_works & eval_works:
        raise PageConsistencyTrainingError("overlay train/eval works overlap")
    direct_family: dict[str, list[Mapping[str, Any]]] = {
        "development_eval": [],
        "train": [],
    }
    for row in direct_rows:
        sample_id = str(row["sample_id"])
        if sample_id not in sample_to_index:
            raise PageConsistencyTrainingError(
                "direct-family row is absent from base NPZ"
            )
        base_index = sample_to_index[sample_id]
        split_name = str(row["split"])
        if (
            split_name not in direct_family
            or int(row["base_binding"]["base_row_index"]) != base_index
            or int(arrays["split"][base_index]) != 0
            or str(arrays["work_ids"][base_index]) != row["identity"]["work_id"]
        ):
            raise PageConsistencyTrainingError("direct-family base-row binding drifted")
        direct_family[split_name].append(
            {
                "family_label": (
                    v8.BODY_FAMILY_INDEX
                    if row["family"] == "body"
                    else v8.VARIANT_FAMILY_INDEX
                ),
                "row_index": base_index,
                "sample_id": sample_id,
                "supervision_weight": float(row["supervision_weight"]),
                "work_id": row["identity"]["work_id"],
            }
        )
    for direct_split in direct_family.values():
        direct_split.sort(key=lambda row: str(row["sample_id"]))
    if {str(row["work_id"]) for row in direct_family["train"]} != train_works or {
        str(row["work_id"]) for row in direct_family["development_eval"]
    } != eval_works:
        raise PageConsistencyTrainingError("direct-family work split drifted")
    return {**result, "direct_family": direct_family}, {
        "direct_family_sha256": sha256_file(root / overlay_v3.DIRECT_FAMILY_FILE),
        "development_eval_work_ids": sorted(eval_works),
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(root / overlay_v3.MANIFEST_FILE),
        "overlay_sha256": sha256_file(root / overlay_v3.OVERLAY_FILE),
        "train_work_ids": sorted(train_works),
        "validation": validation,
    }


def make_overlay_batch(
    torch: Any,
    groups: Sequence[Mapping[str, Any]],
    *,
    device: Any,
) -> Mapping[str, Any]:
    if not groups:
        raise PageConsistencyTrainingError("overlay batch is empty")
    indices: list[int] = []
    positives: list[np.ndarray] = []
    eligible: list[np.ndarray] = []
    shared: list[np.ndarray] = []
    common: list[np.ndarray] = []
    weights: list[float] = []
    group_indices: list[int] = []
    for local_group, group in enumerate(groups):
        row_indices = group["row_indices"].tolist()
        if len(row_indices) != len(group["row_masks"]):
            raise PageConsistencyTrainingError("overlay group row masks drifted")
        for row_index, masks, weight in zip(
            row_indices, group["row_masks"], group["row_weights"], strict=True
        ):
            indices.append(int(row_index))
            positives.append(masks["positive"])
            eligible.append(masks["eligible"])
            shared.append(group["shared_reviewed_eligible_mask"])
            common.append(group["common_positive_mask"])
            weights.append(float(weight))
            group_indices.append(local_group)
    return {
        "common_positive_mask": torch.from_numpy(np.stack(common)).to(device),
        "eligible_mask": torch.from_numpy(np.stack(eligible)).to(device),
        "group_indices": torch.as_tensor(
            group_indices, dtype=torch.long, device=device
        ),
        "indices": torch.as_tensor(indices, dtype=torch.long, device=device),
        "positive_mask": torch.from_numpy(np.stack(positives)).to(device),
        "row_weights": torch.as_tensor(weights, dtype=torch.float32, device=device),
        "shared_reviewed_eligible_mask": torch.from_numpy(np.stack(shared)).to(device),
    }


def overlay_metrics(
    torch: Any,
    outputs: Mapping[str, Any],
    *,
    groups: Sequence[Mapping[str, Any]],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    expected_rows = sum(len(group["row_indices"]) for group in groups)
    body_scores = outputs["body_candidate_scores"].float()
    variant_scores = outputs["variant_candidate_scores"].float()
    family_probabilities = torch.softmax(outputs["family_logits"].float(), dim=1)
    if (
        body_scores.shape != variant_scores.shape
        or body_scores.shape[0] != expected_rows
        or body_scores.shape[1] != len(candidate_ids)
    ):
        raise PageConsistencyTrainingError("overlay metric row order drifted")
    single_day_index = tuple(candidate_ids).index("single-day")
    family_top1 = family_probabilities.argmax(dim=1)
    raw_deployed_scores = torch.where(
        (family_top1 == v8.BODY_FAMILY_INDEX)[:, None], body_scores, variant_scores
    )
    other_mask = torch.ones_like(raw_deployed_scores, dtype=torch.bool)
    other_mask[:, single_day_index] = False
    best_other = (
        raw_deployed_scores.masked_fill(~other_mask, torch.finfo(torch.float32).min)
        .max(dim=1)
        .values
    )
    single_day_allowed = (
        (family_top1 == v8.VARIANT_FAMILY_INDEX)
        & (
            family_probabilities[:, v8.VARIANT_FAMILY_INDEX]
            >= v8.MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE
        )
        & (
            raw_deployed_scores[:, single_day_index] - best_other
            >= v8.MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN
        )
    )
    deployed_scores = raw_deployed_scores.clone()
    deployed_scores[:, single_day_index] = deployed_scores[
        :, single_day_index
    ].masked_fill(~single_day_allowed, torch.finfo(torch.float32).min)
    body_deployed_scores = body_scores.clone()
    body_deployed_scores[:, single_day_index] = torch.finfo(torch.float32).min

    def summarize_distribution(probabilities: Any, common: Any) -> Mapping[str, Any]:
        mixture = probabilities.mean(dim=0, keepdim=True)
        js = (
            (
                probabilities
                * (
                    torch.log(probabilities.clamp_min(1e-12))
                    - torch.log(mixture.clamp_min(1e-12))
                )
            )
            .sum(dim=1)
            .mean()
        )
        top1 = probabilities.argmax(dim=1)
        return {
            "all_rows_top1_in_common_positive": bool(common[top1].all().item()),
            "common_positive_mass": float(
                probabilities[:, common].sum(dim=1).mean().item()
            ),
            "js": float(js.item()),
            "top1_all_agree": bool((top1 == top1[0]).all().item()),
        }

    summaries: list[Mapping[str, Any]] = []
    offset = 0
    for group in groups:
        row_count = len(group["row_indices"])
        group_body_scores = body_deployed_scores[offset : offset + row_count]
        group_deployed_scores = deployed_scores[offset : offset + row_count]
        group_family = family_probabilities[offset : offset + row_count]
        offset += row_count
        shared = torch.from_numpy(group["shared_reviewed_eligible_mask"]).to(
            device=body_scores.device, dtype=torch.bool
        )
        common = torch.from_numpy(group["common_positive_mask"]).to(
            device=body_scores.device, dtype=torch.bool
        )
        reviewed_scores = group_body_scores.masked_fill(
            ~shared[None, :], torch.finfo(torch.float32).min
        )
        reviewed = summarize_distribution(torch.softmax(reviewed_scores, dim=1), common)
        full_body = summarize_distribution(
            torch.softmax(group_body_scores, dim=1), common
        )
        production = summarize_distribution(
            torch.softmax(group_deployed_scores, dim=1), common
        )
        summaries.append(
            {
                "body_full_inventory": full_body,
                "group_id": group["group_id"],
                "js_capable": int(shared.sum().item()) > 1,
                "mean_body_probability": float(
                    group_family[:, v8.BODY_FAMILY_INDEX].mean().item()
                ),
                "production_deployed": production,
                "predicted_body_rate": float(
                    (group_family.argmax(dim=1) == v8.BODY_FAMILY_INDEX)
                    .float()
                    .mean()
                    .item()
                ),
                "row_count": row_count,
                "reviewed_support": reviewed,
                "shared_reviewed_candidate_count": int(shared.sum().item()),
                "work_id": group["work_id"],
            }
        )
    if not summaries:
        raise PageConsistencyTrainingError("overlay metrics require groups")

    def aggregate(view: str, *, js_capable_only: bool) -> Mapping[str, Any]:
        js_rows = (
            [group for group in summaries if group["js_capable"]]
            if js_capable_only
            else summaries
        )
        return {
            "all_rows_top1_in_common_positive_rate": sum(
                int(group[view]["all_rows_top1_in_common_positive"])
                for group in summaries
            )
            / len(summaries),
            "mean_common_positive_mass": sum(
                float(group[view]["common_positive_mass"]) for group in summaries
            )
            / len(summaries),
            "mean_js": sum(float(group[view]["js"]) for group in js_rows)
            / max(1, len(js_rows)),
            "top1_all_agree_rate": sum(
                int(group[view]["top1_all_agree"]) for group in summaries
            )
            / len(summaries),
        }

    production = aggregate("production_deployed", js_capable_only=False)
    return {
        **production,
        "body_full_inventory": aggregate("body_full_inventory", js_capable_only=False),
        "candidate_inventory_count": len(candidate_ids),
        "group_count": len(summaries),
        "groups": summaries,
        "mean_body_probability": sum(
            float(group["mean_body_probability"]) for group in summaries
        )
        / len(summaries),
        "predicted_body_rate": sum(
            float(group["predicted_body_rate"]) for group in summaries
        )
        / len(summaries),
        "probability_support": "production_deployed_full_candidate_inventory",
        "reviewed_support": aggregate("reviewed_support", js_capable_only=True),
        "row_count": expected_rows,
        "single_day_route": {
            "allowed_rows": int(single_day_allowed.sum().item()),
            "body_policy": "always_mask",
            "family_confidence_threshold": v8.MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE,
            "raw_margin_threshold": v8.MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN,
        },
    }


def bounded_drift_diagnostics(
    torch: Any,
    candidate_outputs: Mapping[str, Any],
    anchor_outputs: Mapping[str, Any],
    *,
    groups: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    candidate_scores = candidate_outputs["body_candidate_scores"].float()
    anchor_scores = anchor_outputs["body_candidate_scores"].float()
    candidate_family = candidate_outputs["family_logits"].float()
    if candidate_scores.shape != anchor_scores.shape:
        raise PageConsistencyTrainingError("candidate/anchor overlay scores drifted")
    row_deltas: list[float] = []
    group_deltas: list[float] = []
    offset = 0
    for group in groups:
        row_count = len(group["row_indices"])
        shared = torch.from_numpy(group["shared_reviewed_eligible_mask"]).to(
            device=candidate_scores.device, dtype=torch.bool
        )
        delta = (
            candidate_scores[offset : offset + row_count, shared]
            - anchor_scores[offset : offset + row_count, shared]
        ).abs()
        offset += row_count
        row_max = delta.max(dim=1).values.tolist()
        row_deltas.extend(float(value) for value in row_max)
        group_deltas.append(float(delta.max().item()))
    shift_grid: dict[str, Mapping[str, float]] = {}
    for shift in FAMILY_LOGIT_SHIFT_GRID:
        shifted = candidate_family.clone()
        shifted[:, v8.BODY_FAMILY_INDEX] += float(shift)
        probabilities = torch.softmax(shifted, dim=1)
        shift_grid[f"{shift:g}"] = {
            "mean_body_probability": float(
                probabilities[:, v8.BODY_FAMILY_INDEX].mean().item()
            ),
            "predicted_body_rate": float(
                (probabilities.argmax(dim=1) == v8.BODY_FAMILY_INDEX)
                .float()
                .mean()
                .item()
            ),
        }
    return {
        "candidate_body_score_delta": {
            "budget_grid": {
                f"{budget:g}": {
                    "group_fraction_within_budget": sum(
                        delta <= budget + 1e-12 for delta in group_deltas
                    )
                    / max(1, len(group_deltas)),
                    "row_fraction_within_budget": sum(
                        delta <= budget + 1e-12 for delta in row_deltas
                    )
                    / max(1, len(row_deltas)),
                }
                for budget in CANDIDATE_DELTA_BUDGET_GRID
            },
            "maximum_absolute_delta": max(row_deltas, default=0.0),
            "mean_row_maximum_absolute_delta": sum(row_deltas)
            / max(1, len(row_deltas)),
            "support": "shared_reviewed_eligible_only",
        },
        "family_body_logit_shift_grid": shift_grid,
    }


def overlay_improvement_checks(
    anchor: Mapping[str, Any],
    candidate: Mapping[str, Any],
    *,
    minimum_js_improvement: float,
    minimum_rate_improvement: float,
    maximum_body_rate_regression: float,
) -> Mapping[str, bool]:
    epsilon = 1e-12
    js_improvement = float(anchor["mean_js"]) - float(candidate["mean_js"])
    agree_change = float(candidate["top1_all_agree_rate"]) - float(
        anchor["top1_all_agree_rate"]
    )
    common_change = float(candidate["all_rows_top1_in_common_positive_rate"]) - float(
        anchor["all_rows_top1_in_common_positive_rate"]
    )
    return {
        "all_rows_common_positive_rate_nonregression": common_change >= -epsilon,
        "body_probability_nonregression": float(candidate["mean_body_probability"])
        >= float(anchor["mean_body_probability"]) - maximum_body_rate_regression,
        "body_prediction_rate_nonregression": float(candidate["predicted_body_rate"])
        >= float(anchor["predicted_body_rate"]) - maximum_body_rate_regression,
        "mean_js_improved": js_improvement + epsilon >= minimum_js_improvement,
        "top1_agreement_or_common_positive_improved": max(agree_change, common_change)
        + epsilon
        >= minimum_rate_improvement,
        "top1_all_agree_rate_nonregression": agree_change >= -epsilon,
    }


def base_regression_checks(
    anchor: Mapping[str, Any],
    candidate: Mapping[str, Any],
    *,
    maximum_acceptable_regression: float,
    maximum_preferred_regression: float,
    maximum_family_regression: float,
) -> Mapping[str, bool]:
    checks: dict[str, bool] = {}
    for slice_name in ("all", "visual"):
        anchor_slice = _mapping(anchor[slice_name], f"anchor {slice_name}")
        candidate_slice = _mapping(candidate[slice_name], f"candidate {slice_name}")
        prefix = f"{slice_name}_"
        checks[prefix + "acceptable_nonmaterial_regression"] = (
            float(candidate_slice["acceptable_at1"])
            >= float(anchor_slice["acceptable_at1"]) - maximum_acceptable_regression
        )
        checks[prefix + "preferred_nonmaterial_regression"] = (
            float(candidate_slice["preferred_at1"])
            >= float(anchor_slice["preferred_at1"]) - maximum_preferred_regression
        )
        checks[prefix + "family_nonmaterial_regression"] = (
            float(candidate_slice["family_accuracy"])
            >= float(anchor_slice["family_accuracy"]) - maximum_family_regression
        )
        checks[prefix + "single_day_body_false_zero"] = (
            int(candidate_slice["single_day_body_false_top1_count"]) == 0
        )
    return checks


def _model_outputs(
    torch: Any,
    model: Any,
    *,
    query_views: Any,
    prototypes: Any,
    indices: np.ndarray,
    batch_size: int,
) -> Mapping[str, Any]:
    collected: dict[str, list[Any]] = {
        "body_candidate_scores": [],
        "family_logits": [],
        "variant_candidate_scores": [],
    }
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(indices), batch_size):
            batch = torch.as_tensor(
                indices[start : start + batch_size],
                dtype=torch.long,
                device=query_views.device,
            )
            outputs = model(query_views[batch], prototypes)
            for name in collected:
                collected[name].append(outputs[name].detach())
    return {name: torch.cat(parts, dim=0) for name, parts in collected.items()}


def evaluate_base(
    torch: Any,
    model: Any,
    *,
    arrays: Mapping[str, np.ndarray],
    query_views: Any,
    prototypes: Any,
    candidate_ids: Sequence[str],
    batch_size: int,
) -> Mapping[str, Any]:
    split = arrays["split"].astype(np.int64, copy=False)
    val_indices = np.flatnonzero(split == 1)
    outputs = _model_outputs(
        torch,
        model,
        query_views=query_views,
        prototypes=prototypes,
        indices=val_indices,
        batch_size=batch_size,
    )
    device = query_views.device
    labels = torch.from_numpy(arrays["family_labels"][val_indices].astype(np.int64)).to(
        device
    )
    positives = torch.from_numpy(arrays["positive_mask"][val_indices]).to(device)
    preferred = torch.from_numpy(arrays["preferred_mask"][val_indices]).to(device)
    weights = torch.from_numpy(
        arrays["font_supervision_weights"][val_indices].astype(np.float32)
    ).to(device)
    negative = torch.from_numpy(arrays["single_day_body_negative"][val_indices]).to(
        device
    )
    metrics = v8.compute_metrics(
        torch,
        outputs,
        family_labels=labels,
        positive_mask=positives,
        preferred_mask=preferred,
        font_supervision_weights=weights,
        single_day_body_negative=negative,
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )
    authorities = arrays["font_authority"][val_indices].astype(str)
    visual_positions = np.flatnonzero(authorities == "visual")
    visual_tensor = torch.as_tensor(visual_positions, dtype=torch.long, device=device)
    visual_outputs = {name: value[visual_tensor] for name, value in outputs.items()}
    visual = v8.compute_metrics(
        torch,
        visual_outputs,
        family_labels=labels[visual_tensor],
        positive_mask=positives[visual_tensor],
        preferred_mask=preferred[visual_tensor],
        font_supervision_weights=weights[visual_tensor],
        single_day_body_negative=negative[visual_tensor],
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )
    quality_checks = v8.build_quality_gate_checks(metrics, visual)
    return {
        "all": dict(metrics),
        "quality_checks": quality_checks,
        "quality_gate_passed": all(quality_checks.values()),
        "visual": dict(visual),
    }


def _overlay_outputs(
    torch: Any,
    model: Any,
    *,
    groups: Sequence[Mapping[str, Any]],
    query_views: Any,
    prototypes: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    indices = np.concatenate([group["row_indices"] for group in groups])
    return _model_outputs(
        torch,
        model,
        query_views=query_views,
        prototypes=prototypes,
        indices=indices,
        batch_size=batch_size,
    )


def base_anchor_drift_diagnostics(
    torch: Any,
    candidate_model: Any,
    anchor_model: Any,
    *,
    arrays: Mapping[str, np.ndarray],
    query_views: Any,
    prototypes: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    indices = np.flatnonzero(arrays["split"].astype(np.int64, copy=False) == 1)
    candidate = _model_outputs(
        torch,
        candidate_model,
        query_views=query_views,
        prototypes=prototypes,
        indices=indices,
        batch_size=batch_size,
    )
    anchor = _model_outputs(
        torch,
        anchor_model,
        query_views=query_views,
        prototypes=prototypes,
        indices=indices,
        batch_size=batch_size,
    )
    score_drift: dict[str, Mapping[str, float]] = {}
    for name in ("body_candidate_scores", "variant_candidate_scores"):
        delta = (candidate[name].float() - anchor[name].float()).abs()
        score_drift[name] = {
            "maximum_absolute_delta": float(delta.max().item()),
            "mean_absolute_delta": float(delta.mean().item()),
        }
    probability_js: dict[str, float] = {}
    for name in ("body_candidate_scores", "variant_candidate_scores", "family_logits"):
        candidate_probability = torch.softmax(candidate[name].float(), dim=1)
        anchor_probability = torch.softmax(anchor[name].float(), dim=1)
        mixture = 0.5 * (candidate_probability + anchor_probability)
        js = 0.5 * (
            (
                candidate_probability
                * (
                    torch.log(candidate_probability.clamp_min(1e-12))
                    - torch.log(mixture.clamp_min(1e-12))
                )
            ).sum(dim=1)
            + (
                anchor_probability
                * (
                    torch.log(anchor_probability.clamp_min(1e-12))
                    - torch.log(mixture.clamp_min(1e-12))
                )
            ).sum(dim=1)
        )
        probability_js[name] = float(js.mean().item())
    return {
        "probability_mean_js": probability_js,
        "rows": int(len(indices)),
        "score_drift": score_drift,
    }


def _exact_anchor_manifest(anchor_dir: Path) -> Mapping[str, Any]:
    expanded = anchor_dir.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise PageConsistencyTrainingError("production r3h anchor cannot be linked")
    root = expanded.resolve()
    if (
        not root.is_dir()
        or overlay_v3._contains_link_or_reparse(root)
        or {path.name for path in root.iterdir()} != v8.OUTPUT_FILES
    ):
        raise PageConsistencyTrainingError(
            "anchor is not the exact production r3h inventory"
        )
    marker_path = root / v8.MARKER_FILE
    manifest_path = root / v8.MANIFEST_FILE
    checkpoint_path = root / v8.CHECKPOINT_FILE
    marker = _read_json(marker_path, "production r3h anchor marker")
    manifest = _read_json(manifest_path, "production r3h anchor manifest")
    validate_record_seal(marker, "production r3h anchor marker")
    validate_record_seal(manifest, "production r3h anchor manifest")
    artifacts = _mapping(marker.get("artifacts"), "production r3h marker artifacts")
    if (
        sha256_file(checkpoint_path) != EXPECTED_ANCHOR_CHECKPOINT_SHA256
        or sha256_file(manifest_path) != EXPECTED_ANCHOR_MANIFEST_SHA256
        or manifest.get("record_sha256") != EXPECTED_ANCHOR_MANIFEST_RECORD_SHA256
        or marker.get("owner") != v8.OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != v8.SCHEMA_VERSION
        or set(artifacts) != {v8.CHECKPOINT_FILE, v8.MANIFEST_FILE}
        or artifacts.get(v8.CHECKPOINT_FILE) != EXPECTED_ANCHOR_CHECKPOINT_SHA256
        or artifacts.get(v8.MANIFEST_FILE) != EXPECTED_ANCHOR_MANIFEST_SHA256
        or manifest.get("schema_version") != v8.SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_student_v8_role_family_adapter_manifest"
    ):
        raise PageConsistencyTrainingError("anchor is not the exact production r3h")
    return manifest


def _load_context(args: argparse.Namespace, torch: Any) -> Mapping[str, Any]:
    if overlay_v3._path_or_ancestor_is_link_or_reparse(
        args.base_npz.expanduser().absolute()
    ):
        raise PageConsistencyTrainingError("base NPZ cannot be linked")
    dataset_path, arrays, inventory = v8._load_training_npz(args.base_npz)
    if sha256_file(dataset_path) != EXPECTED_BASE_NPZ_SHA256:
        raise PageConsistencyTrainingError(
            "base NPZ is not the exact production r3 set"
        )
    source_head_input = args.source_query_head.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(source_head_input):
        raise PageConsistencyTrainingError("source query head cannot be linked")
    source_head = source_head_input.resolve()
    if sha256_file(source_head) != EXPECTED_SOURCE_QUERY_HEAD_SHA256:
        raise PageConsistencyTrainingError(
            "source query head is not production r3h input"
        )
    anchor_manifest = _exact_anchor_manifest(args.anchor_adapter_dir)
    candidate_ids = tuple(str(value) for value in inventory["candidate_ids"])
    architecture = _mapping(anchor_manifest.get("architecture"), "anchor architecture")
    expected_architecture = v8.adapter_architecture_contract(
        candidate_count=len(candidate_ids),
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(
            architecture["candidate_residual_hidden_dim"]
        ),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    if architecture != expected_architecture:
        raise PageConsistencyTrainingError("anchor runtime architecture drifted")
    initial_weights, initial_scale = v8._load_initial_head(source_head)
    model = v8.build_role_family_adapter(
        torch,
        candidate_count=len(candidate_ids),
        initial_query_weight_logits=initial_weights,
        initial_logit_scale=initial_scale,
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(
            architecture["candidate_residual_hidden_dim"]
        ),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    initialization = v8.initialize_adapter_from_artifact(
        torch,
        model,
        args.anchor_adapter_dir,
        candidate_ids=candidate_ids,
        source_query_head=source_head,
        expected_architecture=expected_architecture,
    )
    if (
        not isinstance(initialization, Mapping)
        or initialization.get("checkpoint_sha256") != EXPECTED_ANCHOR_CHECKPOINT_SHA256
    ):
        raise PageConsistencyTrainingError("r3h initialization binding drifted")
    groups, overlay_binding = load_overlay_groups(
        args.overlay_dir,
        arrays=arrays,
        base_npz_sha256=EXPECTED_BASE_NPZ_SHA256,
        candidate_ids=candidate_ids,
    )
    return {
        "architecture": dict(expected_architecture),
        "arrays": arrays,
        "candidate_ids": candidate_ids,
        "dataset_path": dataset_path,
        "groups": groups,
        "initialization": initialization,
        "inventory": inventory,
        "model": model,
        "overlay_binding": overlay_binding,
        "source_head": source_head,
    }


def _finite_nonnegative(value: float, name: str) -> None:
    if not math.isfinite(value) or value < 0:
        raise PageConsistencyTrainingError(f"{name} must be finite and nonnegative")


def _validate_options(args: argparse.Namespace) -> None:
    for name in (
        "epochs",
        "batch_size",
        "overlay_groups_per_batch",
        "direct_family_batch_size",
        "evaluation_batch_size",
        "learning_rate",
        "gradient_clip",
        "candidate_distribution_temperature",
        "rare_class_weight_cap",
    ):
        value = float(getattr(args, name))
        if not math.isfinite(value) or value <= 0:
            raise PageConsistencyTrainingError(f"{name} must be positive")
    for name in (
        "base_loss_weight",
        "direct_body_ce_weight",
        "direct_family_ce_weight",
        "consistency_js_weight",
        "common_positive_mass_weight",
        "anchor_output_weight",
        "anchor_parameter_weight",
        "maximum_acceptable_regression",
        "maximum_preferred_regression",
        "maximum_family_regression",
        "minimum_overlay_js_improvement",
        "minimum_overlay_rate_improvement",
        "maximum_body_rate_regression",
        "maximum_candidate_score_delta",
        "weight_decay",
        "candidate_parameter_lr_multiplier",
        "family_weight",
        "single_day_hard_negative_weight",
        "single_day_hard_negative_margin",
        "bias_l2_weight",
        "candidate_distribution_weight",
        "candidate_distribution_slack",
        "sample_residual_l2_weight",
        "supervised_single_day_hard_negative_weight",
    ):
        _finite_nonnegative(float(getattr(args, name)), name)
    if args.trainable_scope not in {"all", "family-head-only"}:
        raise PageConsistencyTrainingError("unsupported trainable scope")
    if args.base_loss_weight <= 0:
        raise PageConsistencyTrainingError("base loss must remain enabled")
    if args.family_weight <= 0:
        raise PageConsistencyTrainingError(
            "non-direct base family supervision must remain enabled"
        )
    if args.rare_class_weight_cap < 1:
        raise PageConsistencyTrainingError("rare class weight cap must be at least one")
    if args.trainable_scope == "all" and args.candidate_parameter_lr_multiplier <= 0:
        raise PageConsistencyTrainingError(
            "all scope requires a positive candidate-parameter LR multiplier"
        )


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise PageConsistencyTrainingError("PyTorch is required") from error
    _validate_options(args)
    torch.manual_seed(args.seed)
    context = _load_context(args, torch)
    model = context["model"].eval()
    arrays = context["arrays"]
    eval_works = set(context["overlay_binding"]["development_eval_work_ids"])
    effective_family_labels, effective_family_weights, override_contract = (
        build_family_override_contract(
            arrays,
            context["groups"]["direct_family"],
            development_eval_work_ids=sorted(eval_works),
        )
    )
    train_groups = context["groups"]["train"]
    batch = make_overlay_batch(torch, train_groups[:2], device=torch.device("cpu"))
    query_views = torch.from_numpy(arrays["query_views"].astype(np.float32, copy=False))
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    )
    with torch.inference_mode():
        outputs = model(query_views[batch["indices"]], prototypes)
        losses = page_consistency_losses(
            torch,
            outputs["body_candidate_scores"],
            family_logits=outputs["family_logits"],
            positive_mask=batch["positive_mask"],
            eligible_mask=batch["eligible_mask"],
            shared_reviewed_eligible_mask=batch["shared_reviewed_eligible_mask"],
            common_positive_mask=batch["common_positive_mask"],
            group_indices=batch["group_indices"],
            row_weights=batch["row_weights"],
        )
        allowed = np.flatnonzero(
            (arrays["split"].astype(np.int64) == 0)
            & ~np.isin(arrays["work_ids"].astype(str), list(eval_works))
        )
        selected = list(allowed[:16])
        supervised_allowed = allowed[
            arrays["font_supervision_weights"][allowed].astype(np.float32) > 0
        ]
        if supervised_allowed.size:
            selected.append(int(supervised_allowed[0]))
        conflict_indices = np.flatnonzero(
            (arrays["family_labels"].astype(np.int64) != effective_family_labels)
            & np.isin(np.arange(len(effective_family_labels)), allowed)
        )
        if conflict_indices.size:
            selected.append(int(conflict_indices[0]))
        base_indices = np.asarray(sorted(set(selected)), dtype=np.int64)
        base_outputs = model(query_views[base_indices], prototypes)
        base_nonfamily_loss, _ = v8.role_family_training_loss(
            torch,
            base_outputs,
            family_labels=torch.from_numpy(
                arrays["family_labels"][base_indices].astype(np.int64)
            ),
            positive_mask=torch.from_numpy(arrays["positive_mask"][base_indices]),
            preferred_mask=torch.from_numpy(arrays["preferred_mask"][base_indices]),
            candidate_eligible_mask=torch.from_numpy(
                arrays["candidate_eligible_mask"][base_indices]
            ),
            font_supervision_weights=torch.from_numpy(
                arrays["font_supervision_weights"][base_indices].astype(np.float32)
            ),
            family_label_weights=torch.from_numpy(
                arrays["family_label_weights"][base_indices].astype(np.float32)
            ),
            single_day_body_negative=torch.from_numpy(
                arrays["single_day_body_negative"][base_indices]
            ),
            single_day_index=context["candidate_ids"].index("single-day"),
            family_weight=0.0,
            hard_negative_weight=args.single_day_hard_negative_weight,
            hard_negative_margin=args.single_day_hard_negative_margin,
            bias_l2_weight=args.bias_l2_weight,
            candidate_distribution_weight=args.candidate_distribution_weight,
            candidate_distribution_slack=args.candidate_distribution_slack,
            candidate_distribution_temperature=args.candidate_distribution_temperature,
            sample_residual_l2_weight=args.sample_residual_l2_weight,
            supervised_single_day_hard_negative_weight=(
                args.supervised_single_day_hard_negative_weight
            ),
        )
        base_family_loss = base_family_training_loss(
            torch,
            base_outputs["family_logits"],
            family_labels=torch.from_numpy(effective_family_labels[base_indices]),
            family_label_weights=torch.from_numpy(
                effective_family_weights[base_indices]
            ),
        )
        base_loss = base_nonfamily_loss + float(args.family_weight) * base_family_loss
        direct_rows = context["groups"]["direct_family"]["train"][:16]
        direct_indices = torch.as_tensor(
            [int(row["row_index"]) for row in direct_rows], dtype=torch.long
        )
        direct_outputs = model(query_views[direct_indices], prototypes)
        family_overlay_loss = direct_family_loss(
            torch,
            direct_outputs["family_logits"],
            family_labels=torch.as_tensor(
                [int(row["family_label"]) for row in direct_rows], dtype=torch.long
            ),
            row_weights=torch.as_tensor(
                [float(row["supervision_weight"]) for row in direct_rows],
                dtype=torch.float32,
            ),
        )
    if any(
        not math.isfinite(float(value))
        for key, value in losses.items()
        if key not in {"group_count", "js_capable_group_count", "row_count"}
    ):
        raise PageConsistencyTrainingError("preflight produced a non-finite loss")
    gradient_rows = np.flatnonzero(
        (arrays["split"].astype(np.int64) == 0)
        & ~np.isin(arrays["work_ids"].astype(str), list(eval_works))
    )
    return {
        "anchor": context["initialization"],
        "base_gradient_rows": int(len(gradient_rows)),
        "base_preflight_loss": float(base_loss),
        "base_family_preflight_loss": float(base_family_loss),
        "base_preflight_rows": int(len(base_indices)),
        "direct_family_preflight_loss": float(family_overlay_loss),
        "direct_family_preflight_rows": len(direct_rows),
        "base_npz_sha256": EXPECTED_BASE_NPZ_SHA256,
        "candidate_ids": list(context["candidate_ids"]),
        "eval_gradient_rows": 0,
        "family_override_contract": override_contract,
        "overlay": context["overlay_binding"],
        "overlay_losses": {
            key: int(value) if isinstance(value, int) else float(value)
            for key, value in losses.items()
        },
        "overlay_weights": effective_overlay_weights(
            trainable_scope=args.trainable_scope,
            direct_body_ce_weight=args.direct_body_ce_weight,
            direct_family_ce_weight=args.direct_family_ce_weight,
            consistency_js_weight=args.consistency_js_weight,
            common_positive_mass_weight=args.common_positive_mass_weight,
        ),
        "runtime_architecture_unchanged": True,
        "status": "ready_for_experimental_v3_page_consistency_training",
    }


def _schedule_overlay_batches(
    groups: Sequence[Mapping[str, Any]],
    *,
    generator: np.random.Generator,
    groups_per_batch: int,
    step_count: int,
) -> Mapping[int, Sequence[Mapping[str, Any]]]:
    order = generator.permutation(len(groups))
    batches = [
        [groups[int(index)] for index in order[start : start + groups_per_batch]]
        for start in range(0, len(order), groups_per_batch)
    ]
    if len(batches) > step_count:
        raise PageConsistencyTrainingError("overlay batches exceed base training steps")
    positions = np.linspace(0, step_count - 1, num=len(batches), dtype=np.int64)
    if len(set(positions.tolist())) != len(batches):
        raise PageConsistencyTrainingError("overlay batch scheduling collided")
    return {
        int(position): batch for position, batch in zip(positions, batches, strict=True)
    }


def _schedule_direct_family_batches(
    rows: Sequence[Mapping[str, Any]],
    *,
    generator: np.random.Generator,
    batch_size: int,
    step_count: int,
) -> Mapping[int, Sequence[Mapping[str, Any]]]:
    order = generator.permutation(len(rows))
    batches = [
        [rows[int(index)] for index in order[start : start + batch_size]]
        for start in range(0, len(order), batch_size)
    ]
    if len(batches) > step_count:
        raise PageConsistencyTrainingError(
            "direct-family batches exceed base training steps"
        )
    positions = np.linspace(0, step_count - 1, num=len(batches), dtype=np.int64)
    if len(set(positions.tolist())) != len(batches):
        raise PageConsistencyTrainingError("direct-family batch scheduling collided")
    return {
        int(position): batch for position, batch in zip(positions, batches, strict=True)
    }


def _base_selection_score(metrics: Mapping[str, Any]) -> float:
    all_metrics = metrics["all"]
    visual = metrics["visual"]
    return (
        float(all_metrics["acceptable_at1"])
        + 0.5 * float(all_metrics["preferred_at1"])
        + 0.25 * float(all_metrics["family_accuracy"])
        + 0.25 * float(visual["acceptable_at1"])
        + 0.125 * float(visual["preferred_at1"])
    )


def _training_only_selection_metrics(
    torch: Any,
    model: Any,
    *,
    direct_rows: Sequence[Mapping[str, Any]],
    groups: Sequence[Mapping[str, Any]],
    query_views: Any,
    prototypes: Any,
    candidate_ids: Sequence[str],
    batch_size: int,
) -> Mapping[str, Any]:
    direct_indices = np.asarray(
        [int(row["row_index"]) for row in direct_rows], dtype=np.int64
    )
    direct_outputs = _model_outputs(
        torch,
        model,
        query_views=query_views,
        prototypes=prototypes,
        indices=direct_indices,
        batch_size=batch_size,
    )
    page_outputs = _overlay_outputs(
        torch,
        model,
        groups=groups,
        query_views=query_views,
        prototypes=prototypes,
        batch_size=batch_size,
    )
    page = overlay_metrics(
        torch, page_outputs, groups=groups, candidate_ids=candidate_ids
    )
    return {
        "direct_family": direct_family_metrics(
            torch, direct_outputs["family_logits"], direct_rows=direct_rows
        ),
        "page_consistency": {
            key: page[key]
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
        },
    }


def _selection_key(
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    train_metrics: Mapping[str, Any],
) -> tuple[float, ...]:
    direct = _mapping(train_metrics["direct_family"], "direct train metrics")
    page = _mapping(train_metrics["page_consistency"], "page train metrics")
    return (
        float(base_metrics["quality_gate_passed"]),
        float(all(base_regression.values())),
        float(direct["balanced_accuracy"]),
        float(direct["body_accuracy"]),
        float(direct["variant_accuracy"]),
        float(page["all_rows_top1_in_common_positive_rate"]),
        float(page["top1_all_agree_rate"]),
        -float(page["mean_js"]),
        float(page["mean_common_positive_mass"]),
        _base_selection_score(base_metrics),
    )


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise PageConsistencyTrainingError(
            "PyTorch and safetensors are required"
        ) from error
    _validate_options(args)
    output = _safe_new_output(args.output_dir)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise PageConsistencyTrainingError("CUDA was requested but is unavailable")
    torch.manual_seed(args.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)
    np.random.seed(args.seed)
    context = _load_context(args, torch)
    model = context["model"].to(device)
    anchor_model = copy.deepcopy(model).to(device).eval()
    for parameter in anchor_model.parameters():
        parameter.requires_grad_(False)
    anchor_state = {
        name: value.detach().clone()
        for name, value in anchor_model.state_dict().items()
    }
    parameter_groups, trainable_parameters = v8.optimizer_parameter_groups(
        model,
        learning_rate=args.learning_rate,
        trainable_scope=args.trainable_scope,
        candidate_parameter_lr_multiplier=args.candidate_parameter_lr_multiplier,
    )
    optimizer = torch.optim.AdamW(parameter_groups, weight_decay=args.weight_decay)
    arrays = context["arrays"]
    candidate_ids = context["candidate_ids"]
    eval_works = set(context["overlay_binding"]["development_eval_work_ids"])
    (
        effective_family_label_values,
        effective_family_weight_values,
        family_override_contract,
    ) = build_family_override_contract(
        arrays,
        context["groups"]["direct_family"],
        development_eval_work_ids=sorted(eval_works),
    )
    query_views = torch.from_numpy(
        arrays["query_views"].astype(np.float32, copy=False)
    ).to(device)
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    labels = torch.from_numpy(arrays["family_labels"].astype(np.int64)).to(device)
    effective_family_labels = torch.from_numpy(effective_family_label_values).to(device)
    positives = torch.from_numpy(arrays["positive_mask"]).to(device)
    preferred = torch.from_numpy(arrays["preferred_mask"]).to(device)
    eligible = torch.from_numpy(arrays["candidate_eligible_mask"]).to(device)
    family_weights = torch.from_numpy(
        arrays["family_label_weights"].astype(np.float32)
    ).to(device)
    effective_family_weights = torch.from_numpy(effective_family_weight_values).to(
        device
    )
    font_weights = torch.from_numpy(
        arrays["font_supervision_weights"].astype(np.float32)
    ).to(device)
    single_day_negative = torch.from_numpy(arrays["single_day_body_negative"]).to(
        device
    )
    weighting_arrays = {
        key: np.array(value, copy=True) for key, value in arrays.items()
    }
    eval_work_mask = np.isin(weighting_arrays["work_ids"].astype(str), list(eval_works))
    weighting_arrays["split"][eval_work_mask] = 1
    candidate_weight_values, candidate_weighting = v8.build_candidate_training_weights(
        weighting_arrays, rare_class_cap=args.rare_class_weight_cap
    )
    candidate_weights = torch.from_numpy(candidate_weight_values).to(device)
    base_train_indices = np.flatnonzero(
        (arrays["split"].astype(np.int64) == 0) & ~eval_work_mask
    )
    family_override_mask = np.zeros(len(arrays["sample_ids"]), dtype=np.bool_)
    family_override_mask[
        [int(row["row_index"]) for row in context["groups"]["direct_family"]["train"]]
    ] = True
    family_override_conflict_mask = family_override_mask & (
        arrays["family_labels"].astype(np.int64) != effective_family_label_values
    )
    if any(
        int(index) in set(base_train_indices.tolist())
        for group in context["groups"]["development_eval"]
        for index in group["row_indices"]
    ):
        raise PageConsistencyTrainingError("development eval entered base gradients")
    with torch.inference_mode():
        anchor_probabilities = v8._anchor_probabilities(
            torch,
            anchor_model,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=args.evaluation_batch_size,
        )
    anchor_base = evaluate_base(
        torch,
        anchor_model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=args.evaluation_batch_size,
    )
    weights_contract = effective_overlay_weights(
        trainable_scope=args.trainable_scope,
        direct_body_ce_weight=args.direct_body_ce_weight,
        direct_family_ce_weight=args.direct_family_ce_weight,
        consistency_js_weight=args.consistency_js_weight,
        common_positive_mass_weight=args.common_positive_mass_weight,
    )
    effective_weights = weights_contract["effective"]
    rng = np.random.default_rng(args.seed)
    started = time.monotonic()
    anchor_train_metrics = _training_only_selection_metrics(
        torch,
        anchor_model,
        direct_rows=context["groups"]["direct_family"]["train"],
        groups=context["groups"]["train"],
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=args.evaluation_batch_size,
    )
    anchor_regression = base_regression_checks(
        anchor_base,
        anchor_base,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    anchor_epoch = {
        "base_metrics": anchor_base,
        "base_no_material_regression": True,
        "base_regression_checks": anchor_regression,
        "checkpoint_selection_inputs": [*CHECKPOINT_SELECTION_INPUTS],
        "development_eval_consulted": False,
        "epoch": 0,
        "family_override_consumption": {
            "conflict_rows": 0,
            "override_batches": 0,
            "override_rows": 0,
            "reason": "frozen_exact_r3h_anchor_fallback",
        },
        "training_only_selection_metrics": anchor_train_metrics,
    }
    history: list[Mapping[str, Any]] = [anchor_epoch]
    best_key: tuple[float, ...] = _selection_key(
        anchor_base, anchor_regression, anchor_train_metrics
    )
    best_state: Mapping[str, Any] = {
        name: value.detach().cpu().clone() for name, value in anchor_state.items()
    }
    best_epoch: Mapping[str, Any] = anchor_epoch
    single_day_index = candidate_ids.index("single-day")
    for epoch in range(1, args.epochs + 1):
        model.train()
        shuffled = rng.permutation(base_train_indices)
        base_batches = [
            shuffled[start : start + args.batch_size]
            for start in range(0, len(shuffled), args.batch_size)
        ]
        overlay_schedule = _schedule_overlay_batches(
            context["groups"]["train"],
            generator=rng,
            groups_per_batch=args.overlay_groups_per_batch,
            step_count=len(base_batches),
        )
        direct_family_schedule = _schedule_direct_family_batches(
            context["groups"]["direct_family"]["train"],
            generator=rng,
            batch_size=args.direct_family_batch_size,
            step_count=len(base_batches),
        )
        epoch_parts: dict[str, list[float]] = {
            "anchor_output": [],
            "anchor_parameter": [],
            "base": [],
            "base_family": [],
            "common_positive_mass": [],
            "consistency_js": [],
            "direct_body_ce": [],
            "direct_family_ce": [],
            "total": [],
        }
        family_override_batches = 0
        family_override_rows_seen = 0
        family_override_conflicts_seen = 0
        for step, base_indices in enumerate(base_batches):
            base_tensor = torch.as_tensor(base_indices, dtype=torch.long, device=device)
            optimizer.zero_grad(set_to_none=True)
            base_outputs = model(query_views[base_tensor], prototypes)
            base_nonfamily_loss, _ = v8.role_family_training_loss(
                torch,
                base_outputs,
                family_labels=labels[base_tensor],
                positive_mask=positives[base_tensor],
                preferred_mask=preferred[base_tensor],
                candidate_eligible_mask=eligible[base_tensor],
                font_supervision_weights=font_weights[base_tensor],
                candidate_loss_weights=candidate_weights[base_tensor],
                family_label_weights=family_weights[base_tensor],
                single_day_body_negative=single_day_negative[base_tensor],
                single_day_index=single_day_index,
                family_weight=0.0,
                hard_negative_weight=args.single_day_hard_negative_weight,
                hard_negative_margin=args.single_day_hard_negative_margin,
                bias_l2_weight=args.bias_l2_weight,
                candidate_distribution_weight=args.candidate_distribution_weight,
                candidate_distribution_slack=args.candidate_distribution_slack,
                candidate_distribution_temperature=args.candidate_distribution_temperature,
                sample_residual_l2_weight=args.sample_residual_l2_weight,
                supervised_single_day_hard_negative_weight=(
                    args.supervised_single_day_hard_negative_weight
                ),
            )
            base_family_loss = base_family_training_loss(
                torch,
                base_outputs["family_logits"],
                family_labels=effective_family_labels[base_tensor],
                family_label_weights=effective_family_weights[base_tensor],
            )
            base_loss = (
                base_nonfamily_loss + float(args.family_weight) * base_family_loss
            )
            anchor_batch = {
                name: value[base_tensor] for name, value in anchor_probabilities.items()
            }
            output_anchor = anchor_output_loss(torch, base_outputs, anchor_batch)
            parameter_anchor = v8.parameter_anchor_loss(torch, model, anchor_state)
            total = (
                float(args.base_loss_weight) * base_loss
                + float(args.anchor_output_weight) * output_anchor
                + float(args.anchor_parameter_weight) * parameter_anchor
            )
            epoch_parts["base"].append(float(base_loss.detach().cpu()))
            epoch_parts["base_family"].append(float(base_family_loss.detach().cpu()))
            epoch_parts["anchor_output"].append(float(output_anchor.detach().cpu()))
            epoch_parts["anchor_parameter"].append(
                float(parameter_anchor.detach().cpu())
            )
            override_rows = int(family_override_mask[base_indices].sum())
            if override_rows:
                family_override_batches += 1
                family_override_rows_seen += override_rows
                family_override_conflicts_seen += int(
                    family_override_conflict_mask[base_indices].sum()
                )
            if step in overlay_schedule:
                overlay_batch = make_overlay_batch(
                    torch, overlay_schedule[step], device=device
                )
                overlay_outputs = model(
                    query_views[overlay_batch["indices"]], prototypes
                )
                overlay_losses = page_consistency_losses(
                    torch,
                    overlay_outputs["body_candidate_scores"],
                    family_logits=overlay_outputs["family_logits"],
                    positive_mask=overlay_batch["positive_mask"],
                    eligible_mask=overlay_batch["eligible_mask"],
                    shared_reviewed_eligible_mask=overlay_batch[
                        "shared_reviewed_eligible_mask"
                    ],
                    common_positive_mask=overlay_batch["common_positive_mask"],
                    group_indices=overlay_batch["group_indices"],
                    row_weights=overlay_batch["row_weights"],
                )
                for name in (
                    "direct_body_ce",
                    "consistency_js",
                    "common_positive_mass",
                ):
                    total = (
                        total + float(effective_weights[name]) * overlay_losses[name]
                    )
                    epoch_parts[name].append(float(overlay_losses[name].detach().cpu()))
            if step in direct_family_schedule:
                direct_rows = direct_family_schedule[step]
                direct_indices = torch.as_tensor(
                    [int(row["row_index"]) for row in direct_rows],
                    dtype=torch.long,
                    device=device,
                )
                direct_outputs = model(query_views[direct_indices], prototypes)
                family_overlay_loss = direct_family_loss(
                    torch,
                    direct_outputs["family_logits"],
                    family_labels=torch.as_tensor(
                        [int(row["family_label"]) for row in direct_rows],
                        dtype=torch.long,
                        device=device,
                    ),
                    row_weights=torch.as_tensor(
                        [float(row["supervision_weight"]) for row in direct_rows],
                        dtype=torch.float32,
                        device=device,
                    ),
                )
                total = (
                    total
                    + float(effective_weights["direct_family_ce"]) * family_overlay_loss
                )
                epoch_parts["direct_family_ce"].append(
                    float(family_overlay_loss.detach().cpu())
                )
            total.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
            optimizer.step()
            epoch_parts["total"].append(float(total.detach().cpu()))
        base_metrics = evaluate_base(
            torch,
            model,
            arrays=arrays,
            query_views=query_views,
            prototypes=prototypes,
            candidate_ids=candidate_ids,
            batch_size=args.evaluation_batch_size,
        )
        regression = base_regression_checks(
            anchor_base,
            base_metrics,
            maximum_acceptable_regression=args.maximum_acceptable_regression,
            maximum_preferred_regression=args.maximum_preferred_regression,
            maximum_family_regression=args.maximum_family_regression,
        )
        mean_parts = {
            name: sum(values) / max(1, len(values))
            for name, values in epoch_parts.items()
        }
        expected_override_counts = family_override_contract["counts"]
        if family_override_rows_seen != int(
            expected_override_counts["direct_train_rows"]
        ) or family_override_conflicts_seen != int(
            expected_override_counts["direct_train_conflicts"]
        ):
            raise PageConsistencyTrainingError(
                "sealed direct family overrides were not consumed exactly once"
            )
        train_selection_metrics = _training_only_selection_metrics(
            torch,
            model,
            direct_rows=context["groups"]["direct_family"]["train"],
            groups=context["groups"]["train"],
            query_views=query_views,
            prototypes=prototypes,
            candidate_ids=candidate_ids,
            batch_size=args.evaluation_batch_size,
        )
        epoch_record = {
            "base_metrics": base_metrics,
            "base_no_material_regression": all(regression.values()),
            "base_regression_checks": regression,
            "checkpoint_selection_inputs": [*CHECKPOINT_SELECTION_INPUTS],
            "development_eval_consulted": False,
            "epoch": epoch,
            "family_override_consumption": {
                "conflict_rows": family_override_conflicts_seen,
                "direct_family_batches": len(direct_family_schedule),
                "direct_family_rows": sum(
                    len(rows) for rows in direct_family_schedule.values()
                ),
                "override_batches": family_override_batches,
                "override_rows": family_override_rows_seen,
                "page_consistency_batches": len(overlay_schedule),
                "page_consistency_groups": sum(
                    len(groups) for groups in overlay_schedule.values()
                ),
            },
            "mean_train_losses": mean_parts,
            "training_only_selection_metrics": train_selection_metrics,
        }
        history.append(epoch_record)
        key = _selection_key(base_metrics, regression, train_selection_metrics)
        if key > best_key:
            best_key = key
            best_epoch = epoch_record
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
    model.load_state_dict(best_state, strict=True)
    model.to(device).eval()
    final_base = evaluate_base(
        torch,
        model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=args.evaluation_batch_size,
    )
    final_base_checks = base_regression_checks(
        anchor_base,
        final_base,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    overlay_evaluation: dict[str, Mapping[str, Any]] = {}
    direct_family_evaluation: dict[str, Mapping[str, Any]] = {}
    diagnostics: dict[str, Mapping[str, Any]] = {}
    for split_name in ("train", "development_eval"):
        groups = context["groups"][split_name]
        anchor_outputs = _overlay_outputs(
            torch,
            anchor_model,
            groups=groups,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=args.evaluation_batch_size,
        )
        candidate_outputs = _overlay_outputs(
            torch,
            model,
            groups=groups,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=args.evaluation_batch_size,
        )
        overlay_evaluation[split_name] = {
            "anchor": overlay_metrics(
                torch, anchor_outputs, groups=groups, candidate_ids=candidate_ids
            ),
            "candidate": overlay_metrics(
                torch, candidate_outputs, groups=groups, candidate_ids=candidate_ids
            ),
        }
        diagnostics[split_name] = bounded_drift_diagnostics(
            torch, candidate_outputs, anchor_outputs, groups=groups
        )
        direct_rows = context["groups"]["direct_family"][split_name]
        direct_indices = np.asarray(
            [int(row["row_index"]) for row in direct_rows], dtype=np.int64
        )
        anchor_direct_outputs = _model_outputs(
            torch,
            anchor_model,
            query_views=query_views,
            prototypes=prototypes,
            indices=direct_indices,
            batch_size=args.evaluation_batch_size,
        )
        candidate_direct_outputs = _model_outputs(
            torch,
            model,
            query_views=query_views,
            prototypes=prototypes,
            indices=direct_indices,
            batch_size=args.evaluation_batch_size,
        )
        direct_family_evaluation[split_name] = {
            "anchor": direct_family_metrics(
                torch,
                anchor_direct_outputs["family_logits"],
                direct_rows=direct_rows,
            ),
            "candidate": direct_family_metrics(
                torch,
                candidate_direct_outputs["family_logits"],
                direct_rows=direct_rows,
            ),
        }
    base_anchor_drift = base_anchor_drift_diagnostics(
        torch,
        model,
        anchor_model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        batch_size=args.evaluation_batch_size,
    )
    with torch.no_grad():
        final_parameter_anchor = float(
            v8.parameter_anchor_loss(torch, model, anchor_state).detach().cpu()
        )
    eval_metrics = overlay_evaluation["development_eval"]
    improvement = overlay_improvement_checks(
        eval_metrics["anchor"],
        eval_metrics["candidate"],
        minimum_js_improvement=args.minimum_overlay_js_improvement,
        minimum_rate_improvement=args.minimum_overlay_rate_improvement,
        maximum_body_rate_regression=args.maximum_body_rate_regression,
    )
    max_delta = float(
        diagnostics["development_eval"]["candidate_body_score_delta"][
            "maximum_absolute_delta"
        ]
    )
    base_max_delta = max(
        float(values["maximum_absolute_delta"])
        for values in base_anchor_drift["score_drift"].values()
    )
    export_checks = {
        **{f"base_{key}": value for key, value in final_base_checks.items()},
        "base_v8_quality_gate_passed": bool(final_base["quality_gate_passed"]),
        "base_validation_candidate_score_delta_within_bound": base_max_delta
        <= args.maximum_candidate_score_delta + 1e-12,
        "development_eval_gradient_rows_zero": True,
        "runtime_architecture_unchanged": True,
    }
    exported = all(export_checks.values())
    status = (
        "experimental_checkpoint_exported" if exported else "rejected_base_regression"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        files: dict[str, Mapping[str, Any]] = {}
        if exported:
            checkpoint_path = staging / CHECKPOINT_FILE
            save_file(best_state, str(checkpoint_path))
            files[CHECKPOINT_FILE] = {
                "byte_size": checkpoint_path.stat().st_size,
                "sha256": sha256_file(checkpoint_path),
            }
        manifest = seal_record(
            {
                "development_diagnostics": {
                    "candidate_score_delta_within_configured_bound": max_delta
                    <= args.maximum_candidate_score_delta + 1e-12,
                    "page_consistency_checks": improvement,
                    "used_for_checkpoint_export": False,
                },
                "export_decision": {
                    "checks": export_checks,
                    "checkpoint_exported": exported,
                    "promotion_claimed": False,
                    "status": status,
                },
                "anchor": {
                    **context["initialization"],
                    "frozen": True,
                    "initialization_and_anchor_are_identical": True,
                },
                "architecture": context["architecture"],
                "authority": dict(EXPECTED_AUTHORITY),
                "base_dataset": {
                    "file": str(context["dataset_path"]),
                    "sha256": EXPECTED_BASE_NPZ_SHA256,
                    "validation": context["inventory"],
                },
                "base_metrics": {"anchor": anchor_base, "candidate": final_base},
                "candidate_ids": list(candidate_ids),
                "candidate_weighting": {
                    **candidate_weighting,
                    "visual_class_frequency_by_candidate": {
                        candidate_id: candidate_weighting["visual_class_frequency"][
                            index
                        ]
                        for index, candidate_id in enumerate(candidate_ids)
                    },
                },
                "configuration": {
                    "anchor_output_weight": args.anchor_output_weight,
                    "anchor_parameter_weight": args.anchor_parameter_weight,
                    "batch_size": args.batch_size,
                    "base_loss_weight": args.base_loss_weight,
                    "bias_l2_weight": args.bias_l2_weight,
                    "candidate_distribution_slack": args.candidate_distribution_slack,
                    "candidate_distribution_temperature": args.candidate_distribution_temperature,
                    "candidate_distribution_weight": args.candidate_distribution_weight,
                    "candidate_parameter_lr_multiplier": (
                        args.candidate_parameter_lr_multiplier
                    ),
                    "consistency_js_weight": args.consistency_js_weight,
                    "direct_body_ce_weight": args.direct_body_ce_weight,
                    "direct_family_batch_size": args.direct_family_batch_size,
                    "direct_family_ce_weight": args.direct_family_ce_weight,
                    "common_positive_mass_weight": args.common_positive_mass_weight,
                    "device": str(device),
                    "effective_overlay_weights": weights_contract,
                    "epochs": args.epochs,
                    "evaluation_batch_size": args.evaluation_batch_size,
                    "family_weight": args.family_weight,
                    "gradient_clip": args.gradient_clip,
                    "learning_rate": args.learning_rate,
                    "maximum_acceptable_regression": args.maximum_acceptable_regression,
                    "maximum_body_rate_regression": args.maximum_body_rate_regression,
                    "maximum_candidate_score_delta": args.maximum_candidate_score_delta,
                    "maximum_family_regression": args.maximum_family_regression,
                    "maximum_preferred_regression": args.maximum_preferred_regression,
                    "minimum_overlay_js_improvement": args.minimum_overlay_js_improvement,
                    "minimum_overlay_rate_improvement": args.minimum_overlay_rate_improvement,
                    "overlay_groups_per_batch": args.overlay_groups_per_batch,
                    "rare_class_weight_cap": args.rare_class_weight_cap,
                    "sample_residual_l2_weight": args.sample_residual_l2_weight,
                    "seed": args.seed,
                    "single_day_hard_negative_margin": args.single_day_hard_negative_margin,
                    "single_day_hard_negative_weight": args.single_day_hard_negative_weight,
                    "supervised_single_day_hard_negative_weight": (
                        args.supervised_single_day_hard_negative_weight
                    ),
                    "trainable_scope": args.trainable_scope,
                    "weight_decay": args.weight_decay,
                },
                "diagnostics": {
                    **diagnostics,
                    "base_validation_anchor_drift": base_anchor_drift,
                    "final_parameter_anchor_loss": final_parameter_anchor,
                },
                "files": files,
                "family_override": family_override_contract,
                "history": history,
                "direct_family_metrics": direct_family_evaluation,
                "overlay": context["overlay_binding"],
                "overlay_metrics": overlay_evaluation,
                "record_type": "manga_font_v3_page_consistency_adapter_manifest",
                "runtime_architecture_unchanged": True,
                "schema_version": SCHEMA_VERSION,
                "selection": {
                    "anchor_fallback_selected": int(best_epoch["epoch"]) == 0,
                    "base_gradient_rows": int(len(base_train_indices)),
                    "best_epoch": best_epoch["epoch"],
                    "development_eval_consulted_during_checkpoint_selection": False,
                    "development_eval_excluded_work_ids": sorted(eval_works),
                    "development_eval_gradient_rows": 0,
                    "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
                    "direct_family_gradient_rows": len(
                        context["groups"]["direct_family"]["train"]
                    ),
                    "model_selection_label_sources": [
                        *MODEL_SELECTION_LABEL_SOURCES,
                    ],
                    "page_consistency_gradient_groups": len(context["groups"]["train"]),
                    "page_consistency_gradient_rows": sum(
                        len(group["row_indices"])
                        for group in context["groups"]["train"]
                    ),
                    "selection_key_order": [*SELECTION_KEY_ORDER],
                },
                "source_query_head": {
                    "file": str(context["source_head"]),
                    "sha256": EXPECTED_SOURCE_QUERY_HEAD_SHA256,
                },
                "trainable_parameters": trainable_parameters,
                "training_seconds": time.monotonic() - started,
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        marker_files = {
            MANIFEST_FILE: sha256_file(manifest_path),
            **(
                {CHECKPOINT_FILE: sha256_file(staging / CHECKPOINT_FILE)}
                if exported
                else {}
            ),
        }
        marker = seal_record(
            {
                "artifacts": marker_files,
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


def _strict_recompute_exported_candidate(
    *,
    root: Path,
    manifest: Mapping[str, Any],
    context: Mapping[str, Any],
    torch: Any,
) -> None:
    try:
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise PageConsistencyTrainingError("safetensors is required") from error
    device = torch.device("cpu")
    anchor_model = context["model"].to(device).eval()
    model = copy.deepcopy(anchor_model).to(device).eval()
    state = load_file(str(root / CHECKPOINT_FILE), device="cpu")
    model.load_state_dict(state, strict=True)
    arrays = context["arrays"]
    query_views = torch.from_numpy(
        arrays["query_views"].astype(np.float32, copy=False)
    ).to(device)
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    candidate_ids = context["candidate_ids"]
    configuration = _mapping(manifest["configuration"], "strict configuration")
    batch_size = int(configuration["evaluation_batch_size"])
    anchor_base = evaluate_base(
        torch,
        anchor_model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=batch_size,
    )
    candidate_base = evaluate_base(
        torch,
        model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=batch_size,
    )
    overlay_evaluation: dict[str, Mapping[str, Any]] = {}
    direct_evaluation: dict[str, Mapping[str, Any]] = {}
    overlay_drift: dict[str, Mapping[str, Any]] = {}
    for split_name in ("train", "development_eval"):
        groups = context["groups"][split_name]
        anchor_outputs = _overlay_outputs(
            torch,
            anchor_model,
            groups=groups,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=batch_size,
        )
        candidate_outputs = _overlay_outputs(
            torch,
            model,
            groups=groups,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=batch_size,
        )
        overlay_evaluation[split_name] = {
            "anchor": overlay_metrics(
                torch, anchor_outputs, groups=groups, candidate_ids=candidate_ids
            ),
            "candidate": overlay_metrics(
                torch, candidate_outputs, groups=groups, candidate_ids=candidate_ids
            ),
        }
        direct_rows = context["groups"]["direct_family"][split_name]
        indices = np.asarray(
            [int(row["row_index"]) for row in direct_rows], dtype=np.int64
        )
        anchor_direct = _model_outputs(
            torch,
            anchor_model,
            query_views=query_views,
            prototypes=prototypes,
            indices=indices,
            batch_size=batch_size,
        )
        candidate_direct = _model_outputs(
            torch,
            model,
            query_views=query_views,
            prototypes=prototypes,
            indices=indices,
            batch_size=batch_size,
        )
        direct_evaluation[split_name] = {
            "anchor": direct_family_metrics(
                torch, anchor_direct["family_logits"], direct_rows=direct_rows
            ),
            "candidate": direct_family_metrics(
                torch, candidate_direct["family_logits"], direct_rows=direct_rows
            ),
        }
        overlay_drift[split_name] = bounded_drift_diagnostics(
            torch, candidate_outputs, anchor_outputs, groups=groups
        )
    drift = base_anchor_drift_diagnostics(
        torch,
        model,
        anchor_model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        batch_size=batch_size,
    )
    regression = base_regression_checks(
        anchor_base,
        candidate_base,
        maximum_acceptable_regression=float(
            configuration["maximum_acceptable_regression"]
        ),
        maximum_preferred_regression=float(
            configuration["maximum_preferred_regression"]
        ),
        maximum_family_regression=float(configuration["maximum_family_regression"]),
    )
    maximum_delta = max(
        float(values["maximum_absolute_delta"])
        for values in drift["score_drift"].values()
    )
    recomputed_checks = {
        **{f"base_{key}": value for key, value in regression.items()},
        "base_v8_quality_gate_passed": bool(candidate_base["quality_gate_passed"]),
        "base_validation_candidate_score_delta_within_bound": maximum_delta
        <= float(configuration["maximum_candidate_score_delta"]) + 1e-12,
        "development_eval_gradient_rows_zero": True,
        "runtime_architecture_unchanged": True,
    }
    anchor_state = {
        name: value.detach().clone()
        for name, value in anchor_model.state_dict().items()
    }
    with torch.no_grad():
        parameter_anchor = float(
            v8.parameter_anchor_loss(torch, model, anchor_state).detach().cpu()
        )
    recomputed_diagnostics = {
        **overlay_drift,
        "base_validation_anchor_drift": drift,
        "final_parameter_anchor_loss": parameter_anchor,
    }
    development_overlay = overlay_evaluation["development_eval"]
    development_score_delta = float(
        overlay_drift["development_eval"]["candidate_body_score_delta"][
            "maximum_absolute_delta"
        ]
    )
    recomputed_development = {
        "candidate_score_delta_within_configured_bound": development_score_delta
        <= float(configuration["maximum_candidate_score_delta"]) + 1e-12,
        "page_consistency_checks": overlay_improvement_checks(
            development_overlay["anchor"],
            development_overlay["candidate"],
            minimum_js_improvement=float(
                configuration["minimum_overlay_js_improvement"]
            ),
            minimum_rate_improvement=float(
                configuration["minimum_overlay_rate_improvement"]
            ),
            maximum_body_rate_regression=float(
                configuration["maximum_body_rate_regression"]
            ),
        ),
        "used_for_checkpoint_export": False,
    }
    _assert_nested_close(
        {"anchor": anchor_base, "candidate": candidate_base},
        manifest["base_metrics"],
        "strict base metrics",
    )
    _assert_nested_close(
        overlay_evaluation,
        manifest["overlay_metrics"],
        "strict overlay metrics",
    )
    _assert_nested_close(
        direct_evaluation,
        manifest["direct_family_metrics"],
        "strict direct-family metrics",
    )
    _assert_nested_close(
        recomputed_diagnostics,
        manifest["diagnostics"],
        "strict diagnostics",
    )
    _assert_nested_close(
        recomputed_development,
        manifest["development_diagnostics"],
        "strict development diagnostics",
    )
    decision = _mapping(manifest["export_decision"], "strict export decision")
    if decision["checks"] != recomputed_checks or not all(recomputed_checks.values()):
        raise PageConsistencyTrainingError("strict checkpoint export checks drifted")
    selection = _mapping(manifest["selection"], "strict selection")
    history = manifest["history"]
    selected_record = _mapping(
        history[int(selection["best_epoch"])], "strict selected history"
    )
    anchor_record = _mapping(history[0], "strict anchor history")
    anchor_regression = base_regression_checks(
        anchor_base,
        anchor_base,
        maximum_acceptable_regression=float(
            configuration["maximum_acceptable_regression"]
        ),
        maximum_preferred_regression=float(
            configuration["maximum_preferred_regression"]
        ),
        maximum_family_regression=float(configuration["maximum_family_regression"]),
    )
    if (
        anchor_record["base_regression_checks"] != anchor_regression
        or anchor_record["base_no_material_regression"]
        is not all(anchor_regression.values())
        or selected_record["base_regression_checks"] != regression
        or selected_record["base_no_material_regression"]
        is not all(regression.values())
    ):
        raise PageConsistencyTrainingError(
            "strict selected-history base regression drifted"
        )
    _assert_nested_close(
        anchor_base,
        anchor_record["base_metrics"],
        "strict anchor-history base metrics",
    )
    anchor_train_metrics = _training_only_selection_metrics(
        torch,
        anchor_model,
        direct_rows=context["groups"]["direct_family"]["train"],
        groups=context["groups"]["train"],
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=batch_size,
    )
    _assert_nested_close(
        anchor_train_metrics,
        anchor_record["training_only_selection_metrics"],
        "strict anchor-history train metrics",
    )
    _assert_nested_close(
        candidate_base,
        selected_record["base_metrics"],
        "strict selected base metrics",
    )
    selected_train_metrics = _training_only_selection_metrics(
        torch,
        model,
        direct_rows=context["groups"]["direct_family"]["train"],
        groups=context["groups"]["train"],
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=batch_size,
    )
    _assert_nested_close(
        selected_train_metrics,
        selected_record["training_only_selection_metrics"],
        "strict selected train metrics",
    )


def validate_output(
    output_dir: Path, *, require_external_sources: bool = True
) -> Mapping[str, Any]:
    expanded = output_dir.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise PageConsistencyTrainingError("candidate artifact cannot be linked")
    root = expanded.resolve()
    if not root.is_dir() or overlay_v3._contains_link_or_reparse(root):
        raise PageConsistencyTrainingError("candidate artifact is missing or linked")
    marker = _read_json(root / MARKER_FILE, "candidate marker")
    manifest = _read_json(root / MANIFEST_FILE, "candidate manifest")
    validate_record_seal(marker, "candidate marker")
    validate_record_seal(manifest, "candidate manifest")
    decision = _mapping(manifest.get("export_decision"), "candidate export decision")
    exported = decision.get("status") == "experimental_checkpoint_exported"
    if (
        decision.get("status")
        not in {
            "experimental_checkpoint_exported",
            "rejected_base_regression",
        }
        or decision.get("checkpoint_exported") is not exported
    ):
        raise PageConsistencyTrainingError("candidate export status drifted")
    expected_files = {MANIFEST_FILE, MARKER_FILE} | (
        {CHECKPOINT_FILE} if exported else set()
    )
    if {path.name for path in root.iterdir()} != expected_files or any(
        path.is_symlink() for path in root.iterdir()
    ):
        raise PageConsistencyTrainingError("candidate exact inventory drifted")
    artifacts = _mapping(marker.get("artifacts"), "candidate marker artifacts")
    expected_artifacts = expected_files - {MARKER_FILE}
    if (
        set(marker) != EXPECTED_MARKER_KEYS
        or set(manifest) != EXPECTED_MANIFEST_KEYS
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not False
        or marker.get("schema_version") != SCHEMA_VERSION
        or set(artifacts) != expected_artifacts
        or any(artifacts[name] != sha256_file(root / name) for name in artifacts)
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v3_page_consistency_adapter_manifest"
        or decision.get("promotion_claimed") is not False
        or manifest.get("runtime_architecture_unchanged") is not True
        or isinstance(manifest.get("training_seconds"), bool)
        or not isinstance(manifest.get("training_seconds"), (int, float))
        or not math.isfinite(float(manifest["training_seconds"]))
        or float(manifest["training_seconds"]) < 0
    ):
        raise PageConsistencyTrainingError("candidate marker/manifest drifted")
    authority = _mapping(manifest.get("authority"), "candidate authority")
    selection = _mapping(manifest.get("selection"), "candidate selection")
    development = _mapping(
        manifest.get("development_diagnostics"), "development diagnostics"
    )
    checks = _mapping(decision.get("checks"), "candidate export checks")
    development_checks = _mapping(
        development.get("page_consistency_checks"),
        "development page-consistency checks",
    )
    if (
        dict(authority) != EXPECTED_AUTHORITY
        or set(decision)
        != {"checkpoint_exported", "checks", "promotion_claimed", "status"}
        or selection.get("development_eval_gradient_rows") != 0
        or selection.get("development_eval_consulted_during_checkpoint_selection")
        is not False
        or selection.get(
            "development_eval_label_rows_consulted_during_checkpoint_selection"
        )
        != 0
        or set(development)
        != {
            "candidate_score_delta_within_configured_bound",
            "page_consistency_checks",
            "used_for_checkpoint_export",
        }
        or development.get("used_for_checkpoint_export") is not False
        or not isinstance(
            development.get("candidate_score_delta_within_configured_bound"), bool
        )
        or set(development_checks) != EXPECTED_OVERLAY_IMPROVEMENT_CHECKS
        or any(not isinstance(value, bool) for value in development_checks.values())
        or set(checks) != EXPECTED_EXPORT_CHECKS
        or any(not isinstance(value, bool) for value in checks.values())
        or (exported and not all(value is True for value in checks.values()))
        or (
            not exported
            and (not checks or all(value is True for value in checks.values()))
        )
    ):
        raise PageConsistencyTrainingError("candidate authority was elevated")
    candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
    architecture = _mapping(manifest.get("architecture"), "candidate architecture")
    expected_architecture = v8.adapter_architecture_contract(
        candidate_count=len(candidate_ids),
        maximum_family_bias=0.1,
        candidate_residual_hidden_dim=64,
        maximum_sample_residual=0.75,
    )
    base = _mapping(manifest.get("base_dataset"), "candidate base dataset")
    source_head = _mapping(
        manifest.get("source_query_head"), "candidate source query head"
    )
    anchor = _mapping(manifest.get("anchor"), "candidate anchor")
    if (
        architecture != expected_architecture
        or candidate_ids != EXPECTED_CANDIDATE_IDS
        or base.get("sha256") != EXPECTED_BASE_NPZ_SHA256
        or source_head.get("sha256") != EXPECTED_SOURCE_QUERY_HEAD_SHA256
        or anchor.get("checkpoint_sha256") != EXPECTED_ANCHOR_CHECKPOINT_SHA256
        or anchor.get("manifest_sha256") != EXPECTED_ANCHOR_MANIFEST_SHA256
        or anchor.get("manifest_record_sha256")
        != EXPECTED_ANCHOR_MANIFEST_RECORD_SHA256
        or anchor.get("frozen") is not True
        or anchor.get("initialization_and_anchor_are_identical") is not True
    ):
        raise PageConsistencyTrainingError("candidate provenance contract drifted")
    configuration = _mapping(manifest.get("configuration"), "candidate configuration")
    integer_configuration = (
        "batch_size",
        "direct_family_batch_size",
        "epochs",
        "evaluation_batch_size",
        "overlay_groups_per_batch",
        "seed",
    )
    if (
        set(configuration) != EXPECTED_CONFIGURATION_KEYS
        or any(
            not isinstance(configuration.get(name), int)
            or isinstance(configuration.get(name), bool)
            for name in integer_configuration
        )
        or configuration.get("device") not in {"cpu", "cuda"}
    ):
        raise PageConsistencyTrainingError("candidate configuration inventory drifted")
    trainable_scope = configuration.get("trainable_scope")
    if trainable_scope not in {"all", "family-head-only"}:
        raise PageConsistencyTrainingError("candidate trainable scope drifted")
    _validate_options(argparse.Namespace(**configuration))
    trainable = _mapping(
        manifest.get("trainable_parameters"), "candidate trainable parameters"
    )
    expected_candidate_names = (
        list(EXPECTED_CANDIDATE_PARAMETER_NAMES) if trainable_scope == "all" else []
    )
    expected_candidate_count = (
        EXPECTED_CANDIDATE_PARAMETER_COUNT if trainable_scope == "all" else 0
    )
    configured_candidate_multiplier = configuration.get(
        "candidate_parameter_lr_multiplier"
    )
    if (
        set(trainable)
        != {
            "candidate_parameter_count",
            "candidate_parameter_lr_multiplier",
            "candidate_parameter_names",
            "family_parameter_count",
            "family_parameter_names",
            "trainable_scope",
        }
        or not isinstance(configured_candidate_multiplier, (int, float))
        or not math.isfinite(float(configured_candidate_multiplier))
        or float(configured_candidate_multiplier) < 0
        or (trainable_scope == "all" and float(configured_candidate_multiplier) <= 0)
        or trainable.get("trainable_scope") != trainable_scope
        or trainable.get("candidate_parameter_lr_multiplier")
        != configured_candidate_multiplier
        or trainable.get("candidate_parameter_count") != expected_candidate_count
        or trainable.get("candidate_parameter_names") != expected_candidate_names
        or trainable.get("family_parameter_count") != EXPECTED_FAMILY_PARAMETER_COUNT
        or trainable.get("family_parameter_names")
        != list(EXPECTED_FAMILY_PARAMETER_NAMES)
    ):
        raise PageConsistencyTrainingError(
            "candidate trainable parameter inventory drifted"
        )
    family_override = _mapping(
        manifest.get("family_override"), "candidate family override"
    )
    override_counts = _mapping(
        family_override.get("counts"), "candidate family override counts"
    )
    if (
        dict(override_counts) != EXPECTED_FAMILY_OVERRIDE_COUNTS
        or family_override.get("base_candidate_and_single_day_route_labels_unchanged")
        is not True
        or family_override.get("development_eval_overrides_applied") != 0
        or family_override.get("direct_train_overrides_applied")
        != EXPECTED_FAMILY_OVERRIDE_COUNTS["direct_train_rows"]
        or family_override.get("direct_train_supervision_authority")
        != "training_only_non_human_visual"
        or not overlay_v3._is_sha256(
            family_override.get("direct_train_override_inventory_sha256")
        )
    ):
        raise PageConsistencyTrainingError("candidate family override drifted")
    effective = _mapping(
        configuration.get("effective_overlay_weights"),
        "candidate effective overlay weights",
    )
    weight_names = (
        "base_loss_weight",
        "common_positive_mass_weight",
        "consistency_js_weight",
        "direct_body_ce_weight",
        "direct_family_ce_weight",
        "family_weight",
    )
    if any(
        isinstance(configuration.get(name), bool)
        or not isinstance(configuration.get(name), (int, float))
        or not math.isfinite(float(configuration[name]))
        or float(configuration[name]) < 0
        for name in weight_names
    ) or any(
        float(configuration[name]) <= 0
        for name in ("base_loss_weight", "family_weight")
    ):
        raise PageConsistencyTrainingError(
            "candidate base/family supervision weight contract drifted"
        )
    expected_effective = effective_overlay_weights(
        trainable_scope=str(trainable_scope),
        direct_body_ce_weight=float(configuration["direct_body_ce_weight"]),
        direct_family_ce_weight=float(configuration["direct_family_ce_weight"]),
        consistency_js_weight=float(configuration["consistency_js_weight"]),
        common_positive_mass_weight=float(configuration["common_positive_mass_weight"]),
    )
    if dict(effective) != expected_effective:
        raise PageConsistencyTrainingError(
            "candidate effective overlay weight contract drifted"
        )
    epochs = configuration.get("epochs")
    batch_size = configuration.get("batch_size")
    direct_batch_size = configuration.get("direct_family_batch_size")
    overlay_groups_per_batch = configuration.get("overlay_groups_per_batch")
    history = manifest.get("history")
    if (
        not isinstance(epochs, int)
        or epochs < 1
        or not isinstance(batch_size, int)
        or isinstance(batch_size, bool)
        or batch_size < 1
        or not isinstance(direct_batch_size, int)
        or direct_batch_size < 1
        or not isinstance(overlay_groups_per_batch, int)
        or overlay_groups_per_batch < 1
        or not isinstance(history, Sequence)
        or isinstance(history, (str, bytes))
        or len(history) != epochs + 1
        or set(selection) != EXPECTED_SELECTION_KEYS
        or selection.get("base_gradient_rows")
        != EXPECTED_FAMILY_OVERRIDE_COUNTS["base_train_rows"]
        or selection.get("development_eval_excluded_work_ids")
        != list(EXPECTED_DEVELOPMENT_EVAL_WORK_IDS)
        or selection.get("direct_family_gradient_rows")
        != EXPECTED_FAMILY_OVERRIDE_COUNTS["direct_train_rows"]
        or selection.get("page_consistency_gradient_groups")
        != overlay_v3.PRODUCTION_COUNTS["train_group_count"]
        or selection.get("page_consistency_gradient_rows")
        != overlay_v3.PRODUCTION_COUNTS["train_row_count"]
        or not isinstance(selection.get("best_epoch"), int)
        or isinstance(selection.get("best_epoch"), bool)
        or selection.get("best_epoch") not in range(epochs + 1)
        or selection.get("anchor_fallback_selected")
        is not (selection.get("best_epoch") == 0)
        or selection.get("model_selection_label_sources")
        != list(MODEL_SELECTION_LABEL_SOURCES)
        or selection.get("selection_key_order") != list(SELECTION_KEY_ORDER)
    ):
        raise PageConsistencyTrainingError("candidate selection history drifted")
    recomputed_best_epoch = 0
    recomputed_best_key: tuple[float, ...] | None = None
    history_anchor_record = _mapping(history[0], "candidate history epoch 0")
    history_anchor_base = _mapping(
        history_anchor_record.get("base_metrics"),
        "candidate history epoch 0 base metrics",
    )
    for epoch, raw_record in enumerate(history):
        record = _mapping(raw_record, f"candidate history epoch {epoch}")
        base_metrics = _mapping(
            record.get("base_metrics"), f"candidate history epoch {epoch} base metrics"
        )
        regression = _mapping(
            record.get("base_regression_checks"),
            f"candidate history epoch {epoch} base regression checks",
        )
        consumption = _mapping(
            record.get("family_override_consumption"),
            f"candidate history epoch {epoch} family override consumption",
        )
        train_metrics = _mapping(
            record.get("training_only_selection_metrics"),
            f"candidate history epoch {epoch} train metrics",
        )
        direct_metrics = _mapping(
            train_metrics.get("direct_family"),
            f"candidate history epoch {epoch} direct metrics",
        )
        page_metrics = _mapping(
            train_metrics.get("page_consistency"),
            f"candidate history epoch {epoch} page metrics",
        )
        required_metric_values = [
            direct_metrics.get("balanced_accuracy"),
            direct_metrics.get("body_accuracy"),
            direct_metrics.get("variant_accuracy"),
            page_metrics.get("all_rows_top1_in_common_positive_rate"),
            page_metrics.get("top1_all_agree_rate"),
            page_metrics.get("mean_js"),
            page_metrics.get("mean_common_positive_mass"),
        ]
        try:
            expected_epoch_regression = base_regression_checks(
                history_anchor_base,
                base_metrics,
                maximum_acceptable_regression=float(
                    configuration["maximum_acceptable_regression"]
                ),
                maximum_preferred_regression=float(
                    configuration["maximum_preferred_regression"]
                ),
                maximum_family_regression=float(
                    configuration["maximum_family_regression"]
                ),
            )
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise PageConsistencyTrainingError(
                "candidate history base regression could not be reconstructed"
            ) from error
        if (
            record.get("epoch") != epoch
            or record.get("development_eval_consulted") is not False
            or record.get("checkpoint_selection_inputs")
            != list(CHECKPOINT_SELECTION_INPUTS)
            or not isinstance(base_metrics.get("quality_gate_passed"), bool)
            or set(regression) != EXPECTED_BASE_REGRESSION_CHECKS
            or any(not isinstance(value, bool) for value in regression.values())
            or dict(regression) != expected_epoch_regression
            or record.get("base_no_material_regression")
            is not all(expected_epoch_regression.values())
            or any(
                not isinstance(value, (int, float)) or not math.isfinite(float(value))
                for value in required_metric_values
            )
        ):
            raise PageConsistencyTrainingError(
                "candidate training-only selection metrics drifted"
            )
        try:
            epoch_key = _selection_key(base_metrics, regression, train_metrics)
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise PageConsistencyTrainingError(
                "candidate checkpoint selection key could not be reconstructed"
            ) from error
        if any(not math.isfinite(value) for value in epoch_key):
            raise PageConsistencyTrainingError(
                "candidate checkpoint selection key is non-finite"
            )
        if recomputed_best_key is None or epoch_key > recomputed_best_key:
            recomputed_best_key = epoch_key
            recomputed_best_epoch = epoch
        if epoch == 0:
            if (
                consumption.get("override_rows") != 0
                or consumption.get("conflict_rows") != 0
                or consumption.get("override_batches") != 0
            ):
                raise PageConsistencyTrainingError(
                    "candidate epoch-zero anchor fallback drifted"
                )
            continue
        expected_direct_batches = math.ceil(
            EXPECTED_FAMILY_OVERRIDE_COUNTS["direct_train_rows"] / direct_batch_size
        )
        expected_page_batches = math.ceil(
            overlay_v3.PRODUCTION_COUNTS["train_group_count"] / overlay_groups_per_batch
        )
        if (
            consumption.get("override_rows")
            != EXPECTED_FAMILY_OVERRIDE_COUNTS["direct_train_rows"]
            or consumption.get("conflict_rows")
            != EXPECTED_FAMILY_OVERRIDE_COUNTS["direct_train_conflicts"]
            or not isinstance(consumption.get("override_batches"), int)
            or not 1
            <= consumption["override_batches"]
            <= math.ceil(
                EXPECTED_FAMILY_OVERRIDE_COUNTS["base_train_rows"] / batch_size
            )
            or consumption.get("direct_family_rows")
            != EXPECTED_FAMILY_OVERRIDE_COUNTS["direct_train_rows"]
            or consumption.get("direct_family_batches") != expected_direct_batches
            or consumption.get("page_consistency_groups")
            != overlay_v3.PRODUCTION_COUNTS["train_group_count"]
            or consumption.get("page_consistency_batches") != expected_page_batches
        ):
            raise PageConsistencyTrainingError(
                "candidate family override batch consumption drifted"
            )
    if selection.get("best_epoch") != recomputed_best_epoch:
        raise PageConsistencyTrainingError(
            "candidate checkpoint selection argmax drifted"
        )
    if configuration.get("trainable_scope") == "family-head-only":
        effective_values = _mapping(effective.get("effective"), "effective weights")
        if (
            effective.get("candidate_objectives_disabled") is not True
            or effective_values.get("consistency_js") != 0.0
            or effective_values.get("common_positive_mass") != 0.0
        ):
            raise PageConsistencyTrainingError(
                "family-head-only candidate objectives were not disabled"
            )
    strict_context: Mapping[str, Any] | None = None
    strict_torch: Any | None = None
    if require_external_sources:
        try:
            import torch
        except ImportError as error:  # pragma: no cover - runtime dependency
            raise PageConsistencyTrainingError("PyTorch is required") from error
        dataset_input = Path(str(base.get("file"))).expanduser().absolute()
        source_head_input = Path(str(source_head.get("file"))).expanduser().absolute()
        if overlay_v3._path_or_ancestor_is_link_or_reparse(dataset_input):
            raise PageConsistencyTrainingError("candidate base NPZ cannot be linked")
        if overlay_v3._path_or_ancestor_is_link_or_reparse(source_head_input):
            raise PageConsistencyTrainingError(
                "candidate source query head cannot be linked"
            )
        dataset_path = dataset_input.resolve()
        if sha256_file(dataset_path) != EXPECTED_BASE_NPZ_SHA256:
            raise PageConsistencyTrainingError("candidate base NPZ binding drifted")
        if (
            sha256_file(source_head_input.resolve())
            != EXPECTED_SOURCE_QUERY_HEAD_SHA256
        ):
            raise PageConsistencyTrainingError("candidate source-query binding drifted")
        _exact_anchor_manifest(Path(str(anchor.get("output_dir"))))
        overlay_binding = _mapping(manifest.get("overlay"), "candidate overlay")
        overlay_validation = _mapping(
            overlay_binding.get("validation"), "candidate overlay validation"
        )
        context_args = argparse.Namespace(
            anchor_adapter_dir=Path(str(anchor["output_dir"])),
            base_npz=dataset_input,
            overlay_dir=Path(str(overlay_validation["output_dir"])),
            source_query_head=source_head_input,
        )
        strict_context = _load_context(context_args, torch)
        strict_torch = torch
        expected_anchor = {
            **strict_context["initialization"],
            "frozen": True,
            "initialization_and_anchor_are_identical": True,
        }
        if (
            set(base) != {"file", "sha256", "validation"}
            or set(source_head) != {"file", "sha256"}
            or dict(anchor) != expected_anchor
        ):
            raise PageConsistencyTrainingError(
                "candidate exact external provenance inventory drifted"
            )
        arrays = strict_context["arrays"]
        inventory = strict_context["inventory"]
        base_validation = _mapping(
            base.get("validation"), "candidate base validation inventory"
        )
        if dict(base_validation) != _json_contract_value(inventory):
            raise PageConsistencyTrainingError(
                "candidate base validation inventory drifted"
            )
        groups = strict_context["groups"]
        recomputed_overlay_binding = strict_context["overlay_binding"]
        if recomputed_overlay_binding != overlay_binding:
            raise PageConsistencyTrainingError("candidate full overlay binding drifted")
        _, _, recomputed_family_override = build_family_override_contract(
            arrays,
            groups["direct_family"],
            development_eval_work_ids=overlay_binding["development_eval_work_ids"],
        )
        if recomputed_family_override != family_override:
            raise PageConsistencyTrainingError(
                "candidate family override/source binding drifted"
            )
    files = _mapping(manifest.get("files"), "candidate files")
    if set(files) != ({CHECKPOINT_FILE} if exported else set()):
        raise PageConsistencyTrainingError("candidate file manifest drifted")
    if exported:
        checkpoint = _mapping(files.get(CHECKPOINT_FILE), "candidate checkpoint")
        path = root / CHECKPOINT_FILE
        if checkpoint.get("byte_size") != path.stat().st_size or checkpoint.get(
            "sha256"
        ) != sha256_file(path):
            raise PageConsistencyTrainingError("candidate checkpoint drifted")
        try:
            from safetensors.numpy import load_file
        except ImportError as error:  # pragma: no cover - runtime dependency
            raise PageConsistencyTrainingError("safetensors is required") from error
        candidate_state = load_file(str(path))
        anchor_state = load_file(
            str(Path(str(anchor.get("output_dir"))) / v8.CHECKPOINT_FILE)
        )
        if set(candidate_state) != set(anchor_state) or any(
            candidate_state[name].shape != anchor_state[name].shape
            or candidate_state[name].dtype != anchor_state[name].dtype
            or not np.isfinite(candidate_state[name]).all()
            for name in candidate_state
        ):
            raise PageConsistencyTrainingError(
                "candidate runtime-compatible state drifted"
            )
        if selection.get("best_epoch") == 0 and any(
            candidate_state[name].tobytes(order="C")
            != anchor_state[name].tobytes(order="C")
            for name in candidate_state
        ):
            raise PageConsistencyTrainingError(
                "anchor-fallback checkpoint drifted from exact r3h"
            )
        if configuration.get("trainable_scope") == "family-head-only":
            frozen_names = [
                name
                for name in candidate_state
                if not name.startswith(FAMILY_TRAINABLE_PREFIXES)
            ]
            if not frozen_names or any(
                candidate_state[name].tobytes(order="C")
                != anchor_state[name].tobytes(order="C")
                for name in frozen_names
            ):
                raise PageConsistencyTrainingError(
                    "family-head-only frozen tensors drifted from exact r3h"
                )
        if require_external_sources:
            if strict_context is None or strict_torch is None:  # pragma: no cover
                raise PageConsistencyTrainingError(
                    "strict external context was not reconstructed"
                )
            _strict_recompute_exported_candidate(
                root=root,
                manifest=manifest,
                context=strict_context,
                torch=strict_torch,
            )
    return {
        "checkpoint_exported": exported,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(root / MANIFEST_FILE),
        "output_dir": str(root),
        "promotion_claimed": False,
        "schema_version": SCHEMA_VERSION,
        "status": decision["status"],
    }


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    """Recompute an exported candidate's base and overlay metrics read-only."""

    validation = validate_output(args.output_dir)
    manifest = _read_json(
        args.output_dir.expanduser().resolve() / MANIFEST_FILE, "candidate manifest"
    )
    if not validation["checkpoint_exported"]:
        return {
            **validation,
            "read_only_recomputation": False,
            "reason": "rejected artifact has no checkpoint bytes",
            "sealed_metrics_only": True,
        }
    try:
        import torch
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise PageConsistencyTrainingError(
            "PyTorch and safetensors are required"
        ) from error
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise PageConsistencyTrainingError("CUDA was requested but is unavailable")
    base = _mapping(manifest.get("base_dataset"), "candidate base dataset")
    anchor = _mapping(manifest.get("anchor"), "candidate anchor")
    source_head = _mapping(
        manifest.get("source_query_head"), "candidate source query head"
    )
    overlay = _mapping(manifest.get("overlay"), "candidate overlay")
    overlay_validation = _mapping(
        overlay.get("validation"), "candidate overlay validation"
    )
    context_args = argparse.Namespace(
        anchor_adapter_dir=Path(str(anchor["output_dir"])),
        base_npz=Path(str(base["file"])),
        overlay_dir=Path(str(overlay_validation["output_dir"])),
        source_query_head=Path(str(source_head["file"])),
    )
    context = _load_context(context_args, torch)
    model = context["model"]
    state = load_file(
        str(args.output_dir.expanduser().resolve() / CHECKPOINT_FILE), device="cpu"
    )
    model.load_state_dict(state, strict=True)
    model.to(device).eval()
    arrays = context["arrays"]
    query_views = torch.from_numpy(
        arrays["query_views"].astype(np.float32, copy=False)
    ).to(device)
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    candidate_ids = context["candidate_ids"]
    base_metrics = evaluate_base(
        torch,
        model,
        arrays=arrays,
        query_views=query_views,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        batch_size=args.batch_size,
    )
    overlay_metrics_by_split: dict[str, Mapping[str, Any]] = {}
    direct_metrics_by_split: dict[str, Mapping[str, Any]] = {}
    for split_name in ("train", "development_eval"):
        groups = context["groups"][split_name]
        outputs = _overlay_outputs(
            torch,
            model,
            groups=groups,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=args.batch_size,
        )
        overlay_metrics_by_split[split_name] = overlay_metrics(
            torch, outputs, groups=groups, candidate_ids=candidate_ids
        )
        direct_rows = context["groups"]["direct_family"][split_name]
        direct_outputs = _model_outputs(
            torch,
            model,
            query_views=query_views,
            prototypes=prototypes,
            indices=np.asarray(
                [int(row["row_index"]) for row in direct_rows], dtype=np.int64
            ),
            batch_size=args.batch_size,
        )
        direct_metrics_by_split[split_name] = direct_family_metrics(
            torch, direct_outputs["family_logits"], direct_rows=direct_rows
        )
    return {
        **validation,
        "recomputed_base_metrics": base_metrics,
        "recomputed_direct_family_metrics": direct_metrics_by_split,
        "recomputed_overlay_metrics": overlay_metrics_by_split,
        "read_only_recomputation": True,
        "sealed_metrics_only": False,
    }


def _add_shared_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-npz", type=Path, default=DEFAULT_BASE_NPZ)
    parser.add_argument("--overlay-dir", type=Path, default=DEFAULT_OVERLAY_DIR)
    parser.add_argument("--anchor-adapter-dir", type=Path, default=DEFAULT_ANCHOR_DIR)
    parser.add_argument(
        "--source-query-head", type=Path, default=DEFAULT_SOURCE_QUERY_HEAD
    )
    parser.add_argument(
        "--trainable-scope", choices=("all", "family-head-only"), default="all"
    )
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--overlay-groups-per-batch", type=int, default=8)
    parser.add_argument("--direct-family-batch-size", type=int, default=128)
    parser.add_argument("--evaluation-batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--candidate-parameter-lr-multiplier", type=float, default=1.0)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--base-loss-weight", type=float, default=1.0)
    parser.add_argument("--direct-body-ce-weight", type=float, default=0.10)
    parser.add_argument("--direct-family-ce-weight", type=float, default=0.10)
    parser.add_argument("--consistency-js-weight", type=float, default=0.05)
    parser.add_argument("--common-positive-mass-weight", type=float, default=0.10)
    parser.add_argument("--anchor-output-weight", type=float, default=0.10)
    parser.add_argument("--anchor-parameter-weight", type=float, default=0.01)
    parser.add_argument("--family-weight", type=float, default=0.35)
    parser.add_argument("--single-day-hard-negative-weight", type=float, default=5.0)
    parser.add_argument("--single-day-hard-negative-margin", type=float, default=0.5)
    parser.add_argument("--bias-l2-weight", type=float, default=0.02)
    parser.add_argument("--candidate-distribution-weight", type=float, default=1.0)
    parser.add_argument("--candidate-distribution-slack", type=float, default=0.0)
    parser.add_argument(
        "--candidate-distribution-temperature", type=float, default=0.12
    )
    parser.add_argument("--sample-residual-l2-weight", type=float, default=0.01)
    parser.add_argument(
        "--supervised-single-day-hard-negative-weight", type=float, default=10.0
    )
    parser.add_argument("--rare-class-weight-cap", type=float, default=3.0)
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument("--minimum-overlay-js-improvement", type=float, default=1e-4)
    parser.add_argument("--minimum-overlay-rate-improvement", type=float, default=0.0)
    parser.add_argument("--maximum-body-rate-regression", type=float, default=0.01)
    parser.add_argument("--maximum-candidate-score-delta", type=float, default=0.35)
    parser.add_argument("--seed", type=int, default=20260820)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    _add_shared_arguments(preflight_parser)
    train_parser = commands.add_parser("train")
    _add_shared_arguments(train_parser)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    train_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    evaluate_parser = commands.add_parser("evaluate")
    evaluate_parser.add_argument("--output-dir", type=Path, required=True)
    evaluate_parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    evaluate_parser.add_argument("--batch-size", type=int, default=512)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "preflight":
        result = preflight(args)
    elif args.command == "train":
        result = train(args)
    elif args.command == "evaluate":
        result = evaluate(args)
    elif args.command == "validate":
        result = validate_output(args.output_dir)
    else:  # pragma: no cover - argparse owns command choices
        raise PageConsistencyTrainingError(f"unsupported command: {args.command}")
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
