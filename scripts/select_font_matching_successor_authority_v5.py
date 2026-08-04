#!/usr/bin/env python3
"""Select an exact, balanced scored round from paired source prechecks.

The selector consumes only sealed, metadata-redacted A/B review summaries.
Private queue metadata is restored after both reviews are complete and is used
solely to enforce the frozen stratum, work-balance, and lineage constraints.
It never creates candidate judgments or training labels.
"""

# ruff: noqa: E402

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts import build_font_matching_successor_authority_intake_v5 as intake
from scripts import font_matching_calibration_preflight_v5 as preflight
from scripts import font_matching_catalog_delta_ledger as delta


AUDIT_SCHEMA_VERSION = "font-matching-successor-authority-selection-audit-v5"
AUDIT_RECORD_TYPE = "font_matching_successor_authority_selection_audit"
OWNER = "carrot-manga-translator/font-matching-successor-authority-selector-v5"
SELECTION_FILE = "selection.json"
AUDIT_FILE = "selection-audit.json"
MARKER_FILE = ".font-matching-successor-authority-selector-v5-owned.json"
MINIMUM_DOUBLE_CLEAN = intake.MIN_DOUBLE_CLEAN_POOL
EXPECTED_WORK_COUNT = intake.EXPECTED_TRAIN_WORK_COUNT
MINIMUM_DOUBLE_CLEAN_PER_WORK = intake.MIN_DOUBLE_CLEAN_PER_WORK
SELECTED_PER_WORK = 4
MAXIMUM_SELECTED_PER_WORK = intake.MAX_SAMPLES_PER_WORK


class SelectionError(ValueError):
    """Raised when a scored-round selection cannot be proven safe."""


