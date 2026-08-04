#!/usr/bin/env python3
"""Compare the v1 student's deployable ranker and direct head on human val.

The human export is opened through the trainer's split-isolated validator.  That
validator recognizes ``test`` with a byte-level top-level-field scanner and
does not deserialize the row.  This diagnostic then resolves pixels only for
the returned validation examples.  Human test labels and pixels are therefore
outside this process's evaluation boundary.
"""

from __future__ import annotations

import argparse
import math
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import build_manga_font_student_human_overlay_v1 as human_overlay
    from scripts import label_manga_font_student_pass as student_pass
    from scripts import train_manga_font_student_v1 as trainer
    from scripts import train_manga_font_student_v2 as trainer_v2
    from scripts.font_matching_catalog_assets import CatalogAssetResolver
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_student_human_overlay_v1 as human_overlay
    import label_manga_font_student_pass as student_pass
    import train_manga_font_student_v1 as trainer
    import train_manga_font_student_v2 as trainer_v2
    from font_matching_catalog_assets import CatalogAssetResolver


SCHEMA_VERSION = "manga-font-student-diagnosis-v1"
RECORD_TYPE = "manga_font_student_validation_diagnosis"
ORDINARY_ROLES = frozenset({"dialogue", "narration", "thought"})
FUSION_RUNTIME_WEIGHTS = (0.25, 0.5, 0.75)
DIRECT_FIXED_VIEW_WEIGHTS = {
    "raw_224": (1.0, 0.0, 0.0),
    "context_224": (0.0, 1.0, 0.0),
    "glyph_224": (0.0, 0.0, 1.0),
    "raw_context_equal": (0.5, 0.5, 0.0),
    "raw_glyph_equal": (0.5, 0.0, 0.5),
    "context_glyph_equal": (0.0, 0.5, 0.5),
    "raw_heavy": (0.5, 0.25, 0.25),
    "context_heavy": (0.25, 0.5, 0.25),
    "glyph_heavy": (0.25, 0.25, 0.5),
}


class StudentDiagnosisError(ValueError):
    """Raised when a diagnosis input or metric is unsafe or inconsistent."""


@dataclass(frozen=True)
class ValidationScores:
    example: trainer.HumanExample
    runtime_scores: np.ndarray
    direct_scores: np.ndarray
    direct_view_scores: np.ndarray | None = None
    view_gate_weights: np.ndarray | None = None


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise StudentDiagnosisError(f"{location}: expected object")
    return value


def stable_eligible_order(
    scores: np.ndarray, eligible_indices: Sequence[int], *, candidate_count: int
) -> tuple[int, ...]:
    values = np.asarray(scores, dtype=np.float64)
    eligible = tuple(int(value) for value in eligible_indices)
    if (
        values.shape != (candidate_count,)
        or not np.isfinite(values).all()
        or not eligible
        or len(eligible) != len(set(eligible))
        or any(value < 0 or value >= candidate_count for value in eligible)
    ):
        raise StudentDiagnosisError("candidate score/order contract drifted")
    return tuple(sorted(eligible, key=lambda index: (-float(values[index]), index)))


def zscore_scores(scores: np.ndarray) -> np.ndarray:
    values = np.asarray(scores, dtype=np.float64)
    standard_deviation = float(values.std())
    if not math.isfinite(standard_deviation) or standard_deviation < 1e-12:
        return np.zeros_like(values)
    return (values - float(values.mean())) / standard_deviation


