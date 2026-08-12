#!/usr/bin/env python3
"""Compare sealed role-family adapters on the immutable blind145 pool.

The comparison extracts the master-v3 query views once, runs every supplied
sealed adapter through the same production routing rule, and publishes only
aggregate acceptable/preferred/family evidence.  It is suitable for choosing
which candidate proceeds to QA40, not for deployment attachment.  Blind
evaluation rows 161..240 are never inputs.
"""

from __future__ import annotations

import argparse
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    import bind_manga_font_v2_blind_calibration_labels as bound
    import build_manga_font_student_v8_role_family_dataset as dataset_builder
    import evaluate_manga_font_student_v8_role_family as evaluator
    import export_manga_font_v2_blind_r3h_score_bundle as score_export
    import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - repository-root execution
    from scripts import bind_manga_font_v2_blind_calibration_labels as bound
    from scripts import build_manga_font_student_v8_role_family_dataset as dataset_builder
    from scripts import evaluate_manga_font_student_v8_role_family as evaluator
    from scripts import export_manga_font_v2_blind_r3h_score_bundle as score_export
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer


SCHEMA_VERSION = "manga-font-v2-blind145-role-family-adapter-comparison-v1"
RECORD_TYPE = "manga_font_v2_blind145_role_family_adapter_comparison"
EXPECTED_ROWS = 145


class BlindAdapterComparisonError(ValueError):
    """Raised when a candidate or comparison boundary drifts."""


def _parse_adapter_spec(value: str) -> tuple[str, Path]:
    label, separator, raw_path = value.partition("=")
    if not separator or not label.strip() or not raw_path.strip():
        raise argparse.ArgumentTypeError("adapter must use LABEL=PATH")
    return label.strip(), Path(raw_path.strip())


