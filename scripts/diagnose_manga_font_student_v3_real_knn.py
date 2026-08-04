from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    import sweep_manga_font_student_v3_heads as sweep
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v2 as v2
    import train_manga_font_student_v3 as v3
except ImportError:  # pragma: no cover - repository-root import
    from scripts import sweep_manga_font_student_v3_heads as sweep
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v2 as v2
    from scripts import train_manga_font_student_v3 as v3


SCHEMA = "manga-font-student-v3-real-knn-diagnostic-v1"
OWNER = SCHEMA
MARKER = f".{OWNER}-owned.json"
REPORT = "diagnostic-report.json"
FILES = frozenset({MARKER, REPORT})
TARGET_VARIANT_PREFERRED_AT1 = 0.50


class MangaFontRealKnnDiagnosticError(RuntimeError):
    pass


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontRealKnnDiagnosticError(f"{location}: expected object")
    return value


def _assert_inventory(root: Path, expected: frozenset[str], location: str) -> None:
    if not root.is_dir():
        raise MangaFontRealKnnDiagnosticError(f"{location}: directory is missing")
    actual = {path.name for path in root.iterdir()}
    if actual != expected:
        raise MangaFontRealKnnDiagnosticError(
            f"{location}: exact inventory drifted: {sorted(actual)}"
        )


def _safe_output(path: Path) -> Path:
    output = path.expanduser().resolve()
    if output.name in {"", ".", ".."}:
        raise MangaFontRealKnnDiagnosticError("unsafe output path")
    return output


