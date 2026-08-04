#!/usr/bin/env python3
"""Build a sealed confidence-only calibration that cannot rerank fonts.

The frozen ONNX runtime remains the sole font-family ranker.  This artifact
fits a tiny Platt model from two pixel-ranker values belonging to the original
top-1 decision: its raw score and its margin over raw top-2.  The calibrated
probability may be used only for an accept/abstain threshold; it never changes
candidate order.  Work-LOGO validation and the existing deployment quality
floors remain mandatory.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import tempfile
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import build_font_matching_selection_calibration as base
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_font_matching_selection_calibration as base  # type: ignore[no-redef]


SCHEMA_VERSION = "font-matching-selection-calibration-v2"
RECORD_TYPE = base.RECORD_TYPE
CONFIDENCE_SCHEMA = "font-matching-rank-preserving-confidence-v1"
FEATURE_NAMES = ("top1_raw_score", "top1_raw_margin")
RANKING_POLICY = {
    "candidate_reranking": False,
    "confidence_model": "top1_score_margin_platt",
    "mode": "preserve_runtime_candidate_order",
}
SIGMOID = "1/(1+exp(-z))"
DEFAULT_C_GRID = base.DEFAULT_C_GRID
EPSILON = base.EPSILON


class RankPreservingCalibrationError(ValueError):
    """Raised when confidence evidence can affect rank or is untrustworthy."""


@dataclass(frozen=True)
class ConfidenceTable:
    features: np.ndarray
    labels: np.ndarray
    weights: np.ndarray
    top1_indices: np.ndarray
    top1_ids: tuple[str, ...]
    raw_top1_sha256: str


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RankPreservingCalibrationError(f"{location}: expected an object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise RankPreservingCalibrationError(f"{location}: expected a list")
    return value


def _finite(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RankPreservingCalibrationError(f"{location}: expected a number")
    result = float(value)
    if not math.isfinite(result):
        raise RankPreservingCalibrationError(f"{location}: must be finite")
    return result


def _probability(value: Any, location: str) -> float:
    result = _finite(value, location)
    if not 0.0 <= result <= 1.0:
        raise RankPreservingCalibrationError(f"{location}: must be in [0,1]")
    return result


def _hash_top1(samples: Sequence[base.BoundSample], top1_ids: Sequence[str]) -> str:
    if len(samples) != len(top1_ids):
        raise RankPreservingCalibrationError("top1 hash inventory drifted")
    return base.sha256_bytes(
        "".join(
            f"{sample.sample_id}\0{candidate_id}\n"
            for sample, candidate_id in zip(samples, top1_ids, strict=True)
        ).encode("utf-8")
    )


def build_confidence_table(
    samples: Sequence[base.BoundSample],
    candidate_ids: Sequence[str],
    outputs: Mapping[str, np.ndarray],
) -> ConfidenceTable:
    scores = np.asarray(outputs.get("candidate_scores"), dtype=np.float64)
    if (
        scores.shape != (len(samples), len(candidate_ids))
        or len(candidate_ids) < 2
        or not np.isfinite(scores).all()
    ):
        raise RankPreservingCalibrationError("raw candidate score matrix drifted")
    per_work_confidence: defaultdict[str, float] = defaultdict(float)
    for sample in samples:
        per_work_confidence[sample.work_id] += sample.label_confidence
    if any(value <= 0.0 for value in per_work_confidence.values()):
        raise RankPreservingCalibrationError("work confidence denominator is invalid")

    features: list[list[float]] = []
    labels: list[int] = []
    weights: list[float] = []
    top1_indices: list[int] = []
    top1_ids: list[str] = []
    for sample_index, sample in enumerate(samples):
        order = np.argsort(-scores[sample_index], kind="stable")
        top1 = int(order[0])
        top2 = int(order[1])
        candidate_id = str(candidate_ids[top1])
        raw_score = float(scores[sample_index, top1])
        raw_margin = float(raw_score - scores[sample_index, top2])
        if raw_margin < -1e-12:
            raise RankPreservingCalibrationError("stable raw ranking produced negative margin")
        features.append([raw_score, max(0.0, raw_margin)])
        labels.append(int(candidate_id in sample.positive))
        weights.append(
            sample.label_confidence / per_work_confidence[sample.work_id]
        )
        top1_indices.append(top1)
        top1_ids.append(candidate_id)
    matrix = np.asarray(features, dtype=np.float64)
    label_array = np.asarray(labels, dtype=np.int64)
    weight_array = np.asarray(weights, dtype=np.float64)
    if (
        matrix.shape != (len(samples), len(FEATURE_NAMES))
        or not np.isfinite(matrix).all()
        or not np.isfinite(weight_array).all()
        or set(label_array.tolist()) != {0, 1}
    ):
        raise RankPreservingCalibrationError("confidence-only table is invalid")
    return ConfidenceTable(
        features=matrix,
        labels=label_array,
        weights=weight_array,
        top1_indices=np.asarray(top1_indices, dtype=np.int64),
        top1_ids=tuple(top1_ids),
        raw_top1_sha256=_hash_top1(samples, top1_ids),
    )


def _fit_predict(
    train: np.ndarray,
    test: np.ndarray,
    table: ConfidenceTable,
    C: float,
) -> tuple[np.ndarray, np.ndarray, float]:
    try:
        from sklearn.linear_model import LogisticRegression
    except ImportError as error:  # pragma: no cover
        raise RankPreservingCalibrationError("scikit-learn is required") from error
    if set(table.labels[train].tolist()) != {0, 1}:
        raise RankPreservingCalibrationError("confidence fold lacks both label classes")
    mean = table.features[train].mean(axis=0)
    scale = table.features[train].std(axis=0, ddof=0)
    scale[scale < 1e-8] = 1.0
    model = LogisticRegression(
        C=C, penalty="l2", solver="lbfgs", max_iter=3000, tol=1e-9
    )
    weight = table.weights[train]
    weight = weight * (len(weight) / weight.sum())
    model.fit(
        (table.features[train] - mean) / scale,
        table.labels[train],
        sample_weight=weight,
    )
    probability = model.predict_proba((table.features[test] - mean) / scale)[:, 1]
    normalized_coef = np.asarray(model.coef_[0], dtype=np.float64)
    raw_coef = normalized_coef / scale
    raw_intercept = float(model.intercept_[0] - np.dot(normalized_coef, mean / scale))
    return probability, raw_coef, raw_intercept


def _weighted_log_loss(
    labels: np.ndarray, predictions: np.ndarray, weights: np.ndarray
) -> float:
    clipped = np.clip(predictions, EPSILON, 1.0 - EPSILON)
    return float(
        np.average(
            -(labels * np.log(clipped) + (1 - labels) * np.log(1 - clipped)),
            weights=weights,
        )
    )


def _select_C(
    train: np.ndarray,
    table: ConfidenceTable,
    samples: Sequence[base.BoundSample],
    grid: Sequence[float],
) -> float:
    works = sorted({samples[int(index)].work_id for index in train})
    if len(works) < 2:
        raise RankPreservingCalibrationError("inner LOGO needs at least two works")
    losses: list[tuple[float, float]] = []
    for C in grid:
        prediction = np.full(len(train), np.nan, dtype=np.float64)
        for work in works:
            test_local = np.asarray(
                [i for i, row in enumerate(train) if samples[int(row)].work_id == work],
                dtype=np.int64,
            )
            train_local = np.asarray(
                [i for i in range(len(train)) if i not in set(test_local.tolist())],
                dtype=np.int64,
            )
            p, _coef, _intercept = _fit_predict(
                train[train_local], train[test_local], table, C
            )
            prediction[test_local] = p
        losses.append(
            (
                _weighted_log_loss(
                    table.labels[train], prediction, table.weights[train]
                ),
                float(C),
            )
        )
    losses.sort(key=lambda value: (round(value[0], 12), value[1]))
    return losses[0][1]


def work_logo_predictions(
    table: ConfidenceTable,
    samples: Sequence[base.BoundSample],
    grid: Sequence[float],
    *,
    fixed_C: float | None = None,
) -> tuple[np.ndarray, list[dict[str, Any]], list[float]]:
    predictions = np.full(len(samples), np.nan, dtype=np.float64)
    folds: list[dict[str, Any]] = []
    selected: list[float] = []
    for work in sorted({sample.work_id for sample in samples}):
        test = np.asarray(
            [index for index, sample in enumerate(samples) if sample.work_id == work],
            dtype=np.int64,
        )
        train = np.asarray(
            [index for index, sample in enumerate(samples) if sample.work_id != work],
            dtype=np.int64,
        )
        C = fixed_C if fixed_C is not None else _select_C(train, table, samples, grid)
        probability, _coef, _intercept = _fit_predict(train, test, table, C)
        predictions[test] = probability
        selected.append(float(C))
        folds.append(
            {
                "C": float(C),
                "confidence_row_count": int(len(test)),
                "held_out_work_id_sha256": base.sha256_bytes(work.encode("utf-8")),
                "confidence_log_loss": _weighted_log_loss(
                    table.labels[test], probability, table.weights[test]
                ),
            }
        )
    if not np.isfinite(predictions).all():
        raise RankPreservingCalibrationError("outer OOF prediction missing")
    return predictions, folds, selected


def _winner_rows(
    predictions: np.ndarray,
    table: ConfidenceTable,
    samples: Sequence[base.BoundSample],
    outputs: Mapping[str, np.ndarray],
    none_threshold: float,
) -> list[dict[str, Any]]:
    none_logits = np.asarray(outputs.get("none_logits"), dtype=np.float64)
    if none_logits.shape != (len(samples),) or not np.isfinite(none_logits).all():
        raise RankPreservingCalibrationError("none-logit output drifted")
    rows: list[dict[str, Any]] = []
    for index, sample in enumerate(samples):
        candidate_id = table.top1_ids[index]
        rows.append(
            {
                "acceptable": candidate_id in sample.positive,
                "family": base._role_family(sample.role),  # noqa: SLF001
                "none_gate_passed": base._sigmoid(float(none_logits[index]))  # noqa: SLF001
                < none_threshold,
                "normal": not sample.none_acceptable,
                "preferred": candidate_id in sample.preferred,
                "sample_index": index,
                "score": float(predictions[index]),
                "work_id": sample.work_id,
            }
        )
    return rows


def _operating_points(
    rows: Sequence[Mapping[str, Any]],
    *,
    coverage_target: float,
    precision_target: float,
) -> dict[str, Any]:
    return {
        family: base.select_operating_point(
            rows,
            family,
            coverage_target=coverage_target,
            precision_target=precision_target,
        )
        for family in ("body", "variant", "global")
    }


def build_calibration(
    *,
    finals_path: Path,
    master_manifest_path: Path,
    catalog_registry_path: Path,
    runtime_dir: Path,
    C_grid: Sequence[float] = DEFAULT_C_GRID,
    coverage_target: float = 0.90,
    precision_target: float = 0.88,
) -> dict[str, Any]:
    if not 0.90 <= coverage_target <= 1.0 or not 0.0 <= precision_target <= 1.0:
        raise RankPreservingCalibrationError("invalid deployment target")
    try:
        bindings, runtime, prototypes = base._runtime_bindings(runtime_dir)  # noqa: SLF001
        registry = base._read_json(catalog_registry_path, "catalog registry")  # noqa: SLF001
        split_map_path, master_bindings = base.validate_master_inputs(
            master_manifest_path, catalog_registry_path, registry
        )
        val_rows, isolation = base.load_val_manifest(master_manifest_path, split_map_path)
        samples, non_val_parsed = base.load_allowlisted_finals(
            finals_path,
            val_rows,
            runtime["candidate_ids"],
            retired_candidate_ids=runtime["retired_label_candidates"],
        )
        if (
            len(runtime["candidate_ids"]) != 21
            or "gugi" in runtime["candidate_ids"]
            or tuple(runtime["retired_label_candidates"]) != ("gugi",)
            or not runtime["hybrid_score_routing"]
            or runtime["hybrid_score_routing"].get("family_scores_shared") is not True
        ):
            raise RankPreservingCalibrationError(
                "v2 confidence-only calibration requires sealed active21 shared pixel scores"
            )
        resolver = base.catalog_assets.CatalogAssetResolver(catalog_registry_path)
        views = base._encode_views(  # noqa: SLF001
            samples, resolver, runtime_dir / "encoder.onnx", runtime["feature_dim"]
        )
        outputs = base._ranker_outputs(  # noqa: SLF001
            views, prototypes, runtime_dir / "ranker.onnx"
        )
        outputs = base._route_hybrid_candidate_scores(  # noqa: SLF001
            samples, outputs, runtime
        )
    except base.SelectionCalibrationError as error:
        raise RankPreservingCalibrationError(str(error)) from error

    table = build_confidence_table(samples, runtime["candidate_ids"], outputs)
    nested_predictions, _nested_folds, selected_Cs = work_logo_predictions(
        table, samples, C_grid
    )
    final_C = base._geometric_median(selected_Cs)  # noqa: SLF001
    oof_predictions, fixed_folds, _ = work_logo_predictions(
        table, samples, C_grid, fixed_C=final_C
    )
    all_rows = np.arange(len(samples), dtype=np.int64)
    _final_predictions, raw_coef, raw_intercept = _fit_predict(
        all_rows, all_rows, table, final_C
    )
    operating = _operating_points(
        _winner_rows(
            oof_predictions, table, samples, outputs, runtime["none_threshold"]
        ),
        coverage_target=coverage_target,
        precision_target=precision_target,
    )
    nested_operating = _operating_points(
        _winner_rows(
            nested_predictions, table, samples, outputs, runtime["none_threshold"]
        ),
        coverage_target=coverage_target,
        precision_target=precision_target,
    )
    try:
        from sklearn.metrics import roc_auc_score

        auc = float(
            roc_auc_score(
                table.labels, oof_predictions, sample_weight=table.weights
            )
        )
    except (ImportError, ValueError):
        auc = 0.0

    bindings.update(master_bindings)
    bindings["finals_sha256"] = base.sha256_file(finals_path)
    top1_hash = table.raw_top1_sha256
    record = {
        "bindings": bindings,
        "candidate_ids": list(runtime["candidate_ids"]),
        "confidence_calibration": {
            "c": final_C,
            "coef": [float(value) for value in raw_coef],
            "feature_names": list(FEATURE_NAMES),
            "intercept": raw_intercept,
            "schema_version": CONFIDENCE_SCHEMA,
            "sigmoid": SIGMOID,
        },
        "leakage_audit": {
            "allowed_sample_count": len(samples),
            "allowed_split": "val",
            "allowed_work_count": len({sample.work_id for sample in samples}),
            "candidate_reranking": False,
            "confidence_row_count": len(samples),
            "excluded_unrenderable_candidate_rows": sum(
                len(sample.excluded) for sample in samples
            ),
            "gold_final_rows_used_for_fit": len(samples),
            "hybrid_score_route_source": "pixel_shared_scores_role_downstream_only",
            "nested_hyperparameter_selection": True,
            "non_val_label_rows_parsed": non_val_parsed,
            "normalized_glyph_isolation_passed": isolation[
                "normalized_glyph_isolation"
            ],
            "pixel_only_confidence_features": True,
            "pseudo_label_rows_used_for_fit": 0,
            "semantic_feature_count": 0,
            "source_page_isolation_passed": isolation["source_page_isolation"],
            "split_component_isolation_passed": isolation[
                "split_component_isolation"
            ],
            "test_rows_used_for_fit": 0,
            "train_rows_used_for_fit": 0,
            "work_group_oof": True,
        },
        "oof_report": {
            "final_C": final_C,
            "fit_implementation": {
                "max_iter": 3000,
                "penalty": "l2",
                "raw_space_coefficients": True,
                "solver": "lbfgs",
                "standardization": "train_fold_population_mean_std_ddof0",
                "tol": 1e-9,
            },
            "folds": fixed_folds,
            "full_oof": copy.deepcopy(operating),
            "nested_operating_evaluation": nested_operating,
            "rank_preservation": {
                "calibrated_top1_sha256": top1_hash,
                "changed_top1_count": 0,
                "evaluated_sample_count": len(samples),
                "exact_top1_agreement": 1.0,
                "raw_top1_sha256": top1_hash,
            },
            "selected_C_values": selected_Cs,
            "confidence_log_loss": _weighted_log_loss(
                table.labels, oof_predictions, table.weights
            ),
            "confidence_roc_auc": auc,
        },
        "operating_points": operating,
        "ranking_policy": copy.deepcopy(RANKING_POLICY),
        "record_type": RECORD_TYPE,
        "schema_version": SCHEMA_VERSION,
        "training_boundary": {
            "none_sample_count": sum(sample.none_acceptable for sample in samples),
            "raw_top1_sha256": top1_hash,
            "sample_count": len(samples),
            "sample_ids_sha256": base._hash_ids(  # noqa: SLF001
                sample.sample_id for sample in samples
            ),
            "split": "val",
            "supervision": {
                "allowed_resolution_kinds": ["adjudicated", "primary"],
                "gold_final_sample_count": len(samples),
                "pseudo_label_sample_count": 0,
                "pseudo_labels_forbidden": True,
                "tier": "gold_final_only",
            },
            "winner_rows_sha256": base.sha256_bytes(
                "".join(
                    f"{sample.sample_id}\0{candidate_id}\0{int(label)}\n"
                    for sample, candidate_id, label in zip(
                        samples, table.top1_ids, table.labels, strict=True
                    )
                ).encode("utf-8")
            ),
            "work_count": len({sample.work_id for sample in samples}),
            "work_ids_sha256": base._hash_ids(  # noqa: SLF001
                sample.work_id for sample in samples
            ),
        },
    }
    return base.seal_record(record)


def _validate_point(value: Any, location: str) -> None:
    point = _mapping(value, location)
    for key in (
        "coverage_target",
        "coverage",
        "precision_target",
        "acceptable_at1",
        "preferred_at1",
    ):
        _probability(point.get(key), f"{location}.{key}")
    threshold = point.get("selection_score_threshold")
    if point.get("enabled") is True:
        _probability(threshold, f"{location}.selection_score_threshold")
    elif threshold is not None:
        raise RankPreservingCalibrationError(f"{location}: disabled threshold drifted")


def validate_calibration(record: Mapping[str, Any]) -> dict[str, Any]:
    try:
        base.validate_record_seal(record, location="rank-preserving calibration")
    except base.SelectionCalibrationError as error:
        raise RankPreservingCalibrationError(str(error)) from error
    expected_keys = {
        "bindings",
        "candidate_ids",
        "confidence_calibration",
        "leakage_audit",
        "oof_report",
        "operating_points",
        "ranking_policy",
        "record_sha256",
        "record_type",
        "schema_version",
        "training_boundary",
    }
    if (
        set(record) != expected_keys
        or record.get("schema_version") != SCHEMA_VERSION
        or record.get("record_type") != RECORD_TYPE
        or dict(_mapping(record.get("ranking_policy"), "ranking_policy"))
        != RANKING_POLICY
    ):
        raise RankPreservingCalibrationError("rank-preserving schema/policy drifted")
    candidate_ids = _list(record.get("candidate_ids"), "candidate_ids")
    if (
        len(candidate_ids) != 21
        or len(set(candidate_ids)) != 21
        or "gugi" in candidate_ids
        or any(not isinstance(value, str) or not value for value in candidate_ids)
    ):
        raise RankPreservingCalibrationError("active21 candidate inventory drifted")
    bindings = _mapping(record.get("bindings"), "bindings")
    if bindings.get("candidate_order_sha256") != base.sha256_bytes(
        ("\n".join(candidate_ids) + "\n").encode("utf-8")
    ):
        raise RankPreservingCalibrationError("candidate-order binding drifted")
    for key, value in bindings.items():
        if key.endswith("sha256") and (
            not isinstance(value, str) or base.SHA_RE.fullmatch(value) is None
        ):
            raise RankPreservingCalibrationError(f"bindings.{key}: invalid SHA")

    confidence = _mapping(record.get("confidence_calibration"), "confidence")
    if set(confidence) != {
        "c",
        "coef",
        "feature_names",
        "intercept",
        "schema_version",
        "sigmoid",
    } or (
        confidence.get("schema_version") != CONFIDENCE_SCHEMA
        or confidence.get("feature_names") != list(FEATURE_NAMES)
        or confidence.get("sigmoid") != SIGMOID
    ):
        raise RankPreservingCalibrationError("confidence-only feature contract drifted")
    coefficients = _list(confidence.get("coef"), "confidence.coef")
    if len(coefficients) != len(FEATURE_NAMES):
        raise RankPreservingCalibrationError("confidence coefficient length drifted")
    for index, value in enumerate(coefficients):
        _finite(value, f"confidence.coef[{index}]")
    _finite(confidence.get("intercept"), "confidence.intercept")
    if _finite(confidence.get("c"), "confidence.c") <= 0.0:
        raise RankPreservingCalibrationError("confidence.c must be positive")

    leakage = _mapping(record.get("leakage_audit"), "leakage_audit")
    if (
        leakage.get("allowed_split") != "val"
        or leakage.get("test_rows_used_for_fit") != 0
        or leakage.get("train_rows_used_for_fit") != 0
        or leakage.get("pseudo_label_rows_used_for_fit") != 0
        or leakage.get("non_val_label_rows_parsed") != 0
        or leakage.get("candidate_reranking") is not False
        or leakage.get("pixel_only_confidence_features") is not True
        or leakage.get("semantic_feature_count") != 0
        or leakage.get("hybrid_score_route_source")
        != "pixel_shared_scores_role_downstream_only"
    ):
        raise RankPreservingCalibrationError("confidence calibration leakage detected")
    points = _mapping(record.get("operating_points"), "operating_points")
    if set(points) != {"body", "variant", "global"}:
        raise RankPreservingCalibrationError("operating point inventory drifted")
    for family, point in points.items():
        _validate_point(point, f"operating_points.{family}")
    global_point = _mapping(points.get("global"), "operating_points.global")
    if (
        global_point.get("coverage_floor_passed") is not True
        or float(global_point.get("coverage_target", 0.0)) < 0.90
        or float(global_point.get("coverage", 0.0))
        < float(global_point.get("coverage_target", 1.0))
    ):
        raise RankPreservingCalibrationError("global coverage hard floor failed")
    oof = _mapping(record.get("oof_report"), "oof_report")
    rank = _mapping(oof.get("rank_preservation"), "rank_preservation")
    training = _mapping(record.get("training_boundary"), "training_boundary")
    if (
        _finite(oof.get("final_C"), "oof.final_C")
        != float(confidence["c"])
        or oof.get("full_oof") != points
        or rank.get("changed_top1_count") != 0
        or rank.get("exact_top1_agreement") != 1.0
        or rank.get("raw_top1_sha256") != rank.get("calibrated_top1_sha256")
        or rank.get("raw_top1_sha256") != training.get("raw_top1_sha256")
        or training.get("split") != "val"
        or _mapping(training.get("supervision"), "supervision").get(
            "pseudo_labels_forbidden"
        )
        is not True
    ):
        raise RankPreservingCalibrationError("rank-preservation evidence drifted")
    nested = _mapping(oof.get("nested_operating_evaluation"), "nested operating")
    if set(nested) != {"body", "variant", "global"}:
        raise RankPreservingCalibrationError("nested operating inventory drifted")
    for family, point in nested.items():
        _validate_point(point, f"nested.{family}")
    return copy.deepcopy(dict(record))


def deployment_quality_gate(record: Mapping[str, Any]) -> dict[str, Any]:
    validated = validate_calibration(record)
    oof = _mapping(validated.get("oof_report"), "oof_report")
    evidence_sets = {
        "full_oof": _mapping(oof.get("full_oof"), "full_oof"),
        "nested_operating_evaluation": _mapping(
            oof.get("nested_operating_evaluation"), "nested"
        ),
    }
    requirements = {
        "global": base.MINIMUM_DEPLOYMENT_GLOBAL_PREFERRED_AT1,
        "variant": base.MINIMUM_DEPLOYMENT_VARIANT_PREFERRED_AT1,
    }
    failures: list[str] = []
    metrics: dict[str, Any] = {}
    for evidence_name, points in evidence_sets.items():
        metrics[evidence_name] = {}
        for family, preferred_floor in requirements.items():
            point = _mapping(points.get(family), f"{evidence_name}.{family}")
            snapshot = {
                "acceptable_at1": float(point.get("acceptable_at1", 0.0)),
                "coverage": float(point.get("coverage", 0.0)),
                "preferred_at1": float(point.get("preferred_at1", 0.0)),
                "preferred_at1_target": preferred_floor,
                "precision_target": float(point.get("precision_target", 0.0)),
            }
            metrics[evidence_name][family] = snapshot
            if point.get("enabled") is not True:
                failures.append(f"{evidence_name}.{family}: disabled")
            if point.get("coverage_floor_passed") is not True:
                failures.append(f"{evidence_name}.{family}: coverage target missed")
            if point.get("precision_target_passed") is not True:
                failures.append(f"{evidence_name}.{family}: precision target missed")
            if snapshot["preferred_at1"] + 1e-12 < preferred_floor:
                failures.append(
                    f"{evidence_name}.{family}: preferred@1 "
                    f"{snapshot['preferred_at1']:.4f} < {preferred_floor:.4f}"
                )
    return {
        "failures": failures,
        "metrics": metrics,
        "passed": not failures,
        "record_sha256": validated["record_sha256"],
    }


def require_deployment_quality(record: Mapping[str, Any]) -> dict[str, Any]:
    result = deployment_quality_gate(record)
    if not result["passed"]:
        raise RankPreservingCalibrationError(
            "deployment quality gate failed: " + "; ".join(result["failures"])
        )
    return result


def write_record(path: Path, record: Mapping[str, Any], *, replace_existing: bool) -> None:
    target = path.expanduser().resolve()
    if target.exists() and not replace_existing:
        raise RankPreservingCalibrationError("output exists; pass --replace-existing")
    if target.exists():
        validate_calibration(base._read_json(target, "existing calibration"))  # noqa: SLF001
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="\n",
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=target.parent,
        delete=False,
    ) as handle:
        temporary = Path(handle.name)
        json.dump(record, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    try:
        temporary.replace(target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--finals", type=Path, required=True)
    build.add_argument("--master-manifest", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--runtime-dir", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--replace-existing", action="store_true")
    build.add_argument("--coverage-target", type=float, default=0.90)
    build.add_argument("--precision-target", type=float, default=0.88)
    validate = commands.add_parser("validate")
    validate.add_argument("--artifact", type=Path, required=True)
    quality = commands.add_parser("quality-gate")
    quality.add_argument("--artifact", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            record = build_calibration(
                finals_path=args.finals,
                master_manifest_path=args.master_manifest,
                catalog_registry_path=args.catalog_registry,
                runtime_dir=args.runtime_dir,
                coverage_target=args.coverage_target,
                precision_target=args.precision_target,
            )
            write_record(args.output, record, replace_existing=args.replace_existing)
            validate_calibration(record)
            result: Mapping[str, Any] = {
                "record_sha256": record["record_sha256"],
                "status": "valid_rank_preserving_confidence_calibration",
            }
        else:
            record = base._read_json(args.artifact, "rank-preserving calibration")  # noqa: SLF001
            result = (
                require_deployment_quality(record)
                if args.command == "quality-gate"
                else {
                    "record_sha256": validate_calibration(record)["record_sha256"],
                    "status": "valid_rank_preserving_confidence_calibration",
                }
            )
    except (RankPreservingCalibrationError, base.SelectionCalibrationError) as error:
        raise SystemExit(f"rank-preserving-calibration error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
