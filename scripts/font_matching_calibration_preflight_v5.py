#!/usr/bin/env python3
"""Run the sealed, source-only eligibility preflight for calibration v5.

The preflight is deliberately append-only.  An initial draw exposes 72 opaque
source-only cards to two independent reviewers.  Candidate pixels and private
strata stay in sealed bindings.  Only samples passing all four checks twice can
enter the deterministic 60-sample scored calibration subset.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Mapping, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:  # direct ``python scripts/...`` execution
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts import font_matching_catalog_delta_ledger as delta  # noqa: E402
from scripts import split_font_matching_review_cards_v5 as split_cards  # noqa: E402
from scripts import build_font_matching_calibration_intake_v5 as intake_v5  # noqa: E402


SCHEMA_VERSION = "font-matching-calibration-preflight-v5"
REVIEWER_STAGES = ("reviewer-a", "reviewer-b")
CHECK_IDS = (
    "complete_text_object",
    "single_skeleton",
    "clean_glyph_isolation",
    "role_context_sufficient",
)
INITIAL_TARGETS = {
    "ordinary_body": 10,
    "aside_whisper_handwritten": 14,
    "emphasis_shout": 14,
    "sfx_impact": 5,
    "sfx_motion": 5,
    "sfx_ambient": 5,
    "sfx_emotion": 5,
    "sfx_comic": 5,
    "sign_ui_title": 9,
}
SCORED_TARGETS = dict(delta.VARIANT_V4_STRATA_TARGETS)
INITIAL_COUNT = sum(INITIAL_TARGETS.values())
SCORED_COUNT = sum(SCORED_TARGETS.values())
SELECTION_ATTEMPTS = 128
BALANCED_INITIAL_CAP_CANDIDATES = (5, 6)
BALANCED_INITIAL_MINIMUM_PER_WORK = 3
DEFAULT_MAX_PER_WORK = BALANCED_INITIAL_CAP_CANDIDATES[-1]
FROZEN_SPLIT_CONTRACTS = {
    "primary": {
        "record_sha256": "1167efc3a95573167771382bc4b6db27408b83d1fa0fa36e2a36021ee858a91c",
        "source_v4_manifest_sha256": "c31e15edf1d81e0e8552fc28399bd27f7b0bab5e3baeebe469f77308c95da76a",
    },
    "secondary": {
        "record_sha256": "e80a51e6253b53ac757d29a0cc879374560cac5f281c5bcfb85aec8fe5b3457e",
        "source_v4_manifest_sha256": "07189ae799ce23ebbc62a145a4886924f11450b9d304e08d5805a778ac86b3e5",
    },
}
MINIMUM_SOURCE_EXTENSION_CONTRACT = {
    "counts_are_derived_from_authoritative_master_split_map": True,
    "frozen_work_assignments_are_immutable": True,
    "requirements_per_new_sample": [
        "real_non_qa_non_synthetic_font_signal_present_crop",
        "authoritative_work_split_train_only",
        "no_val_or_test_pixel_page_or_visual_lineage_conflict",
        "outside_all_prior_calibration_leakage_closures",
        "distinct_page_and_visual_lineage",
        "sealed_primary_and_secondary_source_only_A_card",
    ],
    "primary_admission_method": (
        "add_only_real_fresh_lineages_to_existing_canonical_train_works, preserve_"
        "every_frozen_work_assignment, rebuild_the_authoritative_rescue_selection_"
        "audit_and_both_v5_split_trees, then_update_the_explicit_frozen_split_allowlist"
    ),
    "alternative_new_work_method": (
        "add_genuinely_new_work_ids_with_new_authoritative_train_assignments_without_"
        "changing_any_existing_work_assignment"
    ),
    "existing_test_or_val_work_reassignment_allowed": False,
    "arbitrary_supplemental_manifest_self_authorization_allowed": False,
    "quota_relaxation_or_quarantine_reuse_allowed": False,
}
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
ALIAS_RE = re.compile(r"ko-candidate-[0-9a-f]{16}", re.IGNORECASE)
DRAW_RE = re.compile(r"^(?P<index>[0-9]{3})-(?:initial|extension)$")
ROLE_AND_TIER_TOKENS = frozenset(
    token.casefold()
    for token in (
        *delta.ROLE_VALUES,
        *delta.ALL_FINAL_TIERS,
        "none_acceptable",
        "translation",
        "translated_text",
        "번역",
    )
)


class PreflightError(ValueError):
    """Raised when a v5 preflight artifact fails closed."""


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


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    try:
        return sha256_bytes(path.read_bytes())
    except OSError as error:
        raise PreflightError(f"cannot read {path}: {error}") from error


def stable_hash(*parts: str) -> str:
    return sha256_bytes("\0".join(parts).encode("utf-8"))


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json_bytes(result))
    return result


def validate_seal(value: Mapping[str, Any], location: str) -> None:
    digest = value.get("record_sha256")
    if not isinstance(digest, str) or not SHA_RE.fullmatch(digest):
        raise PreflightError(f"{location}.record_sha256 is invalid")
    payload = dict(value)
    payload.pop("record_sha256", None)
    if sha256_bytes(canonical_json_bytes(payload)) != digest:
        raise PreflightError(f"{location}: record seal changed")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PreflightError(f"{location} must be an object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise PreflightError(f"{location} must be an array")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PreflightError(f"{location} must be non-empty text")
    return value


def _identifier(value: Any, location: str) -> str:
    result = _text(value, location)
    if not ID_RE.fullmatch(result):
        raise PreflightError(f"{location} is not a portable identifier")
    return result


def _sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise PreflightError(f"{location} must be a lowercase SHA-256")
    return value


def _exact_keys(value: Mapping[str, Any], expected: set[str], location: str) -> None:
    if set(value) != expected:
        raise PreflightError(
            f"{location} has wrong keys "
            f"(missing={sorted(expected - set(value))}, "
            f"extra={sorted(set(value) - expected)})"
        )


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise PreflightError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise PreflightError(f"{path}: expected an object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise PreflightError(f"cannot read {path}: {error}") from error
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise PreflightError(f"{path}:{line_number}: {error}") from error
        if not isinstance(value, dict):
            raise PreflightError(f"{path}:{line_number}: expected an object")
        rows.append(value)
    return rows


def _file_binding(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise PreflightError(f"bound file is missing: {resolved}")
    return {
        "path": str(resolved),
        "sha256": sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def _validate_file_binding(value: Mapping[str, Any], location: str) -> Path:
    _exact_keys(value, {"path", "sha256", "byte_size"}, location)
    path = Path(_text(value.get("path"), f"{location}.path")).resolve()
    expected_sha = _sha(value.get("sha256"), f"{location}.sha256")
    size = value.get("byte_size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise PreflightError(f"{location}.byte_size is invalid")
    if not path.is_file() or path.stat().st_size != size:
        raise PreflightError(f"bound file is missing or changed: {path}")
    if sha256_file(path) != expected_sha:
        raise PreflightError(f"bound file hash changed: {path}")
    return path


def _safe_relative(value: Any, location: str) -> PurePosixPath:
    text = _text(value, location)
    relative = PurePosixPath(text)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise PreflightError(f"{location} is unsafe")
    return relative


def _resolve_inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    path = (root / Path(*relative.parts)).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise PreflightError(f"{location} escapes its root") from error
    return path


def _write_once(path: Path, payload: bytes) -> None:
    if path.exists():
        raise PreflightError(f"refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            raise PreflightError(f"refusing to overwrite {path}")
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


@contextmanager
def _workspace_lock(workspace: Path) -> Iterator[None]:
    lock = workspace / ".preflight-v5.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise PreflightError(f"workspace is locked: {workspace}") from error
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield
    finally:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def _assert_disjoint(target: Path, inputs: Iterable[Path]) -> None:
    resolved_target = target.resolve()
    for input_path in inputs:
        resolved_input = input_path.resolve()
        try:
            resolved_target.relative_to(resolved_input)
        except ValueError:
            pass
        else:
            raise PreflightError(
                f"workspace must not be inside input root: {resolved_input}"
            )
        try:
            resolved_input.relative_to(resolved_target)
        except ValueError:
            pass
        else:
            raise PreflightError(
                f"workspace must not contain input root: {resolved_input}"
            )


def _split_index(
    root: Path,
    *,
    expected_stage: str,
    source: Mapping[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    resolved_root = root.resolve()
    manifest_path = resolved_root / split_cards.MANIFEST_FILE
    marker_path = resolved_root / split_cards.MARKER_FILE
    try:
        manifest = split_cards.read_json(manifest_path, "split manifest")
        marker = split_cards.read_json(marker_path, "split marker")
        split_cards.validate_seal(manifest, "split manifest")
        split_cards.validate_seal(marker, "split marker")
    except (split_cards.SplitCardError, OSError) as error:
        raise PreflightError(f"invalid {expected_stage} split tree: {error}") from error
    frozen = FROZEN_SPLIT_CONTRACTS[expected_stage]
    source_manifest = _mapping(manifest.get("source_manifest"), "source_manifest")
    split_contract = _mapping(manifest.get("split_contract"), "split_contract")
    if (
        manifest.get("schema_version") != split_cards.SCHEMA_VERSION
        or manifest.get("record_type") != split_cards.RECORD_TYPE
        or marker.get("schema_version") != split_cards.SCHEMA_VERSION
        or marker.get("record_type") != "font_matching_review_card_split_tree_marker"
        or manifest.get("record_sha256") != frozen["record_sha256"]
        or source_manifest.get("sha256") != frozen["source_v4_manifest_sha256"]
        or split_contract.get("candidate_pixels_visible_in_source_stage") is not False
        or split_contract.get("source_candidate_pixel_overlap") != 0
        or split_contract.get("source_stage_must_be_sealed_before_candidate_stage")
        is not True
    ):
        raise PreflightError(f"{expected_stage} split tree is not the frozen v5 tree")
    source_manifest_path = Path(
        _text(source_manifest.get("path"), "source_manifest.path")
    ).resolve()
    if (
        not source_manifest_path.is_file()
        or sha256_file(source_manifest_path) != frozen["source_v4_manifest_sha256"]
    ):
        raise PreflightError(f"{expected_stage} frozen v4 source manifest changed")
    if marker.get("manifest_sha256") != sha256_file(manifest_path):
        raise PreflightError(f"{expected_stage} split marker binding changed")
    expected_managed = _mapping(marker.get("managed_files"), "split managed_files")
    actual_managed = {
        path.relative_to(resolved_root).as_posix(): sha256_file(path)
        for path in sorted(resolved_root.rglob("*"))
        if path.is_file() and path.name != split_cards.MARKER_FILE
    }
    if dict(expected_managed) != actual_managed:
        raise PreflightError(f"{expected_stage} split managed files changed")
    index: dict[str, dict[str, Any]] = {}
    for row_index, raw in enumerate(_list(manifest.get("cards"), "split.cards")):
        row = _mapping(raw, f"split.cards[{row_index}]")
        sample_id = _identifier(row.get("sample_id"), f"split[{row_index}].sample_id")
        assignment_id = _identifier(
            row.get("assignment_id"), f"split[{row_index}].assignment_id"
        )
        if row.get("stage") != expected_stage:
            raise PreflightError(f"{assignment_id}: split card is in the wrong stage")
        if sample_id in index:
            raise PreflightError(f"duplicate {expected_stage} split sample {sample_id}")
        stages_value = source.get("stages_by_sample", {}).get(sample_id)
        if isinstance(stages_value, Mapping) and isinstance(
            stages_value.get(expected_stage), Mapping
        ):
            assignment = _mapping(
                stages_value.get(expected_stage), f"{sample_id}.{expected_stage}"
            )
            if assignment.get("assignment_id") != assignment_id:
                raise PreflightError(f"{sample_id}: split assignment binding changed")
        descriptors: dict[str, Any] = {}
        for name in ("source_only", "candidate_only"):
            descriptor = _mapping(row.get(name), f"{assignment_id}.{name}")
            relative = _safe_relative(
                descriptor.get("file"), f"{assignment_id}.{name}.file"
            )
            path = _resolve_inside(resolved_root, relative, f"{assignment_id}.{name}")
            expected_sha = _sha(
                descriptor.get("sha256"), f"{assignment_id}.{name}.sha256"
            )
            if actual_managed.get(relative.as_posix()) != expected_sha:
                raise PreflightError(f"{assignment_id}: {name} bytes changed")
            descriptors[name] = {
                "path": str(path),
                "sha256": expected_sha,
                "pixel_sha256": _sha(
                    descriptor.get("pixel_sha256"),
                    f"{assignment_id}.{name}.pixel_sha256",
                ),
                "size_px": list(descriptor.get("size_px", [])),
            }
        index[sample_id] = {
            "assignment_id": assignment_id,
            "source_only": descriptors["source_only"],
            "candidate_only": descriptors["candidate_only"],
        }
    return index, {
        "root": str(resolved_root),
        "manifest": _file_binding(manifest_path),
        "marker": _file_binding(marker_path),
        "stage": expected_stage,
        "card_count": len(index),
    }


def _canonical_master_split_contract(
    path: Path,
    source: Mapping[str, Any],
    *,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    resolved = path.resolve()
    document = read_json(resolved)
    expected_sha = (
        expected_sha256
        if expected_sha256 is not None
        else delta.nested(source["source_report"], "inputs", "master_split_map_sha256")
    )
    if sha256_file(resolved) != expected_sha:
        raise PreflightError(
            "authoritative master split map differs from its selected authority binding"
        )
    if document.get("schema_version") != 1:
        raise PreflightError("authoritative master split map schema changed")
    assignments_value = _mapping(
        document.get("work_assignments"), "master split map.work_assignments"
    )
    assignments: dict[str, str] = {}
    for work_id_value, split_value in assignments_value.items():
        work_id = _identifier(work_id_value, "master split map.work_id")
        if split_value not in {"train", "val", "test"}:
            raise PreflightError(f"{work_id}: canonical split is invalid")
        assignments[work_id] = str(split_value)
    selection = _mapping(source.get("selection"), "source.selection")
    canonical_by_sample: dict[str, str] = {}
    inferred_by_sample = _mapping(
        source.get("split_by_sample"), "source.split_by_sample"
    )
    mismatches: list[dict[str, str]] = []
    source_work_ids: set[str] = set()
    for sample_id, row_value in selection.items():
        row = _mapping(row_value, f"source.selection[{sample_id}]")
        work_id = _identifier(row.get("work_id"), f"selection[{sample_id}].work_id")
        source_work_ids.add(work_id)
        canonical = assignments.get(work_id)
        if canonical is None:
            raise PreflightError(
                f"{sample_id}: work is absent from the authoritative split map"
            )
        canonical_by_sample[str(sample_id)] = canonical
        inferred = inferred_by_sample.get(sample_id)
        if inferred != canonical:
            mismatches.append(
                {
                    "sample_id": str(sample_id),
                    "work_id": work_id,
                    "legacy_view_path_split": str(inferred),
                    "canonical_work_split": canonical,
                }
            )
    extra_source_works = sorted(source_work_ids - set(assignments))
    if extra_source_works:
        raise PreflightError(
            f"source works escape the authoritative split map: {extra_source_works}"
        )
    assignment_counts = Counter(assignments[work_id] for work_id in source_work_ids)
    authoritative_identity: dict[str, str] | None = None
    if isinstance(document.get("algorithm"), Mapping):
        try:
            authoritative_identity = intake_v5.split_identity(document)
        except intake_v5.IntakeError as error:
            raise PreflightError(str(error)) from error
    return {
        "file_binding": _file_binding(resolved),
        "work_assignments": assignments,
        "canonical_by_sample": canonical_by_sample,
        "source_work_ids": sorted(source_work_ids),
        "source_work_assignment_counts": dict(sorted(assignment_counts.items())),
        "legacy_path_mismatch_count": len(mismatches),
        "legacy_path_mismatch_sample_ids_sha256": sha256_bytes(
            canonical_json_bytes(sorted(row["sample_id"] for row in mismatches))
        ),
        "legacy_path_mismatches": mismatches,
        "authoritative_identity": authoritative_identity,
    }


def _pool_fingerprint(pool: Sequence[Mapping[str, Any]]) -> str:
    rows = [
        {
            "sample_id": str(row["sample_id"]),
            "stratum": str(row["stratum"]),
            "work_id": str(row["work_id"]),
            "chapter_id": str(row["chapter_id"]),
            "page_key": str(row["page_key"]),
            "conflict_keys": sorted(str(value) for value in row["conflict_keys"]),
            "role": str(row["role"]),
            "priority_rank": int(row["priority_rank"]),
            "orientation": str(row["orientation"]),
            "style_cluster": str(row["style_cluster"]),
        }
        for row in sorted(pool, key=lambda item: str(item["sample_id"]))
    ]
    return sha256_bytes(canonical_json_bytes(rows))


def _validate_authority_pool_exclusions(
    pool: Sequence[Mapping[str, Any]], bridge: Mapping[str, Any]
) -> None:
    parents = {str(value) for value in bridge.get("excluded_parent_ids", [])}
    successors = {str(value) for value in bridge.get("successor_ids", [])}
    pool_ids = {str(row["sample_id"]) for row in pool}
    parent_leaks = sorted(pool_ids.intersection(parents))
    successor_leaks = sorted(pool_ids.intersection(successors))
    if parent_leaks:
        raise PreflightError(
            f"authority-excluded parent re-entered v4 pool: {parent_leaks}"
        )
    if successor_leaks:
        raise PreflightError(
            f"promotion successor was auto-inherited into v4 pool: {successor_leaks}"
        )


def _preflight_candidate(
    source: Mapping[str, Any], sample_id: str
) -> dict[str, Any] | None:
    """Build a train candidate without inheriting an old release-state gate.

    The frozen secondary v5 split card is the A-stage availability proof for
    this new workflow.  Reviewer independence is enforced by v5 reviewer IDs,
    so a stale v3 ``ready_assignments`` projection must not erase an otherwise
    sealed secondary card.
    """

    stratum = delta._variant_v4_stratum(source, sample_id)
    if stratum is None:
        return None
    selection = _mapping(source["selection"].get(sample_id), f"selection[{sample_id}]")
    master_row = _mapping(source["master"].get(sample_id), f"master[{sample_id}]")
    role, _ = delta._variant_v4_source_role_and_style(source, sample_id)
    work_id = delta.require_id(
        selection.get("work_id"), f"selection[{sample_id}].work_id"
    )
    metadata = master_row.get("metadata")
    orientation = metadata.get("orientation") if isinstance(metadata, Mapping) else None
    if not isinstance(orientation, str) or not orientation.strip():
        orientation = delta.nested(
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
        "chapter_id": delta._variant_v4_chapter_id(master_row, sample_id),
        "page_key": delta._variant_v4_page_key(master_row, sample_id),
        "conflict_keys": frozenset(delta._master_calibration_leakage_keys(master_row)),
        "priority_rank": delta._variant_v4_priority_rank(source, sample_id),
        "orientation": str(orientation),
        "style_cluster": delta._variant_v4_style_cluster(source, sample_id, role),
    }


def _fresh_candidate_pool(
    source: Mapping[str, Any],
    *,
    excluded_sample_ids: frozenset[str],
    primary: Mapping[str, Any],
    secondary: Mapping[str, Any],
) -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    for sample_id in sorted(source["inventory"]):
        if (
            sample_id in excluded_sample_ids
            or source["split_by_sample"].get(sample_id) != "train"
            or sample_id not in primary
            or sample_id not in secondary
        ):
            continue
        closure = delta._calibration_leakage_closure(source, {sample_id})
        if any(
            source["split_by_sample"].get(member) in {"val", "test"}
            for member in closure
        ):
            continue
        candidate = _preflight_candidate(source, sample_id)
        if candidate is not None:
            pool.append(candidate)
    return pool


def _intake_closure_keys(row: Mapping[str, Any], *, location: str) -> frozenset[str]:
    closure = _mapping(row.get("closure"), f"{location}.closure")
    expected_categories = {
        "exact",
        "page",
        "root",
        "variant",
        "glyph",
        "source",
        "lineage",
    }
    if set(closure) != expected_categories:
        raise PreflightError(f"{location}: sealed closure categories changed")
    keys: list[str] = []
    for category in sorted(expected_categories):
        values = _list(closure.get(category), f"{location}.closure.{category}")
        if not values:
            raise PreflightError(f"{location}: {category} closure is empty")
        for value in values:
            keys.append(_text(value, f"{location}.closure.{category}"))
    if len(keys) != len(set(keys)):
        raise PreflightError(f"{location}: sealed closure contains duplicate keys")
    return frozenset(keys)


def _authoritative_projection_gap_master_rows(
    external: Mapping[str, Any], sample_ids: set[str]
) -> dict[str, dict[str, Any]]:
    """Resolve only sealed existing-master gaps against the bound v3 manifest."""

    if not sample_ids:
        return {}
    bridge = _mapping(
        external.get("authority_successor_bridge"), "authority successor bridge"
    )
    manifest_path = _validate_file_binding(
        _mapping(
            bridge.get("successor_master_manifest"),
            "authority successor bridge.successor_master_manifest",
        ),
        "authority successor bridge.successor_master_manifest",
    )
    found: dict[str, dict[str, Any]] = {}
    try:
        with manifest_path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise PreflightError(
                        f"{manifest_path}:{line_number}: {error}"
                    ) from error
                if not isinstance(value, dict) or value.get("id") not in sample_ids:
                    continue
                sample_id = str(value["id"])
                if sample_id in found:
                    raise PreflightError(
                        f"authoritative master duplicates projection-gap ID: {sample_id}"
                    )
                found[sample_id] = {
                    "row": value,
                    "record_sha256": sha256_bytes(canonical_json_bytes(value)),
                }
    except OSError as error:
        raise PreflightError(
            f"cannot read authoritative successor master: {error}"
        ) from error
    missing = sorted(sample_ids.difference(found))
    if missing:
        raise PreflightError(
            "sealed existing-master projection gap is absent from the bound "
            f"successor master: {missing[:5]}"
        )
    return found


def _merge_sealed_intake(external: dict[str, Any], *, sealed_intake_root: Path) -> None:
    """Attach only an owned, fully revalidated source-sealed intake workspace."""

    try:
        verified = intake_v5.validate_sealed_intake(sealed_intake_root)
    except (intake_v5.IntakeError, OSError) as error:
        raise PreflightError(f"invalid sealed intake workspace: {error}") from error
    binding = _mapping(verified.get("binding"), "sealed intake.binding")
    report = _mapping(verified.get("report"), "sealed intake.report")
    rows = _list(verified.get("rows"), "sealed intake.rows")
    if len(rows) != intake_v5.EXPECTED_COUNT:
        raise PreflightError("sealed intake does not contain exactly eight rows")
    counts = Counter(str(row.get("stratum")) for row in rows)
    if counts != Counter(intake_v5.EXPECTED_STRATA):
        raise PreflightError(
            "sealed intake does not contain the exact ambient5/comic3 strata"
        )
    if (
        report.get("test_or_val_count") != 0
        or report.get("prior_leakage_count") != 0
        or report.get("candidate_b_count") != 0
        or report.get("font_identity_count") != 0
        or report.get("synthetic_generative_qa_count") != 0
    ):
        raise PreflightError("sealed intake reports unsafe source evidence")

    supplemental_cards = verified.get("source_stage_bindings")
    if supplemental_cards is None:
        intake_root = Path(
            _text(verified.get("workspace"), "sealed intake.workspace")
        ).resolve()
        if intake_root != sealed_intake_root.resolve():
            raise PreflightError("sealed intake workspace identity changed")
        private_rows = read_jsonl(intake_root / "private-bindings.jsonl")
        private_by_sample = {
            _identifier(row.get("sample_id"), "sealed intake private.sample_id"): row
            for row in private_rows
        }
        tasks_by_reviewer: dict[str, dict[str, Mapping[str, Any]]] = {}
        for reviewer_stage in intake_v5.REVIEWER_STAGES:
            task_rows = read_jsonl(intake_root / "tasks" / f"{reviewer_stage}.jsonl")
            tasks_by_reviewer[reviewer_stage] = {
                _identifier(task.get("task_id"), "sealed intake task.task_id"): task
                for task in task_rows
            }
        supplemental_cards = {}
        for row in rows:
            sample_id = _identifier(
                row.get("sample_id"), "sealed intake source card.sample_id"
            )
            private = _mapping(
                private_by_sample.get(sample_id),
                f"sealed intake source card[{sample_id}].private",
            )
            task_ids = _mapping(
                private.get("task_ids"),
                f"sealed intake source card[{sample_id}].task_ids",
            )
            by_stage: dict[str, dict[str, Any]] = {}
            for source_stage, reviewer_stage in (
                ("primary", "reviewer-a"),
                ("secondary", "reviewer-b"),
            ):
                task_id = _identifier(
                    task_ids.get(reviewer_stage),
                    f"sealed intake source card[{sample_id}].{reviewer_stage}",
                )
                task = _mapping(
                    tasks_by_reviewer[reviewer_stage].get(task_id),
                    f"sealed intake source task[{task_id}]",
                )
                source_only = _mapping(
                    task.get("source_only"),
                    f"sealed intake source task[{task_id}].source_only",
                )
                relative = PurePosixPath(
                    _text(source_only.get("path"), "sealed intake source path")
                )
                if relative.is_absolute() or ".." in relative.parts:
                    raise PreflightError("sealed intake source task path escaped")
                source_path = (intake_root / Path(*relative.parts)).resolve()
                if not source_path.is_relative_to(intake_root):
                    raise PreflightError("sealed intake source task path escaped")
                source_sha = _sha(
                    source_only.get("sha256"), "sealed intake source sha256"
                )
                if not source_path.is_file() or sha256_file(source_path) != source_sha:
                    raise PreflightError("sealed intake source task changed")
                by_stage[source_stage] = {
                    "assignment_id": (
                        "intake-source-"
                        + stable_hash(sample_id, source_stage, task_id)[:32]
                    ),
                    "source_only": {
                        "path": str(source_path),
                        "sha256": source_sha,
                        "pixel_sha256": _sha(
                            source_only.get("pixel_sha256"),
                            "sealed intake source pixel sha256",
                        ),
                        "size_px": list(
                            _list(
                                source_only.get("size_px"),
                                "sealed intake source size_px",
                            )
                        ),
                    },
                    "candidate_only": {
                        "candidate_b_present": False,
                        "status": "not_materialized_before_source_preflight",
                        "source_seal_report_record_sha256": report["record_sha256"],
                    },
                }
            supplemental_cards[sample_id] = by_stage

    canonical_split = external["canonical_split"]
    current_identity = _mapping(
        canonical_split.get("authoritative_identity"),
        "canonical split.authoritative_identity",
    )
    if binding.get("authoritative_split_identity") != current_identity:
        raise PreflightError(
            "sealed intake frozen source/work-assignment identity differs from preflight"
        )
    source = external["source"]
    authority_bridge = external.get("authority_successor_bridge")
    expected_master_manifest_sha = (
        authority_bridge["successor_master_manifest"]["sha256"]
        if isinstance(authority_bridge, Mapping)
        else delta.nested(source["source_report"], "inputs", "master_manifest_sha256")
    )
    expected_bridge_record = (
        authority_bridge["record_sha256"]
        if isinstance(authority_bridge, Mapping)
        else None
    )
    if (
        binding.get("rescue_report_record_sha256")
        != source.get("source_report_record_sha256")
        or binding.get("font_signal_audit_report_record_sha256")
        != source.get("audit_report_record_sha256")
        or binding.get("master_manifest_sha256") != expected_master_manifest_sha
        or binding.get("prior_subset_bindings_sha256")
        != sha256_bytes(canonical_json_bytes(external["prior"]["bindings"]))
        or binding.get("authority_successor_bridge_record_sha256")
        != expected_bridge_record
        or binding.get("authority_successor_ids_auto_inherited") is not False
    ):
        raise PreflightError("sealed intake authoritative source/prior binding differs")

    projection_gap_ids = {
        _identifier(
            _mapping(row, f"sealed intake.rows[{index}]").get("sample_id"),
            f"sealed intake[{index}].sample_id",
        )
        for index, row in enumerate(rows)
        if _mapping(row, f"sealed intake.rows[{index}]").get("kind")
        == "existing_master"
        and _mapping(row, f"sealed intake.rows[{index}]").get("sample_id")
        not in source["master"]
    }
    authoritative_gap_rows = _authoritative_projection_gap_master_rows(
        external, projection_gap_ids
    )

    base_ids = {str(row["sample_id"]) for row in external["pool"]}
    prior_ids = set(str(value) for value in external["prior"]["excluded_sample_ids"])
    prior_conflict_keys: set[str] = set()
    for prior_id in prior_ids:
        prior_row = source["master"].get(prior_id)
        if isinstance(prior_row, Mapping):
            try:
                prior_conflict_keys.update(
                    str(value)
                    for value in delta._master_calibration_leakage_keys(prior_row)
                )
            except delta.DeltaLedgerError as error:
                raise PreflightError(str(error)) from error

    additions: list[dict[str, Any]] = []
    sealed_manual_recrop_conflict_keys = external.setdefault(
        "_sealed_manual_recrop_conflict_keys", {}
    )
    if not isinstance(sealed_manual_recrop_conflict_keys, dict):
        raise PreflightError("sealed manual-recrop quarantine index changed")
    sealed_existing_master_projection_gaps = external.setdefault(
        "_sealed_existing_master_projection_gaps", {}
    )
    if not isinstance(sealed_existing_master_projection_gaps, dict):
        raise PreflightError("sealed existing-master projection-gap index changed")
    observed_ids: set[str] = set()
    for index, row_value in enumerate(rows):
        row = _mapping(row_value, f"sealed intake.rows[{index}]")
        sample_id = _identifier(
            row.get("sample_id"), f"sealed intake[{index}].sample_id"
        )
        if sample_id in observed_ids or sample_id in base_ids:
            raise PreflightError(
                f"sealed intake sample is not a fresh pool addition: {sample_id}"
            )
        observed_ids.add(sample_id)
        if sample_id in prior_ids:
            raise PreflightError(
                f"sealed intake reuses a prior calibration sample: {sample_id}"
            )
        work_id = _identifier(row.get("work_id"), f"sealed intake[{index}].work_id")
        if canonical_split["work_assignments"].get(work_id) != "train":
            raise PreflightError(
                f"sealed intake work is not canonical train: {work_id}"
            )
        if row.get("authoritative_split_identity") != current_identity:
            raise PreflightError(f"{sample_id}: sealed row split identity changed")
        if (
            row.get("source_status") != "dual_independent_pass"
            or row.get("all_four_checks_passed_twice") is not True
            or row.get("reviewers_independent") is not True
            or row.get("candidate_b_present") is not False
            or row.get("font_identity_present") is not False
            or row.get("synthetic") is not False
            or row.get("qa_overlay") is not False
        ):
            raise PreflightError(f"{sample_id}: unsafe sealed intake row")
        stratum = _text(row.get("stratum"), f"sealed intake[{index}].stratum")
        role = _text(row.get("role"), f"sealed intake[{index}].role")
        if stratum not in intake_v5.EXPECTED_STRATA or role != stratum:
            raise PreflightError(f"{sample_id}: source role/stratum agreement changed")
        conflict_keys = _intake_closure_keys(row, location=f"sealed intake[{index}]")
        if conflict_keys.intersection(prior_conflict_keys):
            raise PreflightError(f"{sample_id}: sealed intake overlaps prior closure")
        page_id = _identifier(row.get("page_id"), f"sealed intake[{index}].page_id")
        page_sha = _sha(
            row.get("source_page_sha256"),
            f"sealed intake[{index}].source_page_sha256",
        )
        kind = row.get("kind")
        if kind == "existing_master":
            master_record_sha256 = _sha(
                row.get("master_record_sha256"),
                f"sealed intake[{index}].master_record_sha256",
            )
            if sample_id in source["selection"]:
                try:
                    candidate = _preflight_candidate(source, sample_id)
                except delta.DeltaLedgerError as error:
                    raise PreflightError(str(error)) from error
                if candidate is None:
                    raise PreflightError(
                        f"{sample_id}: existing intake row has no stratum"
                    )
                if (
                    candidate["stratum"] != stratum
                    or candidate["work_id"] != work_id
                    or candidate["chapter_id"] != row.get("chapter_id")
                    or candidate["page_key"] != f"{page_id}\0{page_sha}"
                    or frozenset(candidate["conflict_keys"]) != conflict_keys
                ):
                    raise PreflightError(
                        f"{sample_id}: existing intake/source projection changed"
                    )
                addition = dict(candidate)
            else:
                if (
                    row.get("stratum_authority")
                    != "dual_independent_source_visual_review"
                ):
                    raise PreflightError(
                        f"{sample_id}: non-rescue existing row lacks visual authority"
                    )
                orientation = _text(
                    row.get("orientation"), f"sealed intake[{index}].orientation"
                )
                if orientation not in {"horizontal", "vertical"}:
                    raise PreflightError(f"{sample_id}: invalid existing orientation")
                addition = {
                    "sample_id": sample_id,
                    "stratum": stratum,
                    "role": role,
                    "work_id": work_id,
                    "chapter_id": _identifier(
                        row.get("chapter_id"),
                        f"sealed intake[{index}].chapter_id",
                    ),
                    "page_key": f"{page_id}\0{page_sha}",
                    "conflict_keys": conflict_keys,
                    "priority_rank": 0,
                    "orientation": orientation,
                    "style_cluster": f"sealed-existing|{role}|{orientation}",
                }
                authoritative_row = _mapping(
                    authoritative_gap_rows.get(sample_id),
                    f"authority successor master[{sample_id}]",
                )
                if authoritative_row.get("record_sha256") != master_record_sha256:
                    raise PreflightError(
                        f"{sample_id}: sealed existing-master hash differs from v3"
                    )
                authoritative_payload = _mapping(
                    authoritative_row.get("row"),
                    f"authority successor master[{sample_id}].row",
                )
                authoritative_work = _mapping(
                    authoritative_payload.get("work"),
                    f"authority successor master[{sample_id}].work",
                )
                if (
                    authoritative_work.get("id") != work_id
                    or authoritative_payload.get("split") != "train"
                ):
                    raise PreflightError(
                        f"{sample_id}: successor master work/split differs from intake"
                    )
                if sample_id in sealed_existing_master_projection_gaps:
                    raise PreflightError(
                        f"{sample_id}: duplicate sealed existing-master projection gap"
                    )
                sealed_existing_master_projection_gaps[sample_id] = {
                    "conflict_keys": conflict_keys,
                    "master_record_sha256": master_record_sha256,
                }
        elif kind == "manual_recrop":
            orientation = _text(
                row.get("orientation"), f"sealed intake[{index}].orientation"
            )
            if orientation not in {"horizontal", "vertical"}:
                raise PreflightError(f"{sample_id}: invalid recrop orientation")
            addition = {
                "sample_id": sample_id,
                "stratum": stratum,
                "role": role,
                "work_id": work_id,
                "chapter_id": _identifier(
                    row.get("chapter_id"), f"sealed intake[{index}].chapter_id"
                ),
                "page_key": f"{page_id}\0{page_sha}",
                "conflict_keys": conflict_keys,
                "priority_rank": 0,
                "orientation": orientation,
                "style_cluster": f"sealed-manual-recrop|{role}|{orientation}",
            }
            if sample_id in sealed_manual_recrop_conflict_keys:
                raise PreflightError(
                    f"{sample_id}: duplicate sealed manual-recrop quarantine entry"
                )
            sealed_manual_recrop_conflict_keys[sample_id] = conflict_keys
        else:
            raise PreflightError(f"{sample_id}: unsupported sealed intake kind")
        for source_stage in ("primary", "secondary"):
            if sample_id not in external[source_stage]:
                external[source_stage][sample_id] = copy.deepcopy(
                    _mapping(
                        _mapping(
                            supplemental_cards,
                            "sealed intake.source_stage_bindings",
                        ).get(sample_id),
                        f"sealed intake source bindings[{sample_id}]",
                    )[source_stage]
                )
        additions.append(addition)

    external["pool"] = sorted(
        [*external["pool"], *additions], key=lambda row: str(row["sample_id"])
    )
    external["pool_fingerprint"] = _pool_fingerprint(external["pool"])
    intake_summary = {
        "binding": copy.deepcopy(dict(binding)),
        "source_seal_report_record_sha256": report["record_sha256"],
        "count": len(additions),
        "sample_ids_sha256": sha256_bytes(canonical_json_bytes(sorted(observed_ids))),
        "stratum_counts": dict(sorted(counts.items())),
    }
    summaries = external.setdefault("_sealed_intake_summaries", [])
    summaries.append(intake_summary)
    if len(summaries) == 1:
        # Preserve the original single-intake fingerprint byte-for-byte so
        # already sealed workspaces remain valid.
        external["sealed_intake"] = copy.deepcopy(intake_summary)
    else:
        aggregate_counts: Counter[str] = Counter()
        for summary in summaries:
            aggregate_counts.update(summary["stratum_counts"])
        external["sealed_intake"] = {
            "intakes": copy.deepcopy(summaries),
            "count": sum(int(summary["count"]) for summary in summaries),
            "sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(
                    sorted(str(summary["sample_ids_sha256"]) for summary in summaries)
                )
            ),
            "stratum_counts": dict(sorted(aggregate_counts.items())),
        }


def _sealed_intake_roots(
    value: Path | Sequence[Path] | None,
) -> list[Path]:
    if value is None:
        return []
    roots = [value] if isinstance(value, Path) else list(value)
    resolved = [Path(root).resolve() for root in roots]
    if len(resolved) != len(set(resolved)):
        raise PreflightError("sealed intake roots must be unique")
    return resolved


def _load_external(
    *,
    rescue_inputs: Path,
    font_signal_audit: Path,
    master_split_map: Path,
    prior_calibration_subsets: Sequence[Path],
    primary_split_root: Path,
    secondary_split_root: Path,
    sealed_intake_root: Path | Sequence[Path] | None = None,
    successor_bridge_root: Path | None = None,
) -> dict[str, Any]:
    if len(prior_calibration_subsets) < 3:
        raise PreflightError("v5 requires sealed prior calibration subsets v1/v2/v3")
    try:
        source = delta._validate_source_inputs(rescue_inputs, font_signal_audit)
        prior = delta._load_prior_calibration_subsets(
            prior_calibration_subsets, source=source
        )
    except delta.DeltaLedgerError as error:
        raise PreflightError(str(error)) from error
    base_split_sha = delta.nested(
        source["source_report"], "inputs", "master_split_map_sha256"
    )
    current_split_sha = sha256_file(master_split_map.resolve())
    authority_bridge: dict[str, Any] | None = None
    if current_split_sha == base_split_sha:
        if successor_bridge_root is not None:
            raise PreflightError(
                "successor bridge supplied for an unchanged split authority"
            )
    else:
        if successor_bridge_root is None:
            raise PreflightError(
                "selected split succeeds rescue v2; --successor-bridge-root is required"
            )
        try:
            authority_bridge = intake_v5.validate_authority_successor_bridge(
                successor_bridge_root,
                base_master_manifest_sha256=delta.nested(
                    source["source_report"], "inputs", "master_manifest_sha256"
                ),
                base_master_split_map_sha256=base_split_sha,
                base_catalog_registry_sha256=delta.nested(
                    source["source_report"], "inputs", "catalog_registry_sha256"
                ),
                base_catalog_registry_record_sha256=delta.nested(
                    source["source_report"],
                    "inputs",
                    "catalog_registry_record_sha256",
                ),
                successor_master_root=master_split_map.resolve().parent,
                successor_split_map=master_split_map,
            )
        except (intake_v5.IntakeError, OSError) as error:
            raise PreflightError(
                f"invalid authority successor bridge: {error}"
            ) from error
        excluded_parent_ids = set(
            str(value) for value in authority_bridge["excluded_parent_ids"]
        )
        successor_ids = set(str(value) for value in authority_bridge["successor_ids"])
        if successor_ids.intersection(source["selection"]):
            raise PreflightError(
                "promotion successors were auto-inherited into v4 source"
            )
        for sample_id in excluded_parent_ids:
            source["selection"].pop(sample_id, None)
            if isinstance(source.get("inventory"), dict):
                source["inventory"].pop(sample_id, None)
            elif isinstance(source.get("inventory"), set):
                source["inventory"].discard(sample_id)
        source["authority_removed_parent_ids"] = sorted(excluded_parent_ids)
        source["authority_successor_ids_not_inherited"] = sorted(successor_ids)
    canonical_split = _canonical_master_split_contract(
        master_split_map, source, expected_sha256=current_split_sha
    )
    source["legacy_view_path_split_by_sample"] = dict(source["split_by_sample"])
    source["split_by_sample"] = dict(canonical_split["canonical_by_sample"])
    declared_prior_training_quarantine = list(prior["training_quarantine_sample_ids"])
    prior_canonical_non_train_quarantine = sorted(
        sample_id
        for sample_id in declared_prior_training_quarantine
        if source["split_by_sample"].get(sample_id) != "train"
    )
    prior["declared_training_quarantine_sample_ids"] = (
        declared_prior_training_quarantine
    )
    prior["canonical_non_train_declared_quarantine_sample_ids"] = (
        prior_canonical_non_train_quarantine
    )
    prior["training_quarantine_sample_ids"] = sorted(
        sample_id
        for sample_id in declared_prior_training_quarantine
        if source["split_by_sample"].get(sample_id) == "train"
    )
    prior_selected_ids: set[str] = set()
    for binding in prior["bindings"]:
        subset = read_json(Path(str(binding["path"])))
        prior_selected_ids.update(str(value) for value in subset["sample_ids"])
    prior["canonical_non_train_selected_sample_ids"] = sorted(
        sample_id
        for sample_id in prior_selected_ids
        if source["split_by_sample"].get(sample_id) != "train"
    )
    prior["canonical_non_train_excluded_sample_ids"] = sorted(
        sample_id
        for sample_id in prior["excluded_sample_ids"]
        if source["split_by_sample"].get(sample_id) != "train"
    )
    # These old rounds were selected through the path-derived split projection,
    # which disagrees with the authoritative work split.  Their labels and
    # answers are never evidence for v5.  Every canonical-train member of their
    # complete pixel/page/visual closure remains permanently out of training.
    prior["training_quarantine_sample_ids"] = sorted(
        sample_id
        for sample_id in prior["excluded_sample_ids"]
        if source["split_by_sample"].get(sample_id) == "train"
    )
    prior["round_output_disposition"] = (
        "permanently_discarded_not_calibration_or_training_evidence"
    )
    primary, primary_binding = _split_index(
        primary_split_root, expected_stage="primary", source=source
    )
    secondary, secondary_binding = _split_index(
        secondary_split_root, expected_stage="secondary", source=source
    )
    try:
        pool = _fresh_candidate_pool(
            source,
            excluded_sample_ids=frozenset(prior["excluded_sample_ids"]),
            primary=primary,
            secondary=secondary,
        )
    except delta.DeltaLedgerError as error:
        raise PreflightError(str(error)) from error
    if not pool:
        raise PreflightError("no fresh train-quarantine samples have both A stages")
    forbidden_tokens = {
        str(token).casefold()
        for token in source.get("identity_tokens", set())
        if isinstance(token, str) and token.strip()
    }
    forbidden_tokens.update(
        str(value).casefold() for value in source["alias_to_id"].keys()
    )
    forbidden_tokens.update(
        str(value).casefold() for value in source["alias_to_id"].values()
    )
    external = {
        "source": source,
        "prior": prior,
        "pool": pool,
        "primary": primary,
        "secondary": secondary,
        "source_file_bindings": source["file_bindings"],
        "source_record_bindings": {
            "rescue_report": source["source_report_record_sha256"],
            "font_signal_audit_report": source["audit_report_record_sha256"],
            "authority_successor_bridge": (
                authority_bridge["record_sha256"]
                if authority_bridge is not None
                else None
            ),
        },
        "canonical_split": canonical_split,
        "split_bindings": {
            "primary": primary_binding,
            "secondary": secondary_binding,
        },
        "forbidden_tokens": forbidden_tokens,
        "pool_fingerprint": _pool_fingerprint(pool),
        "sealed_intake": None,
        "authority_successor_bridge": authority_bridge,
    }
    if authority_bridge is not None:
        _validate_authority_pool_exclusions(pool, authority_bridge)
    for intake_root in _sealed_intake_roots(sealed_intake_root):
        _merge_sealed_intake(external, sealed_intake_root=intake_root)
    return external


def _can_select(
    candidate: Mapping[str, Any],
    *,
    selected_by_work: Mapping[str, list[Mapping[str, Any]]],
    used_conflict_keys: set[str],
    maximum_per_work: int,
    enforce_third_branch: bool,
) -> bool:
    if set(candidate["conflict_keys"]).intersection(used_conflict_keys):
        return False
    existing = selected_by_work.get(str(candidate["work_id"]), [])
    if len(existing) >= maximum_per_work:
        return False
    if enforce_third_branch and len(existing) >= 2:
        branches = {(str(row["chapter_id"]), str(row["role"])) for row in existing}
        if len(branches) < 3:
            branches.add((str(candidate["chapter_id"]), str(candidate["role"])))
            if len(branches) < 3:
                return False
    return True


def _selection_attempt(
    pool: Sequence[Mapping[str, Any]],
    *,
    targets: Mapping[str, int],
    seed: str,
    attempt: int,
    forbidden_sample_ids: set[str],
    fixed_conflict_keys: set[str],
    maximum_per_work: int,
    minimum_by_work: Mapping[str, int],
    enforce_third_branch: bool,
) -> tuple[list[Mapping[str, Any]], dict[str, int]]:
    remaining = Counter(targets)
    selected: list[Mapping[str, Any]] = []
    selected_ids: set[str] = set()
    selected_by_work: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    used_conflicts = set(fixed_conflict_keys)
    style_counts: Counter[str] = Counter()
    orientation_counts: Counter[str] = Counter()
    while sum(remaining.values()):
        feasible: dict[str, list[Mapping[str, Any]]] = {}
        for stratum, needed in remaining.items():
            if needed <= 0:
                continue
            feasible[stratum] = [
                row
                for row in pool
                if row["stratum"] == stratum
                and row["sample_id"] not in forbidden_sample_ids
                and row["sample_id"] not in selected_ids
                and _can_select(
                    row,
                    selected_by_work=selected_by_work,
                    used_conflict_keys=used_conflicts,
                    maximum_per_work=maximum_per_work,
                    enforce_third_branch=enforce_third_branch,
                )
            ]
        if not feasible or any(not rows for rows in feasible.values()):
            break
        stratum = min(
            feasible,
            key=lambda name: (
                len(feasible[name]) - remaining[name],
                len(feasible[name]) / remaining[name],
                stable_hash("preflight-v5-stratum", seed, str(attempt), name),
                name,
            ),
        )

        def key(row: Mapping[str, Any]) -> tuple[Any, ...]:
            work_rows = selected_by_work[str(row["work_id"])]
            minimum = minimum_by_work.get(str(row["work_id"]), 0)
            return (
                int(len(work_rows) >= minimum),
                len(work_rows),
                int(any(item["role"] == row["role"] for item in work_rows)),
                int(any(item["chapter_id"] == row["chapter_id"] for item in work_rows)),
                int(row["priority_rank"]),
                style_counts[str(row["style_cluster"])],
                orientation_counts[str(row["orientation"])],
                stable_hash(
                    "preflight-v5-candidate",
                    seed,
                    str(attempt),
                    str(len(selected)),
                    str(row["sample_id"]),
                ),
                str(row["sample_id"]),
            )

        chosen = min(feasible[stratum], key=key)
        selected.append(chosen)
        selected_ids.add(str(chosen["sample_id"]))
        selected_by_work[str(chosen["work_id"])].append(chosen)
        used_conflicts.update(str(value) for value in chosen["conflict_keys"])
        style_counts[str(chosen["style_cluster"])] += 1
        orientation_counts[str(chosen["orientation"])] += 1
        remaining[stratum] -= 1
    work_counts = Counter(str(row["work_id"]) for row in selected)
    minimum_shortfall = {
        work_id: max(0, minimum - work_counts.get(work_id, 0))
        for work_id, minimum in minimum_by_work.items()
    }
    result = {name: max(0, remaining[name]) for name in targets}
    result.update(
        {
            f"work:{work_id}": shortfall
            for work_id, shortfall in minimum_shortfall.items()
            if shortfall
        }
    )
    return selected, result


def _selection_objective(
    rows: Sequence[Mapping[str, Any]], *, seed: str
) -> tuple[Any, ...]:
    work_counts = Counter(str(row["work_id"]) for row in rows)
    return (
        -len(rows),
        -len(work_counts),
        max(work_counts.values(), default=0),
        sum(count * count for count in work_counts.values()),
        sum(int(row["priority_rank"]) for row in rows),
        -len({str(row["style_cluster"]) for row in rows}),
        stable_hash(seed, *sorted(str(row["sample_id"]) for row in rows)),
    )


def _milp_exact_selection(
    pool: Sequence[Mapping[str, Any]],
    *,
    targets: Mapping[str, int],
    seed: str,
    forbidden_sample_ids: set[str],
    fixed_conflict_keys: set[str],
    maximum_per_work: int,
    minimum_by_work: Mapping[str, int],
    enforce_third_branch: bool,
) -> tuple[list[Mapping[str, Any]] | None, dict[str, Any]]:
    """Use a deterministic HiGHS MILP fallback after seeded greedy search.

    This is a correctness fallback, not a source of labels.  It enforces the
    same stratum, work, page/lineage, and third-branch constraints.  If SciPy is
    unavailable or the solver cannot prove a solution, the caller fails closed.
    """

    try:
        import numpy as np
        import scipy.sparse as sparse
        from scipy.optimize import Bounds, LinearConstraint, milp
    except ImportError:
        return None, {
            "solver": "scipy_highs_milp",
            "status": "unavailable",
            "fail_closed": True,
        }
    candidates = [
        row
        for row in pool
        if row["sample_id"] not in forbidden_sample_ids
        and not set(row["conflict_keys"]).intersection(fixed_conflict_keys)
        and row["stratum"] in targets
    ]
    works = sorted({str(row["work_id"]) for row in candidates}.union(minimum_by_work))
    candidate_count = len(candidates)
    work_count = len(works)
    z_offset = candidate_count
    third_offset = z_offset + work_count
    branch_keys = sorted(
        {
            (
                str(row["work_id"]),
                str(row["chapter_id"]),
                str(row["role"]),
            )
            for row in candidates
        }
    )
    branch_offset = third_offset + (work_count if enforce_third_branch else 0)
    branch_positions = {key: index for index, key in enumerate(branch_keys)}
    variable_count = branch_offset + (len(branch_keys) if enforce_third_branch else 0)
    rows: list[tuple[list[int], list[float], float, float]] = []

    def add(
        indices: Iterable[int],
        values: Iterable[float],
        lower: float,
        upper: float,
    ) -> None:
        rows.append((list(indices), list(values), lower, upper))

    for stratum, target in targets.items():
        indices = [
            index for index, row in enumerate(candidates) if row["stratum"] == stratum
        ]
        add(indices, [1.0] * len(indices), float(target), float(target))
    for work_position, work_id in enumerate(works):
        indices = [
            index
            for index, row in enumerate(candidates)
            if str(row["work_id"]) == work_id
        ]
        z_index = z_offset + work_position
        minimum = float(minimum_by_work.get(work_id, 0))
        add(indices, [1.0] * len(indices), minimum, float(maximum_per_work))
        add(
            [*indices, z_index],
            [*([1.0] * len(indices)), -float(maximum_per_work)],
            -math.inf,
            0.0,
        )
        add([z_index, *indices], [1.0, *([-1.0] * len(indices))], -math.inf, 0.0)
        if enforce_third_branch:
            third_index = third_offset + work_position
            add(
                [*indices, third_index],
                [*([1.0] * len(indices)), -float(maximum_per_work - 2)],
                -math.inf,
                2.0,
            )
            add(
                [third_index, *indices],
                [3.0, *([-1.0] * len(indices))],
                -math.inf,
                0.0,
            )
            branches: dict[tuple[str, str, str], list[int]] = defaultdict(list)
            for candidate_index in indices:
                candidate = candidates[candidate_index]
                key = (
                    work_id,
                    str(candidate["chapter_id"]),
                    str(candidate["role"]),
                )
                branches[key].append(candidate_index)
            work_branch_variables: list[int] = []
            for branch_key, branch_indices in branches.items():
                branch_index = branch_offset + branch_positions[branch_key]
                work_branch_variables.append(branch_index)
                add(
                    [*branch_indices, branch_index],
                    [*([1.0] * len(branch_indices)), -float(len(branch_indices))],
                    -math.inf,
                    0.0,
                )
                add(
                    [branch_index, *branch_indices],
                    [1.0, *([-1.0] * len(branch_indices))],
                    -math.inf,
                    0.0,
                )
            add(
                [*work_branch_variables, third_index],
                [*([1.0] * len(work_branch_variables)), -3.0],
                0.0,
                math.inf,
            )
    conflict_groups: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(candidates):
        for conflict_key in row["conflict_keys"]:
            conflict_groups[str(conflict_key)].append(index)
    for indices in conflict_groups.values():
        if len(indices) > 1:
            add(indices, [1.0] * len(indices), -math.inf, 1.0)

    row_indices: list[int] = []
    column_indices: list[int] = []
    data: list[float] = []
    lower_bounds: list[float] = []
    upper_bounds: list[float] = []
    for row_index, (indices, values, lower, upper) in enumerate(rows):
        if len(indices) != len(values):
            raise PreflightError("internal MILP row length changed")
        for column, value in zip(indices, values):
            row_indices.append(row_index)
            column_indices.append(column)
            data.append(value)
        lower_bounds.append(lower)
        upper_bounds.append(upper)
    matrix = sparse.coo_matrix(
        (data, (row_indices, column_indices)),
        shape=(len(rows), variable_count),
    ).tocsr()
    objective = np.zeros(variable_count, dtype=np.float64)
    for index, row in enumerate(candidates):
        stable_fraction = int(
            stable_hash("preflight-v5-milp", seed, str(row["sample_id"]))[:13],
            16,
        ) / float(16**13)
        objective[index] = float(row["priority_rank"]) * 0.1 + stable_fraction * 1e-4
    for work_position in range(work_count):
        objective[z_offset + work_position] = -100.0
        if enforce_third_branch:
            objective[third_offset + work_position] = 1.0
    try:
        result = milp(
            objective,
            integrality=np.ones(variable_count, dtype=np.int8),
            bounds=Bounds(np.zeros(variable_count), np.ones(variable_count)),
            constraints=LinearConstraint(
                matrix,
                np.asarray(lower_bounds),
                np.asarray(upper_bounds),
            ),
            options={"time_limit": 120.0, "mip_rel_gap": 0.0},
        )
    except (RuntimeError, ValueError) as error:
        return None, {
            "solver": "scipy_highs_milp",
            "status": "error",
            "error_type": type(error).__name__,
            "fail_closed": True,
        }
    audit = {
        "solver": "scipy_highs_milp",
        "status_code": int(result.status),
        "status": str(result.message),
        "candidate_variable_count": candidate_count,
        "work_indicator_count": work_count,
        "branch_indicator_count": len(branch_keys) if enforce_third_branch else 0,
        "constraint_count": len(rows),
        "objective_seed_sha256": sha256_bytes(seed.encode("utf-8")),
        "optimality_required": True,
        "fail_closed": result.status != 0,
    }
    if result.status != 0 or result.x is None:
        return None, audit
    selected = [
        row for index, row in enumerate(candidates) if float(result.x[index]) > 0.5
    ]
    if Counter(str(row["stratum"]) for row in selected) != Counter(targets):
        raise PreflightError("MILP returned a non-exact stratum selection")
    work_counts = Counter(str(row["work_id"]) for row in selected)
    if max(work_counts.values(), default=0) > maximum_per_work:
        raise PreflightError("MILP exceeded the work cap")
    minimum_shortfall = {
        work_id: minimum - work_counts.get(work_id, 0)
        for work_id, minimum in minimum_by_work.items()
        if work_counts.get(work_id, 0) < minimum
    }
    if minimum_shortfall:
        raise PreflightError("MILP violated a required work minimum")
    used_conflicts: set[str] = set()
    for row in selected:
        conflicts = {str(value) for value in row["conflict_keys"]}
        if conflicts.intersection(used_conflicts):
            raise PreflightError("MILP reused a page or visual lineage")
        used_conflicts.update(conflicts)
    if enforce_third_branch:
        for work_id, count in work_counts.items():
            if (
                count >= 3
                and len(
                    {
                        (str(row["chapter_id"]), str(row["role"]))
                        for row in selected
                        if str(row["work_id"]) == work_id
                    }
                )
                < 3
            ):
                raise PreflightError("MILP violated the third-branch rule")
    return selected, audit


def _select_exact(
    pool: Sequence[Mapping[str, Any]],
    *,
    targets: Mapping[str, int],
    seed: str,
    forbidden_sample_ids: set[str] | None = None,
    fixed_conflict_keys: set[str] | None = None,
    maximum_per_work: int = DEFAULT_MAX_PER_WORK,
    minimum_by_work: Mapping[str, int] | None = None,
    require_milp_proof: bool = False,
    enforce_third_branch: bool,
) -> tuple[list[Mapping[str, Any]] | None, dict[str, Any]]:
    if set(targets) - set(INITIAL_TARGETS) or any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in targets.values()
    ):
        raise PreflightError("selection targets are invalid")
    if (
        isinstance(maximum_per_work, bool)
        or not isinstance(maximum_per_work, int)
        or maximum_per_work < 1
    ):
        raise PreflightError("maximum_per_work is invalid")
    minimums = {
        _identifier(work_id, "minimum_by_work.work_id"): minimum
        for work_id, minimum in (minimum_by_work or {}).items()
    }
    if any(
        isinstance(minimum, bool)
        or not isinstance(minimum, int)
        or minimum < 0
        or minimum > maximum_per_work
        for minimum in minimums.values()
    ):
        raise PreflightError("minimum_by_work is invalid")
    forbidden = set(forbidden_sample_ids or set())
    fixed = set(fixed_conflict_keys or set())
    available = [
        row
        for row in pool
        if row["sample_id"] not in forbidden
        and not set(row["conflict_keys"]).intersection(fixed)
        and row["stratum"] in targets
    ]
    capacity = Counter(str(row["stratum"]) for row in available)
    work_capacity = Counter(str(row["work_id"]) for row in available)
    capped_work_capacity = sum(
        min(maximum_per_work, count) for count in work_capacity.values()
    )
    target_total = sum(targets.values())
    if sum(minimums.values()) > target_total:
        raise PreflightError("required work minimums exceed the exact target count")
    hard_stratum_shortfall = {
        name: max(0, target - capacity.get(name, 0)) for name, target in targets.items()
    }
    raw_minimum_shortfall = {
        work_id: max(0, minimum - work_capacity.get(work_id, 0))
        for work_id, minimum in minimums.items()
    }
    audit: dict[str, Any] = {
        "targets": dict(targets),
        "eligible_capacity": {name: capacity.get(name, 0) for name in targets},
        "eligible_work_count": len(work_capacity),
        "work_capped_capacity": capped_work_capacity,
        "work_capped_shortfall": max(0, target_total - capped_work_capacity),
        "hard_stratum_shortfall": hard_stratum_shortfall,
        "required_minimum_by_work": dict(sorted(minimums.items())),
        "raw_minimum_shortfall_by_work": {
            work_id: shortfall
            for work_id, shortfall in sorted(raw_minimum_shortfall.items())
            if shortfall
        },
        "attempt_count": 0,
        "milp_proof_required": require_milp_proof,
        "enforce_third_chapter_role_branch": enforce_third_branch,
        "maximum_samples_per_work": maximum_per_work,
        "maximum_samples_per_page_or_visual_lineage": 1,
    }
    if (
        any(hard_stratum_shortfall.values())
        or any(raw_minimum_shortfall.values())
        or capped_work_capacity < target_total
    ):
        audit["hard_capacity_failure"] = True
        return None, audit
    best_rows: list[Mapping[str, Any]] = []
    best_remaining = dict(targets)
    feasible: list[tuple[tuple[Any, ...], int, list[Mapping[str, Any]]]] = []
    if not require_milp_proof:
        for attempt in range(SELECTION_ATTEMPTS):
            rows, remaining = _selection_attempt(
                pool,
                targets=targets,
                seed=seed,
                attempt=attempt,
                forbidden_sample_ids=forbidden,
                fixed_conflict_keys=fixed,
                maximum_per_work=maximum_per_work,
                minimum_by_work=minimums,
                enforce_third_branch=enforce_third_branch,
            )
            if len(rows) > len(best_rows) or (
                len(rows) == len(best_rows)
                and _selection_objective(rows, seed=seed)
                < _selection_objective(best_rows, seed=seed)
            ):
                best_rows = rows
                best_remaining = remaining
            if not any(remaining.values()):
                feasible.append((_selection_objective(rows, seed=seed), attempt, rows))
        audit["attempt_count"] = SELECTION_ATTEMPTS
    if require_milp_proof or not feasible:
        if not require_milp_proof:
            audit["best_selected_count"] = len(best_rows)
            audit["best_shortfall"] = best_remaining
        exact, exact_audit = _milp_exact_selection(
            pool,
            targets=targets,
            seed=seed,
            forbidden_sample_ids=forbidden,
            fixed_conflict_keys=fixed,
            maximum_per_work=maximum_per_work,
            minimum_by_work=minimums,
            enforce_third_branch=enforce_third_branch,
        )
        audit["exact_solver"] = exact_audit
        if exact is None:
            return None, audit
        exact_attempt = 0 if require_milp_proof else SELECTION_ATTEMPTS
        feasible.append((_selection_objective(exact, seed=seed), exact_attempt, exact))
    _, attempt, selected = min(feasible, key=lambda item: (item[0], item[1]))
    ordered = sorted(
        selected,
        key=lambda row: (
            stable_hash("preflight-v5-order", seed, str(row["sample_id"])),
            str(row["sample_id"]),
        ),
    )
    counts = Counter(str(row["stratum"]) for row in ordered)
    work_counts = Counter(str(row["work_id"]) for row in ordered)
    minimum_shortfall = {
        work_id: minimum - work_counts.get(work_id, 0)
        for work_id, minimum in minimums.items()
        if work_counts.get(work_id, 0) < minimum
    }
    if (
        counts != Counter(targets)
        or max(work_counts.values(), default=0) > maximum_per_work
        or minimum_shortfall
    ):
        raise PreflightError("internal exact selection invariant failed")
    audit.update(
        {
            "selected_attempt": attempt,
            "selected_count": len(ordered),
            "selected_work_count": len(work_counts),
            "maximum_selected_in_one_work": max(work_counts.values(), default=0),
            "selected_counts_by_work": dict(sorted(work_counts.items())),
            "selected_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes([str(row["sample_id"]) for row in ordered])
            ),
        }
    )
    return ordered, audit


def _canonical_train_work_ids(external: Mapping[str, Any]) -> list[str]:
    canonical_split = external["canonical_split"]
    return sorted(
        work_id
        for work_id in canonical_split["source_work_ids"]
        if canonical_split["work_assignments"][work_id] == "train"
    )


def _balanced_initial_selection(
    external: Mapping[str, Any], *, selection_seed: str
) -> tuple[
    list[Mapping[str, Any]] | None,
    dict[str, Any],
    list[dict[str, Any]],
]:
    train_work_ids = _canonical_train_work_ids(external)
    minimums = {
        work_id: BALANCED_INITIAL_MINIMUM_PER_WORK for work_id in train_work_ids
    }
    if sum(minimums.values()) > INITIAL_COUNT:
        raise PreflightError(
            "minimum-per-train-work balance exceeds the exact initial reserve size"
        )
    trials: list[dict[str, Any]] = []
    selected_audit: dict[str, Any] | None = None
    for maximum in BALANCED_INITIAL_CAP_CANDIDATES:
        selected, audit = _select_exact(
            external["pool"],
            targets=INITIAL_TARGETS,
            seed=selection_seed,
            maximum_per_work=maximum,
            minimum_by_work=minimums,
            require_milp_proof=True,
            enforce_third_branch=False,
        )
        counts = (
            Counter(str(row["work_id"]) for row in selected)
            if selected is not None
            else Counter()
        )
        trials.append(
            {
                "maximum_samples_per_work": maximum,
                "minimum_samples_per_canonical_train_work": (
                    BALANCED_INITIAL_MINIMUM_PER_WORK
                ),
                "required_canonical_train_work_count": len(train_work_ids),
                "feasible": selected is not None,
                "selected_count": len(selected) if selected is not None else 0,
                "selected_counts_by_work": dict(sorted(counts.items())),
                "selection_audit": audit,
            }
        )
        selected_audit = audit
        if selected is not None:
            return selected, audit, trials
    assert selected_audit is not None
    return None, selected_audit, trials


def _task_id(round_id: str, draw_index: int, stage: str, sample_id: str) -> str:
    return "check-" + stable_hash(round_id, str(draw_index), stage, sample_id)[:24]


def _copy_bound_source(source: Mapping[str, Any], target: Path) -> dict[str, Any]:
    source_path = Path(_text(source.get("path"), "source.path")).resolve()
    expected_sha = _sha(source.get("sha256"), "source.sha256")
    payload = source_path.read_bytes()
    if sha256_bytes(payload) != expected_sha:
        raise PreflightError(f"source-only card changed: {source_path}")
    _write_once(target, payload)
    return {
        "path": target.name,
        "sha256": expected_sha,
        "pixel_sha256": _sha(source.get("pixel_sha256"), "source.pixel_sha256"),
        "size_px": list(source.get("size_px", [])),
    }


def _build_draw_directory(
    *,
    temporary_draw: Path,
    final_draw_relative: PurePosixPath,
    round_id: str,
    draw_index: int,
    kind: str,
    selection_seed: str,
    targets: Mapping[str, int],
    selected: Sequence[Mapping[str, Any]],
    selection_audit: Mapping[str, Any],
    external: Mapping[str, Any],
    previous_manifest_sha256: str | None,
    replacement_request: Mapping[str, Any] | None,
) -> dict[str, Any]:
    draw_id = f"{draw_index:03d}-{'initial' if kind == 'initial' else 'extension'}"
    if temporary_draw.exists() and any(temporary_draw.iterdir()):
        raise PreflightError(f"temporary draw is not empty: {temporary_draw}")
    temporary_draw.mkdir(parents=True, exist_ok=True)
    private_rows: list[dict[str, Any]] = []
    public_by_stage: dict[str, list[dict[str, Any]]] = {
        stage: [] for stage in REVIEWER_STAGES
    }
    for review_order, candidate in enumerate(selected, start=1):
        sample_id = str(candidate["sample_id"])
        tasks: dict[str, str] = {}
        source_bindings: dict[str, Any] = {}
        for reviewer_stage, source_stage, card_key in (
            ("reviewer-a", "primary", "primary"),
            ("reviewer-b", "secondary", "secondary"),
        ):
            task_id = _task_id(round_id, draw_index, reviewer_stage, sample_id)
            tasks[reviewer_stage] = task_id
            split_binding = external[card_key][sample_id]
            relative = PurePosixPath("source-only", reviewer_stage, f"{task_id}.png")
            local_path = temporary_draw / Path(*relative.parts)
            copied = _copy_bound_source(split_binding["source_only"], local_path)
            public_path = (final_draw_relative / relative).as_posix()
            public = seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "source_only_eligibility_task",
                    "task_id": task_id,
                    "reviewer_stage": reviewer_stage,
                    "review_order": review_order,
                    "source_only": {
                        "path": public_path,
                        "sha256": copied["sha256"],
                        "pixel_sha256": copied["pixel_sha256"],
                        "size_px": copied["size_px"],
                    },
                    "check_ids": list(CHECK_IDS),
                }
            )
            public_by_stage[reviewer_stage].append(public)
            source_bindings[source_stage] = {
                "assignment_id": split_binding["assignment_id"],
                "source_only": copy.deepcopy(split_binding["source_only"]),
                "candidate_only_private": copy.deepcopy(
                    split_binding["candidate_only"]
                ),
                "public_source_sha256": copied["sha256"],
            }
        private_rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "source_only_eligibility_private_binding",
                    "draw_id": draw_id,
                    "sample_id": sample_id,
                    "task_ids": tasks,
                    "stratum": str(candidate["stratum"]),
                    "role_private": str(candidate["role"]),
                    "work_id": str(candidate["work_id"]),
                    "chapter_id": str(candidate["chapter_id"]),
                    "page_key": str(candidate["page_key"]),
                    "visual_lineage_conflict_keys": sorted(
                        str(value) for value in candidate["conflict_keys"]
                    ),
                    "source_stages": source_bindings,
                }
            )
        )
    private_payload = jsonl_bytes(private_rows)
    _write_once(temporary_draw / "private-bindings.jsonl", private_payload)
    for stage in REVIEWER_STAGES:
        _write_once(
            temporary_draw / f"tasks-{stage}.jsonl",
            jsonl_bytes(public_by_stage[stage]),
        )
    managed: dict[str, str] = {}
    for path in sorted(temporary_draw.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            managed[path.relative_to(temporary_draw).as_posix()] = sha256_file(path)
    manifest = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "source_only_eligibility_draw",
            "draw_id": draw_id,
            "draw_index": draw_index,
            "kind": kind,
            "selection_seed": selection_seed,
            "requested_quotas": dict(targets),
            "selected_count": len(selected),
            "selected_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes([str(row["sample_id"]) for row in selected])
            ),
            "selection_audit": dict(selection_audit),
            "previous_draw_manifest_sha256": previous_manifest_sha256,
            "replacement_request": (
                {
                    "path": str(replacement_request["path"]),
                    "sha256": str(replacement_request["sha256"]),
                    "record_sha256": str(replacement_request["record_sha256"]),
                }
                if replacement_request is not None
                else None
            ),
            "managed_files": managed,
            "private_bindings_sha256": sha256_bytes(private_payload),
            "task_counts": {
                stage: len(public_by_stage[stage]) for stage in REVIEWER_STAGES
            },
            "candidate_pixels_on_public_surface": False,
            "private_stratum_on_public_surface": False,
        }
    )
    _write_once(
        temporary_draw / "manifest.json", canonical_json_bytes(manifest, pretty=True)
    )
    return manifest


def _external_fingerprint(external: Mapping[str, Any]) -> dict[str, Any]:
    prior = external["prior"]
    canonical_split = external["canonical_split"]
    return {
        "source_file_bindings_sha256": sha256_bytes(
            canonical_json_bytes(external["source_file_bindings"])
        ),
        "source_record_bindings": dict(external["source_record_bindings"]),
        "prior_subset_bindings_sha256": sha256_bytes(
            canonical_json_bytes(prior["bindings"])
        ),
        "prior_excluded_sample_ids_sha256": sha256_bytes(
            canonical_json_bytes(prior["excluded_sample_ids"])
        ),
        "prior_training_quarantine_ids_sha256": sha256_bytes(
            canonical_json_bytes(prior["training_quarantine_sample_ids"])
        ),
        "prior_declared_training_quarantine_ids_sha256": sha256_bytes(
            canonical_json_bytes(prior["declared_training_quarantine_sample_ids"])
        ),
        "prior_canonical_non_train_quarantine_ids_sha256": sha256_bytes(
            canonical_json_bytes(
                prior["canonical_non_train_declared_quarantine_sample_ids"]
            )
        ),
        "prior_canonical_non_train_selected_ids_sha256": sha256_bytes(
            canonical_json_bytes(prior["canonical_non_train_selected_sample_ids"])
        ),
        "prior_canonical_non_train_excluded_ids_sha256": sha256_bytes(
            canonical_json_bytes(prior["canonical_non_train_excluded_sample_ids"])
        ),
        "prior_round_output_disposition": prior["round_output_disposition"],
        "master_split_map": copy.deepcopy(canonical_split["file_binding"]),
        "canonical_work_assignments_sha256": sha256_bytes(
            canonical_json_bytes(canonical_split["work_assignments"])
        ),
        "canonical_source_work_assignment_counts": copy.deepcopy(
            canonical_split["source_work_assignment_counts"]
        ),
        "legacy_view_path_mismatch_count": canonical_split[
            "legacy_path_mismatch_count"
        ],
        "legacy_view_path_mismatch_sample_ids_sha256": canonical_split[
            "legacy_path_mismatch_sample_ids_sha256"
        ],
        "split_bindings": copy.deepcopy(external["split_bindings"]),
        "eligible_pool_sha256": str(external["pool_fingerprint"]),
        "eligible_pool_count": len(external["pool"]),
        "forbidden_identity_tokens_sha256": sha256_bytes(
            canonical_json_bytes(sorted(external["forbidden_tokens"]))
        ),
        "sealed_intake": copy.deepcopy(external.get("sealed_intake")),
        "authority_successor_bridge": copy.deepcopy(
            external.get("authority_successor_bridge")
        ),
    }


def _feasibility_report(
    external: Mapping[str, Any], *, selection_seed: str
) -> dict[str, Any]:
    selected, audit, cap_trials = _balanced_initial_selection(
        external, selection_seed=selection_seed
    )
    capacities = Counter(str(row["stratum"]) for row in external["pool"])
    shortfalls = {
        name: max(0, target - capacities.get(name, 0))
        for name, target in INITIAL_TARGETS.items()
    }
    short_strata_ids = {
        name: sorted(
            str(row["sample_id"]) for row in external["pool"] if row["stratum"] == name
        )
        for name, shortfall in shortfalls.items()
        if shortfall
    }
    source = external["source"]
    canonical_split = external["canonical_split"]
    all_source_works = list(canonical_split["source_work_ids"])
    canonical_train_works = _canonical_train_work_ids(external)
    canonical_non_train_works = {
        split_name: sorted(
            work_id
            for work_id in all_source_works
            if canonical_split["work_assignments"][work_id] == split_name
        )
        for split_name in ("val", "test")
    }
    eligible_works = sorted({str(row["work_id"]) for row in external["pool"]})
    if set(eligible_works) - set(canonical_train_works):
        raise PreflightError("eligible pool contains a canonical val/test work")
    eligible_counts_by_work = Counter(str(row["work_id"]) for row in external["pool"])
    trial_maximum = BALANCED_INITIAL_CAP_CANDIDATES[-1]
    source_train_work_ceiling = len(canonical_train_works) * trial_maximum
    quota_capacity_ceiling = sum(
        min(target, capacities.get(name, 0)) for name, target in INITIAL_TARGETS.items()
    )
    minimum_new_lineages_for_quotas = sum(shortfalls.values())
    legacy_cap = 3
    legacy_ceiling = len(canonical_train_works) * legacy_cap
    alternative_new_train_works = max(
        0, math.ceil((INITIAL_COUNT - legacy_ceiling) / legacy_cap)
    )
    smallest_feasible_cap = (
        int(audit["maximum_samples_per_work"]) if selected is not None else None
    )
    selected_work_size_distribution = Counter(
        Counter(str(row["work_id"]) for row in selected).values()
        if selected is not None
        else []
    )
    extension_contract = copy.deepcopy(MINIMUM_SOURCE_EXTENSION_CONTRACT)
    extension_contract["derived_lower_bounds"] = {
        "canonical_train_work_count": len(canonical_train_works),
        "current_eligible_train_work_count": len(eligible_works),
        "minimum_total_new_eligible_lineages_for_current_quota_gaps": (
            minimum_new_lineages_for_quotas
        ),
        "stratum_capacity_shortfalls": shortfalls,
        "lower_bounds_only_not_a_feasibility_attestation": True,
    }
    extension_contract["balanced_existing_work_strategy"] = {
        "cap_trial_order": list(BALANCED_INITIAL_CAP_CANDIDATES),
        "minimum_per_canonical_train_work": BALANCED_INITIAL_MINIMUM_PER_WORK,
        "cap_five_selected_distribution_if_feasible": {
            f"works_with_{count}": selected_work_size_distribution.get(count, 0)
            for count in range(
                BALANCED_INITIAL_MINIMUM_PER_WORK,
                BALANCED_INITIAL_CAP_CANDIDATES[0] + 1,
            )
        },
        "new_work_ids_required_by_policy": 0,
    }
    extension_contract["alternative_legacy_max3_scenario_only"] = {
        "not_the_default_policy": True,
        "maximum_per_work": legacy_cap,
        "current_source_ceiling": legacy_ceiling,
        "minimum_genuinely_new_train_work_ids": alternative_new_train_works,
        "minimum_lineages_across_those_new_works": (
            alternative_new_train_works * legacy_cap
        ),
    }
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "source_only_eligibility_feasibility_report",
            "selection_seed": selection_seed,
            "feasible": selected is not None,
            "required_initial_count": INITIAL_COUNT,
            "required_initial_quotas": dict(INITIAL_TARGETS),
            "eligible_pool_count": len(external["pool"]),
            "eligible_pool_sha256": external["pool_fingerprint"],
            "eligible_capacity_by_stratum": {
                name: capacities.get(name, 0) for name in INITIAL_TARGETS
            },
            "hard_capacity_shortfall_by_stratum": shortfalls,
            "quota_capacity_ceiling_before_cross_constraints": quota_capacity_ceiling,
            "eligible_work_count": len(eligible_works),
            "eligible_counts_by_canonical_train_work": {
                work_id: eligible_counts_by_work.get(work_id, 0)
                for work_id in canonical_train_works
            },
            "source_work_count": len(all_source_works),
            "canonical_train_work_count": len(canonical_train_works),
            "canonical_train_work_ids_without_fresh_eligible_samples": sorted(
                set(canonical_train_works) - set(eligible_works)
            ),
            "canonical_non_train_work_ids": canonical_non_train_works,
            "balanced_initial_minimum_per_canonical_train_work": (
                BALANCED_INITIAL_MINIMUM_PER_WORK
            ),
            "balanced_initial_cap_trial_order": list(BALANCED_INITIAL_CAP_CANDIDATES),
            "smallest_feasible_balanced_cap": smallest_feasible_cap,
            "balanced_cap_trials": cap_trials,
            "cap_five_balance_contract": {
                "description": "all_train_works_three_to_five_only",
                **{
                    f"works_with_{count}": selected_work_size_distribution.get(count, 0)
                    for count in range(
                        BALANCED_INITIAL_MINIMUM_PER_WORK,
                        BALANCED_INITIAL_CAP_CANDIDATES[0] + 1,
                    )
                },
                "specific_work_assignment_is_solver_derived": True,
            },
            "source_train_work_ceiling_at_largest_trial_cap": (
                source_train_work_ceiling
            ),
            "irreducibly_infeasible_with_current_frozen_work_assignments": False,
            "current_failure_is_quota_capacity_not_frozen_work_count": (
                selected is None and any(shortfalls.values())
            ),
            "work_capped_capacity": audit["work_capped_capacity"],
            "work_capped_shortfall": audit["work_capped_shortfall"],
            "fresh_sample_ids_in_short_strata": short_strata_ids,
            "selected_count": len(selected) if selected is not None else 0,
            "selected_work_count": (
                len({str(row["work_id"]) for row in selected})
                if selected is not None
                else 0
            ),
            "selection_audit": audit,
            "source_inventory_contract": {
                "selection_count": len(source["selection"]),
                "review_ready_inventory_count": len(source["inventory"]),
                "master_count": len(source["master"]),
                "split_counts": dict(
                    sorted(Counter(source["split_by_sample"].values()).items())
                ),
                "primary_v5_card_count": len(external["primary"]),
                "secondary_v5_card_count": len(external["secondary"]),
                "sealed_intake_source_count": (
                    int(external["sealed_intake"]["count"])
                    if external.get("sealed_intake") is not None
                    else 0
                ),
                "sealed_intake_binding": copy.deepcopy(external.get("sealed_intake")),
                "prior_leakage_closure_count": len(
                    external["prior"]["excluded_sample_ids"]
                ),
                "prior_training_quarantine_count": len(
                    external["prior"]["training_quarantine_sample_ids"]
                ),
                "prior_declared_training_quarantine_count": len(
                    external["prior"]["declared_training_quarantine_sample_ids"]
                ),
                "prior_canonical_non_train_declared_quarantine_count": len(
                    external["prior"][
                        "canonical_non_train_declared_quarantine_sample_ids"
                    ]
                ),
                "prior_canonical_non_train_selected_count": len(
                    external["prior"]["canonical_non_train_selected_sample_ids"]
                ),
                "prior_canonical_non_train_excluded_count": len(
                    external["prior"]["canonical_non_train_excluded_sample_ids"]
                ),
                "prior_round_output_disposition": external["prior"][
                    "round_output_disposition"
                ],
                "legacy_view_path_split_mismatch_count": canonical_split[
                    "legacy_path_mismatch_count"
                ],
                "external_fingerprint": _external_fingerprint(external),
            },
            "frozen_split_contracts": copy.deepcopy(FROZEN_SPLIT_CONTRACTS),
            "minimum_source_extension_contract": extension_contract,
        }
    )


def evaluate_feasibility(
    *,
    rescue_inputs: Path,
    font_signal_audit: Path,
    master_split_map: Path,
    prior_calibration_subsets: Sequence[Path],
    primary_split_root: Path,
    secondary_split_root: Path,
    selection_seed: str,
    sealed_intake_root: Path | Sequence[Path] | None = None,
    successor_bridge_root: Path | None = None,
) -> dict[str, Any]:
    _text(selection_seed, "selection_seed")
    external = _load_external(
        rescue_inputs=rescue_inputs,
        font_signal_audit=font_signal_audit,
        master_split_map=master_split_map,
        prior_calibration_subsets=prior_calibration_subsets,
        primary_split_root=primary_split_root,
        secondary_split_root=secondary_split_root,
        sealed_intake_root=sealed_intake_root,
        successor_bridge_root=successor_bridge_root,
    )
    return _feasibility_report(external, selection_seed=selection_seed)


def initialize_workspace(
    *,
    workspace: Path,
    rescue_inputs: Path,
    font_signal_audit: Path,
    master_split_map: Path,
    prior_calibration_subsets: Sequence[Path],
    primary_split_root: Path,
    secondary_split_root: Path,
    rubric: Path,
    round_id: str,
    selection_seed: str,
    sealed_intake_root: Path | Sequence[Path] | None = None,
    successor_bridge_root: Path | None = None,
) -> dict[str, Any]:
    target = workspace.resolve()
    if target.exists():
        raise PreflightError(f"workspace must not exist: {target}")
    _identifier(round_id, "round_id")
    _text(selection_seed, "selection_seed")
    if rubric.name != "font-matching-v2-review-rubric-v5.md" or not rubric.is_file():
        raise PreflightError("the sealed v5 review rubric is required")
    intake_roots = _sealed_intake_roots(sealed_intake_root)
    input_roots = [
        rescue_inputs,
        font_signal_audit,
        master_split_map.parent,
        primary_split_root,
        secondary_split_root,
        *(path.parent for path in prior_calibration_subsets),
        *intake_roots,
        *([successor_bridge_root] if successor_bridge_root is not None else []),
    ]
    _assert_disjoint(target, input_roots)
    external = _load_external(
        rescue_inputs=rescue_inputs,
        font_signal_audit=font_signal_audit,
        master_split_map=master_split_map,
        prior_calibration_subsets=prior_calibration_subsets,
        primary_split_root=primary_split_root,
        secondary_split_root=secondary_split_root,
        sealed_intake_root=sealed_intake_root,
        successor_bridge_root=successor_bridge_root,
    )
    selected, audit, _ = _balanced_initial_selection(
        external, selection_seed=selection_seed
    )
    if selected is None or len(selected) != INITIAL_COUNT:
        feasibility = _feasibility_report(external, selection_seed=selection_seed)
        raise PreflightError(
            "cannot draw the sealed 72-sample reserve under exact quotas and diversity caps; "
            "no quota or quarantine rule was relaxed; "
            f"feasibility_report={json.dumps(feasibility, ensure_ascii=False, sort_keys=True)}"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=target.parent))
    try:
        draw_root = temporary / "draws" / "000-initial"
        draw_manifest = _build_draw_directory(
            temporary_draw=draw_root,
            final_draw_relative=PurePosixPath("draws", "000-initial"),
            round_id=round_id,
            draw_index=0,
            kind="initial",
            selection_seed=selection_seed,
            targets=INITIAL_TARGETS,
            selected=selected,
            selection_audit=audit,
            external=external,
            previous_manifest_sha256=None,
            replacement_request=None,
        )
        contract = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "source_only_eligibility_workspace_contract",
                "round_id": round_id,
                "selection_seed": selection_seed,
                "development_only": True,
                "source_split": "train_quarantine",
                "test_split_forbidden": True,
                "rubric": _file_binding(rubric),
                "inputs": {
                    "rescue_inputs": str(rescue_inputs.resolve()),
                    "font_signal_audit": str(font_signal_audit.resolve()),
                    "master_split_map": str(master_split_map.resolve()),
                    "prior_calibration_subsets": [
                        str(path.resolve()) for path in prior_calibration_subsets
                    ],
                    "primary_split_root": str(primary_split_root.resolve()),
                    "secondary_split_root": str(secondary_split_root.resolve()),
                    "sealed_intake_root": (
                        None
                        if not intake_roots
                        else (
                            str(intake_roots[0])
                            if len(intake_roots) == 1
                            else [str(path) for path in intake_roots]
                        )
                    ),
                    "successor_bridge_root": (
                        str(successor_bridge_root.resolve())
                        if successor_bridge_root is not None
                        else None
                    ),
                },
                "external_fingerprint": _external_fingerprint(external),
                "initial_targets": dict(INITIAL_TARGETS),
                "scored_targets": dict(SCORED_TARGETS),
                "initial_draw_manifest_sha256": draw_manifest["record_sha256"],
                "review_contract": {
                    "source_only_before_candidate_stage": True,
                    "two_independent_reviewers": True,
                    "checks": list(CHECK_IDS),
                    "disposition_derived_from_all_four_checks": True,
                    "candidate_pixels_public": False,
                    "role_tier_translation_answers_allowed": False,
                },
                "diversity_contract": {
                    "initial_maximum_per_work": audit["maximum_samples_per_work"],
                    "initial_minimum_per_canonical_train_work": (
                        BALANCED_INITIAL_MINIMUM_PER_WORK
                    ),
                    "initial_required_canonical_train_work_ids": (
                        _canonical_train_work_ids(external)
                    ),
                    "extension_maximum_per_work_per_draw": audit[
                        "maximum_samples_per_work"
                    ],
                    "final_maximum_per_work": audit["maximum_samples_per_work"],
                    "maximum_per_page_or_visual_lineage": 1,
                    "final_third_sample_distinct_chapter_role_branch": True,
                },
            }
        )
        _write_once(
            temporary / "contract.json", canonical_json_bytes(contract, pretty=True)
        )
        if target.exists():
            raise PreflightError(f"workspace appeared during initialization: {target}")
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {
        "workspace": str(target),
        "status": "initialized_source_only",
        "initial_samples": INITIAL_COUNT,
        "review_tasks_per_reviewer": INITIAL_COUNT,
        "initial_draw_record_sha256": draw_manifest["record_sha256"],
    }


def _public_task_safe(task: Mapping[str, Any], forbidden_tokens: set[str]) -> None:
    _exact_keys(
        task,
        {
            "schema_version",
            "record_type",
            "task_id",
            "reviewer_stage",
            "review_order",
            "source_only",
            "check_ids",
            "record_sha256",
        },
        "public task",
    )
    validate_seal(task, "public task")
    if (
        task.get("schema_version") != SCHEMA_VERSION
        or task.get("record_type") != "source_only_eligibility_task"
    ):
        raise PreflightError("public task schema changed")
    if task.get("reviewer_stage") not in REVIEWER_STAGES:
        raise PreflightError("public task reviewer stage changed")
    if task.get("check_ids") != list(CHECK_IDS):
        raise PreflightError("public task checks changed")
    source_only = _mapping(task.get("source_only"), "public task.source_only")
    _exact_keys(
        source_only,
        {"path", "sha256", "pixel_sha256", "size_px"},
        "public task.source_only",
    )
    serialized = canonical_json_bytes(task).decode("utf-8").casefold()
    if ALIAS_RE.search(serialized):
        raise PreflightError("public task leaks a candidate alias")
    for token in forbidden_tokens:
        if token and token in serialized:
            raise PreflightError("public task leaks a candidate identity")


def _load_draws(
    workspace: Path, external: Mapping[str, Any], contract: Mapping[str, Any]
) -> list[dict[str, Any]]:
    draws_root = workspace / "draws"
    directories = sorted(path for path in draws_root.iterdir() if path.is_dir())
    if not directories:
        raise PreflightError("workspace has no draws")
    pool_by_id = {str(row["sample_id"]): row for row in external["pool"]}
    diversity = _mapping(contract.get("diversity_contract"), "diversity_contract")
    initial_maximum = diversity.get("initial_maximum_per_work")
    initial_minimum = diversity.get("initial_minimum_per_canonical_train_work")
    initial_required_work_ids = [
        _identifier(value, "initial_required_canonical_train_work_id")
        for value in _list(
            diversity.get("initial_required_canonical_train_work_ids"),
            "initial_required_canonical_train_work_ids",
        )
    ]
    extension_maximum = diversity.get("extension_maximum_per_work_per_draw")
    draws: list[dict[str, Any]] = []
    drawn_ids: set[str] = set()
    used_conflicts: set[str] = set()
    previous_sha: str | None = None
    for expected_index, draw_root in enumerate(directories):
        match = DRAW_RE.fullmatch(draw_root.name)
        if match is None or int(match.group("index")) != expected_index:
            raise PreflightError(
                "draw directories are not a contiguous append-only chain"
            )
        manifest_path = draw_root / "manifest.json"
        manifest = read_json(manifest_path)
        validate_seal(manifest, f"draw[{expected_index}]")
        if (
            manifest.get("schema_version") != SCHEMA_VERSION
            or manifest.get("record_type") != "source_only_eligibility_draw"
            or manifest.get("draw_index") != expected_index
            or manifest.get("draw_id") != draw_root.name
            or manifest.get("previous_draw_manifest_sha256") != previous_sha
        ):
            raise PreflightError(f"draw[{expected_index}] chain changed")
        expected_kind = "initial" if expected_index == 0 else "extension"
        if manifest.get("kind") != expected_kind:
            raise PreflightError(f"draw[{expected_index}] kind changed")
        replacement_binding = manifest.get("replacement_request")
        if expected_index == 0:
            if (
                replacement_binding is not None
                or manifest.get("requested_quotas") != INITIAL_TARGETS
                or manifest.get("selection_seed") != contract.get("selection_seed")
            ):
                raise PreflightError("initial draw contract changed")
        else:
            replacement = _mapping(
                replacement_binding, f"draw[{expected_index}].replacement_request"
            )
            _exact_keys(
                replacement,
                {"path", "sha256", "record_sha256"},
                f"draw[{expected_index}].replacement_request",
            )
            request_relative = _safe_relative(
                replacement.get("path"),
                f"draw[{expected_index}].replacement_request.path",
            )
            request_path = _resolve_inside(
                workspace,
                request_relative,
                f"draw[{expected_index}].replacement_request.path",
            )
            request = read_json(request_path)
            validate_seal(request, f"draw[{expected_index}].replacement_request")
            if (
                sha256_file(request_path) != replacement.get("sha256")
                or request.get("record_sha256") != replacement.get("record_sha256")
                or request.get("draw_count") != expected_index
                or manifest.get("requested_quotas")
                != {
                    name: value
                    for name, value in request[
                        "requested_fresh_same_stratum_counts"
                    ].items()
                    if value > 0
                }
            ):
                raise PreflightError(
                    f"draw[{expected_index}] replacement binding changed"
                )
        expected_managed = _mapping(manifest.get("managed_files"), "managed_files")
        actual_managed = {
            path.relative_to(draw_root).as_posix(): sha256_file(path)
            for path in sorted(draw_root.rglob("*"))
            if path.is_file() and path.name != "manifest.json"
        }
        if dict(expected_managed) != actual_managed:
            raise PreflightError(f"draw[{expected_index}] managed files changed")
        private_path = draw_root / "private-bindings.jsonl"
        if sha256_file(private_path) != manifest.get("private_bindings_sha256"):
            raise PreflightError(f"draw[{expected_index}] private bindings changed")
        private_rows = read_jsonl(private_path)
        if len(private_rows) != manifest.get("selected_count"):
            raise PreflightError(f"draw[{expected_index}] selected count changed")
        selected_rows: list[Mapping[str, Any]] = []
        tasks_by_stage: dict[str, list[dict[str, Any]]] = {}
        binding_by_task: dict[str, Mapping[str, Any]] = {}
        review_order_by_task: dict[str, int] = {}
        for row_index, row in enumerate(private_rows):
            validate_seal(row, f"draw[{expected_index}].private[{row_index}]")
            _exact_keys(
                row,
                {
                    "schema_version",
                    "record_type",
                    "draw_id",
                    "sample_id",
                    "task_ids",
                    "stratum",
                    "role_private",
                    "work_id",
                    "chapter_id",
                    "page_key",
                    "visual_lineage_conflict_keys",
                    "source_stages",
                    "record_sha256",
                },
                f"draw[{expected_index}].private[{row_index}]",
            )
            if (
                row.get("schema_version") != SCHEMA_VERSION
                or row.get("record_type") != "source_only_eligibility_private_binding"
                or row.get("draw_id") != draw_root.name
            ):
                raise PreflightError(f"draw[{expected_index}] private schema changed")
            sample_id = _identifier(row.get("sample_id"), "private.sample_id")
            candidate = pool_by_id.get(sample_id)
            if candidate is None or sample_id in drawn_ids:
                raise PreflightError(
                    f"draw[{expected_index}] reuses an ineligible sample"
                )
            expected_private = {
                "stratum": candidate["stratum"],
                "role_private": candidate["role"],
                "work_id": candidate["work_id"],
                "chapter_id": candidate["chapter_id"],
                "page_key": candidate["page_key"],
                "visual_lineage_conflict_keys": sorted(candidate["conflict_keys"]),
            }
            for field, expected in expected_private.items():
                if row.get(field) != expected:
                    raise PreflightError(f"{sample_id}: private {field} changed")
            if set(candidate["conflict_keys"]).intersection(used_conflicts):
                raise PreflightError(f"{sample_id}: page/lineage reused across draws")
            selected_rows.append(candidate)
            drawn_ids.add(sample_id)
            used_conflicts.update(str(value) for value in candidate["conflict_keys"])
            task_ids = _mapping(row.get("task_ids"), "private.task_ids")
            if set(task_ids) != set(REVIEWER_STAGES):
                raise PreflightError("private task-stage binding changed")
            for reviewer_stage, task_id in task_ids.items():
                task_text = _identifier(task_id, "private.task_id")
                if task_text != _task_id(
                    str(contract["round_id"]),
                    expected_index,
                    reviewer_stage,
                    sample_id,
                ):
                    raise PreflightError("opaque task ID derivation changed")
                if task_text in binding_by_task:
                    raise PreflightError("duplicate opaque task ID")
                binding_by_task[task_text] = row
                review_order_by_task[task_text] = row_index + 1
            source_stages = _mapping(row.get("source_stages"), "private.source_stages")
            if set(source_stages) != {"primary", "secondary"}:
                raise PreflightError("private source-stage inventory changed")
            for source_stage, external_key in (
                ("primary", "primary"),
                ("secondary", "secondary"),
            ):
                actual_source = _mapping(
                    source_stages.get(source_stage),
                    f"private.source_stages.{source_stage}",
                )
                expected_source = external[external_key][sample_id]
                expected_stage_binding = {
                    "assignment_id": expected_source["assignment_id"],
                    "source_only": expected_source["source_only"],
                    "candidate_only_private": expected_source["candidate_only"],
                    "public_source_sha256": expected_source["source_only"]["sha256"],
                }
                if dict(actual_source) != expected_stage_binding:
                    raise PreflightError(
                        f"{sample_id}: private {source_stage} A/B binding changed"
                    )
        selected_id_order = [str(row["sample_id"]) for row in selected_rows]
        if manifest.get("selected_sample_ids_sha256") != sha256_bytes(
            canonical_json_bytes(selected_id_order)
        ):
            raise PreflightError(f"draw[{expected_index}] selected inventory changed")
        for stage in REVIEWER_STAGES:
            tasks_path = draw_root / f"tasks-{stage}.jsonl"
            tasks = read_jsonl(tasks_path)
            if len(tasks) != manifest.get("task_counts", {}).get(stage):
                raise PreflightError(f"draw[{expected_index}] {stage} count changed")
            seen: set[str] = set()
            for task in tasks:
                _public_task_safe(task, set(external["forbidden_tokens"]))
                task_id = _identifier(task.get("task_id"), "task.task_id")
                if task_id in seen or task_id not in binding_by_task:
                    raise PreflightError("public task/private binding mismatch")
                seen.add(task_id)
                binding = binding_by_task[task_id]
                if (
                    binding["task_ids"].get(stage) != task_id
                    or task.get("review_order") != review_order_by_task[task_id]
                ):
                    raise PreflightError(
                        "public task appears in the wrong reviewer stage"
                    )
                source_desc = _mapping(task.get("source_only"), "task.source_only")
                relative = _safe_relative(
                    source_desc.get("path"), "task.source_only.path"
                )
                expected_relative = PurePosixPath(
                    "draws", draw_root.name, "source-only", stage, f"{task_id}.png"
                )
                if relative != expected_relative:
                    raise PreflightError("public source-only path changed")
                card_path = _resolve_inside(
                    workspace, relative, "task.source_only.path"
                )
                expected_source = binding["source_stages"][
                    "primary" if stage == "reviewer-a" else "secondary"
                ]["source_only"]
                if (
                    not card_path.is_file()
                    or sha256_file(card_path) != source_desc.get("sha256")
                    or source_desc.get("sha256") != expected_source["sha256"]
                    or source_desc.get("pixel_sha256")
                    != expected_source["pixel_sha256"]
                    or source_desc.get("size_px") != expected_source["size_px"]
                ):
                    raise PreflightError("source-only public card bytes changed")
            tasks_by_stage[stage] = tasks
        targets = _mapping(manifest.get("requested_quotas"), "requested_quotas")
        seed = _text(manifest.get("selection_seed"), "selection_seed")
        forbidden_before = {
            str(row["sample_id"])
            for prior_draw in draws
            for row in prior_draw["selected"]
        }
        fixed_before = {
            str(value)
            for prior_draw in draws
            for row in prior_draw["selected"]
            for value in row["conflict_keys"]
        }
        expected_selected, expected_audit = _select_exact(
            external["pool"],
            targets={str(key): int(value) for key, value in targets.items()},
            seed=seed,
            forbidden_sample_ids=forbidden_before,
            fixed_conflict_keys=fixed_before,
            maximum_per_work=(
                initial_maximum if expected_index == 0 else extension_maximum
            ),
            minimum_by_work=(
                {work_id: initial_minimum for work_id in initial_required_work_ids}
                if expected_index == 0
                else None
            ),
            require_milp_proof=expected_index == 0,
            enforce_third_branch=False,
        )
        if expected_selected is None or [
            row["sample_id"] for row in expected_selected
        ] != [row["sample_id"] for row in selected_rows]:
            raise PreflightError(
                f"draw[{expected_index}] deterministic selection changed"
            )
        if dict(manifest.get("selection_audit", {})) != expected_audit:
            raise PreflightError(f"draw[{expected_index}] selection audit changed")
        draws.append(
            {
                "root": draw_root,
                "manifest": manifest,
                "manifest_file_sha256": sha256_file(manifest_path),
                "selected": selected_rows,
                "private": private_rows,
                "tasks": tasks_by_stage,
            }
        )
        previous_sha = str(manifest["record_sha256"])
    if draws[0]["manifest"]["record_sha256"] != contract.get(
        "initial_draw_manifest_sha256"
    ):
        raise PreflightError("contract no longer binds the initial draw")
    return draws


def _load_reviews(
    workspace: Path,
    draws: Sequence[Mapping[str, Any]],
    external: Mapping[str, Any],
) -> dict[str, dict[str, dict[str, Any]]]:
    output: dict[str, dict[str, dict[str, Any]]] = {
        stage: {} for stage in REVIEWER_STAGES
    }
    reviewer_ids: dict[str, set[str]] = {stage: set() for stage in REVIEWER_STAGES}
    for draw in draws:
        draw_id = str(draw["manifest"]["draw_id"])
        for stage in REVIEWER_STAGES:
            review_root = workspace / "reviews" / draw_id / stage
            if not review_root.exists():
                continue
            report_path = review_root / "report.json"
            decisions_path = review_root / "decisions.jsonl"
            if set(path.name for path in review_root.iterdir()) != {
                "report.json",
                "decisions.jsonl",
            }:
                raise PreflightError(f"{draw_id}/{stage}: review inventory changed")
            report = read_json(report_path)
            validate_seal(report, f"{draw_id}/{stage}.report")
            _exact_keys(
                report,
                {
                    "schema_version",
                    "record_type",
                    "draw_id",
                    "reviewer_stage",
                    "reviewer_id",
                    "draw_manifest_record_sha256",
                    "decision_count",
                    "eligible_count",
                    "decisions_sha256",
                    "record_sha256",
                },
                f"{draw_id}/{stage}.report",
            )
            if (
                report.get("schema_version") != SCHEMA_VERSION
                or report.get("record_type") != "source_only_eligibility_review_batch"
                or report.get("draw_id") != draw_id
                or report.get("reviewer_stage") != stage
                or report.get("draw_manifest_record_sha256")
                != draw["manifest"]["record_sha256"]
                or report.get("decisions_sha256") != sha256_file(decisions_path)
            ):
                raise PreflightError(f"{draw_id}/{stage}: review binding changed")
            reviewer_id = _identifier(report.get("reviewer_id"), "reviewer_id")
            reviewer_ids[stage].add(reviewer_id)
            rows = read_jsonl(decisions_path)
            if len(rows) != report.get("decision_count"):
                raise PreflightError(f"{draw_id}/{stage}: review count changed")
            task_by_id = {str(row["task_id"]): row for row in draw["tasks"][stage]}
            seen: set[str] = set()
            by_task: dict[str, Any] = {}
            for index, row in enumerate(rows):
                validate_seal(row, f"{draw_id}/{stage}.decisions[{index}]")
                _exact_keys(
                    row,
                    {
                        "schema_version",
                        "record_type",
                        "draw_id",
                        "task_id",
                        "reviewer_stage",
                        "reviewer_id",
                        "public_task_record_sha256",
                        "checks",
                        "confidence",
                        "evidence_note",
                        "disposition",
                        "record_sha256",
                    },
                    f"{draw_id}/{stage}.decisions[{index}]",
                )
                task_id = _identifier(row.get("task_id"), "decision.task_id")
                if task_id in seen or task_id not in task_by_id:
                    raise PreflightError(f"{draw_id}/{stage}: review task mismatch")
                seen.add(task_id)
                if (
                    row.get("reviewer_id") != reviewer_id
                    or row.get("reviewer_stage") != stage
                    or row.get("draw_id") != draw_id
                ):
                    raise PreflightError("reviewer binding changed")
                if (
                    row.get("schema_version") != SCHEMA_VERSION
                    or row.get("record_type") != "source_only_eligibility_review"
                ):
                    raise PreflightError("review schema changed")
                if row.get("public_task_record_sha256") != task_by_id[task_id].get(
                    "record_sha256"
                ):
                    raise PreflightError("review no longer binds its public task")
                checks = _mapping(row.get("checks"), "decision.checks")
                if set(checks) != set(CHECK_IDS) or any(
                    not isinstance(checks[name], bool) for name in CHECK_IDS
                ):
                    raise PreflightError("review checks changed")
                expected_disposition = (
                    "eligible" if all(checks[name] for name in CHECK_IDS) else "reject"
                )
                if row.get("disposition") != expected_disposition:
                    raise PreflightError("review disposition was not derived")
                _validate_evidence_note(
                    row.get("evidence_note"), set(external["forbidden_tokens"])
                )
                confidence = row.get("confidence")
                if (
                    isinstance(confidence, bool)
                    or not isinstance(confidence, (int, float))
                    or not math.isfinite(float(confidence))
                    or not 0.0 <= float(confidence) <= 1.0
                ):
                    raise PreflightError("review confidence changed")
                by_task[task_id] = row
            if set(by_task) != set(task_by_id):
                raise PreflightError(f"{draw_id}/{stage}: review is incomplete")
            if report.get("eligible_count") != sum(
                row["disposition"] == "eligible" for row in rows
            ):
                raise PreflightError(f"{draw_id}/{stage}: eligible count changed")
            output[stage][draw_id] = {
                "report": report,
                "report_file_sha256": sha256_file(report_path),
                "by_task": by_task,
            }
    if reviewer_ids["reviewer-a"].intersection(reviewer_ids["reviewer-b"]):
        raise PreflightError("reviewer identities are not independent")
    return output


def _load_workspace(workspace: Path) -> dict[str, Any]:
    root = workspace.resolve()
    contract = read_json(root / "contract.json")
    validate_seal(contract, "workspace contract")
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type") != "source_only_eligibility_workspace_contract"
        or contract.get("initial_targets") != INITIAL_TARGETS
        or contract.get("scored_targets") != SCORED_TARGETS
    ):
        raise PreflightError("workspace contract changed")
    rubric_path = _validate_file_binding(
        _mapping(contract.get("rubric"), "contract.rubric"), "contract.rubric"
    )
    if rubric_path.name != "font-matching-v2-review-rubric-v5.md":
        raise PreflightError("workspace binds another rubric")
    inputs = _mapping(contract.get("inputs"), "contract.inputs")
    sealed_intake_input = inputs.get("sealed_intake_root")
    if sealed_intake_input is None:
        sealed_intake_paths: list[Path] = []
    elif isinstance(sealed_intake_input, str):
        sealed_intake_paths = [Path(_text(sealed_intake_input, "sealed_intake_root"))]
    else:
        sealed_intake_paths = [
            Path(_text(value, "sealed_intake_root[]"))
            for value in _list(sealed_intake_input, "sealed_intake_root")
        ]
    _sealed_intake_roots(sealed_intake_paths)
    prior_paths = [
        Path(_text(value, "prior calibration path"))
        for value in _list(
            inputs.get("prior_calibration_subsets"), "prior calibration paths"
        )
    ]
    _assert_disjoint(
        root,
        [
            Path(_text(inputs.get("rescue_inputs"), "rescue_inputs")),
            Path(_text(inputs.get("font_signal_audit"), "font_signal_audit")),
            Path(_text(inputs.get("master_split_map"), "master_split_map")).parent,
            Path(_text(inputs.get("primary_split_root"), "primary_split_root")),
            Path(_text(inputs.get("secondary_split_root"), "secondary_split_root")),
            *(path.parent for path in prior_paths),
            *sealed_intake_paths,
            *(
                [
                    Path(
                        _text(
                            inputs.get("successor_bridge_root"),
                            "successor_bridge_root",
                        )
                    )
                ]
                if inputs.get("successor_bridge_root") is not None
                else []
            ),
        ],
    )
    external = _load_external(
        rescue_inputs=Path(_text(inputs.get("rescue_inputs"), "rescue_inputs")),
        font_signal_audit=Path(
            _text(inputs.get("font_signal_audit"), "font_signal_audit")
        ),
        master_split_map=Path(
            _text(inputs.get("master_split_map"), "master_split_map")
        ),
        prior_calibration_subsets=prior_paths,
        primary_split_root=Path(
            _text(inputs.get("primary_split_root"), "primary_split_root")
        ),
        secondary_split_root=Path(
            _text(inputs.get("secondary_split_root"), "secondary_split_root")
        ),
        sealed_intake_root=sealed_intake_paths,
        successor_bridge_root=(
            Path(_text(inputs.get("successor_bridge_root"), "successor_bridge_root"))
            if inputs.get("successor_bridge_root") is not None
            else None
        ),
    )
    if contract.get("external_fingerprint") != _external_fingerprint(external):
        raise PreflightError(
            "a bound source, audit, prior round, split tree, or pool changed"
        )
    draws = _load_draws(root, external, contract)
    reviews = _load_reviews(root, draws, external)
    state = {
        "root": root,
        "contract": contract,
        "external": external,
        "draws": draws,
        "reviews": reviews,
    }
    _validate_replacement_requests(state)
    _validate_final_if_present(state)
    return state


def _validate_evidence_note(value: Any, forbidden_tokens: set[str]) -> str:
    note = _text(value, "evidence_note")
    if len(note) > 1000 or "\n" in note or "\r" in note:
        raise PreflightError(
            "evidence_note must be one line of at most 1000 characters"
        )
    folded = note.casefold()
    if ALIAS_RE.search(folded):
        raise PreflightError("evidence_note leaks a candidate alias")
    for token in forbidden_tokens:
        if token and token in folded:
            raise PreflightError("evidence_note leaks a candidate identity")
    words = set(re.findall(r"[a-z0-9_]+|[가-힣]+", folded))
    if words.intersection(ROLE_AND_TIER_TOKENS):
        raise PreflightError(
            "evidence_note contains a role, tier, or translation answer"
        )
    return note


def submit_reviews(
    *,
    workspace: Path,
    draw_id: str,
    reviewer_stage: str,
    reviewer_id: str,
    decisions: Path,
) -> dict[str, Any]:
    if reviewer_stage not in REVIEWER_STAGES:
        raise PreflightError(f"reviewer_stage must be one of {REVIEWER_STAGES}")
    reviewer = _identifier(reviewer_id, "reviewer_id")
    state = _load_workspace(workspace)
    draw = next(
        (item for item in state["draws"] if item["manifest"]["draw_id"] == draw_id),
        None,
    )
    if draw is None:
        raise PreflightError(f"unknown draw_id: {draw_id}")
    target = state["root"] / "reviews" / draw_id / reviewer_stage
    if target.exists():
        raise PreflightError(f"review stage was already submitted: {target}")
    other_stage = "reviewer-b" if reviewer_stage == "reviewer-a" else "reviewer-a"
    other = state["reviews"][other_stage].get(draw_id)
    if other is not None and other["report"]["reviewer_id"] == reviewer:
        raise PreflightError("primary and secondary reviewer IDs must differ")
    task_by_id = {str(row["task_id"]): row for row in draw["tasks"][reviewer_stage]}
    input_rows = read_jsonl(decisions.resolve())
    if len(input_rows) != len(task_by_id):
        raise PreflightError("submission must cover every pending task exactly once")
    output_rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    expected_keys = {"task_id", *CHECK_IDS, "confidence", "evidence_note"}
    for index, row in enumerate(input_rows):
        _exact_keys(row, expected_keys, f"decisions[{index}]")
        task_id = _identifier(row.get("task_id"), f"decisions[{index}].task_id")
        if task_id in seen or task_id not in task_by_id:
            raise PreflightError(
                f"decisions[{index}] uses an unknown or duplicate task"
            )
        seen.add(task_id)
        checks: dict[str, bool] = {}
        for check_id in CHECK_IDS:
            value = row.get(check_id)
            if not isinstance(value, bool):
                raise PreflightError(f"decisions[{index}].{check_id} must be boolean")
            checks[check_id] = value
        confidence = row.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise PreflightError(f"decisions[{index}].confidence is invalid")
        confidence_value = float(confidence)
        if not math.isfinite(confidence_value) or not 0.0 <= confidence_value <= 1.0:
            raise PreflightError(f"decisions[{index}].confidence is invalid")
        note = _validate_evidence_note(
            row.get("evidence_note"), set(state["external"]["forbidden_tokens"])
        )
        task = task_by_id[task_id]
        output_rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "source_only_eligibility_review",
                    "draw_id": draw_id,
                    "task_id": task_id,
                    "reviewer_stage": reviewer_stage,
                    "reviewer_id": reviewer,
                    "public_task_record_sha256": task["record_sha256"],
                    "checks": checks,
                    "confidence": confidence_value,
                    "evidence_note": note,
                    "disposition": ("eligible" if all(checks.values()) else "reject"),
                }
            )
        )
    output_rows.sort(
        key=lambda row: next(
            task["review_order"]
            for task in draw["tasks"][reviewer_stage]
            if task["task_id"] == row["task_id"]
        )
    )
    payload = jsonl_bytes(output_rows)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{reviewer_stage}.", dir=target.parent))
    try:
        _write_once(temporary / "decisions.jsonl", payload)
        report = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "source_only_eligibility_review_batch",
                "draw_id": draw_id,
                "reviewer_stage": reviewer_stage,
                "reviewer_id": reviewer,
                "draw_manifest_record_sha256": draw["manifest"]["record_sha256"],
                "decision_count": len(output_rows),
                "eligible_count": sum(
                    row["disposition"] == "eligible" for row in output_rows
                ),
                "decisions_sha256": sha256_bytes(payload),
            }
        )
        _write_once(
            temporary / "report.json", canonical_json_bytes(report, pretty=True)
        )
        with _workspace_lock(state["root"]):
            if target.exists():
                raise PreflightError("review stage appeared during submission")
            os.replace(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {
        "workspace": str(state["root"]),
        "draw_id": draw_id,
        "reviewer_stage": reviewer_stage,
        "reviewer_id": reviewer,
        "decisions": len(output_rows),
        "eligible": report["eligible_count"],
        "status": "sealed",
    }


def _joint_eligible(state: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]], int]:
    eligible: list[Mapping[str, Any]] = []
    reviewed = 0
    for draw in state["draws"]:
        draw_id = str(draw["manifest"]["draw_id"])
        if any(draw_id not in state["reviews"][stage] for stage in REVIEWER_STAGES):
            raise PreflightError(f"draw {draw_id} lacks a complete two-person review")
        private_by_stage_task: dict[str, Mapping[str, Any]] = {}
        for binding in draw["private"]:
            for task_id in binding["task_ids"].values():
                private_by_stage_task[str(task_id)] = binding
        for binding in draw["private"]:
            reviewed += 1
            passed = True
            for stage in REVIEWER_STAGES:
                task_id = str(binding["task_ids"][stage])
                decision = state["reviews"][stage][draw_id]["by_task"][task_id]
                if decision["disposition"] != "eligible":
                    passed = False
            if passed:
                sample_id = str(binding["sample_id"])
                candidate = next(
                    row for row in draw["selected"] if row["sample_id"] == sample_id
                )
                eligible.append(candidate)
    return eligible, reviewed


def _request_inventory(workspace: Path) -> list[Path]:
    root = workspace / "replacement-requests"
    if not root.exists():
        return []
    paths = sorted(root.glob("*.json"))
    for index, path in enumerate(paths):
        if path.name != f"{index:03d}.json":
            raise PreflightError("replacement requests are not contiguous")
    return paths


def _review_report_bindings(state: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for draw in state["draws"]:
        draw_id = str(draw["manifest"]["draw_id"])
        for stage in REVIEWER_STAGES:
            review = state["reviews"][stage].get(draw_id)
            if review is None:
                continue
            rows.append(
                {
                    "draw_id": draw_id,
                    "reviewer_stage": stage,
                    "report_record_sha256": review["report"]["record_sha256"],
                    "report_file_sha256": review["report_file_sha256"],
                }
            )
    return rows


def _validate_replacement_requests(state: Mapping[str, Any]) -> None:
    paths = _request_inventory(state["root"])
    prior_sha: str | None = None
    for index, path in enumerate(paths):
        request = read_json(path)
        validate_seal(request, f"replacement request[{index}]")
        _exact_keys(
            request,
            {
                "schema_version",
                "record_type",
                "request_index",
                "previous_request_record_sha256",
                "draw_count",
                "draw_manifest_record_sha256s",
                "review_report_bindings_sha256",
                "aggregate_only",
                "individual_reviewer_answers_present",
                "drawn_counts_by_private_stratum",
                "joint_pass_counts_by_private_stratum",
                "requested_fresh_same_stratum_counts",
                "selection_failure_audit",
                "record_sha256",
            },
            f"replacement request[{index}]",
        )
        if (
            request.get("schema_version") != SCHEMA_VERSION
            or request.get("record_type")
            != "source_only_eligibility_replacement_request"
            or request.get("request_index") != index
            or request.get("previous_request_record_sha256") != prior_sha
        ):
            raise PreflightError("replacement request chain changed")
        draw_count = request.get("draw_count")
        if isinstance(draw_count, bool) or not isinstance(draw_count, int):
            raise PreflightError("replacement request draw_count is invalid")
        if not 1 <= draw_count <= len(state["draws"]):
            raise PreflightError("replacement request binds an impossible draw count")
        expected_draw_shas = [
            row["manifest"]["record_sha256"] for row in state["draws"][:draw_count]
        ]
        if request.get("draw_manifest_record_sha256s") != expected_draw_shas:
            raise PreflightError("replacement request draw binding changed")
        prefix_draws = state["draws"][:draw_count]
        prefix_draw_ids = {str(draw["manifest"]["draw_id"]) for draw in prefix_draws}
        prefix_state = {
            **state,
            "draws": prefix_draws,
            "reviews": {
                stage: {
                    draw_id: review
                    for draw_id, review in state["reviews"][stage].items()
                    if draw_id in prefix_draw_ids
                }
                for stage in REVIEWER_STAGES
            },
        }
        eligible, _ = _joint_eligible(prefix_state)
        selection_seed = stable_hash(
            str(state["contract"]["selection_seed"]),
            "scored-60",
            *expected_draw_shas,
        )
        selected, selection_audit = _select_exact(
            eligible,
            targets=SCORED_TARGETS,
            seed=selection_seed,
            maximum_per_work=_mapping(
                state["contract"].get("diversity_contract"),
                "diversity_contract",
            ).get("final_maximum_per_work"),
            enforce_third_branch=True,
        )
        if selected is not None:
            raise PreflightError(
                "replacement request exists for a feasible scored subset"
            )
        expected_requested = _replacement_shortfall(eligible, selection_audit)
        eligible_counts = Counter(str(row["stratum"]) for row in eligible)
        drawn_counts = Counter(
            str(row["stratum"]) for draw in prefix_draws for row in draw["selected"]
        )
        if (
            request.get("aggregate_only") is not True
            or request.get("individual_reviewer_answers_present") is not False
            or request.get("review_report_bindings_sha256")
            != sha256_bytes(canonical_json_bytes(_review_report_bindings(prefix_state)))
            or request.get("drawn_counts_by_private_stratum")
            != {name: drawn_counts.get(name, 0) for name in SCORED_TARGETS}
            or request.get("joint_pass_counts_by_private_stratum")
            != {name: eligible_counts.get(name, 0) for name in SCORED_TARGETS}
            or request.get("requested_fresh_same_stratum_counts") != expected_requested
            or request.get("selection_failure_audit") != selection_audit
        ):
            raise PreflightError("replacement request aggregate derivation changed")
        prior_sha = str(request["record_sha256"])


def _current_request(state: Mapping[str, Any]) -> tuple[Path, dict[str, Any]] | None:
    paths = _request_inventory(state["root"])
    if not paths:
        return None
    path = paths[-1]
    value = read_json(path)
    if value.get("draw_count") != len(state["draws"]):
        return None
    return path, value


def _replacement_shortfall(
    eligible: Sequence[Mapping[str, Any]], audit: Mapping[str, Any]
) -> dict[str, int]:
    capacity = Counter(str(row["stratum"]) for row in eligible)
    requested = {
        stratum: max(0, target - capacity.get(stratum, 0))
        for stratum, target in SCORED_TARGETS.items()
    }
    if not any(requested.values()):
        best_shortfall = audit.get("best_shortfall")
        if isinstance(best_shortfall, Mapping):
            requested = {
                stratum: max(0, int(best_shortfall.get(stratum, 0)))
                for stratum in SCORED_TARGETS
            }
    if not any(requested.values()):
        stratum = min(
            SCORED_TARGETS,
            key=lambda name: (capacity.get(name, 0) - SCORED_TARGETS[name], name),
        )
        requested[stratum] = 1
    return requested


def _write_replacement_request(
    state: Mapping[str, Any],
    *,
    eligible: Sequence[Mapping[str, Any]],
    selection_audit: Mapping[str, Any],
) -> dict[str, Any]:
    current = _current_request(state)
    if current is not None:
        return current[1]
    paths = _request_inventory(state["root"])
    index = len(paths)
    requested = _replacement_shortfall(eligible, selection_audit)
    eligible_counts = Counter(str(row["stratum"]) for row in eligible)
    drawn_counts = Counter(
        str(row["stratum"]) for draw in state["draws"] for row in draw["selected"]
    )
    request = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "source_only_eligibility_replacement_request",
            "request_index": index,
            "previous_request_record_sha256": (
                read_json(paths[-1])["record_sha256"] if paths else None
            ),
            "draw_count": len(state["draws"]),
            "draw_manifest_record_sha256s": [
                draw["manifest"]["record_sha256"] for draw in state["draws"]
            ],
            "review_report_bindings_sha256": sha256_bytes(
                canonical_json_bytes(_review_report_bindings(state))
            ),
            "aggregate_only": True,
            "individual_reviewer_answers_present": False,
            "drawn_counts_by_private_stratum": {
                name: drawn_counts.get(name, 0) for name in SCORED_TARGETS
            },
            "joint_pass_counts_by_private_stratum": {
                name: eligible_counts.get(name, 0) for name in SCORED_TARGETS
            },
            "requested_fresh_same_stratum_counts": requested,
            "selection_failure_audit": dict(selection_audit),
        }
    )
    target = state["root"] / "replacement-requests" / f"{index:03d}.json"
    with _workspace_lock(state["root"]):
        _write_once(target, canonical_json_bytes(request, pretty=True))
    return request


def extend_workspace(*, workspace: Path) -> dict[str, Any]:
    state = _load_workspace(workspace)
    if (state["root"] / "final").exists():
        raise PreflightError("a finalized workspace cannot be extended")
    current = _current_request(state)
    if current is None:
        raise PreflightError("finalize must emit a current replacement request first")
    request_path, request = current
    targets = {
        str(name): int(value)
        for name, value in _mapping(
            request.get("requested_fresh_same_stratum_counts"),
            "replacement request targets",
        ).items()
        if int(value) > 0
    }
    if not targets:
        raise PreflightError("replacement request asks for no samples")
    drawn_ids = {
        str(row["sample_id"]) for draw in state["draws"] for row in draw["selected"]
    }
    used_conflicts = {
        str(value)
        for draw in state["draws"]
        for row in draw["selected"]
        for value in row["conflict_keys"]
    }
    draw_index = len(state["draws"])
    seed = stable_hash(
        str(state["contract"]["selection_seed"]),
        "extension",
        str(draw_index),
        str(request["record_sha256"]),
    )
    selected, audit = _select_exact(
        state["external"]["pool"],
        targets=targets,
        seed=seed,
        forbidden_sample_ids=drawn_ids,
        fixed_conflict_keys=used_conflicts,
        maximum_per_work=_mapping(
            state["contract"].get("diversity_contract"), "diversity_contract"
        ).get("extension_maximum_per_work_per_draw"),
        enforce_third_branch=False,
    )
    if selected is None:
        raise PreflightError(
            "fresh same-stratum lineage capacity is exhausted; no quota was relaxed; "
            f"audit={audit}"
        )
    draw_id = f"{draw_index:03d}-extension"
    target = state["root"] / "draws" / draw_id
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{draw_id}.", dir=state["root"] / "draws")
    )
    try:
        manifest = _build_draw_directory(
            temporary_draw=temporary,
            final_draw_relative=PurePosixPath("draws", draw_id),
            round_id=str(state["contract"]["round_id"]),
            draw_index=draw_index,
            kind="extension",
            selection_seed=seed,
            targets=targets,
            selected=selected,
            selection_audit=audit,
            external=state["external"],
            previous_manifest_sha256=state["draws"][-1]["manifest"]["record_sha256"],
            replacement_request={
                "path": request_path.relative_to(state["root"]).as_posix(),
                "sha256": sha256_file(request_path),
                "record_sha256": request["record_sha256"],
            },
        )
        with _workspace_lock(state["root"]):
            if target.exists():
                raise PreflightError("extension draw appeared concurrently")
            os.replace(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {
        "workspace": str(state["root"]),
        "draw_id": draw_id,
        "fresh_samples": len(selected),
        "requested_quotas": targets,
        "draw_record_sha256": manifest["record_sha256"],
        "status": "extended_source_only",
    }


def _training_quarantine(
    state: Mapping[str, Any], drawn_ids: set[str]
) -> tuple[list[str], list[str]]:
    external = _mapping(state.get("external"), "state.external")
    source = _mapping(external.get("source"), "state.external.source")
    master = _mapping(source.get("master"), "source.master")
    master_ids = {str(value) for value in master}
    missing_master_ids = set(drawn_ids).difference(master_ids)
    sealed_manual_recrops = external.get("_sealed_manual_recrop_conflict_keys", {})
    if not isinstance(sealed_manual_recrops, Mapping):
        raise PreflightError("sealed manual-recrop quarantine index changed")
    sealed_existing_gaps = external.get(
        "_sealed_existing_master_projection_gaps", {}
    )
    if not isinstance(sealed_existing_gaps, Mapping):
        raise PreflightError("sealed existing-master projection-gap index changed")
    supported_missing = set(sealed_manual_recrops).union(sealed_existing_gaps)
    unsupported_missing = sorted(missing_master_ids.difference(supported_missing))
    if unsupported_missing:
        raise PreflightError(
            "drawn sample is missing from source master outside the sealed "
            f"manual-recrop path: {unsupported_missing[:5]}"
        )

    current_ids: set[str] = set()
    existing_drawn_ids = set(drawn_ids).intersection(master_ids)
    if existing_drawn_ids:
        try:
            current_ids.update(
                delta._calibration_training_quarantine(source, existing_drawn_ids)
            )
        except delta.DeltaLedgerError as error:
            raise PreflightError(str(error)) from error

    supplemental_conflict_keys: set[str] = set()
    for sample_id in sorted(missing_master_ids):
        if sample_id in sealed_manual_recrops:
            keys = sealed_manual_recrops.get(sample_id)
        else:
            gap = _mapping(
                sealed_existing_gaps.get(sample_id),
                f"sealed existing-master projection gap[{sample_id}]",
            )
            _sha(
                gap.get("master_record_sha256"),
                f"sealed existing-master projection gap[{sample_id}].master_record_sha256",
            )
            keys = gap.get("conflict_keys")
            current_ids.add(sample_id)
        if not isinstance(keys, (set, frozenset)) or not keys or any(
            not isinstance(value, str) or not value for value in keys
        ):
            raise PreflightError(
                f"{sample_id}: sealed supplemental conflict keys changed"
            )
        supplemental_conflict_keys.update(keys)
    if supplemental_conflict_keys:
        try:
            for sample_id, row_value in master.items():
                row = _mapping(row_value, f"source.master[{sample_id}]")
                if delta._master_calibration_leakage_keys(row).intersection(
                    supplemental_conflict_keys
                ):
                    current_ids.add(str(sample_id))
        except delta.DeltaLedgerError as error:
            raise PreflightError(str(error)) from error

    test_conflicts = sorted(
        sample_id
        for sample_id in current_ids
        if sample_id not in sealed_existing_gaps
        and source["split_by_sample"].get(sample_id) == "test"
    )
    if test_conflicts:
        raise PreflightError(
            "sealed manual-recrop calibration closure shares a pixel/lineage "
            f"group with test samples: {test_conflicts[:5]}"
        )
    non_train = sorted(
        sample_id
        for sample_id in current_ids
        if sample_id not in sealed_existing_gaps
        and source["split_by_sample"].get(sample_id) != "train"
    )
    if non_train:
        raise PreflightError(
            "calibration training quarantine contains non-train samples: "
            f"{non_train[:5]}"
        )
    current = sorted(current_ids)
    cumulative = sorted(
        set(current).union(state["external"]["prior"]["training_quarantine_sample_ids"])
    )
    return current, cumulative


def _expected_final(state: Mapping[str, Any]) -> dict[str, Any] | None:
    eligible, reviewed_count = _joint_eligible(state)
    seed = stable_hash(
        str(state["contract"]["selection_seed"]),
        "scored-60",
        *[draw["manifest"]["record_sha256"] for draw in state["draws"]],
    )
    selected, audit = _select_exact(
        eligible,
        targets=SCORED_TARGETS,
        seed=seed,
        maximum_per_work=_mapping(
            state["contract"].get("diversity_contract"), "diversity_contract"
        ).get("final_maximum_per_work"),
        enforce_third_branch=True,
    )
    if selected is None:
        return {
            "selected": None,
            "eligible": eligible,
            "reviewed_count": reviewed_count,
            "selection_seed": seed,
            "selection_audit": audit,
        }
    drawn_ids = {
        str(row["sample_id"]) for draw in state["draws"] for row in draw["selected"]
    }
    current_quarantine, cumulative_quarantine = _training_quarantine(state, drawn_ids)
    return {
        "selected": selected,
        "eligible": eligible,
        "reviewed_count": reviewed_count,
        "selection_seed": seed,
        "selection_audit": audit,
        "drawn_ids": sorted(drawn_ids),
        "current_quarantine": current_quarantine,
        "cumulative_quarantine": cumulative_quarantine,
    }


def _validate_final_if_present(state: Mapping[str, Any]) -> None:
    final_root = state["root"] / "final"
    if not final_root.exists():
        return
    expected_files = {
        "report.json",
        "scored-sample-ids.json",
        "scored-sample-ids.jsonl",
        "training-quarantine-closure.json",
    }
    if {path.name for path in final_root.iterdir()} != expected_files:
        raise PreflightError("final artifact inventory changed")
    expected = _expected_final(state)
    if expected is None or expected["selected"] is None:
        raise PreflightError("final artifacts exist without a feasible scored subset")
    rows = read_jsonl(final_root / "scored-sample-ids.jsonl")
    for index, row in enumerate(rows):
        validate_seal(row, f"final.scored[{index}]")
    expected_ids = [str(row["sample_id"]) for row in expected["selected"]]
    if [row.get("sample_id") for row in rows] != expected_ids:
        raise PreflightError("final scored sample IDs changed")
    for output_row, candidate in zip(rows, expected["selected"]):
        if (
            output_row.get("schema_version") != SCHEMA_VERSION
            or output_row.get("record_type") != "scored_calibration_sample_id"
            or output_row.get("private_stratum") != candidate["stratum"]
            or output_row.get("source_split") != "train_quarantine"
            or output_row.get("development_only") is not True
        ):
            raise PreflightError("final scored row contract changed")
    scored = read_json(final_root / "scored-sample-ids.json")
    quarantine = read_json(final_root / "training-quarantine-closure.json")
    report = read_json(final_root / "report.json")
    for name, value in (
        ("scored", scored),
        ("quarantine", quarantine),
        ("report", report),
    ):
        validate_seal(value, f"final.{name}")
    if (
        scored.get("schema_version") != SCHEMA_VERSION
        or scored.get("record_type") != "scored_calibration_sample_ids"
        or scored.get("round_id") != state["contract"]["round_id"]
        or scored.get("sample_count") != SCORED_COUNT
        or scored.get("sample_ids") != expected_ids
        or scored.get("strata_targets") != SCORED_TARGETS
        or scored.get("selection_seed") != expected["selection_seed"]
        or scored.get("selection_audit") != expected["selection_audit"]
        or scored.get("source_only_reviews_complete_before_candidate_stage") is not True
    ):
        raise PreflightError("final scored manifest changed")
    if scored.get("scored_jsonl_sha256") != sha256_file(
        final_root / "scored-sample-ids.jsonl"
    ):
        raise PreflightError("final scored JSONL binding changed")
    if (
        quarantine.get("current_round_training_quarantine_sample_ids")
        != expected["current_quarantine"]
        or quarantine.get("cumulative_training_quarantine_sample_ids")
        != expected["cumulative_quarantine"]
    ):
        raise PreflightError("final training quarantine closure changed")
    if (
        quarantine.get("schema_version") != SCHEMA_VERSION
        or quarantine.get("record_type") != "calibration_training_quarantine_closure"
        or quarantine.get("round_id") != state["contract"]["round_id"]
        or quarantine.get("all_drawn_sample_ids") != expected["drawn_ids"]
        or quarantine.get("all_drawn_sample_ids_sha256")
        != sha256_bytes(canonical_json_bytes(expected["drawn_ids"]))
        or quarantine.get("current_round_training_quarantine_sample_ids_sha256")
        != sha256_bytes(canonical_json_bytes(expected["current_quarantine"]))
        or quarantine.get("prior_training_quarantine_sample_ids")
        != state["external"]["prior"]["training_quarantine_sample_ids"]
        or quarantine.get("cumulative_training_quarantine_sample_ids_sha256")
        != sha256_bytes(canonical_json_bytes(expected["cumulative_quarantine"]))
        or quarantine.get("test_samples_present") is not False
    ):
        raise PreflightError("final training quarantine contract changed")
    if report.get("scored_sample_ids_file_sha256") != sha256_file(
        final_root / "scored-sample-ids.json"
    ) or report.get("training_quarantine_file_sha256") != sha256_file(
        final_root / "training-quarantine-closure.json"
    ):
        raise PreflightError("final report output binding changed")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != "source_only_eligibility_preflight_final_report"
        or report.get("workspace") != str(state["root"])
        or report.get("status") != "complete"
        or report.get("reviewed_sample_count") != expected["reviewed_count"]
        or report.get("jointly_eligible_sample_count") != len(expected["eligible"])
        or report.get("scored_sample_count") != SCORED_COUNT
        or report.get("draw_manifest_record_sha256s")
        != [draw["manifest"]["record_sha256"] for draw in state["draws"]]
        or report.get("review_report_bindings") != _review_report_bindings(state)
        or report.get("scored_sample_ids_jsonl_sha256")
        != sha256_file(final_root / "scored-sample-ids.jsonl")
    ):
        raise PreflightError("final report contract changed")


def finalize_workspace(*, workspace: Path) -> dict[str, Any]:
    state = _load_workspace(workspace)
    if (state["root"] / "final").exists():
        report = read_json(state["root"] / "final" / "report.json")
        return dict(report)
    expected = _expected_final(state)
    assert expected is not None
    if expected["selected"] is None:
        request = _write_replacement_request(
            state,
            eligible=expected["eligible"],
            selection_audit=expected["selection_audit"],
        )
        return {
            "workspace": str(state["root"]),
            "status": "replacement_required",
            "reviewed_samples": expected["reviewed_count"],
            "jointly_eligible_samples": len(expected["eligible"]),
            "requested_fresh_same_stratum_counts": request[
                "requested_fresh_same_stratum_counts"
            ],
            "replacement_request_record_sha256": request["record_sha256"],
        }
    selected = expected["selected"]
    rows = [
        seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "scored_calibration_sample_id",
                "sample_id": str(row["sample_id"]),
                "private_stratum": str(row["stratum"]),
                "source_split": "train_quarantine",
                "development_only": True,
            }
        )
        for row in selected
    ]
    jsonl_payload = jsonl_bytes(rows)
    scored = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "scored_calibration_sample_ids",
            "round_id": state["contract"]["round_id"],
            "sample_count": SCORED_COUNT,
            "sample_ids": [row["sample_id"] for row in rows],
            "strata_targets": dict(SCORED_TARGETS),
            "selection_seed": expected["selection_seed"],
            "selection_audit": expected["selection_audit"],
            "source_only_reviews_complete_before_candidate_stage": True,
            "scored_jsonl_sha256": sha256_bytes(jsonl_payload),
        }
    )
    quarantine = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "calibration_training_quarantine_closure",
            "round_id": state["contract"]["round_id"],
            "all_drawn_sample_ids": expected["drawn_ids"],
            "all_drawn_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(expected["drawn_ids"])
            ),
            "current_round_training_quarantine_sample_ids": expected[
                "current_quarantine"
            ],
            "current_round_training_quarantine_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(expected["current_quarantine"])
            ),
            "prior_training_quarantine_sample_ids": state["external"]["prior"][
                "training_quarantine_sample_ids"
            ],
            "cumulative_training_quarantine_sample_ids": expected[
                "cumulative_quarantine"
            ],
            "cumulative_training_quarantine_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(expected["cumulative_quarantine"])
            ),
            "test_samples_present": False,
        }
    )
    final_root = state["root"] / "final"
    temporary = Path(tempfile.mkdtemp(prefix=".final.", dir=state["root"]))
    try:
        _write_once(temporary / "scored-sample-ids.jsonl", jsonl_payload)
        _write_once(
            temporary / "scored-sample-ids.json",
            canonical_json_bytes(scored, pretty=True),
        )
        _write_once(
            temporary / "training-quarantine-closure.json",
            canonical_json_bytes(quarantine, pretty=True),
        )
        report = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "source_only_eligibility_preflight_final_report",
                "workspace": str(state["root"]),
                "status": "complete",
                "reviewed_sample_count": expected["reviewed_count"],
                "jointly_eligible_sample_count": len(expected["eligible"]),
                "scored_sample_count": SCORED_COUNT,
                "draw_manifest_record_sha256s": [
                    draw["manifest"]["record_sha256"] for draw in state["draws"]
                ],
                "review_report_bindings": _review_report_bindings(state),
                "scored_sample_ids_file_sha256": sha256_file(
                    temporary / "scored-sample-ids.json"
                ),
                "scored_sample_ids_jsonl_sha256": sha256_file(
                    temporary / "scored-sample-ids.jsonl"
                ),
                "training_quarantine_file_sha256": sha256_file(
                    temporary / "training-quarantine-closure.json"
                ),
            }
        )
        _write_once(
            temporary / "report.json", canonical_json_bytes(report, pretty=True)
        )
        with _workspace_lock(state["root"]):
            if final_root.exists():
                raise PreflightError("final artifact appeared concurrently")
            os.replace(temporary, final_root)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return dict(report)


def validate_workspace(*, workspace: Path) -> dict[str, Any]:
    state = _load_workspace(workspace)
    reviewed_draws = sum(
        all(
            draw["manifest"]["draw_id"] in state["reviews"][stage]
            for stage in REVIEWER_STAGES
        )
        for draw in state["draws"]
    )
    return {
        "workspace": str(state["root"]),
        "status": "valid",
        "draws": len(state["draws"]),
        "drawn_samples": sum(len(draw["selected"]) for draw in state["draws"]),
        "fully_reviewed_draws": reviewed_draws,
        "finalized": (state["root"] / "final").exists(),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    feasibility = subparsers.add_parser(
        "feasibility", help="validate sources and report exact 72-card capacity"
    )
    feasibility.add_argument("--rescue-inputs", type=Path, required=True)
    feasibility.add_argument("--font-signal-audit", type=Path, required=True)
    feasibility.add_argument("--master-split-map", type=Path, required=True)
    feasibility.add_argument(
        "--prior-calibration-subset", type=Path, action="append", required=True
    )
    feasibility.add_argument("--primary-split-root", type=Path, required=True)
    feasibility.add_argument("--secondary-split-root", type=Path, required=True)
    feasibility.add_argument(
        "--sealed-intake-root",
        type=Path,
        action="append",
        help="owned source-sealed intake workspace; arbitrary JSON is rejected",
    )
    feasibility.add_argument(
        "--successor-bridge-root",
        type=Path,
        help="sealed v2-to-v3 promotion authority required with master-v3 split",
    )
    feasibility.add_argument("--selection-seed", required=True)
    init = subparsers.add_parser(
        "init", help="create the sealed 72-card A-stage reserve"
    )
    init.add_argument("--workspace", type=Path, required=True)
    init.add_argument("--rescue-inputs", type=Path, required=True)
    init.add_argument("--font-signal-audit", type=Path, required=True)
    init.add_argument("--master-split-map", type=Path, required=True)
    init.add_argument(
        "--prior-calibration-subset", type=Path, action="append", required=True
    )
    init.add_argument("--primary-split-root", type=Path, required=True)
    init.add_argument("--secondary-split-root", type=Path, required=True)
    init.add_argument("--rubric", type=Path, required=True)
    init.add_argument("--round-id", required=True)
    init.add_argument("--selection-seed", required=True)
    init.add_argument(
        "--sealed-intake-root",
        type=Path,
        action="append",
        help="owned source-sealed intake workspace; arbitrary JSON is rejected",
    )
    init.add_argument(
        "--successor-bridge-root",
        type=Path,
        help="sealed v2-to-v3 promotion authority required with master-v3 split",
    )

    submit = subparsers.add_parser(
        "submit", help="seal one reviewer's A-stage decisions"
    )
    submit.add_argument("--workspace", type=Path, required=True)
    submit.add_argument("--draw-id", required=True)
    submit.add_argument("--reviewer-stage", choices=REVIEWER_STAGES, required=True)
    submit.add_argument("--reviewer-id", required=True)
    submit.add_argument("--decisions", type=Path, required=True)

    extend = subparsers.add_parser(
        "extend", help="draw sealed same-stratum replacements"
    )
    extend.add_argument("--workspace", type=Path, required=True)
    finalize = subparsers.add_parser(
        "finalize", help="emit exact scored 60 or a request"
    )
    finalize.add_argument("--workspace", type=Path, required=True)
    validate = subparsers.add_parser(
        "validate", help="recompute every binding and invariant"
    )
    validate.add_argument("--workspace", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "feasibility":
            result = evaluate_feasibility(
                rescue_inputs=args.rescue_inputs,
                font_signal_audit=args.font_signal_audit,
                master_split_map=args.master_split_map,
                prior_calibration_subsets=args.prior_calibration_subset,
                primary_split_root=args.primary_split_root,
                secondary_split_root=args.secondary_split_root,
                selection_seed=args.selection_seed,
                sealed_intake_root=args.sealed_intake_root,
                successor_bridge_root=args.successor_bridge_root,
            )
        elif args.command == "init":
            result = initialize_workspace(
                workspace=args.workspace,
                rescue_inputs=args.rescue_inputs,
                font_signal_audit=args.font_signal_audit,
                master_split_map=args.master_split_map,
                prior_calibration_subsets=args.prior_calibration_subset,
                primary_split_root=args.primary_split_root,
                secondary_split_root=args.secondary_split_root,
                rubric=args.rubric,
                round_id=args.round_id,
                selection_seed=args.selection_seed,
                sealed_intake_root=args.sealed_intake_root,
                successor_bridge_root=args.successor_bridge_root,
            )
        elif args.command == "submit":
            result = submit_reviews(
                workspace=args.workspace,
                draw_id=args.draw_id,
                reviewer_stage=args.reviewer_stage,
                reviewer_id=args.reviewer_id,
                decisions=args.decisions,
            )
        elif args.command == "extend":
            result = extend_workspace(workspace=args.workspace)
        elif args.command == "finalize":
            result = finalize_workspace(workspace=args.workspace)
        else:
            result = validate_workspace(workspace=args.workspace)
    except PreflightError as error:
        print(f"error: {error}", file=os.sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
