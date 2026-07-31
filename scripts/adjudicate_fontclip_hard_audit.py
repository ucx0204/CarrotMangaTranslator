#!/usr/bin/env python3
"""Adjudicate exhaustive FontCLIP hard-style reviews without implicit trust.

This tool deliberately separates manual recropping into three phases:

``prepare``
    Revalidate the complete processed dataset and four completed visual-review
    shards, freeze every review artifact by SHA-256, and materialize a signed
    real-page repair queue.  Original passes are *not* published yet.

``build-recheck``
    Verify that the ordinary hard postprocessor produced exactly one terminal
    outcome for every repair candidate.  Signed processing rejects are safely
    excluded; surviving successors are rendered into a new four-shard
    exhaustive review.  A successor remains ineligible until that second
    review is finalized by ``record_fontclip_sheet_review.py``.

``finalize``
    Revalidate both processed datasets and both four-shard review bundles.
    Original passes plus second-review successor passes are copied into a
    mutation-independent accepted dataset.  Reject and recrop lineage remains
    explicit, synthetic records are forbidden, and the default final gate is
    5,000 accepted records.

The repair queue contains byte-derived crops from immutable original pages and
uses the input contract of ``postprocess_fontclip_hard_candidates.py``.  It
never copies a QA overlay or generates glyph pixels.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image, ImageOps, UnidentifiedImageError


TOOL_ID = "manga-translator-fontclip-hard-adjudicator"
SCHEMA_VERSION = 1
MINIMUM_ACCEPTED_RECORDS = 5000
REQUIRED_AUDIT_SHARDS = 4
MAX_CHAPTERS_PER_WORK = 20
MAX_RECROP_PADDING = 4096
PREP_MARKER_NAME = ".fontclip-hard-adjudication.json"
FINAL_MARKER_NAME = ".fontclip-hard-final.json"
PREP_REPORT_NAME = "report.json"
INITIAL_DECISIONS_NAME = "initial_decisions.jsonl"
INITIAL_REJECTS_NAME = "initial_rejects.jsonl"
RECROP_LINEAGE_NAME = "recrop_lineage.jsonl"
REPAIR_QUEUE_NAME = "repair_queue"
FINAL_MANIFEST_NAME = "manifest.jsonl"
FINAL_REJECTS_NAME = "rejects.jsonl"
FINAL_LINEAGE_NAME = "lineage.jsonl"
FINAL_REPORT_NAME = "report.json"
FINAL_POLICY_NAME = "provenance_policy.json"
RECHECK_QA_DIR_NAME = "qa-recheck"
REPAIR_QUEUE_OWNED_OUTPUTS = [
    "images/raw",
    "images/clip_224",
    "manifest.jsonl",
    "report.json",
]
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_COMPONENT = re.compile(r"^[^/\\\x00]+$")
ALLOWED_SPLITS = frozenset({"train", "val", "test"})
HARD_CATEGORY_PRIORITY = {
    "page_sound": 0,
    "ocr_sound_prior": 1,
    "bubble_edge": 2,
    "text_free": 3,
    "free_near_bubble": 4,
    "ocr_hard": 5,
    "ocr_anime_region": 6,
    "ocr_free_container": 7,
}


class HardAdjudicationError(RuntimeError):
    """Raised when any signed review or dataset contract is violated."""


@dataclass(frozen=True)
class ReviewDecision:
    item_id: str
    decision: str
    reject_reason: str
    recrop_bbox_px: tuple[int, int, int, int] | None
    padding_px: int
    reviewer: str
    reviewed_at: str
    notes: str
    shard_tag: str
    sheet: str
    cell_index: int
    ledger_path: str
    ledger_sha256: str


@dataclass(frozen=True)
class AuditBundle:
    decisions: dict[str, ReviewDecision]
    binding: dict[str, Any]
    frozen_files: dict[str, str]


@dataclass(frozen=True)
class ValidatedDataset:
    root: Path
    library_root: Path
    result: Any
    records_by_id: dict[str, dict[str, Any]]
    binding: dict[str, Any]


@dataclass(frozen=True)
class RepairResolution:
    successors: dict[str, dict[str, Any]]
    postprocess_rejects: dict[str, dict[str, Any]]


def _load_local_module(name: str, filename: str) -> ModuleType:
    path = Path(__file__).resolve().with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load required local module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


HARD_QA = _load_local_module(
    "_fontclip_hard_dataset_qa_for_adjudication",
    "fontclip_hard_dataset_qa.py",
)
RECORDER = _load_local_module(
    "_record_fontclip_sheet_review_for_adjudication",
    "record_fontclip_sheet_review.py",
)


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pixel_sha256(image: Image.Image) -> str:
    canonical = image
    if canonical.mode not in {"RGB", "RGBA", "L"}:
        canonical = canonical.convert("RGB")
    digest = hashlib.sha256()
    digest.update(canonical.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(f"{canonical.width}x{canonical.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(canonical.tobytes())
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def safe_component(value: Any, label: str) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or text in {".", ".."} or not SAFE_COMPONENT.fullmatch(text):
        raise HardAdjudicationError(f"unsafe or empty {label}: {value!r}")
    return text


def safe_relative(value: Any, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value.strip():
        raise HardAdjudicationError(f"missing {label}")
    normalized = value.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    pure = PurePosixPath(normalized)
    if (
        pure.is_absolute()
        or not pure.parts
        or any(part in {"", ".", ".."} for part in pure.parts)
        or ":" in pure.parts[0]
    ):
        raise HardAdjudicationError(f"unsafe {label}: {value!r}")
    return pure


def resolve_inside(root: Path, value: Any, label: str) -> Path:
    pure = safe_relative(value, label)
    candidate = root.joinpath(*pure.parts).resolve()
    if not is_within(root, candidate):
        raise HardAdjudicationError(f"{label} escapes its root: {value!r}")
    return candidate


def parse_bbox(
    value: Any,
    label: str,
    *,
    page_size: tuple[int, int] | None = None,
) -> tuple[int, int, int, int]:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 4
        or any(type(component) is not int for component in value)
    ):
        raise HardAdjudicationError(
            f"{label} must be four integer source-page XYXY coordinates"
        )
    x1, y1, x2, y2 = (int(component) for component in value)
    if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
        raise HardAdjudicationError(f"invalid {label}: {list(value)!r}")
    if page_size is not None:
        width, height = page_size
        if x2 > width or y2 > height:
            raise HardAdjudicationError(
                f"{label} {list(value)!r} exceeds source page {page_size}"
            )
    return x1, y1, x2, y2


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as error:
        raise HardAdjudicationError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise HardAdjudicationError(f"{path}: expected a JSON object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise HardAdjudicationError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, dict):
                raise HardAdjudicationError(
                    f"{path}:{line_number}: expected a JSON object"
                )
            records.append(value)
    return records


def json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def jsonl_bytes(records: Iterable[Mapping[str, Any]]) -> bytes:
    return "".join(f"{canonical_json(record)}\n" for record in records).encode("utf-8")


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def letterbox_rgb(image: Image.Image, size: int = 224) -> Image.Image:
    source = image.convert("RGB")
    scale = min(size / source.width, size / source.height)
    resized_size = (
        max(1, round(source.width * scale)),
        max(1, round(source.height * scale)),
    )
    resized = source.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), "white")
    canvas.paste(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    resized.close()
    return canvas


def _require_separate_roots(
    left: Path,
    right: Path,
    left_label: str,
    right_label: str,
) -> None:
    if left == right or is_within(left, right) or is_within(right, left):
        raise HardAdjudicationError(
            f"{left_label} and {right_label} must be separate, non-nested roots"
        )


def validate_output_root(
    output_value: Path,
    *,
    protected: Sequence[tuple[str, Path]],
) -> Path:
    output = output_value.expanduser().resolve()
    broad_roots = {
        Path(output.anchor).resolve(),
        Path.home().resolve(),
        Path.cwd().resolve(),
        Path(__file__).resolve().parents[1],
    }
    if not output.name or output in broad_roots:
        raise HardAdjudicationError(f"unsafe output root: {output}")
    for label, root in protected:
        _require_separate_roots(output, root.resolve(), "--output-root", label)
    return output


def validate_processed_dataset(
    dataset_value: Path,
    library_value: Path,
) -> ValidatedDataset:
    dataset_root = dataset_value.expanduser().resolve()
    library_root = library_value.expanduser().resolve()
    if not dataset_root.is_dir():
        raise FileNotFoundError(dataset_root)
    if not library_root.is_dir():
        raise FileNotFoundError(library_root)
    _require_separate_roots(
        dataset_root,
        library_root,
        "processed dataset",
        "library root",
    )
    issues = HARD_QA.IssueCollector()
    try:
        result = HARD_QA.validate_dataset(
            dataset_root,
            library_root,
            issues,
            shard_index=0,
            shard_count=1,
        )
    except (
        ArithmeticError,
        IndexError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
    ) as error:
        raise HardAdjudicationError(
            f"hard dataset validation raised {type(error).__name__}: {error}"
        ) from error
    if issues.error_count:
        preview = "; ".join(
            f"{item.get('code')}: {item.get('message')}" for item in issues.details[:12]
        )
        raise HardAdjudicationError(
            f"hard dataset validation found {issues.error_count} errors: {preview}"
        )
    records_by_id = {str(record["id"]): dict(record) for record in result.records}
    if len(records_by_id) != len(result.records):
        raise HardAdjudicationError("processed manifest IDs are not unique")
    for item_id, record in records_by_id.items():
        if (
            record.get("provenance") != "real_processed"
            or record.get("synthetic") is not False
            or record.get("synthetic_provenance") is not None
        ):
            raise HardAdjudicationError(
                f"{item_id}: synthetic or non-real processed record is forbidden"
            )
        processing = record.get("processing")
        if (
            not isinstance(processing, Mapping)
            or processing.get("diagnostic_overlay_written") is not False
        ):
            raise HardAdjudicationError(
                f"{item_id}: diagnostic-overlay provenance is forbidden"
            )
    binding = {
        "root": str(dataset_root),
        "manifest": str(dataset_root / HARD_QA.MANIFEST_NAME),
        "manifest_sha256": result.manifest_sha256,
        "ownership_marker": str(dataset_root / HARD_QA.MARKER_NAME),
        "ownership_marker_sha256": result.marker_sha256,
        "report": str(dataset_root / HARD_QA.REPORT_NAME),
        "report_sha256": result.report_sha256,
        "rejects": str(dataset_root / HARD_QA.REJECTS_NAME),
        "rejects_sha256": result.rejects_sha256,
        "synthetic_provenance_schema": str(dataset_root / HARD_QA.SYNTHETIC_SPEC_NAME),
        "synthetic_provenance_schema_sha256": result.synthetic_spec_sha256,
        "processed_records": len(result.records),
        "id_set_sha256": HARD_QA.hash_ids(result.global_ids, sort_items=True),
        "ordered_ids_sha256": HARD_QA.hash_ids(
            result.global_ids,
            sort_items=False,
        ),
    }
    return ValidatedDataset(
        root=dataset_root,
        library_root=library_root,
        result=result,
        records_by_id=records_by_id,
        binding=binding,
    )


def verify_dataset_binding(binding: Mapping[str, Any]) -> None:
    for path_key, hash_key in (
        ("manifest", "manifest_sha256"),
        ("ownership_marker", "ownership_marker_sha256"),
        ("report", "report_sha256"),
        ("rejects", "rejects_sha256"),
        (
            "synthetic_provenance_schema",
            "synthetic_provenance_schema_sha256",
        ),
    ):
        path = Path(str(binding.get(path_key, ""))).resolve()
        expected = binding.get(hash_key)
        if not path.is_file() or not isinstance(expected, str):
            raise HardAdjudicationError(f"dataset binding lacks {path_key}/{hash_key}")
        if sha256_file(path) != expected:
            raise HardAdjudicationError(
                f"signed dataset input changed during adjudication: {path}"
            )


def _parse_csv_bbox(value: Any, label: str) -> tuple[int, int, int, int] | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise HardAdjudicationError(f"{label}: invalid bbox JSON") from error
    return parse_bbox(value, label)


def _validate_decision_semantics(
    row: Mapping[str, Any],
    *,
    shard_tag: str,
    sheet: str,
    ledger_path: Path,
    ledger_sha256: str,
) -> ReviewDecision:
    item_id = safe_component(row.get("id"), "review decision id")
    decision = str(row.get("decision", "")).strip()
    reject_reason = str(row.get("reject_reason", "")).strip()
    notes = str(row.get("notes", "")).strip()
    reviewer = str(row.get("reviewer", "")).strip()
    reviewed_at = str(row.get("reviewed_at", "")).strip()
    if decision not in {"pass", "reject", "recrop"}:
        raise HardAdjudicationError(f"{item_id}: invalid review decision {decision!r}")
    if not reviewer or not reviewed_at:
        raise HardAdjudicationError(f"{item_id}: reviewer and reviewed_at are required")
    if not reviewed_at.endswith("Z"):
        raise HardAdjudicationError(
            f"{item_id}: reviewed_at must be a UTC timestamp ending in Z"
        )
    try:
        parsed_review_time = datetime.fromisoformat(
            reviewed_at.removesuffix("Z") + "+00:00"
        )
    except ValueError as error:
        raise HardAdjudicationError(
            f"{item_id}: reviewed_at is not a valid UTC timestamp"
        ) from error
    offset = parsed_review_time.utcoffset()
    if offset is None or offset.total_seconds() != 0:
        raise HardAdjudicationError(f"{item_id}: reviewed_at must be UTC")
    raw_cell_index = row.get("cell_index")
    if type(raw_cell_index) is not int:
        raise HardAdjudicationError(f"{item_id}: invalid review cell index")
    cell_index = raw_cell_index
    if cell_index < 1:
        raise HardAdjudicationError(f"{item_id}: invalid review cell index")
    bbox = _parse_csv_bbox(
        row.get("recrop_bbox_px"),
        f"{item_id} recrop_bbox_px",
    )
    raw_padding = row.get("padding_px")
    if raw_padding in {None, ""}:
        padding = 0
    else:
        if type(raw_padding) is not int:
            raise HardAdjudicationError(f"{item_id}: padding_px must be an integer")
        padding = raw_padding
    if not 0 <= padding <= MAX_RECROP_PADDING:
        raise HardAdjudicationError(
            f"{item_id}: padding_px must be 0..{MAX_RECROP_PADDING}"
        )
    if decision == "pass":
        if reject_reason or bbox is not None or padding:
            raise HardAdjudicationError(
                f"{item_id}: pass decision contains reject/recrop data"
            )
    elif decision == "reject":
        if not reject_reason or bbox is not None or padding:
            raise HardAdjudicationError(
                f"{item_id}: reject decision requires only a non-empty reason"
            )
    else:
        if bbox is None or reject_reason or not notes:
            raise HardAdjudicationError(
                f"{item_id}: recrop requires bbox and note, without reject reason"
            )
    return ReviewDecision(
        item_id=item_id,
        decision=decision,
        reject_reason=reject_reason,
        recrop_bbox_px=bbox,
        padding_px=padding,
        reviewer=reviewer,
        reviewed_at=reviewed_at,
        notes=notes,
        shard_tag=shard_tag,
        sheet=sheet,
        cell_index=cell_index,
        ledger_path=str(ledger_path),
        ledger_sha256=ledger_sha256,
    )


def _expected_inventory_item(
    record: Mapping[str, Any],
    *,
    cell_index: int,
    audit_index: int,
) -> dict[str, Any]:
    return HARD_QA.inventory_item(
        record,
        cell_index=cell_index,
        audit_index=audit_index,
    )


def _validate_one_shard(
    ledger_value: Path,
    *,
    dataset: ValidatedDataset,
) -> tuple[
    int,
    str,
    list[ReviewDecision],
    dict[str, Any],
    dict[str, str],
]:
    ledger = ledger_value.expanduser().resolve()
    if not ledger.is_file() or ledger.suffix.lower() != ".csv":
        raise HardAdjudicationError(
            f"completed review ledger must be a CSV file: {ledger}"
        )
    review_dir = ledger.parent.resolve()
    qa_dir = (
        review_dir.parent.resolve()
        if review_dir.name == "reviews"
        else review_dir
    )
    if not is_within(dataset.root, qa_dir) or qa_dir == dataset.root:
        raise HardAdjudicationError(
            f"review ledger must be below the processed dataset: {ledger}"
        )
    ledger_sha = sha256_file(ledger)
    marker_path = RECORDER.completion_marker_path(ledger)
    marker = read_json(marker_path)
    if (
        marker.get("schema_version") != RECORDER.SCHEMA_VERSION
        or marker.get("marker_type") != RECORDER.LEDGER_MARKER_TYPE
        or marker.get("completed") is not True
        or marker.get("ledger") != ledger.name
        or marker.get("ledger_sha256") != ledger_sha
    ):
        raise HardAdjudicationError(f"{marker_path}: invalid completed-ledger marker")
    shard_tag = str(marker.get("shard_tag", "")).strip()
    state, inventory_paths = RECORDER.validate_shard_state(qa_dir, shard_tag)
    try:
        shard_index = int(state["shard_index"])
        shard_count = int(state["shard_count"])
    except (KeyError, TypeError, ValueError) as error:
        raise HardAdjudicationError(f"{qa_dir}: malformed shard state") from error
    if shard_count != REQUIRED_AUDIT_SHARDS:
        raise HardAdjudicationError(
            f"{qa_dir}: exhaustive adjudication requires exactly "
            f"{REQUIRED_AUDIT_SHARDS} shards"
        )
    expected_tag = HARD_QA.shard_tag(shard_index, shard_count)
    if shard_tag != expected_tag:
        raise HardAdjudicationError(f"{qa_dir}: shard tag/state coordinates disagree")

    state_path = qa_dir / HARD_QA.state_name_for_shard(
        shard_index,
        shard_count,
    )
    report_path = qa_dir / HARD_QA.report_name_for_shard(
        shard_index,
        shard_count,
    )
    report = read_json(report_path)
    ordered_global_records = sorted(
        dataset.result.records,
        key=HARD_QA.record_order_key,
    )
    expected_global_ids_in_order = [
        str(record["id"]) for record in ordered_global_records
    ]
    expected_ids_in_order = [
        str(record["id"])
        for record in ordered_global_records
        if HARD_QA.shard_bucket(str(record["id"]), shard_count) == shard_index
    ]
    expected_ids = sorted(expected_ids_in_order)
    expected_mask_hashes = {
        "ownership_marker": dataset.result.marker_sha256,
        "postprocess_report": dataset.result.report_sha256,
        "rejects": dataset.result.rejects_sha256,
        "synthetic_provenance_schema": dataset.result.synthetic_spec_sha256,
    }
    hard_state = state.get("hard_qa")
    validation_scope = (
        hard_state.get("asset_validation_scope")
        if isinstance(hard_state, Mapping)
        else None
    )
    overlay = (
        hard_state.get("qa_context_overlay_colors")
        if isinstance(hard_state, Mapping)
        else None
    )
    if (
        state.get("schema_version") != HARD_QA.SCHEMA_VERSION
        or state.get("audit_all") is not True
        or state.get("mask_review") is not True
        or state.get("primary_manifest") != HARD_QA.MANIFEST_NAME
        or state.get("primary_manifest_sha256") != dataset.result.manifest_sha256
        or state.get("mask_manifest_sha256") != expected_mask_hashes
        or state.get("item_count") != len(expected_ids)
        or state.get("ids") != expected_ids
        or state.get("id_set_sha256") != HARD_QA.hash_ids(expected_ids, sort_items=True)
        or state.get("ordered_ids_sha256")
        != HARD_QA.hash_ids(expected_ids_in_order, sort_items=False)
        or not isinstance(hard_state, Mapping)
        or hard_state.get("tool") != HARD_QA.QA_TOOL_ID
        or hard_state.get("schema_version") != HARD_QA.SCHEMA_VERSION
        or hard_state.get("max_chapters_per_work") != MAX_CHAPTERS_PER_WORK
        or hard_state.get("global_item_count") != len(expected_global_ids_in_order)
        or hard_state.get("global_id_set_sha256")
        != HARD_QA.hash_ids(expected_global_ids_in_order, sort_items=True)
        or hard_state.get("global_ordered_ids_sha256")
        != HARD_QA.hash_ids(expected_global_ids_in_order, sort_items=False)
        or hard_state.get("shard_algorithm")
        != ("int(sha256('fontclip-qa-shard-v1\\0' + id)[:16],16)%shard_count")
        or not isinstance(validation_scope, Mapping)
        or validation_scope.get("shard_index") != shard_index
        or validation_scope.get("shard_count") != shard_count
        or validation_scope.get("processed_item_count") != len(expected_ids)
        or validation_scope.get("four_shard_union_rehashes_every_processed_asset_once")
        is not True
        or hard_state.get("training_assets_modified") is not False
        or hard_state.get("recrop_coordinate_space") != "source_page_pixels_xyxy"
        or not isinstance(overlay, Mapping)
        or overlay.get("red_used") is not False
    ):
        raise HardAdjudicationError(
            f"{state_path}: audit state is not bound to the current dataset"
        )

    report_sources = report.get("source_signatures")
    report_shard = report.get("shard")
    report_validation = report.get("validation")
    report_contact_sheet = report.get("contact_sheet")
    if (
        report.get("schema_version") != HARD_QA.SCHEMA_VERSION
        or report.get("tool") != HARD_QA.QA_TOOL_ID
        or report.get("ok") is not True
        or report.get("audit_all") is not True
        or report_sources
        != {
            "manifest_sha256": dataset.result.manifest_sha256,
            "rejects_sha256": dataset.result.rejects_sha256,
            "report_sha256": dataset.result.report_sha256,
            "ownership_marker_sha256": dataset.result.marker_sha256,
            "synthetic_provenance_schema_sha256": (
                dataset.result.synthetic_spec_sha256
            ),
        }
        or not isinstance(report_shard, Mapping)
        or report_shard.get("index") != shard_index
        or report_shard.get("count") != shard_count
        or report_shard.get("item_count") != len(expected_ids)
        or report_shard.get("id_set_sha256")
        != HARD_QA.hash_ids(expected_ids, sort_items=True)
        or report_shard.get("algorithm_namespace") != HARD_QA.SHARD_HASH_NAMESPACE
        or not isinstance(report_validation, Mapping)
        or report_validation.get("shard_rows_and_assets_rehashed") is not True
        or report_validation.get("source_crop_pixel_equality_verified") is not True
        or report_validation.get("asset_semantic_dag_verified") is not True
        or report_validation.get("checkpoint_union_verified") is not True
        or report_validation.get("work_split_and_max20_verified") is not True
        or report_validation.get("validated_processed_records") != len(expected_ids)
        or report_validation.get("global_asset_validation_requires_all_shards")
        is not True
        or report_validation.get("diagnostic_overlays_forbidden_in_training_assets")
        is not True
        or not isinstance(report_contact_sheet, Mapping)
        or report_contact_sheet.get("panel_count_per_item") != 16
        or len(report_contact_sheet.get("panels", ())) != 16
        or report.get("error_count") != 0
    ):
        raise HardAdjudicationError(
            f"{report_path}: hard QA report is incomplete or stale"
        )

    journal_name = str(marker.get("journal", "")).strip()
    if not journal_name or Path(journal_name).name != journal_name:
        raise HardAdjudicationError(f"{marker_path}: journal must be a basename")
    journal = (review_dir / journal_name).resolve()
    if (
        not is_within(review_dir, journal)
        or not journal.is_file()
        or sha256_file(journal) != marker.get("journal_sha256")
    ):
        raise HardAdjudicationError(
            f"{marker_path}: completed ledger journal binding is invalid"
        )
    journal_records = RECORDER.load_journal(journal)
    by_sheet = {
        str(record.get("sheet_json", "")).strip(): record for record in journal_records
    }
    if len(by_sheet) != len(journal_records):
        raise HardAdjudicationError(f"{journal}: duplicate journal sheet")
    expected_names = {path.name for path in inventory_paths}
    if set(by_sheet) != expected_names:
        raise HardAdjudicationError(
            f"{journal}: journal does not exactly cover shard inventories"
        )

    state_artifacts = (
        hard_state.get("sheet_artifacts") if isinstance(hard_state, Mapping) else None
    )
    if not isinstance(state_artifacts, list):
        raise HardAdjudicationError(f"{state_path}: missing sheet artifact inventory")
    state_artifacts_by_json = {
        str(artifact.get("json", "")): artifact
        for artifact in state_artifacts
        if isinstance(artifact, Mapping)
    }
    if len(state_artifacts_by_json) != len(state_artifacts):
        raise HardAdjudicationError(
            f"{state_path}: duplicate or invalid sheet artifacts"
        )
    report_artifacts = report.get("sheet_artifacts")
    if not isinstance(report_artifacts, list):
        raise HardAdjudicationError(f"{report_path}: missing sheet artifact inventory")
    report_artifacts_by_json = {
        Path(str(artifact.get("json", ""))).name: artifact
        for artifact in report_artifacts
        if isinstance(artifact, Mapping)
    }
    if len(report_artifacts_by_json) != len(report_artifacts) or set(
        report_artifacts_by_json
    ) != set(state_artifacts_by_json):
        raise HardAdjudicationError(
            f"{report_path}: report/state sheet inventories disagree"
        )

    ledger_rows: list[dict[str, Any]] = []
    decisions: list[ReviewDecision] = []
    ordered_ids: list[str] = []
    frozen_files: dict[str, str] = {
        str(ledger): ledger_sha,
        str(marker_path): sha256_file(marker_path),
        str(state_path): sha256_file(state_path),
        str(report_path): sha256_file(report_path),
        str(journal): sha256_file(journal),
    }
    global_audit_index = 0
    for inventory_path in inventory_paths:
        inventory = RECORDER.parse_sheet_inventory(inventory_path)
        record = by_sheet.get(inventory_path.name)
        if record is None:
            raise HardAdjudicationError(f"{journal}: missing {inventory_path.name}")
        RECORDER.verify_record_against_inventory(record, inventory)
        outer_reviewer = str(record.get("reviewer", "")).strip()
        outer_reviewed_at = str(record.get("reviewed_at", "")).strip()
        if not outer_reviewer or not outer_reviewed_at:
            raise HardAdjudicationError(
                f"{inventory_path}: journal lacks reviewer/timestamp"
            )
        if any(
            str(decision.get("reviewer", "")).strip() != outer_reviewer
            or str(decision.get("reviewed_at", "")).strip() != outer_reviewed_at
            for decision in record["decisions"]
        ):
            raise HardAdjudicationError(
                f"{inventory_path}: cell reviewer/timestamp differs from "
                "the whole-sheet review assertion"
            )
        expected_fingerprint = RECORDER.stable_review_fingerprint(
            inventory,
            outer_reviewer,
            record["decisions"],
        )
        if record.get("review_fingerprint_sha256") != expected_fingerprint:
            raise HardAdjudicationError(
                f"{inventory_path}: review fingerprint mismatch"
            )
        artifact = state_artifacts_by_json.get(inventory_path.name)
        if not isinstance(artifact, Mapping):
            raise HardAdjudicationError(
                f"{state_path}: inventory is absent from signed sheet list"
            )
        if (
            artifact.get("sheet_index") != inventory.sheet_index
            or artifact.get("png") != inventory.png_path.name
            or artifact.get("item_count") != len(inventory.items)
            or artifact.get("png_sha256") != inventory.png_sha256
            or artifact.get("json_sha256") != inventory.json_sha256
            or artifact.get("ordered_ids_sha256") != inventory.ordered_ids_sha256
        ):
            raise HardAdjudicationError(
                f"{state_path}: sheet artifact hash binding is stale"
            )
        report_artifact = report_artifacts_by_json[inventory_path.name]
        if (
            report_artifact.get("png_sha256") != inventory.png_sha256
            or report_artifact.get("json_sha256") != inventory.json_sha256
            or report_artifact.get("ordered_ids_sha256") != inventory.ordered_ids_sha256
            or report_artifact.get("item_count") != len(inventory.items)
        ):
            raise HardAdjudicationError(f"{report_path}: report sheet binding is stale")
        inventory_payload = read_json(inventory_path)
        inventory_items = inventory_payload.get("items")
        if not isinstance(inventory_items, list):
            raise HardAdjudicationError(f"{inventory_path}: items must be an array")
        for position, (inventory_item, raw_decision) in enumerate(
            zip(inventory_items, record["decisions"]),
            1,
        ):
            global_audit_index += 1
            item_id = str(inventory_item.get("id", "")).strip()
            current = dataset.records_by_id.get(item_id)
            if current is None:
                raise HardAdjudicationError(
                    f"{inventory_path}: unknown processed id {item_id!r}"
                )
            expected_inventory = _expected_inventory_item(
                current,
                cell_index=position,
                audit_index=global_audit_index,
            )
            if inventory_item != expected_inventory:
                raise HardAdjudicationError(
                    f"{inventory_path}: cell {position} no longer matches "
                    "the processed manifest/asset hashes"
                )
            ledger_row = {
                "id": item_id,
                "decision": raw_decision.get("decision"),
                "reject_reason": str(raw_decision.get("reject_reason", "")).strip(),
                "recrop_bbox_px": raw_decision.get("recrop_bbox_px"),
                "padding_px": raw_decision.get("padding_px", 0),
                "reviewer": str(raw_decision.get("reviewer", "")).strip(),
                "reviewed_at": str(raw_decision.get("reviewed_at", "")).strip(),
                "notes": str(raw_decision.get("notes", "")).strip(),
                "sheet": inventory.png_path.name,
                "cell_index": raw_decision.get("cell_index"),
            }
            decision = _validate_decision_semantics(
                ledger_row,
                shard_tag=shard_tag,
                sheet=inventory.png_path.name,
                ledger_path=ledger,
                ledger_sha256=ledger_sha,
            )
            decisions.append(decision)
            ledger_rows.append(ledger_row)
            ordered_ids.append(item_id)
        frozen_files[str(inventory_path)] = inventory.json_sha256
        frozen_files[str(inventory.png_path)] = inventory.png_sha256
    if global_audit_index != len(expected_ids_in_order):
        raise HardAdjudicationError(
            f"{state_path}: sheet cells do not match shard item count"
        )
    if ordered_ids != expected_ids_in_order:
        raise HardAdjudicationError(
            f"{state_path}: ledger order does not match audit state order"
        )
    expected_ledger = RECORDER.ledger_csv_bytes(ledger_rows)
    if ledger.read_bytes() != expected_ledger:
        raise HardAdjudicationError(
            f"{ledger}: CSV is not the exact finalized journal projection"
        )
    if (
        marker.get("sheet_count") != len(inventory_paths)
        or marker.get("item_count") != len(ordered_ids)
        or marker.get("ordered_ids_sha256")
        != RECORDER.hash_id_list(ordered_ids, sort_items=False)
    ):
        raise HardAdjudicationError(
            f"{marker_path}: completion counts/order are invalid"
        )
    binding = {
        "shard_index": shard_index,
        "shard_count": shard_count,
        "shard_tag": shard_tag,
        "qa_dir": str(qa_dir),
        "review_dir": str(review_dir),
        "state": str(state_path),
        "state_sha256": frozen_files[str(state_path)],
        "qa_report": str(report_path),
        "qa_report_sha256": frozen_files[str(report_path)],
        "ledger": str(ledger),
        "ledger_sha256": ledger_sha,
        "completion_marker": str(marker_path),
        "completion_marker_sha256": frozen_files[str(marker_path)],
        "journal": str(journal),
        "journal_sha256": frozen_files[str(journal)],
        "item_count": len(ordered_ids),
        "id_set_sha256": HARD_QA.hash_ids(ordered_ids, sort_items=True),
        "ordered_ids_sha256": HARD_QA.hash_ids(
            ordered_ids,
            sort_items=False,
        ),
        "decision_counts": dict(
            sorted(Counter(item.decision for item in decisions).items())
        ),
        "sheet_artifact_count": len(inventory_paths),
    }
    return shard_index, shard_tag, decisions, binding, frozen_files


def validate_audit_bundle(
    ledgers: Sequence[Path],
    *,
    dataset: ValidatedDataset,
) -> AuditBundle:
    if len(ledgers) != REQUIRED_AUDIT_SHARDS:
        raise HardAdjudicationError(
            f"exactly {REQUIRED_AUDIT_SHARDS} completed ledgers are required"
        )
    decisions: dict[str, ReviewDecision] = {}
    shard_bindings: dict[int, dict[str, Any]] = {}
    frozen_files: dict[str, str] = {}
    for ledger in ledgers:
        (
            shard_index,
            _shard_tag,
            shard_decisions,
            binding,
            shard_files,
        ) = _validate_one_shard(ledger, dataset=dataset)
        if shard_index in shard_bindings:
            raise HardAdjudicationError(
                f"audit shard {shard_index} was supplied more than once"
            )
        shard_bindings[shard_index] = binding
        for decision in shard_decisions:
            if decision.item_id in decisions:
                raise HardAdjudicationError(
                    f"processed id was reviewed more than once: {decision.item_id}"
                )
            decisions[decision.item_id] = decision
        for path, digest in shard_files.items():
            previous = frozen_files.setdefault(path, digest)
            if previous != digest:
                raise HardAdjudicationError(
                    f"review artifact has conflicting hashes: {path}"
                )
    if set(shard_bindings) != set(range(REQUIRED_AUDIT_SHARDS)):
        raise HardAdjudicationError(
            "review ledgers do not contain shards 0, 1, 2, and 3 exactly once"
        )
    expected_ids = set(dataset.records_by_id)
    actual_ids = set(decisions)
    if actual_ids != expected_ids or len(decisions) != len(expected_ids):
        missing = sorted(expected_ids - actual_ids)
        extra = sorted(actual_ids - expected_ids)
        raise HardAdjudicationError(
            "four-shard decisions do not cover every processed ID exactly once: "
            f"missing={missing[:8]}, extra={extra[:8]}"
        )
    binding = {
        "shard_count": REQUIRED_AUDIT_SHARDS,
        "dataset_manifest_sha256": dataset.result.manifest_sha256,
        "global_item_count": len(expected_ids),
        "global_id_set_sha256": HARD_QA.hash_ids(
            expected_ids,
            sort_items=True,
        ),
        "decision_counts": dict(
            sorted(Counter(item.decision for item in decisions.values()).items())
        ),
        "shards": [shard_bindings[index] for index in sorted(shard_bindings)],
        "frozen_file_count": len(frozen_files),
        "frozen_files_sha256": sha256_json(frozen_files),
    }
    return AuditBundle(
        decisions=decisions,
        binding=binding,
        frozen_files=frozen_files,
    )


def verify_frozen_files(files: Mapping[str, str]) -> None:
    for path_value, expected in sorted(files.items()):
        path = Path(path_value).resolve()
        if not path.is_file() or sha256_file(path) != expected:
            raise HardAdjudicationError(
                f"signed review artifact changed during adjudication: {path}"
            )


def verify_source_page_bindings(
    records: Sequence[Mapping[str, Any]],
    *,
    library_root: Path,
) -> int:
    bindings: dict[str, str] = {}
    for record in records:
        relative = safe_relative(
            record.get("source_image_path"),
            "source_image_path",
        ).as_posix()
        digest = record.get("source_page_sha256")
        if not isinstance(digest, str) or not HEX_SHA256.fullmatch(digest):
            raise HardAdjudicationError(f"{relative}: invalid source page SHA-256")
        previous = bindings.setdefault(relative, digest)
        if previous != digest:
            raise HardAdjudicationError(
                f"{relative}: conflicting source page signatures"
            )
    for relative, expected in sorted(bindings.items()):
        path = resolve_inside(
            library_root,
            relative,
            "signed source page",
        )
        if not path.is_file() or sha256_file(path) != expected:
            raise HardAdjudicationError(
                f"signed source page changed before commit: {path}"
            )
    return len(bindings)


def decision_record(
    decision: ReviewDecision,
    source_record: Mapping[str, Any],
    *,
    repair_candidate_id: str | None,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "id": decision.item_id,
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
        "source_record_sha256": sha256_json(source_record),
        "root_real_id": source_record.get("root_real_id"),
        "work_id": source_record.get("work_id"),
        "chapter_id": source_record.get("chapter_id"),
        "page_id": source_record.get("page_id"),
        "split": source_record.get("split"),
        "repair_candidate_id": repair_candidate_id,
        "coordinate_space": "source_page_pixels_xyxy",
        "synthetic": False,
    }


def _source_page(
    record: Mapping[str, Any],
    *,
    library_root: Path,
) -> tuple[Path, bytes, Image.Image]:
    relative = safe_relative(
        record.get("source_image_path"),
        "source_image_path",
    )
    work_id = safe_component(record.get("work_id"), "work_id")
    chapter_id = safe_component(record.get("chapter_id"), "chapter_id")
    if (
        len(relative.parts) != 6
        or relative.parts[0] != "works"
        or relative.parts[1] != work_id
        or relative.parts[2] != "chapters"
        or relative.parts[3] != chapter_id
        or relative.parts[4] != "pages"
    ):
        raise HardAdjudicationError(
            "source image is not an original works/<work>/chapters/"
            "<chapter>/pages image"
        )
    path = library_root.joinpath(*relative.parts).resolve()
    page_root = (
        library_root / "works" / work_id / "chapters" / chapter_id / "pages"
    ).resolve()
    if not is_within(page_root, path) or path.parent != page_root or not path.is_file():
        raise HardAdjudicationError(
            f"source image escapes the immutable pages directory: {path}"
        )
    payload = path.read_bytes()
    expected = record.get("source_page_sha256")
    if not isinstance(expected, str) or sha256_bytes(payload) != expected:
        raise HardAdjudicationError(f"signed original source page changed: {path}")
    try:
        with Image.open(io.BytesIO(payload)) as opened:
            page = ImageOps.exif_transpose(opened).convert("RGB")
            page.load()
    except (OSError, UnidentifiedImageError) as error:
        raise HardAdjudicationError(
            f"cannot decode original source page: {path}"
        ) from error
    return path, payload, page


def _repair_candidate_id(
    source_record: Mapping[str, Any],
    decision: ReviewDecision,
) -> str:
    identity = {
        "parent_processed_id": decision.item_id,
        "parent_processed_record_sha256": sha256_json(source_record),
        "source_page_sha256": source_record.get("source_page_sha256"),
        "bbox_px": list(decision.recrop_bbox_px or ()),
        "padding_px": decision.padding_px,
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "algorithm_version": "manual-recrop-v1",
        "provenance": "real_manual_recrop",
    }
    return "fhcr_" + sha256_json(identity)[:24]


def build_repair_candidate(
    source_record: Mapping[str, Any],
    decision: ReviewDecision,
    *,
    queue_physical_root: Path | None,
    queue_declared_root: Path,
    library_root: Path,
    write_assets: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if decision.decision != "recrop" or decision.recrop_bbox_px is None:
        raise HardAdjudicationError(
            f"{decision.item_id}: not a materializable recrop decision"
        )
    orientation = source_record.get("orientation")
    if orientation not in {"horizontal", "vertical"}:
        raise HardAdjudicationError(
            f"{decision.item_id}: parent processed orientation must be "
            f"'horizontal' or 'vertical', got {orientation!r}"
        )
    _source_path, source_bytes, page = _source_page(
        source_record,
        library_root=library_root,
    )
    try:
        page_size = (page.width, page.height)
        bbox = parse_bbox(
            decision.recrop_bbox_px,
            f"{decision.item_id} recrop bbox",
            page_size=page_size,
        )
        x1, y1, x2, y2 = bbox
        padding = decision.padding_px
        crop_bbox = (
            max(0, x1 - padding),
            max(0, y1 - padding),
            min(page.width, x2 + padding),
            min(page.height, y2 + padding),
        )
        current_bbox = parse_bbox(
            source_record.get("bbox_px"),
            f"{decision.item_id} current bbox",
            page_size=page_size,
        )
        current_crop = parse_bbox(
            source_record.get("source_crop_bbox_px")
            or source_record.get("crop_bbox_px"),
            f"{decision.item_id} current crop bbox",
            page_size=page_size,
        )
        if bbox == current_bbox and crop_bbox == current_crop:
            raise HardAdjudicationError(f"{decision.item_id}: recrop is a no-op")
        crop = page.crop(crop_bbox).convert("RGB")
        candidate_id = _repair_candidate_id(source_record, decision)
        split = safe_component(source_record.get("split"), "split")
        if split not in ALLOWED_SPLITS:
            raise HardAdjudicationError(
                f"{decision.item_id}: unsupported split {split!r}"
            )
        raw_relative = f"images/raw/{split}/{candidate_id}.png"
        clip_relative = f"images/clip_224/{split}/{candidate_id}.png"
        raw_bytes = encode_png(crop)
        clip = letterbox_rgb(crop)
        try:
            clip_bytes = encode_png(clip)
        finally:
            clip.close()
        if write_assets:
            if queue_physical_root is None:
                raise HardAdjudicationError(
                    "queue_physical_root is required when writing repair assets"
                )
            atomic_write_bytes(
                queue_physical_root / PurePosixPath(raw_relative),
                raw_bytes,
            )
            atomic_write_bytes(
                queue_physical_root / PurePosixPath(clip_relative),
                clip_bytes,
            )
        metadata = source_record.get("candidate_metadata")
        if not isinstance(metadata, Mapping):
            raise HardAdjudicationError(
                f"{decision.item_id}: candidate metadata is missing"
            )
        categories_value = metadata.get("categories")
        if not isinstance(categories_value, list) or not categories_value:
            raise HardAdjudicationError(
                f"{decision.item_id}: hard categories are missing"
            )
        categories = sorted(
            {str(value) for value in categories_value},
            key=lambda value: (
                HARD_CATEGORY_PRIORITY.get(value, 999),
                value,
            ),
        )
        if any(value not in HARD_CATEGORY_PRIORITY for value in categories):
            raise HardAdjudicationError(
                f"{decision.item_id}: unsupported hard category"
            )
        original_evidence = metadata.get("candidate_evidence")
        evidence = (
            [dict(value) for value in original_evidence if isinstance(value, Mapping)]
            if isinstance(original_evidence, list)
            else []
        )
        evidence.append(
            {
                "source": "exhaustive_visual_review_manual_recrop",
                "parent_processed_id": decision.item_id,
                "parent_processed_record_sha256": sha256_json(source_record),
                "review_ledger_sha256": decision.ledger_sha256,
                "source_page_bbox_px": list(bbox),
                "padding_px": padding,
                "diagnostic_overlay_written": False,
            }
        )
        source_relative = PurePosixPath(
            str(source_record["source_image_path"]).replace("\\", "/")
        ).as_posix()
        page_name = source_record.get("page_name") or Path(source_relative).name
        declared_size = source_record.get("declared_page_size_px")
        candidate = {
            "schema_version": SCHEMA_VERSION,
            "id": candidate_id,
            "image_path": raw_relative,
            "clip_image_path": clip_relative,
            "asset_file_sha256": {
                "image_path": sha256_bytes(raw_bytes),
                "clip_image_path": sha256_bytes(clip_bytes),
            },
            "source_image_path": source_relative,
            "source_page_sha256": sha256_bytes(source_bytes),
            "source_page_content_signature": {
                "sha256": sha256_bytes(source_bytes),
                "size": len(source_bytes),
                "width": page.width,
                "height": page.height,
            },
            "work_id": source_record.get("work_id"),
            "work_title": source_record.get("work_title"),
            "chapter_id": source_record.get("chapter_id"),
            "chapter_title": source_record.get("chapter_title"),
            "page_id": source_record.get("page_id"),
            "page_name": page_name,
            "page_size_px": [page.width, page.height],
            "declared_page_size_px": (
                declared_size
                if isinstance(declared_size, list)
                else [page.width, page.height]
            ),
            "source_dimension_mismatch": bool(
                source_record.get("source_dimension_mismatch", False)
            ),
            "split": split,
            "tier": "hard_candidate",
            "provenance": "real_mined",
            "primary_category": categories[0],
            "categories": categories,
            "candidate_score": metadata.get("candidate_score", 1.0),
            "candidate_evidence": evidence,
            "candidate_source_ids": [
                decision.item_id,
                candidate_id,
            ],
            "bbox_px": list(bbox),
            "crop_bbox_px": list(crop_bbox),
            "crop_size_px": [crop.width, crop.height],
            "crop_sha256": pixel_sha256(crop),
            "orientation": orientation,
            "ocr_text": metadata.get("ocr_text") or "",
            "ocr_hints_sha256": source_record.get("ocr_hints_sha256"),
            "ocr_coordinate_provenance": {
                "coordinate_space": "actual_source_pixels",
                "manual_recrop": True,
            },
            "ocr_metadata_skip_reasons": source_record.get(
                "ocr_metadata_skip_reasons",
                {},
            ),
            "detector_model": metadata.get("detector_model"),
            "selection_segment_index": source_record.get(
                "selection_segment_index",
                0,
            ),
            "work_balance_weight": source_record.get(
                "work_balance_weight",
                1.0,
            ),
            "chapter_balance_weight": source_record.get(
                "chapter_balance_weight",
                1.0,
            ),
            "root_real_id": source_record.get("root_real_id"),
            "manual_recrop": {
                "tool": TOOL_ID,
                "schema_version": SCHEMA_VERSION,
                "parent_processed_id": decision.item_id,
                "supersedes_id": decision.item_id,
                "parent_processed_record_sha256": sha256_json(source_record),
                "review_ledger": decision.ledger_path,
                "review_ledger_sha256": decision.ledger_sha256,
                "reviewer": decision.reviewer,
                "reviewed_at": decision.reviewed_at,
                "notes": decision.notes,
                "coordinate_space": "source_page_pixels_xyxy",
                "bbox_px": list(bbox),
                "padding_px": padding,
                "crop_bbox_px": list(crop_bbox),
                "crop_sha256": pixel_sha256(crop),
                "diagnostic_overlay_written": False,
                "synthetic": False,
            },
            "label": None,
        }
        lineage = {
            "schema_version": SCHEMA_VERSION,
            "parent_processed_id": decision.item_id,
            "parent_processed_record_sha256": sha256_json(source_record),
            "repair_candidate_id": candidate_id,
            "repair_candidate_record_sha256": sha256_json(candidate),
            "root_real_id": source_record.get("root_real_id"),
            "source_image_path": source_relative,
            "source_page_sha256": sha256_bytes(source_bytes),
            "bbox_px": list(bbox),
            "padding_px": padding,
            "crop_bbox_px": list(crop_bbox),
            "crop_sha256": pixel_sha256(crop),
            "queue_root": str(queue_declared_root),
            "review": {
                "ledger": decision.ledger_path,
                "ledger_sha256": decision.ledger_sha256,
                "reviewer": decision.reviewer,
                "reviewed_at": decision.reviewed_at,
                "sheet": decision.sheet,
                "cell_index": decision.cell_index,
                "notes": decision.notes,
            },
            "provenance": "real_manual_recrop",
            "synthetic": False,
            "accepted": False,
            "acceptance_gate": "pending_postprocess_and_exhaustive_recheck",
        }
        crop.close()
        return candidate, lineage
    finally:
        page.close()


def write_repair_queue_contract(
    *,
    queue_physical_root: Path,
    queue_declared_root: Path,
    library_root: Path,
    candidates: Sequence[Mapping[str, Any]],
    preparation_signature_sha256: str,
) -> dict[str, Any]:
    manifest_path = queue_physical_root / "manifest.jsonl"
    atomic_write_bytes(manifest_path, jsonl_bytes(candidates))
    manifest_sha = sha256_file(manifest_path)
    category_counts = Counter(
        str(category) for row in candidates for category in row.get("categories", ())
    )
    split_counts = Counter(str(row.get("split")) for row in candidates)
    signature = {
        "library_root": str(library_root),
        "configuration": {"max_chapters_per_work": MAX_CHAPTERS_PER_WORK},
        "manifest_sha256": manifest_sha,
        "producer": {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "phase": "manual_recrop_repair_queue",
            "preparation_signature_sha256": preparation_signature_sha256,
            "source_geometry": "source_page_pixels_xyxy",
            "synthetic": False,
        },
    }
    marker = {
        "tool": "manga-translator-fontclip-hard-candidates",
        "schema_version": SCHEMA_VERSION,
        "output_root": str(queue_declared_root),
        "owned_outputs": REPAIR_QUEUE_OWNED_OUTPUTS,
        "signature": signature,
        "signature_sha256": sha256_json(signature),
    }
    report = {
        "tool": "manga-translator-fontclip-hard-candidates",
        "schema_version": SCHEMA_VERSION,
        "run_signature_sha256": marker["signature_sha256"],
        "candidate_records": len(candidates),
        "unique_crop_sha256": len({str(row.get("crop_sha256")) for row in candidates}),
        "category_memberships": dict(sorted(category_counts.items())),
        "by_split": dict(sorted(split_counts.items())),
        "configuration": {"max_chapters_per_work": MAX_CHAPTERS_PER_WORK},
        "output_root": str(queue_declared_root),
        "library_root": str(library_root),
        "producer": {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "real_page_recrops_only": True,
            "synthetic_assets": 0,
            "diagnostic_overlays": 0,
        },
    }
    marker_path = queue_physical_root / ".fontclip-hard-candidates.json"
    report_path = queue_physical_root / "report.json"
    atomic_write_bytes(marker_path, json_bytes(marker))
    atomic_write_bytes(report_path, json_bytes(report))
    return {
        "root": str(queue_declared_root),
        "manifest": str(queue_declared_root / "manifest.jsonl"),
        "manifest_sha256": manifest_sha,
        "marker": str(queue_declared_root / ".fontclip-hard-candidates.json"),
        "marker_sha256": sha256_file(marker_path),
        "report": str(queue_declared_root / "report.json"),
        "report_sha256": sha256_file(report_path),
        "candidate_records": len(candidates),
        "candidate_id_set_sha256": HARD_QA.hash_ids(
            [str(row["id"]) for row in candidates],
            sort_items=True,
        ),
        "unique_crop_sha256": report["unique_crop_sha256"],
    }


def _owned_output_marker(path: Path, expected_tool: str) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    marker = read_json(path)
    if (
        marker.get("tool") != expected_tool
        or marker.get("schema_version") != SCHEMA_VERSION
    ):
        raise HardAdjudicationError(f"unrecognized ownership marker: {path}")
    return marker


def _new_staging(output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.parent / f".{output.name}.staging-{uuid.uuid4().hex}"
    if staging.exists():
        raise RuntimeError(f"unexpected staging collision: {staging}")
    staging.mkdir()
    return staging


def _is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or (
        hasattr(path, "is_junction") and bool(path.is_junction())
    )


def _regular_file_inventory(root: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    for current_text, directory_names, file_names in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        current = Path(current_text)
        if _is_link_or_junction(current):
            raise HardAdjudicationError(
                f"owned output contains a linked directory: {current}"
            )
        for name in list(directory_names):
            child = current / name
            if _is_link_or_junction(child):
                raise HardAdjudicationError(
                    f"owned output contains a linked directory: {child}"
                )
            if not is_within(root, child):
                raise HardAdjudicationError(
                    f"owned output directory escapes its root: {child}"
                )
            directories.add(child.relative_to(root).as_posix())
        for name in file_names:
            child = current / name
            if _is_link_or_junction(child) or not child.is_file():
                raise HardAdjudicationError(
                    f"owned output contains a non-regular file: {child}"
                )
            if not is_within(root, child):
                raise HardAdjudicationError(
                    f"owned output file escapes its root: {child}"
                )
            relative = child.relative_to(root).as_posix()
            if relative in files:
                raise HardAdjudicationError(
                    f"owned output has a duplicate file path: {relative}"
                )
            files.add(relative)
    return files, directories


def _validate_owned_output_inventory(
    physical_root: Path,
    *,
    declared_root: Path,
    marker_name: str,
    expected_tool: str,
) -> dict[str, Any]:
    marker_path = physical_root / marker_name
    marker = _owned_output_marker(marker_path, expected_tool)
    expected_phase = "prepared" if marker_name == PREP_MARKER_NAME else "finalized"
    expected_owned = (
        [
            INITIAL_DECISIONS_NAME,
            INITIAL_REJECTS_NAME,
            RECROP_LINEAGE_NAME,
            PREP_REPORT_NAME,
            REPAIR_QUEUE_NAME,
        ]
        if expected_phase == "prepared"
        else [
            "images",
            FINAL_MANIFEST_NAME,
            FINAL_REJECTS_NAME,
            FINAL_LINEAGE_NAME,
            FINAL_REPORT_NAME,
            FINAL_POLICY_NAME,
        ]
    )
    if (
        marker is None
        or marker.get("phase") != expected_phase
        or marker.get("completed") is not True
        or marker.get("output_root") != str(declared_root)
        or marker.get("owned_outputs") != expected_owned
    ):
        raise HardAdjudicationError(
            f"refusing overwrite without an exact {expected_phase} "
            f"ownership contract: {physical_root}"
        )
    outputs = marker.get("outputs")
    if not isinstance(outputs, Mapping):
        raise HardAdjudicationError(
            f"{marker_path}: ownership marker lacks output hashes"
        )
    required_outputs = (
        {
            INITIAL_DECISIONS_NAME,
            INITIAL_REJECTS_NAME,
            RECROP_LINEAGE_NAME,
            PREP_REPORT_NAME,
            f"{REPAIR_QUEUE_NAME}/manifest.jsonl",
            f"{REPAIR_QUEUE_NAME}/.fontclip-hard-candidates.json",
            f"{REPAIR_QUEUE_NAME}/report.json",
        }
        if expected_phase == "prepared"
        else {
            FINAL_MANIFEST_NAME,
            FINAL_REJECTS_NAME,
            FINAL_LINEAGE_NAME,
            FINAL_REPORT_NAME,
            FINAL_POLICY_NAME,
        }
    )
    if set(outputs) != required_outputs:
        raise HardAdjudicationError(
            f"{marker_path}: signed output inventory is incomplete"
        )
    expected_files = {marker_name, *required_outputs}
    for relative, expected_hash in outputs.items():
        path = resolve_inside(
            physical_root,
            relative,
            "owned signed output",
        )
        if (
            not isinstance(expected_hash, str)
            or not HEX_SHA256.fullmatch(expected_hash)
            or not path.is_file()
            or sha256_file(path) != expected_hash
        ):
            raise HardAdjudicationError(f"owned signed output changed: {path}")

    if expected_phase == "prepared":
        queue_manifest = physical_root / REPAIR_QUEUE_NAME / FINAL_MANIFEST_NAME
        queue_rows = read_jsonl(queue_manifest)
        queue_marker = read_json(
            physical_root / REPAIR_QUEUE_NAME / ".fontclip-hard-candidates.json"
        )
        queue_report = read_json(physical_root / REPAIR_QUEUE_NAME / "report.json")
        queue_signature = queue_marker.get("signature")
        if (
            queue_marker.get("tool") != "manga-translator-fontclip-hard-candidates"
            or queue_marker.get("output_root") != str(declared_root / REPAIR_QUEUE_NAME)
            or queue_marker.get("owned_outputs") != REPAIR_QUEUE_OWNED_OUTPUTS
            or not isinstance(queue_signature, Mapping)
            or queue_marker.get("signature_sha256") != sha256_json(queue_signature)
            or queue_signature.get("manifest_sha256")
            != outputs[f"{REPAIR_QUEUE_NAME}/manifest.jsonl"]
            or queue_report.get("run_signature_sha256")
            != queue_marker.get("signature_sha256")
            or queue_report.get("candidate_records") != len(queue_rows)
        ):
            raise HardAdjudicationError(
                "owned repair queue marker/report contract is invalid"
            )
        for row in queue_rows:
            candidate_id = safe_component(
                row.get("id"),
                "owned repair candidate id",
            )
            split = safe_component(
                row.get("split"),
                "owned repair split",
            )
            if split not in ALLOWED_SPLITS:
                raise HardAdjudicationError(
                    f"{candidate_id}: invalid owned repair split"
                )
            asset_hashes = row.get("asset_file_sha256")
            if not isinstance(asset_hashes, Mapping):
                raise HardAdjudicationError(
                    "owned repair queue candidate lacks asset hashes"
                )
            for key in ("image_path", "clip_image_path"):
                expected_candidate_path = (
                    f"images/raw/{split}/{candidate_id}.png"
                    if key == "image_path"
                    else f"images/clip_224/{split}/{candidate_id}.png"
                )
                if row.get(key) != expected_candidate_path:
                    raise HardAdjudicationError(
                        f"{candidate_id}: owned repair {key} is not canonical"
                    )
                relative = (
                    PurePosixPath(REPAIR_QUEUE_NAME)
                    / safe_relative(row.get(key), f"repair {key}")
                ).as_posix()
                if relative in expected_files:
                    raise HardAdjudicationError(
                        f"duplicate owned repair asset path: {relative}"
                    )
                expected_files.add(relative)
                asset = resolve_inside(
                    physical_root,
                    relative,
                    f"owned repair {key}",
                )
                expected_hash = asset_hashes.get(key)
                if (
                    not isinstance(expected_hash, str)
                    or not HEX_SHA256.fullmatch(expected_hash)
                    or not asset.is_file()
                    or sha256_file(asset) != expected_hash
                ):
                    raise HardAdjudicationError(f"owned repair asset changed: {asset}")
    else:
        final_rows = read_jsonl(physical_root / FINAL_MANIFEST_NAME)
        _validate_final_population(final_rows)
        for row in final_rows:
            assets = row.get("assets")
            if not isinstance(assets, Mapping):
                raise HardAdjudicationError(
                    "owned final record lacks its asset inventory"
                )
            for descriptor in assets.values():
                if not isinstance(descriptor, Mapping):
                    raise HardAdjudicationError(
                        "owned final record has an invalid asset descriptor"
                    )
                relative = safe_relative(
                    descriptor.get("path"),
                    "owned final asset path",
                ).as_posix()
                if relative in expected_files:
                    raise HardAdjudicationError(
                        f"duplicate owned final asset path: {relative}"
                    )
                expected_files.add(relative)
                asset = resolve_inside(
                    physical_root,
                    relative,
                    "owned final asset",
                )
                expected_hash = descriptor.get("file_sha256")
                if (
                    not isinstance(expected_hash, str)
                    or not HEX_SHA256.fullmatch(expected_hash)
                    or not asset.is_file()
                    or sha256_file(asset) != expected_hash
                ):
                    raise HardAdjudicationError(f"owned final asset changed: {asset}")
    actual_files, actual_directories = _regular_file_inventory(physical_root)
    expected_directories = {
        parent.as_posix()
        for relative in expected_files
        for parent in PurePosixPath(relative).parents
        if parent.as_posix() != "."
    }
    if actual_files != expected_files or actual_directories != expected_directories:
        unknown = sorted(actual_files - expected_files)
        missing = sorted(expected_files - actual_files)
        unknown_directories = sorted(actual_directories - expected_directories)
        missing_directories = sorted(expected_directories - actual_directories)
        raise HardAdjudicationError(
            "refusing overwrite because the target contains unknown or "
            "missing files/directories: "
            f"unknown={unknown[:8]}, missing={missing[:8]}, "
            f"unknown_dirs={unknown_directories[:8]}, "
            f"missing_dirs={missing_directories[:8]}"
        )
    return marker


def _commit_directory(
    staging: Path,
    output: Path,
    *,
    marker_name: str,
    expected_tool: str,
    overwrite: bool,
) -> Path | None:
    backup: Path | None = None
    if output.exists():
        if not overwrite:
            raise FileExistsError(f"output already exists: {output}; use --overwrite")
        if not output.is_dir():
            raise HardAdjudicationError(
                f"output exists and is not a directory: {output}"
            )
        _validate_owned_output_inventory(
            output,
            declared_root=output,
            marker_name=marker_name,
            expected_tool=expected_tool,
        )
    _validate_owned_output_inventory(
        staging,
        declared_root=output,
        marker_name=marker_name,
        expected_tool=expected_tool,
    )
    if output.exists():
        backup = output.parent / f".{output.name}.backup-{uuid.uuid4().hex}"
        output.replace(backup)
        try:
            _validate_owned_output_inventory(
                backup,
                declared_root=output,
                marker_name=marker_name,
                expected_tool=expected_tool,
            )
        except BaseException:
            if not output.exists() and backup.exists():
                backup.replace(output)
            raise
    try:
        staging.replace(output)
    except BaseException:
        if backup is not None and backup.exists() and not output.exists():
            backup.replace(output)
        raise
    try:
        _validate_owned_output_inventory(
            output,
            declared_root=output,
            marker_name=marker_name,
            expected_tool=expected_tool,
        )
    except BaseException:
        if output.exists() and not staging.exists():
            output.replace(staging)
        if backup is not None and backup.exists() and not output.exists():
            backup.replace(output)
        raise
    if backup is not None:
        try:
            _validate_owned_output_inventory(
                backup,
                declared_root=output,
                marker_name=marker_name,
                expected_tool=expected_tool,
            )
        except BaseException:
            if output.exists() and not staging.exists():
                output.replace(staging)
            if backup.exists() and not output.exists():
                backup.replace(output)
            raise
        # Keep the replaced tree recoverable.  Deleting it after validation
        # would reopen an unavoidable validation-to-recursive-delete race in
        # which an unrelated late file could be destroyed.
    return backup


def _preflight_output_destination(
    output: Path,
    *,
    marker_name: str,
    expected_tool: str,
    overwrite: bool,
) -> None:
    """Fail before expensive staging work while retaining commit-time checks."""

    if not output.exists():
        return
    if not overwrite:
        raise FileExistsError(f"output already exists: {output}; use --overwrite")
    if not output.is_dir():
        raise HardAdjudicationError(f"output exists and is not a directory: {output}")
    _validate_owned_output_inventory(
        output,
        declared_root=output,
        marker_name=marker_name,
        expected_tool=expected_tool,
    )


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    dataset = validate_processed_dataset(args.dataset, args.library_root)
    output = validate_output_root(
        args.output_root,
        protected=(
            ("--dataset", dataset.root),
            ("--library-root", dataset.library_root),
        ),
    )
    repair_processed_root = validate_output_root(
        args.repair_processed_root,
        protected=(
            ("--dataset", dataset.root),
            ("--library-root", dataset.library_root),
            ("--output-root", output),
        ),
    )
    _preflight_output_destination(
        output,
        marker_name=PREP_MARKER_NAME,
        expected_tool=TOOL_ID,
        overwrite=bool(args.overwrite),
    )
    audit = validate_audit_bundle(args.ledger, dataset=dataset)
    preparation_signature = {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "phase": "prepare",
        "dataset": dataset.binding,
        "initial_audit": audit.binding,
        "output_root": str(output),
        "repair_processed_root": str(repair_processed_root),
        "configuration": {
            "required_audit_shards": REQUIRED_AUDIT_SHARDS,
            "max_chapters_per_work": MAX_CHAPTERS_PER_WORK,
            "recrop_coordinate_space": "source_page_pixels_xyxy",
            "successor_requires_exhaustive_recheck": True,
            "synthetic_forbidden": True,
        },
    }
    preparation_signature_sha = sha256_json(preparation_signature)
    staging = _new_staging(output)
    try:
        queue_physical = staging / REPAIR_QUEUE_NAME
        queue_declared = output / REPAIR_QUEUE_NAME
        queue_physical.mkdir()
        decision_rows: list[dict[str, Any]] = []
        rejected_rows: list[dict[str, Any]] = []
        repair_candidates: list[dict[str, Any]] = []
        repair_lineage: list[dict[str, Any]] = []
        seen_crop_hashes: set[str] = set()
        ordered_records = sorted(
            dataset.result.records,
            key=HARD_QA.record_order_key,
        )
        for source_record in ordered_records:
            item_id = str(source_record["id"])
            decision = audit.decisions[item_id]
            repair_id = (
                _repair_candidate_id(source_record, decision)
                if decision.decision == "recrop"
                else None
            )
            decision_rows.append(
                decision_record(
                    decision,
                    source_record,
                    repair_candidate_id=repair_id,
                )
            )
            if decision.decision == "reject":
                rejected_rows.append(
                    {
                        **decision_rows[-1],
                        "stage": "initial_exhaustive_review",
                        "provenance": "real_processed",
                        "accepted": False,
                    }
                )
            elif decision.decision == "recrop":
                candidate, lineage = build_repair_candidate(
                    source_record,
                    decision,
                    queue_physical_root=queue_physical,
                    queue_declared_root=queue_declared,
                    library_root=dataset.library_root,
                )
                if candidate["id"] != repair_id:
                    raise RuntimeError("repair candidate identity drift")
                crop_hash = str(candidate["crop_sha256"])
                if crop_hash in seen_crop_hashes:
                    raise HardAdjudicationError(
                        f"{item_id}: manual recrop duplicates another repair crop"
                    )
                seen_crop_hashes.add(crop_hash)
                repair_candidates.append(candidate)
                repair_lineage.append(lineage)
        repair_candidates.sort(
            key=lambda row: (
                str(row.get("work_id", "")).casefold(),
                str(row.get("chapter_id", "")).casefold(),
                str(row.get("source_image_path", "")).casefold(),
                tuple(row.get("bbox_px", ())),
                str(row.get("id", "")),
            )
        )
        repair_lineage.sort(key=lambda row: str(row["repair_candidate_id"]))
        queue_binding = write_repair_queue_contract(
            queue_physical_root=queue_physical,
            queue_declared_root=queue_declared,
            library_root=dataset.library_root,
            candidates=repair_candidates,
            preparation_signature_sha256=preparation_signature_sha,
        )
        atomic_write_bytes(
            staging / INITIAL_DECISIONS_NAME,
            jsonl_bytes(decision_rows),
        )
        atomic_write_bytes(
            staging / INITIAL_REJECTS_NAME,
            jsonl_bytes(rejected_rows),
        )
        atomic_write_bytes(
            staging / RECROP_LINEAGE_NAME,
            jsonl_bytes(repair_lineage),
        )
        counts = Counter(row["decision"] for row in decision_rows)
        postprocess_command = (
            "python scripts/postprocess_fontclip_hard_candidates.py "
            f'--input-root "{queue_declared}" '
            f'--library-root "{dataset.library_root}" '
            f'--output-root "{repair_processed_root}" '
            "--expected-input-manifest-sha256 "
            f"{queue_binding['manifest_sha256']} "
            "--verify-ctd-model-hash "
            f"--minimum-input-candidates {len(repair_candidates)} "
            "--minimum-processed-records 0"
        )
        report = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "phase": "prepared",
            "completed": True,
            "output_root": str(output),
            "prepared_at": utc_now(),
            "preparation_signature": preparation_signature,
            "preparation_signature_sha256": preparation_signature_sha,
            "decision_counts": dict(sorted(counts.items())),
            "processed_input_records": len(dataset.records_by_id),
            "all_processed_ids_decided_exactly_once": True,
            "repair_queue": queue_binding,
            "repair_successors_accepted": 0,
            "successor_acceptance_gate": (
                "ordinary hard postprocess plus a second completed exhaustive "
                "four-shard visual review"
            ),
            "postprocess_command": postprocess_command,
            "synthetic_assets": 0,
            "diagnostic_overlays_written": 0,
        }
        atomic_write_bytes(staging / PREP_REPORT_NAME, json_bytes(report))
        outputs = {
            INITIAL_DECISIONS_NAME: sha256_file(staging / INITIAL_DECISIONS_NAME),
            INITIAL_REJECTS_NAME: sha256_file(staging / INITIAL_REJECTS_NAME),
            RECROP_LINEAGE_NAME: sha256_file(staging / RECROP_LINEAGE_NAME),
            PREP_REPORT_NAME: sha256_file(staging / PREP_REPORT_NAME),
            f"{REPAIR_QUEUE_NAME}/manifest.jsonl": queue_binding["manifest_sha256"],
            f"{REPAIR_QUEUE_NAME}/.fontclip-hard-candidates.json": (
                queue_binding["marker_sha256"]
            ),
            f"{REPAIR_QUEUE_NAME}/report.json": queue_binding["report_sha256"],
        }
        marker = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "phase": "prepared",
            "completed": True,
            "output_root": str(output),
            "owned_outputs": [
                INITIAL_DECISIONS_NAME,
                INITIAL_REJECTS_NAME,
                RECROP_LINEAGE_NAME,
                PREP_REPORT_NAME,
                REPAIR_QUEUE_NAME,
            ],
            "preparation_signature": preparation_signature,
            "preparation_signature_sha256": preparation_signature_sha,
            "outputs": outputs,
            "repair_queue": queue_binding,
            "counts": {
                "input": len(dataset.records_by_id),
                "pass": counts["pass"],
                "reject": counts["reject"],
                "recrop": counts["recrop"],
            },
            "created_at": utc_now(),
        }
        atomic_write_bytes(staging / PREP_MARKER_NAME, json_bytes(marker))
        verify_dataset_binding(dataset.binding)
        verify_frozen_files(audit.frozen_files)
        for candidate in repair_candidates:
            for key in ("image_path", "clip_image_path"):
                queued_asset = resolve_inside(
                    queue_physical,
                    candidate[key],
                    f"repair candidate {key}",
                )
                expected = candidate["asset_file_sha256"][key]
                if sha256_file(queued_asset) != expected:
                    raise HardAdjudicationError(
                        f"repair queue asset changed before commit: {queued_asset}"
                    )
        verify_source_page_bindings(
            repair_candidates,
            library_root=dataset.library_root,
        )
        retained_backup = _commit_directory(
            staging,
            output,
            marker_name=PREP_MARKER_NAME,
            expected_tool=TOOL_ID,
            overwrite=bool(args.overwrite),
        )
    except BaseException:
        # Never recursively delete a failed staging tree: another process may
        # have added an unknown file after the last validation.  The hidden,
        # uniquely named tree remains recoverable for explicit operator cleanup.
        raise
    return {
        "phase": "prepared",
        "output_root": str(output),
        "decision_counts": dict(sorted(counts.items())),
        "repair_candidates": len(repair_candidates),
        "repair_manifest_sha256": queue_binding["manifest_sha256"],
        "postprocess_command": postprocess_command,
        "repair_processed_root": str(repair_processed_root),
        "retained_previous_output": (
            str(retained_backup) if retained_backup is not None else None
        ),
    }


def load_preparation(
    preparation_value: Path,
    *,
    dataset_root: Path | None = None,
    library_root: Path | None = None,
) -> tuple[Path, dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    root = preparation_value.expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(root)
    marker_path = root / PREP_MARKER_NAME
    marker = _validate_owned_output_inventory(
        root,
        declared_root=root,
        marker_name=PREP_MARKER_NAME,
        expected_tool=TOOL_ID,
    )
    if (
        marker is None
        or marker.get("phase") != "prepared"
        or marker.get("completed") is not True
        or marker.get("output_root") != str(root)
    ):
        raise HardAdjudicationError(
            f"{root}: invalid hard adjudication preparation marker"
        )
    signature = marker.get("preparation_signature")
    if not isinstance(signature, Mapping) or marker.get(
        "preparation_signature_sha256"
    ) != sha256_json(signature):
        raise HardAdjudicationError(f"{marker_path}: preparation signature mismatch")
    signed_dataset = signature.get("dataset")
    if not isinstance(signed_dataset, Mapping):
        raise HardAdjudicationError(f"{marker_path}: missing signed source dataset")
    if (
        dataset_root is not None
        and Path(str(signed_dataset.get("root"))).resolve() != dataset_root.resolve()
    ):
        raise HardAdjudicationError(
            "--dataset does not match the prepared source dataset"
        )
    if library_root is not None:
        source_manifest_marker = read_json(
            Path(str(signed_dataset["ownership_marker"]))
        )
        run_signature = source_manifest_marker.get("signature")
        marked_library = (
            Path(str(run_signature.get("library_root"))).resolve()
            if isinstance(run_signature, Mapping)
            else None
        )
        if marked_library != library_root.resolve():
            raise HardAdjudicationError(
                "--library-root does not match the prepared source dataset"
            )
    outputs = marker.get("outputs")
    if not isinstance(outputs, Mapping):
        raise HardAdjudicationError(f"{marker_path}: missing output hashes")
    for relative, expected in outputs.items():
        path = resolve_inside(root, relative, "prepared output")
        if not path.is_file() or sha256_file(path) != expected:
            raise HardAdjudicationError(
                f"prepared adjudication artifact changed: {path}"
            )
    report = read_json(root / PREP_REPORT_NAME)
    if (
        report.get("tool") != TOOL_ID
        or report.get("phase") != "prepared"
        or report.get("completed") is not True
        or report.get("preparation_signature_sha256")
        != marker.get("preparation_signature_sha256")
    ):
        raise HardAdjudicationError(
            f"{root / PREP_REPORT_NAME}: stale preparation report"
        )
    decisions = read_jsonl(root / INITIAL_DECISIONS_NAME)
    lineage = read_jsonl(root / RECROP_LINEAGE_NAME)
    counts = marker.get("counts")
    if (
        not isinstance(counts, Mapping)
        or len(decisions) != counts.get("input")
        or sum(row.get("decision") == "recrop" for row in decisions)
        != counts.get("recrop")
        or len(lineage) != counts.get("recrop")
    ):
        raise HardAdjudicationError(
            f"{marker_path}: preparation counts do not match artifacts"
        )
    return root, marker, decisions, lineage


def _repair_successor_map(
    *,
    preparation_root: Path,
    preparation_marker: Mapping[str, Any],
    repair_dataset: ValidatedDataset,
    lineage: Sequence[Mapping[str, Any]],
    prepared_decisions: Mapping[str, Mapping[str, Any]],
    original_dataset: ValidatedDataset,
    review_decisions: Mapping[str, ReviewDecision],
) -> RepairResolution:
    queue = preparation_marker.get("repair_queue")
    if not isinstance(queue, Mapping):
        raise HardAdjudicationError("preparation marker lacks repair queue")
    queue_manifest = preparation_root / REPAIR_QUEUE_NAME / "manifest.jsonl"
    if Path(
        str(queue.get("manifest"))
    ).resolve() != queue_manifest.resolve() or sha256_file(queue_manifest) != queue.get(
        "manifest_sha256"
    ):
        raise HardAdjudicationError("prepared repair manifest binding is invalid")
    postprocess_signature = repair_dataset.result.marker.get("signature")
    if (
        not isinstance(postprocess_signature, Mapping)
        or Path(str(postprocess_signature.get("manifest"))).resolve()
        != queue_manifest.resolve()
        or postprocess_signature.get("manifest_sha256") != queue.get("manifest_sha256")
    ):
        raise HardAdjudicationError(
            "repair postprocessor output is not derived from the prepared queue"
        )
    queue_rows = read_jsonl(queue_manifest)
    queue_by_id = {str(row["id"]): row for row in queue_rows}
    if len(queue_by_id) != len(queue_rows):
        raise HardAdjudicationError("repair queue IDs are not unique")
    lineage_by_candidate = {str(row.get("repair_candidate_id")): row for row in lineage}
    if len(lineage_by_candidate) != len(lineage) or set(queue_by_id) != set(
        lineage_by_candidate
    ):
        raise HardAdjudicationError(
            "repair queue does not exactly match recrop lineage"
        )
    for candidate_id, candidate in queue_by_id.items():
        manual = candidate.get("manual_recrop")
        if not isinstance(manual, Mapping):
            raise HardAdjudicationError(
                f"{candidate_id}: repair candidate lacks manual lineage"
            )
        parent_id = str(manual.get("parent_processed_id", ""))
        prepared = prepared_decisions.get(parent_id)
        source_record = original_dataset.records_by_id.get(parent_id)
        review_decision = review_decisions.get(parent_id)
        if (
            not isinstance(prepared, Mapping)
            or source_record is None
            or review_decision is None
        ):
            raise HardAdjudicationError(
                f"{candidate_id}: repair parent is absent from prepared decisions"
            )
        expected_candidate, expected_lineage_from_source = build_repair_candidate(
            source_record,
            review_decision,
            queue_physical_root=None,
            queue_declared_root=preparation_root / REPAIR_QUEUE_NAME,
            library_root=original_dataset.library_root,
            write_assets=False,
        )
        if candidate != expected_candidate:
            raise HardAdjudicationError(
                f"{candidate_id}: repair queue row/asset signatures are not "
                "the exact source-page derivation of the signed decision"
            )
        expected_manual = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "parent_processed_id": parent_id,
            "supersedes_id": parent_id,
            "parent_processed_record_sha256": prepared.get("source_record_sha256"),
            "review_ledger": prepared.get("ledger"),
            "review_ledger_sha256": prepared.get("ledger_sha256"),
            "reviewer": prepared.get("reviewer"),
            "reviewed_at": prepared.get("reviewed_at"),
            "notes": prepared.get("notes"),
            "coordinate_space": "source_page_pixels_xyxy",
            "bbox_px": prepared.get("recrop_bbox_px"),
            "padding_px": prepared.get("padding_px"),
            "crop_bbox_px": candidate.get("crop_bbox_px"),
            "crop_sha256": candidate.get("crop_sha256"),
            "diagnostic_overlay_written": False,
            "synthetic": False,
        }
        if (
            prepared.get("decision") != "recrop"
            or prepared.get("repair_candidate_id") != candidate_id
            or manual != expected_manual
            or candidate.get("bbox_px") != prepared.get("recrop_bbox_px")
            or candidate.get("root_real_id") != prepared.get("root_real_id")
            or candidate.get("work_id") != prepared.get("work_id")
            or candidate.get("chapter_id") != prepared.get("chapter_id")
            or candidate.get("page_id") != prepared.get("page_id")
            or candidate.get("split") != prepared.get("split")
        ):
            raise HardAdjudicationError(
                f"{candidate_id}: repair candidate differs from its signed "
                "manual decision"
            )
        expected_lineage = {
            "schema_version": SCHEMA_VERSION,
            "parent_processed_id": parent_id,
            "parent_processed_record_sha256": prepared.get("source_record_sha256"),
            "repair_candidate_id": candidate_id,
            "repair_candidate_record_sha256": sha256_json(candidate),
            "root_real_id": candidate.get("root_real_id"),
            "source_image_path": candidate.get("source_image_path"),
            "source_page_sha256": candidate.get("source_page_sha256"),
            "bbox_px": candidate.get("bbox_px"),
            "padding_px": prepared.get("padding_px"),
            "crop_bbox_px": candidate.get("crop_bbox_px"),
            "crop_sha256": candidate.get("crop_sha256"),
            "queue_root": str(preparation_root / REPAIR_QUEUE_NAME),
            "review": {
                "ledger": prepared.get("ledger"),
                "ledger_sha256": prepared.get("ledger_sha256"),
                "reviewer": prepared.get("reviewer"),
                "reviewed_at": prepared.get("reviewed_at"),
                "sheet": prepared.get("sheet"),
                "cell_index": prepared.get("cell_index"),
                "notes": prepared.get("notes"),
            },
            "provenance": "real_manual_recrop",
            "synthetic": False,
            "accepted": False,
            "acceptance_gate": "pending_postprocess_and_exhaustive_recheck",
        }
        if (
            expected_lineage != expected_lineage_from_source
            or lineage_by_candidate[candidate_id] != expected_lineage
        ):
            raise HardAdjudicationError(
                f"{candidate_id}: recrop lineage does not exactly match its "
                "queue record and signed decision"
            )
    successor_by_candidate: dict[str, dict[str, Any]] = {}
    for record in repair_dataset.result.records:
        candidate_id = str(record.get("parent_id", ""))
        if candidate_id not in queue_by_id:
            raise HardAdjudicationError(
                f"unexpected repair successor parent: {candidate_id!r}"
            )
        if candidate_id in successor_by_candidate:
            raise HardAdjudicationError(
                f"repair candidate has multiple successors: {candidate_id}"
            )
        candidate = queue_by_id[candidate_id]
        if (
            record.get("parent_record_sha256") != sha256_json(candidate)
            or record.get("root_real_id") != candidate.get("root_real_id")
            or record.get("split") != candidate.get("split")
            or record.get("work_id") != candidate.get("work_id")
            or record.get("chapter_id") != candidate.get("chapter_id")
            or record.get("source_page_sha256") != candidate.get("source_page_sha256")
            or record.get("source_crop_bbox_px") != candidate.get("crop_bbox_px")
            or record.get("bbox_px") != candidate.get("bbox_px")
        ):
            raise HardAdjudicationError(
                f"{record.get('id')}: repair successor lineage mismatch"
            )
        successor_by_candidate[candidate_id] = dict(record)
    reject_by_candidate: dict[str, dict[str, Any]] = {}
    for reject in repair_dataset.result.rejects:
        candidate_id = safe_component(
            reject.get("parent_id"),
            "repair postprocess reject parent",
        )
        if candidate_id not in queue_by_id:
            raise HardAdjudicationError(
                f"unexpected repair postprocess reject parent: {candidate_id}"
            )
        if (
            candidate_id in reject_by_candidate
            or candidate_id in successor_by_candidate
        ):
            raise HardAdjudicationError(
                f"repair candidate has multiple terminal outcomes: {candidate_id}"
            )
        candidate = queue_by_id[candidate_id]
        if (
            reject.get("id") != candidate_id
            or reject.get("parent_record_sha256") != sha256_json(candidate)
            or reject.get("work_id") != candidate.get("work_id")
            or reject.get("chapter_id") != candidate.get("chapter_id")
            or reject.get("page_id") != candidate.get("page_id")
            or reject.get("split") != candidate.get("split")
            or reject.get("source_image_path") != candidate.get("source_image_path")
            or reject.get("bbox_px") != candidate.get("bbox_px")
            or reject.get("crop_bbox_px") != candidate.get("crop_bbox_px")
            or reject.get("synthetic") is not False
        ):
            raise HardAdjudicationError(
                f"{candidate_id}: repair postprocess reject lineage mismatch"
            )
        reject_by_candidate[candidate_id] = dict(reject)
    observed = set(successor_by_candidate) | set(reject_by_candidate)
    missing = sorted(set(queue_by_id) - observed)
    unexpected = sorted(observed - set(queue_by_id))
    if missing or unexpected or len(observed) != len(queue_by_id):
        raise HardAdjudicationError(
            "repair postprocess outcomes do not cover every candidate exactly "
            f"once: missing={missing[:8]}, unexpected={unexpected[:8]}"
        )
    return RepairResolution(
        successors=successor_by_candidate,
        postprocess_rejects=reject_by_candidate,
    )


def build_recheck(args: argparse.Namespace) -> dict[str, Any]:
    library_root = args.library_root.expanduser().resolve()
    prep_root, prep_marker, decisions, lineage = load_preparation(
        args.adjudication_root,
        library_root=library_root,
    )
    prepared_by_id = _decision_rows_by_id(decisions)
    prep_signature = prep_marker.get("preparation_signature")
    expected_repair_root = (
        Path(str(prep_signature.get("repair_processed_root"))).resolve()
        if isinstance(prep_signature, Mapping)
        else None
    )
    if expected_repair_root != args.repair_processed_root.expanduser().resolve():
        raise HardAdjudicationError(
            "--repair-processed-root does not match the prepared destination"
        )
    signed_dataset = (
        prep_signature.get("dataset") if isinstance(prep_signature, Mapping) else None
    )
    if not isinstance(signed_dataset, Mapping):
        raise HardAdjudicationError(
            "preparation signature lacks its original processed dataset"
        )
    original = validate_processed_dataset(
        Path(str(signed_dataset.get("root"))),
        library_root,
    )
    initial_audit = validate_audit_bundle(
        _audit_ledgers_from_preparation(prep_marker),
        dataset=original,
    )
    if (
        prep_signature.get("dataset") != original.binding
        or prep_signature.get("initial_audit") != initial_audit.binding
    ):
        raise HardAdjudicationError(
            "current original dataset/audit differs from the prepared "
            "adjudication signature"
        )
    for item_id, review_decision in initial_audit.decisions.items():
        source_record = original.records_by_id[item_id]
        repair_candidate_id = (
            _repair_candidate_id(source_record, review_decision)
            if review_decision.decision == "recrop"
            else None
        )
        if prepared_by_id.get(item_id) != decision_record(
            review_decision,
            source_record,
            repair_candidate_id=repair_candidate_id,
        ):
            raise HardAdjudicationError(
                f"{item_id}: prepared decision differs from signed initial audit"
            )
    repair = validate_processed_dataset(
        args.repair_processed_root,
        library_root,
    )
    _require_separate_roots(
        prep_root,
        repair.root,
        "--adjudication-root",
        "--repair-processed-root",
    )
    resolution = _repair_successor_map(
        preparation_root=prep_root,
        preparation_marker=prep_marker,
        repair_dataset=repair,
        lineage=lineage,
        prepared_decisions=prepared_by_id,
        original_dataset=original,
        review_decisions=initial_audit.decisions,
    )
    successors = resolution.successors
    if not successors:
        return {
            "phase": "recheck_not_required",
            "qa_dir": None,
            "successors": 0,
            "repair_postprocess_rejected": len(resolution.postprocess_rejects),
            "shards": 0,
            "sheet_count": 0,
            "successors_accepted": 0,
            "acceptance_gate": "no postprocess successor exists",
        }
    qa_dir = (
        args.qa_dir.expanduser().resolve()
        if args.qa_dir is not None
        else repair.root / RECHECK_QA_DIR_NAME
    )
    if qa_dir == repair.root or not is_within(repair.root, qa_dir):
        raise HardAdjudicationError(
            "--qa-dir must be a child of --repair-processed-root"
        )
    reports: list[dict[str, Any]] = []
    for shard_index in range(REQUIRED_AUDIT_SHARDS):
        qa_args = HARD_QA.build_argument_parser().parse_args(
            [
                "--dataset",
                str(repair.root),
                "--library-root",
                str(library_root),
                "--qa-dir",
                str(qa_dir),
                "--audit-all",
                "--shard-index",
                str(shard_index),
                "--shard-count",
                str(REQUIRED_AUDIT_SHARDS),
                "--contact-sheet-size",
                str(args.contact_sheet_size),
                *(["--quiet"] if args.quiet else []),
            ]
        )
        code, report = HARD_QA.run(qa_args)
        if code != 0:
            raise HardAdjudicationError(
                f"hard recheck QA shard {shard_index} failed: "
                f"{report.get('issue_counts')}"
            )
        reports.append(report)
    return {
        "phase": "recheck_rendered",
        "qa_dir": str(qa_dir),
        "successors": len(successors),
        "repair_postprocess_rejected": len(resolution.postprocess_rejects),
        "shards": REQUIRED_AUDIT_SHARDS,
        "sheet_count": sum(
            len(report.get("sheet_artifacts", ())) for report in reports
        ),
        "recorder": "scripts/record_fontclip_sheet_review.py",
        "successors_accepted": 0,
        "acceptance_gate": "four completed recheck ledgers",
    }


def _decision_rows_by_id(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        item_id = safe_component(row.get("id"), "prepared decision id")
        if item_id in result:
            raise HardAdjudicationError(
                f"prepared decision ID is duplicated: {item_id}"
            )
        if row.get("decision") not in {"pass", "reject", "recrop"}:
            raise HardAdjudicationError(f"{item_id}: invalid prepared decision")
        result[item_id] = dict(row)
    return result


def _audit_ledgers_from_preparation(
    marker: Mapping[str, Any],
) -> list[Path]:
    signature = marker.get("preparation_signature")
    audit = signature.get("initial_audit") if isinstance(signature, Mapping) else None
    shards = audit.get("shards") if isinstance(audit, Mapping) else None
    if not isinstance(shards, list) or len(shards) != REQUIRED_AUDIT_SHARDS:
        raise HardAdjudicationError(
            "prepared marker lacks four initial audit shard bindings"
        )
    return [Path(str(shard["ledger"])) for shard in shards]


def _validated_asset_source(
    dataset_root: Path,
    descriptor: Mapping[str, Any],
) -> Path:
    path = resolve_inside(dataset_root, descriptor.get("path"), "asset path")
    if not path.is_file():
        raise HardAdjudicationError(f"accepted asset is missing: {path}")
    expected = descriptor.get("file_sha256")
    if not isinstance(expected, str) or sha256_file(path) != expected:
        raise HardAdjudicationError(
            f"accepted asset hash changed before publication: {path}"
        )
    return path


def _copy_or_link(source: Path, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Keep the final training dataset mutation-independent from its signed
    # source.  A hardlink would couple later writes in either tree.
    shutil.copy2(source, destination)
    return "copy"


def _decorate_accepted_original(
    record: Mapping[str, Any],
    decision: ReviewDecision,
) -> dict[str, Any]:
    result = dict(record)
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
    result["mask_review"] = dict(result["review"])
    result["adjudication"] = {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "path": "original_processed_pass",
        "source_record_sha256": sha256_json(record),
        "initial_review_ledger_sha256": decision.ledger_sha256,
        "exhaustive_visual_review_passed": True,
        "manual_recrop": False,
        "successor_recheck_required": False,
        "synthetic": False,
    }
    return result


def _decorate_accepted_successor(
    record: Mapping[str, Any],
    *,
    initial: Mapping[str, Any],
    lineage: Mapping[str, Any],
    recheck: ReviewDecision,
) -> dict[str, Any]:
    result = dict(record)
    result["review"] = {
        "status": "accepted",
        "decision": "pass",
        "reviewer": recheck.reviewer,
        "reviewed_at": recheck.reviewed_at,
        "ledger_sha256": recheck.ledger_sha256,
        "sheet": recheck.sheet,
        "cell_index": recheck.cell_index,
        "notes": recheck.notes or None,
    }
    result["mask_review"] = dict(result["review"])
    result["adjudication"] = {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "path": "manual_recrop_postprocess_recheck_pass",
        "source_record_sha256": sha256_json(record),
        "root_original_processed_id": initial.get("id"),
        "root_original_processed_record_sha256": initial.get("source_record_sha256"),
        "repair_candidate_id": lineage.get("repair_candidate_id"),
        "repair_candidate_record_sha256": lineage.get("repair_candidate_record_sha256"),
        "manual_recrop_bbox_px": lineage.get("bbox_px"),
        "manual_recrop_padding_px": lineage.get("padding_px"),
        "manual_recrop_crop_sha256": lineage.get("crop_sha256"),
        "initial_review_ledger_sha256": initial.get("ledger_sha256"),
        "recheck_review_ledger_sha256": recheck.ledger_sha256,
        "exhaustive_visual_review_passed": True,
        "manual_recrop": True,
        "successor_recheck_required": True,
        "successor_recheck_passed": True,
        "synthetic": False,
    }
    postprocess_lineage = [
        dict(value) for value in result.get("lineage", ()) if isinstance(value, Mapping)
    ]
    processed_event = next(
        (
            dict(value)
            for value in reversed(postprocess_lineage)
            if value.get("id") == result.get("id")
        ),
        {
            "id": result.get("id"),
            "provenance": "real_processed",
            "tool": result.get("processing", {}).get("tool"),
        },
    )
    processed_event.update(
        {
            "provenance": "real_processed_recheck_accepted",
            "adjudication_tool": TOOL_ID,
            "review_ledger_sha256": recheck.ledger_sha256,
            "reviewed_at": recheck.reviewed_at,
            "synthetic": False,
        }
    )
    result["postprocess_lineage"] = postprocess_lineage
    result["lineage"] = [
        {
            "id": initial.get("id"),
            "provenance": "real_processed_superseded",
            "record_sha256": initial.get("source_record_sha256"),
            "review_ledger_sha256": initial.get("ledger_sha256"),
            "synthetic": False,
        },
        {
            "id": lineage.get("repair_candidate_id"),
            "provenance": "real_manual_recrop",
            "tool": TOOL_ID,
            "source_page_sha256": lineage.get("source_page_sha256"),
            "crop_sha256": lineage.get("crop_sha256"),
            "bbox_px": lineage.get("bbox_px"),
            "padding_px": lineage.get("padding_px"),
            "synthetic": False,
        },
        processed_event,
    ]
    return result


def _validate_final_population(records: Sequence[Mapping[str, Any]]) -> None:
    ids: set[str] = set()
    asset_ids: set[str] = set()
    asset_paths: set[str] = set()
    work_splits: dict[str, str] = {}
    root_splits: dict[str, str] = {}
    crop_hashes: set[str] = set()
    work_chapters: dict[str, set[str]] = defaultdict(set)
    for record in records:
        item_id = safe_component(record.get("id"), "final record id")
        if item_id in ids:
            raise HardAdjudicationError(f"duplicate final record id: {item_id}")
        ids.add(item_id)
        if (
            record.get("provenance") != "real_processed"
            or record.get("synthetic") is not False
            or record.get("synthetic_provenance") is not None
            or record.get("label") is not None
        ):
            raise HardAdjudicationError(
                f"{item_id}: final dataset cannot contain synthetic provenance"
            )
        work_id = safe_component(record.get("work_id"), "work_id")
        chapter_id = safe_component(record.get("chapter_id"), "chapter_id")
        split = safe_component(record.get("split"), "split")
        if split not in ALLOWED_SPLITS:
            raise HardAdjudicationError(f"{item_id}: invalid final split {split!r}")
        previous = work_splits.setdefault(work_id, split)
        if previous != split:
            raise HardAdjudicationError(f"work {work_id} crosses final splits")
        root_real_id = safe_component(
            record.get("root_real_id"),
            "root_real_id",
        )
        if root_real_id in root_splits:
            raise HardAdjudicationError(
                f"root lineage appears more than once: {root_real_id}"
            )
        root_splits[root_real_id] = split
        crop_hash = record.get("crop_sha256")
        if not isinstance(crop_hash, str) or not HEX_SHA256.fullmatch(crop_hash):
            raise HardAdjudicationError(f"{item_id}: invalid final crop SHA-256")
        if crop_hash in crop_hashes:
            raise HardAdjudicationError(f"{item_id}: duplicate final real crop SHA-256")
        crop_hashes.add(crop_hash)
        work_chapters[work_id].add(chapter_id)
        if len(work_chapters[work_id]) > MAX_CHAPTERS_PER_WORK:
            raise HardAdjudicationError(
                f"work {work_id} exceeds {MAX_CHAPTERS_PER_WORK} chapters"
            )
        processing = record.get("processing")
        if (
            not isinstance(processing, Mapping)
            or processing.get("diagnostic_overlay_written") is not False
        ):
            raise HardAdjudicationError(
                f"{item_id}: diagnostic overlay record is forbidden"
            )
        lineage = record.get("lineage")
        if not isinstance(lineage, list) or not lineage:
            raise HardAdjudicationError(
                f"{item_id}: final lineage must be a non-empty array"
            )
        lineage_ids: list[str] = []
        for event in lineage:
            if not isinstance(event, Mapping):
                raise HardAdjudicationError(
                    f"{item_id}: final lineage event is invalid"
                )
            lineage_ids.append(safe_component(event.get("id"), "lineage event id"))
            if event.get("synthetic") is True:
                raise HardAdjudicationError(
                    f"{item_id}: synthetic lineage event is forbidden"
                )
        if len(lineage_ids) != len(set(lineage_ids)):
            raise HardAdjudicationError(f"{item_id}: lineage IDs must be unique")
        adjudication = record.get("adjudication")
        if not isinstance(adjudication, Mapping):
            raise HardAdjudicationError(
                f"{item_id}: final adjudication metadata is missing"
            )
        if adjudication.get("manual_recrop") is True:
            expected_lineage_ids = [
                adjudication.get("root_original_processed_id"),
                adjudication.get("repair_candidate_id"),
                item_id,
            ]
            if lineage_ids != expected_lineage_ids:
                raise HardAdjudicationError(
                    f"{item_id}: manual successor lineage is not the exact "
                    "root→repair→successor chain"
                )
        elif lineage_ids[-1] != item_id:
            raise HardAdjudicationError(
                f"{item_id}: original-pass lineage does not terminate at "
                "the accepted record"
            )
        assets = record.get("assets")
        if not isinstance(assets, Mapping):
            raise HardAdjudicationError(f"{item_id}: missing asset DAG")
        allowed_asset_kinds = set(HARD_QA.REQUIRED_ASSET_KINDS) | {"deskew_rgba"}
        if not set(HARD_QA.REQUIRED_ASSET_KINDS).issubset(assets) or not set(
            assets
        ).issubset(allowed_asset_kinds):
            raise HardAdjudicationError(
                f"{item_id}: final asset kinds are incomplete or unknown"
            )
        for kind, descriptor in assets.items():
            if not isinstance(descriptor, Mapping):
                raise HardAdjudicationError(f"{item_id}: invalid asset descriptor")
            asset_id = safe_component(descriptor.get("id"), "asset id")
            path = safe_relative(descriptor.get("path"), "asset path").as_posix()
            expected_path = f"{HARD_QA.ASSET_DIRECTORIES[kind]}/{split}/{item_id}.png"
            if (
                asset_id != HARD_QA.expected_asset_id(item_id, kind)
                or path != expected_path
                or descriptor.get("kind") != kind
            ):
                raise HardAdjudicationError(
                    f"{item_id}: non-canonical final {kind} asset identity"
                )
            if asset_id in asset_ids or path in asset_paths:
                raise HardAdjudicationError(
                    f"{item_id}: duplicate final asset identity/path"
                )
            asset_ids.add(asset_id)
            asset_paths.add(path)
            if descriptor.get("provenance") not in {
                "real_preserved",
                "real_processed",
            }:
                raise HardAdjudicationError(
                    f"{item_id}: non-real final asset provenance"
                )


def _final_reject_row(
    *,
    initial: Mapping[str, Any],
    recheck: ReviewDecision | None = None,
    successor: Mapping[str, Any] | None = None,
    repair_reject: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "id": initial.get("id"),
        "original_processed_record_sha256": initial.get("source_record_sha256"),
        "root_real_id": initial.get("root_real_id"),
        "work_id": initial.get("work_id"),
        "chapter_id": initial.get("chapter_id"),
        "page_id": initial.get("page_id"),
        "split": initial.get("split"),
        "initial_decision": initial.get("decision"),
        "initial_reject_reason": initial.get("reject_reason"),
        "initial_ledger_sha256": initial.get("ledger_sha256"),
        "initial_reviewer": initial.get("reviewer"),
        "initial_reviewed_at": initial.get("reviewed_at"),
        "initial_notes": initial.get("notes"),
        "initial_recrop_bbox_px": initial.get("recrop_bbox_px"),
        "initial_recrop_padding_px": initial.get("padding_px"),
        "repair_candidate_id": initial.get("repair_candidate_id"),
        "repair_postprocess_reject_id": (
            repair_reject.get("id") if repair_reject else None
        ),
        "repair_postprocess_reject_record_sha256": (
            sha256_json(repair_reject) if repair_reject is not None else None
        ),
        "repair_postprocess_stage": (
            repair_reject.get("stage") if repair_reject else None
        ),
        "repair_postprocess_failure_reasons": (
            repair_reject.get("failure_reasons") if repair_reject else None
        ),
        "successor_id": successor.get("id") if successor else None,
        "successor_record_sha256": (
            sha256_json(successor) if successor is not None else None
        ),
        "recheck_decision": recheck.decision if recheck else None,
        "recheck_reject_reason": recheck.reject_reason if recheck else None,
        "recheck_ledger_sha256": (recheck.ledger_sha256 if recheck else None),
        "accepted": False,
        "synthetic": False,
        "stage": (
            "repair_postprocess_reject"
            if repair_reject is not None
            else (
                "successor_exhaustive_recheck"
                if recheck is not None
                else "initial_exhaustive_review"
            )
        ),
    }


def finalize(args: argparse.Namespace) -> dict[str, Any]:
    dataset_root = args.dataset.expanduser().resolve()
    library_root = args.library_root.expanduser().resolve()
    prep_root, prep_marker, prepared_rows, lineage_rows = load_preparation(
        args.adjudication_root,
        dataset_root=dataset_root,
        library_root=library_root,
    )
    original = validate_processed_dataset(dataset_root, library_root)
    initial_ledgers = _audit_ledgers_from_preparation(prep_marker)
    initial_audit = validate_audit_bundle(initial_ledgers, dataset=original)
    prepared_signature = prep_marker.get("preparation_signature")
    if (
        not isinstance(prepared_signature, Mapping)
        or prepared_signature.get("dataset") != original.binding
        or prepared_signature.get("initial_audit") != initial_audit.binding
    ):
        raise HardAdjudicationError(
            "current source dataset/audit no longer matches the prepared "
            "adjudication signature"
        )
    prepared_by_id = _decision_rows_by_id(prepared_rows)
    if set(prepared_by_id) != set(original.records_by_id):
        raise HardAdjudicationError(
            "prepared decisions no longer match the original processed manifest"
        )
    for item_id, decision in initial_audit.decisions.items():
        prepared = prepared_by_id[item_id]
        source_record = original.records_by_id[item_id]
        repair_candidate_id = (
            _repair_candidate_id(source_record, decision)
            if decision.decision == "recrop"
            else None
        )
        expected_prepared = decision_record(
            decision,
            source_record,
            repair_candidate_id=repair_candidate_id,
        )
        if prepared != expected_prepared:
            raise HardAdjudicationError(
                f"{item_id}: prepared decision differs from signed initial audit"
            )

    recrop_count = sum(row.get("decision") == "recrop" for row in prepared_rows)
    repair: ValidatedDataset | None = None
    recheck_audit: AuditBundle | None = None
    successors: dict[str, dict[str, Any]] = {}
    repair_rejects: dict[str, dict[str, Any]] = {}
    if recrop_count:
        if args.repair_processed_root is None:
            raise HardAdjudicationError(
                "--repair-processed-root is required when recrops exist"
            )
        expected_repair_root = Path(
            str(prepared_signature.get("repair_processed_root"))
        ).resolve()
        if args.repair_processed_root.expanduser().resolve() != expected_repair_root:
            raise HardAdjudicationError(
                "--repair-processed-root does not match the prepared destination"
            )
        repair = validate_processed_dataset(
            args.repair_processed_root,
            library_root,
        )
        _require_separate_roots(
            original.root,
            repair.root,
            "--dataset",
            "--repair-processed-root",
        )
        _require_separate_roots(
            prep_root,
            repair.root,
            "--adjudication-root",
            "--repair-processed-root",
        )
        resolution = _repair_successor_map(
            preparation_root=prep_root,
            preparation_marker=prep_marker,
            repair_dataset=repair,
            lineage=lineage_rows,
            prepared_decisions=prepared_by_id,
            original_dataset=original,
            review_decisions=initial_audit.decisions,
        )
        successors = resolution.successors
        repair_rejects = resolution.postprocess_rejects
        if successors:
            if len(args.recheck_ledger) != REQUIRED_AUDIT_SHARDS:
                raise HardAdjudicationError(
                    f"exactly {REQUIRED_AUDIT_SHARDS} --recheck-ledger values "
                    "are required when repair successors exist"
                )
            recheck_audit = validate_audit_bundle(
                args.recheck_ledger,
                dataset=repair,
            )
            if set(recheck_audit.decisions) != {
                str(record["id"]) for record in successors.values()
            }:
                raise HardAdjudicationError(
                    "recheck decisions do not exactly cover repair successors"
                )
            unresolved = sorted(
                decision.item_id
                for decision in recheck_audit.decisions.values()
                if decision.decision == "recrop"
            )
            if unresolved:
                raise HardAdjudicationError(
                    "successors marked recrop cannot be finalized. Re-open the "
                    "corresponding original bound review cells, replace their "
                    "source-page XYXY recrop decisions, finalize all four "
                    "initial ledgers again, and run prepare/postprocess/"
                    f"build-recheck into new roots: {unresolved[:12]}"
                )
        elif args.recheck_ledger:
            raise HardAdjudicationError(
                "recheck ledgers were supplied, but every repair candidate was "
                "safely excluded by the signed postprocessor"
            )
    elif args.repair_processed_root is not None or args.recheck_ledger:
        raise HardAdjudicationError(
            "repair/recheck inputs were supplied but preparation has no recrops"
        )

    lineage_by_candidate = {
        str(row.get("repair_candidate_id")): dict(row) for row in lineage_rows
    }
    if len(lineage_by_candidate) != len(lineage_rows):
        raise HardAdjudicationError("prepared recrop lineage IDs are not unique")
    accepted_sources: list[tuple[dict[str, Any], ValidatedDataset, dict[str, Any]]] = []
    rejected: list[dict[str, Any]] = []
    final_lineage: list[dict[str, Any]] = []
    for source_record in sorted(
        original.result.records,
        key=HARD_QA.record_order_key,
    ):
        item_id = str(source_record["id"])
        initial = prepared_by_id[item_id]
        initial_decision = initial_audit.decisions[item_id]
        if initial_decision.decision == "pass":
            accepted = _decorate_accepted_original(
                source_record,
                initial_decision,
            )
            accepted_sources.append((accepted, original, dict(source_record)))
            final_lineage.append(
                {
                    "schema_version": SCHEMA_VERSION,
                    "accepted_id": item_id,
                    "path": "original_processed_pass",
                    "original_processed_id": item_id,
                    "original_processed_record_sha256": sha256_json(source_record),
                    "initial_review_ledger_sha256": (initial_decision.ledger_sha256),
                    "synthetic": False,
                }
            )
        elif initial_decision.decision == "reject":
            rejected.append(_final_reject_row(initial=initial))
        else:
            candidate_id = str(initial.get("repair_candidate_id", ""))
            successor = successors.get(candidate_id)
            repair_reject = repair_rejects.get(candidate_id)
            lineage = lineage_by_candidate.get(candidate_id)
            if lineage is None or repair is None:
                raise HardAdjudicationError(
                    f"{item_id}: missing repair outcome lineage"
                )
            if repair_reject is not None:
                if successor is not None:
                    raise HardAdjudicationError(
                        f"{item_id}: repair has both successor and reject"
                    )
                rejected.append(
                    _final_reject_row(
                        initial=initial,
                        repair_reject=repair_reject,
                    )
                )
                continue
            if successor is None:
                raise HardAdjudicationError(f"{item_id}: missing repair successor")
            recheck = (
                recheck_audit.decisions[str(successor["id"])]
                if recheck_audit is not None
                else None
            )
            if recheck is None:
                raise HardAdjudicationError(
                    f"{item_id}: successor has no completed recheck"
                )
            if recheck.decision == "pass":
                accepted = _decorate_accepted_successor(
                    successor,
                    initial=initial,
                    lineage=lineage,
                    recheck=recheck,
                )
                accepted_sources.append((accepted, repair, dict(successor)))
                final_lineage.append(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "accepted_id": successor["id"],
                        "path": "manual_recrop_postprocess_recheck_pass",
                        "original_processed_id": item_id,
                        "original_processed_record_sha256": initial.get(
                            "source_record_sha256"
                        ),
                        "repair_candidate_id": candidate_id,
                        "repair_candidate_record_sha256": lineage.get(
                            "repair_candidate_record_sha256"
                        ),
                        "successor_processed_record_sha256": sha256_json(successor),
                        "initial_review_ledger_sha256": initial.get("ledger_sha256"),
                        "recheck_review_ledger_sha256": (recheck.ledger_sha256),
                        "source_page_sha256": lineage.get("source_page_sha256"),
                        "crop_sha256": lineage.get("crop_sha256"),
                        "synthetic": False,
                    }
                )
            else:
                rejected.append(
                    _final_reject_row(
                        initial=initial,
                        recheck=recheck,
                        successor=successor,
                    )
                )
    accepted_records = [item[0] for item in accepted_sources]
    _validate_final_population(accepted_records)
    if len(accepted_records) < MINIMUM_ACCEPTED_RECORDS:
        raise HardAdjudicationError(
            f"final accepted count {len(accepted_records)} is below the "
            f"required minimum of {MINIMUM_ACCEPTED_RECORDS}"
        )

    protected = [
        ("--dataset", original.root),
        ("--library-root", library_root),
        ("--adjudication-root", prep_root),
    ]
    if repair is not None:
        protected.append(("--repair-processed-root", repair.root))
    output = validate_output_root(args.output_root, protected=protected)
    _preflight_output_destination(
        output,
        marker_name=FINAL_MARKER_NAME,
        expected_tool=TOOL_ID,
        overwrite=bool(args.overwrite),
    )
    staging = _new_staging(output)
    try:
        link_counts: Counter[str] = Counter()
        copied_paths: set[str] = set()
        encoded_bytes = 0
        for accepted, source_dataset, source_record in accepted_sources:
            if accepted["id"] != source_record["id"]:
                raise RuntimeError("accepted/source record identity drift")
            assets = source_record["assets"]
            for descriptor in assets.values():
                source = _validated_asset_source(
                    source_dataset.root,
                    descriptor,
                )
                relative = safe_relative(
                    descriptor.get("path"),
                    "accepted asset path",
                ).as_posix()
                if relative in copied_paths:
                    raise HardAdjudicationError(
                        f"duplicate accepted asset path: {relative}"
                    )
                copied_paths.add(relative)
                destination = staging / PurePosixPath(relative)
                mode = _copy_or_link(source, destination)
                link_counts[mode] += 1
                if sha256_file(destination) != descriptor.get("file_sha256"):
                    raise HardAdjudicationError(
                        f"published asset hash mismatch: {destination}"
                    )
                encoded_bytes += destination.stat().st_size
        accepted_records.sort(key=HARD_QA.record_order_key)
        rejected.sort(key=lambda row: str(row.get("id", "")))
        final_lineage.sort(key=lambda row: str(row.get("accepted_id", "")))
        atomic_write_bytes(
            staging / FINAL_MANIFEST_NAME,
            jsonl_bytes(accepted_records),
        )
        atomic_write_bytes(
            staging / FINAL_REJECTS_NAME,
            jsonl_bytes(rejected),
        )
        atomic_write_bytes(
            staging / FINAL_LINEAGE_NAME,
            jsonl_bytes(final_lineage),
        )
        policy = {
            "schema_version": SCHEMA_VERSION,
            "tool": TOOL_ID,
            "accepted_provenance": ["real_processed"],
            "manual_recrop_provenance": "real_manual_recrop",
            "synthetic_allowed": False,
            "synthetic_records": 0,
            "synthetic_assets": 0,
            "generative_glyphs": 0,
            "diagnostic_overlays_in_training_assets": 0,
            "qa_overlay_colors_are_not_training_assets": True,
            "successor_requires_exhaustive_recheck": True,
        }
        atomic_write_bytes(
            staging / FINAL_POLICY_NAME,
            json_bytes(policy),
        )
        by_split = Counter(str(row["split"]) for row in accepted_records)
        by_work = Counter(str(row["work_id"]) for row in accepted_records)
        accepted_successors = sum(
            row.get("adjudication", {}).get("manual_recrop") is True
            for row in accepted_records
        )
        final_report = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "phase": "finalized",
            "completed": True,
            "output_root": str(output),
            "completed_at": utc_now(),
            "accepted_records": len(accepted_records),
            "rejected_records": len(rejected),
            "accepted_original_passes": (len(accepted_records) - accepted_successors),
            "accepted_rechecked_successors": accepted_successors,
            "minimum_accepted_required": MINIMUM_ACCEPTED_RECORDS,
            "minimum_gate_passed": True,
            "by_split": dict(sorted(by_split.items())),
            "by_work": dict(sorted(by_work.items())),
            "works": len(by_work),
            "max_chapters_per_work": MAX_CHAPTERS_PER_WORK,
            "work_split_unique": True,
            "root_lineage_split_unique": True,
            "upstream_postprocess_rejected": len(original.result.rejects),
            "repair_postprocess_rejected": (
                len(repair.result.rejects) if repair else 0
            ),
            "repair_postprocess_rejects_safely_excluded": True,
            "recheck_eligible_successors": len(successors),
            "published_asset_files": len(copied_paths),
            "published_asset_bytes": encoded_bytes,
            "signed_source_pages": len(
                {
                    str(source_record.get("source_image_path"))
                    for _accepted, _dataset, source_record in accepted_sources
                }
            ),
            "storage": dict(sorted(link_counts.items())),
            "all_ids_decided_exactly_once": True,
            "all_recrop_successors_rechecked": True,
            "synthetic_records": 0,
            "synthetic_assets": 0,
            "diagnostic_overlays": 0,
            "inputs": {
                "original_dataset": original.binding,
                "initial_audit": initial_audit.binding,
                "preparation_marker": str(prep_root / PREP_MARKER_NAME),
                "preparation_marker_sha256": sha256_file(prep_root / PREP_MARKER_NAME),
                "repair_dataset": repair.binding if repair else None,
                "recheck_audit": (recheck_audit.binding if recheck_audit else None),
            },
        }
        atomic_write_bytes(
            staging / FINAL_REPORT_NAME,
            json_bytes(final_report),
        )
        output_hashes = {
            FINAL_MANIFEST_NAME: sha256_file(staging / FINAL_MANIFEST_NAME),
            FINAL_REJECTS_NAME: sha256_file(staging / FINAL_REJECTS_NAME),
            FINAL_LINEAGE_NAME: sha256_file(staging / FINAL_LINEAGE_NAME),
            FINAL_REPORT_NAME: sha256_file(staging / FINAL_REPORT_NAME),
            FINAL_POLICY_NAME: sha256_file(staging / FINAL_POLICY_NAME),
        }
        final_marker = {
            "tool": TOOL_ID,
            "schema_version": SCHEMA_VERSION,
            "phase": "finalized",
            "completed": True,
            "output_root": str(output),
            "owned_outputs": [
                "images",
                FINAL_MANIFEST_NAME,
                FINAL_REJECTS_NAME,
                FINAL_LINEAGE_NAME,
                FINAL_REPORT_NAME,
                FINAL_POLICY_NAME,
            ],
            "outputs": output_hashes,
            "counts": {
                "accepted": len(accepted_records),
                "rejected": len(rejected),
                "assets": len(copied_paths),
                "synthetic": 0,
            },
            "input_bindings_sha256": sha256_json(final_report["inputs"]),
            "completed_at": utc_now(),
        }
        atomic_write_bytes(
            staging / FINAL_MARKER_NAME,
            json_bytes(final_marker),
        )
        verify_dataset_binding(original.binding)
        verify_frozen_files(initial_audit.frozen_files)
        if repair is not None:
            verify_dataset_binding(repair.binding)
        if recheck_audit is not None:
            verify_frozen_files(recheck_audit.frozen_files)
        load_preparation(
            prep_root,
            dataset_root=original.root,
            library_root=library_root,
        )
        verify_source_page_bindings(
            [source_record for _accepted, _dataset, source_record in accepted_sources],
            library_root=library_root,
        )
        for accepted, _source_dataset, source_record in accepted_sources:
            for descriptor in source_record["assets"].values():
                destination = resolve_inside(
                    staging,
                    descriptor.get("path"),
                    "published asset",
                )
                if sha256_file(destination) != descriptor.get("file_sha256"):
                    raise HardAdjudicationError(
                        f"published asset changed before commit: {destination}"
                    )
            if accepted.get("synthetic") is not False:
                raise HardAdjudicationError(
                    "synthetic record appeared before final commit"
                )
        retained_backup = _commit_directory(
            staging,
            output,
            marker_name=FINAL_MARKER_NAME,
            expected_tool=TOOL_ID,
            overwrite=bool(args.overwrite),
        )
    except BaseException:
        # Preserve failed staging for the same reason as prepare(): automatic
        # recursive cleanup cannot distinguish a late external file safely.
        raise
    return {
        "phase": "finalized",
        "output_root": str(output),
        "accepted_records": len(accepted_records),
        "rejected_records": len(rejected),
        "accepted_rechecked_successors": accepted_successors,
        "manifest_sha256": output_hashes[FINAL_MANIFEST_NAME],
        "asset_files": len(copied_paths),
        "minimum_gate": MINIMUM_ACCEPTED_RECORDS,
        "retained_previous_output": (
            str(retained_backup) if retained_backup is not None else None
        ),
    }


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
The tool intentionally has no default dataset path.  All production roots
must be explicit, so an accidental invocation cannot touch the live dataset.

After `prepare`, run the exact postprocess command printed in its JSON result.
After `build-recheck`, inspect and record every generated sheet with
record_fontclip_sheet_review.py, then finalize each shard ledger before using
`finalize`.  If a successor itself needs another recrop, replace the original
signed recrop decision with a corrected source-page XYXY box, finalize the four
initial ledgers again, and repeat all three phases into new roots.  This keeps
the already reviewed original-pass population integrated while remaining
fail-closed.

Successful overwrites retain the prior owned tree in a hidden
`.NAME.backup-<id>` sibling.  Failed writes retain their hidden staging tree.
Inspect and remove those recoverable trees explicitly after confirming that no
external file was added to them.
""",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser(
        "prepare",
        help="Validate initial four-shard review and create a repair queue.",
    )
    prepare_parser.add_argument("--dataset", type=Path, required=True)
    prepare_parser.add_argument("--library-root", type=Path, required=True)
    prepare_parser.add_argument(
        "--ledger",
        type=Path,
        action="append",
        required=True,
        help="Completed initial shard CSV; supply exactly four times.",
    )
    prepare_parser.add_argument("--output-root", type=Path, required=True)
    prepare_parser.add_argument(
        "--repair-processed-root",
        type=Path,
        required=True,
        help="Exact separate destination for the official repair postprocess.",
    )
    prepare_parser.add_argument("--overwrite", action="store_true")

    recheck_parser = subparsers.add_parser(
        "build-recheck",
        help="Render a second exhaustive four-shard review for repair successors.",
    )
    recheck_parser.add_argument(
        "--adjudication-root",
        type=Path,
        required=True,
    )
    recheck_parser.add_argument(
        "--repair-processed-root",
        type=Path,
        required=True,
    )
    recheck_parser.add_argument("--library-root", type=Path, required=True)
    recheck_parser.add_argument("--qa-dir", type=Path)
    recheck_parser.add_argument(
        "--contact-sheet-size",
        type=int,
        default=12,
    )
    recheck_parser.add_argument("--quiet", action="store_true")

    finalize_parser = subparsers.add_parser(
        "finalize",
        help="Publish only original passes and rechecked successor passes.",
    )
    finalize_parser.add_argument(
        "--adjudication-root",
        type=Path,
        required=True,
    )
    finalize_parser.add_argument("--dataset", type=Path, required=True)
    finalize_parser.add_argument("--library-root", type=Path, required=True)
    finalize_parser.add_argument("--repair-processed-root", type=Path)
    finalize_parser.add_argument(
        "--recheck-ledger",
        type=Path,
        action="append",
        default=[],
        help="Completed successor recheck shard CSV; supply four when needed.",
    )
    finalize_parser.add_argument("--output-root", type=Path, required=True)
    finalize_parser.add_argument("--overwrite", action="store_true")
    return parser


def validate_arguments(args: argparse.Namespace) -> None:
    if args.command == "prepare" and len(args.ledger) != REQUIRED_AUDIT_SHARDS:
        raise HardAdjudicationError(
            f"prepare requires exactly {REQUIRED_AUDIT_SHARDS} --ledger values"
        )
    if args.command == "build-recheck" and not (1 <= args.contact_sheet_size <= 64):
        raise HardAdjudicationError("--contact-sheet-size must be between 1 and 64")


def run(args: argparse.Namespace) -> dict[str, Any]:
    validate_arguments(args)
    if args.command == "prepare":
        return prepare(args)
    if args.command == "build-recheck":
        return build_recheck(args)
    if args.command == "finalize":
        return finalize(args)
    raise AssertionError(f"unhandled command: {args.command}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        result = run(args)
    except (
        HardAdjudicationError,
        FileExistsError,
        FileNotFoundError,
        OSError,
        ValueError,
    ) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
