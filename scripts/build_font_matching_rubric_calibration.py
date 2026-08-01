#!/usr/bin/env python3
"""Select a fresh, development-only calibration set for review rubric v2.

The selector never mutates the canonical master manifest.  It writes a
zero-copy subset manifest plus a card-builder-compatible inventory.  Frozen
test rows, synthetic/overlay rows, and every sample already exposed in the v1
pilot are excluded before selection.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = "font-matching-rubric-calibration-v2"
DEFAULT_SEED = "font-matching-rubric-calibration-v2"
DEFAULT_PER_WORK = 16
DEFAULT_EXPECTED_WORKS = 18
DEFAULT_EXPECTED_TOTAL = 282
DEVELOPMENT_SPLITS = frozenset({"train", "val"})

CATEGORY_TARGETS: tuple[tuple[str, int], ...] = (
    ("ordinary", 4),
    ("aside", 2),
    ("sfx", 2),
    ("treatment", 3),
    ("ocr", 2),
    ("horizontal", 2),
)


class CalibrationSelectionError(ValueError):
    """Raised when a calibration input or output violates the contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(json_bytes(dict(row)) for row in rows)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    return sha256_bytes("\0".join(parts).encode("utf-8"))


def read_jsonl(path: Path, *, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise CalibrationSelectionError(
                        f"{location}:{line_number}: expected an object"
                    )
                rows.append(value)
    except (OSError, json.JSONDecodeError) as error:
        raise CalibrationSelectionError(
            f"could not read {location}: {error}"
        ) from error
    if not rows:
        raise CalibrationSelectionError(f"{location}: no records")
    return rows


def require_text(value: Any, *, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise CalibrationSelectionError(f"{location}: expected non-empty text")
    return normalized


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CalibrationSelectionError(f"{location}: expected an object")
    return value


def _validate_provenance(row: Mapping[str, Any], *, location: str) -> None:
    provenance = require_mapping(
        row.get("provenance"), location=f"{location}.provenance"
    )
    if provenance.get("qa_overlay") is not False:
        raise CalibrationSelectionError(f"{location}: QA overlay input is forbidden")
    if provenance.get("synthetic") is not False:
        raise CalibrationSelectionError(f"{location}: synthetic input is forbidden")


def _row_categories(row: Mapping[str, Any]) -> frozenset[str]:
    cohorts_value = row.get("cohorts")
    cohorts = (
        {value for value in cohorts_value if isinstance(value, str)}
        if isinstance(cohorts_value, list)
        else set()
    )
    categories: set[str] = set()
    if "ordinary_dialogue_proxy_control" in cohorts:
        categories.add("ordinary")
    if cohorts & {"hard_free_near_bubble", "hard_text_free"}:
        categories.add("aside")
    if "hard_page_sound" in cohorts:
        categories.add("sfx")
    if cohorts & {
        "hard_outline_extreme",
        "hard_inverse_extreme",
        "hard_color_extreme",
    }:
        categories.add("treatment")
    if cohorts & {"hard_ocr_hard", "hard_ocr_anime_region"}:
        categories.add("ocr")
    if "horizontal" in cohorts:
        categories.add("horizontal")
    return frozenset(categories)


def _eligible_inventory_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> tuple[list[dict[str, Any]], Counter[str]]:
    eligible: list[dict[str, Any]] = []
    excluded: Counter[str] = Counter()
    seen: set[str] = set()
    for index, source in enumerate(rows, 1):
        row = dict(source)
        location = f"inventory[{index}]"
        sample_id = require_text(row.get("sample_id"), location=f"{location}.sample_id")
        if sample_id in seen:
            raise CalibrationSelectionError(f"duplicate inventory sample: {sample_id}")
        seen.add(sample_id)
        _validate_provenance(row, location=location)
        if sample_id in excluded_sample_ids:
            excluded["explicit_visual_audit_reject"] += 1
            continue
        split = require_text(row.get("split"), location=f"{location}.split")
        batches = require_mapping(row.get("batches"), location=f"{location}.batches")
        if split not in DEVELOPMENT_SPLITS:
            excluded["frozen_test"] += 1
            continue
        if "pilot" in batches:
            excluded["pilot_overlap"] += 1
            continue
        if "calibration" not in batches:
            excluded["outside_calibration_inventory"] += 1
            continue
        require_text(row.get("work_id"), location=f"{location}.work_id")
        require_text(row.get("chapter_id"), location=f"{location}.chapter_id")
        require_text(row.get("page_id"), location=f"{location}.page_id")
        eligible.append(row)
    return eligible, excluded


def _selection_score(
    row: Mapping[str, Any],
    *,
    category_counts: Counter[str],
    selected_chapters: Counter[str],
    selected_pages: set[str],
    seed: str,
    work_id: str,
) -> tuple[int, int, int, int, str]:
    categories = _row_categories(row)
    unmet = sum(
        1
        for category, target in CATEGORY_TARGETS
        if category in categories and category_counts[category] < target
    )
    scarcity_gain = sum(
        max(0, target - category_counts[category])
        for category, target in CATEGORY_TARGETS
        if category in categories
    )
    chapter_id = str(row["chapter_id"])
    page_id = str(row["page_id"])
    new_chapter = int(selected_chapters[chapter_id] == 0)
    new_page = int(page_id not in selected_pages)
    tie_break = stable_hash(seed, work_id, str(row["sample_id"]))
    return unmet, scarcity_gain, new_chapter, new_page, tie_break


def _select_work_rows(
    rows: Sequence[dict[str, Any]], *, work_id: str, per_work: int, seed: str
) -> list[dict[str, Any]]:
    remaining = list(rows)
    selected: list[dict[str, Any]] = []
    categories: Counter[str] = Counter()
    chapters: Counter[str] = Counter()
    pages: set[str] = set()
    while remaining and len(selected) < per_work:
        chosen = max(
            remaining,
            key=lambda row: _selection_score(
                row,
                category_counts=categories,
                selected_chapters=chapters,
                selected_pages=pages,
                seed=seed,
                work_id=work_id,
            ),
        )
        remaining.remove(chosen)
        selected.append(chosen)
        categories.update(_row_categories(chosen))
        chapters[str(chosen["chapter_id"])] += 1
        pages.add(str(chosen["page_id"]))
    return sorted(
        selected,
        key=lambda row: (
            stable_hash(seed, work_id, str(row["sample_id"])),
            row["sample_id"],
        ),
    )


def select_rows(
    inventory_rows: Sequence[Mapping[str, Any]],
    *,
    per_work: int,
    seed: str,
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if per_work < 1:
        raise CalibrationSelectionError("per_work must be positive")
    eligible, excluded = _eligible_inventory_rows(
        inventory_rows, excluded_sample_ids=excluded_sample_ids
    )
    by_work: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in eligible:
        by_work[str(row["work_id"])].append(row)
    selected: list[dict[str, Any]] = []
    eligible_by_work: dict[str, int] = {}
    for work_id in sorted(by_work):
        eligible_by_work[work_id] = len(by_work[work_id])
        selected.extend(
            _select_work_rows(
                by_work[work_id], work_id=work_id, per_work=per_work, seed=seed
            )
        )
    selected.sort(
        key=lambda row: (str(row["work_id"]), stable_hash(seed, str(row["sample_id"])))
    )
    diagnostics = {
        "eligible": len(eligible),
        "eligible_by_work": eligible_by_work,
        "excluded": dict(sorted(excluded.items())),
    }
    return selected, diagnostics


def _master_subset(
    master_rows: Sequence[Mapping[str, Any]], selected_ids: set[str]
) -> list[dict[str, Any]]:
    subset: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, source in enumerate(master_rows, 1):
        row = dict(source)
        sample_id = require_text(row.get("id"), location=f"master[{index}].id")
        if sample_id not in selected_ids:
            continue
        if sample_id in seen:
            raise CalibrationSelectionError(f"duplicate master sample: {sample_id}")
        _validate_provenance(row, location=f"master[{index}]")
        if row.get("split") not in DEVELOPMENT_SPLITS:
            raise CalibrationSelectionError(f"selected frozen-test row: {sample_id}")
        seen.add(sample_id)
        subset.append(row)
    missing = sorted(selected_ids - seen)
    if missing:
        raise CalibrationSelectionError(
            f"selected samples missing from master: {missing[:8]}"
        )
    return sorted(subset, key=lambda row: str(row["id"]))


def _selection_reasons(row: Mapping[str, Any]) -> list[str]:
    categories = sorted(_row_categories(row))
    return [f"rubric-v2:{category}" for category in categories] or [
        "rubric-v2:work-balanced-fill"
    ]


def _write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
        handle.flush()
    temporary.replace(path)


def build_calibration(
    *,
    master_manifest: Path,
    inventory: Path,
    rubric: Path,
    output_dir: Path,
    seed: str = DEFAULT_SEED,
    per_work: int = DEFAULT_PER_WORK,
    expected_works: int | None = DEFAULT_EXPECTED_WORKS,
    expected_total: int | None = DEFAULT_EXPECTED_TOTAL,
    exclude_samples: Path | None = None,
) -> dict[str, Any]:
    for path, name in (
        (master_manifest, "master manifest"),
        (inventory, "inventory"),
        (rubric, "rubric"),
    ):
        if not path.is_file():
            raise CalibrationSelectionError(f"missing {name}: {path}")
    master_rows = read_jsonl(master_manifest, location="master manifest")
    inventory_rows = read_jsonl(inventory, location="inventory")
    excluded_sample_ids = frozenset(
        require_text(
            row.get("sample_id"), location=f"exclude_samples[{index}].sample_id"
        )
        for index, row in enumerate(
            read_jsonl(exclude_samples, location="exclude samples")
            if exclude_samples is not None
            else [],
            1,
        )
    )
    selected, diagnostics = select_rows(
        inventory_rows,
        per_work=per_work,
        seed=seed,
        excluded_sample_ids=excluded_sample_ids,
    )
    selected_ids = {str(row["sample_id"]) for row in selected}
    if len(selected_ids) != len(selected):
        raise CalibrationSelectionError("selection contains duplicate sample IDs")
    work_count = len({str(row["work_id"]) for row in selected})
    if expected_works is not None and work_count != expected_works:
        raise CalibrationSelectionError(
            f"expected {expected_works} selected works, got {work_count}"
        )
    if expected_total is not None and len(selected) != expected_total:
        raise CalibrationSelectionError(
            f"expected {expected_total} selected samples, got {len(selected)}"
        )
    subset = _master_subset(master_rows, selected_ids)
    subset_payload = jsonl_bytes(subset)
    subset_sha = sha256_bytes(subset_payload)
    inventory_output_rows: list[dict[str, Any]] = []
    for review_order, row in enumerate(selected, 1):
        inventory_output_rows.append(
            {
                "schema_version": 1,
                "sample_id": row["sample_id"],
                "work_id": row["work_id"],
                "chapter_id": row["chapter_id"],
                "page_id": row["page_id"],
                "split": row["split"],
                "master_manifest_sha256": subset_sha,
                "cohorts": list(row.get("cohorts", [])),
                "orientation": row.get("orientation"),
                "batches": {
                    "calibration": {
                        "review_order": review_order,
                        "selection_reasons": _selection_reasons(row),
                    }
                },
                "provenance": {
                    "qa_overlay": False,
                    "synthetic": False,
                    "source_catalog_id": row.get("provenance", {}).get(
                        "source_catalog_id"
                    ),
                },
            }
        )
    inventory_payload = jsonl_bytes(inventory_output_rows)
    by_work = Counter(str(row["work_id"]) for row in selected)
    by_split = Counter(str(row["split"]) for row in selected)
    by_category: Counter[str] = Counter()
    for row in selected:
        by_category.update(_row_categories(row))
    report_core = {
        "schema_version": SCHEMA_VERSION,
        "seed": seed,
        "per_work_cap": per_work,
        "counts": {
            "selected": len(selected),
            "works": work_count,
            "by_work": dict(sorted(by_work.items())),
            "by_split": dict(sorted(by_split.items())),
            "by_category": dict(sorted(by_category.items())),
        },
        "selection_diagnostics": diagnostics,
        "hashes": {
            "source_master_manifest_sha256": sha256_file(master_manifest),
            "source_inventory_sha256": sha256_file(inventory),
            "rubric_sha256": sha256_file(rubric),
            "subset_master_manifest_sha256": subset_sha,
            "selected_inventory_sha256": sha256_bytes(inventory_payload),
            "exclude_samples_sha256": (
                sha256_file(exclude_samples) if exclude_samples is not None else None
            ),
        },
        "safety": {
            "frozen_test_selected": 0,
            "pilot_overlap_selected": 0,
            "qa_overlay_selected": 0,
            "synthetic_selected": 0,
            "explicit_visual_audit_reject_selected": 0,
        },
    }
    report = {
        **report_core,
        "record_sha256": sha256_bytes(canonical_json(report_core).encode("utf-8")),
    }
    _write_atomic(output_dir / "master.jsonl", subset_payload)
    _write_atomic(output_dir / "inventory.jsonl", inventory_payload)
    _write_atomic(output_dir / "report.json", json_bytes(report, pretty=True))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--rubric", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--per-work", type=int, default=DEFAULT_PER_WORK)
    parser.add_argument("--expected-works", type=int, default=DEFAULT_EXPECTED_WORKS)
    parser.add_argument("--expected-total", type=int, default=DEFAULT_EXPECTED_TOTAL)
    parser.add_argument("--exclude-samples", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = build_calibration(
            master_manifest=args.master_manifest.resolve(),
            inventory=args.inventory.resolve(),
            rubric=args.rubric.resolve(),
            output_dir=args.output_dir.resolve(),
            seed=args.seed,
            per_work=args.per_work,
            expected_works=args.expected_works,
            expected_total=args.expected_total,
            exclude_samples=(
                args.exclude_samples.resolve() if args.exclude_samples else None
            ),
        )
    except CalibrationSelectionError as error:
        print(f"error: {error}")
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
