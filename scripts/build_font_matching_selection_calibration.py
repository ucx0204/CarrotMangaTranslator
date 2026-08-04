#!/usr/bin/env python3
"""Build a sealed, val-only supervised selector for a supported font runtime.

The builder deliberately treats the deployed ONNX stack as frozen.  It reads
only manually finalized labels whose sample IDs belong to the work-disjoint
validation split, emits work-LOGO out-of-fold evidence, and fits a small L2
logistic suitability model.  Deployment then reranks only the frozen ONNX
runtime's original top-three candidates.  The legacy 15-font, retired-Gugi
active21, and full22 student runtimes use this exact sealed path.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import tempfile
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - repository-root import
    from scripts import font_matching_catalog_assets as catalog_assets  # type: ignore[no-redef]


SCHEMA_VERSION = "font-matching-selection-calibration-v1"
RECORD_TYPE = "font_matching_selection_calibration"
RUNTIME_SCHEMA_V1 = "font-matching-runtime-artifact-v1"
RUNTIME_SCHEMA_V2 = "font-matching-runtime-artifact-v2"
HYBRID_ROUTING_SCHEMA = "font-matching-hybrid-score-routing-v1"
PIXEL_FAMILY_EVIDENCE_SCHEMA = "manga-font-v7-active21-pixel-family-evidence-v1"
FEATURE_CONTRACT_VERSION = "font-matching-selection-features-v1"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
ROLE_VALUES = (
    "dialogue",
    "narration",
    "thought",
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
)
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
VARIANT_ROLES = frozenset(set(ROLE_VALUES) - BODY_ROLES - {"other"})
STYLE_NAMES = (
    "serifness",
    "weight",
    "width",
    "roundness",
    "stroke_contrast",
    "handwritten",
    "angularity",
    "irregularity",
    "slant",
    "energy",
)
ORIENTATION_VALUES = ("horizontal", "vertical", "mixed", "unknown")
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
SAMPLE_ID_RE = re.compile(r'"sample_id"\s*:\s*"(?P<sample_id>[A-Za-z0-9._:-]+)"')
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
DEFAULT_C_GRID = (0.01, 0.03, 0.1, 0.3, 1.0)
SUPPORTED_CANDIDATE_COUNTS = frozenset({15, 21, 22})
RETIRED_GUGI_ID = "gugi"
EPSILON = 1e-8
PROTOTYPE_LME_SCALE = 10.0
MINIMUM_DEPLOYMENT_GLOBAL_PREFERRED_AT1 = 0.45
MINIMUM_DEPLOYMENT_VARIANT_PREFERRED_AT1 = 0.50


class SelectionCalibrationError(ValueError):
    """Raised when calibration evidence is incomplete, leaky, or stale."""


@dataclass(frozen=True)
class BoundSample:
    sample_id: str
    work_id: str
    role: str
    manifest: Mapping[str, Any]
    label: Mapping[str, Any]
    preferred: frozenset[str]
    positive: frozenset[str]
    excluded: frozenset[str]
    none_acceptable: bool
    label_confidence: float


@dataclass(frozen=True)
class CandidateTable:
    features: np.ndarray
    labels: np.ndarray
    weights: np.ndarray
    sample_indices: np.ndarray
    candidate_indices: np.ndarray
    feature_names: tuple[str, ...]


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise SelectionCalibrationError(f"could not hash {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or SHA_RE.fullmatch(expected) is None:
        raise SelectionCalibrationError(f"{location}: invalid record SHA")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise SelectionCalibrationError(f"{location}: record seal mismatch")
    return actual


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SelectionCalibrationError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise SelectionCalibrationError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise SelectionCalibrationError(f"{location}: expected text")
    return result


def _probability(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SelectionCalibrationError(f"{location}: expected probability")
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise SelectionCalibrationError(f"{location}: probability outside [0,1]")
    return result


def _read_json(path: Path, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise SelectionCalibrationError(f"{location}: missing or linked file")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SelectionCalibrationError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _hash_ids(values: Iterable[str]) -> str:
    ordered = sorted(values)
    return sha256_bytes(("\n".join(ordered) + ("\n" if ordered else "")).encode())


def _softmax(values: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    scaled = np.asarray(values, dtype=np.float64) / temperature
    scaled -= np.max(scaled, axis=-1, keepdims=True)
    result = np.exp(scaled)
    return result / np.sum(result, axis=-1, keepdims=True)


def _entropy(probabilities: np.ndarray) -> float:
    values = np.clip(np.asarray(probabilities, dtype=np.float64), EPSILON, 1.0)
    if values.size <= 1:
        return 0.0
    return float(-(values * np.log(values)).sum() / math.log(values.size))


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)


def feature_contract() -> dict[str, Any]:
    return {
        "candidate_scope": "original_onnx_top3_only",
        "entropy": "-sum(p*ln(p))/ln(category_count), epsilon=1e-8",
        "gap_sign": "candidate_minus_best_nonpositive",
        "log_probability": "natural_log_of_temperature_softmax_plus_1e-8",
        "prototype_lme": "ln(mean(exp(10*cosine)))/10",
        "prototype_rank_basis": "view_gate_weighted_prototype_bag_mean_cosine",
        "rank_fraction": "(zero_based_rank)/(candidate_count-1)",
        "runtime_temperature_applied": True,
        "schema_version": FEATURE_CONTRACT_VERSION,
        "view_gate": "ranker_output_already_softmax_normalized",
        "z_logit": "(logit-row_mean)/max(population_std_ddof0,1e-6)",
        "prototype_bag_count_fraction": "bag_count/max_candidate_bag_count",
    }


def validate_master_inputs(
    master_manifest_path: Path,
    catalog_registry_path: Path,
    registry: Mapping[str, Any],
) -> tuple[Path, dict[str, str]]:
    """Verify the master-v2 report chain and return its own split map.

    The catalog registry intentionally points at the frozen master-v1 split
    source.  The authoritative master-v2 manifest is instead paired with the
    copied ``split_map.json`` named by its report.  We verify both links so a
    caller cannot silently pair the v2 manifest with an unrelated split map.
    """
    registry_record_sha256 = validate_record_seal(registry, location="catalog registry")
    registry_file_sha256 = sha256_file(catalog_registry_path)
    report_path = master_manifest_path.parent / "report.json"
    report = _read_json(report_path, "master report")
    outputs = _mapping(report.get("outputs"), "master report.outputs")

    def reported_path(key: str) -> Path:
        raw = Path(_text(outputs.get(key), f"master report.outputs.{key}"))
        return (raw if raw.is_absolute() else report_path.parent / raw).resolve()

    reported_manifest_path = reported_path("master_manifest")
    if reported_manifest_path != master_manifest_path.resolve():
        raise SelectionCalibrationError("master report names a different manifest")
    manifest_sha256 = sha256_file(master_manifest_path)
    if outputs.get("master_manifest_sha256") != manifest_sha256:
        raise SelectionCalibrationError("master manifest hash mismatch")

    split_map_path = reported_path("split_map")
    split_map_sha256 = sha256_file(split_map_path)
    if outputs.get("split_map_sha256") != split_map_sha256:
        raise SelectionCalibrationError("master split-map hash mismatch")

    attestation = _mapping(report.get("inputs"), "master report.inputs")
    attestation = _mapping(
        attestation.get("attestation"), "master report.inputs.attestation"
    )
    attested_registry = _mapping(
        attestation.get("catalog_registry"),
        "master report.inputs.attestation.catalog_registry",
    )
    if attested_registry.get("sha256") != registry_file_sha256:
        raise SelectionCalibrationError(
            "master report catalog-registry file hash mismatch"
        )
    if attested_registry.get("record_sha256") != registry_record_sha256:
        raise SelectionCalibrationError(
            "master report catalog-registry record hash mismatch"
        )

    frozen = _mapping(registry.get("frozen_split_map"), "registry.frozen_split_map")
    frozen_path = Path(_text(frozen.get("path"), "frozen split path")).resolve()
    frozen_sha256 = sha256_file(frozen_path)
    if frozen.get("sha256") != frozen_sha256:
        raise SelectionCalibrationError("frozen split-map hash mismatch")
    split_map = _read_json(split_map_path, "master split map")
    algorithm = _mapping(split_map.get("algorithm"), "master split map.algorithm")
    frozen_source = _mapping(
        algorithm.get("frozen_source"), "master split map.algorithm.frozen_source"
    )
    if frozen_source.get("sha256") != frozen_sha256:
        raise SelectionCalibrationError("master split map frozen-source drift")

    return split_map_path, {
        "catalog_registry_record_sha256": registry_record_sha256,
        "catalog_registry_sha256": registry_file_sha256,
        "frozen_split_map_sha256": frozen_sha256,
        "master_manifest_sha256": manifest_sha256,
        "master_report_sha256": sha256_file(report_path),
        "master_split_map_sha256": split_map_sha256,
    }


def load_val_manifest(
    manifest_path: Path, split_map_path: Path
) -> tuple[dict[str, Mapping[str, Any]], dict[str, Any]]:
    split_map = _read_json(split_map_path, "split map")
    assignments = _mapping(
        split_map.get("work_assignments"), "split map.work_assignments"
    )
    val_rows: dict[str, Mapping[str, Any]] = {}
    work_splits: dict[str, str] = {}
    group_splits: dict[str, dict[str, str]] = {
        "split_component": {},
        "normalized_glyph": {},
        "source_page_sha256": {},
    }
    split_counts: defaultdict[str, int] = defaultdict(int)
    try:
        handle = manifest_path.open(encoding="utf-8")
    except OSError as error:
        raise SelectionCalibrationError(
            f"master manifest unavailable: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = _mapping(json.loads(line), f"master manifest:{line_number}")
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SelectionCalibrationError(
                    f"master manifest:{line_number}: invalid JSON: {error}"
                ) from error
            sample_id = _text(row.get("id"), f"manifest:{line_number}.id")
            split = _text(row.get("split"), f"manifest:{line_number}.split")
            if split not in {"train", "val", "test"}:
                raise SelectionCalibrationError(f"{sample_id}: invalid split")
            work = _mapping(row.get("work"), f"{sample_id}.work")
            work_id = _text(work.get("id"), f"{sample_id}.work.id")
            if assignments.get(work_id) != split:
                raise SelectionCalibrationError(f"{sample_id}: split-map work drift")
            prior = work_splits.setdefault(work_id, split)
            if prior != split:
                raise SelectionCalibrationError(f"work crosses splits: {work_id}")
            groups = _mapping(row.get("groups"), f"{sample_id}.groups")
            page = _mapping(row.get("page"), f"{sample_id}.page")
            keys = {
                "split_component": groups.get("split_component"),
                "normalized_glyph": groups.get("normalized_glyph"),
                "source_page_sha256": page.get("source_page_sha256"),
            }
            for name, raw_key in keys.items():
                key = _text(raw_key, f"{sample_id}.{name}")
                earlier = group_splits[name].setdefault(key, split)
                if earlier != split:
                    raise SelectionCalibrationError(f"{name} crosses splits: {key}")
            split_counts[split] += 1
            if split == "val":
                if sample_id in val_rows:
                    raise SelectionCalibrationError(
                        f"duplicate val sample: {sample_id}"
                    )
                val_rows[sample_id] = row
    val_works = {str(_mapping(row["work"], "work")["id"]) for row in val_rows.values()}
    if len(val_works) < 3:
        raise SelectionCalibrationError("val split needs at least three works for LOGO")
    return val_rows, {
        "split_counts": dict(sorted(split_counts.items())),
        "val_work_ids": sorted(val_works),
        "work_group_isolation": True,
        "split_component_isolation": True,
        "normalized_glyph_isolation": True,
        "source_page_isolation": True,
    }


def load_allowlisted_finals(
    finals_path: Path,
    val_rows: Mapping[str, Mapping[str, Any]],
    candidate_ids: Sequence[str],
    *,
    retired_candidate_ids: Sequence[str] = (),
) -> tuple[list[BoundSample], int]:
    candidate_set = set(candidate_ids)
    retired_values = tuple(retired_candidate_ids)
    retired_set = set(retired_values)
    if (
        candidate_set & retired_set
        or len(retired_set) != len(retired_values)
        or any(not isinstance(value, str) or not value for value in retired_values)
    ):
        raise SelectionCalibrationError("invalid retired-candidate projection")
    source_candidate_set = candidate_set | retired_set
    labels: dict[str, Mapping[str, Any]] = {}
    non_val_parsed = 0
    try:
        handle = finals_path.open(encoding="utf-8")
    except OSError as error:
        raise SelectionCalibrationError(f"finals unavailable: {error}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            matches = list(SAMPLE_ID_RE.finditer(line))
            if len(matches) != 1:
                raise SelectionCalibrationError(
                    f"finals:{line_number}: expected one textual sample_id"
                )
            sample_id = matches[0].group("sample_id")
            if sample_id not in val_rows:
                continue  # Deliberately never JSON-parse train/test label rows.
            try:
                row = _mapping(json.loads(line), f"finals:{line_number}")
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SelectionCalibrationError(
                    f"finals:{line_number}: invalid allowlisted JSON: {error}"
                ) from error
            if row.get("sample_id") != sample_id or sample_id in labels:
                raise SelectionCalibrationError(f"duplicate/drifted final: {sample_id}")
            validate_record_seal(row, location=f"final[{sample_id}]")
            labels[sample_id] = row
    bound: list[BoundSample] = []
    for sample_id in sorted(set(val_rows) & set(labels)):
        manifest = val_rows[sample_id]
        label = labels[sample_id]
        work_id = _text(
            _mapping(manifest.get("work"), "manifest.work").get("id"), "work.id"
        )
        if label.get("work_id") != work_id:
            raise SelectionCalibrationError(f"{sample_id}: label work mismatch")
        page_sha = _text(
            _mapping(manifest.get("page"), "manifest.page").get("source_page_sha256"),
            "page sha",
        )
        if label.get("source_page_sha256") != page_sha:
            raise SelectionCalibrationError(f"{sample_id}: label page mismatch")
        judgment = _mapping(label.get("font_judgment"), f"{sample_id}.font_judgment")
        tiers = {
            name: [
                _text(value, f"{sample_id}.{name}")
                for value in _list(judgment.get(name), f"{sample_id}.{name}")
            ]
            for name in (
                "preferred",
                "acceptable",
                "marginal",
                "unacceptable",
                "unrenderable",
                "not_reviewed",
            )
        }
        flattened = [value for values in tiers.values() for value in values]
        if (
            len(flattened) != len(source_candidate_set)
            or len(flattened) != len(set(flattened))
            or set(flattened) != source_candidate_set
        ):
            raise SelectionCalibrationError(
                f"{sample_id}: candidate tier partition drift"
            )
        resolution = _mapping(label.get("resolution"), f"{sample_id}.resolution")
        resolution_kind = _text(resolution.get("kind"), f"{sample_id}.resolution.kind")
        if label.get(
            "record_type"
        ) != "manga_font_label_final" or resolution_kind not in {
            "primary",
            "adjudicated",
        }:
            raise SelectionCalibrationError(
                f"{sample_id}: pseudo/non-final supervision is forbidden"
            )
        source_positive = frozenset(tiers["preferred"] + tiers["acceptable"])
        none = judgment.get("none_acceptable")
        if not isinstance(none, bool) or none != (len(source_positive) == 0):
            raise SelectionCalibrationError(
                f"{sample_id}: invalid none/positive labels"
            )
        if tiers["not_reviewed"]:
            raise SelectionCalibrationError(
                f"{sample_id}: finalized supervision remains not-reviewed"
            )
        role = _text(
            _mapping(label.get("role"), f"{sample_id}.role").get("primary"),
            f"{sample_id}.role.primary",
        )
        if role not in ROLE_VALUES:
            raise SelectionCalibrationError(f"{sample_id}: unsupported gold role")
        # The source final stays byte-bound by ``finals_sha256``.  Only after
        # validating its exhaustive partition do we remove an explicitly
        # retired catalog row for the active runtime.
        preferred = frozenset(
            value for value in tiers["preferred"] if value in candidate_set
        )
        positive = frozenset(
            value for value in source_positive if value in candidate_set
        )
        excluded = frozenset(
            value
            for value in tiers["unrenderable"] + tiers["not_reviewed"]
            if value in candidate_set
        )
        bound.append(
            BoundSample(
                sample_id=sample_id,
                work_id=work_id,
                role=role,
                manifest=manifest,
                label=label,
                preferred=preferred,
                positive=positive,
                excluded=excluded,
                none_acceptable=len(positive) == 0,
                label_confidence=_probability(
                    resolution.get("confidence"), f"{sample_id}.confidence"
                ),
            )
        )
    if not bound:
        raise SelectionCalibrationError("no finalized val labels joined")
    return bound, non_val_parsed


def _runtime_bindings(
    runtime_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any], np.ndarray]:
    contract_path = runtime_dir / "runtime-contract.json"
    contract = _read_json(contract_path, "runtime contract")
    validate_record_seal(contract, location="runtime contract")
    catalog = _mapping(contract.get("catalog"), "runtime.catalog")
    candidate_ids = tuple(
        _text(value, "candidate id")
        for value in _list(catalog.get("candidate_ids"), "candidate ids")
    )
    if (
        len(candidate_ids) not in SUPPORTED_CANDIDATE_COUNTS
        or len(set(candidate_ids)) != len(candidate_ids)
        or catalog.get("candidate_count") != len(candidate_ids)
    ):
        raise SelectionCalibrationError(
            "runtime candidate inventory must be sealed legacy15, active21, or student22"
        )
    artifacts = _mapping(contract.get("artifacts"), "runtime.artifacts")
    bindings: dict[str, Any] = {
        "model_version": _text(contract.get("model_version"), "model version"),
        "candidate_order_sha256": _text(
            catalog.get("candidate_order_sha256"), "candidate order sha"
        ),
        "catalog_registry_sha256": _text(
            catalog.get("catalog_registry_sha256"), "catalog registry sha"
        ),
        "runtime_contract_sha256": sha256_file(contract_path),
    }
    if SHA_RE.fullmatch(bindings["catalog_registry_sha256"]) is None:
        raise SelectionCalibrationError("runtime catalog-registry SHA is invalid")
    ordered_candidate_sha256 = sha256_bytes(
        ("\n".join(candidate_ids) + "\n").encode("utf-8")
    )
    if bindings["candidate_order_sha256"] != ordered_candidate_sha256:
        raise SelectionCalibrationError("runtime candidate-order hash mismatch")
    for filename, key in (
        ("encoder.onnx", "encoder_sha256"),
        ("ranker.onnx", "ranker_sha256"),
        ("prototype-features.f32", "prototype_features_sha256"),
    ):
        descriptor = _mapping(artifacts.get(filename), f"runtime artifact {filename}")
        expected = _text(descriptor.get("sha256"), f"{filename}.sha256")
        actual = sha256_file(runtime_dir / filename)
        if actual != expected:
            raise SelectionCalibrationError(
                f"runtime artifact hash mismatch: {filename}"
            )
        bindings[key] = actual
    declared_prototype_sha = catalog.get("font_prototypes_sha256")
    if (
        declared_prototype_sha is not None
        and declared_prototype_sha != bindings["prototype_features_sha256"]
    ):
        raise SelectionCalibrationError("runtime prototype catalog binding mismatch")
    feature_dim = int(
        _mapping(contract.get("head"), "head")
        .get("architecture", {})
        .get("feature_dim", 0)
    )
    family_evidence = _parse_pixel_family_evidence(contract, candidate_ids)
    routing = _parse_hybrid_routing(contract, feature_dim)
    if family_evidence is not None:
        if routing is None:
            raise SelectionCalibrationError(
                "v7 pixel-family evidence requires sealed hybrid compatibility routing"
            )
        routing["family_scores_shared"] = True
    selection_feature_dim = (
        int(routing["selection_feature_dim"]) if routing else feature_dim
    )
    prototype_count = int(catalog.get("prototype_count", 0))
    raw = np.fromfile(runtime_dir / "prototype-features.f32", dtype="<f4")
    if feature_dim <= 0 or raw.size != prototype_count * feature_dim:
        raise SelectionCalibrationError("prototype feature shape mismatch")
    candidate_bags = tuple(_list(catalog.get("prototype_bags"), "prototype bags"))
    if len(candidate_bags) != len(candidate_ids):
        raise SelectionCalibrationError("prototype bag inventory drift")
    expected_start = 0
    for candidate_id, raw_bag in zip(candidate_ids, candidate_bags, strict=True):
        bag = _mapping(raw_bag, f"prototype bag {candidate_id}")
        start = int(bag.get("start", -1))
        count = int(bag.get("count", 0))
        if (
            bag.get("candidate_id") != candidate_id
            or start != expected_start
            or count <= 0
        ):
            raise SelectionCalibrationError("prototype bag layout drift")
        expected_start += count
    if expected_start != prototype_count:
        raise SelectionCalibrationError("prototype bag coverage drift")
    runtime = {
        "candidate_ids": candidate_ids,
        "candidate_bags": candidate_bags,
        "feature_dim": feature_dim,
        "selection_feature_dim": selection_feature_dim,
        "hybrid_score_routing": routing,
        "retired_label_candidates": (
            family_evidence["retired_label_candidates"]
            if family_evidence is not None
            else ()
        ),
        "temperature": float(
            _mapping(contract.get("calibration"), "calibration").get("temperature", 0)
        ),
        "none_threshold": float(
            _mapping(contract.get("calibration"), "calibration").get(
                "none_threshold", 0
            )
        ),
    }
    if runtime["temperature"] <= 0:
        raise SelectionCalibrationError("invalid runtime temperature")
    if not 0 <= runtime["none_threshold"] <= 1:
        raise SelectionCalibrationError("invalid runtime none threshold")
    prototypes = raw.reshape(prototype_count, feature_dim)
    if not np.isfinite(prototypes).all():
        raise SelectionCalibrationError("prototype features are non-finite")
    return bindings, runtime, prototypes


def _parse_pixel_family_evidence(
    contract: Mapping[str, Any], candidate_ids: Sequence[str]
) -> dict[str, Any] | None:
    raw = contract.get("font_family_evidence")
    if raw is None:
        return None
    evidence = _mapping(raw, "runtime.font_family_evidence")
    expected = {
        "body_and_variant_share_exact_scores": True,
        "candidate_output": "candidate_scores",
        "candidate_score_inputs": [
            "base_siglip2_last_hidden_state_patch_tokens",
            "active21_four_query_head",
            "active21_candidate_query_prototypes",
        ],
        "forbidden_family_logit_inputs": ["gemma", "genre", "role"],
        "role_policy_stage": "downstream_page_consistency_and_emphasis_only",
        "schema_version": PIXEL_FAMILY_EVIDENCE_SCHEMA,
    }
    if (
        dict(evidence) != expected
        or len(candidate_ids) != 21
        or RETIRED_GUGI_ID in candidate_ids
    ):
        raise SelectionCalibrationError("v7 pixel-family evidence contract drifted")
    return {
        "family_scores_shared": True,
        "retired_label_candidates": (RETIRED_GUGI_ID,),
    }


def _parse_hybrid_routing(
    contract: Mapping[str, Any], feature_dim: int
) -> dict[str, Any] | None:
    schema = contract.get("schema_version")
    raw = contract.get("hybrid_score_routing")
    if schema == RUNTIME_SCHEMA_V1:
        if raw is not None:
            raise SelectionCalibrationError("v1 runtime must not declare hybrid routing")
        return None
    if schema != RUNTIME_SCHEMA_V2:
        raise SelectionCalibrationError("runtime schema is unsupported")
    routing = _mapping(raw, "runtime.hybrid_score_routing")
    body_roles = tuple(_list(routing.get("body_roles"), "hybrid body roles"))
    variant_roles = tuple(
        _list(routing.get("variant_roles"), "hybrid variant roles")
    )
    expected_variant = tuple(role for role in ROLE_VALUES if role not in BODY_ROLES)
    selection_dim = int(routing.get("selection_feature_dim", 0))
    architecture = _mapping(
        _mapping(contract.get("head"), "head").get("architecture"),
        "head.architecture",
    )
    batching = _mapping(contract.get("runtime_batching"), "runtime batching")
    if (
        routing.get("schema_version") != HYBRID_ROUTING_SCHEMA
        or routing.get("candidate_scores_compatibility_alias")
        != "body_candidate_scores"
        or routing.get("body_candidate_output") != "body_candidate_scores"
        or routing.get("variant_candidate_output") != "variant_candidate_scores"
        or body_roles != tuple(sorted(BODY_ROLES, key=ROLE_VALUES.index))
        or variant_roles != expected_variant
        or routing.get("unknown_role_fallback") != "variant_candidate_scores"
        or routing.get("role_source")
        != "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)"
        or routing.get("selection_feature_source")
        != "selected_candidate_scores_with_legacy256_visual_features"
        or routing.get("row_specific_rules") is not False
        or selection_dim != 256
        or architecture.get("legacy_feature_dim") != selection_dim
        or architecture.get("variant_feature_dim") != 1024
        or feature_dim != selection_dim + 1024
        or dict(batching)
        != {
            "encoder_batch_size": 2,
            "ranker_batch_size": 16,
            "parity_qualified": True,
        }
    ):
        raise SelectionCalibrationError("hybrid score-routing contract drifted")
    return {
        "body_roles": body_roles,
        "body_output": "body_candidate_scores",
        "variant_output": "variant_candidate_scores",
        "selection_feature_dim": selection_dim,
    }


def _encode_views(
    samples: Sequence[BoundSample],
    resolver: Any,
    encoder_path: Path,
    feature_dim: int,
) -> np.ndarray:
    try:
        import onnxruntime as ort
    except ImportError as error:  # pragma: no cover - environment dependency
        raise SelectionCalibrationError("onnxruntime is required") from error
    session = ort.InferenceSession(
        str(encoder_path), providers=["CPUExecutionProvider"]
    )
    if [value.name for value in session.get_inputs()] != ["pixel_values"]:
        raise SelectionCalibrationError("encoder input contract drift")
    output = np.empty((len(samples), 3, feature_dim), dtype=np.float32)
    batch_pixels: list[np.ndarray] = []
    batch_positions: list[tuple[int, int]] = []

    def flush() -> None:
        if not batch_pixels:
            return
        pixels = np.stack(batch_pixels).astype(np.float32, copy=False)
        encoded = np.asarray(
            session.run(["image_features"], {"pixel_values": pixels})[0],
            dtype=np.float32,
        )
        if (
            encoded.shape != (len(batch_positions), output.shape[-1])
            or not np.isfinite(encoded).all()
        ):
            raise SelectionCalibrationError("encoder emitted invalid features")
        for value, (sample_index, view_index) in zip(
            encoded, batch_positions, strict=True
        ):
            output[sample_index, view_index] = value
        batch_pixels.clear()
        batch_positions.clear()

    for sample_index, sample in enumerate(samples):
        views = _mapping(sample.manifest.get("views"), f"{sample.sample_id}.views")
        for view_index, view_name in enumerate(VIEW_NAMES):
            try:
                with resolver.resolve_view_descriptor(
                    views.get(view_name),
                    sample_id=sample.sample_id,
                    view_name=view_name,
                    location=f"{sample.sample_id}.views.{view_name}",
                ) as resolved:
                    image = resolved.image.convert("RGB")
                    array = np.asarray(image, dtype=np.float32)
            except catalog_assets.CatalogAssetError as error:
                raise SelectionCalibrationError(str(error)) from error
            if array.shape != (224, 224, 3):
                raise SelectionCalibrationError(
                    f"{sample.sample_id}: invalid {view_name}"
                )
            batch_pixels.append(np.transpose(array / 127.5 - 1.0, (2, 0, 1)))
            batch_positions.append((sample_index, view_index))
            if len(batch_pixels) >= 32:
                flush()
    flush()
    return output


def _ranker_outputs(
    views: np.ndarray, prototypes: np.ndarray, ranker_path: Path
) -> dict[str, np.ndarray]:
    try:
        import onnxruntime as ort
    except ImportError as error:  # pragma: no cover
        raise SelectionCalibrationError("onnxruntime is required") from error
    session = ort.InferenceSession(str(ranker_path), providers=["CPUExecutionProvider"])
    names = [value.name for value in session.get_outputs()]
    required = {
        "candidate_scores",
        "none_logits",
        "role_logits",
        "style_logits",
        "treatment_orientation_logits",
        "view_gate_weights",
    }
    if not required <= set(names):
        raise SelectionCalibrationError("ranker output contract drift")
    gathered: dict[str, list[np.ndarray]] = {name: [] for name in names}
    for start in range(0, len(views), 64):
        values = session.run(
            names,
            {
                "views": views[start : start + 64].astype(np.float32, copy=False),
                "prototype_features": prototypes.astype(np.float32, copy=False),
            },
        )
        for name, value in zip(names, values, strict=True):
            gathered[name].append(np.asarray(value, dtype=np.float32))
    return {name: np.concatenate(parts, axis=0) for name, parts in gathered.items()}


def _route_hybrid_candidate_scores(
    samples: Sequence[BoundSample],
    outputs: Mapping[str, np.ndarray],
    runtime: Mapping[str, Any],
) -> dict[str, np.ndarray]:
    routed = {name: np.asarray(value) for name, value in outputs.items()}
    routing = runtime.get("hybrid_score_routing")
    if routing is None:
        return routed
    contract = _mapping(routing, "hybrid score routing")
    body = np.asarray(
        outputs.get(_text(contract.get("body_output"), "body score output")),
        dtype=np.float32,
    )
    variant = np.asarray(
        outputs.get(_text(contract.get("variant_output"), "variant score output")),
        dtype=np.float32,
    )
    compatibility = np.asarray(outputs.get("candidate_scores"), dtype=np.float32)
    candidate_count = len(runtime["candidate_ids"])
    expected = (len(samples), candidate_count)
    shared_scores = contract.get("family_scores_shared") is True
    if (
        body.shape != expected
        or variant.shape != expected
        or compatibility.shape != expected
        or not np.isfinite(body).all()
        or not np.isfinite(variant).all()
        or not np.array_equal(body, compatibility)
        or (shared_scores and not np.array_equal(body, variant))
    ):
        raise SelectionCalibrationError("hybrid candidate-score outputs drifted")
    body_roles = frozenset(contract.get("body_roles", ()))
    selected = np.empty_like(body)
    for index, sample in enumerate(samples):
        selected[index] = (
            body[index]
            if shared_scores or sample.role in body_roles
            else variant[index]
        )
    routed["candidate_scores"] = selected
    return routed


def _candidate_feature_table(
    samples: Sequence[BoundSample],
    candidate_ids: Sequence[str],
    candidate_bags: Sequence[Mapping[str, Any]],
    views: np.ndarray,
    prototypes: np.ndarray,
    outputs: Mapping[str, np.ndarray],
    temperature: float,
) -> CandidateTable:
    feature_names = CONTINUOUS_FEATURE_NAMES + tuple(
        f"candidate_id::{value}" for value in candidate_ids
    )
    candidate_count = len(candidate_ids)
    if outputs["candidate_scores"].shape != (len(samples), candidate_count):
        raise SelectionCalibrationError("candidate score shape mismatch")
    prototype_unit = prototypes / np.maximum(
        np.linalg.norm(prototypes, axis=1, keepdims=True), EPSILON
    )
    view_unit = views / np.maximum(
        np.linalg.norm(views, axis=2, keepdims=True), EPSILON
    )
    per_work_confidence: dict[str, float] = defaultdict(float)
    for sample in samples:
        per_work_confidence[sample.work_id] += sample.label_confidence
    rows: list[list[float]] = []
    labels: list[int] = []
    weights: list[float] = []
    sample_indices: list[int] = []
    candidate_indices: list[int] = []
    max_bag_count = max(
        int(_mapping(value, "bag").get("count", 0)) for value in candidate_bags
    )
    for sample_index, sample in enumerate(samples):
        scores = outputs["candidate_scores"][sample_index].astype(np.float64)
        probabilities = _softmax(scores, temperature)
        ordering = np.argsort(-scores, kind="stable")
        ranks = np.empty(candidate_count, dtype=np.int64)
        ranks[ordering] = np.arange(candidate_count)
        score_mean = float(scores.mean())
        score_std = max(float(scores.std(ddof=0)), 1e-6)
        distribution_entropy = _entropy(probabilities)
        top3_mass = float(probabilities[ordering[:3]].sum())
        margin12 = float(probabilities[ordering[0]] - probabilities[ordering[1]])
        none_logit = float(outputs["none_logits"][sample_index])
        role_prob = _softmax(outputs["role_logits"][sample_index])
        style_prob = np.asarray(
            [_sigmoid(float(value)) for value in outputs["style_logits"][sample_index]]
        )
        orientation_prob = _softmax(
            outputs["treatment_orientation_logits"][sample_index]
        )
        gates = np.asarray(outputs["view_gate_weights"][sample_index], dtype=np.float64)
        if (
            gates.shape != (3,)
            or not np.isfinite(gates).all()
            or abs(float(gates.sum()) - 1) > 1e-4
        ):
            raise SelectionCalibrationError("view gate weights are not normalized")
        proto_means = np.empty((candidate_count, 3), dtype=np.float64)
        proto_lme = np.empty((candidate_count, 3), dtype=np.float64)
        bag_counts = np.empty(candidate_count, dtype=np.float64)
        for candidate_index, raw_bag in enumerate(candidate_bags):
            bag = _mapping(raw_bag, f"bag[{candidate_index}]")
            if bag.get("candidate_id") != candidate_ids[candidate_index]:
                raise SelectionCalibrationError("prototype bag order mismatch")
            start = int(bag.get("start", -1))
            count = int(bag.get("count", 0))
            if start < 0 or count <= 0:
                raise SelectionCalibrationError("invalid prototype bag")
            similarities = (
                view_unit[sample_index] @ prototype_unit[start : start + count].T
            )
            proto_means[candidate_index] = similarities.mean(axis=1)
            maximum = similarities.max(axis=1, keepdims=True)
            proto_lme[candidate_index] = (
                maximum[:, 0] * PROTOTYPE_LME_SCALE
                + np.log(
                    np.exp((similarities - maximum) * PROTOTYPE_LME_SCALE).mean(axis=1)
                )
            ) / PROTOTYPE_LME_SCALE
            bag_counts[candidate_index] = count
        proto_aggregate = proto_means @ gates
        proto_order = np.argsort(-proto_aggregate, kind="stable")
        proto_ranks = np.empty(candidate_count, dtype=np.int64)
        proto_ranks[proto_order] = np.arange(candidate_count)
        eligible_count = candidate_count - len(sample.excluded)
        for candidate_index, candidate_id in enumerate(candidate_ids):
            if candidate_id in sample.excluded:
                continue
            continuous = [
                float(scores[candidate_index] - score_mean),
                float((scores[candidate_index] - score_mean) / score_std),
                float(probabilities[candidate_index]),
                float(math.log(float(probabilities[candidate_index]) + EPSILON)),
                float(ranks[candidate_index] / max(1, candidate_count - 1)),
                float(scores[candidate_index] - scores[ordering[0]]),
                float(ranks[candidate_index] == 0),
                float(ranks[candidate_index] < 3),
                distribution_entropy,
                top3_mass,
                margin12,
                none_logit,
                _sigmoid(none_logit),
                float(
                    sum(
                        role_prob[index]
                        for index, role in enumerate(ROLE_VALUES)
                        if role in BODY_ROLES
                    )
                ),
                float(
                    sum(
                        role_prob[index]
                        for index, role in enumerate(ROLE_VALUES)
                        if role in VARIANT_ROLES
                    )
                ),
                float(role_prob.max()),
                _entropy(role_prob),
                float(style_prob[0]),
                float(style_prob[1]),
                float(style_prob[2]),
                float(style_prob[8]),
                float(style_prob[5]),
                float(style_prob[7]),
                float(style_prob[9]),
                *[float(value) for value in orientation_prob],
                _entropy(orientation_prob),
                *[float(value) for value in gates],
                _entropy(gates),
                *[float(value) for value in proto_means[candidate_index]],
                *[float(value) for value in proto_lme[candidate_index]],
                float(proto_aggregate[candidate_index]),
                float(proto_means[candidate_index].min()),
                float(proto_means[candidate_index].std(ddof=0)),
                float(proto_ranks[candidate_index] / max(1, candidate_count - 1)),
                float(
                    proto_aggregate[candidate_index] - proto_aggregate[proto_order[0]]
                ),
                float(bag_counts[candidate_index] / max_bag_count),
            ]
            one_hot = [
                float(index == candidate_index) for index in range(candidate_count)
            ]
            if len(continuous) != len(CONTINUOUS_FEATURE_NAMES):
                raise SelectionCalibrationError("feature implementation/schema drift")
            rows.append(continuous + one_hot)
            labels.append(int(candidate_id in sample.positive))
            weights.append(
                sample.label_confidence
                / (per_work_confidence[sample.work_id] * eligible_count)
            )
            sample_indices.append(sample_index)
            candidate_indices.append(candidate_index)
    matrix = np.asarray(rows, dtype=np.float64)
    if matrix.shape[1] != len(feature_names) or not np.isfinite(matrix).all():
        raise SelectionCalibrationError("candidate feature matrix invalid")
    return CandidateTable(
        matrix,
        np.asarray(labels),
        np.asarray(weights),
        np.asarray(sample_indices),
        np.asarray(candidate_indices),
        feature_names,
    )


def _fit_predict(
    train: np.ndarray, test: np.ndarray, table: CandidateTable, C: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, Any]:
    try:
        from sklearn.linear_model import LogisticRegression
    except ImportError as error:  # pragma: no cover
        raise SelectionCalibrationError("scikit-learn is required") from error
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
    return probability, mean, scale, model


def _weighted_log_loss(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    clipped = np.clip(p, EPSILON, 1 - EPSILON)
    return float(
        np.average(-(y * np.log(clipped) + (1 - y) * np.log(1 - clipped)), weights=w)
    )


def _select_C(
    train_rows: np.ndarray,
    table: CandidateTable,
    samples: Sequence[BoundSample],
    grid: Sequence[float],
) -> float:
    works = sorted(
        {samples[int(table.sample_indices[index])].work_id for index in train_rows}
    )
    if len(works) < 2:
        raise SelectionCalibrationError("inner LOGO needs at least two works")
    losses: list[tuple[float, float]] = []
    for C in grid:
        prediction = np.full(len(train_rows), np.nan)
        for work in works:
            test_local = np.asarray(
                [
                    i
                    for i, row in enumerate(train_rows)
                    if samples[int(table.sample_indices[row])].work_id == work
                ]
            )
            train_local = np.asarray(
                [i for i in range(len(train_rows)) if i not in set(test_local.tolist())]
            )
            p, _, _, _ = _fit_predict(
                train_rows[train_local], train_rows[test_local], table, C
            )
            prediction[test_local] = p
        if not np.isfinite(prediction).all():
            raise SelectionCalibrationError("inner OOF prediction missing")
        losses.append(
            (
                _weighted_log_loss(
                    table.labels[train_rows], prediction, table.weights[train_rows]
                ),
                C,
            )
        )
    losses.sort(key=lambda value: (round(value[0], 12), value[1]))
    return losses[0][1]


def work_logo_predictions(
    table: CandidateTable,
    samples: Sequence[BoundSample],
    grid: Sequence[float],
    *,
    fixed_C: float | None = None,
) -> tuple[np.ndarray, list[dict[str, Any]], list[float]]:
    predictions = np.full(len(table.labels), np.nan)
    folds: list[dict[str, Any]] = []
    selected: list[float] = []
    works = sorted({sample.work_id for sample in samples})
    for work in works:
        test = np.asarray(
            [
                index
                for index, sample_index in enumerate(table.sample_indices)
                if samples[int(sample_index)].work_id == work
            ]
        )
        train = np.asarray(
            [
                index
                for index in range(len(table.labels))
                if index not in set(test.tolist())
            ]
        )
        C = fixed_C if fixed_C is not None else _select_C(train, table, samples, grid)
        p, _, _, _ = _fit_predict(train, test, table, C)
        predictions[test] = p
        selected.append(float(C))
        folds.append(
            {
                "held_out_work_id_sha256": sha256_bytes(work.encode()),
                "C": float(C),
                "candidate_row_count": int(len(test)),
                "candidate_log_loss": _weighted_log_loss(
                    table.labels[test], p, table.weights[test]
                ),
            }
        )
    if not np.isfinite(predictions).all():
        raise SelectionCalibrationError("outer OOF prediction missing")
    return predictions, folds, selected


def _role_family(role: str) -> str:
    if role in BODY_ROLES:
        return "body"
    if role in VARIANT_ROLES:
        return "variant"
    return "global"


def _winner_rows(
    predictions: np.ndarray,
    table: CandidateTable,
    samples: Sequence[BoundSample],
    outputs: Mapping[str, np.ndarray],
    candidate_ids: Sequence[str],
    none_threshold: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sample_index, sample in enumerate(samples):
        candidate_rows = np.where(table.sample_indices == sample_index)[0]
        score_order = np.argsort(
            -outputs["candidate_scores"][sample_index], kind="stable"
        )
        top3 = set(int(value) for value in score_order[:3])
        scoped = [
            row for row in candidate_rows if int(table.candidate_indices[row]) in top3
        ]
        if not scoped:
            continue
        winner = max(
            scoped,
            key=lambda row: (
                float(predictions[row]),
                -int(table.candidate_indices[row]),
            ),
        )
        candidate_id = candidate_ids[int(table.candidate_indices[winner])]
        none_probability = _sigmoid(float(outputs["none_logits"][sample_index]))
        rows.append(
            {
                "sample_index": sample_index,
                "work_id": sample.work_id,
                "family": _role_family(sample.role),
                "score": float(predictions[winner]),
                "acceptable": candidate_id in sample.positive,
                "preferred": candidate_id in sample.preferred,
                "normal": not sample.none_acceptable,
                "none_gate_passed": none_probability < none_threshold,
            }
        )
    return rows


def _risk_lcb(hits: int, total: int) -> float:
    if total <= 0 or hits <= 0:
        return 0.0
    try:
        from scipy.stats import beta
    except ImportError as error:  # pragma: no cover
        raise SelectionCalibrationError("scipy is required") from error
    return float(beta.ppf(0.05, hits, total - hits + 1))


def select_operating_point(
    rows: Sequence[Mapping[str, Any]],
    family: str,
    *,
    coverage_target: float,
    precision_target: float,
) -> dict[str, Any]:
    cohort = [row for row in rows if family == "global" or row["family"] == family]
    normal = [row for row in cohort if row["normal"]]
    none = [row for row in cohort if not row["normal"]]
    gated = [row for row in cohort if row["none_gate_passed"]]

    def summarize(
        threshold: float, accepted: Sequence[Mapping[str, Any]]
    ) -> dict[str, Any]:
        normal_accepted = [row for row in accepted if row["normal"]]
        none_false_accepted = [row for row in accepted if not row["normal"]]
        hits = sum(bool(row["acceptable"]) for row in accepted)
        preferred = sum(bool(row["preferred"]) for row in accepted)
        none_abstained = len(none) - len(none_false_accepted)
        accepted_count = len(accepted)
        coverage = len(normal_accepted) / len(normal)
        precision = hits / accepted_count
        return {
            "enabled": True,
            "selection_score_threshold": threshold,
            "coverage_target": coverage_target,
            "coverage_floor_passed": coverage >= coverage_target,
            "precision_target": precision_target,
            "precision_target_passed": precision >= precision_target,
            "risk_lcb": _risk_lcb(hits, accepted_count),
            "cohort_count": len(cohort),
            "accepted_count": accepted_count,
            "eligible_count": len(normal),
            "normal_sample_count": len(normal),
            "normal_accepted_count": len(normal_accepted),
            "none_sample_count": len(none),
            "none_false_accept_count": len(none_false_accepted),
            "none_abstained_count": none_abstained,
            "hit_count": hits,
            "miss_count": accepted_count - hits,
            "coverage": coverage,
            "acceptable_at1": precision,
            "preferred_at1": preferred / accepted_count,
            "overall_decision_accuracy": (hits + none_abstained) / len(cohort),
            "none_abstention_rate": none_abstained / len(none) if none else 1.0,
        }

    if not normal or not gated:
        return {
            "enabled": False,
            "selection_score_threshold": None,
            "coverage_target": coverage_target,
            "coverage_floor_passed": False,
            "precision_target": precision_target,
            "precision_target_passed": False,
            "risk_lcb": 0.0,
            "cohort_count": len(cohort),
            "accepted_count": 0,
            "eligible_count": len(normal),
            "normal_sample_count": len(normal),
            "normal_accepted_count": 0,
            "none_sample_count": len(none),
            "none_false_accept_count": 0,
            "none_abstained_count": len(none),
            "hit_count": 0,
            "miss_count": 0,
            "coverage": 0.0,
            "acceptable_at1": 0.0,
            "preferred_at1": 0.0,
            "overall_decision_accuracy": len(none) / len(cohort) if cohort else 0.0,
            "none_abstention_rate": 1.0,
        }
    thresholds = sorted({float(row["score"]) for row in gated}, reverse=True)
    choices: list[tuple[tuple[float, float, float], dict[str, Any]]] = []
    for threshold in thresholds:
        accepted = [row for row in gated if float(row["score"]) >= threshold]
        record = summarize(threshold, accepted)
        if record["coverage_floor_passed"]:
            choices.append(
                ((record["acceptable_at1"], record["coverage"], threshold), record)
            )
    if choices:
        return max(choices, key=lambda value: value[0])[1]
    # Coverage floor cannot be met because the severe-none gate removed rows;
    # choose maximum coverage and make the miss explicit instead of silently disabling.
    threshold = min(thresholds)
    accepted = [row for row in gated if float(row["score"]) >= threshold]
    return summarize(threshold, accepted)


def _geometric_median(values: Sequence[float]) -> float:
    logs = sorted(math.log(value) for value in values)
    middle = len(logs) // 2
    selected = logs[middle] if len(logs) % 2 else (logs[middle - 1] + logs[middle]) / 2
    return float(math.exp(selected))


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
    if not math.isfinite(coverage_target) or not 0.90 <= coverage_target <= 1:
        raise SelectionCalibrationError("coverage target must be inside [0.90,1]")
    if not math.isfinite(precision_target) or not 0 <= precision_target <= 1:
        raise SelectionCalibrationError("precision target must be inside [0,1]")
    if not C_grid or any(
        not math.isfinite(float(value)) or float(value) <= 0 for value in C_grid
    ):
        raise SelectionCalibrationError("C grid must contain positive finite values")
    bindings, runtime, prototypes = _runtime_bindings(runtime_dir)
    registry = _read_json(catalog_registry_path, "catalog registry")
    split_map_path, master_bindings = validate_master_inputs(
        master_manifest_path, catalog_registry_path, registry
    )
    if (
        bindings["catalog_registry_sha256"]
        != master_bindings["catalog_registry_sha256"]
    ):
        raise SelectionCalibrationError(
            "runtime and master use different catalog registries"
        )
    val_rows, isolation = load_val_manifest(master_manifest_path, split_map_path)
    samples, non_val_parsed = load_allowlisted_finals(
        finals_path,
        val_rows,
        runtime["candidate_ids"],
        retired_candidate_ids=runtime["retired_label_candidates"],
    )
    resolver = catalog_assets.CatalogAssetResolver(catalog_registry_path)
    views = _encode_views(
        samples,
        resolver,
        runtime_dir / "encoder.onnx",
        runtime["feature_dim"],
    )
    outputs = _ranker_outputs(views, prototypes, runtime_dir / "ranker.onnx")
    outputs = _route_hybrid_candidate_scores(samples, outputs, runtime)
    selection_dim = int(runtime["selection_feature_dim"])
    selection_views = np.ascontiguousarray(views[:, :, :selection_dim])
    selection_prototypes = np.ascontiguousarray(prototypes[:, :selection_dim])
    table = _candidate_feature_table(
        samples,
        runtime["candidate_ids"],
        runtime["candidate_bags"],
        selection_views,
        selection_prototypes,
        outputs,
        runtime["temperature"],
    )
    nested_predictions, folds, selected_Cs = work_logo_predictions(
        table, samples, C_grid
    )
    final_C = _geometric_median(selected_Cs)
    oof_predictions, fixed_folds, _ = work_logo_predictions(
        table, samples, C_grid, fixed_C=final_C
    )
    all_rows = np.arange(len(table.labels))
    _, mean, scale, final_model = _fit_predict(all_rows, all_rows, table, final_C)
    winners = _winner_rows(
        oof_predictions,
        table,
        samples,
        outputs,
        runtime["candidate_ids"],
        runtime["none_threshold"],
    )
    if len(winners) != len(samples):
        raise SelectionCalibrationError(
            "one or more gold samples have no runtime top-three candidate evidence"
        )
    operating = {
        family: select_operating_point(
            winners,
            family,
            coverage_target=coverage_target,
            precision_target=precision_target,
        )
        for family in ("body", "variant", "global")
    }
    if not operating["global"]["coverage_floor_passed"]:
        raise SelectionCalibrationError(
            "global normal/renderable coverage is below the hard floor"
        )
    try:
        from sklearn.metrics import roc_auc_score

        auc = float(
            roc_auc_score(table.labels, oof_predictions, sample_weight=table.weights)
        )
    except (ImportError, ValueError):
        auc = 0.0
    candidate_rows_hash = sha256_bytes(
        "".join(
            f"{samples[int(s)].sample_id}\0{runtime['candidate_ids'][int(c)]}\n"
            for s, c in zip(table.sample_indices, table.candidate_indices, strict=True)
        ).encode()
    )
    bindings.update(master_bindings)
    bindings["finals_sha256"] = sha256_file(finals_path)
    record = {
        "bindings": bindings,
        "candidate_ids": list(runtime["candidate_ids"]),
        "feature_contract": feature_contract(),
        "feature_names": list(table.feature_names),
        "leakage_audit": {
            "allowed_split": "val",
            "allowed_work_count": len({s.work_id for s in samples}),
            "allowed_sample_count": len(samples),
            "candidate_row_count": len(table.labels),
            "excluded_unrenderable_candidate_rows": sum(
                len(s.excluded) for s in samples
            ),
            "non_val_label_rows_parsed": non_val_parsed,
            "test_rows_used_for_fit": 0,
            "train_rows_used_for_fit": 0,
            "pseudo_label_rows_used_for_fit": 0,
            "gold_final_rows_used_for_fit": len(samples),
            "work_group_oof": True,
            "nested_hyperparameter_selection": True,
            "hybrid_score_route_source": (
                "pixel_shared_scores_role_downstream_only"
                if runtime["hybrid_score_routing"]
                and runtime["hybrid_score_routing"].get("family_scores_shared")
                else "sealed_gold_role_family"
                if runtime["hybrid_score_routing"]
                else "legacy_candidate_scores"
            ),
            "split_component_isolation_passed": isolation["split_component_isolation"],
            "normalized_glyph_isolation_passed": isolation[
                "normalized_glyph_isolation"
            ],
            "source_page_isolation_passed": isolation["source_page_isolation"],
        },
        "logistic": {
            "c": final_C,
            "coef": [float(v) for v in final_model.coef_[0]],
            "intercept": float(final_model.intercept_[0]),
        },
        "oof_report": {
            "candidate_log_loss": _weighted_log_loss(
                table.labels, oof_predictions, table.weights
            ),
            "candidate_roc_auc": auc,
            "folds": fixed_folds,
            "nested_operating_evaluation": {
                family: select_operating_point(
                    _winner_rows(
                        nested_predictions,
                        table,
                        samples,
                        outputs,
                        runtime["candidate_ids"],
                        runtime["none_threshold"],
                    ),
                    family,
                    coverage_target=coverage_target,
                    precision_target=precision_target,
                )
                for family in ("body", "variant", "global")
            },
            "full_oof": copy.deepcopy(operating),
            "selected_C_values": selected_Cs,
            "final_C": final_C,
            "fit_implementation": {
                "solver": "lbfgs",
                "penalty": "l2",
                "max_iter": 3000,
                "tol": 1e-9,
                "standardization": "train_fold_population_mean_std_ddof0",
            },
        },
        "operating_points": operating,
        "record_type": RECORD_TYPE,
        "scaler": {
            "mean": [float(v) for v in mean],
            "scale": [float(v) for v in scale],
        },
        "schema_version": SCHEMA_VERSION,
        "training_boundary": {
            "split": "val",
            "sample_count": len(samples),
            "work_count": len({s.work_id for s in samples}),
            "work_ids_sha256": _hash_ids(s.work_id for s in samples),
            "sample_ids_sha256": _hash_ids(s.sample_id for s in samples),
            "candidate_rows_sha256": candidate_rows_hash,
            "none_sample_count": sum(s.none_acceptable for s in samples),
            "supervision": {
                "tier": "gold_final_only",
                "allowed_resolution_kinds": ["adjudicated", "primary"],
                "gold_final_sample_count": len(samples),
                "pseudo_label_sample_count": 0,
                "pseudo_labels_forbidden": True,
            },
        },
    }
    return seal_record(record)


def validate_calibration(record: Mapping[str, Any]) -> dict[str, Any]:
    validate_record_seal(record, location="selection calibration")
    if (
        record.get("schema_version") != SCHEMA_VERSION
        or record.get("record_type") != RECORD_TYPE
    ):
        raise SelectionCalibrationError("selection calibration schema/type unsupported")
    candidates = _list(record.get("candidate_ids"), "candidate_ids")
    names = _list(record.get("feature_names"), "feature_names")
    if (
        len(candidates) not in SUPPORTED_CANDIDATE_COUNTS
        or len(candidates) != len(set(candidates))
        or len(names) != len(set(names))
    ):
        raise SelectionCalibrationError(
            "candidate/feature inventory is unsupported or duplicated"
        )
    expected_names = [
        *CONTINUOUS_FEATURE_NAMES,
        *(f"candidate_id::{candidate_id}" for candidate_id in candidates),
    ]
    if names != expected_names:
        raise SelectionCalibrationError("candidate feature inventory drift")
    scaler = _mapping(record.get("scaler"), "scaler")
    logistic = _mapping(record.get("logistic"), "logistic")
    if not all(
        isinstance(value, list) and len(value) == len(names)
        for value in (scaler.get("mean"), scaler.get("scale"), logistic.get("coef"))
    ):
        raise SelectionCalibrationError("model vector length mismatch")
    if any(
        not isinstance(v, (int, float)) or not math.isfinite(float(v))
        for key in ("mean", "scale")
        for v in scaler[key]
    ):
        raise SelectionCalibrationError("scaler is non-finite")
    if any(float(v) <= 0 for v in scaler["scale"]):
        raise SelectionCalibrationError("scaler contains non-positive scale")
    leakage = _mapping(record.get("leakage_audit"), "leakage_audit")
    if (
        leakage.get("test_rows_used_for_fit") != 0
        or leakage.get("train_rows_used_for_fit") != 0
        or leakage.get("non_val_label_rows_parsed") != 0
        or leakage.get("pseudo_label_rows_used_for_fit") not in {None, 0}
    ):
        raise SelectionCalibrationError("selection calibration leaked non-val data")
    points = _mapping(record.get("operating_points"), "operating_points")
    if set(points) != {"body", "variant", "global"}:
        raise SelectionCalibrationError("operating point inventory drift")
    for family, value in points.items():
        point = _mapping(value, f"operating_points.{family}")
        threshold = point.get("selection_score_threshold")
        if point.get("enabled") is True and (
            not isinstance(threshold, (int, float)) or not 0 <= float(threshold) <= 1
        ):
            raise SelectionCalibrationError(f"{family}: invalid enabled threshold")
    global_point = _mapping(points.get("global"), "operating_points.global")
    if (
        global_point.get("coverage_floor_passed") is not True
        or not isinstance(global_point.get("coverage_target"), (int, float))
        or float(global_point["coverage_target"]) < 0.90
        or not isinstance(global_point.get("coverage"), (int, float))
        or float(global_point["coverage"]) < float(global_point["coverage_target"])
    ):
        raise SelectionCalibrationError("global coverage hard floor failed")
    contract = _mapping(record.get("feature_contract"), "feature_contract")
    if contract != feature_contract():
        raise SelectionCalibrationError("feature contract drift")
    return copy.deepcopy(dict(record))


def deployment_quality_gate(record: Mapping[str, Any]) -> dict[str, Any]:
    """Evaluate release quality without turning diagnostic builds into releases.

    The artifact validator above deliberately answers only whether a record is
    structurally trustworthy.  Deployment has a stricter boundary: both the
    fixed-C OOF evidence used by the runtime and the nested work-LOGO evidence
    must meet the declared precision/coverage contract.  Preferred-at-1 is a
    separate guard because a broad acceptable tier can otherwise hide a
    selector that repeatedly chooses a merely tolerable font.
    """

    validated = validate_calibration(record)
    oof_report = _mapping(validated.get("oof_report"), "oof_report")
    evidence_sets = {
        "full_oof": _mapping(oof_report.get("full_oof"), "oof_report.full_oof"),
        "nested_operating_evaluation": _mapping(
            oof_report.get("nested_operating_evaluation"),
            "oof_report.nested_operating_evaluation",
        ),
    }
    requirements = {
        "global": MINIMUM_DEPLOYMENT_GLOBAL_PREFERRED_AT1,
        "variant": MINIMUM_DEPLOYMENT_VARIANT_PREFERRED_AT1,
    }
    failures: list[str] = []
    metrics: dict[str, Any] = {}
    for evidence_name, raw_points in evidence_sets.items():
        metrics[evidence_name] = {}
        for family, preferred_floor in requirements.items():
            point = _mapping(
                raw_points.get(family), f"{evidence_name}.{family}"
            )
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
        "passed": not failures,
        "failures": failures,
        "metrics": metrics,
        "record_sha256": validated["record_sha256"],
    }


def require_deployment_quality(record: Mapping[str, Any]) -> dict[str, Any]:
    report = deployment_quality_gate(record)
    if not report["passed"]:
        raise SelectionCalibrationError(
            "deployment quality gate failed: " + "; ".join(report["failures"])
        )
    return report


def write_record(
    path: Path, record: Mapping[str, Any], *, replace_existing: bool
) -> None:
    target = path.expanduser().resolve()
    if path.exists() and path.is_symlink():
        raise SelectionCalibrationError("refusing symlink output")
    if target.exists() and not replace_existing:
        raise SelectionCalibrationError("output exists; pass --replace-existing")
    if target.exists():
        validate_calibration(_read_json(target, "existing calibration"))
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--finals", type=Path, required=True)
    build.add_argument("--master-manifest", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--runtime-dir", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--replace-existing", action="store_true")
    build.add_argument("--coverage-target", type=float, default=0.90)
    build.add_argument("--precision-target", type=float, default=0.88)
    validate = sub.add_parser("validate")
    validate.add_argument("--artifact", type=Path, required=True)
    quality = sub.add_parser("quality-gate")
    quality.add_argument("--artifact", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "validate":
        record = validate_calibration(
            _read_json(args.artifact, "selection calibration")
        )
        result: Mapping[str, Any] = {
            "record_sha256": record["record_sha256"],
            "status": "valid",
        }
    elif args.command == "quality-gate":
        record = _read_json(args.artifact, "selection calibration")
        result = require_deployment_quality(record)
    else:
        coverage = _probability(args.coverage_target, "coverage target")
        precision = _probability(args.precision_target, "precision target")
        record = build_calibration(
            finals_path=args.finals,
            master_manifest_path=args.master_manifest,
            catalog_registry_path=args.catalog_registry,
            runtime_dir=args.runtime_dir,
            coverage_target=coverage,
            precision_target=precision,
        )
        write_record(args.output, record, replace_existing=args.replace_existing)
        validate_calibration(_read_json(args.output, "selection calibration"))
        result = {
            "record_sha256": record["record_sha256"],
            "status": "valid",
        }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SelectionCalibrationError as error:
        raise SystemExit(f"selection-calibration error: {error}") from error