def reweight_direct_rows(
    rows: Sequence[ValidationScores],
    *,
    fixed_weights: Sequence[float] | None = None,
    use_runtime_view_gate: bool = False,
) -> tuple[ValidationScores, ...]:
    if (fixed_weights is None) == (not use_runtime_view_gate):
        raise StudentDiagnosisError(
            "direct-view reweighting requires exactly one weight authority"
        )
    normalized_fixed: np.ndarray | None = None
    if fixed_weights is not None:
        normalized_fixed = np.asarray(fixed_weights, dtype=np.float64)
        if (
            normalized_fixed.shape != (len(student_pass.VIEW_NAMES),)
            or not np.isfinite(normalized_fixed).all()
            or (normalized_fixed < 0.0).any()
            or not math.isclose(float(normalized_fixed.sum()), 1.0, abs_tol=1e-9)
        ):
            raise StudentDiagnosisError("fixed direct-view weights are invalid")
    output: list[ValidationScores] = []
    for row in rows:
        direct_views = np.asarray(row.direct_view_scores, dtype=np.float64)
        expected = (len(student_pass.VIEW_NAMES), row.direct_scores.shape[0])
        if direct_views.shape != expected or not np.isfinite(direct_views).all():
            raise StudentDiagnosisError("direct per-view score contract drifted")
        weights = normalized_fixed
        if use_runtime_view_gate:
            weights = np.asarray(row.view_gate_weights, dtype=np.float64)
            if (
                weights.shape != (len(student_pass.VIEW_NAMES),)
                or not np.isfinite(weights).all()
                or (weights < 0.0).any()
                or not math.isclose(float(weights.sum()), 1.0, abs_tol=1e-4)
            ):
                raise StudentDiagnosisError("runtime view-gate weights drifted")
        assert weights is not None
        direct = np.sum(direct_views * weights[:, None], axis=0).astype(np.float32)
        output.append(
            ValidationScores(
                example=row.example,
                runtime_scores=row.runtime_scores,
                direct_scores=direct,
                direct_view_scores=row.direct_view_scores,
                view_gate_weights=row.view_gate_weights,
            )
        )
    return tuple(output)


def _tier_indices(
    example: trainer.HumanExample, candidate_ids: Sequence[str]
) -> tuple[frozenset[int], frozenset[int]]:
    candidate_index = {value: index for index, value in enumerate(candidate_ids)}
    judgment = _require_mapping(
        example.row.get("font_judgment"), f"{example.sample_id}.font_judgment"
    )
    try:
        preferred = frozenset(
            candidate_index[str(value)] for value in judgment["preferred"]
        )
        acceptable_only = frozenset(
            candidate_index[str(value)] for value in judgment["acceptable"]
        )
    except (KeyError, TypeError) as error:
        raise StudentDiagnosisError(
            f"{example.sample_id}: preferred/acceptable tier drifted"
        ) from error
    combined = preferred | acceptable_only
    if combined != frozenset(example.positive_indices) or not preferred:
        raise StudentDiagnosisError(
            f"{example.sample_id}: trainer positives lost tier identity"
        )
    return preferred, combined


def _softmax_eligible(scores: np.ndarray, order: Sequence[int]) -> np.ndarray:
    eligible = np.asarray([scores[index] for index in order], dtype=np.float64)
    eligible -= float(eligible.max())
    exponent = np.exp(eligible)
    return exponent / float(exponent.sum())


