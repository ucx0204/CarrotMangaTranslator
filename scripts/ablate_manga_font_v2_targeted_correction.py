"""Ablate short r3h-anchored corrections on sealed high-value font labels.

This experiment is intentionally isolated from the production trainer.  It starts
each trial from the sealed r3h adapter, applies supervised loss only to the newly
sealed high-value rows, and distils r3h body/variant/family outputs on every other
training row.  Checkpoint selection uses the r3 work holdout with val33 removed;
val33 is loaded only after the winning trial and epoch are fixed.
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
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import augment_manga_font_student_v8_with_high_value_labels as overlay
    from scripts import seal_manga_font_v2_high_value_supervised_labels as labels_artifact
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - direct script execution
    import augment_manga_font_student_v8_with_high_value_labels as overlay
    import seal_manga_font_v2_high_value_supervised_labels as labels_artifact
    import train_manga_font_student_v8_role_family_adapter as trainer


SCHEMA_VERSION = "manga-font-v2-targeted-correction-ablation-v1"
OWNER = f"carrot-manga-translator/{SCHEMA_VERSION}"
MARKER_FILE = ".manga-font-v2-targeted-correction-ablation-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
CHECKPOINT_FILE = "role-family-adapter.safetensors"
EXPECTED_OVERLAP_KEYS = frozenset(
    {
        "adapter_validation",
        "adapter_validation_work",
        "blind_calibration",
        "blind_evaluation",
        "master_test",
        "master_val",
        "qa_pages",
        "val33",
    }
)


class TargetedCorrectionError(ValueError):
    """Raised when an experimental or authority boundary fails closed."""


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TargetedCorrectionError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise TargetedCorrectionError(f"{location}: expected object")
    return value


def _read_jsonl(path: Path, location: str) -> list[Mapping[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        values = [json.loads(line) for line in lines if line.strip()]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TargetedCorrectionError(f"{location}: invalid JSONL") from error
    if not values or any(not isinstance(value, Mapping) for value in values):
        raise TargetedCorrectionError(f"{location}: expected nonempty object rows")
    return values


def _descriptor(path: Path, *, file: str | None = None) -> Mapping[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "file": file if file is not None else str(path.resolve()),
        "sha256": trainer.sha256_file(path),
    }


def validate_high_value_boundary(
    arrays: Mapping[str, np.ndarray],
    *,
    label_ids: Sequence[str],
    label_manifest: Mapping[str, Any],
    dataset_manifest: Mapping[str, Any],
    val33_ids: Sequence[str],
) -> Mapping[str, Any]:
    """Bind the exact sealed label identities to train-only r5 rows."""

    ids = tuple(str(value) for value in label_ids)
    if not ids or len(set(ids)) != len(ids):
        raise TargetedCorrectionError("high-value label IDs are empty or duplicated")
    overlap_counts = label_manifest.get("overlap")
    if (
        not isinstance(overlap_counts, Mapping)
        or set(overlap_counts) != EXPECTED_OVERLAP_KEYS
        or any(value != 0 for value in overlap_counts.values())
    ):
        raise TargetedCorrectionError("sealed high-value exclusions are not all zero")
    authority = label_manifest.get("authority")
    if not isinstance(authority, Mapping) or authority != {
        "automatic_label_promotion_allowed": False,
        "automatic_release_authority": False,
        "calibration_eligible": False,
        "evaluation_eligible": False,
        "human_gold": False,
        "review_authority": "codex_agent_direct_visual_supervision",
        "training_eligible": True,
        "training_only": True,
    }:
        raise TargetedCorrectionError("sealed label authority drifted")
    dataset_authority = dataset_manifest.get("authority")
    split_policy = dataset_manifest.get("split_policy")
    if (
        not isinstance(dataset_authority, Mapping)
        or dataset_authority.get("human_gold") is not False
        or dataset_authority.get("npz_authority_encoding")
        != "human_for_weighting_compatibility_only"
        or dataset_authority.get("review_authority")
        != "codex_agent_direct_visual_supervision"
        or dataset_authority.get("training_only") is not True
        or dataset_authority.get("automatic_release_authority") is not False
        or not isinstance(split_policy, Mapping)
        or split_policy.get("train_only_overlay") is not True
        or split_policy.get("validation_rows_modified") != 0
        or split_policy.get("test_rows_exported") != 0
    ):
        raise TargetedCorrectionError("r5 overlay authority or split policy drifted")

    sample_ids = np.asarray(arrays["sample_ids"]).astype(str)
    if len(set(sample_ids.tolist())) != len(sample_ids):
        raise TargetedCorrectionError("dataset sample IDs are duplicated")
    index = {value: offset for offset, value in enumerate(sample_ids.tolist())}
    missing = sorted(set(ids) - set(index))
    if missing:
        raise TargetedCorrectionError(f"sealed IDs are absent from r5: {missing[:3]}")
    positions = np.asarray([index[value] for value in ids], dtype=np.int64)
    split = np.asarray(arrays["split"]).astype(np.int64)
    authority_values = np.asarray(arrays["font_authority"]).astype(str)
    supervision = np.asarray(arrays["font_supervision_weights"]).astype(np.float32)
    val33 = frozenset(str(value) for value in val33_ids)
    if (
        np.any(split[positions] != 0)
        or np.any(authority_values[positions] != "human")
        or np.any(supervision[positions] <= 0)
        or set(ids).intersection(val33)
    ):
        raise TargetedCorrectionError(
            "sealed labels escaped train-only ABI authority or overlap val33"
        )
    counts = label_manifest.get("counts")
    dataset_counts = dataset_manifest.get("counts")
    if (
        not isinstance(counts, Mapping)
        or counts.get("training_label_rows") != len(ids)
        or not isinstance(dataset_counts, Mapping)
        or dataset_counts.get("high_value_overlay_rows") != len(ids)
    ):
        raise TargetedCorrectionError("sealed/r5 overlay row counts drifted")
    return {
        "high_value_positions": positions,
        "high_value_rows": len(ids),
        "high_value_sample_ids_sha256": hashlib.sha256(
            ("\n".join(ids) + "\n").encode("utf-8")
        ).hexdigest(),
        "overlap": dict(overlap_counts),
    }


def anchor_distillation_loss(
    torch: Any,
    student: Mapping[str, Any],
    teacher: Mapping[str, Any],
) -> tuple[Any, Mapping[str, Any]]:
    """Anchor score logits with MSE and the family posterior with KL."""

    required = {"body_candidate_scores", "variant_candidate_scores", "family_logits"}
    if set(student) < required or set(teacher) < required:
        raise TargetedCorrectionError("anchor output inventory drifted")
    body = torch.nn.functional.mse_loss(
        student["body_candidate_scores"].float(),
        teacher["body_candidate_scores"].float(),
    )
    variant = torch.nn.functional.mse_loss(
        student["variant_candidate_scores"].float(),
        teacher["variant_candidate_scores"].float(),
    )
    family = torch.nn.functional.kl_div(
        torch.nn.functional.log_softmax(student["family_logits"].float(), dim=1),
        torch.nn.functional.softmax(teacher["family_logits"].float(), dim=1),
        reduction="batchmean",
    )
    total = 0.5 * (body + variant) + family
    return total, {"body_mse": body, "family_kl": family, "variant_mse": variant}


def compact_metrics(metrics: Mapping[str, Any]) -> Mapping[str, Any]:
    keys = (
        "acceptable_at1",
        "family_accuracy",
        "font_supervised_rows",
        "preferred_at1",
        "preferred_supervised_rows",
        "rows",
        "single_day_body_false_top1_count",
        "single_day_body_false_top1_rate",
        "single_day_positive_count",
        "single_day_positive_precision",
        "single_day_positive_recall",
        "single_day_predicted_count",
        "top1_max_candidate_share",
        "top1_unique_candidate_count",
    )
    return {
        **{key: metrics[key] for key in keys},
        "single_day_eligibility": dict(metrics["single_day_eligibility"]),
    }


def selection_score(
    all_metrics: Mapping[str, Any], visual_metrics: Mapping[str, Any]
) -> float:
    """Score only r3 non-val33 selection metrics; never high-value fit."""

    return (
        0.35 * float(all_metrics["acceptable_at1"])
        + 0.25 * float(visual_metrics["acceptable_at1"])
        + 0.20 * float(all_metrics["preferred_at1"])
        + 0.15 * float(visual_metrics["preferred_at1"])
        + 0.05 * float(all_metrics["family_accuracy"])
    )


def retention_checks(
    candidate_all: Mapping[str, Any],
    candidate_visual: Mapping[str, Any],
    teacher_all: Mapping[str, Any],
    teacher_visual: Mapping[str, Any],
    *,
    maximum_drop: float,
) -> Mapping[str, bool]:
    def precision_safe(values: Mapping[str, Any]) -> bool:
        return int(values["single_day_predicted_count"]) == 0 or float(
            values["single_day_positive_precision"]
        ) >= 0.80

    return {
        "all_acceptable_retained": float(candidate_all["acceptable_at1"])
        >= float(teacher_all["acceptable_at1"]) - maximum_drop,
        "all_preferred_retained": float(candidate_all["preferred_at1"])
        >= float(teacher_all["preferred_at1"]) - maximum_drop,
        "all_single_day_false_zero": int(
            candidate_all["single_day_body_false_top1_count"]
        )
        == 0,
        "all_single_day_precision_safe": precision_safe(candidate_all),
        "visual_acceptable_retained": float(candidate_visual["acceptable_at1"])
        >= float(teacher_visual["acceptable_at1"]) - maximum_drop,
        "visual_preferred_retained": float(candidate_visual["preferred_at1"])
        >= float(teacher_visual["preferred_at1"]) - maximum_drop,
        "visual_single_day_false_zero": int(
            candidate_visual["single_day_body_false_top1_count"]
        )
        == 0,
        "visual_single_day_precision_safe": precision_safe(candidate_visual),
    }


def _forward_metrics(
    torch: Any,
    model: Any,
    tensors: Mapping[str, Any],
    positions: np.ndarray,
    *,
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    index = torch.as_tensor(positions, dtype=torch.long, device=tensors["query_views"].device)
    with torch.no_grad():
        outputs = model(tensors["query_views"][index], tensors["prototypes"])
        return trainer.compute_metrics(
            torch,
            outputs,
            family_labels=tensors["family_labels"][index],
            positive_mask=tensors["positive_mask"][index],
            preferred_mask=tensors["preferred_mask"][index],
            font_supervision_weights=tensors["font_weights"][index],
            single_day_body_negative=tensors["single_day_negative"][index],
            single_day_index=tuple(candidate_ids).index("single-day"),
            candidate_ids=candidate_ids,
        )


def _load_inputs(args: argparse.Namespace) -> tuple[Any, ...]:
    dataset_root = args.dataset_dir.expanduser().resolve()
    labels_root = args.labels_dir.expanduser().resolve()
    dataset_validation = overlay.validate_output(dataset_root)
    labels_validation = labels_artifact.validate_output(labels_root)
    dataset_manifest = _read_json(dataset_root / overlay.MANIFEST_FILE, "dataset manifest")
    label_manifest = _read_json(labels_root / labels_artifact.MANIFEST_FILE, "label manifest")
    rows = _read_jsonl(labels_root / labels_artifact.LABELS_FILE, "sealed labels")
    label_ids = tuple(str(row.get("sample_id", "")) for row in rows)
    val33_rows = _read_jsonl(args.val33_finals.expanduser().resolve(), "val33 finals")
    val33_ids = tuple(str(row.get("sample_id", "")) for row in val33_rows)
    if len(val33_ids) != 33 or len(set(val33_ids)) != 33 or "" in val33_ids:
        raise TargetedCorrectionError("val33 identity count drifted")
    dataset_path = dataset_root / overlay.DATASET_FILE
    try:
        with np.load(dataset_path, allow_pickle=False) as archive:
            arrays = {name: archive[name] for name in archive.files}
    except (OSError, ValueError) as error:
        raise TargetedCorrectionError("r5 dataset NPZ could not be loaded") from error
    inventory = trainer.validate_training_arrays(
        arrays, candidate_count=len(arrays["candidate_ids"])
    )
    boundary = validate_high_value_boundary(
        arrays,
        label_ids=label_ids,
        label_manifest=label_manifest,
        dataset_manifest=dataset_manifest,
        val33_ids=val33_ids,
    )
    sample_ids = np.asarray(arrays["sample_ids"]).astype(str)
    split = np.asarray(arrays["split"]).astype(np.int64)
    authorities = np.asarray(arrays["font_authority"]).astype(str)
    val33_mask = np.isin(sample_ids, val33_ids)
    if int(val33_mask.sum()) != 33 or np.any(split[val33_mask] != 1):
        raise TargetedCorrectionError("val33 escaped the r3 validation split")
    selection = np.flatnonzero((split == 1) & ~val33_mask)
    visual_selection = np.flatnonzero((split == 1) & ~val33_mask & (authorities == "visual"))
    high_value = np.asarray(boundary["high_value_positions"], dtype=np.int64)
    replay = np.flatnonzero((split == 0) & ~np.isin(np.arange(len(split)), high_value))
    if (
        len(selection) != inventory["val_rows"] - 33
        or not len(visual_selection)
        or len(replay) != inventory["train_rows"] - len(high_value)
        or set(high_value.tolist()).intersection(replay.tolist())
    ):
        raise TargetedCorrectionError("selection/replay partitions drifted")
    return (
        arrays,
        inventory,
        boundary,
        dataset_validation,
        labels_validation,
        label_manifest,
        dataset_manifest,
        val33_ids,
        selection,
        visual_selection,
        high_value,
        replay,
    )


def _build_model(
    torch: Any,
    *,
    candidate_ids: Sequence[str],
    teacher_dir: Path,
    source_query_head: Path,
    device: Any,
) -> tuple[Any, Mapping[str, Any], Mapping[str, Any]]:
    teacher_manifest = _read_json(
        teacher_dir.expanduser().resolve() / trainer.MANIFEST_FILE, "teacher manifest"
    )
    architecture = teacher_manifest.get("architecture")
    if not isinstance(architecture, Mapping):
        raise TargetedCorrectionError("teacher architecture is absent")
    model = trainer.build_role_family_adapter(
        torch,
        candidate_count=len(candidate_ids),
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    ).to(device)
    expected_architecture = trainer.adapter_architecture_contract(
        candidate_count=len(candidate_ids),
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    binding = trainer.initialize_adapter_from_artifact(
        torch,
        model,
        teacher_dir,
        candidate_ids=candidate_ids,
        source_query_head=source_query_head,
        expected_architecture=expected_architecture,
    )
    if binding is None:
        raise TargetedCorrectionError("r3h teacher initialization was not bound")
    return model, expected_architecture, binding


def _tensorize(torch: Any, arrays: Mapping[str, np.ndarray], device: Any) -> Mapping[str, Any]:
    return {
        "eligible_mask": torch.from_numpy(arrays["candidate_eligible_mask"].astype(np.bool_, copy=False)).to(device),
        "family_labels": torch.from_numpy(arrays["family_labels"].astype(np.int64, copy=False)).to(device),
        "family_weights": torch.from_numpy(arrays["family_label_weights"].astype(np.float32, copy=False)).to(device),
        "font_weights": torch.from_numpy(arrays["font_supervision_weights"].astype(np.float32, copy=False)).to(device),
        "positive_mask": torch.from_numpy(arrays["positive_mask"].astype(np.bool_, copy=False)).to(device),
        "preferred_mask": torch.from_numpy(arrays["preferred_mask"].astype(np.bool_, copy=False)).to(device),
        "prototypes": torch.from_numpy(arrays["prototype_queries"].astype(np.float32, copy=False)).to(device),
        "query_views": torch.from_numpy(arrays["query_views"].astype(np.float32, copy=False)).to(device),
        "single_day_negative": torch.from_numpy(arrays["single_day_body_negative"].astype(np.bool_, copy=False)).to(device),
    }


def _teacher_outputs(
    torch: Any, model: Any, tensors: Mapping[str, Any], rows: int, batch_size: int
) -> Mapping[str, Any]:
    result = {
        "body_candidate_scores": [],
        "variant_candidate_scores": [],
        "family_logits": [],
    }
    model.eval()
    with torch.no_grad():
        for start in range(0, rows, batch_size):
            outputs = model(
                tensors["query_views"][start : start + batch_size], tensors["prototypes"]
            )
            for name in result:
                result[name].append(outputs[name].detach())
    return {name: torch.cat(values, dim=0) for name, values in result.items()}


def _training_configuration(teacher_manifest: Mapping[str, Any]) -> Mapping[str, float]:
    values = teacher_manifest.get("configuration")
    if not isinstance(values, Mapping):
        raise TargetedCorrectionError("teacher training configuration is absent")
    required = (
        "bias_l2_weight",
        "candidate_distribution_slack",
        "candidate_distribution_temperature",
        "candidate_distribution_weight",
        "family_weight",
        "sample_residual_l2_weight",
        "single_day_hard_negative_margin",
        "single_day_hard_negative_weight",
        "supervised_single_day_hard_negative_weight",
        "weight_decay",
    )
    if any(key not in values or not math.isfinite(float(values[key])) for key in required):
        raise TargetedCorrectionError("teacher training configuration drifted")
    return {key: float(values[key]) for key in required}


def _trial(
    torch: Any,
    *,
    initial_state: Mapping[str, Any],
    model_template: Any,
    tensors: Mapping[str, Any],
    teacher_outputs: Mapping[str, Any],
    candidate_ids: Sequence[str],
    high_value: np.ndarray,
    replay: np.ndarray,
    selection: np.ndarray,
    visual_selection: np.ndarray,
    teacher_all: Mapping[str, Any],
    teacher_visual: Mapping[str, Any],
    high_value_weight: float,
    anchor_weight: float,
    epochs: int,
    high_value_batch_size: int,
    learning_rate: float,
    maximum_drop: float,
    configuration: Mapping[str, float],
    seed: int,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    model = copy.deepcopy(model_template)
    model.load_state_dict(initial_state, strict=True)
    model.train()
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=configuration["weight_decay"]
    )
    generator = np.random.default_rng(seed)
    history: list[Mapping[str, Any]] = []
    best_state: dict[str, Any] | None = None
    best_record: Mapping[str, Any] | None = None
    best_key: tuple[float, ...] | None = None
    device = tensors["query_views"].device
    single_day_index = tuple(candidate_ids).index("single-day")
    for epoch in range(1, epochs + 1):
        model.train()
        hv_chunks = np.array_split(
            generator.permutation(high_value),
            max(1, math.ceil(len(high_value) / high_value_batch_size)),
        )
        replay_chunks = np.array_split(generator.permutation(replay), len(hv_chunks))
        losses: list[Mapping[str, float]] = []
        for hv_values, replay_values in zip(hv_chunks, replay_chunks, strict=True):
            hv_index = torch.as_tensor(hv_values, dtype=torch.long, device=device)
            replay_index = torch.as_tensor(replay_values, dtype=torch.long, device=device)
            optimizer.zero_grad(set_to_none=True)
            hv_outputs = model(tensors["query_views"][hv_index], tensors["prototypes"])
            hv_loss, hv_parts = trainer.role_family_training_loss(
                torch,
                hv_outputs,
                family_labels=tensors["family_labels"][hv_index],
                positive_mask=tensors["positive_mask"][hv_index],
                preferred_mask=tensors["preferred_mask"][hv_index],
                candidate_eligible_mask=tensors["eligible_mask"][hv_index],
                font_supervision_weights=tensors["font_weights"][hv_index],
                candidate_loss_weights=tensors["font_weights"][hv_index],
                family_label_weights=tensors["family_weights"][hv_index],
                single_day_body_negative=tensors["single_day_negative"][hv_index],
                single_day_index=single_day_index,
                family_weight=configuration["family_weight"],
                hard_negative_weight=configuration["single_day_hard_negative_weight"],
                hard_negative_margin=configuration["single_day_hard_negative_margin"],
                bias_l2_weight=configuration["bias_l2_weight"],
                candidate_distribution_weight=configuration["candidate_distribution_weight"],
                candidate_distribution_slack=configuration["candidate_distribution_slack"],
                candidate_distribution_temperature=configuration[
                    "candidate_distribution_temperature"
                ],
                sample_residual_l2_weight=configuration["sample_residual_l2_weight"],
                supervised_single_day_hard_negative_weight=configuration[
                    "supervised_single_day_hard_negative_weight"
                ],
            )
            replay_outputs = model(
                tensors["query_views"][replay_index], tensors["prototypes"]
            )
            replay_teacher = {
                name: values[replay_index] for name, values in teacher_outputs.items()
            }
            anchor_loss, anchor_parts = anchor_distillation_loss(
                torch, replay_outputs, replay_teacher
            )
            loss = high_value_weight * hv_loss + anchor_weight * anchor_loss
            if not bool(torch.isfinite(loss)):
                raise TargetedCorrectionError("targeted correction loss became non-finite")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(
                {
                    "anchor": float(anchor_loss.detach().cpu()),
                    "anchor_body_mse": float(anchor_parts["body_mse"].detach().cpu()),
                    "anchor_family_kl": float(anchor_parts["family_kl"].detach().cpu()),
                    "anchor_variant_mse": float(anchor_parts["variant_mse"].detach().cpu()),
                    "high_value": float(hv_loss.detach().cpu()),
                    "high_value_candidate": float(hv_parts["candidate"].detach().cpu()),
                    "total": float(loss.detach().cpu()),
                }
            )
        model.eval()
        all_metrics = _forward_metrics(
            torch, model, tensors, selection, candidate_ids=candidate_ids
        )
        visual_metrics = _forward_metrics(
            torch, model, tensors, visual_selection, candidate_ids=candidate_ids
        )
        checks = retention_checks(
            all_metrics,
            visual_metrics,
            teacher_all,
            teacher_visual,
            maximum_drop=maximum_drop,
        )
        score = selection_score(all_metrics, visual_metrics)
        record = {
            "epoch": epoch,
            "loss": {
                key: float(np.mean([value[key] for value in losses])) for key in losses[0]
            },
            "retention_checks": checks,
            "retention_passed": all(checks.values()),
            "selection_metrics": compact_metrics(all_metrics),
            "selection_score": score,
            "visual_selection_metrics": compact_metrics(visual_metrics),
        }
        history.append(record)
        key = (
            float(all(checks.values())),
            score,
            float(all_metrics["acceptable_at1"]),
            float(visual_metrics["acceptable_at1"]),
            -float(record["loss"]["anchor"]),
        )
        if best_key is None or key > best_key:
            best_key = key
            best_record = record
            best_state = {
                name: value.detach().cpu().clone() for name, value in model.state_dict().items()
            }
    if best_state is None or best_record is None:
        raise TargetedCorrectionError("trial did not produce a selectable epoch")
    return (
        {
            "anchor_weight": anchor_weight,
            "best_epoch": best_record,
            "high_value_weight": high_value_weight,
            "history": history,
            "trial_id": f"hv{high_value_weight:g}-anchor{anchor_weight:g}",
        },
        best_state,
    )


def run(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise TargetedCorrectionError("torch and safetensors are required") from error
    (
        arrays,
        inventory,
        boundary,
        dataset_validation,
        labels_validation,
        label_manifest,
        dataset_manifest,
        val33_ids,
        selection,
        visual_selection,
        high_value,
        replay,
    ) = _load_inputs(args)
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise TargetedCorrectionError("CUDA was requested but is unavailable")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    teacher, architecture, teacher_binding = _build_model(
        torch,
        candidate_ids=candidate_ids,
        teacher_dir=args.teacher_adapter_dir,
        source_query_head=args.source_query_head,
        device=device,
    )
    teacher_manifest = _read_json(
        args.teacher_adapter_dir.expanduser().resolve() / trainer.MANIFEST_FILE,
        "teacher manifest",
    )
    configuration = _training_configuration(teacher_manifest)
    tensors = _tensorize(torch, arrays, device)
    teacher.eval()
    teacher_outputs = _teacher_outputs(
        torch, teacher, tensors, len(arrays["sample_ids"]), args.teacher_batch_size
    )
    teacher_all = _forward_metrics(
        torch, teacher, tensors, selection, candidate_ids=candidate_ids
    )
    teacher_visual = _forward_metrics(
        torch, teacher, tensors, visual_selection, candidate_ids=candidate_ids
    )
    teacher_high_value = _forward_metrics(
        torch, teacher, tensors, high_value, candidate_ids=candidate_ids
    )
    initial_state = {
        name: value.detach().cpu().clone() for name, value in teacher.state_dict().items()
    }
    model_template = copy.deepcopy(teacher)
    del teacher
    started = time.monotonic()
    trials: list[Mapping[str, Any]] = []
    trial_states: list[Mapping[str, Any]] = []
    for high_value_weight in args.high_value_weights:
        for anchor_weight in args.anchor_weights:
            result, state = _trial(
                torch,
                initial_state=initial_state,
                model_template=model_template,
                tensors=tensors,
                teacher_outputs=teacher_outputs,
                candidate_ids=candidate_ids,
                high_value=high_value,
                replay=replay,
                selection=selection,
                visual_selection=visual_selection,
                teacher_all=teacher_all,
                teacher_visual=teacher_visual,
                high_value_weight=high_value_weight,
                anchor_weight=anchor_weight,
                epochs=args.epochs,
                high_value_batch_size=args.high_value_batch_size,
                learning_rate=args.learning_rate,
                maximum_drop=args.maximum_retention_drop,
                configuration=configuration,
                seed=args.seed + len(trials) + 1,
            )
            trials.append(result)
            trial_states.append(state)
    ranked = sorted(
        range(len(trials)),
        key=lambda index: (
            float(trials[index]["best_epoch"]["retention_passed"]),
            float(trials[index]["best_epoch"]["selection_score"]),
        ),
        reverse=True,
    )
    selected_index = ranked[0]
    selected_trial = trials[selected_index]
    selected_state = trial_states[selected_index]
    selected_model = copy.deepcopy(model_template)
    selected_model.load_state_dict(selected_state, strict=True)
    selected_model.eval()
    selected_high_value = _forward_metrics(
        torch, selected_model, tensors, high_value, candidate_ids=candidate_ids
    )
    teacher_score = selection_score(teacher_all, teacher_visual)
    selected_score = float(selected_trial["best_epoch"]["selection_score"])
    high_value_improved = (
        float(selected_high_value["acceptable_at1"])
        > float(teacher_high_value["acceptable_at1"])
        and float(selected_high_value["preferred_at1"])
        > float(teacher_high_value["preferred_at1"])
    )
    # New-358 fit is diagnostic and is deliberately absent from this decision.
    accepted = bool(selected_trial["best_epoch"]["retention_passed"]) and (
        selected_score > teacher_score
    )
    # Val33 identities were used only to remove the cohort from selection. Its
    # metrics are deliberately materialized only after every trial/epoch is ranked.
    sample_ids = np.asarray(arrays["sample_ids"]).astype(str)
    val33_positions = np.flatnonzero(np.isin(sample_ids, val33_ids))
    teacher_for_diagnostic = copy.deepcopy(model_template)
    teacher_for_diagnostic.load_state_dict(initial_state, strict=True)
    teacher_for_diagnostic.eval()
    teacher_val33 = _forward_metrics(
        torch, teacher_for_diagnostic, tensors, val33_positions, candidate_ids=candidate_ids
    )
    selected_val33 = _forward_metrics(
        torch, selected_model, tensors, val33_positions, candidate_ids=candidate_ids
    )
    output = args.output_dir.expanduser().resolve()
    if output.exists() or output.is_symlink():
        raise TargetedCorrectionError("output already exists; use a unique ablation path")
    if output in {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}:
        raise TargetedCorrectionError("unsafe output path")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        files = {MANIFEST_FILE, REPORT_FILE, MARKER_FILE}
        if accepted:
            checkpoint_state = {
                name: value.detach().cpu().contiguous() for name, value in selected_state.items()
            }
            save_file(checkpoint_state, str(staging / CHECKPOINT_FILE))
            files.add(CHECKPOINT_FILE)
        report = trainer.seal_record(
            {
                "acceptance": {
                    "accepted_as_interpolation_candidate": accepted,
                    "high_value_fit_improved": high_value_improved,
                    "selected_score": selected_score,
                    "strictly_beats_r3h_selection_score": selected_score > teacher_score,
                    "teacher_score": teacher_score,
                },
                "boundaries": {
                    "blind_qa_master_val33_overlap": dict(boundary["overlap"]),
                    "high_value_rows": len(high_value),
                    "high_value_train_only": True,
                    "replay_rows": len(replay),
                    "selection_rows_excluding_val33": len(selection),
                    "selection_used_high_value_fit": False,
                    "selection_used_val33": False,
                    "val33_diagnostic_computed_after_selection": True,
                    "val33_identities_used_for_exclusion_only": True,
                    "val33_rows": len(val33_positions),
                    "visual_selection_rows_excluding_val33": len(visual_selection),
                },
                "configuration": {
                    "anchor_weights": list(args.anchor_weights),
                    "epochs": args.epochs,
                    "high_value_weights": list(args.high_value_weights),
                    "learning_rate": args.learning_rate,
                    "maximum_retention_drop": args.maximum_retention_drop,
                    "teacher_loss_configuration": configuration,
                },
                "diagnostic_after_selection": {
                    "selected_val33": compact_metrics(selected_val33),
                    "teacher_val33": compact_metrics(teacher_val33),
                },
                "record_type": "manga_font_v2_targeted_correction_ablation_report",
                "schema_version": SCHEMA_VERSION,
                "selected": {
                    **selected_trial,
                    "high_value_fit": compact_metrics(selected_high_value),
                },
                "teacher": {
                    "high_value_fit": compact_metrics(teacher_high_value),
                    "selection_metrics": compact_metrics(teacher_all),
                    "selection_score": teacher_score,
                    "visual_selection_metrics": compact_metrics(teacher_visual),
                },
                "training_seconds": time.monotonic() - started,
                "trials": trials,
            }
        )
        (staging / REPORT_FILE).write_bytes(trainer.json_bytes(report, pretty=True))
        artifact_descriptors = {
            REPORT_FILE: _descriptor(staging / REPORT_FILE, file=REPORT_FILE)
        }
        if accepted:
            artifact_descriptors[CHECKPOINT_FILE] = _descriptor(
                staging / CHECKPOINT_FILE, file=CHECKPOINT_FILE
            )
        manifest = trainer.seal_record(
            {
                "architecture": architecture,
                "artifacts": artifact_descriptors,
                "authority": {
                    "automatic_release_authority": False,
                    "calibration_authority": False,
                    "evaluation_authority": False,
                    "export_allowed": False,
                    "human_gold": False,
                    "interpolation_candidate_available": accepted,
                    "training_only_experiment": True,
                },
                "candidate_ids": list(candidate_ids),
                "dataset": {
                    **dataset_validation,
                    "manifest": _descriptor(args.dataset_dir / overlay.MANIFEST_FILE),
                },
                "high_value_labels": {
                    **labels_validation,
                    "manifest": _descriptor(args.labels_dir / labels_artifact.MANIFEST_FILE),
                    "sample_ids_sha256": boundary["high_value_sample_ids_sha256"],
                },
                "record_type": "manga_font_v2_targeted_correction_ablation_manifest",
                "schema_version": SCHEMA_VERSION,
                "selected_trial": selected_trial["trial_id"],
                "status": "candidate_retained" if accepted else "discarded_no_r3h_improvement",
                "teacher": teacher_binding,
                "val33_finals": _descriptor(args.val33_finals.expanduser().resolve()),
            }
        )
        (staging / MANIFEST_FILE).write_bytes(trainer.json_bytes(manifest, pretty=True))
        marker_artifacts = {
            name: trainer.sha256_file(staging / name) for name in sorted(files - {MARKER_FILE})
        }
        marker = trainer.seal_record(
            {
                "artifacts": marker_artifacts,
                "owner": OWNER,
                "safe_replace": False,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise TargetedCorrectionError("ablation output is absent or symlinked")
    names = {path.name for path in root.iterdir()}
    minimum = {MARKER_FILE, MANIFEST_FILE, REPORT_FILE}
    if names not in (minimum, minimum | {CHECKPOINT_FILE}) or any(
        path.is_symlink() or not path.is_file() for path in root.iterdir()
    ):
        raise TargetedCorrectionError("ablation exact inventory drifted")
    marker = _read_json(root / MARKER_FILE, "marker")
    manifest = _read_json(root / MANIFEST_FILE, "manifest")
    report = _read_json(root / REPORT_FILE, "report")
    trainer.validate_record_seal(marker, "marker")
    trainer.validate_record_seal(manifest, "manifest")
    trainer.validate_record_seal(report, "report")
    authority = manifest.get("authority")
    accepted = bool(report.get("acceptance", {}).get("accepted_as_interpolation_candidate"))
    expected_files = names - {MARKER_FILE}
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not False
        or set(marker.get("artifacts", {})) != expected_files
        or any(
            marker["artifacts"].get(name) != trainer.sha256_file(root / name)
            for name in expected_files
        )
        or not isinstance(authority, Mapping)
        or authority.get("automatic_release_authority") is not False
        or authority.get("export_allowed") is not False
        or authority.get("human_gold") is not False
        or authority.get("training_only_experiment") is not True
        or authority.get("interpolation_candidate_available") is not accepted
        or (CHECKPOINT_FILE in names) is not accepted
    ):
        raise TargetedCorrectionError("ablation authority or marker drifted")
    boundaries = report.get("boundaries")
    if (
        not isinstance(boundaries, Mapping)
        or boundaries.get("selection_used_val33") is not False
        or boundaries.get("selection_used_high_value_fit") is not False
        or boundaries.get("val33_diagnostic_computed_after_selection") is not True
        or boundaries.get("val33_identities_used_for_exclusion_only") is not True
        or boundaries.get("val33_rows") != 33
        or boundaries.get("high_value_train_only") is not True
        or boundaries.get("high_value_rows") != 358
        or boundaries.get("blind_qa_master_val33_overlap")
        != {key: 0 for key in EXPECTED_OVERLAP_KEYS}
    ):
        raise TargetedCorrectionError("ablation leakage boundary drifted")
    return {
        "accepted_as_interpolation_candidate": accepted,
        "checkpoint": str(root / CHECKPOINT_FILE) if accepted else None,
        "high_value_rows": boundaries["high_value_rows"],
        "output_dir": str(root),
        "selected_trial": manifest.get("selected_trial"),
        "status": manifest.get("status"),
        "val33_diagnostic_only": True,
    }


def _parse_float_list(value: str) -> tuple[float, ...]:
    try:
        result = tuple(float(item.strip()) for item in value.split(",") if item.strip())
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected comma-separated floats") from error
    if not result or any(not math.isfinite(item) or item <= 0 for item in result):
        raise argparse.ArgumentTypeError("weights must be finite and positive")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--dataset-dir", type=Path, required=True)
    run_parser.add_argument("--labels-dir", type=Path, required=True)
    run_parser.add_argument("--teacher-adapter-dir", type=Path, required=True)
    run_parser.add_argument("--source-query-head", type=Path, required=True)
    run_parser.add_argument("--val33-finals", type=Path, required=True)
    run_parser.add_argument("--output-dir", type=Path, required=True)
    run_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    run_parser.add_argument("--epochs", type=int, default=4)
    run_parser.add_argument("--high-value-weights", type=_parse_float_list, default=(2.0, 4.0))
    run_parser.add_argument("--anchor-weights", type=_parse_float_list, default=(0.5, 2.0))
    run_parser.add_argument("--learning-rate", type=float, default=4e-4)
    run_parser.add_argument("--high-value-batch-size", type=int, default=128)
    run_parser.add_argument("--teacher-batch-size", type=int, default=512)
    run_parser.add_argument("--maximum-retention-drop", type=float, default=0.005)
    run_parser.add_argument("--seed", type=int, default=20260811)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "run":
            if (
                not 2 <= args.epochs <= 6
                or len(args.high_value_weights) != 2
                or len(args.anchor_weights) != 2
                or args.learning_rate <= 0
                or args.high_value_batch_size < 1
                or args.teacher_batch_size < 1
                or not 0 <= args.maximum_retention_drop <= 0.02
            ):
                raise TargetedCorrectionError("ablation configuration is outside the bounded grid")
            result = run(args)
        else:
            result = validate_output(args.output_dir)
    except (
        TargetedCorrectionError,
        labels_artifact.HighValueLabelsError,
        overlay.HighValueOverlayError,
        trainer.MangaFontV8RoleFamilyError,
    ) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
