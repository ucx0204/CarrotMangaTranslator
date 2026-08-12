#!/usr/bin/env python3
"""Refine active21 pseudo labels with bounded visual and Single Day evidence.

The input stays pseudo supervision.  This tool never promotes A-H visual
choices, source-category heuristics, or model agreement to human gold.  It
preserves the existing mass21 loader schema and teacher bindings, records every
changed row in a sealed lineage file, and publishes through a staged directory.
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
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

try:
    from scripts import audit_manga_font_student_v7_mass21_relabel as audit
    from scripts import build_manga_font_visual_pseudo_overlay_v1 as visual
    from scripts import label_manga_font_student_v7_mass21_pass as labeler
except ImportError:  # pragma: no cover - direct execution from scripts/
    import audit_manga_font_student_v7_mass21_relabel as audit
    import build_manga_font_visual_pseudo_overlay_v1 as visual
    import label_manga_font_student_v7_mass21_pass as labeler


SCHEMA = "manga-font-v2-pseudo-refinement-v1"
MANIFEST_SCHEMA = "manga-font-v2-pseudo-refinement-manifest-v1"
REPORT_SCHEMA = "manga-font-v2-pseudo-refinement-report-v1"
LINEAGE_SCHEMA = "manga-font-v2-pseudo-refinement-lineage-v1"
OWNER = "carrot-manga-translator/manga-font-v2-pseudo-refinement-v1"
AUTHORITY = "pseudo_v2_refinement_not_gold"
LOADER_AUTHORITY = "pseudo_soft_not_gold"
LINEAGE_AUTHORITY = "pseudo_not_gold"
MARKER_FILE = ".manga-font-v2-pseudo-refinement-owned.json"
PSEUDO_FILE = "refined-pseudo-targets.jsonl"
LINEAGE_FILE = "refinement-lineage.jsonl"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset(
    {MARKER_FILE, PSEUDO_FILE, LINEAGE_FILE, MANIFEST_FILE, REPORT_FILE}
)
EXPECTED_PSEUDO_ROWS = 18_952
EXPECTED_REVIEW_ROWS = 28_094
SINGLE_DAY_ID = "single-day"
RETIRED_FONT_ID = "gugi"


class PseudoRefinementError(ValueError):
    """Raised when a refinement input or output crosses a sealed boundary."""


@dataclass(frozen=True)
class Parameters:
    ordinary_single_day_multiplier: float = 0.08
    bubble_edge_single_day_multiplier: float = 0.55
    uncertain_single_day_multiplier: float = 0.75
    consensus_confidence: float = 0.72
    consensus_max_disagreement: float = 0.0
    visual_strength_min: float = 0.75
    visual_strength_max: float = 0.95
    visual_selected_mass: float = 0.82
    visual_acceptable_mass: float = 0.10
    visual_weight_floor: float = 0.85
    ordinary_weight_floor: float = 0.80
    bubble_edge_weight_floor: float = 0.60
    negative_weight_min_probability: float = 0.02


@dataclass(frozen=True)
class PassEvidence:
    sample_id: str
    record_sha256: str
    split: str
    source_category: str
    master_row_sha256: str
    work_id: str
    selected_font_id: str
    confidence: float
    top1_disagreement: float


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
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


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    row = copy.deepcopy(dict(core))
    row.pop("record_sha256", None)
    row["record_sha256"] = sha256_bytes(canonical_json(row).encode("utf-8"))
    return row


def validate_record_seal(row: Mapping[str, Any], *, location: str) -> None:
    expected = row.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise PseudoRefinementError(f"{location}: invalid record seal")
    core = {key: value for key, value in row.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise PseudoRefinementError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PseudoRefinementError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise PseudoRefinementError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise PseudoRefinementError(f"{location}: expected text")
    return result


def _sha(value: Any, location: str) -> str:
    result = _text(value, location)
    if len(result) != 64 or any(
        character not in "0123456789abcdef" for character in result
    ):
        raise PseudoRefinementError(f"{location}: expected lowercase SHA-256")
    return result


def _number(value: Any, location: str, *, minimum: float, maximum: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or not minimum <= float(value) <= maximum
    ):
        raise PseudoRefinementError(
            f"{location}: expected finite number in [{minimum},{maximum}]"
        )
    return float(value)


def _iter_jsonl(path: Path, location: str) -> Iterable[tuple[int, dict[str, Any]]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise PseudoRefinementError(f"{location}: missing or linked file")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as error:
                raise PseudoRefinementError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield line_number, dict(_mapping(raw, f"{location}:{line_number}"))


def _ordered_sha(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _active_ids() -> tuple[str, ...]:
    values = audit.active_candidate_ids()
    if len(values) != 21 or RETIRED_FONT_ID in values or SINGLE_DAY_ID not in values:
        raise PseudoRefinementError("active21 candidate contract drifted")
    return values


def _validate_parameters(parameters: Parameters) -> None:
    values = asdict(parameters)
    for name, value in values.items():
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise PseudoRefinementError(f"parameter {name} must be in [0,1]")
    if not (
        parameters.ordinary_single_day_multiplier
        < parameters.bubble_edge_single_day_multiplier
        < 1.0
    ):
        raise PseudoRefinementError(
            "Single Day multipliers must enforce ordinary < bubble_edge < 1"
        )
    if (
        not parameters.bubble_edge_single_day_multiplier
        < parameters.uncertain_single_day_multiplier
        < 1.0
    ):
        raise PseudoRefinementError(
            "uncertain Single Day multiplier must be weaker than bubble-edge suppression"
        )
    if not 0.5 <= parameters.visual_strength_min <= parameters.visual_strength_max:
        raise PseudoRefinementError("visual soft-target strength range drifted")
    if not 0.5 < parameters.visual_selected_mass < 1.0:
        raise PseudoRefinementError(
            "visual selected mass must prefer the selected font"
        )
    if parameters.visual_selected_mass + parameters.visual_acceptable_mass >= 1.0:
        raise PseudoRefinementError(
            "visual target must retain non-positive residual mass"
        )


def _artifact_descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("wb") as handle:
        for row in rows:
            handle.write(json_bytes(row))


def _validate_source_pseudo_row(
    row: Mapping[str, Any], *, candidate_ids: tuple[str, ...], location: str
) -> None:
    try:
        audit._validate_pseudo_row(  # noqa: SLF001
            row, candidate_ids=candidate_ids, location=location
        )
    except audit.RelabelAuditError as error:
        raise PseudoRefinementError(str(error)) from error


def _source_bundle_kind(source: Path) -> tuple[str, Mapping[str, Any]]:
    parent = source.parent
    if source.name == PSEUDO_FILE and (parent / MARKER_FILE).is_file():
        return "v2_refinement", validate_output(parent)
    if source.name == visual.PSEUDO_FILE and (parent / visual.MARKER_FILE).is_file():
        try:
            return "visual_overlay", visual.validate_output(parent)
        except (
            visual.VisualPseudoOverlayError,
            OSError,
            KeyError,
            ValueError,
        ) as error:
            raise PseudoRefinementError(
                f"visual overlay validation failed: {error}"
            ) from error
    if source.name == audit.NEXT_PSEUDO_FILE and (parent / audit.MARKER).is_file():
        try:
            return "relabel_audit", audit.validate_output(parent)
        except (audit.RelabelAuditError, OSError, KeyError, ValueError) as error:
            raise PseudoRefinementError(
                f"relabel audit validation failed: {error}"
            ) from error
    raise PseudoRefinementError(
        "pseudo input must belong to a sealed relabel-audit, visual-overlay, or v2 refinement bundle"
    )


def _load_pseudo_input(
    path: Path, *, expected_row_count: int
) -> tuple[list[dict[str, Any]], tuple[str, ...], Mapping[str, Any]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise PseudoRefinementError("pseudo input is missing or linked")
    kind, validation = _source_bundle_kind(source)
    candidate_ids = _active_ids()
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    teacher_hashes: Counter[str] = Counter()
    for line_number, row in _iter_jsonl(source, "source pseudo"):
        _validate_source_pseudo_row(
            row, candidate_ids=candidate_ids, location=f"source pseudo:{line_number}"
        )
        sample_id = _text(
            row.get("sample_id"), f"source pseudo:{line_number}.sample_id"
        )
        if sample_id in seen:
            raise PseudoRefinementError("source pseudo identity duplicated")
        seen.add(sample_id)
        teacher = _mapping(
            row.get("teacher_bindings"), f"source pseudo:{line_number}.teacher_bindings"
        )
        teacher_hashes[sha256_bytes(canonical_json(teacher).encode("utf-8"))] += 1
        rows.append(row)
    if len(rows) != expected_row_count:
        raise PseudoRefinementError(
            f"source pseudo row count {len(rows)} != expected {expected_row_count}"
        )
    return (
        rows,
        candidate_ids,
        {
            "bundle_kind": kind,
            "bundle_validation": dict(validation),
            "byte_size": source.stat().st_size,
            "file": str(source),
            "row_count": len(rows),
            "sample_order_sha256": _ordered_sha(str(row["sample_id"]) for row in rows),
            "sha256": sha256_file(source),
            "teacher_binding_sha256_counts": dict(sorted(teacher_hashes.items())),
        },
    )


def _load_pass_review(
    path: Path,
    *,
    required_ids: frozenset[str],
    expected_row_count: int,
    candidate_ids: tuple[str, ...],
) -> tuple[dict[str, PassEvidence], Mapping[str, Any]]:
    source = path.expanduser().resolve()
    if (
        source.name != labeler.REVIEW_OUTPUT
        or source.is_symlink()
        or not source.is_file()
    ):
        raise PseudoRefinementError(
            "pass review must be sealed review-predictions.jsonl"
        )
    try:
        validation = labeler.validate_output(source.parent)
    except (labeler.MangaFontV7PassError, OSError, KeyError, ValueError) as error:
        raise PseudoRefinementError(
            f"pass review validation failed: {error}"
        ) from error
    evidence: dict[str, PassEvidence] = {}
    seen: set[str] = set()
    total = 0
    for line_number, row in _iter_jsonl(source, "pass review"):
        total += 1
        try:
            audit._validate_review_row(  # noqa: SLF001
                row, candidate_ids=candidate_ids, location=f"pass review:{line_number}"
            )
        except audit.RelabelAuditError as error:
            raise PseudoRefinementError(str(error)) from error
        sample_id = _text(row.get("sample_id"), f"pass review:{line_number}.sample_id")
        if sample_id in seen:
            raise PseudoRefinementError("pass review identity duplicated")
        seen.add(sample_id)
        if sample_id not in required_ids:
            continue
        disagreement = _mapping(
            row.get("view_disagreement"), f"pass review:{line_number}.view_disagreement"
        )
        evidence[sample_id] = PassEvidence(
            sample_id=sample_id,
            record_sha256=_sha(row.get("record_sha256"), "pass review seal"),
            split=_text(row.get("split"), "pass review split"),
            source_category=_text(
                row.get("source_category"), "pass review source category"
            ),
            master_row_sha256=_sha(
                row.get("master_row_sha256"), "pass review master row"
            ),
            work_id=_text(row.get("work_id"), "pass review work id"),
            selected_font_id=_text(
                row.get("selected_font_id"), "pass review selected font"
            ),
            confidence=_number(
                row.get("confidence"),
                "pass review confidence",
                minimum=0.0,
                maximum=1.0,
            ),
            top1_disagreement=_number(
                disagreement.get("top1_disagreement"),
                "pass review top1 disagreement",
                minimum=0.0,
                maximum=1.0,
            ),
        )
    if total != expected_row_count:
        raise PseudoRefinementError(
            f"pass review row count {total} != expected {expected_row_count}"
        )
    missing = required_ids - evidence.keys()
    if missing:
        raise PseudoRefinementError(
            f"pass review is missing {len(missing)} required pseudo identities"
        )
    return evidence, {
        "bundle_validation": dict(validation),
        "byte_size": source.stat().st_size,
        "file": str(source),
        "required_pseudo_rows": len(evidence),
        "row_count": total,
        "sha256": sha256_file(source),
    }


def _probabilities(
    row: Mapping[str, Any], candidate_ids: tuple[str, ...], location: str
) -> list[float]:
    declared = tuple(
        str(value) for value in _sequence(row.get("candidate_ids"), location)
    )
    raw = _sequence(row.get("probabilities"), f"{location}.probabilities")
    if declared != candidate_ids or len(raw) != len(candidate_ids):
        raise PseudoRefinementError(f"{location}: candidate/probability order drifted")
    values = [float(value) for value in raw]
    if any(
        not math.isfinite(value) or value < 0.0 for value in values
    ) or not math.isclose(sum(values), 1.0, rel_tol=0.0, abs_tol=1e-5):
        raise PseudoRefinementError(f"{location}: invalid probability simplex")
    total = sum(values)
    return [value / total for value in values]


def _top1(candidate_ids: Sequence[str], probabilities: Sequence[float]) -> str:
    return candidate_ids[
        max(range(len(candidate_ids)), key=lambda index: probabilities[index])
    ]


def _single_day_multiplier(
    evidence: PassEvidence,
    *,
    visual_review: Mapping[str, Any] | None,
    parameters: Parameters,
) -> tuple[float, str]:
    if evidence.source_category == "ordinary":
        return parameters.ordinary_single_day_multiplier, "ordinary_strong_negative"
    if evidence.source_category == "bubble_edge":
        return parameters.bubble_edge_single_day_multiplier, "bubble_edge_weak_negative"
    if evidence.source_category == "page_sound":
        return 1.0, "page_sound_preserved"
    if visual_review is not None:
        return 1.0, "explicit_visual_review_preserved_for_soft_target"
    if (
        evidence.selected_font_id == SINGLE_DAY_ID
        and evidence.confidence >= parameters.consensus_confidence
        and evidence.top1_disagreement <= parameters.consensus_max_disagreement
    ):
        return 1.0, "model_visual_consensus_preserved"
    return (
        parameters.uncertain_single_day_multiplier,
        "nonstandard_uncertain_weak_negative",
    )


def _apply_single_day_multiplier(
    probabilities: Sequence[float],
    *,
    candidate_ids: tuple[str, ...],
    multiplier: float,
) -> tuple[list[float], float]:
    values = [float(value) for value in probabilities]
    position = candidate_ids.index(SINGLE_DAY_ID)
    old = values[position]
    new = old * multiplier
    removed = old - new
    if removed <= 0.0:
        return values, 0.0
    values[position] = new
    other_total = sum(
        values[index] for index in range(len(values)) if index != position
    )
    if other_total <= 0.0:
        share = removed / (len(values) - 1)
        for index in range(len(values)):
            if index != position:
                values[index] = share
    else:
        for index in range(len(values)):
            if index != position:
                values[index] += removed * values[index] / other_total
    values[-1] += 1.0 - sum(values)
    if any(value < 0.0 for value in values) or not math.isclose(
        sum(values), 1.0, rel_tol=0.0, abs_tol=1e-12
    ):
        raise PseudoRefinementError("Single Day suppression broke probability simplex")
    return values, removed


def _validated_visual_review(
    row: Mapping[str, Any], candidate_ids: tuple[str, ...]
) -> Mapping[str, Any] | None:
    raw = row.get("pseudo_visual_review")
    if raw is None:
        return None
    review = _mapping(raw, "pseudo_visual_review")
    reviewed = tuple(
        _text(value, "pseudo_visual_review.reviewed_font_ids")
        for value in _sequence(
            review.get("reviewed_font_ids"), "pseudo_visual_review.reviewed_font_ids"
        )
    )
    acceptable = tuple(
        _text(value, "pseudo_visual_review.acceptable_font_ids")
        for value in _sequence(
            review.get("acceptable_font_ids"),
            "pseudo_visual_review.acceptable_font_ids",
        )
    )
    selected = _text(
        review.get("selected_font_id"), "pseudo_visual_review.selected_font_id"
    )
    decision_kind = _text(
        review.get("decision_kind"), "pseudo_visual_review.decision_kind"
    )
    confidence = _number(
        review.get("confidence"),
        "pseudo_visual_review.confidence",
        minimum=0.0,
        maximum=1.0,
    )
    if (
        review.get("authority") != visual.AUTHORITY
        or review.get("visible_candidates_only") is not True
        or decision_kind not in {"correction", "confirmed"}
        or len(reviewed) != 5
        or len(set(reviewed)) != len(reviewed)
        or not set(reviewed) <= set(candidate_ids)
        or selected not in reviewed
        or selected in acceptable
        or not set(acceptable) <= set(reviewed)
    ):
        raise PseudoRefinementError("pseudo_visual_review binding drifted")
    _sha(review.get("decision_sha256"), "pseudo_visual_review.decision_sha256")
    _sha(
        review.get("original_record_sha256"),
        "pseudo_visual_review.original_record_sha256",
    )
    original_top1 = _text(
        review.get("original_top1_font_id"),
        "pseudo_visual_review.original_top1_font_id",
    )
    if (decision_kind == "confirmed") != (selected == original_top1):
        raise PseudoRefinementError("pseudo_visual_review correction kind drifted")
    return {
        "acceptable_font_ids": acceptable,
        "confidence": confidence,
        "decision_kind": decision_kind,
        "decision_sha256": str(review["decision_sha256"]),
        "reviewed_font_ids": reviewed,
        "selected_font_id": selected,
    }


def _visual_soft_target(
    probabilities: Sequence[float],
    *,
    candidate_ids: tuple[str, ...],
    visual_review: Mapping[str, Any],
    parameters: Parameters,
) -> tuple[list[float], Mapping[str, Any]]:
    values = [float(value) for value in probabilities]
    index = {
        candidate_id: position for position, candidate_id in enumerate(candidate_ids)
    }
    selected = str(visual_review["selected_font_id"])
    acceptable = tuple(str(value) for value in visual_review["acceptable_font_ids"])
    positives = {selected, *acceptable}
    selected_mass = parameters.visual_selected_mass
    acceptable_mass = parameters.visual_acceptable_mass if acceptable else 0.0
    residual_mass = 1.0 - selected_mass - acceptable_mass
    target = [0.0] * len(values)
    target[index[selected]] = selected_mass
    if acceptable:
        acceptable_priors = [values[index[font_id]] + 1e-9 for font_id in acceptable]
        denominator = sum(acceptable_priors)
        for font_id, prior in zip(acceptable, acceptable_priors, strict=True):
            target[index[font_id]] = acceptable_mass * prior / denominator
    residual = [font_id for font_id in candidate_ids if font_id not in positives]
    residual_priors = [values[index[font_id]] + 1e-9 for font_id in residual]
    denominator = sum(residual_priors)
    for font_id, prior in zip(residual, residual_priors, strict=True):
        target[index[font_id]] = residual_mass * prior / denominator
    confidence = float(visual_review["confidence"])
    strength = parameters.visual_strength_min + confidence * (
        parameters.visual_strength_max - parameters.visual_strength_min
    )
    updated = [
        (1.0 - strength) * value + strength * target_value
        for value, target_value in zip(values, target, strict=True)
    ]
    updated[-1] += 1.0 - sum(updated)
    if _top1(candidate_ids, updated) != selected:
        raise PseudoRefinementError(
            "strong visual soft target failed to select reviewed font"
        )
    return updated, {
        "acceptable_mass": acceptable_mass,
        "residual_mass": residual_mass,
        "selected_mass": selected_mass,
        "strength": strength,
    }


def _refine_rows(
    source_rows: Sequence[Mapping[str, Any]],
    *,
    pass_evidence: Mapping[str, PassEvidence],
    candidate_ids: tuple[str, ...],
    parameters: Parameters,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Mapping[str, Any]]:
    _validate_parameters(parameters)
    output: list[dict[str, Any]] = []
    lineage: list[dict[str, Any]] = []
    stats: Counter[str] = Counter()
    single_day_index = candidate_ids.index(SINGLE_DAY_ID)
    mass_before = 0.0
    mass_after = 0.0
    for source in source_rows:
        sample_id = _text(source.get("sample_id"), "source sample_id")
        evidence = pass_evidence.get(sample_id)
        if evidence is None:
            raise PseudoRefinementError(f"{sample_id}: missing pass review evidence")
        if (
            evidence.split != "train"
            or evidence.master_row_sha256 != source.get("master_row_sha256")
            or evidence.work_id != source.get("work_id")
            or evidence.source_category != source.get("source_category")
        ):
            raise PseudoRefinementError(
                f"{sample_id}: pseudo/pass review binding drifted"
            )
        original = _probabilities(source, candidate_ids, f"pseudo {sample_id}")
        original_weight = _number(
            source.get("weight"), f"pseudo {sample_id}.weight", minimum=0.0, maximum=1.0
        )
        original_top1 = _top1(candidate_ids, original)
        stats[f"all_top1_before_{original_top1}"] += 1
        if original_top1 == SINGLE_DAY_ID:
            stats[f"single_day_top1_before_{evidence.source_category}"] += 1
        mass_before += original[single_day_index]
        visual_review = _validated_visual_review(source, candidate_ids)
        multiplier, policy = _single_day_multiplier(
            evidence, visual_review=visual_review, parameters=parameters
        )
        probabilities, removed = _apply_single_day_multiplier(
            original, candidate_ids=candidate_ids, multiplier=multiplier
        )
        weight = original_weight
        actions: list[dict[str, Any]] = []
        stats[f"single_day_policy_{policy}"] += 1
        if removed > 0.0:
            action = {
                "kind": "single_day_category_prior",
                "multiplier": multiplier,
                "policy": policy,
                "probability_after": probabilities[single_day_index],
                "probability_before": original[single_day_index],
                "probability_removed": removed,
            }
            actions.append(action)
            stats[f"single_day_applied_{evidence.source_category}"] += 1
            if original[single_day_index] >= parameters.negative_weight_min_probability:
                if evidence.source_category == "ordinary":
                    weight = max(weight, parameters.ordinary_weight_floor)
                elif evidence.source_category == "bubble_edge":
                    weight = max(weight, parameters.bubble_edge_weight_floor)
        if visual_review is not None:
            probabilities, target = _visual_soft_target(
                probabilities,
                candidate_ids=candidate_ids,
                visual_review=visual_review,
                parameters=parameters,
            )
            confidence = float(visual_review["confidence"])
            weight = max(
                weight,
                parameters.visual_weight_floor
                + (1.0 - parameters.visual_weight_floor) * confidence,
            )
            actions.append(
                {
                    "acceptable_font_ids": list(visual_review["acceptable_font_ids"]),
                    "confidence": confidence,
                    "decision_kind": visual_review["decision_kind"],
                    "decision_sha256": visual_review["decision_sha256"],
                    "kind": "strong_visual_soft_target",
                    "reviewed_font_ids": list(visual_review["reviewed_font_ids"]),
                    "selected_font_id": visual_review["selected_font_id"],
                    "target": dict(target),
                }
            )
            stats[f"visual_applied_{visual_review['decision_kind']}"] += 1
            stats[f"visual_selected_{visual_review['selected_font_id']}"] += 1
        refined_top1 = _top1(candidate_ids, probabilities)
        stats[f"all_top1_after_{refined_top1}"] += 1
        if refined_top1 == SINGLE_DAY_ID:
            stats[f"single_day_top1_after_{evidence.source_category}"] += 1
        mass_after += probabilities[single_day_index]
        if not actions or (
            probabilities == original
            and math.isclose(weight, original_weight, abs_tol=0.0)
        ):
            output.append(copy.deepcopy(dict(source)))
            stats["unchanged_rows"] += 1
            continue
        teacher = _mapping(source.get("teacher_bindings"), "source teacher bindings")
        teacher_sha = sha256_bytes(canonical_json(teacher).encode("utf-8"))
        refinement_core = {
            "actions": actions,
            "authority": AUTHORITY,
            "label_authority": LINEAGE_AUTHORITY,
            "pass_review_record_sha256": evidence.record_sha256,
            "promotion_allowed": False,
            "sample_id": sample_id,
            "source_record_sha256": _sha(source.get("record_sha256"), "source record"),
            "source_teacher_bindings_sha256": teacher_sha,
            "training_eligible": False,
        }
        refinement_id = sha256_bytes(canonical_json(refinement_core).encode("utf-8"))
        row = copy.deepcopy(dict(source))
        row["probabilities"] = probabilities
        row["weight"] = weight
        row["label_authority"] = LOADER_AUTHORITY
        row["training_eligible"] = False
        row["pseudo_v2_refinement"] = {
            **refinement_core,
            "refinement_id": refinement_id,
        }
        row = seal_record(row)
        output.append(row)
        lineage.append(
            seal_record(
                {
                    "actions": actions,
                    "authority": AUTHORITY,
                    "candidate_ids": list(candidate_ids),
                    "label_authority": LINEAGE_AUTHORITY,
                    "output_record_sha256": row["record_sha256"],
                    "pass_review_record_sha256": evidence.record_sha256,
                    "probability_top1_after": refined_top1,
                    "probability_top1_before": original_top1,
                    "promotion_allowed": False,
                    "record_type": "manga_font_v2_pseudo_refinement_lineage_row",
                    "refinement_id": refinement_id,
                    "sample_id": sample_id,
                    "schema_version": LINEAGE_SCHEMA,
                    "single_day_probability_after": probabilities[single_day_index],
                    "single_day_probability_before": original[single_day_index],
                    "source_category": evidence.source_category,
                    "source_record_sha256": source["record_sha256"],
                    "source_teacher_bindings_sha256": teacher_sha,
                    "training_eligible": False,
                    "weight_after": weight,
                    "weight_before": original_weight,
                }
            )
        )
        stats["changed_rows"] += 1
        stats[f"changed_source_category_{evidence.source_category}"] += 1
        stats[f"top1_before_{original_top1}"] += 1
        stats[f"top1_after_{refined_top1}"] += 1
    return (
        output,
        lineage,
        {
            **dict(stats),
            "single_day_probability_mass_after": mass_after,
            "single_day_probability_mass_before": mass_before,
            "single_day_probability_mass_delta": mass_after - mass_before,
        },
    )


def _assert_safe_output(destination: Path, *, input_paths: Sequence[Path]) -> None:
    if destination.parent == destination:
        raise PseudoRefinementError("refusing to use a filesystem root as output")
    for raw_input in input_paths:
        source = raw_input.expanduser().resolve()
        if destination == source or destination == source.parent:
            raise PseudoRefinementError("output overlaps an input artifact")
        if source.is_relative_to(destination):
            raise PseudoRefinementError(
                "output would contain and replace an input artifact"
            )


def _owned_output(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise PseudoRefinementError(
            "refusing to replace a linked or non-directory output"
        )
    marker_path = path / MARKER_FILE
    if marker_path.is_symlink() or not marker_path.is_file():
        raise PseudoRefinementError("refusing to replace an unowned output directory")
    marker = _mapping(json.loads(marker_path.read_text(encoding="utf-8")), "old marker")
    validate_record_seal(marker, location="old marker")
    if marker.get("owner") != OWNER or marker.get("safe_replace") is not True:
        raise PseudoRefinementError("refusing to replace an unowned output directory")


def _publish_staged(
    staging: Path,
    destination: Path,
    *,
    replace_owned_output: bool,
) -> None:
    backup: Path | None = None
    if destination.exists():
        if not replace_owned_output:
            raise PseudoRefinementError(
                "output already exists; pass --replace-owned-output after validation"
            )
        _owned_output(destination)
        backup = destination.parent / f".{destination.name}.backup-{uuid.uuid4().hex}"
        os.replace(destination, backup)
    try:
        os.replace(staging, destination)
    except BaseException:
        if backup is not None and backup.exists() and not destination.exists():
            os.replace(backup, destination)
        raise
    if backup is not None and backup.exists():
        shutil.rmtree(backup)


def build_refinement(
    *,
    pseudo_targets: Path,
    pass_review: Path,
    output_dir: Path,
    expected_pseudo_rows: int = EXPECTED_PSEUDO_ROWS,
    expected_review_rows: int = EXPECTED_REVIEW_ROWS,
    parameters: Parameters = Parameters(),
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    if expected_pseudo_rows < 1 or expected_review_rows < expected_pseudo_rows:
        raise PseudoRefinementError("expected row counts are inconsistent")
    _validate_parameters(parameters)
    source_rows, candidate_ids, pseudo_binding = _load_pseudo_input(
        pseudo_targets, expected_row_count=expected_pseudo_rows
    )
    required_ids = frozenset(str(row["sample_id"]) for row in source_rows)
    review_rows, review_binding = _load_pass_review(
        pass_review,
        required_ids=required_ids,
        expected_row_count=expected_review_rows,
        candidate_ids=candidate_ids,
    )
    output_rows, lineage_rows, application = _refine_rows(
        source_rows,
        pass_evidence=review_rows,
        candidate_ids=candidate_ids,
        parameters=parameters,
    )
    if len(output_rows) != len(source_rows):
        raise PseudoRefinementError("refinement changed pseudo row count")

    destination = output_dir.expanduser().resolve()
    _assert_safe_output(destination, input_paths=(pseudo_targets, pass_review))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if not replace_owned_output:
            raise PseudoRefinementError(
                "output already exists; pass --replace-owned-output after validation"
            )
        _owned_output(destination)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent)
    )
    try:
        pseudo_path = staging / PSEUDO_FILE
        lineage_path = staging / LINEAGE_FILE
        _write_jsonl(pseudo_path, output_rows)
        _write_jsonl(lineage_path, lineage_rows)
        parameter_values = asdict(parameters)
        manifest = seal_record(
            {
                "authority": {
                    "human_gold_promotions": 0,
                    "label_authority": AUTHORITY,
                    "loader_top_level_authority": LOADER_AUTHORITY,
                    "promotion_allowed": False,
                    "training_eligible": False,
                },
                "candidate_ids": list(candidate_ids),
                "counts": {
                    "changed_rows": len(lineage_rows),
                    "output_pseudo_rows": len(output_rows),
                    "pass_review_rows": expected_review_rows,
                },
                "inputs": {"pass_review": review_binding, "pseudo": pseudo_binding},
                "output_sample_order_sha256": _ordered_sha(
                    str(row["sample_id"]) for row in output_rows
                ),
                "parameters": parameter_values,
                "record_type": "manga_font_v2_pseudo_refinement_manifest",
                "schema_version": MANIFEST_SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "application": application,
                "artifacts": {
                    LINEAGE_FILE: _artifact_descriptor(
                        lineage_path, row_count=len(lineage_rows)
                    ),
                    MANIFEST_FILE: _artifact_descriptor(manifest_path),
                    PSEUDO_FILE: _artifact_descriptor(
                        pseudo_path, row_count=len(output_rows)
                    ),
                },
                "authority": {
                    "human_gold_promotions": 0,
                    "label_authority": AUTHORITY,
                    "lineage_label_authority": LINEAGE_AUTHORITY,
                    "loader_top_level_authority": LOADER_AUTHORITY,
                    "promotion_allowed": False,
                    "training_eligible": False,
                },
                "candidate_ids": list(candidate_ids),
                "manifest_record_sha256": manifest["record_sha256"],
                "parameters": parameter_values,
                "record_type": "manga_font_v2_pseudo_refinement_report",
                "schema_version": REPORT_SCHEMA,
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "manifest_sha256": sha256_file(manifest_path),
                "owner": OWNER,
                "report_sha256": sha256_file(report_path),
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging)
        _publish_staged(
            staging,
            destination,
            replace_owned_output=replace_owned_output,
        )
        return validate_output(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise PseudoRefinementError("refinement output is missing or linked")
    if {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise PseudoRefinementError("refinement exact inventory drifted")
    marker = _mapping(
        json.loads((root / MARKER_FILE).read_text(encoding="utf-8")), "marker"
    )
    manifest = _mapping(
        json.loads((root / MANIFEST_FILE).read_text(encoding="utf-8")), "manifest"
    )
    report = _mapping(
        json.loads((root / REPORT_FILE).read_text(encoding="utf-8")), "report"
    )
    validate_record_seal(marker, location="marker")
    validate_record_seal(manifest, location="manifest")
    validate_record_seal(report, location="report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or marker.get("manifest_sha256") != sha256_file(root / MANIFEST_FILE)
        or marker.get("report_sha256") != sha256_file(root / REPORT_FILE)
        or manifest.get("schema_version") != MANIFEST_SCHEMA
        or report.get("schema_version") != REPORT_SCHEMA
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or manifest.get("source_code_sha256") != sha256_file(Path(__file__).resolve())
    ):
        raise PseudoRefinementError("refinement metadata drifted")
    candidate_ids = _active_ids()
    if (
        tuple(manifest.get("candidate_ids", ())) != candidate_ids
        or tuple(report.get("candidate_ids", ())) != candidate_ids
    ):
        raise PseudoRefinementError("refinement candidate inventory drifted")
    counts = _mapping(manifest.get("counts"), "manifest counts")
    artifacts = _mapping(report.get("artifacts"), "report artifacts")
    expected_rows = {
        PSEUDO_FILE: int(counts.get("output_pseudo_rows", -1)),
        LINEAGE_FILE: int(counts.get("changed_rows", -1)),
    }
    for name, expected_count in expected_rows.items():
        path = root / name
        descriptor = _mapping(artifacts.get(name), f"artifact {name}")
        if (
            descriptor.get("file") != name
            or descriptor.get("byte_size") != path.stat().st_size
            or descriptor.get("sha256") != sha256_file(path)
            or descriptor.get("row_count") != expected_count
        ):
            raise PseudoRefinementError(f"artifact descriptor drifted: {name}")
    manifest_descriptor = _mapping(artifacts.get(MANIFEST_FILE), "manifest artifact")
    if (
        manifest_descriptor.get("file") != MANIFEST_FILE
        or manifest_descriptor.get("byte_size") != (root / MANIFEST_FILE).stat().st_size
        or manifest_descriptor.get("sha256") != sha256_file(root / MANIFEST_FILE)
    ):
        raise PseudoRefinementError("manifest descriptor drifted")

    lineage: dict[str, Mapping[str, Any]] = {}
    for line_number, row in _iter_jsonl(root / LINEAGE_FILE, "lineage"):
        validate_record_seal(row, location=f"lineage:{line_number}")
        sample_id = _text(row.get("sample_id"), f"lineage:{line_number}.sample_id")
        if (
            sample_id in lineage
            or row.get("schema_version") != LINEAGE_SCHEMA
            or row.get("authority") != AUTHORITY
            or row.get("label_authority") != LINEAGE_AUTHORITY
            or row.get("training_eligible") is not False
            or row.get("promotion_allowed") is not False
            or tuple(row.get("candidate_ids", ())) != candidate_ids
        ):
            raise PseudoRefinementError("lineage authority or identity drifted")
        lineage[sample_id] = row
    if len(lineage) != expected_rows[LINEAGE_FILE]:
        raise PseudoRefinementError("lineage row count drifted")

    pseudo_ids: list[str] = []
    seen: set[str] = set()
    changed_seen: set[str] = set()
    for line_number, row in _iter_jsonl(root / PSEUDO_FILE, "refined pseudo"):
        _validate_source_pseudo_row(
            row, candidate_ids=candidate_ids, location=f"refined pseudo:{line_number}"
        )
        sample_id = _text(
            row.get("sample_id"), f"refined pseudo:{line_number}.sample_id"
        )
        if sample_id in seen:
            raise PseudoRefinementError("refined pseudo identity duplicated")
        seen.add(sample_id)
        pseudo_ids.append(sample_id)
        refinement = row.get("pseudo_v2_refinement")
        bound = lineage.get(sample_id)
        if bound is None:
            continue
        changed_seen.add(sample_id)
        metadata = _mapping(refinement, "pseudo_v2_refinement")
        teacher = _mapping(row.get("teacher_bindings"), "refined teacher bindings")
        teacher_sha = sha256_bytes(canonical_json(teacher).encode("utf-8"))
        if (
            metadata.get("authority") != AUTHORITY
            or metadata.get("label_authority") != LINEAGE_AUTHORITY
            or metadata.get("training_eligible") is not False
            or metadata.get("promotion_allowed") is not False
            or metadata.get("refinement_id") != bound.get("refinement_id")
            or row.get("record_sha256") != bound.get("output_record_sha256")
            or metadata.get("source_record_sha256") != bound.get("source_record_sha256")
            or metadata.get("pass_review_record_sha256")
            != bound.get("pass_review_record_sha256")
            or teacher_sha != bound.get("source_teacher_bindings_sha256")
            or teacher_sha != metadata.get("source_teacher_bindings_sha256")
        ):
            raise PseudoRefinementError("pseudo/lineage binding drifted")
    if len(pseudo_ids) != expected_rows[PSEUDO_FILE] or changed_seen != lineage.keys():
        raise PseudoRefinementError("pseudo/lineage coverage drifted")
    if _ordered_sha(pseudo_ids) != manifest.get("output_sample_order_sha256"):
        raise PseudoRefinementError("refined pseudo order drifted")
    try:
        loaded = audit.mass21.load_pseudo_targets(
            root / PSEUDO_FILE,
            candidate_ids=candidate_ids,
            real_train_ids=frozenset(pseudo_ids),
            human_gold_ids=frozenset(),
        )
    except audit.mass21.MangaFontMass21DataError as error:
        raise PseudoRefinementError(
            f"mass21 loader compatibility failed: {error}"
        ) from error
    authority = _mapping(report.get("authority"), "report authority")
    if (
        len(loaded.targets) != len(pseudo_ids)
        or authority.get("human_gold_promotions") != 0
        or authority.get("label_authority") != AUTHORITY
        or authority.get("lineage_label_authority") != LINEAGE_AUTHORITY
        or authority.get("loader_top_level_authority") != LOADER_AUTHORITY
        or authority.get("training_eligible") is not False
        or authority.get("promotion_allowed") is not False
    ):
        raise PseudoRefinementError("refinement authority boundary drifted")
    return {
        "changed_rows": len(lineage),
        "loader_compatible_rows": len(loaded.targets),
        "output_dir": str(root),
        "pseudo_rows": len(pseudo_ids),
        "status": "validated_manga_font_v2_pseudo_refinement_not_gold",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--pseudo-targets", type=Path, required=True)
    build.add_argument("--pass-review", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--expected-pseudo-rows", type=int, default=EXPECTED_PSEUDO_ROWS)
    build.add_argument("--expected-review-rows", type=int, default=EXPECTED_REVIEW_ROWS)
    build.add_argument("--replace-owned-output", action="store_true")
    build.add_argument(
        "--ordinary-single-day-multiplier",
        type=float,
        default=Parameters.ordinary_single_day_multiplier,
    )
    build.add_argument(
        "--bubble-edge-single-day-multiplier",
        type=float,
        default=Parameters.bubble_edge_single_day_multiplier,
    )
    build.add_argument(
        "--uncertain-single-day-multiplier",
        type=float,
        default=Parameters.uncertain_single_day_multiplier,
    )
    build.add_argument(
        "--consensus-confidence", type=float, default=Parameters.consensus_confidence
    )
    build.add_argument(
        "--consensus-max-disagreement",
        type=float,
        default=Parameters.consensus_max_disagreement,
    )
    build.add_argument(
        "--visual-strength-min", type=float, default=Parameters.visual_strength_min
    )
    build.add_argument(
        "--visual-strength-max", type=float, default=Parameters.visual_strength_max
    )
    build.add_argument(
        "--visual-selected-mass", type=float, default=Parameters.visual_selected_mass
    )
    build.add_argument(
        "--visual-acceptable-mass",
        type=float,
        default=Parameters.visual_acceptable_mass,
    )
    build.add_argument(
        "--visual-weight-floor", type=float, default=Parameters.visual_weight_floor
    )
    build.add_argument(
        "--ordinary-weight-floor", type=float, default=Parameters.ordinary_weight_floor
    )
    build.add_argument(
        "--bubble-edge-weight-floor",
        type=float,
        default=Parameters.bubble_edge_weight_floor,
    )
    build.add_argument(
        "--negative-weight-min-probability",
        type=float,
        default=Parameters.negative_weight_min_probability,
    )
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            result = build_refinement(
                pseudo_targets=args.pseudo_targets,
                pass_review=args.pass_review,
                output_dir=args.output_dir,
                expected_pseudo_rows=args.expected_pseudo_rows,
                expected_review_rows=args.expected_review_rows,
                replace_owned_output=args.replace_owned_output,
                parameters=Parameters(
                    ordinary_single_day_multiplier=args.ordinary_single_day_multiplier,
                    bubble_edge_single_day_multiplier=args.bubble_edge_single_day_multiplier,
                    uncertain_single_day_multiplier=args.uncertain_single_day_multiplier,
                    consensus_confidence=args.consensus_confidence,
                    consensus_max_disagreement=args.consensus_max_disagreement,
                    visual_strength_min=args.visual_strength_min,
                    visual_strength_max=args.visual_strength_max,
                    visual_selected_mass=args.visual_selected_mass,
                    visual_acceptable_mass=args.visual_acceptable_mass,
                    visual_weight_floor=args.visual_weight_floor,
                    ordinary_weight_floor=args.ordinary_weight_floor,
                    bubble_edge_weight_floor=args.bubble_edge_weight_floor,
                    negative_weight_min_probability=args.negative_weight_min_probability,
                ),
            )
    except (PseudoRefinementError, OSError, KeyError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
