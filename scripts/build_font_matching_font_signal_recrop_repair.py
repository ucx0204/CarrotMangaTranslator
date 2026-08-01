#!/usr/bin/env python3
"""Build a sealed, review-only repair proposal set for font-signal defects.

The builder is intentionally upstream of the real recrop queue.  It binds the
human ``needs_recrop`` decisions to the v3 font-signal audit, the exact v3
master row, and hash-verified library pages.  It writes only direct crops from
those pages plus sealed evidence and an empty human-review ledger.  Nothing in
the output is training eligible and no proposal is promoted automatically.
"""

from __future__ import annotations

import argparse
import copy
import csv
import io
import json
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

import build_font_matching_recrop_repair as repair


SCHEMA_VERSION = "font-matching-font-signal-recrop-repair-proposals-v1"
OWNER = "carrot-manga-translator/font-signal-recrop-repair-proposals"
MARKER_FILE = ".font-matching-font-signal-recrop-repair-owned.json"
PROPOSALS_FILE = "proposals.jsonl"
TERMINAL_FILE = "terminal-replacements.jsonl"
LEDGER_FILE = "review-ledger-template.csv"
REPORT_FILE = "report.json"
EVIDENCE_DIR = "evidence"
PREVIEW_DIR = "direct-previews"
CONTEXT_DIR = "source-context"
SINGLE_ORIENTATIONS = frozenset({"horizontal", "vertical"})
TERMINAL_CATEGORIES = frozenset(
    {
        "promo_overlay",
        "decorated_work_title",
        "issue_badge_sidebar",
        "mixed_editorial_noncontent",
    }
)


class FontSignalRepairError(ValueError):
    """Raised when the sealed proposal contract cannot be proven."""


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


def _validate_v3_audit_seal(record: Mapping[str, Any], label: str) -> None:
    """The v3 rescue builder seals records over canonical JSON plus one LF."""

    expected = repair.require_sha(record.get("record_sha256"), f"{label}.record_sha256")
    core = copy.deepcopy(dict(record))
    core.pop("record_sha256", None)
    actual = repair.sha256_bytes((canonical_json(core) + "\n").encode("utf-8"))
    if actual != expected:
        raise FontSignalRepairError(f"{label}: record seal mismatch")


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
                    raise FontSignalRepairError(
                        f"{label}:{line_number}: invalid JSON: {error}"
                    ) from error
                if not isinstance(value, Mapping):
                    raise FontSignalRepairError(
                        f"{label}:{line_number}: expected an object"
                    )
                rows.append(dict(value))
    except OSError as error:
        raise FontSignalRepairError(
            f"{label}: could not read {path}: {error}"
        ) from error
    if not rows:
        raise FontSignalRepairError(f"{label}: JSONL is empty")
    return rows


def _unique(
    rows: Sequence[dict[str, Any]], key: str, label: str
) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        value = repair.require_text(row.get(key), f"{label}:{index}.{key}")
        if value in output:
            raise FontSignalRepairError(f"{label}:{index}: duplicate {key} {value}")
        output[value] = row
    return output


def _safe_relative_path(value: Any, label: str) -> PurePosixPath:
    text = repair.require_text(value, label).replace("\\", "/")
    posix = PurePosixPath(text)
    windows = PureWindowsPath(text)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
        or ".." in posix.parts
    ):
        raise FontSignalRepairError(f"{label}: unsafe relative path")
    return posix


def _safe_managed_path(root: Path, value: Any, label: str) -> Path:
    relative = _safe_relative_path(value, label)
    path = root.joinpath(*relative.parts)
    if path.is_symlink():
        raise FontSignalRepairError(f"{label}: symlinks are forbidden")
    return path


def _require_bbox(value: Any, label: str) -> tuple[int, int, int, int]:
    try:
        return repair.require_bbox(value, label)
    except repair.RecropRepairError as error:
        raise FontSignalRepairError(str(error)) from error


