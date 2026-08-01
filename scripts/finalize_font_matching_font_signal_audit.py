#!/usr/bin/env python3
"""Seal the human-only font-signal audit and gate delta-font assignments.

The v3 rescue input queue deliberately leaves ambiguous crops blocked.  This
tool accepts one strict human decision for every queued sample, binds it to the
immutable source audit record, and emits a deterministic ledger.  It also
projects ``assignments.jsonl`` into a gated copy where an audited assignment is
``ready`` *only* when its decision is ``font_signal_present``.

The source rescue directory is read-only.  Review cards and QA overlays are
evidence surfaces; neither they nor generated pixels are copied into the
ledger or made eligible as training assets.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import sys
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SOURCE_SCHEMA = "font-matching-catalog-delta-review-inputs-v3"
SOURCE_RECORD_TYPE = "font_signal_identifiability_audit"
SCHEMA_VERSION = "font-matching-font-signal-audit-v1"
LEDGER_RECORD_TYPE = "font_matching_font_signal_audit_final"
REPORT_RECORD_TYPE = "font_matching_font_signal_audit_report"
OWNER = "carrot-manga-translator/font-matching-font-signal-audit"
MARKER_FILE = ".font-matching-font-signal-audit-owned.json"
LEDGER_FILE = "ledger.jsonl"
GATED_ASSIGNMENTS_FILE = "gated-assignments.jsonl"
REVIEW_READY_ASSIGNMENTS_FILE = "review-ready-assignments.jsonl"
REVIEW_READY_INVENTORY_FILE = "review-ready-inventory.jsonl"
REPORT_FILE = "report.json"
EXPECTED_AUDIT_COUNT = 62

ALLOWED_OUTCOMES = frozenset(
    {"font_signal_present", "font_signal_absent", "needs_recrop", "uncertain"}
)
REQUIRED_EVIDENCE = (
    "source_page",
    "raw_224",
    "context_224",
    "glyph_224",
)
DECISION_KEYS = frozenset(
    {
        "sample_id",
        "source_audit_record_sha256",
        "outcome",
        "rationale",
        "reviewer",
        "reviewed_at",
        "decision_source",
        "evidence_checked",
    }
)
LEDGER_KEYS = frozenset(
    {
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
)
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
RATIONALE_LANGUAGE_RE = re.compile(r"[A-Za-z\uac00-\ud7a3]")
SPLIT_KEYS = frozenset({"split", "dataset_split", "source_split"})


class FontSignalAuditError(ValueError):
    """Raised when the audit or its provenance violates the sealed contract."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def pretty_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise FontSignalAuditError(f"could not read {path}: {error}") from error
    with handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sorted_ids_sha256(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(sorted(values)) + "\n").encode("utf-8"))


