#!/usr/bin/env python3
"""Build a sealed adjudicated-val overlay for MangaFont student training.

The overlay never copies or rewrites train/test rows.  The base export remains
the authority for train, source pixels, and the hidden test boundary.  Only the
33 already-public validation rows are materialized with their promoted human
judgments.  Base test rows are recognized by the v1 byte scanner and are never
JSON-deserialized by this process.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from scripts import promote_manga_font_student_calibration_finals as promotion
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import promote_manga_font_student_calibration_finals as promotion
    import train_manga_font_student_v1 as trainer


SCHEMA_VERSION = "manga-font-student-human-val-overlay-v1"
RECORD_TYPE = "manga_font_student_human_val_overlay_manifest"
REPORT_TYPE = "manga_font_student_human_val_overlay_report"
OWNER = "carrot-manga-translator/manga-font-student-human-val-overlay-v1"
MARKER_FILE = ".manga-font-student-human-val-overlay-v1-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
VAL_FILE = "val-samples-adjudicated.jsonl"
OUTPUT_FILES = frozenset({MARKER_FILE, MANIFEST_FILE, REPORT_FILE, VAL_FILE})


class HumanValOverlayError(ValueError):
    """Raised when an adjudicated validation overlay is unsafe or inconsistent."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HumanValOverlayError(f"{location}: expected object")
    return value


def _safe_output(path: Path) -> Path:
    output = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}
    if output in forbidden or len(output.parts) < 3 or len(output.name) < 3:
        raise HumanValOverlayError(f"unsafe overlay output: {output}")
    return output


def _descriptor(path: Path, *, record_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise HumanValOverlayError(f"artifact missing or linked: {path}")
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": trainer.sha256_file(path),
    }
    if record_count is not None:
        result["record_count"] = record_count
    return result


def _ordered_digest(values: Sequence[str]) -> str:
    return trainer.sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _base_bindings(base_export_dir: Path, snapshot: trainer.HumanSnapshot) -> dict[str, Any]:
    root = base_export_dir.expanduser().resolve()
    return {
        "manifest_sha256": snapshot.manifest_sha256,
        "marker_sha256": snapshot.marker_sha256,
        "report_sha256": snapshot.report_sha256,
        "samples_sha256": snapshot.samples_sha256,
        "skipped_test_row_count": snapshot.skipped_test_rows,
        "train_record_count": len(snapshot.train_examples),
        "train_record_sha256_sequence_digest": _ordered_digest(
            [str(example.row["record_sha256"]) for example in snapshot.train_examples]
        ),
        "val_original_record_count": len(snapshot.val_examples),
        "val_original_record_sha256_sequence_digest": _ordered_digest(
            [str(example.row["record_sha256"]) for example in snapshot.val_examples]
        ),
        "val_sample_id_sequence_digest": _ordered_digest(
            [example.sample_id for example in snapshot.val_examples]
        ),
        "root_name": root.name,
    }


