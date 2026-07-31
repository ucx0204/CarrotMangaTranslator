#!/usr/bin/env python3
"""Blind font-label review contracts and exactly-once ledger validation.

This module is the data contract for the P1/P2 review stages in
``docs/font-matching-v2-plan.md``.  It deliberately has no dependency on the
renderer or on either source-dataset builder.  A master manifest only needs to
provide :class:`ReviewSample` records; a renderer can then consume the emitted
assignments and bind its review cards to them.

The contract separates three things that must not be conflated:

* a deterministic, blind primary/secondary review assignment;
* an immutable human review record bound to the assignment and card hashes;
* one final label projection per sample, which resolves any recalculation.

The manual validators below enforce semantic constraints that JSON Schema
alone cannot express, including candidate-tier partitions, blind first passes,
independent double review, exactly-once coverage, and adjudication of every
disagreement/low-confidence/``none_acceptable`` item.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
SCHEMA_ID = "https://carrot-manga-translator.local/schemas/font-label-v1.json"
REVIEW_RECORD_TYPE = "manga_font_label_review"
FINAL_RECORD_TYPE = "manga_font_label_final"
ASSIGNMENT_RECORD_TYPE = "manga_font_label_assignment"

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
    "unknown_needs_review",
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
FONT_TIERS = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
    "not_reviewed",
)
CONSISTENCY_POLICIES = (
    "inherit_work_anchor",
    "intentional_override",
    "undetermined",
)
CONSISTENCY_REASONS = (
    "ordinary_dialogue",
    "narration_anchor",
    "thought_anchor",
    "handwritten_aside",
    "sfx_role_palette",
    "emphasis",
    "orientation_specific",
    "cold_start",
    "insufficient_evidence",
    "other",
)
REVIEW_FLAGS = (
    "low_confidence",
    "role_uncertain",
    "crop_needs_review",
    "catalog_gap",
    "rendering_issue",
    "layout_not_assessed",
    "policy_uncertain",
    "manual_recrop",
    "none_acceptable",
)
FINAL_FLAGS = (
    "none_acceptable_confirmed",
    "catalog_gap_confirmed",
    "manual_recrop_resolved",
    "low_confidence_resolved",
    "disagreement_resolved",
)
REVIEW_STAGES = ("primary", "secondary")
RESOLUTION_KINDS = ("primary", "blind_agreement", "adjudicated")

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")


class LabelValidationError(ValueError):
    """Raised when a label artifact violates the frozen review contract."""


def _array_schema(item_schema: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": "array",
        "items": dict(item_schema),
        "uniqueItems": True,
    }


_ID_SCHEMA: dict[str, Any] = {"type": "string", "pattern": ID_RE.pattern}
_SHA_SCHEMA: dict[str, Any] = {"type": "string", "pattern": SHA256_RE.pattern}
_SCORE_SCHEMA: dict[str, Any] = {
    "anyOf": [
        {"type": "number", "minimum": 0.0, "maximum": 1.0},
        {"type": "null"},
    ]
}

_ROLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["primary", "confidence"],
    "properties": {
        "primary": {"type": "string", "enum": list(ROLE_VALUES)},
        "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
    },
}
_SOURCE_STYLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [*STYLE_FIELDS, "unknown_fields"],
    "properties": {
        **{field: _SCORE_SCHEMA for field in STYLE_FIELDS},
        "unknown_fields": {
            "type": "array",
            "items": {"type": "string", "enum": list(STYLE_FIELDS)},
            "uniqueItems": True,
        },
    },
}
_TREATMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["orientation", "outline", "shadow", "fill", "distortion"],
    "properties": {
        "orientation": {
            "type": "string",
            "enum": ["horizontal", "vertical", "mixed", "unknown"],
        },
        "outline": {
            "type": "string",
            "enum": ["none", "single", "double", "multiple", "unknown"],
        },
        "shadow": {
            "type": "string",
            "enum": ["none", "hard", "soft", "multiple", "unknown"],
        },
        "fill": {
            "type": "string",
            "enum": [
                "solid",
                "gradient",
                "pattern",
                "inverse",
                "transparent",
                "unknown",
            ],
        },
        "distortion": {
            "type": "string",
            "enum": [
                "none",
                "slant",
                "perspective",
                "warp",
                "wave",
                "jitter",
                "other",
                "unknown",
            ],
        },
    },
}
_FONT_JUDGMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [*FONT_TIERS, "none_acceptable"],
    "properties": {
        **{tier: _array_schema(_ID_SCHEMA) for tier in FONT_TIERS},
        "none_acceptable": {"type": "boolean"},
    },
}
_CONSISTENCY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["policy", "reason_code"],
    "properties": {
        "policy": {"type": "string", "enum": list(CONSISTENCY_POLICIES)},
        "reason_code": {"type": "string", "enum": list(CONSISTENCY_REASONS)},
    },
}
_CORE_PROPERTIES: dict[str, Any] = {
    "schema_version": {"const": SCHEMA_VERSION},
    "sample_id": _ID_SCHEMA,
    "work_id": _ID_SCHEMA,
    "source_page_sha256": _SHA_SCHEMA,
    "role": _ROLE_SCHEMA,
    "source_style": _SOURCE_STYLE_SCHEMA,
    "treatment": _TREATMENT_SCHEMA,
    "font_judgment": _FONT_JUDGMENT_SCHEMA,
    "consistency": _CONSISTENCY_SCHEMA,
}
_CORE_REQUIRED = list(_CORE_PROPERTIES)

_REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        *_CORE_REQUIRED,
        "record_type",
        "label_id",
        "review",
        "record_sha256",
    ],
    "properties": {
        **_CORE_PROPERTIES,
        "record_type": {"const": REVIEW_RECORD_TYPE},
        "label_id": _ID_SCHEMA,
        "review": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "stage",
                "assignment_id",
                "reviewer",
                "reviewed_at",
                "catalog_version",
                "catalog_sha256",
                "renderer_hash",
                "review_card_sha256",
                "candidate_order_seed",
                "candidate_order",
                "blind_first_pass",
                "font_names_visible",
                "model_suggestions_visible",
                "confidence",
                "flags",
            ],
            "properties": {
                "stage": {"type": "string", "enum": list(REVIEW_STAGES)},
                "assignment_id": _ID_SCHEMA,
                "reviewer": _ID_SCHEMA,
                "reviewed_at": {"type": "string", "format": "date-time"},
                "catalog_version": _ID_SCHEMA,
                "catalog_sha256": _SHA_SCHEMA,
                "renderer_hash": _SHA_SCHEMA,
                "review_card_sha256": _SHA_SCHEMA,
                "candidate_order_seed": _SHA_SCHEMA,
                "candidate_order": _array_schema(_ID_SCHEMA),
                "blind_first_pass": {"const": True},
                "font_names_visible": {"const": False},
                "model_suggestions_visible": {"const": False},
                "confidence": {
                    "type": "number",
                    "minimum": 0.0,
                    "maximum": 1.0,
                },
                "flags": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(REVIEW_FLAGS)},
                    "uniqueItems": True,
                },
            },
        },
        "record_sha256": _SHA_SCHEMA,
    },
}

_FINAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        *_CORE_REQUIRED,
        "record_type",
        "final_id",
        "resolution",
        "record_sha256",
    ],
    "properties": {
        **_CORE_PROPERTIES,
        "record_type": {"const": FINAL_RECORD_TYPE},
        "final_id": _ID_SCHEMA,
        "resolution": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "kind",
                "resolver",
                "resolved_at",
                "source_label_ids",
                "catalog_version",
                "catalog_sha256",
                "renderer_hash",
                "confidence",
                "flags",
                "notes",
                "adjudication_evidence",
            ],
            "properties": {
                "kind": {"type": "string", "enum": list(RESOLUTION_KINDS)},
                "resolver": _ID_SCHEMA,
                "resolved_at": {"type": "string", "format": "date-time"},
                "source_label_ids": {
                    "type": "array",
                    "items": _ID_SCHEMA,
                    "minItems": 1,
                    "uniqueItems": True,
                },
                "catalog_version": _ID_SCHEMA,
                "catalog_sha256": _SHA_SCHEMA,
                "renderer_hash": _SHA_SCHEMA,
                "confidence": {
                    "type": "number",
                    "minimum": 0.0,
                    "maximum": 1.0,
                },
                "flags": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(FINAL_FLAGS)},
                    "uniqueItems": True,
                },
                "notes": {"type": "string", "maxLength": 4000},
                "adjudication_evidence": {
                    "oneOf": [
                        {"type": "null"},
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "review_card_sha256",
                                "candidate_order_seed",
                                "candidate_order",
                                "font_names_visible",
                                "model_suggestions_visible",
                            ],
                            "properties": {
                                "review_card_sha256": _SHA_SCHEMA,
                                "candidate_order_seed": _SHA_SCHEMA,
                                "candidate_order": _array_schema(_ID_SCHEMA),
                                "font_names_visible": {"type": "boolean"},
                                "model_suggestions_visible": {"type": "boolean"},
                            },
                        },
                    ]
                },
            },
            "allOf": [
                {
                    "if": {
                        "properties": {"kind": {"const": "adjudicated"}},
                        "required": ["kind"],
                    },
                    "then": {
                        "properties": {"adjudication_evidence": {"type": "object"}}
                    },
                    "else": {"properties": {"adjudication_evidence": {"type": "null"}}},
                }
            ],
        },
        "record_sha256": _SHA_SCHEMA,
    },
}

FONT_MATCHING_LABEL_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": SCHEMA_ID,
    "title": "Manga Font Matching Human Label Ledger Record v1",
    "description": (
        "An immutable blind review event or exactly-once final font label. "
        "Candidate partition and ledger-wide invariants require the companion "
        "semantic validator in scripts/font_matching_labels.py."
    ),
    "oneOf": [_REVIEW_SCHEMA, _FINAL_SCHEMA],
}


def label_json_schema() -> dict[str, Any]:
    """Return a defensive copy of the public Draft 2020-12 JSON Schema."""

    return copy.deepcopy(FONT_MATCHING_LABEL_SCHEMA)


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _record_digest(record: Mapping[str, Any]) -> str:
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    return sha256_json(core)


def seal_record(record: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copied immutable-ledger payload with its content hash set."""

    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = _record_digest(output)
    return output


