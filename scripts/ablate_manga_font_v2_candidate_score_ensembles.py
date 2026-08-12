#!/usr/bin/env python3
"""Read-only candidate-score ablations for the MangaFont v2 adapter.

The experiment deliberately freezes the production-relevant parts of r3h:

* the pixel-only family logits and their predicted-family route;
* the TypeScript-equivalent Single Day eligibility rule; and
* every label/data split.

Only candidate score sources are exchanged.  The human val33 cohort is
reported as a repeatedly observed diagnostic and is never used to fit,
select, or otherwise mutate a checkpoint.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import build_manga_font_student_v8_role_family_dataset as dataset
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v8_role_family_adapter as r3h
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_student_v8_role_family_dataset as dataset
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v8_role_family_adapter as r3h


SCHEMA = "manga-font-v2-candidate-score-ensemble-ablation-v1"
REPORT = "report.json"
SCORE_ARCHIVE = "scores-val.npz"
MARKER = ".manga-font-v2-candidate-score-ensemble-ablation-owned.json"
BODY = r3h.BODY_FAMILY_INDEX
VARIANT = r3h.VARIANT_FAMILY_INDEX
BLEND_ALPHAS = (0.15, 0.25, 0.35)


class ScoreAblationError(ValueError):
    """Raised when a source or evaluation boundary is not trustworthy."""


@dataclass(frozen=True)
class CacheBinding:
    cache_index: int


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ScoreAblationError(f"{path}: expected a JSON object")
    return value


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values.astype(np.float64) - values.max(axis=1, keepdims=True)
    result = np.exp(shifted)
    return result / result.sum(axis=1, keepdims=True)


def convex_probability_blend(
    anchor_scores: np.ndarray, other_scores: np.ndarray, alpha: float
) -> np.ndarray:
    """Return log probabilities from a fixed, bounded convex blend."""

    if alpha not in BLEND_ALPHAS:
        raise ScoreAblationError("blend alpha escaped the predeclared grid")
    if anchor_scores.shape != other_scores.shape or anchor_scores.ndim != 2:
        raise ScoreAblationError("blend score shapes drifted")
    probabilities = (1.0 - alpha) * _softmax(anchor_scores)
    probabilities += alpha * _softmax(other_scores)
    return np.log(np.clip(probabilities, 1e-12, None)).astype(np.float32)


def production_route(
    *,
    body_scores: np.ndarray,
    variant_scores: np.ndarray,
    family_logits: np.ndarray,
    single_day_index: int,
) -> Mapping[str, np.ndarray]:
    """Mirror r3h predicted-family routing and the current TS Single Day mask."""

    if (
        body_scores.shape != variant_scores.shape
        or body_scores.ndim != 2
        or family_logits.shape != (body_scores.shape[0], 2)
        or not 0 <= single_day_index < body_scores.shape[1]
    ):
        raise ScoreAblationError("production route tensor shapes drifted")
    family_probabilities = _softmax(family_logits)
    predicted_family = family_probabilities.argmax(axis=1)
    raw_scores = np.where(
        (predicted_family == BODY)[:, None], body_scores, variant_scores
    ).astype(np.float32, copy=True)

    competitor_scores = raw_scores.copy()
    competitor_scores[:, single_day_index] = -np.inf
    raw_margin = raw_scores[:, single_day_index] - competitor_scores.max(axis=1)
    allowed = (
        (predicted_family == VARIANT)
        & (
            family_probabilities[:, VARIANT]
            >= r3h.MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE
        )
        & (raw_margin >= r3h.MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN)
    )

    deployed_scores = raw_scores.copy()
    competitors_for_min = raw_scores.copy()
    competitors_for_min[:, single_day_index] = np.inf
    minimum_competitor = competitors_for_min.min(axis=1)
    deployed_scores[~allowed, single_day_index] = (
        minimum_competitor[~allowed] - 1.0
    )
    return {
        "deployed_scores": deployed_scores,
        "family_probabilities": family_probabilities.astype(np.float32),
        "predicted_family": predicted_family.astype(np.int8),
        "raw_margin": raw_margin.astype(np.float32),
        "raw_scores": raw_scores,
        "single_day_allowed": allowed,
    }


def cohort_metrics(
    *,
    routed: Mapping[str, np.ndarray],
    family_labels: np.ndarray,
    positive_mask: np.ndarray,
    preferred_mask: np.ndarray,
    font_supervision_weights: np.ndarray,
    single_day_body_negative: np.ndarray,
    single_day_index: int,
) -> Mapping[str, Any]:
    """Compute label metrics without using them to choose a score source."""

    scores = routed["deployed_scores"]
    predicted_family = routed["predicted_family"]
    count = int(scores.shape[0])
    if (
        family_labels.shape != (count,)
        or positive_mask.shape != scores.shape
        or preferred_mask.shape != scores.shape
        or font_supervision_weights.shape != (count,)
        or single_day_body_negative.shape != (count,)
    ):
        raise ScoreAblationError("cohort metric tensor shapes drifted")
    supervised = (font_supervision_weights > 0) & positive_mask.any(axis=1)
    if not supervised.any():
        raise ScoreAblationError("cohort has no candidate-supervised rows")
    order = np.argsort(-scores, axis=1, kind="stable")
    top1 = order[:, 0]
    supervised_top1 = top1[supervised]
    preferred_supervised = supervised & preferred_mask.any(axis=1)
    row = np.arange(count)
    preferred_at1 = preferred_mask[row, top1]
    acceptable_at1 = positive_mask[row, top1]
    preferred_at3 = np.take_along_axis(preferred_mask, order[:, :3], axis=1).any(
        axis=1
    )
    acceptable_at3 = np.take_along_axis(positive_mask, order[:, :3], axis=1).any(
        axis=1
    )
    sd_positive = supervised & positive_mask[:, single_day_index]
    sd_predicted = supervised & (top1 == single_day_index)
    distribution = Counter(int(value) for value in supervised_top1.tolist())
    max_count = max(distribution.values())
    return {
        "acceptable_at1": float(acceptable_at1[supervised].mean()),
        "acceptable_hit_at3": float(acceptable_at3[supervised].mean()),
        "candidate_supervised_rows": int(supervised.sum()),
        "family_accuracy": float((predicted_family == family_labels).mean()),
        "preferred_at1": float(preferred_at1[preferred_supervised].mean()),
        "preferred_hit_at3": float(preferred_at3[preferred_supervised].mean()),
        "preferred_supervised_rows": int(preferred_supervised.sum()),
        "rows": count,
        "single_day_all_top1_count": int((top1 == single_day_index).sum()),
        "single_day_all_top1_rate": float((top1 == single_day_index).mean()),
        "single_day_allowed_rows": int(routed["single_day_allowed"].sum()),
        "single_day_positive_count": int(sd_positive.sum()),
        "single_day_positive_precision": (
            float((sd_predicted & sd_positive).sum() / sd_predicted.sum())
            if sd_predicted.any()
            else None
        ),
        "single_day_positive_recall": (
            float((sd_predicted & sd_positive).sum() / sd_positive.sum())
            if sd_positive.any()
            else None
        ),
        "single_day_predicted_count": int(sd_predicted.sum()),
        "single_day_body_false_top1_count": int(
            (single_day_body_negative & (top1 == single_day_index)).sum()
        ),
        "single_day_body_false_top1_rate": float(
            (single_day_body_negative & (top1 == single_day_index)).sum()
            / max(1, int(single_day_body_negative.sum()))
        ),
        "single_day_body_negative_rows": int(single_day_body_negative.sum()),
        "top1_distribution_indices": {
            str(key): int(value) for key, value in sorted(distribution.items())
        },
        "top1_max_candidate_share": float(max_count / supervised.sum()),
        "top1_unique_candidate_count": len(distribution),
    }


def val33_indices(sample_ids: np.ndarray, finals_path: Path) -> np.ndarray:
    """Resolve the diagnostic IDs only; never expose labels to model code."""

    ids: list[str] = []
    with finals_path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            value = json.loads(line)
            sample_id = value.get("sample_id")
            if not isinstance(sample_id, str) or not sample_id:
                raise ScoreAblationError("val33 final lacks sample_id")
            ids.append(sample_id)
    if len(ids) != 33 or len(set(ids)) != 33:
        raise ScoreAblationError("val33 diagnostic identity count drifted")
    index = {str(value): offset for offset, value in enumerate(sample_ids.tolist())}
    missing = set(ids) - index.keys()
    if missing:
        raise ScoreAblationError(f"val33 has {len(missing)} rows outside the dataset")
    return np.asarray([index[value] for value in ids], dtype=np.int64)


def _load_r3h(
    root: Path, *, torch: Any, candidate_count: int, device: Any
) -> tuple[Any, Mapping[str, Any]]:
    from safetensors.torch import load_file

    manifest = _json(root / r3h.MANIFEST_FILE)
    architecture = manifest.get("architecture")
    if not isinstance(architecture, dict):
        raise ScoreAblationError("r3h architecture is absent")
    if (
        manifest.get("schema_version") != r3h.SCHEMA_VERSION
        or architecture.get("text_or_font_name_or_gemma_input") is not False
    ):
        raise ScoreAblationError("r3h pixel-only architecture boundary drifted")
    model = r3h.build_role_family_adapter(
        torch,
        candidate_count=candidate_count,
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(
            architecture["candidate_residual_hidden_dim"]
        ),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    model.load_state_dict(
        load_file(str(root / r3h.CHECKPOINT_FILE), device="cpu"), strict=True
    )
    model.requires_grad_(False).eval().to(device)
    return model, manifest


def _adapter_outputs(
    *,
    torch: Any,
    model: Any,
    query_views: np.ndarray,
    prototypes: np.ndarray,
    device: Any,
    batch_size: int,
) -> Mapping[str, np.ndarray]:
    names = ("body_candidate_scores", "variant_candidate_scores", "family_logits")
    collected: dict[str, list[np.ndarray]] = {name: [] for name in names}
    prototype_tensor = torch.from_numpy(prototypes.astype(np.float32)).to(device)
    with torch.inference_mode():
        for start in range(0, len(query_views), batch_size):
            views = torch.from_numpy(
                query_views[start : start + batch_size].astype(np.float32)
            ).to(device)
            output = model(views, prototype_tensor)
            for name in names:
                collected[name].append(output[name].float().cpu().numpy())
    return {name: np.concatenate(values) for name, values in collected.items()}


def _scores_from_queries(
    query_views: np.ndarray,
    prototypes: np.ndarray,
    *,
    query_weight_logits: np.ndarray,
    logit_scale: float,
) -> np.ndarray:
    sample = query_views.astype(np.float32).mean(axis=1)
    sample /= np.clip(np.linalg.norm(sample, axis=-1, keepdims=True), 1e-12, None)
    prototype = prototypes.astype(np.float32)
    prototype /= np.clip(
        np.linalg.norm(prototype, axis=-1, keepdims=True), 1e-12, None
    )
    per_query = np.einsum("bqd,cqd->bcq", sample, prototype, optimize=True)
    weights = _softmax(np.asarray(query_weight_logits, dtype=np.float32)[None, :])[0]
    return (
        min(math.exp(float(logit_scale)), 100.0)
        * np.einsum("bcq,q->bc", per_query, weights, optimize=True)
    ).astype(np.float32)


def _load_v7_scores(
    query_views: np.ndarray,
    prototypes: np.ndarray,
    source_dir: Path,
) -> tuple[np.ndarray, Mapping[str, Any]]:
    from safetensors.torch import load_file

    state = load_file(str(source_dir / "best-fontquery-head.safetensors"), device="cpu")
    scores = _scores_from_queries(
        query_views,
        prototypes,
        query_weight_logits=state["query_weight_logits"].numpy(),
        logit_scale=float(state["logit_scale"].item()),
    )
    return scores, {
        "checkpoint_sha256": _sha256(source_dir / "best-fontquery-head.safetensors"),
        "prototype_sha256": _sha256(source_dir / "candidate-query-prototypes.f32"),
    }


def _cache_bindings(cache_root: Path, sample_ids: Sequence[str]) -> list[CacheBinding]:
    wanted = set(sample_ids)
    found: dict[str, int] = {}
    with (cache_root / "sample-index.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            value = json.loads(line)
            sample_id = value.get("sample_id")
            if sample_id in wanted:
                found[str(sample_id)] = int(value["cache_index"])
    if found.keys() != wanted:
        raise ScoreAblationError(
            f"hidden cache lacks {len(wanted - found.keys())} requested samples"
        )
    return [CacheBinding(found[value]) for value in sample_ids]


def _load_v6_r2_scores(
    *,
    cache_root: Path,
    sample_ids: Sequence[str],
    source_dir: Path,
    active_candidate_ids: Sequence[str],
    device_name: str,
    batch_size: int,
) -> tuple[np.ndarray, Mapping[str, Any]]:
    import torch
    from safetensors.torch import load_file

    report = _json(source_dir / "report.json")
    source_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
    if not set(active_candidate_ids) <= set(source_ids):
        raise ScoreAblationError("v6-r2 candidate vocabulary cannot project to active21")
    state = load_file(str(source_dir / "best-fontquery-head.safetensors"), device="cpu")
    head = v6.build_font_query_head(
        torch, query_count=dataset.QUERY_COUNT, query_dim=dataset.QUERY_DIM
    )
    head.load_state_dict(state, strict=True)
    device = torch.device(device_name)
    head.requires_grad_(False).eval().to(device)
    cache_manifest = _json(cache_root / "manifest.json")
    bindings = _cache_bindings(cache_root, sample_ids)
    query_views = dataset._extract_query_views(  # noqa: SLF001
        cache_root=cache_root,
        cache_manifest=cache_manifest,
        bindings=bindings,
        torch=torch,
        head=head,
        device_name=device_name,
        batch_size=batch_size,
    )
    prototypes = np.fromfile(
        source_dir / "candidate-query-prototypes.f32", dtype="<f4"
    ).reshape(len(source_ids), dataset.QUERY_COUNT, dataset.QUERY_DIM)
    selected = np.asarray([source_ids.index(value) for value in active_candidate_ids])
    scores = _scores_from_queries(
        query_views,
        prototypes[selected],
        query_weight_logits=state["query_weight_logits"].numpy(),
        logit_scale=float(state["logit_scale"].item()),
    )
    return scores, {
        "candidate_projection": list(active_candidate_ids),
        "checkpoint_sha256": _sha256(source_dir / "best-fontquery-head.safetensors"),
        "prototype_sha256": _sha256(source_dir / "candidate-query-prototypes.f32"),
        "query_recomputed_from_pixel_hidden_cache": True,
        "retired_candidates_removed": sorted(set(source_ids) - set(active_candidate_ids)),
    }


def _evaluate_source(
    *,
    body_scores: np.ndarray,
    variant_scores: np.ndarray,
    family_logits: np.ndarray,
    arrays: Mapping[str, np.ndarray],
    positions: np.ndarray,
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    single_day_index = candidate_ids.index("single-day")
    routed = production_route(
        body_scores=body_scores[positions],
        variant_scores=variant_scores[positions],
        family_logits=family_logits[positions],
        single_day_index=single_day_index,
    )
    metrics = dict(
        cohort_metrics(
            routed=routed,
            family_labels=arrays["family_labels"][positions],
            positive_mask=arrays["positive_mask"][positions],
            preferred_mask=arrays["preferred_mask"][positions],
            font_supervision_weights=arrays["font_supervision_weights"][positions],
            single_day_body_negative=arrays["single_day_body_negative"][positions],
            single_day_index=single_day_index,
        )
    )
    metrics["top1_candidate_distribution"] = {
        candidate_ids[int(index)]: count
        for index, count in metrics.pop("top1_distribution_indices").items()
    }
    return metrics


def run(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    output = args.output_dir.expanduser().resolve()
    if output.exists():
        raise ScoreAblationError("output already exists")
    dataset_npz = args.dataset_npz.expanduser().resolve()
    with np.load(dataset_npz, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    val_source_positions = np.flatnonzero(arrays["split"] == 1)
    if len(val_source_positions) != 9033:
        raise ScoreAblationError("expected the sealed r3 body-holdout 9033-row val")
    val_arrays = {
        name: value[val_source_positions]
        if value.ndim and value.shape[0] == len(arrays["split"])
        else value
        for name, value in arrays.items()
    }
    val33 = val33_indices(
        val_arrays["sample_ids"].astype(str), args.val33_finals.expanduser().resolve()
    )
    all_positions = np.arange(len(val_source_positions), dtype=np.int64)
    visual_positions = np.flatnonzero(val_arrays["font_authority"].astype(str) == "visual")
    if len(visual_positions) != 1047:
        raise ScoreAblationError("expected exactly 1047 visual holdout rows")

    import torch

    if args.device == "cuda" and not torch.cuda.is_available():
        raise ScoreAblationError("CUDA requested but unavailable")
    device = torch.device(args.device)
    adapter, adapter_manifest = _load_r3h(
        args.r3h_adapter.expanduser().resolve(),
        torch=torch,
        candidate_count=len(candidate_ids),
        device=device,
    )
    adapter_outputs = _adapter_outputs(
        torch=torch,
        model=adapter,
        query_views=val_arrays["query_views"],
        prototypes=val_arrays["prototype_queries"],
        device=device,
        batch_size=args.batch_size,
    )
    family_logits = adapter_outputs["family_logits"]

    v7_scores, v7_binding = _load_v7_scores(
        val_arrays["query_views"],
        val_arrays["prototype_queries"],
        args.v7_source.expanduser().resolve(),
    )
    v6_scores, v6_binding = _load_v6_r2_scores(
        cache_root=args.hidden_cache.expanduser().resolve(),
        sample_ids=val_arrays["sample_ids"].astype(str).tolist(),
        source_dir=args.v6_r2_source.expanduser().resolve(),
        active_candidate_ids=candidate_ids,
        device_name=args.device,
        batch_size=args.batch_size,
    )

    source_scores: dict[str, tuple[np.ndarray, np.ndarray]] = {
        "r3h": (
            adapter_outputs["body_candidate_scores"],
            adapter_outputs["variant_candidate_scores"],
        ),
        "v7_r5_shared": (v7_scores, v7_scores),
        "v6_r2_shared": (v6_scores, v6_scores),
        "hybrid_v7_body_v6_r2_variant": (v7_scores, v6_scores),
        "hybrid_r3h_body_v6_r2_variant": (
            adapter_outputs["body_candidate_scores"],
            v6_scores,
        ),
    }
    r3h_routed_raw = np.where(
        (_softmax(family_logits).argmax(axis=1) == BODY)[:, None],
        adapter_outputs["body_candidate_scores"],
        adapter_outputs["variant_candidate_scores"],
    )
    for other_name, other_scores in (
        ("v7", v7_scores),
        ("v6_r2", v6_scores),
    ):
        for alpha in BLEND_ALPHAS:
            blended = convex_probability_blend(r3h_routed_raw, other_scores, alpha)
            source_scores[f"blend_r3h_{other_name}_a{alpha:.2f}"] = (
                blended,
                blended,
            )

    metrics: dict[str, Any] = {}
    for name, (body_scores, variant_scores) in source_scores.items():
        metrics[name] = {
            "r3_body_holdout_5works": _evaluate_source(
                body_scores=body_scores,
                variant_scores=variant_scores,
                family_logits=family_logits,
                arrays=val_arrays,
                positions=all_positions,
                candidate_ids=candidate_ids,
            ),
            "r3_visual_holdout_1047_packaging_slice": _evaluate_source(
                body_scores=body_scores,
                variant_scores=variant_scores,
                family_logits=family_logits,
                arrays=val_arrays,
                positions=visual_positions,
                candidate_ids=candidate_ids,
            ),
            "val33_repeated_diagnostic_only": _evaluate_source(
                body_scores=body_scores,
                variant_scores=variant_scores,
                family_logits=family_logits,
                arrays=val_arrays,
                positions=val33,
                candidate_ids=candidate_ids,
            ),
        }

    legacy_report = _json(
        args.legacy_hybrid_diagnostic.expanduser().resolve() / "report.json"
    )
    report: dict[str, Any] = {
        "boundaries": {
            "candidate_scores_only_ablation": True,
            "checkpoint_or_gradient_updates": 0,
            "family_logits_source": "frozen_r3h_pixel_only",
            "family_route": "predicted_pixel_family",
            "human_gold_used_for_fitting_or_selection": False,
            "r3_body_holdout_was_used_by_r3h_checkpoint_selection": True,
            "single_day_policy": {
                "body": "always_mask",
                "family_confidence_threshold": r3h.MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE,
                "raw_logit_margin_threshold": r3h.MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN,
                "typescript_equivalent_mask_gap": 1.0,
            },
            "val33_status": "repeatedly_observed_diagnostic_evaluation_only",
        },
        "candidate_ids": list(candidate_ids),
        "elapsed_seconds": time.perf_counter() - started,
        "legacy_hybrid_audit": {
            "best_global_blend": legacy_report.get("best_global_blend"),
            "not_comparable_reason": (
                "legacy diagnostic used sealed human role routing and val33 alpha "
                "selection; it is provenance-only and is not an ablation candidate"
            ),
        },
        "metrics": metrics,
        "record_type": "manga_font_v2_candidate_score_ensemble_ablation_report",
        "schema_version": SCHEMA,
        "sources": {
            "dataset_npz": {
                "path": str(dataset_npz),
                "sha256": _sha256(dataset_npz),
            },
            "hidden_cache": {
                "path": str(args.hidden_cache.expanduser().resolve()),
                "sample_index_sha256": _sha256(
                    args.hidden_cache.expanduser().resolve() / "sample-index.jsonl"
                ),
            },
            "r3h": {
                "checkpoint_sha256": _sha256(
                    args.r3h_adapter.expanduser().resolve() / r3h.CHECKPOINT_FILE
                ),
                "manifest_record_sha256": adapter_manifest.get("record_sha256"),
            },
            "v6_r2": v6_binding,
            "v7_r5": v7_binding,
            "val33_finals": {
                "path": str(args.val33_finals.expanduser().resolve()),
                "row_count": 33,
                "sha256": _sha256(args.val33_finals.expanduser().resolve()),
            },
        },
    }
    canonical = json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    report["record_sha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    output.mkdir(parents=True)
    np.savez_compressed(
        output / SCORE_ARCHIVE,
        family_logits=family_logits.astype(np.float32),
        sample_ids=val_arrays["sample_ids"],
        v6_r2_scores=v6_scores.astype(np.float32),
        v7_r5_scores=v7_scores.astype(np.float32),
        r3h_body_scores=adapter_outputs["body_candidate_scores"].astype(np.float32),
        r3h_variant_scores=adapter_outputs["variant_candidate_scores"].astype(np.float32),
    )
    (output / REPORT).write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    marker = {
        "artifacts": {
            REPORT: _sha256(output / REPORT),
            SCORE_ARCHIVE: _sha256(output / SCORE_ARCHIVE),
        },
        "owner": SCHEMA,
        "read_only_evaluator": True,
        "safe_replace": True,
        "schema_version": SCHEMA,
    }
    (output / MARKER).write_text(
        json.dumps(marker, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument(
        "--dataset-npz",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout/role-family-dataset.npz"
        ),
    )
    value.add_argument(
        "--r3h-adapter",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v81-role-family-adapter-production-r3h"
        ),
    )
    value.add_argument(
        "--v7-source",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-r5-epoch1-qa-v1"),
    )
    value.add_argument(
        "--v6-r2-source",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-fontquery-r2-first40-v1"),
    )
    value.add_argument(
        "--hidden-cache",
        type=Path,
        default=Path("artifacts/manga-font-master-v3-siglip2-hidden-cache-v1"),
    )
    value.add_argument(
        "--val33-finals",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-calibration-gold-val33-v1/finals-calibration-val.jsonl"
        ),
    )
    value.add_argument(
        "--legacy-hybrid-diagnostic",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-hybrid-diagnostic-v2"),
    )
    value.add_argument("--output-dir", type=Path, required=True)
    value.add_argument("--batch-size", type=int, default=128)
    value.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    return value


def main() -> None:
    args = parser().parse_args()
    try:
        report = run(args)
    except (OSError, ValueError, RuntimeError) as error:
        raise SystemExit(f"candidate-score ablation failed: {error}") from error
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