def ordered_hashes_sha256(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def validate_seal(record: Mapping[str, Any], location: str) -> str:
    declared = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if declared != sha256_bytes(canonical_json_bytes(core)):
        raise FontSignalAuditError(f"{location}: record SHA-256 binding failed")
    return declared


def validate_source_v3_seal(record: Mapping[str, Any], location: str) -> str:
    """Validate the v3 builder's canonical-line (including LF) record seal."""

    declared = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if declared != sha256_bytes(canonical_json_bytes(core) + b"\n"):
        raise FontSignalAuditError(
            f"{location}: source v3 record SHA-256 binding failed"
        )
    return declared


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise FontSignalAuditError(f"{location}: expected an object")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FontSignalAuditError(f"{location}: expected non-empty text")
    return value.strip()


def require_id(value: Any, location: str) -> str:
    text = require_text(value, location)
    if SAFE_ID_RE.fullmatch(text) is None:
        raise FontSignalAuditError(f"{location}: expected a safe identifier")
    return text


def require_sha(value: Any, location: str) -> str:
    text = require_text(value, location)
    if SHA_RE.fullmatch(text) is None:
        raise FontSignalAuditError(f"{location}: expected lowercase SHA-256")
    return text


def require_bool(value: Any, location: str) -> bool:
    if not isinstance(value, bool):
        raise FontSignalAuditError(f"{location}: expected boolean")
    return value


def require_exact_keys(
    value: Mapping[str, Any], expected: frozenset[str], location: str
) -> None:
    missing = sorted(expected - set(value))
    extra = sorted(set(value) - expected)
    if missing or extra:
        raise FontSignalAuditError(
            f"{location}: invalid keys; missing={missing}, unexpected={extra}"
        )


def require_rfc3339(value: Any, location: str) -> str:
    text = require_text(value, location)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise FontSignalAuditError(f"{location}: expected RFC3339 timestamp") from error
    if parsed.tzinfo is None:
        raise FontSignalAuditError(f"{location}: timezone is required")
    return (
        parsed.astimezone(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FontSignalAuditError(
            f"{location}: could not read JSON: {error}"
        ) from error
    return dict(require_mapping(value, location))


def read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as error:
        raise FontSignalAuditError(
            f"{location}: could not read JSONL: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise FontSignalAuditError(
                    f"{location}:{line_number}: invalid JSON: {error}"
                ) from error
            rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    if not rows:
        raise FontSignalAuditError(f"{location}: JSONL is empty")
    return rows


def _nested(mapping: Mapping[str, Any], *keys: str) -> Any:
    current: Any = mapping
    for key in keys:
        if not isinstance(current, Mapping) or key not in current:
            return None
        current = current[key]
    return current


def _validate_split_secrecy(value: Any, location: str) -> None:
    if isinstance(value, Mapping):
        for raw_key, item in value.items():
            key = str(raw_key)
            if key in SPLIT_KEYS:
                raise FontSignalAuditError(
                    f"{location}: split secrecy was violated at {key}"
                )
            if key == "split_visible" and item is not False:
                raise FontSignalAuditError(f"{location}: split_visible must be false")
            _validate_split_secrecy(item, f"{location}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _validate_split_secrecy(item, f"{location}[{index}]")


def _validate_source_audit_row(
    row: Mapping[str, Any], *, index: int
) -> tuple[str, str]:
    location = f"font-signal-audit:{index}"
    if row.get("schema_version") != SOURCE_SCHEMA:
        raise FontSignalAuditError(f"{location}: wrong schema_version")
    if row.get("record_type") != SOURCE_RECORD_TYPE:
        raise FontSignalAuditError(f"{location}: wrong record_type")
    if row.get("status") != "pending_human_audit":
        raise FontSignalAuditError(
            f"{location}: source audit is not pending human review"
        )
    source_record_sha = validate_source_v3_seal(row, location)
    sample_id = require_id(row.get("sample_id"), f"{location}.sample_id")
    if row.get("audit_order") != index:
        raise FontSignalAuditError(f"{location}: audit_order is not contiguous")

    provenance = require_mapping(row.get("provenance"), f"{location}.provenance")
    require_exact_keys(
        provenance,
        frozenset(
            {
                "prior_final_record_sha256",
                "qa_overlay",
                "synthetic",
                "training_sample_record_sha256",
            }
        ),
        f"{location}.provenance",
    )
    if require_bool(provenance.get("qa_overlay"), f"{location}.provenance.qa_overlay"):
        raise FontSignalAuditError(f"{location}: QA-overlay samples are forbidden")
    if require_bool(provenance.get("synthetic"), f"{location}.provenance.synthetic"):
        raise FontSignalAuditError(f"{location}: synthetic samples are forbidden")
    require_sha(
        provenance.get("training_sample_record_sha256"),
        f"{location}.provenance.training_sample_record_sha256",
    )
    require_sha(
        provenance.get("prior_final_record_sha256"),
        f"{location}.provenance.prior_final_record_sha256",
    )

    contract = require_mapping(
        row.get("decision_contract"), f"{location}.decision_contract"
    )
    if contract.get("automatic_absent_classification_allowed") is not False:
        raise FontSignalAuditError(f"{location}: automatic decisions must be disabled")
    if contract.get("new_candidate_review_blocked_until_resolved") is not True:
        raise FontSignalAuditError(f"{location}: review must remain blocked")
    if set(contract.get("allowed_human_outcomes", [])) != ALLOWED_OUTCOMES:
        raise FontSignalAuditError(f"{location}: human outcome contract changed")

    page_sha = require_sha(
        row.get("source_page_sha256"), f"{location}.source_page_sha256"
    )
    locator = require_mapping(
        _nested(row, "evidence", "source_page_locator"),
        f"{location}.evidence.source_page_locator",
    )
    if (
        locator.get("file_sha256") != page_sha
        or locator.get("provenance") != "real_preserved"
    ):
        raise FontSignalAuditError(
            f"{location}: source-page provenance binding changed"
        )

    views = require_mapping(
        _nested(row, "evidence", "views"), f"{location}.evidence.views"
    )
    for view_name in REQUIRED_EVIDENCE[1:]:
        view = require_mapping(
            views.get(view_name), f"{location}.evidence.views.{view_name}"
        )
        status = view.get("status")
        if status not in {"available", "derivable"}:
            raise FontSignalAuditError(
                f"{location}: {view_name} has no reviewable evidence"
            )
        if status == "available":
            require_sha(view.get("file_sha256"), f"{location}.{view_name}.file_sha256")
        else:
            native = require_mapping(
                view.get("source_native"), f"{location}.{view_name}.source_native"
            )
            if native.get("provenance") != "real_preserved":
                raise FontSignalAuditError(
                    f"{location}: derivation source is not preserved real data"
                )
            require_sha(
                native.get("file_sha256"),
                f"{location}.{view_name}.source_native.file_sha256",
            )

    review_surface = require_mapping(
        row.get("review_surface"), f"{location}.review_surface"
    )
    for field in (
        "font_names_visible",
        "model_suggestions_visible",
        "prior_tiers_visible",
        "split_visible",
    ):
        if review_surface.get(field) is not False:
            raise FontSignalAuditError(
                f"{location}: blind review surface changed at {field}"
            )
    return sample_id, source_record_sha


def load_source(
    rescue_inputs: Path,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, Any],
    dict[str, str],
]:
    audit_path = rescue_inputs / "font-signal-audit.jsonl"
    assignments_path = rescue_inputs / "assignments.jsonl"
    selection_path = rescue_inputs / "selection.jsonl"
    report_path = rescue_inputs / "report.json"
    audit_sha = sha256_file(audit_path)
    assignments_sha = sha256_file(assignments_path)
    selection_sha = sha256_file(selection_path)
    report_file_sha = sha256_file(report_path)
    audits = read_jsonl(audit_path, "font-signal-audit")
    assignments = read_jsonl(assignments_path, "assignments")
    selections = read_jsonl(selection_path, "selection")
    report = read_json(report_path, "source report")

    if len(audits) != EXPECTED_AUDIT_COUNT:
        raise FontSignalAuditError(
            f"font-signal-audit: expected exactly {EXPECTED_AUDIT_COUNT} rows, got {len(audits)}"
        )
    source_ids: list[str] = []
    source_record_shas: set[str] = set()
    for index, row in enumerate(audits, 1):
        sample_id, record_sha = _validate_source_audit_row(row, index=index)
        if sample_id in source_ids:
            raise FontSignalAuditError(
                f"font-signal-audit:{index}: duplicate {sample_id}"
            )
        if record_sha in source_record_shas:
            raise FontSignalAuditError(
                f"font-signal-audit:{index}: duplicate record SHA"
            )
        source_ids.append(sample_id)
        source_record_shas.add(record_sha)

    if report.get("schema_version") != SOURCE_SCHEMA:
        raise FontSignalAuditError("source report: wrong schema_version")
    report_record_sha = validate_source_v3_seal(report, "source report")
    if _nested(report, "outputs", "font_signal_audit_sha256") != audit_sha:
        raise FontSignalAuditError("source report: font-signal audit file hash changed")
    if _nested(report, "outputs", "assignments_sha256") != assignments_sha:
        raise FontSignalAuditError("source report: assignments file hash changed")
    if _nested(report, "outputs", "selection_sha256") != selection_sha:
        raise FontSignalAuditError("source report: selection file hash changed")
    if _nested(report, "summary", "font_signal_audit_count") != EXPECTED_AUDIT_COUNT:
        raise FontSignalAuditError("source report: audit count contract changed")
    if _nested(
        report, "summary", "font_signal_audit_sample_ids_sha256"
    ) != sorted_ids_sha256(source_ids):
        raise FontSignalAuditError("source report: audit sample-ID set binding changed")
    if (
        _nested(
            report,
            "contracts",
            "font_signal_audit",
            "automatic_absent_classification_allowed",
        )
        is not False
    ):
        raise FontSignalAuditError(
            "source report: automatic audit decisions are enabled"
        )

    audit_id_set = set(source_ids)
    assignment_ids: set[str] = set()
    assigned_audit_ids: set[str] = set()
    for index, assignment in enumerate(assignments, 1):
        location = f"assignments:{index}"
        assignment_id = require_id(
            assignment.get("assignment_id"), f"{location}.assignment_id"
        )
        if assignment_id in assignment_ids:
            raise FontSignalAuditError(f"{location}: duplicate assignment_id")
        assignment_ids.add(assignment_id)
        sample_id = require_id(assignment.get("sample_id"), f"{location}.sample_id")
        _validate_split_secrecy(assignment, location)
        if sample_id in audit_id_set:
            assigned_audit_ids.add(sample_id)
            if assignment.get("release_state") != "blocked_pending_font_signal_audit":
                raise FontSignalAuditError(
                    f"{location}: audited assignment was prematurely released"
                )
    if assigned_audit_ids != audit_id_set:
        missing = sorted(audit_id_set - assigned_audit_ids)
        raise FontSignalAuditError(f"assignments: missing audited sample IDs {missing}")

    selection_ids: set[str] = set()
    for index, selection in enumerate(selections, 1):
        location = f"selection:{index}"
        if selection.get("schema_version") != SOURCE_SCHEMA:
            raise FontSignalAuditError(f"{location}: wrong schema_version")
        validate_source_v3_seal(selection, location)
        sample_id = require_id(selection.get("sample_id"), f"{location}.sample_id")
        if sample_id in selection_ids:
            raise FontSignalAuditError(f"{location}: duplicate sample ID")
        selection_ids.add(sample_id)
        provenance = require_mapping(
            selection.get("provenance"), f"{location}.provenance"
        )
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise FontSignalAuditError(f"{location}: unsafe QA/synthetic provenance")
        _validate_split_secrecy(selection, location)
    primary_sample_ids = {
        str(row["sample_id"]) for row in assignments if row.get("stage") == "primary"
    }
    if selection_ids != primary_sample_ids:
        raise FontSignalAuditError(
            "selection: sample IDs are not the exact primary-assignment inventory"
        )

    stable_hashes = {
        audit_path: audit_sha,
        assignments_path: assignments_sha,
        selection_path: selection_sha,
        report_path: report_file_sha,
    }
    for path, expected_sha in stable_hashes.items():
        if sha256_file(path) != expected_sha:
            raise FontSignalAuditError(
                f"source changed while it was being validated: {path}"
            )

    hashes = {
        "source_audit_file_sha256": audit_sha,
        "source_assignments_file_sha256": assignments_sha,
        "source_selection_file_sha256": selection_sha,
        "source_report_file_sha256": report_file_sha,
        "source_report_record_sha256": report_record_sha,
    }
    return audits, assignments, selections, report, hashes


def load_decisions(
    decisions_path: Path, audits: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    source_by_id = {str(row["sample_id"]): row for row in audits}
    rows = read_jsonl(decisions_path, "decisions")
    decisions: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        location = f"decisions:{index}"
        require_exact_keys(row, DECISION_KEYS, location)
        sample_id = require_id(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in decisions:
            raise FontSignalAuditError(
                f"{location}: duplicate sample decision {sample_id}"
            )
        if sample_id not in source_by_id:
            raise FontSignalAuditError(f"{location}: extra sample ID {sample_id}")
        source = source_by_id[sample_id]
        source_sha = require_sha(
            row.get("source_audit_record_sha256"),
            f"{location}.source_audit_record_sha256",
        )
        if source_sha != source.get("record_sha256"):
            raise FontSignalAuditError(
                f"{location}: source audit record binding changed"
            )
        outcome = require_text(row.get("outcome"), f"{location}.outcome")
        if outcome not in ALLOWED_OUTCOMES:
            raise FontSignalAuditError(f"{location}: invalid outcome {outcome!r}")
        rationale = require_text(row.get("rationale"), f"{location}.rationale")
        if RATIONALE_LANGUAGE_RE.search(rationale) is None:
            raise FontSignalAuditError(
                f"{location}.rationale: must contain Korean or English evidence text"
            )
        if len(rationale) > 2_000:
            raise FontSignalAuditError(f"{location}.rationale: exceeds 2000 characters")
        reviewer = require_id(row.get("reviewer"), f"{location}.reviewer")
        if row.get("decision_source") != "human_visual_review":
            raise FontSignalAuditError(
                f"{location}: automatic/model/heuristic decisions are forbidden"
            )
        evidence = row.get("evidence_checked")
        if not isinstance(evidence, list) or any(
            not isinstance(item, str) for item in evidence
        ):
            raise FontSignalAuditError(
                f"{location}.evidence_checked: expected an array"
            )
        if len(evidence) != len(set(evidence)) or set(evidence) != set(
            REQUIRED_EVIDENCE
        ):
            raise FontSignalAuditError(
                f"{location}.evidence_checked: must contain exactly {list(REQUIRED_EVIDENCE)}"
            )
        decisions[sample_id] = {
            "sample_id": sample_id,
            "source_audit_record_sha256": source_sha,
            "outcome": outcome,
            "rationale": rationale,
            "reviewer": reviewer,
            "reviewed_at": require_rfc3339(
                row.get("reviewed_at"), f"{location}.reviewed_at"
            ),
            "decision_source": "human_visual_review",
            "evidence_checked": list(REQUIRED_EVIDENCE),
        }

    missing = sorted(set(source_by_id) - set(decisions))
    if missing or len(decisions) != EXPECTED_AUDIT_COUNT:
        raise FontSignalAuditError(
            f"decisions: expected every one of {EXPECTED_AUDIT_COUNT} samples exactly once; missing={missing}"
        )
    return decisions


def build_ledger(
    audits: list[dict[str, Any]],
    decisions: Mapping[str, Mapping[str, Any]],
    source_hashes: Mapping[str, str],
) -> list[dict[str, Any]]:
    ledger: list[dict[str, Any]] = []
    for audit in audits:
        sample_id = str(audit["sample_id"])
        decision = decisions[sample_id]
        outcome = str(decision["outcome"])
        provenance = require_mapping(
            audit["provenance"], f"audit[{sample_id}].provenance"
        )
        ledger.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": LEDGER_RECORD_TYPE,
                    "audit_order": audit["audit_order"],
                    "sample_id": sample_id,
                    "work_id": audit["work_id"],
                    "chapter_id": audit["chapter_id"],
                    "page_id": audit["page_id"],
                    "source_page_sha256": audit["source_page_sha256"],
                    "outcome": outcome,
                    "rationale": decision["rationale"],
                    "reviewer": decision["reviewer"],
                    "reviewed_at": decision["reviewed_at"],
                    "decision_source": "human_visual_review",
                    "evidence_checked": list(REQUIRED_EVIDENCE),
                    "provenance": {
                        **source_hashes,
                        "source_audit_record_sha256": audit["record_sha256"],
                        "training_sample_record_sha256": provenance[
                            "training_sample_record_sha256"
                        ],
                        "prior_final_record_sha256": provenance[
                            "prior_final_record_sha256"
                        ],
                        "qa_overlay": False,
                        "synthetic": False,
                    },
                    "assignment_gate": {
                        "new_7_review_allowed": outcome == "font_signal_present",
                        "required_release_state": (
                            "ready"
                            if outcome == "font_signal_present"
                            else "blocked_pending_font_signal_audit"
                        ),
                    },
                }
            )
        )
    return ledger


def gate_assignments(
    assignments: list[dict[str, Any]], ledger: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    outcome_by_id = {str(row["sample_id"]): str(row["outcome"]) for row in ledger}
    output: list[dict[str, Any]] = []
    for assignment in assignments:
        projected = copy.deepcopy(assignment)
        sample_id = str(projected["sample_id"])
        if sample_id in outcome_by_id:
            projected["release_state"] = (
                "ready"
                if outcome_by_id[sample_id] == "font_signal_present"
                else "blocked_pending_font_signal_audit"
            )
        output.append(projected)
    validate_gated_assignments(assignments, output, ledger)
    return output


def validate_gated_assignments(
    source_assignments: list[dict[str, Any]],
    gated_assignments: list[dict[str, Any]],
    ledger: list[dict[str, Any]],
) -> None:
    if len(gated_assignments) != len(source_assignments):
        raise FontSignalAuditError("gated assignments: row count changed")
    outcome_by_id = {str(row["sample_id"]): str(row["outcome"]) for row in ledger}
    for index, (source, gated) in enumerate(
        zip(source_assignments, gated_assignments), 1
    ):
        location = f"gated assignments:{index}"
        if source.get("assignment_id") != gated.get("assignment_id"):
            raise FontSignalAuditError(f"{location}: assignment order/identity changed")
        sample_id = str(source.get("sample_id"))
        expected = copy.deepcopy(source)
        if sample_id in outcome_by_id:
            expected["release_state"] = (
                "ready"
                if outcome_by_id[sample_id] == "font_signal_present"
                else "blocked_pending_font_signal_audit"
            )
        if gated != expected:
            raise FontSignalAuditError(
                f"{location}: not the exact safe gate projection"
            )
        if sample_id in outcome_by_id:
            released = gated.get("release_state") == "ready"
            if released != (outcome_by_id[sample_id] == "font_signal_present"):
                raise FontSignalAuditError(
                    f"{location}: only font_signal_present may be unblocked"
                )


def project_review_ready_assignments(
    gated_assignments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    output = [
        copy.deepcopy(row)
        for row in gated_assignments
        if row.get("release_state") == "ready"
    ]
    validate_review_ready_assignments(gated_assignments, output)
    return output


def validate_review_ready_assignments(
    gated_assignments: list[dict[str, Any]],
    review_ready_assignments: list[dict[str, Any]],
) -> None:
    expected = [row for row in gated_assignments if row.get("release_state") == "ready"]
    if review_ready_assignments != expected:
        raise FontSignalAuditError(
            "review-ready assignments: not the exact ordered ready-only projection"
        )
    if any(row.get("release_state") != "ready" for row in review_ready_assignments):
        raise FontSignalAuditError(
            "review-ready assignments: blocked assignment leakage detected"
        )
    assignment_ids = [str(row.get("assignment_id")) for row in review_ready_assignments]
    if len(assignment_ids) != len(set(assignment_ids)):
        raise FontSignalAuditError("review-ready assignments: duplicate assignment IDs")


def project_review_ready_inventory(
    source_selection: list[dict[str, Any]],
    review_ready_assignments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ready_primary_ids = {
        str(row["sample_id"])
        for row in review_ready_assignments
        if row.get("stage") == "primary"
    }
    output = [
        copy.deepcopy(row)
        for row in source_selection
        if str(row.get("sample_id")) in ready_primary_ids
    ]
    validate_review_ready_inventory(source_selection, review_ready_assignments, output)
    return output


def validate_review_ready_inventory(
    source_selection: list[dict[str, Any]],
    review_ready_assignments: list[dict[str, Any]],
    review_ready_inventory: list[dict[str, Any]],
) -> None:
    ready_primary_ids = {
        str(row["sample_id"])
        for row in review_ready_assignments
        if row.get("stage") == "primary"
    }
    ready_assignment_sample_ids = {
        str(row["sample_id"]) for row in review_ready_assignments
    }
    if ready_assignment_sample_ids != ready_primary_ids:
        raise FontSignalAuditError(
            "review-ready inventory: every ready sample must have a ready primary assignment"
        )
    expected = [
        row
        for row in source_selection
        if str(row.get("sample_id")) in ready_primary_ids
    ]
    if review_ready_inventory != expected:
        raise FontSignalAuditError(
            "review-ready inventory: not the exact ordered source-selection projection"
        )
    inventory_ids = [str(row.get("sample_id")) for row in review_ready_inventory]
    if (
        len(inventory_ids) != len(set(inventory_ids))
        or set(inventory_ids) != ready_primary_ids
    ):
        raise FontSignalAuditError(
            "review-ready inventory: IDs differ from ready primary assignment IDs"
        )
    for index, row in enumerate(review_ready_inventory, 1):
        _validate_split_secrecy(row, f"review-ready inventory:{index}")


def build_report(
    *,
    ledger: list[dict[str, Any]],
    gated_assignments: list[dict[str, Any]],
    review_ready_assignments: list[dict[str, Any]],
    review_ready_inventory: list[dict[str, Any]],
    source_hashes: Mapping[str, str],
    ledger_payload: bytes,
    gated_payload: bytes,
    review_ready_payload: bytes,
    review_ready_inventory_payload: bytes,
) -> dict[str, Any]:
    outcomes = Counter(str(row["outcome"]) for row in ledger)
    present_ids = [
        str(row["sample_id"])
        for row in ledger
        if row["outcome"] == "font_signal_present"
    ]
    blocked_ids = [
        str(row["sample_id"])
        for row in ledger
        if row["outcome"] != "font_signal_present"
    ]
    audit_ids = {str(row["sample_id"]) for row in ledger}
    released_assignment_count = sum(
        1
        for row in gated_assignments
        if row.get("sample_id") in audit_ids and row.get("release_state") == "ready"
    )
    blocked_assignment_count = sum(
        1
        for row in gated_assignments
        if row.get("sample_id") in audit_ids
        and row.get("release_state") == "blocked_pending_font_signal_audit"
    )
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": REPORT_RECORD_TYPE,
            "contracts": {
                "decision_source": "human_visual_review_only",
                "automatic_decisions_allowed": False,
                "qa_overlay_training_allowed": False,
                "synthetic_training_allowed": False,
                "new_7_assignment_release_rule": "font_signal_present_only",
                "review_card_assignment_input": REVIEW_READY_ASSIGNMENTS_FILE,
                "review_card_inventory_input": REVIEW_READY_INVENTORY_FILE,
                "review_card_input_ready_only": True,
                "test_split_secret": True,
                "source_rescue_inputs_immutable": True,
            },
            "inputs": dict(source_hashes),
            "outputs": {
                "ledger_sha256": sha256_bytes(ledger_payload),
                "gated_assignments_sha256": sha256_bytes(gated_payload),
                "review_ready_assignments_sha256": sha256_bytes(review_ready_payload),
                "review_ready_inventory_sha256": sha256_bytes(
                    review_ready_inventory_payload
                ),
                "ordered_ledger_record_sha256s_sha256": ordered_hashes_sha256(
                    str(row["record_sha256"]) for row in ledger
                ),
            },
            "summary": {
                "audit_count": len(ledger),
                "sample_ids_sha256": sorted_ids_sha256(
                    str(row["sample_id"]) for row in ledger
                ),
                "outcome_counts": {
                    outcome: outcomes.get(outcome, 0)
                    for outcome in sorted(ALLOWED_OUTCOMES)
                },
                "font_signal_present_sample_ids_sha256": sorted_ids_sha256(present_ids),
                "blocked_sample_ids_sha256": sorted_ids_sha256(blocked_ids),
                "released_assignment_count": released_assignment_count,
                "blocked_assignment_count": blocked_assignment_count,
                "gated_assignment_count": len(gated_assignments),
                "review_ready_assignment_count": len(review_ready_assignments),
                "review_ready_inventory_count": len(review_ready_inventory),
                "review_ready_inventory_sample_ids_sha256": sorted_ids_sha256(
                    str(row["sample_id"]) for row in review_ready_inventory
                ),
                "review_ready_blocked_leak_count": sum(
                    1
                    for row in review_ready_assignments
                    if row.get("release_state") != "ready"
                ),
            },
        }
    )


def _assert_separate_paths(source: Path, output: Path) -> None:
    source = source.resolve()
    output = output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise FontSignalAuditError(
            "output must be a separate directory, not the source or its ancestor/descendant"
        )


def _prepare_output(output: Path, *, overwrite: bool) -> None:
    if not output.exists():
        return
    if not overwrite:
        raise FontSignalAuditError(f"output already exists: {output}; pass --overwrite")
    marker_path = output / MARKER_FILE
    marker = read_json(marker_path, "existing output marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise FontSignalAuditError(
            "refusing to replace a directory not owned by this tool"
        )
    current_managed = {
        LEDGER_FILE,
        GATED_ASSIGNMENTS_FILE,
        REVIEW_READY_ASSIGNMENTS_FILE,
        REVIEW_READY_INVENTORY_FILE,
        REPORT_FILE,
    }
    legacy_managed = {LEDGER_FILE, GATED_ASSIGNMENTS_FILE, REPORT_FILE}
    managed = require_mapping(
        marker.get("managed_files"), "existing marker.managed_files"
    )
    managed_names = set(managed)
    if managed_names not in {frozenset(current_managed), frozenset(legacy_managed)}:
        raise FontSignalAuditError(
            "refusing to replace output with a changed managed-file set"
        )
    actual_names = {path.name for path in output.iterdir()}
    if actual_names != managed_names | {MARKER_FILE}:
        raise FontSignalAuditError(
            "refusing to replace output containing unmanaged files"
        )
    for name in sorted(managed_names):
        path = output / name
        if not path.is_file() or sha256_file(path) != require_sha(
            managed.get(name), f"existing marker.managed_files.{name}"
        ):
            raise FontSignalAuditError(
                f"refusing to replace changed managed file: {name}"
            )


def write_output(
    output: Path,
    *,
    ledger: list[dict[str, Any]],
    gated_assignments: list[dict[str, Any]],
    review_ready_assignments: list[dict[str, Any]],
    review_ready_inventory: list[dict[str, Any]],
    report: Mapping[str, Any],
    overwrite: bool,
) -> None:
    _prepare_output(output, overwrite=overwrite)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        ledger_payload = jsonl_bytes(ledger)
        gated_payload = jsonl_bytes(gated_assignments)
        review_ready_payload = jsonl_bytes(review_ready_assignments)
        review_ready_inventory_payload = jsonl_bytes(review_ready_inventory)
        report_payload = pretty_json_bytes(report)
        (stage / LEDGER_FILE).write_bytes(ledger_payload)
        (stage / GATED_ASSIGNMENTS_FILE).write_bytes(gated_payload)
        (stage / REVIEW_READY_ASSIGNMENTS_FILE).write_bytes(review_ready_payload)
        (stage / REVIEW_READY_INVENTORY_FILE).write_bytes(
            review_ready_inventory_payload
        )
        (stage / REPORT_FILE).write_bytes(report_payload)
        managed = {
            LEDGER_FILE: sha256_bytes(ledger_payload),
            GATED_ASSIGNMENTS_FILE: sha256_bytes(gated_payload),
            REVIEW_READY_ASSIGNMENTS_FILE: sha256_bytes(review_ready_payload),
            REVIEW_READY_INVENTORY_FILE: sha256_bytes(review_ready_inventory_payload),
            REPORT_FILE: sha256_bytes(report_payload),
        }
        marker = {
            "schema_version": SCHEMA_VERSION,
            "owner": OWNER,
            "safe_replace": True,
            "managed_files": managed,
        }
        (stage / MARKER_FILE).write_bytes(canonical_json_bytes(marker) + b"\n")
        if output.exists():
            shutil.rmtree(output)
        stage.replace(output)
    except Exception:
        if stage.exists():
            shutil.rmtree(stage)
        raise


def validate_output(rescue_inputs: Path, output: Path) -> dict[str, Any]:
    (
        audits,
        source_assignments,
        source_selection,
        _source_report,
        source_hashes,
    ) = load_source(rescue_inputs)
    marker = read_json(output / MARKER_FILE, "output marker")
    if marker.get("schema_version") != SCHEMA_VERSION or marker.get("owner") != OWNER:
        raise FontSignalAuditError("output marker owner/schema is invalid")
    if marker.get("safe_replace") is not True:
        raise FontSignalAuditError("output marker is not safely replaceable")
    expected_files = {
        LEDGER_FILE,
        GATED_ASSIGNMENTS_FILE,
        REVIEW_READY_ASSIGNMENTS_FILE,
        REVIEW_READY_INVENTORY_FILE,
        REPORT_FILE,
    }
    managed = require_mapping(
        marker.get("managed_files"), "output marker.managed_files"
    )
    if set(managed) != expected_files:
        raise FontSignalAuditError("output marker managed file set changed")
    for name in sorted(expected_files):
        if require_sha(
            managed.get(name), f"output marker.managed_files.{name}"
        ) != sha256_file(output / name):
            raise FontSignalAuditError(f"output marker hash mismatch for {name}")

    ledger = read_jsonl(output / LEDGER_FILE, "sealed ledger")
    if len(ledger) != EXPECTED_AUDIT_COUNT:
        raise FontSignalAuditError("sealed ledger does not contain exactly 62 records")
    audit_by_id = {str(row["sample_id"]): row for row in audits}
    seen: set[str] = set()
    for index, row in enumerate(ledger, 1):
        location = f"sealed ledger:{index}"
        require_exact_keys(row, LEDGER_KEYS, location)
        validate_seal(row, location)
        if (
            row.get("schema_version") != SCHEMA_VERSION
            or row.get("record_type") != LEDGER_RECORD_TYPE
        ):
            raise FontSignalAuditError(f"{location}: ledger schema/type changed")
        sample_id = require_id(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in seen or sample_id not in audit_by_id:
            raise FontSignalAuditError(f"{location}: duplicate or extra sample ID")
        seen.add(sample_id)
        source = audit_by_id[sample_id]
        if row.get("audit_order") != index or source.get("audit_order") != index:
            raise FontSignalAuditError(f"{location}: order changed")
        outcome = row.get("outcome")
        if outcome not in ALLOWED_OUTCOMES:
            raise FontSignalAuditError(f"{location}: invalid outcome")
        if row.get("decision_source") != "human_visual_review":
            raise FontSignalAuditError(f"{location}: automatic decision found")
        rationale = require_text(row.get("rationale"), f"{location}.rationale")
        if RATIONALE_LANGUAGE_RE.search(rationale) is None:
            raise FontSignalAuditError(f"{location}: invalid rationale")
        require_id(row.get("reviewer"), f"{location}.reviewer")
        require_rfc3339(row.get("reviewed_at"), f"{location}.reviewed_at")
        if row.get("evidence_checked") != list(REQUIRED_EVIDENCE):
            raise FontSignalAuditError(f"{location}: evidence set changed")
        provenance = require_mapping(row.get("provenance"), f"{location}.provenance")
        source_provenance = require_mapping(
            source["provenance"], f"{location}.source.provenance"
        )
        expected_provenance = {
            **source_hashes,
            "source_audit_record_sha256": source["record_sha256"],
            "training_sample_record_sha256": source_provenance[
                "training_sample_record_sha256"
            ],
            "prior_final_record_sha256": source_provenance["prior_final_record_sha256"],
            "qa_overlay": False,
            "synthetic": False,
        }
        if provenance != expected_provenance:
            raise FontSignalAuditError(f"{location}: source provenance changed")
        for field in ("work_id", "chapter_id", "page_id", "source_page_sha256"):
            if row.get(field) != source.get(field):
                raise FontSignalAuditError(f"{location}: source {field} changed")
        expected_gate = {
            "new_7_review_allowed": outcome == "font_signal_present",
            "required_release_state": (
                "ready"
                if outcome == "font_signal_present"
                else "blocked_pending_font_signal_audit"
            ),
        }
        if row.get("assignment_gate") != expected_gate:
            raise FontSignalAuditError(f"{location}: assignment gate changed")
    if seen != set(audit_by_id):
        raise FontSignalAuditError("sealed ledger is missing source sample IDs")

    gated = read_jsonl(output / GATED_ASSIGNMENTS_FILE, "gated assignments")
    validate_gated_assignments(source_assignments, gated, ledger)
    review_ready = read_jsonl(
        output / REVIEW_READY_ASSIGNMENTS_FILE, "review-ready assignments"
    )
    validate_review_ready_assignments(gated, review_ready)
    review_ready_inventory = read_jsonl(
        output / REVIEW_READY_INVENTORY_FILE, "review-ready inventory"
    )
    validate_review_ready_inventory(
        source_selection, review_ready, review_ready_inventory
    )
    ledger_payload = (output / LEDGER_FILE).read_bytes()
    gated_payload = (output / GATED_ASSIGNMENTS_FILE).read_bytes()
    review_ready_payload = (output / REVIEW_READY_ASSIGNMENTS_FILE).read_bytes()
    review_ready_inventory_payload = (output / REVIEW_READY_INVENTORY_FILE).read_bytes()
    expected_report = build_report(
        ledger=ledger,
        gated_assignments=gated,
        review_ready_assignments=review_ready,
        review_ready_inventory=review_ready_inventory,
        source_hashes=source_hashes,
        ledger_payload=ledger_payload,
        gated_payload=gated_payload,
        review_ready_payload=review_ready_payload,
        review_ready_inventory_payload=review_ready_inventory_payload,
    )
    report = read_json(output / REPORT_FILE, "sealed report")
    validate_seal(report, "sealed report")
    if report != expected_report:
        raise FontSignalAuditError(
            "sealed report is not the exact aggregate projection"
        )
    return report


def finalize(args: argparse.Namespace) -> int:
    rescue_inputs = args.rescue_inputs.resolve()
    output = args.output.resolve()
    _assert_separate_paths(rescue_inputs, output)
    audits, assignments, source_selection, _source_report, source_hashes = load_source(
        rescue_inputs
    )
    decisions = load_decisions(args.decisions.resolve(), audits)
    ledger = build_ledger(audits, decisions, source_hashes)
    gated = gate_assignments(assignments, ledger)
    review_ready = project_review_ready_assignments(gated)
    review_ready_inventory = project_review_ready_inventory(
        source_selection, review_ready
    )
    ledger_payload = jsonl_bytes(ledger)
    gated_payload = jsonl_bytes(gated)
    review_ready_payload = jsonl_bytes(review_ready)
    review_ready_inventory_payload = jsonl_bytes(review_ready_inventory)
    report = build_report(
        ledger=ledger,
        gated_assignments=gated,
        review_ready_assignments=review_ready,
        review_ready_inventory=review_ready_inventory,
        source_hashes=source_hashes,
        ledger_payload=ledger_payload,
        gated_payload=gated_payload,
        review_ready_payload=review_ready_payload,
        review_ready_inventory_payload=review_ready_inventory_payload,
    )
    write_output(
        output,
        ledger=ledger,
        gated_assignments=gated,
        review_ready_assignments=review_ready,
        review_ready_inventory=review_ready_inventory,
        report=report,
        overwrite=args.overwrite,
    )
    validate_output(rescue_inputs, output)
    immutable_sources = {
        "font-signal-audit.jsonl": source_hashes["source_audit_file_sha256"],
        "assignments.jsonl": source_hashes["source_assignments_file_sha256"],
        "selection.jsonl": source_hashes["source_selection_file_sha256"],
        "report.json": source_hashes["source_report_file_sha256"],
    }
    for name, expected_sha in immutable_sources.items():
        if sha256_file(rescue_inputs / name) != expected_sha:
            raise FontSignalAuditError(f"source rescue input was modified: {name}")
    print(
        json.dumps(
            {
                "status": "sealed",
                "audit_count": EXPECTED_AUDIT_COUNT,
                "output": str(output),
                "report_record_sha256": report["record_sha256"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


def validate_command(args: argparse.Namespace) -> int:
    _assert_separate_paths(args.rescue_inputs.resolve(), args.output.resolve())
    report = validate_output(args.rescue_inputs.resolve(), args.output.resolve())
    print(
        json.dumps(
            {
                "status": "valid",
                "audit_count": report["summary"]["audit_count"],
                "report_record_sha256": report["record_sha256"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    finalize_parser = subparsers.add_parser("finalize", help="seal human decisions")
    finalize_parser.add_argument("--rescue-inputs", type=Path, required=True)
    finalize_parser.add_argument("--decisions", type=Path, required=True)
    finalize_parser.add_argument("--output", type=Path, required=True)
    finalize_parser.add_argument("--overwrite", action="store_true")
    finalize_parser.set_defaults(handler=finalize)
    validate_parser = subparsers.add_parser("validate", help="validate a sealed output")
    validate_parser.add_argument("--rescue-inputs", type=Path, required=True)
    validate_parser.add_argument("--output", type=Path, required=True)
    validate_parser.set_defaults(handler=validate_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except FontSignalAuditError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
