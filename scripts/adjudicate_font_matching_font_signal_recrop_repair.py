#!/usr/bin/env python3
"""Seal primary/secondary review and bbox revisions for font-signal repairs.

This tool consumes the immutable v1 proposal records plus two human review
sidecars: the completed primary CSV ledger and an independent secondary JSONL
review.  It emits a separate v2 adjudication artifact.  The four revised
bboxes are cropped directly from hash-verified library pages and remain
pending direct visual review.  Consensus accepts and terminal exclusions are
recorded but deliberately withheld from promotion.

No repair queue or training sample is created by this tool.
"""

from __future__ import annotations

import argparse
import copy
import csv
import io
import json
import os
import shutil
import tempfile
import uuid
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

import build_font_matching_font_signal_recrop_repair as v1


repair = v1.repair

SCHEMA_VERSION = "font-matching-font-signal-recrop-repair-adjudication-v2"
OWNER = "carrot-manga-translator/font-signal-recrop-repair-adjudication"
MARKER_FILE = ".font-matching-font-signal-recrop-repair-adjudication-owned.json"
ADJUDICATIONS_FILE = "adjudications.jsonl"
REVISIONS_FILE = "revisions.jsonl"
REVISION_LEDGER_FILE = "revision-review-ledger.csv"
REPORT_FILE = "report.json"
EVIDENCE_DIR = "evidence"
PREVIEW_DIR = "revision-previews"
CONTEXT_DIR = "revision-context"
PRIMARY_EVIDENCE_FILE = f"{EVIDENCE_DIR}/primary-review-ledger.csv"
SECONDARY_EVIDENCE_FILE = f"{EVIDENCE_DIR}/secondary-review-input.jsonl"
PRIOR_PROPOSALS_EVIDENCE_FILE = f"{EVIDENCE_DIR}/prior-proposals.jsonl"
PRIOR_REPORT_EVIDENCE_FILE = f"{EVIDENCE_DIR}/prior-report.json"
PRIOR_MARKER_EVIDENCE_FILE = f"{EVIDENCE_DIR}/prior-ownership-marker.json"
SECONDARY_SIDECAR_FILE = "secondary-review-input.jsonl"
PRIMARY_ALLOWED_DECISIONS = (
    "accept_proposal|revise_bbox|confirm_terminal|restore_repair|reject"
)
PRIMARY_HEADER = (
    "sample_id",
    "proposed_action",
    "proposed_bbox_px",
    "preview_path",
    "preview_sha256",
    "allowed_decisions",
    "decision",
    "revision_bbox_px",
    "reviewer",
    "reviewed_at",
    "notes",
)
REVISION_LEDGER_HEADER = (
    "sample_id",
    "review_alignment",
    "prior_bbox_px",
    "revision_bbox_px",
    "preview_path",
    "preview_sha256",
    "context_path",
    "context_sha256",
    "allowed_decisions",
    "decision",
    "next_revision_bbox_px",
    "reviewer",
    "reviewed_at",
    "notes",
)
REVISION_ALLOWED_DECISIONS = "accept_revision|revise_bbox|reject_revision"
SECONDARY_KEYS = frozenset(
    {
        "sample_id",
        "proposal_record_sha256",
        "card_sha256",
        "decision",
        "confidence",
        "rationale",
        "reviewer",
        "viewed_direct_preview_original",
        "viewed_source_context_original",
        "viewed_source_page_original",
    }
)


class FontSignalAdjudicationError(ValueError):
    """Raised when review, provenance, or revision bindings cannot be proven."""


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


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise FontSignalAdjudicationError(
                        f"{label}:{line_number}: invalid JSON: {error}"
                    ) from error
                if not isinstance(value, Mapping):
                    raise FontSignalAdjudicationError(
                        f"{label}:{line_number}: expected an object"
                    )
                rows.append(dict(value))
    except OSError as error:
        raise FontSignalAdjudicationError(
            f"{label}: could not read {path}: {error}"
        ) from error
    if not rows:
        raise FontSignalAdjudicationError(f"{label}: JSONL is empty")
    return rows


def _unique(
    rows: Sequence[dict[str, Any]], key: str, label: str
) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        value = repair.require_text(row.get(key), f"{label}:{index}.{key}")
        if value in output:
            raise FontSignalAdjudicationError(
                f"{label}:{index}: duplicate {key} {value}"
            )
        output[value] = row
    return output


def _safe_relative_path(value: Any, label: str) -> PurePosixPath:
    text = repair.require_text(value, label)
    if "\\" in text:
        raise FontSignalAdjudicationError(
            f"{label}: relative paths must use POSIX separators"
        )
    posix = PurePosixPath(text)
    windows = PureWindowsPath(text)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or ".." in posix.parts
    ):
        raise FontSignalAdjudicationError(f"{label}: unsafe relative path")
    return posix


def _safe_managed_path(root: Path, value: Any, label: str) -> Path:
    relative = _safe_relative_path(value, label)
    path = root.joinpath(*relative.parts)
    if _is_link_or_junction(path):
        raise FontSignalAdjudicationError(f"{label}: links are forbidden")
    return path


def _require_bbox(value: Any, label: str) -> tuple[int, int, int, int]:
    try:
        return repair.require_bbox(value, label)
    except repair.RecropRepairError as error:
        raise FontSignalAdjudicationError(str(error)) from error


def _bbox_cell(
    value: str, label: str, *, allow_null: bool
) -> tuple[int, int, int, int] | None:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise FontSignalAdjudicationError(f"{label}: invalid JSON bbox") from error
    if parsed is None and allow_null:
        return None
    return _require_bbox(parsed, label)


def _is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or (
        hasattr(path, "is_junction") and bool(path.is_junction())
    )


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
        raise FontSignalAdjudicationError(
            f"{first_label} and {second_label} must be separate, non-nested paths"
        )


def _validate_root_separation(
    *, output_root: Path, proposal_root: Path, library_root: Path
) -> None:
    _require_disjoint(output_root, proposal_root, "output root", "proposal root")
    _require_disjoint(output_root, library_root, "output root", "library root")
    _require_disjoint(proposal_root, library_root, "proposal root", "library root")


def _regular_file_inventory(root: Path) -> set[str]:
    files: set[str] = set()
    for current_text, directory_names, file_names in os.walk(
        root, topdown=True, followlinks=False
    ):
        current = Path(current_text)
        if _is_link_or_junction(current):
            raise FontSignalAdjudicationError(
                f"artifact contains a linked directory: {current}"
            )
        for name in list(directory_names):
            child = current / name
            if _is_link_or_junction(child) or not _is_within(root, child):
                raise FontSignalAdjudicationError(
                    f"artifact contains an unsafe directory: {child}"
                )
        for name in file_names:
            child = current / name
            if (
                _is_link_or_junction(child)
                or not child.is_file()
                or not _is_within(root, child)
            ):
                raise FontSignalAdjudicationError(
                    f"artifact contains an unsafe file: {child}"
                )
            relative = child.relative_to(root).as_posix()
            if relative in files:
                raise FontSignalAdjudicationError(
                    f"artifact contains a duplicate file path: {relative}"
                )
            files.add(relative)
    return files