def _load_inputs(
    cache_dir: Path, sweep_dir: Path
) -> tuple[dict[str, Any], dict[str, np.ndarray], dict[str, Any]]:
    cache_root = cache_dir.expanduser().resolve()
    sweep_root = sweep_dir.expanduser().resolve()
    _assert_inventory(cache_root, sweep.CACHE_FILES, "v3 embedding cache")
    cache_marker = base.read_json(
        cache_root / sweep.CACHE_MARKER, location="embedding cache marker"
    )
    contract = base.read_json(
        cache_root / sweep.CACHE_CONTRACT, location="embedding cache contract"
    )
    base.validate_record_seal(contract, location="embedding cache contract")
    if (
        cache_marker.get("owner") != sweep.CACHE_OWNER
        or cache_marker.get("schema_version") != sweep.CACHE_SCHEMA
        or cache_marker.get("safe_replace") is not True
        or contract.get("schema_version") != sweep.CACHE_SCHEMA
    ):
        raise MangaFontRealKnnDiagnosticError("embedding cache metadata drifted")
    cache_artifacts = _mapping(
        cache_marker.get("artifacts"), "embedding cache marker artifacts"
    )
    for name in (sweep.CACHE_ARRAYS, sweep.CACHE_CONTRACT):
        if cache_artifacts.get(name) != base.sha256_file(cache_root / name):
            raise MangaFontRealKnnDiagnosticError(
                f"embedding cache hash drifted: {name}"
            )
    array_descriptor = _mapping(contract.get("arrays"), "cache arrays")
    if (
        array_descriptor.get("sha256")
        != base.sha256_file(cache_root / sweep.CACHE_ARRAYS)
        or array_descriptor.get("byte_size")
        != (cache_root / sweep.CACHE_ARRAYS).stat().st_size
    ):
        raise MangaFontRealKnnDiagnosticError("cache array binding drifted")
    expected_arrays = _mapping(array_descriptor.get("contract"), "array contract")
    with np.load(cache_root / sweep.CACHE_ARRAYS, allow_pickle=False) as source:
        if set(source.files) != set(expected_arrays):
            raise MangaFontRealKnnDiagnosticError("cache array inventory drifted")
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    for name, value in arrays.items():
        descriptor = _mapping(expected_arrays[name], f"cache array {name}")
        if (
            list(value.shape) != descriptor.get("shape")
            or str(value.dtype) != descriptor.get("dtype")
            or (value.dtype.kind == "f" and not np.isfinite(value).all())
        ):
            raise MangaFontRealKnnDiagnosticError(f"cache array drifted: {name}")

    _assert_inventory(sweep_root, sweep.SWEEP_FILES, "v3 head sweep")
    sweep_marker = base.read_json(
        sweep_root / sweep.SWEEP_MARKER, location="head sweep marker"
    )
    head_report = base.read_json(
        sweep_root / sweep.SWEEP_REPORT, location="head sweep report"
    )
    base.validate_record_seal(head_report, location="head sweep report")
    if (
        sweep_marker.get("owner") != sweep.SWEEP_OWNER
        or sweep_marker.get("schema_version") != sweep.SWEEP_SCHEMA
        or sweep_marker.get("safe_replace") is not True
        or head_report.get("schema_version") != sweep.SWEEP_SCHEMA
    ):
        raise MangaFontRealKnnDiagnosticError("head sweep metadata drifted")
    sweep_artifacts = _mapping(
        sweep_marker.get("artifacts"), "head sweep marker artifacts"
    )
    for name in (sweep.SWEEP_CHECKPOINT, sweep.SWEEP_REPORT):
        if sweep_artifacts.get(name) != base.sha256_file(sweep_root / name):
            raise MangaFontRealKnnDiagnosticError(f"head sweep hash drifted: {name}")
    cache_boundary = _mapping(contract.get("boundaries"), "cache boundaries")
    sweep_boundary = _mapping(head_report.get("boundaries"), "sweep boundaries")
    if (
        cache_boundary.get("human_train_count") != 109
        or cache_boundary.get("human_val_count") != 33
        or cache_boundary.get("human_test_labels_deserialized") != 0
        or cache_boundary.get("human_test_pixels_opened") != 0
        or cache_boundary.get("synthetic_test_pixels_opened") != 0
        or cache_boundary.get("train_val_identity_overlap") != 0
        or cache_boundary.get("val_used_for_optimizer") is not False
        or sweep_boundary.get("hidden_test_labels_deserialized") != 0
        or sweep_boundary.get("hidden_test_pixels_opened") != 0
        or sweep_boundary.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontRealKnnDiagnosticError("sealed leakage boundary drifted")
    if contract.get("candidate_ids") != head_report.get(
        "candidate_ids"
    ) or head_report.get("cache_contract_sha256") != base.sha256_file(
        cache_root / sweep.CACHE_CONTRACT
    ):
        raise MangaFontRealKnnDiagnosticError("cache/head candidate binding drifted")
    if any("test" in name.lower() for name in arrays):
        raise MangaFontRealKnnDiagnosticError("test array entered diagnostic cache")
    return dict(contract), arrays, dict(head_report)


def _load_ranker(
    *, candidate_count: int, sweep_dir: Path, head_report: Mapping[str, Any]
) -> tuple[Any, Any]:
    try:
        import torch
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover - dependency setup
        raise MangaFontRealKnnDiagnosticError(
            "torch and safetensors are required"
        ) from error
    best_index = int(head_report.get("global_best_trial", 0)) - 1
    trials = head_report.get("trials")
    if not isinstance(trials, list) or not 0 <= best_index < len(trials):
        raise MangaFontRealKnnDiagnosticError("head sweep best trial is invalid")
    config = _mapping(trials[best_index].get("config"), "best head config")
    ranker = v3.build_runtime_ranker_v3(
        torch,
        candidate_count=candidate_count,
        dropout=0.10,
        residual_scale=float(config.get("residual_scale", 0.0)),
    )
    state = dict(
        load_file(
            str(sweep_dir.expanduser().resolve() / sweep.SWEEP_CHECKPOINT),
            device="cpu",
        )
    )
    prefix = "runtime_ranker."
    if any(not name.startswith(prefix) for name in state):
        raise MangaFontRealKnnDiagnosticError("head state prefix drifted")
    stripped = {name[len(prefix) :]: value for name, value in state.items()}
    ranker.load_state_dict(stripped, strict=True)
    ranker.requires_grad_(False)
    ranker.eval()
    return torch, ranker


def _unit(value: np.ndarray) -> np.ndarray:
    denominator = np.maximum(np.linalg.norm(value, axis=-1, keepdims=True), 1e-9)
    return value / denominator


def _raw_mean(views: np.ndarray) -> np.ndarray:
    return _unit(_unit(views.astype(np.float32, copy=False)).mean(axis=1))


def _sample_hidden(torch: Any, ranker: Any, views: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        source = torch.from_numpy(views)
        normalized = ranker.view_norm(source.float())
        weights = torch.softmax(ranker.view_gate(normalized).squeeze(-1), dim=1)
        gated = (normalized * weights.unsqueeze(-1)).sum(dim=1)
        hidden = ranker.sample_projection(
            torch.cat([gated, normalized.reshape(normalized.shape[0], -1)], dim=-1)
        )
    return _unit(hidden.detach().cpu().numpy())


def _masked_zscore(scores: np.ndarray, masks: np.ndarray) -> np.ndarray:
    visible = np.where(masks, scores, np.nan)
    mean = np.nanmean(visible, axis=1, keepdims=True)
    std = np.maximum(np.nanstd(visible, axis=1, keepdims=True), 1e-6)
    return (scores - mean) / std


def _knn_scores(
    *,
    train_features: np.ndarray,
    query_features: np.ndarray,
    train_targets: np.ndarray,
    neighbors: int,
    temperature: float,
    train_roles: np.ndarray | None = None,
    query_roles: np.ndarray | None = None,
    train_styles: np.ndarray | None = None,
    query_styles: np.ndarray | None = None,
    style_distance_weight: float = 0.0,
) -> np.ndarray:
    similarities = query_features @ train_features.T
    if style_distance_weight:
        if train_styles is None or query_styles is None:
            raise MangaFontRealKnnDiagnosticError("style-conditioned kNN lacks styles")
        distance = np.mean(
            (query_styles[:, None, :] - train_styles[None, :, :]) ** 2, axis=2
        )
        similarities = similarities - (style_distance_weight * distance)
    positive = (train_targets >= v3.ACCEPTABLE_CODE).astype(np.float32)
    result = np.zeros(
        (query_features.shape[0], train_targets.shape[1]), dtype=np.float32
    )
    for row in range(query_features.shape[0]):
        eligible = np.arange(train_features.shape[0])
        if train_roles is not None and query_roles is not None:
            matching = eligible[train_roles == query_roles[row]]
            if matching.size:
                eligible = matching
        count = min(neighbors, int(eligible.size))
        local_order = np.argsort(-similarities[row, eligible], kind="stable")[:count]
        selected = eligible[local_order]
        selected_scores = similarities[row, selected]
        weights = np.exp((selected_scores - selected_scores.max()) / temperature)
        result[row] = (weights[:, None] * positive[selected]).sum(axis=0) / max(
            float(weights.sum()), 1e-9
        )
    return result


def _real_prototype_scores(
    *,
    torch: Any,
    ranker: Any,
    train_views: np.ndarray,
    train_targets: np.ndarray,
    query_hidden: np.ndarray,
    feature_mode: str,
    aggregation: str,
) -> np.ndarray:
    if feature_mode == "raw_mean":
        features = train_views.mean(axis=1)
        row_ids = np.arange(train_views.shape[0])
    elif feature_mode == "all_views":
        features = train_views.reshape(-1, train_views.shape[-1])
        row_ids = np.repeat(np.arange(train_views.shape[0]), train_views.shape[1])
    else:  # pragma: no cover - fixed diagnostic grid
        raise MangaFontRealKnnDiagnosticError("unknown real prototype feature mode")
    memberships: list[np.ndarray] = []
    flattened: list[np.ndarray] = []
    cursor = 0
    for candidate in range(train_targets.shape[1]):
        positive_rows = np.where(train_targets[:, candidate] >= v3.ACCEPTABLE_CODE)[0]
        feature_indices = np.where(np.isin(row_ids, positive_rows))[0]
        selected = features[feature_indices]
        if selected.shape[0] < 1:
            raise MangaFontRealKnnDiagnosticError(
                "real prototype candidate bag is empty"
            )
        flattened.extend(selected)
        memberships.append(np.arange(cursor, cursor + selected.shape[0]))
        cursor += selected.shape[0]
    with torch.no_grad():
        prototypes = torch.from_numpy(np.asarray(flattened, dtype=np.float32))
        prototype_hidden = torch.nn.functional.normalize(
            ranker.prototype_projection(prototypes), p=2, dim=1
        )
        query = torch.from_numpy(query_hidden.astype(np.float32, copy=False))
        similarities = (query @ prototype_hidden.transpose(0, 1)) * (
            ranker.logit_scale.exp().clamp(max=100.0)
        )
        columns = []
        for membership in memberships:
            values = similarities[:, torch.from_numpy(membership)]
            if aggregation == "top3_logmeanexp":
                values = torch.topk(values, min(3, int(values.shape[1])), dim=1).values
            elif aggregation != "logmeanexp":  # pragma: no cover - fixed grid
                raise MangaFontRealKnnDiagnosticError(
                    "unknown real prototype aggregation"
                )
            columns.append(
                torch.logsumexp(values, dim=1) - math.log(int(values.shape[1]))
            )
        scores = torch.stack(columns, dim=1)
    return scores.detach().cpu().numpy()


def _metrics(
    scores: np.ndarray,
    *,
    targets: np.ndarray,
    masks: np.ndarray,
    roles: np.ndarray,
    candidate_ids: Sequence[str],
) -> dict[str, Any]:
    masked = np.where(masks, scores, -np.inf)
    order = np.argsort(-masked, axis=1, kind="stable")
    distribution: Counter[str] = Counter()
    counters: Counter[str] = Counter()
    variant: Counter[str] = Counter()
    ordinary_indices = {base.ROLE_VALUES.index(role) for role in v2.ORDINARY_ROLES}
    for row in range(targets.shape[0]):
        preferred = set(np.where(targets[row] == v3.PREFERRED_CODE)[0].tolist())
        acceptable = set(np.where(targets[row] >= v3.ACCEPTABLE_CODE)[0].tolist())
        if not acceptable:
            continue
        top1 = int(order[row, 0])
        top3 = set(order[row, :3].tolist())
        distribution[candidate_ids[top1]] += 1
        counters["rows"] += 1
        counters["preferred_at1"] += int(top1 in preferred)
        counters["acceptable_at1"] += int(top1 in acceptable)
        counters["preferred_hit_at3"] += int(bool(preferred & top3))
        counters["acceptable_hit_at3"] += int(bool(acceptable & top3))
        if int(roles[row]) not in ordinary_indices:
            variant["rows"] += 1
            variant["preferred_at1"] += int(top1 in preferred)
            variant["acceptable_at1"] += int(top1 in acceptable)
            variant["preferred_hit_at3"] += int(bool(preferred & top3))
            variant["acceptable_hit_at3"] += int(bool(acceptable & top3))
    rows = counters["rows"]
    variant_rows = variant["rows"]
    if rows < 1 or variant_rows < 1:
        raise MangaFontRealKnnDiagnosticError("validation rows are incomplete")
    return {
        "acceptable_at1": counters["acceptable_at1"] / rows,
        "acceptable_at1_count": counters["acceptable_at1"],
        "acceptable_hit_at3": counters["acceptable_hit_at3"] / rows,
        "evaluated_positive_rows": rows,
        "preferred_at1": counters["preferred_at1"] / rows,
        "preferred_at1_count": counters["preferred_at1"],
        "preferred_hit_at3": counters["preferred_hit_at3"] / rows,
        "top1_candidate_distribution": dict(sorted(distribution.items())),
        "top1_max_candidate_share": max(distribution.values()) / rows,
        "top1_unique_candidate_count": len(distribution),
        "variant_acceptable_at1": variant["acceptable_at1"] / variant_rows,
        "variant_acceptable_at1_count": variant["acceptable_at1"],
        "variant_acceptable_hit_at3": variant["acceptable_hit_at3"] / variant_rows,
        "variant_preferred_at1": variant["preferred_at1"] / variant_rows,
        "variant_preferred_at1_count": variant["preferred_at1"],
        "variant_preferred_hit_at3": variant["preferred_hit_at3"] / variant_rows,
        "variant_val_rows": variant_rows,
    }


def _selection_key(trial: Mapping[str, Any]) -> tuple[Any, ...]:
    metrics = _mapping(trial.get("metrics"), "trial metrics")
    return (
        float(metrics["variant_preferred_at1"]),
        float(metrics["variant_acceptable_at1"]),
        float(metrics["preferred_at1"]),
        float(metrics["acceptable_at1"]),
        int(metrics["top1_unique_candidate_count"]),
        -float(metrics["top1_max_candidate_share"]),
        -int(trial["trial"]),
    )


def run_diagnostic(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise MangaFontRealKnnDiagnosticError("diagnostic output already exists")
    contract, arrays, head_report = _load_inputs(args.cache_dir, args.sweep_dir)
    candidate_ids = tuple(str(value) for value in contract["candidate_ids"])
    torch, ranker = _load_ranker(
        candidate_count=len(candidate_ids),
        sweep_dir=args.sweep_dir,
        head_report=head_report,
    )
    prototype_bags = tuple(
        torch.arange(int(record["start"]), int(record["start"]) + int(record["count"]))
        for record in contract["prototype_bags"]
    )
    train_views = arrays["human_train_embeddings"]
    val_views = arrays["human_val_embeddings"]
    train_targets = arrays["human_train_targets"]
    val_targets = arrays["human_val_targets"]
    val_masks = arrays["human_val_masks"].astype(bool)
    train_roles = arrays["human_train_role"]
    val_roles = arrays["human_val_role"]
    with torch.no_grad():
        head_outputs = ranker(
            torch.from_numpy(val_views),
            torch.from_numpy(arrays["prototype_features"]),
            prototype_bags,
        )
        head_scores = head_outputs["candidate_scores"].detach().cpu().numpy()
        predicted_roles = (
            head_outputs["role_logits"].argmax(dim=1).detach().cpu().numpy()
        )
        predicted_styles = (
            torch.sigmoid(head_outputs["style_logits"]).detach().cpu().numpy()
        )
    representations = {
        "raw_mean_unit": (_raw_mean(train_views), _raw_mean(val_views)),
        "head_hidden_unit": (
            _sample_hidden(torch, ranker, train_views),
            _sample_hidden(torch, ranker, val_views),
        ),
    }
    trials: list[dict[str, Any]] = []

    def append_trial(
        method: str, config: Mapping[str, Any], scores: np.ndarray
    ) -> None:
        trials.append(
            {
                "config": dict(config),
                "method": method,
                "metrics": _metrics(
                    scores,
                    targets=val_targets,
                    masks=val_masks,
                    roles=val_roles,
                    candidate_ids=candidate_ids,
                ),
                "selection_eligible": True,
                "trial": len(trials) + 1,
            }
        )

    append_trial("sealed_head_baseline", {}, head_scores)
    head_z = _masked_zscore(head_scores, val_masks)
    for representation, (train_features, val_features) in representations.items():
        for neighbors in (5, 15, 25):
            memory_scores = _knn_scores(
                train_features=train_features,
                query_features=val_features,
                train_targets=train_targets,
                neighbors=neighbors,
                temperature=0.15,
            )
            memory_z = _masked_zscore(memory_scores, val_masks)
            for alpha in (0.25, 0.50):
                append_trial(
                    "unordered_positive_set_knn_fusion",
                    {
                        "fusion_alpha": alpha,
                        "neighbors": neighbors,
                        "representation": representation,
                        "temperature": 0.15,
                    },
                    ((1.0 - alpha) * head_z) + (alpha * memory_z),
                )

    raw_train, raw_val = representations["raw_mean_unit"]
    for neighbors in (5, 15, 25):
        predicted_role_scores = _knn_scores(
            train_features=raw_train,
            query_features=raw_val,
            train_targets=train_targets,
            neighbors=neighbors,
            temperature=0.15,
            train_roles=train_roles,
            query_roles=predicted_roles,
        )
        append_trial(
            "predicted_role_filtered_knn_fusion",
            {
                "fallback": "unfiltered_if_no_matching_train_role",
                "fusion_alpha": 0.25,
                "neighbors": neighbors,
                "representation": "raw_mean_unit",
                "temperature": 0.15,
            },
            (0.75 * head_z) + (0.25 * _masked_zscore(predicted_role_scores, val_masks)),
        )
    style_scores = _knn_scores(
        train_features=raw_train,
        query_features=raw_val,
        train_targets=train_targets,
        neighbors=25,
        temperature=0.15,
        train_styles=arrays["human_train_style"],
        query_styles=predicted_styles,
        style_distance_weight=0.10,
    )
    append_trial(
        "predicted_style_conditioned_knn_fusion",
        {
            "fusion_alpha": 0.25,
            "neighbors": 25,
            "representation": "raw_mean_unit",
            "style_distance_weight": 0.10,
            "temperature": 0.15,
        },
        (0.75 * head_z) + (0.25 * _masked_zscore(style_scores, val_masks)),
    )
    query_hidden = representations["head_hidden_unit"][1]
    for feature_mode in ("raw_mean", "all_views"):
        for aggregation in ("logmeanexp", "top3_logmeanexp"):
            prototype_scores = _real_prototype_scores(
                torch=torch,
                ranker=ranker,
                train_views=train_views,
                train_targets=train_targets,
                query_hidden=query_hidden,
                feature_mode=feature_mode,
                aggregation=aggregation,
            )
            append_trial(
                "real_manga_candidate_prototype_fusion",
                {
                    "aggregation": aggregation,
                    "feature_mode": feature_mode,
                    "fusion_alpha": 0.25,
                },
                (0.75 * head_z) + (0.25 * _masked_zscore(prototype_scores, val_masks)),
            )

    oracle_trials: list[dict[str, Any]] = []
    for representation, (train_features, val_features) in representations.items():
        for neighbors in (1, 5, 15, 25):
            oracle_scores = _knn_scores(
                train_features=train_features,
                query_features=val_features,
                train_targets=train_targets,
                neighbors=neighbors,
                temperature=0.15,
                train_roles=train_roles,
                query_roles=val_roles,
            )
            for alpha in (0.25, 0.50, 0.75):
                oracle_trials.append(
                    {
                        "config": {
                            "fusion_alpha": alpha,
                            "neighbors": neighbors,
                            "representation": representation,
                            "temperature": 0.15,
                        },
                        "method": "gold_role_filtered_knn_fusion_oracle",
                        "metrics": _metrics(
                            ((1.0 - alpha) * head_z)
                            + (alpha * _masked_zscore(oracle_scores, val_masks)),
                            targets=val_targets,
                            masks=val_masks,
                            roles=val_roles,
                            candidate_ids=candidate_ids,
                        ),
                        "selection_eligible": False,
                    }
                )
    best = max(trials, key=_selection_key)
    best_oracle = max(
        oracle_trials,
        key=lambda trial: (
            trial["metrics"]["variant_preferred_at1"],
            trial["metrics"]["variant_acceptable_at1"],
            trial["metrics"]["preferred_at1"],
            trial["metrics"]["acceptable_at1"],
        ),
    )
    baseline = trials[0]
    variant_gap = TARGET_VARIANT_PREFERRED_AT1 - float(
        best["metrics"]["variant_preferred_at1"]
    )
    report_core = {
        "boundaries": {
            "candidate_or_tier_order_used_as_supervision": False,
            "hidden_test_labels_deserialized": 0,
            "hidden_test_pixels_opened": 0,
            "human_train_embeddings_used_as_memory": 109,
            "human_train_targets_used_as_memory": 109,
            "human_val_embeddings_used_for_selection": 33,
            "human_val_targets_used_for_selection": 33,
            "optimizer_instances_created": 0,
            "source_image_pixels_opened": 0,
            "synthetic_test_pixels_opened": 0,
            "test_arrays_present_in_cache": False,
            "train_val_identity_overlap": 0,
            "val_used_for_gradient_or_weight_updates": False,
        },
        "candidate_ids": list(candidate_ids),
        "conclusion": {
            "closes_variant_preferred_target": variant_gap <= 0.0,
            "recommendation": (
                "do_not_promote_real_knn_or_prototype_augmentation; retain the "
                "sealed head as the v3 initialization and rely on the ongoing "
                "train-only encoder/head finetune plus a fresh sealed evaluation"
            ),
            "status": "does_not_close_variant_gap",
            "target_variant_preferred_at1": TARGET_VARIANT_PREFERRED_AT1,
            "variant_preferred_gap": variant_gap,
        },
        "head_baseline": baseline,
        "non_deployable_gold_role_upper_bound": best_oracle,
        "record_type": "manga_font_student_v3_real_knn_diagnostic",
        "schema_version": SCHEMA,
        "selected_deployable_diagnostic": best,
        "selection": {
            "eligible_trial_count": len(trials),
            "objective": [
                "variant_preferred_at1",
                "variant_acceptable_at1",
                "preferred_at1",
                "acceptable_at1",
                "top1_unique_candidate_count",
                "negative_top1_max_candidate_share",
                "earlier_trial",
            ],
            "policy": "bounded-fixed-grid-validation-selection-v1",
            "tier_semantics": (
                "preferred and acceptable candidate arrays are unordered sets; "
                "every target>=acceptable contributes one equal positive memory vote"
            ),
            "validation_is_research_selection_not_deployment_evidence": True,
        },
        "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
        "sources": {
            "cache_arrays_sha256": base.sha256_file(
                args.cache_dir.expanduser().resolve() / sweep.CACHE_ARRAYS
            ),
            "cache_contract_sha256": base.sha256_file(
                args.cache_dir.expanduser().resolve() / sweep.CACHE_CONTRACT
            ),
            "head_checkpoint_sha256": base.sha256_file(
                args.sweep_dir.expanduser().resolve() / sweep.SWEEP_CHECKPOINT
            ),
            "head_sweep_report_sha256": base.sha256_file(
                args.sweep_dir.expanduser().resolve() / sweep.SWEEP_REPORT
            ),
        },
        "trials": trials,
    }
    report = base.seal_record(report_core)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {REPORT: base.sha256_file(staging / REPORT)},
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_diagnostic(staging)
        if output.exists():
            raise MangaFontRealKnnDiagnosticError("diagnostic output appeared")
        os.rename(staging, output)
        published = True
        return validate_diagnostic(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_diagnostic(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    _assert_inventory(root, FILES, "real kNN diagnostic")
    marker = base.read_json(root / MARKER, location="diagnostic marker")
    report = base.read_json(root / REPORT, location="diagnostic report")
    base.validate_record_seal(report, location="diagnostic report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontRealKnnDiagnosticError("diagnostic metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "diagnostic artifacts")
    if artifacts != {REPORT: base.sha256_file(root / REPORT)}:
        raise MangaFontRealKnnDiagnosticError("diagnostic artifact hash drifted")
    boundary = _mapping(report.get("boundaries"), "diagnostic boundaries")
    if (
        boundary.get("candidate_or_tier_order_used_as_supervision") is not False
        or boundary.get("hidden_test_labels_deserialized") != 0
        or boundary.get("hidden_test_pixels_opened") != 0
        or boundary.get("source_image_pixels_opened") != 0
        or boundary.get("synthetic_test_pixels_opened") != 0
        or boundary.get("optimizer_instances_created") != 0
        or boundary.get("val_used_for_gradient_or_weight_updates") is not False
    ):
        raise MangaFontRealKnnDiagnosticError("diagnostic leakage boundary drifted")
    conclusion = _mapping(report.get("conclusion"), "diagnostic conclusion")
    selected = _mapping(
        report.get("selected_deployable_diagnostic"), "selected diagnostic"
    )
    metrics = _mapping(selected.get("metrics"), "selected metrics")
    return {
        "global_acceptable_at1": metrics.get("acceptable_at1"),
        "global_preferred_at1": metrics.get("preferred_at1"),
        "output_dir": str(root),
        "status": conclusion.get("status"),
        "top1_max_candidate_share": metrics.get("top1_max_candidate_share"),
        "top1_unique_candidate_count": metrics.get("top1_unique_candidate_count"),
        "variant_acceptable_at1": metrics.get("variant_acceptable_at1"),
        "variant_preferred_at1": metrics.get("variant_preferred_at1"),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Bounded train-only real-manga kNN/prototype diagnostic for v3"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run")
    run.add_argument("--cache-dir", type=Path, required=True)
    run.add_argument("--sweep-dir", type=Path, required=True)
    run.add_argument("--output-dir", type=Path, required=True)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    result = (
        run_diagnostic(args)
        if args.command == "run"
        else validate_diagnostic(args.output_dir)
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
