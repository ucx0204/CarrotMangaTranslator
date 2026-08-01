#!/usr/bin/env python3
"""Prepare and validate direct visual orientation audits for font-review cards.

The review-card renderer must know the source writing direction before it can
choose comparable Korean probes.  Detector metadata is only a proposal: every
calibration sample is therefore opened at original resolution and receives one
explicit, hash-bound orientation decision before the final blind cards exist.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = "font-matching-orientation-audit-v1"
TASK_TYPE = "font_matching_orientation_task"
RESPONSE_TYPE = "font_matching_orientation_response"
REPORT_TYPE = "font_matching_orientation_audit_report"
DEFAULT_SEED = "font-matching-orientation-audit-v1"
ORIENTATIONS = frozenset({"horizontal", "vertical", "mixed", "unknown"})
CROP_STATUSES = frozenset({"usable", "needs_recrop", "mixed_hierarchy", "unusable"})


class OrientationAuditError(ValueError):
    """Raised when orientation QA inputs or responses violate the contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty
        else canonical_json(value)
    )
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


def require_text(value: Any, *, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise OrientationAuditError(f"{location}: expected non-empty text")
    return normalized


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise OrientationAuditError(f"{location}: expected an object")
    return value


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OrientationAuditError(f"could not read {location}: {error}") from error
    return dict(require_mapping(value, location=location))


def read_jsonl(path: Path, *, location: str, allow_empty: bool = False) -> list[dict]:
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
        raise OrientationAuditError(f"could not read {location}: {error}") from error
    if not rows and not allow_empty:
        raise OrientationAuditError(f"{location}: no records")
    return rows


def _resolve_inside(root: Path, relative: str, *, location: str) -> Path:
    pure = PurePosixPath(require_text(relative, location=location).replace("\\", "/"))
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise OrientationAuditError(f"{location}: unsafe relative path")
    resolved = root.joinpath(*pure.parts).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as error:
        raise OrientationAuditError(f"{location}: path escapes card root") from error
    if not resolved.is_file():
        raise OrientationAuditError(f"{location}: missing card file")
    return resolved


def _seal(value: Mapping[str, Any]) -> dict[str, Any]:
    core = dict(value)
    return {
        **core,
        "record_sha256": sha256_bytes(canonical_json(core).encode("utf-8")),
    }


def _validate_seal(value: Mapping[str, Any], *, location: str) -> None:
    expected = value.get("record_sha256")
    if not isinstance(expected, str):
        raise OrientationAuditError(f"{location}: missing record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise OrientationAuditError(f"{location}: record seal mismatch")


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
        handle.flush()
    temporary.replace(path)


def _load_inventory(path: Path) -> dict[str, dict[str, Any]]:
    rows = read_jsonl(path, location="calibration inventory")
    output: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        sample_id = require_text(
            row.get("sample_id"), location=f"inventory[{index}].sample_id"
        )
        if sample_id in output:
            raise OrientationAuditError(f"duplicate inventory sample: {sample_id}")
        provenance = require_mapping(
            row.get("provenance"), location=f"inventory[{index}].provenance"
        )
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise OrientationAuditError(f"inventory[{index}]: unsafe provenance")
        orientation = row.get("orientation")
        if orientation not in {"horizontal", "vertical"}:
            raise OrientationAuditError(
                f"inventory[{index}].orientation: expected detector proposal"
            )
        output[sample_id] = row
    return output


def _load_primary_assignments(
    path: Path, selected_ids: set[str]
) -> dict[str, dict[str, Any]]:
    rows = read_jsonl(path, location="assignments")
    by_stage: Counter[tuple[str, str]] = Counter()
    primary: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        sample_id = require_text(
            row.get("sample_id"), location=f"assignments[{index}].sample_id"
        )
        if sample_id not in selected_ids:
            continue
        stage = require_text(row.get("stage"), location=f"assignments[{index}].stage")
        by_stage[(sample_id, stage)] += 1
        if stage == "primary":
            primary[sample_id] = row
    for sample_id in selected_ids:
        if (
            by_stage[(sample_id, "primary")] != 1
            or by_stage[(sample_id, "secondary")] != 1
        ):
            raise OrientationAuditError(
                f"{sample_id}: expected one primary and one secondary assignment"
            )
    return primary


def _load_primary_cards(
    manifest_path: Path,
    cards_root: Path,
    primary_assignments: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    manifest = read_json(manifest_path, location="card manifest")
    if (
        manifest.get("qa_overlay") is not True
        or manifest.get("training_asset") is not False
    ):
        raise OrientationAuditError("card manifest is not isolated review-only QA")
    cards_value = manifest.get("cards")
    if not isinstance(cards_value, list):
        raise OrientationAuditError("card manifest cards must be an array")
    wanted = {
        str(value["assignment_id"]): sample_id
        for sample_id, value in primary_assignments.items()
    }
    output: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(cards_value, 1):
        card = dict(require_mapping(value, location=f"cards[{index}]"))
        assignment = require_mapping(
            card.get("assignment"), location=f"cards[{index}].assignment"
        )
        assignment_id = str(assignment.get("assignment_id", ""))
        if assignment_id not in wanted:
            continue
        sample_id = wanted[assignment_id]
        if (
            assignment.get("sample_id") != sample_id
            or assignment.get("stage") != "primary"
        ):
            raise OrientationAuditError(f"cards[{index}]: assignment binding mismatch")
        artifact = require_mapping(
            card.get("artifact"), location=f"cards[{index}].artifact"
        )
        if (
            artifact.get("qa_overlay") is not True
            or artifact.get("watermark") != "REVIEW-ONLY"
        ):
            raise OrientationAuditError(f"cards[{index}]: unsafe review artifact")
        relative = require_text(
            artifact.get("file"), location=f"cards[{index}].artifact.file"
        )
        path = _resolve_inside(
            cards_root, relative, location=f"cards[{index}].artifact.file"
        )
        expected_sha = require_text(
            artifact.get("sha256"), location=f"cards[{index}].artifact.sha256"
        )
        if sha256_file(path) != expected_sha:
            raise OrientationAuditError(f"cards[{index}]: card SHA mismatch")
        output[sample_id] = {
            "assignment_id": assignment_id,
            "card_path": relative.replace("\\", "/"),
            "card_sha256": expected_sha,
        }
    missing = sorted(set(primary_assignments) - set(output))
    if missing:
        raise OrientationAuditError(f"primary cards missing: {missing[:8]}")
    return output


def build_workspace(
    *,
    inventory_path: Path,
    assignments_path: Path,
    card_manifest_path: Path,
    cards_root: Path,
    output_dir: Path,
    shards: int,
    seed: str = DEFAULT_SEED,
    expected_samples: int | None = None,
) -> dict[str, Any]:
    if shards < 1:
        raise OrientationAuditError("shards must be positive")
    inventory = _load_inventory(inventory_path)
    if expected_samples is not None and len(inventory) != expected_samples:
        raise OrientationAuditError(
            f"expected {expected_samples} samples, got {len(inventory)}"
        )
    primary = _load_primary_assignments(assignments_path, set(inventory))
    cards = _load_primary_cards(card_manifest_path, cards_root, primary)
    sample_ids = sorted(inventory, key=lambda value: (stable_hash(seed, value), value))
    shard_rows: list[list[dict[str, Any]]] = [[] for _ in range(shards)]
    task_rows: list[dict[str, Any]] = []
    for index, sample_id in enumerate(sample_ids):
        row = inventory[sample_id]
        card = cards[sample_id]
        shard_number = index % shards + 1
        task = _seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": TASK_TYPE,
                "sample_id": sample_id,
                "work_id": row["work_id"],
                "chapter_id": row["chapter_id"],
                "page_id": row["page_id"],
                "declared_orientation": row["orientation"],
                "primary_assignment_id": card["assignment_id"],
                "card_path": card["card_path"],
                "card_sha256": card["card_sha256"],
                "shard": shard_number,
                "view_contract": "open card with view_image(detail=original); inspect source page, local context, raw_224, context_224, and glyph_224",
            }
        )
        task_rows.append(task)
        shard_rows[shard_number - 1].append(task)
    tasks_payload = jsonl_bytes(task_rows)
    report_core = {
        "schema_version": SCHEMA_VERSION,
        "record_type": REPORT_TYPE,
        "seed": seed,
        "counts": {
            "samples": len(task_rows),
            "shards": shards,
            "by_shard": {
                str(index + 1): len(rows) for index, rows in enumerate(shard_rows)
            },
            "declared_orientation": dict(
                sorted(
                    Counter(row["declared_orientation"] for row in task_rows).items()
                )
            ),
        },
        "hashes": {
            "inventory_sha256": sha256_file(inventory_path),
            "assignments_sha256": sha256_file(assignments_path),
            "card_manifest_sha256": sha256_file(card_manifest_path),
            "tasks_sha256": sha256_bytes(tasks_payload),
        },
        "safety": {
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "qa_overlay_cards": len(task_rows),
            "training_assets": 0,
        },
    }
    report = _seal(report_core)
    _atomic_write(output_dir / "tasks.jsonl", tasks_payload)
    for index, rows in enumerate(shard_rows, 1):
        _atomic_write(
            output_dir / "shards" / f"shard-{index:03d}.jsonl", jsonl_bytes(rows)
        )
    _atomic_write(output_dir / "report.json", json_bytes(report, pretty=True))
    return report


def _load_tasks(workspace: Path) -> dict[str, dict[str, Any]]:
    rows = read_jsonl(workspace / "tasks.jsonl", location="orientation tasks")
    tasks: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        _validate_seal(row, location=f"tasks[{index}]")
        if (
            row.get("schema_version") != SCHEMA_VERSION
            or row.get("record_type") != TASK_TYPE
        ):
            raise OrientationAuditError(f"tasks[{index}]: unsupported task schema")
        sample_id = require_text(
            row.get("sample_id"), location=f"tasks[{index}].sample_id"
        )
        if sample_id in tasks:
            raise OrientationAuditError(f"duplicate orientation task: {sample_id}")
        tasks[sample_id] = row
    return tasks


def _validate_response(
    value: Mapping[str, Any], task: Mapping[str, Any], *, location: str
) -> dict[str, Any]:
    required = {
        "schema_version",
        "record_type",
        "sample_id",
        "primary_assignment_id",
        "card_sha256",
        "reviewer",
        "viewed_original",
        "actual_orientation",
        "confidence",
        "crop_status",
        "notes",
    }
    if set(value) != required:
        raise OrientationAuditError(
            f"{location}: response keys differ: {sorted(set(value) ^ required)}"
        )
    if (
        value.get("schema_version") != SCHEMA_VERSION
        or value.get("record_type") != RESPONSE_TYPE
    ):
        raise OrientationAuditError(f"{location}: unsupported response schema")
    for field, task_field in (
        ("sample_id", "sample_id"),
        ("primary_assignment_id", "primary_assignment_id"),
        ("card_sha256", "card_sha256"),
    ):
        if value.get(field) != task.get(task_field):
            raise OrientationAuditError(f"{location}.{field}: task binding mismatch")
    require_text(value.get("reviewer"), location=f"{location}.reviewer")
    if value.get("viewed_original") is not True:
        raise OrientationAuditError(f"{location}: original-detail view is mandatory")
    orientation = value.get("actual_orientation")
    if orientation not in ORIENTATIONS:
        raise OrientationAuditError(f"{location}.actual_orientation: invalid value")
    confidence = value.get("confidence")
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not math.isfinite(float(confidence))
        or not 0 <= float(confidence) <= 1
    ):
        raise OrientationAuditError(f"{location}.confidence: expected 0..1")
    crop_status = value.get("crop_status")
    if crop_status not in CROP_STATUSES:
        raise OrientationAuditError(f"{location}.crop_status: invalid value")
    notes = require_text(value.get("notes"), location=f"{location}.notes")
    if orientation in {"mixed", "unknown"} and crop_status == "usable":
        raise OrientationAuditError(
            f"{location}: mixed/unknown orientation cannot be marked usable"
        )
    return {**dict(value), "notes": notes, "confidence": float(confidence)}


