#!/usr/bin/env python3
"""Apply exhaustive visual-audit decisions to a FontClip crop manifest.

Decision ledgers may be UTF-8 CSV or JSONL and must contain ``id`` and one of
``pass``, ``reject``, or ``recrop`` in ``decision``.  A recrop row must also
contain an absolute *source-page pixel* box (``x1``, ``y1``, ``x2``, ``y2``)
and may contain ``padding_px``.  Generated recrops are deliberately excluded
from the final manifest until they have a fresh high-precision mask and a later
ledger marks their generated ID ``pass``. Blank QA-template decisions are
treated as missing rather than malformed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


AUDIT_SCHEMA_VERSION = 1
MARKER_NAME = ".fontclip-audit"
MARKER_CONTENT = "manga-translator-fontclip-audit:v1\n"
VALID_DECISIONS = frozenset({"pass", "reject", "recrop"})
SUPPORTED_LEDGER_SUFFIXES = frozenset({".csv", ".jsonl", ".ndjson"})
STALE_RECROP_PREFIXES = (
    "ctd_",
    "detector_",
    "final_",
    "glyph_",
    "ink_",
    "mask_",
    "masked_",
    "segmentation_",
)
STALE_RECROP_FIELDS = frozenset(
    {
        "context_224_path",
        "context_dhash",
        "context_path",
        "context_sha256",
        "crop_dhash",
        "clip_image_sha256",
        "clip_sha256",
        "image_dhash",
        "image_sha256",
        "needs_mask_enrichment",
        "quality_gate",
        "raw_bbox_px",
        "raw_sha256",
        "source_crop_bbox_px",
    }
)
PRESERVED_RECROP_HASH_FIELDS = frozenset(
    {"crop_sha256", "source_image_sha256", "source_page_sha256"}
)


@dataclass(frozen=True)
class AuditDecision:
    item_id: str
    decision: str
    bbox_px: tuple[int, int, int, int] | None
    padding_px: int
    reviewer: str
    notes: str
    ledger_name: str
    ledger_sha256: str
    row_number: int
    reject_reason: str = ""
    reviewed_at: str = ""


@dataclass(frozen=True)
class RecropSpec:
    parent_id: str
    child_id: str
    bbox_px: tuple[int, int, int, int]
    padding_px: int
    decision: AuditDecision


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_within(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _read_jsonl(path: Path) -> list[tuple[int, Mapping[str, Any]]]:
    rows: list[tuple[int, Mapping[str, Any]]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {error}") from error
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: each JSONL row must be an object")
            rows.append((line_number, value))
    return rows


def _read_csv(path: Path) -> list[tuple[int, Mapping[str, Any]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path}: CSV header is missing")
        return [(line_number, dict(row)) for line_number, row in enumerate(reader, 2)]


def _read_rows(path: Path) -> list[tuple[int, Mapping[str, Any]]]:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_LEDGER_SUFFIXES:
        raise ValueError(f"unsupported ledger extension for {path}; use CSV or JSONL")
    if not path.is_file():
        raise FileNotFoundError(path)
    return _read_csv(path) if suffix == ".csv" else _read_jsonl(path)


def _integer(value: Any, *, field: str, location: str) -> int:
    if isinstance(value, bool) or value is None or value == "":
        raise ValueError(f"{location}: {field} must be an integer")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{location}: {field} must be an integer") from error
    if not math.isfinite(number) or not number.is_integer():
        raise ValueError(f"{location}: {field} must be an integer")
    return int(number)


def _optional_value(row: Mapping[str, Any], names: Sequence[str]) -> Any:
    for name in names:
        value = row.get(name)
        if value is not None and value != "":
            return value
    return None


def _parse_bbox(
    row: Mapping[str, Any], *, decision: str, location: str
) -> tuple[int, int, int, int] | None:
    # ``bbox_px`` is intentionally not an alias here. Full manifest records
    # always contain their current bbox, including pass/reject rows used as a
    # JSONL decision ledger. Only the dedicated recrop field or explicit
    # x1/y1/x2/y2 columns request a new source-page crop.
    list_value = _optional_value(row, ("recrop_bbox_px",))
    coordinate_values = tuple(row.get(name) for name in ("x1", "y1", "x2", "y2"))
    has_coordinates = any(value is not None and value != "" for value in coordinate_values)

    parsed_list: tuple[int, int, int, int] | None = None
    if list_value is not None:
        if isinstance(list_value, str):
            try:
                list_value = json.loads(list_value)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"{location}: recrop_bbox_px must be a JSON array or object"
                ) from error
        if isinstance(list_value, Mapping):
            if not all(name in list_value for name in ("x1", "y1", "x2", "y2")):
                raise ValueError(
                    f"{location}: recrop_bbox_px object must contain x1,y1,x2,y2"
                )
            list_value = [list_value[name] for name in ("x1", "y1", "x2", "y2")]
        if not isinstance(list_value, (list, tuple)) or len(list_value) != 4:
            raise ValueError(
                f"{location}: recrop_bbox_px must contain x1,y1,x2,y2"
            )
        parsed_list = tuple(
            _integer(value, field=f"recrop_bbox_px[{index}]", location=location)
            for index, value in enumerate(list_value)
        )

    parsed_coordinates: tuple[int, int, int, int] | None = None
    if has_coordinates:
        if not all(value is not None and value != "" for value in coordinate_values):
            raise ValueError(f"{location}: x1, y1, x2, and y2 must be supplied together")
        parsed_coordinates = tuple(
            _integer(value, field=name, location=location)
            for name, value in zip(("x1", "y1", "x2", "y2"), coordinate_values)
        )

    if parsed_list is not None and parsed_coordinates is not None:
        if parsed_list != parsed_coordinates:
            raise ValueError(
                f"{location}: recrop_bbox_px and x1/y1/x2/y2 disagree"
            )
    bbox = parsed_coordinates or parsed_list
    if decision == "recrop" and bbox is None:
        raise ValueError(f"{location}: recrop requires x1,y1,x2,y2")
    if decision != "recrop" and bbox is not None:
        raise ValueError(f"{location}: only recrop decisions may contain a bbox")
    if bbox is not None and (bbox[0] < 0 or bbox[1] < 0 or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]):
        raise ValueError(f"{location}: invalid source-page bbox {list(bbox)}")
    return bbox


def _parse_decision(
    row: Mapping[str, Any],
    *,
    path: Path,
    row_number: int,
    ledger_sha256: str,
) -> AuditDecision:
    location = f"{path}:{row_number}"
    item_id = _string(row.get("id")) or _string(row.get("item_id"))
    if not item_id:
        raise ValueError(f"{location}: id is required")
    decision = _string(row.get("decision")).lower()
    if decision not in VALID_DECISIONS:
        raise ValueError(
            f"{location}: decision must be one of {sorted(VALID_DECISIONS)}"
        )
    bbox = _parse_bbox(row, decision=decision, location=location)
    padding_value = _optional_value(row, ("padding_px", "padding"))
    padding = (
        _integer(padding_value, field="padding_px", location=location)
        if padding_value is not None
        else 0
    )
    if padding < 0:
        raise ValueError(f"{location}: padding_px cannot be negative")
    if decision != "recrop" and padding:
        raise ValueError(f"{location}: only recrop decisions may contain padding_px")
    return AuditDecision(
        item_id=item_id,
        decision=decision,
        bbox_px=bbox,
        padding_px=padding,
        reviewer=_string(row.get("reviewer")),
        notes=(
            _string(row.get("notes"))
            or (
                _string(row.get("reason"))
                if decision != "reject"
                else ""
            )
        ),
        ledger_name=path.name,
        ledger_sha256=ledger_sha256,
        row_number=row_number,
        reject_reason=(
            _string(row.get("reject_reason"))
            or (
                _string(row.get("reason"))
                if decision == "reject"
                else ""
            )
        ),
        reviewed_at=_string(row.get("reviewed_at")),
    )


def load_decisions(paths: Sequence[Path]) -> dict[str, AuditDecision]:
    decisions: dict[str, AuditDecision] = {}
    origins: dict[str, str] = {}
    for raw_path in paths:
        path = raw_path.resolve()
        digest = _sha256_file(path)
        for row_number, row in _read_rows(path):
            # QA emits a complete ledger template whose undecided rows have an
            # empty decision. Treat those rows as absent so partial ledgers can
            # be resumed and --require-complete can report the actual IDs still
            # needing review.
            if not _string(row.get("decision")):
                continue
            decision = _parse_decision(
                row, path=path, row_number=row_number, ledger_sha256=digest
            )
            location = f"{path}:{row_number}"
            if decision.item_id in decisions:
                raise ValueError(
                    f"duplicate decision for {decision.item_id!r}: "
                    f"{origins[decision.item_id]} and {location}"
                )
            decisions[decision.item_id] = decision
            origins[decision.item_id] = location
    return decisions


def load_manifests(paths: Sequence[Path]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    records: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    origins: dict[str, str] = {}
    for raw_path in paths:
        path = raw_path.resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        for line_number, value in _read_jsonl(path):
            item_id = _string(value.get("id"))
            if not item_id:
                raise ValueError(f"{path}:{line_number}: manifest id is required")
            if item_id in by_id:
                raise ValueError(
                    f"duplicate manifest id {item_id!r}: "
                    f"{origins[item_id]} and {path}:{line_number}"
                )
            record = dict(value)
            records.append(record)
            by_id[item_id] = record
            origins[item_id] = f"{path}:{line_number}"
    if not records:
        raise ValueError("no manifest records were loaded")
    return records, by_id


def _recrop_id(parent_id: str, bbox: tuple[int, int, int, int], padding: int) -> str:
    payload = json.dumps(
        {"parent_id": parent_id, "bbox_px": list(bbox), "padding_px": padding},
        sort_keys=True,
        separators=(",", ":"),
    )
    return "frc_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def build_recrop_specs(
    original_ids: set[str], decisions: Mapping[str, AuditDecision]
) -> tuple[dict[str, RecropSpec], set[str]]:
    """Expand deterministic recrop chains without trusting arbitrary decision IDs."""
    known = set(original_ids)
    specs: dict[str, RecropSpec] = {}
    expanded: set[str] = set()
    while True:
        changed = False
        for item_id in sorted(known - expanded):
            expanded.add(item_id)
            decision = decisions.get(item_id)
            if decision is None or decision.decision != "recrop":
                continue
            if decision.bbox_px is None:
                raise AssertionError("validated recrop decision has no bbox")
            child_id = _recrop_id(item_id, decision.bbox_px, decision.padding_px)
            existing = specs.get(child_id)
            if existing is not None and existing.parent_id != item_id:
                raise ValueError(f"manual recrop ID collision: {child_id}")
            if child_id in original_ids:
                raise ValueError(f"manual recrop ID collides with manifest ID: {child_id}")
            specs[child_id] = RecropSpec(
                parent_id=item_id,
                child_id=child_id,
                bbox_px=decision.bbox_px,
                padding_px=decision.padding_px,
                decision=decision,
            )
            if child_id not in known:
                known.add(child_id)
                changed = True
        if not changed:
            break
    return specs, known


def validate_decision_coverage(
    original_ids: set[str],
    decisions: Mapping[str, AuditDecision],
    specs: Mapping[str, RecropSpec],
    known_ids: set[str],
    *,
    require_complete: bool,
) -> None:
    unknown = sorted(set(decisions) - known_ids)
    if unknown:
        preview = ", ".join(repr(item_id) for item_id in unknown[:10])
        suffix = f" (+{len(unknown) - 10} more)" if len(unknown) > 10 else ""
        raise ValueError(f"decision ledger contains unknown IDs: {preview}{suffix}")

    if require_complete:
        missing = sorted(known_ids - set(decisions))
        if missing:
            preview = ", ".join(repr(item_id) for item_id in missing[:10])
            suffix = f" (+{len(missing) - 10} more)" if len(missing) > 10 else ""
            raise ValueError(
                "complete audit required, but decisions are missing for "
                f"{preview}{suffix}. Recrop candidates also require a second decision."
            )
    elif not set(decisions).intersection(original_ids):
        raise ValueError("decision ledgers contain no decisions for the input manifest")


def _resolve_source_page(library_root: Path, record: Mapping[str, Any]) -> Path:
    raw_relative = _string(record.get("source_image_path"))
    if not raw_relative:
        raise ValueError(f"{record.get('id')}: source_image_path is missing")
    normalized = raw_relative.replace("\\", "/")
    relative = PurePosixPath(normalized)
    if (
        relative.is_absolute()
        or ".." in relative.parts
        or not relative.parts
        or ":" in relative.parts[0]
    ):
        raise ValueError(
            f"{record.get('id')}: unsafe source_image_path {raw_relative!r}"
        )
    candidate = library_root.joinpath(*relative.parts).resolve()
    if not _is_within(library_root, candidate):
        raise ValueError(
            f"{record.get('id')}: source_image_path escapes the library root"
        )
    if not candidate.is_file():
        raise FileNotFoundError(
            f"{record.get('id')}: source page does not exist: {candidate}"
        )
    return candidate


def _rgb_image(image: Any) -> Any:
    from PIL import Image

    if image.mode == "RGB":
        return image.copy()
    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def _letterbox_image(image: Any, size: int) -> Any:
    from PIL import Image

    width, height = image.size
    scale = min(size / width, size / height)
    resized_size = (
        max(1, int(round(width * scale))),
        max(1, int(round(height * scale))),
    )
    resized = image.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    return canvas


def _crop_sha256(image: Any) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(str(image.size[0]).encode("ascii"))
    digest.update(b"x")
    digest.update(str(image.size[1]).encode("ascii"))
    digest.update(b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def _audit_history(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = record.get("audit_history")
    if raw is None:
        return []
    if not isinstance(raw, list) or any(not isinstance(item, dict) for item in raw):
        raise ValueError(f"{record.get('id')}: audit_history must be a list of objects")
    return [dict(item) for item in raw]


def _audit_event(decision: AuditDecision) -> dict[str, Any]:
    return {
        "audit_schema_version": AUDIT_SCHEMA_VERSION,
        "kind": "manual_visual_audit",
        "item_id": decision.item_id,
        "decision": decision.decision,
        "decision_ledger": decision.ledger_name,
        "decision_ledger_sha256": decision.ledger_sha256,
        "decision_row": decision.row_number,
        "reviewer": decision.reviewer or None,
        "reviewed_at": decision.reviewed_at or None,
        "reject_reason": decision.reject_reason or None,
        "notes": decision.notes or None,
    }


def _record_with_decision(
    record: Mapping[str, Any], decision: AuditDecision, status: str
) -> dict[str, Any]:
    result = dict(record)
    result["audit_history"] = [*_audit_history(record), _audit_event(decision)]
    result["audit_status"] = status
    return result


def _orientation(bbox: tuple[int, int, int, int]) -> str:
    return "vertical" if bbox[3] - bbox[1] > bbox[2] - bbox[0] else "horizontal"


def _validate_manifest_page_size(
    record: Mapping[str, Any], actual_size: tuple[int, int]
) -> None:
    raw_size = record.get("page_size_px")
    if raw_size is None:
        return
    if (
        not isinstance(raw_size, (list, tuple))
        or len(raw_size) != 2
        or any(isinstance(value, bool) for value in raw_size)
    ):
        raise ValueError(f"{record.get('id')}: invalid page_size_px in manifest")
    try:
        expected = (int(raw_size[0]), int(raw_size[1]))
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"{record.get('id')}: invalid page_size_px in manifest"
        ) from error
    if expected != actual_size:
        raise ValueError(
            f"{record.get('id')}: source page is {actual_size}, "
            f"but manifest records {expected}"
        )


def _strip_stale_recrop_fields(
    record: Mapping[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Remove every crop-derived mask/detector field invalidated by recropping."""
    clean: dict[str, Any] = {}
    removed: list[str] = []
    for key, value in record.items():
        normalized = key.casefold()
        stale = (
            normalized in STALE_RECROP_FIELDS
            or normalized.startswith(STALE_RECROP_PREFIXES)
            or normalized.endswith(("_dhash", "_phash"))
            or (
                normalized.endswith("_sha256")
                and normalized not in PRESERVED_RECROP_HASH_FIELDS
            )
        )
        if stale:
            removed.append(key)
        else:
            clean[key] = value
    return clean, sorted(removed)


