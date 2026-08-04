#!/usr/bin/env python3
"""Build or validate a sealed full-22 font catalog utility audit.

The audit is deliberately diagnostic.  It binds the human full-22 labels, the
successor validation predictions, the old-15 ordinary-reference checkpoint
evidence, and the successor prototype feature/cache/checkpoint chain.  It never
writes a catalog transition.  In particular, an unfinalized strict-consensus
training export can only produce ``diagnostic_only/pending_formal_adjudication``
recommendations.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import evaluate_font_matching_v2 as offline  # noqa: E402
import train_font_matching_siglip_baseline as trainer  # noqa: E402


SCHEMA_VERSION = "font-matching-catalog-utility-evaluation-v1"
RECORD_TYPE = "font_matching_catalog_utility_evaluation"
EXPECTED_FULL_CANDIDATE_COUNT = 22
EXPECTED_REFERENCE_CANDIDATE_COUNT = 15
STRICT_SELECTION_MODE = "unfinalized_exact_independent_consensus_only"
FORMAL_SELECTION_MODE = "formal_finalized_all_resolved"
TRAINER_FILES = {
    ".font-matching-siglip-baseline-owned.json",
    "checkpoint.safetensors",
    "model-contract.json",
    "predictions-val.jsonl",
    "report.json",
}
CACHE_FILES = {
    ".font-matching-siglip-feature-cache-owned.json",
    "manifest.json",
    "prototype-features.npy",
    "sample-features.npy",
}
TIERS = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
    "not_reviewed",
)
AUTHORITY_FIELDS = {
    "all_22_candidates_retained_for_utility_audit",
    "candidate_count",
    "catalog_disposition_record_sha256",
    "eligibility_exceptions_excluded",
    "formal_calibration_gate_passed",
    "old_tier_mutation_allowed",
    "provisional_catalog_record_sha256",
    "resolved_label_file",
    "schema_version",
    "selection_mode",
    "tier_merge",
    "top1_synthesis_allowed",
    "training_only",
    "training_quarantine_excluded",
}
INPUT_HASH_FIELDS = {
    "catalog_registry_sha256",
    "feature_cache_manifest_sha256",
    "ordinary_reference_checkpoint_sha256",
    "ordinary_reference_model_contract_sha256",
    "ordinary_reference_output_marker_sha256",
    "ordinary_reference_predictions_sha256",
    "ordinary_reference_report_sha256",
    "render_bank_manifest_sha256",
    "successor_checkpoint_sha256",
    "successor_model_contract_sha256",
    "successor_predictions_sha256",
    "successor_report_sha256",
    "training_export_manifest_sha256",
    "training_export_samples_sha256",
}
HUMAN_METRIC_FIELDS = {
    "deployable_opportunity_count",
    "legacy_gap_p1_rescue_count",
    "legacy_gap_safe_count",
    "preferred_count",
    "safe_count",
    "sample_count",
    "unique_p1_safe_count",
    "unique_preferred_count",
    "unique_safe_count",
    "unrenderable_count",
}
VALIDATION_METRIC_FIELDS = {
    "candidate_recall_at_1",
    "candidate_recall_at_3",
    "safe_target_count",
    "selection_safe_count",
    "selection_safe_precision",
    "top1_usage_count",
    "top3_usage_count",
    "validation_sample_count",
}
CLI_EPILOG = """\
Strict full-22 example (the provisional-v4 prior-label authority binds registry-v2):
  python scripts/evaluate_font_matching_catalog_utility.py build --training-export-dir artifacts/font-matching-training-export-full22-strict-v1 --trainer-output-dir artifacts/font-matching-siglip-full22-strict-v1 --feature-cache-dir artifacts/font-matching-siglip-full22-strict-v1-feature-cache --catalog-registry datasets/font-matching-catalog-registry-v2.json --render-bank-manifest datasets/fontclip-font-render-bank-v2/manifest.json --ordinary-reference-output-dir datasets/font-matching-siglip-baseline-15-provisional-v1 --output artifacts/font-matching-catalog-utility-full22-strict-v1.json