def summarize_method(
    rows: Sequence[ValidationScores],
    *,
    candidate_ids: Sequence[str],
    score_source: str,
    fusion_runtime_weight: float | None = None,
) -> dict[str, Any]:
    if not rows:
        raise StudentDiagnosisError("human validation is empty")
    if score_source not in {"runtime", "direct", "fusion"}:
        raise StudentDiagnosisError(f"unknown score source: {score_source}")
    if score_source == "fusion" and (
        fusion_runtime_weight is None or not 0.0 <= fusion_runtime_weight <= 1.0
    ):
        raise StudentDiagnosisError("fusion requires a bounded runtime weight")

    counters: Counter[str] = Counter()
    role_buckets: dict[str, list[tuple[bool, bool, bool, bool]]] = defaultdict(list)
    group_buckets: dict[str, list[tuple[bool, bool, bool, bool]]] = defaultdict(list)
    acceptable_at1 = 0
    preferred_at1 = 0
    acceptable_hit_at3 = 0
    preferred_hit_at3 = 0
    acceptable_set_recall_at3 = 0.0
    preferred_set_recall_at3 = 0.0
    acceptable_mrr = 0.0
    preferred_mrr = 0.0
    margins: list[float] = []
    normalized_entropies: list[float] = []
    top1_by_sample: dict[str, str] = {}

    for row in rows:
        if score_source == "runtime":
            scores = row.runtime_scores
        elif score_source == "direct":
            scores = row.direct_scores
        else:
            assert fusion_runtime_weight is not None
            scores = fusion_runtime_weight * zscore_scores(row.runtime_scores) + (
                1.0 - fusion_runtime_weight
            ) * zscore_scores(row.direct_scores)
        order = stable_eligible_order(
            scores,
            row.example.eligible_indices,
            candidate_count=len(candidate_ids),
        )
        preferred, acceptable = _tier_indices(row.example, candidate_ids)
        first = order[0]
        top3 = frozenset(order[:3])
        acceptable_first = first in acceptable
        preferred_first = first in preferred
        acceptable_three = bool(acceptable & top3)
        preferred_three = bool(preferred & top3)
        acceptable_at1 += int(acceptable_first)
        preferred_at1 += int(preferred_first)
        acceptable_hit_at3 += int(acceptable_three)
        preferred_hit_at3 += int(preferred_three)
        acceptable_set_recall_at3 += len(acceptable & top3) / len(acceptable)
        preferred_set_recall_at3 += len(preferred & top3) / len(preferred)
        acceptable_mrr += 1.0 / (
            1 + next(i for i, value in enumerate(order) if value in acceptable)
        )
        preferred_mrr += 1.0 / (
            1 + next(i for i, value in enumerate(order) if value in preferred)
        )
        top1_id = candidate_ids[first]
        counters[top1_id] += 1
        top1_by_sample[row.example.sample_id] = top1_id
        role = trainer.ROLE_VALUES[row.example.role_index]
        values = (acceptable_first, preferred_first, acceptable_three, preferred_three)
        role_buckets[role].append(values)
        group_buckets["ordinary" if role in ORDINARY_ROLES else "variant"].append(
            values
        )
        probabilities = _softmax_eligible(scores, order)
        margins.append(float(probabilities[0] - probabilities[1]))
        entropy = -float(
            np.sum(probabilities * np.log(np.maximum(probabilities, 1e-12)))
        )
        normalized_entropies.append(entropy / math.log(len(order)))

    count = len(rows)

    def summarize_bucket(
        values: Sequence[tuple[bool, bool, bool, bool]],
    ) -> dict[str, Any]:
        size = len(values)
        return {
            "acceptable_at1": sum(int(value[0]) for value in values) / size,
            "acceptable_hit_at3": sum(int(value[2]) for value in values) / size,
            "preferred_at1": sum(int(value[1]) for value in values) / size,
            "preferred_hit_at3": sum(int(value[3]) for value in values) / size,
            "sample_count": size,
        }

    result = {
        "acceptable_at1": acceptable_at1 / count,
        "acceptable_hit_at3": acceptable_hit_at3 / count,
        "acceptable_mean_reciprocal_rank": acceptable_mrr / count,
        "acceptable_set_recall_at3": acceptable_set_recall_at3 / count,
        "by_role": {
            role: summarize_bucket(values)
            for role, values in sorted(role_buckets.items())
        },
        "by_variant_group": {
            group: summarize_bucket(values)
            for group, values in sorted(group_buckets.items())
        },
        "candidate_top1_count": {
            candidate_id: counters.get(candidate_id, 0)
            for candidate_id in candidate_ids
        },
        "mean_normalized_entropy": float(np.mean(normalized_entropies)),
        "mean_top1_probability_margin": float(np.mean(margins)),
        "preferred_at1": preferred_at1 / count,
        "preferred_hit_at3": preferred_hit_at3 / count,
        "preferred_mean_reciprocal_rank": preferred_mrr / count,
        "preferred_set_recall_at3": preferred_set_recall_at3 / count,
        "sample_count": count,
        "selected_candidate_count": len(counters),
        "top1_by_sample": top1_by_sample,
    }
    if score_source == "fusion":
        result["fusion_runtime_weight"] = fusion_runtime_weight
    return result