def _load_needs_recrop(path: Path, expected: int) -> dict[str, dict[str, Any]]:
    all_rows = _unique(
        _read_jsonl(path, "font-signal human review"),
        "sample_id",
        "font-signal human review",
    )
    selected: dict[str, dict[str, Any]] = {}
    for sample_id, row in all_rows.items():
        if row.get("outcome") != "needs_recrop":
            continue
        if row.get("decision_source") != "human_visual_review":
            raise FontSignalRepairError(
                f"human review[{sample_id}]: decision is not human visual review"
            )
        evidence = row.get("evidence_checked")
        if not isinstance(evidence, list) or "source_page" not in evidence:
            raise FontSignalRepairError(
                f"human review[{sample_id}]: source page was not checked"
            )
        repair.require_sha(
            row.get("source_audit_record_sha256"),
            f"human review[{sample_id}].source_audit_record_sha256",
        )
        repair.require_text(
            row.get("rationale"), f"human review[{sample_id}].rationale"
        )
        repair.require_text(row.get("reviewer"), f"human review[{sample_id}].reviewer")
        repair._review_time(
            row.get("reviewed_at"), f"human review[{sample_id}].reviewed_at"
        )
        selected[sample_id] = row
    if len(selected) != expected:
        raise FontSignalRepairError(
            f"expected {expected} needs_recrop rows, got {len(selected)}"
        )
    return selected