Recompute the same sealed audit by replacing `build` with `validate` and keeping
every path unchanged.
"""


class UtilityEvaluationError(ValueError):
    """Raised when utility evidence is incomplete, stale, or unsafe."""


@dataclass(frozen=True)
class SampleInfo:
    sample_id: str
    target: offline.Target
    row: Mapping[str, Any]
    priority: int


@dataclass(frozen=True)
class TrainerBundle:
    root: Path
    marker: Mapping[str, Any]
    contract: Mapping[str, Any]
    report: Mapping[str, Any]
    checkpoint_path: Path
    checkpoint_sha256: str
    contract_sha256: str
    report_sha256: str
    predictions_sha256: str


@dataclass(frozen=True)
class CacheBundle:
    root: Path
    manifest: Mapping[str, Any]
    manifest_sha256: str
    prototype_features: np.ndarray
    prototype_index: tuple[Mapping[str, Any], ...]


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = json.dumps(
        value,
        ensure_ascii=False,
        indent=2 if pretty else None,
        sort_keys=True,
        separators=None if pretty else (",", ":"),
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal(core: Mapping[str, Any]) -> dict[str, Any]:
    record = copy.deepcopy(dict(core))
    record.pop("record_sha256", None)
    record["record_sha256"] = sha256_bytes(canonical_json_bytes(record).rstrip(b"\n"))
    return record


def validate_seal(value: Mapping[str, Any], *, location: str) -> str:
    expected = require_sha(value.get("record_sha256"), f"{location}.record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json_bytes(core).rstrip(b"\n"))
    if actual != expected:
        raise UtilityEvaluationError(f"{location}: record seal mismatch")
    return actual


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise UtilityEvaluationError(f"{location}: expected an object")
    return value


def require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise UtilityEvaluationError(f"{location}: expected an array")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise UtilityEvaluationError(f"{location}: expected non-empty text")
    return value


def require_sha(value: Any, location: str) -> str:
    output = require_text(value, location)
    if len(output) != 64 or any(char not in "0123456789abcdef" for char in output):
        raise UtilityEvaluationError(f"{location}: expected lowercase SHA-256")
    return output


def require_int(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise UtilityEvaluationError(f"{location}: expected integer >= {minimum}")
    return value


def require_bool(value: Any, location: str) -> bool:
    if not isinstance(value, bool):
        raise UtilityEvaluationError(f"{location}: expected boolean")
    return value


def require_finite_number(
    value: Any,
    location: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    allow_none: bool = False,
) -> float | None:
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UtilityEvaluationError(f"{location}: expected a finite number")
    output = float(value)
    if (
        not math.isfinite(output)
        or (minimum is not None and output < minimum)
        or (maximum is not None and output > maximum)
    ):
        raise UtilityEvaluationError(f"{location}: number is out of range")
    return output


def require_exact_keys(
    value: Mapping[str, Any], expected: set[str], *, location: str
) -> None:
    if set(value) != expected:
        raise UtilityEvaluationError(
            f"{location}: field inventory drifted; "
            f"missing={sorted(expected - set(value))} "
            f"extra={sorted(set(value) - expected)}"
        )


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise UtilityEvaluationError(f"{location}: file is missing or linked")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UtilityEvaluationError(f"{location}: invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise UtilityEvaluationError(f"{location}: top-level JSON must be an object")
    return value


def _regular_directory(path: Path, *, location: str) -> Path:
    root = path.resolve()
    if root.is_symlink() or not root.is_dir():
        raise UtilityEvaluationError(f"{location}: directory is missing or linked")
    return root


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise UtilityEvaluationError(f"artifact is missing or linked: {path}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }


def _validate_descriptor(
    descriptor: Any, path: Path, *, location: str
) -> dict[str, Any]:
    value = require_mapping(descriptor, location)
    expected = _descriptor(path)
    if any(value.get(key) != expected[key] for key in expected):
        raise UtilityEvaluationError(f"{location}: artifact descriptor mismatch")
    return expected


def _load_trainer_bundle(path: Path, *, location: str) -> TrainerBundle:
    root = _regular_directory(path, location=location)
    if {item.name for item in root.iterdir()} != TRAINER_FILES:
        raise UtilityEvaluationError(f"{location}: trainer file inventory drifted")
    marker_path = root / ".font-matching-siglip-baseline-owned.json"
    marker = read_json(marker_path, location=f"{location} marker")
    if (
        marker.get("owner") != trainer.OUTPUT_OWNER
        or marker.get("schema_version") != trainer.TRAINER_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise UtilityEvaluationError(f"{location}: ownership marker is invalid")
    artifacts = require_mapping(marker.get("artifacts"), f"{location}.marker.artifacts")
    expected_artifacts = TRAINER_FILES - {marker_path.name}
    if set(artifacts) != expected_artifacts:
        raise UtilityEvaluationError(f"{location}: marker artifact inventory drifted")
    for name in sorted(expected_artifacts):
        if artifacts.get(name) != sha256_file(root / name):
            raise UtilityEvaluationError(f"{location}: marker hash mismatch for {name}")

    contract_path = root / "model-contract.json"
    report_path = root / "report.json"
    predictions_path = root / "predictions-val.jsonl"
    checkpoint_path = root / "checkpoint.safetensors"
    contract = read_json(contract_path, location=f"{location} model contract")
    report = read_json(report_path, location=f"{location} report")
    validate_seal(contract, location=f"{location} model contract")
    validate_seal(report, location=f"{location} report")
    if (
        contract.get("schema_version") != trainer.MODEL_CONTRACT_SCHEMA_VERSION
        or contract.get("record_type") != "font_matching_siglip_model_contract"
        or report.get("schema_version") != trainer.REPORT_SCHEMA_VERSION
        or report.get("record_type") != "font_matching_siglip_training_report"
    ):
        raise UtilityEvaluationError(f"{location}: trainer schema is unsupported")
    checks = require_mapping(report.get("checks"), f"{location}.report.checks")
    if (
        checks.get("candidate_id_classifier_parameters") != 0
        or checks.get("encoder_fully_frozen") is not True
        or checks.get("prediction_semantics_from_model_heads") is not True
        or checks.get("synthetic_or_qa_inputs") != 0
        or checks.get("test_pixels_opened_or_cached") != 0
        or checks.get(
            "test_rows_used_for_optimizer_calibration_prototypes_or_hard_negatives"
        )
        not in {None, 0}
        or checks.get("chapter_pair_test_rows_used") not in {None, 0}
    ):
        raise UtilityEvaluationError(f"{location}: trainer safety provenance is unsafe")
    contract_sha = sha256_file(contract_path)
    if report.get("model_contract_sha256") != contract_sha:
        raise UtilityEvaluationError(
            f"{location}: report/model-contract binding failed"
        )
    report_artifacts = require_mapping(
        report.get("artifacts"), f"{location}.report.artifacts"
    )
    for name in (
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
    ):
        _validate_descriptor(
            report_artifacts.get(name), root / name, location=f"{location}.{name}"
        )
    checkpoint = require_mapping(
        contract.get("checkpoint"), f"{location}.contract.checkpoint"
    )
    checkpoint_sha = sha256_file(checkpoint_path)
    if (
        checkpoint.get("file") != checkpoint_path.name
        or checkpoint.get("sha256") != checkpoint_sha
    ):
        raise UtilityEvaluationError(f"{location}: checkpoint binding failed")
    inputs = require_mapping(contract.get("inputs"), f"{location}.contract.inputs")
    if report.get("input_hashes") != inputs:
        raise UtilityEvaluationError(f"{location}: report input hashes drifted")
    return TrainerBundle(
        root=root,
        marker=marker,
        contract=contract,
        report=report,
        checkpoint_path=checkpoint_path,
        checkpoint_sha256=checkpoint_sha,
        contract_sha256=contract_sha,
        report_sha256=sha256_file(report_path),
        predictions_sha256=sha256_file(predictions_path),
    )


def _load_cache(
    path: Path,
    *,
    model_contract: Mapping[str, Any],
    model_inputs: Mapping[str, Any],
    candidate_ids: Sequence[str],
) -> CacheBundle:
    root = _regular_directory(path, location="feature cache")
    if {item.name for item in root.iterdir()} != CACHE_FILES:
        raise UtilityEvaluationError("feature cache file inventory drifted")
    marker_path = root / ".font-matching-siglip-feature-cache-owned.json"
    marker = read_json(marker_path, location="feature cache marker")
    manifest_path = root / "manifest.json"
    manifest_sha = sha256_file(manifest_path)
    if (
        marker.get("owner") != trainer.CACHE_OWNER
        or marker.get("schema_version") != trainer.CACHE_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("manifest_sha256") != manifest_sha
    ):
        raise UtilityEvaluationError("feature cache ownership binding failed")
    manifest = read_json(manifest_path, location="feature cache manifest")
    validate_seal(manifest, location="feature cache manifest")
    if manifest.get("schema_version") != trainer.CACHE_SCHEMA_VERSION:
        raise UtilityEvaluationError("feature cache schema is unsupported")
    cache_contract = require_mapping(manifest.get("contract"), "cache.contract")
    expected_cache_inputs = copy.deepcopy(dict(model_inputs))
    expected_cache_inputs.pop("font_catalog_sha256", None)
    expected_cache_inputs.pop("chapter_pairs", None)
    if (
        require_mapping(cache_contract.get("inputs"), "cache.contract.inputs")
        != expected_cache_inputs
    ):
        raise UtilityEvaluationError("feature cache/model input binding drifted")
    contract_cache = require_mapping(
        model_contract.get("feature_cache"), "model contract.feature_cache"
    )
    processor_config_sha = require_sha(
        manifest.get("processor_config_sha256"),
        "feature cache.processor_config_sha256",
    )
    if (
        contract_cache.get("manifest_sha256") != manifest_sha
        or contract_cache.get("processor_config_sha256") != processor_config_sha
    ):
        raise UtilityEvaluationError("model contract/feature cache binding failed")
    artifacts = require_mapping(manifest.get("artifacts"), "cache.artifacts")
    arrays: dict[str, np.ndarray] = {}
    for name in ("sample-features.npy", "prototype-features.npy"):
        descriptor = _validate_descriptor(
            artifacts.get(name), root / name, location=f"cache.{name}"
        )
        try:
            array = np.load(root / name, allow_pickle=False)
        except (OSError, ValueError) as error:
            raise UtilityEvaluationError(
                f"cache.{name}: invalid NPY: {error}"
            ) from error
        if (
            list(array.shape)
            != require_mapping(artifacts.get(name), f"cache.{name}").get("shape")
            or str(array.dtype)
            != require_mapping(artifacts.get(name), f"cache.{name}").get("dtype")
            or array.dtype != np.float32
            or not np.all(np.isfinite(array))
            or descriptor["byte_size"] <= 0
        ):
            raise UtilityEvaluationError(f"cache.{name}: shape/dtype/value drifted")
        arrays[name] = array
    prototype_index_raw = require_list(
        manifest.get("prototype_index"), "cache.prototype_index"
    )
    prototype_index: list[Mapping[str, Any]] = []
    fonts: set[str] = set()
    keys: set[tuple[str, str, str]] = set()
    for index, raw in enumerate(prototype_index_raw):
        row = require_mapping(raw, f"cache.prototype_index[{index}]")
        font_id = require_text(row.get("font_id"), f"prototype[{index}].font_id")
        probe_id = require_text(row.get("probe_id"), f"prototype[{index}].probe_id")
        writing_mode = require_text(
            row.get("writing_mode"), f"prototype[{index}].writing_mode"
        )
        key = (font_id, probe_id, writing_mode)
        if row.get("row_index") != index or key in keys:
            raise UtilityEvaluationError("feature cache prototype index is duplicated")
        if writing_mode not in {"horizontal", "vertical"}:
            raise UtilityEvaluationError("prototype writing mode is unsupported")
        keys.add(key)
        fonts.add(font_id)
        prototype_index.append(row)
    if len(prototype_index) != arrays["prototype-features.npy"].shape[
        0
    ] or fonts != set(candidate_ids):
        raise UtilityEvaluationError("prototype cache candidate inventory drifted")
    return CacheBundle(
        root=root,
        manifest=manifest,
        manifest_sha256=manifest_sha,
        prototype_features=arrays["prototype-features.npy"],
        prototype_index=tuple(prototype_index),
    )


def _validate_registry(
    path: Path,
    *,
    expected_sha256: str,
    manifest_inputs: Mapping[str, Any],
) -> tuple[Mapping[str, Any], str]:
    registry = read_json(path, location="catalog registry")
    if "record_sha256" in registry:
        validate_seal(registry, location="catalog registry")
    actual = sha256_file(path)
    if (
        actual != expected_sha256
        or manifest_inputs.get("catalog_registry_sha256") != actual
    ):
        raise UtilityEvaluationError("catalog registry hash binding failed")
    return registry, actual


def _validate_render_bank(
    path: Path,
    *,
    expected_sha256: str,
    expected_font_catalog_sha256: str,
    candidate_ids: Sequence[str],
    manifest: Mapping[str, Any],
) -> tuple[Mapping[str, Any], str]:
    render = read_json(path, location="render bank")
    actual = sha256_file(path)
    renderer = require_mapping(manifest.get("renderer_bindings"), "renderer_bindings")
    if (
        actual != expected_sha256
        or renderer.get("render_bank_manifest_sha256") != actual
        or require_mapping(render.get("source_contract"), "render.source_contract").get(
            "manifest_sha256"
        )
        != expected_font_catalog_sha256
        or render.get("schema_version") != "font-render-bank-v1"
        or require_mapping(render.get("render_spec"), "render.render_spec").get(
            "qa_overlay"
        )
        is not False
    ):
        raise UtilityEvaluationError("render bank hash/catalog binding failed")
    candidate_rows = require_list(render.get("candidates"), "render.candidates")
    if (
        render.get("candidate_count") != len(candidate_rows)
        or render.get("rendered_candidate_count") != len(candidate_rows)
        or require_mapping(render.get("generation"), "render.generation").get(
            "complete_against_production_assets"
        )
        is not True
    ):
        raise UtilityEvaluationError(
            "render bank candidate/completeness contract drifted"
        )
    canonical: list[str] = []
    for index, raw in enumerate(candidate_rows):
        row = require_mapping(raw, f"render.candidates[{index}]")
        if row.get("production_400_normal_canonical") is True:
            canonical.append(
                require_text(row.get("font_id"), f"render.candidates[{index}].font_id")
            )
    if len(canonical) != len(set(canonical)) or set(canonical) != set(candidate_ids):
        raise UtilityEvaluationError(
            "render bank canonical candidate inventory drifted"
        )
    return render, actual


def _candidate_ids(contract: Mapping[str, Any], *, location: str) -> tuple[str, ...]:
    vocabulary = require_mapping(contract.get("vocabulary"), f"{location}.vocabulary")
    values = tuple(
        require_text(value, f"{location}.candidate_ids[{index}]")
        for index, value in enumerate(
            require_list(vocabulary.get("candidate_ids"), f"{location}.candidate_ids")
        )
    )
    if len(values) != len(set(values)) or tuple(sorted(values)) != values:
        raise UtilityEvaluationError(
            f"{location}: candidate IDs must be sorted and unique"
        )
    return values


def _load_reference(
    path: Path,
    *,
    successor: TrainerBundle,
    full_candidate_ids: Sequence[str],
    expected_priority2_sample_count: int,
) -> tuple[TrainerBundle, tuple[str, ...], Mapping[str, Any]]:
    reference = _load_trainer_bundle(path, location="ordinary reference")
    legacy_ids = _candidate_ids(reference.contract, location="ordinary reference")
    if len(legacy_ids) != EXPECTED_REFERENCE_CANDIDATE_COUNT or not set(
        legacy_ids
    ).issubset(full_candidate_ids):
        raise UtilityEvaluationError("ordinary reference is not an exact old-15 subset")
    training = require_mapping(successor.report.get("training"), "successor.training")
    selection = require_mapping(
        training.get("checkpoint_selection"), "successor.checkpoint_selection"
    )
    if successor.contract.get("ordinary_regression_safety") != selection:
        raise UtilityEvaluationError(
            "successor ordinary regression safety report binding drifted"
        )
    try:
        trainer._validate_ordinary_regression_safety(
            selection,
            expected_priority2_sample_count=expected_priority2_sample_count,
        )
    except trainer.TrainerError as error:
        raise UtilityEvaluationError(
            f"successor ordinary reference safety contract is invalid: {error}"
        ) from error
    baseline = require_mapping(
        selection.get("baseline_validation_metrics"),
        "successor.baseline_validation_metrics",
    )
    best_metrics = require_mapping(
        training.get("best_validation_metrics"),
        "successor.best_validation_metrics",
    )
    expected_gate = trainer.ordinary_regression_gate(
        metrics=best_metrics,
        baseline_metrics=baseline,
        production_reference_required=True,
    )
    if selection.get("best_ordinary_regression_gate") != expected_gate:
        raise UtilityEvaluationError(
            "successor ordinary regression floor was not reproduced"
        )
    binding = require_mapping(selection.get("reference"), "successor.reference")
    expected = {
        "checkpoint_sha256": reference.checkpoint_sha256,
        "model_contract_sha256": reference.contract_sha256,
        "output_marker_sha256": sha256_file(
            reference.root / ".font-matching-siglip-baseline-owned.json"
        ),
        "report_sha256": reference.report_sha256,
        "source_candidate_count": EXPECTED_REFERENCE_CANDIDATE_COUNT,
        "usage": "evaluation_only_ordinary_regression_baseline",
    }
    for key, value in expected.items():
        if binding.get(key) != value:
            raise UtilityEvaluationError(f"ordinary reference binding mismatch: {key}")
    if (
        selection.get("baseline_status") != "production_reference"
        or selection.get("ordinary_baseline_source")
        != "validated_owned_prior_checkpoint_evaluation_only"
    ):
        raise UtilityEvaluationError(
            "ordinary reference safety status is not production"
        )
    return reference, legacy_ids, baseline


def _authority(manifest: Mapping[str, Any]) -> tuple[Mapping[str, Any], str]:
    contracts = require_mapping(manifest.get("contracts"), "manifest.contracts")
    authority = require_mapping(
        contracts.get("provisional_full22"), "contracts.provisional_full22"
    )
    require_exact_keys(
        authority, AUTHORITY_FIELDS, location="contracts.provisional_full22"
    )
    if (
        authority.get("schema_version") != "font-matching-provisional-full22-export-v1"
        or authority.get("training_only") is not True
        or authority.get("all_22_candidates_retained_for_utility_audit") is not True
        or authority.get("candidate_count") != EXPECTED_FULL_CANDIDATE_COUNT
        or authority.get("eligibility_exceptions_excluded") is not True
        or authority.get("old_tier_mutation_allowed") is not False
        or authority.get("resolved_label_file") != "resolved-labels-full22.jsonl"
        or authority.get("tier_merge") != "immutable_prior15_plus_exact_resolved_delta7"
        or authority.get("top1_synthesis_allowed") is not False
        or authority.get("training_quarantine_excluded") is not True
    ):
        raise UtilityEvaluationError(
            "training export is not a provisional full-22 audit"
        )
    formal = authority.get("formal_calibration_gate_passed")
    selection_mode = authority.get("selection_mode")
    catalog_disposition = authority.get("catalog_disposition_record_sha256")
    provisional_catalog = authority.get("provisional_catalog_record_sha256")
    if (
        formal is False
        and selection_mode == STRICT_SELECTION_MODE
        and catalog_disposition is None
        and provisional_catalog is None
    ):
        return authority, "strict_consensus_diagnostic"
    if formal is True and selection_mode == FORMAL_SELECTION_MODE:
        require_sha(
            catalog_disposition,
            "contracts.provisional_full22.catalog_disposition_record_sha256",
        )
        require_sha(
            provisional_catalog,
            "contracts.provisional_full22.provisional_catalog_record_sha256",
        )
        return authority, "formal_utility_evidence"
    raise UtilityEvaluationError(
        "full-22 authority state is unsupported or contradictory"
    )


def _sample_priority(row: Mapping[str, Any], target: offline.Target) -> int:
    try:
        style = require_mapping(row.get("source_style"), "sample.source_style")
        unknown_values = style.get("unknown_fields")
        if not isinstance(unknown_values, list) or any(
            not isinstance(value, str) for value in unknown_values
        ):
            raise UtilityEvaluationError(
                "sample.source_style.unknown_fields must be a string array"
            )
        unknown_fields = set(unknown_values)
        if not unknown_fields.issubset(set(trainer.STYLE_FIELDS)):
            raise UtilityEvaluationError(
                "sample.source_style.unknown_fields contains unsupported names"
            )
        values: list[float] = []
        for field in trainer.STYLE_FIELDS:
            value = style.get(field)
            known = field not in unknown_fields and value is not None
            if known:
                normalized = require_finite_number(
                    value,
                    f"sample.source_style.{field}",
                    minimum=0.0,
                    maximum=1.0,
                )
                assert normalized is not None
                values.append(normalized)
            else:
                if value is not None or field not in unknown_fields:
                    raise UtilityEvaluationError(
                        "sample.source_style unknown mask/value mismatch"
                    )
                values.append(0.0)
        priority, _ = trainer._variant_metadata(
            row,
            role=target.role,
            style_values=values,
            consistency_action=trainer._consistency_action(row),
        )
    except (
        KeyError,
        TypeError,
        ValueError,
        UtilityEvaluationError,
        trainer.TrainerError,
    ) as error:
        raise UtilityEvaluationError(
            f"{target.sample_id}: cannot reproduce trainer priority: {error}"
        ) from error
    return priority


def _load_sample_infos(
    export: offline.ExportData, samples_path: Path
) -> tuple[SampleInfo, ...]:
    rows = offline.read_jsonl(samples_path, "utility samples")
    by_id = {str(row.get("sample_id")): row for row in rows}
    if len(by_id) != len(rows) or set(by_id) != set(export.targets):
        raise UtilityEvaluationError("utility sample inventory differs from export")
    return tuple(
        SampleInfo(
            sample_id=sample_id,
            target=export.targets[sample_id],
            row=by_id[sample_id],
            priority=_sample_priority(by_id[sample_id], export.targets[sample_id]),
        )
        for sample_id in sorted(by_id)
    )


def _tier_set(info: SampleInfo, tier: str) -> set[str]:
    raw = info.target.judgment.get(tier)
    if not isinstance(raw, list):
        raise UtilityEvaluationError(f"{info.sample_id}: invalid {tier} tier")
    return {str(value) for value in raw}


def _safe_set(info: SampleInfo) -> set[str]:
    return _tier_set(info, "preferred") | _tier_set(info, "acceptable")


def _ratio(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


def _metric_block(
    *,
    candidate_id: str,
    infos: Sequence[SampleInfo],
    predictions: Mapping[str, offline.Prediction],
    legacy_ids: set[str],
) -> dict[str, Any]:
    preferred_infos = [
        info for info in infos if candidate_id in _tier_set(info, "preferred")
    ]
    safe_infos = [info for info in infos if candidate_id in _safe_set(info)]
    unique_preferred = [
        info
        for info in infos
        if candidate_id in _tier_set(info, "preferred")
        and _tier_set(info, "preferred") == {candidate_id}
    ]
    unique_safe = [
        info
        for info in infos
        if candidate_id in _safe_set(info) and _safe_set(info) == {candidate_id}
    ]
    unique_p1 = [info for info in unique_safe if info.priority == 1]
    legacy_gap = [
        info
        for info in safe_infos
        if not (_safe_set(info) & legacy_ids) and candidate_id not in legacy_ids
    ]
    val_infos = [info for info in infos if info.target.split == "val"]
    if any(info.sample_id not in predictions for info in val_infos):
        raise UtilityEvaluationError("validation prediction coverage drifted")
    top1 = [
        info
        for info in val_infos
        if predictions[info.sample_id].decision.ranked_candidate_ids[0] == candidate_id
    ]
    top3 = [
        info
        for info in val_infos
        if candidate_id in predictions[info.sample_id].decision.ranked_candidate_ids[:3]
    ]
    selected_safe = [info for info in top1 if candidate_id in _safe_set(info)]
    val_safe = [info for info in val_infos if candidate_id in _safe_set(info)]
    recalled1 = [
        info
        for info in val_safe
        if predictions[info.sample_id].decision.ranked_candidate_ids[0] == candidate_id
    ]
    recalled3 = [
        info
        for info in val_safe
        if candidate_id in predictions[info.sample_id].decision.ranked_candidate_ids[:3]
    ]

    def lineage(rows: Sequence[SampleInfo]) -> dict[str, int]:
        return {
            "source_page_count": len({info.target.source_page_sha256 for info in rows}),
            "work_count": len({info.target.work_id for info in rows}),
        }

    return {
        "human": {
            "deployable_opportunity_count": sum(
                candidate_id not in _tier_set(info, "unrenderable") for info in infos
            ),
            "legacy_gap_p1_rescue_count": sum(
                info.priority == 1 for info in legacy_gap
            ),
            "legacy_gap_safe_count": len(legacy_gap),
            "preferred_count": len(preferred_infos),
            "safe_count": len(safe_infos),
            "sample_count": len(infos),
            "unique_p1_safe_count": len(unique_p1),
            "unique_preferred_count": len(unique_preferred),
            "unique_safe_count": len(unique_safe),
            "unrenderable_count": sum(
                candidate_id in _tier_set(info, "unrenderable") for info in infos
            ),
        },
        "lineage": {
            "preferred": lineage(preferred_infos),
            "safe": lineage(safe_infos),
            "unique_p1_safe": lineage(unique_p1),
        },
        "validation_prediction": {
            "candidate_recall_at_1": _ratio(len(recalled1), len(val_safe)),
            "candidate_recall_at_3": _ratio(len(recalled3), len(val_safe)),
            "safe_target_count": len(val_safe),
            "selection_safe_count": len(selected_safe),
            "selection_safe_precision": _ratio(len(selected_safe), len(top1)),
            "top1_usage_count": len(top1),
            "top3_usage_count": len(top3),
            "validation_sample_count": len(val_infos),
        },
    }


def _project_prototypes(features: np.ndarray, checkpoint_path: Path) -> np.ndarray:
    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover - production dependency
        raise UtilityEvaluationError("prototype audit requires safetensors") from error
    try:
        state = load_file(str(checkpoint_path))
    except (OSError, ValueError) as error:
        raise UtilityEvaluationError(
            f"checkpoint could not be loaded: {error}"
        ) from error
    names = (
        "prototype_projection.0.bias",
        "prototype_projection.0.weight",
        "prototype_projection.1.weight",
    )
    if any(name not in state for name in names):
        raise UtilityEvaluationError("checkpoint lacks prototype projection tensors")
    bias = np.asarray(state[names[0]], dtype=np.float32)
    scale = np.asarray(state[names[1]], dtype=np.float32)
    weight = np.asarray(state[names[2]], dtype=np.float32)
    if (
        bias.shape != (features.shape[1],)
        or scale.shape != bias.shape
        or weight.ndim != 2
        or weight.shape[1] != features.shape[1]
    ):
        raise UtilityEvaluationError("prototype projection tensor shapes drifted")
    mean = features.mean(axis=1, keepdims=True, dtype=np.float32)
    variance = ((features - mean) ** 2).mean(axis=1, keepdims=True, dtype=np.float32)
    normalized = (features - mean) / np.sqrt(variance + np.float32(1e-5))
    projected = ((normalized * scale) + bias) @ weight.T
    norms = np.linalg.norm(projected, axis=1, keepdims=True)
    if not np.all(np.isfinite(projected)) or np.any(norms <= 0):
        raise UtilityEvaluationError("prototype projection produced invalid values")
    return (projected / norms).astype(np.float32, copy=False)


def _unit_rows(features: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    if np.any(norms <= 0) or not np.all(np.isfinite(norms)):
        raise UtilityEvaluationError("prototype encoder features are invalid")
    return (features / norms).astype(np.float32, copy=False)


def _collision_evidence(
    *,
    cache: CacheBundle,
    checkpoint_path: Path,
    candidate_ids: Sequence[str],
    legacy_ids: Sequence[str],
) -> tuple[dict[str, Any], Mapping[str, Mapping[str, Any]]]:
    raw = _unit_rows(cache.prototype_features)
    projected = _project_prototypes(cache.prototype_features, checkpoint_path)
    by_font: dict[str, dict[tuple[str, str], int]] = {}
    for index, row in enumerate(cache.prototype_index):
        by_font.setdefault(str(row["font_id"]), {})[
            (str(row["probe_id"]), str(row["writing_mode"]))
        ] = index

    pair_rows: list[dict[str, Any]] = []
    for first_index, first in enumerate(candidate_ids):
        for second in candidate_ids[first_index + 1 :]:
            shared = sorted(set(by_font[first]) & set(by_font[second]))
            if not shared:
                raise UtilityEvaluationError(
                    f"prototype pair has no aligned probes: {first}/{second}"
                )
            raw_values = np.asarray(
                [
                    float(raw[by_font[first][key]] @ raw[by_font[second][key]])
                    for key in shared
                ],
                dtype=np.float64,
            )
            projected_values = np.asarray(
                [
                    float(
                        projected[by_font[first][key]] @ projected[by_font[second][key]]
                    )
                    for key in shared
                ],
                dtype=np.float64,
            )
            pair_rows.append(
                {
                    "first_candidate_id": first,
                    "projected_aligned_max": float(projected_values.max()),
                    "projected_aligned_mean": float(projected_values.mean()),
                    "projected_aligned_min": float(projected_values.min()),
                    "raw_aligned_max": float(raw_values.max()),
                    "raw_aligned_mean": float(raw_values.mean()),
                    "raw_aligned_min": float(raw_values.min()),
                    "second_candidate_id": second,
                    "shared_prototype_count": len(shared),
                }
            )
    legacy_set = set(legacy_ids)
    legacy_values = [
        float(row["projected_aligned_mean"])
        for row in pair_rows
        if row["first_candidate_id"] in legacy_set
        and row["second_candidate_id"] in legacy_set
    ]
    if not legacy_values:
        raise UtilityEvaluationError("legacy collision reference has no pairs")
    threshold = float(np.quantile(np.asarray(legacy_values), 0.99))

    def nearest(candidate: str, *, legacy_only: bool) -> Mapping[str, Any] | None:
        choices = []
        for row in pair_rows:
            if candidate not in {row["first_candidate_id"], row["second_candidate_id"]}:
                continue
            other = (
                row["second_candidate_id"]
                if row["first_candidate_id"] == candidate
                else row["first_candidate_id"]
            )
            if legacy_only and other not in legacy_set:
                continue
            choices.append((float(row["projected_aligned_mean"]), str(other), row))
        if not choices:
            return None
        _, other, row = max(choices, key=lambda item: (item[0], item[1]))
        return {
            "candidate_id": other,
            "projected_aligned_mean": row["projected_aligned_mean"],
            "raw_aligned_mean": row["raw_aligned_mean"],
            "shared_prototype_count": row["shared_prototype_count"],
        }

    per_candidate: dict[str, Mapping[str, Any]] = {}
    for candidate in candidate_ids:
        nearest_legacy = nearest(candidate, legacy_only=True)
        per_candidate[candidate] = {
            "auxiliary_collision_flag": bool(
                candidate not in legacy_set
                and nearest_legacy is not None
                and float(nearest_legacy["projected_aligned_mean"]) >= threshold
            ),
            "nearest_any": nearest(candidate, legacy_only=False),
            "nearest_legacy": nearest_legacy,
        }
    return (
        {
            "deletion_authority": False,
            "interpretation": "auxiliary_collision_flag_only",
            "legacy_pair_count": len(legacy_values),
            "legacy_projected_aligned_mean_p99": threshold,
            "pair_count": len(pair_rows),
            "pair_metrics_sha256": sha256_bytes(
                canonical_json_bytes(pair_rows).rstrip(b"\n")
            ),
        },
        per_candidate,
    )


def _recommendation(
    *,
    audit_mode: str,
    candidate_id: str,
    is_legacy: bool,
    metrics: Mapping[str, Any],
) -> dict[str, Any]:
    human = require_mapping(metrics.get("human"), "metrics.human")
    if audit_mode == "strict_consensus_diagnostic":
        return {
            "action": "diagnostic_only",
            "active_release_eligible": False,
            "deletion_allowed": False,
            "reason": "pending_formal_adjudication",
            "terminal": False,
        }
    if is_legacy:
        reason = "prior_catalog_member_not_disposed_by_delta_utility"
    elif human.get("deployable_opportunity_count") == 0:
        reason = "pending_deployment_repair"
    elif human.get("safe_count") == 0:
        reason = "formal_safe_zero_evidence_requires_catalog_transition_review"
    elif human.get("unique_p1_safe_count", 0) > 0:
        reason = "formal_unique_p1_retention_evidence"
    else:
        reason = "pending_formal_redundancy_review"
    return {
        "action": "evidence_only",
        "active_release_eligible": False,
        "deletion_allowed": False,
        "reason": reason,
        "terminal": False,
    }


def _validate_lineage(value: Any, *, location: str, maximum: int) -> None:
    row = require_mapping(value, location)
    require_exact_keys(row, {"source_page_count", "work_count"}, location=location)
    page_count = require_int(
        row.get("source_page_count"), f"{location}.source_page_count"
    )
    work_count = require_int(row.get("work_count"), f"{location}.work_count")
    if page_count > maximum or work_count > maximum:
        raise UtilityEvaluationError(
            f"{location}: lineage exceeds its sample inventory"
        )


def _validate_metric_block(value: Any, *, location: str) -> None:
    block = require_mapping(value, location)
    require_exact_keys(
        block, {"human", "lineage", "validation_prediction"}, location=location
    )
    human = require_mapping(block.get("human"), f"{location}.human")
    require_exact_keys(human, HUMAN_METRIC_FIELDS, location=f"{location}.human")
    human_counts = {
        field: require_int(human.get(field), f"{location}.human.{field}")
        for field in HUMAN_METRIC_FIELDS
    }
    sample_count = human_counts["sample_count"]
    if (
        human_counts["preferred_count"] > human_counts["safe_count"]
        or human_counts["safe_count"] > sample_count
        or human_counts["unique_preferred_count"] > human_counts["preferred_count"]
        or human_counts["unique_safe_count"] > human_counts["safe_count"]
        or human_counts["unique_p1_safe_count"] > human_counts["unique_safe_count"]
        or human_counts["legacy_gap_safe_count"] > human_counts["safe_count"]
        or human_counts["legacy_gap_p1_rescue_count"]
        > human_counts["legacy_gap_safe_count"]
        or human_counts["unrenderable_count"] > sample_count
        or human_counts["deployable_opportunity_count"]
        + human_counts["unrenderable_count"]
        != sample_count
    ):
        raise UtilityEvaluationError(f"{location}: human metric counts contradict")

    lineage = require_mapping(block.get("lineage"), f"{location}.lineage")
    require_exact_keys(
        lineage,
        {"preferred", "safe", "unique_p1_safe"},
        location=f"{location}.lineage",
    )
    _validate_lineage(
        lineage.get("preferred"),
        location=f"{location}.lineage.preferred",
        maximum=human_counts["preferred_count"],
    )
    _validate_lineage(
        lineage.get("safe"),
        location=f"{location}.lineage.safe",
        maximum=human_counts["safe_count"],
    )
    _validate_lineage(
        lineage.get("unique_p1_safe"),
        location=f"{location}.lineage.unique_p1_safe",
        maximum=human_counts["unique_p1_safe_count"],
    )

    validation = require_mapping(
        block.get("validation_prediction"), f"{location}.validation_prediction"
    )
    require_exact_keys(
        validation,
        VALIDATION_METRIC_FIELDS,
        location=f"{location}.validation_prediction",
    )
    count_fields = VALIDATION_METRIC_FIELDS - {
        "candidate_recall_at_1",
        "candidate_recall_at_3",
        "selection_safe_precision",
    }
    counts = {
        field: require_int(
            validation.get(field), f"{location}.validation_prediction.{field}"
        )
        for field in count_fields
    }
    val_count = counts["validation_sample_count"]
    if (
        counts["safe_target_count"] > val_count
        or counts["top1_usage_count"] > val_count
        or counts["top3_usage_count"] > val_count
        or counts["selection_safe_count"] > counts["top1_usage_count"]
        or counts["top1_usage_count"] > counts["top3_usage_count"]
    ):
        raise UtilityEvaluationError(f"{location}: validation counts contradict")
    recall1 = require_finite_number(
        validation.get("candidate_recall_at_1"),
        f"{location}.validation_prediction.candidate_recall_at_1",
        minimum=0.0,
        maximum=1.0,
        allow_none=True,
    )
    recall3 = require_finite_number(
        validation.get("candidate_recall_at_3"),
        f"{location}.validation_prediction.candidate_recall_at_3",
        minimum=0.0,
        maximum=1.0,
        allow_none=True,
    )
    precision = require_finite_number(
        validation.get("selection_safe_precision"),
        f"{location}.validation_prediction.selection_safe_precision",
        minimum=0.0,
        maximum=1.0,
        allow_none=True,
    )
    if (
        (counts["safe_target_count"] == 0) != (recall1 is None)
        or (counts["safe_target_count"] == 0) != (recall3 is None)
        or (counts["top1_usage_count"] == 0) != (precision is None)
        or (recall1 is not None and recall3 is not None and recall1 > recall3)
    ):
        raise UtilityEvaluationError(f"{location}: validation ratio semantics drifted")


def _validate_nearest(
    value: Any,
    *,
    location: str,
    candidate_id: str,
    candidate_ids: set[str],
) -> None:
    row = require_mapping(value, location)
    require_exact_keys(
        row,
        {
            "candidate_id",
            "projected_aligned_mean",
            "raw_aligned_mean",
            "shared_prototype_count",
        },
        location=location,
    )
    other = require_text(row.get("candidate_id"), f"{location}.candidate_id")
    if other == candidate_id or other not in candidate_ids:
        raise UtilityEvaluationError(f"{location}: nearest candidate identity drifted")
    require_finite_number(
        row.get("projected_aligned_mean"),
        f"{location}.projected_aligned_mean",
        minimum=-1.000001,
        maximum=1.000001,
    )
    require_finite_number(
        row.get("raw_aligned_mean"),
        f"{location}.raw_aligned_mean",
        minimum=-1.000001,
        maximum=1.000001,
    )
    require_int(
        row.get("shared_prototype_count"),
        f"{location}.shared_prototype_count",
        minimum=1,
    )


def _validate_output_shape(report: Mapping[str, Any]) -> None:
    require_exact_keys(
        report,
        {
            "audit_mode",
            "authority",
            "candidate_count",
            "candidate_ids",
            "candidates",
            "collision_reference",
            "decision_boundary",
            "input_hashes",
            "record_sha256",
            "record_type",
            "schema_version",
            "summary",
        },
        location="utility report",
    )
    validate_seal(report, location="utility report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != RECORD_TYPE
        or report.get("candidate_count") != EXPECTED_FULL_CANDIDATE_COUNT
    ):
        raise UtilityEvaluationError("utility report header is unsupported")
    audit_mode = report.get("audit_mode")
    if audit_mode not in {"strict_consensus_diagnostic", "formal_utility_evidence"}:
        raise UtilityEvaluationError("utility report audit mode is unsupported")
    authority = require_mapping(report.get("authority"), "authority")
    require_exact_keys(authority, AUTHORITY_FIELDS, location="authority")
    _, expected_mode = _authority({"contracts": {"provisional_full22": authority}})
    if audit_mode != expected_mode:
        raise UtilityEvaluationError("utility report authority/audit mode contradict")

    candidate_ids = require_list(report.get("candidate_ids"), "candidate_ids")
    normalized_ids = [
        require_text(value, f"candidate_ids[{index}]")
        for index, value in enumerate(candidate_ids)
    ]
    candidates = require_list(report.get("candidates"), "candidates")
    if (
        normalized_ids != sorted(normalized_ids)
        or len(normalized_ids) != len(set(normalized_ids))
        or len(candidates) != len(normalized_ids)
    ):
        raise UtilityEvaluationError("utility candidate inventory drifted")
    candidate_id_set = set(normalized_ids)
    kind_counts = {"legacy_15": 0, "challenger_7": 0}
    for index, raw in enumerate(candidates):
        row = require_mapping(raw, f"candidates[{index}]")
        require_exact_keys(
            row,
            {
                "by_priority",
                "by_role",
                "candidate_id",
                "candidate_kind",
                "metrics",
                "prototype_projection_collision",
                "recommendation",
            },
            location=f"candidates[{index}]",
        )
        candidate_id = require_text(
            row.get("candidate_id"), f"candidates[{index}].candidate_id"
        )
        if candidate_id != normalized_ids[index]:
            raise UtilityEvaluationError("utility candidate row order drifted")
        kind = row.get("candidate_kind")
        if kind not in kind_counts:
            raise UtilityEvaluationError("utility candidate kind is unsupported")
        kind_counts[str(kind)] += 1
        _validate_metric_block(
            row.get("metrics"), location=f"candidates[{index}].metrics"
        )
        priorities = require_mapping(
            row.get("by_priority"), f"candidates[{index}].by_priority"
        )
        require_exact_keys(
            priorities, {"0", "1", "2"}, location=f"candidates[{index}].by_priority"
        )
        for priority in ("0", "1", "2"):
            _validate_metric_block(
                priorities.get(priority),
                location=f"candidates[{index}].by_priority.{priority}",
            )
        roles = require_mapping(row.get("by_role"), f"candidates[{index}].by_role")
        require_exact_keys(
            roles, set(trainer.ROLE_VALUES), location=f"candidates[{index}].by_role"
        )
        for role in trainer.ROLE_VALUES:
            _validate_metric_block(
                roles.get(role), location=f"candidates[{index}].by_role.{role}"
            )
        collision = require_mapping(
            row.get("prototype_projection_collision"),
            f"candidates[{index}].prototype_projection_collision",
        )
        require_exact_keys(
            collision,
            {"auxiliary_collision_flag", "nearest_any", "nearest_legacy"},
            location=f"candidates[{index}].prototype_projection_collision",
        )
        require_bool(
            collision.get("auxiliary_collision_flag"),
            f"candidates[{index}].prototype_projection_collision.auxiliary_collision_flag",
        )
        _validate_nearest(
            collision.get("nearest_any"),
            location=f"candidates[{index}].prototype_projection_collision.nearest_any",
            candidate_id=candidate_id,
            candidate_ids=candidate_id_set,
        )
        _validate_nearest(
            collision.get("nearest_legacy"),
            location=f"candidates[{index}].prototype_projection_collision.nearest_legacy",
            candidate_id=candidate_id,
            candidate_ids=candidate_id_set,
        )
        recommendation = require_mapping(
            row.get("recommendation"), f"candidates[{index}].recommendation"
        )
        require_exact_keys(
            recommendation,
            {
                "action",
                "active_release_eligible",
                "deletion_allowed",
                "reason",
                "terminal",
            },
            location=f"candidates[{index}].recommendation",
        )
        if (
            recommendation.get("terminal") is not False
            or recommendation.get("deletion_allowed") is not False
            or recommendation.get("active_release_eligible") is not False
        ):
            raise UtilityEvaluationError(
                "utility report attempted a catalog disposition"
            )
        if report.get("audit_mode") == "strict_consensus_diagnostic" and (
            recommendation.get("action") != "diagnostic_only"
            or recommendation.get("reason") != "pending_formal_adjudication"
        ):
            raise UtilityEvaluationError("strict audit escaped diagnostic-only state")
        if report.get("audit_mode") == "formal_utility_evidence" and (
            recommendation.get("action") != "evidence_only"
            or not isinstance(recommendation.get("reason"), str)
        ):
            raise UtilityEvaluationError("formal utility audit emitted a disposition")
    if kind_counts != {
        "legacy_15": EXPECTED_REFERENCE_CANDIDATE_COUNT,
        "challenger_7": EXPECTED_FULL_CANDIDATE_COUNT
        - EXPECTED_REFERENCE_CANDIDATE_COUNT,
    }:
        raise UtilityEvaluationError("utility candidate kind counts drifted")

    collision_reference = require_mapping(
        report.get("collision_reference"), "collision_reference"
    )
    require_exact_keys(
        collision_reference,
        {
            "deletion_authority",
            "interpretation",
            "legacy_pair_count",
            "legacy_projected_aligned_mean_p99",
            "pair_count",
            "pair_metrics_sha256",
        },
        location="collision_reference",
    )
    if (
        collision_reference.get("deletion_authority") is not False
        or collision_reference.get("interpretation") != "auxiliary_collision_flag_only"
        or require_int(
            collision_reference.get("legacy_pair_count"),
            "collision_reference.legacy_pair_count",
            minimum=1,
        )
        != EXPECTED_REFERENCE_CANDIDATE_COUNT
        * (EXPECTED_REFERENCE_CANDIDATE_COUNT - 1)
        // 2
        or require_int(
            collision_reference.get("pair_count"),
            "collision_reference.pair_count",
            minimum=1,
        )
        != EXPECTED_FULL_CANDIDATE_COUNT * (EXPECTED_FULL_CANDIDATE_COUNT - 1) // 2
    ):
        raise UtilityEvaluationError("collision reference contract drifted")
    require_finite_number(
        collision_reference.get("legacy_projected_aligned_mean_p99"),
        "collision_reference.legacy_projected_aligned_mean_p99",
        minimum=-1.000001,
        maximum=1.000001,
    )
    require_sha(
        collision_reference.get("pair_metrics_sha256"),
        "collision_reference.pair_metrics_sha256",
    )

    boundary = require_mapping(report.get("decision_boundary"), "decision_boundary")
    require_exact_keys(
        boundary,
        {"catalog_disposition_emitted", "deletion_allowed", "reason", "status"},
        location="decision_boundary",
    )
    expected_boundary = (
        {
            "catalog_disposition_emitted": False,
            "deletion_allowed": False,
            "reason": "pending_formal_adjudication",
            "status": "diagnostic_only",
        }
        if audit_mode == "strict_consensus_diagnostic"
        else {
            "catalog_disposition_emitted": False,
            "deletion_allowed": False,
            "reason": "evidence_requires_separate_catalog_transition",
            "status": "formal_evidence_only",
        }
    )
    if dict(boundary) != expected_boundary:
        raise UtilityEvaluationError("utility decision boundary drifted")

    input_hashes = require_mapping(report.get("input_hashes"), "input_hashes")
    require_exact_keys(input_hashes, INPUT_HASH_FIELDS, location="input_hashes")
    for name in sorted(INPUT_HASH_FIELDS):
        require_sha(input_hashes.get(name), f"input_hashes.{name}")

    summary = require_mapping(report.get("summary"), "summary")
    require_exact_keys(
        summary,
        {
            "baseline_validation_metrics_sha256",
            "challenger_count",
            "challenger_top1_usage_count",
            "challenger_top3_usage_count",
            "formal_calibration_gate_passed",
            "legacy_candidate_count",
            "sample_count",
            "successor_validation_metrics_sha256",
            "validation_sample_count",
        },
        location="summary",
    )
    require_sha(
        summary.get("baseline_validation_metrics_sha256"),
        "summary.baseline_validation_metrics_sha256",
    )
    require_sha(
        summary.get("successor_validation_metrics_sha256"),
        "summary.successor_validation_metrics_sha256",
    )
    if (
        require_int(summary.get("challenger_count"), "summary.challenger_count") != 7
        or require_int(
            summary.get("legacy_candidate_count"), "summary.legacy_candidate_count"
        )
        != EXPECTED_REFERENCE_CANDIDATE_COUNT
        or require_bool(
            summary.get("formal_calibration_gate_passed"),
            "summary.formal_calibration_gate_passed",
        )
        is not authority.get("formal_calibration_gate_passed")
    ):
        raise UtilityEvaluationError("utility summary contract drifted")
    for field in (
        "challenger_top1_usage_count",
        "challenger_top3_usage_count",
        "sample_count",
        "validation_sample_count",
    ):
        require_int(summary.get(field), f"summary.{field}")


def build_report(
    *,
    training_export_dir: Path,
    trainer_output_dir: Path,
    feature_cache_dir: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    ordinary_reference_output_dir: Path,
) -> dict[str, Any]:
    export_root = _regular_directory(training_export_dir, location="training export")
    manifest_path = export_root / "manifest.json"
    samples_path = export_root / "samples.jsonl"
    listwise_path = export_root / "listwise.jsonl"
    manifest = read_json(manifest_path, location="training export manifest")
    try:
        export = offline.load_export(manifest_path, samples_path, listwise_path)
    except offline.EvaluationError as error:
        raise UtilityEvaluationError(
            f"training export validation failed: {error}"
        ) from error
    if len(export.candidate_ids) != EXPECTED_FULL_CANDIDATE_COUNT:
        raise UtilityEvaluationError("utility audit requires exactly 22 candidates")
    authority, audit_mode = _authority(manifest)
    successor = _load_trainer_bundle(trainer_output_dir, location="successor trainer")
    successor_ids = _candidate_ids(successor.contract, location="successor")
    if successor_ids != export.candidate_ids:
        raise UtilityEvaluationError("successor vocabulary differs from full-22 export")
    model_inputs = require_mapping(successor.contract.get("inputs"), "successor.inputs")
    if model_inputs.get("training_export_manifest_sha256") != export.manifest_sha256:
        raise UtilityEvaluationError("successor/training export binding failed")
    _validate_registry(
        catalog_registry,
        expected_sha256=require_sha(
            model_inputs.get("catalog_registry_sha256"),
            "successor.inputs.catalog_registry_sha256",
        ),
        manifest_inputs=require_mapping(
            manifest.get("input_hashes"), "manifest.input_hashes"
        ),
    )
    _, render_sha = _validate_render_bank(
        render_bank_manifest,
        expected_sha256=require_sha(
            model_inputs.get("render_bank_manifest_sha256"),
            "successor.inputs.render_bank_manifest_sha256",
        ),
        expected_font_catalog_sha256=export.font_catalog_sha256,
        candidate_ids=export.candidate_ids,
        manifest=manifest,
    )
    cache = _load_cache(
        feature_cache_dir,
        model_contract=successor.contract,
        model_inputs=model_inputs,
        candidate_ids=export.candidate_ids,
    )
    infos = _load_sample_infos(export, samples_path)
    reference, legacy_ids, baseline_metrics = _load_reference(
        ordinary_reference_output_dir,
        successor=successor,
        full_candidate_ids=export.candidate_ids,
        expected_priority2_sample_count=sum(
            info.target.split == "val" and info.priority == 2 for info in infos
        ),
    )
    try:
        predictions = offline.load_predictions(
            successor.root / "predictions-val.jsonl",
            export=export,
            evaluation_split="val",
            require_semantics=True,
        )
    except offline.EvaluationError as error:
        raise UtilityEvaluationError(
            f"successor predictions failed validation: {error}"
        ) from error
    if predictions.model_sha256 != successor.checkpoint_sha256:
        raise UtilityEvaluationError("prediction/checkpoint identity mismatch")
    collision_reference, collision_by_candidate = _collision_evidence(
        cache=cache,
        checkpoint_path=successor.checkpoint_path,
        candidate_ids=export.candidate_ids,
        legacy_ids=legacy_ids,
    )
    legacy_set = set(legacy_ids)
    candidate_rows = []
    for candidate_id in export.candidate_ids:
        metrics = _metric_block(
            candidate_id=candidate_id,
            infos=infos,
            predictions=predictions.predictions,
            legacy_ids=legacy_set,
        )
        by_priority = {
            str(priority): _metric_block(
                candidate_id=candidate_id,
                infos=[info for info in infos if info.priority == priority],
                predictions=predictions.predictions,
                legacy_ids=legacy_set,
            )
            for priority in sorted(trainer.PRIORITY_TARGET_MIX)
        }
        by_role = {
            role: _metric_block(
                candidate_id=candidate_id,
                infos=[info for info in infos if info.target.role == role],
                predictions=predictions.predictions,
                legacy_ids=legacy_set,
            )
            for role in trainer.ROLE_VALUES
        }
        candidate_rows.append(
            {
                "by_priority": by_priority,
                "by_role": by_role,
                "candidate_id": candidate_id,
                "candidate_kind": (
                    "legacy_15" if candidate_id in legacy_set else "challenger_7"
                ),
                "metrics": metrics,
                "prototype_projection_collision": collision_by_candidate[candidate_id],
                "recommendation": _recommendation(
                    audit_mode=audit_mode,
                    candidate_id=candidate_id,
                    is_legacy=candidate_id in legacy_set,
                    metrics=metrics,
                ),
            }
        )
    val_count = sum(info.target.split == "val" for info in infos)
    challenger_rows = [
        row for row in candidate_rows if row["candidate_kind"] == "challenger_7"
    ]
    best_metrics = require_mapping(
        require_mapping(successor.report.get("training"), "successor.training").get(
            "best_validation_metrics"
        ),
        "successor.best_validation_metrics",
    )
    core = {
        "audit_mode": audit_mode,
        "authority": copy.deepcopy(dict(authority)),
        "candidate_count": len(export.candidate_ids),
        "candidate_ids": list(export.candidate_ids),
        "candidates": candidate_rows,
        "collision_reference": collision_reference,
        "decision_boundary": {
            "catalog_disposition_emitted": False,
            "deletion_allowed": False,
            "reason": (
                "pending_formal_adjudication"
                if audit_mode == "strict_consensus_diagnostic"
                else "evidence_requires_separate_catalog_transition"
            ),
            "status": (
                "diagnostic_only"
                if audit_mode == "strict_consensus_diagnostic"
                else "formal_evidence_only"
            ),
        },
        "input_hashes": {
            "catalog_registry_sha256": sha256_file(catalog_registry),
            "feature_cache_manifest_sha256": cache.manifest_sha256,
            "ordinary_reference_checkpoint_sha256": reference.checkpoint_sha256,
            "ordinary_reference_model_contract_sha256": reference.contract_sha256,
            "ordinary_reference_output_marker_sha256": sha256_file(
                reference.root / ".font-matching-siglip-baseline-owned.json"
            ),
            "ordinary_reference_predictions_sha256": reference.predictions_sha256,
            "ordinary_reference_report_sha256": reference.report_sha256,
            "render_bank_manifest_sha256": render_sha,
            "successor_checkpoint_sha256": successor.checkpoint_sha256,
            "successor_model_contract_sha256": successor.contract_sha256,
            "successor_predictions_sha256": successor.predictions_sha256,
            "successor_report_sha256": successor.report_sha256,
            "training_export_manifest_sha256": export.manifest_sha256,
            "training_export_samples_sha256": sha256_file(samples_path),
        },
        "record_type": RECORD_TYPE,
        "schema_version": SCHEMA_VERSION,
        "summary": {
            "baseline_validation_metrics_sha256": sha256_bytes(
                canonical_json_bytes(baseline_metrics).rstrip(b"\n")
            ),
            "challenger_count": len(challenger_rows),
            "challenger_top1_usage_count": sum(
                row["metrics"]["validation_prediction"]["top1_usage_count"]
                for row in challenger_rows
            ),
            "challenger_top3_usage_count": sum(
                row["metrics"]["validation_prediction"]["top3_usage_count"]
                for row in challenger_rows
            ),
            "formal_calibration_gate_passed": authority[
                "formal_calibration_gate_passed"
            ],
            "legacy_candidate_count": len(legacy_ids),
            "sample_count": len(infos),
            "successor_validation_metrics_sha256": sha256_bytes(
                canonical_json_bytes(best_metrics).rstrip(b"\n")
            ),
            "validation_sample_count": val_count,
        },
    }
    report = seal(core)
    _validate_output_shape(report)
    return report


def _write_atomic(path: Path, payload: bytes) -> None:
    output = path.resolve()
    if output.exists() and (output.is_symlink() or not output.is_file()):
        raise UtilityEvaluationError("output must be a regular file")
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.staging-", dir=output.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def build_output(*, output: Path, **kwargs: Any) -> Mapping[str, Any]:
    report = build_report(**kwargs)
    _write_atomic(output, canonical_json_bytes(report, pretty=True))
    return {
        "audit_mode": report["audit_mode"],
        "candidate_count": report["candidate_count"],
        "output": str(output.resolve()),
        "record_sha256": report["record_sha256"],
        "status": "built",
    }


def validate_output(*, output: Path, **kwargs: Any) -> Mapping[str, Any]:
    actual = read_json(output.resolve(), location="utility output")
    _validate_output_shape(actual)
    expected = build_report(**kwargs)
    if actual != expected:
        raise UtilityEvaluationError("utility output differs from bound inputs")
    return {
        "audit_mode": actual["audit_mode"],
        "candidate_count": actual["candidate_count"],
        "output": str(output.resolve()),
        "record_sha256": actual["record_sha256"],
        "status": "valid",
    }


def _add_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--training-export-dir", type=Path, required=True)
    parser.add_argument("--trainer-output-dir", type=Path, required=True)
    parser.add_argument("--feature-cache-dir", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--ordinary-reference-output-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=CLI_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="build a sealed utility audit")
    validate = commands.add_parser("validate", help="recompute and validate an audit")
    _add_inputs(build)
    _add_inputs(validate)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    kwargs = {
        "training_export_dir": args.training_export_dir,
        "trainer_output_dir": args.trainer_output_dir,
        "feature_cache_dir": args.feature_cache_dir,
        "catalog_registry": args.catalog_registry,
        "render_bank_manifest": args.render_bank_manifest,
        "ordinary_reference_output_dir": args.ordinary_reference_output_dir,
    }
    try:
        result = (
            build_output(output=args.output, **kwargs)
            if args.command == "build"
            else validate_output(output=args.output, **kwargs)
        )
    except (UtilityEvaluationError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    sys.stdout.buffer.write(canonical_json_bytes(result, pretty=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
