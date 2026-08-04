#!/usr/bin/env python3
"""Seal the directly reviewed rank 41-160 new7 visual-draft tranche.

This tool is deliberately draft-only.  It locks the existing legacy15 tier
membership, expands all seven successor candidates to explicit four-way tiers,
binds the exact contact sheets opened at original detail, and refuses to emit
training authority.  A later full22 promotion must consume this sealed bundle
and perform its own explicit authority step.
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
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_legacy_new7_expansion_review_v1 as legacy
    import train_manga_font_student_v1 as trainer


SCHEMA_VERSION = "manga-font-legacy-new7-expansion-visual-draft-remaining120-v1"
SOURCE_SCHEMA_VERSION = (
    "manga-font-legacy-new7-expansion-remaining120-visual-source-v1"
)
AUDIT_SCHEMA_VERSION = (
    "manga-font-legacy-new7-secondary-visual-audit-remaining120-v1"
)
OWNER = (
    "carrot-manga-translator/"
    "manga-font-legacy-new7-expansion-visual-draft-remaining120-v1"
)
MARKER_FILE = (
    ".manga-font-legacy-new7-expansion-visual-draft-remaining120-v1-owned.json"
)
DRAFT_FILE = "judgments-remaining120-draft.json"
AUDIT_FILE = "secondary-visual-audit-remaining120.json"
SOURCE_FILE = "visual-judgments-source-remaining120.json"
FINAL_TIERS = ("preferred", "acceptable", "marginal", "unacceptable")
NEW7_IDS = tuple(legacy.NEW7_IDS)
START_RANK = 41
END_RANK = 160
RECORD_COUNT = 120
FIRST_SHEET_INDEX = 11
LAST_SHEET_INDEX = 40
EXPECTED_SECONDARY_REVIEWER = "codex-root-independent-remaining120-v1"
EXPECTED_PRIMARY_REVIEWER = "codex-new7-direct-visual-remaining120-v1"


class Remaining120DraftError(ValueError):
    """Raised when draft identity, label, hash, or exclusion boundaries drift."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise Remaining120DraftError(f"{location}: expected object")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise Remaining120DraftError(f"{location}: expected text")
    return result


def _safe_output(path: Path) -> Path:
    output = path.expanduser().resolve()
    if output in {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}:
        raise Remaining120DraftError(f"unsafe output: {output}")
    if len(output.parts) < 3 or len(output.name) < 3:
        raise Remaining120DraftError(f"unsafe output: {output}")
    return output


def _read_review_rows(review_root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with (review_root / legacy.REVIEW_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"review:{line_number}"))
            except json.JSONDecodeError as error:
                raise Remaining120DraftError("review input JSON drifted") from error
            trainer.validate_record_seal(row, location=f"review:{line_number}")
            rows.append(row)
    if len(rows) != 160:
        raise Remaining120DraftError("review queue must remain exactly 160 rows")
    return rows


def _expected_rows(review_root: Path) -> list[dict[str, Any]]:
    legacy.validate_review(review_root)
    rows = _read_review_rows(review_root)
    expected = rows[START_RANK - 1 : END_RANK]
    if (
        len(expected) != RECORD_COUNT
        or [row.get("selection_rank") for row in expected]
        != list(range(START_RANK, END_RANK + 1))
        or len({str(row.get("sample_id")) for row in expected}) != RECORD_COUNT
    ):
        raise Remaining120DraftError("remaining120 identity/rank tranche drifted")
    if {str(row["sample_id"]) for row in rows[:40]} & {
        str(row["sample_id"]) for row in expected
    }:
        raise Remaining120DraftError("remaining120 overlaps protected first40")
    return expected