def paired_comparison(
    runtime: Mapping[str, Any],
    direct: Mapping[str, Any],
    rows: Sequence[ValidationScores],
    *,
    candidate_ids: Sequence[str],
) -> dict[str, Any]:
    runtime_top1 = _require_mapping(runtime.get("top1_by_sample"), "runtime top1")
    direct_top1 = _require_mapping(direct.get("top1_by_sample"), "direct top1")
    index = {value: offset for offset, value in enumerate(candidate_ids)}
    counts: Counter[str] = Counter()
    preferred_counts: Counter[str] = Counter()
    disagreements = 0
    for row in rows:
        sample_id = row.example.sample_id
        runtime_id = str(runtime_top1[sample_id])
        direct_id = str(direct_top1[sample_id])
        if runtime_id not in index or direct_id not in index:
            raise StudentDiagnosisError("paired top1 escaped the candidate vocabulary")
        disagreements += int(runtime_id != direct_id)
        preferred, acceptable = _tier_indices(row.example, candidate_ids)
        runtime_ok = index[runtime_id] in acceptable
        direct_ok = index[direct_id] in acceptable
        runtime_preferred = index[runtime_id] in preferred
        direct_preferred = index[direct_id] in preferred
        counts[
            "both"
            if runtime_ok and direct_ok
            else "runtime_only"
            if runtime_ok
            else "direct_only"
            if direct_ok
            else "neither"
        ] += 1
        preferred_counts[
            "both"
            if runtime_preferred and direct_preferred
            else "runtime_only"
            if runtime_preferred
            else "direct_only"
            if direct_preferred
            else "neither"
        ] += 1
    size = len(rows)
    return {
        "acceptable_top1_outcomes": {
            key: counts[key]
            for key in ("both", "runtime_only", "direct_only", "neither")
        },
        "disagreement_count": disagreements,
        "disagreement_rate": disagreements / size,
        "either_head_acceptable_oracle_at1": 1.0 - counts["neither"] / size,
        "either_head_preferred_oracle_at1": 1.0 - preferred_counts["neither"] / size,
        "preferred_top1_outcomes": {
            key: preferred_counts[key]
            for key in ("both", "runtime_only", "direct_only", "neither")
        },
        "sample_count": size,
    }


def label_statistics(
    examples: Sequence[trainer.HumanExample], candidate_ids: Sequence[str]
) -> dict[str, Any]:
    preferred_sizes: Counter[int] = Counter()
    acceptable_only_sizes: Counter[int] = Counter()
    combined_sizes: Counter[int] = Counter()
    role_counts: Counter[str] = Counter()
    for example in examples:
        preferred, combined = _tier_indices(example, candidate_ids)
        preferred_sizes[len(preferred)] += 1
        acceptable_only_sizes[len(combined - preferred)] += 1
        combined_sizes[len(combined)] += 1
        role_counts[trainer.ROLE_VALUES[example.role_index]] += 1
    size = len(examples)
    return {
        "acceptable_only_set_size_histogram": {
            str(key): value for key, value in sorted(acceptable_only_sizes.items())
        },
        "combined_positive_set_mean_size": sum(
            key * value for key, value in combined_sizes.items()
        )
        / size,
        "combined_positive_set_size_histogram": {
            str(key): value for key, value in sorted(combined_sizes.items())
        },
        "preferred_set_mean_size": sum(
            key * value for key, value in preferred_sizes.items()
        )
        / size,
        "preferred_set_size_histogram": {
            str(key): value for key, value in sorted(preferred_sizes.items())
        },
        "role_counts": dict(sorted(role_counts.items())),
        "sample_count": size,
    }


