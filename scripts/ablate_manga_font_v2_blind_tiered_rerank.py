#!/usr/bin/env python3
"""Ablate a preferred-first tiered reranker on sealed blind145 r3h scores.

This is calibration evidence only.  It consumes the immutable 145-row blind
calibration labels and the already sealed production-r3h score bundle.  It
never reads the held-back blind evaluation rows 161..240 and never emits a
deployable model.  A candidate is allowed to replace raw top-1 only when its
cross-fitted preferred probability gains enough and its acceptable
probability passes a secondary safety gate.
"""

from __future__ import annotations

import argparse
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np

try:
    import bind_manga_font_v2_blind_calibration_labels as bound
    import export_manga_font_v2_blind_r3h_score_bundle as r3h_export
except ImportError:  # pragma: no cover - repository-root execution
    from scripts import bind_manga_font_v2_blind_calibration_labels as bound
    from scripts import export_manga_font_v2_blind_r3h_score_bundle as r3h_export


SCHEMA_VERSION = "manga-font-v2-blind-tiered-rerank-ablation-v1"
RECORD_TYPE = "manga_font_v2_blind_tiered_rerank_ablation_report"
EXPECTED_ROWS = 145
PREFERRED_MULTIPLIERS = (2.0, 3.0)
PREFERRED_GAIN_GRID = (0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3)
ACCEPTABLE_SLACK_GRID = (0.0, 0.025, 0.05, 0.075, 0.1)
ACCEPTABLE_FLOOR_GRID = (0.1, 0.25, 0.4, 0.55)


class TieredRerankAblationError(ValueError):
    """Raised when the sealed inputs or work-LOGO evidence drift."""


def _config_grid() -> list[dict[str, float]]:
    return [
        {
            "acceptable_floor": floor,
            "acceptable_slack": slack,
            "preferred_gain": gain,
            "preferred_positive_loss_multiplier": multiplier,
        }
        for multiplier in PREFERRED_MULTIPLIERS
        for gain in PREFERRED_GAIN_GRID
        for slack in ACCEPTABLE_SLACK_GRID
        for floor in ACCEPTABLE_FLOOR_GRID
    ]


def _preferred_labels(labels: list[bound.FitLabel]) -> list[bound.FitLabel]:
    return [replace(label, positive=label.preferred) for label in labels]


def _candidate_table(
    labels: list[bound.FitLabel],
    candidate_ids: list[str],
    scores: np.ndarray,
    *,
    positive_multiplier: float,
) -> bound.CandidateTable:
    table = bound.build_candidate_table(labels, candidate_ids, scores)
    weights = table.weights * np.where(
        table.labels == 1, float(positive_multiplier), 1.0
    )
    return bound.CandidateTable(
        features=table.features,
        labels=table.labels,
        weights=weights,
        sample_indices=table.sample_indices,
        candidate_indices=table.candidate_indices,
        feature_names=table.feature_names,
    )


def _matrix_from_prediction(
    table: bound.CandidateTable,
    prediction: np.ndarray,
    shape: tuple[int, int],
    *,
    row_indices: np.ndarray | None = None,
) -> np.ndarray:
    result = np.full(shape, np.nan, dtype=np.float64)
    rows = (
        np.arange(len(table.labels), dtype=np.int64)
        if row_indices is None
        else np.asarray(row_indices, dtype=np.int64)
    )
    if prediction.shape != (len(rows),):
        raise TieredRerankAblationError("candidate prediction shape drift")
    result[table.sample_indices[rows], table.candidate_indices[rows]] = prediction
    return result


def _outer_oof_matrix(
    table: bound.CandidateTable,
    model_labels: list[bound.FitLabel],
    shape: tuple[int, int],
) -> tuple[np.ndarray, list[dict[str, Any]], list[float]]:
    prediction, folds, selected_cs = bound._work_logo_predictions(  # noqa: SLF001
        table, model_labels, bound.DEFAULT_C_GRID
    )
    return (
        _matrix_from_prediction(table, prediction, shape),
        folds,
        [float(value) for value in selected_cs],
    )


