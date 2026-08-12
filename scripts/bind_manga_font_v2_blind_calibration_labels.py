#!/usr/bin/env python3
"""Bind sealed blind slots to active21 IDs for calibration-only supervision.

Only the first 160 private-binding lines are JSON-decoded.  Their usable
projection is deliberately restricted to the opaque row identities and the
21 slot-to-candidate bindings.  The remaining 80 evaluation lines are never
decoded.  No model output, probability, predicted label, or selection reason
is an input to ``build-labels``.

The optional ``fit-r3h-scores`` command consumes a separately sealed bundle of
production-routed r3h *raw candidate scores*.  It emits aggregate work-LOGO
evidence and a small top-three reranking calibrator, never per-row predictions.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import itertools
import json
import math
import tempfile
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


LABEL_SCHEMA = "manga-font-v2-bound-blind-calibration-label-v1"
LABEL_RECORD = "manga_font_v2_bound_blind_calibration_label"
EXCLUSION_SCHEMA = "manga-font-v2-blind-calibration-exclusion-v1"
EXCLUSION_RECORD = "manga_font_v2_blind_calibration_exclusion"
REPORT_SCHEMA = "manga-font-v2-bound-blind-calibration-report-v1"
REPORT_RECORD = "manga_font_v2_bound_blind_calibration_report"
SCORE_CONTRACT_SCHEMA = "manga-font-v2-r3h-score-input-contract-v1"
SCORE_CONTRACT_RECORD = "manga_font_v2_r3h_score_input_contract"
SCORE_ROW_SCHEMA = "manga-font-v2-r3h-routed-score-row-v1"
SCORE_ROW_RECORD = "manga_font_v2_r3h_routed_score_row"
SCORE_MANIFEST_SCHEMA = "manga-font-v2-r3h-routed-score-manifest-v1"
SCORE_MANIFEST_RECORD = "manga_font_v2_r3h_routed_score_manifest"
FIT_SCHEMA = "manga-font-v2-r3h-score-calibration-fit-v1"
FIT_RECORD = "manga_font_v2_r3h_score_calibration_fit"

CALIBRATION_ROW_COUNT = 160
ELIGIBLE_ROW_COUNT = 145
EXCLUDED_ROW_COUNT = 15
PANEL_COUNT = 3
SLOTS_PER_PANEL = 7
TIER_NAMES = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
)
BOUND_PARTITION_FIELDS = (
    "preferred",
    "acceptable_nonpreferred",
    "marginal",
    "unacceptable",
    "unrenderable",
)
SLOT_TIER_FIELDS = {
    "preferred": "preferred_slots",
    "acceptable": "acceptable_slots",
    "marginal": "marginal_slots",
    "unacceptable": "unacceptable_slots",
    "unrenderable": "unrenderable_slots",
}
ROLE_VALUES = frozenset(
    {
        "dialogue",
        "narration",
        "thought",
        "whisper",
        "aside_balloon_edge",
        "aside",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
        "other",
    }
)
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
SCORE_ROUTE = "r3h_production_pixel_predicted_family_with_single_day_eligibility"
SCORE_SEMANTICS = "finite_pre_softmax_logits_after_production_route"
SCORE_ROW_KEYS = frozenset(
    {
        "candidate_ids",
        "candidate_scores",
        "record_sha256",
        "record_type",
        "sample_id",
        "schema_version",
    }
)
SCORE_MANIFEST_KEYS = frozenset(
    {
        "active_catalog_sha256",
        "calibration_labels_sha256",
        "candidate_order_sha256",
        "record_sha256",
        "record_type",
        "row_count",
        "runtime_lineage",
        "schema_version",
        "score_route",
        "score_rows_sha256",
        "score_semantics",
    }
)
RUNTIME_LINEAGE_KEYS = frozenset(
    {
        "encoder_onnx_sha256",
        "ranker_onnx_sha256",
        "runtime_contract_sha256",
    }
)
SHA_CHARS = frozenset("0123456789abcdef")
DEFAULT_C_GRID = (0.01, 0.03, 0.1, 0.3, 1.0)
CONTINUOUS_FEATURE_NAMES = (
    "routed_score_centered",
    "routed_score_z",
    "routed_softmax",
    "routed_log_softmax",
    "routed_rank_fraction",
    "routed_gap_to_top",
    "routed_is_top1",
    "routed_is_top3",
    "routed_entropy",
    "routed_top3_mass",
    "routed_margin_1_2",
)
EPSILON = 1e-8


class BlindCalibrationBindingError(ValueError):
    """Raised when a blind label, binding, or score contract drifts."""


@dataclass(frozen=True)
class FitLabel:
    sample_id: str
    work_token: str
    page_token: str
    role: str
    confidence: float
    preferred: frozenset[str]
    positive: frozenset[str]
    unrenderable: frozenset[str]


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


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        )
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise BlindCalibrationBindingError(f"could not hash {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> str:
    declared = record.get("record_sha256")
    if not _is_sha(declared):
        raise BlindCalibrationBindingError(f"{location}: missing record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != declared:
        raise BlindCalibrationBindingError(f"{location}: record seal drift")
    return actual


def _is_sha(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= SHA_CHARS


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise BlindCalibrationBindingError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise BlindCalibrationBindingError(f"{location}: expected list")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise BlindCalibrationBindingError(f"{location}: expected text")
    return value


def _finite(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BlindCalibrationBindingError(f"{location}: expected finite number")
    result = float(value)
    if not math.isfinite(result):
        raise BlindCalibrationBindingError(f"{location}: expected finite number")
    return result


def _probability(value: Any, location: str) -> float:
    result = _finite(value, location)
    if not 0.0 <= result <= 1.0:
        raise BlindCalibrationBindingError(f"{location}: expected value in [0,1]")
    return result


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BlindCalibrationBindingError(f"{location}: could not read JSON") from error
    return dict(_mapping(value, location))


def _read_exact_jsonl(path: Path, count: int, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line_number, raw in enumerate(handle, 1):
                if not raw.strip():
                    raise BlindCalibrationBindingError(
                        f"{location}:{line_number}: blank line"
                    )
                try:
                    rows.append(dict(_mapping(json.loads(raw), location)))
                except json.JSONDecodeError as error:
                    raise BlindCalibrationBindingError(
                        f"{location}:{line_number}: invalid JSON"
                    ) from error
    except OSError as error:
        raise BlindCalibrationBindingError(f"{location}: could not read JSONL") from error
    if len(rows) != count:
        raise BlindCalibrationBindingError(
            f"{location}: expected {count} rows, found {len(rows)}"
        )
    return rows


def _read_jsonl_prefix(path: Path, count: int, location: str) -> list[dict[str, Any]]:
    """Decode exactly ``count`` lines; the tail is not iterated or decoded."""

    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line_number, raw in enumerate(itertools.islice(handle, count), 1):
                if not raw.strip():
                    raise BlindCalibrationBindingError(
                        f"{location}:{line_number}: blank line"
                    )
                try:
                    rows.append(dict(_mapping(json.loads(raw), location)))
                except json.JSONDecodeError as error:
                    raise BlindCalibrationBindingError(
                        f"{location}:{line_number}: invalid JSON"
                    ) from error
    except OSError as error:
        raise BlindCalibrationBindingError(f"{location}: could not read JSONL") from error
    if len(rows) != count:
        raise BlindCalibrationBindingError(
            f"{location}: expected at least {count} rows, found {len(rows)}"
        )
    return rows


def _sha256_jsonl_prefix(path: Path, count: int, location: str) -> str:
    """Hash exactly the authorized prefix without reading the next line."""

    digest = hashlib.sha256()
    seen = 0
    try:
        with path.open("rb") as handle:
            for raw in itertools.islice(handle, count):
                digest.update(raw)
                seen += 1
    except OSError as error:
        raise BlindCalibrationBindingError(f"{location}: could not hash prefix") from error
    if seen != count:
        raise BlindCalibrationBindingError(
            f"{location}: expected at least {count} rows, found {seen}"
        )
    return digest.hexdigest()


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes(
        "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")
    )


def _candidate_order_sha(candidate_ids: Sequence[str]) -> str:
    return sha256_bytes(("\n".join(candidate_ids) + "\n").encode("utf-8"))


def _load_active_catalog(path: Path) -> tuple[list[str], dict[str, Any]]:
    record = _read_json(path, "active catalog")
    validate_record_seal(record, "active catalog")
    candidate_ids = [_text(value, "candidate id") for value in _list(record.get("candidate_ids"), "candidate ids")]
    order_sha = _candidate_order_sha(candidate_ids)
    if (
        len(candidate_ids) != 21
        or len(set(candidate_ids)) != 21
        or record.get("candidate_count") != 21
        or record.get("candidate_order_sha256") != order_sha
    ):
        raise BlindCalibrationBindingError("active21 catalog inventory drift")
    return candidate_ids, record


def _load_pool_report(
    path: Path,
    *,
    private_path: Path,
    queue_path: Path,
    candidate_ids: Sequence[str],
) -> dict[str, Any]:
    report = _read_json(path, "pool report")
    validate_record_seal(report, "pool report")
    artifacts = _mapping(report.get("artifacts"), "pool artifacts")
    private = _mapping(artifacts.get("private-bindings.jsonl"), "private descriptor")
    queue = _mapping(artifacts.get("review-queue.jsonl"), "queue descriptor")
    boundary = _mapping(report.get("boundary"), "pool boundary")
    if (
        not _is_sha(private.get("sha256"))
        or not _is_sha(queue.get("sha256"))
        or private.get("file") != private_path.name
        or queue.get("file") != queue_path.name
        or int(private.get("row_count", -1)) < CALIBRATION_ROW_COUNT
        or int(queue.get("row_count", -1)) < CALIBRATION_ROW_COUNT
        or report.get("candidate_ids") != list(candidate_ids)
        or report.get("candidate_count") != 21
        or report.get("candidate_order_sha256") != _candidate_order_sha(candidate_ids)
        or boundary.get("automatic_label_promotions") != 0
        or boundary.get("model_predictions_read") != 0
    ):
        raise BlindCalibrationBindingError("sealed pool boundary or artifact drift")
    return report


def _private_projection(
    rows: Sequence[Mapping[str, Any]], candidate_ids: Sequence[str]
) -> tuple[dict[str, dict[str, Any]], str]:
    expected_candidates = set(candidate_ids)
    by_sample: dict[str, dict[str, Any]] = {}
    projections: list[dict[str, Any]] = []
    for line_number, row in enumerate(rows, 1):
        validate_record_seal(row, f"private binding:{line_number}")
        sample_id = _text(row.get("sample_id"), "private sample_id")
        review_id = _text(row.get("review_id"), "private review_id")
        binding_id = _text(row.get("binding_id"), "private binding_id")
        if sample_id in by_sample:
            raise BlindCalibrationBindingError("duplicate private sample")
        slot_to_candidate: dict[str, str] = {}
        panels = _list(row.get("candidate_panels"), "private candidate panels")
        if len(panels) != PANEL_COUNT:
            raise BlindCalibrationBindingError("private panel count drift")
        for expected_panel, raw_panel in enumerate(panels, 1):
            panel = _mapping(raw_panel, "private panel")
            if panel.get("panel_number") != expected_panel:
                raise BlindCalibrationBindingError("private panel order drift")
            slots = _list(panel.get("slots"), "private slots")
            if len(slots) != SLOTS_PER_PANEL:
                raise BlindCalibrationBindingError("private slot count drift")
            for expected_letter, raw_slot in zip("ABCDEFG", slots, strict=True):
                slot = _mapping(raw_slot, "private slot")
                expected_name = f"P{expected_panel}-{expected_letter}"
                slot_name = _text(slot.get("slot"), "private slot name")
                candidate_id = _text(slot.get("candidate_id"), "private candidate id")
                if slot_name != expected_name or slot_name in slot_to_candidate:
                    raise BlindCalibrationBindingError("private slot order/identity drift")
                slot_to_candidate[slot_name] = candidate_id
        if (
            len(slot_to_candidate) != 21
            or set(slot_to_candidate.values()) != expected_candidates
            or len(set(slot_to_candidate.values())) != 21
        ):
            raise BlindCalibrationBindingError("private active21 partition drift")
        projection = {
            "binding_id": binding_id,
            "review_id": review_id,
            "sample_id": sample_id,
            "slot_to_candidate": slot_to_candidate,
            "source_binding_record_sha256": row["record_sha256"],
        }
        by_sample[sample_id] = projection
        projections.append(projection)
    projection_sha = sha256_bytes(
        "".join(canonical_json(value) + "\n" for value in projections).encode("utf-8")
    )
    return by_sample, projection_sha


def _public_projection(
    rows: Sequence[Mapping[str, Any]], *, require_calibration_purpose: bool = True
) -> dict[str, dict[str, Any]]:
    by_sample: dict[str, dict[str, Any]] = {}
    for queue_row, row in enumerate(rows, 1):
        validate_record_seal(row, f"public queue:{queue_row}")
        sample_id = _text(row.get("sample_id"), "public sample_id")
        if sample_id in by_sample or (
            require_calibration_purpose and row.get("purpose") != "calibration"
        ):
            raise BlindCalibrationBindingError("public calibration prefix drift")
        projection = {
            "binding_id": _text(row.get("binding_id"), "public binding_id"),
            "chapter_token": _text(row.get("chapter_token"), "chapter token"),
            "page_token": _text(row.get("page_token"), "page token"),
            "queue_row": queue_row,
            "review_id": _text(row.get("review_id"), "public review_id"),
            "review_item_sha256": row["record_sha256"],
            "sample_id": sample_id,
            "work_token": _text(row.get("work_token"), "work token"),
        }
        by_sample[sample_id] = projection
    return by_sample


def _projection_sha(rows: Mapping[str, Mapping[str, Any]]) -> str:
    return sha256_bytes(
        "".join(
            canonical_json(rows[sample_id]) + "\n" for sample_id in sorted(rows)
        ).encode("utf-8")
    )


def _load_decisions(
    paths: Sequence[Path], crossreview_report: Mapping[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    if len(paths) != 2:
        raise BlindCalibrationBindingError("exactly two 80-row decision shards required")
    expected = _mapping(
        crossreview_report.get("output_decisions_sha256"), "crossreview output decisions"
    )
    labels = ("cal001-080", "cal081-160")
    rows: list[dict[str, Any]] = []
    shas: dict[str, str] = {}
    for label, path in zip(labels, paths, strict=True):
        digest = sha256_file(path)
        if expected.get(label) != digest:
            raise BlindCalibrationBindingError(f"{label}: decision SHA drift")
        shas[label] = digest
        rows.extend(_read_exact_jsonl(path, 80, f"decisions {label}"))
    return rows, shas


def _decision_tiers(
    decision: Mapping[str, Any], binding: Mapping[str, Any], candidate_ids: Sequence[str]
) -> dict[str, list[str]]:
    slot_map = _mapping(binding.get("slot_to_candidate"), "slot map")
    tier_slots: dict[str, list[str]] = {name: [] for name in TIER_NAMES}
    panels = _list(decision.get("panel_decisions"), "panel decisions")
    if len(panels) != PANEL_COUNT:
        raise BlindCalibrationBindingError("decision panel count drift")
    for expected_panel, raw_panel in enumerate(panels, 1):
        panel = _mapping(raw_panel, "panel decision")
        if panel.get("panel_number") != expected_panel or panel.get("review_complete") is not True:
            raise BlindCalibrationBindingError("decision panel incomplete/drifted")
        panel_slots: list[str] = []
        for tier, field in SLOT_TIER_FIELDS.items():
            values = [_text(value, f"{field} value") for value in _list(panel.get(field), field)]
            tier_slots[tier].extend(values)
            panel_slots.extend(values)
        expected_slots = {f"P{expected_panel}-{letter}" for letter in "ABCDEFG"}
        if len(panel_slots) != 7 or len(set(panel_slots)) != 7 or set(panel_slots) != expected_slots:
            raise BlindCalibrationBindingError("decision slot partition drift")
        panel_positive = bool(panel.get("preferred_slots") or panel.get("acceptable_slots"))
        if panel.get("panel_none_acceptable") is not (not panel_positive):
            raise BlindCalibrationBindingError("panel none-acceptable drift")
    flattened_slots = [slot for values in tier_slots.values() for slot in values]
    if len(flattened_slots) != 21 or set(flattened_slots) != set(slot_map):
        raise BlindCalibrationBindingError("global slot partition drift")
    candidate_order = {candidate_id: index for index, candidate_id in enumerate(candidate_ids)}
    result = {
        tier: sorted((str(slot_map[slot]) for slot in slots), key=candidate_order.__getitem__)
        for tier, slots in tier_slots.items()
    }
    flattened_candidates = [value for values in result.values() for value in values]
    if len(flattened_candidates) != 21 or set(flattened_candidates) != set(candidate_ids):
        raise BlindCalibrationBindingError("bound candidate partition drift")
    return result


def _oof_assignments(public_rows: Mapping[str, Mapping[str, Any]]) -> dict[str, str]:
    work_tokens = sorted({str(row["work_token"]) for row in public_rows.values()})
    if len(work_tokens) != 3:
        raise BlindCalibrationBindingError("calibration supervision requires exactly three works")
    return {work: f"work-logo-{index:02d}" for index, work in enumerate(work_tokens, 1)}


def _split_statistics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    per_work: dict[str, dict[str, Any]] = {}
    page_owner: dict[str, str] = {}
    for row in rows:
        split = _mapping(row.get("split"), "label split")
        work = _text(split.get("work_token"), "work token")
        page = _text(split.get("page_token"), "page token")
        chapter = _text(split.get("chapter_token"), "chapter token")
        owner = page_owner.setdefault(page, work)
        if owner != work:
            raise BlindCalibrationBindingError("page token crosses work groups")
        item = per_work.setdefault(
            work,
            {"chapter_tokens": set(), "page_tokens": set(), "sample_count": 0},
        )
        item["sample_count"] += 1
        item["page_tokens"].add(page)
        item["chapter_tokens"].add(chapter)
    folds = []
    all_pages = set(page_owner)
    for work, item in sorted(per_work.items()):
        held_out = set(item["page_tokens"])
        training = all_pages - held_out
        if held_out & training:
            raise BlindCalibrationBindingError("work-LOGO page leakage")
        folds.append(
            {
                "chapter_count": len(item["chapter_tokens"]),
                "held_out_work_token": work,
                "oof_fold_id": next(
                    str(_mapping(row.get("split"), "split")["oof_fold_id"])
                    for row in rows
                    if _mapping(row.get("split"), "split")["work_token"] == work
                ),
                "page_count": len(held_out),
                "page_overlap_with_training_count": 0,
                "sample_count": int(item["sample_count"]),
            }
        )
    return {
        "fold_count": len(folds),
        "folds": folds,
        "page_group_isolation": True,
        "unique_page_count": len(all_pages),
        "work_group_oof": True,
    }


def _artifact_descriptor(path: Path, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def build_labels(
    *,
    decision_paths: Sequence[Path],
    crossreview_report_path: Path,
    crossreview_decisions_path: Path,
    private_bindings_path: Path,
    review_queue_path: Path,
    alternate_review_queue_path: Path,
    pool_report_path: Path,
    active_catalog_path: Path,
    output_dir: Path,
) -> dict[str, Any]:
    target = output_dir.expanduser().resolve()
    if target.exists():
        raise BlindCalibrationBindingError("output directory already exists")
    candidate_ids, active_catalog = _load_active_catalog(active_catalog_path)
    pool_report = _load_pool_report(
        pool_report_path,
        private_path=private_bindings_path,
        queue_path=review_queue_path,
        candidate_ids=candidate_ids,
    )
    crossreview_report = _read_json(crossreview_report_path, "crossreview report")
    if (
        crossreview_report.get("validated") is not True
        or crossreview_report.get("private_bindings_opened") is not False
        or crossreview_report.get("model_predictions_opened") is not False
        or crossreview_report.get("evaluation_sheets_opened") is not False
    ):
        raise BlindCalibrationBindingError("crossreview blindness attestation drift")
    crossreview_decisions_sha = sha256_file(crossreview_decisions_path)
    if crossreview_report.get("cross_review_decisions_sha256") != crossreview_decisions_sha:
        raise BlindCalibrationBindingError("crossreview decision lineage drift")
    decisions, decision_shas = _load_decisions(decision_paths, crossreview_report)
    private_rows = _read_jsonl_prefix(
        private_bindings_path, CALIBRATION_ROW_COUNT, "private calibration bindings"
    )
    queue_rows = _read_jsonl_prefix(
        review_queue_path, CALIBRATION_ROW_COUNT, "public calibration queue"
    )
    alternate_queue_rows = _read_jsonl_prefix(
        alternate_review_queue_path,
        CALIBRATION_ROW_COUNT,
        "alternate public calibration queue",
    )
    private_by_sample, private_projection_sha = _private_projection(private_rows, candidate_ids)
    public_by_sample = _public_projection(queue_rows)
    alternate_public_by_sample = _public_projection(
        alternate_queue_rows, require_calibration_purpose=False
    )
    if set(private_by_sample) != set(public_by_sample):
        raise BlindCalibrationBindingError("private/public calibration identity drift")
    if set(public_by_sample) != set(alternate_public_by_sample):
        raise BlindCalibrationBindingError("public queue generation identity drift")
    for sample_id, public in public_by_sample.items():
        alternate = alternate_public_by_sample[sample_id]
        for field in (
            "binding_id",
            "chapter_token",
            "page_token",
            "queue_row",
            "review_id",
            "sample_id",
            "work_token",
        ):
            if public[field] != alternate[field]:
                raise BlindCalibrationBindingError(
                    "public queue generation semantic identity drift"
                )
    folds = _oof_assignments(public_by_sample)

    labels: list[dict[str, Any]] = []
    exclusions: list[dict[str, Any]] = []
    seen: set[str] = set()
    review_item_sha_match_count = 0
    alternate_review_item_sha_match_count = 0
    for queue_row, decision in enumerate(decisions, 1):
        validate_record_seal(decision, f"decision:{queue_row}")
        sample_id = _text(decision.get("sample_id"), "decision sample_id")
        if sample_id in seen:
            raise BlindCalibrationBindingError("duplicate decision sample")
        seen.add(sample_id)
        public = public_by_sample.get(sample_id)
        binding = private_by_sample.get(sample_id)
        if public is None or binding is None:
            raise BlindCalibrationBindingError("decision has no calibration binding")
        if (
            decision.get("review_id") != public["review_id"]
            or binding["review_id"] != public["review_id"]
            or binding["binding_id"] != public["binding_id"]
            or not _is_sha(decision.get("review_item_sha256"))
            or decision.get("review_item_sha256")
            not in {
                public["review_item_sha256"],
                alternate_public_by_sample[sample_id]["review_item_sha256"],
            }
        ):
            raise BlindCalibrationBindingError("decision/public/private lineage drift")
        review_item_sha_match_count += int(
            decision.get("review_item_sha256") == public["review_item_sha256"]
        )
        alternate_review_item_sha_match_count += int(
            decision.get("review_item_sha256")
            == alternate_public_by_sample[sample_id]["review_item_sha256"]
        )
        role = _text(decision.get("verified_role"), "verified role")
        split = {
            "chapter_token": public["chapter_token"],
            "oof_fold_id": folds[public["work_token"]],
            "page_token": public["page_token"],
            "purpose": "calibration_fit_only",
            "work_token": public["work_token"],
        }
        source_lineage = {
            "binding_id": public["binding_id"],
            "binding_pool_review_item_sha256": public["review_item_sha256"],
            "decision_record_sha256": decision["record_sha256"],
            "decision_review_item_sha256": decision["review_item_sha256"],
            "queue_row": queue_row,
            "review_id": public["review_id"],
            "source_binding_record_sha256": binding["source_binding_record_sha256"],
        }
        completed = (
            decision.get("decision_status") == "completed"
            and decision.get("review_needed") is False
            and decision.get("candidate_search_complete") is True
            and decision.get("crop_quality") == "pass"
        )
        if not completed:
            exclusion_class = (
                "crop_not_font_supervision_quality"
                if decision.get("crop_quality") == "reject"
                else "catalog_gap_none_acceptable"
            )
            exclusions.append(
                seal_record(
                    {
                        "authority": {
                            "automatic_model_training_human_promotion_allowed": False,
                            "calibration_fit_eligible": False,
                            "evaluation_eligible": False,
                            "human_gold": False,
                            "training_eligible": False,
                        },
                        "exclusion_class": exclusion_class,
                        "record_type": EXCLUSION_RECORD,
                        "role": role,
                        "sample_id": sample_id,
                        "schema_version": EXCLUSION_SCHEMA,
                        "source_lineage": source_lineage,
                        "split": split,
                    }
                )
            )
            continue
        if role not in ROLE_VALUES:
            raise BlindCalibrationBindingError("eligible decision has unsupported role")
        tiers = _decision_tiers(decision, binding, candidate_ids)
        if not tiers["preferred"]:
            raise BlindCalibrationBindingError("eligible decision lacks preferred candidate")
        candidate_order = {
            candidate_id: index for index, candidate_id in enumerate(candidate_ids)
        }
        inclusive_acceptable = sorted(
            set(tiers["preferred"]) | set(tiers["acceptable"]),
            key=candidate_order.__getitem__,
        )
        confidence = _probability(decision.get("font_match_confidence"), "font confidence")
        labels.append(
            seal_record(
                {
                    "authority": {
                        "automatic_label_promotion_allowed": False,
                        "automatic_model_training_human_promotion_allowed": False,
                        "calibration_fit_authority": True,
                        "calibration_fit_eligible": True,
                        "evaluation_eligible": False,
                        "human_gold": False,
                        "label_authority": "blind_crossreview_calibration_fit_only",
                        "training_eligible": False,
                    },
                    "font_judgment": {
                        "acceptable": inclusive_acceptable,
                        "acceptable_nonpreferred": tiers["acceptable"],
                        "marginal": tiers["marginal"],
                        "none_acceptable": False,
                        "preferred": tiers["preferred"],
                        "unacceptable": tiers["unacceptable"],
                        "unrenderable": tiers["unrenderable"],
                    },
                    "record_type": LABEL_RECORD,
                    "resolution": {
                        "confidence": confidence,
                        "human_adjudicated": False,
                        "kind": "blind_agent_crossreview_bound_projection",
                    },
                    "role": {"confidence": _probability(decision.get("verified_role_confidence"), "role confidence"), "primary": role},
                    "sample_id": sample_id,
                    "schema_version": LABEL_SCHEMA,
                    "source_lineage": source_lineage,
                    "split": split,
                }
            )
        )
    if seen != set(public_by_sample):
        raise BlindCalibrationBindingError("decision coverage drift")
    if (
        review_item_sha_match_count + alternate_review_item_sha_match_count
        != CALIBRATION_ROW_COUNT
    ):
        raise BlindCalibrationBindingError("public review-item generation lineage drift")
    if len(labels) != ELIGIBLE_ROW_COUNT or len(exclusions) != EXCLUDED_ROW_COUNT:
        raise BlindCalibrationBindingError("145/15 calibration eligibility boundary drift")
    exclusion_counts = Counter(row["exclusion_class"] for row in exclusions)
    if exclusion_counts != {
        "catalog_gap_none_acceptable": 12,
        "crop_not_font_supervision_quality": 3,
    }:
        raise BlindCalibrationBindingError("catalog-gap/reject partition drift")
    split_stats = _split_statistics(labels)

    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}.", dir=target.parent) as raw_temp:
        staging = Path(raw_temp) / target.name
        staging.mkdir()
        label_path = staging / "calibration-labels.jsonl"
        exclusion_path = staging / "excluded-calibration-rows.jsonl"
        contract_path = staging / "r3h-score-input-contract.json"
        report_path = staging / "report.json"
        _write_jsonl(label_path, labels)
        _write_jsonl(exclusion_path, exclusions)
        contract = seal_record(
            {
                "authority": {
                    "automatic_model_training_human_promotion_allowed": False,
                    "calibration_fit_only": True,
                    "human_gold": False,
                    "training_eligible": False,
                },
                "candidate_count": 21,
                "candidate_ids": list(candidate_ids),
                "candidate_order_sha256": _candidate_order_sha(candidate_ids),
                "exact_score_manifest_keys": sorted(SCORE_MANIFEST_KEYS),
                "exact_score_row_keys": sorted(SCORE_ROW_KEYS),
                "labels_sha256": sha256_file(label_path),
                "prohibited_score_bundle_fields": [
                    "predicted_candidate",
                    "predicted_role",
                    "probabilities",
                    "selection_reason",
                ],
                "record_type": SCORE_CONTRACT_RECORD,
                "required_row_count": len(labels),
                "required_runtime_lineage_keys": sorted(RUNTIME_LINEAGE_KEYS),
                "required_score_route": SCORE_ROUTE,
                "required_score_semantics": SCORE_SEMANTICS,
                "schema_version": SCORE_CONTRACT_SCHEMA,
                "score_manifest_schema_version": SCORE_MANIFEST_SCHEMA,
                "score_row_schema_version": SCORE_ROW_SCHEMA,
                "transform": {
                    "candidate_binary_positive": "inclusive_acceptable",
                    "candidate_excluded": "unrenderable",
                    "candidate_negative": "marginal_or_unacceptable",
                    "features": list(CONTINUOUS_FEATURE_NAMES) + ["candidate_id_one_hot_active21"],
                    "oof": "nested_leave_one_opaque_work_out_then_fixed_C_leave_one_work_out",
                    "reranking_scope": "within_raw_runtime_top3",
                },
                "production_route_bridge": {
                    "direct_existing_human_final_loader_ingestion": False,
                    "direct_ingestion_blocker": "existing_loader_requires_val_human_primary_or_adjudicated_finals",
                    "required_function": "scripts.build_manga_font_v8_selection_calibration._v8_production_score_route",
                    "required_output_projection": "candidate_scores_after_predicted_pixel_family_and_single_day_eligibility",
                },
            }
        )
        contract_path.write_bytes(json_bytes(contract, pretty=True))
        original_decision_shas = dict(
            _mapping(crossreview_report.get("input_decisions_sha256"), "original decisions")
        )
        report = seal_record(
            {
                "artifacts": {
                    "calibration-labels.jsonl": _artifact_descriptor(label_path, len(labels)),
                    "excluded-calibration-rows.jsonl": _artifact_descriptor(exclusion_path, len(exclusions)),
                    "r3h-score-input-contract.json": _artifact_descriptor(contract_path),
                },
                "authority": {
                    "automatic_model_training_human_promotion_allowed": False,
                    "calibration_fit_authority_only": True,
                    "evaluation_eligible": False,
                    "human_gold": False,
                    "training_eligible": False,
                },
                "bindings": {
                    "active_catalog_record_sha256": active_catalog["record_sha256"],
                    "active_catalog_sha256": sha256_file(active_catalog_path),
                    "candidate_order_sha256": _candidate_order_sha(candidate_ids),
                    "crossreview_decisions_sha256": crossreview_decisions_sha,
                    "crossreview_report_sha256": sha256_file(crossreview_report_path),
                    "decision_shard_sha256": decision_shas,
                    "original_blind_decision_sha256": original_decision_shas,
                    "pool_report_record_sha256": pool_report["record_sha256"],
                    "pool_report_sha256": sha256_file(pool_report_path),
                    "alternate_public_review_queue_cal001_160_projection_sha256": _projection_sha(
                        alternate_public_by_sample
                    ),
                    "private_binding_cal001_160_projection_sha256": private_projection_sha,
                    "private_binding_cal001_160_raw_prefix_sha256": _sha256_jsonl_prefix(
                        private_bindings_path,
                        CALIBRATION_ROW_COUNT,
                        "private calibration prefix",
                    ),
                    "private_bindings_declared_artifact_sha256": _mapping(
                        pool_report["artifacts"], "pool artifacts"
                    )["private-bindings.jsonl"]["sha256"],
                    "public_review_queue_cal001_160_raw_prefix_sha256": _sha256_jsonl_prefix(
                        review_queue_path,
                        CALIBRATION_ROW_COUNT,
                        "public calibration prefix",
                    ),
                    "public_review_queue_declared_artifact_sha256": _mapping(
                        pool_report["artifacts"], "pool artifacts"
                    )["review-queue.jsonl"]["sha256"],
                },
                "boundary": {
                    "calibration_binding_lines_json_decoded": CALIBRATION_ROW_COUNT,
                    "calibration_completed_rows": len(labels),
                    "calibration_excluded_rows": len(exclusions),
                    "catalog_gap_rows_excluded": exclusion_counts["catalog_gap_none_acceptable"],
                    "crop_reject_rows_excluded": exclusion_counts["crop_not_font_supervision_quality"],
                    "decision_binding_pool_review_item_sha_match_count": review_item_sha_match_count,
                    "decision_binding_pool_review_item_sha_mismatch_count": CALIBRATION_ROW_COUNT
                    - review_item_sha_match_count,
                    "decision_public_queue_generation_union_match_count": review_item_sha_match_count
                    + alternate_review_item_sha_match_count,
                    "private_binding_tail_json_decoded": False,
                    "private_binding_tail_raw_bytes_read": False,
                    "preferred_subset_of_acceptable": True,
                    "score_or_inference_artifacts_consumed": False,
                },
                "candidate_count": 21,
                "candidate_ids": list(candidate_ids),
                "record_type": REPORT_RECORD,
                "schema_version": REPORT_SCHEMA,
                "split_statistics": split_stats,
            }
        )
        report_path.write_bytes(json_bytes(report, pretty=True))
        staging.replace(target)
    return validate_label_artifact(target)


def _validate_label_row(row: Mapping[str, Any], candidate_ids: Sequence[str]) -> None:
    validate_record_seal(row, "bound label")
    if row.get("schema_version") != LABEL_SCHEMA or row.get("record_type") != LABEL_RECORD:
        raise BlindCalibrationBindingError("bound label schema drift")
    authority = _mapping(row.get("authority"), "label authority")
    if authority != {
        "automatic_label_promotion_allowed": False,
        "automatic_model_training_human_promotion_allowed": False,
        "calibration_fit_authority": True,
        "calibration_fit_eligible": True,
        "evaluation_eligible": False,
        "human_gold": False,
        "label_authority": "blind_crossreview_calibration_fit_only",
        "training_eligible": False,
    }:
        raise BlindCalibrationBindingError("label authority drift")
    judgment = _mapping(row.get("font_judgment"), "font judgment")
    preferred = _list(judgment.get("preferred"), "preferred")
    acceptable = _list(judgment.get("acceptable"), "acceptable")
    partition = {
        name: _list(judgment.get(name), name) for name in BOUND_PARTITION_FIELDS
    }
    flattened = [value for values in partition.values() for value in values]
    if (
        judgment.get("none_acceptable") is not False
        or not preferred
        or not set(preferred) <= set(acceptable)
        or set(acceptable)
        != set(preferred) | set(partition["acceptable_nonpreferred"])
        or len(flattened) != 21
        or len(set(flattened)) != 21
        or set(flattened) != set(candidate_ids)
    ):
        raise BlindCalibrationBindingError("bound label candidate partition drift")


def validate_label_artifact(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = _read_json(root / "report.json", "bound report")
    validate_record_seal(report, "bound report")
    if report.get("schema_version") != REPORT_SCHEMA or report.get("record_type") != REPORT_RECORD:
        raise BlindCalibrationBindingError("bound report schema drift")
    candidate_ids = [_text(value, "candidate id") for value in _list(report.get("candidate_ids"), "candidate ids")]
    if len(candidate_ids) != 21 or _candidate_order_sha(candidate_ids) != _mapping(report.get("bindings"), "bindings").get("candidate_order_sha256"):
        raise BlindCalibrationBindingError("bound report candidate drift")
    artifact_descriptors = _mapping(report.get("artifacts"), "artifact descriptors")
    expected = {"calibration-labels.jsonl", "excluded-calibration-rows.jsonl", "r3h-score-input-contract.json", "report.json"}
    actual = {path.name for path in root.iterdir() if path.is_file()}
    if actual != expected:
        raise BlindCalibrationBindingError("bound artifact inventory drift")
    labels = _read_exact_jsonl(root / "calibration-labels.jsonl", ELIGIBLE_ROW_COUNT, "bound labels")
    for row in labels:
        _validate_label_row(row, candidate_ids)
    exclusions = _read_exact_jsonl(root / "excluded-calibration-rows.jsonl", EXCLUDED_ROW_COUNT, "bound exclusions")
    for row in exclusions:
        validate_record_seal(row, "bound exclusion")
        if _mapping(row.get("authority"), "exclusion authority").get("calibration_fit_eligible") is not False:
            raise BlindCalibrationBindingError("excluded row became eligible")
    contract = _read_json(root / "r3h-score-input-contract.json", "score contract")
    validate_record_seal(contract, "score contract")
    if contract.get("labels_sha256") != sha256_file(root / "calibration-labels.jsonl"):
        raise BlindCalibrationBindingError("score contract label binding drift")
    for filename, count in (("calibration-labels.jsonl", ELIGIBLE_ROW_COUNT), ("excluded-calibration-rows.jsonl", EXCLUDED_ROW_COUNT)):
        descriptor = _mapping(artifact_descriptors.get(filename), f"descriptor {filename}")
        if descriptor.get("sha256") != sha256_file(root / filename) or descriptor.get("row_count") != count:
            raise BlindCalibrationBindingError("artifact descriptor drift")
    descriptor = _mapping(artifact_descriptors.get("r3h-score-input-contract.json"), "contract descriptor")
    if descriptor.get("sha256") != sha256_file(root / "r3h-score-input-contract.json"):
        raise BlindCalibrationBindingError("score contract descriptor drift")
    return report


def _load_fit_labels(artifact_dir: Path) -> tuple[list[FitLabel], list[str], dict[str, Any]]:
    report = validate_label_artifact(artifact_dir)
    candidate_ids = [str(value) for value in report["candidate_ids"]]
    rows = _read_exact_jsonl(artifact_dir / "calibration-labels.jsonl", ELIGIBLE_ROW_COUNT, "fit labels")
    labels: list[FitLabel] = []
    for row in rows:
        judgment = _mapping(row["font_judgment"], "font judgment")
        split = _mapping(row["split"], "split")
        resolution = _mapping(row["resolution"], "resolution")
        role = _mapping(row["role"], "role")
        labels.append(
            FitLabel(
                sample_id=str(row["sample_id"]),
                work_token=str(split["work_token"]),
                page_token=str(split["page_token"]),
                role=str(role["primary"]),
                confidence=_probability(resolution["confidence"], "fit confidence"),
                preferred=frozenset(str(value) for value in judgment["preferred"]),
                positive=frozenset(str(value) for value in judgment["acceptable"]),
                unrenderable=frozenset(str(value) for value in judgment["unrenderable"]),
            )
        )
    return labels, candidate_ids, report


def _load_scores(
    *,
    score_manifest_path: Path,
    scores_path: Path,
    labels_path: Path,
    active_catalog_sha256: str,
    candidate_ids: Sequence[str],
    expected_sample_ids: Sequence[str],
) -> tuple[np.ndarray, dict[str, Any]]:
    manifest = _read_json(score_manifest_path, "score manifest")
    validate_record_seal(manifest, "score manifest")
    if set(manifest) != SCORE_MANIFEST_KEYS:
        raise BlindCalibrationBindingError("score manifest exact-key contract drift")
    runtime_lineage = _mapping(manifest.get("runtime_lineage"), "runtime lineage")
    if set(runtime_lineage) != RUNTIME_LINEAGE_KEYS or any(not _is_sha(value) for value in runtime_lineage.values()):
        raise BlindCalibrationBindingError("runtime lineage contract drift")
    if (
        manifest.get("schema_version") != SCORE_MANIFEST_SCHEMA
        or manifest.get("record_type") != SCORE_MANIFEST_RECORD
        or manifest.get("row_count") != len(expected_sample_ids)
        or manifest.get("score_route") != SCORE_ROUTE
        or manifest.get("score_semantics") != SCORE_SEMANTICS
        or manifest.get("candidate_order_sha256") != _candidate_order_sha(candidate_ids)
        or manifest.get("calibration_labels_sha256") != sha256_file(labels_path)
        or manifest.get("active_catalog_sha256") != active_catalog_sha256
        or manifest.get("score_rows_sha256") != sha256_file(scores_path)
    ):
        raise BlindCalibrationBindingError("score manifest lineage drift")
    rows = _read_exact_jsonl(scores_path, len(expected_sample_ids), "r3h routed scores")
    by_sample: dict[str, np.ndarray] = {}
    for line_number, row in enumerate(rows, 1):
        validate_record_seal(row, f"score row:{line_number}")
        if set(row) != SCORE_ROW_KEYS:
            raise BlindCalibrationBindingError(f"score row:{line_number}: exact-key contract drift")
        if row.get("schema_version") != SCORE_ROW_SCHEMA or row.get("record_type") != SCORE_ROW_RECORD:
            raise BlindCalibrationBindingError("score row schema drift")
        sample_id = _text(row.get("sample_id"), "score sample_id")
        if sample_id in by_sample or row.get("candidate_ids") != list(candidate_ids):
            raise BlindCalibrationBindingError("score sample/candidate order drift")
        raw_scores = _list(row.get("candidate_scores"), "candidate scores")
        if len(raw_scores) != len(candidate_ids):
            raise BlindCalibrationBindingError("score candidate count drift")
        by_sample[sample_id] = np.asarray(
            [_finite(value, f"score row:{line_number}:candidate") for value in raw_scores],
            dtype=np.float64,
        )
    if set(by_sample) != set(expected_sample_ids):
        raise BlindCalibrationBindingError("score/label sample coverage drift")
    return np.stack([by_sample[sample_id] for sample_id in expected_sample_ids]), manifest


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - np.max(values)
    exponential = np.exp(shifted)
    return exponential / exponential.sum()


def _entropy(probabilities: np.ndarray) -> float:
    clipped = np.clip(probabilities, EPSILON, 1.0)
    return float(-(clipped * np.log(clipped)).sum())


def build_candidate_table(
    labels: Sequence[FitLabel], candidate_ids: Sequence[str], scores: np.ndarray
) -> CandidateTable:
    if scores.shape != (len(labels), len(candidate_ids)) or not np.isfinite(scores).all():
        raise BlindCalibrationBindingError("score matrix shape/finite contract drift")
    per_work_confidence: defaultdict[str, float] = defaultdict(float)
    for label in labels:
        per_work_confidence[label.work_token] += label.confidence
    feature_names = CONTINUOUS_FEATURE_NAMES + tuple(f"candidate_id::{value}" for value in candidate_ids)
    rows: list[list[float]] = []
    targets: list[int] = []
    weights: list[float] = []
    sample_indices: list[int] = []
    candidate_indices: list[int] = []
    for sample_index, label in enumerate(labels):
        row_scores = scores[sample_index]
        probabilities = _softmax(row_scores)
        order = np.argsort(-row_scores, kind="stable")
        ranks = np.empty(len(candidate_ids), dtype=np.int64)
        ranks[order] = np.arange(len(candidate_ids))
        mean = float(row_scores.mean())
        std = max(float(row_scores.std(ddof=0)), 1e-6)
        entropy = _entropy(probabilities)
        top3_mass = float(probabilities[order[:3]].sum())
        margin12 = float(probabilities[order[0]] - probabilities[order[1]])
        for candidate_index, candidate_id in enumerate(candidate_ids):
            if candidate_id in label.unrenderable:
                continue
            continuous = [
                float(row_scores[candidate_index] - mean),
                float((row_scores[candidate_index] - mean) / std),
                float(probabilities[candidate_index]),
                float(math.log(float(probabilities[candidate_index]) + EPSILON)),
                float(ranks[candidate_index] / max(1, len(candidate_ids) - 1)),
                float(row_scores[candidate_index] - row_scores[order[0]]),
                float(ranks[candidate_index] == 0),
                float(ranks[candidate_index] < 3),
                entropy,
                top3_mass,
                margin12,
            ]
            one_hot = [float(index == candidate_index) for index in range(len(candidate_ids))]
            rows.append(continuous + one_hot)
            targets.append(int(candidate_id in label.positive))
            weights.append(label.confidence / per_work_confidence[label.work_token])
            sample_indices.append(sample_index)
            candidate_indices.append(candidate_index)
    table = CandidateTable(
        features=np.asarray(rows, dtype=np.float64),
        labels=np.asarray(targets, dtype=np.int64),
        weights=np.asarray(weights, dtype=np.float64),
        sample_indices=np.asarray(sample_indices, dtype=np.int64),
        candidate_indices=np.asarray(candidate_indices, dtype=np.int64),
        feature_names=feature_names,
    )
    if set(table.labels.tolist()) != {0, 1} or not np.isfinite(table.features).all():
        raise BlindCalibrationBindingError("candidate calibration table invalid")
    return table


def _fit_predict(
    train: np.ndarray, test: np.ndarray, table: CandidateTable, C: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, Any]:
    try:
        from sklearn.linear_model import LogisticRegression
    except ImportError as error:
        raise BlindCalibrationBindingError("scikit-learn is required for score fit") from error
    if set(table.labels[train].tolist()) != {0, 1}:
        raise BlindCalibrationBindingError("calibration fold lacks both label classes")
    mean = table.features[train].mean(axis=0)
    scale = table.features[train].std(axis=0, ddof=0)
    scale[scale < 1e-8] = 1.0
    model = LogisticRegression(C=C, penalty="l2", solver="lbfgs", max_iter=3000, tol=1e-9)
    weight = table.weights[train]
    weight = weight * (len(weight) / weight.sum())
    model.fit((table.features[train] - mean) / scale, table.labels[train], sample_weight=weight)
    prediction = model.predict_proba((table.features[test] - mean) / scale)[:, 1]
    return prediction, mean, scale, model


def _weighted_log_loss(labels: np.ndarray, prediction: np.ndarray, weights: np.ndarray) -> float:
    clipped = np.clip(prediction, EPSILON, 1.0 - EPSILON)
    return float(np.average(-(labels * np.log(clipped) + (1 - labels) * np.log(1 - clipped)), weights=weights))


def _select_C(
    train_rows: np.ndarray,
    table: CandidateTable,
    labels: Sequence[FitLabel],
    C_grid: Sequence[float],
) -> float:
    works = sorted({labels[int(table.sample_indices[index])].work_token for index in train_rows})
    if len(works) < 2:
        raise BlindCalibrationBindingError("inner work-LOGO requires two training works")
    losses: list[tuple[float, float]] = []
    for C in C_grid:
        prediction = np.full(len(train_rows), np.nan)
        for work in works:
            test_local = np.asarray(
                [i for i, row in enumerate(train_rows) if labels[int(table.sample_indices[row])].work_token == work],
                dtype=np.int64,
            )
            held = set(test_local.tolist())
            train_local = np.asarray([i for i in range(len(train_rows)) if i not in held], dtype=np.int64)
            p, _, _, _ = _fit_predict(train_rows[train_local], train_rows[test_local], table, float(C))
            prediction[test_local] = p
        if not np.isfinite(prediction).all():
            raise BlindCalibrationBindingError("inner OOF prediction coverage drift")
        losses.append((_weighted_log_loss(table.labels[train_rows], prediction, table.weights[train_rows]), float(C)))
    losses.sort(key=lambda value: (round(value[0], 12), value[1]))
    return losses[0][1]


def _work_logo_predictions(
    table: CandidateTable,
    labels: Sequence[FitLabel],
    C_grid: Sequence[float],
    *,
    fixed_C: float | None = None,
) -> tuple[np.ndarray, list[dict[str, Any]], list[float]]:
    prediction = np.full(len(table.labels), np.nan)
    folds: list[dict[str, Any]] = []
    selected: list[float] = []
    for work in sorted({label.work_token for label in labels}):
        test = np.asarray(
            [index for index, sample_index in enumerate(table.sample_indices) if labels[int(sample_index)].work_token == work],
            dtype=np.int64,
        )
        held = set(test.tolist())
        train = np.asarray([index for index in range(len(table.labels)) if index not in held], dtype=np.int64)
        C = float(fixed_C) if fixed_C is not None else _select_C(train, table, labels, C_grid)
        p, _, _, _ = _fit_predict(train, test, table, C)
        prediction[test] = p
        selected.append(C)
        folds.append(
            {
                "C": C,
                "candidate_log_loss": _weighted_log_loss(table.labels[test], p, table.weights[test]),
                "candidate_row_count": int(len(test)),
                "held_out_work_token": work,
                "held_out_page_count": len({label.page_token for label in labels if label.work_token == work}),
            }
        )
    if not np.isfinite(prediction).all():
        raise BlindCalibrationBindingError("outer OOF prediction coverage drift")
    return prediction, folds, selected


def _geometric_median(values: Sequence[float]) -> float:
    logs = sorted(math.log(value) for value in values)
    middle = len(logs) // 2
    selected = logs[middle] if len(logs) % 2 else (logs[middle - 1] + logs[middle]) / 2
    return float(math.exp(selected))


def _role_family(role: str) -> str:
    if role in BODY_ROLES:
        return "body"
    if role == "other":
        return "other"
    return "variant"


def _winner_metrics(
    prediction: np.ndarray,
    table: CandidateTable,
    labels: Sequence[FitLabel],
    candidate_ids: Sequence[str],
    scores: np.ndarray,
) -> tuple[dict[str, Any], str, int]:
    by_sample: dict[int, dict[int, float]] = defaultdict(dict)
    for value, sample_index, candidate_index in zip(
        prediction, table.sample_indices, table.candidate_indices, strict=True
    ):
        by_sample[int(sample_index)][int(candidate_index)] = float(value)
    cohorts: dict[str, list[tuple[bool, bool, bool]]] = defaultdict(list)
    calibrated_ids: list[str] = []
    changed = 0
    for sample_index, label in enumerate(labels):
        raw_order = np.argsort(-scores[sample_index], kind="stable")
        eligible_top3 = [int(index) for index in raw_order[:3] if int(index) in by_sample[sample_index]]
        if not eligible_top3:
            raise BlindCalibrationBindingError("sample lacks renderable raw top-three candidate")
        winner = max(eligible_top3, key=lambda index: (by_sample[sample_index][index], -eligible_top3.index(index)))
        candidate_id = str(candidate_ids[winner])
        raw_id = str(candidate_ids[int(raw_order[0])])
        changed += int(candidate_id != raw_id)
        calibrated_ids.append(candidate_id)
        result = (candidate_id in label.positive, candidate_id in label.preferred, candidate_id == raw_id)
        cohorts["global"].append(result)
        cohorts[_role_family(label.role)].append(result)
    metrics: dict[str, Any] = {}
    for family in ("body", "variant", "global"):
        rows = cohorts.get(family, [])
        metrics[family] = {
            "acceptable_at1": sum(row[0] for row in rows) / len(rows) if rows else 0.0,
            "exact_raw_top1_agreement": sum(row[2] for row in rows) / len(rows) if rows else 0.0,
            "preferred_at1": sum(row[1] for row in rows) / len(rows) if rows else 0.0,
            "sample_count": len(rows),
        }
    winner_sha = sha256_bytes(
        "".join(f"{label.sample_id}\0{candidate_id}\n" for label, candidate_id in zip(labels, calibrated_ids, strict=True)).encode("utf-8")
    )
    return metrics, winner_sha, changed


def fit_r3h_scores(
    *,
    artifact_dir: Path,
    score_manifest_path: Path,
    scores_path: Path,
    output_path: Path,
    C_grid: Sequence[float] = DEFAULT_C_GRID,
) -> dict[str, Any]:
    if output_path.exists():
        raise BlindCalibrationBindingError("fit output already exists")
    labels, candidate_ids, report = _load_fit_labels(artifact_dir)
    bindings = _mapping(report.get("bindings"), "report bindings")
    score_matrix, score_manifest = _load_scores(
        score_manifest_path=score_manifest_path,
        scores_path=scores_path,
        labels_path=artifact_dir / "calibration-labels.jsonl",
        active_catalog_sha256=str(bindings["active_catalog_sha256"]),
        candidate_ids=candidate_ids,
        expected_sample_ids=[label.sample_id for label in labels],
    )
    table = build_candidate_table(labels, candidate_ids, score_matrix)
    nested, _nested_folds, selected_Cs = _work_logo_predictions(table, labels, C_grid)
    final_C = _geometric_median(selected_Cs)
    oof, folds, _ = _work_logo_predictions(table, labels, C_grid, fixed_C=final_C)
    all_rows = np.arange(len(table.labels), dtype=np.int64)
    _, mean, scale, model = _fit_predict(all_rows, all_rows, table, final_C)
    oof_metrics, winner_sha, changed = _winner_metrics(oof, table, labels, candidate_ids, score_matrix)
    nested_metrics, nested_winner_sha, nested_changed = _winner_metrics(nested, table, labels, candidate_ids, score_matrix)
    try:
        from sklearn.metrics import roc_auc_score

        auc = float(roc_auc_score(table.labels, oof, sample_weight=table.weights))
    except (ImportError, ValueError):
        auc = 0.0
    record = seal_record(
        {
            "authority": {
                "automatic_model_training_human_promotion_allowed": False,
                "calibration_fit_authority_only": True,
                "deployment_attachment_allowed": False,
                "human_gold": False,
                "training_eligible": False,
            },
            "bindings": {
                "active_catalog_sha256": bindings["active_catalog_sha256"],
                "calibration_labels_sha256": sha256_file(artifact_dir / "calibration-labels.jsonl"),
                "candidate_order_sha256": _candidate_order_sha(candidate_ids),
                "score_manifest_record_sha256": score_manifest["record_sha256"],
                "score_manifest_sha256": sha256_file(score_manifest_path),
                "score_rows_sha256": sha256_file(scores_path),
            },
            "candidate_ids": list(candidate_ids),
            "feature_contract": {
                "candidate_reranking": "within_raw_runtime_top3_only",
                "feature_names": list(table.feature_names),
                "gold_role_used_as_model_feature": False,
                "score_route": SCORE_ROUTE,
                "score_semantics": SCORE_SEMANTICS,
            },
            "logistic": {
                "c": final_C,
                "coef": [float(value) for value in model.coef_[0]],
                "intercept": float(model.intercept_[0]),
                "scaler_mean": [float(value) for value in mean],
                "scaler_scale": [float(value) for value in scale],
            },
            "oof_report": {
                "candidate_log_loss": _weighted_log_loss(table.labels, oof, table.weights),
                "candidate_roc_auc": auc,
                "changed_raw_top1_count": changed,
                "final_C": final_C,
                "fixed_C_metrics": oof_metrics,
                "fixed_C_winner_sha256": winner_sha,
                "folds": folds,
                "nested_changed_raw_top1_count": nested_changed,
                "nested_metrics": nested_metrics,
                "nested_winner_sha256": nested_winner_sha,
                "selected_C_values": selected_Cs,
                "work_group_oof": True,
            },
            "record_type": FIT_RECORD,
            "schema_version": FIT_SCHEMA,
            "supervision_boundary": {
                "candidate_row_count": int(len(table.labels)),
                "catalog_gap_rows_used": 0,
                "crop_reject_rows_used": 0,
                "evaluation_rows_used": 0,
                "human_gold_rows_used": 0,
                "sample_count": len(labels),
                "work_count": len({label.work_token for label in labels}),
            },
        }
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(json_bytes(record, pretty=True))
    validate_fit(record)
    return record


def validate_fit(record: Mapping[str, Any]) -> dict[str, Any]:
    validate_record_seal(record, "r3h calibration fit")
    if record.get("schema_version") != FIT_SCHEMA or record.get("record_type") != FIT_RECORD:
        raise BlindCalibrationBindingError("r3h fit schema drift")
    authority = _mapping(record.get("authority"), "fit authority")
    if authority.get("calibration_fit_authority_only") is not True or authority.get("deployment_attachment_allowed") is not False or authority.get("human_gold") is not False or authority.get("training_eligible") is not False:
        raise BlindCalibrationBindingError("r3h fit authority drift")
    boundary = _mapping(record.get("supervision_boundary"), "fit boundary")
    if boundary.get("sample_count") != ELIGIBLE_ROW_COUNT or any(boundary.get(key) != 0 for key in ("catalog_gap_rows_used", "crop_reject_rows_used", "evaluation_rows_used", "human_gold_rows_used")):
        raise BlindCalibrationBindingError("r3h fit supervision boundary drift")
    return dict(record)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-labels")
    build.add_argument("--decisions", action="append", type=Path, required=True)
    build.add_argument("--crossreview-report", type=Path, required=True)
    build.add_argument("--crossreview-decisions", type=Path, required=True)
    build.add_argument("--private-bindings", type=Path, required=True)
    build.add_argument("--review-queue", type=Path, required=True)
    build.add_argument("--alternate-review-queue", type=Path, required=True)
    build.add_argument("--pool-report", type=Path, required=True)
    build.add_argument("--active-catalog", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate-labels")
    validate.add_argument("--artifact-dir", type=Path, required=True)
    fit = commands.add_parser("fit-r3h-scores")
    fit.add_argument("--artifact-dir", type=Path, required=True)
    fit.add_argument("--score-manifest", type=Path, required=True)
    fit.add_argument("--scores", type=Path, required=True)
    fit.add_argument("--output", type=Path, required=True)
    validate_score_fit = commands.add_parser("validate-fit")
    validate_score_fit.add_argument("--artifact", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build-labels":
            report = build_labels(
                decision_paths=args.decisions,
                crossreview_report_path=args.crossreview_report,
                crossreview_decisions_path=args.crossreview_decisions,
                private_bindings_path=args.private_bindings,
                review_queue_path=args.review_queue,
                alternate_review_queue_path=args.alternate_review_queue,
                pool_report_path=args.pool_report,
                active_catalog_path=args.active_catalog,
                output_dir=args.output_dir,
            )
            result = {
                "eligible_rows": report["boundary"]["calibration_completed_rows"],
                "excluded_rows": report["boundary"]["calibration_excluded_rows"],
                "record_sha256": report["record_sha256"],
                "status": "valid_calibration_fit_only_labels",
            }
        elif args.command == "validate-labels":
            report = validate_label_artifact(args.artifact_dir)
            result = {"record_sha256": report["record_sha256"], "status": "valid_calibration_fit_only_labels"}
        elif args.command == "fit-r3h-scores":
            fit = fit_r3h_scores(
                artifact_dir=args.artifact_dir,
                score_manifest_path=args.score_manifest,
                scores_path=args.scores,
                output_path=args.output,
            )
            result = {"record_sha256": fit["record_sha256"], "status": "valid_calibration_fit_requires_independent_quality_gate"}
        else:
            fit = validate_fit(_read_json(args.artifact, "r3h fit"))
            result = {"record_sha256": fit["record_sha256"], "status": "valid_calibration_fit_requires_independent_quality_gate"}
    except BlindCalibrationBindingError as error:
        print(json.dumps({"error": str(error), "status": "blocked"}, ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
