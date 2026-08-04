#!/usr/bin/env python3
"""Finalize the sealed 28k three-pass font review into an active21 overlay.

The review bundle deliberately keeps every template pseudo-only.  This tool is
the narrow authority boundary that can promote *completed* three-pass human
decisions.  It preserves every pass and correction, emits a partial candidate
mask when only the displayed fonts were reviewed, retires ``gugi``, joins rows
to the current master by exact split/work/chapter/page identity, and never
places test decisions in the supervised output.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from itertools import zip_longest
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from scripts import build_manga_font_fast_review_batches as review
    from scripts import build_manga_font_student_calibration_review as catalog
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_fast_review_batches as review
    import build_manga_font_student_calibration_review as catalog


SCHEMA_VERSION = "manga-font-fast-review-supervised-overlay-v1"
RECORD_TYPE = "manga_font_fast_review_supervised_overlay_row"
MANIFEST_TYPE = "manga_font_fast_review_supervised_overlay_manifest"
REPORT_TYPE = "manga_font_fast_review_supervised_overlay_report"
OWNER = "carrot-manga-translator/manga-font-fast-review-supervised-overlay-v1"
MARKER_FILE = ".manga-font-fast-review-supervised-overlay-v1-owned.json"
OVERLAY_FILE = "supervised-overlay.jsonl"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset({MARKER_FILE, OVERLAY_FILE, MANIFEST_FILE, REPORT_FILE})
RETIRED_FONT_ID = "gugi"
FULL_CANDIDATE_IDS = tuple(catalog.EXPECTED_CANDIDATE_IDS)
ACTIVE_CANDIDATE_IDS = tuple(
    candidate_id for candidate_id in FULL_CANDIDATE_IDS if candidate_id != RETIRED_FONT_ID
)
PASS_PURPOSES = dict(review.REVIEW_PASSES)
JUDGMENT_TIERS = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
    "not_reviewed",
)
DECISION_REQUIRED_FIELDS = frozenset(
    {
        "acceptable_font_ids",
        "confidence",
        "decision_status",
        "label_authority",
        "none_acceptable",
        "notes",
        "promotion_allowed",
        "record_type",
        "review_item_sha256",
        "review_pass",
        "review_purpose",
        "reviewed_at",
        "reviewer",
        "sample_id",
        "schema_version",
        "selected_font_id",
        "training_eligible",
    }
)
DECISION_OPTIONAL_FIELDS = frozenset(
    {"correction_reason", "decision_metadata", "record_sha256", "reviewed_font_ids"}
)
SAFE_BATCH_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class FastReviewFinalizationError(review.FastNamedReviewError):
    """Raised when a review decision cannot safely become supervision."""


@dataclass(frozen=True)
class ReviewItem:
    sample_id: str
    record_sha256: str
    split: str
    work_id: str
    chapter_id: str
    page_id: str
    source_page_sha256: str
    candidate_ids: tuple[str, ...]
    source_category: str | None


@dataclass(frozen=True)
class MasterIdentity:
    sample_id: str
    split: str
    work_id: str
    chapter_id: str
    page_id: str
    source_page_sha256: str
    record_sha256: str
    line_number: int
    work_balance_weight: float


@dataclass(frozen=True)
class Decision:
    sample_id: str
    review_pass: int
    review_purpose: str
    review_item_sha256: str
    selected_font_id: str | None
    acceptable_font_ids: tuple[str, ...]
    none_acceptable: bool
    reviewed_font_ids: tuple[str, ...] | None
    confidence: float
    notes: str
    correction_reason: str | None
    reviewer: str
    reviewed_at: str
    decision_sha256: str


@dataclass(frozen=True)
class DecisionSource:
    path: Path
    sha256: str
    byte_size: int
    record_count: int


@dataclass(frozen=True)
class PreparedOverlay:
    rows: tuple[dict[str, Any], ...]
    bindings: Mapping[str, Any]
    stats: Mapping[str, Any]
    checks: Mapping[str, Any]


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise FastReviewFinalizationError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise FastReviewFinalizationError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise FastReviewFinalizationError(f"{location}: expected text")
    return result


def _optional_text(value: Any, location: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise FastReviewFinalizationError(f"{location}: expected text or null")
    result = value.strip()
    return result or None


def _record_digest(row: Mapping[str, Any], *, location: str) -> str:
    if "record_sha256" in row:
        return review.validate_record_seal(row, location=location)
    return review.sha256_bytes(review.canonical_json(row).encode("utf-8"))


def _iter_jsonl(path: Path, location: str) -> Iterable[tuple[int, dict[str, Any]]]:
    try:
        yield from review._iter_jsonl(path, location)  # noqa: SLF001
    except review.FastNamedReviewError as error:
        raise FastReviewFinalizationError(str(error)) from error


def _safe_child(root: Path, relative: PurePosixPath, location: str) -> Path:
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise FastReviewFinalizationError(f"{location}: unsafe relative path")
    path = root.joinpath(*relative.parts).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise FastReviewFinalizationError(f"{location}: path escapes root") from error
    return path


def _page_sha(page: Mapping[str, Any], location: str) -> str:
    direct = page.get("source_page_sha256")
    locator = _mapping(page.get("source_locator"), f"{location}.source_locator")
    located = locator.get("file_sha256")
    value = direct if isinstance(direct, str) and direct else located
    result = _text(value, f"{location}.source_page_sha256")
    if direct is not None and located is not None and direct != located:
        raise FastReviewFinalizationError(f"{location}: source page SHA disagrees")
    return result


def _load_review_items(
    review_dir: Path,
) -> tuple[tuple[ReviewItem, ...], Mapping[str, Any], str]:
    root = review_dir.expanduser().resolve()
    try:
        review.validate_review_bundle(root, verify_items=True)
        report = review._read_json(root / review.REPORT_FILE, "review report")  # noqa: SLF001
    except review.FastNamedReviewError as error:
        raise FastReviewFinalizationError(f"review bundle: {error}") from error
    candidate_ids = tuple(
        _text(value, f"review report.candidate_ids[{index}]")
        for index, value in enumerate(
            _list(report.get("candidate_ids"), "review report.candidate_ids")
        )
    )
    if candidate_ids != FULL_CANDIDATE_IDS:
        raise FastReviewFinalizationError("review bundle candidate order is not sealed full22")
    output: list[ReviewItem] = []
    seen: set[str] = set()
    for batch_index, raw_batch in enumerate(
        _list(report.get("batches"), "review report.batches"), 1
    ):
        batch = _mapping(raw_batch, f"review report.batches[{batch_index}]")
        batch_name = _text(batch.get("batch"), f"batch[{batch_index}].batch")
        if SAFE_BATCH_RE.fullmatch(batch_name) is None:
            raise FastReviewFinalizationError("unsafe review batch name")
        artifacts = _mapping(batch.get("artifacts"), f"batch[{batch_index}].artifacts")
        descriptor = _mapping(
            artifacts.get("review_items"), f"batch[{batch_index}].review_items"
        )
        filename = _text(descriptor.get("file"), "review item filename")
        item_path = _safe_child(
            root,
            PurePosixPath("batches") / batch_name / PurePosixPath(filename),
            "review items",
        )
        for line_number, row in _iter_jsonl(item_path, f"review items {batch_name}"):
            location = f"review items {batch_name}:{line_number}"
            try:
                review.validate_review_item(row)
            except review.FastNamedReviewError as error:
                raise FastReviewFinalizationError(f"{location}: {error}") from error
            sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
            if sample_id in seen:
                raise FastReviewFinalizationError(f"duplicate review item {sample_id}")
            seen.add(sample_id)
            work = _mapping(row.get("work"), f"{location}.work")
            chapter = _mapping(row.get("chapter"), f"{location}.chapter")
            page = _mapping(row.get("page"), f"{location}.page")
            source = _mapping(row.get("source"), f"{location}.source")
            displayed = tuple(
                _text(candidate.get("candidate_id"), f"{location}.candidate_id")
                for candidate in (
                    _mapping(value, f"{location}.candidates")
                    for value in _list(row.get("candidates"), f"{location}.candidates")
                )
            )
            if not displayed or len(displayed) != len(set(displayed)):
                raise FastReviewFinalizationError(f"{location}: invalid displayed candidates")
            if not set(displayed) <= set(FULL_CANDIDATE_IDS):
                raise FastReviewFinalizationError(f"{location}: unknown displayed font")
            output.append(
                ReviewItem(
                    sample_id=sample_id,
                    record_sha256=_text(
                        row.get("record_sha256"), f"{location}.record_sha256"
                    ),
                    split=_text(row.get("split"), f"{location}.split"),
                    work_id=_text(work.get("id"), f"{location}.work.id"),
                    chapter_id=_text(chapter.get("id"), f"{location}.chapter.id"),
                    page_id=_text(page.get("id"), f"{location}.page.id"),
                    source_page_sha256=_page_sha(page, f"{location}.page"),
                    candidate_ids=displayed,
                    source_category=(
                        str(source["source_category"])
                        if source.get("source_category") is not None
                        else None
                    ),
                )
            )
    expected = int(_mapping(report.get("stats"), "review report.stats")["rows"])
    if len(output) != expected:
        raise FastReviewFinalizationError("review item count drifted")
    return tuple(output), report, review.sha256_file(root / review.REPORT_FILE)


def _load_master(
    master_manifest: Path,
) -> tuple[dict[str, MasterIdentity], Mapping[str, Any]]:
    path = master_manifest.expanduser().resolve()
    if path.is_symlink() or not path.is_file():
        raise FastReviewFinalizationError("master manifest is missing or linked")
    report_path = path.parent / "report.json"
    if report_path.is_symlink() or not report_path.is_file():
        raise FastReviewFinalizationError("master report is missing or linked")
    try:
        master_report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FastReviewFinalizationError(f"invalid master report: {error}") from error
    master_report = _mapping(master_report, "master report")
    outputs = _mapping(master_report.get("outputs"), "master report.outputs")
    manifest_sha = review.sha256_file(path)
    if (
        master_report.get("tool") != "manga-translator-font-matching-master-builder"
        or master_report.get("report_schema_version") != 1
        or outputs.get("master_manifest") != path.name
        or outputs.get("master_manifest_sha256") != manifest_sha
    ):
        raise FastReviewFinalizationError("master report/manifest binding drifted")
    split_map_name = _text(outputs.get("split_map"), "master report.outputs.split_map")
    split_map_path = _safe_child(path.parent, PurePosixPath(split_map_name), "split map")
    if split_map_path.is_symlink() or not split_map_path.is_file():
        raise FastReviewFinalizationError("master split map is missing or linked")
    split_map_sha = review.sha256_file(split_map_path)
    if outputs.get("split_map_sha256") != split_map_sha:
        raise FastReviewFinalizationError("master split map hash drifted")

    identities: dict[str, MasterIdentity] = {}
    for line_number, row in _iter_jsonl(path, "master-v3 manifest"):
        location = f"master-v3 manifest:{line_number}"
        if row.get("schema_version") != 1 or row.get("catalog_version") != 1:
            raise FastReviewFinalizationError(f"{location}: master schema drifted")
        sample_id = _text(row.get("id"), f"{location}.id")
        if sample_id in identities:
            raise FastReviewFinalizationError(f"{location}: duplicate master ID")
        split = _text(row.get("split"), f"{location}.split")
        if split not in {"train", "val", "test"}:
            raise FastReviewFinalizationError(f"{location}: invalid split")
        provenance = _mapping(row.get("provenance"), f"{location}.provenance")
        if (
            provenance.get("approval") != "exhaustive_manual_visual_review"
            or provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
        ):
            raise FastReviewFinalizationError(f"{location}: non-authoritative crop")
        work = _mapping(row.get("work"), f"{location}.work")
        chapter = _mapping(row.get("chapter"), f"{location}.chapter")
        page = _mapping(row.get("page"), f"{location}.page")
        weight = row.get("work_balance_weight")
        if isinstance(weight, bool) or not isinstance(weight, (int, float)):
            raise FastReviewFinalizationError(f"{location}: invalid work balance weight")
        weight = float(weight)
        if not math.isfinite(weight) or weight <= 0.0:
            raise FastReviewFinalizationError(f"{location}: invalid work balance weight")
        identities[sample_id] = MasterIdentity(
            sample_id=sample_id,
            split=split,
            work_id=_text(work.get("id"), f"{location}.work.id"),
            chapter_id=_text(chapter.get("id"), f"{location}.chapter.id"),
            page_id=_text(page.get("id"), f"{location}.page.id"),
            source_page_sha256=_page_sha(page, f"{location}.page"),
            record_sha256=review.sha256_bytes(
                review.canonical_json(row).encode("utf-8")
            ),
            line_number=line_number,
            work_balance_weight=weight,
        )
    if not identities:
        raise FastReviewFinalizationError("master manifest is empty")
    return identities, {
        "manifest_file": path.name,
        "manifest_sha256": manifest_sha,
        "record_count": len(identities),
        "report_sha256": review.sha256_file(report_path),
        "split_map_file": split_map_name,
        "split_map_sha256": split_map_sha,
    }


def _parse_reviewed_at(value: Any, location: str) -> str:
    text = _text(value, location)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise FastReviewFinalizationError(f"{location}: invalid ISO timestamp") from error
    if parsed.tzinfo is None:
        raise FastReviewFinalizationError(f"{location}: timezone is required")
    return text


def _font_list(value: Any, location: str) -> tuple[str, ...]:
    output = tuple(
        _text(item, f"{location}[{index}]")
        for index, item in enumerate(_list(value, location))
    )
    if len(output) != len(set(output)):
        raise FastReviewFinalizationError(f"{location}: duplicate font")
    return output


def _load_decisions(
    decision_paths: Sequence[Path],
) -> tuple[dict[tuple[str, int], Decision], tuple[DecisionSource, ...]]:
    resolved = tuple(sorted({path.expanduser().resolve() for path in decision_paths}, key=str))
    if not resolved:
        raise FastReviewFinalizationError("at least one completed decision JSONL is required")
    decisions: dict[tuple[str, int], Decision] = {}
    sources: list[DecisionSource] = []
    for source_index, path in enumerate(resolved, 1):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() != ".jsonl":
            raise FastReviewFinalizationError(f"decision source {path} is not a plain JSONL file")
        record_count = 0
        for line_number, row in _iter_jsonl(path, f"decision source {source_index}"):
            record_count += 1
            location = f"decision source {source_index}:{line_number}"
            fields = set(row)
            missing = DECISION_REQUIRED_FIELDS - fields
            unknown = fields - DECISION_REQUIRED_FIELDS - DECISION_OPTIONAL_FIELDS
            if missing or unknown:
                raise FastReviewFinalizationError(
                    f"{location}: decision schema drift; missing={sorted(missing)}, unknown={sorted(unknown)}"
                )
            if (
                row.get("schema_version") != review.SCHEMA_VERSION
                or row.get("record_type") != review.DECISION_TYPE
                or row.get("decision_status") != "completed"
                or row.get("label_authority") != "pseudo_not_gold"
                or row.get("promotion_allowed") is not False
                or row.get("training_eligible") is not False
            ):
                raise FastReviewFinalizationError(
                    f"{location}: pending or pre-promoted decision is forbidden"
                )
            review_pass = row.get("review_pass")
            if isinstance(review_pass, bool) or review_pass not in PASS_PURPOSES:
                raise FastReviewFinalizationError(f"{location}: invalid review pass")
            purpose = _text(row.get("review_purpose"), f"{location}.review_purpose")
            if purpose != PASS_PURPOSES[int(review_pass)]:
                raise FastReviewFinalizationError(f"{location}: review purpose drifted")
            confidence = row.get("confidence")
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
                raise FastReviewFinalizationError(f"{location}: confidence is required")
            confidence = float(confidence)
            if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
                raise FastReviewFinalizationError(f"{location}: invalid confidence")
            sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
            key = (sample_id, int(review_pass))
            if key in decisions:
                raise FastReviewFinalizationError(
                    f"{location}: duplicate decision for {sample_id} pass {review_pass}"
                )
            notes = row.get("notes")
            if not isinstance(notes, str):
                raise FastReviewFinalizationError(f"{location}: notes must be text")
            selected = _optional_text(
                row.get("selected_font_id"), f"{location}.selected_font_id"
            )
            acceptable = _font_list(
                row.get("acceptable_font_ids"), f"{location}.acceptable_font_ids"
            )
            none_acceptable = row.get("none_acceptable")
            if not isinstance(none_acceptable, bool):
                raise FastReviewFinalizationError(
                    f"{location}: none_acceptable must be decided"
                )
            if none_acceptable and (selected is not None or acceptable):
                raise FastReviewFinalizationError(
                    f"{location}: none_acceptable conflicts with positive fonts"
                )
            if not none_acceptable and selected is None:
                raise FastReviewFinalizationError(
                    f"{location}: a preferred selected_font_id is required"
                )
            if selected is not None and selected in acceptable:
                raise FastReviewFinalizationError(
                    f"{location}: preferred font is duplicated as acceptable"
                )
            reviewed_ids = (
                _font_list(row["reviewed_font_ids"], f"{location}.reviewed_font_ids")
                if "reviewed_font_ids" in row
                else None
            )
            decision = Decision(
                sample_id=sample_id,
                review_pass=int(review_pass),
                review_purpose=purpose,
                review_item_sha256=_text(
                    row.get("review_item_sha256"), f"{location}.review_item_sha256"
                ),
                selected_font_id=selected,
                acceptable_font_ids=acceptable,
                none_acceptable=none_acceptable,
                reviewed_font_ids=reviewed_ids,
                confidence=confidence,
                notes=notes,
                correction_reason=_optional_text(
                    row.get("correction_reason"), f"{location}.correction_reason"
                ),
                reviewer=_text(row.get("reviewer"), f"{location}.reviewer"),
                reviewed_at=_parse_reviewed_at(
                    row.get("reviewed_at"), f"{location}.reviewed_at"
                ),
                decision_sha256=_record_digest(row, location=location),
            )
            decisions[key] = decision
        if record_count == 0:
            raise FastReviewFinalizationError(f"decision source {path} is empty")
        sources.append(
            DecisionSource(
                path=path,
                sha256=review.sha256_file(path),
                byte_size=path.stat().st_size,
                record_count=record_count,
            )
        )
    return decisions, tuple(sources)


def _active_order(values: Iterable[str]) -> tuple[str, ...]:
    wanted = set(values)
    return tuple(value for value in ACTIVE_CANDIDATE_IDS if value in wanted)


def _validated_reviewed_ids(
    decision: Decision, item: ReviewItem, *, location: str
) -> tuple[str, ...]:
    values = (
        decision.reviewed_font_ids
        if decision.reviewed_font_ids is not None
        else tuple(value for value in item.candidate_ids if value != RETIRED_FONT_ID)
    )
    unknown = set(values) - set(ACTIVE_CANDIDATE_IDS)
    if unknown:
        retired = RETIRED_FONT_ID in unknown
        qualifier = "retired Gugi" if retired else "unknown font"
        raise FastReviewFinalizationError(
            f"{location}: {qualifier} in reviewed_font_ids: {sorted(unknown)}"
        )
    if not values:
        raise FastReviewFinalizationError(f"{location}: no active font was reviewed")
    positives = {
        value
        for value in (decision.selected_font_id, *decision.acceptable_font_ids)
        if value is not None
    }
    unknown_positive = positives - set(ACTIVE_CANDIDATE_IDS)
    if unknown_positive:
        raise FastReviewFinalizationError(
            f"{location}: retired or unknown positive font: {sorted(unknown_positive)}"
        )
    if not positives <= set(values):
        raise FastReviewFinalizationError(
            f"{location}: positive font was not included in the reviewed candidate mask"
        )
    return _active_order(values)


def _decision_signature(decision: Decision) -> tuple[Any, ...]:
    return (
        decision.selected_font_id,
        _active_order(decision.acceptable_font_ids),
        decision.none_acceptable,
    )


def _changed_fields(previous: Decision, current: Decision) -> list[str]:
    fields = []
    if previous.selected_font_id != current.selected_font_id:
        fields.append("selected_font_id")
    if set(previous.acceptable_font_ids) != set(current.acceptable_font_ids):
        fields.append("acceptable_font_ids")
    if previous.none_acceptable != current.none_acceptable:
        fields.append("none_acceptable")
    return fields


def _validate_identity(item: ReviewItem, master: MasterIdentity) -> None:
    pairs = {
        "split": (item.split, master.split),
        "work_id": (item.work_id, master.work_id),
        "chapter_id": (item.chapter_id, master.chapter_id),
        "page_id": (item.page_id, master.page_id),
        "source_page_sha256": (item.source_page_sha256, master.source_page_sha256),
    }
    mismatches = [name for name, values in pairs.items() if values[0] != values[1]]
    if mismatches:
        raise FastReviewFinalizationError(
            f"{item.sample_id}: master-v3 identity mismatch: {mismatches}"
        )


def _pass_provenance(
    decision: Decision, reviewed_ids: tuple[str, ...]
) -> dict[str, Any]:
    output = {
        "acceptable_font_ids": list(decision.acceptable_font_ids),
        "confidence": decision.confidence,
        "decision_sha256": decision.decision_sha256,
        "decision_status": "completed",
        "label_authority_before_finalization": "pseudo_not_gold",
        "none_acceptable": decision.none_acceptable,
        "notes": decision.notes,
        "review_pass": decision.review_pass,
        "review_purpose": decision.review_purpose,
        "reviewed_at": decision.reviewed_at,
        "reviewed_font_ids": list(reviewed_ids),
        "reviewer": decision.reviewer,
        "selected_font_id": decision.selected_font_id,
    }
    if decision.correction_reason is not None:
        output["correction_reason"] = decision.correction_reason
    return output


def _build_overlay_row(
    *,
    item: ReviewItem,
    master: MasterIdentity,
    passes: tuple[Decision, Decision, Decision],
    reviewed_by_pass: tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]],
    review_report_sha256: str,
    master_manifest_sha256: str,
) -> dict[str, Any]:
    final = passes[2]
    reviewed_union = _active_order(
        value for values in reviewed_by_pass for value in values
    )
    positives = {
        value
        for value in (final.selected_font_id, *final.acceptable_font_ids)
        if value is not None
    }
    preferred = [final.selected_font_id] if final.selected_font_id is not None else []
    acceptable = [
        value
        for value in ACTIVE_CANDIDATE_IDS
        if value in set(final.acceptable_font_ids)
    ]
    reviewed_set = set(reviewed_union)
    judgment = {
        "acceptable": acceptable,
        "marginal": [],
        "none_acceptable": final.none_acceptable,
        "not_reviewed": [
            value for value in ACTIVE_CANDIDATE_IDS if value not in reviewed_set
        ],
        "preferred": preferred,
        "unacceptable": [
            value
            for value in ACTIVE_CANDIDATE_IDS
            if value in reviewed_set and value not in positives
        ],
        "unrenderable": [],
    }
    signatures = [_decision_signature(value) for value in passes]
    corrections = []
    for previous, current in zip(passes, passes[1:]):
        changed = _changed_fields(previous, current)
        if changed:
            correction = {
                "changed_fields": changed,
                "decision_sha256": current.decision_sha256,
                "from_pass": previous.review_pass,
                "notes": current.notes,
                "reviewed_at": current.reviewed_at,
                "reviewer": current.reviewer,
                "to_pass": current.review_pass,
            }
            if current.correction_reason is not None:
                correction["correction_reason"] = current.correction_reason
            corrections.append(correction)
    core = {
        "candidate_ids": list(ACTIVE_CANDIDATE_IDS),
        "candidate_mask": [
            candidate_id in reviewed_set for candidate_id in ACTIVE_CANDIDATE_IDS
        ],
        "chapter_id": master.chapter_id,
        "evaluation_eligible": master.split == "val",
        "font_judgment": judgment,
        "label_authority": "completed_human_three_pass_review",
        "label_confidence": final.confidence,
        "master_binding": {
            "line_number": master.line_number,
            "manifest_sha256": master_manifest_sha256,
            "record_sha256": master.record_sha256,
        },
        "page_id": master.page_id,
        "partial_candidate_mask": len(reviewed_union) < len(ACTIVE_CANDIDATE_IDS),
        "record_type": RECORD_TYPE,
        "review_provenance": {
            "agreement": {
                "distinct_decision_count": len(set(signatures)),
                "final_agrees_with_pass1": signatures[2] == signatures[0],
                "final_agrees_with_pass2": signatures[2] == signatures[1],
                "unanimous": len(set(signatures)) == 1,
            },
            "corrections": corrections,
            "model_suggestions_visible_during_review": True,
            "passes": [
                _pass_provenance(decision, reviewed_ids)
                for decision, reviewed_ids in zip(passes, reviewed_by_pass)
            ],
            "review_bundle_report_sha256": review_report_sha256,
            "review_item_sha256": item.record_sha256,
        },
        "sample_id": item.sample_id,
        "schema_version": SCHEMA_VERSION,
        "source_category": item.source_category,
        "source_page_sha256": master.source_page_sha256,
        "split": master.split,
        "test_split_training_promotion_forbidden": True,
        "training_eligible": master.split == "train",
        "work_balance_weight": master.work_balance_weight,
        "work_id": master.work_id,
    }
    return review.seal_record(core)


def _validate_output_row(row: Mapping[str, Any], master: MasterIdentity) -> None:
    review.validate_record_seal(row, location=f"overlay {master.sample_id}")
    if (
        row.get("schema_version") != SCHEMA_VERSION
        or row.get("record_type") != RECORD_TYPE
        or row.get("sample_id") != master.sample_id
        or row.get("split") != master.split
        or row.get("split") not in {"train", "val"}
        or row.get("training_eligible") is not (master.split == "train")
        or row.get("evaluation_eligible") is not (master.split == "val")
        or row.get("test_split_training_promotion_forbidden") is not True
        or row.get("label_authority") != "completed_human_three_pass_review"
        or tuple(_list(row.get("candidate_ids"), "overlay candidate_ids"))
        != ACTIVE_CANDIDATE_IDS
    ):
        raise FastReviewFinalizationError(f"{master.sample_id}: overlay boundary drifted")
    mask = _list(row.get("candidate_mask"), "overlay candidate_mask")
    if len(mask) != len(ACTIVE_CANDIDATE_IDS) or any(
        not isinstance(value, bool) for value in mask
    ):
        raise FastReviewFinalizationError(f"{master.sample_id}: invalid candidate mask")
    judgment = _mapping(row.get("font_judgment"), "overlay font_judgment")
    if set(judgment) != set(JUDGMENT_TIERS) | {"none_acceptable"}:
        raise FastReviewFinalizationError(f"{master.sample_id}: judgment schema drifted")
    tiers = {
        tier: tuple(_list(judgment.get(tier), f"overlay.{tier}"))
        for tier in JUDGMENT_TIERS
    }
    flattened = tuple(value for tier in JUDGMENT_TIERS for value in tiers[tier])
    if len(flattened) != len(set(flattened)) or set(flattened) != set(ACTIVE_CANDIDATE_IDS):
        raise FastReviewFinalizationError(
            f"{master.sample_id}: judgment does not partition active21"
        )
    reviewed = set(ACTIVE_CANDIDATE_IDS) - set(tiers["not_reviewed"])
    if [candidate_id in reviewed for candidate_id in ACTIVE_CANDIDATE_IDS] != mask:
        raise FastReviewFinalizationError(f"{master.sample_id}: candidate mask drifted")
    positives = (*tiers["preferred"], *tiers["acceptable"])
    none_acceptable = judgment.get("none_acceptable")
    if (
        not isinstance(none_acceptable, bool)
        or none_acceptable == bool(positives)
        or (not none_acceptable and len(tiers["preferred"]) != 1)
        or (none_acceptable and tiers["preferred"])
    ):
        raise FastReviewFinalizationError(f"{master.sample_id}: none/preferred semantics drifted")


def prepare_overlay(
    *,
    review_dir: Path,
    master_manifest: Path,
    decision_paths: Sequence[Path],
) -> PreparedOverlay:
    items, review_report, review_report_sha = _load_review_items(review_dir)
    master_rows, master_binding = _load_master(master_manifest)
    decisions, decision_sources = _load_decisions(decision_paths)
    item_by_id = {item.sample_id: item for item in items}
    expected_decisions = {
        (item.sample_id, pass_number)
        for item in items
        for pass_number in PASS_PURPOSES
    }
    actual_decisions = set(decisions)
    if actual_decisions != expected_decisions:
        missing = sorted(expected_decisions - actual_decisions)[:8]
        extra = sorted(actual_decisions - expected_decisions)[:8]
        raise FastReviewFinalizationError(
            f"three-pass decisions are incomplete; missing={missing}, extra={extra}"
        )

    output_rows: list[dict[str, Any]] = []
    stale_item_ids: list[str] = []
    omitted_test_ids: list[str] = []
    output_split_counts: Counter[str] = Counter()
    preferred_counts: Counter[str] = Counter()
    acceptable_counts: Counter[str] = Counter()
    unanimous = 0
    corrected = 0
    none_count = 0
    full_mask_count = 0
    partial_mask_count = 0
    for item in items:
        passes = tuple(decisions[(item.sample_id, number)] for number in (1, 2, 3))
        assert len(passes) == 3
        reviewed_by_pass = []
        for decision in passes:
            location = f"{item.sample_id}.pass{decision.review_pass}"
            if decision.review_item_sha256 != item.record_sha256:
                raise FastReviewFinalizationError(f"{location}: review item binding drifted")
            reviewed_by_pass.append(
                _validated_reviewed_ids(decision, item, location=location)
            )
        master = master_rows.get(item.sample_id)
        if master is None:
            stale_item_ids.append(item.sample_id)
            continue
        _validate_identity(item, master)
        if master.split == "test":
            omitted_test_ids.append(item.sample_id)
            continue
        row = _build_overlay_row(
            item=item,
            master=master,
            passes=passes,  # type: ignore[arg-type]
            reviewed_by_pass=tuple(reviewed_by_pass),  # type: ignore[arg-type]
            review_report_sha256=review_report_sha,
            master_manifest_sha256=str(master_binding["manifest_sha256"]),
        )
        _validate_output_row(row, master)
        output_rows.append(row)
        output_split_counts[master.split] += 1
        judgment = row["font_judgment"]
        preferred_counts.update(judgment["preferred"])
        acceptable_counts.update(judgment["acceptable"])
        agreement = row["review_provenance"]["agreement"]
        unanimous += int(agreement["unanimous"])
        corrected += int(not agreement["unanimous"])
        none_count += int(judgment["none_acceptable"])
        full_mask_count += int(not row["partial_candidate_mask"])
        partial_mask_count += int(row["partial_candidate_mask"])

    review_ids = set(item_by_id)
    master_only_ids = sorted(set(master_rows) - review_ids)
    review_split_counts = Counter(item.split for item in items)
    master_split_counts = Counter(value.split for value in master_rows.values())
    decision_descriptors = [
        {
            "byte_size": source.byte_size,
            "file_name": source.path.name,
            "record_count": source.record_count,
            "sha256": source.sha256,
            "source_index": index,
        }
        for index, source in enumerate(decision_sources, 1)
    ]
    bindings = {
        "decision_sources": decision_descriptors,
        "master_v3": dict(master_binding),
        "review_bundle": {
            "record_count": len(items),
            "report_record_sha256": review_report.get("record_sha256"),
            "report_sha256": review_report_sha,
        },
    }
    stats = {
        "acceptable_font_counts": dict(sorted(acceptable_counts.items())),
        "completed_decision_count": len(decisions),
        "correction_row_count": corrected,
        "full_candidate_mask_rows": full_mask_count,
        "master_only_unreviewed_count": len(master_only_ids),
        "master_only_unreviewed_sample_ids": master_only_ids,
        "master_split_counts": dict(sorted(master_split_counts.items())),
        "none_acceptable_rows": none_count,
        "omitted_test_count": len(omitted_test_ids),
        "output_record_count": len(output_rows),
        "output_split_counts": dict(sorted(output_split_counts.items())),
        "partial_candidate_mask_rows": partial_mask_count,
        "preferred_font_counts": dict(sorted(preferred_counts.items())),
        "review_item_count": len(items),
        "review_split_counts": dict(sorted(review_split_counts.items())),
        "stale_review_item_count": len(stale_item_ids),
        "stale_review_sample_ids": sorted(stale_item_ids),
        "training_eligible_rows": output_split_counts["train"],
        "unanimous_row_count": unanimous,
        "validation_rows": output_split_counts["val"],
    }
    checks = {
        "active_candidate_count": len(ACTIVE_CANDIDATE_IDS),
        "all_three_passes_completed": True,
        "conflicting_decision_rows": 0,
        "gugi_output_occurrences": 0,
        "master_common_identity_rows_verified": len(review_ids & set(master_rows)),
        "master_v3_identity_fields": [
            "split",
            "work_id",
            "chapter_id",
            "page_id",
            "source_page_sha256",
        ],
        "pseudo_direct_promotion_used": False,
        "retired_font_id": RETIRED_FONT_ID,
        "test_rows_in_output": 0,
        "test_rows_training_eligible": 0,
        "unknown_font_occurrences": 0,
    }
    return PreparedOverlay(tuple(output_rows), bindings, stats, checks)


def _overlay_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return b"".join(
        (review.canonical_json(row) + "\n").encode("utf-8") for row in rows
    )


def _artifact(path: Path, *, record_count: int | None = None) -> dict[str, Any]:
    output: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": review.sha256_file(path),
    }
    if record_count is not None:
        output["record_count"] = record_count
    return output


def _manifest_and_report(
    prepared: PreparedOverlay, overlay_artifact: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = review.seal_record(
        {
            "active_candidate_ids": list(ACTIVE_CANDIDATE_IDS),
            "artifacts": {OVERLAY_FILE: dict(overlay_artifact)},
            "bindings": copy.deepcopy(dict(prepared.bindings)),
            "policy": {
                "cross_pass_disagreement_is_preserved_as_correction_history": True,
                "direct_pseudo_promotion_allowed": False,
                "incomplete_decision_promotion_allowed": False,
                "partial_candidate_masks_supported": True,
                "test_split_training_promotion_forbidden": True,
            },
            "record_type": MANIFEST_TYPE,
            "retired_font_ids": [RETIRED_FONT_ID],
            "schema_version": SCHEMA_VERSION,
            "stats": copy.deepcopy(dict(prepared.stats)),
        }
    )
    report = review.seal_record(
        {
            "artifacts": {OVERLAY_FILE: dict(overlay_artifact)},
            "bindings": copy.deepcopy(dict(prepared.bindings)),
            "checks": copy.deepcopy(dict(prepared.checks)),
            "record_type": REPORT_TYPE,
            "schema_version": SCHEMA_VERSION,
            "stats": copy.deepcopy(dict(prepared.stats)),
            "status": "ready_for_active21_masked_supervision",
        }
    )
    return manifest, report


def build_overlay(
    *,
    review_dir: Path,
    master_manifest: Path,
    decision_paths: Sequence[Path],
    output_dir: Path,
) -> Mapping[str, Any]:
    prepared = prepare_overlay(
        review_dir=review_dir,
        master_manifest=master_manifest,
        decision_paths=decision_paths,
    )
    output = output_dir.expanduser().resolve()
    if output.exists():
        raise FastReviewFinalizationError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        (staging / OVERLAY_FILE).write_bytes(_overlay_bytes(prepared.rows))
        overlay_artifact = _artifact(
            staging / OVERLAY_FILE, record_count=len(prepared.rows)
        )
        manifest, report_data = _manifest_and_report(prepared, overlay_artifact)
        (staging / MANIFEST_FILE).write_bytes(review.json_bytes(manifest, pretty=True))
        (staging / REPORT_FILE).write_bytes(review.json_bytes(report_data, pretty=True))
        marker = {
            "artifacts": {
                name: review.sha256_file(staging / name)
                for name in (OVERLAY_FILE, MANIFEST_FILE, REPORT_FILE)
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(review.json_bytes(marker, pretty=True))
        _validate_overlay_prepared(staging, prepared)
        if output.exists():
            raise FastReviewFinalizationError("output directory appeared during build")
        os.rename(staging, output)
        published = True
        return validate_overlay(
            output_dir=output,
            review_dir=review_dir,
            master_manifest=master_manifest,
            decision_paths=decision_paths,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def _validate_overlay_prepared(
    output_dir: Path, prepared: PreparedOverlay
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise FastReviewFinalizationError("overlay output is missing or linked")
    actual_files = {path.name for path in root.iterdir() if path.is_file()}
    if actual_files != OUTPUT_FILES or any(path.is_dir() for path in root.iterdir()):
        raise FastReviewFinalizationError("overlay exact inventory drifted")
    if any((root / name).is_symlink() for name in OUTPUT_FILES):
        raise FastReviewFinalizationError("overlay contains a linked artifact")
    try:
        marker = json.loads((root / MARKER_FILE).read_text(encoding="utf-8-sig"))
        manifest = json.loads((root / MANIFEST_FILE).read_text(encoding="utf-8-sig"))
        report_data = json.loads((root / REPORT_FILE).read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FastReviewFinalizationError(f"invalid overlay metadata: {error}") from error
    marker = _mapping(marker, "overlay marker")
    manifest = _mapping(manifest, "overlay manifest")
    report_data = _mapping(report_data, "overlay report")
    review.validate_record_seal(manifest, location="overlay manifest")
    review.validate_record_seal(report_data, location="overlay report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
    ):
        raise FastReviewFinalizationError("overlay marker drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "overlay marker.artifacts")
    for name in (OVERLAY_FILE, MANIFEST_FILE, REPORT_FILE):
        if marker_artifacts.get(name) != review.sha256_file(root / name):
            raise FastReviewFinalizationError(f"overlay hash drifted: {name}")
    overlay_artifact = _artifact(
        root / OVERLAY_FILE, record_count=len(prepared.rows)
    )
    expected_manifest, expected_report = _manifest_and_report(prepared, overlay_artifact)
    if manifest != expected_manifest or report_data != expected_report:
        raise FastReviewFinalizationError("overlay manifest/report source binding drifted")
    sentinel = object()
    actual_rows = (row for _, row in _iter_jsonl(root / OVERLAY_FILE, "overlay rows"))
    for index, (actual, expected) in enumerate(
        zip_longest(actual_rows, prepared.rows, fillvalue=sentinel), 1
    ):
        if actual is sentinel or expected is sentinel or actual != expected:
            raise FastReviewFinalizationError(f"overlay row {index} drifted")
    return {
        "active_candidate_count": len(ACTIVE_CANDIDATE_IDS),
        "output_dir": str(root),
        "partial_candidate_mask_rows": prepared.stats["partial_candidate_mask_rows"],
        "record_count": len(prepared.rows),
        "status": "ready_for_active21_masked_supervision",
        "training_eligible_rows": prepared.stats["training_eligible_rows"],
        "validation_rows": prepared.stats["validation_rows"],
    }


def validate_overlay(
    *,
    output_dir: Path,
    review_dir: Path,
    master_manifest: Path,
    decision_paths: Sequence[Path],
) -> Mapping[str, Any]:
    prepared = prepare_overlay(
        review_dir=review_dir,
        master_manifest=master_manifest,
        decision_paths=decision_paths,
    )
    return _validate_overlay_prepared(output_dir, prepared)


def collect_decision_paths(
    *, decision_jsonl: Sequence[Path], decision_dirs: Sequence[Path]
) -> tuple[Path, ...]:
    output = [path.expanduser().resolve() for path in decision_jsonl]
    for raw_dir in decision_dirs:
        root = raw_dir.expanduser().resolve()
        if root.is_symlink() or not root.is_dir():
            raise FastReviewFinalizationError(f"decision directory is missing or linked: {root}")
        output.extend(path.resolve() for path in root.rglob("*.jsonl"))
    return tuple(sorted(set(output), key=str))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("build", "validate"):
        target = subparsers.add_parser(command)
        target.add_argument("--review-dir", type=Path, required=True)
        target.add_argument("--master-manifest", type=Path, required=True)
        target.add_argument("--decision-jsonl", type=Path, action="append", default=[])
        target.add_argument("--decisions-dir", type=Path, action="append", default=[])
        target.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        decision_paths = collect_decision_paths(
            decision_jsonl=args.decision_jsonl,
            decision_dirs=args.decisions_dir,
        )
        result = (
            build_overlay(
                review_dir=args.review_dir,
                master_manifest=args.master_manifest,
                decision_paths=decision_paths,
                output_dir=args.output_dir,
            )
            if args.command == "build"
            else validate_overlay(
                output_dir=args.output_dir,
                review_dir=args.review_dir,
                master_manifest=args.master_manifest,
                decision_paths=decision_paths,
            )
        )
    except (FastReviewFinalizationError, OSError, ValueError) as error:
        raise SystemExit(f"fast-review-finalizer error: {error}") from error
    print(review.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