def constant_candidate_baselines(
    examples: Sequence[trainer.HumanExample], candidate_ids: Sequence[str]
) -> dict[str, Any]:
    groups = {
        "all": tuple(examples),
        "ordinary": tuple(
            example
            for example in examples
            if trainer.ROLE_VALUES[example.role_index] in ORDINARY_ROLES
        ),
        "variant": tuple(
            example
            for example in examples
            if trainer.ROLE_VALUES[example.role_index] not in ORDINARY_ROLES
        ),
    }
    output: dict[str, Any] = {}
    for group, rows in groups.items():
        if not rows:
            continue
        acceptable_counts: Counter[str] = Counter()
        preferred_counts: Counter[str] = Counter()
        uniform_acceptable = 0.0
        uniform_preferred = 0.0
        for example in rows:
            preferred, acceptable = _tier_indices(example, candidate_ids)
            acceptable_counts.update(candidate_ids[index] for index in acceptable)
            preferred_counts.update(candidate_ids[index] for index in preferred)
            uniform_acceptable += len(acceptable) / len(example.eligible_indices)
            uniform_preferred += len(preferred) / len(example.eligible_indices)
        best_acceptable_id, best_acceptable_count = max(
            acceptable_counts.items(),
            key=lambda value: (value[1], -candidate_ids.index(value[0])),
        )
        best_preferred_id, best_preferred_count = max(
            preferred_counts.items(),
            key=lambda value: (value[1], -candidate_ids.index(value[0])),
        )
        size = len(rows)
        output[group] = {
            "best_constant_acceptable_at1": best_acceptable_count / size,
            "best_constant_acceptable_candidate_id": best_acceptable_id,
            "best_constant_preferred_at1": best_preferred_count / size,
            "best_constant_preferred_candidate_id": best_preferred_id,
            "sample_count": size,
            "uniform_eligible_expected_acceptable_at1": uniform_acceptable / size,
            "uniform_eligible_expected_preferred_at1": uniform_preferred / size,
        }
    return output


def _infer_validation(
    *,
    artifacts: student_pass.StudentArtifacts,
    snapshot: trainer.HumanSnapshot,
    catalog_registry: Path,
    device: str,
    amp_dtype: str,
    batch_size: int,
) -> list[ValidationScores]:
    runtime = student_pass.build_inference_runtime(
        artifacts, device=device, amp_dtype=amp_dtype
    )
    resolver = CatalogAssetResolver(catalog_registry)
    output: list[ValidationScores] = []
    for offset in range(0, len(snapshot.val_examples), batch_size):
        examples = snapshot.val_examples[offset : offset + batch_size]
        images: list[Any] = []
        try:
            for example in examples:
                if example.split != "val":
                    raise StudentDiagnosisError("non-validation row reached inference")
                images.extend(trainer._open_human_views(example, resolver))  # noqa: SLF001
            scores = student_pass.infer_batch(runtime, images)
        finally:
            for image in images:
                image.close()
        runtime_values = np.asarray(scores["candidate_scores"], dtype=np.float32)
        direct_values = np.asarray(scores["direct_scores"], dtype=np.float32)
        direct_view_values = np.asarray(scores["direct_view_scores"], dtype=np.float32)
        view_gate_values = np.asarray(scores["view_gate_weights"], dtype=np.float32)
        expected_shape = (len(examples), len(artifacts.candidate_ids))
        if (
            runtime_values.shape != expected_shape
            or direct_values.shape != expected_shape
            or direct_view_values.shape
            != (
                len(examples),
                len(student_pass.VIEW_NAMES),
                len(artifacts.candidate_ids),
            )
            or view_gate_values.shape != (len(examples), len(student_pass.VIEW_NAMES))
        ):
            raise StudentDiagnosisError("inference candidate shape drifted")
        for index, example in enumerate(examples):
            output.append(
                ValidationScores(
                    example=example,
                    runtime_scores=runtime_values[index].copy(),
                    direct_scores=direct_values[index].copy(),
                    direct_view_scores=direct_view_values[index].copy(),
                    view_gate_weights=view_gate_values[index].copy(),
                )
            )
    if len(output) != len(snapshot.val_examples):
        raise StudentDiagnosisError("validation inference row count drifted")
    return output


