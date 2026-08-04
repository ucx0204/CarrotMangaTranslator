#!/usr/bin/env python3
"""Seal the complete 160-row new7 visual draft and full22 train authority.

The first 40 rows and the remaining 120 rows keep their independently sealed
visual provenance.  This successor only combines those decisions, proves that
the legacy 15-font tier membership is byte-for-byte equivalent, and promotes
exactly the selected train identities to complete 22-font supervision.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import build_manga_font_legacy_new7_expansion_review_v1 as legacy
    from scripts import build_manga_font_legacy_new7_remaining120_draft_v1 as remaining
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_legacy_new7_expansion_review_v1 as legacy
    import build_manga_font_legacy_new7_remaining120_draft_v1 as remaining
    import train_manga_font_student_v1 as trainer


DRAFT_SCHEMA = "manga-font-legacy-new7-expansion-visual-draft-all160-v1"
AUTHORITY_SCHEMA = "manga-font-legacy-new7-full22-authority-all160-v1"
DRAFT_OWNER = "carrot-manga-translator/manga-font-legacy-new7-expansion-visual-draft-all160-v1"
AUTHORITY_OWNER = "carrot-manga-translator/manga-font-legacy-new7-full22-authority-all160-v1"
DRAFT_MARKER = ".manga-font-legacy-new7-expansion-visual-draft-all160-v1-owned.json"
AUTHORITY_MARKER = ".manga-font-legacy-new7-full22-authority-all160-v1-owned.json"
DRAFT_FILE = "judgments-all160-draft.json"
AUDIT_FILE = "secondary-visual-audit-all160.json"
AUTHORITY_FILE = legacy.AUTHORITY_FILE
REPORT_FILE = legacy.REPORT_FILE
RECORD_COUNT = 160
STRICT_FULL22_TRAIN_COUNT = 109
FULL22_TRAIN_AFTER_APPLY = 269
PARTIAL15_TRAIN_AFTER_APPLY = 458
TOTAL_REAL_TRAIN_COUNT = 727
FIRST40_DRAFT_DIRNAME = "manga-font-legacy-new7-expansion-visual-draft-first40-v1"
FIRST40_AUTHORITY_DIRNAME = "manga-font-legacy-new7-expansion-full22-authority-first40-v1"
REMAINING120_DIRNAME = "manga-font-legacy-new7-expansion-visual-draft-remaining120-v1"
DRAFT_FILES = frozenset({DRAFT_MARKER, DRAFT_FILE, AUDIT_FILE})
AUTHORITY_FILES = frozenset({AUTHORITY_MARKER, REPORT_FILE, AUTHORITY_FILE, AUDIT_FILE})


class All160AuthorityError(legacy.LegacyNew7ReviewError):
    """Raised when the all160 visual or promotion boundary drifts."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise All160AuthorityError(f"{location}: expected object")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise All160AuthorityError(f"{location}: expected text")
    return result


def _safe_output(path: Path) -> Path:
    output = path.expanduser().resolve()
    if output in {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}:
        raise All160AuthorityError(f"unsafe output: {output}")
    if len(output.parts) < 3 or len(output.name) < 3:
        raise All160AuthorityError(f"unsafe output: {output}")
    return output


def _descriptor(path: Path, *, count: int | None = None) -> dict[str, Any]:
    target = path.expanduser().resolve()
    if target.is_symlink() or not target.is_file() or target.stat().st_size < 1:
        raise All160AuthorityError(f"missing or linked source: {target}")
    result: dict[str, Any] = {
        "byte_size": target.stat().st_size,
        "file": target.name,
        "sha256": trainer.sha256_file(target),
    }
    if count is not None:
        result["record_count"] = count
    return result


def _assert_inventory(root: Path, expected: frozenset[str], location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise All160AuthorityError(f"{location}: missing or linked directory")
    actual = {entry.name for entry in root.iterdir()}
    if actual != set(expected) or any(entry.is_symlink() for entry in root.iterdir()):
        raise All160AuthorityError(f"{location}: inventory drifted")


def _read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"{location}:{line_number}"))
            except json.JSONDecodeError as error:
                raise All160AuthorityError(f"{location}: invalid JSON") from error
            trainer.validate_record_seal(row, location=f"{location}:{line_number}")
            rows.append(row)
    return rows


def _review_rows(review_root: Path) -> list[dict[str, Any]]:
    legacy.validate_review(review_root)
    rows = legacy._read_review_rows(review_root)  # noqa: SLF001
    if (
        len(rows) != RECORD_COUNT
        or [row.get("selection_rank") for row in rows] != list(range(1, 161))
        or len({str(row.get("sample_id")) for row in rows}) != RECORD_COUNT
    ):
        raise All160AuthorityError("review queue is not exact rank1-160")
    return rows


