#!/usr/bin/env python3
"""Run the isolated R2.2 concat-feature work-LOGO diagnostic pilot.

R2.2 is a single-cell, single-seed, nonpromotable diagnostic.  It concatenates
the frozen shared 64-dimensional candidate hidden and frozen 1024-dimensional
``family_norm`` activation, then trains an exact-zero ``Linear(1088, 1)``
family-margin sidecar.  The ten-fold work-LOGO training, epoch selection, source
validation, and strict CPU metric recomputation are inherited from one exact,
immutable R2.1 v2 engine.  The exact R2.1 shared64/plain-CE/seed-20260820
artifact is opened read-only as a comparison control and never initializes the
head or enters gradients, fold selection, or labels.

This pilot performs no page optimization/rendering, opens no development work,
and has no production/export/application authority.  Its continuation gate is
separate from, and does not relax, the existing absolute +0.02 diagnostic-worth
gate.  A fused single-thread full-runtime benchmark remains mandatory before
any production consideration.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import threading
from collections.abc import Iterator, Mapping, Sequence
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

SCHEMA_VERSION = "manga-font-v3-family-residual-r22-concat-logo-v1"
OWNER = "carrot-manga-translator/manga-font-v3-family-residual-r22-concat-logo-v1"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-family-residual-r22-concat-logo-v1-owned.json"
PRODUCER_FILE_NAME = "train_manga_font_v3_family_residual_r22_concat_logo.py"
SIDECAR_TEMPLATE = "fold-{fold_index:02d}-family-margin-r22-concat.safetensors"
FOLD_COUNT = 10

FEATURE_SOURCE = "concat_shared_hidden64_family_norm1024"
DIRECT_OBJECTIVE = "work_family_ce"
SEED = 20260820
FEATURE_DIMENSION = 1088
SHARED_FEATURE_DIMENSION = 64
FAMILY_FEATURE_DIMENSION = 1024
CONTINUATION_JOINT_MINIMUM_IMPROVEMENT = 0.005

R21_ENGINE_FILE_NAME = "train_manga_font_v3_family_residual_r21_logo.py"
R21_ENGINE_BYTE_SIZE = 113_083
R21_ENGINE_SHA256 = "deca641485fa0d655b370b99151ea9524f74715195fff84a1b239ef38068d268"

CONTROL_RELATIVE_DIRECTORY = (
    "artifacts/manga-font-v3-family-residual-r21-logo-"
    "shared_hidden64-work_family_ce-seed20260820-v2"
)
CONTROL_SCHEMA_VERSION = "manga-font-v3-family-residual-r21-logo-v2"
CONTROL_MANIFEST_BYTE_SIZE = 6_703_754
CONTROL_MANIFEST_SHA256 = (
    "af04656075ed2399e3564eb8c4c5049404d9b59966b61f175349b43c7f7e5f23"
)
CONTROL_RECORD_SHA256 = (
    "ebb94d2a514e16bd1ee2cbfc885309f7483df82f4a872a08618911e27385f090"
)
CONTROL_MARKER_FILE = ".manga-font-v3-family-residual-r21-logo-v2-owned.json"
CONTROL_MARKER_BYTE_SIZE = 1_695
CONTROL_MARKER_SHA256 = (
    "400ba5749782610913d2d8c24a6596df0832f91d6c5553a4b138c38b32753d1e"
)
CONTROL_SIDECAR_SHA256 = (
    "e9389e51df910b29207d45064cd2f030fab64afb66f3c08c8314a1d393f72049"
)
CONTROL_SIDECAR_BYTE_SIZE = 428
CONTROL_PRODUCER = {
    "byte_size": R21_ENGINE_BYTE_SIZE,
    "file_name": R21_ENGINE_FILE_NAME,
    "sha256": R21_ENGINE_SHA256,
}
CONTROL_OOF_DELTA = {
    "balanced_accuracy": 0.0,
    "body_accuracy": 0.0,
    "variant_accuracy": 0.0,
}

PRECOMMITTED_CONFIGURATION = dict(r21.PRECOMMITTED_CONFIGURATION)
EXPECTED_AUTHORITY = {
    **r21.EXPECTED_AUTHORITY,
    "comparison_control_authority": "read_only_exact_r21_v2_diagnostic",
    "pilot_continuation_authority": "training_only_nonpromotable",
}
EXPECTED_RUNTIME_BOUNDARY = {
    **r21.EXPECTED_RUNTIME_BOUNDARY,
    "training_contract": "r22_concat_ten_fold_logo_one_direct_one_base",
}

_REPO_ROOT = Path(__file__).expanduser().absolute().parent.parent
_CONTROL_DIR = _REPO_ROOT / CONTROL_RELATIVE_DIRECTORY
_ENGINE_LOCK = threading.RLock()
_ENGINE_ACTIVE = False

_NATIVE_GLOBALS = {
    name: getattr(r21, name)
    for name in (
        "DIRECT_OBJECTIVES",
        "EXPECTED_AUTHORITY",
        "EXPECTED_RUNTIME_BOUNDARY",
        "FEATURE_SOURCES",
        "FINAL_SEEDS",
        "INITIAL_SEEDS",
        "MARKER_FILE",
        "OWNER",
        "PRODUCER_FILE_NAME",
        "SCHEMA_VERSION",
        "SIDECAR_TEMPLATE",
        "_aggregate_logo_metrics",
        "_architecture_contract",
        "_build_feature_cache",
        "_configuration",
        "_experiment_contract",
        "_feature_dimension",
        "_feature_from_queries",
        "_producer_binding",
        "_validate_options",
    )
}
_NATIVE_AGGREGATE = r21._aggregate_logo_metrics
_NATIVE_VALIDATE_OUTPUT = r21.validate_output


class R22TrainingError(r21.R21TrainingError):
    """Raised when the sealed R2.2 pilot contract is violated."""


def canonical_json(value: Any) -> str:
    return r21.canonical_json(value)


def sha256_file(path: Path) -> str:
    return r21.sha256_file(path)


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R22TrainingError(f"{location}: expected object")
    return value


def _descriptor(path: Path, *, expected_name: str) -> Mapping[str, Any]:
    expanded = path.expanduser().absolute()
    if (
        expanded.name != expected_name
        or r0.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded)
    ):
        raise R22TrainingError(f"{expected_name}: path is linked, reparsed, or renamed")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise R22TrainingError(f"{expected_name}: file is missing")
    return {
        "byte_size": int(resolved.stat().st_size),
        "file_name": expected_name,
        "sha256": sha256_file(resolved),
    }


def _assert_frozen_engine() -> Mapping[str, Any]:
    descriptor = _descriptor(Path(r21.__file__), expected_name=R21_ENGINE_FILE_NAME)
    if descriptor != CONTROL_PRODUCER:
        raise R22TrainingError("frozen R2.1 engine bytes drifted")
    return descriptor


def _producer_binding() -> Mapping[str, Any]:
    return {
        "frozen_r21_engine": _assert_frozen_engine(),
        "r22_producer": _descriptor(Path(__file__), expected_name=PRODUCER_FILE_NAME),
    }


def _expected_control_inventory() -> Mapping[str, Mapping[str, Any]]:
    inventory: dict[str, Mapping[str, Any]] = {
        CONTROL_MARKER_FILE: {
            "byte_size": CONTROL_MARKER_BYTE_SIZE,
            "sha256": CONTROL_MARKER_SHA256,
        },
        MANIFEST_FILE: {
            "byte_size": CONTROL_MANIFEST_BYTE_SIZE,
            "sha256": CONTROL_MANIFEST_SHA256,
        },
    }
    for fold_index in range(FOLD_COUNT):
        inventory[f"fold-{fold_index:02d}-family-margin-r21.safetensors"] = {
            "byte_size": CONTROL_SIDECAR_BYTE_SIZE,
            "sha256": CONTROL_SIDECAR_SHA256,
        }
    return dict(sorted(inventory.items()))


def _control_artifact_contract() -> Mapping[str, Any]:
    return {
        "artifact_role": "read_only_comparison_control_never_model_initialization_or_gradient",
        "directory_relative_to_repository": CONTROL_RELATIVE_DIRECTORY,
        "file_inventory": _expected_control_inventory(),
        "manifest_record_sha256": CONTROL_RECORD_SHA256,
        "manifest_sha256": CONTROL_MANIFEST_SHA256,
        "oof_heldout_work_macro_delta": dict(CONTROL_OOF_DELTA),
        "producer": dict(CONTROL_PRODUCER),
        "schema_version": CONTROL_SCHEMA_VERSION,
        "strict_native_r21_validation_required": True,
    }


def _load_control_contract() -> Mapping[str, Any]:
    # Fail closed on both producer paths before following the fixed control path.
    _producer_binding()
    expanded = _CONTROL_DIR.expanduser().absolute()
    if r0.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R22TrainingError("R2.1 control path is linked or reparsed")
    root = expanded.resolve()
    if not root.is_dir() or r0.overlay_v3._contains_link_or_reparse(root):
        raise R22TrainingError("R2.1 control directory is invalid")
    expected_inventory = _expected_control_inventory()
    if {path.name for path in root.iterdir()} != set(expected_inventory):
        raise R22TrainingError("R2.1 control file inventory drifted")
    for name, expected in expected_inventory.items():
        path = root / name
        actual = {"byte_size": int(path.stat().st_size), "sha256": sha256_file(path)}
        if actual != expected:
            raise R22TrainingError(f"R2.1 control physical file drifted: {name}")
    try:
        validation = _NATIVE_VALIDATE_OUTPUT(root)
    except r21.R21TrainingError as error:
        raise R22TrainingError(
            f"R2.1 control strict validation failed: {error}"
        ) from error
    manifest_path = root / MANIFEST_FILE
    try:
        manifest_bytes = manifest_path.read_bytes()
        if (
            len(manifest_bytes) != CONTROL_MANIFEST_BYTE_SIZE
            or hashlib.sha256(manifest_bytes).hexdigest() != CONTROL_MANIFEST_SHA256
        ):
            raise R22TrainingError("R2.1 control manifest bytes drifted")
        manifest_value = json.loads(manifest_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise R22TrainingError("R2.1 control manifest is unreadable") from error
    manifest = _mapping(manifest_value, "R2.1 control manifest")
    configuration = _mapping(
        manifest.get("configuration"), "R2.1 control configuration"
    )
    aggregate = _mapping(manifest.get("logo_aggregate"), "R2.1 control aggregate")
    if (
        manifest.get("schema_version") != CONTROL_SCHEMA_VERSION
        or manifest.get("record_sha256") != CONTROL_RECORD_SHA256
        or manifest.get("producer") != CONTROL_PRODUCER
        or configuration.get("feature_source") != "shared_hidden64"
        or configuration.get("direct_objective") != DIRECT_OBJECTIVE
        or configuration.get("seed") != SEED
        or aggregate.get("heldout_work_macro_delta") != CONTROL_OOF_DELTA
        or aggregate.get("passed") is not False
        or validation.get("manifest_sha256") != CONTROL_MANIFEST_SHA256
        or validation.get("manifest_record_sha256") != CONTROL_RECORD_SHA256
        or validation.get("producer") != CONTROL_PRODUCER
    ):
        raise R22TrainingError("R2.1 comparison control binding drifted")
    return _control_artifact_contract()


def _feature_dimension(feature_source: str) -> int:
    if feature_source == FEATURE_SOURCE:
        return FEATURE_DIMENSION
    # ``frozen_family_norm`` checks its native activation name internally.
    if feature_source == "shared_hidden64":
        return SHARED_FEATURE_DIMENSION
    if feature_source == "family_norm1024":
        return FAMILY_FEATURE_DIMENSION
    raise R22TrainingError("R2.2 feature source drifted")


def _feature_from_queries(
    torch: Any, anchor_model: Any, query_views: Any, feature_source: str
) -> Any:
    if feature_source != FEATURE_SOURCE:
        raise R22TrainingError("R2.2 feature source drifted")
    shared = r0.frozen_shared_hidden(torch, anchor_model, query_views)
    family = r21.frozen_family_norm(torch, anchor_model, query_views)
    if shared.ndim != 2 or family.ndim != 2 or shared.shape[0] != family.shape[0]:
        raise R22TrainingError("R2.2 frozen feature shapes drifted")
    feature = torch.cat((shared, family), dim=1)
    if feature.shape[1] != FEATURE_DIMENSION:
        raise R22TrainingError("R2.2 concat feature dimension drifted")
    return feature


def _build_feature_cache(
    torch: Any,
    *,
    context: Mapping[str, Any],
    device: Any,
    batch_size: int,
    feature_source: str,
) -> Mapping[str, Any]:
    if feature_source != FEATURE_SOURCE:
        raise R22TrainingError("R2.2 feature source drifted")
    base_cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=device,
        batch_size=batch_size,
    )
    shared = base_cache["hidden"]
    if shared.ndim != 2 or shared.shape[1] != SHARED_FEATURE_DIMENSION:
        raise R22TrainingError("R2.2 shared hidden cache drifted")
    arrays = context["arrays"]
    anchor_model = context["model"].to(device)
    family_parts: list[Any] = []
    with torch.inference_mode():
        for start in range(0, len(arrays["query_views"]), int(batch_size)):
            query_views = torch.from_numpy(
                arrays["query_views"][start : start + int(batch_size)].astype(
                    np.float32, copy=False
                )
            ).to(device)
            family_parts.append(
                r21.frozen_family_norm(torch, anchor_model, query_views).detach()
            )
    family = torch.cat(family_parts, dim=0)
    if tuple(family.shape) != (len(arrays["query_views"]), FAMILY_FEATURE_DIMENSION):
        raise R22TrainingError("R2.2 family_norm cache drifted")
    with torch.inference_mode():
        replayed_family_logits = anchor_model.family_head(family)
    if not torch.equal(replayed_family_logits, base_cache["family_logits"]):
        raise R22TrainingError("R2.2 family_norm replay is not bit-exact family logits")
    feature = torch.cat((shared, family), dim=1)
    if tuple(feature.shape) != (len(arrays["query_views"]), FEATURE_DIMENSION):
        raise R22TrainingError("R2.2 concat cache inventory drifted")
    return {**base_cache, "hidden": feature}


def _validate_options(args: argparse.Namespace) -> None:
    try:
        r0._validate_options(args)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R22TrainingError(str(error)) from error
    if args.feature_source != FEATURE_SOURCE:
        raise R22TrainingError("R2.2 requires the precommitted concat feature")
    if args.direct_objective != DIRECT_OBJECTIVE:
        raise R22TrainingError("R2.2 requires plain work-family CE")
    if getattr(args, "device", None) not in {"cpu", "cuda"}:
        raise R22TrainingError("device must be cpu or cuda")
    if args.base_supervision_mode != "non_direct_preservation":
        raise R22TrainingError("R2.2 requires non_direct_preservation")
    if args.direct_balance_mode != "work_family":
        raise R22TrainingError("R2.2 requires work_family balancing")
    if args.anchor_kl_scope != "base_only":
        raise R22TrainingError("R2.2 requires base_only anchor KL")
    if (
        isinstance(args.seed, bool)
        or not isinstance(args.seed, int)
        or args.seed != SEED
    ):
        raise R22TrainingError("R2.2 permits only schedule seed 20260820")
    for name, expected in PRECOMMITTED_CONFIGURATION.items():
        actual = getattr(args, name)
        if isinstance(expected, int):
            if (
                isinstance(actual, bool)
                or not isinstance(actual, int)
                or actual != expected
            ):
                raise R22TrainingError(f"R2.2 precommitted option drifted: {name}")
        elif (
            isinstance(actual, bool)
            or not isinstance(actual, (int, float))
            or not math.isfinite(float(actual))
            or float(actual) != float(expected)
        ):
            raise R22TrainingError(f"R2.2 precommitted option drifted: {name}")
    expected_cell = f"r22-{FEATURE_SOURCE}-{DIRECT_OBJECTIVE}-seed{SEED}"
    if hasattr(args, "experiment_cell_id") and args.experiment_cell_id != expected_cell:
        raise R22TrainingError("R2.2 experiment cell ID drifted")


def _configuration(args: argparse.Namespace) -> Mapping[str, Any]:
    return {
        "anchor_kl_scope": "base_only",
        "anchor_kl_weight": float(args.anchor_kl_weight),
        "base_family_ce_weight": float(args.base_family_ce_weight),
        "base_supervision_mode": "non_direct_preservation",
        "batch_size": int(args.batch_size),
        "device": str(args.device),
        "direct_balance_mode": "work_family",
        "direct_family_ce_weight": float(args.direct_family_ce_weight),
        "direct_objective": DIRECT_OBJECTIVE,
        "epochs": int(args.epochs),
        "evaluation_batch_size": int(args.evaluation_batch_size),
        "experiment_cell_id": f"r22-{FEATURE_SOURCE}-{DIRECT_OBJECTIVE}-seed{SEED}",
        "feature_source": FEATURE_SOURCE,
        "gradient_clip": float(args.gradient_clip),
        "learning_rate": float(args.learning_rate),
        "maximum_acceptable_regression": float(args.maximum_acceptable_regression),
        "maximum_family_regression": float(args.maximum_family_regression),
        "maximum_margin": float(args.maximum_margin),
        "maximum_preferred_regression": float(args.maximum_preferred_regression),
        "minimum_diagnostic_work_macro_improvement": float(
            args.minimum_diagnostic_work_macro_improvement
        ),
        "page_body_ce_weight": 0.0,
        "residual_l2_weight": float(args.residual_l2_weight),
        "seed": SEED,
        "weight_decay": float(args.weight_decay),
    }


def _architecture_contract(
    model: Any, *, feature_source: str, maximum_margin: float
) -> Mapping[str, Any]:
    if feature_source != FEATURE_SOURCE or float(maximum_margin) != 1.0:
        raise R22TrainingError("R2.2 architecture options drifted")
    initial = r21._initial_state_contract(model, feature_source)
    production_parameters = 74_528
    production_macs = 91_776
    trainable_parameters = FEATURE_DIMENSION + 1
    return {
        "anchor_tensor_count": r0.EXPECTED_ANCHOR_TENSOR_COUNT,
        "concat_order": ["shared_hidden64", "family_norm1024"],
        "cpu_benchmark_completed": False,
        "cpu_single_thread_full_runtime_relative_budget": 1.5,
        "cpu_single_thread_full_runtime_benchmark_required_before_promotion": True,
        "diagnostic_cache_may_compute_features_separately": True,
        "family_logit_adjustment": "+margin/2 body, -margin/2 variant",
        "family_margin_formula": "B*tanh(raw_margin/B)",
        "feature_dimension": FEATURE_DIMENSION,
        "feature_source": FEATURE_SOURCE,
        "feature_source_formula": (
            "concat(frozen_sample_candidate_norm_then_Linear1024x64_then_GELU,"
            "mean_views_then_per_query_l2_normalize_then_flatten_then_frozen_family_norm)"
        ),
        "fused_feature_reuse_required_for_any_runtime_candidate": True,
        "head_formula": "Linear1088x1_exact_zero",
        "initial_state": initial,
        "maximum_margin": 1.0,
        "reuse_existing_runtime_features_required": True,
        "sidecar_parameter_count": trainable_parameters,
        "sidecar_tensor_count": 2,
        "static_reuse_estimate_not_runtime_benchmark": {
            "additional_multiply_accumulates_per_row": FEATURE_DIMENSION,
            "additional_parameters": trainable_parameters,
            "baseline_multiply_accumulates_per_row": production_macs,
            "baseline_parameters": production_parameters,
            "estimated_multiply_accumulate_ratio": float(
                (production_macs + FEATURE_DIMENSION) / production_macs
            ),
            "estimated_parameter_ratio": float(
                (production_parameters + trainable_parameters) / production_parameters
            ),
            "within_static_1_5x_parameter_and_mac_budget": bool(
                production_parameters + trainable_parameters <= 111_792
                and production_macs + FEATURE_DIMENSION <= 137_664
            ),
        },
        "zero_output_initialization_exact_anchor": True,
    }


def _experiment_contract(control_contract: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        "application_integration_allowed": False,
        "comparison_control": dict(control_contract),
        "cpu_benchmark": {
            "budget_relative_to_current_full_font_runtime": 1.5,
            "completed": False,
            "fused_onnx_runtime_required": True,
            "required_before_any_promotion": True,
            "scope": "single_thread_full_font_runtime_not_sidecar_only",
        },
        "development_diagnostics": {
            "consulted": False,
            "gradient_rows": 0,
            "opened_by_pilot": False,
            "three_development_works_remain_sealed": True,
        },
        "engine_compatibility": {
            "concurrent_native_r21_use_inside_same_process_forbidden": True,
            "frozen_engine": dict(CONTROL_PRODUCER),
            "internal_manifest_record_type_remains_r21_engine_compatibility_only": True,
            "reuse_mode": "exclusive_scoped_module_global_override_restored_in_finally",
            "r22_schema_and_marker_are_mutually_rejected_by_r21": True,
            "standalone_cli_process_required": True,
        },
        "logo_scope_limitation": (
            "residual_supervision_logo_only_frozen_r3h_anchor_was_pretrained_on_base_npz_and_is_not_work_unseen"
        ),
        "page_optimizer_calls": 0,
        "page_render_or_replay_performed": False,
        "pilot_cell": {
            "direct_objective": DIRECT_OBJECTIVE,
            "feature_source": FEATURE_SOURCE,
            "seed": SEED,
        },
        "pilot_continuation_rule": {
            "absolute_plus_0_02_diagnostic_worth_gate_is_unchanged": True,
            "control_joint_minimum": 0.0,
            "candidate_joint_formula": "min(oof_work_macro_balanced_delta,oof_work_macro_body_delta)",
            "minimum_joint_improvement_over_exact_control": (
                CONTINUATION_JOINT_MINIMUM_IMPROVEMENT
            ),
            "requires_all_existing_non_improvement_safety_checks": True,
            "stop_if_failed": (
                "no_more_seeds_widths_development_pages_or_production_work"
            ),
        },
        "promotion_authority": False,
        "seed_contract": {
            "allowed_schedule_seeds": [SEED],
            "head_initialization_seed": None,
            "seed_changes_only_schedule_and_float_accumulation_order": True,
            "seed_does_not_change_exact_zero_head_initialization": True,
        },
        "trajectory_authenticity_keyed": False,
        "trajectory_phase_transcript_authority": "sealed_producer_attestation_only",
        "trajectory_replayed_by_strict_validator": False,
        "work_logo": {
            "fold_count": FOLD_COUNT,
            "fold_epoch_selection_uses_heldout": False,
            "heldout_excluded_from_all_new_gradients_and_training_side_metrics": True,
            "heldout_metrics_are_post_selection_only": True,
            "not_end_to_end_new_work_generalization_authority": True,
        },
    }


def _metric_at_least(value: float, threshold: float) -> bool:
    return float(value) + float(r21.METRIC_GATE_ABSOLUTE_TOLERANCE) >= float(threshold)


def _aggregate_logo_metrics(
    fold_reports: Sequence[Mapping[str, Any]],
    *,
    control_contract: Mapping[str, Any],
) -> Mapping[str, Any]:
    aggregate = dict(_NATIVE_AGGREGATE(fold_reports))
    control_delta = _mapping(
        control_contract["oof_heldout_work_macro_delta"], "control OOF delta"
    )
    candidate_delta = _mapping(
        aggregate["heldout_work_macro_delta"], "candidate OOF delta"
    )
    control_joint = min(
        float(control_delta["balanced_accuracy"]), float(control_delta["body_accuracy"])
    )
    candidate_joint = min(
        float(candidate_delta["balanced_accuracy"]),
        float(candidate_delta["body_accuracy"]),
    )
    improvement = float(candidate_joint - control_joint)
    checks = _mapping(aggregate["checks"], "native aggregate checks")
    non_improvement_safety_names = (
        "all_fold_base_and_page_and_candidate_checks_passed",
        "all_fold_variant_deltas_at_least_negative_0_005",
        "worst_heldout_work_balanced_accuracy_delta_at_least_negative_0_05",
    )
    safety = {name: bool(checks[name]) for name in non_improvement_safety_names}
    continuation_checks = {
        **safety,
        "joint_minimum_improved_over_control_by_0_005": _metric_at_least(
            improvement, CONTINUATION_JOINT_MINIMUM_IMPROVEMENT
        ),
    }
    aggregate["pilot_continuation"] = {
        "absolute_plus_0_02_diagnostic_worth_gate_passed": bool(aggregate["passed"]),
        "absolute_plus_0_02_diagnostic_worth_gate_remains_authoritative": True,
        "candidate_joint_minimum": candidate_joint,
        "checks": continuation_checks,
        "control_joint_minimum": control_joint,
        "control_manifest_record_sha256": CONTROL_RECORD_SHA256,
        "joint_minimum_improvement_over_control": improvement,
        "minimum_required_improvement": CONTINUATION_JOINT_MINIMUM_IMPROVEMENT,
        "passed": bool(all(continuation_checks.values())),
        "promotion_authority": False,
    }
    return aggregate


@contextlib.contextmanager
def _r22_engine_context(
    control_contract: Mapping[str, Any],
) -> Iterator[None]:
    global _ENGINE_ACTIVE
    with _ENGINE_LOCK:
        if _ENGINE_ACTIVE:
            raise R22TrainingError("R2.2 engine context is not reentrant")
        _assert_frozen_engine()
        patches: Mapping[str, Any] = {
            "DIRECT_OBJECTIVES": (DIRECT_OBJECTIVE,),
            "EXPECTED_AUTHORITY": EXPECTED_AUTHORITY,
            "EXPECTED_RUNTIME_BOUNDARY": EXPECTED_RUNTIME_BOUNDARY,
            "FEATURE_SOURCES": (FEATURE_SOURCE,),
            "FINAL_SEEDS": (SEED,),
            "INITIAL_SEEDS": (SEED,),
            "MARKER_FILE": MARKER_FILE,
            "OWNER": OWNER,
            "PRODUCER_FILE_NAME": PRODUCER_FILE_NAME,
            "SCHEMA_VERSION": SCHEMA_VERSION,
            "SIDECAR_TEMPLATE": SIDECAR_TEMPLATE,
            "_aggregate_logo_metrics": lambda reports: _aggregate_logo_metrics(
                reports, control_contract=control_contract
            ),
            "_architecture_contract": _architecture_contract,
            "_build_feature_cache": _build_feature_cache,
            "_configuration": _configuration,
            "_experiment_contract": lambda: _experiment_contract(control_contract),
            "_feature_dimension": _feature_dimension,
            "_feature_from_queries": _feature_from_queries,
            "_producer_binding": _producer_binding,
            "_validate_options": _validate_options,
        }
        originals = {name: getattr(r21, name) for name in patches}
        _ENGINE_ACTIVE = True
        try:
            for name, value in patches.items():
                setattr(r21, name, value)
            yield
        finally:
            for name, value in originals.items():
                setattr(r21, name, value)
            _ENGINE_ACTIVE = False


def _normalize_result(
    result: Mapping[str, Any], *, control: Mapping[str, Any], operation: str
) -> Mapping[str, Any]:
    normalized = dict(result)
    normalized["comparison_control"] = dict(control)
    normalized["nonpromotable"] = True
    normalized["operation"] = operation
    normalized["schema_version"] = SCHEMA_VERSION
    normalized["status"] = f"{operation}_nonpromotable_r22_concat_logo_pilot"
    if operation in {"validate", "evaluate", "train"}:
        output_dir = Path(str(normalized["output_dir"]))
        manifest_bytes = (output_dir / MANIFEST_FILE).read_bytes()
        if hashlib.sha256(manifest_bytes).hexdigest() != normalized.get(
            "manifest_sha256"
        ):
            raise R22TrainingError("validated result manifest bytes changed")
        try:
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise R22TrainingError("validated result manifest is unreadable") from error
        r21._validate_record_seal(manifest, "validated result manifest")
        if manifest.get("schema_version") != SCHEMA_VERSION:
            raise R22TrainingError("validated result manifest schema drifted")
        continuation = manifest["logo_aggregate"]["pilot_continuation"]
        normalized["logo_diagnostic_worth"] = bool(manifest["logo_aggregate"]["passed"])
        normalized["pilot_continuation_worth"] = bool(continuation["passed"])
    return normalized


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    control = _load_control_contract()
    try:
        with _r22_engine_context(control):
            result = r21.preflight(args)
    except r21.R21TrainingError as error:
        if isinstance(error, R22TrainingError):
            raise
        raise R22TrainingError(str(error)) from error
    return _normalize_result(result, control=control, operation="preflight")


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    control = _load_control_contract()
    try:
        with _r22_engine_context(control):
            result = r21.train(args)
    except r21.R21TrainingError as error:
        if isinstance(error, R22TrainingError):
            raise
        raise R22TrainingError(str(error)) from error
    return _normalize_result(result, control=control, operation="train")


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    control = _load_control_contract()
    try:
        with _r22_engine_context(control):
            result = _NATIVE_VALIDATE_OUTPUT(output_dir)
    except r21.R21TrainingError as error:
        if isinstance(error, R22TrainingError):
            raise
        raise R22TrainingError(str(error)) from error
    return _normalize_result(result, control=control, operation="validate")


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    result = validate_output(args.output_dir)
    return {
        **result,
        "development_evaluation_opened": False,
        "evaluation_authority": False,
        "operation": "evaluate",
        "status": "evaluate_nonpromotable_r22_concat_logo_pilot",
        "note": (
            "strict CPU source/state/metric recomputation; optimizer trajectory is producer-attested, "
            "the frozen anchor is not work-unseen, the R2.1 control is comparison-only, and "
            "development works remain sealed"
        ),
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
    parser.add_argument(
        "--feature-source", choices=(FEATURE_SOURCE,), default=FEATURE_SOURCE
    )
    parser.add_argument(
        "--direct-objective", choices=(DIRECT_OBJECTIVE,), default=DIRECT_OBJECTIVE
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
    parser.add_argument("--maximum-margin", type=float, default=1.0)
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument(
        "--minimum-diagnostic-work-macro-improvement", type=float, default=0.02
    )
    parser.add_argument("--seed", type=int, choices=(SEED,), default=SEED)
    parser.add_argument(
        "--base-supervision-mode",
        choices=("non_direct_preservation",),
        default="non_direct_preservation",
    )
    parser.add_argument(
        "--direct-balance-mode", choices=("work_family",), default="work_family"
    )
    parser.add_argument(
        "--anchor-kl-scope", choices=("base_only",), default="base_only"
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
        else:  # pragma: no cover - argparse owns enum
            parser.error("unsupported command")
    except (R22TrainingError, r21.R21TrainingError) as error:
        parser.error(str(error))
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