def _load_finals(finals_dir: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    root = finals_dir.expanduser().resolve()
    try:
        validation = promotion.validate_promoted_output(root)
    except promotion.StudentCalibrationPromotionError as error:
        raise HumanValOverlayError(str(error)) from error
    finals_path = root / promotion.FINALS_FILE
    rows: list[dict[str, Any]] = []
    with finals_path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = _mapping(json.loads(line), f"finals:{line_number}")
            except json.JSONDecodeError as error:
                raise HumanValOverlayError("promoted finals JSON drifted") from error
            rows.append(copy.deepcopy(dict(row)))
    if len(rows) != validation["record_count"]:
        raise HumanValOverlayError("promoted finals count drifted")
    return rows, {
        "finals_sha256": trainer.sha256_file(finals_path),
        "marker_sha256": trainer.sha256_file(root / promotion.MARKER_FILE),
        "record_count": len(rows),
        "report_sha256": trainer.sha256_file(root / promotion.REPORT_FILE),
        "root_name": root.name,
    }


def _overlay_row(
    example: trainer.HumanExample,
    final: Mapping[str, Any],
    *,
    candidate_ids: tuple[str, ...],
    catalog_registry_sha256: str,
    finals_sha256: str,
) -> dict[str, Any]:
    sample_id = example.sample_id
    source = _mapping(example.row.get("source"), f"{sample_id}.source")
    source_page_sha = str(source.get("source_page_sha256"))
    if (
        final.get("sample_id") != sample_id
        or final.get("work_id") != example.work_id
        or final.get("source_page_sha256") != source_page_sha
    ):
        raise HumanValOverlayError(f"{sample_id}: final/source identity drifted")
    resolution = _mapping(final.get("resolution"), f"{sample_id}.resolution")
    input_bindings = _mapping(
        example.row.get("input_bindings"), f"{sample_id}.input_bindings"
    )
    if (
        resolution.get("kind") not in {"adjudicated", "primary"}
        or resolution.get("catalog_sha256") != input_bindings.get("font_catalog_sha256")
        or resolution.get("renderer_hash") != input_bindings.get("renderer_hash")
    ):
        raise HumanValOverlayError(f"{sample_id}: final rendering authority drifted")

    row = copy.deepcopy(dict(example.row))
    original_record_sha = str(row.pop("record_sha256"))
    for field in ("consistency", "font_judgment", "role", "source_style", "treatment"):
        row[field] = copy.deepcopy(final[field])
    bindings = dict(_mapping(row.get("input_bindings"), f"{sample_id}.input_bindings"))
    bindings.update(
        {
            "adjudicated_val_final_record_sha256": str(final["record_sha256"]),
            "adjudicated_val_finals_sha256": finals_sha256,
        }
    )
    row["input_bindings"] = bindings
    provenance = dict(_mapping(row.get("provenance"), f"{sample_id}.provenance"))
    provenance["adjudicated_val_overlay"] = {
        "base_training_sample_record_sha256": original_record_sha,
        "final_record_sha256": str(final["record_sha256"]),
        "relationship": "validation_label_only_overlay",
        "schema_version": SCHEMA_VERSION,
        "test_data_used": False,
        "train_data_modified": False,
    }
    row["provenance"] = provenance
    review_provenance = dict(
        _mapping(row.get("review_provenance"), f"{sample_id}.review_provenance")
    )
    review_provenance.update(
        {
            "adjudicated_val_overlay": {
                "base_final_record_sha256": review_provenance.get(
                    "final_record_sha256"
                ),
                "promoted_final_record_sha256": str(final["record_sha256"]),
                "schema_version": SCHEMA_VERSION,
            },
            "final_record_sha256": str(final["record_sha256"]),
            "resolution": copy.deepcopy(dict(resolution)),
        }
    )
    row["review_provenance"] = review_provenance
    row = trainer.seal_record(row)
    try:
        trainer._validate_human_row(  # noqa: SLF001
            row,
            split="val",
            candidate_ids=candidate_ids,
            catalog_registry_sha256=catalog_registry_sha256,
            location=f"overlay {sample_id}",
        )
    except trainer.MangaFontStudentError as error:
        raise HumanValOverlayError(str(error)) from error
    return row


def _prepare(
    *,
    base_export_dir: Path,
    finals_dir: Path,
    catalog_registry: Path,
    candidate_ids: tuple[str, ...],
) -> tuple[trainer.HumanSnapshot, list[dict[str, Any]], dict[str, Any]]:
    registry = catalog_registry.expanduser().resolve()
    registry_sha = trainer.sha256_file(registry)
    try:
        snapshot = trainer.validate_human_input(
            base_export_dir,
            candidate_ids=candidate_ids,
            catalog_registry_sha256=registry_sha,
        )
    except trainer.MangaFontStudentError as error:
        raise HumanValOverlayError(str(error)) from error
    finals, finals_bindings = _load_finals(finals_dir)
    finals_by_id = {str(row["sample_id"]): row for row in finals}
    val_ids = [example.sample_id for example in snapshot.val_examples]
    if len(finals_by_id) != len(finals) or set(finals_by_id) != set(val_ids):
        raise HumanValOverlayError(
            "promoted finals must cover the existing val split exactly once"
        )
    overlay_rows = [
        _overlay_row(
            example,
            finals_by_id[example.sample_id],
            candidate_ids=candidate_ids,
            catalog_registry_sha256=registry_sha,
            finals_sha256=finals_bindings["finals_sha256"],
        )
        for example in snapshot.val_examples
    ]
    bindings = {
        "base_export": _base_bindings(base_export_dir, snapshot),
        "catalog_registry_sha256": registry_sha,
        "finals": finals_bindings,
    }
    bindings["combined_authority_sha256"] = trainer.sha256_bytes(
        trainer.canonical_json(bindings).encode("utf-8")
    )
    return snapshot, overlay_rows, bindings


def build_overlay(
    *,
    base_export_dir: Path,
    finals_dir: Path,
    catalog_registry: Path,
    candidate_ids: tuple[str, ...],
    output_dir: Path,
) -> Mapping[str, Any]:
    output = _safe_output(output_dir)
    if output.exists():
        raise HumanValOverlayError("overlay output already exists")
    snapshot, rows, bindings = _prepare(
        base_export_dir=base_export_dir,
        finals_dir=finals_dir,
        catalog_registry=catalog_registry,
        candidate_ids=candidate_ids,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        val_path = staging / VAL_FILE
        val_path.write_bytes(
            b"".join(
                (trainer.canonical_json(row) + "\n").encode("utf-8") for row in rows
            )
        )
        val_descriptor = _descriptor(val_path, record_count=len(rows))
        manifest = trainer.seal_record(
            {
                "artifacts": {VAL_FILE: val_descriptor},
                "bindings": copy.deepcopy(bindings),
                "candidate_count": len(candidate_ids),
                "candidate_ids": list(candidate_ids),
                "invariants": {
                    "base_test_rows_deserialized": 0,
                    "base_test_rows_rewritten": 0,
                    "base_train_rows_rewritten": 0,
                    "overlay_split": "val",
                    "val_sample_count": len(rows),
                },
                "record_type": RECORD_TYPE,
                "schema_version": SCHEMA_VERSION,
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
        report = trainer.seal_record(
            {
                "artifacts": {VAL_FILE: val_descriptor},
                "bindings": copy.deepcopy(bindings),
                "checks": {
                    "base_test_labels_deserialized": 0,
                    "base_test_pixels_opened": 0,
                    "base_train_record_count_unchanged": len(snapshot.train_examples),
                    "base_train_rows_modified": 0,
                    "overlay_rows_are_completed_human_gold": True,
                    "promoted_final_ids_exactly_match_val": True,
                    "val_pixels_opened": 0,
                },
                "manifest_sha256": trainer.sha256_file(manifest_path),
                "record_type": REPORT_TYPE,
                "schema_version": SCHEMA_VERSION,
                "val_record_count": len(rows),
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(trainer.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                MANIFEST_FILE: trainer.sha256_file(manifest_path),
                REPORT_FILE: trainer.sha256_file(report_path),
                VAL_FILE: trainer.sha256_file(val_path),
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        validate_overlay(
            overlay_dir=staging,
            base_export_dir=base_export_dir,
            finals_dir=finals_dir,
            catalog_registry=catalog_registry,
            candidate_ids=candidate_ids,
        )
        if output.exists():
            raise HumanValOverlayError("overlay output appeared during build")
        os.rename(staging, output)
        published = True
        return validate_overlay(
            overlay_dir=output,
            base_export_dir=base_export_dir,
            finals_dir=finals_dir,
            catalog_registry=catalog_registry,
            candidate_ids=candidate_ids,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_overlay(
    *,
    overlay_dir: Path,
    base_export_dir: Path,
    finals_dir: Path,
    catalog_registry: Path,
    candidate_ids: tuple[str, ...],
) -> dict[str, Any]:
    root = overlay_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise HumanValOverlayError("overlay directory is missing or linked")
    if {path.name for path in root.iterdir()} != set(OUTPUT_FILES):
        raise HumanValOverlayError("overlay root inventory drifted")
    marker = trainer.read_json(root / MARKER_FILE, location="overlay marker")
    if (
        set(marker) != {"artifacts", "owner", "safe_replace", "schema_version"}
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
    ):
        raise HumanValOverlayError("overlay marker drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "overlay marker.artifacts")
    if set(marker_artifacts) != {MANIFEST_FILE, REPORT_FILE, VAL_FILE} or any(
        marker_artifacts.get(name) != trainer.sha256_file(root / name)
        for name in marker_artifacts
    ):
        raise HumanValOverlayError("overlay marker hash drifted")
    manifest = trainer.read_json(root / MANIFEST_FILE, location="overlay manifest")
    report = trainer.read_json(root / REPORT_FILE, location="overlay report")
    trainer.validate_record_seal(manifest, location="overlay manifest")
    trainer.validate_record_seal(report, location="overlay report")
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type") != RECORD_TYPE
        or report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != REPORT_TYPE
        or report.get("manifest_sha256") != trainer.sha256_file(root / MANIFEST_FILE)
        or manifest.get("candidate_ids") != list(candidate_ids)
        or manifest.get("candidate_count") != len(candidate_ids)
    ):
        raise HumanValOverlayError("overlay schema/candidate contract drifted")
    snapshot, expected_rows, expected_bindings = _prepare(
        base_export_dir=base_export_dir,
        finals_dir=finals_dir,
        catalog_registry=catalog_registry,
        candidate_ids=candidate_ids,
    )
    if manifest.get("bindings") != expected_bindings or report.get("bindings") != expected_bindings:
        raise HumanValOverlayError("overlay input bindings drifted")
    descriptor = _mapping(
        _mapping(manifest.get("artifacts"), "overlay artifacts").get(VAL_FILE),
        "overlay val descriptor",
    )
    if descriptor != _descriptor(root / VAL_FILE, record_count=len(expected_rows)):
        raise HumanValOverlayError("overlay val descriptor drifted")
    if _mapping(report.get("artifacts"), "overlay report artifacts").get(VAL_FILE) != descriptor:
        raise HumanValOverlayError("overlay report descriptor drifted")
    rows: list[dict[str, Any]] = []
    with (root / VAL_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"overlay val:{line_number}"))
            except json.JSONDecodeError as error:
                raise HumanValOverlayError("overlay val JSON drifted") from error
            trainer.validate_record_seal(row, location=f"overlay val:{line_number}")
            rows.append(row)
    if [row["record_sha256"] for row in rows] != [
        row["record_sha256"] for row in expected_rows
    ]:
        raise HumanValOverlayError("overlay val rows differ from adjudicated authority")
    checks = _mapping(report.get("checks"), "overlay checks")
    if (
        checks.get("base_test_labels_deserialized") != 0
        or checks.get("base_test_pixels_opened") != 0
        or checks.get("base_train_rows_modified") != 0
        or checks.get("val_pixels_opened") != 0
        or len(rows) != len(snapshot.val_examples)
    ):
        raise HumanValOverlayError("overlay isolation checks drifted")
    return {
        "base_train_record_count": len(snapshot.train_examples),
        "combined_authority_sha256": expected_bindings["combined_authority_sha256"],
        "overlay_dir": str(root),
        "skipped_test_row_count": snapshot.skipped_test_rows,
        "status": "ready_for_val_only_merge",
        "val_record_count": len(rows),
        "val_samples_sha256": trainer.sha256_file(root / VAL_FILE),
    }


def apply_overlay(
    *,
    overlay_dir: Path,
    base_export_dir: Path,
    finals_dir: Path,
    catalog_registry: Path,
    candidate_ids: tuple[str, ...],
) -> tuple[trainer.HumanSnapshot, Mapping[str, Any]]:
    validation = validate_overlay(
        overlay_dir=overlay_dir,
        base_export_dir=base_export_dir,
        finals_dir=finals_dir,
        catalog_registry=catalog_registry,
        candidate_ids=candidate_ids,
    )
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    base_snapshot = trainer.validate_human_input(
        base_export_dir,
        candidate_ids=candidate_ids,
        catalog_registry_sha256=registry_sha,
    )
    rows: list[trainer.HumanExample] = []
    with (overlay_dir.expanduser().resolve() / VAL_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            rows.append(
                trainer._validate_human_row(  # noqa: SLF001
                    row,
                    split="val",
                    candidate_ids=candidate_ids,
                    catalog_registry_sha256=registry_sha,
                    location=f"applied overlay val:{line_number}",
                )
            )
    snapshot = trainer.HumanSnapshot(
        root=base_snapshot.root,
        train_examples=base_snapshot.train_examples,
        val_examples=tuple(rows),
        skipped_test_rows=base_snapshot.skipped_test_rows,
        marker_sha256=base_snapshot.marker_sha256,
        manifest_sha256=base_snapshot.manifest_sha256,
        report_sha256=base_snapshot.report_sha256,
        samples_sha256=str(validation["combined_authority_sha256"]),
    )
    return snapshot, validation


def _candidate_ids(finals_dir: Path) -> tuple[str, ...]:
    report = trainer.read_json(
        finals_dir.expanduser().resolve() / promotion.REPORT_FILE,
        location="promotion report",
    )
    values = report.get("candidate_ids")
    if not isinstance(values, list) or len(values) != trainer.CANDIDATE_COUNT:
        raise HumanValOverlayError("promotion candidate inventory drifted")
    candidate_ids = tuple(str(value) for value in values)
    if len(set(candidate_ids)) != trainer.CANDIDATE_COUNT:
        raise HumanValOverlayError("promotion candidates are duplicated")
    return candidate_ids


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "validate"):
        command = sub.add_parser(name)
        command.add_argument("--base-export-dir", type=Path, required=True)
        command.add_argument("--finals-dir", type=Path, required=True)
        command.add_argument("--catalog-registry", type=Path, required=True)
        command.add_argument("--overlay-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    candidate_ids = _candidate_ids(args.finals_dir)
    try:
        result = (
            build_overlay(
                base_export_dir=args.base_export_dir,
                finals_dir=args.finals_dir,
                catalog_registry=args.catalog_registry,
                candidate_ids=candidate_ids,
                output_dir=args.overlay_dir,
            )
            if args.command == "build"
            else validate_overlay(
                overlay_dir=args.overlay_dir,
                base_export_dir=args.base_export_dir,
                finals_dir=args.finals_dir,
                catalog_registry=args.catalog_registry,
                candidate_ids=candidate_ids,
            )
        )
    except (
        HumanValOverlayError,
        trainer.MangaFontStudentError,
        promotion.StudentCalibrationPromotionError,
        OSError,
    ) as error:
        raise SystemExit(f"human-val-overlay error: {error}") from error
    print(trainer.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
