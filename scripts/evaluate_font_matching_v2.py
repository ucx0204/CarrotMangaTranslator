#!/usr/bin/env python3
"""Evaluate Font Matching V2 predictions against a finalized training export.

The evaluator is deliberately release-oriented.  It verifies every exported
sample/listwise record and every prediction binding before computing metrics,
evaluates exactly one work-disjoint ``val`` or frozen ``test`` split, and emits
machine-readable gates.  It never trains a model or fabricates predictions.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import random
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


EXPORT_SCHEMA_VERSION = "font-matching-training-export-v1"
SAMPLE_SCHEMA_VERSION = "font-matching-training-sample-v1"
LISTWISE_SCHEMA_VERSION = "font-matching-listwise-example-v1"
PREDICTION_SCHEMA_VERSION = "font-matching-v2-prediction-v1"
REPORT_SCHEMA_VERSION = "font-matching-v2-offline-evaluation-v1"
EXPORT_OWNER = "carrot-manga-translator/font-matching-training-export"
EXPORT_MARKER_FILE = ".font-matching-training-export-owned.json"
RANKED_TIERS = ("preferred", "acceptable", "marginal", "unacceptable")
SKIPPED_TIERS = ("unrenderable", "not_reviewed")
TIER_GAIN = {"preferred": 3, "acceptable": 2, "marginal": 1, "unacceptable": 0}
VALID_EVALUATION_SPLITS = frozenset({"val", "test"})
GENRE_VARIANTS = ("no_genre", "swapped_genre")
CORE_COHORTS = (
    "ordinary",
    "aside",
    "handwriting",
    "sfx",
    "emphasis",
    "outline",
    "inverse",
    "color",
    "horizontal",
    "vertical",
    "manual_recrop",
)
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
SELECTIVE_THRESHOLDS = (0.0, 0.5, 0.75, 0.9)
GENRE_REMOVAL_MAX_DROP = 0.03
GENRE_SWAP_MAX_DROP = 0.05
CORE_COHORT_MAX_REGRESSION = 0.03
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class EvaluationError(ValueError):
    """Raised when inputs cannot support a leakage-safe evaluation."""


@dataclass(frozen=True)
class Target:
    sample_id: str
    work_id: str
    split: str
    sample_record_sha256: str
    listwise_record_sha256: str
    role: str
    source_style: Mapping[str, Any]
    treatment: Mapping[str, Any]
    consistency_reason: str
    cohorts: tuple[str, ...]
    judgment: Mapping[str, Any]
    gains: Mapping[str, int | None]
    loss_eligible: frozenset[str]
    candidate_ids: tuple[str, ...]
    source_page_sha256: str
    sample_crop_sha256: str
    manual_recrop: bool


@dataclass(frozen=True)
class Decision:
    ranked_candidate_ids: tuple[str, ...]
    none_probability: float
    confidence: float


@dataclass(frozen=True)
class Prediction:
    sample_id: str
    work_id: str
    split: str
    decision: Decision
    variants: Mapping[str, Decision]
    role: str | None
    source_style: Mapping[str, float] | None
    treatment: Mapping[str, str] | None


@dataclass(frozen=True)
class PredictionSet:
    path_sha256: str
    model_id: str
    model_sha256: str
    predictions: Mapping[str, Prediction]
    available_variants: tuple[str, ...]


@dataclass(frozen=True)
class ExportData:
    manifest_sha256: str
    font_catalog_sha256: str
    targets: Mapping[str, Target]
    candidate_ids: tuple[str, ...]
    work_split: Mapping[str, str]
    input_hashes: Mapping[str, Any]


@dataclass(frozen=True)
class SampleScore:
    sample_id: str
    work_id: str
    split: str
    role: str
    cohorts: tuple[str, ...]
    rankable: bool
    preferred_at_1: float | None
    acceptable_at_1: float | None
    acceptable_at_3: float | None
    ndcg: float | None
    pairwise_correct: int
    pairwise_total: int
    truth_none: bool
    predicted_none: bool
    decision_correct: bool
    confidence: float
    role_correct: float | None
    style_absolute_errors: tuple[tuple[str, float], ...]
    treatment_correct: tuple[tuple[str, float], ...]


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise EvaluationError(f"could not read {path}: {error}") from error
    with handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(
        json.dumps(
            output, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )
    return output


def validate_seal(record: Mapping[str, Any], location: str) -> str:
    declared = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    expected = sha256_bytes(
        json.dumps(
            core, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )
    if declared != expected:
        raise EvaluationError(f"{location}: record hash binding failed")
    return declared


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvaluationError(f"{location}: expected an object")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvaluationError(f"{location}: expected a non-empty string")
    return value


def require_sha(value: Any, location: str) -> str:
    output = require_text(value, location)
    if SHA_RE.fullmatch(output) is None:
        raise EvaluationError(f"{location}: expected a lowercase SHA-256")
    return output


def require_probability(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvaluationError(f"{location}: expected a probability")
    output = float(value)
    if not math.isfinite(output) or output < 0.0 or output > 1.0:
        raise EvaluationError(f"{location}: probability must be finite in [0, 1]")
    return output


def require_unique_text_list(value: Any, location: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise EvaluationError(f"{location}: expected an array")
    output = tuple(
        require_text(item, f"{location}[{index}]") for index, item in enumerate(value)
    )
    if len(output) != len(set(output)):
        raise EvaluationError(f"{location}: duplicates are forbidden")
    return output


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvaluationError(f"{location}: could not read JSON: {error}") from error
    return dict(require_mapping(value, location))


def read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as error:
        raise EvaluationError(f"{location}: could not read JSONL: {error}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise EvaluationError(
                    f"{location}:{line_number}: invalid JSON: {error}"
                ) from error
            rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    return rows


def count_jsonl(path: Path) -> int:
    try:
        handle = path.open("rb")
    except OSError as error:
        raise EvaluationError(f"could not read {path}: {error}") from error
    with handle:
        return sum(1 for line in handle if line.strip())


def validate_artifact(
    manifest: Mapping[str, Any], path: Path, artifact_name: str
) -> None:
    artifacts = require_mapping(manifest.get("artifacts"), "manifest.artifacts")
    descriptor = require_mapping(
        artifacts.get(artifact_name), f"manifest.artifacts.{artifact_name}"
    )
    if path.name != descriptor.get("file") or path.name != artifact_name:
        raise EvaluationError(
            f"{artifact_name}: supplied file name differs from manifest"
        )
    if not path.is_file():
        raise EvaluationError(f"{artifact_name}: file does not exist")
    expected_sha = require_sha(descriptor.get("sha256"), f"{artifact_name}.sha256")
    expected_count = descriptor.get("record_count")
    expected_size = descriptor.get("byte_size")
    if (
        isinstance(expected_count, bool)
        or not isinstance(expected_count, int)
        or expected_count < 0
        or isinstance(expected_size, bool)
        or not isinstance(expected_size, int)
        or expected_size < 0
    ):
        raise EvaluationError(f"{artifact_name}: invalid count/size descriptor")
    if (
        sha256_file(path) != expected_sha
        or count_jsonl(path) != expected_count
        or path.stat().st_size != expected_size
    ):
        raise EvaluationError(f"{artifact_name}: artifact hash/count/size mismatch")


def _tier_lists(
    judgment: Mapping[str, Any], location: str
) -> dict[str, tuple[str, ...]]:
    output: dict[str, tuple[str, ...]] = {}
    seen: set[str] = set()
    for tier in (*RANKED_TIERS, *SKIPPED_TIERS):
        values = require_unique_text_list(judgment.get(tier), f"{location}.{tier}")
        overlap = seen & set(values)
        if overlap:
            raise EvaluationError(f"{location}: candidates appear in multiple tiers")
        seen.update(values)
        output[tier] = values
    none = judgment.get("none_acceptable")
    if not isinstance(none, bool):
        raise EvaluationError(f"{location}.none_acceptable must be boolean")
    has_positive = bool(output["preferred"] or output["acceptable"])
    if none == has_positive:
        raise EvaluationError(f"{location}: none_acceptable semantics are invalid")
    return output


def load_export(
    manifest_path: Path, samples_path: Path, listwise_path: Path
) -> ExportData:
    manifest = read_json(manifest_path, "training export manifest")
    if manifest.get("schema_version") != EXPORT_SCHEMA_VERSION:
        raise EvaluationError("training export manifest schema is unsupported")
    manifest_sha = sha256_file(manifest_path)
    marker = read_json(
        manifest_path.parent / EXPORT_MARKER_FILE, "training export ownership marker"
    )
    if (
        marker.get("owner") != EXPORT_OWNER
        or marker.get("schema_version") != EXPORT_SCHEMA_VERSION
        or marker.get("manifest_sha256") != manifest_sha
    ):
        raise EvaluationError("training export ownership/manifest hash binding failed")
    validate_artifact(manifest, samples_path, "samples.jsonl")
    validate_artifact(manifest, listwise_path, "listwise.jsonl")
    renderer = require_mapping(manifest.get("renderer_bindings"), "renderer_bindings")
    font_catalog_sha = require_sha(
        renderer.get("font_catalog_sha256"), "renderer_bindings.font_catalog_sha256"
    )
    declared_work_split = require_mapping(manifest.get("work_split"), "work_split")

    sample_rows = read_jsonl(samples_path, "samples")
    listwise_rows = read_jsonl(listwise_path, "listwise")
    if not sample_rows:
        raise EvaluationError("training export contains no real samples")
    if manifest.get("real_sample_count") != len(sample_rows):
        raise EvaluationError("real sample count differs from training export manifest")
    samples_by_id: dict[str, dict[str, Any]] = {}
    work_split: dict[str, str] = {}
    crop_splits: dict[str, set[str]] = defaultdict(set)
    page_splits: dict[str, set[str]] = defaultdict(set)
    for index, row in enumerate(sample_rows):
        location = f"samples[{index}]"
        if row.get("schema_version") != SAMPLE_SCHEMA_VERSION:
            raise EvaluationError(f"{location}: unsupported sample schema")
        record_sha = validate_seal(row, location)
        sample_id = require_text(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in samples_by_id:
            raise EvaluationError(f"duplicate training sample {sample_id}")
        split = require_text(row.get("split"), f"{location}.split")
        if split not in {"train", "val", "test"}:
            raise EvaluationError(f"{location}: unsupported split")
        work_id = require_text(row.get("work_id"), f"{location}.work_id")
        prior = work_split.setdefault(work_id, split)
        if prior != split:
            raise EvaluationError(f"work split leakage for {work_id}: {prior}/{split}")
        if declared_work_split.get(work_id) != split:
            raise EvaluationError(
                f"{work_id}: sample split differs from export manifest"
            )
        provenance = require_mapping(row.get("provenance"), f"{location}.provenance")
        if (
            provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
        ):
            raise EvaluationError(
                f"{sample_id}: evaluation accepts real overlay-free samples only"
            )
        input_bindings = require_mapping(
            row.get("input_bindings"), f"{location}.input_bindings"
        )
        if input_bindings.get("font_catalog_sha256") != font_catalog_sha:
            raise EvaluationError(f"{sample_id}: sample/catalog hash binding mismatch")
        source = require_mapping(row.get("source"), f"{location}.source")
        crop_sha = require_sha(
            source.get("sample_crop_sha256"), f"{location}.source.sample_crop_sha256"
        )
        page_sha = require_sha(
            source.get("source_page_sha256"), f"{location}.source.source_page_sha256"
        )
        crop_splits[crop_sha].add(split)
        page_splits[page_sha].add(split)
        row["_validated_record_sha256"] = record_sha
        samples_by_id[sample_id] = row
    for name, groups in (("crop", crop_splits), ("source page", page_splits)):
        leaked = [key for key, splits in groups.items() if len(splits) > 1]
        if leaked:
            raise EvaluationError(f"{name} split leakage detected: {leaked[:8]}")
    if dict(sorted(work_split.items())) != dict(sorted(declared_work_split.items())):
        raise EvaluationError("manifest work_split contains missing or extra works")

    listwise_by_id: dict[str, dict[str, Any]] = {}
    global_candidates: tuple[str, ...] | None = None
    for index, row in enumerate(listwise_rows):
        location = f"listwise[{index}]"
        if row.get("schema_version") != LISTWISE_SCHEMA_VERSION:
            raise EvaluationError(f"{location}: unsupported listwise schema")
        validate_seal(row, location)
        sample_id = require_text(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in listwise_by_id:
            raise EvaluationError(f"duplicate listwise target {sample_id}")
        targets_value = row.get("candidate_targets")
        if not isinstance(targets_value, list) or not targets_value:
            raise EvaluationError(f"{location}.candidate_targets must be non-empty")
        candidates = tuple(
            require_text(
                require_mapping(
                    value, f"{location}.candidate_targets[{target_index}]"
                ).get("candidate_id"),
                f"{location}.candidate_targets[{target_index}].candidate_id",
            )
            for target_index, value in enumerate(targets_value)
        )
        if len(candidates) != len(set(candidates)):
            raise EvaluationError(f"{location}: duplicate candidate target")
        if global_candidates is None:
            global_candidates = tuple(sorted(candidates))
        elif set(global_candidates) != set(candidates):
            raise EvaluationError("listwise rows use different candidate catalogs")
        listwise_by_id[sample_id] = row
    if set(samples_by_id) != set(listwise_by_id):
        raise EvaluationError("samples/listwise target inventories differ")
    assert global_candidates is not None
    declared_candidate_count = manifest.get("candidate_count")
    if declared_candidate_count != len(global_candidates):
        raise EvaluationError("candidate count differs from training export manifest")

    targets: dict[str, Target] = {}
    for sample_id in sorted(samples_by_id):
        sample = samples_by_id[sample_id]
        listwise = listwise_by_id[sample_id]
        if (
            listwise.get("training_sample_record_sha256")
            != sample["_validated_record_sha256"]
            or listwise.get("work_id") != sample.get("work_id")
            or listwise.get("split") != sample.get("split")
        ):
            raise EvaluationError(f"{sample_id}: listwise/sample binding mismatch")
        judgment = require_mapping(
            sample.get("font_judgment"), f"{sample_id}.font_judgment"
        )
        tier_values = _tier_lists(judgment, f"{sample_id}.font_judgment")
        if tier_values["not_reviewed"]:
            raise EvaluationError(f"{sample_id}: evaluation label is incomplete")
        partition = {item for values in tier_values.values() for item in values}
        if partition != set(global_candidates):
            raise EvaluationError(f"{sample_id}: judgment does not partition catalog")
        gains: dict[str, int | None] = {}
        eligible: set[str] = set()
        targets_value = listwise["candidate_targets"]
        if {value["candidate_id"] for value in targets_value} != set(global_candidates):
            raise EvaluationError(f"{sample_id}: incomplete listwise catalog")
        tier_by_candidate = {
            candidate: tier
            for tier, values in tier_values.items()
            for candidate in values
        }
        for value in targets_value:
            candidate = str(value["candidate_id"])
            tier = tier_by_candidate[candidate]
            expected_eligible = tier in RANKED_TIERS
            expected_gain = TIER_GAIN[tier] if expected_eligible else None
            if (
                value.get("tier") != tier
                or value.get("loss_eligible") is not expected_eligible
                or value.get("relevance_gain") != expected_gain
            ):
                raise EvaluationError(f"{sample_id}: listwise gain/tier mismatch")
            gains[candidate] = expected_gain
            if expected_eligible:
                eligible.add(candidate)
        role = require_text(
            require_mapping(sample.get("role"), f"{sample_id}.role").get("primary"),
            f"{sample_id}.role.primary",
        )
        source_style = require_mapping(
            sample.get("source_style"), f"{sample_id}.source_style"
        )
        treatment = require_mapping(sample.get("treatment"), f"{sample_id}.treatment")
        consistency = require_mapping(
            sample.get("consistency"), f"{sample_id}.consistency"
        )
        cohorts_value = sample.get("cohorts")
        if not isinstance(cohorts_value, list):
            raise EvaluationError(f"{sample_id}.cohorts must be an array")
        resolution = require_mapping(
            require_mapping(
                sample.get("review_provenance"), f"{sample_id}.review_provenance"
            ).get("resolution"),
            f"{sample_id}.review_provenance.resolution",
        )
        flags = resolution.get("flags")
        if not isinstance(flags, list):
            raise EvaluationError(f"{sample_id}: final resolution flags are invalid")
        source = require_mapping(sample.get("source"), f"{sample_id}.source")
        targets[sample_id] = Target(
            sample_id=sample_id,
            work_id=str(sample["work_id"]),
            split=str(sample["split"]),
            sample_record_sha256=str(sample["_validated_record_sha256"]),
            listwise_record_sha256=require_sha(
                listwise.get("record_sha256"), f"{sample_id}.listwise.record_sha256"
            ),
            role=role,
            source_style=copy.deepcopy(dict(source_style)),
            treatment=copy.deepcopy(dict(treatment)),
            consistency_reason=require_text(
                consistency.get("reason_code"),
                f"{sample_id}.consistency.reason_code",
            ),
            cohorts=tuple(sorted(str(value) for value in cohorts_value)),
            judgment=copy.deepcopy(dict(judgment)),
            gains=gains,
            loss_eligible=frozenset(eligible),
            candidate_ids=global_candidates,
            source_page_sha256=str(source["source_page_sha256"]),
            sample_crop_sha256=str(source["sample_crop_sha256"]),
            manual_recrop="manual_recrop_resolved" in flags,
        )
    return ExportData(
        manifest_sha256=manifest_sha,
        font_catalog_sha256=font_catalog_sha,
        targets=targets,
        candidate_ids=global_candidates,
        work_split=dict(sorted(work_split.items())),
        input_hashes=copy.deepcopy(dict(manifest.get("input_hashes") or {})),
    )


def _parse_decision(
    value: Mapping[str, Any], *, candidates: Sequence[str], location: str
) -> Decision:
    ranking = require_unique_text_list(
        value.get("ranked_candidate_ids"), f"{location}.ranked_candidate_ids"
    )
    if set(ranking) != set(candidates) or len(ranking) != len(candidates):
        raise EvaluationError(
            f"{location}: ranking must be an exact catalog permutation"
        )
    return Decision(
        ranked_candidate_ids=ranking,
        none_probability=require_probability(
            value.get("none_probability"), f"{location}.none_probability"
        ),
        confidence=require_probability(
            value.get("confidence"), f"{location}.confidence"
        ),
    )


def load_predictions(
    path: Path,
    *,
    export: ExportData,
    evaluation_split: str,
    require_semantics: bool,
) -> PredictionSet:
    expected = {
        sample_id: target
        for sample_id, target in export.targets.items()
        if target.split == evaluation_split
    }
    if not expected:
        raise EvaluationError(f"training export has no {evaluation_split} samples")
    rows = read_jsonl(path, f"predictions:{path.name}")
    predictions: dict[str, Prediction] = {}
    identity: tuple[str, str] | None = None
    variant_counts: Counter[str] = Counter()
    for index, row in enumerate(rows):
        location = f"predictions:{path.name}[{index}]"
        if row.get("schema_version") != PREDICTION_SCHEMA_VERSION:
            raise EvaluationError(f"{location}: unsupported prediction schema")
        validate_seal(row, location)
        sample_id = require_text(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in predictions:
            raise EvaluationError(f"duplicate prediction for {sample_id}")
        target = export.targets.get(sample_id)
        if target is None:
            raise EvaluationError(f"prediction targets unknown sample {sample_id}")
        split = require_text(row.get("split"), f"{location}.split")
        if split != evaluation_split or target.split != evaluation_split:
            raise EvaluationError(
                f"prediction split leakage: {sample_id} is {split}/{target.split}, expected {evaluation_split}"
            )
        work_id = require_text(row.get("work_id"), f"{location}.work_id")
        if work_id != target.work_id:
            raise EvaluationError(f"{sample_id}: prediction work binding mismatch")
        bindings = require_mapping(row.get("bindings"), f"{location}.bindings")
        expected_bindings = {
            "font_catalog_sha256": export.font_catalog_sha256,
            "listwise_target_record_sha256": target.listwise_record_sha256,
            "training_export_manifest_sha256": export.manifest_sha256,
            "training_sample_record_sha256": target.sample_record_sha256,
        }
        for key, expected_value in expected_bindings.items():
            if bindings.get(key) != expected_value:
                raise EvaluationError(f"{sample_id}: prediction {key} mismatch")
        model = require_mapping(row.get("model"), f"{location}.model")
        model_identity = (
            require_text(model.get("id"), f"{location}.model.id"),
            require_sha(model.get("sha256"), f"{location}.model.sha256"),
        )
        if identity is None:
            identity = model_identity
        elif identity != model_identity:
            raise EvaluationError("prediction file mixes model IDs or hashes")
        decision = _parse_decision(
            row, candidates=target.candidate_ids, location=location
        )
        variants_value = row.get("variants", {})
        variants_mapping = require_mapping(variants_value, f"{location}.variants")
        unknown_variants = set(variants_mapping) - set(GENRE_VARIANTS)
        if unknown_variants:
            raise EvaluationError(
                f"{location}: unsupported variants {sorted(unknown_variants)}"
            )
        variants: dict[str, Decision] = {}
        for name, value in variants_mapping.items():
            variants[name] = _parse_decision(
                require_mapping(value, f"{location}.variants.{name}"),
                candidates=target.candidate_ids,
                location=f"{location}.variants.{name}",
            )
            variant_counts[name] += 1

        role: str | None = None
        source_style: Mapping[str, float] | None = None
        treatment: Mapping[str, str] | None = None
        if require_semantics:
            role = require_text(
                require_mapping(row.get("role"), f"{location}.role").get("primary"),
                f"{location}.role.primary",
            )
            style_mapping = require_mapping(
                row.get("source_style"), f"{location}.source_style"
            )
            parsed_style: dict[str, float] = {}
            for field in STYLE_FIELDS:
                parsed_style[field] = require_probability(
                    style_mapping.get(field), f"{location}.source_style.{field}"
                )
            source_style = parsed_style
            treatment_mapping = require_mapping(
                row.get("treatment"), f"{location}.treatment"
            )
            parsed_treatment: dict[str, str] = {}
            for field in target.treatment:
                parsed_treatment[str(field)] = require_text(
                    treatment_mapping.get(field), f"{location}.treatment.{field}"
                )
            treatment = parsed_treatment
        predictions[sample_id] = Prediction(
            sample_id=sample_id,
            work_id=work_id,
            split=split,
            decision=decision,
            variants=variants,
            role=role,
            source_style=source_style,
            treatment=treatment,
        )
    if set(predictions) != set(expected):
        missing = sorted(set(expected) - set(predictions))
        extra = sorted(set(predictions) - set(expected))
        raise EvaluationError(
            f"prediction inventory mismatch: missing={missing[:8]}, extra={extra[:8]}"
        )
    for name in GENRE_VARIANTS:
        if variant_counts[name] not in {0, len(expected)}:
            raise EvaluationError(
                f"variant {name} must cover the evaluation split exactly"
            )
    if identity is None:
        raise EvaluationError("prediction file is empty")
    return PredictionSet(
        path_sha256=sha256_file(path),
        model_id=identity[0],
        model_sha256=identity[1],
        predictions=predictions,
        available_variants=tuple(
            name for name in GENRE_VARIANTS if variant_counts[name] == len(expected)
        ),
    )


def _cohorts(target: Target) -> tuple[str, ...]:
    role = target.role.casefold().replace("-", "_")
    reason = target.consistency_reason.casefold()
    treatment = {
        str(key): str(value).casefold() for key, value in target.treatment.items()
    }
    source_names = {value.casefold().replace("-", "_") for value in target.cohorts}
    output: set[str] = set()
    if role in {"dialogue", "narration", "thought"}:
        output.add("ordinary")
    if role.startswith("aside") or "aside" in reason:
        output.add("aside")
    handwritten = target.source_style.get("handwritten")
    if (
        isinstance(handwritten, (int, float)) and float(handwritten) >= 0.5
    ) or "handwritten" in reason:
        output.add("handwriting")
    if role.startswith("sfx"):
        output.add("sfx")
    if "emphasis" in role or "emphasis" in reason:
        output.add("emphasis")
    if treatment.get("outline") not in {None, "none"}:
        output.add("outline")
    if treatment.get("fill") in {"inverse", "inverted", "reverse"} or any(
        "inverse" in name for name in source_names
    ):
        output.add("inverse")
    if treatment.get("fill") in {"color", "gradient", "pattern", "multicolor"} or any(
        "color" in name for name in source_names
    ):
        output.add("color")
    orientation = treatment.get("orientation")
    if orientation in {"horizontal", "vertical"}:
        output.add(orientation)
    if target.manual_recrop:
        output.add("manual_recrop")
    return tuple(sorted(output))


def _dcg(gains: Sequence[int]) -> float:
    return sum(gain / math.log2(index + 2) for index, gain in enumerate(gains))


def _score_sample(
    target: Target,
    prediction: Prediction,
    *,
    none_threshold: float,
    variant: str | None,
) -> SampleScore:
    decision = prediction.decision if variant is None else prediction.variants[variant]
    judgment = target.judgment
    preferred = set(judgment["preferred"])
    acceptable = preferred | set(judgment["acceptable"])
    rankable = not bool(judgment["none_acceptable"])
    top = decision.ranked_candidate_ids[0]
    top_three = set(decision.ranked_candidate_ids[:3])
    ranked_eligible = [
        candidate
        for candidate in decision.ranked_candidate_ids
        if candidate in target.loss_eligible
    ]
    observed_gains = [
        int(target.gains[candidate] or 0) for candidate in ranked_eligible
    ]
    ideal_gains = sorted(observed_gains, reverse=True)
    ideal_dcg = _dcg(ideal_gains)
    ndcg = None if ideal_dcg == 0 else _dcg(observed_gains) / ideal_dcg
    positions = {
        candidate: index
        for index, candidate in enumerate(decision.ranked_candidate_ids)
    }
    pairwise_correct = 0
    pairwise_total = 0
    eligible = sorted(target.loss_eligible)
    for left_index, left in enumerate(eligible):
        for right in eligible[left_index + 1 :]:
            left_gain = int(target.gains[left] or 0)
            right_gain = int(target.gains[right] or 0)
            if left_gain == right_gain:
                continue
            pairwise_total += 1
            predicted_relation = positions[left] < positions[right]
            truth_relation = left_gain > right_gain
            pairwise_correct += predicted_relation == truth_relation
    truth_none = bool(judgment["none_acceptable"])
    predicted_none = decision.none_probability >= none_threshold
    decision_correct = (
        predicted_none if truth_none else (not predicted_none and top in acceptable)
    )

    role_correct: float | None = None
    style_errors: list[tuple[str, float]] = []
    treatment_correct: list[tuple[str, float]] = []
    if variant is None and prediction.role is not None:
        role_correct = float(prediction.role == target.role)
        unknown = target.source_style.get("unknown_fields")
        unknown_fields = set(unknown) if isinstance(unknown, list) else set()
        assert prediction.source_style is not None
        for field in STYLE_FIELDS:
            truth = target.source_style.get(field)
            if (
                field in unknown_fields
                or isinstance(truth, bool)
                or not isinstance(truth, (int, float))
            ):
                continue
            style_errors.append(
                (field, abs(prediction.source_style[field] - float(truth)))
            )
        assert prediction.treatment is not None
        for field, truth in target.treatment.items():
            treatment_correct.append(
                (str(field), float(prediction.treatment.get(field) == truth))
            )
    return SampleScore(
        sample_id=target.sample_id,
        work_id=target.work_id,
        split=target.split,
        role=target.role,
        cohorts=_cohorts(target),
        rankable=rankable,
        preferred_at_1=float(top in preferred) if rankable else None,
        acceptable_at_1=float(top in acceptable) if rankable else None,
        acceptable_at_3=float(bool(top_three & acceptable)) if rankable else None,
        ndcg=ndcg,
        pairwise_correct=pairwise_correct,
        pairwise_total=pairwise_total,
        truth_none=truth_none,
        predicted_none=predicted_none,
        decision_correct=bool(decision_correct),
        confidence=decision.confidence,
        role_correct=role_correct,
        style_absolute_errors=tuple(style_errors),
        treatment_correct=tuple(treatment_correct),
    )


def _mean(values: Iterable[float | None]) -> float | None:
    present = [float(value) for value in values if value is not None]
    return None if not present else sum(present) / len(present)


def _metric_block(samples: Sequence[SampleScore]) -> dict[str, Any]:
    pairwise_correct = sum(sample.pairwise_correct for sample in samples)
    pairwise_total = sum(sample.pairwise_total for sample in samples)
    sample_pairwise = [
        sample.pairwise_correct / sample.pairwise_total
        for sample in samples
        if sample.pairwise_total
    ]
    tp = sum(sample.truth_none and sample.predicted_none for sample in samples)
    fp = sum(not sample.truth_none and sample.predicted_none for sample in samples)
    fn = sum(sample.truth_none and not sample.predicted_none for sample in samples)
    tn = sum(not sample.truth_none and not sample.predicted_none for sample in samples)
    precision = None if tp + fp == 0 else tp / (tp + fp)
    recall = None if tp + fn == 0 else tp / (tp + fn)
    f1 = (
        None
        if precision is None or recall is None
        else (
            0.0
            if precision + recall == 0
            else 2 * precision * recall / (precision + recall)
        )
    )
    style_by_field: dict[str, list[float]] = defaultdict(list)
    treatment_by_field: dict[str, list[float]] = defaultdict(list)
    for sample in samples:
        for field, value in sample.style_absolute_errors:
            style_by_field[field].append(value)
        for field, value in sample.treatment_correct:
            treatment_by_field[field].append(value)
    selective = []
    for threshold in SELECTIVE_THRESHOLDS:
        covered = [
            sample
            for sample in samples
            if not sample.predicted_none and sample.confidence >= threshold
        ]
        selective.append(
            {
                "confidence_threshold": threshold,
                "covered_count": len(covered),
                "coverage": None if not samples else len(covered) / len(samples),
                "selective_acceptable_accuracy": (
                    None
                    if not covered
                    else sum(
                        sample.rankable and sample.acceptable_at_1 == 1.0
                        for sample in covered
                    )
                    / len(covered)
                ),
                "abstain_rate": None
                if not samples
                else 1.0 - len(covered) / len(samples),
            }
        )
    all_style_errors = [value for values in style_by_field.values() for value in values]
    all_treatment = [
        value for values in treatment_by_field.values() for value in values
    ]
    return {
        "sample_count": len(samples),
        "rankable_count": sum(sample.rankable for sample in samples),
        "preferred_at_1": _mean(sample.preferred_at_1 for sample in samples),
        "acceptable_at_1": _mean(sample.acceptable_at_1 for sample in samples),
        "acceptable_at_3": _mean(sample.acceptable_at_3 for sample in samples),
        "tier_ndcg": _mean(sample.ndcg for sample in samples),
        "pairwise_agreement": (
            None if pairwise_total == 0 else pairwise_correct / pairwise_total
        ),
        "pairwise_sample_macro": _mean(sample_pairwise),
        "pairwise_comparison_count": pairwise_total,
        "none": {
            "truth_positive_count": tp + fn,
            "predicted_positive_count": tp + fp,
            "true_positive": tp,
            "false_positive": fp,
            "false_negative": fn,
            "true_negative": tn,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        },
        "none_precision": precision,
        "none_recall": recall,
        "none_f1": f1,
        "decision_accuracy": _mean(
            float(sample.decision_correct) for sample in samples
        ),
        "role_accuracy": _mean(sample.role_correct for sample in samples),
        "style_mae": None
        if not all_style_errors
        else sum(all_style_errors) / len(all_style_errors),
        "style_mae_by_field": {
            field: sum(values) / len(values)
            for field, values in sorted(style_by_field.items())
        },
        "treatment_accuracy": None
        if not all_treatment
        else sum(all_treatment) / len(all_treatment),
        "treatment_accuracy_by_field": {
            field: sum(values) / len(values)
            for field, values in sorted(treatment_by_field.items())
        },
        "selective": selective,
    }


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise EvaluationError("cannot compute a quantile of no values")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


MACRO_METRICS = (
    "preferred_at_1",
    "acceptable_at_1",
    "acceptable_at_3",
    "tier_ndcg",
    "pairwise_agreement",
    "none_precision",
    "none_recall",
    "none_f1",
    "decision_accuracy",
    "role_accuracy",
    "style_mae",
    "treatment_accuracy",
)


def _macro_summary(blocks: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for metric in MACRO_METRICS:
        values = [
            float(block[metric])
            for block in blocks.values()
            if block.get(metric) is not None
        ]
        output[metric] = {
            "group_count": len(values),
            "mean": None if not values else sum(values) / len(values),
            "median": None if not values else _quantile(values, 0.5),
            "lower_10_percentile": None if not values else _quantile(values, 0.1),
        }
    return output


def evaluate_system(
    export: ExportData,
    prediction_set: PredictionSet,
    *,
    evaluation_split: str,
    none_threshold: float,
    variant: str | None = None,
) -> dict[str, Any]:
    target_ids = sorted(
        sample_id
        for sample_id, target in export.targets.items()
        if target.split == evaluation_split
    )
    scores = [
        _score_sample(
            export.targets[sample_id],
            prediction_set.predictions[sample_id],
            none_threshold=none_threshold,
            variant=variant,
        )
        for sample_id in target_ids
    ]
    by_work_samples: dict[str, list[SampleScore]] = defaultdict(list)
    by_role_samples: dict[str, list[SampleScore]] = defaultdict(list)
    by_split_samples: dict[str, list[SampleScore]] = defaultdict(list)
    by_cohort_samples: dict[str, list[SampleScore]] = defaultdict(list)
    for score in scores:
        by_work_samples[score.work_id].append(score)
        by_role_samples[score.role].append(score)
        by_split_samples[score.split].append(score)
        for cohort in score.cohorts:
            by_cohort_samples[cohort].append(score)
    by_work = {
        key: _metric_block(value) for key, value in sorted(by_work_samples.items())
    }
    by_role = {
        key: _metric_block(value) for key, value in sorted(by_role_samples.items())
    }
    return {
        "model": {
            "id": prediction_set.model_id,
            "sha256": prediction_set.model_sha256,
            "prediction_jsonl_sha256": prediction_set.path_sha256,
        },
        "variant": variant or "default",
        "overall": _metric_block(scores),
        "by_split": {
            key: _metric_block(value) for key, value in sorted(by_split_samples.items())
        },
        "by_role": by_role,
        "by_work": by_work,
        "by_cohort": {
            key: _metric_block(value)
            for key, value in sorted(by_cohort_samples.items())
        },
        "macro": {
            "role": _macro_summary(by_role),
            "work": _macro_summary(by_work),
        },
    }


def paired_work_bootstrap(
    model: Mapping[str, Any],
    baseline: Mapping[str, Any],
    *,
    metric: str,
    iterations: int,
    seed: str,
) -> dict[str, Any]:
    model_work = require_mapping(model.get("by_work"), "model.by_work")
    baseline_work = require_mapping(baseline.get("by_work"), "baseline.by_work")
    works = sorted(set(model_work) & set(baseline_work))
    deltas = [
        float(require_mapping(model_work[work], f"model.by_work.{work}")[metric])
        - float(
            require_mapping(baseline_work[work], f"baseline.by_work.{work}")[metric]
        )
        for work in works
        if require_mapping(model_work[work], f"model.by_work.{work}").get(metric)
        is not None
        and require_mapping(baseline_work[work], f"baseline.by_work.{work}").get(metric)
        is not None
    ]
    if not deltas:
        return {
            "metric": metric,
            "work_count": 0,
            "iterations": iterations,
            "observed_delta": None,
            "ci95": {"lower": None, "upper": None},
        }
    generator = random.Random(int(sha256_bytes(seed.encode("utf-8"))[:16], 16))
    bootstrap = [
        sum(deltas[generator.randrange(len(deltas))] for _ in deltas) / len(deltas)
        for _ in range(iterations)
    ]
    return {
        "metric": metric,
        "work_count": len(deltas),
        "iterations": iterations,
        "observed_delta": sum(deltas) / len(deltas),
        "ci95": {
            "lower": _quantile(bootstrap, 0.025),
            "upper": _quantile(bootstrap, 0.975),
        },
    }


def _work_macro_acceptable(system: Mapping[str, Any]) -> float | None:
    macro = require_mapping(system.get("macro"), "system.macro")
    work = require_mapping(macro.get("work"), "system.macro.work")
    metric = require_mapping(work.get("acceptable_at_1"), "work.acceptable_at_1")
    value = metric.get("mean")
    return None if value is None else float(value)


def _gate(
    *,
    name: str,
    observed: float | None,
    threshold: float,
    comparator: str,
    passed: bool | None,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "status": "not_evaluable" if passed is None else ("pass" if passed else "fail"),
        "observed": observed,
        "threshold": threshold,
        "comparator": comparator,
        "details": copy.deepcopy(dict(details or {})),
    }


def evaluate(
    *,
    export: ExportData,
    model_predictions: PredictionSet,
    evaluation_split: str,
    none_threshold: float,
    current_rule_predictions: PredictionSet | None,
    majority_predictions: PredictionSet | None,
    bootstrap_iterations: int,
    bootstrap_seed: str,
) -> dict[str, Any]:
    if evaluation_split not in VALID_EVALUATION_SPLITS:
        raise EvaluationError("evaluation split must be val or frozen test")
    model = evaluate_system(
        export,
        model_predictions,
        evaluation_split=evaluation_split,
        none_threshold=none_threshold,
    )
    systems: dict[str, Any] = {"model": model}
    comparisons: dict[str, Any] = {}
    baseline_gates: dict[str, Any] = {}
    for name, prediction_set in (
        ("current_rule", current_rule_predictions),
        ("role_work_majority", majority_predictions),
    ):
        if prediction_set is None:
            baseline_gates[name] = _gate(
                name=f"paired_work_bootstrap_vs_{name}",
                observed=None,
                threshold=0.0,
                comparator=">",
                passed=None,
            )
            continue
        baseline = evaluate_system(
            export,
            prediction_set,
            evaluation_split=evaluation_split,
            none_threshold=none_threshold,
        )
        systems[name] = baseline
        comparison = paired_work_bootstrap(
            model,
            baseline,
            metric="acceptable_at_1",
            iterations=bootstrap_iterations,
            seed=f"{bootstrap_seed}:{name}:{export.manifest_sha256}",
        )
        comparisons[name] = comparison
        lower = comparison["ci95"]["lower"]
        baseline_gates[name] = _gate(
            name=f"paired_work_bootstrap_vs_{name}",
            observed=lower,
            threshold=0.0,
            comparator=">",
            passed=None if lower is None else float(lower) > 0.0,
            details={"observed_delta": comparison["observed_delta"]},
        )

    genre_reports: dict[str, Any] = {}
    genre_gates: dict[str, Any] = {}
    default_macro = _work_macro_acceptable(model)
    for name, threshold in (
        ("no_genre", GENRE_REMOVAL_MAX_DROP),
        ("swapped_genre", GENRE_SWAP_MAX_DROP),
    ):
        if name not in model_predictions.available_variants:
            genre_gates[name] = _gate(
                name=f"{name}_acceptable_at_1_drop",
                observed=None,
                threshold=threshold,
                comparator="<=",
                passed=None,
            )
            continue
        variant_report = evaluate_system(
            export,
            model_predictions,
            evaluation_split=evaluation_split,
            none_threshold=none_threshold,
            variant=name,
        )
        genre_reports[name] = variant_report
        variant_macro = _work_macro_acceptable(variant_report)
        drop = (
            None
            if default_macro is None or variant_macro is None
            else default_macro - variant_macro
        )
        genre_gates[name] = _gate(
            name=f"{name}_acceptable_at_1_drop",
            observed=drop,
            threshold=threshold,
            comparator="<=",
            passed=None if drop is None else drop <= threshold,
        )

    cohort_gates: dict[str, Any] = {}
    current_cohorts = (
        require_mapping(systems["current_rule"].get("by_cohort"), "current.by_cohort")
        if "current_rule" in systems
        else {}
    )
    model_cohorts = require_mapping(model.get("by_cohort"), "model.by_cohort")
    for cohort in CORE_COHORTS:
        model_block = model_cohorts.get(cohort)
        baseline_block = current_cohorts.get(cohort)
        if not isinstance(model_block, Mapping) or not isinstance(
            baseline_block, Mapping
        ):
            cohort_gates[cohort] = _gate(
                name=f"core_cohort_{cohort}_regression",
                observed=None,
                threshold=CORE_COHORT_MAX_REGRESSION,
                comparator="<=",
                passed=None,
            )
            continue
        model_value = model_block.get("acceptable_at_1")
        baseline_value = baseline_block.get("acceptable_at_1")
        regression = (
            None
            if model_value is None or baseline_value is None
            else float(baseline_value) - float(model_value)
        )
        cohort_gates[cohort] = _gate(
            name=f"core_cohort_{cohort}_regression",
            observed=regression,
            threshold=CORE_COHORT_MAX_REGRESSION,
            comparator="<=",
            passed=None
            if regression is None
            else regression <= CORE_COHORT_MAX_REGRESSION,
            details={
                "model_acceptable_at_1": model_value,
                "current_rule_acceptable_at_1": baseline_value,
            },
        )

    all_gate_records = [
        *baseline_gates.values(),
        *genre_gates.values(),
        *cohort_gates.values(),
    ]
    report = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "evaluation_split": evaluation_split,
        "frozen_test": evaluation_split == "test",
        "input_hashes": {
            "font_catalog_sha256": export.font_catalog_sha256,
            "training_export_manifest_sha256": export.manifest_sha256,
            "training_export_inputs": copy.deepcopy(dict(export.input_hashes)),
        },
        "configuration": {
            "bootstrap_iterations": bootstrap_iterations,
            "bootstrap_seed": bootstrap_seed,
            "none_threshold": none_threshold,
            "selective_confidence_thresholds": list(SELECTIVE_THRESHOLDS),
        },
        "systems": systems,
        "genre_counterfactuals": genre_reports,
        "comparisons": comparisons,
        "gates": {
            "baseline_superiority": baseline_gates,
            "genre_robustness": genre_gates,
            "core_cohort_regression": cohort_gates,
        },
        "all_gates_pass": all(
            record["status"] == "pass" for record in all_gate_records
        ),
        "not_evaluable_gate_count": sum(
            record["status"] == "not_evaluable" for record in all_gate_records
        ),
    }
    assert_finite(report)
    return report


def assert_finite(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise EvaluationError("evaluation report contains a non-finite number")
    if isinstance(value, Mapping):
        for child in value.values():
            assert_finite(child)
    elif isinstance(value, list):
        for child in value:
            assert_finite(child)


def evaluate_files(
    *,
    training_export_manifest: Path,
    samples: Path,
    listwise: Path,
    predictions: Path,
    evaluation_split: str = "test",
    current_rule_predictions: Path | None = None,
    majority_predictions: Path | None = None,
    none_threshold: float = 0.5,
    bootstrap_iterations: int = 2_000,
    bootstrap_seed: str = "font-matching-v2-work-bootstrap-v1",
) -> dict[str, Any]:
    export = load_export(training_export_manifest, samples, listwise)
    model = load_predictions(
        predictions,
        export=export,
        evaluation_split=evaluation_split,
        require_semantics=True,
    )
    current = (
        load_predictions(
            current_rule_predictions,
            export=export,
            evaluation_split=evaluation_split,
            require_semantics=False,
        )
        if current_rule_predictions is not None
        else None
    )
    majority = (
        load_predictions(
            majority_predictions,
            export=export,
            evaluation_split=evaluation_split,
            require_semantics=False,
        )
        if majority_predictions is not None
        else None
    )
    return evaluate(
        export=export,
        model_predictions=model,
        evaluation_split=evaluation_split,
        none_threshold=none_threshold,
        current_rule_predictions=current,
        majority_predictions=majority,
        bootstrap_iterations=bootstrap_iterations,
        bootstrap_seed=bootstrap_seed,
    )


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def probability(value: str) -> float:
    try:
        return require_probability(float(value), "value")
    except EvaluationError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training-export-manifest", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--listwise", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--current-rule-predictions", type=Path)
    parser.add_argument("--majority-predictions", type=Path)
    parser.add_argument("--evaluation-split", choices=("val", "test"), default="test")
    parser.add_argument("--none-threshold", type=probability, default=0.5)
    parser.add_argument("--bootstrap-iterations", type=positive_int, default=2_000)
    parser.add_argument(
        "--bootstrap-seed", default="font-matching-v2-work-bootstrap-v1"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-gates", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = evaluate_files(
            training_export_manifest=args.training_export_manifest.resolve(),
            samples=args.samples.resolve(),
            listwise=args.listwise.resolve(),
            predictions=args.predictions.resolve(),
            evaluation_split=args.evaluation_split,
            current_rule_predictions=(
                args.current_rule_predictions.resolve()
                if args.current_rule_predictions is not None
                else None
            ),
            majority_predictions=(
                args.majority_predictions.resolve()
                if args.majority_predictions is not None
                else None
            ),
            none_threshold=args.none_threshold,
            bootstrap_iterations=args.bootstrap_iterations,
            bootstrap_seed=args.bootstrap_seed,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(canonical_json_bytes(report, pretty=True))
        print(
            json.dumps(
                {
                    "all_gates_pass": report["all_gates_pass"],
                    "output": str(args.output.resolve()),
                    "schema_version": REPORT_SCHEMA_VERSION,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        if args.require_gates and not report["all_gates_pass"]:
            return 2
        return 0
    except (EvaluationError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
