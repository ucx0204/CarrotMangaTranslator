#!/usr/bin/env python3
"""Safely merge completed FontCLIP audit fragments into one manifest.

Every ``--shard`` is an ordered audit chain.  The first stage must point to a
completed visual-review ledger (``*.complete.json``), every recrop child must
be the exact input of the following stage, and the last stage must be a
``require_complete`` adjudication with no pending recrops.

Accepted records are copied from each stage's ``final_accepted_manifest.jsonl``.
Dataset asset paths are resolved against the stage input and its ancestors,
verified, copied or hard-linked into a standalone output, and rewritten
relative to that output.  Duplicate IDs, lineage roots, crop hashes, asset
paths, or source-page crop boxes are fatal instead of being silently
deduplicated.

Partial shard sets are accepted only for ``--dry-run`` together with
``--allow-partial-shards``.  A real output therefore cannot accidentally omit
unfinished shards.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

try:
    from PIL import Image, UnidentifiedImageError
except ImportError as error:  # pragma: no cover - environment setup failure
    print(
        "merge_fontclip_accepted_shards.py requires Pillow.",
        file=sys.stderr,
    )
    raise SystemExit(2) from error


SCHEMA_VERSION = 1
AUDIT_SCHEMA_VERSION = 1
AUDIT_MARKER_NAME = ".fontclip-audit"
AUDIT_MARKER_CONTENT = "manga-translator-fontclip-audit:v1\n"
MERGE_MARKER_NAME = ".fontclip-accepted-merge"
MERGE_MARKER_CONTENT = "manga-translator-fontclip-accepted-merge:v1\n"
COMPLETION_MARKER_TYPE = "fontclip_completed_review_ledger"
VALID_DECISIONS = frozenset({"pass", "reject", "recrop"})
SHARD_NAME_RE = re.compile(r"^shard-(\d{3})$")
SHARD_TAG_RE = re.compile(r"^shard-(\d{3})-of-(\d{3})$")
HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

TOP_LEVEL_ASSET_FIELDS = {
    "image_path": None,
    "clip_image_path": None,
    "masked_context_path": "context",
    "context_224_path": "context_224",
    "glyph_224_path": "glyph_224",
    "glyph_rgba_path": "glyph_rgba",
    "glyph_mask_path": "mask",
}
NESTED_ASSET_PATHS = ("mask_paths", "final_image_paths")
MASK_PATH_TO_TOP_LEVEL = {
    "context": "masked_context_path",
    "context_224": "context_224_path",
    "glyph_224": "glyph_224_path",
    "glyph_rgba": "glyph_rgba_path",
    "mask": "glyph_mask_path",
}


class MergeValidationError(ValueError):
    """Raised when audit provenance or manifest content is unsafe to merge."""


@dataclass(frozen=True)
class DecisionRow:
    item_id: str
    decision: str
    source: Path
    line_number: int


@dataclass
class StageBundle:
    shard_name: str
    stage_index: int
    root: Path
    summary_path: Path
    summary: dict[str, Any]
    input_manifest: Path
    input_rows: list[dict[str, Any]]
    input_by_id: dict[str, dict[str, Any]]
    accepted_manifest: Path
    accepted_rows: list[dict[str, Any]]
    accepted_by_id: dict[str, dict[str, Any]]
    recrop_manifest: Path
    recrop_rows: list[dict[str, Any]]
    recrop_by_id: dict[str, dict[str, Any]]
    decision_paths: list[Path]
    decision_hashes: list[str]
    decisions: list[DecisionRow]
    decisions_by_id: dict[str, DecisionRow]


@dataclass(frozen=True)
class ShardBundle:
    name: str
    shard_index: int
    declared_shard_count: int
    primary_item_count: int
    primary_ledger_sha256: str
    stages: tuple[StageBundle, ...]
    accepted_records: int
    rejected_records: int


@dataclass
class AssetVerificationStats:
    references: int = 0
    unique_files: int = 0
    verified_hashes: int = 0
    identical_copies: int = 0
    source_pages: int = 0


@dataclass(frozen=True)
class PlannedAsset:
    source: Path
    destination_relative: str
    sha256: str


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _integer(value: Any, *, location: str) -> int:
    if isinstance(value, bool):
        raise MergeValidationError(f"{location}: expected an integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise MergeValidationError(f"{location}: expected an integer") from error
    if result < 0:
        raise MergeValidationError(f"{location}: expected a non-negative integer")
    return result


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


@lru_cache(maxsize=None)
def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


@lru_cache(maxsize=None)
def _crop_pixel_sha256(path: Path) -> tuple[str, tuple[int, int]]:
    try:
        with Image.open(path) as image:
            image.load()
            digest = hashlib.sha256()
            digest.update(image.mode.encode("ascii", "strict"))
            digest.update(b"\0")
            digest.update(str(image.size[0]).encode("ascii"))
            digest.update(b"x")
            digest.update(str(image.size[1]).encode("ascii"))
            digest.update(b"\0")
            digest.update(image.tobytes())
            return digest.hexdigest(), image.size
    except (OSError, UnidentifiedImageError) as error:
        raise MergeValidationError(f"cannot decode crop image {path}: {error}") from error


def _hash_id_list(ids: Iterable[str]) -> str:
    return _sha256_bytes("\n".join(ids).encode("utf-8"))


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as error:
        raise MergeValidationError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise MergeValidationError(f"{path}: expected a JSON object")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise MergeValidationError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, dict):
                raise MergeValidationError(
                    f"{path}:{line_number}: every JSONL row must be an object"
                )
            rows.append(value)
    return rows


def _rows_by_id(
    rows: Sequence[Mapping[str, Any]], *, location: Path
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for line_number, raw in enumerate(rows, 1):
        item_id = _string(raw.get("id"))
        if not item_id:
            raise MergeValidationError(f"{location}:{line_number}: id is missing")
        if item_id in result:
            raise MergeValidationError(
                f"{location}:{line_number}: duplicate id {item_id!r}"
            )
        result[item_id] = dict(raw)
    return result


def _resolve_recorded_path(
    raw_value: Any,
    *,
    relative_to: Path,
    allowed_root: Path,
    location: str,
) -> Path:
    value = _string(raw_value)
    if not value:
        raise MergeValidationError(f"{location}: path is missing")
    raw_path = Path(value)
    path = raw_path.resolve() if raw_path.is_absolute() else (relative_to / raw_path).resolve()
    if not _is_within(allowed_root, path):
        raise MergeValidationError(
            f"{location}: path escapes {allowed_root}: {path}"
        )
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def _resolve_stage_root(dataset_root: Path, raw_path: Path) -> Path:
    if raw_path.is_absolute():
        result = raw_path.resolve()
    else:
        dataset_candidate = (dataset_root / raw_path).resolve()
        cwd_candidate = raw_path.resolve()
        result = dataset_candidate if dataset_candidate.exists() else cwd_candidate
    audits_root = (dataset_root / "audits").resolve()
    if result == audits_root or not _is_within(audits_root, result):
        raise MergeValidationError(
            f"stage root must be below {audits_root}: {result}"
        )
    if not result.is_dir():
        raise FileNotFoundError(result)
    return result


def _read_decision_rows(path: Path) -> list[DecisionRow]:
    suffix = path.suffix.lower()
    raw_rows: list[tuple[int, Mapping[str, Any]]]
    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise MergeValidationError(f"{path}: CSV header is missing")
            raw_rows = [
                (line_number, dict(row))
                for line_number, row in enumerate(reader, 2)
            ]
    elif suffix in {".jsonl", ".ndjson"}:
        raw_rows = [
            (line_number, row)
            for line_number, row in enumerate(_read_jsonl(path), 1)
        ]
    else:
        raise MergeValidationError(
            f"{path}: decision ledger must be CSV or JSONL"
        )

    result: list[DecisionRow] = []
    for line_number, row in raw_rows:
        item_id = _string(row.get("id"))
        decision = _string(row.get("decision")).lower()
        if not item_id:
            raise MergeValidationError(f"{path}:{line_number}: id is missing")
        if decision not in VALID_DECISIONS:
            raise MergeValidationError(
                f"{path}:{line_number}: invalid decision {decision!r}"
            )
        result.append(DecisionRow(item_id, decision, path, line_number))
    return result


def _decision_map(rows: Sequence[DecisionRow]) -> dict[str, DecisionRow]:
    result: dict[str, DecisionRow] = {}
    for row in rows:
        previous = result.get(row.item_id)
        if previous is not None:
            raise MergeValidationError(
                f"duplicate decision for {row.item_id!r}: "
                f"{previous.source}:{previous.line_number} and "
                f"{row.source}:{row.line_number}"
            )
        result[row.item_id] = row
    return result


def _summary_output_path(
    stage_root: Path, summary: Mapping[str, Any], key: str, expected_name: str
) -> Path:
    value = _string(summary.get(key))
    if value != expected_name:
        raise MergeValidationError(
            f"{stage_root / 'audit_summary.json'}: {key} must be "
            f"{expected_name!r}, got {value!r}"
        )
    result = (stage_root / value).resolve()
    if result.parent != stage_root:
        raise MergeValidationError(f"{key} escaped stage root: {result}")
    return result


def _load_stage(
    shard_name: str,
    stage_index: int,
    stage_root: Path,
    *,
    dataset_root: Path,
) -> StageBundle:
    marker = stage_root / AUDIT_MARKER_NAME
    if (
        not marker.is_file()
        or marker.read_text(encoding="utf-8") != AUDIT_MARKER_CONTENT
    ):
        raise MergeValidationError(
            f"{stage_root}: missing exact {AUDIT_MARKER_NAME} ownership marker"
        )

    summary_path = stage_root / "audit_summary.json"
    summary = _read_json(summary_path)
    if _integer(
        summary.get("audit_schema_version"),
        location=f"{summary_path}:audit_schema_version",
    ) != AUDIT_SCHEMA_VERSION:
        raise MergeValidationError(
            f"{summary_path}: unsupported audit schema version"
        )
    if summary.get("dry_run") is not False:
        raise MergeValidationError(
            f"{summary_path}: dry-run adjudication cannot be merged"
        )
    recorded_output = Path(_string(summary.get("output_root"))).resolve()
    if recorded_output != stage_root:
        raise MergeValidationError(
            f"{summary_path}: output_root {recorded_output} != {stage_root}"
        )

    input_values = summary.get("input_manifests")
    if not isinstance(input_values, list) or len(input_values) != 1:
        raise MergeValidationError(
            f"{summary_path}: exactly one input manifest is required"
        )
    input_manifest = _resolve_recorded_path(
        input_values[0],
        relative_to=stage_root,
        allowed_root=dataset_root,
        location=f"{summary_path}:input_manifests[0]",
    )
    input_rows = _read_jsonl(input_manifest)
    input_by_id = _rows_by_id(input_rows, location=input_manifest)
    if _integer(
        summary.get("input_records"), location=f"{summary_path}:input_records"
    ) != len(input_rows):
        raise MergeValidationError(
            f"{summary_path}: input_records does not match {input_manifest}"
        )

    accepted_manifest = _summary_output_path(
        stage_root, summary, "final_manifest", "final_accepted_manifest.jsonl"
    )
    accepted_rows = _read_jsonl(accepted_manifest)
    accepted_by_id = _rows_by_id(accepted_rows, location=accepted_manifest)
    if _integer(
        summary.get("accepted_records"),
        location=f"{summary_path}:accepted_records",
    ) != len(accepted_rows):
        raise MergeValidationError(
            f"{summary_path}: accepted_records does not match fragment rows"
        )

    recrop_manifest = _summary_output_path(
        stage_root,
        summary,
        "recrop_recheck_manifest",
        "recrop_recheck_manifest.jsonl",
    )
    recrop_rows = _read_jsonl(recrop_manifest)
    recrop_by_id = _rows_by_id(recrop_rows, location=recrop_manifest)
    generated_recrops = _integer(
        summary.get("generated_recrops"),
        location=f"{summary_path}:generated_recrops",
    )
    if generated_recrops != len(recrop_rows):
        raise MergeValidationError(
            f"{summary_path}: generated_recrops does not match recrop manifest"
        )

    ledger_entries = summary.get("decision_ledgers")
    if not isinstance(ledger_entries, list) or not ledger_entries:
        raise MergeValidationError(f"{summary_path}: decision_ledgers is empty")
    decision_paths: list[Path] = []
    decision_hashes: list[str] = []
    decisions: list[DecisionRow] = []
    for entry_index, entry in enumerate(ledger_entries):
        if not isinstance(entry, Mapping):
            raise MergeValidationError(
                f"{summary_path}:decision_ledgers[{entry_index}] must be an object"
            )
        ledger_path = _resolve_recorded_path(
            entry.get("path"),
            relative_to=stage_root,
            allowed_root=dataset_root,
            location=f"{summary_path}:decision_ledgers[{entry_index}].path",
        )
        expected_sha = _string(entry.get("sha256")).lower()
        if not HEX_SHA256_RE.fullmatch(expected_sha):
            raise MergeValidationError(
                f"{summary_path}: invalid ledger sha256 for {ledger_path}"
            )
        actual_sha = _sha256_file(ledger_path)
        if actual_sha != expected_sha:
            raise MergeValidationError(
                f"{summary_path}: ledger hash mismatch for {ledger_path}"
            )
        decision_paths.append(ledger_path)
        decision_hashes.append(expected_sha)
        decisions.extend(_read_decision_rows(ledger_path))
    decisions_by_id = _decision_map(decisions)
    if _integer(
        summary.get("decisions"), location=f"{summary_path}:decisions"
    ) != len(decisions):
        raise MergeValidationError(
            f"{summary_path}: decisions does not match decision ledgers"
        )

    input_ids = set(input_by_id)
    decision_ids = set(decisions_by_id)
    unknown = sorted(decision_ids - input_ids)
    if unknown:
        raise MergeValidationError(
            f"{summary_path}: decisions reference IDs outside input manifest: "
            f"{unknown[:3]}"
        )
    expected_pending = len(input_ids - decision_ids)
    pending_original = _integer(
        summary.get("pending_original_decisions"),
        location=f"{summary_path}:pending_original_decisions",
    )
    if pending_original != expected_pending:
        raise MergeValidationError(
            f"{summary_path}: pending_original_decisions={pending_original}, "
            f"expected {expected_pending}"
        )

    pass_ids = {
        item_id
        for item_id, decision in decisions_by_id.items()
        if decision.decision == "pass"
    }
    if set(accepted_by_id) != pass_ids:
        missing = sorted(pass_ids - set(accepted_by_id))
        extra = sorted(set(accepted_by_id) - pass_ids)
        raise MergeValidationError(
            f"{summary_path}: accepted fragment does not equal pass decisions; "
            f"missing={missing[:3]} extra={extra[:3]}"
        )

    recrop_parent_ids = {
        item_id
        for item_id, decision in decisions_by_id.items()
        if decision.decision == "recrop"
    }
    if generated_recrops != len(recrop_parent_ids):
        raise MergeValidationError(
            f"{summary_path}: one generated child is required per recrop decision"
        )
    observed_parents: list[str] = []
    for child_id, child in recrop_by_id.items():
        manual = child.get("manual_recrop")
        parent_id = (
            _string(manual.get("supersedes_id"))
            if isinstance(manual, Mapping)
            else ""
        )
        if not parent_id:
            raise MergeValidationError(
                f"{recrop_manifest}: {child_id} has no manual_recrop.supersedes_id"
            )
        observed_parents.append(parent_id)
    if len(observed_parents) != len(set(observed_parents)):
        raise MergeValidationError(
            f"{recrop_manifest}: multiple children supersede the same parent"
        )
    if set(observed_parents) != recrop_parent_ids:
        raise MergeValidationError(
            f"{recrop_manifest}: recrop child-parent mapping disagrees with ledger"
        )

    expected_pending_recrops = len(set(recrop_by_id) - decision_ids)
    pending_recrops = _integer(
        summary.get("pending_recrop_decisions"),
        location=f"{summary_path}:pending_recrop_decisions",
    )
    if pending_recrops != expected_pending_recrops:
        raise MergeValidationError(
            f"{summary_path}: pending_recrop_decisions={pending_recrops}, "
            f"expected {expected_pending_recrops}"
        )
    expected_pending_masks = sum(
        row.get("needs_mask_enrichment") is True for row in recrop_rows
    )
    pending_masks = _integer(
        summary.get("pending_mask_enrichment"),
        location=f"{summary_path}:pending_mask_enrichment",
    )
    if pending_masks != expected_pending_masks:
        raise MergeValidationError(
            f"{summary_path}: pending_mask_enrichment={pending_masks}, "
            f"expected {expected_pending_masks}"
        )

    ledger_hashes = set(decision_hashes)
    for item_id, row in accepted_by_id.items():
        history = row.get("audit_history")
        has_matching_pass = isinstance(history, list) and any(
            isinstance(event, Mapping)
            and event.get("kind") == "manual_visual_audit"
            and event.get("decision") == "pass"
            and _string(event.get("item_id")) == item_id
            and _string(event.get("decision_ledger_sha256")).lower()
            in ledger_hashes
            for event in history
        )
        if not has_matching_pass:
            raise MergeValidationError(
                f"{accepted_manifest}: {item_id} lacks its signed pass audit event"
            )

    return StageBundle(
        shard_name=shard_name,
        stage_index=stage_index,
        root=stage_root,
        summary_path=summary_path,
        summary=summary,
        input_manifest=input_manifest,
        input_rows=input_rows,
        input_by_id=input_by_id,
        accepted_manifest=accepted_manifest,
        accepted_rows=accepted_rows,
        accepted_by_id=accepted_by_id,
        recrop_manifest=recrop_manifest,
        recrop_rows=recrop_rows,
        recrop_by_id=recrop_by_id,
        decision_paths=decision_paths,
        decision_hashes=decision_hashes,
        decisions=decisions,
        decisions_by_id=decisions_by_id,
    )


def _completion_marker_for_ledger(ledger: Path) -> Path:
    return ledger.with_suffix(ledger.suffix + ".complete.json")


def _validate_completion_marker(
    stage: StageBundle,
    *,
    expected_shard_tag: str | None,
) -> tuple[dict[str, Any], str]:
    if len(stage.decision_paths) != 1:
        raise MergeValidationError(
            f"{stage.summary_path}: a completed stage requires exactly one ledger"
        )
    ledger = stage.decision_paths[0]
    marker_path = _completion_marker_for_ledger(ledger)
    marker = _read_json(marker_path)
    if (
        marker.get("marker_type") != COMPLETION_MARKER_TYPE
        or marker.get("completed") is not True
        or _integer(
            marker.get("schema_version"),
            location=f"{marker_path}:schema_version",
        )
        != 1
    ):
        raise MergeValidationError(
            f"{marker_path}: invalid completed review ledger marker"
        )
    if _string(marker.get("ledger")) != ledger.name:
        raise MergeValidationError(f"{marker_path}: ledger filename mismatch")
    ledger_sha = _sha256_file(ledger)
    if _string(marker.get("ledger_sha256")).lower() != ledger_sha:
        raise MergeValidationError(f"{marker_path}: ledger SHA-256 mismatch")
    item_count = _integer(
        marker.get("item_count"), location=f"{marker_path}:item_count"
    )
    if item_count != len(stage.decisions):
        raise MergeValidationError(
            f"{marker_path}: item_count does not match stage decisions"
        )
    ordered_hash = _hash_id_list(row.item_id for row in stage.decisions)
    if _string(marker.get("ordered_ids_sha256")).lower() != ordered_hash:
        raise MergeValidationError(
            f"{marker_path}: ordered decision IDs do not match marker"
        )
    if expected_shard_tag is not None:
        actual_tag = _string(marker.get("shard_tag"))
        if actual_tag != expected_shard_tag:
            raise MergeValidationError(
                f"{marker_path}: shard_tag must be {expected_shard_tag!r}, "
                f"got {actual_tag!r}"
            )
    return marker, ledger_sha


def _validate_primary_completion(
    shard_name: str, stage: StageBundle
) -> tuple[int, int, str]:
    marker, ledger_sha = _validate_completion_marker(
        stage, expected_shard_tag=None
    )
    marker_path = _completion_marker_for_ledger(stage.decision_paths[0])

    shard_tag = _string(marker.get("shard_tag"))
    match = SHARD_TAG_RE.fullmatch(shard_tag)
    if match is None:
        raise MergeValidationError(
            f"{marker_path}: primary shard_tag must be shard-NNN-of-NNN"
        )
    shard_index = int(match.group(1))
    declared_count = int(match.group(2))
    expected_match = SHARD_NAME_RE.fullmatch(shard_name)
    if expected_match is None or int(expected_match.group(1)) != shard_index:
        raise MergeValidationError(
            f"{marker_path}: {shard_tag} does not match group {shard_name}"
        )
    if declared_count < 1 or shard_index >= declared_count:
        raise MergeValidationError(f"{marker_path}: invalid shard range {shard_tag}")
    return shard_index, declared_count, ledger_sha


def _has_complete_mask_contract(record: Mapping[str, Any]) -> bool:
    paths = record.get("mask_paths")
    final_paths = record.get("final_image_paths")
    hashes = record.get("mask_asset_sha256")
    if (
        not isinstance(paths, Mapping)
        or not isinstance(final_paths, Mapping)
        or not isinstance(hashes, Mapping)
        or set(paths) != set(MASK_PATH_TO_TOP_LEVEL)
        or dict(paths) != dict(final_paths)
        or set(hashes) != set(MASK_PATH_TO_TOP_LEVEL)
    ):
        return False
    try:
        schema = int(record.get("mask_schema_version", 0))
    except (TypeError, ValueError):
        return False
    if schema < 2:
        return False
    return all(
        _string(record.get(top_field)) == _string(paths.get(kind))
        and HEX_SHA256_RE.fullmatch(_string(hashes.get(kind)).lower()) is not None
        for kind, top_field in MASK_PATH_TO_TOP_LEVEL.items()
    )


def _normalized_bbox(record: Mapping[str, Any], field: str) -> tuple[int, ...]:
    value = record.get(field)
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise MergeValidationError(
            f"{_string(record.get('id'))}: {field} must contain four coordinates"
        )
    try:
        return tuple(int(coordinate) for coordinate in value)
    except (TypeError, ValueError) as error:
        raise MergeValidationError(
            f"{_string(record.get('id'))}: {field} contains a non-integer"
        ) from error


def _recrop_lineage_edges(
    record: Mapping[str, Any],
) -> tuple[tuple[str, str, tuple[int, ...]], ...]:
    item_id = _string(record.get("id"))
    history = record.get("audit_history")
    if not isinstance(history, list):
        raise MergeValidationError(f"{item_id}: audit_history is missing")
    edges: list[tuple[str, str, tuple[int, ...]]] = []
    for event_index, event in enumerate(history):
        if not isinstance(event, Mapping):
            raise MergeValidationError(
                f"{item_id}: audit_history[{event_index}] is not an object"
            )
        if _string(event.get("kind")) != "manual_recrop_generated":
            continue
        parent = _string(event.get("supersedes_id"))
        child = _string(event.get("item_id"))
        raw_bbox = event.get("bbox_px")
        if (
            not parent
            or not child
            or not isinstance(raw_bbox, (list, tuple))
            or len(raw_bbox) != 4
        ):
            raise MergeValidationError(
                f"{item_id}: generated lineage event {event_index} is incomplete"
            )
        try:
            bbox = tuple(int(coordinate) for coordinate in raw_bbox)
        except (TypeError, ValueError) as error:
            raise MergeValidationError(
                f"{item_id}: generated lineage event {event_index} has "
                "a non-integer bbox"
            ) from error
        edges.append((parent, child, bbox))
    if not edges or edges[-1][1] != item_id:
        raise MergeValidationError(
            f"{item_id}: recrop lineage does not terminate at the record ID"
        )
    return tuple(edges)


def _validate_followup_input_identity(
    previous: StageBundle,
    following: StageBundle,
) -> None:
    """Prove that mask enrichment did not substitute a recrop child.

    Asset paths and mask metadata may legitimately change during enrichment.
    The crop content, source coordinates, and ordered supersession lineage may
    not.  In particular, a completion marker tagged ``all`` is accepted only
    after this exact parent-child inventory check and the full decision check
    in ``_validate_shard_chain``.
    """

    previous_ids = set(previous.recrop_by_id)
    following_ids = set(following.input_by_id)
    if following_ids != previous_ids:
        missing = sorted(previous_ids - following_ids)
        extra = sorted(following_ids - previous_ids)
        raise MergeValidationError(
            f"{following.input_manifest}: input IDs do not exactly equal "
            f"previous recrop children; missing={missing[:3]} extra={extra[:3]}"
        )

    for item_id in sorted(previous_ids):
        parent = previous.recrop_by_id[item_id]
        child = following.input_by_id[item_id]
        comparisons = {
            "crop_sha256": (
                _string(parent.get("crop_sha256")).lower(),
                _string(child.get("crop_sha256")).lower(),
            ),
            "crop_bbox_px": (
                _normalized_bbox(parent, "crop_bbox_px"),
                _normalized_bbox(child, "crop_bbox_px"),
            ),
            "bbox_px": (
                _normalized_bbox(parent, "bbox_px"),
                _normalized_bbox(child, "bbox_px"),
            ),
            "source_image_path": (
                _string(parent.get("source_image_path")).replace("\\", "/"),
                _string(child.get("source_image_path")).replace("\\", "/"),
            ),
        }
        comparisons["source_page_path"] = (
            (
                _string(parent.get("source_page_path"))
                or _string(parent.get("source_image_path"))
            ).replace("\\", "/"),
            (
                _string(child.get("source_page_path"))
                or _string(child.get("source_image_path"))
            ).replace("\\", "/"),
        )
        parent_manual = parent.get("manual_recrop")
        child_manual = child.get("manual_recrop")
        comparisons["manual_recrop.supersedes_id"] = (
            _string(parent_manual.get("supersedes_id"))
            if isinstance(parent_manual, Mapping)
            else "",
            _string(child_manual.get("supersedes_id"))
            if isinstance(child_manual, Mapping)
            else "",
        )
        comparisons["manual_recrop.source_image_path"] = (
            (
                _string(parent_manual.get("source_image_path"))
                if isinstance(parent_manual, Mapping)
                else ""
            )
            .replace("\\", "/")
            or _string(parent.get("source_image_path")).replace("\\", "/"),
            (
                _string(child_manual.get("source_image_path"))
                if isinstance(child_manual, Mapping)
                else ""
            )
            .replace("\\", "/")
            or _string(child.get("source_image_path")).replace("\\", "/"),
        )
        for field, (before, after) in comparisons.items():
            if not before or before != after:
                raise MergeValidationError(
                    f"{following.input_manifest}: {item_id} changed {field} "
                    "between recrop generation and follow-up QA"
                )
        if _recrop_lineage_edges(parent) != _recrop_lineage_edges(child):
            raise MergeValidationError(
                f"{following.input_manifest}: {item_id} changed its ordered "
                "supersedes lineage between recrop generation and follow-up QA"
            )


def _validate_shard_chain(
    shard_name: str,
    stage_roots: Sequence[Path],
    *,
    dataset_root: Path,
) -> ShardBundle:
    if not stage_roots:
        raise MergeValidationError(f"{shard_name}: at least one stage is required")
    stages = tuple(
        _load_stage(
            shard_name,
            stage_index,
            stage_root,
            dataset_root=dataset_root,
        )
        for stage_index, stage_root in enumerate(stage_roots)
    )
    shard_index, declared_count, primary_sha = _validate_primary_completion(
        shard_name, stages[0]
    )

    for stage_index, stage in enumerate(stages):
        input_ids = set(stage.input_by_id)
        decision_ids = set(stage.decisions_by_id)
        if stage_index > 0 and decision_ids != input_ids:
            missing = sorted(input_ids - decision_ids)
            extra = sorted(decision_ids - input_ids)
            raise MergeValidationError(
                f"{stage.summary_path}: recrop stage must decide every input; "
                f"missing={missing[:3]} extra={extra[:3]}"
            )
        if stage_index == 0 and len(decision_ids) != _integer(
            stage.summary.get("decisions"),
            location=f"{stage.summary_path}:decisions",
        ):
            raise MergeValidationError(
                f"{stage.summary_path}: primary decision count mismatch"
            )

        if stage_index + 1 < len(stages):
            next_stage = stages[stage_index + 1]
            child_ids = set(stage.recrop_by_id)
            if not child_ids:
                raise MergeValidationError(
                    f"{stage.summary_path}: chain continues without recrop children"
                )
            _validate_followup_input_identity(stage, next_stage)
            marker_path = _completion_marker_for_ledger(
                next_stage.decision_paths[0]
            )
            if marker_path.is_file():
                _validate_completion_marker(
                    next_stage, expected_shard_tag="all"
                )
            for item_id, row in next_stage.input_by_id.items():
                if not _has_complete_mask_contract(row):
                    raise MergeValidationError(
                        f"{next_stage.input_manifest}: {item_id} lacks a fresh "
                        "five-asset mask contract"
                    )
        else:
            terminal_fields = {
                "generated_recrops": 0,
                "recrop_rechecks": 0,
                "pending_original_decisions": 0,
                "pending_recrop_decisions": 0,
                "pending_mask_enrichment": 0,
            }
            if stage.summary.get("require_complete") is not True:
                raise MergeValidationError(
                    f"{stage.summary_path}: terminal stage must require completeness"
                )
            for key, expected in terminal_fields.items():
                actual = _integer(
                    stage.summary.get(key), location=f"{stage.summary_path}:{key}"
                )
                if actual != expected:
                    raise MergeValidationError(
                        f"{stage.summary_path}: terminal {key}={actual}, "
                        f"expected {expected}"
                    )
            if stage.recrop_rows:
                raise MergeValidationError(
                    f"{stage.recrop_manifest}: terminal recrop manifest is not empty"
                )

    accepted_count = sum(len(stage.accepted_rows) for stage in stages)
    rejected_count = sum(
        row.decision == "reject"
        for stage in stages
        for row in stage.decisions
    )
    primary_item_count = len(stages[0].decisions)
    if accepted_count + rejected_count != primary_item_count:
        raise MergeValidationError(
            f"{shard_name}: final accounting mismatch; accepted={accepted_count}, "
            f"rejected={rejected_count}, reviewed={primary_item_count}"
        )

    for stage in stages:
        for row in stage.accepted_rows:
            history = row.get("audit_history")
            if not isinstance(history, list) or not any(
                isinstance(event, Mapping)
                and _string(event.get("decision_ledger_sha256")).lower()
                == primary_sha
                for event in history
            ):
                raise MergeValidationError(
                    f"{stage.accepted_manifest}: {_string(row.get('id'))} does not "
                    f"descend from {shard_name}'s primary ledger"
                )

    return ShardBundle(
        name=shard_name,
        shard_index=shard_index,
        declared_shard_count=declared_count,
        primary_item_count=primary_item_count,
        primary_ledger_sha256=primary_sha,
        stages=stages,
        accepted_records=accepted_count,
        rejected_records=rejected_count,
    )


def _safe_relative_asset_path(raw_value: Any, *, location: str) -> PurePosixPath:
    value = _string(raw_value).replace("\\", "/")
    if not value:
        raise MergeValidationError(f"{location}: asset path is empty")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise MergeValidationError(f"{location}: unsafe asset path {value!r}")
    return path


@lru_cache(maxsize=None)
def _asset_bases_cached(
    input_parent: Path,
    stage_root: Path,
    dataset_root: Path,
) -> tuple[Path, ...]:
    result: list[Path] = []
    current = input_parent
    dataset = dataset_root
    while True:
        try:
            current.relative_to(dataset)
            within_dataset = True
        except ValueError:
            within_dataset = False
        if within_dataset and current not in result:
            result.append(current)
        if current == dataset:
            break
        parent = current.parent
        if parent == current:
            break
        try:
            parent.relative_to(dataset)
        except ValueError:
            break
        current = parent
    if stage_root not in result:
        result.append(stage_root)
    if dataset not in result:
        result.append(dataset)
    return tuple(result)


def _asset_bases(stage: StageBundle, dataset_root: Path) -> tuple[Path, ...]:
    return _asset_bases_cached(
        stage.input_manifest.parent.resolve(),
        stage.root.resolve(),
        dataset_root.resolve(),
    )


@lru_cache(maxsize=None)
def _asset_candidates_cached(
    relative_value: str,
    input_parent: Path,
    stage_root: Path,
    dataset_root: Path,
) -> tuple[Path, ...]:
    relative = PurePosixPath(relative_value)
    candidates: list[Path] = []
    for base in _asset_bases_cached(
        input_parent, stage_root, dataset_root
    ):
        candidate = (base / Path(*relative.parts)).resolve()
        try:
            candidate.relative_to(dataset_root)
        except ValueError:
            continue
        if candidate.is_file() and candidate not in candidates:
            candidates.append(candidate)
    return tuple(candidates)


def _asset_candidates(
    raw_value: Any,
    *,
    stage: StageBundle,
    dataset_root: Path,
    location: str,
) -> tuple[PurePosixPath, tuple[Path, ...]]:
    relative = _safe_relative_asset_path(raw_value, location=location)
    dataset = dataset_root.resolve()
    candidates = _asset_candidates_cached(
        relative.as_posix(),
        stage.input_manifest.parent.resolve(),
        stage.root.resolve(),
        dataset,
    )
    if not candidates:
        raise FileNotFoundError(
            f"{location}: asset does not exist under dataset root: {relative}"
        )
    return relative, candidates


def _resolve_asset(
    raw_value: Any,
    *,
    stage: StageBundle,
    dataset_root: Path,
    location: str,
    expected_sha256: str | None,
    stats: AssetVerificationStats,
) -> tuple[str, Path, str]:
    relative, candidates = _asset_candidates(
        raw_value,
        stage=stage,
        dataset_root=dataset_root,
        location=location,
    )

    hashes = {candidate: _sha256_file(candidate) for candidate in candidates}
    unique_hashes = set(hashes.values())
    if len(unique_hashes) > 1:
        raise MergeValidationError(
            f"{location}: relative path is ambiguous across stage ancestors: "
            f"{[str(path) for path in candidates]}"
        )
    if len(candidates) > 1:
        stats.identical_copies += len(candidates) - 1

    chosen = min(
        candidates,
        key=lambda path: (
            len(path.relative_to(dataset_root).parts),
            path.relative_to(dataset_root).as_posix(),
        ),
    )
    actual_sha = hashes[chosen]
    if expected_sha256 is not None:
        expected = expected_sha256.lower()
        if not HEX_SHA256_RE.fullmatch(expected):
            raise MergeValidationError(
                f"{location}: invalid expected SHA-256 {expected_sha256!r}"
            )
        if actual_sha != expected:
            raise MergeValidationError(
                f"{location}: SHA-256 mismatch for {chosen}; "
                f"expected {expected}, got {actual_sha}"
            )
        stats.verified_hashes += 1
    stats.references += 1
    canonical = chosen.relative_to(dataset_root).as_posix()
    return canonical, chosen, actual_sha


@lru_cache(maxsize=None)
def _source_page_cached(library_root: Path, relative_value: str) -> Path:
    source_path = (
        library_root / Path(*PurePosixPath(relative_value).parts)
    ).resolve()
    try:
        source_path.relative_to(library_root)
    except ValueError as error:
        raise MergeValidationError(
            f"source page escapes library root: {relative_value}"
        ) from error
    if not source_path.is_file():
        raise FileNotFoundError(
            f"source page is missing: {relative_value}"
        )
    return source_path


def _canonicalize_source_page(
    record: dict[str, Any],
    *,
    library_root: Path,
    location: str,
    stats: AssetVerificationStats,
) -> None:
    raw_source = _string(record.get("source_image_path")).replace("\\", "/")
    source_rel = _safe_relative_asset_path(
        raw_source, location=f"{location}:source_image_path"
    )
    source_path = _source_page_cached(
        library_root.resolve(), source_rel.as_posix()
    )
    record["source_image_path"] = source_rel.as_posix()
    if "source_page_path" in record:
        page_rel = _safe_relative_asset_path(
            record["source_page_path"], location=f"{location}:source_page_path"
        )
        if page_rel != source_rel:
            raise MergeValidationError(
                f"{location}: source_page_path disagrees with source_image_path"
            )
        record["source_page_path"] = source_rel.as_posix()
    if "source_page_absolute_path" in record:
        record["source_page_absolute_path"] = str(source_path)

    signature = record.get("source_page_content_signature")
    if isinstance(signature, dict):
        signature["path"] = str(source_path)
        expected = _string(signature.get("sha256")).lower()
        if expected and _sha256_file(source_path) != expected:
            raise MergeValidationError(
                f"{location}: source_page_content_signature SHA-256 mismatch"
            )
        if expected:
            stats.verified_hashes += 1
    expected_source_sha = _string(record.get("source_page_sha256")).lower()
    if expected_source_sha:
        if _sha256_file(source_path) != expected_source_sha:
            raise MergeValidationError(
                f"{location}: source_page_sha256 mismatch"
            )
        stats.verified_hashes += 1

    manual = record.get("manual_recrop")
    if isinstance(manual, dict) and "source_image_path" in manual:
        manual_source = _safe_relative_asset_path(
            manual["source_image_path"],
            location=f"{location}:manual_recrop.source_image_path",
        )
        if manual_source != source_rel:
            raise MergeValidationError(
                f"{location}: manual_recrop source page disagrees with record"
            )
        manual["source_image_path"] = source_rel.as_posix()
    stats.source_pages += 1


def _hydrate_mask_record(
    raw_record: Mapping[str, Any],
    *,
    root_masked_by_id: Mapping[str, Mapping[str, Any]],
    location: str,
) -> dict[str, Any]:
    record = copy.deepcopy(dict(raw_record))
    if isinstance(record.get("mask_paths"), Mapping):
        return record
    item_id = _string(record.get("id"))
    masked = root_masked_by_id.get(item_id)
    if masked is None:
        raise MergeValidationError(
            f"{location}: accepted row has no mask fields and id {item_id!r} "
            "is absent from the root masked manifest"
        )
    identity_fields = (
        "id",
        "image_path",
        "clip_image_path",
        "work_id",
        "chapter_id",
        "page_id",
        "split",
        "tier",
        "orientation",
        "bbox_px",
        "crop_bbox_px",
        "crop_sha256",
        "source_image_path",
    )
    for field in identity_fields:
        if record.get(field) != masked.get(field):
            raise MergeValidationError(
                f"{location}: root masked row disagrees on {field}"
            )
    for key, value in masked.items():
        if key not in record:
            record[key] = copy.deepcopy(value)
    if not isinstance(record.get("mask_paths"), Mapping):
        raise MergeValidationError(
            f"{location}: root masked row did not supply mask assets"
        )
    return record


def _prewarm_verification_caches(
    shards: Sequence[ShardBundle],
    *,
    dataset_root: Path,
    library_root: Path,
    root_masked_by_id: Mapping[str, Mapping[str, Any]],
    workers: int,
) -> dict[str, int]:
    """Resolve once, then hash/decode independent assets concurrently."""

    file_paths: set[Path] = set()
    crop_paths: set[Path] = set()
    dataset = dataset_root.resolve()
    library = library_root.resolve()
    for shard in shards:
        for stage in shard.stages:
            for raw_record in stage.accepted_rows:
                item_id = _string(raw_record.get("id")) or "<missing-id>"
                location = f"{stage.accepted_manifest}:{item_id}"
                record = _hydrate_mask_record(
                    raw_record,
                    root_masked_by_id=root_masked_by_id,
                    location=location,
                )
                for field in TOP_LEVEL_ASSET_FIELDS:
                    if field not in record:
                        continue
                    _relative, candidates = _asset_candidates(
                        record[field],
                        stage=stage,
                        dataset_root=dataset,
                        location=f"{location}:{field}",
                    )
                    file_paths.update(candidates)
                    if field == "image_path":
                        chosen = min(
                            candidates,
                            key=lambda path: (
                                len(path.relative_to(dataset).parts),
                                path.relative_to(dataset).as_posix(),
                            ),
                        )
                        crop_paths.add(chosen)
                for nested_name in NESTED_ASSET_PATHS:
                    nested = record.get(nested_name)
                    if not isinstance(nested, Mapping):
                        continue
                    for kind, raw_path in nested.items():
                        if kind not in MASK_PATH_TO_TOP_LEVEL:
                            continue
                        _relative, candidates = _asset_candidates(
                            raw_path,
                            stage=stage,
                            dataset_root=dataset,
                            location=f"{location}:{nested_name}.{kind}",
                        )
                        file_paths.update(candidates)

                source_rel = _safe_relative_asset_path(
                    record.get("source_image_path"),
                    location=f"{location}:source_image_path",
                )
                source_path = _source_page_cached(
                    library, source_rel.as_posix()
                )
                signature = record.get("source_page_content_signature")
                signature_sha = (
                    _string(signature.get("sha256"))
                    if isinstance(signature, Mapping)
                    else ""
                )
                if signature_sha or _string(record.get("source_page_sha256")):
                    file_paths.add(source_path)

    ordered_files = sorted(file_paths, key=str)
    ordered_crops = sorted(crop_paths, key=str)
    with ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="fontclip-verify",
    ) as executor:
        for _digest in executor.map(_sha256_file, ordered_files):
            pass
        for _pixel_result in executor.map(
            _crop_pixel_sha256, ordered_crops
        ):
            pass
    return {
        "workers": workers,
        "file_hashes": len(ordered_files),
        "crop_decodes": len(ordered_crops),
    }


def _asset_destination(
    record: Mapping[str, Any],
    *,
    field: str,
    mask_kind: str | None,
    source: Path,
    location: str,
) -> str:
    split = _string(record.get("split"))
    if split not in {"train", "val", "test"}:
        raise MergeValidationError(f"{location}: invalid split {split!r}")
    if source.name in {"", ".", ".."}:
        raise MergeValidationError(f"{location}: invalid asset filename")
    if field == "image_path":
        folder = "raw"
    elif field == "clip_image_path":
        folder = "clip_224"
    else:
        folder_by_kind = {
            "context": "masked_context",
            "context_224": "masked_context_224",
            "glyph_224": "masked_glyph_224",
            "glyph_rgba": "masked_glyph_rgba",
            "mask": "masked_mask",
        }
        folder = folder_by_kind.get(mask_kind or "")
        if folder is None:
            raise MergeValidationError(
                f"{location}: cannot assign output folder for {field}"
            )
    return PurePosixPath("images", folder, split, source.name).as_posix()


def _register_planned_asset(
    plan: dict[str, PlannedAsset],
    *,
    destination_relative: str,
    source: Path,
    sha256: str,
    location: str,
) -> None:
    previous = plan.get(destination_relative)
    current = PlannedAsset(source, destination_relative, sha256)
    if previous is None:
        plan[destination_relative] = current
        return
    if previous.sha256 != sha256:
        raise MergeValidationError(
            f"{location}: output asset collision at {destination_relative}"
        )


def _canonicalize_record(
    raw_record: Mapping[str, Any],
    *,
    stage: StageBundle,
    dataset_root: Path,
    library_root: Path,
    root_masked_by_id: Mapping[str, Mapping[str, Any]],
    asset_plan: dict[str, PlannedAsset],
    stats: AssetVerificationStats,
) -> dict[str, Any]:
    item_id = _string(raw_record.get("id"))
    location = f"{stage.accepted_manifest}:{item_id or '<missing-id>'}"
    if not item_id:
        raise MergeValidationError(f"{location}: id is missing")
    if raw_record.get("audit_status") != "accepted":
        raise MergeValidationError(f"{location}: audit_status must be accepted")
    record = _hydrate_mask_record(
        raw_record,
        root_masked_by_id=root_masked_by_id,
        location=location,
    )
    crop_sha = _string(record.get("crop_sha256")).lower()
    if not HEX_SHA256_RE.fullmatch(crop_sha):
        raise MergeValidationError(f"{location}: invalid crop_sha256")

    mask_hashes = record.get("mask_asset_sha256")
    if mask_hashes is not None and not isinstance(mask_hashes, Mapping):
        raise MergeValidationError(f"{location}: mask_asset_sha256 must be an object")
    resolved_by_kind: dict[str, str] = {}
    resolved_files: set[Path] = set()

    for field, mask_kind in TOP_LEVEL_ASSET_FIELDS.items():
        if field not in record:
            if field in {"image_path", "clip_image_path"}:
                raise MergeValidationError(f"{location}: {field} is missing")
            continue
        expected_sha: str | None = None
        if mask_kind is not None and isinstance(mask_hashes, Mapping):
            expected_sha = _string(mask_hashes.get(mask_kind)) or None
        _canonical, physical, actual_sha = _resolve_asset(
            record[field],
            stage=stage,
            dataset_root=dataset_root,
            location=f"{location}:{field}",
            expected_sha256=expected_sha,
            stats=stats,
        )
        if field == "image_path":
            pixel_sha, decoded_size = _crop_pixel_sha256(physical)
            if pixel_sha != crop_sha:
                raise MergeValidationError(
                    f"{location}:{field}: decoded crop SHA-256 mismatch"
                )
            expected_size = record.get("crop_size_px")
            if (
                isinstance(expected_size, (list, tuple))
                and len(expected_size) == 2
                and tuple(expected_size) != decoded_size
            ):
                raise MergeValidationError(
                    f"{location}:{field}: decoded dimensions {decoded_size} "
                    f"!= crop_size_px {expected_size}"
                )
            stats.verified_hashes += 1
        destination = _asset_destination(
            record,
            field=field,
            mask_kind=mask_kind,
            source=physical,
            location=f"{location}:{field}",
        )
        _register_planned_asset(
            asset_plan,
            destination_relative=destination,
            source=physical,
            sha256=actual_sha,
            location=f"{location}:{field}",
        )
        record[field] = destination
        resolved_files.add(physical)
        if mask_kind is not None:
            resolved_by_kind[mask_kind] = destination

    for nested_name in NESTED_ASSET_PATHS:
        nested = record.get(nested_name)
        if nested is None:
            continue
        if not isinstance(nested, dict):
            raise MergeValidationError(
                f"{location}: {nested_name} must be an object"
            )
        for kind, raw_path in list(nested.items()):
            if kind not in MASK_PATH_TO_TOP_LEVEL:
                raise MergeValidationError(
                    f"{location}: unknown {nested_name} key {kind!r}"
                )
            expected_sha = (
                _string(mask_hashes.get(kind)) or None
                if isinstance(mask_hashes, Mapping)
                else None
            )
            _canonical, physical, actual_sha = _resolve_asset(
                raw_path,
                stage=stage,
                dataset_root=dataset_root,
                location=f"{location}:{nested_name}.{kind}",
                expected_sha256=expected_sha,
                stats=stats,
            )
            top_field = MASK_PATH_TO_TOP_LEVEL[kind]
            destination = _asset_destination(
                record,
                field=top_field,
                mask_kind=kind,
                source=physical,
                location=f"{location}:{nested_name}.{kind}",
            )
            _register_planned_asset(
                asset_plan,
                destination_relative=destination,
                source=physical,
                sha256=actual_sha,
                location=f"{location}:{nested_name}.{kind}",
            )
            nested[kind] = destination
            resolved_files.add(physical)
            expected_top = resolved_by_kind.get(kind)
            if expected_top is not None and expected_top != destination:
                raise MergeValidationError(
                    f"{location}: {nested_name}.{kind} disagrees with "
                    f"{MASK_PATH_TO_TOP_LEVEL[kind]}"
                )

    mask_paths = record.get("mask_paths")
    final_paths = record.get("final_image_paths")
    if isinstance(mask_paths, Mapping) and isinstance(final_paths, Mapping):
        if dict(mask_paths) != dict(final_paths):
            raise MergeValidationError(
                f"{location}: final_image_paths must equal mask_paths"
            )
    if set(resolved_by_kind) != set(MASK_PATH_TO_TOP_LEVEL):
        raise MergeValidationError(
            f"{location}: accepted row lacks the complete five-asset mask set"
        )
    record["mask_enrichment_status"] = "complete"
    record["needs_mask_enrichment"] = False
    if item_id.startswith("frc_") or "recheck_decision" in record:
        record["recheck_decision"] = "pass"

    _canonicalize_source_page(
        record,
        library_root=library_root,
        location=location,
        stats=stats,
    )
    stats.unique_files += len(resolved_files)
    return record


def _record_ancestor_ids(record: Mapping[str, Any]) -> set[str]:
    result: set[str] = set()
    manual = record.get("manual_recrop")
    if isinstance(manual, Mapping):
        parent = _string(manual.get("supersedes_id"))
        if parent:
            result.add(parent)
    history = record.get("audit_history")
    if isinstance(history, list):
        for event in history:
            if not isinstance(event, Mapping):
                continue
            parent = _string(event.get("supersedes_id"))
            if parent:
                result.add(parent)
    return result


def _lineage_root(record: Mapping[str, Any]) -> str:
    item_id = _string(record.get("id"))
    history = record.get("audit_history")
    if not isinstance(history, list) or not history:
        raise MergeValidationError(f"{item_id}: audit_history is missing")
    current = ""
    root = ""
    seen: set[str] = set()
    last_manual_decision = ""
    for event_index, event in enumerate(history):
        if not isinstance(event, Mapping):
            raise MergeValidationError(
                f"{item_id}: audit_history[{event_index}] is not an object"
            )
        kind = _string(event.get("kind"))
        if kind == "manual_visual_audit":
            event_id = _string(event.get("item_id"))
            if not event_id:
                raise MergeValidationError(
                    f"{item_id}: audit event {event_index} has no item_id"
                )
            if not current:
                current = event_id
                root = event_id
                seen.add(event_id)
            elif event_id != current:
                raise MergeValidationError(
                    f"{item_id}: audit event {event_index} breaks lineage "
                    f"({event_id} != {current})"
                )
            last_manual_decision = _string(event.get("decision"))
        elif kind == "manual_recrop_generated":
            parent = _string(event.get("supersedes_id"))
            child = _string(event.get("item_id"))
            if not current or parent != current or not child:
                raise MergeValidationError(
                    f"{item_id}: generated event {event_index} breaks lineage"
                )
            if child in seen:
                raise MergeValidationError(f"{item_id}: recrop lineage contains a cycle")
            current = child
            seen.add(child)
            last_manual_decision = ""
    if current != item_id:
        raise MergeValidationError(
            f"{item_id}: audit lineage terminates at {current!r}"
        )
    if last_manual_decision != "pass":
        raise MergeValidationError(
            f"{item_id}: final manual audit decision is not pass"
        )
    return root


def _validate_merged_uniqueness(
    records: Sequence[Mapping[str, Any]],
) -> None:
    indexes: dict[str, dict[Any, str]] = {
        "id": {},
        "crop_sha256": {},
        "image_path": {},
        "clip_image_path": {},
        "source_crop": {},
        "lineage_root": {},
    }
    accepted_ids = {_string(record.get("id")) for record in records}
    for record in records:
        item_id = _string(record.get("id"))
        bbox = record.get("crop_bbox_px")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise MergeValidationError(
                f"{item_id}: crop_bbox_px must contain four coordinates"
            )
        source_crop = (
            _string(record.get("source_image_path")),
            tuple(bbox),
        )
        values = {
            "id": item_id,
            "crop_sha256": _string(record.get("crop_sha256")).lower(),
            "image_path": _string(record.get("image_path")),
            "clip_image_path": _string(record.get("clip_image_path")),
            "source_crop": source_crop,
            "lineage_root": _lineage_root(record),
        }
        for name, value in values.items():
            previous = indexes[name].get(value)
            if previous is not None:
                raise MergeValidationError(
                    f"duplicate {name} for {previous!r} and {item_id!r}: {value!r}"
                )
            indexes[name][value] = item_id
        accepted_ancestors = _record_ancestor_ids(record) & accepted_ids
        if accepted_ancestors:
            raise MergeValidationError(
                f"{item_id}: accepted record supersedes another accepted ID: "
                f"{sorted(accepted_ancestors)}"
            )


def _sort_reweight_and_validate_distribution(
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    work_splits: dict[str, set[str]] = defaultdict(set)
    chapters_by_work: dict[str, set[str]] = defaultdict(set)
    for record in records:
        work_id = _string(record.get("work_id"))
        chapter_id = _string(record.get("chapter_id"))
        split = _string(record.get("split"))
        if not work_id or not chapter_id:
            raise MergeValidationError(
                f"{_string(record.get('id'))}: work_id/chapter_id is missing"
            )
        if split not in {"train", "val", "test"}:
            raise MergeValidationError(
                f"{_string(record.get('id'))}: invalid split {split!r}"
            )
        work_splits[work_id].add(split)
        chapters_by_work[work_id].add(chapter_id)
    leaking = {
        work_id: sorted(splits)
        for work_id, splits in work_splits.items()
        if len(splits) != 1
    }
    if leaking:
        raise MergeValidationError(
            f"work split leakage detected: {list(leaking.items())[:3]}"
        )
    excessive = {
        work_id: len(chapters)
        for work_id, chapters in chapters_by_work.items()
        if len(chapters) > 10
    }
    if excessive:
        raise MergeValidationError(
            f"more than 10 chapters selected for a work: "
            f"{list(excessive.items())[:3]}"
        )

    records.sort(
        key=lambda record: (
            _string(record.get("work_id")),
            _string(record.get("chapter_id")),
            _string(record.get("page_name")),
            tuple(record.get("bbox_px") or ()),
            _string(record.get("id")),
        )
    )
    total = len(records)
    work_counts = Counter(_string(record.get("work_id")) for record in records)
    chapter_counts = Counter(
        (
            _string(record.get("work_id")),
            _string(record.get("chapter_id")),
        )
        for record in records
    )
    for record in records:
        work_id = _string(record.get("work_id"))
        chapter_key = (work_id, _string(record.get("chapter_id")))
        record["work_balance_weight"] = round(
            total / (len(work_counts) * work_counts[work_id]), 8
        )
        record["chapter_balance_weight"] = round(
            total / (len(chapter_counts) * chapter_counts[chapter_key]), 8
        )
    return {
        "works": len(work_counts),
        "chapters": len(chapter_counts),
        "by_split": dict(
            sorted(Counter(_string(record.get("split")) for record in records).items())
        ),
        "by_tier": dict(
            sorted(Counter(_string(record.get("tier")) for record in records).items())
        ),
        "by_orientation": dict(
            sorted(
                Counter(
                    _string(record.get("orientation")) for record in records
                ).items()
            )
        ),
    }


def _serialize_jsonl(records: Sequence[Mapping[str, Any]]) -> tuple[list[bytes], str]:
    lines: list[bytes] = []
    digest = hashlib.sha256()
    for record in records:
        line = (
            json.dumps(
                record,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )
        lines.append(line)
        digest.update(line)
    return lines, digest.hexdigest()


def _parse_shard_arguments(
    raw_groups: Sequence[Sequence[str]], dataset_root: Path
) -> list[tuple[str, list[Path]]]:
    result: list[tuple[str, list[Path]]] = []
    names: set[str] = set()
    roots: set[Path] = set()
    for group in raw_groups:
        if len(group) < 2:
            raise MergeValidationError(
                "--shard requires NAME followed by one or more stage roots"
            )
        name = group[0]
        if SHARD_NAME_RE.fullmatch(name) is None:
            raise MergeValidationError(
                f"invalid shard name {name!r}; expected shard-NNN"
            )
        if name in names:
            raise MergeValidationError(f"duplicate shard group {name}")
        names.add(name)
        stage_roots = [
            _resolve_stage_root(dataset_root, Path(raw_path))
            for raw_path in group[1:]
        ]
        for root in stage_roots:
            if root in roots:
                raise MergeValidationError(
                    f"audit stage is reused by multiple groups: {root}"
                )
            roots.add(root)
        result.append((name, stage_roots))
    return result


def _validate_shard_set(
    shards: Sequence[ShardBundle],
    *,
    dry_run: bool,
    allow_partial: bool,
) -> tuple[int, bool]:
    if allow_partial and not dry_run:
        raise MergeValidationError(
            "--allow-partial-shards is permitted only with --dry-run"
        )
    declared_counts = {shard.declared_shard_count for shard in shards}
    if len(declared_counts) != 1:
        raise MergeValidationError(
            f"shard completion markers disagree on total count: {declared_counts}"
        )
    declared_count = next(iter(declared_counts))
    indices = {shard.shard_index for shard in shards}
    if len(indices) != len(shards):
        raise MergeValidationError("duplicate shard index")
    expected = set(range(declared_count))
    is_partial = indices != expected
    if is_partial and not allow_partial:
        missing = sorted(expected - indices)
        raise MergeValidationError(
            f"refusing partial merge; missing completed shards {missing}. "
            "Partial validation requires --dry-run --allow-partial-shards."
        )
    return declared_count, is_partial


def _validate_output_target(
    dataset_root: Path,
    output_root: Path,
    *,
    overwrite: bool,
    dry_run: bool,
) -> Path:
    outputs_root = dataset_root.parent.resolve()
    output = output_root.resolve()
    if (
        output in {outputs_root, dataset_root.resolve()}
        or not _is_within(outputs_root, output)
    ):
        raise MergeValidationError(
            f"output must be a sibling dataset below {outputs_root} and may not "
            f"replace the source dataset"
        )
    if output.is_symlink():
        raise MergeValidationError(f"refusing symlink output target: {output}")
    if output.exists() and not dry_run:
        if not overwrite:
            raise FileExistsError(f"output already exists; pass --overwrite: {output}")
        marker = output / MERGE_MARKER_NAME
        if (
            not marker.is_file()
            or marker.read_text(encoding="utf-8") != MERGE_MARKER_CONTENT
        ):
            raise MergeValidationError(
                f"refusing overwrite without exact merge marker: {marker}"
            )
    return outputs_root


def _new_staging_root(outputs_root: Path) -> Path:
    outputs_root.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=".fontclip-merge-staging-", dir=outputs_root)
    ).resolve()
    if not _is_within(outputs_root, staging):
        raise RuntimeError("merge staging directory escaped datasets root")
    (staging / MERGE_MARKER_NAME).write_text(
        MERGE_MARKER_CONTENT, encoding="utf-8", newline="\n"
    )
    return staging


def _commit_staging(
    staging: Path,
    output_root: Path,
    outputs_root: Path,
    *,
    overwrite: bool,
) -> None:
    output = output_root.resolve()
    if not _is_within(outputs_root, staging) or not _is_within(outputs_root, output):
        raise RuntimeError("unsafe merge commit paths")
    output.parent.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if output.exists():
        marker = output / MERGE_MARKER_NAME
        if (
            not overwrite
            or not marker.is_file()
            or marker.read_text(encoding="utf-8") != MERGE_MARKER_CONTENT
        ):
            raise RuntimeError(f"refusing to replace unmarked merge output: {output}")
        backup = outputs_root / f"{staging.name}-previous"
        if backup.exists():
            raise RuntimeError(f"unexpected merge backup path exists: {backup}")
        output.replace(backup)
    try:
        staging.replace(output)
    except BaseException:
        if backup is not None and backup.exists() and not output.exists():
            backup.replace(output)
        raise
    if backup is not None:
        marker = backup / MERGE_MARKER_NAME
        if (
            not _is_within(outputs_root, backup)
            or not marker.is_file()
            or marker.read_text(encoding="utf-8") != MERGE_MARKER_CONTENT
        ):
            raise RuntimeError(f"refusing unsafe merge backup cleanup: {backup}")
        shutil.rmtree(backup)


def _build_mask_gate_outputs(
    records: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    high_precision: list[dict[str, Any]] = []
    rejects: list[dict[str, Any]] = []
    for line_number, record in enumerate(records, 1):
        gate = record.get("mask_quality_gate")
        passed = (
            record.get("mask_high_precision") is True
            and isinstance(gate, Mapping)
            and gate.get("passed") is True
        )
        if passed:
            high_precision.append(dict(record))
            continue
        if not isinstance(gate, Mapping) or gate.get("passed") is not False:
            raise MergeValidationError(
                f"{_string(record.get('id'))}: non-HP row lacks a failed "
                "mask_quality_gate"
            )
        raw_reasons = gate.get("reasons")
        if not isinstance(raw_reasons, list) or not all(
            isinstance(reason, str) and reason for reason in raw_reasons
        ):
            raise MergeValidationError(
                f"{_string(record.get('id'))}: invalid quality gate reasons"
            )
        rejects.append(
            {
                "schema_version": _integer(
                    record.get("mask_schema_version", 1),
                    location=f"{_string(record.get('id'))}:mask_schema_version",
                ),
                "line_number": line_number,
                "stage": "high_precision_gate",
                "reasons": list(raw_reasons),
                "source_image_path": _string(record.get("source_image_path")),
                "row": dict(record),
            }
        )
    if len(high_precision) + len(rejects) != len(records):
        raise AssertionError("mask gate partition is not one-to-one")
    return high_precision, rejects


def _write_jsonl_lines(path: Path, lines: Sequence[bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        for line in lines:
            handle.write(line)


def _materialize_assets(
    staging: Path,
    assets: Mapping[str, PlannedAsset],
) -> dict[str, int]:
    hardlinked = 0
    copied = 0
    for relative, planned in sorted(assets.items()):
        destination = (staging / Path(*PurePosixPath(relative).parts)).resolve()
        if not _is_within(staging, destination):
            raise RuntimeError(f"asset destination escaped staging: {relative}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(planned.source, destination)
            hardlinked += 1
        except OSError:
            shutil.copy2(planned.source, destination)
            copied += 1
        if _sha256_file(destination) != planned.sha256:
            raise RuntimeError(f"materialized asset hash mismatch: {relative}")
    return {"hardlinked": hardlinked, "copied": copied}


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Example: validate completed shard 000 and 001 without writing:

  python scripts/merge_fontclip_accepted_shards.py \\
    --dataset-root datasets/fontclip-source-v1 \\
    --shard shard-000 audits/manual-shard-000-v1 audits/manual-shard-000-v2 \\
      audits/manual-shard-000-v3 audits/manual-shard-000-v4 \\
      audits/manual-shard-000-v4-final \\
    --shard shard-001 audits/shard-001-recrops-v1 \\
      audits/shard-001-recrops-v2 audits/shard-001-recrops-v3 \\
      audits/shard-001-recrops-v3-final \\
    --dry-run --allow-partial-shards

Without --allow-partial-shards, all indices declared by shard-NNN-of-NNN
completion markers must be present.
""",
    )
    parser.add_argument(
        "--dataset-root",
        type=Path,
        default=repo_root / "datasets" / "fontclip-source-v1",
    )
    parser.add_argument(
        "--library-root", "--library", type=Path, default=repo_root / "library"
    )
    parser.add_argument(
        "--root-masked-manifest",
        type=Path,
        help=(
            "authoritative masked rows used to hydrate original accepted crops "
            "(default: DATASET_ROOT/manifest_masked.jsonl)"
        ),
    )
    parser.add_argument(
        "--shard",
        dest="shards",
        action="append",
        nargs="+",
        required=True,
        metavar="NAME_OR_STAGE",
        help=(
            "NAME followed by ordered audit stage roots; repeat once per shard"
        ),
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        help=(
            "standalone sibling dataset below DATASET_ROOT.parent "
            "(default: DATASET_ROOT.parent/fontclip-accepted-v1)"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and hash everything without writing or deleting files",
    )
    parser.add_argument(
        "--allow-partial-shards",
        action="store_true",
        help="allow a subset of declared shards; valid only with --dry-run",
    )
    parser.add_argument(
        "--hash-workers",
        type=int,
        default=min(32, max(4, (os.cpu_count() or 4) * 2)),
        help=(
            "parallel workers used to hash and decode independent assets "
            "(default: 2x CPU count, clamped to 4..32)"
        ),
    )
    parser.add_argument("--overwrite", action="store_true")
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    dataset_root = args.dataset_root.resolve()
    library_root = args.library_root.resolve()
    if not dataset_root.is_dir():
        raise FileNotFoundError(f"dataset root does not exist: {dataset_root}")
    if not library_root.is_dir():
        raise FileNotFoundError(f"library root does not exist: {library_root}")
    output_root = (
        args.output_root.resolve()
        if args.output_root
        else (dataset_root.parent / "fontclip-accepted-v1").resolve()
    )
    outputs_root = _validate_output_target(
        dataset_root,
        output_root,
        overwrite=bool(args.overwrite),
        dry_run=bool(args.dry_run),
    )
    root_masked_manifest = (
        args.root_masked_manifest.resolve()
        if args.root_masked_manifest
        else (dataset_root / "manifest_masked.jsonl").resolve()
    )
    if not _is_within(dataset_root, root_masked_manifest):
        raise MergeValidationError(
            f"root masked manifest must be within {dataset_root}"
        )
    root_masked_rows = _read_jsonl(root_masked_manifest)
    root_masked_by_id = _rows_by_id(
        root_masked_rows, location=root_masked_manifest
    )

    parsed_groups = _parse_shard_arguments(args.shards, dataset_root)
    shards = [
        _validate_shard_chain(name, roots, dataset_root=dataset_root)
        for name, roots in parsed_groups
    ]
    shards.sort(key=lambda shard: shard.shard_index)
    declared_count, is_partial = _validate_shard_set(
        shards,
        dry_run=bool(args.dry_run),
        allow_partial=bool(args.allow_partial_shards),
    )
    hash_workers = int(args.hash_workers)
    if hash_workers < 1 or hash_workers > 128:
        raise MergeValidationError("--hash-workers must be in the range 1..128")
    prewarm = _prewarm_verification_caches(
        shards,
        dataset_root=dataset_root,
        library_root=library_root,
        root_masked_by_id=root_masked_by_id,
        workers=hash_workers,
    )

    stats = AssetVerificationStats()
    asset_plan: dict[str, PlannedAsset] = {}
    merged_records: list[dict[str, Any]] = []
    fragment_summaries: list[dict[str, Any]] = []
    for shard in shards:
        for stage in shard.stages:
            fragment_summaries.append(
                {
                    "shard": shard.name,
                    "stage_index": stage.stage_index,
                    "stage_root": str(stage.root),
                    "input_manifest": str(stage.input_manifest),
                    "accepted_manifest": str(stage.accepted_manifest),
                    "accepted_manifest_sha256": _sha256_file(
                        stage.accepted_manifest
                    ),
                    "accepted_records": len(stage.accepted_rows),
                    "decision_ledgers": [
                        {"path": str(path), "sha256": digest}
                        for path, digest in zip(
                            stage.decision_paths, stage.decision_hashes
                        )
                    ],
                }
            )
            for row in stage.accepted_rows:
                merged_records.append(
                    _canonicalize_record(
                        row,
                        stage=stage,
                        dataset_root=dataset_root,
                        library_root=library_root,
                        root_masked_by_id=root_masked_by_id,
                        asset_plan=asset_plan,
                        stats=stats,
                    )
                )
    _validate_merged_uniqueness(merged_records)
    distribution = _sort_reweight_and_validate_distribution(merged_records)
    serialized_lines, manifest_sha = _serialize_jsonl(merged_records)
    high_precision_rows, mask_reject_rows = _build_mask_gate_outputs(merged_records)
    high_precision_lines, high_precision_sha = _serialize_jsonl(
        high_precision_rows
    )
    mask_reject_lines, mask_reject_sha = _serialize_jsonl(mask_reject_rows)

    stats.unique_files = len(asset_plan)
    summary: dict[str, Any] = {
        "merge_schema_version": SCHEMA_VERSION,
        "dry_run": bool(args.dry_run),
        "partial_shard_validation": is_partial,
        "dataset_root": str(dataset_root),
        "library_root": str(library_root),
        "output_root": str(output_root),
        "root_masked_manifest": str(root_masked_manifest),
        "root_masked_manifest_sha256": _sha256_file(root_masked_manifest),
        "declared_shard_count": declared_count,
        "included_shards": [shard.name for shard in shards],
        "accepted_records": len(merged_records),
        "reviewed_records": sum(shard.primary_item_count for shard in shards),
        "rejected_records": sum(shard.rejected_records for shard in shards),
        "manifest": "manifest.jsonl",
        "manifest_sha256": manifest_sha,
        "masked_manifest": "manifest_masked.jsonl",
        "masked_manifest_sha256": manifest_sha,
        "high_precision_manifest": "manifest_masked_high_precision.jsonl",
        "high_precision_manifest_sha256": high_precision_sha,
        "high_precision_records": len(high_precision_rows),
        "mask_rejects_manifest": "mask_rejects.jsonl",
        "mask_rejects_manifest_sha256": mask_reject_sha,
        "mask_reject_records": len(mask_reject_rows),
        "verification_prewarm": prewarm,
        "duplicate_ids": 0,
        "duplicate_crop_sha256": 0,
        "duplicate_image_paths": 0,
        "duplicate_clip_image_paths": 0,
        "duplicate_source_crops": 0,
        "asset_verification": {
            "references": stats.references,
            "unique_files": stats.unique_files,
            "verified_hashes": stats.verified_hashes,
            "identical_stage_copies": stats.identical_copies,
            "source_pages": stats.source_pages,
            "planned_output_assets": len(asset_plan),
        },
        "distribution": distribution,
        "shards": [
            {
                "name": shard.name,
                "index": shard.shard_index,
                "reviewed_records": shard.primary_item_count,
                "accepted_records": shard.accepted_records,
                "rejected_records": shard.rejected_records,
                "primary_ledger_sha256": shard.primary_ledger_sha256,
                "stage_count": len(shard.stages),
            }
            for shard in shards
        ],
        "fragments": fragment_summaries,
    }

    staging: Path | None = None
    try:
        if not args.dry_run:
            staging = _new_staging_root(outputs_root)
            _write_jsonl_lines(staging / "manifest.jsonl", serialized_lines)
            _write_jsonl_lines(
                staging / "manifest_masked.jsonl", serialized_lines
            )
            _write_jsonl_lines(
                staging / "manifest_masked_high_precision.jsonl",
                high_precision_lines,
            )
            _write_jsonl_lines(
                staging / "mask_rejects.jsonl", mask_reject_lines
            )
            _write_jsonl_lines(
                staging / "manifests" / "all.jsonl", serialized_lines
            )
            for split in ("train", "val", "test"):
                split_lines, _split_sha = _serialize_jsonl(
                    [
                        record
                        for record in merged_records
                        if record.get("split") == split
                    ]
                )
                _write_jsonl_lines(
                    staging / "manifests" / f"{split}.jsonl", split_lines
                )
            materialized = _materialize_assets(staging, asset_plan)
            summary["asset_materialization"] = materialized
            (staging / "merge_summary.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n",
                encoding="utf-8",
                newline="\n",
            )
            _commit_staging(
                staging,
                output_root,
                outputs_root,
                overwrite=bool(args.overwrite),
            )
            staging = None
        return summary
    finally:
        if staging is not None and staging.exists():
            if not _is_within(outputs_root, staging):
                raise RuntimeError(f"refusing unsafe staging cleanup: {staging}")
            shutil.rmtree(staging)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        summary = run(args)
    except (OSError, MergeValidationError, RuntimeError, ValueError) as error:
        parser.exit(2, f"error: {error}\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
