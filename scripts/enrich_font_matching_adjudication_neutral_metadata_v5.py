#!/usr/bin/env python3
"""Bind direct-visual audit metadata to neutral adjudication annotations.

Some visual-review exports intentionally contain only the candidate-free
semantic evidence.  The v5 source sealer additionally requires the review
confidence and the direct-review order.  This helper restores only those two
metadata fields from the matching audit TSV and refuses any identity,
coverage, confidence, or verification mismatch.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import derive_font_matching_delta_decisions as derive
    from scripts import seal_font_matching_source_annotations_v5 as source_seal
except (ImportError, ModuleNotFoundError):  # direct ``python scripts/...``
    import derive_font_matching_delta_decisions as derive
    import seal_font_matching_source_annotations_v5 as source_seal


REQUIRED_AUDIT_COLUMNS = {
    "priority_rank",
    "sample_id",
    "primary_assignment_id",
    "confidence",
    "verification",
}
DIRECT_VERIFICATION = "full_primary_v4_card_direct"


class NeutralMetadataError(ValueError):
    """Raised when visual audit metadata cannot be bound exactly."""


def _audit_rows(path: Path) -> dict[str, dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            if reader.fieldnames is None or not REQUIRED_AUDIT_COLUMNS.issubset(
                reader.fieldnames
            ):
                raise NeutralMetadataError(
                    "audit TSV lacks required identity/confidence/verification columns"
                )
            rows = list(reader)
    except (OSError, UnicodeError, csv.Error) as error:
        raise NeutralMetadataError(f"cannot read audit TSV: {error}") from error
    if not rows:
        raise NeutralMetadataError("audit TSV is empty")

    by_assignment: dict[str, dict[str, Any]] = {}
    samples: set[str] = set()
    ranks: set[int] = set()
    for index, row in enumerate(rows, 1):
        assignment_id = str(row.get("primary_assignment_id", "")).strip()
        sample_id = str(row.get("sample_id", "")).strip()
        try:
            rank = int(str(row.get("priority_rank", "")).strip())
            confidence = float(str(row.get("confidence", "")).strip())
        except ValueError as error:
            raise NeutralMetadataError(
                f"audit row {index} has invalid rank/confidence"
            ) from error
        if (
            not assignment_id
            or not sample_id
            or rank <= 0
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
            or row.get("verification") != DIRECT_VERIFICATION
        ):
            raise NeutralMetadataError(
                f"audit row {index} is not a valid direct full-card review"
            )
        if assignment_id in by_assignment or sample_id in samples or rank in ranks:
            raise NeutralMetadataError("audit TSV repeats an identity or review rank")
        by_assignment[assignment_id] = {
            "sample_id": sample_id,
            "review_confidence": confidence,
            "visual_review_index": rank,
        }
        samples.add(sample_id)
        ranks.add(rank)
    return by_assignment


def enrich_rows(
    neutral_rows: Sequence[Mapping[str, Any]],
    audit_by_assignment: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if len(neutral_rows) != len(audit_by_assignment):
        raise NeutralMetadataError("neutral/audit row counts differ")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(neutral_rows, 1):
        row = dict(raw)
        assignment_id = str(row.get("assignment_id", ""))
        audit = audit_by_assignment.get(assignment_id)
        if audit is None or row.get("sample_id") != audit.get("sample_id"):
            raise NeutralMetadataError(
                f"neutral row {index} does not match its audit identity"
            )
        if assignment_id in seen:
            raise NeutralMetadataError("neutral rows repeat an assignment")
        seen.add(assignment_id)
        for key in ("review_confidence", "visual_review_index"):
            if key in row and row[key] != audit[key]:
                raise NeutralMetadataError(
                    f"neutral row {index} conflicts with audit {key}"
                )
            row[key] = audit[key]
        output.append(row)
    if seen != set(audit_by_assignment):
        raise NeutralMetadataError("neutral/audit assignment coverage differs")
    source_seal._validated_neutral_annotations(output, stage="adjudication")
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--neutral", type=Path, required=True)
    parser.add_argument("--audit-tsv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.output.exists():
            raise NeutralMetadataError("refusing to overwrite output")
        neutral_rows = source_seal._read_jsonl(args.neutral, "neutral")
        output_rows = enrich_rows(neutral_rows, _audit_rows(args.audit_tsv))
        payload = derive.jsonl_bytes(output_rows)
        derive._write_once(args.output, payload)
    except (
        NeutralMetadataError,
        source_seal.SourceAnnotationSealError,
        derive.DerivationError,
        OSError,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "output_sha256": derive.sha256_bytes(payload),
                "records": len(output_rows),
                "status": "enriched",
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
