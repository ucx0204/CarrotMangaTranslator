#!/usr/bin/env python3
"""Seal three secondary-review corrections over the named train48 overlay."""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import build_manga_font_named_train_review_v1 as named
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_named_train_review_v1 as named
    import train_manga_font_student_v1 as trainer


SCHEMA_VERSION = "manga-font-named-train-secondary-overlay-v1"
OWNER = "carrot-manga-translator/manga-font-named-train-secondary-overlay-v1"
MARKER_FILE = ".manga-font-named-train-secondary-overlay-v1-owned.json"
REPORT_FILE = "report.json"
OVERLAY_FILE = "train-samples-named-secondary-overlay.jsonl"
FILES = frozenset({MARKER_FILE, REPORT_FILE, OVERLAY_FILE})
EXPECTED_CORRECTIONS = 3


class SecondaryNamedTrainOverlayError(trainer.MangaFontStudentError):
    """Raised when secondary train-only corrections drift."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SecondaryNamedTrainOverlayError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise SecondaryNamedTrainOverlayError(f"{location}: expected array")
    return value


def _safe_output(path: Path) -> Path:
    return trainer._safe_output_path(path)  # noqa: SLF001


def _read_base_rows(overlay_dir: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    validation = named.validate_overlay(overlay_dir)
    root = overlay_dir.expanduser().resolve()
    rows: list[dict[str, Any]] = []
    with (root / named.OVERLAY_FILE).open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"base overlay:{number}"))
            trainer.validate_record_seal(row, location=f"base overlay:{number}")
            rows.append(row)
    if len(rows) != validation["record_count"]:
        raise SecondaryNamedTrainOverlayError("base overlay count drifted")
    return rows, dict(validation)


def _partition(entry: Mapping[str, Any], *, sample_id: str) -> dict[str, Any]:
    chosen = {
        tier: [str(value) for value in _list(entry.get(tier), f"{sample_id}.{tier}")]
        for tier in ("preferred", "acceptable", "marginal")
    }
    flattened = [value for values in chosen.values() for value in values]
    if (
        not chosen["preferred"]
        or len(flattened) != len(set(flattened))
        or not set(flattened) <= set(named.EXPECTED_IDS)
    ):
        raise SecondaryNamedTrainOverlayError(
            f"{sample_id}: invalid secondary candidate partition"
        )
    remaining = [
        value for value in named.EXPECTED_IDS if value not in set(flattened)
    ]
    return {
        "acceptable": chosen["acceptable"],
        "marginal": chosen["marginal"],
        "none_acceptable": False,
        "not_reviewed": [],
        "preferred": chosen["preferred"],
        "unacceptable": remaining,
        "unrenderable": [],
    }


def build_secondary_overlay(
    *,
    base_overlay_dir: Path,
    corrections_path: Path,
    catalog_registry: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    base_rows, base_validation = _read_base_rows(base_overlay_dir)
    corrections = trainer.read_json(
        corrections_path, location="secondary named corrections"
    )
    if len(corrections) != EXPECTED_CORRECTIONS:
        raise SecondaryNamedTrainOverlayError(
            f"expected {EXPECTED_CORRECTIONS} secondary corrections"
        )
    by_id = {str(row["sample_id"]): row for row in base_rows}
    if not set(corrections) <= set(by_id):
        raise SecondaryNamedTrainOverlayError(
            "secondary correction is outside the sealed train48 overlay"
        )
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    correction_sha = trainer.sha256_file(corrections_path.expanduser().resolve())
    output_rows: list[dict[str, Any]] = []
    corrected_ids: list[str] = []
    for base_row in base_rows:
        sample_id = str(base_row["sample_id"])
        if sample_id not in corrections:
            output_rows.append(base_row)
            continue
        entry = _mapping(corrections[sample_id], f"corrections.{sample_id}")
        confidence = float(entry.get("confidence"))
        if not 0.0 <= confidence <= 1.0:
            raise SecondaryNamedTrainOverlayError(
                f"{sample_id}: invalid correction confidence"
            )
        row = copy.deepcopy(base_row)
        base_record_sha = str(row.pop("record_sha256"))
        row["font_judgment"] = _partition(entry, sample_id=sample_id)
        provenance = dict(_mapping(row.get("provenance"), "provenance"))
        provenance["named_train_secondary_overlay"] = {
            "base_named_overlay_record_sha256": base_record_sha,
            "corrections_file_sha256": correction_sha,
            "font_judgment_only": True,
            "schema_version": SCHEMA_VERSION,
            "test_data_used": False,
        }
        row["provenance"] = provenance
        review = dict(_mapping(row.get("review_provenance"), "review provenance"))
        review["named_train_secondary_overlay"] = {
            "confidence": confidence,
            "notes": str(entry.get("notes", "")),
            "reviewer": "independent-secondary-named-font-review-v1",
            "schema_version": SCHEMA_VERSION,
        }
        row["review_provenance"] = review
        row = trainer.seal_record(row)
        trainer._validate_human_row(  # noqa: SLF001
            row,
            split="train",
            candidate_ids=named.EXPECTED_IDS,
            catalog_registry_sha256=registry_sha,
            location=f"secondary named overlay {sample_id}",
        )
        output_rows.append(row)
        corrected_ids.append(sample_id)
    if len(corrected_ids) != EXPECTED_CORRECTIONS:
        raise SecondaryNamedTrainOverlayError("secondary correction count drifted")

    output = _safe_output(output_dir)
    if output.exists():
        raise SecondaryNamedTrainOverlayError("secondary overlay output exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        (staging / OVERLAY_FILE).write_bytes(
            b"".join(
                (trainer.canonical_json(row) + "\n").encode("utf-8")
                for row in output_rows
            )
        )
        report = trainer.seal_record(
            {
                "artifacts": {
                    OVERLAY_FILE: {
                        "byte_size": (staging / OVERLAY_FILE).stat().st_size,
                        "file": OVERLAY_FILE,
                        "record_count": len(output_rows),
                        "sha256": trainer.sha256_file(staging / OVERLAY_FILE),
                    }
                },
                "bindings": {
                    "base_overlay_report_sha256": trainer.sha256_file(
                        base_overlay_dir.expanduser().resolve() / named.REPORT_FILE
                    ),
                    "base_overlay_rows_sha256": trainer.sha256_file(
                        base_overlay_dir.expanduser().resolve() / named.OVERLAY_FILE
                    ),
                    "corrections_sha256": correction_sha,
                },
                "checks": {
                    "base_hidden_test_rows_json_deserialized": 0,
                    "base_hidden_test_pixels_opened": 0,
                    "correction_scope": "font_judgment_plus_provenance_only",
                    "output_split": "train",
                    "uncorrected_rows_byte_identical": len(output_rows)
                    - EXPECTED_CORRECTIONS,
                    "val_rows_modified": 0,
                    "view_bindings_modified": 0,
                },
                "corrected_sample_ids": sorted(corrected_ids),
                "correction_count": len(corrected_ids),
                "record_count": len(output_rows),
                "record_type": "manga_font_named_train_secondary_overlay_report",
                "schema_version": SCHEMA_VERSION,
                "source_base_overlay": base_validation,
            }
        )
        (staging / REPORT_FILE).write_bytes(trainer.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: trainer.sha256_file(staging / name)
                for name in (OVERLAY_FILE, REPORT_FILE)
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        validate_secondary_overlay(
            output_dir=staging,
            base_overlay_dir=base_overlay_dir,
            corrections_path=corrections_path,
        )
        if output.exists():
            raise SecondaryNamedTrainOverlayError("secondary output appeared")
        os.rename(staging, output)
        published = True
        return validate_secondary_overlay(
            output_dir=output,
            base_overlay_dir=base_overlay_dir,
            corrections_path=corrections_path,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_secondary_overlay(
    *,
    output_dir: Path,
    base_overlay_dir: Path,
    corrections_path: Path,
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != FILES
    ):
        raise SecondaryNamedTrainOverlayError("secondary overlay inventory drifted")
    marker = trainer.read_json(root / MARKER_FILE, location="secondary marker")
    report = trainer.read_json(root / REPORT_FILE, location="secondary report")
    trainer.validate_record_seal(report, location="secondary report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
        or report.get("schema_version") != SCHEMA_VERSION
    ):
        raise SecondaryNamedTrainOverlayError("secondary overlay metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "secondary artifacts")
    for name in (OVERLAY_FILE, REPORT_FILE):
        if artifacts.get(name) != trainer.sha256_file(root / name):
            raise SecondaryNamedTrainOverlayError(
                f"secondary overlay hash drifted: {name}"
            )
    bindings = _mapping(report.get("bindings"), "secondary bindings")
    base_root = base_overlay_dir.expanduser().resolve()
    if (
        bindings.get("base_overlay_report_sha256")
        != trainer.sha256_file(base_root / named.REPORT_FILE)
        or bindings.get("base_overlay_rows_sha256")
        != trainer.sha256_file(base_root / named.OVERLAY_FILE)
        or bindings.get("corrections_sha256")
        != trainer.sha256_file(corrections_path.expanduser().resolve())
    ):
        raise SecondaryNamedTrainOverlayError("secondary source binding drifted")
    named.validate_overlay(base_root)
    rows: list[dict[str, Any]] = []
    with (root / OVERLAY_FILE).open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"secondary overlay:{number}"))
            trainer.validate_record_seal(row, location=f"secondary overlay:{number}")
            if row.get("split") != "train":
                raise SecondaryNamedTrainOverlayError(
                    "secondary overlay contains a non-train row"
                )
            rows.append(row)
    if (
        len(rows) != report.get("record_count")
        or report.get("correction_count") != EXPECTED_CORRECTIONS
    ):
        raise SecondaryNamedTrainOverlayError("secondary row count drifted")
    return {
        "corrected_sample_ids": report.get("corrected_sample_ids"),
        "correction_count": report.get("correction_count"),
        "output_dir": str(root),
        "record_count": len(rows),
        "status": "ready_for_final_train_only_merge",
    }


def apply_secondary_overlay(
    snapshot: trainer.HumanSnapshot,
    *,
    base_overlay_dir: Path,
    secondary_overlay_dir: Path,
    corrections_path: Path,
    catalog_registry: Path,
    candidate_ids: tuple[str, ...] = named.EXPECTED_IDS,
) -> tuple[trainer.HumanSnapshot, Mapping[str, Any]]:
    """Apply train48, then replace exactly its three corrected rows."""

    validation = validate_secondary_overlay(
        output_dir=secondary_overlay_dir,
        base_overlay_dir=base_overlay_dir,
        corrections_path=corrections_path,
    )
    merged, base_validation = named.apply_train_overlay(
        snapshot,
        overlay_dir=base_overlay_dir,
        catalog_registry=catalog_registry,
        candidate_ids=candidate_ids,
        expected_replacements=48,
    )
    root = secondary_overlay_dir.expanduser().resolve()
    corrected_ids = set(validation["corrected_sample_ids"])
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    replacements: dict[str, trainer.HumanExample] = {}
    with (root / OVERLAY_FILE).open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"applied secondary:{number}"))
            sample_id = str(row["sample_id"])
            if sample_id not in corrected_ids:
                continue
            replacements[sample_id] = trainer._validate_human_row(  # noqa: SLF001
                row,
                split="train",
                candidate_ids=candidate_ids,
                catalog_registry_sha256=registry_sha,
                location=f"applied secondary correction:{number}",
            )
    if set(replacements) != corrected_ids:
        raise SecondaryNamedTrainOverlayError(
            "secondary corrected identity set drifted"
        )
    merged_train = tuple(
        replacements.get(example.sample_id, example)
        for example in merged.train_examples
    )
    final = trainer.HumanSnapshot(
        root=merged.root,
        train_examples=merged_train,
        val_examples=merged.val_examples,
        skipped_test_rows=merged.skipped_test_rows,
        marker_sha256=merged.marker_sha256,
        manifest_sha256=merged.manifest_sha256,
        report_sha256=merged.report_sha256,
        samples_sha256=merged.samples_sha256,
    )
    return final, {
        **dict(validation),
        "base_overlay": dict(base_validation),
        "hidden_test_labels_deserialized": 0,
        "hidden_test_pixels_opened": 0,
        "train_record_count_unchanged": len(final.train_examples),
        "val_record_count_unchanged": len(final.val_examples),
        "val_rows_modified": 0,
        "view_bindings_modified": 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--base-overlay-dir", type=Path, required=True)
    build.add_argument("--corrections", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--base-overlay-dir", type=Path, required=True)
    validate.add_argument("--corrections", type=Path, required=True)
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = (
            build_secondary_overlay(
                base_overlay_dir=args.base_overlay_dir,
                corrections_path=args.corrections,
                catalog_registry=args.catalog_registry,
                output_dir=args.output_dir,
            )
            if args.command == "build"
            else validate_secondary_overlay(
                output_dir=args.output_dir,
                base_overlay_dir=args.base_overlay_dir,
                corrections_path=args.corrections,
            )
        )
    except (trainer.MangaFontStudentError, OSError, ValueError) as error:
        raise SystemExit(f"secondary-named-train-overlay error: {error}") from error
    print(trainer.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