def _stable_hash(*parts: str) -> str:
    payload = "\0".join(parts).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def candidate_order_seed(
    sample_id: str,
    stage: str,
    *,
    catalog_version: str,
    allocation_seed: str,
) -> str:
    """Derive a stable, non-secret seed for one blind candidate ordering."""

    _validate_id(sample_id, "sample_id")
    if stage not in REVIEW_STAGES:
        raise LabelValidationError(f"unsupported review stage: {stage!r}")
    _validate_id(catalog_version, "catalog_version")
    if not isinstance(allocation_seed, str) or not allocation_seed:
        raise LabelValidationError("allocation_seed must be a non-empty string")
    return _stable_hash(
        "manga-font-candidate-order-v1",
        allocation_seed,
        catalog_version,
        sample_id,
        stage,
    )


def deterministic_candidate_order(
    candidate_ids: Iterable[str], seed: str
) -> tuple[str, ...]:
    """Return a platform-independent seeded permutation of candidate IDs.

    Hash-ranking is used instead of ``random.shuffle`` so results do not depend
    on Python's PRNG implementation or the input catalog's incidental order.
    """

    candidates = tuple(candidate_ids)
    if not candidates:
        raise LabelValidationError("candidate_ids must not be empty")
    if len(candidates) != len(set(candidates)):
        raise LabelValidationError("candidate_ids must be unique")
    for index, candidate in enumerate(candidates):
        _validate_id(candidate, f"candidate_ids[{index}]")
    if not isinstance(seed, str) or not seed:
        raise LabelValidationError("candidate order seed must be non-empty")
    return tuple(
        sorted(
            candidates,
            key=lambda candidate: (
                _stable_hash("manga-font-candidate-rank-v1", seed, candidate),
                candidate,
            ),
        )
    )


@dataclass(frozen=True)
class ReviewSample:
    sample_id: str
    work_id: str
    source_page_sha256: str
    candidate_ids: tuple[str, ...]

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ReviewSample":
        _require_mapping(value, "sample")
        _require_keys(
            value,
            {"sample_id", "work_id", "source_page_sha256", "candidate_ids"},
            set(),
            "sample",
        )
        sample = cls(
            sample_id=_required_string(value, "sample_id", "sample"),
            work_id=_required_string(value, "work_id", "sample"),
            source_page_sha256=_required_string(value, "source_page_sha256", "sample"),
            candidate_ids=_string_tuple(value.get("candidate_ids"), "candidate_ids"),
        )
        _validate_id(sample.sample_id, "sample.sample_id")
        _validate_id(sample.work_id, "sample.work_id")
        _validate_sha(sample.source_page_sha256, "sample.source_page_sha256")
        if not sample.candidate_ids:
            raise LabelValidationError("sample.candidate_ids must not be empty")
        if len(sample.candidate_ids) != len(set(sample.candidate_ids)):
            raise LabelValidationError("sample.candidate_ids contains duplicates")
        for index, candidate in enumerate(sample.candidate_ids):
            _validate_id(candidate, f"sample.candidate_ids[{index}]")
        return sample

    def as_dict(self) -> dict[str, Any]:
        return {
            "sample_id": self.sample_id,
            "work_id": self.work_id,
            "source_page_sha256": self.source_page_sha256,
            "candidate_ids": list(self.candidate_ids),
        }