def _recrop_has_fresh_mask(record: Mapping[str, Any]) -> bool:
    """Require concrete new high-precision mask assets before final acceptance."""
    if record.get("needs_mask_enrichment") is not False:
        return False
    if record.get("mask_high_precision") is not True:
        return False
    required_text_fields = (
        "glyph_224_path",
        "glyph_rgba_path",
        "glyph_mask_path",
        "glyph_sha256",
    )
    return all(_string(record.get(field)) for field in required_text_fields)


def materialize_recrop(
    parent: Mapping[str, Any],
    spec: RecropSpec,
    *,
    library_root: Path,
    dataset_root: Path,
    output_root: Path,
    physical_output_root: Path,
    letterbox_size: int,
    dry_run: bool,
) -> dict[str, Any]:
    from PIL import Image, ImageOps

    source_path = _resolve_source_page(library_root, parent)
    with Image.open(source_path) as opened:
        image = _rgb_image(ImageOps.exif_transpose(opened))
    _validate_manifest_page_size(parent, image.size)

    x1, y1, x2, y2 = spec.bbox_px
    if x2 > image.width or y2 > image.height:
        raise ValueError(
            f"{spec.parent_id}: recrop bbox {list(spec.bbox_px)} exceeds "
            f"source page {list(image.size)}"
        )
    padding = spec.padding_px
    crop_bbox = (
        max(0, x1 - padding),
        max(0, y1 - padding),
        min(image.width, x2 + padding),
        min(image.height, y2 + padding),
    )
    crop = image.crop(crop_bbox)
    pixel_hash = _crop_sha256(crop)
    split = _string(parent.get("split"))
    if split not in {"train", "val", "test"}:
        split = "unspecified"

    target_prefix = output_root.relative_to(dataset_root).as_posix()
    raw_rel = f"{target_prefix}/manual_recrops/images/raw/{split}/{spec.child_id}.png"
    clip_rel = (
        f"{target_prefix}/manual_recrops/images/clip_{letterbox_size}/"
        f"{split}/{spec.child_id}.png"
    )
    if not dry_run:
        physical_raw = (
            physical_output_root
            / "manual_recrops"
            / "images"
            / "raw"
            / split
            / f"{spec.child_id}.png"
        )
        physical_clip = (
            physical_output_root
            / "manual_recrops"
            / "images"
            / f"clip_{letterbox_size}"
            / split
            / f"{spec.child_id}.png"
        )
        physical_raw.parent.mkdir(parents=True, exist_ok=True)
        physical_clip.parent.mkdir(parents=True, exist_ok=True)
        crop.save(physical_raw, format="PNG", optimize=False)
        _letterbox_image(crop, letterbox_size).save(
            physical_clip, format="PNG", optimize=False
        )

    decision = spec.decision
    parent_with_event = _record_with_decision(
        parent, decision, "superseded_by_manual_recrop"
    )
    result, invalidated_fields = _strip_stale_recrop_fields(parent_with_event)
    original_bbox = parent.get("bbox_px")
    original_crop_bbox = parent.get("crop_bbox_px")
    result.update(
        {
            "id": spec.child_id,
            "image_path": raw_rel,
            "clip_image_path": clip_rel,
            "bbox_px": list(spec.bbox_px),
            "crop_bbox_px": list(crop_bbox),
            "page_size_px": [image.width, image.height],
            "crop_size_px": [crop.width, crop.height],
            "crop_sha256": pixel_hash,
            "orientation": _orientation(spec.bbox_px),
            "audit_status": "pending_recheck",
            "needs_mask_enrichment": True,
            "mask_enrichment_status": "required_after_manual_recrop",
            "manual_recrop_invalidated_fields": invalidated_fields,
            "manual_recrop": {
                "audit_schema_version": AUDIT_SCHEMA_VERSION,
                "supersedes_id": spec.parent_id,
                "requested_bbox_px": list(spec.bbox_px),
                "padding_px": padding,
                "previous_bbox_px": original_bbox,
                "previous_crop_bbox_px": original_crop_bbox,
                "source_image_path": parent.get("source_image_path"),
                "decision_ledger": decision.ledger_name,
                "decision_ledger_sha256": decision.ledger_sha256,
                "decision_row": decision.row_number,
                "reviewer": decision.reviewer or None,
                "reviewed_at": decision.reviewed_at or None,
                "notes": decision.notes or None,
            },
        }
    )
    result["audit_history"] = [
        *result["audit_history"],
        {
            "audit_schema_version": AUDIT_SCHEMA_VERSION,
            "kind": "manual_recrop_generated",
            "item_id": spec.child_id,
            "supersedes_id": spec.parent_id,
            "bbox_px": list(spec.bbox_px),
            "padding_px": padding,
        },
    ]
    return result


