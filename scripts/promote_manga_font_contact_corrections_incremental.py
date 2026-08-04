#!/usr/bin/env python3
"""Incrementally promote completed contact-sheet corrections to active21 gold.

The source contact bundle stays sealed and pseudo-only.  A reviewer edits a
copy of ``correction-index.csv`` or ``correction-index.jsonl``.  This tool
verifies every immutable cell against the sealed source, promotes only rows
with a non-empty verdict, and leaves untouched rows in a priority-preserving
remaining index.  Test rows, stale rows, Gugi positives, unknown fonts,
duplicates, and contradictory correction fields fail closed.
"""

from __future__ import annotations

import argparse
import copy
import csv
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
from pathlib import Path
from typing import Any

try:
    from scripts import build_font_pseudolabel_contact_sheets as contacts
    from scripts import finalize_manga_font_fast_review_overlay_v1 as finalizer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_pseudolabel_contact_sheets as contacts
    import finalize_manga_font_fast_review_overlay_v1 as finalizer


SCHEMA_VERSION = "manga-font-contact-corrections-incremental-v1"
ROW_TYPE = "manga_font_contact_correction_supervised_row"
REMAINING_TYPE = "manga_font_contact_correction_remaining_row"
MANIFEST_TYPE = "manga_font_contact_correction_incremental_manifest"
REPORT_TYPE = "manga_font_contact_correction_incremental_report"
OWNER = "carrot-manga-translator/manga-font-contact-corrections-incremental-v1"
MARKER_FILE = ".manga-font-contact-corrections-incremental-v1-owned.json"
OVERLAY_FILE = "supervised-overlay.jsonl"
REMAINING_JSONL_FILE = "remaining-index.jsonl"
REMAINING_CSV_FILE = "remaining-index.csv"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset(
    {
        MARKER_FILE,
        OVERLAY_FILE,
        REMAINING_JSONL_FILE,
        REMAINING_CSV_FILE,
        MANIFEST_FILE,
        REPORT_FILE,
    }
)
ACTIVE_CANDIDATE_IDS = finalizer.ACTIVE_CANDIDATE_IDS
FULL_CANDIDATE_IDS = finalizer.FULL_CANDIDATE_IDS
RETIRED_FONT_ID = finalizer.RETIRED_FONT_ID
JUDGMENT_TIERS = finalizer.JUDGMENT_TIERS
VERDICTS = frozenset({"accept", "correct", "reject", "none"})
LIST_SPLIT_RE = re.compile(r"[|;,]")
CORRECTION_BASE_FIELDS = frozenset(
    {"corrected_family", "corrected_font_id", "notes", "verdict"}
)
CORRECTION_EXTENSION_FIELDS = frozenset(
    {
        "acceptable_font_ids",
        "confidence",
        "correction_round",
        "none_acceptable",
        "preferred_font_id",
        "reviewed_at",
        "reviewed_font_ids",
        "reviewer",
    }
)
CSV_EXTENSION_FIELDS = tuple(sorted(CORRECTION_EXTENSION_FIELDS))
REMAINING_CSV_FIELDS = (
    "remaining_order",
    "review_order",
    "font_review_order",
    "sheet_file",
    "sheet_cell",
    "sample_id",
    "predicted_font_id",
    "predicted_family",
    "review_priority_score",
    "confidence",
    "split",
    "work_id",
    "chapter_id",
    "page_id",
    "source_page_sha256",
    "source_category",
    "status",
    "base_index_record_sha256",
    "verdict",
    "corrected_font_id",
    "corrected_family",
    "acceptable_font_ids",
    "reviewed_font_ids",
    "none_acceptable",
    "notes",
)


class IncrementalContactCorrectionError(contacts.ContactSheetError):
    """Raised when a correction cannot safely become human supervision."""


@dataclass(frozen=True)
class BaseIndexRow:
    sample_id: str
    record: Mapping[str, Any]
    record_sha256: str
    review_order: int


@dataclass(frozen=True)
class CorrectionInput:
    sample_id: str
    verdict: str
    corrected_font_id: str
    corrected_family: str
    preferred_font_id: str
    acceptable_font_ids: tuple[str, ...]
    reviewed_font_ids: tuple[str, ...]
    none_acceptable: bool | None
    notes: str
    reviewer: str
    reviewed_at: str
    confidence: float | None
    correction_round: int | None
    source_row_sha256: str


@dataclass(frozen=True)
class HumanDecision:
    verdict: str
    preferred_font_id: str | None
    acceptable_font_ids: tuple[str, ...]
    reviewed_font_ids: tuple[str, ...]
    none_acceptable: bool
    notes: str
    reviewer: str
    reviewed_at: str
    confidence: float
    correction_round: int
    source_row_sha256: str


@dataclass(frozen=True)
class PreparedIncremental:
    overlay_rows: tuple[dict[str, Any], ...]
    remaining_rows: tuple[dict[str, Any], ...]
    bindings: Mapping[str, Any]
    stats: Mapping[str, Any]
    checks: Mapping[str, Any]


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise IncrementalContactCorrectionError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise IncrementalContactCorrectionError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise IncrementalContactCorrectionError(f"{location}: expected text")
    return result


