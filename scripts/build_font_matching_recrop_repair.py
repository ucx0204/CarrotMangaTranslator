#!/usr/bin/env python3
"""Build a sealed real-page recrop queue for font-matching defects.

This is the narrow bridge between the font-review orientation audit and the
existing hard-crop postprocessor.  It never mutates a parent catalog.  Every
recrop receives a new deterministic candidate ID; every parent is recorded in
an explicit supersession ledger; and every replacement-only decision remains
excluded until a fresh sample is selected.

The queue contains only pixels cropped from hash-verified library pages.  QA
overlays and synthetic assets are forbidden.  Human proposals bind the parent
master row, page, half-open source-page bbox, direct-preview PNG, reviewer, and
UTC review time before any image is written.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

import adjudicate_fontclip_hard_audit as hard_audit
import font_matching_labels as labels


SCHEMA_VERSION = "font-matching-recrop-repair-v1"
ORIENTATION_PROPOSAL_CONTRACT = (
    "font-matching-orientation-recrop-proposal-v1",
    "font_matching_orientation_recrop_proposal",
)
RESCUE_PROPOSAL_CONTRACT = (
    "font-matching-rescue-recrop-proposal-v1",
    "font_matching_rescue_recrop_proposal",
)
PROPOSAL_CONTRACTS = frozenset(
    {ORIENTATION_PROPOSAL_CONTRACT, RESCUE_PROPOSAL_CONTRACT}
)
ORIENTATION_SCHEMA_VERSION = "font-matching-orientation-audit-v1"
OWNER = "carrot-manga-translator/font-matching-recrop-repair"
MARKER_FILE = ".font-matching-recrop-repair-owned.json"
INTAKE_FILE = "intake.jsonl"
SUPERSESSION_FILE = "supersession.jsonl"
REPLACEMENTS_FILE = "replacement-required.jsonl"
DEFECT_EVIDENCE_FILE = "defect-evidence.jsonl"
PROPOSAL_RECORDS_FILE = "proposal-records.jsonl"
PARENT_RECORDS_FILE = "parent-records.jsonl"
REPORT_FILE = "report.json"
QUEUE_DIR = "repair-queue"
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SINGLE_ORIENTATIONS = frozenset({"horizontal", "vertical"})
DEFECT_ORIENTATIONS = frozenset({"mixed", "unknown"})


class RecropRepairError(ValueError):
    """Raised when a repair proposal or artifact violates the sealed contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(json_bytes(dict(row)) for row in rows)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    return sha256_bytes("\0".join(parts).encode("utf-8"))


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def validate_seal(record: Mapping[str, Any], location: str) -> None:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or not SHA_RE.fullmatch(expected):
        raise RecropRepairError(f"{location}: missing record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise RecropRepairError(f"{location}: record seal mismatch")


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RecropRepairError(f"{location}: expected an object")
    return value


def require_text(value: Any, location: str) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text:
        raise RecropRepairError(f"{location}: expected non-empty text")
    return text


def require_sha(value: Any, location: str) -> str:
    text = require_text(value, location)
    if not SHA_RE.fullmatch(text):
        raise RecropRepairError(f"{location}: expected lowercase SHA-256")
    return text


def require_bbox(value: Any, location: str) -> tuple[int, int, int, int]:
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(isinstance(component, bool) or not isinstance(component, int) for component in value)
    ):
        raise RecropRepairError(f"{location}: expected four integer XYXY values")
    bbox = tuple(value)
    if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        raise RecropRepairError(f"{location}: invalid half-open bbox {list(bbox)}")
    return bbox  # type: ignore[return-value]


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RecropRepairError(f"{location}: could not read JSON: {error}") from error
    return dict(require_mapping(value, location))


def read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RecropRepairError(
                        f"{location}:{line_number}: invalid JSON: {error}"
                    ) from error
                rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    except OSError as error:
        raise RecropRepairError(f"{location}: could not read JSONL: {error}") from error
    if not rows:
        raise RecropRepairError(f"{location}: JSONL is empty")
    return rows


def _orientation_targets(path: Path, expected: int) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(read_jsonl(path, "orientation rejected"), 1):
        location = f"orientation rejected:{index}"
        validate_seal(row, location)
        sample_id = require_text(row.get("sample_id"), f"{location}.sample_id")
        audit = require_mapping(row.get("audit"), f"{location}.audit")
        if (
            row.get("schema_version") != ORIENTATION_SCHEMA_VERSION
            or row.get("record_type") != "font_matching_orientation_applied_decision"
            or row.get("accepted") is not False
            or audit.get("viewed_original") is not True
            or audit.get("crop_status") not in {
                "needs_recrop",
                "mixed_hierarchy",
                "unusable",
            }
        ):
            raise RecropRepairError(f"{location}: not a sealed visual-audit rejection")
        if sample_id in output:
            raise RecropRepairError(f"{location}: duplicate sample {sample_id}")
        output[sample_id] = {
            "defect_source": "orientation_visual_audit",
            "defect_record_sha256": require_sha(
                row.get("record_sha256"), f"{location}.record_sha256"
            ),
            "crop_status": audit.get("crop_status"),
            "audited_orientation": row.get("orientation"),
            "orientation_task_record_sha256": audit.get("task_record_sha256"),
            "orientation_card_sha256": audit.get("card_sha256"),
            "_evidence_record": copy.deepcopy(row),
        }
    if len(output) != expected:
        raise RecropRepairError(
            f"expected {expected} orientation rejects, got {len(output)}"
        )
    return output


