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
``submit``
    Append sealed primary, secondary, or adjudication decisions atomically.
``validate``
    Recheck source files, blindness, reviewer independence, and completeness.
``finalize``
    Emit either a fresh calibration report or resolved 22-candidate labels.

Reviewer decision files never contain font IDs or names.  Candidate identity
is revealed only inside ``finalize`` after every required human decision has
been resolved.
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
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Iterable, Iterator, Mapping, Sequence


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


class DeltaLedgerError(ValueError):
    """Raised when an artifact violates a frozen delta-review contract."""


class CalibrationGateError(DeltaLedgerError):
    """Raised after a calibration report is written but fails frozen gates."""


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
        split_by_sample[sample_id] = next(iter(splits))

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
        "audit_by_sample": audit_by_sample,
        "assignments": assignments,
        "stages_by_sample": stages_by_sample,
        "alias_to_id": alias_to_id,
        "identity_tokens": identity_tokens,
        "old_candidates": old_candidate_set,
        "file_bindings": {name: _file_binding(path) for name, path in paths.items()},
    }


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
    if stripped.startswith("["):
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise DeltaLedgerError(
                f"invalid calibration sample ID JSON: {error}"
            ) from error
        ids = [
            require_id(item, f"calibration sample IDs[{index}]")
            for index, item in enumerate(require_list(value, "calibration sample IDs"))
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
            quarantine_unknown = sorted(set(quarantine_ids) - set(source["master"]))
            if quarantine_unknown:
                raise DeltaLedgerError(
                    f"{location} quarantine references samples outside the source master: {quarantine_unknown[:5]}"
                )
            non_train = sorted(
                sample_id
                for sample_id in quarantine_ids
                if source["split_by_sample"].get(sample_id) != "train"
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


def _public_task(
    assignment: Mapping[str, Any], card: Mapping[str, Any]
) -> dict[str, Any]:
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
    rubric: Path,
    mode: str,
    calibration_sample_ids: Path | None = None,
    calibration_round_id: str | None = None,
    calibration_count: int | None = None,
    calibration_seed: str | None = None,
    calibration_reservoir: str | None = None,
    calibration_profile: str | None = None,
    prior_calibration_subsets: Sequence[Path] = (),
    verify_card_files: bool = True,
) -> dict[str, Any]:
    if mode not in {"production", "calibration"}:
        raise DeltaLedgerError("mode must be production or calibration")
    target = workspace.resolve()
    if target.exists() and any(target.iterdir()):
        raise DeltaLedgerError(f"workspace must be new and empty: {target}")
    if not rubric.is_file():
        raise DeltaLedgerError(f"review rubric is missing: {rubric}")

    source = _validate_source_inputs(rescue_inputs, font_signal_audit)
    prior_calibration = _load_prior_calibration_subsets(
        prior_calibration_subsets, source=source
    )
    prior_excluded_ids = set(prior_calibration["excluded_sample_ids"])
    prior_training_quarantine_ids = list(
        prior_calibration["training_quarantine_sample_ids"]
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

    all_ids = set(source["inventory"])
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
        training_quarantine_ids = (
            _calibration_training_quarantine(source, selected_ids)
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
        selected_ids = all_ids
        calibration_order = []
        selection_method = None
        reservoir = None
        calibration_source_split = None
        training_quarantine_required = False
        training_quarantine_ids = []
        selection_audit = None
        selection_profile_contract = None

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
    for assignment in selected_assignments:
        cards = primary_cards if assignment["stage"] == "primary" else secondary_cards
        card = cards.get(str(assignment["assignment_id"]))
        if card is None:
            missing_cards.append(str(assignment["assignment_id"]))
            continue
        selection = source["selection"][assignment["sample_id"]]
        binding = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_catalog_delta_private_binding",
                "visibility": "private_reveal_mapping_merge_only",
                "sample_id": assignment["sample_id"],
                "work_id": assignment["work_id"],
                "source_page_sha256": assignment["source_page_sha256"],
                "assignment": copy.deepcopy(dict(assignment)),
                "card": copy.deepcopy(card),
                "alias_to_candidate_id": {
                    alias: source["alias_to_id"][alias]
                    for alias in assignment["blind_alias_order"]
                },
                "selection_record_sha256": selection["record_sha256"],
                "prior_final_record_sha256": nested(
                    selection, "merge_provenance", "prior_final_record_sha256"
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
            "source_records": {
                "rescue_report_record_sha256": source["source_report_record_sha256"],
                "font_signal_audit_report_record_sha256": source[
                    "audit_report_record_sha256"
                ],
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
            },
            "rubric": rubric_binding,
            "card_manifests": {
                "primary": primary_manifest_bindings,
                "secondary": secondary_manifest_bindings,
            },
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
    atomic_write(target / "blind-tasks.jsonl", tasks_payload)
    atomic_write(target / "blind-tasks-primary.jsonl", primary_tasks_payload)
    atomic_write(target / "blind-tasks-secondary.jsonl", secondary_tasks_payload)
    atomic_write(target / "reviews.jsonl", b"")
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
    if verify_sources:
        for name, binding_value in source_files.items():
            _validate_file_binding(
                require_mapping(binding_value, f"contract.source_files.{name}"),
                f"contract.source_files.{name}",
            )
        rubric_path = _validate_file_binding(
            require_mapping(contract.get("rubric"), "contract.rubric"),
            "contract.rubric",
        )
        if rubric_path.name not in {
            "font-matching-v2-review-rubric.md",
            "font-matching-v2-review-rubric-v3.md",
            "font-matching-v2-review-rubric-v4.md",
        }:
            raise DeltaLedgerError("workspace is not bound to the v2 review rubric")
        for stage in ("primary", "secondary"):
            manifests = require_list(
                nested(contract, "card_manifests", stage),
                f"contract.card_manifests.{stage}",
            )
            for index, value in enumerate(manifests):
                _validate_file_binding(
                    require_mapping(value, f"contract.card_manifests.{stage}[{index}]"),
                    f"contract.card_manifests.{stage}[{index}]",
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
    for name, expected in source["file_bindings"].items():
        if (
            dict(
                require_mapping(source_files.get(name), f"contract.source_files.{name}")
            )
            != expected
        ):
            raise DeltaLedgerError(f"workspace source binding differs for {name}")
    source_records = require_mapping(
        contract.get("source_records"), "contract.source_records"
    )
    expected_source_records = {
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
    if dict(source_records) != expected_source_records:
        raise DeltaLedgerError("workspace source record hashes changed")

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
    prior_calibration = _load_prior_calibration_subsets(
        prior_calibration_paths, source=source
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
        if assignment_id in by_assignment or stage in bindings_by_sample[sample_id]:
            raise DeltaLedgerError("workspace private bindings contain duplicates")
        source_assignment = source["assignments"].get(assignment_id)
        if source_assignment is None or dict(assignment) != dict(source_assignment):
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
        alias_map = require_mapping(
            binding.get("alias_to_candidate_id"),
            f"{assignment_id}.alias_to_candidate_id",
        )
        expected_alias_map = {
            alias: source["alias_to_id"][alias]
            for alias in assignment["blind_alias_order"]
        }
        if dict(alias_map) != expected_alias_map:
            raise DeltaLedgerError(f"{assignment_id}: private reveal map changed")
        selection = source["selection"][sample_id]
        if binding.get("selection_record_sha256") != selection.get(
            "record_sha256"
        ) or binding.get("prior_final_record_sha256") != nested(
            selection, "merge_provenance", "prior_final_record_sha256"
        ):
            raise DeltaLedgerError(f"{assignment_id}: merge source binding changed")
        by_assignment[assignment_id] = binding
        bindings_by_sample[sample_id][stage] = binding

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
        task_by_assignment[assignment_id] = task
    if set(task_by_assignment) != set(by_assignment):
        raise DeltaLedgerError("blind task coverage differs from private bindings")
    sample_ids = set(bindings_by_sample)
    if sha256_bytes(canonical_json_bytes(sorted(sample_ids))) != contract.get(
        "selected_sample_ids_sha256"
    ) or len(sample_ids) != contract.get("selected_sample_count"):
        raise DeltaLedgerError("workspace selected sample inventory changed")
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
            _calibration_training_quarantine(source, sample_ids)
            if quarantine_required
            else []
        )
        if quarantine_ids != expected_quarantine:
            raise DeltaLedgerError("calibration quarantine closure changed")
    elif calibration_ids or calibration_subset.get("development_only") is not False:
        raise DeltaLedgerError("production workspace contains a calibration subset")

    reviews = read_jsonl(reviews_path, missing_ok=True)
    return {
        "root": root,
        "contract": contract,
        "source": source,
        "bindings": bindings,
        "by_assignment": by_assignment,
        "bindings_by_sample": bindings_by_sample,
        "tasks": tasks,
        "task_by_assignment": task_by_assignment,
        "prior_calibration": prior_calibration,
        "reviews": reviews,
        "reviews_path": reviews_path,
    }


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
) -> dict[str, Any]:
    require_exact_keys(decision, DECISION_KEYS, location)
    _decision_identity_leak(decision, state, location)
    assignment = require_mapping(
        binding.get("assignment"), f"{location}.binding.assignment"
    )
    card = require_mapping(binding.get("card"), f"{location}.binding.card")
    expected = {
        "assignment_id": assignment.get("assignment_id"),
        "sample_id": assignment.get("sample_id"),
        "review_card_sha256": card.get("review_card_sha256"),
        "candidate_order_seed": assignment.get("candidate_order_seed"),
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
        aliases = set(assignment.get("blind_alias_order", []))
        partition = _validate_partition(
            require_mapping(decision.get("font_judgment"), f"{location}.font_judgment"),
            aliases,
            f"{location}.font_judgment",
        )
        mandatory_unrenderable = set(card.get("mandatory_unrenderable", []))
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
    return {
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


def _build_review_record(
    *,
    state: Mapping[str, Any],
    binding: Mapping[str, Any],
    stage: str,
    reviewer: str,
    normalized: Mapping[str, Any],
    source_review_record_sha256s: Sequence[str],
) -> dict[str, Any]:
    assignment = require_mapping(binding.get("assignment"), "binding.assignment")
    card = require_mapping(binding.get("card"), "binding.card")
    decision_for_id = {
        "assignment_id": assignment["assignment_id"],
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
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_catalog_delta_blind_review",
            "review_id": review_id,
            "sample_id": assignment["sample_id"],
            "work_id": assignment["work_id"],
            "source_page_sha256": assignment["source_page_sha256"],
            "assignment_id": assignment["assignment_id"],
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
            "evidence": {
                "review_card_sha256": card["review_card_sha256"],
                "card_manifest_sha256": card["card_manifest_sha256"],
                "candidate_order_seed": assignment["candidate_order_seed"],
                "candidate_order_aliases": list(assignment["blind_alias_order"]),
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "prior_tiers_visible": False,
            },
            "source_bindings": {
                **_source_review_bindings(state),
                "selection_record_sha256": binding["selection_record_sha256"],
                "prior_final_record_sha256": binding["prior_final_record_sha256"],
            },
            "source_review_record_sha256s": list(source_review_record_sha256s),
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
        "sample_id": record.get("sample_id"),
        "review_card_sha256": nested(record, "evidence", "review_card_sha256"),
        "candidate_order_seed": nested(record, "evidence", "candidate_order_seed"),
        "role": nested(record, "role", "primary"),
        "role_confidence": nested(record, "role", "confidence"),
        "eligibility": record.get("eligibility"),
        "font_judgment": copy.deepcopy(record.get("font_judgment")),
        "confidence": record.get("confidence"),
        "rationale": record.get("rationale"),
    }


def _validate_review_records(
    state: Mapping[str, Any]
) -> tuple[dict[str, dict[str, Mapping[str, Any]]], dict[str, Mapping[str, Any]]]:
    reviews = require_list(state.get("reviews"), "state.reviews")
    by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    by_review_id: dict[str, Mapping[str, Any]] = {}
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
    return by_sample, by_review_id


def submit_decisions(
    workspace: Path,
    *,
    stage: str,
    reviewer: str,
    decisions: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if stage not in REVIEW_STAGES:
        raise DeltaLedgerError(f"unsupported stage: {stage}")
    reviewer_id = require_id(reviewer, "reviewer")
    if not decisions:
        raise DeltaLedgerError("decision file is empty")
    with workspace_lock(workspace.resolve()):
        state = _load_workspace(workspace)
        existing_by_sample, _ = _validate_review_records(state)
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

            normalized = _validate_decision(
                decision,
                binding=binding,
                state=state,
                location=f"decisions[{index}]",
            )
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


def validate_workspace(
    workspace: Path, *, require_complete: bool = False
) -> dict[str, Any]:
    state = _load_workspace(workspace)
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
    }
    return seal(report)


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
    if quarantine_required:
        expected_quarantine = _calibration_training_quarantine(
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
    for key in (
        "rescue_report_record_sha256",
        "font_signal_audit_report_record_sha256",
        "expanded_catalog_sha256",
        "expanded_render_bank_sha256",
        "master_manifest_sha256",
        "catalog_registry_sha256",
    ):
        if report_sources.get(key) != current_sources.get(key):
            raise DeltaLedgerError(f"calibration report binds another {key}")


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
    judgment_alias = require_mapping(
        final_review.get("font_judgment"), f"{sample_id}.font_judgment"
    )
    judgment_ids = {
        tier: [str(alias_to_id[alias]) for alias in judgment_alias[tier]]
        for tier in TIERS
    }
    judgment_ids["not_reviewed"] = []
    judgment_ids["none_acceptable"] = bool(judgment_alias["none_acceptable"])
    source_review_ids = [str(row["review_id"]) for row in source_reviews]
    if resolution_kind == "adjudicated":
        source_review_ids.append(str(final_review["review_id"]))
    delta_id = f"fmdl-{stable_hash('font-catalog-delta-resolution-v1', sample_id, final_review['record_sha256'])[:32]}"
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
            },
        }
    )


def _merge_final_record(
    *,
    state: Mapping[str, Any],
    sample_id: str,
    delta: Mapping[str, Any],
    resolver: str,
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
    if len(new_candidates) != 7 or old_candidates.intersection(new_candidates):
        raise DeltaLedgerError(
            f"{sample_id}: delta catalog is not disjoint seven-font set"
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
    if len({item for tier in ALL_FINAL_TIERS for item in merged_judgment[tier]}) != 22:
        raise DeltaLedgerError(
            f"{sample_id}: merged final does not partition 22 candidates"
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
    final_id = f"fmfl-{stable_hash('font-catalog-22-final-v1', sample_id, prior['record_sha256'], delta['record_sha256'])[:32]}"
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
        "catalog_version": "font-face-manifest-v1",
        "catalog_sha256": source_records["expanded_catalog_sha256"],
        "renderer_hash": source_records["expanded_render_bank_sha256"],
        "confidence": delta["confidence"],
        "flags": flags,
        "notes": delta["rationale"],
        "adjudication_evidence": evidence,
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
    validation = validate_workspace(workspace, require_complete=False)
    state = _load_workspace(workspace)
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
        )
        final = _merge_final_record(
            state=state,
            sample_id=sample_id,
            delta=delta,
            resolver=resolver_id,
        )
        delta_rows.append(delta)
        final_rows.append(final)
        resolution_counts[kind] += 1
        trigger_counts.update(reasons)

    delta_payload = jsonl_bytes(delta_rows)
    finals_payload = jsonl_bytes(final_rows)
    exceptions_payload = jsonl_bytes(exception_rows)
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
            "summary": {
                "merged_sample_count": len(final_rows),
                "candidate_count": 22,
                "prior_candidate_count": 15,
                "delta_candidate_count": 7,
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
                "final_labels_22_sha256": sha256_bytes(finals_payload),
                "eligibility_exceptions_sha256": sha256_bytes(exceptions_payload),
                "agreement_report_sha256": sha256_bytes(agreement_payload),
                "training_quarantine_sha256": sha256_bytes(quarantine_payload),
            },
        }
    )
    _write_once_or_same(root / "delta-resolutions.jsonl", delta_payload)
    _write_once_or_same(root / "final-labels-22.jsonl", finals_payload)
    _write_once_or_same(root / "training-quarantine.json", quarantine_payload)
    _write_once_or_same(root / "eligibility-exceptions.jsonl", exceptions_payload)
    _write_once_or_same(
        root / "merge-report.json", canonical_json_bytes(merge_report, pretty=True)
    )
    return merge_report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Seal blind seven-font delta reviews and merge 22-font finals."
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
        "--rubric",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "docs"
        / "font-matching-v2-review-rubric.md",
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

    validate = commands.add_parser("validate", help="validate all ledger invariants")
    validate.add_argument("--workspace", type=Path, required=True)
    validate.add_argument("--require-complete", action="store_true")
    validate.add_argument("--output", type=Path)

    finalize = commands.add_parser(
        "finalize", help="emit a calibration gate or merge resolved 22-font finals"
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
                rubric=args.rubric,
                mode=args.mode,
                calibration_sample_ids=args.calibration_sample_ids,
                calibration_round_id=args.calibration_round_id,
                calibration_count=args.calibration_count,
                calibration_seed=args.calibration_seed,
                calibration_reservoir=args.calibration_reservoir,
                calibration_profile=args.calibration_profile,
                prior_calibration_subsets=args.prior_calibration_subset,
                verify_card_files=not args.skip_card_files,
            )
            _emit(report)
        elif args.command == "submit":
            created = submit_decisions(
                args.workspace.resolve(),
                stage=args.stage,
                reviewer=args.reviewer,
                decisions=read_jsonl(args.decisions.resolve()),
            )
            _emit(
                {
                    "stage": args.stage,
                    "submitted": len(created),
                    "review_record_sha256s": [row["record_sha256"] for row in created],
                    "status": "accepted",
                }
            )
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