@dataclass(frozen=True)
class ReviewAssignment:
    assignment_id: str
    sample_id: str
    work_id: str
    source_page_sha256: str
    stage: str
    catalog_version: str
    candidate_order_seed: str
    candidate_order: tuple[str, ...]
    blind_first_pass: bool = True
    font_names_visible: bool = False
    model_suggestions_visible: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "record_type": ASSIGNMENT_RECORD_TYPE,
            "assignment_id": self.assignment_id,
            "sample_id": self.sample_id,
            "work_id": self.work_id,
            "source_page_sha256": self.source_page_sha256,
            "stage": self.stage,
            "catalog_version": self.catalog_version,
            "candidate_order_seed": self.candidate_order_seed,
            "candidate_order": list(self.candidate_order),
            "blind_first_pass": self.blind_first_pass,
            "font_names_visible": self.font_names_visible,
            "model_suggestions_visible": self.model_suggestions_visible,
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ReviewAssignment":
        _require_mapping(value, "assignment")
        required = {
            "schema_version",
            "record_type",
            "assignment_id",
            "sample_id",
            "work_id",
            "source_page_sha256",
            "stage",
            "catalog_version",
            "candidate_order_seed",
            "candidate_order",
            "blind_first_pass",
            "font_names_visible",
            "model_suggestions_visible",
        }
        _require_keys(value, required, set(), "assignment")
        if value.get("schema_version") != SCHEMA_VERSION:
            raise LabelValidationError("assignment.schema_version must be 1")
        if value.get("record_type") != ASSIGNMENT_RECORD_TYPE:
            raise LabelValidationError("assignment.record_type is invalid")
        assignment = cls(
            assignment_id=_required_string(value, "assignment_id", "assignment"),
            sample_id=_required_string(value, "sample_id", "assignment"),
            work_id=_required_string(value, "work_id", "assignment"),
            source_page_sha256=_required_string(
                value, "source_page_sha256", "assignment"
            ),
            stage=_required_string(value, "stage", "assignment"),
            catalog_version=_required_string(value, "catalog_version", "assignment"),
            candidate_order_seed=_required_string(
                value, "candidate_order_seed", "assignment"
            ),
            candidate_order=_string_tuple(
                value.get("candidate_order"), "assignment.candidate_order"
            ),
            blind_first_pass=value.get("blind_first_pass") is True,
            font_names_visible=value.get("font_names_visible") is True,
            model_suggestions_visible=value.get("model_suggestions_visible") is True,
        )
        _validate_assignment(assignment)
        return assignment


@dataclass(frozen=True)
class RecalculationItem:
    sample_id: str
    reasons: tuple[str, ...]
    source_label_ids: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "sample_id": self.sample_id,
            "reasons": list(self.reasons),
            "source_label_ids": list(self.source_label_ids),
        }


@dataclass(frozen=True)
class LedgerValidationReport:
    sample_count: int
    assignment_count: int
    primary_review_count: int
    secondary_review_count: int
    double_review_sample_count: int
    double_review_fraction: float
    recalculation_queue: tuple[RecalculationItem, ...]
    final_record_count: int
    completion_ready: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "sample_count": self.sample_count,
            "assignment_count": self.assignment_count,
            "primary_review_count": self.primary_review_count,
            "secondary_review_count": self.secondary_review_count,
            "double_review_sample_count": self.double_review_sample_count,
            "double_review_fraction": self.double_review_fraction,
            "recalculation_queue_count": len(self.recalculation_queue),
            "recalculation_queue": [
                item.as_dict() for item in self.recalculation_queue
            ],
            "final_record_count": self.final_record_count,
            "completion_ready": self.completion_ready,
        }


def _normalise_samples(
    samples: Iterable[ReviewSample | Mapping[str, Any]],
) -> tuple[ReviewSample, ...]:
    output = tuple(
        ReviewSample.from_mapping(sample.as_dict())
        if isinstance(sample, ReviewSample)
        else ReviewSample.from_mapping(sample)
        for sample in samples
    )
    if not output:
        raise LabelValidationError("at least one review sample is required")
    ids = [sample.sample_id for sample in output]
    if len(ids) != len(set(ids)):
        raise LabelValidationError("review samples contain duplicate sample_id values")
    return tuple(sorted(output, key=lambda sample: sample.sample_id))


def _rank_for_allocation(seed: str, *parts: str) -> str:
    return _stable_hash("manga-font-double-review-v1", seed, *parts)


def _apportion(capacities: Mapping[str, int], target: int, seed: str) -> dict[str, int]:
    """Hamilton-apportion ``target`` slots without exceeding capacities."""

    output = {key: 0 for key in capacities}
    if target <= 0:
        return output
    total_capacity = sum(capacities.values())
    if target > total_capacity:
        raise LabelValidationError("double-review allocation exceeds sample capacity")
    if total_capacity == 0:
        return output
    raw = {
        key: (target * capacity / total_capacity)
        for key, capacity in capacities.items()
    }
    for key, capacity in capacities.items():
        output[key] = min(capacity, math.floor(raw[key]))
    remaining = target - sum(output.values())
    eligible = [key for key in capacities if output[key] < capacities[key]]
    eligible.sort(
        key=lambda key: (
            -(raw[key] - math.floor(raw[key])),
            _rank_for_allocation(seed, "work", key),
            key,
        )
    )
    for key in eligible[:remaining]:
        output[key] += 1
    if sum(output.values()) != target:
        raise LabelValidationError("could not apportion double-review allocation")
    return output


def _double_review_sample_ids(
    samples: Sequence[ReviewSample], fraction: float, allocation_seed: str
) -> frozenset[str]:
    if isinstance(fraction, bool) or not isinstance(fraction, (int, float)):
        raise LabelValidationError("double_review_fraction must be numeric")
    fraction = float(fraction)
    if not 0.0 <= fraction <= 1.0:
        raise LabelValidationError("double_review_fraction must be between 0 and 1")
    target = math.ceil(len(samples) * fraction)
    if target == 0:
        return frozenset()
    by_work: dict[str, list[ReviewSample]] = {}
    for sample in samples:
        by_work.setdefault(sample.work_id, []).append(sample)
    works = sorted(by_work)
    quotas = {work: 0 for work in works}
    if target >= len(works):
        for work in works:
            quotas[work] = 1
        extra = _apportion(
            {work: len(by_work[work]) - 1 for work in works},
            target - len(works),
            allocation_seed,
        )
        quotas = {work: quotas[work] + extra[work] for work in works}
    else:
        # A tiny pilot may have fewer double-review slots than works. Select
        # globally by stable hash; the production 20% allocation has many more
        # slots than the 24 known works and therefore takes the stratified path.
        ranked = sorted(
            samples,
            key=lambda sample: (
                _rank_for_allocation(allocation_seed, sample.work_id, sample.sample_id),
                sample.sample_id,
            ),
        )
        return frozenset(sample.sample_id for sample in ranked[:target])
    selected: set[str] = set()
    for work, work_samples in by_work.items():
        ranked = sorted(
            work_samples,
            key=lambda sample: (
                _rank_for_allocation(allocation_seed, work, sample.sample_id),
                sample.sample_id,
            ),
        )
        selected.update(sample.sample_id for sample in ranked[: quotas[work]])
    if len(selected) != target:
        raise LabelValidationError("double-review allocation did not reach target")
    return frozenset(selected)


def _assignment_identifier(
    *,
    sample_id: str,
    stage: str,
    catalog_version: str,
    order_seed: str,
    candidate_order: Sequence[str],
) -> str:
    digest = _stable_hash(
        "manga-font-review-assignment-v1",
        sample_id,
        stage,
        catalog_version,
        order_seed,
        *candidate_order,
    )
    return f"fmra-{digest[:32]}"


