#!/usr/bin/env python3
"""Promote the sealed legacy-15 train rows into masked 22-font supervision.

Only rows whose sealed split is ``train`` are JSON-deserialized.  Legacy val
and test rows are classified with the byte-level scanner from the student
trainer and skipped while their label payload remains opaque.  The seven
successor-only fonts are recorded as ``not_reviewed`` and are therefore not
treated as negatives.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v1 as trainer


SCHEMA_VERSION = "manga-font-legacy15-train-overlay-v1"
OWNER = "carrot-manga-translator/manga-font-legacy15-train-overlay-v1"
MARKER_FILE = ".manga-font-legacy15-train-overlay-v1-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OVERLAY_FILE = "train-samples-legacy15-partial22.jsonl"

FULL22_CANDIDATE_IDS = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
    "black-and-white-picture",
    "black-han-sans",
    "gasoek-one",
    "gugi",
    "kirang-haerang",
    "nanum-brush-script",
    "single-day",
)
LEGACY15_CANDIDATE_IDS = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
)
SUCCESSOR_ONLY_CANDIDATE_IDS = tuple(
    value for value in FULL22_CANDIDATE_IDS if value not in LEGACY15_CANDIDATE_IDS
)
OUTPUT_FILES = frozenset({MARKER_FILE, MANIFEST_FILE, REPORT_FILE, OVERLAY_FILE})


class Legacy15TrainOverlayError(ValueError):
    """Raised when the legacy-only train authority is unsafe or inconsistent."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise Legacy15TrainOverlayError(f"{location}: expected object")
    return value


def _safe_output(path: Path) -> Path:
    output = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}
    if output in forbidden or len(output.parts) < 3 or len(output.name) < 3:
        raise Legacy15TrainOverlayError(f"unsafe output: {output}")
    return output


