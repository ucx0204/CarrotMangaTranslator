#!/usr/bin/env python3
"""Validate and run a non-promotable crude bubble-fit gate probe.

The legacy source pack contains only 56 manually reviewed detector candidates
from a ten-page crude probe.  A versioned input-pack-set can compose multiple
independently sealed packs without copying their artifacts.  Both modes produce
evidence, not a production model, and every emitted artifact states
``promotionEligible: false``.

Production-model pixels have exactly two entry points: ``originalNative`` and
``candidateCoreMask``.  Cleaned/inpainted images are verified as sealed source
artifacts, but are structurally absent from ``TrainingSample`` and can never be
used as a feature.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import io
import importlib.metadata as importlib_metadata
import json
import math
import os
import platform
import random
import re
import subprocess
import sys
import sysconfig
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse

import numpy as np
from PIL import Image, ImageDraw, UnidentifiedImageError


TOOL_ID = "manga-translator-bubble-fit-gate-crude-probe"
SCHEMA_VERSION = 4
LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION = 5
PACK_SET_OUTPUT_SCHEMA_VERSION = 6
SUPPORTED_OUTPUT_SCHEMA_VERSIONS = frozenset(
    {
        SCHEMA_VERSION,
        LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        PACK_SET_OUTPUT_SCHEMA_VERSION,
    }
)
LEGACY_INPUT_PACK_SET_SCHEMA_VERSION = 1
INPUT_PACK_SET_SCHEMA_VERSION = 2
SUPPORTED_INPUT_PACK_SET_SCHEMA_VERSIONS = frozenset(
    {LEGACY_INPUT_PACK_SET_SCHEMA_VERSION, INPUT_PACK_SET_SCHEMA_VERSION}
)
PACK_SET_SOURCE_KINDS = frozenset(
    f"strict_input_pack_set_v{version}"
    for version in SUPPORTED_INPUT_PACK_SET_SCHEMA_VERSIONS
)
INPUT_PACK_SET_TOOL_ID = "manga-translator-bubble-fit-gate-input-pack-set"
EXPECTED_SOURCE_TOOL = "manga-translator-bubble-fit-gate-dataset"
EXPECTED_SOURCE_SCHEMA = 1
EXPECTED_CRUDE_CANDIDATES = 56
IMAGE_SIZE = 224
DEFAULT_SEED = 1729
DEFAULT_UNSAFE_FALSE_ACCEPT_TARGET = 0.05
DEFAULT_MINIMUM_COVERAGE = 0.05
DEFAULT_MINIMUM_ACCEPTED_SAFE = 1
FIVE_CLASS_UNSAFE_LOSS_WEIGHT = 2.5
FALSE_ACCEPT_CONFIDENCE = 0.95
REFERENCE_LIBRARY_INVENTORY_WORK_COUNT = 38
REFERENCE_PRODUCTION_TARGET = 0.05
BASE_PYTHON_PRODUCER_DISTRIBUTIONS = ("Pillow", "numpy")
MOBILE_PYTHON_PRODUCER_DISTRIBUTIONS = (
    "torch",
    "torchvision",
    "onnx",
    "onnxruntime",
)
PYTHON_REPOSITORY_AUTHORITY_CANDIDATES = (
    "pyproject.toml",
    "uv.lock",
    "requirements.txt",
    "requirements-lock.txt",
    "constraints.txt",
    "Pipfile.lock",
    "poetry.lock",
)
MOBILENET_V3_SMALL_IMAGENET1K_V1_URL = (
    "https://download.pytorch.org/models/mobilenet_v3_small-047dcff4.pth"
)
MOBILENET_V3_SMALL_IMAGENET1K_V1_SHA256 = (
    "047dcff4addef86ea5bc2eff13c9614dc11f47ab1160d0a71a25e7db994f4e1f"
)
MOBILENET_V3_SMALL_IMAGENET1K_V1_SIZE_BYTES = 10_306_551
PRODUCTION_INPUT_ARTIFACTS = ("originalNative", "candidateCoreMask")
FORBIDDEN_FEATURE_ARTIFACTS = (
    "cleanedNative",
    "cleanedTraining224",
    "cleanedCoreMaskOverlay",
)
DATASET_ARTIFACT_ORDER = (
    "originalNative",
    "cleanedNative",
    "originalTraining224",
    "cleanedTraining224",
    "qaSingleCandidateOverlay",
    "candidateCoreMask",
    "cleanedCoreMaskOverlay",
)
ALLOWED_LABELS = (
    "safe_opaque",
    "unsafe_translucent",
    "unsafe_open_or_illusory",
    "unsafe_mask_leak_or_clip",
    "unsafe_merged_or_wrong_region",
)
ALLOWED_CONFIDENCE = frozenset({"high", "medium", "low"})
LEGACY_MODEL_KINDS = (
    "heuristic_original_core_v1",
    "mobilenet_v3_small_frozen_head",
    "mobilenet_v3_small_light_finetune",
)
LINEAR_BINARY_MODEL_KIND = "mobilenet_v3_small_linear_binary"
LINEAR_FIVE_CLASS_MODEL_KIND = "mobilenet_v3_small_linear_5class"
MODEL_KINDS = (
    *LEGACY_MODEL_KINDS,
    LINEAR_BINARY_MODEL_KIND,
    LINEAR_FIVE_CLASS_MODEL_KIND,
)
DEFAULT_MODEL_KINDS = LEGACY_MODEL_KINDS
EXPORTABLE_MODEL_KINDS = (*LEGACY_MODEL_KINDS[1:], LINEAR_BINARY_MODEL_KIND)
MOBILE_MODEL_KINDS = MODEL_KINDS[1:]
CLASS_INDEX_BY_LABEL = {label: index for index, label in enumerate(ALLOWED_LABELS)}
SAFE_CLASS_INDEX = CLASS_INDEX_BY_LABEL["safe_opaque"]
PREDICTION_EVIDENCE_LIMITATIONS = {
    "neuralPredictionReexecution": False,
    "modelScoresProducerEvidence": True,
    "unkeyedLocalIntegrityOnly": True,
    "keyedAuthenticityEstablished": False,
    "foldCheckpointReexecutionArtifactsPresent": False,
    "dependentDecisionsAndMetricsRecomputed": True,
    "finalCandidateStateOnnxParityReexecutedWhenPresent": True,
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGENET_MEAN = np.asarray((0.485, 0.456, 0.406), dtype=np.float32)
IMAGENET_STD = np.asarray((0.229, 0.224, 0.225), dtype=np.float32)


class BubbleFitTrainingError(RuntimeError):
    """Raised when probe evidence, splitting, or training is unsafe."""


class FoldClassError(BubbleFitTrainingError):
    """Raised when a learned fold has no usable two-class training data."""


class UnsupportedMulticlassFoldError(FoldClassError):
    """Raised when a five-class training fold omits one or more classes."""

    def __init__(self, missing_classes: Sequence[str]) -> None:
        self.missing_classes = tuple(missing_classes)
        super().__init__(
            "unsupported five-class training fold; missing classes: "
            + ", ".join(self.missing_classes)
        )


@dataclass(frozen=True)
class TrainingSample:
    candidate_id: str
    ordinal: int
    selection_index: int
    source_page_id: str
    work_id: str
    work_title: str
    label: str
    safe: bool
    confidence: str
    original_path: Path
    original_sha256: str
    core_mask_path: Path
    core_mask_sha256: str
    pack_id: str | None = None
    pack_role: str | None = None
    combined_ordinal: int | None = None


@dataclass(frozen=True)
class DatasetSnapshot:
    dataset_dir: Path
    labels_path: Path
    dataset_manifest_sha256: str
    dataset_manifest_binding_sha256: str
    dataset_seal_sha256: str
    labels_sha256: str
    artifact_inventory_sha256: str
    samples: tuple[TrainingSample, ...]
    work_ids: tuple[str, ...]
    source_page_count: int
    source_work_ids: tuple[str, ...]
    production_input_binding_sha256: str

    def provenance(self) -> dict[str, Any]:
        return {
            "datasetManifestSha256": self.dataset_manifest_sha256,
            "datasetManifestBindingSha256": self.dataset_manifest_binding_sha256,
            "datasetSealSha256": self.dataset_seal_sha256,
            "artifactInventorySha256": self.artifact_inventory_sha256,
            "labelsSha256": self.labels_sha256,
            "candidateCount": len(self.samples),
            "candidateBearingWorkCount": len(self.work_ids),
            "candidateBearingWorkIds": list(self.work_ids),
            "sourcePageCount": self.source_page_count,
            "sourceWorkCount": len(self.source_work_ids),
            "sourceWorkIds": list(self.source_work_ids),
            "productionInputBindingSha256": self.production_input_binding_sha256,
        }


@dataclass(frozen=True)
class DatasetPack:
    pack_id: str
    role: str
    snapshot: DatasetSnapshot

    def provenance(self) -> dict[str, Any]:
        return {
            "packId": self.pack_id,
            "role": self.role,
            **self.snapshot.provenance(),
        }


@dataclass(frozen=True)
class DatasetPackSetSnapshot:
    input_schema_version: int
    identifier: str
    pack_set_file_sha256: str
    pack_set_canonical_sha256: str
    pack_set_binding_sha256: str
    packs: tuple[DatasetPack, ...]
    samples: tuple[TrainingSample, ...]
    work_ids: tuple[str, ...]
    source_page_count: int
    source_work_ids: tuple[str, ...]
    production_input_binding_sha256: str
    source_packs_canonical_sha256: str

    def provenance(self) -> dict[str, Any]:
        packs = [pack.provenance() for pack in self.packs]
        payload = {
            "sourceKind": f"strict_input_pack_set_v{self.input_schema_version}",
            "packSetIdentifier": self.identifier,
            "inputPackSetFileSha256": self.pack_set_file_sha256,
            "inputPackSetCanonicalSha256": self.pack_set_canonical_sha256,
            "inputPackSetBindingSha256": self.pack_set_binding_sha256,
            "sourcePacksCanonicalSha256": self.source_packs_canonical_sha256,
            "packCount": len(self.packs),
            "packs": packs,
            "candidateCount": len(self.samples),
            "candidateBearingWorkCount": len(self.work_ids),
            "candidateBearingWorkIds": list(self.work_ids),
            "sourcePageCount": self.source_page_count,
            "sourceWorkCount": len(self.source_work_ids),
            "sourceWorkIds": list(self.source_work_ids),
            "productionInputBindingSha256": self.production_input_binding_sha256,
        }
        if self.input_schema_version == INPUT_PACK_SET_SCHEMA_VERSION:
            payload["inputPackSetSchemaVersion"] = self.input_schema_version
        return payload


TrainingSnapshot = DatasetSnapshot | DatasetPackSetSnapshot


@dataclass(frozen=True)
class GroupFold:
    fold_id: str
    holdout_work_ids: tuple[str, ...]
    train_indices: tuple[int, ...]
    test_indices: tuple[int, ...]


@dataclass(frozen=True)
class EvaluationConfig:
    seed: int = DEFAULT_SEED
    unsafe_false_accept_target: float = DEFAULT_UNSAFE_FALSE_ACCEPT_TARGET
    minimum_coverage: float = DEFAULT_MINIMUM_COVERAGE
    minimum_accepted_safe: int = DEFAULT_MINIMUM_ACCEPTED_SAFE
    frozen_epochs: int = 24
    finetune_epochs: int = 12
    batch_size: int = 16
    frozen_learning_rate: float = 3e-3
    finetune_head_learning_rate: float = 8e-4
    finetune_feature_learning_rate: float = 8e-5
    weight_decay: float = 1e-4
    unsafe_loss_weight: float = 2.5
    device: str = "cpu"


@dataclass(frozen=True)
class MobileNetWeightBundle:
    state_dict: Mapping[str, Any]
    provenance: Mapping[str, Any]


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(_canonical_json_bytes(value))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise BubbleFitTrainingError(f"could not hash {path}: {exc}") from exc
    return digest.hexdigest()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BubbleFitTrainingError(f"invalid {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise BubbleFitTrainingError(f"{label} must contain a JSON object: {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
        ),
        encoding="utf-8",
        newline="\n",
    )


def _bound_canonical_json_file(repo_root: Path, relative_path: str) -> dict[str, Any]:
    path = (repo_root / relative_path).resolve()
    try:
        path.relative_to(repo_root)
    except ValueError as exc:
        raise BubbleFitTrainingError(
            f"authority file escapes repository: {relative_path}"
        ) from exc
    if not path.is_file() or path.is_symlink():
        raise BubbleFitTrainingError(f"authority file is missing: {relative_path}")
    payload = _read_json(path, f"authority file {relative_path}")
    return {
        "path": relative_path,
        "fileSha256": _sha256_file(path),
        "sizeBytes": path.stat().st_size,
        "canonicalJsonSha256": _sha256_json(payload),
    }


def _bound_repository_file(repo_root: Path, relative_path: str) -> dict[str, Any]:
    path = (repo_root / relative_path).resolve()
    try:
        path.relative_to(repo_root)
    except ValueError as exc:
        raise BubbleFitTrainingError(
            f"authority file escapes repository: {relative_path}"
        ) from exc
    if not path.is_file() or path.is_symlink():
        raise BubbleFitTrainingError(f"authority file is missing: {relative_path}")
    return {
        "path": relative_path,
        "fileSha256": _sha256_file(path),
        "sizeBytes": path.stat().st_size,
    }


def _git_execution_state(
    repo_root: Path, output_dir: Path | None = None
) -> dict[str, Any]:
    status_command = ["git", "status", "--porcelain=v1", "--untracked-files=all"]
    if output_dir is not None:
        try:
            relative_output = output_dir.resolve().relative_to(repo_root).as_posix()
        except ValueError:
            relative_output = ""
        if relative_output:
            status_command.extend(["--", ".", f":(top,exclude){relative_output}"])
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            capture_output=True,
        ).stdout.strip()
        status = subprocess.run(
            status_command,
            cwd=repo_root,
            check=True,
            capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise BubbleFitTrainingError(
            f"could not bind git execution state: {exc}"
        ) from exc
    if not re.fullmatch(rb"[0-9a-f]{40}", commit):
        raise BubbleFitTrainingError("git HEAD is not a full lowercase commit SHA")
    return {
        "commit": commit.decode("ascii"),
        "dirty": bool(status),
        "porcelainV1Sha256": _sha256_bytes(status),
        "dirtyEntryCount": len(status.splitlines()),
    }


def _normalized_distribution_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _distribution_record_authority(requested_name: str) -> dict[str, Any]:
    try:
        distribution = importlib_metadata.distribution(requested_name)
    except importlib_metadata.PackageNotFoundError as exc:
        raise BubbleFitTrainingError(
            f"required Python producer distribution is missing: {requested_name}"
        ) from exc
    files = tuple(distribution.files or ())
    record_files = {
        str(item).replace("\\", "/"): item
        for item in files
        if str(item).replace("\\", "/").endswith(".dist-info/RECORD")
    }
    if len(record_files) != 1:
        raise BubbleFitTrainingError(
            f"{requested_name} must expose exactly one installed RECORD"
        )
    record_relative_path, record_file = next(iter(record_files.items()))
    record_path = Path(distribution.locate_file(record_file)).resolve()
    if not record_path.is_file() or record_path.is_symlink():
        raise BubbleFitTrainingError(
            f"{requested_name} installed RECORD is missing or symlinked"
        )
    try:
        record_bytes = record_path.read_bytes()
        decoded = record_bytes.decode("utf-8")
        raw_rows = list(csv.reader(io.StringIO(decoded, newline="")))
    except (OSError, UnicodeError, csv.Error) as exc:
        raise BubbleFitTrainingError(
            f"could not read {requested_name} installed RECORD: {exc}"
        ) from exc
    rows: list[dict[str, Any]] = []
    for row_index, raw in enumerate(raw_rows, start=1):
        if len(raw) != 3 or not raw[0]:
            raise BubbleFitTrainingError(
                f"{requested_name} RECORD row {row_index} is invalid"
            )
        relative_path = raw[0].replace("\\", "/")
        if raw[2] and (not raw[2].isdigit() or int(raw[2]) < 0):
            raise BubbleFitTrainingError(
                f"{requested_name} RECORD size is invalid for {relative_path}"
            )
        rows.append(
            {
                "recordPath": raw[0],
                "normalizedPath": relative_path,
                "declaredHash": raw[1] or None,
                "declaredSizeBytes": int(raw[2]) if raw[2] else None,
            }
        )
    rows.sort(
        key=lambda item: (
            item["normalizedPath"],
            item["recordPath"],
            item["declaredHash"] or "",
            item["declaredSizeBytes"] if item["declaredSizeBytes"] is not None else -1,
        )
    )
    normalized_entry_count = len({row["normalizedPath"] for row in rows})
    distribution_name = distribution.metadata.get("Name")
    if not isinstance(distribution_name, str) or not distribution_name.strip():
        raise BubbleFitTrainingError(
            f"{requested_name} distribution metadata lacks a name"
        )
    return {
        "requestedName": requested_name,
        "normalizedName": _normalized_distribution_name(distribution_name),
        "distributionName": distribution_name,
        "version": distribution.version,
        "record": {
            "relativePath": record_relative_path,
            "sha256": _sha256_bytes(record_bytes),
            "sizeBytes": len(record_bytes),
            "entryCount": len(raw_rows),
            "normalizedEntryCount": normalized_entry_count,
            "equivalentNormalizedPathEntryCount": len(rows) - normalized_entry_count,
            "declaredFileContentHashCount": sum(
                row["declaredHash"] is not None for row in rows
            ),
            "canonicalEntryInventorySha256": _sha256_json(rows),
        },
    }


def _python_runtime_authority() -> dict[str, Any]:
    return {
        "implementation": platform.python_implementation(),
        "implementationName": sys.implementation.name,
        "implementationCacheTag": sys.implementation.cache_tag,
        "version": platform.python_version(),
        "versionInfo": list(sys.version_info[:5]),
        "abiFlags": getattr(sys, "abiflags", ""),
        "soabi": sysconfig.get_config_var("SOABI"),
        "extensionSuffix": sysconfig.get_config_var("EXT_SUFFIX"),
        "sysconfigPlatform": sysconfig.get_platform(),
        "system": platform.system(),
        "systemRelease": platform.release(),
        "machine": platform.machine(),
        "architectureBits": platform.architecture()[0],
        "byteorder": sys.byteorder,
    }


def _python_distribution_authority(requires_mobile: bool) -> dict[str, Any]:
    requested = list(BASE_PYTHON_PRODUCER_DISTRIBUTIONS)
    if requires_mobile:
        requested.extend(MOBILE_PYTHON_PRODUCER_DISTRIBUTIONS)
    distributions = [
        _distribution_record_authority(name)
        for name in sorted(requested, key=_normalized_distribution_name)
    ]
    return {
        "mobileProducerDependenciesRequired": requires_mobile,
        "requiredDistributionNames": requested,
        "distributions": distributions,
        "canonicalInstalledDistributionInventorySha256": _sha256_json(distributions),
        "inventoryBasis": (
            "canonicalized installed wheel RECORD declarations plus the byte-exact "
            "RECORD file; this binds the producer environment but is not a claim "
            "that the repository fully pins Python"
        ),
    }


def _python_repository_lock_authority(repo_root: Path) -> dict[str, Any]:
    files = [
        _bound_repository_file(repo_root, relative_path)
        for relative_path in PYTHON_REPOSITORY_AUTHORITY_CANDIDATES
        if (repo_root / relative_path).is_file()
        and not (repo_root / relative_path).is_symlink()
    ]
    return {
        "searchedRepositoryPaths": list(PYTHON_REPOSITORY_AUTHORITY_CANDIDATES),
        "files": files,
        "canonicalInventorySha256": _sha256_json(files),
        "repositoryFullyPinsProducerEnvironment": False,
        "interpretation": (
            "present repository Python lock or constraint files are byte-bound; "
            "absence or presence does not imply a complete producer pin"
        ),
    }


def execution_authority(
    *, requires_mobile: bool = False, output_dir: Path | None = None
) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[1]
    script_path = Path(__file__).resolve()
    if script_path.is_symlink():
        raise BubbleFitTrainingError("trainer script must not be symlinked")
    authority = {
        "trainerScript": {
            "path": "scripts/train_bubble_fit_gate.py",
            "sha256": _sha256_file(script_path),
            "sizeBytes": script_path.stat().st_size,
        },
        "git": _git_execution_state(repo_root, output_dir),
        "packageConfig": _bound_canonical_json_file(repo_root, "package.json"),
        "rendererDependencyLock": _bound_canonical_json_file(
            repo_root, "package-lock.json"
        ),
        "pythonRuntime": _python_runtime_authority(),
        "pythonProducerDistributions": _python_distribution_authority(requires_mobile),
        "pythonRepositoryLocks": _python_repository_lock_authority(repo_root),
    }
    authority["bindingSha256"] = _sha256_json(authority)
    return authority


def _assert_no_absolute_paths(value: Any, location: str = "authority") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            _assert_no_absolute_paths(item, f"{location}.{key}")
        return
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _assert_no_absolute_paths(item, f"{location}[{index}]")
        return
    if not isinstance(value, str) or "://" in value:
        return
    if Path(value).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value):
        raise BubbleFitTrainingError(f"absolute path is forbidden in {location}")


def evaluation_config_payload(config: EvaluationConfig) -> dict[str, Any]:
    return {
        "seed": config.seed,
        "unsafeFalseAcceptTarget": config.unsafe_false_accept_target,
        "minimumCoverage": config.minimum_coverage,
        "minimumAcceptedSafe": config.minimum_accepted_safe,
        "frozenEpochs": config.frozen_epochs,
        "finetuneEpochs": config.finetune_epochs,
        "batchSize": config.batch_size,
        "frozenLearningRate": config.frozen_learning_rate,
        "finetuneHeadLearningRate": config.finetune_head_learning_rate,
        "finetuneFeatureLearningRate": config.finetune_feature_learning_rate,
        "weightDecay": config.weight_decay,
        "unsafeLossWeight": config.unsafe_loss_weight,
        "device": config.device,
    }


def evaluation_config_from_payload(payload: Mapping[str, Any]) -> EvaluationConfig:
    expected_keys = set(evaluation_config_payload(EvaluationConfig()))
    if set(payload) != expected_keys:
        raise BubbleFitTrainingError("evaluation config fields are not canonical")
    device = _require_string(payload.get("device"), "config.device")
    if device not in {"cpu", "cuda", "auto"}:
        raise BubbleFitTrainingError("config.device is invalid")
    config = EvaluationConfig(
        seed=_require_int(payload.get("seed"), "config.seed"),
        unsafe_false_accept_target=_require_float(
            payload.get("unsafeFalseAcceptTarget"),
            "config.unsafeFalseAcceptTarget",
        ),
        minimum_coverage=_require_float(
            payload.get("minimumCoverage"), "config.minimumCoverage"
        ),
        minimum_accepted_safe=_require_int(
            payload.get("minimumAcceptedSafe"), "config.minimumAcceptedSafe", 1
        ),
        frozen_epochs=_require_int(
            payload.get("frozenEpochs"), "config.frozenEpochs", 1
        ),
        finetune_epochs=_require_int(
            payload.get("finetuneEpochs"), "config.finetuneEpochs", 1
        ),
        batch_size=_require_int(payload.get("batchSize"), "config.batchSize", 1),
        frozen_learning_rate=_require_float(
            payload.get("frozenLearningRate"), "config.frozenLearningRate"
        ),
        finetune_head_learning_rate=_require_float(
            payload.get("finetuneHeadLearningRate"),
            "config.finetuneHeadLearningRate",
        ),
        finetune_feature_learning_rate=_require_float(
            payload.get("finetuneFeatureLearningRate"),
            "config.finetuneFeatureLearningRate",
        ),
        weight_decay=_require_float(payload.get("weightDecay"), "config.weightDecay"),
        unsafe_loss_weight=_require_float(
            payload.get("unsafeLossWeight"), "config.unsafeLossWeight"
        ),
        device=device,
    )
    _validate_evaluation_config(config)
    if _canonical_json_bytes(
        evaluation_config_payload(config)
    ) != _canonical_json_bytes(payload):
        raise BubbleFitTrainingError("evaluation config values are not canonical")
    return config


def run_configuration_payload(
    *,
    config_payload: Mapping[str, Any],
    model_kinds: Sequence[str],
    export_final_model: str | None,
    input_contract: Mapping[str, Any],
    schema_version: int = SCHEMA_VERSION,
    input_pack_set_canonical_sha256: str | None = None,
    input_pack_set_schema_version: int | None = None,
    cross_pack_evaluation: bool = False,
) -> dict[str, Any]:
    payload = {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "modelKinds": list(model_kinds),
        "exportFinalModel": export_final_model,
        "evaluationConfigCanonicalSha256": _sha256_json(config_payload),
        "inputContractCanonicalSha256": _sha256_json(input_contract),
    }
    if input_pack_set_canonical_sha256 is not None:
        if (
            input_pack_set_schema_version
            not in SUPPORTED_INPUT_PACK_SET_SCHEMA_VERSIONS
        ):
            raise BubbleFitTrainingError(
                "run configuration input pack-set schema is unsupported"
            )
        input_mode = f"strict_input_pack_set_v{input_pack_set_schema_version}"
        evaluation_role = (
            "exploratory work-disjoint directional diagnostics only"
            if input_pack_set_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION
            else (
                "exploratory source-work-unseen incremental-pack external "
                "diagnostics only"
            )
        )
        payload.update(
            {
                "inputMode": input_mode,
                "inputPackSetCanonicalSha256": input_pack_set_canonical_sha256,
                "crossPackEvaluation": cross_pack_evaluation,
                "crossPackEvaluationRole": evaluation_role,
            }
        )
    elif input_pack_set_schema_version is not None:
        raise BubbleFitTrainingError(
            "run configuration pack-set schema lacks a canonical pack-set binding"
        )
    return payload


def _output_schema_version(snapshot: TrainingSnapshot) -> int:
    if isinstance(snapshot, DatasetPackSetSnapshot):
        return PACK_SET_OUTPUT_SCHEMA_VERSION
    return SCHEMA_VERSION


def _is_pack_set_output_schema(schema_version: int) -> bool:
    return schema_version in {
        LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        PACK_SET_OUTPUT_SCHEMA_VERSION,
    }


def _has_recomputable_threshold_evidence(schema_version: int) -> bool:
    return schema_version == PACK_SET_OUTPUT_SCHEMA_VERSION


def _prediction_evidence_limitations_payload() -> dict[str, bool]:
    return dict(PREDICTION_EVIDENCE_LIMITATIONS)


def _schema_compatibility_contract() -> dict[str, Any]:
    return {
        "currentPackSetOutputSchemaVersion": PACK_SET_OUTPUT_SCHEMA_VERSION,
        "legacyStructuralReaderSchemaVersions": [
            SCHEMA_VERSION,
            LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        ],
        "legacyCompatibilityScope": "structural reader compatibility only",
        "historicalProducerByteAuthorityCompatibility": False,
        "reason": (
            "historical v4/v5 artifacts bind their original trainer script, git "
            "state, runtime, and dependency authority; validation under a changed "
            "current producer is intentionally allowed to fail exact "
            "executionAuthority even when the legacy structure is understood"
        ),
    }


def _current_schema_contract_fields(schema_version: int) -> dict[str, Any]:
    if not _has_recomputable_threshold_evidence(schema_version):
        return {}
    return {
        **_prediction_evidence_limitations_payload(),
        "predictionEvidenceInterpretation": (
            "OOF/cross neural model scores are unkeyed producer evidence. The "
            "validator recomputes dependent thresholds, decisions, and metrics, but "
            "cannot establish authenticity against a malicious coherent reseal "
            "without saved fold states or keyed attestation. A future fold-checkpoint "
            "inventory hook is reserved but v6 emits no such checkpoints."
        ),
        "schemaCompatibility": _schema_compatibility_contract(),
    }


def build_authority_bindings(
    *,
    snapshot: TrainingSnapshot,
    config: EvaluationConfig,
    model_kinds: Sequence[str],
    export_final_model: str | None,
    split_plan_sha256: str,
    oof_predictions_sha256: str,
    authority: Mapping[str, Any],
    confirmatory_contract: Mapping[str, Any],
    cross_pack_plan_sha256: str | None = None,
    cross_pack_predictions_sha256: str | None = None,
) -> dict[str, Any]:
    config_payload = evaluation_config_payload(config)
    input_contract = production_input_contract()
    schema_version = _output_schema_version(snapshot)
    pack_set_sha = (
        snapshot.pack_set_canonical_sha256
        if isinstance(snapshot, DatasetPackSetSnapshot)
        else None
    )
    run_configuration = run_configuration_payload(
        config_payload=config_payload,
        model_kinds=model_kinds,
        export_final_model=export_final_model,
        input_contract=input_contract,
        schema_version=schema_version,
        input_pack_set_canonical_sha256=pack_set_sha,
        input_pack_set_schema_version=(
            snapshot.input_schema_version
            if isinstance(snapshot, DatasetPackSetSnapshot)
            else None
        ),
        cross_pack_evaluation=isinstance(snapshot, DatasetPackSetSnapshot),
    )
    if isinstance(snapshot, DatasetPackSetSnapshot):
        if cross_pack_plan_sha256 is None or cross_pack_predictions_sha256 is None:
            raise BubbleFitTrainingError(
                "pack-set authority lacks cross-pack artifacts"
            )
        source_bindings = {
            "inputPackSetFileSha256": snapshot.pack_set_file_sha256,
            "inputPackSetCanonicalSha256": snapshot.pack_set_canonical_sha256,
            "inputPackSetBindingSha256": snapshot.pack_set_binding_sha256,
            "sourcePacksCanonicalSha256": snapshot.source_packs_canonical_sha256,
            "productionInputBindingSha256": snapshot.production_input_binding_sha256,
            "crossPackPlanSha256": cross_pack_plan_sha256,
            "crossPackPredictionsSha256": cross_pack_predictions_sha256,
        }
    else:
        source_bindings = {
            "datasetManifestSha256": snapshot.dataset_manifest_sha256,
            "datasetManifestBindingSha256": snapshot.dataset_manifest_binding_sha256,
            "datasetSealSha256": snapshot.dataset_seal_sha256,
            "artifactInventorySha256": snapshot.artifact_inventory_sha256,
            "labelsSha256": snapshot.labels_sha256,
            "productionInputBindingSha256": snapshot.production_input_binding_sha256,
        }
    bindings = {
        **source_bindings,
        "splitPlanSha256": split_plan_sha256,
        "oofPredictionsSha256": oof_predictions_sha256,
        "evaluationConfigCanonicalSha256": _sha256_json(config_payload),
        "inputContractCanonicalSha256": _sha256_json(input_contract),
        "runConfigurationCanonicalSha256": _sha256_json(run_configuration),
        "confirmatoryAuditContractCanonicalSha256": _sha256_json(confirmatory_contract),
        "trainerScriptSha256": authority["trainerScript"]["sha256"],
        "gitCommit": authority["git"]["commit"],
        "gitDirty": authority["git"]["dirty"],
        "gitPorcelainV1Sha256": authority["git"]["porcelainV1Sha256"],
        "packageConfigCanonicalSha256": authority["packageConfig"][
            "canonicalJsonSha256"
        ],
        "rendererDependencyLockCanonicalSha256": authority["rendererDependencyLock"][
            "canonicalJsonSha256"
        ],
        "pythonRuntimeCanonicalSha256": _sha256_json(authority["pythonRuntime"]),
        "pythonProducerDistributionsCanonicalSha256": _sha256_json(
            authority["pythonProducerDistributions"]
        ),
        "pythonRepositoryLocksCanonicalSha256": _sha256_json(
            authority["pythonRepositoryLocks"]
        ),
    }
    bindings["bindingSha256"] = _sha256_json(bindings)
    _assert_no_absolute_paths(bindings)
    return bindings


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BubbleFitTrainingError(f"missing or empty {field}")
    return value.strip()


def _require_int(value: Any, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise BubbleFitTrainingError(f"{field} must be an integer >= {minimum}")
    return value


def _require_float(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BubbleFitTrainingError(f"{field} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise BubbleFitTrainingError(f"{field} must be finite")
    return number


def _require_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise BubbleFitTrainingError(f"{field} must be a lowercase SHA-256")
    return value


def _validated_class_probability_vector(value: Any, field: str) -> np.ndarray:
    if not isinstance(value, dict) or set(value) != set(ALLOWED_LABELS):
        raise BubbleFitTrainingError(f"{field} class probability keys are invalid")
    values: list[float] = []
    for label in ALLOWED_LABELS:
        raw = value.get(label)
        if (
            isinstance(raw, bool)
            or not isinstance(raw, (int, float))
            or not math.isfinite(float(raw))
            or not 0.0 <= float(raw) <= 1.0
        ):
            raise BubbleFitTrainingError(f"{field}.{label} probability is invalid")
        values.append(float(raw))
    result = np.asarray(values, dtype=np.float64)
    if not math.isclose(float(result.sum()), 1.0, rel_tol=0.0, abs_tol=1e-8):
        raise BubbleFitTrainingError(f"{field} probabilities do not sum to one")
    return result


def _manifest_without_binding(manifest: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(manifest)
    value.pop("manifestBindingSha256", None)
    return value


def _safe_artifact_path(dataset_dir: Path, raw: Any, field: str) -> Path:
    text = _require_string(raw, field)
    relative = Path(text)
    if relative.is_absolute() or ".." in relative.parts:
        raise BubbleFitTrainingError(f"unsafe {field}: {text}")
    path = (dataset_dir / relative).resolve()
    try:
        path.relative_to(dataset_dir)
    except ValueError as exc:
        raise BubbleFitTrainingError(f"{field} escapes the dataset: {text}") from exc
    if not path.is_file() or path.is_symlink():
        raise BubbleFitTrainingError(f"missing or symlinked {field}: {path}")
    return path


def _pixel_sha256(image: Image.Image) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(str(image.width).encode("ascii"))
    digest.update(b"x")
    digest.update(str(image.height).encode("ascii"))
    digest.update(b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def _open_bound_image(
    path: Path,
    binding: Mapping[str, Any],
    field: str,
) -> Image.Image:
    expected_sha = _require_sha256(binding.get("sha256"), f"{field}.sha256")
    if _sha256_file(path) != expected_sha:
        raise BubbleFitTrainingError(f"{field} file SHA-256 mismatch: {path}")
    expected_bytes = _require_int(binding.get("sizeBytes"), f"{field}.sizeBytes", 1)
    if path.stat().st_size != expected_bytes:
        raise BubbleFitTrainingError(f"{field} byte-size mismatch: {path}")
    try:
        with Image.open(path) as opened:
            opened.load()
            if opened.format != "PNG" or binding.get("format") != "PNG":
                raise BubbleFitTrainingError(f"{field} must be a PNG: {path}")
            image = opened.copy()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise BubbleFitTrainingError(
            f"could not decode {field}: {path}: {exc}"
        ) from exc
    expected_size = (
        _require_int(binding.get("width"), f"{field}.width", 1),
        _require_int(binding.get("height"), f"{field}.height", 1),
    )
    if image.size != expected_size or image.mode != binding.get("mode"):
        image.close()
        raise BubbleFitTrainingError(f"{field} image contract mismatch: {path}")
    if _pixel_sha256(image) != _require_sha256(
        binding.get("pixelSha256"), f"{field}.pixelSha256"
    ):
        image.close()
        raise BubbleFitTrainingError(f"{field} pixel SHA-256 mismatch: {path}")
    return image


def _letterbox_rgb(image: Image.Image) -> Image.Image:
    if image.mode != "RGB" or image.width <= 0 or image.height <= 0:
        raise BubbleFitTrainingError("RGB letterbox input is invalid")
    scale = min(IMAGE_SIZE / image.width, IMAGE_SIZE / image.height)
    size = (
        max(1, min(IMAGE_SIZE, round(image.width * scale))),
        max(1, min(IMAGE_SIZE, round(image.height * scale))),
    )
    resized = image.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (255, 255, 255))
    try:
        canvas.paste(
            resized,
            ((IMAGE_SIZE - size[0]) // 2, (IMAGE_SIZE - size[1]) // 2),
        )
    finally:
        resized.close()
    return canvas


def _letterbox_mask(image: Image.Image) -> Image.Image:
    if image.mode != "L" or image.width <= 0 or image.height <= 0:
        raise BubbleFitTrainingError("mask letterbox input is invalid")
    scale = min(IMAGE_SIZE / image.width, IMAGE_SIZE / image.height)
    size = (
        max(1, min(IMAGE_SIZE, round(image.width * scale))),
        max(1, min(IMAGE_SIZE, round(image.height * scale))),
    )
    resized = image.resize(size, Image.Resampling.NEAREST)
    canvas = Image.new("L", (IMAGE_SIZE, IMAGE_SIZE), 0)
    try:
        canvas.paste(
            resized,
            ((IMAGE_SIZE - size[0]) // 2, (IMAGE_SIZE - size[1]) // 2),
        )
    finally:
        resized.close()
    return canvas


def _assert_exact_filled_rectangle_mask(
    mask: Image.Image,
    bbox: Sequence[int],
    candidate_id: str,
) -> None:
    if mask.mode != "L" or len(bbox) != 4:
        raise BubbleFitTrainingError(
            f"{candidate_id} core mask rectangle contract is invalid"
        )
    left, top, right, bottom = (int(value) for value in bbox)
    if not (0 <= left < right <= mask.width and 0 <= top < bottom <= mask.height):
        raise BubbleFitTrainingError(
            f"{candidate_id} core mask rectangle is outside the native crop"
        )
    expected = Image.new("L", mask.size, 0)
    draw = ImageDraw.Draw(expected)
    draw.rectangle((left, top, right - 1, bottom - 1), fill=255)
    try:
        if mask.tobytes() != expected.tobytes():
            raise BubbleFitTrainingError(
                f"{candidate_id} core mask is not the exact metadata-bbox filled rectangle"
            )
    finally:
        expected.close()


def _validate_artifact_binding(
    dataset_dir: Path,
    candidate_id: str,
    kind: str,
    raw: Any,
) -> tuple[Path, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise BubbleFitTrainingError(f"{candidate_id}.{kind} must be an object")
    expected_keys = {
        "format",
        "height",
        "mode",
        "path",
        "pixelSha256",
        "sha256",
        "sizeBytes",
        "width",
    }
    if set(raw) != expected_keys:
        raise BubbleFitTrainingError(
            f"{candidate_id}.{kind} has unexpected binding fields"
        )
    path = _safe_artifact_path(dataset_dir, raw.get("path"), f"{candidate_id}.{kind}")
    image = _open_bound_image(path, raw, f"{candidate_id}.{kind}")
    image.close()
    binding = dict(raw)
    return path, binding


def _validate_source_manifest(
    dataset_dir: Path,
    *,
    expected_candidate_count: int,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
    manifest_path = dataset_dir / "manifest.json"
    seal_path = dataset_dir / "dataset-seal.json"
    if not manifest_path.is_file() or not seal_path.is_file():
        raise BubbleFitTrainingError("dataset manifest/seal is missing")
    manifest = _read_json(manifest_path, "source dataset manifest")
    seal = _read_json(seal_path, "source dataset seal")
    if (
        manifest.get("schemaVersion") != EXPECTED_SOURCE_SCHEMA
        or manifest.get("toolId") != EXPECTED_SOURCE_TOOL
    ):
        raise BubbleFitTrainingError("unsupported source dataset schema/tool")
    label_spec = manifest.get("labels")
    if not isinstance(label_spec, dict) or label_spec.get("present") is not False:
        raise BubbleFitTrainingError("source dataset must remain unlabeled")
    mask_spec = manifest.get("maskSpec")
    if (
        not isinstance(mask_spec, dict)
        or mask_spec.get("exactProductionFloodParity") is not False
    ):
        raise BubbleFitTrainingError("source core mask provenance is missing")
    binding_sha = _require_sha256(
        manifest.get("manifestBindingSha256"), "manifestBindingSha256"
    )
    if _sha256_json(_manifest_without_binding(manifest)) != binding_sha:
        raise BubbleFitTrainingError("source manifest binding SHA-256 mismatch")
    manifest_sha = _sha256_file(manifest_path)
    candidates = manifest.get("candidates")
    pages = manifest.get("pages")
    counts = manifest.get("counts")
    if not isinstance(candidates, list) or not isinstance(pages, list):
        raise BubbleFitTrainingError("source manifest candidates/pages must be arrays")
    if len(candidates) != expected_candidate_count:
        raise BubbleFitTrainingError(
            f"expected {expected_candidate_count} candidates, got {len(candidates)}"
        )
    if not isinstance(counts, dict) or counts.get("bubbleCandidates") != len(
        candidates
    ):
        raise BubbleFitTrainingError("source candidate count is inconsistent")
    page_by_index: dict[int, Mapping[str, Any]] = {}
    for raw_page in pages:
        if not isinstance(raw_page, dict):
            raise BubbleFitTrainingError("source page record must be an object")
        index = _require_int(raw_page.get("selectionIndex"), "page.selectionIndex")
        if index in page_by_index:
            raise BubbleFitTrainingError(f"duplicate page selectionIndex: {index}")
        page_by_index[index] = raw_page

    candidate_by_id: dict[str, dict[str, Any]] = {}
    artifact_inventory: list[dict[str, Any]] = []
    expected_files = {"manifest.json", "dataset-seal.json"}
    artifact_count = 0
    for position, raw_candidate in enumerate(candidates, start=1):
        if not isinstance(raw_candidate, dict):
            raise BubbleFitTrainingError(f"candidate {position} is not an object")
        candidate_id = _require_string(
            raw_candidate.get("id"), f"candidate {position}.id"
        )
        if candidate_id in candidate_by_id:
            raise BubbleFitTrainingError(f"duplicate candidate id: {candidate_id}")
        selection_index = _require_int(
            raw_candidate.get("selectionIndex"), f"{candidate_id}.selectionIndex"
        )
        page = page_by_index.get(selection_index)
        if page is None:
            raise BubbleFitTrainingError(f"{candidate_id} references an unknown page")
        for field in ("sourcePageId", "sourcePageSha256", "workId", "workTitle"):
            if raw_candidate.get(field) != page.get(field):
                raise BubbleFitTrainingError(
                    f"{candidate_id}.{field} disagrees with its page provenance"
                )
        artifacts = raw_candidate.get("artifacts")
        if not isinstance(artifacts, dict) or set(artifacts) != set(
            DATASET_ARTIFACT_ORDER
        ):
            raise BubbleFitTrainingError(f"{candidate_id} artifact set is incomplete")
        validated: dict[str, tuple[Path, dict[str, Any]]] = {}
        for kind in DATASET_ARTIFACT_ORDER:
            path, artifact = _validate_artifact_binding(
                dataset_dir, candidate_id, kind, artifacts.get(kind)
            )
            relative = path.relative_to(dataset_dir).as_posix()
            if relative in expected_files:
                raise BubbleFitTrainingError(
                    f"duplicate dataset file binding: {relative}"
                )
            expected_files.add(relative)
            validated[kind] = (path, artifact)
            artifact_inventory.append(
                {
                    "path": artifact["path"],
                    "sha256": artifact["sha256"],
                    "pixelSha256": artifact["pixelSha256"],
                    "sizeBytes": artifact["sizeBytes"],
                }
            )
            artifact_count += 1
        original_path, original_binding = validated["originalNative"]
        mask_path, mask_binding = validated["candidateCoreMask"]
        training_path, training_binding = validated["originalTraining224"]
        original = _open_bound_image(
            original_path, original_binding, f"{candidate_id}.originalNative"
        )
        mask = _open_bound_image(
            mask_path, mask_binding, f"{candidate_id}.candidateCoreMask"
        )
        training = _open_bound_image(
            training_path,
            training_binding,
            f"{candidate_id}.originalTraining224",
        )
        try:
            if original.mode != "RGB" or mask.mode != "L" or original.size != mask.size:
                raise BubbleFitTrainingError(
                    f"{candidate_id} original/core-mask native contract mismatch"
                )
            if training.mode != "RGB" or training.size != (IMAGE_SIZE, IMAGE_SIZE):
                raise BubbleFitTrainingError(
                    f"{candidate_id} original training image is not RGB 224x224"
                )
            values = set(mask.getdata())
            if not values.issubset({0, 255}) or 255 not in values:
                raise BubbleFitTrainingError(
                    f"{candidate_id} core mask is not binary/nonempty"
                )
            core = raw_candidate.get("candidateCoreMask")
            if (
                not isinstance(core, dict)
                or core.get("exactProductionFloodParity") is not False
            ):
                raise BubbleFitTrainingError(
                    f"{candidate_id} core-mask provenance is invalid"
                )
            local_bbox = core.get("cropLocalBboxPx")
            if not isinstance(local_bbox, list) or len(local_bbox) != 4:
                raise BubbleFitTrainingError(
                    f"{candidate_id} local core bbox is invalid"
                )
            expected_bbox = tuple(
                _require_int(value, "core bbox") for value in local_bbox
            )
            _assert_exact_filled_rectangle_mask(mask, expected_bbox, candidate_id)
            recreated = _letterbox_rgb(original)
            try:
                if _pixel_sha256(recreated) != _pixel_sha256(training):
                    raise BubbleFitTrainingError(
                        f"{candidate_id} originalTraining224 is not the exact native recrop"
                    )
            finally:
                recreated.close()
        finally:
            original.close()
            mask.close()
            training.close()
        raw_candidate = dict(raw_candidate)
        raw_candidate["_validatedOriginalPath"] = str(original_path)
        raw_candidate["_validatedMaskPath"] = str(mask_path)
        candidate_by_id[candidate_id] = raw_candidate

    inventory_sha = _sha256_json(artifact_inventory)
    if manifest.get("artifactInventorySha256") != inventory_sha:
        raise BubbleFitTrainingError("source artifact inventory SHA-256 mismatch")
    if counts.get("artifacts") != artifact_count:
        raise BubbleFitTrainingError("source artifact count is inconsistent")
    if seal.get("artifactCount") != artifact_count or seal.get("candidateCount") != len(
        candidates
    ):
        raise BubbleFitTrainingError("source seal counts are inconsistent")
    expected_seal = {
        "schemaVersion": EXPECTED_SOURCE_SCHEMA,
        "toolId": EXPECTED_SOURCE_TOOL,
        "manifestFile": "manifest.json",
        "manifestSha256": manifest_sha,
        "manifestBindingSha256": binding_sha,
        "artifactInventorySha256": inventory_sha,
        "sourceReportSha256": manifest.get("sourceRun", {}).get("sha256"),
        "detectorModelSha256": manifest.get("detector", {}).get("sha256"),
        "candidateCount": len(candidates),
        "artifactCount": artifact_count,
    }
    if seal != expected_seal:
        raise BubbleFitTrainingError("source dataset seal does not bind the manifest")
    actual_files = {
        path.relative_to(dataset_dir).as_posix()
        for path in dataset_dir.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_files:
        raise BubbleFitTrainingError(
            "source dataset file inventory differs from its sealed artifact inventory"
        )
    return manifest, seal, candidate_by_id


def _validate_labels(
    labels_path: Path,
    manifest: Mapping[str, Any],
    candidates: Mapping[str, Mapping[str, Any]],
) -> tuple[dict[str, Any], dict[str, Mapping[str, Any]]]:
    labels = _read_json(labels_path, "manual labels")
    if labels.get("schemaVersion") != 1:
        raise BubbleFitTrainingError("manual label schemaVersion must be 1")
    if labels.get("classes") != list(ALLOWED_LABELS):
        raise BubbleFitTrainingError(
            "manual label classes do not match the allowed policy"
        )
    source = labels.get("sourceDataset")
    if not isinstance(source, dict):
        raise BubbleFitTrainingError("manual labels sourceDataset is missing")
    if source.get("manifestSha256") != manifest.get("_actualSha256"):
        raise BubbleFitTrainingError("manual labels bind a different dataset manifest")
    if source.get("manifestBindingSha256") != manifest.get("manifestBindingSha256"):
        raise BubbleFitTrainingError("manual labels bind a different manifest payload")
    review = labels.get("review")
    if not isinstance(review, dict) or not isinstance(review.get("safePolicy"), str):
        raise BubbleFitTrainingError("manual label review policy is missing")
    annotations = labels.get("annotations")
    if not isinstance(annotations, list) or len(annotations) != len(candidates):
        raise BubbleFitTrainingError(
            "manual labels must cover every candidate exactly once"
        )
    candidate_order = [item.get("id") for item in manifest.get("candidates", [])]
    annotation_by_id: dict[str, Mapping[str, Any]] = {}
    for index, raw in enumerate(annotations, start=1):
        if not isinstance(raw, dict):
            raise BubbleFitTrainingError(f"annotation {index} is not an object")
        if _require_int(raw.get("ordinal"), f"annotation {index}.ordinal", 1) != index:
            raise BubbleFitTrainingError("manual label ordinals must be contiguous")
        candidate_id = _require_string(
            raw.get("candidateId"), f"annotation {index}.candidateId"
        )
        if candidate_id in annotation_by_id or candidate_id not in candidates:
            raise BubbleFitTrainingError(
                f"duplicate or unknown manual-label candidate: {candidate_id}"
            )
        if candidate_order[index - 1] != candidate_id:
            raise BubbleFitTrainingError("manual labels must preserve candidate order")
        candidate = candidates[candidate_id]
        if _require_int(raw.get("page"), f"{candidate_id}.page", 1) != (
            int(candidate["selectionIndex"]) + 1
        ):
            raise BubbleFitTrainingError(f"{candidate_id} label page is inconsistent")
        label = _require_string(raw.get("label"), f"{candidate_id}.label")
        if label not in ALLOWED_LABELS:
            raise BubbleFitTrainingError(
                f"{candidate_id} has an unsupported label: {label}"
            )
        safe = raw.get("safeForBubbleFit")
        if type(safe) is not bool:  # bool must not accept integers
            raise BubbleFitTrainingError(
                f"{candidate_id}.safeForBubbleFit must be boolean"
            )
        if safe != (label == "safe_opaque"):
            raise BubbleFitTrainingError(
                f"{candidate_id} label/safeForBubbleFit semantics disagree"
            )
        confidence = _require_string(
            raw.get("confidence"), f"{candidate_id}.confidence"
        )
        if confidence not in ALLOWED_CONFIDENCE:
            raise BubbleFitTrainingError(f"{candidate_id} confidence is unsupported")
        _require_string(raw.get("notes"), f"{candidate_id}.notes")
        annotation_by_id[candidate_id] = raw
    if set(annotation_by_id) != set(candidates):
        raise BubbleFitTrainingError("manual labels are not a candidate bijection")
    return labels, annotation_by_id


def load_training_snapshot(
    dataset_dir: Path,
    labels_path: Path,
    *,
    expected_candidate_count: int = EXPECTED_CRUDE_CANDIDATES,
) -> DatasetSnapshot:
    dataset_dir = Path(dataset_dir).resolve()
    labels_path = Path(labels_path).resolve()
    if not dataset_dir.is_dir() or not labels_path.is_file():
        raise BubbleFitTrainingError("dataset directory or manual labels are missing")
    manifest, _seal, candidates = _validate_source_manifest(
        dataset_dir,
        expected_candidate_count=expected_candidate_count,
    )
    manifest_path = dataset_dir / "manifest.json"
    manifest["_actualSha256"] = _sha256_file(manifest_path)
    labels, annotation_by_id = _validate_labels(labels_path, manifest, candidates)
    del labels
    samples: list[TrainingSample] = []
    for candidate in manifest["candidates"]:
        candidate_id = str(candidate["id"])
        validated = candidates[candidate_id]
        annotation = annotation_by_id[candidate_id]
        artifacts = candidate["artifacts"]
        samples.append(
            TrainingSample(
                candidate_id=candidate_id,
                ordinal=int(annotation["ordinal"]),
                selection_index=int(candidate["selectionIndex"]),
                source_page_id=str(candidate["sourcePageId"]),
                work_id=str(candidate["workId"]),
                work_title=str(candidate["workTitle"]),
                label=str(annotation["label"]),
                safe=bool(annotation["safeForBubbleFit"]),
                confidence=str(annotation["confidence"]),
                original_path=Path(str(validated["_validatedOriginalPath"])),
                original_sha256=str(artifacts["originalNative"]["sha256"]),
                core_mask_path=Path(str(validated["_validatedMaskPath"])),
                core_mask_sha256=str(artifacts["candidateCoreMask"]["sha256"]),
            )
        )
    work_ids = tuple(sorted({sample.work_id for sample in samples}))
    source_pages = manifest.get("pages")
    if not isinstance(source_pages, list) or not source_pages:
        raise BubbleFitTrainingError("source page provenance is empty")
    source_work_ids = tuple(
        sorted(
            {
                _require_string(page.get("workId"), "page.workId")
                for page in source_pages
                if isinstance(page, Mapping)
            }
        )
    )
    if len(source_work_ids) == 0 or any(
        not isinstance(page, Mapping) for page in source_pages
    ):
        raise BubbleFitTrainingError("source page work provenance is invalid")
    input_binding = [
        {
            "candidateId": sample.candidate_id,
            "workId": sample.work_id,
            "originalNativeSha256": sample.original_sha256,
            "candidateCoreMaskSha256": sample.core_mask_sha256,
        }
        for sample in samples
    ]
    return DatasetSnapshot(
        dataset_dir=dataset_dir,
        labels_path=labels_path,
        dataset_manifest_sha256=_sha256_file(manifest_path),
        dataset_manifest_binding_sha256=str(manifest["manifestBindingSha256"]),
        dataset_seal_sha256=_sha256_file(dataset_dir / "dataset-seal.json"),
        labels_sha256=_sha256_file(labels_path),
        artifact_inventory_sha256=str(manifest["artifactInventorySha256"]),
        samples=tuple(samples),
        work_ids=work_ids,
        source_page_count=len(source_pages),
        source_work_ids=source_work_ids,
        production_input_binding_sha256=_sha256_json(input_binding),
    )


def _safe_repository_input_path(
    repository_root: Path,
    raw: Any,
    field: str,
    *,
    directory: bool,
) -> Path:
    text = _require_string(raw, field)
    if "\\" in text:
        raise BubbleFitTrainingError(f"{field} must use canonical POSIX separators")
    relative = Path(text)
    if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != text:
        raise BubbleFitTrainingError(f"unsafe repository-relative {field}: {text}")
    repository_root = repository_root.resolve()
    raw_cursor = repository_root
    for part in relative.parts:
        raw_cursor = raw_cursor / part
        if raw_cursor.is_symlink():
            raise BubbleFitTrainingError(f"symlink is forbidden in {field}: {text}")
    path = (repository_root / relative).resolve()
    try:
        resolved_relative = path.relative_to(repository_root)
    except ValueError as exc:
        raise BubbleFitTrainingError(f"{field} escapes the repository: {text}") from exc
    cursor = repository_root
    for part in resolved_relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise BubbleFitTrainingError(f"symlink is forbidden in {field}: {text}")
    exists = path.is_dir() if directory else path.is_file()
    if not exists:
        kind = "directory" if directory else "file"
        raise BubbleFitTrainingError(f"{field} {kind} is missing: {text}")
    return path


def _pack_compatibility_contract(manifest: Mapping[str, Any]) -> dict[str, Any]:
    detector = manifest.get("detector")
    if not isinstance(detector, Mapping):
        raise BubbleFitTrainingError("source detector contract is missing")
    portable_detector = dict(detector)
    portable_detector.pop("path", None)
    return {
        "sourceSchemaVersion": manifest.get("schemaVersion"),
        "sourceToolId": manifest.get("toolId"),
        "cropSpec": manifest.get("cropSpec"),
        "maskSpec": manifest.get("maskSpec"),
        "labels": manifest.get("labels"),
        "detector": portable_detector,
    }


def _pack_set_without_binding(payload: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(payload)
    value.pop("bindingSha256", None)
    return value


def load_training_pack_set_snapshot(
    pack_set_path: Path,
    *,
    repository_root: Path | None = None,
) -> DatasetPackSetSnapshot:
    raw_path = Path(pack_set_path)
    if raw_path.is_symlink():
        raise BubbleFitTrainingError("input pack-set file must not be symlinked")
    pack_set_path = raw_path.resolve()
    if not pack_set_path.is_file():
        raise BubbleFitTrainingError("input pack-set file is missing")
    if repository_root is None:
        repository_root = Path(__file__).resolve().parents[1]
    repository_root = Path(repository_root).resolve()
    unresolved_absolute = raw_path.absolute()
    try:
        unresolved_relative = unresolved_absolute.relative_to(repository_root)
    except ValueError as exc:
        raise BubbleFitTrainingError(
            "input pack-set must be inside the repository"
        ) from exc
    cursor = repository_root
    for part in unresolved_relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise BubbleFitTrainingError(
                "input pack-set path must not contain symlinks"
            )
    try:
        pack_set_path.relative_to(repository_root)
    except ValueError as exc:
        raise BubbleFitTrainingError(
            "input pack-set must resolve inside the repository"
        ) from exc
    payload = _read_json(pack_set_path, "input pack-set")
    expected_top_level = {
        "schemaVersion",
        "toolId",
        "identifier",
        "packs",
        "bindingSha256",
    }
    if set(payload) != expected_top_level:
        raise BubbleFitTrainingError("input pack-set fields are not canonical")
    input_schema_version = payload.get("schemaVersion")
    if (
        isinstance(input_schema_version, bool)
        or not isinstance(input_schema_version, int)
        or input_schema_version not in SUPPORTED_INPUT_PACK_SET_SCHEMA_VERSIONS
        or payload.get("toolId") != INPUT_PACK_SET_TOOL_ID
    ):
        raise BubbleFitTrainingError("unsupported input pack-set schema/tool")
    identifier = _require_string(payload.get("identifier"), "packSet.identifier")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", identifier):
        raise BubbleFitTrainingError("packSet.identifier is not canonical")
    binding = _require_sha256(payload.get("bindingSha256"), "packSet.bindingSha256")
    if _sha256_json(_pack_set_without_binding(payload)) != binding:
        raise BubbleFitTrainingError("input pack-set canonical binding mismatch")
    raw_packs = payload.get("packs")
    if not isinstance(raw_packs, list):
        raise BubbleFitTrainingError("input pack-set packs must be an ordered list")
    if (
        input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION
        and len(raw_packs) != 2
    ):
        raise BubbleFitTrainingError(
            "input pack-set v1 requires exactly old and new packs"
        )
    if input_schema_version == INPUT_PACK_SET_SCHEMA_VERSION and len(raw_packs) < 3:
        raise BubbleFitTrainingError(
            "input pack-set v2 requires at least three ordered packs"
        )
    expected_pack_fields = {
        "packId",
        "role",
        "datasetDir",
        "labelsFile",
        "expectedCandidates",
        "datasetManifestSha256",
        "datasetManifestBindingSha256",
        "datasetSealSha256",
        "artifactInventorySha256",
        "labelsSha256",
    }
    if any(
        not isinstance(item, dict) or set(item) != expected_pack_fields
        for item in raw_packs
    ):
        raise BubbleFitTrainingError("input pack-set child fields are not canonical")
    pack_ids = [
        _require_string(item.get("packId"), f"packs[{index}].packId")
        for index, item in enumerate(raw_packs)
    ]
    if len(set(pack_ids)) != len(pack_ids):
        raise BubbleFitTrainingError(
            "input pack-set packId order/uniqueness is invalid"
        )
    if (
        input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION
        and pack_ids != sorted(pack_ids)
    ):
        raise BubbleFitTrainingError(
            "input pack-set packId order/uniqueness is invalid"
        )
    if any(
        not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", value) for value in pack_ids
    ):
        raise BubbleFitTrainingError("input pack-set packId is not canonical")
    roles = [
        _require_string(item.get("role"), f"packs[{index}].role")
        for index, item in enumerate(raw_packs)
    ]
    if input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION:
        if sorted(roles) != ["new", "old"]:
            raise BubbleFitTrainingError(
                "input pack-set v1 roles must be unique old/new"
            )
    elif roles != ["base"] * (len(raw_packs) - 1) + ["incremental"]:
        raise BubbleFitTrainingError(
            "input pack-set v2 requires ordered base packs followed by exactly one "
            "incremental pack"
        )

    packs: list[DatasetPack] = []
    manifests: list[dict[str, Any]] = []
    seen_dataset_dirs: set[Path] = set()
    seen_labels_files: set[Path] = set()
    compatibility: dict[str, Any] | None = None
    for index, raw_pack in enumerate(raw_packs):
        pack_id = pack_ids[index]
        dataset_dir = _safe_repository_input_path(
            repository_root,
            raw_pack.get("datasetDir"),
            f"packs[{index}].datasetDir",
            directory=True,
        )
        labels_path = _safe_repository_input_path(
            repository_root,
            raw_pack.get("labelsFile"),
            f"packs[{index}].labelsFile",
            directory=False,
        )
        if dataset_dir in seen_dataset_dirs or labels_path in seen_labels_files:
            raise BubbleFitTrainingError(
                "input pack-set reuses a child dataset or labels file"
            )
        seen_dataset_dirs.add(dataset_dir)
        seen_labels_files.add(labels_path)
        expected_candidates = _require_int(
            raw_pack.get("expectedCandidates"),
            f"packs[{index}].expectedCandidates",
            1,
        )
        snapshot = load_training_snapshot(
            dataset_dir,
            labels_path,
            expected_candidate_count=expected_candidates,
        )
        expected_hashes = {
            "datasetManifestSha256": snapshot.dataset_manifest_sha256,
            "datasetManifestBindingSha256": snapshot.dataset_manifest_binding_sha256,
            "datasetSealSha256": snapshot.dataset_seal_sha256,
            "artifactInventorySha256": snapshot.artifact_inventory_sha256,
            "labelsSha256": snapshot.labels_sha256,
        }
        for field, actual in expected_hashes.items():
            if (
                _require_sha256(raw_pack.get(field), f"packs[{index}].{field}")
                != actual
            ):
                raise BubbleFitTrainingError(
                    f"input pack-set child binding mismatch: {pack_id}.{field}"
                )
        manifest = _read_json(dataset_dir / "manifest.json", f"{pack_id} manifest")
        contract = _pack_compatibility_contract(manifest)
        if compatibility is None:
            compatibility = contract
        elif contract != compatibility:
            raise BubbleFitTrainingError(
                "input pack-set child preprocessing contracts differ"
            )
        manifests.append(manifest)
        packs.append(DatasetPack(pack_id=pack_id, role=roles[index], snapshot=snapshot))

    seen_candidate_ids: set[str] = set()
    seen_page_ids: set[str] = set()
    seen_artifact_paths: set[Path] = set()
    work_titles: dict[str, str] = {}
    combined_samples: list[TrainingSample] = []
    source_work_ids: set[str] = set()
    combined_ordinal = 0
    for pack, manifest in zip(packs, manifests, strict=True):
        for raw_page in manifest["pages"]:
            page_id = _require_string(raw_page.get("sourcePageId"), "page.sourcePageId")
            if page_id in seen_page_ids:
                raise BubbleFitTrainingError(
                    f"cross-pack source page id collision: {page_id}"
                )
            seen_page_ids.add(page_id)
            work_id = _require_string(raw_page.get("workId"), "page.workId")
            work_title = _require_string(raw_page.get("workTitle"), "page.workTitle")
            previous_title = work_titles.setdefault(work_id, work_title)
            if previous_title != work_title:
                raise BubbleFitTrainingError(
                    f"cross-pack work title conflict: {work_id}"
                )
            source_work_ids.add(work_id)
        for raw_candidate in manifest["candidates"]:
            candidate_id = _require_string(raw_candidate.get("id"), "candidate.id")
            if candidate_id in seen_candidate_ids:
                raise BubbleFitTrainingError(
                    f"cross-pack candidate id collision: {candidate_id}"
                )
            seen_candidate_ids.add(candidate_id)
            artifacts = raw_candidate.get("artifacts")
            if not isinstance(artifacts, Mapping):
                raise BubbleFitTrainingError(f"{candidate_id} artifact set is invalid")
            for kind in DATASET_ARTIFACT_ORDER:
                artifact = artifacts.get(kind)
                if not isinstance(artifact, Mapping):
                    raise BubbleFitTrainingError(f"{candidate_id}.{kind} is invalid")
                path = _safe_artifact_path(
                    pack.snapshot.dataset_dir,
                    artifact.get("path"),
                    f"{pack.pack_id}.{candidate_id}.{kind}",
                )
                if path in seen_artifact_paths:
                    raise BubbleFitTrainingError(
                        f"cross-pack artifact path collision: {candidate_id}.{kind}"
                    )
                seen_artifact_paths.add(path)
        for sample in pack.snapshot.samples:
            combined_ordinal += 1
            combined_samples.append(
                replace(
                    sample,
                    pack_id=pack.pack_id,
                    pack_role=pack.role,
                    combined_ordinal=combined_ordinal,
                )
            )

    work_ids = tuple(sorted({sample.work_id for sample in combined_samples}))
    input_binding = [
        {
            "packId": sample.pack_id,
            "candidateId": sample.candidate_id,
            "sourceOrdinal": sample.ordinal,
            "sourceSelectionIndex": sample.selection_index,
            "combinedOrdinal": sample.combined_ordinal,
            "workId": sample.work_id,
            "originalNativeSha256": sample.original_sha256,
            "candidateCoreMaskSha256": sample.core_mask_sha256,
        }
        for sample in combined_samples
    ]
    pack_provenance = [pack.provenance() for pack in packs]
    return DatasetPackSetSnapshot(
        input_schema_version=input_schema_version,
        identifier=identifier,
        pack_set_file_sha256=_sha256_file(pack_set_path),
        pack_set_canonical_sha256=_sha256_json(payload),
        pack_set_binding_sha256=binding,
        packs=tuple(packs),
        samples=tuple(combined_samples),
        work_ids=work_ids,
        source_page_count=sum(pack.snapshot.source_page_count for pack in packs),
        source_work_ids=tuple(sorted(source_work_ids)),
        production_input_binding_sha256=_sha256_json(input_binding),
        source_packs_canonical_sha256=_sha256_json(pack_provenance),
    )


def load_production_input(sample: TrainingSample) -> np.ndarray:
    """Return normalized [R,G,B,core-mask] without any cleaned-image access."""

    if not sample.original_path.is_file() or not sample.core_mask_path.is_file():
        raise BubbleFitTrainingError(
            f"production input is missing: {sample.candidate_id}"
        )
    if _sha256_file(sample.original_path) != sample.original_sha256:
        raise BubbleFitTrainingError(f"original crop drift: {sample.candidate_id}")
    if _sha256_file(sample.core_mask_path) != sample.core_mask_sha256:
        raise BubbleFitTrainingError(f"core mask drift: {sample.candidate_id}")
    try:
        with Image.open(sample.original_path) as opened:
            opened.load()
            original = opened.convert("RGB")
        with Image.open(sample.core_mask_path) as opened:
            opened.load()
            mask = opened.convert("L")
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise BubbleFitTrainingError(
            f"could not decode production input {sample.candidate_id}: {exc}"
        ) from exc
    try:
        if original.size != mask.size:
            raise BubbleFitTrainingError(
                f"original/mask size mismatch: {sample.candidate_id}"
            )
        rgb_224 = _letterbox_rgb(original)
        mask_224 = _letterbox_mask(mask)
        try:
            rgb = np.asarray(rgb_224, dtype=np.float32) / np.float32(255.0)
            core = np.asarray(mask_224, dtype=np.float32) / np.float32(255.0)
        finally:
            rgb_224.close()
            mask_224.close()
    finally:
        original.close()
        mask.close()
    if not set(np.unique(core)).issubset({0.0, 1.0}) or not np.any(core == 1.0):
        raise BubbleFitTrainingError(
            f"letterboxed core mask is invalid: {sample.candidate_id}"
        )
    normalized_rgb = (rgb - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(
        np.concatenate((normalized_rgb.transpose(2, 0, 1), core[None, ...]), axis=0),
        dtype=np.float32,
    )


def production_input_contract() -> dict[str, Any]:
    return {
        "shape": ["batch", 4, IMAGE_SIZE, IMAGE_SIZE],
        "dtype": "float32",
        "channelOrder": ["red", "green", "blue", "candidate_core_mask"],
        "rgbNormalization": {
            "scale": "uint8 / 255",
            "mean": IMAGENET_MEAN.tolist(),
            "std": IMAGENET_STD.tolist(),
        },
        "coreMaskNormalization": "binary uint8 {0,255} -> float32 {0,1}",
        "resize": "native aspect-preserving 224 letterbox; RGB LANCZOS, mask NEAREST",
        "sourceArtifacts": list(PRODUCTION_INPUT_ARTIFACTS),
        "forbiddenFeatureArtifacts": list(FORBIDDEN_FEATURE_ARTIFACTS),
        "cleanedPixelsUsed": False,
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        "rawCropAndMaskGeometryContractEmbedded": False,
        "promotionBlockedByPreprocessorParity": True,
        "parityNote": (
            "The crude dataset core is a deterministic rectangular detector-box ROI; "
            "it is not the production flood-refined safe mask and no shared runtime "
            "page-to-tensor preprocessor has been sealed."
        ),
    }


def build_grouped_folds(samples: Sequence[TrainingSample]) -> tuple[GroupFold, ...]:
    work_ids = sorted({sample.work_id for sample in samples})
    if len(work_ids) < 2:
        raise BubbleFitTrainingError("work-disjoint CV requires at least two works")
    folds: list[GroupFold] = []
    for index, holdout in enumerate(work_ids, start=1):
        train = tuple(
            i for i, sample in enumerate(samples) if sample.work_id != holdout
        )
        test = tuple(i for i, sample in enumerate(samples) if sample.work_id == holdout)
        fold = GroupFold(
            fold_id=f"work-holdout-{index:02d}",
            holdout_work_ids=(holdout,),
            train_indices=train,
            test_indices=test,
        )
        assert_work_disjoint_fold(fold, samples)
        folds.append(fold)
    held_out = [work for fold in folds for work in fold.holdout_work_ids]
    if sorted(held_out) != work_ids or len(held_out) != len(set(held_out)):
        raise BubbleFitTrainingError("every work must be held out exactly once")
    test_indices = [index for fold in folds for index in fold.test_indices]
    if sorted(test_indices) != list(range(len(samples))):
        raise BubbleFitTrainingError(
            "outer OOF folds do not cover every candidate once"
        )
    return tuple(folds)


def assert_work_disjoint_fold(
    fold: GroupFold,
    samples: Sequence[TrainingSample],
) -> None:
    train_indices = set(fold.train_indices)
    test_indices = set(fold.test_indices)
    if not train_indices or not test_indices or train_indices & test_indices:
        raise BubbleFitTrainingError(f"{fold.fold_id} has invalid candidate partitions")
    if (
        max(train_indices | test_indices) >= len(samples)
        or min(train_indices | test_indices) < 0
    ):
        raise BubbleFitTrainingError(f"{fold.fold_id} has out-of-range indices")
    train_works = {samples[index].work_id for index in train_indices}
    test_works = {samples[index].work_id for index in test_indices}
    if train_works & test_works:
        raise BubbleFitTrainingError(f"{fold.fold_id} leaks a work across train/test")
    if test_works != set(fold.holdout_work_ids):
        raise BubbleFitTrainingError(f"{fold.fold_id} holdout work metadata is stale")


def _class_counts(indices: Sequence[int], labels: np.ndarray) -> dict[str, int]:
    values = labels[np.asarray(indices, dtype=np.int64)]
    return {
        "safe": int(np.count_nonzero(values == 1)),
        "unsafe": int(np.count_nonzero(values == 0)),
    }


def _multiclass_targets(samples: Sequence[TrainingSample]) -> np.ndarray:
    try:
        values = [CLASS_INDEX_BY_LABEL[sample.label] for sample in samples]
    except KeyError as exc:
        raise BubbleFitTrainingError(
            f"unsupported sample label: {exc.args[0]}"
        ) from exc
    return np.asarray(values, dtype=np.int64)


def _multiclass_counts(
    indices: Sequence[int], class_targets: np.ndarray
) -> dict[str, int]:
    selected = class_targets[np.asarray(indices, dtype=np.int64)]
    return {
        label: int(np.count_nonzero(selected == class_index))
        for label, class_index in CLASS_INDEX_BY_LABEL.items()
    }


def _missing_multiclass_training_classes(
    indices: Sequence[int], class_targets: np.ndarray
) -> list[str]:
    counts = _multiclass_counts(indices, class_targets)
    return [label for label in ALLOWED_LABELS if counts[label] == 0]


def split_plan_payload(
    folds: Sequence[GroupFold],
    samples: Sequence[TrainingSample],
    *,
    schema_version: int = SCHEMA_VERSION,
) -> dict[str, Any]:
    labels = np.asarray([sample.safe for sample in samples], dtype=np.int64)
    records = []
    for fold in folds:
        train_ids = [samples[index].candidate_id for index in fold.train_indices]
        test_ids = [samples[index].candidate_id for index in fold.test_indices]
        train_works = sorted({samples[index].work_id for index in fold.train_indices})
        test_works = sorted({samples[index].work_id for index in fold.test_indices})
        test_counts = _class_counts(fold.test_indices, labels)
        issues = []
        if 0 in test_counts.values():
            issues.append("holdout_has_single_class_metrics_partially_undefined")
        record = {
            "foldId": fold.fold_id,
            "trainWorkIds": train_works,
            "holdoutWorkIds": test_works,
            "trainCandidateIds": train_ids,
            "holdoutCandidateIds": test_ids,
            "trainCandidateIdsSha256": _sha256_json(train_ids),
            "holdoutCandidateIdsSha256": _sha256_json(test_ids),
            "trainClassCounts": _class_counts(fold.train_indices, labels),
            "holdoutClassCounts": test_counts,
            "classIssues": issues,
        }
        if _is_pack_set_output_schema(schema_version):
            train_keys = [
                f"{samples[index].pack_id}:{samples[index].candidate_id}"
                for index in fold.train_indices
            ]
            holdout_keys = [
                f"{samples[index].pack_id}:{samples[index].candidate_id}"
                for index in fold.test_indices
            ]
            record.update(
                {
                    "trainCandidateKeys": train_keys,
                    "holdoutCandidateKeys": holdout_keys,
                    "trainCandidateKeysSha256": _sha256_json(train_keys),
                    "holdoutCandidateKeysSha256": _sha256_json(holdout_keys),
                }
            )
        records.append(record)
    return {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "strategy": "leave-one-work-out outer OOF; every work held out exactly once",
        "promotionEligible": False,
        "folds": records,
        "splitBindingSha256": _sha256_json(records),
    }


HEURISTIC_FEATURE_NAMES = (
    "core_luma_mean",
    "core_luma_std",
    "core_edge_density",
    "core_near_white_fraction",
    "core_near_black_fraction",
    "context_luma_mean",
    "context_luma_std",
    "context_edge_density",
    "core_context_luma_delta",
    "core_context_edge_delta",
    "core_area_fraction",
)


def _edge_density(gray: np.ndarray, mask: np.ndarray) -> float:
    horizontal_mask = mask[:, 1:] & mask[:, :-1]
    vertical_mask = mask[1:, :] & mask[:-1, :]
    horizontal = np.abs(gray[:, 1:] - gray[:, :-1]) >= 18.0
    vertical = np.abs(gray[1:, :] - gray[:-1, :]) >= 18.0
    count = int(np.count_nonzero(horizontal & horizontal_mask)) + int(
        np.count_nonzero(vertical & vertical_mask)
    )
    pairs = int(np.count_nonzero(horizontal_mask)) + int(
        np.count_nonzero(vertical_mask)
    )
    return count / pairs if pairs else 0.0


def original_core_diagnostics(input_tensor: np.ndarray) -> np.ndarray:
    if input_tensor.shape != (4, IMAGE_SIZE, IMAGE_SIZE):
        raise BubbleFitTrainingError("heuristic input must be [4,224,224]")
    rgb = input_tensor[:3].transpose(1, 2, 0) * IMAGENET_STD + IMAGENET_MEAN
    rgb = np.clip(rgb, 0.0, 1.0)
    core = input_tensor[3] >= 0.5
    context = ~core
    if not np.any(core) or not np.any(context):
        raise BubbleFitTrainingError("heuristic core/context is empty")
    gray = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114

    def stats(mask: np.ndarray) -> tuple[float, float, float, float, float]:
        selected = gray[mask]
        return (
            float(selected.mean()),
            float(selected.std()),
            _edge_density(gray, mask),
            float(np.mean(np.all(rgb[mask] >= 242.0 / 255.0, axis=1))),
            float(np.mean(np.all(rgb[mask] <= 48.0 / 255.0, axis=1))),
        )

    core_stats = stats(core)
    context_stats = stats(context)
    values = (
        core_stats[0],
        core_stats[1],
        core_stats[2],
        core_stats[3],
        core_stats[4],
        context_stats[0],
        context_stats[1],
        context_stats[2],
        abs(core_stats[0] - context_stats[0]),
        abs(core_stats[2] - context_stats[2]),
        float(core.mean()),
    )
    return np.asarray(values, dtype=np.float32)


def heuristic_safe_probability(input_tensor: np.ndarray) -> float:
    features = original_core_diagnostics(input_tensor)
    core_std = float(features[1])
    core_edge = float(features[2])
    tone_extreme = max(float(features[3]), float(features[4]))
    contrast = float(features[8])
    edge_advantage = max(0.0, float(features[7]) - core_edge)
    area = float(features[10])
    logit = (
        -0.35
        + 1.25 * (1.0 - min(1.0, core_std / 0.28))
        + 0.95 * (1.0 - min(1.0, core_edge / 0.24))
        + 0.90 * tone_extreme
        + 0.55 * min(1.0, contrast / 0.30)
        + 0.35 * min(1.0, edge_advantage / 0.18)
        - 0.30 * float(area < 0.015)
    )
    return float(1.0 / (1.0 + math.exp(-logit)))


def seed_everything(seed: int) -> dict[str, Any]:
    if not isinstance(seed, int) or seed < 0:
        raise BubbleFitTrainingError("seed must be a non-negative integer")
    cublas_workspace_config = os.environ.get("CUBLAS_WORKSPACE_CONFIG")
    if cublas_workspace_config is None:
        cublas_workspace_config = ":4096:8"
        os.environ["CUBLAS_WORKSPACE_CONFIG"] = cublas_workspace_config
    elif cublas_workspace_config not in {":4096:8", ":16:8"}:
        raise BubbleFitTrainingError(
            "CUBLAS_WORKSPACE_CONFIG must be :4096:8 or :16:8 for deterministic CUDA"
        )
    random.seed(seed)
    np.random.seed(seed % (2**32))
    record: dict[str, Any] = {
        "seed": seed,
        "pythonRandom": True,
        "numpyRandom": True,
        "cublasWorkspaceConfig": cublas_workspace_config,
    }
    try:
        import torch
    except ImportError:
        return record
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    record.update(
        {
            "torchRandom": True,
            "torchDeterministicAlgorithms": True,
            "cudnnBenchmark": False,
            "cudnnDeterministic": True,
        }
    )
    return record


def _derived_seed(seed: int, *parts: str) -> int:
    digest = hashlib.sha256(
        (str(seed) + "\0" + "\0".join(parts)).encode("utf-8")
    ).digest()
    return int.from_bytes(digest[:4], "big")


def _assert_pinned_mobilenet_checkpoint(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise BubbleFitTrainingError(
            f"pinned MobileNetV3-Small checkpoint is missing or symlinked: {path}"
        )
    actual_size = path.stat().st_size
    if actual_size != MOBILENET_V3_SMALL_IMAGENET1K_V1_SIZE_BYTES:
        raise BubbleFitTrainingError(
            "official MobileNetV3-Small checkpoint byte-size mismatch: "
            f"expected {MOBILENET_V3_SMALL_IMAGENET1K_V1_SIZE_BYTES}, got {actual_size}"
        )
    actual_sha256 = _sha256_file(path)
    if actual_sha256 != MOBILENET_V3_SMALL_IMAGENET1K_V1_SHA256:
        raise BubbleFitTrainingError(
            "official MobileNetV3-Small checkpoint SHA-256 mismatch: "
            f"expected {MOBILENET_V3_SMALL_IMAGENET1K_V1_SHA256}, got {actual_sha256}"
        )


def _download_pinned_mobilenet_checkpoint(
    torch: Any, url: str, cache_path: Path
) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{cache_path.name}.", suffix=".download", dir=cache_path.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        torch.hub.download_url_to_file(
            url,
            str(temporary_path),
            hash_prefix=MOBILENET_V3_SMALL_IMAGENET1K_V1_SHA256,
            progress=True,
        )
        _assert_pinned_mobilenet_checkpoint(temporary_path)
        os.replace(temporary_path, cache_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def load_official_mobilenet_weights(
    *,
    allow_download: bool,
) -> MobileNetWeightBundle:
    try:
        import torch
        import torchvision
        from torchvision.models import (
            MobileNet_V3_Small_Weights,
            mobilenet_v3_small,
        )
    except ImportError as exc:
        raise BubbleFitTrainingError(f"torchvision is unavailable: {exc}") from exc
    weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1
    url = weights.url
    if url != MOBILENET_V3_SMALL_IMAGENET1K_V1_URL:
        raise BubbleFitTrainingError(
            "torchvision MobileNetV3-Small official URL changed; update the explicit pin"
        )
    filename = Path(urlparse(url).path).name
    cache_path = (Path(torch.hub.get_dir()) / "checkpoints" / filename).resolve()
    if not cache_path.is_file():
        if not allow_download:
            raise BubbleFitTrainingError(
                "official MobileNetV3-Small weights are not cached; rerun with "
                "--allow-official-weight-download to download the explicitly pinned file"
            )
        _download_pinned_mobilenet_checkpoint(torch, url, cache_path)
    _assert_pinned_mobilenet_checkpoint(cache_path)
    try:
        with cache_path.open("rb") as checkpoint_handle:
            checkpoint_state = torch.load(
                checkpoint_handle, map_location="cpu", weights_only=True
            )
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise BubbleFitTrainingError(
            f"could not load pinned MobileNetV3-Small checkpoint: {exc}"
        ) from exc
    model = mobilenet_v3_small(weights=None)
    model.load_state_dict(checkpoint_state, strict=True)
    state = copy.deepcopy(model.state_dict())
    del model
    transform = weights.transforms()
    if not np.allclose(
        transform.mean, IMAGENET_MEAN, rtol=0, atol=1e-7
    ) or not np.allclose(transform.std, IMAGENET_STD, rtol=0, atol=1e-7):
        raise BubbleFitTrainingError(
            "official MobileNet normalization contract changed"
        )
    provenance = {
        "source": "torchvision official weights enum/cache only",
        "enum": "MobileNet_V3_Small_Weights.IMAGENET1K_V1",
        "url": url,
        "cacheFileName": cache_path.name,
        "expectedSha256": MOBILENET_V3_SMALL_IMAGENET1K_V1_SHA256,
        "expectedSizeBytes": MOBILENET_V3_SMALL_IMAGENET1K_V1_SIZE_BYTES,
        "cacheSha256": MOBILENET_V3_SMALL_IMAGENET1K_V1_SHA256,
        "cacheSizeBytes": MOBILENET_V3_SMALL_IMAGENET1K_V1_SIZE_BYTES,
        "verifiedBeforeDeserialization": True,
        "torchVersion": torch.__version__,
        "torchvisionVersion": torchvision.__version__,
        "comicDataExternalUpload": False,
    }
    return MobileNetWeightBundle(state_dict=state, provenance=provenance)


def build_mobilenet_v3_small_gate(
    *,
    mode: str,
    seed: int,
    pretrained_state_dict: Mapping[str, Any] | None,
) -> Any:
    if mode not in MOBILE_MODEL_KINDS:
        raise BubbleFitTrainingError(f"unsupported MobileNet mode: {mode}")
    try:
        import torch
        from torch import nn
        from torchvision.models import mobilenet_v3_small
    except ImportError as exc:
        raise BubbleFitTrainingError(f"torchvision is unavailable: {exc}") from exc
    torch.manual_seed(seed)
    model = mobilenet_v3_small(weights=None)
    if pretrained_state_dict is not None:
        model.load_state_dict(pretrained_state_dict, strict=True)
    old_conv = model.features[0][0]
    if not isinstance(old_conv, nn.Conv2d) or old_conv.in_channels != 3:
        raise BubbleFitTrainingError("MobileNet first convolution contract changed")
    new_conv = nn.Conv2d(
        4,
        old_conv.out_channels,
        kernel_size=old_conv.kernel_size,
        stride=old_conv.stride,
        padding=old_conv.padding,
        dilation=old_conv.dilation,
        groups=old_conv.groups,
        bias=old_conv.bias is not None,
        padding_mode=old_conv.padding_mode,
    )
    with torch.no_grad():
        new_conv.weight[:, :3].copy_(old_conv.weight)
        new_conv.weight[:, 3:4].copy_(old_conv.weight.mean(dim=1, keepdim=True))
        if old_conv.bias is not None and new_conv.bias is not None:
            new_conv.bias.copy_(old_conv.bias)
    model.features[0][0] = new_conv
    last = model.classifier[-1]
    if not isinstance(last, nn.Linear):
        raise BubbleFitTrainingError("MobileNet classifier contract changed")
    output_count = 5 if mode == LINEAR_FIVE_CLASS_MODEL_KIND else 1
    model.classifier[-1] = nn.Linear(last.in_features, output_count)
    if mode in {LINEAR_BINARY_MODEL_KIND, LINEAR_FIVE_CLASS_MODEL_KIND}:
        for parameter in model.parameters():
            parameter.requires_grad = False
        for parameter in model.classifier[-1].parameters():
            parameter.requires_grad = True
    else:
        for parameter in model.features.parameters():
            parameter.requires_grad = False
        if mode == "mobilenet_v3_small_light_finetune":
            for block in model.features[-2:]:
                for parameter in block.parameters():
                    parameter.requires_grad = True
        for parameter in model.classifier.parameters():
            parameter.requires_grad = True
    return model


def model_definition(model_kind: str) -> dict[str, Any]:
    if model_kind == "heuristic_original_core_v1":
        return {
            "architecture": "fixed hand-authored sigmoid diagnostic score",
            "trainedParameters": 0,
            "featureNames": list(HEURISTIC_FEATURE_NAMES),
            "pixelSources": list(PRODUCTION_INPUT_ARTIFACTS),
            "cleanedPixelsUsed": False,
        }
    if model_kind not in MODEL_KINDS:
        raise BubbleFitTrainingError(f"unsupported model definition: {model_kind}")
    if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
        classifier = (
            "frozen pretrained classifier trunk with a new 1024x5 final Linear; "
            "softmax safe_opaque probability is the production-safe score"
        )
        trainable_scope = "new final Linear only"
        trained_parameters = 5_125
        output_semantics = {
            "kind": "five_class_softmax",
            "classOrder": list(ALLOWED_LABELS),
            "safeClassIndex": SAFE_CLASS_INDEX,
            "safeScore": "softmax probability at safeClassIndex",
        }
        training_objective = {
            "loss": "weighted_cross_entropy",
            "classWeights": {
                label: (
                    1.0 if label == "safe_opaque" else FIVE_CLASS_UNSAFE_LOSS_WEIGHT
                )
                for label in ALLOWED_LABELS
            },
        }
    elif model_kind == LINEAR_BINARY_MODEL_KIND:
        classifier = "frozen pretrained classifier trunk with a new 1024x1 final Linear"
        trainable_scope = "new final Linear only"
        trained_parameters = 1_025
        output_semantics = {"kind": "sigmoid_safe_probability"}
        training_objective = None
    else:
        classifier = (
            "stock MobileNetV3-Small classifier with final Linear replaced by one "
            "safe logit"
        )
        trainable_scope = (
            "classifier only"
            if model_kind == "mobilenet_v3_small_frozen_head"
            else "classifier plus final two feature blocks"
        )
        trained_parameters = None
        output_semantics = None
        training_objective = None
    return {
        "architecture": "torchvision.models.mobilenet_v3_small",
        "inputChannels": 4,
        "firstConvolutionInitialization": {
            "rgbChannels": "official ImageNet weight copy",
            "candidateCoreMaskChannel": "mean of three official RGB kernels",
        },
        "classifier": classifier,
        "trainableScope": trainable_scope,
        **(
            {"trainedParameters": trained_parameters}
            if trained_parameters is not None
            else {}
        ),
        **(
            {"outputSemantics": output_semantics}
            if output_semantics is not None
            else {}
        ),
        **(
            {"trainingObjective": training_objective}
            if training_objective is not None
            else {}
        ),
        **(
            {"frozenTrunkModeDuringTraining": "eval"}
            if model_kind in {LINEAR_BINARY_MODEL_KIND, LINEAR_FIVE_CLASS_MODEL_KIND}
            else {}
        ),
        "pixelSources": list(PRODUCTION_INPUT_ARTIFACTS),
        "cleanedPixelsUsed": False,
    }


def _resolve_device(raw: str) -> str:
    value = raw.strip().lower()
    if value not in {"cpu", "cuda", "auto"}:
        raise BubbleFitTrainingError("device must be cpu, cuda, or auto")
    try:
        import torch
    except ImportError as exc:
        raise BubbleFitTrainingError(f"PyTorch is unavailable: {exc}") from exc
    if value == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if value == "cuda" and not torch.cuda.is_available():
        raise BubbleFitTrainingError("CUDA was requested but is unavailable")
    return value


def _freeze_nontrainable_batchnorm(model: Any) -> None:
    for module in model.modules():
        parameters = list(module.parameters(recurse=False))
        if parameters and not any(parameter.requires_grad for parameter in parameters):
            module.eval()


def _fit_mobile_model(
    model_kind: str,
    train_indices: Sequence[int],
    inputs: np.ndarray,
    labels: np.ndarray,
    config: EvaluationConfig,
    weight_bundle: MobileNetWeightBundle,
    seed: int,
    class_targets: np.ndarray | None = None,
) -> tuple[Any | None, dict[str, Any]]:
    counts = _class_counts(train_indices, labels)
    multiclass_counts: dict[str, int] | None = None
    if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
        if class_targets is None or class_targets.shape != labels.shape:
            raise BubbleFitTrainingError(
                "five-class fit requires one class target per binary label"
            )
        multiclass_counts = _multiclass_counts(train_indices, class_targets)
        if sum(multiclass_counts.values()) != len(train_indices):
            raise BubbleFitTrainingError(
                "five-class training targets contain an invalid class index"
            )
        missing = [label for label in ALLOWED_LABELS if multiclass_counts[label] == 0]
        if missing:
            raise UnsupportedMulticlassFoldError(missing)
    elif 0 in counts.values():
        return None, {
            "status": "constant_prior_due_single_class_training_fold",
            "seed": seed,
            "trainClassCounts": counts,
            "classIssue": "learned fit impossible with one training class",
            "constantProbability": float(labels[list(train_indices)].mean()),
        }
    import torch
    import torch.nn.functional as functional

    seed_everything(seed)
    device = _resolve_device(config.device)
    model = build_mobilenet_v3_small_gate(
        mode=model_kind,
        seed=seed,
        pretrained_state_dict=weight_bundle.state_dict,
    ).to(device)
    classifier_parameters = [
        parameter
        for parameter in model.classifier.parameters()
        if parameter.requires_grad
    ]
    trainable_parameter_count = sum(
        parameter.numel() for parameter in model.parameters() if parameter.requires_grad
    )
    if model_kind == LINEAR_BINARY_MODEL_KIND and trainable_parameter_count != 1_025:
        raise BubbleFitTrainingError(
            "linear-binary MobileNet trainable parameter contract changed"
        )
    if (
        model_kind == LINEAR_FIVE_CLASS_MODEL_KIND
        and trainable_parameter_count != 5_125
    ):
        raise BubbleFitTrainingError(
            "linear-five-class MobileNet trainable parameter contract changed"
        )
    if model_kind == "mobilenet_v3_small_light_finetune":
        classifier_ids = {id(parameter) for parameter in classifier_parameters}
        feature_parameters = [
            parameter
            for parameter in model.parameters()
            if parameter.requires_grad and id(parameter) not in classifier_ids
        ]
        groups = [
            {
                "params": classifier_parameters,
                "lr": config.finetune_head_learning_rate,
            },
            {
                "params": feature_parameters,
                "lr": config.finetune_feature_learning_rate,
            },
        ]
        epochs = config.finetune_epochs
    else:
        groups = [{"params": classifier_parameters, "lr": config.frozen_learning_rate}]
        epochs = config.frozen_epochs
    optimizer = torch.optim.AdamW(
        groups,
        weight_decay=config.weight_decay,
    )
    train_index_tensor = torch.as_tensor(train_indices, dtype=torch.long)
    x_cpu = torch.from_numpy(inputs)
    if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
        assert class_targets is not None
        y_cpu = torch.from_numpy(class_targets.astype(np.int64))
        class_weight_tensor = torch.tensor(
            [1.0] + [FIVE_CLASS_UNSAFE_LOSS_WEIGHT] * (len(ALLOWED_LABELS) - 1),
            dtype=torch.float32,
            device=device,
        )
    else:
        y_cpu = torch.from_numpy(labels.astype(np.float32))
        class_weight_tensor = None
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    for _epoch in range(epochs):
        if model_kind in {LINEAR_BINARY_MODEL_KIND, LINEAR_FIVE_CLASS_MODEL_KIND}:
            model.eval()
            model.classifier[-1].train()
        else:
            model.train()
            _freeze_nontrainable_batchnorm(model)
        order = train_index_tensor[
            torch.randperm(len(train_index_tensor), generator=generator)
        ]
        for start in range(0, len(order), config.batch_size):
            batch = order[start : start + config.batch_size]
            x = x_cpu[batch].to(device)
            y = y_cpu[batch].to(device)
            optimizer.zero_grad(set_to_none=True)
            if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
                logits = model(x)
                if logits.ndim != 2 or logits.shape[1] != len(ALLOWED_LABELS):
                    raise BubbleFitTrainingError(
                        "five-class MobileNet output contract changed"
                    )
                loss = functional.cross_entropy(
                    logits,
                    y,
                    weight=class_weight_tensor,
                )
            else:
                logits = model(x).reshape(-1)
                losses = functional.binary_cross_entropy_with_logits(
                    logits, y, reduction="none"
                )
                weights = torch.where(
                    y < 0.5,
                    torch.full_like(y, config.unsafe_loss_weight),
                    torch.ones_like(y),
                )
                loss = (losses * weights).mean()
            loss.backward()
            optimizer.step()
    fit_record = {
        "status": "trained",
        "seed": seed,
        "trainClassCounts": counts,
        "epochs": epochs,
        "device": device,
        "batchSize": config.batch_size,
        "unsafeLossWeight": config.unsafe_loss_weight,
    }
    if model_kind in {LINEAR_BINARY_MODEL_KIND, LINEAR_FIVE_CLASS_MODEL_KIND}:
        fit_record.update(
            {
                "trainableScope": "new final Linear only",
                "trainableParameterCount": trainable_parameter_count,
                "frozenTrunkModeDuringTraining": "eval",
            }
        )
    if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
        assert multiclass_counts is not None
        fit_record.pop("unsafeLossWeight")
        fit_record.update(
            {
                "loss": "weighted_cross_entropy",
                "classOrder": list(ALLOWED_LABELS),
                "trainLabelClassCounts": multiclass_counts,
                "classWeights": {
                    label: (
                        1.0 if label == "safe_opaque" else FIVE_CLASS_UNSAFE_LOSS_WEIGHT
                    )
                    for label in ALLOWED_LABELS
                },
                "safeScore": "softmax probability for safe_opaque",
            }
        )
    return model, fit_record


def _predict_mobile(
    model: Any, indices: Sequence[int], inputs: np.ndarray, device: str
) -> np.ndarray:
    import torch

    model.eval()
    resolved = _resolve_device(device)
    with torch.inference_mode():
        tensor = torch.from_numpy(inputs[np.asarray(indices, dtype=np.int64)]).to(
            resolved
        )
        probabilities = torch.sigmoid(model(tensor).reshape(-1)).cpu().numpy()
    return np.clip(probabilities.astype(np.float64), 1e-7, 1.0 - 1e-7)


def _predict_mobile_five_class(
    model: Any, indices: Sequence[int], inputs: np.ndarray, device: str
) -> np.ndarray:
    import torch

    model.eval()
    resolved = _resolve_device(device)
    with torch.inference_mode():
        tensor = torch.from_numpy(inputs[np.asarray(indices, dtype=np.int64)]).to(
            resolved
        )
        logits = model(tensor)
        if logits.ndim != 2 or logits.shape[1] != len(ALLOWED_LABELS):
            raise BubbleFitTrainingError("five-class MobileNet output contract changed")
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()
    values = probabilities.astype(np.float64)
    values /= values.sum(axis=1, keepdims=True)
    return values


def _fit_predict_split(
    model_kind: str,
    train_indices: Sequence[int],
    predict_indices: Sequence[int],
    inputs: np.ndarray,
    labels: np.ndarray,
    config: EvaluationConfig,
    weight_bundle: MobileNetWeightBundle | None,
    seed: int,
    class_targets: np.ndarray | None = None,
) -> tuple[np.ndarray, dict[str, Any]]:
    if model_kind == "heuristic_original_core_v1":
        values = np.asarray(
            [heuristic_safe_probability(inputs[index]) for index in predict_indices],
            dtype=np.float64,
        )
        return np.clip(values, 1e-7, 1.0 - 1e-7), {
            "status": "fixed_original_core_diagnostics",
            "featureNames": list(HEURISTIC_FEATURE_NAMES),
            "trained": False,
        }
    if weight_bundle is None:
        raise BubbleFitTrainingError("MobileNet evaluation requires official weights")
    model, fit = _fit_mobile_model(
        model_kind,
        train_indices,
        inputs,
        labels,
        config,
        weight_bundle,
        seed,
        class_targets,
    )
    if model is None:
        probability = float(fit["constantProbability"])
        return np.full(len(predict_indices), probability, dtype=np.float64), fit
    try:
        if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
            class_probabilities = _predict_mobile_five_class(
                model, predict_indices, inputs, config.device
            )
            probabilities = class_probabilities[:, SAFE_CLASS_INDEX]
            fit = dict(fit)
            fit["_classProbabilities"] = class_probabilities
        else:
            probabilities = _predict_mobile(
                model, predict_indices, inputs, config.device
            )
    finally:
        del model
    return probabilities, fit


def _extract_class_probabilities(
    model_kind: str,
    fit: Mapping[str, Any],
    *,
    expected_count: int,
) -> tuple[dict[str, Any], np.ndarray | None]:
    fit_record = dict(fit)
    raw = fit_record.pop("_classProbabilities", None)
    if model_kind != LINEAR_FIVE_CLASS_MODEL_KIND:
        if raw is not None:
            raise BubbleFitTrainingError(
                "binary model unexpectedly emitted class probabilities"
            )
        return fit_record, None
    if (
        not isinstance(raw, np.ndarray)
        or raw.shape != (expected_count, len(ALLOWED_LABELS))
        or not np.all(np.isfinite(raw))
        or np.any(raw < 0.0)
        or np.any(raw > 1.0)
        or not np.allclose(raw.sum(axis=1), 1.0, rtol=0.0, atol=1e-8)
    ):
        raise BubbleFitTrainingError(
            "five-class prediction probabilities are missing or invalid"
        )
    return fit_record, np.asarray(raw, dtype=np.float64)


def _binomial_cdf(successes: int, trials: int, probability: float) -> float:
    if successes < 0 or trials < 0 or successes > trials:
        raise BubbleFitTrainingError("binomial counts are invalid")
    if probability <= 0:
        return 1.0
    if probability >= 1:
        return 1.0 if successes == trials else 0.0
    logs = [
        math.lgamma(trials + 1)
        - math.lgamma(value + 1)
        - math.lgamma(trials - value + 1)
        + value * math.log(probability)
        + (trials - value) * math.log1p(-probability)
        for value in range(successes + 1)
    ]
    maximum = max(logs)
    return min(
        1.0, math.exp(maximum) * sum(math.exp(value - maximum) for value in logs)
    )


def one_sided_binomial_upper_bound(
    false_accepts: int,
    unsafe_count: int,
    *,
    confidence: float = FALSE_ACCEPT_CONFIDENCE,
) -> float | None:
    """Return a one-sided Clopper-Pearson calculation for a declared event unit.

    The calculation is confirmatory only when callers supply predeclared independent
    event units. Candidate-level calls in this trainer are explicitly exploratory
    diagnostics because candidates are clustered within works.
    """

    if unsafe_count == 0:
        return None
    if false_accepts < 0 or false_accepts > unsafe_count or not 0 < confidence < 1:
        raise BubbleFitTrainingError("binomial upper-bound inputs are invalid")
    if false_accepts == unsafe_count:
        return 1.0
    alpha = 1.0 - confidence
    lower = false_accepts / unsafe_count
    upper = 1.0
    for _iteration in range(80):
        midpoint = (lower + upper) / 2.0
        if _binomial_cdf(false_accepts, unsafe_count, midpoint) > alpha:
            lower = midpoint
        else:
            upper = midpoint
    return float(upper)


def minimum_zero_failure_work_clusters(
    target: float,
    *,
    confidence: float = FALSE_ACCEPT_CONFIDENCE,
) -> int | None:
    if not 0 <= target <= 1 or not 0 < confidence < 1:
        raise BubbleFitTrainingError("work-cluster feasibility inputs are invalid")
    if target == 0:
        return None
    if target == 1:
        return 1
    alpha = 1.0 - confidence
    estimate = max(1, math.ceil(math.log(alpha) / math.log1p(-target)))
    while (
        float(one_sided_binomial_upper_bound(0, estimate, confidence=confidence))
        > target
    ):
        estimate += 1
    while (
        estimate > 1
        and float(
            one_sided_binomial_upper_bound(0, estimate - 1, confidence=confidence)
        )
        <= target
    ):
        estimate -= 1
    return estimate


def confirmatory_audit_contract(
    *,
    current_source_work_count: int,
    target: float,
    schema_version: int = SCHEMA_VERSION,
) -> dict[str, Any]:
    if (
        isinstance(current_source_work_count, bool)
        or not isinstance(current_source_work_count, int)
        or current_source_work_count < 0
    ):
        raise BubbleFitTrainingError("current source work count is invalid")
    if not isinstance(target, (int, float)) or isinstance(target, bool):
        raise BubbleFitTrainingError("confirmatory target is invalid")
    target = float(target)
    if not math.isfinite(target) or not 0 <= target <= 1:
        raise BubbleFitTrainingError("confirmatory target is invalid")
    reference_upper = one_sided_binomial_upper_bound(
        0, REFERENCE_LIBRARY_INVENTORY_WORK_COUNT
    )
    required_for_target = minimum_zero_failure_work_clusters(target)
    required_for_five_percent = minimum_zero_failure_work_clusters(
        REFERENCE_PRODUCTION_TARGET
    )
    return {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "contractKind": "future locked work-cluster confirmatory audit protocol",
        "productionSafetyEstablished": False,
        "confirmatory": False,
        "currentRunRole": "exploratory development OOF only",
        "currentRunIsLockedConfirmatoryAudit": False,
        "candidateIidInferenceAuthorized": False,
        "confirmatoryEventUnit": (
            "independent locked-audit work cluster; a failure event is any unsafe "
            "false acceptance within that audited work"
        ),
        "clusterEligibility": (
            "each denominator work must contain at least one predeclared unsafe "
            "gate opportunity and must be audited after model, runtime preprocessor, "
            "and operational threshold are frozen"
        ),
        "currentSourceWorkCount": current_source_work_count,
        "currentSourceWorkCountIsEligibleAuditDenominator": False,
        "referenceLibraryInventoryWorkCount": (REFERENCE_LIBRARY_INVENTORY_WORK_COUNT),
        "referenceLibraryInventoryIsEligibilityLedger": False,
        "sealedEligibilityLedgerPresent": False,
        "eligibleUntouchedWorkClusterCount": None,
        "eligibleUntouchedWorkClusterShortfallForConfiguredTarget": None,
        "eligibleUntouchedWorkClusterShortfallForFivePercent": None,
        "theoreticalBestCaseAssumingEveryInventoryWorkIsEligibleUntouchedAndHasZeroFailures": {
            "assumptionIsEstablished": False,
            "referenceLibraryInventoryWorkCount": (
                REFERENCE_LIBRARY_INVENTORY_WORK_COUNT
            ),
            "zeroFailureWorkClusterUpper95": reference_upper,
            "target": REFERENCE_PRODUCTION_TARGET,
            "meetsTarget": bool(
                reference_upper is not None
                and reference_upper <= REFERENCE_PRODUCTION_TARGET
            ),
            "minimumZeroFailureWorkClusters": required_for_five_percent,
            "interpretation": (
                "38 is only a library inventory reference. Even the unestablished "
                "best case of 38 eligible untouched zero-failure clusters has an "
                "upper bound above 5%; 59 such clusters would be required."
            ),
        },
        "minimumZeroFailureWorkClustersForFivePercent": required_for_five_percent,
        "configuredTarget": target,
        "minimumZeroFailureWorkClustersForConfiguredTarget": required_for_target,
        "precommittedExposureProtocol": {
            "required": True,
            "currentlySealed": False,
            "sealedBeforeInferenceRequired": True,
            "perWorkRequiredFields": [
                "workId",
                "precommittedPageSelectionRule",
                "precommittedPageIds",
                "precommittedPageCount",
                "opportunityEligibilityDefinition",
                "opportunityEnumerationRule",
                "precommittedOpportunityIds",
                "precommittedUnsafeOpportunityCount",
                "exclusionsWithReasons",
            ],
            "fixedSystemBindingsRequired": [
                "model artifact SHA-256",
                "runtime preprocessing contract SHA-256",
                "flood-mask implementation and parity evidence SHA-256",
                "single operational probability threshold",
            ],
            "denominatorRule": (
                "count only independently selected untouched works with a sealed "
                "per-work page/opportunity ledger and at least one precommitted "
                "unsafe gate opportunity"
            ),
            "failureEventRule": (
                "one work-cluster failure if any precommitted unsafe opportunity "
                "within that work is accepted as safe"
            ),
        },
        "lockedPromotionRequirements": [
            "freeze and hash the exact model artifact before audit selection",
            "seal byte-exact production page-to-tensor preprocessing and flood-mask parity",
            "precommit one operational probability threshold before audit inference",
            "seal each work's page selection and eligible opportunity exposure before inference",
            "select independent untouched work clusters and lock labels/protocol before inference",
            "count work-cluster failure events, not correlated candidate rows",
            "perform no training, calibration, threshold selection, or model ranking on the locked audit",
        ],
        "modelPreprocessorThresholdFrozenBeforeCurrentRun": False,
        "promotionEligible": False,
    }


def _binary_metrics(
    labels: np.ndarray,
    probabilities: np.ndarray,
    threshold: float,
) -> dict[str, Any]:
    predicted = probabilities >= threshold
    safe = labels.astype(bool)
    true_positive = int(np.count_nonzero(predicted & safe))
    false_positive = int(np.count_nonzero(predicted & ~safe))
    true_negative = int(np.count_nonzero(~predicted & ~safe))
    false_negative = int(np.count_nonzero(~predicted & safe))
    predicted_safe = true_positive + false_positive
    unsafe_count = false_positive + true_negative
    safe_count = true_positive + false_negative
    false_accept_rate = false_positive / unsafe_count if unsafe_count else None
    false_accept_upper = one_sided_binomial_upper_bound(false_positive, unsafe_count)
    return {
        "threshold": float(threshold),
        "safePrecision": (true_positive / predicted_safe if predicted_safe else None),
        "unsafeFalseAcceptRate": false_accept_rate,
        "unsafeFalseAcceptRateEmpirical": false_accept_rate,
        "candidateLevelDiagnosticUpper95": false_accept_upper,
        "candidateLevelDiagnosticBound": {
            "method": "one-sided Clopper-Pearson calculation",
            "nominalLevel": FALSE_ACCEPT_CONFIDENCE,
            "eventUnit": "candidate",
            "candidateIndependenceAsserted": False,
            "confirmatory": False,
            "falseAccepts": false_positive,
            "unsafeCount": unsafe_count,
            "empiricalRate": false_accept_rate,
            "upperBound": false_accept_upper,
        },
        "coverage": predicted_safe / len(labels) if len(labels) else 0.0,
        "safeRecall": true_positive / safe_count if safe_count else None,
        "accuracy": (
            (true_positive + true_negative) / len(labels) if len(labels) else None
        ),
        "counts": {
            "trueSafeAccepted": true_positive,
            "unsafeFalseAccepted": false_positive,
            "unsafeRejected": true_negative,
            "safeRejected": false_negative,
            "predictedSafe": predicted_safe,
            "total": len(labels),
        },
    }


def select_safety_threshold(
    labels: np.ndarray,
    probabilities: np.ndarray,
    *,
    unsafe_false_accept_target: float,
    minimum_coverage: float = DEFAULT_MINIMUM_COVERAGE,
    minimum_accepted_safe: int = DEFAULT_MINIMUM_ACCEPTED_SAFE,
) -> tuple[float | None, dict[str, Any]]:
    labels = np.asarray(labels, dtype=np.int64)
    probabilities = np.clip(np.asarray(probabilities, dtype=np.float64), 1e-7, 1 - 1e-7)
    if labels.shape != probabilities.shape or labels.ndim != 1 or not len(labels):
        raise BubbleFitTrainingError("threshold selection arrays are invalid")
    if set(np.unique(labels)) != {0, 1}:
        raise FoldClassError("threshold selection requires safe and unsafe examples")
    if not 0 <= unsafe_false_accept_target <= 1:
        raise BubbleFitTrainingError("unsafe false-accept target must be in [0,1]")
    if not 0 < minimum_coverage <= 1 or minimum_accepted_safe < 1:
        raise BubbleFitTrainingError(
            "threshold admissibility requires positive coverage and accepted-safe minima"
        )
    candidates = sorted({0.0, 1.0, *map(float, probabilities.tolist())})
    available: list[tuple[tuple[float, ...], float, dict[str, Any]]] = []
    diagnostics: list[dict[str, Any]] = []
    for threshold in candidates:
        metrics = _binary_metrics(labels, probabilities, threshold)
        false_accept_upper = metrics["candidateLevelDiagnosticUpper95"]
        precision = (
            float(metrics["safePrecision"])
            if metrics["safePrecision"] is not None
            else 0.0
        )
        recall = (
            float(metrics["safeRecall"]) if metrics["safeRecall"] is not None else 0.0
        )
        accepted_safe = int(metrics["counts"]["trueSafeAccepted"])
        has_minimum_utility = (
            float(metrics["coverage"]) >= minimum_coverage
            and accepted_safe >= minimum_accepted_safe
        )
        meets_bound = (
            false_accept_upper is not None
            and float(false_accept_upper) <= unsafe_false_accept_target
        )
        is_available = has_minimum_utility and meets_bound
        diagnostics.append(
            {
                "threshold": threshold,
                "availableForInnerSelection": is_available,
                "hasMinimumUtility": has_minimum_utility,
                "meetsCandidateLevelSelectionDiagnostic": meets_bound,
                "metrics": metrics,
            }
        )
        if not is_available:
            continue
        score = (
            recall,
            float(metrics["coverage"]),
            precision,
            -float(false_accept_upper),
            threshold,
        )
        available.append((score, threshold, metrics))
    common = {
        "unsafeFalseAcceptTarget": unsafe_false_accept_target,
        "thresholdRole": "inner cross-fitted selection diagnostic only",
        "candidateLevelSelectionDiagnostic": (
            "nominal one-sided 95% Clopper-Pearson calculation; candidates are "
            "work-clustered, independence is not asserted, and this is not a "
            "confirmatory confidence bound"
        ),
        "candidateIndependenceAsserted": False,
        "confirmatory": False,
        "productionSafetyEstablished": False,
        "safeCount": int(np.count_nonzero(labels == 1)),
        "unsafeCount": int(np.count_nonzero(labels == 0)),
        "candidateLevelDiagnosticZeroFailureUpper95": one_sided_binomial_upper_bound(
            0, int(np.count_nonzero(labels == 0))
        ),
        "minimumCoverage": minimum_coverage,
        "minimumAcceptedSafe": minimum_accepted_safe,
        "candidateThresholdCount": len(candidates),
        "innerThresholdAvailableCount": len(available),
        "empiricalRatesAreDiagnosticOnly": True,
    }
    if not available:
        utility_candidates = [row for row in diagnostics if row["hasMinimumUtility"]]
        closest = None
        if utility_candidates:
            closest = min(
                utility_candidates,
                key=lambda row: (
                    float(row["metrics"]["candidateLevelDiagnosticUpper95"]),
                    -float(row["metrics"]["safeRecall"] or 0.0),
                    -float(row["metrics"]["coverage"]),
                ),
            )
        return None, {
            **common,
            "status": "noInnerThresholdAvailable",
            "innerThresholdAvailable": False,
            "selectedThreshold": None,
            "selectedMetrics": None,
            "reason": (
                "no threshold met both the candidate-level selection diagnostic "
                "and nonzero utility requirements"
            ),
            "closestUnavailableDiagnostic": closest,
            "selectionPolicy": (
                "for inner threshold selection only, require nonzero utility and a "
                "candidate-level diagnostic calculation at or below target; return "
                "no threshold when none qualifies"
            ),
        }
    _score, threshold, metrics = max(available, key=lambda item: item[0])
    return threshold, {
        **common,
        "status": "innerThresholdAvailable",
        "innerThresholdAvailable": True,
        "selectedThreshold": threshold,
        "selectionPolicy": (
            "for exploratory inner selection, among thresholds meeting the "
            "candidate-level diagnostic and minimum utility, maximize safe recall, "
            "coverage, precision, then prefer the tighter diagnostic and higher threshold"
        ),
        "selectedMetrics": metrics,
    }


def _inner_cross_fitted_probabilities(
    model_kind: str,
    outer_fold: GroupFold,
    samples: Sequence[TrainingSample],
    inputs: np.ndarray,
    labels: np.ndarray,
    config: EvaluationConfig,
    weight_bundle: MobileNetWeightBundle | None,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    outer_train = tuple(outer_fold.train_indices)
    class_targets = _multiclass_targets(samples)
    works = sorted({samples[index].work_id for index in outer_train})
    if len(works) < 2:
        raise FoldClassError("inner work-disjoint threshold CV requires two works")
    values = np.full(len(samples), np.nan, dtype=np.float64)
    records: list[dict[str, Any]] = []
    for inner_index, holdout in enumerate(works, start=1):
        validation = tuple(
            index for index in outer_train if samples[index].work_id == holdout
        )
        training = tuple(
            index for index in outer_train if samples[index].work_id != holdout
        )
        train_works = {samples[index].work_id for index in training}
        validation_works = {samples[index].work_id for index in validation}
        if train_works & validation_works:
            raise BubbleFitTrainingError("inner threshold fold leaks a work")
        probabilities, fit = _fit_predict_split(
            model_kind,
            training,
            validation,
            inputs,
            labels,
            config,
            weight_bundle,
            _derived_seed(
                config.seed,
                model_kind,
                outer_fold.fold_id,
                f"inner-{inner_index}",
            ),
            class_targets,
        )
        fit, _unused_class_probabilities = _extract_class_probabilities(
            model_kind, fit, expected_count=len(validation)
        )
        values[np.asarray(validation, dtype=np.int64)] = probabilities
        records.append(
            {
                "innerFoldId": f"{outer_fold.fold_id}-threshold-{inner_index:02d}",
                "trainWorkIds": sorted(train_works),
                "validationWorkIds": sorted(validation_works),
                "trainCandidateIdsSha256": _sha256_json(
                    [samples[index].candidate_id for index in training]
                ),
                "validationCandidateIdsSha256": _sha256_json(
                    [samples[index].candidate_id for index in validation]
                ),
                "trainClassCounts": _class_counts(training, labels),
                "validationClassCounts": _class_counts(validation, labels),
                "fit": fit,
            }
        )
    selected = values[np.asarray(outer_train, dtype=np.int64)]
    if not np.all(np.isfinite(selected)):
        raise BubbleFitTrainingError("inner threshold OOF predictions are incomplete")
    return selected, records


def _work_macro_metrics(
    samples: Sequence[TrainingSample],
    labels: np.ndarray,
    predicted_safe: np.ndarray,
    decision_available: np.ndarray,
) -> dict[str, Any]:
    per_work: list[dict[str, Any]] = []
    for work_id in sorted({sample.work_id for sample in samples}):
        indices = np.asarray(
            [
                index
                for index, sample in enumerate(samples)
                if sample.work_id == work_id
            ],
            dtype=np.int64,
        )
        available_indices = indices[decision_available[indices]]
        if len(available_indices):
            metrics = _binary_metrics(
                labels[available_indices],
                predicted_safe[available_indices].astype(np.float64),
                0.5,
            )
        else:
            metrics = _empty_decision_metrics()
        per_work.append(
            {
                "workId": work_id,
                "candidateCount": len(indices),
                "evaluatedCandidateCount": len(available_indices),
                "decisionAvailabilityCoverage": len(available_indices) / len(indices),
                **metrics,
            }
        )
    macro: dict[str, Any] = {}
    defined: dict[str, int] = {}
    for key in (
        "safePrecision",
        "unsafeFalseAcceptRate",
        "coverage",
        "safeRecall",
        "accuracy",
    ):
        values = [float(row[key]) for row in per_work if row[key] is not None]
        macro[key] = float(np.mean(values)) if values else None
        defined[key] = len(values)
    return {"macro": macro, "definedWorkCounts": defined, "perWork": per_work}


def _empty_decision_metrics() -> dict[str, Any]:
    return {
        "threshold": None,
        "safePrecision": None,
        "unsafeFalseAcceptRate": None,
        "unsafeFalseAcceptRateEmpirical": None,
        "candidateLevelDiagnosticUpper95": None,
        "candidateLevelDiagnosticBound": {
            "method": "one-sided Clopper-Pearson calculation",
            "nominalLevel": FALSE_ACCEPT_CONFIDENCE,
            "eventUnit": "candidate",
            "candidateIndependenceAsserted": False,
            "confirmatory": False,
            "falseAccepts": 0,
            "unsafeCount": 0,
            "empiricalRate": None,
            "upperBound": None,
        },
        "coverage": None,
        "safeRecall": None,
        "accuracy": None,
        "counts": {
            "trueSafeAccepted": 0,
            "unsafeFalseAccepted": 0,
            "unsafeRejected": 0,
            "safeRejected": 0,
            "predictedSafe": 0,
            "total": 0,
        },
    }


def _decision_metrics_for_selector(
    labels: np.ndarray,
    predicted_safe: np.ndarray,
    decision_available: np.ndarray,
    selector: np.ndarray,
) -> dict[str, Any]:
    selected_count = int(np.count_nonzero(selector))
    evaluated = selector & decision_available
    evaluated_count = int(np.count_nonzero(evaluated))
    if evaluated_count:
        metrics = _binary_metrics(
            labels[evaluated], predicted_safe[evaluated].astype(np.float64), 0.5
        )
    else:
        metrics = _empty_decision_metrics()
    return {
        "candidateCount": selected_count,
        "evaluatedCandidateCount": evaluated_count,
        "unevaluatedCandidateCount": selected_count - evaluated_count,
        "decisionAvailabilityCoverage": (
            evaluated_count / selected_count if selected_count else None
        ),
        **metrics,
    }


def _confidence_and_subtype_metrics(
    samples: Sequence[TrainingSample],
    labels: np.ndarray,
    predicted_safe: np.ndarray,
    decision_available: np.ndarray,
) -> tuple[dict[str, Any], dict[str, Any]]:
    confidence = np.asarray([sample.confidence for sample in samples], dtype=object)
    high = confidence == "high"
    high_or_medium = np.isin(confidence, ("high", "medium"))
    confidence_metrics = {
        "primaryHighConfidence": _decision_metrics_for_selector(
            labels, predicted_safe, decision_available, high
        ),
        "sensitivityIncludingMedium": _decision_metrics_for_selector(
            labels, predicted_safe, decision_available, high_or_medium
        ),
        "mediumOnlyDiagnostic": _decision_metrics_for_selector(
            labels, predicted_safe, decision_available, confidence == "medium"
        ),
        "trainingUsesAllValidatedConfidenceLevels": True,
    }
    subtype_metrics: dict[str, Any] = {}
    sample_labels = np.asarray([sample.label for sample in samples], dtype=object)
    for subtype in ALLOWED_LABELS:
        if subtype == "safe_opaque":
            continue
        selected = sample_labels == subtype
        evaluated = selected & decision_available
        evaluated_count = int(np.count_nonzero(evaluated))
        false_accepts = int(np.count_nonzero(predicted_safe & evaluated))
        subtype_metrics[subtype] = {
            "candidateCount": int(np.count_nonzero(selected)),
            "evaluatedUnsafeCount": evaluated_count,
            "unevaluatedUnsafeCount": int(np.count_nonzero(selected)) - evaluated_count,
            "falseAccepts": false_accepts,
            "empiricalFalseAcceptRate": (
                false_accepts / evaluated_count if evaluated_count else None
            ),
            "candidateLevelDiagnosticUpper95": one_sided_binomial_upper_bound(
                false_accepts, evaluated_count
            ),
            "diagnosticMethod": "one-sided Clopper-Pearson calculation",
            "candidateIndependenceAsserted": False,
            "confirmatory": False,
        }
    return confidence_metrics, subtype_metrics


def _outer_exploratory_target_checks(
    aggregate: Mapping[str, Any],
    *,
    all_outer_decisions_available: bool,
    config: EvaluationConfig,
) -> tuple[dict[str, Any], bool]:
    outer_diagnostic_upper = aggregate.get("candidateLevelDiagnosticUpper95")
    bound_met = bool(
        all_outer_decisions_available
        and outer_diagnostic_upper is not None
        and float(outer_diagnostic_upper) <= config.unsafe_false_accept_target
    )
    coverage_met = bool(
        all_outer_decisions_available
        and aggregate.get("coverage") is not None
        and float(aggregate["coverage"]) >= config.minimum_coverage
    )
    counts = aggregate.get("counts")
    accepted_safe_met = bool(
        all_outer_decisions_available
        and isinstance(counts, Mapping)
        and int(counts.get("trueSafeAccepted", 0)) >= config.minimum_accepted_safe
    )
    checks = {
        "allOuterDecisionsAvailable": all_outer_decisions_available,
        "candidateLevelDiagnosticUpper95AtOrBelowTarget": bound_met,
        "minimumCoverageMet": coverage_met,
        "minimumAcceptedSafeMet": accepted_safe_met,
        "unsafeFalseAcceptTarget": config.unsafe_false_accept_target,
        "minimumCoverage": config.minimum_coverage,
        "minimumAcceptedSafe": config.minimum_accepted_safe,
    }
    return checks, bool(
        all_outer_decisions_available
        and bound_met
        and coverage_met
        and accepted_safe_met
    )


def evaluate_model(
    model_kind: str,
    folds: Sequence[GroupFold],
    samples: Sequence[TrainingSample],
    inputs: np.ndarray,
    labels: np.ndarray,
    config: EvaluationConfig,
    weight_bundle: MobileNetWeightBundle | None,
    *,
    schema_version: int = SCHEMA_VERSION,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if model_kind not in MODEL_KINDS:
        raise BubbleFitTrainingError(f"unsupported model kind: {model_kind}")
    probabilities = np.full(len(samples), np.nan, dtype=np.float64)
    class_targets = _multiclass_targets(samples)
    class_probabilities = (
        np.full((len(samples), len(ALLOWED_LABELS)), np.nan, dtype=np.float64)
        if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND
        else None
    )
    thresholds = np.full(len(samples), np.nan, dtype=np.float64)
    decision_available = np.zeros(len(samples), dtype=bool)
    predicted_safe = np.zeros(len(samples), dtype=bool)
    fold_records: list[dict[str, Any]] = []
    for fold in folds:
        inner_probabilities, inner_records = _inner_cross_fitted_probabilities(
            model_kind,
            fold,
            samples,
            inputs,
            labels,
            config,
            weight_bundle,
        )
        inner_labels = labels[np.asarray(fold.train_indices, dtype=np.int64)]
        threshold, threshold_record = select_safety_threshold(
            inner_labels,
            inner_probabilities,
            unsafe_false_accept_target=config.unsafe_false_accept_target,
            minimum_coverage=config.minimum_coverage,
            minimum_accepted_safe=config.minimum_accepted_safe,
        )
        holdout_probabilities, outer_fit = _fit_predict_split(
            model_kind,
            fold.train_indices,
            fold.test_indices,
            inputs,
            labels,
            config,
            weight_bundle,
            _derived_seed(config.seed, model_kind, fold.fold_id, "outer-fit"),
            class_targets,
        )
        outer_fit, holdout_class_probabilities = _extract_class_probabilities(
            model_kind,
            outer_fit,
            expected_count=len(fold.test_indices),
        )
        test_index = np.asarray(fold.test_indices, dtype=np.int64)
        probabilities[test_index] = holdout_probabilities
        if class_probabilities is not None:
            assert holdout_class_probabilities is not None
            if not np.allclose(
                holdout_probabilities,
                holdout_class_probabilities[:, SAFE_CLASS_INDEX],
                rtol=0.0,
                atol=1e-12,
            ):
                raise BubbleFitTrainingError(
                    "five-class safe score differs from safe class probability"
                )
            class_probabilities[test_index] = holdout_class_probabilities
        if threshold is None:
            holdout_metrics = None
        else:
            thresholds[test_index] = threshold
            decision_available[test_index] = True
            predicted_safe[test_index] = holdout_probabilities >= threshold
            holdout_metrics = _binary_metrics(
                labels[test_index], holdout_probabilities, threshold
            )
        class_issues = []
        if 0 in _class_counts(fold.test_indices, labels).values():
            class_issues.append("holdout_has_single_class_metrics_partially_undefined")
        fold_records.append(
            {
                "foldId": fold.fold_id,
                "trainWorkIds": sorted(
                    {samples[index].work_id for index in fold.train_indices}
                ),
                "holdoutWorkIds": list(fold.holdout_work_ids),
                "thresholdSelectionCandidateIdsSha256": _sha256_json(
                    [samples[index].candidate_id for index in fold.train_indices]
                ),
                "holdoutCandidateIdsSha256": _sha256_json(
                    [samples[index].candidate_id for index in fold.test_indices]
                ),
                "thresholdSelectionExcludesHoldout": True,
                "selectedThreshold": threshold,
                "innerThresholdAvailable": threshold is not None,
                "thresholdSelection": threshold_record,
                "innerWorkDisjointFolds": inner_records,
                "outerFit": outer_fit,
                "holdoutMetrics": holdout_metrics,
                "holdoutEvaluationRole": "exploratory outer OOF",
                "outerDecisionAvailable": threshold is not None,
                "confirmatory": False,
                "classIssues": class_issues,
                **(
                    {
                        "thresholdSelectionSafeProbabilities": [
                            float(value) for value in inner_probabilities
                        ],
                        "thresholdSelectionEvidenceRole": (
                            "unkeyed producer evidence: sealed inner work-disjoint "
                            "OOF probabilities in split-plan train-candidate order; "
                            "validator recomputes dependent thresholdSelection but "
                            "does not reexecute the neural fold model"
                        ),
                    }
                    if _has_recomputable_threshold_evidence(schema_version)
                    else {}
                ),
            }
        )
    if not np.all(np.isfinite(probabilities)):
        raise BubbleFitTrainingError("outer OOF predictions are incomplete")
    if class_probabilities is not None and not np.all(np.isfinite(class_probabilities)):
        raise BubbleFitTrainingError("outer five-class OOF predictions are incomplete")
    aggregate = _decision_metrics_for_selector(
        labels,
        predicted_safe,
        decision_available,
        np.ones(len(samples), dtype=bool),
    )
    unavailable_inner_threshold_fold_count = sum(
        not bool(row["thresholdSelection"]["innerThresholdAvailable"])
        for row in fold_records
    )
    all_outer_decisions_available = bool(np.all(decision_available))
    outer_target_checks, outer_exploratory_target_met = (
        _outer_exploratory_target_checks(
            aggregate,
            all_outer_decisions_available=all_outer_decisions_available,
            config=config,
        )
    )
    aggregate.update(
        {
            "evaluationRole": (
                "exploratory outer OOF after inner work-disjoint threshold selection"
            ),
            "thresholdMode": "per-outer-fold inner-work selection diagnostic",
            "allOuterDecisionsAvailable": all_outer_decisions_available,
            "innerThresholdUnavailableOuterFoldCount": (
                unavailable_inner_threshold_fold_count
            ),
            "outerFoldCount": len(fold_records),
            "outerExploratoryTargetChecks": outer_target_checks,
            "outerExploratoryTargetMet": outer_exploratory_target_met,
            "candidateIndependenceAsserted": False,
            "confirmatory": False,
            "productionSafetyEstablished": False,
        }
    )
    work_macro = _work_macro_metrics(
        samples, labels, predicted_safe, decision_available
    )
    confidence_metrics, subtype_metrics = _confidence_and_subtype_metrics(
        samples, labels, predicted_safe, decision_available
    )
    oof_rows = []
    for index, sample in enumerate(samples):
        row = {
            "schemaVersion": schema_version,
            "toolId": TOOL_ID,
            "promotionEligible": False,
            "productionUseForbidden": True,
            "runtimePreprocessorParity": False,
            "exactProductionFloodParity": False,
            "evaluationRole": "exploratory outer OOF",
            "confirmatory": False,
            "productionSafetyEstablished": False,
            "modelKind": model_kind,
            "candidateId": sample.candidate_id,
            "ordinal": sample.ordinal,
            "workId": sample.work_id,
            "label": sample.label,
            "safeForBubbleFit": sample.safe,
            "safeProbability": float(probabilities[index]),
            "threshold": (
                float(thresholds[index]) if decision_available[index] else None
            ),
            "decisionAvailable": bool(decision_available[index]),
            "predictedSafe": (
                bool(predicted_safe[index]) if decision_available[index] else None
            ),
            "foldId": next(
                fold.fold_id for fold in folds if index in fold.test_indices
            ),
        }
        if _is_pack_set_output_schema(schema_version):
            if (
                sample.pack_id is None
                or sample.pack_role is None
                or sample.combined_ordinal is None
            ):
                raise BubbleFitTrainingError("pack-set sample provenance is incomplete")
            row.update(
                {
                    "packId": sample.pack_id,
                    "packRole": sample.pack_role,
                    "candidateKey": f"{sample.pack_id}:{sample.candidate_id}",
                    "sourceOrdinal": sample.ordinal,
                    "sourceSelectionIndex": sample.selection_index,
                    "combinedOrdinal": sample.combined_ordinal,
                }
            )
        if class_probabilities is not None:
            row.update(
                {
                    "classProbabilities": {
                        label: float(class_probabilities[index, class_index])
                        for label, class_index in CLASS_INDEX_BY_LABEL.items()
                    },
                    "predictedClass": ALLOWED_LABELS[
                        int(np.argmax(class_probabilities[index]))
                    ],
                    "safeScoreSource": "softmax_safe_opaque_probability",
                }
            )
        oof_rows.append(row)
    model_record = {
        "modelKind": model_kind,
        "modelDefinition": model_definition(model_kind),
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "confirmatory": False,
        "currentRunRole": "exploratory development OOF only",
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        "evaluationRole": "exploratory model comparison only",
        "inputContract": production_input_contract(),
        "outerOofMetrics": aggregate,
        "workMacroMetrics": work_macro,
        "confidenceMetrics": confidence_metrics,
        "unsafeSubtypeFalseAcceptMetrics": subtype_metrics,
        "folds": fold_records,
        "foldThresholdAggregationForOptionalFinalCandidate": {
            "method": "forbidden: fold thresholds are not calibrated for an all-data fit",
            "threshold": None,
            "operationalThreshold": None,
            "calibrationRequired": True,
        },
    }
    if _has_recomputable_threshold_evidence(schema_version):
        model_record["thresholdFreeCombinedOofMetrics"] = (
            _combined_oof_threshold_free_metrics(samples, labels, probabilities)
        )
    if class_probabilities is not None:
        model_record["multiclassOofMetrics"] = _multiclass_classification_metrics(
            [sample.label for sample in samples], class_probabilities
        )
    return model_record, oof_rows


def _threshold_free_score_metrics(
    labels: np.ndarray, probabilities: np.ndarray
) -> dict[str, Any]:
    labels = np.asarray(labels, dtype=np.int64)
    probabilities = np.clip(
        np.asarray(probabilities, dtype=np.float64), 1e-7, 1.0 - 1e-7
    )
    if labels.ndim != 1 or labels.shape != probabilities.shape or not len(labels):
        raise BubbleFitTrainingError("cross-pack score arrays are invalid")
    positives = probabilities[labels == 1]
    negatives = probabilities[labels == 0]
    roc_auc = None
    if len(positives) and len(negatives):
        comparisons = positives[:, None] - negatives[None, :]
        roc_auc = float(
            (
                np.count_nonzero(comparisons > 0)
                + 0.5 * np.count_nonzero(comparisons == 0)
            )
            / comparisons.size
        )
    average_precision = None
    if len(positives):
        order = np.argsort(-probabilities, kind="stable")
        ordered_labels = labels[order]
        cumulative = np.cumsum(ordered_labels == 1)
        positive_positions = np.flatnonzero(ordered_labels == 1)
        average_precision = float(
            np.mean(cumulative[positive_positions] / (positive_positions + 1))
        )
    return {
        "rocAuc": roc_auc,
        "averagePrecision": average_precision,
        "brierScore": float(np.mean((probabilities - labels) ** 2)),
        "logLoss": float(
            -np.mean(
                labels * np.log(probabilities) + (1 - labels) * np.log1p(-probabilities)
            )
        ),
        "safeCount": int(np.count_nonzero(labels == 1)),
        "unsafeCount": int(np.count_nonzero(labels == 0)),
        "thresholdSelectedOnTarget": False,
        "evaluationRole": "threshold-free exploratory target-pack diagnostics",
        "confirmatory": False,
    }


def _combined_oof_threshold_free_metrics(
    samples: Sequence[TrainingSample],
    labels: np.ndarray,
    probabilities: np.ndarray,
) -> dict[str, Any]:
    """Return sealed ranking diagnostics that never depend on a threshold.

    Candidate metrics remain work-clustered exploratory evidence.  Work-macro AUC
    averages only works containing both safe and unsafe rows, and reports every
    omitted single-class work explicitly instead of silently assigning a value.
    """

    candidate_metrics = _threshold_free_score_metrics(labels, probabilities)
    per_work: list[dict[str, Any]] = []
    defined_auc: list[float] = []
    for work_id in sorted({sample.work_id for sample in samples}):
        indices = np.asarray(
            [
                index
                for index, sample in enumerate(samples)
                if sample.work_id == work_id
            ],
            dtype=np.int64,
        )
        work_metrics = _threshold_free_score_metrics(
            labels[indices], probabilities[indices]
        )
        work_auc = work_metrics["rocAuc"]
        if work_auc is not None:
            defined_auc.append(float(work_auc))
        per_work.append(
            {
                "workId": work_id,
                "candidateCount": len(indices),
                "safeCount": work_metrics["safeCount"],
                "unsafeCount": work_metrics["unsafeCount"],
                "rocAuc": work_auc,
            }
        )
    return {
        "evaluationRole": (
            "unkeyed producer-score evidence with recomputed threshold-free "
            "exploratory combined outer OOF diagnostics"
        ),
        "promotionAuthority": False,
        "confirmatory": False,
        "productionSafetyEstablished": False,
        "candidateLevel": {
            "rocAuc": candidate_metrics["rocAuc"],
            "averagePrecision": candidate_metrics["averagePrecision"],
            "brierScore": candidate_metrics["brierScore"],
            "logLoss": candidate_metrics["logLoss"],
            "safeCount": candidate_metrics["safeCount"],
            "unsafeCount": candidate_metrics["unsafeCount"],
            "candidateIndependenceAsserted": False,
        },
        "workMacroRocAuc": {
            "rocAuc": float(np.mean(defined_auc)) if defined_auc else None,
            "definedWorkCount": len(defined_auc),
            "undefinedSingleClassWorkCount": len(per_work) - len(defined_auc),
            "totalWorkCount": len(per_work),
            "perWork": per_work,
        },
    }


def _multiclass_classification_metrics(
    true_labels: Sequence[str], class_probabilities: np.ndarray
) -> dict[str, Any]:
    probabilities = np.asarray(class_probabilities, dtype=np.float64)
    if (
        probabilities.shape != (len(true_labels), len(ALLOWED_LABELS))
        or not len(true_labels)
        or not np.all(np.isfinite(probabilities))
        or np.any(probabilities < 0.0)
        or np.any(probabilities > 1.0)
        or not np.allclose(probabilities.sum(axis=1), 1.0, rtol=0.0, atol=1e-8)
    ):
        raise BubbleFitTrainingError("multiclass metric probabilities are invalid")
    try:
        targets = np.asarray(
            [CLASS_INDEX_BY_LABEL[label] for label in true_labels], dtype=np.int64
        )
    except KeyError as exc:
        raise BubbleFitTrainingError(
            f"multiclass metrics contain an unsupported label: {exc.args[0]}"
        ) from exc
    predicted = np.argmax(probabilities, axis=1)
    confusion = np.zeros((len(ALLOWED_LABELS), len(ALLOWED_LABELS)), dtype=np.int64)
    for actual, prediction in zip(targets, predicted, strict=True):
        confusion[int(actual), int(prediction)] += 1
    per_class: dict[str, Any] = {}
    recalls: list[float] = []
    for label, class_index in CLASS_INDEX_BY_LABEL.items():
        actual = targets == class_index
        selected = predicted == class_index
        true_positive = int(np.count_nonzero(actual & selected))
        candidate_count = int(np.count_nonzero(actual))
        predicted_count = int(np.count_nonzero(selected))
        recall = true_positive / candidate_count if candidate_count else None
        precision = true_positive / predicted_count if predicted_count else None
        if recall is not None:
            recalls.append(recall)
        one_vs_rest = _threshold_free_score_metrics(
            actual.astype(np.int64), probabilities[:, class_index]
        )
        per_class[label] = {
            "candidateCount": candidate_count,
            "predictedCount": predicted_count,
            "truePositiveCount": true_positive,
            "recall": recall,
            "precision": precision,
            "oneVsRestRocAuc": one_vs_rest["rocAuc"],
            "oneVsRestAveragePrecision": one_vs_rest["averagePrecision"],
            "oneVsRestBrierScore": one_vs_rest["brierScore"],
            "oneVsRestLogLoss": one_vs_rest["logLoss"],
        }
        if label != "safe_opaque":
            per_class[label]["predictedAsSafeCount"] = int(
                np.count_nonzero(actual & (predicted == SAFE_CLASS_INDEX))
            )
    safe_targets = (targets == SAFE_CLASS_INDEX).astype(np.int64)
    return {
        "evaluationRole": "exploratory five-class outer OOF diagnostics",
        "confirmatory": False,
        "productionSafetyEstablished": False,
        "classOrder": list(ALLOWED_LABELS),
        "safeClassIndex": SAFE_CLASS_INDEX,
        "safeScoreSource": "softmax_safe_opaque_probability",
        "candidateCount": len(true_labels),
        "accuracy": float(np.mean(predicted == targets)),
        "macroRecallDefinedClasses": float(np.mean(recalls)) if recalls else None,
        "confusionMatrix": {
            actual_label: {
                predicted_label: int(confusion[actual_index, predicted_index])
                for predicted_label, predicted_index in CLASS_INDEX_BY_LABEL.items()
            }
            for actual_label, actual_index in CLASS_INDEX_BY_LABEL.items()
        },
        "perClass": per_class,
        "unsafeSubtypeMetrics": {
            label: per_class[label]
            for label in ALLOWED_LABELS
            if label != "safe_opaque"
        },
        "productionSafeScoreMetrics": _threshold_free_score_metrics(
            safe_targets, probabilities[:, SAFE_CLASS_INDEX]
        ),
    }


def build_cross_pack_plan(
    snapshot: DatasetPackSetSnapshot,
    *,
    schema_version: int = PACK_SET_OUTPUT_SCHEMA_VERSION,
) -> dict[str, Any]:
    if not _is_pack_set_output_schema(schema_version):
        raise BubbleFitTrainingError("cross-pack plan requires a pack-set schema")
    directions: list[dict[str, Any]] = []
    if snapshot.input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION:
        by_role = {pack.role: pack for pack in snapshot.packs}
        if set(by_role) != {"old", "new"}:
            raise BubbleFitTrainingError("cross-pack plan requires old/new roles")
        works = {
            role: {
                sample.work_id
                for sample in snapshot.samples
                if sample.pack_role == role
            }
            for role in ("old", "new")
        }
        overlap = sorted(works["old"] & works["new"])
        for train_role, target_role in (("old", "new"), ("new", "old")):
            train_indices = [
                index
                for index, sample in enumerate(snapshot.samples)
                if sample.pack_role == train_role and sample.work_id not in overlap
            ]
            target_indices = [
                index
                for index, sample in enumerate(snapshot.samples)
                if sample.pack_role == target_role and sample.work_id not in overlap
            ]
            train_works = sorted(
                {snapshot.samples[index].work_id for index in train_indices}
            )
            target_works = sorted(
                {snapshot.samples[index].work_id for index in target_indices}
            )
            if (
                not train_indices
                or not target_indices
                or set(train_works) & set(target_works)
            ):
                raise BubbleFitTrainingError(
                    "cross-pack work-disjoint partition is empty or leaks"
                )
            train_keys = [
                f"{snapshot.samples[index].pack_id}:"
                f"{snapshot.samples[index].candidate_id}"
                for index in train_indices
            ]
            target_keys = [
                f"{snapshot.samples[index].pack_id}:"
                f"{snapshot.samples[index].candidate_id}"
                for index in target_indices
            ]
            directions.append(
                {
                    "directionId": f"{train_role}_to_{target_role}",
                    "trainRole": train_role,
                    "targetRole": target_role,
                    "trainPackId": by_role[train_role].pack_id,
                    "targetPackId": by_role[target_role].pack_id,
                    "excludedOverlapWorkIds": overlap,
                    "excludedOverlapWorkIdsSha256": _sha256_json(overlap),
                    "trainWorkIds": train_works,
                    "targetWorkIds": target_works,
                    "trainWorkIdsSha256": _sha256_json(train_works),
                    "targetWorkIdsSha256": _sha256_json(target_works),
                    "trainCandidateCount": len(train_indices),
                    "targetCandidateCount": len(target_indices),
                    "trainCandidateKeysSha256": _sha256_json(train_keys),
                    "targetCandidateKeysSha256": _sha256_json(target_keys),
                    "trainTargetWorkIntersection": [],
                    "targetLabelsUsedForFit": False,
                    "targetLabelsStructurallyAbsentFromFit": True,
                    "targetLabelsUsedForThreshold": False,
                    "targetLabelsUsedForMetricsOnly": True,
                    "promotionAuthority": False,
                    "confirmatory": False,
                }
            )
        evaluation_role = (
            "exploratory directional pack holdout with overlapping works excluded "
            "from both train and target"
        )
        external_view = None
    elif snapshot.input_schema_version == INPUT_PACK_SET_SCHEMA_VERSION:
        if len(snapshot.packs) < 3 or [pack.role for pack in snapshot.packs] != [
            "base"
        ] * (len(snapshot.packs) - 1) + ["incremental"]:
            raise BubbleFitTrainingError(
                "pack-set v2 external plan requires ordered base packs and one "
                "incremental pack"
            )
        base_packs = snapshot.packs[:-1]
        incremental_pack = snapshot.packs[-1]
        base_pack_ids = [pack.pack_id for pack in base_packs]
        existing_source_works = sorted(
            {
                work_id
                for pack in base_packs
                for work_id in pack.snapshot.source_work_ids
            }
        )
        incremental_source_works = sorted(incremental_pack.snapshot.source_work_ids)
        overlap = sorted(set(existing_source_works) & set(incremental_source_works))
        unseen_source_works = sorted(
            set(incremental_source_works) - set(existing_source_works)
        )
        train_indices = [
            index
            for index, sample in enumerate(snapshot.samples)
            if sample.pack_id in set(base_pack_ids)
        ]
        target_indices = [
            index
            for index, sample in enumerate(snapshot.samples)
            if sample.pack_id == incremental_pack.pack_id
            and sample.work_id in set(unseen_source_works)
        ]
        train_works = sorted(
            {snapshot.samples[index].work_id for index in train_indices}
        )
        target_works = sorted(
            {snapshot.samples[index].work_id for index in target_indices}
        )
        if not train_indices:
            raise BubbleFitTrainingError(
                "pack-set v2 external evaluation has no existing-pack training candidates"
            )
        if not target_indices:
            raise BubbleFitTrainingError(
                "pack-set v2 external evaluation has no source-work-unseen target "
                "candidates"
            )
        if set(train_works) & set(target_works):
            raise BubbleFitTrainingError(
                "pack-set v2 external evaluation leaks a raw workId"
            )
        train_keys = [
            f"{snapshot.samples[index].pack_id}:{snapshot.samples[index].candidate_id}"
            for index in train_indices
        ]
        target_keys = [
            f"{snapshot.samples[index].pack_id}:{snapshot.samples[index].candidate_id}"
            for index in target_indices
        ]
        directions.append(
            {
                "directionId": "base_to_incremental_source_work_unseen",
                "inputPackSetSchemaVersion": snapshot.input_schema_version,
                "evaluationViewKind": (
                    "existing-packs-to-source-work-unseen-new-pack-v1"
                ),
                "trainRole": "base",
                "targetRole": "incremental",
                "trainPackIds": base_pack_ids,
                "targetPackId": incremental_pack.pack_id,
                "existingSourceWorkIds": existing_source_works,
                "existingSourceWorkIdsSha256": _sha256_json(existing_source_works),
                "incrementalSourceWorkIds": incremental_source_works,
                "incrementalSourceWorkIdsSha256": _sha256_json(
                    incremental_source_works
                ),
                "sourceWorkUnseenTargetWorkIds": unseen_source_works,
                "sourceWorkUnseenTargetWorkIdsSha256": _sha256_json(
                    unseen_source_works
                ),
                "excludedOverlapWorkIds": overlap,
                "excludedOverlapWorkIdsSha256": _sha256_json(overlap),
                "trainWorkIds": train_works,
                "targetWorkIds": target_works,
                "trainWorkIdsSha256": _sha256_json(train_works),
                "targetWorkIdsSha256": _sha256_json(target_works),
                "trainCandidateCount": len(train_indices),
                "targetCandidateCount": len(target_indices),
                "trainCandidateKeysSha256": _sha256_json(train_keys),
                "targetCandidateKeysSha256": _sha256_json(target_keys),
                "trainTargetWorkIntersection": [],
                "rawWorkIdGroupedAcrossAllPacks": True,
                "overlapNewPackPagesGroupedOofOnly": True,
                "targetLabelsUsedForFit": False,
                "targetLabelsStructurallyAbsentFromFit": True,
                "targetLabelsUsedForThreshold": False,
                "targetLabelsUsedForMetricsOnly": True,
                "promotionAuthority": False,
                "confirmatory": False,
            }
        )
        evaluation_role = (
            "exploratory external incremental-pack holdout; train on ordered existing "
            "packs and evaluate only source-work-unseen new-pack candidates"
        )
        external_view = {
            "viewId": "base_to_incremental_source_work_unseen",
            "existingPackIds": base_pack_ids,
            "newPackId": incremental_pack.pack_id,
            "sourceWorkIdentity": "raw workId across every child pack",
            "existingSourceWorkIdsSha256": _sha256_json(existing_source_works),
            "newSourceWorkIdsSha256": _sha256_json(incremental_source_works),
            "unseenTargetSourceWorkIdsSha256": _sha256_json(unseen_source_works),
            "overlapSourceWorkIdsSha256": _sha256_json(overlap),
            "overlapNewPackPagesGroupedOofOnly": True,
            "targetLabelsUsedForFit": False,
            "promotionAuthority": False,
        }
    else:
        raise BubbleFitTrainingError("unsupported input pack-set schema")
    payload = {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        "confirmatory": False,
        "evaluationRole": evaluation_role,
        "inputPackSetCanonicalSha256": snapshot.pack_set_canonical_sha256,
        "affectsCombinedModelRanking": False,
        "promotionAuthority": False,
        "directions": directions,
    }
    if external_view is not None:
        payload["inputPackSetSchemaVersion"] = snapshot.input_schema_version
        payload["externalEvaluationView"] = external_view
    payload["planBindingSha256"] = _sha256_json(payload)
    return payload


def _cross_pack_indices(
    snapshot: DatasetPackSetSnapshot,
    direction: Mapping[str, Any],
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    excluded = set(direction["excludedOverlapWorkIds"])
    raw_train_pack_ids = direction.get("trainPackIds")
    if raw_train_pack_ids is not None:
        if (
            snapshot.input_schema_version != INPUT_PACK_SET_SCHEMA_VERSION
            or not isinstance(raw_train_pack_ids, list)
            or not raw_train_pack_ids
            or any(
                not isinstance(value, str) or not value for value in raw_train_pack_ids
            )
            or len(set(raw_train_pack_ids)) != len(raw_train_pack_ids)
        ):
            raise BubbleFitTrainingError(
                "cross-pack external train pack identity is invalid"
            )
        target_pack_id = _require_string(
            direction.get("targetPackId"), "crossPack.targetPackId"
        )
        target_work_ids = direction.get("targetWorkIds")
        if (
            not isinstance(target_work_ids, list)
            or not target_work_ids
            or any(not isinstance(value, str) or not value for value in target_work_ids)
            or set(target_work_ids) & excluded
        ):
            raise BubbleFitTrainingError(
                "cross-pack external target work identity is invalid"
            )
        train_pack_ids = set(raw_train_pack_ids)
        target_work_id_set = set(target_work_ids)
        train = tuple(
            index
            for index, sample in enumerate(snapshot.samples)
            if sample.pack_id in train_pack_ids
        )
        target = tuple(
            index
            for index, sample in enumerate(snapshot.samples)
            if sample.pack_id == target_pack_id and sample.work_id in target_work_id_set
        )
    else:
        train = tuple(
            index
            for index, sample in enumerate(snapshot.samples)
            if sample.pack_role == direction["trainRole"]
            and sample.work_id not in excluded
        )
        target = tuple(
            index
            for index, sample in enumerate(snapshot.samples)
            if sample.pack_role == direction["targetRole"]
            and sample.work_id not in excluded
        )
    return train, target


def _cross_label_class_counts(samples: Sequence[TrainingSample]) -> dict[str, int]:
    return {
        label: sum(sample.label == label for sample in samples)
        for label in ALLOWED_LABELS
    }


def _cross_direction_identity_fields(direction: Mapping[str, Any]) -> dict[str, Any]:
    target_pack_id = _require_string(
        direction.get("targetPackId"), "crossPack.targetPackId"
    )
    if "trainPackIds" in direction:
        train_pack_ids = direction.get("trainPackIds")
        if (
            not isinstance(train_pack_ids, list)
            or not train_pack_ids
            or any(not isinstance(value, str) or not value for value in train_pack_ids)
            or len(set(train_pack_ids)) != len(train_pack_ids)
        ):
            raise BubbleFitTrainingError(
                "cross-pack external train pack identity is invalid"
            )
        if direction.get("inputPackSetSchemaVersion") != INPUT_PACK_SET_SCHEMA_VERSION:
            raise BubbleFitTrainingError(
                "cross-pack external input schema identity is invalid"
            )
        return {
            "inputPackSetSchemaVersion": INPUT_PACK_SET_SCHEMA_VERSION,
            "trainPackIds": list(train_pack_ids),
            "targetPackId": target_pack_id,
        }
    return {
        "trainPackId": _require_string(
            direction.get("trainPackId"), "crossPack.trainPackId"
        ),
        "targetPackId": target_pack_id,
    }


def _cross_direction_diagnostic_role(snapshot: DatasetPackSetSnapshot) -> str:
    if snapshot.input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION:
        return "exploratory cross-pack work-disjoint target diagnostics"
    return "exploratory source-work-unseen incremental-pack external target diagnostics"


def _cross_prediction_role(snapshot: DatasetPackSetSnapshot) -> str:
    if snapshot.input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION:
        return "exploratory cross-pack work-disjoint target prediction"
    return "exploratory source-work-unseen incremental-pack external target prediction"


def _cross_report_role(snapshot: DatasetPackSetSnapshot) -> str:
    if snapshot.input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION:
        return (
            "exploratory directional pack holdout; overlapping works excluded "
            "symmetrically"
        )
    return (
        "exploratory external incremental-pack holdout; target works are unseen in "
        "every existing source pack"
    )


CROSS_PARTITION_VARIANT_FIELDS = frozenset(
    {
        "overlappingWorkExcludedFromTrainAndTarget",
        "sourceWorkUnseenFromAllExistingPacks",
        "overlapNewPackPagesGroupedOofOnly",
    }
)
CROSS_IDENTITY_VARIANT_FIELDS = frozenset(
    {"inputPackSetSchemaVersion", "trainPackId", "trainPackIds"}
)


def _cross_partition_row_fields(
    snapshot: DatasetPackSetSnapshot,
) -> dict[str, bool]:
    if snapshot.input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION:
        return {"overlappingWorkExcludedFromTrainAndTarget": True}
    return {
        "sourceWorkUnseenFromAllExistingPacks": True,
        "overlapNewPackPagesGroupedOofOnly": True,
    }


def _cross_identity_matches(
    payload: Mapping[str, Any], direction: Mapping[str, Any]
) -> bool:
    expected = _cross_direction_identity_fields(direction)
    if any(payload.get(key) != value for key, value in expected.items()):
        return False
    alternate = "trainPackId" if "trainPackIds" in expected else "trainPackIds"
    if alternate in payload:
        return False
    if "trainPackIds" not in expected and "inputPackSetSchemaVersion" in payload:
        return False
    return True


def _cross_partition_row_matches(
    snapshot: DatasetPackSetSnapshot, payload: Mapping[str, Any]
) -> bool:
    expected = _cross_partition_row_fields(snapshot)
    if any(payload.get(key) is not value for key, value in expected.items()):
        return False
    return not any(
        key in payload for key in CROSS_PARTITION_VARIANT_FIELDS - set(expected)
    )


def _cross_direction_report_variant_matches(
    payload: Mapping[str, Any], direction: Mapping[str, Any]
) -> bool:
    return _cross_identity_matches(payload, direction) and not any(
        key in payload for key in CROSS_PARTITION_VARIANT_FIELDS
    )


def _unsupported_multiclass_cross_record(
    *,
    direction: Mapping[str, Any],
    train_candidate_count: int,
    target_samples: Sequence[TrainingSample],
    missing_classes: Sequence[str],
    reason: str,
) -> dict[str, Any]:
    return {
        "directionId": direction["directionId"],
        **_cross_direction_identity_fields(direction),
        "excludedOverlapWorkIdsSha256": direction["excludedOverlapWorkIdsSha256"],
        "trainWorkIdsSha256": direction["trainWorkIdsSha256"],
        "targetWorkIdsSha256": direction["targetWorkIdsSha256"],
        "trainCandidateCount": train_candidate_count,
        "targetCandidateCount": len(target_samples),
        "trainTargetWorkIntersection": [],
        "targetLabelsUsedForFit": False,
        "targetLabelsStructurallyAbsentFromFit": True,
        "targetLabelsUsedForThreshold": False,
        "targetLabelsUsedForMetricsOnly": False,
        "status": "unsupported_missing_training_classes",
        "supported": False,
        "missingTrainingClasses": list(missing_classes),
        "predictionCount": 0,
        "targetLabelClassCounts": _cross_label_class_counts(target_samples),
        "sourceThreshold": None,
        "decisionAvailable": False,
        "sourceThresholdSelection": {
            "status": "unsupported_missing_training_classes",
            "innerThresholdAvailable": False,
            "selectedThreshold": None,
            "selectedMetrics": None,
            "reason": reason,
            "thresholdRole": "unavailable because five-class fit is unsupported",
            "targetLabelsUsed": False,
            "confirmatory": False,
            "productionSafetyEstablished": False,
        },
        "sourceInnerWorkDisjointFolds": [],
        "targetFit": None,
        "targetThresholdFreeMetrics": None,
        "targetDecisionMetrics": None,
        "targetWorkMacroMetrics": None,
        "targetConfidenceMetrics": None,
        "targetUnsafeSubtypeFalseAcceptMetrics": None,
        "targetMulticlassMetrics": None,
        "evaluationRole": (
            "unsupported exploratory cross-pack five-class direction; no fit or "
            "prediction was performed"
        ),
        "affectsCombinedModelRanking": False,
        "promotionAuthority": False,
        "confirmatory": False,
        "productionSafetyEstablished": False,
    }


def evaluate_cross_pack_directions(
    *,
    snapshot: DatasetPackSetSnapshot,
    plan: Mapping[str, Any],
    model_kinds: Sequence[str],
    inputs: np.ndarray,
    labels: np.ndarray,
    config: EvaluationConfig,
    weight_bundle: MobileNetWeightBundle | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    model_records: list[dict[str, Any]] = []
    prediction_rows: list[dict[str, Any]] = []
    schema_version = plan.get("schemaVersion")
    if not isinstance(schema_version, int) or not _is_pack_set_output_schema(
        schema_version
    ):
        raise BubbleFitTrainingError("cross-pack evaluation schema is invalid")
    directions = plan.get("directions")
    expected_direction_count = (
        2
        if snapshot.input_schema_version == LEGACY_INPUT_PACK_SET_SCHEMA_VERSION
        else 1
    )
    if not isinstance(directions, list) or len(directions) != expected_direction_count:
        raise BubbleFitTrainingError("cross-pack plan directions are invalid")
    for model_kind in model_kinds:
        direction_records: list[dict[str, Any]] = []
        for direction in directions:
            if not isinstance(direction, Mapping):
                raise BubbleFitTrainingError("cross-pack direction is invalid")
            train_indices, target_indices = _cross_pack_indices(snapshot, direction)
            train_works = {snapshot.samples[index].work_id for index in train_indices}
            target_works = {snapshot.samples[index].work_id for index in target_indices}
            if train_works & target_works:
                raise BubbleFitTrainingError("cross-pack model evaluation leaks a work")
            source_samples = [snapshot.samples[index] for index in train_indices]
            target_samples = [snapshot.samples[index] for index in target_indices]
            source_inputs = inputs[np.asarray(train_indices, dtype=np.int64)]
            source_labels = labels[np.asarray(train_indices, dtype=np.int64)]
            source_class_targets = _multiclass_targets(source_samples)
            source_local_indices = tuple(range(len(train_indices)))
            if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
                missing = _missing_multiclass_training_classes(
                    source_local_indices, source_class_targets
                )
                if missing:
                    direction_records.append(
                        _unsupported_multiclass_cross_record(
                            direction=direction,
                            train_candidate_count=len(train_indices),
                            target_samples=target_samples,
                            missing_classes=missing,
                            reason=(
                                "source-unique cross-pack training cohort omits "
                                + ", ".join(missing)
                            ),
                        )
                    )
                    continue
            pseudo_fold = GroupFold(
                fold_id=f"cross-{direction['directionId']}",
                holdout_work_ids=(),
                train_indices=source_local_indices,
                test_indices=(),
            )
            threshold: float | None = None
            inner_records: list[dict[str, Any]] = []
            source_probabilities: np.ndarray | None = None
            try:
                source_probabilities, inner_records = _inner_cross_fitted_probabilities(
                    model_kind,
                    pseudo_fold,
                    source_samples,
                    source_inputs,
                    source_labels,
                    config,
                    weight_bundle,
                )
                threshold, threshold_record = select_safety_threshold(
                    source_labels,
                    source_probabilities,
                    unsafe_false_accept_target=config.unsafe_false_accept_target,
                    minimum_coverage=config.minimum_coverage,
                    minimum_accepted_safe=config.minimum_accepted_safe,
                )
            except UnsupportedMulticlassFoldError as exc:
                threshold_record = {
                    "status": "noSourceThresholdAvailable",
                    "innerThresholdAvailable": False,
                    "selectedThreshold": None,
                    "selectedMetrics": None,
                    "reason": str(exc),
                    "thresholdRole": (
                        "source-pack work-disjoint selection diagnostic only"
                    ),
                    "targetLabelsUsed": False,
                    "confirmatory": False,
                    "productionSafetyEstablished": False,
                }
            except FoldClassError as exc:
                threshold_record = {
                    "status": "noSourceThresholdAvailable",
                    "innerThresholdAvailable": False,
                    "selectedThreshold": None,
                    "selectedMetrics": None,
                    "reason": str(exc),
                    "thresholdRole": (
                        "source-pack work-disjoint selection diagnostic only"
                    ),
                    "targetLabelsUsed": False,
                    "confirmatory": False,
                    "productionSafetyEstablished": False,
                }
            target_inputs = inputs[np.asarray(target_indices, dtype=np.int64)]
            fit_inputs = np.concatenate((source_inputs, target_inputs), axis=0)
            fit_labels = np.concatenate(
                (
                    source_labels,
                    np.full(len(target_indices), -1, dtype=np.int64),
                )
            )
            fit_class_targets = np.concatenate(
                (
                    source_class_targets,
                    np.full(len(target_indices), -1, dtype=np.int64),
                )
            )
            target_local_indices = tuple(
                range(len(train_indices), len(train_indices) + len(target_indices))
            )
            target_probabilities, target_fit = _fit_predict_split(
                model_kind,
                source_local_indices,
                target_local_indices,
                fit_inputs,
                fit_labels,
                config,
                weight_bundle,
                _derived_seed(
                    config.seed,
                    model_kind,
                    str(direction["directionId"]),
                    "cross-target-fit",
                ),
                fit_class_targets,
            )
            target_fit, target_class_probabilities = _extract_class_probabilities(
                model_kind,
                target_fit,
                expected_count=len(target_indices),
            )
            target_labels = labels[np.asarray(target_indices, dtype=np.int64)]
            if target_class_probabilities is not None and not np.allclose(
                target_probabilities,
                target_class_probabilities[:, SAFE_CLASS_INDEX],
                rtol=0.0,
                atol=1e-12,
            ):
                raise BubbleFitTrainingError(
                    "cross five-class safe score differs from class probability"
                )
            decision_available = np.full(
                len(target_indices), threshold is not None, dtype=bool
            )
            predicted_safe = (
                target_probabilities >= float(threshold)
                if threshold is not None
                else np.zeros(len(target_indices), dtype=bool)
            )
            decision_metrics = _decision_metrics_for_selector(
                target_labels,
                predicted_safe,
                decision_available,
                np.ones(len(target_indices), dtype=bool),
            )
            work_macro = _work_macro_metrics(
                target_samples,
                target_labels,
                predicted_safe,
                decision_available,
            )
            confidence_metrics, subtype_metrics = _confidence_and_subtype_metrics(
                target_samples,
                target_labels,
                predicted_safe,
                decision_available,
            )
            direction_record = {
                "directionId": direction["directionId"],
                **_cross_direction_identity_fields(direction),
                "excludedOverlapWorkIdsSha256": direction[
                    "excludedOverlapWorkIdsSha256"
                ],
                "trainWorkIdsSha256": direction["trainWorkIdsSha256"],
                "targetWorkIdsSha256": direction["targetWorkIdsSha256"],
                "trainCandidateCount": len(train_indices),
                "targetCandidateCount": len(target_indices),
                "trainTargetWorkIntersection": [],
                "targetLabelsUsedForFit": False,
                "targetLabelsStructurallyAbsentFromFit": True,
                "targetLabelsUsedForThreshold": False,
                "targetLabelsUsedForMetricsOnly": True,
                "sourceThreshold": threshold,
                "decisionAvailable": threshold is not None,
                "sourceThresholdSelection": threshold_record,
                "sourceInnerWorkDisjointFolds": inner_records,
                "targetFit": target_fit,
                "targetThresholdFreeMetrics": _threshold_free_score_metrics(
                    target_labels, target_probabilities
                ),
                "targetDecisionMetrics": decision_metrics,
                "targetWorkMacroMetrics": work_macro,
                "targetConfidenceMetrics": confidence_metrics,
                "targetUnsafeSubtypeFalseAcceptMetrics": subtype_metrics,
                "evaluationRole": _cross_direction_diagnostic_role(snapshot),
                "affectsCombinedModelRanking": False,
                "promotionAuthority": False,
                "confirmatory": False,
                "productionSafetyEstablished": False,
            }
            if _has_recomputable_threshold_evidence(schema_version):
                direction_record.update(
                    {
                        "sourceThresholdSelectionSafeProbabilities": (
                            [float(value) for value in source_probabilities]
                            if source_probabilities is not None
                            else None
                        ),
                        "sourceThresholdSelectionEvidenceRole": (
                            "unkeyed producer evidence: sealed source-pack inner "
                            "work-disjoint OOF probabilities in cross-plan "
                            "train-candidate order; validator recomputes dependent "
                            "sourceThresholdSelection but does not reexecute the "
                            "neural fold model"
                        ),
                    }
                )
            if target_class_probabilities is not None:
                direction_record.update(
                    {
                        "status": "evaluated",
                        "supported": True,
                        "missingTrainingClasses": [],
                        "predictionCount": len(target_indices),
                        "targetLabelClassCounts": _cross_label_class_counts(
                            target_samples
                        ),
                        "targetMulticlassMetrics": (
                            _multiclass_classification_metrics(
                                [sample.label for sample in target_samples],
                                target_class_probabilities,
                            )
                        ),
                    }
                )
            direction_records.append(direction_record)
            for local_index, sample_index in enumerate(target_indices):
                sample = snapshot.samples[sample_index]
                prediction_row = {
                    "schemaVersion": schema_version,
                    "toolId": TOOL_ID,
                    "promotionEligible": False,
                    "productionUseForbidden": True,
                    "productionSafetyEstablished": False,
                    "runtimePreprocessorParity": False,
                    "exactProductionFloodParity": False,
                    "confirmatory": False,
                    "evaluationRole": _cross_prediction_role(snapshot),
                    "promotionAuthority": False,
                    "modelKind": model_kind,
                    "directionId": direction["directionId"],
                    **_cross_direction_identity_fields(direction),
                    "packId": sample.pack_id,
                    "packRole": sample.pack_role,
                    "candidateId": sample.candidate_id,
                    "candidateKey": f"{sample.pack_id}:{sample.candidate_id}",
                    "sourceOrdinal": sample.ordinal,
                    "sourceSelectionIndex": sample.selection_index,
                    "combinedOrdinal": sample.combined_ordinal,
                    "workId": sample.work_id,
                    "label": sample.label,
                    "safeForBubbleFit": sample.safe,
                    "safeProbability": float(target_probabilities[local_index]),
                    "sourceThreshold": threshold,
                    "decisionAvailable": threshold is not None,
                    "predictedSafe": (
                        bool(predicted_safe[local_index])
                        if threshold is not None
                        else None
                    ),
                    **_cross_partition_row_fields(snapshot),
                    "targetLabelsUsedForFit": False,
                    "targetLabelsStructurallyAbsentFromFit": True,
                    "targetLabelsUsedForThreshold": False,
                    "targetLabelsUsedForMetricsOnly": True,
                }
                if target_class_probabilities is not None:
                    prediction_row.update(
                        {
                            "classProbabilities": {
                                label: float(
                                    target_class_probabilities[local_index, class_index]
                                )
                                for label, class_index in CLASS_INDEX_BY_LABEL.items()
                            },
                            "predictedClass": ALLOWED_LABELS[
                                int(np.argmax(target_class_probabilities[local_index]))
                            ],
                            "safeScoreSource": ("softmax_safe_opaque_probability"),
                        }
                    )
                prediction_rows.append(prediction_row)
        model_records.append(
            {
                "modelKind": model_kind,
                "directions": direction_records,
                "affectsCombinedModelRanking": False,
                "promotionAuthority": False,
                "confirmatory": False,
                "productionSafetyEstablished": False,
            }
        )
    report = {
        "evaluationRole": (_cross_report_role(snapshot)),
        "modelKinds": list(model_kinds),
        "affectsCombinedModelRanking": False,
        "promotionAuthority": False,
        "confirmatory": False,
        "productionSafetyEstablished": False,
        "models": model_records,
    }
    if snapshot.input_schema_version == INPUT_PACK_SET_SCHEMA_VERSION:
        report["inputPackSetSchemaVersion"] = snapshot.input_schema_version
    return report, prediction_rows


def rank_model_records(
    records: Sequence[Mapping[str, Any]],
    *,
    schema_version: int = PACK_SET_OUTPUT_SCHEMA_VERSION,
) -> list[str]:
    def legacy_key(
        record: Mapping[str, Any],
    ) -> tuple[float, float, float, float, float, str]:
        metrics = record["outerOofMetrics"]
        exploratory_target_met = bool(metrics.get("outerExploratoryTargetMet"))
        false_accept_upper = metrics.get("candidateLevelDiagnosticUpper95")
        precision = metrics.get("safePrecision")
        recall = metrics.get("safeRecall")
        coverage = metrics.get("coverage")
        return (
            0.0 if exploratory_target_met else 1.0,
            float(false_accept_upper) if false_accept_upper is not None else 1.0,
            -(float(precision) if precision is not None else 0.0),
            -(float(recall) if recall is not None else 0.0),
            -(float(coverage) if coverage is not None else 0.0),
            str(record["modelKind"]),
        )

    if schema_version in {
        SCHEMA_VERSION,
        LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
    }:
        ordered = sorted(records, key=legacy_key)
    else:

        def evidence_key(
            indexed_record: tuple[int, Mapping[str, Any]],
        ) -> tuple[float, ...]:
            index, record = indexed_record
            metrics = record["outerOofMetrics"]
            exploratory_target_met = bool(metrics.get("outerExploratoryTargetMet"))
            evaluated = int(metrics.get("evaluatedCandidateCount") or 0)
            false_accept_upper = metrics.get("candidateLevelDiagnosticUpper95")
            precision = metrics.get("safePrecision")
            recall = metrics.get("safeRecall")
            coverage = metrics.get("coverage")
            threshold_free = record.get("thresholdFreeCombinedOofMetrics")
            candidate_level = (
                threshold_free.get("candidateLevel")
                if isinstance(threshold_free, Mapping)
                else None
            )
            work_macro = (
                threshold_free.get("workMacroRocAuc")
                if isinstance(threshold_free, Mapping)
                else None
            )
            work_auc = (
                work_macro.get("rocAuc") if isinstance(work_macro, Mapping) else None
            )
            roc_auc = (
                candidate_level.get("rocAuc")
                if isinstance(candidate_level, Mapping)
                else None
            )
            average_precision = (
                candidate_level.get("averagePrecision")
                if isinstance(candidate_level, Mapping)
                else None
            )
            return (
                0.0 if exploratory_target_met else 1.0,
                0.0 if evaluated > 0 else 1.0,
                (float(false_accept_upper) if false_accept_upper is not None else 1.0),
                -(float(precision) if precision is not None else -1.0),
                -(float(recall) if recall is not None else -1.0),
                -(float(coverage) if coverage is not None else -1.0),
                -(float(work_auc) if work_auc is not None else -1.0),
                -(float(roc_auc) if roc_auc is not None else -1.0),
                -(float(average_precision) if average_precision is not None else -1.0),
                float(index),
            )

        ordered = [
            record for _index, record in sorted(enumerate(records), key=evidence_key)
        ]
    return [str(record["modelKind"]) for record in ordered]


def _ranking_status(schema_version: int) -> str:
    if _has_recomputable_threshold_evidence(schema_version):
        return (
            "models meeting every outer exploratory target check rank first; "
            "decision-bearing evidence ranks ahead of no-decision evidence, then "
            "sealed threshold-free OOF diagnostics break remaining ties without "
            "using filenames; this ordering is model-development evidence, not "
            "production safety evidence"
        )
    return (
        "models meeting every outer exploratory target check rank first; this "
        "ordering is model-development evidence, not production safety evidence"
    )


ONNX_METADATA = {
    "toolId": TOOL_ID,
    "promotionEligible": "false",
    "productionUseForbidden": "true",
    "inputChannels": "RGB+candidate_core_mask",
    "outputSemantics": "sigmoid_safe_probability",
    "thresholdSpace": "probability",
    "cleanedPixelsUsed": "false",
    "runtimePreprocessorParity": "false",
    "exactProductionFloodParity": "false",
    "calibrationRequired": "true",
    "confirmatory": "false",
    "productionSafetyEstablished": "false",
    "lockedWorkClusterAuditRequired": "true",
}


def _onnx_parity_input() -> np.ndarray:
    values = np.zeros((2, 4, IMAGE_SIZE, IMAGE_SIZE), dtype=np.float32)
    horizontal = np.linspace(-2.0, 2.0, IMAGE_SIZE, dtype=np.float32)
    vertical = np.linspace(-1.5, 1.5, IMAGE_SIZE, dtype=np.float32)
    values[0, 0] = horizontal[None, :]
    values[0, 1] = vertical[:, None]
    values[0, 2] = (horizontal[None, :] + vertical[:, None]) / np.float32(2.0)
    values[0, 3, 48:176, 64:160] = 1.0
    values[1, 0] = vertical[:, None]
    values[1, 1] = -horizontal[None, :]
    values[1, 2] = np.float32(0.25)
    values[1, 3, 32:192:2, 40:184] = 1.0
    return values


def export_onnx_candidate(model: Any, path: Path) -> dict[str, Any]:
    try:
        import onnx
        import torch
    except ImportError as exc:
        raise BubbleFitTrainingError(
            f"ONNX export dependencies unavailable: {exc}"
        ) from exc
    model = model.cpu().eval()

    class SafeProbabilityModule(torch.nn.Module):
        def __init__(self, source: Any) -> None:
            super().__init__()
            self.source = source

        def forward(self, value: Any) -> Any:
            return torch.sigmoid(self.source(value))

    export_model = SafeProbabilityModule(model).eval()
    dummy = torch.zeros((1, 4, IMAGE_SIZE, IMAGE_SIZE), dtype=torch.float32)
    torch.onnx.export(
        export_model,
        dummy,
        path,
        input_names=["input"],
        output_names=["safe_probability"],
        dynamic_axes={"input": {0: "batch"}, "safe_probability": {0: "batch"}},
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    graph = onnx.load(path)
    onnx.helper.set_model_props(
        graph,
        ONNX_METADATA,
    )
    onnx.save(graph, path)
    contract = assert_onnx_input_contract(path, model)
    return {**contract, "sha256": _sha256_file(path), "sizeBytes": path.stat().st_size}


def _dimension_value(dimension: Any) -> int | str | None:
    if dimension.HasField("dim_value"):
        return int(dimension.dim_value)
    if dimension.HasField("dim_param"):
        return str(dimension.dim_param)
    return None


def assert_onnx_input_contract(path: Path, pytorch_model: Any) -> dict[str, Any]:
    try:
        import onnx
        import onnxruntime as ort
        import torch
        from onnx import TensorProto
    except ImportError as exc:
        raise BubbleFitTrainingError(f"onnx is unavailable: {exc}") from exc
    graph = onnx.load(path)
    onnx.checker.check_model(graph)
    if len(graph.graph.input) != 1 or len(graph.graph.output) != 1:
        raise BubbleFitTrainingError("ONNX gate must have exactly one input/output")
    input_value = graph.graph.input[0]
    output_value = graph.graph.output[0]
    if input_value.name != "input" or output_value.name != "safe_probability":
        raise BubbleFitTrainingError("ONNX gate input/output names are invalid")
    input_type = input_value.type.tensor_type
    output_type = output_value.type.tensor_type
    if (
        input_type.elem_type != TensorProto.FLOAT
        or output_type.elem_type != TensorProto.FLOAT
    ):
        raise BubbleFitTrainingError("ONNX gate input/output must be float32")
    input_dims = [_dimension_value(item) for item in input_type.shape.dim]
    output_dims = [_dimension_value(item) for item in output_type.shape.dim]
    if input_dims != ["batch", 4, IMAGE_SIZE, IMAGE_SIZE]:
        raise BubbleFitTrainingError(
            f"ONNX input must be [batch,4,224,224], got {input_dims}"
        )
    if output_dims != ["batch", 1]:
        raise BubbleFitTrainingError(
            f"ONNX output must be [batch,1], got {output_dims}"
        )
    metadata = {item.key: item.value for item in graph.metadata_props}
    if metadata != ONNX_METADATA:
        raise BubbleFitTrainingError("ONNX safety metadata is invalid")
    opsets = {item.domain: int(item.version) for item in graph.opset_import}
    if opsets != {"": 17}:
        raise BubbleFitTrainingError(f"ONNX opset contract is invalid: {opsets}")
    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise BubbleFitTrainingError(
            "onnxruntime CPUExecutionProvider is required for numerical parity"
        )
    parity_input = _onnx_parity_input()
    pytorch_model = pytorch_model.cpu().eval()
    with torch.inference_mode():
        expected = (
            torch.sigmoid(pytorch_model(torch.from_numpy(parity_input)))
            .cpu()
            .numpy()
            .astype(np.float32)
        )
    try:
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        actual = np.asarray(
            session.run(["safe_probability"], {"input": parity_input})[0],
            dtype=np.float32,
        )
    except Exception as exc:
        raise BubbleFitTrainingError(
            f"ONNX Runtime parity execution failed: {exc}"
        ) from exc
    absolute_error = np.abs(actual - expected)
    max_absolute_error = float(np.max(absolute_error))
    denominator = np.maximum(np.abs(expected), np.float32(1e-7))
    max_relative_error = float(np.max(absolute_error / denominator))
    absolute_tolerance = 2e-5
    relative_tolerance = 2e-4
    if actual.shape != expected.shape or not np.allclose(
        actual,
        expected,
        atol=absolute_tolerance,
        rtol=relative_tolerance,
    ):
        raise BubbleFitTrainingError(
            "ONNX Runtime safe-probability output differs from PyTorch: "
            f"shape {actual.shape} vs {expected.shape}, "
            f"max abs {max_absolute_error}, max rel {max_relative_error}"
        )
    parity = {
        "provider": "CPUExecutionProvider",
        "sampleCount": len(parity_input),
        "outputSemantics": "sigmoid_safe_probability",
        "absoluteTolerance": absolute_tolerance,
        "relativeTolerance": relative_tolerance,
        "maxAbsoluteError": max_absolute_error,
        "maxRelativeError": max_relative_error,
        "onnxRuntimeVersion": ort.__version__,
        "passed": True,
    }
    return {
        "inputName": input_value.name,
        "inputShape": input_dims,
        "inputDtype": "float32",
        "outputName": output_value.name,
        "outputShape": output_dims,
        "outputDtype": "float32",
        "outputSemantics": "sigmoid_safe_probability",
        "opsetImports": opsets,
        "metadata": metadata,
        "numericalParity": parity,
    }


def _validate_final_candidate_files(
    *,
    output_dir: Path,
    contract: Mapping[str, Any],
    config: EvaluationConfig,
) -> None:
    try:
        import torch
    except ImportError as exc:
        raise BubbleFitTrainingError(
            f"PyTorch is required to validate final candidate state: {exc}"
        ) from exc
    model_kind = contract.get("modelKind")
    if model_kind not in EXPORTABLE_MODEL_KINDS:
        raise BubbleFitTrainingError("final candidate model kind is not exportable")
    state_record = contract.get("state")
    onnx_record = contract.get("onnx")
    if (
        not isinstance(state_record, Mapping)
        or set(state_record) != {"path", "sha256", "sizeBytes"}
        or state_record.get("path") != "final-candidate-state.pt"
        or not isinstance(onnx_record, Mapping)
        or onnx_record.get("path") != "final-candidate.onnx"
    ):
        raise BubbleFitTrainingError(
            "final candidate state/ONNX inventory contract is invalid"
        )
    state_path = output_dir / "final-candidate-state.pt"
    onnx_path = output_dir / "final-candidate.onnx"
    for path, record, label in (
        (state_path, state_record, "state"),
        (onnx_path, onnx_record, "ONNX"),
    ):
        if not path.is_file() or path.is_symlink():
            raise BubbleFitTrainingError(f"final candidate {label} is missing")
        if (
            record.get("sha256") != _sha256_file(path)
            or record.get("sizeBytes") != path.stat().st_size
        ):
            raise BubbleFitTrainingError(
                f"final candidate {label} direct hash/byte binding is invalid"
            )
    try:
        with state_path.open("rb") as handle:
            state_dict = torch.load(handle, map_location="cpu", weights_only=True)
    except Exception as exc:
        raise BubbleFitTrainingError(
            f"final candidate state could not be safely reopened: {exc}"
        ) from exc
    if not isinstance(state_dict, Mapping) or not state_dict:
        raise BubbleFitTrainingError("final candidate state dictionary is invalid")
    model = build_mobilenet_v3_small_gate(
        mode=str(model_kind),
        seed=config.seed,
        pretrained_state_dict=None,
    ).cpu()
    try:
        model.load_state_dict(state_dict, strict=True)
    except (RuntimeError, TypeError, ValueError) as exc:
        raise BubbleFitTrainingError(
            f"final candidate state does not match its declared architecture: {exc}"
        ) from exc
    try:
        recalculated_onnx = assert_onnx_input_contract(onnx_path, model)
    finally:
        del model
    expected_onnx_record = {
        "path": "final-candidate.onnx",
        **recalculated_onnx,
        "sha256": _sha256_file(onnx_path),
        "sizeBytes": onnx_path.stat().st_size,
    }
    if dict(onnx_record) != expected_onnx_record:
        raise BubbleFitTrainingError(
            "final candidate ONNX contract/parity receipt is not canonical"
        )


def _train_final_mobile_candidate(
    model_kind: str,
    inputs: np.ndarray,
    labels: np.ndarray,
    config: EvaluationConfig,
    weight_bundle: MobileNetWeightBundle,
    output_dir: Path,
    cohort_counts: Mapping[str, int],
    authority: Mapping[str, Any],
    authority_bindings: Mapping[str, Any],
    confirmatory_contract: Mapping[str, Any],
    *,
    schema_version: int = SCHEMA_VERSION,
    direct_authority_keys: Sequence[str] | None = None,
) -> dict[str, Any]:
    import torch

    if model_kind not in EXPORTABLE_MODEL_KINDS:
        raise BubbleFitTrainingError(
            "this model kind does not support non-promotable final/ONNX export"
        )

    indices = tuple(range(len(labels)))
    model, fit = _fit_mobile_model(
        model_kind,
        indices,
        inputs,
        labels,
        config,
        weight_bundle,
        _derived_seed(config.seed, model_kind, "final-all-data"),
    )
    if model is None:
        raise FoldClassError("all-data final candidate unexpectedly has one class")
    state_path = output_dir / "final-candidate-state.pt"
    onnx_path = output_dir / "final-candidate.onnx"
    torch.save(model.cpu().state_dict(), state_path)
    onnx_record = export_onnx_candidate(model, onnx_path)
    del model
    resolved_direct_keys = (
        tuple(direct_authority_keys)
        if direct_authority_keys is not None
        else AUTHORITY_DIRECT_KEYS
    )
    return {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "artifactKind": "optional all-data crude candidate",
        "modelKind": model_kind,
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "confirmatory": False,
        **_current_schema_contract_fields(schema_version),
        "currentRunRole": "diagnostic all-data export after exploratory development",
        "reason": (
            f"{cohort_counts['candidateCount']} candidates from "
            f"{cohort_counts['sourcePageCount']} source pages are insufficient for "
            "promotion, and runtime preprocessing/flood-mask parity is unsealed"
        ),
        "cohortCounts": dict(cohort_counts),
        "threshold": None,
        "operationalThreshold": None,
        "calibrationRequired": True,
        "thresholdOrigin": (
            "none; leakage-free fold thresholds are diagnostics for different fitted "
            "models and cannot calibrate this all-data model"
        ),
        "outputSemantics": "sigmoid_safe_probability",
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        "executionAuthority": dict(authority),
        "authorityBindings": dict(authority_bindings),
        **{key: authority_bindings[key] for key in resolved_direct_keys},
        "confirmatoryAuditContract": dict(confirmatory_contract),
        "fit": fit,
        "inputContract": production_input_contract(),
        "state": {
            "path": state_path.name,
            "sha256": _sha256_file(state_path),
            "sizeBytes": state_path.stat().st_size,
        },
        "onnx": {"path": onnx_path.name, **onnx_record},
        "officialWeights": dict(weight_bundle.provenance),
    }


def _validate_evaluation_config(config: EvaluationConfig) -> None:
    if config.seed < 0 or config.batch_size < 1:
        raise BubbleFitTrainingError("seed/batch size is invalid")
    if config.frozen_epochs < 1 or config.finetune_epochs < 1:
        raise BubbleFitTrainingError("training epochs must be positive")
    for name in (
        "frozen_learning_rate",
        "finetune_head_learning_rate",
        "finetune_feature_learning_rate",
        "weight_decay",
        "unsafe_loss_weight",
    ):
        if (
            not math.isfinite(float(getattr(config, name)))
            or float(getattr(config, name)) <= 0
        ):
            raise BubbleFitTrainingError(f"{name} must be positive and finite")
    if not 0 <= config.unsafe_false_accept_target <= 1:
        raise BubbleFitTrainingError("unsafe false-accept target must be in [0,1]")
    if not 0 < config.minimum_coverage <= 1:
        raise BubbleFitTrainingError("minimum coverage must be in (0,1]")
    if (
        isinstance(config.minimum_accepted_safe, bool)
        or not isinstance(config.minimum_accepted_safe, int)
        or config.minimum_accepted_safe < 1
    ):
        raise BubbleFitTrainingError("minimum accepted safe count must be positive")


def _artifact_stage(source_page_count: int, candidate_count: int) -> str:
    return f"crude_probe_{source_page_count}_pages_{candidate_count}_candidates"


def _promotion_block_reason(source_page_count: int, candidate_count: int) -> str:
    return (
        f"Only {candidate_count} candidates from {source_page_count} manually "
        "inspected source pages, with no sealed runtime preprocessor/flood-mask "
        "parity and no precommitted operational threshold; production promotion "
        "requires a later independent locked work-cluster audit"
    )


def _safety_evidence_limits(
    labels: np.ndarray, *, unsafe_false_accept_target: float
) -> dict[str, Any]:
    unsafe_count = int(np.count_nonzero(labels == 0))
    return {
        "unsafeCandidateCount": unsafe_count,
        "safeCandidateCount": int(np.count_nonzero(labels == 1)),
        "candidateLevelDiagnosticZeroFailureUpper95": (
            one_sided_binomial_upper_bound(0, unsafe_count)
        ),
        "unsafeFalseAcceptTarget": unsafe_false_accept_target,
        "candidateIndependenceAsserted": False,
        "confirmatory": False,
        "productionSafetyEstablished": False,
        "interpretation": (
            "Candidate rows are clustered within works. This nominal calculation "
            "is a development diagnostic and cannot establish a production target."
        ),
    }


def _runtime_versions_payload() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "pillow": Image.__version__,
        "platform": platform.platform(),
    }


def _ensure_new_output(path: Path) -> Path:
    path = path.resolve()
    if path.exists():
        if not path.is_dir():
            raise BubbleFitTrainingError(f"output is not a directory: {path}")
        try:
            next(path.iterdir())
        except StopIteration:
            pass
        else:
            raise BubbleFitTrainingError(
                f"output directory must be new or empty: {path}"
            )
    return path


AUTHORITY_DIRECT_KEYS = (
    "datasetManifestSha256",
    "datasetManifestBindingSha256",
    "datasetSealSha256",
    "artifactInventorySha256",
    "labelsSha256",
    "productionInputBindingSha256",
    "splitPlanSha256",
    "oofPredictionsSha256",
    "evaluationConfigCanonicalSha256",
    "inputContractCanonicalSha256",
    "runConfigurationCanonicalSha256",
    "confirmatoryAuditContractCanonicalSha256",
    "trainerScriptSha256",
    "gitCommit",
    "gitDirty",
    "gitPorcelainV1Sha256",
    "packageConfigCanonicalSha256",
    "rendererDependencyLockCanonicalSha256",
    "pythonRuntimeCanonicalSha256",
    "pythonProducerDistributionsCanonicalSha256",
    "pythonRepositoryLocksCanonicalSha256",
)

PACK_SET_AUTHORITY_DIRECT_KEYS = (
    "inputPackSetFileSha256",
    "inputPackSetCanonicalSha256",
    "inputPackSetBindingSha256",
    "sourcePacksCanonicalSha256",
    "productionInputBindingSha256",
    "crossPackPlanSha256",
    "crossPackPredictionsSha256",
    "splitPlanSha256",
    "oofPredictionsSha256",
    "evaluationConfigCanonicalSha256",
    "inputContractCanonicalSha256",
    "runConfigurationCanonicalSha256",
    "confirmatoryAuditContractCanonicalSha256",
    "trainerScriptSha256",
    "gitCommit",
    "gitDirty",
    "gitPorcelainV1Sha256",
    "packageConfigCanonicalSha256",
    "rendererDependencyLockCanonicalSha256",
    "pythonRuntimeCanonicalSha256",
    "pythonProducerDistributionsCanonicalSha256",
    "pythonRepositoryLocksCanonicalSha256",
)


def _authority_direct_keys_for_source(source: Mapping[str, Any]) -> tuple[str, ...]:
    if _is_pack_set_source_kind(source.get("sourceKind")):
        return PACK_SET_AUTHORITY_DIRECT_KEYS
    return AUTHORITY_DIRECT_KEYS


def _is_pack_set_source_kind(value: Any) -> bool:
    return isinstance(value, str) and value in PACK_SET_SOURCE_KINDS


def _assert_canonical_binding(payload: Mapping[str, Any], location: str) -> None:
    expected = _require_sha256(
        payload.get("bindingSha256"), f"{location}.bindingSha256"
    )
    content = dict(payload)
    content.pop("bindingSha256", None)
    if _sha256_json(content) != expected:
        raise BubbleFitTrainingError(f"{location} canonical binding SHA-256 mismatch")


def _assert_common_nonpromotable(
    payload: Mapping[str, Any],
    location: str,
    *,
    schema_version: int = SCHEMA_VERSION,
) -> None:
    expected = {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        "confirmatory": False,
    }
    mismatches = [key for key, value in expected.items() if payload.get(key) != value]
    if mismatches:
        raise BubbleFitTrainingError(
            f"{location} common non-promotable contract is invalid: "
            + ", ".join(mismatches)
        )


def _read_jsonl_objects(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise BubbleFitTrainingError(f"could not read {label}: {exc}") from exc
    if not lines:
        raise BubbleFitTrainingError(f"{label} is empty")
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise BubbleFitTrainingError(
                f"invalid {label} line {line_number}: {exc}"
            ) from exc
        if not isinstance(row, dict):
            raise BubbleFitTrainingError(
                f"{label} line {line_number} must be a JSON object"
            )
        rows.append(row)
    return rows


@dataclass(frozen=True)
class _ValidationMetricSample:
    work_id: str
    label: str
    confidence: str


def _assert_current_schema_contract_fields(
    payload: Mapping[str, Any], *, schema_version: int, location: str
) -> None:
    expected = _current_schema_contract_fields(schema_version)
    for key, value in expected.items():
        if payload.get(key) != value:
            raise BubbleFitTrainingError(
                f"{location} prediction evidence/schema compatibility contract "
                f"is invalid: {key}"
            )


def _assert_binary_metric_count_consistency(
    metrics: Any,
    *,
    safe_count: int,
    unsafe_count: int,
    threshold: float,
    location: str,
) -> None:
    if not isinstance(metrics, Mapping) or not isinstance(
        metrics.get("counts"), Mapping
    ):
        raise BubbleFitTrainingError(f"{location} metrics are invalid")
    counts = metrics["counts"]
    keys = {
        "trueSafeAccepted",
        "unsafeFalseAccepted",
        "unsafeRejected",
        "safeRejected",
        "predictedSafe",
        "total",
    }
    if set(counts) != keys or any(
        isinstance(counts.get(key), bool)
        or not isinstance(counts.get(key), int)
        or int(counts[key]) < 0
        for key in keys
    ):
        raise BubbleFitTrainingError(f"{location} metric counts are invalid")
    true_positive = int(counts["trueSafeAccepted"])
    false_positive = int(counts["unsafeFalseAccepted"])
    true_negative = int(counts["unsafeRejected"])
    false_negative = int(counts["safeRejected"])
    if (
        true_positive + false_negative != safe_count
        or false_positive + true_negative != unsafe_count
        or counts["predictedSafe"] != true_positive + false_positive
        or counts["total"] != safe_count + unsafe_count
    ):
        raise BubbleFitTrainingError(f"{location} metric counts are inconsistent")
    synthetic_labels = np.asarray(
        [1] * true_positive
        + [1] * false_negative
        + [0] * false_positive
        + [0] * true_negative,
        dtype=np.int64,
    )
    synthetic_probabilities = np.asarray(
        [1.0] * true_positive
        + [0.0] * false_negative
        + [1.0] * false_positive
        + [0.0] * true_negative,
        dtype=np.float64,
    )
    expected = _binary_metrics(synthetic_labels, synthetic_probabilities, 0.5)
    expected["threshold"] = threshold
    if dict(metrics) != expected:
        raise BubbleFitTrainingError(f"{location} metrics are not canonical")


def _assert_threshold_selection_binding(
    *,
    record: Mapping[str, Any],
    selected_threshold: float | None,
    labels: np.ndarray,
    config: EvaluationConfig,
    location: str,
    sealed_probabilities: Any = None,
    require_recomputable_evidence: bool,
) -> None:
    if not isinstance(record, Mapping):
        raise BubbleFitTrainingError(f"{location} is missing")
    diagnostic_description = (
        "nominal one-sided 95% Clopper-Pearson calculation; candidates are "
        "work-clustered, independence is not asserted, and this is not a "
        "confirmatory confidence bound"
    )
    expected_available = selected_threshold is not None
    if (
        record.get("innerThresholdAvailable") is not expected_available
        or record.get("selectedThreshold") != selected_threshold
        or record.get("unsafeFalseAcceptTarget") != config.unsafe_false_accept_target
        or record.get("minimumCoverage") != config.minimum_coverage
        or record.get("minimumAcceptedSafe") != config.minimum_accepted_safe
        or record.get("safeCount") != int(np.count_nonzero(labels == 1))
        or record.get("unsafeCount") != int(np.count_nonzero(labels == 0))
        or record.get("candidateLevelDiagnosticZeroFailureUpper95")
        != one_sided_binomial_upper_bound(0, int(np.count_nonzero(labels == 0)))
        or record.get("candidateIndependenceAsserted") is not False
        or record.get("confirmatory") is not False
        or record.get("productionSafetyEstablished") is not False
        or record.get("thresholdRole") != "inner cross-fitted selection diagnostic only"
        or record.get("candidateLevelSelectionDiagnostic") != diagnostic_description
        or record.get("empiricalRatesAreDiagnosticOnly") is not True
        or isinstance(record.get("candidateThresholdCount"), bool)
        or not isinstance(record.get("candidateThresholdCount"), int)
        or not 2 <= int(record["candidateThresholdCount"]) <= len(labels) + 2
        or isinstance(record.get("innerThresholdAvailableCount"), bool)
        or not isinstance(record.get("innerThresholdAvailableCount"), int)
        or not 0
        <= int(record["innerThresholdAvailableCount"])
        <= int(record["candidateThresholdCount"])
    ):
        raise BubbleFitTrainingError(f"{location} contract is invalid")
    if require_recomputable_evidence:
        if (
            not isinstance(sealed_probabilities, list)
            or len(sealed_probabilities) != len(labels)
            or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or not 0.0 <= float(value) <= 1.0
                for value in sealed_probabilities
            )
        ):
            raise BubbleFitTrainingError(
                f"{location} sealed probability evidence is invalid"
            )
        expected_threshold, expected_record = select_safety_threshold(
            labels,
            np.asarray(sealed_probabilities, dtype=np.float64),
            unsafe_false_accept_target=config.unsafe_false_accept_target,
            minimum_coverage=config.minimum_coverage,
            minimum_accepted_safe=config.minimum_accepted_safe,
        )
        if selected_threshold != expected_threshold or dict(record) != expected_record:
            raise BubbleFitTrainingError(
                f"{location} differs from recomputed sealed probabilities"
            )
        return
    if expected_available:
        selected_metrics = record.get("selectedMetrics")
        if (
            record.get("status") != "innerThresholdAvailable"
            or not isinstance(selected_metrics, Mapping)
            or selected_metrics.get("threshold") != selected_threshold
            or int(record["innerThresholdAvailableCount"]) < 1
            or record.get("selectionPolicy")
            != (
                "for exploratory inner selection, among thresholds meeting the "
                "candidate-level diagnostic and minimum utility, maximize safe "
                "recall, coverage, precision, then prefer the tighter diagnostic "
                "and higher threshold"
            )
        ):
            raise BubbleFitTrainingError(f"{location} selected threshold is invalid")
        _assert_binary_metric_count_consistency(
            selected_metrics,
            safe_count=int(np.count_nonzero(labels == 1)),
            unsafe_count=int(np.count_nonzero(labels == 0)),
            threshold=float(selected_threshold),
            location=f"{location}.selectedMetrics",
        )
    elif (
        record.get("status") != "noInnerThresholdAvailable"
        or record.get("selectedMetrics") is not None
        or record.get("innerThresholdAvailableCount") != 0
        or record.get("reason")
        != (
            "no threshold met both the candidate-level selection diagnostic "
            "and nonzero utility requirements"
        )
        or record.get("selectionPolicy")
        != (
            "for inner threshold selection only, require nonzero utility and a "
            "candidate-level diagnostic calculation at or below target; return "
            "no threshold when none qualifies"
        )
    ):
        raise BubbleFitTrainingError(f"{location} unavailable threshold is invalid")
    else:
        closest = record.get("closestUnavailableDiagnostic")
        if closest is not None:
            if (
                not isinstance(closest, Mapping)
                or closest.get("availableForInnerSelection") is not False
                or closest.get("hasMinimumUtility") is not True
                or closest.get("meetsCandidateLevelSelectionDiagnostic") is not False
                or isinstance(closest.get("threshold"), bool)
                or not isinstance(closest.get("threshold"), (int, float))
            ):
                raise BubbleFitTrainingError(
                    f"{location} closest unavailable diagnostic is invalid"
                )
            _assert_binary_metric_count_consistency(
                closest.get("metrics"),
                safe_count=int(np.count_nonzero(labels == 1)),
                unsafe_count=int(np.count_nonzero(labels == 0)),
                threshold=float(closest["threshold"]),
                location=f"{location}.closestUnavailableDiagnostic.metrics",
            )


def _assert_no_source_threshold_record(record: Any, *, location: str) -> None:
    expected_keys = {
        "status",
        "innerThresholdAvailable",
        "selectedThreshold",
        "selectedMetrics",
        "reason",
        "thresholdRole",
        "targetLabelsUsed",
        "confirmatory",
        "productionSafetyEstablished",
    }
    if (
        not isinstance(record, Mapping)
        or set(record) != expected_keys
        or record.get("status") != "noSourceThresholdAvailable"
        or record.get("innerThresholdAvailable") is not False
        or record.get("selectedThreshold") is not None
        or record.get("selectedMetrics") is not None
        or not isinstance(record.get("reason"), str)
        or not str(record["reason"]).strip()
        or record.get("thresholdRole")
        != "source-pack work-disjoint selection diagnostic only"
        or record.get("targetLabelsUsed") is not False
        or record.get("confirmatory") is not False
        or record.get("productionSafetyEstablished") is not False
    ):
        raise BubbleFitTrainingError(
            f"{location} no-source-threshold contract is invalid"
        )


def _expected_authority_bindings(
    *,
    source: Mapping[str, Any],
    config_payload: Mapping[str, Any],
    input_contract: Mapping[str, Any],
    run_configuration: Mapping[str, Any],
    confirmatory_contract: Mapping[str, Any],
    split_plan_sha256: str,
    oof_predictions_sha256: str,
    authority: Mapping[str, Any],
    cross_pack_plan_sha256: str | None = None,
    cross_pack_predictions_sha256: str | None = None,
) -> dict[str, Any]:
    if _is_pack_set_source_kind(source.get("sourceKind")):
        if cross_pack_plan_sha256 is None or cross_pack_predictions_sha256 is None:
            raise BubbleFitTrainingError(
                "pack-set authority lacks cross-pack artifacts"
            )
        source_bindings = {
            "inputPackSetFileSha256": source.get("inputPackSetFileSha256"),
            "inputPackSetCanonicalSha256": source.get("inputPackSetCanonicalSha256"),
            "inputPackSetBindingSha256": source.get("inputPackSetBindingSha256"),
            "sourcePacksCanonicalSha256": source.get("sourcePacksCanonicalSha256"),
            "productionInputBindingSha256": source.get("productionInputBindingSha256"),
            "crossPackPlanSha256": cross_pack_plan_sha256,
            "crossPackPredictionsSha256": cross_pack_predictions_sha256,
        }
    else:
        source_bindings = {
            "datasetManifestSha256": source.get("datasetManifestSha256"),
            "datasetManifestBindingSha256": source.get("datasetManifestBindingSha256"),
            "datasetSealSha256": source.get("datasetSealSha256"),
            "artifactInventorySha256": source.get("artifactInventorySha256"),
            "labelsSha256": source.get("labelsSha256"),
            "productionInputBindingSha256": source.get("productionInputBindingSha256"),
        }
    expected = {
        **source_bindings,
        "splitPlanSha256": split_plan_sha256,
        "oofPredictionsSha256": oof_predictions_sha256,
        "evaluationConfigCanonicalSha256": _sha256_json(config_payload),
        "inputContractCanonicalSha256": _sha256_json(input_contract),
        "runConfigurationCanonicalSha256": _sha256_json(run_configuration),
        "confirmatoryAuditContractCanonicalSha256": _sha256_json(confirmatory_contract),
        "trainerScriptSha256": authority["trainerScript"]["sha256"],
        "gitCommit": authority["git"]["commit"],
        "gitDirty": authority["git"]["dirty"],
        "gitPorcelainV1Sha256": authority["git"]["porcelainV1Sha256"],
        "packageConfigCanonicalSha256": authority["packageConfig"][
            "canonicalJsonSha256"
        ],
        "rendererDependencyLockCanonicalSha256": authority["rendererDependencyLock"][
            "canonicalJsonSha256"
        ],
        "pythonRuntimeCanonicalSha256": _sha256_json(authority["pythonRuntime"]),
        "pythonProducerDistributionsCanonicalSha256": _sha256_json(
            authority["pythonProducerDistributions"]
        ),
        "pythonRepositoryLocksCanonicalSha256": _sha256_json(
            authority["pythonRepositoryLocks"]
        ),
    }
    for key, value in expected.items():
        if key == "gitDirty":
            if not isinstance(value, bool):
                raise BubbleFitTrainingError("gitDirty authority is invalid")
        elif key == "gitCommit":
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
                raise BubbleFitTrainingError("gitCommit authority is invalid")
        else:
            _require_sha256(value, f"authorityBindings.{key}")
    expected["bindingSha256"] = _sha256_json(expected)
    return expected


def validate_output_artifacts(
    output_dir: Path, *, expected_snapshot: TrainingSnapshot | None = None
) -> dict[str, Any]:
    raw_output_dir = Path(output_dir)
    if raw_output_dir.is_symlink():
        raise BubbleFitTrainingError("output artifact root is missing or symlinked")
    output_dir = raw_output_dir.resolve()
    if not output_dir.is_dir():
        raise BubbleFitTrainingError("output artifact root is missing or symlinked")
    manifest_path = output_dir / "artifact-manifest.json"
    seal_path = output_dir / "artifact-seal.json"
    manifest = _read_json(manifest_path, "output artifact manifest")
    seal = _read_json(seal_path, "output artifact seal")
    schema_version = seal.get("schemaVersion")
    if schema_version not in SUPPORTED_OUTPUT_SCHEMA_VERSIONS:
        raise BubbleFitTrainingError("unsupported output artifact schemaVersion")
    for location, payload in (("manifest", manifest), ("seal", seal)):
        _assert_common_nonpromotable(
            payload, f"output {location}", schema_version=schema_version
        )
        _assert_current_schema_contract_fields(
            payload,
            schema_version=schema_version,
            location=f"output {location}",
        )
    if seal.get("manifestFile") != "artifact-manifest.json" or seal.get(
        "manifestSha256"
    ) != _sha256_file(manifest_path):
        raise BubbleFitTrainingError("output seal does not bind artifact manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise BubbleFitTrainingError("output artifact file inventory is empty")
    if manifest.get("filesBindingSha256") != _sha256_json(files):
        raise BubbleFitTrainingError("output artifact file inventory binding mismatch")
    expected_files = {"artifact-manifest.json", "artifact-seal.json"}
    for raw in files:
        if not isinstance(raw, dict) or set(raw) != {"path", "sha256", "sizeBytes"}:
            raise BubbleFitTrainingError("output artifact inventory entry is invalid")
        relative_text = _require_string(raw.get("path"), "artifact.path")
        relative = Path(relative_text)
        if relative.is_absolute() or ".." in relative.parts:
            raise BubbleFitTrainingError(
                f"unsafe output artifact path: {relative_text}"
            )
        unresolved_path = output_dir / relative
        if unresolved_path.is_symlink():
            raise BubbleFitTrainingError(
                f"output artifact is symlinked: {relative_text}"
            )
        path = unresolved_path.resolve()
        try:
            path.relative_to(output_dir)
        except ValueError as exc:
            raise BubbleFitTrainingError(
                f"output artifact escapes root: {relative_text}"
            ) from exc
        if relative.as_posix() in expected_files:
            raise BubbleFitTrainingError(
                f"duplicate output artifact path: {relative_text}"
            )
        expected_files.add(relative.as_posix())
        if not path.is_file() or path.is_symlink():
            raise BubbleFitTrainingError(f"output artifact is missing: {relative_text}")
        if path.stat().st_size != _require_int(
            raw.get("sizeBytes"), f"{relative_text}.sizeBytes", 1
        ) or _sha256_file(path) != _require_sha256(
            raw.get("sha256"), f"{relative_text}.sha256"
        ):
            raise BubbleFitTrainingError(
                f"output artifact binding mismatch: {relative_text}"
            )
    actual_files: set[str] = set()
    for path in output_dir.rglob("*"):
        if path.is_symlink():
            raise BubbleFitTrainingError(
                f"symlink is forbidden in output artifacts: {path}"
            )
        if path.is_file():
            actual_files.add(path.relative_to(output_dir).as_posix())
    if actual_files != expected_files:
        raise BubbleFitTrainingError(
            "output artifact inventory has missing or unsealed extra files"
        )
    authority = seal.get("executionAuthority")
    bindings = seal.get("authorityBindings")
    if not isinstance(authority, dict) or not isinstance(bindings, dict):
        raise BubbleFitTrainingError("output authority payload is missing")
    _assert_no_absolute_paths(authority, "seal.executionAuthority")
    _assert_no_absolute_paths(bindings, "seal.authorityBindings")
    _assert_canonical_binding(authority, "executionAuthority")
    _assert_canonical_binding(bindings, "authorityBindings")
    direct_keys = (
        PACK_SET_AUTHORITY_DIRECT_KEYS
        if _is_pack_set_output_schema(schema_version)
        else AUTHORITY_DIRECT_KEYS
    )
    for key in direct_keys:
        if seal.get(key) != bindings.get(key):
            raise BubbleFitTrainingError(
                f"output seal direct authority mismatch: {key}"
            )
    report = _read_json(output_dir / "evaluation-report.json", "evaluation report")
    _assert_common_nonpromotable(
        report, "evaluation report", schema_version=schema_version
    )
    _assert_current_schema_contract_fields(
        report,
        schema_version=schema_version,
        location="evaluation report",
    )
    if (
        report.get("executionAuthority") != authority
        or report.get("authorityBindings") != bindings
    ):
        raise BubbleFitTrainingError("evaluation report authority differs from seal")
    source = report.get("source")
    if not isinstance(source, dict):
        raise BubbleFitTrainingError("evaluation report source is missing")
    is_pack_set = _is_pack_set_source_kind(source.get("sourceKind"))
    if is_pack_set != _is_pack_set_output_schema(schema_version):
        raise BubbleFitTrainingError("output schema/source kind mismatch")
    if is_pack_set:
        if expected_snapshot is None or not isinstance(
            expected_snapshot, DatasetPackSetSnapshot
        ):
            raise BubbleFitTrainingError(
                "pack-set output validation requires a revalidated expected snapshot"
            )
        packs = source.get("packs")
        if (
            not isinstance(packs, list)
            or len(packs) != source.get("packCount")
            or _sha256_json(packs) != source.get("sourcePacksCanonicalSha256")
        ):
            raise BubbleFitTrainingError("pack-set source provenance is not canonical")
        for field in (
            "inputPackSetFileSha256",
            "inputPackSetCanonicalSha256",
            "inputPackSetBindingSha256",
            "sourcePacksCanonicalSha256",
            "productionInputBindingSha256",
        ):
            _require_sha256(source.get(field), f"source.{field}")
    if expected_snapshot is not None and source != expected_snapshot.provenance():
        raise BubbleFitTrainingError(
            "evaluation report source differs from the revalidated dataset snapshot"
        )
    shared_authority_invalid = (
        manifest.get("executionAuthority") != authority
        or manifest.get("authorityBindings") != bindings
        or manifest.get("source") != source
        or seal.get("source") != source
    )
    if is_pack_set:
        source_seal_invalid = seal.get("inputPackSetCanonicalSha256") != source.get(
            "inputPackSetCanonicalSha256"
        ) or seal.get("sourcePacksCanonicalSha256") != source.get(
            "sourcePacksCanonicalSha256"
        )
        direct_payload_invalid = any(
            payload.get(key) != bindings.get(key)
            for payload in (report, manifest, seal)
            for key in direct_keys
        )
    else:
        source_seal_invalid = seal.get("sourceDatasetManifestSha256") != source.get(
            "datasetManifestSha256"
        ) or seal.get("sourceLabelsSha256") != source.get("labelsSha256")
        direct_payload_invalid = False
    if shared_authority_invalid or source_seal_invalid or direct_payload_invalid:
        raise BubbleFitTrainingError("artifact manifest authority differs from seal")

    config_payload = report.get("config")
    input_contract = report.get("inputContract")
    cohort_counts = report.get("cohortCounts")
    model_kinds = report.get("modelKinds")
    models = report.get("models")
    if (
        not isinstance(config_payload, dict)
        or not isinstance(input_contract, dict)
        or not isinstance(cohort_counts, dict)
        or not isinstance(model_kinds, list)
        or not model_kinds
        or any(model not in MODEL_KINDS for model in model_kinds)
        or len(set(model_kinds)) != len(model_kinds)
        or not isinstance(models, list)
        or len(models) != len(model_kinds)
        or any(not isinstance(model, dict) for model in models)
        or [model.get("modelKind") for model in models] != model_kinds
    ):
        raise BubbleFitTrainingError("evaluation report run configuration is invalid")
    validated_config = evaluation_config_from_payload(config_payload)
    if input_contract != production_input_contract():
        raise BubbleFitTrainingError("production input contract is not canonical")
    source_work_count = _require_int(
        cohort_counts.get("sourceWorkCount"), "cohortCounts.sourceWorkCount", 1
    )
    if (
        source_work_count != source.get("sourceWorkCount")
        or cohort_counts.get("sourcePageCount") != source.get("sourcePageCount")
        or cohort_counts.get("candidateCount") != source.get("candidateCount")
        or cohort_counts.get("candidateBearingWorkCount")
        != source.get("candidateBearingWorkCount")
    ):
        raise BubbleFitTrainingError("cohort counts differ from source provenance")
    expected_candidate_count = _require_int(
        cohort_counts.get("candidateCount"), "cohortCounts.candidateCount", 1
    )
    expected_source_page_count = _require_int(
        cohort_counts.get("sourcePageCount"), "cohortCounts.sourcePageCount", 1
    )
    if (
        report.get("artifactStage")
        != _artifact_stage(expected_source_page_count, expected_candidate_count)
        or report.get("promotionBlockReason")
        != _promotion_block_reason(expected_source_page_count, expected_candidate_count)
        or report.get("currentRunRole") != "exploratory development OOF only"
        or report.get("determinism") != seed_everything(validated_config.seed)
        or report.get("versions") != _runtime_versions_payload()
    ):
        raise BubbleFitTrainingError(
            "evaluation report top-level provenance/limitations are not canonical"
        )
    expected_confirmatory = confirmatory_audit_contract(
        current_source_work_count=source_work_count,
        target=validated_config.unsafe_false_accept_target,
        schema_version=schema_version,
    )
    for location, payload in (
        ("report", report),
        ("manifest", manifest),
        ("seal", seal),
    ):
        if payload.get("confirmatoryAuditContract") != expected_confirmatory:
            raise BubbleFitTrainingError(
                f"{location} confirmatory audit contract is not canonical"
            )

    final_contract_path = output_dir / "final-candidate-contract.json"
    final_contract: dict[str, Any] | None = None
    optional_final = report.get("optionalFinalCandidate")
    if final_contract_path.is_file():
        final_contract = _read_json(final_contract_path, "final candidate contract")
        _assert_common_nonpromotable(
            final_contract,
            "final candidate contract",
            schema_version=schema_version,
        )
        _assert_current_schema_contract_fields(
            final_contract,
            schema_version=schema_version,
            location="final candidate contract",
        )
        if isinstance(optional_final, Mapping):
            _assert_current_schema_contract_fields(
                optional_final,
                schema_version=schema_version,
                location="optional final candidate summary",
            )
        if (
            not isinstance(optional_final, dict)
            or optional_final.get("contractPath") != "final-candidate-contract.json"
            or optional_final.get("contractSha256") != _sha256_file(final_contract_path)
            or final_contract.get("modelKind") not in EXPORTABLE_MODEL_KINDS
            or final_contract.get("modelKind") not in model_kinds
            or optional_final.get("modelKind") != final_contract.get("modelKind")
            or final_contract.get("artifactKind") != "optional all-data crude candidate"
            or final_contract.get("currentRunRole")
            != "diagnostic all-data export after exploratory development"
            or final_contract.get("cohortCounts") != cohort_counts
            or final_contract.get("inputContract") != input_contract
            or final_contract.get("threshold") is not None
            or final_contract.get("operationalThreshold") is not None
            or final_contract.get("calibrationRequired") is not True
            or final_contract.get("outputSemantics") != "sigmoid_safe_probability"
            or not isinstance(final_contract.get("fit"), Mapping)
            or not isinstance(final_contract.get("officialWeights"), Mapping)
            or optional_final.get("promotionEligible") is not False
            or optional_final.get("productionUseForbidden") is not True
            or optional_final.get("operationalThreshold") is not None
            or optional_final.get("calibrationRequired") is not True
            or optional_final.get("runtimePreprocessorParity") is not False
            or optional_final.get("exactProductionFloodParity") is not False
            or optional_final.get("productionSafetyEstablished") is not False
            or optional_final.get("confirmatory") is not False
            or final_contract.get("confirmatoryAuditContract") != expected_confirmatory
        ):
            raise BubbleFitTrainingError("final candidate contract binding is invalid")
        _validate_final_candidate_files(
            output_dir=output_dir,
            contract=final_contract,
            config=validated_config,
        )
        export_final_model: str | None = str(final_contract["modelKind"])
    else:
        if optional_final is not None:
            raise BubbleFitTrainingError("optional final candidate artifact is missing")
        export_final_model = None
    expected_run_configuration = run_configuration_payload(
        config_payload=config_payload,
        model_kinds=model_kinds,
        export_final_model=export_final_model,
        input_contract=input_contract,
        schema_version=schema_version,
        input_pack_set_canonical_sha256=(
            source.get("inputPackSetCanonicalSha256") if is_pack_set else None
        ),
        input_pack_set_schema_version=(
            expected_snapshot.input_schema_version
            if isinstance(expected_snapshot, DatasetPackSetSnapshot)
            else None
        ),
        cross_pack_evaluation=is_pack_set,
    )
    if report.get("runConfiguration") != expected_run_configuration:
        raise BubbleFitTrainingError("run configuration is not canonical")

    oof_path = output_dir / "oof-predictions.jsonl"
    oof_rows = _read_jsonl_objects(oof_path, "OOF predictions")
    identity_by_candidate: dict[str, tuple[Any, ...]] = {}
    candidate_ids_by_model = {model_kind: set() for model_kind in model_kinds}
    oof_rows_by_model: dict[str, list[dict[str, Any]]] = {
        model_kind: [] for model_kind in model_kinds
    }
    multiclass_rows_by_model: dict[str, list[tuple[str, np.ndarray]]] = {
        model_kind: []
        for model_kind in model_kinds
        if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND
    }
    expected_samples_by_id = (
        {sample.candidate_id: sample for sample in expected_snapshot.samples}
        if is_pack_set and isinstance(expected_snapshot, DatasetPackSetSnapshot)
        else {}
    )
    for index, row in enumerate(oof_rows):
        _assert_common_nonpromotable(
            row,
            f"OOF prediction {index + 1}",
            schema_version=schema_version,
        )
        model_kind = row.get("modelKind")
        candidate_id = row.get("candidateId")
        label = row.get("label")
        safe = row.get("safeForBubbleFit")
        safe_probability = row.get("safeProbability")
        if model_kind not in model_kinds:
            raise BubbleFitTrainingError("OOF prediction model is not declared")
        if (
            not isinstance(candidate_id, str)
            or not candidate_id
            or isinstance(row.get("ordinal"), bool)
            or not isinstance(row.get("ordinal"), int)
            or row.get("ordinal") < 1
            or not isinstance(row.get("workId"), str)
            or not row.get("workId")
            or not isinstance(row.get("foldId"), str)
            or not row.get("foldId")
            or label not in ALLOWED_LABELS
            or not isinstance(safe, bool)
            or safe != (label == "safe_opaque")
            or isinstance(safe_probability, bool)
            or not isinstance(safe_probability, (int, float))
            or not math.isfinite(float(safe_probability))
            or not 0.0 <= float(safe_probability) <= 1.0
        ):
            raise BubbleFitTrainingError("OOF prediction source identity is invalid")
        decision_available_value = row.get("decisionAvailable")
        threshold = row.get("threshold")
        predicted_safe_value = row.get("predictedSafe")
        if not isinstance(decision_available_value, bool):
            raise BubbleFitTrainingError("OOF prediction decisionAvailable is invalid")
        if decision_available_value:
            if (
                isinstance(threshold, bool)
                or not isinstance(threshold, (int, float))
                or not math.isfinite(float(threshold))
                or not 0.0 <= float(threshold) <= 1.0
                or not isinstance(predicted_safe_value, bool)
                or predicted_safe_value
                is not (float(safe_probability) >= float(threshold))
            ):
                raise BubbleFitTrainingError(
                    "OOF prediction threshold/decision semantics are invalid"
                )
        elif threshold is not None or predicted_safe_value is not None:
            raise BubbleFitTrainingError(
                "OOF prediction unavailable decision must be null"
            )
        if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
            class_vector = _validated_class_probability_vector(
                row.get("classProbabilities"),
                f"OOF prediction {index + 1}.classProbabilities",
            )
            expected_predicted_class = ALLOWED_LABELS[int(np.argmax(class_vector))]
            if (
                not math.isclose(
                    float(safe_probability),
                    float(class_vector[SAFE_CLASS_INDEX]),
                    rel_tol=0.0,
                    abs_tol=1e-12,
                )
                or row.get("predictedClass") != expected_predicted_class
                or row.get("safeScoreSource") != "softmax_safe_opaque_probability"
            ):
                raise BubbleFitTrainingError(
                    "five-class OOF probability semantics are invalid"
                )
            multiclass_rows_by_model[str(model_kind)].append((str(label), class_vector))
        elif any(
            field in row
            for field in ("classProbabilities", "predictedClass", "safeScoreSource")
        ):
            raise BubbleFitTrainingError(
                "binary OOF prediction contains five-class fields"
            )
        if is_pack_set:
            expected_sample = expected_samples_by_id.get(str(candidate_id))
            if (
                expected_sample is None
                or row.get("packId") != expected_sample.pack_id
                or row.get("packRole") != expected_sample.pack_role
                or row.get("candidateKey")
                != f"{expected_sample.pack_id}:{expected_sample.candidate_id}"
                or row.get("sourceOrdinal") != expected_sample.ordinal
                or row.get("sourceSelectionIndex") != expected_sample.selection_index
                or row.get("combinedOrdinal") != expected_sample.combined_ordinal
                or row.get("ordinal") != expected_sample.ordinal
                or row.get("workId") != expected_sample.work_id
                or label != expected_sample.label
                or safe != expected_sample.safe
            ):
                raise BubbleFitTrainingError(
                    "pack-set OOF prediction provenance differs from source"
                )
        identity = (
            row.get("ordinal"),
            row.get("workId"),
            label,
            safe,
            row.get("foldId"),
            row.get("packId") if is_pack_set else None,
            row.get("combinedOrdinal") if is_pack_set else None,
        )
        previous_identity = identity_by_candidate.setdefault(candidate_id, identity)
        if previous_identity != identity:
            raise BubbleFitTrainingError(
                "OOF prediction source identity differs between models"
            )
        candidate_ids_by_model[str(model_kind)].add(candidate_id)
        oof_rows_by_model[str(model_kind)].append(row)
    expected_oof_count = _require_int(
        cohort_counts.get("candidateCount"), "cohortCounts.candidateCount", 1
    ) * len(model_kinds)
    oof_keys = [
        (
            row.get("modelKind"),
            row.get("packId") if is_pack_set else None,
            row.get("candidateId"),
        )
        for row in oof_rows
    ]
    if len(oof_rows) != expected_oof_count or len(set(oof_keys)) != len(oof_keys):
        raise BubbleFitTrainingError("OOF prediction coverage is not bijective")
    candidate_sets = list(candidate_ids_by_model.values())
    if any(
        len(candidate_ids) != expected_oof_count // len(model_kinds)
        for candidate_ids in candidate_sets
    ) or any(
        candidate_ids != candidate_sets[0] for candidate_ids in candidate_sets[1:]
    ):
        raise BubbleFitTrainingError("OOF candidate sets differ between models")
    safety_labels = np.asarray(
        [
            bool(row["safeForBubbleFit"])
            for row in oof_rows_by_model[str(model_kinds[0])]
        ],
        dtype=np.int64,
    )
    if report.get("safetyEvidenceLimits") != _safety_evidence_limits(
        safety_labels,
        unsafe_false_accept_target=validated_config.unsafe_false_accept_target,
    ):
        raise BubbleFitTrainingError(
            "evaluation report safetyEvidenceLimits are not canonical"
        )
    candidate_work_ids = sorted(
        {
            str(identity[1])
            for identity in identity_by_candidate.values()
            if isinstance(identity[1], str) and identity[1]
        }
    )
    if candidate_work_ids != source.get("candidateBearingWorkIds"):
        raise BubbleFitTrainingError(
            "OOF work identities differ from source provenance"
        )
    for model_record in models:
        model_kind = str(model_record["modelKind"])
        if model_record.get("modelDefinition") != model_definition(model_kind):
            raise BubbleFitTrainingError("model definition is not canonical")
        if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
            rows = multiclass_rows_by_model.get(model_kind, [])
            expected_metrics = _multiclass_classification_metrics(
                [label for label, _probabilities in rows],
                np.stack([probabilities for _label, probabilities in rows]),
            )
            if model_record.get("multiclassOofMetrics") != expected_metrics:
                raise BubbleFitTrainingError(
                    "five-class OOF metrics differ from prediction rows"
                )
        elif "multiclassOofMetrics" in model_record:
            raise BubbleFitTrainingError(
                "binary model report contains five-class metrics"
            )

    split_plan_path = output_dir / "split-plan.json"
    split_plan = _read_json(split_plan_path, "split plan")
    split_folds = split_plan.get("folds")
    if (
        split_plan.get("schemaVersion") != schema_version
        or split_plan.get("toolId") != TOOL_ID
        or split_plan.get("strategy")
        != "leave-one-work-out outer OOF; every work held out exactly once"
        or split_plan.get("promotionEligible") is not False
        or not isinstance(split_folds, list)
        or not split_folds
        or split_plan.get("splitBindingSha256") != _sha256_json(split_folds)
    ):
        raise BubbleFitTrainingError("split plan contract is invalid")
    holdout_fold_by_candidate: dict[str, str] = {}
    seen_fold_ids: set[str] = set()
    declared_candidate_ids = candidate_sets[0]
    if len(split_folds) != source.get("candidateBearingWorkCount"):
        raise BubbleFitTrainingError("split plan fold count is invalid")
    for fold in split_folds:
        if not isinstance(fold, dict):
            raise BubbleFitTrainingError("split plan fold is invalid")
        fold_id = _require_string(fold.get("foldId"), "splitPlan.foldId")
        train_ids = fold.get("trainCandidateIds")
        holdout_ids = fold.get("holdoutCandidateIds")
        train_works = fold.get("trainWorkIds")
        holdout_works = fold.get("holdoutWorkIds")
        count_train_ids = train_ids if isinstance(train_ids, list) else []
        count_holdout_ids = holdout_ids if isinstance(holdout_ids, list) else []
        train_class_counts = {
            "safe": sum(
                bool(identity_by_candidate[str(candidate_id)][3])
                for candidate_id in count_train_ids
                if str(candidate_id) in identity_by_candidate
            ),
            "unsafe": sum(
                not bool(identity_by_candidate[str(candidate_id)][3])
                for candidate_id in count_train_ids
                if str(candidate_id) in identity_by_candidate
            ),
        }
        holdout_class_counts = {
            "safe": sum(
                bool(identity_by_candidate[str(candidate_id)][3])
                for candidate_id in count_holdout_ids
                if str(candidate_id) in identity_by_candidate
            ),
            "unsafe": sum(
                not bool(identity_by_candidate[str(candidate_id)][3])
                for candidate_id in count_holdout_ids
                if str(candidate_id) in identity_by_candidate
            ),
        }
        expected_class_issues = (
            ["holdout_has_single_class_metrics_partially_undefined"]
            if 0 in holdout_class_counts.values()
            else []
        )
        if (
            fold_id in seen_fold_ids
            or not isinstance(train_ids, list)
            or not isinstance(holdout_ids, list)
            or not isinstance(train_works, list)
            or not isinstance(holdout_works, list)
            or any(not isinstance(value, str) or not value for value in train_ids)
            or any(not isinstance(value, str) or not value for value in holdout_ids)
            or any(not isinstance(value, str) or not value for value in train_works)
            or any(not isinstance(value, str) or not value for value in holdout_works)
            or len(set(train_ids)) != len(train_ids)
            or len(set(holdout_ids)) != len(holdout_ids)
            or set(train_ids) & set(holdout_ids)
            or set(train_works) & set(holdout_works)
            or not set(holdout_ids) <= declared_candidate_ids
            or len(holdout_works) != 1
            or set(train_ids) != declared_candidate_ids - set(holdout_ids)
            or sorted(
                {
                    str(identity_by_candidate[candidate_id][1])
                    for candidate_id in train_ids
                }
            )
            != train_works
            or sorted(
                {
                    str(identity_by_candidate[candidate_id][1])
                    for candidate_id in holdout_ids
                }
            )
            != holdout_works
            or fold.get("trainCandidateIdsSha256") != _sha256_json(train_ids)
            or fold.get("holdoutCandidateIdsSha256") != _sha256_json(holdout_ids)
            or fold.get("trainClassCounts") != train_class_counts
            or fold.get("holdoutClassCounts") != holdout_class_counts
            or fold.get("classIssues") != expected_class_issues
        ):
            raise BubbleFitTrainingError("split plan fold binding is invalid")
        if is_pack_set:
            train_keys = [
                f"{expected_samples_by_id[candidate_id].pack_id}:{candidate_id}"
                for candidate_id in train_ids
            ]
            holdout_keys = [
                f"{expected_samples_by_id[candidate_id].pack_id}:{candidate_id}"
                for candidate_id in holdout_ids
            ]
            if (
                fold.get("trainCandidateKeys") != train_keys
                or fold.get("holdoutCandidateKeys") != holdout_keys
                or fold.get("trainCandidateKeysSha256") != _sha256_json(train_keys)
                or fold.get("holdoutCandidateKeysSha256") != _sha256_json(holdout_keys)
            ):
                raise BubbleFitTrainingError(
                    "pack-set split candidate provenance is invalid"
                )
        seen_fold_ids.add(fold_id)
        for candidate_id in holdout_ids:
            if (
                not isinstance(candidate_id, str)
                or candidate_id in holdout_fold_by_candidate
            ):
                raise BubbleFitTrainingError(
                    "split plan holdout coverage is not bijective"
                )
            holdout_fold_by_candidate[candidate_id] = fold_id
    if set(holdout_fold_by_candidate) != candidate_sets[0] or any(
        holdout_fold_by_candidate[candidate_id] != identity[4]
        for candidate_id, identity in identity_by_candidate.items()
    ):
        raise BubbleFitTrainingError("OOF predictions differ from the split plan")

    split_fold_by_id = {str(fold["foldId"]): fold for fold in split_folds}
    if expected_snapshot is not None:
        ordered_candidate_ids = [
            sample.candidate_id for sample in expected_snapshot.samples
        ]
        metric_samples_by_id: dict[str, Any] = {
            sample.candidate_id: sample for sample in expected_snapshot.samples
        }
    else:
        ordered_candidate_ids = [
            str(row["candidateId"]) for row in oof_rows_by_model[str(model_kinds[0])]
        ]
        metric_samples_by_id = {
            candidate_id: _ValidationMetricSample(
                work_id=str(identity_by_candidate[candidate_id][1]),
                label=str(identity_by_candidate[candidate_id][2]),
                confidence="unavailable_without_revalidated_snapshot",
            )
            for candidate_id in ordered_candidate_ids
        }
    if set(ordered_candidate_ids) != candidate_sets[0] or len(
        ordered_candidate_ids
    ) != len(candidate_sets[0]):
        raise BubbleFitTrainingError(
            "revalidated sample order differs from OOF prediction coverage"
        )

    model_record_by_kind = {
        str(model_record["modelKind"]): model_record for model_record in models
    }
    for model_kind in model_kinds:
        model_record = model_record_by_kind[str(model_kind)]
        rows_by_id = {
            str(row["candidateId"]): row for row in oof_rows_by_model[str(model_kind)]
        }
        ordered_rows = [
            rows_by_id[candidate_id] for candidate_id in ordered_candidate_ids
        ]
        metric_samples = [
            metric_samples_by_id[candidate_id] for candidate_id in ordered_candidate_ids
        ]
        if expected_snapshot is not None:
            for sample, row in zip(metric_samples, ordered_rows, strict=True):
                if (
                    row.get("ordinal") != sample.ordinal
                    or row.get("workId") != sample.work_id
                    or row.get("label") != sample.label
                    or row.get("safeForBubbleFit") != sample.safe
                ):
                    raise BubbleFitTrainingError(
                        "OOF prediction differs from revalidated source sample"
                    )
        ordered_labels = np.asarray(
            [bool(row["safeForBubbleFit"]) for row in ordered_rows],
            dtype=np.int64,
        )
        ordered_probabilities = np.asarray(
            [float(row["safeProbability"]) for row in ordered_rows],
            dtype=np.float64,
        )
        ordered_available = np.asarray(
            [bool(row["decisionAvailable"]) for row in ordered_rows], dtype=bool
        )
        ordered_predicted = np.asarray(
            [
                bool(row["predictedSafe"]) if row["decisionAvailable"] else False
                for row in ordered_rows
            ],
            dtype=bool,
        )
        fold_records = model_record.get("folds")
        if not isinstance(fold_records, list) or [
            record.get("foldId") for record in fold_records
        ] != [fold["foldId"] for fold in split_folds]:
            raise BubbleFitTrainingError("model fold coverage differs from split plan")
        for fold_record in fold_records:
            fold_id = str(fold_record["foldId"])
            split_fold = split_fold_by_id[fold_id]
            train_ids = [str(value) for value in split_fold["trainCandidateIds"]]
            holdout_ids = [str(value) for value in split_fold["holdoutCandidateIds"]]
            holdout_rows = [rows_by_id[candidate_id] for candidate_id in holdout_ids]
            holdout_available = {bool(row["decisionAvailable"]) for row in holdout_rows}
            if len(holdout_available) != 1:
                raise BubbleFitTrainingError(
                    "OOF decision availability differs within an outer fold"
                )
            fold_decision_available = holdout_available == {True}
            if fold_decision_available:
                fold_thresholds = {float(row["threshold"]) for row in holdout_rows}
                if len(fold_thresholds) != 1:
                    raise BubbleFitTrainingError(
                        "OOF threshold differs within an outer fold"
                    )
                selected_threshold: float | None = next(iter(fold_thresholds))
            else:
                selected_threshold = None
            train_label_values = np.asarray(
                [
                    bool(rows_by_id[candidate_id]["safeForBubbleFit"])
                    for candidate_id in train_ids
                ],
                dtype=np.int64,
            )
            holdout_label_values = np.asarray(
                [
                    bool(rows_by_id[candidate_id]["safeForBubbleFit"])
                    for candidate_id in holdout_ids
                ],
                dtype=np.int64,
            )
            holdout_probability_values = np.asarray(
                [float(row["safeProbability"]) for row in holdout_rows],
                dtype=np.float64,
            )
            expected_holdout_metrics = (
                _binary_metrics(
                    holdout_label_values,
                    holdout_probability_values,
                    float(selected_threshold),
                )
                if selected_threshold is not None
                else None
            )
            expected_class_issues = (
                ["holdout_has_single_class_metrics_partially_undefined"]
                if 0
                in {
                    "safe": int(np.count_nonzero(holdout_label_values == 1)),
                    "unsafe": int(np.count_nonzero(holdout_label_values == 0)),
                }.values()
                else []
            )
            if (
                fold_record.get("trainWorkIds") != split_fold["trainWorkIds"]
                or fold_record.get("holdoutWorkIds") != split_fold["holdoutWorkIds"]
                or fold_record.get("thresholdSelectionCandidateIdsSha256")
                != _sha256_json(train_ids)
                or fold_record.get("holdoutCandidateIdsSha256")
                != _sha256_json(holdout_ids)
                or fold_record.get("thresholdSelectionExcludesHoldout") is not True
                or fold_record.get("selectedThreshold") != selected_threshold
                or fold_record.get("innerThresholdAvailable")
                is not fold_decision_available
                or fold_record.get("holdoutMetrics") != expected_holdout_metrics
                or fold_record.get("holdoutEvaluationRole") != "exploratory outer OOF"
                or fold_record.get("outerDecisionAvailable")
                is not fold_decision_available
                or fold_record.get("confirmatory") is not False
                or fold_record.get("classIssues") != expected_class_issues
            ):
                raise BubbleFitTrainingError(
                    "model outer fold report differs from OOF rows/split plan"
                )
            require_evidence = _has_recomputable_threshold_evidence(schema_version)
            evidence = fold_record.get("thresholdSelectionSafeProbabilities")
            if require_evidence:
                if fold_record.get("thresholdSelectionEvidenceRole") != (
                    "unkeyed producer evidence: sealed inner work-disjoint OOF "
                    "probabilities in split-plan train-candidate order; validator "
                    "recomputes dependent thresholdSelection but does not reexecute "
                    "the neural fold model"
                ):
                    raise BubbleFitTrainingError(
                        "model threshold selection evidence role is invalid"
                    )
            elif any(
                field in fold_record
                for field in (
                    "thresholdSelectionSafeProbabilities",
                    "thresholdSelectionEvidenceRole",
                )
            ):
                raise BubbleFitTrainingError(
                    "legacy model fold contains unversioned threshold evidence"
                )
            _assert_threshold_selection_binding(
                record=fold_record.get("thresholdSelection"),
                selected_threshold=selected_threshold,
                labels=train_label_values,
                config=validated_config,
                location=f"{model_kind}.{fold_id}.thresholdSelection",
                sealed_probabilities=evidence,
                require_recomputable_evidence=require_evidence,
            )
            inner_records = fold_record.get("innerWorkDisjointFolds")
            train_work_ids = sorted(
                {str(rows_by_id[candidate_id]["workId"]) for candidate_id in train_ids}
            )
            if not isinstance(inner_records, list) or len(inner_records) != len(
                train_work_ids
            ):
                raise BubbleFitTrainingError("inner threshold fold coverage is invalid")
            for inner_index, (holdout_work_id, inner_record) in enumerate(
                zip(train_work_ids, inner_records, strict=True), start=1
            ):
                validation_ids = [
                    candidate_id
                    for candidate_id in train_ids
                    if rows_by_id[candidate_id]["workId"] == holdout_work_id
                ]
                training_ids = [
                    candidate_id
                    for candidate_id in train_ids
                    if rows_by_id[candidate_id]["workId"] != holdout_work_id
                ]
                training_labels = np.asarray(
                    [
                        bool(rows_by_id[candidate_id]["safeForBubbleFit"])
                        for candidate_id in training_ids
                    ],
                    dtype=np.int64,
                )
                validation_labels = np.asarray(
                    [
                        bool(rows_by_id[candidate_id]["safeForBubbleFit"])
                        for candidate_id in validation_ids
                    ],
                    dtype=np.int64,
                )
                if (
                    not isinstance(inner_record, Mapping)
                    or inner_record.get("innerFoldId")
                    != f"{fold_id}-threshold-{inner_index:02d}"
                    or inner_record.get("trainWorkIds")
                    != [work for work in train_work_ids if work != holdout_work_id]
                    or inner_record.get("validationWorkIds") != [holdout_work_id]
                    or inner_record.get("trainCandidateIdsSha256")
                    != _sha256_json(training_ids)
                    or inner_record.get("validationCandidateIdsSha256")
                    != _sha256_json(validation_ids)
                    or inner_record.get("trainClassCounts")
                    != {
                        "safe": int(np.count_nonzero(training_labels == 1)),
                        "unsafe": int(np.count_nonzero(training_labels == 0)),
                    }
                    or inner_record.get("validationClassCounts")
                    != {
                        "safe": int(np.count_nonzero(validation_labels == 1)),
                        "unsafe": int(np.count_nonzero(validation_labels == 0)),
                    }
                    or not isinstance(inner_record.get("fit"), Mapping)
                ):
                    raise BubbleFitTrainingError(
                        "inner threshold fold differs from split-plan partition"
                    )

        expected_outer = _decision_metrics_for_selector(
            ordered_labels,
            ordered_predicted,
            ordered_available,
            np.ones(len(ordered_rows), dtype=bool),
        )
        unavailable_fold_count = sum(
            not bool(record["innerThresholdAvailable"]) for record in fold_records
        )
        all_decisions_available = bool(np.all(ordered_available))
        expected_checks, expected_target_met = _outer_exploratory_target_checks(
            expected_outer,
            all_outer_decisions_available=all_decisions_available,
            config=validated_config,
        )
        expected_outer.update(
            {
                "evaluationRole": (
                    "exploratory outer OOF after inner work-disjoint threshold "
                    "selection"
                ),
                "thresholdMode": ("per-outer-fold inner-work selection diagnostic"),
                "allOuterDecisionsAvailable": all_decisions_available,
                "innerThresholdUnavailableOuterFoldCount": unavailable_fold_count,
                "outerFoldCount": len(fold_records),
                "outerExploratoryTargetChecks": expected_checks,
                "outerExploratoryTargetMet": expected_target_met,
                "candidateIndependenceAsserted": False,
                "confirmatory": False,
                "productionSafetyEstablished": False,
            }
        )
        expected_work = _work_macro_metrics(
            metric_samples,
            ordered_labels,
            ordered_predicted,
            ordered_available,
        )
        expected_confidence, expected_subtypes = _confidence_and_subtype_metrics(
            metric_samples,
            ordered_labels,
            ordered_predicted,
            ordered_available,
        )
        confidence_invalid = (
            expected_snapshot is not None
            and model_record.get("confidenceMetrics") != expected_confidence
        )
        expected_fold_aggregation = {
            "method": (
                "forbidden: fold thresholds are not calibrated for an all-data fit"
            ),
            "threshold": None,
            "operationalThreshold": None,
            "calibrationRequired": True,
        }
        if (
            model_record.get("promotionEligible") is not False
            or model_record.get("productionUseForbidden") is not True
            or model_record.get("productionSafetyEstablished") is not False
            or model_record.get("confirmatory") is not False
            or model_record.get("runtimePreprocessorParity") is not False
            or model_record.get("exactProductionFloodParity") is not False
            or model_record.get("currentRunRole") != "exploratory development OOF only"
            or model_record.get("evaluationRole") != "exploratory model comparison only"
            or model_record.get("inputContract") != input_contract
            or model_record.get("outerOofMetrics") != expected_outer
            or model_record.get("workMacroMetrics") != expected_work
            or confidence_invalid
            or model_record.get("unsafeSubtypeFalseAcceptMetrics") != expected_subtypes
            or model_record.get("foldThresholdAggregationForOptionalFinalCandidate")
            != expected_fold_aggregation
        ):
            raise BubbleFitTrainingError(
                "model aggregate metrics differ from recomputed OOF rows"
            )
        if _has_recomputable_threshold_evidence(schema_version):
            expected_threshold_free = _combined_oof_threshold_free_metrics(
                metric_samples, ordered_labels, ordered_probabilities
            )
            if (
                model_record.get("thresholdFreeCombinedOofMetrics")
                != expected_threshold_free
            ):
                raise BubbleFitTrainingError(
                    "combined threshold-free OOF metrics differ from prediction rows"
                )
        elif "thresholdFreeCombinedOofMetrics" in model_record:
            raise BubbleFitTrainingError(
                "legacy model report contains unversioned threshold-free metrics"
            )

    expected_ranking = rank_model_records(models, schema_version=schema_version)
    expected_target_met_models = [
        model_kind
        for model_kind in expected_ranking
        if bool(
            model_record_by_kind[model_kind]["outerOofMetrics"].get(
                "outerExploratoryTargetMet"
            )
        )
    ]
    if (
        report.get("modelRankingExploratoryTargetFirst") != expected_ranking
        or report.get("rankingStatus") != _ranking_status(schema_version)
        or report.get("outerExploratoryTargetMetModels") != expected_target_met_models
        or report.get("bestCrudeProbeOnly")
        != (expected_target_met_models[0] if expected_target_met_models else None)
        or report.get("bestCrudeProbeIsExploratoryOnly") is not True
    ):
        raise BubbleFitTrainingError(
            "evaluation report ranking differs from recomputed model evidence"
        )

    cross_pack_plan_sha256: str | None = None
    cross_pack_predictions_sha256: str | None = None
    if is_pack_set:
        assert isinstance(expected_snapshot, DatasetPackSetSnapshot)
        cross_plan_path = output_dir / "cross-pack-plan.json"
        cross_predictions_path = output_dir / "cross-pack-predictions.jsonl"
        cross_plan = _read_json(cross_plan_path, "cross-pack plan")
        _assert_common_nonpromotable(
            cross_plan,
            "cross-pack plan",
            schema_version=schema_version,
        )
        expected_cross_plan = build_cross_pack_plan(
            expected_snapshot, schema_version=schema_version
        )
        if cross_plan != expected_cross_plan:
            raise BubbleFitTrainingError(
                "cross-pack plan differs from the revalidated pack-set"
            )
        bound_cross_plan = dict(cross_plan)
        declared_plan_binding = bound_cross_plan.pop("planBindingSha256", None)
        if declared_plan_binding != _sha256_json(bound_cross_plan):
            raise BubbleFitTrainingError("cross-pack plan binding is invalid")
        cross_rows = _read_jsonl_objects(
            cross_predictions_path, "cross-pack predictions"
        )
        directions_by_id = {
            str(direction["directionId"]): direction
            for direction in expected_cross_plan["directions"]
        }
        expected_target_keys_by_direction: dict[str, set[str]] = {}
        cross_support_by_model_direction: dict[
            tuple[str, str], tuple[bool, tuple[str, ...]]
        ] = {}
        for direction_id, direction in directions_by_id.items():
            train_indices, target_indices = _cross_pack_indices(
                expected_snapshot, direction
            )
            expected_target_keys_by_direction[direction_id] = {
                f"{expected_snapshot.samples[index].pack_id}:"
                f"{expected_snapshot.samples[index].candidate_id}"
                for index in target_indices
            }
            train_class_targets = _multiclass_targets(
                [expected_snapshot.samples[index] for index in train_indices]
            )
            train_local_indices = tuple(range(len(train_indices)))
            for model_kind in model_kinds:
                missing_classes = (
                    _missing_multiclass_training_classes(
                        train_local_indices, train_class_targets
                    )
                    if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND
                    else []
                )
                cross_support_by_model_direction[(str(model_kind), direction_id)] = (
                    not missing_classes,
                    tuple(missing_classes),
                )
        seen_cross_keys: set[tuple[str, str, str]] = set()
        cross_row_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
        cross_class_vector_by_key: dict[tuple[str, str, str], np.ndarray] = {}
        actual_target_keys: dict[tuple[str, str], set[str]] = {}
        threshold_by_model_direction: dict[tuple[str, str], float | None] = {}
        for index, row in enumerate(cross_rows, start=1):
            _assert_common_nonpromotable(
                row,
                f"cross-pack prediction {index}",
                schema_version=schema_version,
            )
            model_kind = row.get("modelKind")
            direction_id = row.get("directionId")
            candidate_id = row.get("candidateId")
            direction = directions_by_id.get(str(direction_id))
            sample = expected_samples_by_id.get(str(candidate_id))
            support_key = (str(model_kind), str(direction_id))
            if (
                model_kind not in model_kinds
                or direction is None
                or sample is None
                or not cross_support_by_model_direction.get(support_key, (False, ()))[0]
                or row.get("packId") != direction["targetPackId"]
                or row.get("packId") != sample.pack_id
                or row.get("packRole") != direction["targetRole"]
                or row.get("packRole") != sample.pack_role
                or not _cross_identity_matches(row, direction)
                or row.get("candidateKey") != f"{sample.pack_id}:{sample.candidate_id}"
                or row.get("sourceOrdinal") != sample.ordinal
                or row.get("sourceSelectionIndex") != sample.selection_index
                or row.get("combinedOrdinal") != sample.combined_ordinal
                or row.get("workId") != sample.work_id
                or row.get("label") != sample.label
                or row.get("safeForBubbleFit") != sample.safe
                or sample.work_id in set(direction["excludedOverlapWorkIds"])
                or not _cross_partition_row_matches(expected_snapshot, row)
                or row.get("targetLabelsUsedForFit") is not False
                or row.get("targetLabelsStructurallyAbsentFromFit") is not True
                or row.get("targetLabelsUsedForThreshold") is not False
                or row.get("targetLabelsUsedForMetricsOnly") is not True
                or row.get("promotionAuthority") is not False
                or row.get("evaluationRole")
                != _cross_prediction_role(expected_snapshot)
            ):
                raise BubbleFitTrainingError(
                    "cross-pack prediction source/partition binding is invalid"
                )
            probability = row.get("safeProbability")
            if (
                isinstance(probability, bool)
                or not isinstance(probability, (int, float))
                or not math.isfinite(float(probability))
                or not 0.0 <= float(probability) <= 1.0
            ):
                raise BubbleFitTrainingError(
                    "cross-pack prediction probability is invalid"
                )
            threshold = row.get("sourceThreshold")
            if threshold is not None and (
                isinstance(threshold, bool)
                or not isinstance(threshold, (int, float))
                or not math.isfinite(float(threshold))
                or not 0.0 <= float(threshold) <= 1.0
            ):
                raise BubbleFitTrainingError("cross-pack source threshold is invalid")
            if (
                row.get("decisionAvailable") is not (threshold is not None)
                or (threshold is None and row.get("predictedSafe") is not None)
                or (
                    threshold is not None
                    and row.get("predictedSafe")
                    is not (float(probability) >= float(threshold))
                )
            ):
                raise BubbleFitTrainingError(
                    "cross-pack prediction decision semantics are invalid"
                )
            key = (str(model_kind), str(direction_id), str(row["candidateKey"]))
            if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
                class_vector = _validated_class_probability_vector(
                    row.get("classProbabilities"),
                    f"cross-pack prediction {index}.classProbabilities",
                )
                if (
                    not math.isclose(
                        float(probability),
                        float(class_vector[SAFE_CLASS_INDEX]),
                        rel_tol=0.0,
                        abs_tol=1e-12,
                    )
                    or row.get("predictedClass")
                    != ALLOWED_LABELS[int(np.argmax(class_vector))]
                    or row.get("safeScoreSource") != "softmax_safe_opaque_probability"
                ):
                    raise BubbleFitTrainingError(
                        "five-class cross-pack probability semantics are invalid"
                    )
                cross_class_vector_by_key[key] = class_vector
            elif any(
                field in row
                for field in (
                    "classProbabilities",
                    "predictedClass",
                    "safeScoreSource",
                )
            ):
                raise BubbleFitTrainingError(
                    "binary cross-pack prediction contains five-class fields"
                )
            if key in seen_cross_keys:
                raise BubbleFitTrainingError(
                    "cross-pack prediction coverage is not bijective"
                )
            seen_cross_keys.add(key)
            cross_row_by_key[key] = row
            actual_target_keys.setdefault(
                (str(model_kind), str(direction_id)), set()
            ).add(str(row["candidateKey"]))
            threshold_key = (str(model_kind), str(direction_id))
            if threshold_key in threshold_by_model_direction and (
                threshold_by_model_direction[threshold_key] != threshold
            ):
                raise BubbleFitTrainingError(
                    "cross-pack source threshold differs within a direction"
                )
            threshold_by_model_direction[threshold_key] = threshold
        for model_kind in model_kinds:
            for (
                direction_id,
                expected_keys,
            ) in expected_target_keys_by_direction.items():
                supported, _missing_classes = cross_support_by_model_direction[
                    (str(model_kind), direction_id)
                ]
                model_expected_keys = expected_keys if supported else set()
                if (
                    actual_target_keys.get((str(model_kind), direction_id), set())
                    != model_expected_keys
                ):
                    raise BubbleFitTrainingError(
                        "cross-pack prediction target coverage is incomplete"
                    )
        cross_report = report.get("crossPackEvaluation")
        cross_report_schema_invalid = (
            cross_report.get("inputPackSetSchemaVersion")
            != INPUT_PACK_SET_SCHEMA_VERSION
            if isinstance(cross_report, dict)
            and expected_snapshot.input_schema_version == INPUT_PACK_SET_SCHEMA_VERSION
            else isinstance(cross_report, dict)
            and "inputPackSetSchemaVersion" in cross_report
        )
        cross_report_variant_polluted = isinstance(cross_report, dict) and any(
            key in cross_report
            for key in (
                CROSS_PARTITION_VARIANT_FIELDS | {"trainPackId", "trainPackIds"}
            )
        )
        if (
            not isinstance(cross_report, dict)
            or cross_report_schema_invalid
            or cross_report_variant_polluted
            or cross_report.get("evaluationRole")
            != _cross_report_role(expected_snapshot)
            or cross_report.get("modelKinds") != model_kinds
            or cross_report.get("affectsCombinedModelRanking") is not False
            or cross_report.get("promotionAuthority") is not False
            or cross_report.get("confirmatory") is not False
            or cross_report.get("productionSafetyEstablished") is not False
            or not isinstance(cross_report.get("models"), list)
            or [record.get("modelKind") for record in cross_report["models"]]
            != model_kinds
        ):
            raise BubbleFitTrainingError("cross-pack report contract is invalid")
        for model_record in cross_report["models"]:
            direction_records = model_record.get("directions")
            if (
                any(
                    key in model_record
                    for key in (
                        CROSS_PARTITION_VARIANT_FIELDS | CROSS_IDENTITY_VARIANT_FIELDS
                    )
                )
                or model_record.get("affectsCombinedModelRanking") is not False
                or model_record.get("promotionAuthority") is not False
                or model_record.get("confirmatory") is not False
                or model_record.get("productionSafetyEstablished") is not False
                or not isinstance(direction_records, list)
                or {record.get("directionId") for record in direction_records}
                != set(directions_by_id)
            ):
                raise BubbleFitTrainingError(
                    "cross-pack model report contract is invalid"
                )
            for direction_record in direction_records:
                key = (
                    str(model_record["modelKind"]),
                    str(direction_record["directionId"]),
                )
                direction = directions_by_id[str(direction_record["directionId"])]
                train_indices, target_indices = _cross_pack_indices(
                    expected_snapshot, direction
                )
                supported, missing_classes = cross_support_by_model_direction[key]
                target_samples = [
                    expected_snapshot.samples[index] for index in target_indices
                ]
                if not supported:
                    expected_unsupported_record = _unsupported_multiclass_cross_record(
                        direction=direction,
                        train_candidate_count=len(train_indices),
                        target_samples=target_samples,
                        missing_classes=missing_classes,
                        reason=(
                            "source-unique cross-pack training cohort omits "
                            + ", ".join(missing_classes)
                        ),
                    )
                    if (
                        direction_record != expected_unsupported_record
                        or key in threshold_by_model_direction
                        or actual_target_keys.get(key) not in (None, set())
                    ):
                        raise BubbleFitTrainingError(
                            "unsupported five-class cross-pack direction is invalid"
                        )
                    continue
                ordered_rows = [
                    cross_row_by_key[
                        (
                            str(model_record["modelKind"]),
                            str(direction_record["directionId"]),
                            f"{expected_snapshot.samples[index].pack_id}:"
                            f"{expected_snapshot.samples[index].candidate_id}",
                        )
                    ]
                    for index in target_indices
                ]
                target_probabilities = np.asarray(
                    [row["safeProbability"] for row in ordered_rows],
                    dtype=np.float64,
                )
                target_labels = np.asarray(
                    [expected_snapshot.samples[index].safe for index in target_indices],
                    dtype=np.int64,
                )
                threshold = threshold_by_model_direction[key]
                decision_available = np.full(
                    len(target_indices), threshold is not None, dtype=bool
                )
                predicted_safe = (
                    target_probabilities >= float(threshold)
                    if threshold is not None
                    else np.zeros(len(target_indices), dtype=bool)
                )
                expected_decision_metrics = _decision_metrics_for_selector(
                    target_labels,
                    predicted_safe,
                    decision_available,
                    np.ones(len(target_indices), dtype=bool),
                )
                expected_work_macro = _work_macro_metrics(
                    target_samples,
                    target_labels,
                    predicted_safe,
                    decision_available,
                )
                expected_confidence, expected_subtypes = (
                    _confidence_and_subtype_metrics(
                        target_samples,
                        target_labels,
                        predicted_safe,
                        decision_available,
                    )
                )
                threshold_selection = direction_record.get("sourceThresholdSelection")
                source_samples = [
                    expected_snapshot.samples[index] for index in train_indices
                ]
                source_labels = np.asarray(
                    [sample.safe for sample in source_samples], dtype=np.int64
                )
                source_inner_records = direction_record.get(
                    "sourceInnerWorkDisjointFolds"
                )
                source_work_ids = sorted({sample.work_id for sample in source_samples})
                source_evidence_present = (
                    direction_record.get("sourceThresholdSelectionSafeProbabilities")
                    is not None
                )
                validate_source_inner = source_evidence_present or (
                    not _has_recomputable_threshold_evidence(schema_version)
                    and source_inner_records != []
                )
                if validate_source_inner:
                    if not isinstance(source_inner_records, list) or len(
                        source_inner_records
                    ) != len(source_work_ids):
                        raise BubbleFitTrainingError(
                            "cross-pack inner threshold fold coverage is invalid"
                        )
                    for inner_index, (
                        holdout_work_id,
                        inner_record,
                    ) in enumerate(
                        zip(
                            source_work_ids,
                            source_inner_records,
                            strict=True,
                        ),
                        start=1,
                    ):
                        validation_indices = [
                            index
                            for index, sample in enumerate(source_samples)
                            if sample.work_id == holdout_work_id
                        ]
                        training_indices = [
                            index
                            for index, sample in enumerate(source_samples)
                            if sample.work_id != holdout_work_id
                        ]
                        if (
                            not isinstance(inner_record, Mapping)
                            or inner_record.get("innerFoldId")
                            != (
                                f"cross-{direction_record['directionId']}-"
                                f"threshold-{inner_index:02d}"
                            )
                            or inner_record.get("trainWorkIds")
                            != [
                                work_id
                                for work_id in source_work_ids
                                if work_id != holdout_work_id
                            ]
                            or inner_record.get("validationWorkIds")
                            != [holdout_work_id]
                            or inner_record.get("trainCandidateIdsSha256")
                            != _sha256_json(
                                [
                                    source_samples[index].candidate_id
                                    for index in training_indices
                                ]
                            )
                            or inner_record.get("validationCandidateIdsSha256")
                            != _sha256_json(
                                [
                                    source_samples[index].candidate_id
                                    for index in validation_indices
                                ]
                            )
                            or inner_record.get("trainClassCounts")
                            != _class_counts(training_indices, source_labels)
                            or inner_record.get("validationClassCounts")
                            != _class_counts(validation_indices, source_labels)
                            or not isinstance(inner_record.get("fit"), Mapping)
                        ):
                            raise BubbleFitTrainingError(
                                "cross-pack inner threshold fold binding is invalid"
                            )
                elif source_inner_records != []:
                    raise BubbleFitTrainingError(
                        "cross-pack unavailable threshold has partial inner folds"
                    )
                if _has_recomputable_threshold_evidence(schema_version):
                    source_evidence = direction_record.get(
                        "sourceThresholdSelectionSafeProbabilities"
                    )
                    if direction_record.get("sourceThresholdSelectionEvidenceRole") != (
                        "unkeyed producer evidence: sealed source-pack inner "
                        "work-disjoint OOF probabilities in cross-plan "
                        "train-candidate order; validator recomputes dependent "
                        "sourceThresholdSelection but does not reexecute the neural "
                        "fold model"
                    ):
                        raise BubbleFitTrainingError(
                            "cross-pack threshold evidence role is invalid"
                        )
                    if source_evidence is not None:
                        _assert_threshold_selection_binding(
                            record=threshold_selection,
                            selected_threshold=threshold,
                            labels=source_labels,
                            config=validated_config,
                            location=(
                                f"crossPack.{model_record['modelKind']}."
                                f"{direction_record['directionId']}."
                                "sourceThresholdSelection"
                            ),
                            sealed_probabilities=source_evidence,
                            require_recomputable_evidence=True,
                        )
                    else:
                        if threshold is not None or source_inner_records != []:
                            raise BubbleFitTrainingError(
                                "cross-pack missing threshold evidence is invalid"
                            )
                        _assert_no_source_threshold_record(
                            threshold_selection,
                            location=(
                                f"crossPack.{model_record['modelKind']}."
                                f"{direction_record['directionId']}."
                                "sourceThresholdSelection"
                            ),
                        )
                else:
                    if any(
                        field in direction_record
                        for field in (
                            "sourceThresholdSelectionSafeProbabilities",
                            "sourceThresholdSelectionEvidenceRole",
                        )
                    ):
                        raise BubbleFitTrainingError(
                            "legacy cross-pack report contains unversioned threshold "
                            "evidence"
                        )
                    threshold_location = (
                        f"crossPack.{model_record['modelKind']}."
                        f"{direction_record['directionId']}."
                        "sourceThresholdSelection"
                    )
                    if source_inner_records == []:
                        if threshold is not None:
                            raise BubbleFitTrainingError(
                                "legacy cross-pack no-source threshold is non-null"
                            )
                        _assert_no_source_threshold_record(
                            threshold_selection,
                            location=threshold_location,
                        )
                    else:
                        _assert_threshold_selection_binding(
                            record=threshold_selection,
                            selected_threshold=threshold,
                            labels=source_labels,
                            config=validated_config,
                            location=threshold_location,
                            sealed_probabilities=None,
                            require_recomputable_evidence=False,
                        )
                model_kind = str(model_record["modelKind"])
                if model_kind == LINEAR_FIVE_CLASS_MODEL_KIND:
                    target_class_probabilities = np.stack(
                        [
                            cross_class_vector_by_key[
                                (
                                    model_kind,
                                    str(direction_record["directionId"]),
                                    str(row["candidateKey"]),
                                )
                            ]
                            for row in ordered_rows
                        ]
                    )
                    expected_multiclass_metrics = _multiclass_classification_metrics(
                        [sample.label for sample in target_samples],
                        target_class_probabilities,
                    )
                    multiclass_contract_invalid = (
                        direction_record.get("status") != "evaluated"
                        or direction_record.get("supported") is not True
                        or direction_record.get("missingTrainingClasses") != []
                        or direction_record.get("predictionCount")
                        != len(target_indices)
                        or direction_record.get("targetLabelClassCounts")
                        != _cross_label_class_counts(target_samples)
                        or direction_record.get("targetMulticlassMetrics")
                        != expected_multiclass_metrics
                    )
                else:
                    multiclass_contract_invalid = any(
                        field in direction_record
                        for field in (
                            "status",
                            "supported",
                            "missingTrainingClasses",
                            "predictionCount",
                            "targetLabelClassCounts",
                            "targetMulticlassMetrics",
                        )
                    )
                if (
                    not _cross_direction_report_variant_matches(
                        direction_record, direction
                    )
                    or direction_record.get("excludedOverlapWorkIdsSha256")
                    != direction["excludedOverlapWorkIdsSha256"]
                    or direction_record.get("trainWorkIdsSha256")
                    != direction["trainWorkIdsSha256"]
                    or direction_record.get("targetWorkIdsSha256")
                    != direction["targetWorkIdsSha256"]
                    or direction_record.get("trainCandidateCount")
                    != direction["trainCandidateCount"]
                    or direction_record.get("targetCandidateCount")
                    != direction["targetCandidateCount"]
                    or direction_record.get("trainTargetWorkIntersection") != []
                    or direction_record.get("sourceThreshold") != threshold
                    or direction_record.get("decisionAvailable")
                    is not (threshold is not None)
                    or not isinstance(threshold_selection, dict)
                    or threshold_selection.get("innerThresholdAvailable")
                    is not (threshold is not None)
                    or threshold_selection.get("selectedThreshold") != threshold
                    or direction_record.get("affectsCombinedModelRanking") is not False
                    or direction_record.get("promotionAuthority") is not False
                    or direction_record.get("confirmatory") is not False
                    or direction_record.get("productionSafetyEstablished") is not False
                    or direction_record.get("evaluationRole")
                    != _cross_direction_diagnostic_role(expected_snapshot)
                    or direction_record.get("targetLabelsUsedForFit") is not False
                    or direction_record.get("targetLabelsStructurallyAbsentFromFit")
                    is not True
                    or direction_record.get("targetLabelsUsedForThreshold") is not False
                    or direction_record.get("targetLabelsUsedForMetricsOnly")
                    is not True
                    or direction_record.get("targetThresholdFreeMetrics")
                    != _threshold_free_score_metrics(
                        target_labels, target_probabilities
                    )
                    or direction_record.get("targetDecisionMetrics")
                    != expected_decision_metrics
                    or direction_record.get("targetWorkMacroMetrics")
                    != expected_work_macro
                    or direction_record.get("targetConfidenceMetrics")
                    != expected_confidence
                    or direction_record.get("targetUnsafeSubtypeFalseAcceptMetrics")
                    != expected_subtypes
                    or multiclass_contract_invalid
                ):
                    raise BubbleFitTrainingError(
                        "cross-pack direction report binding is invalid"
                    )
        cross_pack_plan_sha256 = _sha256_file(cross_plan_path)
        cross_pack_predictions_sha256 = _sha256_file(cross_predictions_path)
        if (
            report.get("crossPackPlanSha256") != cross_pack_plan_sha256
            or report.get("crossPackPredictionsSha256") != cross_pack_predictions_sha256
        ):
            raise BubbleFitTrainingError("cross-pack report file binding is invalid")

    requires_mobile = any(
        model_kind != "heuristic_original_core_v1" for model_kind in model_kinds
    )
    recalculated_authority = execution_authority(
        requires_mobile=requires_mobile, output_dir=output_dir
    )
    if authority != recalculated_authority:
        if schema_version in {
            SCHEMA_VERSION,
            LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        }:
            raise BubbleFitTrainingError(
                "legacy v4/v5 structural reader compatibility does not imply "
                "historical producer-byte authority compatibility; exact "
                "executionAuthority intentionally fails under a changed current "
                "trainer/runtime"
            )
        raise BubbleFitTrainingError(
            "execution authority differs from the current producer environment"
        )
    split_plan_sha256 = _sha256_file(split_plan_path)
    oof_predictions_sha256 = _sha256_file(oof_path)
    expected_bindings = _expected_authority_bindings(
        source=source,
        config_payload=config_payload,
        input_contract=input_contract,
        run_configuration=expected_run_configuration,
        confirmatory_contract=expected_confirmatory,
        split_plan_sha256=split_plan_sha256,
        oof_predictions_sha256=oof_predictions_sha256,
        authority=recalculated_authority,
        cross_pack_plan_sha256=cross_pack_plan_sha256,
        cross_pack_predictions_sha256=cross_pack_predictions_sha256,
    )
    if bindings != expected_bindings:
        raise BubbleFitTrainingError(
            "evaluation report authority cross-binding mismatch"
        )
    if (
        report.get("splitPlanSha256") != split_plan_sha256
        or report.get("oofPredictionsSha256") != oof_predictions_sha256
    ):
        raise BubbleFitTrainingError("evaluation report file binding mismatch")
    final_contract_path = output_dir / "final-candidate-contract.json"
    if final_contract is not None:
        if (
            final_contract.get("executionAuthority") != authority
            or final_contract.get("authorityBindings") != bindings
        ):
            raise BubbleFitTrainingError("final candidate authority differs from seal")
        for key in direct_keys:
            if final_contract.get(key) != bindings.get(key):
                raise BubbleFitTrainingError(
                    f"final candidate direct authority mismatch: {key}"
                )
    return {
        "ok": True,
        "schemaVersion": schema_version,
        **_current_schema_contract_fields(schema_version),
        "fileCount": len(expected_files),
        "manifestSha256": _sha256_file(manifest_path),
        "sealSha256": _sha256_file(seal_path),
        "authorityBindingSha256": bindings["bindingSha256"],
        "promotionEligible": False,
    }


def run_evaluation(
    *,
    snapshot: TrainingSnapshot,
    output_dir: Path,
    model_kinds: Sequence[str],
    config: EvaluationConfig,
    allow_official_weight_download: bool,
    export_final_model: str | None = None,
) -> dict[str, Any]:
    _validate_evaluation_config(config)
    schema_version = _output_schema_version(snapshot)
    if not model_kinds or len(set(model_kinds)) != len(model_kinds):
        raise BubbleFitTrainingError("model list must be nonempty and unique")
    if any(model not in MODEL_KINDS for model in model_kinds):
        raise BubbleFitTrainingError("model list contains an unsupported model")
    if export_final_model is not None and export_final_model not in model_kinds:
        raise BubbleFitTrainingError(
            "final export model must be one of the evaluated models"
        )
    if (
        export_final_model is not None
        and export_final_model not in EXPORTABLE_MODEL_KINDS
    ):
        raise BubbleFitTrainingError(
            "only binary MobileNet models support final/ONNX export"
        )
    cross_pack_plan = (
        build_cross_pack_plan(snapshot)
        if isinstance(snapshot, DatasetPackSetSnapshot)
        else None
    )
    output_dir = _ensure_new_output(output_dir)
    needs_mobile = any(model != "heuristic_original_core_v1" for model in model_kinds)
    authority = execution_authority(requires_mobile=needs_mobile, output_dir=output_dir)
    _assert_no_absolute_paths(authority)
    determinism = seed_everything(config.seed)
    inputs = np.stack(
        [load_production_input(sample) for sample in snapshot.samples]
    ).astype(np.float32)
    labels = np.asarray([sample.safe for sample in snapshot.samples], dtype=np.int64)
    if set(np.unique(labels)) != {0, 1}:
        raise BubbleFitTrainingError(
            "crude probe must contain safe and unsafe examples"
        )
    folds = build_grouped_folds(snapshot.samples)
    split_plan = split_plan_payload(
        folds, snapshot.samples, schema_version=schema_version
    )
    weight_bundle = (
        load_official_mobilenet_weights(allow_download=allow_official_weight_download)
        if needs_mobile
        else None
    )
    model_records: list[dict[str, Any]] = []
    all_oof: list[dict[str, Any]] = []
    for model_kind in model_kinds:
        record, rows = evaluate_model(
            model_kind,
            folds,
            snapshot.samples,
            inputs,
            labels,
            config,
            weight_bundle,
            schema_version=schema_version,
        )
        if model_kind != "heuristic_original_core_v1" and weight_bundle is not None:
            record["officialWeights"] = dict(weight_bundle.provenance)
        else:
            record["officialWeights"] = None
        model_records.append(record)
        all_oof.extend(rows)
    ranking = rank_model_records(model_records, schema_version=schema_version)
    cohort_counts = {
        "sourcePageCount": snapshot.source_page_count,
        "sourceWorkCount": len(snapshot.source_work_ids),
        "candidateCount": len(snapshot.samples),
        "candidateBearingWorkCount": len(snapshot.work_ids),
    }
    exploratory_target_met_models = [
        model_kind
        for model_kind in ranking
        if next(
            record for record in model_records if record["modelKind"] == model_kind
        )["outerOofMetrics"]["outerExploratoryTargetMet"]
    ]
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_json(output_dir / "split-plan.json", split_plan)
    _write_jsonl(output_dir / "oof-predictions.jsonl", all_oof)
    cross_pack_plan_sha256: str | None = None
    cross_pack_predictions_sha256: str | None = None
    cross_pack_evaluation: dict[str, Any] | None = None
    if isinstance(snapshot, DatasetPackSetSnapshot):
        if cross_pack_plan is None:
            raise BubbleFitTrainingError("pack-set external plan is unavailable")
        cross_pack_evaluation, cross_pack_predictions = evaluate_cross_pack_directions(
            snapshot=snapshot,
            plan=cross_pack_plan,
            model_kinds=model_kinds,
            inputs=inputs,
            labels=labels,
            config=config,
            weight_bundle=weight_bundle,
        )
        _write_json(output_dir / "cross-pack-plan.json", cross_pack_plan)
        _write_jsonl(
            output_dir / "cross-pack-predictions.jsonl", cross_pack_predictions
        )
        cross_pack_plan_sha256 = _sha256_file(output_dir / "cross-pack-plan.json")
        cross_pack_predictions_sha256 = _sha256_file(
            output_dir / "cross-pack-predictions.jsonl"
        )
    split_plan_sha256 = _sha256_file(output_dir / "split-plan.json")
    oof_predictions_sha256 = _sha256_file(output_dir / "oof-predictions.jsonl")
    confirmatory_contract = confirmatory_audit_contract(
        current_source_work_count=len(snapshot.source_work_ids),
        target=config.unsafe_false_accept_target,
        schema_version=schema_version,
    )
    authority_bindings = build_authority_bindings(
        snapshot=snapshot,
        config=config,
        model_kinds=model_kinds,
        export_final_model=export_final_model,
        split_plan_sha256=split_plan_sha256,
        oof_predictions_sha256=oof_predictions_sha256,
        authority=authority,
        confirmatory_contract=confirmatory_contract,
        cross_pack_plan_sha256=cross_pack_plan_sha256,
        cross_pack_predictions_sha256=cross_pack_predictions_sha256,
    )
    config_payload = evaluation_config_payload(config)
    input_contract = production_input_contract()
    run_configuration = run_configuration_payload(
        config_payload=config_payload,
        model_kinds=model_kinds,
        export_final_model=export_final_model,
        input_contract=input_contract,
        schema_version=schema_version,
        input_pack_set_canonical_sha256=(
            snapshot.pack_set_canonical_sha256
            if isinstance(snapshot, DatasetPackSetSnapshot)
            else None
        ),
        input_pack_set_schema_version=(
            snapshot.input_schema_version
            if isinstance(snapshot, DatasetPackSetSnapshot)
            else None
        ),
        cross_pack_evaluation=isinstance(snapshot, DatasetPackSetSnapshot),
    )
    direct_keys = (
        PACK_SET_AUTHORITY_DIRECT_KEYS
        if isinstance(snapshot, DatasetPackSetSnapshot)
        else AUTHORITY_DIRECT_KEYS
    )
    multi_direct_payload = (
        {key: authority_bindings[key] for key in direct_keys}
        if isinstance(snapshot, DatasetPackSetSnapshot)
        else {}
    )
    report: dict[str, Any] = {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "artifactStage": _artifact_stage(
            snapshot.source_page_count, len(snapshot.samples)
        ),
        "cohortCounts": cohort_counts,
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "confirmatory": False,
        **_current_schema_contract_fields(schema_version),
        "currentRunRole": "exploratory development OOF only",
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        "promotionBlockReason": _promotion_block_reason(
            snapshot.source_page_count, len(snapshot.samples)
        ),
        "source": snapshot.provenance(),
        "inputContract": input_contract,
        "modelKinds": list(model_kinds),
        "runConfiguration": run_configuration,
        "executionAuthority": authority,
        "authorityBindings": authority_bindings,
        **multi_direct_payload,
        "confirmatoryAuditContract": confirmatory_contract,
        "safetyEvidenceLimits": _safety_evidence_limits(
            labels,
            unsafe_false_accept_target=config.unsafe_false_accept_target,
        ),
        "determinism": determinism,
        "config": config_payload,
        "versions": _runtime_versions_payload(),
        "splitPlanSha256": split_plan_sha256,
        "oofPredictionsSha256": oof_predictions_sha256,
        "modelRankingExploratoryTargetFirst": ranking,
        "rankingStatus": _ranking_status(schema_version),
        "bestCrudeProbeOnly": (
            exploratory_target_met_models[0] if exploratory_target_met_models else None
        ),
        "bestCrudeProbeIsExploratoryOnly": True,
        "outerExploratoryTargetMetModels": exploratory_target_met_models,
        "models": model_records,
    }
    if isinstance(snapshot, DatasetPackSetSnapshot):
        if (
            cross_pack_evaluation is None
            or cross_pack_plan_sha256 is None
            or cross_pack_predictions_sha256 is None
        ):
            raise BubbleFitTrainingError("pack-set cross evaluation is incomplete")
        report.update(
            {
                "crossPackPlanSha256": cross_pack_plan_sha256,
                "crossPackPredictionsSha256": cross_pack_predictions_sha256,
                "crossPackEvaluation": cross_pack_evaluation,
            }
        )
    final_contract = None
    if export_final_model is not None:
        if weight_bundle is None:
            raise BubbleFitTrainingError(
                "final MobileNet export lacks official weights"
            )
        final_contract = _train_final_mobile_candidate(
            export_final_model,
            inputs,
            labels,
            config,
            weight_bundle,
            output_dir,
            cohort_counts,
            authority,
            authority_bindings,
            confirmatory_contract,
            schema_version=schema_version,
            direct_authority_keys=direct_keys,
        )
        _write_json(output_dir / "final-candidate-contract.json", final_contract)
        report["optionalFinalCandidate"] = {
            "contractPath": "final-candidate-contract.json",
            "contractSha256": _sha256_file(
                output_dir / "final-candidate-contract.json"
            ),
            "modelKind": export_final_model,
            "promotionEligible": False,
            "productionUseForbidden": True,
            "operationalThreshold": None,
            "calibrationRequired": True,
            "runtimePreprocessorParity": False,
            "exactProductionFloodParity": False,
            "productionSafetyEstablished": False,
            "confirmatory": False,
            **_current_schema_contract_fields(schema_version),
        }
    else:
        report["optionalFinalCandidate"] = None
    _write_json(output_dir / "evaluation-report.json", report)
    if _sha256_file(Path(__file__).resolve()) != authority["trainerScript"]["sha256"]:
        raise BubbleFitTrainingError(
            "trainer script changed while evaluation was running"
        )
    artifact_files = []
    for path in sorted(
        (item for item in output_dir.rglob("*") if item.is_file()),
        key=lambda item: item.relative_to(output_dir).as_posix(),
    ):
        artifact_files.append(
            {
                "path": path.relative_to(output_dir).as_posix(),
                "sha256": _sha256_file(path),
                "sizeBytes": path.stat().st_size,
            }
        )
    artifact_manifest = {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "confirmatory": False,
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        **_current_schema_contract_fields(schema_version),
        "source": snapshot.provenance(),
        "executionAuthority": authority,
        "authorityBindings": authority_bindings,
        **multi_direct_payload,
        "confirmatoryAuditContract": confirmatory_contract,
        "files": artifact_files,
        "filesBindingSha256": _sha256_json(artifact_files),
    }
    _write_json(output_dir / "artifact-manifest.json", artifact_manifest)
    artifact_seal = {
        "schemaVersion": schema_version,
        "toolId": TOOL_ID,
        "promotionEligible": False,
        "productionUseForbidden": True,
        "productionSafetyEstablished": False,
        "confirmatory": False,
        "runtimePreprocessorParity": False,
        "exactProductionFloodParity": False,
        **_current_schema_contract_fields(schema_version),
        "source": snapshot.provenance(),
        "executionAuthority": authority,
        "authorityBindings": authority_bindings,
        **{key: authority_bindings[key] for key in direct_keys},
        "confirmatoryAuditContract": confirmatory_contract,
        "manifestFile": "artifact-manifest.json",
        "manifestSha256": _sha256_file(output_dir / "artifact-manifest.json"),
        **(
            {
                "inputPackSetCanonicalSha256": snapshot.pack_set_canonical_sha256,
                "sourcePacksCanonicalSha256": snapshot.source_packs_canonical_sha256,
            }
            if isinstance(snapshot, DatasetPackSetSnapshot)
            else {
                "sourceDatasetManifestSha256": snapshot.dataset_manifest_sha256,
                "sourceLabelsSha256": snapshot.labels_sha256,
            }
        ),
    }
    _write_json(output_dir / "artifact-seal.json", artifact_seal)
    artifact_validation = validate_output_artifacts(
        output_dir, expected_snapshot=snapshot
    )
    return {
        "ok": True,
        "outputDir": str(output_dir),
        "candidateCount": len(snapshot.samples),
        "sourcePageCount": snapshot.source_page_count,
        "sourceWorkCount": len(snapshot.source_work_ids),
        "candidateBearingWorkCount": len(snapshot.work_ids),
        "models": list(model_kinds),
        "ranking": ranking,
        "promotionEligible": False,
        "evaluationReportSha256": _sha256_file(output_dir / "evaluation-report.json"),
        "artifactManifestSha256": artifact_seal["manifestSha256"],
        "artifactValidation": artifact_validation,
        "finalCandidateExported": final_contract is not None,
    }


def _parse_models(raw: str) -> tuple[str, ...]:
    models = tuple(part.strip() for part in raw.split(",") if part.strip())
    if not models or any(model not in MODEL_KINDS for model in models):
        raise argparse.ArgumentTypeError(
            "models must be a comma-separated subset of: " + ", ".join(MODEL_KINDS)
        )
    if len(set(models)) != len(models):
        raise argparse.ArgumentTypeError("models cannot contain duplicates")
    return models


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    default_dataset = repo_root / "artifacts" / "bubble-fit-gate-dataset-crude10-v1"
    default_labels = (
        repo_root
        / "artifacts"
        / "bubble-fit-gate-labels-crude10-v1"
        / "manual-labels.json"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="fail-closed source audit only")
    evaluate = subparsers.add_parser(
        "evaluate", help="work-disjoint crude model comparison"
    )
    for subparser in (validate, evaluate):
        subparser.set_defaults(
            default_dataset=default_dataset,
            default_labels=default_labels,
        )
        subparser.add_argument("--dataset", type=Path)
        subparser.add_argument("--labels", type=Path)
        subparser.add_argument("--expected-candidates", type=int)
        subparser.add_argument(
            "--input-pack-set",
            type=Path,
            help=(
                "versioned strict input-pack-set; mutually exclusive with "
                "--dataset/--labels/--expected-candidates"
            ),
        )
    evaluate.add_argument("--output", type=Path, required=True)
    evaluate.add_argument(
        "--models",
        type=_parse_models,
        default=DEFAULT_MODEL_KINDS,
        help="comma-separated model kinds",
    )
    evaluate.add_argument("--seed", type=int, default=DEFAULT_SEED)
    evaluate.add_argument(
        "--unsafe-false-accept-target",
        type=float,
        default=DEFAULT_UNSAFE_FALSE_ACCEPT_TARGET,
    )
    evaluate.add_argument(
        "--minimum-coverage", type=float, default=DEFAULT_MINIMUM_COVERAGE
    )
    evaluate.add_argument(
        "--minimum-accepted-safe", type=int, default=DEFAULT_MINIMUM_ACCEPTED_SAFE
    )
    evaluate.add_argument("--frozen-epochs", type=int, default=24)
    evaluate.add_argument("--finetune-epochs", type=int, default=12)
    evaluate.add_argument("--batch-size", type=int, default=16)
    evaluate.add_argument("--device", choices=("cpu", "cuda", "auto"), default="cpu")
    evaluate.add_argument(
        "--allow-official-weight-download",
        action="store_true",
        help="allow torchvision to populate only its official torch.hub checkpoint cache",
    )
    evaluate.add_argument(
        "--export-final-model",
        choices=EXPORTABLE_MODEL_KINDS,
        help="optional non-promotable all-data MobileNet/ONNX candidate",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        if args.input_pack_set is not None:
            if any(
                value is not None
                for value in (args.dataset, args.labels, args.expected_candidates)
            ):
                raise BubbleFitTrainingError(
                    "--input-pack-set is mutually exclusive with single-pack inputs"
                )
            snapshot: TrainingSnapshot = load_training_pack_set_snapshot(
                args.input_pack_set
            )
        else:
            snapshot = load_training_snapshot(
                args.dataset or args.default_dataset,
                args.labels or args.default_labels,
                expected_candidate_count=(
                    args.expected_candidates
                    if args.expected_candidates is not None
                    else EXPECTED_CRUDE_CANDIDATES
                ),
            )
        if args.command == "validate":
            result = {
                "ok": True,
                "candidateCount": len(snapshot.samples),
                "workCount": len(snapshot.work_ids),
                "candidateBearingWorkCount": len(snapshot.work_ids),
                "sourcePageCount": snapshot.source_page_count,
                "sourceWorkCount": len(snapshot.source_work_ids),
                "safeCount": sum(sample.safe for sample in snapshot.samples),
                "unsafeCount": sum(not sample.safe for sample in snapshot.samples),
                "source": snapshot.provenance(),
                "promotionEligible": False,
            }
            if isinstance(snapshot, DatasetPackSetSnapshot):
                result.update(
                    {
                        "schemaVersion": PACK_SET_OUTPUT_SCHEMA_VERSION,
                        "inputMode": (
                            f"strict_input_pack_set_v{snapshot.input_schema_version}"
                        ),
                    }
                )
        else:
            result = run_evaluation(
                snapshot=snapshot,
                output_dir=args.output,
                model_kinds=args.models,
                config=EvaluationConfig(
                    seed=args.seed,
                    unsafe_false_accept_target=args.unsafe_false_accept_target,
                    minimum_coverage=args.minimum_coverage,
                    minimum_accepted_safe=args.minimum_accepted_safe,
                    frozen_epochs=args.frozen_epochs,
                    finetune_epochs=args.finetune_epochs,
                    batch_size=args.batch_size,
                    device=args.device,
                ),
                allow_official_weight_download=args.allow_official_weight_download,
                export_final_model=args.export_final_model,
            )
    except (BubbleFitTrainingError, OSError, ValueError) as exc:
        parser.exit(2, f"error: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
