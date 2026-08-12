#!/usr/bin/env python3
"""Export sealed r3h scores for the immutable blind145 calibration labels.

The exporter joins only the 145 sample IDs already present in the immutable
calibration-label artifact.  It reads their master-v3 hidden-cache rows,
reconstructs the sealed production-r3h adapter, writes body/variant/family
outputs, mirrors the current production route, and runs the separate 3-work
LOGO score calibrator.  Blind-pool evaluation rows 161..240 are not inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import bind_manga_font_v2_blind_calibration_labels as bound
    import build_manga_font_student_v8_role_family_dataset as dataset_builder
    import evaluate_manga_font_student_v8_role_family as evaluator
    import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - repository-root execution
    from scripts import bind_manga_font_v2_blind_calibration_labels as bound
    from scripts import build_manga_font_student_v8_role_family_dataset as dataset_builder
    from scripts import evaluate_manga_font_student_v8_role_family as evaluator
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer


SCHEMA_VERSION = "manga-font-v2-blind-r3h-production-route-evidence-v1"
REPORT_RECORD = "manga_font_v2_blind_r3h_production_route_report"
RAW_ROW_SCHEMA = "manga-font-v2-blind-r3h-raw-score-row-v1"
RAW_ROW_RECORD = "manga_font_v2_blind_r3h_raw_score_row"
EVIDENCE_RECORD = "manga_font_v2_blind_r3h_family_threshold_evidence"
EXPECTED_ROWS = 145
THRESHOLDS = tuple(round(value / 100.0, 2) for value in range(50, 96, 5))
SELECTION_BETA = 0.5
BODY = trainer.BODY_FAMILY_INDEX
VARIANT = trainer.VARIANT_FAMILY_INDEX


class BlindR3HScoreError(ValueError):
    """Raised when hidden-cache, r3h, or blind-label lineage drifts."""


@dataclass(frozen=True)
class CacheBinding:
    cache_index: int
    sample_id: str
    split: str
    work_id: str
    record_sha256: str


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise BlindR3HScoreError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BlindR3HScoreError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _sha256_file(path: Path) -> str:
    return bound.sha256_file(path)


def _sha256_array(value: np.ndarray) -> str:
    contiguous = np.ascontiguousarray(value)
    return hashlib.sha256(contiguous.tobytes()).hexdigest()


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes(
        "".join(bound.canonical_json(row) + "\n" for row in rows).encode("utf-8")
    )


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": _sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _load_cache_bindings(
    *, cache_root: Path, labels: Sequence[bound.FitLabel]
) -> tuple[list[CacheBinding], dict[str, Any], dict[str, Any]]:
    manifest_path = cache_root / "manifest.json"
    contract_path = cache_root / "build-contract.json"
    index_path = cache_root / "sample-index.jsonl"
    manifest = _read_json(manifest_path, "hidden-cache manifest")
    contract = _read_json(contract_path, "hidden-cache contract")
    bound.validate_record_seal(manifest, "hidden-cache manifest")
    bound.validate_record_seal(contract, "hidden-cache contract")
    index = _mapping(manifest.get("index"), "hidden-cache index")
    if (
        manifest.get("record_type") != "manga_font_master_v3_siglip2_hidden_cache"
        or contract.get("record_type")
        != "manga_font_master_v3_siglip2_hidden_cache_build_contract"
        or manifest.get("build_contract_record_sha256") != contract.get("record_sha256")
        or index.get("record_count") != 28094
        or index.get("sha256") != _sha256_file(index_path)
        or contract.get("sample_index_sha256") != index.get("sha256")
    ):
        raise BlindR3HScoreError("hidden-cache root lineage drift")
    required = {label.sample_id for label in labels}
    selected: dict[str, CacheBinding] = {}
    try:
        with index_path.open(encoding="utf-8") as handle:
            for line_number, raw in enumerate(handle, 1):
                try:
                    row = _mapping(json.loads(raw), f"hidden index:{line_number}")
                except json.JSONDecodeError as error:
                    raise BlindR3HScoreError("hidden-cache sample index invalid") from error
                sample_id = str(row.get("sample_id", ""))
                if sample_id not in required:
                    continue
                bound.validate_record_seal(row, f"hidden index:{line_number}")
                if sample_id in selected or row.get("split") != "test":
                    raise BlindR3HScoreError("blind145 cache identity/split drift")
                selected[sample_id] = CacheBinding(
                    cache_index=int(row.get("cache_index", -1)),
                    sample_id=sample_id,
                    split=str(row.get("split")),
                    work_id=str(row.get("work_id")),
                    record_sha256=str(row.get("record_sha256")),
                )
    except OSError as error:
        raise BlindR3HScoreError("hidden-cache sample index unavailable") from error
    if set(selected) != required or len(selected) != EXPECTED_ROWS:
        raise BlindR3HScoreError("hidden-cache does not cover exactly blind145")
    ordered = [selected[label.sample_id] for label in labels]

    opaque_to_source: dict[str, set[str]] = defaultdict(set)
    source_to_opaque: dict[str, set[str]] = defaultdict(set)
    for label, binding in zip(labels, ordered, strict=True):
        opaque_to_source[label.work_token].add(binding.work_id)
        source_to_opaque[binding.work_id].add(label.work_token)
    if (
        len(opaque_to_source) != 3
        or len(source_to_opaque) != 3
        or any(len(values) != 1 for values in opaque_to_source.values())
        or any(len(values) != 1 for values in source_to_opaque.values())
    ):
        raise BlindR3HScoreError("opaque/source work grouping drift")

    descriptors = tuple(_mapping(row, "hidden shard") for row in manifest.get("shards", ()))
    selected_ordinals = sorted({binding.cache_index // 128 for binding in ordered})
    selected_seals: list[str] = []
    for ordinal in selected_ordinals:
        descriptor = descriptors[ordinal]
        if (
            int(descriptor.get("shard_ordinal", -1)) != ordinal
            or int(descriptor.get("start_cache_index", -1)) != ordinal * 128
        ):
            raise BlindR3HScoreError("selected hidden shard descriptor drift")
        directory = cache_root / "shards" / str(descriptor.get("directory"))
        seal = _read_json(directory / "seal.json", f"hidden shard {ordinal} seal")
        bound.validate_record_seal(seal, f"hidden shard {ordinal} seal")
        if seal.get("record_sha256") != descriptor.get("seal_record_sha256"):
            raise BlindR3HScoreError("selected hidden shard seal lineage drift")
        selected_seals.append(str(seal["record_sha256"]))
    selected_binding_sha = hashlib.sha256(
        "".join(
            f"{binding.sample_id}\0{binding.cache_index}\0{binding.record_sha256}\n"
            for binding in ordered
        ).encode("utf-8")
    ).hexdigest()
    work_groups = [
        {
            "opaque_work_token": opaque,
            "sample_count": sum(label.work_token == opaque for label in labels),
            "source_work_id_sha256": hashlib.sha256(
                next(iter(source_ids)).encode("utf-8")
            ).hexdigest(),
        }
        for opaque, source_ids in sorted(opaque_to_source.items())
    ]
    lineage = {
        "build_contract_record_sha256": contract["record_sha256"],
        "build_contract_sha256": _sha256_file(contract_path),
        "cache_identity_sha256": contract["cache_identity_sha256"],
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": _sha256_file(manifest_path),
        "sample_index_sha256": index["sha256"],
        "selected_binding_sha256": selected_binding_sha,
        "selected_row_count": len(ordered),
        "selected_shard_count": len(selected_ordinals),
        "selected_shard_seals_sha256": hashlib.sha256(
            ("\n".join(selected_seals) + "\n").encode("utf-8")
        ).hexdigest(),
        "selected_split": "test_calibration_fit_only",
        "work_groups": work_groups,
    }
    return ordered, manifest, lineage


def _validate_runtime_lineage(
    *,
    runtime_dir: Path,
    graph_report_path: Path,
    adapter: Mapping[str, Any],
    candidate_ids: Sequence[str],
    active_catalog_sha256: str,
) -> dict[str, str]:
    contract_path = runtime_dir / "runtime-contract.json"
    catalog_path = runtime_dir / "auto-match-active-catalog.json"
    encoder_path = runtime_dir / "encoder.onnx"
    ranker_path = runtime_dir / "ranker.onnx"
    contract = _read_json(contract_path, "r3h runtime contract")
    graph = _read_json(graph_report_path, "r3h graph report")
    bound.validate_record_seal(contract, "r3h runtime contract")
    bound.validate_record_seal(graph, "r3h graph report")
    graph_artifacts = _mapping(graph.get("artifacts"), "graph artifacts")
    graph_inputs = _mapping(graph.get("inputs"), "graph inputs")
    encoder_sha = _sha256_file(encoder_path)
    ranker_sha = _sha256_file(ranker_path)
    catalog_sha = _sha256_file(catalog_path)
    if (
        graph.get("candidate_ids") != list(candidate_ids)
        or catalog_sha != active_catalog_sha256
        or _mapping(graph_artifacts.get("encoder.onnx"), "graph encoder").get("sha256")
        != encoder_sha
        or _mapping(graph_artifacts.get("ranker.onnx"), "graph ranker").get("sha256")
        != ranker_sha
        or _mapping(
            graph_artifacts.get("auto-match-active-catalog.json"), "graph catalog"
        ).get("sha256")
        != catalog_sha
        or graph_inputs.get("adapter_checkpoint_sha256")
        != adapter["checkpoint_sha256"]
        or graph_inputs.get("adapter_manifest_sha256") != adapter["manifest_sha256"]
    ):
        raise BlindR3HScoreError("r3h PyTorch/ONNX runtime lineage drift")
    return {
        "active_catalog_sha256": catalog_sha,
        "encoder_onnx_sha256": encoder_sha,
        "graph_report_record_sha256": str(graph["record_sha256"]),
        "graph_report_sha256": _sha256_file(graph_report_path),
        "ranker_onnx_sha256": ranker_sha,
        "runtime_contract_record_sha256": str(contract["record_sha256"]),
        "runtime_contract_sha256": _sha256_file(contract_path),
    }


def _family_truth(labels: Sequence[bound.FitLabel]) -> np.ndarray:
    return np.asarray(
        [BODY if label.role in bound.BODY_ROLES else VARIANT for label in labels],
        dtype=np.int64,
    )


def _safe_ratio(numerator: int, denominator: int) -> float:
    return float(numerator / denominator) if denominator else 0.0


def _f_beta(precision: float, recall: float, beta: float) -> float:
    beta2 = beta * beta
    denominator = beta2 * precision + recall
    return (1.0 + beta2) * precision * recall / denominator if denominator else 0.0


def evaluate_threshold(
    *,
    labels: Sequence[bound.FitLabel],
    candidate_ids: Sequence[str],
    body_scores: np.ndarray,
    variant_scores: np.ndarray,
    family_probabilities: np.ndarray,
    threshold: float | np.ndarray,
    indices: np.ndarray | None = None,
) -> dict[str, Any]:
    selected_indices = (
        np.arange(len(labels), dtype=np.int64) if indices is None else np.asarray(indices)
    )
    truth = _family_truth(labels)[selected_indices]
    probability = family_probabilities[selected_indices, VARIANT]
    threshold_values = np.asarray(threshold, dtype=np.float64)
    if threshold_values.ndim == 0:
        threshold_values = np.full(len(selected_indices), float(threshold_values))
    elif threshold_values.shape != (len(selected_indices),):
        raise BlindR3HScoreError("threshold vector shape drift")
    predicted = np.where(probability >= threshold_values, VARIANT, BODY)
    tp = int(np.sum((predicted == VARIANT) & (truth == VARIANT)))
    fp = int(np.sum((predicted == VARIANT) & (truth == BODY)))
    fn = int(np.sum((predicted == BODY) & (truth == VARIANT)))
    tn = int(np.sum((predicted == BODY) & (truth == BODY)))
    variant_precision = _safe_ratio(tp, tp + fp)
    variant_recall = _safe_ratio(tp, tp + fn)
    body_precision = _safe_ratio(tn, tn + fn)
    body_recall = _safe_ratio(tn, tn + fp)

    selected_scores = np.where(
        (predicted == VARIANT)[:, None],
        variant_scores[selected_indices],
        body_scores[selected_indices],
    ).astype(np.float32, copy=True)
    single_day_index = candidate_ids.index("single-day")
    competitor = selected_scores.copy()
    competitor[:, single_day_index] = -np.inf
    raw_margin = selected_scores[:, single_day_index] - competitor.max(axis=1)
    single_day_allowed = (
        (predicted == VARIANT)
        & (probability >= trainer.MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE)
        & (raw_margin >= trainer.MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN)
    )
    minimum = selected_scores.copy()
    minimum[:, single_day_index] = np.inf
    minimum_competitor = minimum.min(axis=1)
    selected_scores[~single_day_allowed, single_day_index] = (
        minimum_competitor[~single_day_allowed] - 1.0
    )
    top1 = selected_scores.argmax(axis=1)
    acceptable = 0
    preferred = 0
    for position, label_index in enumerate(selected_indices.tolist()):
        candidate_id = str(candidate_ids[int(top1[position])])
        acceptable += int(candidate_id in labels[label_index].positive)
        preferred += int(candidate_id in labels[label_index].preferred)
    count = len(selected_indices)
    return {
        "acceptable_at1": _safe_ratio(acceptable, count),
        "body_precision": body_precision,
        "body_recall": body_recall,
        "confusion": {"body_as_body": tn, "body_as_variant": fp, "variant_as_body": fn, "variant_as_variant": tp},
        "family_accuracy": _safe_ratio(tp + tn, count),
        "preferred_at1": _safe_ratio(preferred, count),
        "sample_count": count,
        "single_day_allowed_count": int(single_day_allowed.sum()),
        "variant_f0_5": _f_beta(variant_precision, variant_recall, SELECTION_BETA),
        "variant_precision": variant_precision,
        "variant_recall": variant_recall,
        "variant_routed_count": int(np.sum(predicted == VARIANT)),
    }


def _threshold_key(row: Mapping[str, Any]) -> tuple[float, ...]:
    return (
        round(float(row["variant_f0_5"]), 12),
        round(float(row["acceptable_at1"]), 12),
        round(float(row["preferred_at1"]), 12),
        round(float(row["variant_recall"]), 12),
        -float(row["threshold"]),
    )


def build_threshold_evidence(
    *,
    labels: Sequence[bound.FitLabel],
    candidate_ids: Sequence[str],
    outputs: Mapping[str, np.ndarray],
) -> dict[str, Any]:
    family_probabilities = evaluator._softmax(outputs["family_logits"])  # noqa: SLF001
    sweep: list[dict[str, Any]] = []
    for threshold in THRESHOLDS:
        row = evaluate_threshold(
            labels=labels,
            candidate_ids=candidate_ids,
            body_scores=outputs["body_candidate_scores"],
            variant_scores=outputs["variant_candidate_scores"],
            family_probabilities=family_probabilities,
            threshold=threshold,
        )
        sweep.append({"threshold": threshold, **row})
    selected = max(sweep, key=_threshold_key)

    work_values = sorted({label.work_token for label in labels})
    oof_thresholds = np.empty(len(labels), dtype=np.float64)
    folds: list[dict[str, Any]] = []
    for work in work_values:
        train_indices = np.asarray(
            [index for index, label in enumerate(labels) if label.work_token != work],
            dtype=np.int64,
        )
        test_indices = np.asarray(
            [index for index, label in enumerate(labels) if label.work_token == work],
            dtype=np.int64,
        )
        train_rows = []
        for threshold in THRESHOLDS:
            metrics = evaluate_threshold(
                labels=labels,
                candidate_ids=candidate_ids,
                body_scores=outputs["body_candidate_scores"],
                variant_scores=outputs["variant_candidate_scores"],
                family_probabilities=family_probabilities,
                threshold=threshold,
                indices=train_indices,
            )
            train_rows.append({"threshold": threshold, **metrics})
        fold_selected = max(train_rows, key=_threshold_key)
        threshold = float(fold_selected["threshold"])
        oof_thresholds[test_indices] = threshold
        holdout = evaluate_threshold(
            labels=labels,
            candidate_ids=candidate_ids,
            body_scores=outputs["body_candidate_scores"],
            variant_scores=outputs["variant_candidate_scores"],
            family_probabilities=family_probabilities,
            threshold=threshold,
            indices=test_indices,
        )
        folds.append(
            {
                "held_out_work_token": work,
                "selected_threshold": threshold,
                "training_metrics": fold_selected,
                "holdout_metrics": holdout,
            }
        )
    oof = evaluate_threshold(
        labels=labels,
        candidate_ids=candidate_ids,
        body_scores=outputs["body_candidate_scores"],
        variant_scores=outputs["variant_candidate_scores"],
        family_probabilities=family_probabilities,
        threshold=oof_thresholds,
    )
    truth = _family_truth(labels)
    variant_probability = family_probabilities[:, VARIANT]
    quantiles: dict[str, dict[str, float]] = {}
    for family, name in ((BODY, "body"), (VARIANT, "variant")):
        values = variant_probability[truth == family]
        quantiles[name] = {
            f"p{percentile:02d}": float(np.quantile(values, percentile / 100.0))
            for percentile in (5, 25, 50, 75, 95)
        }
    return bound.seal_record(
        {
            "confidence_distribution": {
                "actual_body_variant_probability_quantiles": quantiles["body"],
                "actual_variant_below_0_75_count": int(
                    np.sum((truth == VARIANT) & (variant_probability < 0.75))
                ),
                "actual_variant_count": int(np.sum(truth == VARIANT)),
                "actual_variant_variant_probability_quantiles": quantiles["variant"],
            },
            "final_threshold_selection": {
                "objective": "maximize_variant_F0.5_then_acceptable_preferred_recall_then_lower_threshold",
                "selected": selected,
            },
            "nested_work_logo": {
                "folds": folds,
                "oof_metrics": oof,
                "thresholds_by_fold": [float(value) for value in sorted(set(oof_thresholds.tolist()))],
            },
            "record_type": EVIDENCE_RECORD,
            "schema_version": SCHEMA_VERSION,
            "threshold_sweep": sweep,
        }
    )


def _raw_output_rows(
    sample_ids: Sequence[str], outputs: Mapping[str, np.ndarray]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, sample_id in enumerate(sample_ids):
        rows.append(
            bound.seal_record(
                {
                    "body_candidate_scores": [
                        float(value) for value in outputs["body_candidate_scores"][index]
                    ],
                    "family_logits": [float(value) for value in outputs["family_logits"][index]],
                    "record_type": RAW_ROW_RECORD,
                    "sample_id": sample_id,
                    "schema_version": RAW_ROW_SCHEMA,
                    "variant_candidate_scores": [
                        float(value) for value in outputs["variant_candidate_scores"][index]
                    ],
                }
            )
        )
    return rows


def _score_rows(
    sample_ids: Sequence[str], candidate_ids: Sequence[str], deployed_scores: np.ndarray
) -> list[dict[str, Any]]:
    return [
        bound.seal_record(
            {
                "candidate_ids": list(candidate_ids),
                "candidate_scores": [float(value) for value in deployed_scores[index]],
                "record_type": bound.SCORE_ROW_RECORD,
                "sample_id": sample_id,
                "schema_version": bound.SCORE_ROW_SCHEMA,
            }
        )
        for index, sample_id in enumerate(sample_ids)
    ]


def build_bundle(
    *,
    labels_dir: Path,
    hidden_cache_dir: Path,
    r5_source_dir: Path,
    adapter_dir: Path,
    runtime_dir: Path,
    graph_report_path: Path,
    output_dir: Path,
    device_name: str,
    batch_size: int,
) -> dict[str, Any]:
    target = output_dir.expanduser().resolve()
    if target.exists():
        raise BlindR3HScoreError("output directory already exists")
    labels, candidate_ids, label_report = bound._load_fit_labels(labels_dir)  # noqa: SLF001
    if len(labels) != EXPECTED_ROWS:
        raise BlindR3HScoreError("immutable label count drift")
    cache_bindings, cache_manifest, cache_lineage = _load_cache_bindings(
        cache_root=hidden_cache_dir, labels=labels
    )
    try:
        torch, query_head, prototypes, query_source = (
            dataset_builder._load_r5_head_and_prototypes(  # noqa: SLF001
                r5_source_dir, device_name=device_name
            )
        )
        if query_source.get("candidate_ids") != candidate_ids:
            raise BlindR3HScoreError("r5 prototype candidate order drift")
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
        raise BlindR3HScoreError(str(error)) from error

    adapter_manifest = _read_json(adapter_dir / trainer.MANIFEST_FILE, "adapter manifest")
    dataset_sha = str(_mapping(adapter_manifest.get("dataset"), "adapter dataset").get("sha256"))
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
        raise BlindR3HScoreError(str(error)) from error
    runtime_lineage = _validate_runtime_lineage(
        runtime_dir=runtime_dir,
        graph_report_path=graph_report_path,
        adapter=adapter,
        candidate_ids=candidate_ids,
        active_catalog_sha256=str(label_report["bindings"]["active_catalog_sha256"]),
    )
    routed = evaluator._production_route(  # noqa: SLF001
        outputs, single_day_index=candidate_ids.index("single-day")
    )
    evidence = build_threshold_evidence(
        labels=labels, candidate_ids=candidate_ids, outputs=outputs
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}.", dir=target.parent) as raw_temp:
        staging = Path(raw_temp) / target.name
        staging.mkdir()
        raw_path = staging / "raw-r3h-outputs.jsonl"
        score_path = staging / "production-routed-scores.jsonl"
        score_manifest_path = staging / "score-manifest.json"
        evidence_path = staging / "family-threshold-evidence.json"
        fit_path = staging / "calibration-fit.json"
        report_path = staging / "report.json"
        sample_ids = [label.sample_id for label in labels]
        _write_jsonl(raw_path, _raw_output_rows(sample_ids, outputs))
        _write_jsonl(
            score_path,
            _score_rows(sample_ids, candidate_ids, routed["deployed_scores"]),
        )
        score_manifest = bound.seal_record(
            {
                "active_catalog_sha256": runtime_lineage["active_catalog_sha256"],
                "calibration_labels_sha256": _sha256_file(
                    labels_dir / "calibration-labels.jsonl"
                ),
                "candidate_order_sha256": bound._candidate_order_sha(candidate_ids),  # noqa: SLF001
                "record_type": bound.SCORE_MANIFEST_RECORD,
                "row_count": len(labels),
                "runtime_lineage": {
                    "encoder_onnx_sha256": runtime_lineage["encoder_onnx_sha256"],
                    "ranker_onnx_sha256": runtime_lineage["ranker_onnx_sha256"],
                    "runtime_contract_sha256": runtime_lineage["runtime_contract_sha256"],
                },
                "schema_version": bound.SCORE_MANIFEST_SCHEMA,
                "score_route": bound.SCORE_ROUTE,
                "score_rows_sha256": _sha256_file(score_path),
                "score_semantics": bound.SCORE_SEMANTICS,
            }
        )
        score_manifest_path.write_bytes(bound.json_bytes(score_manifest, pretty=True))
        evidence_path.write_bytes(bound.json_bytes(evidence, pretty=True))
        fit = bound.fit_r3h_scores(
            artifact_dir=labels_dir,
            score_manifest_path=score_manifest_path,
            scores_path=score_path,
            output_path=fit_path,
        )
        current_metrics = evaluate_threshold(
            labels=labels,
            candidate_ids=candidate_ids,
            body_scores=outputs["body_candidate_scores"],
            variant_scores=outputs["variant_candidate_scores"],
            family_probabilities=evaluator._softmax(outputs["family_logits"]),  # noqa: SLF001
            threshold=0.50,
        )
        report = bound.seal_record(
            {
                "artifacts": {
                    "calibration-fit.json": _descriptor(fit_path),
                    "family-threshold-evidence.json": _descriptor(evidence_path),
                    "production-routed-scores.jsonl": _descriptor(
                        score_path, row_count=len(labels)
                    ),
                    "raw-r3h-outputs.jsonl": _descriptor(raw_path, row_count=len(labels)),
                    "score-manifest.json": _descriptor(score_manifest_path),
                },
                "authority": {
                    "automatic_model_training_human_promotion_allowed": False,
                    "calibration_fit_only": True,
                    "deployment_attachment_allowed": False,
                    "human_gold": False,
                    "training_eligible": False,
                },
                "bindings": {
                    "adapter_checkpoint_sha256": adapter["checkpoint_sha256"],
                    "adapter_manifest_record_sha256": adapter["manifest_record_sha256"],
                    "adapter_manifest_sha256": adapter["manifest_sha256"],
                    "hidden_cache": cache_lineage,
                    "immutable_label_report_record_sha256": label_report["record_sha256"],
                    "immutable_labels_sha256": _sha256_file(
                        labels_dir / "calibration-labels.jsonl"
                    ),
                    "query_source": query_source,
                    "runtime": runtime_lineage,
                },
                "boundary": {
                    "blind_calibration_rows_used": len(labels),
                    "blind_evaluation_rows_161_240_read": 0,
                    "catalog_gap_rows_used": 0,
                    "crop_reject_rows_used": 0,
                    "hidden_cache_selected_split": "test_calibration_fit_only",
                    "optimizer_updates": 0,
                },
                "candidate_ids": list(candidate_ids),
                "family_evidence_record_sha256": evidence["record_sha256"],
                "font_metrics": {
                    "calibrated_fixed_C_oof": fit["oof_report"]["fixed_C_metrics"]["global"],
                    "calibrated_nested_oof": fit["oof_report"]["nested_metrics"]["global"],
                    "production_route_before_calibration": current_metrics,
                },
                "raw_output_tensor_sha256": {
                    "body_candidate_scores": _sha256_array(outputs["body_candidate_scores"]),
                    "family_logits": _sha256_array(outputs["family_logits"]),
                    "query_views_f16": _sha256_array(query_views),
                    "variant_candidate_scores": _sha256_array(outputs["variant_candidate_scores"]),
                },
                "record_type": REPORT_RECORD,
                "schema_version": SCHEMA_VERSION,
                "score_fit_record_sha256": fit["record_sha256"],
            }
        )
        report_path.write_bytes(bound.json_bytes(report, pretty=True))
        staging.replace(target)
    return validate_bundle(target)


def validate_bundle(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = _read_json(root / "report.json", "r3h score report")
    bound.validate_record_seal(report, "r3h score report")
    if report.get("schema_version") != SCHEMA_VERSION or report.get("record_type") != REPORT_RECORD:
        raise BlindR3HScoreError("r3h score report schema drift")
    expected = {
        "calibration-fit.json",
        "family-threshold-evidence.json",
        "production-routed-scores.jsonl",
        "raw-r3h-outputs.jsonl",
        "report.json",
        "score-manifest.json",
    }
    actual = {path.name for path in root.iterdir() if path.is_file()}
    if actual != expected:
        raise BlindR3HScoreError("r3h score bundle exact inventory drift")
    descriptors = _mapping(report.get("artifacts"), "r3h artifact descriptors")
    for name in expected - {"report.json"}:
        descriptor = _mapping(descriptors.get(name), f"descriptor {name}")
        if descriptor.get("sha256") != _sha256_file(root / name):
            raise BlindR3HScoreError("r3h score artifact descriptor drift")
    raw_rows = bound._read_exact_jsonl(  # noqa: SLF001
        root / "raw-r3h-outputs.jsonl", EXPECTED_ROWS, "raw r3h outputs"
    )
    for row in raw_rows:
        bound.validate_record_seal(row, "raw r3h output")
        if (
            row.get("schema_version") != RAW_ROW_SCHEMA
            or row.get("record_type") != RAW_ROW_RECORD
            or len(row.get("body_candidate_scores", ())) != 21
            or len(row.get("variant_candidate_scores", ())) != 21
            or len(row.get("family_logits", ())) != 2
        ):
            raise BlindR3HScoreError("raw r3h output row drift")
    evidence = _read_json(root / "family-threshold-evidence.json", "family evidence")
    bound.validate_record_seal(evidence, "family evidence")
    if len(evidence.get("threshold_sweep", ())) != len(THRESHOLDS):
        raise BlindR3HScoreError("family threshold sweep drift")
    fit = bound.validate_fit(_read_json(root / "calibration-fit.json", "calibration fit"))
    if (
        report.get("score_fit_record_sha256") != fit.get("record_sha256")
        or _mapping(report.get("boundary"), "boundary").get(
            "blind_evaluation_rows_161_240_read"
        )
        != 0
    ):
        raise BlindR3HScoreError("r3h score supervision boundary drift")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--labels-dir", type=Path, required=True)
    build.add_argument("--hidden-cache-dir", type=Path, required=True)
    build.add_argument("--r5-source-dir", type=Path, required=True)
    build.add_argument("--adapter-dir", type=Path, required=True)
    build.add_argument("--runtime-dir", type=Path, required=True)
    build.add_argument("--graph-report", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    build.add_argument("--batch-size", type=int, default=64)
    validate = commands.add_parser("validate")
    validate.add_argument("--artifact-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            report = build_bundle(
                labels_dir=args.labels_dir.expanduser().resolve(),
                hidden_cache_dir=args.hidden_cache_dir.expanduser().resolve(),
                r5_source_dir=args.r5_source_dir.expanduser().resolve(),
                adapter_dir=args.adapter_dir.expanduser().resolve(),
                runtime_dir=args.runtime_dir.expanduser().resolve(),
                graph_report_path=args.graph_report.expanduser().resolve(),
                output_dir=args.output_dir,
                device_name=args.device,
                batch_size=args.batch_size,
            )
        else:
            report = validate_bundle(args.artifact_dir)
    except (
        BlindR3HScoreError,
        bound.BlindCalibrationBindingError,
        trainer.MangaFontV8RoleFamilyError,
    ) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}, sort_keys=True))
        return 2
    print(
        json.dumps(
            {
                "record_sha256": report["record_sha256"],
                "status": "valid_blind145_r3h_calibration_fit_only",
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
