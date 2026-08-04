#!/usr/bin/env python3
"""Build and validate a fail-closed Font Matching runtime bundle.

The trainer checkpoint contains only the prototype-conditioned ranker.  A
deployable bundle therefore requires a separately exported SigLIP vision
encoder, ranker ONNX graph, and sealed prototype feature bank.  This tool will
never publish a partial bundle or silently substitute the semantic bootstrap.

Row-level train/validation/test data and predictions are deliberately excluded
from the runtime output.  Only aggregate release metrics and immutable hashes
cross this boundary.
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
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np


SCHEMA_VERSION = "font-matching-runtime-artifact-v1"
RECORD_TYPE = "font_matching_runtime_artifact"
OWNER = "carrot-manga-translator/font-matching-runtime-artifact"
MARKER_FILE = ".font-matching-runtime-artifact-owned.json"
CONTRACT_FILE = "runtime-contract.json"
ENCODER_FILE = "encoder.onnx"
RANKER_FILE = "ranker.onnx"
PROTOTYPE_FILE = "prototype-features.f32"
ACTIVE_CATALOG_FILE = "auto-match-active-catalog.json"
ACTIVE_CATALOG_SCHEMA = "font-matching-auto-match-active-catalog-v1"
ACTIVE_CATALOG_RECORD_TYPE = "font_matching_auto_match_active_catalog"
FINAL_CATALOG_SCHEMA = "font-matching-final-catalog-v5"
FINAL_CATALOG_RECORD_TYPE = "font_matching_final_catalog"
CATALOG_DISPOSITION_SCHEMA = "font-matching-catalog-disposition-v5"
CATALOG_DISPOSITION_RECORD_TYPE = "font_matching_catalog_disposition"
TERMINAL_CATALOG_ACTIONS = {
    "retained_unique_p1",
    "deleted_redundant",
    "deleted_safe_zero",
}

TRAINER_SCHEMA_VERSION = "font-matching-siglip-baseline-v1"
TRAINER_OWNER = "carrot-manga-translator/font-matching-siglip-baseline"
TRAINER_MARKER = ".font-matching-siglip-baseline-owned.json"
MODEL_CONTRACT_SCHEMA = "font-matching-siglip-model-contract-v1"
TRAINING_REPORT_SCHEMA = "font-matching-siglip-training-report-v1"
PARITY_SCHEMA = "font-matching-onnx-parity-report-v1"
PARITY_RECORD_TYPE = "font_matching_onnx_parity_report"
RELEASE_SCHEMA = "font-matching-release-evaluation-v1"
RELEASE_RECORD_TYPE = "font_matching_release_evaluation"
POLICY_SCHEMA = "font-matching-runtime-policy-v1"
POLICY_RECORD_TYPE = "font_matching_runtime_policy"

TARGET_ORT_PACKAGE = "onnxruntime-web"
TARGET_ORT_VERSION = "1.27.0"
TARGET_ORT_PROVIDER = "wasm"
EXPECTED_CANDIDATE_SCORING = (
    "three-view-gated-concat-projection-to-prototype-dot-"
    "conditional-logmeanexp-bag-v1"
)
EXPECTED_ROLES = (
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
EXPECTED_STYLE_FIELDS = (
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
EXPECTED_TREATMENTS: Mapping[str, tuple[str, ...]] = {
    "orientation": ("horizontal", "vertical", "mixed", "unknown"),
    "outline": ("none", "single", "double", "multiple", "unknown"),
    "shadow": ("none", "hard", "soft", "multiple", "unknown"),
    "fill": (
        "solid",
        "gradient",
        "pattern",
        "inverse",
        "transparent",
        "unknown",
    ),
    "distortion": (
        "none",
        "slant",
        "perspective",
        "warp",
        "wave",
        "jitter",
        "other",
        "unknown",
    ),
}
RELEASE_METRICS = (
    "overall_acceptable_at_1",
    "recall_at_3",
    "p1_variant_role_macro_acceptable_at_1",
    "none_f1_p0_p1",
    "chapter_local_override_success_rate",
    "ordinary_acceptable_at_1",
)


class RuntimeArtifactError(ValueError):
    """Raised when a runtime artifact cannot be proven safe to publish."""


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
    record["record_sha256"] = sha256_bytes(canonical_json(core).encode("utf-8"))
    return record


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = _require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise RuntimeArtifactError(f"{location}: record seal mismatch")
    return actual


def _read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise RuntimeArtifactError(f"{location}: file is missing or linked")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeArtifactError(f"{location}: invalid JSON: {error}") from error
    return dict(_require_mapping(value, location))


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RuntimeArtifactError(f"{location}: expected an object")
    return value


def _require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise RuntimeArtifactError(f"{location}: expected a list")
    return value


def _require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeArtifactError(f"{location}: expected non-empty text")
    return value.strip()


def _require_sha(value: Any, location: str) -> str:
    text = _require_text(value, location).lower()
    if len(text) != 64 or any(
        character not in "0123456789abcdef" for character in text
    ):
        raise RuntimeArtifactError(f"{location}: expected a SHA-256 digest")
    return text


def _require_integer(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RuntimeArtifactError(f"{location}: expected integer >= {minimum}")
    return value


def _require_probability(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeArtifactError(f"{location}: expected a probability")
    result = float(value)
    if not math.isfinite(result) or not 0.0 <= result <= 1.0:
        raise RuntimeArtifactError(f"{location}: probability must be in [0, 1]")
    return result


def _require_finite(
    value: Any, location: str, *, minimum: float | None = None
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeArtifactError(f"{location}: expected a finite number")
    result = float(value)
    if not math.isfinite(result) or (minimum is not None and result < minimum):
        raise RuntimeArtifactError(f"{location}: invalid numeric value")
    return result


def _ordered_values_sha256(values: Sequence[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _candidate_set_sha256(values: Sequence[str]) -> str:
    return sha256_bytes(canonical_json(list(values)).encode("utf-8"))


def _validate_active_asset(value: Any, *, location: str) -> dict[str, Any]:
    asset = _require_mapping(value, location)
    face_id = _require_text(asset.get("face_id"), f"{location}.face_id")
    file_name = _require_text(asset.get("file"), f"{location}.file")
    file_path = Path(file_name)
    if file_path.is_absolute() or ".." in file_path.parts:
        raise RuntimeArtifactError(f"{location}.file must be repository-relative")
    byte_size = _require_integer(
        asset.get("byte_size"), f"{location}.byte_size", minimum=1
    )
    return {
        "face_id": face_id,
        "file": file_name.replace("\\", "/"),
        "byte_size": byte_size,
        "sha256": _require_sha(asset.get("sha256"), f"{location}.sha256"),
    }


def _validate_active_disposition(
    value: Any, *, location: str, active: bool
) -> dict[str, Any]:
    disposition = _require_mapping(value, location)
    expected_keys = {
        "action",
        "active_release_eligible",
        "all_unrenderable",
        "deployable_opportunity_count",
        "evidence_source",
        "safe_count",
        "terminal",
    }
    if (
        set(disposition) != expected_keys
        or disposition.get("active_release_eligible") is not active
        or disposition.get("terminal") is not True
        or disposition.get("all_unrenderable") is not False
    ):
        raise RuntimeArtifactError(f"{location}: invalid active disposition envelope")
    action = _require_text(disposition.get("action"), f"{location}.action")
    evidence_source = _require_text(
        disposition.get("evidence_source"), f"{location}.evidence_source"
    )
    raw_safe_count = disposition.get("safe_count")
    safe_count = (
        None
        if raw_safe_count is None
        else _require_integer(raw_safe_count, f"{location}.safe_count")
    )
    raw_opportunity_count = disposition.get("deployable_opportunity_count")
    opportunity_count = (
        None
        if raw_opportunity_count is None
        else _require_integer(
            raw_opportunity_count,
            f"{location}.deployable_opportunity_count",
            minimum=1,
        )
    )
    if evidence_source == "prior_production_catalog":
        if (
            not active
            or action != "prior_production_catalog"
            or safe_count is not None
            or opportunity_count is not None
        ):
            raise RuntimeArtifactError(f"{location}: prior catalog disposition drifted")
    elif evidence_source == "v5_catalog_disposition":
        if (
            action not in TERMINAL_CATALOG_ACTIONS
            or safe_count is None
            or opportunity_count is None
            or active != (action == "retained_unique_p1")
            or (action == "deleted_safe_zero" and safe_count != 0)
            or (action != "deleted_safe_zero" and safe_count <= 0)
        ):
            raise RuntimeArtifactError(
                f"{location}: v5 disposition is not terminal release evidence"
            )
    else:
        raise RuntimeArtifactError(f"{location}: disposition evidence source drifted")
    return {
        "action": action,
        "active_release_eligible": active,
        "all_unrenderable": False,
        "deployable_opportunity_count": opportunity_count,
        "evidence_source": evidence_source,
        "safe_count": safe_count,
        "terminal": True,
    }


def _validate_active_candidate(
    value: Any, *, location: str, active: bool
) -> dict[str, Any]:
    candidate = _require_mapping(value, location)
    expected_keys = (
        {"assets", "candidate_id", "disposition"}
        if active
        else {"candidate_id", "disposition"}
    )
    if set(candidate) != expected_keys:
        raise RuntimeArtifactError(f"{location}: candidate fields drifted")
    candidate_id = _require_text(
        candidate.get("candidate_id"), f"{location}.candidate_id"
    )
    raw_assets = (
        _require_list(candidate.get("assets"), f"{location}.assets") if active else []
    )
    if active and not raw_assets:
        raise RuntimeArtifactError(f"{location}: candidate has no installed assets")
    assets = [
        _validate_active_asset(asset, location=f"{location}.assets[{index}]")
        for index, asset in enumerate(raw_assets)
    ]
    face_ids = [asset["face_id"] for asset in assets]
    files = [asset["file"] for asset in assets]
    if len(set(face_ids)) != len(face_ids) or len(set(files)) != len(files):
        raise RuntimeArtifactError(f"{location}: duplicate active candidate assets")
    disposition = _validate_active_disposition(
        candidate.get("disposition"),
        location=f"{location}.disposition",
        active=active,
    )
    return {
        "candidate_id": candidate_id,
        "assets": assets,
        "disposition": disposition,
    }


def validate_active_catalog_record(
    record: Mapping[str, Any], *, location: str
) -> dict[str, Any]:
    validate_record_seal(record, location=location)
    if (
        record.get("schema_version") != ACTIVE_CATALOG_SCHEMA
        or record.get("record_type") != ACTIVE_CATALOG_RECORD_TYPE
    ):
        raise RuntimeArtifactError(f"{location}: active catalog schema is unsupported")
    catalog_version = _require_text(
        record.get("catalog_version"), f"{location}.catalog_version"
    )
    if record.get("locale") != "ko":
        raise RuntimeArtifactError(f"{location}: only the sealed Korean catalog is supported")
    candidate_ids = tuple(
        _require_text(value, f"{location}.candidate_ids[{index}]")
        for index, value in enumerate(
            _require_list(record.get("candidate_ids"), f"{location}.candidate_ids")
        )
    )
    if not candidate_ids or len(set(candidate_ids)) != len(candidate_ids):
        raise RuntimeArtifactError(
            f"{location}: candidate ids must be non-empty and unique"
        )
    if record.get("candidate_count") != len(candidate_ids):
        raise RuntimeArtifactError(f"{location}: candidate count drifted")
    if record.get("candidate_order_sha256") != _ordered_values_sha256(candidate_ids):
        raise RuntimeArtifactError(f"{location}: candidate order SHA drifted")
    candidates = [
        _validate_active_candidate(
            value, location=f"{location}.candidates[{index}]", active=True
        )
        for index, value in enumerate(
            _require_list(record.get("candidates"), f"{location}.candidates")
        )
    ]
    if tuple(candidate["candidate_id"] for candidate in candidates) != candidate_ids:
        raise RuntimeArtifactError(f"{location}: candidate records are out of order")
    excluded_candidates = [
        _validate_active_candidate(
            value,
            location=f"{location}.excluded_candidates[{index}]",
            active=False,
        )
        for index, value in enumerate(
            _require_list(
                record.get("excluded_candidates"),
                f"{location}.excluded_candidates",
            )
        )
    ]
    excluded_ids = [candidate["candidate_id"] for candidate in excluded_candidates]
    if len(set(excluded_ids)) != len(excluded_ids) or set(candidate_ids) & set(
        excluded_ids
    ):
        raise RuntimeArtifactError(f"{location}: excluded candidate inventory drifted")
    source_records = _require_mapping(
        record.get("source_records"), f"{location}.source_records"
    )
    expected_source_keys = {
        "catalog_disposition_record_sha256",
        "deployment_font_face_manifest_sha256",
        "deployment_render_bank_manifest_sha256",
        "evidence_font_face_manifest_sha256",
        "evidence_render_bank_manifest_sha256",
        "final_catalog_record_sha256",
    }
    if set(source_records) != expected_source_keys:
        raise RuntimeArtifactError(f"{location}: source record fields drifted")
    normalized_sources = {
        key: _require_sha(source_records.get(key), f"{location}.source_records.{key}")
        for key in sorted(expected_source_keys)
    }
    return {
        "record": dict(record),
        "record_sha256": _require_sha(
            record.get("record_sha256"), f"{location}.record_sha256"
        ),
        "catalog_version": catalog_version,
        "locale": "ko",
        "candidate_ids": candidate_ids,
        "candidate_order_sha256": _ordered_values_sha256(candidate_ids),
        "candidates": candidates,
        "excluded_candidates": excluded_candidates,
        "source_records": normalized_sources,
    }


def load_active_catalog(
    path: Path, *, location: str = "active catalog"
) -> dict[str, Any]:
    return validate_active_catalog_record(
        _read_json(path, location=location), location=location
    )


def _assert_asset_path(asset_root: Path, relative_file: str) -> Path:
    raw_path = Path(relative_file)
    if raw_path.is_absolute() or ".." in raw_path.parts:
        raise RuntimeArtifactError(
            f"font face asset must be repository-relative: {relative_file}"
        )
    root = asset_root.resolve()
    path = (root / raw_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise RuntimeArtifactError(
            f"font face asset escapes the asset root: {relative_file}"
        ) from error
    cursor = path
    while cursor != root:
        if cursor.is_symlink():
            raise RuntimeArtifactError(
                f"font face asset path is linked: {relative_file}"
            )
        cursor = cursor.parent
    if not path.is_file():
        raise RuntimeArtifactError(f"font face asset is missing: {relative_file}")
    return path


def _font_face_inventory(
    manifest: Mapping[str, Any],
    *,
    asset_root: Path,
    expected_candidate_ids: Sequence[str],
) -> dict[str, list[dict[str, Any]]]:
    if manifest.get("schema_version") != "font-face-manifest-v1":
        raise RuntimeArtifactError("font face manifest schema is unsupported")
    raw_families = _require_list(manifest.get("families"), "font face families")
    if manifest.get("family_count") != len(raw_families):
        raise RuntimeArtifactError("font face manifest family count drifted")
    inventory: dict[str, list[dict[str, Any]]] = {}
    face_count = 0
    for family_index, raw_family in enumerate(raw_families):
        family = _require_mapping(raw_family, f"font face families[{family_index}]")
        candidate_id = _require_text(
            family.get("font_id"), f"font face families[{family_index}].font_id"
        )
        if candidate_id in inventory:
            raise RuntimeArtifactError(f"duplicate font face family: {candidate_id}")
        raw_faces = _require_list(
            family.get("faces"), f"font face families[{family_index}].faces"
        )
        if not raw_faces:
            raise RuntimeArtifactError(f"font face family has no faces: {candidate_id}")
        assets: list[dict[str, Any]] = []
        for face_index, raw_face in enumerate(raw_faces):
            location = f"font face families[{family_index}].faces[{face_index}]"
            face = _require_mapping(raw_face, location)
            asset = _validate_active_asset(face, location=location)
            path = _assert_asset_path(asset_root, asset["file"])
            if (
                path.stat().st_size != asset["byte_size"]
                or sha256_file(path) != asset["sha256"]
            ):
                raise RuntimeArtifactError(
                    f"font face asset hash/size mismatch: {asset['file']}"
                )
            assets.append(asset)
        inventory[candidate_id] = assets
        face_count += len(assets)
    if manifest.get("face_count") != face_count:
        raise RuntimeArtifactError("font face manifest face count drifted")
    if set(inventory) != set(expected_candidate_ids):
        raise RuntimeArtifactError(
            "deployment font face manifest is not the exact active vocabulary"
        )
    return inventory


def _source_disposition(
    entry: Mapping[str, Any] | None, *, active: bool
) -> dict[str, Any]:
    if entry is None:
        if not active:
            raise RuntimeArtifactError(
                "prior catalog candidate cannot be excluded implicitly"
            )
        return {
            "action": "prior_production_catalog",
            "active_release_eligible": True,
            "all_unrenderable": False,
            "deployable_opportunity_count": None,
            "evidence_source": "prior_production_catalog",
            "safe_count": None,
            "terminal": True,
        }
    safe_count = _require_integer(
        entry.get("safe_count"), "catalog disposition.safe_count"
    )
    opportunity_count = _require_integer(
        entry.get("deployable_opportunity_count"),
        "catalog disposition.deployable_opportunity_count",
        minimum=1,
    )
    action = _require_text(entry.get("action"), "catalog disposition.action")
    if (
        entry.get("terminal") is not True
        or entry.get("active_release_eligible") is not active
        or entry.get("all_unrenderable") is not False
        or action not in TERMINAL_CATALOG_ACTIONS
        or active != (action == "retained_unique_p1")
        or (action == "deleted_safe_zero" and safe_count != 0)
        or (action != "deleted_safe_zero" and safe_count <= 0)
    ):
        raise RuntimeArtifactError(
            "catalog disposition is pending, failed, or not release-eligible"
        )
    return {
        "action": action,
        "active_release_eligible": active,
        "all_unrenderable": False,
        "deployable_opportunity_count": opportunity_count,
        "evidence_source": "v5_catalog_disposition",
        "safe_count": safe_count,
        "terminal": True,
    }


def _validate_deployment_render_bank(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    font_face_manifest_sha256: str,
    expected_candidate_ids: Sequence[str],
) -> None:
    if manifest.get("schema_version") != "font-render-bank-v1":
        raise RuntimeArtifactError("deployment render bank schema is unsupported")
    source_contract = _require_mapping(
        manifest.get("source_contract"), "deployment render bank.source_contract"
    )
    if source_contract.get("manifest_sha256") != font_face_manifest_sha256:
        raise RuntimeArtifactError(
            "deployment render bank is not bound to the deployment font catalog"
        )
    raw_candidates = _require_list(
        manifest.get("candidates"), "deployment render bank.candidates"
    )
    if not raw_candidates or manifest.get("candidate_count") != len(raw_candidates):
        raise RuntimeArtifactError("deployment render bank candidate count drifted")
    display_to_font: dict[str, str] = {}
    face_ids: set[str] = set()
    for index, raw_candidate in enumerate(raw_candidates):
        candidate = _require_mapping(
            raw_candidate, f"deployment render bank.candidates[{index}]"
        )
        display_id = _require_text(
            candidate.get("display_id"),
            f"deployment render bank.candidates[{index}].display_id",
        )
        font_id = _require_text(
            candidate.get("font_id"),
            f"deployment render bank.candidates[{index}].font_id",
        )
        face_id = _require_text(
            candidate.get("face_id"),
            f"deployment render bank.candidates[{index}].face_id",
        )
        if display_id in display_to_font:
            raise RuntimeArtifactError("duplicate deployment render candidate")
        display_to_font[display_id] = font_id
        face_ids.add(face_id)
    expected_ids = set(expected_candidate_ids)
    if (
        set(display_to_font.values()) != expected_ids
        or manifest.get("family_count") != len(expected_ids)
        or manifest.get("face_count") != len(face_ids)
    ):
        raise RuntimeArtifactError(
            "deployment render bank is not the exact active vocabulary"
        )
    raw_renders = _require_list(
        manifest.get("renders"), "deployment render bank.renders"
    )
    generation = _require_mapping(
        manifest.get("generation"), "deployment render bank.generation"
    )
    if (
        not raw_renders
        or generation.get("partial") is not False
        or generation.get("complete_against_production_assets") is not True
        or generation.get("rendered_count") != len(raw_renders)
    ):
        raise RuntimeArtifactError("deployment render bank is incomplete")
    rendered_font_ids: set[str] = set()
    for index, raw_render in enumerate(raw_renders):
        render = _require_mapping(raw_render, f"deployment render bank.renders[{index}]")
        display_id = _require_text(
            render.get("candidate_display_id"),
            f"deployment render bank.renders[{index}].candidate_display_id",
        )
        font_id = display_to_font.get(display_id)
        if font_id is None:
            raise RuntimeArtifactError(
                "deployment render references a candidate outside the active catalog"
            )
        artifact = _require_mapping(
            render.get("artifact"),
            f"deployment render bank.renders[{index}].artifact",
        )
        relative_file = _require_text(
            artifact.get("file"),
            f"deployment render bank.renders[{index}].artifact.file",
        )
        path = _assert_asset_path(manifest_path.parent, relative_file)
        expected_size = _require_integer(
            artifact.get("byte_size"),
            f"deployment render bank.renders[{index}].artifact.byte_size",
            minimum=1,
        )
        expected_sha = _require_sha(
            artifact.get("sha256"),
            f"deployment render bank.renders[{index}].artifact.sha256",
        )
        if path.stat().st_size != expected_size or sha256_file(path) != expected_sha:
            raise RuntimeArtifactError(
                f"deployment render asset hash/size mismatch: {relative_file}"
            )
        rendered_font_ids.add(font_id)
    if rendered_font_ids != expected_ids:
        raise RuntimeArtifactError("deployment render bank does not cover every active font")


def build_active_catalog(
    *,
    final_catalog_path: Path,
    catalog_disposition_path: Path,
    deployment_font_face_manifest_path: Path,
    deployment_render_bank_manifest_path: Path,
    asset_root: Path,
    output_path: Path,
    deployment_candidate_order: Sequence[str] | None = None,
    replace_existing: bool = False,
) -> Mapping[str, Any]:
    final_catalog = _read_json(final_catalog_path, location="v5 final catalog")
    disposition = _read_json(
        catalog_disposition_path, location="v5 catalog disposition"
    )
    validate_record_seal(final_catalog, location="v5 final catalog")
    validate_record_seal(disposition, location="v5 catalog disposition")
    if (
        final_catalog.get("schema_version") != FINAL_CATALOG_SCHEMA
        or final_catalog.get("record_type") != FINAL_CATALOG_RECORD_TYPE
        or disposition.get("schema_version") != CATALOG_DISPOSITION_SCHEMA
        or disposition.get("record_type") != CATALOG_DISPOSITION_RECORD_TYPE
    ):
        raise RuntimeArtifactError("active catalog requires finalized v5 records")
    if (
        disposition.get("release_state") != "final_released"
        or disposition.get("final_release_allowed") is not True
    ):
        raise RuntimeArtifactError(
            "catalog disposition is provisional and cannot enter deployment"
        )
    disposition_sha = _require_sha(
        disposition.get("record_sha256"), "catalog disposition.record_sha256"
    )
    if final_catalog.get("catalog_disposition_record_sha256") != disposition_sha:
        raise RuntimeArtifactError("final catalog/disposition binding failed")
    if final_catalog.get("workspace_contract_record_sha256") != disposition.get(
        "workspace_contract_record_sha256"
    ):
        raise RuntimeArtifactError("v5 workspace binding failed")
    source_catalog_sha = _require_sha(
        final_catalog.get("source_catalog_sha256"),
        "final catalog.source_catalog_sha256",
    )
    if disposition.get("source_catalog_sha256") != source_catalog_sha:
        raise RuntimeArtifactError("v5 source catalog binding failed")
    evidence_render_sha = _require_sha(
        disposition.get("source_render_bank_sha256"),
        "catalog disposition.source_render_bank_sha256",
    )

    candidate_ids = tuple(
        _require_text(value, f"final catalog.candidate_ids[{index}]")
        for index, value in enumerate(
            _require_list(
                final_catalog.get("candidate_ids"), "final catalog.candidate_ids"
            )
        )
    )
    if (
        not candidate_ids
        or len(set(candidate_ids)) != len(candidate_ids)
        or list(candidate_ids) != sorted(candidate_ids)
        or final_catalog.get("candidate_count") != len(candidate_ids)
        or final_catalog.get("candidate_set_sha256")
        != _candidate_set_sha256(candidate_ids)
    ):
        raise RuntimeArtifactError("final v5 candidate inventory drifted")
    active_candidate_ids = candidate_ids
    if deployment_candidate_order is not None:
        active_candidate_ids = tuple(
            _require_text(value, f"deployment candidate order[{index}]")
            for index, value in enumerate(deployment_candidate_order)
        )
        if (
            len(active_candidate_ids) != len(candidate_ids)
            or len(set(active_candidate_ids)) != len(active_candidate_ids)
            or set(active_candidate_ids) != set(candidate_ids)
        ):
            raise RuntimeArtifactError(
                "deployment candidate order is not an exact final-catalog permutation"
            )
    manifest = _read_json(
        deployment_font_face_manifest_path,
        location="deployment font face manifest",
    )
    deployment_font_sha = sha256_file(deployment_font_face_manifest_path)
    inventory = _font_face_inventory(
        manifest,
        asset_root=asset_root,
        expected_candidate_ids=candidate_ids,
    )
    render_manifest = _read_json(
        deployment_render_bank_manifest_path,
        location="deployment render bank manifest",
    )
    deployment_render_sha = sha256_file(deployment_render_bank_manifest_path)
    _validate_deployment_render_bank(
        render_manifest,
        manifest_path=deployment_render_bank_manifest_path,
        font_face_manifest_sha256=deployment_font_sha,
        expected_candidate_ids=candidate_ids,
    )
    prior_ids = tuple(
        _require_text(value, f"final catalog.prior_candidate_ids[{index}]")
        for index, value in enumerate(
            _require_list(
                final_catalog.get("prior_candidate_ids"),
                "final catalog.prior_candidate_ids",
            )
        )
    )
    if len(set(prior_ids)) != len(prior_ids) or final_catalog.get(
        "prior_candidate_count"
    ) != len(prior_ids):
        raise RuntimeArtifactError("final v5 prior candidate inventory drifted")
    raw_entries = _require_list(
        disposition.get("entries"), "catalog disposition.entries"
    )
    entries_by_id: dict[str, Mapping[str, Any]] = {}
    for index, raw_entry in enumerate(raw_entries):
        entry = _require_mapping(raw_entry, f"catalog disposition.entries[{index}]")
        candidate_id = _require_text(
            entry.get("candidate_id"),
            f"catalog disposition.entries[{index}].candidate_id",
        )
        if candidate_id in entries_by_id:
            raise RuntimeArtifactError(f"duplicate v5 disposition: {candidate_id}")
        entries_by_id[candidate_id] = entry
    if disposition.get("candidate_count") != len(entries_by_id):
        raise RuntimeArtifactError("catalog disposition candidate count drifted")

    included_delta_ids = {
        _require_text(
            _require_mapping(value, f"included delta[{index}]").get("candidate_id"),
            f"included delta[{index}].candidate_id",
        )
        for index, value in enumerate(
            _require_list(
                final_catalog.get("included_delta_candidates"),
                "final catalog.included_delta_candidates",
            )
        )
    }
    removed_delta_ids = {
        _require_text(
            _require_mapping(value, f"removed delta[{index}]").get("candidate_id"),
            f"removed delta[{index}].candidate_id",
        )
        for index, value in enumerate(
            _require_list(
                final_catalog.get("removed_delta_candidates"),
                "final catalog.removed_delta_candidates",
            )
        )
    }
    if (
        included_delta_ids & removed_delta_ids
        or set(entries_by_id) != included_delta_ids | removed_delta_ids
        or set(candidate_ids) != set(prior_ids) | included_delta_ids
        or final_catalog.get("included_delta_candidate_count")
        != len(included_delta_ids)
        or final_catalog.get("removed_delta_candidate_count") != len(removed_delta_ids)
    ):
        raise RuntimeArtifactError("final v5 delta disposition inventory drifted")

    def candidate_record(candidate_id: str, *, active: bool) -> dict[str, Any]:
        assets = inventory.get(candidate_id)
        if active and not assets:
            raise RuntimeArtifactError(
                f"finalized candidate has no installed font asset: {candidate_id}"
            )
        entry = entries_by_id.get(candidate_id)
        if candidate_id in prior_ids and entry is not None:
            raise RuntimeArtifactError(
                f"prior and delta candidate identities overlap: {candidate_id}"
            )
        return {
            **({"assets": copy.deepcopy(assets)} if active else {}),
            "candidate_id": candidate_id,
            "disposition": _source_disposition(entry, active=active),
        }

    candidates = [
        candidate_record(candidate_id, active=True)
        for candidate_id in active_candidate_ids
    ]
    excluded_candidates = [
        candidate_record(candidate_id, active=False)
        for candidate_id in sorted(removed_delta_ids)
    ]
    record = seal_record(
        {
            "candidate_count": len(active_candidate_ids),
            "candidate_ids": list(active_candidate_ids),
            "candidate_order_sha256": _ordered_values_sha256(active_candidate_ids),
            "candidates": candidates,
            "catalog_version": _require_text(
                final_catalog.get("catalog_version"), "final catalog.catalog_version"
            ),
            "excluded_candidates": excluded_candidates,
            "locale": "ko",
            "record_type": ACTIVE_CATALOG_RECORD_TYPE,
            "schema_version": ACTIVE_CATALOG_SCHEMA,
            "source_records": {
                "catalog_disposition_record_sha256": disposition_sha,
                "deployment_font_face_manifest_sha256": deployment_font_sha,
                "deployment_render_bank_manifest_sha256": deployment_render_sha,
                "evidence_font_face_manifest_sha256": source_catalog_sha,
                "evidence_render_bank_manifest_sha256": evidence_render_sha,
                "final_catalog_record_sha256": _require_sha(
                    final_catalog.get("record_sha256"),
                    "final catalog.record_sha256",
                ),
            },
        }
    )
    validated = validate_active_catalog_record(
        record, location="generated active catalog"
    )
    payload = json_bytes(record, pretty=True)
    output = output_path.resolve()
    if output.exists():
        if output.is_symlink() or not output.is_file():
            raise RuntimeArtifactError("active catalog output is not a regular file")
        if output.read_bytes() == payload:
            return {
                "candidate_count": len(candidate_ids),
                "output_path": str(output),
                "record_sha256": validated["record_sha256"],
                "status": "unchanged",
            }
        if not replace_existing:
            raise RuntimeArtifactError(
                "active catalog output exists; pass --replace-existing after validation"
            )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.staging-{uuid.uuid4().hex}")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "candidate_count": len(candidate_ids),
        "excluded_candidate_count": len(excluded_candidates),
        "output_path": str(output),
        "record_sha256": validated["record_sha256"],
        "status": "ready",
    }


def _artifact_descriptor(path: Path, *, file_name: str | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise RuntimeArtifactError(f"runtime source asset is missing or linked: {path}")
    return {
        "byte_size": path.stat().st_size,
        "file": file_name or path.name,
        "sha256": sha256_file(path),
    }


def _validate_exact_inventory(root: Path, expected: set[str], *, location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise RuntimeArtifactError(f"{location}: directory is missing or linked")
    actual: set[str] = set()
    for path in root.iterdir():
        if path.is_symlink() or not path.is_file():
            raise RuntimeArtifactError(
                f"{location}: nested or linked entries are forbidden"
            )
        actual.add(path.name)
    if actual != expected:
        raise RuntimeArtifactError(
            f"{location}: file inventory drifted; expected={sorted(expected)} actual={sorted(actual)}"
        )


def _safetensor_contract(path: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    try:
        from safetensors import safe_open
    except ImportError as error:  # pragma: no cover - release environment
        raise RuntimeArtifactError(
            "safetensors is required for runtime export"
        ) from error
    try:
        with safe_open(str(path), framework="np") as handle:
            metadata = dict(handle.metadata() or {})
            state = []
            for name in sorted(handle.keys()):
                tensor = handle.get_tensor(name)
                state.append(
                    {
                        "dtype": str(tensor.dtype),
                        "name": name,
                        "shape": list(tensor.shape),
                    }
                )
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeArtifactError(f"checkpoint failed to load: {error}") from error
    return state, metadata


def _expected_head_state_contract(contract: Mapping[str, Any]) -> list[dict[str, Any]]:
    architecture = _require_mapping(contract.get("architecture"), "model architecture")
    feature_dim = _require_integer(
        architecture.get("feature_dim"), "feature_dim", minimum=1
    )
    hidden_dim = _require_integer(
        architecture.get("hidden_dim"), "hidden_dim", minimum=1
    )
    vocabulary = _require_mapping(contract.get("vocabulary"), "model vocabulary")
    roles = _require_list(vocabulary.get("roles"), "model vocabulary.roles")
    styles = _require_list(
        vocabulary.get("style_fields"), "model vocabulary.style_fields"
    )
    treatments = _require_mapping(
        vocabulary.get("treatments"), "model vocabulary.treatments"
    )
    shapes: dict[str, list[int]] = {
        "logit_scale": [],
        "none_head.bias": [1],
        "none_head.weight": [1, hidden_dim],
        "prototype_projection.0.bias": [feature_dim],
        "prototype_projection.0.weight": [feature_dim],
        "prototype_projection.1.weight": [hidden_dim, feature_dim],
        "role_head.bias": [len(roles)],
        "role_head.weight": [len(roles), hidden_dim],
        "sample_projection.0.bias": [hidden_dim],
        "sample_projection.0.weight": [hidden_dim, feature_dim * 4],
        "sample_projection.3.bias": [hidden_dim],
        "sample_projection.3.weight": [hidden_dim],
        "style_head.bias": [len(styles)],
        "style_head.weight": [len(styles), hidden_dim],
        "view_gate.bias": [1],
        "view_gate.weight": [1, feature_dim],
        "view_norm.bias": [feature_dim],
        "view_norm.weight": [feature_dim],
    }
    for field, values in treatments.items():
        count = len(_require_list(values, f"model vocabulary.treatments.{field}"))
        shapes[f"treatment_heads.{field}.bias"] = [count]
        shapes[f"treatment_heads.{field}.weight"] = [count, hidden_dim]
    return [
        {"dtype": "float32", "name": name, "shape": shapes[name]}
        for name in sorted(shapes)
    ]


def _validate_vocabulary(
    contract: Mapping[str, Any], *, expected_candidate_ids: Sequence[str]
) -> tuple[str, ...]:
    vocabulary = _require_mapping(contract.get("vocabulary"), "model vocabulary")
    raw_ids = _require_list(vocabulary.get("candidate_ids"), "candidate_ids")
    candidate_ids = tuple(
        _require_text(value, f"candidate_ids[{index}]")
        for index, value in enumerate(raw_ids)
    )
    expected = tuple(expected_candidate_ids)
    if candidate_ids != expected:
        raise RuntimeArtifactError(
            "candidate ids/order differ from the authoritative production catalog"
        )
    if (
        vocabulary.get("candidate_parameterization")
        != "prototype-bag-only-no-id-embedding-or-bias"
    ):
        raise RuntimeArtifactError("candidate parameterization is unsafe")
    if tuple(vocabulary.get("roles", ())) != EXPECTED_ROLES:
        raise RuntimeArtifactError("semantic role vocabulary drifted")
    if tuple(vocabulary.get("style_fields", ())) != EXPECTED_STYLE_FIELDS:
        raise RuntimeArtifactError("source-style vocabulary drifted")
    treatments = _require_mapping(vocabulary.get("treatments"), "treatments")
    if {key: tuple(value) for key, value in treatments.items()} != EXPECTED_TREATMENTS:
        raise RuntimeArtifactError("treatment vocabulary drifted")
    return candidate_ids


def _validate_training_safety(
    contract: Mapping[str, Any], report: Mapping[str, Any]
) -> None:
    checks = _require_mapping(report.get("checks"), "training report.checks")
    required_zero = (
        "candidate_id_classifier_parameters",
        "chapter_pair_test_rows_used",
        "synthetic_or_qa_inputs",
        "test_pixels_opened_or_cached",
        "test_rows_used_for_optimizer_calibration_prototypes_or_hard_negatives",
    )
    for key in required_zero:
        if checks.get(key) != 0:
            raise RuntimeArtifactError(f"training leakage/safety check failed: {key}")
    required_true = (
        "encoder_fully_frozen",
        "prediction_semantics_from_model_heads",
        "train_split_used_for_optimizer",
        "val_split_used_for_calibration_and_early_stop",
    )
    for key in required_true:
        if checks.get(key) is not True:
            raise RuntimeArtifactError(f"training safety check failed: {key}")
    safety = _require_mapping(
        contract.get("ordinary_regression_safety"), "ordinary regression safety"
    )
    if safety.get("baseline_status") not in {
        "production_same_input_resume_reference",
        "production_reference",
    }:
        raise RuntimeArtifactError(
            "non-production ordinary regression baseline is forbidden"
        )
    gate = _require_mapping(
        safety.get("best_ordinary_regression_gate"), "ordinary regression gate"
    )
    if gate.get("passed") is not True:
        raise RuntimeArtifactError("ordinary regression gate did not pass")
    if (
        safety.get("optimizer_seeded_from_ordinary_reference") is not False
        or safety.get("ordinary_reference_argument_seeded_optimizer") is not False
    ):
        raise RuntimeArtifactError("ordinary reference crossed the optimizer boundary")


def _load_training_bundle(
    root: Path, *, expected_candidate_ids: Sequence[str]
) -> dict[str, Any]:
    expected_files = {
        TRAINER_MARKER,
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
        "report.json",
    }
    _validate_exact_inventory(root, expected_files, location="trainer output")
    marker_path = root / TRAINER_MARKER
    marker = _read_json(marker_path, location="trainer marker")
    if (
        marker.get("owner") != TRAINER_OWNER
        or marker.get("schema_version") != TRAINER_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise RuntimeArtifactError("trainer ownership marker is invalid")
    marker_artifacts = _require_mapping(marker.get("artifacts"), "trainer artifacts")
    for file_name in expected_files - {TRAINER_MARKER}:
        if marker_artifacts.get(file_name) != sha256_file(root / file_name):
            raise RuntimeArtifactError(f"trainer artifact hash mismatch: {file_name}")
    contract_path = root / "model-contract.json"
    report_path = root / "report.json"
    checkpoint_path = root / "checkpoint.safetensors"
    contract = _read_json(contract_path, location="trainer model contract")
    report = _read_json(report_path, location="trainer report")
    validate_record_seal(contract, location="trainer model contract")
    validate_record_seal(report, location="trainer report")
    if (
        contract.get("schema_version") != MODEL_CONTRACT_SCHEMA
        or contract.get("record_type") != "font_matching_siglip_model_contract"
    ):
        raise RuntimeArtifactError("trainer model contract schema is unsupported")
    if (
        report.get("schema_version") != TRAINING_REPORT_SCHEMA
        or report.get("record_type") != "font_matching_siglip_training_report"
    ):
        raise RuntimeArtifactError("trainer report schema is unsupported")
    if report.get("model_contract_sha256") != sha256_file(contract_path):
        raise RuntimeArtifactError("trainer report/model contract binding failed")
    candidate_ids = _validate_vocabulary(
        contract, expected_candidate_ids=expected_candidate_ids
    )
    architecture = _require_mapping(contract.get("architecture"), "model architecture")
    if architecture.get("candidate_scoring") != EXPECTED_CANDIDATE_SCORING:
        raise RuntimeArtifactError("ranker architecture is unsupported")
    encoder = _require_mapping(contract.get("encoder"), "model encoder")
    if (
        encoder.get("class") != "SiglipVisionModel"
        or encoder.get("fully_frozen") is not True
        or encoder.get("optimizer_parameter_overlap") != 0
    ):
        raise RuntimeArtifactError("encoder was not frozen safely")
    _require_text(encoder.get("model_id"), "encoder.model_id")
    revision = _require_text(encoder.get("revision"), "encoder.revision")
    if len(revision) != 40 or any(
        character not in "0123456789abcdef" for character in revision
    ):
        raise RuntimeArtifactError("encoder revision must be an immutable Git commit")
    calibration = _require_mapping(contract.get("calibration"), "model calibration")
    if calibration.get("calibration_split") != "val":
        raise RuntimeArtifactError("calibration must use only the validation split")
    _require_probability(calibration.get("none_threshold"), "none threshold")
    temperature = _require_finite(
        calibration.get("temperature"), "temperature", minimum=0.000001
    )
    if temperature > 10.0:
        raise RuntimeArtifactError("temperature is outside the runtime contract")
    inputs = _require_mapping(contract.get("inputs"), "model inputs")
    for key in (
        "catalog_registry_sha256",
        "font_catalog_sha256",
        "font_prototypes_sha256",
        "frozen_test_manifest_sha256",
        "listwise_sha256",
        "pairwise_sha256",
        "render_bank_manifest_sha256",
        "render_specification_sha256",
        "retrieval_sha256",
        "samples_sha256",
        "training_export_manifest_sha256",
    ):
        _require_sha(inputs.get(key), f"model inputs.{key}")
    checkpoint = _require_mapping(contract.get("checkpoint"), "model checkpoint")
    if checkpoint.get("file") != checkpoint_path.name or checkpoint.get(
        "sha256"
    ) != sha256_file(checkpoint_path):
        raise RuntimeArtifactError("checkpoint binding failed")
    state_contract, checkpoint_metadata = _safetensor_contract(checkpoint_path)
    if checkpoint.get("state_contract") != state_contract:
        raise RuntimeArtifactError("checkpoint tensor inventory drifted")
    if state_contract != _expected_head_state_contract(contract):
        raise RuntimeArtifactError("checkpoint head architecture drifted")
    if checkpoint.get("metadata") != checkpoint_metadata:
        raise RuntimeArtifactError("checkpoint metadata binding failed")
    _validate_training_safety(contract, report)
    return {
        "candidate_ids": candidate_ids,
        "checkpoint_path": checkpoint_path,
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "contract": contract,
        "contract_path": contract_path,
        "contract_sha256": sha256_file(contract_path),
        "report": report,
        "report_sha256": sha256_file(report_path),
    }


def _validate_candidate_bags(
    value: Any, *, candidate_ids: Sequence[str]
) -> tuple[dict[str, Any], ...]:
    rows = _require_list(value, "conversion report.candidate_bags")
    if len(rows) != len(candidate_ids):
        raise RuntimeArtifactError("prototype candidate bag count drifted")
    output = []
    next_start = 0
    for index, (raw, candidate_id) in enumerate(zip(rows, candidate_ids, strict=True)):
        row = _require_mapping(raw, f"candidate_bags[{index}]")
        start = _require_integer(row.get("start"), f"candidate_bags[{index}].start")
        count = _require_integer(
            row.get("count"), f"candidate_bags[{index}].count", minimum=1
        )
        if row.get("candidate_id") != candidate_id or start != next_start:
            raise RuntimeArtifactError(
                "prototype candidate bags are reordered or non-contiguous"
            )
        output.append({"candidate_id": candidate_id, "count": count, "start": start})
        next_start += count
    return tuple(output)


def _expected_onnx_io(
    *, contract: Mapping[str, Any], prototype_count: int, candidate_count: int
) -> dict[str, Any]:
    architecture = _require_mapping(contract.get("architecture"), "model architecture")
    feature_dim = _require_integer(
        architecture.get("feature_dim"), "feature_dim", minimum=1
    )
    vocabulary = _require_mapping(contract.get("vocabulary"), "model vocabulary")
    roles = _require_list(vocabulary.get("roles"), "roles")
    styles = _require_list(vocabulary.get("style_fields"), "style fields")
    treatments = _require_mapping(vocabulary.get("treatments"), "treatments")
    ranker_outputs = [
        {
            "name": "candidate_scores",
            "shape": [None, candidate_count],
            "type": "tensor(float)",
        },
        {"name": "none_logits", "shape": [None], "type": "tensor(float)"},
        {"name": "role_logits", "shape": [None, len(roles)], "type": "tensor(float)"},
        {"name": "style_logits", "shape": [None, len(styles)], "type": "tensor(float)"},
    ]
    ranker_outputs.extend(
        {
            "name": f"treatment_{field}_logits",
            "shape": [None, len(_require_list(values, f"treatments.{field}"))],
            "type": "tensor(float)",
        }
        for field, values in sorted(treatments.items())
    )
    ranker_outputs.append(
        {"name": "view_gate_weights", "shape": [None, 3], "type": "tensor(float)"}
    )
    return {
        ENCODER_FILE: {
            "inputs": [
                {
                    "name": "pixel_values",
                    "shape": [None, 3, 224, 224],
                    "type": "tensor(float)",
                }
            ],
            "outputs": [
                {
                    "name": "image_features",
                    "shape": [None, feature_dim],
                    "type": "tensor(float)",
                }
            ],
        },
        RANKER_FILE: {
            "inputs": [
                {
                    "name": "views",
                    "shape": [None, 3, feature_dim],
                    "type": "tensor(float)",
                },
                {
                    "name": "prototype_features",
                    "shape": [prototype_count, feature_dim],
                    "type": "tensor(float)",
                },
            ],
            "outputs": ranker_outputs,
        },
    }


def _normalize_ort_shape(shape: Sequence[Any]) -> list[Any]:
    return [value if isinstance(value, int) else None for value in shape]


def _inspect_onnx_contract(path: Path) -> dict[str, Any]:
    try:
        import onnxruntime as ort
    except ImportError as error:  # pragma: no cover - release environment
        raise RuntimeArtifactError(
            "onnxruntime is required to inspect runtime graphs"
        ) from error
    try:
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    except Exception as error:  # noqa: BLE001 - normalize third-party failures
        raise RuntimeArtifactError(
            f"ONNX graph failed to load: {path.name}: {error}"
        ) from error
    return {
        "inputs": [
            {
                "name": item.name,
                "shape": _normalize_ort_shape(item.shape),
                "type": item.type,
            }
            for item in session.get_inputs()
        ],
        "outputs": [
            {
                "name": item.name,
                "shape": _normalize_ort_shape(item.shape),
                "type": item.type,
            }
            for item in session.get_outputs()
        ],
    }


def _validate_parity_metrics(parity: Mapping[str, Any], *, prefix: str) -> None:
    if (
        _require_integer(
            parity.get("sample_count"), f"{prefix}.sample_count", minimum=32
        )
        < 32
    ):
        raise RuntimeArtifactError(f"{prefix}: insufficient parity sample count")
    if parity.get("sample_source") != "synthetic_plus_validation":
        raise RuntimeArtifactError(
            f"{prefix}: parity source must exclude train and test"
        )
    if (
        parity.get("frozen_test_rows_used") != 0
        or parity.get("frozen_test_pixels_opened") != 0
        or parity.get("test_identifiers_embedded") is not False
    ):
        raise RuntimeArtifactError(
            f"{prefix}: frozen test data crossed conversion boundary"
        )
    encoder = _require_mapping(parity.get("encoder"), f"{prefix}.encoder")
    if (
        _require_finite(encoder.get("max_abs_error"), f"{prefix}.encoder.max_abs_error")
        > 2e-4
        or _require_probability(
            encoder.get("minimum_cosine_similarity"),
            f"{prefix}.encoder.minimum_cosine_similarity",
        )
        < 0.999
    ):
        raise RuntimeArtifactError(f"{prefix}: encoder parity gate failed")
    ranker = _require_mapping(parity.get("ranker"), f"{prefix}.ranker")
    if (
        _require_finite(ranker.get("max_abs_error"), f"{prefix}.ranker.max_abs_error")
        > 2e-4
    ):
        raise RuntimeArtifactError(f"{prefix}: ranker numeric parity gate failed")
    for key in (
        "candidate_top1_agreement",
        "none_decision_agreement",
        "role_top1_agreement",
    ):
        if _require_probability(ranker.get(key), f"{prefix}.ranker.{key}") != 1.0:
            raise RuntimeArtifactError(
                f"{prefix}: ranker decision parity gate failed: {key}"
            )


def _load_conversion_report(
    path: Path,
    *,
    training: Mapping[str, Any],
    encoder_onnx: Path,
    ranker_onnx: Path,
    prototype_features: Path,
    encoder_source_weights: Path,
) -> dict[str, Any]:
    report = _read_json(path, location="ONNX parity report")
    validate_record_seal(report, location="ONNX parity report")
    if (
        report.get("schema_version") != PARITY_SCHEMA
        or report.get("record_type") != PARITY_RECORD_TYPE
    ):
        raise RuntimeArtifactError("ONNX parity report schema is unsupported")
    source = _require_mapping(report.get("source"), "ONNX parity report.source")
    contract = _require_mapping(training.get("contract"), "training contract")
    encoder = _require_mapping(contract.get("encoder"), "training encoder")
    expected_source = {
        "checkpoint_sha256": training["checkpoint_sha256"],
        "encoder_model_id": encoder.get("model_id"),
        "encoder_revision": encoder.get("revision"),
        "encoder_source_weights_sha256": sha256_file(encoder_source_weights),
        "model_contract_sha256": training["contract_sha256"],
    }
    if dict(source) != expected_source:
        raise RuntimeArtifactError("ONNX parity report source binding failed")
    actual_assets = {
        "encoder_onnx_sha256": sha256_file(encoder_onnx),
        "prototype_features_sha256": sha256_file(prototype_features),
        "ranker_onnx_sha256": sha256_file(ranker_onnx),
    }
    if (
        dict(_require_mapping(report.get("artifacts"), "parity artifacts"))
        != actual_assets
    ):
        raise RuntimeArtifactError("ONNX parity artifact hashes drifted")
    candidate_ids = tuple(training["candidate_ids"])
    if tuple(report.get("candidate_ids", ())) != candidate_ids:
        raise RuntimeArtifactError("ONNX candidate order drifted")
    if report.get("candidate_ids_sha256") != _ordered_values_sha256(candidate_ids):
        raise RuntimeArtifactError("ONNX candidate-order hash drifted")
    bags = _validate_candidate_bags(
        report.get("candidate_bags"), candidate_ids=candidate_ids
    )
    prototype_count = sum(int(row["count"]) for row in bags)
    feature_dim = int(
        _require_mapping(contract.get("architecture"), "architecture")["feature_dim"]
    )
    if prototype_features.stat().st_size != prototype_count * feature_dim * 4:
        raise RuntimeArtifactError("prototype feature bank byte size drifted")
    values = np.fromfile(prototype_features, dtype="<f4")
    if values.size != prototype_count * feature_dim or not np.isfinite(values).all():
        raise RuntimeArtifactError("prototype feature bank contains invalid values")
    _validate_parity_metrics(
        _require_mapping(report.get("reference_parity"), "reference parity"),
        prefix="reference_parity",
    )
    target = _require_mapping(report.get("target_runtime"), "target runtime")
    if (
        target.get("package") != TARGET_ORT_PACKAGE
        or target.get("version") != TARGET_ORT_VERSION
        or target.get("execution_provider") != TARGET_ORT_PROVIDER
        or target.get("io_contract_passed") is not True
        or target.get("all_outputs_finite") is not True
        or _require_integer(
            target.get("smoke_case_count"), "target smoke cases", minimum=8
        )
        < 8
    ):
        raise RuntimeArtifactError("target onnxruntime-web WASM gate failed")
    _validate_parity_metrics(
        _require_mapping(target.get("parity"), "target runtime parity"),
        prefix="target_runtime.parity",
    )
    expected_io = _expected_onnx_io(
        contract=contract,
        prototype_count=prototype_count,
        candidate_count=len(candidate_ids),
    )
    if report.get("io_contract") != expected_io:
        raise RuntimeArtifactError("sealed ONNX I/O contract drifted")
    if _inspect_onnx_contract(encoder_onnx) != expected_io[ENCODER_FILE]:
        raise RuntimeArtifactError("encoder ONNX I/O inspection failed")
    if _inspect_onnx_contract(ranker_onnx) != expected_io[RANKER_FILE]:
        raise RuntimeArtifactError("ranker ONNX I/O inspection failed")
    return {
        "candidate_bags": bags,
        "prototype_count": prototype_count,
        "report": report,
    }


def _load_release_evaluation(
    path: Path, *, training: Mapping[str, Any]
) -> dict[str, Any]:
    report = _read_json(path, location="release evaluation")
    validate_record_seal(report, location="release evaluation")
    if (
        report.get("schema_version") != RELEASE_SCHEMA
        or report.get("record_type") != RELEASE_RECORD_TYPE
    ):
        raise RuntimeArtifactError("release evaluation schema is unsupported")
    training_contract = _require_mapping(training.get("contract"), "training contract")
    training_inputs = _require_mapping(
        training_contract.get("inputs"), "training inputs"
    )
    upstream_test_manifest_sha = _require_sha(
        training_inputs.get("frozen_test_manifest_sha256"),
        "training inputs.frozen_test_manifest_sha256",
    )
    if report.get("source") != {
        "candidate_ids_sha256": _ordered_values_sha256(training["candidate_ids"]),
        "checkpoint_sha256": training["checkpoint_sha256"],
        "frozen_test_manifest_sha256": upstream_test_manifest_sha,
        "model_contract_sha256": training["contract_sha256"],
    }:
        raise RuntimeArtifactError("release evaluation source binding failed")
    boundary = _require_mapping(report.get("test_data_boundary"), "test data boundary")
    if (
        boundary.get("split") != "frozen_test"
        or boundary.get("work_disjoint") is not True
        or boundary.get("frozen_before_training") is not True
        or boundary.get(
            "rows_used_for_optimizer_calibration_prototypes_or_hard_negatives"
        )
        != 0
        or boundary.get("pixels_opened_by_runtime_exporter") != 0
        or boundary.get("row_level_predictions_embedded") is not False
        or boundary.get("sample_identifiers_embedded") is not False
    ):
        raise RuntimeArtifactError(
            "release evaluation leaked or reused frozen test data"
        )
    if (
        _require_sha(boundary.get("test_manifest_sha256"), "test manifest sha256")
        != upstream_test_manifest_sha
    ):
        raise RuntimeArtifactError("release evaluation frozen-test manifest drifted")
    _require_integer(
        boundary.get("evaluated_row_count"), "evaluated row count", minimum=1
    )
    gate = _require_mapping(report.get("gate"), "release gate")
    if gate.get("passed") is not True or gate.get("failed_checks") != []:
        raise RuntimeArtifactError("release evaluation gate did not pass")
    metrics = _require_mapping(report.get("metrics"), "release metrics")
    thresholds = _require_mapping(report.get("thresholds"), "release thresholds")
    if set(metrics) != set(RELEASE_METRICS) or set(thresholds) != set(RELEASE_METRICS):
        raise RuntimeArtifactError("release metric inventory drifted")
    for key in RELEASE_METRICS:
        metric = _require_probability(metrics.get(key), f"release metrics.{key}")
        threshold = _require_probability(
            thresholds.get(key), f"release thresholds.{key}"
        )
        if metric < threshold:
            raise RuntimeArtifactError(f"release metric failed threshold: {key}")
    return report


def _load_policy(path: Path) -> dict[str, Any]:
    policy = _read_json(path, location="runtime policy")
    validate_record_seal(policy, location="runtime policy")
    if (
        policy.get("schema_version") != POLICY_SCHEMA
        or policy.get("record_type") != POLICY_RECORD_TYPE
    ):
        raise RuntimeArtifactError("runtime policy schema is unsupported")
    automatic = _require_mapping(policy.get("automatic_mutation"), "automatic mutation")
    for key in (
        "minimum_calibrated_confidence",
        "minimum_role_confidence",
        "minimum_intentional_override_confidence",
        "intentional_override_minimum_score_margin",
    ):
        _require_probability(automatic.get(key), f"automatic mutation.{key}")
    if (
        automatic.get("require_none_acceptable_false") is not True
        or automatic.get("require_translation_glyph_coverage") is not True
        or automatic.get("require_runtime_artifact_ready") is not True
    ):
        raise RuntimeArtifactError("automatic mutation policy is not fail closed")
    chapter = _require_mapping(policy.get("chapter_prior"), "chapter prior")
    if (
        chapter.get("mode") != "weak_prior_never_hard_constraint"
        or chapter.get("scope") != "chapter"
        or chapter.get("real_local_change_overrides_prior") is not True
        or _require_probability(
            chapter.get("maximum_score_contribution"),
            "chapter prior.maximum_score_contribution",
        )
        > 0.1
        or _require_integer(
            chapter.get("minimum_anchor_evidence_count"),
            "chapter prior.minimum_anchor_evidence_count",
            minimum=1,
        )
        < 2
    ):
        raise RuntimeArtifactError("chapter prior is too strong or underspecified")
    _require_probability(
        chapter.get("local_override_minimum_score_margin"),
        "chapter prior.local_override_minimum_score_margin",
    )
    fallback = _require_mapping(policy.get("fallback"), "fallback policy")
    if dict(fallback) != {
        "automatic_profile_without_pixel_model": "forbidden",
        "invalid_artifact": "explicit_disabled",
        "manual_user_lock": "allowed",
        "missing_artifact": "explicit_disabled",
        "semantic_bootstrap": "forbidden",
    }:
        raise RuntimeArtifactError("runtime fallback policy permits a silent heuristic")
    return policy


def _assert_safe_output_target(path: Path) -> Path:
    root = path.resolve()
    forbidden = {
        Path.cwd().resolve(),
        Path.home().resolve(),
        Path(root.anchor).resolve(),
    }
    if root in forbidden or len(root.parts) < 3:
        raise RuntimeArtifactError(f"unsafe runtime output target: {root}")
    return root


def _validate_output_marker(root: Path) -> Mapping[str, Any]:
    marker = _read_json(root / MARKER_FILE, location="runtime output marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise RuntimeArtifactError("runtime output is not safely owned")
    return marker


def _commit_managed_directory(
    staging: Path,
    target: Path,
    *,
    validate_published: Any,
) -> Mapping[str, Any]:
    if not target.exists():
        os.replace(staging, target)
        try:
            return validate_published(target)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            raise
    _validate_output_marker(target)
    backup = target.with_name(f".{target.name}.backup-{uuid.uuid4().hex}")
    os.replace(target, backup)
    try:
        os.replace(staging, target)
        result = validate_published(target)
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        os.replace(backup, target)
        raise
    shutil.rmtree(backup)
    return result


def build_runtime_artifact(
    *,
    active_catalog_path: Path,
    trainer_output: Path,
    encoder_onnx: Path,
    ranker_onnx: Path,
    prototype_features: Path,
    encoder_source_weights: Path,
    conversion_report: Path,
    release_evaluation: Path,
    policy_path: Path,
    output_dir: Path,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    return _build_runtime_artifact(
        trainer_output=trainer_output,
        encoder_onnx=encoder_onnx,
        ranker_onnx=ranker_onnx,
        prototype_features=prototype_features,
        encoder_source_weights=encoder_source_weights,
        conversion_report=conversion_report,
        release_evaluation=release_evaluation,
        policy_path=policy_path,
        output_dir=output_dir,
        active_catalog_path=active_catalog_path,
        replace_owned_output=replace_owned_output,
    )


def _build_runtime_artifact(
    *,
    active_catalog_path: Path,
    trainer_output: Path,
    encoder_onnx: Path,
    ranker_onnx: Path,
    prototype_features: Path,
    encoder_source_weights: Path,
    conversion_report: Path,
    release_evaluation: Path,
    policy_path: Path,
    output_dir: Path,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    active_catalog = load_active_catalog(
        active_catalog_path.resolve(), location="deployment active catalog"
    )
    expected_candidate_ids = tuple(active_catalog["candidate_ids"])
    training = _load_training_bundle(
        trainer_output.resolve(), expected_candidate_ids=expected_candidate_ids
    )
    training_inputs = _require_mapping(
        _require_mapping(training["contract"], "training contract").get("inputs"),
        "training inputs",
    )
    active_sources = _require_mapping(
        active_catalog["source_records"], "active catalog source records"
    )
    if training_inputs.get("font_catalog_sha256") != active_sources.get(
        "deployment_font_face_manifest_sha256"
    ) or training_inputs.get("render_bank_manifest_sha256") != active_sources.get(
        "deployment_render_bank_manifest_sha256"
    ):
        raise RuntimeArtifactError(
            "trainer catalog/render-bank hashes do not match the active catalog"
        )
    for path, label in (
        (encoder_onnx, "encoder ONNX"),
        (ranker_onnx, "ranker ONNX"),
        (prototype_features, "prototype features"),
        (encoder_source_weights, "encoder source weights"),
    ):
        if path.is_symlink() or not path.is_file():
            raise RuntimeArtifactError(f"{label} is missing or linked")
    conversion = _load_conversion_report(
        conversion_report,
        training=training,
        encoder_onnx=encoder_onnx,
        ranker_onnx=ranker_onnx,
        prototype_features=prototype_features,
        encoder_source_weights=encoder_source_weights,
    )
    release = _load_release_evaluation(release_evaluation, training=training)
    policy = _load_policy(policy_path)
    root = _assert_safe_output_target(output_dir)
    if root.exists() and not replace_owned_output:
        raise RuntimeArtifactError(
            "runtime output exists; pass --replace-owned-output after validation"
        )
    if root.exists():
        _validate_output_marker(root)
    root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{root.name}.staging-", dir=root.parent))
    try:
        copies = {
            ACTIVE_CATALOG_FILE: active_catalog_path,
            ENCODER_FILE: encoder_onnx,
            RANKER_FILE: ranker_onnx,
            PROTOTYPE_FILE: prototype_features,
        }
        for name, source in copies.items():
            shutil.copyfile(source, staging / name)
        candidate_ids = tuple(training["candidate_ids"])
        model_contract = _require_mapping(training["contract"], "training contract")
        encoder = _require_mapping(model_contract.get("encoder"), "training encoder")
        inputs = _require_mapping(model_contract.get("inputs"), "training inputs")
        checkpoint = _require_mapping(model_contract.get("checkpoint"), "checkpoint")
        calibration = _require_mapping(model_contract.get("calibration"), "calibration")
        conversion_record = _require_mapping(conversion["report"], "conversion report")
        release_boundary = _require_mapping(
            release["test_data_boundary"], "release boundary"
        )
        release_core = {
            "evaluated_row_count": release_boundary["evaluated_row_count"],
            "evaluation_report_sha256": sha256_file(release_evaluation),
            "metrics": copy.deepcopy(release["metrics"]),
            "test_manifest_sha256": release_boundary["test_manifest_sha256"],
            "thresholds": copy.deepcopy(release["thresholds"]),
        }
        candidate_order_sha = _ordered_values_sha256(candidate_ids)
        model_version = (
            f"font-matching-runtime-v1-{training['checkpoint_sha256'][:12]}-"
            f"{candidate_order_sha[:12]}"
        )
        artifact_descriptors = {
            name: _artifact_descriptor(staging / name, file_name=name)
            for name in copies
        }
        contract = seal_record(
            {
                "artifacts": artifact_descriptors,
                "calibration": copy.deepcopy(dict(calibration)),
                "catalog": {
                    "active_catalog_record_sha256": active_catalog["record_sha256"],
                    "candidate_count": len(candidate_ids),
                    "candidate_ids": list(candidate_ids),
                    "candidate_order_sha256": candidate_order_sha,
                    "candidate_parameterization": (
                        "prototype-bag-only-no-id-embedding-or-bias"
                    ),
                    "catalog_registry_sha256": inputs["catalog_registry_sha256"],
                    "catalog_disposition_record_sha256": active_sources[
                        "catalog_disposition_record_sha256"
                    ],
                    "catalog_version": active_catalog["catalog_version"],
                    "final_catalog_record_sha256": active_sources[
                        "final_catalog_record_sha256"
                    ],
                    "font_catalog_sha256": inputs["font_catalog_sha256"],
                    "font_prototypes_sha256": inputs["font_prototypes_sha256"],
                    "prototype_bags": list(conversion["candidate_bags"]),
                    "prototype_count": conversion["prototype_count"],
                    "render_bank_manifest_sha256": inputs[
                        "render_bank_manifest_sha256"
                    ],
                },
                "deployment": {
                    "automatic_mutation_allowed": True,
                    "fail_closed": True,
                    "fallback_policy": copy.deepcopy(policy["fallback"]),
                    "state": "ready",
                },
                "encoder": {
                    "class": encoder["class"],
                    "fully_frozen": True,
                    "model_id": encoder["model_id"],
                    "onnx_sha256": artifact_descriptors[ENCODER_FILE]["sha256"],
                    "revision": encoder["revision"],
                    "source_weights_sha256": conversion_record["source"][
                        "encoder_source_weights_sha256"
                    ],
                    "version": "siglip-vision-onnx-v1",
                },
                "head": {
                    "architecture": model_contract["architecture"],
                    "checkpoint_metadata": checkpoint["metadata"],
                    "checkpoint_sha256": training["checkpoint_sha256"],
                    "onnx_sha256": artifact_descriptors[RANKER_FILE]["sha256"],
                    "version": "prototype-conditioned-ranker-onnx-v1",
                },
                "model_version": model_version,
                "onnx_io_contract": copy.deepcopy(conversion_record["io_contract"]),
                "policy": {
                    "automatic_mutation": copy.deepcopy(policy["automatic_mutation"]),
                    "chapter_prior": copy.deepcopy(policy["chapter_prior"]),
                    "policy_sha256": sha256_file(policy_path),
                },
                "preprocessing": copy.deepcopy(model_contract["preprocessing"]),
                "provenance": {
                    "conversion_report_sha256": sha256_file(conversion_report),
                    "frozen_test_manifest_sha256": inputs[
                        "frozen_test_manifest_sha256"
                    ],
                    "model_contract_sha256": training["contract_sha256"],
                    "trainer_checkpoint_sha256": training["checkpoint_sha256"],
                    "trainer_code_sha256": model_contract["code_sha256"],
                    "training_report_sha256": training["report_sha256"],
                },
                "record_type": RECORD_TYPE,
                "release_evaluation": release_core,
                "runtime": {
                    "execution_provider": TARGET_ORT_PROVIDER,
                    "package": TARGET_ORT_PACKAGE,
                    "version": TARGET_ORT_VERSION,
                },
                "schema_version": SCHEMA_VERSION,
                "test_data_boundary": {
                    "aggregate_metrics_only": True,
                    "frozen_test_pixels_opened_by_exporter": 0,
                    "row_level_predictions_packaged": False,
                    "sample_identifiers_packaged": False,
                    "training_or_validation_pixels_packaged": False,
                },
            }
        )
        contract_path = staging / CONTRACT_FILE
        contract_path.write_bytes(json_bytes(contract, pretty=True))
        marker = {
            "artifacts": {
                **{name: sha256_file(staging / name) for name in copies},
                CONTRACT_FILE: sha256_file(contract_path),
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        _validate_runtime_artifact(
            output_dir=staging,
            inspect_onnx=True,
        )
        result = _commit_managed_directory(
            staging,
            root,
            validate_published=lambda published: _validate_runtime_artifact(
                output_dir=published,
                inspect_onnx=True,
            ),
        )
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return result


def validate_runtime_artifact(*, output_dir: Path) -> Mapping[str, Any]:
    return _validate_runtime_artifact(
        output_dir=output_dir,
        inspect_onnx=True,
    )


def _validate_runtime_artifact(
    *,
    output_dir: Path,
    inspect_onnx: bool = True,
) -> Mapping[str, Any]:
    root = _assert_safe_output_target(output_dir)
    expected_files = {
        MARKER_FILE,
        ACTIVE_CATALOG_FILE,
        CONTRACT_FILE,
        ENCODER_FILE,
        RANKER_FILE,
        PROTOTYPE_FILE,
    }
    _validate_exact_inventory(root, expected_files, location="runtime output")
    marker = _validate_output_marker(root)
    artifacts = _require_mapping(marker.get("artifacts"), "runtime marker.artifacts")
    for file_name in expected_files - {MARKER_FILE}:
        if artifacts.get(file_name) != sha256_file(root / file_name):
            raise RuntimeArtifactError(f"runtime artifact hash mismatch: {file_name}")
    contract_path = root / CONTRACT_FILE
    active_catalog = load_active_catalog(
        root / ACTIVE_CATALOG_FILE, location="runtime active catalog"
    )
    expected_candidate_ids = tuple(active_catalog["candidate_ids"])
    active_sources = _require_mapping(
        active_catalog["source_records"], "runtime active catalog source records"
    )
    contract = _read_json(contract_path, location="runtime contract")
    validate_record_seal(contract, location="runtime contract")
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type") != RECORD_TYPE
    ):
        raise RuntimeArtifactError("runtime contract schema is unsupported")
    deployment = _require_mapping(contract.get("deployment"), "runtime deployment")
    fallback = _require_mapping(
        deployment.get("fallback_policy"), "runtime fallback policy"
    )
    if (
        deployment.get("state") != "ready"
        or deployment.get("automatic_mutation_allowed") is not True
        or deployment.get("fail_closed") is not True
        or dict(fallback)
        != {
            "automatic_profile_without_pixel_model": "forbidden",
            "invalid_artifact": "explicit_disabled",
            "manual_user_lock": "allowed",
            "missing_artifact": "explicit_disabled",
            "semantic_bootstrap": "forbidden",
        }
    ):
        raise RuntimeArtifactError("runtime deployment is not fail closed")
    catalog = _require_mapping(contract.get("catalog"), "runtime catalog")
    candidate_ids = tuple(
        _require_text(value, f"runtime candidate_ids[{index}]")
        for index, value in enumerate(
            _require_list(catalog.get("candidate_ids"), "runtime candidate ids")
        )
    )
    if candidate_ids != expected_candidate_ids:
        raise RuntimeArtifactError("runtime candidate vocabulary/order failed")
    if catalog.get("candidate_count") != len(expected_candidate_ids):
        raise RuntimeArtifactError("runtime candidate count failed")
    if catalog.get("candidate_order_sha256") != _ordered_values_sha256(candidate_ids):
        raise RuntimeArtifactError("runtime candidate-order seal failed")
    if (
        catalog.get("catalog_version") != active_catalog["catalog_version"]
        or catalog.get("active_catalog_record_sha256")
        != active_catalog["record_sha256"]
        or catalog.get("catalog_disposition_record_sha256")
        != active_sources.get("catalog_disposition_record_sha256")
        or catalog.get("final_catalog_record_sha256")
        != active_sources.get("final_catalog_record_sha256")
        or catalog.get("font_catalog_sha256")
        != active_sources.get("deployment_font_face_manifest_sha256")
        or catalog.get("render_bank_manifest_sha256")
        != active_sources.get("deployment_render_bank_manifest_sha256")
    ):
        raise RuntimeArtifactError("runtime active-catalog binding failed")
    bags = _validate_candidate_bags(
        catalog.get("prototype_bags"), candidate_ids=candidate_ids
    )
    prototype_count = sum(int(row["count"]) for row in bags)
    if catalog.get("prototype_count") != prototype_count:
        raise RuntimeArtifactError("runtime prototype count drifted")
    contract_artifacts = _require_mapping(
        contract.get("artifacts"), "contract artifacts"
    )
    for file_name in (
        ACTIVE_CATALOG_FILE,
        ENCODER_FILE,
        RANKER_FILE,
        PROTOTYPE_FILE,
    ):
        descriptor = _require_mapping(
            contract_artifacts.get(file_name), f"artifacts.{file_name}"
        )
        path = root / file_name
        if descriptor != _artifact_descriptor(path, file_name=file_name):
            raise RuntimeArtifactError(f"runtime descriptor drifted: {file_name}")
    io_contract = _require_mapping(
        contract.get("onnx_io_contract"), "ONNX I/O contract"
    )
    if inspect_onnx:
        if _inspect_onnx_contract(root / ENCODER_FILE) != io_contract.get(ENCODER_FILE):
            raise RuntimeArtifactError("runtime encoder I/O drifted")
        if _inspect_onnx_contract(root / RANKER_FILE) != io_contract.get(RANKER_FILE):
            raise RuntimeArtifactError("runtime ranker I/O drifted")
    boundary = _require_mapping(
        contract.get("test_data_boundary"), "runtime test boundary"
    )
    if dict(boundary) != {
        "aggregate_metrics_only": True,
        "frozen_test_pixels_opened_by_exporter": 0,
        "row_level_predictions_packaged": False,
        "sample_identifiers_packaged": False,
        "training_or_validation_pixels_packaged": False,
    }:
        raise RuntimeArtifactError("runtime output packages forbidden evaluation data")
    provenance = _require_mapping(contract.get("provenance"), "runtime provenance")
    release = _require_mapping(
        contract.get("release_evaluation"), "runtime release evaluation"
    )
    if _require_sha(
        provenance.get("frozen_test_manifest_sha256"),
        "runtime provenance.frozen_test_manifest_sha256",
    ) != _require_sha(
        release.get("test_manifest_sha256"),
        "runtime release_evaluation.test_manifest_sha256",
    ):
        raise RuntimeArtifactError("runtime frozen-test manifest binding failed")
    return {
        "candidate_count": len(candidate_ids),
        "contract_sha256": sha256_file(contract_path),
        "model_version": contract["model_version"],
        "output_dir": str(root),
        "status": "ready",
    }


def preflight_trainer_output(
    *, trainer_output: Path, active_catalog_path: Path
) -> Mapping[str, Any]:
    active_catalog = load_active_catalog(
        active_catalog_path.resolve(), location="deployment active catalog"
    )
    training = _load_training_bundle(
        trainer_output.resolve(),
        expected_candidate_ids=active_catalog["candidate_ids"],
    )
    inputs = _require_mapping(
        _require_mapping(training["contract"], "training contract").get("inputs"),
        "training inputs",
    )
    sources = _require_mapping(
        active_catalog["source_records"], "active catalog source records"
    )
    if inputs.get("font_catalog_sha256") != sources.get(
        "deployment_font_face_manifest_sha256"
    ) or inputs.get("render_bank_manifest_sha256") != sources.get(
        "deployment_render_bank_manifest_sha256"
    ):
        raise RuntimeArtifactError(
            "trainer catalog/render-bank hashes do not match the active catalog"
        )
    return {
        "candidate_count": len(training["candidate_ids"]),
        "checkpoint_sha256": training["checkpoint_sha256"],
        "model_contract_sha256": training["contract_sha256"],
        "next_required_assets": [
            ENCODER_FILE,
            RANKER_FILE,
            PROTOTYPE_FILE,
            "sealed ONNX parity report",
            "sealed aggregate frozen-test release evaluation",
            "sealed runtime policy",
        ],
        "status": "ready_for_onnx_conversion_not_deployable",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    active_catalog = subparsers.add_parser("active-catalog")
    active_catalog.add_argument("--final-catalog", type=Path, required=True)
    active_catalog.add_argument("--catalog-disposition", type=Path, required=True)
    active_catalog.add_argument(
        "--deployment-font-face-manifest", type=Path, required=True
    )
    active_catalog.add_argument(
        "--deployment-render-bank-manifest", type=Path, required=True
    )
    active_catalog.add_argument("--asset-root", type=Path, required=True)
    active_catalog.add_argument("--output", type=Path, required=True)
    active_catalog.add_argument("--replace-existing", action="store_true")
    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--trainer-output", type=Path, required=True)
    preflight.add_argument("--active-catalog", type=Path, required=True)
    build = subparsers.add_parser("build")
    build.add_argument("--active-catalog", type=Path, required=True)
    build.add_argument("--trainer-output", type=Path, required=True)
    build.add_argument("--encoder-onnx", type=Path, required=True)
    build.add_argument("--ranker-onnx", type=Path, required=True)
    build.add_argument("--prototype-features", type=Path, required=True)
    build.add_argument("--encoder-source-weights", type=Path, required=True)
    build.add_argument("--conversion-report", type=Path, required=True)
    build.add_argument("--release-evaluation", type=Path, required=True)
    build.add_argument("--policy", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--replace-owned-output", action="store_true")
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "active-catalog":
            result = build_active_catalog(
                final_catalog_path=args.final_catalog,
                catalog_disposition_path=args.catalog_disposition,
                deployment_font_face_manifest_path=(
                    args.deployment_font_face_manifest
                ),
                deployment_render_bank_manifest_path=(
                    args.deployment_render_bank_manifest
                ),
                asset_root=args.asset_root,
                output_path=args.output,
                replace_existing=args.replace_existing,
            )
        elif args.command == "preflight":
            result = preflight_trainer_output(
                trainer_output=args.trainer_output,
                active_catalog_path=args.active_catalog,
            )
        elif args.command == "build":
            result = build_runtime_artifact(
                active_catalog_path=args.active_catalog,
                trainer_output=args.trainer_output,
                encoder_onnx=args.encoder_onnx,
                ranker_onnx=args.ranker_onnx,
                prototype_features=args.prototype_features,
                encoder_source_weights=args.encoder_source_weights,
                conversion_report=args.conversion_report,
                release_evaluation=args.release_evaluation,
                policy_path=args.policy,
                output_dir=args.output_dir,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_runtime_artifact(
                output_dir=args.output_dir,
            )
    except RuntimeArtifactError as error:
        print(
            json.dumps({"status": "blocked", "reason": str(error)}, ensure_ascii=False)
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