def _load_audits(
    path: Path, reviews: Mapping[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    all_rows = _unique(
        _read_jsonl(path, "font-signal audit v3"), "sample_id", "font-signal audit v3"
    )
    output: dict[str, dict[str, Any]] = {}
    for sample_id, review in reviews.items():
        row = all_rows.get(sample_id)
        if row is None:
            raise FontSignalRepairError(f"font-signal audit v3 lacks {sample_id}")
        _validate_v3_audit_seal(row, f"font-signal audit v3[{sample_id}]")
        provenance = row.get("provenance")
        decision = row.get("decision_contract")
        if (
            row.get("schema_version") != "font-matching-catalog-delta-review-inputs-v3"
            or row.get("record_type") != "font_signal_identifiability_audit"
            or row.get("status") != "pending_human_audit"
            or not isinstance(provenance, Mapping)
            or provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
            or not isinstance(decision, Mapping)
            or decision.get("new_candidate_review_blocked_until_resolved") is not True
        ):
            raise FontSignalRepairError(
                f"font-signal audit v3[{sample_id}]: unsafe audit contract"
            )
        if review.get("source_audit_record_sha256") != row.get("record_sha256"):
            raise FontSignalRepairError(
                f"font-signal audit v3[{sample_id}]: human review binding drifted"
            )
        output[sample_id] = row
    return output


def _load_master(
    path: Path, audits: Mapping[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    all_rows = _unique(_read_jsonl(path, "v3 master"), "id", "v3 master")
    output: dict[str, dict[str, Any]] = {}
    for sample_id, audit in audits.items():
        row = all_rows.get(sample_id)
        if row is None:
            raise FontSignalRepairError(f"v3 master lacks {sample_id}")
        provenance = row.get("provenance")
        if (
            row.get("schema_version") != 1
            or row.get("catalog_version") != 1
            or not isinstance(provenance, Mapping)
            or provenance.get("approval") != "exhaustive_manual_visual_review"
            or provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise FontSignalRepairError(
                f"v3 master[{sample_id}]: master provenance/binding drifted"
            )
        evidence = audit.get("evidence")
        geometry = row.get("geometry")
        page = row.get("page")
        if (
            not isinstance(evidence, Mapping)
            or not isinstance(geometry, Mapping)
            or not isinstance(page, Mapping)
        ):
            raise FontSignalRepairError(
                f"v3 master[{sample_id}]: missing geometry/page evidence"
            )
        if geometry != evidence.get("geometry") or page.get(
            "source_page_sha256"
        ) != audit.get("source_page_sha256"):
            raise FontSignalRepairError(
                f"v3 master[{sample_id}]: audit geometry/page binding drifted"
            )
        output[sample_id] = row
    return output


def _load_plan(path: Path, target_ids: set[str]) -> dict[str, dict[str, Any]]:
    rows = _unique(
        _read_jsonl(path, "repair proposal plan"), "sample_id", "repair proposal plan"
    )
    if set(rows) != target_ids:
        raise FontSignalRepairError(
            "proposal plan target set differs; "
            f"missing={sorted(target_ids - set(rows))[:8]} extra={sorted(set(rows) - target_ids)[:8]}"
        )
    for sample_id, row in rows.items():
        if (
            row.get("schema_version") != SCHEMA_VERSION
            or row.get("record_type") != "font_signal_recrop_repair_plan"
        ):
            raise FontSignalRepairError(f"repair plan[{sample_id}]: invalid contract")
        action = row.get("action")
        if action not in {"recrop", "terminal_replacement"}:
            raise FontSignalRepairError(f"repair plan[{sample_id}]: invalid action")
        if (
            row.get("viewed_original") is not True
            or row.get("source_pixels") != "hash_verified_library_page_only"
        ):
            raise FontSignalRepairError(
                f"repair plan[{sample_id}]: source-page review attestation missing"
            )
        repair.require_text(row.get("rationale"), f"repair plan[{sample_id}].rationale")
        repair.require_text(row.get("reviewer"), f"repair plan[{sample_id}].reviewer")
        repair._review_time(
            row.get("reviewed_at"), f"repair plan[{sample_id}].reviewed_at"
        )
        if action == "recrop":
            _require_bbox(
                row.get("recrop_bbox_px"), f"repair plan[{sample_id}].recrop_bbox_px"
            )
            if (
                row.get("orientation") not in SINGLE_ORIENTATIONS
                or row.get("terminal_category") is not None
            ):
                raise FontSignalRepairError(
                    f"repair plan[{sample_id}]: malformed recrop disposition"
                )
            if row.get("target_semantics") != "one_complete_single_style_text_block":
                raise FontSignalRepairError(
                    f"repair plan[{sample_id}]: recrop semantics are not explicit"
                )
        else:
            if (
                row.get("recrop_bbox_px") is not None
                or row.get("orientation") is not None
            ):
                raise FontSignalRepairError(
                    f"repair plan[{sample_id}]: terminal proposal claims a crop"
                )
            if row.get("terminal_category") not in TERMINAL_CATEGORIES:
                raise FontSignalRepairError(
                    f"repair plan[{sample_id}]: invalid terminal category"
                )
    return rows


def _resolve_page(
    *,
    audit: Mapping[str, Any],
    master: Mapping[str, Any],
    library_root: Path,
    sample_id: str,
) -> tuple[
    Path, bytes, Image.Image, tuple[int, int, int, int], tuple[int, int, int, int]
]:
    evidence = audit["evidence"]
    locator = evidence["source_page_locator"]
    relative = _safe_relative_path(
        locator.get("path"), f"audit[{sample_id}].source_page_locator.path"
    )
    physical = library_root.joinpath(*relative.parts).resolve()
    try:
        physical.relative_to(library_root.resolve())
    except ValueError as error:
        raise FontSignalRepairError(
            f"audit[{sample_id}]: source page escapes library"
        ) from error
    if not physical.is_file() or physical.is_symlink():
        raise FontSignalRepairError(f"audit[{sample_id}]: missing/unsafe library page")
    payload = physical.read_bytes()
    expected_sha = repair.require_sha(
        locator.get("file_sha256"), f"audit[{sample_id}].locator.file_sha256"
    )
    if repair.sha256_bytes(payload) != expected_sha or expected_sha != audit.get(
        "source_page_sha256"
    ):
        raise FontSignalRepairError(f"audit[{sample_id}]: library page hash drifted")
    if (
        locator.get("provenance") != "real_preserved"
        or locator.get("storage_root") != "library_root"
    ):
        raise FontSignalRepairError(
            f"audit[{sample_id}]: source is not a preserved real library page"
        )
    try:
        with Image.open(physical) as opened:
            decoded = ImageOps.exif_transpose(opened).convert("RGB")
            decoded.load()
    except (OSError, UnidentifiedImageError) as error:
        raise FontSignalRepairError(
            f"audit[{sample_id}]: source page decode failed"
        ) from error
    size = [decoded.width, decoded.height]
    geometry = evidence["geometry"]
    if locator.get("size_px") != size or geometry.get("page_size_px") != size:
        decoded.close()
        raise FontSignalRepairError(f"audit[{sample_id}]: decoded page size drifted")
    if locator.get("size_bytes") != len(payload):
        decoded.close()
        raise FontSignalRepairError(
            f"audit[{sample_id}]: source page byte size drifted"
        )
    master_locator = master["page"]["source_locator"]
    if master_locator != locator:
        decoded.close()
        raise FontSignalRepairError(f"audit[{sample_id}]: v3 master locator drifted")
    current = _require_bbox(
        geometry.get("bbox_px"), f"audit[{sample_id}].geometry.bbox_px"
    )
    current_crop = _require_bbox(
        geometry.get("crop_bbox_px"), f"audit[{sample_id}].geometry.crop_bbox_px"
    )
    return physical, payload, decoded, current, current_crop


def _check_bbox(
    bbox: tuple[int, int, int, int], image: Image.Image, label: str
) -> None:
    if not (
        0 <= bbox[0] < bbox[2] <= image.width and 0 <= bbox[1] < bbox[3] <= image.height
    ):
        raise FontSignalRepairError(f"{label}: bbox exceeds decoded page: {list(bbox)}")


def _context_bbox(
    current: tuple[int, int, int, int],
    preview: tuple[int, int, int, int],
    page_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    x1 = min(current[0], preview[0])
    y1 = min(current[1], preview[1])
    x2 = max(current[2], preview[2])
    y2 = max(current[3], preview[3])
    margin = max(80, round(max(x2 - x1, y2 - y1) * 0.45))
    return (
        max(0, x1 - margin),
        max(0, y1 - margin),
        min(page_size[0], x2 + margin),
        min(page_size[1], y2 + margin),
    )


def _png_crop(image: Image.Image, bbox: tuple[int, int, int, int]) -> bytes:
    crop = image.crop(bbox).convert("RGB")
    try:
        return repair.hard_audit.encode_png(crop)
    finally:
        crop.close()


def _managed_files(root: Path) -> dict[str, str]:
    output: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise FontSignalRepairError(f"output contains a symlink: {path}")
        if path.is_file() and path.name != MARKER_FILE:
            output[path.relative_to(root).as_posix()] = sha256_file(path)
    return output


def _ledger_bytes(proposals: Sequence[Mapping[str, Any]]) -> bytes:
    stream = io.StringIO(newline="")
    fieldnames = [
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
    ]
    writer = csv.DictWriter(stream, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in proposals:
        writer.writerow(
            {
                "sample_id": row["sample_id"],
                "proposed_action": row["action"],
                "proposed_bbox_px": canonical_json(row.get("recrop_bbox_px")),
                "preview_path": row["direct_preview"]["path"],
                "preview_sha256": row["direct_preview"]["file_sha256"],
                "allowed_decisions": "accept_proposal|revise_bbox|confirm_terminal|restore_repair|reject",
                "decision": "",
                "revision_bbox_px": "",
                "reviewer": "",
                "reviewed_at": "",
                "notes": "",
            }
        )
    return stream.getvalue().encode("utf-8")


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    human_review: Path,
    audit_v3: Path,
    master_v3: Path,
    plan_path: Path,
    library_root: Path,
    expected_targets: int,
) -> dict[str, Any]:
    builder_source_sha256 = sha256_file(Path(__file__).resolve())
    reviews = _load_needs_recrop(human_review, expected_targets)
    audits = _load_audits(audit_v3, reviews)
    masters = _load_master(master_v3, audits)
    plans = _load_plan(plan_path, set(reviews))
    physical_root.mkdir(parents=True, exist_ok=False)
    (physical_root / EVIDENCE_DIR).mkdir()
    (physical_root / PREVIEW_DIR).mkdir()
    (physical_root / CONTEXT_DIR).mkdir()

    proposal_rows: list[dict[str, Any]] = []
    terminal_rows: list[dict[str, Any]] = []
    for sample_id in sorted(reviews):
        review = reviews[sample_id]
        audit = audits[sample_id]
        master = masters[sample_id]
        plan = plans[sample_id]
        physical, page_bytes, decoded, current_bbox, current_crop = _resolve_page(
            audit=audit, master=master, library_root=library_root, sample_id=sample_id
        )
        try:
            action = str(plan["action"])
            if action == "recrop":
                preview_bbox = _require_bbox(
                    plan["recrop_bbox_px"], f"plan[{sample_id}].recrop_bbox_px"
                )
                if preview_bbox == current_bbox:
                    raise FontSignalRepairError(f"plan[{sample_id}]: recrop is a no-op")
            else:
                preview_bbox = current_crop
            _check_bbox(preview_bbox, decoded, f"plan[{sample_id}].preview")
            context_bbox = _context_bbox(
                current_bbox, preview_bbox, (decoded.width, decoded.height)
            )
            preview_bytes = _png_crop(decoded, preview_bbox)
            context_bytes = _png_crop(decoded, context_bbox)
            preview_name = f"{sample_id}.png"
            preview_path = physical_root / PREVIEW_DIR / preview_name
            context_path = physical_root / CONTEXT_DIR / preview_name
            preview_path.write_bytes(preview_bytes)
            context_path.write_bytes(context_bytes)
            common = {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_signal_recrop_repair_proposal",
                "sample_id": sample_id,
                "status": "pending_direct_visual_review",
                "action": action,
                "recrop_bbox_px": list(preview_bbox) if action == "recrop" else None,
                "orientation": plan.get("orientation"),
                "target_semantics": plan.get("target_semantics"),
                "terminal_category": plan.get("terminal_category"),
                "rationale": plan["rationale"],
                "current_bbox_px": list(current_bbox),
                "current_crop_bbox_px": list(current_crop),
                "coordinate_space": "source_page_pixels_xyxy_half_open",
                "source_page": {
                    "path": audit["evidence"]["source_page_locator"]["path"],
                    "file_sha256": repair.sha256_bytes(page_bytes),
                    "size_bytes": len(page_bytes),
                    "size_px": [decoded.width, decoded.height],
                    "decoded_mode": "RGB",
                    "provenance": "real_preserved",
                    "storage_root": "library_root",
                    "physical_path_review_only": str(physical),
                },
                "direct_preview": {
                    "path": f"{PREVIEW_DIR}/{preview_name}",
                    "bbox_px": list(preview_bbox),
                    "file_sha256": repair.sha256_bytes(preview_bytes),
                    "decoded_mode": "RGB",
                    "size_px": [
                        preview_bbox[2] - preview_bbox[0],
                        preview_bbox[3] - preview_bbox[1],
                    ],
                    "pixel_source": "direct_hash_verified_library_page_crop",
                    "qa_overlay": False,
                    "synthetic": False,
                },
                "source_context": {
                    "path": f"{CONTEXT_DIR}/{preview_name}",
                    "bbox_px": list(context_bbox),
                    "file_sha256": repair.sha256_bytes(context_bytes),
                    "decoded_mode": "RGB",
                    "size_px": [
                        context_bbox[2] - context_bbox[0],
                        context_bbox[3] - context_bbox[1],
                    ],
                    "pixel_source": "direct_hash_verified_library_page_crop",
                    "qa_overlay": False,
                    "synthetic": False,
                },
                "bindings": {
                    "builder_source_sha256": builder_source_sha256,
                    "human_review_file_sha256": sha256_file(human_review),
                    "human_review_record_sha256": sha256_json(review),
                    "source_audit_file_sha256": sha256_file(audit_v3),
                    "source_audit_record_sha256": audit["record_sha256"],
                    "master_file_sha256": sha256_file(master_v3),
                    "master_record_sha256": sha256_json(master),
                    "proposal_plan_file_sha256": sha256_file(plan_path),
                    "proposal_plan_record_sha256": sha256_json(plan),
                },
                "review_attestation": {
                    "reviewer": plan["reviewer"],
                    "reviewed_at": plan["reviewed_at"],
                    "viewed_original": True,
                    "source_pixels": "hash_verified_library_page_only",
                },
                "training_eligible": False,
                "promotion_allowed": False,
            }
            sealed = seal(common)
            proposal_rows.append(sealed)
            if action == "terminal_replacement":
                terminal_rows.append(sealed)
        finally:
            decoded.close()

    snapshots = {
        "human-review.jsonl": [copy.deepcopy(reviews[sid]) for sid in sorted(reviews)],
        "font-signal-audit-v3.jsonl": [
            copy.deepcopy(audits[sid]) for sid in sorted(audits)
        ],
        "master-v3.jsonl": [copy.deepcopy(masters[sid]) for sid in sorted(masters)],
        "proposal-plan.jsonl": [copy.deepcopy(plans[sid]) for sid in sorted(plans)],
    }
    for name, rows in snapshots.items():
        (physical_root / EVIDENCE_DIR / name).write_bytes(jsonl_bytes(rows))
    (physical_root / PROPOSALS_FILE).write_bytes(jsonl_bytes(proposal_rows))
    (physical_root / TERMINAL_FILE).write_bytes(jsonl_bytes(terminal_rows))
    (physical_root / LEDGER_FILE).write_bytes(_ledger_bytes(proposal_rows))

    action_counts = Counter(str(row["action"]) for row in proposal_rows)
    terminal_counts = Counter(str(row["terminal_category"]) for row in terminal_rows)
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_signal_recrop_repair_proposal_report",
            "inputs": {
                "builder_source_sha256": builder_source_sha256,
                "human_review": {
                    "path": str(human_review),
                    "sha256": sha256_file(human_review),
                },
                "font_signal_audit_v3": {
                    "path": str(audit_v3),
                    "sha256": sha256_file(audit_v3),
                },
                "master_v3": {"path": str(master_v3), "sha256": sha256_file(master_v3)},
                "proposal_plan": {
                    "path": str(plan_path),
                    "sha256": sha256_file(plan_path),
                },
                "library_root": str(library_root),
            },
            "counts": {
                "targets": len(proposal_rows),
                "actions": dict(sorted(action_counts.items())),
                "terminal_categories": dict(sorted(terminal_counts.items())),
                "direct_previews": len(proposal_rows),
                "source_contexts": len(proposal_rows),
                "pending_review": len(proposal_rows),
            },
            "outputs": {
                "proposals": PROPOSALS_FILE,
                "proposals_sha256": sha256_file(physical_root / PROPOSALS_FILE),
                "terminal_replacements": TERMINAL_FILE,
                "terminal_replacements_sha256": sha256_file(
                    physical_root / TERMINAL_FILE
                ),
                "review_ledger_template": LEDGER_FILE,
                "review_ledger_template_sha256": sha256_file(
                    physical_root / LEDGER_FILE
                ),
            },
            "next_step": {
                "requires_exhaustive_direct_preview_review": True,
                "review_ledger_must_be_completed": True,
                "build_real_repair_queue_after_review_only": True,
                "training_eligible": False,
                "promoted": False,
            },
            "safety": {
                "prior_v1_v3_artifacts_modified": False,
                "source_pages_modified": False,
                "source_pixels": "hash_verified_library_pages_only",
                "qa_overlays_written": 0,
                "qa_overlays_used_as_pixels": 0,
                "synthetic_assets_written": 0,
                "generated_assets_written": 0,
                "direct_preview_decisions_preapproved": 0,
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


def validate_tree(root: Path, library_root: Path) -> dict[str, Any]:
    marker = repair.read_json(root / MARKER_FILE, "font-signal repair marker")
    if marker.get("schema_version") != SCHEMA_VERSION or marker.get("owner") != OWNER:
        raise FontSignalRepairError("font-signal repair marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise FontSignalRepairError(
            "font-signal repair marker has no managed inventory"
        )
    actual = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    expected = {MARKER_FILE, *[str(value) for value in managed]}
    if actual != expected:
        raise FontSignalRepairError(
            f"managed inventory differs; missing={sorted(expected-actual)[:8]} unexpected={sorted(actual-expected)[:8]}"
        )
    for relative, expected_sha in managed.items():
        path = _safe_managed_path(root, relative, f"marker[{relative}]")
        repair.require_sha(expected_sha, f"marker[{relative}].sha256")
        if not path.is_file() or sha256_file(path) != expected_sha:
            raise FontSignalRepairError(
                f"managed artifact is stale/tampered: {relative}"
            )
    proposals = _unique(
        _read_jsonl(root / PROPOSALS_FILE, "sealed proposals"),
        "sample_id",
        "sealed proposals",
    )
    terminal = _unique(
        _read_jsonl(root / TERMINAL_FILE, "terminal proposals"),
        "sample_id",
        "terminal proposals",
    )
    for sample_id, row in proposals.items():
        try:
            repair.validate_seal(row, f"proposal[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalRepairError(str(error)) from error
        if (
            row.get("status") != "pending_direct_visual_review"
            or row.get("training_eligible") is not False
            or row.get("promotion_allowed") is not False
        ):
            raise FontSignalRepairError(f"proposal[{sample_id}]: unsafe status")
        source = row["source_page"]
        relative = _safe_relative_path(
            source["path"], f"proposal[{sample_id}].source_page.path"
        )
        page_path = library_root.joinpath(*relative.parts).resolve()
        if not page_path.is_file() or sha256_file(page_path) != source["file_sha256"]:
            raise FontSignalRepairError(f"proposal[{sample_id}]: source page drifted")
        with Image.open(page_path) as opened:
            decoded = ImageOps.exif_transpose(opened).convert("RGB")
            decoded.load()
        try:
            for key in ("direct_preview", "source_context"):
                asset = row[key]
                bbox = _require_bbox(
                    asset["bbox_px"], f"proposal[{sample_id}].{key}.bbox_px"
                )
                expected_png = _png_crop(decoded, bbox)
                asset_path = _safe_managed_path(
                    root, asset["path"], f"proposal[{sample_id}].{key}.path"
                )
                if (
                    asset.get("qa_overlay") is not False
                    or asset.get("synthetic") is not False
                    or asset.get("pixel_source")
                    != "direct_hash_verified_library_page_crop"
                    or asset_path.read_bytes() != expected_png
                    or asset.get("file_sha256") != repair.sha256_bytes(expected_png)
                ):
                    raise FontSignalRepairError(
                        f"proposal[{sample_id}]: {key} is not an exact direct page crop"
                    )
        finally:
            decoded.close()
    expected_terminal = {
        sid
        for sid, row in proposals.items()
        if row.get("action") == "terminal_replacement"
    }
    if set(terminal) != expected_terminal or any(
        terminal[sid] != proposals[sid] for sid in terminal
    ):
        raise FontSignalRepairError("terminal replacement projection drifted")
    report = repair.read_json(root / REPORT_FILE, "font-signal repair report")
    try:
        repair.validate_seal(report, "font-signal repair report")
    except repair.RecropRepairError as error:
        raise FontSignalRepairError(str(error)) from error
    counts = report.get("counts")
    if (
        not isinstance(counts, Mapping)
        or counts.get("targets") != len(proposals)
        or counts.get("pending_review") != len(proposals)
    ):
        raise FontSignalRepairError("font-signal repair report counts drifted")
    inputs = report.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get(
        "builder_source_sha256"
    ) != sha256_file(Path(__file__).resolve()):
        raise FontSignalRepairError("font-signal repair builder source binding drifted")
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
        raise FontSignalRepairError("deterministic rebuild inventory differs")
    stale = [name for name in expected if expected[name] != actual[name]]
    if stale:
        raise FontSignalRepairError(f"deterministic rebuild differs: {stale[:8]}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--human-review", type=Path, required=True)
    parser.add_argument("--font-signal-audit-v3", type=Path, required=True)
    parser.add_argument("--master-v3", type=Path, required=True)
    parser.add_argument("--proposal-plan", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--expected-targets", type=int, default=27)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        inputs = {
            "human_review": args.human_review.expanduser().resolve(),
            "audit_v3": args.font_signal_audit_v3.expanduser().resolve(),
            "master_v3": args.master_v3.expanduser().resolve(),
            "plan_path": args.proposal_plan.expanduser().resolve(),
            "library_root": args.library_root.expanduser().resolve(),
            "declared_root": args.output_root.expanduser().resolve(),
        }
        output_root = inputs["declared_root"]
        if args.command == "build":
            if output_root.exists():
                raise FontSignalRepairError(
                    f"refusing to overwrite output root: {output_root}"
                )
            output_root.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(
                tempfile.mkdtemp(
                    prefix=f".{output_root.name}.tmp-", dir=output_root.parent
                )
            )
            shutil.rmtree(temporary)
            try:
                report = _write_tree(
                    physical_root=temporary,
                    expected_targets=args.expected_targets,
                    **inputs,
                )
                temporary.replace(output_root)
                validate_tree(output_root, inputs["library_root"])
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        else:
            report = validate_tree(output_root, inputs["library_root"])
            temporary = Path(tempfile.mkdtemp(prefix="font-signal-repair-validate-"))
            shutil.rmtree(temporary)
            try:
                _write_tree(
                    physical_root=temporary,
                    expected_targets=args.expected_targets,
                    **inputs,
                )
                _compare_trees(output_root, temporary)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (
        FontSignalRepairError,
        repair.RecropRepairError,
        OSError,
        ValueError,
    ) as error:
        print(f"font-signal recrop repair error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
