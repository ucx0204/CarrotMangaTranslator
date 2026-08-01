#!/usr/bin/env python3
"""Rebind human font-signal decisions to byte-equivalent reordered audit rows.

This utility exists for immutable queue revisions where the only source-row
change is ``audit_order``.  It refuses every pixel, geometry, provenance,
trigger, or review-contract change.  Human outcomes and rationales are copied
verbatim; only the bound source-row SHA is updated, with a sealed equivalence
report kept beside the rebound decision file.
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

import finalize_font_matching_font_signal_audit as audit


SCHEMA_VERSION = "font-matching-font-signal-decision-rebind-v1"
OWNER = "carrot-manga-translator/font-signal-decision-rebind"
DECISIONS_FILE = "decisions.jsonl"
REPORT_FILE = "report.json"
MARKER_FILE = ".font-matching-font-signal-decision-rebind-owned.json"


class DecisionRebindError(ValueError):
    """Raised when prior human evidence is not byte-equivalent."""


def _audit_snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    snapshot = copy.deepcopy(dict(row))
    snapshot.pop("record_sha256", None)
    snapshot.pop("audit_order", None)
    return snapshot


def _snapshot_sha(row: Mapping[str, Any]) -> str:
    return audit.sha256_bytes(audit.canonical_json_bytes(_audit_snapshot(row)))


def build_artifacts(
    *,
    old_rescue: Path,
    new_rescue: Path,
    decisions_path: Path,
) -> dict[str, bytes]:
    old_audits, *_old_tail, old_hashes = audit.load_source(old_rescue.resolve())
    new_audits, *_new_tail, new_hashes = audit.load_source(new_rescue.resolve())
    decisions = audit.load_decisions(decisions_path.resolve(), old_audits)
    raw_decisions = audit.read_jsonl(decisions_path.resolve(), "human decisions")
    raw_by_id = {str(row["sample_id"]): row for row in raw_decisions}
    old_by_id = {str(row["sample_id"]): row for row in old_audits}
    new_by_id = {str(row["sample_id"]): row for row in new_audits}
    if (
        set(old_by_id) != set(new_by_id)
        or set(decisions) != set(new_by_id)
        or set(raw_by_id) != set(new_by_id)
    ):
        raise DecisionRebindError("old/new audit and human decision inventories differ")

    identical_count = 0
    reordered_count = 0
    rows: list[dict[str, Any]] = []
    equivalence_rows: list[dict[str, Any]] = []
    for current in new_audits:
        sample_id = str(current["sample_id"])
        prior = old_by_id[sample_id]
        prior_snapshot_sha = _snapshot_sha(prior)
        current_snapshot_sha = _snapshot_sha(current)
        if prior_snapshot_sha != current_snapshot_sha:
            raise DecisionRebindError(
                f"{sample_id}: audit evidence changed beyond audit_order"
            )
        prior_order = prior.get("audit_order")
        current_order = current.get("audit_order")
        if prior_order == current_order:
            identical_count += 1
        else:
            reordered_count += 1
        decision = copy.deepcopy(raw_by_id[sample_id])
        if decision["source_audit_record_sha256"] != prior["record_sha256"]:
            raise DecisionRebindError(f"{sample_id}: prior human binding changed")
        decision["source_audit_record_sha256"] = current["record_sha256"]
        rows.append(decision)
        equivalence_rows.append(
            {
                "sample_id": sample_id,
                "prior_audit_order": prior_order,
                "current_audit_order": current_order,
                "prior_source_audit_record_sha256": prior["record_sha256"],
                "current_source_audit_record_sha256": current["record_sha256"],
                "evidence_snapshot_sha256": current_snapshot_sha,
            }
        )

    decisions_payload = audit.jsonl_bytes(rows)
    equivalence_sha = audit.sha256_bytes(audit.canonical_json_bytes(equivalence_rows))
    report = audit.seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_signal_human_decision_rebind_report",
            "inputs": {
                "old_rescue_report_record_sha256": old_hashes[
                    "source_report_record_sha256"
                ],
                "old_audit_file_sha256": old_hashes["source_audit_file_sha256"],
                "new_rescue_report_record_sha256": new_hashes[
                    "source_report_record_sha256"
                ],
                "new_audit_file_sha256": new_hashes["source_audit_file_sha256"],
                "human_decisions_sha256": audit.sha256_file(decisions_path.resolve()),
            },
            "outputs": {
                "decisions_sha256": audit.sha256_bytes(decisions_payload),
                "evidence_equivalence_rows_sha256": equivalence_sha,
            },
            "summary": {
                "decision_count": len(rows),
                "byte_equivalent_evidence_count": len(rows),
                "identical_record_count": identical_count,
                "audit_order_only_change_count": reordered_count,
                "human_outcome_changes": 0,
                "human_rationale_changes": 0,
                "automatic_decisions": 0,
            },
            "contracts": {
                "allowed_source_difference": ["audit_order", "record_sha256"],
                "all_pixel_geometry_provenance_and_trigger_fields_exact": True,
                "human_review_fields_copied_verbatim": True,
                "reviewer_identity_and_timestamp_copied_verbatim": True,
                "qa_or_synthetic_pixels_read": False,
            },
        }
    )
    report_payload = audit.pretty_json_bytes(report)
    marker_payload = audit.pretty_json_bytes(
        {
            "schema_version": SCHEMA_VERSION,
            "owner": OWNER,
            "safe_replace": False,
            "managed_files": {
                DECISIONS_FILE: audit.sha256_bytes(decisions_payload),
                REPORT_FILE: audit.sha256_bytes(report_payload),
            },
        }
    )
    return {
        DECISIONS_FILE: decisions_payload,
        REPORT_FILE: report_payload,
        MARKER_FILE: marker_payload,
    }


def write_artifacts(output: Path, artifacts: Mapping[str, bytes]) -> None:
    target = output.resolve()
    if target.exists():
        raise DecisionRebindError(f"refusing to overwrite output: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=target.parent))
    try:
        for name, payload in artifacts.items():
            (staging / name).write_bytes(payload)
        staging.replace(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def validate_artifacts(
    *,
    old_rescue: Path,
    new_rescue: Path,
    decisions_path: Path,
    output: Path,
) -> dict[str, Any]:
    target = output.resolve()
    expected = build_artifacts(
        old_rescue=old_rescue,
        new_rescue=new_rescue,
        decisions_path=decisions_path,
    )
    if not target.is_dir() or {path.name for path in target.iterdir()} != set(expected):
        raise DecisionRebindError("rebind output inventory changed")
    for name, payload in expected.items():
        if (target / name).read_bytes() != payload:
            raise DecisionRebindError(f"rebind output changed: {name}")
    rebound = audit.read_jsonl(target / DECISIONS_FILE, "rebound decisions")
    new_audits, *_ = audit.load_source(new_rescue.resolve())
    audit.load_decisions(target / DECISIONS_FILE, new_audits)
    report = audit.read_json(target / REPORT_FILE, "rebind report")
    audit.validate_seal(report, "rebind report")
    if report["summary"]["decision_count"] != len(rebound):
        raise DecisionRebindError("rebind report count changed")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--old-rescue", type=Path, required=True)
    parser.add_argument("--new-rescue", type=Path, required=True)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            artifacts = build_artifacts(
                old_rescue=args.old_rescue,
                new_rescue=args.new_rescue,
                decisions_path=args.decisions,
            )
            write_artifacts(args.output, artifacts)
        report = validate_artifacts(
            old_rescue=args.old_rescue,
            new_rescue=args.new_rescue,
            decisions_path=args.decisions,
            output=args.output,
        )
        print(json.dumps(report["summary"], ensure_ascii=False, sort_keys=True))
        return 0
    except (DecisionRebindError, audit.FontSignalAuditError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