def _string(value: Any, location: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise IncrementalContactCorrectionError(f"{location}: expected text")
    return value.strip()


def _parse_timestamp(value: str, location: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise IncrementalContactCorrectionError(f"{location}: invalid ISO timestamp") from error
    if parsed.tzinfo is None:
        raise IncrementalContactCorrectionError(f"{location}: timezone required")
    return value


def _parse_bool(value: Any, location: str) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    raise IncrementalContactCorrectionError(f"{location}: expected boolean or blank")


def _parse_float(value: Any, location: str) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise IncrementalContactCorrectionError(f"{location}: invalid number")
    try:
        output = float(value)
    except (TypeError, ValueError) as error:
        raise IncrementalContactCorrectionError(f"{location}: invalid number") from error
    if not math.isfinite(output) or not 0.0 <= output <= 1.0:
        raise IncrementalContactCorrectionError(f"{location}: outside [0,1]")
    return output


def _parse_round(value: Any, location: str) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise IncrementalContactCorrectionError(f"{location}: invalid round")
    try:
        output = int(value)
    except (TypeError, ValueError) as error:
        raise IncrementalContactCorrectionError(f"{location}: invalid round") from error
    if output < 1 or str(output) != str(value).strip():
        raise IncrementalContactCorrectionError(f"{location}: invalid round")
    return output


def _parse_font_ids(value: Any, location: str) -> tuple[str, ...]:
    if value is None or value == "":
        return ()
    if isinstance(value, list):
        output = tuple(_text(item, f"{location}[{index}]") for index, item in enumerate(value))
    elif isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return ()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise IncrementalContactCorrectionError(f"{location}: invalid JSON list") from error
            return _parse_font_ids(parsed, location)
        output = tuple(part.strip() for part in LIST_SPLIT_RE.split(stripped) if part.strip())
    else:
        raise IncrementalContactCorrectionError(f"{location}: expected font list")
    if len(output) != len(set(output)):
        raise IncrementalContactCorrectionError(f"{location}: duplicate font")
    return output


def _canonical_digest(value: Mapping[str, Any]) -> str:
    return contacts.sha256_bytes(contacts.canonical_json(value).encode("utf-8"))


def _load_contact_bundle(
    contact_bundle: Path,
) -> tuple[tuple[BaseIndexRow, ...], Mapping[str, Any], Mapping[str, Any]]:
    root = contact_bundle.expanduser().resolve()
    try:
        validation = contacts.validate_bundle(root)
        report = contacts.read_json(root / contacts.REPORT_FILE, location="contact report")
    except contacts.ContactSheetError as error:
        raise IncrementalContactCorrectionError(f"contact bundle: {error}") from error
    rows: list[BaseIndexRow] = []
    seen: set[str] = set()
    for line_number, record in contacts.iter_jsonl(
        root / contacts.INDEX_JSONL_FILE, location="base correction index"
    ):
        location = f"base correction index:{line_number}"
        contacts.validate_record_seal(record, location=location)
        correction = _mapping(record.get("correction"), f"{location}.correction")
        if set(correction) != CORRECTION_BASE_FIELDS or any(
            correction[field] != "" for field in CORRECTION_BASE_FIELDS
        ):
            raise IncrementalContactCorrectionError(
                f"{location}: source bundle is not a blank correction template"
            )
        if (
            record.get("schema_version") != contacts.INDEX_SCHEMA_VERSION
            or record.get("label_authority") != "pseudo_not_gold"
            or record.get("training_eligible") is not False
        ):
            raise IncrementalContactCorrectionError(f"{location}: pseudo boundary drifted")
        sample_id = _text(record.get("sample_id"), f"{location}.sample_id")
        if sample_id in seen:
            raise IncrementalContactCorrectionError(f"{location}: duplicate sample")
        seen.add(sample_id)
        review_order = record.get("review_order")
        if isinstance(review_order, bool) or not isinstance(review_order, int) or review_order < 1:
            raise IncrementalContactCorrectionError(f"{location}: invalid review order")
        rows.append(
            BaseIndexRow(
                sample_id=sample_id,
                record=copy.deepcopy(record),
                record_sha256=_text(record.get("record_sha256"), f"{location}.record_sha256"),
                review_order=review_order,
            )
        )
    rows.sort(key=lambda value: (value.review_order, value.sample_id))
    if [row.review_order for row in rows] != list(range(1, len(rows) + 1)):
        raise IncrementalContactCorrectionError("base review order is incomplete")
    return tuple(rows), report, {
        "contact_bundle_report_sha256": contacts.sha256_file(root / contacts.REPORT_FILE),
        "contact_index_jsonl_sha256": contacts.sha256_file(root / contacts.INDEX_JSONL_FILE),
        "contact_index_csv_sha256": contacts.sha256_file(root / contacts.INDEX_CSV_FILE),
        "record_count": validation["record_count"],
    }


def _correction_input(
    *, sample_id: str, values: Mapping[str, Any], source_row_sha256: str, location: str
) -> CorrectionInput:
    verdict = _string(values.get("verdict"), f"{location}.verdict").lower()
    if verdict and verdict not in VERDICTS:
        raise IncrementalContactCorrectionError(f"{location}: unknown verdict {verdict!r}")
    return CorrectionInput(
        sample_id=sample_id,
        verdict=verdict,
        corrected_font_id=_string(
            values.get("corrected_font_id"), f"{location}.corrected_font_id"
        ),
        corrected_family=_string(
            values.get("corrected_family"), f"{location}.corrected_family"
        ),
        preferred_font_id=_string(
            values.get("preferred_font_id"), f"{location}.preferred_font_id"
        ),
        acceptable_font_ids=_parse_font_ids(
            values.get("acceptable_font_ids"), f"{location}.acceptable_font_ids"
        ),
        reviewed_font_ids=_parse_font_ids(
            values.get("reviewed_font_ids"), f"{location}.reviewed_font_ids"
        ),
        none_acceptable=_parse_bool(
            values.get("none_acceptable"), f"{location}.none_acceptable"
        ),
        notes=_string(values.get("notes"), f"{location}.notes"),
        reviewer=_string(values.get("reviewer"), f"{location}.reviewer"),
        reviewed_at=_string(values.get("reviewed_at"), f"{location}.reviewed_at"),
        confidence=_parse_float(values.get("confidence"), f"{location}.confidence"),
        correction_round=_parse_round(
            values.get("correction_round"), f"{location}.correction_round"
        ),
        source_row_sha256=source_row_sha256,
    )


def _csv_expected(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _load_csv_corrections(
    path: Path, base_rows: Sequence[BaseIndexRow]
) -> dict[str, CorrectionInput]:
    base_by_id = {row.sample_id: row for row in base_rows}
    try:
        handle = path.open("r", encoding="utf-8-sig", newline="")
    except OSError as error:
        raise IncrementalContactCorrectionError(f"cannot open correction CSV: {error}") from error
    output: dict[str, CorrectionInput] = {}
    with handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames
        if fields is None or len(fields) != len(set(fields)):
            raise IncrementalContactCorrectionError("correction CSV has invalid headers")
        unknown = set(fields) - set(contacts.CSV_FIELDS) - set(CSV_EXTENSION_FIELDS)
        missing = set(contacts.CSV_FIELDS) - set(fields)
        if unknown or missing:
            raise IncrementalContactCorrectionError(
                f"correction CSV schema drift; missing={sorted(missing)}, unknown={sorted(unknown)}"
            )
        for line_number, row in enumerate(reader, 2):
            location = f"correction CSV:{line_number}"
            if None in row:
                raise IncrementalContactCorrectionError(f"{location}: extra CSV values")
            sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
            base = base_by_id.get(sample_id)
            if base is None or sample_id in output:
                raise IncrementalContactCorrectionError(
                    f"{location}: unknown or duplicate sample {sample_id}"
                )
            expected = contacts._csv_record(base.record)  # noqa: SLF001
            for field in contacts.CSV_FIELDS:
                if field in CORRECTION_BASE_FIELDS:
                    continue
                if row.get(field, "") != _csv_expected(expected[field]):
                    raise IncrementalContactCorrectionError(
                        f"{location}: immutable field drifted: {field}"
                    )
            semantic = {field: row.get(field, "") for field in CORRECTION_BASE_FIELDS}
            semantic.update({field: row.get(field, "") for field in CSV_EXTENSION_FIELDS})
            output[sample_id] = _correction_input(
                sample_id=sample_id,
                values=semantic,
                source_row_sha256=_canonical_digest(dict(row)),
                location=location,
            )
    if set(output) != set(base_by_id):
        raise IncrementalContactCorrectionError("correction CSV coverage is incomplete")
    return output


def _load_jsonl_corrections(
    path: Path, base_rows: Sequence[BaseIndexRow]
) -> dict[str, CorrectionInput]:
    base_by_id = {row.sample_id: row for row in base_rows}
    output: dict[str, CorrectionInput] = {}
    for line_number, row in contacts.iter_jsonl(path, location="correction JSONL"):
        location = f"correction JSONL:{line_number}"
        sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
        base = base_by_id.get(sample_id)
        if base is None or sample_id in output:
            raise IncrementalContactCorrectionError(
                f"{location}: unknown or duplicate sample {sample_id}"
            )
        if set(row) != set(base.record):
            raise IncrementalContactCorrectionError(f"{location}: top-level schema drifted")
        for field, expected in base.record.items():
            if field in {"correction", "record_sha256"}:
                continue
            if row.get(field) != expected:
                raise IncrementalContactCorrectionError(
                    f"{location}: immutable field drifted: {field}"
                )
        if row.get("record_sha256") != base.record_sha256:
            raise IncrementalContactCorrectionError(
                f"{location}: base record binding drifted"
            )
        correction = _mapping(row.get("correction"), f"{location}.correction")
        unknown = set(correction) - CORRECTION_BASE_FIELDS - CORRECTION_EXTENSION_FIELDS
        missing = CORRECTION_BASE_FIELDS - set(correction)
        if unknown or missing:
            raise IncrementalContactCorrectionError(
                f"{location}: correction schema drift; missing={sorted(missing)}, unknown={sorted(unknown)}"
            )
        output[sample_id] = _correction_input(
            sample_id=sample_id,
            values=correction,
            source_row_sha256=_canonical_digest(row),
            location=location,
        )
    if set(output) != set(base_by_id):
        raise IncrementalContactCorrectionError("correction JSONL coverage is incomplete")
    return output


def _load_corrections(
    path_value: Path, base_rows: Sequence[BaseIndexRow]
) -> tuple[dict[str, CorrectionInput], Mapping[str, Any]]:
    path = path_value.expanduser().resolve()
    if path.is_symlink() or not path.is_file():
        raise IncrementalContactCorrectionError("correction input is missing or linked")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        rows = _load_csv_corrections(path, base_rows)
        kind = "csv"
    elif suffix == ".jsonl":
        rows = _load_jsonl_corrections(path, base_rows)
        kind = "jsonl"
    else:
        raise IncrementalContactCorrectionError("corrections must be CSV or JSONL")
    return rows, {
        "byte_size": path.stat().st_size,
        "file_name": path.name,
        "format": kind,
        "record_count": len(rows),
        "sha256": contacts.sha256_file(path),
    }


def _active_order(values: Iterable[str]) -> tuple[str, ...]:
    wanted = set(values)
    return tuple(value for value in ACTIVE_CANDIDATE_IDS if value in wanted)


def _human_decision(
    correction: CorrectionInput,
    base: BaseIndexRow,
    *,
    default_reviewer: str | None,
    default_reviewed_at: str | None,
    default_confidence: float,
) -> HumanDecision | None:
    if not correction.verdict:
        dangling = (
            correction.corrected_font_id,
            correction.corrected_family,
            correction.preferred_font_id,
            correction.acceptable_font_ids,
            correction.reviewed_font_ids,
            correction.none_acceptable,
        )
        if any(value not in {"", (), None} for value in dangling):
            raise IncrementalContactCorrectionError(
                f"{base.sample_id}: correction fields exist without a verdict"
            )
        return None
    prediction = _mapping(base.record.get("prediction"), f"{base.sample_id}.prediction")
    predicted = _text(prediction.get("font_id"), f"{base.sample_id}.predicted_font_id")
    predicted_family = _text(
        prediction.get("family"), f"{base.sample_id}.predicted_family"
    )
    if (
        predicted not in FULL_CANDIDATE_IDS
        or contacts.FONT_FAMILY_BY_ID.get(predicted) != predicted_family
    ):
        raise IncrementalContactCorrectionError(f"{base.sample_id}: unknown predicted font")
    preferred: str | None
    none_acceptable: bool
    if correction.verdict == "accept":
        if correction.corrected_font_id or correction.corrected_family:
            raise IncrementalContactCorrectionError(
                f"{base.sample_id}: accept conflicts with correction fields"
            )
        preferred = correction.preferred_font_id or predicted
        if preferred != predicted:
            raise IncrementalContactCorrectionError(
                f"{base.sample_id}: accept must preserve predicted font"
            )
        none_acceptable = False
    elif correction.verdict == "correct":
        preferred = correction.preferred_font_id or correction.corrected_font_id
        if (
            not correction.corrected_font_id
            or preferred != correction.corrected_font_id
            or correction.corrected_font_id == predicted
        ):
            raise IncrementalContactCorrectionError(
                f"{base.sample_id}: correct requires a different preferred font"
            )
        expected_family = contacts.FONT_FAMILY_BY_ID.get(correction.corrected_font_id)
        if not correction.corrected_family or correction.corrected_family != expected_family:
            raise IncrementalContactCorrectionError(
                f"{base.sample_id}: corrected family does not match font"
            )
        none_acceptable = False
    else:
        if (
            correction.corrected_font_id
            or correction.corrected_family
            or correction.preferred_font_id
            or correction.acceptable_font_ids
        ):
            raise IncrementalContactCorrectionError(
                f"{base.sample_id}: none/reject conflicts with positive fonts"
            )
        preferred = None
        none_acceptable = True
    if correction.none_acceptable is not None and correction.none_acceptable != none_acceptable:
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: verdict and none_acceptable conflict"
        )
    positives = {
        value
        for value in (preferred, *correction.acceptable_font_ids)
        if value is not None
    }
    unknown_positive = positives - set(ACTIVE_CANDIDATE_IDS)
    if unknown_positive:
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: retired Gugi or unknown positive font: {sorted(unknown_positive)}"
        )
    if preferred is not None and preferred in correction.acceptable_font_ids:
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: preferred font duplicated as acceptable"
        )
    if correction.reviewed_font_ids:
        reviewed = correction.reviewed_font_ids
    else:
        defaults = set(positives)
        if predicted in ACTIVE_CANDIDATE_IDS:
            defaults.add(predicted)
        reviewed = _active_order(defaults)
    unknown_reviewed = set(reviewed) - set(ACTIVE_CANDIDATE_IDS)
    if unknown_reviewed:
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: retired Gugi or unknown reviewed font: {sorted(unknown_reviewed)}"
        )
    if not positives <= set(reviewed):
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: positive font is outside reviewed mask"
        )
    reviewer = correction.reviewer or (default_reviewer or "").strip()
    reviewed_at = correction.reviewed_at or (default_reviewed_at or "").strip()
    if not reviewer or not reviewed_at:
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: reviewer and reviewed_at are required for verdict rows"
        )
    reviewed_at = _parse_timestamp(reviewed_at, f"{base.sample_id}.reviewed_at")
    confidence = (
        correction.confidence
        if correction.confidence is not None
        else default_confidence
    )
    if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
        raise IncrementalContactCorrectionError(f"{base.sample_id}: invalid confidence")
    return HumanDecision(
        verdict=correction.verdict,
        preferred_font_id=preferred,
        acceptable_font_ids=_active_order(correction.acceptable_font_ids),
        reviewed_font_ids=_active_order(reviewed),
        none_acceptable=none_acceptable,
        notes=correction.notes,
        reviewer=reviewer,
        reviewed_at=reviewed_at,
        confidence=confidence,
        correction_round=correction.correction_round or 1,
        source_row_sha256=correction.source_row_sha256,
    )


