#!/usr/bin/env python3
"""Cache v2 embeddings and run bounded MangaFont v3 head-only sweeps.

The cache contains only synthetic-train, human-train, and adjudicated
human-validation embeddings.  Hidden-test rows and pixels are never opened.
Four tiny ranker trials can then run without repeating SigLIP inference; the
best sealed head is an initialization for the short v3 encoder fine-tune, not
a deployable runtime by itself.
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
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v2 as v2
    from scripts import train_manga_font_student_v3 as v3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v2 as v2
    import train_manga_font_student_v3 as v3


CACHE_SCHEMA = "manga-font-student-v3-embedding-cache-v1"
CACHE_OWNER = "carrot-manga-translator/manga-font-student-v3-embedding-cache-v1"
CACHE_MARKER = ".manga-font-student-v3-embedding-cache-v1-owned.json"
CACHE_CONTRACT = "cache-contract.json"
CACHE_ARRAYS = "embeddings-and-targets.npz"
CACHE_FILES = frozenset({CACHE_MARKER, CACHE_CONTRACT, CACHE_ARRAYS})

SWEEP_SCHEMA = "manga-font-student-v3-head-sweep-v1"
SWEEP_OWNER = "carrot-manga-translator/manga-font-student-v3-head-sweep-v1"
SWEEP_MARKER = ".manga-font-student-v3-head-sweep-v1-owned.json"
SWEEP_REPORT = "sweep-report.json"
SWEEP_CHECKPOINT = "best-head.safetensors"
SWEEP_FILES = frozenset({SWEEP_MARKER, SWEEP_REPORT, SWEEP_CHECKPOINT})


class MangaFontV3SweepError(v3.MangaFontStudentV3Error):
    """Raised when a v3 embedding cache or head sweep is unsafe."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV3SweepError(f"{location}: expected object")
    return value


