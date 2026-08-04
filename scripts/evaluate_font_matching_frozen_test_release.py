#!/usr/bin/env python3
"""Predict the frozen test split and publish aggregate-only release evidence.

The prediction directory is an evaluator-only artifact and may contain test row
identifiers.  The final release record is a separate sealed boundary containing
only aggregate metrics and immutable source hashes; it never embeds predictions
or sample identifiers.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
import tempfile
import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import replace as dataclass_replace
from pathlib import Path
from typing import Any

import numpy as np

try:
    import evaluate_font_matching_v2 as evaluator
    import train_font_matching_siglip_baseline as trainer
except ImportError:  # pragma: no cover - import from repository root
    from scripts import evaluate_font_matching_v2 as evaluator  # type: ignore[no-redef]
    from scripts import train_font_matching_siglip_baseline as trainer  # type: ignore[no-redef]


PREDICTION_SCHEMA = "font-matching-frozen-test-predictions-v1"
PREDICTION_RECORD_TYPE = "font_matching_frozen_test_predictions"
PREDICTION_OWNER = "carrot-manga-translator/font-matching-frozen-test-predictions"
PREDICTION_MARKER = ".font-matching-frozen-test-predictions-owned.json"
PREDICTION_MANIFEST = "manifest.json"
PREDICTION_FILE = "predictions-test.jsonl"

RELEASE_SCHEMA = "font-matching-release-evaluation-v1"
RELEASE_RECORD_TYPE = "font_matching_release_evaluation"
RELEASE_METRICS = (
    "overall_acceptable_at_1",
    "recall_at_3",
    "p1_variant_role_macro_acceptable_at_1",
    "none_f1_p0_p1",
    "chapter_local_override_success_rate",
    "ordinary_acceptable_at_1",
)
RELEASE_METRIC_DEFINITIONS = {
    "chapter_local_override_success_rate": (
        "decision_accuracy_on_consistency_action_local_override"
    ),
    "none_f1_p0_p1": "none_f1_on_priority_0_or_1",
    "ordinary_acceptable_at_1": "acceptable_at_1_on_priority_2",
    "overall_acceptable_at_1": "acceptable_at_1_on_all_rankable_test_rows",
    "p1_variant_role_macro_acceptable_at_1": (
        "unweighted_role_macro_acceptable_at_1_on_priority_1_variant_roles"
    ),
    "recall_at_3": "acceptable_at_3_on_all_rankable_test_rows",
}
RELEASE_COHORT_COUNT_KEYS = frozenset(
    {
        "evaluated_row_count",
        "local_override_count",
        "none_p0_p1_count",
        "ordinary_p2_count",
        "p1_variant_role_count",
        "p1_variant_row_count",
    }
)


class FrozenTestReleaseError(ValueError):
    """Raised when frozen-test evidence is incomplete, stale, or unsafe."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = True) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise FrozenTestReleaseError(f"could not read {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise FrozenTestReleaseError(f"{location}: expected an object")
    return value


def require_list(value: Any, *, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise FrozenTestReleaseError(f"{location}: expected an array")
    return value


def require_probability(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FrozenTestReleaseError(f"{location}: expected a probability")
    result = float(value)
    if not math.isfinite(result) or not 0.0 <= result <= 1.0:
        raise FrozenTestReleaseError(f"{location}: probability must be in [0, 1]")
    return result


def require_sha(value: Any, *, location: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise FrozenTestReleaseError(f"{location}: expected a SHA-256 digest")
    return value


def require_integer(value: Any, *, location: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise FrozenTestReleaseError(f"{location}: expected an integer >= {minimum}")
    return value


def require_exact_keys(
    value: Mapping[str, Any], expected: set[str], *, location: str
) -> None:
    if set(value) != expected:
        raise FrozenTestReleaseError(
            f"{location}: invalid keys; missing={sorted(expected - set(value))}, "
            f"unexpected={sorted(set(value) - expected)}"
        )


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = require_sha(record.get("record_sha256"), location=f"{location}.seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise FrozenTestReleaseError(f"{location}: record seal mismatch")
    return actual


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise FrozenTestReleaseError(f"{location}: file is missing or linked")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrozenTestReleaseError(f"{location}: invalid JSON: {error}") from error
    return dict(require_mapping(value, location=location))


def ordered_values_sha256(values: Sequence[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def records_digest(records: Sequence[Mapping[str, Any]]) -> str:
    return sha256_bytes(
        "".join(canonical_json(record) + "\n" for record in records).encode("utf-8")
    )


def scan_frozen_test_assets(*, resolver: Any, corpus: Any) -> tuple[Mapping[str, Any], ...]:
    """Open only test views and return path-free evidence in canonical order."""

    rows: list[Mapping[str, Any]] = []
    examples = corpus.examples_for_split("test")
    if not examples:
        raise FrozenTestReleaseError("training export has no frozen test examples")
    for example in examples:
        sample = corpus.samples_by_id.get(example.sample_id)
        if not isinstance(sample, Mapping) or sample.get("split") != "test":
            raise FrozenTestReleaseError(
                f"{example.sample_id}: frozen test sample binding drifted"
            )
        if sample.get("record_sha256") != example.sample_record_sha256:
            raise FrozenTestReleaseError(
                f"{example.sample_id}: frozen test record hash drifted"
            )
        views: dict[str, Mapping[str, Any]] = {}
        for view_name in trainer.VIEW_NAMES:
            with resolver.resolve_sample_view(sample, view_name) as resolved:
                if resolved.mode != trainer.IMAGE_MODE or resolved.size != trainer.IMAGE_SIZE:
                    raise FrozenTestReleaseError(
                        f"{example.sample_id}.{view_name}: expected RGB 224x224"
                    )
                evidence = resolved.evidence()
                views[view_name] = {
                    "catalog_id": evidence["catalog_id"],
                    "encoder_input_pixel_sha256": evidence["pixel_sha256"],
                    "materialized": evidence["materialized"],
                    "source_file_sha256": evidence["source_file_sha256"],
                    "source_pixel_sha256": evidence["pixel_sha256"],
                    "status": evidence["status"],
                }
        rows.append(
            {
                "sample_id": example.sample_id,
                "split": "test",
                "training_sample_record_sha256": example.sample_record_sha256,
                "views": views,
            }
        )
    return tuple(rows)


def extract_frozen_test_features(
    *,
    resolver: Any,
    corpus: Any,
    scan_rows: Sequence[Mapping[str, Any]],
    extractor: Any,
    image_batch_size: int,
) -> np.ndarray:
    if image_batch_size < 1 or extractor.feature_dim < 1:
        raise FrozenTestReleaseError("invalid frozen-test extraction dimensions")
    output = np.empty(
        (len(scan_rows), len(trainer.VIEW_NAMES), extractor.feature_dim),
        dtype=np.float32,
    )
    flat = output.reshape(-1, extractor.feature_dim)
    images: list[Any] = []
    indices: list[int] = []
    for sample_index, scan_row in enumerate(scan_rows):
        sample_id = str(scan_row["sample_id"])
        sample = corpus.samples_by_id[sample_id]
        if sample.get("split") != "test":
            raise FrozenTestReleaseError("non-test pixels entered frozen-test extraction")
        expected_views = require_mapping(
            scan_row.get("views"), location=f"frozen scan.{sample_id}.views"
        )
        for view_index, view_name in enumerate(trainer.VIEW_NAMES):
            with resolver.resolve_sample_view(sample, view_name) as resolved:
                expected = require_mapping(
                    expected_views.get(view_name),
                    location=f"frozen scan.{sample_id}.{view_name}",
                )
                if (
                    resolved.mode != trainer.IMAGE_MODE
                    or resolved.size != trainer.IMAGE_SIZE
                    or resolved.pixel_sha256 != expected.get("source_pixel_sha256")
                    or resolved.source_file_sha256 != expected.get("source_file_sha256")
                ):
                    raise FrozenTestReleaseError(
                        f"{sample_id}.{view_name}: pixels changed after frozen scan"
                    )
                images.append(resolved.image.copy())
                indices.append(sample_index * len(trainer.VIEW_NAMES) + view_index)
            if len(images) >= image_batch_size:
                trainer._flush_image_batch(
                    images=images,
                    indices=indices,
                    output=flat,
                    extractor=extractor,
                )
    trainer._flush_image_batch(
        images=images, indices=indices, output=flat, extractor=extractor
    )
    if not np.all(np.isfinite(output)):
        raise FrozenTestReleaseError("frozen-test encoder emitted non-finite features")
    return output


def infer_frozen_test(
    *,
    model: Any,
    test_features: np.ndarray,
    cache: Any,
    corpus: Any,
    device: str,
    batch_size: int,
) -> tuple[tuple[Any, ...], Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - environment setup
        raise FrozenTestReleaseError("frozen-test inference requires torch") from error
    examples = corpus.examples_for_split("test")
    if batch_size < 1 or test_features.shape[0] != len(examples):
        raise FrozenTestReleaseError("frozen-test feature/example shape drifted")
    views = torch.from_numpy(np.array(test_features, copy=True)).to(device)
    prototypes = torch.from_numpy(
        np.array(np.asarray(cache.prototype_features, dtype=np.float32), copy=True)
    ).to(device)
    bags = trainer.prototype_bags(cache, corpus.candidate_ids, device=device)
    score_parts: list[np.ndarray] = []
    none_parts: list[np.ndarray] = []
    role_parts: list[np.ndarray] = []
    style_parts: list[np.ndarray] = []
    treatment_parts: dict[str, list[np.ndarray]] = {
        field: [] for field in trainer.TREATMENT_VALUES
    }
    model.eval()
    with torch.no_grad():
        for start in range(0, len(examples), batch_size):
            model_output = model(views[start : start + batch_size], prototypes, bags)
            score_parts.append(model_output["candidate_scores"].float().cpu().numpy())
            none_parts.append(model_output["none_logits"].float().cpu().numpy())
            role_parts.append(model_output["role_logits"].float().cpu().numpy())
            style_parts.append(model_output["style_logits"].float().cpu().numpy())
            for field in trainer.TREATMENT_VALUES:
                treatment_parts[field].append(
                    model_output["treatment_logits"][field].float().cpu().numpy()
                )
    inference = trainer.InferenceOutput(
        candidate_scores=np.concatenate(score_parts),
        none_logits=np.concatenate(none_parts),
        role_logits=np.concatenate(role_parts),
        style_logits=np.concatenate(style_parts),
        treatment_logits={
            field: np.concatenate(parts) for field, parts in treatment_parts.items()
        },
    )
    bindings = tuple(
        trainer.PredictionBinding(
            sample_id=example.sample_id,
            work_id=example.work_id,
            split="test",
            sample_record_sha256=example.sample_record_sha256,
            listwise_record_sha256=example.listwise_record_sha256,
        )
        for example in examples
    )
    return bindings, inference


def load_bound_runtime(
    *,
    catalog_registry: Path,
    training_export_dir: Path,
    render_bank_manifest: Path,
    asset_validation_report: Path | None,
    font_signal_audit_root: Path,
    trainer_output_dir: Path,
    feature_cache_dir: Path,
) -> tuple[Any, Any, Mapping[str, Any]]:
    try:
        runtime = trainer.prepare_runtime_inputs(
            catalog_registry=catalog_registry,
            training_export_dir=training_export_dir,
            render_bank_manifest=render_bank_manifest,
            asset_validation_report=asset_validation_report,
            font_signal_audit_root=font_signal_audit_root,
        )
        cache = trainer.load_feature_cache(
            cache_dir=feature_cache_dir, expected_contract=runtime.cache_contract
        )
        training_status = trainer.validate_training_output(
            output_dir=trainer_output_dir,
            corpus=runtime.corpus,
            resolver=runtime.resolver,
            render_bank=runtime.render_bank,
            cache=cache,
            asset_validation_report_sha256=runtime.asset_validation_report_sha256,
        )
    except trainer.TrainerError as error:
        raise FrozenTestReleaseError(f"trainer authority validation failed: {error}") from error
    contract_path = trainer_output_dir.expanduser().resolve() / "model-contract.json"
    contract = read_json(contract_path, location="trainer model contract")
    expected_frozen_sha = trainer.frozen_test_manifest_sha256(runtime.corpus)
    inputs = require_mapping(contract.get("inputs"), location="trainer contract.inputs")
    if inputs.get("frozen_test_manifest_sha256") != expected_frozen_sha:
        raise FrozenTestReleaseError("trainer contract frozen-test commitment drifted")
    return runtime, cache, {
        "checkpoint_sha256": training_status["checkpoint_sha256"],
        "contract": contract,
        "contract_path": contract_path,
        "contract_sha256": training_status["model_contract_sha256"],
        "frozen_test_manifest_sha256": expected_frozen_sha,
    }


def project_evaluator_export_to_audit_eligible_corpus(
    *, export: Any, corpus: Any
) -> Any:
    """Expose exactly the trainer's audit-eligible rows to the evaluator."""

    targets = require_mapping(export.targets, location="evaluator export.targets")
    examples = require_mapping(
        corpus.examples_by_id, location="trainer corpus.examples_by_id"
    )
    target_ids = set(targets)
    eligible_ids = set(examples)
    excluded_ids = set(corpus.font_signal_audit.excluded_sample_ids)
    if not eligible_ids or eligible_ids - target_ids:
        raise FrozenTestReleaseError(
            "trainer/evaluator audit-eligible inventory drifted"
        )
    if eligible_ids & excluded_ids:
        raise FrozenTestReleaseError("audit-excluded rows survived trainer projection")
    if target_ids - eligible_ids != target_ids & excluded_ids:
        raise FrozenTestReleaseError(
            "evaluator export contains rows omitted without audit exclusion"
        )

    projected_targets: dict[str, Any] = {}
    projected_work_split: dict[str, str] = {}
    for sample_id in sorted(eligible_ids):
        target = targets[sample_id]
        example = examples[sample_id]
        if (
            target.sample_id != sample_id
            or target.work_id != example.work_id
            or target.split != example.split
            or target.sample_record_sha256 != example.sample_record_sha256
            or target.listwise_record_sha256 != example.listwise_record_sha256
            or tuple(target.candidate_ids) != tuple(corpus.candidate_ids)
        ):
            raise FrozenTestReleaseError(
                f"{sample_id}: evaluator/trainer eligible-row binding drifted"
            )
        previous = projected_work_split.setdefault(target.work_id, target.split)
        if previous != target.split:
            raise FrozenTestReleaseError(
                f"{target.work_id}: projected evaluator work split drifted"
            )
        projected_targets[sample_id] = target

    frozen_ids = {
        example.sample_id for example in corpus.examples_for_split("test")
    }
    projected_frozen_ids = {
        sample_id
        for sample_id, target in projected_targets.items()
        if target.split == "test"
    }
    if not frozen_ids or projected_frozen_ids != frozen_ids:
        raise FrozenTestReleaseError(
            "evaluator target inventory differs from committed frozen corpus"
        )
    return dataclass_replace(
        export,
        targets=projected_targets,
        work_split=dict(sorted(projected_work_split.items())),
    )


def _validated_execution(value: Any) -> dict[str, Any]:
    execution = require_mapping(value, location="prediction manifest.execution")
    require_exact_keys(
        execution,
        {
            "encoder_device",
            "encoder_precision",
            "image_batch_size",
            "inference_batch_size",
            "ranker_device",
        },
        location="prediction manifest.execution",
    )
    encoder_device = execution.get("encoder_device")
    ranker_device = execution.get("ranker_device")
    precision = execution.get("encoder_precision")
    if encoder_device not in {"cpu", "cuda"} or ranker_device not in {"cpu", "cuda"}:
        raise FrozenTestReleaseError("prediction execution devices must be cpu or cuda")
    if precision not in {"fp32", "fp16"} or (
        precision == "fp16" and encoder_device != "cuda"
    ):
        raise FrozenTestReleaseError("prediction encoder precision/device is invalid")
    return {
        "encoder_device": encoder_device,
        "encoder_precision": precision,
        "image_batch_size": require_integer(
            execution.get("image_batch_size"),
            location="prediction execution.image_batch_size",
            minimum=1,
        ),
        "inference_batch_size": require_integer(
            execution.get("inference_batch_size"),
            location="prediction execution.inference_batch_size",
            minimum=1,
        ),
        "ranker_device": ranker_device,
    }


def build_model_and_calibration(
    *, cache: Any, training: Mapping[str, Any], ranker_device: str
) -> tuple[Any, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - environment setup
        raise FrozenTestReleaseError("ranker inference requires torch") from error
    if ranker_device == "cuda" and not torch.cuda.is_available():
        raise FrozenTestReleaseError("CUDA ranker requested but CUDA is unavailable")
    contract = require_mapping(training.get("contract"), location="training.contract")
    architecture = require_mapping(
        contract.get("architecture"), location="training.contract.architecture"
    )
    hyperparameters = require_mapping(
        contract.get("hyperparameters"), location="training.contract.hyperparameters"
    )
    feature_dim = require_integer(
        architecture.get("feature_dim"), location="model feature_dim", minimum=1
    )
    if feature_dim != int(cache.prototype_features.shape[-1]):
        raise FrozenTestReleaseError("model/cache feature dimension drifted")
    hidden_dim = require_integer(
        architecture.get("hidden_dim"), location="model hidden_dim", minimum=1
    )
    view_dropout = require_probability(
        architecture.get("view_dropout"), location="model view_dropout"
    )
    head_dropout = require_probability(
        hyperparameters.get("head_dropout"), location="model head_dropout"
    )
    if view_dropout >= 1.0 or head_dropout >= 1.0:
        raise FrozenTestReleaseError("model dropout must stay below one")
    model = trainer.build_ranker(
        feature_dim=feature_dim,
        hidden_dim=hidden_dim,
        view_dropout=view_dropout,
        head_dropout=head_dropout,
    )
    checkpoint_path = Path(training["contract_path"]).parent / "checkpoint.safetensors"
    state = trainer.load_checkpoint(checkpoint_path)
    try:
        model.load_state_dict(dict(state), strict=True)
        model.to(ranker_device)
    except (RuntimeError, KeyError, ValueError) as error:
        raise FrozenTestReleaseError(f"checkpoint/model contract mismatch: {error}") from error
    raw_calibration = require_mapping(
        contract.get("calibration"), location="training.contract.calibration"
    )
    if raw_calibration.get("calibration_split") != "val":
        raise FrozenTestReleaseError("model calibration did not come from validation")
    calibration = trainer.Calibration(
        temperature=float(raw_calibration.get("temperature")),
        none_threshold=require_probability(
            raw_calibration.get("none_threshold"), location="calibration.none_threshold"
        ),
        temperature_selection_metric=str(
            raw_calibration.get("temperature_selection_metric")
        ),
        none_threshold_selection_metric=str(
            raw_calibration.get("none_threshold_selection_metric")
        ),
        calibration_split="val",
    )
    if not math.isfinite(calibration.temperature) or calibration.temperature <= 0.0:
        raise FrozenTestReleaseError("calibration temperature is invalid")
    return model, calibration


def compute_prediction_rows(
    *,
    runtime: Any,
    cache: Any,
    training: Mapping[str, Any],
    scan_rows: Sequence[Mapping[str, Any]],
    execution: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...]:
    execution = _validated_execution(execution)
    try:
        trainer.seed_everything(0)
    except trainer.TrainerError as error:
        raise FrozenTestReleaseError(
            f"could not enable deterministic inference: {error}"
        ) from error
    try:
        extractor = trainer.FrozenSiglipExtractor(
            device=str(execution["encoder_device"]),
            fp16=execution["encoder_precision"] == "fp16",
        )
    except trainer.TrainerError as error:
        raise FrozenTestReleaseError(f"frozen encoder initialization failed: {error}") from error
    if extractor.device != execution["encoder_device"] or extractor.fp16 != (
        execution["encoder_precision"] == "fp16"
    ):
        raise FrozenTestReleaseError("encoder execution contract drifted")
    test_features = extract_frozen_test_features(
        resolver=runtime.resolver,
        corpus=runtime.corpus,
        scan_rows=scan_rows,
        extractor=extractor,
        image_batch_size=int(execution["image_batch_size"]),
    )
    if test_features.shape[-1] != cache.prototype_features.shape[-1]:
        raise FrozenTestReleaseError("frozen encoder/cache feature dimension drifted")
    model, calibration = build_model_and_calibration(
        cache=cache,
        training=training,
        ranker_device=str(execution["ranker_device"]),
    )
    bindings, inference = infer_frozen_test(
        model=model,
        test_features=test_features,
        cache=cache,
        corpus=runtime.corpus,
        device=str(execution["ranker_device"]),
        batch_size=int(execution["inference_batch_size"]),
    )
    try:
        return trainer.build_prediction_rows(
            bindings=bindings,
            inference=inference,
            candidate_ids=runtime.corpus.candidate_ids,
            font_catalog_sha256=runtime.corpus.font_catalog_sha256,
            training_export_manifest_sha256=runtime.export.manifest_sha256,
            checkpoint_sha256=str(training["checkpoint_sha256"]),
            calibration=calibration,
        )
    except trainer.TrainerError as error:
        raise FrozenTestReleaseError(f"frozen prediction construction failed: {error}") from error


def build_prediction_manifest(
    *,
    runtime: Any,
    cache: Any,
    training: Mapping[str, Any],
    scan_rows: Sequence[Mapping[str, Any]],
    execution: Mapping[str, Any],
    predictions_sha256: str,
    prediction_count: int,
) -> dict[str, Any]:
    execution = _validated_execution(execution)
    test_count = len(runtime.corpus.examples_for_split("test"))
    if prediction_count != test_count or len(scan_rows) != test_count or test_count < 1:
        raise FrozenTestReleaseError("frozen prediction/test inventory count drifted")
    return seal_record(
        {
            "boundary": {
                "calibration_split": "val",
                "feature_arrays_persisted": False,
                "frozen_before_training": True,
                "prediction_split": "test",
                "rows_used_for_optimizer_calibration_prototypes_or_hard_negatives": 0,
                "train_or_val_rows_in_prediction_file": 0,
                "work_disjoint": True,
            },
            "execution": dict(execution),
            "prediction_count": prediction_count,
            "prediction_file": {
                "file": PREDICTION_FILE,
                "sha256": require_sha(
                    predictions_sha256, location="predictions-test.jsonl sha256"
                ),
            },
            "record_type": PREDICTION_RECORD_TYPE,
            "schema_version": PREDICTION_SCHEMA,
            "source": {
                "asset_validation_report_sha256": runtime.asset_validation_report_sha256,
                "candidate_ids_sha256": ordered_values_sha256(
                    runtime.corpus.candidate_ids
                ),
                "catalog_registry_sha256": runtime.resolver.registry_sha256,
                "checkpoint_sha256": training["checkpoint_sha256"],
                "feature_cache_manifest_sha256": cache.manifest_sha256,
                "font_catalog_sha256": runtime.corpus.font_catalog_sha256,
                "frozen_test_manifest_sha256": training[
                    "frozen_test_manifest_sha256"
                ],
                "model_contract_sha256": training["contract_sha256"],
                "render_bank_manifest_sha256": runtime.render_bank.manifest_sha256,
                "test_asset_evidence_sha256": records_digest(scan_rows),
                "training_export_manifest_sha256": runtime.export.manifest_sha256,
            },
            "test_view_count": prediction_count * len(trainer.VIEW_NAMES),
        }
    )


def validate_prediction_manifest_binding(
    actual: Mapping[str, Any], *, expected: Mapping[str, Any]
) -> None:
    validate_record_seal(actual, location="prediction manifest")
    if dict(actual) != dict(expected):
        raise FrozenTestReleaseError("frozen prediction manifest binding drifted")


def _safe_prediction_root(path: Path) -> Path:
    root = path.expanduser().resolve()
    if root == Path(root.anchor) or len(root.name) < 3:
        raise FrozenTestReleaseError(f"unsafe frozen prediction target: {root}")
    if path.exists() and path.is_symlink():
        raise FrozenTestReleaseError("frozen prediction target must not be a symlink")
    return root


def load_prediction_directory(root_value: Path) -> tuple[dict[str, Any], bytes]:
    root = _safe_prediction_root(root_value)
    if not root.is_dir():
        raise FrozenTestReleaseError("frozen prediction directory does not exist")
    expected_files = {PREDICTION_MARKER, PREDICTION_MANIFEST, PREDICTION_FILE}
    if {path.name for path in root.iterdir()} != expected_files:
        raise FrozenTestReleaseError("frozen prediction file inventory drifted")
    marker = read_json(root / PREDICTION_MARKER, location="prediction owner marker")
    require_exact_keys(
        marker,
        {"managed_files", "owner", "safe_replace", "schema_version"},
        location="prediction owner marker",
    )
    if (
        marker.get("owner") != PREDICTION_OWNER
        or marker.get("schema_version") != PREDICTION_SCHEMA
        or marker.get("safe_replace") is not True
    ):
        raise FrozenTestReleaseError("frozen prediction owner marker is invalid")
    managed = require_mapping(marker.get("managed_files"), location="marker.managed_files")
    if set(managed) != {PREDICTION_MANIFEST, PREDICTION_FILE}:
        raise FrozenTestReleaseError("frozen prediction managed inventory drifted")
    for name in managed:
        path = root / name
        if path.is_symlink() or not path.is_file() or sha256_file(path) != managed[name]:
            raise FrozenTestReleaseError(f"frozen prediction artifact hash mismatch: {name}")
    manifest = read_json(root / PREDICTION_MANIFEST, location="prediction manifest")
    validate_record_seal(manifest, location="prediction manifest")
    predictions = (root / PREDICTION_FILE).read_bytes()
    return manifest, predictions


def _write_prediction_directory(
    *,
    output_dir: Path,
    manifest: Mapping[str, Any],
    prediction_payload: bytes,
    replace_owned_output: bool,
) -> None:
    root = _safe_prediction_root(output_dir)
    if root.exists() and not replace_owned_output:
        raise FrozenTestReleaseError(
            "frozen prediction output exists; pass --replace-owned-output"
        )
    if root.exists():
        load_prediction_directory(root)
    root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{root.name}.staging-", dir=root.parent))
    try:
        (staging / PREDICTION_FILE).write_bytes(prediction_payload)
        (staging / PREDICTION_MANIFEST).write_bytes(json_bytes(manifest))
        marker = {
            "managed_files": {
                PREDICTION_FILE: sha256_file(staging / PREDICTION_FILE),
                PREDICTION_MANIFEST: sha256_file(staging / PREDICTION_MANIFEST),
            },
            "owner": PREDICTION_OWNER,
            "safe_replace": True,
            "schema_version": PREDICTION_SCHEMA,
        }
        (staging / PREDICTION_MARKER).write_bytes(json_bytes(marker))
        load_prediction_directory(staging)
        if not root.exists():
            os.replace(staging, root)
        else:
            backup = root.with_name(f".{root.name}.backup-{uuid.uuid4().hex}")
            os.replace(root, backup)
            try:
                os.replace(staging, root)
                load_prediction_directory(root)
            except BaseException:
                if root.exists():
                    shutil.rmtree(root)
                os.replace(backup, root)
                raise
            shutil.rmtree(backup)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def validate_frozen_predictions(
    *,
    predictions_dir: Path,
    catalog_registry: Path,
    training_export_dir: Path,
    render_bank_manifest: Path,
    asset_validation_report: Path | None,
    font_signal_audit_root: Path,
    trainer_output_dir: Path,
    feature_cache_dir: Path,
) -> dict[str, Any]:
    manifest, prediction_payload = load_prediction_directory(predictions_dir)
    require_exact_keys(
        manifest,
        {
            "boundary",
            "execution",
            "prediction_count",
            "prediction_file",
            "record_sha256",
            "record_type",
            "schema_version",
            "source",
            "test_view_count",
        },
        location="prediction manifest",
    )
    if (
        manifest.get("schema_version") != PREDICTION_SCHEMA
        or manifest.get("record_type") != PREDICTION_RECORD_TYPE
    ):
        raise FrozenTestReleaseError("frozen prediction manifest schema/type drifted")
    execution = _validated_execution(manifest.get("execution"))
    runtime, cache, training = load_bound_runtime(
        catalog_registry=catalog_registry,
        training_export_dir=training_export_dir,
        render_bank_manifest=render_bank_manifest,
        asset_validation_report=asset_validation_report,
        font_signal_audit_root=font_signal_audit_root,
        trainer_output_dir=trainer_output_dir,
        feature_cache_dir=feature_cache_dir,
    )
    scan_rows = scan_frozen_test_assets(
        resolver=runtime.resolver, corpus=runtime.corpus
    )
    prediction_path = predictions_dir.expanduser().resolve() / PREDICTION_FILE
    try:
        export = project_evaluator_export_to_audit_eligible_corpus(
            export=evaluator.load_export(
                runtime.export.root / "manifest.json",
                runtime.export.root / "samples.jsonl",
                runtime.export.root / "listwise.jsonl",
            ),
            corpus=runtime.corpus,
        )
        prediction_set = evaluator.load_predictions(
            prediction_path,
            export=export,
            evaluation_split="test",
            require_semantics=True,
        )
    except evaluator.EvaluationError as error:
        raise FrozenTestReleaseError(f"evaluator rejected frozen predictions: {error}") from error
    expected_rows = compute_prediction_rows(
        runtime=runtime,
        cache=cache,
        training=training,
        scan_rows=scan_rows,
        execution=execution,
    )
    expected_payload = trainer.prediction_jsonl_bytes(expected_rows)
    if prediction_payload != expected_payload:
        raise FrozenTestReleaseError(
            "frozen prediction rows do not reproduce from sealed pixels/model"
        )
    expected_manifest = build_prediction_manifest(
        runtime=runtime,
        cache=cache,
        training=training,
        scan_rows=scan_rows,
        execution=execution,
        predictions_sha256=sha256_bytes(prediction_payload),
        prediction_count=len(expected_rows),
    )
    validate_prediction_manifest_binding(manifest, expected=expected_manifest)
    if prediction_set.model_sha256 != training["checkpoint_sha256"]:
        raise FrozenTestReleaseError("prediction model/checkpoint binding drifted")
    return {
        "cache": cache,
        "export": export,
        "manifest": manifest,
        "manifest_sha256": sha256_file(
            predictions_dir.expanduser().resolve() / PREDICTION_MANIFEST
        ),
        "prediction_set": prediction_set,
        "runtime": runtime,
        "training": training,
    }


def produce_frozen_predictions(
    *,
    output_dir: Path,
    replace_owned_output: bool,
    execution: Mapping[str, Any],
    catalog_registry: Path,
    training_export_dir: Path,
    render_bank_manifest: Path,
    asset_validation_report: Path | None,
    font_signal_audit_root: Path,
    trainer_output_dir: Path,
    feature_cache_dir: Path,
) -> Mapping[str, Any]:
    execution = _validated_execution(execution)
    runtime, cache, training = load_bound_runtime(
        catalog_registry=catalog_registry,
        training_export_dir=training_export_dir,
        render_bank_manifest=render_bank_manifest,
        asset_validation_report=asset_validation_report,
        font_signal_audit_root=font_signal_audit_root,
        trainer_output_dir=trainer_output_dir,
        feature_cache_dir=feature_cache_dir,
    )
    scan_rows = scan_frozen_test_assets(
        resolver=runtime.resolver, corpus=runtime.corpus
    )
    rows = compute_prediction_rows(
        runtime=runtime,
        cache=cache,
        training=training,
        scan_rows=scan_rows,
        execution=execution,
    )
    payload = trainer.prediction_jsonl_bytes(rows)
    manifest = build_prediction_manifest(
        runtime=runtime,
        cache=cache,
        training=training,
        scan_rows=scan_rows,
        execution=execution,
        predictions_sha256=sha256_bytes(payload),
        prediction_count=len(rows),
    )
    _write_prediction_directory(
        output_dir=output_dir,
        manifest=manifest,
        prediction_payload=payload,
        replace_owned_output=replace_owned_output,
    )
    return validate_frozen_predictions(
        predictions_dir=output_dir,
        catalog_registry=catalog_registry,
        training_export_dir=training_export_dir,
        render_bank_manifest=render_bank_manifest,
        asset_validation_report=asset_validation_report,
        font_signal_audit_root=font_signal_audit_root,
        trainer_output_dir=trainer_output_dir,
        feature_cache_dir=feature_cache_dir,
    )


def compute_release_metrics(
    *, export: Any, prediction_set: Any, corpus: Any, none_threshold: float
) -> tuple[dict[str, float], dict[str, int]]:
    test_examples = {
        example.sample_id: example for example in corpus.examples_for_split("test")
    }
    test_targets = {
        sample_id: target
        for sample_id, target in export.targets.items()
        if target.split == "test"
    }
    if set(test_examples) != set(test_targets):
        raise FrozenTestReleaseError("evaluator/trainer frozen-test inventory drifted")
    try:
        system = evaluator.evaluate_system(
            export,
            prediction_set,
            evaluation_split="test",
            none_threshold=none_threshold,
        )
        scores = {
            sample_id: evaluator._score_sample(
                target,
                prediction_set.predictions[sample_id],
                none_threshold=none_threshold,
                variant=None,
            )
            for sample_id, target in sorted(test_targets.items())
        }
    except evaluator.EvaluationError as error:
        raise FrozenTestReleaseError(f"frozen-test metric computation failed: {error}") from error

    overall = require_mapping(system.get("overall"), location="evaluation.overall")
    p1_by_role: dict[str, list[Any]] = defaultdict(list)
    none_p0_p1: list[Any] = []
    local_overrides: list[Any] = []
    ordinary: list[Any] = []
    for sample_id, score in scores.items():
        example = test_examples[sample_id]
        if example.priority == 1 and score.role in trainer.VARIANT_ROLES:
            p1_by_role[score.role].append(score)
        if example.priority in {0, 1}:
            none_p0_p1.append(score)
        if example.consistency_action == "local_override":
            local_overrides.append(score)
        if example.priority == 2:
            ordinary.append(score)
    if not p1_by_role or not none_p0_p1 or not local_overrides or not ordinary:
        raise FrozenTestReleaseError(
            "frozen test lacks a required P1/none/local-override/ordinary cohort"
        )
    p1_role_values: list[float] = []
    for role, role_scores in sorted(p1_by_role.items()):
        value = evaluator._metric_block(role_scores).get("acceptable_at_1")
        if value is not None:
            p1_role_values.append(float(value))
    none_f1 = evaluator._metric_block(none_p0_p1).get("none_f1")
    ordinary_top1 = evaluator._metric_block(ordinary).get("acceptable_at_1")
    local_override_success = sum(score.decision_correct for score in local_overrides) / len(
        local_overrides
    )
    raw_metrics: dict[str, Any] = {
        "overall_acceptable_at_1": overall.get("acceptable_at_1"),
        "recall_at_3": overall.get("acceptable_at_3"),
        "p1_variant_role_macro_acceptable_at_1": (
            None if not p1_role_values else sum(p1_role_values) / len(p1_role_values)
        ),
        "none_f1_p0_p1": none_f1,
        "chapter_local_override_success_rate": local_override_success,
        "ordinary_acceptable_at_1": ordinary_top1,
    }
    metrics = {
        name: require_probability(raw_metrics.get(name), location=f"release metric.{name}")
        for name in RELEASE_METRICS
    }
    counts = {
        "evaluated_row_count": len(scores),
        "local_override_count": len(local_overrides),
        "none_p0_p1_count": len(none_p0_p1),
        "ordinary_p2_count": len(ordinary),
        "p1_variant_role_count": len(p1_by_role),
        "p1_variant_row_count": sum(len(value) for value in p1_by_role.values()),
    }
    return metrics, counts


def validate_thresholds(value: Mapping[str, Any]) -> dict[str, float]:
    if set(value) != set(RELEASE_METRICS):
        raise FrozenTestReleaseError("release threshold inventory drifted")
    return {
        name: require_probability(value[name], location=f"release threshold.{name}")
        for name in RELEASE_METRICS
    }


def build_release_record(
    *,
    validated_predictions: Mapping[str, Any],
    thresholds: Mapping[str, Any],
) -> dict[str, Any]:
    runtime = validated_predictions["runtime"]
    training = validated_predictions["training"]
    contract = require_mapping(training["contract"], location="training contract")
    calibration = require_mapping(
        contract.get("calibration"), location="training contract.calibration"
    )
    none_threshold = require_probability(
        calibration.get("none_threshold"), location="training none threshold"
    )
    metrics, counts = compute_release_metrics(
        export=validated_predictions["export"],
        prediction_set=validated_predictions["prediction_set"],
        corpus=runtime.corpus,
        none_threshold=none_threshold,
    )
    threshold_values = validate_thresholds(thresholds)
    failed = [
        name
        for name in RELEASE_METRICS
        if metrics[name] + 1e-12 < threshold_values[name]
    ]
    record = seal_record(
        {
            "evaluation_provenance": {
                "evaluator_schema_version": evaluator.REPORT_SCHEMA_VERSION,
                "frozen_prediction_manifest_sha256": validated_predictions[
                    "manifest_sha256"
                ],
                "frozen_prediction_record_sha256": validated_predictions["manifest"][
                    "record_sha256"
                ],
                "metric_definitions": dict(RELEASE_METRIC_DEFINITIONS),
                "none_threshold": none_threshold,
                "prediction_jsonl_sha256": validated_predictions[
                    "prediction_set"
                ].path_sha256,
                "required_cohort_counts": counts,
            },
            "gate": {"failed_checks": failed, "passed": not failed},
            "metrics": metrics,
            "record_type": RELEASE_RECORD_TYPE,
            "schema_version": RELEASE_SCHEMA,
            "source": {
                "candidate_ids_sha256": ordered_values_sha256(
                    runtime.corpus.candidate_ids
                ),
                "checkpoint_sha256": training["checkpoint_sha256"],
                "frozen_test_manifest_sha256": training[
                    "frozen_test_manifest_sha256"
                ],
                "model_contract_sha256": training["contract_sha256"],
            },
            "test_data_boundary": {
                "evaluated_row_count": counts["evaluated_row_count"],
                "frozen_before_training": True,
                "pixels_opened_by_runtime_exporter": 0,
                "row_level_predictions_embedded": False,
                "rows_used_for_optimizer_calibration_prototypes_or_hard_negatives": 0,
                "sample_identifiers_embedded": False,
                "split": "frozen_test",
                "test_manifest_sha256": training["frozen_test_manifest_sha256"],
                "work_disjoint": True,
            },
            "thresholds": threshold_values,
        }
    )
    assert_release_has_no_row_data(record)
    return record


FORBIDDEN_RELEASE_KEYS = frozenset(
    {
        "chapter_id",
        "candidate_ids",
        "page_id",
        "predictions",
        "ranked_candidate_ids",
        "sample_id",
        "sample_ids",
        "test_rows",
        "work_id",
        "work_ids",
    }
)


def assert_release_has_no_row_data(value: Any, *, location: str = "release") -> None:
    if isinstance(value, Mapping):
        leaked = set(value) & FORBIDDEN_RELEASE_KEYS
        if leaked:
            raise FrozenTestReleaseError(
                f"{location}: row-level test data leaked through keys {sorted(leaked)}"
            )
        for key, item in value.items():
            assert_release_has_no_row_data(item, location=f"{location}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            assert_release_has_no_row_data(item, location=f"{location}[{index}]")


def validate_release_record_shape(record: Mapping[str, Any]) -> None:
    validate_record_seal(record, location="release evaluation")
    require_exact_keys(
        record,
        {
            "evaluation_provenance",
            "gate",
            "metrics",
            "record_sha256",
            "record_type",
            "schema_version",
            "source",
            "test_data_boundary",
            "thresholds",
        },
        location="release evaluation",
    )
    if (
        record.get("schema_version") != RELEASE_SCHEMA
        or record.get("record_type") != RELEASE_RECORD_TYPE
    ):
        raise FrozenTestReleaseError("release evaluation schema/type drifted")
    assert_release_has_no_row_data(record)
    provenance = require_mapping(
        record.get("evaluation_provenance"), location="release.evaluation_provenance"
    )
    require_exact_keys(
        provenance,
        {
            "evaluator_schema_version",
            "frozen_prediction_manifest_sha256",
            "frozen_prediction_record_sha256",
            "metric_definitions",
            "none_threshold",
            "prediction_jsonl_sha256",
            "required_cohort_counts",
        },
        location="release.evaluation_provenance",
    )
    if provenance.get("evaluator_schema_version") != evaluator.REPORT_SCHEMA_VERSION:
        raise FrozenTestReleaseError("release evaluator schema binding drifted")
    for key in (
        "frozen_prediction_manifest_sha256",
        "frozen_prediction_record_sha256",
        "prediction_jsonl_sha256",
    ):
        require_sha(provenance.get(key), location=f"release provenance.{key}")
    require_probability(
        provenance.get("none_threshold"), location="release provenance.none_threshold"
    )
    if provenance.get("metric_definitions") != RELEASE_METRIC_DEFINITIONS:
        raise FrozenTestReleaseError("release metric definitions drifted")
    cohort_counts = require_mapping(
        provenance.get("required_cohort_counts"),
        location="release provenance.required_cohort_counts",
    )
    require_exact_keys(
        cohort_counts,
        set(RELEASE_COHORT_COUNT_KEYS),
        location="release provenance.required_cohort_counts",
    )
    for key in RELEASE_COHORT_COUNT_KEYS:
        require_integer(
            cohort_counts.get(key),
            location=f"release cohort count.{key}",
            minimum=1,
        )
    if (
        cohort_counts["none_p0_p1_count"] + cohort_counts["ordinary_p2_count"]
        != cohort_counts["evaluated_row_count"]
        or cohort_counts["p1_variant_row_count"]
        > cohort_counts["none_p0_p1_count"]
        or cohort_counts["p1_variant_role_count"]
        > cohort_counts["p1_variant_row_count"]
        or cohort_counts["local_override_count"]
        > cohort_counts["evaluated_row_count"]
    ):
        raise FrozenTestReleaseError("release required cohort counts are inconsistent")

    source = require_mapping(record.get("source"), location="release.source")
    require_exact_keys(
        source,
        {
            "candidate_ids_sha256",
            "checkpoint_sha256",
            "frozen_test_manifest_sha256",
            "model_contract_sha256",
        },
        location="release.source",
    )
    for key in source:
        require_sha(source.get(key), location=f"release.source.{key}")

    boundary = require_mapping(
        record.get("test_data_boundary"), location="release.test_data_boundary"
    )
    require_exact_keys(
        boundary,
        {
            "evaluated_row_count",
            "frozen_before_training",
            "pixels_opened_by_runtime_exporter",
            "row_level_predictions_embedded",
            "rows_used_for_optimizer_calibration_prototypes_or_hard_negatives",
            "sample_identifiers_embedded",
            "split",
            "test_manifest_sha256",
            "work_disjoint",
        },
        location="release.test_data_boundary",
    )
    if (
        boundary.get("split") != "frozen_test"
        or boundary.get("work_disjoint") is not True
        or boundary.get("frozen_before_training") is not True
        or boundary.get("pixels_opened_by_runtime_exporter") != 0
        or boundary.get("row_level_predictions_embedded") is not False
        or boundary.get("sample_identifiers_embedded") is not False
        or boundary.get(
            "rows_used_for_optimizer_calibration_prototypes_or_hard_negatives"
        )
        != 0
    ):
        raise FrozenTestReleaseError("release frozen-test boundary drifted")
    evaluated_count = require_integer(
        boundary.get("evaluated_row_count"),
        location="release boundary.evaluated_row_count",
        minimum=1,
    )
    if evaluated_count != cohort_counts.get("evaluated_row_count"):
        raise FrozenTestReleaseError("release evaluated row count drifted")
    if require_sha(
        boundary.get("test_manifest_sha256"),
        location="release boundary.test_manifest_sha256",
    ) != source.get("frozen_test_manifest_sha256"):
        raise FrozenTestReleaseError("release test manifest source drifted")

    metrics = require_mapping(record.get("metrics"), location="release.metrics")
    thresholds = require_mapping(
        record.get("thresholds"), location="release.thresholds"
    )
    validate_thresholds(metrics)
    validate_thresholds(thresholds)
    gate = require_mapping(record.get("gate"), location="release.gate")
    require_exact_keys(gate, {"failed_checks", "passed"}, location="release.gate")
    if gate.get("passed") is not True or gate.get("failed_checks") != []:
        raise FrozenTestReleaseError("release gate did not pass")
    for name in RELEASE_METRICS:
        if float(metrics[name]) + 1e-12 < float(thresholds[name]):
            raise FrozenTestReleaseError(f"release threshold failed: {name}")


def read_release(path: Path) -> dict[str, Any]:
    return read_json(path.expanduser().resolve(), location="release evaluation")


def _write_release(
    path: Path, record: Mapping[str, Any], *, replace_existing: bool
) -> None:
    validate_release_record_shape(record)
    target = path.expanduser().resolve()
    if target == Path(target.anchor) or target.name in {"", ".", ".."}:
        raise FrozenTestReleaseError(f"unsafe release output: {target}")
    if path.exists() and path.is_symlink():
        raise FrozenTestReleaseError("release output must not be a symlink")
    if target.exists():
        if not replace_existing:
            raise FrozenTestReleaseError("release output exists; pass --replace-existing")
        validate_release_record_shape(read_release(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(json_bytes(record))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def build_or_validate_release(
    *,
    release_path: Path,
    build: bool,
    replace_existing: bool,
    thresholds: Mapping[str, Any],
    predictions_dir: Path,
    catalog_registry: Path,
    training_export_dir: Path,
    render_bank_manifest: Path,
    asset_validation_report: Path | None,
    font_signal_audit_root: Path,
    trainer_output_dir: Path,
    feature_cache_dir: Path,
) -> dict[str, Any]:
    validated = validate_frozen_predictions(
        predictions_dir=predictions_dir,
        catalog_registry=catalog_registry,
        training_export_dir=training_export_dir,
        render_bank_manifest=render_bank_manifest,
        asset_validation_report=asset_validation_report,
        font_signal_audit_root=font_signal_audit_root,
        trainer_output_dir=trainer_output_dir,
        feature_cache_dir=feature_cache_dir,
    )
    expected = build_release_record(
        validated_predictions=validated, thresholds=thresholds
    )
    if expected["gate"]["passed"] is not True:
        raise FrozenTestReleaseError(
            "release thresholds failed: " + ", ".join(expected["gate"]["failed_checks"])
        )
    if build:
        _write_release(
            release_path, expected, replace_existing=replace_existing
        )
    actual = read_release(release_path)
    validate_release_record_shape(actual)
    if actual != expected:
        raise FrozenTestReleaseError(
            "release evaluation does not reproduce from sealed frozen predictions"
        )
    return actual


def _add_authority_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--training-export-dir", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--asset-validation-report", type=Path)
    parser.add_argument("--font-signal-audit-root", type=Path, required=True)
    parser.add_argument("--trainer-output-dir", type=Path, required=True)
    parser.add_argument("--feature-cache-dir", type=Path, required=True)


def _add_threshold_arguments(parser: argparse.ArgumentParser) -> None:
    for name in RELEASE_METRICS:
        parser.add_argument("--" + name.replace("_", "-"), type=float, required=True)


def _thresholds_from_args(args: argparse.Namespace) -> dict[str, float]:
    return validate_thresholds({name: getattr(args, name) for name in RELEASE_METRICS})


def _authority_kwargs(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "asset_validation_report": args.asset_validation_report,
        "catalog_registry": args.catalog_registry,
        "feature_cache_dir": args.feature_cache_dir,
        "font_signal_audit_root": args.font_signal_audit_root,
        "render_bank_manifest": args.render_bank_manifest,
        "trainer_output_dir": args.trainer_output_dir,
        "training_export_dir": args.training_export_dir,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    predict = subparsers.add_parser("predict", help="build frozen-test predictions")
    _add_authority_arguments(predict)
    predict.add_argument("--output-dir", type=Path, required=True)
    predict.add_argument("--replace-owned-output", action="store_true")
    predict.add_argument("--encoder-device", choices=("cpu", "cuda"), required=True)
    predict.add_argument("--encoder-precision", choices=("fp32", "fp16"), required=True)
    predict.add_argument("--ranker-device", choices=("cpu", "cuda"), required=True)
    predict.add_argument("--image-batch-size", type=int, required=True)
    predict.add_argument("--inference-batch-size", type=int, required=True)

    validate_predictions = subparsers.add_parser(
        "validate-predictions", help="reproduce and validate frozen-test predictions"
    )
    _add_authority_arguments(validate_predictions)
    validate_predictions.add_argument("--predictions-dir", type=Path, required=True)

    build_release = subparsers.add_parser(
        "build-release", help="build aggregate-only release evidence"
    )
    _add_authority_arguments(build_release)
    _add_threshold_arguments(build_release)
    build_release.add_argument("--predictions-dir", type=Path, required=True)
    build_release.add_argument("--output", type=Path, required=True)
    build_release.add_argument("--replace-existing", action="store_true")

    validate_release = subparsers.add_parser(
        "validate-release", help="recompute aggregate release evidence"
    )
    _add_authority_arguments(validate_release)
    _add_threshold_arguments(validate_release)
    validate_release.add_argument("--predictions-dir", type=Path, required=True)
    validate_release.add_argument("--release", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    authorities = _authority_kwargs(args)
    if args.command == "predict":
        validated = produce_frozen_predictions(
            output_dir=args.output_dir,
            replace_owned_output=args.replace_owned_output,
            execution={
                "encoder_device": args.encoder_device,
                "encoder_precision": args.encoder_precision,
                "image_batch_size": args.image_batch_size,
                "inference_batch_size": args.inference_batch_size,
                "ranker_device": args.ranker_device,
            },
            **authorities,
        )
        result = {
            "prediction_count": validated["manifest"]["prediction_count"],
            "record_sha256": validated["manifest"]["record_sha256"],
            "status": "valid",
        }
    elif args.command == "validate-predictions":
        validated = validate_frozen_predictions(
            predictions_dir=args.predictions_dir, **authorities
        )
        result = {
            "prediction_count": validated["manifest"]["prediction_count"],
            "record_sha256": validated["manifest"]["record_sha256"],
            "status": "valid",
        }
    else:
        release_path = args.output if args.command == "build-release" else args.release
        release = build_or_validate_release(
            release_path=release_path,
            build=args.command == "build-release",
            replace_existing=(
                args.replace_existing if args.command == "build-release" else False
            ),
            thresholds=_thresholds_from_args(args),
            predictions_dir=args.predictions_dir,
            **authorities,
        )
        result = {
            "evaluated_row_count": release["test_data_boundary"][
                "evaluated_row_count"
            ],
            "record_sha256": release["record_sha256"],
            "status": "valid",
        }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FrozenTestReleaseError, trainer.TrainerError, evaluator.EvaluationError) as error:
        raise SystemExit(f"frozen-test-release error: {error}") from error