def _descriptor(path: Path, *, record_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise Legacy15TrainOverlayError(f"artifact missing or linked: {path}")
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


def _validate_export_metadata(
    root: Path, *, catalog_registry_sha256: str
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    root = root.expanduser().resolve()
    marker_path = root / trainer.HUMAN_EXPORT_MARKER
    manifest_path = root / "manifest.json"
    report_path = root / "report.json"
    marker = trainer.read_json(marker_path, location="legacy export marker")
    manifest = trainer.read_json(manifest_path, location="legacy export manifest")
    report = trainer.read_json(report_path, location="legacy export report")
    if set(marker) != {
        "manifest_sha256",
        "owner",
        "report_sha256",
        "safe_replace",
        "schema_version",
    } or (
        marker.get("owner") != trainer.HUMAN_EXPORT_OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != trainer.HUMAN_EXPORT_SCHEMA
    ):
        raise Legacy15TrainOverlayError("legacy export ownership marker is invalid")
    manifest_sha = trainer.sha256_file(manifest_path)
    report_sha = trainer.sha256_file(report_path)
    if (
        marker.get("manifest_sha256") != manifest_sha
        or marker.get("report_sha256") != report_sha
        or report.get("manifest_sha256") != manifest_sha
    ):
        raise Legacy15TrainOverlayError("legacy export metadata hash binding failed")
    if (
        manifest.get("schema_version") != trainer.HUMAN_EXPORT_SCHEMA
        or report.get("schema_version") != trainer.HUMAN_EXPORT_REPORT_SCHEMA
        or manifest.get("candidate_count") != len(LEGACY15_CANDIDATE_IDS)
    ):
        raise Legacy15TrainOverlayError("legacy export schema/candidate count drifted")
    registry = _mapping(
        manifest.get("registry_exclusions"), "legacy manifest.registry_exclusions"
    )
    if registry.get("catalog_registry_sha256") != catalog_registry_sha256:
        raise Legacy15TrainOverlayError("legacy export binds another catalog registry")
    contracts = _mapping(manifest.get("contracts"), "legacy manifest.contracts")
    source = _mapping(contracts.get("source_inputs"), "legacy contracts.source_inputs")
    isolation = _mapping(
        contracts.get("augmentation_isolation"),
        "legacy contracts.augmentation_isolation",
    )
    evaluation = _mapping(contracts.get("evaluation"), "legacy contracts.evaluation")
    if (
        source.get("required_views") != list(trainer.VIEW_NAMES)
        or source.get("review_card_pixels_allowed") is not False
        or isolation.get("core_files_accept_synthetic") is not False
        or isolation.get("evaluation_splits_accept_generated") is not False
        or evaluation.get("generated_examples_allowed") is not False
        or evaluation.get("qa_overlay_examples_allowed") is not False
    ):
        raise Legacy15TrainOverlayError("legacy source/evaluation contract is unsafe")
    checks = _mapping(report.get("checks"), "legacy report.checks")
    for key in (
        "core_qa_overlay_count",
        "core_synthetic_count",
        "generated_evaluation_count",
        "not_reviewed_candidate_count",
        "work_split_leakage_count",
    ):
        if checks.get(key) != 0:
            raise Legacy15TrainOverlayError(f"legacy export report check failed: {key}")
    artifacts = _mapping(manifest.get("artifacts"), "legacy manifest.artifacts")
    outputs = _mapping(report.get("outputs"), "legacy report.outputs")
    for name, raw_descriptor in artifacts.items():
        descriptor = _mapping(raw_descriptor, f"legacy artifact {name}")
        path = root / str(name)
        if (
            path.is_symlink()
            or not path.is_file()
            or descriptor.get("file") != name
            or descriptor.get("byte_size") != path.stat().st_size
            or descriptor.get("sha256") != trainer.sha256_file(path)
            or outputs.get(name) != descriptor
        ):
            raise Legacy15TrainOverlayError(f"legacy artifact binding drifted: {name}")
    samples = _mapping(artifacts.get("samples.jsonl"), "legacy samples descriptor")
    return dict(manifest), dict(report), {
        "manifest_sha256": manifest_sha,
        "marker_sha256": trainer.sha256_file(marker_path),
        "report_sha256": report_sha,
        "samples_byte_size": samples.get("byte_size"),
        "samples_record_count": samples.get("record_count"),
        "samples_sha256": samples.get("sha256"),
    }


def validate_partial_human_row(
    row: Mapping[str, Any],
    *,
    candidate_ids: tuple[str, ...],
    catalog_registry_sha256: str,
    location: str,
    legacy_samples_sha256: str | None = None,
) -> trainer.HumanExample:
    """Validate one legacy-15 label as partial, masked 22-font supervision."""

    if tuple(candidate_ids) != FULL22_CANDIDATE_IDS:
        raise Legacy15TrainOverlayError("full22 candidate order drifted")
    trainer.validate_record_seal(row, location=location)
    judgment = _mapping(row.get("font_judgment"), f"{location}.font_judgment")
    if set(judgment) != trainer.HUMAN_JUDGMENT_KEYS:
        raise Legacy15TrainOverlayError(f"{location}: judgment schema drifted")
    not_reviewed = tuple(judgment.get("not_reviewed", ()))
    if not_reviewed != SUCCESSOR_ONLY_CANDIDATE_IDS:
        raise Legacy15TrainOverlayError(
            f"{location}: successor-only mask must be exact and ordered"
        )
    flattened: list[str] = []
    for tier in trainer.HUMAN_TIERS:
        values = judgment.get(tier)
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise Legacy15TrainOverlayError(f"{location}: invalid tier {tier}")
        if len(values) != len(set(values)):
            raise Legacy15TrainOverlayError(f"{location}: duplicate tier value")
        flattened.extend(values)
    if len(flattened) != len(candidate_ids) or set(flattened) != set(candidate_ids):
        raise Legacy15TrainOverlayError(f"{location}: tiers do not partition full22")
    if any(
        value in SUCCESSOR_ONLY_CANDIDATE_IDS
        for tier in trainer.HUMAN_TIERS
        if tier != "not_reviewed"
        for value in judgment[tier]
    ):
        raise Legacy15TrainOverlayError(f"{location}: masked candidate leaked into a tier")
    provenance = _mapping(row.get("provenance"), f"{location}.provenance")
    overlay = _mapping(
        provenance.get("legacy15_train_overlay"),
        f"{location}.provenance.legacy15_train_overlay",
    )
    if (
        overlay.get("label_scope") != "legacy15_only"
        or overlay.get("legacy_candidate_ids_sha256")
        != _ordered_digest(LEGACY15_CANDIDATE_IDS)
        or overlay.get("successor_candidates_used_as_negatives") is not False
        or overlay.get("non_train_labels_deserialized") != 0
        or overlay.get("schema_version") != SCHEMA_VERSION
        or overlay.get("successor_candidate_ids")
        != list(SUCCESSOR_ONLY_CANDIDATE_IDS)
    ):
        raise Legacy15TrainOverlayError(f"{location}: partial-label provenance drifted")
    try:
        source_samples_sha = trainer.require_sha(
            overlay.get("legacy_samples_sha256"),
            f"{location}.provenance.legacy15_train_overlay.legacy_samples_sha256",
        )
        source_record_sha = trainer.require_sha(
            overlay.get("source_legacy_train_record_sha256"),
            f"{location}.provenance.legacy15_train_overlay.source_record_sha256",
        )
    except trainer.MangaFontStudentError as error:
        raise Legacy15TrainOverlayError(str(error)) from error
    if legacy_samples_sha256 is not None and source_samples_sha != legacy_samples_sha256:
        raise Legacy15TrainOverlayError(f"{location}: legacy samples authority drifted")
    review_provenance = _mapping(
        row.get("review_provenance"), f"{location}.review_provenance"
    )
    review_overlay = _mapping(
        review_provenance.get("legacy15_train_overlay"),
        f"{location}.review_provenance.legacy15_train_overlay",
    )
    if (
        review_overlay.get("relationship")
        != "sealed_legacy15_train_label_to_partial22"
        or review_overlay.get("schema_version") != SCHEMA_VERSION
        or review_overlay.get("source_legacy_train_record_sha256")
        != source_record_sha
    ):
        raise Legacy15TrainOverlayError(f"{location}: review source binding drifted")

    restored_legacy = copy.deepcopy(dict(row))
    restored_legacy.pop("record_sha256", None)
    restored_judgment = copy.deepcopy(dict(judgment))
    restored_judgment["not_reviewed"] = []
    restored_legacy["font_judgment"] = restored_judgment
    restored_provenance = dict(
        _mapping(restored_legacy.get("provenance"), f"{location}.provenance")
    )
    restored_provenance.pop("legacy15_train_overlay", None)
    restored_legacy["provenance"] = restored_provenance
    restored_review = dict(
        _mapping(
            restored_legacy.get("review_provenance"),
            f"{location}.review_provenance",
        )
    )
    restored_review.pop("legacy15_train_overlay", None)
    restored_legacy["review_provenance"] = restored_review
    restored_record_sha = trainer.sha256_bytes(
        trainer.canonical_json(restored_legacy).encode("utf-8")
    )
    if restored_record_sha != source_record_sha:
        raise Legacy15TrainOverlayError(f"{location}: legacy source lineage drifted")

    # Reuse the strict full-row validator with an in-memory surrogate.  Moving
    # the seven masked candidates to unrenderable produces the same eligibility
    # mask without changing any positive, style, role, treatment, or pixel field.
    surrogate = copy.deepcopy(dict(row))
    surrogate.pop("record_sha256", None)
    surrogate_judgment = copy.deepcopy(dict(judgment))
    surrogate_judgment["unrenderable"] = [
        *surrogate_judgment["unrenderable"],
        *SUCCESSOR_ONLY_CANDIDATE_IDS,
    ]
    surrogate_judgment["not_reviewed"] = []
    surrogate["font_judgment"] = surrogate_judgment
    surrogate = trainer.seal_record(surrogate)
    try:
        validated = trainer._validate_human_row(  # noqa: SLF001
            surrogate,
            split="train",
            candidate_ids=candidate_ids,
            catalog_registry_sha256=catalog_registry_sha256,
            location=f"{location}.eligibility-surrogate",
        )
    except trainer.MangaFontStudentError as error:
        raise Legacy15TrainOverlayError(str(error)) from error
    expected_eligible = tuple(
        index
        for index, candidate_id in enumerate(candidate_ids)
        if candidate_id in LEGACY15_CANDIDATE_IDS
        and candidate_id not in set(judgment["unrenderable"])
    )
    if validated.eligible_indices != expected_eligible:
        raise Legacy15TrainOverlayError(f"{location}: partial eligibility drifted")
    return trainer.HumanExample(
        sample_id=validated.sample_id,
        work_id=validated.work_id,
        split=validated.split,
        positive_indices=validated.positive_indices,
        eligible_indices=validated.eligible_indices,
        none_target=validated.none_target,
        role_index=validated.role_index,
        style_values=validated.style_values,
        style_mask=validated.style_mask,
        treatment_indices=validated.treatment_indices,
        row=copy.deepcopy(dict(row)),
    )


def _promote_legacy_train_row(
    row: Mapping[str, Any],
    *,
    catalog_registry_sha256: str,
    legacy_samples_sha256: str,
) -> dict[str, Any]:
    trainer.validate_record_seal(row, location="legacy train source row")
    if row.get("schema_version") != trainer.HUMAN_SAMPLE_SCHEMA or row.get("split") != "train":
        raise Legacy15TrainOverlayError("legacy source is not a train sample")
    judgment = _mapping(row.get("font_judgment"), "legacy font_judgment")
    if set(judgment) != trainer.HUMAN_JUDGMENT_KEYS:
        raise Legacy15TrainOverlayError("legacy judgment schema drifted")
    flattened = [
        value
        for tier in trainer.HUMAN_TIERS
        for value in judgment.get(tier, [])
    ]
    if (
        len(flattened) != len(LEGACY15_CANDIDATE_IDS)
        or set(flattened) != set(LEGACY15_CANDIDATE_IDS)
        or judgment.get("not_reviewed") != []
    ):
        raise Legacy15TrainOverlayError("legacy judgment is not a complete 15-font partition")
    promoted = copy.deepcopy(dict(row))
    legacy_record_sha = str(promoted.pop("record_sha256"))
    promoted_judgment = copy.deepcopy(dict(judgment))
    promoted_judgment["not_reviewed"] = list(SUCCESSOR_ONLY_CANDIDATE_IDS)
    promoted["font_judgment"] = promoted_judgment
    provenance = dict(_mapping(promoted.get("provenance"), "legacy provenance"))
    provenance["legacy15_train_overlay"] = {
        "label_scope": "legacy15_only",
        "legacy_candidate_ids_sha256": _ordered_digest(LEGACY15_CANDIDATE_IDS),
        "legacy_samples_sha256": legacy_samples_sha256,
        "non_train_labels_deserialized": 0,
        "source_legacy_train_record_sha256": legacy_record_sha,
        "schema_version": SCHEMA_VERSION,
        "successor_candidate_ids": list(SUCCESSOR_ONLY_CANDIDATE_IDS),
        "successor_candidates_used_as_negatives": False,
    }
    promoted["provenance"] = provenance
    review_provenance = dict(
        _mapping(promoted.get("review_provenance"), "legacy review_provenance")
    )
    review_provenance["legacy15_train_overlay"] = {
        "relationship": "sealed_legacy15_train_label_to_partial22",
        "schema_version": SCHEMA_VERSION,
        "source_legacy_train_record_sha256": legacy_record_sha,
    }
    promoted["review_provenance"] = review_provenance
    promoted = trainer.seal_record(promoted)
    validate_partial_human_row(
        promoted,
        candidate_ids=FULL22_CANDIDATE_IDS,
        catalog_registry_sha256=catalog_registry_sha256,
        location=f"promoted legacy train {promoted.get('sample_id')}",
    )
    return promoted


def _load_legacy_train_additions(
    *,
    legacy_export_dir: Path,
    strict_train_ids: frozenset[str],
    strict_train_works: frozenset[str],
    catalog_registry_sha256: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    root = legacy_export_dir.expanduser().resolve()
    manifest, report, metadata = _validate_export_metadata(
        root, catalog_registry_sha256=catalog_registry_sha256
    )
    samples_path = root / "samples.jsonl"
    digest = hashlib.sha256()
    split_counts = {"train": 0, "val": 0, "test": 0}
    parsed_train = 0
    overlap = 0
    additions: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    with samples_path.open("rb") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            digest.update(raw_line)
            if not raw_line.strip():
                continue
            split = trainer.top_level_string_field_without_deserializing(raw_line, "split")
            if split not in split_counts:
                raise Legacy15TrainOverlayError(f"legacy row {line_number}: invalid split")
            split_counts[split] += 1
            if split != "train":
                continue
            parsed_train += 1
            try:
                row = dict(_mapping(json.loads(raw_line), f"legacy train row {line_number}"))
            except json.JSONDecodeError as error:
                raise Legacy15TrainOverlayError(
                    f"legacy train row {line_number}: invalid JSON"
                ) from error
            promoted = _promote_legacy_train_row(
                row,
                catalog_registry_sha256=catalog_registry_sha256,
                legacy_samples_sha256=str(metadata["samples_sha256"]),
            )
            sample_id = str(promoted.get("sample_id"))
            work_id = str(promoted.get("work_id"))
            if sample_id in seen_ids or work_id not in strict_train_works:
                raise Legacy15TrainOverlayError(
                    f"legacy train row escaped strict train authority: {sample_id}"
                )
            seen_ids.add(sample_id)
            if sample_id in strict_train_ids:
                overlap += 1
                continue
            additions.append(promoted)
    summary = _mapping(report.get("summary"), "legacy report.summary")
    reported_splits = _mapping(summary.get("by_split"), "legacy report.summary.by_split")
    if (
        digest.hexdigest() != metadata["samples_sha256"]
        or samples_path.stat().st_size != metadata["samples_byte_size"]
        or sum(split_counts.values()) != metadata["samples_record_count"]
        or split_counts != {key: int(value) for key, value in reported_splits.items()}
        or parsed_train != split_counts["train"]
        or len(strict_train_ids) != overlap
    ):
        raise Legacy15TrainOverlayError("legacy row counts or artifact binding drifted")
    return additions, {
        "legacy_export": {
            **metadata,
            "root_name": root.name,
        },
        "legacy_manifest_candidate_count": manifest.get("candidate_count"),
        "legacy_non_train_rows_byte_skipped": split_counts["val"] + split_counts["test"],
        "legacy_test_rows_byte_skipped": split_counts["test"],
        "legacy_train_rows_json_deserialized": parsed_train,
        "legacy_val_rows_byte_skipped": split_counts["val"],
        "overlapping_strict_full22_train_rows_preserved": overlap,
    }


def _base_bindings(snapshot: trainer.HumanSnapshot) -> dict[str, Any]:
    return {
        "manifest_sha256": snapshot.manifest_sha256,
        "marker_sha256": snapshot.marker_sha256,
        "report_sha256": snapshot.report_sha256,
        "root_name": snapshot.root.name,
        "samples_sha256": snapshot.samples_sha256,
        "skipped_test_row_count": snapshot.skipped_test_rows,
        "train_record_count": len(snapshot.train_examples),
        "train_sample_ids_sha256": _ordered_digest(
            [example.sample_id for example in snapshot.train_examples]
        ),
        "train_work_ids_sha256": _ordered_digest(
            sorted({example.work_id for example in snapshot.train_examples})
        ),
        "val_record_count": len(snapshot.val_examples),
    }


def build_overlay(
    *,
    base_full22_export_dir: Path,
    legacy15_export_dir: Path,
    catalog_registry: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    output = _safe_output(output_dir)
    if output.exists():
        raise Legacy15TrainOverlayError("overlay output already exists")
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    try:
        snapshot = trainer.validate_human_input(
            base_full22_export_dir,
            candidate_ids=FULL22_CANDIDATE_IDS,
            catalog_registry_sha256=registry_sha,
        )
    except trainer.MangaFontStudentError as error:
        raise Legacy15TrainOverlayError(str(error)) from error
    strict_ids = frozenset(example.sample_id for example in snapshot.train_examples)
    strict_works = frozenset(example.work_id for example in snapshot.train_examples)
    additions, legacy = _load_legacy_train_additions(
        legacy_export_dir=legacy15_export_dir,
        strict_train_ids=strict_ids,
        strict_train_works=strict_works,
        catalog_registry_sha256=registry_sha,
    )
    if not additions:
        raise Legacy15TrainOverlayError("legacy overlay has no new train rows")
    bindings = {
        "base_full22_export": _base_bindings(snapshot),
        "catalog_registry_sha256": registry_sha,
        **legacy,
    }
    bindings["combined_authority_sha256"] = trainer.sha256_bytes(
        trainer.canonical_json(bindings).encode("utf-8")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        overlay_path = staging / OVERLAY_FILE
        overlay_path.write_bytes(
            b"".join(
                (trainer.canonical_json(row) + "\n").encode("utf-8")
                for row in additions
            )
        )
        descriptor = _descriptor(overlay_path, record_count=len(additions))
        manifest = trainer.seal_record(
            {
                "artifacts": {OVERLAY_FILE: descriptor},
                "bindings": copy.deepcopy(bindings),
                "candidate_ids": list(FULL22_CANDIDATE_IDS),
                "invariants": {
                    "base_full22_train_rows_replaced": 0,
                    "legacy_non_train_labels_deserialized": 0,
                    "legacy_train_addition_count": len(additions),
                    "label_scope": "legacy15_only",
                    "successor_candidate_ids": list(SUCCESSOR_ONLY_CANDIDATE_IDS),
                    "successor_candidates_used_as_negatives": False,
                },
                "record_type": "manga_font_legacy15_train_overlay_manifest",
                "schema_version": SCHEMA_VERSION,
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
        report = trainer.seal_record(
            {
                "artifacts": {OVERLAY_FILE: descriptor},
                "bindings": copy.deepcopy(bindings),
                "checks": {
                    "base_hidden_test_labels_deserialized": 0,
                    "base_hidden_test_pixels_opened": 0,
                    "legacy_non_train_labels_deserialized": 0,
                    "legacy_non_train_pixels_opened": 0,
                    "new7_negative_supervision_count": 0,
                    "strict_train_overlap_preserved": len(strict_ids),
                    "val_rows_modified": 0,
                },
                "combined_train_record_count": len(snapshot.train_examples) + len(additions),
                "manifest_sha256": trainer.sha256_file(manifest_path),
                "record_type": "manga_font_legacy15_train_overlay_report",
                "schema_version": SCHEMA_VERSION,
                "train_addition_count": len(additions),
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(trainer.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                MANIFEST_FILE: trainer.sha256_file(manifest_path),
                OVERLAY_FILE: trainer.sha256_file(overlay_path),
                REPORT_FILE: trainer.sha256_file(report_path),
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        validate_overlay(
            staging,
            candidate_ids=FULL22_CANDIDATE_IDS,
            catalog_registry_sha256=registry_sha,
        )
        if output.exists():
            raise Legacy15TrainOverlayError("overlay output appeared during build")
        os.rename(staging, output)
        published = True
        return validate_overlay(
            output,
            candidate_ids=FULL22_CANDIDATE_IDS,
            catalog_registry_sha256=registry_sha,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_overlay(
    overlay_dir: Path,
    *,
    candidate_ids: tuple[str, ...] = FULL22_CANDIDATE_IDS,
    catalog_registry_sha256: str,
) -> dict[str, Any]:
    root = overlay_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != set(OUTPUT_FILES)
    ):
        raise Legacy15TrainOverlayError("overlay inventory drifted")
    marker = trainer.read_json(root / MARKER_FILE, location="legacy overlay marker")
    manifest = trainer.read_json(root / MANIFEST_FILE, location="legacy overlay manifest")
    report = trainer.read_json(root / REPORT_FILE, location="legacy overlay report")
    trainer.validate_record_seal(manifest, location="legacy overlay manifest")
    trainer.validate_record_seal(report, location="legacy overlay report")
    if (
        set(marker) != {"artifacts", "owner", "safe_replace", "schema_version"}
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
        or manifest.get("schema_version") != SCHEMA_VERSION
        or report.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_legacy15_train_overlay_manifest"
        or report.get("record_type") != "manga_font_legacy15_train_overlay_report"
        or manifest.get("candidate_ids") != list(candidate_ids)
    ):
        raise Legacy15TrainOverlayError("overlay metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "legacy overlay marker.artifacts")
    if set(artifacts) != {MANIFEST_FILE, OVERLAY_FILE, REPORT_FILE}:
        raise Legacy15TrainOverlayError("overlay marker artifact inventory drifted")
    for name, expected_sha in artifacts.items():
        if trainer.sha256_file(root / name) != expected_sha:
            raise Legacy15TrainOverlayError(f"overlay artifact hash drifted: {name}")
    bindings = _mapping(manifest.get("bindings"), "legacy overlay manifest.bindings")
    report_bindings = _mapping(report.get("bindings"), "legacy overlay report.bindings")
    expected_binding_keys = {
        "base_full22_export",
        "catalog_registry_sha256",
        "combined_authority_sha256",
        "legacy_export",
        "legacy_manifest_candidate_count",
        "legacy_non_train_rows_byte_skipped",
        "legacy_test_rows_byte_skipped",
        "legacy_train_rows_json_deserialized",
        "legacy_val_rows_byte_skipped",
        "overlapping_strict_full22_train_rows_preserved",
    }
    authority_core = {
        key: copy.deepcopy(value)
        for key, value in bindings.items()
        if key != "combined_authority_sha256"
    }
    expected_authority_sha = trainer.sha256_bytes(
        trainer.canonical_json(authority_core).encode("utf-8")
    )
    if (
        set(bindings) != expected_binding_keys
        or dict(report_bindings) != dict(bindings)
        or bindings.get("catalog_registry_sha256") != catalog_registry_sha256
        or bindings.get("combined_authority_sha256") != expected_authority_sha
        or bindings.get("legacy_manifest_candidate_count")
        != len(LEGACY15_CANDIDATE_IDS)
    ):
        raise Legacy15TrainOverlayError("overlay authority binding drifted")
    base_binding = _mapping(
        bindings.get("base_full22_export"), "legacy overlay base binding"
    )
    legacy_binding = _mapping(bindings.get("legacy_export"), "legacy source binding")
    try:
        for field in (
            "manifest_sha256",
            "marker_sha256",
            "report_sha256",
            "samples_sha256",
            "train_sample_ids_sha256",
            "train_work_ids_sha256",
        ):
            trainer.require_sha(base_binding.get(field), f"base binding.{field}")
        for field in (
            "manifest_sha256",
            "marker_sha256",
            "report_sha256",
            "samples_sha256",
        ):
            trainer.require_sha(legacy_binding.get(field), f"legacy binding.{field}")
        base_train_count = trainer.require_nonnegative_int(
            base_binding.get("train_record_count"), "base binding.train_record_count"
        )
        trainer.require_nonnegative_int(
            base_binding.get("val_record_count"), "base binding.val_record_count"
        )
        trainer.require_nonnegative_int(
            base_binding.get("skipped_test_row_count"),
            "base binding.skipped_test_row_count",
        )
        legacy_total = trainer.require_nonnegative_int(
            legacy_binding.get("samples_record_count"),
            "legacy binding.samples_record_count",
        )
        trainer.require_nonnegative_int(
            legacy_binding.get("samples_byte_size"),
            "legacy binding.samples_byte_size",
        )
    except trainer.MangaFontStudentError as error:
        raise Legacy15TrainOverlayError(str(error)) from error
    descriptor = _mapping(
        _mapping(manifest.get("artifacts"), "legacy overlay manifest.artifacts").get(
            OVERLAY_FILE
        ),
        "legacy overlay descriptor",
    )
    overlay_path = root / OVERLAY_FILE
    if set(descriptor) != {"byte_size", "file", "record_count", "sha256"}:
        raise Legacy15TrainOverlayError("overlay descriptor schema drifted")
    try:
        addition_count = trainer.require_nonnegative_int(
            descriptor.get("record_count"), "legacy overlay descriptor.record_count"
        )
    except trainer.MangaFontStudentError as error:
        raise Legacy15TrainOverlayError(str(error)) from error
    val_skipped = bindings.get("legacy_val_rows_byte_skipped")
    test_skipped = bindings.get("legacy_test_rows_byte_skipped")
    non_train_skipped = bindings.get("legacy_non_train_rows_byte_skipped")
    legacy_train_count = bindings.get("legacy_train_rows_json_deserialized")
    overlap_count = bindings.get("overlapping_strict_full22_train_rows_preserved")
    if not all(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
        for value in (
            val_skipped,
            test_skipped,
            non_train_skipped,
            legacy_train_count,
            overlap_count,
        )
    ) or (
        non_train_skipped != val_skipped + test_skipped
        or legacy_train_count != addition_count + overlap_count
        or legacy_total != legacy_train_count + non_train_skipped
        or overlap_count != base_train_count
    ):
        raise Legacy15TrainOverlayError("legacy split/count bindings drifted")
    expected_invariants = {
        "base_full22_train_rows_replaced": 0,
        "legacy_non_train_labels_deserialized": 0,
        "legacy_train_addition_count": addition_count,
        "label_scope": "legacy15_only",
        "successor_candidate_ids": list(SUCCESSOR_ONLY_CANDIDATE_IDS),
        "successor_candidates_used_as_negatives": False,
    }
    expected_checks = {
        "base_hidden_test_labels_deserialized": 0,
        "base_hidden_test_pixels_opened": 0,
        "legacy_non_train_labels_deserialized": 0,
        "legacy_non_train_pixels_opened": 0,
        "new7_negative_supervision_count": 0,
        "strict_train_overlap_preserved": base_train_count,
        "val_rows_modified": 0,
    }
    if (
        dict(_mapping(manifest.get("invariants"), "legacy overlay invariants"))
        != expected_invariants
        or dict(_mapping(report.get("checks"), "legacy overlay checks"))
        != expected_checks
        or report.get("train_addition_count") != addition_count
        or report.get("combined_train_record_count")
        != base_train_count + addition_count
    ):
        raise Legacy15TrainOverlayError("overlay invariants/checks drifted")
    if (
        descriptor.get("file") != OVERLAY_FILE
        or descriptor.get("sha256") != trainer.sha256_file(overlay_path)
        or descriptor.get("byte_size") != overlay_path.stat().st_size
        or _mapping(report.get("artifacts"), "legacy overlay report.artifacts").get(
            OVERLAY_FILE
        )
        != descriptor
        or report.get("manifest_sha256") != trainer.sha256_file(root / MANIFEST_FILE)
    ):
        raise Legacy15TrainOverlayError("overlay descriptor binding drifted")
    examples: list[trainer.HumanExample] = []
    seen: set[str] = set()
    with overlay_path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"legacy overlay row {line_number}"))
            except json.JSONDecodeError as error:
                raise Legacy15TrainOverlayError(
                    f"legacy overlay row {line_number}: invalid JSON"
                ) from error
            example = validate_partial_human_row(
                row,
                candidate_ids=candidate_ids,
                catalog_registry_sha256=catalog_registry_sha256,
                location=f"legacy overlay row {line_number}",
                legacy_samples_sha256=str(legacy_binding["samples_sha256"]),
            )
            if example.sample_id in seen:
                raise Legacy15TrainOverlayError("duplicate legacy overlay sample")
            seen.add(example.sample_id)
            examples.append(example)
    if (
        len(examples) != addition_count
        or len(examples) != report.get("train_addition_count")
    ):
        raise Legacy15TrainOverlayError("overlay record count drifted")
    return {
        "combined_authority_sha256": bindings.get("combined_authority_sha256"),
        "combined_train_record_count": report.get("combined_train_record_count"),
        "legacy_non_train_labels_deserialized": 0,
        "new7_negative_supervision_count": 0,
        "output_dir": str(root),
        "partial_candidate_row_count": len(examples),
        "record_count": len(examples),
        "status": "ready_for_partial22_train_append",
    }


def apply_legacy15_train_overlay(
    snapshot: trainer.HumanSnapshot,
    *,
    overlay_dir: Path,
    candidate_ids: tuple[str, ...],
    catalog_registry_sha256: str,
) -> tuple[trainer.HumanSnapshot, dict[str, Any]]:
    validation = validate_overlay(
        overlay_dir,
        candidate_ids=candidate_ids,
        catalog_registry_sha256=catalog_registry_sha256,
    )
    root = overlay_dir.expanduser().resolve()
    manifest = trainer.read_json(root / MANIFEST_FILE, location="legacy overlay manifest")
    bindings = _mapping(manifest.get("bindings"), "legacy overlay bindings")
    base_binding = _mapping(bindings.get("base_full22_export"), "legacy overlay base binding")
    legacy_binding = _mapping(bindings.get("legacy_export"), "legacy source binding")
    snapshot_train_ids = [example.sample_id for example in snapshot.train_examples]
    snapshot_train_works = sorted({example.work_id for example in snapshot.train_examples})
    if (
        base_binding.get("manifest_sha256") != snapshot.manifest_sha256
        or base_binding.get("marker_sha256") != snapshot.marker_sha256
        or base_binding.get("report_sha256") != snapshot.report_sha256
        or snapshot.root.name != base_binding.get("root_name")
        or base_binding.get("train_record_count") != len(snapshot.train_examples)
        or base_binding.get("val_record_count") != len(snapshot.val_examples)
        or base_binding.get("skipped_test_row_count") != snapshot.skipped_test_rows
        or base_binding.get("train_sample_ids_sha256")
        != _ordered_digest(snapshot_train_ids)
        or base_binding.get("train_work_ids_sha256")
        != _ordered_digest(snapshot_train_works)
    ):
        raise Legacy15TrainOverlayError("overlay/base full22 authority binding drifted")
    existing_ids = {example.sample_id for example in snapshot.train_examples}
    strict_work_ids = {example.work_id for example in snapshot.train_examples}
    additions: list[trainer.HumanExample] = []
    with (root / OVERLAY_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"legacy append row {line_number}"))
            example = validate_partial_human_row(
                row,
                candidate_ids=candidate_ids,
                catalog_registry_sha256=catalog_registry_sha256,
                location=f"legacy append row {line_number}",
                legacy_samples_sha256=str(legacy_binding["samples_sha256"]),
            )
            if example.sample_id in existing_ids or example.work_id not in strict_work_ids:
                raise Legacy15TrainOverlayError("legacy append identity escaped train boundary")
            existing_ids.add(example.sample_id)
            additions.append(example)
    descriptor = _mapping(
        _mapping(manifest.get("artifacts"), "legacy overlay artifacts").get(
            OVERLAY_FILE
        ),
        "legacy overlay descriptor",
    )
    if trainer.sha256_file(root / OVERLAY_FILE) != descriptor.get("sha256"):
        raise Legacy15TrainOverlayError("overlay changed between validation and apply")
    combined = (*snapshot.train_examples, *additions)
    if (
        len(additions) != validation["record_count"]
        or len(combined) != validation["combined_train_record_count"]
        or len({example.sample_id for example in combined}) != len(combined)
    ):
        raise Legacy15TrainOverlayError("legacy append count or identity drifted")
    merged = trainer.HumanSnapshot(
        root=snapshot.root,
        train_examples=tuple(combined),
        val_examples=snapshot.val_examples,
        skipped_test_rows=snapshot.skipped_test_rows,
        marker_sha256=snapshot.marker_sha256,
        manifest_sha256=snapshot.manifest_sha256,
        report_sha256=snapshot.report_sha256,
        samples_sha256=snapshot.samples_sha256,
    )
    return merged, {
        **validation,
        "base_train_record_count": len(snapshot.train_examples),
        "legacy_partial_train_record_count": len(additions),
        "merged_train_record_count": len(combined),
        "test_labels_deserialized": 0,
        "test_pixels_opened": 0,
        "val_record_count_unchanged": len(snapshot.val_examples),
        "val_rows_modified": 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--base-full22-export-dir", type=Path, required=True)
    build.add_argument("--legacy15-export-dir", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--overlay-dir", type=Path, required=True)
    validate.add_argument("--catalog-registry", type=Path, required=True)
    preflight = commands.add_parser("preflight-apply")
    preflight.add_argument("--base-full22-export-dir", type=Path, required=True)
    preflight.add_argument("--overlay-dir", type=Path, required=True)
    preflight.add_argument("--catalog-registry", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    registry_sha = trainer.sha256_file(args.catalog_registry.expanduser().resolve())
    try:
        if args.command == "build":
            result = build_overlay(
                base_full22_export_dir=args.base_full22_export_dir,
                legacy15_export_dir=args.legacy15_export_dir,
                catalog_registry=args.catalog_registry,
                output_dir=args.output_dir,
            )
        elif args.command == "validate":
            result = validate_overlay(
                args.overlay_dir,
                candidate_ids=FULL22_CANDIDATE_IDS,
                catalog_registry_sha256=registry_sha,
            )
        else:
            snapshot = trainer.validate_human_input(
                args.base_full22_export_dir,
                candidate_ids=FULL22_CANDIDATE_IDS,
                catalog_registry_sha256=registry_sha,
            )
            _merged, result = apply_legacy15_train_overlay(
                snapshot,
                overlay_dir=args.overlay_dir,
                candidate_ids=FULL22_CANDIDATE_IDS,
                catalog_registry_sha256=registry_sha,
            )
    except (Legacy15TrainOverlayError, trainer.MangaFontStudentError, OSError) as error:
        raise SystemExit(f"legacy15 train overlay error: {error}") from error
    print(trainer.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