def build_blind_review_assignments(
    samples: Iterable[ReviewSample | Mapping[str, Any]],
    *,
    catalog_version: str,
    allocation_seed: str,
    double_review_fraction: float = 0.2,
) -> tuple[ReviewAssignment, ...]:
    """Create exactly one primary and a deterministic 20% secondary plan."""

    normalised = _normalise_samples(samples)
    _validate_id(catalog_version, "catalog_version")
    if not isinstance(allocation_seed, str) or not allocation_seed:
        raise LabelValidationError("allocation_seed must be a non-empty string")
    doubled = _double_review_sample_ids(
        normalised, double_review_fraction, allocation_seed
    )
    assignments: list[ReviewAssignment] = []
    for sample in normalised:
        stages = (
            ("primary", "secondary") if sample.sample_id in doubled else ("primary",)
        )
        for stage in stages:
            order_seed = candidate_order_seed(
                sample.sample_id,
                stage,
                catalog_version=catalog_version,
                allocation_seed=allocation_seed,
            )
            order = deterministic_candidate_order(sample.candidate_ids, order_seed)
            assignments.append(
                ReviewAssignment(
                    assignment_id=_assignment_identifier(
                        sample_id=sample.sample_id,
                        stage=stage,
                        catalog_version=catalog_version,
                        order_seed=order_seed,
                        candidate_order=order,
                    ),
                    sample_id=sample.sample_id,
                    work_id=sample.work_id,
                    source_page_sha256=sample.source_page_sha256,
                    stage=stage,
                    catalog_version=catalog_version,
                    candidate_order_seed=order_seed,
                    candidate_order=order,
                )
            )
    return tuple(assignments)


def _validate_assignment(assignment: ReviewAssignment) -> None:
    _validate_id(assignment.assignment_id, "assignment.assignment_id")
    _validate_id(assignment.sample_id, "assignment.sample_id")
    _validate_id(assignment.work_id, "assignment.work_id")
    _validate_sha(assignment.source_page_sha256, "assignment.source_page_sha256")
    if assignment.stage not in REVIEW_STAGES:
        raise LabelValidationError("assignment.stage is invalid")
    _validate_id(assignment.catalog_version, "assignment.catalog_version")
    _validate_sha(assignment.candidate_order_seed, "assignment.candidate_order_seed")
    if not assignment.candidate_order:
        raise LabelValidationError("assignment.candidate_order must not be empty")
    if len(assignment.candidate_order) != len(set(assignment.candidate_order)):
        raise LabelValidationError("assignment.candidate_order contains duplicates")
    for candidate in assignment.candidate_order:
        _validate_id(candidate, "assignment.candidate_order item")
    expected_order = deterministic_candidate_order(
        assignment.candidate_order, assignment.candidate_order_seed
    )
    if assignment.candidate_order != expected_order:
        raise LabelValidationError(
            "assignment.candidate_order does not match candidate_order_seed"
        )
    expected_id = _assignment_identifier(
        sample_id=assignment.sample_id,
        stage=assignment.stage,
        catalog_version=assignment.catalog_version,
        order_seed=assignment.candidate_order_seed,
        candidate_order=assignment.candidate_order,
    )
    if assignment.assignment_id != expected_id:
        raise LabelValidationError("assignment.assignment_id content binding failed")
    if (
        assignment.blind_first_pass is not True
        or assignment.font_names_visible is not False
        or assignment.model_suggestions_visible is not False
    ):
        raise LabelValidationError(
            "primary/secondary assignments must hide font names and model proposals"
        )


def _require_mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise LabelValidationError(f"{path} must be an object")
    return value


def _require_keys(
    value: Mapping[str, Any],
    required: set[str],
    optional: set[str],
    path: str,
) -> None:
    missing = sorted(required - set(value))
    extra = sorted(set(value) - required - optional)
    if missing:
        raise LabelValidationError(f"{path} is missing required keys: {missing}")
    if extra:
        raise LabelValidationError(f"{path} has unexpected keys: {extra}")