def _rescue_targets(path: Path, expected: int) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    seen_sample_ids: set[str] = set()
    seen_final_ids: set[str] = set()
    for index, row in enumerate(read_jsonl(path, "final labels"), 1):
        try:
            labels.validate_final_record(row)
        except labels.LabelValidationError as error:
            raise RecropRepairError(f"final labels:{index}: {error}") from error
        sample_id = require_text(row.get("sample_id"), f"final labels:{index}.sample_id")
        final_id = require_text(row.get("final_id"), f"final labels:{index}.final_id")
        if sample_id in seen_sample_ids:
            raise RecropRepairError(f"final labels:{index}: duplicate sample {sample_id}")
        if final_id in seen_final_ids:
            raise RecropRepairError(f"final labels:{index}: duplicate final {final_id}")
        seen_sample_ids.add(sample_id)
        seen_final_ids.add(final_id)
        judgment = require_mapping(
            row.get("font_judgment"), f"final labels:{index}.font_judgment"
        )
        treatment = require_mapping(
            row.get("treatment"), f"final labels:{index}.treatment"
        )
        orientation = treatment.get("orientation")
        if judgment.get("none_acceptable") is not True or orientation not in DEFECT_ORIENTATIONS:
            continue
        output[sample_id] = {
            "defect_source": "none_acceptable_non_single_orientation",
            "defect_record_sha256": require_sha(
                row.get("record_sha256"), f"final labels:{index}.record_sha256"
            ),
            "prior_final_id": final_id,
            "prior_final_record_sha256": row["record_sha256"],
            "prior_work_id": require_text(
                row.get("work_id"), f"final labels:{index}.work_id"
            ),
            "prior_source_page_sha256": require_sha(
                row.get("source_page_sha256"),
                f"final labels:{index}.source_page_sha256",
            ),
            "prior_final_orientation": orientation,
            "prior_final_must_be_invalidated": True,
            "_evidence_record": copy.deepcopy(row),
        }
    if len(output) != expected:
        raise RecropRepairError(
            f"expected {expected} non-single rescue finals, got {len(output)}"
        )
    return output


