#!/usr/bin/env python3
"""Seal blind delta-font reviews and merge them with immutable prior labels.

This is deliberately separate from the original 15-font review ledger.  The
catalog rescue is a *delta* experiment: reviewers see seven opaque aliases,
while the old 15-font final stays private until the final merge.  The module
therefore treats the v3 rescue selection, the human font-signal gate, and the
rendered review-card manifests as immutable inputs.

The four public commands are:

``init``
    Validate all source bindings and create private bindings plus blind tasks.
``commit-source`` / ``release-candidates`` / ``submit``
    Freeze a complete source-only A batch, release candidate-only B in a later
    ledger state, then append re-derived decisions atomically.
``validate``
    Recheck source files, blindness, reviewer independence, and completeness.
``finalize``
    Emit either a fresh calibration report or a production-evidence-pruned
    final catalog.  Production-safe-zero additions are removed and queued for
    a fresh blind replacement round.

Reviewer decision files never contain font IDs or names.  Candidate identity
is revealed only inside ``finalize`` after every required human decision has
been resolved.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import math
import os
import re
import secrets
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Iterable, Iterator, Mapping, Sequence

try:
    from scripts import derive_font_matching_delta_decisions as v5_deriver
except (ImportError, ModuleNotFoundError):  # direct ``python scripts/...``
    import derive_font_matching_delta_decisions as v5_deriver


SCHEMA_VERSION = "font-matching-catalog-delta-ledger-v1"
SOURCE_SCHEMA_VERSION = "font-matching-catalog-delta-review-inputs-v3"
AUDIT_SCHEMA_VERSION = "font-matching-font-signal-audit-v1"
TIERS = ("preferred", "acceptable", "marginal", "unacceptable", "unrenderable")
ALL_FINAL_TIERS = (*TIERS, "not_reviewed")
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
REVIEW_STAGES = ("primary", "secondary", "adjudication")
EXPECTED_TRIGGER_NAMES = (
    "primary_secondary_disagreement",
    "none_acceptable",
    "confidence_below_0.80",
)
CALIBRATION_THRESHOLDS = {
    "role_macro_f1": 0.85,
    "tier_pairwise_agreement": 0.80,
    "acceptable_set_jaccard": 0.70,
    "none_acceptable_agreement": 0.90,
}
VARIANT_V4_CALIBRATION_PROFILE = "variant_first_v4"
VARIANT_V4_SELECTION_METHOD = "deterministic_train_variant_first_v4"
VARIANT_V4_STRATA_TARGETS = {
    "ordinary_body": 8,
    "aside_whisper_handwritten": 12,
    "emphasis_shout": 12,
    "sfx_impact": 4,
    "sfx_motion": 4,
    "sfx_ambient": 4,
    "sfx_emotion": 4,
    "sfx_comic": 4,
    "sign_ui_title": 8,
}
VARIANT_V4_TOTAL = sum(VARIANT_V4_STRATA_TARGETS.values())
VARIANT_V4_CORPUS_WORK_COUNT = 24
VARIANT_V4_SELECTION_ATTEMPTS = 128
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
ALIAS_RE = re.compile(r"^ko-candidate-[0-9a-f]{16}$")
V5_RUBRIC_NAME = "font-matching-v2-review-rubric-v5.md"
V5_RUBRIC_CONTRACT = {
    "schema_version": "font-matching-review-rubric-contract-v1",
    "record_type": "font_matching_v5_review_rubric",
    "sha256": "9ec2c0227300025875a0021a5c073e704067c74f857553f08ae50c0d3a5d63a3",
}
V5_SPLIT_SCHEMA_VERSION = "font-matching-review-card-split-v5"
V5_SOURCE_COMMIT_SCHEMA_VERSION = "font-matching-delta-source-commit-v5"
V5_SOURCE_COMMIT_RECORD_TYPE = "font_matching_delta_source_commit"
V5_CANDIDATE_SURFACE_SCHEMA_VERSION = "font-matching-candidate-surface-v5"
V5_CANDIDATE_SURFACE_RECORD_TYPE = "font_matching_candidate_surface"
V5_CATALOG_DISPOSITION_SCHEMA_VERSION = "font-matching-catalog-disposition-v5"
V5_CATALOG_DISPOSITION_RECORD_TYPE = "font_matching_catalog_disposition"
V5_FINAL_CATALOG_SCHEMA_VERSION = "font-matching-final-catalog-v5"
V5_FINAL_CATALOG_RECORD_TYPE = "font_matching_final_catalog"
V5_PROVISIONAL_CATALOG_SCHEMA_VERSION = "font-matching-provisional-catalog-v5"
V5_PROVISIONAL_CATALOG_RECORD_TYPE = "font_matching_provisional_catalog"
V5_PROVISIONAL_REPORT_RECORD_TYPE = "font_catalog_delta_provisional_report"
V5_DEPLOYMENT_FAILURE_ACTION = "deployment_failure"
V5_SAFE_ZERO_ACTION = "deleted_safe_zero"
V5_PENDING_UTILITY_ACTION = "pending_full22_utility_audit"
CALIBRATION_SUPPLEMENT_SCHEMA_VERSION = "font-matching-calibration-supplement-v5"
CALIBRATION_SUPPLEMENT_RECORD_TYPE = (
    "font_matching_calibration_only_supplement_manifest"
)
CALIBRATION_SUPPLEMENT_OWNER = (
    "carrot-manga-translator/font-matching-calibration-supplement-v5"
)
CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION = "permanent_quarantine_closure"
CALIBRATION_SUPPLEMENT_SOURCE_SEAL_SCHEMA_VERSION = (
    "font-matching-review-source-seal-v5-calibration-only"
)
CALIBRATION_SUPPLEMENT_SOURCE_SEAL_RECORD_TYPE = (
    "font_matching_calibration_only_source_seal"
)
CALIBRATION_SUPPLEMENT_SOURCE_FILE_KEY = "calibration_only_supplement_manifest"
SUCCESSOR_AUTHORITY_SELECTION_RECORD_TYPE = (
    "font_catalog_delta_successor_authority_selection"
)
SUCCESSOR_AUTHORITY_INTAKE_SCHEMA_VERSION = (
    "font-matching-successor-authority-intake-v5"
)
SUCCESSOR_AUTHORITY_INTAKE_RECORD_TYPE = "font_catalog_delta_successor_authority_intake"
SUCCESSOR_AUTHORITY_INTAKE_OWNER = (
    "carrot-manga-translator/font-matching-successor-authority-intake-v5"
)
SUCCESSOR_AUTHORITY_INTAKE_SAMPLE_RECORD_TYPE = (
    "font_matching_successor_authority_intake_sample"
)
SUCCESSOR_AUTHORITY_INTAKE_INVENTORY_RECORD_TYPE = (
    "font_matching_successor_authority_review_inventory"
)
SUCCESSOR_AUTHORITY_INTAKE_TRAINING_DISPOSITION = (
    "permanent_train_quarantine_calibration_only"
)
SUCCESSOR_AUTHORITY_INTAKE_SOURCE_FILE_KEY = "successor_authority_intake_manifest"


class DeltaLedgerError(ValueError):
    """Raised when an artifact violates a frozen delta-review contract."""


class CalibrationGateError(DeltaLedgerError):
    """Raised after a calibration report is written but fails frozen gates."""


def _detect_rubric_contract(path: Path) -> tuple[bool, dict[str, Any] | None]:
    rubric_sha = sha256_file(path)
    try:
        text_value = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise DeltaLedgerError(f"cannot read review rubric: {error}") from error
    declares_v5 = (
        "Font Matching V2 육안검수 규약 v5" in text_value
        or "A/source-only" in text_value
        or path.name == V5_RUBRIC_NAME
    )
    if rubric_sha == V5_RUBRIC_CONTRACT["sha256"]:
        if not declares_v5:
            raise DeltaLedgerError("expected v5 rubric content marker is missing")
        return True, copy.deepcopy(V5_RUBRIC_CONTRACT)
    if declares_v5:
        raise DeltaLedgerError(
            "v5 rubric content SHA differs from the explicit expected contract"
        )
    return False, None


def _v5_derivation_contract() -> dict[str, Any]:
    return {
        "task_schema_version": v5_deriver.TASK_SCHEMA_VERSION,
        "source_annotation_schema_version": v5_deriver.SOURCE_SCHEMA_VERSION,
        "decision_audit_schema_version": v5_deriver.AUDIT_SCHEMA_VERSION,
        "candidate_release_schema_version": v5_deriver.RELEASE_SCHEMA_VERSION,
        "frozen_alias_order_sha256": sha256_bytes(
            canonical_json_bytes(list(v5_deriver.FROZEN_ALIAS_ORDER))
        ),
        "prototype_profile_sha256": sha256_bytes(
            canonical_json_bytes(v5_deriver.PROTOTYPES)
        ),
        "review_surface_sha256": sha256_bytes(
            canonical_json_bytes(v5_deriver.REVIEW_SURFACE)
        ),
        "safe_candidate_cap": 2,
        "source_annotation_seal_required": True,
        "whole_a_batch_before_b_required": True,
        "source_commit_precedes_candidate_release": True,
        "candidate_release_precedes_decision_submit": True,
        "source_annotation_with_decision_forbidden": True,
        "ledger_rederivation_required": True,
    }


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    try:
        return sha256_bytes(path.read_bytes())
    except OSError as error:
        raise DeltaLedgerError(f"cannot read {path}: {error}") from error


def stable_hash(*parts: str) -> str:
    return sha256_bytes("\0".join(parts).encode("utf-8"))


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def validate_seal(
    record: Mapping[str, Any], location: str, *, trailing_lf: bool = False
) -> str:
    digest = record.get("record_sha256")
    require_sha(digest, f"{location}.record_sha256")
    payload = dict(record)
    payload.pop("record_sha256", None)
    canonical = canonical_json_bytes(payload)
    expected = sha256_bytes(canonical + (b"\n" if trailing_lf else b""))
    if digest != expected:
        raise DeltaLedgerError(f"{location}: record_sha256 mismatch")
    return str(digest)


def utc_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise DeltaLedgerError(f"{location} must be an object")
    return value


def require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise DeltaLedgerError(f"{location} must be an array")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DeltaLedgerError(f"{location} must be a non-empty string")
    return value


def require_id(value: Any, location: str) -> str:
    text = require_text(value, location)
    if not ID_RE.fullmatch(text):
        raise DeltaLedgerError(f"{location} is not a portable identifier")
    return text


def require_sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise DeltaLedgerError(f"{location} must be a lowercase SHA-256")
    return value


def require_bool(value: Any, location: str) -> bool:
    if not isinstance(value, bool):
        raise DeltaLedgerError(f"{location} must be boolean")
    return value


def require_unit(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DeltaLedgerError(f"{location} must be a finite number in [0, 1]")
    result = float(value)
    if not math.isfinite(result) or not 0.0 <= result <= 1.0:
        raise DeltaLedgerError(f"{location} must be a finite number in [0, 1]")
    return result


def require_exact_keys(
    value: Mapping[str, Any], expected: set[str], location: str
) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise DeltaLedgerError(
            f"{location} has wrong keys (missing={missing}, extra={extra})"
        )


def nested(value: Mapping[str, Any], *parts: str) -> Any:
    current: Any = value
    for part in parts:
        if not isinstance(current, Mapping) or part not in current:
            raise DeltaLedgerError(f"missing required field: {'.'.join(parts)}")
        current = current[part]
    return current


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise DeltaLedgerError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise DeltaLedgerError(f"{path}: expected a JSON object")
    return value


def read_jsonl(path: Path, *, missing_ok: bool = False) -> list[dict[str, Any]]:
    if missing_ok and not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise DeltaLedgerError(f"cannot read {path}: {error}") from error
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise DeltaLedgerError(f"{path}:{line_number}: {error}") from error
        if not isinstance(value, dict):
            raise DeltaLedgerError(f"{path}:{line_number}: expected an object")
        rows.append(value)
    return rows


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


@contextmanager
def workspace_lock(workspace: Path) -> Iterator[None]:
    lock = workspace / ".delta-ledger.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise DeltaLedgerError(f"workspace is locked: {lock}") from error
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield
    finally:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def _file_binding(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    return {
        "path": str(resolved),
        "sha256": sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def _opaque_file_binding(path: Path) -> dict[str, Any]:
    """Bind bytes without publishing a path into a pre-release workspace."""

    resolved = path.resolve()
    return {
        "sha256": sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def _validate_opaque_file_binding(
    value: Mapping[str, Any], path: Path, location: str
) -> None:
    require_exact_keys(value, {"sha256", "byte_size"}, location)
    expected_sha = require_sha(value.get("sha256"), f"{location}.sha256")
    size = value.get("byte_size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise DeltaLedgerError(f"{location}.byte_size must be non-negative integer")
    resolved = path.resolve()
    if (
        not resolved.is_file()
        or resolved.stat().st_size != size
        or sha256_file(resolved) != expected_sha
    ):
        raise DeltaLedgerError(f"release input differs from {location}: {resolved}")


def _validate_file_binding(value: Mapping[str, Any], location: str) -> Path:
    require_exact_keys(value, {"path", "sha256", "byte_size"}, location)
    path = Path(require_text(value.get("path"), f"{location}.path"))
    expected_sha = require_sha(value.get("sha256"), f"{location}.sha256")
    size = value.get("byte_size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise DeltaLedgerError(f"{location}.byte_size must be non-negative integer")
    if not path.is_file():
        raise DeltaLedgerError(f"bound file is missing: {path}")
    if path.stat().st_size != size or sha256_file(path) != expected_sha:
        raise DeltaLedgerError(f"bound file changed: {path}")
    return path


def _index_unique(
    rows: Sequence[Mapping[str, Any]], key: str, location: str
) -> dict[str, Mapping[str, Any]]:
    output: dict[str, Mapping[str, Any]] = {}
    for index, row in enumerate(rows):
        item = require_id(row.get(key), f"{location}[{index}].{key}")
        if item in output:
            raise DeltaLedgerError(f"{location}: duplicate {key} {item}")
        output[item] = row
    return output


def _string_array(value: Any, location: str) -> list[str]:
    values = require_list(value, location)
    output = [
        require_id(item, f"{location}[{index}]") for index, item in enumerate(values)
    ]
    if len(output) != len(set(output)):
        raise DeltaLedgerError(f"{location} contains duplicates")
    return output


def _validate_partition(
    judgment: Mapping[str, Any], candidates: set[str], location: str
) -> dict[str, list[str]]:
    require_exact_keys(judgment, {*TIERS, "none_acceptable"}, location)
    partition: dict[str, list[str]] = {}
    seen: set[str] = set()
    for tier in TIERS:
        aliases = _string_array(judgment.get(tier), f"{location}.{tier}")
        for alias in aliases:
            if alias not in candidates:
                raise DeltaLedgerError(
                    f"{location}.{tier} uses a non-blind or unknown candidate: {alias}"
                )
            if alias in seen:
                raise DeltaLedgerError(f"{location}: {alias} appears in multiple tiers")
            seen.add(alias)
        partition[tier] = aliases
    if seen != candidates:
        missing = sorted(candidates - seen)
        raise DeltaLedgerError(
            f"{location} must tier all seven candidates exactly once; missing={missing}"
        )
    none = require_bool(judgment.get("none_acceptable"), f"{location}.none_acceptable")
    expected_none = not partition["preferred"] and not partition["acceptable"]
    if none != expected_none:
        raise DeltaLedgerError(
            f"{location}.none_acceptable must be true exactly when preferred and acceptable are empty"
        )
    return partition


def _candidate_partition_with_not_reviewed(
    judgment: Mapping[str, Any], location: str
) -> tuple[dict[str, list[str]], set[str]]:
    expected = {*ALL_FINAL_TIERS, "none_acceptable"}
    if set(judgment) != expected:
        raise DeltaLedgerError(f"{location} is not a complete prior catalog judgment")
    output: dict[str, list[str]] = {}
    seen: set[str] = set()
    for tier in ALL_FINAL_TIERS:
        ids = _string_array(judgment.get(tier), f"{location}.{tier}")
        if seen.intersection(ids):
            raise DeltaLedgerError(f"{location}: candidate appears in multiple tiers")
        seen.update(ids)
        output[tier] = ids
    none = require_bool(judgment.get("none_acceptable"), f"{location}.none_acceptable")
    if none != (not output["preferred"] and not output["acceptable"]):
        raise DeltaLedgerError(f"{location}: invalid none_acceptable semantics")
    return output, seen


def _validate_source_inputs(rescue_inputs: Path, audit: Path) -> dict[str, Any]:
    rescue = rescue_inputs.resolve()
    audit_root = audit.resolve()
    paths = {
        "source_report": rescue / "report.json",
        "source_selection": rescue / "selection.jsonl",
        "source_assignments": rescue / "assignments.jsonl",
        "source_master": rescue / "master.jsonl",
        "render_manifest": rescue / "render-bank" / "manifest.json",
        "audit_report": audit_root / "report.json",
        "audit_ledger": audit_root / "ledger.jsonl",
        "ready_inventory": audit_root / "review-ready-inventory.jsonl",
        "ready_assignments": audit_root / "review-ready-assignments.jsonl",
    }
    for name, path in paths.items():
        if not path.is_file():
            raise DeltaLedgerError(f"missing {name}: {path}")

    source_report = read_json(paths["source_report"])
    if source_report.get("schema_version") != SOURCE_SCHEMA_VERSION:
        raise DeltaLedgerError("rescue report is not the sealed v3 delta input")
    source_report_sha = validate_seal(source_report, "source report", trailing_lf=True)
    if nested(source_report, "outputs", "selection_sha256") != sha256_file(
        paths["source_selection"]
    ):
        raise DeltaLedgerError("source report no longer binds selection.jsonl")
    if nested(source_report, "outputs", "assignments_sha256") != sha256_file(
        paths["source_assignments"]
    ):
        raise DeltaLedgerError("source report no longer binds assignments.jsonl")
    if nested(source_report, "outputs", "master_sha256") != sha256_file(
        paths["source_master"]
    ):
        raise DeltaLedgerError("source report no longer binds master.jsonl")
    if nested(source_report, "outputs", "render_bank_manifest_sha256") != sha256_file(
        paths["render_manifest"]
    ):
        raise DeltaLedgerError("source report no longer binds render-bank manifest")

    audit_report = read_json(paths["audit_report"])
    if audit_report.get("schema_version") != AUDIT_SCHEMA_VERSION:
        raise DeltaLedgerError("font-signal audit uses another schema")
    audit_report_sha = validate_seal(audit_report, "font-signal audit report")
    if nested(audit_report, "inputs", "source_report_file_sha256") != sha256_file(
        paths["source_report"]
    ):
        raise DeltaLedgerError("font-signal audit binds another source report file")
    if (
        nested(audit_report, "inputs", "source_report_record_sha256")
        != source_report_sha
    ):
        raise DeltaLedgerError("font-signal audit binds another source report record")
    expected_audit_outputs = {
        "ledger_sha256": "audit_ledger",
        "review_ready_inventory_sha256": "ready_inventory",
        "review_ready_assignments_sha256": "ready_assignments",
    }
    for report_key, path_key in expected_audit_outputs.items():
        if nested(audit_report, "outputs", report_key) != sha256_file(paths[path_key]):
            raise DeltaLedgerError(f"font-signal audit no longer binds {path_key}")

    selection_rows = read_jsonl(paths["source_selection"])
    selection = _index_unique(selection_rows, "sample_id", "selection")
    for index, row in enumerate(selection_rows):
        validate_seal(row, f"selection[{index}]", trailing_lf=True)
        if row.get("schema_version") != SOURCE_SCHEMA_VERSION:
            raise DeltaLedgerError(f"selection[{index}] uses another schema")
        if row.get("record_type") != "font_catalog_delta_review_selection":
            raise DeltaLedgerError(f"selection[{index}] has another record_type")
        provenance = require_mapping(
            row.get("provenance"), f"selection[{index}].provenance"
        )
        if (
            provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
        ):
            raise DeltaLedgerError(f"selection[{index}] is synthetic or a QA overlay")
        merge = require_mapping(
            row.get("merge_provenance"), f"selection[{index}].merge_provenance"
        )
        if merge.get("visibility") != "merge_only_not_reviewer_surface":
            raise DeltaLedgerError(f"selection[{index}] exposes prior labels")
        prior = require_mapping(
            merge.get("prior_final_record"), f"selection[{index}].prior_final_record"
        )
        validate_seal(prior, f"selection[{index}].prior_final_record")
        sample_id = str(row["sample_id"])
        if prior.get("sample_id") != sample_id:
            raise DeltaLedgerError(
                f"{sample_id}: prior label belongs to another sample; successor inheritance is forbidden"
            )
        if prior.get("work_id") != row.get("work_id") or prior.get(
            "source_page_sha256"
        ) != row.get("source_page_sha256"):
            raise DeltaLedgerError(f"{sample_id}: prior final core binding changed")
        if merge.get("prior_final_record_sha256") != prior.get("record_sha256"):
            raise DeltaLedgerError(f"{sample_id}: prior final SHA binding changed")
        old_partition, old_candidates = _candidate_partition_with_not_reviewed(
            require_mapping(
                prior.get("font_judgment"), f"{sample_id}.prior.font_judgment"
            ),
            f"{sample_id}.prior.font_judgment",
        )
        if old_partition["not_reviewed"]:
            raise DeltaLedgerError(f"{sample_id}: prior 15-font label is incomplete")
        if len(old_candidates) != 15:
            raise DeltaLedgerError(
                f"{sample_id}: prior catalog must contain exactly 15 candidates"
            )

    audit_rows = read_jsonl(paths["audit_ledger"])
    audit_by_sample = _index_unique(audit_rows, "sample_id", "font-signal audit ledger")
    blocked: set[str] = set()
    uncertain: set[str] = set()
    for index, row in enumerate(audit_rows):
        validate_seal(row, f"font-signal audit ledger[{index}]")
        outcome = row.get("outcome")
        if outcome not in {
            "font_signal_present",
            "font_signal_absent",
            "needs_recrop",
            "uncertain",
        }:
            raise DeltaLedgerError(
                f"font-signal audit ledger[{index}] has invalid outcome"
            )
        if row.get("sample_id") not in selection:
            raise DeltaLedgerError("font-signal audit references a non-active sample")
        if outcome in {"font_signal_absent", "needs_recrop", "uncertain"}:
            blocked.add(str(row["sample_id"]))
        if outcome == "uncertain":
            uncertain.add(str(row["sample_id"]))
    if uncertain:
        raise DeltaLedgerError(
            "font-signal audit still contains uncertain outcomes; resolve them before labeling"
        )

    inventory_rows = read_jsonl(paths["ready_inventory"])
    inventory = _index_unique(inventory_rows, "sample_id", "review-ready inventory")
    expected_ready = set(selection) - blocked
    if set(inventory) != expected_ready:
        raise DeltaLedgerError(
            "review-ready inventory is not active selection minus absent/recrop samples"
        )
    for sample_id, row in inventory.items():
        if dict(row) != dict(selection[sample_id]):
            raise DeltaLedgerError(
                f"{sample_id}: review-ready inventory changed selection content"
            )

    master_rows = read_jsonl(paths["source_master"])
    master = _index_unique(master_rows, "id", "source master")
    if set(master) != set(selection):
        raise DeltaLedgerError("source master and selection sample inventories differ")
    split_by_sample: dict[str, str] = {}
    storage_split_by_sample: dict[str, str] = {}
    for sample_id, row in master.items():
        views = require_mapping(row.get("views"), f"master[{sample_id}].views")
        splits: set[str] = set()
        for view_name, view_value in views.items():
            view = require_mapping(view_value, f"master[{sample_id}].views.{view_name}")
            candidate_paths: list[str] = []
            if isinstance(view.get("path"), str):
                candidate_paths.append(str(view["path"]))
            source_native = view.get("source_native")
            if isinstance(source_native, Mapping) and isinstance(
                source_native.get("path"), str
            ):
                candidate_paths.append(str(source_native["path"]))
            for candidate_path in candidate_paths:
                parts = PurePosixPath(candidate_path).parts
                found = {part for part in parts if part in {"train", "val", "test"}}
                if len(found) != 1:
                    raise DeltaLedgerError(
                        f"master[{sample_id}].views.{view_name} has ambiguous split path"
                    )
                splits.update(found)
        if len(splits) != 1:
            raise DeltaLedgerError(f"master[{sample_id}] view splits disagree")
        storage_split = next(iter(splits))
        storage_split_by_sample[sample_id] = storage_split

        # The master builder freezes a work-level canonical split in the
        # explicit `split` field.  View paths may still point at the immutable
        # source catalog's legacy storage partition; treating that directory
        # name as the training split would recreate the leakage that v5 is
        # intended to prevent.  Older fixtures/artifacts without an explicit
        # field retain the path-derived behavior.
        declared_split = row.get("split")
        if declared_split is None:
            split_by_sample[sample_id] = storage_split
        elif declared_split not in {"train", "val", "test"}:
            raise DeltaLedgerError(f"master[{sample_id}].split is unsupported")
        else:
            legacy_split = row.get("legacy_split")
            if legacy_split is not None and legacy_split != storage_split:
                raise DeltaLedgerError(
                    f"master[{sample_id}].legacy_split differs from immutable view storage"
                )
            split_by_sample[sample_id] = str(declared_split)

    render_manifest = read_json(paths["render_manifest"])
    candidates = require_list(
        render_manifest.get("candidates"), "render manifest.candidates"
    )
    if render_manifest.get("candidate_count") != 7 or len(candidates) != 7:
        raise DeltaLedgerError(
            "delta render bank must contain exactly seven candidates"
        )
    alias_to_id: dict[str, str] = {}
    identity_tokens: set[str] = set()
    for index, candidate_value in enumerate(candidates):
        candidate = require_mapping(
            candidate_value, f"render manifest.candidates[{index}]"
        )
        alias = require_text(
            candidate.get("blind_alias"), f"render candidate[{index}].blind_alias"
        )
        if not ALIAS_RE.fullmatch(alias) or alias in alias_to_id:
            raise DeltaLedgerError("render bank aliases must be unique opaque aliases")
        font_id = require_id(
            candidate.get("font_id"), f"render candidate[{index}].font_id"
        )
        if font_id in alias_to_id.values():
            raise DeltaLedgerError("render bank font IDs must be unique")
        alias_to_id[alias] = font_id
        for key in ("font_id", "font_label", "css_family", "face_id", "display_id"):
            token = candidate.get(key)
            if isinstance(token, str) and token.strip():
                identity_tokens.add(token.casefold())

    old_candidate_set: set[str] | None = None
    for sample_id, row in selection.items():
        new_judgment = require_mapping(
            row.get("new_7_candidate_judgment"), f"{sample_id}.new_7"
        )
        if set(new_judgment.get("not_reviewed", [])) != set(alias_to_id.values()):
            raise DeltaLedgerError(
                f"{sample_id}: new-candidate inventory differs from render bank"
            )
        prior = require_mapping(
            nested(row, "merge_provenance", "prior_final_record"), f"{sample_id}.prior"
        )
        _, candidates15 = _candidate_partition_with_not_reviewed(
            require_mapping(
                prior.get("font_judgment"), f"{sample_id}.prior.font_judgment"
            ),
            f"{sample_id}.prior.font_judgment",
        )
        if old_candidate_set is None:
            old_candidate_set = candidates15
        elif candidates15 != old_candidate_set:
            raise DeltaLedgerError(
                "prior 15-font catalog differs between selection rows"
            )
    assert old_candidate_set is not None
    if old_candidate_set.intersection(alias_to_id.values()):
        raise DeltaLedgerError("old and new candidate catalogs overlap")

    assignment_rows = read_jsonl(paths["ready_assignments"])
    assignments = _index_unique(
        assignment_rows, "assignment_id", "review-ready assignments"
    )
    stages_by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    for index, assignment in enumerate(assignment_rows):
        sample_id = require_id(
            assignment.get("sample_id"), f"assignments[{index}].sample_id"
        )
        stage = assignment.get("stage")
        if sample_id not in inventory or stage not in {"primary", "secondary"}:
            raise DeltaLedgerError(f"assignments[{index}] is not review-ready")
        if stage in stages_by_sample[sample_id]:
            raise DeltaLedgerError(f"{sample_id}: duplicate {stage} assignment")
        stages_by_sample[sample_id][str(stage)] = assignment
        if assignment.get("release_state") != "ready":
            raise DeltaLedgerError(f"assignments[{index}] is not released")
        if assignment.get("blind_first_pass") is not True:
            raise DeltaLedgerError(f"assignments[{index}] is not blind")
        for field in (
            "font_names_visible",
            "model_suggestions_visible",
            "prior_tiers_visible",
            "split_visible",
        ):
            if assignment.get(field) is not False:
                raise DeltaLedgerError(f"assignments[{index}] leaks {field}")
        if tuple(assignment.get("adjudication_if", [])) != EXPECTED_TRIGGER_NAMES:
            raise DeltaLedgerError(
                f"assignments[{index}] changed adjudication triggers"
            )
        ids = _string_array(
            assignment.get("candidate_order"), f"assignments[{index}].candidate_order"
        )
        aliases = _string_array(
            assignment.get("blind_alias_order"),
            f"assignments[{index}].blind_alias_order",
        )
        if len(ids) != 7 or len(aliases) != 7 or set(ids) != set(alias_to_id.values()):
            raise DeltaLedgerError(
                f"assignments[{index}] does not cover the delta catalog"
            )
        if any(alias_to_id[alias] != font_id for alias, font_id in zip(aliases, ids)):
            raise DeltaLedgerError(
                f"assignments[{index}] alias-to-font binding changed"
            )
        require_sha(
            assignment.get("candidate_order_seed"),
            f"assignments[{index}].candidate_order_seed",
        )
        inventory_row = inventory[sample_id]
        for field in ("work_id", "source_page_sha256"):
            if assignment.get(field) != inventory_row.get(field):
                raise DeltaLedgerError(f"assignments[{index}] changed {field}")
    if set(stages_by_sample) != set(inventory):
        raise DeltaLedgerError("some review-ready samples lack assignments")
    for sample_id, stages in stages_by_sample.items():
        if "primary" not in stages:
            raise DeltaLedgerError(f"{sample_id}: primary assignment missing")

    return {
        "paths": paths,
        "source_report": source_report,
        "source_report_record_sha256": source_report_sha,
        "audit_report": audit_report,
        "audit_report_record_sha256": audit_report_sha,
        "selection": selection,
        "inventory": inventory,
        "master": master,
        "split_by_sample": split_by_sample,
        "storage_split_by_sample": storage_split_by_sample,
        "audit_by_sample": audit_by_sample,
        "assignments": assignments,
        "stages_by_sample": stages_by_sample,
        "alias_to_id": alias_to_id,
        "identity_tokens": identity_tokens,
        "old_candidates": old_candidate_set,
        "file_bindings": {name: _file_binding(path) for name, path in paths.items()},
    }


def _calibration_supplement_output_path(
    root: Path, value: Mapping[str, Any], name: str
) -> Path:
    location = f"calibration supplement.outputs.{name}"
    require_exact_keys(value, {"file", "sha256", "byte_size"}, location)
    if value.get("file") != name:
        raise DeltaLedgerError(f"{location}.file changed")
    expected_sha = require_sha(value.get("sha256"), f"{location}.sha256")
    size = value.get("byte_size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise DeltaLedgerError(f"{location}.byte_size must be non-negative integer")
    path = (root / name).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise DeltaLedgerError(f"{location} escapes its sealed root") from error
    if (
        not path.is_file()
        or path.stat().st_size != size
        or sha256_file(path) != expected_sha
    ):
        raise DeltaLedgerError(f"calibration supplement output changed: {path}")
    return path


def _reject_calibration_supplement_answers(value: Any, location: str) -> None:
    """Reject inherited font answers while allowing blind assignment ordering."""

    forbidden = {
        "prior_final_record",
        "prior_final_record_sha256",
        "font_judgment",
        "new_7_candidate_judgment",
        "baseline_font_id",
        "baseline_font_ids",
        "font_scores",
        "font_ranks",
        "candidate_scores",
        "candidate_ranks",
        "preferred",
        "acceptable",
        "marginal",
        "unacceptable",
        "unrenderable",
        "not_reviewed",
        "none_acceptable",
    }
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key).casefold() in forbidden:
                raise DeltaLedgerError(
                    f"{location}: calibration-only evidence contains inherited answer field {key}"
                )
            _reject_calibration_supplement_answers(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_calibration_supplement_answers(child, f"{location}[{index}]")


def _calibration_supplement_source_records(
    supplement: Mapping[str, Any],
) -> dict[str, str]:
    return {
        "calibration_supplement_manifest_record_sha256": require_sha(
            supplement.get("manifest_record_sha256"),
            "calibration supplement.manifest_record_sha256",
        ),
        "calibration_supplement_manifest_file_sha256": require_sha(
            supplement.get("manifest_file_sha256"),
            "calibration supplement.manifest_file_sha256",
        ),
        "calibration_supplement_preflight_final_report_record_sha256": require_sha(
            supplement.get("preflight_final_report_record_sha256"),
            "calibration supplement.preflight_final_report_record_sha256",
        ),
        "calibration_supplement_scored_samples_record_sha256": require_sha(
            supplement.get("preflight_scored_samples_record_sha256"),
            "calibration supplement.preflight_scored_samples_record_sha256",
        ),
        "calibration_supplement_quarantine_record_sha256": require_sha(
            supplement.get("preflight_quarantine_record_sha256"),
            "calibration supplement.preflight_quarantine_record_sha256",
        ),
        "calibration_supplement_successor_master_manifest_sha256": require_sha(
            supplement.get("successor_master_manifest_sha256"),
            "calibration supplement.successor_master_manifest_sha256",
        ),
        "calibration_supplement_successor_master_split_map_sha256": require_sha(
            supplement.get("successor_master_split_map_sha256"),
            "calibration supplement.successor_master_split_map_sha256",
        ),
        "calibration_supplement_successor_catalog_registry_sha256": require_sha(
            supplement.get("successor_catalog_registry_sha256"),
            "calibration supplement.successor_catalog_registry_sha256",
        ),
    }


def _merge_calibration_only_rows(
    source: dict[str, Any],
    *,
    closure_master: Mapping[str, Mapping[str, Any]],
    samples: Mapping[str, Mapping[str, Any]],
    inventory: Mapping[str, Mapping[str, Any]],
    assignments: Mapping[str, Mapping[str, Any]],
    stages_by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]],
    replace_existing_review_tasks: bool = False,
) -> None:
    """Merge review rows while keeping closure-only rows out of card inventory."""

    supplemental_ids = set(samples)
    if set(inventory) != supplemental_ids or set(stages_by_sample) != supplemental_ids:
        raise DeltaLedgerError("calibration supplement merge inventories differ")
    if not supplemental_ids.issubset(closure_master):
        raise DeltaLedgerError(
            "calibration supplement review rows escape their closure master"
        )
    for sample_id, master in closure_master.items():
        existing = source["master"].get(sample_id)
        if existing is not None:
            for expected, actual, label in (
                (
                    nested(existing, "work", "id"),
                    nested(master, "work", "id"),
                    "work",
                ),
                (
                    nested(existing, "page", "source_page_sha256"),
                    nested(master, "page", "source_page_sha256"),
                    "source page",
                ),
                (
                    existing.get("sample_crop_sha256"),
                    master.get("sample_crop_sha256"),
                    "crop",
                ),
            ):
                if expected != actual:
                    raise DeltaLedgerError(
                        f"calibration supplement master[{sample_id}] changed {label}"
                    )
        source["master"][sample_id] = master
        source["split_by_sample"][sample_id] = "train"
        source["storage_split_by_sample"][sample_id] = str(
            master.get("legacy_split") or "train"
        )
    for sample_id in supplemental_ids:
        if replace_existing_review_tasks:
            previous_stages = source["stages_by_sample"].pop(sample_id, {})
            for previous in previous_stages.values():
                assignment_id = previous.get("assignment_id")
                if not isinstance(assignment_id, str):
                    raise DeltaLedgerError(
                        f"successor authority prior task {sample_id} has no assignment ID"
                    )
                if source["assignments"].pop(assignment_id, None) is None:
                    raise DeltaLedgerError(
                        f"successor authority prior assignment disappeared: {assignment_id}"
                    )
            source.get("audit_by_sample", {}).pop(sample_id, None)
        source["selection"][sample_id] = samples[sample_id]
        source["inventory"][sample_id] = inventory[sample_id]
    for assignment_id, assignment in assignments.items():
        if assignment_id in source["assignments"]:
            raise DeltaLedgerError(
                f"calibration supplement assignment collision: {assignment_id}"
            )
        source["assignments"][assignment_id] = assignment
    for sample_id, stages in stages_by_sample.items():
        if sample_id in source["stages_by_sample"]:
            raise DeltaLedgerError(
                f"calibration supplement stage collision: {sample_id}"
            )
        source["stages_by_sample"][sample_id] = stages


def _load_calibration_only_supplement(
    manifest_path: Path,
    *,
    source: dict[str, Any],
    rubric: Path,
) -> dict[str, Any]:
    """Validate and merge a fresh-label-only calibration supplement.

    Only the explicitly listed supplemental samples enter the review inventory.
    The larger closure master is merged solely so quarantine/leakage validation
    can see every sibling; it never creates assignments or review cards.
    """

    resolved = manifest_path.resolve()
    manifest = read_json(resolved)
    validate_seal(manifest, "calibration supplement manifest")
    require_exact_keys(
        manifest,
        {
            "schema_version",
            "record_type",
            "owner",
            "round_id",
            "development_only",
            "fresh_blind_source_pass",
            "baseline_label_fields_present",
            "candidate_score_or_rank_fields_present",
            "parent_font_score_or_rank_inheritance_allowed",
            "training_disposition",
            "source_split",
            "test_lineage_sample_count",
            "supplemental_review_sample_count",
            "base_review_sample_count",
            "selected_sample_count",
            "candidate_assignment_count",
            "preflight_closure_sample_count",
            "closure_master_row_count",
            "quarantine_validation_only_sample_count",
            "closure_card_candidate_count",
            "supplemental_sample_ids",
            "supplemental_sample_ids_sha256",
            "selected_sample_ids_sha256",
            "training_quarantine_sample_ids",
            "training_quarantine_sample_ids_sha256",
            "inputs",
            "outputs",
            "record_sha256",
        },
        "calibration supplement manifest",
    )
    if (
        manifest.get("schema_version") != CALIBRATION_SUPPLEMENT_SCHEMA_VERSION
        or manifest.get("record_type") != CALIBRATION_SUPPLEMENT_RECORD_TYPE
        or manifest.get("owner") != CALIBRATION_SUPPLEMENT_OWNER
        or manifest.get("development_only") is not True
        or manifest.get("fresh_blind_source_pass") is not True
        or manifest.get("baseline_label_fields_present") is not False
        or manifest.get("candidate_score_or_rank_fields_present") is not False
        or manifest.get("parent_font_score_or_rank_inheritance_allowed") is not False
        or manifest.get("training_disposition")
        != CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION
        or manifest.get("source_split") != "train"
        or manifest.get("test_lineage_sample_count") != 0
        or manifest.get("closure_card_candidate_count") != 0
    ):
        raise DeltaLedgerError(
            "calibration supplement is not fresh, answer-free, train-only, and permanently quarantined"
        )
    round_id = require_id(manifest.get("round_id"), "calibration supplement.round_id")

    inputs = require_mapping(manifest.get("inputs"), "calibration supplement.inputs")
    expected_input_keys = {
        "base_ready_assignments",
        "base_ready_inventory",
        "base_source_report",
        "builder_source_sha256",
        "catalog_registry",
        "preflight_contract",
        "preflight_final_report",
        "preflight_final_report_record_sha256",
        "preflight_quarantine_closure",
        "preflight_quarantine_record_sha256",
        "preflight_scored_samples",
        "preflight_scored_samples_record_sha256",
        "render_bank_manifest",
        "rubric",
        "source_observations_input",
        "successor_catalog_registry_sha256",
        "successor_master_manifest",
        "successor_master_manifest_sha256",
        "successor_master_report",
        "successor_master_split_map",
        "successor_master_split_map_sha256",
    }
    require_exact_keys(inputs, expected_input_keys, "calibration supplement.inputs")
    input_paths: dict[str, Path] = {}
    for name in sorted(
        expected_input_keys
        - {
            "builder_source_sha256",
            "preflight_final_report_record_sha256",
            "preflight_quarantine_record_sha256",
            "preflight_scored_samples_record_sha256",
            "successor_catalog_registry_sha256",
            "successor_master_manifest_sha256",
            "successor_master_split_map_sha256",
        }
    ):
        input_paths[name] = _validate_file_binding(
            require_mapping(inputs.get(name), f"calibration supplement.inputs.{name}"),
            f"calibration supplement.inputs.{name}",
        )
    base_path_bindings = {
        "base_ready_assignments": "ready_assignments",
        "base_ready_inventory": "ready_inventory",
        "base_source_report": "source_report",
        "render_bank_manifest": "render_manifest",
    }
    for supplement_name, source_name in base_path_bindings.items():
        if input_paths[supplement_name] != source["paths"][source_name].resolve():
            raise DeltaLedgerError(
                f"calibration supplement binds another base {source_name}"
            )
    if input_paths["rubric"] != rubric.resolve():
        raise DeltaLedgerError("calibration supplement binds another review rubric")
    builder_path = (
        Path(__file__)
        .resolve()
        .with_name("build_font_matching_calibration_supplement_v5.py")
    )
    if require_sha(
        inputs.get("builder_source_sha256"),
        "calibration supplement.inputs.builder_source_sha256",
    ) != sha256_file(builder_path):
        raise DeltaLedgerError("calibration supplement builder source changed")
    if inputs.get("successor_master_manifest_sha256") != sha256_file(
        input_paths["successor_master_manifest"]
    ):
        raise DeltaLedgerError(
            "calibration supplement successor master binding changed"
        )
    if inputs.get("successor_master_split_map_sha256") != sha256_file(
        input_paths["successor_master_split_map"]
    ):
        raise DeltaLedgerError(
            "calibration supplement successor split-map binding changed"
        )
    successor_master_report = read_json(input_paths["successor_master_report"])
    successor_outputs = require_mapping(
        successor_master_report.get("outputs"),
        "calibration supplement successor master report.outputs",
    )
    if (
        successor_outputs.get("master_manifest_sha256")
        != inputs.get("successor_master_manifest_sha256")
        or successor_outputs.get("split_map_sha256")
        != inputs.get("successor_master_split_map_sha256")
        or successor_outputs.get("split_map")
        != input_paths["successor_master_split_map"].name
    ):
        raise DeltaLedgerError(
            "calibration supplement successor master report authority changed"
        )
    if inputs.get("successor_catalog_registry_sha256") != sha256_file(
        input_paths["catalog_registry"]
    ):
        raise DeltaLedgerError(
            "calibration supplement catalog registry binding changed"
        )

    final_report = read_json(input_paths["preflight_final_report"])
    scored = read_json(input_paths["preflight_scored_samples"])
    preflight_closure = read_json(input_paths["preflight_quarantine_closure"])
    for value, name, expected_record_sha in (
        (
            final_report,
            "preflight final report",
            inputs.get("preflight_final_report_record_sha256"),
        ),
        (
            scored,
            "preflight scored samples",
            inputs.get("preflight_scored_samples_record_sha256"),
        ),
        (
            preflight_closure,
            "preflight quarantine closure",
            inputs.get("preflight_quarantine_record_sha256"),
        ),
    ):
        if validate_seal(value, name) != require_sha(
            expected_record_sha, f"{name} record SHA"
        ):
            raise DeltaLedgerError(f"calibration supplement binds another {name}")
    if (
        scored.get("round_id") != round_id
        or preflight_closure.get("round_id") != round_id
    ):
        raise DeltaLedgerError("calibration supplement preflight round changed")

    selected_ids_list = _string_array(
        scored.get("sample_ids"), "calibration supplement scored.sample_ids"
    )
    selected_ids = set(selected_ids_list)
    if scored.get("sample_count") != len(selected_ids):
        raise DeltaLedgerError("calibration supplement scored count changed")
    supplemental_ids_list = _string_array(
        manifest.get("supplemental_sample_ids"),
        "calibration supplement.supplemental_sample_ids",
    )
    supplemental_ids = set(supplemental_ids_list)
    training_ids_list = _string_array(
        manifest.get("training_quarantine_sample_ids"),
        "calibration supplement.training_quarantine_sample_ids",
    )
    training_ids = set(training_ids_list)
    preflight_closure_ids = set(
        _string_array(
            preflight_closure.get("current_round_training_quarantine_sample_ids"),
            "preflight closure.current_round_training_quarantine_sample_ids",
        )
    )
    if preflight_closure.get("test_samples_present") is not False:
        raise DeltaLedgerError("calibration supplement preflight closure reaches test")
    if (
        len(supplemental_ids) != 7
        or len(selected_ids) != 60
        or len(selected_ids - supplemental_ids) != 53
        or len(preflight_closure_ids) != 117
        or len(training_ids) != 120
        or training_ids != preflight_closure_ids.union(supplemental_ids)
        or not selected_ids.issubset(training_ids)
    ):
        raise DeltaLedgerError(
            "calibration supplement exact 53+7/60/117/120 closure contract changed"
        )
    expected_count_values = {
        "supplemental_review_sample_count": 7,
        "base_review_sample_count": 53,
        "selected_sample_count": 60,
        "candidate_assignment_count": 14,
        "preflight_closure_sample_count": 117,
        "closure_master_row_count": 120,
        "quarantine_validation_only_sample_count": 113,
    }
    for key, expected in expected_count_values.items():
        if manifest.get(key) != expected:
            raise DeltaLedgerError(f"calibration supplement {key} changed")
    for key, values in (
        ("supplemental_sample_ids_sha256", supplemental_ids),
        ("selected_sample_ids_sha256", selected_ids),
        ("training_quarantine_sample_ids_sha256", training_ids),
    ):
        if manifest.get(key) != sha256_bytes(canonical_json_bytes(sorted(values))):
            raise DeltaLedgerError(f"calibration supplement {key} changed")
    if not (selected_ids - supplemental_ids).issubset(source["inventory"]):
        raise DeltaLedgerError(
            "calibration supplement base 53 left the review inventory"
        )
    if supplemental_ids.intersection(source["inventory"]):
        raise DeltaLedgerError(
            "calibration supplement attempts to replace a base review row"
        )

    outputs = require_mapping(manifest.get("outputs"), "calibration supplement.outputs")
    expected_output_names = {
        "assignments.jsonl",
        "closure-master.jsonl",
        "fresh-source-observations.jsonl",
        "inventory.jsonl",
        "samples.jsonl",
        "source-seal-primary.json",
        "source-seal-secondary.json",
    }
    require_exact_keys(outputs, expected_output_names, "calibration supplement.outputs")
    output_paths = {
        name: _calibration_supplement_output_path(
            resolved.parent,
            require_mapping(
                outputs.get(name), f"calibration supplement.outputs.{name}"
            ),
            name,
        )
        for name in sorted(expected_output_names)
    }

    closure_rows = read_jsonl(output_paths["closure-master.jsonl"])
    closure_master = _index_unique(
        closure_rows, "id", "calibration supplement closure master"
    )
    if set(closure_master) != training_ids:
        raise DeltaLedgerError(
            "calibration supplement closure master is not the exact quarantine"
        )
    for sample_id, row in closure_master.items():
        provenance = require_mapping(
            row.get("provenance"),
            f"calibration supplement master[{sample_id}].provenance",
        )
        if (
            row.get("split") != "train"
            or provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
        ):
            raise DeltaLedgerError(
                f"calibration supplement master[{sample_id}] is not real train data"
            )

    observation_rows = read_jsonl(output_paths["fresh-source-observations.jsonl"])
    observations: dict[tuple[str, str], Mapping[str, Any]] = {}
    for index, row in enumerate(observation_rows):
        validate_seal(row, f"calibration supplement observations[{index}]")
        sample_id = require_id(row.get("sample_id"), f"observations[{index}].sample_id")
        stage = require_text(row.get("stage"), f"observations[{index}].stage")
        if (
            row.get("schema_version")
            != "font-matching-calibration-source-observations-v5"
            or row.get("record_type") != "font_matching_calibration_source_observation"
            or row.get("round_id") != round_id
            or sample_id not in supplemental_ids
            or stage not in {"primary", "secondary"}
            or row.get("derived_role") not in ROLE_VALUES
            or (sample_id, stage) in observations
        ):
            raise DeltaLedgerError(
                "calibration supplement source observation contract changed"
            )
        observations[(sample_id, stage)] = row
    if set(observations) != {
        (sample_id, stage)
        for sample_id in supplemental_ids
        for stage in ("primary", "secondary")
    }:
        raise DeltaLedgerError(
            "calibration supplement lacks two independent source observations"
        )
    _reject_calibration_supplement_answers(
        observation_rows, "calibration supplement observations"
    )

    sample_rows = read_jsonl(output_paths["samples.jsonl"])
    samples = _index_unique(sample_rows, "sample_id", "calibration supplement samples")
    if set(samples) != supplemental_ids:
        raise DeltaLedgerError("calibration supplement sample inventory changed")
    for sample_id, row in samples.items():
        validate_seal(row, f"calibration supplement samples[{sample_id}]")
        if (
            row.get("schema_version") != CALIBRATION_SUPPLEMENT_SCHEMA_VERSION
            or row.get("record_type")
            != "font_matching_calibration_only_supplement_sample"
            or row.get("split") != "train"
            or row.get("baseline_label_fields_present") is not False
            or row.get("candidate_score_or_rank_fields_present") is not False
            or row.get("training_disposition")
            != CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION
        ):
            raise DeltaLedgerError(
                f"calibration supplement sample[{sample_id}] contract changed"
            )
        master = closure_master[sample_id]
        if row.get("successor_master_row_sha256") != sha256_bytes(
            canonical_json_bytes(master)
        ):
            raise DeltaLedgerError(
                f"calibration supplement sample[{sample_id}] master row changed"
            )
        if (
            row.get("work_id") != nested(master, "work", "id")
            or row.get("source_page_sha256")
            != nested(master, "page", "source_page_sha256")
            or row.get("sample_crop_sha256") != master.get("sample_crop_sha256")
            or row.get("source_catalog_id")
            != nested(master, "provenance", "source_catalog_id")
            or sorted(row.get("visual_lineage_conflict_keys", []))
            != sorted(_master_calibration_leakage_keys(master))
        ):
            raise DeltaLedgerError(
                f"calibration supplement sample[{sample_id}] core lineage changed"
            )
        expected_observation_shas = [
            observations[(sample_id, stage)]["record_sha256"]
            for stage in ("primary", "secondary")
        ]
        if (
            row.get("fresh_source_observation_record_sha256s")
            != expected_observation_shas
        ):
            raise DeltaLedgerError(
                f"calibration supplement sample[{sample_id}] source observations changed"
            )
    _reject_calibration_supplement_answers(
        sample_rows, "calibration supplement samples"
    )

    inventory_rows = read_jsonl(output_paths["inventory.jsonl"])
    inventory = _index_unique(
        inventory_rows, "sample_id", "calibration supplement inventory"
    )
    if set(inventory) != supplemental_ids:
        raise DeltaLedgerError("calibration supplement review inventory changed")
    successor_master_sha = require_sha(
        inputs.get("successor_master_manifest_sha256"),
        "calibration supplement successor master SHA",
    )
    for sample_id, row in inventory.items():
        validate_seal(row, f"calibration supplement inventory[{sample_id}]")
        provenance = require_mapping(
            row.get("provenance"), f"inventory[{sample_id}].provenance"
        )
        if (
            row.get("schema_version") != CALIBRATION_SUPPLEMENT_SCHEMA_VERSION
            or row.get("record_type")
            != "font_matching_calibration_only_review_inventory"
            or row.get("master_manifest_sha256") != successor_master_sha
            or row.get("training_disposition")
            != CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION
            or provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
            or row.get("work_id") != samples[sample_id].get("work_id")
            or row.get("source_page_sha256")
            != samples[sample_id].get("source_page_sha256")
            or row.get("fresh_source_observation_record_sha256s")
            != samples[sample_id].get("fresh_source_observation_record_sha256s")
        ):
            raise DeltaLedgerError(
                f"calibration supplement inventory[{sample_id}] changed"
            )

    assignment_rows = read_jsonl(output_paths["assignments.jsonl"])
    assignments = _index_unique(
        assignment_rows, "assignment_id", "calibration supplement assignments"
    )
    stages_by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    candidate_ids = set(source["alias_to_id"].values())
    for index, row in enumerate(assignment_rows):
        sample_id = require_id(
            row.get("sample_id"), f"supplement assignments[{index}].sample_id"
        )
        stage = require_text(row.get("stage"), f"supplement assignments[{index}].stage")
        if sample_id not in supplemental_ids or stage not in {"primary", "secondary"}:
            raise DeltaLedgerError(
                "calibration supplement assignment targets another inventory"
            )
        if stage in stages_by_sample[sample_id]:
            raise DeltaLedgerError(
                f"calibration supplement repeats {sample_id}/{stage}"
            )
        order = _string_array(
            row.get("candidate_order"),
            f"supplement assignments[{index}].candidate_order",
        )
        aliases = _string_array(
            row.get("blind_alias_order"),
            f"supplement assignments[{index}].blind_alias_order",
        )
        seed = require_sha(
            row.get("candidate_order_seed"),
            f"supplement assignments[{index}].candidate_order_seed",
        )
        if (
            row.get("schema_version") != 1
            or row.get("record_type") != "manga_font_label_assignment"
            or row.get("candidate_count") != 7
            or row.get("candidate_initial_state") != "not_reviewed"
            or row.get("blind_first_pass") is not True
            or row.get("release_state") != "ready"
            or row.get("font_names_visible") is not False
            or row.get("model_suggestions_visible") is not False
            or row.get("prior_tiers_visible") is not False
            or row.get("split_visible") is not False
            or tuple(row.get("adjudication_if", [])) != EXPECTED_TRIGGER_NAMES
            or set(order) != candidate_ids
            or order != deterministic_candidate_order(order, seed)
            or any(
                source["alias_to_id"].get(alias) != font_id
                for alias, font_id in zip(aliases, order)
            )
            or row.get("work_id") != inventory[sample_id].get("work_id")
            or row.get("source_page_sha256")
            != inventory[sample_id].get("source_page_sha256")
        ):
            raise DeltaLedgerError(
                f"calibration supplement assignment[{index}] changed"
            )
        expected_assignment_id = (
            "fmra-"
            + stable_hash(
                "manga-font-review-assignment-v1",
                sample_id,
                stage,
                str(row.get("catalog_version")),
                seed,
                *(str(value) for value in order),
            )[:32]
        )
        if row.get("assignment_id") != expected_assignment_id:
            raise DeltaLedgerError(
                f"calibration supplement assignment[{index}] ID changed"
            )
        independence = require_mapping(
            row.get("reviewer_independence"),
            f"supplement assignments[{index}].reviewer_independence",
        )
        if independence.get("required_for_secondary") is not (
            stage == "secondary"
        ) or independence.get("same_reviewer_as_primary_allowed") is not (
            False if stage == "secondary" else None
        ):
            raise DeltaLedgerError(
                f"calibration supplement assignment[{index}] independence changed"
            )
        stages_by_sample[sample_id][stage] = row
    if set(stages_by_sample) != supplemental_ids or any(
        set(stages) != {"primary", "secondary"} for stages in stages_by_sample.values()
    ):
        raise DeltaLedgerError(
            "calibration supplement assignments are not exact independent pairs"
        )
    for sample_id, row in samples.items():
        expected_ids = [
            stages_by_sample[sample_id][stage]["assignment_id"]
            for stage in ("primary", "secondary")
        ]
        if row.get("assignment_ids") != expected_ids:
            raise DeltaLedgerError(
                f"calibration supplement sample[{sample_id}] assignment binding changed"
            )

    observation_file_sha = sha256_file(output_paths["fresh-source-observations.jsonl"])
    inventory_file_sha = sha256_file(output_paths["inventory.jsonl"])
    rubric_sha = sha256_file(rubric.resolve())
    for stage in ("primary", "secondary"):
        source_seal = read_json(output_paths[f"source-seal-{stage}.json"])
        validate_seal(source_seal, f"calibration supplement source seal {stage}")
        if (
            source_seal.get("schema_version")
            != CALIBRATION_SUPPLEMENT_SOURCE_SEAL_SCHEMA_VERSION
            or source_seal.get("record_type")
            != CALIBRATION_SUPPLEMENT_SOURCE_SEAL_RECORD_TYPE
            or source_seal.get("development_only") is not True
            or source_seal.get("baseline_label_fields_present") is not False
            or source_seal.get("candidate_score_or_rank_fields_present") is not False
            or source_seal.get("training_disposition")
            != CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION
        ):
            raise DeltaLedgerError(
                f"calibration supplement source seal {stage} changed"
            )
        seal_inputs = require_mapping(
            source_seal.get("inputs"), f"source seal {stage}.inputs"
        )
        if dict(seal_inputs) != {
            "inventory_sha256": inventory_file_sha,
            "master_manifest_sha256": successor_master_sha,
            "rubric_sha256": rubric_sha,
            "fresh_source_observations_sha256": observation_file_sha,
        }:
            raise DeltaLedgerError(
                f"calibration supplement source seal {stage} inputs changed"
            )
        seal_samples = _index_unique(
            require_list(source_seal.get("samples"), f"source seal {stage}.samples"),
            "sample_id",
            f"source seal {stage}.samples",
        )
        if set(seal_samples) != supplemental_ids:
            raise DeltaLedgerError(
                f"calibration supplement source seal {stage} inventory changed"
            )
        for sample_id, seal_row in seal_samples.items():
            validate_seal(seal_row, f"source seal {stage}.samples[{sample_id}]")
            observation = observations[(sample_id, stage)]
            treatment = require_mapping(
                observation.get("treatment"),
                f"observation {sample_id}/{stage}.treatment",
            )
            if (
                seal_row.get("fresh_source_observation_record_sha256")
                != observation.get("record_sha256")
                or seal_row.get("sealed_role") != observation.get("derived_role")
                or seal_row.get("treatment")
                != {
                    "outline": treatment.get("outline"),
                    "shadow": treatment.get("shadow"),
                    "inverse": treatment.get("inverse_fill"),
                    "distortion": treatment.get("distortion"),
                    "texture": treatment.get("texture"),
                }
            ):
                raise DeltaLedgerError(
                    f"calibration supplement source seal {sample_id}/{stage} changed"
                )

    # Overlay the successor rows for the full closure.  Rows outside the seven
    # supplemental samples are deliberately absent from inventory/assignments.
    _merge_calibration_only_rows(
        source,
        closure_master=closure_master,
        samples=samples,
        inventory=inventory,
        assignments=assignments,
        stages_by_sample=stages_by_sample,
    )

    supplement = {
        "round_id": round_id,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_file_sha256": sha256_file(resolved),
        "preflight_final_report_record_sha256": final_report["record_sha256"],
        "preflight_scored_samples_record_sha256": scored["record_sha256"],
        "preflight_quarantine_record_sha256": preflight_closure["record_sha256"],
        "successor_master_manifest_sha256": successor_master_sha,
        "successor_master_split_map_sha256": require_sha(
            inputs.get("successor_master_split_map_sha256"),
            "calibration supplement successor split-map SHA",
        ),
        "successor_catalog_registry_sha256": require_sha(
            inputs.get("successor_catalog_registry_sha256"),
            "calibration supplement successor catalog registry SHA",
        ),
        "selected_sample_ids": sorted(selected_ids),
        "supplemental_sample_ids": sorted(supplemental_ids),
        "training_quarantine_sample_ids": sorted(training_ids),
        "preflight_closure_sample_ids": sorted(preflight_closure_ids),
        "closure_validation_only_sample_ids": sorted(training_ids - supplemental_ids),
        # Runtime-only paths.  The manifest has already sealed and revalidated
        # each binding above; keeping the resolved paths here lets a later
        # calibration round verify its fresh selection against the same
        # successor authority without serializing an untrusted path into the
        # workspace contract.
        "_successor_master_manifest_path": input_paths["successor_master_manifest"],
        "_successor_master_report_path": input_paths["successor_master_report"],
        "_successor_catalog_registry_path": input_paths["catalog_registry"],
        "_successor_master_split_map_path": input_paths["successor_master_split_map"],
    }
    source["calibration_only_supplement"] = supplement
    source["file_bindings"][CALIBRATION_SUPPLEMENT_SOURCE_FILE_KEY] = _file_binding(
        resolved
    )
    return supplement


def _successor_authority_intake_source_records(
    intake: Mapping[str, Any],
) -> dict[str, str]:
    return {
        "successor_authority_intake_manifest_record_sha256": require_sha(
            intake.get("manifest_record_sha256"),
            "successor authority intake manifest record SHA",
        ),
        "successor_authority_intake_manifest_file_sha256": require_sha(
            intake.get("manifest_file_sha256"),
            "successor authority intake manifest file SHA",
        ),
        "successor_authority_intake_selected_sample_ids_sha256": require_sha(
            intake.get("selected_sample_ids_sha256"),
            "successor authority intake selected IDs SHA",
        ),
        "successor_authority_intake_double_clean_pool_sample_ids_sha256": require_sha(
            intake.get("double_clean_pool_sample_ids_sha256"),
            "successor authority intake double-clean pool SHA",
        ),
        "successor_authority_intake_sample_ids_sha256": require_sha(
            intake.get("intake_sample_ids_sha256"),
            "successor authority intake IDs SHA",
        ),
    }


def _load_successor_authority_intake(
    manifest_path: Path,
    *,
    source: dict[str, Any],
    supplement: Mapping[str, Any],
    round_id: str,
) -> dict[str, Any]:
    """Validate and merge answer-free tasks for fresh successor-master rows."""

    try:
        from scripts import (
            build_font_matching_successor_authority_intake_v5 as intake_builder,
        )
    except (ImportError, ModuleNotFoundError):
        import build_font_matching_successor_authority_intake_v5 as intake_builder

    resolved = manifest_path.resolve()
    manifest = read_json(resolved)
    validate_seal(manifest, "successor authority intake manifest")
    require_exact_keys(
        manifest,
        {
            "schema_version",
            "record_type",
            "owner",
            "round_id",
            "development_only",
            "answer_free",
            "precheck_labels_inherited",
            "precheck_contaminated_sample_count",
            "precheck_contaminated_sample_ids",
            "precheck_contaminated_sample_ids_sha256",
            "source_annotation_state",
            "candidate_judgment_state",
            "eligibility_contract",
            "selection_manifest",
            "selected_sample_count",
            "selected_sample_ids",
            "selected_sample_ids_sha256",
            "double_clean_pool_count",
            "double_clean_pool_sample_ids_sha256",
            "double_clean_work_counts",
            "double_clean_stratum_counts",
            "intake_sample_count",
            "intake_sample_ids",
            "intake_sample_ids_sha256",
            "fresh_public_task_sample_count",
            "fresh_public_assignment_count",
            "reused_existing_task_sample_count",
            "superseded_existing_task_sample_count",
            "superseded_existing_task_sample_ids_sha256",
            "superseded_existing_assignment_count",
            "superseded_existing_assignment_ids_sha256",
            "selected_stratum_counts",
            "selected_work_counts",
            "inputs",
            "outputs",
            "record_sha256",
        },
        "successor authority intake manifest",
    )
    if (
        manifest.get("schema_version") != SUCCESSOR_AUTHORITY_INTAKE_SCHEMA_VERSION
        or manifest.get("record_type") != SUCCESSOR_AUTHORITY_INTAKE_RECORD_TYPE
        or manifest.get("owner") != SUCCESSOR_AUTHORITY_INTAKE_OWNER
        or manifest.get("round_id") != round_id
        or manifest.get("development_only") is not True
        or manifest.get("answer_free") is not True
        or manifest.get("precheck_labels_inherited") is not False
        or manifest.get("source_annotation_state") != "not_reviewed"
        or manifest.get("candidate_judgment_state") != "not_reviewed"
    ):
        raise DeltaLedgerError(
            "successor authority intake is not a fresh answer-free round"
        )
    expected_eligibility = {
        "candidate_font_pixels_viewed": False,
        "manual_source_view_required": True,
        "metadata_only_forbidden": True,
        "independent_clean_reviewers_per_selected_sample": 2,
        "disagreement_policy": "reject_or_fresh_replacement_only",
        "minimum_double_clean_reserve": 72,
    }
    if manifest.get("eligibility_contract") != expected_eligibility:
        raise DeltaLedgerError("successor authority intake eligibility gate changed")

    selection_value = require_mapping(
        manifest.get("selection_manifest"),
        "successor authority intake.selection_manifest",
    )
    require_exact_keys(
        selection_value,
        {"path", "sha256", "byte_size", "record_sha256"},
        "successor authority intake.selection_manifest",
    )
    selection_path = _validate_file_binding(
        {key: selection_value[key] for key in ("path", "sha256", "byte_size")},
        "successor authority intake.selection_manifest",
    )
    selected_ids, selection_binding = _read_successor_authority_selection_manifest(
        selection_path, round_id=round_id
    )
    if selection_value.get("record_sha256") != selection_binding["record_sha256"]:
        raise DeltaLedgerError("successor authority intake selection record changed")
    selected_list = _string_array(
        manifest.get("selected_sample_ids"),
        "successor authority intake.selected_sample_ids",
    )
    intake_list = _string_array(
        manifest.get("intake_sample_ids"),
        "successor authority intake.intake_sample_ids",
    )
    intake_ids = set(intake_list)
    selected_sha = sha256_bytes(canonical_json_bytes(sorted(selected_ids)))
    intake_sha = sha256_bytes(canonical_json_bytes(sorted(intake_ids)))
    if (
        len(selected_ids) != 60
        or selected_list != sorted(selected_ids)
        or manifest.get("selected_sample_count") != 60
        or manifest.get("selected_sample_ids_sha256") != selected_sha
        or intake_list != sorted(intake_ids)
        or manifest.get("intake_sample_count") != len(intake_ids)
        or manifest.get("intake_sample_ids_sha256") != intake_sha
        or intake_ids != selected_ids
        or manifest.get("fresh_public_task_sample_count") != 60
        or manifest.get("fresh_public_assignment_count") != 120
        or manifest.get("reused_existing_task_sample_count") != 0
    ):
        raise DeltaLedgerError("successor authority intake sample inventory changed")
    superseded_sample_ids = selected_ids.intersection(source["inventory"])
    superseded_assignment_ids = {
        str(assignment.get("assignment_id"))
        for sample_id in superseded_sample_ids
        for assignment in source["stages_by_sample"].get(sample_id, {}).values()
    }
    if (
        manifest.get("superseded_existing_task_sample_count")
        != len(superseded_sample_ids)
        or manifest.get("superseded_existing_task_sample_ids_sha256")
        != sha256_bytes(canonical_json_bytes(sorted(superseded_sample_ids)))
        or manifest.get("superseded_existing_assignment_count")
        != len(superseded_assignment_ids)
        or manifest.get("superseded_existing_assignment_ids_sha256")
        != sha256_bytes(canonical_json_bytes(sorted(superseded_assignment_ids)))
    ):
        raise DeltaLedgerError(
            "successor authority intake historical-task replacement closure changed"
        )

    inputs = require_mapping(
        manifest.get("inputs"), "successor authority intake.inputs"
    )
    input_keys = {
        "builder_source",
        "base_inventory",
        "base_assignments",
        "successor_master_manifest",
        "successor_master_report",
        "successor_split_map",
        "catalog_registry",
        "render_bank_manifest",
        "font_catalog_manifest",
        "precheck_reviews",
    }
    require_exact_keys(inputs, input_keys, "successor authority intake.inputs")
    input_paths: dict[str, Path] = {}
    for name in sorted(input_keys - {"precheck_reviews"}):
        input_paths[name] = _validate_file_binding(
            require_mapping(
                inputs.get(name), f"successor authority intake.inputs.{name}"
            ),
            f"successor authority intake.inputs.{name}",
        )
    expected_builder = (
        Path(__file__)
        .resolve()
        .with_name("build_font_matching_successor_authority_intake_v5.py")
    )
    expected_paths = {
        "builder_source": expected_builder,
        "base_inventory": source["paths"]["ready_inventory"].resolve(),
        "base_assignments": source["paths"]["ready_assignments"].resolve(),
        "successor_master_manifest": Path(
            supplement["_successor_master_manifest_path"]
        ).resolve(),
        "successor_master_report": Path(
            supplement["_successor_master_report_path"]
        ).resolve(),
        "successor_split_map": Path(
            supplement["_successor_master_split_map_path"]
        ).resolve(),
        "catalog_registry": Path(
            supplement["_successor_catalog_registry_path"]
        ).resolve(),
        "render_bank_manifest": Path(__file__).resolve().parents[1]
        / "datasets"
        / "fontclip-font-render-bank-v2"
        / "manifest.json",
        "font_catalog_manifest": Path(__file__).resolve().parents[1]
        / "datasets"
        / "fontclip-font-catalog-v2"
        / "manifest.json",
    }
    for name, expected in expected_paths.items():
        if input_paths[name] != expected:
            raise DeltaLedgerError(f"successor authority intake binds another {name}")

    precheck_values = require_list(
        inputs.get("precheck_reviews"),
        "successor authority intake.inputs.precheck_reviews",
    )
    summary_paths: list[Path] = []
    for index, value in enumerate(precheck_values):
        review = require_mapping(
            value, f"successor authority intake.precheck_reviews[{index}]"
        )
        summary = require_mapping(
            review.get("summary"), f"precheck_reviews[{index}].summary"
        )
        summary_paths.append(
            _validate_file_binding(summary, f"precheck_reviews[{index}].summary")
        )
    try:
        evidence, recomputed_prechecks, queue_by_sample = (
            intake_builder._load_prechecks(summary_paths)
        )
    except intake_builder.IntakeError as error:
        raise DeltaLedgerError(str(error)) from error
    if [dict(value) for value in precheck_values] != recomputed_prechecks:
        raise DeltaLedgerError("successor authority intake precheck binding changed")
    contaminated_ids = set(
        _string_array(
            manifest.get("precheck_contaminated_sample_ids"),
            "successor authority intake.precheck_contaminated_sample_ids",
        )
    )
    if (
        manifest.get("precheck_contaminated_sample_count") != len(contaminated_ids)
        or manifest.get("precheck_contaminated_sample_ids_sha256")
        != sha256_bytes(canonical_json_bytes(sorted(contaminated_ids)))
        or not contaminated_ids.issubset(evidence)
    ):
        raise DeltaLedgerError(
            "successor authority intake contaminated precheck exclusion changed"
        )
    double_clean = {
        sample_id
        for sample_id, rows in evidence.items()
        if len(rows) == 2
        and len({str(row["reviewer_id"]) for row in rows}) == 2
        and all(row["eligibility"] == "clean" for row in rows)
    }
    double_clean.difference_update(contaminated_ids)
    double_clean_sha = sha256_bytes(canonical_json_bytes(sorted(double_clean)))
    work_counts = Counter(
        str(queue_by_sample[sample_id].get("work_id")) for sample_id in double_clean
    )
    stratum_counts = Counter(
        str(queue_by_sample[sample_id].get("proposed_stratum"))
        for sample_id in double_clean
    )
    if (
        len(double_clean) < 72
        or len(work_counts) != 15
        or min(work_counts.values(), default=0) < 4
        or not selected_ids.issubset(double_clean)
        or manifest.get("double_clean_pool_count") != len(double_clean)
        or manifest.get("double_clean_pool_sample_ids_sha256") != double_clean_sha
        or manifest.get("double_clean_work_counts") != dict(sorted(work_counts.items()))
        or manifest.get("double_clean_stratum_counts")
        != dict(sorted(stratum_counts.items()))
    ):
        raise DeltaLedgerError(
            "successor authority intake no longer has a 72-sample/15-work/min4 "
            "double-clean reserve"
        )

    outputs = require_mapping(
        manifest.get("outputs"), "successor authority intake.outputs"
    )
    output_names = {
        "selected-master.jsonl",
        "inventory.jsonl",
        "assignments.jsonl",
        "samples.jsonl",
    }
    require_exact_keys(outputs, output_names, "successor authority intake.outputs")
    output_paths = {
        name: _calibration_supplement_output_path(
            resolved.parent,
            require_mapping(
                outputs.get(name), f"successor authority intake.outputs.{name}"
            ),
            name,
        )
        for name in sorted(output_names)
    }
    selected_master = _index_unique(
        read_jsonl(output_paths["selected-master.jsonl"]),
        "id",
        "successor authority intake selected master",
    )
    if set(selected_master) != selected_ids:
        raise DeltaLedgerError("successor authority intake selected master changed")
    authority_master = _successor_authority_rows(
        input_paths["successor_master_manifest"], selected_ids=selected_ids
    )
    if any(
        canonical_json_bytes(selected_master[sample_id])
        != canonical_json_bytes(authority_master[sample_id])
        for sample_id in selected_ids
    ):
        raise DeltaLedgerError("successor authority intake master rows changed")
    selected_work_counts = Counter(
        require_id(
            nested(row, "work", "id"),
            f"successor authority intake selected master[{sample_id}].work.id",
        )
        for sample_id, row in selected_master.items()
    )
    selected_stratum_counts = Counter(
        str(queue_by_sample[sample_id].get("proposed_stratum"))
        for sample_id in selected_ids
    )
    if (
        len(selected_work_counts) != 15
        or set(selected_work_counts.values()) != {4}
        or manifest.get("selected_work_counts")
        != dict(sorted(selected_work_counts.items()))
        or dict(selected_stratum_counts) != intake_builder.EXACT_STRATUM_COUNTS
        or manifest.get("selected_stratum_counts")
        != dict(sorted(selected_stratum_counts.items()))
    ):
        raise DeltaLedgerError(
            "successor authority intake selection is not exact 15-work x4 with "
            "the frozen scored quotas"
        )

    samples = _index_unique(
        read_jsonl(output_paths["samples.jsonl"]),
        "sample_id",
        "successor authority intake samples",
    )
    inventory = _index_unique(
        read_jsonl(output_paths["inventory.jsonl"]),
        "sample_id",
        "successor authority intake inventory",
    )
    if set(samples) != intake_ids or set(inventory) != intake_ids:
        raise DeltaLedgerError("successor authority intake review inventory changed")
    for sample_id in sorted(intake_ids):
        sample = samples[sample_id]
        row = selected_master[sample_id]
        validate_seal(sample, f"successor authority intake sample[{sample_id}]")
        evidence_rows = require_list(
            sample.get("eligibility_evidence"),
            f"successor authority intake sample[{sample_id}].eligibility_evidence",
        )
        expected_evidence = sorted(
            (
                {
                    key: item[key]
                    for key in (
                        "review_id",
                        "reviewer_id",
                        "decision_record_sha256",
                        "decision_file_sha256",
                        "queue_item_record_sha256",
                        "reviewed_source_surfaces_sha256",
                    )
                }
                for item in evidence[sample_id]
            ),
            key=lambda item: str(item["reviewer_id"]),
        )
        evidence_sha = sha256_bytes(canonical_json_bytes(expected_evidence))
        if (
            sample.get("schema_version") != SUCCESSOR_AUTHORITY_INTAKE_SCHEMA_VERSION
            or sample.get("record_type")
            != SUCCESSOR_AUTHORITY_INTAKE_SAMPLE_RECORD_TYPE
            or sample.get("split") != "train"
            or sample.get("successor_master_row_sha256")
            != sha256_bytes(canonical_json_bytes(row))
            or sample.get("work_id") != nested(row, "work", "id")
            or sample.get("source_page_sha256")
            != nested(row, "page", "source_page_sha256")
            or sample.get("sample_crop_sha256") != row.get("sample_crop_sha256")
            or sample.get("source_catalog_id")
            != nested(row, "provenance", "source_catalog_id")
            or sorted(sample.get("visual_lineage_conflict_keys", []))
            != sorted(_master_calibration_leakage_keys(row))
            or evidence_rows != expected_evidence
            or sample.get("eligibility_evidence_sha256") != evidence_sha
            or sample.get("precheck_labels_inherited") is not False
            or sample.get("baseline_label_fields_present") is not False
            or sample.get("candidate_score_or_rank_fields_present") is not False
            or sample.get("source_annotation_state") != "not_reviewed"
            or sample.get("candidate_judgment_state") != "not_reviewed"
            or sample.get("training_disposition")
            != SUCCESSOR_AUTHORITY_INTAKE_TRAINING_DISPOSITION
        ):
            raise DeltaLedgerError(
                f"successor authority intake sample[{sample_id}] changed"
            )
        inventory_row = inventory[sample_id]
        validate_seal(
            inventory_row, f"successor authority intake inventory[{sample_id}]"
        )
        provenance = require_mapping(
            inventory_row.get("provenance"), f"intake inventory[{sample_id}].provenance"
        )
        if (
            inventory_row.get("schema_version")
            != SUCCESSOR_AUTHORITY_INTAKE_SCHEMA_VERSION
            or inventory_row.get("record_type")
            != SUCCESSOR_AUTHORITY_INTAKE_INVENTORY_RECORD_TYPE
            or inventory_row.get("master_manifest_sha256")
            != sha256_file(input_paths["successor_master_manifest"])
            or inventory_row.get("work_id") != sample.get("work_id")
            or inventory_row.get("source_page_sha256")
            != sample.get("source_page_sha256")
            or inventory_row.get("eligibility_evidence_sha256") != evidence_sha
            or provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
            or inventory_row.get("training_disposition")
            != SUCCESSOR_AUTHORITY_INTAKE_TRAINING_DISPOSITION
        ):
            raise DeltaLedgerError(
                f"successor authority intake inventory[{sample_id}] changed"
            )

    assignment_rows = read_jsonl(output_paths["assignments.jsonl"])
    assignments = _index_unique(
        assignment_rows, "assignment_id", "successor authority intake assignments"
    )
    if len(assignments) != 120 or set(assignments).intersection(
        superseded_assignment_ids
    ):
        raise DeltaLedgerError(
            "successor authority intake did not issue 120 fresh public assignments"
        )
    stages_by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    try:
        fresh_candidate_ids, fresh_alias_by_id, fresh_catalog_version = (
            intake_builder._render_candidates(
                input_paths["render_bank_manifest"],
                input_paths["font_catalog_manifest"],
            )
        )
    except intake_builder.IntakeError as error:
        raise DeltaLedgerError(str(error)) from error
    candidate_ids = set(fresh_candidate_ids)
    if (
        candidate_ids != set(source["alias_to_id"].values())
        or {alias: font_id for font_id, alias in fresh_alias_by_id.items()}
        != source["alias_to_id"]
    ):
        raise DeltaLedgerError(
            "successor authority expanded-v2 new-seven binding changed"
        )
    for index, row in enumerate(assignment_rows):
        sample_id = require_id(
            row.get("sample_id"), f"intake assignments[{index}].sample_id"
        )
        stage = require_text(row.get("stage"), f"intake assignments[{index}].stage")
        order = _string_array(
            row.get("candidate_order"), f"intake assignments[{index}].candidate_order"
        )
        aliases = _string_array(
            row.get("blind_alias_order"),
            f"intake assignments[{index}].blind_alias_order",
        )
        seed = require_sha(
            row.get("candidate_order_seed"), f"intake assignments[{index}].seed"
        )
        if sample_id not in intake_ids or stage not in {"primary", "secondary"}:
            raise DeltaLedgerError(
                "successor authority intake assignment escaped inventory"
            )
        if stage in stages_by_sample[sample_id]:
            raise DeltaLedgerError(
                f"successor authority intake repeats {sample_id}/{stage}"
            )
        if (
            row.get("schema_version") != 1
            or row.get("record_type") != "manga_font_label_assignment"
            or row.get("candidate_count") != 7
            or row.get("catalog_version") != fresh_catalog_version
            or row.get("candidate_initial_state") != "not_reviewed"
            or row.get("blind_first_pass") is not True
            or row.get("release_state") != "ready"
            or row.get("font_names_visible") is not False
            or row.get("model_suggestions_visible") is not False
            or row.get("prior_tiers_visible") is not False
            or row.get("split_visible") is not False
            or tuple(row.get("adjudication_if", [])) != EXPECTED_TRIGGER_NAMES
            or set(order) != candidate_ids
            or order != deterministic_candidate_order(order, seed)
            or any(
                source["alias_to_id"].get(alias) != font_id
                for alias, font_id in zip(aliases, order)
            )
            or row.get("work_id") != inventory[sample_id].get("work_id")
            or row.get("source_page_sha256")
            != inventory[sample_id].get("source_page_sha256")
        ):
            raise DeltaLedgerError(
                f"successor authority intake assignment[{index}] changed"
            )
        expected_assignment_id = (
            "fmra-"
            + stable_hash(
                "manga-font-review-assignment-v1",
                sample_id,
                stage,
                str(row.get("catalog_version")),
                seed,
                *(str(value) for value in order),
            )[:32]
        )
        independence = require_mapping(
            row.get("reviewer_independence"),
            f"intake assignments[{index}].reviewer_independence",
        )
        if (
            row.get("assignment_id") != expected_assignment_id
            or independence.get("required_for_secondary") is not (stage == "secondary")
            or independence.get("same_reviewer_as_primary_allowed")
            is not (False if stage == "secondary" else None)
        ):
            raise DeltaLedgerError(
                f"successor authority intake assignment[{index}] identity changed"
            )
        stages_by_sample[sample_id][stage] = row
    if set(stages_by_sample) != intake_ids or any(
        set(stages) != {"primary", "secondary"} for stages in stages_by_sample.values()
    ):
        raise DeltaLedgerError(
            "successor authority intake assignments are not independent pairs"
        )
    for sample_id, sample in samples.items():
        if sample.get("assignment_ids") != [
            stages_by_sample[sample_id][stage]["assignment_id"]
            for stage in ("primary", "secondary")
        ]:
            raise DeltaLedgerError(
                f"successor authority intake sample[{sample_id}] assignment changed"
            )
    _reject_calibration_supplement_answers(
        [*samples.values(), *inventory.values()],
        "successor authority intake answer-free rows",
    )
    _merge_calibration_only_rows(
        source,
        closure_master=selected_master,
        samples=samples,
        inventory=inventory,
        assignments=assignments,
        stages_by_sample=stages_by_sample,
        replace_existing_review_tasks=True,
    )
    intake = {
        "round_id": round_id,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_file_sha256": sha256_file(resolved),
        "selected_sample_ids": sorted(selected_ids),
        "selected_sample_ids_sha256": selected_sha,
        "double_clean_pool_sample_ids": sorted(double_clean),
        "double_clean_pool_sample_ids_sha256": double_clean_sha,
        "intake_sample_ids": sorted(intake_ids),
        "intake_sample_ids_sha256": intake_sha,
        "selection_manifest_record_sha256": selection_binding["record_sha256"],
        "selection_manifest_file_sha256": selection_binding["file"]["sha256"],
    }
    source["successor_authority_intake"] = intake
    source["file_bindings"][SUCCESSOR_AUTHORITY_INTAKE_SOURCE_FILE_KEY] = _file_binding(
        resolved
    )
    return intake


def _source_record_bindings(
    source: Mapping[str, Any],
    *,
    v5_required: bool,
    successor_authority_only: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    records: dict[str, Any] = {
        "rescue_report_record_sha256": source["source_report_record_sha256"],
        "font_signal_audit_report_record_sha256": source["audit_report_record_sha256"],
        "expanded_catalog_sha256": nested(
            source["source_report"], "inputs", "expanded_catalog_sha256"
        ),
        "expanded_render_bank_sha256": nested(
            source["source_report"], "inputs", "expanded_render_bank_sha256"
        ),
        "master_manifest_sha256": nested(
            source["source_report"], "inputs", "master_manifest_sha256"
        ),
        "catalog_registry_sha256": nested(
            source["source_report"], "inputs", "catalog_registry_sha256"
        ),
    }
    supplement = source.get("calibration_only_supplement")
    if isinstance(supplement, Mapping):
        records.update(_calibration_supplement_source_records(supplement))
    intake = source.get("successor_authority_intake")
    if isinstance(intake, Mapping):
        records.update(_successor_authority_intake_source_records(intake))
    if v5_required:
        records["master_split_map_sha256"] = (
            require_sha(
                supplement.get("successor_master_split_map_sha256"),
                "calibration supplement.successor_master_split_map_sha256",
            )
            if isinstance(supplement, Mapping)
            else require_sha(
                nested(source["source_report"], "inputs", "master_split_map_sha256"),
                "source report.inputs.master_split_map_sha256",
            )
        )
    if successor_authority_only is not None:
        if not isinstance(supplement, Mapping):
            raise DeltaLedgerError(
                "successor-authority-only source binding requires a sealed supplement"
            )
        records.update(
            {
                "successor_authority_only_selection_sample_ids_sha256": require_sha(
                    successor_authority_only.get("selected_sample_ids_sha256"),
                    "successor authority selection IDs SHA",
                ),
                "successor_authority_only_selection_records_sha256": require_sha(
                    successor_authority_only.get("selected_authority_records_sha256"),
                    "successor authority selection records SHA",
                ),
                "successor_authority_only_selection_manifest_file_sha256": require_sha(
                    nested(
                        successor_authority_only,
                        "selection_manifest",
                        "sha256",
                    ),
                    "successor authority selection manifest file SHA",
                ),
                "successor_authority_only_selection_manifest_record_sha256": require_sha(
                    successor_authority_only.get("selection_manifest_record_sha256"),
                    "successor authority selection manifest record SHA",
                ),
                "successor_authority_only_training_quarantine_sample_ids_sha256": require_sha(
                    successor_authority_only.get(
                        "successor_training_quarantine_sample_ids_sha256"
                    ),
                    "successor authority training quarantine SHA",
                ),
            }
        )
    return records


def _selection_prior_final_record_sha256(
    selection: Mapping[str, Any], *, location: str
) -> str | None:
    if (
        selection.get("schema_version") == CALIBRATION_SUPPLEMENT_SCHEMA_VERSION
        and selection.get("record_type")
        == "font_matching_calibration_only_supplement_sample"
    ):
        if (
            selection.get("baseline_label_fields_present") is not False
            or selection.get("candidate_score_or_rank_fields_present") is not False
            or selection.get("training_disposition")
            != CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION
        ):
            raise DeltaLedgerError(
                f"{location}: calibration-only selection answer contract changed"
            )
        return None
    if (
        selection.get("schema_version") == SUCCESSOR_AUTHORITY_INTAKE_SCHEMA_VERSION
        and selection.get("record_type")
        == SUCCESSOR_AUTHORITY_INTAKE_SAMPLE_RECORD_TYPE
    ):
        if (
            selection.get("precheck_labels_inherited") is not False
            or selection.get("baseline_label_fields_present") is not False
            or selection.get("candidate_score_or_rank_fields_present") is not False
            or selection.get("source_annotation_state") != "not_reviewed"
            or selection.get("candidate_judgment_state") != "not_reviewed"
            or selection.get("training_disposition")
            != SUCCESSOR_AUTHORITY_INTAKE_TRAINING_DISPOSITION
        ):
            raise DeltaLedgerError(
                f"{location}: successor intake answer contract changed"
            )
        return None
    return require_sha(
        nested(selection, "merge_provenance", "prior_final_record_sha256"),
        f"{location}.merge_provenance.prior_final_record_sha256",
    )


def _walk_identity_leaks(
    value: Any,
    *,
    candidate_ids: set[str],
    identity_tokens: set[str],
    location: str,
) -> None:
    forbidden_keys = {
        "font_id",
        "font_label",
        "font_name",
        "css_family",
        "face_id",
        "display_id",
        "candidate_display_id",
        "source_file",
        "candidate_order",
        "reveal_map",
    }
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key).casefold() in forbidden_keys:
                raise DeltaLedgerError(f"{location}: blind surface exposes {key}")
            _walk_identity_leaks(
                child,
                candidate_ids=candidate_ids,
                identity_tokens=identity_tokens,
                location=f"{location}.{key}",
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _walk_identity_leaks(
                child,
                candidate_ids=candidate_ids,
                identity_tokens=identity_tokens,
                location=f"{location}[{index}]",
            )
    elif isinstance(value, str):
        folded = value.casefold()
        if value in candidate_ids or folded in identity_tokens:
            raise DeltaLedgerError(
                f"{location}: blind surface exposes candidate identity"
            )


def _card_manifest_bindings(
    manifest_paths: Sequence[Path],
    *,
    expected_stage: str,
    source: Mapping[str, Any],
    verify_card_files: bool,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if not manifest_paths:
        raise DeltaLedgerError(
            f"at least one {expected_stage} card manifest is required"
        )
    cards: dict[str, dict[str, Any]] = {}
    manifest_file_bindings: list[dict[str, Any]] = []
    assignments = require_mapping(source.get("assignments"), "source.assignments")
    candidate_ids = set(
        require_mapping(source.get("alias_to_id"), "source.alias_to_id").values()
    )
    identity_tokens = set(source.get("identity_tokens", set()))

    for manifest_index, manifest_path_value in enumerate(manifest_paths):
        manifest_path = manifest_path_value.resolve()
        manifest = read_json(manifest_path)
        blindness = require_mapping(
            manifest.get("blindness_contract"),
            f"card manifest[{manifest_index}].blindness_contract",
        )
        required_blindness = {
            "candidate_identity_fields_present": False,
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "public_candidates_use_blind_alias_only": True,
            "reveal_map_embedded": False,
            "same_work_references_anonymous": True,
        }
        for key, expected in required_blindness.items():
            if blindness.get(key) is not expected:
                raise DeltaLedgerError(
                    f"card manifest[{manifest_index}] violates blindness contract {key}"
                )
        manifest_cards = require_list(
            manifest.get("cards"), f"card manifest[{manifest_index}].cards"
        )
        if manifest.get("card_count") != len(manifest_cards):
            raise DeltaLedgerError(
                f"card manifest[{manifest_index}] card_count differs"
            )
        manifest_sha = sha256_file(manifest_path)
        manifest_file_bindings.append(_file_binding(manifest_path))

        for card_index, card_value in enumerate(manifest_cards):
            card = require_mapping(
                card_value, f"card manifest[{manifest_index}].cards[{card_index}]"
            )
            _walk_identity_leaks(
                card,
                candidate_ids=candidate_ids,
                identity_tokens=identity_tokens,
                location=f"card manifest[{manifest_index}].cards[{card_index}]",
            )
            assignment_value = require_mapping(
                card.get("assignment"),
                f"card manifest[{manifest_index}].cards[{card_index}].assignment",
            )
            assignment_id = require_id(
                assignment_value.get("assignment_id"),
                f"card manifest[{manifest_index}].cards[{card_index}].assignment_id",
            )
            if assignment_id in cards:
                raise DeltaLedgerError(f"duplicate review card for {assignment_id}")
            source_assignment = assignments.get(assignment_id)
            if source_assignment is None:
                raise DeltaLedgerError(
                    f"review card references unknown assignment {assignment_id}"
                )
            if source_assignment.get("stage") != expected_stage:
                raise DeltaLedgerError(
                    f"{assignment_id}: card appears in wrong stage manifest"
                )
            expected_fields = {
                "sample_id": source_assignment.get("sample_id"),
                "stage": expected_stage,
                "candidate_order_seed": source_assignment.get("candidate_order_seed"),
                "catalog_version": source_assignment.get("catalog_version"),
            }
            for field, expected in expected_fields.items():
                if assignment_value.get(field) != expected:
                    raise DeltaLedgerError(f"{assignment_id}: card changed {field}")
            alias_order = _string_array(
                assignment_value.get("blind_candidate_order"),
                f"{assignment_id}.blind_candidate_order",
            )
            if alias_order != list(source_assignment.get("blind_alias_order", [])):
                raise DeltaLedgerError(f"{assignment_id}: card candidate order changed")

            candidate_rows = require_list(
                card.get("candidates"), f"{assignment_id}.candidates"
            )
            candidate_aliases: list[str] = []
            mandatory_unrenderable: list[str] = []
            for candidate_index, candidate_value in enumerate(candidate_rows):
                candidate = require_mapping(
                    candidate_value, f"{assignment_id}.candidates[{candidate_index}]"
                )
                alias = require_text(
                    candidate.get("blind_alias"),
                    f"{assignment_id}.candidates[{candidate_index}].blind_alias",
                )
                if not ALIAS_RE.fullmatch(alias):
                    raise DeltaLedgerError(f"{assignment_id}: non-opaque card alias")
                if candidate.get("position") != candidate_index + 1:
                    raise DeltaLedgerError(
                        f"{assignment_id}: card candidate position changed"
                    )
                candidate_aliases.append(alias)
                if candidate.get("status") != "rendered":
                    mandatory_unrenderable.append(alias)
            if candidate_aliases != alias_order:
                raise DeltaLedgerError(
                    f"{assignment_id}: card candidate rows changed order"
                )

            artifact = require_mapping(
                card.get("artifact"), f"{assignment_id}.artifact"
            )
            card_sha = require_sha(
                artifact.get("sha256"), f"{assignment_id}.artifact.sha256"
            )
            if (
                artifact.get("qa_overlay") is not True
                or artifact.get("watermark") != "REVIEW-ONLY"
            ):
                raise DeltaLedgerError(
                    f"{assignment_id}: review card lacks QA-only marking"
                )
            relative_file = require_text(
                artifact.get("file"), f"{assignment_id}.artifact.file"
            )
            relative_path = Path(relative_file)
            if relative_path.is_absolute() or ".." in relative_path.parts:
                raise DeltaLedgerError(f"{assignment_id}: unsafe card artifact path")
            card_path = (manifest_path.parent / relative_path).resolve()
            try:
                card_path.relative_to(manifest_path.parent.resolve())
            except ValueError as error:
                raise DeltaLedgerError(
                    f"{assignment_id}: card path escapes manifest root"
                ) from error
            if verify_card_files:
                if not card_path.is_file() or sha256_file(card_path) != card_sha:
                    raise DeltaLedgerError(
                        f"{assignment_id}: review-card bytes changed"
                    )
            cards[assignment_id] = {
                "assignment_id": assignment_id,
                "sample_id": source_assignment["sample_id"],
                "stage": expected_stage,
                "candidate_order_seed": source_assignment["candidate_order_seed"],
                "blind_alias_order": alias_order,
                "review_card_sha256": card_sha,
                "review_card_file": str(card_path),
                "card_manifest_sha256": manifest_sha,
                "mandatory_unrenderable": mandatory_unrenderable,
            }
    return cards, manifest_file_bindings


def _v5_split_card_bindings(
    manifest_paths: Sequence[Path],
    *,
    expected_stage: str,
    cards: Mapping[str, dict[str, Any]],
    verify_card_files: bool,
) -> list[dict[str, Any]]:
    if not manifest_paths:
        raise DeltaLedgerError(
            f"v5 requires at least one {expected_stage} split-card manifest"
        )
    seen: set[str] = set()
    bindings: list[dict[str, Any]] = []
    for manifest_index, manifest_path_value in enumerate(manifest_paths):
        manifest_path = manifest_path_value.resolve()
        manifest = read_json(manifest_path)
        validate_seal(manifest, f"v5 split manifest[{manifest_index}]")
        if (
            manifest.get("schema_version") != V5_SPLIT_SCHEMA_VERSION
            or manifest.get("record_type") != "font_matching_review_card_split_manifest"
            or manifest.get("purpose")
            != "review_only_physical_source_candidate_separation"
            or manifest.get("training_asset") is not False
            or manifest.get("qa_overlay") is not True
        ):
            raise DeltaLedgerError(
                f"v5 split manifest[{manifest_index}] has another contract"
            )
        split_contract = require_mapping(
            manifest.get("split_contract"),
            f"v5 split manifest[{manifest_index}].split_contract",
        )
        required_split = {
            "candidate_pixels_visible_in_source_stage": False,
            "lossless_vertical_rejoin_required": True,
            "source_candidate_pixel_overlap": 0,
            "source_stage_must_be_sealed_before_candidate_stage": True,
        }
        for key, expected in required_split.items():
            if split_contract.get(key) != expected:
                raise DeltaLedgerError(
                    f"v5 split manifest[{manifest_index}] violates {key}"
                )
        source_manifest = require_mapping(
            manifest.get("source_manifest"),
            f"v5 split manifest[{manifest_index}].source_manifest",
        )
        source_manifest_sha = require_sha(
            source_manifest.get("sha256"),
            f"v5 split manifest[{manifest_index}].source_manifest.sha256",
        )
        rows = require_list(
            manifest.get("cards"), f"v5 split manifest[{manifest_index}].cards"
        )
        if manifest.get("card_count") != len(rows):
            raise DeltaLedgerError(
                f"v5 split manifest[{manifest_index}] card_count changed"
            )
        for row_index, row_value in enumerate(rows):
            row = require_mapping(
                row_value,
                f"v5 split manifest[{manifest_index}].cards[{row_index}]",
            )
            assignment_id = require_id(
                row.get("assignment_id"),
                f"v5 split manifest[{manifest_index}].cards[{row_index}].assignment_id",
            )
            if assignment_id in seen:
                raise DeltaLedgerError(f"duplicate v5 split card for {assignment_id}")
            base = cards.get(assignment_id)
            if base is None:
                raise DeltaLedgerError(
                    f"v5 split card references unknown assignment {assignment_id}"
                )
            if row.get("stage") != expected_stage or row.get("sample_id") != base.get(
                "sample_id"
            ):
                raise DeltaLedgerError(
                    f"{assignment_id}: v5 split stage/sample changed"
                )
            if source_manifest_sha != base.get("card_manifest_sha256"):
                raise DeltaLedgerError(
                    f"{assignment_id}: v5 split source manifest binding changed"
                )
            descriptors: dict[str, dict[str, Any]] = {}
            decoded_images: dict[str, Any] = {}
            for name in ("full_card", "source_only", "candidate_only"):
                descriptor = require_mapping(row.get(name), f"{assignment_id}.{name}")
                sha = require_sha(
                    descriptor.get("sha256"), f"{assignment_id}.{name}.sha256"
                )
                pixel_sha = require_sha(
                    descriptor.get("pixel_sha256"),
                    f"{assignment_id}.{name}.pixel_sha256",
                )
                size = require_list(
                    descriptor.get("size_px"), f"{assignment_id}.{name}.size_px"
                )
                if len(size) != 2 or any(
                    isinstance(item, bool) or not isinstance(item, int) or item <= 0
                    for item in size
                ):
                    raise DeltaLedgerError(f"{assignment_id}.{name}.size_px is invalid")
                file_value = require_text(
                    descriptor.get("file"), f"{assignment_id}.{name}.file"
                )
                if name == "full_card":
                    path = Path(file_value).resolve()
                else:
                    relative = PurePosixPath(file_value)
                    if relative.is_absolute() or ".." in relative.parts:
                        raise DeltaLedgerError(f"{assignment_id}.{name}.file is unsafe")
                    path = (manifest_path.parent / Path(*relative.parts)).resolve()
                    try:
                        path.relative_to(manifest_path.parent.resolve())
                    except ValueError as error:
                        raise DeltaLedgerError(
                            f"{assignment_id}.{name}.file escapes split root"
                        ) from error
                if verify_card_files and (
                    not path.is_file() or sha256_file(path) != sha
                ):
                    raise DeltaLedgerError(f"{assignment_id}: {name} bytes changed")
                if verify_card_files:
                    decoded_images[name] = _open_v5_review_image(
                        path,
                        expected_pixel_sha256=pixel_sha,
                        expected_size=(int(size[0]), int(size[1])),
                        location=f"{assignment_id}.{name}",
                    )
                descriptors[name] = {
                    "file": str(path),
                    "sha256": sha,
                    "pixel_sha256": pixel_sha,
                    "size_px": list(size),
                }
            if descriptors["full_card"]["sha256"] != base.get("review_card_sha256"):
                raise DeltaLedgerError(
                    f"{assignment_id}: full-card SHA differs from the sealed review card"
                )
            if (
                Path(descriptors["full_card"]["file"])
                != Path(
                    require_text(base.get("review_card_file"), "review_card_file")
                ).resolve()
            ):
                raise DeltaLedgerError(
                    f"{assignment_id}: full-card path differs from the sealed review card"
                )
            if len({value["sha256"] for value in descriptors.values()}) != 3:
                raise DeltaLedgerError(
                    f"{assignment_id}: full/source/candidate files are not distinct"
                )
            if verify_card_files:
                _validate_v5_review_image_rejoin(
                    assignment_id=assignment_id,
                    full=decoded_images["full_card"],
                    source=decoded_images["source_only"],
                    candidate=decoded_images["candidate_only"],
                    split_contract=split_contract,
                )
            base["v5_review_cards"] = descriptors
            seen.add(assignment_id)
        # The split tree contains candidate-B paths and hashes.  Initialization
        # may verify it, but the pre-release workspace binds only opaque bytes;
        # the actual path must be presented again at release time.
        bindings.append(_opaque_file_binding(manifest_path))
    missing = sorted(set(cards) - seen)
    if missing:
        raise DeltaLedgerError(
            f"v5 split manifests do not cover {expected_stage} cards: {missing[:5]}"
        )
    return bindings


def _v5_pixel_sha256(image: Any) -> str:
    rgb = image.convert("RGB")
    digest = hashlib.sha256()
    digest.update(b"font-matching-review-rgb-v1\0")
    digest.update(rgb.width.to_bytes(4, "big"))
    digest.update(rgb.height.to_bytes(4, "big"))
    digest.update(rgb.tobytes())
    return digest.hexdigest()


def _open_v5_review_image(
    path: Path,
    *,
    expected_pixel_sha256: str,
    expected_size: tuple[int, int],
    location: str,
) -> Any:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:  # pragma: no cover - packaging invariant
        raise DeltaLedgerError("v5 split verification requires Pillow") from error
    try:
        with Image.open(path) as probe:
            probe.verify()
        with Image.open(path) as source:
            source.load()
            image = source.convert("RGB")
    except (OSError, UnidentifiedImageError) as error:
        raise DeltaLedgerError(
            f"{location} is not a decodable image: {error}"
        ) from error
    if image.size != expected_size:
        raise DeltaLedgerError(
            f"{location} decoded size {image.size} differs from {expected_size}"
        )
    if _v5_pixel_sha256(image) != expected_pixel_sha256:
        raise DeltaLedgerError(f"{location} pixel SHA changed")
    return image


def _validate_v5_review_image_rejoin(
    *,
    assignment_id: str,
    full: Any,
    source: Any,
    candidate: Any,
    split_contract: Mapping[str, Any],
) -> None:
    if (
        full.width != source.width
        or full.width != candidate.width
        or full.height != source.height + candidate.height
    ):
        raise DeltaLedgerError(
            f"{assignment_id}: source/candidate geometry does not cover the full card"
        )
    expected_geometry = {
        "canvas_px": [full.width, full.height],
        "source_box_px": [0, 0, full.width, source.height],
        "candidate_box_px": [0, source.height, full.width, full.height],
    }
    for key, expected in expected_geometry.items():
        actual = (
            split_contract.get("full_size_px")
            if key == "canvas_px" and "canvas_px" not in split_contract
            else split_contract.get(key)
        )
        if actual != expected:
            raise DeltaLedgerError(
                f"{assignment_id}: split contract geometry differs for {key}"
            )
    from PIL import Image

    joined = Image.new("RGB", full.size)
    joined.paste(source, (0, 0))
    joined.paste(candidate, (0, source.height))
    if _v5_pixel_sha256(joined) != _v5_pixel_sha256(full):
        raise DeltaLedgerError(
            f"{assignment_id}: lossless source/candidate rejoin failed"
        )


def _read_sample_ids(path: Path) -> set[str]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise DeltaLedgerError(
            f"cannot read calibration sample IDs: {error}"
        ) from error
    stripped = text.strip()
    if not stripped:
        raise DeltaLedgerError("calibration sample ID file is empty")
    ids: list[str] = []
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise DeltaLedgerError(
                f"invalid calibration sample ID JSON: {error}"
            ) from error
        if isinstance(value, Mapping):
            validate_seal(value, "calibration sample ID manifest")
            values = require_list(
                value.get("sample_ids"), "calibration sample ID manifest.sample_ids"
            )
            if value.get("sample_count") != len(values):
                raise DeltaLedgerError("calibration sample ID manifest count changed")
        else:
            values = require_list(value, "calibration sample IDs")
        ids = [
            require_id(item, f"calibration sample IDs[{index}]")
            for index, item in enumerate(values)
        ]
    else:
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                value = line.strip()
            if isinstance(value, Mapping):
                value = value.get("sample_id")
            ids.append(require_id(value, f"calibration sample IDs:{line_number}"))
    if len(ids) != len(set(ids)):
        raise DeltaLedgerError("calibration sample ID file contains duplicates")
    return set(ids)


def _read_successor_authority_selection_manifest(
    path: Path, *, round_id: str
) -> tuple[set[str], dict[str, Any]]:
    resolved = path.resolve()
    value = read_json(resolved)
    validate_seal(value, "successor authority selection manifest")
    require_exact_keys(
        value,
        {
            "schema_version",
            "record_type",
            "round_id",
            "development_only",
            "source_authority",
            "sample_count",
            "sample_ids",
            "record_sha256",
        },
        "successor authority selection manifest",
    )
    sample_ids = _string_array(
        value.get("sample_ids"), "successor authority selection.sample_ids"
    )
    if (
        value.get("schema_version") != SCHEMA_VERSION
        or value.get("record_type") != SUCCESSOR_AUTHORITY_SELECTION_RECORD_TYPE
        or value.get("round_id") != round_id
        or value.get("development_only") is not True
        or value.get("source_authority") != "sealed_successor_master_registry_split"
        or value.get("sample_count") != 60
        or len(sample_ids) != 60
        or sample_ids != sorted(sample_ids)
        or len(sample_ids) != len(set(sample_ids))
    ):
        raise DeltaLedgerError(
            "successor authority selection manifest is not a sealed fresh 60-sample round"
        )
    return set(sample_ids), {
        "file": _file_binding(resolved),
        "record_sha256": require_sha(
            value.get("record_sha256"),
            "successor authority selection manifest record SHA",
        ),
        "sample_ids_sha256": sha256_bytes(canonical_json_bytes(sample_ids)),
    }


def _deterministic_calibration_subset(
    source: Mapping[str, Any],
    *,
    count: int,
    seed: str,
    source_split: str = "val",
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> list[str]:
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise DeltaLedgerError("calibration_count must be a positive integer")
    seed_value = require_text(seed, "calibration_seed")
    if source_split not in {"train", "val"}:
        raise DeltaLedgerError("calibration source split must be train or val")
    eligible = [
        sample_id
        for sample_id, stages in source["stages_by_sample"].items()
        if "secondary" in stages
        and source["split_by_sample"].get(sample_id) == source_split
        and sample_id not in excluded_sample_ids
    ]
    if source_split == "train":
        eligible = [
            sample_id
            for sample_id in eligible
            if not any(
                source["split_by_sample"].get(member) == "test"
                for member in _calibration_leakage_closure(source, {sample_id})
            )
        ]
    if count > len(eligible):
        raise DeltaLedgerError(
            f"calibration_count {count} exceeds {len(eligible)} {source_split} samples with independent secondary cards"
        )
    role_by_sample = {
        sample_id: str(
            nested(
                source["selection"][sample_id],
                "merge_provenance",
                "prior_final_record",
                "role",
                "primary",
            )
        )
        for sample_id in eligible
    }
    work_by_sample = {
        sample_id: str(source["selection"][sample_id]["work_id"])
        for sample_id in eligible
    }
    remaining = set(eligible)
    selected: list[str] = []
    role_counts: Counter[str] = Counter()
    work_counts: Counter[str] = Counter()
    while len(selected) < count:
        sample_id = min(
            remaining,
            key=lambda candidate: (
                role_counts[role_by_sample[candidate]],
                work_counts[work_by_sample[candidate]],
                stable_hash(
                    "font-delta-calibration-subset-v1",
                    seed_value,
                    role_by_sample[candidate],
                    work_by_sample[candidate],
                    candidate,
                ),
                candidate,
            ),
        )
        remaining.remove(sample_id)
        selected.append(sample_id)
        role_counts[role_by_sample[sample_id]] += 1
        work_counts[work_by_sample[sample_id]] += 1
    return selected


def _master_calibration_leakage_keys(row: Mapping[str, Any]) -> set[str]:
    """Return conservative pixel/lineage keys for calibration quarantine."""

    keys: set[str] = set()

    def add(kind: str, value: Any) -> None:
        if isinstance(value, str) and value.strip():
            keys.add(f"{kind}\0{value.strip()}")

    add("crop_sha256", row.get("sample_crop_sha256"))
    groups = row.get("groups")
    if isinstance(groups, Mapping):
        for field in ("root", "variant", "normalized_glyph"):
            add(f"groups.{field}", groups.get(field))
    page = row.get("page")
    if isinstance(page, Mapping):
        add("page.id", page.get("id"))
        add("page.source_page_sha256", page.get("source_page_sha256"))
    provenance = row.get("provenance")
    if isinstance(provenance, Mapping):
        add("provenance.source_id", provenance.get("source_id"))
        lineage = provenance.get("source_lineage")
        if isinstance(lineage, list):
            for item in lineage:
                if isinstance(item, Mapping):
                    add("provenance.lineage_id", item.get("id"))
    return keys


def _calibration_leakage_closure(
    source: Mapping[str, Any], selected_ids: set[str]
) -> set[str]:
    master = require_mapping(source.get("master"), "source.master")
    seed_keys: set[str] = set()
    for sample_id in selected_ids:
        row = require_mapping(master.get(sample_id), f"source.master[{sample_id}]")
        seed_keys.update(_master_calibration_leakage_keys(row))
    if not seed_keys:
        raise DeltaLedgerError("calibration reservoir has no quarantine lineage keys")
    return {
        str(sample_id)
        for sample_id, value in master.items()
        if _master_calibration_leakage_keys(
            require_mapping(value, f"source.master[{sample_id}]")
        ).intersection(seed_keys)
    }


def _calibration_training_quarantine(
    source: Mapping[str, Any], selected_ids: set[str]
) -> list[str]:
    closure = _calibration_leakage_closure(source, selected_ids)
    test_conflicts = sorted(
        sample_id
        for sample_id in closure
        if source["split_by_sample"].get(sample_id) == "test"
    )
    if test_conflicts:
        raise DeltaLedgerError(
            "calibration reservoir shares a pixel/lineage group with sealed test "
            f"samples: {test_conflicts[:5]}"
        )
    quarantine = sorted(
        sample_id
        for sample_id in closure
        if source["split_by_sample"].get(sample_id) == "train"
    )
    if not selected_ids.issubset(quarantine):
        raise DeltaLedgerError(
            "calibration reservoir is not contained in its training quarantine"
        )
    return quarantine


def _sealed_calibration_training_quarantine(
    source: Mapping[str, Any],
    selected_ids: set[str],
    *,
    successor_authority_only: Mapping[str, Any] | None = None,
) -> list[str]:
    """Return lineage closure plus any stricter sealed preflight quarantine."""

    quarantine = set(_calibration_training_quarantine(source, selected_ids))
    supplement = source.get("calibration_only_supplement")
    if not isinstance(supplement, Mapping):
        return sorted(quarantine)
    supplement_selected = set(
        _string_array(
            supplement.get("selected_sample_ids"),
            "calibration supplement.selected_sample_ids",
        )
    )
    if selected_ids != supplement_selected:
        if successor_authority_only is not None:
            sealed_ids = set(
                _string_array(
                    supplement.get("training_quarantine_sample_ids"),
                    "calibration supplement.training_quarantine_sample_ids",
                )
            )
            overlap = sorted(selected_ids.intersection(sealed_ids))
            if overlap:
                raise DeltaLedgerError(
                    "successor-authority-only calibration reuses the sealed "
                    f"supplement closure: {overlap[:5]}"
                )
            authority_ids = _string_array(
                successor_authority_only.get(
                    "successor_training_quarantine_sample_ids"
                ),
                "successor authority training quarantine",
            )
            if (
                authority_ids != sorted(authority_ids)
                or not selected_ids.issubset(authority_ids)
                or successor_authority_only.get(
                    "successor_training_quarantine_sample_ids_sha256"
                )
                != sha256_bytes(canonical_json_bytes(authority_ids))
            ):
                raise DeltaLedgerError(
                    "successor authority training quarantine binding changed"
                )
            return authority_ids
        raise DeltaLedgerError(
            "calibration-only supplement may only be used for its exact sealed 60-sample round"
        )
    sealed_ids = set(
        _string_array(
            supplement.get("training_quarantine_sample_ids"),
            "calibration supplement.training_quarantine_sample_ids",
        )
    )
    if not quarantine.issubset(sealed_ids) or not selected_ids.issubset(sealed_ids):
        raise DeltaLedgerError(
            "calibration-only supplement does not contain the computed lineage closure"
        )
    return sorted(sealed_ids)


def _successor_authority_core_projection(row: Mapping[str, Any]) -> dict[str, Any]:
    """Return immutable sample identity fields shared by old and successor rows."""

    return {
        key: copy.deepcopy(row.get(key))
        for key in (
            "schema_version",
            "catalog_version",
            "id",
            "work",
            "chapter",
            "page",
            "geometry",
            "groups",
            "provenance",
        )
    }


def _successor_authority_catalog_ids(value: Any) -> set[str]:
    catalog_ids: set[str] = set()
    if isinstance(value, Mapping):
        catalog_id = value.get("catalog_id")
        if isinstance(catalog_id, str) and catalog_id:
            catalog_ids.add(catalog_id)
        for child in value.values():
            catalog_ids.update(_successor_authority_catalog_ids(child))
    elif isinstance(value, list):
        for child in value:
            catalog_ids.update(_successor_authority_catalog_ids(child))
    return catalog_ids


def _successor_authority_rows(
    manifest_path: Path, *, selected_ids: set[str]
) -> dict[str, Mapping[str, Any]]:
    rows: dict[str, Mapping[str, Any]] = {}
    with manifest_path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise DeltaLedgerError(
                    f"successor master line {line_number} is invalid JSON"
                ) from error
            if not isinstance(value, Mapping):
                raise DeltaLedgerError(
                    f"successor master line {line_number} is not an object"
                )
            sample_id = value.get("id")
            if sample_id not in selected_ids:
                continue
            if sample_id in rows:
                raise DeltaLedgerError(
                    f"successor master repeats selected sample {sample_id}"
                )
            rows[str(sample_id)] = value
    missing = sorted(selected_ids - set(rows))
    if missing:
        raise DeltaLedgerError(
            "successor authority lacks fresh calibration samples: " f"{missing[:5]}"
        )
    return rows


def _successor_authority_manifest_splits(
    manifest_path: Path,
) -> dict[str, str]:
    splits: dict[str, str] = {}
    with manifest_path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise DeltaLedgerError(
                    f"successor master line {line_number} is invalid JSON"
                ) from error
            row = require_mapping(value, f"successor master[{line_number}]")
            sample_id = require_id(row.get("id"), f"successor master[{line_number}].id")
            split = row.get("split")
            if split not in {"train", "val", "test"}:
                raise DeltaLedgerError(
                    f"successor master[{sample_id}] has an invalid split"
                )
            if sample_id in splits:
                raise DeltaLedgerError(f"successor master repeats sample {sample_id}")
            splits[sample_id] = str(split)
    return splits


def _successor_authority_only_binding(
    source: Mapping[str, Any],
    *,
    supplement: Mapping[str, Any],
    selected_ids: set[str],
    split_by_sample: Mapping[str, str],
    predecessor_master: Mapping[str, Mapping[str, Any]],
    predecessor_split_by_sample: Mapping[str, str],
    selection_manifest_binding: Mapping[str, Any],
) -> dict[str, Any]:
    """Fail closed unless a fresh round exactly matches the successor authority."""

    if len(selected_ids) != 60:
        raise DeltaLedgerError(
            "successor-authority-only calibration requires exactly 60 fresh samples"
        )
    manifest_path_value = supplement.get("_successor_master_manifest_path")
    registry_path_value = supplement.get("_successor_catalog_registry_path")
    split_path_value = supplement.get("_successor_master_split_map_path")
    if not all(
        isinstance(value, Path)
        for value in (manifest_path_value, registry_path_value, split_path_value)
    ):
        raise DeltaLedgerError(
            "successor-authority-only calibration lacks sealed successor paths"
        )
    manifest_path = manifest_path_value.resolve()
    registry_path = registry_path_value.resolve()
    split_path = split_path_value.resolve()
    for path, expected_sha, label in (
        (
            manifest_path,
            supplement.get("successor_master_manifest_sha256"),
            "successor master",
        ),
        (
            registry_path,
            supplement.get("successor_catalog_registry_sha256"),
            "successor catalog registry",
        ),
        (
            split_path,
            supplement.get("successor_master_split_map_sha256"),
            "successor split map",
        ),
    ):
        if sha256_file(path) != require_sha(expected_sha, f"{label} SHA"):
            raise DeltaLedgerError(f"{label} bytes changed")

    registry = read_json(registry_path)
    validate_seal(registry, "successor catalog registry")
    if (
        registry.get("schema_version") != "font-matching-catalog-registry-v1"
        or registry.get("record_type") != "font_matching_catalog_registry"
    ):
        raise DeltaLedgerError("successor catalog registry schema changed")
    catalog_ids: set[str] = set()
    for index, value in enumerate(
        require_list(registry.get("catalogs"), "successor catalog registry.catalogs")
    ):
        catalog = require_mapping(
            value, f"successor catalog registry.catalogs[{index}]"
        )
        catalog_id = require_id(
            catalog.get("catalog_id"),
            f"successor catalog registry.catalogs[{index}].catalog_id",
        )
        if catalog_id in catalog_ids:
            raise DeltaLedgerError(f"successor catalog registry repeats {catalog_id}")
        catalog_root = Path(
            require_text(
                catalog.get("root"),
                f"successor catalog registry.catalogs[{index}].root",
            )
        ).resolve()
        manifest_name = require_text(
            catalog.get("manifest_name"),
            f"successor catalog registry.catalogs[{index}].manifest_name",
        )
        catalog_manifest = (catalog_root / manifest_name).resolve()
        try:
            catalog_manifest.relative_to(catalog_root)
        except ValueError as error:
            raise DeltaLedgerError(
                f"successor catalog {catalog_id} manifest escapes its root"
            ) from error
        if not catalog_manifest.is_file() or sha256_file(
            catalog_manifest
        ) != require_sha(
            catalog.get("manifest_sha256"),
            f"successor catalog registry.catalogs[{index}].manifest_sha256",
        ):
            raise DeltaLedgerError(
                f"successor catalog registry manifest changed for {catalog_id}"
            )
        catalog_ids.add(catalog_id)

    split_document = read_json(split_path)
    split_work_assignments_raw = require_mapping(
        split_document.get("work_assignments"),
        "successor split map.work_assignments",
    )
    split_work_assignments = {
        require_id(work_id, "successor split map.work_id"): str(split)
        for work_id, split in split_work_assignments_raw.items()
    }
    if any(
        split not in {"train", "val", "test"}
        for split in split_work_assignments.values()
    ):
        raise DeltaLedgerError("successor split map contains an unsupported split")

    predecessor_work_assignments: dict[str, str] = {}
    predecessor_non_train_conflict_keys: set[str] = set()
    if set(predecessor_master) != set(predecessor_split_by_sample):
        raise DeltaLedgerError(
            "predecessor master and sample split authority inventories differ"
        )
    for sample_id, value in predecessor_master.items():
        row = require_mapping(value, f"predecessor master[{sample_id}]")
        work_id = require_id(
            nested(row, "work", "id"),
            f"predecessor master[{sample_id}].work.id",
        )
        split = predecessor_split_by_sample.get(sample_id)
        if split not in {"train", "val", "test"}:
            raise DeltaLedgerError(
                f"predecessor master[{sample_id}] has an invalid split"
            )
        prior = predecessor_work_assignments.setdefault(work_id, str(split))
        if prior != split:
            raise DeltaLedgerError(
                f"predecessor work {work_id} spans multiple canonical splits"
            )
        if split != "train":
            predecessor_non_train_conflict_keys.update(
                _master_calibration_leakage_keys(row)
            )
    reassigned_works = sorted(
        work_id
        for work_id, split in predecessor_work_assignments.items()
        if split_work_assignments.get(work_id) != split
    )
    if reassigned_works:
        raise DeltaLedgerError(
            "successor split map changed or removed predecessor work assignments: "
            f"{reassigned_works[:5]}"
        )
    new_successor_work_ids = sorted(
        set(split_work_assignments) - set(predecessor_work_assignments)
    )
    non_train_new_works = [
        work_id
        for work_id in new_successor_work_ids
        if split_work_assignments[work_id] != "train"
    ]
    if non_train_new_works:
        raise DeltaLedgerError(
            "new successor works must be train-only extensions: "
            f"{non_train_new_works[:5]}"
        )

    successor_rows = _successor_authority_rows(manifest_path, selected_ids=selected_ids)
    selected_conflict_keys: set[str] = set()
    for row in successor_rows.values():
        selected_conflict_keys.update(_master_calibration_leakage_keys(row))
    successor_closure_ids: set[str] = set()
    with manifest_path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise DeltaLedgerError(
                    f"successor master line {line_number} is invalid JSON"
                ) from error
            row = require_mapping(value, f"successor master[{line_number}]")
            if not selected_conflict_keys.intersection(
                _master_calibration_leakage_keys(row)
            ):
                continue
            sample_id = require_id(row.get("id"), f"successor master[{line_number}].id")
            if sample_id in successor_closure_ids:
                raise DeltaLedgerError(
                    f"successor master repeats closure sample {sample_id}"
                )
            work_id = require_id(
                nested(row, "work", "id"),
                f"successor master[{sample_id}].work.id",
            )
            canonical_split = split_work_assignments.get(work_id)
            if canonical_split is None or row.get("split") != canonical_split:
                raise DeltaLedgerError(
                    f"{sample_id}: successor closure row differs from split authority"
                )
            if canonical_split != "train":
                raise DeltaLedgerError(
                    "successor-authority-only calibration closure reaches a sealed "
                    f"{canonical_split} sample: {sample_id}"
                )
            if (
                nested(row, "provenance", "synthetic") is not False
                or nested(row, "provenance", "qa_overlay") is not False
            ):
                raise DeltaLedgerError(
                    f"{sample_id}: successor closure is synthetic or an overlay"
                )
            successor_closure_ids.add(sample_id)
    if not selected_ids.issubset(successor_closure_ids):
        raise DeltaLedgerError(
            "successor authority closure does not contain every selected sample"
        )

    authority_records: list[dict[str, Any]] = []
    for sample_id in sorted(selected_ids):
        active_row = require_mapping(
            source.get("master", {}).get(sample_id),
            f"active source master[{sample_id}]",
        )
        successor_row = require_mapping(
            successor_rows[sample_id], f"successor master[{sample_id}]"
        )
        if _successor_authority_core_projection(active_row) != (
            _successor_authority_core_projection(successor_row)
        ):
            raise DeltaLedgerError(
                f"{sample_id}: active source core identity differs from successor authority"
            )
        if active_row.get("sample_crop_sha256") != require_sha(
            successor_row.get("sample_crop_sha256"),
            f"successor master[{sample_id}].sample_crop_sha256",
        ):
            raise DeltaLedgerError(
                f"{sample_id}: sample pixel hash differs from successor authority"
            )
        active_views = require_mapping(
            active_row.get("views"), f"active source master[{sample_id}].views"
        )
        successor_views = require_mapping(
            successor_row.get("views"), f"successor master[{sample_id}].views"
        )
        if dict(active_views) != dict(successor_views):
            raise DeltaLedgerError(
                f"{sample_id}: view hashes differ from successor authority"
            )
        active_conflicts = sorted(_master_calibration_leakage_keys(active_row))
        successor_conflicts = sorted(_master_calibration_leakage_keys(successor_row))
        if active_conflicts != successor_conflicts:
            raise DeltaLedgerError(
                f"{sample_id}: conflict keys differ from successor authority"
            )
        non_train_lineage_overlap = sorted(
            set(successor_conflicts).intersection(predecessor_non_train_conflict_keys)
        )
        if non_train_lineage_overlap:
            raise DeltaLedgerError(
                f"{sample_id}: successor selection overlaps predecessor val/test "
                f"lineage: {non_train_lineage_overlap[:3]}"
            )
        predecessor_row = predecessor_master.get(sample_id)
        if predecessor_row is not None:
            predecessor = require_mapping(
                predecessor_row, f"predecessor master[{sample_id}]"
            )
            if (
                _successor_authority_core_projection(predecessor)
                != _successor_authority_core_projection(successor_row)
                or predecessor.get("sample_crop_sha256")
                != successor_row.get("sample_crop_sha256")
                or dict(
                    require_mapping(
                        predecessor.get("views"),
                        f"predecessor master[{sample_id}].views",
                    )
                )
                != dict(successor_views)
                or sorted(_master_calibration_leakage_keys(predecessor))
                != successor_conflicts
            ):
                raise DeltaLedgerError(
                    f"{sample_id}: predecessor sample identity differs from successor authority"
                )
        source_catalog_id = require_id(
            nested(successor_row, "provenance", "source_catalog_id"),
            f"successor master[{sample_id}].provenance.source_catalog_id",
        )
        referenced_catalog_ids = _successor_authority_catalog_ids(
            successor_views
        ).union({source_catalog_id})
        unknown_catalogs = sorted(referenced_catalog_ids - catalog_ids)
        if unknown_catalogs:
            raise DeltaLedgerError(
                f"{sample_id}: successor row references catalogs absent from registry: "
                f"{unknown_catalogs[:5]}"
            )
        work_id = require_id(
            nested(successor_row, "work", "id"),
            f"successor master[{sample_id}].work.id",
        )
        authoritative_split = split_by_sample.get(sample_id)
        split_map_value = split_work_assignments.get(work_id)
        if (
            authoritative_split not in {"train", "val", "test"}
            or successor_row.get("split") != authoritative_split
            or split_map_value != authoritative_split
            or source.get("split_by_sample", {}).get(sample_id) != authoritative_split
        ):
            raise DeltaLedgerError(
                f"{sample_id}: successor master/split-map authority differs"
            )
        if (
            nested(successor_row, "provenance", "synthetic") is not False
            or nested(successor_row, "provenance", "qa_overlay") is not False
        ):
            raise DeltaLedgerError(
                f"{sample_id}: successor authority is synthetic or an overlay"
            )
        authority_records.append(
            {
                "sample_id": sample_id,
                "work_id": work_id,
                "split": authoritative_split,
                "predecessor_sample_present": predecessor_row is not None,
                "predecessor_work_present": work_id in predecessor_work_assignments,
                "source_catalog_id": source_catalog_id,
                "successor_master_row_sha256": sha256_bytes(
                    canonical_json_bytes(successor_row)
                ),
                "core_identity_sha256": sha256_bytes(
                    canonical_json_bytes(
                        _successor_authority_core_projection(successor_row)
                    )
                ),
                "sample_crop_sha256": successor_row["sample_crop_sha256"],
                "views_sha256": sha256_bytes(canonical_json_bytes(successor_views)),
                "conflict_keys_sha256": sha256_bytes(
                    canonical_json_bytes(successor_conflicts)
                ),
            }
        )

    selected_sha = sha256_bytes(canonical_json_bytes(sorted(selected_ids)))
    selection_file_binding = require_mapping(
        selection_manifest_binding.get("file"),
        "successor authority selection manifest.file",
    )
    if selection_manifest_binding.get(
        "sample_ids_sha256"
    ) != selected_sha or not isinstance(selection_file_binding.get("path"), str):
        raise DeltaLedgerError(
            "successor authority selection manifest differs from selected IDs"
        )
    return {
        "mode": "successor_authority_only",
        "supplement_manifest_record_sha256": require_sha(
            supplement.get("manifest_record_sha256"),
            "calibration supplement manifest record SHA",
        ),
        "successor_master_manifest_sha256": require_sha(
            supplement.get("successor_master_manifest_sha256"),
            "successor master manifest SHA",
        ),
        "successor_catalog_registry_sha256": require_sha(
            supplement.get("successor_catalog_registry_sha256"),
            "successor catalog registry SHA",
        ),
        "successor_master_split_map_sha256": require_sha(
            supplement.get("successor_master_split_map_sha256"),
            "successor split map SHA",
        ),
        "selected_sample_count": len(selected_ids),
        "selected_sample_ids_sha256": selected_sha,
        "selection_manifest": copy.deepcopy(dict(selection_file_binding)),
        "selection_manifest_record_sha256": require_sha(
            selection_manifest_binding.get("record_sha256"),
            "successor authority selection manifest record SHA",
        ),
        "selected_authority_records_sha256": sha256_bytes(
            canonical_json_bytes(authority_records)
        ),
        "predecessor_work_assignments_sha256": sha256_bytes(
            canonical_json_bytes(dict(sorted(predecessor_work_assignments.items())))
        ),
        "new_train_work_ids": new_successor_work_ids,
        "new_train_work_ids_sha256": sha256_bytes(
            canonical_json_bytes(new_successor_work_ids)
        ),
        "successor_training_quarantine_sample_ids": sorted(successor_closure_ids),
        "successor_training_quarantine_sample_ids_sha256": sha256_bytes(
            canonical_json_bytes(sorted(successor_closure_ids))
        ),
    }


def _validate_successor_authority_only_prior(
    *,
    supplement: Mapping[str, Any],
    selected_ids: set[str],
    prior_excluded_ids: set[str],
    prior_training_quarantine_ids: set[str],
    prior_subset_paths: Sequence[Path],
) -> None:
    """Require the whole predecessor supplement to be permanently retired."""

    supplement_selected = set(
        _string_array(
            supplement.get("selected_sample_ids"),
            "calibration supplement.selected_sample_ids",
        )
    )
    supplement_quarantine = set(
        _string_array(
            supplement.get("training_quarantine_sample_ids"),
            "calibration supplement.training_quarantine_sample_ids",
        )
    )
    matching_subsets: list[Mapping[str, Any]] = []
    for path_value in prior_subset_paths:
        subset = read_json(path_value.resolve())
        validate_seal(subset, f"prior calibration subset {path_value}")
        if subset.get("round_id") == supplement.get("round_id"):
            matching_subsets.append(subset)
    if len(matching_subsets) != 1:
        raise DeltaLedgerError(
            "successor-authority-only calibration requires exactly one sealed "
            "prior subset for the supplement round"
        )
    predecessor = matching_subsets[0]
    predecessor_selected = _string_array(
        predecessor.get("sample_ids"), "supplement predecessor.sample_ids"
    )
    predecessor_quarantine = _string_array(
        predecessor.get("training_quarantine_sample_ids"),
        "supplement predecessor.training_quarantine_sample_ids",
    )
    if (
        predecessor.get("schema_version") != SCHEMA_VERSION
        or predecessor.get("record_type") != "font_catalog_delta_calibration_subset"
        or predecessor.get("development_only") is not True
        or predecessor.get("training_quarantine_required") is not True
        or predecessor_selected != sorted(supplement_selected)
        or predecessor_quarantine != sorted(supplement_quarantine)
        or predecessor.get("training_quarantine_sample_ids_sha256")
        != sha256_bytes(canonical_json_bytes(predecessor_quarantine))
    ):
        raise DeltaLedgerError(
            "successor-authority-only predecessor subset does not exactly seal "
            "the supplement selection and closure"
        )
    if (
        not supplement_selected.issubset(prior_excluded_ids)
        or not supplement_selected.issubset(prior_training_quarantine_ids)
        or not supplement_quarantine.issubset(prior_excluded_ids)
        or not supplement_quarantine.issubset(prior_training_quarantine_ids)
    ):
        raise DeltaLedgerError(
            "successor-authority-only calibration requires the full supplement "
            "selection and closure in prior exclusion and training quarantine"
        )
    overlap = sorted(selected_ids.intersection(supplement_quarantine))
    if overlap:
        raise DeltaLedgerError(
            "successor-authority-only calibration reuses the prior supplement "
            f"closure: {overlap[:5]}"
        )


def _variant_v4_profile_contract() -> dict[str, Any]:
    return {
        "profile": VARIANT_V4_CALIBRATION_PROFILE,
        "profile_version": 4,
        "required_sample_count": VARIANT_V4_TOTAL,
        "required_source_split": "train",
        "required_reservoir": "train_quarantine",
        "corpus_work_count": VARIANT_V4_CORPUS_WORK_COUNT,
        "preferred_samples_per_work": 2,
        "maximum_samples_per_work": 3,
        "third_sample_requires_distinct_chapter_role_branch": True,
        "chapter_role_branch_definition": "unique_(chapter_id,semantic_role)_pair",
        "maximum_samples_per_page": 1,
        "maximum_samples_per_visual_lineage_cluster": 1,
        "independent_secondary_required": True,
        "prior_calibration_leakage_closure_excluded": True,
        "test_samples_forbidden": True,
        "strata_targets": dict(VARIANT_V4_STRATA_TARGETS),
        "handwritten_or_irregular_threshold": 0.5,
        "stratum_precedence": [
            "sfx_exact_role",
            "sign_ui_title",
            "emphasis_shout",
            "aside_whisper_or_handwritten",
            "ordinary_non_handwritten_body",
        ],
        "deterministic_tie_breaks": [
            "minimum_remaining_stratum_slack",
            "work_sample_count_ascending",
            "same_work_role_and_chapter_novelty",
            "priority_rank_ascending",
            "global_style_and_orientation_rarity",
            "seeded_sha256",
            "sample_id",
        ],
        "no_quota_relaxation": True,
    }


def _optional_finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _variant_v4_source_role_and_style(
    source: Mapping[str, Any], sample_id: str
) -> tuple[str, Mapping[str, Any]]:
    prior = require_mapping(
        nested(
            source["selection"][sample_id],
            "merge_provenance",
            "prior_final_record",
        ),
        f"selection[{sample_id}].prior_final_record",
    )
    role = require_text(
        nested(prior, "role", "primary"), f"selection[{sample_id}].prior.role"
    )
    style = require_mapping(
        prior.get("source_style"), f"selection[{sample_id}].prior.source_style"
    )
    return role, style


def _variant_v4_stratum(source: Mapping[str, Any], sample_id: str) -> str | None:
    role, style = _variant_v4_source_role_and_style(source, sample_id)
    if role in {
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
    }:
        return role
    if role == "sign_ui_title":
        return "sign_ui_title"
    if role in {"emphasis_dialogue", "shout"}:
        return "emphasis_shout"
    handwritten = _optional_finite_number(style.get("handwritten"))
    irregularity = _optional_finite_number(style.get("irregularity"))
    has_handwritten_signal = any(
        value is not None and value >= 0.5 for value in (handwritten, irregularity)
    )
    if role in {"aside_balloon_edge", "whisper"} or has_handwritten_signal:
        return "aside_whisper_handwritten"
    if role in {"dialogue", "narration", "thought"}:
        return "ordinary_body"
    return None


def _variant_v4_chapter_id(master_row: Mapping[str, Any], sample_id: str) -> str:
    chapter = require_mapping(master_row.get("chapter"), f"master[{sample_id}].chapter")
    return require_id(chapter.get("id"), f"master[{sample_id}].chapter.id")


def _variant_v4_page_key(master_row: Mapping[str, Any], sample_id: str) -> str:
    page = require_mapping(master_row.get("page"), f"master[{sample_id}].page")
    page_id = require_id(page.get("id"), f"master[{sample_id}].page.id")
    page_sha = require_sha(
        page.get("source_page_sha256"),
        f"master[{sample_id}].page.source_page_sha256",
    )
    return f"{page_id}\0{page_sha}"


def _variant_v4_priority_rank(source: Mapping[str, Any], sample_id: str) -> int:
    priority = require_mapping(
        source["selection"][sample_id].get("priority"),
        f"selection[{sample_id}].priority",
    )
    rank = priority.get("rank")
    if isinstance(rank, bool) or not isinstance(rank, int) or rank < 0:
        raise DeltaLedgerError(f"selection[{sample_id}].priority.rank is invalid")
    return rank


def _variant_v4_style_cluster(
    source: Mapping[str, Any], sample_id: str, role: str
) -> str:
    _, style = _variant_v4_source_role_and_style(source, sample_id)

    def bucket(field: str) -> str:
        value = _optional_finite_number(style.get(field))
        if value is None:
            return "u"
        return str(round(value * 4) / 4)

    orientation: Any = None
    metadata = source["master"][sample_id].get("metadata")
    if isinstance(metadata, Mapping):
        orientation = metadata.get("orientation")
    if not isinstance(orientation, str) or not orientation.strip():
        orientation = nested(
            source["selection"][sample_id],
            "merge_provenance",
            "prior_final_record",
            "treatment",
            "orientation",
        )
    return "|".join(
        [
            role,
            str(orientation),
            *(bucket(field) for field in ("weight", "width", "roundness")),
            *(bucket(field) for field in ("handwritten", "angularity", "energy")),
        ]
    )


def _variant_v4_candidate(
    source: Mapping[str, Any], sample_id: str
) -> dict[str, Any] | None:
    stratum = _variant_v4_stratum(source, sample_id)
    if stratum is None:
        return None
    selection = require_mapping(
        source["selection"].get(sample_id), f"selection[{sample_id}]"
    )
    master_row = require_mapping(
        source["master"].get(sample_id), f"master[{sample_id}]"
    )
    role, _ = _variant_v4_source_role_and_style(source, sample_id)
    work_id = require_id(selection.get("work_id"), f"selection[{sample_id}].work_id")
    stages = require_mapping(
        source["stages_by_sample"].get(sample_id),
        f"stages_by_sample[{sample_id}]",
    )
    secondary = stages.get("secondary")
    if not isinstance(secondary, Mapping):
        return None
    independence = secondary.get("reviewer_independence")
    if (
        not isinstance(independence, Mapping)
        or independence.get("required_for_secondary") is not True
    ):
        return None
    metadata = master_row.get("metadata")
    orientation = metadata.get("orientation") if isinstance(metadata, Mapping) else None
    if not isinstance(orientation, str) or not orientation.strip():
        orientation = nested(
            selection,
            "merge_provenance",
            "prior_final_record",
            "treatment",
            "orientation",
        )
    return {
        "sample_id": sample_id,
        "stratum": stratum,
        "role": role,
        "work_id": work_id,
        "chapter_id": _variant_v4_chapter_id(master_row, sample_id),
        "page_key": _variant_v4_page_key(master_row, sample_id),
        "conflict_keys": frozenset(_master_calibration_leakage_keys(master_row)),
        "priority_rank": _variant_v4_priority_rank(source, sample_id),
        "orientation": str(orientation),
        "style_cluster": _variant_v4_style_cluster(source, sample_id, role),
    }


def _variant_v4_candidate_pool(
    source: Mapping[str, Any], *, excluded_sample_ids: frozenset[str]
) -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    for sample_id in sorted(source["inventory"]):
        if (
            sample_id in excluded_sample_ids
            or source["split_by_sample"].get(sample_id) != "train"
        ):
            continue
        closure = _calibration_leakage_closure(source, {sample_id})
        if any(source["split_by_sample"].get(member) == "test" for member in closure):
            continue
        candidate = _variant_v4_candidate(source, sample_id)
        if candidate is not None:
            pool.append(candidate)
    return pool


def _variant_v4_can_select(
    candidate: Mapping[str, Any],
    *,
    selected_by_work: Mapping[str, list[Mapping[str, Any]]],
    used_conflict_keys: set[str],
) -> bool:
    if set(candidate["conflict_keys"]).intersection(used_conflict_keys):
        return False
    existing = selected_by_work.get(str(candidate["work_id"]), [])
    if len(existing) >= 3:
        return False
    if len(existing) == 2:
        chapter_role_branches = {
            (str(row["chapter_id"]), str(row["role"])) for row in existing
        }
        chapter_role_branches.add(
            (str(candidate["chapter_id"]), str(candidate["role"]))
        )
        if len(chapter_role_branches) != 3:
            return False
    return True


def _variant_v4_attempt(
    candidates: Sequence[Mapping[str, Any]], *, seed: str, attempt: int
) -> list[Mapping[str, Any]] | None:
    remaining = Counter(VARIANT_V4_STRATA_TARGETS)
    selected: list[Mapping[str, Any]] = []
    selected_ids: set[str] = set()
    selected_by_work: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    used_conflict_keys: set[str] = set()
    style_counts: Counter[str] = Counter()
    orientation_counts: Counter[str] = Counter()

    while sum(remaining.values()):
        feasible_by_stratum: dict[str, list[Mapping[str, Any]]] = {}
        for stratum, needed in remaining.items():
            if needed <= 0:
                continue
            feasible_by_stratum[stratum] = [
                candidate
                for candidate in candidates
                if candidate["stratum"] == stratum
                and candidate["sample_id"] not in selected_ids
                and _variant_v4_can_select(
                    candidate,
                    selected_by_work=selected_by_work,
                    used_conflict_keys=used_conflict_keys,
                )
            ]
            if len(feasible_by_stratum[stratum]) < needed:
                return None
        stratum = min(
            feasible_by_stratum,
            key=lambda name: (
                len(feasible_by_stratum[name]) - remaining[name],
                len(feasible_by_stratum[name]) / remaining[name],
                stable_hash(
                    "font-delta-variant-v4-stratum",
                    seed,
                    str(attempt),
                    str(len(selected)),
                    name,
                ),
                name,
            ),
        )

        def candidate_key(candidate: Mapping[str, Any]) -> tuple[Any, ...]:
            work_rows = selected_by_work[str(candidate["work_id"])]
            duplicate_role = any(row["role"] == candidate["role"] for row in work_rows)
            duplicate_chapter = any(
                row["chapter_id"] == candidate["chapter_id"] for row in work_rows
            )
            return (
                len(work_rows),
                int(duplicate_role),
                int(duplicate_chapter),
                int(candidate["priority_rank"]),
                style_counts[str(candidate["style_cluster"])],
                orientation_counts[str(candidate["orientation"])],
                stable_hash(
                    "font-delta-variant-v4-candidate",
                    seed,
                    str(attempt),
                    str(len(selected)),
                    stratum,
                    str(candidate["work_id"]),
                    str(candidate["sample_id"]),
                ),
                str(candidate["sample_id"]),
            )

        chosen = min(feasible_by_stratum[stratum], key=candidate_key)
        selected.append(chosen)
        selected_ids.add(str(chosen["sample_id"]))
        selected_by_work[str(chosen["work_id"])].append(chosen)
        used_conflict_keys.update(chosen["conflict_keys"])
        style_counts[str(chosen["style_cluster"])] += 1
        orientation_counts[str(chosen["orientation"])] += 1
        remaining[stratum] -= 1
    return selected


def _variant_v4_selection_objective(
    rows: Sequence[Mapping[str, Any]], *, seed: str
) -> tuple[Any, ...]:
    work_counts = Counter(str(row["work_id"]) for row in rows)
    return (
        -len(work_counts),
        sum(count == 3 for count in work_counts.values()),
        sum(int(row["priority_rank"]) for row in rows),
        -len({str(row["chapter_id"]) for row in rows}),
        -len({str(row["style_cluster"]) for row in rows}),
        stable_hash(
            "font-delta-variant-v4-objective",
            seed,
            *sorted(str(row["sample_id"]) for row in rows),
        ),
    )


def _variant_v4_selection_audit(
    source: Mapping[str, Any],
    *,
    selected: Sequence[Mapping[str, Any]],
    eligible: Sequence[Mapping[str, Any]],
    ordered_sample_ids: Sequence[str],
    seed: str,
    attempt: int,
) -> dict[str, Any]:
    achieved = Counter(str(row["stratum"]) for row in selected)
    achieved_dict = {key: achieved.get(key, 0) for key in VARIANT_V4_STRATA_TARGETS}
    shortfall = {
        key: VARIANT_V4_STRATA_TARGETS[key] - achieved_dict[key]
        for key in VARIANT_V4_STRATA_TARGETS
    }
    work_counts = Counter(str(row["work_id"]) for row in selected)
    page_counts = Counter(str(row["page_key"]) for row in selected)
    priority_counts = Counter(int(row["priority_rank"]) for row in selected)
    stratum_bindings = sorted(
        (
            {
                "sample_id": str(row["sample_id"]),
                "stratum": str(row["stratum"]),
            }
            for row in selected
        ),
        key=lambda row: (row["sample_id"], row["stratum"]),
    )
    profile_contract = _variant_v4_profile_contract()
    return {
        "profile": VARIANT_V4_CALIBRATION_PROFILE,
        "profile_contract_sha256": sha256_bytes(canonical_json_bytes(profile_contract)),
        "selection_method": VARIANT_V4_SELECTION_METHOD,
        "selection_algorithm": "scarcity_first_seeded_multistart_v1",
        "selected_attempt": attempt,
        "attempt_count": VARIANT_V4_SELECTION_ATTEMPTS,
        "strata_targets": dict(VARIANT_V4_STRATA_TARGETS),
        "strata_achieved": achieved_dict,
        "strata_shortfall": shortfall,
        "eligible_strata_counts": dict(
            sorted(Counter(str(row["stratum"]) for row in eligible).items())
        ),
        "eligible_sample_count": len(eligible),
        "selected_sample_ids_ordered_sha256": sha256_bytes(
            canonical_json_bytes(list(ordered_sample_ids))
        ),
        "selected_sample_ids_set_sha256": sha256_bytes(
            canonical_json_bytes(sorted(ordered_sample_ids))
        ),
        "stratum_assignment_sha256": sha256_bytes(
            canonical_json_bytes(stratum_bindings)
        ),
        "constraints_achieved": {
            "source_split": "train",
            "selected_work_count": len(work_counts),
            "corpus_work_count": len(
                {
                    str(source["selection"][sample_id]["work_id"])
                    for sample_id in source["inventory"]
                }
            ),
            "maximum_samples_on_one_page": max(page_counts.values(), default=0),
            "maximum_samples_in_one_work": max(work_counts.values(), default=0),
            "works_using_three_sample_exception": sum(
                count == 3 for count in work_counts.values()
            ),
            "page_cap_violations": sum(count > 1 for count in page_counts.values()),
            "work_cap_violations": sum(count > 3 for count in work_counts.values()),
            "third_sample_distinctness_violations": sum(
                1
                for work_id, count in work_counts.items()
                if count == 3
                and (
                    len(
                        {
                            (str(row["chapter_id"]), str(row["role"]))
                            for row in selected
                            if row["work_id"] == work_id
                        }
                    )
                    != 3
                )
            ),
            "visual_lineage_conflict_violations": sum(
                1
                for index, row in enumerate(selected)
                for other in selected[index + 1 :]
                if set(row["conflict_keys"]).intersection(other["conflict_keys"])
            ),
        },
        "selected_priority_rank_counts": {
            str(key): value for key, value in sorted(priority_counts.items())
        },
        "deterministic_tie_breaks": profile_contract["deterministic_tie_breaks"],
        "selection_seed_sha256": sha256_bytes(seed.encode("utf-8")),
    }


def _validate_variant_v4_selection_audit(
    source: Mapping[str, Any],
    *,
    sample_ids: Sequence[str],
    audit: Mapping[str, Any],
    excluded_sample_ids: frozenset[str],
) -> None:
    if len(sample_ids) != VARIANT_V4_TOTAL or len(set(sample_ids)) != len(sample_ids):
        raise DeltaLedgerError(
            f"{VARIANT_V4_CALIBRATION_PROFILE} requires exactly {VARIANT_V4_TOTAL} unique samples"
        )
    eligible = _variant_v4_candidate_pool(
        source, excluded_sample_ids=excluded_sample_ids
    )
    eligible_by_id = {str(row["sample_id"]): row for row in eligible}
    missing = sorted(set(sample_ids) - set(eligible_by_id))
    if missing:
        raise DeltaLedgerError(
            f"{VARIANT_V4_CALIBRATION_PROFILE} includes ineligible samples: {missing[:5]}"
        )
    selected = [eligible_by_id[sample_id] for sample_id in sample_ids]
    selected_attempt = audit.get("selected_attempt")
    if (
        isinstance(selected_attempt, bool)
        or not isinstance(selected_attempt, int)
        or not 0 <= selected_attempt < VARIANT_V4_SELECTION_ATTEMPTS
    ):
        raise DeltaLedgerError("selection_audit.selected_attempt is invalid")
    expected = _variant_v4_selection_audit(
        source,
        selected=selected,
        eligible=eligible,
        ordered_sample_ids=sample_ids,
        seed=require_text(
            audit.get("selection_seed"), "selection_audit.selection_seed"
        ),
        attempt=selected_attempt,
    )
    expected["selection_seed"] = audit.get("selection_seed")
    if dict(audit) != expected:
        raise DeltaLedgerError("variant-first v4 selection audit changed")
    constraints = require_mapping(
        audit.get("constraints_achieved"), "selection_audit.constraints_achieved"
    )
    if constraints.get("corpus_work_count") != VARIANT_V4_CORPUS_WORK_COUNT:
        raise DeltaLedgerError(
            f"{VARIANT_V4_CALIBRATION_PROFILE} is frozen to the 24-work corpus"
        )
    for field in (
        "page_cap_violations",
        "work_cap_violations",
        "third_sample_distinctness_violations",
        "visual_lineage_conflict_violations",
    ):
        if constraints.get(field) != 0:
            raise DeltaLedgerError(f"variant-first v4 selection violates {field}")
    if audit.get("strata_shortfall") != {key: 0 for key in VARIANT_V4_STRATA_TARGETS}:
        raise DeltaLedgerError("variant-first v4 selection has a quota shortfall")


def _deterministic_variant_v4_calibration_subset(
    source: Mapping[str, Any],
    *,
    count: int,
    seed: str,
    source_split: str,
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> tuple[list[str], dict[str, Any]]:
    if count != VARIANT_V4_TOTAL:
        raise DeltaLedgerError(
            f"{VARIANT_V4_CALIBRATION_PROFILE} requires --calibration-count {VARIANT_V4_TOTAL}"
        )
    seed_value = require_text(seed, "calibration_seed")
    if source_split != "train":
        raise DeltaLedgerError(
            f"{VARIANT_V4_CALIBRATION_PROFILE} requires train_quarantine; test and val are forbidden"
        )
    corpus_works = {
        str(source["selection"][sample_id]["work_id"])
        for sample_id in source["inventory"]
    }
    if len(corpus_works) != VARIANT_V4_CORPUS_WORK_COUNT:
        raise DeltaLedgerError(
            f"{VARIANT_V4_CALIBRATION_PROFILE} expects the sealed 24-work corpus, got {len(corpus_works)}"
        )
    eligible = _variant_v4_candidate_pool(
        source, excluded_sample_ids=excluded_sample_ids
    )
    capacity = Counter(str(row["stratum"]) for row in eligible)
    short_capacity = {
        stratum: {"required": target, "eligible": capacity.get(stratum, 0)}
        for stratum, target in VARIANT_V4_STRATA_TARGETS.items()
        if capacity.get(stratum, 0) < target
    }
    if short_capacity:
        raise DeltaLedgerError(
            "variant-first v4 calibration is infeasible without quota relaxation; "
            f"stratum capacity shortfall={short_capacity}"
        )

    feasible: list[tuple[tuple[Any, ...], int, list[Mapping[str, Any]]]] = []
    for attempt in range(VARIANT_V4_SELECTION_ATTEMPTS):
        rows = _variant_v4_attempt(eligible, seed=seed_value, attempt=attempt)
        if rows is None:
            continue
        feasible.append(
            (_variant_v4_selection_objective(rows, seed=seed_value), attempt, rows)
        )
    if not feasible:
        raise DeltaLedgerError(
            "variant-first v4 calibration is infeasible under exact quotas, "
            "same-page/visual-lineage cap 1, work cap 3, and the distinct "
            "chapter-role-branch third-sample rule; no quota was relaxed"
        )
    _, attempt, selected = min(feasible, key=lambda value: (value[0], value[1]))
    ordered = sorted(
        (str(row["sample_id"]) for row in selected),
        key=lambda sample_id: (
            stable_hash("font-delta-variant-v4-final-order", seed_value, sample_id),
            sample_id,
        ),
    )
    audit = _variant_v4_selection_audit(
        source,
        selected=selected,
        eligible=eligible,
        ordered_sample_ids=ordered,
        seed=seed_value,
        attempt=attempt,
    )
    audit["selection_seed"] = seed_value
    _validate_variant_v4_selection_audit(
        source,
        sample_ids=ordered,
        audit=audit,
        excluded_sample_ids=excluded_sample_ids,
    )
    return ordered, audit


def _load_prior_calibration_subsets(
    paths: Sequence[Path], *, source: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate prior blind rounds and derive permanent leakage exclusions.

    A failed calibration round is still development data.  Its selected samples,
    every pixel/lineage sibling, and any previously sealed train quarantine must
    therefore stay out of later calibration draws.  Train quarantine IDs also
    remain excluded from the eventual training export even when the round failed.
    """

    bindings: list[dict[str, Any]] = []
    selected_seen: set[str] = set()
    excluded_ids: set[str] = set()
    training_quarantine_ids: set[str] = set()
    path_seen: set[Path] = set()
    inventory = set(source["inventory"])

    for index, path_value in enumerate(paths):
        path = path_value.resolve()
        if path in path_seen:
            raise DeltaLedgerError(f"duplicate prior calibration subset: {path}")
        path_seen.add(path)
        value = read_json(path)
        location = f"prior calibration subset[{index}]"
        validate_seal(value, location)
        if (
            value.get("schema_version") != SCHEMA_VERSION
            or value.get("record_type") != "font_catalog_delta_calibration_subset"
            or value.get("development_only") is not True
        ):
            raise DeltaLedgerError(
                f"{location} is not a sealed development-only calibration subset"
            )
        require_id(value.get("round_id"), f"{location}.round_id")
        sample_ids = _string_array(value.get("sample_ids"), f"{location}.sample_ids")
        if value.get("sample_count") != len(sample_ids) or not sample_ids:
            raise DeltaLedgerError(f"{location} sample inventory is inconsistent")
        unknown = sorted(set(sample_ids) - inventory)
        if unknown:
            raise DeltaLedgerError(
                f"{location} references samples outside the current source: {unknown[:5]}"
            )
        overlap = sorted(set(sample_ids).intersection(selected_seen))
        if overlap:
            raise DeltaLedgerError(
                f"prior calibration rounds reuse selected samples: {overlap[:5]}"
            )
        selected_seen.update(sample_ids)
        test_selected = sorted(
            sample_id
            for sample_id in sample_ids
            if source["split_by_sample"].get(sample_id) == "test"
        )
        if test_selected:
            raise DeltaLedgerError(
                f"{location} contains sealed test samples: {test_selected[:5]}"
            )

        # Legacy val rounds predate explicit quarantine fields.  They are valid
        # prior calibration evidence, but have no permanent train exclusion list.
        has_quarantine_fields = any(
            key in value
            for key in (
                "training_quarantine_required",
                "training_quarantine_sample_ids",
                "training_quarantine_sample_ids_sha256",
            )
        )
        quarantine_ids: list[str] = []
        if has_quarantine_fields:
            quarantine_required = require_bool(
                value.get("training_quarantine_required"),
                f"{location}.training_quarantine_required",
            )
            quarantine_ids = _string_array(
                value.get("training_quarantine_sample_ids"),
                f"{location}.training_quarantine_sample_ids",
            )
            if quarantine_ids != sorted(quarantine_ids):
                raise DeltaLedgerError(f"{location} quarantine is not sorted")
            quarantine_sha = sha256_bytes(canonical_json_bytes(quarantine_ids))
            if value.get("training_quarantine_sample_ids_sha256") != quarantine_sha:
                raise DeltaLedgerError(f"{location} quarantine hash changed")
            if quarantine_required != bool(quarantine_ids):
                raise DeltaLedgerError(
                    f"{location} quarantine requirement is inconsistent"
                )
            if quarantine_required and not set(sample_ids).issubset(quarantine_ids):
                raise DeltaLedgerError(
                    f"{location} selected train samples escape their quarantine"
                )
            # A later font-signal gate may remove a formerly review-ready
            # lineage sibling.  It still belongs to the immutable source master
            # and must remain quarantined instead of making the prior round
            # impossible to bind.
            known_master_ids = set(source["master"])
            quarantine_unknown_set = set(quarantine_ids) - known_master_ids
            supplement = source.get("calibration_only_supplement")
            successor_split_by_sample: dict[str, str] = {}
            if quarantine_unknown_set and isinstance(supplement, Mapping):
                successor_manifest_path = supplement.get(
                    "_successor_master_manifest_path"
                )
                if not isinstance(successor_manifest_path, Path):
                    raise DeltaLedgerError(
                        f"{location} lacks the sealed successor master authority"
                    )
                successor_split_by_sample = _successor_authority_manifest_splits(
                    successor_manifest_path.resolve()
                )
                quarantine_unknown_set.difference_update(successor_split_by_sample)
            quarantine_unknown = sorted(quarantine_unknown_set)
            if quarantine_unknown:
                raise DeltaLedgerError(
                    f"{location} quarantine references samples outside the source master: {quarantine_unknown[:5]}"
                )
            non_train = sorted(
                sample_id
                for sample_id in quarantine_ids
                if source["split_by_sample"].get(
                    sample_id, successor_split_by_sample.get(sample_id)
                )
                != "train"
            )
            if non_train:
                raise DeltaLedgerError(
                    f"{location} training quarantine contains non-train samples: {non_train[:5]}"
                )

        selected_closure = _calibration_leakage_closure(source, set(sample_ids))
        excluded_ids.update(selected_closure)
        excluded_ids.update(quarantine_ids)
        training_quarantine_ids.update(quarantine_ids)
        bindings.append(_file_binding(path))

    return {
        "bindings": bindings,
        "excluded_sample_ids": sorted(excluded_ids),
        "training_quarantine_sample_ids": sorted(training_quarantine_ids),
    }


def _load_prior_calibration_subsets_for_active_authority(
    paths: Sequence[Path],
    *,
    source: Mapping[str, Any],
    legacy_split_by_sample: Mapping[str, str],
    predecessor_master: Mapping[str, Mapping[str, Any]],
    predecessor_split_by_sample: Mapping[str, str],
) -> dict[str, Any]:
    """Bridge discarded old rounds across the sealed successor split authority.

    Pre-v5 rounds were selected under the legacy path-derived projection.  They
    are never scoring evidence for the fresh round, but their full closure must
    remain excluded.  A subset matching the active supplement round is instead
    validated under the successor canonical split and retains its explicit
    120-row quarantine.
    """

    supplement = source.get("calibration_only_supplement")
    if not isinstance(supplement, Mapping):
        return _load_prior_calibration_subsets(paths, source=source)
    active_round = require_id(
        supplement.get("round_id"), "calibration supplement.round_id"
    )
    old_paths: list[Path] = []
    active_paths: list[Path] = []
    authority_only_paths: list[Path] = []
    selected_by_path: dict[Path, set[str]] = {}
    for path_value in paths:
        path = path_value.resolve()
        subset = read_json(path)
        round_id = require_id(subset.get("round_id"), f"{path}.round_id")
        selected_by_path[path] = set(
            _string_array(subset.get("sample_ids"), f"{path}.sample_ids")
        )
        if round_id == active_round:
            active_paths.append(path)
        elif subset.get("successor_authority_only") is True:
            authority_only_paths.append(path)
        else:
            old_paths.append(path)

    legacy_source = dict(source)
    legacy_source["split_by_sample"] = dict(legacy_split_by_sample)
    old = _load_prior_calibration_subsets(old_paths, source=legacy_source)
    active = _load_prior_calibration_subsets(active_paths, source=source)
    authority_only = _load_prior_calibration_subsets(
        authority_only_paths, source=source
    )
    old_selected = (
        set().union(*(selected_by_path[path] for path in old_paths))
        if old_paths
        else set()
    )
    active_selected = (
        set().union(*(selected_by_path[path] for path in active_paths))
        if active_paths
        else set()
    )
    authority_selected = (
        set().union(*(selected_by_path[path] for path in authority_only_paths))
        if authority_only_paths
        else set()
    )
    if (
        old_selected.intersection(active_selected)
        or old_selected.intersection(authority_selected)
        or active_selected.intersection(authority_selected)
    ):
        raise DeltaLedgerError(
            "successor calibration authority reuses a discarded-round sample"
        )
    old_excluded = set(old["excluded_sample_ids"])
    if active_selected.intersection(old_excluded):
        raise DeltaLedgerError(
            "active calibration supplement overlaps an old discarded-round closure"
        )
    predecessor_excluded = old_excluded.union(active["excluded_sample_ids"])
    predecessor_training = set(old["training_quarantine_sample_ids"]).union(
        active["training_quarantine_sample_ids"]
    )
    for path in authority_only_paths:
        subset = read_json(path)
        selected = set(selected_by_path[path])
        binding = require_mapping(
            subset.get("successor_authority_binding"),
            f"{path}.successor_authority_binding",
        )
        selection_manifest_path = _validate_file_binding(
            require_mapping(
                binding.get("selection_manifest"),
                f"{path}.successor_authority_binding.selection_manifest",
            ),
            f"{path}.successor_authority_binding.selection_manifest",
        )
        selection_ids, selection_manifest_binding = (
            _read_successor_authority_selection_manifest(
                selection_manifest_path,
                round_id=require_id(subset.get("round_id"), f"{path}.round_id"),
            )
        )
        if selection_ids != selected:
            raise DeltaLedgerError(
                f"{path}: successor authority selection manifest changed"
            )
        recomputed = _successor_authority_only_binding(
            source,
            supplement=supplement,
            selected_ids=selected,
            split_by_sample=source["split_by_sample"],
            predecessor_master=predecessor_master,
            predecessor_split_by_sample=predecessor_split_by_sample,
            selection_manifest_binding=selection_manifest_binding,
        )
        if dict(binding) != recomputed:
            raise DeltaLedgerError(f"{path}: successor authority binding changed")
        authority_closure_overlap = sorted(
            set(recomputed["successor_training_quarantine_sample_ids"]).intersection(
                predecessor_excluded
            )
        )
        if authority_closure_overlap:
            raise DeltaLedgerError(
                f"{path}: successor authority closure overlaps an earlier "
                f"calibration exclusion: {authority_closure_overlap[:5]}"
            )
        expected_quarantine = recomputed["successor_training_quarantine_sample_ids"]
        if (
            subset.get("training_quarantine_sample_ids") != expected_quarantine
            or subset.get("training_quarantine_sample_ids_sha256")
            != recomputed["successor_training_quarantine_sample_ids_sha256"]
        ):
            raise DeltaLedgerError(
                f"{path}: successor authority quarantine closure changed"
            )
        _validate_successor_authority_only_prior(
            supplement=supplement,
            selected_ids=selected,
            prior_excluded_ids=predecessor_excluded,
            prior_training_quarantine_ids=predecessor_training,
            prior_subset_paths=paths,
        )
    if authority_selected.intersection(predecessor_excluded):
        raise DeltaLedgerError(
            "successor-authority-only prior overlaps an earlier calibration closure"
        )
    excluded_ids = predecessor_excluded.union(authority_only["excluded_sample_ids"])
    old_training_ids = {
        sample_id
        for sample_id in old_excluded
        if source["split_by_sample"].get(sample_id) == "train"
    }
    training_ids = old_training_ids.union(
        active["training_quarantine_sample_ids"]
    ).union(authority_only["training_quarantine_sample_ids"])
    binding_by_path = {
        Path(str(binding["path"])).resolve(): binding
        for binding in [
            *old["bindings"],
            *active["bindings"],
            *authority_only["bindings"],
        ]
    }
    ordered_bindings = [binding_by_path[path.resolve()] for path in paths]
    return {
        "bindings": ordered_bindings,
        "excluded_sample_ids": sorted(excluded_ids),
        "training_quarantine_sample_ids": sorted(training_ids),
    }


def _public_task(
    assignment: Mapping[str, Any], card: Mapping[str, Any]
) -> dict[str, Any]:
    if "v5_source_card" in card:
        source_card = require_mapping(card.get("v5_source_card"), "card.v5_source_card")
        public_ids = require_mapping(card.get("v5_public_ids"), "card.v5_public_ids")
        return v5_deriver.seal_record(
            {
                "schema_version": v5_deriver.SOURCE_TASK_SCHEMA_VERSION,
                "record_type": v5_deriver.SOURCE_TASK_RECORD_TYPE,
                "assignment_id": require_id(
                    public_ids.get("assignment_id"), "card.v5_public_ids.assignment_id"
                ),
                "sample_id": require_id(
                    public_ids.get("sample_id"), "card.v5_public_ids.sample_id"
                ),
                "stage": assignment["stage"],
                "review_order": assignment["review_order"],
                "source_only_card_sha256": source_card["sha256"],
                "review_surface": dict(v5_deriver.SOURCE_REVIEW_SURFACE),
            }
        )
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_blind_task",
            "assignment_id": assignment["assignment_id"],
            "sample_id": assignment["sample_id"],
            "work_id": assignment["work_id"],
            "stage": assignment["stage"],
            "review_order": assignment["review_order"],
            "candidate_count": 7,
            "blind_alias_order": list(assignment["blind_alias_order"]),
            "candidate_order_seed": assignment["candidate_order_seed"],
            "review_card": {
                "file": card["review_card_file"],
                "sha256": card["review_card_sha256"],
            },
            "mandatory_unrenderable": list(card["mandatory_unrenderable"]),
            "review_surface": {
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "prior_tiers_visible": False,
                "split_visible": False,
                "candidate_identity": "blind_alias_only",
            },
        }
    )


def initialize_workspace(
    *,
    workspace: Path,
    rescue_inputs: Path,
    font_signal_audit: Path,
    primary_card_manifests: Sequence[Path],
    secondary_card_manifests: Sequence[Path],
    primary_split_manifests: Sequence[Path] = (),
    secondary_split_manifests: Sequence[Path] = (),
    rubric: Path,
    mode: str,
    master_split_map: Path | None = None,
    calibration_sample_ids: Path | None = None,
    calibration_round_id: str | None = None,
    calibration_count: int | None = None,
    calibration_seed: str | None = None,
    calibration_reservoir: str | None = None,
    calibration_profile: str | None = None,
    calibration_successor_authority_only: bool = False,
    prior_calibration_subsets: Sequence[Path] = (),
    calibration_only_supplement: Path | None = None,
    successor_authority_intake: Path | None = None,
    verify_card_files: bool = True,
) -> dict[str, Any]:
    if mode not in {"production", "calibration"}:
        raise DeltaLedgerError("mode must be production or calibration")
    if calibration_successor_authority_only and (
        mode != "calibration"
        or calibration_only_supplement is None
        or successor_authority_intake is None
        or calibration_sample_ids is None
        or calibration_reservoir != "train_quarantine"
    ):
        raise DeltaLedgerError(
            "--calibration-successor-authority-only requires v5 calibration, "
            "an explicit sample-ID manifest, a sealed supplement, and the "
            "sealed successor intake with a train_quarantine reservoir"
        )
    target = workspace.resolve()
    if target.exists() and any(target.iterdir()):
        raise DeltaLedgerError(f"workspace must be new and empty: {target}")
    if not rubric.is_file():
        raise DeltaLedgerError(f"review rubric is missing: {rubric}")
    v5_derivation_required, rubric_content_contract = _detect_rubric_contract(rubric)
    if v5_derivation_required and not verify_card_files:
        raise DeltaLedgerError(
            "v5 forbids --skip-card-files because physical A/B pixel verification is mandatory"
        )

    source = _validate_source_inputs(rescue_inputs, font_signal_audit)
    predecessor_master = copy.deepcopy(source["master"])
    predecessor_split_by_sample = dict(source["split_by_sample"])
    if calibration_only_supplement is not None:
        if not v5_derivation_required:
            raise DeltaLedgerError(
                "--calibration-only-supplement requires the sealed v5 rubric"
            )
        _load_calibration_only_supplement(
            calibration_only_supplement,
            source=source,
            rubric=rubric,
        )
    if successor_authority_intake is not None:
        if (
            not v5_derivation_required
            or not calibration_successor_authority_only
            or calibration_round_id is None
            or not isinstance(source.get("calibration_only_supplement"), Mapping)
        ):
            raise DeltaLedgerError(
                "--successor-authority-intake is only valid for a later sealed "
                "v5 successor-authority calibration round"
            )
        _load_successor_authority_intake(
            successor_authority_intake,
            source=source,
            supplement=require_mapping(
                source.get("calibration_only_supplement"),
                "source.calibration_only_supplement",
            ),
            round_id=calibration_round_id,
        )
    legacy_split_by_sample = dict(source["split_by_sample"])
    if v5_derivation_required:
        if master_split_map is None:
            raise DeltaLedgerError("v5 requires the actual --master-split-map file")
        canonical_master_split = _validate_master_split_map(
            master_split_map, source=source
        )
        source["split_by_sample"] = dict(canonical_master_split["split_by_sample"])
    else:
        if master_split_map is not None:
            raise DeltaLedgerError("--master-split-map requires the v5 rubric")
        canonical_master_split = None
    prior_calibration = _load_prior_calibration_subsets_for_active_authority(
        prior_calibration_subsets,
        source=source,
        legacy_split_by_sample=legacy_split_by_sample,
        predecessor_master=predecessor_master,
        predecessor_split_by_sample=predecessor_split_by_sample,
    )
    prior_excluded_ids = set(prior_calibration["excluded_sample_ids"])
    prior_training_quarantine_ids = list(
        prior_calibration["training_quarantine_sample_ids"]
    )
    supplement = source.get("calibration_only_supplement")
    if mode == "production" and isinstance(supplement, Mapping):
        required_exclusions = set(
            _string_array(
                supplement.get("training_quarantine_sample_ids"),
                "calibration supplement.training_quarantine_sample_ids",
            )
        )
        if not required_exclusions.issubset(prior_excluded_ids):
            raise DeltaLedgerError(
                "production may bind a calibration-only supplement only after its full sealed quarantine is a prior-calibration exclusion"
            )
    primary_cards, primary_manifest_bindings = _card_manifest_bindings(
        primary_card_manifests,
        expected_stage="primary",
        source=source,
        verify_card_files=verify_card_files,
    )
    secondary_cards, secondary_manifest_bindings = _card_manifest_bindings(
        secondary_card_manifests,
        expected_stage="secondary",
        source=source,
        verify_card_files=verify_card_files,
    )
    if v5_derivation_required:
        primary_split_manifest_bindings = _v5_split_card_bindings(
            primary_split_manifests,
            expected_stage="primary",
            cards=primary_cards,
            verify_card_files=verify_card_files,
        )
        secondary_split_manifest_bindings = _v5_split_card_bindings(
            secondary_split_manifests,
            expected_stage="secondary",
            cards=secondary_cards,
            verify_card_files=verify_card_files,
        )
    else:
        if primary_split_manifests or secondary_split_manifests:
            raise DeltaLedgerError("split-card manifests require the v5 review rubric")
        primary_split_manifest_bindings = []
        secondary_split_manifest_bindings = []

    if v5_derivation_required:
        for card_map in (primary_cards, secondary_cards):
            for card in card_map.values():
                sample_id = str(card["sample_id"])
                assignment = source["assignments"][card["assignment_id"]]
                master_row = source["master"].get(sample_id, {})
                chapter_value = master_row.get("chapter")
                chapter_id = (
                    str(chapter_value.get("id"))
                    if isinstance(chapter_value, Mapping)
                    and chapter_value.get("id") is not None
                    else str(
                        nested(master_row, "page", "id")
                        if isinstance(master_row.get("page"), Mapping)
                        and master_row["page"].get("id") is not None
                        else sample_id
                    )
                )
                card["neutral_tie_anchors"] = {
                    "chapter_sha256": stable_hash(
                        "font-matching-neutral-chapter-anchor-v5",
                        str(assignment["work_id"]),
                        chapter_id,
                    ),
                    "work_sha256": stable_hash(
                        "font-matching-neutral-work-anchor-v5",
                        str(assignment["work_id"]),
                    ),
                }

    all_ids = set(source["inventory"])
    successor_authority_only_binding: dict[str, Any] | None = None
    successor_authority_selection_manifest_binding: dict[str, Any] | None = None
    if mode == "calibration":
        reservoir = calibration_reservoir or "val"
        if reservoir not in {"val", "train_quarantine"}:
            raise DeltaLedgerError(
                "calibration_reservoir must be val or train_quarantine"
            )
        calibration_source_split = "train" if reservoir == "train_quarantine" else "val"
        training_quarantine_required = reservoir == "train_quarantine"
        if calibration_round_id is None:
            raise DeltaLedgerError("calibration mode requires --calibration-round-id")
        require_id(calibration_round_id, "calibration_round_id")
        if calibration_profile not in {None, VARIANT_V4_CALIBRATION_PROFILE}:
            raise DeltaLedgerError(
                f"unsupported calibration_profile: {calibration_profile}"
            )
        selection_audit: dict[str, Any] | None = None
        selection_profile_contract: dict[str, Any] | None = None
        if calibration_profile == VARIANT_V4_CALIBRATION_PROFILE:
            if reservoir != "train_quarantine":
                raise DeltaLedgerError(
                    f"{VARIANT_V4_CALIBRATION_PROFILE} requires --calibration-reservoir train_quarantine"
                )
            if rubric.name != "font-matching-v2-review-rubric-v4.md":
                raise DeltaLedgerError(
                    f"{VARIANT_V4_CALIBRATION_PROFILE} requires the v4 review rubric"
                )
            selection_profile_contract = _variant_v4_profile_contract()
        if calibration_sample_ids is not None:
            if (
                calibration_count is not None
                or calibration_seed is not None
                or calibration_profile is not None
            ):
                raise DeltaLedgerError(
                    "use either --calibration-sample-ids or deterministic --calibration-count/--calibration-seed/--calibration-profile"
                )
            if calibration_successor_authority_only:
                (
                    authority_sample_ids,
                    successor_authority_selection_manifest_binding,
                ) = _read_successor_authority_selection_manifest(
                    calibration_sample_ids,
                    round_id=calibration_round_id,
                )
                calibration_order = sorted(authority_sample_ids)
            else:
                calibration_order = sorted(_read_sample_ids(calibration_sample_ids))
            selection_method = "explicit_sealed_sample_ids"
        else:
            if calibration_count is None or calibration_seed is None:
                raise DeltaLedgerError(
                    "calibration mode requires either --calibration-sample-ids or both --calibration-count and --calibration-seed"
                )
            if calibration_profile == VARIANT_V4_CALIBRATION_PROFILE:
                calibration_order, selection_audit = (
                    _deterministic_variant_v4_calibration_subset(
                        source,
                        count=calibration_count,
                        seed=calibration_seed,
                        source_split=calibration_source_split,
                        excluded_sample_ids=frozenset(prior_excluded_ids),
                    )
                )
                selection_method = VARIANT_V4_SELECTION_METHOD
            else:
                calibration_order = _deterministic_calibration_subset(
                    source,
                    count=calibration_count,
                    seed=calibration_seed,
                    source_split=calibration_source_split,
                    excluded_sample_ids=frozenset(prior_excluded_ids),
                )
                selection_method = (
                    f"deterministic_{calibration_source_split}_role_work_balanced_v1"
                )
        selected_ids = set(calibration_order)
        if calibration_successor_authority_only:
            intake = require_mapping(
                source.get("successor_authority_intake"),
                "source.successor_authority_intake",
            )
            if (
                set(
                    _string_array(
                        intake.get("selected_sample_ids"),
                        "successor authority intake.selected_sample_ids",
                    )
                )
                != selected_ids
            ):
                raise DeltaLedgerError(
                    "successor authority selection differs from its sealed intake"
                )
        if not selected_ids or not selected_ids.issubset(all_ids):
            raise DeltaLedgerError(
                "calibration IDs must be a non-empty review-ready subset"
            )
        prior_overlap = sorted(selected_ids.intersection(prior_excluded_ids))
        if prior_overlap:
            raise DeltaLedgerError(
                "calibration samples overlap a prior calibration leakage closure: "
                f"{prior_overlap[:5]}"
            )
        wrong_split = sorted(
            sample_id
            for sample_id in selected_ids
            if source["split_by_sample"].get(sample_id) != calibration_source_split
        )
        if wrong_split:
            raise DeltaLedgerError(
                "calibration reservoir split mismatch "
                f"(expected {calibration_source_split}): {wrong_split[:5]}"
            )
        missing_secondary = sorted(
            sample_id
            for sample_id in selected_ids
            if "secondary" not in source["stages_by_sample"][sample_id]
        )
        if missing_secondary:
            raise DeltaLedgerError(
                f"calibration requires independent secondary assignments: {missing_secondary[:5]}"
            )
        if isinstance(supplement, Mapping):
            supplement_selected = set(supplement["selected_sample_ids"])
            exact_supplement_round = (
                calibration_round_id == supplement.get("round_id")
                and selected_ids == supplement_selected
            )
            if not exact_supplement_round:
                if not calibration_successor_authority_only:
                    raise DeltaLedgerError(
                        "a fresh round over the successor authority requires "
                        "--calibration-successor-authority-only"
                    )
                if (
                    calibration_round_id == supplement.get("round_id")
                    or selected_ids == supplement_selected
                ):
                    raise DeltaLedgerError(
                        "calibration supplement round and selected inventory must "
                        "either both match or both be fresh"
                    )
                _validate_successor_authority_only_prior(
                    supplement=supplement,
                    selected_ids=selected_ids,
                    prior_excluded_ids=set(prior_excluded_ids),
                    prior_training_quarantine_ids=set(prior_training_quarantine_ids),
                    prior_subset_paths=prior_calibration_subsets,
                )
                if canonical_master_split is None:
                    raise DeltaLedgerError(
                        "successor-authority-only calibration requires the sealed "
                        "successor split map"
                    )
                successor_authority_only_binding = _successor_authority_only_binding(
                    source,
                    supplement=supplement,
                    selected_ids=selected_ids,
                    split_by_sample=canonical_master_split["split_by_sample"],
                    predecessor_master=predecessor_master,
                    predecessor_split_by_sample=(predecessor_split_by_sample),
                    selection_manifest_binding=require_mapping(
                        successor_authority_selection_manifest_binding,
                        "successor authority selection manifest binding",
                    ),
                )
                authority_closure_overlap = sorted(
                    set(
                        successor_authority_only_binding[
                            "successor_training_quarantine_sample_ids"
                        ]
                    ).intersection(prior_excluded_ids)
                )
                if authority_closure_overlap:
                    raise DeltaLedgerError(
                        "successor-authority-only closure overlaps a prior "
                        f"calibration exclusion: {authority_closure_overlap[:5]}"
                    )
            elif calibration_successor_authority_only:
                raise DeltaLedgerError(
                    "--calibration-successor-authority-only cannot be used for "
                    "the supplement's own sealed round"
                )
        elif calibration_successor_authority_only:
            raise DeltaLedgerError(
                "successor-authority-only calibration cannot fall back to the old authority"
            )
        if calibration_successor_authority_only != (
            successor_authority_only_binding is not None
        ):
            raise DeltaLedgerError(
                "successor-authority-only calibration did not seal its authority binding"
            )
        training_quarantine_ids = (
            _sealed_calibration_training_quarantine(
                source,
                selected_ids,
                successor_authority_only=successor_authority_only_binding,
            )
            if training_quarantine_required
            else []
        )
    else:
        if any(
            value is not None
            for value in (
                calibration_sample_ids,
                calibration_round_id,
                calibration_count,
                calibration_seed,
                calibration_reservoir,
                calibration_profile,
            )
        ):
            raise DeltaLedgerError("production mode cannot declare calibration samples")
        selected_ids = (
            all_ids - prior_excluded_ids if v5_derivation_required else all_ids
        )
        if v5_derivation_required and not selected_ids:
            raise DeltaLedgerError(
                "v5 production pool is empty after permanent prior-calibration closure exclusion"
            )
        calibration_order = []
        selection_method = None
        reservoir = None
        calibration_source_split = None
        training_quarantine_required = False
        training_quarantine_ids = []
        selection_audit = None
        selection_profile_contract = None
        successor_authority_only_binding = None
        successor_authority_selection_manifest_binding = None

    selected_assignments: list[Mapping[str, Any]] = []
    for assignment in source["assignments"].values():
        if assignment["sample_id"] in selected_ids:
            selected_assignments.append(assignment)
    selected_assignments.sort(
        key=lambda row: (
            0 if row["stage"] == "primary" else 1,
            int(row["review_order"]),
            str(row["assignment_id"]),
        )
    )
    missing_cards: list[str] = []
    bindings: list[dict[str, Any]] = []
    public_tasks: list[dict[str, Any]] = []
    v5_source_card_payloads: dict[Path, bytes] = {}
    public_id_namespace = secrets.token_hex(32) if v5_derivation_required else None
    public_sample_ids = {
        sample_id: f"fmv5s-{stable_hash('font-matching-v5-public-sample', str(public_id_namespace), sample_id)[:32]}"
        for sample_id in selected_ids
    }
    for assignment in selected_assignments:
        cards = primary_cards if assignment["stage"] == "primary" else secondary_cards
        card_value = cards.get(str(assignment["assignment_id"]))
        card = copy.deepcopy(card_value) if card_value is not None else None
        if card is None:
            missing_cards.append(str(assignment["assignment_id"]))
            continue
        if v5_derivation_required:
            public_ids = {
                "assignment_id": f"fmv5a-{stable_hash('font-matching-v5-public-assignment', str(public_id_namespace), str(assignment['assignment_id']))[:32]}",
                "sample_id": public_sample_ids[str(assignment["sample_id"])],
            }
            split_cards = require_mapping(
                card.get("v5_review_cards"),
                f"{assignment['assignment_id']}.v5_review_cards",
            )
            source_descriptor = require_mapping(
                split_cards.get("source_only"),
                f"{assignment['assignment_id']}.v5_review_cards.source_only",
            )
            source_path = Path(
                require_text(
                    source_descriptor.get("file"),
                    f"{assignment['assignment_id']}.source_only.file",
                )
            )
            source_sha = require_sha(
                source_descriptor.get("sha256"),
                f"{assignment['assignment_id']}.source_only.sha256",
            )
            source_payload = source_path.read_bytes()
            if sha256_bytes(source_payload) != source_sha:
                raise DeltaLedgerError(
                    f"{assignment['assignment_id']}: source-only bytes changed during initialization"
                )
            source_relative = (
                Path("source-cards") / f"{public_ids['assignment_id']}.png"
            )
            source_workspace_path = target / source_relative
            v5_source_card_payloads[source_workspace_path] = source_payload
            # This is the complete serialized card surface before B release.
            # In particular it contains no canonical alias, candidate order,
            # mandatory-unrenderable status, full-card hash, candidate hash, or
            # path back into the split tree.
            card = {
                "assignment_id": assignment["assignment_id"],
                "sample_id": assignment["sample_id"],
                "stage": assignment["stage"],
                "review_card_sha256": source_sha,
                "review_card_file": str(source_workspace_path),
                "v5_public_ids": public_ids,
                "v5_source_card": {
                    "file": str(source_workspace_path),
                    "sha256": source_sha,
                    "pixel_sha256": require_sha(
                        source_descriptor.get("pixel_sha256"),
                        f"{assignment['assignment_id']}.source_only.pixel_sha256",
                    ),
                    "size_px": copy.deepcopy(source_descriptor["size_px"]),
                },
            }
        selection = source["selection"][assignment["sample_id"]]
        serialized_assignment = (
            {
                key: assignment[key]
                for key in (
                    "assignment_id",
                    "sample_id",
                    "work_id",
                    "source_page_sha256",
                    "stage",
                    "review_order",
                )
            }
            if v5_derivation_required
            else copy.deepcopy(dict(assignment))
        )
        binding = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_catalog_delta_private_binding",
                "visibility": "private_reveal_mapping_merge_only",
                "sample_id": assignment["sample_id"],
                "work_id": assignment["work_id"],
                "source_page_sha256": assignment["source_page_sha256"],
                "assignment": serialized_assignment,
                "card": copy.deepcopy(card),
                **(
                    {}
                    if v5_derivation_required
                    else {
                        "alias_to_candidate_id": {
                            alias: source["alias_to_id"][alias]
                            for alias in assignment["blind_alias_order"]
                        }
                    }
                ),
                "selection_record_sha256": selection["record_sha256"],
                "prior_final_record_sha256": _selection_prior_final_record_sha256(
                    selection,
                    location=f"selection[{assignment['sample_id']}]",
                ),
            }
        )
        bindings.append(binding)
        public_tasks.append(_public_task(assignment, card))
    if missing_cards:
        raise DeltaLedgerError(
            f"review-card manifests do not cover selected assignments: {missing_cards[:5]}"
        )

    # Bindings nest the assignment, so check uniqueness explicitly.
    binding_ids = [str(nested(row, "assignment", "assignment_id")) for row in bindings]
    if len(binding_ids) != len(set(binding_ids)):
        raise DeltaLedgerError("private bindings contain duplicate assignments")

    target.mkdir(parents=True, exist_ok=True)
    bindings_payload = jsonl_bytes(bindings)
    tasks_payload = jsonl_bytes(public_tasks)
    primary_tasks_payload = jsonl_bytes(
        row for row in public_tasks if row["stage"] == "primary"
    )
    secondary_tasks_payload = jsonl_bytes(
        row for row in public_tasks if row["stage"] == "secondary"
    )
    rubric_binding = _file_binding(rubric.resolve())
    decision_schema_payload = canonical_json_bytes(
        blind_decision_json_schema(), pretty=True
    )
    calibration_subset = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_calibration_subset",
            "round_id": calibration_round_id,
            "selection_method": selection_method,
            "selection_profile": calibration_profile,
            "selection_profile_contract": selection_profile_contract,
            "selection_profile_contract_sha256": (
                sha256_bytes(canonical_json_bytes(selection_profile_contract))
                if selection_profile_contract is not None
                else None
            ),
            "selection_audit": selection_audit,
            "selection_seed": calibration_seed,
            "development_only": mode == "calibration",
            "source_split": calibration_source_split,
            "test_split_forbidden": True,
            "training_quarantine_required": training_quarantine_required,
            "training_quarantine_sample_ids": training_quarantine_ids,
            "training_quarantine_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(training_quarantine_ids)
            ),
            "successor_authority_only": (successor_authority_only_binding is not None),
            "successor_authority_binding": copy.deepcopy(
                successor_authority_only_binding
            ),
            "prior_calibration_subset_count": len(prior_calibration["bindings"]),
            "prior_calibration_excluded_sample_count": len(prior_excluded_ids),
            "prior_calibration_excluded_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(prior_excluded_ids))
            ),
            "prior_training_quarantine_sample_count": len(
                prior_training_quarantine_ids
            ),
            "prior_training_quarantine_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(prior_training_quarantine_ids)
            ),
            "split_visible_on_review_surface": False,
            "sample_count": len(calibration_order),
            "sample_ids": calibration_order,
        }
    )
    calibration_subset_payload = canonical_json_bytes(calibration_subset, pretty=True)
    contract = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_workspace_contract",
            "created_at": utc_timestamp(),
            "mode": mode,
            "calibration": {
                "round_id": calibration_round_id,
                "fresh_blind_round": mode == "calibration",
                "prior_answers_visible": False,
                "development_only": mode == "calibration",
                "selection_method": selection_method,
                "selection_profile": calibration_profile,
                "selection_profile_contract": selection_profile_contract,
                "selection_profile_contract_sha256": (
                    sha256_bytes(canonical_json_bytes(selection_profile_contract))
                    if selection_profile_contract is not None
                    else None
                ),
                "selection_audit": selection_audit,
                "selection_seed": calibration_seed,
                "reservoir": reservoir,
                "source_split": calibration_source_split,
                "test_split_forbidden": True,
                "training_quarantine_required": training_quarantine_required,
                "training_quarantine_sample_ids": training_quarantine_ids,
                "training_quarantine_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(training_quarantine_ids)
                ),
                "successor_authority_only": (
                    successor_authority_only_binding is not None
                ),
                "successor_authority_binding": copy.deepcopy(
                    successor_authority_only_binding
                ),
                "prior_calibration_subset_count": len(prior_calibration["bindings"]),
                "prior_calibration_excluded_sample_count": len(prior_excluded_ids),
                "prior_calibration_excluded_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(sorted(prior_excluded_ids))
                ),
                "prior_training_quarantine_sample_ids": (prior_training_quarantine_ids),
                "prior_training_quarantine_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(prior_training_quarantine_ids)
                ),
                "quarantine_closure": {
                    "page_level": True,
                    "sample_crop_sha256": True,
                    "root_variant_normalized_glyph": True,
                    "source_lineage": True,
                },
            },
            "prior_calibration_subsets": prior_calibration["bindings"],
            "source_files": source["file_bindings"],
            "source_records": _source_record_bindings(
                source,
                v5_required=v5_derivation_required,
                successor_authority_only=successor_authority_only_binding,
            ),
            "master_split_map": (
                copy.deepcopy(canonical_master_split["binding"])
                if canonical_master_split is not None
                else None
            ),
            "authoritative_split_identity": (
                {
                    "frozen_source_sha256": canonical_master_split[
                        "frozen_source_sha256"
                    ],
                    "work_assignments_sha256": canonical_master_split[
                        "work_assignments_sha256"
                    ],
                }
                if canonical_master_split is not None
                else None
            ),
            "rubric": rubric_binding,
            "rubric_content_contract": rubric_content_contract,
            "card_manifests": {
                "primary": (
                    [_opaque_file_binding(path) for path in primary_card_manifests]
                    if v5_derivation_required
                    else primary_manifest_bindings
                ),
                "secondary": (
                    [_opaque_file_binding(path) for path in secondary_card_manifests]
                    if v5_derivation_required
                    else secondary_manifest_bindings
                ),
            },
            "split_card_manifests": {
                "primary": primary_split_manifest_bindings,
                "secondary": secondary_split_manifest_bindings,
            },
            "v5_derivation_required": v5_derivation_required,
            "v5_derivation_contract": (
                _v5_derivation_contract() if v5_derivation_required else None
            ),
            "v5_stage_state_artifacts": (
                {
                    "source_commits": "source-annotation-commits.jsonl",
                    "candidate_releases": "candidate-releases.jsonl",
                    "candidate_tasks_directory": "candidate-tasks",
                    "candidate_surfaces_directory": "candidate-surfaces",
                }
                if v5_derivation_required
                else None
            ),
            "v5_public_id_namespace_sha256": (
                sha256_bytes(str(public_id_namespace).encode("ascii"))
                if v5_derivation_required
                else None
            ),
            "verify_card_files": verify_card_files,
            "selected_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(selected_ids))
            ),
            "selected_sample_count": len(selected_ids),
            "expected_review_counts": dict(
                sorted(Counter(row["stage"] for row in selected_assignments).items())
            ),
            "old_candidate_count": len(source["old_candidates"]),
            "new_candidate_count": len(source["alias_to_id"]),
            "private_bindings_sha256": sha256_bytes(bindings_payload),
            "public_tasks_sha256": sha256_bytes(tasks_payload),
            "primary_public_tasks_sha256": sha256_bytes(primary_tasks_payload),
            "secondary_public_tasks_sha256": sha256_bytes(secondary_tasks_payload),
            "blind_decision_schema_sha256": sha256_bytes(decision_schema_payload),
            "calibration_subset_sha256": sha256_bytes(calibration_subset_payload),
            "blindness_contract": {
                "public_candidate_references": "blind_alias_only",
                "font_names_visible": False,
                "prior_tiers_visible": False,
                "reveal_allowed_command": "finalize_only",
            },
        }
    )
    atomic_write(target / "private-bindings.jsonl", bindings_payload)
    for source_card_path, source_card_payload in sorted(
        v5_source_card_payloads.items(), key=lambda item: str(item[0])
    ):
        atomic_write(source_card_path, source_card_payload)
    atomic_write(target / "blind-tasks.jsonl", tasks_payload)
    atomic_write(target / "blind-tasks-primary.jsonl", primary_tasks_payload)
    atomic_write(target / "blind-tasks-secondary.jsonl", secondary_tasks_payload)
    atomic_write(target / "reviews.jsonl", b"")
    if v5_derivation_required:
        atomic_write(target / "source-annotation-commits.jsonl", b"")
        atomic_write(target / "candidate-releases.jsonl", b"")
    atomic_write(target / "blind-decision.schema.json", decision_schema_payload)
    atomic_write(target / "calibration-subset.json", calibration_subset_payload)
    atomic_write(target / "contract.json", canonical_json_bytes(contract, pretty=True))
    report = {
        "workspace": str(target),
        "mode": mode,
        "selected_samples": len(selected_ids),
        "primary_tasks": sum(row["stage"] == "primary" for row in selected_assignments),
        "secondary_tasks": sum(
            row["stage"] == "secondary" for row in selected_assignments
        ),
        "prior_calibration_subsets": len(prior_calibration["bindings"]),
        "prior_calibration_excluded_samples": len(prior_excluded_ids),
        "prior_training_quarantine_samples": len(prior_training_quarantine_ids),
        "contract_record_sha256": contract["record_sha256"],
        "status": "initialized_blind",
    }
    return report


def _load_workspace(workspace: Path, *, verify_sources: bool = True) -> dict[str, Any]:
    root = workspace.resolve()
    contract_path = root / "contract.json"
    bindings_path = root / "private-bindings.jsonl"
    tasks_path = root / "blind-tasks.jsonl"
    primary_tasks_path = root / "blind-tasks-primary.jsonl"
    secondary_tasks_path = root / "blind-tasks-secondary.jsonl"
    reviews_path = root / "reviews.jsonl"
    decision_schema_path = root / "blind-decision.schema.json"
    calibration_subset_path = root / "calibration-subset.json"
    if not all(
        path.is_file()
        for path in (
            contract_path,
            bindings_path,
            tasks_path,
            primary_tasks_path,
            secondary_tasks_path,
            reviews_path,
            decision_schema_path,
            calibration_subset_path,
        )
    ):
        raise DeltaLedgerError(f"not an initialized delta workspace: {root}")
    contract = read_json(contract_path)
    validate_seal(contract, "workspace contract")
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type") != "font_catalog_delta_workspace_contract"
    ):
        raise DeltaLedgerError("workspace contract uses another schema")
    if contract.get("mode") not in {"production", "calibration"}:
        raise DeltaLedgerError("workspace contract has invalid mode")
    v5_required = contract.get("v5_derivation_required") is True
    if v5_required:
        if contract.get("v5_derivation_contract") != _v5_derivation_contract():
            raise DeltaLedgerError("workspace v5 derivation contract changed")
        state_artifacts = require_mapping(
            contract.get("v5_stage_state_artifacts"),
            "contract.v5_stage_state_artifacts",
        )
        if dict(state_artifacts) != {
            "source_commits": "source-annotation-commits.jsonl",
            "candidate_releases": "candidate-releases.jsonl",
            "candidate_tasks_directory": "candidate-tasks",
            "candidate_surfaces_directory": "candidate-surfaces",
        }:
            raise DeltaLedgerError("workspace v5 stage-state artifact contract changed")
        require_sha(
            contract.get("v5_public_id_namespace_sha256"),
            "contract.v5_public_id_namespace_sha256",
        )
    elif contract.get("v5_derivation_contract") is not None:
        raise DeltaLedgerError("legacy workspace contains a v5 derivation contract")
    elif contract.get("v5_stage_state_artifacts") is not None:
        raise DeltaLedgerError("legacy workspace contains v5 stage-state artifacts")
    elif contract.get("v5_public_id_namespace_sha256") is not None:
        raise DeltaLedgerError("legacy workspace contains a v5 public-ID namespace")

    source_commits_path = root / "source-annotation-commits.jsonl"
    candidate_releases_path = root / "candidate-releases.jsonl"
    if v5_required and (
        not source_commits_path.is_file() or not candidate_releases_path.is_file()
    ):
        raise DeltaLedgerError("v5 workspace is missing its A-commit/B-release ledgers")

    if sha256_file(bindings_path) != contract.get("private_bindings_sha256"):
        raise DeltaLedgerError("private bindings changed after initialization")
    if sha256_file(tasks_path) != contract.get("public_tasks_sha256"):
        raise DeltaLedgerError("blind tasks changed after initialization")
    if sha256_file(primary_tasks_path) != contract.get(
        "primary_public_tasks_sha256"
    ) or sha256_file(secondary_tasks_path) != contract.get(
        "secondary_public_tasks_sha256"
    ):
        raise DeltaLedgerError(
            "stage-separated blind tasks changed after initialization"
        )
    if (
        sha256_file(decision_schema_path)
        != contract.get("blind_decision_schema_sha256")
        or read_json(decision_schema_path) != blind_decision_json_schema()
    ):
        raise DeltaLedgerError("blind decision schema changed after initialization")
    if sha256_file(calibration_subset_path) != contract.get(
        "calibration_subset_sha256"
    ):
        raise DeltaLedgerError("calibration subset export changed after initialization")
    calibration_subset = read_json(calibration_subset_path)
    validate_seal(calibration_subset, "calibration subset")
    if calibration_subset.get("record_type") != "font_catalog_delta_calibration_subset":
        raise DeltaLedgerError("calibration subset export uses another schema")

    source_files = require_mapping(
        contract.get("source_files"), "contract.source_files"
    )
    rubric_binding = require_mapping(contract.get("rubric"), "contract.rubric")
    rubric_path = Path(require_text(rubric_binding.get("path"), "contract.rubric.path"))
    if verify_sources:
        for name, binding_value in source_files.items():
            _validate_file_binding(
                require_mapping(binding_value, f"contract.source_files.{name}"),
                f"contract.source_files.{name}",
            )
        rubric_path = _validate_file_binding(rubric_binding, "contract.rubric")
        detected_v5, expected_rubric_contract = _detect_rubric_contract(rubric_path)
        if not detected_v5 and rubric_path.name not in {
            "font-matching-v2-review-rubric.md",
            "font-matching-v2-review-rubric-v3.md",
            "font-matching-v2-review-rubric-v4.md",
        }:
            raise DeltaLedgerError("workspace is not bound to an explicit rubric")
        if detected_v5 is not v5_required:
            raise DeltaLedgerError("workspace rubric content attempts a v5 downgrade")
        if v5_required:
            if contract.get("rubric_content_contract") != expected_rubric_contract:
                raise DeltaLedgerError("workspace v5 rubric SHA contract changed")
        elif contract.get("rubric_content_contract") is not None:
            raise DeltaLedgerError("legacy workspace contains a v5 rubric contract")
        for stage in ("primary", "secondary"):
            manifests = require_list(
                nested(contract, "card_manifests", stage),
                f"contract.card_manifests.{stage}",
            )
            for index, value in enumerate(manifests):
                manifest_binding = require_mapping(
                    value, f"contract.card_manifests.{stage}[{index}]"
                )
                if v5_required:
                    require_exact_keys(
                        manifest_binding,
                        {"sha256", "byte_size"},
                        f"contract.card_manifests.{stage}[{index}]",
                    )
                    require_sha(
                        manifest_binding.get("sha256"),
                        f"contract.card_manifests.{stage}[{index}].sha256",
                    )
                else:
                    _validate_file_binding(
                        manifest_binding,
                        f"contract.card_manifests.{stage}[{index}]",
                    )
            split_contract_value = contract.get("split_card_manifests")
            split_manifests = (
                require_list(
                    require_mapping(
                        split_contract_value, "contract.split_card_manifests"
                    ).get(stage),
                    f"contract.split_card_manifests.{stage}",
                )
                if split_contract_value is not None
                else []
            )
            for index, value in enumerate(split_manifests):
                split_binding = require_mapping(
                    value,
                    f"contract.split_card_manifests.{stage}[{index}]",
                )
                if v5_required:
                    require_exact_keys(
                        split_binding,
                        {"sha256", "byte_size"},
                        f"contract.split_card_manifests.{stage}[{index}]",
                    )
                    require_sha(
                        split_binding.get("sha256"),
                        f"contract.split_card_manifests.{stage}[{index}].sha256",
                    )
                else:
                    _validate_file_binding(
                        split_binding,
                        f"contract.split_card_manifests.{stage}[{index}]",
                    )

    source_report_path = Path(
        require_text(
            nested(source_files, "source_report", "path"),
            "contract.source_files.source_report.path",
        )
    )
    audit_report_path = Path(
        require_text(
            nested(source_files, "audit_report", "path"),
            "contract.source_files.audit_report.path",
        )
    )
    source = _validate_source_inputs(
        source_report_path.parent, audit_report_path.parent
    )
    predecessor_master = copy.deepcopy(source["master"])
    predecessor_split_by_sample = dict(source["split_by_sample"])
    supplement_binding_value = source_files.get(CALIBRATION_SUPPLEMENT_SOURCE_FILE_KEY)
    if supplement_binding_value is not None:
        if not v5_required:
            raise DeltaLedgerError(
                "legacy workspace contains a calibration-only supplement"
            )
        supplement_path = _validate_file_binding(
            require_mapping(
                supplement_binding_value,
                f"contract.source_files.{CALIBRATION_SUPPLEMENT_SOURCE_FILE_KEY}",
            ),
            f"contract.source_files.{CALIBRATION_SUPPLEMENT_SOURCE_FILE_KEY}",
        )
        _load_calibration_only_supplement(
            supplement_path,
            source=source,
            rubric=rubric_path,
        )
    intake_binding_value = source_files.get(SUCCESSOR_AUTHORITY_INTAKE_SOURCE_FILE_KEY)
    if intake_binding_value is not None:
        if not v5_required or not isinstance(
            source.get("calibration_only_supplement"), Mapping
        ):
            raise DeltaLedgerError(
                "successor authority intake requires the sealed v5 supplement"
            )
        intake_path = _validate_file_binding(
            require_mapping(
                intake_binding_value,
                f"contract.source_files.{SUCCESSOR_AUTHORITY_INTAKE_SOURCE_FILE_KEY}",
            ),
            f"contract.source_files.{SUCCESSOR_AUTHORITY_INTAKE_SOURCE_FILE_KEY}",
        )
        _load_successor_authority_intake(
            intake_path,
            source=source,
            supplement=require_mapping(
                source.get("calibration_only_supplement"),
                "source.calibration_only_supplement",
            ),
            round_id=require_id(
                nested(contract, "calibration", "round_id"),
                "contract.calibration.round_id",
            ),
        )
    legacy_split_by_sample = dict(source["split_by_sample"])
    for name, expected in source["file_bindings"].items():
        if (
            dict(
                require_mapping(source_files.get(name), f"contract.source_files.{name}")
            )
            != expected
        ):
            raise DeltaLedgerError(f"workspace source binding differs for {name}")
    if set(source_files) != set(source["file_bindings"]):
        raise DeltaLedgerError("workspace source file inventory changed")
    source_records = require_mapping(
        contract.get("source_records"), "contract.source_records"
    )
    early_calibration_contract = require_mapping(
        contract.get("calibration"), "contract.calibration"
    )
    successor_authority_only_declared = (
        early_calibration_contract.get("successor_authority_only") is True
    )
    successor_authority_binding_declared = (
        require_mapping(
            early_calibration_contract.get("successor_authority_binding"),
            "contract.calibration.successor_authority_binding",
        )
        if successor_authority_only_declared
        else None
    )
    if successor_authority_only_declared and (
        contract.get("mode") != "calibration"
        or not isinstance(source.get("calibration_only_supplement"), Mapping)
        or not isinstance(source.get("successor_authority_intake"), Mapping)
    ):
        raise DeltaLedgerError(
            "successor-authority-only binding is calibration-only and requires "
            "a sealed supplement and successor intake"
        )
    if (
        not successor_authority_only_declared
        and early_calibration_contract.get("successor_authority_binding") is not None
    ):
        raise DeltaLedgerError(
            "workspace has an undeclared successor-authority-only binding"
        )
    expected_source_records = _source_record_bindings(
        source,
        v5_required=v5_required,
        successor_authority_only=successor_authority_binding_declared,
    )
    if dict(source_records) != expected_source_records:
        raise DeltaLedgerError("workspace source record hashes changed")
    if v5_required:
        master_split_binding = require_mapping(
            contract.get("master_split_map"), "contract.master_split_map"
        )
        master_split_path = _validate_file_binding(
            master_split_binding, "contract.master_split_map"
        )
        canonical_master_split = _validate_master_split_map(
            master_split_path, source=source
        )
        source["split_by_sample"] = dict(canonical_master_split["split_by_sample"])
        if dict(master_split_binding) != canonical_master_split["binding"]:
            raise DeltaLedgerError("workspace master split file binding changed")
        expected_split_identity = {
            "frozen_source_sha256": canonical_master_split["frozen_source_sha256"],
            "work_assignments_sha256": canonical_master_split[
                "work_assignments_sha256"
            ],
        }
        if contract.get("authoritative_split_identity") != expected_split_identity:
            raise DeltaLedgerError("workspace authoritative split identity changed")
    else:
        if (
            contract.get("master_split_map") is not None
            or contract.get("authoritative_split_identity") is not None
        ):
            raise DeltaLedgerError("legacy workspace contains a v5 master split map")
        canonical_master_split = None

    prior_calibration_binding_values = require_list(
        contract.get("prior_calibration_subsets", []),
        "contract.prior_calibration_subsets",
    )
    prior_calibration_paths: list[Path] = []
    for index, binding_value in enumerate(prior_calibration_binding_values):
        prior_calibration_paths.append(
            _validate_file_binding(
                require_mapping(
                    binding_value,
                    f"contract.prior_calibration_subsets[{index}]",
                ),
                f"contract.prior_calibration_subsets[{index}]",
            )
        )
    prior_calibration = _load_prior_calibration_subsets_for_active_authority(
        prior_calibration_paths,
        source=source,
        legacy_split_by_sample=legacy_split_by_sample,
        predecessor_master=predecessor_master,
        predecessor_split_by_sample=predecessor_split_by_sample,
    )
    if prior_calibration_binding_values:
        calibration_contract = require_mapping(
            contract.get("calibration"), "contract.calibration"
        )
        prior_excluded_ids = list(prior_calibration["excluded_sample_ids"])
        prior_training_ids = list(prior_calibration["training_quarantine_sample_ids"])
        prior_expected = {
            "prior_calibration_subset_count": len(prior_calibration_paths),
            "prior_calibration_excluded_sample_count": len(prior_excluded_ids),
            "prior_calibration_excluded_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(prior_excluded_ids)
            ),
            "prior_training_quarantine_sample_ids": prior_training_ids,
            "prior_training_quarantine_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(prior_training_ids)
            ),
        }
        for key, expected in prior_expected.items():
            if calibration_contract.get(key) != expected:
                raise DeltaLedgerError(
                    f"workspace prior calibration metadata changed: {key}"
                )
        subset_expected = {
            "prior_calibration_subset_count": len(prior_calibration_paths),
            "prior_calibration_excluded_sample_count": len(prior_excluded_ids),
            "prior_calibration_excluded_sample_ids_sha256": prior_expected[
                "prior_calibration_excluded_sample_ids_sha256"
            ],
            "prior_training_quarantine_sample_count": len(prior_training_ids),
            "prior_training_quarantine_sample_ids_sha256": prior_expected[
                "prior_training_quarantine_sample_ids_sha256"
            ],
        }
        for key, expected in subset_expected.items():
            if calibration_subset.get(key) != expected:
                raise DeltaLedgerError(
                    f"calibration subset prior-round metadata changed: {key}"
                )
    elif "prior_calibration_subsets" in contract:
        calibration_contract = require_mapping(
            contract.get("calibration"), "contract.calibration"
        )
        empty_sha = sha256_bytes(canonical_json_bytes([]))
        expected_empty_contract = {
            "prior_calibration_subset_count": 0,
            "prior_calibration_excluded_sample_count": 0,
            "prior_calibration_excluded_sample_ids_sha256": empty_sha,
            "prior_training_quarantine_sample_ids": [],
            "prior_training_quarantine_sample_ids_sha256": empty_sha,
        }
        for key, expected in expected_empty_contract.items():
            if calibration_contract.get(key) != expected:
                raise DeltaLedgerError(
                    f"workspace empty prior calibration metadata changed: {key}"
                )
        expected_empty_subset = {
            "prior_calibration_subset_count": 0,
            "prior_calibration_excluded_sample_count": 0,
            "prior_calibration_excluded_sample_ids_sha256": empty_sha,
            "prior_training_quarantine_sample_count": 0,
            "prior_training_quarantine_sample_ids_sha256": empty_sha,
        }
        for key, expected in expected_empty_subset.items():
            if calibration_subset.get(key) != expected:
                raise DeltaLedgerError(
                    f"calibration subset empty prior-round metadata changed: {key}"
                )

    supplement = source.get("calibration_only_supplement")
    if isinstance(supplement, Mapping):
        if contract.get("mode") == "production":
            if successor_authority_only_declared:
                raise DeltaLedgerError(
                    "production cannot use successor-authority-only calibration"
                )
            required_exclusions = set(
                _string_array(
                    supplement.get("training_quarantine_sample_ids"),
                    "calibration supplement.training_quarantine_sample_ids",
                )
            )
            if not required_exclusions.issubset(
                set(prior_calibration["excluded_sample_ids"])
            ):
                raise DeltaLedgerError(
                    "production calibration-only supplement escaped its permanent prior-round exclusion"
                )
        else:
            active_round_matches = nested(
                contract, "calibration", "round_id"
            ) == supplement.get("round_id")
            if active_round_matches and successor_authority_only_declared:
                raise DeltaLedgerError(
                    "the supplement's own calibration round cannot declare "
                    "successor-authority-only mode"
                )
            if not active_round_matches and not successor_authority_only_declared:
                raise DeltaLedgerError(
                    "workspace calibration round differs from its supplement"
                )
    elif successor_authority_only_declared:
        raise DeltaLedgerError(
            "successor-authority-only calibration cannot fall back to the old authority"
        )

    bindings = read_jsonl(bindings_path)
    tasks = read_jsonl(tasks_path)
    if read_jsonl(primary_tasks_path) != [
        row for row in tasks if row.get("stage") == "primary"
    ] or read_jsonl(secondary_tasks_path) != [
        row for row in tasks if row.get("stage") == "secondary"
    ]:
        raise DeltaLedgerError("stage-separated blind task exports changed")
    by_assignment: dict[str, Mapping[str, Any]] = {}
    bindings_by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    normalized_bindings: list[dict[str, Any]] = []
    source_assignment_ids: set[str] = set()
    public_sample_by_private: dict[str, str] = {}
    for index, binding in enumerate(bindings):
        validate_seal(binding, f"private bindings[{index}]")
        if (
            binding.get("record_type") != "font_catalog_delta_private_binding"
            or binding.get("visibility") != "private_reveal_mapping_merge_only"
        ):
            raise DeltaLedgerError(f"private bindings[{index}] has invalid visibility")
        assignment = require_mapping(
            binding.get("assignment"), f"private bindings[{index}].assignment"
        )
        assignment_id = require_id(
            assignment.get("assignment_id"), f"private bindings[{index}].assignment_id"
        )
        sample_id = require_id(
            binding.get("sample_id"), f"private bindings[{index}].sample_id"
        )
        stage = require_text(
            assignment.get("stage"), f"private bindings[{index}].stage"
        )
        if (
            assignment_id in source_assignment_ids
            or stage in bindings_by_sample[sample_id]
        ):
            raise DeltaLedgerError("workspace private bindings contain duplicates")
        source_assignment_ids.add(assignment_id)
        source_assignment = source["assignments"].get(assignment_id)
        expected_serialized_assignment = (
            {
                key: source_assignment[key]
                for key in (
                    "assignment_id",
                    "sample_id",
                    "work_id",
                    "source_page_sha256",
                    "stage",
                    "review_order",
                )
            }
            if source_assignment is not None and v5_required
            else source_assignment
        )
        if source_assignment is None or dict(assignment) != dict(
            expected_serialized_assignment
        ):
            raise DeltaLedgerError(f"{assignment_id}: private assignment changed")
        if sample_id != assignment.get("sample_id"):
            raise DeltaLedgerError(f"{assignment_id}: sample binding changed")
        card = require_mapping(binding.get("card"), f"private bindings[{index}].card")
        if card.get("assignment_id") != assignment_id or card.get("stage") != stage:
            raise DeltaLedgerError(f"{assignment_id}: private card binding changed")
        require_sha(
            card.get("review_card_sha256"), f"{assignment_id}.review_card_sha256"
        )
        if contract.get("verify_card_files") is True:
            card_path = Path(
                require_text(
                    card.get("review_card_file"), f"{assignment_id}.review_card_file"
                )
            )
            if not card_path.is_file() or sha256_file(card_path) != card.get(
                "review_card_sha256"
            ):
                raise DeltaLedgerError(f"{assignment_id}: review-card bytes changed")
        if contract.get("v5_derivation_required") is True:
            require_exact_keys(
                card,
                {
                    "assignment_id",
                    "sample_id",
                    "stage",
                    "review_card_sha256",
                    "review_card_file",
                    "v5_public_ids",
                    "v5_source_card",
                },
                f"{assignment_id}.card",
            )
            public_ids = require_mapping(
                card.get("v5_public_ids"), f"{assignment_id}.v5_public_ids"
            )
            require_exact_keys(
                public_ids,
                {"assignment_id", "sample_id"},
                f"{assignment_id}.v5_public_ids",
            )
            public_assignment_id = require_id(
                public_ids.get("assignment_id"),
                f"{assignment_id}.v5_public_ids.assignment_id",
            )
            public_sample_id = require_id(
                public_ids.get("sample_id"),
                f"{assignment_id}.v5_public_ids.sample_id",
            )
            if public_assignment_id == assignment_id or public_sample_id == sample_id:
                raise DeltaLedgerError(
                    f"{assignment_id}: v5 public IDs reuse stable source identities"
                )
            prior_public_sample = public_sample_by_private.setdefault(
                sample_id, public_sample_id
            )
            if prior_public_sample != public_sample_id:
                raise DeltaLedgerError(
                    f"{sample_id}: v5 public sample token changed between stages"
                )
            source_card = require_mapping(
                card.get("v5_source_card"), f"{assignment_id}.v5_source_card"
            )
            require_exact_keys(
                source_card,
                {"file", "sha256", "pixel_sha256", "size_px"},
                f"{assignment_id}.v5_source_card",
            )
            source_card_path = Path(
                require_text(
                    source_card.get("file"), f"{assignment_id}.v5_source_card.file"
                )
            ).resolve()
            try:
                source_card_path.relative_to((root / "source-cards").resolve())
            except ValueError as error:
                raise DeltaLedgerError(
                    f"{assignment_id}: source-only card escapes the workspace A surface"
                ) from error
            source_card_sha = require_sha(
                source_card.get("sha256"), f"{assignment_id}.v5_source_card.sha256"
            )
            size = require_list(
                source_card.get("size_px"), f"{assignment_id}.v5_source_card.size_px"
            )
            if len(size) != 2:
                raise DeltaLedgerError(f"{assignment_id}: invalid source-card size")
            if (
                card.get("review_card_file") != str(source_card_path)
                or card.get("review_card_sha256") != source_card_sha
            ):
                raise DeltaLedgerError(
                    f"{assignment_id}: pre-release review card is not source-only"
                )
            if contract.get("verify_card_files") is True:
                _open_v5_review_image(
                    source_card_path,
                    expected_pixel_sha256=require_sha(
                        source_card.get("pixel_sha256"),
                        f"{assignment_id}.v5_source_card.pixel_sha256",
                    ),
                    expected_size=(int(size[0]), int(size[1])),
                    location=f"{assignment_id}.v5_source_card",
                )
        else:
            public_assignment_id = assignment_id
        expected_alias_map = {
            alias: source["alias_to_id"][alias]
            for alias in source_assignment["blind_alias_order"]
        }
        if v5_required:
            if "alias_to_candidate_id" in binding:
                raise DeltaLedgerError(
                    f"{assignment_id}: pre-release binding exposes candidate identities"
                )
        else:
            alias_map = require_mapping(
                binding.get("alias_to_candidate_id"),
                f"{assignment_id}.alias_to_candidate_id",
            )
            if dict(alias_map) != expected_alias_map:
                raise DeltaLedgerError(f"{assignment_id}: private reveal map changed")
        selection = source["selection"][sample_id]
        if binding.get("selection_record_sha256") != selection.get(
            "record_sha256"
        ) or binding.get(
            "prior_final_record_sha256"
        ) != _selection_prior_final_record_sha256(
            selection, location=f"selection[{sample_id}]"
        ):
            raise DeltaLedgerError(f"{assignment_id}: merge source binding changed")
        if public_assignment_id in by_assignment:
            raise DeltaLedgerError("workspace public assignment IDs are not unique")
        runtime_binding = copy.deepcopy(dict(binding))
        runtime_binding["assignment"] = copy.deepcopy(dict(source_assignment))
        runtime_binding["alias_to_candidate_id"] = expected_alias_map
        by_assignment[public_assignment_id] = runtime_binding
        bindings_by_sample[sample_id][stage] = runtime_binding
        normalized_bindings.append(runtime_binding)

    task_by_assignment: dict[str, Mapping[str, Any]] = {}
    candidate_ids = set(source["alias_to_id"].values())
    for index, task in enumerate(tasks):
        validate_seal(task, f"blind tasks[{index}]")
        _walk_identity_leaks(
            task,
            candidate_ids=candidate_ids,
            identity_tokens=source["identity_tokens"],
            location=f"blind tasks[{index}]",
        )
        assignment_id = require_id(
            task.get("assignment_id"), f"blind tasks[{index}].assignment_id"
        )
        if assignment_id in task_by_assignment or assignment_id not in by_assignment:
            raise DeltaLedgerError(
                "blind tasks contain duplicate or unknown assignment"
            )
        binding = by_assignment[assignment_id]
        expected = _public_task(
            require_mapping(binding["assignment"], f"{assignment_id}.assignment"),
            require_mapping(binding["card"], f"{assignment_id}.card"),
        )
        if dict(task) != expected:
            raise DeltaLedgerError(f"{assignment_id}: public blind task changed")
        if contract.get("v5_derivation_required") is True:
            try:
                v5_deriver.validate_source_task(task, f"blind tasks[{index}]")
            except v5_deriver.DerivationError as error:
                raise DeltaLedgerError(str(error)) from error
        elif task.get("schema_version") == v5_deriver.TASK_SCHEMA_VERSION:
            raise DeltaLedgerError("legacy workspace unexpectedly contains a v5 task")
        task_by_assignment[assignment_id] = task
    if set(task_by_assignment) != set(by_assignment):
        raise DeltaLedgerError("blind task coverage differs from private bindings")
    sample_ids = set(bindings_by_sample)
    if sha256_bytes(canonical_json_bytes(sorted(sample_ids))) != contract.get(
        "selected_sample_ids_sha256"
    ) or len(sample_ids) != contract.get("selected_sample_count"):
        raise DeltaLedgerError("workspace selected sample inventory changed")
    if (
        contract.get("v5_derivation_required") is True
        and contract.get("mode") == "production"
    ):
        production_prior_overlap = sorted(
            sample_ids.intersection(prior_calibration["excluded_sample_ids"])
        )
        if production_prior_overlap:
            raise DeltaLedgerError(
                "v5 production pool reuses a permanent prior-calibration closure: "
                f"{production_prior_overlap[:5]}"
            )
    calibration_ids = _string_array(
        calibration_subset.get("sample_ids"), "calibration subset.sample_ids"
    )
    if calibration_subset.get("sample_count") != len(calibration_ids):
        raise DeltaLedgerError("calibration subset count changed")
    if contract.get("mode") == "calibration":
        prior_overlap = sorted(
            sample_ids.intersection(prior_calibration["excluded_sample_ids"])
        )
        if prior_overlap:
            raise DeltaLedgerError(
                "calibration workspace reuses a prior calibration leakage closure: "
                f"{prior_overlap[:5]}"
            )
        if (
            set(calibration_ids) != sample_ids
            or calibration_subset.get("development_only") is not True
        ):
            raise DeltaLedgerError(
                "calibration subset does not match workspace inventory"
            )
        calibration_contract = require_mapping(
            contract.get("calibration"), "contract.calibration"
        )
        subset_authority_only = (
            calibration_subset.get("successor_authority_only") is True
        )
        if subset_authority_only != successor_authority_only_declared:
            raise DeltaLedgerError(
                "calibration subset successor-authority-only mode differs from "
                "its contract"
            )
        if successor_authority_only_declared:
            supplement = require_mapping(
                source.get("calibration_only_supplement"),
                "source.calibration_only_supplement",
            )
            declared_binding = require_mapping(
                calibration_contract.get("successor_authority_binding"),
                "contract.calibration.successor_authority_binding",
            )
            subset_binding = require_mapping(
                calibration_subset.get("successor_authority_binding"),
                "calibration subset.successor_authority_binding",
            )
            if dict(declared_binding) != dict(subset_binding):
                raise DeltaLedgerError(
                    "calibration subset successor authority differs from its contract"
                )
            _validate_successor_authority_only_prior(
                supplement=supplement,
                selected_ids=sample_ids,
                prior_excluded_ids=set(prior_calibration["excluded_sample_ids"]),
                prior_training_quarantine_ids=set(
                    prior_calibration["training_quarantine_sample_ids"]
                ),
                prior_subset_paths=prior_calibration_paths,
            )
            if canonical_master_split is None:
                raise DeltaLedgerError(
                    "successor-authority-only workspace lacks the sealed split map"
                )
            selection_manifest_path = _validate_file_binding(
                require_mapping(
                    declared_binding.get("selection_manifest"),
                    "successor authority selection manifest binding",
                ),
                "successor authority selection manifest binding",
            )
            (
                selected_from_manifest,
                selection_manifest_binding,
            ) = _read_successor_authority_selection_manifest(
                selection_manifest_path,
                round_id=require_id(
                    calibration_contract.get("round_id"),
                    "contract.calibration.round_id",
                ),
            )
            if selected_from_manifest != sample_ids or selection_manifest_binding.get(
                "record_sha256"
            ) != declared_binding.get("selection_manifest_record_sha256"):
                raise DeltaLedgerError("successor authority selection manifest changed")
            recomputed_binding = _successor_authority_only_binding(
                source,
                supplement=supplement,
                selected_ids=sample_ids,
                split_by_sample=canonical_master_split["split_by_sample"],
                predecessor_master=predecessor_master,
                predecessor_split_by_sample=predecessor_split_by_sample,
                selection_manifest_binding=selection_manifest_binding,
            )
            authority_closure_overlap = sorted(
                set(
                    recomputed_binding["successor_training_quarantine_sample_ids"]
                ).intersection(prior_calibration["excluded_sample_ids"])
            )
            if authority_closure_overlap:
                raise DeltaLedgerError(
                    "successor-authority-only closure overlaps a prior "
                    f"calibration exclusion: {authority_closure_overlap[:5]}"
                )
            if dict(declared_binding) != recomputed_binding:
                raise DeltaLedgerError(
                    "successor-authority-only selection binding changed"
                )
        elif (
            calibration_contract.get("successor_authority_binding") is not None
            or calibration_subset.get("successor_authority_binding") is not None
        ):
            raise DeltaLedgerError(
                "calibration contains an inactive successor authority binding"
            )
        selection_profile = calibration_contract.get("selection_profile")
        if selection_profile is None:
            if calibration_subset.get("selection_profile") not in {None}:
                raise DeltaLedgerError(
                    "calibration subset selection profile differs from its contract"
                )
        elif selection_profile == VARIANT_V4_CALIBRATION_PROFILE:
            profile_contract = _variant_v4_profile_contract()
            profile_sha = sha256_bytes(canonical_json_bytes(profile_contract))
            for key, expected in {
                "selection_profile": VARIANT_V4_CALIBRATION_PROFILE,
                "selection_profile_contract": profile_contract,
                "selection_profile_contract_sha256": profile_sha,
            }.items():
                if (
                    calibration_contract.get(key) != expected
                    or calibration_subset.get(key) != expected
                ):
                    raise DeltaLedgerError(
                        f"variant-first v4 profile binding changed: {key}"
                    )
            if (
                calibration_contract.get("selection_method")
                != VARIANT_V4_SELECTION_METHOD
                or calibration_subset.get("selection_method")
                != VARIANT_V4_SELECTION_METHOD
            ):
                raise DeltaLedgerError(
                    "variant-first v4 selection method binding changed"
                )
            selection_audit = require_mapping(
                calibration_contract.get("selection_audit"),
                "contract.calibration.selection_audit",
            )
            if dict(selection_audit) != dict(
                require_mapping(
                    calibration_subset.get("selection_audit"),
                    "calibration subset.selection_audit",
                )
            ):
                raise DeltaLedgerError(
                    "variant-first v4 selection audit differs from its contract"
                )
            _validate_variant_v4_selection_audit(
                source,
                sample_ids=calibration_ids,
                audit=selection_audit,
                excluded_sample_ids=frozenset(prior_calibration["excluded_sample_ids"]),
            )
        else:
            raise DeltaLedgerError(
                f"workspace has unsupported calibration profile: {selection_profile}"
            )
        source_split = calibration_contract.get("source_split")
        reservoir = calibration_contract.get("reservoir")
        quarantine_required = calibration_contract.get("training_quarantine_required")
        if (
            source_split not in {"train", "val"}
            or reservoir not in {"val", "train_quarantine"}
            or calibration_contract.get("test_split_forbidden") is not True
            or calibration_subset.get("source_split") != source_split
            or calibration_subset.get("test_split_forbidden") is not True
            or calibration_subset.get("training_quarantine_required")
            is not quarantine_required
            or quarantine_required != (source_split == "train")
            or reservoir != ("train_quarantine" if source_split == "train" else "val")
        ):
            raise DeltaLedgerError("calibration reservoir contract is inconsistent")
        if any(
            source["split_by_sample"].get(sample_id) != source_split
            for sample_id in sample_ids
        ):
            raise DeltaLedgerError(
                f"calibration workspace includes a non-{source_split} sample"
            )
        quarantine_ids = _string_array(
            calibration_contract.get("training_quarantine_sample_ids"),
            "contract.calibration.training_quarantine_sample_ids",
        )
        if len(quarantine_ids) != len(set(quarantine_ids)):
            raise DeltaLedgerError("calibration quarantine contains duplicates")
        quarantine_sha = sha256_bytes(canonical_json_bytes(sorted(quarantine_ids)))
        if quarantine_sha != calibration_contract.get(
            "training_quarantine_sample_ids_sha256"
        ):
            raise DeltaLedgerError("calibration quarantine hash changed")
        if (
            calibration_subset.get("training_quarantine_sample_ids") != quarantine_ids
            or calibration_subset.get("training_quarantine_sample_ids_sha256")
            != quarantine_sha
        ):
            raise DeltaLedgerError(
                "calibration subset quarantine differs from its contract"
            )
        expected_quarantine = (
            _sealed_calibration_training_quarantine(
                source,
                sample_ids,
                successor_authority_only=(
                    successor_authority_binding_declared
                    if successor_authority_only_declared
                    else None
                ),
            )
            if quarantine_required
            else []
        )
        if quarantine_ids != expected_quarantine:
            raise DeltaLedgerError("calibration quarantine closure changed")
    elif calibration_ids or calibration_subset.get("development_only") is not False:
        raise DeltaLedgerError("production workspace contains a calibration subset")

    reviews = read_jsonl(reviews_path, missing_ok=True)
    state = {
        "root": root,
        "contract": contract,
        "source": source,
        "bindings": normalized_bindings,
        "by_assignment": by_assignment,
        "bindings_by_sample": bindings_by_sample,
        "tasks": tasks,
        "task_by_assignment": task_by_assignment,
        "prior_calibration": prior_calibration,
        "master_split_map": canonical_master_split,
        "reviews": reviews,
        "reviews_path": reviews_path,
        "source_commits": (
            read_jsonl(source_commits_path, missing_ok=True) if v5_required else []
        ),
        "source_commits_path": source_commits_path,
        "candidate_releases": (
            read_jsonl(candidate_releases_path, missing_ok=True) if v5_required else []
        ),
        "candidate_releases_path": candidate_releases_path,
    }
    if v5_required:
        state.update(_validate_v5_stage_state(state))
    return state


def _decision_identity_leak(
    value: Any, state: Mapping[str, Any], location: str
) -> None:
    source = require_mapping(state.get("source"), "state.source")
    candidate_ids = set(
        require_mapping(source.get("alias_to_id"), "source.alias_to_id").values()
    )
    identity_tokens = set(source.get("identity_tokens", set()))

    def walk(child: Any, path: str) -> None:
        if isinstance(child, Mapping):
            for key, grandchild in child.items():
                if str(key).casefold() in {
                    "font_id",
                    "font_name",
                    "font_label",
                    "candidate_order",
                    "reveal_map",
                }:
                    raise DeltaLedgerError(
                        f"{path}: decision exposes candidate identity"
                    )
                walk(grandchild, f"{path}.{key}")
        elif isinstance(child, list):
            for index, grandchild in enumerate(child):
                walk(grandchild, f"{path}[{index}]")
        elif isinstance(child, str):
            folded = child.casefold()
            if child in candidate_ids:
                raise DeltaLedgerError(f"{path}: decision must use blind aliases only")
            # Reject an identity token even inside free-form rationale.
            for token in identity_tokens:
                if len(token) >= 4 and token in folded:
                    raise DeltaLedgerError(
                        f"{path}: decision rationale exposes candidate identity"
                    )

    walk(value, location)


DECISION_KEYS = {
    "assignment_id",
    "sample_id",
    "review_card_sha256",
    "candidate_order_seed",
    "role",
    "role_confidence",
    "eligibility",
    "font_judgment",
    "confidence",
    "rationale",
}
V5_DECISION_KEYS = DECISION_KEYS | {
    "candidate_release_record_sha256",
    "release_challenge_sha256",
    "release_nonce_sha256",
}


def blind_decision_json_schema() -> dict[str, Any]:
    alias = {"type": "string", "pattern": ALIAS_RE.pattern}
    tier = {"type": "array", "items": alias, "uniqueItems": True}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://carrot-manga-translator.local/schemas/font-catalog-delta-blind-decision-v1.json",
        "title": "Blind seven-font delta decision",
        "type": "object",
        "additionalProperties": False,
        "required": sorted(DECISION_KEYS),
        "properties": {
            "assignment_id": {"type": "string", "pattern": ID_RE.pattern},
            "sample_id": {"type": "string", "pattern": ID_RE.pattern},
            "review_card_sha256": {"type": "string", "pattern": SHA_RE.pattern},
            "candidate_order_seed": {"type": "string", "pattern": SHA_RE.pattern},
            "role": {"type": "string", "enum": list(ROLE_VALUES)},
            "role_confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "eligibility": {"type": "string", "enum": list(ELIGIBILITY_VALUES)},
            "font_judgment": {
                "oneOf": [
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": [*TIERS, "none_acceptable"],
                        "properties": {
                            **{name: tier for name in TIERS},
                            "none_acceptable": {"type": "boolean"},
                        },
                    },
                    {"type": "null"},
                ]
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "rationale": {"type": "string", "minLength": 12, "maxLength": 4000},
        },
        "$comment": (
            "font_signal_present requires all seven sealed aliases to partition the "
            "five tiers exactly once. absent/crop_needs_review requires null judgment "
            "and is fail-closed into the sealed eligibility exception queue."
        ),
    }


def _validate_decision(
    decision: Mapping[str, Any],
    *,
    binding: Mapping[str, Any],
    state: Mapping[str, Any],
    location: str,
    v5_candidate_task: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    require_exact_keys(
        decision,
        V5_DECISION_KEYS if v5_candidate_task is not None else DECISION_KEYS,
        location,
    )
    _decision_identity_leak(decision, state, location)
    assignment = require_mapping(
        binding.get("assignment"), f"{location}.binding.assignment"
    )
    card = require_mapping(binding.get("card"), f"{location}.binding.card")
    public_task = _public_task(assignment, card)
    expected = {
        "assignment_id": public_task.get("assignment_id"),
        "sample_id": public_task.get("sample_id"),
        "review_card_sha256": (
            v5_candidate_task["full_card_sha256"]
            if v5_candidate_task is not None
            else card.get("review_card_sha256")
        ),
        "candidate_order_seed": (
            v5_candidate_task["candidate_order_seed"]
            if v5_candidate_task is not None
            else assignment.get("candidate_order_seed")
        ),
        **(
            {
                "candidate_release_record_sha256": v5_candidate_task[
                    "candidate_release_record_sha256"
                ],
                "release_challenge_sha256": v5_candidate_task[
                    "release_challenge_sha256"
                ],
                "release_nonce_sha256": v5_candidate_task["release_nonce_sha256"],
            }
            if v5_candidate_task is not None
            else {}
        ),
    }
    for field, expected_value in expected.items():
        if decision.get(field) != expected_value:
            raise DeltaLedgerError(f"{location}.{field} does not match the sealed task")
    role = decision.get("role")
    if role not in ROLE_VALUES:
        raise DeltaLedgerError(f"{location}.role is unsupported")
    role_confidence = require_unit(
        decision.get("role_confidence"), f"{location}.role_confidence"
    )
    confidence = require_unit(decision.get("confidence"), f"{location}.confidence")
    rationale = require_text(decision.get("rationale"), f"{location}.rationale").strip()
    if len(rationale) < 12 or len(rationale) > 4000:
        raise DeltaLedgerError(f"{location}.rationale must be 12..4000 characters")
    eligibility = decision.get("eligibility")
    if eligibility not in ELIGIBILITY_VALUES:
        raise DeltaLedgerError(f"{location}.eligibility is unsupported")
    judgment: dict[str, Any] | None
    if eligibility == "font_signal_present":
        aliases = set(
            v5_candidate_task["blind_alias_order"]
            if v5_candidate_task is not None
            else assignment.get("blind_alias_order", [])
        )
        partition = _validate_partition(
            require_mapping(decision.get("font_judgment"), f"{location}.font_judgment"),
            aliases,
            f"{location}.font_judgment",
        )
        mandatory_unrenderable = set(
            v5_candidate_task["mandatory_unrenderable"]
            if v5_candidate_task is not None
            else card.get("mandatory_unrenderable", [])
        )
        if not mandatory_unrenderable.issubset(set(partition["unrenderable"])):
            raise DeltaLedgerError(
                f"{location}: card-declared unrenderable candidates must stay unrenderable"
            )
        judgment = {
            **partition,
            "none_acceptable": bool(decision["font_judgment"]["none_acceptable"]),
        }
    else:
        if decision.get("font_judgment") is not None:
            raise DeltaLedgerError(
                f"{location}: eligibility exception forbids all candidate tiers; font_judgment must be null"
            )
        judgment = None
    return {
        "role": str(role),
        "role_confidence": role_confidence,
        "eligibility": str(eligibility),
        "font_judgment": judgment,
        "confidence": confidence,
        "rationale": rationale,
    }


def _v5_task_for_stage(task: Mapping[str, Any], stage: str) -> dict[str, Any]:
    if task.get("stage") == stage:
        return copy.deepcopy(dict(task))
    if stage != "adjudication" or task.get("stage") != "primary":
        raise DeltaLedgerError("v5 derivation task stage cannot be rebound")
    payload = copy.deepcopy(dict(task))
    payload.pop("record_sha256", None)
    payload["stage"] = "adjudication"
    return v5_deriver.seal_record(payload)


def _v5_rows_by_assignment(
    rows: Sequence[Mapping[str, Any]],
    *,
    label: str,
) -> dict[str, Mapping[str, Any]]:
    result: dict[str, Mapping[str, Any]] = {}
    for index, value in enumerate(rows):
        row = require_mapping(value, f"{label}[{index}]")
        assignment_id = require_id(
            row.get("assignment_id"), f"{label}[{index}].assignment_id"
        )
        if assignment_id in result:
            raise DeltaLedgerError(f"{label} repeats assignment {assignment_id}")
        result[assignment_id] = row
    return result


def _validate_master_split_map(
    path: Path, *, source: Mapping[str, Any]
) -> dict[str, Any]:
    """Verify the actual canonical work split file against every source row."""

    resolved = path.resolve()
    if not resolved.is_file():
        raise DeltaLedgerError(f"master split map is missing: {resolved}")
    actual_sha = sha256_file(resolved)
    supplement = source.get("calibration_only_supplement")
    expected_sha = (
        require_sha(
            supplement.get("successor_master_split_map_sha256"),
            "calibration supplement.successor_master_split_map_sha256",
        )
        if isinstance(supplement, Mapping)
        else require_sha(
            nested(source, "source_report", "inputs", "master_split_map_sha256"),
            "source report.inputs.master_split_map_sha256",
        )
    )
    if actual_sha != expected_sha:
        raise DeltaLedgerError(
            "actual --master-split-map SHA differs from the sealed active source authority"
        )
    document = read_json(resolved)
    work_assignments = require_mapping(
        document.get("work_assignments"), "master split map.work_assignments"
    )
    if not work_assignments:
        raise DeltaLedgerError("master split map has no work assignments")
    normalized_assignments: dict[str, str] = {}
    for work_id_value, split_value in work_assignments.items():
        work_id = require_id(work_id_value, "master split map.work_id")
        if split_value not in {"train", "val", "test"}:
            raise DeltaLedgerError(
                f"master split map has unsupported split for {work_id}"
            )
        normalized_assignments[work_id] = str(split_value)

    components = require_list(document.get("components"), "master split map.components")
    component_work_ids: set[str] = set()
    for index, value in enumerate(components):
        component = require_mapping(value, f"master split map.components[{index}]")
        split = component.get("split")
        work_ids = _string_array(
            component.get("work_ids"),
            f"master split map.components[{index}].work_ids",
        )
        if component.get("work_count") != len(work_ids) or not work_ids:
            raise DeltaLedgerError(
                f"master split map.components[{index}] work_count changed"
            )
        for work_id in work_ids:
            if work_id in component_work_ids:
                raise DeltaLedgerError(
                    f"master split map repeats work {work_id} across components"
                )
            if normalized_assignments.get(work_id) != split:
                raise DeltaLedgerError(
                    f"master split map component assignment changed for {work_id}"
                )
            component_work_ids.add(work_id)
    if component_work_ids != set(normalized_assignments):
        raise DeltaLedgerError(
            "master split map components do not cover the work assignment map"
        )

    canonical_by_sample: dict[str, str] = {}
    for sample_id, master_value in source["master"].items():
        master = require_mapping(master_value, f"master[{sample_id}]")
        work = master.get("work")
        work_id = (
            require_id(work.get("id"), f"master[{sample_id}].work.id")
            if isinstance(work, Mapping)
            else require_id(
                nested(source, "selection", sample_id, "work_id"),
                f"selection[{sample_id}].work_id",
            )
        )
        canonical_split = normalized_assignments.get(work_id)
        if canonical_split is None:
            raise DeltaLedgerError(
                f"master[{sample_id}] work {work_id} is absent from the split map"
            )
        declared_split = master.get("split")
        if declared_split is not None and declared_split != canonical_split:
            raise DeltaLedgerError(
                f"master[{sample_id}].split differs from canonical work split"
            )
        canonical_by_sample[sample_id] = canonical_split
    algorithm = require_mapping(document.get("algorithm"), "master split map.algorithm")
    frozen_source = algorithm.get("frozen_source")
    frozen_source_sha = (
        require_sha(
            frozen_source.get("sha256"),
            "master split map.algorithm.frozen_source.sha256",
        )
        if isinstance(frozen_source, Mapping)
        else actual_sha
    )
    return {
        "binding": _file_binding(resolved),
        "work_assignments": normalized_assignments,
        "split_by_sample": canonical_by_sample,
        "work_assignments_sha256": sha256_bytes(
            canonical_json_bytes(normalized_assignments)
        ),
        "frozen_source_sha256": frozen_source_sha,
    }


V5_SOURCE_COMMIT_KEYS = {
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


def _v5_commit_tasks_and_annotations(
    *,
    state: Mapping[str, Any],
    stage: str,
    raw_annotations: Sequence[Mapping[str, Any]],
    reviewer: str,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    annotation_by_assignment = _v5_rows_by_assignment(
        raw_annotations, label="source_annotations"
    )
    tasks: list[dict[str, Any]] = []
    annotations: dict[str, dict[str, Any]] = {}
    for assignment_id in sorted(annotation_by_assignment):
        task_value = state["task_by_assignment"].get(assignment_id)
        if task_value is None:
            raise DeltaLedgerError(f"unknown v5 assignment: {assignment_id}")
        try:
            task = v5_deriver.validate_source_task(
                _v5_task_for_stage(task_value, stage),
                f"v5 task {assignment_id}",
            )
            annotation = v5_deriver.validate_annotation(
                annotation_by_assignment[assignment_id],
                f"v5 annotation {assignment_id}",
            )
        except v5_deriver.DerivationError as error:
            raise DeltaLedgerError(str(error)) from error
        if annotation["reviewer_id"] != reviewer or annotation["stage"] != stage:
            raise DeltaLedgerError(
                f"{assignment_id}: v5 annotation reviewer/stage binding changed"
            )
        for annotation_key, task_key in (
            ("assignment_id", "assignment_id"),
            ("sample_id", "sample_id"),
            ("stage", "stage"),
            ("source_only_card_sha256", "source_only_card_sha256"),
        ):
            if annotation[annotation_key] != task[task_key]:
                raise DeltaLedgerError(
                    f"{assignment_id}: annotation.{annotation_key} does not match the sealed task"
                )
        _decision_identity_leak(
            annotation_by_assignment[assignment_id],
            state,
            f"source_annotations[{assignment_id}]",
        )
        if task["sample_id"] in annotations:
            raise DeltaLedgerError("v5 source batch repeats a public sample token")
        tasks.append(task)
        annotations[str(task["sample_id"])] = annotation
    tasks.sort(key=lambda row: str(row["assignment_id"]))
    try:
        v5_deriver._validate_batch_binding(tasks, annotations, reviewer_id=reviewer)
    except v5_deriver.DerivationError as error:
        raise DeltaLedgerError(str(error)) from error
    return tasks, annotations


def _validate_v5_source_commit(
    record: Mapping[str, Any],
    *,
    state: Mapping[str, Any],
    previous_record_sha256: str | None,
    location: str,
) -> dict[str, Any]:
    validate_seal(record, location)
    require_exact_keys(record, V5_SOURCE_COMMIT_KEYS, location)
    if (
        record.get("schema_version") != V5_SOURCE_COMMIT_SCHEMA_VERSION
        or record.get("record_type") != V5_SOURCE_COMMIT_RECORD_TYPE
    ):
        raise DeltaLedgerError(f"{location} has another source-commit contract")
    commit_id = require_id(record.get("commit_id"), f"{location}.commit_id")
    stage = require_text(record.get("stage"), f"{location}.stage")
    if stage not in REVIEW_STAGES:
        raise DeltaLedgerError(f"{location}.stage is unsupported")
    reviewer = require_id(record.get("reviewer_id"), f"{location}.reviewer_id")
    batch_id = require_id(record.get("batch_id"), f"{location}.batch_id")
    annotations_value = require_list(
        record.get("annotations"), f"{location}.annotations"
    )
    raw_annotations = [
        require_mapping(value, f"{location}.annotations[{index}]")
        for index, value in enumerate(annotations_value)
    ]
    if record.get("previous_commit_record_sha256") != previous_record_sha256:
        raise DeltaLedgerError(f"{location} breaks the append-only source-commit chain")
    if record.get("annotation_jsonl_sha256") != sha256_bytes(
        jsonl_bytes(raw_annotations)
    ):
        raise DeltaLedgerError(f"{location}.annotation_jsonl_sha256 changed")
    tasks, annotations = _v5_commit_tasks_and_annotations(
        state=state,
        stage=stage,
        raw_annotations=raw_annotations,
        reviewer=reviewer,
    )
    if (
        record.get("batch_size") != len(tasks)
        or record.get("batch_task_set_sha256") != v5_deriver.task_batch_sha256(tasks)
        or {str(row["batch_id"]) for row in annotations.values()} != {batch_id}
    ):
        raise DeltaLedgerError(f"{location} changed its complete A-batch binding")
    expected_commit_id = f"fmac-{stable_hash('font-matching-v5-source-commit', stage, reviewer, batch_id, str(record['annotation_jsonl_sha256']), str(previous_record_sha256))[:32]}"
    if commit_id != expected_commit_id:
        raise DeltaLedgerError(f"{location}.commit_id is not deterministic")
    require_text(record.get("committed_at"), f"{location}.committed_at")
    return {
        "record": record,
        "commit_id": commit_id,
        "stage": stage,
        "reviewer_id": reviewer,
        "batch_id": batch_id,
        "tasks": tasks,
        "annotations": annotations,
        "assignment_ids": {str(row["assignment_id"]) for row in tasks},
    }


def _validate_v5_candidate_surface(
    *, state: Mapping[str, Any], release: Mapping[str, Any]
) -> list[dict[str, Any]]:
    release_id = str(release["release_id"])
    task_path = state["root"] / "candidate-tasks" / f"{release_id}.jsonl"
    surface_root = state["root"] / "candidate-surfaces" / release_id
    manifest_path = surface_root / "manifest.json"
    if not task_path.is_file() or not manifest_path.is_file():
        raise DeltaLedgerError(
            f"{release_id}: released candidate B lacks materialized tasks/surface"
        )
    candidate_tasks: list[dict[str, Any]] = []
    for index, raw in enumerate(read_jsonl(task_path)):
        try:
            candidate_tasks.append(
                v5_deriver.validate_task(raw, f"{release_id}.tasks[{index}]")
            )
        except v5_deriver.DerivationError as error:
            raise DeltaLedgerError(str(error)) from error
    try:
        v5_deriver.validate_candidate_tasks_for_release(candidate_tasks, release)
    except v5_deriver.DerivationError as error:
        raise DeltaLedgerError(str(error)) from error
    if [int(task["candidate_batch_order"]) for task in candidate_tasks] != list(
        range(len(candidate_tasks))
    ):
        raise DeltaLedgerError(f"{release_id}: candidate task file order changed")

    manifest = read_json(manifest_path)
    validate_seal(manifest, f"{release_id}.candidate_surface")
    require_exact_keys(
        manifest,
        {
            "schema_version",
            "record_type",
            "candidate_release_id",
            "candidate_release_record_sha256",
            "release_nonce_sha256",
            "batch_size",
            "entries",
            "pixel_contract",
            "record_sha256",
        },
        f"{release_id}.candidate_surface",
    )
    if (
        manifest.get("schema_version") != V5_CANDIDATE_SURFACE_SCHEMA_VERSION
        or manifest.get("record_type") != V5_CANDIDATE_SURFACE_RECORD_TYPE
        or manifest.get("candidate_release_id") != release_id
        or manifest.get("candidate_release_record_sha256") != release["record_sha256"]
        or manifest.get("release_nonce_sha256") != release["release_nonce_sha256"]
    ):
        raise DeltaLedgerError(f"{release_id}: candidate surface binding changed")
    expected_pixel_contract = {
        "release_aliases_painted_into_pixels": True,
        "release_candidate_order_applied_to_panels": True,
        "release_nonce_pixel_challenge_visible": True,
        "pre_release_candidate_pixels_reused_verbatim": False,
    }
    if manifest.get("pixel_contract") != expected_pixel_contract:
        raise DeltaLedgerError(f"{release_id}: candidate pixel contract changed")
    rows = require_list(manifest.get("entries"), f"{release_id}.entries")
    if manifest.get("batch_size") != len(rows) or len(rows) != len(candidate_tasks):
        raise DeltaLedgerError(f"{release_id}: candidate surface count changed")
    release_entries = {str(row["assignment_id"]): row for row in release["entries"]}
    task_by_assignment = {str(row["assignment_id"]): row for row in candidate_tasks}
    expected_files = {manifest_path.resolve()}
    for index, row_value in enumerate(rows):
        row = require_mapping(row_value, f"{release_id}.entries[{index}]")
        require_exact_keys(
            row,
            {
                "assignment_id",
                "sample_id",
                "candidate_batch_order",
                "blind_alias_order",
                "candidate_order_seed",
                "source_only",
                "candidate_only",
                "full_card",
            },
            f"{release_id}.entries[{index}]",
        )
        assignment_id = require_id(
            row.get("assignment_id"), f"{release_id}.entries[{index}].assignment_id"
        )
        entry = release_entries.get(assignment_id)
        task = task_by_assignment.get(assignment_id)
        if entry is None or task is None:
            raise DeltaLedgerError(f"{release_id}: candidate surface coverage changed")
        if (
            row.get("sample_id") != entry["sample_id"]
            or row.get("candidate_batch_order") != entry["candidate_batch_order"]
            or row.get("blind_alias_order") != entry["blind_alias_order"]
            or row.get("candidate_order_seed") != entry["candidate_order_seed"]
            or index != entry["candidate_batch_order"]
        ):
            raise DeltaLedgerError(
                f"{release_id}: candidate surface order/alias binding changed"
            )
        decoded: dict[str, Any] = {}
        for name, release_hash_key in (
            ("source_only", "source_only_card_sha256"),
            ("candidate_only", "candidate_only_card_sha256"),
            ("full_card", "full_card_sha256"),
        ):
            descriptor = require_mapping(
                row.get(name), f"{release_id}.{assignment_id}.{name}"
            )
            require_exact_keys(
                descriptor,
                {"file", "sha256", "pixel_sha256", "size_px"},
                f"{release_id}.{assignment_id}.{name}",
            )
            path = Path(
                require_text(
                    descriptor.get("file"),
                    f"{release_id}.{assignment_id}.{name}.file",
                )
            ).resolve()
            allowed_root = (
                (state["root"] / "source-cards").resolve()
                if name == "source_only"
                else surface_root.resolve()
            )
            try:
                path.relative_to(allowed_root)
            except ValueError as error:
                raise DeltaLedgerError(
                    f"{release_id}.{assignment_id}.{name} escapes its release root"
                ) from error
            sha = require_sha(
                descriptor.get("sha256"),
                f"{release_id}.{assignment_id}.{name}.sha256",
            )
            if (
                sha != entry[release_hash_key]
                or not path.is_file()
                or sha256_file(path) != sha
            ):
                raise DeltaLedgerError(
                    f"{release_id}.{assignment_id}.{name} bytes changed"
                )
            size = require_list(
                descriptor.get("size_px"),
                f"{release_id}.{assignment_id}.{name}.size_px",
            )
            if len(size) != 2:
                raise DeltaLedgerError(
                    f"{release_id}.{assignment_id}.{name} size changed"
                )
            decoded[name] = _open_v5_review_image(
                path,
                expected_pixel_sha256=require_sha(
                    descriptor.get("pixel_sha256"),
                    f"{release_id}.{assignment_id}.{name}.pixel_sha256",
                ),
                expected_size=(int(size[0]), int(size[1])),
                location=f"{release_id}.{assignment_id}.{name}",
            )
            if name != "source_only":
                expected_files.add(path)
        _validate_v5_review_image_rejoin(
            assignment_id=assignment_id,
            full=decoded["full_card"],
            source=decoded["source_only"],
            candidate=decoded["candidate_only"],
            split_contract={
                "canvas_px": list(decoded["full_card"].size),
                "source_box_px": [
                    0,
                    0,
                    decoded["source_only"].width,
                    decoded["source_only"].height,
                ],
                "candidate_box_px": [
                    0,
                    decoded["source_only"].height,
                    decoded["candidate_only"].width,
                    decoded["full_card"].height,
                ],
            },
        )
    actual_files = {
        path.resolve() for path in surface_root.rglob("*") if path.is_file()
    }
    if actual_files != expected_files:
        raise DeltaLedgerError(
            f"{release_id}: candidate surface file inventory changed"
        )
    return candidate_tasks


def _validate_v5_stage_state(state: Mapping[str, Any]) -> dict[str, Any]:
    commits_by_id: dict[str, dict[str, Any]] = {}
    commit_by_assignment_stage: dict[tuple[str, str], dict[str, Any]] = {}
    previous_sha: str | None = None
    for index, value in enumerate(state.get("source_commits", [])):
        raw = require_mapping(value, f"source commits[{index}]")
        commit = _validate_v5_source_commit(
            raw,
            state=state,
            previous_record_sha256=previous_sha,
            location=f"source commits[{index}]",
        )
        if commit["commit_id"] in commits_by_id:
            raise DeltaLedgerError("v5 source commit IDs are not unique")
        for assignment_id in commit["assignment_ids"]:
            key = (assignment_id, str(commit["stage"]))
            if key in commit_by_assignment_stage:
                raise DeltaLedgerError(
                    f"{assignment_id}: source-only A was committed more than once"
                )
            commit_by_assignment_stage[key] = commit
        commits_by_id[str(commit["commit_id"])] = commit
        previous_sha = str(raw["record_sha256"])

    releases_by_commit_id: dict[str, dict[str, Any]] = {}
    candidate_tasks_by_release_id: dict[str, list[dict[str, Any]]] = {}
    release_ids: set[str] = set()
    for index, value in enumerate(state.get("candidate_releases", [])):
        raw = require_mapping(value, f"candidate releases[{index}]")
        source_commit_id = require_id(
            raw.get("source_commit_id"),
            f"candidate releases[{index}].source_commit_id",
        )
        commit = commits_by_id.get(source_commit_id)
        if commit is None:
            raise DeltaLedgerError(
                f"candidate releases[{index}] lacks a prior immutable A commit"
            )
        try:
            release = v5_deriver.validate_candidate_release(
                raw,
                commit["tasks"],
                commit["annotations"],
                reviewer_id=str(commit["reviewer_id"]),
                location=f"candidate releases[{index}]",
            )
        except v5_deriver.DerivationError as error:
            raise DeltaLedgerError(str(error)) from error
        if (
            release["source_commit_record_sha256"] != commit["record"]["record_sha256"]
            or release["stage"] != commit["stage"]
            or release["batch_id"] != commit["batch_id"]
        ):
            raise DeltaLedgerError(
                f"candidate releases[{index}] changed its prior A commit binding"
            )
        if (
            source_commit_id in releases_by_commit_id
            or release["release_id"] in release_ids
        ):
            raise DeltaLedgerError("a v5 A commit was released more than once")
        releases_by_commit_id[source_commit_id] = release
        release_ids.add(str(release["release_id"]))
        candidate_tasks_by_release_id[str(release["release_id"])] = (
            _validate_v5_candidate_surface(state=state, release=release)
        )
    task_root = state["root"] / "candidate-tasks"
    surface_parent = state["root"] / "candidate-surfaces"
    actual_task_release_ids = (
        {path.stem for path in task_root.glob("*.jsonl")}
        if task_root.exists()
        else set()
    )
    actual_surface_release_ids = (
        {path.name for path in surface_parent.iterdir() if path.is_dir()}
        if surface_parent.exists()
        else set()
    )
    if (
        actual_task_release_ids != release_ids
        or actual_surface_release_ids != release_ids
    ):
        raise DeltaLedgerError(
            "candidate task/surface artifacts exist without an exact sealed release"
        )
    return {
        "v5_commits_by_id": commits_by_id,
        "v5_commit_by_assignment_stage": commit_by_assignment_stage,
        "v5_releases_by_commit_id": releases_by_commit_id,
        "v5_candidate_tasks_by_release_id": candidate_tasks_by_release_id,
    }


def commit_source_annotations(
    workspace: Path,
    *,
    stage: str,
    reviewer: str,
    source_annotations: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    if stage not in REVIEW_STAGES:
        raise DeltaLedgerError(f"unsupported stage: {stage}")
    reviewer_id = require_id(reviewer, "reviewer")
    if not source_annotations:
        raise DeltaLedgerError("source annotation file is empty")
    with workspace_lock(workspace.resolve()):
        state = _load_workspace(workspace)
        if state["contract"].get("v5_derivation_required") is not True:
            raise DeltaLedgerError("source-only A commits require a v5 workspace")
        existing_by_sample, _ = _validate_review_records(state)
        tasks, annotations = _v5_commit_tasks_and_annotations(
            state=state,
            stage=stage,
            raw_annotations=source_annotations,
            reviewer=reviewer_id,
        )
        assignment_ids = {str(row["assignment_id"]) for row in tasks}
        if stage in {"primary", "secondary"}:
            expected_ids = {
                str(task["assignment_id"])
                for task in state["tasks"]
                if task.get("stage") == stage
            }
            if assignment_ids != expected_ids:
                raise DeltaLedgerError(
                    "whole assigned v5 A batch must commit before candidate B "
                    f"(missing={sorted(expected_ids - assignment_ids)[:5]}, "
                    f"extra={sorted(assignment_ids - expected_ids)[:5]})"
                )
        else:
            expected_ids: set[str] = set()
            incomplete_prior_samples: list[str] = []
            for private_sample_id, bindings in state["bindings_by_sample"].items():
                sample_reviews = existing_by_sample.get(private_sample_id, {})
                if "primary" not in sample_reviews:
                    incomplete_prior_samples.append(private_sample_id)
                    continue
                if _has_eligibility_exception(sample_reviews):
                    continue
                secondary_required = "secondary" in bindings
                if secondary_required and "secondary" not in sample_reviews:
                    incomplete_prior_samples.append(private_sample_id)
                    continue
                if _trigger_reasons(
                    sample_reviews, secondary_required=secondary_required
                ):
                    public_ids = require_mapping(
                        nested(bindings, "primary", "card", "v5_public_ids"),
                        f"{private_sample_id}.primary.card.v5_public_ids",
                    )
                    expected_ids.add(
                        require_id(
                            public_ids.get("assignment_id"),
                            f"{private_sample_id}.public_assignment_id",
                        )
                    )
            if incomplete_prior_samples:
                raise DeltaLedgerError(
                    "whole adjudication A batch waits for every required primary/secondary "
                    f"review: {sorted(incomplete_prior_samples)[:5]}"
                )
            if assignment_ids != expected_ids:
                raise DeltaLedgerError(
                    "whole triggered adjudication A batch must commit before candidate B "
                    f"(missing={sorted(expected_ids - assignment_ids)[:5]}, "
                    f"extra={sorted(assignment_ids - expected_ids)[:5]})"
                )
        for task in tasks:
            assignment_id = str(task["assignment_id"])
            if (assignment_id, stage) in state["v5_commit_by_assignment_stage"]:
                raise DeltaLedgerError(
                    f"{assignment_id}: source-only A is already immutable"
                )
            binding = state["by_assignment"][assignment_id]
            private_sample_id = str(binding["sample_id"])
            sample_reviews = existing_by_sample.get(private_sample_id, {})
            if (
                stage == "secondary"
                and sample_reviews.get("primary", {}).get("reviewer") == reviewer_id
            ):
                raise DeltaLedgerError(
                    f"{private_sample_id}: secondary A reviewer is not independent"
                )
            if stage == "adjudication":
                if "primary" not in sample_reviews:
                    raise DeltaLedgerError(
                        f"{private_sample_id}: adjudication A lacks primary review"
                    )
                secondary_required = (
                    "secondary" in state["bindings_by_sample"][private_sample_id]
                )
                if secondary_required and "secondary" not in sample_reviews:
                    raise DeltaLedgerError(
                        f"{private_sample_id}: adjudication A lacks secondary review"
                    )
                if not _trigger_reasons(
                    sample_reviews, secondary_required=secondary_required
                ):
                    raise DeltaLedgerError(
                        f"{private_sample_id}: adjudication A is not triggered"
                    )
                prior_reviewers = {
                    str(row["reviewer"])
                    for key, row in sample_reviews.items()
                    if key in {"primary", "secondary"}
                }
                if reviewer_id in prior_reviewers:
                    raise DeltaLedgerError(
                        f"{private_sample_id}: adjudication A reviewer is not independent"
                    )
                expected_source_review_shas = [
                    str(sample_reviews[key]["record_sha256"])
                    for key in ("primary", "secondary")
                    if key in sample_reviews
                ]
                annotation = annotations[str(task["sample_id"])]
                if list(annotation["source_review_record_sha256s"]) != (
                    expected_source_review_shas
                ):
                    raise DeltaLedgerError(
                        f"{private_sample_id}: adjudication A source reviews changed"
                    )

        canonical_annotations = [
            next(
                dict(value)
                for value in source_annotations
                if value.get("assignment_id") == task["assignment_id"]
            )
            for task in tasks
        ]
        annotation_sha = sha256_bytes(jsonl_bytes(canonical_annotations))
        previous_sha = (
            str(state["source_commits"][-1]["record_sha256"])
            if state["source_commits"]
            else None
        )
        batch_id = next(iter({str(row["batch_id"]) for row in annotations.values()}))
        commit_id = f"fmac-{stable_hash('font-matching-v5-source-commit', stage, reviewer_id, batch_id, annotation_sha, str(previous_sha))[:32]}"
        commit = seal(
            {
                "schema_version": V5_SOURCE_COMMIT_SCHEMA_VERSION,
                "record_type": V5_SOURCE_COMMIT_RECORD_TYPE,
                "commit_id": commit_id,
                "stage": stage,
                "reviewer_id": reviewer_id,
                "batch_id": batch_id,
                "batch_size": len(tasks),
                "batch_task_set_sha256": v5_deriver.task_batch_sha256(tasks),
                "annotation_jsonl_sha256": annotation_sha,
                "previous_commit_record_sha256": previous_sha,
                "annotations": canonical_annotations,
                "committed_at": utc_timestamp(),
            }
        )
        combined = [*state["source_commits"], commit]
        atomic_write(state["source_commits_path"], jsonl_bytes(combined))
    return commit


def _v5_release_input_cards(
    *,
    state: Mapping[str, Any],
    release_stage: str,
    split_manifest_paths: Sequence[Path],
) -> dict[str, dict[str, Any]]:
    """Re-present and verify candidate-bearing inputs only at B release."""

    source_stage = "primary" if release_stage == "adjudication" else release_stage
    if source_stage not in {"primary", "secondary"}:
        raise DeltaLedgerError(f"unsupported candidate release stage: {release_stage}")
    paths = [path.resolve() for path in split_manifest_paths]
    if not paths:
        raise DeltaLedgerError(
            "candidate release requires the sealed split-card manifest inputs"
        )
    expected_split_bindings = require_list(
        nested(state, "contract", "split_card_manifests", source_stage),
        f"contract.split_card_manifests.{source_stage}",
    )
    actual_split_bindings = [_opaque_file_binding(path) for path in paths]
    if sorted(
        (str(row["sha256"]), int(row["byte_size"])) for row in actual_split_bindings
    ) != sorted(
        (
            require_sha(row.get("sha256"), "split manifest binding.sha256"),
            int(row.get("byte_size")),
        )
        for row in (
            require_mapping(value, "split manifest binding")
            for value in expected_split_bindings
        )
    ):
        raise DeltaLedgerError(
            "candidate release split manifests differ from the opaque init binding"
        )

    source_manifest_paths: list[Path] = []
    for index, path in enumerate(paths):
        _validate_opaque_file_binding(
            require_mapping(
                next(
                    value
                    for value in expected_split_bindings
                    if require_mapping(value, "split binding").get("sha256")
                    == sha256_file(path)
                ),
                f"contract.split_card_manifests.{source_stage}[{index}]",
            ),
            path,
            f"contract.split_card_manifests.{source_stage}[{index}]",
        )
        manifest = read_json(path)
        source_manifest = require_mapping(
            manifest.get("source_manifest"), f"split manifest[{index}].source_manifest"
        )
        source_path = Path(
            require_text(
                source_manifest.get("path"),
                f"split manifest[{index}].source_manifest.path",
            )
        ).resolve()
        if sha256_file(source_path) != require_sha(
            source_manifest.get("sha256"),
            f"split manifest[{index}].source_manifest.sha256",
        ):
            raise DeltaLedgerError(
                f"split manifest[{index}] source manifest bytes changed"
            )
        if source_path not in source_manifest_paths:
            source_manifest_paths.append(source_path)

    expected_card_bindings = require_list(
        nested(state, "contract", "card_manifests", source_stage),
        f"contract.card_manifests.{source_stage}",
    )
    actual_card_bindings = [
        _opaque_file_binding(path) for path in source_manifest_paths
    ]
    if sorted(
        (str(row["sha256"]), int(row["byte_size"])) for row in actual_card_bindings
    ) != sorted(
        (
            require_sha(row.get("sha256"), "card manifest binding.sha256"),
            int(row.get("byte_size")),
        )
        for row in (
            require_mapping(value, "card manifest binding")
            for value in expected_card_bindings
        )
    ):
        raise DeltaLedgerError(
            "candidate release source-card manifests differ from the opaque init binding"
        )
    cards, _ = _card_manifest_bindings(
        source_manifest_paths,
        expected_stage=source_stage,
        source=state["source"],
        verify_card_files=True,
    )
    _v5_split_card_bindings(
        paths,
        expected_stage=source_stage,
        cards=cards,
        verify_card_files=True,
    )
    return cards


def _v5_neutral_tie_anchors(
    state: Mapping[str, Any], assignment: Mapping[str, Any]
) -> dict[str, str]:
    sample_id = str(assignment["sample_id"])
    master_row = require_mapping(
        state["source"]["master"].get(sample_id), f"master[{sample_id}]"
    )
    chapter_value = master_row.get("chapter")
    if isinstance(chapter_value, Mapping) and chapter_value.get("id") is not None:
        chapter_id = str(chapter_value["id"])
    elif (
        isinstance(master_row.get("page"), Mapping)
        and nested(master_row, "page", "id") is not None
    ):
        chapter_id = str(nested(master_row, "page", "id"))
    else:
        chapter_id = sample_id
    work_id = str(assignment["work_id"])
    return {
        "chapter_sha256": stable_hash(
            "font-matching-neutral-chapter-anchor-v5", work_id, chapter_id
        ),
        "work_sha256": stable_hash("font-matching-neutral-work-anchor-v5", work_id),
    }


def _v5_png_payload(image: Any, *, nonce_sha256: str, role: str) -> bytes:
    from PIL import PngImagePlugin

    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("font_matching_release_nonce_sha256", nonce_sha256)
    metadata.add_text("font_matching_release_surface_role", role)
    stream = io.BytesIO()
    image.save(
        stream,
        format="PNG",
        optimize=False,
        # Candidate surfaces are large, ephemeral human-review artifacts.  A
        # low deterministic compression level keeps the same pixels and
        # metadata while avoiding excessive single-core DEFLATE work for a
        # 1,151-card production release.
        compress_level=1,
        pnginfo=metadata,
    )
    return stream.getvalue()


def _v5_render_release_candidate_card(
    *,
    candidate_source_path: Path,
    source_assignment: Mapping[str, Any],
    public_assignment_id: str,
    nonce_sha256: str,
    alias_order: Sequence[str],
) -> Any:
    """Reorder physical v4 panels and repaint every public alias for this release."""

    from PIL import Image, ImageDraw, ImageFont

    with Image.open(candidate_source_path) as opened:
        opened.load()
        original = opened.convert("RGB")
    nonce_bytes = bytes.fromhex(nonce_sha256)
    tint = Image.new(
        "RGB",
        original.size,
        (
            235 + nonce_bytes[0] % 16,
            235 + nonce_bytes[1] % 16,
            235 + nonce_bytes[2] % 16,
        ),
    )
    # A subtle release-wide transform makes the rendered pixels themselves
    # fresh while preserving equal treatment for all seven candidates.
    candidate = Image.blend(original, tint, 0.018)
    draw = ImageDraw.Draw(candidate)
    try:
        label_font = ImageFont.truetype("DejaVuSans.ttf", 28)
        small_font = ImageFont.truetype("DejaVuSans.ttf", 20)
    except OSError:  # pragma: no cover - Pillow packaging fallback
        label_font = ImageFont.load_default()
        small_font = ImageFont.load_default()
    alias_map = v5_deriver.release_alias_map(nonce_sha256)
    prototype_by_public = {public: prototype for prototype, public in alias_map.items()}
    old_order = list(source_assignment["blind_alias_order"])

    # Production v4 geometry: the candidate-only crop starts at full-card
    # y=1412 and its seven 2-column cells start at relative y=348.
    if candidate.size == (2400, 4428) and set(old_order) == set(
        v5_deriver.FROZEN_ALIAS_ORDER
    ):
        cell_width, cell_height, gap_x, gap_y = 1159, 960, 18, 16

        def cell_box(position: int) -> tuple[int, int, int, int]:
            row, column = divmod(position, 2)
            left = 32 + column * (cell_width + gap_x)
            top = 348 + row * (cell_height + gap_y)
            return (left, top, left + cell_width, top + cell_height)

        source_tiles = [candidate.crop(cell_box(index)) for index in range(7)]
        for target_index, public_alias in enumerate(alias_order):
            prototype_alias = prototype_by_public[public_alias]
            source_index = old_order.index(prototype_alias)
            left, top, right, bottom = cell_box(target_index)
            candidate.paste(source_tiles[source_index], (left, top))
            draw.rectangle((left, top, right, top + 62), fill=(226, 239, 245))
            draw.text(
                (left + 18, top + 14),
                f"{target_index + 1:02d}  {public_alias}",
                font=label_font,
                fill=(30, 47, 58),
            )
            marker_left = right - 132
            for marker_index, byte in enumerate(nonce_bytes[:12]):
                marker_top = top + 10 + (marker_index % 3) * 14
                x = marker_left + (marker_index // 3) * 28
                draw.rectangle(
                    (x, marker_top, x + 18, marker_top + 8),
                    fill=(40 + byte % 120, 80 + byte % 96, 100 + byte % 80),
                )
        draw.rectangle((0, 0, candidate.width, 92), fill=(30, 47, 58))
        draw.text(
            (48, 28),
            f"RELEASE-SEALED STEP B  {nonce_sha256[:20]}",
            font=label_font,
            fill=(65, 225, 238),
        )
    else:
        # Small synthetic fixtures and any future geometry still receive a
        # pixel-visible nonce challenge and the exact fresh alias order.  Real
        # production cards are required to take the panel-reordering branch.
        band_height = min(max(24, candidate.height // 5), 120)
        draw.rectangle((0, 0, candidate.width, band_height), fill=(30, 47, 58))
        alias_text = " | ".join(
            f"{index + 1:02d}:{alias}" for index, alias in enumerate(alias_order)
        )
        draw.text((8, 4), alias_text, font=small_font, fill=(65, 225, 238))
        draw.text(
            (8, max(4, band_height // 2)),
            f"B:{public_assignment_id[-12:]}:{nonce_sha256[:16]}",
            font=small_font,
            fill=(245, 245, 245),
        )
    return candidate


def release_candidate_batch(
    workspace: Path,
    *,
    source_commit_id: str,
    candidate_split_manifests: Sequence[Path],
) -> dict[str, Any]:
    from PIL import Image

    commit_id = require_id(source_commit_id, "source_commit_id")
    with workspace_lock(workspace.resolve()):
        state = _load_workspace(workspace)
        if state["contract"].get("v5_derivation_required") is not True:
            raise DeltaLedgerError("candidate B release requires a v5 workspace")
        commit = state["v5_commits_by_id"].get(commit_id)
        if commit is None:
            raise DeltaLedgerError("candidate B release lacks a committed A batch")
        if commit_id in state["v5_releases_by_commit_id"]:
            raise DeltaLedgerError("candidate B was already released for this A commit")
        release_cards = _v5_release_input_cards(
            state=state,
            release_stage=str(commit["stage"]),
            split_manifest_paths=candidate_split_manifests,
        )
        release_nonce = secrets.token_hex(32)
        release_nonce_sha = sha256_bytes(release_nonce.encode("ascii"))
        release_id = (
            "fmbr-"
            + sha256_bytes(
                canonical_json_bytes(
                    [
                        "font-matching-v5-candidate-release",
                        commit_id,
                        commit["record"]["record_sha256"],
                        release_nonce_sha,
                    ]
                )
            )[:32]
        )
        task_assignment_ids = [str(task["assignment_id"]) for task in commit["tasks"]]
        batch_order = v5_deriver.release_batch_order(
            release_nonce_sha, task_assignment_ids
        )
        alias_map = v5_deriver.release_alias_map(release_nonce_sha)
        entries: list[dict[str, Any]] = []
        pending_images: dict[Path, bytes] = {}
        surface_rows: list[dict[str, Any]] = []
        for source_task in sorted(
            commit["tasks"], key=lambda row: row["assignment_id"]
        ):
            public_assignment_id = str(source_task["assignment_id"])
            binding = state["by_assignment"][public_assignment_id]
            source_assignment = require_mapping(
                binding.get("assignment"), f"{public_assignment_id}.assignment"
            )
            private_assignment_id = str(source_assignment["assignment_id"])
            release_card = release_cards.get(private_assignment_id)
            if release_card is None:
                raise DeltaLedgerError(
                    f"candidate release input lacks {private_assignment_id}"
                )
            split_cards = require_mapping(
                release_card.get("v5_review_cards"),
                f"{private_assignment_id}.v5_review_cards",
            )
            candidate_source = require_mapping(
                split_cards.get("candidate_only"),
                f"{private_assignment_id}.candidate_only",
            )
            alias_order = v5_deriver.release_alias_order(
                release_nonce_sha, public_assignment_id
            )
            candidate_image = _v5_render_release_candidate_card(
                candidate_source_path=Path(str(candidate_source["file"])),
                source_assignment=source_assignment,
                public_assignment_id=public_assignment_id,
                nonce_sha256=release_nonce_sha,
                alias_order=alias_order,
            )
            source_card = require_mapping(
                nested(binding, "card", "v5_source_card"),
                f"{public_assignment_id}.v5_source_card",
            )
            source_path = Path(str(source_card["file"]))
            with Image.open(source_path) as opened:
                opened.load()
                source_image = opened.convert("RGB")
            if source_image.width != candidate_image.width:
                raise DeltaLedgerError(
                    f"{public_assignment_id}: source/candidate release widths differ"
                )
            full_image = Image.new(
                "RGB",
                (source_image.width, source_image.height + candidate_image.height),
            )
            full_image.paste(source_image, (0, 0))
            full_image.paste(candidate_image, (0, source_image.height))
            candidate_payload = _v5_png_payload(
                candidate_image,
                nonce_sha256=release_nonce_sha,
                role="candidate_only",
            )
            full_payload = _v5_png_payload(
                full_image, nonce_sha256=release_nonce_sha, role="full_card"
            )
            file_token = stable_hash(
                "font-matching-v5-release-card-file",
                release_nonce_sha,
                public_assignment_id,
            )[:24]
            prefix = f"{batch_order[public_assignment_id]:06d}-{file_token}"
            release_root = state["root"] / "candidate-surfaces" / release_id
            candidate_path = release_root / f"{prefix}-candidate.png"
            full_path = release_root / f"{prefix}-full.png"
            pending_images[candidate_path] = candidate_payload
            pending_images[full_path] = full_payload
            mandatory_prototypes = set(release_card["mandatory_unrenderable"])
            mandatory_public = [
                public_alias
                for public_alias in alias_order
                if next(
                    prototype
                    for prototype, mapped in alias_map.items()
                    if mapped == public_alias
                )
                in mandatory_prototypes
            ]
            entry = {
                "assignment_id": public_assignment_id,
                "sample_id": source_task["sample_id"],
                "source_task_record_sha256": source_task["source_task_record_sha256"],
                "source_annotation_record_sha256": commit["annotations"][
                    source_task["sample_id"]
                ]["record_sha256"],
                "candidate_batch_order": batch_order[public_assignment_id],
                "blind_alias_order": alias_order,
                "candidate_order_seed": v5_deriver.release_candidate_order_seed(
                    release_nonce_sha, public_assignment_id
                ),
                "mandatory_unrenderable": mandatory_public,
                "full_card_sha256": sha256_bytes(full_payload),
                "source_only_card_sha256": source_card["sha256"],
                "candidate_only_card_sha256": sha256_bytes(candidate_payload),
                "neutral_tie_anchors": _v5_neutral_tie_anchors(
                    state, source_assignment
                ),
            }
            entries.append(entry)
            surface_rows.append(
                {
                    "assignment_id": public_assignment_id,
                    "sample_id": source_task["sample_id"],
                    "candidate_batch_order": batch_order[public_assignment_id],
                    "blind_alias_order": alias_order,
                    "candidate_order_seed": entry["candidate_order_seed"],
                    "source_only": copy.deepcopy(dict(source_card)),
                    "candidate_only": {
                        "file": str(candidate_path),
                        "sha256": entry["candidate_only_card_sha256"],
                        "pixel_sha256": _v5_pixel_sha256(candidate_image),
                        "size_px": list(candidate_image.size),
                    },
                    "full_card": {
                        "file": str(full_path),
                        "sha256": entry["full_card_sha256"],
                        "pixel_sha256": _v5_pixel_sha256(full_image),
                        "size_px": list(full_image.size),
                    },
                }
            )
        entries.sort(key=lambda row: str(row["assignment_id"]))
        release = v5_deriver.seal_record(
            {
                "schema_version": v5_deriver.RELEASE_SCHEMA_VERSION,
                "record_type": v5_deriver.RELEASE_RECORD_TYPE,
                "release_id": release_id,
                "source_commit_id": commit_id,
                "source_commit_record_sha256": commit["record"]["record_sha256"],
                "stage": commit["stage"],
                "reviewer_id": commit["reviewer_id"],
                "batch_id": commit["batch_id"],
                "batch_size": len(commit["tasks"]),
                "batch_task_set_sha256": v5_deriver.task_batch_sha256(commit["tasks"]),
                "release_nonce": release_nonce,
                "release_nonce_sha256": release_nonce_sha,
                "entries": entries,
                "released_at": utc_timestamp(),
            }
        )
        try:
            normalized_release = v5_deriver.validate_candidate_release(
                release,
                commit["tasks"],
                commit["annotations"],
                reviewer_id=str(commit["reviewer_id"]),
            )
        except v5_deriver.DerivationError as error:
            raise DeltaLedgerError(str(error)) from error
        source_task_by_assignment = {
            str(task["assignment_id"]): task for task in commit["tasks"]
        }
        candidate_tasks = [
            v5_deriver.materialize_candidate_task(
                normalized_release,
                entry,
                source_task_by_assignment[str(entry["assignment_id"])],
            )
            for entry in sorted(
                normalized_release["entries"],
                key=lambda row: int(row["candidate_batch_order"]),
            )
        ]
        surface_manifest = seal(
            {
                "schema_version": V5_CANDIDATE_SURFACE_SCHEMA_VERSION,
                "record_type": V5_CANDIDATE_SURFACE_RECORD_TYPE,
                "candidate_release_id": release_id,
                "candidate_release_record_sha256": release["record_sha256"],
                "release_nonce_sha256": release_nonce_sha,
                "batch_size": len(surface_rows),
                "entries": sorted(
                    surface_rows, key=lambda row: int(row["candidate_batch_order"])
                ),
                "pixel_contract": {
                    "release_aliases_painted_into_pixels": True,
                    "release_candidate_order_applied_to_panels": True,
                    "release_nonce_pixel_challenge_visible": True,
                    "pre_release_candidate_pixels_reused_verbatim": False,
                },
            }
        )
        combined = [*state["candidate_releases"], release]
        # The release record is the state transition.  Candidate-bearing files
        # and tasks are materialized only after that append succeeds.
        atomic_write(state["candidate_releases_path"], jsonl_bytes(combined))
        for path, payload in sorted(
            pending_images.items(), key=lambda item: str(item[0])
        ):
            atomic_write(path, payload)
        atomic_write(
            state["root"] / "candidate-surfaces" / release_id / "manifest.json",
            canonical_json_bytes(surface_manifest, pretty=True),
        )
        atomic_write(
            state["root"] / "candidate-tasks" / f"{release_id}.jsonl",
            jsonl_bytes(candidate_tasks),
        )
    return release


def _prepare_v5_derivation_batch(
    *,
    state: Mapping[str, Any],
    stage: str,
    reviewer: str,
    decisions: Sequence[Mapping[str, Any]],
    derivation_audits: Sequence[Mapping[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    if derivation_audits is None:
        raise DeltaLedgerError("v5 submit requires sealed --derivation-audit")
    decision_by_assignment = _v5_rows_by_assignment(decisions, label="decisions")
    audit_by_assignment = _v5_rows_by_assignment(
        derivation_audits, label="derivation_audits"
    )
    assignment_ids = set(decision_by_assignment)
    if set(audit_by_assignment) != assignment_ids:
        raise DeltaLedgerError("v5 decision/audit assignment coverage differs")
    if stage in {"primary", "secondary"}:
        expected_ids = {
            str(task["assignment_id"])
            for task in state["tasks"]
            if task.get("stage") == stage
        }
        if assignment_ids != expected_ids:
            raise DeltaLedgerError(
                "whole released v5 B batch must be submitted together "
                f"(missing={sorted(expected_ids - assignment_ids)[:5]}, "
                f"extra={sorted(assignment_ids - expected_ids)[:5]})"
            )
    commits = {
        state["v5_commit_by_assignment_stage"]
        .get((assignment_id, stage), {})
        .get("commit_id")
        for assignment_id in assignment_ids
    }
    commits.discard(None)
    if len(commits) != 1:
        raise DeltaLedgerError(
            "decision batch is not backed by one immutable source-only A commit"
        )
    commit = state["v5_commits_by_id"][next(iter(commits))]
    if commit["assignment_ids"] != assignment_ids or commit["reviewer_id"] != reviewer:
        raise DeltaLedgerError(
            "decision batch differs from its immutable source-only A commit"
        )
    release = state["v5_releases_by_commit_id"].get(commit["commit_id"])
    if release is None:
        raise DeltaLedgerError(
            "candidate B has not been released after the immutable A commit"
        )
    source_tasks = list(commit["tasks"])
    normalized_annotations = dict(commit["annotations"])
    try:
        v5_deriver.validate_candidate_release(
            release,
            source_tasks,
            normalized_annotations,
            reviewer_id=reviewer,
        )
    except v5_deriver.DerivationError as error:
        raise DeltaLedgerError(str(error)) from error
    normalized_tasks = list(
        state["v5_candidate_tasks_by_release_id"].get(release["release_id"], [])
    )
    if not normalized_tasks:
        raise DeltaLedgerError("released candidate B task artifact is missing")
    task_by_assignment = {str(task["assignment_id"]): task for task in normalized_tasks}
    raw_candidate_task_by_assignment = {
        str(task["assignment_id"]): task
        for task in read_jsonl(
            state["root"] / "candidate-tasks" / f"{release['release_id']}.jsonl"
        )
    }
    raw_annotation_by_assignment = {
        str(value["assignment_id"]): value for value in commit["record"]["annotations"]
    }
    raw_evidence: dict[str, dict[str, Any]] = {}
    for assignment_id in sorted(assignment_ids):
        _decision_identity_leak(
            audit_by_assignment[assignment_id],
            state,
            f"derivation_audits[{assignment_id}]",
        )
        raw_evidence[assignment_id] = {
            "source_commit_id": commit["commit_id"],
            "source_commit_record_sha256": commit["record"]["record_sha256"],
            "candidate_release_id": release["release_id"],
            "candidate_release_record_sha256": release["record_sha256"],
            "source_annotation": copy.deepcopy(
                dict(raw_annotation_by_assignment[assignment_id])
            ),
            "derivation_audit": copy.deepcopy(dict(audit_by_assignment[assignment_id])),
        }
    try:
        v5_deriver._validate_batch_binding(
            normalized_tasks,
            normalized_annotations,
            reviewer_id=reviewer,
        )
        expected_decisions, expected_audits = v5_deriver.derive_all(
            normalized_tasks, normalized_annotations, release=release
        )
    except v5_deriver.DerivationError as error:
        raise DeltaLedgerError(str(error)) from error
    expected_decision_by_assignment = {
        str(row["assignment_id"]): row for row in expected_decisions
    }
    expected_audit_by_assignment = {
        str(row["assignment_id"]): row for row in expected_audits
    }
    for assignment_id in sorted(assignment_ids):
        if (
            dict(decision_by_assignment[assignment_id])
            != expected_decision_by_assignment[assignment_id]
        ):
            raise DeltaLedgerError(
                f"{assignment_id}: decision differs from deterministic v5 derivation"
            )
        if (
            dict(audit_by_assignment[assignment_id])
            != expected_audit_by_assignment[assignment_id]
        ):
            raise DeltaLedgerError(
                f"{assignment_id}: derivation audit is stale, tampered, or misbound"
            )
        audit = expected_audit_by_assignment[assignment_id]
        if audit["safe_count"] > 2:
            raise DeltaLedgerError(f"{assignment_id}: v5 safe cap exceeded")
        raw_evidence[assignment_id]["task_record_sha256"] = task_by_assignment[
            assignment_id
        ]["task_record_sha256"]
        raw_evidence[assignment_id]["source_annotation_canonical_sha256"] = audit[
            "source_annotation_canonical_sha256"
        ]
        raw_evidence[assignment_id]["derivation_audit_record_sha256"] = audit[
            "record_sha256"
        ]
        raw_evidence[assignment_id]["candidate_task"] = copy.deepcopy(
            dict(raw_candidate_task_by_assignment[assignment_id])
        )
        raw_evidence[assignment_id]["derived_decision"] = copy.deepcopy(
            dict(expected_decision_by_assignment[assignment_id])
        )
    return raw_evidence


def _review_record_id(
    *, sample_id: str, stage: str, reviewer: str, decision: Mapping[str, Any]
) -> str:
    digest = stable_hash(
        "font-catalog-delta-blind-review-v1",
        sample_id,
        stage,
        reviewer,
        sha256_bytes(canonical_json_bytes(decision)),
    )
    return f"fmdr-{digest[:32]}"


def _source_review_bindings(state: Mapping[str, Any]) -> dict[str, str]:
    contract = require_mapping(state.get("contract"), "state.contract")
    records = require_mapping(contract.get("source_records"), "contract.source_records")
    bindings = {
        "workspace_contract_record_sha256": require_sha(
            contract.get("record_sha256"), "contract.record_sha256"
        ),
        "rescue_report_record_sha256": require_sha(
            records.get("rescue_report_record_sha256"),
            "contract.source_records.rescue_report_record_sha256",
        ),
        "font_signal_audit_report_record_sha256": require_sha(
            records.get("font_signal_audit_report_record_sha256"),
            "contract.source_records.font_signal_audit_report_record_sha256",
        ),
        "expanded_catalog_sha256": require_sha(
            records.get("expanded_catalog_sha256"),
            "contract.source_records.expanded_catalog_sha256",
        ),
        "expanded_render_bank_sha256": require_sha(
            records.get("expanded_render_bank_sha256"),
            "contract.source_records.expanded_render_bank_sha256",
        ),
    }
    if contract.get("v5_derivation_required") is True:
        bindings["master_split_map_sha256"] = require_sha(
            records.get("master_split_map_sha256"),
            "contract.source_records.master_split_map_sha256",
        )
    return bindings


def _build_review_record(
    *,
    state: Mapping[str, Any],
    binding: Mapping[str, Any],
    stage: str,
    reviewer: str,
    normalized: Mapping[str, Any],
    source_review_record_sha256s: Sequence[str],
    derivation_evidence: Mapping[str, Any] | None,
) -> dict[str, Any]:
    assignment = require_mapping(binding.get("assignment"), "binding.assignment")
    card = require_mapping(binding.get("card"), "binding.card")
    public_task = _public_task(assignment, card)
    decision_for_id = {
        "assignment_id": public_task["assignment_id"],
        "role": normalized["role"],
        "role_confidence": normalized["role_confidence"],
        "eligibility": normalized["eligibility"],
        "font_judgment": normalized["font_judgment"],
        "confidence": normalized["confidence"],
        "rationale": normalized["rationale"],
    }
    review_id = _review_record_id(
        sample_id=str(assignment["sample_id"]),
        stage=stage,
        reviewer=reviewer,
        decision=decision_for_id,
    )
    if derivation_evidence is not None:
        candidate_task = require_mapping(
            derivation_evidence.get("candidate_task"),
            "derivation_evidence.candidate_task",
        )
        release_id = require_id(
            candidate_task.get("candidate_release_id"),
            "candidate_task.candidate_release_id",
        )
        review_evidence = {
            "review_card_sha256": candidate_task["full_card_sha256"],
            "public_sample_id": public_task["sample_id"],
            "card_manifest_sha256": sha256_file(
                state["root"] / "candidate-surfaces" / release_id / "manifest.json"
            ),
            "candidate_order_seed": candidate_task["candidate_order_seed"],
            "candidate_order_aliases": list(candidate_task["blind_alias_order"]),
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "prior_tiers_visible": False,
        }
    else:
        review_evidence = {
            "review_card_sha256": card["review_card_sha256"],
            "public_sample_id": public_task["sample_id"],
            "card_manifest_sha256": card["card_manifest_sha256"],
            "candidate_order_seed": assignment["candidate_order_seed"],
            "candidate_order_aliases": list(assignment["blind_alias_order"]),
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "prior_tiers_visible": False,
        }
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_blind_review",
            "review_id": review_id,
            "sample_id": assignment["sample_id"],
            "work_id": assignment["work_id"],
            "source_page_sha256": assignment["source_page_sha256"],
            "assignment_id": public_task["assignment_id"],
            "stage": stage,
            "reviewer": reviewer,
            "reviewed_at": utc_timestamp(),
            "role": {
                "primary": normalized["role"],
                "confidence": normalized["role_confidence"],
            },
            "eligibility": normalized["eligibility"],
            "font_judgment": copy.deepcopy(normalized["font_judgment"]),
            "confidence": normalized["confidence"],
            "rationale": normalized["rationale"],
            "evidence": review_evidence,
            "source_bindings": {
                **_source_review_bindings(state),
                "selection_record_sha256": binding["selection_record_sha256"],
                "prior_final_record_sha256": binding["prior_final_record_sha256"],
            },
            "source_review_record_sha256s": list(source_review_record_sha256s),
            "derivation_evidence": (
                copy.deepcopy(dict(derivation_evidence))
                if derivation_evidence is not None
                else None
            ),
        }
    )


def _judgments_disagree(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    if left.get("eligibility") != right.get("eligibility"):
        return True
    if left.get("eligibility") != "font_signal_present":
        return False
    if nested(left, "role", "primary") != nested(right, "role", "primary"):
        return True
    left_judgment = require_mapping(left.get("font_judgment"), "left.font_judgment")
    right_judgment = require_mapping(right.get("font_judgment"), "right.font_judgment")
    if bool(left_judgment.get("none_acceptable")) != bool(
        right_judgment.get("none_acceptable")
    ):
        return True
    return any(
        set(left_judgment.get(tier, [])) != set(right_judgment.get(tier, []))
        for tier in TIERS
    )


def _trigger_reasons(
    sample_reviews: Mapping[str, Mapping[str, Any]],
    *,
    secondary_required: bool,
) -> list[str]:
    primary = sample_reviews.get("primary")
    secondary = sample_reviews.get("secondary")
    if primary is None:
        return []
    reviewed = [primary]
    if secondary is not None:
        reviewed.append(secondary)
    if any(row.get("eligibility") != "font_signal_present" for row in reviewed):
        return []
    reasons: list[str] = []
    if (
        secondary_required
        and secondary is not None
        and _judgments_disagree(primary, secondary)
    ):
        reasons.append("primary_secondary_disagreement")
    if any(bool(nested(row, "font_judgment", "none_acceptable")) for row in reviewed):
        reasons.append("none_acceptable")
    if any(float(row.get("confidence", 0.0)) < 0.80 for row in reviewed):
        reasons.append("confidence_below_0.80")
    if any(float(nested(row, "role", "confidence")) < 0.75 for row in reviewed):
        reasons.append("role_confidence_below_0.75")
    if any(
        nested(row, "role", "primary") == "unknown_needs_review" for row in reviewed
    ):
        reasons.append("role_unresolved")
    return reasons


def _has_eligibility_exception(sample_reviews: Mapping[str, Mapping[str, Any]]) -> bool:
    return any(
        row.get("eligibility") in {"font_signal_absent", "crop_needs_review"}
        for stage, row in sample_reviews.items()
        if stage in {"primary", "secondary"}
    )


def _decision_from_review(record: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "assignment_id": record.get("assignment_id"),
        "sample_id": (
            nested(record, "evidence", "public_sample_id")
            if isinstance(record.get("evidence"), Mapping)
            and "public_sample_id" in record["evidence"]
            else record.get("sample_id")
        ),
        "review_card_sha256": nested(record, "evidence", "review_card_sha256"),
        "candidate_order_seed": nested(record, "evidence", "candidate_order_seed"),
        "role": nested(record, "role", "primary"),
        "role_confidence": nested(record, "role", "confidence"),
        "eligibility": record.get("eligibility"),
        "font_judgment": copy.deepcopy(record.get("font_judgment")),
        "confidence": record.get("confidence"),
        "rationale": record.get("rationale"),
    }


def _validate_stored_v5_derivation(
    *,
    record: Mapping[str, Any],
    state: Mapping[str, Any],
    location: str,
) -> dict[str, Any]:
    evidence = require_mapping(
        record.get("derivation_evidence"), f"{location}.derivation_evidence"
    )
    require_exact_keys(
        evidence,
        {
            "source_commit_id",
            "source_commit_record_sha256",
            "candidate_release_id",
            "candidate_release_record_sha256",
            "task_record_sha256",
            "source_annotation_canonical_sha256",
            "derivation_audit_record_sha256",
            "source_annotation",
            "derivation_audit",
            "candidate_task",
            "derived_decision",
        },
        f"{location}.derivation_evidence",
    )
    assignment_id = str(record["assignment_id"])
    task_value = require_mapping(
        evidence.get("candidate_task"), f"{location}.derivation_evidence.candidate_task"
    )
    annotation_value = require_mapping(
        evidence.get("source_annotation"),
        f"{location}.derivation_evidence.source_annotation",
    )
    audit_value = require_mapping(
        evidence.get("derivation_audit"),
        f"{location}.derivation_evidence.derivation_audit",
    )
    _decision_identity_leak(annotation_value, state, f"{location}.source_annotation")
    _decision_identity_leak(audit_value, state, f"{location}.derivation_audit")
    derived_decision_value = require_mapping(
        evidence.get("derived_decision"),
        f"{location}.derivation_evidence.derived_decision",
    )
    try:
        task = v5_deriver.validate_task(task_value, f"{location}.v5_task")
        annotation = v5_deriver.validate_annotation(
            annotation_value, f"{location}.source_annotation"
        )
        expected_decision, expected_audit = v5_deriver.derive_one(task, annotation)
    except v5_deriver.DerivationError as error:
        raise DeltaLedgerError(str(error)) from error
    if annotation["reviewer_id"] != record.get("reviewer") or annotation[
        "stage"
    ] != record.get("stage"):
        raise DeltaLedgerError(f"{location}: v5 annotation reviewer/stage changed")
    if record.get("stage") == "adjudication" and annotation[
        "source_review_record_sha256s"
    ] != record.get("source_review_record_sha256s"):
        raise DeltaLedgerError(
            f"{location}: adjudication annotation source reviews changed"
        )
    if dict(derived_decision_value) != expected_decision:
        raise DeltaLedgerError(
            f"{location}: stored public decision differs from v5 derivation"
        )
    expected_canonical_decision = copy.deepcopy(expected_decision)
    public_to_prototype = {
        public: prototype
        for prototype, public in v5_deriver.release_alias_map(
            str(task["release_nonce_sha256"])
        ).items()
    }
    if expected_canonical_decision["font_judgment"] is not None:
        expected_canonical_decision["font_judgment"] = {
            **{
                tier: [
                    public_to_prototype[alias]
                    for alias in expected_canonical_decision["font_judgment"][tier]
                ]
                for tier in TIERS
            },
            "none_acceptable": expected_canonical_decision["font_judgment"][
                "none_acceptable"
            ],
        }
    for key in (
        "candidate_release_record_sha256",
        "release_challenge_sha256",
        "release_nonce_sha256",
    ):
        expected_canonical_decision.pop(key)
    if _decision_from_review(record) != expected_canonical_decision:
        raise DeltaLedgerError(
            f"{location}: stored canonical decision differs from v5 derivation"
        )
    if dict(audit_value) != expected_audit:
        raise DeltaLedgerError(f"{location}: stored derivation audit changed")
    expected_bindings = {
        "source_commit_id": None,
        "source_commit_record_sha256": None,
        "candidate_release_id": None,
        "candidate_release_record_sha256": None,
        "task_record_sha256": task["task_record_sha256"],
        "source_annotation_canonical_sha256": annotation["canonical_annotation_sha256"],
        "derivation_audit_record_sha256": expected_audit["record_sha256"],
    }
    commit = state["v5_commit_by_assignment_stage"].get(
        (assignment_id, str(record["stage"]))
    )
    if commit is None:
        raise DeltaLedgerError(f"{location}: stored decision lacks its prior A commit")
    release = state["v5_releases_by_commit_id"].get(commit["commit_id"])
    if release is None:
        raise DeltaLedgerError(f"{location}: stored decision lacks its B release")
    expected_bindings.update(
        {
            "source_commit_id": commit["commit_id"],
            "source_commit_record_sha256": commit["record"]["record_sha256"],
            "candidate_release_id": release["release_id"],
            "candidate_release_record_sha256": release["record_sha256"],
        }
    )
    released_tasks = {
        str(value["assignment_id"]): value
        for value in state["v5_candidate_tasks_by_release_id"].get(
            release["release_id"], []
        )
    }
    if released_tasks.get(assignment_id) != task:
        raise DeltaLedgerError(f"{location}: stored candidate task changed")
    for key, expected in expected_bindings.items():
        if evidence.get(key) != expected:
            raise DeltaLedgerError(f"{location}.derivation_evidence.{key} changed")
    if expected_audit["safe_count"] > 2:
        raise DeltaLedgerError(f"{location}: stored v5 safe cap exceeded")
    return annotation


def _validate_review_records(
    state: Mapping[str, Any]
) -> tuple[dict[str, dict[str, Mapping[str, Any]]], dict[str, Mapping[str, Any]]]:
    reviews = require_list(state.get("reviews"), "state.reviews")
    by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    by_review_id: dict[str, Mapping[str, Any]] = {}
    v5_annotations: list[dict[str, Any]] = []
    v5_task_by_annotation_sha: dict[str, dict[str, Any]] = {}
    source_bindings_expected = _source_review_bindings(state)
    for index, record_value in enumerate(reviews):
        record = require_mapping(record_value, f"reviews[{index}]")
        validate_seal(record, f"reviews[{index}]")
        if (
            record.get("schema_version") != SCHEMA_VERSION
            or record.get("record_type") != "font_catalog_delta_blind_review"
        ):
            raise DeltaLedgerError(f"reviews[{index}] has another schema")
        _decision_identity_leak(record, state, f"reviews[{index}]")
        review_id = require_id(record.get("review_id"), f"reviews[{index}].review_id")
        if review_id in by_review_id:
            raise DeltaLedgerError(f"duplicate review ID: {review_id}")
        stage = record.get("stage")
        if stage not in REVIEW_STAGES:
            raise DeltaLedgerError(f"reviews[{index}].stage is unsupported")
        assignment_id = require_id(
            record.get("assignment_id"), f"reviews[{index}].assignment_id"
        )
        binding = state["by_assignment"].get(assignment_id)
        if binding is None:
            raise DeltaLedgerError(f"reviews[{index}] references unknown assignment")
        assignment = require_mapping(
            binding.get("assignment"), f"reviews[{index}].assignment"
        )
        if stage in {"primary", "secondary"} and assignment.get("stage") != stage:
            raise DeltaLedgerError(
                f"reviews[{index}] uses an assignment from another stage"
            )
        if stage == "adjudication" and assignment.get("stage") != "primary":
            raise DeltaLedgerError("adjudication must bind the primary blind card")
        sample_id = require_id(record.get("sample_id"), f"reviews[{index}].sample_id")
        if sample_id != assignment.get("sample_id"):
            raise DeltaLedgerError(f"reviews[{index}] changed sample_id")
        if stage in by_sample[sample_id]:
            raise DeltaLedgerError(f"{sample_id}: duplicate {stage} decision")
        require_id(record.get("reviewer"), f"reviews[{index}].reviewer")
        if state["contract"].get("v5_derivation_required") is True:
            annotation = _validate_stored_v5_derivation(
                record=record,
                state=state,
                location=f"reviews[{index}]",
            )
            v5_annotations.append(annotation)
            candidate_task = v5_deriver.validate_task(
                require_mapping(
                    nested(record, "derivation_evidence", "candidate_task"),
                    f"reviews[{index}].derivation_evidence.candidate_task",
                ),
                f"reviews[{index}].candidate_task",
            )
            v5_task_by_annotation_sha[str(annotation["record_sha256"])] = candidate_task
        elif record.get("derivation_evidence") is not None:
            raise DeltaLedgerError(
                f"reviews[{index}] legacy workspace contains v5 derivation evidence"
            )
        else:
            normalized = _validate_decision(
                _decision_from_review(record),
                binding=binding,
                state=state,
                location=f"reviews[{index}]",
            )
            if normalized["role"] != nested(record, "role", "primary"):
                raise DeltaLedgerError(f"reviews[{index}] role normalization changed")
        source_bindings = require_mapping(
            record.get("source_bindings"), f"reviews[{index}].source_bindings"
        )
        for key, expected in source_bindings_expected.items():
            if source_bindings.get(key) != expected:
                raise DeltaLedgerError(f"reviews[{index}] changed source binding {key}")
        if source_bindings.get("selection_record_sha256") != binding.get(
            "selection_record_sha256"
        ) or source_bindings.get("prior_final_record_sha256") != binding.get(
            "prior_final_record_sha256"
        ):
            raise DeltaLedgerError(f"reviews[{index}] changed merge provenance")
        source_review_shas = _string_array(
            record.get("source_review_record_sha256s"),
            f"reviews[{index}].source_review_record_sha256s",
        )
        # _string_array accepts IDs, and SHA strings are valid portable IDs; now
        # enforce their exact digest shape.
        for sha in source_review_shas:
            require_sha(sha, f"reviews[{index}].source_review_record_sha256s")
        if stage != "adjudication" and source_review_shas:
            raise DeltaLedgerError("only adjudication may cite source reviews")
        by_sample[sample_id][str(stage)] = record
        by_review_id[review_id] = record

    for sample_id, stages in by_sample.items():
        if "primary" in stages and "secondary" in stages:
            if stages["primary"].get("reviewer") == stages["secondary"].get("reviewer"):
                raise DeltaLedgerError(
                    f"{sample_id}: primary and secondary reviewers are not independent"
                )
        if "adjudication" in stages:
            if _has_eligibility_exception(stages):
                raise DeltaLedgerError(
                    f"{sample_id}: eligibility exception cannot be adjudicated inside the font-tier ledger"
                )
            expected_sources = [
                stages[stage]["record_sha256"]
                for stage in ("primary", "secondary")
                if stage in stages
            ]
            actual_sources = list(
                stages["adjudication"]["source_review_record_sha256s"]
            )
            if actual_sources != expected_sources:
                raise DeltaLedgerError(
                    f"{sample_id}: adjudication source reviews changed"
                )
            prior_reviewers = {
                str(stages[stage]["reviewer"])
                for stage in ("primary", "secondary")
                if stage in stages
            }
            if stages["adjudication"].get("reviewer") in prior_reviewers:
                raise DeltaLedgerError(
                    f"{sample_id}: adjudicator must be independent of source reviewers"
                )
    if v5_annotations:
        annotation_shas = [str(row["record_sha256"]) for row in v5_annotations]
        if len(annotation_shas) != len(set(annotation_shas)):
            raise DeltaLedgerError("primary/secondary A annotation seal was reused")
        groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
        for annotation in v5_annotations:
            groups[
                (
                    str(annotation["reviewer_id"]),
                    str(annotation["stage"]),
                    str(annotation["batch_id"]),
                )
            ].append(annotation)
        for (reviewer, stage, _batch_id), annotations in groups.items():
            task_rows = [
                v5_task_by_annotation_sha[str(annotation["record_sha256"])]
                for annotation in annotations
            ]
            by_sample_annotation = {
                str(annotation["sample_id"]): annotation for annotation in annotations
            }
            try:
                v5_deriver._validate_batch_binding(
                    task_rows,
                    by_sample_annotation,
                    reviewer_id=reviewer,
                )
            except v5_deriver.DerivationError as error:
                raise DeltaLedgerError(str(error)) from error
    return by_sample, by_review_id


def submit_decisions(
    workspace: Path,
    *,
    stage: str,
    reviewer: str,
    decisions: Sequence[Mapping[str, Any]],
    derivation_audits: Sequence[Mapping[str, Any]] | None = None,
    source_annotations: Sequence[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if stage not in REVIEW_STAGES:
        raise DeltaLedgerError(f"unsupported stage: {stage}")
    reviewer_id = require_id(reviewer, "reviewer")
    if not decisions:
        raise DeltaLedgerError("decision file is empty")
    if source_annotations is not None:
        raise DeltaLedgerError(
            "source-only A annotations must be committed in a prior command; "
            "simultaneous A/decision submission is forbidden"
        )
    with workspace_lock(workspace.resolve()):
        state = _load_workspace(workspace)
        existing_by_sample, _ = _validate_review_records(state)
        if state["contract"].get("v5_derivation_required") is True:
            v5_evidence = _prepare_v5_derivation_batch(
                state=state,
                stage=stage,
                reviewer=reviewer_id,
                decisions=decisions,
                derivation_audits=derivation_audits,
            )
        else:
            if derivation_audits is not None:
                raise DeltaLedgerError(
                    "legacy workspace does not accept v5 derivation artifacts"
                )
            v5_evidence = {}
        seen_assignments: set[str] = set()
        created: list[dict[str, Any]] = []
        for index, decision_value in enumerate(decisions):
            decision = require_mapping(decision_value, f"decisions[{index}]")
            assignment_id = require_id(
                decision.get("assignment_id"), f"decisions[{index}].assignment_id"
            )
            if assignment_id in seen_assignments:
                raise DeltaLedgerError(
                    f"duplicate assignment in decision batch: {assignment_id}"
                )
            seen_assignments.add(assignment_id)
            binding = state["by_assignment"].get(assignment_id)
            if binding is None:
                raise DeltaLedgerError(f"unknown assignment: {assignment_id}")
            assignment = require_mapping(
                binding.get("assignment"), f"{assignment_id}.assignment"
            )
            sample_id = str(assignment["sample_id"])
            if stage in {"primary", "secondary"} and assignment.get("stage") != stage:
                raise DeltaLedgerError(f"{assignment_id} is not a {stage} assignment")
            if stage == "adjudication" and assignment.get("stage") != "primary":
                raise DeltaLedgerError(
                    "adjudication decisions must bind the primary card"
                )
            sample_reviews = dict(existing_by_sample.get(sample_id, {}))
            if stage in sample_reviews:
                raise DeltaLedgerError(f"{sample_id}: {stage} decision already exists")
            if (
                stage == "primary"
                and sample_reviews.get("secondary", {}).get("reviewer") == reviewer_id
            ):
                raise DeltaLedgerError(
                    f"{sample_id}: primary reviewer is not independent"
                )
            if (
                stage == "secondary"
                and sample_reviews.get("primary", {}).get("reviewer") == reviewer_id
            ):
                raise DeltaLedgerError(
                    f"{sample_id}: secondary reviewer is not independent"
                )

            source_review_shas: list[str] = []
            if stage == "adjudication":
                if "primary" not in sample_reviews:
                    raise DeltaLedgerError(
                        f"{sample_id}: adjudication lacks primary review"
                    )
                if _has_eligibility_exception(sample_reviews):
                    raise DeltaLedgerError(
                        f"{sample_id}: eligibility exceptions are resolved only by a new sealed font-signal audit"
                    )
                secondary_required = (
                    "secondary" in state["bindings_by_sample"][sample_id]
                )
                if secondary_required and "secondary" not in sample_reviews:
                    raise DeltaLedgerError(
                        f"{sample_id}: adjudication lacks required secondary review"
                    )
                reasons = _trigger_reasons(
                    sample_reviews, secondary_required=secondary_required
                )
                if not reasons:
                    raise DeltaLedgerError(
                        f"{sample_id}: adjudication is not triggered"
                    )
                prior_reviewers = {
                    str(row["reviewer"])
                    for key, row in sample_reviews.items()
                    if key in {"primary", "secondary"}
                }
                if reviewer_id in prior_reviewers:
                    raise DeltaLedgerError(
                        f"{sample_id}: adjudicator must be independent of source reviewers"
                    )
                source_review_shas = [
                    sample_reviews[key]["record_sha256"]
                    for key in ("primary", "secondary")
                    if key in sample_reviews
                ]

            candidate_task = (
                require_mapping(
                    v5_evidence[assignment_id].get("candidate_task"),
                    f"{assignment_id}.candidate_task",
                )
                if assignment_id in v5_evidence
                else None
            )
            normalized = _validate_decision(
                decision,
                binding=binding,
                state=state,
                location=f"decisions[{index}]",
                v5_candidate_task=candidate_task,
            )
            if candidate_task is not None and normalized["font_judgment"] is not None:
                public_to_prototype = {
                    public: prototype
                    for prototype, public in v5_deriver.release_alias_map(
                        str(candidate_task["release_nonce_sha256"])
                    ).items()
                }
                canonical_judgment = {
                    tier: [
                        public_to_prototype[alias]
                        for alias in normalized["font_judgment"][tier]
                    ]
                    for tier in TIERS
                }
                canonical_judgment["none_acceptable"] = normalized["font_judgment"][
                    "none_acceptable"
                ]
                normalized = {**normalized, "font_judgment": canonical_judgment}
            if stage == "adjudication":
                if normalized["confidence"] < 0.80:
                    raise DeltaLedgerError(
                        f"{sample_id}: adjudication must resolve review confidence to >= 0.80"
                    )
                if (
                    normalized["role_confidence"] < 0.75
                    or normalized["role"] == "unknown_needs_review"
                ):
                    raise DeltaLedgerError(
                        f"{sample_id}: adjudication must resolve the semantic role"
                    )
            record = _build_review_record(
                state=state,
                binding=binding,
                stage=stage,
                reviewer=reviewer_id,
                normalized=normalized,
                source_review_record_sha256s=source_review_shas,
                derivation_evidence=v5_evidence.get(assignment_id),
            )
            created.append(record)
            sample_reviews[stage] = record
            existing_by_sample[sample_id] = sample_reviews
        combined = [*state["reviews"], *created]
        atomic_write(state["reviews_path"], jsonl_bytes(combined))
    return created


def _tier_ranks(record: Mapping[str, Any]) -> tuple[dict[str, int], set[str]]:
    judgment = require_mapping(record.get("font_judgment"), "review.font_judgment")
    ranks: dict[str, int] = {}
    # Higher rank means safer.  Ties inside one tier intentionally remain ties.
    for rank, tier in enumerate(reversed(TIERS[:-1])):
        for alias in judgment.get(tier, []):
            ranks[str(alias)] = rank
    return ranks, set(str(alias) for alias in judgment.get("unrenderable", []))


def _pairwise_agreement(
    primary: Mapping[str, Any], secondary: Mapping[str, Any]
) -> tuple[int, int]:
    primary_ranks, primary_skipped = _tier_ranks(primary)
    secondary_ranks, secondary_skipped = _tier_ranks(secondary)
    if set(primary_ranks) | primary_skipped != set(secondary_ranks) | secondary_skipped:
        raise DeltaLedgerError("double reviewers did not judge the same alias catalog")
    comparable = sorted(set(primary_ranks).intersection(secondary_ranks))
    equal = 0
    total = 0
    for left_index, left in enumerate(comparable):
        for right in comparable[left_index + 1 :]:
            total += 1
            primary_relation = (primary_ranks[left] > primary_ranks[right]) - (
                primary_ranks[left] < primary_ranks[right]
            )
            secondary_relation = (secondary_ranks[left] > secondary_ranks[right]) - (
                secondary_ranks[left] < secondary_ranks[right]
            )
            equal += primary_relation == secondary_relation
    return equal, total


def _safe_set(record: Mapping[str, Any]) -> set[str]:
    judgment = require_mapping(record.get("font_judgment"), "review.font_judgment")
    return set(judgment.get("preferred", [])) | set(judgment.get("acceptable", []))


def _jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return 1.0 if not union else len(left & right) / len(union)


def _role_macro_f1(samples: Sequence[Mapping[str, Any]]) -> float:
    labels = sorted(
        {str(row["role_primary"]) for row in samples}
        | {str(row["role_secondary"]) for row in samples}
    )
    scores: list[float] = []
    for label in labels:
        true_positive = sum(
            row["role_primary"] == label and row["role_secondary"] == label
            for row in samples
        )
        false_positive = sum(
            row["role_primary"] != label and row["role_secondary"] == label
            for row in samples
        )
        false_negative = sum(
            row["role_primary"] == label and row["role_secondary"] != label
            for row in samples
        )
        denominator = 2 * true_positive + false_positive + false_negative
        scores.append(0.0 if denominator == 0 else 2 * true_positive / denominator)
    return sum(scores) / len(scores)


def _agreement_metric_block(samples: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    pairwise_equal = sum(int(row["pairwise_equal"]) for row in samples)
    pairwise_total = sum(int(row["pairwise_total"]) for row in samples)
    sample_pairwise = [
        row["pairwise_equal"] / row["pairwise_total"]
        for row in samples
        if row["pairwise_total"]
    ]
    return {
        "sample_count": len(samples),
        "role_macro_f1": _role_macro_f1(samples),
        "tier_pairwise_agreement": (
            None if not pairwise_total else pairwise_equal / pairwise_total
        ),
        "tier_pairwise_sample_macro": (
            None if not sample_pairwise else sum(sample_pairwise) / len(sample_pairwise)
        ),
        "tier_pair_count": pairwise_total,
        "acceptable_set_jaccard": sum(
            float(row["acceptable_jaccard"]) for row in samples
        )
        / len(samples),
        "none_acceptable_agreement": sum(bool(row["none_agreement"]) for row in samples)
        / len(samples),
    }


def evaluate_agreement(
    by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]]
) -> dict[str, Any] | None:
    samples: list[dict[str, Any]] = []
    eligibility_excluded = 0
    for sample_id, stages in sorted(by_sample.items()):
        if "secondary" not in stages:
            continue
        if "primary" not in stages:
            raise DeltaLedgerError(f"{sample_id}: secondary review lacks primary")
        primary = stages["primary"]
        secondary = stages["secondary"]
        if _has_eligibility_exception(stages):
            eligibility_excluded += 1
            continue
        equal, total = _pairwise_agreement(primary, secondary)
        primary_safe = _safe_set(primary)
        secondary_safe = _safe_set(secondary)
        samples.append(
            {
                "sample_id": sample_id,
                "work_id": primary["work_id"],
                "role_primary": nested(primary, "role", "primary"),
                "role_secondary": nested(secondary, "role", "primary"),
                "pairwise_equal": equal,
                "pairwise_total": total,
                "acceptable_jaccard": _jaccard(primary_safe, secondary_safe),
                "none_agreement": bool(
                    nested(primary, "font_judgment", "none_acceptable")
                )
                == bool(nested(secondary, "font_judgment", "none_acceptable")),
            }
        )
    if not samples:
        return None
    overall = _agreement_metric_block(samples)
    by_work_samples: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        by_work_samples[str(sample["work_id"])].append(sample)
    by_work = {
        work_id: _agreement_metric_block(work_samples)
        for work_id, work_samples in sorted(by_work_samples.items())
    }
    gates = {
        key: overall.get(key) is not None and float(overall[key]) >= threshold
        for key, threshold in CALIBRATION_THRESHOLDS.items()
    }
    return {
        "double_review_sample_count": len(samples),
        "eligibility_excluded_double_review_count": eligibility_excluded,
        "work_count": len(by_work),
        "overall": overall,
        "thresholds": dict(CALIBRATION_THRESHOLDS),
        "gates": gates,
        "all_gates_pass": all(gates.values()),
        "by_work": by_work,
    }


def _validate_workspace_state(
    state: Mapping[str, Any], *, require_complete: bool = False
) -> dict[str, Any]:
    """Build the workspace validation report from one fully verified load.

    Callers must pass the state returned by :func:`_load_workspace`.  That load
    performs every source-byte and review-surface byte/pixel integrity check;
    this helper deliberately reuses the verified in-memory state instead of
    reopening the same (potentially very large) candidate surface inventory.
    """

    by_sample, _ = _validate_review_records(state)
    expected_counts = Counter(
        nested(binding, "assignment", "stage") for binding in state["bindings"]
    )
    actual_counts = Counter(
        stage
        for stages in by_sample.values()
        for stage in stages
        if stage in {"primary", "secondary"}
    )
    missing_primary: list[str] = []
    missing_secondary: list[str] = []
    pending_adjudication: dict[str, list[str]] = {}
    unnecessary_adjudication: list[str] = []
    eligibility_exceptions: dict[str, list[str]] = {}
    for sample_id, bindings in state["bindings_by_sample"].items():
        stages = by_sample.get(sample_id, {})
        if "primary" not in stages:
            missing_primary.append(sample_id)
        exception = _has_eligibility_exception(stages)
        if exception:
            eligibility_exceptions[sample_id] = sorted(
                {
                    str(row["eligibility"])
                    for stage, row in stages.items()
                    if stage in {"primary", "secondary"}
                    and row.get("eligibility") != "font_signal_present"
                }
            )
        if not exception and "secondary" in bindings and "secondary" not in stages:
            missing_secondary.append(sample_id)
        secondary_required = "secondary" in bindings
        ready_for_trigger = (
            not exception
            and "primary" in stages
            and (not secondary_required or "secondary" in stages)
        )
        reasons = (
            _trigger_reasons(stages, secondary_required=secondary_required)
            if ready_for_trigger
            else []
        )
        if reasons and "adjudication" not in stages:
            pending_adjudication[sample_id] = reasons
        if not reasons and "adjudication" in stages:
            unnecessary_adjudication.append(sample_id)
        if "adjudication" in stages:
            adjudication = stages["adjudication"]
            if (
                float(adjudication["confidence"]) < 0.80
                or float(nested(adjudication, "role", "confidence")) < 0.75
                or nested(adjudication, "role", "primary") == "unknown_needs_review"
            ):
                raise DeltaLedgerError(f"{sample_id}: adjudication remains unresolved")
    if unnecessary_adjudication:
        raise DeltaLedgerError(
            f"untriggered adjudications found: {unnecessary_adjudication[:5]}"
        )
    complete = (
        not missing_primary and not missing_secondary and not pending_adjudication
    )
    if require_complete and not complete:
        raise DeltaLedgerError(
            "workspace is incomplete "
            f"(primary={len(missing_primary)}, secondary={len(missing_secondary)}, "
            f"adjudication={len(pending_adjudication)})"
        )
    agreement = evaluate_agreement(by_sample)
    provisional_catalog = _validate_existing_v5_final_artifacts(state, by_sample)
    report = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "font_catalog_delta_workspace_validation",
        "workspace_contract_record_sha256": state["contract"]["record_sha256"],
        "mode": state["contract"]["mode"],
        "selected_sample_count": len(state["bindings_by_sample"]),
        "expected_review_counts": dict(sorted(expected_counts.items())),
        "submitted_review_counts": dict(sorted(actual_counts.items())),
        "adjudication_count": sum(
            "adjudication" in stages for stages in by_sample.values()
        ),
        "missing_primary_count": len(missing_primary),
        "missing_secondary_count": len(missing_secondary),
        "pending_adjudication_count": len(pending_adjudication),
        "font_signal_exception_count": len(eligibility_exceptions),
        "font_signal_exception_outcome_counts": dict(
            sorted(
                Counter(
                    outcome
                    for outcomes in eligibility_exceptions.values()
                    for outcome in outcomes
                ).items()
            )
        ),
        "pending_adjudication_reason_counts": dict(
            sorted(
                Counter(
                    reason
                    for reasons in pending_adjudication.values()
                    for reason in reasons
                ).items()
            )
        ),
        "agreement": agreement,
        "complete": complete,
        **(
            {
                "provisional_catalog_delta_candidate_count": provisional_catalog[
                    "evaluated_delta_candidate_count"
                ],
                "provisional_catalog_record_sha256": provisional_catalog[
                    "record_sha256"
                ],
            }
            if provisional_catalog is not None
            else {}
        ),
    }
    return seal(report)


def validate_workspace(
    workspace: Path, *, require_complete: bool = False
) -> dict[str, Any]:
    state = _load_workspace(workspace)
    return _validate_workspace_state(state, require_complete=require_complete)


def _build_calibration_report(
    state: Mapping[str, Any], validation: Mapping[str, Any]
) -> dict[str, Any]:
    if state["contract"].get("mode") != "calibration":
        raise DeltaLedgerError("only a calibration workspace can emit a gate report")
    if validation.get("missing_primary_count") or validation.get(
        "missing_secondary_count"
    ):
        raise DeltaLedgerError(
            "calibration workspace lacks a complete independent primary/secondary pair"
        )
    if validation.get("adjudication_count"):
        raise DeltaLedgerError(
            "calibration agreement must be measured before adjudication"
        )
    if validation.get("font_signal_exception_count"):
        raise DeltaLedgerError(
            "calibration subset contains a newly discovered eligibility exception; replace it with a fresh sample"
        )
    agreement = require_mapping(validation.get("agreement"), "validation.agreement")
    calibration = require_mapping(
        state["contract"].get("calibration"), "contract.calibration"
    )
    if (
        calibration.get("fresh_blind_round") is not True
        or calibration.get("prior_answers_visible") is not False
        or calibration.get("development_only") is not True
    ):
        raise DeltaLedgerError(
            "calibration workspace is not a fresh development-only blind round"
        )
    completed_at = max(
        str(row["reviewed_at"])
        for row in state["reviews"]
        if row.get("stage") in {"primary", "secondary"}
    )
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_calibration_gate",
            "created_at": completed_at,
            "calibration_round_id": calibration.get("round_id"),
            "fresh_blind_round": True,
            "prior_answers_visible": False,
            "development_only": True,
            "calibration_reservoir": calibration.get("reservoir"),
            "calibration_source_split": calibration.get("source_split"),
            "calibration_selection_profile": calibration.get("selection_profile"),
            "calibration_selection_profile_contract_sha256": calibration.get(
                "selection_profile_contract_sha256"
            ),
            "calibration_selection_audit_sha256": (
                sha256_bytes(canonical_json_bytes(calibration["selection_audit"]))
                if calibration.get("selection_audit") is not None
                else None
            ),
            "successor_authority_only": (
                nested(
                    state,
                    "contract",
                    "calibration",
                    "successor_authority_only",
                )
                is True
            ),
            "successor_authority_binding": copy.deepcopy(
                nested(
                    state,
                    "contract",
                    "calibration",
                    "successor_authority_binding",
                )
            ),
            "test_split_used": False,
            "training_quarantine_required": calibration.get(
                "training_quarantine_required"
            ),
            "selected_sample_ids": sorted(state["bindings_by_sample"]),
            "training_quarantine_sample_ids": list(
                calibration.get("training_quarantine_sample_ids", [])
            ),
            "training_quarantine_sample_ids_sha256": calibration.get(
                "training_quarantine_sample_ids_sha256"
            ),
            "rubric_sha256": nested(state, "contract", "rubric", "sha256"),
            "selected_sample_ids_sha256": state["contract"][
                "selected_sample_ids_sha256"
            ],
            "review_records_sha256": sha256_file(state["reviews_path"]),
            "source_records": copy.deepcopy(state["contract"]["source_records"]),
            "double_review_sample_count": agreement["double_review_sample_count"],
            "overall": copy.deepcopy(agreement["overall"]),
            "thresholds": dict(CALIBRATION_THRESHOLDS),
            "gates": copy.deepcopy(agreement["gates"]),
            "all_gates_pass": agreement["all_gates_pass"],
            "review_answers_reused_from_failed_round": False,
        }
    )
    return report


def _validate_calibration_report(
    report: Mapping[str, Any], state: Mapping[str, Any]
) -> None:
    validate_seal(report, "calibration report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != "font_catalog_delta_calibration_gate"
    ):
        raise DeltaLedgerError("calibration report uses another schema")
    if (
        report.get("fresh_blind_round") is not True
        or report.get("prior_answers_visible") is not False
        or report.get("development_only") is not True
        or report.get("review_answers_reused_from_failed_round") is not False
    ):
        raise DeltaLedgerError(
            "calibration report is not a fresh independent blind round"
        )
    if report.get("test_split_used") is not False:
        raise DeltaLedgerError("calibration report used the sealed test split")
    contract_authority_only = (
        nested(
            state,
            "contract",
            "calibration",
            "successor_authority_only",
        )
        is True
    )
    if (
        report.get("successor_authority_only") is True
    ) != contract_authority_only or report.get("successor_authority_binding") != nested(
        state,
        "contract",
        "calibration",
        "successor_authority_binding",
    ):
        raise DeltaLedgerError("calibration report successor authority binding changed")
    selection_profile = report.get("calibration_selection_profile")
    if selection_profile is not None:
        if selection_profile != VARIANT_V4_CALIBRATION_PROFILE:
            raise DeltaLedgerError(
                f"calibration report has unsupported selection profile: {selection_profile}"
            )
        expected_profile_sha = sha256_bytes(
            canonical_json_bytes(_variant_v4_profile_contract())
        )
        if (
            report.get("calibration_selection_profile_contract_sha256")
            != expected_profile_sha
        ):
            raise DeltaLedgerError(
                "calibration report variant-first profile hash changed"
            )
        require_sha(
            report.get("calibration_selection_audit_sha256"),
            "calibration report.calibration_selection_audit_sha256",
        )
    reservoir = report.get("calibration_reservoir")
    source_split = report.get("calibration_source_split")
    quarantine_required = report.get("training_quarantine_required")
    if (
        reservoir not in {"val", "train_quarantine"}
        or source_split not in {"val", "train"}
        or quarantine_required != (source_split == "train")
        or reservoir != ("train_quarantine" if source_split == "train" else "val")
    ):
        raise DeltaLedgerError("calibration report reservoir contract is inconsistent")
    quarantine_ids = _string_array(
        report.get("training_quarantine_sample_ids"),
        "calibration report.training_quarantine_sample_ids",
    )
    if len(quarantine_ids) != len(set(quarantine_ids)):
        raise DeltaLedgerError("calibration report quarantine contains duplicates")
    if sha256_bytes(canonical_json_bytes(sorted(quarantine_ids))) != report.get(
        "training_quarantine_sample_ids_sha256"
    ):
        raise DeltaLedgerError("calibration report quarantine hash changed")
    selected_ids = _string_array(
        report.get("selected_sample_ids"),
        "calibration report.selected_sample_ids",
    )
    if (
        len(selected_ids) != len(set(selected_ids))
        or sha256_bytes(canonical_json_bytes(sorted(selected_ids)))
        != report.get("selected_sample_ids_sha256")
        or any(
            item not in state["source"]["inventory"]
            or state["source"]["split_by_sample"].get(item) != source_split
            for item in selected_ids
        )
    ):
        raise DeltaLedgerError("calibration report selected inventory changed")
    if state["contract"].get("v5_derivation_required") is True:
        calibration_closure = _calibration_leakage_closure(
            state["source"], set(selected_ids)
        )
        production_ids = set(state["bindings_by_sample"])
        production_overlap = sorted(calibration_closure.intersection(production_ids))
        if production_overlap:
            raise DeltaLedgerError(
                "v5 calibration leakage closure overlaps the production pool: "
                f"{production_overlap[:5]}"
            )
        permanently_excluded = set(state["prior_calibration"]["excluded_sample_ids"])
        if not calibration_closure.issubset(permanently_excluded):
            raise DeltaLedgerError(
                "v5 production must bind the fresh calibration subset as a permanent "
                "prior-calibration exclusion"
            )
    if quarantine_required:
        expected_quarantine = _sealed_calibration_training_quarantine(
            state["source"], set(selected_ids)
        )
        if quarantine_ids != expected_quarantine:
            raise DeltaLedgerError(
                "train calibration reservoir is not fully quarantined"
            )
    elif quarantine_ids:
        raise DeltaLedgerError("val calibration cannot quarantine training samples")
    if report.get("rubric_sha256") != nested(state, "contract", "rubric", "sha256"):
        raise DeltaLedgerError("calibration report used another rubric revision")
    if report.get("thresholds") != CALIBRATION_THRESHOLDS:
        raise DeltaLedgerError("calibration thresholds differ from the frozen rubric")
    overall = require_mapping(report.get("overall"), "calibration report.overall")
    expected_gates = {
        key: overall.get(key) is not None and float(overall[key]) >= threshold
        for key, threshold in CALIBRATION_THRESHOLDS.items()
    }
    if report.get("gates") != expected_gates or report.get("all_gates_pass") is not all(
        expected_gates.values()
    ):
        raise DeltaLedgerError("calibration gate calculation is inconsistent")
    if not all(expected_gates.values()):
        raise DeltaLedgerError("fresh calibration did not pass all frozen gates")
    if (
        not isinstance(report.get("double_review_sample_count"), int)
        or report.get("double_review_sample_count", 0) < 1
    ):
        raise DeltaLedgerError(
            "calibration report contains no independent double review"
        )
    report_sources = require_mapping(
        report.get("source_records"), "calibration report.source_records"
    )
    current_sources = require_mapping(
        state["contract"].get("source_records"), "contract.source_records"
    )
    if dict(report_sources) != dict(current_sources):
        raise DeltaLedgerError(
            "calibration report binds another source-record inventory"
        )


def deterministic_candidate_order(candidate_ids: Iterable[str], seed: str) -> list[str]:
    candidates = list(candidate_ids)
    if len(candidates) != len(set(candidates)) or not candidates:
        raise DeltaLedgerError("candidate IDs must be a non-empty unique set")
    return sorted(
        candidates,
        key=lambda candidate: (
            stable_hash("manga-font-candidate-rank-v1", seed, candidate),
            candidate,
        ),
    )


def _v5_catalog_artifacts(
    *,
    state: Mapping[str, Any],
    by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]],
    calibration_report: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Seal a fail-closed disposition before the full-22 utility audit.

    No delta font becomes active here.  A safe-zero candidate is distinguished
    from a candidate that never had a deployable rendering opportunity, because
    the latter is a deployment failure rather than evidence of poor utility.
    """

    if state["contract"].get("v5_derivation_required") is not True:
        raise DeltaLedgerError("catalog disposition is only defined for v5")
    alias_to_id = require_mapping(
        state["source"].get("alias_to_id"), "source.alias_to_id"
    )
    alias_order = list(v5_deriver.FROZEN_ALIAS_ORDER)
    if set(alias_to_id) != set(alias_order):
        raise DeltaLedgerError("v5 disposition candidate aliases changed")

    tier_counts: dict[str, Counter[str]] = {alias: Counter() for alias in alias_order}
    deployable_opportunity_counts: Counter[str] = Counter()
    observed_sample_ids: list[str] = []
    for sample_id in sorted(state["bindings_by_sample"]):
        stages = by_sample[sample_id]
        if _has_eligibility_exception(stages):
            continue
        secondary_required = "secondary" in state["bindings_by_sample"][sample_id]
        final_review, _, _, _ = _resolved_review(
            sample_id,
            stages,
            secondary_required=secondary_required,
        )
        if final_review.get("eligibility") != "font_signal_present":
            continue
        judgment = require_mapping(
            final_review.get("font_judgment"),
            f"{sample_id}.v5_catalog_disposition.font_judgment",
        )
        observed: set[str] = set()
        for tier in TIERS:
            aliases = _string_array(
                judgment.get(tier),
                f"{sample_id}.v5_catalog_disposition.{tier}",
            )
            for alias in aliases:
                if alias not in tier_counts or alias in observed:
                    raise DeltaLedgerError(
                        f"{sample_id}: disposition review does not partition v5 aliases"
                    )
                observed.add(alias)
                tier_counts[alias][tier] += 1
        if observed != set(alias_order):
            raise DeltaLedgerError(
                f"{sample_id}: disposition review does not cover the v5 catalog"
            )
        derivation_evidence = require_mapping(
            final_review.get("derivation_evidence"),
            f"{sample_id}.v5_catalog_disposition.derivation_evidence",
        )
        candidate_task = require_mapping(
            derivation_evidence.get("candidate_task"),
            f"{sample_id}.v5_catalog_disposition.candidate_task",
        )
        audit = require_mapping(
            derivation_evidence.get("derivation_audit"),
            f"{sample_id}.v5_catalog_disposition.derivation_audit",
        )
        public_to_prototype = {
            public: prototype
            for prototype, public in v5_deriver.release_alias_map(
                require_sha(
                    candidate_task.get("release_nonce_sha256"),
                    f"{sample_id}.candidate_task.release_nonce_sha256",
                )
            ).items()
        }
        audit_candidates = require_list(
            audit.get("candidates"),
            f"{sample_id}.v5_catalog_disposition.derivation_audit.candidates",
        )
        audit_aliases: set[str] = set()
        for index, raw_candidate in enumerate(audit_candidates):
            candidate = require_mapping(
                raw_candidate,
                f"{sample_id}.v5_catalog_disposition.candidates[{index}]",
            )
            public_alias = require_text(
                candidate.get("alias"),
                f"{sample_id}.v5_catalog_disposition.candidates[{index}].alias",
            )
            if public_alias not in public_to_prototype or public_alias in audit_aliases:
                raise DeltaLedgerError(
                    f"{sample_id}: derivation audit candidate aliases changed"
                )
            audit_aliases.add(public_alias)
            prototype_alias = public_to_prototype[public_alias]
            mandatory_unrenderable = candidate.get("mandatory_unrenderable")
            if not isinstance(mandatory_unrenderable, bool):
                raise DeltaLedgerError(
                    f"{sample_id}: derivation audit deployment state is invalid"
                )
            if not mandatory_unrenderable:
                deployable_opportunity_counts[prototype_alias] += 1
        if audit_aliases != set(public_to_prototype):
            raise DeltaLedgerError(
                f"{sample_id}: derivation audit does not cover the v5 catalog"
            )
        observed_sample_ids.append(sample_id)

    entries: list[dict[str, Any]] = []
    pending_aliases: list[str] = []
    removed_aliases: list[str] = []
    deployment_failure_aliases: list[str] = []
    for alias in alias_order:
        counts = tier_counts[alias]
        preferred_count = counts["preferred"]
        acceptable_count = counts["acceptable"]
        safe_count = preferred_count + acceptable_count
        deployable_opportunity_count = deployable_opportunity_counts[alias]
        all_unrenderable = deployable_opportunity_count == 0
        if all_unrenderable:
            deployment_failure_aliases.append(alias)
            action = V5_DEPLOYMENT_FAILURE_ACTION
            replacement_state = "pending_repaired_blind_v5_round"
            reason_code = "no_deployable_rendering_opportunity"
        elif safe_count == 0:
            removed_aliases.append(alias)
            action = V5_SAFE_ZERO_ACTION
            replacement_state = "pending_fresh_blind_v5_round"
            reason_code = "production_safe_zero_with_deployable_opportunity"
        else:
            pending_aliases.append(alias)
            action = V5_PENDING_UTILITY_ACTION
            replacement_state = "pending_full22_utility_audit"
            reason_code = "observed_safe_but_not_yet_unique"
        entries.append(
            {
                "blind_alias": alias,
                "candidate_id": str(alias_to_id[alias]),
                "preferred_count": preferred_count,
                "acceptable_count": acceptable_count,
                "safe_count": safe_count,
                "marginal_count": counts["marginal"],
                "unacceptable_count": counts["unacceptable"],
                "unrenderable_count": counts["unrenderable"],
                "deployable_opportunity_count": deployable_opportunity_count,
                "all_unrenderable": all_unrenderable,
                "terminal": False,
                "active_release_eligible": False,
                "action": action,
                "reason_code": reason_code,
                "replacement_state": replacement_state,
            }
        )

    disposition = seal(
        {
            "schema_version": V5_CATALOG_DISPOSITION_SCHEMA_VERSION,
            "record_type": V5_CATALOG_DISPOSITION_RECORD_TYPE,
            "workspace_contract_record_sha256": state["contract"]["record_sha256"],
            "calibration_report_record_sha256": calibration_report["record_sha256"],
            "review_ledger_sha256": sha256_file(state["reviews_path"]),
            "source_catalog_sha256": nested(
                state, "contract", "source_records", "expanded_catalog_sha256"
            ),
            "source_render_bank_sha256": nested(
                state,
                "contract",
                "source_records",
                "expanded_render_bank_sha256",
            ),
            "master_split_map_sha256": nested(
                state, "contract", "source_records", "master_split_map_sha256"
            ),
            "production_sample_count": len(state["bindings_by_sample"]),
            "observed_font_signal_sample_count": len(observed_sample_ids),
            "observed_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(observed_sample_ids)
            ),
            "release_state": "provisional_not_released",
            "final_release_allowed": False,
            "full22_utility_audit_required": True,
            "candidate_count": len(entries),
            "included_candidate_count": 0,
            "safe_zero_candidate_count": len(removed_aliases),
            "deployment_failure_candidate_count": len(deployment_failure_aliases),
            "pending_full22_utility_candidate_count": len(pending_aliases),
            "terminal_candidate_count": 0,
            "all_candidates_non_active": True,
            "included_aliases": [],
            "pending_aliases": pending_aliases,
            "removed_aliases": removed_aliases,
            "deployment_failure_aliases": deployment_failure_aliases,
            "entries": entries,
        }
    )

    prior_candidate_ids = sorted(state["source"]["old_candidates"])
    delta_candidates = [
        {
            "blind_alias": entry["blind_alias"],
            "candidate_id": entry["candidate_id"],
            "action": entry["action"],
            "safe_count": entry["safe_count"],
            "deployable_opportunity_count": entry["deployable_opportunity_count"],
            "all_unrenderable": entry["all_unrenderable"],
            "terminal": entry["terminal"],
            "active_release_eligible": entry["active_release_eligible"],
            "replacement_state": entry["replacement_state"],
        }
        for entry in entries
    ]
    provisional_catalog = seal(
        {
            "schema_version": V5_PROVISIONAL_CATALOG_SCHEMA_VERSION,
            "record_type": V5_PROVISIONAL_CATALOG_RECORD_TYPE,
            "workspace_contract_record_sha256": state["contract"]["record_sha256"],
            "catalog_disposition_record_sha256": disposition["record_sha256"],
            "source_catalog_sha256": nested(
                state, "contract", "source_records", "expanded_catalog_sha256"
            ),
            "release_state": "provisional_not_released",
            "final_release_allowed": False,
            "full22_utility_audit_required": True,
            "required_next_action": "complete_full22_utility_and_redundancy_audit",
            "prior_candidate_count": len(prior_candidate_ids),
            "prior_candidate_ids": prior_candidate_ids,
            "evaluated_delta_candidate_count": len(delta_candidates),
            "active_delta_candidate_count": 0,
            "delta_candidates": delta_candidates,
        }
    )
    return disposition, provisional_catalog


def _validate_existing_v5_final_artifacts(
    state: Mapping[str, Any],
    by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> dict[str, Any] | None:
    if state["contract"].get("v5_derivation_required") is not True:
        return None
    root = state["root"]
    forbidden = [
        root / "final-catalog.json",
        root / "final-labels-catalog.jsonl",
        root / "merge-report.json",
    ]
    if any(path.exists() for path in forbidden):
        raise DeltaLedgerError(
            "v5 provisional workflow contains a forbidden final-release artifact"
        )
    paths = {
        "disposition": root / "catalog-disposition.json",
        "catalog": root / "provisional-catalog.json",
        "report": root / "provisional-report.json",
    }
    present = {name for name, path in paths.items() if path.is_file()}
    if not present:
        return None
    # The report is the transaction commit marker and is written last.
    if "report" not in present:
        return None
    if present != set(paths):
        raise DeltaLedgerError(
            "v5 provisional catalog artifact set is partial: "
            f"missing={sorted(set(paths) - present)}"
        )

    disposition = read_json(paths["disposition"])
    provisional_catalog = read_json(paths["catalog"])
    provisional_report = read_json(paths["report"])
    validate_seal(disposition, "catalog disposition")
    validate_seal(provisional_catalog, "provisional catalog")
    validate_seal(provisional_report, "provisional report")
    if (
        disposition.get("schema_version") != V5_CATALOG_DISPOSITION_SCHEMA_VERSION
        or disposition.get("record_type") != V5_CATALOG_DISPOSITION_RECORD_TYPE
        or provisional_catalog.get("schema_version")
        != V5_PROVISIONAL_CATALOG_SCHEMA_VERSION
        or provisional_catalog.get("record_type") != V5_PROVISIONAL_CATALOG_RECORD_TYPE
        or provisional_report.get("record_type") != V5_PROVISIONAL_REPORT_RECORD_TYPE
    ):
        raise DeltaLedgerError("v5 provisional catalog uses another schema")
    if any(
        artifact.get("release_state") != "provisional_not_released"
        or artifact.get("final_release_allowed") is not False
        for artifact in (disposition, provisional_catalog, provisional_report)
    ):
        raise DeltaLedgerError("v5 provisional artifacts claim a final release")
    calibration_sha = require_sha(
        disposition.get("calibration_report_record_sha256"),
        "catalog disposition.calibration_report_record_sha256",
    )
    expected_disposition, expected_catalog = _v5_catalog_artifacts(
        state=state,
        by_sample=by_sample,
        calibration_report={"record_sha256": calibration_sha},
    )
    if disposition != expected_disposition:
        raise DeltaLedgerError("v5 provisional catalog disposition changed")
    if provisional_catalog != expected_catalog:
        raise DeltaLedgerError("v5 provisional catalog changed")
    if (
        provisional_report.get("workspace_contract_record_sha256")
        != state["contract"]["record_sha256"]
        or provisional_report.get("calibration_report_record_sha256") != calibration_sha
        or provisional_report.get("catalog_disposition_record_sha256")
        != disposition["record_sha256"]
        or provisional_report.get("provisional_catalog_record_sha256")
        != provisional_catalog["record_sha256"]
    ):
        raise DeltaLedgerError("v5 provisional report changed its catalog bindings")
    outputs = require_mapping(
        provisional_report.get("outputs"), "provisional report.outputs"
    )
    expected_output_hashes = {
        "catalog_disposition_sha256": sha256_file(paths["disposition"]),
        "provisional_catalog_sha256": sha256_file(paths["catalog"]),
    }
    for key, expected in expected_output_hashes.items():
        if outputs.get(key) != expected:
            raise DeltaLedgerError(f"v5 provisional output changed: {key}")
    return provisional_catalog


def _resolved_review(
    sample_id: str,
    stages: Mapping[str, Mapping[str, Any]],
    *,
    secondary_required: bool,
) -> tuple[Mapping[str, Any], str, list[str], list[Mapping[str, Any]]]:
    primary = stages["primary"]
    source_reviews = [primary]
    if secondary_required:
        source_reviews.append(stages["secondary"])
    reasons = _trigger_reasons(stages, secondary_required=secondary_required)
    if reasons:
        adjudication = stages.get("adjudication")
        if adjudication is None:
            raise DeltaLedgerError(
                f"{sample_id}: triggered decision lacks adjudication"
            )
        return adjudication, "adjudicated", reasons, source_reviews
    if "adjudication" in stages:
        raise DeltaLedgerError(
            f"{sample_id}: untriggered adjudication cannot be merged"
        )
    kind = "blind_agreement" if secondary_required else "primary"
    return primary, kind, reasons, source_reviews


def _delta_resolution(
    *,
    state: Mapping[str, Any],
    sample_id: str,
    final_review: Mapping[str, Any],
    resolution_kind: str,
    reasons: Sequence[str],
    source_reviews: Sequence[Mapping[str, Any]],
    included_delta_aliases: set[str] | None = None,
    catalog_disposition_record_sha256: str | None = None,
) -> dict[str, Any]:
    if final_review.get("eligibility") != "font_signal_present":
        raise DeltaLedgerError(
            f"{sample_id}: eligibility exception cannot enter candidate merge"
        )
    primary_binding = state["bindings_by_sample"][sample_id]["primary"]
    alias_to_id = require_mapping(
        primary_binding.get("alias_to_candidate_id"),
        f"{sample_id}.alias_to_candidate_id",
    )
    included_aliases = (
        set(alias_to_id) if included_delta_aliases is None else included_delta_aliases
    )
    if not included_aliases.issubset(alias_to_id):
        raise DeltaLedgerError(f"{sample_id}: disposition includes an unknown alias")
    judgment_alias = require_mapping(
        final_review.get("font_judgment"), f"{sample_id}.font_judgment"
    )
    judgment_ids = {
        tier: [
            str(alias_to_id[alias])
            for alias in judgment_alias[tier]
            if alias in included_aliases
        ]
        for tier in TIERS
    }
    judgment_ids["not_reviewed"] = []
    judgment_ids["none_acceptable"] = (
        not judgment_ids["preferred"] and not judgment_ids["acceptable"]
    )
    source_review_ids = [str(row["review_id"]) for row in source_reviews]
    if resolution_kind == "adjudicated":
        source_review_ids.append(str(final_review["review_id"]))
    delta_hash = (
        stable_hash(
            "font-catalog-delta-resolution-v5",
            sample_id,
            str(final_review["record_sha256"]),
            str(catalog_disposition_record_sha256),
        )
        if catalog_disposition_record_sha256 is not None
        else stable_hash(
            "font-catalog-delta-resolution-v1",
            sample_id,
            str(final_review["record_sha256"]),
        )
    )
    delta_id = f"fmdl-{delta_hash[:32]}"
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_resolved_label",
            "delta_label_id": delta_id,
            "sample_id": sample_id,
            "work_id": final_review["work_id"],
            "source_page_sha256": final_review["source_page_sha256"],
            "resolution_kind": resolution_kind,
            "trigger_reasons": list(reasons),
            "source_review_ids": source_review_ids,
            "source_review_record_sha256s": [
                row["record_sha256"] for row in source_reviews
            ]
            + (
                [final_review["record_sha256"]]
                if resolution_kind == "adjudicated"
                else []
            ),
            "role": copy.deepcopy(final_review["role"]),
            "font_judgment": judgment_ids,
            "confidence": final_review["confidence"],
            "rationale": final_review["rationale"],
            "review_evidence": copy.deepcopy(final_review["evidence"]),
            "source_bindings": {
                **_source_review_bindings(state),
                "selection_record_sha256": primary_binding["selection_record_sha256"],
                "prior_final_record_sha256": primary_binding[
                    "prior_final_record_sha256"
                ],
                **(
                    {
                        "catalog_disposition_record_sha256": require_sha(
                            catalog_disposition_record_sha256,
                            "catalog_disposition_record_sha256",
                        )
                    }
                    if catalog_disposition_record_sha256 is not None
                    else {}
                ),
            },
        }
    )


def _merge_final_record(
    *,
    state: Mapping[str, Any],
    sample_id: str,
    delta: Mapping[str, Any],
    resolver: str,
    final_catalog: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    selection = state["source"]["selection"][sample_id]
    prior = copy.deepcopy(
        dict(nested(selection, "merge_provenance", "prior_final_record"))
    )
    prior_judgment = require_mapping(
        prior.get("font_judgment"), f"{sample_id}.prior.font_judgment"
    )
    old_partition, old_candidates = _candidate_partition_with_not_reviewed(
        prior_judgment, f"{sample_id}.prior.font_judgment"
    )
    delta_judgment = require_mapping(
        delta.get("font_judgment"), f"{sample_id}.delta.font_judgment"
    )
    new_candidates = {
        candidate
        for tier in ALL_FINAL_TIERS
        for candidate in delta_judgment.get(tier, [])
    }
    expected_new_candidates = (
        set(state["source"]["alias_to_id"].values())
        if final_catalog is None
        else {
            str(entry["candidate_id"])
            for entry in require_list(
                final_catalog.get("included_delta_candidates"),
                "final_catalog.included_delta_candidates",
            )
        }
    )
    if new_candidates != expected_new_candidates or old_candidates.intersection(
        new_candidates
    ):
        raise DeltaLedgerError(
            f"{sample_id}: delta labels differ from the active disjoint catalog"
        )
    merged_judgment: dict[str, Any] = {
        tier: [*old_partition[tier], *list(delta_judgment.get(tier, []))]
        for tier in ALL_FINAL_TIERS
    }
    if merged_judgment["not_reviewed"]:
        raise DeltaLedgerError(f"{sample_id}: merged final remains incomplete")
    merged_judgment["none_acceptable"] = (
        not merged_judgment["preferred"] and not merged_judgment["acceptable"]
    )
    for tier in ALL_FINAL_TIERS:
        if merged_judgment[tier][: len(old_partition[tier])] != old_partition[tier]:
            raise DeltaLedgerError(f"{sample_id}: prior tier {tier} changed")
    expected_candidate_count = len(old_candidates) + len(expected_new_candidates)
    if (
        len({item for tier in ALL_FINAL_TIERS for item in merged_judgment[tier]})
        != expected_candidate_count
    ):
        raise DeltaLedgerError(
            f"{sample_id}: merged final does not partition the active catalog"
        )

    source_records = state["contract"]["source_records"]
    resolution_kind = str(delta["resolution_kind"])
    trigger_reasons = list(delta["trigger_reasons"])
    flags: list[str] = []
    if merged_judgment["none_acceptable"]:
        flags.extend(["none_acceptable_confirmed", "catalog_gap_confirmed"])
    if "primary_secondary_disagreement" in trigger_reasons:
        flags.append("disagreement_resolved")
    if any(
        reason.startswith("confidence_")
        or reason.startswith("role_confidence_")
        or reason == "role_unresolved"
        for reason in trigger_reasons
    ):
        flags.append("low_confidence_resolved")
    flags = list(dict.fromkeys(flags))
    all_candidates = sorted(old_candidates | new_candidates)
    evidence: dict[str, Any] | None = None
    if resolution_kind == "adjudicated":
        order_seed = stable_hash(
            "font-catalog-delta-final-order-v1",
            sample_id,
            str(delta["record_sha256"]),
            str(source_records["expanded_catalog_sha256"]),
        )
        evidence = {
            "review_card_sha256": nested(
                delta, "review_evidence", "review_card_sha256"
            ),
            "candidate_order_seed": order_seed,
            "candidate_order": deterministic_candidate_order(
                all_candidates, order_seed
            ),
            "font_names_visible": False,
            "model_suggestions_visible": False,
        }
    if final_catalog is not None:
        active_candidate_ids = set(
            _string_array(
                final_catalog.get("candidate_ids"), "final_catalog.candidate_ids"
            )
        )
        if active_candidate_ids != old_candidates | new_candidates:
            raise DeltaLedgerError(
                f"{sample_id}: final catalog candidate set differs from merged tiers"
            )
        catalog_version = require_text(
            final_catalog.get("catalog_version"), "final_catalog.catalog_version"
        )
        catalog_sha256 = require_sha(
            final_catalog.get("candidate_set_sha256"),
            "final_catalog.candidate_set_sha256",
        )
        final_hash = stable_hash(
            "font-catalog-pruned-final-v5",
            sample_id,
            str(prior["record_sha256"]),
            str(delta["record_sha256"]),
            str(final_catalog["record_sha256"]),
        )
    else:
        catalog_version = "font-face-manifest-v1"
        catalog_sha256 = source_records["expanded_catalog_sha256"]
        final_hash = stable_hash(
            "font-catalog-22-final-v1",
            sample_id,
            str(prior["record_sha256"]),
            str(delta["record_sha256"]),
        )
    final_id = f"fmfl-{final_hash[:32]}"
    prior["font_judgment"] = merged_judgment
    prior["role"] = copy.deepcopy(delta["role"])
    prior["final_id"] = final_id
    prior["resolution"] = {
        "kind": resolution_kind,
        "resolver": resolver,
        "resolved_at": max(
            str(row["reviewed_at"])
            for row in state["reviews"]
            if row.get("sample_id") == sample_id
        ),
        "source_label_ids": [
            nested(selection, "merge_provenance", "prior_final_record", "final_id"),
            delta["delta_label_id"],
        ],
        "catalog_version": catalog_version,
        "catalog_sha256": catalog_sha256,
        "renderer_hash": source_records["expanded_render_bank_sha256"],
        "confidence": delta["confidence"],
        "flags": flags,
        "notes": delta["rationale"],
        "adjudication_evidence": evidence,
        **(
            {
                "catalog_disposition_record_sha256": nested(
                    final_catalog, "catalog_disposition_record_sha256"
                ),
                "final_catalog_record_sha256": final_catalog["record_sha256"],
            }
            if final_catalog is not None
            else {}
        ),
    }
    prior["record_sha256"] = sha256_bytes(
        canonical_json_bytes(
            {key: value for key, value in prior.items() if key != "record_sha256"}
        )
    )
    return prior


def _write_once_or_same(path: Path, payload: bytes) -> None:
    if path.exists():
        if path.read_bytes() != payload:
            raise DeltaLedgerError(
                f"refusing to overwrite different finalized artifact: {path}"
            )
        return
    atomic_write(path, payload)


def _eligibility_exception_record(
    state: Mapping[str, Any],
    sample_id: str,
    stages: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    flagged = [
        row
        for stage, row in stages.items()
        if stage in {"primary", "secondary"}
        and row.get("eligibility") != "font_signal_present"
    ]
    if not flagged:
        raise DeltaLedgerError(f"{sample_id}: no eligibility exception to seal")
    primary_binding = state["bindings_by_sample"][sample_id]["primary"]
    outcomes = sorted({str(row["eligibility"]) for row in flagged})
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_font_signal_exception",
            "sample_id": sample_id,
            "work_id": primary_binding["work_id"],
            "source_page_sha256": primary_binding["source_page_sha256"],
            "status": "pending_expanded_human_font_signal_audit",
            "assignment_gate": {
                "candidate_tiering_allowed": False,
                "merge_allowed": False,
                "required_next_action": "rebuild_sealed_font_signal_audit",
            },
            "outcomes": outcomes,
            "source_review_ids": [row["review_id"] for row in flagged],
            "source_review_record_sha256s": [row["record_sha256"] for row in flagged],
            "evidence": [
                {
                    "stage": row["stage"],
                    "reviewer": row["reviewer"],
                    "rationale": row["rationale"],
                    "review_card_sha256": nested(row, "evidence", "review_card_sha256"),
                    "candidate_order_seed": nested(
                        row, "evidence", "candidate_order_seed"
                    ),
                }
                for row in flagged
            ],
            "source_bindings": {
                **_source_review_bindings(state),
                "selection_record_sha256": primary_binding["selection_record_sha256"],
                "prior_final_record_sha256": primary_binding[
                    "prior_final_record_sha256"
                ],
            },
        }
    )


def finalize_workspace(
    workspace: Path,
    *,
    resolver: str,
    calibration_report_path: Path | None = None,
) -> dict[str, Any]:
    resolver_id = require_id(resolver, "resolver")
    state = _load_workspace(workspace)
    validation = _validate_workspace_state(state, require_complete=False)
    by_sample, _ = _validate_review_records(state)
    root = state["root"]
    agreement_payload = canonical_json_bytes(
        seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_catalog_delta_agreement_report",
                "workspace_contract_record_sha256": state["contract"]["record_sha256"],
                "agreement": validation.get("agreement"),
            }
        ),
        pretty=True,
    )
    _write_once_or_same(root / "agreement-report.json", agreement_payload)

    if state["contract"].get("mode") == "calibration":
        if calibration_report_path is not None:
            raise DeltaLedgerError(
                "calibration finalize does not accept another gate report"
            )
        report = _build_calibration_report(state, validation)
        _write_once_or_same(
            root / "calibration-report.json",
            canonical_json_bytes(report, pretty=True),
        )
        if not report["all_gates_pass"]:
            raise CalibrationGateError(
                "fresh calibration failed; production merge remains locked"
            )
        return report

    if not validation.get("complete"):
        raise DeltaLedgerError(
            "production workspace is incomplete "
            f"(primary={validation.get('missing_primary_count')}, "
            f"secondary={validation.get('missing_secondary_count')}, "
            f"adjudication={validation.get('pending_adjudication_count')})"
        )

    if calibration_report_path is None:
        raise DeltaLedgerError(
            "production finalize requires --calibration-report from a fresh passing round"
        )
    calibration_report = read_json(calibration_report_path.resolve())
    _validate_calibration_report(calibration_report, state)
    current_training_quarantine_ids = _string_array(
        calibration_report.get("training_quarantine_sample_ids"),
        "calibration report.training_quarantine_sample_ids",
    )
    prior_training_quarantine_ids = list(
        state["prior_calibration"]["training_quarantine_sample_ids"]
    )
    training_quarantine_ids = sorted(
        set(current_training_quarantine_ids).union(prior_training_quarantine_ids)
    )
    non_train_quarantine_ids = sorted(
        sample_id
        for sample_id in training_quarantine_ids
        if state["source"]["split_by_sample"].get(sample_id) != "train"
    )
    if non_train_quarantine_ids:
        raise DeltaLedgerError(
            "training quarantine contains non-train or unknown samples: "
            f"{non_train_quarantine_ids[:5]}"
        )
    quarantine_payload = canonical_json_bytes(
        seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_catalog_delta_training_quarantine",
                "calibration_report_record_sha256": calibration_report["record_sha256"],
                "prior_calibration_subset_sha256s": [
                    binding["sha256"]
                    for binding in state["prior_calibration"]["bindings"]
                ],
                "reason": "fresh_and_prior_calibration_development_only",
                "test_split_used": False,
                "current_round_sample_count": len(current_training_quarantine_ids),
                "prior_round_sample_count": len(prior_training_quarantine_ids),
                "sample_count": len(training_quarantine_ids),
                "sample_ids": training_quarantine_ids,
            }
        ),
        pretty=True,
    )

    v5_required = state["contract"].get("v5_derivation_required") is True
    catalog_disposition: dict[str, Any] | None = None
    final_catalog: dict[str, Any] | None = None
    included_delta_aliases: set[str] | None = None
    if v5_required:
        catalog_disposition, provisional_catalog = _v5_catalog_artifacts(
            state=state,
            by_sample=by_sample,
            calibration_report=calibration_report,
        )
        exception_rows = [
            _eligibility_exception_record(state, sample_id, by_sample[sample_id])
            for sample_id in sorted(state["bindings_by_sample"])
            if _has_eligibility_exception(by_sample[sample_id])
        ]
        exceptions_payload = jsonl_bytes(exception_rows)
        disposition_payload = canonical_json_bytes(catalog_disposition, pretty=True)
        provisional_catalog_payload = canonical_json_bytes(
            provisional_catalog, pretty=True
        )
        provisional_report = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": V5_PROVISIONAL_REPORT_RECORD_TYPE,
                "workspace_contract_record_sha256": state["contract"]["record_sha256"],
                "calibration_report_record_sha256": calibration_report["record_sha256"],
                "catalog_disposition_record_sha256": catalog_disposition[
                    "record_sha256"
                ],
                "provisional_catalog_record_sha256": provisional_catalog[
                    "record_sha256"
                ],
                "release_state": "provisional_not_released",
                "final_release_allowed": False,
                "full22_utility_audit_required": True,
                "summary": {
                    "evaluated_delta_candidate_count": catalog_disposition[
                        "candidate_count"
                    ],
                    "active_delta_candidate_count": 0,
                    "safe_zero_candidate_count": catalog_disposition[
                        "safe_zero_candidate_count"
                    ],
                    "deployment_failure_candidate_count": catalog_disposition[
                        "deployment_failure_candidate_count"
                    ],
                    "pending_full22_utility_candidate_count": catalog_disposition[
                        "pending_full22_utility_candidate_count"
                    ],
                    "font_signal_exception_count": len(exception_rows),
                },
                "outputs": {
                    "catalog_disposition_sha256": sha256_bytes(disposition_payload),
                    "provisional_catalog_sha256": sha256_bytes(
                        provisional_catalog_payload
                    ),
                    "eligibility_exceptions_sha256": sha256_bytes(exceptions_payload),
                    "agreement_report_sha256": sha256_bytes(agreement_payload),
                    "training_quarantine_sha256": sha256_bytes(quarantine_payload),
                },
            }
        )
        _write_once_or_same(root / "catalog-disposition.json", disposition_payload)
        _write_once_or_same(
            root / "provisional-catalog.json", provisional_catalog_payload
        )
        _write_once_or_same(root / "training-quarantine.json", quarantine_payload)
        _write_once_or_same(root / "eligibility-exceptions.jsonl", exceptions_payload)
        _write_once_or_same(
            root / "provisional-report.json",
            canonical_json_bytes(provisional_report, pretty=True),
        )
        return provisional_report

    delta_rows: list[dict[str, Any]] = []
    final_rows: list[dict[str, Any]] = []
    exception_rows: list[dict[str, Any]] = []
    resolution_counts: Counter[str] = Counter()
    trigger_counts: Counter[str] = Counter()
    for sample_id in sorted(state["bindings_by_sample"]):
        stages = by_sample[sample_id]
        if _has_eligibility_exception(stages):
            exception_rows.append(
                _eligibility_exception_record(state, sample_id, stages)
            )
            continue
        secondary_required = "secondary" in state["bindings_by_sample"][sample_id]
        final_review, kind, reasons, source_reviews = _resolved_review(
            sample_id,
            stages,
            secondary_required=secondary_required,
        )
        delta = _delta_resolution(
            state=state,
            sample_id=sample_id,
            final_review=final_review,
            resolution_kind=kind,
            reasons=reasons,
            source_reviews=source_reviews,
            included_delta_aliases=included_delta_aliases,
            catalog_disposition_record_sha256=(
                str(catalog_disposition["record_sha256"])
                if catalog_disposition is not None
                else None
            ),
        )
        final = _merge_final_record(
            state=state,
            sample_id=sample_id,
            delta=delta,
            resolver=resolver_id,
            final_catalog=final_catalog,
        )
        delta_rows.append(delta)
        final_rows.append(final)
        resolution_counts[kind] += 1
        trigger_counts.update(reasons)

    delta_payload = jsonl_bytes(delta_rows)
    finals_payload = jsonl_bytes(final_rows)
    exceptions_payload = jsonl_bytes(exception_rows)
    catalog_disposition_payload = (
        canonical_json_bytes(catalog_disposition, pretty=True)
        if catalog_disposition is not None
        else None
    )
    final_catalog_payload = (
        canonical_json_bytes(final_catalog, pretty=True)
        if final_catalog is not None
        else None
    )
    final_labels_name = (
        "final-labels-catalog.jsonl"
        if final_catalog is not None
        else "final-labels-22.jsonl"
    )
    candidate_count = (
        int(final_catalog["candidate_count"]) if final_catalog is not None else 22
    )
    included_delta_candidate_count = (
        int(final_catalog["included_delta_candidate_count"])
        if final_catalog is not None
        else 7
    )
    merge_report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_merge_report",
            "workspace_contract_record_sha256": state["contract"]["record_sha256"],
            "calibration_report_record_sha256": calibration_report["record_sha256"],
            "source_records": copy.deepcopy(state["contract"]["source_records"]),
            "source_files": {
                name: binding["sha256"]
                for name, binding in state["contract"]["source_files"].items()
            },
            "card_manifest_sha256s": {
                stage: [
                    binding["sha256"]
                    for binding in state["contract"]["card_manifests"][stage]
                ]
                for stage in ("primary", "secondary")
            },
            **(
                {
                    "catalog_disposition_record_sha256": catalog_disposition[
                        "record_sha256"
                    ],
                    "final_catalog_record_sha256": final_catalog["record_sha256"],
                    "final_catalog_candidate_set_sha256": final_catalog[
                        "candidate_set_sha256"
                    ],
                }
                if catalog_disposition is not None and final_catalog is not None
                else {}
            ),
            "summary": {
                "merged_sample_count": len(final_rows),
                "candidate_count": candidate_count,
                "prior_candidate_count": 15,
                "delta_candidate_count": included_delta_candidate_count,
                **(
                    {
                        "evaluated_delta_candidate_count": int(
                            catalog_disposition["candidate_count"]
                        ),
                        "removed_delta_candidate_count": int(
                            final_catalog["removed_delta_candidate_count"]
                        ),
                        "production_safe_zero_candidate_count": int(
                            catalog_disposition["safe_zero_candidate_count"]
                        ),
                        "replacement_pending_candidate_count": int(
                            final_catalog["removed_delta_candidate_count"]
                        ),
                    }
                    if catalog_disposition is not None and final_catalog is not None
                    else {}
                ),
                "old_tier_mutation_count": 0,
                "successor_inheritance_count": 0,
                "source_font_signal_absent_and_recrop_excluded_count": len(
                    state["source"]["selection"]
                )
                - len(state["bindings_by_sample"]),
                "new_font_signal_exception_count": len(exception_rows),
                "calibration_training_quarantine_count": len(training_quarantine_ids),
                "current_calibration_training_quarantine_count": len(
                    current_training_quarantine_ids
                ),
                "prior_calibration_training_quarantine_count": len(
                    prior_training_quarantine_ids
                ),
                "total_font_signal_excluded_count": len(state["source"]["selection"])
                - len(final_rows),
                "resolution_counts": dict(sorted(resolution_counts.items())),
                "trigger_counts": dict(sorted(trigger_counts.items())),
            },
            "outputs": {
                "delta_resolutions_sha256": sha256_bytes(delta_payload),
                **(
                    {
                        "final_labels_catalog_sha256": sha256_bytes(finals_payload),
                        "catalog_disposition_sha256": sha256_bytes(
                            catalog_disposition_payload
                        ),
                        "final_catalog_sha256": sha256_bytes(final_catalog_payload),
                    }
                    if catalog_disposition_payload is not None
                    and final_catalog_payload is not None
                    else {"final_labels_22_sha256": sha256_bytes(finals_payload)}
                ),
                "eligibility_exceptions_sha256": sha256_bytes(exceptions_payload),
                "agreement_report_sha256": sha256_bytes(agreement_payload),
                "training_quarantine_sha256": sha256_bytes(quarantine_payload),
            },
        }
    )
    _write_once_or_same(root / "delta-resolutions.jsonl", delta_payload)
    _write_once_or_same(root / final_labels_name, finals_payload)
    if catalog_disposition_payload is not None and final_catalog_payload is not None:
        _write_once_or_same(
            root / "catalog-disposition.json", catalog_disposition_payload
        )
        _write_once_or_same(root / "final-catalog.json", final_catalog_payload)
    _write_once_or_same(root / "training-quarantine.json", quarantine_payload)
    _write_once_or_same(root / "eligibility-exceptions.jsonl", exceptions_payload)
    _write_once_or_same(
        root / "merge-report.json", canonical_json_bytes(merge_report, pretty=True)
    )
    return merge_report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Seal blind seven-font delta reviews and merge an evidence-pruned catalog."
        )
    )
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="initialize a sealed blind workspace")
    init.add_argument("--workspace", type=Path, required=True)
    init.add_argument("--rescue-inputs", type=Path, required=True)
    init.add_argument("--font-signal-audit", type=Path, required=True)
    init.add_argument(
        "--primary-card-manifest", type=Path, action="append", required=True
    )
    init.add_argument(
        "--secondary-card-manifest", type=Path, action="append", required=True
    )
    init.add_argument(
        "--primary-split-manifest", type=Path, action="append", default=[]
    )
    init.add_argument(
        "--secondary-split-manifest", type=Path, action="append", default=[]
    )
    init.add_argument("--rubric", type=Path, required=True)
    init.add_argument("--master-split-map", type=Path)
    init.add_argument(
        "--calibration-only-supplement",
        type=Path,
        help=(
            "bind a sealed answer-free v5 supplement; only its explicit samples "
            "receive cards while its wider closure remains quarantine-only"
        ),
    )
    init.add_argument(
        "--successor-authority-intake",
        type=Path,
        help=(
            "bind the answer-free double-clean successor intake that supplies "
            "fresh primary/secondary task definitions for a later v5 round"
        ),
    )
    init.add_argument("--mode", choices=("production", "calibration"), required=True)
    init.add_argument("--calibration-sample-ids", type=Path)
    init.add_argument("--calibration-round-id")
    init.add_argument("--calibration-count", type=int)
    init.add_argument("--calibration-seed")
    init.add_argument(
        "--calibration-profile",
        choices=(VARIANT_V4_CALIBRATION_PROFILE,),
        help=(
            "opt into the frozen v4 60-sample variant-first train-quarantine "
            "profile with exact strata and diversity caps"
        ),
    )
    init.add_argument(
        "--calibration-reservoir",
        choices=("val", "train_quarantine"),
        help=(
            "use val by default; train_quarantine permanently reserves selected "
            "train samples for development and excludes them from final training"
        ),
    )
    init.add_argument(
        "--calibration-successor-authority-only",
        action="store_true",
        help=(
            "start a later fresh 60-sample calibration round against the sealed "
            "successor master/registry/split authority; requires the predecessor "
            "supplement closure to be fully present in prior quarantine"
        ),
    )
    init.add_argument(
        "--prior-calibration-subset",
        type=Path,
        action="append",
        default=[],
        help=(
            "bind a prior development-only calibration subset; selections and "
            "pixel/lineage siblings cannot be reused, and prior train quarantine "
            "remains excluded from final training"
        ),
    )
    init.add_argument("--skip-card-files", action="store_true")

    submit = commands.add_parser("submit", help="append sealed blind decisions")
    submit.add_argument("--workspace", type=Path, required=True)
    submit.add_argument("--stage", choices=REVIEW_STAGES, required=True)
    submit.add_argument("--reviewer", required=True)
    submit.add_argument("--decisions", type=Path, required=True)
    submit.add_argument("--derivation-audit", type=Path)

    commit_source = commands.add_parser(
        "commit-source",
        help="append and freeze one candidate-free source-only A batch",
    )
    commit_source.add_argument("--workspace", type=Path, required=True)
    commit_source.add_argument("--stage", choices=REVIEW_STAGES, required=True)
    commit_source.add_argument("--reviewer", required=True)
    commit_source.add_argument("--source-annotations", type=Path, required=True)

    release = commands.add_parser(
        "release-candidates",
        help="release candidate B only for a previously committed A batch",
    )
    release.add_argument("--workspace", type=Path, required=True)
    release.add_argument("--source-commit-id", required=True)
    release.add_argument(
        "--candidate-split-manifest", type=Path, action="append", required=True
    )

    validate = commands.add_parser("validate", help="validate all ledger invariants")
    validate.add_argument("--workspace", type=Path, required=True)
    validate.add_argument("--require-complete", action="store_true")
    validate.add_argument("--output", type=Path)

    finalize = commands.add_parser(
        "finalize",
        help="emit a calibration gate or merge an evidence-pruned final catalog",
    )
    finalize.add_argument("--workspace", type=Path, required=True)
    finalize.add_argument("--resolver", required=True)
    finalize.add_argument("--calibration-report", type=Path)
    return parser


def _emit(value: Mapping[str, Any], output: Path | None = None) -> None:
    payload = canonical_json_bytes(value, pretty=True)
    if output is None:
        sys.stdout.buffer.write(payload)
    else:
        atomic_write(output.resolve(), payload)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "init":
            report = initialize_workspace(
                workspace=args.workspace,
                rescue_inputs=args.rescue_inputs,
                font_signal_audit=args.font_signal_audit,
                primary_card_manifests=args.primary_card_manifest,
                secondary_card_manifests=args.secondary_card_manifest,
                primary_split_manifests=args.primary_split_manifest,
                secondary_split_manifests=args.secondary_split_manifest,
                rubric=args.rubric,
                mode=args.mode,
                master_split_map=args.master_split_map,
                calibration_sample_ids=args.calibration_sample_ids,
                calibration_round_id=args.calibration_round_id,
                calibration_count=args.calibration_count,
                calibration_seed=args.calibration_seed,
                calibration_reservoir=args.calibration_reservoir,
                calibration_profile=args.calibration_profile,
                calibration_successor_authority_only=(
                    args.calibration_successor_authority_only
                ),
                prior_calibration_subsets=args.prior_calibration_subset,
                calibration_only_supplement=args.calibration_only_supplement,
                successor_authority_intake=args.successor_authority_intake,
                verify_card_files=not args.skip_card_files,
            )
            _emit(report)
        elif args.command == "submit":
            created = submit_decisions(
                args.workspace.resolve(),
                stage=args.stage,
                reviewer=args.reviewer,
                decisions=read_jsonl(args.decisions.resolve()),
                derivation_audits=(
                    read_jsonl(args.derivation_audit.resolve())
                    if args.derivation_audit is not None
                    else None
                ),
            )
            _emit(
                {
                    "stage": args.stage,
                    "submitted": len(created),
                    "review_record_sha256s": [row["record_sha256"] for row in created],
                    "status": "accepted",
                }
            )
        elif args.command == "commit-source":
            commit = commit_source_annotations(
                args.workspace.resolve(),
                stage=args.stage,
                reviewer=args.reviewer,
                source_annotations=read_jsonl(args.source_annotations.resolve()),
            )
            _emit(commit)
        elif args.command == "release-candidates":
            release = release_candidate_batch(
                args.workspace.resolve(),
                source_commit_id=args.source_commit_id,
                candidate_split_manifests=args.candidate_split_manifest,
            )
            _emit(release)
        elif args.command == "validate":
            report = validate_workspace(
                args.workspace.resolve(), require_complete=args.require_complete
            )
            _emit(report, args.output)
        elif args.command == "finalize":
            report = finalize_workspace(
                args.workspace.resolve(),
                resolver=args.resolver,
                calibration_report_path=args.calibration_report,
            )
            _emit(report)
        else:  # pragma: no cover - argparse makes this unreachable.
            raise DeltaLedgerError(f"unsupported command: {args.command}")
        return 0
    except CalibrationGateError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except (DeltaLedgerError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