def _required_string(value: Mapping[str, Any], key: str, path: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise LabelValidationError(f"{path}.{key} must be a non-empty string")
    return item


def _string_tuple(value: Any, path: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise LabelValidationError(f"{path} must be an array of non-empty strings")
    if len(value) != len(set(value)):
        raise LabelValidationError(f"{path} must contain unique strings")
    return tuple(value)


def _validate_id(value: Any, path: str) -> None:
    if not isinstance(value, str) or ID_RE.fullmatch(value) is None:
        raise LabelValidationError(f"{path} is not a valid stable identifier")


def _validate_sha(value: Any, path: str) -> None:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise LabelValidationError(f"{path} must be a lowercase SHA-256")


def _validate_timestamp(value: Any, path: str) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise LabelValidationError(f"{path} must be an RFC3339 UTC timestamp")
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise LabelValidationError(
            f"{path} must be an RFC3339 UTC timestamp"
        ) from error


def _validate_unit_number(value: Any, path: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise LabelValidationError(f"{path} must be a number between 0 and 1")
    if not math.isfinite(float(value)) or not 0.0 <= float(value) <= 1.0:
        raise LabelValidationError(f"{path} must be a number between 0 and 1")


def _validate_enum(value: Any, allowed: Sequence[str], path: str) -> None:
    if value not in allowed:
        raise LabelValidationError(f"{path} has an unsupported value: {value!r}")


def _validate_core_label(
    record: Mapping[str, Any], candidate_ids: Sequence[str] | None
) -> None:
    if record.get("schema_version") != SCHEMA_VERSION:
        raise LabelValidationError("schema_version must be 1")
    for key in ("sample_id", "work_id"):
        _validate_id(record.get(key), key)
    _validate_sha(record.get("source_page_sha256"), "source_page_sha256")

    role = _require_mapping(record.get("role"), "role")
    _require_keys(role, {"primary", "confidence"}, set(), "role")
    _validate_enum(role.get("primary"), ROLE_VALUES, "role.primary")
    _validate_unit_number(role.get("confidence"), "role.confidence")

    style = _require_mapping(record.get("source_style"), "source_style")
    _require_keys(
        style,
        {*STYLE_FIELDS, "unknown_fields"},
        set(),
        "source_style",
    )
    unknown = _string_tuple(style.get("unknown_fields"), "source_style.unknown_fields")
    invalid_unknown = sorted(set(unknown) - set(STYLE_FIELDS))
    if invalid_unknown:
        raise LabelValidationError(
            f"source_style.unknown_fields contains unknown names: {invalid_unknown}"
        )
    for field in STYLE_FIELDS:
        _validate_unit_number(style.get(field), f"source_style.{field}", nullable=True)
        is_unknown = field in unknown
        if (style.get(field) is None) != is_unknown:
            raise LabelValidationError(
                f"source_style.{field} must be null exactly when listed in "
                "source_style.unknown_fields"
            )

    treatment = _require_mapping(record.get("treatment"), "treatment")
    _require_keys(
        treatment,
        {"orientation", "outline", "shadow", "fill", "distortion"},
        set(),
        "treatment",
    )
    allowed_treatment = {
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
    for field, values in allowed_treatment.items():
        _validate_enum(treatment.get(field), values, f"treatment.{field}")

    judgment = _require_mapping(record.get("font_judgment"), "font_judgment")
    _require_keys(
        judgment,
        {*FONT_TIERS, "none_acceptable"},
        set(),
        "font_judgment",
    )
    tier_values: dict[str, tuple[str, ...]] = {}
    seen: dict[str, str] = {}
    for tier in FONT_TIERS:
        values = _string_tuple(judgment.get(tier), f"font_judgment.{tier}")
        tier_values[tier] = values
        for candidate in values:
            _validate_id(candidate, f"font_judgment.{tier} item")
            if candidate in seen:
                raise LabelValidationError(
                    f"font candidate {candidate!r} occurs in both "
                    f"{seen[candidate]} and {tier}"
                )
            seen[candidate] = tier
    if candidate_ids is not None:
        expected = set(candidate_ids)
        if set(seen) != expected:
            missing = sorted(expected - set(seen))
            extra = sorted(set(seen) - expected)
            raise LabelValidationError(
                "font_judgment must partition the complete candidate catalog: "
                f"missing={missing}, unexpected={extra}"
            )
    none_acceptable = judgment.get("none_acceptable")
    if not isinstance(none_acceptable, bool):
        raise LabelValidationError("font_judgment.none_acceptable must be boolean")
    has_acceptable = bool(tier_values["preferred"] or tier_values["acceptable"])
    if none_acceptable == has_acceptable:
        raise LabelValidationError(
            "none_acceptable must be true exactly when preferred and acceptable "
            "are both empty"
        )

    consistency = _require_mapping(record.get("consistency"), "consistency")
    _require_keys(consistency, {"policy", "reason_code"}, set(), "consistency")
    _validate_enum(
        consistency.get("policy"),
        CONSISTENCY_POLICIES,
        "consistency.policy",
    )
    _validate_enum(
        consistency.get("reason_code"),
        CONSISTENCY_REASONS,
        "consistency.reason_code",
    )


def _verify_record_hash(record: Mapping[str, Any]) -> None:
    _validate_sha(record.get("record_sha256"), "record_sha256")
    if record.get("record_sha256") != _record_digest(record):
        raise LabelValidationError("record_sha256 content binding failed")


def validate_review_record(
    record: Mapping[str, Any],
    *,
    assignment: ReviewAssignment | None = None,
    candidate_ids: Sequence[str] | None = None,
) -> None:
    """Validate one sealed blind primary/secondary review record."""

    _require_mapping(record, "record")
    _require_keys(
        record,
        {
            *_CORE_REQUIRED,
            "record_type",
            "label_id",
            "review",
            "record_sha256",
        },
        set(),
        "record",
    )
    if record.get("record_type") != REVIEW_RECORD_TYPE:
        raise LabelValidationError("record_type is not a review record")
    _validate_id(record.get("label_id"), "label_id")
    review = _require_mapping(record.get("review"), "review")
    review_keys = {
        "stage",
        "assignment_id",
        "reviewer",
        "reviewed_at",
        "catalog_version",
        "catalog_sha256",
        "renderer_hash",
        "review_card_sha256",
        "candidate_order_seed",
        "candidate_order",
        "blind_first_pass",
        "font_names_visible",
        "model_suggestions_visible",
        "confidence",
        "flags",
    }
    _require_keys(review, review_keys, set(), "review")
    _validate_enum(review.get("stage"), REVIEW_STAGES, "review.stage")
    for key in ("assignment_id", "reviewer", "catalog_version"):
        _validate_id(review.get(key), f"review.{key}")
    _validate_timestamp(review.get("reviewed_at"), "review.reviewed_at")
    for key in (
        "catalog_sha256",
        "renderer_hash",
        "review_card_sha256",
        "candidate_order_seed",
    ):
        _validate_sha(review.get(key), f"review.{key}")
    order = _string_tuple(review.get("candidate_order"), "review.candidate_order")
    expected_order = deterministic_candidate_order(
        order, str(review.get("candidate_order_seed"))
    )
    if order != expected_order:
        raise LabelValidationError(
            "review.candidate_order does not match candidate_order_seed"
        )
    if (
        review.get("blind_first_pass") is not True
        or review.get("font_names_visible") is not False
        or review.get("model_suggestions_visible") is not False
    ):
        raise LabelValidationError(
            "primary/secondary review must be blind to font names and model proposals"
        )
    _validate_unit_number(review.get("confidence"), "review.confidence")
    flags = _string_tuple(review.get("flags"), "review.flags")
    for flag in flags:
        _validate_enum(flag, REVIEW_FLAGS, "review.flags item")
    if bool(record.get("font_judgment", {}).get("none_acceptable")) != (
        "none_acceptable" in flags
    ):
        raise LabelValidationError(
            "review.flags must contain none_acceptable exactly when the judgment does"
        )
    effective_candidates = tuple(candidate_ids) if candidate_ids is not None else order
    _validate_core_label(record, effective_candidates)
    if assignment is not None:
        bindings = {
            "sample_id": assignment.sample_id,
            "work_id": assignment.work_id,
            "source_page_sha256": assignment.source_page_sha256,
        }
        for field, expected in bindings.items():
            if record.get(field) != expected:
                raise LabelValidationError(
                    f"review record {field} does not match assignment"
                )
        review_bindings = {
            "stage": assignment.stage,
            "assignment_id": assignment.assignment_id,
            "catalog_version": assignment.catalog_version,
            "candidate_order_seed": assignment.candidate_order_seed,
            "candidate_order": list(assignment.candidate_order),
            "blind_first_pass": assignment.blind_first_pass,
            "font_names_visible": assignment.font_names_visible,
            "model_suggestions_visible": assignment.model_suggestions_visible,
        }
        for field, expected in review_bindings.items():
            if review.get(field) != expected:
                raise LabelValidationError(f"review.{field} does not match assignment")
    _verify_record_hash(record)


def validate_final_record(
    record: Mapping[str, Any], *, candidate_ids: Sequence[str] | None = None
) -> None:
    """Validate one sealed final label projection."""

    _require_mapping(record, "record")
    _require_keys(
        record,
        {
            *_CORE_REQUIRED,
            "record_type",
            "final_id",
            "resolution",
            "record_sha256",
        },
        set(),
        "record",
    )
    if record.get("record_type") != FINAL_RECORD_TYPE:
        raise LabelValidationError("record_type is not a final record")
    _validate_id(record.get("final_id"), "final_id")
    _validate_core_label(record, candidate_ids)
    resolution = _require_mapping(record.get("resolution"), "resolution")
    resolution_keys = {
        "kind",
        "resolver",
        "resolved_at",
        "source_label_ids",
        "catalog_version",
        "catalog_sha256",
        "renderer_hash",
        "confidence",
        "flags",
        "notes",
        "adjudication_evidence",
    }
    _require_keys(resolution, resolution_keys, set(), "resolution")
    _validate_enum(resolution.get("kind"), RESOLUTION_KINDS, "resolution.kind")
    for key in ("resolver", "catalog_version"):
        _validate_id(resolution.get(key), f"resolution.{key}")
    _validate_timestamp(resolution.get("resolved_at"), "resolution.resolved_at")
    for key in ("catalog_sha256", "renderer_hash"):
        _validate_sha(resolution.get(key), f"resolution.{key}")
    sources = _string_tuple(
        resolution.get("source_label_ids"), "resolution.source_label_ids"
    )
    if not sources:
        raise LabelValidationError("resolution.source_label_ids must not be empty")
    for source in sources:
        _validate_id(source, "resolution.source_label_ids item")
    _validate_unit_number(resolution.get("confidence"), "resolution.confidence")
    flags = _string_tuple(resolution.get("flags"), "resolution.flags")
    for flag in flags:
        _validate_enum(flag, FINAL_FLAGS, "resolution.flags item")
    notes = resolution.get("notes")
    if not isinstance(notes, str) or len(notes) > 4000:
        raise LabelValidationError("resolution.notes must be a string up to 4000 chars")
    evidence = resolution.get("adjudication_evidence")
    if resolution.get("kind") == "adjudicated":
        evidence = _require_mapping(evidence, "resolution.adjudication_evidence")
        evidence_keys = {
            "review_card_sha256",
            "candidate_order_seed",
            "candidate_order",
            "font_names_visible",
            "model_suggestions_visible",
        }
        _require_keys(
            evidence,
            evidence_keys,
            set(),
            "resolution.adjudication_evidence",
        )
        _validate_sha(
            evidence.get("review_card_sha256"),
            "resolution.adjudication_evidence.review_card_sha256",
        )
        _validate_sha(
            evidence.get("candidate_order_seed"),
            "resolution.adjudication_evidence.candidate_order_seed",
        )
        order = _string_tuple(
            evidence.get("candidate_order"),
            "resolution.adjudication_evidence.candidate_order",
        )
        if candidate_ids is not None and set(order) != set(candidate_ids):
            raise LabelValidationError(
                "adjudication candidate_order must cover the complete catalog"
            )
        if order != deterministic_candidate_order(
            order, str(evidence.get("candidate_order_seed"))
        ):
            raise LabelValidationError(
                "adjudication candidate_order does not match its seed"
            )
        for field in ("font_names_visible", "model_suggestions_visible"):
            if not isinstance(evidence.get(field), bool):
                raise LabelValidationError(
                    f"resolution.adjudication_evidence.{field} must be boolean"
                )
    elif evidence is not None:
        raise LabelValidationError(
            "only adjudicated resolutions may carry adjudication_evidence"
        )
    if record["font_judgment"]["not_reviewed"]:
        raise LabelValidationError("final font_judgment.not_reviewed must be empty")
    if record["role"]["primary"] == "unknown_needs_review":
        raise LabelValidationError("final role cannot remain unknown_needs_review")
    _verify_record_hash(record)


def validate_label_record(
    record: Mapping[str, Any],
    *,
    assignment: ReviewAssignment | None = None,
    candidate_ids: Sequence[str] | None = None,
) -> None:
    """Dispatch semantic validation for either public schema record type."""

    if record.get("record_type") == REVIEW_RECORD_TYPE:
        validate_review_record(
            record, assignment=assignment, candidate_ids=candidate_ids
        )
    elif record.get("record_type") == FINAL_RECORD_TYPE:
        if assignment is not None:
            raise LabelValidationError("final records do not bind to assignments")
        validate_final_record(record, candidate_ids=candidate_ids)
    else:
        raise LabelValidationError("record_type is unsupported")


def _style_disagrees(
    left: Mapping[str, Any], right: Mapping[str, Any], tolerance: float
) -> bool:
    if set(left.get("unknown_fields", [])) != set(right.get("unknown_fields", [])):
        return True
    for field in STYLE_FIELDS:
        left_value = left.get(field)
        right_value = right.get(field)
        if left_value is None or right_value is None:
            if left_value is not right_value:
                return True
        elif abs(float(left_value) - float(right_value)) > tolerance:
            return True
    return False


def review_disagreements(
    primary: Mapping[str, Any],
    secondary: Mapping[str, Any],
    *,
    style_tolerance: float = 0.15,
) -> tuple[str, ...]:
    """Return decision-relevant differences between two blind reviews."""

    if not 0.0 <= style_tolerance <= 1.0:
        raise LabelValidationError("style_tolerance must be between 0 and 1")
    reasons: list[str] = []
    if primary["role"]["primary"] != secondary["role"]["primary"]:
        reasons.append("role_disagreement")
    if _style_disagrees(
        primary["source_style"], secondary["source_style"], style_tolerance
    ):
        reasons.append("source_style_disagreement")
    if primary["treatment"] != secondary["treatment"]:
        reasons.append("treatment_disagreement")
    left_judgment = primary["font_judgment"]
    right_judgment = secondary["font_judgment"]
    if (
        any(
            set(left_judgment[tier]) != set(right_judgment[tier]) for tier in FONT_TIERS
        )
        or left_judgment["none_acceptable"] != right_judgment["none_acceptable"]
    ):
        reasons.append("font_tier_disagreement")
    if primary["consistency"] != secondary["consistency"]:
        reasons.append("consistency_disagreement")
    return tuple(reasons)


_RECALC_REASON_ORDER = {
    reason: index
    for index, reason in enumerate(
        (
            "manual_recrop",
            "crop_needs_review",
            "rendering_issue",
            "catalog_gap",
            "role_disagreement",
            "font_tier_disagreement",
            "treatment_disagreement",
            "source_style_disagreement",
            "consistency_disagreement",
            "none_acceptable",
            "role_unknown",
            "candidate_not_reviewed",
            "low_confidence",
            "role_uncertain",
            "policy_uncertain",
        )
    )
}


def _review_recalculation_reasons(
    record: Mapping[str, Any], low_confidence_threshold: float
) -> set[str]:
    reasons: set[str] = set()
    if record["font_judgment"]["none_acceptable"]:
        reasons.add("none_acceptable")
    if record["font_judgment"]["not_reviewed"]:
        reasons.add("candidate_not_reviewed")
    if record["role"]["primary"] == "unknown_needs_review":
        reasons.add("role_unknown")
    if min(record["role"]["confidence"], record["review"]["confidence"]) < (
        low_confidence_threshold
    ):
        reasons.add("low_confidence")
    for flag in record["review"]["flags"]:
        if flag in {
            "low_confidence",
            "crop_needs_review",
            "catalog_gap",
            "rendering_issue",
            "role_uncertain",
            "policy_uncertain",
            "manual_recrop",
        }:
            reasons.add(flag)
    return reasons


def _normalise_assignments(
    assignments: Iterable[ReviewAssignment | Mapping[str, Any]],
) -> tuple[ReviewAssignment, ...]:
    output = tuple(
        assignment
        if isinstance(assignment, ReviewAssignment)
        else ReviewAssignment.from_mapping(assignment)
        for assignment in assignments
    )
    for assignment in output:
        _validate_assignment(assignment)
    ids = [assignment.assignment_id for assignment in output]
    if len(ids) != len(set(ids)):
        raise LabelValidationError("assignments contain duplicate assignment_id")
    pairs = [(assignment.sample_id, assignment.stage) for assignment in output]
    if len(pairs) != len(set(pairs)):
        raise LabelValidationError(
            "assignments contain duplicate sample_id/review stage pairs"
        )
    return output


def validate_exactly_once_ledger(
    samples: Iterable[ReviewSample | Mapping[str, Any]],
    assignments: Iterable[ReviewAssignment | Mapping[str, Any]],
    review_records: Iterable[Mapping[str, Any]],
    *,
    final_records: Iterable[Mapping[str, Any]] | None = None,
    minimum_double_review_fraction: float = 0.2,
    low_confidence_threshold: float = 0.75,
    style_tolerance: float = 0.15,
    manual_recrop_ids: Iterable[str] = (),
) -> LedgerValidationReport:
    """Validate complete blind reviews and, optionally, final projections.

    When ``final_records`` is omitted the report exposes the deterministic
    recalculation queue and ``completion_ready`` is false.  Passing final
    records is the completion gate: exactly one final label must exist for
    every sample, and every queued sample must use an ``adjudicated`` result.
    """

    normalised_samples = _normalise_samples(samples)
    sample_by_id = {sample.sample_id: sample for sample in normalised_samples}
    normalised_assignments = _normalise_assignments(assignments)
    assignment_by_id = {
        assignment.assignment_id: assignment for assignment in normalised_assignments
    }

    if isinstance(minimum_double_review_fraction, bool) or not isinstance(
        minimum_double_review_fraction, (int, float)
    ):
        raise LabelValidationError("minimum_double_review_fraction must be numeric")
    minimum_double_review_fraction = float(minimum_double_review_fraction)
    if not 0.0 <= minimum_double_review_fraction <= 1.0:
        raise LabelValidationError(
            "minimum_double_review_fraction must be between 0 and 1"
        )
    _validate_unit_number(low_confidence_threshold, "low_confidence_threshold")
    _validate_unit_number(style_tolerance, "style_tolerance")

    assignment_by_pair: dict[tuple[str, str], ReviewAssignment] = {}
    for assignment in normalised_assignments:
        sample = sample_by_id.get(assignment.sample_id)
        if sample is None:
            raise LabelValidationError(
                f"assignment targets unknown sample {assignment.sample_id!r}"
            )
        if (
            assignment.work_id != sample.work_id
            or assignment.source_page_sha256 != sample.source_page_sha256
            or set(assignment.candidate_order) != set(sample.candidate_ids)
        ):
            raise LabelValidationError(
                f"assignment binding differs from sample {sample.sample_id!r}"
            )
        assignment_by_pair[(assignment.sample_id, assignment.stage)] = assignment
    missing_primary = sorted(
        sample.sample_id
        for sample in normalised_samples
        if (sample.sample_id, "primary") not in assignment_by_pair
    )
    if missing_primary:
        raise LabelValidationError(
            f"every sample needs exactly one primary assignment: {missing_primary[:8]}"
        )
    secondary_ids = {
        sample_id for sample_id, stage in assignment_by_pair if stage == "secondary"
    }
    minimum_secondary = math.ceil(
        len(normalised_samples) * minimum_double_review_fraction
    )
    if len(secondary_ids) < minimum_secondary:
        raise LabelValidationError(
            "secondary assignment coverage is below the required fraction: "
            f"{len(secondary_ids)}/{len(normalised_samples)} < "
            f"{minimum_double_review_fraction:.3f}"
        )

    records = tuple(review_records)
    by_assignment: dict[str, Mapping[str, Any]] = {}
    label_ids: set[str] = set()
    for index, record in enumerate(records):
        review = _require_mapping(record.get("review"), f"reviews[{index}].review")
        assignment_id = review.get("assignment_id")
        if not isinstance(assignment_id, str) or assignment_id not in assignment_by_id:
            raise LabelValidationError(
                f"reviews[{index}] targets an unknown assignment"
            )
        if assignment_id in by_assignment:
            raise LabelValidationError(
                f"assignment {assignment_id!r} was reviewed more than once"
            )
        assignment = assignment_by_id[assignment_id]
        sample = sample_by_id[assignment.sample_id]
        validate_review_record(
            record,
            assignment=assignment,
            candidate_ids=sample.candidate_ids,
        )
        label_id = str(record["label_id"])
        if label_id in label_ids:
            raise LabelValidationError(f"duplicate label_id: {label_id!r}")
        label_ids.add(label_id)
        by_assignment[assignment_id] = record
    missing_reviews = sorted(set(assignment_by_id) - set(by_assignment))
    if missing_reviews:
        raise LabelValidationError(
            "review ledger must cover every assignment exactly once: "
            f"missing={missing_reviews[:8]}"
        )
    if len(records) != len(normalised_assignments):
        raise LabelValidationError(
            "review ledger count does not match assignment count"
        )
    catalog_bindings = {
        (
            record["review"]["catalog_version"],
            record["review"]["catalog_sha256"],
            record["review"]["renderer_hash"],
        )
        for record in records
    }
    if len(catalog_bindings) != 1:
        raise LabelValidationError("review ledger mixes catalog or renderer versions")

    records_by_sample: dict[str, dict[str, Mapping[str, Any]]] = {}
    for assignment_id, record in by_assignment.items():
        assignment = assignment_by_id[assignment_id]
        records_by_sample.setdefault(assignment.sample_id, {})[assignment.stage] = (
            record
        )
    for sample_id in secondary_ids:
        primary_reviewer = records_by_sample[sample_id]["primary"]["review"]["reviewer"]
        secondary_reviewer = records_by_sample[sample_id]["secondary"]["review"][
            "reviewer"
        ]
        if primary_reviewer == secondary_reviewer:
            raise LabelValidationError(
                f"secondary review for {sample_id!r} is not independent"
            )

    manual_recrops = set(manual_recrop_ids)
    unknown_recrops = sorted(manual_recrops - set(sample_by_id))
    if unknown_recrops:
        raise LabelValidationError(
            f"manual_recrop_ids contains unknown samples: {unknown_recrops[:8]}"
        )
    recalc_items: list[RecalculationItem] = []
    for sample in normalised_samples:
        sample_records = records_by_sample[sample.sample_id]
        reasons: set[str] = set()
        for record in sample_records.values():
            reasons.update(
                _review_recalculation_reasons(record, float(low_confidence_threshold))
            )
        if "secondary" in sample_records:
            reasons.update(
                review_disagreements(
                    sample_records["primary"],
                    sample_records["secondary"],
                    style_tolerance=float(style_tolerance),
                )
            )
        if sample.sample_id in manual_recrops:
            reasons.add("manual_recrop")
        if reasons:
            ordered_reasons = tuple(
                sorted(
                    reasons,
                    key=lambda reason: (
                        _RECALC_REASON_ORDER.get(reason, len(_RECALC_REASON_ORDER)),
                        reason,
                    ),
                )
            )
            sources = tuple(
                sample_records[stage]["label_id"]
                for stage in REVIEW_STAGES
                if stage in sample_records
            )
            recalc_items.append(
                RecalculationItem(sample.sample_id, ordered_reasons, sources)
            )
    recalc_by_id = {item.sample_id: item for item in recalc_items}

    final_count = 0
    completion_ready = False
    if final_records is not None:
        finals = tuple(final_records)
        final_count = len(finals)
        final_by_sample: dict[str, Mapping[str, Any]] = {}
        final_ids: set[str] = set()
        for index, record in enumerate(finals):
            sample_id = record.get("sample_id")
            if not isinstance(sample_id, str) or sample_id not in sample_by_id:
                raise LabelValidationError(f"finals[{index}] targets an unknown sample")
            if sample_id in final_by_sample:
                raise LabelValidationError(
                    f"sample {sample_id!r} has more than one final record"
                )
            sample = sample_by_id[sample_id]
            if (
                record.get("work_id") != sample.work_id
                or record.get("source_page_sha256") != sample.source_page_sha256
            ):
                raise LabelValidationError(
                    f"final record binding differs from sample {sample_id!r}"
                )
            validate_final_record(record, candidate_ids=sample.candidate_ids)
            final_id = str(record["final_id"])
            if final_id in final_ids:
                raise LabelValidationError(f"duplicate final_id: {final_id!r}")
            final_ids.add(final_id)
            sample_reviews = records_by_sample[sample_id]
            expected_sources = {
                review["label_id"] for review in sample_reviews.values()
            }
            actual_sources = set(record["resolution"]["source_label_ids"])
            if actual_sources != expected_sources:
                raise LabelValidationError(
                    f"final record for {sample_id!r} must bind all blind reviews"
                )
            kind = record["resolution"]["kind"]
            if sample_id in recalc_by_id and kind != "adjudicated":
                raise LabelValidationError(
                    f"queued sample {sample_id!r} requires adjudicated resolution"
                )
            if kind == "primary" and "secondary" in sample_reviews:
                raise LabelValidationError(
                    f"double-reviewed sample {sample_id!r} cannot use primary resolution"
                )
            if kind == "blind_agreement":
                if "secondary" not in sample_reviews:
                    raise LabelValidationError(
                        f"blind_agreement for {sample_id!r} lacks secondary review"
                    )
                disagreements = review_disagreements(
                    sample_reviews["primary"],
                    sample_reviews["secondary"],
                    style_tolerance=float(style_tolerance),
                )
                if disagreements:
                    raise LabelValidationError(
                        f"blind_agreement for {sample_id!r} still disagrees"
                    )
            if kind in {"primary", "blind_agreement"}:
                primary = sample_reviews["primary"]
                decision_fields = (
                    "role",
                    "source_style",
                    "treatment",
                    "font_judgment",
                    "consistency",
                )
                if any(record[field] != primary[field] for field in decision_fields):
                    raise LabelValidationError(
                        f"non-adjudicated final for {sample_id!r} must project "
                        "the primary decision exactly"
                    )
            final_by_sample[sample_id] = record
        missing_finals = sorted(set(sample_by_id) - set(final_by_sample))
        if missing_finals:
            raise LabelValidationError(
                "final ledger must contain every sample exactly once: "
                f"missing={missing_finals[:8]}"
            )
        if len(finals) != len(normalised_samples):
            raise LabelValidationError(
                "final ledger count does not match expected sample count"
            )
        # Mixing catalog/renderer builds would silently turn font identity into
        # different targets.  Freeze both across review and final ledgers.
        catalog_bindings |= {
            (
                record["resolution"]["catalog_version"],
                record["resolution"]["catalog_sha256"],
                record["resolution"]["renderer_hash"],
            )
            for record in finals
        }
        if len(catalog_bindings) != 1:
            raise LabelValidationError(
                "review/final ledgers mix catalog or renderer versions"
            )
        completion_ready = True

    return LedgerValidationReport(
        sample_count=len(normalised_samples),
        assignment_count=len(normalised_assignments),
        primary_review_count=len(normalised_samples),
        secondary_review_count=len(secondary_ids),
        double_review_sample_count=len(secondary_ids),
        double_review_fraction=(len(secondary_ids) / len(normalised_samples)),
        recalculation_queue=tuple(recalc_items),
        final_record_count=final_count,
        completion_ready=completion_ready,
    )


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise LabelValidationError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, dict):
                raise LabelValidationError(
                    f"{path}:{line_number}: expected a JSON object"
                )
            rows.append(value)
    return rows


def write_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = b"".join(canonical_json_bytes(row) + b"\n" for row in rows)
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
    finally:
        if temporary.exists():
            temporary.unlink()


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build and validate blind MangaFontMatcher label ledgers."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    schema = subparsers.add_parser("schema", help="Emit the JSON Schema.")
    schema.add_argument("--output", type=Path)

    plan = subparsers.add_parser(
        "plan", help="Create primary plus deterministic double-review assignments."
    )
    plan.add_argument("--samples", type=Path, required=True)
    plan.add_argument("--output", type=Path, required=True)
    plan.add_argument("--catalog-version", required=True)
    plan.add_argument("--allocation-seed", required=True)
    plan.add_argument("--double-review-fraction", type=float, default=0.2)

    validate = subparsers.add_parser(
        "validate", help="Validate exactly-once reviews and optional final labels."
    )
    validate.add_argument("--samples", type=Path, required=True)
    validate.add_argument("--assignments", type=Path, required=True)
    validate.add_argument("--reviews", type=Path, required=True)
    validate.add_argument("--finals", type=Path)
    validate.add_argument("--report", type=Path)
    validate.add_argument("--minimum-double-review-fraction", type=float, default=0.2)
    validate.add_argument("--low-confidence-threshold", type=float, default=0.75)
    validate.add_argument("--style-tolerance", type=float, default=0.15)
    validate.add_argument(
        "--manual-recrop-id",
        action="append",
        default=[],
        help="Sample ID that must enter the recalculation queue. May be repeated.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        if args.command == "schema":
            payload = (
                json.dumps(
                    label_json_schema(), ensure_ascii=False, indent=2, sort_keys=True
                )
                + "\n"
            )
            if args.output is None:
                print(payload, end="")
            else:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(payload, encoding="utf-8")
            return 0
        if args.command == "plan":
            samples = [
                ReviewSample.from_mapping(row) for row in read_jsonl(args.samples)
            ]
            assignments = build_blind_review_assignments(
                samples,
                catalog_version=args.catalog_version,
                allocation_seed=args.allocation_seed,
                double_review_fraction=args.double_review_fraction,
            )
            write_jsonl(
                args.output, (assignment.as_dict() for assignment in assignments)
            )
            print(
                f"Wrote {len(assignments)} blind assignments for "
                f"{len(samples)} samples -> {args.output}"
            )
            return 0
        if args.command == "validate":
            report = validate_exactly_once_ledger(
                read_jsonl(args.samples),
                read_jsonl(args.assignments),
                read_jsonl(args.reviews),
                final_records=(read_jsonl(args.finals) if args.finals else None),
                minimum_double_review_fraction=args.minimum_double_review_fraction,
                low_confidence_threshold=args.low_confidence_threshold,
                style_tolerance=args.style_tolerance,
                manual_recrop_ids=args.manual_recrop_id,
            )
            payload = (
                json.dumps(
                    report.as_dict(), ensure_ascii=False, indent=2, sort_keys=True
                )
                + "\n"
            )
            if args.report is None:
                print(payload, end="")
            else:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(payload, encoding="utf-8")
            return 0
        raise LabelValidationError(f"unsupported command: {args.command}")
    except (OSError, LabelValidationError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