def _base_identity(base: BaseIndexRow) -> tuple[str, str, str, str]:
    source = _mapping(base.record.get("source"), f"{base.sample_id}.source")
    work = _mapping(base.record.get("work"), f"{base.sample_id}.work")
    chapter = _mapping(base.record.get("chapter"), f"{base.sample_id}.chapter")
    page = _mapping(base.record.get("page"), f"{base.sample_id}.page")
    return (
        _text(source.get("split"), f"{base.sample_id}.split"),
        _text(work.get("id"), f"{base.sample_id}.work.id"),
        _text(chapter.get("id"), f"{base.sample_id}.chapter.id"),
        _text(page.get("id"), f"{base.sample_id}.page.id"),
    )


def _verify_master_identity(base: BaseIndexRow, master: finalizer.MasterIdentity) -> None:
    expected = _base_identity(base)
    actual = (master.split, master.work_id, master.chapter_id, master.page_id)
    fields = ("split", "work_id", "chapter_id", "page_id")
    mismatches = [field for field, left, right in zip(fields, expected, actual) if left != right]
    if mismatches:
        raise IncrementalContactCorrectionError(
            f"{base.sample_id}: master-v3 identity mismatch: {mismatches}"
        )


def _decision_judgment(decision: HumanDecision) -> tuple[dict[str, Any], list[bool]]:
    reviewed = set(decision.reviewed_font_ids)
    positives = {
        value
        for value in (decision.preferred_font_id, *decision.acceptable_font_ids)
        if value is not None
    }
    judgment = {
        "acceptable": list(decision.acceptable_font_ids),
        "marginal": [],
        "none_acceptable": decision.none_acceptable,
        "not_reviewed": [value for value in ACTIVE_CANDIDATE_IDS if value not in reviewed],
        "preferred": [decision.preferred_font_id] if decision.preferred_font_id else [],
        "unacceptable": [
            value for value in ACTIVE_CANDIDATE_IDS if value in reviewed and value not in positives
        ],
        "unrenderable": [],
    }
    return judgment, [value in reviewed for value in ACTIVE_CANDIDATE_IDS]