def _nested_fold_matrices(
    *,
    table: bound.CandidateTable,
    model_labels: list[bound.FitLabel],
    all_labels: list[bound.FitLabel],
    held_work: str,
    shape: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray, float]:
    test_rows = np.asarray(
        [
            row_index
            for row_index, sample_index in enumerate(table.sample_indices)
            if all_labels[int(sample_index)].work_token == held_work
        ],
        dtype=np.int64,
    )
    test_set = set(test_rows.tolist())
    train_rows = np.asarray(
        [row_index for row_index in range(len(table.labels)) if row_index not in test_set],
        dtype=np.int64,
    )
    selected_c = float(
        bound._select_C(  # noqa: SLF001
            train_rows, table, model_labels, bound.DEFAULT_C_GRID
        )
    )
    outer_prediction, _, _, _ = bound._fit_predict(  # noqa: SLF001
        train_rows, test_rows, table, selected_c
    )
    outer = _matrix_from_prediction(
        table, outer_prediction, shape, row_indices=test_rows
    )

    inner = np.full(shape, np.nan, dtype=np.float64)
    training_works = sorted(
        {
            all_labels[int(table.sample_indices[row_index])].work_token
            for row_index in train_rows
        }
    )
    if len(training_works) != 2:
        raise TieredRerankAblationError("nested gate selection requires two train works")
    for inner_held in training_works:
        inner_test = np.asarray(
            [
                row_index
                for row_index in train_rows
                if all_labels[int(table.sample_indices[row_index])].work_token
                == inner_held
            ],
            dtype=np.int64,
        )
        inner_train = np.asarray(
            [
                row_index
                for row_index in train_rows
                if all_labels[int(table.sample_indices[row_index])].work_token
                != inner_held
            ],
            dtype=np.int64,
        )
        prediction, _, _, _ = bound._fit_predict(  # noqa: SLF001
            inner_train, inner_test, table, selected_c
        )
        inner[
            table.sample_indices[inner_test], table.candidate_indices[inner_test]
        ] = prediction
    return inner, outer, selected_c


def _apply_gate(
    *,
    scores: np.ndarray,
    preferred_probability: np.ndarray,
    acceptable_probability: np.ndarray,
    sample_indices: list[int],
    config: dict[str, float] | None,
) -> np.ndarray:
    raw_winners = scores.argmax(axis=1)
    if config is None:
        return raw_winners[np.asarray(sample_indices, dtype=np.int64)].copy()
    winners: list[int] = []
    for sample_index in sample_indices:
        raw_order = np.argsort(-scores[sample_index], kind="stable")[:3].tolist()
        if any(
            not np.isfinite(preferred_probability[sample_index, candidate_index])
            or not np.isfinite(acceptable_probability[sample_index, candidate_index])
            for candidate_index in raw_order
        ):
            raise TieredRerankAblationError(
                "raw top-three lacks a cross-fitted candidate prediction"
            )
        raw_winner = int(raw_order[0])
        proposed = max(
            raw_order,
            key=lambda candidate_index: (
                preferred_probability[sample_index, candidate_index],
                acceptable_probability[sample_index, candidate_index],
                -raw_order.index(candidate_index),
            ),
        )
        preferred_gain = (
            preferred_probability[sample_index, proposed]
            - preferred_probability[sample_index, raw_winner]
        )
        acceptable_safe = acceptable_probability[sample_index, proposed] >= (
            acceptable_probability[sample_index, raw_winner]
            - config["acceptable_slack"]
        )
        acceptable_floor = (
            acceptable_probability[sample_index, proposed]
            >= config["acceptable_floor"]
        )
        allowed = (
            preferred_gain >= config["preferred_gain"]
            and acceptable_safe
            and acceptable_floor
        )
        winners.append(int(proposed if allowed else raw_winner))
    return np.asarray(winners, dtype=np.int64)


