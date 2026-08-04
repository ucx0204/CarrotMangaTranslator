#!/usr/bin/env python3
"""Train the first active21 MangaFont model over the complete mass corpus.

This trainer is the executable consumer of
``train_manga_font_student_v6_mass21_data``.  It keeps SigLIP2 frozen, warm
starts the v6/r3 four-query head, and trains one shared active21 head from all
four sources in every epoch:

* 19,664 master-v3 train crops, exactly once, using all three views;
* every usable complete and masked-partial human row;
* all 1,008 active21 synthetic training rows; and
* optional, low-weight, sealed 21-way pseudo soft targets.

Only the unchanged adjudicated val33 selects checkpoints and controls early
stopping.  Master validation/test rows and every hidden human test surface
remain unopened.  Gugi is projected out before the model or optimizer exists.
The CLI includes metadata-only preflight, a bounded real-pixel dry smoke,
checkpoint/resume training, and independent sealed-output validation.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import tempfile
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

import numpy as np

try:
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_fontquery_r3 as r3
    from scripts import train_manga_font_student_v6_mass21_data as mass21
except ImportError:  # pragma: no cover - direct execution from scripts/
    import font_matching_catalog_assets as catalog_assets
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_fontquery_r3 as r3
    import train_manga_font_student_v6_mass21_data as mass21


SCHEMA = "manga-font-student-v7-mass21-v1"
OWNER = "carrot-manga-translator/manga-font-student-v7-mass21-v1"
MARKER = ".manga-font-student-v7-mass21-v1-owned.json"
MANIFEST = "manifest.json"
HISTORY = "history.jsonl"
BEST_HEAD = "best-fontquery-head.safetensors"
PROTOTYPES = "candidate-query-prototypes.f32"
PREDICTIONS = "predictions-val.jsonl"
LATEST_CHECKPOINT = "latest-checkpoint.pt"
OUTPUT_FILES = frozenset(
    {
        MARKER,
        MANIFEST,
        HISTORY,
        BEST_HEAD,
        PROTOTYPES,
        PREDICTIONS,
        LATEST_CHECKPOINT,
    }
)
RUN_STATE_SCHEMA = "manga-font-student-v7-mass21-run-state-v1"
RUN_STATE_MARKER = ".manga-font-student-v7-mass21-run-state-owned.json"
RUN_STATE_CHECKPOINT = "checkpoint.pt"
RUN_STATE_FILES = frozenset({RUN_STATE_MARKER, RUN_STATE_CHECKPOINT})
QUERY_COUNT = 4
QUERY_DIM = 256
HIDDEN_SIZE = 768
PATCH_COUNT = 196
VAL_ROWS = 33
VARIANT_VAL_ROWS = 28


class MangaFontV7Mass21Error(mass21.MangaFontMass21DataError):
    """Raised when the trainer or its sealed output crosses a boundary."""


@dataclass(frozen=True)
class LossWeights:
    synthetic: float
    full_human: float
    partial_human: float
    real_consistency: float
    domain_moment: float
    pseudo: float
    attention_diversity: float


@dataclass(frozen=True)
class HumanLookup:
    addition_index_by_id: Mapping[str, int]


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV7Mass21Error(f"{location}: expected object")
    return value


def _safe_directory(path: Path, *, location: str) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontV7Mass21Error(f"unsafe {location}: {result}")
    return result


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV7Mass21Error(f"missing output file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, raw_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    os.close(handle)
    temporary = Path(raw_name)
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _source_fingerprint(args: argparse.Namespace) -> dict[str, Any]:
    cache_root = args.cache_dir.expanduser().resolve()
    r3_root = args.r3_output_dir.expanduser().resolve()
    pseudo_path = args.pseudo_labels.expanduser().resolve() if args.pseudo_labels else None
    return {
        "authority_report_sha256": base.sha256_file(
            args.authority_dir.expanduser().resolve() / "report.json"
        ),
        "cache_contract_sha256": base.sha256_file(cache_root / v6.CACHE_CONTRACT),
        "cache_arrays_sha256": base.sha256_file(cache_root / v6.CACHE_ARRAYS),
        "human_catalog_registry_sha256": base.sha256_file(
            args.human_catalog_registry.expanduser().resolve()
        ),
        "legacy_overlay_manifest_sha256": base.sha256_file(
            args.legacy_overlay_dir.expanduser().resolve() / "manifest.json"
        ),
        "master_catalog_registry_sha256": base.sha256_file(
            args.master_catalog_registry.expanduser().resolve()
        ),
        "master_manifest_sha256": base.sha256_file(
            args.master_dir.expanduser().resolve() / "manifest.jsonl"
        ),
        "master_split_map_sha256": base.sha256_file(
            args.master_dir.expanduser().resolve() / "split_map.json"
        ),
        "pseudo_labels_sha256": base.sha256_file(pseudo_path) if pseudo_path else None,
        "r3_checkpoint_sha256": base.sha256_file(r3_root / r3.CHECKPOINT),
        "r3_report_sha256": base.sha256_file(r3_root / r3.REPORT),
    }


def _configuration(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "attention_diversity_weight": args.attention_diversity_weight,
        "checkpoint_steps": args.checkpoint_steps,
        "domain_moment_weight": args.domain_moment_weight,
        "epochs": args.epochs,
        "full_human_batch_size": args.full_human_batch_size,
        "full_human_weight": args.full_human_weight,
        "gradient_clip": args.gradient_clip,
        "head_lr": args.head_lr,
        "partial_human_batch_size": args.partial_human_batch_size,
        "partial_human_weight": args.partial_human_weight,
        "patience": args.patience,
        "pseudo_weight": args.pseudo_weight,
        "query_count": QUERY_COUNT,
        "query_dim": QUERY_DIM,
        "real_batch_size": args.real_batch_size,
        "real_consistency_weight": args.real_consistency_weight,
        "seed": args.seed,
        "synthetic_batch_size": args.synthetic_batch_size,
        "synthetic_weight": args.synthetic_weight,
        "weight_decay": args.weight_decay,
    }


def _configuration_sha256(args: argparse.Namespace) -> str:
    return base.sha256_bytes(base.canonical_json(_configuration(args)).encode("utf-8"))


def _build_inputs(
    args: argparse.Namespace, *, load_cached_arrays: bool
) -> mass21.Mass21TrainingInputs:
    return mass21.build_training_inputs(
        cache_dir=args.cache_dir,
        r3_output_dir=args.r3_output_dir,
        authority_dir=args.authority_dir,
        review_dir=args.review_dir,
        draft_dir=args.draft_dir,
        legacy_overlay_dir=args.legacy_overlay_dir,
        human_catalog_registry=args.human_catalog_registry,
        master_dir=args.master_dir,
        master_catalog_registry=args.master_catalog_registry,
        pseudo_labels=args.pseudo_labels,
        real_batch_size=args.real_batch_size,
        full_human_batch_size=args.full_human_batch_size,
        partial_human_batch_size=args.partial_human_batch_size,
        synthetic_batch_size=args.synthetic_batch_size,
        seed=args.seed,
        load_cached_arrays=load_cached_arrays,
    )


def _preflight_plan(
    args: argparse.Namespace, inputs: mass21.Mass21TrainingInputs
) -> dict[str, Any]:
    dynamic_rows = (
        mass21.MASTER_TRAIN_ROWS
        + len(inputs.epoch_batches) * (
            args.full_human_batch_size + args.partial_human_batch_size
        )
    )
    dynamic_images = dynamic_rows * len(base.VIEW_NAMES)
    return {
        **dict(inputs.summary),
        "boundaries": {
            "gugi_present_in_active_candidates": mass21.RETIRED_FONT_ID
            in inputs.projection.active_ids,
            "master_test_rows_json_deserialized": 0,
            "master_test_pixels_opened": 0,
            "master_val_rows_json_deserialized": 0,
            "master_val_pixels_opened": 0,
            "test_used_for_model_selection": False,
            "val33_used_for_model_selection": True,
            "val_used_for_optimizer": False,
        },
        "configuration": _configuration(args),
        "estimated_dynamic_images_per_epoch": dynamic_images,
        "estimated_time": {
            "full_run_hours_on_rtx4090": "2.5-6.0",
            "single_epoch_minutes_on_rtx4090": "25-60",
        },
        "estimated_vram_gib": "2-4",
        "inverse_work_weight": "sealed master-v3 work_balance_weight",
        "model_selection": "adjudicated_val33_only",
        "preflight_status": "ready_for_v7_mass21_training",
        "source_fingerprint": _source_fingerprint(args),
    }


def _load_r3_state(args: argparse.Namespace) -> dict[str, Any]:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV7Mass21Error("safetensors is required") from error
    root = args.r3_output_dir.expanduser().resolve()
    r3.validate_output(root)
    return dict(load_file(str(root / r3.CHECKPOINT), device="cpu"))


def _amp_context(torch: Any, device: Any) -> Any:
    if device.type == "cuda":
        return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    return nullcontext()


def _encode_image_groups(
    *,
    torch: Any,
    encoder: Any,
    processor: Any,
    image_groups: Sequence[Sequence[Any]],
    device: Any,
) -> Any:
    if not image_groups or any(len(group) != len(base.VIEW_NAMES) for group in image_groups):
        raise MangaFontV7Mass21Error("dynamic three-view group inventory drifted")
    images = [image for group in image_groups for image in group]
    try:
        processed = processor(
            images=images,
            return_tensors="pt",
            do_resize=False,
            do_convert_rgb=True,
        )
    finally:
        for image in images:
            image.close()
    pixels = processed["pixel_values"].to(device, non_blocking=False)
    encoder.eval()
    with torch.inference_mode(), _amp_context(torch, device):
        encoded = encoder(pixel_values=pixels).last_hidden_state
    expected = (len(image_groups) * len(base.VIEW_NAMES), PATCH_COUNT, HIDDEN_SIZE)
    if tuple(encoded.shape) != expected or not bool(torch.isfinite(encoded).all()):
        raise MangaFontV7Mass21Error(
            f"SigLIP2 dynamic patch shape drifted: {tuple(encoded.shape)}"
        )
    return encoded.detach().reshape(
        len(image_groups), len(base.VIEW_NAMES), PATCH_COUNT, HIDDEN_SIZE
    )


def _human_lookup(inputs: mass21.Mass21TrainingInputs) -> HumanLookup:
    values = {
        example.sample_id: index
        for index, example in enumerate(inputs.human.addition_examples)
    }
    if len(values) != len(inputs.human.addition_examples):
        raise MangaFontV7Mass21Error("duplicate addition human sample id")
    required = {
        example.sample_id for example in inputs.human.upgraded_full_examples
    } | {example.sample_id for example in inputs.human.partial_examples}
    if not required <= set(values):
        raise MangaFontV7Mass21Error("human supervision lookup drifted")
    return HumanLookup(values)


def _stack_numpy_rows(
    torch: Any,
    rows: Sequence[np.ndarray],
    *,
    device: Any,
    dtype: Any,
) -> Any:
    if not rows:
        raise MangaFontV7Mass21Error("cannot stack an empty supervised batch")
    values = np.ascontiguousarray(np.stack(rows, axis=0))
    return torch.from_numpy(values).to(device=device, dtype=dtype, non_blocking=False)


def _weighted_three_view_consistency_loss(
    torch: Any, view_embeddings: Any, row_weights: Any
) -> Any:
    if (
        view_embeddings.ndim != 4
        or view_embeddings.shape[1] != len(base.VIEW_NAMES)
        or row_weights.ndim != 1
        or row_weights.shape[0] != view_embeddings.shape[0]
    ):
        raise MangaFontV7Mass21Error("weighted consistency tensor shape drifted")
    center = torch.nn.functional.normalize(
        view_embeddings.float().mean(dim=1), p=2, dim=-1
    )
    similarity = (view_embeddings.float() * center[:, None]).sum(dim=-1)
    per_row = (1.0 - similarity).mean(dim=(1, 2))
    weights = row_weights.float().clamp(min=0.0)
    return (per_row * weights).sum() / weights.sum().clamp(min=1e-6)


def _open_training_batch(
    *,
    torch: Any,
    batch: mass21.Mass21EpochBatch,
    inputs: mass21.Mass21TrainingInputs,
    arrays: Mapping[str, np.ndarray],
    lookup: HumanLookup,
    master_handle: BinaryIO,
    master_resolver: Any,
    human_resolver: Any,
    encoder: Any,
    processor: Any,
    device: Any,
) -> dict[str, Any]:
    real_entries = [inputs.real.entries[index] for index in batch.real_indices]
    real_groups: list[list[Any]] = []
    for entry in real_entries:
        row = mass21.read_real_train_row(inputs.real, entry, handle=master_handle)
        real_groups.append(mass21.open_real_train_views(row, master_resolver))

    full_sources = [
        mass21.resolve_full_human_index(index) for index in batch.full_human_indices
    ]
    full_dynamic_examples: list[Any] = []
    full_dynamic_slot: dict[int, int] = {}
    for batch_index, source in enumerate(full_sources):
        if source.source == "upgraded_full21_pixels":
            full_dynamic_slot[batch_index] = len(full_dynamic_examples)
            full_dynamic_examples.append(
                inputs.human.upgraded_full_examples[source.source_index]
            )
        elif source.source != "cached_original_full21":
            raise MangaFontV7Mass21Error("unknown full-human batch source")
    partial_examples = [
        inputs.human.partial_examples[index] for index in batch.partial_human_indices
    ]
    human_groups = [
        base._open_human_views(example, human_resolver)  # noqa: SLF001
        for example in (*full_dynamic_examples, *partial_examples)
    ]
    dynamic = _encode_image_groups(
        torch=torch,
        encoder=encoder,
        processor=processor,
        image_groups=(*real_groups, *human_groups),
        device=device,
    )
    real_count = len(real_entries)
    full_dynamic_offset = real_count
    partial_offset = real_count + len(full_dynamic_examples)

    full_tokens: list[Any] = []
    full_targets: list[np.ndarray] = []
    full_masks: list[np.ndarray] = []
    for batch_index, source in enumerate(full_sources):
        if source.source == "cached_original_full21":
            full_tokens.append(
                torch.from_numpy(arrays["human_train_tokens"][source.source_index]).to(
                    device=device, dtype=torch.float16, non_blocking=False
                )
            )
            full_targets.append(arrays["human_train_targets"][source.source_index])
            full_masks.append(arrays["human_train_masks"][source.source_index])
        else:
            dynamic_index = full_dynamic_slot[batch_index]
            full_tokens.append(dynamic[full_dynamic_offset + dynamic_index])
            example = full_dynamic_examples[dynamic_index]
            addition_index = lookup.addition_index_by_id[example.sample_id]
            full_targets.append(inputs.human.addition_targets[addition_index])
            full_masks.append(inputs.human.addition_masks[addition_index])

    partial_targets: list[np.ndarray] = []
    partial_masks: list[np.ndarray] = []
    for example in partial_examples:
        addition_index = lookup.addition_index_by_id[example.sample_id]
        partial_targets.append(inputs.human.addition_targets[addition_index])
        partial_masks.append(inputs.human.addition_masks[addition_index])

    synthetic_index = np.asarray(batch.synthetic_indices, dtype=np.int64)
    synthetic_tokens = torch.from_numpy(
        np.ascontiguousarray(arrays["synthetic_tokens"][synthetic_index])
    ).to(device=device, dtype=torch.float16, non_blocking=False)
    synthetic_labels = torch.from_numpy(
        np.ascontiguousarray(arrays["synthetic_labels"][synthetic_index])
    ).to(device=device, dtype=torch.long, non_blocking=False)
    real_weights = torch.tensor(
        [entry.work_weight for entry in real_entries],
        device=device,
        dtype=torch.float32,
    )
    real_ids = [entry.sample_id for entry in real_entries]
    pseudo_positions: list[int] = []
    pseudo_targets: list[tuple[float, ...]] = []
    pseudo_weights: list[float] = []
    for position, (sample_id, entry) in enumerate(zip(real_ids, real_entries, strict=True)):
        target = inputs.pseudo.targets.get(sample_id)
        if target is None:
            continue
        pseudo_positions.append(position)
        pseudo_targets.append(target.probabilities)
        pseudo_weights.append(target.weight * entry.work_weight)

    tokens = torch.cat(
        (
            dynamic[:real_count],
            torch.stack(full_tokens, dim=0),
            dynamic[partial_offset : partial_offset + len(partial_examples)],
            synthetic_tokens,
        ),
        dim=0,
    )
    return {
        "full_count": len(full_sources),
        "full_masks": _stack_numpy_rows(
            torch, full_masks, device=device, dtype=torch.bool
        ),
        "full_targets": _stack_numpy_rows(
            torch, full_targets, device=device, dtype=torch.float32
        ),
        "partial_count": len(partial_examples),
        "partial_masks": _stack_numpy_rows(
            torch, partial_masks, device=device, dtype=torch.bool
        ),
        "partial_targets": _stack_numpy_rows(
            torch, partial_targets, device=device, dtype=torch.float32
        ),
        "pseudo_positions": torch.tensor(
            pseudo_positions, device=device, dtype=torch.long
        ),
        "pseudo_targets": (
            torch.tensor(pseudo_targets, device=device, dtype=torch.float32)
            if pseudo_targets
            else None
        ),
        "pseudo_weights": (
            torch.tensor(pseudo_weights, device=device, dtype=torch.float32)
            if pseudo_weights
            else None
        ),
        "real_count": real_count,
        "real_weights": real_weights,
        "synthetic_count": len(batch.synthetic_indices),
        "synthetic_labels": synthetic_labels,
        "tokens": tokens,
    }


def _loss_weights(args: argparse.Namespace) -> LossWeights:
    return LossWeights(
        synthetic=args.synthetic_weight,
        full_human=args.full_human_weight,
        partial_human=args.partial_human_weight,
        real_consistency=args.real_consistency_weight,
        domain_moment=args.domain_moment_weight,
        pseudo=args.pseudo_weight,
        attention_diversity=args.attention_diversity_weight,
    )


def _compute_losses(
    *,
    torch: Any,
    result: Mapping[str, Any],
    batch: Mapping[str, Any],
    weights: LossWeights,
) -> tuple[Any, dict[str, Any]]:
    real_count = int(batch["real_count"])
    full_count = int(batch["full_count"])
    partial_count = int(batch["partial_count"])
    synthetic_count = int(batch["synthetic_count"])
    full_start = real_count
    partial_start = full_start + full_count
    synthetic_start = partial_start + partial_count
    logits = result["candidate_scores"]
    views = result["view_embeddings"]
    expected_rows = real_count + full_count + partial_count + synthetic_count
    if logits.shape != (expected_rows, mass21.ACTIVE_CANDIDATE_COUNT):
        raise MangaFontV7Mass21Error("active21 batch score shape drifted")

    synthetic_loss = torch.nn.functional.cross_entropy(
        logits[synthetic_start:], batch["synthetic_labels"]
    )
    full_loss = mass21.masked_human_loss(
        torch,
        logits[full_start:partial_start],
        batch["full_targets"],
        batch["full_masks"],
    )
    partial_loss = mass21.masked_human_loss(
        torch,
        logits[partial_start:synthetic_start],
        batch["partial_targets"],
        batch["partial_masks"],
    )
    real_consistency = _weighted_three_view_consistency_loss(
        torch, views[:real_count], batch["real_weights"]
    )
    domain = mass21.domain_moment_loss(
        torch,
        views[:real_count],
        views[synthetic_start:],
        real_weights=batch["real_weights"],
    )
    diversity = v6.attention_diversity_loss(torch, result["attention"])
    if batch["pseudo_targets"] is None:
        pseudo = logits.sum() * 0.0
        pseudo_rows = 0
    else:
        pseudo_logits = logits[:real_count].index_select(
            0, batch["pseudo_positions"]
        )
        pseudo = mass21.pseudo_soft_target_loss(
            torch,
            pseudo_logits,
            batch["pseudo_targets"],
            batch["pseudo_weights"],
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
    components = {
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
    return total, components


def _epoch_batches(
    args: argparse.Namespace,
    inputs: mass21.Mass21TrainingInputs,
    epoch: int,
) -> tuple[mass21.Mass21EpochBatch, ...]:
    if epoch == 1:
        return inputs.epoch_batches
    return mass21.build_epoch_batches(
        real_count=len(inputs.real.entries),
        full_human_count=mass21.SUPERVISED_FULL21_ROWS,
        partial_human_count=mass21.SUPERVISED_PARTIAL15_ROWS,
        synthetic_count=mass21.SYNTHETIC21_ROWS,
        real_batch_size=args.real_batch_size,
        full_human_batch_size=args.full_human_batch_size,
        partial_human_batch_size=args.partial_human_batch_size,
        synthetic_batch_size=args.synthetic_batch_size,
        seed=args.seed + epoch - 1,
    )


def _coverage_record(
    batches: Sequence[mass21.Mass21EpochBatch],
) -> dict[str, Any]:
    real = {index for batch in batches for index in batch.real_indices}
    full = {index for batch in batches for index in batch.full_human_indices}
    partial = {index for batch in batches for index in batch.partial_human_indices}
    synthetic = {index for batch in batches for index in batch.synthetic_indices}
    return {
        "full_human_unique": len(full),
        "partial_human_unique": len(partial),
        "real_rows": sum(len(batch.real_indices) for batch in batches),
        "real_unique": len(real),
        "synthetic_unique": len(synthetic),
    }


def _checkpoint_payload(
    *,
    torch: Any,
    args: argparse.Namespace,
    candidate_ids: tuple[str, ...],
    model: Any,
    optimizer: Any,
    epoch: int,
    next_step: int,
    stale_epochs: int,
    best_metrics: Mapping[str, Any] | None,
    best_predictions: Sequence[Mapping[str, Any]] | None,
    best_state: Mapping[str, Any] | None,
    best_prototypes: Any | None,
    best_epoch: int,
    history: Sequence[Mapping[str, Any]],
    epoch_sums: Mapping[str, float],
    epoch_steps: int,
    source_fingerprint: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "best_epoch": best_epoch,
        "best_metrics": copy.deepcopy(best_metrics),
        "best_predictions": copy.deepcopy(best_predictions),
        "best_prototypes": (
            best_prototypes.detach().float().cpu()
            if best_prototypes is not None
            else None
        ),
        "best_state": copy.deepcopy(best_state),
        "candidate_ids": candidate_ids,
        "configuration": _configuration(args),
        "configuration_sha256": _configuration_sha256(args),
        "epoch": epoch,
        "epoch_steps": epoch_steps,
        "epoch_sums": dict(epoch_sums),
        "history": copy.deepcopy(list(history)),
        "model_state": v6._state_cpu(model),  # noqa: SLF001
        "next_step": next_step,
        "optimizer_state": optimizer.state_dict(),
        "schema_version": RUN_STATE_SCHEMA,
        "source_fingerprint": copy.deepcopy(dict(source_fingerprint)),
        "stale_epochs": stale_epochs,
        "torch_rng_state": torch.get_rng_state(),
    }


def _write_run_checkpoint(
    *,
    torch: Any,
    run_state_dir: Path,
    payload: Mapping[str, Any],
) -> None:
    root = _safe_directory(run_state_dir, location="run-state directory")
    root.mkdir(parents=True, exist_ok=True)
    checkpoint = root / RUN_STATE_CHECKPOINT
    handle, raw_name = tempfile.mkstemp(prefix=".checkpoint.", dir=root)
    os.close(handle)
    temporary = Path(raw_name)
    try:
        torch.save(dict(payload), temporary)
        os.replace(temporary, checkpoint)
    finally:
        if temporary.exists():
            temporary.unlink()
    marker = {
        "checkpoint_sha256": base.sha256_file(checkpoint),
        "owner": OWNER,
        "safe_replace": True,
        "schema_version": RUN_STATE_SCHEMA,
    }
    _atomic_write_bytes(root / RUN_STATE_MARKER, base.json_bytes(marker, pretty=True))


def _validate_run_state(run_state_dir: Path) -> dict[str, Any]:
    root = run_state_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV7Mass21Error("run-state directory is missing or linked")
    if {path.name for path in root.iterdir()} != RUN_STATE_FILES:
        raise MangaFontV7Mass21Error("run-state inventory drifted")
    marker = base.read_json(root / RUN_STATE_MARKER, location="v7 run-state marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != RUN_STATE_SCHEMA
        or marker.get("checkpoint_sha256")
        != base.sha256_file(root / RUN_STATE_CHECKPOINT)
    ):
        raise MangaFontV7Mass21Error("run-state marker drifted")
    return marker


def _load_run_checkpoint(
    *,
    torch: Any,
    args: argparse.Namespace,
    run_state_dir: Path,
    source_fingerprint: Mapping[str, Any],
    candidate_ids: tuple[str, ...],
    device: Any,
) -> dict[str, Any]:
    _validate_run_state(run_state_dir)
    try:
        payload = torch.load(
            run_state_dir.expanduser().resolve() / RUN_STATE_CHECKPOINT,
            map_location=device,
            weights_only=False,
        )
    except (OSError, RuntimeError, ValueError, TypeError) as error:
        raise MangaFontV7Mass21Error("cannot load sealed run checkpoint") from error
    record = dict(_mapping(payload, "v7 run checkpoint"))
    if (
        record.get("schema_version") != RUN_STATE_SCHEMA
        or tuple(record.get("candidate_ids", ())) != candidate_ids
        or record.get("configuration_sha256") != _configuration_sha256(args)
        or record.get("source_fingerprint") != dict(source_fingerprint)
    ):
        raise MangaFontV7Mass21Error("resume checkpoint contract drifted")
    return record


def _state_to_optimizer_device(torch: Any, optimizer: Any, device: Any) -> None:
    for state in optimizer.state.values():
        for key, value in tuple(state.items()):
            if torch.is_tensor(value):
                state[key] = value.to(device)


def _evaluate_val(
    *,
    torch: Any,
    model: Any,
    val_tokens: Any,
    val_targets: Any,
    val_masks: Any,
    val_roles: Any,
    reference_tokens: Any,
    reference_labels: Any,
    candidate_ids: tuple[str, ...],
    device: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]], Any]:
    model.eval()
    with torch.inference_mode(), _amp_context(torch, device):
        result = model(
            val_tokens,
            reference_tokens,
            reference_labels,
            len(candidate_ids),
        )
    metrics, predictions = v6.compute_val_metrics(
        torch=torch,
        logits=result["candidate_scores"],
        targets=val_targets,
        masks=val_masks,
        roles=val_roles,
        candidate_ids=candidate_ids,
    )
    if (
        int(metrics.get("evaluated_positive_rows", 0)) != VAL_ROWS
        or int(metrics.get("variant_val_rows", 0)) != VARIANT_VAL_ROWS
    ):
        raise MangaFontV7Mass21Error("val33 selection boundary drifted")
    return metrics, predictions, result["candidate_prototypes"].detach().float().cpu()


def _runtime(
    args: argparse.Namespace,
    inputs: mass21.Mass21TrainingInputs,
) -> dict[str, Any]:
    if inputs.cached_arrays is None:
        raise MangaFontV7Mass21Error("training requires projected cached arrays")
    torch, processor_class, vision_class, save_file = (
        base._load_training_dependencies()  # noqa: SLF001
    )
    device = torch.device(args.device)
    if device.type == "cuda":
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise MangaFontV7Mass21Error("CUDA bf16 is required for mass training")
    elif device.type != "cpu":
        raise MangaFontV7Mass21Error("device must be cuda or cpu")
    base._configure_reproducibility(torch, seed=args.seed)  # noqa: SLF001
    processor = processor_class.from_pretrained(
        base.MODEL_ID,
        revision=base.MODEL_REVISION,
        use_fast=base.PROCESSOR_USE_FAST,
        local_files_only=True,
    )
    encoder = (
        vision_class.from_pretrained(
            base.MODEL_ID,
            revision=base.MODEL_REVISION,
            local_files_only=True,
        )
        .eval()
        .requires_grad_(False)
        .to(device)
    )
    model = v6.build_font_query_head(
        torch,
        query_count=QUERY_COUNT,
        query_dim=QUERY_DIM,
    ).to(device)
    model.load_state_dict(_load_r3_state(args), strict=True)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.head_lr, weight_decay=args.weight_decay
    )
    arrays = inputs.cached_arrays
    reference_tokens = torch.from_numpy(arrays["reference_tokens"]).to(
        device=device, dtype=torch.float16, non_blocking=False
    )
    reference_labels = torch.from_numpy(arrays["reference_labels"]).to(
        device=device, dtype=torch.long, non_blocking=False
    )
    val_tokens = torch.from_numpy(arrays["human_val_tokens"]).to(
        device=device, dtype=torch.float16, non_blocking=False
    )
    val_targets = torch.from_numpy(arrays["human_val_targets"]).to(
        device=device, dtype=torch.float32, non_blocking=False
    )
    val_masks = torch.from_numpy(arrays["human_val_masks"]).to(
        device=device, dtype=torch.bool, non_blocking=False
    )
    val_roles = torch.from_numpy(arrays["human_val_roles"]).to(
        device=device, dtype=torch.long, non_blocking=False
    )
    return {
        "arrays": arrays,
        "device": device,
        "encoder": encoder,
        "model": model,
        "optimizer": optimizer,
        "processor": processor,
        "reference_labels": reference_labels,
        "reference_tokens": reference_tokens,
        "save_file": save_file,
        "torch": torch,
        "val_masks": val_masks,
        "val_roles": val_roles,
        "val_targets": val_targets,
        "val_tokens": val_tokens,
    }


def _train_or_smoke(
    args: argparse.Namespace,
    *,
    dry_steps: int | None,
) -> Mapping[str, Any]:
    command_started = time.monotonic()
    if dry_steps is None and _safe_directory(
        args.output_dir, location="output directory"
    ).exists():
        raise MangaFontV7Mass21Error("output already exists")
    inputs = _build_inputs(args, load_cached_arrays=True)
    candidate_ids = inputs.projection.active_ids
    if (
        len(candidate_ids) != mass21.ACTIVE_CANDIDATE_COUNT
        or mass21.RETIRED_FONT_ID in candidate_ids
    ):
        raise MangaFontV7Mass21Error("active21 vocabulary is unsafe")
    runtime = _runtime(args, inputs)
    torch = runtime["torch"]
    device = runtime["device"]
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    model = runtime["model"]
    optimizer = runtime["optimizer"]
    source_fingerprint = _source_fingerprint(args)
    run_state_dir = _safe_directory(args.run_state_dir, location="run-state directory")
    lookup = _human_lookup(inputs)
    master_resolver = catalog_assets.CatalogAssetResolver(
        args.master_catalog_registry.expanduser().resolve()
    )
    human_resolver = catalog_assets.CatalogAssetResolver(
        args.human_catalog_registry.expanduser().resolve()
    )
    history: list[dict[str, Any]] = []
    best_metrics: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    best_state: dict[str, Any] | None = None
    best_prototypes: Any | None = None
    best_epoch = 0
    stale_epochs = 0
    start_epoch = 1
    start_step = 0
    epoch_sums: Counter[str] = Counter()
    epoch_steps_done = 0
    if dry_steps is None:
        if args.resume:
            payload = _load_run_checkpoint(
                torch=torch,
                args=args,
                run_state_dir=run_state_dir,
                source_fingerprint=source_fingerprint,
                candidate_ids=candidate_ids,
                device=device,
            )
            model.load_state_dict(payload["model_state"], strict=True)
            optimizer.load_state_dict(payload["optimizer_state"])
            _state_to_optimizer_device(torch, optimizer, device)
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
            torch.set_rng_state(payload["torch_rng_state"].cpu())
        elif run_state_dir.exists():
            raise MangaFontV7Mass21Error(
                "run-state exists; pass --resume or select a new run-state directory"
            )
    weights = _loss_weights(args)
    started = time.monotonic()
    total_smoke_steps = 0
    stop_training = False
    with inputs.real.manifest_path.open("rb") as master_handle:
        for epoch in range(start_epoch, args.epochs + 1):
            batches = _epoch_batches(args, inputs, epoch)
            if start_step > len(batches):
                raise MangaFontV7Mass21Error("resume step escaped epoch schedule")
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
                with _amp_context(torch, device):
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
                    raise MangaFontV7Mass21Error("mass21 loss became nonfinite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
                optimizer.step()
                for name, value in components.items():
                    epoch_sums[name] += (
                        float(value.detach().item())
                        if hasattr(value, "detach")
                        else float(value)
                    )
                epoch_steps_done += 1
                total_smoke_steps += 1
                if dry_steps is not None and total_smoke_steps >= dry_steps:
                    if device.type == "cuda":
                        torch.cuda.synchronize(device)
                        peak_allocated = torch.cuda.max_memory_allocated(device) / (
                            1024**3
                        )
                        peak_reserved = torch.cuda.max_memory_reserved(device) / (
                            1024**3
                        )
                    else:
                        peak_allocated = None
                        peak_reserved = None
                    return {
                        **dict(inputs.summary),
                        "batch": {
                            "full_human": prepared["full_count"],
                            "partial_human": prepared["partial_count"],
                            "pseudo_rows": components["pseudo_rows"],
                            "real": prepared["real_count"],
                            "synthetic": prepared["synthetic_count"],
                        },
                        "device": str(device),
                        "dry_smoke_status": "bounded_real_training_steps_completed",
                        "elapsed_seconds": time.monotonic() - command_started,
                        "losses": {
                            name: float(value.detach().item())
                            for name, value in components.items()
                            if hasattr(value, "detach")
                        },
                        "peak_gpu_allocated_gib": peak_allocated,
                        "peak_gpu_reserved_gib": peak_reserved,
                        "steps": total_smoke_steps,
                        "training_loop_elapsed_seconds": time.monotonic() - started,
                        "test_rows_opened": 0,
                        "val_rows_used_for_optimizer": 0,
                    }
                next_step = step_index + 1
                if (
                    args.checkpoint_steps > 0
                    and next_step % args.checkpoint_steps == 0
                ):
                    payload = _checkpoint_payload(
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
                    )
                    _write_run_checkpoint(
                        torch=torch, run_state_dir=run_state_dir, payload=payload
                    )

            metrics, predictions, prototypes = _evaluate_val(
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
            improved = best_metrics is None or v6._metric_key(metrics) > v6._metric_key(  # noqa: SLF001
                best_metrics
            )
            if improved:
                best_metrics = copy.deepcopy(metrics)
                best_predictions = copy.deepcopy(predictions)
                best_state = v6._state_cpu(model)  # noqa: SLF001
                best_prototypes = prototypes
                best_epoch = epoch
                stale_epochs = 0
            else:
                stale_epochs += 1
            history.append(
                base.seal_record(
                    {
                        "coverage": _coverage_record(batches),
                        "epoch": epoch,
                        "improved": improved,
                        "record_type": "manga_font_student_v7_mass21_epoch",
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
            payload = _checkpoint_payload(
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
            )
            _write_run_checkpoint(
                torch=torch, run_state_dir=run_state_dir, payload=payload
            )
            epoch_sums = Counter()
            epoch_steps_done = 0
            start_step = 0
            if stale_epochs >= args.patience:
                stop_training = True
                break
    if dry_steps is not None:
        raise MangaFontV7Mass21Error("dry smoke produced no training step")
    if (
        best_metrics is None
        or best_predictions is None
        or best_state is None
        or best_prototypes is None
        or best_epoch < 1
    ):
        raise MangaFontV7Mass21Error("mass21 training produced no best model")
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
        run_state_dir=run_state_dir,
        source_fingerprint=source_fingerprint,
        timing_seconds=time.monotonic() - started,
        early_stopped=stop_training,
    )


def _publish_output(
    *,
    args: argparse.Namespace,
    inputs: mass21.Mass21TrainingInputs,
    runtime: Mapping[str, Any],
    candidate_ids: tuple[str, ...],
    history: Sequence[Mapping[str, Any]],
    best_metrics: Mapping[str, Any],
    best_predictions: Sequence[Mapping[str, Any]],
    best_state: Mapping[str, Any],
    best_prototypes: Any,
    best_epoch: int,
    run_state_dir: Path,
    source_fingerprint: Mapping[str, Any],
    timing_seconds: float,
    early_stopped: bool,
) -> Mapping[str, Any]:
    output = _safe_directory(args.output_dir, location="output directory")
    if output.exists():
        raise MangaFontV7Mass21Error("output already exists")
    _validate_run_state(run_state_dir)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        runtime["save_file"](
            dict(best_state),
            str(staging / BEST_HEAD),
            metadata={
                "format": SCHEMA,
                "kind": "active21-frozen-siglip2-patch-query-head",
            },
        )
        prototype_array = np.ascontiguousarray(
            best_prototypes.numpy(), dtype="<f4"
        )
        if prototype_array.shape != (
            mass21.ACTIVE_CANDIDATE_COUNT,
            QUERY_COUNT,
            QUERY_DIM,
        ):
            raise MangaFontV7Mass21Error("best prototype shape drifted")
        (staging / PROTOTYPES).write_bytes(prototype_array.tobytes())
        with (staging / PREDICTIONS).open("wb") as handle:
            for row in best_predictions:
                handle.write(base.json_bytes(row))
        with (staging / HISTORY).open("wb") as handle:
            for row in history:
                handle.write(base.json_bytes(row))
        shutil.copy2(
            run_state_dir.expanduser().resolve() / RUN_STATE_CHECKPOINT,
            staging / LATEST_CHECKPOINT,
        )
        gate = v6.research_gate(best_metrics)
        manifest = base.seal_record(
            {
                "architecture": {
                    "candidate_bias": False,
                    "candidate_scoring": "query-wise-cosine-to-reference-prototypes",
                    "encoder": base.MODEL_ID,
                    "encoder_revision": base.MODEL_REVISION,
                    "encoder_trainable_blocks": 0,
                    "input_representation": "three-view-last-hidden-state-patch-tokens",
                    "query_count": QUERY_COUNT,
                    "query_dim": QUERY_DIM,
                    "warm_start": "v6-r3-all160",
                },
                "best_epoch": best_epoch,
                "best_val": copy.deepcopy(dict(best_metrics)),
                "boundaries": {
                    **{
                        key: value
                        for key, value in inputs.summary.items()
                        if key.endswith("json_deserialized") or key.endswith("skipped")
                    },
                    "gugi_candidate_count": candidate_ids.count(
                        mass21.RETIRED_FONT_ID
                    ),
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "master_test_pixels_opened": 0,
                    "master_val_pixels_opened": 0,
                    "test_used_for_model_selection": False,
                    "val33_count": VAL_ROWS,
                    "val33_used_for_early_stop": True,
                    "val33_used_for_model_selection": True,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(candidate_ids),
                "configuration": _configuration(args),
                "early_stopped": early_stopped,
                "files": {
                    name: _descriptor(staging / name)
                    for name in (
                        BEST_HEAD,
                        HISTORY,
                        LATEST_CHECKPOINT,
                        PREDICTIONS,
                        PROTOTYPES,
                    )
                },
                "history_epochs": len(history),
                "inverse_work_weight": {
                    "applied_to": [
                        "domain_moment",
                        "pseudo_soft_target",
                        "real_three_view_consistency",
                    ],
                    "source": "master-v3.work_balance_weight",
                },
                "quality_gate": gate,
                "record_type": "manga_font_student_v7_mass21_training_manifest",
                "schema_version": SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "source_fingerprint": copy.deepcopy(dict(source_fingerprint)),
                "training_inventory": copy.deepcopy(dict(inputs.summary)),
                "training_seconds": timing_seconds,
            }
        )
        (staging / MANIFEST).write_bytes(base.json_bytes(manifest, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in OUTPUT_FILES - {MARKER}
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV7Mass21Error("v7 output is missing or linked")
    if {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise MangaFontV7Mass21Error("v7 output inventory drifted")
    marker = base.read_json(root / MARKER, location="v7 marker")
    manifest = base.read_json(root / MANIFEST, location="v7 manifest")
    base.validate_record_seal(manifest, location="v7 manifest")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or manifest.get("schema_version") != SCHEMA
        or manifest.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV7Mass21Error("v7 output metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v7 marker.artifacts")
    descriptors = _mapping(manifest.get("files"), "v7 manifest.files")
    for name in OUTPUT_FILES - {MARKER, MANIFEST}:
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV7Mass21Error(f"v7 output hash drifted: {name}")
        descriptor = _mapping(descriptors.get(name), f"v7 files.{name}")
        if (
            descriptor.get("file") != name
            or descriptor.get("sha256") != artifacts.get(name)
            or int(descriptor.get("byte_size", -1)) != (root / name).stat().st_size
        ):
            raise MangaFontV7Mass21Error(f"v7 descriptor drifted: {name}")
    if artifacts.get(MANIFEST) != base.sha256_file(root / MANIFEST):
        raise MangaFontV7Mass21Error("v7 manifest hash drifted")
    candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
    if (
        len(candidate_ids) != mass21.ACTIVE_CANDIDATE_COUNT
        or candidate_ids != mass21.candidate_projection(
            mass21.legacy15.FULL22_CANDIDATE_IDS
        ).active_ids
        or mass21.RETIRED_FONT_ID in candidate_ids
    ):
        raise MangaFontV7Mass21Error("v7 active21 vocabulary drifted")
    boundaries = _mapping(manifest.get("boundaries"), "v7 boundaries")
    required_zero = (
        "gugi_candidate_count",
        "human_test_labels_deserialized",
        "human_test_pixels_opened",
        "master_test_rows_json_deserialized",
        "master_test_pixels_opened",
        "master_val_rows_json_deserialized",
        "master_val_pixels_opened",
    )
    if (
        any(int(boundaries.get(name, -1)) != 0 for name in required_zero)
        or int(boundaries.get("val33_count", 0)) != VAL_ROWS
        or boundaries.get("test_used_for_model_selection") is not False
        or boundaries.get("val33_used_for_early_stop") is not True
        or boundaries.get("val33_used_for_model_selection") is not True
        or boundaries.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV7Mass21Error("v7 leakage boundary drifted")
    history: list[Mapping[str, Any]] = []
    with (root / HISTORY).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = _mapping(json.loads(line), f"v7 history:{line_number}")
            except json.JSONDecodeError as error:
                raise MangaFontV7Mass21Error("v7 history is invalid JSONL") from error
            base.validate_record_seal(row, location=f"v7 history:{line_number}")
            if (
                row.get("schema_version") != SCHEMA
                or int(row.get("epoch", 0)) != line_number
                or int(_mapping(row.get("coverage"), "v7 coverage").get("real_unique", 0))
                != mass21.MASTER_TRAIN_ROWS
            ):
                raise MangaFontV7Mass21Error("v7 history boundary drifted")
            history.append(row)
    if not history or len(history) != int(manifest.get("history_epochs", 0)):
        raise MangaFontV7Mass21Error("v7 history inventory drifted")
    best = _mapping(manifest.get("best_val"), "v7 best val")
    if (
        int(best.get("evaluated_positive_rows", 0)) != VAL_ROWS
        or int(best.get("variant_val_rows", 0)) != VARIANT_VAL_ROWS
    ):
        raise MangaFontV7Mass21Error("v7 best-val boundary drifted")
    expected_prototype_bytes = (
        mass21.ACTIVE_CANDIDATE_COUNT * QUERY_COUNT * QUERY_DIM * 4
    )
    if (root / PROTOTYPES).stat().st_size != expected_prototype_bytes:
        raise MangaFontV7Mass21Error("v7 prototype byte size drifted")
    prediction_count = 0
    with (root / PREDICTIONS).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                prediction = _mapping(
                    json.loads(line), f"v7 prediction:{line_number}"
                )
            except json.JSONDecodeError as error:
                raise MangaFontV7Mass21Error(
                    "v7 predictions are invalid JSONL"
                ) from error
            base.validate_record_seal(
                prediction, location=f"v7 prediction:{line_number}"
            )
            ranked = prediction.get("ranked_candidates")
            if (
                prediction.get("split") != "val"
                or not isinstance(ranked, list)
                or len(ranked) != mass21.ACTIVE_CANDIDATE_COUNT
                or any(
                    _mapping(value, "v7 ranked candidate").get("candidate_id")
                    == mass21.RETIRED_FONT_ID
                    for value in ranked
                )
            ):
                raise MangaFontV7Mass21Error("v7 prediction boundary drifted")
            prediction_count += 1
    if prediction_count != VAL_ROWS:
        raise MangaFontV7Mass21Error("v7 prediction count drifted")
    return {
        "best_epoch": int(manifest.get("best_epoch", 0)),
        "candidate_count": len(candidate_ids),
        "history_epochs": len(history),
        "output_dir": str(root),
        "status": "validated_v7_mass21_training_output",
        "test_rows_opened": 0,
    }


def _add_data_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-patch-cache-v1"),
    )
    parser.add_argument(
        "--r3-output-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-fontquery-r3-all160-v1"),
    )
    parser.add_argument(
        "--authority-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1"
        ),
    )
    parser.add_argument(
        "--review-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"),
    )
    parser.add_argument(
        "--draft-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1"
        ),
    )
    parser.add_argument(
        "--legacy-overlay-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy15-train-overlay-v1"),
    )
    parser.add_argument(
        "--human-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v2.json"),
    )
    parser.add_argument(
        "--master-dir",
        type=Path,
        default=Path("datasets/font-matching-master-v3"),
    )
    parser.add_argument(
        "--master-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    parser.add_argument("--pseudo-labels", type=Path)


def _add_training_configuration(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--real-batch-size", type=int, default=16)
    parser.add_argument("--full-human-batch-size", type=int, default=4)
    parser.add_argument("--partial-human-batch-size", type=int, default=4)
    parser.add_argument("--synthetic-batch-size", type=int, default=16)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--head-lr", type=float, default=8e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--synthetic-weight", type=float, default=1.0)
    parser.add_argument("--full-human-weight", type=float, default=6.0)
    parser.add_argument("--partial-human-weight", type=float, default=5.0)
    parser.add_argument("--real-consistency-weight", type=float, default=0.15)
    parser.add_argument("--domain-moment-weight", type=float, default=0.05)
    parser.add_argument("--pseudo-weight", type=float, default=0.10)
    parser.add_argument("--attention-diversity-weight", type=float, default=0.01)
    parser.add_argument("--checkpoint-steps", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260803)


def _validate_cli_configuration(args: argparse.Namespace) -> None:
    integer_values = {
        "epochs": args.epochs,
        "full-human batch": args.full_human_batch_size,
        "partial-human batch": args.partial_human_batch_size,
        "patience": args.patience,
        "real batch": args.real_batch_size,
        "synthetic batch": args.synthetic_batch_size,
    }
    if any(value < 1 for value in integer_values.values()):
        raise MangaFontV7Mass21Error("training counts and batch sizes must be positive")
    if args.checkpoint_steps < 0:
        raise MangaFontV7Mass21Error("checkpoint steps must be nonnegative")
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
        raise MangaFontV7Mass21Error("training weights must be finite and positive")
    if not math.isfinite(args.pseudo_weight) or not 0.0 <= args.pseudo_weight <= 0.20:
        raise MangaFontV7Mass21Error("pseudo weight must remain inside [0,0.20]")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("preflight")
    _add_data_inputs(preflight)
    _add_training_configuration(preflight)
    dry_smoke = commands.add_parser("dry-smoke")
    _add_data_inputs(dry_smoke)
    _add_training_configuration(dry_smoke)
    dry_smoke.set_defaults(
        real_batch_size=2,
        full_human_batch_size=1,
        partial_human_batch_size=1,
        synthetic_batch_size=2,
    )
    dry_smoke.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    dry_smoke.add_argument("--smoke-steps", type=int, default=1)
    dry_smoke.add_argument(
        "--run-state-dir", type=Path, default=Path("artifacts/.v7-mass21-dry-smoke")
    )
    dry_smoke.add_argument(
        "--output-dir", type=Path, default=Path("artifacts/.v7-mass21-dry-output")
    )
    dry_smoke.set_defaults(resume=False)
    train = commands.add_parser("train")
    _add_data_inputs(train)
    _add_training_configuration(train)
    train.add_argument("--device", choices=("cuda",), default="cuda")
    train.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-v1"),
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
                inputs = _build_inputs(args, load_cached_arrays=False)
                result = _preflight_plan(args, inputs)
            else:
                if args.command == "train" and args.run_state_dir is None:
                    args.run_state_dir = args.output_dir.with_name(
                        args.output_dir.name + ".run-state"
                    )
                if args.command == "dry-smoke" and not 1 <= args.smoke_steps <= 4:
                    raise MangaFontV7Mass21Error("dry smoke steps must be 1..4")
                result = _train_or_smoke(
                    args,
                    dry_steps=args.smoke_steps if args.command == "dry-smoke" else None,
                )
    except (
        MangaFontV7Mass21Error,
        mass21.MangaFontMass21DataError,
        catalog_assets.CatalogAssetError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-v7-mass21 error: {error}") from error
    print(base.canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