def _write_jsonl(path: Path, records: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(
                json.dumps(
                    record,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def _recrop_decision_rows(
    rechecks: Sequence[Mapping[str, Any]],
    decisions: Mapping[str, AuditDecision],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for audit_index, record in enumerate(rechecks, 1):
        item_id = _string(record.get("id"))
        decision = decisions.get(item_id)
        manual = record.get("manual_recrop")
        parent_id = (
            _string(manual.get("supersedes_id"))
            if isinstance(manual, Mapping)
            else ""
        )
        rows.append(
            {
                "audit_index": audit_index,
                "id": item_id,
                "supersedes_id": parent_id,
                "image_path": _string(record.get("image_path")),
                "clip_image_path": _string(record.get("clip_image_path")),
                "crop_sha256": _string(record.get("crop_sha256")),
                "needs_mask_enrichment": bool(
                    record.get("needs_mask_enrichment")
                ),
                "mask_enrichment_status": _string(
                    record.get("mask_enrichment_status")
                ),
                "decision": decision.decision if decision is not None else "",
                "reject_reason": (
                    decision.reject_reason if decision is not None else ""
                ),
                "recrop_bbox_px": (
                    list(decision.bbox_px)
                    if decision is not None
                    and decision.decision == "recrop"
                    and decision.bbox_px is not None
                    else None
                ),
                "padding_px": (
                    decision.padding_px
                    if decision is not None and decision.decision == "recrop"
                    else 0
                ),
                "reviewer": decision.reviewer if decision is not None else "",
                "reviewed_at": (
                    decision.reviewed_at if decision is not None else ""
                ),
                "notes": decision.notes if decision is not None else "",
            }
        )
    return rows


def _write_recrop_decision_ledgers(
    output_root: Path,
    rechecks: Sequence[Mapping[str, Any]],
    decisions: Mapping[str, AuditDecision],
) -> None:
    rows = _recrop_decision_rows(rechecks, decisions)
    _write_jsonl(output_root / "recrop_recheck_ledger.jsonl", rows)
    fieldnames = [
        "audit_index",
        "id",
        "supersedes_id",
        "image_path",
        "clip_image_path",
        "crop_sha256",
        "needs_mask_enrichment",
        "mask_enrichment_status",
        "decision",
        "reject_reason",
        "recrop_bbox_px",
        "padding_px",
        "reviewer",
        "reviewed_at",
        "notes",
    ]
    with (output_root / "recrop_recheck_ledger.csv").open(
        "w", encoding="utf-8", newline=""
    ) as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=fieldnames,
            extrasaction="ignore",
            lineterminator="\n",
        )
        writer.writeheader()
        for row in rows:
            csv_row = dict(row)
            bbox = csv_row.get("recrop_bbox_px")
            csv_row["recrop_bbox_px"] = (
                json.dumps(bbox, separators=(",", ":"))
                if bbox is not None
                else ""
            )
            writer.writerow(csv_row)


def _validate_output_target(
    dataset_root: Path, output_root: Path, *, overwrite: bool, dry_run: bool
) -> Path:
    audits_root = (dataset_root / "audits").resolve()
    output = output_root.resolve()
    if output == audits_root or not _is_within(audits_root, output):
        raise ValueError(
            f"output must be a child of the dataset audits directory: {audits_root}"
        )
    if output.is_symlink():
        raise ValueError(f"refusing symlink output target: {output}")
    if output.exists():
        if dry_run:
            return audits_root
        if not overwrite:
            raise FileExistsError(f"output already exists; pass --overwrite: {output}")
        marker = output / MARKER_NAME
        if (
            not marker.is_file()
            or marker.read_text(encoding="utf-8") != MARKER_CONTENT
        ):
            raise RuntimeError(
                f"refusing overwrite without the exact audit marker: {marker}"
            )
    return audits_root


def _new_staging_root(audits_root: Path) -> Path:
    audits_root.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=".fontclip-audit-staging-", dir=audits_root)
    ).resolve()
    if not _is_within(audits_root, staging):
        raise RuntimeError("temporary audit directory escaped audits root")
    (staging / MARKER_NAME).write_text(
        MARKER_CONTENT, encoding="utf-8", newline="\n"
    )
    return staging


def _commit_staging(
    staging: Path, output_root: Path, audits_root: Path, *, overwrite: bool
) -> None:
    output = output_root.resolve()
    if not _is_within(audits_root, staging) or not _is_within(audits_root, output):
        raise RuntimeError("unsafe audit commit paths")
    output.parent.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if output.exists():
        marker = output / MARKER_NAME
        if (
            not overwrite
            or not marker.is_file()
            or marker.read_text(encoding="utf-8") != MARKER_CONTENT
        ):
            raise RuntimeError(f"refusing to replace unmarked audit output: {output}")
        backup = audits_root / f"{staging.name}-previous"
        if backup.exists():
            raise RuntimeError(f"unexpected audit backup path already exists: {backup}")
        output.replace(backup)
    try:
        staging.replace(output)
    except BaseException:
        if backup is not None and backup.exists() and not output.exists():
            backup.replace(output)
        raise
    if backup is not None:
        marker = backup / MARKER_NAME
        if (
            not _is_within(audits_root, backup)
            or not marker.is_file()
            or marker.read_text(encoding="utf-8") != MARKER_CONTENT
        ):
            raise RuntimeError(f"refusing unsafe audit backup cleanup: {backup}")
        shutil.rmtree(backup)


def adjudicate(
    records: Sequence[Mapping[str, Any]],
    decisions: Mapping[str, AuditDecision],
    specs: Mapping[str, RecropSpec],
    *,
    library_root: Path,
    dataset_root: Path,
    output_root: Path,
    physical_output_root: Path,
    letterbox_size: int,
    dry_run: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    accepted: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    rechecks: list[dict[str, Any]] = []

    for original in records:
        current = dict(original)
        visited: set[str] = set()
        while True:
            item_id = _string(current.get("id"))
            if item_id in visited:
                raise RuntimeError(f"recrop decision cycle at {item_id}")
            visited.add(item_id)
            decision = decisions.get(item_id)
            is_recrop_candidate = item_id in specs
            if decision is None:
                status = (
                    "pending_recheck" if is_recrop_candidate else "unreviewed"
                )
                pending = dict(current)
                pending["audit_status"] = status
                excluded.append(pending)
                if is_recrop_candidate:
                    recheck = dict(pending)
                    recheck["recheck_decision"] = "pending"
                    rechecks.append(recheck)
                break

            if decision.decision == "pass":
                if is_recrop_candidate and not _recrop_has_fresh_mask(current):
                    pending_mask = _record_with_decision(
                        current,
                        decision,
                        "pending_mask_enrichment",
                    )
                    pending_mask["recheck_decision"] = "pass"
                    pending_mask["recheck_result"] = (
                        "second_review_passed_but_fresh_mask_is_required"
                    )
                    excluded.append(pending_mask)
                    rechecks.append(dict(pending_mask))
                    break
                passed = _record_with_decision(current, decision, "accepted")
                accepted.append(passed)
                if is_recrop_candidate:
                    recheck = dict(passed)
                    recheck["recheck_decision"] = "pass"
                    rechecks.append(recheck)
                break

            if decision.decision == "reject":
                rejected = _record_with_decision(current, decision, "rejected")
                excluded.append(rejected)
                if is_recrop_candidate:
                    recheck = dict(rejected)
                    recheck["recheck_decision"] = "reject"
                    rechecks.append(recheck)
                break

            spec = specs.get(_recrop_id(item_id, decision.bbox_px, decision.padding_px))  # type: ignore[arg-type]
            if spec is None or spec.parent_id != item_id:
                raise RuntimeError(f"missing recrop specification for {item_id}")
            superseded = _record_with_decision(
                current, decision, "superseded_by_manual_recrop"
            )
            superseded["manual_recrop_successor_id"] = spec.child_id
            excluded.append(superseded)
            if is_recrop_candidate:
                recheck = dict(superseded)
                recheck["recheck_decision"] = "recrop"
                rechecks.append(recheck)
            current = materialize_recrop(
                current,
                spec,
                library_root=library_root,
                dataset_root=dataset_root,
                output_root=output_root,
                physical_output_root=physical_output_root,
                letterbox_size=letterbox_size,
                dry_run=dry_run,
            )

    return accepted, excluded, rechecks


def build_argument_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
First pass (recrops remain pending and require fresh mask enrichment):
  python scripts/adjudicate_fontclip_audit.py --dataset-root datasets/fontclip-source-v1 \\
    --decisions audit-first-pass.csv

Second review (edit recrop_recheck_ledger.csv or .jsonl):
  python scripts/adjudicate_fontclip_audit.py --dataset-root datasets/fontclip-source-v1 \\
    --decisions audit-first-pass.csv recrop_recheck_ledger.csv \\
    --require-complete --overwrite

A recrop remains excluded with pending_mask_enrichment even after pass until
fresh high-precision glyph/mask fields replace its invalidated derived fields.
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
        "--manifest",
        dest="manifests",
        type=Path,
        action="extend",
        nargs="+",
        help="one or more input JSONL manifests (default: DATASET_ROOT/manifest.jsonl)",
    )
    parser.add_argument(
        "--decision-ledger",
        "--decisions",
        dest="decision_ledgers",
        type=Path,
        action="extend",
        nargs="+",
        required=True,
        help="one or more CSV/JSONL ledgers; IDs must be globally unique",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        help="must be below DATASET_ROOT/audits (default: .../audits/manual-v1)",
    )
    parser.add_argument("--letterbox-size", type=int, default=224)
    parser.add_argument(
        "--require-complete",
        action="store_true",
        help=(
            "fail unless every original and every generated recrop ID has exactly "
            "one decision"
        ),
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and calculate all results without writing or deleting files",
    )
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    dataset_root = args.dataset_root.resolve()
    library_root = args.library_root.resolve()
    if not dataset_root.is_dir():
        raise FileNotFoundError(f"dataset root does not exist: {dataset_root}")
    if not library_root.is_dir():
        raise FileNotFoundError(f"library root does not exist: {library_root}")
    if args.letterbox_size < 1:
        raise ValueError("--letterbox-size must be positive")

    manifests = (
        [path.resolve() for path in args.manifests]
        if args.manifests
        else [(dataset_root / "manifest.jsonl").resolve()]
    )
    output_root = (
        args.output_root.resolve()
        if args.output_root
        else (dataset_root / "audits" / "manual-v1").resolve()
    )
    records, by_id = load_manifests(manifests)
    decisions = load_decisions(args.decision_ledgers)
    specs, known_ids = build_recrop_specs(set(by_id), decisions)
    validate_decision_coverage(
        set(by_id),
        decisions,
        specs,
        known_ids,
        require_complete=args.require_complete,
    )
    audits_root = _validate_output_target(
        dataset_root,
        output_root,
        overwrite=args.overwrite,
        dry_run=args.dry_run,
    )

    staging: Path | None = None
    physical_output = output_root
    try:
        if not args.dry_run:
            staging = _new_staging_root(audits_root)
            physical_output = staging
        accepted, excluded, rechecks = adjudicate(
            records,
            decisions,
            specs,
            library_root=library_root,
            dataset_root=dataset_root,
            output_root=output_root,
            physical_output_root=physical_output,
            letterbox_size=args.letterbox_size,
            dry_run=args.dry_run,
        )
        summary: dict[str, Any] = {
            "audit_schema_version": AUDIT_SCHEMA_VERSION,
            "dry_run": bool(args.dry_run),
            "dataset_root": str(dataset_root),
            "library_root": str(library_root),
            "input_manifests": [str(path) for path in manifests],
            "decision_ledgers": [
                {
                    "path": str(path.resolve()),
                    "sha256": _sha256_file(path.resolve()),
                }
                for path in args.decision_ledgers
            ],
            "input_records": len(records),
            "decisions": len(decisions),
            "accepted_records": len(accepted),
            "excluded_records": len(excluded),
            "generated_recrops": len(specs),
            "recrop_rechecks": len(rechecks),
            "pending_original_decisions": sum(
                1 for item_id in by_id if item_id not in decisions
            ),
            "pending_recrop_decisions": sum(
                1 for item_id in specs if item_id not in decisions
            ),
            "pending_mask_enrichment": sum(
                1
                for record in rechecks
                if record.get("needs_mask_enrichment") is True
            ),
            "require_complete": bool(args.require_complete),
            "output_root": str(output_root),
            "final_manifest": "final_accepted_manifest.jsonl",
            "rejected_ledger": "rejected_ledger.jsonl",
            "recrop_recheck_manifest": "recrop_recheck_manifest.jsonl",
            "recrop_recheck_ledger_csv": "recrop_recheck_ledger.csv",
            "recrop_recheck_ledger_jsonl": "recrop_recheck_ledger.jsonl",
        }
        if not args.dry_run:
            if staging is None:
                raise AssertionError("staging output was not created")
            _write_jsonl(staging / "final_accepted_manifest.jsonl", accepted)
            _write_jsonl(staging / "rejected_ledger.jsonl", excluded)
            _write_jsonl(staging / "recrop_recheck_manifest.jsonl", rechecks)
            _write_recrop_decision_ledgers(staging, rechecks, decisions)
            _write_json(staging / "audit_summary.json", summary)
            _commit_staging(
                staging, output_root, audits_root, overwrite=args.overwrite
            )
            staging = None
        return summary
    finally:
        if staging is not None and staging.exists():
            if not _is_within(audits_root, staging):
                raise RuntimeError(f"refusing unsafe staging cleanup: {staging}")
            shutil.rmtree(staging)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        summary = run(args)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"error: {error}\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
