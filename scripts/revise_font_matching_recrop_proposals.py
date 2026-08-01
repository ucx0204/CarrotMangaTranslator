#!/usr/bin/env python3
"""Seal a new proposal generation from exhaustive repair-crop rechecks.

The first repair generation is immutable evidence.  This tool validates that
generation, its postprocessed successors, and exactly four completed QA
ledgers.  It then emits a new, sealed proposal snapshot:

* pass decisions retain the original proposal byte-for-byte at record level;
* recrop decisions bind a new source-page bbox and direct-preview PNG hash;
* human rejects and postprocess rejects become replacement-only proposals;
* initial replacement proposals remain replacement-only; and
* no QA sheet, overlay, generated image, or processed glyph is used as source
  pixels.

The output is proposal evidence only.  It is not training-eligible.  A revised
snapshot must be fed to ``build_font_matching_recrop_repair.py`` under a new
output root, postprocessed, and exhaustively rechecked again.
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import build_font_matching_recrop_repair as repair


hard_audit = repair.hard_audit

SCHEMA_VERSION = "font-matching-recrop-proposal-revision-v1"
OWNER = "carrot-manga-translator/font-matching-recrop-proposal-revision"
MARKER_FILE = ".font-matching-recrop-proposal-revision-owned.json"
PROPOSALS_FILE = "proposals.jsonl"
REVISIONS_FILE = "revisions.jsonl"
REPORT_FILE = "report.json"


class ProposalRevisionError(ValueError):
    """Raised when a repair/recheck binding cannot be proven exactly."""


def canonical_json(value: Any) -> str:
    return repair.canonical_json(value)


def sha256_file(path: Path) -> str:
    return repair.sha256_file(path)


def sha256_json(value: Any) -> str:
    return repair.sha256_bytes(canonical_json(value).encode("utf-8"))


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    return repair.seal(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return repair.json_bytes(value, pretty=pretty)


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return repair.jsonl_bytes(rows)


def _read_jsonl(
    path: Path, label: str, *, allow_empty: bool = False
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ProposalRevisionError(
                        f"{label}:{line_number}: invalid JSON: {error}"
                    ) from error
                if not isinstance(value, Mapping):
                    raise ProposalRevisionError(
                        f"{label}:{line_number}: expected an object"
                    )
                rows.append(dict(value))
    except OSError as error:
        raise ProposalRevisionError(
            f"{label}: could not read {path}: {error}"
        ) from error
    if not rows and not allow_empty:
        raise ProposalRevisionError(f"{label}: JSONL is empty")
    return rows


def _unique_by(
    rows: Sequence[dict[str, Any]], key: str, label: str
) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        value = repair.require_text(row.get(key), f"{label}:{index}.{key}")
        if value in output:
            raise ProposalRevisionError(f"{label}:{index}: duplicate {key} {value}")
        output[value] = row
    return output


def _safe_managed_path(root: Path, relative: Any, label: str) -> Path:
    text = repair.require_text(relative, label)
    if "\\" in text:
        raise ProposalRevisionError(f"{label}: managed paths must use POSIX separators")
    posix = PurePosixPath(text)
    windows = PureWindowsPath(text)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
        or ".." in posix.parts
    ):
        raise ProposalRevisionError(f"{label}: unsafe managed path")
    physical = root.joinpath(*posix.parts)
    if physical.is_symlink():
        raise ProposalRevisionError(f"{label}: symlinks are forbidden")
    return physical


def _managed_files(root: Path) -> dict[str, str]:
    output: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ProposalRevisionError(f"output contains a symlink: {path}")
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
        raise ProposalRevisionError(
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


def _load_repair_contract(repair_root: Path) -> dict[str, Any]:
    report = repair.validate_tree(repair_root)
    proposals = _unique_by(
        _read_jsonl(repair_root / repair.PROPOSAL_RECORDS_FILE, "proposal records"),
        "sample_id",
        "proposal records",
    )
    intake = _unique_by(
        _read_jsonl(repair_root / repair.INTAKE_FILE, "repair intake"),
        "parent_sample_id",
        "repair intake",
    )
    parents = _unique_by(
        _read_jsonl(repair_root / repair.PARENT_RECORDS_FILE, "parent records"),
        "id",
        "parent records",
    )
    if set(proposals) != set(intake) or set(parents) != set(intake):
        raise ProposalRevisionError("proposal, intake, and parent target sets differ")

    queue_rows = _unique_by(
        _read_jsonl(repair_root / repair.QUEUE_DIR / "manifest.jsonl", "repair queue"),
        "id",
        "repair queue",
    )
    expected_queue_ids: set[str] = set()
    proposal_contracts: Counter[str] = Counter()
    for sample_id in sorted(intake):
        proposal = proposals[sample_id]
        intake_row = intake[sample_id]
        parent = parents[sample_id]
        repair.validate_seal(proposal, f"proposal[{sample_id}]")
        repair.validate_seal(intake_row, f"intake[{sample_id}]")
        proposal_contract = (
            proposal.get("schema_version"),
            proposal.get("record_type"),
        )
        if proposal_contract not in repair.PROPOSAL_CONTRACTS:
            raise ProposalRevisionError(f"proposal[{sample_id}]: unsupported contract")
        proposal_contracts[str(proposal.get("record_type"))] += 1
        if intake_row.get("proposal_record_sha256") != proposal.get("record_sha256"):
            raise ProposalRevisionError(
                f"intake[{sample_id}]: proposal binding drifted"
            )
        parent_sha = sha256_json(parent)
        if intake_row.get("parent_master_record_sha256") != parent_sha:
            raise ProposalRevisionError(f"intake[{sample_id}]: parent binding drifted")
        if intake_row.get("action") != proposal.get("action"):
            raise ProposalRevisionError(f"intake[{sample_id}]: action binding drifted")
        candidate_id = intake_row.get("successor_candidate_id")
        candidate_sha = intake_row.get("successor_candidate_record_sha256")
        if proposal.get("action") == "recrop":
            candidate_id = repair.require_text(
                candidate_id, f"intake[{sample_id}].successor_candidate_id"
            )
            expected_queue_ids.add(candidate_id)
            queue_row = queue_rows.get(candidate_id)
            if queue_row is None or candidate_sha != sha256_json(queue_row):
                raise ProposalRevisionError(
                    f"intake[{sample_id}]: successor queue binding drifted"
                )
        elif candidate_id is not None or candidate_sha is not None:
            raise ProposalRevisionError(
                f"intake[{sample_id}]: replacement unexpectedly has a successor"
            )
    if set(queue_rows) != expected_queue_ids:
        raise ProposalRevisionError("repair queue IDs differ from recrop intake")

    counts = report.get("counts")
    if not isinstance(counts, Mapping) or counts.get("targets") != len(intake):
        raise ProposalRevisionError("repair report target count drifted")
    queue_report = report.get("outputs", {}).get("queue", {})
    if not isinstance(queue_report, Mapping):
        raise ProposalRevisionError("repair report lacks queue binding")
    queue_manifest_sha = sha256_file(repair_root / repair.QUEUE_DIR / "manifest.jsonl")
    if queue_report.get("manifest_sha256") != queue_manifest_sha:
        raise ProposalRevisionError("repair report queue manifest binding drifted")
    return {
        "report": report,
        "proposals": proposals,
        "intake": intake,
        "parents": parents,
        "queue_rows": queue_rows,
        "queue_manifest_sha256": queue_manifest_sha,
        "proposal_contract_counts": dict(sorted(proposal_contracts.items())),
    }


def _processed_parent_id(record: Mapping[str, Any], location: str) -> str:
    assets = record.get("assets")
    if not isinstance(assets, Mapping):
        raise ProposalRevisionError(f"{location}: missing assets")
    raw = assets.get("raw")
    if not isinstance(raw, Mapping):
        raise ProposalRevisionError(f"{location}: missing raw asset")
    return repair.require_text(
        raw.get("parent_sample_id"), f"{location}.raw.parent_sample_id"
    )


def _validate_processed_attestation(
    dataset: Any, expected_manifest_sha256: str
) -> None:
    marker = dataset.result.marker
    signature = marker.get("signature") if isinstance(marker, Mapping) else None
    attestation = (
        signature.get("input_builder_attestation")
        if isinstance(signature, Mapping)
        else None
    )
    if not isinstance(attestation, Mapping):
        raise ProposalRevisionError("processed marker lacks input builder attestation")
    if attestation.get("manifest_sha256") != expected_manifest_sha256:
        raise ProposalRevisionError(
            "processed dataset was built from another repair queue"
        )


def _load_terminal_outcomes(
    *,
    processed_root: Path,
    library_root: Path,
    ledgers: Sequence[Path],
    queue_rows: Mapping[str, dict[str, Any]],
    queue_manifest_sha256: str,
) -> dict[str, Any]:
    try:
        dataset = hard_audit.validate_processed_dataset(processed_root, library_root)
        _validate_processed_attestation(dataset, queue_manifest_sha256)
        audit = hard_audit.validate_audit_bundle(ledgers, dataset=dataset)
    except (OSError, RuntimeError, ValueError) as error:
        raise ProposalRevisionError(
            f"processed/recheck validation failed: {error}"
        ) from error

    processed_by_candidate: dict[str, dict[str, Any]] = {}
    processed_id_by_candidate: dict[str, str] = {}
    for processed_id, record in dataset.records_by_id.items():
        candidate_id = _processed_parent_id(record, f"processed[{processed_id}]")
        if candidate_id in processed_by_candidate:
            raise ProposalRevisionError(
                f"repair candidate produced duplicate successors: {candidate_id}"
            )
        processed_by_candidate[candidate_id] = record
        processed_id_by_candidate[candidate_id] = processed_id

    rejects_by_candidate: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(dataset.result.rejects, 1):
        candidate_id = repair.require_text(
            row.get("parent_id") or row.get("id"),
            f"processed rejects:{index}.parent_id",
        )
        if candidate_id in rejects_by_candidate:
            raise ProposalRevisionError(f"duplicate postprocess reject: {candidate_id}")
        rejects_by_candidate[candidate_id] = dict(row)

    queue_ids = set(queue_rows)
    processed_ids = set(processed_by_candidate)
    reject_ids = set(rejects_by_candidate)
    if processed_ids & reject_ids:
        raise ProposalRevisionError("a repair candidate has both successor and reject")
    if processed_ids | reject_ids != queue_ids:
        missing = sorted(queue_ids - processed_ids - reject_ids)
        extra = sorted((processed_ids | reject_ids) - queue_ids)
        raise ProposalRevisionError(
            "repair candidates lack exactly one terminal outcome: "
            f"missing={missing[:8]} extra={extra[:8]}"
        )
    if set(audit.decisions) != set(dataset.records_by_id):
        raise ProposalRevisionError("recheck decisions do not cover all successors")

    return {
        "dataset": dataset,
        "audit": audit,
        "processed_by_candidate": processed_by_candidate,
        "processed_id_by_candidate": processed_id_by_candidate,
        "rejects_by_candidate": rejects_by_candidate,
    }


def _expand_bbox(
    bbox: tuple[int, int, int, int], padding: int, page_size: tuple[int, int]
) -> tuple[int, int, int, int]:
    width, height = page_size
    x1, y1, x2, y2 = bbox
    expanded = (
        max(0, x1 - padding),
        max(0, y1 - padding),
        min(width, x2 + padding),
        min(height, y2 + padding),
    )
    if not (expanded[0] < expanded[2] and expanded[1] < expanded[3]):
        raise ProposalRevisionError(
            f"expanded recrop bbox is invalid: {list(expanded)}"
        )
    return expanded


def _preview_sha(decoded: Any, bbox: tuple[int, int, int, int]) -> str:
    if not (
        0 <= bbox[0] < bbox[2] <= decoded.width
        and 0 <= bbox[1] < bbox[3] <= decoded.height
    ):
        raise ProposalRevisionError(
            f"recheck bbox exceeds decoded source page: {list(bbox)}"
        )
    crop = decoded.crop(bbox).convert("RGB")
    try:
        return repair.sha256_bytes(hard_audit.encode_png(crop))
    finally:
        crop.close()


def _revision_evidence(
    *,
    sample_id: str,
    prior: Mapping[str, Any],
    intake: Mapping[str, Any],
    terminal_kind: str,
    terminal_record: Mapping[str, Any],
    terminal_record_sha256: str,
    decision: Any | None,
    applied_bbox: tuple[int, int, int, int],
    prior_proposals_sha256: str,
    repair_report_sha256: str,
    queue_manifest_sha256: str,
) -> dict[str, Any]:
    review = None
    if decision is not None:
        review = {
            "decision": decision.decision,
            "reject_reason": decision.reject_reason,
            "recrop_bbox_px": (
                list(decision.recrop_bbox_px)
                if decision.recrop_bbox_px is not None
                else None
            ),
            "padding_px": decision.padding_px,
            "reviewer": decision.reviewer,
            "reviewed_at": decision.reviewed_at,
            "notes": decision.notes,
            "shard_tag": decision.shard_tag,
            "sheet": decision.sheet,
            "cell_index": decision.cell_index,
            "ledger": decision.ledger_path,
            "ledger_sha256": decision.ledger_sha256,
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "sample_id": sample_id,
        "prior_proposal_record_sha256": prior.get("record_sha256"),
        "prior_proposal_snapshot_sha256": prior_proposals_sha256,
        "repair_report_sha256": repair_report_sha256,
        "repair_queue_manifest_sha256": queue_manifest_sha256,
        "repair_candidate_id": intake.get("successor_candidate_id"),
        "repair_candidate_record_sha256": intake.get(
            "successor_candidate_record_sha256"
        ),
        "terminal_kind": terminal_kind,
        "terminal_id": terminal_record.get("id"),
        "terminal_record_sha256": terminal_record_sha256,
        "recheck": review,
        "prior_recrop_bbox_px": prior.get("recrop_bbox_px"),
        "applied_bbox_px": list(applied_bbox),
        "coordinate_space": "source_page_pixels_xyxy_half_open",
        "source_pixels": "hash_verified_library_page_only",
        "viewed_original": True,
        "qa_overlay": False,
        "synthetic": False,
    }


def _revised_from_decision(
    *,
    sample_id: str,
    prior: Mapping[str, Any],
    intake: Mapping[str, Any],
    parent: Mapping[str, Any],
    decoded: Any,
    current_bbox: tuple[int, int, int, int],
    terminal_kind: str,
    terminal_record: Mapping[str, Any],
    terminal_record_sha256: str,
    decision: Any | None,
    prior_proposals_sha256: str,
    repair_report_sha256: str,
    queue_manifest_sha256: str,
) -> dict[str, Any]:
    del parent  # The parent was already hash-bound and source-validated by the caller.
    revised = {
        key: copy.deepcopy(value)
        for key, value in prior.items()
        if key not in {"record_sha256", "revision"}
    }
    if decision is not None and decision.decision == "recrop":
        if decision.recrop_bbox_px is None:
            raise ProposalRevisionError(f"{sample_id}: recrop decision lacks bbox")
        applied_bbox = _expand_bbox(
            decision.recrop_bbox_px,
            decision.padding_px,
            (decoded.width, decoded.height),
        )
        if list(applied_bbox) == prior.get("recrop_bbox_px"):
            raise ProposalRevisionError(f"{sample_id}: recheck recrop is a no-op")
        orientation = prior.get("actual_orientation")
        if orientation not in repair.SINGLE_ORIENTATIONS:
            raise ProposalRevisionError(
                f"{sample_id}: revised recrop lost horizontal/vertical orientation"
            )
        revised.update(
            {
                "action": "recrop",
                "actual_orientation": orientation,
                "recrop_bbox_px": list(applied_bbox),
                "preview_bbox_px": list(applied_bbox),
                "preview_crop_sha256": _preview_sha(decoded, applied_bbox),
                "reviewer": decision.reviewer,
                "reviewed_at": decision.reviewed_at,
                "note": decision.notes,
            }
        )
    else:
        applied_bbox = current_bbox
        if decision is not None:
            reviewer = decision.reviewer
            reviewed_at = decision.reviewed_at
            note = (
                "재후처리 육안검수에서 제외 판정: "
                f"{decision.reject_reason}. {decision.notes}".strip()
            )
        else:
            reviewer = prior.get("reviewer")
            reviewed_at = prior.get("reviewed_at")
            reasons = terminal_record.get("failure_reasons")
            reason_text = (
                ", ".join(str(value) for value in reasons)
                if isinstance(reasons, list)
                else "unknown"
            )
            note = f"후처리 실패로 재사용하지 않고 교체 대상으로 전환: {reason_text}"
        revised.update(
            {
                "action": "replace",
                "actual_orientation": None,
                "recrop_bbox_px": None,
                "preview_bbox_px": list(current_bbox),
                "preview_crop_sha256": _preview_sha(decoded, current_bbox),
                "reviewer": reviewer,
                "reviewed_at": reviewed_at,
                "note": note,
            }
        )
    revised["revision"] = _revision_evidence(
        sample_id=sample_id,
        prior=prior,
        intake=intake,
        terminal_kind=terminal_kind,
        terminal_record=terminal_record,
        terminal_record_sha256=terminal_record_sha256,
        decision=decision,
        applied_bbox=applied_bbox,
        prior_proposals_sha256=prior_proposals_sha256,
        repair_report_sha256=repair_report_sha256,
        queue_manifest_sha256=queue_manifest_sha256,
    )
    return seal(revised)


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    repair_root: Path,
    processed_root: Path,
    library_root: Path,
    ledgers: Sequence[Path],
) -> dict[str, Any]:
    contract = _load_repair_contract(repair_root)
    terminal = _load_terminal_outcomes(
        processed_root=processed_root,
        library_root=library_root,
        ledgers=ledgers,
        queue_rows=contract["queue_rows"],
        queue_manifest_sha256=contract["queue_manifest_sha256"],
    )
    dataset = terminal["dataset"]
    audit = terminal["audit"]
    prior_proposals_path = repair_root / repair.PROPOSAL_RECORDS_FILE
    prior_proposals_sha = sha256_file(prior_proposals_path)
    repair_report_sha = sha256_file(repair_root / repair.REPORT_FILE)

    output_rows: list[dict[str, Any]] = []
    revision_rows: list[dict[str, Any]] = []
    disposition_counts: Counter[str] = Counter()
    for sample_id in sorted(contract["intake"]):
        prior = contract["proposals"][sample_id]
        intake = contract["intake"][sample_id]
        parent = contract["parents"][sample_id]
        _page_path, _page_bytes, decoded, current_bbox = repair._resolve_page(
            parent=parent,
            proposal=prior,
            library_root=library_root,
            sample_id=sample_id,
        )
        try:
            if prior.get("action") == "replace":
                output = copy.deepcopy(prior)
                disposition_counts["initial_replace_unchanged"] += 1
            else:
                candidate_id = str(intake["successor_candidate_id"])
                if candidate_id in terminal["rejects_by_candidate"]:
                    rejected = terminal["rejects_by_candidate"][candidate_id]
                    output = _revised_from_decision(
                        sample_id=sample_id,
                        prior=prior,
                        intake=intake,
                        parent=parent,
                        decoded=decoded,
                        current_bbox=current_bbox,
                        terminal_kind="postprocess_reject",
                        terminal_record=rejected,
                        terminal_record_sha256=sha256_json(rejected),
                        decision=None,
                        prior_proposals_sha256=prior_proposals_sha,
                        repair_report_sha256=repair_report_sha,
                        queue_manifest_sha256=contract["queue_manifest_sha256"],
                    )
                    disposition_counts["postprocess_reject_to_replace"] += 1
                else:
                    processed = terminal["processed_by_candidate"][candidate_id]
                    processed_id = terminal["processed_id_by_candidate"][candidate_id]
                    decision = audit.decisions[processed_id]
                    if decision.decision == "pass":
                        output = copy.deepcopy(prior)
                        disposition_counts["recheck_pass_unchanged"] += 1
                    else:
                        output = _revised_from_decision(
                            sample_id=sample_id,
                            prior=prior,
                            intake=intake,
                            parent=parent,
                            decoded=decoded,
                            current_bbox=current_bbox,
                            terminal_kind="processed_successor",
                            terminal_record=processed,
                            terminal_record_sha256=sha256_json(processed),
                            decision=decision,
                            prior_proposals_sha256=prior_proposals_sha,
                            repair_report_sha256=repair_report_sha,
                            queue_manifest_sha256=contract["queue_manifest_sha256"],
                        )
                        disposition_counts[
                            (
                                "recheck_recrop_revised"
                                if decision.decision == "recrop"
                                else "recheck_reject_to_replace"
                            )
                        ] += 1
            repair.validate_seal(output, f"output proposal[{sample_id}]")
            output_rows.append(output)
            if output.get("record_sha256") != prior.get("record_sha256"):
                revision = output.get("revision")
                if not isinstance(revision, Mapping):
                    raise ProposalRevisionError(
                        f"output proposal[{sample_id}]: changed without revision evidence"
                    )
                revision_rows.append(
                    seal(
                        {
                            **copy.deepcopy(dict(revision)),
                            "record_type": "font_matching_recrop_proposal_revision",
                            "revised_proposal_record_sha256": output["record_sha256"],
                        }
                    )
                )
        finally:
            decoded.close()

    if len(output_rows) != len(contract["intake"]):
        raise ProposalRevisionError("output proposal coverage drifted")
    physical_root.mkdir(parents=True, exist_ok=False)
    (physical_root / PROPOSALS_FILE).write_bytes(jsonl_bytes(output_rows))
    (physical_root / REVISIONS_FILE).write_bytes(jsonl_bytes(revision_rows))
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_recrop_proposal_revision_report",
            "inputs": {
                "repair_root": str(repair_root),
                "repair_marker_sha256": sha256_file(repair_root / repair.MARKER_FILE),
                "repair_report_sha256": repair_report_sha,
                "prior_proposals_sha256": prior_proposals_sha,
                "repair_queue_manifest_sha256": contract["queue_manifest_sha256"],
                "processed_root": str(processed_root),
                "processed_binding": copy.deepcopy(dataset.binding),
                "audit_binding": copy.deepcopy(audit.binding),
                "library_root": str(library_root),
                "proposal_contract_counts": contract["proposal_contract_counts"],
            },
            "counts": {
                "targets": len(output_rows),
                "revisions": len(revision_rows),
                "unchanged": len(output_rows) - len(revision_rows),
                "dispositions": dict(sorted(disposition_counts.items())),
            },
            "outputs": {
                "root": str(declared_root),
                "proposals": str(declared_root / PROPOSALS_FILE),
                "proposals_sha256": sha256_file(physical_root / PROPOSALS_FILE),
                "revisions": str(declared_root / REVISIONS_FILE),
                "revisions_sha256": sha256_file(physical_root / REVISIONS_FILE),
            },
            "next_step": {
                "training_eligible": False,
                "requires_new_repair_generation": bool(revision_rows),
                "proposal_argument": str(declared_root / PROPOSALS_FILE),
                "recheck_until_no_recrop": True,
            },
            "safety": {
                "source_files_modified": False,
                "prior_proposal_records_modified": False,
                "qa_overlays_copied": 0,
                "processed_glyphs_copied": 0,
                "synthetic_assets_written": 0,
                "direct_previews_recomputed_from_library_pages": len(output_rows),
            },
        }
    )
    (physical_root / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
    marker = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "safe_replace": False,
        "declared_root": str(declared_root),
        "managed_files": _managed_files(physical_root),
    }
    (physical_root / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))

    hard_audit.verify_dataset_binding(dataset.binding)
    hard_audit.verify_frozen_files(audit.frozen_files)
    repair.validate_tree(repair_root)
    return report


def validate_tree(root: Path) -> dict[str, Any]:
    marker = repair.read_json(root / MARKER_FILE, "proposal revision marker")
    if marker.get("schema_version") != SCHEMA_VERSION or marker.get("owner") != OWNER:
        raise ProposalRevisionError("proposal revision marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise ProposalRevisionError("proposal revision marker lacks managed files")
    actual = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    expected = {MARKER_FILE, *[str(value) for value in managed]}
    if actual != expected:
        raise ProposalRevisionError(
            "proposal revision inventory differs: "
            f"missing={sorted(expected - actual)[:8]} "
            f"unexpected={sorted(actual - expected)[:8]}"
        )
    for relative, expected_sha in managed.items():
        physical = _safe_managed_path(root, relative, f"marker[{relative}]")
        repair.require_sha(expected_sha, f"marker[{relative}].sha256")
        if not physical.is_file() or sha256_file(physical) != expected_sha:
            raise ProposalRevisionError(f"stale proposal revision artifact: {relative}")

    proposals = _read_jsonl(root / PROPOSALS_FILE, "revised proposals")
    proposal_map = _unique_by(proposals, "sample_id", "revised proposals")
    for sample_id, row in proposal_map.items():
        repair.validate_seal(row, f"revised proposal[{sample_id}]")
        if (
            row.get("schema_version"),
            row.get("record_type"),
        ) not in repair.PROPOSAL_CONTRACTS:
            raise ProposalRevisionError(f"revised proposal[{sample_id}]: bad contract")
    revisions = _read_jsonl(
        root / REVISIONS_FILE, "proposal revisions", allow_empty=True
    )
    for index, row in enumerate(revisions, 1):
        repair.validate_seal(row, f"proposal revision:{index}")
        revised_sha = row.get("revised_proposal_record_sha256")
        sample_id = repair.require_text(
            row.get("sample_id"), f"proposal revision:{index}.sample_id"
        )
        if (
            sample_id not in proposal_map
            or proposal_map[sample_id].get("record_sha256") != revised_sha
        ):
            raise ProposalRevisionError(
                f"proposal revision:{index}: output binding drifted"
            )
    report = repair.read_json(root / REPORT_FILE, "proposal revision report")
    repair.validate_seal(report, "proposal revision report")
    counts = report.get("counts")
    if (
        not isinstance(counts, Mapping)
        or counts.get("targets") != len(proposals)
        or counts.get("revisions") != len(revisions)
    ):
        raise ProposalRevisionError("proposal revision report counts drifted")
    outputs = report.get("outputs")
    if (
        not isinstance(outputs, Mapping)
        or outputs.get("proposals_sha256") != sha256_file(root / PROPOSALS_FILE)
        or outputs.get("revisions_sha256") != sha256_file(root / REVISIONS_FILE)
    ):
        raise ProposalRevisionError("proposal revision report hashes drifted")
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
        raise ProposalRevisionError("deterministic rebuild inventory differs")
    stale = [name for name in expected if expected[name] != actual[name]]
    if stale:
        raise ProposalRevisionError(f"deterministic rebuild differs: {stale[:8]}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--repair-root", type=Path, required=True)
    parser.add_argument("--processed-root", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, action="append", required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repair_root = args.repair_root.expanduser().resolve()
    processed_root = args.processed_root.expanduser().resolve()
    library_root = args.library_root.expanduser().resolve()
    output_root = args.output_root.expanduser().resolve()
    ledgers = [value.expanduser().resolve() for value in args.ledger]
    _validate_output_separation(
        output_root=output_root,
        repair_root=repair_root,
        processed_root=processed_root,
        library_root=library_root,
    )
    if args.command == "build":
        if output_root.exists():
            raise ProposalRevisionError(
                f"refusing to overwrite proposal revision root: {output_root}"
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
            )
            temporary.replace(output_root)
            validate_tree(output_root)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    else:
        report = validate_tree(output_root)
        temporary = Path(tempfile.mkdtemp(prefix="font-recrop-revision-validate-"))
        shutil.rmtree(temporary)
        try:
            _write_tree(
                physical_root=temporary,
                declared_root=output_root,
                repair_root=repair_root,
                processed_root=processed_root,
                library_root=library_root,
                ledgers=ledgers,
            )
            _compare_trees(output_root, temporary)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