def build_diagnosis(args: argparse.Namespace) -> dict[str, Any]:
    if args.batch_size < 1:
        raise StudentDiagnosisError("batch size must be positive")
    registry = args.catalog_registry.expanduser().resolve()
    artifacts = student_pass.validate_student_artifacts(args.student_dir, registry)
    contract_inputs = _require_mapping(
        artifacts.contract.get("inputs"), "student contract.inputs"
    )
    base_snapshot = trainer.validate_human_input(
        args.human_export_dir,
        candidate_ids=artifacts.candidate_ids,
        catalog_registry_sha256=trainer.sha256_file(registry),
    )
    expected_human_bindings = {
        "human_export_manifest_sha256": base_snapshot.manifest_sha256,
        "human_export_marker_sha256": base_snapshot.marker_sha256,
        "human_export_report_sha256": base_snapshot.report_sha256,
    }
    if any(
        contract_inputs.get(key) != value
        for key, value in expected_human_bindings.items()
    ):
        raise StudentDiagnosisError(
            "human validation export is not the training authority"
        )
    overlay_dir = getattr(args, "human_val_overlay_dir", None)
    finals_dir = getattr(args, "human_val_finals_dir", None)
    if (overlay_dir is None) != (finals_dir is None):
        raise StudentDiagnosisError(
            "adjudicated val diagnosis requires both overlay and finals directories"
        )
    snapshot = base_snapshot
    overlay_validation: Mapping[str, Any] | None = None
    validation_authority = "base_human_export_val"
    if overlay_dir is not None and finals_dir is not None:
        trainer_v2.validate_v2_output(args.student_dir)
        snapshot, overlay_validation = human_overlay.apply_overlay(
            overlay_dir=overlay_dir,
            base_export_dir=args.human_export_dir,
            finals_dir=finals_dir,
            catalog_registry=registry,
            candidate_ids=artifacts.candidate_ids,
        )
        extension = _require_mapping(
            artifacts.contract.get("trainer_extension"), "student trainer extension"
        )
        if (
            _require_mapping(
                extension.get("human_val_overlay"), "student human val overlay"
            )
            != overlay_validation
        ):
            raise StudentDiagnosisError(
                "adjudicated val overlay differs from the v2 training authority"
            )
        validation_authority = "adjudicated_val_overlay"
    if contract_inputs.get("human_samples_sha256") != snapshot.samples_sha256:
        raise StudentDiagnosisError(
            "validation samples differ from the student training authority"
        )
    rows = _infer_validation(
        artifacts=artifacts,
        snapshot=snapshot,
        catalog_registry=registry,
        device=args.device,
        amp_dtype=args.amp_dtype,
        batch_size=args.batch_size,
    )
    runtime = summarize_method(
        rows, candidate_ids=artifacts.candidate_ids, score_source="runtime"
    )
    direct = summarize_method(
        rows, candidate_ids=artifacts.candidate_ids, score_source="direct"
    )
    direct_view_methods: dict[str, dict[str, Any]] = {}
    direct_view_paired: dict[str, dict[str, Any]] = {}
    for name, weights in DIRECT_FIXED_VIEW_WEIGHTS.items():
        weighted_rows = reweight_direct_rows(rows, fixed_weights=weights)
        summary = summarize_method(
            weighted_rows,
            candidate_ids=artifacts.candidate_ids,
            score_source="direct",
        )
        summary["fixed_view_weights"] = {
            view_name: weights[index]
            for index, view_name in enumerate(student_pass.VIEW_NAMES)
        }
        direct_view_methods[name] = summary
        direct_view_paired[name] = paired_comparison(
            runtime, summary, weighted_rows, candidate_ids=artifacts.candidate_ids
        )
    gated_rows = reweight_direct_rows(rows, use_runtime_view_gate=True)
    gated_direct = summarize_method(
        gated_rows,
        candidate_ids=artifacts.candidate_ids,
        score_source="direct",
    )
    gated_direct["view_weight_source"] = "runtime_ranker_per_sample_view_gate"
    direct_view_methods["runtime_view_gate_weighted"] = gated_direct
    direct_view_paired["runtime_view_gate_weighted"] = paired_comparison(
        runtime, gated_direct, gated_rows, candidate_ids=artifacts.candidate_ids
    )
    fusions = [
        summarize_method(
            rows,
            candidate_ids=artifacts.candidate_ids,
            score_source="fusion",
            fusion_runtime_weight=weight,
        )
        for weight in FUSION_RUNTIME_WEIGHTS
    ]
    # Per-sample maps are useful internally for the paired audit but would add
    # unnecessary identifiers to the aggregate diagnosis.
    paired = paired_comparison(
        runtime, direct, rows, candidate_ids=artifacts.candidate_ids
    )
    for method in (runtime, direct, *direct_view_methods.values(), *fusions):
        method.pop("top1_by_sample", None)
    prototype = _require_mapping(
        artifacts.contract.get("prototype_bank"), "student prototype bank"
    )
    bags = prototype.get("candidate_bags")
    if not isinstance(bags, list):
        raise StudentDiagnosisError("prototype bags are unavailable")
    baselines = constant_candidate_baselines(
        snapshot.val_examples, artifacts.candidate_ids
    )
    all_constant = _require_mapping(baselines.get("all"), "all constant baseline")
    constant_acceptable = float(all_constant["best_constant_acceptable_at1"])
    constant_preferred = float(all_constant["best_constant_preferred_at1"])
    acceptable_delta = float(runtime["acceptable_at1"]) - constant_acceptable
    preferred_delta = float(runtime["preferred_at1"]) - constant_preferred
    beats_both_constant_baselines = acceptable_delta > 0.0 and preferred_delta > 0.0
    return trainer.seal_record(
        {
            "baselines": baselines,
            "bindings": {
                "catalog_registry_sha256": trainer.sha256_file(registry),
                "checkpoint_sha256": artifacts.bindings["checkpoint_sha256"],
                "human_samples_sha256": snapshot.samples_sha256,
                "model_contract_sha256": artifacts.bindings["model_contract_sha256"],
                "prototype_features_sha256": artifacts.bindings[
                    "prototype_features_sha256"
                ],
                "source_code_sha256": trainer.sha256_file(Path(__file__).resolve()),
            },
            "checks": {
                "evaluation_split": "human_val_only",
                "human_test_labels_deserialized": 0,
                "human_test_pixels_opened": 0,
                "human_train_pixels_opened": 0,
                "validation_label_authority": validation_authority,
                "skipped_test_rows_seen_only_by_byte_split_scanner": snapshot.skipped_test_rows,
            },
            "label_statistics": label_statistics(
                snapshot.val_examples, artifacts.candidate_ids
            ),
            "metric_definitions": {
                "acceptable_at1": "top1_in_preferred_or_acceptable",
                "acceptable_hit_at3": "any_top3_in_preferred_or_acceptable",
                "acceptable_set_recall_at3": "intersection_size_divided_by_full_acceptable_set_size",
                "preferred_at1": "top1_in_preferred",
                "preferred_hit_at3": "any_top3_in_preferred",
            },
            "methods": {
                "direct_classifier": direct,
                "direct_view_ensembles": direct_view_methods,
                "runtime_prototype_ranker": runtime,
            },
            "overlay_validation": (
                None
                if overlay_validation is None
                else {
                    "combined_authority_sha256": overlay_validation[
                        "combined_authority_sha256"
                    ],
                    "status": overlay_validation["status"],
                    "val_record_count": overlay_validation["val_record_count"],
                    "val_samples_sha256": overlay_validation["val_samples_sha256"],
                }
            ),
            "paired_comparison": paired,
            "paired_runtime_vs_direct_view_ensembles": direct_view_paired,
            "prototype_bank": {
                "candidate_bag_count": len(bags),
                "prototype_count": prototype.get("prototype_count"),
                "prototypes_per_candidate": [
                    _require_mapping(value, "prototype bag").get("count")
                    for value in bags
                ],
                "selection_policy_from_trainer": prototype.get(
                    "selection_policy",
                    "sample_id_sorted_first_n_synthetic_train_glyph_views",
                ),
            },
            "quality_comparison": {
                "best_constant_acceptable_at1": constant_acceptable,
                "best_constant_preferred_at1": constant_preferred,
                "deployment_authority": False,
                "observation": (
                    "runtime_failed_to_beat_best_constant_baselines"
                    if not beats_both_constant_baselines
                    else "runtime_beat_constants_but_requires_independent_release_gate"
                ),
                "recommended_action": (
                    "block_attachment_and_retrain"
                    if not beats_both_constant_baselines
                    else "run_independent_release_evaluation"
                ),
                "runtime_acceptable_at1": runtime["acceptable_at1"],
                "runtime_acceptable_minus_best_constant": acceptable_delta,
                "runtime_beats_both_best_constants": beats_both_constant_baselines,
                "runtime_preferred_at1": runtime["preferred_at1"],
                "runtime_preferred_minus_best_constant": preferred_delta,
            },
            "record_type": RECORD_TYPE,
            "schema_version": SCHEMA_VERSION,
            "validation_only_exploratory_fusions": {
                "deployment_authority": False,
                "methods": fusions,
                "warning": "same_validation_rows_used_for_weight_probe_do_not_select_for_release",
            },
        }
    )


