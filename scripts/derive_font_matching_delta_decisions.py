#!/usr/bin/env python3
"""Derive blind seven-font decisions from candidate-free source annotations.

This module implements the structured v5 two-stage review contract:

1. A reviewer records *only* source evidence (glyph/crop completeness, semantic
   evidence, family, six style axes, hard axes, and treatment).  Candidate
   aliases and earlier answers are forbidden in that artifact.
2. This program binds that evidence to a sealed blind task and applies the
   frozen v4 prototypes, role weights, hard gates, distance thresholds, and
   safe-set cap.  It writes the standard blind-decision JSONL plus a sealed
   alias-only gate/distance audit.

The source annotation JSONL has one record per ``sample_id``::

    {
      "schema_version": "font-matching-delta-source-annotation-v5",
      "record_type": "font_matching_delta_source_annotation",
      "assignment_id": "fmra_...",
      "sample_id": "fm_...",
      "stage": "primary",
      "reviewer_id": "reviewer-a",
      "batch_id": "round4-primary",
      "batch_size": 60,
      "batch_task_set_sha256": "...",
      "source_only_card_sha256": "...",
      "eligibility_evidence": {
        "complete_text_object": true,
        "single_source_skeleton": true,
        "clean_glyph_isolation": true,
        "role_context_sufficient": true,
        "font_signal_skeleton_present": true,
        "crop_issue": "none"
      },
      "role_evidence": {
        "label": false,
        "sfx_event": "none",
        "comic_timing": false,
        "external_utterance": true,
        "independent_aside": false,
        "same_utterance_contrast": false,
        "shout_cues": [],
        "whisper": false,
        "inner_thought": false,
        "narrator": false,
        "other": false
      },
      "source_family": "sans_printed",
      "source_family_confidence": 0.92,
      "serif_evidence": {
        "raw": {
          "thick_thin_glyph_ids": [],
          "terminal_serif_glyph_ids": []
        },
        "glyph_view": {
          "thick_thin_glyph_ids": [],
          "terminal_serif_glyph_ids": []
        },
        "cross_view_glyph_ids": []
      },
      "axes": {
        "weight": 2.5, "width": 2.0, "roundness": 2.0,
        "handwritten": 0.0, "angularity": 1.5, "energy": 1.5
      },
      "hard_axes": ["weight", "handwritten"],
      "treatment": {
        "outline": false, "shadow": false, "inverse_fill": false,
        "texture": false, "distortion": false, "rotation": false
      },
      "rationale": "Candidate-free description of the visible source.",
      "record_sha256": "..."
    }

Every source annotation is write-once and sealed.  It binds the reviewer,
assignment, stage, source-only card, and the complete A-batch task set.  The
candidate-stage derivation is therefore impossible until every assigned A
record exists and validates.  Blind task, annotation, and audit records are
all required to be sealed.
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
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SOURCE_TASK_SCHEMA_VERSION = "font-matching-delta-source-task-v5"
SOURCE_TASK_RECORD_TYPE = "font_matching_delta_source_task"
TASK_SCHEMA_VERSION = "font-matching-catalog-delta-candidate-task-v5"
SOURCE_SCHEMA_VERSION = "font-matching-delta-source-annotation-v5"
AUDIT_SCHEMA_VERSION = "font-matching-delta-decision-audit-v5"
RELEASE_SCHEMA_VERSION = "font-matching-delta-candidate-release-v5"
TASK_RECORD_TYPE = "font_catalog_delta_blind_task"
SOURCE_RECORD_TYPE = "font_matching_delta_source_annotation"
AUDIT_RECORD_TYPE = "font_matching_delta_decision_audit"
RELEASE_RECORD_TYPE = "font_matching_delta_candidate_release"
SOURCE_COMMIT_SCHEMA_VERSION = "font-matching-delta-source-commit-v5"
SOURCE_COMMIT_RECORD_TYPE = "font_matching_delta_source_commit"

AXES = ("weight", "width", "roundness", "handwritten", "angularity", "energy")
TIERS = ("preferred", "acceptable", "marginal", "unacceptable", "unrenderable")
ELIGIBILITY_VALUES = (
    "font_signal_present",
    "font_signal_absent",
    "crop_needs_review",
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
    "unknown_needs_review",
)
FAMILY_VALUES = (
    "serif_printed",
    "sans_printed",
    "handwritten",
    "display",
    "mixed_or_unknown",
)
CROP_ISSUES = (
    "none",
    "cut_text",
    "neighbor_text",
    "art_or_pattern",
    "review_overlay",
    "mixed_logo",
    "other",
)
SFX_EVENTS = ("none", "impact", "motion", "ambient", "emotion")
SHOUT_CUES = (
    "semantic_high_volume",
    "size_or_weight",
    "balloon_or_background",
)
ALIAS_RE = re.compile(r"^ko-candidate-[0-9a-f]{16}$")
ALIAS_ANYWHERE_RE = re.compile(r"ko-candidate-[0-9a-f]{16}", re.IGNORECASE)
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
PRIOR_ANSWER_RE = re.compile(
    r"(?:\b(?:prior|previous|earlier)\s+(?:answer|decision|tier|label|review)\b|"
    r"(?:이전|기존)\s*(?:답|답변|판정|등급|티어|라벨|검수))",
    re.IGNORECASE,
)

# These are the seven identities behind the frozen aliases.  They are present
# only in the source-only leak guard and never emitted.  The ledger repeats the
# same check against its authoritative catalog-derived identity token set.
FROZEN_IDENTITY_TOKENS = frozenset(
    token.casefold()
    for token in (
        "black-and-white-picture",
        "black and white picture",
        "mgt black and white picture",
        "black-han-sans",
        "black han sans",
        "mgt black han sans",
        "gasoek-one",
        "gasoek one",
        "mgt gasoek one",
        "gugi",
        "mgt gugi",
        "kirang-haerang",
        "kirang haerang",
        "mgt kirang haerang",
        "nanum-brush-script",
        "nanum brush script",
        "mgt nanum brush script",
        "single-day",
        "single day",
        "mgt single day",
    )
)

# Frozen blind prototypes from review rubric v4.  No real font identity is
# present here or in either output artifact.
PROTOTYPES: dict[str, dict[str, Any]] = {
    "ko-candidate-2a5d12c7e8f32c30": {
        "family": "handwritten",
        "axes": dict(zip(AXES, (1.5, 2.0, 1.5, 3.0, 3.0, 2.5), strict=True)),
    },
    "ko-candidate-a0144e95710224a2": {
        "family": "display",
        "axes": dict(zip(AXES, (3.5, 2.0, 1.0, 0.0, 3.0, 3.5), strict=True)),
    },
    "ko-candidate-9ee53bb2477d92a2": {
        "family": "handwritten",
        "axes": dict(zip(AXES, (1.5, 2.0, 3.0, 2.5, 1.5, 1.5), strict=True)),
    },
    "ko-candidate-e7b4692fa6ce4ebc": {
        "family": "display",
        "axes": dict(zip(AXES, (4.0, 1.5, 0.5, 0.0, 4.0, 4.0), strict=True)),
    },
    "ko-candidate-cd8774e1d647c522": {
        "family": "sans_printed",
        "axes": dict(zip(AXES, (2.0, 1.5, 1.5, 0.0, 2.0, 1.0), strict=True)),
    },
    "ko-candidate-f11ed4e82c1eacf1": {
        "family": "handwritten",
        "axes": dict(zip(AXES, (0.5, 2.5, 2.5, 4.0, 2.0, 2.0), strict=True)),
    },
    "ko-candidate-4cc309d56243eb25": {
        "family": "sans_printed",
        "axes": dict(zip(AXES, (2.5, 2.0, 2.0, 0.0, 1.5, 1.5), strict=True)),
    },
}
FROZEN_ALIAS_ORDER = tuple(PROTOTYPES)

ROLE_WEIGHTS: dict[str, dict[str, float]] = {
    "ordinary": dict(zip(AXES, (0.20, 0.20, 0.15, 0.20, 0.10, 0.15), strict=True)),
    "aside_whisper": dict(zip(AXES, (0.10, 0.10, 0.15, 0.30, 0.15, 0.20), strict=True)),
    "emphasis_shout": dict(
        zip(AXES, (0.25, 0.10, 0.10, 0.10, 0.20, 0.25), strict=True)
    ),
    "impact": dict(zip(AXES, (0.25, 0.10, 0.05, 0.10, 0.25, 0.25), strict=True)),
    "motion": dict(zip(AXES, (0.10, 0.15, 0.10, 0.25, 0.20, 0.20), strict=True)),
    "ambient": dict(zip(AXES, (0.15, 0.15, 0.20, 0.20, 0.10, 0.20), strict=True)),
    "emotion": dict(zip(AXES, (0.10, 0.10, 0.20, 0.30, 0.10, 0.20), strict=True)),
    "comic": dict(zip(AXES, (0.20, 0.10, 0.20, 0.15, 0.10, 0.25), strict=True)),
    "sign": dict(zip(AXES, (0.20, 0.20, 0.15, 0.05, 0.20, 0.20), strict=True)),
    "other": dict(zip(AXES, (1 / 6,) * 6, strict=True)),
}

ROLE_WEIGHT_GROUP = {
    "dialogue": "ordinary",
    "narration": "ordinary",
    "thought": "ordinary",
    "whisper": "aside_whisper",
    "aside_balloon_edge": "aside_whisper",
    "emphasis_dialogue": "emphasis_shout",
    "shout": "emphasis_shout",
    "sfx_impact": "impact",
    "sfx_motion": "motion",
    "sfx_ambient": "ambient",
    "sfx_emotion": "emotion",
    "sfx_comic": "comic",
    "sign_ui_title": "sign",
    "other": "other",
    "unknown_needs_review": "other",
}

ANNOTATION_KEYS = {
    "schema_version",
    "record_type",
    "assignment_id",
    "sample_id",
    "stage",
    "reviewer_id",
    "batch_id",
    "batch_size",
    "batch_task_set_sha256",
    "source_only_card_sha256",
    "eligibility_evidence",
    "role_evidence",
    "source_family",
    "source_family_confidence",
    "serif_evidence",
    "axes",
    "hard_axes",
    "treatment",
    "rationale",
}
ADJUDICATION_ANNOTATION_KEYS = ANNOTATION_KEYS | {
    "source_review_record_sha256s",
}
ELIGIBILITY_KEYS = {
    "complete_text_object",
    "single_source_skeleton",
    "clean_glyph_isolation",
    "role_context_sufficient",
    "font_signal_skeleton_present",
    "crop_issue",
}
ROLE_EVIDENCE_KEYS = {
    "label",
    "sfx_event",
    "comic_timing",
    "external_utterance",
    "independent_aside",
    "same_utterance_contrast",
    "shout_cues",
    "whisper",
    "inner_thought",
    "narrator",
    "other",
}
SERIF_EVIDENCE_KEYS = {"raw", "glyph_view", "cross_view_glyph_ids"}
SERIF_VIEW_KEYS = {"thick_thin_glyph_ids", "terminal_serif_glyph_ids"}
TREATMENT_KEYS = {
    "outline",
    "shadow",
    "inverse_fill",
    "texture",
    "distortion",
    "rotation",
}
DECISION_KEYS = {
    "assignment_id",
    "candidate_release_record_sha256",
    "candidate_order_seed",
    "confidence",
    "eligibility",
    "font_judgment",
    "rationale",
    "review_card_sha256",
    "release_challenge_sha256",
    "release_nonce_sha256",
    "role",
    "role_confidence",
    "sample_id",
}
AUDIT_KEYS = {
    "schema_version",
    "record_type",
    "assignment_id",
    "sample_id",
    "stage",
    "reviewer_id",
    "batch_id",
    "batch_size",
    "batch_task_set_sha256",
    "task_record_sha256",
    "source_task_record_sha256",
    "source_annotation_record_sha256",
    "source_annotation_canonical_sha256",
    "candidate_order_seed",
    "candidate_release_record_sha256",
    "release_challenge_sha256",
    "release_nonce_sha256",
    "full_card_sha256",
    "source_only_card_sha256",
    "candidate_only_card_sha256",
    "eligibility",
    "role",
    "role_basis",
    "role_weight_group",
    "source_family",
    "source_family_confidence",
    "effective_family_gate",
    "family_gate_notes",
    "source_axes",
    "hard_axes",
    "treatment_observed_not_scored",
    "candidates",
    "safe_count",
    "none_audit",
    "decision_sha256",
    "record_sha256",
}

SOURCE_TASK_KEYS = {
    "schema_version",
    "record_type",
    "assignment_id",
    "sample_id",
    "stage",
    "review_order",
    "source_only_card_sha256",
    "review_surface",
    "record_sha256",
}
TASK_KEYS = {
    "schema_version",
    "record_type",
    "assignment_id",
    "sample_id",
    "stage",
    "review_order",
    "candidate_batch_order",
    "source_task_record_sha256",
    "source_annotation_record_sha256",
    "blind_alias_order",
    "candidate_count",
    "candidate_order_seed",
    "mandatory_unrenderable",
    "full_card_sha256",
    "source_only_card_sha256",
    "candidate_only_card_sha256",
    "neutral_tie_anchors",
    "candidate_release_id",
    "candidate_release_record_sha256",
    "release_nonce_sha256",
    "release_challenge_sha256",
    "review_surface",
    "record_sha256",
}
ANCHOR_KEYS = {"chapter_sha256", "work_sha256"}
SOURCE_REVIEW_SURFACE = {
    "candidate_metadata_visible": False,
    "candidate_pixels_visible": False,
    "source_only": True,
    "write_once_before_candidate_release": True,
}
REVIEW_SURFACE = {
    "candidate_identity": "blind_alias_only",
    "font_names_visible": False,
    "model_suggestions_visible": False,
    "prior_tiers_visible": False,
    "source_candidate_files_physically_separate": True,
    "source_annotation_sealed_before_candidate_release": True,
    "source_pixels_visible_during_candidate_stage": False,
}
RELEASE_ENTRY_KEYS = {
    "assignment_id",
    "sample_id",
    "source_task_record_sha256",
    "source_annotation_record_sha256",
    "candidate_batch_order",
    "blind_alias_order",
    "candidate_order_seed",
    "mandatory_unrenderable",
    "full_card_sha256",
    "source_only_card_sha256",
    "candidate_only_card_sha256",
    "neutral_tie_anchors",
}
RELEASE_KEYS = {
    "schema_version",
    "record_type",
    "release_id",
    "source_commit_id",
    "source_commit_record_sha256",
    "stage",
    "reviewer_id",
    "batch_id",
    "batch_size",
    "batch_task_set_sha256",
    "release_nonce",
    "release_nonce_sha256",
    "entries",
    "released_at",
    "record_sha256",
}
SOURCE_COMMIT_KEYS = {
    "schema_version",
    "record_type",
    "commit_id",
    "stage",
    "reviewer_id",
    "batch_id",
    "batch_size",
    "batch_task_set_sha256",
    "annotation_jsonl_sha256",
    "previous_commit_record_sha256",
    "annotations",
    "committed_at",
    "record_sha256",
}


class DerivationError(ValueError):
    """Raised when an input or derived artifact violates the frozen contract."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def seal_record(value: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(value))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise DerivationError(f"{location} must be an object")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], location: str
) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise DerivationError(
            f"{location} keys mismatch; missing={missing}, extra={extra}"
        )