def _validate_exclusion_boundary(review_report: Mapping[str, Any]) -> None:
    boundary = _mapping(review_report.get("boundary"), "review.boundary")
    zero_keys = (
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
    if boundary.get("selected_split") != "train" or any(
        boundary.get(key) != 0 for key in zero_keys
    ):
        raise Remaining120DraftError("test/fresh64/QA exclusion boundary drifted")


def _normalize_profile(
    profile: Mapping[str, Any], *, location: str
) -> tuple[dict[str, str], str]:
    candidate_to_tier: dict[str, str] = {}
    for tier in FINAL_TIERS:
        values = profile.get(tier)
        if not isinstance(values, list) or any(
            not isinstance(candidate_id, str) for candidate_id in values
        ):
            raise Remaining120DraftError(f"{location}.{tier}: expected string array")
        for candidate_id in values:
            if candidate_id not in NEW7_IDS or candidate_id in candidate_to_tier:
                raise Remaining120DraftError(
                    f"{location}: invalid or duplicate new7 candidate {candidate_id}"
                )
            candidate_to_tier[candidate_id] = tier
    if set(candidate_to_tier) != set(NEW7_IDS):
        raise Remaining120DraftError(
            f"{location}: profile must explicitly partition all seven candidates"
        )
    return (
        {candidate_id: candidate_to_tier[candidate_id] for candidate_id in NEW7_IDS},
        _text(profile.get("notes"), f"{location}.notes"),
    )


def _normalize_source(
    source: Mapping[str, Any], expected_rows: Sequence[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if (
        source.get("schema_version") != SOURCE_SCHEMA_VERSION
        or source.get("label_authority")
        != "direct_visual_judgment_source_not_gold_until_sealed_promotion"
        or source.get("training_eligible") is not False
    ):
        raise Remaining120DraftError("visual source authority boundary drifted")
    raw_profiles = _mapping(source.get("profiles"), "source.profiles")
    profiles: dict[str, tuple[dict[str, str], str]] = {}
    for name, raw_profile in raw_profiles.items():
        profile_name = _text(name, "profile name")
        profiles[profile_name] = _normalize_profile(
            _mapping(raw_profile, f"profile.{profile_name}"),
            location=f"profile.{profile_name}",
        )
    entries = _mapping(source.get("judgments"), "source.judgments")
    expected_ids = {str(row["sample_id"]) for row in expected_rows}
    if set(entries) != expected_ids:
        missing = sorted(expected_ids - set(entries))
        extra = sorted(set(entries) - expected_ids)
        raise Remaining120DraftError(
            f"source must contain exact rank41-160 IDs; missing={missing[:3]} extra={extra[:3]}"
        )
    normalized: list[dict[str, Any]] = []
    for row in expected_rows:
        sample_id = str(row["sample_id"])
        entry = _mapping(entries[sample_id], f"judgment.{sample_id}")
        if entry.get("selection_rank") != row.get("selection_rank"):
            raise Remaining120DraftError(f"judgment.{sample_id}: rank drifted")
        if entry.get("visually_reviewed") is not True:
            raise Remaining120DraftError(
                f"judgment.{sample_id}: visual acknowledgement required"
            )
        confidence = _text(entry.get("confidence"), f"judgment.{sample_id}.confidence")
        if confidence not in {"high", "medium", "low"}:
            raise Remaining120DraftError(
                f"judgment.{sample_id}: invalid confidence {confidence}"
            )
        profile_name = _text(entry.get("profile"), f"judgment.{sample_id}.profile")
        if profile_name not in profiles:
            raise Remaining120DraftError(
                f"judgment.{sample_id}: unknown profile {profile_name}"
            )
        tiers, profile_notes = profiles[profile_name]
        notes = str(entry.get("notes") or profile_notes).strip()
        normalized.append(
            {
                "confidence": confidence,
                "legacy15_membership_sha256": row["legacy15_lock"][
                    "membership_sha256"
                ],
                "model_reference_visible": True,
                "new7_tiers": copy.deepcopy(tiers),
                "notes": notes,
                "profile": profile_name,
                "sample_id": sample_id,
                "selection_rank": row["selection_rank"],
                "visually_reviewed": True,
            }
        )
    visual_audit = dict(_mapping(source.get("visual_audit"), "source.visual_audit"))
    if (
        visual_audit.get("reviewer") != EXPECTED_SECONDARY_REVIEWER
        or visual_audit.get("detail") != "original"
        or visual_audit.get("opened_sheet_range") != [11, 40]
        or visual_audit.get("opened_row_range") != [41, 160]
        or visual_audit.get("visual_rows_opened") != RECORD_COUNT
        or visual_audit.get("blocking_outliers") != 0
        or visual_audit.get("status")
        != "pass_no_blocking_visual_tier_outlier"
    ):
        raise Remaining120DraftError("source visual audit boundary drifted")
    return normalized, visual_audit


def _contact_sheets(review_report: Mapping[str, Any]) -> list[dict[str, Any]]:
    sheets = [
        copy.deepcopy(dict(_mapping(value, "contact sheet")))
        for value in review_report.get("contact_sheets", [])[10:40]
    ]
    if (
        len(sheets) != 30
        or sheets[0].get("first_selection_rank") != START_RANK
        or sheets[-1].get("last_selection_rank") != END_RANK
        or [sheet.get("file") for sheet in sheets]
        != [f"contact-sheets/sheet-{index:03d}.png" for index in range(11, 41)]
    ):
        raise Remaining120DraftError("contact sheet tranche drifted")
    return sheets


def _descriptor(path: Path) -> dict[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": trainer.sha256_file(path),
    }


def _builder_sha() -> str:
    return trainer.sha256_file(Path(__file__).resolve())


def build_draft(
    *,
    review_dir: Path,
    judgments_path: Path,
    output_dir: Path,
    reviewer: str = EXPECTED_PRIMARY_REVIEWER,
    secondary_reviewer: str = EXPECTED_SECONDARY_REVIEWER,
) -> dict[str, Any]:
    review_root = review_dir.expanduser().resolve()
    judgments_root = judgments_path.expanduser().resolve()
    expected = _expected_rows(review_root)
    review_report = trainer.read_json(
        review_root / legacy.REPORT_FILE, location="new7 review report"
    )
    trainer.validate_record_seal(review_report, location="new7 review report")
    _validate_exclusion_boundary(review_report)
    source = trainer.read_json(judgments_root, location="remaining120 visual source")
    normalized, visual_audit = _normalize_source(source, expected)
    primary_reviewer = _text(reviewer, "reviewer")
    secondary_reviewer_text = _text(secondary_reviewer, "secondary reviewer")
    if primary_reviewer != EXPECTED_PRIMARY_REVIEWER:
        raise Remaining120DraftError("unexpected primary reviewer identity")
    if secondary_reviewer_text != visual_audit["reviewer"]:
        raise Remaining120DraftError("secondary reviewer/source audit identity drifted")

    first40_ids = {
        str(row["sample_id"]) for row in _read_review_rows(review_root)[:40]
    }
    decision_ids = {str(decision["sample_id"]) for decision in normalized}
    if first40_ids & decision_ids:
        raise Remaining120DraftError("protected first40 artifact identity overlap")

    profile_counts = dict(sorted(Counter(row["profile"] for row in normalized).items()))
    confidence_counts = dict(
        sorted(Counter(row["confidence"] for row in normalized).items())
    )
    low_confidence_ids = [
        row["sample_id"] for row in normalized if row["confidence"] == "low"
    ]
    no_forced_preferred_ids = [
        row["sample_id"]
        for row in normalized
        if "preferred" not in set(row["new7_tiers"].values())
    ]
    output = _safe_output(output_dir)
    if output.exists():
        raise Remaining120DraftError("draft output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        shutil.copyfile(judgments_root, staging / SOURCE_FILE)
        draft = trainer.seal_record(
            {
                "builder_source_sha256": _builder_sha(),
                "checks": {
                    "all_four_tiers_explicit": True,
                    "first40_overlap_count": 0,
                    "fresh64_overlap_count": 0,
                    "legacy15_membership_mutations": 0,
                    "model_reference_auto_promotions": 0,
                    "new7_all_reviewed": True,
                    "qa40_overlap_count": 0,
                    "remaining120_exact": True,
                    "selection_rank_range": [START_RANK, END_RANK],
                    "test_overlap_count": 0,
                },
                "confidence_counts": confidence_counts,
                "judgments": normalized,
                "label_authority": "human_visual_draft_not_gold",
                "low_confidence_sample_ids": low_confidence_ids,
                "no_forced_preferred_sample_ids": no_forced_preferred_ids,
                "profile_counts": profile_counts,
                "promotion_allowed": False,
                "record_type": (
                    "manga_font_legacy_new7_expansion_visual_draft_remaining120"
                ),
                "review_input_sha256": trainer.sha256_file(
                    review_root / legacy.REVIEW_FILE
                ),
                "review_report_sha256": trainer.sha256_file(
                    review_root / legacy.REPORT_FILE
                ),
                "reviewer": primary_reviewer,
                "schema_version": SCHEMA_VERSION,
                "source_judgments_sha256": trainer.sha256_file(staging / SOURCE_FILE),
                "training_eligible": False,
            }
        )
        (staging / DRAFT_FILE).write_bytes(trainer.json_bytes(draft, pretty=True))
        sheets = _contact_sheets(review_report)
        audit = trainer.seal_record(
            {
                "blocking_outliers": 0,
                "contact_sheets": sheets,
                "detail": "original",
                "draft_record_sha256": draft["record_sha256"],
                "low_confidence_sample_ids": low_confidence_ids,
                "no_forced_preferred_sample_ids": no_forced_preferred_ids,
                "opened_row_range": [START_RANK, END_RANK],
                "opened_sheet_range": [FIRST_SHEET_INDEX, LAST_SHEET_INDEX],
                "record_type": (
                    "manga_font_legacy_new7_secondary_visual_audit_remaining120"
                ),
                "review_report_sha256": trainer.sha256_file(
                    review_root / legacy.REPORT_FILE
                ),
                "reviewer": secondary_reviewer_text,
                "schema_version": AUDIT_SCHEMA_VERSION,
                "source_judgments_sha256": trainer.sha256_file(staging / SOURCE_FILE),
                "special_case_confirmations": {
                    "low_confidence_explicit": len(low_confidence_ids),
                    "mincho_or_general_no_forced_preferred": len(
                        no_forced_preferred_ids
                    ),
                    "pseudo_top5_auto_promotions": 0,
                },
                "status": "pass_no_blocking_visual_tier_outlier",
                "visual_rows_opened": RECORD_COUNT,
            }
        )
        (staging / AUDIT_FILE).write_bytes(trainer.json_bytes(audit, pretty=True))
        marker = {
            "artifacts": {
                AUDIT_FILE: trainer.sha256_file(staging / AUDIT_FILE),
                DRAFT_FILE: trainer.sha256_file(staging / DRAFT_FILE),
                SOURCE_FILE: trainer.sha256_file(staging / SOURCE_FILE),
            },
            "builder_source_sha256": _builder_sha(),
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.rename(staging, output)
        published = True
        return validate_draft(output, review_root)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_draft(output_dir: Path, review_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    review_root = review_dir.expanduser().resolve()
    expected = _expected_rows(review_root)
    review_report = trainer.read_json(
        review_root / legacy.REPORT_FILE, location="new7 review report"
    )
    trainer.validate_record_seal(review_report, location="new7 review report")
    _validate_exclusion_boundary(review_report)

    marker = trainer.read_json(root / MARKER_FILE, location="remaining120 marker")
    expected_artifacts = {
        AUDIT_FILE: trainer.sha256_file(root / AUDIT_FILE),
        DRAFT_FILE: trainer.sha256_file(root / DRAFT_FILE),
        SOURCE_FILE: trainer.sha256_file(root / SOURCE_FILE),
    }
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("builder_source_sha256") != _builder_sha()
        or marker.get("artifacts") != expected_artifacts
    ):
        raise Remaining120DraftError("draft marker/hash boundary drifted")

    source = trainer.read_json(root / SOURCE_FILE, location="remaining120 source copy")
    normalized, visual_audit = _normalize_source(source, expected)
    draft = trainer.read_json(root / DRAFT_FILE, location="remaining120 draft")
    draft_record_sha = trainer.validate_record_seal(
        draft, location="remaining120 draft"
    )
    expected_checks = {
        "all_four_tiers_explicit": True,
        "first40_overlap_count": 0,
        "fresh64_overlap_count": 0,
        "legacy15_membership_mutations": 0,
        "model_reference_auto_promotions": 0,
        "new7_all_reviewed": True,
        "qa40_overlap_count": 0,
        "remaining120_exact": True,
        "selection_rank_range": [START_RANK, END_RANK],
        "test_overlap_count": 0,
    }
    if (
        draft.get("schema_version") != SCHEMA_VERSION
        or draft.get("label_authority") != "human_visual_draft_not_gold"
        or draft.get("training_eligible") is not False
        or draft.get("promotion_allowed") is not False
        or draft.get("reviewer") != EXPECTED_PRIMARY_REVIEWER
        or draft.get("builder_source_sha256") != _builder_sha()
        or draft.get("source_judgments_sha256")
        != trainer.sha256_file(root / SOURCE_FILE)
        or draft.get("review_input_sha256")
        != trainer.sha256_file(review_root / legacy.REVIEW_FILE)
        or draft.get("review_report_sha256")
        != trainer.sha256_file(review_root / legacy.REPORT_FILE)
        or draft.get("checks") != expected_checks
        or draft.get("judgments") != normalized
    ):
        raise Remaining120DraftError("draft record boundary drifted")

    ranks = [row.get("selection_rank") for row in draft["judgments"]]
    ids = [str(row.get("sample_id")) for row in draft["judgments"]]
    expected_ids = [str(row["sample_id"]) for row in expected]
    if (
        len(draft["judgments"]) != RECORD_COUNT
        or ranks != list(range(START_RANK, END_RANK + 1))
        or ids != expected_ids
        or len(set(ids)) != RECORD_COUNT
    ):
        raise Remaining120DraftError("draft exact identity/rank validation failed")
    for decision, review_row in zip(draft["judgments"], expected, strict=True):
        tiers = _mapping(decision.get("new7_tiers"), "decision.new7_tiers")
        if (
            list(tiers) != list(NEW7_IDS)
            or set(tiers.values()) - set(FINAL_TIERS)
            or decision.get("legacy15_membership_sha256")
            != review_row["legacy15_lock"]["membership_sha256"]
            or decision.get("model_reference_visible") is not True
            or decision.get("visually_reviewed") is not True
        ):
            raise Remaining120DraftError("explicit new7/legacy15 lock drifted")

    low_ids = [row["sample_id"] for row in normalized if row["confidence"] == "low"]
    no_preferred_ids = [
        row["sample_id"]
        for row in normalized
        if "preferred" not in set(row["new7_tiers"].values())
    ]
    expected_profile_counts = dict(
        sorted(Counter(row["profile"] for row in normalized).items())
    )
    expected_confidence_counts = dict(
        sorted(Counter(row["confidence"] for row in normalized).items())
    )
    if (
        draft.get("low_confidence_sample_ids") != low_ids
        or draft.get("no_forced_preferred_sample_ids") != no_preferred_ids
        or draft.get("profile_counts") != expected_profile_counts
        or draft.get("confidence_counts") != expected_confidence_counts
    ):
        raise Remaining120DraftError("draft summary counts drifted")

    audit = trainer.read_json(root / AUDIT_FILE, location="remaining120 audit")
    audit_record_sha = trainer.validate_record_seal(
        audit, location="remaining120 audit"
    )
    expected_sheets = _contact_sheets(review_report)
    for descriptor in expected_sheets:
        sheet = review_root / str(descriptor["file"])
        if trainer.sha256_file(sheet) != descriptor.get("sha256"):
            raise Remaining120DraftError("opened contact sheet hash drifted")
    if (
        audit.get("schema_version") != AUDIT_SCHEMA_VERSION
        or audit.get("reviewer") != visual_audit["reviewer"]
        or audit.get("detail") != "original"
        or audit.get("opened_sheet_range") != [11, 40]
        or audit.get("opened_row_range") != [41, 160]
        or audit.get("visual_rows_opened") != RECORD_COUNT
        or audit.get("blocking_outliers") != 0
        or audit.get("status") != "pass_no_blocking_visual_tier_outlier"
        or audit.get("draft_record_sha256") != draft_record_sha
        or audit.get("review_report_sha256")
        != trainer.sha256_file(review_root / legacy.REPORT_FILE)
        or audit.get("source_judgments_sha256")
        != trainer.sha256_file(root / SOURCE_FILE)
        or audit.get("contact_sheets") != expected_sheets
        or audit.get("low_confidence_sample_ids") != low_ids
        or audit.get("no_forced_preferred_sample_ids") != no_preferred_ids
        or audit.get("special_case_confirmations")
        != {
            "low_confidence_explicit": len(low_ids),
            "mincho_or_general_no_forced_preferred": len(no_preferred_ids),
            "pseudo_top5_auto_promotions": 0,
        }
    ):
        raise Remaining120DraftError("secondary visual audit boundary drifted")

    return {
        "audit_record_sha256": audit_record_sha,
        "confidence_counts": expected_confidence_counts,
        "draft_count": RECORD_COUNT,
        "draft_record_sha256": draft_record_sha,
        "first40_overlap_count": 0,
        "fresh64_overlap_count": 0,
        "legacy15_membership_mutations": 0,
        "low_confidence_count": len(low_ids),
        "no_forced_preferred_count": len(no_preferred_ids),
        "output_dir": str(root),
        "qa40_overlap_count": 0,
        "selection_rank_range": [START_RANK, END_RANK],
        "status": "sealed_human_visual_draft_not_gold",
        "test_overlap_count": 0,
    }


def load_authority_inputs(
    output_dir: Path, review_dir: Path
) -> tuple[tuple[dict[str, Any], ...], dict[str, Any]]:
    """Return sealed decisions/audit for a later explicit full22 authority builder."""

    validate_draft(output_dir, review_dir)
    root = output_dir.expanduser().resolve()
    draft = trainer.read_json(root / DRAFT_FILE, location="remaining120 draft")
    audit = trainer.read_json(root / AUDIT_FILE, location="remaining120 audit")
    return tuple(copy.deepcopy(draft["judgments"])), copy.deepcopy(audit)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-draft")
    build.add_argument("--review-dir", type=Path, required=True)
    build.add_argument("--judgments", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--reviewer", default=EXPECTED_PRIMARY_REVIEWER)
    build.add_argument("--secondary-reviewer", default=EXPECTED_SECONDARY_REVIEWER)
    validate = commands.add_parser("validate-draft")
    validate.add_argument("--output-dir", type=Path, required=True)
    validate.add_argument("--review-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "build-draft":
        result = build_draft(
            review_dir=args.review_dir,
            judgments_path=args.judgments,
            output_dir=args.output_dir,
            reviewer=args.reviewer,
            secondary_reviewer=args.secondary_reviewer,
        )
    else:
        result = validate_draft(args.output_dir, args.review_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