def _cohort_font_metrics(
    *,
    labels: list[bound.FitLabel],
    candidate_ids: list[str],
    deployed_scores: np.ndarray,
) -> dict[str, Any]:
    winners = deployed_scores.argmax(axis=1)
    groups = {
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
    result: dict[str, Any] = {}
    for name, indices in groups.items():
        acceptable = sum(
            candidate_ids[int(winners[index])] in labels[index].positive
            for index in indices
        )
        preferred = sum(
            candidate_ids[int(winners[index])] in labels[index].preferred
            for index in indices
        )
        result[name] = {
            "acceptable_at1": acceptable / len(indices),
            "preferred_at1": preferred / len(indices),
            "sample_count": len(indices),
        }
    result["top1_candidate_distribution"] = dict(
        sorted(Counter(candidate_ids[int(value)] for value in winners).items())
    )
    result["top1_max_candidate_share"] = max(
        result["top1_candidate_distribution"].values()
    ) / len(labels)
    result["top1_unique_candidate_count"] = len(
        result["top1_candidate_distribution"]
    )
    return result


def _adapter_result(
    *,
    label: str,
    adapter_dir: Path,
    labels: list[bound.FitLabel],
    candidate_ids: list[str],
    query_views: np.ndarray,
    prototypes: np.ndarray,
    device_name: str,
    batch_size: int,
) -> dict[str, Any]:
    manifest_path = adapter_dir / trainer.MANIFEST_FILE
    manifest = score_export._read_json(manifest_path, f"{label} adapter manifest")  # noqa: SLF001
    dataset_sha = str(
        score_export._mapping(  # noqa: SLF001
            manifest.get("dataset"), f"{label} adapter dataset"
        ).get("sha256")
    )
    try:
        torch, model, adapter = evaluator._load_adapter(  # noqa: SLF001
            adapter_dir,
            candidate_ids=candidate_ids,
            dataset_sha256=dataset_sha,
            device_name=device_name,
        )
        outputs = evaluator._infer(  # noqa: SLF001
            torch=torch,
            model=model,
            query_views=query_views,
            prototype_queries=prototypes,
            device_name=device_name,
            batch_size=batch_size,
        )
    except evaluator.MangaFontV8EvaluationError as error:
        raise BlindAdapterComparisonError(f"{label}: {error}") from error
    routed = evaluator._production_route(  # noqa: SLF001
        outputs, single_day_index=candidate_ids.index("single-day")
    )
    winners = routed["deployed_scores"].argmax(axis=1)
    single_day_index = candidate_ids.index("single-day")
    single_day_mask = winners == single_day_index
    single_day_positive = np.asarray(
        ["single-day" in item.positive for item in labels], dtype=bool
    )
    single_day_true = int(np.sum(single_day_mask & single_day_positive))
    single_day_top1 = int(single_day_mask.sum())
    family = score_export.evaluate_threshold(
        labels=labels,
        candidate_ids=candidate_ids,
        body_scores=outputs["body_candidate_scores"],
        variant_scores=outputs["variant_candidate_scores"],
        family_probabilities=routed["family_probabilities"],
        threshold=0.5,
    )
    return {
        "_winner_indices": winners,
        "adapter_checkpoint_sha256": adapter["checkpoint_sha256"],
        "adapter_manifest_record_sha256": adapter["manifest_record_sha256"],
        "adapter_manifest_sha256": adapter["manifest_sha256"],
        "adapter_schema_version": manifest["schema_version"],
        "family": family,
        "font": _cohort_font_metrics(
            labels=labels,
            candidate_ids=candidate_ids,
            deployed_scores=routed["deployed_scores"],
        ),
        "label": label,
        "raw_output_tensor_sha256": {
            name: score_export._sha256_array(outputs[name])  # noqa: SLF001
            for name in (
                "body_candidate_scores",
                "family_logits",
                "variant_candidate_scores",
            )
        },
        "single_day": {
            "allowed_by_route_count": int(routed["single_day_allowed"].sum()),
            "false_top1_count": single_day_top1 - single_day_true,
            "positive_label_count": int(single_day_positive.sum()),
            "precision": (
                single_day_true / single_day_top1 if single_day_top1 else 0.0
            ),
            "recall": (
                single_day_true / int(single_day_positive.sum())
                if single_day_positive.any()
                else 0.0
            ),
            "top1_count": single_day_top1,
            "top1_rate": single_day_top1 / len(labels),
            "true_top1_count": single_day_true,
        },
        "training_quality_gate_passed": adapter["training_quality_gate_passed"],
    }


def _selection_key(result: Mapping[str, Any]) -> tuple[float, ...]:
    font = result["font"]["global"]
    family = result["family"]
    return (
        round(float(font["preferred_at1"]), 12),
        round(float(font["acceptable_at1"]), 12),
        round(float(family["family_accuracy"]), 12),
        -round(float(result["font"]["top1_max_candidate_share"]), 12),
    )


def build_comparison(
    *,
    labels_dir: Path,
    hidden_cache_dir: Path,
    r5_source_dir: Path,
    adapters: list[tuple[str, Path]],
    baseline_label: str,
    output_dir: Path,
    device_name: str,
    batch_size: int,
) -> dict[str, Any]:
    target = output_dir.expanduser().resolve()
    if target.exists():
        raise BlindAdapterComparisonError("output directory already exists")
    labels, candidate_ids, label_report = bound._load_fit_labels(labels_dir)  # noqa: SLF001
    if len(labels) != EXPECTED_ROWS:
        raise BlindAdapterComparisonError("blind145 label count drift")
    labels_seen = [label for label, _path in adapters]
    if len(set(labels_seen)) != len(labels_seen) or baseline_label not in labels_seen:
        raise BlindAdapterComparisonError("adapter labels are duplicate or baseline is absent")
    cache_bindings, cache_manifest, cache_lineage = score_export._load_cache_bindings(  # noqa: SLF001
        cache_root=hidden_cache_dir, labels=labels
    )
    try:
        torch, query_head, prototypes, query_source = (
            dataset_builder._load_r5_head_and_prototypes(  # noqa: SLF001
                r5_source_dir, device_name=device_name
            )
        )
        if query_source.get("candidate_ids") != candidate_ids:
            raise BlindAdapterComparisonError("query candidate order drift")
        query_views = dataset_builder._extract_query_views(  # noqa: SLF001
            cache_root=hidden_cache_dir,
            cache_manifest=cache_manifest,
            bindings=cache_bindings,
            torch=torch,
            head=query_head,
            device_name=device_name,
            batch_size=batch_size,
        )
    except dataset_builder.V8RoleFamilyDatasetError as error:
        raise BlindAdapterComparisonError(str(error)) from error

    results = [
        _adapter_result(
            label=label,
            adapter_dir=adapter_dir.expanduser().resolve(),
            labels=labels,
            candidate_ids=candidate_ids,
            query_views=query_views,
            prototypes=prototypes,
            device_name=device_name,
            batch_size=batch_size,
        )
        for label, adapter_dir in adapters
    ]
    by_label = {str(result["label"]): result for result in results}
    baseline = by_label[baseline_label]
    baseline_font = baseline["font"]["global"]
    baseline_winners = baseline["_winner_indices"]
    for result in results:
        winners = result["_winner_indices"]
        changed = winners != baseline_winners
        preferred_gain = 0
        preferred_loss = 0
        acceptable_gain = 0
        acceptable_loss = 0
        for index in np.flatnonzero(changed).tolist():
            baseline_id = candidate_ids[int(baseline_winners[index])]
            candidate_id = candidate_ids[int(winners[index])]
            preferred_gain += int(
                baseline_id not in labels[index].preferred
                and candidate_id in labels[index].preferred
            )
            preferred_loss += int(
                baseline_id in labels[index].preferred
                and candidate_id not in labels[index].preferred
            )
            acceptable_gain += int(
                baseline_id not in labels[index].positive
                and candidate_id in labels[index].positive
            )
            acceptable_loss += int(
                baseline_id in labels[index].positive
                and candidate_id not in labels[index].positive
            )
        result["vs_baseline"] = {
            "acceptable_gain_row_count": acceptable_gain,
            "acceptable_loss_row_count": acceptable_loss,
            "changed_top1_row_count": int(changed.sum()),
            "exact_top1_agreement": float(np.mean(~changed)),
            "preferred_gain_row_count": preferred_gain,
            "preferred_loss_row_count": preferred_loss,
            "winner_sequence_sha256": bound.sha256_bytes(
                "".join(
                    f"{item.sample_id}\0{candidate_ids[int(winner)]}\n"
                    for item, winner in zip(labels, winners, strict=True)
                ).encode("utf-8")
            ),
        }
    baseline_family_accuracy = float(baseline["family"]["family_accuracy"])
    baseline_single_day_false = int(baseline["single_day"]["false_top1_count"])
    baseline_single_day_rate = float(baseline["single_day"]["top1_rate"])
    eligible = [
        result
        for result in results
        if float(result["font"]["global"]["preferred_at1"])
        >= float(baseline_font["preferred_at1"])
        and float(result["font"]["global"]["acceptable_at1"])
        >= float(baseline_font["acceptable_at1"])
        and float(result["family"]["family_accuracy"])
        >= baseline_family_accuracy
        and int(result["single_day"]["false_top1_count"])
        <= baseline_single_day_false
        and float(result["single_day"]["top1_rate"])
        <= baseline_single_day_rate
    ]
    selected = max(eligible, key=_selection_key) if eligible else baseline
    for result in results:
        result.pop("_winner_indices")
    table = [
        {
            "acceptable_at1": result["font"]["global"]["acceptable_at1"],
            "body_acceptable_at1": result["font"]["body"]["acceptable_at1"],
            "body_preferred_at1": result["font"]["body"]["preferred_at1"],
            "family_accuracy": result["family"]["family_accuracy"],
            "family_confusion": result["family"]["confusion"],
            "label": result["label"],
            "preferred_at1": result["font"]["global"]["preferred_at1"],
            "single_day_false_top1_count": result["single_day"]["false_top1_count"],
            "single_day_top1_count": result["single_day"]["top1_count"],
            "top1_max_candidate_share": result["font"]["top1_max_candidate_share"],
            "top1_rows_changed_vs_baseline": result["vs_baseline"]["changed_top1_row_count"],
            "preferred_gain_rows_vs_baseline": result["vs_baseline"]["preferred_gain_row_count"],
            "preferred_loss_rows_vs_baseline": result["vs_baseline"]["preferred_loss_row_count"],
            "acceptable_gain_rows_vs_baseline": result["vs_baseline"]["acceptable_gain_row_count"],
            "acceptable_loss_rows_vs_baseline": result["vs_baseline"]["acceptable_loss_row_count"],
            "variant_acceptable_at1": result["font"]["variant"]["acceptable_at1"],
            "variant_precision": result["family"]["variant_precision"],
            "variant_preferred_at1": result["font"]["variant"]["preferred_at1"],
            "variant_recall": result["family"]["variant_recall"],
        }
        for result in results
    ]
    report = bound.seal_record(
        {
            "adapters": results,
            "authority": {
                "automatic_model_training_human_promotion_allowed": False,
                "blind145_calibration_candidate_comparison_only": True,
                "deployment_attachment_allowed": False,
                "human_gold": False,
                "qa40_candidate_selection_authority": True,
                "training_eligible": False,
            },
            "bindings": {
                "calibration_labels_sha256": bound.sha256_file(
                    labels_dir / "calibration-labels.jsonl"
                ),
                "candidate_order_sha256": bound._candidate_order_sha(candidate_ids),  # noqa: SLF001
                "hidden_cache": cache_lineage,
                "immutable_label_report_record_sha256": label_report["record_sha256"],
                "query_source": query_source,
                "query_views_f16_sha256": score_export._sha256_array(query_views),  # noqa: SLF001
            },
            "boundary": {
                "blind_calibration_rows_used": len(labels),
                "blind_evaluation_rows_161_240_read": 0,
                "catalog_gap_rows_used": 0,
                "crop_reject_rows_used": 0,
                "optimizer_updates": 0,
                "per_sample_predictions_emitted": False,
            },
            "candidate_ids": candidate_ids,
            "comparison_table": table,
            "decision": {
                "baseline_label": baseline_label,
                "safety_gate": {
                    "acceptable_at1_not_below_baseline": True,
                    "family_accuracy_not_below_baseline": True,
                    "preferred_at1_not_below_baseline": True,
                    "single_day_false_top1_not_above_baseline": True,
                    "single_day_top1_rate_not_above_baseline": True,
                    "single_day_top1_rate_long_term_target_at_most": 0.01,
                },
                "safety_gate_eligible_labels": [result["label"] for result in eligible],
                "qa40_candidate_label": selected["label"],
                "selection_order": (
                    "preferred_at1_then_acceptable_at1_then_family_accuracy_then_diversity"
                ),
            },
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
    return validate_comparison(target)


def validate_comparison(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    if {path.name for path in root.iterdir()} != {"report.json"}:
        raise BlindAdapterComparisonError("comparison exact inventory drift")
    report = bound._read_json(root / "report.json", "adapter comparison report")  # noqa: SLF001
    bound.validate_record_seal(report, "adapter comparison report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != RECORD_TYPE
        or report.get("boundary", {}).get("blind_calibration_rows_used")
        != EXPECTED_ROWS
        or report.get("boundary", {}).get("blind_evaluation_rows_161_240_read")
        != 0
        or report.get("authority", {}).get("deployment_attachment_allowed")
        is not False
        or len(report.get("comparison_table", ())) < 1
    ):
        raise BlindAdapterComparisonError("comparison contract drift")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--labels-dir", type=Path, required=True)
    build.add_argument("--hidden-cache-dir", type=Path, required=True)
    build.add_argument("--r5-source-dir", type=Path, required=True)
    build.add_argument("--adapter", action="append", type=_parse_adapter_spec, required=True)
    build.add_argument("--baseline-label", required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    build.add_argument("--batch-size", type=int, default=64)
    validate = commands.add_parser("validate")
    validate.add_argument("--artifact-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            report = build_comparison(
                labels_dir=args.labels_dir.expanduser().resolve(),
                hidden_cache_dir=args.hidden_cache_dir.expanduser().resolve(),
                r5_source_dir=args.r5_source_dir.expanduser().resolve(),
                adapters=args.adapter,
                baseline_label=args.baseline_label,
                output_dir=args.output_dir,
                device_name=args.device,
                batch_size=args.batch_size,
            )
        else:
            report = validate_comparison(args.artifact_dir)
    except (
        BlindAdapterComparisonError,
        bound.BlindCalibrationBindingError,
        score_export.BlindR3HScoreError,
    ) as error:
        print(bound.canonical_json({"error": str(error), "status": "blocked"}))
        return 2
    print(
        bound.canonical_json(
            {
                "qa40_candidate_label": report["decision"]["qa40_candidate_label"],
                "record_sha256": report["record_sha256"],
                "status": "valid_blind145_adapter_comparison_only",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