def _managed_files(root: Path) -> dict[str, str]:
    return {
        relative: sha256_file(root.joinpath(*PurePosixPath(relative).parts))
        for relative in sorted(_regular_file_inventory(root))
        if relative != MARKER_FILE
    }


def _resolve_library_page(
    proposal: Mapping[str, Any], library_root: Path, sample_id: str
) -> tuple[Path, bytes, Image.Image]:
    source = proposal.get("source_page")
    if not isinstance(source, Mapping):
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: source_page is missing"
        )
    relative = _safe_relative_path(
        source.get("path"), f"proposal[{sample_id}].source_page.path"
    )
    page_path = library_root.joinpath(*relative.parts).resolve()
    if (
        not _is_within(library_root, page_path)
        or not page_path.is_file()
        or _is_link_or_junction(page_path)
    ):
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: missing or unsafe source page"
        )
    payload = page_path.read_bytes()
    expected_sha = repair.require_sha(
        source.get("file_sha256"), f"proposal[{sample_id}].source_page.file_sha256"
    )
    if repair.sha256_bytes(payload) != expected_sha:
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: source page hash drifted"
        )
    if (
        source.get("provenance") != "real_preserved"
        or source.get("storage_root") != "library_root"
        or source.get("size_bytes") != len(payload)
    ):
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: source page provenance drifted"
        )
    try:
        with Image.open(page_path) as opened:
            decoded = ImageOps.exif_transpose(opened).convert("RGB")
            decoded.load()
    except (OSError, UnidentifiedImageError) as error:
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: source page decode failed"
        ) from error
    if source.get("size_px") != [decoded.width, decoded.height]:
        decoded.close()
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: source page dimensions drifted"
        )
    physical_path = source.get("physical_path_review_only")
    if physical_path is not None and Path(str(physical_path)).resolve() != page_path:
        decoded.close()
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}]: physical page binding drifted"
        )
    return page_path, payload, decoded


def _check_bbox(
    bbox: tuple[int, int, int, int], decoded: Image.Image, label: str
) -> None:
    if not (
        0 <= bbox[0] < bbox[2] <= decoded.width
        and 0 <= bbox[1] < bbox[3] <= decoded.height
    ):
        raise FontSignalAdjudicationError(
            f"{label}: bbox exceeds decoded page: {list(bbox)}"
        )


def _asset_matches_source(
    *,
    proposal_root: Path,
    proposal: Mapping[str, Any],
    key: str,
    decoded: Image.Image,
    sample_id: str,
) -> None:
    asset = proposal.get(key)
    if not isinstance(asset, Mapping):
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}].{key}: asset is missing"
        )
    bbox = _require_bbox(asset.get("bbox_px"), f"proposal[{sample_id}].{key}.bbox")
    _check_bbox(bbox, decoded, f"proposal[{sample_id}].{key}")
    expected = v1._png_crop(decoded, bbox)
    path = _safe_managed_path(
        proposal_root, asset.get("path"), f"proposal[{sample_id}].{key}.path"
    )
    if (
        asset.get("qa_overlay") is not False
        or asset.get("synthetic") is not False
        or asset.get("pixel_source") != "direct_hash_verified_library_page_crop"
        or not path.is_file()
        or path.read_bytes() != expected
        or asset.get("file_sha256") != repair.sha256_bytes(expected)
        or asset.get("size_px") != [bbox[2] - bbox[0], bbox[3] - bbox[1]]
    ):
        raise FontSignalAdjudicationError(
            f"proposal[{sample_id}].{key}: not an exact source-page crop"
        )