def _validate_review_boundary(review_root: Path) -> Mapping[str, Any]:
    report = trainer.read_json(review_root / legacy.REPORT_FILE, location="review report")
    trainer.validate_record_seal(report, location="review report")
    boundary = _mapping(report.get("boundary"), "review boundary")
    required_zero = (
        "selected_authority_overlap_count",
        "fresh64_labels_deserialized",
        "fresh64_pixels_opened",
        "qa_v7_pixels_opened",
        "qa_v8_pixels_opened",
        "qa_v9_pixels_opened",
        "strict_test_labels_json_deserialized",
        "strict_test_pixels_opened",
        "model_reference_gold_promotions",
    )
    inputs = _mapping(report.get("inputs"), "review inputs")
    strict = _mapping(inputs.get("strict_full22"), "strict full22")
    if (
        boundary.get("selected_split") != "train"
        or any(int(boundary.get(name, -1)) != 0 for name in required_zero)
        or strict.get("split_counts") != {"train": 109, "val": 33, "test": 30}
        or int(strict.get("label_rows_json_deserialized", -1)) != 0
        or int(strict.get("test_labels_json_deserialized", -1)) != 0
        or int(strict.get("test_pixels_opened", -1)) != 0
    ):
        raise All160AuthorityError("review leakage/exclusion boundary drifted")
    selection = _mapping(report.get("selection"), "review selection")
    if int(selection.get("selected_count", 0)) != RECORD_COUNT:
        raise All160AuthorityError("review selection count drifted")
    return report


def _new7_tiers_from_row(row: Mapping[str, Any]) -> dict[str, str]:
    judgment = _mapping(row.get("font_judgment"), "font judgment")
    result: dict[str, str] = {}
    for tier in trainer.HUMAN_TIERS:
        values = judgment.get(tier)
        if not isinstance(values, list):
            raise All160AuthorityError(f"font judgment.{tier}: expected list")
        for candidate_id in values:
            if candidate_id in legacy.NEW7_IDS:
                if candidate_id in result:
                    raise All160AuthorityError("duplicate new7 tier membership")
                result[candidate_id] = tier
    if set(result) != set(legacy.NEW7_IDS):
        raise All160AuthorityError("full22 row does not partition exact new7")
    return {candidate_id: result[candidate_id] for candidate_id in legacy.NEW7_IDS}


