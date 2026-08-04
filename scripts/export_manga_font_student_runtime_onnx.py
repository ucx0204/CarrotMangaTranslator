#!/usr/bin/env python3
"""Export a sealed MangaFont-22 student as the application's ONNX runtime.

The student checkpoint is a trainable delta against one pinned local SigLIP2
snapshot.  This exporter reconstructs that model offline, folds the learned
256-dimensional projection into ``encoder.onnx``, exports the prototype
conditioned ``runtime_ranker`` as ``ranker.onnx``, and atomically publishes the
base runtime artifact.  A supervised ``selection-calibration.json`` must still
be attached with ``attach_font_matching_selection_calibration.py`` before the
application bundle loader will enable automatic mutation.
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import build_font_matching_runtime_artifact as runtime
    import export_font_matching_runtime_onnx as legacy_export
    import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import export_font_matching_runtime_onnx as legacy_export
    from scripts import train_manga_font_student_v1 as trainer


OPSET_VERSION = legacy_export.OPSET_VERSION
MIN_PARITY_SAMPLES = 32
MARKER_FILE = runtime.MARKER_FILE
CONTRACT_FILE = runtime.CONTRACT_FILE
ENCODER_FILE = runtime.ENCODER_FILE
RANKER_FILE = runtime.RANKER_FILE
PROTOTYPE_FILE = runtime.PROTOTYPE_FILE
ACTIVE_CATALOG_FILE = runtime.ACTIVE_CATALOG_FILE
OUTPUT_FILES = frozenset(
    {
        MARKER_FILE,
        CONTRACT_FILE,
        ENCODER_FILE,
        RANKER_FILE,
        PROTOTYPE_FILE,
        ACTIVE_CATALOG_FILE,
    }
)
EXPECTED_PREFIXES = {
    "direct_classifier": "font_head.",
    "encoder": "vision_encoder.",
    "projection": "projection.",
    "ranker": "runtime_ranker.",
}
V2_EXTENSION_SCHEMA = "manga-font-student-training-extension-v2"
V3_EXTENSION_SCHEMA = "manga-font-student-training-extension-v3"
V3_SCORER_SCHEMA = "role-style-conditioned-candidate-residual-v1"
V3_RANKER_HYPERPARAMETER_KEYS = frozenset(
    {
        "candidate_count",
        "residual_dropout",
        "residual_initial_scale",
        "semantic_mix_initial",
        "scorer_schema",
    }
)
FALLBACK_POLICY = {
    "automatic_profile_without_pixel_model": "forbidden",
    "invalid_artifact": "explicit_disabled",
    "manual_user_lock": "allowed",
    "missing_artifact": "explicit_disabled",
    "semantic_bootstrap": "forbidden",
}
AUTOMATIC_POLICY = {
    "intentional_override_minimum_score_margin": 0.12,
    "minimum_calibrated_confidence": 0.82,
    "minimum_intentional_override_confidence": 0.88,
    "minimum_role_confidence": 0.75,
    "require_none_acceptable_false": True,
    "require_runtime_artifact_ready": True,
    "require_translation_glyph_coverage": True,
}
CHAPTER_POLICY = {
    "local_override_minimum_score_margin": 0.12,
    "maximum_score_contribution": 0.08,
    "minimum_anchor_evidence_count": 3,
    "mode": "weak_prior_never_hard_constraint",
    "real_local_change_overrides_prior": True,
    "scope": "chapter",
}

FULL22_ACTIVE_SCHEMA = "manga-font-full22-active-catalog-bundle-v1"
FULL22_ACTIVE_OWNER = "carrot-manga-translator/manga-font-full22-active-catalog"
FULL22_ACTIVE_MARKER = ".manga-font-full22-active-catalog-owned.json"
FULL22_AUTHORITY_FILE = "full22-release-authority.json"
FULL22_DISPOSITION_FILE = "catalog-disposition.json"
FULL22_FINAL_CATALOG_FILE = "final-catalog.json"
FULL22_ACTIVE_FILES = frozenset(
    {
        FULL22_ACTIVE_MARKER,
        FULL22_AUTHORITY_FILE,
        FULL22_DISPOSITION_FILE,
        FULL22_FINAL_CATALOG_FILE,
        ACTIVE_CATALOG_FILE,
    }
)
FULL22_FONT_MANIFEST_SHA256 = (
    "2bd549480b7ccecf2dd31418fcf705c5eda5d0c8787bf86c12803bed77df9d34"
)
FULL22_RENDER_MANIFEST_SHA256 = (
    "e27cf064ae5df0a83146f665387ee1462a286596d06a4f10f02f09585e975577"
)
FULL22_CATALOG_VERSION = "fontclip-font-catalog-v2-manga-font22"
FULL22_RELEASE_BASIS = "explicit_user_approved_manga_font22_successor"
EXPECTED_CANDIDATE_IDS = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
    "black-and-white-picture",
    "black-han-sans",
    "gasoek-one",
    "gugi",
    "kirang-haerang",
    "nanum-brush-script",
    "single-day",
)


class StudentRuntimeExportError(ValueError):
    """Raised when a student cannot be proven safe for runtime export."""


@dataclass(frozen=True)
class StudentAuthority:
    student_root: Path
    active_catalog_path: Path
    active_catalog: Mapping[str, Any]
    contract: Mapping[str, Any]
    report: Mapping[str, Any]
    checkpoint_path: Path
    prototype_path: Path
    prototypes: np.ndarray
    candidate_ids: tuple[str, ...]
    candidate_bags: tuple[dict[str, Any], ...]
    encoder_source_dir: Path
    encoder_source_weights: Path


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise StudentRuntimeExportError(f"{location}: expected an object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise StudentRuntimeExportError(f"{location}: expected a list")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StudentRuntimeExportError(f"{location}: expected non-empty text")
    return value.strip()


def _read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise StudentRuntimeExportError(f"{location}: missing or linked file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StudentRuntimeExportError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _exact_inventory(root: Path, expected: set[str], *, location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise StudentRuntimeExportError(f"{location}: missing or linked directory")
    entries = list(root.iterdir())
    if any(path.is_symlink() or not path.is_file() for path in entries):
        raise StudentRuntimeExportError(
            f"{location}: linked/nested entries are forbidden"
        )
    actual = {path.name for path in entries}
    if actual != expected:
        raise StudentRuntimeExportError(
            f"{location}: inventory drifted; expected={sorted(expected)} actual={sorted(actual)}"
        )


def _safe_output(path: Path) -> Path:
    root = path.expanduser().resolve()
    if root in {Path.cwd().resolve(), Path.home().resolve(), Path(root.anchor)}:
        raise StudentRuntimeExportError(f"unsafe output directory: {root}")
    if len(root.parts) < 3 or len(root.name) < 3:
        raise StudentRuntimeExportError(f"unsafe output directory: {root}")
    return root


def _validate_runtime_adapter(contract: Mapping[str, Any]) -> tuple[str, ...]:
    adapter = _mapping(contract.get("runtime_export_adapter"), "runtime adapter")
    vocabulary = _mapping(contract.get("vocabulary"), "student vocabulary")
    treatments = _mapping(vocabulary.get("treatments"), "student treatments")
    output_names = (
        "candidate_scores",
        "none_logits",
        "role_logits",
        "style_logits",
        *(f"treatment_{field}_logits" for field in sorted(treatments)),
        "view_gate_weights",
    )
    encoder_output = _mapping(adapter.get("encoder_onnx_output"), "encoder output")
    if (
        adapter.get("schema_version") != "manga-font-student-onnx-adapter-v1"
        or adapter.get("candidate_scores_authority") != "runtime_ranker"
        or adapter.get("candidate_bags_source") != "prototype_bank.candidate_bags"
        or adapter.get("checkpoint_prefixes") != EXPECTED_PREFIXES
        or encoder_output.get("name") != "image_features"
        or encoder_output.get("normalization") != "l2"
        or encoder_output.get("shape") != [None, trainer.PROJECTION_DIM]
        or adapter.get("ranker_onnx_outputs") != list(output_names)
        or adapter.get("ranker_onnx_inputs")
        != [
            {"name": "views", "shape": [None, 3, trainer.PROJECTION_DIM]},
            {
                "name": "prototype_features",
                "shape": [None, trainer.PROJECTION_DIM],
            },
        ]
    ):
        raise StudentRuntimeExportError("student ONNX adapter differs from app runtime")
    checkpoint = _mapping(contract.get("checkpoint"), "student checkpoint")
    state_contract = _list(
        checkpoint.get("state_contract"), "checkpoint state contract"
    )
    names = tuple(
        _text(_mapping(row, "checkpoint state row").get("name"), "state name")
        for row in state_contract
    )
    if len(names) != len(set(names)):
        raise StudentRuntimeExportError("checkpoint state tensor names are duplicated")
    allowed = tuple(EXPECTED_PREFIXES.values())
    if any(not name.startswith(allowed) for name in names):
        raise StudentRuntimeExportError(
            "checkpoint contains an unknown parameter prefix"
        )
    if any(not any(name.startswith(prefix) for name in names) for prefix in allowed):
        raise StudentRuntimeExportError(
            "checkpoint omits an export-required parameter prefix"
        )
    extension = contract.get("trainer_extension")
    if (
        isinstance(extension, Mapping)
        and extension.get("schema_version") == V3_EXTENSION_SCHEMA
    ):
        metadata = _mapping(checkpoint.get("metadata"), "checkpoint metadata")
        if metadata.get("trainer_extension") != V3_EXTENSION_SCHEMA:
            raise StudentRuntimeExportError(
                "v3 checkpoint metadata is not bound to the v3 trainer extension"
            )
    return output_names


def _load_v2_trainer() -> Any:
    try:
        import train_manga_font_student_v2 as trainer_v2
    except ImportError:  # pragma: no cover - repository-root import
        from scripts import train_manga_font_student_v2 as trainer_v2
    return trainer_v2


def _load_v3_trainer() -> Any:
    try:
        import train_manga_font_student_v3 as trainer_v3
    except ImportError:  # pragma: no cover - repository-root import
        from scripts import train_manga_font_student_v3 as trainer_v3
    return trainer_v3


def _trainer_extension_schema(contract: Mapping[str, Any]) -> str | None:
    extension = contract.get("trainer_extension")
    if extension is None:
        return None
    return _text(
        _mapping(extension, "student trainer extension").get("schema_version"),
        "student trainer extension schema",
    )


def _finite_number(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StudentRuntimeExportError(f"{location}: expected a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise StudentRuntimeExportError(f"{location}: expected a finite number")
    return result


def _v3_ranker_reconstruction_values(
    contract: Mapping[str, Any], *, candidate_count: int
) -> tuple[float, float]:
    """Read the exact sealed values that affect v3 ranker reconstruction."""

    extension = _mapping(contract.get("trainer_extension"), "v3 extension")
    if extension.get("schema_version") != V3_EXTENSION_SCHEMA:
        raise StudentRuntimeExportError(
            "v3 reconstruction requires the v3 extension"
        )
    values = _mapping(
        extension.get("runtime_ranker_hyperparameters"),
        "v3 runtime ranker hyperparameters",
    )
    if set(values) != V3_RANKER_HYPERPARAMETER_KEYS:
        raise StudentRuntimeExportError(
            "v3 runtime ranker hyperparameter inventory drifted"
        )
    declared_count = values.get("candidate_count")
    if (
        isinstance(declared_count, bool)
        or not isinstance(declared_count, int)
        or declared_count != candidate_count
    ):
        raise StudentRuntimeExportError("v3 runtime ranker candidate count drifted")
    dropout = _finite_number(
        values.get("residual_dropout"), location="v3 residual dropout"
    )
    residual_scale = _finite_number(
        values.get("residual_initial_scale"),
        location="v3 residual initial scale",
    )
    semantic_mix = _finite_number(
        values.get("semantic_mix_initial"), location="v3 semantic mix initial"
    )
    if not 0.0 <= dropout < 0.5:
        raise StudentRuntimeExportError("v3 residual dropout is out of range")
    if not 0.05 <= residual_scale <= 4.0:
        raise StudentRuntimeExportError("v3 residual initial scale is out of range")
    if semantic_mix != 0.25:
        raise StudentRuntimeExportError("v3 semantic mix initial value drifted")
    if (
        values.get("scorer_schema") != V3_SCORER_SCHEMA
        or extension.get("scorer_schema") != V3_SCORER_SCHEMA
    ):
        raise StudentRuntimeExportError("v3 runtime ranker scorer schema drifted")
    return dropout, residual_scale


def _validate_encoder_source(
    root: Path, *, contract: Mapping[str, Any]
) -> tuple[Path, Mapping[str, Any]]:
    source = root.expanduser().resolve()
    encoder = _mapping(contract.get("encoder"), "student encoder")
    revision = _text(encoder.get("revision"), "student encoder revision")
    if source.is_symlink() or not source.is_dir() or source.name != revision:
        raise StudentRuntimeExportError(
            "encoder source must be the pinned immutable revision directory"
        )
    for name in ("config.json", "preprocessor_config.json", "model.safetensors"):
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise StudentRuntimeExportError(f"encoder snapshot lacks regular {name}")
    config = _read_json(source / "config.json", location="encoder config")
    if config.get("model_type") not in {"siglip", "siglip2"}:
        raise StudentRuntimeExportError("encoder snapshot is not SigLIP/SigLIP2")
    return source / "model.safetensors", config


def _validate_student_output_for_export(student_root: Path) -> Mapping[str, Any]:
    """Validate the base schema and any recognized trainer extension."""

    result = trainer.validate_output(student_root)
    contract = _read_json(
        student_root / trainer.CONTRACT_FILE, location="student contract"
    )
    extension_schema = _trainer_extension_schema(contract)
    if extension_schema is None:
        return result
    try:
        if extension_schema == V2_EXTENSION_SCHEMA:
            return _load_v2_trainer().validate_v2_output(student_root)
        if extension_schema == V3_EXTENSION_SCHEMA:
            return _load_v3_trainer().validate_v3_output(student_root)
    except trainer.MangaFontStudentError as error:
        raise StudentRuntimeExportError(str(error)) from error
    raise StudentRuntimeExportError(
        f"unsupported MangaFont student trainer extension: {extension_schema}"
    )


def _build_student_for_export(
    torch: Any,
    *,
    vision_encoder: Any,
    contract: Mapping[str, Any],
    candidate_count: int,
) -> tuple[Any, tuple[int, ...]]:
    """Reconstruct the sealed trainer architecture without changing ONNX I/O."""

    extension_schema = _trainer_extension_schema(contract)
    if extension_schema == V3_EXTENSION_SCHEMA:
        dropout, residual_scale = _v3_ranker_reconstruction_values(
            contract, candidate_count=candidate_count
        )
        return _load_v3_trainer().build_student_model_v3(
            torch,
            vision_encoder=vision_encoder,
            candidate_count=candidate_count,
            dropout=dropout,
            residual_scale=residual_scale,
        )
    if extension_schema not in {None, V2_EXTENSION_SCHEMA}:
        raise StudentRuntimeExportError(
            f"unsupported MangaFont student trainer extension: {extension_schema}"
        )
    return trainer.build_student_model(
        torch,
        vision_encoder=vision_encoder,
        candidate_count=candidate_count,
    )


def load_student_authority(
    *, student_output: Path, active_catalog_path: Path, encoder_source_dir: Path
) -> StudentAuthority:
    student_root = student_output.expanduser().resolve()
    try:
        _validate_student_output_for_export(student_root)
        _validate_student_bound_active_catalog_bundle(
            student_root=student_root,
            active_catalog_path=active_catalog_path,
        )
        active_catalog = runtime.load_active_catalog(
            active_catalog_path.expanduser().resolve(),
            location="MangaFont-22 active catalog",
        )
    except (trainer.MangaFontStudentError, runtime.RuntimeArtifactError) as error:
        raise StudentRuntimeExportError(str(error)) from error
    contract = _read_json(
        student_root / trainer.CONTRACT_FILE, location="student contract"
    )
    report = _read_json(student_root / trainer.REPORT_FILE, location="student report")
    _validate_runtime_adapter(contract)
    vocabulary = _mapping(contract.get("vocabulary"), "student vocabulary")
    candidate_ids = tuple(
        _text(value, f"candidate_ids[{index}]")
        for index, value in enumerate(
            _list(vocabulary.get("candidate_ids"), "candidate ids")
        )
    )
    active_ids = tuple(active_catalog["candidate_ids"])
    active_sources = _mapping(
        active_catalog.get("source_records"), "MangaFont-22 active catalog sources"
    )
    if (
        len(candidate_ids) != trainer.CANDIDATE_COUNT
        or len(set(candidate_ids)) != trainer.CANDIDATE_COUNT
        or candidate_ids != active_ids
        or candidate_ids != EXPECTED_CANDIDATE_IDS
        or active_catalog.get("catalog_version") != FULL22_CATALOG_VERSION
        or active_sources.get("deployment_font_face_manifest_sha256")
        != FULL22_FONT_MANIFEST_SHA256
        or active_sources.get("deployment_render_bank_manifest_sha256")
        != FULL22_RENDER_MANIFEST_SHA256
    ):
        raise StudentRuntimeExportError(
            "student and pinned v2 active catalog must contain the same ordered 22 fonts"
        )
    prototype = _mapping(contract.get("prototype_bank"), "student prototype bank")
    prototype_count = int(prototype.get("prototype_count", 0))
    prototype_path = student_root / trainer.PROTOTYPE_FILE
    if (
        prototype.get("feature_dim") != trainer.PROJECTION_DIM
        or prototype_count < trainer.CANDIDATE_COUNT
        or prototype.get("sha256") != sha256_file(prototype_path)
        or prototype_path.stat().st_size != prototype_count * trainer.PROJECTION_DIM * 4
    ):
        raise StudentRuntimeExportError("student prototype-bank binding drifted")
    prototypes = np.frombuffer(prototype_path.read_bytes(), dtype="<f4").reshape(
        prototype_count, trainer.PROJECTION_DIM
    )
    if not np.isfinite(prototypes).all():
        raise StudentRuntimeExportError(
            "student prototype bank contains non-finite values"
        )
    bags_raw = _list(prototype.get("candidate_bags"), "student prototype bags")
    try:
        bags = runtime._validate_candidate_bags(  # noqa: SLF001
            bags_raw, candidate_ids=candidate_ids
        )
    except runtime.RuntimeArtifactError as error:
        raise StudentRuntimeExportError(str(error)) from error
    if sum(int(row["count"]) for row in bags) != prototype_count:
        raise StudentRuntimeExportError("student prototype bags do not cover the bank")
    source_weights, _ = _validate_encoder_source(encoder_source_dir, contract=contract)
    return StudentAuthority(
        student_root=student_root,
        active_catalog_path=active_catalog_path.expanduser().resolve(),
        active_catalog=active_catalog,
        contract=contract,
        report=report,
        checkpoint_path=student_root / trainer.CHECKPOINT_FILE,
        prototype_path=prototype_path,
        prototypes=np.ascontiguousarray(prototypes),
        candidate_ids=candidate_ids,
        candidate_bags=tuple(dict(row) for row in bags),
        encoder_source_dir=encoder_source_dir.expanduser().resolve(),
        encoder_source_weights=source_weights,
    )


def _student_candidate_contract(
    student_output: Path,
) -> tuple[tuple[str, ...], str, str]:
    root = student_output.expanduser().resolve()
    try:
        _validate_student_output_for_export(root)
    except trainer.MangaFontStudentError as error:
        raise StudentRuntimeExportError(str(error)) from error
    contract_path = root / trainer.CONTRACT_FILE
    contract = _read_json(contract_path, location="student contract")
    _validate_runtime_adapter(contract)
    vocabulary = _mapping(contract.get("vocabulary"), "student vocabulary")
    candidate_ids = tuple(
        _text(value, f"candidate_ids[{index}]")
        for index, value in enumerate(
            _list(vocabulary.get("candidate_ids"), "student candidate ids")
        )
    )
    if candidate_ids != EXPECTED_CANDIDATE_IDS:
        raise StudentRuntimeExportError(
            "student candidate order is not the pinned MangaFont-22 order"
        )
    checkpoint_path = root / trainer.CHECKPOINT_FILE
    return candidate_ids, sha256_file(contract_path), sha256_file(checkpoint_path)


def _validate_full22_catalog_sources(
    *,
    font_face_manifest_path: Path,
    render_bank_manifest_path: Path,
    asset_root: Path,
    candidate_ids: Sequence[str],
) -> tuple[str, str]:
    font_path = font_face_manifest_path.expanduser().resolve()
    render_path = render_bank_manifest_path.expanduser().resolve()
    font_manifest = _read_json(font_path, location="full22 font face manifest")
    render_manifest = _read_json(render_path, location="full22 render bank manifest")
    font_sha = sha256_file(font_path)
    render_sha = sha256_file(render_path)
    if font_sha != FULL22_FONT_MANIFEST_SHA256:
        raise StudentRuntimeExportError("pinned v2 font face manifest hash drifted")
    if render_sha != FULL22_RENDER_MANIFEST_SHA256:
        raise StudentRuntimeExportError("pinned v2 render bank manifest hash drifted")
    raw_families = _list(font_manifest.get("families"), "font face families")
    manifest_ids = tuple(
        sorted(
            _text(
                _mapping(row, f"font face family[{index}]").get("font_id"),
                f"font face family[{index}].font_id",
            )
            for index, row in enumerate(raw_families)
        )
    )
    if (
        manifest_ids != tuple(sorted(candidate_ids))
        or font_manifest.get("family_count") != trainer.CANDIDATE_COUNT
    ):
        raise StudentRuntimeExportError("v2 font manifest is not exact MangaFont-22")
    try:
        runtime._font_face_inventory(  # noqa: SLF001
            font_manifest,
            asset_root=asset_root.expanduser().resolve(),
            expected_candidate_ids=candidate_ids,
        )
        runtime._validate_deployment_render_bank(  # noqa: SLF001
            render_manifest,
            manifest_path=render_path,
            font_face_manifest_sha256=font_sha,
            expected_candidate_ids=candidate_ids,
        )
    except runtime.RuntimeArtifactError as error:
        raise StudentRuntimeExportError(str(error)) from error
    return font_sha, render_sha


def _full22_source_records(
    *,
    authority_sha256: str,
    student_contract_sha256: str,
    checkpoint_sha256: str,
    font_manifest_sha256: str,
    render_manifest_sha256: str,
) -> dict[str, str]:
    return {
        "font_face_manifest_sha256": font_manifest_sha256,
        "manga_font_student_checkpoint_sha256": checkpoint_sha256,
        "manga_font_student_contract_sha256": student_contract_sha256,
        "release_authority_record_sha256": authority_sha256,
        "render_bank_manifest_sha256": render_manifest_sha256,
    }


def _full22_authority_record(
    *,
    candidate_ids: Sequence[str],
    student_contract_sha256: str,
    checkpoint_sha256: str,
    font_manifest_sha256: str,
    render_manifest_sha256: str,
) -> dict[str, Any]:
    return runtime.seal_record(
        {
            "authorization": {
                "decision": "deploy_all_22_fonts_in_manga_font_successor",
                "source": "explicit_user_instruction",
            },
            "candidate_count": len(candidate_ids),
            "candidate_ids": list(candidate_ids),
            "candidate_order_sha256": runtime._ordered_values_sha256(candidate_ids),  # noqa: SLF001
            "locale": "ko",
            "record_type": "manga_font_full22_release_authority",
            "schema_version": "manga-font-full22-release-authority-v1",
            "sources": {
                "font_face_manifest_sha256": font_manifest_sha256,
                "manga_font_student_checkpoint_sha256": checkpoint_sha256,
                "manga_font_student_contract_sha256": student_contract_sha256,
                "render_bank_manifest_sha256": render_manifest_sha256,
            },
        }
    )


def _full22_disposition_record(
    *,
    authority_sha256: str,
    student_contract_sha256: str,
    checkpoint_sha256: str,
    font_manifest_sha256: str,
    render_manifest_sha256: str,
) -> dict[str, Any]:
    return runtime.seal_record(
        {
            "candidate_count": 0,
            "entries": [],
            "final_release_allowed": True,
            "record_type": runtime.CATALOG_DISPOSITION_RECORD_TYPE,
            "release_basis": FULL22_RELEASE_BASIS,
            "release_state": "final_released",
            "schema_version": runtime.CATALOG_DISPOSITION_SCHEMA,
            "source_catalog_sha256": font_manifest_sha256,
            "source_records": _full22_source_records(
                authority_sha256=authority_sha256,
                student_contract_sha256=student_contract_sha256,
                checkpoint_sha256=checkpoint_sha256,
                font_manifest_sha256=font_manifest_sha256,
                render_manifest_sha256=render_manifest_sha256,
            ),
            "source_render_bank_sha256": render_manifest_sha256,
            "workspace_contract_record_sha256": authority_sha256,
        }
    )


def _full22_final_catalog_record(
    *,
    candidate_ids: Sequence[str],
    authority_sha256: str,
    disposition_sha256: str,
    student_contract_sha256: str,
    checkpoint_sha256: str,
    font_manifest_sha256: str,
    render_manifest_sha256: str,
) -> dict[str, Any]:
    # The v5 final-catalog schema defines candidate_ids as a stable sorted set.
    # Runtime tensor alignment is a separate concern and is carried by the sealed
    # active catalog (and the student release-authority record) instead.
    catalog_candidate_ids = tuple(sorted(candidate_ids))
    return runtime.seal_record(
        {
            "candidate_count": len(catalog_candidate_ids),
            "candidate_ids": list(catalog_candidate_ids),
            "candidate_set_sha256": runtime._candidate_set_sha256(
                catalog_candidate_ids
            ),  # noqa: SLF001
            "catalog_disposition_record_sha256": disposition_sha256,
            "catalog_version": FULL22_CATALOG_VERSION,
            "included_delta_candidate_count": 0,
            "included_delta_candidates": [],
            "prior_candidate_count": len(catalog_candidate_ids),
            "prior_candidate_ids": list(catalog_candidate_ids),
            "record_type": runtime.FINAL_CATALOG_RECORD_TYPE,
            "release_basis": FULL22_RELEASE_BASIS,
            "removed_delta_candidate_count": 0,
            "removed_delta_candidates": [],
            "schema_version": runtime.FINAL_CATALOG_SCHEMA,
            "source_catalog_sha256": font_manifest_sha256,
            "source_records": _full22_source_records(
                authority_sha256=authority_sha256,
                student_contract_sha256=student_contract_sha256,
                checkpoint_sha256=checkpoint_sha256,
                font_manifest_sha256=font_manifest_sha256,
                render_manifest_sha256=render_manifest_sha256,
            ),
            "workspace_contract_record_sha256": authority_sha256,
        }
    )


def _validate_full22_active_marker(root: Path) -> Mapping[str, Any]:
    marker = _read_json(root / FULL22_ACTIVE_MARKER, location="full22 active marker")
    if (
        marker.get("owner") != FULL22_ACTIVE_OWNER
        or marker.get("schema_version") != FULL22_ACTIVE_SCHEMA
        or marker.get("safe_replace") is not True
    ):
        raise StudentRuntimeExportError("full22 active ownership marker is invalid")
    artifacts = _mapping(marker.get("artifacts"), "full22 marker artifacts")
    expected = FULL22_ACTIVE_FILES - {FULL22_ACTIVE_MARKER}
    if set(artifacts) != set(expected):
        raise StudentRuntimeExportError("full22 active marker inventory drifted")
    for name in expected:
        if artifacts.get(name) != sha256_file(root / name):
            raise StudentRuntimeExportError(f"full22 active hash mismatch: {name}")
    return marker


def _validate_student_bound_active_catalog_bundle(
    *, student_root: Path, active_catalog_path: Path
) -> None:
    """Fail closed when a managed full22 bundle belongs to another student.

    The generic active-catalog record deliberately describes only the ordered
    font/assets set. Its enclosing MangaFont bundle carries the student model
    authority. Without checking that outer seal, a v2 export could
    accidentally reuse the otherwise-compatible v1 bundle and publish
    misleading checkpoint provenance.

    Standalone active-catalog records remain supported for isolated tests and
    lower-level tooling. Once the managed full22 marker is present, however,
    the complete bundle and its exact student binding are mandatory.
    """

    catalog_path = active_catalog_path.expanduser().resolve()
    bundle_root = catalog_path.parent
    marker_path = bundle_root / FULL22_ACTIVE_MARKER
    if not marker_path.exists():
        return
    if catalog_path.name != ACTIVE_CATALOG_FILE:
        raise StudentRuntimeExportError(
            "managed full22 bundle must use its canonical active-catalog file"
        )
    _exact_inventory(
        bundle_root,
        set(FULL22_ACTIVE_FILES),
        location="student-bound full22 active bundle",
    )
    marker = _validate_full22_active_marker(bundle_root)
    expected_student_sources = {
        "manga_font_student_checkpoint_sha256": sha256_file(
            student_root / trainer.CHECKPOINT_FILE
        ),
        "manga_font_student_contract_sha256": sha256_file(
            student_root / trainer.CONTRACT_FILE
        ),
    }
    expected_marker_source = {
        "font_face_manifest_sha256": FULL22_FONT_MANIFEST_SHA256,
        **expected_student_sources,
        "render_bank_manifest_sha256": FULL22_RENDER_MANIFEST_SHA256,
    }
    if _mapping(marker.get("source"), "full22 marker source") != expected_marker_source:
        raise StudentRuntimeExportError(
            "managed full22 active catalog belongs to a different student checkpoint"
        )
    authority = _read_json(
        bundle_root / FULL22_AUTHORITY_FILE, location="full22 release authority"
    )
    try:
        runtime.validate_record_seal(authority, location="full22 release authority")
    except runtime.RuntimeArtifactError as error:
        raise StudentRuntimeExportError(str(error)) from error
    if (
        authority.get("schema_version") != "manga-font-full22-release-authority-v1"
        or authority.get("record_type") != "manga_font_full22_release_authority"
        or tuple(authority.get("candidate_ids", [])) != EXPECTED_CANDIDATE_IDS
        or authority.get("sources") != expected_marker_source
    ):
        raise StudentRuntimeExportError(
            "managed full22 release authority is not bound to the current student"
        )


def validate_full22_active_catalog_output(
    *,
    student_output: Path,
    font_face_manifest_path: Path,
    render_bank_manifest_path: Path,
    asset_root: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    candidate_ids, student_contract_sha, checkpoint_sha = _student_candidate_contract(
        student_output
    )
    font_sha, render_sha = _validate_full22_catalog_sources(
        font_face_manifest_path=font_face_manifest_path,
        render_bank_manifest_path=render_bank_manifest_path,
        asset_root=asset_root,
        candidate_ids=candidate_ids,
    )
    root = _safe_output(output_dir)
    _exact_inventory(root, set(FULL22_ACTIVE_FILES), location="full22 active bundle")
    marker = _validate_full22_active_marker(root)
    source = _mapping(marker.get("source"), "full22 marker source")
    if source != {
        "font_face_manifest_sha256": font_sha,
        "manga_font_student_checkpoint_sha256": checkpoint_sha,
        "manga_font_student_contract_sha256": student_contract_sha,
        "render_bank_manifest_sha256": render_sha,
    }:
        raise StudentRuntimeExportError("full22 active source binding drifted")
    authority = _read_json(root / FULL22_AUTHORITY_FILE, location="full22 authority")
    disposition = _read_json(
        root / FULL22_DISPOSITION_FILE, location="full22 disposition"
    )
    final_catalog = _read_json(
        root / FULL22_FINAL_CATALOG_FILE, location="full22 final catalog"
    )
    try:
        for record, location in (
            (authority, "full22 authority"),
            (disposition, "full22 disposition"),
            (final_catalog, "full22 final catalog"),
        ):
            runtime.validate_record_seal(record, location=location)
        active = runtime.load_active_catalog(
            root / ACTIVE_CATALOG_FILE, location="full22 active catalog"
        )
    except runtime.RuntimeArtifactError as error:
        raise StudentRuntimeExportError(str(error)) from error
    authority_sha = authority.get("record_sha256")
    final_catalog_candidate_ids = tuple(final_catalog.get("candidate_ids", []))
    if (
        tuple(authority.get("candidate_ids", [])) != candidate_ids
        or final_catalog_candidate_ids != tuple(sorted(candidate_ids))
        or tuple(final_catalog.get("prior_candidate_ids", []))
        != final_catalog_candidate_ids
        or final_catalog.get("candidate_set_sha256")
        != runtime._candidate_set_sha256(final_catalog_candidate_ids)  # noqa: SLF001
        or authority.get("sources")
        != {
            "font_face_manifest_sha256": font_sha,
            "manga_font_student_checkpoint_sha256": checkpoint_sha,
            "manga_font_student_contract_sha256": student_contract_sha,
            "render_bank_manifest_sha256": render_sha,
        }
        or disposition.get("workspace_contract_record_sha256") != authority_sha
        or final_catalog.get("workspace_contract_record_sha256") != authority_sha
        or final_catalog.get("catalog_disposition_record_sha256")
        != disposition.get("record_sha256")
        or tuple(active["candidate_ids"]) != candidate_ids
        or active["excluded_candidates"]
        or active["source_records"]["catalog_disposition_record_sha256"]
        != disposition.get("record_sha256")
        or active["source_records"]["final_catalog_record_sha256"]
        != final_catalog.get("record_sha256")
        or active["source_records"]["deployment_font_face_manifest_sha256"] != font_sha
        or active["source_records"]["deployment_render_bank_manifest_sha256"]
        != render_sha
    ):
        raise StudentRuntimeExportError("full22 active catalog authority drifted")
    return {
        "active_catalog_path": str(root / ACTIVE_CATALOG_FILE),
        "active_catalog_record_sha256": active["record_sha256"],
        "candidate_count": len(candidate_ids),
        "output_dir": str(root),
        "status": "ready",
    }


def _commit_full22_active_bundle(
    *,
    staging: Path,
    target: Path,
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
    _validate_full22_active_marker(target)
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


def build_full22_active_catalog_output(
    *,
    student_output: Path,
    font_face_manifest_path: Path,
    render_bank_manifest_path: Path,
    asset_root: Path,
    output_dir: Path,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    candidate_ids, student_contract_sha, checkpoint_sha = _student_candidate_contract(
        student_output
    )
    font_sha, render_sha = _validate_full22_catalog_sources(
        font_face_manifest_path=font_face_manifest_path,
        render_bank_manifest_path=render_bank_manifest_path,
        asset_root=asset_root,
        candidate_ids=candidate_ids,
    )
    authority = _full22_authority_record(
        candidate_ids=candidate_ids,
        student_contract_sha256=student_contract_sha,
        checkpoint_sha256=checkpoint_sha,
        font_manifest_sha256=font_sha,
        render_manifest_sha256=render_sha,
    )
    authority_sha = str(authority["record_sha256"])
    disposition = _full22_disposition_record(
        authority_sha256=authority_sha,
        student_contract_sha256=student_contract_sha,
        checkpoint_sha256=checkpoint_sha,
        font_manifest_sha256=font_sha,
        render_manifest_sha256=render_sha,
    )
    final_catalog = _full22_final_catalog_record(
        candidate_ids=candidate_ids,
        authority_sha256=authority_sha,
        disposition_sha256=str(disposition["record_sha256"]),
        student_contract_sha256=student_contract_sha,
        checkpoint_sha256=checkpoint_sha,
        font_manifest_sha256=font_sha,
        render_manifest_sha256=render_sha,
    )
    target = _safe_output(output_dir)
    sources = (
        student_output.expanduser().resolve(),
        font_face_manifest_path.expanduser().resolve(),
        render_bank_manifest_path.expanduser().resolve(),
    )
    if any(_paths_overlap(target, source) for source in sources):
        raise StudentRuntimeExportError("full22 active output overlaps a source")
    if target.exists() and not replace_owned_output:
        raise StudentRuntimeExportError(
            "full22 active output exists; pass --replace-owned-output after validation"
        )
    if target.exists():
        _validate_full22_active_marker(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        (staging / FULL22_AUTHORITY_FILE).write_bytes(
            json_bytes(authority, pretty=True)
        )
        (staging / FULL22_DISPOSITION_FILE).write_bytes(
            json_bytes(disposition, pretty=True)
        )
        (staging / FULL22_FINAL_CATALOG_FILE).write_bytes(
            json_bytes(final_catalog, pretty=True)
        )
        try:
            runtime.build_active_catalog(
                final_catalog_path=staging / FULL22_FINAL_CATALOG_FILE,
                catalog_disposition_path=staging / FULL22_DISPOSITION_FILE,
                deployment_font_face_manifest_path=font_face_manifest_path.expanduser().resolve(),
                deployment_render_bank_manifest_path=render_bank_manifest_path.expanduser().resolve(),
                asset_root=asset_root.expanduser().resolve(),
                output_path=staging / ACTIVE_CATALOG_FILE,
                deployment_candidate_order=candidate_ids,
            )
        except runtime.RuntimeArtifactError as error:
            raise StudentRuntimeExportError(str(error)) from error
        marker = {
            "artifacts": {
                name: sha256_file(staging / name)
                for name in sorted(FULL22_ACTIVE_FILES - {FULL22_ACTIVE_MARKER})
            },
            "owner": FULL22_ACTIVE_OWNER,
            "safe_replace": True,
            "schema_version": FULL22_ACTIVE_SCHEMA,
            "source": {
                "font_face_manifest_sha256": font_sha,
                "manga_font_student_checkpoint_sha256": checkpoint_sha,
                "manga_font_student_contract_sha256": student_contract_sha,
                "render_bank_manifest_sha256": render_sha,
            },
        }
        (staging / FULL22_ACTIVE_MARKER).write_bytes(json_bytes(marker, pretty=True))
        validate_full22_active_catalog_output(
            student_output=student_output,
            font_face_manifest_path=font_face_manifest_path,
            render_bank_manifest_path=render_bank_manifest_path,
            asset_root=asset_root,
            output_dir=staging,
        )
        return _commit_full22_active_bundle(
            staging=staging,
            target=target,
            validate_published=lambda published: validate_full22_active_catalog_output(
                student_output=student_output,
                font_face_manifest_path=font_face_manifest_path,
                render_bank_manifest_path=render_bank_manifest_path,
                asset_root=asset_root,
                output_dir=published,
            ),
        )
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def _load_models(authority: StudentAuthority) -> tuple[Any, Any]:
    legacy_export._ensure_offline_environment()  # noqa: SLF001
    try:
        import torch
        from safetensors.torch import load_file
        from transformers import AutoImageProcessor, SiglipVisionModel
    except (ImportError, OSError) as error:  # pragma: no cover - release environment
        raise StudentRuntimeExportError(
            "export requires torch, transformers, safetensors, and local model files"
        ) from error
    processor = AutoImageProcessor.from_pretrained(
        str(authority.encoder_source_dir), local_files_only=True, use_fast=False
    )
    preprocessing = _mapping(authority.contract.get("preprocessing"), "preprocessing")
    processor_sha = sha256_bytes(canonical_json(processor.to_dict()).encode("utf-8"))
    if processor_sha != preprocessing.get("processor_config_sha256"):
        raise StudentRuntimeExportError("local processor differs from student training")
    try:
        vision = SiglipVisionModel.from_pretrained(
            str(authority.encoder_source_dir),
            local_files_only=True,
            attn_implementation="eager",
        )
        vision.config._attn_implementation = "eager"  # noqa: SLF001
        student, _ = _build_student_for_export(
            torch,
            vision_encoder=vision,
            contract=authority.contract,
            candidate_count=len(authority.candidate_ids),
        )
        state = dict(load_file(str(authority.checkpoint_path), device="cpu"))
    except Exception as error:  # noqa: BLE001 - normalize dependency/model failures
        raise StudentRuntimeExportError(
            f"student reconstruction failed: {error}"
        ) from error
    checkpoint = _mapping(authority.contract.get("checkpoint"), "student checkpoint")
    rows = _list(checkpoint.get("state_contract"), "checkpoint state contract")
    declared = {
        _text(_mapping(row, "state row").get("name"), "state name"): row for row in rows
    }
    parameters = dict(student.named_parameters())
    trainable = {name for name, value in parameters.items() if value.requires_grad}
    if set(state) != set(declared) or set(state) != trainable:
        raise StudentRuntimeExportError(
            "checkpoint tensors do not exactly equal reconstructed trainable parameters"
        )
    with torch.no_grad():
        for name, value in state.items():
            row = _mapping(declared[name], f"state_contract.{name}")
            expected_dtype = str(value.dtype).replace("torch.", "")
            if (
                row.get("shape") != list(value.shape)
                or row.get("dtype") != expected_dtype
            ):
                raise StudentRuntimeExportError(
                    f"checkpoint tensor contract drifted: {name}"
                )
            parameter = parameters[name]
            if tuple(parameter.shape) != tuple(value.shape):
                raise StudentRuntimeExportError(
                    f"checkpoint tensor shape drifted: {name}"
                )
            parameter.copy_(value.to(dtype=parameter.dtype))
    student.requires_grad_(False)
    student.eval()
    student.to("cpu", dtype=torch.float32)
    return student, processor


def _make_wrappers(student: Any, authority: StudentAuthority) -> tuple[Any, Any]:
    import torch

    class EncoderWrapper(torch.nn.Module):
        def __init__(self, model: Any) -> None:
            super().__init__()
            self.vision_encoder = model.vision_encoder
            self.projection = model.projection

        def forward(self, pixel_values: Any) -> Any:
            output = self.vision_encoder(pixel_values=pixel_values, return_dict=False)
            projected = self.projection(output[1])
            return torch.nn.functional.normalize(projected.float(), p=2, dim=-1)

    bag_tensors = tuple(
        torch.arange(row["start"], row["start"] + row["count"], dtype=torch.long)
        for row in authority.candidate_bags
    )
    treatment_fields = tuple(
        sorted(_mapping(authority.contract["vocabulary"], "vocabulary")["treatments"])
    )

    class RankerWrapper(torch.nn.Module):
        def __init__(self, ranker: Any) -> None:
            super().__init__()
            self.runtime_ranker = ranker
            for index, bag in enumerate(bag_tensors):
                self.register_buffer(f"candidate_bag_{index}", bag, persistent=False)

        def forward(self, views: Any, prototype_features: Any) -> tuple[Any, ...]:
            bags = tuple(
                getattr(self, f"candidate_bag_{index}")
                for index in range(len(bag_tensors))
            )
            outputs = self.runtime_ranker(views, prototype_features, bags)
            treatments = outputs["treatment_logits"]
            return (
                outputs["candidate_scores"],
                outputs["none_logits"],
                outputs["role_logits"],
                outputs["style_logits"],
                *(treatments[field] for field in treatment_fields),
                outputs["view_gate_weights"],
            )

    return EncoderWrapper(student).eval(), RankerWrapper(student.runtime_ranker).eval()


def _output_names(authority: StudentAuthority) -> tuple[str, ...]:
    return _validate_runtime_adapter(authority.contract)


def _io_contract(authority: StudentAuthority) -> dict[str, Any]:
    adapter_contract = {
        "architecture": {"feature_dim": trainer.PROJECTION_DIM},
        "vocabulary": copy.deepcopy(dict(authority.contract["vocabulary"])),
    }
    return runtime._expected_onnx_io(  # noqa: SLF001
        contract=adapter_contract,
        prototype_count=int(authority.prototypes.shape[0]),
        candidate_count=len(authority.candidate_ids),
    )


def _export_graphs(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    authority: StudentAuthority,
    encoder_path: Path,
    ranker_path: Path,
) -> None:
    legacy_export._require_onnx_export_dependency()  # noqa: SLF001
    import torch

    output_names = _output_names(authority)
    prototypes = torch.from_numpy(np.array(authority.prototypes, copy=True))
    dynamic_axes = {"views": {0: "batch"}}
    dynamic_axes.update({name: {0: "batch"} for name in output_names})
    try:
        with torch.inference_mode():
            torch.onnx.export(
                encoder_wrapper,
                (torch.zeros((1, 3, 224, 224), dtype=torch.float32),),
                str(encoder_path),
                input_names=["pixel_values"],
                output_names=["image_features"],
                dynamic_axes={
                    "pixel_values": {0: "batch"},
                    "image_features": {0: "batch"},
                },
                opset_version=OPSET_VERSION,
                dynamo=False,
                external_data=False,
                export_params=True,
                do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
            torch.onnx.export(
                ranker_wrapper,
                (
                    torch.zeros((2, 3, trainer.PROJECTION_DIM), dtype=torch.float32),
                    prototypes,
                ),
                str(ranker_path),
                input_names=["views", "prototype_features"],
                output_names=list(output_names),
                dynamic_axes=dynamic_axes,
                opset_version=OPSET_VERSION,
                dynamo=False,
                external_data=False,
                export_params=True,
                do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
    except Exception as error:  # noqa: BLE001 - normalize torch exporter failures
        raise StudentRuntimeExportError(
            f"PyTorch ONNX export failed: {error}"
        ) from error


def inspect_graph(path: Path) -> Mapping[str, Any]:
    try:
        return legacy_export._inspect_graph_file(  # noqa: SLF001
            path, expected_opset=OPSET_VERSION
        )
    except legacy_export.ConversionError as error:
        raise StudentRuntimeExportError(str(error)) from error


def _parity_metrics(
    *,
    reference_encoder: np.ndarray,
    actual_encoder: np.ndarray,
    reference_ranker: Mapping[str, np.ndarray],
    actual_ranker: Mapping[str, np.ndarray],
) -> dict[str, Any]:
    if reference_encoder.shape != actual_encoder.shape:
        raise StudentRuntimeExportError("encoder parity shape drifted")
    if set(reference_ranker) != set(actual_ranker):
        raise StudentRuntimeExportError("ranker parity output inventory drifted")
    if not np.isfinite(actual_encoder).all() or any(
        not np.isfinite(value).all() for value in actual_ranker.values()
    ):
        raise StudentRuntimeExportError("ONNX runtime emitted non-finite values")
    for name, reference in reference_ranker.items():
        if reference.shape != actual_ranker[name].shape:
            raise StudentRuntimeExportError(f"ranker parity shape drifted: {name}")
    encoder_error = float(
        np.max(np.abs(reference_encoder.astype(np.float64) - actual_encoder))
    )
    ranker_error = max(
        float(np.max(np.abs(value.astype(np.float64) - actual_ranker[name])))
        for name, value in reference_ranker.items()
    )
    norms = np.maximum(
        np.linalg.norm(reference_encoder, axis=1)
        * np.linalg.norm(actual_encoder, axis=1),
        np.float32(1e-12),
    )
    cosine = np.sum(reference_encoder * actual_encoder, axis=1) / norms
    decisions = {
        "candidate_top1_agreement": float(
            np.mean(
                np.argmax(reference_ranker["candidate_scores"], axis=1)
                == np.argmax(actual_ranker["candidate_scores"], axis=1)
            )
        ),
        "none_decision_agreement": float(
            np.mean(
                (reference_ranker["none_logits"] >= 0)
                == (actual_ranker["none_logits"] >= 0)
            )
        ),
        "role_top1_agreement": float(
            np.mean(
                np.argmax(reference_ranker["role_logits"], axis=1)
                == np.argmax(actual_ranker["role_logits"], axis=1)
            )
        ),
    }
    minimum_cosine = float(np.min(cosine))
    if (
        encoder_error > 2e-4
        or ranker_error > 2e-4
        or minimum_cosine < 0.999
        or any(value != 1.0 for value in decisions.values())
    ):
        raise StudentRuntimeExportError("ONNX numeric/decision parity gate failed")
    return {
        "encoder_max_abs_error": encoder_error,
        "encoder_minimum_cosine_similarity": minimum_cosine,
        "ranker_max_abs_error": ranker_error,
        **decisions,
    }


def _run_parity(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    authority: StudentAuthority,
    encoder_path: Path,
    ranker_path: Path,
    electron_path: Path,
    sample_count: int,
    seed: int,
    wasm_timeout_seconds: int,
) -> Mapping[str, Any]:
    if sample_count < MIN_PARITY_SAMPLES:
        raise StudentRuntimeExportError(
            f"parity requires at least {MIN_PARITY_SAMPLES} synthetic rows"
        )
    encoder_inputs = legacy_export._synthetic_encoder_inputs(sample_count, seed)  # noqa: SLF001
    rng = np.random.default_rng(seed ^ 0x22F0)
    ranker_views = rng.standard_normal(
        (sample_count, 3, trainer.PROJECTION_DIM), dtype=np.float32
    )
    ranker_views /= np.maximum(
        np.linalg.norm(ranker_views, axis=-1, keepdims=True), np.float32(1e-12)
    )
    output_names = _output_names(authority)
    reference_encoder, reference_ranker = legacy_export._run_reference_models(  # noqa: SLF001
        encoder_wrapper=encoder_wrapper,
        ranker_wrapper=ranker_wrapper,
        encoder_inputs=encoder_inputs,
        ranker_views=np.ascontiguousarray(ranker_views),
        prototype_features=authority.prototypes,
        encoder_batch_size=2,
        ranker_batch_size=16,
        output_names=output_names,
    )
    cpu_encoder, cpu_ranker, cpu_evidence = legacy_export._run_cpu_ort(  # noqa: SLF001
        encoder_path=encoder_path,
        ranker_path=ranker_path,
        encoder_inputs=encoder_inputs,
        ranker_views=np.ascontiguousarray(ranker_views),
        prototype_features=authority.prototypes,
        encoder_batch_size=2,
        ranker_batch_size=16,
        output_names=output_names,
    )
    wasm_encoder, wasm_ranker, wasm_evidence = legacy_export._run_electron_wasm(  # noqa: SLF001
        encoder_path=encoder_path,
        ranker_path=ranker_path,
        encoder_inputs=encoder_inputs,
        ranker_views=np.ascontiguousarray(ranker_views),
        prototype_features=authority.prototypes,
        encoder_batch_size=2,
        ranker_batch_size=16,
        output_names=output_names,
        electron_path=electron_path,
        timeout_seconds=wasm_timeout_seconds,
    )
    return {
        "cpu": {
            "evidence": dict(cpu_evidence),
            "metrics": _parity_metrics(
                reference_encoder=reference_encoder,
                actual_encoder=cpu_encoder,
                reference_ranker=reference_ranker,
                actual_ranker=cpu_ranker,
            ),
        },
        "frozen_test_pixels_opened": 0,
        "frozen_test_rows_used": 0,
        "opset": OPSET_VERSION,
        "sample_count": sample_count,
        "sample_source": "deterministic_synthetic_only",
        "seed": seed,
        "wasm": {
            "evidence": dict(wasm_evidence),
            "metrics": _parity_metrics(
                reference_encoder=reference_encoder,
                actual_encoder=wasm_encoder,
                reference_ranker=reference_ranker,
                actual_ranker=wasm_ranker,
            ),
        },
    }


def _artifact_descriptor(path: Path, *, file_name: str) -> dict[str, Any]:
    return runtime._artifact_descriptor(path, file_name=file_name)  # noqa: SLF001


def _runtime_policy() -> dict[str, Any]:
    core = {
        "automatic_mutation": copy.deepcopy(AUTOMATIC_POLICY),
        "chapter_prior": copy.deepcopy(CHAPTER_POLICY),
    }
    return {**core, "policy_sha256": sha256_bytes(canonical_json(core).encode("utf-8"))}


def _build_runtime_contract(
    *, authority: StudentAuthority, staging: Path, parity: Mapping[str, Any]
) -> dict[str, Any]:
    copies = (ACTIVE_CATALOG_FILE, ENCODER_FILE, RANKER_FILE, PROTOTYPE_FILE)
    artifacts = {
        name: _artifact_descriptor(staging / name, file_name=name) for name in copies
    }
    active_sources = _mapping(
        authority.active_catalog.get("source_records"), "active catalog source records"
    )
    inputs = _mapping(authority.contract.get("inputs"), "student inputs")
    checkpoint = _mapping(authority.contract.get("checkpoint"), "student checkpoint")
    architecture = copy.deepcopy(dict(authority.contract["architecture"]))
    architecture["feature_dim"] = trainer.PROJECTION_DIM
    candidate_order_sha = runtime._ordered_values_sha256(authority.candidate_ids)  # noqa: SLF001
    frozen_manifest = _text(
        inputs.get("human_export_manifest_sha256"), "human export manifest hash"
    )
    report_boundary = _mapping(authority.report.get("human_boundary"), "human boundary")
    return runtime.seal_record(
        {
            "artifacts": artifacts,
            "calibration": {
                "calibration_split": "val",
                "none_threshold": 0.5,
                "none_threshold_selection_metric": "neutral_base_before_supervised_attachment",
                "temperature": 1.0,
                "temperature_selection_metric": "neutral_base_before_supervised_attachment",
            },
            "catalog": {
                "active_catalog_record_sha256": authority.active_catalog[
                    "record_sha256"
                ],
                "candidate_count": len(authority.candidate_ids),
                "candidate_ids": list(authority.candidate_ids),
                "candidate_order_sha256": candidate_order_sha,
                "candidate_parameterization": "prototype-bag-only-no-id-embedding-or-bias",
                "catalog_disposition_record_sha256": active_sources[
                    "catalog_disposition_record_sha256"
                ],
                "catalog_registry_sha256": inputs["catalog_registry_sha256"],
                "catalog_version": authority.active_catalog["catalog_version"],
                "final_catalog_record_sha256": active_sources[
                    "final_catalog_record_sha256"
                ],
                "font_catalog_sha256": active_sources[
                    "deployment_font_face_manifest_sha256"
                ],
                "font_prototypes_sha256": sha256_file(staging / PROTOTYPE_FILE),
                "prototype_bags": [dict(row) for row in authority.candidate_bags],
                "prototype_count": int(authority.prototypes.shape[0]),
                "render_bank_manifest_sha256": active_sources[
                    "deployment_render_bank_manifest_sha256"
                ],
            },
            "deployment": {
                "automatic_mutation_allowed": True,
                "fail_closed": True,
                "fallback_policy": copy.deepcopy(FALLBACK_POLICY),
                "state": "ready",
            },
            "encoder": {
                "class": "SiglipVisionModel",
                "fully_frozen": True,
                "model_id": trainer.MODEL_ID,
                "onnx_sha256": artifacts[ENCODER_FILE]["sha256"],
                "revision": trainer.MODEL_REVISION,
                "source_weights_sha256": sha256_file(authority.encoder_source_weights),
                "version": "siglip-vision-onnx-v1",
            },
            "head": {
                "architecture": architecture,
                "checkpoint_metadata": copy.deepcopy(dict(checkpoint["metadata"])),
                "checkpoint_sha256": sha256_file(authority.checkpoint_path),
                "onnx_sha256": artifacts[RANKER_FILE]["sha256"],
                "version": "manga-font-student-prototype-ranker-onnx-v1",
            },
            "model_version": (
                f"manga-font-student-runtime-v1-"
                f"{sha256_file(authority.checkpoint_path)[:12]}-{candidate_order_sha[:12]}"
            ),
            "onnx_io_contract": _io_contract(authority),
            "policy": _runtime_policy(),
            "preprocessing": {
                "input_mode": "RGB",
                "input_size_px": [224, 224],
                "processor": {
                    "class": "AutoImageProcessor",
                    "do_resize": False,
                    "use_fast": False,
                },
                "prototype_to_encoder_input": {
                    "algorithm": "fontclip-letterbox-rgb-v1",
                    "canvas_color_rgb": [255, 255, 255],
                    "convert_mode": "RGB",
                    "operation": "aspect_preserving_letterbox",
                    "placement": "center_floor",
                    "resize_filter": "lanczos",
                    "rounding": "python_round_then_minimum_1px",
                    "target_size_px": [224, 224],
                },
                "sample_views": "verified-rgb-224-passthrough-v1",
            },
            "provenance": {
                "export_validation": copy.deepcopy(dict(parity)),
                "exporter_sha256": sha256_file(Path(__file__).resolve()),
                "frozen_test_manifest_sha256": frozen_manifest,
                "model_contract_sha256": sha256_file(
                    authority.student_root / trainer.CONTRACT_FILE
                ),
                "student_report_sha256": sha256_file(
                    authority.student_root / trainer.REPORT_FILE
                ),
                "trainer_checkpoint_sha256": sha256_file(authority.checkpoint_path),
                "trainer_code_sha256": authority.contract["source_code_sha256"],
            },
            "record_type": runtime.RECORD_TYPE,
            "release_evaluation": {
                "evaluated_row_count": int(report_boundary.get("val_row_count", 0)),
                "evaluation_report_sha256": sha256_file(
                    authority.student_root / trainer.REPORT_FILE
                ),
                "metrics": copy.deepcopy(dict(authority.report["best_human_val"])),
                "test_manifest_sha256": frozen_manifest,
                "thresholds": {},
            },
            "runtime": {
                "execution_provider": runtime.TARGET_ORT_PROVIDER,
                "package": runtime.TARGET_ORT_PACKAGE,
                "version": runtime.TARGET_ORT_VERSION,
            },
            "schema_version": runtime.SCHEMA_VERSION,
            "test_data_boundary": {
                "aggregate_metrics_only": True,
                "frozen_test_pixels_opened_by_exporter": 0,
                "row_level_predictions_packaged": False,
                "sample_identifiers_packaged": False,
                "training_or_validation_pixels_packaged": False,
            },
        }
    )


def validate_runtime_output(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    output_dir: Path,
    inspect_onnx: bool = True,
) -> Mapping[str, Any]:
    authority = load_student_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
    )
    root = _safe_output(output_dir)
    _exact_inventory(root, set(OUTPUT_FILES), location="student runtime output")
    marker = _read_json(root / MARKER_FILE, location="runtime marker")
    if (
        marker.get("owner") != runtime.OWNER
        or marker.get("schema_version") != runtime.SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise StudentRuntimeExportError("runtime ownership marker is invalid")
    marker_artifacts = _mapping(marker.get("artifacts"), "runtime marker artifacts")
    if set(marker_artifacts) != set(OUTPUT_FILES - {MARKER_FILE}):
        raise StudentRuntimeExportError("runtime marker inventory drifted")
    for name in OUTPUT_FILES - {MARKER_FILE}:
        if marker_artifacts.get(name) != sha256_file(root / name):
            raise StudentRuntimeExportError(f"runtime artifact hash mismatch: {name}")
    if (root / PROTOTYPE_FILE).read_bytes() != authority.prototype_path.read_bytes():
        raise StudentRuntimeExportError("published prototype bank differs from student")
    contract = _read_json(root / CONTRACT_FILE, location="runtime contract")
    provenance = _mapping(contract.get("provenance"), "runtime provenance")
    if (
        provenance.get("model_contract_sha256")
        != sha256_file(authority.student_root / trainer.CONTRACT_FILE)
        or provenance.get("trainer_checkpoint_sha256")
        != sha256_file(authority.checkpoint_path)
        or tuple(_mapping(contract.get("catalog"), "runtime catalog")["candidate_ids"])
        != authority.candidate_ids
    ):
        raise StudentRuntimeExportError("runtime/student source binding drifted")
    if inspect_onnx:
        inspect_graph(root / ENCODER_FILE)
        inspect_graph(root / RANKER_FILE)
    try:
        result = runtime._validate_runtime_artifact(  # noqa: SLF001
            output_dir=root, inspect_onnx=inspect_onnx
        )
    except runtime.RuntimeArtifactError as error:
        raise StudentRuntimeExportError(str(error)) from error
    return {
        **dict(result),
        "candidate_count": len(authority.candidate_ids),
        "selection_calibration_required": True,
        "status": "base_runtime_ready_for_supervised_calibration_attachment",
    }


def build_runtime_output(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    output_dir: Path,
    electron_path: Path,
    parity_samples: int = MIN_PARITY_SAMPLES,
    parity_seed: int = 20260803,
    wasm_timeout_seconds: int = 7200,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    if parity_samples < MIN_PARITY_SAMPLES:
        raise StudentRuntimeExportError(
            f"parity_samples must be >= {MIN_PARITY_SAMPLES}"
        )
    if wasm_timeout_seconds < 60:
        raise StudentRuntimeExportError("WASM timeout must be at least 60 seconds")
    authority = load_student_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
    )
    target = _safe_output(output_dir)
    if any(
        _paths_overlap(target, source)
        for source in (
            authority.student_root,
            authority.active_catalog_path,
            authority.encoder_source_dir,
        )
    ):
        raise StudentRuntimeExportError("runtime output overlaps an immutable source")
    if target.exists() and not replace_owned_output:
        raise StudentRuntimeExportError(
            "runtime output exists; pass --replace-owned-output after validation"
        )
    if target.exists():
        runtime._validate_output_marker(target)  # noqa: SLF001
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        shutil.copyfile(authority.active_catalog_path, staging / ACTIVE_CATALOG_FILE)
        shutil.copyfile(authority.prototype_path, staging / PROTOTYPE_FILE)
        student, _processor = _load_models(authority)
        encoder_wrapper, ranker_wrapper = _make_wrappers(student, authority)
        _export_graphs(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=staging / ENCODER_FILE,
            ranker_path=staging / RANKER_FILE,
        )
        inspect_graph(staging / ENCODER_FILE)
        inspect_graph(staging / RANKER_FILE)
        expected_io = _io_contract(authority)
        if (
            runtime._inspect_onnx_contract(staging / ENCODER_FILE)  # noqa: SLF001
            != expected_io[ENCODER_FILE]
            or runtime._inspect_onnx_contract(staging / RANKER_FILE)  # noqa: SLF001
            != expected_io[RANKER_FILE]
        ):
            raise StudentRuntimeExportError(
                "exported ONNX I/O differs from app runtime"
            )
        parity = _run_parity(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=staging / ENCODER_FILE,
            ranker_path=staging / RANKER_FILE,
            electron_path=electron_path.expanduser().resolve(),
            sample_count=parity_samples,
            seed=parity_seed,
            wasm_timeout_seconds=wasm_timeout_seconds,
        )
        contract = _build_runtime_contract(
            authority=authority, staging=staging, parity=parity
        )
        (staging / CONTRACT_FILE).write_bytes(json_bytes(contract, pretty=True))
        marker = {
            "artifacts": {
                name: sha256_file(staging / name)
                for name in sorted(OUTPUT_FILES - {MARKER_FILE})
            },
            "owner": runtime.OWNER,
            "safe_replace": True,
            "schema_version": runtime.SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_runtime_output(
            student_output=student_output,
            active_catalog_path=active_catalog_path,
            encoder_source_dir=encoder_source_dir,
            output_dir=staging,
        )
        return runtime._commit_managed_directory(  # noqa: SLF001
            staging,
            target,
            validate_published=lambda published: validate_runtime_output(
                student_output=student_output,
                active_catalog_path=active_catalog_path,
                encoder_source_dir=encoder_source_dir,
                output_dir=published,
            ),
        )
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def _paths_overlap(left: Path, right: Path) -> bool:
    left = left.resolve()
    right = right.resolve()
    try:
        left.relative_to(right)
        return True
    except ValueError:
        pass
    try:
        right.relative_to(left)
        return True
    except ValueError:
        return False


def preflight(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    electron_path: Path,
) -> Mapping[str, Any]:
    authority = load_student_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
    )
    legacy_export._require_onnx_export_dependency()  # noqa: SLF001
    try:
        import onnxruntime as ort
        import torch
        import transformers
    except ImportError as error:  # pragma: no cover - release environment
        raise StudentRuntimeExportError(
            f"export dependency missing: {error}"
        ) from error
    if electron_path.is_symlink() or not electron_path.is_file():
        raise StudentRuntimeExportError("pinned Electron executable is unavailable")
    assets = legacy_export._runtime_asset_paths()  # noqa: SLF001
    for label, path in {"WASM helper": legacy_export.WASM_HELPER, **assets}.items():
        if path.is_symlink() or not path.is_file():
            raise StudentRuntimeExportError(f"{label} is unavailable: {path}")
    return {
        "candidate_count": len(authority.candidate_ids),
        "checkpoint_sha256": sha256_file(authority.checkpoint_path),
        "electron_version": legacy_export._pinned_electron_version(),  # noqa: SLF001
        "feature_dim": trainer.PROJECTION_DIM,
        "onnxruntime_version": ort.__version__,
        "opset": OPSET_VERSION,
        "prototype_count": int(authority.prototypes.shape[0]),
        "status": "ready_for_manga_font_student_onnx_export",
        "torch_version": torch.__version__,
        "transformers_version": transformers.__version__,
    }


def _add_authority_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--student-output", type=Path, required=True)
    parser.add_argument("--active-catalog", type=Path, required=True)
    parser.add_argument("--encoder-source-dir", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    active = subparsers.add_parser("active-catalog")
    active.add_argument("--student-output", type=Path, required=True)
    active.add_argument(
        "--font-face-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-catalog-v2/manifest.json"),
    )
    active.add_argument(
        "--render-bank-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v2/manifest.json"),
    )
    active.add_argument("--asset-root", type=Path, default=Path("."))
    active.add_argument("--output-dir", type=Path, required=True)
    active.add_argument("--replace-owned-output", action="store_true")
    validate_active = subparsers.add_parser("validate-active-catalog")
    validate_active.add_argument("--student-output", type=Path, required=True)
    validate_active.add_argument(
        "--font-face-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-catalog-v2/manifest.json"),
    )
    validate_active.add_argument(
        "--render-bank-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v2/manifest.json"),
    )
    validate_active.add_argument("--asset-root", type=Path, default=Path("."))
    validate_active.add_argument("--output-dir", type=Path, required=True)
    preflight_parser = subparsers.add_parser("preflight")
    _add_authority_arguments(preflight_parser)
    preflight_parser.add_argument(
        "--electron-path",
        type=Path,
        default=legacy_export._default_electron_path(),  # noqa: SLF001
    )
    build = subparsers.add_parser("build")
    _add_authority_arguments(build)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument(
        "--electron-path",
        type=Path,
        default=legacy_export._default_electron_path(),  # noqa: SLF001
    )
    build.add_argument("--parity-samples", type=int, default=MIN_PARITY_SAMPLES)
    build.add_argument("--parity-seed", type=int, default=20260803)
    build.add_argument("--wasm-timeout-seconds", type=int, default=7200)
    build.add_argument("--replace-owned-output", action="store_true")
    validate = subparsers.add_parser("validate")
    _add_authority_arguments(validate)
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "active-catalog":
            result = build_full22_active_catalog_output(
                student_output=args.student_output,
                font_face_manifest_path=args.font_face_manifest,
                render_bank_manifest_path=args.render_bank_manifest,
                asset_root=args.asset_root,
                output_dir=args.output_dir,
                replace_owned_output=args.replace_owned_output,
            )
        elif args.command == "validate-active-catalog":
            result = validate_full22_active_catalog_output(
                student_output=args.student_output,
                font_face_manifest_path=args.font_face_manifest,
                render_bank_manifest_path=args.render_bank_manifest,
                asset_root=args.asset_root,
                output_dir=args.output_dir,
            )
        elif args.command == "preflight":
            result = preflight(
                student_output=args.student_output,
                active_catalog_path=args.active_catalog,
                encoder_source_dir=args.encoder_source_dir,
                electron_path=args.electron_path,
            )
        elif args.command == "build":
            result = build_runtime_output(
                student_output=args.student_output,
                active_catalog_path=args.active_catalog,
                encoder_source_dir=args.encoder_source_dir,
                output_dir=args.output_dir,
                electron_path=args.electron_path,
                parity_samples=args.parity_samples,
                parity_seed=args.parity_seed,
                wasm_timeout_seconds=args.wasm_timeout_seconds,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_runtime_output(
                student_output=args.student_output,
                active_catalog_path=args.active_catalog,
                encoder_source_dir=args.encoder_source_dir,
                output_dir=args.output_dir,
            )
    except StudentRuntimeExportError as error:
        print(
            json.dumps({"error": str(error), "status": "blocked"}, ensure_ascii=False)
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