def _load_prior_contract(
    *,
    proposal_root: Path,
    primary_ledger: Path,
    secondary_review: Path,
    library_root: Path,
    expected_targets: int,
) -> dict[str, Any]:
    proposal_root = proposal_root.resolve()
    primary_ledger = primary_ledger.resolve()
    secondary_review = secondary_review.resolve()
    if primary_ledger != (proposal_root / v1.LEDGER_FILE).resolve():
        raise FontSignalAdjudicationError(
            "primary ledger must be the completed v1 review-ledger-template.csv"
        )
    if secondary_review != (proposal_root / SECONDARY_SIDECAR_FILE).resolve():
        raise FontSignalAdjudicationError(
            "secondary review must be the v1 secondary-review-input.jsonl sidecar"
        )
    if _is_link_or_junction(proposal_root) or not proposal_root.is_dir():
        raise FontSignalAdjudicationError("prior proposal root is missing or unsafe")
    marker_path = proposal_root / v1.MARKER_FILE
    marker = repair.read_json(marker_path, "prior proposal ownership marker")
    if (
        marker.get("schema_version") != v1.SCHEMA_VERSION
        or marker.get("owner") != v1.OWNER
        or marker.get("safe_replace") is not False
    ):
        raise FontSignalAdjudicationError("prior proposal ownership marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise FontSignalAdjudicationError(
            "prior proposal marker lacks a managed inventory"
        )
    managed_names: set[str] = set()
    for relative, expected_sha in managed.items():
        safe = _safe_relative_path(relative, f"prior marker[{relative}]")
        name = safe.as_posix()
        if name == v1.MARKER_FILE:
            raise FontSignalAdjudicationError(
                "prior marker must not manage its own ownership file"
            )
        managed_names.add(name)
        repair.require_sha(expected_sha, f"prior marker[{relative}].sha256")
        physical = proposal_root.joinpath(*safe.parts)
        if not physical.is_file():
            raise FontSignalAdjudicationError(f"prior managed file is missing: {name}")
        if name != v1.LEDGER_FILE and sha256_file(physical) != expected_sha:
            raise FontSignalAdjudicationError(
                f"prior managed artifact is stale/tampered: {name}"
            )
    actual = _regular_file_inventory(proposal_root)
    expected_actual = {v1.MARKER_FILE, SECONDARY_SIDECAR_FILE, *managed_names}
    if actual != expected_actual:
        raise FontSignalAdjudicationError(
            "prior proposal inventory differs; "
            f"missing={sorted(expected_actual-actual)[:8]} "
            f"unexpected={sorted(actual-expected_actual)[:8]}"
        )
    historical_ledger_sha = repair.require_sha(
        managed.get(v1.LEDGER_FILE), "prior marker historical ledger sha256"
    )
    if sha256_file(primary_ledger) == historical_ledger_sha:
        raise FontSignalAdjudicationError(
            "primary ledger still matches the blank historical template"
        )

    proposals = _unique(
        _read_jsonl(proposal_root / v1.PROPOSALS_FILE, "prior proposals"),
        "sample_id",
        "prior proposals",
    )
    if len(proposals) != expected_targets:
        raise FontSignalAdjudicationError(
            f"expected {expected_targets} prior proposals, got {len(proposals)}"
        )
    terminal = _unique(
        _read_jsonl(proposal_root / v1.TERMINAL_FILE, "prior terminal projection"),
        "sample_id",
        "prior terminal projection",
    )
    report_path = proposal_root / v1.REPORT_FILE
    report = repair.read_json(report_path, "prior proposal report")
    try:
        repair.validate_seal(report, "prior proposal report")
    except repair.RecropRepairError as error:
        raise FontSignalAdjudicationError(str(error)) from error
    outputs = report.get("outputs")
    inputs = report.get("inputs")
    if (
        not isinstance(outputs, Mapping)
        or outputs.get("proposals_sha256")
        != sha256_file(proposal_root / v1.PROPOSALS_FILE)
        or outputs.get("terminal_replacements_sha256")
        != sha256_file(proposal_root / v1.TERMINAL_FILE)
        or outputs.get("review_ledger_template_sha256") != historical_ledger_sha
        or not isinstance(inputs, Mapping)
        or Path(str(inputs.get("library_root"))).resolve() != library_root.resolve()
    ):
        raise FontSignalAdjudicationError("prior proposal report bindings drifted")

    expected_terminal = {
        sample_id
        for sample_id, row in proposals.items()
        if row.get("action") == "terminal_replacement"
    }
    if set(terminal) != expected_terminal or any(
        terminal[sample_id] != proposals[sample_id] for sample_id in terminal
    ):
        raise FontSignalAdjudicationError("prior terminal projection drifted")

    for sample_id, proposal in proposals.items():
        try:
            repair.validate_seal(proposal, f"prior proposal[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalAdjudicationError(str(error)) from error
        bindings = proposal.get("bindings")
        if (
            proposal.get("schema_version") != v1.SCHEMA_VERSION
            or proposal.get("record_type") != "font_signal_recrop_repair_proposal"
            or proposal.get("status") != "pending_direct_visual_review"
            or proposal.get("training_eligible") is not False
            or proposal.get("promotion_allowed") is not False
            or not isinstance(bindings, Mapping)
            or bindings.get("builder_source_sha256")
            != inputs.get("builder_source_sha256")
        ):
            raise FontSignalAdjudicationError(
                f"prior proposal[{sample_id}]: unsafe proposal contract"
            )
        if proposal.get("action") not in {"recrop", "terminal_replacement"}:
            raise FontSignalAdjudicationError(
                f"prior proposal[{sample_id}]: invalid action"
            )
        _, _, decoded = _resolve_library_page(proposal, library_root, sample_id)
        try:
            _asset_matches_source(
                proposal_root=proposal_root,
                proposal=proposal,
                key="direct_preview",
                decoded=decoded,
                sample_id=sample_id,
            )
            _asset_matches_source(
                proposal_root=proposal_root,
                proposal=proposal,
                key="source_context",
                decoded=decoded,
                sample_id=sample_id,
            )
        finally:
            decoded.close()
    return {
        "proposals": proposals,
        "report": report,
        "marker": marker,
        "historical_ledger_sha256": historical_ledger_sha,
        "proposals_sha256": sha256_file(proposal_root / v1.PROPOSALS_FILE),
        "report_sha256": sha256_file(report_path),
        "marker_sha256": sha256_file(marker_path),
    }


def _load_primary_reviews(
    path: Path,
    proposals: Mapping[str, dict[str, Any]],
    *,
    expected_accepts: int,
    expected_terminal: int,
    expected_revisions: int,
) -> dict[str, dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != PRIMARY_HEADER:
                raise FontSignalAdjudicationError(
                    "primary ledger header differs from the v1 review contract"
                )
            raw_rows = [dict(row) for row in reader]
    except OSError as error:
        raise FontSignalAdjudicationError(
            f"primary ledger could not be read: {error}"
        ) from error
    rows = _unique(raw_rows, "sample_id", "primary ledger")
    if set(rows) != set(proposals):
        raise FontSignalAdjudicationError(
            "primary ledger does not cover the prior proposal set exactly"
        )
    counts: Counter[str] = Counter()
    output: dict[str, dict[str, Any]] = {}
    for sample_id in sorted(rows):
        row = rows[sample_id]
        proposal = proposals[sample_id]
        if set(row) != set(PRIMARY_HEADER) or any(
            value is None for value in row.values()
        ):
            raise FontSignalAdjudicationError(
                f"primary ledger[{sample_id}]: malformed CSV columns"
            )
        if (
            row.get("proposed_action") != proposal.get("action")
            or row.get("preview_path") != proposal["direct_preview"]["path"]
            or row.get("preview_sha256") != proposal["direct_preview"]["file_sha256"]
            or row.get("allowed_decisions") != PRIMARY_ALLOWED_DECISIONS
        ):
            raise FontSignalAdjudicationError(
                f"primary ledger[{sample_id}]: proposal/card binding drifted"
            )
        proposed_bbox = _bbox_cell(
            str(row.get("proposed_bbox_px")),
            f"primary ledger[{sample_id}].proposed_bbox_px",
            allow_null=True,
        )
        proposal_bbox = proposal.get("recrop_bbox_px")
        if (
            list(proposed_bbox) if proposed_bbox is not None else None
        ) != proposal_bbox:
            raise FontSignalAdjudicationError(
                f"primary ledger[{sample_id}]: proposed bbox drifted"
            )
        decision = repair.require_text(
            row.get("decision"), f"primary ledger[{sample_id}].decision"
        )
        reviewer = repair.require_text(
            row.get("reviewer"), f"primary ledger[{sample_id}].reviewer"
        )
        reviewed_at = repair._review_time(
            row.get("reviewed_at"), f"primary ledger[{sample_id}].reviewed_at"
        )
        notes = repair.require_text(
            row.get("notes"), f"primary ledger[{sample_id}].notes"
        )
        revision_text = str(row.get("revision_bbox_px") or "").strip()
        revision_bbox: tuple[int, int, int, int] | None = None
        if proposal.get("action") == "recrop":
            if decision not in {"accept_proposal", "revise_bbox"}:
                raise FontSignalAdjudicationError(
                    f"primary ledger[{sample_id}]: unsafe recrop decision {decision}"
                )
            if decision == "revise_bbox":
                if not revision_text:
                    raise FontSignalAdjudicationError(
                        f"primary ledger[{sample_id}]: revision bbox is missing"
                    )
                revision_bbox = _bbox_cell(
                    revision_text,
                    f"primary ledger[{sample_id}].revision_bbox_px",
                    allow_null=False,
                )
                if list(revision_bbox) == proposal_bbox:
                    raise FontSignalAdjudicationError(
                        f"primary ledger[{sample_id}]: revision bbox is a no-op"
                    )
            elif revision_text:
                raise FontSignalAdjudicationError(
                    f"primary ledger[{sample_id}]: accepted row has a revision bbox"
                )
        else:
            if decision != "confirm_terminal" or revision_text:
                raise FontSignalAdjudicationError(
                    f"primary ledger[{sample_id}]: terminal disposition drifted"
                )
        counts[decision] += 1
        output[sample_id] = {
            "decision": decision,
            "revision_bbox_px": list(revision_bbox) if revision_bbox else None,
            "reviewer": reviewer,
            "reviewed_at": reviewed_at,
            "notes": notes,
            "row_sha256": sha256_json(row),
        }
    expected_counts = {
        "accept_proposal": expected_accepts,
        "confirm_terminal": expected_terminal,
        "revise_bbox": expected_revisions,
    }
    actual_counts = {name: counts[name] for name in expected_counts}
    if actual_counts != expected_counts or set(counts) - set(expected_counts):
        raise FontSignalAdjudicationError(
            f"primary decision counts drifted: {dict(sorted(counts.items()))}"
        )
    return output


def _load_secondary_reviews(
    path: Path,
    proposals: Mapping[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    rows = _unique(
        _read_jsonl(path, "secondary review"), "sample_id", "secondary review"
    )
    if set(rows) != set(proposals):
        raise FontSignalAdjudicationError(
            "secondary review does not cover the prior proposal set exactly"
        )
    for sample_id, row in rows.items():
        proposal = proposals[sample_id]
        if set(row) != SECONDARY_KEYS:
            raise FontSignalAdjudicationError(
                f"secondary review[{sample_id}]: fields differ from review contract"
            )
        decision = row.get("decision")
        allowed = (
            {"approve_recrop", "revise"}
            if proposal.get("action") == "recrop"
            else {"approve_terminal"}
        )
        confidence = row.get("confidence")
        if (
            row.get("proposal_record_sha256") != proposal.get("record_sha256")
            or row.get("card_sha256") != proposal["direct_preview"]["file_sha256"]
            or decision not in allowed
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not 0 <= float(confidence) <= 1
            or row.get("viewed_direct_preview_original") is not True
            or row.get("viewed_source_context_original") is not True
            or row.get("viewed_source_page_original") is not True
        ):
            raise FontSignalAdjudicationError(
                f"secondary review[{sample_id}]: unsafe or stale review contract"
            )
        repair.require_text(
            row.get("rationale"), f"secondary review[{sample_id}].rationale"
        )
        repair.require_text(
            row.get("reviewer"), f"secondary review[{sample_id}].reviewer"
        )
    return rows


def _alignment(primary: Mapping[str, Any], secondary: Mapping[str, Any]) -> str:
    pair = (primary.get("decision"), secondary.get("decision"))
    mapping = {
        ("accept_proposal", "approve_recrop"): "consensus_keep_prior_recrop",
        ("confirm_terminal", "approve_terminal"): "consensus_terminal_exclusion",
        ("revise_bbox", "revise"): "consensus_revision_required",
        ("revise_bbox", "approve_recrop"): "primary_stricter_revision",
    }
    try:
        return mapping[pair]
    except KeyError as error:
        raise FontSignalAdjudicationError(
            f"unsupported primary/secondary decision pair: {pair}"
        ) from error


def _review_bindings(
    *,
    proposal: Mapping[str, Any],
    primary: Mapping[str, Any],
    secondary: Mapping[str, Any],
    builder_source_sha256: str,
    prior: Mapping[str, Any],
    primary_ledger: Path,
    secondary_review: Path,
) -> dict[str, Any]:
    return {
        "builder_source_sha256": builder_source_sha256,
        "prior_proposals_file_sha256": prior["proposals_sha256"],
        "prior_proposal_record_sha256": proposal["record_sha256"],
        "prior_report_file_sha256": prior["report_sha256"],
        "prior_report_record_sha256": prior["report"]["record_sha256"],
        "prior_ownership_marker_sha256": prior["marker_sha256"],
        "primary_review_file_sha256": sha256_file(primary_ledger),
        "primary_review_row_sha256": primary["row_sha256"],
        "secondary_review_file_sha256": sha256_file(secondary_review),
        "secondary_review_row_sha256": sha256_json(secondary),
    }


def _public_primary(primary: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "decision": primary["decision"],
        "revision_bbox_px": copy.deepcopy(primary["revision_bbox_px"]),
        "reviewer": primary["reviewer"],
        "reviewed_at": primary["reviewed_at"],
        "notes": primary["notes"],
    }


def _public_secondary(secondary: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "decision": secondary["decision"],
        "confidence": secondary["confidence"],
        "rationale": secondary["rationale"],
        "reviewer": secondary["reviewer"],
        "viewed_direct_preview_original": True,
        "viewed_source_context_original": True,
        "viewed_source_page_original": True,
    }


def _direct_asset(
    *, path: str, bbox: tuple[int, int, int, int], payload: bytes
) -> dict[str, Any]:
    return {
        "path": path,
        "bbox_px": list(bbox),
        "file_sha256": repair.sha256_bytes(payload),
        "decoded_mode": "RGB",
        "size_px": [bbox[2] - bbox[0], bbox[3] - bbox[1]],
        "pixel_source": "direct_hash_verified_library_page_crop",
        "qa_overlay": False,
        "synthetic": False,
        "generated": False,
    }


def _full_page_binding(
    proposal: Mapping[str, Any], page_payload: bytes, decoded: Image.Image
) -> dict[str, Any]:
    source = proposal["source_page"]
    return {
        "path": source["path"],
        "file_sha256": repair.sha256_bytes(page_payload),
        "size_bytes": len(page_payload),
        "size_px": [decoded.width, decoded.height],
        "decoded_mode": "RGB",
        "provenance": "real_preserved",
        "storage_root": "library_root",
    }


def _revision_ledger_bytes(revisions: Sequence[Mapping[str, Any]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(
        buffer, fieldnames=REVISION_LEDGER_HEADER, lineterminator="\n"
    )
    writer.writeheader()
    for row in revisions:
        preview = row["direct_preview"]
        context = row["revision_context"]
        writer.writerow(
            {
                "sample_id": row["sample_id"],
                "review_alignment": row["review_alignment"],
                "prior_bbox_px": canonical_json(row["prior_bbox_px"]),
                "revision_bbox_px": canonical_json(row["revision_bbox_px"]),
                "preview_path": preview["path"],
                "preview_sha256": preview["file_sha256"],
                "context_path": context["path"],
                "context_sha256": context["file_sha256"],
                "allowed_decisions": REVISION_ALLOWED_DECISIONS,
                "decision": "",
                "next_revision_bbox_px": "",
                "reviewer": "",
                "reviewed_at": "",
                "notes": "",
            }
        )
    return buffer.getvalue().encode("utf-8")


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    proposal_root: Path,
    primary_ledger: Path,
    secondary_review: Path,
    library_root: Path,
    expected_targets: int,
    expected_accepts: int,
    expected_terminal: int,
    expected_revisions: int,
    expected_disagreements: int,
) -> dict[str, Any]:
    _validate_root_separation(
        output_root=declared_root,
        proposal_root=proposal_root,
        library_root=library_root,
    )
    prior = _load_prior_contract(
        proposal_root=proposal_root,
        primary_ledger=primary_ledger,
        secondary_review=secondary_review,
        library_root=library_root,
        expected_targets=expected_targets,
    )
    proposals: dict[str, dict[str, Any]] = prior["proposals"]
    primary = _load_primary_reviews(
        primary_ledger,
        proposals,
        expected_accepts=expected_accepts,
        expected_terminal=expected_terminal,
        expected_revisions=expected_revisions,
    )
    secondary = _load_secondary_reviews(secondary_review, proposals)
    if any(
        primary[sample_id]["reviewer"] == secondary[sample_id]["reviewer"]
        for sample_id in proposals
    ):
        raise FontSignalAdjudicationError(
            "primary and secondary reviews must come from independent reviewers"
        )
    alignments = {
        sample_id: _alignment(primary[sample_id], secondary[sample_id])
        for sample_id in sorted(proposals)
    }
    disagreement_ids = {
        sample_id
        for sample_id, alignment in alignments.items()
        if alignment == "primary_stricter_revision"
    }
    revision_ids = {
        sample_id
        for sample_id, row in primary.items()
        if row["decision"] == "revise_bbox"
    }
    if (
        len(revision_ids) != expected_revisions
        or len(disagreement_ids) != expected_disagreements
        or sum(
            alignment == "consensus_revision_required"
            for alignment in alignments.values()
        )
        != expected_revisions - expected_disagreements
    ):
        raise FontSignalAdjudicationError(
            "revision agreement/disagreement counts drifted"
        )

    physical_root.mkdir(parents=True, exist_ok=False)
    (physical_root / EVIDENCE_DIR).mkdir()
    (physical_root / PREVIEW_DIR).mkdir()
    (physical_root / CONTEXT_DIR).mkdir()
    builder_source_sha256 = sha256_file(Path(__file__).resolve())

    revision_rows: list[dict[str, Any]] = []
    for sample_id in sorted(revision_ids):
        proposal = proposals[sample_id]
        primary_row = primary[sample_id]
        secondary_row = secondary[sample_id]
        revised_bbox = _require_bbox(
            primary_row["revision_bbox_px"],
            f"primary review[{sample_id}].revision_bbox_px",
        )
        prior_bbox = _require_bbox(
            proposal.get("recrop_bbox_px"),
            f"proposal[{sample_id}].recrop_bbox_px",
        )
        _, page_payload, decoded = _resolve_library_page(
            proposal, library_root, sample_id
        )
        try:
            _check_bbox(revised_bbox, decoded, f"revision[{sample_id}]")
            context_bbox = v1._context_bbox(
                prior_bbox, revised_bbox, (decoded.width, decoded.height)
            )
            preview_payload = v1._png_crop(decoded, revised_bbox)
            context_payload = v1._png_crop(decoded, context_bbox)
            preview_relative = f"{PREVIEW_DIR}/{sample_id}.png"
            context_relative = f"{CONTEXT_DIR}/{sample_id}.png"
            (physical_root / PREVIEW_DIR / f"{sample_id}.png").write_bytes(
                preview_payload
            )
            (physical_root / CONTEXT_DIR / f"{sample_id}.png").write_bytes(
                context_payload
            )
            alignment = alignments[sample_id]
            revision_rows.append(
                seal(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "record_type": "font_signal_recrop_bbox_revision",
                        "sample_id": sample_id,
                        "status": "pending_direct_visual_review",
                        "review_alignment": alignment,
                        "primary_secondary_disagreement": alignment
                        == "primary_stricter_revision",
                        "prior_bbox_px": list(prior_bbox),
                        "revision_bbox_px": list(revised_bbox),
                        "coordinate_space": "source_page_pixels_xyxy_half_open",
                        "revision_reason": primary_row["notes"],
                        "primary_review": _public_primary(primary_row),
                        "secondary_review": _public_secondary(secondary_row),
                        "prior_direct_preview": copy.deepcopy(
                            proposal["direct_preview"]
                        ),
                        "direct_preview": _direct_asset(
                            path=preview_relative,
                            bbox=revised_bbox,
                            payload=preview_payload,
                        ),
                        "revision_context": _direct_asset(
                            path=context_relative,
                            bbox=context_bbox,
                            payload=context_payload,
                        ),
                        "full_page_binding": _full_page_binding(
                            proposal, page_payload, decoded
                        ),
                        "bindings": _review_bindings(
                            proposal=proposal,
                            primary=primary_row,
                            secondary=secondary_row,
                            builder_source_sha256=builder_source_sha256,
                            prior=prior,
                            primary_ledger=primary_ledger,
                            secondary_review=secondary_review,
                        ),
                        "requires_exhaustive_direct_preview_review": True,
                        "training_eligible": False,
                        "promotion_allowed": False,
                        "promoted": False,
                    }
                )
            )
        finally:
            decoded.close()
    revision_by_id = {row["sample_id"]: row for row in revision_rows}

    adjudication_rows: list[dict[str, Any]] = []
    for sample_id in sorted(proposals):
        proposal = proposals[sample_id]
        primary_row = primary[sample_id]
        secondary_row = secondary[sample_id]
        alignment = alignments[sample_id]
        if sample_id in revision_by_id:
            status = "pending_direct_visual_review"
            disposition = "revision_preview_pending"
            revision_sha = revision_by_id[sample_id]["record_sha256"]
        elif alignment == "consensus_keep_prior_recrop":
            status = "review_complete_withheld_not_promoted"
            disposition = "accept_proposal_withheld"
            revision_sha = None
        elif alignment == "consensus_terminal_exclusion":
            status = "review_complete_withheld_not_promoted"
            disposition = "confirm_terminal_withheld"
            revision_sha = None
        else:
            raise FontSignalAdjudicationError(
                f"adjudication[{sample_id}]: unresolved review alignment"
            )
        adjudication_rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "font_signal_recrop_repair_adjudication",
                    "sample_id": sample_id,
                    "prior_action": proposal["action"],
                    "status": status,
                    "adjudicated_disposition": disposition,
                    "review_alignment": alignment,
                    "primary_secondary_disagreement": alignment
                    == "primary_stricter_revision",
                    "primary_review": _public_primary(primary_row),
                    "secondary_review": _public_secondary(secondary_row),
                    "revision_record_sha256": revision_sha,
                    "bindings": _review_bindings(
                        proposal=proposal,
                        primary=primary_row,
                        secondary=secondary_row,
                        builder_source_sha256=builder_source_sha256,
                        prior=prior,
                        primary_ledger=primary_ledger,
                        secondary_review=secondary_review,
                    ),
                    "training_eligible": False,
                    "promotion_allowed": False,
                    "promoted": False,
                }
            )
        )

    evidence_payloads = {
        PRIMARY_EVIDENCE_FILE: primary_ledger.read_bytes(),
        SECONDARY_EVIDENCE_FILE: secondary_review.read_bytes(),
        PRIOR_PROPOSALS_EVIDENCE_FILE: (proposal_root / v1.PROPOSALS_FILE).read_bytes(),
        PRIOR_REPORT_EVIDENCE_FILE: (proposal_root / v1.REPORT_FILE).read_bytes(),
        PRIOR_MARKER_EVIDENCE_FILE: (proposal_root / v1.MARKER_FILE).read_bytes(),
    }
    for relative, payload in evidence_payloads.items():
        physical_root.joinpath(*PurePosixPath(relative).parts).write_bytes(payload)
    (physical_root / ADJUDICATIONS_FILE).write_bytes(jsonl_bytes(adjudication_rows))
    (physical_root / REVISIONS_FILE).write_bytes(jsonl_bytes(revision_rows))
    (physical_root / REVISION_LEDGER_FILE).write_bytes(
        _revision_ledger_bytes(revision_rows)
    )

    primary_counts = Counter(row["decision"] for row in primary.values())
    secondary_counts = Counter(str(row["decision"]) for row in secondary.values())
    alignment_counts = Counter(alignments.values())
    status_counts = Counter(row["status"] for row in adjudication_rows)
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_signal_recrop_repair_adjudication_report",
            "inputs": {
                "builder_source_sha256": builder_source_sha256,
                "proposal_root": str(proposal_root),
                "prior_proposals": {
                    "path": str(proposal_root / v1.PROPOSALS_FILE),
                    "sha256": prior["proposals_sha256"],
                },
                "prior_report": {
                    "path": str(proposal_root / v1.REPORT_FILE),
                    "sha256": prior["report_sha256"],
                    "record_sha256": prior["report"]["record_sha256"],
                },
                "prior_ownership_marker": {
                    "path": str(proposal_root / v1.MARKER_FILE),
                    "sha256": prior["marker_sha256"],
                },
                "primary_review_ledger": {
                    "path": str(primary_ledger),
                    "sha256": sha256_file(primary_ledger),
                    "historical_blank_template_sha256": prior[
                        "historical_ledger_sha256"
                    ],
                },
                "secondary_review": {
                    "path": str(secondary_review),
                    "sha256": sha256_file(secondary_review),
                },
                "library_root": str(library_root),
            },
            "counts": {
                "targets": len(adjudication_rows),
                "primary_decisions": dict(sorted(primary_counts.items())),
                "secondary_decisions": dict(sorted(secondary_counts.items())),
                "review_alignments": dict(sorted(alignment_counts.items())),
                "adjudication_statuses": dict(sorted(status_counts.items())),
                "revision_previews_pending": len(revision_rows),
                "revision_contexts": len(revision_rows),
                "full_page_bindings": len(revision_rows),
                "primary_secondary_disagreements": len(disagreement_ids),
                "consensus_revision_required": sum(
                    value == "consensus_revision_required"
                    for value in alignments.values()
                ),
                "accepted_but_withheld": expected_accepts,
                "terminal_but_withheld": expected_terminal,
                "promoted": 0,
            },
            "outputs": {
                "adjudications": ADJUDICATIONS_FILE,
                "adjudications_sha256": sha256_file(physical_root / ADJUDICATIONS_FILE),
                "revisions": REVISIONS_FILE,
                "revisions_sha256": sha256_file(physical_root / REVISIONS_FILE),
                "revision_review_ledger": REVISION_LEDGER_FILE,
                "revision_review_ledger_sha256": sha256_file(
                    physical_root / REVISION_LEDGER_FILE
                ),
                "evidence": {
                    relative: repair.sha256_bytes(payload)
                    for relative, payload in sorted(evidence_payloads.items())
                },
            },
            "review_policy": {
                "primary_bbox_authority": True,
                "secondary_review_independent": True,
                "stricter_primary_revision_preserved": True,
                "all_revisions_require_fresh_direct_visual_review": True,
                "consensus_accepts_auto_promoted": False,
                "consensus_terminal_auto_promoted": False,
            },
            "next_step": {
                "review_revision_previews": True,
                "complete_revision_review_ledger": True,
                "promotion_permitted_after_this_artifact": False,
                "training_eligible": False,
                "promoted": False,
            },
            "safety": {
                "prior_artifacts_modified": False,
                "source_pages_modified": False,
                "source_pixels": "hash_verified_library_pages_only",
                "direct_revision_previews": len(revision_rows),
                "direct_revision_contexts": len(revision_rows),
                "qa_overlays_written": 0,
                "qa_overlays_used_as_pixels": 0,
                "synthetic_assets_written": 0,
                "generated_assets_written": 0,
                "repair_queue_records_written": 0,
                "training_records_written": 0,
            },
            "declared_root": str(declared_root),
        }
    )
    (physical_root / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
    marker = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "safe_replace": True,
        "declared_root": str(declared_root),
        "managed_files": _managed_files(physical_root),
    }
    (physical_root / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
    return report


def _validate_output_marker(
    root: Path, *, expected_declared_root: Path | None = None
) -> dict[str, Any]:
    if _is_link_or_junction(root) or not root.is_dir():
        raise FontSignalAdjudicationError("output root is missing or unsafe")
    marker = repair.read_json(root / MARKER_FILE, "adjudication ownership marker")
    if (
        marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or (
            expected_declared_root is not None
            and Path(str(marker.get("declared_root"))).resolve()
            != expected_declared_root.resolve()
        )
    ):
        raise FontSignalAdjudicationError("adjudication ownership marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise FontSignalAdjudicationError(
            "adjudication ownership marker lacks managed files"
        )
    expected = {MARKER_FILE}
    for relative, expected_sha in managed.items():
        safe = _safe_relative_path(relative, f"output marker[{relative}]")
        expected.add(safe.as_posix())
        repair.require_sha(expected_sha, f"output marker[{relative}].sha256")
        physical = root.joinpath(*safe.parts)
        if not physical.is_file() or sha256_file(physical) != expected_sha:
            raise FontSignalAdjudicationError(
                f"managed adjudication artifact is stale/tampered: {relative}"
            )
    actual = _regular_file_inventory(root)
    if actual != expected:
        raise FontSignalAdjudicationError(
            "adjudication managed inventory differs; "
            f"missing={sorted(expected-actual)[:8]} unexpected={sorted(actual-expected)[:8]}"
        )
    return marker


def _validate_blank_revision_ledger(
    path: Path, revisions: Mapping[str, dict[str, Any]]
) -> None:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != REVISION_LEDGER_HEADER:
                raise FontSignalAdjudicationError(
                    "revision ledger header differs from its contract"
                )
            rows = _unique(
                [dict(row) for row in reader], "sample_id", "revision review ledger"
            )
    except OSError as error:
        raise FontSignalAdjudicationError(
            f"revision review ledger could not be read: {error}"
        ) from error
    if set(rows) != set(revisions):
        raise FontSignalAdjudicationError(
            "revision review ledger does not cover revisions exactly"
        )
    for sample_id, row in rows.items():
        revision = revisions[sample_id]
        preview = revision["direct_preview"]
        context = revision["revision_context"]
        if (
            row.get("review_alignment") != revision["review_alignment"]
            or row.get("prior_bbox_px") != canonical_json(revision["prior_bbox_px"])
            or row.get("revision_bbox_px")
            != canonical_json(revision["revision_bbox_px"])
            or row.get("preview_path") != preview["path"]
            or row.get("preview_sha256") != preview["file_sha256"]
            or row.get("context_path") != context["path"]
            or row.get("context_sha256") != context["file_sha256"]
            or row.get("allowed_decisions") != REVISION_ALLOWED_DECISIONS
            or any(
                row.get(field)
                for field in (
                    "decision",
                    "next_revision_bbox_px",
                    "reviewer",
                    "reviewed_at",
                    "notes",
                )
            )
        ):
            raise FontSignalAdjudicationError(
                f"revision review ledger[{sample_id}]: stale or preapproved row"
            )


def validate_tree(
    *,
    root: Path,
    proposal_root: Path,
    primary_ledger: Path,
    secondary_review: Path,
    library_root: Path,
    expected_targets: int,
    expected_accepts: int,
    expected_terminal: int,
    expected_revisions: int,
    expected_disagreements: int,
    declared_root: Path,
) -> dict[str, Any]:
    _validate_root_separation(
        output_root=declared_root,
        proposal_root=proposal_root,
        library_root=library_root,
    )
    _validate_output_marker(root, expected_declared_root=declared_root)
    prior = _load_prior_contract(
        proposal_root=proposal_root,
        primary_ledger=primary_ledger,
        secondary_review=secondary_review,
        library_root=library_root,
        expected_targets=expected_targets,
    )
    proposals: dict[str, dict[str, Any]] = prior["proposals"]
    primary = _load_primary_reviews(
        primary_ledger,
        proposals,
        expected_accepts=expected_accepts,
        expected_terminal=expected_terminal,
        expected_revisions=expected_revisions,
    )
    secondary = _load_secondary_reviews(secondary_review, proposals)
    if any(
        primary[sample_id]["reviewer"] == secondary[sample_id]["reviewer"]
        for sample_id in proposals
    ):
        raise FontSignalAdjudicationError(
            "primary and secondary reviews must come from independent reviewers"
        )
    builder_source_sha256 = sha256_file(Path(__file__).resolve())
    evidence_expected = {
        PRIMARY_EVIDENCE_FILE: primary_ledger.read_bytes(),
        SECONDARY_EVIDENCE_FILE: secondary_review.read_bytes(),
        PRIOR_PROPOSALS_EVIDENCE_FILE: (proposal_root / v1.PROPOSALS_FILE).read_bytes(),
        PRIOR_REPORT_EVIDENCE_FILE: (proposal_root / v1.REPORT_FILE).read_bytes(),
        PRIOR_MARKER_EVIDENCE_FILE: (proposal_root / v1.MARKER_FILE).read_bytes(),
    }
    for relative, expected in evidence_expected.items():
        path = root.joinpath(*PurePosixPath(relative).parts)
        if path.read_bytes() != expected:
            raise FontSignalAdjudicationError(
                f"evidence snapshot differs from its input: {relative}"
            )

    revisions = _unique(
        _read_jsonl(root / REVISIONS_FILE, "sealed revisions"),
        "sample_id",
        "sealed revisions",
    )
    adjudications = _unique(
        _read_jsonl(root / ADJUDICATIONS_FILE, "sealed adjudications"),
        "sample_id",
        "sealed adjudications",
    )
    revision_ids = {
        sample_id
        for sample_id, row in primary.items()
        if row["decision"] == "revise_bbox"
    }
    if (
        set(adjudications) != set(proposals)
        or set(revisions) != revision_ids
        or len(revisions) != expected_revisions
    ):
        raise FontSignalAdjudicationError(
            "adjudication/revision target projections drifted"
        )
    disagreement_count = 0
    for sample_id, adjudication in adjudications.items():
        try:
            repair.validate_seal(adjudication, f"adjudication[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalAdjudicationError(str(error)) from error
        alignment = _alignment(primary[sample_id], secondary[sample_id])
        revision = revisions.get(sample_id)
        expected_status = (
            "pending_direct_visual_review"
            if revision is not None
            else "review_complete_withheld_not_promoted"
        )
        expected_disposition = (
            "revision_preview_pending"
            if revision is not None
            else (
                "accept_proposal_withheld"
                if alignment == "consensus_keep_prior_recrop"
                else "confirm_terminal_withheld"
            )
        )
        expected_bindings = _review_bindings(
            proposal=proposals[sample_id],
            primary=primary[sample_id],
            secondary=secondary[sample_id],
            builder_source_sha256=builder_source_sha256,
            prior=prior,
            primary_ledger=primary_ledger,
            secondary_review=secondary_review,
        )
        if alignment == "primary_stricter_revision":
            disagreement_count += 1
        if (
            adjudication.get("schema_version") != SCHEMA_VERSION
            or adjudication.get("record_type")
            != "font_signal_recrop_repair_adjudication"
            or adjudication.get("prior_action") != proposals[sample_id].get("action")
            or adjudication.get("review_alignment") != alignment
            or adjudication.get("status") != expected_status
            or adjudication.get("adjudicated_disposition") != expected_disposition
            or adjudication.get("primary_secondary_disagreement")
            is not (alignment == "primary_stricter_revision")
            or adjudication.get("primary_review") != _public_primary(primary[sample_id])
            or adjudication.get("secondary_review")
            != _public_secondary(secondary[sample_id])
            or adjudication.get("bindings") != expected_bindings
            or adjudication.get("training_eligible") is not False
            or adjudication.get("promotion_allowed") is not False
            or adjudication.get("promoted") is not False
            or adjudication.get("revision_record_sha256")
            != (revision.get("record_sha256") if revision else None)
        ):
            raise FontSignalAdjudicationError(
                f"adjudication[{sample_id}]: sealed disposition drifted"
            )
    if disagreement_count != expected_disagreements:
        raise FontSignalAdjudicationError("adjudication disagreement count drifted")

    for sample_id, revision in revisions.items():
        try:
            repair.validate_seal(revision, f"revision[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalAdjudicationError(str(error)) from error
        proposal = proposals[sample_id]
        prior_bbox = _require_bbox(
            proposal.get("recrop_bbox_px"),
            f"proposal[{sample_id}].recrop_bbox_px",
        )
        revised_bbox = _require_bbox(
            revision.get("revision_bbox_px"), f"revision[{sample_id}].revision_bbox"
        )
        alignment = _alignment(primary[sample_id], secondary[sample_id])
        expected_bindings = _review_bindings(
            proposal=proposal,
            primary=primary[sample_id],
            secondary=secondary[sample_id],
            builder_source_sha256=builder_source_sha256,
            prior=prior,
            primary_ledger=primary_ledger,
            secondary_review=secondary_review,
        )
        if (
            revision.get("schema_version") != SCHEMA_VERSION
            or revision.get("record_type") != "font_signal_recrop_bbox_revision"
            or revision.get("status") != "pending_direct_visual_review"
            or revision.get("review_alignment") != alignment
            or revision.get("primary_secondary_disagreement")
            is not (alignment == "primary_stricter_revision")
            or revision.get("prior_bbox_px") != list(prior_bbox)
            or list(revised_bbox) != primary[sample_id]["revision_bbox_px"]
            or revision.get("coordinate_space") != "source_page_pixels_xyxy_half_open"
            or revision.get("revision_reason") != primary[sample_id]["notes"]
            or revision.get("primary_review") != _public_primary(primary[sample_id])
            or revision.get("secondary_review")
            != _public_secondary(secondary[sample_id])
            or revision.get("prior_direct_preview") != proposal["direct_preview"]
            or revision.get("bindings") != expected_bindings
            or revision.get("requires_exhaustive_direct_preview_review") is not True
            or revision.get("training_eligible") is not False
            or revision.get("promotion_allowed") is not False
            or revision.get("promoted") is not False
        ):
            raise FontSignalAdjudicationError(
                f"revision[{sample_id}]: unsafe revision contract"
            )
        _, page_payload, decoded = _resolve_library_page(
            proposal, library_root, sample_id
        )
        try:
            expected_context_bbox = v1._context_bbox(
                prior_bbox, revised_bbox, (decoded.width, decoded.height)
            )
            page = revision.get("full_page_binding")
            if (
                not isinstance(page, Mapping)
                or page.get("path") != proposal["source_page"]["path"]
                or page.get("file_sha256") != repair.sha256_bytes(page_payload)
                or page.get("size_bytes") != len(page_payload)
                or page.get("size_px") != [decoded.width, decoded.height]
                or page.get("decoded_mode") != "RGB"
                or page.get("provenance") != "real_preserved"
                or page.get("storage_root") != "library_root"
            ):
                raise FontSignalAdjudicationError(
                    f"revision[{sample_id}]: full-page binding drifted"
                )
            for key in ("direct_preview", "revision_context"):
                asset = revision.get(key)
                if not isinstance(asset, Mapping):
                    raise FontSignalAdjudicationError(
                        f"revision[{sample_id}].{key}: asset missing"
                    )
                bbox = _require_bbox(
                    asset.get("bbox_px"), f"revision[{sample_id}].{key}.bbox"
                )
                expected_bbox = (
                    revised_bbox if key == "direct_preview" else expected_context_bbox
                )
                expected_path = (
                    f"{PREVIEW_DIR}/{sample_id}.png"
                    if key == "direct_preview"
                    else f"{CONTEXT_DIR}/{sample_id}.png"
                )
                _check_bbox(bbox, decoded, f"revision[{sample_id}].{key}")
                expected_png = v1._png_crop(decoded, bbox)
                asset_path = _safe_managed_path(
                    root,
                    asset.get("path"),
                    f"revision[{sample_id}].{key}.path",
                )
                if (
                    asset.get("qa_overlay") is not False
                    or bbox != expected_bbox
                    or asset.get("path") != expected_path
                    or asset.get("synthetic") is not False
                    or asset.get("generated") is not False
                    or asset.get("decoded_mode") != "RGB"
                    or asset.get("size_px") != [bbox[2] - bbox[0], bbox[3] - bbox[1]]
                    or asset.get("pixel_source")
                    != "direct_hash_verified_library_page_crop"
                    or asset_path.read_bytes() != expected_png
                    or asset.get("file_sha256") != repair.sha256_bytes(expected_png)
                ):
                    raise FontSignalAdjudicationError(
                        f"revision[{sample_id}].{key}: not an exact page crop"
                    )
        finally:
            decoded.close()
    _validate_blank_revision_ledger(root / REVISION_LEDGER_FILE, revisions)

    report = repair.read_json(root / REPORT_FILE, "adjudication report")
    try:
        repair.validate_seal(report, "adjudication report")
    except repair.RecropRepairError as error:
        raise FontSignalAdjudicationError(str(error)) from error
    inputs = report.get("inputs")
    counts = report.get("counts")
    outputs = report.get("outputs")
    if (
        not isinstance(inputs, Mapping)
        or inputs.get("builder_source_sha256") != sha256_file(Path(__file__).resolve())
        or inputs.get("primary_review_ledger", {}).get("sha256")
        != sha256_file(primary_ledger)
        or inputs.get("secondary_review", {}).get("sha256")
        != sha256_file(secondary_review)
        or inputs.get("prior_proposals", {}).get("sha256") != prior["proposals_sha256"]
        or not isinstance(counts, Mapping)
        or counts.get("targets") != expected_targets
        or counts.get("revision_previews_pending") != expected_revisions
        or counts.get("primary_secondary_disagreements") != expected_disagreements
        or counts.get("accepted_but_withheld") != expected_accepts
        or counts.get("terminal_but_withheld") != expected_terminal
        or counts.get("promoted") != 0
        or not isinstance(outputs, Mapping)
        or outputs.get("adjudications_sha256") != sha256_file(root / ADJUDICATIONS_FILE)
        or outputs.get("revisions_sha256") != sha256_file(root / REVISIONS_FILE)
        or outputs.get("revision_review_ledger_sha256")
        != sha256_file(root / REVISION_LEDGER_FILE)
    ):
        raise FontSignalAdjudicationError("adjudication report bindings drifted")
    return report


def _assert_replaceable(output_root: Path) -> None:
    if not output_root.exists():
        return
    if _is_link_or_junction(output_root) or not output_root.is_dir():
        raise FontSignalAdjudicationError(
            "refusing to replace a non-directory or linked output"
        )
    if not any(output_root.iterdir()):
        return
    _validate_output_marker(output_root, expected_declared_root=output_root)


def _install_owned_tree(staging: Path, output_root: Path) -> None:
    _assert_replaceable(output_root)
    if not output_root.exists():
        staging.replace(output_root)
        return
    if not any(output_root.iterdir()):
        output_root.rmdir()
        staging.replace(output_root)
        return
    backup = output_root.parent / f".{output_root.name}.backup-{uuid.uuid4().hex}"
    output_root.replace(backup)
    try:
        staging.replace(output_root)
    except BaseException:
        if output_root.exists():
            shutil.rmtree(output_root)
        backup.replace(output_root)
        raise
    shutil.rmtree(backup)


def _compare_trees(expected_root: Path, actual_root: Path) -> None:
    expected = {
        relative: expected_root.joinpath(*PurePosixPath(relative).parts).read_bytes()
        for relative in _regular_file_inventory(expected_root)
    }
    actual = {
        relative: actual_root.joinpath(*PurePosixPath(relative).parts).read_bytes()
        for relative in _regular_file_inventory(actual_root)
    }
    if expected.keys() != actual.keys():
        raise FontSignalAdjudicationError(
            "deterministic rebuild file inventory differs"
        )
    stale = [name for name in expected if expected[name] != actual[name]]
    if stale:
        raise FontSignalAdjudicationError(f"deterministic rebuild differs: {stale[:8]}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--proposal-root", type=Path, required=True)
    parser.add_argument("--primary-ledger", type=Path, required=True)
    parser.add_argument("--secondary-review", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--expected-targets", type=int, default=27)
    parser.add_argument("--expected-accepts", type=int, default=16)
    parser.add_argument("--expected-terminal", type=int, default=7)
    parser.add_argument("--expected-revisions", type=int, default=4)
    parser.add_argument("--expected-disagreements", type=int, default=3)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        inputs = {
            "proposal_root": args.proposal_root.expanduser().resolve(),
            "primary_ledger": args.primary_ledger.expanduser().resolve(),
            "secondary_review": args.secondary_review.expanduser().resolve(),
            "library_root": args.library_root.expanduser().resolve(),
            "declared_root": args.output_root.expanduser().resolve(),
            "expected_targets": args.expected_targets,
            "expected_accepts": args.expected_accepts,
            "expected_terminal": args.expected_terminal,
            "expected_revisions": args.expected_revisions,
            "expected_disagreements": args.expected_disagreements,
        }
        output_root = inputs["declared_root"]
        if args.command == "build":
            _assert_replaceable(output_root)
            output_root.parent.mkdir(parents=True, exist_ok=True)
            staging = Path(
                tempfile.mkdtemp(
                    prefix=f".{output_root.name}.staging-", dir=output_root.parent
                )
            )
            shutil.rmtree(staging)
            try:
                report = _write_tree(physical_root=staging, **inputs)
                validate_tree(root=staging, **inputs)
                _install_owned_tree(staging, output_root)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        else:
            report = validate_tree(root=output_root, **inputs)
            staging = Path(
                tempfile.mkdtemp(prefix="font-signal-adjudication-validate-")
            )
            shutil.rmtree(staging)
            try:
                _write_tree(physical_root=staging, **inputs)
                _compare_trees(output_root, staging)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (
        FontSignalAdjudicationError,
        v1.FontSignalRepairError,
        repair.RecropRepairError,
        OSError,
        ValueError,
    ) as error:
        print(f"font-signal recrop adjudication error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