def _validate_decisions(
    decisions: Sequence[Mapping[str, Any]], review_rows: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    if len(decisions) != RECORD_COUNT or len(review_rows) != RECORD_COUNT:
        raise All160AuthorityError("all160 decision count drifted")
    normalized: list[dict[str, Any]] = []
    for rank, (raw, review_row) in enumerate(zip(decisions, review_rows, strict=True), 1):
        decision = copy.deepcopy(dict(raw))
        tiers = _mapping(decision.get("new7_tiers"), f"decision {rank}.new7_tiers")
        if (
            decision.get("sample_id") != review_row.get("sample_id")
            or decision.get("selection_rank") != rank
            or decision.get("visually_reviewed") is not True
            or decision.get("model_reference_visible") is not True
            or decision.get("legacy15_membership_sha256")
            != _mapping(review_row.get("legacy15_lock"), "legacy15 lock").get("membership_sha256")
            or list(tiers) != list(legacy.NEW7_IDS)
            or set(tiers.values()) - set(legacy.FINAL_NEW7_TIERS)
        ):
            raise All160AuthorityError(f"decision rank {rank} boundary drifted")
        confidence = _text(decision.get("confidence"), f"decision {rank}.confidence")
        if confidence not in {"high", "medium", "low"}:
            raise All160AuthorityError("invalid visual confidence")
        normalized.append(decision)
    if len({row["sample_id"] for row in normalized}) != RECORD_COUNT:
        raise All160AuthorityError("all160 decision identities are not unique")
    return normalized


def _resolve_sources(
    *,
    draft_dir: Path,
    authority_dir: Path | None = None,
    first40_draft_dir: Path | None = None,
    first40_authority_dir: Path | None = None,
    remaining120_dir: Path | None = None,
) -> tuple[Path, Path, Path]:
    parent = draft_dir.expanduser().resolve().parent
    authority_parent = authority_dir.expanduser().resolve().parent if authority_dir else parent
    return (
        (first40_draft_dir or parent / FIRST40_DRAFT_DIRNAME).expanduser().resolve(),
        (first40_authority_dir or authority_parent / FIRST40_AUTHORITY_DIRNAME).expanduser().resolve(),
        (remaining120_dir or parent / REMAINING120_DIRNAME).expanduser().resolve(),
    )


def _load_source_decisions(
    *,
    review_root: Path,
    first40_draft_root: Path,
    first40_authority_root: Path,
    remaining120_root: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    legacy.validate_draft(first40_draft_root, review_root)
    first_validation = legacy.validate_authority(
        first40_authority_root,
        review_dir=review_root,
        draft_dir=first40_draft_root,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
    )
    remaining_validation = remaining.validate_draft(remaining120_root, review_root)
    first_draft = trainer.read_json(first40_draft_root / legacy.DRAFT_FILE, location="first40 draft")
    remaining_draft = trainer.read_json(remaining120_root / remaining.DRAFT_FILE, location="remaining120 draft")
    first_rows = _read_jsonl(first40_authority_root / legacy.AUTHORITY_FILE, "first40 authority")
    first_decisions = [copy.deepcopy(dict(row)) for row in first_draft["judgments"]]
    later_decisions = [copy.deepcopy(dict(row)) for row in remaining_draft["judgments"]]
    review_rows = _review_rows(review_root)
    decisions = _validate_decisions(first_decisions + later_decisions, review_rows)
    first_by_id = {str(row["sample_id"]): row for row in first_rows}
    for decision in decisions[:40]:
        prior = first_by_id.get(str(decision["sample_id"]))
        if prior is None or _new7_tiers_from_row(prior) != dict(decision["new7_tiers"]):
            raise All160AuthorityError("first40 decision differs from sealed authority")
    if (
        int(first_validation.get("upgraded_record_count", 0)) != 40
        or int(remaining_validation.get("draft_count", 0)) != 120
    ):
        raise All160AuthorityError("source tranche count drifted")
    first_audit = trainer.read_json(
        first40_authority_root / legacy.SECONDARY_AUDIT_FILE,
        location="first40 secondary audit",
    )
    remaining_audit = trainer.read_json(
        remaining120_root / remaining.AUDIT_FILE,
        location="remaining120 secondary audit",
    )
    trainer.validate_record_seal(first_audit, location="first40 secondary audit")
    trainer.validate_record_seal(remaining_audit, location="remaining120 secondary audit")
    if (
        first_audit.get("visual_rows_opened") != 40
        or remaining_audit.get("visual_rows_opened") != 120
        or first_audit.get("blocking_outliers") != 0
        or remaining_audit.get("blocking_outliers") != 0
    ):
        raise All160AuthorityError("secondary audit tranche drifted")
    return decisions, {
        "first40_authority": first_validation,
        "remaining120_draft": remaining_validation,
        "first40_audit": first_audit,
        "remaining120_audit": remaining_audit,
    }


def build_draft(
    *,
    review_dir: Path,
    first40_draft_dir: Path,
    first40_authority_dir: Path,
    remaining120_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
    output_dir: Path,
) -> dict[str, Any]:
    review_root = review_dir.expanduser().resolve()
    review_report = _validate_review_boundary(review_root)
    decisions, sources = _load_source_decisions(
        review_root=review_root,
        first40_draft_root=first40_draft_dir.expanduser().resolve(),
        first40_authority_root=first40_authority_dir.expanduser().resolve(),
        remaining120_root=remaining120_dir.expanduser().resolve(),
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
    )
    confidence_counts = dict(sorted(Counter(row["confidence"] for row in decisions).items()))
    low_ids = [row["sample_id"] for row in decisions if row["confidence"] == "low"]
    no_preferred = [
        row["sample_id"]
        for row in decisions
        if "preferred" not in set(row["new7_tiers"].values())
    ]
    output = _safe_output(output_dir)
    if output.exists():
        raise All160AuthorityError("all160 draft output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        draft = trainer.seal_record(
            {
                "checks": {
                    "all160_exact": True,
                    "completed_human_visual_provenance": True,
                    "fabricated_new7_negative_count": 0,
                    "first40_authority_equivalent": True,
                    "fresh64_overlap_count": 0,
                    "legacy15_membership_mutation_count": 0,
                    "model_reference_auto_promotions": 0,
                    "new7_all_reviewed": True,
                    "qa40_overlap_count": 0,
                    "test_overlap_count": 0,
                    "val_overlap_count": 0,
                },
                "confidence_counts": confidence_counts,
                "judgments": decisions,
                "label_authority": "human_visual_draft_not_gold",
                "low_confidence_sample_ids": low_ids,
                "no_forced_preferred_sample_ids": no_preferred,
                "promotion_allowed": False,
                "record_type": "manga_font_legacy_new7_expansion_visual_draft_all160",
                "review_input_sha256": trainer.sha256_file(review_root / legacy.REVIEW_FILE),
                "review_report_sha256": trainer.sha256_file(review_root / legacy.REPORT_FILE),
                "schema_version": DRAFT_SCHEMA,
                "selection_rank_range": [1, 160],
                "source_tranches": {
                    "first40_authority_file": _descriptor(first40_authority_dir / legacy.AUTHORITY_FILE, count=40),
                    "first40_authority_report": _descriptor(first40_authority_dir / legacy.REPORT_FILE),
                    "first40_draft": _descriptor(first40_draft_dir / legacy.DRAFT_FILE),
                    "remaining120_audit": _descriptor(remaining120_dir / remaining.AUDIT_FILE),
                    "remaining120_draft": _descriptor(remaining120_dir / remaining.DRAFT_FILE),
                },
                "training_eligible": False,
            }
        )
        (staging / DRAFT_FILE).write_bytes(trainer.json_bytes(draft, pretty=True))
        first_audit = _mapping(sources["first40_audit"], "first40 audit")
        later_audit = _mapping(sources["remaining120_audit"], "remaining120 audit")
        sheets = copy.deepcopy(list(first_audit["contact_sheets"])) + copy.deepcopy(
            list(later_audit["contact_sheets"])
        )
        if (
            len(sheets) != 40
            or sheets[0].get("first_selection_rank") != 1
            or sheets[-1].get("last_selection_rank") != 160
        ):
            raise All160AuthorityError("combined contact sheet boundary drifted")
        for descriptor in sheets:
            sheet_path = review_root / str(descriptor["file"])
            if trainer.sha256_file(sheet_path) != descriptor.get("sha256"):
                raise All160AuthorityError("combined contact sheet hash drifted")
        audit = trainer.seal_record(
            {
                "blocking_outliers": 0,
                "contact_sheets": sheets,
                "detail": "original",
                "draft_record_sha256": draft["record_sha256"],
                "opened_row_range": [1, 160],
                "opened_sheet_range": [1, 40],
                "record_type": "manga_font_legacy_new7_secondary_visual_audit_all160",
                "review_report_sha256": trainer.sha256_file(review_root / legacy.REPORT_FILE),
                "reviewers": [first_audit["reviewer"], later_audit["reviewer"]],
                "schema_version": DRAFT_SCHEMA,
                "source_audit_record_sha256": [
                    first_audit["record_sha256"],
                    later_audit["record_sha256"],
                ],
                "status": "pass_no_blocking_visual_tier_outlier",
                "visual_rows_opened": RECORD_COUNT,
            }
        )
        (staging / AUDIT_FILE).write_bytes(trainer.json_bytes(audit, pretty=True))
        marker = {
            "artifacts": {
                DRAFT_FILE: trainer.sha256_file(staging / DRAFT_FILE),
                AUDIT_FILE: trainer.sha256_file(staging / AUDIT_FILE),
            },
            "owner": DRAFT_OWNER,
            "safe_replace": True,
            "schema_version": DRAFT_SCHEMA,
        }
        (staging / DRAFT_MARKER).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.rename(staging, output)
        published = True
        return validate_draft(
            output,
            review_dir=review_root,
            legacy_overlay_dir=legacy_overlay_dir,
            catalog_registry=catalog_registry,
            first40_draft_dir=first40_draft_dir,
            first40_authority_dir=first40_authority_dir,
            remaining120_dir=remaining120_dir,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_draft(
    output_dir: Path,
    *,
    review_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
    first40_draft_dir: Path | None = None,
    first40_authority_dir: Path | None = None,
    remaining120_dir: Path | None = None,
) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    review_root = review_dir.expanduser().resolve()
    first_draft, first_authority, later = _resolve_sources(
        draft_dir=root,
        first40_draft_dir=first40_draft_dir,
        first40_authority_dir=first40_authority_dir,
        remaining120_dir=remaining120_dir,
    )
    _assert_inventory(root, DRAFT_FILES, "all160 draft")
    _validate_review_boundary(review_root)
    decisions, sources = _load_source_decisions(
        review_root=review_root,
        first40_draft_root=first_draft,
        first40_authority_root=first_authority,
        remaining120_root=later,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
    )
    marker = trainer.read_json(root / DRAFT_MARKER, location="all160 draft marker")
    draft = trainer.read_json(root / DRAFT_FILE, location="all160 draft")
    draft_sha = trainer.validate_record_seal(draft, location="all160 draft")
    audit = trainer.read_json(root / AUDIT_FILE, location="all160 audit")
    audit_sha = trainer.validate_record_seal(audit, location="all160 audit")
    expected_artifacts = {
        DRAFT_FILE: trainer.sha256_file(root / DRAFT_FILE),
        AUDIT_FILE: trainer.sha256_file(root / AUDIT_FILE),
    }
    checks = _mapping(draft.get("checks"), "all160 draft checks")
    required_zero = (
        "fabricated_new7_negative_count",
        "fresh64_overlap_count",
        "legacy15_membership_mutation_count",
        "model_reference_auto_promotions",
        "qa40_overlap_count",
        "test_overlap_count",
        "val_overlap_count",
    )
    if (
        marker.get("owner") != DRAFT_OWNER
        or marker.get("schema_version") != DRAFT_SCHEMA
        or marker.get("safe_replace") is not True
        or marker.get("artifacts") != expected_artifacts
        or draft.get("schema_version") != DRAFT_SCHEMA
        or draft.get("label_authority") != "human_visual_draft_not_gold"
        or draft.get("training_eligible") is not False
        or draft.get("promotion_allowed") is not False
        or draft.get("judgments") != decisions
        or draft.get("selection_rank_range") != [1, 160]
        or checks.get("all160_exact") is not True
        or checks.get("completed_human_visual_provenance") is not True
        or checks.get("first40_authority_equivalent") is not True
        or checks.get("new7_all_reviewed") is not True
        or any(int(checks.get(name, -1)) != 0 for name in required_zero)
    ):
        raise All160AuthorityError("all160 draft boundary drifted")
    first_audit = _mapping(sources["first40_audit"], "first audit")
    later_audit = _mapping(sources["remaining120_audit"], "remaining audit")
    expected_sheets = copy.deepcopy(list(first_audit["contact_sheets"])) + copy.deepcopy(
        list(later_audit["contact_sheets"])
    )
    if (
        audit.get("schema_version") != DRAFT_SCHEMA
        or audit.get("draft_record_sha256") != draft_sha
        or audit.get("visual_rows_opened") != RECORD_COUNT
        or audit.get("blocking_outliers") != 0
        or audit.get("opened_row_range") != [1, 160]
        or audit.get("opened_sheet_range") != [1, 40]
        or audit.get("contact_sheets") != expected_sheets
        or audit.get("source_audit_record_sha256")
        != [first_audit["record_sha256"], later_audit["record_sha256"]]
    ):
        raise All160AuthorityError("all160 audit boundary drifted")
    return {
        "audit_record_sha256": audit_sha,
        "completed_human_visual_provenance": True,
        "draft_count": RECORD_COUNT,
        "draft_record_sha256": draft_sha,
        "fabricated_new7_negative_count": 0,
        "fresh64_overlap_count": 0,
        "legacy15_membership_mutation_count": 0,
        "output_dir": str(root),
        "qa40_overlap_count": 0,
        "status": "sealed_human_visual_draft_not_gold",
        "test_overlap_count": 0,
        "val_overlap_count": 0,
    }


def build_authority(
    *,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
    output_dir: Path,
    confirm_human_finalization: bool,
    reviewer: str,
) -> dict[str, Any]:
    if not confirm_human_finalization:
        raise All160AuthorityError("--confirm-human-finalization is required")
    draft_root = draft_dir.expanduser().resolve()
    review_root = review_dir.expanduser().resolve()
    validate_draft(
        draft_root,
        review_dir=review_root,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
    )
    review_report = _validate_review_boundary(review_root)
    review_rows = _review_rows(review_root)
    draft = trainer.read_json(draft_root / DRAFT_FILE, location="all160 draft")
    draft_record_sha = trainer.validate_record_seal(draft, location="all160 draft")
    audit = trainer.read_json(draft_root / AUDIT_FILE, location="all160 audit")
    audit_record_sha = trainer.validate_record_seal(audit, location="all160 audit")
    decisions = {str(row["sample_id"]): _mapping(row, "all160 decision") for row in draft["judgments"]}
    examples, partial_binding = legacy.load_partial_examples(legacy_overlay_dir, catalog_registry)
    examples_by_id = {example.sample_id: example for example in examples}
    if set(decisions) != {str(row["sample_id"]) for row in review_rows}:
        raise All160AuthorityError("all160 authority identity set drifted")
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    reviewer_text = _text(reviewer, "reviewer")
    promoted_rows = [
        legacy._promote_full22_row(  # noqa: SLF001
            examples_by_id[str(review_row["sample_id"])],
            review_row=review_row,
            decision=decisions[str(review_row["sample_id"])],
            draft_record_sha256=draft_record_sha,
            review_report_sha256=trainer.sha256_file(review_root / legacy.REPORT_FILE),
            reviewer=reviewer_text,
            secondary_visual_audit_record_sha256=audit_record_sha,
            catalog_registry_sha256=registry_sha,
        )
        for review_row in review_rows
    ]
    if len(promoted_rows) != RECORD_COUNT:
        raise All160AuthorityError("promotion count drifted")
    output = _safe_output(output_dir)
    if output.exists():
        raise All160AuthorityError("all160 authority output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        (staging / AUDIT_FILE).write_bytes(trainer.json_bytes(audit, pretty=True))
        legacy._write_jsonl(staging / AUTHORITY_FILE, promoted_rows)  # noqa: SLF001
        low_ids = [row["sample_id"] for row in promoted_rows if row["visual_judgment_confidence"] == "low"]
        aggregate_base = legacy._aggregate_row_binding(  # noqa: SLF001
            promoted_rows, "base_partial_record_sha256"
        )
        aggregate_legacy = legacy._aggregate_row_binding(  # noqa: SLF001
            promoted_rows, "legacy15_membership_sha256"
        )
        report = trainer.seal_record(
            {
                "artifacts": {AUTHORITY_FILE: _descriptor(staging / AUTHORITY_FILE, count=RECORD_COUNT)},
                "base_partial_record_sha256": aggregate_base,
                "completed_human_visual_provenance": True,
                "fabricated_new7_negative_count": 0,
                "fresh64_overlap_count": 0,
                "legacy15_membership_sha256": aggregate_legacy,
                "low_confidence_record_count": len(low_ids),
                "low_confidence_sample_ids": low_ids,
                "new7_candidate_ids": list(legacy.NEW7_IDS),
                "new7_visual_judgment_record_count": RECORD_COUNT,
                "old15_membership_mutation_count": 0,
                "qa40_overlap_count": 0,
                "record_type": "manga_font_legacy_new7_full22_train_upgrade_report_all160",
                "schema_version": AUTHORITY_SCHEMA,
                "source": {
                    "catalog_registry_sha256": registry_sha,
                    "legacy_partial618": partial_binding,
                    "review_input_sha256": trainer.sha256_file(review_root / legacy.REVIEW_FILE),
                    "review_report_sha256": trainer.sha256_file(review_root / legacy.REPORT_FILE),
                    "strict_full22_identity_scan": copy.deepcopy(review_report["inputs"]["strict_full22"]),
                    "visual_draft": _descriptor(draft_root / DRAFT_FILE, count=RECORD_COUNT),
                    "visual_draft_record_sha256": draft_record_sha,
                    "secondary_visual_audit": {
                        **_descriptor(staging / AUDIT_FILE),
                        "record_sha256": audit_record_sha,
                    },
                },
                "split": "train",
                "status": "ready_for_legacy_new7_full22_train_upgrade",
                "test_overlap_count": 0,
                "training_effect": {
                    "full22_train_rows_after_apply": FULL22_TRAIN_AFTER_APPLY,
                    "original_strict_full22_train_rows": STRICT_FULL22_TRAIN_COUNT,
                    "partial15_train_rows_after_apply": PARTIAL15_TRAIN_AFTER_APPLY,
                    "total_train_rows_after_apply": TOTAL_REAL_TRAIN_COUNT,
                },
                "upgraded_record_count": RECORD_COUNT,
                "val_overlap_count": 0,
            }
        )
        (staging / REPORT_FILE).write_bytes(trainer.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                AUTHORITY_FILE: trainer.sha256_file(staging / AUTHORITY_FILE),
                REPORT_FILE: trainer.sha256_file(staging / REPORT_FILE),
                AUDIT_FILE: trainer.sha256_file(staging / AUDIT_FILE),
            },
            "owner": AUTHORITY_OWNER,
            "safe_replace": True,
            "schema_version": AUTHORITY_SCHEMA,
        }
        (staging / AUTHORITY_MARKER).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.rename(staging, output)
        published = True
        return validate_authority(
            output,
            review_dir=review_root,
            draft_dir=draft_root,
            legacy_overlay_dir=legacy_overlay_dir,
            catalog_registry=catalog_registry,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_authority(
    output_dir: Path,
    *,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    draft_root = draft_dir.expanduser().resolve()
    review_root = review_dir.expanduser().resolve()
    _assert_inventory(root, AUTHORITY_FILES, "all160 authority")
    draft_validation = validate_draft(
        draft_root,
        review_dir=review_root,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
        first40_authority_dir=root.parent / FIRST40_AUTHORITY_DIRNAME,
    )
    _validate_review_boundary(review_root)
    report = trainer.read_json(root / REPORT_FILE, location="all160 authority report")
    trainer.validate_record_seal(report, location="all160 authority report")
    marker = trainer.read_json(root / AUTHORITY_MARKER, location="all160 authority marker")
    expected_artifacts = {
        AUTHORITY_FILE: trainer.sha256_file(root / AUTHORITY_FILE),
        REPORT_FILE: trainer.sha256_file(root / REPORT_FILE),
        AUDIT_FILE: trainer.sha256_file(root / AUDIT_FILE),
    }
    effect = _mapping(report.get("training_effect"), "training effect")
    required_zero = (
        "fabricated_new7_negative_count",
        "fresh64_overlap_count",
        "old15_membership_mutation_count",
        "qa40_overlap_count",
        "test_overlap_count",
        "val_overlap_count",
    )
    if (
        marker.get("owner") != AUTHORITY_OWNER
        or marker.get("schema_version") != AUTHORITY_SCHEMA
        or marker.get("safe_replace") is not True
        or marker.get("artifacts") != expected_artifacts
        or report.get("schema_version") != AUTHORITY_SCHEMA
        or report.get("status") != "ready_for_legacy_new7_full22_train_upgrade"
        or report.get("split") != "train"
        or report.get("completed_human_visual_provenance") is not True
        or int(report.get("upgraded_record_count", 0)) != RECORD_COUNT
        or int(report.get("new7_visual_judgment_record_count", 0)) != RECORD_COUNT
        or report.get("new7_candidate_ids") != list(legacy.NEW7_IDS)
        or any(int(report.get(name, -1)) != 0 for name in required_zero)
        or effect.get("original_strict_full22_train_rows") != STRICT_FULL22_TRAIN_COUNT
        or effect.get("full22_train_rows_after_apply") != FULL22_TRAIN_AFTER_APPLY
        or effect.get("partial15_train_rows_after_apply") != PARTIAL15_TRAIN_AFTER_APPLY
        or effect.get("total_train_rows_after_apply") != TOTAL_REAL_TRAIN_COUNT
    ):
        raise All160AuthorityError("all160 authority report boundary drifted")
    audit = trainer.read_json(root / AUDIT_FILE, location="authority audit")
    audit_sha = trainer.validate_record_seal(audit, location="authority audit")
    if audit_sha != draft_validation["audit_record_sha256"]:
        raise All160AuthorityError("authority/draft audit binding drifted")
    decisions = {
        str(row["sample_id"]): row
        for row in trainer.read_json(draft_root / DRAFT_FILE, location="all160 draft")["judgments"]
    }
    review_rows = _review_rows(review_root)
    examples, _binding = legacy.load_partial_examples(legacy_overlay_dir, catalog_registry)
    base_by_id = {example.sample_id: example for example in examples}
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    rows = _read_jsonl(root / AUTHORITY_FILE, "all160 authority")
    if (
        len(rows) != RECORD_COUNT
        or [row.get("sample_id") for row in rows] != [row.get("sample_id") for row in review_rows]
        or len({str(row.get("sample_id")) for row in rows}) != RECORD_COUNT
    ):
        raise All160AuthorityError("all160 authority identity/order drifted")
    for row in rows:
        sample_id = _text(row.get("sample_id"), "authority sample")
        base_example = base_by_id.get(sample_id)
        decision = decisions.get(sample_id)
        if base_example is None or decision is None:
            raise All160AuthorityError("authority escaped partial618/draft identity")
        if (
            row.get("base_partial_record_sha256") != base_example.row.get("record_sha256")
            or row.get("legacy15_membership_sha256")
            != legacy._legacy_membership_sha(base_example.row["font_judgment"])  # noqa: SLF001
            or legacy._legacy_membership_sha(row["font_judgment"])  # noqa: SLF001
            != row.get("legacy15_membership_sha256")
            or _new7_tiers_from_row(row) != dict(decision["new7_tiers"])
            or row.get("source") != base_example.row.get("source")
            or row.get("role") != base_example.row.get("role")
            or row.get("source_style") != base_example.row.get("source_style")
            or row.get("treatment") != base_example.row.get("treatment")
            or row.get("training_eligible") is not True
            or row.get("label_authority") != "completed_human_final_label"
            or row.get("review_provenance", {}).get("authority", {}).get(
                "secondary_visual_audit_record_sha256"
            )
            != audit_sha
        ):
            raise All160AuthorityError("all160 authority row contract drifted")
        judgment = _mapping(row.get("font_judgment"), "authority judgment")
        if judgment.get("not_reviewed") or set().union(
            *(set(judgment[tier]) for tier in trainer.HUMAN_TIERS)
        ) != set(legacy.FULL22_IDS):
            raise All160AuthorityError("authority row is not complete full22")
        trainer._validate_human_row(  # noqa: SLF001
            row,
            split="train",
            candidate_ids=legacy.FULL22_IDS,
            catalog_registry_sha256=registry_sha,
            location=f"all160 authority:{sample_id}",
        )
    aggregate_base = legacy._aggregate_row_binding(rows, "base_partial_record_sha256")  # noqa: SLF001
    aggregate_legacy = legacy._aggregate_row_binding(rows, "legacy15_membership_sha256")  # noqa: SLF001
    if (
        report.get("base_partial_record_sha256") != aggregate_base
        or report.get("legacy15_membership_sha256") != aggregate_legacy
    ):
        raise All160AuthorityError("all160 aggregate binding drifted")
    return {
        "base_partial_record_sha256": aggregate_base,
        "completed_human_visual_provenance": True,
        "fabricated_new7_negative_count": 0,
        "fresh64_overlap_count": 0,
        "full22_train_rows_after_apply": FULL22_TRAIN_AFTER_APPLY,
        "legacy15_membership_sha256": aggregate_legacy,
        "new7_candidate_ids": list(legacy.NEW7_IDS),
        "new7_visual_judgment_record_count": RECORD_COUNT,
        "old15_membership_mutation_count": 0,
        "output_dir": str(root),
        "qa40_overlap_count": 0,
        "split": "train",
        "status": "ready_for_legacy_new7_full22_train_upgrade",
        "test_overlap_count": 0,
        "upgraded_record_count": RECORD_COUNT,
        "val_overlap_count": 0,
    }


def load_authority_examples(
    output_dir: Path,
    *,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
) -> tuple[tuple[trainer.HumanExample, ...], dict[str, Any]]:
    validation = validate_authority(
        output_dir,
        review_dir=review_dir,
        draft_dir=draft_dir,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
    )
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    examples = tuple(
        trainer._validate_human_row(  # noqa: SLF001
            row,
            split="train",
            candidate_ids=legacy.FULL22_IDS,
            catalog_registry_sha256=registry_sha,
            location=f"all160 authority load:{index}",
        )
        for index, row in enumerate(
            _read_jsonl(output_dir.expanduser().resolve() / AUTHORITY_FILE, "authority load"),
            1,
        )
    )
    if len(examples) != RECORD_COUNT:
        raise All160AuthorityError("loaded all160 authority count drifted")
    return examples, validation


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    draft = commands.add_parser("build-draft")
    draft.add_argument("--review-dir", type=Path, required=True)
    draft.add_argument("--first40-draft-dir", type=Path, required=True)
    draft.add_argument("--first40-authority-dir", type=Path, required=True)
    draft.add_argument("--remaining120-dir", type=Path, required=True)
    draft.add_argument("--legacy-overlay-dir", type=Path, required=True)
    draft.add_argument("--catalog-registry", type=Path, required=True)
    draft.add_argument("--output-dir", type=Path, required=True)
    validate_draft_parser = commands.add_parser("validate-draft")
    validate_draft_parser.add_argument("--review-dir", type=Path, required=True)
    validate_draft_parser.add_argument("--legacy-overlay-dir", type=Path, required=True)
    validate_draft_parser.add_argument("--catalog-registry", type=Path, required=True)
    validate_draft_parser.add_argument("--output-dir", type=Path, required=True)
    authority_parser = commands.add_parser("build-authority")
    authority_parser.add_argument("--review-dir", type=Path, required=True)
    authority_parser.add_argument("--draft-dir", type=Path, required=True)
    authority_parser.add_argument("--legacy-overlay-dir", type=Path, required=True)
    authority_parser.add_argument("--catalog-registry", type=Path, required=True)
    authority_parser.add_argument("--output-dir", type=Path, required=True)
    authority_parser.add_argument("--reviewer", default="codex-root-all160-finalizer-v1")
    authority_parser.add_argument("--confirm-human-finalization", action="store_true")
    validate_authority_parser = commands.add_parser("validate-authority")
    validate_authority_parser.add_argument("--review-dir", type=Path, required=True)
    validate_authority_parser.add_argument("--draft-dir", type=Path, required=True)
    validate_authority_parser.add_argument("--legacy-overlay-dir", type=Path, required=True)
    validate_authority_parser.add_argument("--catalog-registry", type=Path, required=True)
    validate_authority_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "build-draft":
        result = build_draft(
            review_dir=args.review_dir,
            first40_draft_dir=args.first40_draft_dir,
            first40_authority_dir=args.first40_authority_dir,
            remaining120_dir=args.remaining120_dir,
            legacy_overlay_dir=args.legacy_overlay_dir,
            catalog_registry=args.catalog_registry,
            output_dir=args.output_dir,
        )
    elif args.command == "validate-draft":
        result = validate_draft(
            args.output_dir,
            review_dir=args.review_dir,
            legacy_overlay_dir=args.legacy_overlay_dir,
            catalog_registry=args.catalog_registry,
        )
    elif args.command == "build-authority":
        result = build_authority(
            review_dir=args.review_dir,
            draft_dir=args.draft_dir,
            legacy_overlay_dir=args.legacy_overlay_dir,
            catalog_registry=args.catalog_registry,
            output_dir=args.output_dir,
            reviewer=args.reviewer,
            confirm_human_finalization=args.confirm_human_finalization,
        )
    else:
        result = validate_authority(
            args.output_dir,
            review_dir=args.review_dir,
            draft_dir=args.draft_dir,
            legacy_overlay_dir=args.legacy_overlay_dir,
            catalog_registry=args.catalog_registry,
        )
    print(trainer.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
