#!/usr/bin/env python3
"""Promote completed named-font val decisions into sealed calibration finals.

The input contact-sheet bundle remains reference-only.  A completed human
decision that exactly confirms the blind reference becomes ``primary``;
changed font tiers become ``adjudicated`` and bind the named contact sheet as
evidence.  Only the bundle's validation rows are accepted, and test rows can
never enter the output.
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
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import build_manga_font_student_calibration_review as review
    import font_matching_labels as labels
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_manga_font_student_calibration_review as review
    from scripts import font_matching_labels as labels


SCHEMA_VERSION = "manga-font-student-calibration-finals-v1"
REPORT_TYPE = "manga_font_student_calibration_finals_report"
OWNER = "carrot-manga-translator/manga-font-student-calibration-finals-v1"
MARKER_FILE = ".manga-font-student-calibration-finals-owned.json"
REPORT_FILE = "report.json"
FINALS_FILE = "finals-calibration-val.jsonl"
DECISION_KEYS = frozenset(
    {
        "confidence",
        "decision_id",
        "decision_status",
        "font_judgment",
        "notes",
        "record_type",
        "review_id",
        "review_item_sha256",
        "review_sheet_acknowledged",
        "reviewed_at",
        "reviewer",
        "sample_id",
        "schema_version",
    }
)
SAMPLE_ID_RE = re.compile(r'"sample_id"\s*:\s*"(?P<sample_id>[A-Za-z0-9._:-]+)"')
CONCISE_TIERS = ("preferred", "acceptable", "marginal")
CONCISE_OPTIONAL_KEYS = frozenset({"confidence", "notes"})


class StudentCalibrationPromotionError(ValueError):
    """Raised when human decisions cannot be promoted as calibration gold."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise StudentCalibrationPromotionError(f"{location}: expected object")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise StudentCalibrationPromotionError(f"{location}: expected text")
    return result


def _timestamp(value: Any, location: str) -> str:
    text = _text(value, location)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise StudentCalibrationPromotionError(
            f"{location}: invalid timestamp"
        ) from error
    if (
        parsed.tzinfo is None
        or parsed.utcoffset() is None
        or parsed.utcoffset().total_seconds() != 0
        or not text.endswith("Z")
    ):
        raise StudentCalibrationPromotionError(
            f"{location}: RFC3339 UTC timestamp ending in Z is required"
        )
    return text