def validate_responses(
    *,
    workspace: Path,
    response_paths: Sequence[Path],
    allow_partial: bool = False,
) -> dict[str, Any]:
    tasks = _load_tasks(workspace)
    responses: dict[str, dict[str, Any]] = {}
    for path in response_paths:
        for index, value in enumerate(
            read_jsonl(path, location=str(path), allow_empty=True), 1
        ):
            sample_id = require_text(
                value.get("sample_id"), location=f"{path}:{index}.sample_id"
            )
            if sample_id not in tasks:
                raise OrientationAuditError(
                    f"{path}:{index}: unknown sample {sample_id}"
                )
            if sample_id in responses:
                raise OrientationAuditError(
                    f"duplicate orientation response: {sample_id}"
                )
            responses[sample_id] = _validate_response(
                value, tasks[sample_id], location=f"{path}:{index}"
            )
    missing = sorted(set(tasks) - set(responses))
    if missing and not allow_partial:
        raise OrientationAuditError(f"missing orientation responses: {missing[:8]}")
    mismatches = sum(
        response["actual_orientation"] != tasks[sample_id]["declared_orientation"]
        for sample_id, response in responses.items()
    )
    report_core = {
        "schema_version": SCHEMA_VERSION,
        "record_type": REPORT_TYPE,
        "complete": not missing,
        "counts": {
            "tasks": len(tasks),
            "responses": len(responses),
            "missing": len(missing),
            "declared_mismatches": mismatches,
            "actual_orientation": dict(
                sorted(
                    Counter(
                        response["actual_orientation"]
                        for response in responses.values()
                    ).items()
                )
            ),
            "crop_status": dict(
                sorted(
                    Counter(
                        response["crop_status"] for response in responses.values()
                    ).items()
                )
            ),
        },
        "missing_sample_ids": missing,
    }
    return _seal(report_core)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build")
    build.add_argument("--inventory", type=Path, required=True)
    build.add_argument("--assignments", type=Path, required=True)
    build.add_argument("--card-manifest", type=Path, required=True)
    build.add_argument("--cards-root", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--shards", type=int, default=3)
    build.add_argument("--seed", default=DEFAULT_SEED)
    build.add_argument("--expected-samples", type=int)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--workspace", type=Path, required=True)
    validate.add_argument("--responses", type=Path, action="append", required=True)
    validate.add_argument("--allow-partial", action="store_true")
    validate.add_argument("--output", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "build":
            report = build_workspace(
                inventory_path=args.inventory.resolve(),
                assignments_path=args.assignments.resolve(),
                card_manifest_path=args.card_manifest.resolve(),
                cards_root=args.cards_root.resolve(),
                output_dir=args.output_dir.resolve(),
                shards=args.shards,
                seed=args.seed,
                expected_samples=args.expected_samples,
            )
        else:
            report = validate_responses(
                workspace=args.workspace.resolve(),
                response_paths=[path.resolve() for path in args.responses],
                allow_partial=args.allow_partial,
            )
            if args.output:
                _atomic_write(args.output.resolve(), json_bytes(report, pretty=True))
    except OrientationAuditError as error:
        print(f"error: {error}")
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
