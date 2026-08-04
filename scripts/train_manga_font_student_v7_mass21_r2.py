#!/usr/bin/env python3
"""Run MangaFont mass21 round 2 with fixed global work weighting.

This is deliberately a separate runner.  The completed v7 baseline remains an
immutable provenance surface; r2 imports its data/runtime/checkpoint machinery
and changes only the weighting contract:

* inverse-work weights are normalized once over all 19,664 train rows;
* consistency and pseudo losses use the configured real batch size as a fixed
  denominator, including the final short batch;
* pseudo confidence remains an absolute multiplicative weight; and
* the domain-moment regularizer uses the ordinary unweighted real batch.

The runner is standalone and temporarily installs its overrides into the
imported v7 module only for the duration of one command.  A separately running
v7 baseline process is unaffected.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_student_v7_mass21 as v7
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v7_mass21 as v7


SCHEMA = "manga-font-student-v7-mass21-r2-v1"
OWNER = "carrot-manga-translator/manga-font-student-v7-mass21-r2-v1"
MARKER = ".manga-font-student-v7-mass21-r2-v1-owned.json"
RUN_STATE_SCHEMA = "manga-font-student-v7-mass21-r2-run-state-v1"
RUN_STATE_MARKER = ".manga-font-student-v7-mass21-r2-run-state-owned.json"
RUN_STATE_CHECKPOINT_A = "checkpoint-a.pt"
RUN_STATE_CHECKPOINT_B = "checkpoint-b.pt"
RUN_STATE_MARKER_A = "checkpoint-a.json"
RUN_STATE_MARKER_B = "checkpoint-b.json"
WORK_NORMALIZATION_ID = "global_fixed_work_normalization"
PSEUDO_CONFIDENCE_MODE = "absolute_multiplicative"
DOMAIN_MOMENT_MODE = "unweighted_ordinary_batch_moment"
REAL_DENOMINATOR_MODE = "configured_real_batch_size"
EXPECTED_TRAIN_WORKS = 15

OUTPUT_FILES = frozenset(
    {
        MARKER,
        v7.MANIFEST,
        v7.HISTORY,
        v7.BEST_HEAD,
        v7.PROTOTYPES,
        v7.PREDICTIONS,
        v7.LATEST_CHECKPOINT,
    }
)
RUN_STATE_FILES = frozenset(
    {
        RUN_STATE_CHECKPOINT_A,
        RUN_STATE_CHECKPOINT_B,
        RUN_STATE_MARKER_A,
        RUN_STATE_MARKER_B,
    }
)


class MangaFontV7Mass21R2Error(v7.MangaFontV7Mass21Error):
    """Raised when the r2 weighting or provenance contract drifts."""


@dataclass(frozen=True)
class GlobalWorkNormalization:
    sample_count: int
    work_count: int
    raw_weight_sum: float
    scale: float
    normalized_weight_mean: float
    normalized_weight_min: float
    normalized_weight_max: float

    def as_manifest(self) -> dict[str, Any]:
        return {
            "id": WORK_NORMALIZATION_ID,
            "normalized_weight_max": self.normalized_weight_max,
            "normalized_weight_mean": self.normalized_weight_mean,
            "normalized_weight_min": self.normalized_weight_min,
            "raw_weight_sum": self.raw_weight_sum,
            "sample_count": self.sample_count,
            "scale": self.scale,
            "work_count": self.work_count,
        }


_BASE_OPEN_TRAINING_BATCH = v7._open_training_batch  # noqa: SLF001
_BASE_VALIDATE_OUTPUT = v7.validate_output
_BASE_CONFIGURATION = v7._configuration  # noqa: SLF001
_NORMALIZATION_CACHE: dict[tuple[str, int], GlobalWorkNormalization] = {}


def _configuration(args: argparse.Namespace) -> dict[str, Any]:
    configuration = dict(_BASE_CONFIGURATION(args))
    configuration.update(
        {
            "domain_moment_mode": DOMAIN_MOMENT_MODE,
            "pseudo_confidence_mode": PSEUDO_CONFIDENCE_MODE,
            "real_loss_denominator": REAL_DENOMINATOR_MODE,
            "work_normalization": WORK_NORMALIZATION_ID,
        }
    )
    return configuration


def _configuration_sha256(args: argparse.Namespace) -> str:
    return v7.base.sha256_bytes(
        v7.base.canonical_json(_configuration(args)).encode("utf-8")
    )


def global_work_normalization(
    entries: Sequence[v7.mass21.RealTrainIndexEntry],
    *,
    expected_work_count: int = EXPECTED_TRAIN_WORKS,
) -> GlobalWorkNormalization:
    if not entries:
        raise MangaFontV7Mass21R2Error("global work normalization has no rows")
    counts = Counter(entry.work_id for entry in entries)
    if len(counts) != expected_work_count:
        raise MangaFontV7Mass21R2Error(
            f"global work count drifted: {len(counts)} != {expected_work_count}"
        )
    raw_weights = [float(entry.work_weight) for entry in entries]
    if any(not math.isfinite(value) or value <= 0.0 for value in raw_weights):
        raise MangaFontV7Mass21R2Error("global work weights must be finite and positive")
    for entry in entries:
        expected = 1.0 / counts[entry.work_id]
        if not math.isclose(
            float(entry.work_weight), expected, rel_tol=0.0, abs_tol=1e-9
        ):
            raise MangaFontV7Mass21R2Error(
                f"{entry.work_id}: inverse-work source weight drifted"
            )
    raw_sum = math.fsum(raw_weights)
    if not math.isclose(
        raw_sum, float(expected_work_count), rel_tol=0.0, abs_tol=1e-6
    ):
        raise MangaFontV7Mass21R2Error("inverse-work effective count drifted")
    scale = len(entries) / raw_sum
    normalized = [value * scale for value in raw_weights]
    normalized_mean = math.fsum(normalized) / len(normalized)
    if not math.isclose(normalized_mean, 1.0, rel_tol=0.0, abs_tol=1e-9):
        raise MangaFontV7Mass21R2Error("global normalized work mean drifted")
    return GlobalWorkNormalization(
        sample_count=len(entries),
        work_count=len(counts),
        raw_weight_sum=raw_sum,
        scale=scale,
        normalized_weight_mean=normalized_mean,
        normalized_weight_min=min(normalized),
        normalized_weight_max=max(normalized),
    )


def _normalization_for_inputs(
    inputs: v7.mass21.Mass21TrainingInputs,
) -> GlobalWorkNormalization:
    key = (inputs.real.manifest_sha256, len(inputs.real.entries))
    result = _NORMALIZATION_CACHE.get(key)
    if result is None:
        result = global_work_normalization(inputs.real.entries)
        _NORMALIZATION_CACHE[key] = result
    return result


def _nominal_real_batch_size(inputs: v7.mass21.Mass21TrainingInputs) -> int:
    if not inputs.epoch_batches:
        raise MangaFontV7Mass21R2Error("r2 epoch schedule is empty")
    result = max(len(batch.real_indices) for batch in inputs.epoch_batches)
    if result < 1:
        raise MangaFontV7Mass21R2Error("r2 nominal real batch is empty")
    return result


def _open_training_batch(**kwargs: Any) -> dict[str, Any]:
    inputs = kwargs.get("inputs")
    if not isinstance(inputs, v7.mass21.Mass21TrainingInputs):
        raise MangaFontV7Mass21R2Error("r2 training inputs are missing")
    prepared = dict(_BASE_OPEN_TRAINING_BATCH(**kwargs))
    normalization = _normalization_for_inputs(inputs)
    prepared["real_weights"] = prepared["real_weights"] * normalization.scale
    if prepared["pseudo_weights"] is not None:
        prepared["pseudo_weights"] = (
            prepared["pseudo_weights"] * normalization.scale
        )
    prepared["real_loss_denominator"] = _nominal_real_batch_size(inputs)
    return prepared


def _weighted_three_view_consistency_loss(
    torch: Any,
    view_embeddings: Any,
    row_weights: Any,
    *,
    denominator: int,
) -> Any:
    if (
        view_embeddings.ndim != 4
        or view_embeddings.shape[1] != len(v7.base.VIEW_NAMES)
        or row_weights.ndim != 1
        or row_weights.shape[0] != view_embeddings.shape[0]
        or denominator < view_embeddings.shape[0]
        or denominator < 1
    ):
        raise MangaFontV7Mass21R2Error("r2 consistency tensor contract drifted")
    center = torch.nn.functional.normalize(
        view_embeddings.float().mean(dim=1), p=2, dim=-1
    )
    similarity = (view_embeddings.float() * center[:, None]).sum(dim=-1)
    per_row = (1.0 - similarity).mean(dim=(1, 2))
    weights = row_weights.float()
    if not bool(torch.isfinite(weights).all()) or bool(torch.any(weights < 0.0)):
        raise MangaFontV7Mass21R2Error("r2 consistency weights are invalid")
    return (per_row * weights).sum() / float(denominator)


def absolute_pseudo_soft_target_loss(
    torch: Any,
    logits: Any,
    targets: Any,
    weights: Any,
    *,
    denominator: int,
) -> Any:
    if (
        logits.ndim != 2
        or logits.shape != targets.shape
        or weights.ndim != 1
        or weights.shape[0] != logits.shape[0]
        or logits.shape[1] != v7.mass21.ACTIVE_CANDIDATE_COUNT
        or denominator < logits.shape[0]
        or denominator < 1
    ):
        raise MangaFontV7Mass21R2Error("r2 pseudo tensor contract drifted")
    if logits.shape[0] == 0:
        return logits.sum() * 0.0
    target_values = targets.float()
    row_weights = weights.float()
    if (
        not bool(torch.isfinite(target_values).all())
        or not bool(torch.isfinite(row_weights).all())
        or bool(torch.any(row_weights < 0.0))
        or not bool(
            torch.allclose(
                target_values.sum(dim=-1),
                torch.ones(logits.shape[0], device=logits.device),
                atol=1e-5,
                rtol=0.0,
            )
        )
    ):
        raise MangaFontV7Mass21R2Error("r2 pseudo values are invalid")
    per_row = -(
        target_values * torch.log_softmax(logits.float(), dim=-1)
    ).sum(dim=-1)
    return (per_row * row_weights).sum() / float(denominator)


def _compute_losses(
    *,
    torch: Any,
    result: Mapping[str, Any],
    batch: Mapping[str, Any],
    weights: v7.LossWeights,
) -> tuple[Any, dict[str, Any]]:
    real_count = int(batch["real_count"])
    full_count = int(batch["full_count"])
    partial_count = int(batch["partial_count"])
    synthetic_count = int(batch["synthetic_count"])
    denominator = int(batch["real_loss_denominator"])
    full_start = real_count
    partial_start = full_start + full_count
    synthetic_start = partial_start + partial_count
    logits = result["candidate_scores"]
    views = result["view_embeddings"]
    expected_rows = real_count + full_count + partial_count + synthetic_count
    if logits.shape != (expected_rows, v7.mass21.ACTIVE_CANDIDATE_COUNT):
        raise MangaFontV7Mass21R2Error("r2 active21 score shape drifted")

    synthetic_loss = torch.nn.functional.cross_entropy(
        logits[synthetic_start:], batch["synthetic_labels"]
    )
    full_loss = v7.mass21.masked_human_loss(
        torch,
        logits[full_start:partial_start],
        batch["full_targets"],
        batch["full_masks"],
    )
    partial_loss = v7.mass21.masked_human_loss(
        torch,
        logits[partial_start:synthetic_start],
        batch["partial_targets"],
        batch["partial_masks"],
    )
    real_consistency = _weighted_three_view_consistency_loss(
        torch,
        views[:real_count],
        batch["real_weights"],
        denominator=denominator,
    )
    domain = v7.mass21.domain_moment_loss(
        torch,
        views[:real_count],
        views[synthetic_start:],
        real_weights=None,
    )
    diversity = v7.v6.attention_diversity_loss(torch, result["attention"])
    if batch["pseudo_targets"] is None:
        pseudo = logits.sum() * 0.0
        pseudo_rows = 0
    else:
        pseudo_logits = logits[:real_count].index_select(
            0, batch["pseudo_positions"]
        )
        pseudo = absolute_pseudo_soft_target_loss(
            torch,
            pseudo_logits,
            batch["pseudo_targets"],
            batch["pseudo_weights"],
            denominator=denominator,
        )
        pseudo_rows = int(batch["pseudo_positions"].shape[0])
    total = (
        weights.synthetic * synthetic_loss
        + weights.full_human * full_loss
        + weights.partial_human * partial_loss
        + weights.real_consistency * real_consistency
        + weights.domain_moment * domain
        + weights.pseudo * pseudo
        + weights.attention_diversity * diversity
    )
    return total, {
        "attention_diversity": diversity,
        "domain_moment": domain,
        "full_human": full_loss,
        "partial_human": partial_loss,
        "pseudo": pseudo,
        "pseudo_rows": pseudo_rows,
        "real_consistency": real_consistency,
        "synthetic": synthetic_loss,
        "total": total,
    }


def _weighting_manifest(
    inputs: v7.mass21.Mass21TrainingInputs,
) -> dict[str, Any]:
    return {
        "domain_moment": DOMAIN_MOMENT_MODE,
        "pseudo_confidence": PSEUDO_CONFIDENCE_MODE,
        "real_loss_denominator": REAL_DENOMINATOR_MODE,
        "work": _normalization_for_inputs(inputs).as_manifest(),
    }


def _source_exposure_plan(
    args: argparse.Namespace,
    inputs: v7.mass21.Mass21TrainingInputs,
) -> dict[str, Any]:
    steps = len(inputs.epoch_batches)

    def cycled(count: int, batch_size: int) -> dict[str, Any]:
        slots = steps * batch_size
        if count < 1 or slots < count:
            raise MangaFontV7Mass21R2Error("r2 source exposure cannot cover its inventory")
        return {
            "batch_size": batch_size,
            "inventory_rows": count,
            "maximum_exposures_per_row": math.ceil(slots / count),
            "mean_exposures_per_row": slots / count,
            "minimum_exposures_per_row": slots // count,
            "slots_per_epoch": slots,
        }

    return {
        "epoch_steps": steps,
        "full_human": cycled(
            v7.mass21.SUPERVISED_FULL21_ROWS, args.full_human_batch_size
        ),
        "partial_human": cycled(
            v7.mass21.SUPERVISED_PARTIAL15_ROWS, args.partial_human_batch_size
        ),
        "real": {
            "batch_size": args.real_batch_size,
            "inventory_rows": len(inputs.real.entries),
            "maximum_exposures_per_row": 1,
            "mean_exposures_per_row": 1.0,
            "minimum_exposures_per_row": 1,
            "slots_per_epoch": len(inputs.real.entries),
        },
        "synthetic": cycled(
            v7.mass21.SYNTHETIC21_ROWS, args.synthetic_batch_size
        ),
    }


def _source_provenance() -> dict[str, str]:
    return {
        "base_v7_source_code_sha256": v7.base.sha256_file(Path(v7.__file__).resolve()),
        "r2_source_code_sha256": v7.base.sha256_file(Path(__file__).resolve()),
    }


def _checkpoint_payload(
    *,
    baseline_val: Mapping[str, Any],
    weighting: Mapping[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    payload = dict(v7._checkpoint_payload(**kwargs))  # noqa: SLF001
    payload.update(
        {
            "baseline_val": copy.deepcopy(dict(baseline_val)),
            "r2_source_provenance": _source_provenance(),
            "weighting": copy.deepcopy(dict(weighting)),
        }
    )
    return payload


def _run_state_slots() -> tuple[tuple[str, str], ...]:
    return (
        (RUN_STATE_CHECKPOINT_A, RUN_STATE_MARKER_A),
        (RUN_STATE_CHECKPOINT_B, RUN_STATE_MARKER_B),
    )


def _valid_run_state_slots(run_state_dir: Path) -> list[dict[str, Any]]:
    root = run_state_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        return []
    unexpected = {
        path.name
        for path in root.iterdir()
        if path.name not in RUN_STATE_FILES
        and not path.name.startswith(".r2-checkpoint-")
        and not path.name.startswith(".r2-marker-")
    }
    if unexpected:
        raise MangaFontV7Mass21R2Error(
            f"r2 run-state inventory drifted: {sorted(unexpected)}"
        )
    valid: list[dict[str, Any]] = []
    for checkpoint_name, marker_name in _run_state_slots():
        checkpoint = root / checkpoint_name
        marker_path = root / marker_name
        if not checkpoint.is_file() or checkpoint.is_symlink():
            continue
        if not marker_path.is_file() or marker_path.is_symlink():
            continue
        try:
            marker = v7.base.read_json(marker_path, location=f"r2 {marker_name}")
            generation = int(marker.get("generation", -1))
        except (OSError, TypeError, ValueError, v7.base.MangaFontStudentError):
            continue
        if (
            generation < 1
            or marker.get("owner") != OWNER
            or marker.get("safe_replace") is not True
            or marker.get("schema_version") != RUN_STATE_SCHEMA
            or marker.get("checkpoint_file") != checkpoint_name
            or marker.get("checkpoint_sha256") != v7.base.sha256_file(checkpoint)
        ):
            continue
        valid.append(
            {
                "checkpoint": checkpoint,
                "generation": generation,
                "marker": marker_path,
            }
        )
    return sorted(valid, key=lambda value: int(value["generation"]), reverse=True)


def _validate_run_state(run_state_dir: Path) -> dict[str, Any]:
    valid = _valid_run_state_slots(run_state_dir)
    if not valid:
        raise MangaFontV7Mass21R2Error("r2 has no valid atomic checkpoint slot")
    latest = valid[0]
    return {
        "checkpoint_file": latest["checkpoint"].name,
        "generation": latest["generation"],
        "marker_file": latest["marker"].name,
        "schema_version": RUN_STATE_SCHEMA,
        "valid_slot_count": len(valid),
    }


def _latest_checkpoint_path(run_state_dir: Path) -> Path:
    metadata = _validate_run_state(run_state_dir)
    return run_state_dir.expanduser().resolve() / str(metadata["checkpoint_file"])


def _atomic_fsync_bytes(path: Path, payload: bytes, *, prefix: str) -> None:
    descriptor, raw_name = tempfile.mkstemp(prefix=prefix, dir=path.parent)
    temporary = Path(raw_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _write_run_checkpoint(
    *,
    torch: Any,
    run_state_dir: Path,
    payload: Mapping[str, Any],
) -> None:
    root = v7._safe_directory(run_state_dir, location="run-state directory")  # noqa: SLF001
    root.mkdir(parents=True, exist_ok=True)
    valid = _valid_run_state_slots(root)
    generation = (int(valid[0]["generation"]) if valid else 0) + 1
    checkpoint_name, marker_name = _run_state_slots()[(generation - 1) % 2]
    checkpoint = root / checkpoint_name
    descriptor, raw_name = tempfile.mkstemp(prefix=".r2-checkpoint-", dir=root)
    temporary = Path(raw_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            torch.save(dict(payload), handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, checkpoint)
    finally:
        if temporary.exists():
            temporary.unlink()
    marker = {
        "checkpoint_file": checkpoint_name,
        "checkpoint_sha256": v7.base.sha256_file(checkpoint),
        "generation": generation,
        "owner": OWNER,
        "safe_replace": True,
        "schema_version": RUN_STATE_SCHEMA,
    }
    _atomic_fsync_bytes(
        root / marker_name,
        v7.base.json_bytes(marker, pretty=True),
        prefix=".r2-marker-",
    )


def _load_run_checkpoint(
    *,
    torch: Any,
    args: argparse.Namespace,
    run_state_dir: Path,
    source_fingerprint: Mapping[str, Any],
    candidate_ids: tuple[str, ...],
    device: Any,
) -> dict[str, Any]:
    checkpoint = _latest_checkpoint_path(run_state_dir)
    try:
        # Keep best-state/prototype tensors on CPU.  Loading the entire sealed
        # payload onto CUDA duplicates model state and makes a no-improvement
        # resume impossible to publish via ``Tensor.numpy()``.
        payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    except (OSError, RuntimeError, ValueError, TypeError) as error:
        raise MangaFontV7Mass21R2Error("cannot load r2 atomic checkpoint") from error
    record = dict(v7._mapping(payload, "r2 run checkpoint"))  # noqa: SLF001
    if (
        record.get("schema_version") != RUN_STATE_SCHEMA
        or tuple(record.get("candidate_ids", ())) != candidate_ids
        or record.get("configuration_sha256") != _configuration_sha256(args)
        or record.get("source_fingerprint") != dict(source_fingerprint)
    ):
        raise MangaFontV7Mass21R2Error("r2 resume checkpoint contract drifted")
    return record


def _validate_val_metric_values(metrics: Mapping[str, Any], *, location: str) -> None:
    if (
        int(metrics.get("evaluated_positive_rows", 0)) != v7.VAL_ROWS
        or int(metrics.get("variant_val_rows", 0)) != v7.VARIANT_VAL_ROWS
    ):
        raise MangaFontV7Mass21R2Error(f"{location}: val33 inventory drifted")
    for name, value in metrics.items():
        if isinstance(value, bool) or isinstance(value, str) or isinstance(value, Mapping):
            continue
        if isinstance(value, (int, float)) and not math.isfinite(float(value)):
            raise MangaFontV7Mass21R2Error(
                f"{location}: val metric became nonfinite: {name}"
            )


def _validate_val_metrics(metrics: Mapping[str, Any], prototypes: Any) -> None:
    _validate_val_metric_values(metrics, location="r2 evaluation")
    try:
        import torch

        finite = bool(torch.isfinite(prototypes).all())
    except (ImportError, TypeError, AttributeError):
        finite = bool(np.isfinite(np.asarray(prototypes)).all())
    if not finite:
        raise MangaFontV7Mass21R2Error("r2 val prototypes became nonfinite")


def _finite_model_state(torch: Any, model: Any) -> bool:
    return all(
        bool(torch.isfinite(value).all())
        for value in model.state_dict().values()
        if torch.is_tensor(value) and value.dtype.is_floating_point
    )


def _is_val_improvement(
    candidate: Mapping[str, Any], best: Mapping[str, Any]
) -> bool:
    return v7.v6._metric_key(candidate) > v7.v6._metric_key(best)  # noqa: SLF001


def _dry_smoke(
    args: argparse.Namespace,
    *,
    steps: int,
) -> Mapping[str, Any]:
    command_started = v7.time.monotonic()
    inputs = v7._build_inputs(args, load_cached_arrays=True)  # noqa: SLF001
    candidate_ids = inputs.projection.active_ids
    runtime = v7._runtime(args, inputs)  # noqa: SLF001
    torch = runtime["torch"]
    device = runtime["device"]
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    model = runtime["model"]
    optimizer = runtime["optimizer"]
    baseline_metrics, _baseline_predictions, baseline_prototypes = v7._evaluate_val(  # noqa: SLF001
        torch=torch,
        model=model,
        val_tokens=runtime["val_tokens"],
        val_targets=runtime["val_targets"],
        val_masks=runtime["val_masks"],
        val_roles=runtime["val_roles"],
        reference_tokens=runtime["reference_tokens"],
        reference_labels=runtime["reference_labels"],
        candidate_ids=candidate_ids,
        device=device,
    )
    _validate_val_metrics(baseline_metrics, baseline_prototypes)
    baseline_state = v7.v6._state_cpu(model)  # noqa: SLF001
    if not baseline_state or not _finite_model_state(torch, model):
        raise MangaFontV7Mass21R2Error("r2 smoke warm-start is invalid")
    lookup = v7._human_lookup(inputs)  # noqa: SLF001
    master_resolver = v7.catalog_assets.CatalogAssetResolver(
        args.master_catalog_registry.expanduser().resolve()
    )
    human_resolver = v7.catalog_assets.CatalogAssetResolver(
        args.human_catalog_registry.expanduser().resolve()
    )
    weights = v7._loss_weights(args)  # noqa: SLF001
    batches = v7._epoch_batches(args, inputs, 1)  # noqa: SLF001
    last_prepared: Mapping[str, Any] | None = None
    last_components: Mapping[str, Any] | None = None
    last_gradient_norm = math.nan
    model.train(True)
    with inputs.real.manifest_path.open("rb") as master_handle:
        for step_index in range(steps):
            prepared = _open_training_batch(
                torch=torch,
                batch=batches[step_index],
                inputs=inputs,
                arrays=runtime["arrays"],
                lookup=lookup,
                master_handle=master_handle,
                master_resolver=master_resolver,
                human_resolver=human_resolver,
                encoder=runtime["encoder"],
                processor=runtime["processor"],
                device=device,
            )
            optimizer.zero_grad(set_to_none=True)
            with v7._amp_context(torch, device):  # noqa: SLF001
                result = model(
                    prepared["tokens"],
                    runtime["reference_tokens"],
                    runtime["reference_labels"],
                    len(candidate_ids),
                )
                loss, components = _compute_losses(
                    torch=torch, result=result, batch=prepared, weights=weights
                )
            if not bool(torch.isfinite(loss)):
                raise MangaFontV7Mass21R2Error("r2 smoke loss became nonfinite")
            loss.backward()
            try:
                gradient_norm = torch.nn.utils.clip_grad_norm_(
                    model.parameters(), args.gradient_clip, error_if_nonfinite=True
                )
            except RuntimeError as error:
                raise MangaFontV7Mass21R2Error(
                    "r2 smoke gradient became nonfinite"
                ) from error
            optimizer.step()
            if not _finite_model_state(torch, model):
                raise MangaFontV7Mass21R2Error(
                    "r2 smoke optimizer produced nonfinite state"
                )
            last_prepared = prepared
            last_components = components
            last_gradient_norm = float(gradient_norm.detach().item())
    post_metrics, _post_predictions, post_prototypes = v7._evaluate_val(  # noqa: SLF001
        torch=torch,
        model=model,
        val_tokens=runtime["val_tokens"],
        val_targets=runtime["val_targets"],
        val_masks=runtime["val_masks"],
        val_roles=runtime["val_roles"],
        reference_tokens=runtime["reference_tokens"],
        reference_labels=runtime["reference_labels"],
        candidate_ids=candidate_ids,
        device=device,
    )
    _validate_val_metrics(post_metrics, post_prototypes)
    improved = _is_val_improvement(post_metrics, baseline_metrics)
    selected_epoch: int | str = "smoke_steps" if improved else 0
    if device.type == "cuda":
        torch.cuda.synchronize(device)
        peak_allocated = torch.cuda.max_memory_allocated(device) / (1024**3)
        peak_reserved = torch.cuda.max_memory_reserved(device) / (1024**3)
    else:
        peak_allocated = None
        peak_reserved = None
    if last_prepared is None or last_components is None:
        raise MangaFontV7Mass21R2Error("r2 smoke produced no step")
    return {
        **dict(inputs.summary),
        "batch": {
            "full_human": last_prepared["full_count"],
            "partial_human": last_prepared["partial_count"],
            "pseudo_rows": last_components["pseudo_rows"],
            "real": last_prepared["real_count"],
            "synthetic": last_prepared["synthetic_count"],
        },
        "device": str(device),
        "elapsed_seconds": v7.time.monotonic() - command_started,
        "epoch0": {
            "baseline_val": baseline_metrics,
            "eligible_for_final_selection": True,
            "post_smoke_improved": improved,
            "post_smoke_val": post_metrics,
            "selected_epoch_after_smoke": selected_epoch,
        },
        "gradient_norm_before_clip": last_gradient_norm,
        "losses": {
            name: float(value.detach().item())
            for name, value in last_components.items()
            if hasattr(value, "detach")
        },
        "peak_gpu_allocated_gib": peak_allocated,
        "peak_gpu_reserved_gib": peak_reserved,
        "r2_source_provenance": _source_provenance(),
        "source_exposure_per_epoch": _source_exposure_plan(args, inputs),
        "status": "r2_full_batch_smoke_completed",
        "steps": steps,
        "test_rows_opened": 0,
        "val_rows_used_for_optimizer": 0,
        "weighting": _weighting_manifest(inputs),
    }


def _train(
    args: argparse.Namespace,
) -> Mapping[str, Any]:
    if v7._safe_directory(args.output_dir, location="output directory").exists():  # noqa: SLF001
        raise MangaFontV7Mass21R2Error("r2 output already exists")
    inputs = v7._build_inputs(args, load_cached_arrays=True)  # noqa: SLF001
    candidate_ids = inputs.projection.active_ids
    if (
        len(candidate_ids) != v7.mass21.ACTIVE_CANDIDATE_COUNT
        or v7.mass21.RETIRED_FONT_ID in candidate_ids
    ):
        raise MangaFontV7Mass21R2Error("r2 active21 vocabulary is unsafe")
    weighting = _weighting_manifest(inputs)
    runtime = v7._runtime(args, inputs)  # noqa: SLF001
    torch = runtime["torch"]
    device = runtime["device"]
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    model = runtime["model"]
    optimizer = runtime["optimizer"]
    source_fingerprint = v7._source_fingerprint(args)  # noqa: SLF001
    run_state_dir = v7._safe_directory(  # noqa: SLF001
        args.run_state_dir, location="run-state directory"
    )
    lookup = v7._human_lookup(inputs)  # noqa: SLF001
    master_resolver = v7.catalog_assets.CatalogAssetResolver(
        args.master_catalog_registry.expanduser().resolve()
    )
    human_resolver = v7.catalog_assets.CatalogAssetResolver(
        args.human_catalog_registry.expanduser().resolve()
    )
    history: list[dict[str, Any]] = []
    best_metrics: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    best_state: dict[str, Any] | None = None
    best_prototypes: Any | None = None
    baseline_val: dict[str, Any] | None = None
    best_epoch = 0
    stale_epochs = 0
    start_epoch = 1
    start_step = 0
    epoch_sums: Counter[str] = Counter()
    epoch_steps_done = 0

    if args.resume:
        payload = v7._load_run_checkpoint(  # noqa: SLF001
            torch=torch,
            args=args,
            run_state_dir=run_state_dir,
            source_fingerprint=source_fingerprint,
            candidate_ids=candidate_ids,
            device=device,
        )
        if (
            payload.get("r2_source_provenance") != _source_provenance()
            or payload.get("weighting") != weighting
        ):
            raise MangaFontV7Mass21R2Error("r2 resume provenance drifted")
        model.load_state_dict(payload["model_state"], strict=True)
        optimizer.load_state_dict(payload["optimizer_state"])
        v7._state_to_optimizer_device(torch, optimizer, device)  # noqa: SLF001
        start_epoch = int(payload["epoch"])
        start_step = int(payload["next_step"])
        stale_epochs = int(payload["stale_epochs"])
        history = copy.deepcopy(list(payload["history"]))
        best_metrics = copy.deepcopy(payload["best_metrics"])
        best_predictions = copy.deepcopy(payload["best_predictions"])
        best_state = copy.deepcopy(payload["best_state"])
        best_prototypes = payload["best_prototypes"]
        best_epoch = int(payload["best_epoch"])
        epoch_sums = Counter(payload["epoch_sums"])
        epoch_steps_done = int(payload["epoch_steps"])
        baseline_val = copy.deepcopy(
            dict(v7._mapping(payload.get("baseline_val"), "r2 baseline checkpoint"))  # noqa: SLF001
        )
        torch.set_rng_state(payload["torch_rng_state"].cpu())
        if (
            not 1 <= start_epoch <= args.epochs + 1
            or not 0 <= best_epoch <= args.epochs
            or best_metrics is None
            or best_predictions is None
            or best_state is None
            or best_prototypes is None
        ):
            raise MangaFontV7Mass21R2Error("r2 resume epoch/best state drifted")
        _validate_val_metrics(baseline_val, best_prototypes)
    else:
        if run_state_dir.exists():
            raise MangaFontV7Mass21R2Error(
                "r2 run-state exists; pass --resume or select a new directory"
            )
        metrics, predictions, prototypes = v7._evaluate_val(  # noqa: SLF001
            torch=torch,
            model=model,
            val_tokens=runtime["val_tokens"],
            val_targets=runtime["val_targets"],
            val_masks=runtime["val_masks"],
            val_roles=runtime["val_roles"],
            reference_tokens=runtime["reference_tokens"],
            reference_labels=runtime["reference_labels"],
            candidate_ids=candidate_ids,
            device=device,
        )
        _validate_val_metrics(metrics, prototypes)
        if not _finite_model_state(torch, model):
            raise MangaFontV7Mass21R2Error("r2 warm-start state is nonfinite")
        baseline_val = copy.deepcopy(metrics)
        best_metrics = copy.deepcopy(metrics)
        best_predictions = copy.deepcopy(predictions)
        best_state = v7.v6._state_cpu(model)  # noqa: SLF001
        best_prototypes = prototypes
        best_epoch = 0
        initial = _checkpoint_payload(
            torch=torch,
            args=args,
            candidate_ids=candidate_ids,
            model=model,
            optimizer=optimizer,
            epoch=1,
            next_step=0,
            stale_epochs=0,
            best_metrics=best_metrics,
            best_predictions=best_predictions,
            best_state=best_state,
            best_prototypes=best_prototypes,
            best_epoch=best_epoch,
            history=history,
            epoch_sums={},
            epoch_steps=0,
            source_fingerprint=source_fingerprint,
            baseline_val=baseline_val,
            weighting=weighting,
        )
        v7._write_run_checkpoint(  # noqa: SLF001
            torch=torch, run_state_dir=run_state_dir, payload=initial
        )

    if baseline_val is None:
        raise MangaFontV7Mass21R2Error("r2 baseline val is missing")
    weights = v7._loss_weights(args)  # noqa: SLF001
    started = v7.time.monotonic()
    stop_training = (
        stale_epochs >= args.patience
        and start_step == 0
        and start_epoch <= args.epochs
    )
    with inputs.real.manifest_path.open("rb") as master_handle:
        for epoch in range(start_epoch, args.epochs + 1):
            if stop_training:
                break
            batches = v7._epoch_batches(args, inputs, epoch)  # noqa: SLF001
            if start_step > len(batches):
                raise MangaFontV7Mass21R2Error("r2 resume step escaped epoch schedule")
            model.train(True)
            for step_index in range(start_step, len(batches)):
                prepared = _open_training_batch(
                    torch=torch,
                    batch=batches[step_index],
                    inputs=inputs,
                    arrays=runtime["arrays"],
                    lookup=lookup,
                    master_handle=master_handle,
                    master_resolver=master_resolver,
                    human_resolver=human_resolver,
                    encoder=runtime["encoder"],
                    processor=runtime["processor"],
                    device=device,
                )
                optimizer.zero_grad(set_to_none=True)
                with v7._amp_context(torch, device):  # noqa: SLF001
                    result = model(
                        prepared["tokens"],
                        runtime["reference_tokens"],
                        runtime["reference_labels"],
                        len(candidate_ids),
                    )
                    loss, components = _compute_losses(
                        torch=torch,
                        result=result,
                        batch=prepared,
                        weights=weights,
                    )
                if not bool(torch.isfinite(loss)):
                    raise MangaFontV7Mass21R2Error("r2 loss became nonfinite")
                loss.backward()
                try:
                    gradient_norm = torch.nn.utils.clip_grad_norm_(
                        model.parameters(),
                        args.gradient_clip,
                        error_if_nonfinite=True,
                    )
                except RuntimeError as error:
                    raise MangaFontV7Mass21R2Error(
                        "r2 gradient became nonfinite"
                    ) from error
                if not bool(torch.isfinite(gradient_norm)):
                    raise MangaFontV7Mass21R2Error("r2 gradient norm became nonfinite")
                optimizer.step()
                if not _finite_model_state(torch, model):
                    raise MangaFontV7Mass21R2Error("r2 optimizer produced nonfinite state")
                for name, value in components.items():
                    epoch_sums[name] += (
                        float(value.detach().item())
                        if hasattr(value, "detach")
                        else float(value)
                    )
                epoch_steps_done += 1
                next_step = step_index + 1
                if (
                    args.checkpoint_steps > 0
                    and next_step % args.checkpoint_steps == 0
                ):
                    checkpoint = _checkpoint_payload(
                        torch=torch,
                        args=args,
                        candidate_ids=candidate_ids,
                        model=model,
                        optimizer=optimizer,
                        epoch=epoch,
                        next_step=next_step,
                        stale_epochs=stale_epochs,
                        best_metrics=best_metrics,
                        best_predictions=best_predictions,
                        best_state=best_state,
                        best_prototypes=best_prototypes,
                        best_epoch=best_epoch,
                        history=history,
                        epoch_sums=epoch_sums,
                        epoch_steps=epoch_steps_done,
                        source_fingerprint=source_fingerprint,
                        baseline_val=baseline_val,
                        weighting=weighting,
                    )
                    v7._write_run_checkpoint(  # noqa: SLF001
                        torch=torch,
                        run_state_dir=run_state_dir,
                        payload=checkpoint,
                    )

            metrics, predictions, prototypes = v7._evaluate_val(  # noqa: SLF001
                torch=torch,
                model=model,
                val_tokens=runtime["val_tokens"],
                val_targets=runtime["val_targets"],
                val_masks=runtime["val_masks"],
                val_roles=runtime["val_roles"],
                reference_tokens=runtime["reference_tokens"],
                reference_labels=runtime["reference_labels"],
                candidate_ids=candidate_ids,
                device=device,
            )
            _validate_val_metrics(metrics, prototypes)
            improved = _is_val_improvement(metrics, best_metrics)
            if improved:
                best_metrics = copy.deepcopy(metrics)
                best_predictions = copy.deepcopy(predictions)
                best_state = v7.v6._state_cpu(model)  # noqa: SLF001
                best_prototypes = prototypes
                best_epoch = epoch
                stale_epochs = 0
            else:
                stale_epochs += 1
            history.append(
                v7.base.seal_record(
                    {
                        "coverage": v7._coverage_record(batches),  # noqa: SLF001
                        "epoch": epoch,
                        "improved": improved,
                        "record_type": "manga_font_student_v7_mass21_r2_epoch",
                        "schema_version": SCHEMA,
                        "train": {
                            name: epoch_sums[name] / max(epoch_steps_done, 1)
                            for name in (
                                "attention_diversity",
                                "domain_moment",
                                "full_human",
                                "partial_human",
                                "pseudo",
                                "pseudo_rows",
                                "real_consistency",
                                "synthetic",
                                "total",
                            )
                        },
                        "val": metrics,
                    }
                )
            )
            next_epoch = epoch + 1
            checkpoint = _checkpoint_payload(
                torch=torch,
                args=args,
                candidate_ids=candidate_ids,
                model=model,
                optimizer=optimizer,
                epoch=next_epoch,
                next_step=0,
                stale_epochs=stale_epochs,
                best_metrics=best_metrics,
                best_predictions=best_predictions,
                best_state=best_state,
                best_prototypes=best_prototypes,
                best_epoch=best_epoch,
                history=history,
                epoch_sums={},
                epoch_steps=0,
                source_fingerprint=source_fingerprint,
                baseline_val=baseline_val,
                weighting=weighting,
            )
            v7._write_run_checkpoint(  # noqa: SLF001
                torch=torch, run_state_dir=run_state_dir, payload=checkpoint
            )
            epoch_sums = Counter()
            epoch_steps_done = 0
            start_step = 0
            if stale_epochs >= args.patience and epoch < args.epochs:
                stop_training = True
                break

    if (
        best_metrics is None
        or best_predictions is None
        or best_state is None
        or best_prototypes is None
        or best_epoch < 0
    ):
        raise MangaFontV7Mass21R2Error("r2 training produced no selectable model")
    return _publish_output(
        args=args,
        inputs=inputs,
        runtime=runtime,
        candidate_ids=candidate_ids,
        history=history,
        best_metrics=best_metrics,
        best_predictions=best_predictions,
        best_state=best_state,
        best_prototypes=best_prototypes,
        best_epoch=best_epoch,
        baseline_val=baseline_val,
        run_state_dir=run_state_dir,
        source_fingerprint=source_fingerprint,
        timing_seconds=v7.time.monotonic() - started,
        early_stopped=stop_training,
    )


def _publish_output(
    *,
    args: argparse.Namespace,
    inputs: v7.mass21.Mass21TrainingInputs,
    runtime: Mapping[str, Any],
    candidate_ids: tuple[str, ...],
    history: Sequence[Mapping[str, Any]],
    best_metrics: Mapping[str, Any],
    best_predictions: Sequence[Mapping[str, Any]],
    best_state: Mapping[str, Any],
    best_prototypes: Any,
    best_epoch: int,
    baseline_val: Mapping[str, Any],
    run_state_dir: Path,
    source_fingerprint: Mapping[str, Any],
    timing_seconds: float,
    early_stopped: bool,
) -> Mapping[str, Any]:
    output = v7._safe_directory(args.output_dir, location="output directory")  # noqa: SLF001
    if output.exists():
        raise MangaFontV7Mass21R2Error("r2 output already exists")
    v7._validate_run_state(run_state_dir)  # noqa: SLF001
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        runtime["save_file"](
            dict(best_state),
            str(staging / v7.BEST_HEAD),
            metadata={
                "format": SCHEMA,
                "kind": "active21-frozen-siglip2-patch-query-head",
            },
        )
        prototype_array = np.ascontiguousarray(best_prototypes.numpy(), dtype="<f4")
        if prototype_array.shape != (
            v7.mass21.ACTIVE_CANDIDATE_COUNT,
            v7.QUERY_COUNT,
            v7.QUERY_DIM,
        ) or not np.isfinite(prototype_array).all():
            raise MangaFontV7Mass21R2Error("r2 best prototypes are invalid")
        (staging / v7.PROTOTYPES).write_bytes(prototype_array.tobytes())
        with (staging / v7.PREDICTIONS).open("wb") as handle:
            for row in best_predictions:
                handle.write(v7.base.json_bytes(row))
        with (staging / v7.HISTORY).open("wb") as handle:
            for row in history:
                handle.write(v7.base.json_bytes(row))
        shutil.copy2(_latest_checkpoint_path(run_state_dir), staging / v7.LATEST_CHECKPOINT)
        gate = v7.v6.research_gate(best_metrics)
        provenance = _source_provenance()
        manifest = v7.base.seal_record(
            {
                "architecture": {
                    "candidate_bias": False,
                    "candidate_scoring": "query-wise-cosine-to-reference-prototypes",
                    "encoder": v7.base.MODEL_ID,
                    "encoder_revision": v7.base.MODEL_REVISION,
                    "encoder_trainable_blocks": 0,
                    "input_representation": "three-view-last-hidden-state-patch-tokens",
                    "query_count": v7.QUERY_COUNT,
                    "query_dim": v7.QUERY_DIM,
                    "warm_start": "v6-r3-all160",
                },
                "base_v7_source_code_sha256": provenance[
                    "base_v7_source_code_sha256"
                ],
                "baseline_val": copy.deepcopy(dict(baseline_val)),
                "best_epoch": best_epoch,
                "best_val": copy.deepcopy(dict(best_metrics)),
                "boundaries": {
                    **{
                        key: value
                        for key, value in inputs.summary.items()
                        if key.endswith("json_deserialized") or key.endswith("skipped")
                    },
                    "gugi_candidate_count": candidate_ids.count(
                        v7.mass21.RETIRED_FONT_ID
                    ),
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "master_test_pixels_opened": 0,
                    "master_val_pixels_opened": 0,
                    "test_used_for_model_selection": False,
                    "val33_count": v7.VAL_ROWS,
                    "val33_used_for_early_stop": True,
                    "val33_used_for_model_selection": True,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(candidate_ids),
                "configuration": _configuration(args),
                "early_stopped": early_stopped,
                "files": {
                    name: v7._descriptor(staging / name)  # noqa: SLF001
                    for name in (
                        v7.BEST_HEAD,
                        v7.HISTORY,
                        v7.LATEST_CHECKPOINT,
                        v7.PREDICTIONS,
                        v7.PROTOTYPES,
                    )
                },
                "history_epochs": len(history),
                "quality_gate": gate,
                "record_type": "manga_font_student_v7_mass21_r2_training_manifest",
                "schema_version": SCHEMA,
                "source_code_sha256": provenance["r2_source_code_sha256"],
                "source_fingerprint": copy.deepcopy(dict(source_fingerprint)),
                "training_inventory": copy.deepcopy(dict(inputs.summary)),
                "training_source_exposure_per_epoch": _source_exposure_plan(
                    args, inputs
                ),
                "training_seconds": timing_seconds,
                "weighting": _weighting_manifest(inputs),
            }
        )
        (staging / v7.MANIFEST).write_bytes(
            v7.base.json_bytes(manifest, pretty=True)
        )
        marker = {
            "artifacts": {
                name: v7.base.sha256_file(staging / name)
                for name in OUTPUT_FILES - {MARKER}
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(v7.base.json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


@contextmanager
def _patched_v7_runtime() -> Any:
    replacements = {
        "SCHEMA": SCHEMA,
        "OWNER": OWNER,
        "MARKER": MARKER,
        "OUTPUT_FILES": OUTPUT_FILES,
        "RUN_STATE_SCHEMA": RUN_STATE_SCHEMA,
        "RUN_STATE_MARKER": RUN_STATE_MARKER,
        "RUN_STATE_FILES": RUN_STATE_FILES,
        "_configuration": _configuration,
        "_configuration_sha256": _configuration_sha256,
        "_open_training_batch": _open_training_batch,
        "_compute_losses": _compute_losses,
        "_publish_output": _publish_output,
        "_write_run_checkpoint": _write_run_checkpoint,
        "_load_run_checkpoint": _load_run_checkpoint,
        "_validate_run_state": _validate_run_state,
    }
    previous = {name: getattr(v7, name) for name in replacements}
    try:
        for name, value in replacements.items():
            setattr(v7, name, value)
        yield
    finally:
        for name, value in previous.items():
            setattr(v7, name, value)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    with _patched_v7_runtime():
        original_file = v7.__file__
        try:
            v7.__file__ = __file__
            result = dict(_BASE_VALIDATE_OUTPUT(output_dir))
        finally:
            v7.__file__ = original_file
    root = output_dir.expanduser().resolve()
    manifest = v7.base.read_json(root / v7.MANIFEST, location="r2 manifest")
    configuration = v7._mapping(manifest.get("configuration"), "r2 configuration")  # noqa: SLF001
    weighting = v7._mapping(manifest.get("weighting"), "r2 weighting")  # noqa: SLF001
    work = v7._mapping(weighting.get("work"), "r2 weighting.work")  # noqa: SLF001
    baseline_val = v7._mapping(manifest.get("baseline_val"), "r2 baseline val")  # noqa: SLF001
    _validate_val_metric_values(baseline_val, location="r2 manifest baseline")
    best_val = v7._mapping(manifest.get("best_val"), "r2 best val")  # noqa: SLF001
    _validate_val_metric_values(best_val, location="r2 manifest best")
    provenance = _source_provenance()
    if (
        configuration.get("work_normalization") != WORK_NORMALIZATION_ID
        or configuration.get("pseudo_confidence_mode") != PSEUDO_CONFIDENCE_MODE
        or configuration.get("domain_moment_mode") != DOMAIN_MOMENT_MODE
        or configuration.get("real_loss_denominator") != REAL_DENOMINATOR_MODE
        or work.get("id") != WORK_NORMALIZATION_ID
        or int(work.get("sample_count", 0)) != v7.mass21.MASTER_TRAIN_ROWS
        or int(work.get("work_count", 0)) != EXPECTED_TRAIN_WORKS
        or not math.isclose(
            float(work.get("normalized_weight_mean", math.nan)),
            1.0,
            rel_tol=0.0,
            abs_tol=1e-9,
        )
        or weighting.get("pseudo_confidence") != PSEUDO_CONFIDENCE_MODE
        or weighting.get("domain_moment") != DOMAIN_MOMENT_MODE
        or weighting.get("real_loss_denominator") != REAL_DENOMINATOR_MODE
        or manifest.get("source_code_sha256") != provenance["r2_source_code_sha256"]
        or manifest.get("base_v7_source_code_sha256")
        != provenance["base_v7_source_code_sha256"]
        or (
            int(manifest.get("best_epoch", -1)) == 0
            and best_val != baseline_val
        )
    ):
        raise MangaFontV7Mass21R2Error("r2 weighting/source provenance drifted")
    result["status"] = "validated_v7_mass21_r2_training_output"
    result["work_normalization"] = WORK_NORMALIZATION_ID
    return result


def _preflight_plan(
    args: argparse.Namespace,
    inputs: v7.mass21.Mass21TrainingInputs,
) -> dict[str, Any]:
    with _patched_v7_runtime():
        result = dict(v7._preflight_plan(args, inputs))  # noqa: SLF001
    result.update(
        {
            "r2_source_provenance": _source_provenance(),
            "r2_status": "ready_for_global_fixed_work_normalization",
            "source_exposure_per_epoch": _source_exposure_plan(args, inputs),
            "weighting": _weighting_manifest(inputs),
        }
    )
    return result


def _validate_cli_configuration(args: argparse.Namespace) -> None:
    integer_values = (
        args.epochs,
        args.full_human_batch_size,
        args.partial_human_batch_size,
        args.patience,
        args.real_batch_size,
        args.synthetic_batch_size,
    )
    if any(value < 1 for value in integer_values):
        raise MangaFontV7Mass21R2Error("r2 training counts must be positive")
    if args.checkpoint_steps < 0:
        raise MangaFontV7Mass21R2Error("r2 checkpoint steps must be nonnegative")
    positive = (
        args.gradient_clip,
        args.head_lr,
        args.weight_decay,
        args.synthetic_weight,
        args.full_human_weight,
        args.partial_human_weight,
        args.real_consistency_weight,
        args.domain_moment_weight,
        args.attention_diversity_weight,
    )
    if any(not math.isfinite(value) or value <= 0.0 for value in positive):
        raise MangaFontV7Mass21R2Error("r2 weights must be finite and positive")
    if not math.isfinite(args.pseudo_weight) or not 0.0 <= args.pseudo_weight <= 1.0:
        raise MangaFontV7Mass21R2Error("r2 pseudo weight must remain inside [0,1]")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("preflight")
    v7._add_data_inputs(preflight)  # noqa: SLF001
    v7._add_training_configuration(preflight)  # noqa: SLF001
    preflight.set_defaults(
        epochs=6,
        patience=6,
        pseudo_weight=0.75,
        head_lr=1e-5,
        full_human_batch_size=1,
        partial_human_batch_size=1,
        synthetic_batch_size=1,
    )
    dry_smoke = commands.add_parser("dry-smoke")
    v7._add_data_inputs(dry_smoke)  # noqa: SLF001
    v7._add_training_configuration(dry_smoke)  # noqa: SLF001
    dry_smoke.set_defaults(
        epochs=6,
        patience=6,
        pseudo_weight=0.75,
        head_lr=1e-5,
        real_batch_size=2,
        full_human_batch_size=1,
        partial_human_batch_size=1,
        synthetic_batch_size=1,
        resume=False,
    )
    dry_smoke.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    dry_smoke.add_argument("--smoke-steps", type=int, default=1)
    dry_smoke.add_argument(
        "--run-state-dir", type=Path, default=Path("artifacts/.v7-mass21-r2-dry-smoke")
    )
    dry_smoke.add_argument(
        "--output-dir", type=Path, default=Path("artifacts/.v7-mass21-r2-dry-output")
    )
    train = commands.add_parser("train")
    v7._add_data_inputs(train)  # noqa: SLF001
    v7._add_training_configuration(train)  # noqa: SLF001
    train.set_defaults(
        epochs=6,
        patience=6,
        pseudo_weight=0.75,
        head_lr=1e-5,
        full_human_batch_size=1,
        partial_human_batch_size=1,
        synthetic_batch_size=1,
    )
    train.add_argument("--device", choices=("cuda",), default="cuda")
    train.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-r2-v1"),
    )
    train.add_argument("--run-state-dir", type=Path)
    train.add_argument("--resume", action="store_true")
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            _validate_cli_configuration(args)
            if args.command == "preflight":
                inputs = v7._build_inputs(args, load_cached_arrays=False)  # noqa: SLF001
                result = _preflight_plan(args, inputs)
            else:
                if args.command == "train" and args.run_state_dir is None:
                    args.run_state_dir = args.output_dir.with_name(
                        args.output_dir.name + ".run-state"
                    )
                if args.command == "dry-smoke" and not 1 <= args.smoke_steps <= 4:
                    raise MangaFontV7Mass21R2Error("r2 dry smoke steps must be 1..4")
                with _patched_v7_runtime():
                    if args.command == "train":
                        result = _train(args)
                    else:
                        result = _dry_smoke(args, steps=args.smoke_steps)
    except (
        MangaFontV7Mass21R2Error,
        v7.MangaFontV7Mass21Error,
        v7.mass21.MangaFontMass21DataError,
        v7.catalog_assets.CatalogAssetError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-v7-mass21-r2 error: {error}") from error
    print(v7.base.canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
