#!/usr/bin/env python3
"""Materialize and validate a blind MangaFont-v2 visual-review shard.

This tool intentionally reads only the public review queue and an opaque-slot
TSV.  It never resolves slot tokens through the pool's private bindings.  The
result therefore records useful agent judgments while remaining ineligible for
training, calibration, or evaluation until a separate adjudicator promotes it.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    import build_manga_font_v2_blind_calibration_pool as pool_contract
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_manga_font_v2_blind_calibration_pool as pool_contract


SCHEMA_VERSION = "manga-font-v2-blind-agent-review-shard-v1"
DECISION_RECORD_TYPE = "manga_font_v2_blind_agent_visual_decision"
CROSS_REVIEW_RECORD_TYPE = "manga_font_v2_blind_cross_review_item"
REPORT_RECORD_TYPE = "manga_font_v2_blind_agent_review_report"
DECISIONS_FILE = "decisions-agent-sheet001-010-r1.jsonl"
CROSS_REVIEW_FILE = "cross-review-agent-sheet001-010-r1.jsonl"
REPORT_FILE = "report-agent-sheet001-010-r1.json"

ROLE_VALUES = frozenset(
    {
        "dialogue",
        "narration",
        "thought",
        "aside",
        "emphasis_dialogue",
        "shout",
        "sign_ui_title",
        "sfx",
    }
)
ROLE_TO_BUCKET = {
    "dialogue": "dialogue",
    "narration": "narration",
    "thought": "thought",
    "aside": "aside_whisper",
    "emphasis_dialogue": "emphasis",
    "shout": "shout",
    "sign_ui_title": "sign_title",
    "sfx": "sfx",
}
DECISION_STATUSES = frozenset({"completed", "review_needed"})
CROP_QUALITIES = frozenset({"pass", "review_needed", "reject"})
TSV_COLUMNS = (
    "row",
    "sample_id",
    "decision_status",
    "crop_quality",
    "verified_role",
    "role_confidence",
    "match_confidence",
    "preferred_slots",
    "acceptable_slots",
    "marginal_slots",
    "notes",
)
LOW_ROLE_CONFIDENCE = 0.75
LOW_MATCH_CONFIDENCE = 0.70
FORBIDDEN_IDENTITY_KEYS = frozenset(
    {
        "candidate_id",
        "family_id",
        "font_id",
        "font_name",
        "model_prediction",
        "model_predictions",
        "model_score",
        "model_scores",
        "purpose",
    }
)


class ReviewShardError(ValueError):
    """Raised when a blind review shard is incomplete, leaky, or inconsistent."""


def _read_public_queue(path: Path) -> list[dict[str, Any]]:
    rows = list(pool_contract._iter_jsonl(path, "public review queue"))
    if not rows:
        raise ReviewShardError("public review queue is empty")
    for index, row in enumerate(rows, 1):
        try:
            pool_contract.validate_public_row(row)
        except pool_contract.BlindPoolError as error:
            raise ReviewShardError(f"public review queue row {index}: {error}") from error
    return rows


def _parse_confidence(value: Any, *, location: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ReviewShardError(f"{location}: confidence must be numeric") from error
    if not 0.0 <= result <= 1.0:
        raise ReviewShardError(f"{location}: confidence must be in [0, 1]")
    return result


def _parse_slots(value: Any, *, location: str) -> list[str]:
    text = value.strip() if isinstance(value, str) else ""
    if not text:
        return []
    result = [item.strip() for item in text.split(",")]
    if any(not item for item in result):
        raise ReviewShardError(f"{location}: empty slot token")
    if len(result) != len(set(result)):
        raise ReviewShardError(f"{location}: duplicate slot token")
    return result


def read_decision_tsv(path: Path) -> list[dict[str, Any]]:
    if path.is_symlink() or not path.is_file():
        raise ReviewShardError(f"missing or linked decisions TSV: {path}")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        if tuple(reader.fieldnames or ()) != TSV_COLUMNS:
            raise ReviewShardError(
                f"TSV columns must be exactly {TSV_COLUMNS}, got {tuple(reader.fieldnames or ())}"
            )
        rows: list[dict[str, Any]] = []
        for line_number, source in enumerate(reader, 2):
            try:
                queue_row = int(str(source["row"]).strip())
            except (TypeError, ValueError) as error:
                raise ReviewShardError(f"TSV line {line_number}: invalid row") from error
            decision_status = str(source["decision_status"]).strip()
            crop_quality = str(source["crop_quality"]).strip()
            verified_role = str(source["verified_role"]).strip()
            if decision_status not in DECISION_STATUSES:
                raise ReviewShardError(f"TSV line {line_number}: invalid decision_status")
            if crop_quality not in CROP_QUALITIES:
                raise ReviewShardError(f"TSV line {line_number}: invalid crop_quality")
            if verified_role not in ROLE_VALUES:
                raise ReviewShardError(f"TSV line {line_number}: invalid verified_role")
            row = {
                "queue_row": queue_row,
                "sample_id": str(source["sample_id"]).strip(),
                "decision_status": decision_status,
                "crop_quality": crop_quality,
                "verified_role": verified_role,
                "verified_role_confidence": _parse_confidence(
                    source["role_confidence"], location=f"TSV line {line_number} role"
                ),
                "font_match_confidence": _parse_confidence(
                    source["match_confidence"], location=f"TSV line {line_number} match"
                ),
                "preferred_slots": _parse_slots(
                    source["preferred_slots"], location=f"TSV line {line_number} preferred"
                ),
                "acceptable_slots": _parse_slots(
                    source["acceptable_slots"], location=f"TSV line {line_number} acceptable"
                ),
                "marginal_slots": _parse_slots(
                    source["marginal_slots"], location=f"TSV line {line_number} marginal"
                ),
                "notes": str(source["notes"]).strip(),
            }
            if not row["sample_id"] or not row["notes"]:
                raise ReviewShardError(f"TSV line {line_number}: sample_id and notes are required")
            rows.append(row)
    if not rows:
        raise ReviewShardError("decisions TSV is empty")
    return rows


def _all_public_slots(review_item: Mapping[str, Any]) -> list[str]:
    result: list[str] = []
    for panel in review_item["panels"]:
        result.extend(str(slot) for slot in panel["slots"])
    if len(result) != 21 or len(set(result)) != 21:
        raise ReviewShardError("public review item does not expose exactly 21 opaque slots")
    return result


def _panel_decisions(
    decision: Mapping[str, Any], review_item: Mapping[str, Any]
) -> list[dict[str, Any]]:
    categories = {
        "preferred_slots": list(decision["preferred_slots"]),
        "acceptable_slots": list(decision["acceptable_slots"]),
        "marginal_slots": list(decision["marginal_slots"]),
    }
    all_listed = [slot for values in categories.values() for slot in values]
    if len(all_listed) != len(set(all_listed)):
        raise ReviewShardError(
            f"queue row {decision['queue_row']}: a slot appears in multiple judgments"
        )
    available = set(_all_public_slots(review_item))
    unknown = sorted(set(all_listed) - available)
    if unknown:
        raise ReviewShardError(
            f"queue row {decision['queue_row']}: unknown opaque slots {unknown}"
        )
    if decision["decision_status"] == "completed" and not categories["preferred_slots"]:
        raise ReviewShardError(
            f"queue row {decision['queue_row']}: completed row needs a preferred slot"
        )

    completed = decision["decision_status"] == "completed"
    result: list[dict[str, Any]] = []
    for source_panel in review_item["panels"]:
        panel_number = int(source_panel["panel_number"])
        panel_slots = [str(slot) for slot in source_panel["slots"]]
        selected = {
            key: [slot for slot in values if slot in panel_slots]
            for key, values in categories.items()
        }
        used = set(slot for values in selected.values() for slot in values)
        acceptable_or_better = selected["preferred_slots"] + selected["acceptable_slots"]
        result.append(
            {
                **selected,
                "panel_none_acceptable": not bool(acceptable_or_better) if completed else None,
                "panel_number": panel_number,
                "review_complete": completed,
                "unacceptable_slots": [slot for slot in panel_slots if slot not in used]
                if completed
                else [],
                "unrenderable_slots": [],
            }
        )
    return result


def _role_correction(decision: Mapping[str, Any], review_item: Mapping[str, Any]) -> bool:
    expected_bucket = ROLE_TO_BUCKET[str(decision["verified_role"])]
    return expected_bucket != review_item["role_sampling"]["bucket"]


def _cross_review_reasons(decision: Mapping[str, Any]) -> list[str]:
    reasons: list[str] = []
    if decision["decision_status"] == "review_needed":
        reasons.append("blind_reviewer_deferred")
    if decision["crop_quality"] != "pass":
        reasons.append(f"crop_quality_{decision['crop_quality']}")
    if decision["verified_role_confidence"] < LOW_ROLE_CONFIDENCE:
        reasons.append("low_verified_role_confidence")
    if decision["font_match_confidence"] < LOW_MATCH_CONFIDENCE:
        reasons.append("low_font_match_confidence")
    return reasons


def materialize_records(
    decisions: Sequence[Mapping[str, Any]],
    queue: Sequence[Mapping[str, Any]],
    *,
    start_row: int,
    end_row: int,
    shard_id: str,
    reviewer: str,
    reviewed_at: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    expected_rows = list(range(start_row, end_row + 1))
    actual_rows = [int(row["queue_row"]) for row in decisions]
    if actual_rows != expected_rows:
        raise ReviewShardError(
            f"TSV row sequence must be exactly {start_row}..{end_row}, got {actual_rows[:3]}..."
        )
    if end_row > len(queue):
        raise ReviewShardError("requested row span exceeds public queue")
    if not shard_id.strip() or not reviewer.strip() or not reviewed_at.strip():
        raise ReviewShardError("shard_id, reviewer, and reviewed_at are required")

    output: list[dict[str, Any]] = []
    cross_review: list[dict[str, Any]] = []
    for decision in decisions:
        queue_row = int(decision["queue_row"])
        review_item = queue[queue_row - 1]
        if decision["sample_id"] != review_item["sample_id"]:
            raise ReviewShardError(f"queue row {queue_row}: sample_id does not match public queue")
        correction = _role_correction(decision, review_item)
        reasons = _cross_review_reasons(decision)
        record = pool_contract.seal_record(
            {
                "authority": {
                    "automatic_label_promotion_allowed": False,
                    "calibration_eligible": False,
                    "evaluation_eligible": False,
                    "label_authority": "agent_blind_visual_review_pending_cross_adjudication",
                    "training_eligible": False,
                },
                "blindness": {
                    "candidate_identifiers_visible": False,
                    "font_names_visible": False,
                    "model_predictions_visible": False,
                    "private_bindings_read": False,
                },
                "candidate_search_complete": True,
                "crop_quality": decision["crop_quality"],
                "decision_status": decision["decision_status"],
                "font_match_confidence": decision["font_match_confidence"],
                "notes": decision["notes"],
                "panel_decisions": _panel_decisions(decision, review_item),
                "queue_row": queue_row,
                "record_type": DECISION_RECORD_TYPE,
                "review_id": review_item["review_id"],
                "review_item_sha256": review_item["record_sha256"],
                "review_needed": decision["decision_status"] == "review_needed",
                "review_needed_reason_codes": reasons
                if decision["decision_status"] == "review_needed"
                else [],
                "reviewed_at": reviewed_at,
                "reviewer": {"id": reviewer, "type": "ai_agent"},
                "role_corrected_from_sampling_hint": correction,
                "role_sampling_hint": dict(review_item["role_sampling"]),
                "sample_id": review_item["sample_id"],
                "schema_version": SCHEMA_VERSION,
                "shard_id": shard_id,
                "verified_role": decision["verified_role"],
                "verified_role_confidence": decision["verified_role_confidence"],
            }
        )
        output.append(record)
        if reasons:
            cross_review.append(
                pool_contract.seal_record(
                    {
                        "current_decision": {
                            "crop_quality": decision["crop_quality"],
                            "decision_record_sha256": record["record_sha256"],
                            "decision_status": decision["decision_status"],
                            "font_match_confidence": decision["font_match_confidence"],
                            "verified_role": decision["verified_role"],
                            "verified_role_confidence": decision[
                                "verified_role_confidence"
                            ],
                        },
                        "panel_sheet_refs": [
                            {
                                "panel_number": panel["panel_number"],
                                "sheet": dict(panel["sheet"]),
                                "slots": list(panel["slots"]),
                            }
                            for panel in review_item["panels"]
                        ],
                        "queue_row": queue_row,
                        "reason_codes": reasons,
                        "record_type": CROSS_REVIEW_RECORD_TYPE,
                        "review_id": review_item["review_id"],
                        "sample_id": review_item["sample_id"],
                        "schema_version": SCHEMA_VERSION,
                        "shard_id": shard_id,
                    }
                )
            )
    return output, cross_review


def _confidence_summary(values: Iterable[float]) -> dict[str, Any]:
    data = list(values)
    return {
        "count": len(data),
        "maximum": max(data),
        "mean": round(statistics.fmean(data), 4),
        "median": round(statistics.median(data), 4),
        "minimum": min(data),
        "threshold_below_count": sum(value < LOW_MATCH_CONFIDENCE for value in data),
    }


def _identity_key_scan(value: Any, *, location: str = "root") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key) in FORBIDDEN_IDENTITY_KEYS:
                raise ReviewShardError(f"{location}: forbidden identity key {key!r}")
            _identity_key_scan(child, location=f"{location}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            _identity_key_scan(child, location=f"{location}[{index}]")


def build_report(
    records: Sequence[Mapping[str, Any]],
    cross_review: Sequence[Mapping[str, Any]],
    *,
    pool_dir: Path,
    tsv_path: Path,
    decisions_path: Path,
    cross_review_path: Path,
    start_row: int,
    end_row: int,
    shard_id: str,
) -> dict[str, Any]:
    status_counts = Counter(str(row["decision_status"]) for row in records)
    crop_counts = Counter(str(row["crop_quality"]) for row in records)
    role_counts = Counter(str(row["verified_role"]) for row in records)
    correction_pairs = Counter(
        (
            str(row["role_sampling_hint"]["bucket"]),
            ROLE_TO_BUCKET[str(row["verified_role"])],
        )
        for row in records
        if row["role_corrected_from_sampling_hint"]
    )
    cross_reason_counts = Counter(
        reason for row in cross_review for reason in row["reason_codes"]
    )
    role_values = [float(row["verified_role_confidence"]) for row in records]
    match_values = [float(row["font_match_confidence"]) for row in records]
    report = pool_contract.seal_record(
        {
            "authority": {
                "automatic_label_promotion_allowed": False,
                "calibration_eligible": False,
                "evaluation_eligible": False,
                "human_gold": False,
                "label_authority": "agent_blind_visual_review_pending_cross_adjudication",
                "training_eligible": False,
            },
            "counts": {
                "candidate_exposures": len(records) * 21,
                "completed": status_counts["completed"],
                "crop_reject": crop_counts["reject"],
                "crop_review_needed": crop_counts["review_needed"],
                "cross_review": len(cross_review),
                "review_needed": status_counts["review_needed"],
                "role_corrected_from_sampling_hint": sum(correction_pairs.values()),
                "rows": len(records),
            },
            "cross_review": {
                "reason_counts": dict(sorted(cross_reason_counts.items())),
                "selection_contract": {
                    "decision_status_review_needed": True,
                    "font_match_confidence_below": LOW_MATCH_CONFIDENCE,
                    "non_pass_crop": True,
                    "verified_role_confidence_below": LOW_ROLE_CONFIDENCE,
                },
            },
            "files": {
                "cross_review": {
                    "file": CROSS_REVIEW_FILE,
                    "sha256": pool_contract.sha256_file(cross_review_path),
                },
                "decisions": {
                    "file": DECISIONS_FILE,
                    "sha256": pool_contract.sha256_file(decisions_path),
                },
                "public_queue": {
                    "file": str((pool_dir / pool_contract.QUEUE_FILE).resolve()),
                    "sha256": pool_contract.sha256_file(pool_dir / pool_contract.QUEUE_FILE),
                },
                "source_tsv": {
                    "file": str(tsv_path.resolve()),
                    "sha256": pool_contract.sha256_file(tsv_path),
                },
            },
            "font_match_confidence": _confidence_summary(match_values),
            "record_type": REPORT_RECORD_TYPE,
            "role_corrections": [
                {"count": count, "from_sampling_bucket": source, "to_verified_bucket": target}
                for (source, target), count in sorted(correction_pairs.items())
            ],
            "role_counts": dict(sorted(role_counts.items())),
            "schema_version": SCHEMA_VERSION,
            "sheet_exposure": {
                "candidate_identifiers_visible": False,
                "evaluation_partition_visible": False,
                "font_names_visible": False,
                "model_predictions_visible": False,
                "panels_per_row": 3,
                "private_bindings_read_by_materializer": False,
                "slots_per_panel": 7,
            },
            "shard_id": shard_id,
            "span": {"end_queue_row": end_row, "start_queue_row": start_row},
            "verified_role_confidence": {
                **_confidence_summary(role_values),
                "threshold_below_count": sum(
                    value < LOW_ROLE_CONFIDENCE for value in role_values
                ),
            },
        }
    )
    return report


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes(
        "".join(pool_contract.canonical_json(row) + "\n" for row in rows).encode("utf-8")
    )


def materialize(
    *,
    pool_dir: Path,
    tsv_path: Path,
    output_dir: Path,
    start_row: int,
    end_row: int,
    shard_id: str,
    reviewer: str,
    reviewed_at: str,
) -> dict[str, Any]:
    pool_dir = pool_dir.resolve()
    output_dir = output_dir.resolve()
    queue = _read_public_queue(pool_dir / pool_contract.QUEUE_FILE)
    decisions = read_decision_tsv(tsv_path)
    records, cross_review = materialize_records(
        decisions,
        queue,
        start_row=start_row,
        end_row=end_row,
        shard_id=shard_id,
        reviewer=reviewer,
        reviewed_at=reviewed_at,
    )
    for row in [*records, *cross_review]:
        _identity_key_scan(row)
    output_dir.mkdir(parents=True, exist_ok=True)
    decisions_path = output_dir / DECISIONS_FILE
    cross_review_path = output_dir / CROSS_REVIEW_FILE
    report_path = output_dir / REPORT_FILE
    occupied = [path for path in (decisions_path, cross_review_path, report_path) if path.exists()]
    if occupied:
        raise ReviewShardError(f"refusing to overwrite existing shard files: {occupied}")
    _write_jsonl(decisions_path, records)
    _write_jsonl(cross_review_path, cross_review)
    report = build_report(
        records,
        cross_review,
        pool_dir=pool_dir,
        tsv_path=tsv_path,
        decisions_path=decisions_path,
        cross_review_path=cross_review_path,
        start_row=start_row,
        end_row=end_row,
        shard_id=shard_id,
    )
    report_path.write_bytes(pool_contract.json_bytes(report, pretty=True))
    validate(pool_dir=pool_dir, shard_dir=output_dir)
    return report


def _read_json(path: Path, *, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReviewShardError(f"{location}: invalid JSON: {error}") from error
    if not isinstance(value, Mapping):
        raise ReviewShardError(f"{location}: expected object")
    return dict(value)


def validate(*, pool_dir: Path, shard_dir: Path) -> dict[str, Any]:
    pool_dir = pool_dir.resolve()
    shard_dir = shard_dir.resolve()
    queue = _read_public_queue(pool_dir / pool_contract.QUEUE_FILE)
    decisions_path = shard_dir / DECISIONS_FILE
    cross_path = shard_dir / CROSS_REVIEW_FILE
    report_path = shard_dir / REPORT_FILE
    records = list(pool_contract._iter_jsonl(decisions_path, "decision shard"))
    cross_review = list(pool_contract._iter_jsonl(cross_path, "cross-review queue"))
    report = _read_json(report_path, location="review report")
    for location, row in [
        *( (f"decision {index}", row) for index, row in enumerate(records, 1) ),
        *( (f"cross-review {index}", row) for index, row in enumerate(cross_review, 1) ),
        ("report", report),
    ]:
        try:
            pool_contract.validate_record_seal(row, location=location)
        except pool_contract.BlindPoolError as error:
            raise ReviewShardError(str(error)) from error
        _identity_key_scan(row, location=location)
    if report.get("record_type") != REPORT_RECORD_TYPE:
        raise ReviewShardError("report: wrong record_type")
    span = report.get("span")
    if not isinstance(span, Mapping):
        raise ReviewShardError("report: invalid span")
    start_row = int(span["start_queue_row"])
    end_row = int(span["end_queue_row"])
    expected_count = end_row - start_row + 1
    if len(records) != expected_count:
        raise ReviewShardError("decision count does not match sealed span")
    for offset, record in enumerate(records):
        queue_row = start_row + offset
        public = queue[queue_row - 1]
        if (
            record.get("queue_row") != queue_row
            or record.get("sample_id") != public["sample_id"]
            or record.get("review_id") != public["review_id"]
            or record.get("review_item_sha256") != public["record_sha256"]
        ):
            raise ReviewShardError(f"decision row {queue_row}: public queue reference mismatch")
        authority = record.get("authority")
        if not isinstance(authority, Mapping) or any(
            authority.get(key) is not False
            for key in (
                "automatic_label_promotion_allowed",
                "calibration_eligible",
                "evaluation_eligible",
                "training_eligible",
            )
        ):
            raise ReviewShardError(f"decision row {queue_row}: authority must remain false")
        panel_decisions = record.get("panel_decisions")
        if not isinstance(panel_decisions, Sequence) or len(panel_decisions) != 3:
            raise ReviewShardError(f"decision row {queue_row}: needs three panel decisions")
        available = set(_all_public_slots(public))
        seen: set[str] = set()
        for panel in panel_decisions:
            if not isinstance(panel, Mapping):
                raise ReviewShardError(f"decision row {queue_row}: invalid panel")
            for key in (
                "preferred_slots",
                "acceptable_slots",
                "marginal_slots",
                "unacceptable_slots",
                "unrenderable_slots",
            ):
                slots = panel.get(key)
                if not isinstance(slots, Sequence) or isinstance(slots, str):
                    raise ReviewShardError(f"decision row {queue_row}: invalid {key}")
                for slot in slots:
                    if slot not in available or slot in seen:
                        raise ReviewShardError(
                            f"decision row {queue_row}: duplicate or unknown slot {slot}"
                        )
                    seen.add(str(slot))
        if record["decision_status"] == "completed":
            if len(seen) != 21 or not all(panel["review_complete"] for panel in panel_decisions):
                raise ReviewShardError(
                    f"decision row {queue_row}: completed row lacks a full 21-slot partition"
                )
        elif record["decision_status"] == "review_needed":
            if any(panel["review_complete"] for panel in panel_decisions):
                raise ReviewShardError(
                    f"decision row {queue_row}: deferred panel cannot be review-complete"
                )
        else:
            raise ReviewShardError(f"decision row {queue_row}: invalid decision_status")

    expected_cross = [
        row["queue_row"]
        for row in records
        if row["decision_status"] == "review_needed"
        or row["crop_quality"] != "pass"
        or row["verified_role_confidence"] < LOW_ROLE_CONFIDENCE
        or row["font_match_confidence"] < LOW_MATCH_CONFIDENCE
    ]
    if [row.get("queue_row") for row in cross_review] != expected_cross:
        raise ReviewShardError("cross-review queue is not the exact deferred/low-confidence subset")
    files = report.get("files")
    if not isinstance(files, Mapping):
        raise ReviewShardError("report: invalid file manifest")
    expected_hashes = {
        "decisions": pool_contract.sha256_file(decisions_path),
        "cross_review": pool_contract.sha256_file(cross_path),
        "public_queue": pool_contract.sha256_file(pool_dir / pool_contract.QUEUE_FILE),
    }
    for key, expected in expected_hashes.items():
        item = files.get(key)
        if not isinstance(item, Mapping) or item.get("sha256") != expected:
            raise ReviewShardError(f"report: {key} hash mismatch")
    exposure = report.get("sheet_exposure")
    if not isinstance(exposure, Mapping) or any(
        exposure.get(key) is not False
        for key in (
            "candidate_identifiers_visible",
            "evaluation_partition_visible",
            "font_names_visible",
            "model_predictions_visible",
            "private_bindings_read_by_materializer",
        )
    ):
        raise ReviewShardError("report: blind sheet-exposure contract is not sealed")
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    materialize_parser = sub.add_parser("materialize")
    materialize_parser.add_argument("--pool", type=Path, required=True)
    materialize_parser.add_argument("--tsv", type=Path, required=True)
    materialize_parser.add_argument("--output", type=Path, required=True)
    materialize_parser.add_argument("--start-row", type=int, required=True)
    materialize_parser.add_argument("--end-row", type=int, required=True)
    materialize_parser.add_argument("--shard-id", required=True)
    materialize_parser.add_argument("--reviewer", required=True)
    materialize_parser.add_argument("--reviewed-at", required=True)
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--pool", type=Path, required=True)
    validate_parser.add_argument("--shard", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "materialize":
            report = materialize(
                pool_dir=args.pool,
                tsv_path=args.tsv,
                output_dir=args.output,
                start_row=args.start_row,
                end_row=args.end_row,
                shard_id=args.shard_id,
                reviewer=args.reviewer,
                reviewed_at=args.reviewed_at,
            )
        else:
            report = validate(pool_dir=args.pool, shard_dir=args.shard)
    except (ReviewShardError, pool_contract.BlindPoolError) as error:
        print(f"ERROR: {error}")
        return 2
    print(pool_contract.canonical_json(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
