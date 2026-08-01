#!/usr/bin/env python3
"""Publish exhaustively rechecked font-recrop successors as a hard delta catalog.

Every defect parent is excluded regardless of its terminal outcome.  Only a
real-page recrop that survived the normal hard postprocessor and received a
human ``pass`` in the exact four-shard recheck is copied into the catalog.
Any remaining ``recrop`` decision aborts before the output root is created.

The result is mutation-independent: every accepted asset is copied (never
hard-linked), rehashed, and referenced by a self-contained manifest.  Review
sheets, diagnostic overlays, proposal previews, and synthetic pixels are not
catalog assets.
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import build_font_matching_master as master
import build_font_matching_recrop_repair as repair
import revise_font_matching_recrop_proposals as revision


hard_audit = repair.hard_audit

SCHEMA_VERSION = "font-matching-recrop-promotion-v1"
OWNER = "carrot-manga-translator/font-matching-recrop-promotion"
TOOL_ID = "manga-translator-font-matching-recrop-promoter"
DEFAULT_CATALOG_ID = "fontclip-recrop-accepted-v1"
MARKER_FILE = ".font-matching-recrop-promotion-owned.json"
MANIFEST_FILE = "manifest.jsonl"
REJECTS_FILE = "rejects.jsonl"
LINEAGE_FILE = "lineage.jsonl"
CROSSWALK_FILE = "crosswalk.jsonl"
EXCLUSIONS_FILE = "parent-exclusions.jsonl"
POLICY_FILE = "provenance_policy.json"
REPORT_FILE = "report.json"


class RecropPromotionError(ValueError):
    """Raised when a repair generation is not safe to publish."""


def canonical_json(value: Any) -> str:
    return repair.canonical_json(value)


def sha256_json(value: Any) -> str:
    return repair.sha256_bytes(canonical_json(value).encode("utf-8"))


def sha256_file(path: Path) -> str:
    return repair.sha256_file(path)


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    return repair.seal(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return repair.json_bytes(value, pretty=pretty)


def jsonl_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return repair.jsonl_bytes(rows)


def _master_id(catalog_id: str, source_id: str) -> str:
    digest = repair.sha256_bytes(f"{catalog_id}\0{source_id}".encode("utf-8"))
    return f"fm_{digest[:24]}"


def _safe_component(value: Any, label: str) -> str:
    try:
        return hard_audit.safe_component(value, label)
    except (TypeError, ValueError) as error:
        raise RecropPromotionError(str(error)) from error


def _safe_managed_path(root: Path, relative: Any, label: str) -> Path:
    text = repair.require_text(relative, label)
    if "\\" in text:
        raise RecropPromotionError(f"{label}: managed paths must use POSIX separators")
    posix = PurePosixPath(text)
    windows = PureWindowsPath(text)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
        or ".." in posix.parts
    ):
        raise RecropPromotionError(f"{label}: unsafe managed path")
    path = root.joinpath(*posix.parts)
    if path.is_symlink():
        raise RecropPromotionError(f"{label}: symlinks are forbidden")
    return path


def _managed_files(root: Path) -> dict[str, str]:
    output: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RecropPromotionError(f"output contains a symlink: {path}")
        if path.is_file() and path.name != MARKER_FILE:
            output[path.relative_to(root).as_posix()] = sha256_file(path)
    return output


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _require_disjoint(
    first: Path, second: Path, first_label: str, second_label: str
) -> None:
    if (
        first.resolve() == second.resolve()
        or _is_within(first, second)
        or _is_within(second, first)
    ):
        raise RecropPromotionError(
            f"{first_label} and {second_label} must be separate, non-nested roots"
        )


def _validate_output_separation(
    *, output_root: Path, repair_root: Path, processed_root: Path, library_root: Path
) -> None:
    _require_disjoint(output_root, repair_root, "output root", "repair root")
    _require_disjoint(output_root, processed_root, "output root", "processed root")
    _require_disjoint(output_root, library_root, "output root", "library root")
    _require_disjoint(repair_root, library_root, "repair root", "library root")
    _require_disjoint(processed_root, library_root, "processed root", "library root")


def _validated_asset_source(
    dataset_root: Path, descriptor: Mapping[str, Any], location: str
) -> tuple[Path, str]:
    try:
        relative = hard_audit.safe_relative(descriptor.get("path"), location).as_posix()
        source = hard_audit.resolve_inside(dataset_root, relative, location)
    except (TypeError, ValueError, RuntimeError) as error:
        raise RecropPromotionError(str(error)) from error
    if not source.is_file() or source.is_symlink():
        raise RecropPromotionError(f"{location}: accepted asset is missing or linked")
    expected = repair.require_sha(
        descriptor.get("file_sha256"), f"{location}.file_sha256"
    )
    if sha256_file(source) != expected:
        raise RecropPromotionError(f"{location}: accepted asset hash drifted")
    lowered_parts = {part.lower() for part in PurePosixPath(relative).parts}
    if lowered_parts & master.OVERLAY_PATH_PARTS:
        raise RecropPromotionError(f"{location}: QA/overlay path is forbidden")
    return source, relative


def _processed_event(record: Mapping[str, Any], decision: Any) -> dict[str, Any]:
    lineage = record.get("lineage")
    values = (
        [dict(value) for value in lineage if isinstance(value, Mapping)]
        if isinstance(lineage, list)
        else []
    )
    event = next(
        (
            dict(value)
            for value in reversed(values)
            if value.get("id") == record.get("id")
        ),
        {
            "id": record.get("id"),
            "provenance": "real_processed",
            "tool": (
                record.get("processing", {}).get("tool")
                if isinstance(record.get("processing"), Mapping)
                else None
            ),
        },
    )
    event.update(
        {
            "provenance": "real_processed_recheck_accepted",
            "adjudication_tool": TOOL_ID,
            "review_ledger_sha256": decision.ledger_sha256,
            "reviewed_at": decision.reviewed_at,
            "synthetic": False,
        }
    )
    return event


def _decorate_accepted(
    *,
    record: Mapping[str, Any],
    decision: Any,
    parent: Mapping[str, Any],
    intake: Mapping[str, Any],
    proposal: Mapping[str, Any],
    queue_row: Mapping[str, Any],
) -> dict[str, Any]:
    item_id = _safe_component(record.get("id"), "accepted processed id")
    parent_id = _safe_component(parent.get("id"), "parent master id")
    candidate_id = _safe_component(
        intake.get("successor_candidate_id"), "repair candidate id"
    )
    if decision.item_id != item_id or decision.decision != "pass":
        raise RecropPromotionError(f"{item_id}: only an exact recheck pass is accepted")
    if queue_row.get("id") != candidate_id:
        raise RecropPromotionError(f"{item_id}: queue lineage drifted")
    result = copy.deepcopy(dict(record))
    result["review"] = {
        "status": "accepted",
        "decision": "pass",
        "reviewer": decision.reviewer,
        "reviewed_at": decision.reviewed_at,
        "ledger_sha256": decision.ledger_sha256,
        "sheet": decision.sheet,
        "cell_index": decision.cell_index,
        "notes": decision.notes or None,
    }
    result["mask_review"] = copy.deepcopy(result["review"])
    result["adjudication"] = {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "path": "font_matching_recrop_postprocess_recheck_pass",
        "source_record_sha256": sha256_json(record),
        "root_original_processed_id": parent_id,
        "root_original_processed_record_sha256": intake.get(
            "parent_master_record_sha256"
        ),
        "root_original_source_catalog_id": intake.get("parent_source_catalog_id"),
        "root_original_source_id": intake.get("parent_source_id"),
        "proposal_record_sha256": proposal.get("record_sha256"),
        "repair_candidate_id": candidate_id,
        "repair_candidate_record_sha256": intake.get(
            "successor_candidate_record_sha256"
        ),
        "manual_recrop_bbox_px": queue_row.get("bbox_px"),
        "manual_recrop_padding_px": (
            queue_row.get("manual_recrop", {}).get("padding_px")
            if isinstance(queue_row.get("manual_recrop"), Mapping)
            else 0
        ),
        "manual_recrop_crop_sha256": queue_row.get("crop_sha256"),
        "recheck_review_ledger_sha256": decision.ledger_sha256,
        "exhaustive_visual_review_passed": True,
        "manual_recrop": True,
        "successor_recheck_required": True,
        "successor_recheck_passed": True,
        "synthetic": False,
    }
    result["postprocess_lineage"] = [
        copy.deepcopy(dict(value))
        for value in record.get("lineage", ())
        if isinstance(value, Mapping)
    ]
    result["lineage"] = [
        {
            "id": parent_id,
            "provenance": "real_master_superseded",
            "record_sha256": intake.get("parent_master_record_sha256"),
            "proposal_record_sha256": proposal.get("record_sha256"),
            "synthetic": False,
        },
        {
            "id": candidate_id,
            "provenance": "real_manual_recrop",
            "tool": TOOL_ID,
            "source_page_sha256": queue_row.get("source_page_sha256"),
            "crop_sha256": queue_row.get("crop_sha256"),
            "bbox_px": queue_row.get("bbox_px"),
            "padding_px": result["adjudication"]["manual_recrop_padding_px"],
            "synthetic": False,
        },
        _processed_event(record, decision),
    ]
    result["label"] = None
    result["synthetic"] = False
    result["synthetic_provenance"] = None
    return result


def _terminal_status(
    *,
    intake: Mapping[str, Any],
    terminal: Mapping[str, Any],
) -> tuple[str, Mapping[str, Any] | None, Any | None]:
    if intake.get("action") == "replace":
        return "replacement_required", None, None
    candidate_id = str(intake.get("successor_candidate_id"))
    rejected = terminal["rejects_by_candidate"].get(candidate_id)
    if rejected is not None:
        return "postprocess_reject", rejected, None
    processed = terminal["processed_by_candidate"].get(candidate_id)
    processed_id = terminal["processed_id_by_candidate"].get(candidate_id)
    if processed is None or processed_id is None:
        raise RecropPromotionError(f"{candidate_id}: missing terminal successor")
    decision = terminal["audit"].decisions[processed_id]
    return f"recheck_{decision.decision}", processed, decision


def _crosswalk_row(
    *,
    catalog_id: str,
    parent: Mapping[str, Any],
    intake: Mapping[str, Any],
    proposal: Mapping[str, Any],
    status: str,
    terminal_record: Mapping[str, Any] | None,
    decision: Any | None,
) -> dict[str, Any]:
    parent_id = str(parent["id"])
    provenance = parent.get("provenance")
    if not isinstance(provenance, Mapping):
        raise RecropPromotionError(f"{parent_id}: parent provenance is missing")
    accepted = status == "recheck_pass"
    successor_id = terminal_record.get("id") if terminal_record is not None else None
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_recrop_promotion_crosswalk",
            "parent_master_id": parent_id,
            "parent_master_record_sha256": intake.get("parent_master_record_sha256"),
            "parent_source_catalog_id": provenance.get("source_catalog_id"),
            "parent_source_id": provenance.get("source_id"),
            "parent_source_line_number": provenance.get("source_line_number"),
            "parent_source_line_sha256": provenance.get("source_line_sha256"),
            "proposal_record_sha256": proposal.get("record_sha256"),
            "repair_candidate_id": intake.get("successor_candidate_id"),
            "repair_candidate_record_sha256": intake.get(
                "successor_candidate_record_sha256"
            ),
            "terminal_status": status,
            "terminal_id": successor_id,
            "terminal_record_sha256": (
                sha256_json(terminal_record) if terminal_record is not None else None
            ),
            "recheck_ledger_sha256": (
                decision.ledger_sha256 if decision is not None else None
            ),
            "parent_excluded": True,
            "accepted_successor": accepted,
            "promoted_catalog_id": catalog_id if accepted else None,
            "promoted_source_id": successor_id if accepted else None,
            "expected_new_master_id": (
                _master_id(catalog_id, str(successor_id)) if accepted else None
            ),
            "invalidated_final_ids": copy.deepcopy(
                intake.get("invalidated_final_ids") or []
            ),
            "split": parent.get("split"),
            "synthetic": False,
        }
    )


def _exclusion_row(crosswalk: Mapping[str, Any]) -> dict[str, Any]:
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_master_parent_exclusion",
            "parent_master_id": crosswalk.get("parent_master_id"),
            "parent_master_record_sha256": crosswalk.get("parent_master_record_sha256"),
            "source_catalog_id": crosswalk.get("parent_source_catalog_id"),
            "source_id": crosswalk.get("parent_source_id"),
            "source_line_number": crosswalk.get("parent_source_line_number"),
            "source_line_sha256": crosswalk.get("parent_source_line_sha256"),
            "terminal_status": crosswalk.get("terminal_status"),
            "successor_catalog_id": crosswalk.get("promoted_catalog_id"),
            "successor_source_id": crosswalk.get("promoted_source_id"),
            "successor_expected_master_id": crosswalk.get("expected_new_master_id"),
            "excluded_from_training": True,
            "excluded_from_font_review": True,
            "prior_final_labels_invalidated": bool(
                crosswalk.get("invalidated_final_ids")
            ),
            "crosswalk_record_sha256": crosswalk.get("record_sha256"),
            "synthetic": False,
        }
    )


def _lineage_row(crosswalk: Mapping[str, Any]) -> dict[str, Any]:
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_recrop_promotion_lineage",
            "parent_master_id": crosswalk.get("parent_master_id"),
            "repair_candidate_id": crosswalk.get("repair_candidate_id"),
            "processed_successor_id": crosswalk.get("terminal_id"),
            "promoted_source_id": crosswalk.get("promoted_source_id"),
            "expected_new_master_id": crosswalk.get("expected_new_master_id"),
            "terminal_status": crosswalk.get("terminal_status"),
            "crosswalk_record_sha256": crosswalk.get("record_sha256"),
            "synthetic": False,
        }
    )


def _copy_accepted_assets(
    *,
    accepted: Sequence[Mapping[str, Any]],
    source_root: Path,
    output_root: Path,
) -> tuple[int, int]:
    copied: set[str] = set()
    total_bytes = 0
    for record in accepted:
        item_id = str(record["id"])
        assets = record.get("assets")
        if not isinstance(assets, Mapping):
            raise RecropPromotionError(f"{item_id}: asset DAG is missing")
        for kind, descriptor in sorted(assets.items()):
            if not isinstance(descriptor, Mapping):
                raise RecropPromotionError(f"{item_id}:{kind}: bad asset descriptor")
            source, relative = _validated_asset_source(
                source_root, descriptor, f"{item_id}.assets.{kind}"
            )
            if relative in copied:
                raise RecropPromotionError(f"duplicate promoted asset path: {relative}")
            copied.add(relative)
            destination = output_root.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            if destination.is_symlink() or sha256_file(destination) != descriptor.get(
                "file_sha256"
            ):
                raise RecropPromotionError(
                    f"promoted asset copy/hash verification failed: {relative}"
                )
            total_bytes += destination.stat().st_size
    return len(copied), total_bytes


def _preflight(
    *,
    repair_root: Path,
    processed_root: Path,
    library_root: Path,
    ledgers: Sequence[Path],
) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        contract = revision._load_repair_contract(repair_root)
        terminal = revision._load_terminal_outcomes(
            processed_root=processed_root,
            library_root=library_root,
            ledgers=ledgers,
            queue_rows=contract["queue_rows"],
            queue_manifest_sha256=contract["queue_manifest_sha256"],
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise RecropPromotionError(
            f"repair promotion preflight failed: {error}"
        ) from error
    unresolved = sorted(
        decision.item_id
        for decision in terminal["audit"].decisions.values()
        if decision.decision == "recrop"
    )
    if unresolved:
        raise RecropPromotionError(
            "promotion is blocked by unresolved recheck recrops; create a new "
            f"proposal/repair generation first: {unresolved[:12]}"
        )
    return contract, terminal


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    repair_root: Path,
    processed_root: Path,
    library_root: Path,
    ledgers: Sequence[Path],
    catalog_id: str,
) -> dict[str, Any]:
    contract, terminal = _preflight(
        repair_root=repair_root,
        processed_root=processed_root,
        library_root=library_root,
        ledgers=ledgers,
    )
    accepted: list[dict[str, Any]] = []
    crosswalk: list[dict[str, Any]] = []
    exclusions: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    lineages: list[dict[str, Any]] = []
    status_counts: Counter[str] = Counter()
    for sample_id in sorted(contract["intake"]):
        intake = contract["intake"][sample_id]
        parent = contract["parents"][sample_id]
        proposal = contract["proposals"][sample_id]
        status, terminal_record, decision = _terminal_status(
            intake=intake, terminal=terminal
        )
        status_counts[status] += 1
        row = _crosswalk_row(
            catalog_id=catalog_id,
            parent=parent,
            intake=intake,
            proposal=proposal,
            status=status,
            terminal_record=terminal_record,
            decision=decision,
        )
        crosswalk.append(row)
        exclusions.append(_exclusion_row(row))
        lineages.append(_lineage_row(row))
        if status == "recheck_pass":
            candidate_id = str(intake["successor_candidate_id"])
            assert terminal_record is not None and decision is not None
            accepted.append(
                _decorate_accepted(
                    record=terminal_record,
                    decision=decision,
                    parent=parent,
                    intake=intake,
                    proposal=proposal,
                    queue_row=contract["queue_rows"][candidate_id],
                )
            )
        else:
            rejected.append(
                seal(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "record_type": "font_matching_recrop_promotion_reject",
                        "parent_master_id": sample_id,
                        "terminal_status": status,
                        "terminal_id": (
                            terminal_record.get("id")
                            if terminal_record is not None
                            else None
                        ),
                        "terminal_record_sha256": (
                            sha256_json(terminal_record)
                            if terminal_record is not None
                            else None
                        ),
                        "crosswalk_record_sha256": row["record_sha256"],
                        "replacement_required": True,
                        "synthetic": False,
                    }
                )
            )

    if len(crosswalk) != len(contract["intake"]):
        raise RecropPromotionError("promotion target coverage drifted")
    accepted.sort(key=hard_audit.HARD_QA.record_order_key)
    try:
        hard_audit._validate_final_population(accepted)
    except (RuntimeError, ValueError) as error:
        raise RecropPromotionError(
            f"accepted delta population is invalid: {error}"
        ) from error

    physical_root.mkdir(parents=True, exist_ok=False)
    asset_count, asset_bytes = _copy_accepted_assets(
        accepted=accepted,
        source_root=processed_root,
        output_root=physical_root,
    )
    (physical_root / MANIFEST_FILE).write_bytes(jsonl_bytes(accepted))
    (physical_root / REJECTS_FILE).write_bytes(jsonl_bytes(rejected))
    (physical_root / LINEAGE_FILE).write_bytes(jsonl_bytes(lineages))
    (physical_root / CROSSWALK_FILE).write_bytes(jsonl_bytes(crosswalk))
    (physical_root / EXCLUSIONS_FILE).write_bytes(jsonl_bytes(exclusions))
    policy = {
        "schema_version": SCHEMA_VERSION,
        "tool": TOOL_ID,
        "catalog_id": catalog_id,
        "accepted_provenance": ["real_processed"],
        "manual_recrop_provenance": "real_manual_recrop",
        "synthetic_allowed": False,
        "synthetic_records": 0,
        "synthetic_assets": 0,
        "generative_glyphs": 0,
        "diagnostic_overlays_in_training_assets": 0,
        "qa_overlay_colors_are_not_training_assets": True,
        "successor_requires_exhaustive_recheck": True,
        "every_defect_parent_excluded": True,
    }
    (physical_root / POLICY_FILE).write_bytes(json_bytes(policy, pretty=True))
    dataset = terminal["dataset"]
    audit = terminal["audit"]
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_recrop_promotion_report",
            "tool": TOOL_ID,
            "catalog_id": catalog_id,
            "completed": True,
            "counts": {
                "targets": len(crosswalk),
                "parents_excluded": len(exclusions),
                "accepted": len(accepted),
                "rejected_or_replacement": len(rejected),
                "published_assets": asset_count,
                "published_asset_bytes": asset_bytes,
                "terminal_statuses": dict(sorted(status_counts.items())),
            },
            "inputs": {
                "repair_root": str(repair_root),
                "repair_marker_sha256": sha256_file(repair_root / repair.MARKER_FILE),
                "repair_report_sha256": sha256_file(repair_root / repair.REPORT_FILE),
                "repair_queue_manifest_sha256": contract["queue_manifest_sha256"],
                "processed_root": str(processed_root),
                "processed_binding": copy.deepcopy(dataset.binding),
                "audit_binding": copy.deepcopy(audit.binding),
                "library_root": str(library_root),
            },
            "outputs": {
                "root": str(declared_root),
                MANIFEST_FILE: sha256_file(physical_root / MANIFEST_FILE),
                REJECTS_FILE: sha256_file(physical_root / REJECTS_FILE),
                LINEAGE_FILE: sha256_file(physical_root / LINEAGE_FILE),
                CROSSWALK_FILE: sha256_file(physical_root / CROSSWALK_FILE),
                EXCLUSIONS_FILE: sha256_file(physical_root / EXCLUSIONS_FILE),
                POLICY_FILE: sha256_file(physical_root / POLICY_FILE),
            },
            "safety": {
                "parent_overwrites": 0,
                "hardlinks_created": 0,
                "qa_overlays_copied": 0,
                "proposal_previews_copied": 0,
                "synthetic_assets_written": 0,
                "font_labels_inherited": 0,
                "all_assets_copied_and_rehashed": True,
                "unresolved_recrops": 0,
            },
        }
    )
    (physical_root / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
    marker = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "tool": TOOL_ID,
        "catalog_id": catalog_id,
        "completed": True,
        "safe_replace": False,
        "declared_root": str(declared_root),
        "managed_files": _managed_files(physical_root),
    }
    (physical_root / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
    hard_audit.verify_dataset_binding(dataset.binding)
    hard_audit.verify_frozen_files(audit.frozen_files)
    repair.validate_tree(repair_root)
    return report


def _read_rows(
    path: Path, label: str, *, allow_empty: bool = False
) -> list[dict[str, Any]]:
    return revision._read_jsonl(path, label, allow_empty=allow_empty)


def validate_tree(root: Path, *, verify_assets: bool = True) -> dict[str, Any]:
    marker = repair.read_json(root / MARKER_FILE, "promotion marker")
    if (
        marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("tool") != TOOL_ID
        or marker.get("completed") is not True
    ):
        raise RecropPromotionError("promotion marker is invalid")
    catalog_id = _safe_component(marker.get("catalog_id"), "catalog id")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise RecropPromotionError("promotion marker lacks managed files")
    actual = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    expected = {MARKER_FILE, *[str(value) for value in managed]}
    if actual != expected:
        raise RecropPromotionError(
            "promotion inventory differs: "
            f"missing={sorted(expected - actual)[:8]} "
            f"unexpected={sorted(actual - expected)[:8]}"
        )
    for relative, expected_sha in managed.items():
        physical = _safe_managed_path(root, relative, f"marker[{relative}]")
        repair.require_sha(expected_sha, f"marker[{relative}].sha256")
        if not physical.is_file() or sha256_file(physical) != expected_sha:
            raise RecropPromotionError(f"stale promotion artifact: {relative}")

    crosswalk = _read_rows(root / CROSSWALK_FILE, "promotion crosswalk")
    exclusions = _read_rows(root / EXCLUSIONS_FILE, "parent exclusions")
    rejected = _read_rows(root / REJECTS_FILE, "promotion rejects", allow_empty=True)
    lineages = _read_rows(root / LINEAGE_FILE, "promotion lineage")
    for label, rows in (
        ("crosswalk", crosswalk),
        ("exclusion", exclusions),
        ("reject", rejected),
        ("lineage", lineages),
    ):
        for index, row in enumerate(rows, 1):
            repair.validate_seal(row, f"{label}:{index}")
    crosswalk_by_parent = revision._unique_by(
        crosswalk, "parent_master_id", "promotion crosswalk"
    )
    exclusion_by_parent = revision._unique_by(
        exclusions, "parent_master_id", "parent exclusions"
    )
    lineage_by_parent = revision._unique_by(
        lineages, "parent_master_id", "promotion lineage"
    )
    if set(crosswalk_by_parent) != set(exclusion_by_parent) or set(
        crosswalk_by_parent
    ) != set(lineage_by_parent):
        raise RecropPromotionError("crosswalk/exclusion/lineage parent sets differ")
    if any(row.get("excluded_from_training") is not True for row in exclusions):
        raise RecropPromotionError("every parent exclusion must be training-blocking")

    try:
        catalog = master.SourceCatalog(catalog_id, "hard", root)
        catalog_read = master.read_catalog(catalog, verify_assets=verify_assets)
        hard_audit._validate_final_population(
            _read_rows(root / MANIFEST_FILE, "promoted manifest", allow_empty=True)
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise RecropPromotionError(
            f"promoted hard catalog is invalid: {error}"
        ) from error
    accepted_ids = {str(row["id"]) for row in catalog_read.records}
    expected_accepted_ids = {
        str(row["expected_new_master_id"])
        for row in crosswalk
        if row.get("accepted_successor") is True
    }
    if accepted_ids != expected_accepted_ids:
        raise RecropPromotionError("promoted master-ID forecast differs from manifest")

    report = repair.read_json(root / REPORT_FILE, "promotion report")
    repair.validate_seal(report, "promotion report")
    counts = report.get("counts")
    outputs = report.get("outputs")
    if (
        not isinstance(counts, Mapping)
        or counts.get("targets") != len(crosswalk)
        or counts.get("parents_excluded") != len(exclusions)
        or counts.get("accepted") != catalog_read.row_count
        or counts.get("rejected_or_replacement") != len(rejected)
    ):
        raise RecropPromotionError("promotion report counts drifted")
    if not isinstance(outputs, Mapping):
        raise RecropPromotionError("promotion report lacks output hashes")
    for name in (
        MANIFEST_FILE,
        REJECTS_FILE,
        LINEAGE_FILE,
        CROSSWALK_FILE,
        EXCLUSIONS_FILE,
        POLICY_FILE,
    ):
        if outputs.get(name) != sha256_file(root / name):
            raise RecropPromotionError(f"promotion report hash drifted: {name}")
    return report


def _compare_trees(expected_root: Path, actual_root: Path) -> None:
    expected = {
        path.relative_to(expected_root).as_posix(): path.read_bytes()
        for path in expected_root.rglob("*")
        if path.is_file()
    }
    actual = {
        path.relative_to(actual_root).as_posix(): path.read_bytes()
        for path in actual_root.rglob("*")
        if path.is_file()
    }
    if expected.keys() != actual.keys():
        raise RecropPromotionError("deterministic promotion inventory differs")
    stale = [name for name in expected if expected[name] != actual[name]]
    if stale:
        raise RecropPromotionError(f"deterministic promotion differs: {stale[:8]}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--repair-root", type=Path, required=True)
    parser.add_argument("--processed-root", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, action="append", required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--catalog-id", default=DEFAULT_CATALOG_ID)
    parser.add_argument("--no-verify-assets", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repair_root = args.repair_root.expanduser().resolve()
    processed_root = args.processed_root.expanduser().resolve()
    library_root = args.library_root.expanduser().resolve()
    output_root = args.output_root.expanduser().resolve()
    ledgers = [value.expanduser().resolve() for value in args.ledger]
    catalog_id = _safe_component(args.catalog_id, "catalog id")
    _validate_output_separation(
        output_root=output_root,
        repair_root=repair_root,
        processed_root=processed_root,
        library_root=library_root,
    )
    if args.command == "build":
        # Crucially, preflight runs before even creating the temporary output.
        _preflight(
            repair_root=repair_root,
            processed_root=processed_root,
            library_root=library_root,
            ledgers=ledgers,
        )
        if output_root.exists():
            raise RecropPromotionError(
                f"refusing to overwrite promotion root: {output_root}"
            )
        output_root.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{output_root.name}.tmp-", dir=output_root.parent)
        )
        shutil.rmtree(temporary)
        try:
            report = _write_tree(
                physical_root=temporary,
                declared_root=output_root,
                repair_root=repair_root,
                processed_root=processed_root,
                library_root=library_root,
                ledgers=ledgers,
                catalog_id=catalog_id,
            )
            temporary.replace(output_root)
            validate_tree(output_root, verify_assets=not args.no_verify_assets)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    else:
        report = validate_tree(output_root, verify_assets=not args.no_verify_assets)
        temporary = Path(tempfile.mkdtemp(prefix="font-recrop-promote-validate-"))
        shutil.rmtree(temporary)
        try:
            _write_tree(
                physical_root=temporary,
                declared_root=output_root,
                repair_root=repair_root,
                processed_root=processed_root,
                library_root=library_root,
                ledgers=ledgers,
                catalog_id=catalog_id,
            )
            _compare_trees(output_root, temporary)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
