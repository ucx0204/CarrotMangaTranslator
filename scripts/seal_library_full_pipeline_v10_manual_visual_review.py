#!/usr/bin/env python3
"""Seal the direct 40-page visual review of the fresh v10 Gemma baseline.

This is deliberately a page-level, evaluation-only record.  It binds the
completed run report, the already sealed visual-review pack, every page-pair
image, and the 317-row block review inventory.  It cannot grant training,
calibration, pseudo-label, promotion, or release authority.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from scripts import build_library_font_qa_visual_review as visual_review
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_library_font_qa_visual_review as visual_review


TOOL_ID = "manga-library-v10-fresh40-manual-visual-review-sealer"
TOOL_VERSION = "1.0.0"
SCHEMA_VERSION = 1
RECORD_TYPE = "manga_library_full_pipeline_manual_visual_review"
REPORT_NAME = "manual-visual-review.json"
SEAL_SUFFIX = ".sha256"

EXPECTED_RUN = {
    "runId": "full-gemma-20260811-r1",
    "cohort": "baseline40",
    "candidateId": "r3h-fresh-gemma-v1",
    "provider": "gemma",
    "targetLanguage": "ko",
    "pageCount": 40,
    "status": "completed",
    "cacheFrom": None,
    "qaPageRelativeRoleReroute": False,
}

PAGE_VERDICTS = {
    "not_applicable": frozenset((3, 21, 35, 37)),
    "good": frozenset((12, 13, 18, 19, 22, 23, 25, 27, 28, 29, 33, 34, 36, 38, 39, 40)),
    "acceptable": frozenset((2, 5, 6, 7, 8, 9, 10, 11, 14, 15, 20, 24, 31)),
    "bad": frozenset((1, 4, 16, 17, 26, 30, 32)),
}

PAGE_NOTES = {
    1: ["layout_or_cover_mismatch"],
    4: ["layout_or_cover_mismatch"],
    16: ["layout_or_cover_mismatch"],
    17: ["font_and_layout_consistency_failure"],
    19: ["dark_background_white_text_outline_preserved"],
    25: ["dark_background_white_text_outline_preserved"],
    26: ["font_and_layout_consistency_failure"],
    30: [
        "font_and_layout_consistency_failure",
        "same_narration_context_received_arbitrarily_mixed_fonts_including_brush_like_face",
    ],
    32: [
        "font_and_layout_consistency_failure",
        "severe_weight_and_placement_mismatch",
    ],
    40: ["dark_background_white_text_outline_preserved"],
}

EXPECTED_ROLE_COUNTS = {
    "dialogue": 59,
    "emphasis_dialogue": 233,
    "narration": 3,
    "sfx_impact": 1,
    "sfx_motion": 4,
    "shout": 3,
    "sign_ui_title": 12,
    "thought": 2,
}
EXPECTED_TOTAL_BLOCKS = 317
EXPECTED_APPLIED_BLOCKS = 274
EXPECTED_SINGLE_DAY_KEYS = ((7, 2), (13, 4), (17, 12), (19, 6), (23, 0))
SINGLE_DAY_ASSESSMENTS = {
    (7, 2): "defensible_reaction_or_soundish_usage",
    (13, 4): "defensible_reaction_or_soundish_usage",
    (17, 12): "defensible_reaction_or_soundish_usage",
    (19, 6): "questionable_ordinary_trailing_phrase",
    (23, 0): "appropriate_reaction_exclamation",
}

AUTHORITY = {
    "mode": "evaluation_only",
    "evaluationEligible": True,
    "manualVisualReviewOnly": True,
    "trainingEligible": False,
    "trainingLabelAuthority": False,
    "calibrationEligible": False,
    "calibrationLabelAuthority": False,
    "pseudoLabelEligible": False,
    "pseudoLabelAuthority": False,
    "automaticLabelPromotionAllowed": False,
    "humanGold": False,
    "releaseEligible": False,
    "releaseAuthority": False,
    "automaticReleaseAuthority": False,
    "allowedUses": ["evaluation", "manual_visual_review", "candidate_comparison"],
}


class ManualVisualReviewError(RuntimeError):
    """Raised when the supplied evidence cannot reproduce the fixed review."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise ManualVisualReviewError(f"Could not hash {path}: {exc}") from exc
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ManualVisualReviewError(f"Could not read {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ManualVisualReviewError(f"{label} must be a JSON object: {path}")
    return value


def read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ManualVisualReviewError(f"Could not read {label} {path}: {exc}") from exc
    for line_number, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ManualVisualReviewError(
                f"Invalid {label} JSON at {path}:{line_number}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise ManualVisualReviewError(
                f"{label} row must be an object at {path}:{line_number}"
            )
        rows.append(value)
    return rows


def file_binding(path: Path, kind: str) -> dict[str, Any]:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ManualVisualReviewError(f"Missing {kind}: {path}: {exc}") from exc
    if not resolved.is_file():
        raise ManualVisualReviewError(f"{kind} is not a file: {resolved}")
    return {
        "kind": kind,
        "path": str(resolved),
        "size": resolved.stat().st_size,
        "sha256": sha256_file(resolved),
    }


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManualVisualReviewError(f"{label} must be an integer >= {minimum}.")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManualVisualReviewError(f"{label} must be a non-empty string.")
    return value


def verdict_for_page(page_number: int) -> str:
    matches = [name for name, pages in PAGE_VERDICTS.items() if page_number in pages]
    if len(matches) != 1:
        raise ManualVisualReviewError(
            f"Page {page_number} must have exactly one fixed verdict, got {matches}."
        )
    return matches[0]


def validate_fixed_verdict_partition() -> None:
    flattened = [page for pages in PAGE_VERDICTS.values() for page in pages]
    if len(flattened) != 40 or set(flattened) != set(range(1, 41)):
        raise ManualVisualReviewError("Fixed verdicts do not partition pages 1..40 exactly once.")


def validate_run(report: Mapping[str, Any]) -> list[dict[str, Any]]:
    for key, expected in EXPECTED_RUN.items():
        if report.get(key) != expected:
            raise ManualVisualReviewError(
                f"Run identity/execution mismatch for {key}: expected {expected!r}, got {report.get(key)!r}."
            )
    pages = report.get("pages")
    if not isinstance(pages, list) or len(pages) != 40:
        raise ManualVisualReviewError("Run must contain exactly 40 pages.")
    seen_page_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for offset, raw_page in enumerate(pages):
        if not isinstance(raw_page, dict):
            raise ManualVisualReviewError(f"Run page {offset + 1} is not an object.")
        if raw_page.get("selectionIndex") != offset:
            raise ManualVisualReviewError(f"Run page {offset + 1} selectionIndex drifted.")
        if raw_page.get("status") != "completed" or raw_page.get("stage") != "done":
            raise ManualVisualReviewError(f"Run page {offset + 1} is incomplete.")
        source_page_id = require_string(raw_page.get("sourcePageId"), "sourcePageId")
        if source_page_id in seen_page_ids:
            raise ManualVisualReviewError(f"Duplicate run sourcePageId: {source_page_id}")
        seen_page_ids.add(source_page_id)
        decisions = raw_page.get("fontDecisions")
        if not isinstance(decisions, list):
            raise ManualVisualReviewError(f"Run page {offset + 1} fontDecisions is not a list.")
        if raw_page.get("blockCount") != len(decisions):
            raise ManualVisualReviewError(f"Run page {offset + 1} blockCount drifted.")
        normalized.append(raw_page)
    return normalized


def validate_visual_index(
    index: Mapping[str, Any],
    report_path: Path,
    report: Mapping[str, Any],
) -> list[dict[str, Any]]:
    if index.get("schemaVersion") != 1:
        raise ManualVisualReviewError("Unsupported visual-review index schemaVersion.")
    if index.get("expectedPageCount") != 40 or index.get("reviewStatus") != "manual_visual_review_required":
        raise ManualVisualReviewError("Visual-review index is not the expected unadjudicated 40-page pack.")
    binding = index.get("binding")
    if not isinstance(binding, dict):
        raise ManualVisualReviewError("Visual-review binding is missing.")
    expected_binding_sha = require_string(index.get("bindingSha256"), "bindingSha256")
    if sha256_bytes(canonical_json_bytes(binding)) != expected_binding_sha:
        raise ManualVisualReviewError("Visual-review bindingSha256 is invalid.")
    identity = binding.get("runIdentity")
    expected_identity = {
        "runId": report["runId"],
        "cohort": report["cohort"],
        "cohortDigest": report["cohortDigest"],
        "candidateId": report["candidateId"],
        "pageCount": 40,
    }
    if identity != expected_identity:
        raise ManualVisualReviewError("Visual-review pack is bound to a different run identity.")
    source_report = binding.get("sourceReport")
    if not isinstance(source_report, dict):
        raise ManualVisualReviewError("Visual-review sourceReport binding is missing.")
    actual_report_binding = file_binding(report_path, "run_report_json")
    for key in ("kind", "path", "size", "sha256"):
        if source_report.get(key) != actual_report_binding[key]:
            raise ManualVisualReviewError(f"Visual-review sourceReport {key} drifted.")
    pages = index.get("pages")
    if not isinstance(pages, list) or len(pages) != 40:
        raise ManualVisualReviewError("Visual-review index must contain exactly 40 pages.")
    return pages


def validate_block_rows(
    report_pages: Sequence[Mapping[str, Any]],
    rows: Sequence[Mapping[str, Any]],
) -> None:
    expected_rows: list[tuple[int, Mapping[str, Any]]] = []
    for page_number, page in enumerate(report_pages, start=1):
        decisions = page["fontDecisions"]
        for decision in decisions:
            if not isinstance(decision, dict):
                raise ManualVisualReviewError(f"Page {page_number} contains a non-object font decision.")
            expected_rows.append((page_number, decision))
    if len(rows) != len(expected_rows):
        raise ManualVisualReviewError(
            f"Block-review row count mismatch: expected {len(expected_rows)}, got {len(rows)}."
        )
    fields = (
        "blockIndex",
        "blockId",
        "applied",
        "selectedFontId",
        "effectiveFontFamily",
        "role",
        "sourceText",
        "translatedText",
    )
    for offset, (row, (page_number, decision)) in enumerate(zip(rows, expected_rows)):
        if row.get("pageNumber") != page_number:
            raise ManualVisualReviewError(f"Block-review row {offset} pageNumber drifted.")
        for field in fields:
            if row.get(field) != decision.get(field):
                raise ManualVisualReviewError(
                    f"Block-review row {offset} field {field} drifted from run report."
                )


def decision_diagnostics(report_pages: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    decisions: list[dict[str, Any]] = []
    for page_number, page in enumerate(report_pages, start=1):
        for raw in page["fontDecisions"]:
            decision = dict(raw)
            decision["_pageNumber"] = page_number
            decisions.append(decision)
    applied = [row for row in decisions if row.get("applied") is True]
    role_counts = Counter(require_string(row.get("role"), "font decision role") for row in decisions)
    if len(decisions) != EXPECTED_TOTAL_BLOCKS:
        raise ManualVisualReviewError(
            f"Expected {EXPECTED_TOTAL_BLOCKS} decisions, got {len(decisions)}."
        )
    if len(applied) != EXPECTED_APPLIED_BLOCKS:
        raise ManualVisualReviewError(
            f"Expected {EXPECTED_APPLIED_BLOCKS} applied decisions, got {len(applied)}."
        )
    if dict(sorted(role_counts.items())) != dict(sorted(EXPECTED_ROLE_COUNTS.items())):
        raise ManualVisualReviewError(f"Role distribution drifted: {dict(role_counts)}")

    outline_scales: list[float] = []
    outline_contrasts: list[float] = []
    for row in applied:
        scale = row.get("effectiveOutlineWidthScale")
        contrast = row.get("effectiveOutlineContrastRatio")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale):
            raise ManualVisualReviewError("Applied decision has an invalid outline width scale.")
        if isinstance(contrast, bool) or not isinstance(contrast, (int, float)) or not math.isfinite(contrast):
            raise ManualVisualReviewError("Applied decision has an invalid outline contrast ratio.")
        outline_scales.append(float(scale))
        outline_contrasts.append(float(contrast))
    if any(scale != 1.0 for scale in outline_scales):
        raise ManualVisualReviewError("An applied decision lost the required outline scale of 1.")
    if not outline_contrasts:
        raise ManualVisualReviewError("No applied outline contrast values were found.")

    single_day = [
        row
        for row in applied
        if row.get("selectedFontId") == "single-day"
        or row.get("effectiveFontFamily") == "single-day"
    ]
    actual_single_day_keys = tuple((row["_pageNumber"], row.get("blockIndex")) for row in single_day)
    if actual_single_day_keys != EXPECTED_SINGLE_DAY_KEYS:
        raise ManualVisualReviewError(
            f"Single Day occurrence set/order drifted: {actual_single_day_keys}."
        )
    if any(row.get("role") != "emphasis_dialogue" for row in single_day):
        raise ManualVisualReviewError("Single Day escaped the emphasis_dialogue role.")

    occurrences = []
    for row in single_day:
        key = (row["_pageNumber"], row["blockIndex"])
        occurrences.append(
            {
                "pageNumber": key[0],
                "blockIndex": key[1],
                "blockId": row.get("blockId"),
                "sourceText": row.get("sourceText"),
                "translatedText": row.get("translatedText"),
                "role": row.get("role"),
                "selectedFontId": row.get("selectedFontId"),
                "effectiveFontFamily": row.get("effectiveFontFamily"),
                "manualAssessment": SINGLE_DAY_ASSESSMENTS[key],
            }
        )

    min_contrast = min(outline_contrasts)
    return {
        "blocks": {
            "total": len(decisions),
            "applied": len(applied),
            "notApplied": len(decisions) - len(applied),
            "applyRatePercent": round(100 * len(applied) / len(decisions), 2),
        },
        "roles": {
            "counts": dict(sorted(role_counts.items())),
            "emphasisDialogue": {
                "count": role_counts["emphasis_dialogue"],
                "denominator": len(decisions),
                "sharePercent": round(100 * role_counts["emphasis_dialogue"] / len(decisions), 2),
                "finding": "role_head_collapse_or_overclassification_requires_followup",
            },
        },
        "singleDay": {
            "fontId": "single-day",
            "appliedCount": len(single_day),
            "appliedDenominator": len(applied),
            "appliedSharePercent": round(100 * len(single_day) / len(applied), 2),
            "allEmphasisDialogue": True,
            "questionableOrdinaryTrailingPhraseCount": sum(
                row["manualAssessment"] == "questionable_ordinary_trailing_phrase"
                for row in occurrences
            ),
            "occurrences": occurrences,
        },
        "outline": {
            "policy": "outline_required_for_every_applied_decision",
            "appliedCount": len(applied),
            "allAppliedWidthScaleExactlyOne": True,
            "zeroWidthAppliedCount": sum(scale == 0 for scale in outline_scales),
            "minimumContrastRatio": min_contrast,
            "minimumContrastRatioRounded3": round(min_contrast, 3),
            "visualOutlineLossCount": 0,
            "visualOutlineLossPages": [],
            "darkBackgroundWhiteTextOutlinePreservedPages": [19, 25, 40],
        },
    }


def page_reviews(
    report_pages: Sequence[Mapping[str, Any]],
    index_pages: Sequence[Mapping[str, Any]],
    review_root: Path,
) -> list[dict[str, Any]]:
    by_number: dict[int, Mapping[str, Any]] = {}
    for index_page in index_pages:
        if not isinstance(index_page, dict):
            raise ManualVisualReviewError("Visual-review page is not an object.")
        number = require_int(index_page.get("pageNumber"), "visual pageNumber", 1)
        if number in by_number:
            raise ManualVisualReviewError(f"Duplicate visual-review page {number}.")
        by_number[number] = index_page
    if set(by_number) != set(range(1, 41)):
        raise ManualVisualReviewError("Visual-review page numbers are not exactly 1..40.")

    reviews: list[dict[str, Any]] = []
    for page_number, report_page in enumerate(report_pages, start=1):
        index_page = by_number[page_number]
        for key, expected in (
            ("selectionIndex", page_number - 1),
            ("sourcePageId", report_page["sourcePageId"]),
            ("blockCount", report_page["blockCount"]),
        ):
            if index_page.get(key) != expected:
                raise ManualVisualReviewError(f"Visual page {page_number} {key} drifted.")
        pair = index_page.get("pagePair")
        if not isinstance(pair, dict) or pair.get("kind") != "page_pair_png":
            raise ManualVisualReviewError(f"Visual page {page_number} pagePair is missing.")
        relative = require_string(pair.get("path"), "pagePair path")
        pair_path = (review_root / relative).resolve(strict=True)
        try:
            pair_path.relative_to(review_root)
        except ValueError as exc:
            raise ManualVisualReviewError(f"Page pair escapes review root: {relative}") from exc
        pair_binding = file_binding(pair_path, "page_pair_png")
        if pair_binding["sha256"] != pair.get("sha256") or pair_binding["size"] != pair.get("size"):
            raise ManualVisualReviewError(f"Visual page {page_number} pagePair binding drifted.")
        verdict = verdict_for_page(page_number)
        block_count = require_int(report_page.get("blockCount"), "blockCount")
        if (verdict == "not_applicable") != (block_count == 0):
            raise ManualVisualReviewError(
                f"Page {page_number} N/A verdict does not match zero-block applicability."
            )
        reviews.append(
            {
                "pageNumber": page_number,
                "selectionIndex": page_number - 1,
                "sourcePageId": report_page["sourcePageId"],
                "sourcePageName": report_page.get("sourcePageName"),
                "workId": report_page.get("workId"),
                "chapterId": report_page.get("chapterId"),
                "blockCount": block_count,
                "pagePair": {
                    "path": relative,
                    "sha256": pair_binding["sha256"],
                    "size": pair_binding["size"],
                    "width": pair.get("width"),
                    "height": pair.get("height"),
                },
                "verdict": verdict,
                "includedInTranslatedPageDenominator": verdict != "not_applicable",
                "manualNotes": PAGE_NOTES.get(page_number, []),
            }
        )
    return reviews


def aggregate_page_reviews(reviews: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    counts = Counter(require_string(row.get("verdict"), "page verdict") for row in reviews)
    expected_counts = {"not_applicable": 4, "good": 16, "acceptable": 13, "bad": 7}
    if dict(counts) != expected_counts:
        raise ManualVisualReviewError(f"Fixed page verdict counts drifted: {dict(counts)}")
    translated = len(reviews) - counts["not_applicable"]
    usable = counts["good"] + counts["acceptable"]
    return {
        "reviewedPages": len(reviews),
        "notApplicablePages": counts["not_applicable"],
        "translatedPages": translated,
        "verdictCounts": {
            "good": counts["good"],
            "acceptable": counts["acceptable"],
            "bad": counts["bad"],
            "notApplicable": counts["not_applicable"],
        },
        "translatedPageRates": {
            "goodPercent": round(100 * counts["good"] / translated, 2),
            "acceptablePercent": round(100 * counts["acceptable"] / translated, 2),
            "badPercent": round(100 * counts["bad"] / translated, 2),
            "usableGoodOrAcceptableCount": usable,
            "usableGoodOrAcceptablePercent": round(100 * usable / translated, 2),
        },
    }


def build_review(report_path: Path, visual_review_dir: Path) -> dict[str, Any]:
    validate_fixed_verdict_partition()
    try:
        report_resolved = report_path.resolve(strict=True)
        review_root = visual_review_dir.resolve(strict=True)
    except OSError as exc:
        raise ManualVisualReviewError(f"Missing review input: {exc}") from exc
    if not review_root.is_dir():
        raise ManualVisualReviewError(f"Visual-review path is not a directory: {review_root}")

    try:
        visual_validation = visual_review.validate_review(review_root)
    except visual_review.ReviewError as exc:
        raise ManualVisualReviewError(f"Visual-review pack validation failed: {exc}") from exc
    if visual_validation.get("pages") != 40 or visual_validation.get("blocks") != EXPECTED_TOTAL_BLOCKS:
        raise ManualVisualReviewError("Visual-review validator returned unexpected coverage.")

    report = read_json(report_resolved, "run report")
    report_pages = validate_run(report)
    index_path = review_root / "visual-review-index.json"
    index_seal_path = review_root / "visual-review-index.sha256"
    block_rows_path = review_root / "block-review.jsonl"
    index = read_json(index_path, "visual-review index")
    index_pages = validate_visual_index(index, report_resolved, report)
    rows = read_jsonl(block_rows_path, "block-review")
    if index.get("blockReviewRows") != len(rows):
        raise ManualVisualReviewError("Visual-review index blockReviewRows drifted.")
    validate_block_rows(report_pages, rows)

    reviews = page_reviews(report_pages, index_pages, review_root)
    diagnostics = decision_diagnostics(report_pages)
    report_binding = file_binding(report_resolved, "run_report_json")
    index_binding = file_binding(index_path, "visual_review_index_json")
    index_seal_binding = file_binding(index_seal_path, "visual_review_index_sha256")
    block_binding = file_binding(block_rows_path, "block_review_jsonl")

    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "recordType": RECORD_TYPE,
        "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
        "reviewStatus": "completed_direct_manual_visual_review",
        "reviewProtocol": {
            "reviewer": "root_codex_agent",
            "inspectionMethod": "direct_visual_inspection_of_all_page_pair_pngs",
            "imageDetail": "original",
            "inspectedPagePairCount": 40,
            "verdictVocabulary": ["good", "acceptable", "bad", "not_applicable"],
            "blockLevelFontLabelsCreated": False,
        },
        "authority": dict(AUTHORITY),
        "sourceRun": {
            "report": report_binding,
            "identity": {
                "runId": report["runId"],
                "cohort": report["cohort"],
                "cohortDigest": report["cohortDigest"],
                "candidateId": report["candidateId"],
                "provider": report["provider"],
                "targetLanguage": report["targetLanguage"],
                "pageCount": report["pageCount"],
                "cacheFrom": report["cacheFrom"],
                "qaPageRelativeRoleReroute": report["qaPageRelativeRoleReroute"],
            },
        },
        "sourceVisualReview": {
            "directory": str(review_root),
            "index": index_binding,
            "indexSeal": index_seal_binding,
            "blockReview": block_binding,
            "bindingSha256": index["bindingSha256"],
            "inspectionAssets": index["inspectionAssets"],
            "validation": visual_validation,
        },
        "pageReviews": reviews,
        "summary": aggregate_page_reviews(reviews),
        "diagnostics": diagnostics,
        "qualitativeFindings": {
            "layoutOrCoverMismatchPages": [1, 4, 16],
            "fontOrLayoutConsistencyFailurePages": [17, 26, 30, 32],
            "page30": "same_narration_context_received_arbitrarily_mixed_fonts_including_brush_like_face",
            "page32": "severe_weight_and_placement_mismatch",
            "outline": "no_visible_outline_loss_across_all_40_inspected_page_pairs",
            "singleDay": "four_reaction_or_soundish_uses_appropriate_or_defensible;_page19_trailing_ordinary_phrase_questionable",
            "roleDistribution": "emphasis_dialogue_233_of_317_indicates_remaining_role_head_collapse",
        },
    }
    result["contentSha256"] = sha256_bytes(canonical_json_bytes(result))
    return result


def write_json_exclusive(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    try:
        with path.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
    except FileExistsError as exc:
        raise ManualVisualReviewError(f"Refusing to overwrite existing output: {path}") from exc


def seal_review(report_path: Path, visual_review_dir: Path, output: Path) -> dict[str, Any]:
    output_resolved = output.resolve(strict=False)
    seal_path = Path(f"{output_resolved}{SEAL_SUFFIX}")
    if output_resolved.exists() or seal_path.exists():
        raise ManualVisualReviewError(
            f"Refusing to overwrite existing review or seal: {output_resolved}"
        )
    review = build_review(report_path, visual_review_dir)
    write_json_exclusive(output_resolved, review)
    digest = sha256_file(output_resolved)
    try:
        with seal_path.open("x", encoding="ascii", newline="\n") as handle:
            handle.write(f"{digest}  {output_resolved.name}\n")
    except FileExistsError as exc:
        raise ManualVisualReviewError(f"Refusing to overwrite existing seal: {seal_path}") from exc
    return {
        "ok": True,
        "reviewPath": str(output_resolved),
        "sealPath": str(seal_path),
        "reviewSha256": digest,
        "contentSha256": review["contentSha256"],
        "pages": review["summary"]["reviewedPages"],
        "translatedPages": review["summary"]["translatedPages"],
        "usablePages": review["summary"]["translatedPageRates"]["usableGoodOrAcceptableCount"],
    }


def validate_sealed_review(review_path: Path) -> dict[str, Any]:
    try:
        resolved = review_path.resolve(strict=True)
    except OSError as exc:
        raise ManualVisualReviewError(f"Missing sealed review: {review_path}: {exc}") from exc
    seal_path = Path(f"{resolved}{SEAL_SUFFIX}")
    if not seal_path.is_file():
        raise ManualVisualReviewError(f"Missing SHA-256 seal: {seal_path}")
    try:
        parts = seal_path.read_text(encoding="ascii").strip().split()
    except (OSError, UnicodeError) as exc:
        raise ManualVisualReviewError(f"Could not read SHA-256 seal: {exc}") from exc
    digest = sha256_file(resolved)
    if len(parts) != 2 or parts[0] != digest or parts[1] != resolved.name:
        raise ManualVisualReviewError("Review does not match its SHA-256 seal.")
    recorded = read_json(resolved, "sealed manual visual review")
    if recorded.get("schemaVersion") != SCHEMA_VERSION or recorded.get("recordType") != RECORD_TYPE:
        raise ManualVisualReviewError("Unsupported sealed review schema/record type.")
    if recorded.get("tool") != {"id": TOOL_ID, "version": TOOL_VERSION}:
        raise ManualVisualReviewError("Unsupported sealed review tool version.")
    content_sha = recorded.get("contentSha256")
    without_content_sha = {key: value for key, value in recorded.items() if key != "contentSha256"}
    if content_sha != sha256_bytes(canonical_json_bytes(without_content_sha)):
        raise ManualVisualReviewError("Review contentSha256 is invalid.")
    if recorded.get("authority") != AUTHORITY:
        raise ManualVisualReviewError("Evaluation-only authority policy drifted.")
    source_run = recorded.get("sourceRun")
    source_visual = recorded.get("sourceVisualReview")
    if not isinstance(source_run, dict) or not isinstance(source_visual, dict):
        raise ManualVisualReviewError("Sealed source bindings are missing.")
    report_binding = source_run.get("report")
    if not isinstance(report_binding, dict):
        raise ManualVisualReviewError("Sealed run-report binding is missing.")
    rebuilt = build_review(
        Path(require_string(report_binding.get("path"), "sealed report path")),
        Path(require_string(source_visual.get("directory"), "sealed visual-review directory")),
    )
    if rebuilt != recorded:
        raise ManualVisualReviewError("Sealed review no longer matches strict reconstruction.")
    return {
        "ok": True,
        "reviewPath": str(resolved),
        "sealPath": str(seal_path),
        "reviewSha256": digest,
        "contentSha256": content_sha,
        "pages": rebuilt["summary"]["reviewedPages"],
        "translatedPages": rebuilt["summary"]["translatedPages"],
        "usablePages": rebuilt["summary"]["translatedPageRates"]["usableGoodOrAcceptableCount"],
        "blocks": rebuilt["diagnostics"]["blocks"]["total"],
        "singleDayApplied": rebuilt["diagnostics"]["singleDay"]["appliedCount"],
        "outlineLoss": rebuilt["diagnostics"]["outline"]["visualOutlineLossCount"],
    }


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    seal = commands.add_parser("seal", help="Build and hash-seal a new manual review artifact.")
    seal.add_argument("--run-report", type=Path, required=True)
    seal.add_argument("--visual-review-dir", type=Path, required=True)
    seal.add_argument("--output", type=Path, required=True)
    validate = commands.add_parser("validate", help="Re-hash and reconstruct a sealed review.")
    validate.add_argument("--review", type=Path, required=True)
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "seal":
            result = seal_review(args.run_report, args.visual_review_dir, args.output)
        else:
            result = validate_sealed_review(args.review)
    except (ManualVisualReviewError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
