#!/usr/bin/env python3
"""Attach a sealed selection calibration to an existing runtime bundle.

The source bundle is immutable input.  This tool verifies its exact inventory,
owner marker, record seals, artifact descriptors, and candidate/model bindings,
then copies the verified bytes into a fresh staging directory.  Only the new
runtime contract and owner marker are rewritten, and the staging directory is
atomically published to a previously nonexistent output path.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence


RUNTIME_SCHEMA_VERSION = "font-matching-runtime-artifact-v1"
RUNTIME_SCHEMA_VERSION_V2 = "font-matching-runtime-artifact-v2"
RUNTIME_RECORD_TYPE = "font_matching_runtime_artifact"
RUNTIME_OWNER = "carrot-manga-translator/font-matching-runtime-artifact"
RUNTIME_OWNER_V2 = "carrot-manga-translator/font-matching-runtime-artifact-v2"
ACTIVE_CATALOG_SCHEMA_VERSION = "font-matching-auto-match-active-catalog-v1"
ACTIVE_CATALOG_RECORD_TYPE = "font_matching_auto_match_active_catalog"
SELECTION_CALIBRATION_SCHEMA_VERSION = "font-matching-selection-calibration-v1"
SELECTION_CALIBRATION_SCHEMA_VERSION_V2 = "font-matching-selection-calibration-v2"
SELECTION_CALIBRATION_RECORD_TYPE = "font_matching_selection_calibration"
RELEASE_ACCEPTANCE_SCHEMA_VERSION = "font-matching-runtime-release-acceptance-v1"
RELEASE_ACCEPTANCE_RECORD_TYPE = "font_matching_runtime_release_acceptance"
EVALUATION_ONLY_SCHEMA_VERSION = "font-matching-evaluation-only-runtime-v1"
EVALUATION_ONLY_CONTRACT_KEY = "evaluation_only_runtime"
V8_PACKAGING_CONTRACT_KEY = "v8_runtime_packaging"
EVALUATION_ONLY_PACKAGING_KEYS = frozenset(
    {
        "evaluation_only",
        "loader_opt_in_required",
        "non_promotable",
        "qa_only",
        "release_approved",
    }
)

MARKER_FILE = ".font-matching-runtime-artifact-owned.json"
CONTRACT_FILE = "runtime-contract.json"
ACTIVE_CATALOG_FILE = "auto-match-active-catalog.json"
SELECTION_CALIBRATION_FILE = "selection-calibration.json"
ENCODER_FILE = "encoder.onnx"
RANKER_FILE = "ranker.onnx"
PROTOTYPE_FILE = "prototype-features.f32"

BASE_ASSET_FILES = (
    ACTIVE_CATALOG_FILE,
    ENCODER_FILE,
    RANKER_FILE,
    PROTOTYPE_FILE,
)
ATTACHED_ASSET_FILES = (*BASE_ASSET_FILES, SELECTION_CALIBRATION_FILE)
BASE_BUNDLE_FILES = frozenset((MARKER_FILE, CONTRACT_FILE, *BASE_ASSET_FILES))
ATTACHED_BUNDLE_FILES = frozenset(
    (MARKER_FILE, CONTRACT_FILE, *ATTACHED_ASSET_FILES)
)
MARKER_KEYS = frozenset({"artifacts", "owner", "safe_replace", "schema_version"})
QA_ONLY_MARKER_KEYS = frozenset((*MARKER_KEYS, "qa_only", "release_approved"))
CALIBRATION_BINDING_KEYS = frozenset(
    {
        "model_version",
        "candidate_order_sha256",
        "encoder_sha256",
        "ranker_sha256",
        "prototype_features_sha256",
        "catalog_registry_record_sha256",
        "catalog_registry_sha256",
        "frozen_split_map_sha256",
        "master_manifest_sha256",
        "master_report_sha256",
        "master_split_map_sha256",
        "finals_sha256",
        "runtime_contract_sha256",
    }
)
CALIBRATION_CORE_KEYS = frozenset(
    {
        "schema_version",
        "record_type",
        "record_sha256",
        "bindings",
        "candidate_ids",
        "feature_names",
        "feature_contract",
        "scaler",
        "logistic",
        "operating_points",
        "training_boundary",
        "leakage_audit",
        "oof_report",
    }
)
CONTINUOUS_FEATURE_NAMES = (
    "ranker_centered_logit",
    "ranker_z_logit",
    "ranker_probability",
    "ranker_log_probability",
    "ranker_rank_fraction",
    "ranker_gap_to_top",
    "ranker_is_top1",
    "ranker_is_top3",
    "ranker_entropy",
    "ranker_top3_mass",
    "ranker_margin_1_2",
    "none_logit",
    "none_probability",
    "role_body_mass",
    "role_variant_mass",
    "role_max_probability",
    "role_entropy",
    "style_serifness",
    "style_weight",
    "style_width",
    "style_slant",
    "style_handwritten",
    "style_irregularity",
    "style_energy",
    "orientation_horizontal",
    "orientation_vertical",
    "orientation_mixed",
    "orientation_unknown",
    "orientation_entropy",
    "view_gate_raw",
    "view_gate_context",
    "view_gate_glyph",
    "view_gate_entropy",
    "proto_mean_raw",
    "proto_mean_context",
    "proto_mean_glyph",
    "proto_lme_raw",
    "proto_lme_context",
    "proto_lme_glyph",
    "proto_gate_weighted_mean",
    "proto_cross_view_min",
    "proto_cross_view_std",
    "proto_rank_fraction",
    "proto_gap_to_best",
    "prototype_bag_count_fraction",
)
CONTINUOUS_FEATURE_COUNT = len(CONTINUOUS_FEATURE_NAMES)
MIN_NORMAL_COVERAGE_TARGET = 0.90
MIN_DEPLOYMENT_GLOBAL_PREFERRED_AT1 = 0.45
MIN_DEPLOYMENT_VARIANT_PREFERRED_AT1 = 0.50
OPERATING_POINT_FAMILIES = ("body", "variant", "global")
OPERATING_POINT_KEYS = frozenset(
    {
        "enabled",
        "selection_score_threshold",
        "coverage_target",
        "coverage_floor_passed",
        "precision_target",
        "precision_target_passed",
        "risk_lcb",
        "cohort_count",
        "accepted_count",
        "eligible_count",
        "normal_sample_count",
        "normal_accepted_count",
        "none_sample_count",
        "none_false_accept_count",
        "none_abstained_count",
        "hit_count",
        "miss_count",
        "coverage",
        "acceptable_at1",
        "preferred_at1",
        "overall_decision_accuracy",
        "none_abstention_rate",
    }
)
FEATURE_CONTRACT = {
    "candidate_scope": "original_onnx_top3_only",
    "entropy": "-sum(p*ln(p))/ln(category_count), epsilon=1e-8",
    "gap_sign": "candidate_minus_best_nonpositive",
    "log_probability": "natural_log_of_temperature_softmax_plus_1e-8",
    "prototype_lme": "ln(mean(exp(10*cosine)))/10",
    "prototype_rank_basis": "view_gate_weighted_prototype_bag_mean_cosine",
    "rank_fraction": "(zero_based_rank)/(candidate_count-1)",
    "runtime_temperature_applied": True,
    "schema_version": "font-matching-selection-features-v1",
    "view_gate": "ranker_output_already_softmax_normalized",
    "z_logit": "(logit-row_mean)/max(population_std_ddof0,1e-6)",
    "prototype_bag_count_fraction": "bag_count/max_candidate_bag_count",
}
TRAINING_BOUNDARY_KEYS = frozenset(
    {
        "split",
        "sample_count",
        "work_count",
        "work_ids_sha256",
        "sample_ids_sha256",
        "candidate_rows_sha256",
        "none_sample_count",
        "supervision",
    }
)
LEAKAGE_AUDIT_KEYS = frozenset(
    {
        "allowed_split",
        "allowed_work_count",
        "allowed_sample_count",
        "candidate_row_count",
        "excluded_unrenderable_candidate_rows",
        "non_val_label_rows_parsed",
        "test_rows_used_for_fit",
        "train_rows_used_for_fit",
        "pseudo_label_rows_used_for_fit",
        "gold_final_rows_used_for_fit",
        "work_group_oof",
        "nested_hyperparameter_selection",
        "split_component_isolation_passed",
        "normalized_glyph_isolation_passed",
        "source_page_isolation_passed",
    }
)
OOF_REPORT_KEYS = frozenset(
    {
        "candidate_log_loss",
        "candidate_roc_auc",
        "folds",
        "nested_operating_evaluation",
        "full_oof",
        "selected_C_values",
        "final_C",
        "fit_implementation",
    }
)
OOF_FOLD_KEYS = frozenset(
    {
        "held_out_work_id_sha256",
        "C",
        "candidate_row_count",
        "candidate_log_loss",
    }
)
SUPERVISION_KEYS = frozenset(
    {
        "tier",
        "allowed_resolution_kinds",
        "gold_final_sample_count",
        "pseudo_label_sample_count",
        "pseudo_labels_forbidden",
    }
)
FIT_IMPLEMENTATION = {
    "solver": "lbfgs",
    "penalty": "l2",
    "max_iter": 3000,
    "tol": 1e-9,
    "standardization": "train_fold_population_mean_std_ddof0",
}


class SelectionCalibrationAttachError(ValueError):
    """Raised when a bundle cannot be safely verified or published."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    record = copy.deepcopy(dict(core))
    record["record_sha256"] = sha256_bytes(
        canonical_json(core).encode("utf-8")
    )
    return record


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = _require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise SelectionCalibrationAttachError(f"{location}: record seal mismatch")
    return actual


