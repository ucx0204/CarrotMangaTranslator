#!/usr/bin/env python3
"""Train the frozen-SigLIP prototype-conditioned font-matching baseline.

Pixels have exactly two entry points in this module:

* ``CatalogAssetResolver.resolve_sample_view`` for real sample views; and
* ``RenderBankSnapshot.resolve_prototype`` for real Korean font prototypes.

The train split alone receives variant-priority sampling/weights and optional
human-confirmed chapter-pair losses. Validation keeps its original distribution
for constrained checkpoint selection and calibration. Test remains metadata-only:
no test image, pair, prototype choice, hard negative, optimizer step, or
calibration target is admitted to a development artifact.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
import random
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field as dataclass_field, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence

import numpy as np

try:
    import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - import from repository root
    from scripts import font_matching_catalog_assets as catalog_assets  # type: ignore[no-redef]


ENCODER_ID = "google/siglip2-base-patch16-224"
ENCODER_REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
ENCODER_CLASS = "SiglipVisionModel"
PROCESSOR_CLASS = "AutoImageProcessor"
PROCESSOR_USE_FAST = False
IMAGE_SIZE = (224, 224)
IMAGE_MODE = "RGB"
MODEL_ID = "font-matching-siglip-baseline-v1"
TRAINER_SCHEMA_VERSION = "font-matching-siglip-baseline-v1"
CACHE_SCHEMA_VERSION = "font-matching-siglip-feature-cache-v2"
CACHE_OWNER = "carrot-manga-translator/font-matching-siglip-feature-cache"
OUTPUT_OWNER = "carrot-manga-translator/font-matching-siglip-baseline"
MODEL_CONTRACT_SCHEMA_VERSION = "font-matching-siglip-model-contract-v1"
REPORT_SCHEMA_VERSION = "font-matching-siglip-training-report-v1"
PREDICTION_SCHEMA_VERSION = "font-matching-v2-prediction-v1"
LISTWISE_SCHEMA_VERSION = "font-matching-listwise-example-v1"
PAIRWISE_SCHEMA_VERSION = "font-matching-pairwise-example-v1"
RETRIEVAL_SCHEMA_VERSION = "font-matching-retrieval-example-v1"
PROTOTYPE_SCHEMA_VERSION = "font-matching-font-prototype-v1"
EXPORTED_AUGMENTATION_SCHEMA_VERSION = "font-matching-train-only-augmentation-v1"
CHAPTER_PAIR_SCHEMA_VERSION = "font-matching-chapter-pair-v1"
CHAPTER_PAIR_FILE = "chapter-pairs.jsonl"
FONT_SIGNAL_AUDIT_SCHEMA_VERSION = "font-matching-font-signal-audit-v1"
FONT_SIGNAL_AUDIT_RECORD_TYPE = "font_matching_font_signal_audit_final"
FONT_SIGNAL_AUDIT_REPORT_TYPE = "font_matching_font_signal_audit_report"
FONT_SIGNAL_AUDIT_OWNER = "carrot-manga-translator/font-matching-font-signal-audit"
FONT_SIGNAL_AUDIT_MARKER = ".font-matching-font-signal-audit-owned.json"
FONT_SIGNAL_AUDIT_LEDGER = "ledger.jsonl"
FONT_SIGNAL_AUDIT_GATED_ASSIGNMENTS = "gated-assignments.jsonl"
FONT_SIGNAL_AUDIT_REVIEW_READY_ASSIGNMENTS = "review-ready-assignments.jsonl"
FONT_SIGNAL_AUDIT_REVIEW_READY_INVENTORY = "review-ready-inventory.jsonl"
FONT_SIGNAL_AUDIT_REPORT = "report.json"
FONT_SIGNAL_AUDIT_EXPECTED_COUNT = 62
FONT_SIGNAL_AUDIT_OUTCOMES = frozenset(
    {"font_signal_present", "font_signal_absent", "needs_recrop", "uncertain"}
)
FONT_SIGNAL_REQUIRED_EVIDENCE = (
    "source_page",
    "raw_224",
    "context_224",
    "glyph_224",
)
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
TRAINING_PIXEL_SPLITS = frozenset({"train", "val"})
RANKED_TIERS = ("preferred", "acceptable", "marginal", "unacceptable")
SKIPPED_TIERS = ("unrenderable", "not_reviewed")
TIER_GAIN = {"preferred": 3.0, "acceptable": 2.0, "marginal": 1.0, "unacceptable": 0.0}
STYLE_FIELDS = (
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
TREATMENT_VALUES: Mapping[str, tuple[str, ...]] = {
    "orientation": ("horizontal", "vertical", "mixed", "unknown"),
    "outline": ("none", "single", "double", "multiple", "unknown"),
    "shadow": ("none", "hard", "soft", "multiple", "unknown"),
    "fill": ("solid", "gradient", "pattern", "inverse", "transparent", "unknown"),
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
DEFAULT_TEMPERATURE_GRID = (0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
DEFAULT_NONE_THRESHOLD_GRID = tuple(round(index / 20, 2) for index in range(1, 20))
PRIORITY_TARGET_MIX: Mapping[int, float] = {0: 0.15, 1: 0.60, 2: 0.25}
PRIORITY_NAMES: Mapping[int, str] = {
    0: "catalog_gap_or_none",
    1: "variant",
    2: "ordinary",
}
VARIANT_ROLES = frozenset(
    {
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "whisper",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
    }
)
HIGH_VARIANT_STYLE_THRESHOLD = 0.5
MAX_TRAINING_EXAMPLE_WEIGHT = 3.0
ORDINARY_TOP1_REGRESSION_LIMIT = 0.03
CHAPTER_PAIR_KINDS = frozenset(
    {"ordinary_consistency_positive", "local_override_margin"}
)


class TrainerError(ValueError):
    """Raised when baseline inputs or artifacts violate the frozen contract."""


class StaleFeatureCacheError(TrainerError):
    """Raised when a feature cache is valid JSON but bound to other inputs."""


class ImageFeatureExtractor(Protocol):
    feature_dim: int

    def encode(self, images: Sequence[Any]) -> np.ndarray:
        """Return one normalized float32 feature row per RGB 224 image."""


@dataclass(frozen=True)
class FontSignalAuditRecord:
    sample_id: str
    work_id: str
    chapter_id: str
    page_id: str
    source_page_sha256: str
    training_sample_record_sha256: str
    outcome: str


@dataclass(frozen=True)
class FontSignalAuditSnapshot:
    root: Path
    marker_sha256: str
    ledger_sha256: str
    report_sha256: str
    records_by_sample_id: Mapping[str, FontSignalAuditRecord]
    outcome_counts: Mapping[str, int]
    audited_sample_ids_sha256: str
    excluded_sample_ids_sha256: str
    review_ready_sample_ids: frozenset[str]
    review_ready_sample_ids_sha256: str

    @property
    def excluded_sample_ids(self) -> frozenset[str]:
        return frozenset(
            sample_id
            for sample_id, record in self.records_by_sample_id.items()
            if record.outcome != "font_signal_present"
        )

    def input_binding(self) -> dict[str, Any]:
        return {
            "audited_sample_count": len(self.records_by_sample_id),
            "audited_sample_ids_sha256": self.audited_sample_ids_sha256,
            "excluded_sample_count": len(self.excluded_sample_ids),
            "excluded_sample_ids_sha256": self.excluded_sample_ids_sha256,
            "ledger_sha256": self.ledger_sha256,
            "marker_sha256": self.marker_sha256,
            "outcome_counts": dict(sorted(self.outcome_counts.items())),
            "report_sha256": self.report_sha256,
            "review_ready_sample_count": len(self.review_ready_sample_ids),
            "review_ready_sample_ids_sha256": self.review_ready_sample_ids_sha256,
            "schema_version": FONT_SIGNAL_AUDIT_SCHEMA_VERSION,
        }


@dataclass(frozen=True)
class TrainingExample:
    sample_id: str
    work_id: str
    split: str
    sample_record_sha256: str
    listwise_record_sha256: str
    candidate_gains: tuple[float, ...]
    candidate_loss_mask: tuple[bool, ...]
    pairwise_indices: tuple[tuple[int, int, int], ...]
    none_target: float
    role_index: int
    style_values: tuple[float, ...]
    style_mask: tuple[bool, ...]
    treatment_indices: tuple[int, ...]
    work_balance_weight: float
    chapter_id: str = "unknown-chapter"
    page_id: str = "unknown-page"
    variant_class: str = "ordinary"
    priority: int = 2
    consistency_action: str = "undetermined"
    label_quality_weight: float = 1.0
    training_weight: float | None = None


@dataclass(frozen=True)
class ChapterPair:
    pair_id: str
    kind: str
    split: str
    chapter_id: str
    role: str
    anchor_sample_id: str
    target_sample_id: str
    record_sha256: str


@dataclass(frozen=True)
class TrainingCorpus:
    export: catalog_assets.TrainingExportSnapshot
    samples_by_id: Mapping[str, Mapping[str, Any]]
    examples_by_id: Mapping[str, TrainingExample]
    candidate_ids: tuple[str, ...]
    font_catalog_sha256: str
    listwise_sha256: str
    pairwise_sha256: str
    retrieval_sha256: str
    prototype_sha256: str
    font_signal_audit: FontSignalAuditSnapshot
    chapter_pairs: tuple[ChapterPair, ...] = ()
    chapter_pair_contract: Mapping[str, Any] = dataclass_field(
        default_factory=lambda: {
            "artifact_sha256": None,
            "losses": {
                "chapter_anchor_consistency": "disabled",
                "local_override_margin": "disabled",
            },
            "reason": "chapter-pairs.jsonl_not_declared_by_sealed_export",
            "status": "disabled",
            "test_pair_rows_used": 0,
        }
    )

    def examples_for_split(self, split: str) -> tuple[TrainingExample, ...]:
        selected = tuple(
            self.examples_by_id[sample_id]
            for sample_id in sorted(self.examples_by_id)
            if self.examples_by_id[sample_id].split == split
        )
        return normalize_work_balance_weights(selected)


@dataclass(frozen=True)
class AssetScan:
    sample_rows: tuple[Mapping[str, Any], ...]
    prototype_rows: tuple[Mapping[str, Any], ...]

    @property
    def sample_ids(self) -> tuple[str, ...]:
        return tuple(str(row["sample_id"]) for row in self.sample_rows)


@dataclass(frozen=True)
class FeatureCache:
    root: Path
    manifest: Mapping[str, Any]
    manifest_sha256: str
    sample_features: np.ndarray
    prototype_features: np.ndarray


@dataclass(frozen=True)
class TrainingHyperparameters:
    seed: int = 20260801
    hidden_dim: int = 256
    epochs: int = 40
    batch_size: int = 64
    learning_rate: float = 3e-4
    weight_decay: float = 1e-4
    patience: int = 7
    view_dropout: float = 0.15
    head_dropout: float = 0.1
    listwise_weight: float = 1.0
    pairwise_weight: float = 0.5
    none_weight: float = 0.5
    role_weight: float = 0.35
    style_weight: float = 0.25
    treatment_weight: float = 0.25
    chapter_consistency_weight: float = 0.2
    local_override_weight: float = 0.2
    local_override_margin: float = 0.15

    def as_dict(self) -> dict[str, Any]:
        return {
            "batch_size": self.batch_size,
            "epochs": self.epochs,
            "head_dropout": self.head_dropout,
            "hidden_dim": self.hidden_dim,
            "learning_rate": self.learning_rate,
            "loss_weights": {
                "chapter_consistency": self.chapter_consistency_weight,
                "listwise": self.listwise_weight,
                "local_override": self.local_override_weight,
                "none": self.none_weight,
                "pairwise": self.pairwise_weight,
                "role": self.role_weight,
                "style": self.style_weight,
                "treatment": self.treatment_weight,
            },
            "patience": self.patience,
            "local_override_margin": self.local_override_margin,
            "seed": self.seed,
            "view_dropout": self.view_dropout,
            "weight_decay": self.weight_decay,
        }


@dataclass(frozen=True)
class Calibration:
    temperature: float
    none_threshold: float
    temperature_selection_metric: str = "val_listwise_cross_entropy"
    none_threshold_selection_metric: str = "val_none_f1_then_accuracy"
    calibration_split: str = "val"

    def as_dict(self) -> dict[str, Any]:
        return {
            "calibration_split": self.calibration_split,
            "none_threshold": self.none_threshold,
            "none_threshold_selection_metric": self.none_threshold_selection_metric,
            "temperature": self.temperature,
            "temperature_selection_metric": self.temperature_selection_metric,
        }


@dataclass(frozen=True)
class InferenceOutput:
    candidate_scores: np.ndarray
    none_logits: np.ndarray
    role_logits: np.ndarray
    style_logits: np.ndarray
    treatment_logits: Mapping[str, np.ndarray]


@dataclass(frozen=True)
class PredictionBinding:
    sample_id: str
    work_id: str
    split: str
    sample_record_sha256: str
    listwise_record_sha256: str


@dataclass(frozen=True)
class RuntimeInputs:
    resolver: catalog_assets.CatalogAssetResolver
    render_bank: catalog_assets.RenderBankSnapshot
    export: catalog_assets.TrainingExportSnapshot
    corpus: TrainingCorpus
    asset_validation_report_sha256: str | None
    scan: AssetScan
    cache_contract: Mapping[str, Any]


@dataclass(frozen=True)
class OrdinaryReference:
    root: Path
    state: Mapping[str, Any]
    binding: Mapping[str, Any]


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
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
        raise TrainerError(f"could not read {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    try:
        return catalog_assets.validate_record_seal(record, location=location)
    except catalog_assets.CatalogAssetError as error:
        raise TrainerError(str(error)) from error


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TrainerError(f"{location}: expected an object")
    return value


def require_list(value: Any, *, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise TrainerError(f"{location}: expected an array")
    return value


def require_text(value: Any, *, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TrainerError(f"{location}: expected a non-empty string")
    return value.strip()


def require_probability(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrainerError(f"{location}: expected a probability")
    output = float(value)
    if not math.isfinite(output) or not 0.0 <= output <= 1.0:
        raise TrainerError(f"{location}: probability must be finite in [0, 1]")
    return output


def _read_json(path: Path, *, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TrainerError(f"{location}: invalid JSON: {error}") from error
    return dict(require_mapping(value, location=location))


def _read_jsonl(path: Path, *, location: str) -> tuple[dict[str, Any], ...]:
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise TrainerError(f"{location}: could not read: {error}") from error
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise TrainerError(
                f"{location}:{line_number}: invalid JSON: {error}"
            ) from error
        rows.append(dict(require_mapping(value, location=f"{location}:{line_number}")))
    return tuple(rows)


def _sorted_ids_sha256(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(sorted(values)) + "\n").encode("utf-8"))


def _ordered_hashes_sha256(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str] | frozenset[str], *, location: str
) -> None:
    missing = sorted(set(expected) - set(value))
    extra = sorted(set(value) - set(expected))
    if missing or extra:
        raise TrainerError(
            f"{location}: invalid keys; missing={missing}, unexpected={extra}"
        )


def _require_audit_sha(value: Any, *, location: str) -> str:
    try:
        return catalog_assets.require_sha256(value, location=location)
    except catalog_assets.CatalogAssetError as error:
        raise TrainerError(str(error)) from error


def _validate_audit_timestamp(value: Any, *, location: str) -> None:
    text = require_text(value, location=location)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise TrainerError(f"{location}: expected an RFC3339 timestamp") from error
    if parsed.tzinfo is None:
        raise TrainerError(f"{location}: timestamp timezone is required")


def load_font_signal_audit(
    audit_root: Path | str,
) -> FontSignalAuditSnapshot:
    """Load the human-sealed signal audit without touching any model pixels."""

    raw_root = Path(audit_root).expanduser()
    if raw_root.exists() and raw_root.is_symlink():
        raise TrainerError("font-signal audit root must not be a symlink")
    root = raw_root.resolve()
    if not root.is_dir():
        raise TrainerError(f"font-signal audit root is not a directory: {root}")

    marker_path = root / FONT_SIGNAL_AUDIT_MARKER
    if not marker_path.is_file() or marker_path.is_symlink():
        raise TrainerError("font-signal audit ownership marker is missing or unsafe")
    marker = _read_json(marker_path, location="font-signal audit marker")
    if (
        marker.get("owner") != FONT_SIGNAL_AUDIT_OWNER
        or marker.get("schema_version") != FONT_SIGNAL_AUDIT_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise TrainerError("font-signal audit ownership marker is invalid")
    managed = require_mapping(
        marker.get("managed_files"), location="font-signal audit marker.managed_files"
    )
    expected_files = {
        FONT_SIGNAL_AUDIT_LEDGER,
        FONT_SIGNAL_AUDIT_GATED_ASSIGNMENTS,
        FONT_SIGNAL_AUDIT_REPORT,
        FONT_SIGNAL_AUDIT_REVIEW_READY_ASSIGNMENTS,
        FONT_SIGNAL_AUDIT_REVIEW_READY_INVENTORY,
    }
    if set(managed) != expected_files:
        raise TrainerError("font-signal audit managed-file inventory drifted")
    if {path.name for path in root.iterdir()} != set(managed) | {
        FONT_SIGNAL_AUDIT_MARKER
    }:
        raise TrainerError("font-signal audit contains unmanaged or missing files")
    for file_name in sorted(managed):
        path = root / file_name
        if (
            path.parent != root
            or not path.is_file()
            or path.is_symlink()
            or sha256_file(path)
            != _require_audit_sha(
                managed.get(file_name),
                location=f"font-signal audit marker.managed_files.{file_name}",
            )
        ):
            raise TrainerError(f"font-signal audit file binding failed: {file_name}")

    ledger_path = root / FONT_SIGNAL_AUDIT_LEDGER
    ledger_rows = _read_jsonl(ledger_path, location="font-signal audit ledger")
    if len(ledger_rows) != FONT_SIGNAL_AUDIT_EXPECTED_COUNT:
        raise TrainerError(
            "font-signal audit ledger must contain exactly "
            f"{FONT_SIGNAL_AUDIT_EXPECTED_COUNT} rows"
        )
    ledger_keys = {
        "schema_version",
        "record_type",
        "audit_order",
        "sample_id",
        "work_id",
        "chapter_id",
        "page_id",
        "source_page_sha256",
        "outcome",
        "rationale",
        "reviewer",
        "reviewed_at",
        "decision_source",
        "evidence_checked",
        "provenance",
        "assignment_gate",
        "record_sha256",
    }
    provenance_keys = {
        "source_audit_file_sha256",
        "source_assignments_file_sha256",
        "source_report_file_sha256",
        "source_report_record_sha256",
        "source_selection_file_sha256",
        "source_audit_record_sha256",
        "training_sample_record_sha256",
        "prior_final_record_sha256",
        "qa_overlay",
        "synthetic",
    }
    records: dict[str, FontSignalAuditRecord] = {}
    common_source_hashes: dict[str, str] | None = None
    ordered_record_shas: list[str] = []
    outcomes: Counter[str] = Counter()
    for index, row in enumerate(ledger_rows, 1):
        location = f"font-signal audit ledger[{index}]"
        _require_exact_keys(row, ledger_keys, location=location)
        record_sha = validate_record_seal(row, location=location)
        ordered_record_shas.append(record_sha)
        if (
            row.get("schema_version") != FONT_SIGNAL_AUDIT_SCHEMA_VERSION
            or row.get("record_type") != FONT_SIGNAL_AUDIT_RECORD_TYPE
            or row.get("audit_order") != index
            or row.get("decision_source") != "human_visual_review"
            or row.get("evidence_checked") != list(FONT_SIGNAL_REQUIRED_EVIDENCE)
        ):
            raise TrainerError(f"{location}: audit schema/order/evidence drifted")
        sample_id = catalog_assets.require_id(
            row.get("sample_id"), location=f"{location}.sample_id"
        )
        if sample_id in records:
            raise TrainerError(f"{location}: duplicate sample ID")
        outcome = require_text(row.get("outcome"), location=f"{location}.outcome")
        if outcome not in FONT_SIGNAL_AUDIT_OUTCOMES:
            raise TrainerError(f"{location}: unsupported outcome {outcome!r}")
        require_text(row.get("rationale"), location=f"{location}.rationale")
        catalog_assets.require_id(row.get("reviewer"), location=f"{location}.reviewer")
        _validate_audit_timestamp(
            row.get("reviewed_at"), location=f"{location}.reviewed_at"
        )
        work_id = catalog_assets.require_id(
            row.get("work_id"), location=f"{location}.work_id"
        )
        chapter_id = catalog_assets.require_id(
            row.get("chapter_id"), location=f"{location}.chapter_id"
        )
        page_id = catalog_assets.require_id(
            row.get("page_id"), location=f"{location}.page_id"
        )
        source_page_sha = _require_audit_sha(
            row.get("source_page_sha256"), location=f"{location}.source_page_sha256"
        )
        provenance = require_mapping(
            row.get("provenance"), location=f"{location}.provenance"
        )
        _require_exact_keys(
            provenance, provenance_keys, location=f"{location}.provenance"
        )
        source_hashes = {
            key: _require_audit_sha(
                provenance.get(key), location=f"{location}.provenance.{key}"
            )
            for key in (
                "source_audit_file_sha256",
                "source_assignments_file_sha256",
                "source_report_file_sha256",
                "source_report_record_sha256",
                "source_selection_file_sha256",
            )
        }
        if common_source_hashes is None:
            common_source_hashes = source_hashes
        elif common_source_hashes != source_hashes:
            raise TrainerError(f"{location}: mixed source-audit bindings")
        for key in (
            "source_audit_record_sha256",
            "training_sample_record_sha256",
            "prior_final_record_sha256",
        ):
            _require_audit_sha(provenance.get(key), location=f"{location}.{key}")
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise TrainerError(f"{location}: unsafe audit provenance")
        expected_gate = {
            "new_7_review_allowed": outcome == "font_signal_present",
            "required_release_state": (
                "ready"
                if outcome == "font_signal_present"
                else "blocked_pending_font_signal_audit"
            ),
        }
        if row.get("assignment_gate") != expected_gate:
            raise TrainerError(f"{location}: assignment gate differs from outcome")
        records[sample_id] = FontSignalAuditRecord(
            sample_id=sample_id,
            work_id=work_id,
            chapter_id=chapter_id,
            page_id=page_id,
            source_page_sha256=source_page_sha,
            training_sample_record_sha256=str(
                provenance["training_sample_record_sha256"]
            ),
            outcome=outcome,
        )
        outcomes[outcome] += 1

    assert common_source_hashes is not None
    gated_path = root / FONT_SIGNAL_AUDIT_GATED_ASSIGNMENTS
    gated_rows = _read_jsonl(gated_path, location="font-signal gated assignments")
    audited_assignment_ids: set[str] = set()
    seen_assignment_ids: set[str] = set()
    released_count = 0
    blocked_count = 0
    for index, row in enumerate(gated_rows, 1):
        location = f"font-signal gated assignments[{index}]"
        assignment_id = catalog_assets.require_id(
            row.get("assignment_id"), location=f"{location}.assignment_id"
        )
        if assignment_id in seen_assignment_ids:
            raise TrainerError(f"{location}: duplicate assignment ID")
        seen_assignment_ids.add(assignment_id)
        sample_id = catalog_assets.require_id(
            row.get("sample_id"), location=f"{location}.sample_id"
        )
        if any(key in row for key in ("split", "dataset_split", "source_split")):
            raise TrainerError(f"{location}: secret split leaked into audit assignment")
        if row.get("split_visible") is not False:
            raise TrainerError(f"{location}: split visibility must remain false")
        audited = records.get(sample_id)
        if audited is None:
            continue
        audited_assignment_ids.add(sample_id)
        expected_release = (
            "ready"
            if audited.outcome == "font_signal_present"
            else "blocked_pending_font_signal_audit"
        )
        if row.get("release_state") != expected_release:
            raise TrainerError(f"{location}: gated release contradicts human outcome")
        if expected_release == "ready":
            released_count += 1
        else:
            blocked_count += 1
    if audited_assignment_ids != set(records):
        raise TrainerError("font-signal gated assignments omit audited samples")

    ready_rows = _read_jsonl(
        root / FONT_SIGNAL_AUDIT_REVIEW_READY_ASSIGNMENTS,
        location="font-signal review-ready assignments",
    )
    expected_ready = tuple(
        row for row in gated_rows if row.get("release_state") == "ready"
    )
    if ready_rows != expected_ready:
        raise TrainerError(
            "font-signal review-ready assignments are not the exact ready projection"
        )
    ready_primary_ids = {
        str(row["sample_id"]) for row in ready_rows if row.get("stage") == "primary"
    }
    if {str(row["sample_id"]) for row in ready_rows} != ready_primary_ids:
        raise TrainerError(
            "font-signal ready samples do not all retain a primary assignment"
        )
    ready_inventory_rows = _read_jsonl(
        root / FONT_SIGNAL_AUDIT_REVIEW_READY_INVENTORY,
        location="font-signal review-ready inventory",
    )
    ready_inventory_ids: list[str] = []
    for index, row in enumerate(ready_inventory_rows, 1):
        location = f"font-signal review-ready inventory[{index}]"
        if any(key in row for key in ("split", "dataset_split", "source_split")):
            raise TrainerError(f"{location}: secret split leaked into ready inventory")
        sample_id = catalog_assets.require_id(
            row.get("sample_id"), location=f"{location}.sample_id"
        )
        ready_inventory_ids.append(sample_id)
    if (
        len(ready_inventory_ids) != len(set(ready_inventory_ids))
        or set(ready_inventory_ids) != ready_primary_ids
    ):
        raise TrainerError(
            "font-signal review-ready inventory differs from ready primary assignments"
        )

    report_path = root / FONT_SIGNAL_AUDIT_REPORT
    report = _read_json(report_path, location="font-signal audit report")
    validate_record_seal(report, location="font-signal audit report")
    if (
        report.get("schema_version") != FONT_SIGNAL_AUDIT_SCHEMA_VERSION
        or report.get("record_type") != FONT_SIGNAL_AUDIT_REPORT_TYPE
    ):
        raise TrainerError("font-signal audit report schema/type is unsupported")
    contracts = require_mapping(
        report.get("contracts"), location="font-signal audit report.contracts"
    )
    required_contracts = {
        "automatic_decisions_allowed": False,
        "decision_source": "human_visual_review_only",
        "new_7_assignment_release_rule": "font_signal_present_only",
        "qa_overlay_training_allowed": False,
        "source_rescue_inputs_immutable": True,
        "synthetic_training_allowed": False,
        "test_split_secret": True,
    }
    if any(contracts.get(key) != value for key, value in required_contracts.items()):
        raise TrainerError("font-signal audit report safety contract drifted")
    if report.get("inputs") != common_source_hashes:
        raise TrainerError("font-signal audit report/source bindings drifted")
    outputs = require_mapping(
        report.get("outputs"), location="font-signal audit report.outputs"
    )
    ledger_sha = sha256_file(ledger_path)
    gated_sha = sha256_file(gated_path)
    if (
        outputs.get("ledger_sha256") != ledger_sha
        or outputs.get("gated_assignments_sha256") != gated_sha
        or outputs.get("ordered_ledger_record_sha256s_sha256")
        != _ordered_hashes_sha256(ordered_record_shas)
    ):
        raise TrainerError("font-signal audit report output binding drifted")
    if outputs.get("review_ready_assignments_sha256") != sha256_file(
        root / FONT_SIGNAL_AUDIT_REVIEW_READY_ASSIGNMENTS
    ) or outputs.get("review_ready_inventory_sha256") != sha256_file(
        root / FONT_SIGNAL_AUDIT_REVIEW_READY_INVENTORY
    ):
        raise TrainerError("font-signal audit review-ready hash drifted")

    summary = require_mapping(
        report.get("summary"), location="font-signal audit report.summary"
    )
    audited_ids = set(records)
    present_ids = {
        sample_id
        for sample_id, record in records.items()
        if record.outcome == "font_signal_present"
    }
    excluded_ids = audited_ids - present_ids
    declared_outcomes = require_mapping(
        summary.get("outcome_counts"),
        location="font-signal audit report.summary.outcome_counts",
    )
    if (
        summary.get("audit_count") != len(records)
        or any(
            declared_outcomes.get(outcome, 0) != outcomes[outcome]
            for outcome in FONT_SIGNAL_AUDIT_OUTCOMES
        )
        or set(declared_outcomes) - FONT_SIGNAL_AUDIT_OUTCOMES
        or summary.get("sample_ids_sha256") != _sorted_ids_sha256(audited_ids)
        or summary.get("font_signal_present_sample_ids_sha256")
        != _sorted_ids_sha256(present_ids)
        or summary.get("blocked_sample_ids_sha256") != _sorted_ids_sha256(excluded_ids)
        or summary.get("gated_assignment_count") != len(gated_rows)
        or summary.get("released_assignment_count") != released_count
        or summary.get("blocked_assignment_count") != blocked_count
        or summary.get("review_ready_assignment_count") != len(ready_rows)
        or summary.get("review_ready_blocked_leak_count") != 0
        or summary.get("review_ready_inventory_count") != len(ready_inventory_ids)
        or summary.get("review_ready_inventory_sample_ids_sha256")
        != _sorted_ids_sha256(ready_inventory_ids)
    ):
        raise TrainerError("font-signal audit report summary drifted")

    return FontSignalAuditSnapshot(
        root=root,
        marker_sha256=sha256_file(marker_path),
        ledger_sha256=ledger_sha,
        report_sha256=sha256_file(report_path),
        records_by_sample_id=dict(sorted(records.items())),
        outcome_counts={
            outcome: outcomes[outcome] for outcome in sorted(FONT_SIGNAL_AUDIT_OUTCOMES)
        },
        audited_sample_ids_sha256=_sorted_ids_sha256(audited_ids),
        excluded_sample_ids_sha256=_sorted_ids_sha256(excluded_ids),
        review_ready_sample_ids=frozenset(ready_inventory_ids),
        review_ready_sample_ids_sha256=_sorted_ids_sha256(ready_inventory_ids),
    )


def _validate_jsonl_artifact(
    export: catalog_assets.TrainingExportSnapshot, file_name: str
) -> tuple[tuple[dict[str, Any], ...], str]:
    artifacts = require_mapping(
        export.manifest.get("artifacts"), location="training export.artifacts"
    )
    descriptor = require_mapping(
        artifacts.get(file_name), location=f"training export.artifacts.{file_name}"
    )
    if descriptor.get("file") != file_name:
        raise TrainerError(f"{file_name}: artifact file binding mismatch")
    path = export.root / file_name
    if path.parent != export.root or not path.is_file() or path.is_symlink():
        raise TrainerError(f"{file_name}: missing direct non-symlink artifact")
    payload = path.read_bytes()
    expected_sha = catalog_assets.require_sha256(
        descriptor.get("sha256"), location=f"{file_name}.sha256"
    )
    rows = _read_jsonl(path, location=file_name)
    if (
        sha256_bytes(payload) != expected_sha
        or descriptor.get("byte_size") != len(payload)
        or descriptor.get("record_count") != len(rows)
    ):
        raise TrainerError(f"{file_name}: artifact hash/count/size mismatch")
    report = _read_json(export.root / "report.json", location="training export report")
    outputs = require_mapping(
        report.get("outputs"), location="training export report.outputs"
    )
    if outputs.get(file_name) != descriptor:
        raise TrainerError(f"{file_name}: report/manifest artifact descriptor drifted")
    return rows, expected_sha


def _tier_partition(
    judgment: Mapping[str, Any], *, location: str
) -> dict[str, tuple[str, ...]]:
    output: dict[str, tuple[str, ...]] = {}
    seen: set[str] = set()
    for tier in (*RANKED_TIERS, *SKIPPED_TIERS):
        raw = require_list(judgment.get(tier), location=f"{location}.{tier}")
        values = tuple(
            require_text(value, location=f"{location}.{tier}[{index}]")
            for index, value in enumerate(raw)
        )
        if len(values) != len(set(values)) or seen & set(values):
            raise TrainerError(f"{location}: candidate tiers overlap or duplicate")
        output[tier] = values
        seen.update(values)
    none = judgment.get("none_acceptable")
    if not isinstance(none, bool):
        raise TrainerError(f"{location}.none_acceptable must be boolean")
    if none == bool(output["preferred"] or output["acceptable"]):
        raise TrainerError(f"{location}: none_acceptable semantics are invalid")
    return output


def normalize_work_balance_weights(
    examples: Sequence[TrainingExample],
) -> tuple[TrainingExample, ...]:
    if not examples:
        return ()
    values = np.asarray(
        [item.work_balance_weight for item in examples], dtype=np.float64
    )
    if not np.all(np.isfinite(values)) or np.any(values <= 0.0):
        raise TrainerError("work_balance_weight must be finite and positive")
    mean = float(values.mean())
    normalized = tuple(
        replace(item, work_balance_weight=float(item.work_balance_weight / mean))
        for item in examples
    )
    observed = sum(item.work_balance_weight for item in normalized) / len(normalized)
    if not math.isclose(observed, 1.0, rel_tol=0.0, abs_tol=1e-12):
        raise TrainerError("normalized work_balance_weight mean drifted")
    return normalized


def _legacy_label_quality_weight(sample: Mapping[str, Any]) -> float:
    values: list[float] = []
    role = sample.get("role")
    if isinstance(role, Mapping) and role.get("confidence") is not None:
        values.append(
            require_probability(
                role.get("confidence"), location="training sample.role.confidence"
            )
        )
    review = sample.get("review_provenance")
    if isinstance(review, Mapping):
        resolution = review.get("resolution")
        if isinstance(resolution, Mapping) and resolution.get("confidence") is not None:
            values.append(
                require_probability(
                    resolution.get("confidence"),
                    location="training sample.review_provenance.resolution.confidence",
                )
            )
    if not values:
        return 1.0
    # V1 did not seal a dedicated quality field.  Preserve compatibility while
    # ensuring its low-confidence legacy labels cannot dominate reviewed V2 rows.
    return max(0.25, min(values))


def _label_quality_weight(sample: Mapping[str, Any]) -> float:
    quality = sample.get("label_quality")
    if quality is None:
        return _legacy_label_quality_weight(sample)
    quality_row = require_mapping(quality, location="training sample.label_quality")
    if quality_row.get("ranking_truth_eligible") is False:
        raise TrainerError("training sample is not eligible as ranking truth")
    raw_weight = quality_row.get("weight", quality_row.get("confidence"))
    weight = require_probability(
        raw_weight, location="training sample.label_quality.weight"
    )
    if weight < 0.80:
        raise TrainerError(
            "V2 ranking truth requires adjudicated label quality >= 0.80"
        )
    return weight


def _has_manual_recrop(sample: Mapping[str, Any]) -> bool:
    review = sample.get("review_provenance")
    if not isinstance(review, Mapping):
        return False
    source_reviews = review.get("source_reviews")
    return isinstance(source_reviews, list) and any(
        isinstance(row, Mapping)
        and isinstance(row.get("flags"), list)
        and "manual_recrop" in row["flags"]
        for row in source_reviews
    )


def _consistency_action(sample: Mapping[str, Any]) -> str:
    if sample.get("consistency") is None:
        return "undetermined"
    consistency = require_mapping(
        sample.get("consistency"), location="training sample.consistency"
    )
    action = consistency.get("action")
    if action is None:
        action = {
            "inherit_work_anchor": "inherit_anchor",
            "intentional_override": "local_override",
        }.get(consistency.get("policy"), "undetermined")
    action = require_text(action, location="training sample.consistency.action")
    if action not in {
        "inherit_anchor",
        "local_override",
        "palette_member",
        "undetermined",
    }:
        raise TrainerError(f"unsupported consistency action {action!r}")
    return action


def _variant_metadata(
    sample: Mapping[str, Any],
    *,
    role: str,
    style_values: Sequence[float],
    consistency_action: str,
) -> tuple[int, str]:
    variant = sample.get("variant")
    if variant is not None:
        variant_row = require_mapping(variant, location="training sample.variant")
        priority = variant_row.get("priority", variant_row.get("priority_rank"))
        if isinstance(priority, bool) or not isinstance(priority, int):
            raise TrainerError("training sample.variant.priority must be integer")
        if priority not in PRIORITY_TARGET_MIX:
            raise TrainerError("training sample.variant.priority must be 0, 1, or 2")
        variant_class = require_text(
            variant_row.get("class", PRIORITY_NAMES[priority]),
            location="training sample.variant.class",
        )
        return priority, variant_class

    judgment = require_mapping(
        sample.get("font_judgment"), location="training sample.font_judgment"
    )
    source_style = require_mapping(
        sample.get("source_style"), location="training sample.source_style"
    )
    unknown_fields = require_list(
        source_style.get("unknown_fields"),
        location="training sample.source_style.unknown_fields",
    )
    if judgment.get("none_acceptable") is True or len(unknown_fields) >= 5:
        return 0, PRIORITY_NAMES[0]
    style_by_name = dict(zip(STYLE_FIELDS, style_values))
    reasons = []
    if role in VARIANT_ROLES:
        reasons.append(role)
    if style_by_name["handwritten"] >= HIGH_VARIANT_STYLE_THRESHOLD:
        reasons.append("handwritten")
    if style_by_name["irregularity"] >= HIGH_VARIANT_STYLE_THRESHOLD:
        reasons.append("irregular")
    if _has_manual_recrop(sample):
        reasons.append("manual_recrop")
    if consistency_action == "local_override":
        reasons.append("source_family_override")
    if reasons:
        return 1, "+".join(sorted(set(reasons)))
    return 2, PRIORITY_NAMES[2]


def _sample_label_record_sha256(sample: Mapping[str, Any], *, location: str) -> str:
    review = require_mapping(
        sample.get("review_provenance"), location=f"{location}.review_provenance"
    )
    return catalog_assets.require_sha256(
        review.get("final_record_sha256"),
        location=f"{location}.review_provenance.final_record_sha256",
    )


def _load_chapter_pairs(
    *,
    export: catalog_assets.TrainingExportSnapshot,
    samples_by_id: Mapping[str, Mapping[str, Any]],
    examples_by_id: Mapping[str, TrainingExample],
) -> tuple[tuple[ChapterPair, ...], Mapping[str, Any]]:
    raw_artifacts = export.manifest.get("artifacts")
    # Legacy in-memory fixtures may omit the descriptor map after the required
    # core artifacts have already been validated by their injected loader.
    artifacts = raw_artifacts if isinstance(raw_artifacts, Mapping) else {}
    if CHAPTER_PAIR_FILE not in artifacts:
        return (), {
            "artifact_sha256": None,
            "losses": {
                "chapter_anchor_consistency": "disabled",
                "local_override_margin": "disabled",
            },
            "reason": "chapter-pairs.jsonl_not_declared_by_sealed_export",
            "status": "disabled",
            "test_pair_rows_used": 0,
        }

    rows, artifact_sha = _validate_jsonl_artifact(export, CHAPTER_PAIR_FILE)
    pair_ids: set[str] = set()
    development_pairs: list[ChapterPair] = []
    split_counts: Counter[str] = Counter()
    kind_counts: Counter[str] = Counter()
    for index, row in enumerate(rows):
        location = f"{CHAPTER_PAIR_FILE}[{index}]"
        if row.get("schema_version") != CHAPTER_PAIR_SCHEMA_VERSION:
            raise TrainerError(f"{location}: unsupported schema")
        record_sha = validate_record_seal(row, location=location)
        pair_id = catalog_assets.require_id(
            row.get("pair_id"), location=f"{location}.pair_id"
        )
        if pair_id in pair_ids:
            raise TrainerError(f"{location}: duplicate pair ID")
        pair_ids.add(pair_id)
        kind = require_text(row.get("pair_kind"), location=f"{location}.pair_kind")
        if kind not in CHAPTER_PAIR_KINDS:
            raise TrainerError(f"{location}: unsupported pair kind")
        if row.get("human_confirmed") is not True:
            raise TrainerError(f"{location}: chapter pair is not human-confirmed")
        split = require_text(row.get("split"), location=f"{location}.split")
        if split not in {"train", "val", "test"}:
            raise TrainerError(f"{location}: unsupported split")
        chapter_id = catalog_assets.require_id(
            row.get("chapter_id"), location=f"{location}.chapter_id"
        )
        role = require_text(row.get("role"), location=f"{location}.role")
        if role not in ROLE_VALUES:
            raise TrainerError(f"{location}: unsupported role")
        anchor_id = catalog_assets.require_id(
            row.get("anchor_sample_id"),
            location=f"{location}.anchor_sample_id",
        )
        target_id = catalog_assets.require_id(
            row.get("target_sample_id"),
            location=f"{location}.target_sample_id",
        )
        if anchor_id == target_id:
            raise TrainerError(f"{location}: pair endpoints must differ")
        if anchor_id not in samples_by_id or target_id not in samples_by_id:
            raise TrainerError(
                f"{location}: pair references a font-signal-excluded or unknown sample"
            )
        anchor = samples_by_id[anchor_id]
        target = samples_by_id[target_id]
        endpoint_rows = (("anchor", anchor_id, anchor), ("target", target_id, target))
        for endpoint, sample_id, sample in endpoint_rows:
            if row.get(f"{endpoint}_training_sample_record_sha256") != sample.get(
                "record_sha256"
            ) or row.get(
                f"{endpoint}_label_record_sha256"
            ) != _sample_label_record_sha256(
                sample, location=sample_id
            ):
                raise TrainerError(f"{location}: {endpoint} binding drifted")
            example = examples_by_id[sample_id]
            if (
                example.split != split
                or example.chapter_id != chapter_id
                or ROLE_VALUES[example.role_index] != role
            ):
                raise TrainerError(f"{location}: {endpoint} grouping drifted")
        anchor_example = examples_by_id[anchor_id]
        target_example = examples_by_id[target_id]
        if kind == "ordinary_consistency_positive":
            if (
                anchor_example.priority != 2
                or target_example.priority != 2
                or anchor_example.consistency_action != "inherit_anchor"
                or target_example.consistency_action != "inherit_anchor"
            ):
                raise TrainerError(f"{location}: invalid ordinary consistency pair")
        elif (
            anchor_example.consistency_action != "inherit_anchor"
            or target_example.consistency_action != "local_override"
        ):
            raise TrainerError(f"{location}: invalid local override pair direction")
        split_counts[split] += 1
        kind_counts[kind] += 1
        if split == "test":
            # The development trainer seals the descriptor/count, but test pairs
            # never enter loss, calibration, checkpoint selection, or metrics.
            continue
        development_pairs.append(
            ChapterPair(
                pair_id=pair_id,
                kind=kind,
                split=split,
                chapter_id=chapter_id,
                role=role,
                anchor_sample_id=anchor_id,
                target_sample_id=target_id,
                record_sha256=record_sha,
            )
        )
    # Use the retained inventory rather than trusting total kind counts, because
    # sealed test metadata is intentionally unavailable to development losses.
    loss_status = {
        "chapter_anchor_consistency": (
            "enabled"
            if any(
                pair.kind == "ordinary_consistency_positive"
                for pair in development_pairs
            )
            else "disabled_no_development_pairs"
        ),
        "local_override_margin": (
            "enabled"
            if any(pair.kind == "local_override_margin" for pair in development_pairs)
            else "disabled_no_development_pairs"
        ),
    }
    return tuple(sorted(development_pairs, key=lambda item: item.pair_id)), {
        "artifact_sha256": artifact_sha,
        "development_pair_count": len(development_pairs),
        "kind_counts": dict(sorted(kind_counts.items())),
        "losses": loss_status,
        "reason": None,
        "split_counts": dict(sorted(split_counts.items())),
        "status": "enabled",
        "test_pair_rows_used": 0,
    }


def load_training_corpus(
    *,
    export: catalog_assets.TrainingExportSnapshot,
    render_bank: catalog_assets.RenderBankSnapshot,
    catalog_registry_sha256: str,
    font_signal_audit: FontSignalAuditSnapshot,
) -> TrainingCorpus:
    listwise_rows, listwise_sha = _validate_jsonl_artifact(export, "listwise.jsonl")
    pairwise_rows, pairwise_sha = _validate_jsonl_artifact(export, "pairwise.jsonl")
    retrieval_rows, retrieval_sha = _validate_jsonl_artifact(export, "retrieval.jsonl")
    prototype_rows, prototype_sha = _validate_jsonl_artifact(
        export, "font-prototypes.jsonl"
    )
    augmentation_rows, _ = _validate_jsonl_artifact(export, "augmentations.jsonl")
    if augmentation_rows:
        raise TrainerError(
            "frozen real baseline forbids generated augmentation rows entirely"
        )
    contracts = require_mapping(
        export.manifest.get("contracts"), location="training export.contracts"
    )
    split_contract = require_mapping(
        contracts.get("split"), location="training export.contracts.split"
    )
    if split_contract != {
        "development_component_key": "groups.split_component",
        "group_key": "work_id",
        "work_disjoint": True,
    }:
        raise TrainerError("training export split contract drifted")
    samples_by_id: dict[str, Mapping[str, Any]] = {}
    work_splits: dict[str, str] = {}
    component_splits: dict[str, str] = {}
    all_sample_ids: set[str] = set()
    excluded_sample_ids = font_signal_audit.excluded_sample_ids
    for index, sample in enumerate(export.samples):
        location = f"samples[{index}]"
        validate_record_seal(sample, location=location)
        sample_id = catalog_assets.require_id(
            sample.get("sample_id"), location=f"{location}.sample_id"
        )
        if sample_id in all_sample_ids:
            raise TrainerError(f"duplicate sample {sample_id!r}")
        all_sample_ids.add(sample_id)
        split = require_text(sample.get("split"), location=f"{location}.split")
        if split not in {"train", "val", "test"}:
            raise TrainerError(f"{location}: unsupported split")
        work_id = catalog_assets.require_id(
            sample.get("work_id"), location=f"{location}.work_id"
        )
        previous = work_splits.setdefault(work_id, split)
        if previous != split:
            raise TrainerError(f"work split leakage for {work_id}: {previous}/{split}")
        groups = require_mapping(sample.get("groups"), location=f"{location}.groups")
        split_component = catalog_assets.require_id(
            groups.get("split_component"),
            location=f"{location}.groups.split_component",
        )
        component_previous = component_splits.setdefault(split_component, split)
        if component_previous != split:
            raise TrainerError(
                "split-component leakage for "
                f"{split_component}: {component_previous}/{split}"
            )
        source = require_mapping(sample.get("source"), location=f"{location}.source")
        audited = font_signal_audit.records_by_sample_id.get(sample_id)
        if audited is not None:
            if (
                audited.training_sample_record_sha256 != sample.get("record_sha256")
                or audited.work_id != work_id
                or audited.chapter_id != sample.get("chapter_id")
                or audited.page_id != sample.get("page_id")
                or audited.source_page_sha256 != source.get("source_page_sha256")
            ):
                raise TrainerError(
                    f"{sample_id}: font-signal audit/training sample binding mismatch"
                )
        if sample_id in excluded_sample_ids:
            continue
        catalog_assets.assert_no_forbidden_flags(sample, location=location)
        provenance = require_mapping(
            sample.get("provenance"), location=f"{location}.provenance"
        )
        if (
            provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
            or sample.get("evaluation_eligible") is False
        ):
            raise TrainerError(f"{sample_id}: unsafe real-sample provenance")
        bindings = require_mapping(
            sample.get("input_bindings"), location=f"{location}.input_bindings"
        )
        if (
            bindings.get("catalog_registry_sha256") != catalog_registry_sha256
            or bindings.get("render_bank_manifest_sha256")
            != render_bank.manifest_sha256
            or bindings.get("render_specification_sha256")
            != render_bank.specification_sha256
        ):
            raise TrainerError(f"{sample_id}: sample input binding mismatch")
        views = require_mapping(
            source.get("views"), location=f"{location}.source.views"
        )
        if set(views) != set(VIEW_NAMES):
            raise TrainerError(f"{sample_id}: exact three-view contract required")
        samples_by_id[sample_id] = sample

    if set(font_signal_audit.records_by_sample_id) - all_sample_ids:
        raise TrainerError(
            "font-signal audit targets samples absent from training export"
        )
    if set(samples_by_id) != set(font_signal_audit.review_ready_sample_ids):
        raise TrainerError(
            "font-signal review-ready inventory is not the exact eligible export projection"
        )
    declared_work_splits = require_mapping(
        export.manifest.get("work_split"), location="training export.work_split"
    )
    if dict(sorted(declared_work_splits.items())) != dict(sorted(work_splits.items())):
        raise TrainerError("training export work split map drifted")

    listwise_by_id: dict[str, Mapping[str, Any]] = {}
    global_candidates: tuple[str, ...] | None = None
    for index, row in enumerate(listwise_rows):
        location = f"listwise[{index}]"
        sample_id = catalog_assets.require_id(
            row.get("sample_id"), location=f"{location}.sample_id"
        )
        if sample_id in excluded_sample_ids:
            continue
        if sample_id not in samples_by_id:
            raise TrainerError(f"{location}: unknown sample")
        if row.get("schema_version") != LISTWISE_SCHEMA_VERSION:
            raise TrainerError(f"{location}: unsupported schema")
        row_sha = validate_record_seal(row, location=location)
        if sample_id in listwise_by_id:
            raise TrainerError(f"duplicate listwise sample {sample_id}")
        targets = require_list(
            row.get("candidate_targets"), location=f"{location}.candidate_targets"
        )
        candidate_ids = tuple(
            catalog_assets.require_id(
                require_mapping(
                    value, location=f"{location}.candidate_targets[{item_index}]"
                ).get("candidate_id"),
                location=f"{location}.candidate_targets[{item_index}].candidate_id",
            )
            for item_index, value in enumerate(targets)
        )
        if not candidate_ids or len(candidate_ids) != len(set(candidate_ids)):
            raise TrainerError(f"{location}: candidate catalog is empty or duplicated")
        if global_candidates is None:
            global_candidates = tuple(sorted(candidate_ids))
        elif set(global_candidates) != set(candidate_ids):
            raise TrainerError("listwise candidate catalog drifted between samples")
        row["_validated_record_sha256"] = row_sha
        listwise_by_id[sample_id] = row
    if global_candidates is None:
        raise TrainerError("listwise.jsonl is empty")
    if global_candidates != tuple(sorted(render_bank.candidate_ids)):
        raise TrainerError("training candidate IDs differ from canonical render bank")
    if set(samples_by_id) != set(listwise_by_id):
        raise TrainerError("samples/listwise inventories differ")

    retrieval_by_id: dict[str, Mapping[str, Any]] = {}
    for index, row in enumerate(retrieval_rows):
        location = f"retrieval[{index}]"
        sample_id = catalog_assets.require_id(
            row.get("sample_id"), location=f"{location}.sample_id"
        )
        if sample_id in excluded_sample_ids:
            continue
        if sample_id not in samples_by_id:
            raise TrainerError(f"{location}: unknown sample")
        if row.get("schema_version") != RETRIEVAL_SCHEMA_VERSION:
            raise TrainerError(f"{location}: unsupported schema")
        validate_record_seal(row, location=location)
        if sample_id in retrieval_by_id:
            raise TrainerError(f"duplicate retrieval sample {sample_id}")
        retrieval_by_id[sample_id] = row
    if set(retrieval_by_id) != set(samples_by_id):
        raise TrainerError("samples/retrieval inventories differ")

    prototype_by_font: dict[str, Mapping[str, Any]] = {}
    exported_render_refs: set[tuple[str, str, str, str]] = set()
    for index, row in enumerate(prototype_rows):
        location = f"font_prototypes[{index}]"
        if row.get("schema_version") != PROTOTYPE_SCHEMA_VERSION:
            raise TrainerError(f"{location}: unsupported schema")
        validate_record_seal(row, location=location)
        catalog_assets.assert_no_forbidden_flags(row, location=location)
        font_id = catalog_assets.require_id(
            row.get("font_id"), location=f"{location}.font_id"
        )
        if font_id in prototype_by_font:
            raise TrainerError(f"duplicate exported font prototype {font_id}")
        if (
            row.get("production_400_normal_canonical") is not True
            or row.get("render_weight") != 400
            or row.get("render_style") != "normal"
        ):
            raise TrainerError(f"{location}: prototype is not canonical 400 normal")
        source_font_sha = catalog_assets.require_sha256(
            row.get("source_font_sha256"),
            location=f"{location}.source_font_sha256",
        )
        refs = require_list(
            row.get("render_prototypes"),
            location=f"{location}.render_prototypes",
        )
        if not refs:
            raise TrainerError(f"{location}: candidate has no render prototypes")
        for ref_index, raw_ref in enumerate(refs):
            ref = require_mapping(
                raw_ref, location=f"{location}.render_prototypes[{ref_index}]"
            )
            artifact_path = catalog_assets.safe_relative_path(
                ref.get("artifact_path"),
                location=f"{location}.render_prototypes[{ref_index}].artifact_path",
            )
            artifact_sha = catalog_assets.require_sha256(
                ref.get("artifact_sha256"),
                location=f"{location}.render_prototypes[{ref_index}].artifact_sha256",
            )
            render_id = catalog_assets.require_id(
                ref.get("render_id"),
                location=f"{location}.render_prototypes[{ref_index}].render_id",
            )
            writing_mode = require_text(
                ref.get("writing_mode"),
                location=f"{location}.render_prototypes[{ref_index}].writing_mode",
            )
            if writing_mode not in {"horizontal", "vertical"}:
                raise TrainerError(f"{location}: unsupported prototype writing mode")
            exported_render_refs.add((font_id, render_id, artifact_sha, writing_mode))
            if not artifact_path:
                raise TrainerError(f"{location}: empty prototype artifact path")
        row["_source_font_sha256"] = source_font_sha
        prototype_by_font[font_id] = row
    if set(prototype_by_font) != set(global_candidates):
        raise TrainerError("exported prototype candidate IDs differ from listwise")
    bank_render_refs = {
        (
            str(row["font_id"]),
            str(row["render_id"]),
            str(row["artifact_sha256"]),
            str(row["writing_mode"]),
        )
        for row in render_bank.prototype_evidence
    }
    if exported_render_refs != bank_render_refs:
        raise TrainerError("exported prototype references differ from render bank")

    pairwise_by_id: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for index, row in enumerate(pairwise_rows):
        location = f"pairwise[{index}]"
        sample_id = catalog_assets.require_id(
            row.get("sample_id"), location=f"{location}.sample_id"
        )
        if sample_id in excluded_sample_ids:
            continue
        if sample_id not in samples_by_id:
            raise TrainerError(f"{location}: unknown sample")
        if row.get("schema_version") != PAIRWISE_SCHEMA_VERSION:
            raise TrainerError(f"{location}: unsupported schema")
        validate_record_seal(row, location=location)
        pairwise_by_id[sample_id].append(row)

    candidate_index = {
        candidate: index for index, candidate in enumerate(global_candidates)
    }
    examples: dict[str, TrainingExample] = {}
    for sample_id in sorted(samples_by_id):
        sample = samples_by_id[sample_id]
        listwise = listwise_by_id[sample_id]
        location = f"sample[{sample_id}]"
        if (
            listwise.get("training_sample_record_sha256") != sample.get("record_sha256")
            or listwise.get("work_id") != sample.get("work_id")
            or listwise.get("split") != sample.get("split")
        ):
            raise TrainerError(f"{sample_id}: listwise/sample binding mismatch")
        judgment = require_mapping(
            sample.get("font_judgment"), location=f"{location}.font_judgment"
        )
        tiers = _tier_partition(judgment, location=f"{location}.font_judgment")
        if tiers["not_reviewed"]:
            raise TrainerError(f"{sample_id}: incomplete candidate judgment")
        partition = {candidate for values in tiers.values() for candidate in values}
        if partition != set(global_candidates):
            raise TrainerError(f"{sample_id}: judgment does not partition candidates")
        retrieval = retrieval_by_id[sample_id]
        if (
            retrieval.get("training_sample_record_sha256")
            != sample.get("record_sha256")
            or retrieval.get("split") != sample.get("split")
            or retrieval.get("work_id") != sample.get("work_id")
        ):
            raise TrainerError(f"{sample_id}: retrieval/sample binding mismatch")
        expected_positive = sorted([*tiers["preferred"], *tiers["acceptable"]])
        expected_negative = sorted([*tiers["marginal"], *tiers["unacceptable"]])
        expected_abstain = bool(judgment["none_acceptable"])
        expected_contrastive_eligible = not expected_abstain
        if (
            retrieval.get("positive_candidate_ids") != expected_positive
            or retrieval.get("negative_candidate_ids") != expected_negative
            or retrieval.get("excluded_unrenderable_candidate_ids")
            != sorted(tiers["unrenderable"])
            or retrieval.get("abstain_target") is not expected_abstain
            or retrieval.get("eligible_for_contrastive_loss")
            is not expected_contrastive_eligible
        ):
            raise TrainerError(f"{sample_id}: retrieval target drifted")
        tier_by_candidate = {
            candidate: tier for tier, values in tiers.items() for candidate in values
        }
        targets = require_list(
            listwise.get("candidate_targets"),
            location=f"{sample_id}.candidate_targets",
        )
        target_by_id = {
            str(
                require_mapping(value, location=f"{sample_id}.candidate_target").get(
                    "candidate_id"
                )
            ): value
            for value in targets
        }
        gains: list[float] = []
        masks: list[bool] = []
        for candidate in global_candidates:
            target = require_mapping(
                target_by_id.get(candidate), location=f"{sample_id}.{candidate}"
            )
            tier = tier_by_candidate[candidate]
            eligible = tier in RANKED_TIERS
            gain = TIER_GAIN[tier] if eligible else None
            if (
                target.get("tier") != tier
                or target.get("loss_eligible") is not eligible
                or target.get("relevance_gain") != gain
            ):
                raise TrainerError(
                    f"{sample_id}: listwise target drift for {candidate}"
                )
            gains.append(float(gain or 0.0))
            masks.append(eligible)
        if not any(masks):
            raise TrainerError(f"{sample_id}: no listwise-loss-eligible candidates")

        expected_pairs: set[tuple[str, str, int]] = set()
        for better_index, better_tier in enumerate(RANKED_TIERS):
            for worse_tier in RANKED_TIERS[better_index + 1 :]:
                distance = RANKED_TIERS.index(worse_tier) - better_index
                expected_pairs.update(
                    (better, worse, distance)
                    for better in tiers[better_tier]
                    for worse in tiers[worse_tier]
                )
        observed_pairs: set[tuple[str, str, int]] = set()
        for pair in pairwise_by_id.get(sample_id, []):
            if (
                pair.get("training_sample_record_sha256") != sample.get("record_sha256")
                or pair.get("split") != sample.get("split")
                or pair.get("work_id") != sample.get("work_id")
            ):
                raise TrainerError(f"{sample_id}: pairwise/sample binding mismatch")
            better = require_text(
                pair.get("better_candidate_id"), location=f"{sample_id}.better"
            )
            worse = require_text(
                pair.get("worse_candidate_id"), location=f"{sample_id}.worse"
            )
            distance = pair.get("tier_distance")
            if (
                not isinstance(distance, int)
                or isinstance(distance, bool)
                or distance < 1
            ):
                raise TrainerError(f"{sample_id}: invalid pairwise tier distance")
            pair_key = (better, worse, distance)
            if pair_key in observed_pairs:
                raise TrainerError(f"{sample_id}: duplicate pairwise target")
            observed_pairs.add(pair_key)
        if observed_pairs != expected_pairs:
            raise TrainerError(f"{sample_id}: pairwise inventory differs from tiers")
        pair_indices = tuple(
            sorted(
                (
                    candidate_index[better],
                    candidate_index[worse],
                    distance,
                )
                for better, worse, distance in observed_pairs
            )
        )

        role = require_text(
            require_mapping(sample.get("role"), location=f"{location}.role").get(
                "primary"
            ),
            location=f"{location}.role.primary",
        )
        if role not in ROLE_VALUES:
            raise TrainerError(f"{sample_id}: unsupported final role {role!r}")
        source_style = require_mapping(
            sample.get("source_style"), location=f"{location}.source_style"
        )
        unknown_fields = set(
            require_list(
                source_style.get("unknown_fields"),
                location=f"{location}.source_style.unknown_fields",
            )
        )
        if not unknown_fields <= set(STYLE_FIELDS):
            raise TrainerError(f"{sample_id}: unknown style field names")
        style_values: list[float] = []
        style_mask: list[bool] = []
        for field in STYLE_FIELDS:
            value = source_style.get(field)
            known = field not in unknown_fields and value is not None
            if known:
                style_values.append(
                    require_probability(
                        value, location=f"{location}.source_style.{field}"
                    )
                )
            else:
                if value is not None or field not in unknown_fields:
                    raise TrainerError(
                        f"{sample_id}: style unknown mask/value mismatch"
                    )
                style_values.append(0.0)
            style_mask.append(known)
        treatment = require_mapping(
            sample.get("treatment"), location=f"{location}.treatment"
        )
        if set(treatment) != set(TREATMENT_VALUES):
            raise TrainerError(f"{sample_id}: treatment fields drifted")
        treatment_indices: list[int] = []
        for field, values in TREATMENT_VALUES.items():
            value = require_text(
                treatment.get(field), location=f"{location}.treatment.{field}"
            )
            if value not in values:
                raise TrainerError(f"{sample_id}: unsupported {field} value {value!r}")
            treatment_indices.append(values.index(value))
        chapter_id = catalog_assets.require_id(
            sample.get("chapter_id"), location=f"{location}.chapter_id"
        )
        page_id = catalog_assets.require_id(
            sample.get("page_id"), location=f"{location}.page_id"
        )
        consistency_action = _consistency_action(sample)
        priority, variant_class = _variant_metadata(
            sample,
            role=role,
            style_values=style_values,
            consistency_action=consistency_action,
        )
        label_quality_weight = _label_quality_weight(sample)
        weight = sample.get("work_balance_weight")
        if (
            isinstance(weight, bool)
            or not isinstance(weight, (int, float))
            or not math.isfinite(float(weight))
            or float(weight) <= 0.0
        ):
            raise TrainerError(f"{sample_id}: invalid work_balance_weight")
        examples[sample_id] = TrainingExample(
            sample_id=sample_id,
            work_id=str(sample["work_id"]),
            split=str(sample["split"]),
            sample_record_sha256=str(sample["record_sha256"]),
            listwise_record_sha256=str(listwise["_validated_record_sha256"]),
            candidate_gains=tuple(gains),
            candidate_loss_mask=tuple(masks),
            pairwise_indices=pair_indices,
            none_target=float(bool(judgment["none_acceptable"])),
            role_index=ROLE_VALUES.index(role),
            style_values=tuple(style_values),
            style_mask=tuple(style_mask),
            treatment_indices=tuple(treatment_indices),
            work_balance_weight=float(weight),
            chapter_id=chapter_id,
            page_id=page_id,
            variant_class=variant_class,
            priority=priority,
            consistency_action=consistency_action,
            label_quality_weight=label_quality_weight,
        )

    renderer = require_mapping(
        export.manifest.get("renderer_bindings"),
        location="training export.renderer_bindings",
    )
    font_catalog_sha = catalog_assets.require_sha256(
        renderer.get("font_catalog_sha256"),
        location="training export.renderer_bindings.font_catalog_sha256",
    )
    if export.manifest.get("candidate_count") != len(global_candidates):
        raise TrainerError("training export candidate count drifted")
    if not any(item.split == "train" for item in examples.values()):
        raise TrainerError("training export has no train examples")
    if not any(item.split == "val" for item in examples.values()):
        raise TrainerError("training export has no val examples")
    chapter_pairs, chapter_pair_contract = _load_chapter_pairs(
        export=export,
        samples_by_id=samples_by_id,
        examples_by_id=examples,
    )
    return TrainingCorpus(
        export=export,
        samples_by_id=dict(sorted(samples_by_id.items())),
        examples_by_id=dict(sorted(examples.items())),
        candidate_ids=global_candidates,
        font_catalog_sha256=font_catalog_sha,
        listwise_sha256=listwise_sha,
        pairwise_sha256=pairwise_sha,
        retrieval_sha256=retrieval_sha,
        prototype_sha256=prototype_sha,
        font_signal_audit=font_signal_audit,
        chapter_pairs=chapter_pairs,
        chapter_pair_contract=chapter_pair_contract,
    )


ENCODER_PREPROCESSING_CONTRACT: Mapping[str, Any] = {
    "input_mode": "RGB",
    "input_size_px": [224, 224],
    "processor": {
        "class": PROCESSOR_CLASS,
        "do_resize": False,
        "use_fast": PROCESSOR_USE_FAST,
    },
    "prototype_to_encoder_input": dict(catalog_assets.RAW_224_RECIPE),
    "sample_views": "verified-rgb-224-passthrough-v1",
}


def _records_digest(records: Iterable[Mapping[str, Any]]) -> str:
    payload = "".join(canonical_json(record) + "\n" for record in records)
    return sha256_bytes(payload.encode("utf-8"))


def _cache_sample_index(scan: AssetScan) -> list[dict[str, Any]]:
    return [
        {
            "row_index": index,
            "sample_id": row["sample_id"],
            "split": row["split"],
            "view_order": list(VIEW_NAMES),
        }
        for index, row in enumerate(scan.sample_rows)
    ]


def _cache_prototype_index(scan: AssetScan) -> list[dict[str, Any]]:
    return [
        {
            "font_id": row["font_id"],
            "probe_id": row["probe_id"],
            "render_id": row["render_id"],
            "row_index": index,
            "writing_mode": row["writing_mode"],
        }
        for index, row in enumerate(scan.prototype_rows)
    ]


def validate_asset_validation_report(
    path_value: Path | str | None,
    *,
    resolver: catalog_assets.CatalogAssetResolver,
    export: catalog_assets.TrainingExportSnapshot,
    render_bank: catalog_assets.RenderBankSnapshot,
) -> str | None:
    if path_value is None:
        return None
    path = Path(path_value).expanduser().resolve()
    report = _read_json(path, location="asset validation report")
    validate_record_seal(report, location="asset validation report")
    if report.get("schema_version") != catalog_assets.SCHEMA_VERSION:
        raise TrainerError("asset validation report schema is unsupported")
    inputs = require_mapping(report.get("inputs"), location="asset report.inputs")
    if (
        require_mapping(
            inputs.get("catalog_registry"), location="asset report.catalog_registry"
        ).get("sha256")
        != resolver.registry_sha256
        or require_mapping(
            inputs.get("render_bank"), location="asset report.render_bank"
        ).get("manifest_sha256")
        != render_bank.manifest_sha256
        or require_mapping(
            inputs.get("training_export"), location="asset report.training_export"
        ).get("manifest_sha256")
        != export.manifest_sha256
    ):
        raise TrainerError("asset validation report is bound to other inputs")
    checks = require_mapping(report.get("checks"), location="asset report.checks")
    required_true = (
        "all_images_decoded",
        "all_model_views_rgb_224",
        "all_render_prototypes_font_ready",
        "catalog_roots_registry_bound",
    )
    if any(checks.get(key) is not True for key in required_true) or any(
        checks.get(key) != 0
        for key in (
            "evaluation_ineligible_inputs",
            "qa_overlay_inputs",
            "synthetic_inputs",
        )
    ):
        raise TrainerError("asset validation report did not pass all safety checks")
    return sha256_file(path)


def scan_model_assets(
    *,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    corpus: TrainingCorpus,
) -> AssetScan:
    """Verify train/val pixels only and return path-free pixel evidence."""

    sample_rows: list[Mapping[str, Any]] = []
    for sample_id in sorted(corpus.samples_by_id):
        sample = corpus.samples_by_id[sample_id]
        split = str(sample.get("split"))
        if split not in TRAINING_PIXEL_SPLITS:
            continue
        view_rows: dict[str, Mapping[str, Any]] = {}
        for view_name in VIEW_NAMES:
            with resolver.resolve_sample_view(sample, view_name) as resolved:
                if resolved.mode != IMAGE_MODE or resolved.size != IMAGE_SIZE:
                    raise TrainerError(
                        f"{sample_id}.{view_name}: safe resolver returned non-RGB/224"
                    )
                evidence = resolved.evidence()
                view_rows[view_name] = {
                    "catalog_id": evidence["catalog_id"],
                    "encoder_input_pixel_sha256": evidence["pixel_sha256"],
                    "materialized": evidence["materialized"],
                    "source_file_sha256": evidence["source_file_sha256"],
                    "source_pixel_sha256": evidence["pixel_sha256"],
                    "status": evidence["status"],
                }
        sample_rows.append(
            {
                "sample_id": sample_id,
                "split": split,
                "training_sample_record_sha256": sample["record_sha256"],
                "views": view_rows,
            }
        )

    prototype_rows: list[Mapping[str, Any]] = []
    for evidence in render_bank.prototype_evidence:
        render_id = str(evidence["render_id"])
        with render_bank.resolve_prototype(render_id) as prototype:
            letterboxed = catalog_assets.letterbox_raw_224(prototype.image)
            try:
                if letterboxed.mode != IMAGE_MODE or letterboxed.size != IMAGE_SIZE:
                    raise TrainerError(
                        f"prototype {render_id}: encoder letterbox is not RGB 224"
                    )
                encoder_pixel_sha = catalog_assets.pixel_sha256(letterboxed)
            finally:
                letterboxed.close()
            prototype_rows.append(
                {
                    "artifact_sha256": prototype.source_file_sha256,
                    "candidate_display_id": prototype.candidate_display_id,
                    "encoder_input_pixel_sha256": encoder_pixel_sha,
                    "font_id": prototype.font_id,
                    "image_file": prototype.image_file,
                    "probe_id": prototype.probe_id,
                    "render_id": prototype.render_id,
                    "source_font_sha256": prototype.source_font_sha256,
                    "source_pixel_sha256": prototype.pixel_sha256,
                    "source_size_px": list(prototype.size),
                    "writing_mode": prototype.writing_mode,
                }
            )
    prototype_rows.sort(
        key=lambda row: (
            str(row["font_id"]),
            str(row["writing_mode"]),
            str(row["probe_id"]),
            str(row["render_id"]),
        )
    )
    if not sample_rows or not prototype_rows:
        raise TrainerError("feature scan requires train/val samples and prototypes")
    if any(row["split"] == "test" for row in sample_rows):
        raise TrainerError("test pixels entered the train/val feature scan")
    return AssetScan(tuple(sample_rows), tuple(prototype_rows))


def build_cache_contract(
    *,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    corpus: TrainingCorpus,
    scan: AssetScan,
    asset_validation_report_sha256: str | None,
) -> dict[str, Any]:
    return {
        "encoder": {
            "class": ENCODER_CLASS,
            "fully_frozen": True,
            "model_id": ENCODER_ID,
            "revision": ENCODER_REVISION,
        },
        "inputs": {
            "asset_validation_report_sha256": asset_validation_report_sha256,
            "catalog_registry_sha256": resolver.registry_sha256,
            "font_signal_audit": corpus.font_signal_audit.input_binding(),
            "font_prototypes_sha256": corpus.prototype_sha256,
            "listwise_sha256": corpus.listwise_sha256,
            "pairwise_sha256": corpus.pairwise_sha256,
            "render_bank_manifest_sha256": render_bank.manifest_sha256,
            "render_specification_sha256": render_bank.specification_sha256,
            "retrieval_sha256": corpus.retrieval_sha256,
            "samples_sha256": corpus.export.samples_sha256,
            "training_export_manifest_sha256": corpus.export.manifest_sha256,
        },
        "inventory": {
            "prototype_count": len(scan.prototype_rows),
            "prototype_index_sha256": _records_digest(_cache_prototype_index(scan)),
            "prototype_pixels_sha256": _records_digest(scan.prototype_rows),
            "sample_count": len(scan.sample_rows),
            "sample_index_sha256": _records_digest(_cache_sample_index(scan)),
            "sample_view_pixels_sha256": _records_digest(scan.sample_rows),
            "splits": ["train", "val"],
            "test_pixel_count": 0,
            "view_count": len(scan.sample_rows) * len(VIEW_NAMES),
        },
        "preprocessing": copy.deepcopy(dict(ENCODER_PREPROCESSING_CONTRACT)),
        "schema_version": CACHE_SCHEMA_VERSION,
    }


def _configure_deterministic_cuda_environment() -> None:
    # cuBLAS reads this when its first handle is created, so feature extraction
    # must set it before moving the frozen encoder to CUDA.
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")


class FrozenSiglipExtractor:
    """Lazy Transformers wrapper with a frozen SiglipVisionModel tower."""

    def __init__(
        self,
        *,
        device: str = "auto",
        fp16: bool = True,
    ) -> None:
        _configure_deterministic_cuda_environment()
        try:
            import torch
            from transformers import AutoImageProcessor, SiglipVisionModel
        except (ImportError, OSError) as error:  # pragma: no cover - environment setup
            raise TrainerError(
                "feature extraction requires torch and transformers with SiglipVisionModel"
            ) from error
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if device not in {"cpu", "cuda"}:
            raise TrainerError("encoder device must be auto, cpu, or cuda")
        if device == "cuda" and not torch.cuda.is_available():
            raise TrainerError("CUDA encoder requested but CUDA is unavailable")
        self._torch = torch
        self.device = device
        self.fp16 = bool(fp16 and device == "cuda")
        self.processor = AutoImageProcessor.from_pretrained(
            ENCODER_ID,
            revision=ENCODER_REVISION,
            use_fast=PROCESSOR_USE_FAST,
        )
        self.model = SiglipVisionModel.from_pretrained(
            ENCODER_ID,
            revision=ENCODER_REVISION,
        )
        self.model.requires_grad_(False)
        self.model.eval()
        self.model.to(self.device)
        if any(parameter.requires_grad for parameter in self.model.parameters()):
            raise TrainerError("SigLIP encoder failed to freeze completely")
        self.feature_dim = int(self.model.config.hidden_size)
        processor_config = self.processor.to_dict()
        self.processor_config_sha256 = sha256_bytes(
            canonical_json(processor_config).encode("utf-8")
        )

    def encode(self, images: Sequence[Any]) -> np.ndarray:
        if not images:
            return np.empty((0, self.feature_dim), dtype=np.float32)
        for index, image in enumerate(images):
            if image.mode != IMAGE_MODE or image.size != IMAGE_SIZE:
                raise TrainerError(
                    f"encoder image[{index}] must be RGB 224x224, got {image.mode} {image.size}"
                )
        inputs = self.processor(
            images=list(images),
            return_tensors="pt",
            do_resize=False,
            do_convert_rgb=True,
        )
        pixel_values = inputs["pixel_values"]
        if tuple(pixel_values.shape[-2:]) != IMAGE_SIZE:
            raise TrainerError("SigLIP processor changed the frozen 224x224 input size")
        pixel_values = pixel_values.to(self.device)
        with (
            self._torch.inference_mode(),
            self._torch.autocast(
                device_type="cuda",
                dtype=self._torch.float16,
                enabled=self.fp16,
            ),
        ):
            output = self.model(pixel_values=pixel_values)
            features = output.pooler_output
        features = self._torch.nn.functional.normalize(features.float(), p=2, dim=-1)
        result = features.cpu().numpy().astype(np.float32, copy=False)
        if result.shape != (len(images), self.feature_dim) or not np.all(
            np.isfinite(result)
        ):
            raise TrainerError("SigLIP emitted invalid feature rows")
        return result.copy()


def _flush_image_batch(
    *,
    images: list[Any],
    indices: list[int],
    output: np.ndarray,
    extractor: ImageFeatureExtractor,
) -> None:
    if not images:
        return
    try:
        features = np.asarray(extractor.encode(images), dtype=np.float32)
        if features.shape != (len(images), output.shape[-1]):
            raise TrainerError(
                f"extractor returned {features.shape}, expected {(len(images), output.shape[-1])}"
            )
        if not np.all(np.isfinite(features)):
            raise TrainerError("extractor returned non-finite features")
        output[np.asarray(indices, dtype=np.int64)] = features
    finally:
        for image in images:
            image.close()
        images.clear()
        indices.clear()


def extract_feature_arrays(
    *,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    corpus: TrainingCorpus,
    scan: AssetScan,
    extractor: ImageFeatureExtractor,
    image_batch_size: int,
) -> tuple[np.ndarray, np.ndarray]:
    if image_batch_size < 1 or extractor.feature_dim < 1:
        raise TrainerError("feature extraction dimensions/batch size must be positive")
    sample_features = np.empty(
        (len(scan.sample_rows), len(VIEW_NAMES), extractor.feature_dim),
        dtype=np.float32,
    )
    flat_samples = sample_features.reshape(-1, extractor.feature_dim)
    images: list[Any] = []
    indices: list[int] = []
    for sample_index, scan_row in enumerate(scan.sample_rows):
        sample_id = str(scan_row["sample_id"])
        sample = corpus.samples_by_id[sample_id]
        if sample.get("split") not in TRAINING_PIXEL_SPLITS:
            raise TrainerError("test pixels attempted to enter feature extraction")
        scan_views = require_mapping(scan_row.get("views"), location="scan.views")
        for view_index, view_name in enumerate(VIEW_NAMES):
            with resolver.resolve_sample_view(sample, view_name) as resolved:
                expected = require_mapping(
                    scan_views.get(view_name), location=f"scan.{sample_id}.{view_name}"
                )
                if resolved.pixel_sha256 != expected.get("source_pixel_sha256"):
                    raise StaleFeatureCacheError(
                        f"{sample_id}.{view_name}: pixels changed after scan"
                    )
                images.append(resolved.image.copy())
                indices.append(sample_index * len(VIEW_NAMES) + view_index)
            if len(images) >= image_batch_size:
                _flush_image_batch(
                    images=images,
                    indices=indices,
                    output=flat_samples,
                    extractor=extractor,
                )
    _flush_image_batch(
        images=images,
        indices=indices,
        output=flat_samples,
        extractor=extractor,
    )

    prototype_features = np.empty(
        (len(scan.prototype_rows), extractor.feature_dim), dtype=np.float32
    )
    images = []
    indices = []
    for prototype_index, scan_row in enumerate(scan.prototype_rows):
        render_id = str(scan_row["render_id"])
        with render_bank.resolve_prototype(render_id) as prototype:
            if prototype.pixel_sha256 != scan_row.get("source_pixel_sha256"):
                raise StaleFeatureCacheError(
                    f"prototype {render_id}: pixels changed after scan"
                )
            letterboxed = catalog_assets.letterbox_raw_224(prototype.image)
            if catalog_assets.pixel_sha256(letterboxed) != scan_row.get(
                "encoder_input_pixel_sha256"
            ):
                letterboxed.close()
                raise StaleFeatureCacheError(
                    f"prototype {render_id}: encoder pixels changed after scan"
                )
            images.append(letterboxed)
            indices.append(prototype_index)
        if len(images) >= image_batch_size:
            _flush_image_batch(
                images=images,
                indices=indices,
                output=prototype_features,
                extractor=extractor,
            )
    _flush_image_batch(
        images=images,
        indices=indices,
        output=prototype_features,
        extractor=extractor,
    )
    return sample_features, prototype_features


def _assert_safe_directory_target(path: Path, *, label: str) -> Path:
    resolved = path.expanduser().resolve()
    if resolved == Path(resolved.anchor) or len(resolved.name) < 3:
        raise TrainerError(f"refusing unsafe {label} directory: {resolved}")
    if path.exists() and path.is_symlink():
        raise TrainerError(f"refusing symlink {label} directory: {path}")
    return resolved


def _write_file_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _write_npy(path: Path, value: np.ndarray) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            np.save(handle, value, allow_pickle=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _artifact_descriptor(path: Path, array: np.ndarray) -> dict[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "dtype": str(array.dtype),
        "file": path.name,
        "sha256": sha256_file(path),
        "shape": list(array.shape),
    }


def _cache_owner_marker_path(root: Path) -> Path:
    return root / ".font-matching-siglip-feature-cache-owned.json"


def _validate_cache_ownership(root: Path) -> Mapping[str, Any]:
    marker_path = _cache_owner_marker_path(root)
    if not marker_path.is_file() or marker_path.is_symlink():
        raise TrainerError("feature cache is not safely owned by this trainer")
    marker = _read_json(marker_path, location="feature cache ownership marker")
    if (
        marker.get("owner") != CACHE_OWNER
        or marker.get("schema_version") != CACHE_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise TrainerError("feature cache ownership marker is invalid")
    return marker


def _commit_managed_directory(
    *, staging: Path, target: Path, owner_validator: Callable[[Path], Any] | None
) -> None:
    backup = target.parent / f".{target.name}.backup-{os.getpid()}"
    if backup.exists():
        raise TrainerError(f"managed-directory backup already exists: {backup}")
    if target.exists():
        if owner_validator is None:
            raise TrainerError(f"refusing to replace existing directory: {target}")
        owner_validator(target)
        os.replace(target, backup)
    try:
        os.replace(staging, target)
    except BaseException:
        if backup.exists() and not target.exists():
            os.replace(backup, target)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def write_feature_cache(
    *,
    cache_dir: Path,
    contract: Mapping[str, Any],
    scan: AssetScan,
    sample_features: np.ndarray,
    prototype_features: np.ndarray,
    processor_config_sha256: str,
) -> FeatureCache:
    root = _assert_safe_directory_target(cache_dir, label="feature cache")
    if sample_features.dtype != np.float32 or prototype_features.dtype != np.float32:
        raise TrainerError("feature cache arrays must be float32")
    if sample_features.shape[:2] != (len(scan.sample_rows), len(VIEW_NAMES)):
        raise TrainerError("sample feature array shape differs from scan")
    if prototype_features.shape[0] != len(scan.prototype_rows):
        raise TrainerError("prototype feature array shape differs from scan")
    if (
        sample_features.ndim != 3
        or prototype_features.ndim != 2
        or sample_features.shape[-1] != prototype_features.shape[-1]
    ):
        raise TrainerError("sample/prototype feature dimensions differ")
    if not np.all(np.isfinite(sample_features)) or not np.all(
        np.isfinite(prototype_features)
    ):
        raise TrainerError("feature cache contains non-finite values")
    catalog_assets.require_sha256(
        processor_config_sha256, location="processor_config_sha256"
    )
    root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{root.name}.staging-", dir=root.parent))
    try:
        sample_path = staging / "sample-features.npy"
        prototype_path = staging / "prototype-features.npy"
        _write_npy(sample_path, np.ascontiguousarray(sample_features))
        _write_npy(prototype_path, np.ascontiguousarray(prototype_features))
        sample_index = _cache_sample_index(scan)
        prototype_index = _cache_prototype_index(scan)
        inventory = require_mapping(
            contract.get("inventory"), location="feature cache contract.inventory"
        )
        if inventory.get("sample_index_sha256") != _records_digest(
            sample_index
        ) or inventory.get("prototype_index_sha256") != _records_digest(
            prototype_index
        ):
            raise TrainerError("feature cache contract/index binding mismatch")
        manifest = seal_record(
            {
                "artifacts": {
                    sample_path.name: _artifact_descriptor(
                        sample_path, sample_features
                    ),
                    prototype_path.name: _artifact_descriptor(
                        prototype_path, prototype_features
                    ),
                },
                "contract": copy.deepcopy(dict(contract)),
                "feature_dim": int(sample_features.shape[-1]),
                "processor_config_sha256": processor_config_sha256,
                "prototype_index": prototype_index,
                "sample_index": sample_index,
                "schema_version": CACHE_SCHEMA_VERSION,
            }
        )
        manifest_payload = json_bytes(manifest, pretty=True)
        _write_file_atomic(staging / "manifest.json", manifest_payload)
        marker = {
            "manifest_sha256": sha256_bytes(manifest_payload),
            "owner": CACHE_OWNER,
            "safe_replace": True,
            "schema_version": CACHE_SCHEMA_VERSION,
        }
        _write_file_atomic(
            _cache_owner_marker_path(staging), json_bytes(marker, pretty=True)
        )
        _commit_managed_directory(
            staging=staging, target=root, owner_validator=_validate_cache_ownership
        )
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return load_feature_cache(cache_dir=root, expected_contract=contract)


def _load_array_artifact(
    *, root: Path, manifest: Mapping[str, Any], file_name: str
) -> np.ndarray:
    artifacts = require_mapping(manifest.get("artifacts"), location="cache.artifacts")
    descriptor = require_mapping(
        artifacts.get(file_name), location=f"cache.artifacts.{file_name}"
    )
    if descriptor.get("file") != file_name:
        raise TrainerError(f"cache artifact {file_name} binding mismatch")
    path = root / file_name
    if path.parent != root or not path.is_file() or path.is_symlink():
        raise TrainerError(f"cache artifact {file_name} is missing or unsafe")
    if sha256_file(path) != descriptor.get(
        "sha256"
    ) or path.stat().st_size != descriptor.get("byte_size"):
        raise TrainerError(f"cache artifact {file_name} hash/size mismatch")
    try:
        value = np.load(path, allow_pickle=False)
    except (OSError, ValueError) as error:
        raise TrainerError(
            f"cache artifact {file_name} failed to load: {error}"
        ) from error
    if list(value.shape) != descriptor.get("shape") or str(
        value.dtype
    ) != descriptor.get("dtype"):
        raise TrainerError(f"cache artifact {file_name} shape/dtype mismatch")
    if value.dtype != np.float32:
        raise TrainerError(f"cache artifact {file_name} must be float32")
    return value


def load_feature_cache(
    *, cache_dir: Path, expected_contract: Mapping[str, Any]
) -> FeatureCache:
    root = _assert_safe_directory_target(cache_dir, label="feature cache")
    if not root.is_dir():
        raise TrainerError(f"feature cache directory does not exist: {root}")
    marker = _validate_cache_ownership(root)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise TrainerError("feature cache manifest is missing or unsafe")
    manifest_payload = manifest_path.read_bytes()
    if sha256_bytes(manifest_payload) != marker.get("manifest_sha256"):
        raise TrainerError("feature cache marker/manifest hash mismatch")
    manifest = _read_json(manifest_path, location="feature cache manifest")
    validate_record_seal(manifest, location="feature cache manifest")
    if manifest.get("schema_version") != CACHE_SCHEMA_VERSION:
        raise TrainerError("feature cache schema is unsupported")
    if manifest.get("contract") != expected_contract:
        raise StaleFeatureCacheError("feature cache contract is stale")
    catalog_assets.require_sha256(
        manifest.get("processor_config_sha256"),
        location="feature cache.processor_config_sha256",
    )
    sample_features = _load_array_artifact(
        root=root, manifest=manifest, file_name="sample-features.npy"
    )
    prototype_features = _load_array_artifact(
        root=root, manifest=manifest, file_name="prototype-features.npy"
    )
    sample_index = require_list(
        manifest.get("sample_index"), location="feature cache.sample_index"
    )
    prototype_index = require_list(
        manifest.get("prototype_index"), location="feature cache.prototype_index"
    )
    if (
        sample_features.ndim != 3
        or prototype_features.ndim != 2
        or sample_features.shape[0] != len(sample_index)
        or prototype_features.shape[0] != len(prototype_index)
        or sample_features.shape[1] != len(VIEW_NAMES)
        or sample_features.shape[-1] != prototype_features.shape[-1]
        or sample_features.shape[-1] < 1
        or manifest.get("feature_dim") != sample_features.shape[-1]
    ):
        raise TrainerError("feature cache index/array dimensions drifted")
    if not np.all(np.isfinite(sample_features)) or not np.all(
        np.isfinite(prototype_features)
    ):
        raise TrainerError("feature cache contains non-finite values")
    inventory = require_mapping(
        expected_contract.get("inventory"), location="cache contract.inventory"
    )
    if (
        inventory.get("sample_count") != len(sample_index)
        or inventory.get("prototype_count") != len(prototype_index)
        or inventory.get("sample_index_sha256")
        != _records_digest(
            require_mapping(row, location="cache.sample_index row")
            for row in sample_index
        )
        or inventory.get("prototype_index_sha256")
        != _records_digest(
            require_mapping(row, location="cache.prototype_index row")
            for row in prototype_index
        )
        or any(
            require_mapping(row, location="cache.sample_index row").get("row_index")
            != index
            for index, row in enumerate(sample_index)
        )
        or any(
            require_mapping(row, location="cache.prototype_index row").get("row_index")
            != index
            for index, row in enumerate(prototype_index)
        )
        or any(
            require_mapping(row, location="cache.sample_index row").get("split")
            not in TRAINING_PIXEL_SPLITS
            for row in sample_index
        )
        or any(
            require_mapping(row, location="cache.sample_index row").get("view_order")
            != list(VIEW_NAMES)
            for row in sample_index
        )
    ):
        raise TrainerError("feature cache inventory index drifted")
    return FeatureCache(
        root=root,
        manifest=manifest,
        manifest_sha256=sha256_bytes(manifest_payload),
        sample_features=sample_features,
        prototype_features=prototype_features,
    )


def get_or_build_feature_cache(
    *,
    cache_dir: Path,
    contract: Mapping[str, Any],
    scan: AssetScan,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    corpus: TrainingCorpus,
    stale_policy: str,
    image_batch_size: int,
    extractor_factory: Callable[[], ImageFeatureExtractor],
) -> tuple[FeatureCache, str]:
    if stale_policy not in {"fail", "rebuild"}:
        raise TrainerError("stale cache policy must be fail or rebuild")
    root = _assert_safe_directory_target(cache_dir, label="feature cache")
    existed = root.exists()
    if root.exists():
        try:
            return (
                load_feature_cache(cache_dir=root, expected_contract=contract),
                "reused",
            )
        except (StaleFeatureCacheError, TrainerError):
            if stale_policy == "fail":
                raise
            _validate_cache_ownership(root)
    extractor = extractor_factory()
    sample_features, prototype_features = extract_feature_arrays(
        resolver=resolver,
        render_bank=render_bank,
        corpus=corpus,
        scan=scan,
        extractor=extractor,
        image_batch_size=image_batch_size,
    )
    processor_config_sha = getattr(extractor, "processor_config_sha256", None)
    if not isinstance(processor_config_sha, str):
        processor_config_sha = sha256_bytes(
            canonical_json(
                {
                    "extractor_type": type(extractor).__name__,
                    "testing_precomputed": True,
                }
            ).encode("utf-8")
        )
    cache = write_feature_cache(
        cache_dir=root,
        contract=contract,
        scan=scan,
        sample_features=sample_features,
        prototype_features=prototype_features,
        processor_config_sha256=processor_config_sha,
    )
    return cache, "rebuilt" if existed else "built"


def seed_everything(seed: int) -> None:
    if seed < 0:
        raise TrainerError("seed must be non-negative")
    _configure_deterministic_cuda_environment()
    random.seed(seed)
    np.random.seed(seed % (2**32))
    try:
        import torch
    except ImportError as error:  # pragma: no cover - environment setup
        raise TrainerError("ranker training requires torch") from error
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True


def build_ranker(
    *,
    feature_dim: int,
    hidden_dim: int,
    view_dropout: float,
    head_dropout: float,
) -> Any:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - environment setup
        raise TrainerError("ranker construction requires torch") from error
    if feature_dim < 1 or hidden_dim < 1:
        raise TrainerError("ranker dimensions must be positive")
    if not 0.0 <= view_dropout < 1.0 or not 0.0 <= head_dropout < 1.0:
        raise TrainerError("dropout probabilities must be in [0, 1)")

    class PrototypeConditionedRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.feature_dim = feature_dim
            self.hidden_dim = hidden_dim
            self.view_dropout_probability = view_dropout
            self.view_norm = torch.nn.LayerNorm(feature_dim)
            self.view_gate = torch.nn.Linear(feature_dim, 1)
            self.sample_projection = torch.nn.Sequential(
                torch.nn.Linear(feature_dim * 4, hidden_dim),
                torch.nn.GELU(),
                torch.nn.Dropout(head_dropout),
                torch.nn.LayerNorm(hidden_dim),
            )
            self.prototype_projection = torch.nn.Sequential(
                torch.nn.LayerNorm(feature_dim),
                torch.nn.Linear(feature_dim, hidden_dim, bias=False),
            )
            self.logit_scale = torch.nn.Parameter(torch.tensor(0.0))
            self.none_head = torch.nn.Linear(hidden_dim, 1)
            self.role_head = torch.nn.Linear(hidden_dim, len(ROLE_VALUES))
            self.style_head = torch.nn.Linear(hidden_dim, len(STYLE_FIELDS))
            self.treatment_heads = torch.nn.ModuleDict(
                {
                    field: torch.nn.Linear(hidden_dim, len(values))
                    for field, values in TREATMENT_VALUES.items()
                }
            )

        def _drop_view_mask(self, views: Any) -> Any:
            mask = torch.ones(views.shape[:2], dtype=torch.bool, device=views.device)
            if self.training and self.view_dropout_probability > 0.0:
                mask = (
                    torch.rand(views.shape[:2], device=views.device)
                    >= self.view_dropout_probability
                )
                empty = ~mask.any(dim=1)
                if empty.any():
                    mask[empty, 0] = True
            return mask

        def forward(
            self,
            views: Any,
            prototypes: Any,
            candidate_bags: Sequence[Any],
        ) -> Mapping[str, Any]:
            if views.ndim != 3 or views.shape[1:] != (3, self.feature_dim):
                raise TrainerError(
                    f"ranker expected [batch,3,{self.feature_dim}] views"
                )
            if prototypes.ndim != 2 or prototypes.shape[1] != self.feature_dim:
                raise TrainerError(
                    f"ranker expected [prototype,{self.feature_dim}] features"
                )
            if not candidate_bags or any(len(bag) < 1 for bag in candidate_bags):
                raise TrainerError("every candidate must retain a prototype bag")
            normalized_views = self.view_norm(views.float())
            view_mask = self._drop_view_mask(normalized_views)
            gate_logits = self.view_gate(normalized_views).squeeze(-1)
            gate_logits = gate_logits.masked_fill(~view_mask, float("-inf"))
            gate_weights = torch.softmax(gate_logits, dim=1)
            gated = (normalized_views * gate_weights.unsqueeze(-1)).sum(dim=1)
            concatenated = (normalized_views * view_mask.unsqueeze(-1)).reshape(
                views.shape[0], -1
            )
            sample_hidden = self.sample_projection(
                torch.cat([gated, concatenated], dim=-1)
            )
            prototype_hidden = self.prototype_projection(prototypes.float())
            sample_unit = torch.nn.functional.normalize(sample_hidden, p=2, dim=-1)
            prototype_unit = torch.nn.functional.normalize(
                prototype_hidden, p=2, dim=-1
            )
            prototype_scores = (
                sample_unit @ prototype_unit.transpose(0, 1)
            ) * self.logit_scale.exp().clamp(max=100.0)
            candidate_scores = torch.stack(
                [
                    torch.logsumexp(prototype_scores[:, bag], dim=1)
                    - math.log(len(bag))
                    for bag in candidate_bags
                ],
                dim=1,
            )
            return {
                "candidate_scores": candidate_scores,
                "none_logits": self.none_head(sample_hidden).squeeze(-1),
                "role_logits": self.role_head(sample_hidden),
                "style_logits": self.style_head(sample_hidden),
                "treatment_logits": {
                    field: head(sample_hidden)
                    for field, head in self.treatment_heads.items()
                },
                "view_gate_weights": gate_weights,
            }

    model = PrototypeConditionedRanker()
    candidate_parameter_names = [
        name
        for name, _ in model.named_parameters()
        if "candidate" in name.casefold() or "font_id" in name.casefold()
    ]
    if candidate_parameter_names:
        raise TrainerError(
            "candidate-ID-specific parameters are forbidden: "
            f"{candidate_parameter_names}"
        )
    return model


def prototype_bags(
    cache: FeatureCache, candidate_ids: Sequence[str], *, device: str
) -> tuple[Any, ...]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise TrainerError("prototype bags require torch") from error
    rows = require_list(
        cache.manifest.get("prototype_index"),
        location="feature cache.prototype_index",
    )
    by_font: dict[str, list[int]] = defaultdict(list)
    for index, raw_row in enumerate(rows):
        row = require_mapping(raw_row, location=f"prototype_index[{index}]")
        if row.get("row_index") != index:
            raise TrainerError("prototype cache row index drifted")
        font_id = require_text(
            row.get("font_id"), location=f"prototype_index[{index}].font_id"
        )
        by_font[font_id].append(index)
    if set(by_font) != set(candidate_ids):
        raise TrainerError("prototype cache candidate inventory drifted")
    return tuple(
        torch.tensor(by_font[candidate], dtype=torch.long, device=device)
        for candidate in candidate_ids
    )


def compute_multitask_loss(
    *,
    outputs: Mapping[str, Any],
    examples: Sequence[TrainingExample],
    hyperparameters: TrainingHyperparameters,
    apply_sample_weights: bool = True,
) -> tuple[Any, Mapping[str, Any]]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise TrainerError("loss computation requires torch") from error
    if not examples:
        raise TrainerError("loss batch must not be empty")
    scores = outputs["candidate_scores"].float()
    device = scores.device
    if scores.shape[0] != len(examples):
        raise TrainerError("loss batch/example count mismatch")
    gains = torch.tensor(
        [item.candidate_gains for item in examples],
        dtype=torch.float32,
        device=device,
    )
    rank_mask = torch.tensor(
        [item.candidate_loss_mask for item in examples],
        dtype=torch.bool,
        device=device,
    )
    if scores.shape != gains.shape or (~rank_mask).all(dim=1).any():
        raise TrainerError("candidate score/target contract mismatch")
    masked_scores = scores.masked_fill(~rank_mask, float("-inf"))
    masked_gains = gains.masked_fill(~rank_mask, float("-inf"))
    target_distribution = torch.softmax(masked_gains, dim=1)
    log_probabilities = torch.log_softmax(masked_scores, dim=1).masked_fill(
        ~rank_mask, 0.0
    )
    listwise_per_sample = -(target_distribution * log_probabilities).sum(dim=1)

    pairwise_losses: list[Any] = []
    for row_index, item in enumerate(examples):
        if not item.pairwise_indices:
            pairwise_losses.append(scores.new_zeros(()))
            continue
        parts = []
        for better, worse, distance in item.pairwise_indices:
            difference = scores[row_index, better] - scores[row_index, worse]
            parts.append(torch.nn.functional.softplus(-difference) * float(distance))
        pairwise_losses.append(torch.stack(parts).mean())
    pairwise_per_sample = torch.stack(pairwise_losses)

    none_targets = torch.tensor(
        [item.none_target for item in examples],
        dtype=torch.float32,
        device=device,
    )
    none_per_sample = torch.nn.functional.binary_cross_entropy_with_logits(
        outputs["none_logits"].float(), none_targets, reduction="none"
    )
    role_targets = torch.tensor(
        [item.role_index for item in examples], dtype=torch.long, device=device
    )
    role_per_sample = torch.nn.functional.cross_entropy(
        outputs["role_logits"].float(), role_targets, reduction="none"
    )
    style_targets = torch.tensor(
        [item.style_values for item in examples],
        dtype=torch.float32,
        device=device,
    )
    style_mask = torch.tensor(
        [item.style_mask for item in examples], dtype=torch.bool, device=device
    )
    raw_style = torch.nn.functional.smooth_l1_loss(
        torch.sigmoid(outputs["style_logits"].float()),
        style_targets,
        reduction="none",
    )
    style_per_sample = (raw_style * style_mask).sum(dim=1) / style_mask.sum(
        dim=1
    ).clamp(min=1)

    treatment_parts: list[Any] = []
    for field_index, field in enumerate(TREATMENT_VALUES):
        target = torch.tensor(
            [item.treatment_indices[field_index] for item in examples],
            dtype=torch.long,
            device=device,
        )
        treatment_parts.append(
            torch.nn.functional.cross_entropy(
                outputs["treatment_logits"][field].float(),
                target,
                reduction="none",
            )
        )
    treatment_per_sample = torch.stack(treatment_parts, dim=1).mean(dim=1)
    weight_values = (
        [
            (
                item.training_weight
                if item.training_weight is not None
                else item.work_balance_weight
            )
            for item in examples
        ]
        if apply_sample_weights
        else [1.0 for _ in examples]
    )
    weight_values = _mean_one_capped_weights(
        weight_values, cap=MAX_TRAINING_EXAMPLE_WEIGHT
    ).tolist()
    weights = torch.tensor(weight_values, dtype=torch.float32, device=device)
    if not torch.isfinite(weights).all() or not torch.all(weights > 0):
        raise TrainerError("batch contains invalid work-balance weights")
    # Every sampled batch is projected back to mean-one under the same 3x cap,
    # preventing optimizer-step scale jitter without violating the multiplier gate.

    per_component = {
        "listwise": (listwise_per_sample * weights).mean(),
        "pairwise": (pairwise_per_sample * weights).mean(),
        "none": (none_per_sample * weights).mean(),
        "role": (role_per_sample * weights).mean(),
        "style": (style_per_sample * weights).mean(),
        "treatment": (treatment_per_sample * weights).mean(),
    }
    total = (
        hyperparameters.listwise_weight * per_component["listwise"]
        + hyperparameters.pairwise_weight * per_component["pairwise"]
        + hyperparameters.none_weight * per_component["none"]
        + hyperparameters.role_weight * per_component["role"]
        + hyperparameters.style_weight * per_component["style"]
        + hyperparameters.treatment_weight * per_component["treatment"]
    )
    if not torch.isfinite(total):
        raise TrainerError("multitask loss became non-finite")
    return total, {**per_component, "total": total}


def _positive_candidate_indices(example: TrainingExample) -> frozenset[int]:
    return frozenset(
        index
        for index, (gain, eligible) in enumerate(
            zip(example.candidate_gains, example.candidate_loss_mask)
        )
        if eligible and gain >= TIER_GAIN["acceptable"]
    )


def compute_chapter_pair_losses(
    *,
    outputs: Mapping[str, Any],
    examples: Sequence[TrainingExample],
    pairs: Sequence[ChapterPair],
    hyperparameters: TrainingHyperparameters,
) -> tuple[Any, Mapping[str, Any]]:
    """Compute pair losses only from human-confirmed same-split chapter pairs."""

    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise TrainerError("chapter pair loss computation requires torch") from error
    scores = outputs["candidate_scores"].float()
    if scores.shape[0] != len(examples):
        raise TrainerError("chapter pair score/example count mismatch")
    row_by_id = {item.sample_id: index for index, item in enumerate(examples)}
    example_by_id = {item.sample_id: item for item in examples}
    if len(row_by_id) != len(examples):
        raise TrainerError("chapter pair examples repeat sample IDs")
    consistency_parts: list[Any] = []
    override_parts: list[Any] = []
    overlap_skipped = 0
    for pair in pairs:
        if pair.split == "test":
            raise TrainerError("test chapter pair attempted to enter development loss")
        anchor = example_by_id.get(pair.anchor_sample_id)
        target = example_by_id.get(pair.target_sample_id)
        if anchor is None or target is None:
            raise TrainerError("chapter pair endpoint is absent from the loss split")
        if (
            anchor.split != pair.split
            or target.split != pair.split
            or anchor.chapter_id != pair.chapter_id
            or target.chapter_id != pair.chapter_id
        ):
            raise TrainerError("chapter pair grouping drifted before loss")
        anchor_scores = scores[row_by_id[anchor.sample_id]]
        target_scores = scores[row_by_id[target.sample_id]]
        if pair.kind == "ordinary_consistency_positive":
            anchor_probability = torch.softmax(anchor_scores, dim=0)
            target_probability = torch.softmax(target_scores, dim=0)
            middle = (anchor_probability + target_probability) / 2.0
            epsilon = torch.finfo(scores.dtype).eps
            divergence = 0.5 * (
                torch.sum(
                    anchor_probability
                    * (
                        torch.log(anchor_probability.clamp(min=epsilon))
                        - torch.log(middle.clamp(min=epsilon))
                    )
                )
                + torch.sum(
                    target_probability
                    * (
                        torch.log(target_probability.clamp(min=epsilon))
                        - torch.log(middle.clamp(min=epsilon))
                    )
                )
            )
            consistency_parts.append(divergence)
            continue
        if pair.kind != "local_override_margin":
            raise TrainerError("unsupported chapter pair kind entered loss")
        anchor_positive = _positive_candidate_indices(anchor)
        target_positive = _positive_candidate_indices(target)
        union = anchor_positive | target_positive
        overlap = anchor_positive & target_positive
        if not anchor_positive or not target_positive:
            raise TrainerError("chapter override pair has no acceptable candidates")
        if len(overlap) / len(union) >= 0.5:
            overlap_skipped += 1
            continue
        target_probability = torch.softmax(target_scores, dim=0)
        target_mass = target_probability[list(sorted(target_positive))].sum()
        anchor_only = anchor_positive - target_positive
        anchor_mass = (
            target_probability[list(sorted(anchor_only))].sum()
            if anchor_only
            else target_probability.new_zeros(())
        )
        override_parts.append(
            torch.relu(
                target_probability.new_tensor(hyperparameters.local_override_margin)
                + anchor_mass
                - target_mass
            )
        )
    zero = scores.new_zeros(())
    consistency_loss = (
        torch.stack(consistency_parts).mean() if consistency_parts else zero
    )
    override_loss = torch.stack(override_parts).mean() if override_parts else zero
    total = (
        hyperparameters.chapter_consistency_weight * consistency_loss
        + hyperparameters.local_override_weight * override_loss
    )
    if not torch.isfinite(total):
        raise TrainerError("chapter pair loss became non-finite")
    return total, {
        "chapter_consistency": consistency_loss,
        "chapter_consistency_pair_count": len(consistency_parts),
        "local_override": override_loss,
        "local_override_overlap_skipped_count": overlap_skipped,
        "local_override_pair_count": len(override_parts),
        "total": total,
    }


def _ranking_metrics(
    scores: np.ndarray,
    examples: Sequence[TrainingExample],
) -> Mapping[str, float | int | None]:
    if not examples:
        return {
            "acceptable_at_1": None,
            "ndcg": None,
            "preferred_at_1": None,
            "recall_at_3": None,
            "sample_count": 0,
        }
    acceptable_hits = 0
    preferred_hits = 0
    recall_hits = 0
    ndcg_values: list[float] = []
    for row_index, example in enumerate(examples):
        ordering = sorted(
            range(scores.shape[1]),
            key=lambda index: (-float(scores[row_index, index]), index),
        )
        best = ordering[0]
        acceptable = _positive_candidate_indices(example)
        acceptable_hits += best in acceptable
        preferred_hits += (
            example.candidate_loss_mask[best]
            and example.candidate_gains[best] >= TIER_GAIN["preferred"]
        )
        recall_hits += bool(acceptable & set(ordering[:3]))
        eligible_ordering = [
            index for index in ordering if example.candidate_loss_mask[index]
        ]
        discounted = sum(
            (2.0 ** example.candidate_gains[index] - 1.0) / math.log2(rank + 2.0)
            for rank, index in enumerate(eligible_ordering)
        )
        ideal = sorted(
            (
                example.candidate_gains[index]
                for index, eligible in enumerate(example.candidate_loss_mask)
                if eligible
            ),
            reverse=True,
        )
        ideal_discounted = sum(
            (2.0**gain - 1.0) / math.log2(rank + 2.0) for rank, gain in enumerate(ideal)
        )
        ndcg_values.append(discounted / ideal_discounted if ideal_discounted else 0.0)
    count = len(examples)
    return {
        "acceptable_at_1": acceptable_hits / count,
        "ndcg": sum(ndcg_values) / count,
        "preferred_at_1": preferred_hits / count,
        "recall_at_3": recall_hits / count,
        "sample_count": count,
    }


def _binary_metrics(predictions: np.ndarray, truths: np.ndarray) -> Mapping[str, Any]:
    count = int(len(truths))
    if not count:
        return {
            "accuracy": None,
            "f1": None,
            "precision": None,
            "recall": None,
            "sample_count": 0,
        }
    true_positive = int(np.sum(predictions & truths))
    false_positive = int(np.sum(predictions & ~truths))
    false_negative = int(np.sum(~predictions & truths))
    precision = (
        true_positive / (true_positive + false_positive)
        if true_positive + false_positive
        else 0.0
    )
    recall = (
        true_positive / (true_positive + false_negative)
        if true_positive + false_negative
        else 0.0
    )
    return {
        "accuracy": float(np.mean(predictions == truths)),
        "f1": (
            2.0 * precision * recall / (precision + recall)
            if precision + recall
            else 0.0
        ),
        "precision": precision,
        "recall": recall,
        "sample_count": count,
    }


def compute_none_metrics(
    *,
    none_logits: np.ndarray,
    examples: Sequence[TrainingExample],
    threshold: float,
) -> Mapping[str, Any]:
    if (
        not examples
        or any(item.split != "val" for item in examples)
        or none_logits.shape != (len(examples),)
    ):
        raise TrainerError("none metrics accept validation logits/examples only")
    if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
        raise TrainerError("none metric threshold must be finite in [0, 1]")
    none_probability = 1.0 / (1.0 + np.exp(-none_logits.astype(np.float64)))
    predictions = none_probability >= threshold
    truths = np.asarray([bool(item.none_target) for item in examples])
    output: dict[str, Any] = {
        "overall": _binary_metrics(predictions, truths),
        "threshold": threshold,
    }
    for priority in sorted(PRIORITY_TARGET_MIX):
        indices = np.asarray(
            [index for index, item in enumerate(examples) if item.priority == priority],
            dtype=np.int64,
        )
        output[f"priority_{priority}"] = _binary_metrics(
            predictions[indices], truths[indices]
        )
    return output


def compute_validation_metrics(
    *,
    candidate_scores: np.ndarray,
    none_logits: np.ndarray,
    examples: Sequence[TrainingExample],
    chapter_pairs: Sequence[ChapterPair],
) -> Mapping[str, Any]:
    """Evaluate the untouched validation distribution; never accepts test rows."""

    if not examples or any(item.split != "val" for item in examples):
        raise TrainerError("validation metrics accept validation examples only")
    if candidate_scores.shape != (
        len(examples),
        len(examples[0].candidate_gains),
    ) or none_logits.shape != (len(examples),):
        raise TrainerError("validation metric tensor shapes drifted")
    by_priority: dict[str, Any] = {}
    for priority in sorted(PRIORITY_TARGET_MIX):
        indices = [
            index for index, item in enumerate(examples) if item.priority == priority
        ]
        by_priority[str(priority)] = _ranking_metrics(
            candidate_scores[indices], tuple(examples[index] for index in indices)
        )
    role_recall: dict[str, Any] = {}
    for role_index, role in enumerate(ROLE_VALUES):
        indices = [
            index
            for index, item in enumerate(examples)
            if item.role_index == role_index
        ]
        if indices:
            role_recall[role] = _ranking_metrics(
                candidate_scores[indices],
                tuple(examples[index] for index in indices),
            )["recall_at_3"]
    p1_role_metrics = []
    for role_index in sorted(
        {item.role_index for item in examples if item.priority == 1}
    ):
        indices = [
            index
            for index, item in enumerate(examples)
            if item.priority == 1 and item.role_index == role_index
        ]
        p1_role_metrics.append(
            _ranking_metrics(
                candidate_scores[indices],
                tuple(examples[index] for index in indices),
            )
        )
    p1_macro = {
        metric: (
            sum(float(row[metric]) for row in p1_role_metrics) / len(p1_role_metrics)
            if p1_role_metrics
            else None
        )
        for metric in ("acceptable_at_1", "ndcg", "preferred_at_1", "recall_at_3")
    }
    p1_macro["role_count"] = len(p1_role_metrics)

    none_metrics = compute_none_metrics(
        none_logits=none_logits, examples=examples, threshold=0.5
    )

    row_by_id = {item.sample_id: index for index, item in enumerate(examples)}
    example_by_id = {item.sample_id: item for item in examples}
    positive_count = 0
    unnecessary_switches = 0
    coherent_positives = 0
    accent_positive_count = 0
    accent_coherent = 0
    override_count = 0
    override_recalled = 0
    override_overlap_skipped = 0
    for pair in chapter_pairs:
        if pair.split != "val":
            continue
        if (
            pair.anchor_sample_id not in row_by_id
            or pair.target_sample_id not in row_by_id
        ):
            raise TrainerError("validation chapter pair endpoint is absent")
        anchor = example_by_id[pair.anchor_sample_id]
        target = example_by_id[pair.target_sample_id]
        anchor_top = int(np.argmax(candidate_scores[row_by_id[anchor.sample_id]]))
        target_top = int(np.argmax(candidate_scores[row_by_id[target.sample_id]]))
        anchor_positive = _positive_candidate_indices(anchor)
        target_positive = _positive_candidate_indices(target)
        coherent = anchor_top == target_top or (
            anchor_top in target_positive and target_top in anchor_positive
        )
        if pair.kind == "ordinary_consistency_positive":
            positive_count += 1
            coherent_positives += coherent
            unnecessary_switches += not coherent
            if pair.role not in {"dialogue", "narration", "thought"}:
                accent_positive_count += 1
                accent_coherent += coherent
            continue
        union = anchor_positive | target_positive
        if not union or len(anchor_positive & target_positive) / len(union) >= 0.5:
            override_overlap_skipped += 1
            continue
        override_count += 1
        override_recalled += (
            target_top in target_positive and target_top not in anchor_positive
        )
    chapter_metrics = {
        "accent_cluster_consistency": (
            accent_coherent / accent_positive_count if accent_positive_count else None
        ),
        "chapter_anchor_coherence": (
            coherent_positives / positive_count if positive_count else None
        ),
        "false_override_rate": (
            unnecessary_switches / positive_count if positive_count else None
        ),
        "local_override_recall": (
            override_recalled / override_count if override_count else None
        ),
        "local_override_pair_count": override_count,
        "local_override_overlap_skipped_count": override_overlap_skipped,
        "positive_pair_count": positive_count,
        "unnecessary_body_font_switches_per_100": (
            100.0 * unnecessary_switches / positive_count if positive_count else None
        ),
    }
    return {
        "chapter": chapter_metrics,
        "none_at_fixed_0_5": none_metrics,
        "overall": _ranking_metrics(candidate_scores, examples),
        "p1_variant_role_macro": p1_macro,
        "priority": by_priority,
        "role_recall_at_3": role_recall,
        "split": "val_original_distribution",
    }


def _feature_row_by_sample(cache: FeatureCache) -> Mapping[str, int]:
    rows = require_list(
        cache.manifest.get("sample_index"), location="feature cache.sample_index"
    )
    output: dict[str, int] = {}
    for index, raw_row in enumerate(rows):
        row = require_mapping(raw_row, location=f"sample_index[{index}]")
        sample_id = require_text(
            row.get("sample_id"), location=f"sample_index[{index}].sample_id"
        )
        if row.get("row_index") != index or sample_id in output:
            raise TrainerError("sample feature index is duplicated or out of order")
        if row.get("split") not in TRAINING_PIXEL_SPLITS:
            raise TrainerError("test sample found in feature cache")
        output[sample_id] = index
    return output


def _batch_indices(count: int, batch_size: int, *, seed: int) -> tuple[np.ndarray, ...]:
    generator = np.random.default_rng(seed)
    ordering = generator.permutation(count)
    return tuple(
        ordering[start : start + batch_size] for start in range(0, count, batch_size)
    )


def _mean_one_capped_weights(raw_weights: Sequence[float], *, cap: float) -> np.ndarray:
    values = np.asarray(raw_weights, dtype=np.float64)
    if (
        not len(values)
        or not np.all(np.isfinite(values))
        or np.any(values <= 0.0)
        or not math.isfinite(cap)
        or cap <= 1.0
    ):
        raise TrainerError("training weights/cap must be finite and positive")
    low = 0.0
    high = 1.0 / float(values.min())
    while float(np.minimum(cap, high * values).mean()) < 1.0:
        high *= 2.0
    for _ in range(100):
        middle = (low + high) / 2.0
        if float(np.minimum(cap, middle * values).mean()) < 1.0:
            low = middle
        else:
            high = middle
    output = np.minimum(cap, high * values)
    if not math.isclose(float(output.mean()), 1.0, abs_tol=1e-10):
        raise TrainerError("capped training weights could not be normalized")
    if float(output.max()) > cap + 1e-10:
        raise TrainerError("normalized training weight exceeded its hard cap")
    return output


def _effective_number_role_factors(
    examples: Sequence[TrainingExample], *, beta: float = 0.999
) -> Mapping[int, float]:
    counts = Counter(item.role_index for item in examples)
    raw = {
        role_index: (1.0 - beta) / (1.0 - beta**count)
        for role_index, count in counts.items()
    }
    mean = sum(raw[item.role_index] for item in examples) / len(examples)
    return {role_index: value / mean for role_index, value in raw.items()}


def prepare_variant_training_examples(
    examples: Sequence[TrainingExample],
) -> tuple[tuple[TrainingExample, ...], Mapping[str, Any]]:
    """Apply train-only work/role/quality weighting with a strict 3x cap.

    Priority is intentionally sampler-only: multiplying it here as well would
    square the requested 60/15/25 emphasis and make loss scale batch-dependent.
    """

    if not examples or any(item.split != "train" for item in examples):
        raise TrainerError("variant training weights accept train examples only")
    normalized = normalize_work_balance_weights(examples)
    priority_counts = Counter(item.priority for item in normalized)
    if any(priority not in PRIORITY_TARGET_MIX for priority in priority_counts):
        raise TrainerError("training example has unsupported priority")
    available_target_total = sum(
        PRIORITY_TARGET_MIX[priority] for priority in priority_counts
    )
    target_shares = {
        priority: PRIORITY_TARGET_MIX[priority] / available_target_total
        for priority in priority_counts
    }
    observed_shares = {
        priority: count / len(normalized) for priority, count in priority_counts.items()
    }
    role_factors = _effective_number_role_factors(normalized)
    role_counts = Counter(item.role_index for item in normalized)
    raw_weights = [
        item.work_balance_weight
        * role_factors[item.role_index]
        * item.label_quality_weight
        for item in normalized
    ]
    final_weights = _mean_one_capped_weights(
        raw_weights, cap=MAX_TRAINING_EXAMPLE_WEIGHT
    )
    weighted = tuple(
        replace(item, training_weight=float(final_weights[index]))
        for index, item in enumerate(normalized)
    )
    return weighted, {
        "formula": "work_balance_x_role_effective_number_x_label_quality",
        "hard_cap": MAX_TRAINING_EXAMPLE_WEIGHT,
        "label_quality_min": min(item.label_quality_weight for item in normalized),
        "label_quality_max": max(item.label_quality_weight for item in normalized),
        "loss_batch_weight_normalization": "mean_one_capped_reprojection",
        "normalized_mean": float(final_weights.mean()),
        "observed_priority_counts": {
            str(priority): priority_counts[priority]
            for priority in sorted(priority_counts)
        },
        "observed_priority_shares": {
            str(priority): observed_shares[priority]
            for priority in sorted(observed_shares)
        },
        "role_balance": "effective_number_beta_0.999",
        "role_counts": {
            ROLE_VALUES[role_index]: role_counts[role_index]
            for role_index in sorted(role_counts)
        },
        "target_priority_shares_available": {
            str(priority): target_shares[priority] for priority in sorted(target_shares)
        },
        "weight_max": float(final_weights.max()),
        "weight_min": float(final_weights.min()),
        "variant_priority_application": (
            "sampler_only_no_duplicate_per_sample_multiplier"
        ),
    }


def _priority_epoch_counts(
    examples: Sequence[TrainingExample],
) -> Mapping[int, int]:
    available = sorted({item.priority for item in examples})
    target_total = sum(PRIORITY_TARGET_MIX[priority] for priority in available)
    raw = {
        priority: len(examples) * PRIORITY_TARGET_MIX[priority] / target_total
        for priority in available
    }
    counts = {priority: int(math.floor(value)) for priority, value in raw.items()}
    remainder = len(examples) - sum(counts.values())
    for priority in sorted(
        available, key=lambda value: (-(raw[value] - counts[value]), value)
    )[:remainder]:
        counts[priority] += 1
    if sum(counts.values()) != len(examples):
        raise TrainerError("priority epoch allocation drifted")
    return counts


def build_priority_epoch_batches(
    examples: Sequence[TrainingExample], *, batch_size: int, seed: int
) -> tuple[tuple[np.ndarray, ...], Mapping[str, Any]]:
    """Build one deterministic priority/role-aware train epoch."""

    if not examples or batch_size < 1:
        raise TrainerError("priority sampler requires examples and positive batch size")
    if any(item.split != "train" for item in examples):
        raise TrainerError("priority sampler accepts train examples only")
    generator = np.random.default_rng(seed)
    desired_counts = _priority_epoch_counts(examples)
    role_factors = _effective_number_role_factors(examples)
    selected: list[int] = []
    for priority in sorted(desired_counts):
        source = np.asarray(
            [index for index, item in enumerate(examples) if item.priority == priority],
            dtype=np.int64,
        )
        desired = desired_counts[priority]
        probabilities = np.asarray(
            [role_factors[examples[int(index)].role_index] for index in source],
            dtype=np.float64,
        )
        probabilities /= probabilities.sum()
        chosen = generator.choice(
            source,
            size=desired,
            replace=desired > len(source),
            p=probabilities,
        )
        selected.extend(int(index) for index in chosen)
    ordering = np.asarray(selected, dtype=np.int64)
    generator.shuffle(ordering)
    batches = tuple(
        ordering[start : start + batch_size]
        for start in range(0, len(ordering), batch_size)
    )
    observed = Counter(examples[int(index)].priority for index in ordering)
    if dict(observed) != dict(desired_counts):
        raise TrainerError("priority sampler output mix drifted")
    return batches, {
        "epoch_sample_count": len(ordering),
        "priority_counts": {
            str(priority): observed[priority] for priority in sorted(observed)
        },
        "priority_shares": {
            str(priority): observed[priority] / len(ordering)
            for priority in sorted(observed)
        },
        "replacement_used": any(
            desired_counts[priority]
            > sum(item.priority == priority for item in examples)
            for priority in desired_counts
        ),
        "role_sampling": "effective_number_beta_0.999",
        "seed": seed,
        "target_mix": {
            str(priority): PRIORITY_TARGET_MIX[priority]
            for priority in sorted(PRIORITY_TARGET_MIX)
        },
    }


def _evaluate_loss(
    *,
    model: Any,
    feature_tensor: Any,
    prototype_tensor: Any,
    bags: Sequence[Any],
    examples: Sequence[TrainingExample],
    hyperparameters: TrainingHyperparameters,
    batch_size: int,
    chapter_pairs: Sequence[ChapterPair],
) -> tuple[float, Mapping[str, float | int], Mapping[str, Any]]:
    import torch

    model.eval()
    totals: Counter[str] = Counter()
    observed = 0
    candidate_parts: list[Any] = []
    none_parts: list[Any] = []
    with torch.no_grad():
        for start in range(0, len(examples), batch_size):
            batch_examples = examples[start : start + batch_size]
            views = feature_tensor[start : start + len(batch_examples)]
            outputs = model(views, prototype_tensor, bags)
            _, components = compute_multitask_loss(
                outputs=outputs,
                examples=batch_examples,
                hyperparameters=hyperparameters,
                apply_sample_weights=False,
            )
            candidate_parts.append(outputs["candidate_scores"].float())
            none_parts.append(outputs["none_logits"].float())
            for name, value in components.items():
                totals[name] += float(value.detach().cpu()) * len(batch_examples)
            observed += len(batch_examples)
    if observed != len(examples):
        raise TrainerError("validation loss inventory drifted")
    averaged = {name: totals[name] / observed for name in sorted(totals)}
    candidate_scores = torch.cat(candidate_parts, dim=0)
    none_logits = torch.cat(none_parts, dim=0)
    split_pairs = tuple(pair for pair in chapter_pairs if pair.split == "val")
    _, pair_components = compute_chapter_pair_losses(
        outputs={"candidate_scores": candidate_scores},
        examples=examples,
        pairs=split_pairs,
        hyperparameters=hyperparameters,
    )
    pair_total = float(pair_components["total"].detach().cpu())
    averaged["sample_total"] = averaged["total"]
    averaged["chapter_consistency"] = float(
        pair_components["chapter_consistency"].detach().cpu()
    )
    averaged["chapter_consistency_pair_count"] = int(
        pair_components["chapter_consistency_pair_count"]
    )
    averaged["local_override"] = float(pair_components["local_override"].detach().cpu())
    averaged["local_override_pair_count"] = int(
        pair_components["local_override_pair_count"]
    )
    averaged["total"] += pair_total
    metrics = compute_validation_metrics(
        candidate_scores=candidate_scores.detach().cpu().numpy(),
        none_logits=none_logits.detach().cpu().numpy(),
        examples=examples,
        chapter_pairs=split_pairs,
    )
    return averaged["total"], averaged, metrics


def _optional_metric(value: Any, *, fallback: float = -1.0) -> float:
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrainerError("checkpoint metric must be numeric or null")
    output = float(value)
    if not math.isfinite(output):
        raise TrainerError("checkpoint metric must be finite")
    return output


def checkpoint_selection_key(
    *, metrics: Mapping[str, Any], val_loss: float
) -> tuple[float, ...]:
    p1 = require_mapping(
        metrics.get("p1_variant_role_macro"), location="validation.p1_variant"
    )
    overall = require_mapping(metrics.get("overall"), location="validation.overall")
    none = require_mapping(
        require_mapping(
            metrics.get("none_at_fixed_0_5"), location="validation.none"
        ).get("overall"),
        location="validation.none.overall",
    )
    p1_available = p1.get("acceptable_at_1") is not None
    source = p1 if p1_available else overall
    return (
        1.0 if p1_available else 0.0,
        _optional_metric(source.get("acceptable_at_1")),
        _optional_metric(source.get("preferred_at_1")),
        _optional_metric(source.get("ndcg")),
        _optional_metric(none.get("f1")),
        -float(val_loss),
    )


def ordinary_regression_gate(
    *, metrics: Mapping[str, Any], baseline_metrics: Mapping[str, Any]
) -> Mapping[str, Any]:
    current = require_mapping(
        metrics.get("priority"), location="validation.priority"
    ).get("2")
    baseline = require_mapping(
        baseline_metrics.get("priority"), location="baseline.priority"
    ).get("2")
    current_row = require_mapping(current, location="validation.priority.2")
    baseline_row = require_mapping(baseline, location="baseline.priority.2")
    current_top1 = current_row.get("acceptable_at_1")
    baseline_top1 = baseline_row.get("acceptable_at_1")
    if baseline_top1 is None or current_top1 is None:
        return {
            "applicable": False,
            "baseline_acceptable_at_1": baseline_top1,
            "current_acceptable_at_1": current_top1,
            "passed": True,
            "regression_limit": ORDINARY_TOP1_REGRESSION_LIMIT,
        }
    floor = float(baseline_top1) - ORDINARY_TOP1_REGRESSION_LIMIT
    return {
        "applicable": True,
        "baseline_acceptable_at_1": float(baseline_top1),
        "current_acceptable_at_1": float(current_top1),
        "floor": floor,
        "passed": float(current_top1) + 1e-12 >= floor,
        "regression_limit": ORDINARY_TOP1_REGRESSION_LIMIT,
    }


def train_ranker(
    *,
    cache: FeatureCache,
    corpus: TrainingCorpus,
    hyperparameters: TrainingHyperparameters,
    device: str,
    resume_state: Mapping[str, Any] | None = None,
    ordinary_reference: OrdinaryReference | None = None,
) -> tuple[Any, Mapping[str, Any]]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise TrainerError("ranker training requires torch") from error
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device not in {"cpu", "cuda"} or (
        device == "cuda" and not torch.cuda.is_available()
    ):
        raise TrainerError("ranker device is unavailable")
    seed_everything(hyperparameters.seed)
    feature_rows = _feature_row_by_sample(cache)
    raw_train_examples = corpus.examples_for_split("train")
    val_examples = corpus.examples_for_split("val")
    if not raw_train_examples or not val_examples:
        raise TrainerError("train and val examples are both required")
    train_examples, training_weight_contract = prepare_variant_training_examples(
        raw_train_examples
    )
    for item in (*train_examples, *val_examples):
        if item.sample_id not in feature_rows:
            raise TrainerError(f"missing cached feature for {item.sample_id}")
    train_array = np.stack(
        [
            np.asarray(cache.sample_features[feature_rows[item.sample_id]])
            for item in train_examples
        ]
    ).astype(np.float32, copy=False)
    val_array = np.stack(
        [
            np.asarray(cache.sample_features[feature_rows[item.sample_id]])
            for item in val_examples
        ]
    ).astype(np.float32, copy=False)
    prototype_array = np.asarray(cache.prototype_features, dtype=np.float32)
    train_tensor = torch.from_numpy(np.array(train_array, copy=True)).to(device)
    val_tensor = torch.from_numpy(np.array(val_array, copy=True)).to(device)
    prototype_tensor = torch.from_numpy(np.array(prototype_array, copy=True)).to(device)
    model = build_ranker(
        feature_dim=int(train_tensor.shape[-1]),
        hidden_dim=hyperparameters.hidden_dim,
        view_dropout=hyperparameters.view_dropout,
        head_dropout=hyperparameters.head_dropout,
    ).to(device=device, dtype=torch.float32)
    if resume_state is not None:
        try:
            model.load_state_dict(dict(resume_state), strict=True)
        except (RuntimeError, KeyError, ValueError) as error:
            raise TrainerError(f"resume checkpoint is incompatible: {error}") from error
    bags = prototype_bags(cache, corpus.candidate_ids, device=device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=hyperparameters.learning_rate,
        weight_decay=hyperparameters.weight_decay,
    )
    if any(parameter.dtype != torch.float32 for parameter in model.parameters()):
        raise TrainerError("ranker parameters must remain fp32")
    train_pairs = tuple(pair for pair in corpus.chapter_pairs if pair.split == "train")
    val_pairs = tuple(pair for pair in corpus.chapter_pairs if pair.split == "val")
    if any(pair.split == "test" for pair in corpus.chapter_pairs):
        raise TrainerError("test chapter pairs entered the development corpus")
    initial_val_loss, initial_val_components, initial_val_metrics = _evaluate_loss(
        model=model,
        feature_tensor=val_tensor,
        prototype_tensor=prototype_tensor,
        bags=bags,
        examples=val_examples,
        hyperparameters=hyperparameters,
        batch_size=hyperparameters.batch_size,
        chapter_pairs=val_pairs,
    )
    reference_binding: Mapping[str, Any] | None = None
    if ordinary_reference is not None:
        reference_model = copy.deepcopy(model)
        try:
            reference_model.load_state_dict(dict(ordinary_reference.state), strict=True)
        except (RuntimeError, KeyError, ValueError) as error:
            raise TrainerError(
                f"ordinary reference checkpoint is incompatible: {error}"
            ) from error
        if any(
            current.data_ptr() == reference.data_ptr()
            for current, reference in zip(
                model.parameters(), reference_model.parameters(), strict=True
            )
        ):
            raise TrainerError("ordinary reference shares optimizer parameter storage")
        (
            safety_baseline_val_loss,
            safety_baseline_val_components,
            safety_baseline_val_metrics,
        ) = _evaluate_loss(
            model=reference_model,
            feature_tensor=val_tensor,
            prototype_tensor=prototype_tensor,
            bags=bags,
            examples=val_examples,
            hyperparameters=hyperparameters,
            batch_size=hyperparameters.batch_size,
            chapter_pairs=val_pairs,
        )
        reference_ordinary = require_mapping(
            require_mapping(
                safety_baseline_val_metrics.get("priority"),
                location="ordinary reference validation.priority",
            ).get("2"),
            location="ordinary reference validation.priority.2",
        )
        if reference_ordinary.get("acceptable_at_1") is None:
            raise TrainerError(
                "ordinary reference cannot establish priority-2 Acceptable@1"
            )
        reference_binding = copy.deepcopy(dict(ordinary_reference.binding))
        safety_baseline_source = "validated_owned_prior_checkpoint_evaluation_only"
        safety_baseline_status = "production_reference"
    else:
        safety_baseline_val_loss = initial_val_loss
        safety_baseline_val_components = initial_val_components
        safety_baseline_val_metrics = initial_val_metrics
        if resume_state is not None:
            safety_baseline_source = "validated_same_input_resume_checkpoint"
            safety_baseline_status = "production_same_input_resume_reference"
        else:
            safety_baseline_source = "fresh_initial_ranker"
            safety_baseline_status = "non_production_safety_baseline"
    history: list[dict[str, Any]] = []
    best_epoch = -1
    if ordinary_reference is None:
        best_val = initial_val_loss
        best_metrics: Mapping[str, Any] | None = initial_val_metrics
        best_key = checkpoint_selection_key(
            metrics=initial_val_metrics, val_loss=initial_val_loss
        )
        best_state: dict[str, Any] | None = {
            name: tensor.detach().cpu().clone()
            for name, tensor in model.state_dict().items()
        }
    else:
        best_val = math.inf
        best_metrics = None
        best_key = tuple(float("-inf") for _ in range(6))
        best_state = None
    epochs_without_improvement = 0
    sampler_contract: Mapping[str, Any] | None = None
    for epoch in range(hyperparameters.epochs):
        model.train()
        train_totals: Counter[str] = Counter()
        observed = 0
        epoch_batches, sampler_contract = build_priority_epoch_batches(
            train_examples,
            batch_size=hyperparameters.batch_size,
            seed=hyperparameters.seed + epoch,
        )
        for indices in epoch_batches:
            batch_examples = tuple(train_examples[int(index)] for index in indices)
            batch_views = train_tensor[
                torch.tensor(indices, dtype=torch.long, device=device)
            ]
            optimizer.zero_grad(set_to_none=True)
            outputs = model(batch_views, prototype_tensor, bags)
            loss, components = compute_multitask_loss(
                outputs=outputs,
                examples=batch_examples,
                hyperparameters=hyperparameters,
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            for name, value in components.items():
                train_totals[name] += float(value.detach().cpu()) * len(batch_examples)
            observed += len(batch_examples)
        train_metrics = {
            name: train_totals[name] / observed for name in sorted(train_totals)
        }
        if train_pairs:
            model.train()
            optimizer.zero_grad(set_to_none=True)
            pair_outputs = model(train_tensor, prototype_tensor, bags)
            pair_loss, pair_components = compute_chapter_pair_losses(
                outputs=pair_outputs,
                examples=train_examples,
                pairs=train_pairs,
                hyperparameters=hyperparameters,
            )
            if pair_loss.requires_grad and (
                pair_components["chapter_consistency_pair_count"]
                or pair_components["local_override_pair_count"]
            ):
                pair_loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
                optimizer.step()
            train_metrics.update(
                {
                    "chapter_consistency": float(
                        pair_components["chapter_consistency"].detach().cpu()
                    ),
                    "chapter_consistency_pair_count": int(
                        pair_components["chapter_consistency_pair_count"]
                    ),
                    "local_override": float(
                        pair_components["local_override"].detach().cpu()
                    ),
                    "local_override_pair_count": int(
                        pair_components["local_override_pair_count"]
                    ),
                    "pair_total": float(pair_loss.detach().cpu()),
                }
            )
        else:
            train_metrics.update(
                {
                    "chapter_consistency": 0.0,
                    "chapter_consistency_pair_count": 0,
                    "local_override": 0.0,
                    "local_override_pair_count": 0,
                    "pair_total": 0.0,
                }
            )
        val_loss, val_metrics, validation_metrics = _evaluate_loss(
            model=model,
            feature_tensor=val_tensor,
            prototype_tensor=prototype_tensor,
            bags=bags,
            examples=val_examples,
            hyperparameters=hyperparameters,
            batch_size=hyperparameters.batch_size,
            chapter_pairs=val_pairs,
        )
        ordinary_gate = ordinary_regression_gate(
            metrics=validation_metrics,
            baseline_metrics=safety_baseline_val_metrics,
        )
        selection_key = checkpoint_selection_key(
            metrics=validation_metrics, val_loss=val_loss
        )
        history.append(
            {
                "epoch": epoch,
                "priority_sampler": copy.deepcopy(dict(sampler_contract)),
                "train": train_metrics,
                "val": val_metrics,
                "validation_metrics": validation_metrics,
                "validation_selection": {
                    "key": list(selection_key),
                    "ordinary_regression_gate": ordinary_gate,
                },
            }
        )
        if ordinary_gate["passed"] is True and selection_key > best_key:
            best_val = val_loss
            best_epoch = epoch
            best_metrics = validation_metrics
            best_key = selection_key
            best_state = {
                name: tensor.detach().cpu().clone()
                for name, tensor in model.state_dict().items()
            }
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= hyperparameters.patience:
                break
    if best_state is None:
        if ordinary_reference is not None:
            raise TrainerError(
                "no trained checkpoint passed the validated ordinary-reference "
                "Acceptable@1 regression floor"
            )
        raise TrainerError("training produced no best validation checkpoint")
    if best_metrics is None:
        raise TrainerError("best checkpoint lacks validation metrics")
    model.load_state_dict(best_state, strict=True)
    model.eval()
    return model, {
        "best_epoch": best_epoch,
        "best_validation_metrics": best_metrics,
        "best_val_loss": best_val,
        "chapter_pair_contract": copy.deepcopy(dict(corpus.chapter_pair_contract)),
        "checkpoint_selection": {
            "baseline_epoch": -1,
            "baseline_status": safety_baseline_status,
            "baseline_val_components": safety_baseline_val_components,
            "baseline_val_loss": safety_baseline_val_loss,
            "baseline_validation_metrics": safety_baseline_val_metrics,
            "best_ordinary_regression_gate": ordinary_regression_gate(
                metrics=best_metrics,
                baseline_metrics=safety_baseline_val_metrics,
            ),
            "best_key": list(best_key),
            "initial_ranker_val_components": initial_val_components,
            "initial_ranker_val_loss": initial_val_loss,
            "initial_ranker_validation_metrics": initial_val_metrics,
            "ordinary_reference_argument_seeded_optimizer": False,
            "optimizer_seeded_from_ordinary_reference": False,
            "resume_requires_separate_resume_from_argument": True,
            "ordinary_baseline_source": safety_baseline_source,
            "ordinary_acceptable_at_1_regression_limit": (
                ORDINARY_TOP1_REGRESSION_LIMIT
            ),
            "priority_order": [
                "p1_variant_role_macro.acceptable_at_1",
                "p1_variant_role_macro.preferred_at_1",
                "p1_variant_role_macro.ndcg",
                "none_at_fixed_0_5.overall.f1",
                "negative_val_loss",
            ],
            "reference": reference_binding,
        },
        "epochs_completed": len(history),
        "history": history,
        "ranker_device": device,
        "train_sample_count": len(train_examples),
        "train_example_weight_mean": sum(
            float(item.training_weight or 0.0) for item in train_examples
        )
        / len(train_examples),
        "train_priority_sampler": copy.deepcopy(dict(sampler_contract or {})),
        "train_priority_weighting": copy.deepcopy(dict(training_weight_contract)),
        "train_work_weight_mean": sum(
            item.work_balance_weight for item in train_examples
        )
        / len(train_examples),
        "val_sample_count": len(val_examples),
        "val_distribution_contract": {
            "priority_or_role_resampling": False,
            "sample_weighting": "uniform_original_distribution",
            "test_used_for_optimizer_calibration_or_checkpoint_selection": 0,
        },
        "val_work_weight_mean": sum(item.work_balance_weight for item in val_examples)
        / len(val_examples),
    }


def infer_split(
    *,
    model: Any,
    cache: FeatureCache,
    corpus: TrainingCorpus,
    split: str,
    device: str,
    batch_size: int,
) -> tuple[tuple[PredictionBinding, ...], InferenceOutput]:
    import torch

    if split not in TRAINING_PIXEL_SPLITS:
        raise TrainerError("baseline inference is restricted to train/val cache splits")
    examples = corpus.examples_for_split(split)
    if not examples:
        raise TrainerError(f"no {split} examples for inference")
    rows = _feature_row_by_sample(cache)
    feature_array = np.stack(
        [np.asarray(cache.sample_features[rows[item.sample_id]]) for item in examples]
    ).astype(np.float32, copy=False)
    feature_tensor = torch.from_numpy(np.array(feature_array, copy=True)).to(device)
    prototype_tensor = torch.from_numpy(
        np.array(np.asarray(cache.prototype_features, dtype=np.float32), copy=True)
    ).to(device)
    bags = prototype_bags(cache, corpus.candidate_ids, device=device)
    score_parts: list[np.ndarray] = []
    none_parts: list[np.ndarray] = []
    role_parts: list[np.ndarray] = []
    style_parts: list[np.ndarray] = []
    treatment_parts: dict[str, list[np.ndarray]] = {
        field: [] for field in TREATMENT_VALUES
    }
    model.eval()
    with torch.no_grad():
        for start in range(0, len(examples), batch_size):
            views = feature_tensor[start : start + batch_size]
            output = model(views, prototype_tensor, bags)
            score_parts.append(output["candidate_scores"].float().cpu().numpy())
            none_parts.append(output["none_logits"].float().cpu().numpy())
            role_parts.append(output["role_logits"].float().cpu().numpy())
            style_parts.append(output["style_logits"].float().cpu().numpy())
            for field in TREATMENT_VALUES:
                treatment_parts[field].append(
                    output["treatment_logits"][field].float().cpu().numpy()
                )
    inference = InferenceOutput(
        candidate_scores=np.concatenate(score_parts, axis=0),
        none_logits=np.concatenate(none_parts, axis=0),
        role_logits=np.concatenate(role_parts, axis=0),
        style_logits=np.concatenate(style_parts, axis=0),
        treatment_logits={
            field: np.concatenate(parts, axis=0)
            for field, parts in treatment_parts.items()
        },
    )
    expected_shape = (len(examples), len(corpus.candidate_ids))
    if inference.candidate_scores.shape != expected_shape:
        raise TrainerError("inference candidate score shape drifted")
    arrays = [
        inference.candidate_scores,
        inference.none_logits,
        inference.role_logits,
        inference.style_logits,
        *inference.treatment_logits.values(),
    ]
    if any(not np.all(np.isfinite(value)) for value in arrays):
        raise TrainerError("inference emitted non-finite values")
    bindings = tuple(
        PredictionBinding(
            sample_id=item.sample_id,
            work_id=item.work_id,
            split=item.split,
            sample_record_sha256=item.sample_record_sha256,
            listwise_record_sha256=item.listwise_record_sha256,
        )
        for item in examples
    )
    return bindings, inference


def _softmax_numpy(values: np.ndarray, *, axis: int = -1) -> np.ndarray:
    shifted = values - np.max(values, axis=axis, keepdims=True)
    exponent = np.exp(shifted)
    return exponent / exponent.sum(axis=axis, keepdims=True)


def calibrate_on_validation(
    *,
    inference: InferenceOutput,
    examples: Sequence[TrainingExample],
    temperature_grid: Sequence[float] = DEFAULT_TEMPERATURE_GRID,
    none_threshold_grid: Sequence[float] = DEFAULT_NONE_THRESHOLD_GRID,
) -> Calibration:
    if not examples or any(item.split != "val" for item in examples):
        raise TrainerError("calibration accepts validation examples only")
    scores = np.asarray(inference.candidate_scores, dtype=np.float64)
    gains = np.asarray([item.candidate_gains for item in examples], dtype=np.float64)
    mask = np.asarray([item.candidate_loss_mask for item in examples], dtype=np.bool_)
    if scores.shape != gains.shape or scores.shape[0] != len(examples):
        raise TrainerError("validation calibration shapes drifted")
    masked_gains = np.where(mask, gains, -np.inf)
    target = _softmax_numpy(masked_gains)
    temperature_scores: list[tuple[float, float]] = []
    for raw_temperature in temperature_grid:
        temperature = float(raw_temperature)
        if not math.isfinite(temperature) or temperature <= 0.0:
            raise TrainerError("temperature grid must be finite and positive")
        logits = np.where(mask, scores / temperature, -np.inf)
        probabilities = _softmax_numpy(logits)
        loss = float(
            -np.sum(
                np.where(mask, target * np.log(np.maximum(probabilities, 1e-12)), 0.0)
            )
            / len(examples)
        )
        temperature_scores.append((loss, temperature))
    _, best_temperature = min(
        temperature_scores,
        key=lambda item: (item[0], abs(item[1] - 1.0), item[1]),
    )

    none_probabilities = 1.0 / (
        1.0 + np.exp(-np.asarray(inference.none_logits, dtype=np.float64))
    )
    truths = np.asarray([bool(item.none_target) for item in examples], dtype=np.bool_)
    threshold_scores: list[tuple[float, float, float, float]] = []
    for raw_threshold in none_threshold_grid:
        threshold = float(raw_threshold)
        if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
            raise TrainerError("none threshold grid must stay in [0, 1]")
        predictions = none_probabilities >= threshold
        true_positive = int(np.sum(predictions & truths))
        false_positive = int(np.sum(predictions & ~truths))
        false_negative = int(np.sum(~predictions & truths))
        precision = (
            true_positive / (true_positive + false_positive)
            if true_positive + false_positive
            else 0.0
        )
        recall = (
            true_positive / (true_positive + false_negative)
            if true_positive + false_negative
            else 0.0
        )
        f1 = (
            2.0 * precision * recall / (precision + recall)
            if precision + recall
            else 0.0
        )
        accuracy = float(np.mean(predictions == truths))
        threshold_scores.append((f1, accuracy, -abs(threshold - 0.5), threshold))
    best_threshold = max(threshold_scores)[3]
    return Calibration(
        temperature=float(best_temperature), none_threshold=float(best_threshold)
    )


def build_prediction_rows(
    *,
    bindings: Sequence[PredictionBinding],
    inference: InferenceOutput,
    candidate_ids: Sequence[str],
    font_catalog_sha256: str,
    training_export_manifest_sha256: str,
    checkpoint_sha256: str,
    calibration: Calibration,
) -> tuple[Mapping[str, Any], ...]:
    catalog_assets.require_sha256(
        font_catalog_sha256, location="prediction.font_catalog_sha256"
    )
    catalog_assets.require_sha256(
        training_export_manifest_sha256,
        location="prediction.training_export_manifest_sha256",
    )
    catalog_assets.require_sha256(
        checkpoint_sha256, location="prediction.checkpoint_sha256"
    )
    if any(binding.split != "val" for binding in bindings):
        raise TrainerError("first-run prediction output is validation-only")
    count = len(bindings)
    if (
        not math.isfinite(float(calibration.temperature))
        or calibration.temperature <= 0.0
        or not math.isfinite(float(calibration.none_threshold))
        or not 0.0 <= calibration.none_threshold <= 1.0
    ):
        raise TrainerError("prediction calibration is invalid")
    if (
        inference.candidate_scores.shape != (count, len(candidate_ids))
        or inference.none_logits.shape != (count,)
        or inference.role_logits.shape != (count, len(ROLE_VALUES))
        or inference.style_logits.shape != (count, len(STYLE_FIELDS))
        or set(inference.treatment_logits) != set(TREATMENT_VALUES)
        or any(
            inference.treatment_logits[field].shape != (count, len(values))
            for field, values in TREATMENT_VALUES.items()
        )
    ):
        raise TrainerError("prediction tensor shapes drifted")
    inference_arrays = (
        inference.candidate_scores,
        inference.none_logits,
        inference.role_logits,
        inference.style_logits,
        *inference.treatment_logits.values(),
    )
    if any(not np.all(np.isfinite(value)) for value in inference_arrays):
        raise TrainerError("prediction tensors contain non-finite values")
    candidate_probabilities = _softmax_numpy(
        np.asarray(inference.candidate_scores, dtype=np.float64)
        / calibration.temperature
    )
    none_probabilities = 1.0 / (
        1.0 + np.exp(-np.asarray(inference.none_logits, dtype=np.float64))
    )
    style_probabilities = 1.0 / (
        1.0 + np.exp(-np.asarray(inference.style_logits, dtype=np.float64))
    )
    role_indices = np.argmax(inference.role_logits, axis=1)
    treatment_indices = {
        field: np.argmax(inference.treatment_logits[field], axis=1)
        for field in TREATMENT_VALUES
    }
    rows: list[Mapping[str, Any]] = []
    for row_index, binding in enumerate(bindings):
        ordering = sorted(
            range(len(candidate_ids)),
            key=lambda index: (
                -float(inference.candidate_scores[row_index, index]),
                str(candidate_ids[index]),
            ),
        )
        decision = {
            "confidence": float(
                np.clip(np.max(candidate_probabilities[row_index]), 0.0, 1.0)
            ),
            "none_probability": float(np.clip(none_probabilities[row_index], 0.0, 1.0)),
            "ranked_candidate_ids": [str(candidate_ids[index]) for index in ordering],
        }
        variants = {
            "no_genre": copy.deepcopy(decision),
            "swapped_genre": copy.deepcopy(decision),
        }
        decision_bytes = canonical_json(decision).encode("utf-8")
        if any(
            canonical_json(value).encode("utf-8") != decision_bytes
            for value in variants.values()
        ):
            raise TrainerError("genre-free variants are not byte-equivalent decisions")
        semantic_role = ROLE_VALUES[int(role_indices[row_index])]
        semantic_style = {
            field: float(np.clip(style_probabilities[row_index, field_index], 0.0, 1.0))
            for field_index, field in enumerate(STYLE_FIELDS)
        }
        semantic_treatment = {
            field: values[int(treatment_indices[field][row_index])]
            for field, values in TREATMENT_VALUES.items()
        }
        row = seal_record(
            {
                "bindings": {
                    "font_catalog_sha256": font_catalog_sha256,
                    "listwise_target_record_sha256": binding.listwise_record_sha256,
                    "training_export_manifest_sha256": training_export_manifest_sha256,
                    "training_sample_record_sha256": binding.sample_record_sha256,
                },
                "confidence": decision["confidence"],
                "counterfactual_proof": {
                    "default_decision_sha256": sha256_bytes(decision_bytes),
                    "genre_input_available": False,
                    "no_genre_byte_equivalent": True,
                    "swapped_genre_byte_equivalent": True,
                },
                "model": {"id": MODEL_ID, "sha256": checkpoint_sha256},
                "none_probability": decision["none_probability"],
                "ranked_candidate_ids": decision["ranked_candidate_ids"],
                "role": {"primary": semantic_role},
                "sample_id": binding.sample_id,
                "schema_version": PREDICTION_SCHEMA_VERSION,
                "source_style": semantic_style,
                "split": binding.split,
                "treatment": semantic_treatment,
                "variants": variants,
                "work_id": binding.work_id,
            }
        )
        rows.append(row)
    return tuple(rows)


def prediction_jsonl_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")


def semantic_caveat_summary(corpus: TrainingCorpus) -> dict[str, Any]:
    flagged_ids: list[str] = []
    for sample_id, sample in corpus.samples_by_id.items():
        judgment = require_mapping(
            sample.get("font_judgment"), location=f"{sample_id}.font_judgment"
        )
        style = require_mapping(
            sample.get("source_style"), location=f"{sample_id}.source_style"
        )
        unknown = require_list(
            style.get("unknown_fields"), location=f"{sample_id}.unknown_fields"
        )
        if judgment.get("none_acceptable") is True and len(unknown) >= 5:
            flagged_ids.append(sample_id)
    return {
        "eligibility_override_applied": True,
        "font_signal_audit": corpus.font_signal_audit.input_binding(),
        "none_with_at_least_five_unknown_style_fields": len(flagged_ids),
        "sample_ids_sha256": sha256_bytes(
            ("\n".join(sorted(flagged_ids)) + ("\n" if flagged_ids else "")).encode(
                "utf-8"
            )
        ),
        "sealed_eligibility_ledger_applied": True,
    }


def _state_contract(state: Mapping[str, Any]) -> list[dict[str, Any]]:
    output = []
    for name in sorted(state):
        tensor = state[name]
        output.append(
            {
                "dtype": str(tensor.dtype).replace("torch.", ""),
                "name": name,
                "shape": list(tensor.shape),
            }
        )
    return output


def _expected_checkpoint_metadata(
    font_signal_audit: FontSignalAuditSnapshot,
) -> dict[str, str]:
    return {
        "encoder": ENCODER_ID,
        "encoder_revision": ENCODER_REVISION,
        "font_signal_audit_ledger_sha256": font_signal_audit.ledger_sha256,
        "font_signal_audit_report_sha256": font_signal_audit.report_sha256,
        "format": TRAINER_SCHEMA_VERSION,
    }


def save_checkpoint(
    model: Any,
    path: Path,
    *,
    font_signal_audit: FontSignalAuditSnapshot,
) -> tuple[str, list[dict[str, Any]]]:
    try:
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - environment setup
        raise TrainerError("checkpoint writing requires safetensors") from error
    state = {
        name: tensor.detach().cpu().contiguous()
        for name, tensor in sorted(model.state_dict().items())
    }
    save_file(
        state,
        str(path),
        metadata=_expected_checkpoint_metadata(font_signal_audit),
    )
    return sha256_file(path), _state_contract(state)


def load_checkpoint(path: Path) -> Mapping[str, Any]:
    try:
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover
        raise TrainerError("checkpoint loading requires safetensors") from error
    try:
        return dict(load_file(str(path), device="cpu"))
    except (OSError, RuntimeError, ValueError) as error:
        raise TrainerError(f"checkpoint failed to load: {error}") from error


def load_checkpoint_metadata(path: Path) -> Mapping[str, str]:
    try:
        from safetensors import safe_open
    except ImportError as error:  # pragma: no cover
        raise TrainerError(
            "checkpoint metadata loading requires safetensors"
        ) from error
    try:
        with safe_open(str(path), framework="pt", device="cpu") as handle:
            return dict(handle.metadata() or {})
    except (OSError, RuntimeError, ValueError) as error:
        raise TrainerError(f"checkpoint metadata failed to load: {error}") from error


def _output_marker_path(root: Path) -> Path:
    return root / ".font-matching-siglip-baseline-owned.json"


def _validate_output_ownership(root: Path) -> Mapping[str, Any]:
    marker_path = _output_marker_path(root)
    if not marker_path.is_file() or marker_path.is_symlink():
        raise TrainerError("baseline output is not safely owned by this trainer")
    marker = _read_json(marker_path, location="baseline output marker")
    if (
        marker.get("owner") != OUTPUT_OWNER
        or marker.get("schema_version") != TRAINER_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise TrainerError("baseline output ownership marker is invalid")
    return marker


def load_ordinary_reference(
    *,
    output_dir: Path,
    cache: FeatureCache,
    hyperparameters: TrainingHyperparameters,
) -> OrdinaryReference:
    """Load a prior owned ranker for evaluation only across successor inputs.

    This deliberately does not call ``validate_training_output`` because that
    validator must reject different exports/catalogs. Instead it fully validates
    the prior owned bundle and its architecture, while never opening the prior
    feature cache, training export, prediction source images, or any test pixels.
    """

    root = _assert_safe_directory_target(output_dir, label="ordinary reference")
    if not root.is_dir():
        raise TrainerError(f"ordinary reference does not exist: {root}")
    marker = _validate_output_ownership(root)
    expected_files = {
        ".font-matching-siglip-baseline-owned.json",
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
        "report.json",
    }
    if {path.name for path in root.iterdir()} != expected_files:
        raise TrainerError("ordinary reference file inventory drifted")
    marker_artifacts = require_mapping(
        marker.get("artifacts"), location="ordinary reference marker.artifacts"
    )
    for file_name in expected_files - {".font-matching-siglip-baseline-owned.json"}:
        path = root / file_name
        if (
            path.is_symlink()
            or not path.is_file()
            or marker_artifacts.get(file_name) != sha256_file(path)
        ):
            raise TrainerError(f"ordinary reference artifact {file_name} hash mismatch")

    contract_path = root / "model-contract.json"
    report_path = root / "report.json"
    checkpoint_path = root / "checkpoint.safetensors"
    contract = _read_json(contract_path, location="ordinary reference model contract")
    report = _read_json(report_path, location="ordinary reference training report")
    validate_record_seal(contract, location="ordinary reference model contract")
    validate_record_seal(report, location="ordinary reference training report")
    if contract.get("schema_version") != MODEL_CONTRACT_SCHEMA_VERSION:
        raise TrainerError("ordinary reference model contract schema is unsupported")
    if report.get("schema_version") != REPORT_SCHEMA_VERSION:
        raise TrainerError("ordinary reference training report schema is unsupported")
    if (
        contract.get("record_type") != "font_matching_siglip_model_contract"
        or report.get("record_type") != "font_matching_siglip_training_report"
    ):
        raise TrainerError("ordinary reference record type is unsupported")
    catalog_assets.require_sha256(
        contract.get("code_sha256"), location="ordinary reference code_sha256"
    )
    if report.get("model_contract_sha256") != sha256_file(contract_path):
        raise TrainerError("ordinary reference report/model contract binding failed")
    source_inputs = require_mapping(
        contract.get("inputs"), location="ordinary reference model contract.inputs"
    )
    if report.get("input_hashes") != source_inputs:
        raise TrainerError("ordinary reference report input binding drifted")

    report_artifacts = require_mapping(
        report.get("artifacts"), location="ordinary reference report.artifacts"
    )
    for file_name in (
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
    ):
        path = root / file_name
        descriptor = require_mapping(
            report_artifacts.get(file_name),
            location=f"ordinary reference report.artifacts.{file_name}",
        )
        if (
            descriptor.get("file") != file_name
            or descriptor.get("sha256") != sha256_file(path)
            or descriptor.get("byte_size") != path.stat().st_size
        ):
            raise TrainerError(
                f"ordinary reference report artifact {file_name} drifted"
            )

    checks = require_mapping(
        report.get("checks"), location="ordinary reference report.checks"
    )
    if (
        checks.get("test_pixels_opened_or_cached") != 0
        or checks.get("synthetic_or_qa_inputs") != 0
        or checks.get("encoder_fully_frozen") is not True
        or checks.get("candidate_id_classifier_parameters") != 0
        or checks.get("prediction_semantics_from_model_heads") is not True
    ):
        raise TrainerError("ordinary reference has unsafe training/test provenance")
    optional_test_use = checks.get(
        "test_rows_used_for_optimizer_calibration_prototypes_or_hard_negatives"
    )
    if optional_test_use not in {None, 0}:
        raise TrainerError("ordinary reference used test rows during development")

    if contract.get("preprocessing") != ENCODER_PREPROCESSING_CONTRACT:
        raise TrainerError("ordinary reference preprocessing is incompatible")
    expected_encoder = {
        "class": ENCODER_CLASS,
        "fully_frozen": True,
        "model_id": ENCODER_ID,
        "optimizer_parameter_overlap": 0,
        "revision": ENCODER_REVISION,
        "use_fast": PROCESSOR_USE_FAST,
    }
    if contract.get("encoder") != expected_encoder:
        raise TrainerError("ordinary reference encoder is incompatible")
    architecture = require_mapping(
        contract.get("architecture"),
        location="ordinary reference model contract.architecture",
    )
    expected_semantic_heads = {
        "none": "binary_logit",
        "role": "categorical",
        "source_style": "ten-sigmoid-masked-regression",
        "treatment": "five-categorical-heads",
    }
    if (
        architecture.get("candidate_scoring")
        != (
            "three-view-gated-concat-projection-to-prototype-dot-"
            "conditional-logmeanexp-bag-v1"
        )
        or architecture.get("feature_dim") != int(cache.sample_features.shape[-1])
        or architecture.get("hidden_dim") != hyperparameters.hidden_dim
        or architecture.get("semantic_heads") != expected_semantic_heads
        or architecture.get("view_dropout") != hyperparameters.view_dropout
    ):
        raise TrainerError("ordinary reference ranker architecture is incompatible")
    prior_hyperparameters = require_mapping(
        contract.get("hyperparameters"),
        location="ordinary reference model contract.hyperparameters",
    )
    current_hyperparameters = hyperparameters.as_dict()
    for field_name in ("hidden_dim", "head_dropout", "view_dropout"):
        if prior_hyperparameters.get(field_name) != current_hyperparameters[field_name]:
            raise TrainerError(
                f"ordinary reference hyperparameter {field_name} is incompatible"
            )
    vocabulary = require_mapping(
        contract.get("vocabulary"),
        location="ordinary reference model contract.vocabulary",
    )
    raw_prior_candidates = require_list(
        vocabulary.get("candidate_ids"),
        location="ordinary reference vocabulary.candidate_ids",
    )
    prior_candidates = tuple(
        require_text(
            value,
            location=f"ordinary reference vocabulary.candidate_ids[{index}]",
        )
        for index, value in enumerate(raw_prior_candidates)
    )
    if (
        not prior_candidates
        or len(prior_candidates) != len(set(prior_candidates))
        or vocabulary.get("candidate_parameterization")
        != "prototype-bag-only-no-id-embedding-or-bias"
        or vocabulary.get("roles") != list(ROLE_VALUES)
        or vocabulary.get("style_fields") != list(STYLE_FIELDS)
        or vocabulary.get("treatments")
        != {field: list(values) for field, values in TREATMENT_VALUES.items()}
    ):
        raise TrainerError(
            "ordinary reference head/vocabulary contract is incompatible"
        )
    genre_contract = require_mapping(
        contract.get("genre_contract"),
        location="ordinary reference model contract.genre_contract",
    )
    if (
        genre_contract.get("genre_feature_present") is not False
        or genre_contract.get("no_genre_and_swapped_genre_equal_default") is not True
    ):
        raise TrainerError("ordinary reference contains an incompatible genre feature")

    checkpoint = require_mapping(
        contract.get("checkpoint"),
        location="ordinary reference model contract.checkpoint",
    )
    checkpoint_sha = sha256_file(checkpoint_path)
    metadata = load_checkpoint_metadata(checkpoint_path)
    if (
        checkpoint.get("file") != checkpoint_path.name
        or checkpoint.get("sha256") != checkpoint_sha
        or checkpoint.get("metadata") != metadata
        or metadata.get("encoder") != ENCODER_ID
        or metadata.get("encoder_revision") != ENCODER_REVISION
        or metadata.get("format") != TRAINER_SCHEMA_VERSION
    ):
        raise TrainerError("ordinary reference checkpoint binding is incompatible")
    for metadata_key in (
        "font_signal_audit_ledger_sha256",
        "font_signal_audit_report_sha256",
    ):
        catalog_assets.require_sha256(
            metadata.get(metadata_key),
            location=f"ordinary reference checkpoint.metadata.{metadata_key}",
        )
    prior_feature_cache = require_mapping(
        contract.get("feature_cache"),
        location="ordinary reference model contract.feature_cache",
    )
    for cache_key in ("manifest_sha256", "processor_config_sha256"):
        catalog_assets.require_sha256(
            prior_feature_cache.get(cache_key),
            location=f"ordinary reference feature_cache.{cache_key}",
        )
    state = load_checkpoint(checkpoint_path)
    if checkpoint.get("state_contract") != _state_contract(state):
        raise TrainerError("ordinary reference checkpoint tensor contract drifted")
    compatibility_model = build_ranker(
        feature_dim=int(cache.sample_features.shape[-1]),
        hidden_dim=hyperparameters.hidden_dim,
        view_dropout=hyperparameters.view_dropout,
        head_dropout=hyperparameters.head_dropout,
    )
    try:
        compatibility_model.load_state_dict(dict(state), strict=True)
    except (RuntimeError, KeyError, ValueError) as error:
        raise TrainerError(
            f"ordinary reference checkpoint head dimensions are incompatible: {error}"
        ) from error
    binding = {
        "checkpoint_sha256": checkpoint_sha,
        "compatible_hyperparameter_fields": [
            "hidden_dim",
            "head_dropout",
            "view_dropout",
        ],
        "evaluation_inputs": "current_val_features_and_current_candidate_prototypes",
        "model_contract_sha256": sha256_file(contract_path),
        "optimizer_seed_allowed": False,
        "output_marker_sha256": sha256_file(_output_marker_path(root)),
        "reference_output": str(root),
        "report_sha256": sha256_file(report_path),
        "source_candidate_count": len(prior_candidates),
        "source_code_sha256": contract["code_sha256"],
        "source_inputs_sha256": sha256_bytes(canonical_json(source_inputs).encode()),
        "training_only_hyperparameters_allowed_to_differ": [
            "batch_size",
            "epochs",
            "learning_rate",
            "loss_weights",
            "patience",
            "seed",
            "weight_decay",
        ],
        "successor_export_catalog_render_bank_allowed": True,
        "test_pixels_opened_from_reference": 0,
        "usage": "evaluation_only_ordinary_regression_baseline",
    }
    return OrdinaryReference(root=root, state=state, binding=binding)


def _input_contract(
    *,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    corpus: TrainingCorpus,
    asset_validation_report_sha256: str | None,
) -> dict[str, Any]:
    return {
        "asset_validation_report_sha256": asset_validation_report_sha256,
        "catalog_registry_sha256": resolver.registry_sha256,
        "chapter_pairs": copy.deepcopy(dict(corpus.chapter_pair_contract)),
        "font_signal_audit": corpus.font_signal_audit.input_binding(),
        "font_catalog_sha256": corpus.font_catalog_sha256,
        "font_prototypes_sha256": corpus.prototype_sha256,
        "listwise_sha256": corpus.listwise_sha256,
        "pairwise_sha256": corpus.pairwise_sha256,
        "render_bank_manifest_sha256": render_bank.manifest_sha256,
        "render_specification_sha256": render_bank.specification_sha256,
        "retrieval_sha256": corpus.retrieval_sha256,
        "samples_sha256": corpus.export.samples_sha256,
        "training_export_manifest_sha256": corpus.export.manifest_sha256,
    }


def _vocabulary_contract(candidate_ids: Sequence[str]) -> dict[str, Any]:
    return {
        "candidate_ids": list(candidate_ids),
        "candidate_parameterization": "prototype-bag-only-no-id-embedding-or-bias",
        "roles": list(ROLE_VALUES),
        "style_fields": list(STYLE_FIELDS),
        "treatments": {
            field: list(values) for field, values in TREATMENT_VALUES.items()
        },
    }


def _artifact_file_descriptor(path: Path) -> dict[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }


def _load_evaluator() -> Any:
    path = Path(__file__).resolve().with_name("evaluate_font_matching_v2.py")
    specification = importlib.util.spec_from_file_location(
        "font_matching_v2_evaluator_for_siglip", path
    )
    if specification is None or specification.loader is None:
        raise TrainerError("could not load font-matching evaluator")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def validate_predictions_with_evaluator(
    *, prediction_path: Path, export_root: Path
) -> None:
    evaluator = _load_evaluator()
    try:
        export = evaluator.load_export(
            export_root / "manifest.json",
            export_root / "samples.jsonl",
            export_root / "listwise.jsonl",
        )
        evaluator.load_predictions(
            prediction_path,
            export=export,
            evaluation_split="val",
            require_semantics=True,
        )
    except evaluator.EvaluationError as error:
        raise TrainerError(
            f"evaluator rejected validation predictions: {error}"
        ) from error


def write_training_output(
    *,
    output_dir: Path,
    replace_owned_output: bool,
    model: Any,
    bindings: Sequence[PredictionBinding],
    inference: InferenceOutput,
    calibration: Calibration,
    cache: FeatureCache,
    cache_status: str,
    corpus: TrainingCorpus,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    hyperparameters: TrainingHyperparameters,
    training_summary: Mapping[str, Any],
    asset_validation_report_sha256: str | None,
) -> Mapping[str, Any]:
    root = _assert_safe_directory_target(output_dir, label="baseline output")
    if root.exists() and not replace_owned_output:
        raise TrainerError(
            "baseline output exists; pass --replace-owned-output after validation"
        )
    if root.exists():
        _validate_output_ownership(root)
    root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{root.name}.staging-", dir=root.parent))
    try:
        checkpoint_path = staging / "checkpoint.safetensors"
        checkpoint_sha, state_contract = save_checkpoint(
            model,
            checkpoint_path,
            font_signal_audit=corpus.font_signal_audit,
        )
        prediction_rows = build_prediction_rows(
            bindings=bindings,
            inference=inference,
            candidate_ids=corpus.candidate_ids,
            font_catalog_sha256=corpus.font_catalog_sha256,
            training_export_manifest_sha256=corpus.export.manifest_sha256,
            checkpoint_sha256=checkpoint_sha,
            calibration=calibration,
        )
        predictions_path = staging / "predictions-val.jsonl"
        _write_file_atomic(predictions_path, prediction_jsonl_bytes(prediction_rows))
        validate_predictions_with_evaluator(
            prediction_path=predictions_path, export_root=corpus.export.root
        )
        model_contract = seal_record(
            {
                "architecture": {
                    "candidate_scoring": (
                        "three-view-gated-concat-projection-to-prototype-dot-"
                        "conditional-logmeanexp-bag-v1"
                    ),
                    "feature_dim": int(cache.sample_features.shape[-1]),
                    "hidden_dim": hyperparameters.hidden_dim,
                    "semantic_heads": {
                        "none": "binary_logit",
                        "role": "categorical",
                        "source_style": "ten-sigmoid-masked-regression",
                        "treatment": "five-categorical-heads",
                    },
                    "train_only_objectives": {
                        "chapter_anchor_consistency": "jensen_shannon_distribution",
                        "local_override": "acceptable_mass_margin",
                        "priority_sampler_target_mix": {
                            str(priority): share
                            for priority, share in sorted(PRIORITY_TARGET_MIX.items())
                        },
                    },
                    "view_dropout": hyperparameters.view_dropout,
                },
                "best_epoch": training_summary["best_epoch"],
                "calibration": calibration.as_dict(),
                "checkpoint": {
                    "file": checkpoint_path.name,
                    "metadata": _expected_checkpoint_metadata(corpus.font_signal_audit),
                    "sha256": checkpoint_sha,
                    "state_contract": state_contract,
                },
                "code_sha256": sha256_file(Path(__file__).resolve()),
                "encoder": {
                    "class": ENCODER_CLASS,
                    "fully_frozen": True,
                    "model_id": ENCODER_ID,
                    "optimizer_parameter_overlap": 0,
                    "revision": ENCODER_REVISION,
                    "use_fast": PROCESSOR_USE_FAST,
                },
                "feature_cache": {
                    "manifest_sha256": cache.manifest_sha256,
                    "processor_config_sha256": cache.manifest[
                        "processor_config_sha256"
                    ],
                },
                "genre_contract": {
                    "genre_feature_present": False,
                    "no_genre_and_swapped_genre_equal_default": True,
                },
                "hyperparameters": hyperparameters.as_dict(),
                "inputs": _input_contract(
                    resolver=resolver,
                    render_bank=render_bank,
                    corpus=corpus,
                    asset_validation_report_sha256=asset_validation_report_sha256,
                ),
                "ordinary_regression_safety": copy.deepcopy(
                    training_summary.get("checkpoint_selection")
                ),
                "preprocessing": copy.deepcopy(dict(ENCODER_PREPROCESSING_CONTRACT)),
                "record_type": "font_matching_siglip_model_contract",
                "schema_version": MODEL_CONTRACT_SCHEMA_VERSION,
                "vocabulary": _vocabulary_contract(corpus.candidate_ids),
            }
        )
        contract_path = staging / "model-contract.json"
        contract_payload = json_bytes(model_contract, pretty=True)
        _write_file_atomic(contract_path, contract_payload)
        report = seal_record(
            {
                "artifacts": {
                    checkpoint_path.name: _artifact_file_descriptor(checkpoint_path),
                    contract_path.name: _artifact_file_descriptor(contract_path),
                    predictions_path.name: _artifact_file_descriptor(predictions_path),
                },
                "cache_status": cache_status,
                "calibration": calibration.as_dict(),
                "checks": {
                    "candidate_id_classifier_parameters": 0,
                    "chapter_pair_test_rows_used": 0,
                    "encoder_fully_frozen": True,
                    "genre_counterfactual_decision_drop": 0.0,
                    "prediction_semantics_from_model_heads": True,
                    "synthetic_or_qa_inputs": 0,
                    "test_pixels_opened_or_cached": 0,
                    "test_rows_used_for_optimizer_calibration_prototypes_or_hard_negatives": 0,
                    "train_split_used_for_optimizer": True,
                    "val_split_used_for_calibration_and_early_stop": True,
                },
                "input_hashes": _input_contract(
                    resolver=resolver,
                    render_bank=render_bank,
                    corpus=corpus,
                    asset_validation_report_sha256=asset_validation_report_sha256,
                ),
                "model_contract_sha256": sha256_bytes(contract_payload),
                "record_type": "font_matching_siglip_training_report",
                "schema_version": REPORT_SCHEMA_VERSION,
                "semantic_data_caveats": semantic_caveat_summary(corpus),
                "training": copy.deepcopy(dict(training_summary)),
                "validation_prediction_count": len(prediction_rows),
            }
        )
        report_path = staging / "report.json"
        report_payload = json_bytes(report, pretty=True)
        _write_file_atomic(report_path, report_payload)
        marker = {
            "artifacts": {
                checkpoint_path.name: sha256_file(checkpoint_path),
                contract_path.name: sha256_file(contract_path),
                predictions_path.name: sha256_file(predictions_path),
                report_path.name: sha256_file(report_path),
            },
            "owner": OUTPUT_OWNER,
            "safe_replace": True,
            "schema_version": TRAINER_SCHEMA_VERSION,
        }
        _write_file_atomic(
            _output_marker_path(staging), json_bytes(marker, pretty=True)
        )
        _commit_managed_directory(
            staging=staging,
            target=root,
            owner_validator=_validate_output_ownership if root.exists() else None,
        )
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return validate_training_output(
        output_dir=root,
        corpus=corpus,
        resolver=resolver,
        render_bank=render_bank,
        cache=cache,
        asset_validation_report_sha256=asset_validation_report_sha256,
    )


def _validate_ordinary_regression_safety(value: Any) -> None:
    if value is None:
        # Kept only for direct legacy writer fixtures. The train CLI always emits
        # a complete checkpoint-selection safety contract.
        return
    safety = require_mapping(value, location="ordinary regression safety")
    status = require_text(
        safety.get("baseline_status"),
        location="ordinary regression safety.baseline_status",
    )
    if status not in {
        "non_production_safety_baseline",
        "production_same_input_resume_reference",
        "production_reference",
    }:
        raise TrainerError("ordinary regression safety status is unsupported")
    if (
        safety.get("ordinary_acceptable_at_1_regression_limit")
        != ORDINARY_TOP1_REGRESSION_LIMIT
        or safety.get("optimizer_seeded_from_ordinary_reference") is not False
        or safety.get("ordinary_reference_argument_seeded_optimizer") is not False
        or safety.get("resume_requires_separate_resume_from_argument") is not True
    ):
        raise TrainerError("ordinary regression safety gate contract drifted")
    gate = require_mapping(
        safety.get("best_ordinary_regression_gate"),
        location="ordinary regression safety.best_ordinary_regression_gate",
    )
    if gate.get("passed") is not True:
        raise TrainerError("sealed checkpoint did not pass its ordinary safety gate")
    reference = safety.get("reference")
    if status == "production_reference":
        reference_row = require_mapping(
            reference, location="ordinary regression safety.reference"
        )
        for key in (
            "checkpoint_sha256",
            "model_contract_sha256",
            "output_marker_sha256",
            "report_sha256",
            "source_code_sha256",
            "source_inputs_sha256",
        ):
            catalog_assets.require_sha256(
                reference_row.get(key),
                location=f"ordinary regression safety.reference.{key}",
            )
        if (
            reference_row.get("optimizer_seed_allowed") is not False
            or reference_row.get("test_pixels_opened_from_reference") != 0
            or reference_row.get("usage")
            != "evaluation_only_ordinary_regression_baseline"
        ):
            raise TrainerError("ordinary reference safety binding is unsafe")
        if gate.get("applicable") is not True:
            raise TrainerError("ordinary reference safety gate was not applicable")
    elif reference is not None:
        raise TrainerError(
            "non-reference ordinary baseline unexpectedly binds a source"
        )


def validate_training_output(
    *,
    output_dir: Path,
    corpus: TrainingCorpus,
    resolver: catalog_assets.CatalogAssetResolver,
    render_bank: catalog_assets.RenderBankSnapshot,
    cache: FeatureCache,
    asset_validation_report_sha256: str | None,
) -> Mapping[str, Any]:
    root = _assert_safe_directory_target(output_dir, label="baseline output")
    if not root.is_dir():
        raise TrainerError(f"baseline output does not exist: {root}")
    marker = _validate_output_ownership(root)
    expected_files = {
        ".font-matching-siglip-baseline-owned.json",
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
        "report.json",
    }
    if {path.name for path in root.iterdir()} != expected_files:
        raise TrainerError("baseline output file inventory drifted")
    artifacts = require_mapping(
        marker.get("artifacts"), location="output marker.artifacts"
    )
    for file_name in expected_files - {".font-matching-siglip-baseline-owned.json"}:
        path = root / file_name
        if (
            path.is_symlink()
            or not path.is_file()
            or sha256_file(path) != artifacts.get(file_name)
        ):
            raise TrainerError(f"baseline output artifact {file_name} hash mismatch")
    contract_path = root / "model-contract.json"
    report_path = root / "report.json"
    contract = _read_json(contract_path, location="model contract")
    report = _read_json(report_path, location="training report")
    validate_record_seal(contract, location="model contract")
    validate_record_seal(report, location="training report")
    if contract.get("schema_version") != MODEL_CONTRACT_SCHEMA_VERSION:
        raise TrainerError("model contract schema is unsupported")
    if report.get("schema_version") != REPORT_SCHEMA_VERSION:
        raise TrainerError("training report schema is unsupported")
    if contract.get("code_sha256") != sha256_file(Path(__file__).resolve()):
        raise TrainerError("baseline output was produced by different trainer code")
    expected_inputs = _input_contract(
        resolver=resolver,
        render_bank=render_bank,
        corpus=corpus,
        asset_validation_report_sha256=asset_validation_report_sha256,
    )
    if (
        contract.get("inputs") != expected_inputs
        or report.get("input_hashes") != expected_inputs
    ):
        raise TrainerError("baseline output is bound to stale or different inputs")
    if contract.get("preprocessing") != ENCODER_PREPROCESSING_CONTRACT:
        raise TrainerError("baseline preprocessing contract drifted")
    encoder = require_mapping(
        contract.get("encoder"), location="model contract.encoder"
    )
    if encoder != {
        "class": ENCODER_CLASS,
        "fully_frozen": True,
        "model_id": ENCODER_ID,
        "optimizer_parameter_overlap": 0,
        "revision": ENCODER_REVISION,
        "use_fast": PROCESSOR_USE_FAST,
    }:
        raise TrainerError("frozen encoder pin drifted")
    if contract.get("vocabulary") != _vocabulary_contract(corpus.candidate_ids):
        raise TrainerError("model vocabulary/candidate contract drifted")
    feature_cache = require_mapping(
        contract.get("feature_cache"), location="model contract.feature_cache"
    )
    if feature_cache.get("manifest_sha256") != cache.manifest_sha256:
        raise TrainerError("model contract is bound to another feature cache")
    checkpoint_path = root / "checkpoint.safetensors"
    checkpoint = require_mapping(
        contract.get("checkpoint"), location="model contract.checkpoint"
    )
    if (
        checkpoint.get("sha256") != sha256_file(checkpoint_path)
        or checkpoint.get("file") != checkpoint_path.name
        or checkpoint.get("metadata")
        != _expected_checkpoint_metadata(corpus.font_signal_audit)
        or load_checkpoint_metadata(checkpoint_path)
        != _expected_checkpoint_metadata(corpus.font_signal_audit)
    ):
        raise TrainerError("model contract checkpoint binding failed")
    state = load_checkpoint(checkpoint_path)
    if checkpoint.get("state_contract") != _state_contract(state):
        raise TrainerError("checkpoint tensor contract drifted")
    if report.get("model_contract_sha256") != sha256_file(contract_path):
        raise TrainerError("training report/model contract hash binding failed")
    report_training = require_mapping(
        report.get("training"), location="training report.training"
    )
    if contract.get("ordinary_regression_safety") != report_training.get(
        "checkpoint_selection"
    ):
        raise TrainerError("ordinary regression safety report binding drifted")
    _validate_ordinary_regression_safety(contract.get("ordinary_regression_safety"))
    report_artifacts = require_mapping(
        report.get("artifacts"), location="training report.artifacts"
    )
    for file_name in (
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
    ):
        descriptor = require_mapping(
            report_artifacts.get(file_name),
            location=f"training report.artifacts.{file_name}",
        )
        path = root / file_name
        if (
            descriptor.get("file") != file_name
            or descriptor.get("sha256") != sha256_file(path)
            or descriptor.get("byte_size") != path.stat().st_size
        ):
            raise TrainerError(f"training report artifact {file_name} drifted")
    validate_predictions_with_evaluator(
        prediction_path=root / "predictions-val.jsonl",
        export_root=corpus.export.root,
    )
    return {
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "model_contract_sha256": sha256_file(contract_path),
        "output_dir": str(root),
        "prediction_sha256": sha256_file(root / "predictions-val.jsonl"),
        "report_sha256": sha256_file(report_path),
        "status": "valid",
    }


def validate_hyperparameters(
    hyperparameters: TrainingHyperparameters,
) -> TrainingHyperparameters:
    positive_integer_fields = (
        "hidden_dim",
        "epochs",
        "batch_size",
        "patience",
    )
    for field in positive_integer_fields:
        value = getattr(hyperparameters, field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise TrainerError(f"{field} must be a positive integer")
    if hyperparameters.seed < 0:
        raise TrainerError("seed must be non-negative")
    for field in ("learning_rate", "weight_decay"):
        value = float(getattr(hyperparameters, field))
        if (
            not math.isfinite(value)
            or value < 0.0
            or (field == "learning_rate" and value == 0.0)
        ):
            raise TrainerError(f"{field} must be finite and positive")
    for field in ("view_dropout", "head_dropout"):
        value = float(getattr(hyperparameters, field))
        if not math.isfinite(value) or not 0.0 <= value < 1.0:
            raise TrainerError(f"{field} must be finite in [0, 1)")
    loss_weights = (
        hyperparameters.listwise_weight,
        hyperparameters.pairwise_weight,
        hyperparameters.none_weight,
        hyperparameters.role_weight,
        hyperparameters.style_weight,
        hyperparameters.treatment_weight,
        hyperparameters.chapter_consistency_weight,
        hyperparameters.local_override_weight,
    )
    if any(not math.isfinite(float(value)) or value < 0.0 for value in loss_weights):
        raise TrainerError("loss weights must be finite and non-negative")
    if sum(loss_weights) <= 0.0:
        raise TrainerError("at least one loss weight must be positive")
    if (
        not math.isfinite(hyperparameters.local_override_margin)
        or not 0.0 <= hyperparameters.local_override_margin <= 1.0
    ):
        raise TrainerError("local_override_margin must be finite in [0, 1]")
    return hyperparameters


def prepare_runtime_inputs(
    *,
    catalog_registry: Path,
    training_export_dir: Path,
    render_bank_manifest: Path,
    asset_validation_report: Path | None,
    font_signal_audit_root: Path,
) -> RuntimeInputs:
    """Load sealed metadata, then scan only train/val model pixels."""

    font_signal_audit = load_font_signal_audit(font_signal_audit_root)
    try:
        resolver = catalog_assets.CatalogAssetResolver(catalog_registry)
        render_bank = catalog_assets.load_render_bank(render_bank_manifest)
        export = catalog_assets.load_training_export(
            training_export_dir,
            catalog_registry_sha256=resolver.registry_sha256,
            render_bank_manifest_sha256=render_bank.manifest_sha256,
            render_specification_sha256=render_bank.specification_sha256,
        )
    except catalog_assets.CatalogAssetError as error:
        raise TrainerError(str(error)) from error
    corpus = load_training_corpus(
        export=export,
        render_bank=render_bank,
        catalog_registry_sha256=resolver.registry_sha256,
        font_signal_audit=font_signal_audit,
    )
    asset_report_sha = validate_asset_validation_report(
        asset_validation_report,
        resolver=resolver,
        export=export,
        render_bank=render_bank,
    )
    scan = scan_model_assets(
        resolver=resolver,
        render_bank=render_bank,
        corpus=corpus,
    )
    cache_contract = build_cache_contract(
        resolver=resolver,
        render_bank=render_bank,
        corpus=corpus,
        scan=scan,
        asset_validation_report_sha256=asset_report_sha,
    )
    return RuntimeInputs(
        resolver=resolver,
        render_bank=render_bank,
        export=export,
        corpus=corpus,
        asset_validation_report_sha256=asset_report_sha,
        scan=scan,
        cache_contract=cache_contract,
    )


def load_resume_state(
    *,
    resume_dir: Path,
    runtime: RuntimeInputs,
    cache: FeatureCache,
    hyperparameters: TrainingHyperparameters,
) -> Mapping[str, Any]:
    """Validate every current binding before accepting ranker weights."""

    validate_training_output(
        output_dir=resume_dir,
        corpus=runtime.corpus,
        resolver=runtime.resolver,
        render_bank=runtime.render_bank,
        cache=cache,
        asset_validation_report_sha256=runtime.asset_validation_report_sha256,
    )
    contract = _read_json(
        resume_dir.expanduser().resolve() / "model-contract.json",
        location="resume model contract",
    )
    if contract.get("hyperparameters") != hyperparameters.as_dict():
        raise TrainerError("resume hyperparameters differ from the sealed checkpoint")
    return load_checkpoint(resume_dir.expanduser().resolve() / "checkpoint.safetensors")


def _add_common_cli_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--catalog-registry",
        type=Path,
        required=True,
        help="sealed catalog registry JSON",
    )
    parser.add_argument(
        "--training-export-dir",
        type=Path,
        required=True,
        help="sealed font-matching training export directory",
    )
    parser.add_argument(
        "--render-bank-manifest",
        type=Path,
        required=True,
        help="sealed production render-bank manifest JSON",
    )
    parser.add_argument(
        "--asset-validation-report",
        type=Path,
        help="optional sealed output from validate_font_matching_training_assets.py",
    )
    parser.add_argument(
        "--font-signal-audit-root",
        type=Path,
        required=True,
        help=(
            "sealed human font-signal audit; only unaudited or "
            "font_signal_present samples remain eligible"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="owned baseline output directory",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        help="owned feature-cache directory (default: OUTPUT-feature-cache)",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Train or validate the deterministic frozen SigLIP2 font-matching "
            "prototype ranker. Test pixels are never opened."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    train_parser = subparsers.add_parser("train", help="extract/cache and train")
    _add_common_cli_arguments(train_parser)
    train_parser.add_argument(
        "--cache-stale-policy",
        choices=("fail", "rebuild"),
        default="fail",
        help="explicit response to a stale or corrupt owned cache",
    )
    train_parser.add_argument(
        "--replace-owned-output",
        action="store_true",
        help="atomically replace an existing output owned by this trainer",
    )
    train_parser.add_argument(
        "--resume-from",
        type=Path,
        help="validated owned baseline output whose ranker weights seed training",
    )
    train_parser.add_argument(
        "--ordinary-reference-from",
        type=Path,
        help=(
            "validated owned prior output used only to score the current val split "
            "for the ordinary Acceptable@1 regression floor; never seeds optimizer"
        ),
    )
    train_parser.add_argument(
        "--encoder-device", choices=("auto", "cpu", "cuda"), default="auto"
    )
    train_parser.add_argument(
        "--encoder-fp16",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="allow fp16 autocast for CUDA feature extraction only",
    )
    train_parser.add_argument(
        "--ranker-device", choices=("auto", "cpu", "cuda"), default="auto"
    )
    train_parser.add_argument("--feature-batch-size", type=int, default=64)
    train_parser.add_argument("--seed", type=int, default=20260801)
    train_parser.add_argument("--hidden-dim", type=int, default=256)
    train_parser.add_argument("--epochs", type=int, default=40)
    train_parser.add_argument("--batch-size", type=int, default=64)
    train_parser.add_argument("--learning-rate", type=float, default=3e-4)
    train_parser.add_argument("--weight-decay", type=float, default=1e-4)
    train_parser.add_argument("--patience", type=int, default=7)
    train_parser.add_argument("--view-dropout", type=float, default=0.15)
    train_parser.add_argument("--head-dropout", type=float, default=0.1)
    train_parser.add_argument("--listwise-weight", type=float, default=1.0)
    train_parser.add_argument("--pairwise-weight", type=float, default=0.5)
    train_parser.add_argument("--none-weight", type=float, default=0.5)
    train_parser.add_argument("--role-weight", type=float, default=0.35)
    train_parser.add_argument("--style-weight", type=float, default=0.25)
    train_parser.add_argument("--treatment-weight", type=float, default=0.25)
    train_parser.add_argument("--chapter-consistency-weight", type=float, default=0.2)
    train_parser.add_argument("--local-override-weight", type=float, default=0.2)
    train_parser.add_argument("--local-override-margin", type=float, default=0.15)

    validate_parser = subparsers.add_parser(
        "validate", help="revalidate cache, checkpoint, contract, and predictions"
    )
    _add_common_cli_arguments(validate_parser)
    return parser


def _cache_dir_from_args(args: argparse.Namespace) -> Path:
    if args.cache_dir is not None:
        return args.cache_dir
    output = args.output_dir.expanduser()
    return output.with_name(f"{output.name}-feature-cache")


def _hyperparameters_from_args(args: argparse.Namespace) -> TrainingHyperparameters:
    return validate_hyperparameters(
        TrainingHyperparameters(
            seed=args.seed,
            hidden_dim=args.hidden_dim,
            epochs=args.epochs,
            batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            weight_decay=args.weight_decay,
            patience=args.patience,
            view_dropout=args.view_dropout,
            head_dropout=args.head_dropout,
            listwise_weight=args.listwise_weight,
            pairwise_weight=args.pairwise_weight,
            none_weight=args.none_weight,
            role_weight=args.role_weight,
            style_weight=args.style_weight,
            treatment_weight=args.treatment_weight,
            chapter_consistency_weight=args.chapter_consistency_weight,
            local_override_weight=args.local_override_weight,
            local_override_margin=args.local_override_margin,
        )
    )


def run_train(args: argparse.Namespace) -> Mapping[str, Any]:
    if args.feature_batch_size < 1:
        raise TrainerError("feature_batch_size must be positive")
    hyperparameters = _hyperparameters_from_args(args)
    # This must precede the first CUDA encoder call; train_ranker reseeds again
    # so cache reuse/build take the same deterministic training path.
    seed_everything(hyperparameters.seed)
    runtime = prepare_runtime_inputs(
        catalog_registry=args.catalog_registry,
        training_export_dir=args.training_export_dir,
        render_bank_manifest=args.render_bank_manifest,
        asset_validation_report=args.asset_validation_report,
        font_signal_audit_root=args.font_signal_audit_root,
    )
    cache, cache_status = get_or_build_feature_cache(
        cache_dir=_cache_dir_from_args(args),
        contract=runtime.cache_contract,
        scan=runtime.scan,
        resolver=runtime.resolver,
        render_bank=runtime.render_bank,
        corpus=runtime.corpus,
        stale_policy=args.cache_stale_policy,
        image_batch_size=args.feature_batch_size,
        extractor_factory=lambda: FrozenSiglipExtractor(
            device=args.encoder_device,
            fp16=args.encoder_fp16,
        ),
    )
    resume_state = None
    if args.resume_from is not None:
        resume_state = load_resume_state(
            resume_dir=args.resume_from,
            runtime=runtime,
            cache=cache,
            hyperparameters=hyperparameters,
        )
    ordinary_reference = None
    if args.ordinary_reference_from is not None:
        if (
            args.ordinary_reference_from.expanduser().resolve()
            == args.output_dir.expanduser().resolve()
        ):
            raise TrainerError(
                "ordinary reference must not be the output directory being replaced"
            )
        ordinary_reference = load_ordinary_reference(
            output_dir=args.ordinary_reference_from,
            cache=cache,
            hyperparameters=hyperparameters,
        )
    model, training_summary = train_ranker(
        cache=cache,
        corpus=runtime.corpus,
        hyperparameters=hyperparameters,
        device=args.ranker_device,
        resume_state=resume_state,
        ordinary_reference=ordinary_reference,
    )
    ranker_device = require_text(
        training_summary.get("ranker_device"),
        location="training_summary.ranker_device",
    )
    bindings, inference = infer_split(
        model=model,
        cache=cache,
        corpus=runtime.corpus,
        split="val",
        device=ranker_device,
        batch_size=hyperparameters.batch_size,
    )
    calibration = calibrate_on_validation(
        inference=inference,
        examples=runtime.corpus.examples_for_split("val"),
    )
    training_summary = {
        **dict(training_summary),
        "calibrated_none_metrics": compute_none_metrics(
            none_logits=inference.none_logits,
            examples=runtime.corpus.examples_for_split("val"),
            threshold=calibration.none_threshold,
        ),
    }
    result = write_training_output(
        output_dir=args.output_dir,
        replace_owned_output=args.replace_owned_output,
        model=model,
        bindings=bindings,
        inference=inference,
        calibration=calibration,
        cache=cache,
        cache_status=cache_status,
        corpus=runtime.corpus,
        resolver=runtime.resolver,
        render_bank=runtime.render_bank,
        hyperparameters=hyperparameters,
        training_summary=training_summary,
        asset_validation_report_sha256=runtime.asset_validation_report_sha256,
    )
    return {
        **result,
        "cache_dir": str(cache.root),
        "cache_status": cache_status,
        "test_pixels_opened_or_cached": 0,
    }


def run_validate(args: argparse.Namespace) -> Mapping[str, Any]:
    runtime = prepare_runtime_inputs(
        catalog_registry=args.catalog_registry,
        training_export_dir=args.training_export_dir,
        render_bank_manifest=args.render_bank_manifest,
        asset_validation_report=args.asset_validation_report,
        font_signal_audit_root=args.font_signal_audit_root,
    )
    cache = load_feature_cache(
        cache_dir=_cache_dir_from_args(args),
        expected_contract=runtime.cache_contract,
    )
    result = validate_training_output(
        output_dir=args.output_dir,
        corpus=runtime.corpus,
        resolver=runtime.resolver,
        render_bank=runtime.render_bank,
        cache=cache,
        asset_validation_report_sha256=runtime.asset_validation_report_sha256,
    )
    return {
        **result,
        "cache_dir": str(cache.root),
        "test_pixels_opened_or_cached": 0,
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run_train(args) if args.command == "train" else run_validate(args)
        print(canonical_json(result))
        return 0
    except (TrainerError, catalog_assets.CatalogAssetError, OSError) as error:
        print(canonical_json({"error": str(error), "status": "failed"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