def _review_time(value: Any, location: str) -> str:
    text = require_text(value, location)
    if not text.endswith("Z"):
        raise RecropRepairError(f"{location}: expected a UTC timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(text.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise RecropRepairError(f"{location}: invalid UTC timestamp") from error
    if parsed.utcoffset() != UTC.utcoffset(parsed):
        raise RecropRepairError(f"{location}: timestamp is not UTC")
    return text


def _load_proposals(
    paths: Sequence[Path], target_ids: set[str]
) -> tuple[dict[str, dict[str, Any]], list[dict[str, str]]]:
    output: dict[str, dict[str, Any]] = {}
    signatures: list[dict[str, str]] = []
    for path in sorted({value.resolve() for value in paths}, key=str):
        if not path.is_file():
            raise RecropRepairError(f"missing proposal file: {path}")
        proposal_file_sha256 = sha256_file(path)
        signatures.append({"path": str(path), "sha256": proposal_file_sha256})
        for index, row in enumerate(read_jsonl(path, f"proposal {path.name}"), 1):
            location = f"proposal {path.name}:{index}"
            validate_seal(row, location)
            proposal_contract = (row.get("schema_version"), row.get("record_type"))
            if proposal_contract not in PROPOSAL_CONTRACTS:
                raise RecropRepairError(f"{location}: unsupported proposal contract")
            sample_id = require_text(row.get("sample_id"), f"{location}.sample_id")
            if sample_id in output:
                raise RecropRepairError(f"{location}: duplicate sample {sample_id}")
            action = row.get("action")
            if action not in {"recrop", "replace"}:
                raise RecropRepairError(f"{location}.action: expected recrop or replace")
            current_bbox = require_bbox(
                row.get("current_bbox_px"), f"{location}.current_bbox_px"
            )
            preview_bbox = require_bbox(
                row.get("preview_bbox_px"), f"{location}.preview_bbox_px"
            )
            recrop_value = row.get("recrop_bbox_px")
            actual_orientation = row.get("actual_orientation")
            if action == "recrop":
                recrop_bbox = require_bbox(
                    recrop_value, f"{location}.recrop_bbox_px"
                )
                if preview_bbox != recrop_bbox:
                    raise RecropRepairError(
                        f"{location}: recrop preview must bind the proposed bbox"
                    )
                if actual_orientation not in SINGLE_ORIENTATIONS:
                    raise RecropRepairError(
                        f"{location}: recrop needs horizontal/vertical orientation"
                    )
            else:
                recrop_bbox = None
                if recrop_value is not None or actual_orientation is not None:
                    raise RecropRepairError(
                        f"{location}: replacement cannot claim a recrop/orientation"
                    )
                if preview_bbox != current_bbox:
                    raise RecropRepairError(
                        f"{location}: replacement preview must bind the current bbox"
                    )
            _review_time(row.get("reviewed_at"), f"{location}.reviewed_at")
            require_text(row.get("reviewer"), f"{location}.reviewer")
            require_text(row.get("note"), f"{location}.note")
            require_text(row.get("source_page_path"), f"{location}.source_page_path")
            require_sha(
                row.get("source_page_sha256"), f"{location}.source_page_sha256"
            )
            require_sha(
                row.get("preview_crop_sha256"), f"{location}.preview_crop_sha256"
            )
            output[sample_id] = {
                **copy.deepcopy(row),
                "current_bbox_px": list(current_bbox),
                "preview_bbox_px": list(preview_bbox),
                "recrop_bbox_px": list(recrop_bbox) if recrop_bbox else None,
                "_proposal_file_path": str(path),
                "_proposal_file_sha256": proposal_file_sha256,
            }
    missing = sorted(target_ids - set(output))
    extra = sorted(set(output) - target_ids)
    if missing or extra:
        raise RecropRepairError(
            f"proposal set differs from targets; missing={missing[:8]} extra={extra[:8]}"
        )
    return output, signatures


def _load_master(path: Path, target_ids: set[str]) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    try:
        handle = path.open("r", encoding="utf-8")
    except OSError as error:
        raise RecropRepairError(f"master manifest could not be opened: {error}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RecropRepairError(
                    f"master:{line_number}: invalid JSON: {error}"
                ) from error
            row = dict(require_mapping(value, f"master:{line_number}"))
            sample_id = require_text(row.get("id"), f"master:{line_number}.id")
            if sample_id not in target_ids:
                continue
            if sample_id in output:
                raise RecropRepairError(f"master:{line_number}: duplicate {sample_id}")
            provenance = require_mapping(
                row.get("provenance"), f"master:{line_number}.provenance"
            )
            if (
                row.get("schema_version") != 1
                or row.get("catalog_version") != 1
                or provenance.get("approval") != "exhaustive_manual_visual_review"
                or provenance.get("qa_overlay") is not False
                or provenance.get("synthetic") is not False
            ):
                raise RecropRepairError(f"master:{line_number}: unsafe parent provenance")
            require_text(
                provenance.get("source_catalog_id"),
                f"master:{line_number}.provenance.source_catalog_id",
            )
            require_text(
                provenance.get("source_id"),
                f"master:{line_number}.provenance.source_id",
            )
            require_sha(
                row.get("sample_crop_sha256"),
                f"master:{line_number}.sample_crop_sha256",
            )
            if row.get("split") not in {"train", "val", "test"}:
                raise RecropRepairError(f"master:{line_number}: invalid split")
            require_text(
                require_mapping(row.get("work"), f"master:{line_number}.work").get("id"),
                f"master:{line_number}.work.id",
            )
            require_text(
                require_mapping(row.get("chapter"), f"master:{line_number}.chapter").get("id"),
                f"master:{line_number}.chapter.id",
            )
            require_text(
                require_mapping(row.get("page"), f"master:{line_number}.page").get("id"),
                f"master:{line_number}.page.id",
            )
            output[sample_id] = row
    missing = sorted(target_ids - set(output))
    if missing:
        raise RecropRepairError(f"target samples are absent from master: {missing[:8]}")
    return output


def _resolve_page(
    *,
    parent: Mapping[str, Any],
    proposal: Mapping[str, Any],
    library_root: Path,
    sample_id: str,
) -> tuple[Path, bytes, Image.Image, tuple[int, int, int, int]]:
    page = require_mapping(parent.get("page"), f"master[{sample_id}].page")
    locator = require_mapping(
        page.get("source_locator"), f"master[{sample_id}].page.source_locator"
    )
    relative_text = require_text(
        locator.get("path"), f"master[{sample_id}].page.source_locator.path"
    ).replace("\\", "/")
    relative = PurePosixPath(relative_text)
    windows_relative = PureWindowsPath(relative_text)
    if (
        relative.is_absolute()
        or windows_relative.is_absolute()
        or bool(windows_relative.drive)
        or ".." in relative.parts
    ):
        raise RecropRepairError(f"master[{sample_id}]: unsafe source page path")
    physical = library_root.joinpath(*relative.parts).resolve()
    try:
        physical.relative_to(library_root.resolve())
    except ValueError as error:
        raise RecropRepairError(f"master[{sample_id}]: source page escapes library") from error
    if not physical.is_file():
        raise RecropRepairError(f"master[{sample_id}]: missing source page {physical}")
    proposed_path_text = require_text(
        proposal.get("source_page_path"), f"proposal[{sample_id}].source_page_path"
    )
    proposed_path = Path(proposed_path_text)
    if proposed_path.is_absolute():
        path_matches = proposed_path.resolve() == physical
    else:
        path_matches = proposed_path_text.replace("\\", "/") == relative.as_posix()
    if not path_matches:
        raise RecropRepairError(f"proposal[{sample_id}]: source page path drifted")
    payload = physical.read_bytes()
    expected_sha = require_sha(
        page.get("source_page_sha256"), f"master[{sample_id}].page.source_page_sha256"
    )
    if (
        expected_sha
        != require_sha(locator.get("file_sha256"), f"master[{sample_id}].locator.file_sha256")
        or expected_sha
        != require_sha(proposal.get("source_page_sha256"), f"proposal[{sample_id}].source_page_sha256")
        or sha256_bytes(payload) != expected_sha
    ):
        raise RecropRepairError(f"master[{sample_id}]: source page hash mismatch")
    try:
        with Image.open(physical) as opened:
            decoded = ImageOps.exif_transpose(opened).convert("RGB")
            decoded.load()
    except (OSError, UnidentifiedImageError) as error:
        raise RecropRepairError(f"master[{sample_id}]: source page decode failed") from error
    geometry = require_mapping(
        parent.get("geometry"), f"master[{sample_id}].geometry"
    )
    current_bbox = require_bbox(
        geometry.get("bbox_px"),
        f"master[{sample_id}].geometry.bbox_px",
    )
    if tuple(proposal["current_bbox_px"]) != current_bbox:
        decoded.close()
        raise RecropRepairError(f"proposal[{sample_id}]: current bbox drifted")
    page_size = geometry.get("page_size_px")
    if page_size != [decoded.width, decoded.height]:
        decoded.close()
        raise RecropRepairError(f"master[{sample_id}]: decoded page size drifted")
    if locator.get("size_px") != page_size:
        decoded.close()
        raise RecropRepairError(f"master[{sample_id}]: locator page size drifted")
    preview_bbox = require_bbox(
        proposal.get("preview_bbox_px"), f"proposal[{sample_id}].preview_bbox_px"
    )
    if not (
        0 <= preview_bbox[0] < preview_bbox[2] <= decoded.width
        and 0 <= preview_bbox[1] < preview_bbox[3] <= decoded.height
    ):
        decoded.close()
        raise RecropRepairError(f"proposal[{sample_id}]: preview bbox exceeds page")
    preview = decoded.crop(preview_bbox)
    try:
        preview_sha = sha256_bytes(hard_audit.encode_png(preview))
    finally:
        preview.close()
    if preview_sha != proposal.get("preview_crop_sha256"):
        decoded.close()
        raise RecropRepairError(f"proposal[{sample_id}]: direct preview hash mismatch")
    return physical, payload, decoded, current_bbox


def _source_record(
    *,
    parent: Mapping[str, Any],
    proposal: Mapping[str, Any],
    parent_record_sha256: str,
) -> dict[str, Any]:
    sample_id = str(parent["id"])
    work = require_mapping(parent.get("work"), f"master[{sample_id}].work")
    chapter = require_mapping(parent.get("chapter"), f"master[{sample_id}].chapter")
    page = require_mapping(parent.get("page"), f"master[{sample_id}].page")
    locator = require_mapping(page.get("source_locator"), f"master[{sample_id}].locator")
    geometry = require_mapping(parent.get("geometry"), f"master[{sample_id}].geometry")
    metadata = require_mapping(parent.get("metadata"), f"master[{sample_id}].metadata")
    provenance = require_mapping(parent.get("provenance"), f"master[{sample_id}].provenance")
    groups = require_mapping(parent.get("groups"), f"master[{sample_id}].groups")
    candidate_value = metadata.get("candidate_metadata")
    if isinstance(candidate_value, Mapping):
        candidate_metadata = copy.deepcopy(dict(candidate_value))
        categories = candidate_metadata.get("categories")
        if (
            not isinstance(categories, list)
            or not categories
            or any(value not in hard_audit.HARD_CATEGORY_PRIORITY for value in categories)
        ):
            raise RecropRepairError(
                f"master[{sample_id}]: hard parent categories are invalid"
            )
    else:
        candidate_metadata = {
            "categories": ["ocr_hard"],
            "candidate_score": 1.0,
            "candidate_evidence": [],
            "candidate_source_ids": [provenance.get("source_id")],
            "ocr_text": metadata.get("ocr_text") or "",
            "detector_model": None,
        }
    evidence = candidate_metadata.get("candidate_evidence")
    if not isinstance(evidence, list):
        evidence = []
    candidate_metadata["candidate_evidence"] = [
        *[copy.deepcopy(value) for value in evidence if isinstance(value, Mapping)],
        {
            "source": "font_matching_visual_defect_intake",
            "parent_sample_id": sample_id,
            "parent_master_record_sha256": parent_record_sha256,
            "parent_source_catalog_id": provenance.get("source_catalog_id"),
            "parent_source_id": provenance.get("source_id"),
            "proposal_record_sha256": proposal.get("record_sha256"),
            "qa_overlay": False,
            "synthetic": False,
        },
    ]
    return {
        "schema_version": 1,
        "id": sample_id,
        "source_image_path": str(locator["path"]).replace("\\", "/"),
        "source_page_sha256": page["source_page_sha256"],
        "work_id": work["id"],
        "work_title": work.get("title"),
        "chapter_id": chapter["id"],
        "chapter_title": chapter.get("title"),
        "page_id": page["id"],
        "page_name": page.get("name"),
        "page_size_px": geometry["page_size_px"],
        "declared_page_size_px": locator.get("size_px") or geometry["page_size_px"],
        "source_dimension_mismatch": False,
        "split": parent["split"],
        "orientation": proposal["actual_orientation"],
        "bbox_px": geometry.get("bbox_px") or geometry["final_bbox_px"],
        "source_crop_bbox_px": geometry.get("crop_bbox_px") or geometry["bbox_px"],
        "candidate_metadata": candidate_metadata,
        "ocr_hints_sha256": None,
        "ocr_metadata_skip_reasons": {},
        "selection_segment_index": 0,
        "work_balance_weight": parent.get("work_balance_weight", 1.0),
        "chapter_balance_weight": 1.0,
        "root_real_id": groups.get("root"),
    }


def _managed_files(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name != MARKER_FILE
    }


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    master_manifest: Path,
    orientation_rejected: Path,
    final_labels: Path,
    proposal_paths: Sequence[Path],
    library_root: Path,
    repair_processed_root: Path,
    expected_orientation_targets: int,
    expected_rescue_targets: int,
    expected_total_targets: int,
) -> dict[str, Any]:
    orientation_targets = _orientation_targets(
        orientation_rejected, expected_orientation_targets
    )
    rescue_targets = _rescue_targets(final_labels, expected_rescue_targets)
    overlap = sorted(set(orientation_targets) & set(rescue_targets))
    if overlap:
        raise RecropRepairError(f"defect target sets overlap: {overlap[:8]}")
    targets = {**orientation_targets, **rescue_targets}
    if len(targets) != expected_total_targets:
        raise RecropRepairError(
            f"expected {expected_total_targets} total targets, got {len(targets)}"
        )
    proposals, proposal_signatures = _load_proposals(
        proposal_paths, set(targets)
    )
    for sample_id, target in targets.items():
        expected_contract = (
            ORIENTATION_PROPOSAL_CONTRACT
            if target["defect_source"] == "orientation_visual_audit"
            else RESCUE_PROPOSAL_CONTRACT
        )
        proposal = proposals[sample_id]
        actual_contract = (
            proposal.get("schema_version"),
            proposal.get("record_type"),
        )
        if actual_contract != expected_contract:
            raise RecropRepairError(
                f"proposal[{sample_id}]: contract does not match its defect source"
            )
    masters = _load_master(master_manifest, set(targets))
    master_sha256 = sha256_file(master_manifest)
    orientation_sha256 = sha256_file(orientation_rejected)
    finals_sha256 = sha256_file(final_labels)
    preparation_signature = stable_hash(
        SCHEMA_VERSION,
        master_sha256,
        orientation_sha256,
        finals_sha256,
        *(value["sha256"] for value in proposal_signatures),
    )
    queue_physical = physical_root / QUEUE_DIR
    queue_declared = declared_root / QUEUE_DIR
    candidates: list[dict[str, Any]] = []
    lineages: list[dict[str, Any]] = []
    intake_rows: list[dict[str, Any]] = []
    supersession_rows: list[dict[str, Any]] = []
    replacement_rows: list[dict[str, Any]] = []
    for sample_id in sorted(targets):
        parent = masters[sample_id]
        proposal = proposals[sample_id]
        target = targets[sample_id]
        public_target = {
            key: copy.deepcopy(value)
            for key, value in target.items()
            if not key.startswith("_")
        }
        if target["defect_source"] == "none_acceptable_non_single_orientation":
            parent_work_id = require_text(
                require_mapping(parent.get("work"), f"master[{sample_id}].work").get("id"),
                f"master[{sample_id}].work.id",
            )
            parent_page_sha = require_sha(
                require_mapping(parent.get("page"), f"master[{sample_id}].page").get(
                    "source_page_sha256"
                ),
                f"master[{sample_id}].page.source_page_sha256",
            )
            if (
                parent_work_id != target["prior_work_id"]
                or parent_page_sha != target["prior_source_page_sha256"]
            ):
                raise RecropRepairError(
                    f"master[{sample_id}]: prior final identity binding drifted"
                )
        parent_record_sha256 = sha256_bytes(
            canonical_json(parent).encode("utf-8")
        )
        _page_path, page_bytes, decoded, current_bbox = _resolve_page(
            parent=parent,
            proposal=proposal,
            library_root=library_root,
            sample_id=sample_id,
        )
        try:
            action = str(proposal["action"])
            candidate_id: str | None = None
            candidate_record_sha256: str | None = None
            if action == "recrop":
                recrop_bbox = require_bbox(
                    proposal.get("recrop_bbox_px"),
                    f"proposal[{sample_id}].recrop_bbox_px",
                )
                if recrop_bbox == current_bbox:
                    raise RecropRepairError(f"proposal[{sample_id}]: recrop is a no-op")
                source_record = _source_record(
                    parent=parent,
                    proposal=proposal,
                    parent_record_sha256=parent_record_sha256,
                )
                decision = hard_audit.ReviewDecision(
                    item_id=sample_id,
                    decision="recrop",
                    reject_reason="",
                    recrop_bbox_px=recrop_bbox,
                    padding_px=0,
                    reviewer=str(proposal["reviewer"]),
                    reviewed_at=str(proposal["reviewed_at"]),
                    notes=str(proposal["note"]),
                    shard_tag="font-matching-recrop-repair-v1",
                    sheet="source-page-direct-review",
                    cell_index=1,
                    ledger_path=str(proposal["_proposal_file_path"]),
                    ledger_sha256=str(proposal["_proposal_file_sha256"]),
                )
                candidate, lineage = hard_audit.build_repair_candidate(
                    source_record,
                    decision,
                    queue_physical_root=queue_physical,
                    queue_declared_root=queue_declared,
                    library_root=library_root,
                    write_assets=True,
                )
                candidate_id = str(candidate["id"])
                if any(existing.get("id") == candidate_id for existing in candidates):
                    raise RecropRepairError(
                        f"proposal[{sample_id}]: duplicate successor candidate ID"
                    )
                candidate_record_sha256 = sha256_bytes(
                    canonical_json(candidate).encode("utf-8")
                )
                candidates.append(candidate)
                lineage = {
                    **lineage,
                    "parent_sample_id": sample_id,
                    "parent_master_manifest_sha256": master_sha256,
                    "parent_master_record_sha256": parent_record_sha256,
                    "proposal_record_sha256": proposal["record_sha256"],
                }
                lineages.append(seal(lineage))
            invalidated_final_ids = (
                [targets[sample_id]["prior_final_id"]]
                if targets[sample_id].get("prior_final_id")
                else []
            )
            common = {
                "schema_version": SCHEMA_VERSION,
                "parent_sample_id": sample_id,
                "parent_master_manifest_sha256": master_sha256,
                "parent_master_record_sha256": parent_record_sha256,
                "parent_source_catalog_id": require_mapping(
                    parent.get("provenance"), f"master[{sample_id}].provenance"
                ).get("source_catalog_id"),
                "parent_source_id": require_mapping(
                    parent.get("provenance"), f"master[{sample_id}].provenance"
                ).get("source_id"),
                "parent_sample_crop_sha256": parent.get("sample_crop_sha256"),
                "source_page_path": require_mapping(
                    require_mapping(
                        parent.get("page"), f"master[{sample_id}].page"
                    ).get("source_locator"),
                    f"master[{sample_id}].locator",
                ).get("path"),
                "source_page_sha256": sha256_bytes(page_bytes),
                "decoded_page_size_px": [decoded.width, decoded.height],
                "defect": public_target,
                "proposal_record_sha256": proposal["record_sha256"],
                "action": action,
                "recrop_bbox_px": proposal.get("recrop_bbox_px"),
                "intended_orientation": proposal.get("actual_orientation"),
                "preview_bbox_px": proposal["preview_bbox_px"],
                "preview_crop_sha256": proposal["preview_crop_sha256"],
                "viewed_original": True,
                "reviewer": proposal["reviewer"],
                "reviewed_at": proposal["reviewed_at"],
                "notes": proposal["note"],
                "successor_candidate_id": candidate_id,
                "successor_candidate_record_sha256": candidate_record_sha256,
                "invalidated_final_ids": invalidated_final_ids,
            }
            intake_rows.append(
                seal({**common, "record_type": "font_matching_recrop_intake"})
            )
            supersession = seal(
                {
                    **common,
                    "record_type": "font_matching_parent_supersession",
                    "parent_excluded_from_training": True,
                    "parent_excluded_from_font_review": True,
                    "successor_status": (
                        "pending_postprocess_and_visual_recheck"
                        if action == "recrop"
                        else "replacement_required"
                    ),
                    "prior_final_labels_invalidated": bool(invalidated_final_ids),
                }
            )
            supersession_rows.append(supersession)
            if action == "replace":
                replacement_rows.append(supersession)
        finally:
            decoded.close()
    if not candidates:
        raise RecropRepairError("repair intake produced no recrop candidates")
    queue_contract = hard_audit.write_repair_queue_contract(
        queue_physical_root=queue_physical,
        queue_declared_root=queue_declared,
        library_root=library_root,
        candidates=candidates,
        preparation_signature_sha256=preparation_signature,
    )
    (physical_root / INTAKE_FILE).write_bytes(jsonl_bytes(intake_rows))
    (physical_root / SUPERSESSION_FILE).write_bytes(jsonl_bytes(supersession_rows))
    (physical_root / REPLACEMENTS_FILE).write_bytes(jsonl_bytes(replacement_rows))
    (physical_root / "recrop-lineage.jsonl").write_bytes(jsonl_bytes(lineages))
    defect_evidence_rows = [
        copy.deepcopy(targets[sample_id]["_evidence_record"])
        for sample_id in sorted(targets)
    ]
    proposal_record_rows = [
        {
            key: copy.deepcopy(value)
            for key, value in proposals[sample_id].items()
            if not key.startswith("_")
        }
        for sample_id in sorted(proposals)
    ]
    parent_record_rows = [copy.deepcopy(masters[sample_id]) for sample_id in sorted(masters)]
    (physical_root / DEFECT_EVIDENCE_FILE).write_bytes(
        jsonl_bytes(defect_evidence_rows)
    )
    (physical_root / PROPOSAL_RECORDS_FILE).write_bytes(
        jsonl_bytes(proposal_record_rows)
    )
    (physical_root / PARENT_RECORDS_FILE).write_bytes(
        jsonl_bytes(parent_record_rows)
    )
    by_catalog = Counter(
        str(row["parent_source_catalog_id"]) for row in intake_rows
    )
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_recrop_repair_report",
            "inputs": {
                "master_manifest_sha256": master_sha256,
                "orientation_rejected_sha256": orientation_sha256,
                "final_labels_sha256": finals_sha256,
                "proposal_files": proposal_signatures,
                "preparation_signature_sha256": preparation_signature,
                "current_bbox_semantics": "master.geometry.bbox_px",
            },
            "counts": {
                "targets": len(targets),
                "orientation_targets": len(orientation_targets),
                "rescue_targets": len(rescue_targets),
                "recrops": len(candidates),
                "replacements": len(replacement_rows),
                "by_parent_catalog": dict(sorted(by_catalog.items())),
                "invalidated_prior_finals": sum(
                    bool(row["invalidated_final_ids"]) for row in intake_rows
                ),
            },
            "outputs": {
                "queue": queue_contract,
                "intake_sha256": sha256_file(physical_root / INTAKE_FILE),
                "supersession_sha256": sha256_file(
                    physical_root / SUPERSESSION_FILE
                ),
                "replacement_sha256": sha256_file(
                    physical_root / REPLACEMENTS_FILE
                ),
                "lineage_sha256": sha256_file(
                    physical_root / "recrop-lineage.jsonl"
                ),
                "defect_evidence_sha256": sha256_file(
                    physical_root / DEFECT_EVIDENCE_FILE
                ),
                "proposal_records_sha256": sha256_file(
                    physical_root / PROPOSAL_RECORDS_FILE
                ),
                "parent_records_sha256": sha256_file(
                    physical_root / PARENT_RECORDS_FILE
                ),
            },
            "postprocess_command": [
                "python",
                "scripts/postprocess_fontclip_hard_candidates.py",
                "--input-root",
                str(queue_declared),
                "--library-root",
                str(library_root),
                "--output-root",
                str(repair_processed_root),
                "--expected-input-manifest-sha256",
                str(queue_contract["manifest_sha256"]),
                "--minimum-input-candidates",
                str(len(candidates)),
                "--minimum-processed-records",
                "0",
                "--verify-ctd-model-hash",
            ],
            "safety": {
                "source_files_modified": False,
                "parents_overwritten": 0,
                "qa_overlays_written": 0,
                "synthetic_assets_written": 0,
                "new_identity_per_recrop": True,
                "prior_finals_carried_to_children": 0,
                "evidence_snapshots_training_eligible": False,
                "only_repair_queue_manifest_is_postprocess_eligible": True,
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
    return report


def validate_tree(root: Path) -> dict[str, Any]:
    marker = read_json(root / MARKER_FILE, "ownership marker")
    if marker.get("schema_version") != SCHEMA_VERSION or marker.get("owner") != OWNER:
        raise RecropRepairError("repair ownership marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise RecropRepairError("repair ownership marker has no file inventory")
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }
    expected = {MARKER_FILE, *[str(value) for value in managed]}
    if actual != expected:
        raise RecropRepairError(
            f"repair file inventory differs; missing={sorted(expected - actual)[:8]} "
            f"unexpected={sorted(actual - expected)[:8]}"
        )
    for relative, expected_sha in managed.items():
        if not isinstance(relative, str) or "\\" in relative:
            raise RecropRepairError("ownership marker contains an unsafe path")
        pure = PurePosixPath(relative)
        windows = PureWindowsPath(relative)
        if pure.is_absolute() or windows.is_absolute() or windows.drive or ".." in pure.parts:
            raise RecropRepairError("ownership marker contains an unsafe path")
        require_sha(expected_sha, f"ownership marker[{relative}]")
        physical = root.joinpath(*pure.parts)
        if not physical.is_file() or sha256_file(physical) != expected_sha:
            raise RecropRepairError(f"repair artifact is stale or tampered: {relative}")
    report = read_json(root / REPORT_FILE, "repair report")
    validate_seal(report, "repair report")
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
        raise RecropRepairError("rebuilt repair file inventory is not deterministic")
    stale = [name for name in expected if expected[name] != actual[name]]
    if stale:
        raise RecropRepairError(f"rebuilt repair artifacts differ: {stale[:8]}")


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _validate_output_separation(
    *, output_root: Path, library_root: Path, repair_processed_root: Path
) -> None:
    if _is_within(library_root, output_root) or _is_within(output_root, library_root):
        raise RecropRepairError("repair output must be disjoint from the library")
    if _is_within(library_root, repair_processed_root) or _is_within(
        repair_processed_root, library_root
    ):
        raise RecropRepairError(
            "processed repair output must be disjoint from the library"
        )
    if (
        output_root == repair_processed_root
        or _is_within(output_root, repair_processed_root)
        or _is_within(repair_processed_root, output_root)
    ):
        raise RecropRepairError(
            "repair queue and processed output must be separate directories"
        )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument("--orientation-rejected", type=Path, required=True)
    parser.add_argument("--final-labels", type=Path, required=True)
    parser.add_argument("--proposal", type=Path, action="append", required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--repair-processed-root", type=Path, required=True)
    parser.add_argument(
        "--expected-orientation-targets", type=positive_int, required=True
    )
    parser.add_argument("--expected-rescue-targets", type=positive_int, required=True)
    parser.add_argument("--expected-total-targets", type=positive_int, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    output_root = args.output_root.resolve()
    inputs = {
        "master_manifest": args.master_manifest.resolve(),
        "orientation_rejected": args.orientation_rejected.resolve(),
        "final_labels": args.final_labels.resolve(),
        "proposal_paths": [value.resolve() for value in args.proposal],
        "library_root": args.library_root.resolve(),
        "repair_processed_root": args.repair_processed_root.resolve(),
        "expected_orientation_targets": args.expected_orientation_targets,
        "expected_rescue_targets": args.expected_rescue_targets,
        "expected_total_targets": args.expected_total_targets,
    }
    try:
        _validate_output_separation(
            output_root=output_root,
            library_root=inputs["library_root"],
            repair_processed_root=inputs["repair_processed_root"],
        )
        if args.command == "build":
            if output_root.exists():
                raise RecropRepairError(
                    f"refusing to replace existing repair output: {output_root}"
                )
            output_root.parent.mkdir(parents=True, exist_ok=True)
            staging = Path(
                tempfile.mkdtemp(
                    prefix=f".{output_root.name}.building-", dir=output_root.parent
                )
            )
            completed = False
            try:
                report = _write_tree(
                    physical_root=staging,
                    declared_root=output_root,
                    **inputs,
                )
                validate_tree(staging)
                staging.rename(output_root)
                completed = True
            finally:
                if not completed and staging.exists():
                    shutil.rmtree(staging)
        else:
            report = validate_tree(output_root)
            temporary_parent = output_root.parent
            rebuilt = Path(
                tempfile.mkdtemp(
                    prefix=f".{output_root.name}.validating-", dir=temporary_parent
                )
            )
            try:
                _write_tree(
                    physical_root=rebuilt,
                    declared_root=output_root,
                    **inputs,
                )
                _compare_trees(rebuilt, output_root)
            finally:
                shutil.rmtree(rebuilt)
        print(canonical_json({"status": "valid", **report["counts"]}))
        return 0
    except (RecropRepairError, hard_audit.HardAdjudicationError) as error:
        print(f"font matching recrop repair error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