def _confidence(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StudentCalibrationPromotionError(f"{location}: expected confidence")
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise StudentCalibrationPromotionError(f"{location}: confidence outside [0,1]")
    return result


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _load_decision_templates(
    path: Path, review_rows: Sequence[Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Load the immutable bundle template and bind every row to review evidence."""

    expected = {str(row["sample_id"]): row for row in review_rows}
    templates: dict[str, dict[str, Any]] = {}
    if path.is_symlink() or not path.is_file():
        raise StudentCalibrationPromotionError("decision template is missing or linked")
    try:
        handle = path.open(encoding="utf-8")
    except OSError as error:
        raise StudentCalibrationPromotionError(
            f"decision template unavailable: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                template = dict(
                    _mapping(json.loads(line), f"decision template:{line_number}")
                )
            except json.JSONDecodeError as error:
                raise StudentCalibrationPromotionError(
                    f"decision template:{line_number}: invalid JSON"
                ) from error
            if set(template) != DECISION_KEYS:
                raise StudentCalibrationPromotionError(
                    f"decision template:{line_number}: schema drift"
                )
            sample_id = template.get("sample_id")
            if not isinstance(sample_id, str) or sample_id not in expected:
                raise StudentCalibrationPromotionError(
                    f"decision template:{line_number}: unknown sample"
                )
            if sample_id in templates:
                raise StudentCalibrationPromotionError(
                    f"decision template:{line_number}: duplicate sample"
                )
            row = expected[sample_id]
            if (
                template.get("schema_version") != review.DECISION_SCHEMA_VERSION
                or template.get("record_type") != review.DECISION_RECORD_TYPE
                or template.get("decision_status") != "pending"
                or template.get("review_id") != row.get("review_id")
                or template.get("review_item_sha256") != row.get("record_sha256")
                or template.get("review_sheet_acknowledged") is not False
                or template.get("reviewer") is not None
                or template.get("reviewed_at") is not None
                or template.get("confidence") is not None
            ):
                raise StudentCalibrationPromotionError(
                    f"{sample_id}: template is mutable or already completed"
                )
            decision_id = _text(template.get("decision_id"), f"{sample_id}.decision_id")
            if labels.ID_RE.fullmatch(decision_id) is None:
                raise StudentCalibrationPromotionError(
                    f"{sample_id}: invalid template decision identity"
                )
            judgment = _mapping(
                template.get("font_judgment"), f"{sample_id}.font_judgment"
            )
            try:
                review._validate_candidate_partition(  # noqa: SLF001
                    judgment,
                    review.EXPECTED_CANDIDATE_IDS,
                    location=f"{sample_id}.font_judgment",
                )
            except review.StudentCalibrationReviewError as error:
                raise StudentCalibrationPromotionError(str(error)) from error
            reference = _mapping(row.get("reference"), f"{sample_id}.reference")
            final = _mapping(
                reference.get("final_record"), f"{sample_id}.reference.final_record"
            )
            if judgment != _mapping(
                final.get("font_judgment"),
                f"{sample_id}.reference.final_record.font_judgment",
            ):
                raise StudentCalibrationPromotionError(
                    f"{sample_id}: template no longer matches the sealed reference"
                )
            templates[sample_id] = template
    missing = sorted(set(expected) - set(templates))
    if missing or len(templates) != len(expected):
        raise StudentCalibrationPromotionError(
            f"decision template must cover every val row; missing={missing[:8]}"
        )
    decision_ids = [str(row["decision_id"]) for row in templates.values()]
    if len(decision_ids) != len(set(decision_ids)):
        raise StudentCalibrationPromotionError("template decision IDs are duplicated")
    return templates


def _concise_row(
    value: Any, *, location: str, include_sample_id: bool
) -> dict[str, Any]:
    row = dict(_mapping(value, location))
    required = {*CONCISE_TIERS}
    if include_sample_id:
        required.add("sample_id")
    allowed = required | CONCISE_OPTIONAL_KEYS
    if set(row) - allowed or not required.issubset(row):
        raise StudentCalibrationPromotionError(
            f"{location}: expected only preferred/acceptable/marginal and optional "
            "confidence/notes"
        )
    return row


def load_concise_judgments(
    path: Path, expected_sample_ids: Sequence[str]
) -> dict[str, dict[str, Any]]:
    """Load either a sample-keyed JSON object or one sample per JSONL line."""

    if path.is_symlink() or not path.is_file():
        raise StudentCalibrationPromotionError(
            "concise judgments file is missing or linked"
        )
    expected = set(expected_sample_ids)
    judgments: dict[str, dict[str, Any]] = {}
    suffix = path.suffix.lower()
    try:
        if suffix == ".json":
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            mapping = _mapping(raw, "concise judgments")
            for raw_sample_id, value in mapping.items():
                if not isinstance(raw_sample_id, str) or not raw_sample_id:
                    raise StudentCalibrationPromotionError(
                        "concise judgments: every object key must be a sample_id"
                    )
                judgments[raw_sample_id] = _concise_row(
                    value,
                    location=f"concise judgments[{raw_sample_id!r}]",
                    include_sample_id=False,
                )
        elif suffix == ".jsonl":
            with path.open(encoding="utf-8-sig") as handle:
                for line_number, line in enumerate(handle, 1):
                    if not line.strip():
                        continue
                    try:
                        row = _concise_row(
                            json.loads(line),
                            location=f"concise judgments:{line_number}",
                            include_sample_id=True,
                        )
                    except json.JSONDecodeError as error:
                        raise StudentCalibrationPromotionError(
                            f"concise judgments:{line_number}: invalid JSON"
                        ) from error
                    sample_id = row.pop("sample_id")
                    if not isinstance(sample_id, str) or not sample_id:
                        raise StudentCalibrationPromotionError(
                            f"concise judgments:{line_number}: invalid sample_id"
                        )
                    if sample_id in judgments:
                        raise StudentCalibrationPromotionError(
                            f"concise judgments:{line_number}: duplicate sample_id"
                        )
                    judgments[sample_id] = row
        else:
            raise StudentCalibrationPromotionError(
                "concise judgments must use a .json or .jsonl extension"
            )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StudentCalibrationPromotionError(
            f"concise judgments are invalid: {error}"
        ) from error
    unknown = sorted(set(judgments) - expected)
    missing = sorted(expected - set(judgments))
    if unknown or missing or len(judgments) != len(expected):
        raise StudentCalibrationPromotionError(
            "concise judgments must cover every val sample exactly once; "
            f"unknown={unknown[:8]}, missing={missing[:8]}"
        )
    return judgments


def _completed_judgment(
    template: Mapping[str, Any], concise: Mapping[str, Any], *, sample_id: str
) -> dict[str, Any]:
    original = _mapping(
        template.get("font_judgment"), f"{sample_id}.template.font_judgment"
    )
    original_unrenderable = list(original["unrenderable"])
    selected: list[str] = []
    judgment: dict[str, Any] = {}
    for tier in CONCISE_TIERS:
        value = concise.get(tier)
        if not isinstance(value, list) or not all(
            isinstance(candidate_id, str) and candidate_id for candidate_id in value
        ):
            raise StudentCalibrationPromotionError(
                f"{sample_id}.{tier}: expected an array of candidate IDs"
            )
        judgment[tier] = list(value)
        selected.extend(value)
    if len(selected) != len(set(selected)):
        raise StudentCalibrationPromotionError(
            f"{sample_id}: a candidate occurs in more than one concise tier"
        )
    unknown = sorted(set(selected) - set(review.EXPECTED_CANDIDATE_IDS))
    if unknown:
        raise StudentCalibrationPromotionError(
            f"{sample_id}: unknown candidate IDs: {unknown[:8]}"
        )
    claimed_unrenderable = sorted(set(selected) & set(original_unrenderable))
    if claimed_unrenderable:
        raise StudentCalibrationPromotionError(
            f"{sample_id}: original unrenderable candidates cannot be selected: "
            f"{claimed_unrenderable[:8]}"
        )
    unavailable = set(original_unrenderable)
    chosen = set(selected)
    judgment["unacceptable"] = [
        candidate_id
        for candidate_id in review.EXPECTED_CANDIDATE_IDS
        if candidate_id not in chosen and candidate_id not in unavailable
    ]
    judgment["unrenderable"] = original_unrenderable
    judgment["not_reviewed"] = []
    judgment["none_acceptable"] = not bool(
        judgment["preferred"] or judgment["acceptable"]
    )
    try:
        review._validate_candidate_partition(  # noqa: SLF001
            judgment,
            review.EXPECTED_CANDIDATE_IDS,
            location=f"{sample_id}.font_judgment",
        )
    except review.StudentCalibrationReviewError as error:
        raise StudentCalibrationPromotionError(str(error)) from error
    return judgment


def _safe_decisions_output(path: Path, review_bundle_dir: Path) -> Path:
    requested = path.expanduser()
    if requested.is_symlink():
        raise StudentCalibrationPromotionError(
            "completed decisions output must not be a symbolic link"
        )
    target = requested.resolve()
    bundle = review_bundle_dir.expanduser().resolve()
    if target == bundle or bundle in target.parents:
        raise StudentCalibrationPromotionError(
            "completed decisions must be written outside the immutable review bundle"
        )
    if target.suffix.lower() != ".jsonl" or len(target.name) < 7:
        raise StudentCalibrationPromotionError(
            "completed decisions output must be a named .jsonl file"
        )
    if target.exists() and (target.is_symlink() or not target.is_file()):
        raise StudentCalibrationPromotionError(
            "completed decisions output is linked or not a regular file"
        )
    return target


def complete_decisions(
    *,
    review_bundle_dir: Path,
    judgments_path: Path,
    output_path: Path,
    reviewer: str,
    reviewed_at: str | None = None,
    default_confidence: float = 0.95,
    replace_valid_output: bool = False,
) -> dict[str, Any]:
    """Apply concise human judgments without relaxing the promotion contract."""

    bundle = review.validate_review_bundle(review_bundle_dir)
    review_rows = bundle["rows"]
    reviewer = _text(reviewer, "reviewer")
    if labels.ID_RE.fullmatch(reviewer) is None:
        raise StudentCalibrationPromotionError("reviewer has an invalid identity")
    completed_at = _timestamp(reviewed_at or _utc_now(), "reviewed_at")
    fallback_confidence = _confidence(default_confidence, "default_confidence")
    templates = _load_decision_templates(
        review_bundle_dir / review.DECISION_TEMPLATE_FILE, review_rows
    )
    sample_ids = [str(row["sample_id"]) for row in review_rows]
    judgments = load_concise_judgments(judgments_path, sample_ids)
    decisions: list[dict[str, Any]] = []
    for row in review_rows:
        sample_id = str(row["sample_id"])
        concise = judgments[sample_id]
        notes = concise.get("notes", "")
        if not isinstance(notes, str) or len(notes) > 3000:
            raise StudentCalibrationPromotionError(f"{sample_id}: invalid notes")
        decision = copy.deepcopy(templates[sample_id])
        decision.update(
            {
                "confidence": _confidence(
                    concise.get("confidence", fallback_confidence),
                    f"{sample_id}.confidence",
                ),
                "decision_status": "complete",
                "font_judgment": _completed_judgment(
                    decision, concise, sample_id=sample_id
                ),
                "notes": notes,
                "review_sheet_acknowledged": True,
                "reviewed_at": completed_at,
                "reviewer": reviewer,
            }
        )
        decisions.append(decision)
    target = _safe_decisions_output(output_path, review_bundle_dir)
    if target.exists():
        if not replace_valid_output:
            raise StudentCalibrationPromotionError(
                "completed decisions output exists; pass --replace-valid-output"
            )
        load_completed_decisions(target, review_rows)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, staging_name = tempfile.mkstemp(
        prefix=f".{target.name}.staging-", suffix=".jsonl", dir=target.parent
    )
    os.close(descriptor)
    staging = Path(staging_name)
    try:
        _write_jsonl(staging, decisions)
        validated, output_sha256 = load_completed_decisions(staging, review_rows)
        if len(validated) != len(decisions):
            raise StudentCalibrationPromotionError(
                "completed decision validation count drift"
            )
        os.replace(staging, target)
    except BaseException:
        if staging.exists():
            staging.unlink()
        raise
    return {
        "decisions_path": str(target),
        "decisions_sha256": output_sha256,
        "record_count": len(decisions),
        "reviewed_at": completed_at,
        "reviewer": reviewer,
        "status": "ready_for_gold_promotion",
    }


def load_completed_decisions(
    path: Path, review_rows: Sequence[Mapping[str, Any]]
) -> tuple[dict[str, dict[str, Any]], str]:
    if path.is_symlink() or not path.is_file():
        raise StudentCalibrationPromotionError("decision file is missing or linked")
    expected = {str(row["sample_id"]): row for row in review_rows}
    decisions: dict[str, dict[str, Any]] = {}
    try:
        handle = path.open(encoding="utf-8")
    except OSError as error:
        raise StudentCalibrationPromotionError(
            f"decision file unavailable: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            matches = list(SAMPLE_ID_RE.finditer(line))
            if len(matches) != 1:
                raise StudentCalibrationPromotionError(
                    f"decisions:{line_number}: expected one textual sample_id"
                )
            sample_id = matches[0].group("sample_id")
            if sample_id not in expected:
                raise StudentCalibrationPromotionError(
                    f"decisions:{line_number}: non-val/unknown sample is forbidden"
                )
            try:
                decision = dict(_mapping(json.loads(line), f"decisions:{line_number}"))
            except json.JSONDecodeError as error:
                raise StudentCalibrationPromotionError(
                    f"decisions:{line_number}: invalid JSON"
                ) from error
            if set(decision) != DECISION_KEYS:
                raise StudentCalibrationPromotionError(
                    f"decisions:{line_number}: decision schema drift"
                )
            if decision.get("sample_id") != sample_id or sample_id in decisions:
                raise StudentCalibrationPromotionError(
                    f"decisions:{line_number}: duplicate/drifted sample"
                )
            row = expected[sample_id]
            if (
                decision.get("schema_version") != review.DECISION_SCHEMA_VERSION
                or decision.get("record_type") != review.DECISION_RECORD_TYPE
                or decision.get("decision_status") != "complete"
                or decision.get("review_id") != row.get("review_id")
                or decision.get("review_item_sha256") != row.get("record_sha256")
                or decision.get("review_sheet_acknowledged") is not True
            ):
                raise StudentCalibrationPromotionError(
                    f"{sample_id}: decision is pending or not bound to reviewed evidence"
                )
            decision_id = _text(decision.get("decision_id"), f"{sample_id}.decision_id")
            reviewer = _text(decision.get("reviewer"), f"{sample_id}.reviewer")
            if (
                labels.ID_RE.fullmatch(decision_id) is None
                or labels.ID_RE.fullmatch(reviewer) is None
            ):
                raise StudentCalibrationPromotionError(
                    f"{sample_id}: invalid decision identity"
                )
            decision["reviewed_at"] = _timestamp(
                decision.get("reviewed_at"), f"{sample_id}.reviewed_at"
            )
            decision["confidence"] = _confidence(
                decision.get("confidence"), f"{sample_id}.confidence"
            )
            notes = decision.get("notes")
            if not isinstance(notes, str) or len(notes) > 3000:
                raise StudentCalibrationPromotionError(f"{sample_id}: invalid notes")
            judgment = _mapping(
                decision.get("font_judgment"), f"{sample_id}.font_judgment"
            )
            try:
                review._validate_candidate_partition(  # noqa: SLF001
                    judgment,
                    review.EXPECTED_CANDIDATE_IDS,
                    location=f"{sample_id}.font_judgment",
                )
            except review.StudentCalibrationReviewError as error:
                raise StudentCalibrationPromotionError(str(error)) from error
            decisions[sample_id] = decision
    missing = sorted(set(expected) - set(decisions))
    if missing or len(decisions) != len(expected):
        raise StudentCalibrationPromotionError(
            f"all val decisions must be complete exactly once; missing={missing[:8]}"
        )
    decision_ids = [str(value["decision_id"]) for value in decisions.values()]
    if len(decision_ids) != len(set(decision_ids)):
        raise StudentCalibrationPromotionError("decision IDs are duplicated")
    return decisions, review.sha256_file(path)


def promote_decisions(
    review_rows: Sequence[Mapping[str, Any]],
    decisions: Mapping[str, Mapping[str, Any]],
    *,
    decisions_sha256: str,
) -> list[dict[str, Any]]:
    finals: list[dict[str, Any]] = []
    for row in review_rows:
        if row.get("split") != "val":
            raise StudentCalibrationPromotionError("review bundle leaked a non-val row")
        sample_id = str(row["sample_id"])
        decision = decisions[sample_id]
        reference_wrapper = _mapping(row.get("reference"), f"{sample_id}.reference")
        reference = _mapping(
            reference_wrapper.get("final_record"), f"{sample_id}.reference.final"
        )
        reference_judgment = _mapping(
            reference.get("font_judgment"), f"{sample_id}.reference.font_judgment"
        )
        judgment = copy.deepcopy(
            dict(_mapping(decision.get("font_judgment"), f"{sample_id}.decision"))
        )
        changed = judgment != dict(reference_judgment)
        kind = "adjudicated" if changed else "primary"
        prior_resolution = _mapping(
            reference.get("resolution"), f"{sample_id}.reference.resolution"
        )
        sources = sorted(
            {
                *[str(value) for value in prior_resolution.get("source_label_ids", [])],
                str(reference["final_id"]),
                str(decision["decision_id"]),
            }
        )
        flags: list[str] = []
        if judgment["none_acceptable"]:
            flags.extend(["catalog_gap_confirmed", "none_acceptable_confirmed"])
        if changed:
            flags.append("disagreement_resolved")
        sheet = _mapping(row.get("sheet"), f"{sample_id}.sheet")
        evidence = (
            {
                "candidate_order": copy.deepcopy(row["display_order"]),
                "candidate_order_seed": row["display_order_seed"],
                "font_names_visible": True,
                "model_suggestions_visible": True,
                "review_card_sha256": sheet["sha256"],
            }
            if changed
            else None
        )
        user_notes = str(decision.get("notes", "")).strip()
        notes = (
            f"named_student22_calibration_review={decision['decision_id']}; "
            f"blind_reference_authority=reference_only; decisions_sha256={decisions_sha256}"
        )
        if user_notes:
            notes += f"; reviewer_notes={user_notes}"
        final_id = (
            "student-cal-final-"
            + review.sha256_bytes(
                f"{sample_id}\0{decision['decision_id']}\0{decisions_sha256}".encode(
                    "utf-8"
                )
            )[:24]
        )
        final = labels.seal_record(
            {
                "consistency": copy.deepcopy(reference["consistency"]),
                "final_id": final_id,
                "font_judgment": judgment,
                "record_type": labels.FINAL_RECORD_TYPE,
                "resolution": {
                    "adjudication_evidence": evidence,
                    "catalog_sha256": prior_resolution["catalog_sha256"],
                    "catalog_version": prior_resolution["catalog_version"],
                    "confidence": decision["confidence"],
                    "flags": flags,
                    "kind": kind,
                    "notes": notes,
                    "renderer_hash": prior_resolution["renderer_hash"],
                    "resolved_at": decision["reviewed_at"],
                    "resolver": decision["reviewer"],
                    "source_label_ids": sources,
                },
                "role": copy.deepcopy(reference["role"]),
                "sample_id": sample_id,
                "schema_version": labels.SCHEMA_VERSION,
                "source_page_sha256": reference["source_page_sha256"],
                "source_style": copy.deepcopy(reference["source_style"]),
                "treatment": copy.deepcopy(reference["treatment"]),
                "work_id": reference["work_id"],
            }
        )
        try:
            labels.validate_final_record(
                final, candidate_ids=review.EXPECTED_CANDIDATE_IDS
            )
        except labels.LabelValidationError as error:
            raise StudentCalibrationPromotionError(str(error)) from error
        if final["resolution"]["kind"] not in {"primary", "adjudicated"}:
            raise StudentCalibrationPromotionError(
                "promoted final authority is invalid"
            )
        finals.append(final)
    return sorted(finals, key=lambda value: str(value["sample_id"]))


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes(
        "".join(review.canonical_json(row) + "\n" for row in rows).encode("utf-8")
    )


def _safe_output(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(resolved.anchor)}
    if resolved in forbidden or len(resolved.parts) < 3 or len(resolved.name) < 3:
        raise StudentCalibrationPromotionError(f"unsafe output directory: {resolved}")
    return resolved


def validate_promoted_output(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    expected = {MARKER_FILE, REPORT_FILE, FINALS_FILE}
    if not root.is_dir() or root.is_symlink():
        raise StudentCalibrationPromotionError("promoted output is missing or linked")
    actual = {path.name for path in root.iterdir()}
    if actual != expected or any(not path.is_file() for path in root.iterdir()):
        raise StudentCalibrationPromotionError("promoted output exact inventory drift")
    report = review._read_json(root / REPORT_FILE, "promotion report")  # noqa: SLF001
    review.validate_record_seal(report, location="promotion report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != REPORT_TYPE
    ):
        raise StudentCalibrationPromotionError("promotion report schema drift")
    boundary = _mapping(report.get("boundary"), "promotion boundary")
    if (
        boundary.get("split") != "val"
        or boundary.get("test_rows_used") != 0
        or boundary.get("pseudo_rows_used") != 0
        or boundary.get("blind_agreement_rows_promoted_directly") != 0
        or boundary.get("allowed_resolution_kinds") != ["adjudicated", "primary"]
    ):
        raise StudentCalibrationPromotionError(
            "promotion split/authority boundary drift"
        )
    marker = review._read_json(root / MARKER_FILE, "promotion marker")  # noqa: SLF001
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("report_sha256") != review.sha256_file(root / REPORT_FILE)
        or marker.get("finals_sha256") != review.sha256_file(root / FINALS_FILE)
    ):
        raise StudentCalibrationPromotionError("promotion marker drift")
    finals: list[dict[str, Any]] = []
    with (root / FINALS_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                final = dict(_mapping(json.loads(line), f"finals:{line_number}"))
            except json.JSONDecodeError as error:
                raise StudentCalibrationPromotionError(
                    f"finals:{line_number}: invalid JSON"
                ) from error
            try:
                labels.validate_final_record(
                    final, candidate_ids=review.EXPECTED_CANDIDATE_IDS
                )
            except labels.LabelValidationError as error:
                raise StudentCalibrationPromotionError(str(error)) from error
            if final["resolution"]["kind"] not in {"primary", "adjudicated"}:
                raise StudentCalibrationPromotionError("non-gold final in output")
            finals.append(final)
    if (
        len(finals) != boundary.get("sample_count")
        or len(finals) != len({row["sample_id"] for row in finals})
        or review.sha256_file(root / FINALS_FILE)
        != _mapping(report.get("artifacts"), "promotion artifacts")[FINALS_FILE][
            "sha256"
        ]
    ):
        raise StudentCalibrationPromotionError("promotion finals count/hash drift")
    return {
        "finals_path": str(root / FINALS_FILE),
        "output_dir": str(root),
        "record_count": len(finals),
        "resolution_counts": dict(
            sorted(Counter(row["resolution"]["kind"] for row in finals).items())
        ),
        "status": "ready_for_supervised_selection_calibration",
    }


def build_promoted_output(
    *,
    review_bundle_dir: Path,
    decisions_path: Path,
    output_dir: Path,
    replace_owned_output: bool = False,
) -> dict[str, Any]:
    bundle = review.validate_review_bundle(review_bundle_dir)
    review_rows = bundle["rows"]
    decisions, decisions_sha256 = load_completed_decisions(decisions_path, review_rows)
    finals = promote_decisions(
        review_rows, decisions, decisions_sha256=decisions_sha256
    )
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise StudentCalibrationPromotionError(
                "output exists; pass --replace-owned-output"
            )
        validate_promoted_output(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        _write_jsonl(staging / FINALS_FILE, finals)
        counts = Counter(row["resolution"]["kind"] for row in finals)
        report = review.seal_record(
            {
                "artifacts": {
                    FINALS_FILE: {
                        "file": FINALS_FILE,
                        "sha256": review.sha256_file(staging / FINALS_FILE),
                    }
                },
                "boundary": {
                    "allowed_resolution_kinds": ["adjudicated", "primary"],
                    "blind_agreement_rows_promoted_directly": 0,
                    "human_named_review_required": True,
                    "pseudo_rows_used": 0,
                    "sample_count": len(finals),
                    "split": "val",
                    "test_rows_used": 0,
                },
                "candidate_count": len(review.EXPECTED_CANDIDATE_IDS),
                "candidate_ids": list(review.EXPECTED_CANDIDATE_IDS),
                "inputs": {
                    "decisions_sha256": decisions_sha256,
                    "review_report_sha256": review.sha256_file(
                        review_bundle_dir / review.REPORT_FILE
                    ),
                },
                "record_type": REPORT_TYPE,
                "resolution_counts": dict(sorted(counts.items())),
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / REPORT_FILE).write_bytes(review.json_bytes(report, pretty=True))
        marker = {
            "finals_sha256": review.sha256_file(staging / FINALS_FILE),
            "owner": OWNER,
            "report_sha256": review.sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(review.json_bytes(marker, pretty=True))
        validate_promoted_output(staging)
        if target.exists():
            validate_promoted_output(target)
            shutil.rmtree(target)
        os.replace(staging, target)
        return validate_promoted_output(target)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    complete = sub.add_parser(
        "apply-judgments",
        help="expand concise reviewed choices into a promotion-ready decisions JSONL",
        description=(
            "Read the review bundle's immutable decision template plus a concise "
            "sample-keyed .json or row-based .jsonl. Unspecified renderable fonts "
            "become unacceptable; only the template's original unrenderable fonts "
            "remain unrenderable. The output must live outside the review bundle."
        ),
    )
    complete.add_argument("--review-bundle-dir", type=Path, required=True)
    complete.add_argument(
        "--judgments",
        type=Path,
        required=True,
        help="concise .json or .jsonl containing every val sample exactly once",
    )
    complete.add_argument(
        "--output",
        type=Path,
        required=True,
        help="promotion-ready decisions .jsonl outside the immutable review bundle",
    )
    complete.add_argument(
        "--reviewer",
        required=True,
        help="human reviewer ID using letters, digits, dot, underscore, colon, or dash",
    )
    complete.add_argument(
        "--reviewed-at",
        help="optional RFC3339 UTC timestamp ending in Z; defaults to the current UTC time",
    )
    complete.add_argument(
        "--default-confidence",
        type=float,
        default=0.95,
        help="confidence used when a concise row omits it (default: 0.95)",
    )
    complete.add_argument("--replace-valid-output", action="store_true")
    promote = sub.add_parser("promote")
    promote.add_argument("--review-bundle-dir", type=Path, required=True)
    promote.add_argument("--decisions", type=Path, required=True)
    promote.add_argument("--output-dir", type=Path, required=True)
    promote.add_argument("--replace-owned-output", action="store_true")
    validate = sub.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "apply-judgments":
            result = complete_decisions(
                review_bundle_dir=args.review_bundle_dir.resolve(),
                judgments_path=args.judgments.resolve(),
                output_path=args.output,
                reviewer=args.reviewer,
                reviewed_at=args.reviewed_at,
                default_confidence=args.default_confidence,
                replace_valid_output=args.replace_valid_output,
            )
        elif args.command == "promote":
            result = build_promoted_output(
                review_bundle_dir=args.review_bundle_dir.resolve(),
                decisions_path=args.decisions.resolve(),
                output_dir=args.output_dir,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_promoted_output(args.output_dir)
    except (
        StudentCalibrationPromotionError,
        review.StudentCalibrationReviewError,
    ) as error:
        raise SystemExit(f"student-calibration-promotion error: {error}") from error
    print(review.canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