def _metrics(
    *,
    labels: list[bound.FitLabel],
    candidate_ids: list[str],
    raw_winners: np.ndarray,
    sample_indices: list[int],
    winners: np.ndarray,
) -> dict[str, Any]:
    if winners.shape != (len(sample_indices),):
        raise TieredRerankAblationError("winner shape drift")
    acceptable = 0
    preferred = 0
    changed = 0
    for position, sample_index in enumerate(sample_indices):
        candidate_id = candidate_ids[int(winners[position])]
        label = labels[sample_index]
        acceptable += int(candidate_id in label.positive)
        preferred += int(candidate_id in label.preferred)
        changed += int(int(winners[position]) != int(raw_winners[sample_index]))
    count = len(sample_indices)
    return {
        "acceptable_at1": acceptable / count,
        "changed_raw_top1_count": changed,
        "exact_raw_top1_agreement": (count - changed) / count,
        "preferred_at1": preferred / count,
        "sample_count": count,
    }


def _cohort_metrics(
    *,
    labels: list[bound.FitLabel],
    candidate_ids: list[str],
    raw_winners: np.ndarray,
    winners: np.ndarray,
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    groups: dict[str, list[int]] = {
        "body": [
            index for index, label in enumerate(labels) if label.role in bound.BODY_ROLES
        ],
        "global": list(range(len(labels))),
        "variant": [
            index
            for index, label in enumerate(labels)
            if label.role not in bound.BODY_ROLES
        ],
    }
    for work in sorted({label.work_token for label in labels}):
        groups[f"work::{work}"] = [
            index for index, label in enumerate(labels) if label.work_token == work
        ]
    for name, sample_indices in groups.items():
        result[name] = _metrics(
            labels=labels,
            candidate_ids=candidate_ids,
            raw_winners=raw_winners,
            sample_indices=sample_indices,
            winners=winners[np.asarray(sample_indices, dtype=np.int64)],
        )
    return result


def _selection_key(row: dict[str, Any]) -> tuple[float, ...]:
    metrics = row["metrics"]
    config = row["config"]
    return (
        round(float(metrics["preferred_at1"]), 12),
        round(float(metrics["acceptable_at1"]), 12),
        -float(metrics["changed_raw_top1_count"]),
        float(config["preferred_gain"]),
        -float(config["acceptable_slack"]),
        float(config["acceptable_floor"]),
        -float(config["preferred_positive_loss_multiplier"]),
    )


def _eligible(metrics: dict[str, Any], baseline: dict[str, Any]) -> bool:
    return (
        float(metrics["preferred_at1"]) >= float(baseline["preferred_at1"])
        and float(metrics["acceptable_at1"]) >= float(baseline["acceptable_at1"])
    )


def build_ablation(
    *, labels_dir: Path, r3h_bundle_dir: Path, output_dir: Path
) -> dict[str, Any]:
    target = output_dir.expanduser().resolve()
    if target.exists():
        raise TieredRerankAblationError("output directory already exists")
    r3h_report = r3h_export.validate_bundle(r3h_bundle_dir)
    labels, candidate_ids, label_report = bound._load_fit_labels(labels_dir)  # noqa: SLF001
    if len(labels) != EXPECTED_ROWS or any(label.unrenderable for label in labels):
        raise TieredRerankAblationError(
            "blind145 count drifted or contains unsupported per-row renderability"
        )
    score_matrix, score_manifest = bound._load_scores(  # noqa: SLF001
        score_manifest_path=r3h_bundle_dir / "score-manifest.json",
        scores_path=r3h_bundle_dir / "production-routed-scores.jsonl",
        labels_path=labels_dir / "calibration-labels.jsonl",
        active_catalog_sha256=str(label_report["bindings"]["active_catalog_sha256"]),
        candidate_ids=candidate_ids,
        expected_sample_ids=[label.sample_id for label in labels],
    )
    raw_winners = score_matrix.argmax(axis=1)
    all_indices = list(range(len(labels)))
    baseline_winners = raw_winners.copy()
    baseline = _cohort_metrics(
        labels=labels,
        candidate_ids=candidate_ids,
        raw_winners=raw_winners,
        winners=baseline_winners,
    )

    acceptable_table = _candidate_table(
        labels, candidate_ids, score_matrix, positive_multiplier=1.0
    )
    acceptable_oof, acceptable_folds, acceptable_cs = _outer_oof_matrix(
        acceptable_table, labels, score_matrix.shape
    )
    preferred_model_labels = _preferred_labels(labels)
    preferred_tables = {
        multiplier: _candidate_table(
            preferred_model_labels,
            candidate_ids,
            score_matrix,
            positive_multiplier=multiplier,
        )
        for multiplier in PREFERRED_MULTIPLIERS
    }
    preferred_oof: dict[float, np.ndarray] = {}
    preferred_fit: dict[str, Any] = {}
    for multiplier, table in preferred_tables.items():
        prediction, folds, selected_cs = _outer_oof_matrix(
            table, preferred_model_labels, score_matrix.shape
        )
        preferred_oof[multiplier] = prediction
        preferred_fit[str(multiplier)] = {
            "folds": folds,
            "selected_C_values": selected_cs,
        }

    fixed_rows: list[dict[str, Any]] = []
    baseline_global = baseline["global"]
    for config in _config_grid():
        multiplier = float(config["preferred_positive_loss_multiplier"])
        winners = _apply_gate(
            scores=score_matrix,
            preferred_probability=preferred_oof[multiplier],
            acceptable_probability=acceptable_oof,
            sample_indices=all_indices,
            config=config,
        )
        metrics = _metrics(
            labels=labels,
            candidate_ids=candidate_ids,
            raw_winners=raw_winners,
            sample_indices=all_indices,
            winners=winners,
        )
        fixed_rows.append(
            {"config": config, "eligible": _eligible(metrics, baseline_global), "metrics": metrics}
        )
    fixed_eligible = [row for row in fixed_rows if row["eligible"]]
    fixed_selected = max(fixed_eligible, key=_selection_key) if fixed_eligible else None

    works = sorted({label.work_token for label in labels})
    nested_winners = raw_winners.copy()
    nested_folds: list[dict[str, Any]] = []
    for held_work in works:
        train_indices = [
            index for index, label in enumerate(labels) if label.work_token != held_work
        ]
        test_indices = [
            index for index, label in enumerate(labels) if label.work_token == held_work
        ]
        acceptable_inner, acceptable_outer, acceptable_c = _nested_fold_matrices(
            table=acceptable_table,
            model_labels=labels,
            all_labels=labels,
            held_work=held_work,
            shape=score_matrix.shape,
        )
        preferred_inner: dict[float, np.ndarray] = {}
        preferred_outer: dict[float, np.ndarray] = {}
        preferred_cs: dict[str, float] = {}
        for multiplier, table in preferred_tables.items():
            inner, outer, selected_c = _nested_fold_matrices(
                table=table,
                model_labels=preferred_model_labels,
                all_labels=labels,
                held_work=held_work,
                shape=score_matrix.shape,
            )
            preferred_inner[multiplier] = inner
            preferred_outer[multiplier] = outer
            preferred_cs[str(multiplier)] = selected_c
        train_baseline = _metrics(
            labels=labels,
            candidate_ids=candidate_ids,
            raw_winners=raw_winners,
            sample_indices=train_indices,
            winners=raw_winners[np.asarray(train_indices, dtype=np.int64)],
        )
        eligible_configs: list[dict[str, Any]] = []
        for config in _config_grid():
            multiplier = float(config["preferred_positive_loss_multiplier"])
            train_winners = _apply_gate(
                scores=score_matrix,
                preferred_probability=preferred_inner[multiplier],
                acceptable_probability=acceptable_inner,
                sample_indices=train_indices,
                config=config,
            )
            metrics = _metrics(
                labels=labels,
                candidate_ids=candidate_ids,
                raw_winners=raw_winners,
                sample_indices=train_indices,
                winners=train_winners,
            )
            if _eligible(metrics, train_baseline):
                eligible_configs.append(
                    {"config": config, "eligible": True, "metrics": metrics}
                )
        selected = (
            max(eligible_configs, key=_selection_key) if eligible_configs else None
        )
        selected_config = selected["config"] if selected is not None else None
        if selected_config is None:
            test_winners = raw_winners[np.asarray(test_indices, dtype=np.int64)].copy()
        else:
            multiplier = float(
                selected_config["preferred_positive_loss_multiplier"]
            )
            test_winners = _apply_gate(
                scores=score_matrix,
                preferred_probability=preferred_outer[multiplier],
                acceptable_probability=acceptable_outer,
                sample_indices=test_indices,
                config=selected_config,
            )
        nested_winners[np.asarray(test_indices, dtype=np.int64)] = test_winners
        holdout_baseline = _metrics(
            labels=labels,
            candidate_ids=candidate_ids,
            raw_winners=raw_winners,
            sample_indices=test_indices,
            winners=raw_winners[np.asarray(test_indices, dtype=np.int64)],
        )
        holdout_metrics = _metrics(
            labels=labels,
            candidate_ids=candidate_ids,
            raw_winners=raw_winners,
            sample_indices=test_indices,
            winners=test_winners,
        )
        nested_folds.append(
            {
                "acceptable_C": acceptable_c,
                "eligible_training_config_count": len(eligible_configs),
                "held_out_work_token": held_work,
                "holdout_baseline": holdout_baseline,
                "holdout_metrics": holdout_metrics,
                "preferred_C_by_multiplier": preferred_cs,
                "selected_config": selected_config,
                "training_baseline": train_baseline,
                "training_selected_metrics": (
                    selected["metrics"] if selected is not None else train_baseline
                ),
            }
        )
    nested = _cohort_metrics(
        labels=labels,
        candidate_ids=candidate_ids,
        raw_winners=raw_winners,
        winners=nested_winners,
    )
    nested_passed = _eligible(nested["global"], baseline_global)

    family_evidence = bound._read_json(  # noqa: SLF001
        r3h_bundle_dir / "family-threshold-evidence.json", "family evidence"
    )
    selected_family = family_evidence["final_threshold_selection"]["selected"]
    family_threshold_safe = (
        float(selected_family["acceptable_at1"])
        >= float(baseline_global["acceptable_at1"])
        and float(selected_family["preferred_at1"])
        >= float(baseline_global["preferred_at1"])
    )
    existing_calibration = r3h_report["font_metrics"]["calibrated_nested_oof"]
    existing_calibration_safe = (
        float(existing_calibration["acceptable_at1"])
        >= float(baseline_global["acceptable_at1"])
        and float(existing_calibration["preferred_at1"])
        >= float(baseline_global["preferred_at1"])
    )
    report = bound.seal_record(
        {
            "authority": {
                "automatic_model_training_human_promotion_allowed": False,
                "calibration_fit_only": True,
                "deployment_attachment_allowed": False,
                "human_gold": False,
                "training_eligible": False,
            },
            "bindings": {
                "calibration_labels_sha256": bound.sha256_file(
                    labels_dir / "calibration-labels.jsonl"
                ),
                "candidate_order_sha256": bound._candidate_order_sha(candidate_ids),  # noqa: SLF001
                "family_evidence_record_sha256": family_evidence["record_sha256"],
                "production_r3h_report_record_sha256": r3h_report["record_sha256"],
                "production_routed_scores_sha256": bound.sha256_file(
                    r3h_bundle_dir / "production-routed-scores.jsonl"
                ),
                "score_manifest_record_sha256": score_manifest["record_sha256"],
            },
            "boundary": {
                "blind_calibration_rows_used": len(labels),
                "blind_evaluation_rows_161_240_read": 0,
                "catalog_gap_rows_used": 0,
                "crop_reject_rows_used": 0,
                "optimizer_updates_to_r3h": 0,
                "per_sample_winners_emitted": False,
            },
            "candidate_ids": candidate_ids,
            "decision": {
                "existing_acceptable_only_calibration_safe": existing_calibration_safe,
                "family_threshold_change_allowed": family_threshold_safe,
                "nested_tiered_gate_passed_dual_floor": nested_passed,
                "production_action": "retain_raw_r3h_route",
                "reason": (
                    "nested_work_LOGO_preferred_or_acceptable_below_raw_baseline"
                    if not nested_passed
                    else "calibration_only_evidence_requires_independent_QA_before_attachment"
                ),
                "tiered_reranker_attachment_allowed": False,
            },
            "existing_acceptable_only_calibration": existing_calibration,
            "family_threshold_ablation": {
                "dual_floor_passed": family_threshold_safe,
                "selected_threshold": selected_family["threshold"],
                "selected_threshold_metrics": selected_family,
            },
            "feature_contract": {
                "acceptable_target": "inclusive_acceptable_secondary_safety_gate",
                "candidate_scope": "raw_production_route_top3",
                "gold_role_used_as_feature": False,
                "pairwise_gate": "proposed_preferred_probability_minus_raw_top1_preferred_probability",
                "preferred_positive_loss_multipliers": list(PREFERRED_MULTIPLIERS),
                "preferred_target": "preferred_primary",
                "raw_fallback": True,
            },
            "fixed_grid_outer_oof": {
                "config_count": len(fixed_rows),
                "eligible_config_count": len(fixed_eligible),
                "selected": fixed_selected,
                "selection_optimism_warning": (
                    "config selected on the same cross-fitted calibration predictions; "
                    "nested_work_LOGO is the decision authority"
                ),
            },
            "model_fit": {
                "acceptable": {
                    "folds": acceptable_folds,
                    "selected_C_values": acceptable_cs,
                },
                "preferred": preferred_fit,
            },
            "nested_work_logo": {
                "decision_authority": True,
                "dual_floor_passed": nested_passed,
                "folds": nested_folds,
                "metrics": nested,
            },
            "raw_baseline": baseline,
            "record_type": RECORD_TYPE,
            "schema_version": SCHEMA_VERSION,
        }
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}.", dir=target.parent) as temp:
        staging = Path(temp) / target.name
        staging.mkdir()
        (staging / "report.json").write_bytes(bound.json_bytes(report, pretty=True))
        staging.replace(target)
    return validate_ablation(target)


def validate_ablation(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    if {path.name for path in root.iterdir()} != {"report.json"}:
        raise TieredRerankAblationError("tiered ablation exact inventory drift")
    report = bound._read_json(root / "report.json", "tiered ablation report")  # noqa: SLF001
    bound.validate_record_seal(report, "tiered ablation report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != RECORD_TYPE
        or report.get("candidate_ids") is None
        or report.get("boundary", {}).get("blind_calibration_rows_used")
        != EXPECTED_ROWS
        or report.get("boundary", {}).get("blind_evaluation_rows_161_240_read")
        != 0
        or report.get("authority", {}).get("deployment_attachment_allowed")
        is not False
        or report.get("decision", {}).get("production_action")
        != "retain_raw_r3h_route"
    ):
        raise TieredRerankAblationError("tiered ablation contract drift")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--labels-dir", type=Path, required=True)
    build.add_argument("--r3h-bundle-dir", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--artifact-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            report = build_ablation(
                labels_dir=args.labels_dir.expanduser().resolve(),
                r3h_bundle_dir=args.r3h_bundle_dir.expanduser().resolve(),
                output_dir=args.output_dir,
            )
        else:
            report = validate_ablation(args.artifact_dir)
    except (
        TieredRerankAblationError,
        bound.BlindCalibrationBindingError,
        r3h_export.BlindR3HScoreError,
    ) as error:
        print(bound.canonical_json({"error": str(error), "status": "blocked"}))
        return 2
    print(
        bound.canonical_json(
            {
                "production_action": report["decision"]["production_action"],
                "record_sha256": report["record_sha256"],
                "status": "valid_blind145_tiered_ablation_calibration_only",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
