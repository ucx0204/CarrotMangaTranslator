#!/usr/bin/env python3
"""Train a runtime-neutral page-consistency candidate-head diagnostic.

R2.4 keeps the exact R2.3 marginal-weak-negative candidate objective and adds
losses derived only from the already sealed, reviewed same-page dialogue
groups.  It never opens new pages or labels.  Only the existing production
candidate final projection is trained, so runtime parameter and MAC counts are
unchanged.  The exact R2.3 weak-negative artifact is a read-only comparison
control.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import json
import math
import threading
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
except ImportError:  # pragma: no cover - direct script execution
    import train_manga_font_v3_candidate_tristate_r23_logo as r23


SCHEMA_VERSION = "manga-font-v3-candidate-page-consistency-r24-logo-v1"
OWNER = "carrot-manga-translator/manga-font-v3-candidate-page-consistency-r24-logo-v1"
RECORD_TYPE = "manga_font_v3_candidate_page_consistency_r24_logo_manifest"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-candidate-page-consistency-r24-logo-v1-owned.json"
PRODUCER_FILE_NAME = "train_manga_font_v3_candidate_page_consistency_r24_logo.py"
SIDECAR_TEMPLATE = "fold-{fold_index:02d}-candidate-final-r24.safetensors"

R23_ENGINE_FILE_NAME = "train_manga_font_v3_candidate_tristate_r23_logo.py"
R23_ENGINE_BYTE_SIZE = 149_967
R23_ENGINE_SHA256 = "cdf41457975b93ac0ddb54d24b022b163a38ad3af4d07e5cf5e8806fcc713166"

CONTROL_RELATIVE_DIRECTORY = (
    "artifacts/manga-font-v3-candidate-tristate-r23-logo-"
    "marginal-weak-negative-0-25-seed20260820-v1"
)
CONTROL_MANIFEST_SHA256 = (
    "9799da2eaedfbe9babf88f417714e212afeb34ee4dd190299273b895dc54e772"
)
CONTROL_RECORD_SHA256 = (
    "47b0d9840ee34ed9e41c146987836f2435b339d7a89e9f58c220de68f064f6e6"
)
CONTROL_MODE = "marginal_weak_negative_0_25"

# Small-to-moderate page loss grid.  Candidate supervision, optimizer, base
# preservation, work folds, seed, and epoch budget remain identical.
PAGE_CELLS: Mapping[str, tuple[float, float]] = {
    "page_js0_02_mass0_05": (0.02, 0.05),
    "page_js0_05_mass0_10": (0.05, 0.10),
    "page_js0_10_mass0_20": (0.10, 0.20),
}
MARGINAL_MODES = {name: 0.25 for name in PAGE_CELLS}
SELECTION_KEY_ORDER = (
    "eligible_epoch0_or_positive_candidate_joint_with_all_safety",
    "training_page_best_discrete_improvement",
    "training_page_common_positive_top1_delta",
    "training_page_top1_all_agree_delta",
    "training_candidate_joint_minimum_delta",
    "training_safe_top1_delta",
    "training_preferred_top1_delta",
    "negative_training_single_day_unsafe_top1_rate",
    "negative_training_unacceptable_top1_rate",
    "external_r3_base_validation_score",
    "negative_mean_absolute_final_head_delta",
    "earlier_epoch",
)

_REPO_ROOT = Path(__file__).expanduser().absolute().parent.parent
_CONTROL_DIR = _REPO_ROOT / CONTROL_RELATIVE_DIRECTORY
_ENGINE_LOCK = threading.RLock()
_ENGINE_ACTIVE = False
_ACTIVE_CONTROL_CONTRACT: Mapping[str, Any] | None = None

_NATIVE_VALIDATE_OUTPUT = r23.validate_output
_NATIVE_PRODUCER_BINDING = r23._producer_binding
_NATIVE_OBJECTIVE_CONTRACT = r23._objective_contract
_NATIVE_EXPERIMENT_CONTRACT = r23._experiment_contract
_NATIVE_FOLD_CONTRACT = r23._fold_contract
_NATIVE_PHASE_CONSUMPTION = r23._phase_consumption
_NATIVE_ZERO_CONSUMPTION = r23._zero_consumption
_NATIVE_TRAINING_DELTAS = r23._training_deltas
_NATIVE_HELDOUT_REPORT = r23._heldout_report
_NATIVE_AGGREGATE = r23._aggregate_logo_metrics

_PATCH_NAMES = (
    "MARGINAL_MODES",
    "MARKER_FILE",
    "OWNER",
    "PRODUCER_FILE_NAME",
    "RECORD_TYPE",
    "SCHEMA_VERSION",
    "SELECTION_KEY_ORDER",
    "SIDECAR_TEMPLATE",
    "_aggregate_logo_metrics",
    "_direct_step",
    "_experiment_contract",
    "_fold_contract",
    "_heldout_report",
    "_load_control_contract",
    "_objective_contract",
    "_phase_consumption",
    "_producer_binding",
    "_selection_key",
    "_training_deltas",
    "_validate_direct_loss",
    "_zero_consumption",
)


class R24TrainingError(r23.R23TrainingError):
    """Raised when the isolated R2.4 contract is violated."""


def _descriptor(path: Path, expected_name: str) -> Mapping[str, Any]:
    expanded = path.expanduser().absolute()
    if (
        expanded.name != expected_name
        or r23.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded)
    ):
        raise R24TrainingError(f"linked, reparsed, or renamed file: {expected_name}")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise R24TrainingError(f"required file is missing: {expected_name}")
    return {
        "byte_size": int(resolved.stat().st_size),
        "file_name": expected_name,
        "sha256": r23.sha256_file(resolved),
    }


def _assert_frozen_engine() -> Mapping[str, Any]:
    actual = _descriptor(Path(r23.__file__), R23_ENGINE_FILE_NAME)
    expected = {
        "byte_size": R23_ENGINE_BYTE_SIZE,
        "file_name": R23_ENGINE_FILE_NAME,
        "sha256": R23_ENGINE_SHA256,
    }
    if actual != expected:
        raise R24TrainingError("frozen R2.3 engine bytes drifted")
    return actual


def _producer_binding() -> Mapping[str, Any]:
    return {
        "frozen_r23_engine": _assert_frozen_engine(),
        "r24_producer": _descriptor(Path(__file__), PRODUCER_FILE_NAME),
    }


def _load_control_contract(control_dir: Path | None = None) -> Mapping[str, Any]:
    if _ENGINE_ACTIVE:
        if _ACTIVE_CONTROL_CONTRACT is None:
            raise R24TrainingError("R2.4 active control contract is missing")
        requested = _CONTROL_DIR if control_dir is None else control_dir
        if requested.expanduser().absolute().resolve() != _CONTROL_DIR.resolve():
            raise R24TrainingError("R2.4 active control path drifted")
        return copy.deepcopy(_ACTIVE_CONTROL_CONTRACT)
    _assert_frozen_engine()
    requested = _CONTROL_DIR if control_dir is None else control_dir
    expanded = requested.expanduser().absolute()
    if r23.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R24TrainingError("R2.3 control path is linked or reparsed")
    root = expanded.resolve()
    if root != _CONTROL_DIR.resolve():
        raise R24TrainingError("R2.4 requires the exact frozen R2.3 weak control")
    validation = _NATIVE_VALIDATE_OUTPUT(root)
    manifest_path = root / MANIFEST_FILE
    if r23.sha256_file(manifest_path) != CONTROL_MANIFEST_SHA256:
        raise R24TrainingError("R2.3 weak control manifest bytes drifted")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("record_sha256") != CONTROL_RECORD_SHA256
        or manifest.get("producer") != _NATIVE_PRODUCER_BINDING()
        or manifest.get("configuration", {}).get("marginal_mode") != CONTROL_MODE
        or validation.get("manifest_sha256") != CONTROL_MANIFEST_SHA256
    ):
        raise R24TrainingError("R2.3 weak control contract drifted")
    delta = manifest["logo_aggregate"]["heldout_work_macro_delta"]
    page_deltas = _page_macro_deltas(
        [fold["heldout_postselection"] for fold in manifest["folds"]]
    )
    return {
        "artifact_role": "read_only_exact_r23_weak_negative_comparison_control",
        "directory": str(root),
        "file_inventory": r23._output_inventory_descriptor(root),
        "manifest_record_sha256": CONTROL_RECORD_SHA256,
        "manifest_sha256": CONTROL_MANIFEST_SHA256,
        "oof_joint_minimum": min(
            float(delta["preferred_top1_accuracy"]),
            float(delta["safe_top1_accuracy"]),
        ),
        "oof_page_macro_delta": page_deltas,
        "producer": _NATIVE_PRODUCER_BINDING(),
        "schema_version": manifest["schema_version"],
    }


def _cell_weights(mode: str) -> tuple[float, float]:
    try:
        return PAGE_CELLS[mode]
    except KeyError as error:
        raise R24TrainingError("unsupported R2.4 page cell") from error


def _objective_contract(
    args: argparse.Namespace,
    ledger: Mapping[str, Any],
    folds: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    contract = copy.deepcopy(_NATIVE_OBJECTIVE_CONTRACT(args, ledger, folds))
    js_weight, mass_weight = _cell_weights(args.marginal_mode)
    contract["direct_candidate"]["base_candidate_objective"] = (
        "exact_r23_marginal_weak_negative_0_25"
    )
    contract["page"] = {
        "common_positive_mass_weight": mass_weight,
        "consistency_js_weight": js_weight,
        "discriminative_group_count": 68,
        "discriminative_row_count": 148,
        "gradient_integrated_into_direct_candidate_optimizer_call": True,
        "ordinary_unreviewed_fonts_excluded_from_support": True,
        "separate_page_optimizer_calls": 0,
        "shared_reviewed_eligible_support_only": True,
    }
    return contract


def _experiment_contract() -> Mapping[str, Any]:
    contract = copy.deepcopy(_NATIVE_EXPERIMENT_CONTRACT())
    contract["r24_scope"] = {
        "comparison_control": CONTROL_RELATIVE_DIRECTORY,
        "new_labels_or_pages_opened": False,
        "objective": "reviewed_same_page_candidate_consistency",
        "production_integration_allowed": False,
        "runtime_parameter_and_mac_ratio": 1.0,
    }
    return contract


def _fold_contract(**kwargs: Any) -> Mapping[str, Any]:
    contract = dict(_NATIVE_FOLD_CONTRACT(**kwargs))
    groups = tuple(kwargs["train_page_groups"])
    contract["page_gradient_group_count"] = len(groups)
    contract["page_gradient_integrated_in_direct_call"] = True
    contract["page_gradient_rows"] = sum(len(group["row_indices"]) for group in groups)
    return contract


def _zero_consumption() -> Mapping[str, Any]:
    result = dict(_NATIVE_ZERO_CONSUMPTION())
    result["page_gradient_integrated_in_direct_call"] = False
    return result


def _phase_consumption(
    fold: Mapping[str, Any],
    *,
    direct: Mapping[str, Any],
    base: Mapping[str, Any] | None = None,
) -> Mapping[str, Any]:
    result = dict(_NATIVE_PHASE_CONSUMPTION(fold, direct=direct, base=base))
    result["page_gradient_integrated_in_direct_call"] = True
    result["page_rows"] = sum(
        len(group["row_indices"]) for group in fold["train_page_groups"]
    )
    return result


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
    order, normalized_weights, schedule = r23._direct_schedule(fold, args, epoch=epoch)
    source_rows = tuple(fold["train_rows"])
    rows = tuple(source_rows[int(position)] for position in order.tolist())
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    outputs = r23.candidate_outputs_from_cache(torch, model, cache, indices)
    device = cache["hidden"].device
    tensors = r23._tier_tensors(torch, rows, device=device)
    row_weights = torch.as_tensor(
        normalized_weights, dtype=torch.float32, device=device
    )
    routed = r23._routed_scores(outputs, tensors["family_labels"])
    candidate_loss, parts = r23.weighted_candidate_set_loss(
        torch,
        routed,
        preferred_mask=tensors["preferred_mask"],
        safe_mask=tensors["safe_mask"],
        marginal_mask=tensors["marginal_mask"],
        unacceptable_mask=tensors["unacceptable_mask"],
        single_day_safety_negative=tensors["single_day_safety_negative"],
        marginal_weight=0.25,
        row_weights=row_weights,
    )
    safety = r23._single_day_safety_losses(
        torch,
        outputs,
        safe_mask=tensors["safe_mask"],
        family_labels=tensors["family_labels"],
        safety_negative=tensors["single_day_safety_negative"],
        row_weights=row_weights,
        single_day_index=tuple(cache["candidate_ids"]).index("single-day"),
    )
    page_batch = r23.r0.page_v3.make_overlay_batch(
        torch, fold["train_page_groups"], device=device
    )
    page_indices = page_batch["indices"].detach().cpu().numpy().astype(np.int64)
    page_outputs = r23.candidate_outputs_from_cache(torch, model, cache, page_indices)
    page = r23.r0.page_v3.page_consistency_losses(
        torch,
        page_outputs["body_candidate_scores"],
        family_logits=page_outputs["family_logits"],
        positive_mask=page_batch["positive_mask"],
        eligible_mask=page_batch["eligible_mask"],
        shared_reviewed_eligible_mask=page_batch["shared_reviewed_eligible_mask"],
        common_positive_mask=page_batch["common_positive_mask"],
        group_indices=page_batch["group_indices"],
        row_weights=page_batch["row_weights"],
    )
    residual_l2 = outputs["sample_candidate_residual_delta"].float().square().mean()
    js_weight, mass_weight = _cell_weights(args.marginal_mode)
    total = (
        float(args.direct_candidate_weight) * candidate_loss
        + r23.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT * safety["body_hard_negative"]
        + r23.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
        * safety["supervised_hard_negative"]
        + float(args.direct_residual_l2_weight) * residual_l2
        + js_weight * page["consistency_js"]
        + mass_weight * page["common_positive_mass"]
    )
    if not bool(torch.isfinite(total)):
        raise R24TrainingError("R2.4 direct/page loss became non-finite")
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
            "page_common_positive_mass": float(
                page["common_positive_mass"].detach().item()
            ),
            "page_consistency_js": float(page["consistency_js"].detach().item()),
            "page_group_count": int(page["group_count"]),
            "page_row_count": int(page["row_count"]),
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


def _validate_direct_loss(
    value: Any, args: argparse.Namespace, location: str
) -> Mapping[str, Any]:
    loss = r23._mapping(value, location)
    expected_names = {
        "candidate_core",
        "candidate_distribution_excess",
        "page_common_positive_mass",
        "page_consistency_js",
        "page_group_count",
        "page_row_count",
        "preferred_set_nll",
        "residual_delta_l2",
        "safe_set_nll",
        "single_day_body_hard_negative",
        "single_day_supervised_hard_negative",
        "total",
    }
    if set(loss) != expected_names:
        raise R24TrainingError(f"{location}: R2.4 direct loss inventory drifted")
    for name, number in loss.items():
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            raise R24TrainingError(f"{location}: nonnumeric direct loss")
        if not math.isfinite(float(number)) or float(number) < 0.0:
            raise R24TrainingError(f"{location}: invalid direct loss")
    if int(loss["page_group_count"]) <= 0 or int(loss["page_row_count"]) <= 0:
        raise R24TrainingError(f"{location}: empty page gradient inventory")
    core = r23.SAFE_WEIGHT * float(
        loss["safe_set_nll"]
    ) + r23.PREFERENCE_WEIGHT * float(loss["preferred_set_nll"])
    js_weight, mass_weight = _cell_weights(args.marginal_mode)
    total = (
        float(args.direct_candidate_weight) * float(loss["candidate_core"])
        + r23.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT
        * float(loss["single_day_body_hard_negative"])
        + r23.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
        * float(loss["single_day_supervised_hard_negative"])
        + float(args.direct_residual_l2_weight) * float(loss["residual_delta_l2"])
        + js_weight * float(loss["page_consistency_js"])
        + mass_weight * float(loss["page_common_positive_mass"])
    )
    if (
        float(loss["candidate_distribution_excess"]) != 0.0
        or not math.isclose(
            float(loss["candidate_core"]), core, rel_tol=1e-6, abs_tol=1e-7
        )
        or not math.isclose(float(loss["total"]), total, rel_tol=1e-6, abs_tol=1e-7)
    ):
        raise R24TrainingError(f"{location}: R2.4 direct loss algebra drifted")
    return loss


def _training_deltas(
    anchor: Mapping[str, Any], candidate: Mapping[str, Any]
) -> Mapping[str, float]:
    result = dict(_NATIVE_TRAINING_DELTAS(anchor, candidate))
    anchor_page = anchor["page_consistency"]
    candidate_page = candidate["page_consistency"]
    result.update(
        {
            "page_all_rows_top1_in_common_positive_rate": float(
                candidate_page["all_rows_top1_in_common_positive_rate"]
            )
            - float(anchor_page["all_rows_top1_in_common_positive_rate"]),
            "page_mean_common_positive_mass": float(
                candidate_page["mean_common_positive_mass"]
            )
            - float(anchor_page["mean_common_positive_mass"]),
            "page_mean_js_improvement": float(anchor_page["mean_js"])
            - float(candidate_page["mean_js"]),
            "page_top1_all_agree_rate": float(candidate_page["top1_all_agree_rate"])
            - float(anchor_page["top1_all_agree_rate"]),
        }
    )
    return result


def _selection_key(record: Mapping[str, Any]) -> tuple[float, ...]:
    epoch = int(record["epoch"])
    deltas = record["training_only_deltas"]
    candidate_joint = min(
        float(deltas["safe_top1_accuracy"]),
        float(deltas["preferred_top1_accuracy"]),
    )
    page_common = float(deltas["page_all_rows_top1_in_common_positive_rate"])
    page_agree = float(deltas["page_top1_all_agree_rate"])
    eligible = epoch == 0 or bool(
        record["diagnostic_gate_passed"] and candidate_joint > 0.0
    )
    candidate = record["training_only_metrics"]["candidate"]["work_macro"]
    return (
        float(eligible),
        max(page_common, page_agree),
        page_common,
        page_agree,
        candidate_joint,
        float(deltas["safe_top1_accuracy"]),
        float(deltas["preferred_top1_accuracy"]),
        -float(candidate["single_day_unsafe_top1_rate"]),
        -float(candidate["unacceptable_top1_rate"]),
        float(r23.r0.page_v3._base_selection_score(record["base_metrics"])),
        -float(record["training_only_metrics"]["head_delta"]["mean_absolute"]),
        -float(epoch),
    )


def _heldout_report(**kwargs: Any) -> Mapping[str, Any]:
    report = dict(_NATIVE_HELDOUT_REPORT(**kwargs))
    anchor_page = kwargs["anchor"]["page_consistency"]
    candidate_page = kwargs["candidate"]["page_consistency"]
    report["page_deltas"] = {
        "all_rows_top1_in_common_positive_rate": float(
            candidate_page["all_rows_top1_in_common_positive_rate"]
        )
        - float(anchor_page["all_rows_top1_in_common_positive_rate"]),
        "mean_common_positive_mass": float(candidate_page["mean_common_positive_mass"])
        - float(anchor_page["mean_common_positive_mass"]),
        "mean_js_improvement": float(anchor_page["mean_js"])
        - float(candidate_page["mean_js"]),
        "top1_all_agree_rate": float(candidate_page["top1_all_agree_rate"])
        - float(anchor_page["top1_all_agree_rate"]),
    }
    return report


def _page_macro_deltas(reports: Sequence[Mapping[str, Any]]) -> Mapping[str, float]:
    keys = (
        "all_rows_top1_in_common_positive_rate",
        "mean_common_positive_mass",
        "mean_js_improvement",
        "top1_all_agree_rate",
    )
    values: dict[str, list[float]] = {key: [] for key in keys}
    for report in reports:
        if "page_deltas" in report:
            delta = report["page_deltas"]
        else:
            anchor = report["anchor"]["page_consistency"]
            candidate = report["candidate"]["page_consistency"]
            delta = {
                "all_rows_top1_in_common_positive_rate": float(
                    candidate["all_rows_top1_in_common_positive_rate"]
                )
                - float(anchor["all_rows_top1_in_common_positive_rate"]),
                "mean_common_positive_mass": float(
                    candidate["mean_common_positive_mass"]
                )
                - float(anchor["mean_common_positive_mass"]),
                "mean_js_improvement": float(anchor["mean_js"])
                - float(candidate["mean_js"]),
                "top1_all_agree_rate": float(candidate["top1_all_agree_rate"])
                - float(anchor["top1_all_agree_rate"]),
            }
        for key in keys:
            values[key].append(float(delta[key]))
    return {key: float(np.mean(value)) for key, value in values.items()}


def _aggregate_logo_metrics(
    reports: Sequence[Mapping[str, Any]],
    *,
    control_contract: Mapping[str, Any] | None,
) -> Mapping[str, Any]:
    if control_contract is None:
        raise R24TrainingError("R2.4 requires its exact R2.3 comparison control")
    aggregate = dict(_NATIVE_AGGREGATE(reports, control_contract=control_contract))
    page = _page_macro_deltas(reports)
    control_page = control_contract["oof_page_macro_delta"]
    candidate_joint = float(aggregate["joint_minimum_safe_preferred_delta"])
    control_joint = float(control_contract["oof_joint_minimum"])
    checks = {
        "all_native_safety_checks_passed": all(
            bool(value)
            for key, value in aggregate["checks"].items()
            if "improved_by_0_02" not in key
        ),
        "candidate_joint_nonregression_vs_r23_weak_control": r23._metric_at_least(
            candidate_joint, control_joint
        ),
        "oof_page_common_positive_nonregression": r23._metric_at_least(
            page["all_rows_top1_in_common_positive_rate"],
            float(control_page["all_rows_top1_in_common_positive_rate"]),
        ),
        "oof_page_top1_agreement_nonregression": r23._metric_at_least(
            page["top1_all_agree_rate"],
            float(control_page["top1_all_agree_rate"]),
        ),
        "oof_page_discrete_improvement_over_control": (
            max(
                page["all_rows_top1_in_common_positive_rate"]
                - float(control_page["all_rows_top1_in_common_positive_rate"]),
                page["top1_all_agree_rate"]
                - float(control_page["top1_all_agree_rate"]),
            )
            > r23.METRIC_GATE_ABSOLUTE_TOLERANCE
        ),
    }
    aggregate["page_consistency_continuation"] = {
        "candidate_joint": candidate_joint,
        "checks": checks,
        "control_candidate_joint": control_joint,
        "control_oof_page_macro_delta": dict(control_page),
        "oof_page_macro_delta": page,
        "passed": bool(all(checks.values())),
        "promotion_authority": False,
    }
    return aggregate


@contextlib.contextmanager
def _engine_context(cell: str) -> Iterator[None]:
    global _ACTIVE_CONTROL_CONTRACT, _ENGINE_ACTIVE
    _cell_weights(cell)
    with _ENGINE_LOCK:
        if _ENGINE_ACTIVE:
            raise R24TrainingError("R2.4 engine context is not reentrant")
        _assert_frozen_engine()
        control_contract = _load_control_contract(_CONTROL_DIR)
        patches: Mapping[str, Any] = {
            "MARGINAL_MODES": MARGINAL_MODES,
            "MARKER_FILE": MARKER_FILE,
            "OWNER": OWNER,
            "PRODUCER_FILE_NAME": PRODUCER_FILE_NAME,
            "RECORD_TYPE": RECORD_TYPE,
            "SCHEMA_VERSION": SCHEMA_VERSION,
            "SELECTION_KEY_ORDER": SELECTION_KEY_ORDER,
            "SIDECAR_TEMPLATE": SIDECAR_TEMPLATE,
            "_aggregate_logo_metrics": _aggregate_logo_metrics,
            "_direct_step": _direct_step,
            "_experiment_contract": _experiment_contract,
            "_fold_contract": _fold_contract,
            "_heldout_report": _heldout_report,
            "_load_control_contract": _load_control_contract,
            "_objective_contract": _objective_contract,
            "_phase_consumption": _phase_consumption,
            "_producer_binding": _producer_binding,
            "_selection_key": _selection_key,
            "_training_deltas": _training_deltas,
            "_validate_direct_loss": _validate_direct_loss,
            "_zero_consumption": _zero_consumption,
        }
        originals = {name: getattr(r23, name) for name in _PATCH_NAMES}
        _ACTIVE_CONTROL_CONTRACT = control_contract
        _ENGINE_ACTIVE = True
        try:
            for name, value in patches.items():
                setattr(r23, name, value)
            yield
        finally:
            for name, value in originals.items():
                setattr(r23, name, value)
            _ENGINE_ACTIVE = False
            _ACTIVE_CONTROL_CONTRACT = None


def _native_args(args: argparse.Namespace) -> argparse.Namespace:
    values = vars(args).copy()
    values["marginal_mode"] = values.pop("page_cell")
    values["control_dir"] = _CONTROL_DIR
    values["page_js_weight"] = 0.0
    return argparse.Namespace(**values)


def _normalize(result: Mapping[str, Any], operation: str) -> Mapping[str, Any]:
    normalized = dict(result)
    normalized["operation"] = operation
    normalized["schema_version"] = SCHEMA_VERSION
    normalized["status"] = f"{operation}_nonpromotable_r24_page_consistency_logo"
    if operation in {"train", "validate", "evaluate"}:
        root = Path(str(normalized["output_dir"]))
        manifest = json.loads((root / MANIFEST_FILE).read_text(encoding="utf-8"))
        normalized["page_consistency_continuation_worth"] = bool(
            manifest["logo_aggregate"]["page_consistency_continuation"]["passed"]
        )
    return normalized


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    native = _native_args(args)
    _load_control_contract(_CONTROL_DIR)
    with _engine_context(native.marginal_mode):
        return _normalize(r23.preflight(native), "preflight")


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    native = _native_args(args)
    with _engine_context(native.marginal_mode):
        return _normalize(r23.train(native), "train")


def _manifest_cell(output_dir: Path) -> str:
    expanded = output_dir.expanduser().absolute()
    if r23.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R24TrainingError("R2.4 output path is linked or reparsed")
    manifest = json.loads(
        (expanded.resolve() / MANIFEST_FILE).read_text(encoding="utf-8")
    )
    mode = manifest.get("configuration", {}).get("marginal_mode")
    if mode not in PAGE_CELLS:
        raise R24TrainingError("R2.4 manifest page cell drifted")
    return str(mode)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    cell = _manifest_cell(output_dir)
    with _engine_context(cell):
        return _normalize(_NATIVE_VALIDATE_OUTPUT(output_dir), "validate")


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    return _normalize(validate_output(args.output_dir), "evaluate")


def _add_source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-npz", type=Path, default=r23.r0.DEFAULT_BASE_NPZ)
    parser.add_argument("--overlay-dir", type=Path, default=r23.r0.DEFAULT_OVERLAY_DIR)
    parser.add_argument(
        "--anchor-adapter-dir", type=Path, default=r23.r0.DEFAULT_ANCHOR_DIR
    )
    parser.add_argument(
        "--source-query-head", type=Path, default=r23.r0.DEFAULT_SOURCE_QUERY_HEAD
    )
    parser.add_argument("--source-label-dir", type=Path, default=r23.DEFAULT_LABEL_DIR)
    parser.add_argument("--page-cell", choices=tuple(PAGE_CELLS), required=True)
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
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument("--seed", type=int, default=r23.INITIAL_SEED)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    _add_source_arguments(preflight_parser)
    preflight_parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    train_parser = commands.add_parser("train")
    _add_source_arguments(train_parser)
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
    except (R24TrainingError, r23.R23TrainingError) as error:
        parser.error(str(error))
    print(r23.canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
