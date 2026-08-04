#!/usr/bin/env python3
"""Seal row-independent v3/v6 hybrid diagnostics on the unchanged val33.

The oracle role route is a diagnostic upper bound because it uses the sealed
human semantic role.  The deployable-policy simulation instead routes on the
v3 pixel role head.  Global probability blends use a fixed coefficient shared
by every row; no sample identity or correctness-dependent rule is permitted.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import sweep_manga_font_student_v3_heads as v3_sweep
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v2 as v2
    from scripts import train_manga_font_student_v3 as v3
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_fontquery_r2 as v6_r2
except ImportError:  # pragma: no cover
    import sweep_manga_font_student_v3_heads as v3_sweep
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v2 as v2
    import train_manga_font_student_v3 as v3
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_fontquery_r2 as v6_r2


SCHEMA = "manga-font-student-v6-hybrid-diagnostic-v2"
OWNER = "carrot-manga-translator/manga-font-student-v6-hybrid-diagnostic-v2"
MARKER = ".manga-font-student-v6-hybrid-diagnostic-v2-owned.json"
REPORT = "report.json"
POLICY = "hybrid-policy.json"
PREDICTIONS = "hybrid-predictions-val.jsonl"
FILES = frozenset({MARKER, REPORT, POLICY, PREDICTIONS})
ALPHAS = (0.0, 0.25, 0.50, 0.75, 1.0)
ROLE_THRESHOLDS = (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90)


class MangaFontV6HybridError(v6.MangaFontV6FontQueryError):
    """Raised when hybrid evidence or its boundaries drift."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV6HybridError(f"{location}: expected object")
    return value


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV6HybridError(f"missing hybrid file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _load_v3_ranker(
    *, torch: Any, cache_dir: Path, sweep_dir: Path, warm_start_dir: Path
) -> tuple[Any, dict[str, Any], dict[str, np.ndarray]]:
    cache_root = cache_dir.expanduser().resolve()
    sweep_root = sweep_dir.expanduser().resolve()
    warm_root = warm_start_dir.expanduser().resolve()
    # These artifacts predate later sweep-source hardening.  Validate their
    # immutable marker/hash chain rather than demanding that the historical
    # source hash equal today's implementation.
    cache_marker = base.read_json(
        cache_root / v3_sweep.CACHE_MARKER, location="historical v3 cache marker"
    )
    cache = dict(
        base.read_json(
            cache_root / v3_sweep.CACHE_CONTRACT,
            location="historical v3 cache contract",
        )
    )
    base.validate_record_seal(cache, location="historical v3 cache contract")
    if (
        cache_marker.get("owner") != v3_sweep.CACHE_OWNER
        or cache_marker.get("schema_version") != v3_sweep.CACHE_SCHEMA
        or cache_marker.get("safe_replace") is not True
        or cache_marker.get("artifacts")
        != {
            v3_sweep.CACHE_ARRAYS: base.sha256_file(cache_root / v3_sweep.CACHE_ARRAYS),
            v3_sweep.CACHE_CONTRACT: base.sha256_file(
                cache_root / v3_sweep.CACHE_CONTRACT
            ),
        }
    ):
        raise MangaFontV6HybridError("historical v3 cache hash chain drifted")
    boundaries = _mapping(cache.get("boundaries"), "historical v3 cache boundaries")
    if (
        boundaries.get("human_test_labels_deserialized") != 0
        or boundaries.get("human_test_pixels_opened") != 0
        or boundaries.get("synthetic_test_pixels_opened") != 0
        or boundaries.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV6HybridError("historical v3 cache leakage boundary drifted")
    expected_arrays = _mapping(
        _mapping(cache.get("arrays"), "historical v3 arrays").get("contract"),
        "historical v3 array contract",
    )
    with np.load(cache_root / v3_sweep.CACHE_ARRAYS, allow_pickle=False) as source:
        if set(source.files) != set(expected_arrays):
            raise MangaFontV6HybridError("historical v3 array inventory drifted")
        arrays: dict[str, np.ndarray] = {}
        for name in source.files:
            value = np.array(source[name], copy=True)
            descriptor = _mapping(expected_arrays[name], f"historical v3 array {name}")
            if (
                list(value.shape) != descriptor.get("shape")
                or str(value.dtype) != descriptor.get("dtype")
                or (value.dtype.kind == "f" and not np.isfinite(value).all())
            ):
                raise MangaFontV6HybridError(f"historical v3 array drifted: {name}")
            arrays[name] = value

    report = base.read_json(
        sweep_root / v3_sweep.SWEEP_REPORT,
        location="v3 strongest sweep",
    )
    base.validate_record_seal(report, location="v3 strongest sweep")
    sweep_marker = base.read_json(
        sweep_root / v3_sweep.SWEEP_MARKER, location="v3 strongest sweep marker"
    )
    if (
        sweep_marker.get("owner") != v3_sweep.SWEEP_OWNER
        or sweep_marker.get("schema_version") != v3_sweep.SWEEP_SCHEMA
        or sweep_marker.get("safe_replace") is not True
        or sweep_marker.get("artifacts")
        != {
            v3_sweep.SWEEP_CHECKPOINT: base.sha256_file(
                sweep_root / v3_sweep.SWEEP_CHECKPOINT
            ),
            v3_sweep.SWEEP_REPORT: base.sha256_file(sweep_root / v3_sweep.SWEEP_REPORT),
        }
        or report.get("cache_contract_sha256")
        != base.sha256_file(cache_root / v3_sweep.CACHE_CONTRACT)
        or report.get("warm_start_checkpoint_sha256")
        != base.sha256_file(warm_root / base.CHECKPOINT_FILE)
        or report.get("warm_start_contract_sha256")
        != base.sha256_file(warm_root / base.CONTRACT_FILE)
    ):
        raise MangaFontV6HybridError("historical v3 sweep hash chain drifted")
    sweep_boundaries = _mapping(report.get("boundaries"), "v3 sweep boundaries")
    if (
        sweep_boundaries.get("hidden_test_labels_deserialized") != 0
        or sweep_boundaries.get("hidden_test_pixels_opened") != 0
        or sweep_boundaries.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV6HybridError("historical v3 sweep leakage boundary drifted")
    best_trial = int(report["global_best_trial"])
    config = _mapping(report["trials"][best_trial - 1]["config"], "v3 config")
    ranker = v3.build_runtime_ranker_v3(
        torch,
        candidate_count=len(cache["candidate_ids"]),
        dropout=0.10,
        residual_scale=float(config["residual_scale"]),
    ).to("cuda")
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV6HybridError("safetensors is required") from error
    state = dict(
        load_file(
            str(sweep_root / v3_sweep.SWEEP_CHECKPOINT),
            device="cpu",
        )
    )
    if any(not name.startswith("runtime_ranker.") for name in state):
        raise MangaFontV6HybridError("v3 head prefix drifted")
    ranker.load_state_dict(
        {name.removeprefix("runtime_ranker."): value for name, value in state.items()},
        strict=True,
    )
    return ranker.eval(), cache, arrays


def _v3_probabilities(
    *,
    torch: Any,
    ranker: Any,
    cache: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
) -> tuple[Any, Any, Any]:
    bags = v3_sweep._candidate_bags(torch, cache["prototype_bags"])  # noqa: SLF001
    with torch.inference_mode():
        outputs = ranker(
            torch.from_numpy(arrays["human_val_embeddings"]).to("cuda"),
            torch.from_numpy(arrays["prototype_features"]).to("cuda"),
            bags,
        )
        masks = torch.from_numpy(arrays["human_val_masks"]).to("cuda").bool()
        probabilities = torch.softmax(
            outputs["candidate_scores"].float().masked_fill(~masks, -torch.inf),
            dim=-1,
        )
        role_logits = outputs["role_logits"].float()
        role_predictions = role_logits.argmax(dim=-1)
    return probabilities, role_predictions, role_logits


def _load_v6_probabilities(
    output_dir: Path, candidate_ids: tuple[str, ...], torch: Any
) -> tuple[Any, tuple[str, ...]]:
    v6_r2.validate_output(output_dir)
    rows: list[Mapping[str, Any]] = []
    with (output_dir.expanduser().resolve() / v6_r2.PREDICTIONS).open(
        encoding="utf-8"
    ) as handle:
        for line in handle:
            if line.strip():
                row = _mapping(json.loads(line), "v6 r2 prediction")
                base.validate_record_seal(row, location="v6 r2 prediction")
                rows.append(row)
    if len(rows) != 33 or [int(row["row_index"]) for row in rows] != list(range(33)):
        raise MangaFontV6HybridError("v6 r2 prediction order drifted")
    index = {candidate_id: offset for offset, candidate_id in enumerate(candidate_ids)}
    values = np.zeros((33, len(candidate_ids)), dtype="<f4")
    roles: list[str] = []
    for row_index, row in enumerate(rows):
        roles.append(str(row["role"]))
        ranked = row.get("ranked_candidates")
        if not isinstance(ranked, list) or len(ranked) != len(candidate_ids):
            raise MangaFontV6HybridError("v6 r2 candidate inventory drifted")
        for item in ranked:
            entry = _mapping(item, "v6 r2 ranked candidate")
            candidate_id = str(entry["candidate_id"])
            if candidate_id not in index:
                raise MangaFontV6HybridError("v6 r2 candidate escaped vocabulary")
            values[row_index, index[candidate_id]] = float(entry["probability"])
    if not np.allclose(values.sum(axis=1), 1.0, atol=1e-5):
        raise MangaFontV6HybridError("v6 r2 probabilities are not normalized")
    return torch.from_numpy(values).to("cuda"), tuple(roles)


def metrics_from_probabilities(
    *,
    torch: Any,
    probabilities: Any,
    targets: Any,
    masks: Any,
    roles: Any,
    candidate_ids: tuple[str, ...],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    logits = probabilities.float().clamp(min=1e-12).log()
    return v6.compute_val_metrics(
        torch=torch,
        logits=logits,
        targets=targets,
        masks=masks,
        roles=roles,
        candidate_ids=candidate_ids,
    )


def combine_role_route(
    *, torch: Any, ordinary_mask: Any, v3_probabilities: Any, v6_probabilities: Any
) -> Any:
    if ordinary_mask.shape != (v3_probabilities.shape[0],):
        raise MangaFontV6HybridError("ordinary route mask drifted")
    return torch.where(ordinary_mask[:, None], v3_probabilities, v6_probabilities)


def combine_global_scores(
    *, torch: Any, v3_probabilities: Any, v6_probabilities: Any, alpha: float, mode: str
) -> Any:
    if alpha not in ALPHAS:
        raise MangaFontV6HybridError("hybrid alpha escaped fixed grid")
    if mode == "arithmetic_probability":
        result = (1.0 - alpha) * v3_probabilities + alpha * v6_probabilities
    elif mode == "geometric_probability":
        logits = (1.0 - alpha) * v3_probabilities.clamp(min=1e-12).log()
        logits = logits + alpha * v6_probabilities.clamp(min=1e-12).log()
        result = torch.softmax(logits, dim=-1)
    else:
        raise MangaFontV6HybridError("unknown global blend mode")
    return result / result.sum(dim=-1, keepdim=True)


def _route_prediction_rows(
    *,
    base_rows: Sequence[Mapping[str, Any]],
    route_names: Sequence[str],
    route_role_sources: Sequence[str],
) -> list[dict[str, Any]]:
    if len(base_rows) != len(route_names) or len(base_rows) != len(route_role_sources):
        raise MangaFontV6HybridError("hybrid route prediction count drifted")
    output = []
    for row, route, role_source in zip(
        base_rows, route_names, route_role_sources, strict=True
    ):
        core = {
            key: copy.deepcopy(value)
            for key, value in row.items()
            if key != "record_sha256"
        }
        core.update(
            {
                "model_route": route,
                "record_type": "manga_font_student_v6_hybrid_prediction",
                "role_source": role_source,
                "schema_version": SCHEMA,
            }
        )
        output.append(base.seal_record(core))
    return output


def analyze(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontV6HybridError("hybrid output already exists")
    torch, _processor, _vision, _save = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available():
        raise MangaFontV6HybridError("hybrid analysis requires CUDA")
    ranker, cache, arrays = _load_v3_ranker(
        torch=torch,
        cache_dir=args.v3_cache_dir,
        sweep_dir=args.v3_sweep_dir,
        warm_start_dir=args.v3_warm_start_dir,
    )
    candidate_ids = tuple(str(value) for value in cache["candidate_ids"])
    v3_probabilities, predicted_roles, role_logits = _v3_probabilities(
        torch=torch, ranker=ranker, cache=cache, arrays=arrays
    )
    v6_probabilities, v6_roles = _load_v6_probabilities(
        args.v6_r2_output_dir, candidate_ids, torch
    )
    targets = torch.from_numpy(arrays["human_val_targets"]).to("cuda").float()
    masks = torch.from_numpy(arrays["human_val_masks"]).to("cuda").bool()
    gold_roles = torch.from_numpy(arrays["human_val_role"]).to("cuda").long()
    expected_roles = tuple(
        base.ROLE_VALUES[int(value)] for value in gold_roles.tolist()
    )
    if v6_roles != expected_roles:
        raise MangaFontV6HybridError("v3/v6 val role alignment drifted")

    v3_metrics, _ = metrics_from_probabilities(
        torch=torch,
        probabilities=v3_probabilities,
        targets=targets,
        masks=masks,
        roles=gold_roles,
        candidate_ids=candidate_ids,
    )
    v6_metrics, _ = metrics_from_probabilities(
        torch=torch,
        probabilities=v6_probabilities,
        targets=targets,
        masks=masks,
        roles=gold_roles,
        candidate_ids=candidate_ids,
    )
    ordinary_indices = {base.ROLE_VALUES.index(role) for role in v2.ORDINARY_ROLES}
    gold_ordinary = torch.tensor(
        [int(value) in ordinary_indices for value in gold_roles.tolist()],
        dtype=torch.bool,
        device="cuda",
    )
    predicted_ordinary = torch.tensor(
        [int(value) in ordinary_indices for value in predicted_roles.tolist()],
        dtype=torch.bool,
        device="cuda",
    )
    oracle_probabilities = combine_role_route(
        torch=torch,
        ordinary_mask=gold_ordinary,
        v3_probabilities=v3_probabilities,
        v6_probabilities=v6_probabilities,
    )
    oracle_metrics, oracle_rows = metrics_from_probabilities(
        torch=torch,
        probabilities=oracle_probabilities,
        targets=targets,
        masks=masks,
        roles=gold_roles,
        candidate_ids=candidate_ids,
    )
    if (
        round(float(oracle_metrics["preferred_at1"]) * 33) != 17
        or round(float(oracle_metrics["acceptable_at1"]) * 33) != 26
    ):
        raise MangaFontV6HybridError("gold role hybrid arithmetic drifted")
    predicted_probabilities = combine_role_route(
        torch=torch,
        ordinary_mask=predicted_ordinary,
        v3_probabilities=v3_probabilities,
        v6_probabilities=v6_probabilities,
    )
    predicted_metrics, predicted_rows = metrics_from_probabilities(
        torch=torch,
        probabilities=predicted_probabilities,
        targets=targets,
        masks=masks,
        roles=gold_roles,
        candidate_ids=candidate_ids,
    )

    role_probabilities = torch.softmax(role_logits, dim=-1)
    ordinary_posterior = role_probabilities[:, sorted(ordinary_indices)].sum(dim=-1)
    role_thresholds: list[dict[str, Any]] = []
    best_role_threshold: dict[str, Any] | None = None
    best_threshold_mask: Any | None = None
    best_threshold_rows: list[dict[str, Any]] | None = None
    for threshold in ROLE_THRESHOLDS:
        threshold_mask = ordinary_posterior >= threshold
        threshold_probabilities = combine_role_route(
            torch=torch,
            ordinary_mask=threshold_mask,
            v3_probabilities=v3_probabilities,
            v6_probabilities=v6_probabilities,
        )
        threshold_metrics, threshold_rows = metrics_from_probabilities(
            torch=torch,
            probabilities=threshold_probabilities,
            targets=targets,
            masks=masks,
            roles=gold_roles,
            candidate_ids=candidate_ids,
        )
        threshold_record = {
            "metrics": threshold_metrics,
            "ordinary_route_count": int(threshold_mask.sum().item()),
            "threshold": threshold,
        }
        role_thresholds.append(threshold_record)
        if best_role_threshold is None or v6._metric_key(  # noqa: SLF001
            threshold_metrics
        ) > v6._metric_key(best_role_threshold["metrics"]):  # noqa: SLF001
            best_role_threshold = threshold_record
            best_threshold_mask = threshold_mask.clone()
            best_threshold_rows = threshold_rows
    if (
        best_role_threshold is None
        or best_threshold_mask is None
        or best_threshold_rows is None
    ):
        raise MangaFontV6HybridError("role threshold sweep is empty")

    blends: list[dict[str, Any]] = []
    best_blend: dict[str, Any] | None = None
    for mode in ("arithmetic_probability", "geometric_probability"):
        for alpha in ALPHAS:
            probabilities = combine_global_scores(
                torch=torch,
                v3_probabilities=v3_probabilities,
                v6_probabilities=v6_probabilities,
                alpha=alpha,
                mode=mode,
            )
            metrics, _rows = metrics_from_probabilities(
                torch=torch,
                probabilities=probabilities,
                targets=targets,
                masks=masks,
                roles=gold_roles,
                candidate_ids=candidate_ids,
            )
            record = {"alpha_v6": alpha, "metrics": metrics, "mode": mode}
            blends.append(record)
            if best_blend is None or v6._metric_key(metrics) > v6._metric_key(  # noqa: SLF001
                best_blend["metrics"]
            ):
                best_blend = record
    if best_blend is None:
        raise MangaFontV6HybridError("global blend sweep is empty")

    predicted_role_names = tuple(
        base.ROLE_VALUES[int(value)] for value in predicted_roles.tolist()
    )
    oracle_predictions = _route_prediction_rows(
        base_rows=oracle_rows,
        route_names=tuple(
            "v3" if value else "v6_r2" for value in gold_ordinary.tolist()
        ),
        route_role_sources=("sealed_human_role_oracle",) * 33,
    )
    generic_predictions = _route_prediction_rows(
        base_rows=predicted_rows,
        route_names=tuple(
            "v3" if value else "v6_r2" for value in predicted_ordinary.tolist()
        ),
        route_role_sources=("v3_pixel_role_head",) * 33,
    )
    threshold_predictions = _route_prediction_rows(
        base_rows=best_threshold_rows,
        route_names=tuple(
            "v3" if value else "v6_r2" for value in best_threshold_mask.tolist()
        ),
        route_role_sources=(
            f"v3_pixel_ordinary_posterior_gte_{best_role_threshold['threshold']}",
        )
        * 33,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        with (staging / PREDICTIONS).open("wb") as handle:
            for row in (
                *oracle_predictions,
                *generic_predictions,
                *threshold_predictions,
            ):
                handle.write(base.json_bytes(row))
        policy = base.seal_record(
            {
                "body_roles": sorted(v2.ORDINARY_ROLES),
                "fallback_for_unknown_role": "global_blend",
                "global_blend": {
                    "alpha_v6": best_blend["alpha_v6"],
                    "mode": best_blend["mode"],
                },
                "inputs": {
                    "body_model": "strongest_v3_head",
                    "variant_model": "v6_fontquery_r2_first40",
                },
                "record_type": "manga_font_student_v6_hybrid_policy",
                "role_route": {
                    "body_roles": "v3",
                    "all_other_known_roles": "v6_r2",
                    "pixel_role_head_ordinary_posterior_threshold": best_role_threshold[
                        "threshold"
                    ],
                    "source": "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
                },
                "row_specific_rules": False,
                "runtime_packaging": {
                    "candidate_order_shared": True,
                    "option_a_single_extended_embedding": {
                        "exact": False,
                        "encoder_output_per_view": "legacy256_plus_v6_candidate_logits22_equals278",
                        "rejection_reasons": [
                            "v3_uses_v2_finetuned_encoder_but_v6_uses_pinned_base_encoder",
                            "v6_normalizes_three_view_mean_query_embeddings_before_cosine_so_view_logit_mean_is_not_exact",
                        ],
                        "status": "rejected_non_exact",
                    },
                    "required_exact_dual_encoder_1280d_dual_scores": {
                        "exact": True,
                        "logical_per_view_feature_width": 1280,
                        "outputs": [
                            "v3_body_candidate_scores22",
                            "v6_variant_candidate_scores22",
                        ],
                        "segments": {
                            "v3_v2_finetuned_encoder_embedding": 256,
                            "v6_base_encoder_four_query_embeddings": 1024,
                        },
                        "selection": "typescript_resolved_combined_item_pixel_role",
                        "three_view_v6_aggregation": "mean_four_query_embeddings_then_querywise_l2_renormalize_then_22x4x256_prototype_cosine",
                        "typescript_role_selection_required": True,
                        "v3_and_v6_encoder_weights_are_distinct": True,
                    },
                    "required_path": "required_exact_dual_encoder_1280d_dual_scores",
                    "v3_io": "existing_three_view_embedding_and_ranker_contract",
                    "v6_io": "three_views_to_four_query_embeddings_then_candidate_scores_with_constant_22x4x256_prototypes",
                },
                "schema_version": SCHEMA,
                "status": "research_policy_not_deployable_until_runtime_role_qa",
            }
        )
        (staging / POLICY).write_bytes(base.json_bytes(policy, pretty=True))
        role_binary_correct = int((gold_ordinary == predicted_ordinary).sum().item())
        report = base.seal_record(
            {
                "best_global_blend": copy.deepcopy(best_blend),
                "boundaries": {
                    "fresh64_labels_deserialized": 0,
                    "fresh64_pixels_opened": 0,
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "library_qa_labels_deserialized": 0,
                    "library_qa_pixels_opened": 0,
                    "row_specific_rule_count": 0,
                    "test30_used": False,
                    "val33_used_for_global_alpha_selection": True,
                },
                "candidate_ids": list(candidate_ids),
                "global_blends": blends,
                "gold_role_oracle": {
                    "deployable_claim": False,
                    "metrics": oracle_metrics,
                    "ordinary_rows": int(gold_ordinary.sum().item()),
                    "role_source": "sealed_human_role",
                    "variant_rows": int((~gold_ordinary).sum().item()),
                },
                "models": {
                    "strongest_v3": v3_metrics,
                    "v6_r2_first40": v6_metrics,
                },
                "item_ocr_combined_role_route": {
                    "app_function": "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
                    "deployable_policy_shape": True,
                    "evaluation_status": "not_measurable_on_val33_missing_item_ocr_role_bindings",
                    "metrics": None,
                    "required_next_evidence": "production_pipeline_qa_role_trace_before_runtime_approval",
                    "role_source": "translated_item_fontRole_plus_pixel_role",
                },
                "predicted_role_route": {
                    "deployable_policy_shape": True,
                    "metrics": predicted_metrics,
                    "ordinary_variant_binary_accuracy": role_binary_correct / 33,
                    "ordinary_variant_binary_correct": role_binary_correct,
                    "predicted_roles": list(predicted_role_names),
                    "role_source": "v3_pixel_role_head",
                },
                "predicted_role_threshold_route": {
                    "best": copy.deepcopy(best_role_threshold),
                    "row_specific_rules": False,
                    "selection_uses_val33": True,
                    "sweep": role_thresholds,
                },
                "record_type": "manga_font_student_v6_hybrid_diagnostic",
                "schema_version": SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "sources": {
                    "v3_cache_contract_sha256": base.sha256_file(
                        args.v3_cache_dir.expanduser().resolve()
                        / v3_sweep.CACHE_CONTRACT
                    ),
                    "v3_sweep_report_sha256": base.sha256_file(
                        args.v3_sweep_dir.expanduser().resolve() / v3_sweep.SWEEP_REPORT
                    ),
                    "v6_r2_report_sha256": base.sha256_file(
                        args.v6_r2_output_dir.expanduser().resolve() / v6_r2.REPORT
                    ),
                },
            }
        )
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (POLICY, PREDICTIONS, REPORT)
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging)
        os.rename(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    v6._assert_inventory(root, FILES, "v6 hybrid")  # noqa: SLF001
    marker = base.read_json(root / MARKER, location="hybrid marker")
    report = base.read_json(root / REPORT, location="hybrid report")
    policy = base.read_json(root / POLICY, location="hybrid policy")
    base.validate_record_seal(report, location="hybrid report")
    base.validate_record_seal(policy, location="hybrid policy")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or policy.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV6HybridError("hybrid metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "hybrid artifacts")
    for name in FILES - {MARKER}:
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV6HybridError(f"hybrid hash drifted: {name}")
    boundaries = _mapping(report.get("boundaries"), "hybrid boundaries")
    required_zero = (
        "fresh64_labels_deserialized",
        "fresh64_pixels_opened",
        "human_test_labels_deserialized",
        "human_test_pixels_opened",
        "library_qa_labels_deserialized",
        "library_qa_pixels_opened",
        "row_specific_rule_count",
    )
    if (
        any(int(boundaries.get(name, -1)) != 0 for name in required_zero)
        or boundaries.get("test30_used") is not False
        or policy.get("row_specific_rules") is not False
    ):
        raise MangaFontV6HybridError("hybrid leakage/rule boundary drifted")
    oracle = _mapping(report.get("gold_role_oracle"), "hybrid oracle")
    oracle_metrics = _mapping(oracle.get("metrics"), "hybrid oracle metrics")
    if (
        round(float(oracle_metrics.get("preferred_at1", math.nan)) * 33) != 17
        or round(float(oracle_metrics.get("acceptable_at1", math.nan)) * 33) != 26
        or oracle.get("deployable_claim") is not False
    ):
        raise MangaFontV6HybridError("hybrid oracle evidence drifted")
    prediction_count = sum(
        bool(line.strip())
        for line in (root / PREDICTIONS).read_text(encoding="utf-8").splitlines()
    )
    if prediction_count != 99:
        raise MangaFontV6HybridError("hybrid prediction count drifted")
    packaging = _mapping(policy.get("runtime_packaging"), "runtime packaging")
    rejected = _mapping(
        packaging.get("option_a_single_extended_embedding"), "rejected 278d option"
    )
    required = _mapping(
        packaging.get("required_exact_dual_encoder_1280d_dual_scores"),
        "required exact option",
    )
    if (
        rejected.get("exact") is not False
        or rejected.get("status") != "rejected_non_exact"
        or required.get("exact") is not True
        or int(required.get("logical_per_view_feature_width", 0)) != 1280
        or required.get("v3_and_v6_encoder_weights_are_distinct") is not True
        or packaging.get("required_path")
        != "required_exact_dual_encoder_1280d_dual_scores"
    ):
        raise MangaFontV6HybridError("hybrid exact packaging contract drifted")
    predicted = _mapping(report.get("predicted_role_route"), "predicted route")
    predicted_metrics = _mapping(predicted.get("metrics"), "predicted route metrics")
    threshold_route = _mapping(
        report.get("predicted_role_threshold_route"), "threshold route"
    )
    best_threshold = _mapping(threshold_route.get("best"), "best threshold")
    threshold_metrics = _mapping(best_threshold.get("metrics"), "threshold metrics")
    threshold_sweep = threshold_route.get("sweep")
    if (
        threshold_route.get("row_specific_rules") is not False
        or threshold_route.get("selection_uses_val33") is not True
        or not isinstance(threshold_sweep, list)
        or [float(row.get("threshold", math.nan)) for row in threshold_sweep]
        != list(ROLE_THRESHOLDS)
        or float(best_threshold.get("threshold", math.nan)) != 0.40
        or round(float(threshold_metrics.get("preferred_at1", math.nan)) * 33) != 15
        or round(float(threshold_metrics.get("acceptable_at1", math.nan)) * 33) != 24
    ):
        raise MangaFontV6HybridError("hybrid threshold diagnostic drifted")
    blend = _mapping(report.get("best_global_blend"), "best blend")
    blend_metrics = _mapping(blend.get("metrics"), "best blend metrics")
    return {
        "best_blend_preferred_at1": blend_metrics.get("preferred_at1"),
        "gold_role_oracle_acceptable_at1": oracle_metrics.get("acceptable_at1"),
        "gold_role_oracle_preferred_at1": oracle_metrics.get("preferred_at1"),
        "output_dir": str(root),
        "predicted_role_acceptable_at1": predicted_metrics.get("acceptable_at1"),
        "predicted_role_preferred_at1": predicted_metrics.get("preferred_at1"),
        "threshold_role_acceptable_at1": threshold_metrics.get("acceptable_at1"),
        "threshold_role_preferred_at1": threshold_metrics.get("preferred_at1"),
        "report_sha256": base.sha256_file(root / REPORT),
        "status": "sealed_hybrid_diagnostic_not_deployable",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    analyze_parser = commands.add_parser("analyze")
    analyze_parser.add_argument("--v3-cache-dir", type=Path, required=True)
    analyze_parser.add_argument("--v3-sweep-dir", type=Path, required=True)
    analyze_parser.add_argument("--v3-warm-start-dir", type=Path, required=True)
    analyze_parser.add_argument("--v6-r2-output-dir", type=Path, required=True)
    analyze_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = (
            analyze(args)
            if args.command == "analyze"
            else validate_output(args.output_dir)
        )
    except (base.MangaFontStudentError, OSError) as error:
        raise SystemExit(f"manga-font-v6-hybrid error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