def _correction_event(
    decision: HumanDecision,
    *,
    base: BaseIndexRow,
    corrections_sha256: str,
) -> dict[str, Any]:
    return contacts.seal_record(
        {
            "acceptable_font_ids": list(decision.acceptable_font_ids),
            "base_index_record_sha256": base.record_sha256,
            "confidence": decision.confidence,
            "correction_input_sha256": corrections_sha256,
            "correction_round": decision.correction_round,
            "correction_source_row_sha256": decision.source_row_sha256,
            "none_acceptable": decision.none_acceptable,
            "notes": decision.notes,
            "preferred_font_id": decision.preferred_font_id,
            "reviewed_at": decision.reviewed_at,
            "reviewed_font_ids": list(decision.reviewed_font_ids),
            "reviewer": decision.reviewer,
            "verdict": decision.verdict,
        }
    )


def _event_semantics(event: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        event.get("correction_source_row_sha256"),
        event.get("verdict"),
        event.get("preferred_font_id"),
        tuple(event.get("acceptable_font_ids", ())),
        bool(event.get("none_acceptable")),
        tuple(event.get("reviewed_font_ids", ())),
    )


def _new_overlay_row(
    *,
    base: BaseIndexRow,
    master: finalizer.MasterIdentity,
    decision: HumanDecision,
    corrections_sha256: str,
    contact_report_sha256: str,
    master_manifest_sha256: str,
    previous: Mapping[str, Any] | None,
) -> dict[str, Any]:
    judgment, mask = _decision_judgment(decision)
    event = _correction_event(
        decision, base=base, corrections_sha256=corrections_sha256
    )
    history: list[dict[str, Any]] = []
    if previous is not None:
        history = copy.deepcopy(
            _list(previous.get("correction_history"), f"{base.sample_id}.correction_history")
        )
    if not history or _event_semantics(history[-1]) != _event_semantics(event):
        history.append(event)
    prediction = _mapping(base.record.get("prediction"), f"{base.sample_id}.prediction")
    core = {
        "candidate_ids": list(ACTIVE_CANDIDATE_IDS),
        "candidate_mask": mask,
        "chapter_id": master.chapter_id,
        "correction_history": history,
        "evaluation_eligible": master.split == "val",
        "font_judgment": judgment,
        "label_authority": "completed_human_contact_correction",
        "label_confidence": decision.confidence,
        "latest_correction_source": {
            "correction_input_sha256": corrections_sha256,
            "source_row_sha256": decision.source_row_sha256,
        },
        "master_binding": {
            "line_number": master.line_number,
            "manifest_sha256": master_manifest_sha256,
            "record_sha256": master.record_sha256,
        },
        "page_id": master.page_id,
        "partial_candidate_mask": not all(mask),
        "pseudo_prediction_before_review": {
            "family": prediction.get("family"),
            "font_id": prediction.get("font_id"),
            "retired_font": prediction.get("retired_font"),
        },
        "record_type": ROW_TYPE,
        "review_source": {
            "base_index_record_sha256": base.record_sha256,
            "contact_bundle_report_sha256": contact_report_sha256,
            "font_review_order": base.record.get("font_review_order"),
            "review_order": base.review_order,
            "sheet": copy.deepcopy(base.record.get("sheet")),
        },
        "sample_id": base.sample_id,
        "schema_version": SCHEMA_VERSION,
        "source_page_sha256": master.source_page_sha256,
        "split": master.split,
        "test_split_training_promotion_forbidden": True,
        "training_eligible": master.split == "train",
        "work_balance_weight": master.work_balance_weight,
        "work_id": master.work_id,
    }
    return contacts.seal_record(core)