def _read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise SelectionCalibrationAttachError(f"{location}: file is missing or linked")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SelectionCalibrationAttachError(
            f"{location}: invalid JSON: {error}"
        ) from error
    return dict(_require_mapping(value, location))


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SelectionCalibrationAttachError(f"{location}: expected an object")
    return value


def _require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise SelectionCalibrationAttachError(f"{location}: expected a list")
    return value


def _require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SelectionCalibrationAttachError(f"{location}: expected non-empty text")
    return value.strip()


def _require_sha(value: Any, location: str) -> str:
    text = _require_text(value, location).lower()
    if len(text) != 64 or any(
        character not in "0123456789abcdef" for character in text
    ):
        raise SelectionCalibrationAttachError(
            f"{location}: expected a SHA-256 digest"
        )
    return text


def _require_integer(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise SelectionCalibrationAttachError(
            f"{location}: expected integer >= {minimum}"
        )
    return value


def _require_finite(
    value: Any, location: str, *, minimum: float | None = None
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SelectionCalibrationAttachError(f"{location}: expected finite number")
    result = float(value)
    if not math.isfinite(result) or (minimum is not None and result < minimum):
        raise SelectionCalibrationAttachError(f"{location}: invalid numeric value")
    return result


def _require_probability(value: Any, location: str) -> float:
    result = _require_finite(value, location)
    if result < 0.0 or result > 1.0:
        raise SelectionCalibrationAttachError(
            f"{location}: probability must be in [0, 1]"
        )
    return result


def _ordered_values_sha256(values: Sequence[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _artifact_descriptor(path: Path, *, file_name: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise SelectionCalibrationAttachError(
            f"runtime artifact is missing or linked: {file_name}"
        )
    size = path.stat().st_size
    if size < 1:
        raise SelectionCalibrationAttachError(f"runtime artifact is empty: {file_name}")
    return {"byte_size": size, "file": file_name, "sha256": sha256_file(path)}


def _validate_exact_inventory(
    root: Path, expected: frozenset[str], *, location: str
) -> None:
    if root.is_symlink() or not root.is_dir():
        raise SelectionCalibrationAttachError(
            f"{location}: directory is missing or linked"
        )
    entries = list(root.iterdir())
    names = {entry.name for entry in entries}
    if names != expected:
        missing = sorted(expected - names)
        extra = sorted(names - expected)
        raise SelectionCalibrationAttachError(
            f"{location}: exact inventory mismatch; missing={missing} extra={extra}"
        )
    invalid = sorted(
        entry.name for entry in entries if entry.is_symlink() or not entry.is_file()
    )
    if invalid:
        raise SelectionCalibrationAttachError(
            f"{location}: inventory contains linked or non-file entries: {invalid}"
        )


def _validate_marker(
    root: Path,
    *,
    expected_asset_files: Sequence[str],
    location: str,
    allow_qa_only: bool = False,
) -> Mapping[str, Any]:
    marker = _read_json(root / MARKER_FILE, location=f"{location} marker")
    marker_keys = set(marker)
    if marker_keys == MARKER_KEYS:
        qa_only = False
    elif marker_keys == QA_ONLY_MARKER_KEYS:
        if marker.get("qa_only") is not True or marker.get("release_approved") is not False:
            raise SelectionCalibrationAttachError(
                f"{location}: QA-only marker flags are invalid"
            )
        if not allow_qa_only:
            raise SelectionCalibrationAttachError(
                f"{location}: QA-only runtime requires explicit validation permission"
            )
        qa_only = True
    else:
        raise SelectionCalibrationAttachError(f"{location}: marker schema drifted")
    schema = marker.get("schema_version")
    if marker.get("owner") != _runtime_owner(schema) or marker.get(
        "safe_replace"
    ) is not True:
        raise SelectionCalibrationAttachError(f"{location}: marker ownership failed")
    artifacts = _require_mapping(marker.get("artifacts"), f"{location}.artifacts")
    expected_hash_names = {CONTRACT_FILE, *expected_asset_files}
    if set(artifacts) != expected_hash_names:
        raise SelectionCalibrationAttachError(
            f"{location}: marker artifact inventory drifted"
        )
    for file_name in sorted(expected_hash_names):
        expected_hash = _require_sha(
            artifacts.get(file_name), f"{location}.artifacts.{file_name}"
        )
        if sha256_file(root / file_name) != expected_hash:
            raise SelectionCalibrationAttachError(
                f"{location}: artifact hash mismatch: {file_name}"
            )
    if qa_only and marker.get("release_approved") is not False:
        raise SelectionCalibrationAttachError(
            f"{location}: QA-only runtime cannot be release-approved"
        )
    return marker


def _runtime_owner(schema: Any) -> str | None:
    if schema == RUNTIME_SCHEMA_VERSION:
        return RUNTIME_OWNER
    if schema == RUNTIME_SCHEMA_VERSION_V2:
        return RUNTIME_OWNER_V2
    return None


def _validate_candidate_ids(value: Any, *, location: str) -> tuple[str, ...]:
    candidate_ids = tuple(
        _require_text(item, f"{location}[{index}]")
        for index, item in enumerate(_require_list(value, location))
    )
    if not candidate_ids or len(candidate_ids) != len(set(candidate_ids)):
        raise SelectionCalibrationAttachError(
            f"{location}: candidate ids must be non-empty and unique"
        )
    return candidate_ids


def _validate_active_catalog(path: Path) -> dict[str, Any]:
    catalog = _read_json(path, location="runtime active catalog")
    validate_record_seal(catalog, location="runtime active catalog")
    if (
        catalog.get("schema_version") != ACTIVE_CATALOG_SCHEMA_VERSION
        or catalog.get("record_type") != ACTIVE_CATALOG_RECORD_TYPE
    ):
        raise SelectionCalibrationAttachError("active catalog schema is unsupported")
    candidate_ids = _validate_candidate_ids(
        catalog.get("candidate_ids"), location="active catalog.candidate_ids"
    )
    if (
        catalog.get("candidate_count") != len(candidate_ids)
        or catalog.get("candidate_order_sha256")
        != _ordered_values_sha256(candidate_ids)
    ):
        raise SelectionCalibrationAttachError("active catalog candidate order failed")
    catalog["_validated_candidate_ids"] = candidate_ids
    return catalog


def _validate_contract(
    root: Path,
    *,
    active_catalog: Mapping[str, Any],
    expected_asset_files: Sequence[str],
) -> dict[str, Any]:
    contract = _read_json(root / CONTRACT_FILE, location="runtime contract")
    validate_record_seal(contract, location="runtime contract")
    schema = contract.get("schema_version")
    if _runtime_owner(schema) is None or contract.get(
        "record_type"
    ) != RUNTIME_RECORD_TYPE:
        raise SelectionCalibrationAttachError("runtime contract schema is unsupported")
    candidate_ids = tuple(active_catalog["_validated_candidate_ids"])
    catalog = _require_mapping(contract.get("catalog"), "runtime contract.catalog")
    contract_candidates = _validate_candidate_ids(
        catalog.get("candidate_ids"), location="runtime contract.catalog.candidate_ids"
    )
    if (
        contract_candidates != candidate_ids
        or catalog.get("candidate_count") != len(candidate_ids)
        or catalog.get("candidate_order_sha256")
        != _ordered_values_sha256(candidate_ids)
        or catalog.get("catalog_version") != active_catalog.get("catalog_version")
        or catalog.get("active_catalog_record_sha256")
        != active_catalog.get("record_sha256")
    ):
        raise SelectionCalibrationAttachError("runtime catalog binding failed")
    _require_sha(
        catalog.get("catalog_registry_sha256"),
        "runtime contract.catalog.catalog_registry_sha256",
    )
    _require_text(contract.get("model_version"), "runtime contract.model_version")
    artifacts = _require_mapping(
        contract.get("artifacts"), "runtime contract.artifacts"
    )
    if set(artifacts) != set(expected_asset_files):
        raise SelectionCalibrationAttachError(
            "runtime contract artifact inventory drifted"
        )
    descriptors: dict[str, Mapping[str, Any]] = {}
    for file_name in expected_asset_files:
        descriptor = _require_mapping(
            artifacts.get(file_name), f"runtime contract.artifacts.{file_name}"
        )
        actual = _artifact_descriptor(root / file_name, file_name=file_name)
        if dict(descriptor) != actual:
            raise SelectionCalibrationAttachError(
                f"runtime contract descriptor drifted: {file_name}"
            )
        descriptors[file_name] = descriptor
    encoder = _require_mapping(contract.get("encoder"), "runtime contract.encoder")
    head = _require_mapping(contract.get("head"), "runtime contract.head")
    if encoder.get("onnx_sha256") != descriptors[ENCODER_FILE]["sha256"]:
        raise SelectionCalibrationAttachError("runtime encoder hash binding failed")
    if head.get("onnx_sha256") != descriptors[RANKER_FILE]["sha256"]:
        raise SelectionCalibrationAttachError("runtime ranker hash binding failed")
    _validate_hybrid_contract(contract)
    return contract


def _validate_hybrid_contract(contract: Mapping[str, Any]) -> None:
    schema = contract.get("schema_version")
    routing = contract.get("hybrid_score_routing")
    if schema == RUNTIME_SCHEMA_VERSION:
        if routing is not None:
            raise SelectionCalibrationAttachError("v1 runtime declares hybrid routing")
        return
    value = _require_mapping(routing, "runtime contract.hybrid_score_routing")
    batching = _require_mapping(
        contract.get("runtime_batching"), "runtime contract.runtime_batching"
    )
    expected_body = ["dialogue", "narration", "thought"]
    expected_variant = [
        "whisper",
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
        "other",
    ]
    if (
        value.get("schema_version") != "font-matching-hybrid-score-routing-v1"
        or value.get("candidate_scores_compatibility_alias")
        != "body_candidate_scores"
        or value.get("body_candidate_output") != "body_candidate_scores"
        or value.get("variant_candidate_output") != "variant_candidate_scores"
        or value.get("body_roles") != expected_body
        or value.get("variant_roles") != expected_variant
        or value.get("unknown_role_fallback") != "variant_candidate_scores"
        or value.get("role_source")
        != "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)"
        or value.get("selection_feature_source")
        != "selected_candidate_scores_with_legacy256_visual_features"
        or value.get("selection_feature_dim") != 256
        or value.get("row_specific_rules") is not False
        or dict(batching)
        != {
            "encoder_batch_size": 2,
            "ranker_batch_size": 16,
            "parity_qualified": True,
        }
    ):
        raise SelectionCalibrationAttachError("hybrid routing contract drifted")


def _require_optional_probability(
    value: Any, location: str, *, allow_none: bool
) -> float | None:
    if value is None and allow_none:
        return None
    return _require_probability(value, location)


def _validate_operating_point(
    value: Any,
    *,
    location: str,
) -> Mapping[str, Any]:
    point = _require_mapping(value, location)
    enabled = point.get("enabled")
    if set(point) != OPERATING_POINT_KEYS or not isinstance(enabled, bool):
        raise SelectionCalibrationAttachError(f"{location}: invalid operating point")

    threshold = _require_optional_probability(
        point.get("selection_score_threshold"),
        f"{location}.selection_score_threshold",
        allow_none=not enabled,
    )
    coverage_target = _require_probability(
        point.get("coverage_target"), f"{location}.coverage_target"
    )
    if coverage_target < MIN_NORMAL_COVERAGE_TARGET:
        raise SelectionCalibrationAttachError(
            f"{location}: coverage_target must be at least "
            f"{MIN_NORMAL_COVERAGE_TARGET:.2f}"
        )
    coverage_floor_passed = point.get("coverage_floor_passed")
    precision_target_passed = point.get("precision_target_passed")
    if not isinstance(coverage_floor_passed, bool) or not isinstance(
        precision_target_passed, bool
    ):
        raise SelectionCalibrationAttachError(
            f"{location}: operating-point pass flags must be boolean"
        )
    precision_target = _require_probability(
        point.get("precision_target"), f"{location}.precision_target"
    )
    _require_probability(point.get("risk_lcb"), f"{location}.risk_lcb")
    coverage = _require_probability(point.get("coverage"), f"{location}.coverage")
    acceptable_at1 = _require_probability(
        point.get("acceptable_at1"), f"{location}.acceptable_at1"
    )
    preferred_at1 = _require_probability(
        point.get("preferred_at1"), f"{location}.preferred_at1"
    )
    overall_accuracy = _require_probability(
        point.get("overall_decision_accuracy"),
        f"{location}.overall_decision_accuracy",
    )
    none_abstention_rate = _require_probability(
        point.get("none_abstention_rate"),
        f"{location}.none_abstention_rate",
    )

    cohort = _require_integer(point.get("cohort_count"), f"{location}.cohort_count")
    accepted = _require_integer(
        point.get("accepted_count"), f"{location}.accepted_count"
    )
    eligible = _require_integer(
        point.get("eligible_count"), f"{location}.eligible_count"
    )
    normal_samples = _require_integer(
        point.get("normal_sample_count"), f"{location}.normal_sample_count"
    )
    normal_accepted = _require_integer(
        point.get("normal_accepted_count"), f"{location}.normal_accepted_count"
    )
    none_samples = _require_integer(
        point.get("none_sample_count"), f"{location}.none_sample_count"
    )
    none_false_accepts = _require_integer(
        point.get("none_false_accept_count"),
        f"{location}.none_false_accept_count",
    )
    none_abstained = _require_integer(
        point.get("none_abstained_count"), f"{location}.none_abstained_count"
    )
    hits = _require_integer(point.get("hit_count"), f"{location}.hit_count")
    misses = _require_integer(point.get("miss_count"), f"{location}.miss_count")
    if (
        eligible != normal_samples
        or cohort != normal_samples + none_samples
        or normal_accepted > normal_samples
        or none_false_accepts > none_samples
        or none_abstained != none_samples - none_false_accepts
        or accepted != normal_accepted + none_false_accepts
        or hits > normal_accepted
        or hits + misses != accepted
    ):
        raise SelectionCalibrationAttachError(f"{location}: invalid evidence counts")

    expected_coverage = normal_accepted / normal_samples if normal_samples else 0.0
    if not math.isclose(coverage, expected_coverage, rel_tol=0.0, abs_tol=1e-9):
        raise SelectionCalibrationAttachError(
            f"{location}: coverage does not match normal accepted/sample counts"
        )
    expected_acceptable = hits / accepted if accepted else 0.0
    if not math.isclose(
        acceptable_at1, expected_acceptable, rel_tol=0.0, abs_tol=1e-9
    ) or preferred_at1 > acceptable_at1:
        raise SelectionCalibrationAttachError(
            f"{location}: accepted-decision metrics are inconsistent"
        )
    expected_overall_accuracy = (
        (hits + none_abstained) / cohort if cohort else 0.0
    )
    expected_none_abstention = (
        none_abstained / none_samples if none_samples else 1.0
    )
    if not math.isclose(
        overall_accuracy, expected_overall_accuracy, rel_tol=0.0, abs_tol=1e-9
    ) or not math.isclose(
        none_abstention_rate,
        expected_none_abstention,
        rel_tol=0.0,
        abs_tol=1e-9,
    ):
        raise SelectionCalibrationAttachError(
            f"{location}: none/overall decision metrics are inconsistent"
        )
    expected_coverage_pass = normal_samples > 0 and coverage >= coverage_target
    if coverage_floor_passed is not expected_coverage_pass:
        raise SelectionCalibrationAttachError(
            f"{location}: coverage_floor_passed is inconsistent"
        )
    expected_precision_pass = enabled and acceptable_at1 >= precision_target
    if precision_target_passed is not expected_precision_pass:
        raise SelectionCalibrationAttachError(
            f"{location}: precision_target_passed is inconsistent"
        )
    if enabled:
        if threshold is None or normal_samples < 1 or accepted < 1:
            raise SelectionCalibrationAttachError(
                f"{location}: enabled point requires threshold and evidence"
            )
    elif accepted != 0 or threshold is not None:
        raise SelectionCalibrationAttachError(
            f"{location}: disabled point cannot carry a threshold or accept rows"
        )
    return point


def _validate_operating_point_families(
    value: Any,
    *,
    location: str,
    require_global_coverage_floor: bool,
    require_global_fallback: bool,
) -> Mapping[str, Any]:
    points = _require_mapping(value, location)
    if set(points) != set(OPERATING_POINT_FAMILIES):
        raise SelectionCalibrationAttachError(
            f"{location}: operating-point families drifted"
        )
    for family in OPERATING_POINT_FAMILIES:
        _validate_operating_point(
            points.get(family),
            location=f"{location}.{family}",
        )
    global_point = _require_mapping(points.get("global"), f"{location}.global")
    if require_global_fallback and global_point.get("enabled") is not True:
        raise SelectionCalibrationAttachError(
            f"{location}: global calibrated fallback must be enabled"
        )
    if (
        require_global_coverage_floor
        and global_point.get("coverage_floor_passed") is not True
    ):
        raise SelectionCalibrationAttachError(
            f"{location}: global full OOF coverage floor was not met"
        )
    return points


def _require_deployment_quality(
    points: Mapping[str, Any],
    *,
    location: str,
    allow_failed_preferred_precision: bool = False,
) -> None:
    """Reject structurally valid selectors that failed their release evidence."""

    for family, preferred_floor in (
        ("global", MIN_DEPLOYMENT_GLOBAL_PREFERRED_AT1),
        ("variant", MIN_DEPLOYMENT_VARIANT_PREFERRED_AT1),
    ):
        point = _require_mapping(points.get(family), f"{location}.{family}")
        if (
            point.get("enabled") is not True
            or point.get("coverage_floor_passed") is not True
        ):
            raise SelectionCalibrationAttachError(
                f"{location}.{family}: deployment coverage gate failed"
            )
        if allow_failed_preferred_precision:
            continue
        if point.get("precision_target_passed") is not True:
            raise SelectionCalibrationAttachError(
                f"{location}.{family}: deployment precision gate failed"
            )
        preferred = _require_probability(
            point.get("preferred_at1"), f"{location}.{family}.preferred_at1"
        )
        if preferred + 1e-12 < preferred_floor:
            raise SelectionCalibrationAttachError(
                f"{location}.{family}: preferred@1 {preferred:.4f} is below "
                f"the deployment floor {preferred_floor:.4f}"
            )


def _validate_training_and_leakage(
    calibration: Mapping[str, Any],
) -> tuple[int, int, int, int]:
    boundary = _require_mapping(
        calibration.get("training_boundary"),
        "selection calibration.training_boundary",
    )
    if set(boundary) != TRAINING_BOUNDARY_KEYS or boundary.get("split") != "val":
        raise SelectionCalibrationAttachError(
            "selection calibration training boundary drifted"
        )
    sample_count = _require_integer(
        boundary.get("sample_count"),
        "selection calibration.training_boundary.sample_count",
        minimum=1,
    )
    work_count = _require_integer(
        boundary.get("work_count"),
        "selection calibration.training_boundary.work_count",
        minimum=1,
    )
    none_count = _require_integer(
        boundary.get("none_sample_count"),
        "selection calibration.training_boundary.none_sample_count",
    )
    if work_count > sample_count or none_count > sample_count:
        raise SelectionCalibrationAttachError(
            "selection calibration training-boundary counts are inconsistent"
        )
    for key in ("work_ids_sha256", "sample_ids_sha256", "candidate_rows_sha256"):
        _require_sha(
            boundary.get(key), f"selection calibration.training_boundary.{key}"
        )
    supervision = _require_mapping(
        boundary.get("supervision"),
        "selection calibration.training_boundary.supervision",
    )
    if (
        set(supervision) != SUPERVISION_KEYS
        or supervision.get("tier") != "gold_final_only"
        or supervision.get("allowed_resolution_kinds")
        != ["adjudicated", "primary"]
        or supervision.get("gold_final_sample_count") != sample_count
        or supervision.get("pseudo_label_sample_count") != 0
        or supervision.get("pseudo_labels_forbidden") is not True
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration supervision boundary drifted"
        )

    audit = _require_mapping(
        calibration.get("leakage_audit"), "selection calibration.leakage_audit"
    )
    allowed_audit_keys = LEAKAGE_AUDIT_KEYS | {"hybrid_score_route_source"}
    if (
        set(audit) not in {LEAKAGE_AUDIT_KEYS, allowed_audit_keys}
        or audit.get("allowed_split") != "val"
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration leakage-audit schema drifted"
        )
    if "hybrid_score_route_source" in audit and audit.get(
        "hybrid_score_route_source"
    ) not in {
        "predicted_pixel_family_with_single_day_eligibility",
        "sealed_gold_role_family",
        "pixel_shared_scores_role_downstream_only",
    }:
        raise SelectionCalibrationAttachError(
            "selection calibration hybrid route source drifted"
        )
    audit_work_count = _require_integer(
        audit.get("allowed_work_count"),
        "selection calibration.leakage_audit.allowed_work_count",
        minimum=1,
    )
    audit_sample_count = _require_integer(
        audit.get("allowed_sample_count"),
        "selection calibration.leakage_audit.allowed_sample_count",
        minimum=1,
    )
    if audit_work_count != work_count or audit_sample_count != sample_count:
        raise SelectionCalibrationAttachError(
            "selection calibration leakage boundary count mismatch"
        )
    candidate_row_count = _require_integer(
        audit.get("candidate_row_count"),
        "selection calibration.leakage_audit.candidate_row_count",
        minimum=1,
    )
    _require_integer(
        audit.get("excluded_unrenderable_candidate_rows"),
        "selection calibration.leakage_audit.excluded_unrenderable_candidate_rows",
    )
    for key in (
        "non_val_label_rows_parsed",
        "test_rows_used_for_fit",
        "train_rows_used_for_fit",
        "pseudo_label_rows_used_for_fit",
    ):
        if audit.get(key) != 0:
            raise SelectionCalibrationAttachError(
                f"selection calibration leakage boundary failed: {key}"
            )
    if audit.get("gold_final_rows_used_for_fit") != sample_count:
        raise SelectionCalibrationAttachError(
            "selection calibration gold-final fit count drifted"
        )
    for key in (
        "work_group_oof",
        "nested_hyperparameter_selection",
        "split_component_isolation_passed",
        "normalized_glyph_isolation_passed",
        "source_page_isolation_passed",
    ):
        if audit.get(key) is not True:
            raise SelectionCalibrationAttachError(
                f"selection calibration leakage audit failed: {key}"
            )
    return work_count, candidate_row_count, sample_count, none_count


def _validate_oof_report(
    value: Any,
    *,
    operating_points: Mapping[str, Any],
    work_count: int,
    candidate_row_count: int,
    logistic_c: float,
    allow_failed_preferred_precision: bool = False,
) -> None:
    location = "selection calibration.oof_report"
    report = _require_mapping(value, location)
    if set(report) != OOF_REPORT_KEYS:
        raise SelectionCalibrationAttachError(
            "selection calibration OOF report schema drifted"
        )
    fit_implementation = _require_mapping(
        report.get("fit_implementation"), f"{location}.fit_implementation"
    )
    if dict(fit_implementation) != FIT_IMPLEMENTATION:
        raise SelectionCalibrationAttachError(
            "selection calibration fit implementation drifted"
        )
    _require_finite(
        report.get("candidate_log_loss"),
        f"{location}.candidate_log_loss",
        minimum=0.0,
    )
    _require_probability(
        report.get("candidate_roc_auc"), f"{location}.candidate_roc_auc"
    )
    folds = _require_list(report.get("folds"), f"{location}.folds")
    selected_cs = _require_list(
        report.get("selected_C_values"), f"{location}.selected_C_values"
    )
    if len(folds) != work_count or len(selected_cs) != work_count:
        raise SelectionCalibrationAttachError(
            "selection calibration requires one OOF fold per training work"
        )
    held_out_work_hashes: set[str] = set()
    fold_cs: list[float] = []
    folded_candidate_rows = 0
    for index, raw_fold in enumerate(folds):
        fold_location = f"{location}.folds[{index}]"
        fold = _require_mapping(raw_fold, fold_location)
        if set(fold) != OOF_FOLD_KEYS:
            raise SelectionCalibrationAttachError(
                f"{fold_location}: fold schema drifted"
            )
        held_out_work_hashes.add(
            _require_sha(
                fold.get("held_out_work_id_sha256"),
                f"{fold_location}.held_out_work_id_sha256",
            )
        )
        fold_c = _require_finite(
            fold.get("C"), f"{fold_location}.C", minimum=0.0
        )
        if fold_c <= 0.0:
            raise SelectionCalibrationAttachError(
                f"{fold_location}.C must be positive"
            )
        fold_cs.append(fold_c)
        folded_candidate_rows += _require_integer(
            fold.get("candidate_row_count"),
            f"{fold_location}.candidate_row_count",
            minimum=1,
        )
        _require_finite(
            fold.get("candidate_log_loss"),
            f"{fold_location}.candidate_log_loss",
            minimum=0.0,
        )
    if len(held_out_work_hashes) != len(folds):
        raise SelectionCalibrationAttachError(
            "selection calibration OOF held-out work seals must be unique"
        )
    if folded_candidate_rows != candidate_row_count:
        raise SelectionCalibrationAttachError(
            "selection calibration OOF candidate rows do not cover the fit table"
        )
    selected_values = [
        _require_finite(value, f"{location}.selected_C_values[{index}]", minimum=0.0)
        for index, value in enumerate(selected_cs)
    ]
    if any(value <= 0.0 for value in selected_values):
        raise SelectionCalibrationAttachError(
            "selection calibration selected C values must be positive"
        )
    final_c = _require_finite(
        report.get("final_C"), f"{location}.final_C", minimum=0.0
    )
    if final_c <= 0.0:
        raise SelectionCalibrationAttachError(
            "selection calibration final_C must be positive"
        )
    if not math.isclose(final_c, logistic_c, rel_tol=1e-12, abs_tol=1e-15):
        raise SelectionCalibrationAttachError(
            "selection calibration logistic.c does not match OOF final_C"
        )
    if any(
        not math.isclose(value, final_c, rel_tol=1e-12, abs_tol=1e-15)
        for value in fold_cs
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration fixed-C OOF folds drifted from final_C"
        )
    selected_logs = sorted(math.log(value) for value in selected_values)
    middle = len(selected_logs) // 2
    median_log = (
        selected_logs[middle]
        if len(selected_logs) % 2
        else (selected_logs[middle - 1] + selected_logs[middle]) / 2.0
    )
    if not math.isclose(
        final_c, math.exp(median_log), rel_tol=1e-12, abs_tol=1e-15
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration final_C is not the selected-C geometric median"
        )
    nested = _validate_operating_point_families(
        report.get("nested_operating_evaluation"),
        location=f"{location}.nested_operating_evaluation",
        require_global_coverage_floor=False,
        require_global_fallback=False,
    )
    _require_deployment_quality(
        nested,
        location=f"{location}.nested_operating_evaluation",
        allow_failed_preferred_precision=allow_failed_preferred_precision,
    )
    full_oof = _validate_operating_point_families(
        report.get("full_oof"),
        location=f"{location}.full_oof",
        require_global_coverage_floor=True,
        require_global_fallback=True,
    )
    if dict(full_oof) != dict(operating_points):
        raise SelectionCalibrationAttachError(
            "selection calibration operating points do not match full OOF evidence"
        )


def validate_selection_calibration(
    path: Path,
    *,
    contract: Mapping[str, Any],
    runtime_contract_sha256: str,
    allow_failed_preferred_precision: bool = False,
) -> dict[str, Any]:
    calibration = _read_json(path, location="selection calibration")
    validate_record_seal(calibration, location="selection calibration")
    if calibration.get("schema_version") == SELECTION_CALIBRATION_SCHEMA_VERSION_V2:
        return _validate_rank_preserving_selection_calibration(
            calibration,
            contract=contract,
            runtime_contract_sha256=runtime_contract_sha256,
            allow_failed_preferred_precision=allow_failed_preferred_precision,
        )
    if (
        calibration.get("schema_version") != SELECTION_CALIBRATION_SCHEMA_VERSION
        or calibration.get("record_type") != SELECTION_CALIBRATION_RECORD_TYPE
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration schema is unsupported"
        )
    if set(calibration) != CALIBRATION_CORE_KEYS:
        raise SelectionCalibrationAttachError(
            "selection calibration top-level schema drifted"
        )
    catalog = _require_mapping(contract.get("catalog"), "runtime contract.catalog")
    artifacts = _require_mapping(
        contract.get("artifacts"), "runtime contract.artifacts"
    )
    candidate_ids = _validate_candidate_ids(
        calibration.get("candidate_ids"), location="selection calibration.candidate_ids"
    )
    contract_ids = _validate_candidate_ids(
        catalog.get("candidate_ids"), location="runtime contract.catalog.candidate_ids"
    )
    if candidate_ids != contract_ids:
        raise SelectionCalibrationAttachError(
            "selection calibration candidate order mismatch"
        )
    bindings = _require_mapping(
        calibration.get("bindings"), "selection calibration.bindings"
    )
    if set(bindings) != CALIBRATION_BINDING_KEYS:
        raise SelectionCalibrationAttachError(
            "selection calibration binding schema drifted"
        )
    expected_bindings = {
        "model_version": contract.get("model_version"),
        "candidate_order_sha256": catalog.get("candidate_order_sha256"),
        "encoder_sha256": _require_mapping(
            artifacts.get(ENCODER_FILE), f"artifacts.{ENCODER_FILE}"
        ).get("sha256"),
        "ranker_sha256": _require_mapping(
            artifacts.get(RANKER_FILE), f"artifacts.{RANKER_FILE}"
        ).get("sha256"),
        "prototype_features_sha256": _require_mapping(
            artifacts.get(PROTOTYPE_FILE), f"artifacts.{PROTOTYPE_FILE}"
        ).get("sha256"),
        "catalog_registry_sha256": catalog.get("catalog_registry_sha256"),
        "runtime_contract_sha256": _require_sha(
            runtime_contract_sha256, "source runtime contract SHA-256"
        ),
    }
    for key in (
        "catalog_registry_record_sha256",
        "frozen_split_map_sha256",
        "master_manifest_sha256",
        "master_report_sha256",
        "master_split_map_sha256",
        "finals_sha256",
    ):
        _require_sha(bindings.get(key), f"selection calibration.bindings.{key}")
    if any(bindings.get(key) != value for key, value in expected_bindings.items()):
        raise SelectionCalibrationAttachError(
            "selection calibration model/hash binding mismatch"
        )
    if bindings.get("candidate_order_sha256") != _ordered_values_sha256(candidate_ids):
        raise SelectionCalibrationAttachError(
            "selection calibration candidate-order seal failed"
        )
    feature_names = tuple(
        _require_text(value, f"selection calibration.feature_names[{index}]")
        for index, value in enumerate(
            _require_list(
                calibration.get("feature_names"),
                "selection calibration.feature_names",
            )
        )
    )
    if not feature_names or len(feature_names) != len(set(feature_names)):
        raise SelectionCalibrationAttachError(
            "selection calibration feature names must be non-empty and unique"
        )
    candidate_feature_names = tuple(
        f"candidate_id::{candidate_id}" for candidate_id in candidate_ids
    )
    if (
        len(feature_names) != CONTINUOUS_FEATURE_COUNT + len(candidate_ids)
        or feature_names[:CONTINUOUS_FEATURE_COUNT] != CONTINUOUS_FEATURE_NAMES
        or feature_names[-len(candidate_ids) :] != candidate_feature_names
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration candidate feature contract drifted"
        )
    feature_contract = _require_mapping(
        calibration.get("feature_contract"),
        "selection calibration.feature_contract",
    )
    if dict(feature_contract) != FEATURE_CONTRACT:
        raise SelectionCalibrationAttachError(
            "selection calibration feature contract drifted"
        )
    scaler = _require_mapping(calibration.get("scaler"), "selection calibration.scaler")
    if set(scaler) != {"mean", "scale"}:
        raise SelectionCalibrationAttachError("selection calibration scaler drifted")
    means = _require_list(scaler.get("mean"), "selection calibration.scaler.mean")
    scales = _require_list(scaler.get("scale"), "selection calibration.scaler.scale")
    logistic = _require_mapping(
        calibration.get("logistic"), "selection calibration.logistic"
    )
    if set(logistic) != {"coef", "intercept", "c"}:
        raise SelectionCalibrationAttachError("selection calibration logistic drifted")
    coefficients = _require_list(
        logistic.get("coef"), "selection calibration.logistic.coef"
    )
    feature_count = len(feature_names)
    if not (
        len(means) == len(scales) == len(coefficients) == feature_count
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration feature dimensions drifted"
        )
    for index, value in enumerate(means):
        _require_finite(value, f"selection calibration.scaler.mean[{index}]")
    for index, value in enumerate(scales):
        if _require_finite(
            value, f"selection calibration.scaler.scale[{index}]", minimum=0.0
        ) <= 0.0:
            raise SelectionCalibrationAttachError(
                "selection calibration scaler scale must be positive"
            )
    for index, value in enumerate(coefficients):
        _require_finite(value, f"selection calibration.logistic.coef[{index}]")
    _require_finite(logistic.get("intercept"), "selection calibration.logistic.intercept")
    logistic_c = _require_finite(
        logistic.get("c"), "selection calibration.logistic.c", minimum=0.0
    )
    if logistic_c <= 0.0:
        raise SelectionCalibrationAttachError(
            "selection calibration logistic.c must be positive"
        )
    points = _validate_operating_point_families(
        calibration.get("operating_points"),
        location="selection calibration.operating_points",
        require_global_coverage_floor=True,
        require_global_fallback=True,
    )
    _require_deployment_quality(
        points,
        location="selection calibration.operating_points",
        allow_failed_preferred_precision=allow_failed_preferred_precision,
    )
    work_count, candidate_row_count, sample_count, none_sample_count = (
        _validate_training_and_leakage(calibration)
    )
    global_point = _require_mapping(
        points.get("global"), "selection calibration.operating_points.global"
    )
    if (
        global_point.get("cohort_count") != sample_count
        or global_point.get("normal_sample_count")
        != sample_count - none_sample_count
        or global_point.get("eligible_count") != sample_count - none_sample_count
        or global_point.get("none_sample_count") != none_sample_count
    ):
        raise SelectionCalibrationAttachError(
            "selection calibration global coverage denominator drifted"
        )
    _validate_oof_report(
        calibration.get("oof_report"),
        operating_points=points,
        work_count=work_count,
        candidate_row_count=candidate_row_count,
        logistic_c=logistic_c,
        allow_failed_preferred_precision=allow_failed_preferred_precision,
    )
    return calibration


def _load_rank_preserving_calibration_validator() -> Any:
    """Load the canonical v2 validator without duplicating its sealed policy."""

    module_name = "_font_matching_rank_preserving_calibration_validator"
    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached
    script = Path(__file__).with_name(
        "build_font_matching_rank_preserving_calibration.py"
    )
    spec = importlib.util.spec_from_file_location(module_name, script)
    if spec is None or spec.loader is None:
        raise SelectionCalibrationAttachError(
            "rank-preserving calibration validator is unavailable"
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


def _validate_rank_preserving_selection_calibration(
    calibration: Mapping[str, Any],
    *,
    contract: Mapping[str, Any],
    runtime_contract_sha256: str,
    allow_failed_preferred_precision: bool,
) -> dict[str, Any]:
    validator = _load_rank_preserving_calibration_validator()
    try:
        validated = validator.validate_calibration(calibration)
        if not allow_failed_preferred_precision:
            validator.require_deployment_quality(validated)
    except Exception as error:
        raise SelectionCalibrationAttachError(str(error)) from error

    catalog = _require_mapping(contract.get("catalog"), "runtime contract.catalog")
    artifacts = _require_mapping(
        contract.get("artifacts"), "runtime contract.artifacts"
    )
    candidate_ids = _validate_candidate_ids(
        validated.get("candidate_ids"),
        location="selection calibration.candidate_ids",
    )
    contract_ids = _validate_candidate_ids(
        catalog.get("candidate_ids"),
        location="runtime contract.catalog.candidate_ids",
    )
    if candidate_ids != contract_ids:
        raise SelectionCalibrationAttachError(
            "selection calibration candidate order mismatch"
        )
    bindings = _require_mapping(
        validated.get("bindings"), "selection calibration.bindings"
    )
    if set(bindings) != CALIBRATION_BINDING_KEYS:
        raise SelectionCalibrationAttachError(
            "selection calibration binding schema drifted"
        )
    expected_bindings = {
        "model_version": contract.get("model_version"),
        "candidate_order_sha256": catalog.get("candidate_order_sha256"),
        "encoder_sha256": _require_mapping(
            artifacts.get(ENCODER_FILE), f"artifacts.{ENCODER_FILE}"
        ).get("sha256"),
        "ranker_sha256": _require_mapping(
            artifacts.get(RANKER_FILE), f"artifacts.{RANKER_FILE}"
        ).get("sha256"),
        "prototype_features_sha256": _require_mapping(
            artifacts.get(PROTOTYPE_FILE), f"artifacts.{PROTOTYPE_FILE}"
        ).get("sha256"),
        "catalog_registry_sha256": catalog.get("catalog_registry_sha256"),
        "runtime_contract_sha256": _require_sha(
            runtime_contract_sha256, "source runtime contract SHA-256"
        ),
    }
    for key in (
        "catalog_registry_record_sha256",
        "frozen_split_map_sha256",
        "master_manifest_sha256",
        "master_report_sha256",
        "master_split_map_sha256",
        "finals_sha256",
    ):
        _require_sha(bindings.get(key), f"selection calibration.bindings.{key}")
    if any(bindings.get(key) != value for key, value in expected_bindings.items()):
        raise SelectionCalibrationAttachError(
            "selection calibration model/hash binding mismatch"
        )
    if bindings.get("candidate_order_sha256") != _ordered_values_sha256(candidate_ids):
        raise SelectionCalibrationAttachError(
            "selection calibration candidate-order seal failed"
        )
    return copy.deepcopy(dict(validated))


def _validate_base_bundle(
    root: Path, *, allow_qa_only: bool = False
) -> dict[str, Any]:
    _validate_exact_inventory(root, BASE_BUNDLE_FILES, location="source runtime bundle")
    marker = _validate_marker(
        root,
        expected_asset_files=BASE_ASSET_FILES,
        location="source runtime bundle",
        allow_qa_only=allow_qa_only,
    )
    active_catalog = _validate_active_catalog(root / ACTIVE_CATALOG_FILE)
    contract = _validate_contract(
        root,
        active_catalog=active_catalog,
        expected_asset_files=BASE_ASSET_FILES,
    )
    if _evaluation_only_contract_mode(contract):
        raise SelectionCalibrationAttachError(
            "evaluation-only annotations are forbidden on a source base bundle"
        )
    if marker.get("schema_version") != contract.get("schema_version"):
        raise SelectionCalibrationAttachError("runtime marker/contract schema mismatch")
    return {"marker": marker, "active_catalog": active_catalog, "contract": contract}


def _evaluation_only_contract_mode(contract: Mapping[str, Any]) -> bool:
    """Validate and recognize the permanently non-promotable QA boundary."""

    raw_evaluation = contract.get(EVALUATION_ONLY_CONTRACT_KEY)
    raw_packaging = contract.get(V8_PACKAGING_CONTRACT_KEY)
    packaging_flags_present = isinstance(raw_packaging, Mapping) and any(
        key in raw_packaging for key in EVALUATION_ONLY_PACKAGING_KEYS
    )
    if raw_evaluation is None and not packaging_flags_present:
        return False
    evaluation = _require_mapping(
        raw_evaluation, f"runtime contract.{EVALUATION_ONLY_CONTRACT_KEY}"
    )
    packaging = _require_mapping(
        raw_packaging, f"runtime contract.{V8_PACKAGING_CONTRACT_KEY}"
    )
    expected_evaluation = {
        "evaluation_only": True,
        "loader_opt_in_required": "allowQaOnlyRuntime",
        "non_promotable": True,
        "quality_gate_bypassed": True,
        "release_acceptance_forbidden": True,
        "release_approved": False,
        "schema_version": EVALUATION_ONLY_SCHEMA_VERSION,
    }
    expected_packaging = {
        "evaluation_only": True,
        "loader_opt_in_required": "allowQaOnlyRuntime",
        "non_promotable": True,
        "qa_only": True,
        "release_approved": False,
    }
    if (
        dict(evaluation) != expected_evaluation
        or any(packaging.get(key) != value for key, value in expected_packaging.items())
        or packaging.get("quality_gate_bypassed") is not True
        or contract.get("release_acceptance") is not None
    ):
        raise SelectionCalibrationAttachError(
            "evaluation-only runtime boundary drifted"
        )
    return True


def _annotate_evaluation_only_contract(
    contract: Mapping[str, Any],
) -> dict[str, Any]:
    """Add the exact opt-in-only/non-promotable flags before resealing."""

    if _evaluation_only_contract_mode(contract):
        raise SelectionCalibrationAttachError(
            "runtime contract is already evaluation-only"
        )
    updated = copy.deepcopy(dict(contract))
    packaging = dict(
        _require_mapping(
            updated.get(V8_PACKAGING_CONTRACT_KEY),
            f"runtime contract.{V8_PACKAGING_CONTRACT_KEY}",
        )
    )
    if packaging.get("quality_gate_bypassed") is not False:
        raise SelectionCalibrationAttachError(
            "source runtime packaging quality gate boundary drifted"
        )
    packaging.update(
        {
            "evaluation_only": True,
            "loader_opt_in_required": "allowQaOnlyRuntime",
            "non_promotable": True,
            "qa_only": True,
            "quality_gate_bypassed": True,
            "release_approved": False,
        }
    )
    updated[V8_PACKAGING_CONTRACT_KEY] = packaging
    updated[EVALUATION_ONLY_CONTRACT_KEY] = {
        "evaluation_only": True,
        "loader_opt_in_required": "allowQaOnlyRuntime",
        "non_promotable": True,
        "quality_gate_bypassed": True,
        "release_acceptance_forbidden": True,
        "release_approved": False,
        "schema_version": EVALUATION_ONLY_SCHEMA_VERSION,
    }
    _evaluation_only_contract_mode(updated)
    return updated


def _strip_evaluation_only_contract_annotations(
    contract: Mapping[str, Any],
) -> dict[str, Any]:
    """Recover the strict source contract used by calibration hash binding."""

    updated = copy.deepcopy(dict(contract))
    if not _evaluation_only_contract_mode(updated):
        return updated
    updated.pop(EVALUATION_ONLY_CONTRACT_KEY, None)
    packaging = dict(
        _require_mapping(
            updated.get(V8_PACKAGING_CONTRACT_KEY),
            f"runtime contract.{V8_PACKAGING_CONTRACT_KEY}",
        )
    )
    for key in EVALUATION_ONLY_PACKAGING_KEYS:
        packaging.pop(key, None)
    packaging["quality_gate_bypassed"] = False
    updated[V8_PACKAGING_CONTRACT_KEY] = packaging
    return updated


def _reconstructed_source_contract_sha256(
    attached_contract: Mapping[str, Any],
) -> str:
    """Recover the deterministic pre-attachment contract file hash.

    Runtime contracts are emitted as sorted, indented JSON by the sealed builder.
    Removing only this tool's descriptor and resealing therefore reproduces the
    exact verified source contract bytes without trusting a redundant hash field.
    """

    source_core = _strip_evaluation_only_contract_annotations(attached_contract)
    source_core.pop("record_sha256", None)
    # A QA-only bundle may later be promoted by the sealed library-QA release
    # tool.  Its release evidence is not part of the pre-calibration source
    # contract and must not alter the calibration's original hash binding.
    source_core.pop("release_acceptance", None)
    artifacts = dict(
        _require_mapping(source_core.get("artifacts"), "runtime contract.artifacts")
    )
    removed = artifacts.pop(SELECTION_CALIBRATION_FILE, None)
    if removed is None or set(artifacts) != set(BASE_ASSET_FILES):
        raise SelectionCalibrationAttachError(
            "attached runtime contract cannot reconstruct its source binding"
        )
    source_core["artifacts"] = artifacts
    source_contract = seal_record(source_core)
    return sha256_bytes(json_bytes(source_contract, pretty=True))


def _has_external_release_acceptance(contract: Mapping[str, Any]) -> bool:
    """Recognize only the fail-closed release-acceptance envelope.

    Full evidence/hash validation belongs to the promotion tool.  This narrow
    check merely lets the existing calibration validator retain the exact QA
    calibration bytes after that separately sealed external quality gate.
    """

    raw = contract.get("release_acceptance")
    if raw is None:
        return False
    acceptance = _require_mapping(raw, "runtime contract.release_acceptance")
    validate_record_seal(acceptance, location="runtime contract.release_acceptance")
    quality_gate = _require_mapping(
        acceptance.get("quality_gate"),
        "runtime contract.release_acceptance.quality_gate",
    )
    manual_pages = _require_mapping(
        quality_gate.get("manual_page_verdicts"),
        "runtime contract.release_acceptance.quality_gate.manual_page_verdicts",
    )
    return bool(
        acceptance.get("schema_version") == RELEASE_ACCEPTANCE_SCHEMA_VERSION
        and acceptance.get("record_type") == RELEASE_ACCEPTANCE_RECORD_TYPE
        and acceptance.get("status") == "accepted"
        and acceptance.get("external_release_quality_gate_passed") is True
        and acceptance.get("automatic_visual_judgment") is False
        and quality_gate.get("structural_error_count") == 0
        and manual_pages.get("accepted") == 80
        and manual_pages.get("total") == 80
    )


def _validate_attached_bundle(
    root: Path, *, allow_qa_only: bool = False
) -> dict[str, Any]:
    _validate_exact_inventory(
        root, ATTACHED_BUNDLE_FILES, location="attached runtime bundle"
    )
    marker = _validate_marker(
        root,
        expected_asset_files=ATTACHED_ASSET_FILES,
        location="attached runtime bundle",
        allow_qa_only=allow_qa_only,
    )
    qa_only = marker.get("qa_only") is True
    active_catalog = _validate_active_catalog(root / ACTIVE_CATALOG_FILE)
    contract = _validate_contract(
        root,
        active_catalog=active_catalog,
        expected_asset_files=ATTACHED_ASSET_FILES,
    )
    if marker.get("schema_version") != contract.get("schema_version"):
        raise SelectionCalibrationAttachError("runtime marker/contract schema mismatch")
    evaluation_only = _evaluation_only_contract_mode(contract)
    if evaluation_only and not qa_only:
        raise SelectionCalibrationAttachError(
            "evaluation-only runtime requires an exact QA-only marker"
        )
    release_accepted = _has_external_release_acceptance(contract)
    if evaluation_only and release_accepted:
        raise SelectionCalibrationAttachError(
            "evaluation-only runtime cannot carry release acceptance"
        )
    validate_selection_calibration(
        root / SELECTION_CALIBRATION_FILE,
        contract=contract,
        runtime_contract_sha256=_reconstructed_source_contract_sha256(contract),
        allow_failed_preferred_precision=qa_only or release_accepted,
    )
    return {
        "candidate_count": len(active_catalog["_validated_candidate_ids"]),
        "contract_sha256": sha256_file(root / CONTRACT_FILE),
        "model_version": contract["model_version"],
        "output_dir": str(root.resolve()),
        "selection_calibration_sha256": sha256_file(
            root / SELECTION_CALIBRATION_FILE
        ),
        "qa_only": qa_only,
        "release_approved": not qa_only,
        "external_release_acceptance": release_accepted,
        "evaluation_only": evaluation_only,
        "non_promotable": evaluation_only,
        "quality_gate_bypassed": evaluation_only,
        "status": "ready",
    }


def validate_attached_runtime_bundle(
    *, output_dir: Path, allow_qa_only: bool = False
) -> Mapping[str, Any]:
    return _validate_attached_bundle(
        _assert_safe_directory(output_dir, label="output"),
        allow_qa_only=allow_qa_only,
    )


def _assert_safe_directory(path: Path, *, label: str) -> Path:
    resolved = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(resolved.anchor)}
    if resolved in forbidden or len(resolved.parts) < 3 or len(resolved.name) < 3:
        raise SelectionCalibrationAttachError(f"unsafe {label} directory: {resolved}")
    return resolved


def _copy_verified_file(source: Path, destination: Path, *, expected_sha256: str) -> None:
    if source.is_symlink() or not source.is_file():
        raise SelectionCalibrationAttachError(
            f"source runtime artifact is missing or linked: {source.name}"
        )
    shutil.copyfile(source, destination)
    if destination.is_symlink() or sha256_file(destination) != expected_sha256:
        raise SelectionCalibrationAttachError(
            f"copied runtime artifact hash mismatch: {source.name}"
        )


def attach_selection_calibration(
    *,
    runtime_dir: Path,
    selection_calibration: Path,
    output_dir: Path,
    qa_only_allow_failed_quality_gate: bool = False,
) -> Mapping[str, Any]:
    source = _assert_safe_directory(runtime_dir, label="source runtime")
    output = _assert_safe_directory(output_dir, label="output")
    if source == output or source in output.parents:
        raise SelectionCalibrationAttachError(
            "output must be a new directory outside the source runtime bundle"
        )
    if output.exists():
        raise SelectionCalibrationAttachError("output directory already exists")
    source_snapshot = _validate_base_bundle(
        source, allow_qa_only=qa_only_allow_failed_quality_gate
    )
    contract = source_snapshot["contract"]
    calibration_path = selection_calibration.expanduser().resolve()
    validate_selection_calibration(
        calibration_path,
        contract=contract,
        runtime_contract_sha256=sha256_file(source / CONTRACT_FILE),
        allow_failed_preferred_precision=qa_only_allow_failed_quality_gate,
    )
    calibration_sha = sha256_file(calibration_path)
    source_hashes = {
        file_name: sha256_file(source / file_name)
        for file_name in BASE_BUNDLE_FILES
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        for file_name in BASE_ASSET_FILES:
            _copy_verified_file(
                source / file_name,
                staging / file_name,
                expected_sha256=source_hashes[file_name],
            )
        _copy_verified_file(
            calibration_path,
            staging / SELECTION_CALIBRATION_FILE,
            expected_sha256=calibration_sha,
        )
        updated_contract = copy.deepcopy(dict(contract))
        updated_contract.pop("record_sha256", None)
        updated_contract["artifacts"] = {
            file_name: _artifact_descriptor(
                staging / file_name, file_name=file_name
            )
            for file_name in ATTACHED_ASSET_FILES
        }
        updated_contract = seal_record(updated_contract)
        (staging / CONTRACT_FILE).write_bytes(json_bytes(updated_contract, pretty=True))
        marker = {
            "artifacts": {
                file_name: sha256_file(staging / file_name)
                for file_name in (CONTRACT_FILE, *ATTACHED_ASSET_FILES)
            },
            "owner": _runtime_owner(updated_contract["schema_version"]),
            "safe_replace": True,
            "schema_version": updated_contract["schema_version"],
        }
        if qa_only_allow_failed_quality_gate:
            marker.update({"qa_only": True, "release_approved": False})
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        _validate_attached_bundle(
            staging, allow_qa_only=qa_only_allow_failed_quality_gate
        )
        # Prove the source stayed byte-identical before making the new tree visible.
        _validate_base_bundle(
            source, allow_qa_only=qa_only_allow_failed_quality_gate
        )
        if any(
            sha256_file(source / file_name) != expected
            for file_name, expected in source_hashes.items()
        ):
            raise SelectionCalibrationAttachError(
                "source runtime bundle changed during attachment"
            )
        if output.exists():
            raise SelectionCalibrationAttachError(
                "output directory appeared during attachment"
            )
        os.rename(staging, output)
        published = True
        return _validate_attached_bundle(
            output, allow_qa_only=qa_only_allow_failed_quality_gate
        )
    except BaseException:
        if not published and staging.exists():
            shutil.rmtree(staging)
        elif published and output.exists():
            # The target is the newly published staging tree, never the source.
            shutil.rmtree(output)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    attach = subparsers.add_parser("attach")
    attach.add_argument("--runtime-dir", type=Path, required=True)
    attach.add_argument("--selection-calibration", type=Path, required=True)
    attach.add_argument("--output-dir", type=Path, required=True)
    attach.add_argument(
        "--qa-only-allow-failed-quality-gate",
        action="store_true",
        help=(
            "Attach structurally valid calibration for frozen library QA even when "
            "preferred/precision release gates fail; marks output non-releasable"
        ),
    )
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    validate.add_argument(
        "--allow-qa-only-runtime",
        action="store_true",
        help="Explicitly permit validation of a non-releasable QA-only bundle",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "attach":
            result = attach_selection_calibration(
                runtime_dir=args.runtime_dir,
                selection_calibration=args.selection_calibration,
                output_dir=args.output_dir,
                qa_only_allow_failed_quality_gate=(
                    args.qa_only_allow_failed_quality_gate
                ),
            )
        else:
            result = validate_attached_runtime_bundle(
                output_dir=args.output_dir,
                allow_qa_only=args.allow_qa_only_runtime,
            )
    except SelectionCalibrationAttachError as error:
        raise SystemExit(str(error)) from error
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
