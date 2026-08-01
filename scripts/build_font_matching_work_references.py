#!/usr/bin/env python3
"""Build anonymous same-work dialogue references for blind font review cards.

The source pool is limited to already-finalized, high-confidence ordinary
dialogue labels.  References are selected around each work's median observable
style, prefer distinct chapters, and never expose work titles or font choices in
the review card.  This file only writes QA metadata; it does not copy or modify
training images.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "font-matching-work-references-v1"
RECORD_TYPE = "font_matching_work_reference_target"
REPORT_TYPE = "font_matching_work_reference_report"
DEFAULT_SEED = "font-matching-work-references-v1"
STYLE_AXES = (
    "weight",
    "width",
    "serifness",
    "roundness",
    "angularity",
    "stroke_contrast",
    "slant",
    "energy",
    "irregularity",
    "handwritten",
)


class WorkReferenceError(ValueError):
    """Raised when reference inputs or selection violate the QA contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


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


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkReferenceError(f"{location}: expected an object")
    return value


def require_text(value: Any, *, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise WorkReferenceError(f"{location}: expected non-empty text")
    return normalized


def read_jsonl(path: Path, *, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                rows.append(
                    dict(require_mapping(value, location=f"{location}:{line_number}"))
                )
    except (OSError, json.JSONDecodeError) as error:
        raise WorkReferenceError(f"could not read {location}: {error}") from error
    if not rows:
        raise WorkReferenceError(f"{location}: no records")
    return rows


def _seal(value: Mapping[str, Any]) -> dict[str, Any]:
    core = dict(value)
    return {
        **core,
        "record_sha256": sha256_bytes(canonical_json(core).encode("utf-8")),
    }


def _validate_seal(value: Mapping[str, Any], *, location: str) -> None:
    expected = value.get("record_sha256")
    if not isinstance(expected, str):
        raise WorkReferenceError(f"{location}: missing record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise WorkReferenceError(f"{location}: final label seal mismatch")


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
        handle.flush()
    temporary.replace(path)


def _numeric_style(
    row: Mapping[str, Any], *, location: str
) -> tuple[float, ...] | None:
    style = require_mapping(
        row.get("source_style"), location=f"{location}.source_style"
    )
    unknown = style.get("unknown_fields")
    if not isinstance(unknown, list):
        raise WorkReferenceError(f"{location}.source_style.unknown_fields is invalid")
    if unknown:
        return None
    values: list[float] = []
    for axis in STYLE_AXES:
        value = style.get(axis)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            or not 0 <= float(value) <= 1
        ):
            return None
        values.append(float(value))
    return tuple(values)


def _eligible_final(row: Mapping[str, Any], *, location: str) -> bool:
    _validate_seal(row, location=location)
    if row.get("record_type") != "manga_font_label_final":
        raise WorkReferenceError(f"{location}: unsupported final record type")
    role = require_mapping(row.get("role"), location=f"{location}.role")
    consistency = require_mapping(
        row.get("consistency"), location=f"{location}.consistency"
    )
    resolution = require_mapping(
        row.get("resolution"), location=f"{location}.resolution"
    )
    judgment = require_mapping(
        row.get("font_judgment"), location=f"{location}.font_judgment"
    )
    treatment = require_mapping(row.get("treatment"), location=f"{location}.treatment")
    return (
        role.get("primary") == "dialogue"
        and float(role.get("confidence", -1)) >= 0.9
        and consistency.get("policy") == "inherit_work_anchor"
        and float(resolution.get("confidence", -1)) >= 0.8
        and judgment.get("none_acceptable") is False
        and treatment.get("orientation") in {"horizontal", "vertical"}
        and _numeric_style(row, location=location) is not None
    )


def _master_views(row: Mapping[str, Any], *, location: str) -> dict[str, Any]:
    views = require_mapping(row.get("views"), location=f"{location}.views")
    output: dict[str, Any] = {}
    for name in ("raw_224", "context_224", "glyph_224"):
        output[name] = dict(
            require_mapping(views.get(name), location=f"{location}.views.{name}")
        )
    return output


def _representative_order(
    rows: Sequence[Mapping[str, Any]], *, seed: str, work_id: str
) -> list[Mapping[str, Any]]:
    vectors = [
        _numeric_style(row, location=f"final[{row['sample_id']}]") for row in rows
    ]
    if any(vector is None for vector in vectors):
        raise WorkReferenceError(f"{work_id}: eligible row lost complete style vector")
    complete_vectors = [vector for vector in vectors if vector is not None]
    median = tuple(
        statistics.median(vector[index] for vector in complete_vectors)
        for index in range(len(STYLE_AXES))
    )

    def key(row: Mapping[str, Any]) -> tuple[Any, ...]:
        vector = _numeric_style(row, location=f"final[{row['sample_id']}]")
        assert vector is not None
        distance = sum((value - center) ** 2 for value, center in zip(vector, median))
        role_confidence = float(
            require_mapping(row["role"], location="role")["confidence"]
        )
        resolution_confidence = float(
            require_mapping(row["resolution"], location="resolution")["confidence"]
        )
        return (
            distance,
            -min(role_confidence, resolution_confidence),
            stable_hash(seed, work_id, str(row["sample_id"])),
            str(row["sample_id"]),
        )

    return sorted(rows, key=key)


def _choose_distinct_chapters(
    rows: Sequence[Mapping[str, Any]],
    *,
    master_by_id: Mapping[str, Mapping[str, Any]],
    target_orientation: str,
    count: int,
) -> list[Mapping[str, Any]]:
    same_orientation = [
        row
        for row in rows
        if require_mapping(row["treatment"], location="treatment").get("orientation")
        == target_orientation
    ]
    ordered = same_orientation + [row for row in rows if row not in same_orientation]
    chosen: list[Mapping[str, Any]] = []
    chapters: set[str] = set()
    for distinct_only in (True, False):
        for row in ordered:
            if row in chosen:
                continue
            master = master_by_id[str(row["sample_id"])]
            chapter_id = require_text(
                require_mapping(master.get("chapter"), location="master.chapter").get(
                    "id"
                ),
                location="master.chapter.id",
            )
            if distinct_only and chapter_id in chapters:
                continue
            chosen.append(row)
            chapters.add(chapter_id)
            if len(chosen) == count:
                return chosen
    return chosen


def build_references(
    *,
    target_inventory: Path,
    source_master: Path,
    final_labels: Path,
    output: Path,
    report_output: Path,
    references_per_target: int = 3,
    seed: str = DEFAULT_SEED,
    require_final_count: int | None = None,
) -> dict[str, Any]:
    if references_per_target < 3:
        raise WorkReferenceError("at least three references per target are required")
    targets = read_jsonl(target_inventory, location="target inventory")
    master_rows = read_jsonl(source_master, location="source master")
    finals = read_jsonl(final_labels, location="final labels")
    if require_final_count is not None and len(finals) != require_final_count:
        raise WorkReferenceError(
            f"expected {require_final_count} complete finals, got {len(finals)}"
        )

    master_by_id: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(master_rows, 1):
        sample_id = require_text(row.get("id"), location=f"master[{index}].id")
        if sample_id in master_by_id:
            raise WorkReferenceError(f"duplicate master sample: {sample_id}")
        master_by_id[sample_id] = row

    eligible_by_work: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(finals, 1):
        if not _eligible_final(row, location=f"finals[{index}]"):
            continue
        sample_id = require_text(
            row.get("sample_id"), location=f"finals[{index}].sample_id"
        )
        work_id = require_text(row.get("work_id"), location=f"finals[{index}].work_id")
        if sample_id not in master_by_id:
            raise WorkReferenceError(f"final {sample_id}: missing source master row")
        master_work = require_text(
            require_mapping(
                master_by_id[sample_id].get("work"), location="master.work"
            ).get("id"),
            location="master.work.id",
        )
        if master_work != work_id:
            raise WorkReferenceError(f"final {sample_id}: work binding mismatch")
        provenance = require_mapping(
            master_by_id[sample_id].get("provenance"), location="master.provenance"
        )
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise WorkReferenceError(f"final {sample_id}: unsafe reference provenance")
        eligible_by_work[work_id].append(row)

    ordered_by_work = {
        work_id: _representative_order(rows, seed=seed, work_id=work_id)
        for work_id, rows in eligible_by_work.items()
    }
    target_records: list[dict[str, Any]] = []
    by_work = Counter()
    for index, target in enumerate(targets, 1):
        sample_id = require_text(
            target.get("sample_id"), location=f"targets[{index}].sample_id"
        )
        work_id = require_text(
            target.get("work_id"), location=f"targets[{index}].work_id"
        )
        orientation = target.get("orientation")
        if orientation not in {"horizontal", "vertical"}:
            raise WorkReferenceError(
                f"target {sample_id}: audited orientation required"
            )
        pool = [
            row
            for row in ordered_by_work.get(work_id, [])
            if row["sample_id"] != sample_id
        ]
        chosen = _choose_distinct_chapters(
            pool,
            master_by_id=master_by_id,
            target_orientation=str(orientation),
            count=references_per_target,
        )
        if len(chosen) != references_per_target:
            raise WorkReferenceError(
                f"target {sample_id}: only {len(chosen)} clean same-work dialogue references"
            )
        references: list[dict[str, Any]] = []
        for position, final in enumerate(chosen, 1):
            reference_id = str(final["sample_id"])
            master = master_by_id[reference_id]
            references.append(
                {
                    "blind_alias": f"same-work-dialogue-{position:02d}",
                    "source_sample_id": reference_id,
                    "source_final_sha256": final["record_sha256"],
                    "role": "dialogue",
                    "role_confidence": final["role"]["confidence"],
                    "resolution_confidence": final["resolution"]["confidence"],
                    "orientation": final["treatment"]["orientation"],
                    "chapter_id": master["chapter"]["id"],
                    "page_id": master["page"]["id"],
                    "sample_crop_sha256": master["sample_crop_sha256"],
                    "source_catalog_id": master["provenance"]["source_catalog_id"],
                    "views": _master_views(master, location=f"master[{reference_id}]"),
                }
            )
        target_records.append(
            _seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": RECORD_TYPE,
                    "target_sample_id": sample_id,
                    "target_work_id": work_id,
                    "target_orientation": orientation,
                    "references": references,
                }
            )
        )
        by_work[work_id] += 1

    manifest_core = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "font_matching_work_reference_manifest",
        "seed": seed,
        "references_per_target": references_per_target,
        "input_hashes": {
            "target_inventory_sha256": sha256_file(target_inventory),
            "source_master_sha256": sha256_file(source_master),
            "final_labels_sha256": sha256_file(final_labels),
        },
        "targets": target_records,
        "safety": {
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "work_titles_visible": False,
            "qa_overlay": True,
            "training_asset": False,
            "images_copied_or_modified": 0,
        },
    }
    manifest = _seal(manifest_core)
    manifest_payload = json_bytes(manifest, pretty=True)
    report = _seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": REPORT_TYPE,
            "counts": {
                "targets": len(target_records),
                "works": len(by_work),
                "references": len(target_records) * references_per_target,
                "eligible_dialogue_finals": sum(
                    len(rows) for rows in eligible_by_work.values()
                ),
                "targets_by_work": dict(sorted(by_work.items())),
            },
            "manifest_sha256": sha256_bytes(manifest_payload),
            "safety": manifest_core["safety"],
        }
    )
    _atomic_write(output, manifest_payload)
    _atomic_write(report_output, json_bytes(report, pretty=True))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-inventory", type=Path, required=True)
    parser.add_argument("--source-master", type=Path, required=True)
    parser.add_argument("--final-labels", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report-output", type=Path, required=True)
    parser.add_argument("--references-per-target", type=int, default=3)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--require-final-count", type=int)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = build_references(
            target_inventory=args.target_inventory.resolve(),
            source_master=args.source_master.resolve(),
            final_labels=args.final_labels.resolve(),
            output=args.output.resolve(),
            report_output=args.report_output.resolve(),
            references_per_target=args.references_per_target,
            seed=args.seed,
            require_final_count=args.require_final_count,
        )
    except WorkReferenceError as error:
        print(f"error: {error}")
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