def _safe_output(path: Path) -> Path:
    return base._safe_output_path(path)  # noqa: SLF001


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV3SweepError(f"missing cache/sweep file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _assert_inventory(root: Path, expected: frozenset[str], location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV3SweepError(f"{location}: missing regular directory")
    names = {path.name for path in root.iterdir()}
    if names != expected or any(path.is_symlink() for path in root.iterdir()):
        raise MangaFontV3SweepError(f"{location}: exact inventory drifted")


def select_balanced_synthetic_subset(
    examples: Sequence[base.SyntheticExample],
    *,
    candidate_ids: tuple[str, ...],
    metadata: Mapping[str, Mapping[str, Any]],
    per_font: int,
) -> tuple[base.SyntheticExample, ...]:
    """Select equal fonts while cycling through role/orientation signatures."""

    if not 16 <= per_font <= 128:
        raise MangaFontV3SweepError("cache synthetic-per-font must be 16..128")
    grouped: dict[str, dict[tuple[str, str, str], list[base.SyntheticExample]]] = {
        candidate_id: {} for candidate_id in candidate_ids
    }
    for example in examples:
        if example.font_id not in grouped:
            continue
        signature = v2.prototype_signature(metadata[example.sample_id])
        grouped[example.font_id].setdefault(signature, []).append(example)
    selected: list[base.SyntheticExample] = []
    for candidate_id in candidate_ids:
        buckets = grouped[candidate_id]
        if len(buckets) < 8:
            raise MangaFontV3SweepError(
                f"{candidate_id}: insufficient cache signature diversity"
            )
        for rows in buckets.values():
            rows.sort(key=lambda value: value.sample_id)
        offsets = {signature: 0 for signature in buckets}
        signatures = sorted(buckets)
        chosen: list[base.SyntheticExample] = []
        while len(chosen) < per_font:
            progressed = False
            for signature in signatures:
                offset = offsets[signature]
                rows = buckets[signature]
                if offset < len(rows):
                    chosen.append(rows[offset])
                    offsets[signature] += 1
                    progressed = True
                    if len(chosen) == per_font:
                        break
            if not progressed:
                break
        if len(chosen) != per_font:
            raise MangaFontV3SweepError(
                f"{candidate_id}: insufficient balanced cache examples"
            )
        selected.extend(chosen)
    return tuple(selected)


def _load_v2_student(
    *,
    warm_start_dir: Path,
    candidate_ids: tuple[str, ...],
) -> tuple[Any, Any, Any]:
    torch, processor_class, vision_class, _save_file = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise MangaFontV3SweepError("embedding cache requires CUDA bf16")
    v3._validate_warm_start(warm_start_dir, candidate_ids=candidate_ids)  # noqa: SLF001
    processor = processor_class.from_pretrained(
        base.MODEL_ID,
        revision=base.MODEL_REVISION,
        use_fast=base.PROCESSOR_USE_FAST,
        local_files_only=True,
    )
    vision = vision_class.from_pretrained(
        base.MODEL_ID,
        revision=base.MODEL_REVISION,
        local_files_only=True,
    )
    student, _ = base.build_student_model(
        torch, vision_encoder=vision, candidate_count=len(candidate_ids)
    )
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover - dependency setup
        raise MangaFontV3SweepError("safetensors is required") from error
    state = dict(
        load_file(
            str(
                warm_start_dir.expanduser().resolve() / base.CHECKPOINT_FILE
            ),
            device="cpu",
        )
    )
    parameters = dict(student.named_parameters())
    trainable = {name for name, value in parameters.items() if value.requires_grad}
    if set(state) != trainable:
        raise MangaFontV3SweepError("sealed v2 checkpoint parameter set drifted")
    with torch.no_grad():
        for name, value in state.items():
            parameter = parameters[name]
            if tuple(parameter.shape) != tuple(value.shape):
                raise MangaFontV3SweepError(f"v2 tensor shape drifted: {name}")
            parameter.copy_(value.to(dtype=parameter.dtype))
    student.requires_grad_(False)
    student.eval().to("cuda")
    return torch, processor, student


def _encode_groups(
    *,
    torch: Any,
    student: Any,
    processor: Any,
    groups: Sequence[Sequence[Any]],
    batch_size: int,
) -> np.ndarray:
    chunks: list[np.ndarray] = []
    with torch.inference_mode():
        for offset in range(0, len(groups), batch_size):
            selected = groups[offset : offset + batch_size]
            images = [image for group in selected for image in group]
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
            pixels = processed["pixel_values"].to("cuda", non_blocking=False)
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                embeddings, _ = student(pixels)
            shaped = embeddings.reshape(
                len(selected), len(base.VIEW_NAMES), base.PROJECTION_DIM
            )
            chunks.append(shaped.detach().float().cpu().numpy())
    result = np.ascontiguousarray(np.concatenate(chunks, axis=0), dtype="<f4")
    if result.shape != (
        len(groups),
        len(base.VIEW_NAMES),
        base.PROJECTION_DIM,
    ) or not np.isfinite(result).all():
        raise MangaFontV3SweepError("cached embeddings are invalid")
    return result


def _open_synthetic_groups(
    examples: Sequence[base.SyntheticExample],
) -> list[list[Any]]:
    return [base._open_synthetic_views(example) for example in examples]  # noqa: SLF001


def _open_human_groups(
    examples: Sequence[base.HumanExample], resolver: Any
) -> list[list[Any]]:
    return [base._open_human_views(example, resolver) for example in examples]  # noqa: SLF001


def _human_metadata(
    example: base.HumanExample, candidate_ids: tuple[str, ...]
) -> dict[str, Any]:
    preferred, acceptable = v2._tier_ids(example)  # noqa: SLF001
    return {
        "acceptable_candidate_ids": list(acceptable),
        "preferred_candidate_ids": list(preferred or acceptable),
        "role": base.ROLE_VALUES[example.role_index],
        "sample_id": example.sample_id,
        "supervision": v3.candidate_supervision_scope(example, candidate_ids),
        "work_id": example.work_id,
    }


def _human_arrays(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> dict[str, np.ndarray]:
    targets = np.asarray(
        [v2.tier_code_target(example, candidate_ids) for example in examples],
        dtype="<f4",
    )
    masks = np.zeros((len(examples), len(candidate_ids)), dtype=np.bool_)
    for row, example in enumerate(examples):
        masks[row, list(example.eligible_indices)] = True
    return {
        "targets": targets,
        "masks": masks,
        "none": np.asarray([example.none_target for example in examples], dtype="<f4"),
        "none_mask": np.asarray(
            v3.human_none_supervision_mask(examples, candidate_ids),
            dtype=np.bool_,
        ),
        "full22": np.asarray(
            [
                not v3.candidate_supervision_scope(example, candidate_ids)[
                    "partial_candidate_supervision"
                ]
                for example in examples
            ],
            dtype=np.bool_,
        ),
        "role": np.asarray([example.role_index for example in examples], dtype="<i8"),
        "style": np.asarray([example.style_values for example in examples], dtype="<f4"),
        "style_mask": np.asarray([example.style_mask for example in examples], dtype=np.bool_),
        "treatment": np.asarray(
            [example.treatment_indices for example in examples], dtype="<i8"
        ),
    }


def _array_contract(arrays: Mapping[str, np.ndarray]) -> dict[str, Any]:
    return {
        name: {"dtype": str(value.dtype), "shape": list(value.shape)}
        for name, value in sorted(arrays.items())
    }


def build_cache(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise MangaFontV3SweepError("embedding-cache output already exists")
    _registry, synthetic, human, bindings = v3._load_inputs(args)  # noqa: SLF001
    warm = v3._validate_warm_start(  # noqa: SLF001
        args.warm_start_student_dir, candidate_ids=synthetic.candidate_ids
    )
    metadata = v2.load_synthetic_train_metadata(synthetic)
    selected = select_balanced_synthetic_subset(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        metadata=metadata,
        per_font=args.synthetic_per_font,
    )
    torch, processor, student = _load_v2_student(
        warm_start_dir=args.warm_start_student_dir,
        candidate_ids=synthetic.candidate_ids,
    )
    try:
        from font_matching_catalog_assets import CatalogAssetResolver
    except ImportError:  # pragma: no cover - repository-root import
        from scripts.font_matching_catalog_assets import CatalogAssetResolver
    resolver = CatalogAssetResolver(args.catalog_registry.expanduser().resolve())

    print(
        base.canonical_json(
            {
                "event": "v3_cache_encoding_started",
                "human_train": len(human.train_examples),
                "human_val": len(human.val_examples),
                "synthetic": len(selected),
            }
        ),
        flush=True,
    )
    synthetic_groups = _open_synthetic_groups(selected)
    synthetic_embeddings = _encode_groups(
        torch=torch,
        student=student,
        processor=processor,
        groups=synthetic_groups,
        batch_size=args.eval_batch_size,
    )
    human_train_groups = _open_human_groups(human.train_examples, resolver)
    human_train_embeddings = _encode_groups(
        torch=torch,
        student=student,
        processor=processor,
        groups=human_train_groups,
        batch_size=args.eval_batch_size,
    )
    human_val_groups = _open_human_groups(human.val_examples, resolver)
    human_val_embeddings = _encode_groups(
        torch=torch,
        student=student,
        processor=processor,
        groups=human_val_groups,
        batch_size=args.eval_batch_size,
    )
    train_arrays = _human_arrays(human.train_examples, synthetic.candidate_ids)
    val_arrays = _human_arrays(human.val_examples, synthetic.candidate_ids)
    warm_root = args.warm_start_student_dir.expanduser().resolve()
    warm_contract = base.read_json(
        warm_root / base.CONTRACT_FILE, location="warm v2 contract"
    )
    prototype_descriptor = _mapping(
        warm_contract.get("prototype_bank"), "warm prototype bank"
    )
    prototype_count = int(prototype_descriptor.get("prototype_count", 0))
    prototype_features = np.frombuffer(
        (warm_root / base.PROTOTYPE_FILE).read_bytes(), dtype="<f4"
    ).reshape(prototype_count, base.PROJECTION_DIM)
    arrays = {
        "synthetic_embeddings": synthetic_embeddings,
        "synthetic_labels": np.asarray(
            [example.label_index for example in selected], dtype="<i8"
        ),
        "human_train_embeddings": human_train_embeddings,
        "human_val_embeddings": human_val_embeddings,
        "prototype_features": np.ascontiguousarray(prototype_features),
        **{f"human_train_{key}": value for key, value in train_arrays.items()},
        **{f"human_val_{key}": value for key, value in val_arrays.items()},
    }
    baseline = v3.constant_candidate_baseline(
        human.val_examples, synthetic.candidate_ids
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        np.savez(staging / CACHE_ARRAYS, **arrays)
        contract = base.seal_record(
            {
                "arrays": {
                    **_descriptor(staging / CACHE_ARRAYS),
                    "contract": _array_contract(arrays),
                },
                "boundaries": {
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "human_train_count": len(human.train_examples),
                    "human_train_none_auxiliary_masked_count": sum(
                        not value
                        for value in v3.human_none_supervision_mask(
                            human.train_examples, synthetic.candidate_ids
                        )
                    ),
                    "human_val_count": len(human.val_examples),
                    "synthetic_test_pixels_opened": 0,
                    "synthetic_train_count": len(selected),
                    "train_val_identity_overlap": 0,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(synthetic.candidate_ids),
                "human_train": [
                    _human_metadata(example, synthetic.candidate_ids)
                    for example in human.train_examples
                ],
                "human_val": [
                    _human_metadata(example, synthetic.candidate_ids)
                    for example in human.val_examples
                ],
                "overlays": copy.deepcopy(bindings),
                "candidate_supervision": {
                    "train": v3.validate_candidate_supervision_scopes(
                        human.train_examples, synthetic.candidate_ids
                    ),
                    "val": v3.validate_candidate_supervision_scopes(
                        human.val_examples, synthetic.candidate_ids
                    ),
                },
                "prototype_bags": copy.deepcopy(
                    prototype_descriptor.get("candidate_bags")
                ),
                "quality_gate_constant_baseline": baseline,
                "record_type": "manga_font_student_v3_embedding_cache",
                "schema_version": CACHE_SCHEMA,
                "selection": {
                    "policy": "equal-font-round-robin-role-orientation-geometry-v1",
                    "synthetic_per_font": args.synthetic_per_font,
                },
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "sources": {
                    "catalog_registry_sha256": base.sha256_file(
                        args.catalog_registry.expanduser().resolve()
                    ),
                    "synthetic_manifest_sha256": synthetic.manifest_sha256,
                    "warm_start_checkpoint_sha256": warm["checkpoint_sha256"],
                    "warm_start_contract_sha256": warm["contract_sha256"],
                },
            }
        )
        (staging / CACHE_CONTRACT).write_bytes(
            base.json_bytes(contract, pretty=True)
        )
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (CACHE_ARRAYS, CACHE_CONTRACT)
            },
            "owner": CACHE_OWNER,
            "safe_replace": True,
            "schema_version": CACHE_SCHEMA,
        }
        (staging / CACHE_MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_cache(staging)
        if output.exists():
            raise MangaFontV3SweepError("embedding-cache output appeared")
        os.rename(staging, output)
        published = True
        return validate_cache(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_cache(cache_dir: Path) -> Mapping[str, Any]:
    root = cache_dir.expanduser().resolve()
    _assert_inventory(root, CACHE_FILES, "v3 embedding cache")
    marker = base.read_json(root / CACHE_MARKER, location="cache marker")
    contract = base.read_json(root / CACHE_CONTRACT, location="cache contract")
    base.validate_record_seal(contract, location="cache contract")
    if (
        marker.get("owner") != CACHE_OWNER
        or marker.get("schema_version") != CACHE_SCHEMA
        or marker.get("safe_replace") is not True
        or contract.get("schema_version") != CACHE_SCHEMA
        or contract.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV3SweepError("cache metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "cache marker artifacts")
    for name in (CACHE_ARRAYS, CACHE_CONTRACT):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV3SweepError(f"cache hash drifted: {name}")
    array_descriptor = _mapping(contract.get("arrays"), "cache arrays")
    if (
        array_descriptor.get("sha256") != base.sha256_file(root / CACHE_ARRAYS)
        or array_descriptor.get("byte_size") != (root / CACHE_ARRAYS).stat().st_size
    ):
        raise MangaFontV3SweepError("cache array descriptor drifted")
    expected = _mapping(array_descriptor.get("contract"), "cache array contract")
    with np.load(root / CACHE_ARRAYS, allow_pickle=False) as arrays:
        if set(arrays.files) != set(expected):
            raise MangaFontV3SweepError("cache array inventory drifted")
        for name in arrays.files:
            descriptor = _mapping(expected[name], f"cache array {name}")
            value = arrays[name]
            nonfinite = value.dtype.kind == "f" and not np.isfinite(value).all()
            if (
                list(value.shape) != descriptor.get("shape")
                or str(value.dtype) != descriptor.get("dtype")
                or nonfinite
            ):
                raise MangaFontV3SweepError(f"cache array drifted: {name}")
    boundaries = _mapping(contract.get("boundaries"), "cache boundaries")
    if (
        boundaries.get("human_test_labels_deserialized") != 0
        or boundaries.get("human_test_pixels_opened") != 0
        or boundaries.get("synthetic_test_pixels_opened") != 0
        or boundaries.get("train_val_identity_overlap") != 0
        or boundaries.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV3SweepError("cache leakage boundary drifted")
    return {
        "cache_contract_sha256": base.sha256_file(root / CACHE_CONTRACT),
        "cache_dir": str(root),
        "candidate_count": len(contract.get("candidate_ids", [])),
        "human_train_count": boundaries.get("human_train_count"),
        "human_val_count": boundaries.get("human_val_count"),
        "status": "ready_for_bounded_v3_head_sweep",
        "synthetic_train_count": boundaries.get("synthetic_train_count"),
    }


def _load_cache_arrays(cache_dir: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    validate_cache(cache_dir)
    root = cache_dir.expanduser().resolve()
    contract = base.read_json(root / CACHE_CONTRACT, location="cache contract")
    with np.load(root / CACHE_ARRAYS, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    return contract, arrays


def _initialize_ranker(
    torch: Any,
    *,
    warm_start_dir: Path,
    candidate_count: int,
    dropout: float,
    residual_scale: float,
) -> Any:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV3SweepError("safetensors is required") from error
    ranker = v3.build_runtime_ranker_v3(
        torch,
        candidate_count=candidate_count,
        dropout=dropout,
        residual_scale=residual_scale,
    ).to("cuda")
    state = dict(
        load_file(
            str(
                warm_start_dir.expanduser().resolve() / base.CHECKPOINT_FILE
            ),
            device="cpu",
        )
    )
    parameters = dict(ranker.named_parameters())
    copied = 0
    with torch.no_grad():
        for name, parameter in parameters.items():
            source = state.get(f"runtime_ranker.{name}")
            if source is not None and tuple(source.shape) == tuple(parameter.shape):
                parameter.copy_(source.to(device="cuda", dtype=parameter.dtype))
                copied += 1
        ranker.candidate_residual.weight.copy_(
            state["font_head.weight"].to(
                device="cuda", dtype=ranker.candidate_residual.weight.dtype
            )
        )
        ranker.semantic_projection[-1].weight.zero_()
    if copied < 10:
        raise MangaFontV3SweepError("too few v2 ranker parameters warm-started")
    return ranker


def _candidate_bags(torch: Any, records: Sequence[Mapping[str, Any]]) -> tuple[Any, ...]:
    return tuple(
        torch.arange(
            int(record["start"]),
            int(record["start"]) + int(record["count"]),
            device="cuda",
            dtype=torch.long,
        )
        for record in records
    )


def _auxiliary_from_arrays(
    *, torch: Any, outputs: Mapping[str, Any], arrays: Mapping[str, Any]
) -> Any:
    loss, _ = v3.masked_human_auxiliary_loss(
        torch=torch,
        outputs=outputs,
        none_targets=arrays["none"],
        none_masks=arrays["none_mask"],
        role_targets=arrays["role"],
        style_targets=arrays["style"],
        style_masks=arrays["style_mask"],
        treatment_targets=arrays["treatment"],
    )
    return loss


def _cached_val_metrics(
    *,
    torch: Any,
    ranker: Any,
    embeddings: Any,
    prototypes: Any,
    bags: Sequence[Any],
    targets: Any,
    masks: Any,
    roles: Any,
    candidate_ids: tuple[str, ...],
) -> dict[str, Any]:
    ranker.eval()
    with torch.inference_mode():
        outputs = ranker(embeddings, prototypes, bags)
        logits = outputs["candidate_scores"].float().masked_fill(~masks, -torch.inf)
        order = torch.argsort(logits, dim=-1, descending=True)
        loss = v3.tiered_deployment_loss(
            torch,
            outputs["candidate_scores"],
            targets,
            masks,
            preferred_weight=1.0,
            acceptable_weight=0.20,
        )
    counters: Counter[str] = Counter()
    variant: Counter[str] = Counter()
    distribution: Counter[str] = Counter()
    positive = 0
    for row in range(targets.shape[0]):
        preferred = set(torch.where(targets[row] == v3.PREFERRED_CODE)[0].tolist())
        acceptable = set(torch.where(targets[row] >= v3.ACCEPTABLE_CODE)[0].tolist())
        if not acceptable:
            continue
        positive += 1
        top1 = int(order[row, 0].item())
        top3 = set(order[row, :3].tolist())
        distribution[candidate_ids[top1]] += 1
        counters["preferred_at1"] += int(top1 in preferred)
        counters["acceptable_at1"] += int(top1 in acceptable)
        counters["preferred_hit_at3"] += int(bool(preferred & top3))
        counters["acceptable_hit_at3"] += int(bool(acceptable & top3))
        role = base.ROLE_VALUES[int(roles[row].item())]
        if role not in v2.ORDINARY_ROLES:
            variant["rows"] += 1
            variant["preferred_at1"] += int(top1 in preferred)
            variant["acceptable_at1"] += int(top1 in acceptable)
            variant["preferred_hit_at3"] += int(bool(preferred & top3))
            variant["acceptable_hit_at3"] += int(bool(acceptable & top3))
    if positive < 1 or variant["rows"] < 1:
        raise MangaFontV3SweepError("cached val lacks positive variant rows")
    return {
        "acceptable_at1": counters["acceptable_at1"] / positive,
        "acceptable_hit_at3": counters["acceptable_hit_at3"] / positive,
        "evaluated_positive_rows": positive,
        "preferred_at1": counters["preferred_at1"] / positive,
        "preferred_hit_at3": counters["preferred_hit_at3"] / positive,
        "tiered_gold_loss": float(loss.item()),
        "top1_candidate_distribution": dict(sorted(distribution.items())),
        "top1_max_candidate_share": max(distribution.values()) / positive,
        "top1_unique_candidate_count": len(distribution),
        "variant_acceptable_at1": variant["acceptable_at1"] / variant["rows"],
        "variant_acceptable_hit_at3": variant["acceptable_hit_at3"]
        / variant["rows"],
        "variant_preferred_at1": variant["preferred_at1"] / variant["rows"],
        "variant_preferred_hit_at3": variant["preferred_hit_at3"]
        / variant["rows"],
        "variant_val_rows": variant["rows"],
    }


def _trial_grid(max_trials: int) -> list[dict[str, float]]:
    grid = [
        {
            "diversity_weight": 0.01,
            "head_lr": 1e-4,
            "partial_row_weight": 0.75,
            "residual_scale": 0.5,
        },
        {
            "diversity_weight": 0.03,
            "head_lr": 1e-4,
            "partial_row_weight": 1.0,
            "residual_scale": 1.0,
        },
        {
            "diversity_weight": 0.03,
            "head_lr": 2e-4,
            "partial_row_weight": 0.75,
            "residual_scale": 0.5,
        },
        {
            "diversity_weight": 0.01,
            "head_lr": 2e-4,
            "partial_row_weight": 1.0,
            "residual_scale": 1.0,
        },
    ]
    if not 1 <= max_trials <= len(grid):
        raise MangaFontV3SweepError("head sweep trials must be 1..4")
    return grid[:max_trials]


def _source_balanced_human_indices(
    torch: Any,
    *,
    full22_mask: Any,
    batch_size: int,
    generator: Any,
) -> Any:
    """Draw an equal-source human batch despite the 618:109 raw imbalance."""

    full = torch.where(full22_mask)[0]
    partial = torch.where(~full22_mask)[0]
    if full.numel() < 1:
        raise MangaFontV3SweepError("head sweep lacks full22 anchor rows")
    if partial.numel() < 1:
        return full[
            torch.randint(
                full.numel(),
                (batch_size,),
                generator=generator,
                device=full.device,
            )
        ]
    partial_count = batch_size // 2
    full_count = batch_size - partial_count
    indices = torch.cat(
        [
            full[
                torch.randint(
                    full.numel(),
                    (full_count,),
                    generator=generator,
                    device=full.device,
                )
            ],
            partial[
                torch.randint(
                    partial.numel(),
                    (partial_count,),
                    generator=generator,
                    device=partial.device,
                )
            ],
        ]
    )
    return indices[
        torch.randperm(indices.numel(), generator=generator, device=indices.device)
    ]


def run_sweep(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise MangaFontV3SweepError("head-sweep output already exists")
    cache, arrays = _load_cache_arrays(args.cache_dir)
    candidate_ids = tuple(str(value) for value in cache["candidate_ids"])
    warm = v3._validate_warm_start(  # noqa: SLF001
        args.warm_start_student_dir, candidate_ids=candidate_ids
    )
    sources = _mapping(cache.get("sources"), "cache sources")
    if (
        sources.get("warm_start_checkpoint_sha256") != warm["checkpoint_sha256"]
        or sources.get("warm_start_contract_sha256") != warm["contract_sha256"]
    ):
        raise MangaFontV3SweepError("cache/warm-start binding drifted")
    torch, _processor, _vision_class, save_file = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available():
        raise MangaFontV3SweepError("head sweep requires CUDA")
    prototypes = torch.from_numpy(arrays["prototype_features"]).to("cuda")
    bags = _candidate_bags(torch, cache["prototype_bags"])
    syn_embeddings = torch.from_numpy(arrays["synthetic_embeddings"]).to("cuda")
    syn_labels = torch.from_numpy(arrays["synthetic_labels"]).to("cuda")
    train_embeddings = torch.from_numpy(arrays["human_train_embeddings"]).to("cuda")
    val_embeddings = torch.from_numpy(arrays["human_val_embeddings"]).to("cuda")
    train = {
        key: torch.from_numpy(arrays[f"human_train_{key}"]).to("cuda")
        for key in (
            "targets",
            "masks",
            "none",
            "none_mask",
            "full22",
            "role",
            "style",
            "style_mask",
            "treatment",
        )
    }
    val = {
        key: torch.from_numpy(arrays[f"human_val_{key}"]).to("cuda")
        for key in ("targets", "masks", "role")
    }
    baseline = _mapping(
        cache.get("quality_gate_constant_baseline"), "cache constant baseline"
    )
    trials: list[dict[str, Any]] = []
    global_state: dict[str, Any] | None = None
    global_trial: dict[str, Any] | None = None

    for trial_index, config in enumerate(_trial_grid(args.trials), 1):
        seed = args.seed + trial_index
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        ranker = _initialize_ranker(
            torch,
            warm_start_dir=args.warm_start_student_dir,
            candidate_count=len(candidate_ids),
            dropout=args.residual_dropout,
            residual_scale=config["residual_scale"],
        )
        optimizer = torch.optim.AdamW(
            ranker.parameters(),
            lr=config["head_lr"],
            weight_decay=args.weight_decay,
            foreach=False,
        )
        history: list[dict[str, Any]] = []
        best_metrics: dict[str, Any] | None = None
        best_gate: dict[str, Any] | None = None
        best_state: dict[str, Any] | None = None
        best_epoch = 0
        stale = 0
        steps = math.ceil(syn_embeddings.shape[0] / args.synthetic_batch_size)
        for epoch in range(1, args.epochs + 1):
            ranker.train(True)
            generator = torch.Generator(device="cuda")
            generator.manual_seed(seed + epoch)
            syn_order = torch.randperm(
                syn_embeddings.shape[0], generator=generator, device="cuda"
            )
            sums: Counter[str] = Counter()
            for step in range(steps):
                syn_index = syn_order[
                    step
                    * args.synthetic_batch_size : (step + 1)
                    * args.synthetic_batch_size
                ]
                human_index = _source_balanced_human_indices(
                    torch,
                    full22_mask=train["full22"],
                    batch_size=args.human_batch_size,
                    generator=generator,
                )
                combined = torch.cat(
                    [syn_embeddings[syn_index], train_embeddings[human_index]],
                    dim=0,
                )
                optimizer.zero_grad(set_to_none=True)
                outputs = ranker(combined, prototypes, bags)
                synthetic_loss = torch.nn.functional.cross_entropy(
                    outputs["candidate_scores"][: len(syn_index)],
                    syn_labels[syn_index],
                )
                human_outputs = {
                    "candidate_scores": outputs["candidate_scores"][len(syn_index) :],
                    "none_logits": outputs["none_logits"][len(syn_index) :],
                    "role_logits": outputs["role_logits"][len(syn_index) :],
                    "style_logits": outputs["style_logits"][len(syn_index) :],
                    "treatment_logits": {
                        field: value[len(syn_index) :]
                        for field, value in outputs["treatment_logits"].items()
                    },
                }
                human_loss = v3.tiered_deployment_loss(
                    torch,
                    human_outputs["candidate_scores"],
                    train["targets"][human_index],
                    train["masks"][human_index],
                    preferred_weight=1.0,
                    acceptable_weight=0.20,
                    row_weights=torch.where(
                        train["full22"][human_index],
                        torch.ones_like(
                            train["none"][human_index], dtype=torch.float32
                        ),
                        torch.full_like(
                            train["none"][human_index],
                            config["partial_row_weight"],
                            dtype=torch.float32,
                        ),
                    ),
                )
                auxiliary = _auxiliary_from_arrays(
                    torch=torch,
                    outputs=human_outputs,
                    arrays={
                        key: value[human_index]
                        for key, value in train.items()
                        if key not in {"targets", "masks", "full22"}
                    },
                )
                diversity = v3.candidate_weight_diversity_loss(torch, ranker)
                loss = (
                    synthetic_loss
                    + args.human_weight * human_loss
                    + args.auxiliary_weight * auxiliary
                    + config["diversity_weight"] * diversity
                )
                if not bool(torch.isfinite(loss)):
                    raise MangaFontV3SweepError("head sweep loss became non-finite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(ranker.parameters(), 1.0)
                optimizer.step()
                sums["loss"] += float(loss.detach().item())
                sums["synthetic"] += float(synthetic_loss.detach().item())
                sums["human"] += float(human_loss.detach().item())
            metrics = _cached_val_metrics(
                torch=torch,
                ranker=ranker,
                embeddings=val_embeddings,
                prototypes=prototypes,
                bags=bags,
                targets=val["targets"],
                masks=val["masks"],
                roles=val["role"],
                candidate_ids=candidate_ids,
            )
            gate = v3.evaluate_quality_gate(
                metrics,
                baseline,
                minimum_preferred_gain=args.minimum_preferred_gain,
                minimum_acceptable_gain=args.minimum_acceptable_gain,
                maximum_top1_share=args.maximum_top1_share,
                minimum_unique_top1=args.minimum_unique_top1,
            )
            history.append(
                {
                    "epoch": epoch,
                    "quality_gate": gate,
                    "train_human_loss": sums["human"] / steps,
                    "train_loss": sums["loss"] / steps,
                    "train_synthetic_loss": sums["synthetic"] / steps,
                    "val": metrics,
                }
            )
            if v3._is_better(  # noqa: SLF001
                metrics,
                gate,
                best_metrics,
                best_gate,
                min_delta=1e-4,
            ):
                best_metrics = copy.deepcopy(metrics)
                best_gate = copy.deepcopy(gate)
                best_state = {
                    f"runtime_ranker.{name}": value.detach().cpu().clone()
                    for name, value in ranker.named_parameters()
                }
                best_epoch = epoch
                stale = 0
            else:
                stale += 1
                if stale >= args.patience:
                    break
        if best_metrics is None or best_gate is None or best_state is None:
            raise MangaFontV3SweepError("head sweep trial produced no checkpoint")
        trial = {
            "best_epoch": best_epoch,
            "best_metrics": best_metrics,
            "config": config,
            "history": history,
            "quality_gate": best_gate,
            "seed": seed,
            "trial": trial_index,
        }
        trials.append(trial)
        if global_trial is None or v3._is_better(  # noqa: SLF001
            best_metrics,
            best_gate,
            global_trial["best_metrics"],
            global_trial["quality_gate"],
            min_delta=1e-4,
        ):
            global_trial = trial
            global_state = best_state
        print(
            base.canonical_json(
                {
                    "best_metrics": best_metrics,
                    "event": "v3_head_trial_complete",
                    "quality_gate_passed": best_gate["passed"],
                    "trial": trial_index,
                }
            ),
            flush=True,
        )

    if global_trial is None or global_state is None:
        raise MangaFontV3SweepError("head sweep produced no global best")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        save_file(
            global_state,
            staging / SWEEP_CHECKPOINT,
            metadata={"format": SWEEP_SCHEMA, "kind": "ranker_initialization_only"},
        )
        report = base.seal_record(
            {
                "best_checkpoint": {
                    **_descriptor(staging / SWEEP_CHECKPOINT),
                    "state_contract": [
                        {
                            "dtype": str(value.dtype).replace("torch.", ""),
                            "name": name,
                            "shape": list(value.shape),
                        }
                        for name, value in sorted(global_state.items())
                    ],
                },
                "boundaries": {
                    "hidden_test_labels_deserialized": 0,
                    "hidden_test_pixels_opened": 0,
                    "selection_uses_human_val": True,
                    "val_used_for_optimizer": False,
                },
                "cache_contract_sha256": base.sha256_file(
                    args.cache_dir.expanduser().resolve() / CACHE_CONTRACT
                ),
                "candidate_ids": list(candidate_ids),
                "constant_candidate_baseline": copy.deepcopy(baseline),
                "global_best_trial": global_trial["trial"],
                "quality_gate": copy.deepcopy(global_trial["quality_gate"]),
                "record_type": "manga_font_student_v3_head_sweep",
                "schema_version": SWEEP_SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "trials": trials,
                "warm_start_checkpoint_sha256": warm["checkpoint_sha256"],
                "warm_start_contract_sha256": warm["contract_sha256"],
            }
        )
        (staging / SWEEP_REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (SWEEP_CHECKPOINT, SWEEP_REPORT)
            },
            "owner": SWEEP_OWNER,
            "safe_replace": True,
            "schema_version": SWEEP_SCHEMA,
        }
        (staging / SWEEP_MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_sweep(
            staging,
            warm_start_dir=args.warm_start_student_dir,
            require_quality_gate=False,
        )
        if output.exists():
            raise MangaFontV3SweepError("head-sweep output appeared")
        os.rename(staging, output)
        published = True
        return validate_sweep(
            output,
            warm_start_dir=args.warm_start_student_dir,
            require_quality_gate=False,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_sweep(
    sweep_dir: Path,
    *,
    warm_start_dir: Path | None = None,
    require_quality_gate: bool = True,
) -> Mapping[str, Any]:
    root = sweep_dir.expanduser().resolve()
    _assert_inventory(root, SWEEP_FILES, "v3 head sweep")
    marker = base.read_json(root / SWEEP_MARKER, location="sweep marker")
    report = base.read_json(root / SWEEP_REPORT, location="sweep report")
    base.validate_record_seal(report, location="sweep report")
    if (
        marker.get("owner") != SWEEP_OWNER
        or marker.get("schema_version") != SWEEP_SCHEMA
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != SWEEP_SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV3SweepError("head sweep metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "sweep marker artifacts")
    for name in (SWEEP_CHECKPOINT, SWEEP_REPORT):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV3SweepError(f"head sweep hash drifted: {name}")
    checkpoint = _mapping(report.get("best_checkpoint"), "sweep checkpoint")
    if (
        checkpoint.get("sha256") != base.sha256_file(root / SWEEP_CHECKPOINT)
        or checkpoint.get("byte_size") != (root / SWEEP_CHECKPOINT).stat().st_size
    ):
        raise MangaFontV3SweepError("head sweep checkpoint binding drifted")
    boundary = _mapping(report.get("boundaries"), "sweep boundaries")
    if (
        boundary.get("hidden_test_labels_deserialized") != 0
        or boundary.get("hidden_test_pixels_opened") != 0
        or boundary.get("selection_uses_human_val") is not True
        or boundary.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV3SweepError("head sweep leakage boundary drifted")
    gate = _mapping(report.get("quality_gate"), "sweep quality gate")
    if require_quality_gate and gate.get("passed") is not True:
        raise MangaFontV3SweepError("head sweep did not pass the deployment gate")
    if warm_start_dir is not None:
        warm_root = warm_start_dir.expanduser().resolve()
        if (
            report.get("warm_start_checkpoint_sha256")
            != base.sha256_file(warm_root / base.CHECKPOINT_FILE)
            or report.get("warm_start_contract_sha256")
            != base.sha256_file(warm_root / base.CONTRACT_FILE)
        ):
            raise MangaFontV3SweepError("head sweep warm-start binding drifted")
    return {
        "best_trial": report.get("global_best_trial"),
        "candidate_count": len(report.get("candidate_ids", [])),
        "output_dir": str(root),
        "quality_gate_passed": gate.get("passed") is True,
        "status": (
            "ready_for_v3_short_finetune"
            if gate.get("passed") is True
            else "research_only_head_initialization"
        ),
        "trial_count": len(report.get("trials", [])),
    }


def load_best_head_into_student(
    *,
    student: Any,
    sweep_dir: Path,
    warm_start_dir: Path,
    require_quality_gate: bool = True,
) -> Mapping[str, Any]:
    validation = validate_sweep(
        sweep_dir,
        warm_start_dir=warm_start_dir,
        require_quality_gate=require_quality_gate,
    )
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV3SweepError("safetensors is required") from error
    state = dict(
        load_file(
            str(sweep_dir.expanduser().resolve() / SWEEP_CHECKPOINT), device="cpu"
        )
    )
    parameters = dict(student.named_parameters())
    expected = {
        name for name in parameters if name.startswith("runtime_ranker.")
    }
    if set(state) != expected:
        raise MangaFontV3SweepError("head sweep state contract drifted")
    with __import__("torch").no_grad():
        for name, value in state.items():
            parameter = parameters[name]
            if tuple(parameter.shape) != tuple(value.shape):
                raise MangaFontV3SweepError(f"head tensor shape drifted: {name}")
            parameter.copy_(value.to(device=parameter.device, dtype=parameter.dtype))
    return validation


def _add_cache_inputs(parser: argparse.ArgumentParser) -> None:
    v3._add_input_arguments(parser)  # noqa: SLF001


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    cache = sub.add_parser("build-cache")
    _add_cache_inputs(cache)
    cache.add_argument("--output-dir", type=Path, required=True)
    cache.add_argument("--synthetic-per-font", type=int, default=64)
    cache.add_argument("--eval-batch-size", type=int, default=32)
    validate_cache_parser = sub.add_parser("validate-cache")
    validate_cache_parser.add_argument("--cache-dir", type=Path, required=True)
    sweep = sub.add_parser("sweep")
    sweep.add_argument("--cache-dir", type=Path, required=True)
    sweep.add_argument("--warm-start-student-dir", type=Path, required=True)
    sweep.add_argument("--output-dir", type=Path, required=True)
    sweep.add_argument("--trials", type=int, default=4)
    sweep.add_argument("--epochs", type=int, default=20)
    sweep.add_argument("--patience", type=int, default=5)
    sweep.add_argument("--synthetic-batch-size", type=int, default=32)
    sweep.add_argument("--human-batch-size", type=int, default=32)
    sweep.add_argument("--human-weight", type=float, default=2.0)
    sweep.add_argument("--auxiliary-weight", type=float, default=0.10)
    sweep.add_argument("--weight-decay", type=float, default=0.01)
    sweep.add_argument("--residual-dropout", type=float, default=0.10)
    sweep.add_argument("--minimum-preferred-gain", type=float, default=0.03)
    sweep.add_argument("--minimum-acceptable-gain", type=float, default=0.02)
    sweep.add_argument("--maximum-top1-share", type=float, default=0.55)
    sweep.add_argument("--minimum-unique-top1", type=int, default=4)
    sweep.add_argument("--seed", type=int, default=20260803)
    validate_sweep_parser = sub.add_parser("validate-sweep")
    validate_sweep_parser.add_argument("--sweep-dir", type=Path, required=True)
    validate_sweep_parser.add_argument("--warm-start-student-dir", type=Path)
    validate_sweep_parser.add_argument(
        "--allow-failed-quality-gate", action="store_true"
    )
    return parser


def _validate_sweep_args(args: argparse.Namespace) -> None:
    values = (
        args.human_weight,
        args.auxiliary_weight,
        args.weight_decay,
        args.residual_dropout,
        args.minimum_preferred_gain,
        args.minimum_acceptable_gain,
        args.maximum_top1_share,
    )
    if (
        not 1 <= args.trials <= 4
        or args.epochs < 1
        or args.patience < 1
        or args.synthetic_batch_size < 4
        or args.human_batch_size < 4
        or args.human_weight <= 0.0
        or args.auxiliary_weight < 0.0
        or args.weight_decay < 0.0
        or not 0.0 <= args.residual_dropout < 0.5
        or not 0.0 <= args.minimum_preferred_gain <= 0.5
        or not 0.0 <= args.minimum_acceptable_gain <= 0.5
        or not 0.2 <= args.maximum_top1_share <= 1.0
        or not 2 <= args.minimum_unique_top1 <= base.CANDIDATE_COUNT
        or not all(math.isfinite(value) for value in values)
    ):
        raise MangaFontV3SweepError("invalid bounded head-sweep configuration")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build-cache":
            if args.eval_batch_size < 1:
                raise MangaFontV3SweepError("eval batch size must be positive")
            result = build_cache(args)
        elif args.command == "validate-cache":
            result = validate_cache(args.cache_dir)
        elif args.command == "sweep":
            _validate_sweep_args(args)
            result = run_sweep(args)
        else:
            result = validate_sweep(
                args.sweep_dir,
                warm_start_dir=args.warm_start_student_dir,
                require_quality_gate=not args.allow_failed_quality_gate,
            )
    except (base.MangaFontStudentError, OSError, ValueError) as error:
        raise SystemExit(f"manga-font-v3-sweep error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