def _validate_overlay_row(row: Mapping[str, Any], master: finalizer.MasterIdentity) -> None:
    contacts.validate_record_seal(row, location=f"overlay {master.sample_id}")
    if (
        row.get("schema_version") != SCHEMA_VERSION
        or row.get("record_type") != ROW_TYPE
        or row.get("sample_id") != master.sample_id
        or row.get("split") != master.split
        or master.split not in {"train", "val"}
        or row.get("training_eligible") is not (master.split == "train")
        or row.get("evaluation_eligible") is not (master.split == "val")
        or row.get("test_split_training_promotion_forbidden") is not True
        or row.get("label_authority") != "completed_human_contact_correction"
        or tuple(_list(row.get("candidate_ids"), "overlay candidate_ids"))
        != ACTIVE_CANDIDATE_IDS
    ):
        raise IncrementalContactCorrectionError(
            f"{master.sample_id}: supervised boundary drifted"
        )
    mask = _list(row.get("candidate_mask"), "overlay candidate_mask")
    if len(mask) != len(ACTIVE_CANDIDATE_IDS) or any(
        not isinstance(value, bool) for value in mask
    ):
        raise IncrementalContactCorrectionError(f"{master.sample_id}: invalid mask")
    judgment = _mapping(row.get("font_judgment"), "overlay judgment")
    if set(judgment) != set(JUDGMENT_TIERS) | {"none_acceptable"}:
        raise IncrementalContactCorrectionError(f"{master.sample_id}: judgment schema drifted")
    tiers = {tier: tuple(_list(judgment.get(tier), tier)) for tier in JUDGMENT_TIERS}
    flat = tuple(value for tier in JUDGMENT_TIERS for value in tiers[tier])
    if len(flat) != len(set(flat)) or set(flat) != set(ACTIVE_CANDIDATE_IDS):
        raise IncrementalContactCorrectionError(
            f"{master.sample_id}: judgment does not partition active21"
        )
    if RETIRED_FONT_ID in flat:
        raise IncrementalContactCorrectionError(f"{master.sample_id}: Gugi leaked")
    reviewed = set(ACTIVE_CANDIDATE_IDS) - set(tiers["not_reviewed"])
    if mask != [value in reviewed for value in ACTIVE_CANDIDATE_IDS]:
        raise IncrementalContactCorrectionError(f"{master.sample_id}: mask drifted")
    positives = (*tiers["preferred"], *tiers["acceptable"])
    none_acceptable = judgment.get("none_acceptable")
    if (
        not isinstance(none_acceptable, bool)
        or none_acceptable == bool(positives)
        or (not none_acceptable and len(tiers["preferred"]) != 1)
    ):
        raise IncrementalContactCorrectionError(
            f"{master.sample_id}: preferred/none semantics drifted"
        )
    history = _list(row.get("correction_history"), "correction history")
    if not history:
        raise IncrementalContactCorrectionError(f"{master.sample_id}: empty history")
    for index, event in enumerate(history, 1):
        contacts.validate_record_seal(
            _mapping(event, f"history[{index}]"), location=f"history[{index}]"
        )