def _file_binding(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise SelectionError(f"missing bound file: {resolved}")
    return {
        "path": str(resolved),
        "sha256": intake.sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def _clean_sample_ids(
    evidence: Mapping[str, Sequence[Mapping[str, Any]]],
) -> set[str]:
    clean: set[str] = set()
    for sample_id, rows in evidence.items():
        reviewer_ids = {str(row.get("reviewer_id")) for row in rows}
        if (
            len(rows) == 2
            and len(reviewer_ids) == 2
            and all(row.get("eligibility") == "clean" for row in rows)
        ):
            clean.add(str(sample_id))
    return clean


def _queue_conflict_keys(row: Mapping[str, Any], *, sample_id: str) -> list[str]:
    values = row.get("visual_lineage_conflict_keys")
    if not isinstance(values, list) or not values:
        raise SelectionError(f"{sample_id}: visual lineage keys are missing")
    keys = [str(value) for value in values]
    if any(not value for value in keys) or len(keys) != len(set(keys)):
        raise SelectionError(f"{sample_id}: visual lineage keys are invalid")
    return sorted(keys)


def _normalized_pool(
    *,
    evidence: Mapping[str, Sequence[Mapping[str, Any]]],
    queue_by_sample: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if set(evidence) != set(queue_by_sample):
        raise SelectionError("paired review evidence and private queue coverage differ")
    double_clean = _clean_sample_ids(evidence)
    if len(double_clean) < MINIMUM_DOUBLE_CLEAN:
        raise SelectionError(
            f"double-clean reserve is {len(double_clean)}, below required "
            f"{MINIMUM_DOUBLE_CLEAN}"
        )

    pool: list[dict[str, Any]] = []
    for sample_id in sorted(double_clean):
        row = queue_by_sample[sample_id]
        work_id = row.get("work_id")
        stratum = row.get("proposed_stratum")
        chapter_id = row.get("chapter_id")
        role = row.get("proposed_role")
        if row.get("canonical_split") != "train":
            raise SelectionError(
                f"{sample_id}: source queue row is not canonical train"
            )
        if not isinstance(work_id, str) or not work_id:
            raise SelectionError(f"{sample_id}: work identity is missing")
        if stratum not in intake.EXACT_STRATUM_COUNTS:
            raise SelectionError(f"{sample_id}: scored stratum is invalid")
        if not isinstance(chapter_id, str) or not chapter_id:
            raise SelectionError(f"{sample_id}: chapter identity is missing")
        if not isinstance(role, str) or not role:
            raise SelectionError(f"{sample_id}: private role is missing")
        review_order = row.get("review_order", 0)
        if isinstance(review_order, bool) or not isinstance(review_order, int):
            raise SelectionError(f"{sample_id}: review order is invalid")
        pool.append(
            {
                "sample_id": sample_id,
                "work_id": work_id,
                "stratum": stratum,
                "chapter_id": chapter_id,
                "role": role,
                "conflict_keys": _queue_conflict_keys(row, sample_id=sample_id),
                "priority_rank": max(0, review_order),
                # The exact solver does not use these two fields, but keeping
                # them explicit makes the normalized contract compatible with
                # the shared selector without inventing source labels.
                "style_cluster": stratum,
                "orientation": "unknown",
            }
        )

    work_counts = Counter(str(row["work_id"]) for row in pool)
    stratum_counts = Counter(str(row["stratum"]) for row in pool)
    work_deficits = {
        work_id: MINIMUM_DOUBLE_CLEAN_PER_WORK - count
        for work_id, count in sorted(work_counts.items())
        if count < MINIMUM_DOUBLE_CLEAN_PER_WORK
    }
    if len(work_counts) != EXPECTED_WORK_COUNT or work_deficits:
        raise SelectionError(
            "double-clean reserve violates the exact 15-work/min4 contract: "
            f"works={len(work_counts)}, deficits={work_deficits}"
        )
    stratum_deficits = {
        name: required - stratum_counts.get(name, 0)
        for name, required in intake.EXACT_STRATUM_COUNTS.items()
        if stratum_counts.get(name, 0) < required
    }
    if stratum_deficits:
        raise SelectionError(
            f"double-clean reserve cannot supply scored quotas: {stratum_deficits}"
        )
    return pool, {
        "double_clean_pool_count": len(pool),
        "double_clean_work_counts": dict(sorted(work_counts.items())),
        "double_clean_stratum_counts": dict(sorted(stratum_counts.items())),
        "double_clean_pool_sample_ids_sha256": intake.sha256_bytes(
            intake.canonical_json_bytes(sorted(double_clean))
        ),
    }


def _forbidden_from_samples_files(
    paths: Sequence[Path],
) -> tuple[set[str], set[str], list[dict[str, Any]]]:
    sample_ids: set[str] = set()
    conflict_keys: set[str] = set()
    bindings: list[dict[str, Any]] = []
    for path_value in paths:
        path = path_value.resolve()
        rows = intake.read_jsonl(path)
        for index, row in enumerate(rows):
            intake.validate_seal(row, f"forbidden samples[{path}][{index}]")
            sample_id = row.get("sample_id")
            values = row.get("visual_lineage_conflict_keys")
            if not isinstance(sample_id, str) or not sample_id:
                raise SelectionError(f"{path}:{index + 1}: sample identity is missing")
            if not isinstance(values, list) or not values:
                raise SelectionError(f"{path}:{index + 1}: lineage keys are missing")
            if sample_id in sample_ids:
                raise SelectionError("forbidden sample inputs overlap")
            sample_ids.add(sample_id)
            conflict_keys.update(str(value) for value in values)
        bindings.append({**_file_binding(path), "row_count": len(rows)})
    return sample_ids, conflict_keys, bindings


def _forbidden_from_prechecks(
    summary_paths: Sequence[Path],
) -> tuple[set[str], set[str], list[dict[str, Any]]]:
    if not summary_paths:
        return set(), set(), []
    try:
        _, bindings, queue_by_sample = intake._load_prechecks(summary_paths)
    except (intake.IntakeError, ValueError) as error:
        raise SelectionError(str(error)) from error
    sample_ids = set(queue_by_sample)
    conflict_keys = {
        key
        for sample_id, row in queue_by_sample.items()
        for key in _queue_conflict_keys(row, sample_id=sample_id)
    }
    return sample_ids, conflict_keys, copy.deepcopy(bindings)


def select_from_loaded_prechecks(
    *,
    round_id: str,
    selection_seed: str,
    evidence: Mapping[str, Sequence[Mapping[str, Any]]],
    queue_by_sample: Mapping[str, Mapping[str, Any]],
    precheck_bindings: Sequence[Mapping[str, Any]],
    forbidden_sample_ids: set[str] | None = None,
    forbidden_conflict_keys: set[str] | None = None,
    forbidden_bindings: Sequence[Mapping[str, Any]] = (),
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not round_id or not selection_seed:
        raise SelectionError("round ID and selection seed are required")
    if intake.EXACT_STRATUM_COUNTS != preflight.SCORED_TARGETS:
        raise SelectionError("shared scored quota contracts differ")
    pool, pool_audit = _normalized_pool(
        evidence=evidence, queue_by_sample=queue_by_sample
    )
    works = sorted({str(row["work_id"]) for row in pool})
    minimum_by_work = {work_id: SELECTED_PER_WORK for work_id in works}
    try:
        selected, solver_audit = preflight._select_exact(
            pool,
            targets=intake.EXACT_STRATUM_COUNTS,
            seed=selection_seed,
            forbidden_sample_ids=set(forbidden_sample_ids or set()),
            fixed_conflict_keys=set(forbidden_conflict_keys or set()),
            maximum_per_work=MAXIMUM_SELECTED_PER_WORK,
            minimum_by_work=minimum_by_work,
            require_milp_proof=True,
            enforce_third_branch=False,
        )
    except preflight.PreflightError as error:
        raise SelectionError(str(error)) from error
    if selected is None:
        raise SelectionError(
            "no exact scored selection satisfies quota, work, and lineage gates: "
            + json.dumps(solver_audit, ensure_ascii=False, sort_keys=True)
        )
    sample_ids = sorted(str(row["sample_id"]) for row in selected)
    selected_work_counts = Counter(str(row["work_id"]) for row in selected)
    selected_strata = Counter(str(row["stratum"]) for row in selected)
    if (
        len(sample_ids) != intake.EXACT_SELECTED_COUNT
        or len(set(sample_ids)) != len(sample_ids)
        or len(selected_work_counts) != EXPECTED_WORK_COUNT
        or set(selected_work_counts.values()) != {SELECTED_PER_WORK}
        or dict(selected_strata) != intake.EXACT_STRATUM_COUNTS
    ):
        raise SelectionError("internal scored selection invariant failed")
    used_conflicts: set[str] = set()
    for row in selected:
        overlap = used_conflicts.intersection(row["conflict_keys"])
        if overlap:
            raise SelectionError("selection reused a page or visual lineage")
        used_conflicts.update(str(value) for value in row["conflict_keys"])

    selection = delta.seal(
        {
            "schema_version": delta.SCHEMA_VERSION,
            "record_type": delta.SUCCESSOR_AUTHORITY_SELECTION_RECORD_TYPE,
            "round_id": round_id,
            "development_only": True,
            "source_authority": "sealed_successor_master_registry_split",
            "sample_count": len(sample_ids),
            "sample_ids": sample_ids,
        }
    )
    reviewer_ids = sorted(
        {str(row["reviewer_id"]) for rows in evidence.values() for row in rows}
    )
    audit = intake.seal(
        {
            "schema_version": AUDIT_SCHEMA_VERSION,
            "record_type": AUDIT_RECORD_TYPE,
            "owner": OWNER,
            "round_id": round_id,
            "development_only": True,
            "answer_free": True,
            "selection_seed_sha256": intake.sha256_bytes(
                selection_seed.encode("utf-8")
            ),
            "reviewer_ids": reviewer_ids,
            "review_contract": {
                "exact_independent_clean_reviewers_per_sample": 2,
                "candidate_pixels_available_to_source_reviewers": False,
                "minimum_double_clean_pool": MINIMUM_DOUBLE_CLEAN,
                "exact_work_count": EXPECTED_WORK_COUNT,
                "minimum_double_clean_per_work": MINIMUM_DOUBLE_CLEAN_PER_WORK,
                "selected_per_work": SELECTED_PER_WORK,
                "maximum_selected_per_work": MAXIMUM_SELECTED_PER_WORK,
                "maximum_per_page_or_visual_lineage": 1,
                "exact_stratum_counts": dict(intake.EXACT_STRATUM_COUNTS),
                "milp_optimality_proof_required": True,
            },
            "pool": pool_audit,
            "selected_sample_count": len(sample_ids),
            "selected_sample_ids_sha256": intake.sha256_bytes(
                intake.canonical_json_bytes(sample_ids)
            ),
            "selected_work_counts": dict(sorted(selected_work_counts.items())),
            "selected_stratum_counts": dict(sorted(selected_strata.items())),
            "selected_conflict_keys_sha256": intake.sha256_bytes(
                intake.canonical_json_bytes(sorted(used_conflicts))
            ),
            "selection_manifest_record_sha256": selection["record_sha256"],
            "solver": copy.deepcopy(solver_audit),
            "inputs": {
                "precheck_reviews": copy.deepcopy(list(precheck_bindings)),
                "forbidden_authorities": copy.deepcopy(list(forbidden_bindings)),
            },
        }
    )
    return selection, audit


def compute_selection(
    *,
    round_id: str,
    selection_seed: str,
    precheck_summaries: Sequence[Path],
    forbidden_samples_files: Sequence[Path] = (),
    forbidden_precheck_summaries: Sequence[Path] = (),
) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        evidence, bindings, queue_by_sample = intake._load_prechecks(precheck_summaries)
    except (intake.IntakeError, ValueError) as error:
        raise SelectionError(str(error)) from error
    file_ids, file_conflicts, file_bindings = _forbidden_from_samples_files(
        forbidden_samples_files
    )
    review_ids, review_conflicts, review_bindings = _forbidden_from_prechecks(
        forbidden_precheck_summaries
    )
    return select_from_loaded_prechecks(
        round_id=round_id,
        selection_seed=selection_seed,
        evidence=evidence,
        queue_by_sample=queue_by_sample,
        precheck_bindings=bindings,
        forbidden_sample_ids=file_ids | review_ids,
        forbidden_conflict_keys=file_conflicts | review_conflicts,
        forbidden_bindings=[
            {"kind": "prior_intake_samples", **value} for value in file_bindings
        ]
        + [{"kind": "prior_precheck_authority", **value} for value in review_bindings],
    )


def _payloads(
    selection: Mapping[str, Any], audit: Mapping[str, Any]
) -> dict[str, bytes]:
    marker = {
        "owner": OWNER,
        "schema_version": AUDIT_SCHEMA_VERSION,
        "round_id": audit["round_id"],
    }
    return {
        SELECTION_FILE: intake.canonical_json_bytes(selection, pretty=True),
        AUDIT_FILE: intake.canonical_json_bytes(audit, pretty=True),
        MARKER_FILE: intake.canonical_json_bytes(marker, pretty=True),
    }


def publish_selection(
    *, output_dir: Path, selection: Mapping[str, Any], audit: Mapping[str, Any]
) -> None:
    output = output_dir.resolve()
    if output.exists():
        raise SelectionError(f"output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        for name, payload in _payloads(selection, audit).items():
            (staging / name).write_bytes(payload)
        os.replace(staging, output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def validate_published_selection(
    *, output_dir: Path, selection: Mapping[str, Any], audit: Mapping[str, Any]
) -> None:
    output = output_dir.resolve()
    expected = _payloads(selection, audit)
    if not output.is_dir() or {path.name for path in output.iterdir()} != set(expected):
        raise SelectionError("published selection file set changed")
    for name, payload in expected.items():
        if (output / name).read_bytes() != payload:
            raise SelectionError(f"published selection changed: {name}")
    delta._read_successor_authority_selection_manifest(
        output / SELECTION_FILE, round_id=str(selection["round_id"])
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("build", "validate"):
        child = subparsers.add_parser(command)
        child.add_argument("--round-id", required=True)
        child.add_argument("--selection-seed", required=True)
        child.add_argument(
            "--precheck-summary", type=Path, action="append", required=True
        )
        child.add_argument(
            "--forbidden-samples-file", type=Path, action="append", default=[]
        )
        child.add_argument(
            "--forbidden-precheck-summary",
            type=Path,
            action="append",
            default=[],
        )
        child.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        selection, audit = compute_selection(
            round_id=args.round_id,
            selection_seed=args.selection_seed,
            precheck_summaries=args.precheck_summary,
            forbidden_samples_files=args.forbidden_samples_file,
            forbidden_precheck_summaries=args.forbidden_precheck_summary,
        )
        if args.command == "build":
            publish_selection(
                output_dir=args.output_dir, selection=selection, audit=audit
            )
        else:
            validate_published_selection(
                output_dir=args.output_dir, selection=selection, audit=audit
            )
    except (SelectionError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "status": "built" if args.command == "build" else "valid",
                "output": str(args.output_dir.resolve()),
                "round_id": selection["round_id"],
                "selected": selection["sample_count"],
                "selection_record_sha256": selection["record_sha256"],
                "audit_record_sha256": audit["record_sha256"],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
