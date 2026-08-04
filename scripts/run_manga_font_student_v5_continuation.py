#!/usr/bin/env python3
"""Run the sealed four-trial v5 head continuation on cached train embeddings.

The runner is intentionally narrow.  It starts every trial from the exact
strongest v3 head, applies only the completed train-only full22 overlay, and
uses val33 only after optimizer epochs for checkpoint selection.  There is no
input for hidden test, fresh64, or library QA data and no encoder execution.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

# Required by CUDA matmul before deterministic algorithms are enabled below.
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

try:
    from scripts import build_manga_font_legacy_new7_expansion_review_v1 as authority
    from scripts import prepare_manga_font_student_v5 as preparation
    from scripts import sweep_manga_font_student_v3_heads as sweep
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v3 as v3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_legacy_new7_expansion_review_v1 as authority
    import prepare_manga_font_student_v5 as preparation
    import sweep_manga_font_student_v3_heads as sweep
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v3 as v3


SCHEMA = "manga-font-student-v5-continuation-v1"
OWNER = "carrot-manga-translator/manga-font-student-v5-continuation-v1"
MARKER = ".manga-font-student-v5-continuation-v1-owned.json"
REPORT = "continuation-report.json"
CONTRACT = "continuation-contract.json"
CHECKPOINT = "best-head.safetensors"
FILES = frozenset({MARKER, REPORT, CONTRACT, CHECKPOINT})

TRIAL_GRID = (
    {"head_learning_rate": 0.000025, "legacy_partial_loss_weight": 0.0},
    {"head_learning_rate": 0.000025, "legacy_partial_loss_weight": 0.10},
    {"head_learning_rate": 0.00005, "legacy_partial_loss_weight": 0.0},
    {"head_learning_rate": 0.00005, "legacy_partial_loss_weight": 0.10},
)
MAX_EPOCHS = 4
PATIENCE = 2
UPGRADED_ROW_WEIGHT = 1.5
FULL22_ROW_WEIGHT = 1.0
PROTOTYPE_SCORE_COEFFICIENT = 1.0
SYNTHETIC_LOSS_COEFFICIENT = 1.0
HUMAN_LOSS_COEFFICIENT = 1.0
WEIGHT_DECAY = 0.01
SYNTHETIC_BATCH_SIZE = 32
HUMAN_BATCH_SIZE = 32
GRADIENT_CLIP_NORM = 1.0
SEED = 20260803
EXPECTED_BASE_FULL22 = 109
EXPECTED_UPGRADED = 40
EXPECTED_FINAL_FULL22 = 149
EXPECTED_TRAIN_ROWS = 727
EXPECTED_VAL_ROWS = 33
EXPECTED_VARIANT_VAL_ROWS = 28
EXPECTED_SYNTHETIC_ROWS = 1408
EXPECTED_CANDIDATES = 22
EXPECTED_START_HITS = {
    "acceptable_at1": 21,
    "preferred_at1": 13,
    "variant_acceptable_at1": 16,
    "variant_preferred_at1": 8,
}
PROMOTION_MINIMUMS = {
    "acceptable_at1": 21,
    "preferred_at1": 14,
    "variant_acceptable_at1": 16,
    "variant_preferred_at1": 9,
}
MAX_TOP1_SHARE = 0.55
MIN_UNIQUE_TOP1 = 4
EXPECTED_ARRAYS = frozenset(
    {
        "synthetic_embeddings",
        "synthetic_labels",
        "human_train_embeddings",
        "human_val_embeddings",
        "prototype_features",
        "human_train_targets",
        "human_train_masks",
        "human_train_none",
        "human_train_none_mask",
        "human_train_full22",
        "human_train_role",
        "human_train_style",
        "human_train_style_mask",
        "human_train_treatment",
        "human_val_targets",
        "human_val_masks",
        "human_val_none",
        "human_val_none_mask",
        "human_val_full22",
        "human_val_role",
        "human_val_style",
        "human_val_style_mask",
        "human_val_treatment",
    }
)


class MangaFontV5ContinuationError(v3.MangaFontStudentV3Error):
    """Raised when a continuation input, execution, or sealed result is unsafe."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV5ContinuationError(f"{location}: expected object")
    return value


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV5ContinuationError(f"missing artifact: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _array_sha(value: np.ndarray) -> str:
    return base.sha256_bytes(np.ascontiguousarray(value).tobytes())


def _trial_grid() -> tuple[dict[str, float], ...]:
    return tuple(copy.deepcopy(value) for value in TRIAL_GRID)


def _metric_hits(metrics: Mapping[str, Any]) -> dict[str, int]:
    if int(metrics.get("evaluated_positive_rows", -1)) != EXPECTED_VAL_ROWS:
        raise MangaFontV5ContinuationError("val33 positive row count drifted")
    if int(metrics.get("variant_val_rows", -1)) != EXPECTED_VARIANT_VAL_ROWS:
        raise MangaFontV5ContinuationError("val33 variant row count drifted")
    result: dict[str, int] = {}
    for name in PROMOTION_MINIMUMS:
        rows = EXPECTED_VARIANT_VAL_ROWS if name.startswith("variant_") else EXPECTED_VAL_ROWS
        raw = metrics.get(name)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise MangaFontV5ContinuationError(f"metric is not numeric: {name}")
        value = float(raw)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise MangaFontV5ContinuationError(f"metric is not a finite rate: {name}")
        result[name] = round(value * rows)
    return result


def promotion_gate(metrics: Mapping[str, Any]) -> dict[str, Any]:
    hits = _metric_hits(metrics)
    share = float(metrics.get("top1_max_candidate_share", math.nan))
    unique = int(metrics.get("top1_unique_candidate_count", -1))
    checks = {
        "acceptable_hits_minimum": hits["acceptable_at1"]
        >= PROMOTION_MINIMUMS["acceptable_at1"],
        "preferred_hits_minimum": hits["preferred_at1"]
        >= PROMOTION_MINIMUMS["preferred_at1"],
        "top1_max_candidate_share_maximum": math.isfinite(share)
        and share <= MAX_TOP1_SHARE,
        "top1_unique_candidate_count_minimum": unique >= MIN_UNIQUE_TOP1,
        "variant_acceptable_hits_minimum": hits["variant_acceptable_at1"]
        >= PROMOTION_MINIMUMS["variant_acceptable_at1"],
        "variant_preferred_hits_minimum": hits["variant_preferred_at1"]
        >= PROMOTION_MINIMUMS["variant_preferred_at1"],
    }
    return {
        "checks": checks,
        "hits": hits,
        "passed": all(checks.values()),
        "policy": {
            "acceptable_hits_minimum": PROMOTION_MINIMUMS["acceptable_at1"],
            "preferred_hits_minimum": PROMOTION_MINIMUMS["preferred_at1"],
            "top1_max_candidate_share_maximum": MAX_TOP1_SHARE,
            "top1_unique_candidate_count_minimum": MIN_UNIQUE_TOP1,
            "variant_acceptable_hits_minimum": PROMOTION_MINIMUMS[
                "variant_acceptable_at1"
            ],
            "variant_preferred_hits_minimum": PROMOTION_MINIMUMS[
                "variant_preferred_at1"
            ],
        },
    }


def _selection_key(metrics: Mapping[str, Any], gate: Mapping[str, Any]) -> tuple[float, ...]:
    hits = _metric_hits(metrics)
    loss = float(metrics.get("tiered_gold_loss", math.nan))
    if not math.isfinite(loss):
        raise MangaFontV5ContinuationError("val tiered loss is not finite")
    return (
        float(gate.get("passed") is True),
        float(hits["variant_preferred_at1"]),
        float(hits["preferred_at1"]),
        float(hits["variant_acceptable_at1"]),
        float(hits["acceptable_at1"]),
        float(metrics.get("acceptable_hit_at3", 0.0)),
        -loss,
        float(metrics.get("top1_unique_candidate_count", 0)),
        -float(metrics.get("top1_max_candidate_share", 1.0)),
    )


def _is_better(
    metrics: Mapping[str, Any],
    gate: Mapping[str, Any],
    best_metrics: Mapping[str, Any],
    best_gate: Mapping[str, Any],
) -> bool:
    return _selection_key(metrics, gate) > _selection_key(best_metrics, best_gate)


def build_train_row_weights(
    *,
    full22: np.ndarray,
    upgraded: np.ndarray,
    legacy_partial_loss_weight: float,
) -> np.ndarray:
    if (
        full22.ndim != 1
        or upgraded.shape != full22.shape
        or full22.dtype != np.bool_
        or upgraded.dtype != np.bool_
        or legacy_partial_loss_weight not in (0.0, 0.10)
        or np.any(upgraded & ~full22)
    ):
        raise MangaFontV5ContinuationError("train row-weight contract drifted")
    result = np.full(full22.shape, legacy_partial_loss_weight, dtype="<f4")
    result[full22] = FULL22_ROW_WEIGHT
    result[upgraded] = UPGRADED_ROW_WEIGHT
    return result


def _assert_readiness_plan(plan: Mapping[str, Any]) -> None:
    phase = _mapping(plan.get("phase1"), "readiness phase1")
    boundary = _mapping(plan.get("selection_boundary"), "readiness boundary")
    if (
        int(plan.get("maximum_trials", -1)) != len(TRIAL_GRID)
        or phase.get("candidate_bias_allowed") is not False
        or int(phase.get("early_stopping_patience", -1)) != PATIENCE
        or int(phase.get("epochs_per_trial", -1)) != MAX_EPOCHS
        or tuple(float(value) for value in phase.get("head_learning_rates", ()))
        != (0.000025, 0.00005)
        or tuple(float(value) for value in phase.get("legacy_partial_loss_weights", ()))
        != (0.0, 0.10)
        or float(phase.get("prototype_score_coefficient", math.nan))
        != PROTOTYPE_SCORE_COEFFICIENT
        or float(phase.get("upgraded_full22_row_weight", math.nan))
        != UPGRADED_ROW_WEIGHT
        or boundary.get("fresh64_accessed") is not False
        or boundary.get("hidden_test_accessed") is not False
        or boundary.get("library_40qa_accessed") is not False
        or boundary.get("optimizer_uses_val33") is not False
        or boundary.get("selection_uses_val33") is not True
    ):
        raise MangaFontV5ContinuationError("readiness continuation plan drifted")


def _load_exact_ranker(torch: Any, checkpoint: Path, candidate_count: int) -> Any:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV5ContinuationError("safetensors is required") from error
    if base.sha256_file(checkpoint) != preparation.STRONGEST_HEAD_SHA256:
        raise MangaFontV5ContinuationError("exact strongest head hash drifted")
    source = dict(load_file(str(checkpoint), device="cpu"))
    if any(not name.startswith("runtime_ranker.") for name in source):
        raise MangaFontV5ContinuationError("strongest head tensor prefix drifted")
    ranker = v3.build_runtime_ranker_v3(
        torch,
        candidate_count=candidate_count,
        dropout=0.10,
        residual_scale=0.50,
    ).to("cuda")
    ranker.load_state_dict(
        {name.removeprefix("runtime_ranker."): value for name, value in source.items()},
        strict=True,
    )
    if ranker.candidate_residual.bias is not None:
        raise MangaFontV5ContinuationError("candidate bias is prohibited")
    return ranker


def _snapshot_state(ranker: Any) -> dict[str, Any]:
    if ranker.candidate_residual.bias is not None:
        raise MangaFontV5ContinuationError("candidate bias appeared during training")
    return {
        f"runtime_ranker.{name}": value.detach().cpu().clone()
        for name, value in ranker.named_parameters()
    }


def _state_contract(state: Mapping[str, Any]) -> list[dict[str, Any]]:
    if "runtime_ranker.candidate_residual.bias" in state:
        raise MangaFontV5ContinuationError("checkpoint contains candidate bias")
    return [
        {
            "dtype": str(value.dtype).replace("torch.", ""),
            "name": name,
            "shape": list(value.shape),
        }
        for name, value in sorted(state.items())
    ]


def _candidate_bags(
    torch: Any, records: Sequence[Mapping[str, Any]]
) -> tuple[Any, ...]:
    return tuple(
        torch.arange(
            int(record["start"]),
            int(record["start"]) + int(record["count"]),
            device="cuda",
            dtype=torch.long,
        )
        for record in records
    )


def _fixed_contract(*, input_bindings: Mapping[str, Any]) -> dict[str, Any]:
    return base.seal_record(
        {
            "boundaries": {
                "encoder_executions": 0,
                "fresh64_accessed": False,
                "hidden_test_labels_deserialized": 0,
                "hidden_test_pixels_opened": 0,
                "library_40qa_accessed": False,
                "optimizer_uses_val33": False,
                "selection_uses_val33": True,
            },
            "candidate_bias_allowed": False,
            "candidate_count": EXPECTED_CANDIDATES,
            "input_bindings": copy.deepcopy(dict(input_bindings)),
            "optimizer": {
                "gradient_clip_norm": GRADIENT_CLIP_NORM,
                "kind": "AdamW",
                "weight_decay": WEIGHT_DECAY,
            },
            "promotion_gate": promotion_gate(
                {
                    "acceptable_at1": PROMOTION_MINIMUMS["acceptable_at1"]
                    / EXPECTED_VAL_ROWS,
                    "acceptable_hit_at3": 0.0,
                    "evaluated_positive_rows": EXPECTED_VAL_ROWS,
                    "preferred_at1": PROMOTION_MINIMUMS["preferred_at1"]
                    / EXPECTED_VAL_ROWS,
                    "tiered_gold_loss": 0.0,
                    "top1_max_candidate_share": MAX_TOP1_SHARE,
                    "top1_unique_candidate_count": MIN_UNIQUE_TOP1,
                    "variant_acceptable_at1": PROMOTION_MINIMUMS[
                        "variant_acceptable_at1"
                    ]
                    / EXPECTED_VARIANT_VAL_ROWS,
                    "variant_preferred_at1": PROMOTION_MINIMUMS[
                        "variant_preferred_at1"
                    ]
                    / EXPECTED_VARIANT_VAL_ROWS,
                    "variant_val_rows": EXPECTED_VARIANT_VAL_ROWS,
                }
            )["policy"],
            "prototype_score_coefficient": PROTOTYPE_SCORE_COEFFICIENT,
            "record_type": "manga_font_student_v5_continuation_contract",
            "row_weights": {
                "existing_full22": FULL22_ROW_WEIGHT,
                "legacy_partial_grid": [0.0, 0.10],
                "upgraded_full22": UPGRADED_ROW_WEIGHT,
            },
            "schema_version": SCHEMA,
            "selection": {
                "maximum_epochs_per_trial": MAX_EPOCHS,
                "patience": PATIENCE,
                "trial_grid": [copy.deepcopy(value) for value in TRIAL_GRID],
            },
            "training": {
                "human_batch_size": HUMAN_BATCH_SIZE,
                "human_loss_coefficient": HUMAN_LOSS_COEFFICIENT,
                "seed": SEED,
                "synthetic_batch_size": SYNTHETIC_BATCH_SIZE,
                "synthetic_loss_coefficient": SYNTHETIC_LOSS_COEFFICIENT,
            },
        }
    )


def _assert_fixed_contract(contract: Mapping[str, Any]) -> None:
    base.validate_record_seal(contract, location="v5 continuation contract")
    boundary = _mapping(contract.get("boundaries"), "continuation boundaries")
    selection = _mapping(contract.get("selection"), "continuation selection")
    weights = _mapping(contract.get("row_weights"), "continuation weights")
    if (
        contract.get("schema_version") != SCHEMA
        or contract.get("candidate_bias_allowed") is not False
        or int(contract.get("candidate_count", -1)) != EXPECTED_CANDIDATES
        or float(contract.get("prototype_score_coefficient", math.nan))
        != PROTOTYPE_SCORE_COEFFICIENT
        or boundary.get("encoder_executions") != 0
        or boundary.get("fresh64_accessed") is not False
        or boundary.get("hidden_test_labels_deserialized") != 0
        or boundary.get("hidden_test_pixels_opened") != 0
        or boundary.get("library_40qa_accessed") is not False
        or boundary.get("optimizer_uses_val33") is not False
        or boundary.get("selection_uses_val33") is not True
        or int(selection.get("maximum_epochs_per_trial", -1)) != MAX_EPOCHS
        or int(selection.get("patience", -1)) != PATIENCE
        or selection.get("trial_grid") != list(TRIAL_GRID)
        or float(weights.get("existing_full22", math.nan)) != FULL22_ROW_WEIGHT
        or tuple(float(value) for value in weights.get("legacy_partial_grid", ()))
        != (0.0, 0.10)
        or float(weights.get("upgraded_full22", math.nan)) != UPGRADED_ROW_WEIGHT
    ):
        raise MangaFontV5ContinuationError("sealed continuation policy drifted")


def run(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontV5ContinuationError("continuation output already exists")

    preparation.validate(args.readiness_dir)
    readiness_root = args.readiness_dir.expanduser().resolve()
    readiness_report = base.read_json(
        readiness_root / preparation.REPORT, location="v5 readiness report"
    )
    readiness_plan = base.read_json(
        readiness_root / preparation.PLAN, location="v5 readiness plan"
    )
    _assert_readiness_plan(readiness_plan)
    exact_head = readiness_root / preparation.HEAD

    sweep.validate_cache(args.cache_dir)
    cache_root = args.cache_dir.expanduser().resolve()
    cache_contract, base_arrays = sweep._load_cache_arrays(  # noqa: SLF001
        cache_root
    )
    if set(base_arrays) != EXPECTED_ARRAYS:
        raise MangaFontV5ContinuationError("cache array inventory escaped train/val")
    readiness_cache = _mapping(
        readiness_report.get("current_cache"), "readiness current cache"
    )
    if (
        readiness_cache.get("arrays_sha256")
        != base.sha256_file(cache_root / sweep.CACHE_ARRAYS)
        or readiness_cache.get("contract_sha256")
        != base.sha256_file(cache_root / sweep.CACHE_CONTRACT)
    ):
        raise MangaFontV5ContinuationError("cache no longer matches reproduced head")

    examples, authority_validation = authority.load_authority_examples(
        args.authority_dir,
        review_dir=args.review_dir,
        draft_dir=args.draft_dir,
        legacy_overlay_dir=args.legacy_overlay_dir,
        catalog_registry=args.catalog_registry,
    )
    candidate_ids = tuple(str(value) for value in cache_contract["candidate_ids"])
    if candidate_ids != authority.FULL22_IDS or len(candidate_ids) != EXPECTED_CANDIDATES:
        raise MangaFontV5ContinuationError("candidate order drifted")
    preparation.validate_upgrade_authority(
        authority_validation, expected_new7=authority.NEW7_IDS
    )
    base_array_hashes = {
        name: _array_sha(value) for name, value in base_arrays.items()
    }
    arrays, overlay_audit = preparation.apply_full22_upgrade_examples_to_cache(
        contract=cache_contract,
        arrays=base_arrays,
        examples=examples,
        candidate_ids=candidate_ids,
        authority_validation=authority_validation,
    )
    if any(
        _array_sha(base_arrays[name]) != digest
        for name, digest in base_array_hashes.items()
    ):
        raise MangaFontV5ContinuationError("overlay mutated source cache arrays")

    metadata = cache_contract.get("human_train")
    if not isinstance(metadata, list) or len(metadata) != EXPECTED_TRAIN_ROWS:
        raise MangaFontV5ContinuationError("human train metadata drifted")
    by_id = {str(row["sample_id"]): index for index, row in enumerate(metadata)}
    if len(by_id) != EXPECTED_TRAIN_ROWS:
        raise MangaFontV5ContinuationError("human train sample identities duplicate")
    upgraded_mask = np.zeros(EXPECTED_TRAIN_ROWS, dtype=np.bool_)
    for example in examples:
        upgraded_mask[by_id[example.sample_id]] = True
    before_full22 = int(np.count_nonzero(base_arrays["human_train_full22"]))
    after_full22 = int(np.count_nonzero(arrays["human_train_full22"]))
    if (
        len(examples) != EXPECTED_UPGRADED
        or int(np.count_nonzero(upgraded_mask)) != EXPECTED_UPGRADED
        or before_full22 != EXPECTED_BASE_FULL22
        or after_full22 != EXPECTED_FINAL_FULL22
        or not np.all(arrays["human_train_full22"][upgraded_mask])
        or arrays["human_val_embeddings"].shape[0] != EXPECTED_VAL_ROWS
        or arrays["synthetic_embeddings"].shape[0] != EXPECTED_SYNTHETIC_ROWS
    ):
        raise MangaFontV5ContinuationError("full22 overlay population drifted")

    try:
        import torch
        from safetensors.torch import save_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV5ContinuationError("torch and safetensors are required") from error
    if not torch.cuda.is_available():
        raise MangaFontV5ContinuationError("v5 continuation requires CUDA")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.use_deterministic_algorithms(True)

    prototypes = torch.from_numpy(arrays["prototype_features"]).to("cuda")
    bags = _candidate_bags(torch, cache_contract["prototype_bags"])
    synthetic_embeddings = torch.from_numpy(arrays["synthetic_embeddings"]).to("cuda")
    synthetic_labels = torch.from_numpy(arrays["synthetic_labels"]).to("cuda")
    train_embeddings = torch.from_numpy(arrays["human_train_embeddings"]).to("cuda")
    train_targets = torch.from_numpy(arrays["human_train_targets"]).to("cuda")
    train_masks = torch.from_numpy(arrays["human_train_masks"]).to("cuda")
    val_embeddings = torch.from_numpy(arrays["human_val_embeddings"]).to("cuda")
    val_targets = torch.from_numpy(arrays["human_val_targets"]).to("cuda")
    val_masks = torch.from_numpy(arrays["human_val_masks"]).to("cuda")
    val_roles = torch.from_numpy(arrays["human_val_role"]).to("cuda")

    baseline_ranker = _load_exact_ranker(torch, exact_head, len(candidate_ids))
    baseline_metrics = preparation.evaluate_cached_val(
        torch,
        ranker=baseline_ranker,
        contract=cache_contract,
        arrays=arrays,
        candidate_ids=candidate_ids,
    )
    if _metric_hits(baseline_metrics) != EXPECTED_START_HITS:
        raise MangaFontV5ContinuationError("exact starting metrics were not reproduced")
    baseline_gate = promotion_gate(baseline_metrics)
    global_metrics = copy.deepcopy(baseline_metrics)
    global_gate = copy.deepcopy(baseline_gate)
    global_state = _snapshot_state(baseline_ranker)
    global_selection: dict[str, Any] = {
        "epoch": 0,
        "source": "exact_starting_head",
        "trial": 0,
    }
    del baseline_ranker

    steps_per_epoch = math.ceil(EXPECTED_SYNTHETIC_ROWS / SYNTHETIC_BATCH_SIZE)
    optimizer_executions = 0
    validation_executions = 1
    trials: list[dict[str, Any]] = []
    for trial_index, config in enumerate(_trial_grid(), 1):
        seed = SEED + trial_index
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        ranker = _load_exact_ranker(torch, exact_head, len(candidate_ids))
        optimizer = torch.optim.AdamW(
            ranker.parameters(),
            lr=config["head_learning_rate"],
            weight_decay=WEIGHT_DECAY,
            foreach=False,
        )
        weights = build_train_row_weights(
            full22=arrays["human_train_full22"],
            upgraded=upgraded_mask,
            legacy_partial_loss_weight=config["legacy_partial_loss_weight"],
        )
        row_weights = torch.from_numpy(weights).to("cuda")
        best_metrics = copy.deepcopy(baseline_metrics)
        best_gate = copy.deepcopy(baseline_gate)
        best_state = _snapshot_state(ranker)
        best_epoch = 0
        history: list[dict[str, Any]] = []
        stale = 0
        for epoch in range(1, MAX_EPOCHS + 1):
            ranker.train(True)
            generator = torch.Generator(device="cuda")
            generator.manual_seed(seed + epoch)
            synthetic_order = torch.randperm(
                EXPECTED_SYNTHETIC_ROWS, generator=generator, device="cuda"
            )
            sums: Counter[str] = Counter()
            for step in range(steps_per_epoch):
                synthetic_index = synthetic_order[
                    step * SYNTHETIC_BATCH_SIZE : (step + 1) * SYNTHETIC_BATCH_SIZE
                ]
                human_index = torch.randint(
                    EXPECTED_TRAIN_ROWS,
                    (HUMAN_BATCH_SIZE,),
                    generator=generator,
                    device="cuda",
                )
                combined = torch.cat(
                    [synthetic_embeddings[synthetic_index], train_embeddings[human_index]],
                    dim=0,
                )
                optimizer.zero_grad(set_to_none=True)
                outputs = ranker(combined, prototypes, bags)
                synthetic_loss = torch.nn.functional.cross_entropy(
                    outputs["candidate_scores"][: len(synthetic_index)],
                    synthetic_labels[synthetic_index],
                )
                human_scores = outputs["candidate_scores"][len(synthetic_index) :]
                human_loss = v3.tiered_deployment_loss(
                    torch,
                    human_scores,
                    train_targets[human_index],
                    train_masks[human_index],
                    preferred_weight=1.0,
                    acceptable_weight=0.20,
                    row_weights=row_weights[human_index],
                )
                loss = (
                    SYNTHETIC_LOSS_COEFFICIENT * synthetic_loss
                    + HUMAN_LOSS_COEFFICIENT * human_loss
                )
                if not bool(torch.isfinite(loss)):
                    raise MangaFontV5ContinuationError("continuation loss became non-finite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(ranker.parameters(), GRADIENT_CLIP_NORM)
                optimizer.step()
                optimizer_executions += 1
                sums["human"] += float(human_loss.detach().item())
                sums["synthetic"] += float(synthetic_loss.detach().item())
                sums["total"] += float(loss.detach().item())

            metrics = sweep._cached_val_metrics(  # noqa: SLF001
                torch=torch,
                ranker=ranker,
                embeddings=val_embeddings,
                prototypes=prototypes,
                bags=bags,
                targets=val_targets,
                masks=val_masks,
                roles=val_roles,
                candidate_ids=candidate_ids,
            )
            validation_executions += 1
            gate = promotion_gate(metrics)
            history.append(
                {
                    "epoch": epoch,
                    "promotion_gate": gate,
                    "train_human_loss": sums["human"] / steps_per_epoch,
                    "train_loss": sums["total"] / steps_per_epoch,
                    "train_synthetic_loss": sums["synthetic"] / steps_per_epoch,
                    "val33": metrics,
                }
            )
            if _is_better(metrics, gate, best_metrics, best_gate):
                best_metrics = copy.deepcopy(metrics)
                best_gate = copy.deepcopy(gate)
                best_state = _snapshot_state(ranker)
                best_epoch = epoch
                stale = 0
            else:
                stale += 1
                if stale >= PATIENCE:
                    break

        trial = {
            "best_epoch": best_epoch,
            "best_metrics": best_metrics,
            "config": config,
            "epochs_executed": len(history),
            "history": history,
            "promotion_gate": best_gate,
            "seed": seed,
            "trial": trial_index,
        }
        trials.append(trial)
        if _is_better(best_metrics, best_gate, global_metrics, global_gate):
            global_metrics = copy.deepcopy(best_metrics)
            global_gate = copy.deepcopy(best_gate)
            global_state = best_state
            global_selection = {
                "epoch": best_epoch,
                "source": "continuation_trial",
                "trial": trial_index,
            }
        print(
            base.canonical_json(
                {
                    "best_hits": _metric_hits(best_metrics),
                    "event": "manga_font_v5_continuation_trial_complete",
                    "promotion_gate_passed": best_gate["passed"],
                    "trial": trial_index,
                }
            ),
            flush=True,
        )
        del optimizer, ranker, row_weights

    promotion_passed = global_gate["passed"] is True
    status = (
        "validation_gate_passed_research_checkpoint_not_deployed"
        if promotion_passed
        else "research_failed_promotion_gate_not_met_not_deployed"
    )
    input_bindings = {
        "authority_report_sha256": base.sha256_file(
            args.authority_dir.expanduser().resolve() / authority.REPORT_FILE
        ),
        "authority_rows_sha256": base.sha256_file(
            args.authority_dir.expanduser().resolve() / authority.AUTHORITY_FILE
        ),
        "cache_arrays_sha256": base.sha256_file(cache_root / sweep.CACHE_ARRAYS),
        "cache_contract_sha256": base.sha256_file(cache_root / sweep.CACHE_CONTRACT),
        "readiness_head_sha256": base.sha256_file(exact_head),
        "readiness_plan_sha256": base.sha256_file(readiness_root / preparation.PLAN),
        "readiness_report_sha256": base.sha256_file(readiness_root / preparation.REPORT),
    }
    contract_record = _fixed_contract(input_bindings=input_bindings)

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        save_file(
            global_state,
            staging / CHECKPOINT,
            metadata={
                "deployment_authorized": "false",
                "format": SCHEMA,
                "promotion_gate_passed": str(promotion_passed).lower(),
            },
        )
        (staging / CONTRACT).write_bytes(base.json_bytes(contract_record, pretty=True))
        checkpoint_descriptor = _descriptor(staging / CHECKPOINT)
        checkpoint_descriptor["candidate_bias_present"] = False
        checkpoint_descriptor["state_contract"] = _state_contract(global_state)
        report = base.seal_record(
            {
                "baseline": {
                    "exact_starting_head_reproduced": True,
                    "metrics": baseline_metrics,
                    "promotion_gate": baseline_gate,
                },
                "best_checkpoint": checkpoint_descriptor,
                "boundaries": {
                    "deployment_authorized": False,
                    "encoder_executions": 0,
                    "fresh64_accessed": False,
                    "hidden_test_labels_deserialized": 0,
                    "hidden_test_pixels_opened": 0,
                    "library_40qa_accessed": False,
                    "optimizer_executions": optimizer_executions,
                    "optimizer_uses_val33": False,
                    "selection_uses_val33": True,
                    "validation_executions": validation_executions,
                },
                "candidate_ids": list(candidate_ids),
                "continuation_contract_sha256": base.sha256_file(staging / CONTRACT),
                "input_bindings": input_bindings,
                "overlay_audit": {
                    **copy.deepcopy(overlay_audit),
                    "full22_rows_after": after_full22,
                    "full22_rows_before": before_full22,
                    "legacy_partial_rows_after": EXPECTED_TRAIN_ROWS - after_full22,
                },
                "promotion_gate": global_gate,
                "record_type": "manga_font_student_v5_continuation_report",
                "schema_version": SCHEMA,
                "selected": {
                    **global_selection,
                    "metrics": global_metrics,
                },
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "status": status,
                "steps_per_epoch": steps_per_epoch,
                "trials": trials,
            }
        )
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (REPORT, CONTRACT, CHECKPOINT)
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate(staging)
        if output.exists():
            raise MangaFontV5ContinuationError("continuation output appeared")
        os.rename(staging, output)
        published = True
        return validate(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    base.assert_exact_root_inventory(root, FILES, location="v5 continuation")
    marker = base.read_json(root / MARKER, location="v5 continuation marker")
    report = base.read_json(root / REPORT, location="v5 continuation report")
    contract = base.read_json(root / CONTRACT, location="v5 continuation contract")
    base.validate_record_seal(report, location="v5 continuation report")
    _assert_fixed_contract(contract)
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV5ContinuationError("v5 continuation metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "continuation artifacts")
    for name in (REPORT, CONTRACT, CHECKPOINT):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV5ContinuationError(f"continuation hash drifted: {name}")
    if report.get("continuation_contract_sha256") != base.sha256_file(root / CONTRACT):
        raise MangaFontV5ContinuationError("continuation contract binding drifted")
    if report.get("input_bindings") != contract.get("input_bindings"):
        raise MangaFontV5ContinuationError("continuation input binding drifted")

    boundary = _mapping(report.get("boundaries"), "continuation report boundary")
    if (
        boundary.get("deployment_authorized") is not False
        or boundary.get("encoder_executions") != 0
        or boundary.get("fresh64_accessed") is not False
        or boundary.get("hidden_test_labels_deserialized") != 0
        or boundary.get("hidden_test_pixels_opened") != 0
        or boundary.get("library_40qa_accessed") is not False
        or boundary.get("optimizer_uses_val33") is not False
        or boundary.get("selection_uses_val33") is not True
    ):
        raise MangaFontV5ContinuationError("continuation leakage/deployment boundary drifted")
    candidate_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
    if candidate_ids != authority.FULL22_IDS:
        raise MangaFontV5ContinuationError("continuation candidate order drifted")
    baseline = _mapping(report.get("baseline"), "continuation baseline")
    baseline_metrics = _mapping(baseline.get("metrics"), "continuation baseline metrics")
    if (
        baseline.get("exact_starting_head_reproduced") is not True
        or _metric_hits(baseline_metrics) != EXPECTED_START_HITS
        or baseline.get("promotion_gate") != promotion_gate(baseline_metrics)
    ):
        raise MangaFontV5ContinuationError("continuation starting reproduction drifted")

    trials = report.get("trials")
    if not isinstance(trials, list) or len(trials) != len(TRIAL_GRID):
        raise MangaFontV5ContinuationError("continuation trial count drifted")
    epoch_count = 0
    validated_trials: list[Mapping[str, Any]] = []
    for expected_index, (trial, expected_config) in enumerate(
        zip(trials, TRIAL_GRID, strict=True), 1
    ):
        row = _mapping(trial, f"continuation trial {expected_index}")
        history = row.get("history")
        if (
            int(row.get("trial", -1)) != expected_index
            or row.get("config") != expected_config
            or not isinstance(history, list)
            or not 1 <= len(history) <= MAX_EPOCHS
            or int(row.get("epochs_executed", -1)) != len(history)
            or int(row.get("best_epoch", -1)) not in range(0, len(history) + 1)
        ):
            raise MangaFontV5ContinuationError("continuation trial policy drifted")
        epoch_count += len(history)
        for epoch, epoch_row in enumerate(history, 1):
            record = _mapping(epoch_row, f"trial {expected_index} epoch {epoch}")
            metrics = _mapping(record.get("val33"), "epoch val33")
            if (
                int(record.get("epoch", -1)) != epoch
                or record.get("promotion_gate") != promotion_gate(metrics)
            ):
                raise MangaFontV5ContinuationError("epoch selection record drifted")
        best_metrics = _mapping(row.get("best_metrics"), "trial best metrics")
        best_epoch = int(row.get("best_epoch", -1))
        expected_best_metrics = (
            baseline_metrics
            if best_epoch == 0
            else _mapping(history[best_epoch - 1], "best epoch row").get("val33")
        )
        if (
            best_metrics != expected_best_metrics
            or row.get("promotion_gate") != promotion_gate(best_metrics)
        ):
            raise MangaFontV5ContinuationError("trial best gate drifted")
        validated_trials.append(row)
    expected_optimizer_executions = epoch_count * int(report.get("steps_per_epoch", -1))
    if (
        int(report.get("steps_per_epoch", -1))
        != math.ceil(EXPECTED_SYNTHETIC_ROWS / SYNTHETIC_BATCH_SIZE)
        or int(boundary.get("optimizer_executions", -1))
        != expected_optimizer_executions
        or int(boundary.get("validation_executions", -1)) != epoch_count + 1
    ):
        raise MangaFontV5ContinuationError("continuation execution count drifted")

    selected = _mapping(report.get("selected"), "continuation selected")
    selected_metrics = _mapping(selected.get("metrics"), "selected metrics")
    selected_source = selected.get("source")
    selected_trial = int(selected.get("trial", -1))
    selected_epoch = int(selected.get("epoch", -1))
    recomputed_metrics = baseline_metrics
    recomputed_gate = promotion_gate(baseline_metrics)
    recomputed_source = "exact_starting_head"
    recomputed_trial = 0
    recomputed_epoch = 0
    for trial in validated_trials:
        candidate_metrics = _mapping(trial.get("best_metrics"), "candidate metrics")
        candidate_gate = promotion_gate(candidate_metrics)
        if _is_better(
            candidate_metrics,
            candidate_gate,
            recomputed_metrics,
            recomputed_gate,
        ):
            recomputed_metrics = candidate_metrics
            recomputed_gate = candidate_gate
            recomputed_source = "continuation_trial"
            recomputed_trial = int(trial["trial"])
            recomputed_epoch = int(trial["best_epoch"])
    if (
        selected_source != recomputed_source
        or selected_trial != recomputed_trial
        or selected_epoch != recomputed_epoch
        or selected_metrics != recomputed_metrics
    ):
        raise MangaFontV5ContinuationError("global checkpoint selection drifted")
    selected_gate = promotion_gate(selected_metrics)
    if report.get("promotion_gate") != selected_gate:
        raise MangaFontV5ContinuationError("selected promotion gate drifted")
    passed = selected_gate["passed"] is True
    expected_status = (
        "validation_gate_passed_research_checkpoint_not_deployed"
        if passed
        else "research_failed_promotion_gate_not_met_not_deployed"
    )
    if report.get("status") != expected_status:
        raise MangaFontV5ContinuationError("continuation status drifted")

    checkpoint = _mapping(report.get("best_checkpoint"), "continuation checkpoint")
    if (
        checkpoint.get("sha256") != base.sha256_file(root / CHECKPOINT)
        or checkpoint.get("byte_size") != (root / CHECKPOINT).stat().st_size
        or checkpoint.get("candidate_bias_present") is not False
    ):
        raise MangaFontV5ContinuationError("continuation checkpoint binding drifted")
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV5ContinuationError("safetensors is required") from error
    state = dict(load_file(str(root / CHECKPOINT), device="cpu"))
    if (
        "runtime_ranker.candidate_residual.bias" in state
        or any(not name.startswith("runtime_ranker.") for name in state)
        or checkpoint.get("state_contract") != _state_contract(state)
    ):
        raise MangaFontV5ContinuationError("continuation state contract drifted")
    overlay = _mapping(report.get("overlay_audit"), "continuation overlay audit")
    if (
        int(overlay.get("upgraded_record_count", -1)) != EXPECTED_UPGRADED
        or int(overlay.get("full22_rows_before", -1)) != EXPECTED_BASE_FULL22
        or int(overlay.get("full22_rows_after", -1)) != EXPECTED_FINAL_FULL22
        or int(overlay.get("fabricated_new7_negative_count", -1)) != 0
        or int(overlay.get("old15_positive_tier_mutation_count", -1)) != 0
    ):
        raise MangaFontV5ContinuationError("continuation overlay audit drifted")
    return {
        "acceptable_hits": selected_gate["hits"]["acceptable_at1"],
        "deployment_authorized": False,
        "output_dir": str(root),
        "preferred_hits": selected_gate["hits"]["preferred_at1"],
        "promotion_gate_passed": passed,
        "status": expected_status,
        "variant_acceptable_hits": selected_gate["hits"]["variant_acceptable_at1"],
        "variant_preferred_hits": selected_gate["hits"]["variant_preferred_at1"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--readiness-dir", type=Path, required=True)
    run_parser.add_argument("--cache-dir", type=Path, required=True)
    run_parser.add_argument("--authority-dir", type=Path, required=True)
    run_parser.add_argument("--review-dir", type=Path, required=True)
    run_parser.add_argument("--draft-dir", type=Path, required=True)
    run_parser.add_argument("--legacy-overlay-dir", type=Path, required=True)
    run_parser.add_argument("--catalog-registry", type=Path, required=True)
    run_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run(args) if args.command == "run" else validate(args.output_dir)
    except (
        MangaFontV5ContinuationError,
        preparation.MangaFontV5PreparationError,
        authority.LegacyNew7ReviewError,
        sweep.MangaFontV3SweepError,
        base.MangaFontStudentError,
        OSError,
        json.JSONDecodeError,
    ) as error:
        raise SystemExit(f"manga-font-v5-continuation error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