def _load_previous(
    previous_dir: Path | None,
    *,
    contact_report_sha256: str,
    master_manifest_sha256: str,
) -> tuple[dict[str, dict[str, Any]], Mapping[str, Any] | None]:
    if previous_dir is None:
        return {}, None
    root = previous_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise IncrementalContactCorrectionError("previous output is missing or linked")
    if {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise IncrementalContactCorrectionError("previous output inventory drifted")
    marker = contacts.read_json(root / MARKER_FILE, location="previous marker")
    manifest = contacts.read_json(root / MANIFEST_FILE, location="previous manifest")
    report = contacts.read_json(root / REPORT_FILE, location="previous report")
    contacts.validate_record_seal(manifest, location="previous manifest")
    contacts.validate_record_seal(report, location="previous report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise IncrementalContactCorrectionError("previous marker drifted")
    artifacts = _mapping(marker.get("artifacts"), "previous marker.artifacts")
    for name in OUTPUT_FILES - {MARKER_FILE}:
        if artifacts.get(name) != contacts.sha256_file(root / name):
            raise IncrementalContactCorrectionError(f"previous hash drifted: {name}")
    bindings = _mapping(manifest.get("bindings"), "previous manifest.bindings")
    if (
        _mapping(bindings.get("contact_bundle"), "previous contact binding").get(
            "contact_bundle_report_sha256"
        )
        != contact_report_sha256
        or _mapping(bindings.get("master_v3"), "previous master binding").get(
            "manifest_sha256"
        )
        != master_manifest_sha256
    ):
        raise IncrementalContactCorrectionError("previous source binding drifted")
    rows: dict[str, dict[str, Any]] = {}
    for line_number, row in contacts.iter_jsonl(
        root / OVERLAY_FILE, location="previous overlay"
    ):
        sample_id = _text(row.get("sample_id"), f"previous overlay:{line_number}.sample_id")
        if sample_id in rows:
            raise IncrementalContactCorrectionError("previous overlay duplicate")
        contacts.validate_record_seal(row, location=f"previous overlay:{line_number}")
        rows[sample_id] = row
    return rows, {
        "output_manifest_sha256": contacts.sha256_file(root / MANIFEST_FILE),
        "output_overlay_sha256": contacts.sha256_file(root / OVERLAY_FILE),
        "record_count": len(rows),
    }


def _remaining_row(
    *,
    remaining_order: int,
    base: BaseIndexRow,
    master: finalizer.MasterIdentity,
) -> dict[str, Any]:
    audit = _mapping(base.record.get("audit"), f"{base.sample_id}.audit")
    source = _mapping(base.record.get("source"), f"{base.sample_id}.source")
    return contacts.seal_record(
        {
            "audit": copy.deepcopy(audit),
            "base_index_record_sha256": base.record_sha256,
            "chapter_id": master.chapter_id,
            "font_review_order": base.record.get("font_review_order"),
            "master_binding": {
                "line_number": master.line_number,
                "record_sha256": master.record_sha256,
            },
            "page_id": master.page_id,
            "prediction": copy.deepcopy(base.record.get("prediction")),
            "record_type": REMAINING_TYPE,
            "remaining_order": remaining_order,
            "review_order": base.review_order,
            "sample_id": base.sample_id,
            "schema_version": SCHEMA_VERSION,
            "sheet": copy.deepcopy(base.record.get("sheet")),
            "source_category": source.get("category"),
            "source_page_sha256": master.source_page_sha256,
            "split": master.split,
            "status": "pending_contact_verdict",
            "work_id": master.work_id,
        }
    )


def _remaining_csv_row(row: Mapping[str, Any]) -> dict[str, Any]:
    audit = _mapping(row.get("audit"), "remaining audit")
    prediction = _mapping(row.get("prediction"), "remaining prediction")
    sheet = _mapping(row.get("sheet"), "remaining sheet")
    return {
        "remaining_order": row["remaining_order"],
        "review_order": row["review_order"],
        "font_review_order": row["font_review_order"],
        "sheet_file": sheet["file"],
        "sheet_cell": sheet["cell"],
        "sample_id": row["sample_id"],
        "predicted_font_id": prediction["font_id"],
        "predicted_family": prediction["family"],
        "review_priority_score": audit["review_priority_score"],
        "confidence": audit["confidence"],
        "split": row["split"],
        "work_id": row["work_id"],
        "chapter_id": row["chapter_id"],
        "page_id": row["page_id"],
        "source_page_sha256": row["source_page_sha256"],
        "source_category": row["source_category"],
        "status": row["status"],
        "base_index_record_sha256": row["base_index_record_sha256"],
        "verdict": "",
        "corrected_font_id": "",
        "corrected_family": "",
        "acceptable_font_ids": "",
        "reviewed_font_ids": "",
        "none_acceptable": "",
        "notes": "",
    }


def prepare_incremental(
    *,
    contact_bundle: Path,
    corrections_path: Path,
    master_manifest: Path,
    default_reviewer: str | None = None,
    default_reviewed_at: str | None = None,
    default_confidence: float = 0.9,
    previous_output_dir: Path | None = None,
) -> PreparedIncremental:
    if not math.isfinite(default_confidence) or not 0.0 <= default_confidence <= 1.0:
        raise IncrementalContactCorrectionError("default confidence is outside [0,1]")
    base_rows, contact_report, contact_binding = _load_contact_bundle(contact_bundle)
    corrections, correction_binding = _load_corrections(corrections_path, base_rows)
    try:
        master_rows, master_binding = finalizer._load_master(master_manifest)  # noqa: SLF001
    except finalizer.FastReviewFinalizationError as error:
        raise IncrementalContactCorrectionError(f"master-v3: {error}") from error
    previous, previous_binding = _load_previous(
        previous_output_dir,
        contact_report_sha256=str(contact_binding["contact_bundle_report_sha256"]),
        master_manifest_sha256=str(master_binding["manifest_sha256"]),
    )
    base_by_id = {row.sample_id: row for row in base_rows}
    if not set(previous) <= set(base_by_id):
        raise IncrementalContactCorrectionError("previous overlay escaped contact index")

    overlay_by_id: dict[str, dict[str, Any]] = {}
    stale_ids: list[str] = []
    test_ids: list[str] = []
    verdict_counts: Counter[str] = Counter()
    new_promotions = 0
    updated_promotions = 0
    carried_promotions = 0
    for base in base_rows:
        correction = corrections[base.sample_id]
        decision = _human_decision(
            correction,
            base,
            default_reviewer=default_reviewer,
            default_reviewed_at=default_reviewed_at,
            default_confidence=default_confidence,
        )
        master = master_rows.get(base.sample_id)
        if master is None:
            if decision is not None or base.sample_id in previous:
                raise IncrementalContactCorrectionError(
                    f"{base.sample_id}: completed verdict targets a stale master row"
                )
            stale_ids.append(base.sample_id)
            continue
        _verify_master_identity(base, master)
        if master.split == "test":
            if decision is not None or base.sample_id in previous:
                raise IncrementalContactCorrectionError(
                    f"{base.sample_id}: test verdict promotion is forbidden"
                )
            test_ids.append(base.sample_id)
            continue
        old = previous.get(base.sample_id)
        if decision is None:
            if old is not None:
                _validate_overlay_row(old, master)
                overlay_by_id[base.sample_id] = old
                carried_promotions += 1
            continue
        verdict_counts[decision.verdict] += 1
        row = _new_overlay_row(
            base=base,
            master=master,
            decision=decision,
            corrections_sha256=str(correction_binding["sha256"]),
            contact_report_sha256=str(contact_binding["contact_bundle_report_sha256"]),
            master_manifest_sha256=str(master_binding["manifest_sha256"]),
            previous=old,
        )
        _validate_overlay_row(row, master)
        overlay_by_id[base.sample_id] = row
        if old is None:
            new_promotions += 1
        else:
            updated_promotions += 1

    output_rows = tuple(
        overlay_by_id[row.sample_id]
        for row in base_rows
        if row.sample_id in overlay_by_id
    )
    remaining_rows_list: list[dict[str, Any]] = []
    for base in base_rows:
        master = master_rows.get(base.sample_id)
        if (
            master is None
            or master.split == "test"
            or base.sample_id in overlay_by_id
        ):
            continue
        remaining_rows_list.append(
            _remaining_row(
                remaining_order=len(remaining_rows_list) + 1,
                base=base,
                master=master,
            )
        )
    remaining_rows = tuple(remaining_rows_list)
    master_only_ids = sorted(set(master_rows) - set(base_by_id))
    split_counts = Counter(row["split"] for row in output_rows)
    remaining_split_counts = Counter(row["split"] for row in remaining_rows)
    history_depths = [len(row["correction_history"]) for row in output_rows]
    bindings = {
        "contact_bundle": dict(contact_binding),
        "contact_report_record_sha256": contact_report.get("record_sha256"),
        "corrections": dict(correction_binding),
        "master_v3": dict(master_binding),
        "previous_output": copy.deepcopy(previous_binding),
    }
    stats = {
        "carried_previous_promotions": carried_promotions,
        "contact_index_rows": len(base_rows),
        "correction_history_max_depth": max(history_depths, default=0),
        "current_nonempty_verdict_rows": sum(verdict_counts.values()),
        "master_only_unreviewed_count": len(master_only_ids),
        "master_only_unreviewed_sample_ids": master_only_ids,
        "new_promotions": new_promotions,
        "output_record_count": len(output_rows),
        "output_split_counts": dict(sorted(split_counts.items())),
        "remaining_record_count": len(remaining_rows),
        "remaining_split_counts": dict(sorted(remaining_split_counts.items())),
        "stale_contact_rows": len(stale_ids),
        "stale_contact_sample_ids": sorted(stale_ids),
        "test_rows_excluded": len(test_ids),
        "training_eligible_rows": split_counts["train"],
        "updated_promotions": updated_promotions,
        "validation_rows": split_counts["val"],
        "verdict_counts": dict(sorted(verdict_counts.items())),
    }
    checks = {
        "active_candidate_count": len(ACTIVE_CANDIDATE_IDS),
        "blank_verdicts_promoted": 0,
        "duplicate_rows": 0,
        "fake_gold_from_pseudo": False,
        "gemma_influence": False,
        "gugi_positive_rows": 0,
        "master_identity_fields": [
            "split",
            "work_id",
            "chapter_id",
            "page_id",
            "source_page_sha256",
            "master_record_sha256",
        ],
        "partial_candidate_masks_supported": True,
        "test_rows_in_output": 0,
        "test_rows_training_eligible": 0,
        "unknown_font_rows": 0,
    }
    return PreparedIncremental(output_rows, remaining_rows, bindings, stats, checks)


def _jsonl_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return b"".join(
        (contacts.canonical_json(row) + "\n").encode("utf-8") for row in rows
    )


def _write_remaining_csv(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=REMAINING_CSV_FIELDS, extrasaction="raise")
        writer.writeheader()
        writer.writerows(_remaining_csv_row(row) for row in rows)


def _artifact(path: Path, *, record_count: int | None = None) -> dict[str, Any]:
    output: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": contacts.sha256_file(path),
    }
    if record_count is not None:
        output["record_count"] = record_count
    return output


def _metadata(
    prepared: PreparedIncremental, artifacts: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = contacts.seal_record(
        {
            "active_candidate_ids": list(ACTIVE_CANDIDATE_IDS),
            "artifacts": copy.deepcopy(dict(artifacts)),
            "bindings": copy.deepcopy(dict(prepared.bindings)),
            "policy": {
                "blank_verdict_remains_pseudo": True,
                "completed_verdict_required_for_gold": True,
                "incremental_partial_promotion": True,
                "test_split_training_promotion_forbidden": True,
            },
            "record_type": MANIFEST_TYPE,
            "retired_font_ids": [RETIRED_FONT_ID],
            "schema_version": SCHEMA_VERSION,
            "stats": copy.deepcopy(dict(prepared.stats)),
        }
    )
    report = contacts.seal_record(
        {
            "artifacts": copy.deepcopy(dict(artifacts)),
            "bindings": copy.deepcopy(dict(prepared.bindings)),
            "checks": copy.deepcopy(dict(prepared.checks)),
            "record_type": REPORT_TYPE,
            "schema_version": SCHEMA_VERSION,
            "stats": copy.deepcopy(dict(prepared.stats)),
            "status": "ready_for_incremental_active21_supervision",
        }
    )
    return manifest, report


def _validate_prepared(root_value: Path, prepared: PreparedIncremental) -> Mapping[str, Any]:
    root = root_value.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise IncrementalContactCorrectionError("incremental output inventory drifted")
    if any((root / name).is_symlink() for name in OUTPUT_FILES):
        raise IncrementalContactCorrectionError("incremental output contains links")
    marker = contacts.read_json(root / MARKER_FILE, location="incremental marker")
    manifest = contacts.read_json(root / MANIFEST_FILE, location="incremental manifest")
    report = contacts.read_json(root / REPORT_FILE, location="incremental report")
    contacts.validate_record_seal(manifest, location="incremental manifest")
    contacts.validate_record_seal(report, location="incremental report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
    ):
        raise IncrementalContactCorrectionError("incremental marker drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "incremental marker.artifacts")
    for name in OUTPUT_FILES - {MARKER_FILE}:
        if marker_artifacts.get(name) != contacts.sha256_file(root / name):
            raise IncrementalContactCorrectionError(f"incremental hash drifted: {name}")
    artifacts = {
        OVERLAY_FILE: _artifact(
            root / OVERLAY_FILE, record_count=len(prepared.overlay_rows)
        ),
        REMAINING_JSONL_FILE: _artifact(
            root / REMAINING_JSONL_FILE, record_count=len(prepared.remaining_rows)
        ),
        REMAINING_CSV_FILE: _artifact(
            root / REMAINING_CSV_FILE, record_count=len(prepared.remaining_rows)
        ),
    }
    expected_manifest, expected_report = _metadata(prepared, artifacts)
    if manifest != expected_manifest or report != expected_report:
        raise IncrementalContactCorrectionError("incremental metadata drifted")
    sentinel = object()
    for file_name, expected_rows in (
        (OVERLAY_FILE, prepared.overlay_rows),
        (REMAINING_JSONL_FILE, prepared.remaining_rows),
    ):
        actual_rows = (
            row
            for _, row in contacts.iter_jsonl(root / file_name, location=file_name)
        )
        for index, (actual, expected) in enumerate(
            zip_longest(actual_rows, expected_rows, fillvalue=sentinel), 1
        ):
            if actual is sentinel or expected is sentinel or actual != expected:
                raise IncrementalContactCorrectionError(
                    f"{file_name}:{index}: row drifted"
                )
    try:
        with (root / REMAINING_CSV_FILE).open(
            "r", encoding="utf-8-sig", newline=""
        ) as handle:
            csv_rows = list(csv.DictReader(handle))
    except OSError as error:
        raise IncrementalContactCorrectionError(f"remaining CSV unreadable: {error}") from error
    if len(csv_rows) != len(prepared.remaining_rows):
        raise IncrementalContactCorrectionError("remaining CSV count drifted")
    return {
        "new_promotions": prepared.stats["new_promotions"],
        "output_dir": str(root),
        "record_count": len(prepared.overlay_rows),
        "remaining_record_count": len(prepared.remaining_rows),
        "status": "ready_for_incremental_active21_supervision",
        "training_eligible_rows": prepared.stats["training_eligible_rows"],
        "validation_rows": prepared.stats["validation_rows"],
    }


def build_incremental(
    *,
    contact_bundle: Path,
    corrections_path: Path,
    master_manifest: Path,
    output_dir: Path,
    default_reviewer: str | None = None,
    default_reviewed_at: str | None = None,
    default_confidence: float = 0.9,
    previous_output_dir: Path | None = None,
) -> Mapping[str, Any]:
    prepared = prepare_incremental(
        contact_bundle=contact_bundle,
        corrections_path=corrections_path,
        master_manifest=master_manifest,
        default_reviewer=default_reviewer,
        default_reviewed_at=default_reviewed_at,
        default_confidence=default_confidence,
        previous_output_dir=previous_output_dir,
    )
    output = output_dir.expanduser().resolve()
    if output.exists():
        raise IncrementalContactCorrectionError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        (staging / OVERLAY_FILE).write_bytes(_jsonl_bytes(prepared.overlay_rows))
        (staging / REMAINING_JSONL_FILE).write_bytes(
            _jsonl_bytes(prepared.remaining_rows)
        )
        _write_remaining_csv(staging / REMAINING_CSV_FILE, prepared.remaining_rows)
        artifacts = {
            OVERLAY_FILE: _artifact(
                staging / OVERLAY_FILE, record_count=len(prepared.overlay_rows)
            ),
            REMAINING_JSONL_FILE: _artifact(
                staging / REMAINING_JSONL_FILE,
                record_count=len(prepared.remaining_rows),
            ),
            REMAINING_CSV_FILE: _artifact(
                staging / REMAINING_CSV_FILE,
                record_count=len(prepared.remaining_rows),
            ),
        }
        manifest, report = _metadata(prepared, artifacts)
        (staging / MANIFEST_FILE).write_bytes(contacts.json_bytes(manifest, pretty=True))
        (staging / REPORT_FILE).write_bytes(contacts.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: contacts.sha256_file(staging / name)
                for name in OUTPUT_FILES - {MARKER_FILE}
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(contacts.json_bytes(marker, pretty=True))
        result = _validate_prepared(staging, prepared)
        if output.exists():
            raise IncrementalContactCorrectionError("output appeared during build")
        os.rename(staging, output)
        published = True
        return {**dict(result), "output_dir": str(output)}
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_incremental(
    *,
    contact_bundle: Path,
    corrections_path: Path,
    master_manifest: Path,
    output_dir: Path,
    default_reviewer: str | None = None,
    default_reviewed_at: str | None = None,
    default_confidence: float = 0.9,
    previous_output_dir: Path | None = None,
) -> Mapping[str, Any]:
    prepared = prepare_incremental(
        contact_bundle=contact_bundle,
        corrections_path=corrections_path,
        master_manifest=master_manifest,
        default_reviewer=default_reviewer,
        default_reviewed_at=default_reviewed_at,
        default_confidence=default_confidence,
        previous_output_dir=previous_output_dir,
    )
    return _validate_prepared(output_dir, prepared)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("build", "validate"):
        target = subparsers.add_parser(command)
        target.add_argument("--contact-bundle", type=Path, required=True)
        target.add_argument("--corrections", type=Path, required=True)
        target.add_argument("--master-manifest", type=Path, required=True)
        target.add_argument("--output-dir", type=Path, required=True)
        target.add_argument("--reviewer")
        target.add_argument("--reviewed-at")
        target.add_argument("--default-confidence", type=float, default=0.9)
        target.add_argument("--previous-output-dir", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    kwargs = {
        "contact_bundle": args.contact_bundle,
        "corrections_path": args.corrections,
        "master_manifest": args.master_manifest,
        "output_dir": args.output_dir,
        "default_reviewer": args.reviewer,
        "default_reviewed_at": args.reviewed_at,
        "default_confidence": args.default_confidence,
        "previous_output_dir": args.previous_output_dir,
    }
    try:
        result = (
            build_incremental(**kwargs)
            if args.command == "build"
            else validate_incremental(**kwargs)
        )
    except (IncrementalContactCorrectionError, OSError, ValueError) as error:
        raise SystemExit(f"incremental-contact-correction error: {error}") from error
    print(contacts.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
