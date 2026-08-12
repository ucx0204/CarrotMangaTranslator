#!/usr/bin/env python3
"""Select one precommitted r10 adapter interpolation without val33 leakage.

The three input adapters are deliberately trained for exactly one epoch from
the sealed r3h checkpoint.  This selector evaluates every adapter/alpha pair
only on the r3 validation cohort after removing the 33 adjudicated diagnostic
rows.  The val33 and train-only r10 labels are scored only after the winner is
fixed.  The output is a normal sealed v8 role/family adapter artifact, but has
no automatic release authority.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import augment_manga_font_student_v8_with_high_value_labels_r3_base_v2 as r10_overlay
    from scripts import build_manga_font_student_v8_role_family_dataset as base_dataset
    from scripts import interpolate_manga_font_student_v8_role_family_adapters as interpolation
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - direct script execution
    import augment_manga_font_student_v8_with_high_value_labels_r3_base_v2 as r10_overlay
    import build_manga_font_student_v8_role_family_dataset as base_dataset
    import interpolate_manga_font_student_v8_role_family_adapters as interpolation
    import train_manga_font_student_v8_role_family_adapter as trainer


SCHEMA_VERSION = "manga-font-v2-r10-conservative-interpolation-sweep-v1"
OWNER = f"carrot-manga-translator/{SCHEMA_VERSION}"
DEFAULT_ALPHA_GRID = "0,0.05,0.10,0.15,0.20,0.25,0.35,0.50"
SELECTION_ROWS = 9000
VISUAL_SELECTION_ROWS = 1047
VAL33_ROWS = 33
TRAIN_ONLY_DIAGNOSTIC_ROWS = 1347
MINIMUM_SCORE_GAIN = 0.00025
MAXIMUM_METRIC_DROP = 0.002
MAXIMUM_FAMILY_DROP = 0.003

# These IDs and configuration subsets are the precommit.  A differently
# trained checkpoint is rejected rather than silently joining the sweep.
PRECOMMITTED_TRIALS: Mapping[str, Mapping[str, Any]] = {
    "full-uniform-e1": {
        "candidate_parameter_lr_multiplier": 1.0,
        "human_candidate_weight_multiplier": 1.0,
        "human_family_weight_multiplier": 1.0,
        "learning_rate": 2e-5,
        "trainable_scope": "all",
    },
    "family-human2-e1": {
        "candidate_parameter_lr_multiplier": 0.0,
        "human_candidate_weight_multiplier": 1.0,
        "human_family_weight_multiplier": 2.0,
        "learning_rate": 2e-5,
        "trainable_scope": "family-head-only",
    },
    "full-human2-e1": {
        "candidate_parameter_lr_multiplier": 1.0,
        "human_candidate_weight_multiplier": 2.0,
        "human_family_weight_multiplier": 1.5,
        "learning_rate": 1e-5,
        "trainable_scope": "all",
    },
}

COMMON_CONFIGURATION: Mapping[str, Any] = {
    "bias_l2_weight": 0.02,
    "candidate_distribution_slack": 0.0,
    "candidate_distribution_temperature": 0.12,
    "candidate_distribution_weight": 1.0,
    "family_weight": 0.35,
    "focus_candidate_ids": [],
    "focus_candidate_weight_multiplier": 1.0,
    "human_selection_weight": 0.0,
    "rare_class_weight_cap": 3.0,
    "sample_residual_l2_weight": 0.01,
    "single_day_hard_negative_margin": 0.5,
    "single_day_hard_negative_weight": 5.0,
    "supervised_single_day_hard_negative_weight": 10.0,
    "weight_decay": 0.0001,
}


class ConservativeSweepError(ValueError):
    """Raised when the r10 experiment crosses its sealed precommit."""


def parse_target(value: str) -> tuple[str, Path]:
    trial_id, separator, raw_path = value.partition("=")
    if (
        separator != "="
        or trial_id not in PRECOMMITTED_TRIALS
        or not raw_path
        or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,40}", trial_id)
    ):
        raise argparse.ArgumentTypeError(
            "target must be a precommitted trial-id=adapter-directory pair"
        )
    return trial_id, Path(raw_path)


def selection_score(
    all_metrics: Mapping[str, Any], visual_metrics: Mapping[str, Any]
) -> float:
    """Rank only the non-val33 r3 holdout and its visual subset."""

    result = (
        0.35 * float(all_metrics["acceptable_at1"])
        + 0.25 * float(visual_metrics["acceptable_at1"])
        + 0.20 * float(all_metrics["preferred_at1"])
        + 0.15 * float(visual_metrics["preferred_at1"])
        + 0.05 * float(all_metrics["family_accuracy"])
    )
    if not math.isfinite(result):
        raise ConservativeSweepError("selection score became non-finite")
    return result


def _single_day_precision_safe(metrics: Mapping[str, Any]) -> bool:
    return int(metrics["single_day_predicted_count"]) == 0 or float(
        metrics["single_day_positive_precision"]
    ) >= 0.80


def quality_gate_checks(
    candidate_all: Mapping[str, Any],
    candidate_visual: Mapping[str, Any],
    baseline_all: Mapping[str, Any],
    baseline_visual: Mapping[str, Any],
) -> Mapping[str, bool]:
    """Use strict r3h-relative retention plus the production SD safeguards."""

    return {
        "all_acceptable_retained": float(candidate_all["acceptable_at1"])
        >= float(baseline_all["acceptable_at1"]) - MAXIMUM_METRIC_DROP,
        "all_family_retained": float(candidate_all["family_accuracy"])
        >= float(baseline_all["family_accuracy"]) - MAXIMUM_FAMILY_DROP,
        "all_preferred_retained": float(candidate_all["preferred_at1"])
        >= float(baseline_all["preferred_at1"]) - MAXIMUM_METRIC_DROP,
        "all_single_day_false_zero": int(
            candidate_all["single_day_body_false_top1_count"]
        )
        == 0,
        "all_single_day_no_new_predictions": int(
            candidate_all["single_day_predicted_count"]
        )
        <= int(baseline_all["single_day_predicted_count"]),
        "all_single_day_precision_safe": _single_day_precision_safe(candidate_all),
        "all_top1_share_bounded": float(candidate_all["top1_max_candidate_share"])
        <= min(0.65, float(baseline_all["top1_max_candidate_share"]) + 0.02),
        "visual_acceptable_retained": float(candidate_visual["acceptable_at1"])
        >= float(baseline_visual["acceptable_at1"]) - MAXIMUM_METRIC_DROP,
        "visual_family_retained": float(candidate_visual["family_accuracy"])
        >= float(baseline_visual["family_accuracy"]) - MAXIMUM_FAMILY_DROP,
        "visual_preferred_retained": float(candidate_visual["preferred_at1"])
        >= float(baseline_visual["preferred_at1"]) - MAXIMUM_METRIC_DROP,
        "visual_single_day_false_zero": int(
            candidate_visual["single_day_body_false_top1_count"]
        )
        == 0,
        "visual_single_day_no_new_predictions": int(
            candidate_visual["single_day_predicted_count"]
        )
        <= int(baseline_visual["single_day_predicted_count"]),
        "visual_single_day_precision_safe": _single_day_precision_safe(
            candidate_visual
        ),
        "visual_top1_share_bounded": float(
            candidate_visual["top1_max_candidate_share"]
        )
        <= min(0.65, float(baseline_visual["top1_max_candidate_share"]) + 0.02),
    }


def choose_candidate(
    records: Sequence[Mapping[str, Any]], *, baseline_score: float
) -> Mapping[str, Any]:
    eligible = [
        record
        for record in records
        if record.get("quality_gate_passed") is True
        and (
            record.get("trial_id") == "r3h-baseline"
            or float(record["selection_score"])
            >= baseline_score + MINIMUM_SCORE_GAIN
        )
    ]
    if not eligible:
        raise ConservativeSweepError("the sealed r3h baseline disappeared from selection")
    return max(
        eligible,
        key=lambda record: (
            float(record["selection_score"]),
            float(record["visual_metrics"]["acceptable_at1"]),
            float(record["all_metrics"]["acceptable_at1"]),
            float(record["visual_metrics"]["preferred_at1"]),
            -float(record["alpha"]),
            -int(record["trial_order"]),
        ),
    )


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConservativeSweepError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise ConservativeSweepError(f"{location}: expected object")
    return value


def _load_ids(path: Path, *, expected: int, location: str) -> tuple[str, ...]:
    values: list[str] = []
    try:
        lines = path.expanduser().resolve().read_text(encoding="utf-8-sig").splitlines()
        for line in lines:
            if not line.strip():
                continue
            row = json.loads(line)
            sample_id = row.get("sample_id") if isinstance(row, Mapping) else None
            if not isinstance(sample_id, str) or not sample_id:
                raise ConservativeSweepError(f"{location}: sample ID is absent")
            values.append(sample_id)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConservativeSweepError(f"{location}: invalid JSONL") from error
    if len(values) != expected or len(set(values)) != expected:
        raise ConservativeSweepError(
            f"{location}: expected {expected} unique sample IDs"
        )
    return tuple(values)


def _positions(
    arrays: Mapping[str, np.ndarray],
    sample_ids: Sequence[str],
    *,
    expected_split: int,
    location: str,
) -> np.ndarray:
    dataset_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    index = {value: position for position, value in enumerate(dataset_ids)}
    if len(index) != len(dataset_ids) or any(value not in index for value in sample_ids):
        raise ConservativeSweepError(f"{location}: sample identity drifted")
    result = np.asarray([index[value] for value in sample_ids], dtype=np.int64)
    if np.any(arrays["split"][result].astype(np.int64, copy=False) != expected_split):
        raise ConservativeSweepError(f"{location}: split boundary drifted")
    return result


def _descriptor(path: Path) -> Mapping[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "sha256": trainer.sha256_file(path),
    }


def _load_adapter(
    torch: Any,
    root: Path,
    *,
    candidate_ids: Sequence[str],
    architecture: Mapping[str, Any],
    source_query_head: Path,
    expected_dataset_sha256: str,
    baseline_checkpoint_sha256: str | None = None,
    trial_id: str | None = None,
) -> tuple[Mapping[str, np.ndarray], Mapping[str, Any]]:
    resolved = root.expanduser().resolve()
    manifest = _read_json(resolved / trainer.MANIFEST_FILE, "adapter manifest")
    model = trainer.build_role_family_adapter(
        torch,
        candidate_count=len(candidate_ids),
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    expected_state = {
        name: value.detach().cpu().numpy() for name, value in model.state_dict().items()
    }
    state, _binding = trainer.load_initial_adapter_state(
        resolved,
        candidate_ids=candidate_ids,
        source_query_head=source_query_head,
        expected_architecture=architecture,
        expected_state=expected_state,
    )
    dataset = manifest.get("dataset")
    if (
        not isinstance(dataset, Mapping)
        or dataset.get("sha256") != expected_dataset_sha256
        or manifest.get("architecture") != architecture
        or tuple(manifest.get("candidate_ids", ())) != tuple(candidate_ids)
    ):
        raise ConservativeSweepError("adapter dataset/architecture binding drifted")
    if trial_id is not None:
        configuration = manifest.get("configuration")
        initialization = manifest.get("initialization")
        history = manifest.get("history")
        expected = {**COMMON_CONFIGURATION, **PRECOMMITTED_TRIALS[trial_id]}
        if (
            not isinstance(configuration, Mapping)
            or any(configuration.get(key) != value for key, value in expected.items())
            or not isinstance(initialization, Mapping)
            or initialization.get("checkpoint_sha256") != baseline_checkpoint_sha256
            or not isinstance(history, list)
            or len(history) != 1
            or history[0].get("epoch") != 1
            or not isinstance(manifest.get("best_epoch"), Mapping)
            or manifest["best_epoch"].get("epoch") != 1
        ):
            raise ConservativeSweepError(
                f"{trial_id}: checkpoint escaped the one-epoch precommit"
            )
    return state, manifest


def _infer(
    torch: Any,
    *,
    state: Mapping[str, np.ndarray],
    architecture: Mapping[str, Any],
    candidate_count: int,
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    device: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    model = trainer.build_role_family_adapter(
        torch,
        candidate_count=candidate_count,
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    ).to(device)
    converted = {
        name: torch.from_numpy(np.asarray(value)).to(device) for name, value in state.items()
    }
    model.load_state_dict(converted, strict=True)
    model.requires_grad_(False).eval()
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    outputs: dict[str, list[Any]] = {
        "body_candidate_scores": [],
        "variant_candidate_scores": [],
        "family_logits": [],
    }
    with torch.inference_mode():
        for start in range(0, len(indices), batch_size):
            selected = indices[start : start + batch_size]
            query = torch.from_numpy(
                arrays["query_views"][selected].astype(np.float32, copy=False)
            ).to(device)
            values = model(query, prototypes)
            for name in outputs:
                outputs[name].append(values[name].detach().cpu())
    return {name: torch.cat(parts, dim=0) for name, parts in outputs.items()}


def _metrics(
    torch: Any,
    *,
    outputs: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    return trainer.compute_metrics(
        torch,
        outputs,
        family_labels=torch.from_numpy(
            arrays["family_labels"][indices].astype(np.int64, copy=False)
        ),
        positive_mask=torch.from_numpy(
            arrays["positive_mask"][indices].astype(np.bool_, copy=False)
        ),
        preferred_mask=torch.from_numpy(
            arrays["preferred_mask"][indices].astype(np.bool_, copy=False)
        ),
        font_supervision_weights=torch.from_numpy(
            arrays["font_supervision_weights"][indices].astype(np.float32, copy=False)
        ),
        single_day_body_negative=torch.from_numpy(
            arrays["single_day_body_negative"][indices].astype(np.bool_, copy=False)
        ),
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )


def _evaluate(
    torch: Any,
    *,
    state: Mapping[str, np.ndarray],
    architecture: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    selection: np.ndarray,
    visual_positions: np.ndarray,
    candidate_ids: Sequence[str],
    device: Any,
    batch_size: int,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    outputs = _infer(
        torch,
        state=state,
        architecture=architecture,
        candidate_count=len(candidate_ids),
        arrays=arrays,
        indices=selection,
        device=device,
        batch_size=batch_size,
    )
    all_metrics = _metrics(
        torch,
        outputs=outputs,
        arrays=arrays,
        indices=selection,
        candidate_ids=candidate_ids,
    )
    visual_outputs = {
        name: value[torch.from_numpy(visual_positions)] for name, value in outputs.items()
    }
    visual_indices = selection[visual_positions]
    visual_metrics = _metrics(
        torch,
        outputs=visual_outputs,
        arrays=arrays,
        indices=visual_indices,
        candidate_ids=candidate_ids,
    )
    return all_metrics, visual_metrics


def _publish(
    *, output_dir: Path, state: Mapping[str, np.ndarray], manifest_core: Mapping[str, Any]
) -> None:
    try:
        from safetensors.numpy import save_file
    except ImportError as error:  # pragma: no cover
        raise ConservativeSweepError("safetensors is required") from error
    output = output_dir.expanduser().resolve()
    if output.exists() or output.is_symlink() or output in {
        Path.cwd().resolve(),
        Path.home().resolve(),
        Path(output.anchor),
    }:
        raise ConservativeSweepError("refusing unsafe/existing output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        checkpoint = staging / trainer.CHECKPOINT_FILE
        save_file({name: np.ascontiguousarray(value) for name, value in state.items()}, str(checkpoint))
        manifest = trainer.seal_record(
            {
                **dict(manifest_core),
                "files": {trainer.CHECKPOINT_FILE: _descriptor(checkpoint)},
                "record_type": "manga_font_student_v8_role_family_adapter_manifest",
                "schema_version": trainer.SCHEMA_VERSION,
            }
        )
        manifest_path = staging / trainer.MANIFEST_FILE
        manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
        marker = trainer.seal_record(
            {
                "artifacts": {
                    trainer.CHECKPOINT_FILE: trainer.sha256_file(checkpoint),
                    trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path),
                },
                "owner": trainer.OWNER,
                "safe_replace": True,
                "schema_version": trainer.SCHEMA_VERSION,
            }
        )
        (staging / trainer.MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def build(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise ConservativeSweepError("PyTorch is required") from error

    target_pairs = tuple(args.target)
    if tuple(trial_id for trial_id, _path in target_pairs) != tuple(
        PRECOMMITTED_TRIALS
    ):
        raise ConservativeSweepError(
            "targets must be supplied once each in the sealed precommit order"
        )
    alphas = interpolation.parse_alpha_grid(args.alpha_grid)
    if alphas != tuple(sorted(set(alphas))) or 0.0 not in alphas or max(alphas) > 0.5:
        raise ConservativeSweepError("alpha grid must include zero and stay at or below 0.50")
    source_query_head = args.source_query_head.expanduser().resolve()
    dataset_root = args.dataset_dir.expanduser().resolve()
    base_dataset_path = args.base_dataset_npz.expanduser().resolve()
    dataset_path = dataset_root / r10_overlay.DATASET_FILE
    r10_validation = r10_overlay.validate_output(dataset_root)
    base_validation = base_dataset.validate_output(base_dataset_path.parent)
    _base_path, base_arrays, base_inventory = trainer._load_training_npz(base_dataset_path)  # noqa: SLF001
    _dataset_path, arrays, inventory = trainer._load_training_npz(dataset_path)  # noqa: SLF001
    if (
        r10_validation.get("val_rows") != 9033
        or base_validation.get("val_rows") != 9033
        or inventory["row_count"] != 23882
        or tuple(base_inventory["candidate_ids"]) != tuple(inventory["candidate_ids"])
    ):
        raise ConservativeSweepError("r3/r10 dataset cardinality drifted")
    candidate_ids = tuple(inventory["candidate_ids"])
    val_mask = arrays["split"].astype(np.int64, copy=False) == 1
    base_val_mask = base_arrays["split"].astype(np.int64, copy=False) == 1
    for name in (
        "candidate_eligible_mask",
        "family_label_weights",
        "family_labels",
        "font_authority",
        "font_supervision_weights",
        "positive_mask",
        "preferred_mask",
        "query_views",
        "sample_ids",
        "single_day_body_negative",
        "split",
        "work_ids",
    ):
        if not np.array_equal(base_arrays[name][base_val_mask], arrays[name][val_mask]):
            raise ConservativeSweepError(f"r10 changed sealed validation array: {name}")

    val33_ids = _load_ids(args.val33_jsonl, expected=VAL33_ROWS, location="val33")
    val33_positions = _positions(
        arrays, val33_ids, expected_split=1, location="val33"
    )
    selection_mask = val_mask.copy()
    selection_mask[val33_positions] = False
    selection = np.flatnonzero(selection_mask)
    authorities = arrays["font_authority"].astype(str, copy=False)
    visual_positions = np.flatnonzero(authorities[selection] == "visual")
    if len(selection) != SELECTION_ROWS or len(visual_positions) != VISUAL_SELECTION_ROWS:
        raise ConservativeSweepError("non-val33 selection cohort cardinality drifted")

    base_root = args.base_adapter_dir.expanduser().resolve()
    base_manifest = _read_json(base_root / trainer.MANIFEST_FILE, "r3h manifest")
    architecture = base_manifest.get("architecture")
    if not isinstance(architecture, Mapping):
        raise ConservativeSweepError("r3h architecture is absent")
    base_state, _base_loaded_manifest = _load_adapter(
        torch,
        base_root,
        candidate_ids=candidate_ids,
        architecture=architecture,
        source_query_head=source_query_head,
        expected_dataset_sha256=trainer.sha256_file(base_dataset_path),
    )
    baseline_checkpoint_sha256 = trainer.sha256_file(
        base_root / trainer.CHECKPOINT_FILE
    )
    target_states: list[tuple[str, Path, Mapping[str, np.ndarray], Mapping[str, Any]]] = []
    seen_checkpoints: set[str] = set()
    for trial_id, target_root in target_pairs:
        state, manifest = _load_adapter(
            torch,
            target_root,
            candidate_ids=candidate_ids,
            architecture=architecture,
            source_query_head=source_query_head,
            expected_dataset_sha256=trainer.sha256_file(dataset_path),
            baseline_checkpoint_sha256=baseline_checkpoint_sha256,
            trial_id=trial_id,
        )
        checkpoint_sha256 = trainer.sha256_file(
            target_root.expanduser().resolve() / trainer.CHECKPOINT_FILE
        )
        if checkpoint_sha256 in seen_checkpoints:
            raise ConservativeSweepError("target checkpoints are duplicated")
        seen_checkpoints.add(checkpoint_sha256)
        target_states.append((trial_id, target_root.expanduser().resolve(), state, manifest))

    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise ConservativeSweepError("CUDA requested but unavailable")
    baseline_all, baseline_visual = _evaluate(
        torch,
        state=base_state,
        architecture=architecture,
        arrays=arrays,
        selection=selection,
        visual_positions=visual_positions,
        candidate_ids=candidate_ids,
        device=device,
        batch_size=args.batch_size,
    )
    baseline_score = selection_score(baseline_all, baseline_visual)
    records: list[Mapping[str, Any]] = [
        {
            "all_metrics": baseline_all,
            "alpha": 0.0,
            "quality_gate_checks": {"sealed_r3h_baseline": True},
            "quality_gate_passed": True,
            "selection_score": baseline_score,
            "trial_id": "r3h-baseline",
            "trial_order": 0,
            "visual_metrics": baseline_visual,
        }
    ]
    states: dict[tuple[str, float], Mapping[str, np.ndarray]] = {
        ("r3h-baseline", 0.0): base_state
    }
    for trial_order, (trial_id, _root, target_state, _manifest) in enumerate(
        target_states, 1
    ):
        for alpha in alphas:
            if alpha == 0.0:
                continue
            state = interpolation.interpolate_states(base_state, target_state, alpha)
            all_metrics, visual_metrics = _evaluate(
                torch,
                state=state,
                architecture=architecture,
                arrays=arrays,
                selection=selection,
                visual_positions=visual_positions,
                candidate_ids=candidate_ids,
                device=device,
                batch_size=args.batch_size,
            )
            checks = quality_gate_checks(
                all_metrics, visual_metrics, baseline_all, baseline_visual
            )
            records.append(
                {
                    "all_metrics": all_metrics,
                    "alpha": alpha,
                    "quality_gate_checks": checks,
                    "quality_gate_passed": all(checks.values()),
                    "selection_score": selection_score(all_metrics, visual_metrics),
                    "trial_id": trial_id,
                    "trial_order": trial_order,
                    "visual_metrics": visual_metrics,
                }
            )
            states[(trial_id, alpha)] = state
    selected = choose_candidate(records, baseline_score=baseline_score)
    selected_key = (str(selected["trial_id"]), float(selected["alpha"]))
    selected_state = states[selected_key]

    # These diagnostics are intentionally unavailable until candidate+alpha is fixed.
    diagnostic_ids = _load_ids(
        args.training_labels_jsonl,
        expected=TRAIN_ONLY_DIAGNOSTIC_ROWS,
        location="r10 train-only labels",
    )
    diagnostic_positions = _positions(
        arrays,
        diagnostic_ids,
        expected_split=0,
        location="r10 train-only labels",
    )
    val33_outputs = _infer(
        torch,
        state=selected_state,
        architecture=architecture,
        candidate_count=len(candidate_ids),
        arrays=arrays,
        indices=val33_positions,
        device=device,
        batch_size=args.batch_size,
    )
    val33_metrics = _metrics(
        torch,
        outputs=val33_outputs,
        arrays=arrays,
        indices=val33_positions,
        candidate_ids=candidate_ids,
    )
    train_outputs = _infer(
        torch,
        state=selected_state,
        architecture=architecture,
        candidate_count=len(candidate_ids),
        arrays=arrays,
        indices=diagnostic_positions,
        device=device,
        batch_size=args.batch_size,
    )
    train_metrics = _metrics(
        torch,
        outputs=train_outputs,
        arrays=arrays,
        indices=diagnostic_positions,
        candidate_ids=candidate_ids,
    )

    selected_checks = dict(selected["quality_gate_checks"])
    manifest_core = {
        "architecture": dict(architecture),
        "authority": {
            "automatic_release_authority": False,
            "evaluation_authority": False,
            "exporter_candidate": selected["trial_id"] != "r3h-baseline",
            "training_label_authority": False,
            "weight_source_only": True,
        },
        "best_epoch": {
            "epoch": 0,
            "selection_safety_passed": all(selected_checks.values()),
            "val": dict(selected["all_metrics"]),
            "val_by_authority": {"visual": dict(selected["visual_metrics"])},
        },
        "candidate_ids": list(candidate_ids),
        "configuration": {
            "alpha_grid": list(alphas),
            "minimum_score_gain": MINIMUM_SCORE_GAIN,
            "precommitted_trial_ids": list(PRECOMMITTED_TRIALS),
            "selection_rows_excluding_val33": len(selection),
            "visual_selection_rows": len(visual_positions),
        },
        "dataset": {
            "authority_counts": dict(inventory["authority_counts"]),
            "dataset_schema_version": inventory["dataset_schema_version"],
            "family_body_rows": inventory["family_body_rows"],
            "family_variant_rows": inventory["family_variant_rows"],
            "file": str(dataset_path),
            "font_supervised_rows": inventory["font_supervised_rows"],
            "row_count": inventory["row_count"],
            "sha256": trainer.sha256_file(dataset_path),
            "single_day_body_negative_rows": inventory[
                "single_day_body_negative_rows"
            ],
            "train_rows": inventory["train_rows"],
            "train_work_count": inventory["train_work_count"],
            "val_rows": inventory["val_rows"],
            "val_work_count": inventory["val_work_count"],
        },
        "history": records,
        "interpolation_selection": {
            "diagnostic_cohorts_excluded": ["adjudicated_val33", "r10_train_only_1347"],
            "routing_authority": "predicted_pixel_family_with_single_day_eligibility",
            "selected_alpha": selected["alpha"],
            "selected_score": selected["selection_score"],
            "selected_trial_id": selected["trial_id"],
            "selection_cohorts": {
                "r3_validation_excluding_val33": len(selection),
                "visual_r3_validation": len(visual_positions),
            },
            "selection_metric": "weighted_all_visual_acceptable_preferred_family",
            "single_day_safety_mandatory": True,
        },
        "interpolation_parents": {
            "base": {
                "adapter_dir": str(base_root),
                "checkpoint_sha256": baseline_checkpoint_sha256,
                "role": "r3h_anchor",
            },
            "targets": [
                {
                    "adapter_dir": str(root),
                    "checkpoint_sha256": trainer.sha256_file(
                        root / trainer.CHECKPOINT_FILE
                    ),
                    "role": trial_id,
                }
                for trial_id, root, _state, _manifest in target_states
            ],
        },
        "post_selection_diagnostics": {
            "adjudicated_val33": {
                "metrics": val33_metrics,
                "row_count": len(val33_positions),
                "selection_used": False,
            },
            "r10_train_only_1347": {
                "human_gold": False,
                "metrics": train_metrics,
                "row_count": len(diagnostic_positions),
                "selection_used": False,
            },
        },
        "quality_gate": {
            "checks": selected_checks,
            "passed": all(selected_checks.values()),
            "selection_only": True,
        },
        "source_code_schema": SCHEMA_VERSION,
        "source_query_head": dict(base_manifest["source_query_head"]),
        "training_seconds": 0.0,
    }
    _publish(output_dir=args.output_dir, state=selected_state, manifest_core=manifest_core)
    return validate(args.output_dir)


def validate(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    manifest = _read_json(root / trainer.MANIFEST_FILE, "sweep manifest")
    trainer.validate_record_seal(manifest, "sweep manifest")
    selection = manifest.get("interpolation_selection")
    diagnostics = manifest.get("post_selection_diagnostics")
    quality = manifest.get("quality_gate")
    if (
        manifest.get("source_code_schema") != SCHEMA_VERSION
        or not isinstance(selection, Mapping)
        or selection.get("selection_cohorts")
        != {
            "r3_validation_excluding_val33": SELECTION_ROWS,
            "visual_r3_validation": VISUAL_SELECTION_ROWS,
        }
        or not isinstance(diagnostics, Mapping)
        or diagnostics.get("adjudicated_val33", {}).get("selection_used") is not False
        or diagnostics.get("r10_train_only_1347", {}).get("selection_used") is not False
        or not isinstance(quality, Mapping)
        or quality.get("passed") is not True
    ):
        raise ConservativeSweepError("published sweep authority/selection seal drifted")
    return {
        "alpha": selection["selected_alpha"],
        "output_dir": str(root),
        "quality_gate_passed": True,
        "selection_rows": SELECTION_ROWS,
        "status": "validated_r10_conservative_interpolation_sweep",
        "trial_id": selection["selected_trial_id"],
        "val33_diagnostic_only": True,
        "visual_selection_rows": VISUAL_SELECTION_ROWS,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--base-adapter-dir", type=Path, required=True)
    build_parser.add_argument("--target", action="append", type=parse_target, required=True)
    build_parser.add_argument("--base-dataset-npz", type=Path, required=True)
    build_parser.add_argument("--dataset-dir", type=Path, required=True)
    build_parser.add_argument("--source-query-head", type=Path, required=True)
    build_parser.add_argument("--val33-jsonl", type=Path, required=True)
    build_parser.add_argument("--training-labels-jsonl", type=Path, required=True)
    build_parser.add_argument("--output-dir", type=Path, required=True)
    build_parser.add_argument("--alpha-grid", default=DEFAULT_ALPHA_GRID)
    build_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    build_parser.add_argument("--batch-size", type=int, default=512)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            if args.batch_size < 1:
                raise ConservativeSweepError("batch size must be positive")
            result = build(args)
        else:
            result = validate(args.output_dir)
    except (
        ConservativeSweepError,
        base_dataset.V8RoleFamilyDatasetError,
        r10_overlay.HighValueDatasetOverlayError,
        trainer.MangaFontV8RoleFamilyError,
        interpolation.MangaFontAdapterInterpolationError,
    ) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