def write_report(path: Path, report: Mapping[str, Any]) -> None:
    output = path.expanduser().resolve()
    if output.exists():
        raise StudentDiagnosisError(f"diagnosis output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = trainer.json_bytes(report, pretty=True)
    with tempfile.NamedTemporaryFile(
        mode="wb", dir=output.parent, prefix=f".{output.name}.", delete=False
    ) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
        handle.flush()
    try:
        temporary.replace(output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--student-dir", type=Path, required=True)
    parser.add_argument("--human-export-dir", type=Path, required=True)
    parser.add_argument("--human-val-overlay-dir", type=Path)
    parser.add_argument("--human-val-finals-dir", type=Path)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument(
        "--amp-dtype",
        choices=("auto", "bfloat16", "float16", "float32"),
        default="auto",
    )
    parser.add_argument("--batch-size", type=int, default=16)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = build_diagnosis(args)
        write_report(args.output, report)
    except (
        StudentDiagnosisError,
        student_pass.StudentPassError,
        trainer.MangaFontStudentError,
        OSError,
    ) as error:
        raise SystemExit(f"diagnosis failed: {error}") from error
    print(
        trainer.canonical_json(
            {
                "direct_preferred_at1": report["methods"]["direct_classifier"][
                    "preferred_at1"
                ],
                "output": str(args.output.expanduser().resolve()),
                "runtime_acceptable_at1": report["methods"]["runtime_prototype_ranker"][
                    "acceptable_at1"
                ],
                "runtime_preferred_at1": report["methods"]["runtime_prototype_ranker"][
                    "preferred_at1"
                ],
                "schema_version": report["schema_version"],
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