def _require_bool(value: Any, location: str) -> bool:
    if not isinstance(value, bool):
        raise DerivationError(f"{location} must be boolean")
    return value


def _require_unit(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DerivationError(f"{location} must be a number in [0, 1]")
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise DerivationError(f"{location} must be a finite number in [0, 1]")
    return result


def _require_id(value: Any, location: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise DerivationError(f"{location} must be a stable identifier")
    return value


def _require_sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise DerivationError(f"{location} must be a lowercase SHA-256")
    return value


def _require_text(value: Any, location: str, minimum: int = 1) -> str:
    if not isinstance(value, str):
        raise DerivationError(f"{location} must be text")
    result = value.strip()
    if len(result) < minimum or len(result) > 4000:
        raise DerivationError(f"{location} must be {minimum}..4000 characters")
    return result


def _validate_seal(record: Mapping[str, Any], location: str, *, required: bool) -> None:
    digest = record.get("record_sha256")
    if digest is None and not required:
        return
    _require_sha(digest, f"{location}.record_sha256")
    payload = dict(record)
    payload.pop("record_sha256", None)
    expected = sha256_bytes(canonical_json_bytes(payload))
    if digest != expected:
        raise DerivationError(f"{location}.record_sha256 does not seal the record")


def _walk_source_only(value: Any, location: str) -> None:
    """Reject candidate aliases and recognizable earlier-answer disclosures."""

    if isinstance(value, Mapping):
        forbidden_keys = {
            "preferred",
            "acceptable",
            "marginal",
            "unacceptable",
            "unrenderable",
            "none_acceptable",
            "font_judgment",
            "candidate_alias",
            "candidate_aliases",
            "prior",
            "prior_answer",
            "prior_answers",
            "prior_role",
            "prior_tier",
            "prior_decision",
        }
        for key, child in value.items():
            if str(key).casefold() in forbidden_keys:
                raise DerivationError(
                    f"{location}.{key} exposes a candidate/prior answer"
                )
            _walk_source_only(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _walk_source_only(child, f"{location}[{index}]")
    elif isinstance(value, str):
        if ALIAS_ANYWHERE_RE.search(value):
            raise DerivationError(f"{location} exposes a blind candidate alias")
        if PRIOR_ANSWER_RE.search(value):
            raise DerivationError(f"{location} exposes a prior answer")
        folded = value.casefold()
        for token in FROZEN_IDENTITY_TOKENS:
            if len(token) >= 4 and token in folded:
                raise DerivationError(f"{location} exposes a candidate identity")


def _require_id_array(value: Any, location: str) -> list[str]:
    if not isinstance(value, list):
        raise DerivationError(f"{location} must be an array")
    result = [
        _require_id(item, f"{location}[{index}]") for index, item in enumerate(value)
    ]
    if len(result) != len(set(result)):
        raise DerivationError(f"{location} must contain unique glyph identifiers")
    return result


def _require_sha_array(value: Any, location: str) -> list[str]:
    if not isinstance(value, list):
        raise DerivationError(f"{location} must be an array")
    result = [
        _require_sha(item, f"{location}[{index}]") for index, item in enumerate(value)
    ]
    if len(result) != len(set(result)):
        raise DerivationError(f"{location} must contain unique SHA-256 values")
    return result


def _axis_value(value: Any, location: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DerivationError(f"{location} must be null or a 0.5-step number in [0, 4]")
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= 4:
        raise DerivationError(f"{location} must be null or a 0.5-step number in [0, 4]")
    doubled = result * 2
    if not math.isclose(doubled, round(doubled), abs_tol=1e-9):
        raise DerivationError(f"{location} must use 0.5 increments")
    return result


def _validate_role_evidence(
    evidence: Mapping[str, Any], location: str
) -> dict[str, Any]:
    _require_exact_keys(evidence, ROLE_EVIDENCE_KEYS, location)
    normalized: dict[str, Any] = {}
    for key in ROLE_EVIDENCE_KEYS - {"sfx_event", "shout_cues"}:
        normalized[key] = _require_bool(evidence.get(key), f"{location}.{key}")
    sfx_event = evidence.get("sfx_event")
    if sfx_event not in SFX_EVENTS:
        raise DerivationError(f"{location}.sfx_event is unsupported")
    normalized["sfx_event"] = str(sfx_event)
    shout_cues = evidence.get("shout_cues")
    if not isinstance(shout_cues, list) or any(
        not isinstance(item, str) for item in shout_cues
    ):
        raise DerivationError(f"{location}.shout_cues must be an array")
    if len(shout_cues) != len(set(shout_cues)) or not set(shout_cues).issubset(
        SHOUT_CUES
    ):
        raise DerivationError(f"{location}.shout_cues must be unique frozen cue names")
    normalized["shout_cues"] = [cue for cue in SHOUT_CUES if cue in shout_cues]

    flags = {
        key
        for key, value in normalized.items()
        if key not in {"sfx_event", "shout_cues"} and value
    }
    has_sfx = normalized["sfx_event"] != "none" or normalized["comic_timing"]
    speech_flags = {
        "external_utterance",
        "independent_aside",
        "same_utterance_contrast",
        "whisper",
    }
    has_speech = bool(flags.intersection(speech_flags) or normalized["shout_cues"])
    if normalized["other"] and (len(flags) > 1 or has_sfx or normalized["shout_cues"]):
        raise DerivationError(f"{location}: other evidence must be exclusive")
    if normalized["label"] and (len(flags) > 1 or has_sfx or normalized["shout_cues"]):
        raise DerivationError(f"{location}: label evidence is exclusive")
    if normalized["sfx_event"] != "none" and normalized["comic_timing"]:
        raise DerivationError(
            f"{location}: comic is residual and conflicts with exact SFX"
        )
    if has_sfx and (
        has_speech
        or normalized["inner_thought"]
        or normalized["narrator"]
        or normalized["label"]
        or normalized["other"]
    ):
        raise DerivationError(f"{location}: speech/SFX evidence is contradictory")
    if normalized["external_utterance"] and (
        normalized["inner_thought"] or normalized["narrator"]
    ):
        raise DerivationError(
            f"{location}: external speech conflicts with internal role"
        )
    if normalized["inner_thought"] and normalized["narrator"]:
        raise DerivationError(f"{location}: thought and narration are incompatible")
    modifiers = (
        normalized["independent_aside"],
        normalized["same_utterance_contrast"],
        bool(normalized["shout_cues"]),
        normalized["whisper"],
    )
    if any(modifiers) and not normalized["external_utterance"]:
        raise DerivationError(
            f"{location}: speech modifiers require external utterance"
        )
    if sum(bool(value) for value in modifiers) > 1:
        raise DerivationError(f"{location}: aside/emphasis/shout/whisper are exclusive")
    return normalized


def _validate_serif_evidence(value: Mapping[str, Any], location: str) -> dict[str, Any]:
    _require_exact_keys(value, SERIF_EVIDENCE_KEYS, location)
    result: dict[str, Any] = {}
    for view_name in ("raw", "glyph_view"):
        view = _require_mapping(value.get(view_name), f"{location}.{view_name}")
        _require_exact_keys(view, SERIF_VIEW_KEYS, f"{location}.{view_name}")
        result[view_name] = {
            key: _require_id_array(view.get(key), f"{location}.{view_name}.{key}")
            for key in sorted(SERIF_VIEW_KEYS)
        }
    cross = _require_id_array(
        value.get("cross_view_glyph_ids"), f"{location}.cross_view_glyph_ids"
    )
    shared = set(result["raw"]["thick_thin_glyph_ids"])
    shared.intersection_update(result["raw"]["terminal_serif_glyph_ids"])
    shared.intersection_update(result["glyph_view"]["thick_thin_glyph_ids"])
    shared.intersection_update(result["glyph_view"]["terminal_serif_glyph_ids"])
    if not set(cross).issubset(shared):
        raise DerivationError(
            f"{location}.cross_view_glyph_ids must appear in both features and views"
        )
    result["cross_view_glyph_ids"] = cross
    return result


def validate_annotation(record: Mapping[str, Any], location: str) -> dict[str, Any]:
    _validate_seal(record, location, required=True)
    payload = dict(record)
    record_sha256 = str(payload.pop("record_sha256"))
    raw_stage = payload.get("stage")
    expected_keys = (
        ADJUDICATION_ANNOTATION_KEYS
        if raw_stage == "adjudication"
        else ANNOTATION_KEYS
    )
    _require_exact_keys(payload, expected_keys, location)
    _walk_source_only(payload, location)
    if payload.get("schema_version") != SOURCE_SCHEMA_VERSION:
        raise DerivationError(f"{location}.schema_version is unsupported")
    if payload.get("record_type") != SOURCE_RECORD_TYPE:
        raise DerivationError(f"{location}.record_type is unsupported")
    assignment_id = _require_id(
        payload.get("assignment_id"), f"{location}.assignment_id"
    )
    sample_id = _require_id(payload.get("sample_id"), f"{location}.sample_id")
    stage = payload.get("stage")
    if stage not in {"primary", "secondary", "adjudication"}:
        raise DerivationError(f"{location}.stage is unsupported")
    source_review_record_sha256s: list[str] | None = None
    if stage == "adjudication":
        source_review_record_sha256s = _require_sha_array(
            payload.get("source_review_record_sha256s"),
            f"{location}.source_review_record_sha256s",
        )
        if not 1 <= len(source_review_record_sha256s) <= 2:
            raise DerivationError(
                f"{location}.source_review_record_sha256s must contain the exact "
                "primary and optional secondary source-review seals"
            )
    reviewer_id = _require_id(payload.get("reviewer_id"), f"{location}.reviewer_id")
    batch_id = _require_id(payload.get("batch_id"), f"{location}.batch_id")
    batch_size = payload.get("batch_size")
    if (
        isinstance(batch_size, bool)
        or not isinstance(batch_size, int)
        or batch_size <= 0
    ):
        raise DerivationError(f"{location}.batch_size must be a positive integer")
    batch_task_set_sha256 = _require_sha(
        payload.get("batch_task_set_sha256"), f"{location}.batch_task_set_sha256"
    )
    source_only_card_sha256 = _require_sha(
        payload.get("source_only_card_sha256"),
        f"{location}.source_only_card_sha256",
    )

    eligibility_value = _require_mapping(
        payload.get("eligibility_evidence"), f"{location}.eligibility_evidence"
    )
    _require_exact_keys(
        eligibility_value, ELIGIBILITY_KEYS, f"{location}.eligibility_evidence"
    )
    eligibility = {
        key: _require_bool(
            eligibility_value.get(key), f"{location}.eligibility_evidence.{key}"
        )
        for key in ELIGIBILITY_KEYS - {"crop_issue"}
    }
    crop_issue = eligibility_value.get("crop_issue")
    if crop_issue not in CROP_ISSUES:
        raise DerivationError(
            f"{location}.eligibility_evidence.crop_issue is unsupported"
        )
    eligibility["crop_issue"] = crop_issue

    normalized_evidence = _validate_role_evidence(
        _require_mapping(payload.get("role_evidence"), f"{location}.role_evidence"),
        f"{location}.role_evidence",
    )
    if eligibility["role_context_sufficient"] and not (
        normalized_evidence["label"]
        or normalized_evidence["sfx_event"] != "none"
        or normalized_evidence["comic_timing"]
        or normalized_evidence["external_utterance"]
        or normalized_evidence["inner_thought"]
        or normalized_evidence["narrator"]
        or normalized_evidence["other"]
    ):
        raise DerivationError(
            f"{location}: sufficient role context requires observable role evidence"
        )

    source_family = payload.get("source_family")
    if source_family not in FAMILY_VALUES:
        raise DerivationError(f"{location}.source_family is unsupported")
    family_confidence = _require_unit(
        payload.get("source_family_confidence"), f"{location}.source_family_confidence"
    )
    serif_evidence = _validate_serif_evidence(
        _require_mapping(payload.get("serif_evidence"), f"{location}.serif_evidence"),
        f"{location}.serif_evidence",
    )
    strong_serif = len(serif_evidence["cross_view_glyph_ids"]) >= 2
    any_serif = any(
        serif_evidence[view][key]
        for view in ("raw", "glyph_view")
        for key in SERIF_VIEW_KEYS
    ) or bool(serif_evidence["cross_view_glyph_ids"])
    if source_family == "serif_printed" and (
        family_confidence < 0.85 or not strong_serif
    ):
        raise DerivationError(
            f"{location}: serif_printed requires confidence >=0.85 and two cross-view glyphs"
        )
    if source_family != "serif_printed" and strong_serif:
        raise DerivationError(
            f"{location}: strong structured serif evidence conflicts with source_family"
        )
    if source_family not in {"serif_printed", "mixed_or_unknown"} and any_serif:
        raise DerivationError(
            f"{location}: serif evidence conflicts with a non-serif source family"
        )
    if source_family == "mixed_or_unknown" and any_serif and family_confidence >= 0.75:
        raise DerivationError(
            f"{location}: incomplete serif evidence requires low family confidence"
        )

    axes_value = _require_mapping(payload.get("axes"), f"{location}.axes")
    _require_exact_keys(axes_value, set(AXES), f"{location}.axes")
    axes = {
        axis: _axis_value(axes_value.get(axis), f"{location}.axes.{axis}")
        for axis in AXES
    }
    hard_axes = payload.get("hard_axes")
    if not isinstance(hard_axes, list) or any(
        not isinstance(axis, str) for axis in hard_axes
    ):
        raise DerivationError(f"{location}.hard_axes must be an array")
    if len(hard_axes) != len(set(hard_axes)) or len(hard_axes) > 3:
        raise DerivationError(
            f"{location}.hard_axes must contain at most three unique axes"
        )
    if not set(hard_axes).issubset(AXES):
        raise DerivationError(f"{location}.hard_axes contains an unsupported axis")
    if any(axes[axis] is None for axis in hard_axes):
        raise DerivationError(f"{location}.hard_axes cannot select a null axis")
    normalized_hard_axes = [axis for axis in AXES if axis in hard_axes]

    treatment = _require_mapping(payload.get("treatment"), f"{location}.treatment")
    _require_exact_keys(treatment, TREATMENT_KEYS, f"{location}.treatment")
    normalized_treatment = {
        key: _require_bool(treatment.get(key), f"{location}.treatment.{key}")
        for key in sorted(TREATMENT_KEYS)
    }
    rationale = _require_text(payload.get("rationale"), f"{location}.rationale", 12)
    normalized = {
        "schema_version": SOURCE_SCHEMA_VERSION,
        "record_type": SOURCE_RECORD_TYPE,
        "assignment_id": assignment_id,
        "sample_id": sample_id,
        "stage": stage,
        "reviewer_id": reviewer_id,
        "batch_id": batch_id,
        "batch_size": batch_size,
        "batch_task_set_sha256": batch_task_set_sha256,
        "source_only_card_sha256": source_only_card_sha256,
        "eligibility_evidence": eligibility,
        "role_evidence": normalized_evidence,
        "source_family": source_family,
        "source_family_confidence": family_confidence,
        "serif_evidence": serif_evidence,
        "axes": axes,
        "hard_axes": normalized_hard_axes,
        "treatment": normalized_treatment,
        "rationale": rationale,
    }
    if source_review_record_sha256s is not None:
        normalized["source_review_record_sha256s"] = source_review_record_sha256s
    normalized["record_sha256"] = record_sha256
    normalized["canonical_annotation_sha256"] = sha256_bytes(
        canonical_json_bytes(normalized | {"record_sha256": record_sha256})
    )
    return normalized


def _review_stage(value: Any, location: str) -> str:
    if value not in {"primary", "secondary", "adjudication"}:
        raise DerivationError(f"{location} is unsupported")
    return str(value)


def _review_order(value: Any, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DerivationError(f"{location} must be a non-negative integer")
    return value


def validate_source_task(record: Mapping[str, Any], location: str) -> dict[str, Any]:
    """Validate the candidate-free task exported before the A commit."""

    _validate_seal(record, location, required=True)
    _require_exact_keys(record, SOURCE_TASK_KEYS, location)
    if record.get("schema_version") != SOURCE_TASK_SCHEMA_VERSION:
        raise DerivationError(f"{location}.schema_version is unsupported")
    if record.get("record_type") != SOURCE_TASK_RECORD_TYPE:
        raise DerivationError(f"{location}.record_type is unsupported")
    surface = _require_mapping(
        record.get("review_surface"), f"{location}.review_surface"
    )
    if dict(surface) != SOURCE_REVIEW_SURFACE:
        raise DerivationError(f"{location}.review_surface leaks candidate B")
    return {
        "assignment_id": _require_id(
            record.get("assignment_id"), f"{location}.assignment_id"
        ),
        "sample_id": _require_id(record.get("sample_id"), f"{location}.sample_id"),
        "stage": _review_stage(record.get("stage"), f"{location}.stage"),
        "review_order": _review_order(
            record.get("review_order"), f"{location}.review_order"
        ),
        "source_only_card_sha256": _require_sha(
            record.get("source_only_card_sha256"),
            f"{location}.source_only_card_sha256",
        ),
        "review_surface": dict(surface),
        "task_record_sha256": str(record["record_sha256"]),
        "source_task_record_sha256": str(record["record_sha256"]),
    }


def release_alias_map(release_nonce_sha256: str) -> dict[str, str]:
    nonce_sha = _require_sha(release_nonce_sha256, "release_nonce_sha256")
    return {
        prototype_alias: "ko-candidate-"
        + sha256_bytes(
            canonical_json_bytes(
                ["font-matching-release-alias-v5", nonce_sha, prototype_alias]
            )
        )[:16]
        for prototype_alias in FROZEN_ALIAS_ORDER
    }


def release_alias_order(release_nonce_sha256: str, assignment_id: str) -> list[str]:
    alias_map = release_alias_map(release_nonce_sha256)
    return sorted(
        alias_map.values(),
        key=lambda alias: (
            sha256_bytes(
                canonical_json_bytes(
                    [
                        "font-matching-release-order-v5",
                        release_nonce_sha256,
                        assignment_id,
                        alias,
                    ]
                )
            ),
            alias,
        ),
    )


def release_candidate_order_seed(
    release_nonce_sha256: str, assignment_id: str
) -> str:
    return sha256_bytes(
        canonical_json_bytes(
            ["font-matching-release-seed-v5", release_nonce_sha256, assignment_id]
        )
    )


def release_batch_order(
    release_nonce_sha256: str, assignment_ids: Sequence[str]
) -> dict[str, int]:
    """Return a nonce-fresh B-batch order without reusing A review order."""

    nonce_sha = _require_sha(release_nonce_sha256, "release_nonce_sha256")
    normalized_ids = sorted(
        {_require_id(value, "assignment_id") for value in assignment_ids}
    )
    ordered = sorted(
        normalized_ids,
        key=lambda assignment_id: (
            sha256_bytes(
                canonical_json_bytes(
                    [
                        "font-matching-release-batch-order-v5",
                        nonce_sha,
                        assignment_id,
                    ]
                )
            ),
            assignment_id,
        ),
    )
    return {assignment_id: index for index, assignment_id in enumerate(ordered)}


def candidate_release_challenge(
    *,
    release_record_sha256: str,
    release_nonce_sha256: str,
    assignment_id: str,
    source_task_record_sha256: str,
    source_annotation_record_sha256: str,
    full_card_sha256: str,
    candidate_only_card_sha256: str,
) -> str:
    values = [
        _require_sha(release_record_sha256, "release_record_sha256"),
        _require_sha(release_nonce_sha256, "release_nonce_sha256"),
        _require_id(assignment_id, "assignment_id"),
        _require_sha(source_task_record_sha256, "source_task_record_sha256"),
        _require_sha(
            source_annotation_record_sha256, "source_annotation_record_sha256"
        ),
        _require_sha(full_card_sha256, "full_card_sha256"),
        _require_sha(candidate_only_card_sha256, "candidate_only_card_sha256"),
    ]
    return sha256_bytes(
        canonical_json_bytes(["font-matching-release-challenge-v5", *values])
    )


def validate_task(record: Mapping[str, Any], location: str) -> dict[str, Any]:
    """Validate a candidate-B task materialized only after a sealed release."""

    _validate_seal(record, location, required=True)
    _require_exact_keys(record, TASK_KEYS, location)
    if record.get("schema_version") != TASK_SCHEMA_VERSION:
        raise DerivationError(f"{location}.schema_version is unsupported")
    if record.get("record_type") != TASK_RECORD_TYPE:
        raise DerivationError(f"{location}.record_type is unsupported")
    assignment_id = _require_id(
        record.get("assignment_id"), f"{location}.assignment_id"
    )
    _require_id(record.get("sample_id"), f"{location}.sample_id")
    seed = _require_sha(
        record.get("candidate_order_seed"), f"{location}.candidate_order_seed"
    )
    stage = _review_stage(record.get("stage"), f"{location}.stage")
    nonce_sha = _require_sha(
        record.get("release_nonce_sha256"), f"{location}.release_nonce_sha256"
    )
    expected_alias_map = release_alias_map(nonce_sha)
    aliases = record.get("blind_alias_order")
    if not isinstance(aliases, list) or aliases != list(dict.fromkeys(aliases)):
        raise DerivationError(
            f"{location}.blind_alias_order must contain unique aliases"
        )
    if len(aliases) != 7 or set(aliases) != set(expected_alias_map.values()):
        raise DerivationError(
            f"{location}.blind_alias_order is not the fresh release alias set"
        )
    if record.get("candidate_count") != 7:
        raise DerivationError(f"{location}.candidate_count must be 7")
    mandatory = record.get("mandatory_unrenderable")
    if not isinstance(mandatory, list) or len(mandatory) != len(set(mandatory)):
        raise DerivationError(f"{location}.mandatory_unrenderable must be unique")
    if not set(mandatory).issubset(expected_alias_map.values()):
        raise DerivationError(
            f"{location}.mandatory_unrenderable contains an unknown alias"
        )
    card_hashes = {
        name: _require_sha(record.get(f"{name}_sha256"), f"{location}.{name}_sha256")
        for name in ("full_card", "source_only_card", "candidate_only_card")
    }
    if len(set(card_hashes.values())) != 3:
        raise DerivationError(f"{location}.review_cards must bind three distinct files")
    anchors = _require_mapping(
        record.get("neutral_tie_anchors"), f"{location}.neutral_tie_anchors"
    )
    _require_exact_keys(anchors, ANCHOR_KEYS, f"{location}.neutral_tie_anchors")
    normalized_anchors = {
        key: _require_sha(anchors.get(key), f"{location}.neutral_tie_anchors.{key}")
        for key in sorted(ANCHOR_KEYS)
    }
    surface = _require_mapping(
        record.get("review_surface"), f"{location}.review_surface"
    )
    if dict(surface) != REVIEW_SURFACE:
        raise DerivationError(
            f"{location}.review_surface violates the v5 separation contract"
        )
    review_order = _review_order(
        record.get("review_order"), f"{location}.review_order"
    )
    candidate_batch_order = _review_order(
        record.get("candidate_batch_order"), f"{location}.candidate_batch_order"
    )
    if candidate_batch_order != review_order:
        raise DerivationError(
            f"{location}.review_order must be the fresh candidate_batch_order"
        )
    assignment_id = _require_id(
        record.get("assignment_id"), f"{location}.assignment_id"
    )
    if aliases != release_alias_order(nonce_sha, assignment_id):
        raise DerivationError(f"{location}.blind_alias_order is not release-derived")
    if seed != release_candidate_order_seed(nonce_sha, assignment_id):
        raise DerivationError(f"{location}.candidate_order_seed is not release-derived")
    release_sha = _require_sha(
        record.get("candidate_release_record_sha256"),
        f"{location}.candidate_release_record_sha256",
    )
    source_task_sha = _require_sha(
        record.get("source_task_record_sha256"),
        f"{location}.source_task_record_sha256",
    )
    annotation_sha = _require_sha(
        record.get("source_annotation_record_sha256"),
        f"{location}.source_annotation_record_sha256",
    )
    challenge = candidate_release_challenge(
        release_record_sha256=release_sha,
        release_nonce_sha256=nonce_sha,
        assignment_id=assignment_id,
        source_task_record_sha256=source_task_sha,
        source_annotation_record_sha256=annotation_sha,
        full_card_sha256=card_hashes["full_card"],
        candidate_only_card_sha256=card_hashes["candidate_only_card"],
    )
    if record.get("release_challenge_sha256") != challenge:
        raise DerivationError(f"{location}.release_challenge_sha256 changed")
    return {
        "assignment_id": assignment_id,
        "sample_id": _require_id(record.get("sample_id"), f"{location}.sample_id"),
        "candidate_order_seed": seed,
        "stage": stage,
        "blind_alias_order": list(aliases),
        "mandatory_unrenderable": [
            alias for alias in aliases if alias in mandatory
        ],
        "full_card_sha256": card_hashes["full_card"],
        "source_only_card_sha256": card_hashes["source_only_card"],
        "candidate_only_card_sha256": card_hashes["candidate_only_card"],
        "neutral_tie_anchors": normalized_anchors,
        "review_surface": dict(surface),
        "review_order": review_order,
        "candidate_batch_order": candidate_batch_order,
        "source_task_record_sha256": source_task_sha,
        "source_annotation_record_sha256": annotation_sha,
        "candidate_release_id": _require_id(
            record.get("candidate_release_id"), f"{location}.candidate_release_id"
        ),
        "candidate_release_record_sha256": release_sha,
        "release_nonce_sha256": nonce_sha,
        "release_challenge_sha256": challenge,
        "prototype_by_alias": {
            public_alias: PROTOTYPES[prototype_alias]
            for prototype_alias, public_alias in expected_alias_map.items()
        },
        "prototype_alias_order": [expected_alias_map[key] for key in FROZEN_ALIAS_ORDER],
        "task_record_sha256": str(record["record_sha256"]),
    }


def derive_eligibility(annotation: Mapping[str, Any]) -> str:
    evidence = annotation["eligibility_evidence"]
    if evidence["crop_issue"] != "none":
        return "crop_needs_review"
    if not all(
        evidence[key]
        for key in (
            "complete_text_object",
            "single_source_skeleton",
            "clean_glyph_isolation",
            "role_context_sufficient",
        )
    ):
        return "crop_needs_review"
    if not evidence["font_signal_skeleton_present"]:
        return "font_signal_absent"
    return "font_signal_present"


def derive_role(annotation: Mapping[str, Any]) -> tuple[str, float, str]:
    """Apply deterministic semantic precedence; comic is an SFX residual."""

    evidence = annotation["role_evidence"]
    if evidence["label"]:
        return "sign_ui_title", 0.98, "label_function"
    if evidence["sfx_event"] != "none":
        role = f"sfx_{evidence['sfx_event']}"
        return role, 0.96, "exact_sfx_event"
    if evidence["comic_timing"]:
        return "sfx_comic", 0.90, "comic_timing_residual"
    if evidence["independent_aside"]:
        return "aside_balloon_edge", 0.95, "independent_aside"
    if evidence["same_utterance_contrast"]:
        return "emphasis_dialogue", 0.95, "same_utterance_contrast"
    if len(evidence["shout_cues"]) >= 2:
        confidence = min(0.96, 0.90 + 0.02 * (len(evidence["shout_cues"]) - 2))
        return "shout", confidence, "shout_two_or_more_cues"
    if evidence["whisper"]:
        return "whisper", 0.92, "whisper_evidence"
    if evidence["external_utterance"]:
        return "dialogue", 0.88, "external_utterance"
    if evidence["inner_thought"]:
        return "thought", 0.92, "inner_thought"
    if evidence["narrator"]:
        return "narration", 0.90, "narrator"
    if evidence["other"]:
        return "other", 0.70, "other_text_function"
    return "unknown_needs_review", 0.45, "insufficient_role_evidence"


def _effective_family(annotation: Mapping[str, Any]) -> tuple[str, list[str]]:
    family = str(annotation["source_family"])
    confidence = float(annotation["source_family_confidence"])
    notes: list[str] = []
    if confidence < 0.75:
        notes.append("family_confidence_below_0.75")
        return "mixed_or_unknown", notes
    if family == "serif_printed":
        serif = annotation["serif_evidence"]
        strong = confidence >= 0.85 and len(serif["cross_view_glyph_ids"]) >= 2
        if not strong:
            # validate_annotation rejects this state.  Retain the guard so
            # direct internal callers cannot silently turn weak serif evidence
            # into a high-confidence sans-safe decision.
            raise DerivationError("serif hard-gate evidence became insufficient")
        notes.append("serif_hard_gate_confirmed")
    return family, notes


def _distance(
    source_axes: Mapping[str, float | None],
    candidate_axes: Mapping[str, float],
    role: str,
) -> tuple[float | None, dict[str, float], dict[str, float], dict[str, float]]:
    weights = ROLE_WEIGHTS[ROLE_WEIGHT_GROUP[role]]
    known = [axis for axis in AXES if source_axes[axis] is not None]
    denominator = sum(weights[axis] for axis in known)
    if not known or denominator <= 0:
        return None, {}, {}, {}
    normalized_weights = {axis: weights[axis] / denominator for axis in known}
    gaps = {
        axis: round(abs(float(source_axes[axis]) - candidate_axes[axis]), 6)
        for axis in known
    }
    raw_contributions = {
        axis: normalized_weights[axis] * gaps[axis] / 4 for axis in known
    }
    contributions = {axis: round(raw_contributions[axis], 6) for axis in known}
    distance = round(sum(raw_contributions.values()), 6)
    return (
        distance,
        gaps,
        contributions,
        {axis: round(normalized_weights[axis], 6) for axis in known},
    )


def _candidate_gate(
    *,
    effective_family: str,
    source_axes: Mapping[str, float | None],
    hard_axes: Sequence[str],
    prototype: Mapping[str, Any],
    distance: float | None,
    gaps: Mapping[str, float],
) -> tuple[list[str], list[str], bool, str]:
    candidate_family = str(prototype["family"])
    failures: list[str] = []
    hard_axis_failures: list[str] = []
    printed_hand_inversion = False
    family_gate = "pass"
    if effective_family == "serif_printed":
        failures.append("family_missing_serif_prototype")
        family_gate = "fail"
    elif (
        effective_family in {"sans_printed", "display"}
        and candidate_family == "handwritten"
    ):
        failures.append("family_printed_handwritten_inversion")
        printed_hand_inversion = True
        family_gate = "fail"
    elif effective_family == "handwritten" and candidate_family in {
        "sans_printed",
        "display",
    }:
        failures.append("family_printed_handwritten_inversion")
        printed_hand_inversion = True
        family_gate = "fail"

    weight_gap = gaps.get("weight")
    if weight_gap is not None and weight_gap >= 2.0:
        failures.append("weight_gap_two_or_more")
    source_energy = source_axes["energy"]
    candidate_energy = prototype["axes"]["energy"]
    if source_energy is not None and (
        (source_energy <= 1.5 and candidate_energy >= 3.5)
        or (source_energy >= 3.5 and candidate_energy <= 1.5)
    ):
        failures.append("quiet_aggressive_display_inversion")
    width_gap = gaps.get("width")
    if width_gap is not None and width_gap >= 2.5:
        failures.append("extreme_width_inversion")
    for axis in hard_axes:
        if gaps[axis] > 1.0:
            hard_axis_failures.append(axis)
            failures.append(f"hard_axis_gap:{axis}")
    if distance is None:
        failures.append("insufficient_style_axes")
    if len(hard_axes) < 2:
        failures.append("hard_axis_evidence_below_two")
    return (
        list(dict.fromkeys(failures)),
        hard_axis_failures,
        printed_hand_inversion,
        family_gate,
    )


def _none_reason(
    *,
    effective_family: str,
    annotation: Mapping[str, Any],
    mandatory_count: int,
    deployment_blocked_safe: bool,
) -> str:
    if mandatory_count == len(FROZEN_ALIAS_ORDER) or deployment_blocked_safe:
        return "deployment_failure"
    if effective_family == "serif_printed":
        return "missing_serif_printed"
    if effective_family == "sans_printed":
        return "missing_sans_printed"
    if effective_family == "handwritten":
        weight = annotation["axes"]["weight"]
        angularity = annotation["axes"]["angularity"]
        roundness = annotation["axes"]["roundness"]
        if weight is not None and weight <= 1.0:
            return "missing_fine_hand"
        if roundness is not None and roundness >= 3.0:
            return "missing_soft_round"
        if angularity is not None and angularity >= 2.5:
            return "missing_rough_hand"
        return "missing_rough_hand"
    weight = annotation["axes"]["weight"]
    roundness = annotation["axes"]["roundness"]
    if effective_family == "display" and weight is not None and weight >= 3.0:
        return "missing_heavy_display"
    if roundness is not None and roundness >= 3.0:
        return "missing_soft_round"
    return "other_explained"


def _round_confidence(
    annotation: Mapping[str, Any], role_confidence: float, eligibility: str
) -> float:
    if eligibility == "crop_needs_review":
        return 0.98
    if eligibility == "font_signal_absent":
        return 0.95
    known_ratio = sum(annotation["axes"][axis] is not None for axis in AXES) / len(AXES)
    value = (
        0.45 * float(annotation["source_family_confidence"])
        + 0.35 * known_ratio
        + 0.20 * role_confidence
    )
    serif = annotation["serif_evidence"]
    partial_serif = (
        any(
            serif[view][key]
            for view in ("raw", "glyph_view")
            for key in SERIF_VIEW_KEYS
        )
        and len(serif["cross_view_glyph_ids"]) < 2
    )
    if annotation["source_family"] == "mixed_or_unknown" and partial_serif:
        value = min(value, 0.74)
    return round(min(0.99, value), 4)


def _unsafe_key(candidate: Mapping[str, Any]) -> tuple[Any, ...]:
    gaps = candidate["axis_gaps"]
    return (
        len(candidate["hard_failures"]),
        int(candidate["printed_hand_inversion"]),
        gaps.get("weight", math.inf),
        gaps.get("width", math.inf),
        gaps.get("energy", math.inf),
        candidate["distance"] if candidate["distance"] is not None else math.inf,
        candidate["neutral_tie_break"]["chapter"],
        candidate["neutral_tie_break"]["work"],
    )


def _ranked_key(candidate: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        candidate["distance"] if candidate["distance"] is not None else math.inf,
        candidate["neutral_tie_break"]["chapter"],
        candidate["neutral_tie_break"]["work"],
    )


def _neutral_tie_break(task: Mapping[str, Any], alias: str) -> dict[str, str]:
    anchors = task["neutral_tie_anchors"]
    return {
        "chapter": sha256_bytes(
            canonical_json_bytes(
                ["font-matching-chapter-tie-v5", anchors["chapter_sha256"], alias]
            )
        ),
        "work": sha256_bytes(
            canonical_json_bytes(
                ["font-matching-work-tie-v5", anchors["work_sha256"], alias]
            )
        ),
    }


def _initial_tier(distance: float, minimum_distance: float) -> str:
    """Apply the frozen v4 thresholds before the global safe-set cap.

    A distance at or below 0.16 that falls outside the best ``+0.04`` band is
    deliberately marginal: the v4 acceptable interval starts *above* 0.16.
    """

    if distance <= 0.16 and distance <= minimum_distance + 0.04 + 1e-9:
        return "preferred"
    if 0.16 < distance <= 0.28:
        return "acceptable"
    if distance <= 0.45:
        return "marginal"
    return "unacceptable"


def derive_one(
    task: Mapping[str, Any], annotation: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    for annotation_key, task_key in (
        ("assignment_id", "assignment_id"),
        ("sample_id", "sample_id"),
        ("stage", "stage"),
        ("source_only_card_sha256", "source_only_card_sha256"),
        ("record_sha256", "source_annotation_record_sha256"),
    ):
        if annotation[annotation_key] != task[task_key]:
            raise DerivationError(
                f"annotation.{annotation_key} does not match the sealed task"
            )
    eligibility = derive_eligibility(annotation)
    role, role_confidence, role_basis = derive_role(annotation)
    confidence = _round_confidence(annotation, role_confidence, eligibility)
    effective_family, family_notes = _effective_family(annotation)
    candidates: list[dict[str, Any]] = []
    judgment: dict[str, Any] | None = None

    if eligibility == "font_signal_present":
        weight_group = ROLE_WEIGHT_GROUP[role]
        for alias in task["prototype_alias_order"]:
            prototype = task["prototype_by_alias"][alias]
            distance, gaps, contributions, normalized_weights = _distance(
                annotation["axes"], prototype["axes"], role
            )
            failures, hard_axis_failures, printed_hand, family_gate = _candidate_gate(
                effective_family=effective_family,
                source_axes=annotation["axes"],
                hard_axes=annotation["hard_axes"],
                prototype=prototype,
                distance=distance,
                gaps=gaps,
            )
            mandatory = alias in task["mandatory_unrenderable"]
            matched_hard_axes = [
                axis
                for axis in annotation["hard_axes"]
                if gaps.get(axis, math.inf) <= 1.0
            ]
            candidates.append(
                {
                    "alias": alias,
                    "prototype_family": prototype["family"],
                    "prototype_axes": dict(prototype["axes"]),
                    "distance": distance,
                    "axis_gaps": gaps,
                    "normalized_role_weights": normalized_weights,
                    "distance_contributions": contributions,
                    "largest_gap": (
                        None
                        if not gaps
                        else {
                            "axis": min(
                                (
                                    axis
                                    for axis in gaps
                                    if gaps[axis] == max(gaps.values())
                                ),
                                key=AXES.index,
                            ),
                            "value": max(gaps.values()),
                        }
                    ),
                    "family_gate": family_gate,
                    "hard_axis_max_gap": (
                        None
                        if not annotation["hard_axes"]
                        else max(gaps[axis] for axis in annotation["hard_axes"])
                    ),
                    "hard_failures": failures,
                    "tier_adjustments": [],
                    "failed_hard_axes": hard_axis_failures,
                    "matched_hard_axes": matched_hard_axes,
                    "printed_hand_inversion": printed_hand,
                    "mandatory_unrenderable": mandatory,
                    "semantic_gate_pass": not failures,
                    "gate_pass": not failures and not mandatory,
                    "neutral_tie_break": _neutral_tie_break(task, alias),
                    "would_be_safe_without_deployment": False,
                    "tier": "unrenderable" if mandatory else None,
                    "safe": False,
                }
            )
        semantic_gate_pass = [
            candidate for candidate in candidates if candidate["semantic_gate_pass"]
        ]
        deployable_gate_pass = [
            candidate
            for candidate in semantic_gate_pass
            if not candidate["mandatory_unrenderable"]
        ]
        semantic_minimum_distance = min(
            (
                candidate["distance"]
                for candidate in semantic_gate_pass
                if candidate["distance"] is not None
            ),
            default=None,
        )
        deployable_minimum_distance = min(
            (
                candidate["distance"]
                for candidate in deployable_gate_pass
                if candidate["distance"] is not None
            ),
            default=None,
        )
        for candidate in candidates:
            if candidate["mandatory_unrenderable"]:
                if (
                    candidate["semantic_gate_pass"]
                    and semantic_minimum_distance is not None
                ):
                    distance = candidate["distance"]
                    assert distance is not None
                    candidate["would_be_safe_without_deployment"] = _initial_tier(
                        distance, semantic_minimum_distance
                    ) in {"preferred", "acceptable"}
                continue
            if not candidate["semantic_gate_pass"]:
                candidate["tier"] = "unacceptable"
                continue
            distance = candidate["distance"]
            assert distance is not None
            assert deployable_minimum_distance is not None
            candidate["tier"] = _initial_tier(distance, deployable_minimum_distance)

        raw_safe = sorted(
            [
                candidate
                for candidate in candidates
                if candidate["tier"] in {"preferred", "acceptable"}
            ],
            key=_ranked_key,
        )
        for candidate in raw_safe[:2]:
            candidate["safe"] = True
        for candidate in raw_safe[2:]:
            candidate["tier"] = "marginal"
            candidate["tier_adjustments"].append("safe_cap_overflow")

        tiers: dict[str, list[str]] = {}
        for tier in TIERS:
            members = [
                candidate for candidate in candidates if candidate["tier"] == tier
            ]
            if tier == "unacceptable":
                members.sort(key=_unsafe_key)
            elif tier == "unrenderable":
                members.sort(
                    key=lambda item: task["prototype_alias_order"].index(item["alias"])
                )
            else:
                members.sort(key=_ranked_key)
            tiers[tier] = [candidate["alias"] for candidate in members]
        safe_count = len(tiers["preferred"]) + len(tiers["acceptable"])
        judgment = {**tiers, "none_acceptable": safe_count == 0}
        deployment_blocked_safe = any(
            candidate["mandatory_unrenderable"]
            and candidate["would_be_safe_without_deployment"]
            for candidate in candidates
        )
        nearest = sorted(
            [
                candidate
                for candidate in candidates
                if not candidate["mandatory_unrenderable"]
            ],
            key=_ranked_key,
        )[:2]
        none_audit = (
            {
                "reason_code": _none_reason(
                    effective_family=effective_family,
                    annotation=annotation,
                    mandatory_count=len(task["mandatory_unrenderable"]),
                    deployment_blocked_safe=deployment_blocked_safe,
                ),
                "nearest_two": [
                    {
                        "alias": candidate["alias"],
                        "distance": candidate["distance"],
                        "failed_hard_axes": candidate["failed_hard_axes"],
                        "hard_failures": candidate["hard_failures"],
                    }
                    for candidate in nearest
                ],
            }
            if safe_count == 0
            else None
        )
        rationale = (
            f"{annotation['rationale']} Structured source evidence derives {role}; frozen v4 "
            f"family/hard-axis gates and role-weighted D produce safe_count={safe_count}. "
            "none_acceptable is derived only from that safe count."
        )
    else:
        weight_group = ROLE_WEIGHT_GROUP[role]
        safe_count = 0
        none_audit = None
        for alias in task["prototype_alias_order"]:
            prototype = task["prototype_by_alias"][alias]
            candidates.append(
                {
                    "alias": alias,
                    "prototype_family": prototype["family"],
                    "prototype_axes": dict(prototype["axes"]),
                    "distance": None,
                    "axis_gaps": {},
                    "normalized_role_weights": {},
                    "distance_contributions": {},
                    "largest_gap": None,
                    "family_gate": "not_evaluated",
                    "hard_axis_max_gap": None,
                    "hard_failures": ["eligibility_exception"],
                    "tier_adjustments": [],
                    "failed_hard_axes": [],
                    "matched_hard_axes": [],
                    "printed_hand_inversion": False,
                    "mandatory_unrenderable": alias in task["mandatory_unrenderable"],
                    "semantic_gate_pass": None,
                    "gate_pass": None,
                    "neutral_tie_break": _neutral_tie_break(task, alias),
                    "would_be_safe_without_deployment": False,
                    "tier": None,
                    "safe": False,
                }
            )
        rationale = (
            f"{annotation['rationale']} Structured glyph/crop evidence derives {eligibility}; "
            f"candidate tiers are intentionally null while semantic evidence derives {role}."
        )

    if len(rationale) > 4000:
        raise DerivationError(
            f"annotation[{annotation['sample_id']}].rationale leaves no output headroom"
        )
    decision = {
        "assignment_id": task["assignment_id"],
        "candidate_release_record_sha256": task[
            "candidate_release_record_sha256"
        ],
        "candidate_order_seed": task["candidate_order_seed"],
        "confidence": confidence,
        "eligibility": eligibility,
        "font_judgment": judgment,
        "rationale": rationale,
        "review_card_sha256": task["full_card_sha256"],
        "release_challenge_sha256": task["release_challenge_sha256"],
        "release_nonce_sha256": task["release_nonce_sha256"],
        "role": role,
        "role_confidence": role_confidence,
        "sample_id": task["sample_id"],
    }
    audit = seal_record(
        {
            "schema_version": AUDIT_SCHEMA_VERSION,
            "record_type": AUDIT_RECORD_TYPE,
            "assignment_id": task["assignment_id"],
            "sample_id": task["sample_id"],
            "stage": task["stage"],
            "reviewer_id": annotation["reviewer_id"],
            "batch_id": annotation["batch_id"],
            "batch_size": annotation["batch_size"],
            "batch_task_set_sha256": annotation["batch_task_set_sha256"],
            "task_record_sha256": task["task_record_sha256"],
            "source_task_record_sha256": task["source_task_record_sha256"],
            "source_annotation_record_sha256": annotation["record_sha256"],
            "source_annotation_canonical_sha256": annotation[
                "canonical_annotation_sha256"
            ],
            "candidate_order_seed": task["candidate_order_seed"],
            "candidate_release_record_sha256": task[
                "candidate_release_record_sha256"
            ],
            "release_challenge_sha256": task["release_challenge_sha256"],
            "release_nonce_sha256": task["release_nonce_sha256"],
            "full_card_sha256": task["full_card_sha256"],
            "source_only_card_sha256": task["source_only_card_sha256"],
            "candidate_only_card_sha256": task["candidate_only_card_sha256"],
            "eligibility": eligibility,
            "role": role,
            "role_basis": role_basis,
            "role_weight_group": weight_group,
            "source_family": annotation["source_family"],
            "source_family_confidence": annotation["source_family_confidence"],
            "effective_family_gate": effective_family,
            "family_gate_notes": family_notes,
            "source_axes": annotation["axes"],
            "hard_axes": annotation["hard_axes"],
            "treatment_observed_not_scored": annotation["treatment"],
            "candidates": candidates,
            "safe_count": safe_count,
            "none_audit": none_audit,
            "decision_sha256": sha256_bytes(canonical_json_bytes(decision)),
        }
    )
    _validate_derived_decision(decision, task)
    _validate_audit(audit, task, annotation, decision)
    return decision, audit


def _validate_derived_decision(
    decision: Mapping[str, Any], task: Mapping[str, Any]
) -> None:
    _require_exact_keys(decision, DECISION_KEYS, "decision")
    for key, task_key in (
        ("assignment_id", "assignment_id"),
        ("sample_id", "sample_id"),
        ("candidate_release_record_sha256", "candidate_release_record_sha256"),
        ("candidate_order_seed", "candidate_order_seed"),
        ("review_card_sha256", "full_card_sha256"),
        ("release_challenge_sha256", "release_challenge_sha256"),
        ("release_nonce_sha256", "release_nonce_sha256"),
    ):
        if decision[key] != task[task_key]:
            raise DerivationError(f"decision.{key} does not match the sealed task")
    if (
        decision["eligibility"] not in ELIGIBILITY_VALUES
        or decision["role"] not in ROLE_VALUES
    ):
        raise DerivationError("decision has an unsupported eligibility or role")
    _require_unit(decision["confidence"], "decision.confidence")
    _require_unit(decision["role_confidence"], "decision.role_confidence")
    _require_text(decision["rationale"], "decision.rationale", 12)
    if decision["eligibility"] != "font_signal_present":
        if decision["font_judgment"] is not None:
            raise DerivationError("eligibility exception requires a null font_judgment")
        return
    judgment = _require_mapping(decision["font_judgment"], "decision.font_judgment")
    _require_exact_keys(judgment, {*TIERS, "none_acceptable"}, "decision.font_judgment")
    flattened: list[str] = []
    for tier in TIERS:
        value = judgment[tier]
        if not isinstance(value, list) or any(
            not ALIAS_RE.fullmatch(alias) for alias in value
        ):
            raise DerivationError(f"decision.font_judgment.{tier} has invalid aliases")
        flattened.extend(value)
    if (
        len(flattened) != 7
        or len(set(flattened)) != 7
        or set(flattened) != set(task["blind_alias_order"])
    ):
        raise DerivationError(
            "decision tiers must partition all frozen aliases exactly once"
        )
    if not set(task["mandatory_unrenderable"]).issubset(judgment["unrenderable"]):
        raise DerivationError("mandatory unrenderable candidates were not honored")
    safe_count = len(judgment["preferred"]) + len(judgment["acceptable"])
    if safe_count > 2:
        raise DerivationError("safe candidate cap exceeded")
    if judgment["none_acceptable"] is not (safe_count == 0):
        raise DerivationError("none_acceptable was not derived from safe count")


def _validate_audit(
    audit: Mapping[str, Any],
    task: Mapping[str, Any],
    annotation: Mapping[str, Any],
    decision: Mapping[str, Any],
) -> None:
    _validate_seal(audit, "audit", required=True)
    _require_exact_keys(audit, AUDIT_KEYS, "audit")
    if (
        audit.get("schema_version") != AUDIT_SCHEMA_VERSION
        or audit.get("record_type") != AUDIT_RECORD_TYPE
    ):
        raise DerivationError("audit has an unsupported contract")
    for key, expected in (
        ("assignment_id", task["assignment_id"]),
        ("sample_id", task["sample_id"]),
        ("stage", task["stage"]),
        ("reviewer_id", annotation["reviewer_id"]),
        ("batch_id", annotation["batch_id"]),
        ("batch_size", annotation["batch_size"]),
        ("batch_task_set_sha256", annotation["batch_task_set_sha256"]),
        ("task_record_sha256", task["task_record_sha256"]),
        ("source_task_record_sha256", task["source_task_record_sha256"]),
        ("source_annotation_record_sha256", annotation["record_sha256"]),
        (
            "source_annotation_canonical_sha256",
            annotation["canonical_annotation_sha256"],
        ),
        ("candidate_order_seed", task["candidate_order_seed"]),
        (
            "candidate_release_record_sha256",
            task["candidate_release_record_sha256"],
        ),
        ("release_challenge_sha256", task["release_challenge_sha256"]),
        ("release_nonce_sha256", task["release_nonce_sha256"]),
        ("full_card_sha256", task["full_card_sha256"]),
        ("source_only_card_sha256", task["source_only_card_sha256"]),
        ("candidate_only_card_sha256", task["candidate_only_card_sha256"]),
        ("decision_sha256", sha256_bytes(canonical_json_bytes(decision))),
    ):
        if audit.get(key) != expected:
            raise DerivationError(f"audit.{key} does not match its binding")
    audit_batch_size = audit.get("batch_size")
    if (
        isinstance(audit_batch_size, bool)
        or not isinstance(audit_batch_size, int)
        or audit_batch_size <= 0
    ):
        raise DerivationError("audit.batch_size must be a positive integer")
    audit_safe_count = audit.get("safe_count")
    if (
        isinstance(audit_safe_count, bool)
        or not isinstance(audit_safe_count, int)
        or not 0 <= audit_safe_count <= 2
    ):
        raise DerivationError("audit.safe_count must be an integer 0..2")
    _require_unit(
        audit.get("source_family_confidence"),
        "audit.source_family_confidence",
    )
    audit_axes = _require_mapping(audit.get("source_axes"), "audit.source_axes")
    _require_exact_keys(audit_axes, set(AXES), "audit.source_axes")
    for axis in AXES:
        _axis_value(audit_axes.get(axis), f"audit.source_axes.{axis}")
    candidates = audit.get("candidates")
    if (
        not isinstance(candidates, list)
        or any(not isinstance(item, Mapping) for item in candidates)
        or [item.get("alias") for item in candidates]
        != list(task["prototype_alias_order"])
    ):
        raise DerivationError("audit candidates are not in frozen deterministic order")
    # The exact schema is generated internally; this second pass makes identity
    # leakage impossible if validate functions are reused on external artifacts.
    eligibility = derive_eligibility(annotation)
    role, role_confidence, role_basis = derive_role(annotation)
    effective_family, family_notes = _effective_family(annotation)
    expected_top = {
        "eligibility": eligibility,
        "role": role,
        "role_basis": role_basis,
        "role_weight_group": ROLE_WEIGHT_GROUP[role],
        "source_family": annotation["source_family"],
        "source_family_confidence": annotation["source_family_confidence"],
        "effective_family_gate": effective_family,
        "family_gate_notes": family_notes,
        "source_axes": annotation["axes"],
        "hard_axes": annotation["hard_axes"],
        "treatment_observed_not_scored": annotation["treatment"],
    }
    for key, expected in expected_top.items():
        if audit.get(key) != expected:
            raise DerivationError(
                f"audit.{key} is numerically or semantically inconsistent"
            )
    if decision["role_confidence"] != role_confidence:
        raise DerivationError("decision.role_confidence differs from source evidence")

    for candidate in candidates:
        if set(candidate) != {
            "alias",
            "prototype_family",
            "prototype_axes",
            "distance",
            "axis_gaps",
            "normalized_role_weights",
            "distance_contributions",
            "largest_gap",
            "family_gate",
            "hard_axis_max_gap",
            "hard_failures",
            "tier_adjustments",
            "failed_hard_axes",
            "matched_hard_axes",
            "printed_hand_inversion",
            "mandatory_unrenderable",
            "semantic_gate_pass",
            "gate_pass",
            "neutral_tie_break",
            "would_be_safe_without_deployment",
            "tier",
            "safe",
        }:
            raise DerivationError("audit candidate has unexpected fields")
        if not ALIAS_RE.fullmatch(str(candidate["alias"])):
            raise DerivationError("audit contains a non-blind candidate identity")
        alias = str(candidate["alias"])
        if not isinstance(candidate["mandatory_unrenderable"], bool):
            raise DerivationError(
                "audit candidate mandatory_unrenderable must be boolean"
            )
        if not isinstance(candidate["safe"], bool):
            raise DerivationError("audit candidate safe must be boolean")
        if candidate["gate_pass"] is not None and not isinstance(
            candidate["gate_pass"], bool
        ):
            raise DerivationError("audit candidate gate_pass must be boolean or null")
        if candidate["semantic_gate_pass"] is not None and not isinstance(
            candidate["semantic_gate_pass"], bool
        ):
            raise DerivationError(
                "audit candidate semantic_gate_pass must be boolean or null"
            )
        if not isinstance(candidate["would_be_safe_without_deployment"], bool):
            raise DerivationError(
                "audit candidate would_be_safe_without_deployment must be boolean"
            )
        prototype_axes_value = _require_mapping(
            candidate["prototype_axes"], "audit candidate.prototype_axes"
        )
        _require_exact_keys(
            prototype_axes_value, set(AXES), "audit candidate.prototype_axes"
        )
        for axis in AXES:
            if (
                _axis_value(
                    prototype_axes_value.get(axis),
                    f"audit candidate.prototype_axes.{axis}",
                )
                is None
            ):
                raise DerivationError("audit candidate prototype axis cannot be null")
        if candidate["distance"] is not None:
            _require_unit(candidate["distance"], "audit candidate.distance")
        for mapping_name in (
            "normalized_role_weights",
            "distance_contributions",
        ):
            numeric_mapping = _require_mapping(
                candidate[mapping_name], f"audit candidate.{mapping_name}"
            )
            for axis, numeric in numeric_mapping.items():
                if axis not in AXES:
                    raise DerivationError(
                        f"audit candidate.{mapping_name} has an unsupported axis"
                    )
                _require_unit(numeric, f"audit candidate.{mapping_name}.{axis}")
        gaps_value = _require_mapping(
            candidate["axis_gaps"], "audit candidate.axis_gaps"
        )
        for axis, gap in gaps_value.items():
            if (
                axis not in AXES
                or _axis_value(gap, f"audit candidate.axis_gaps.{axis}") is None
            ):
                raise DerivationError("audit candidate axis gap is invalid")
        if (
            candidate["hard_axis_max_gap"] is not None
            and _axis_value(
                candidate["hard_axis_max_gap"],
                "audit candidate.hard_axis_max_gap",
            )
            is None
        ):
            raise DerivationError("audit candidate hard-axis max gap is invalid")
        largest_value = candidate["largest_gap"]
        if largest_value is not None:
            largest = _require_mapping(largest_value, "audit candidate.largest_gap")
            _require_exact_keys(
                largest, {"axis", "value"}, "audit candidate.largest_gap"
            )
            if (
                largest.get("axis") not in AXES
                or _axis_value(
                    largest.get("value"), "audit candidate.largest_gap.value"
                )
                is None
            ):
                raise DerivationError("audit candidate largest gap is invalid")
        prototype = task["prototype_by_alias"][alias]
        mandatory = alias in task["mandatory_unrenderable"]
        if (
            candidate["prototype_family"] != prototype["family"]
            or candidate["prototype_axes"] != prototype["axes"]
        ):
            raise DerivationError("audit candidate prototype changed")
        if candidate["mandatory_unrenderable"] is not mandatory:
            raise DerivationError("audit candidate deployment binding changed")
        if candidate["neutral_tie_break"] != _neutral_tie_break(task, alias):
            raise DerivationError("audit candidate neutral tie key changed")
        if eligibility != "font_signal_present":
            expected_non_present = {
                "distance": None,
                "axis_gaps": {},
                "normalized_role_weights": {},
                "distance_contributions": {},
                "largest_gap": None,
                "family_gate": "not_evaluated",
                "hard_axis_max_gap": None,
                "hard_failures": ["eligibility_exception"],
                "tier_adjustments": [],
                "failed_hard_axes": [],
                "matched_hard_axes": [],
                "printed_hand_inversion": False,
                "semantic_gate_pass": None,
                "gate_pass": None,
                "would_be_safe_without_deployment": False,
                "tier": None,
                "safe": False,
            }
            for key, expected in expected_non_present.items():
                if candidate[key] != expected:
                    raise DerivationError(
                        f"audit candidate {alias}.{key} is inconsistent"
                    )
            continue
        distance, gaps, contributions, normalized_weights = _distance(
            annotation["axes"], prototype["axes"], role
        )
        failures, failed_axes, printed_hand, family_gate = _candidate_gate(
            effective_family=effective_family,
            source_axes=annotation["axes"],
            hard_axes=annotation["hard_axes"],
            prototype=prototype,
            distance=distance,
            gaps=gaps,
        )
        matched_axes = [
            axis for axis in annotation["hard_axes"] if gaps.get(axis, math.inf) <= 1.0
        ]
        largest_gap = (
            None
            if not gaps
            else {
                "axis": min(
                    (axis for axis in gaps if gaps[axis] == max(gaps.values())),
                    key=AXES.index,
                ),
                "value": max(gaps.values()),
            }
        )
        hard_max = (
            None
            if not annotation["hard_axes"]
            else max(gaps[axis] for axis in annotation["hard_axes"])
        )
        expected_numeric = {
            "distance": distance,
            "axis_gaps": gaps,
            "normalized_role_weights": normalized_weights,
            "distance_contributions": contributions,
            "largest_gap": largest_gap,
            "family_gate": family_gate,
            "hard_axis_max_gap": hard_max,
            "hard_failures": failures,
            "failed_hard_axes": failed_axes,
            "matched_hard_axes": matched_axes,
            "printed_hand_inversion": printed_hand,
            "semantic_gate_pass": not failures,
            "gate_pass": not failures and not mandatory,
        }
        for key, expected in expected_numeric.items():
            if candidate[key] != expected:
                raise DerivationError(f"audit candidate {alias}.{key} is inconsistent")
        if normalized_weights and not math.isclose(
            sum(normalized_weights.values()), 1.0, abs_tol=5e-6
        ):
            raise DerivationError("audit normalized role weights do not sum to one")

    safe_count = 0
    if eligibility == "font_signal_present":
        semantic = [row for row in candidates if row["semantic_gate_pass"]]
        deployable = [row for row in semantic if not row["mandatory_unrenderable"]]
        semantic_minimum = min(
            (row["distance"] for row in semantic if row["distance"] is not None),
            default=None,
        )
        deployable_minimum = min(
            (row["distance"] for row in deployable if row["distance"] is not None),
            default=None,
        )
        expected_tiers: dict[str, str] = {}
        would_safe: dict[str, bool] = {}
        for row in candidates:
            alias = str(row["alias"])
            if row["mandatory_unrenderable"]:
                expected_tiers[alias] = "unrenderable"
                would_safe[alias] = bool(
                    row["semantic_gate_pass"]
                    and semantic_minimum is not None
                    and row["distance"] is not None
                    and _initial_tier(row["distance"], semantic_minimum)
                    in {"preferred", "acceptable"}
                )
            elif not row["semantic_gate_pass"]:
                expected_tiers[alias] = "unacceptable"
                would_safe[alias] = False
            else:
                assert deployable_minimum is not None and row["distance"] is not None
                expected_tiers[alias] = _initial_tier(
                    row["distance"], deployable_minimum
                )
                would_safe[alias] = False
        raw_safe = sorted(
            [
                row
                for row in candidates
                if expected_tiers[str(row["alias"])] in {"preferred", "acceptable"}
            ],
            key=_ranked_key,
        )
        allowed = {str(row["alias"]) for row in raw_safe[:2]}
        overflow = {str(row["alias"]) for row in raw_safe[2:]}
        for alias in overflow:
            expected_tiers[alias] = "marginal"
        for row in candidates:
            alias = str(row["alias"])
            expected_adjustments = ["safe_cap_overflow"] if alias in overflow else []
            if (
                row["tier"] != expected_tiers[alias]
                or row["safe"] is not (alias in allowed)
                or row["tier_adjustments"] != expected_adjustments
                or row["would_be_safe_without_deployment"] is not would_safe[alias]
            ):
                raise DerivationError(
                    f"audit candidate {alias} tier/cap state is inconsistent"
                )
        safe_count = len(allowed)
        judgment = _require_mapping(decision["font_judgment"], "decision.font_judgment")
        for tier in TIERS:
            expected_members = {
                alias
                for alias, expected_tier in expected_tiers.items()
                if expected_tier == tier
            }
            if set(judgment[tier]) != expected_members:
                raise DerivationError(
                    f"decision tier {tier} differs from the audit matrix"
                )
        if any(len(row["matched_hard_axes"]) < 2 for row in candidates if row["safe"]):
            raise DerivationError("safe candidate lacks two matched hard axes")
        if judgment["none_acceptable"] is not (safe_count == 0):
            raise DerivationError("audit/decision none state is inconsistent")
    elif decision["font_judgment"] is not None:
        raise DerivationError("eligibility exception has candidate tiers")

    if audit.get("safe_count") != safe_count:
        raise DerivationError("audit.safe_count is inconsistent")
    none_audit = audit.get("none_audit")
    if eligibility != "font_signal_present" or safe_count:
        if none_audit is not None:
            raise DerivationError("audit.none_audit exists when none was not derived")
    else:
        none_value = _require_mapping(none_audit, "audit.none_audit")
        if set(none_value) != {"reason_code", "nearest_two"}:
            raise DerivationError("audit.none_audit has unexpected fields")
        nearest = sorted(
            [row for row in candidates if not row["mandatory_unrenderable"]],
            key=_ranked_key,
        )[:2]
        expected_nearest = [
            {
                "alias": row["alias"],
                "distance": row["distance"],
                "failed_hard_axes": row["failed_hard_axes"],
                "hard_failures": row["hard_failures"],
            }
            for row in nearest
        ]
        deployment_blocked = any(
            row["mandatory_unrenderable"] and row["would_be_safe_without_deployment"]
            for row in candidates
        )
        expected_reason = _none_reason(
            effective_family=effective_family,
            annotation=annotation,
            mandatory_count=len(task["mandatory_unrenderable"]),
            deployment_blocked_safe=deployment_blocked,
        )
        if (
            none_value.get("nearest_two") != expected_nearest
            or none_value.get("reason_code") != expected_reason
        ):
            raise DerivationError("audit.none_audit is inconsistent")


def _load_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise DerivationError(f"cannot read {path}: {error}") from error
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise DerivationError(f"{label}[{line_number}] blank lines are forbidden")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise DerivationError(
                f"{label}[{line_number}] invalid JSON: {error}"
            ) from error
        if not isinstance(value, dict):
            raise DerivationError(f"{label}[{line_number}] must be an object")
        rows.append(value)
    if not rows:
        raise DerivationError(f"{label} must not be empty")
    return rows


def task_batch_sha256(tasks: Sequence[Mapping[str, Any]]) -> str:
    rows = [
        {
            "assignment_id": task["assignment_id"],
            "sample_id": task["sample_id"],
            "stage": task["stage"],
            "task_record_sha256": task.get(
                "source_task_record_sha256", task["task_record_sha256"]
            ),
            "source_only_card_sha256": task["source_only_card_sha256"],
        }
        for task in sorted(tasks, key=lambda row: str(row["assignment_id"]))
    ]
    return sha256_bytes(canonical_json_bytes(rows))


def _validate_batch_binding(
    tasks: Sequence[Mapping[str, Any]],
    annotations: Mapping[str, Mapping[str, Any]],
    *,
    reviewer_id: str | None = None,
) -> None:
    if not tasks:
        raise DerivationError("A batch must not be empty")
    expected_sha = task_batch_sha256(tasks)
    expected_size = len(tasks)
    batch_ids: set[str] = set()
    annotation_shas: set[str] = set()
    stages = {str(task["stage"]) for task in tasks}
    if len(stages) != 1:
        raise DerivationError("A batch must contain exactly one review stage")
    for task in tasks:
        annotation = annotations.get(str(task["sample_id"]))
        if annotation is None:
            raise DerivationError(
                "whole assigned A batch must be sealed before B derivation"
            )
        if annotation["batch_task_set_sha256"] != expected_sha:
            raise DerivationError(
                "annotation batch task-set seal does not match all assigned A tasks"
            )
        if annotation["batch_size"] != expected_size:
            raise DerivationError(
                "annotation batch_size does not cover the whole assigned A batch"
            )
        if annotation["stage"] != task["stage"]:
            raise DerivationError("annotation stage differs from its assigned A task")
        if reviewer_id is not None and annotation["reviewer_id"] != reviewer_id:
            raise DerivationError("annotation reviewer does not match --reviewer")
        batch_ids.add(str(annotation["batch_id"]))
        annotation_sha = str(annotation["record_sha256"])
        if annotation_sha in annotation_shas:
            raise DerivationError("primary/secondary A annotation seal was reused")
        annotation_shas.add(annotation_sha)
    if len(batch_ids) != 1:
        raise DerivationError("all A annotations must bind one batch_id")


def validate_candidate_release(
    record: Mapping[str, Any],
    tasks: Sequence[Mapping[str, Any]],
    annotations: Mapping[str, Mapping[str, Any]],
    *,
    reviewer_id: str | None = None,
    location: str = "candidate_release",
) -> dict[str, Any]:
    """Validate the immutable state transition that authorizes candidate B."""

    _validate_seal(record, location, required=True)
    _require_exact_keys(record, RELEASE_KEYS, location)
    if (
        record.get("schema_version") != RELEASE_SCHEMA_VERSION
        or record.get("record_type") != RELEASE_RECORD_TYPE
    ):
        raise DerivationError(f"{location} has another release contract")
    release_id = _require_id(record.get("release_id"), f"{location}.release_id")
    source_commit_id = _require_id(
        record.get("source_commit_id"), f"{location}.source_commit_id"
    )
    source_commit_sha = _require_sha(
        record.get("source_commit_record_sha256"),
        f"{location}.source_commit_record_sha256",
    )
    stage = _review_stage(record.get("stage"), f"{location}.stage")
    reviewer = _require_id(record.get("reviewer_id"), f"{location}.reviewer_id")
    if reviewer_id is not None and reviewer != reviewer_id:
        raise DerivationError(f"{location}.reviewer_id does not match --reviewer")
    batch_id = _require_id(record.get("batch_id"), f"{location}.batch_id")
    batch_size = record.get("batch_size")
    if (
        isinstance(batch_size, bool)
        or not isinstance(batch_size, int)
        or batch_size <= 0
    ):
        raise DerivationError(f"{location}.batch_size must be a positive integer")
    batch_sha = _require_sha(
        record.get("batch_task_set_sha256"), f"{location}.batch_task_set_sha256"
    )
    release_nonce = _require_sha(
        record.get("release_nonce"), f"{location}.release_nonce"
    )
    release_nonce_sha = _require_sha(
        record.get("release_nonce_sha256"), f"{location}.release_nonce_sha256"
    )
    if sha256_bytes(release_nonce.encode("ascii")) != release_nonce_sha:
        raise DerivationError(f"{location}.release_nonce_sha256 changed")
    expected_release_id = "fmbr-" + sha256_bytes(
        canonical_json_bytes(
            [
                "font-matching-v5-candidate-release",
                source_commit_id,
                source_commit_sha,
                release_nonce_sha,
            ]
        )
    )[:32]
    if release_id != expected_release_id:
        raise DerivationError(f"{location}.release_id is not nonce-bound")
    released_at = _require_text(record.get("released_at"), f"{location}.released_at")
    entries_value = record.get("entries")
    if not isinstance(entries_value, list) or not entries_value:
        raise DerivationError(f"{location}.entries must be a non-empty array")
    entries: list[dict[str, Any]] = []
    seen_assignments: set[str] = set()
    for index, value in enumerate(entries_value):
        entry = _require_mapping(value, f"{location}.entries[{index}]")
        _require_exact_keys(entry, RELEASE_ENTRY_KEYS, f"{location}.entries[{index}]")
        assignment_id = _require_id(
            entry.get("assignment_id"),
            f"{location}.entries[{index}].assignment_id",
        )
        aliases_value = entry.get("blind_alias_order")
        if (
            not isinstance(aliases_value, list)
            or any(not isinstance(alias, str) for alias in aliases_value)
            or aliases_value != release_alias_order(release_nonce_sha, assignment_id)
        ):
            raise DerivationError(
                f"{location}.entries[{index}].blind_alias_order is not fresh"
            )
        mandatory_value = entry.get("mandatory_unrenderable")
        if (
            not isinstance(mandatory_value, list)
            or len(mandatory_value) != len(set(mandatory_value))
            or not set(mandatory_value).issubset(aliases_value)
        ):
            raise DerivationError(
                f"{location}.entries[{index}].mandatory_unrenderable is invalid"
            )
        anchors_value = _require_mapping(
            entry.get("neutral_tie_anchors"),
            f"{location}.entries[{index}].neutral_tie_anchors",
        )
        _require_exact_keys(
            anchors_value,
            ANCHOR_KEYS,
            f"{location}.entries[{index}].neutral_tie_anchors",
        )
        normalized_entry: dict[str, Any] = {
            "assignment_id": assignment_id,
            "sample_id": _require_id(
                entry.get("sample_id"), f"{location}.entries[{index}].sample_id"
            ),
            "source_task_record_sha256": _require_sha(
                entry.get("source_task_record_sha256"),
                f"{location}.entries[{index}].source_task_record_sha256",
            ),
            "source_annotation_record_sha256": _require_sha(
                entry.get("source_annotation_record_sha256"),
                f"{location}.entries[{index}].source_annotation_record_sha256",
            ),
            "candidate_batch_order": _review_order(
                entry.get("candidate_batch_order"),
                f"{location}.entries[{index}].candidate_batch_order",
            ),
            "blind_alias_order": list(aliases_value),
            "candidate_order_seed": _require_sha(
                entry.get("candidate_order_seed"),
                f"{location}.entries[{index}].candidate_order_seed",
            ),
            "mandatory_unrenderable": list(mandatory_value),
            "full_card_sha256": _require_sha(
                entry.get("full_card_sha256"),
                f"{location}.entries[{index}].full_card_sha256",
            ),
            "source_only_card_sha256": _require_sha(
                entry.get("source_only_card_sha256"),
                f"{location}.entries[{index}].source_only_card_sha256",
            ),
            "candidate_only_card_sha256": _require_sha(
                entry.get("candidate_only_card_sha256"),
                f"{location}.entries[{index}].candidate_only_card_sha256",
            ),
            "neutral_tie_anchors": {
                key: _require_sha(
                    anchors_value.get(key),
                    f"{location}.entries[{index}].neutral_tie_anchors.{key}",
                )
                for key in sorted(ANCHOR_KEYS)
            },
        }
        if normalized_entry["candidate_order_seed"] != release_candidate_order_seed(
            release_nonce_sha, assignment_id
        ):
            raise DerivationError(
                f"{location}.entries[{index}].candidate_order_seed is not fresh"
            )
        if len(
            {
                normalized_entry["full_card_sha256"],
                normalized_entry["source_only_card_sha256"],
                normalized_entry["candidate_only_card_sha256"],
            }
        ) != 3:
            raise DerivationError(
                f"{location}.entries[{index}] card hashes must be distinct"
            )
        if normalized_entry["assignment_id"] in seen_assignments:
            raise DerivationError(f"{location}.entries repeats assignment_id")
        seen_assignments.add(normalized_entry["assignment_id"])
        entries.append(normalized_entry)
    if entries != sorted(entries, key=lambda row: row["assignment_id"]):
        raise DerivationError(f"{location}.entries must use canonical assignment order")
    expected_b_order = release_batch_order(
        release_nonce_sha, [row["assignment_id"] for row in entries]
    )
    if any(
        row["candidate_batch_order"] != expected_b_order[row["assignment_id"]]
        for row in entries
    ):
        raise DerivationError(
            f"{location}.entries candidate_batch_order is not nonce-derived"
        )

    _validate_batch_binding(tasks, annotations, reviewer_id=reviewer)
    entries_by_assignment = {row["assignment_id"]: row for row in entries}
    for task in sorted(tasks, key=lambda row: str(row["assignment_id"])):
        annotation = annotations[str(task["sample_id"])]
        entry = entries_by_assignment.get(str(task["assignment_id"]))
        if entry is None or {
            "sample_id": entry["sample_id"],
            "source_task_record_sha256": entry["source_task_record_sha256"],
            "source_annotation_record_sha256": entry[
                "source_annotation_record_sha256"
            ],
            "source_only_card_sha256": entry["source_only_card_sha256"],
        } != {
            "sample_id": str(task["sample_id"]),
            "source_task_record_sha256": str(task["source_task_record_sha256"]),
            "source_annotation_record_sha256": str(annotation["record_sha256"]),
            "source_only_card_sha256": str(task["source_only_card_sha256"]),
        }:
            raise DerivationError(
                f"{location} entry differs from its sealed source-only A task"
            )
    expected_batch_ids = {str(row["batch_id"]) for row in annotations.values()}
    if (
        stage != next(iter({str(task["stage"]) for task in tasks}))
        or batch_size != len(tasks)
        or batch_sha != task_batch_sha256(tasks)
        or expected_batch_ids != {batch_id}
        or set(entries_by_assignment)
        != {str(task["assignment_id"]) for task in tasks}
    ):
        raise DerivationError(
            f"{location} does not authorize this exact sealed A batch"
        )
    return {
        "schema_version": RELEASE_SCHEMA_VERSION,
        "record_type": RELEASE_RECORD_TYPE,
        "release_id": release_id,
        "source_commit_id": source_commit_id,
        "source_commit_record_sha256": source_commit_sha,
        "stage": str(stage),
        "reviewer_id": reviewer,
        "batch_id": batch_id,
        "batch_size": batch_size,
        "batch_task_set_sha256": batch_sha,
        "release_nonce": release_nonce,
        "release_nonce_sha256": release_nonce_sha,
        "entries": entries,
        "released_at": released_at,
        "record_sha256": str(record["record_sha256"]),
    }


def materialize_candidate_task(
    release: Mapping[str, Any],
    entry: Mapping[str, Any],
    source_task: Mapping[str, Any],
) -> dict[str, Any]:
    """Materialize the first candidate-bearing task after release sealing."""

    if (
        entry["assignment_id"] != source_task["assignment_id"]
        or entry["sample_id"] != source_task["sample_id"]
        or entry["source_task_record_sha256"]
        != source_task["source_task_record_sha256"]
        or entry["source_only_card_sha256"]
        != source_task["source_only_card_sha256"]
    ):
        raise DerivationError("candidate release entry differs from its source task")
    challenge = candidate_release_challenge(
        release_record_sha256=str(release["record_sha256"]),
        release_nonce_sha256=str(release["release_nonce_sha256"]),
        assignment_id=str(entry["assignment_id"]),
        source_task_record_sha256=str(entry["source_task_record_sha256"]),
        source_annotation_record_sha256=str(
            entry["source_annotation_record_sha256"]
        ),
        full_card_sha256=str(entry["full_card_sha256"]),
        candidate_only_card_sha256=str(entry["candidate_only_card_sha256"]),
    )
    return seal_record(
        {
            "schema_version": TASK_SCHEMA_VERSION,
            "record_type": TASK_RECORD_TYPE,
            "assignment_id": entry["assignment_id"],
            "sample_id": entry["sample_id"],
            "stage": release["stage"],
            "review_order": entry["candidate_batch_order"],
            "source_task_record_sha256": entry["source_task_record_sha256"],
            "source_annotation_record_sha256": entry[
                "source_annotation_record_sha256"
            ],
            "candidate_batch_order": entry["candidate_batch_order"],
            "blind_alias_order": list(entry["blind_alias_order"]),
            "candidate_count": 7,
            "candidate_order_seed": entry["candidate_order_seed"],
            "mandatory_unrenderable": list(entry["mandatory_unrenderable"]),
            "full_card_sha256": entry["full_card_sha256"],
            "source_only_card_sha256": entry["source_only_card_sha256"],
            "candidate_only_card_sha256": entry["candidate_only_card_sha256"],
            "neutral_tie_anchors": copy.deepcopy(entry["neutral_tie_anchors"]),
            "candidate_release_id": release["release_id"],
            "candidate_release_record_sha256": release["record_sha256"],
            "release_nonce_sha256": release["release_nonce_sha256"],
            "release_challenge_sha256": challenge,
            "review_surface": dict(REVIEW_SURFACE),
        }
    )


def validate_candidate_tasks_for_release(
    tasks: Sequence[Mapping[str, Any]], release: Mapping[str, Any]
) -> None:
    entries = {
        str(entry["assignment_id"]): entry for entry in release["entries"]
    }
    if {str(task["assignment_id"]) for task in tasks} != set(entries):
        raise DerivationError("candidate task coverage differs from its release")
    for task in tasks:
        entry = entries[str(task["assignment_id"])]
        expected = {
            "sample_id": entry["sample_id"],
            "review_order": entry["candidate_batch_order"],
            "candidate_batch_order": entry["candidate_batch_order"],
            "source_task_record_sha256": entry["source_task_record_sha256"],
            "source_annotation_record_sha256": entry[
                "source_annotation_record_sha256"
            ],
            "blind_alias_order": entry["blind_alias_order"],
            "candidate_order_seed": entry["candidate_order_seed"],
            "mandatory_unrenderable": entry["mandatory_unrenderable"],
            "full_card_sha256": entry["full_card_sha256"],
            "source_only_card_sha256": entry["source_only_card_sha256"],
            "candidate_only_card_sha256": entry["candidate_only_card_sha256"],
            "neutral_tie_anchors": entry["neutral_tie_anchors"],
            "candidate_release_id": release["release_id"],
            "candidate_release_record_sha256": release["record_sha256"],
            "release_nonce_sha256": release["release_nonce_sha256"],
        }
        for key, value in expected.items():
            if task.get(key) != value:
                raise DerivationError(
                    f"candidate task {task['assignment_id']}.{key} differs from release"
                )


def load_candidate_release(
    path: Path,
    tasks: Sequence[Mapping[str, Any]],
    annotations: Mapping[str, Mapping[str, Any]],
    *,
    reviewer_id: str,
) -> dict[str, Any]:
    expected_assignments = {str(task["assignment_id"]) for task in tasks}
    matching: list[dict[str, Any]] = []
    for index, raw in enumerate(_load_jsonl(path, "candidate_releases"), 1):
        try:
            normalized = validate_candidate_release(
                raw,
                tasks,
                annotations,
                reviewer_id=reviewer_id,
                location=f"candidate_releases[{index}]",
            )
        except DerivationError:
            continue
        if {
            entry["assignment_id"] for entry in normalized["entries"]
        } == expected_assignments:
            matching.append(normalized)
    if len(matching) != 1:
        raise DerivationError(
            "exactly one immutable candidate-B release must authorize this A batch"
        )
    validate_candidate_tasks_for_release(tasks, matching[0])
    return matching[0]


def validate_source_commit_ledger(
    path: Path,
    release: Mapping[str, Any],
    annotations: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Bind standalone derivation to the actual append-only A commit ledger."""

    previous_sha: str | None = None
    matching: list[dict[str, Any]] = []
    for index, raw in enumerate(_load_jsonl(path, "source_commits"), 1):
        location = f"source_commits[{index}]"
        _validate_seal(raw, location, required=True)
        _require_exact_keys(raw, SOURCE_COMMIT_KEYS, location)
        if (
            raw.get("schema_version") != SOURCE_COMMIT_SCHEMA_VERSION
            or raw.get("record_type") != SOURCE_COMMIT_RECORD_TYPE
        ):
            raise DerivationError(f"{location} has another source-commit contract")
        if raw.get("previous_commit_record_sha256") != previous_sha:
            raise DerivationError(f"{location} breaks the append-only commit chain")
        committed_annotations = raw.get("annotations")
        if not isinstance(committed_annotations, list) or not committed_annotations:
            raise DerivationError(f"{location}.annotations must be non-empty")
        if raw.get("annotation_jsonl_sha256") != sha256_bytes(
            jsonl_bytes(committed_annotations)
        ):
            raise DerivationError(f"{location}.annotation_jsonl_sha256 changed")
        if (
            raw.get("commit_id") == release["source_commit_id"]
            and raw.get("record_sha256")
            == release["source_commit_record_sha256"]
        ):
            matching.append(raw)
        previous_sha = str(raw["record_sha256"])
    if len(matching) != 1:
        raise DerivationError(
            "candidate release lacks exactly one provenance-matching source commit"
        )
    commit = matching[0]
    annotation_shas = {
        str(value["record_sha256"]) for value in annotations.values()
    }
    committed_shas = {
        str(_require_mapping(value, "source commit annotation").get("record_sha256"))
        for value in commit["annotations"]
    }
    if (
        commit.get("stage") != release["stage"]
        or commit.get("reviewer_id") != release["reviewer_id"]
        or commit.get("batch_id") != release["batch_id"]
        or commit.get("batch_size") != release["batch_size"]
        or commit.get("batch_task_set_sha256")
        != release["batch_task_set_sha256"]
        or committed_shas != annotation_shas
    ):
        raise DerivationError(
            "candidate release differs from the actual committed A batch"
        )
    return commit


def load_inputs(
    task_path: Path,
    annotation_path: Path,
    *,
    stage: str | None,
    reviewer_id: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    raw_tasks = _load_jsonl(task_path, "tasks")
    tasks: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_tasks, 1):
        normalized = validate_task(raw, f"tasks[{index}]")
        if stage is None or normalized["stage"] == stage:
            tasks.append(normalized)
    if not tasks:
        raise DerivationError("no blind tasks match the requested stage")
    assignment_ids = [task["assignment_id"] for task in tasks]
    sample_ids = [task["sample_id"] for task in tasks]
    if len(assignment_ids) != len(set(assignment_ids)):
        raise DerivationError(
            "selected blind tasks contain duplicate assignment_id values"
        )
    if len(sample_ids) != len(set(sample_ids)):
        raise DerivationError(
            "selected tasks repeat sample_id; pass --stage or split the task file"
        )

    annotations: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(_load_jsonl(annotation_path, "annotations"), 1):
        normalized = validate_annotation(raw, f"annotations[{index}]")
        sample_id = normalized["sample_id"]
        if sample_id in annotations:
            raise DerivationError(f"annotations repeat sample_id {sample_id}")
        annotations[sample_id] = normalized
    task_set = set(sample_ids)
    annotation_set = set(annotations)
    if task_set != annotation_set:
        raise DerivationError(
            "task/annotation sample coverage mismatch; "
            f"missing={sorted(task_set - annotation_set)}, extra={sorted(annotation_set - task_set)}"
        )
    tasks.sort(
        key=lambda row: (row["review_order"], row["sample_id"], row["assignment_id"])
    )
    _validate_batch_binding(tasks, annotations, reviewer_id=reviewer_id)
    return tasks, annotations


def derive_all(
    tasks: Sequence[Mapping[str, Any]],
    annotations: Mapping[str, Mapping[str, Any]],
    *,
    release: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    _validate_batch_binding(tasks, annotations)
    validate_candidate_tasks_for_release(tasks, release)
    decisions: list[dict[str, Any]] = []
    audits: list[dict[str, Any]] = []
    for task in tasks:
        decision, audit = derive_one(task, annotations[task["sample_id"]])
        decisions.append(decision)
        audits.append(audit)
    return decisions, audits


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _write_once(path: Path, data: bytes) -> None:
    if path.exists():
        raise DerivationError(f"refusing to overwrite existing output: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # The temporary file is on the destination filesystem, so a hard
            # link is an atomic O_EXCL-style publication and never replaces an
            # existing path on either POSIX or Windows.
            os.link(temporary_path, path)
        except FileExistsError as error:
            raise DerivationError(
                f"refusing to overwrite existing output: {path}"
            ) from error
    finally:
        temporary_path.unlink(missing_ok=True)


def _assert_derive_paths_disjoint(args: argparse.Namespace) -> None:
    paths = {
        "tasks": args.tasks.resolve(),
        "annotations": args.annotations.resolve(),
        "candidate_release": args.candidate_release.resolve(),
        "source_commits": args.source_commits.resolve(),
        "decisions": args.decisions.resolve(),
        "audit": args.audit.resolve(),
    }
    if len(set(paths.values())) != len(paths):
        raise DerivationError(
            "task, annotation, decision, and audit paths must be disjoint"
        )
    for output_name in ("decisions", "audit"):
        output = paths[output_name]
        for input_name in (
            "tasks",
            "annotations",
            "candidate_release",
            "source_commits",
        ):
            source = paths[input_name]
            try:
                output.relative_to(source)
            except ValueError:
                pass
            else:
                raise DerivationError(
                    f"{output_name} output must not be inside {input_name} input"
                )
            try:
                source.relative_to(output)
            except ValueError:
                pass
            else:
                raise DerivationError(
                    f"{output_name} output must not contain {input_name} input"
                )


def command_derive(args: argparse.Namespace) -> None:
    _assert_derive_paths_disjoint(args)
    reviewer_id = _require_id(args.reviewer, "--reviewer")
    tasks, annotations = load_inputs(
        args.tasks, args.annotations, stage=args.stage, reviewer_id=reviewer_id
    )
    release = load_candidate_release(
        args.candidate_release,
        tasks,
        annotations,
        reviewer_id=reviewer_id,
    )
    validate_source_commit_ledger(args.source_commits, release, annotations)
    decisions, audits = derive_all(tasks, annotations, release=release)
    if args.decisions.exists() or args.audit.exists():
        raise DerivationError("v5 derivation outputs are write-once")
    decision_data = jsonl_bytes(decisions)
    audit_data = jsonl_bytes(audits)
    # Both payloads are complete and validated before either destination changes.
    # Publish the decision last so it acts as the pair's consumer-visible marker;
    # each individual replacement is atomic on the destination filesystem.
    _write_once(args.audit, audit_data)
    try:
        _write_once(args.decisions, decision_data)
    except BaseException:
        # Roll back only the audit bytes published by this invocation.  This
        # keeps the two-file marker atomic without deleting a concurrently
        # changed artifact.
        if args.audit.is_file() and args.audit.read_bytes() == audit_data:
            args.audit.unlink()
        raise
    print(
        json.dumps(
            {
                "status": "derived",
                "records": len(decisions),
                "decisions_sha256": sha256_bytes(decision_data),
                "audit_sha256": sha256_bytes(audit_data),
            },
            sort_keys=True,
        )
    )


def command_validate(args: argparse.Namespace) -> None:
    reviewer_id = _require_id(args.reviewer, "--reviewer")
    tasks, annotations = load_inputs(
        args.tasks, args.annotations, stage=args.stage, reviewer_id=reviewer_id
    )
    release = load_candidate_release(
        args.candidate_release,
        tasks,
        annotations,
        reviewer_id=reviewer_id,
    )
    validate_source_commit_ledger(args.source_commits, release, annotations)
    expected_decisions, expected_audits = derive_all(
        tasks, annotations, release=release
    )
    actual_decisions = _load_jsonl(args.decisions, "decisions")
    actual_audits = _load_jsonl(args.audit, "audit")
    if actual_decisions != expected_decisions:
        raise DerivationError(
            "decision output is stale, tampered, reordered, or misbound"
        )
    if actual_audits != expected_audits:
        raise DerivationError("audit output is stale, tampered, reordered, or misbound")
    decision_data = jsonl_bytes(actual_decisions)
    audit_data = jsonl_bytes(actual_audits)
    if args.decisions.read_bytes() != decision_data:
        raise DerivationError("decision JSONL is not in canonical deterministic form")
    if args.audit.read_bytes() != audit_data:
        raise DerivationError("audit JSONL is not in canonical deterministic form")
    print(
        json.dumps(
            {
                "status": "valid",
                "records": len(actual_decisions),
                "decisions_sha256": sha256_bytes(decision_data),
                "audit_sha256": sha256_bytes(audit_data),
            },
            sort_keys=True,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("derive", command_derive), ("validate", command_validate)):
        child = subparsers.add_parser(name)
        child.add_argument(
            "--tasks", "--task-jsonl", dest="tasks", type=Path, required=True
        )
        child.add_argument(
            "--annotations",
            "--annotation-jsonl",
            dest="annotations",
            type=Path,
            required=True,
        )
        child.add_argument(
            "--decisions",
            "--decision-output",
            dest="decisions",
            type=Path,
            required=True,
        )
        child.add_argument(
            "--audit", "--audit-output", dest="audit", type=Path, required=True
        )
        child.add_argument(
            "--candidate-release",
            type=Path,
            required=True,
            help="immutable ledger release created only after the whole A batch commits",
        )
        child.add_argument(
            "--source-commits",
            type=Path,
            required=True,
            help="actual append-only source-commit ledger bound by the release",
        )
        child.add_argument("--stage", choices=("primary", "secondary", "adjudication"))
        child.add_argument("--reviewer", required=True)
        child.set_defaults(handler=handler)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.handler(args)
    except (DerivationError, OSError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    sys.exit(main())
