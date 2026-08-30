#!/usr/bin/env python3
"""Build manual-review panels from the full production V3 size replay."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from research_source_font_size_v3_geometry_smoke import contact_sheet


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"expected an object: {path}")
    return value


def combine_rows(
    audit: dict[str, object], production: dict[str, object]
) -> list[dict[str, object]]:
    audit_rows = audit.get("rows")
    production_rows = production.get("rows")
    if not isinstance(audit_rows, list) or not isinstance(production_rows, list):
        raise ValueError("reports are missing rows")
    by_id = {
        str(row.get("blockId")): row for row in audit_rows if isinstance(row, dict)
    }
    combined: list[dict[str, object]] = []
    for production_row in production_rows:
        if not isinstance(production_row, dict):
            continue
        audit_row = by_id.get(str(production_row.get("blockId")))
        line_estimate = production_row.get("lineGeometryEstimate")
        if not isinstance(audit_row, dict) or not isinstance(line_estimate, dict):
            continue
        old_face = production_row.get("storedSourceFontFacePx")
        new_face = line_estimate.get("facePx")
        try:
            old_value = float(old_face)
            new_value = float(new_face)
        except (TypeError, ValueError):
            continue
        if old_value <= 0 or new_value <= 0:
            continue
        combined.append(
            {
                **audit_row,
                "sourceFontFacePx": round(old_value, 3),
                "fixedEstimate": {"correctedFacePx": round(new_value, 3)},
                "deltaRatio": new_value / old_value,
            }
        )
    return combined


def combine_all_audited_rows(
    audit: dict[str, object], production: dict[str, object]
) -> list[dict[str, object]]:
    audit_rows = audit.get("rows")
    production_rows = production.get("rows")
    if not isinstance(audit_rows, list) or not isinstance(production_rows, list):
        raise ValueError("reports are missing rows")
    production_by_id = {
        str(row.get("blockId")): row for row in production_rows if isinstance(row, dict)
    }
    combined: list[dict[str, object]] = []
    for audit_row in audit_rows:
        if not isinstance(audit_row, dict):
            continue
        try:
            old_face = float(audit_row.get("sourceFontFacePx"))
        except (TypeError, ValueError):
            continue
        production_row = production_by_id.get(str(audit_row.get("blockId")))
        estimate = (
            production_row.get("lineGeometryEstimate")
            if isinstance(production_row, dict)
            else None
        )
        try:
            new_face = (
                float(estimate.get("facePx"))
                if isinstance(estimate, dict)
                else old_face
            )
        except (TypeError, ValueError):
            new_face = old_face
        combined.append(
            {
                **audit_row,
                "sourceFontFacePx": round(old_face, 3),
                "fixedEstimate": {"correctedFacePx": round(new_face, 3)},
                "deltaRatio": new_face / old_face,
            }
        )
    return combined


def write_paginated_panels(
    rows: list[dict[str, object]],
    output: Path,
    prefix: str,
    page_size: int,
) -> list[str]:
    paths: list[str] = []
    for start in range(0, len(rows), page_size):
        target = output / f"{prefix}-{start // page_size + 1:02d}.png"
        contact_sheet(rows[start : start + page_size], target)
        paths.append(str(target))
    return paths


def run(args: argparse.Namespace) -> int:
    audit = read_json(Path(args.audit).resolve())
    production = read_json(Path(args.production).resolve())
    rows = combine_rows(audit, production)
    all_rows = combine_all_audited_rows(audit, production)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    count = args.count
    increases = sorted(rows, key=lambda row: float(row["deltaRatio"]), reverse=True)
    decreases = sorted(rows, key=lambda row: float(row["deltaRatio"]))
    low_faces = sorted(
        (row for row in rows if float(row["sourceFontFacePx"]) <= 14),
        key=lambda row: float(row["deltaRatio"]),
        reverse=True,
    )
    contact_sheet(increases[:count], output / "largest-increases.png")
    contact_sheet(decreases[:count], output / "largest-decreases.png")
    contact_sheet(low_faces[:count], output / "stored-low-face.png")
    all_low_faces = sorted(
        (row for row in all_rows if float(row["sourceFontFacePx"]) <= 14),
        key=lambda row: float(row["sourceFontFacePx"]),
    )[: args.max_extremes]
    all_high_faces = sorted(
        all_rows,
        key=lambda row: float(row["sourceFontFacePx"]),
        reverse=True,
    )[: args.max_extremes]
    all_low_panels = write_paginated_panels(all_low_faces, output, "all-low", count)
    all_high_panels = write_paginated_panels(all_high_faces, output, "all-high", count)
    summary = {
        "rows": len(rows),
        "increasePanel": str(output / "largest-increases.png"),
        "decreasePanel": str(output / "largest-decreases.png"),
        "lowFacePanel": str(output / "stored-low-face.png"),
        "allLowPanels": all_low_panels,
        "allHighPanels": all_high_panels,
    }
    (output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True)
    parser.add_argument("--production", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=12)
    parser.add_argument("--max-extremes", type=int, default=120)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
