#!/usr/bin/env python3
"""Seal the direct page-level review of the work-disjoint v11 Gemma run.

The artifact produced here is immutable, evaluation-only evidence.  It binds
the exact completed run report and the already sealed visual-review pack.  It
cannot create human-gold labels or grant training, calibration, pseudo-label,
promotion, or release authority.
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


TOOL_ID = "manga-library-v11-work-disjoint-manual-visual-review-sealer"
TOOL_VERSION = "1.0.0"
SCHEMA_VERSION = 1
RECORD_TYPE = "manga_library_full_pipeline_manual_visual_review"
REPORT_NAME = "manual-visual-review.json"
SEAL_SUFFIX = ".sha256"

EXPECTED_RUN = {
    "schemaVersion": 1,
    "status": "completed",
    "runId": "full-gemma-20260811-r1",
    "cohort": "baseline40",
    "cohortDigest": "9c1ddde045ab0ddbad1e86fa30c20b869a112a9405eddbe404b0d1292686f5d2",
    "candidateId": "r3h-v11-work-disjoint-fresh-gemma-v1",
    "provider": "gemma",
    "targetLanguage": "ko",
    "pageCount": 40,
    "cacheFrom": None,
    "qaPageRelativeRoleReroute": False,
}
EXPECTED_RUN_REPORT = {
    "size": 1_442_691,
    "sha256": "61570016f17039e982c05afb066c92bf649a5ac837d3e8254b847b96bb2d11cb",
}
EXPECTED_VISUAL_INDEX = {
    "size": 284_144,
    "sha256": "5155436a1bf25e2e5694c4cc88d1f65092245e6bc80743484e604ef7984593ad",
}
EXPECTED_VISUAL_INDEX_SEAL = {
    "size": 91,
    "sha256": "8e34915d3ffbf641458ea0f0c6545535c28e79bf2a32d2808f91e6c1839053f3",
}
EXPECTED_BLOCK_REVIEW = {
    "size": 956_750,
    "sha256": "8180c745b7ee832d1ca01065669c9574880b95fd41254fa360511d60406d7e46",
}
EXPECTED_VISUAL_BINDING_SHA256 = (
    "dda39004aaa34a6f2b3c38e8a6b4f7157c6b21eeb28c4552346027a513bd00a2"
)
EXPECTED_PAGES = 40
EXPECTED_BLOCKS = 375
EXPECTED_APPLIED = 337
EXPECTED_INSPECTION_ASSETS = 116

PAGE_VERDICTS = {
    "not_applicable": frozenset((1, 6, 10, 11, 14, 15, 23, 28, 31, 39)),
    "good": frozenset((7, 12, 13, 16, 19, 21, 26, 33, 34, 38)),
    "acceptable": frozenset((4, 5, 8, 9, 17, 18, 20, 22, 24, 27, 29, 32, 35, 37, 40)),
    "bad": frozenset((2, 3, 25, 30, 36)),
}

BAD_PAGE_REASONS = {
    2: "ordinary_dialogue_over_bold_and_page_font_choices_inconsistent",
    3: "ordinary_dialogue_over_bold_and_page_font_choices_inconsistent",
    25: "narration_dialogue_family_and_weight_inconsistent",
    30: "serious_source_tone_underweighted",
    36: "mixed_editorial_dialogue_clutter_and_weight_mismatch",
}

EXPECTED_ROLE_COUNTS = {
    "dialogue": 78,
    "emphasis_dialogue": 273,
    "narration": 1,
    "sfx_emotion": 2,
    "sfx_impact": 1,
    "sfx_motion": 2,
    "shout": 5,
    "sign_ui_title": 9,
    "thought": 4,
}
EXPECTED_SELECTED_FONT_COUNTS = {
    "__not_selected__": 38,
    "black-and-white-picture": 1,
    "black-han-sans": 14,
    "chosun-gungseo": 2,
    "dohyeon": 79,
    "gaegu": 4,
    "griun-pol-sensibility": 41,
    "jua": 13,
    "kirang-haerang": 1,
    "mongtori": 30,
    "nanum-barun-gothic": 15,
    "nanum-brush-script": 8,
    "nanum-gothic": 12,
    "nanum-myeongjo": 32,
    "ridi-batang": 76,
    "seoul-namsan": 4,
    "single-day": 4,
    "start-over": 1,
}
EXPECTED_SINGLE_DAY_KEYS = ((4, 7), (9, 7), (18, 10), (29, 10))

AUTHORITY = {
    "mode": "evaluation_only",
    "evaluation_only": True,
    "human_gold": False,
    "manual_visual_review_only": True,
    "training": False,
    "training_label_authority": False,
    "calibration": False,
    "calibration_label_authority": False,
    "pseudo_labeling": False,
    "pseudo_label_authority": False,
    "automatic_label_promotion": False,
    "release": False,
    "release_authority": False,
    "automatic_release_authority": False,
    "allowed_uses": ["evaluation", "manual_visual_review"],
}


class ManualVisualReviewError(RuntimeError):
    """Raised when evidence cannot reproduce the fixed review."""


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


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManualVisualReviewError(f"{label} must be a non-empty string.")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManualVisualReviewError(f"{label} must be an integer >= {minimum}.")
    return value


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ManualVisualReviewError(f"Could not read {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ManualVisualReviewError(f"{label} must be a JSON object: {path}")
    return value


def read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ManualVisualReviewError(f"Could not read {label} {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ManualVisualReviewError(
                f"Invalid {label} JSON at {path}:{line_number}: {exc}"
            ) from exc
        if not isinstance(row, dict):
            raise ManualVisualReviewError(
                f"{label} row must be an object at {path}:{line_number}."
            )
        rows.append(row)
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


def require_exact_binding(
    binding: Mapping[str, Any], expected: Mapping[str, Any], label: str
) -> None:
    for key in ("size", "sha256"):
        if binding.get(key) != expected[key]:
            raise ManualVisualReviewError(
                f"{label} {key} drifted: expected {expected[key]!r}, "
                f"got {binding.get(key)!r}."
            )


def verdict_for_page(page_number: int) -> str:
    matches = [name for name, pages in PAGE_VERDICTS.items() if page_number in pages]
    if len(matches) != 1:
        raise ManualVisualReviewError(
            f"Page {page_number} must have exactly one verdict, got {matches}."
        )
    return matches[0]


def reason_for_page(page_number: int) -> str:
    verdict = verdict_for_page(page_number)
    if verdict == "not_applicable":
        return "cover_or_editorial_page_excluded_from_body_font_quality_denominator"
    if verdict == "good":
        return "source_role_and_weight_well_preserved_overall"
    if verdict == "acceptable":
        return "directionally_matched_with_minor_weight_or_consistency_variance"
    try:
        return BAD_PAGE_REASONS[page_number]
    except KeyError as exc:  # pragma: no cover - protected by partition validation
        raise ManualVisualReviewError(f"Missing fixed reason for bad page {page_number}.") from exc


def validate_fixed_review() -> None:
    flattened = [page for pages in PAGE_VERDICTS.values() for page in pages]
    if len(flattened) != EXPECTED_PAGES or set(flattened) != set(range(1, 41)):
        raise ManualVisualReviewError("Fixed verdicts do not partition pages 1..40.")
    if set(BAD_PAGE_REASONS) != set(PAGE_VERDICTS["bad"]):
        raise ManualVisualReviewError("Bad-page reasons do not match bad verdict pages.")
    for page_number in range(1, 41):
        require_string(reason_for_page(page_number), f"page {page_number} reason")


def validate_run(report: Mapping[str, Any]) -> list[dict[str, Any]]:
    for key, expected in EXPECTED_RUN.items():
        if report.get(key) != expected:
            raise ManualVisualReviewError(
                f"Run field {key} drifted: expected {expected!r}, got {report.get(key)!r}."
            )
    pages = report.get("pages")
    if not isinstance(pages, list) or len(pages) != EXPECTED_PAGES:
        raise ManualVisualReviewError("Run must contain exactly 40 pages.")
    seen_ids: set[str] = set()
    total_blocks = 0
    normalized: list[dict[str, Any]] = []
    for offset, raw_page in enumerate(pages):
        if not isinstance(raw_page, dict):
            raise ManualVisualReviewError(f"Run page {offset + 1} is not an object.")
        if raw_page.get("selectionIndex") != offset:
            raise ManualVisualReviewError(f"Run page {offset + 1} selectionIndex drifted.")
        if raw_page.get("status") != "completed" or raw_page.get("stage") != "done":
            raise ManualVisualReviewError(f"Run page {offset + 1} is incomplete.")
        page_id = require_string(raw_page.get("sourcePageId"), "sourcePageId")
        if page_id in seen_ids:
            raise ManualVisualReviewError(f"Duplicate sourcePageId: {page_id}")
        seen_ids.add(page_id)
        decisions = raw_page.get("fontDecisions")
        if not isinstance(decisions, list):
            raise ManualVisualReviewError(f"Page {offset + 1} fontDecisions is not a list.")
        if raw_page.get("blockCount") != len(decisions):
            raise ManualVisualReviewError(f"Page {offset + 1} blockCount drifted.")
        total_blocks += len(decisions)
        normalized.append(raw_page)
    if total_blocks != EXPECTED_BLOCKS:
        raise ManualVisualReviewError(
            f"Expected {EXPECTED_BLOCKS} blocks, got {total_blocks}."
        )
    return normalized


def validate_block_rows(
    report_pages: Sequence[Mapping[str, Any]], rows: Sequence[Mapping[str, Any]]
) -> None:
    expected: list[tuple[int, Mapping[str, Any]]] = []
    for page_number, page in enumerate(report_pages, start=1):
        for decision in page["fontDecisions"]:
            if not isinstance(decision, dict):
                raise ManualVisualReviewError(
                    f"Page {page_number} contains a non-object font decision."
                )
            expected.append((page_number, decision))
    if len(rows) != EXPECTED_BLOCKS or len(rows) != len(expected):
        raise ManualVisualReviewError(
            f"Block-review row count drifted: expected {len(expected)}, got {len(rows)}."
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
    for offset, (row, (page_number, decision)) in enumerate(zip(rows, expected)):
        if row.get("pageNumber") != page_number:
            raise ManualVisualReviewError(f"Block-review row {offset} pageNumber drifted.")
        for field in fields:
            if row.get(field) != decision.get(field):
                raise ManualVisualReviewError(
                    f"Block-review row {offset} field {field} drifted."
                )


def decision_diagnostics(report_pages: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    decisions: list[dict[str, Any]] = []
    for page_number, page in enumerate(report_pages, start=1):
        for raw in page["fontDecisions"]:
            row = dict(raw)
            row["_pageNumber"] = page_number
            decisions.append(row)
    applied = [row for row in decisions if row.get("applied") is True]
    roles = Counter(require_string(row.get("role"), "font decision role") for row in decisions)
    fonts = Counter(row.get("selectedFontId") or "__not_selected__" for row in decisions)
    if len(decisions) != EXPECTED_BLOCKS or len(applied) != EXPECTED_APPLIED:
        raise ManualVisualReviewError(
            f"Decision coverage drifted: total={len(decisions)}, applied={len(applied)}."
        )
    if dict(sorted(roles.items())) != EXPECTED_ROLE_COUNTS:
        raise ManualVisualReviewError(f"Role distribution drifted: {dict(roles)}")
    if dict(sorted(fonts.items())) != EXPECTED_SELECTED_FONT_COUNTS:
        raise ManualVisualReviewError(f"Selected-font distribution drifted: {dict(fonts)}")
    if any((row.get("selectedFontId") is not None) != (row.get("applied") is True) for row in decisions):
        raise ManualVisualReviewError("Selected/applied identity drifted.")

    outline_widths: list[float] = []
    outline_contrasts: list[float] = []
    for row in applied:
        width = row.get("effectiveOutlineWidthScale")
        contrast = row.get("effectiveOutlineContrastRatio")
        for value, label in ((width, "outline width"), (contrast, "outline contrast")):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            ):
                raise ManualVisualReviewError(f"Applied decision has invalid {label}.")
        outline_widths.append(float(width))
        outline_contrasts.append(float(contrast))
    if any(width != 1.0 for width in outline_widths):
        raise ManualVisualReviewError("An applied decision lost outline width scale 1.")

    single_day = [
        row
        for row in applied
        if row.get("selectedFontId") == "single-day"
        or row.get("effectiveFontFamily") == "single-day"
    ]
    keys = tuple((row["_pageNumber"], row.get("blockIndex")) for row in single_day)
    if keys != EXPECTED_SINGLE_DAY_KEYS:
        raise ManualVisualReviewError(f"Single Day occurrence set drifted: {keys}.")
    occurrences = [
        {
            "pageNumber": row["_pageNumber"],
            "blockIndex": row.get("blockIndex"),
            "blockId": row.get("blockId"),
            "role": row.get("role"),
            "selectedFontId": row.get("selectedFontId"),
            "effectiveFontFamily": row.get("effectiveFontFamily"),
        }
        for row in single_day
    ]
    return {
        "blocks": {
            "total": len(decisions),
            "applied": len(applied),
            "notApplied": len(decisions) - len(applied),
            "applyRatePercent": round(100 * len(applied) / len(decisions), 2),
        },
        "roles": {
            "counts": dict(sorted(roles.items())),
            "emphasisDialogueCount": roles["emphasis_dialogue"],
            "emphasisDialogueSharePercent": round(
                100 * roles["emphasis_dialogue"] / len(decisions), 2
            ),
        },
        "selectedFonts": {
            "counts": dict(sorted(fonts.items())),
            "selectedFamilyCount": len(fonts) - ("__not_selected__" in fonts),
        },
        "singleDay": {
            "appliedCount": len(single_day),
            "appliedDenominator": len(applied),
            "appliedSharePercent": round(100 * len(single_day) / len(applied), 2),
            "occurrences": occurrences,
            "manualFinding": "not_the_primary_visual_failure_in_this_review",
        },
        "outline": {
            "appliedCount": len(applied),
            "allAppliedWidthScaleExactlyOne": True,
            "minimumContrastRatio": min(outline_contrasts),
            "minimumContrastRatioRounded3": round(min(outline_contrasts), 3),
            "visualOutlineLossCount": 0,
            "visualOutlineLossPages": [],
            "manualFinding": "no_observed_outline_loss",
        },
    }


def page_reviews(
    report_pages: Sequence[Mapping[str, Any]],
    index_pages: Sequence[Mapping[str, Any]],
    review_root: Path,
) -> list[dict[str, Any]]:
    by_number: dict[int, Mapping[str, Any]] = {}
    for raw in index_pages:
        if not isinstance(raw, dict):
            raise ManualVisualReviewError("Visual-review page is not an object.")
        page_number = require_int(raw.get("pageNumber"), "pageNumber", 1)
        if page_number in by_number:
            raise ManualVisualReviewError(f"Duplicate visual page {page_number}.")
        by_number[page_number] = raw
    if set(by_number) != set(range(1, 41)):
        raise ManualVisualReviewError("Visual page numbers are not exactly 1..40.")

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
            raise ManualVisualReviewError(f"Visual page {page_number} page pair is missing.")
        relative = require_string(pair.get("path"), "page pair path")
        try:
            pair_path = (review_root / relative).resolve(strict=True)
            pair_path.relative_to(review_root)
        except (OSError, ValueError) as exc:
            raise ManualVisualReviewError(
                f"Page pair is missing or escapes the review root: {relative}"
            ) from exc
        binding = file_binding(pair_path, "page_pair_png")
        if binding["size"] != pair.get("size") or binding["sha256"] != pair.get("sha256"):
            raise ManualVisualReviewError(f"Visual page {page_number} page-pair binding drifted.")
        verdict = verdict_for_page(page_number)
        reviews.append(
            {
                "pageNumber": page_number,
                "selectionIndex": page_number - 1,
                "sourcePageId": report_page["sourcePageId"],
                "sourcePageName": report_page.get("sourcePageName"),
                "workId": report_page.get("workId"),
                "chapterId": report_page.get("chapterId"),
                "blockCount": report_page["blockCount"],
                "pagePair": {
                    "path": relative,
                    "size": binding["size"],
                    "sha256": binding["sha256"],
                    "width": pair.get("width"),
                    "height": pair.get("height"),
                },
                "verdict": verdict,
                "includedInBodyFontQualityDenominator": verdict != "not_applicable",
                "reason": reason_for_page(page_number),
            }
        )
    return reviews


def aggregate_page_reviews(reviews: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    counts = Counter(require_string(row.get("verdict"), "page verdict") for row in reviews)
    expected = {"acceptable": 15, "bad": 5, "good": 10, "not_applicable": 10}
    if dict(sorted(counts.items())) != expected:
        raise ManualVisualReviewError(f"Fixed verdict counts drifted: {dict(counts)}")
    judged = len(reviews) - counts["not_applicable"]
    usable = counts["good"] + counts["acceptable"]
    return {
        "reviewedPages": len(reviews),
        "notApplicablePages": counts["not_applicable"],
        "bodyFontQualityJudgedPages": judged,
        "verdictCounts": {
            "good": counts["good"],
            "acceptable": counts["acceptable"],
            "bad": counts["bad"],
            "notApplicable": counts["not_applicable"],
        },
        "judgedPageRates": {
            "goodPercent": round(100 * counts["good"] / judged, 2),
            "acceptablePercent": round(100 * counts["acceptable"] / judged, 2),
            "badPercent": round(100 * counts["bad"] / judged, 2),
            "usableGoodOrAcceptableCount": usable,
            "usableGoodOrAcceptablePercent": round(100 * usable / judged, 2),
        },
    }


def build_review(report_path: Path, visual_review_dir: Path) -> dict[str, Any]:
    validate_fixed_review()
    try:
        report_resolved = report_path.resolve(strict=True)
        review_root = visual_review_dir.resolve(strict=True)
    except OSError as exc:
        raise ManualVisualReviewError(f"Missing source evidence: {exc}") from exc
    if not review_root.is_dir():
        raise ManualVisualReviewError(f"Visual-review path is not a directory: {review_root}")

    report_binding = file_binding(report_resolved, "run_report_json")
    require_exact_binding(report_binding, EXPECTED_RUN_REPORT, "run report")
    index_path = review_root / "visual-review-index.json"
    index_seal_path = review_root / "visual-review-index.sha256"
    block_rows_path = review_root / "block-review.jsonl"
    index_binding = file_binding(index_path, "visual_review_index_json")
    index_seal_binding = file_binding(index_seal_path, "visual_review_index_sha256")
    block_binding = file_binding(block_rows_path, "block_review_jsonl")
    require_exact_binding(index_binding, EXPECTED_VISUAL_INDEX, "visual-review index")
    require_exact_binding(index_seal_binding, EXPECTED_VISUAL_INDEX_SEAL, "visual-review index seal")
    require_exact_binding(block_binding, EXPECTED_BLOCK_REVIEW, "block-review inventory")

    try:
        visual_validation = visual_review.validate_review(review_root)
    except visual_review.ReviewError as exc:
        raise ManualVisualReviewError(f"Visual-review validation failed: {exc}") from exc
    expected_validation = {
        "ok": True,
        "pages": EXPECTED_PAGES,
        "blocks": EXPECTED_BLOCKS,
        "inspectionAssets": EXPECTED_INSPECTION_ASSETS,
        "candidateId": EXPECTED_RUN["candidateId"],
        "cohort": EXPECTED_RUN["cohort"],
        "bindingSha256": EXPECTED_VISUAL_BINDING_SHA256,
        "indexSha256": EXPECTED_VISUAL_INDEX["sha256"],
    }
    if visual_validation != expected_validation:
        raise ManualVisualReviewError(
            f"Visual-review validation summary drifted: {visual_validation}"
        )

    report = read_json(report_resolved, "run report")
    report_pages = validate_run(report)
    index = read_json(index_path, "visual-review index")
    if index.get("bindingSha256") != EXPECTED_VISUAL_BINDING_SHA256:
        raise ManualVisualReviewError("Visual-review bindingSha256 drifted.")
    index_pages = index.get("pages")
    if not isinstance(index_pages, list) or len(index_pages) != EXPECTED_PAGES:
        raise ManualVisualReviewError("Visual-review index must contain 40 pages.")
    rows = read_jsonl(block_rows_path, "block-review")
    if index.get("blockReviewRows") != EXPECTED_BLOCKS:
        raise ManualVisualReviewError("Visual-review blockReviewRows drifted.")
    validate_block_rows(report_pages, rows)

    reviews = page_reviews(report_pages, index_pages, review_root)
    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "recordType": RECORD_TYPE,
        "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
        "reviewStatus": "completed_direct_manual_visual_review",
        "reviewProtocol": {
            "reviewer": "root_codex_agent",
            "inspectionMethod": "direct_visual_inspection_of_all_page_pair_pngs",
            "imageDetail": "original",
            "inspectedPagePairCount": EXPECTED_PAGES,
            "blockLevelFontLabelsCreated": False,
            "verdictVocabulary": ["good", "acceptable", "bad", "not_applicable"],
        },
        "authority": dict(AUTHORITY),
        "sourceRun": {
            "report": report_binding,
            "identity": {key: report[key] for key in EXPECTED_RUN},
        },
        "sourceVisualReview": {
            "directory": str(review_root),
            "index": index_binding,
            "indexSeal": index_seal_binding,
            "blockReview": block_binding,
            "bindingSha256": EXPECTED_VISUAL_BINDING_SHA256,
            "validation": visual_validation,
        },
        "pageReviews": reviews,
        "summary": aggregate_page_reviews(reviews),
        "diagnostics": decision_diagnostics(report_pages),
        "qualitativeFindings": {
            "ordinaryToHeavyErrors": "repeated_errors_observed",
            "strongToThinErrors": "repeated_errors_observed",
            "pageConsistency": "varies_across_pages",
            "outline": "no_observed_outline_loss",
            "singleDay": "not_the_primary_visual_failure",
            "badPages": {
                str(page_number): reason
                for page_number, reason in sorted(BAD_PAGE_REASONS.items())
            },
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
        "judgedPages": review["summary"]["bodyFontQualityJudgedPages"],
        "blocks": review["diagnostics"]["blocks"]["total"],
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
        "judgedPages": rebuilt["summary"]["bodyFontQualityJudgedPages"],
        "verdictCounts": rebuilt["summary"]["verdictCounts"],
        "blocks": rebuilt["diagnostics"]["blocks"]["total"],
        "applied": rebuilt["diagnostics"]["blocks"]["applied"],
        "singleDayApplied": rebuilt["diagnostics"]["singleDay"]["appliedCount"],
        "outlineLoss": rebuilt["diagnostics"]["outline"]["visualOutlineLossCount"],
    }


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    seal = commands.add_parser("seal", help="Build and hash-seal a new manual review.")
    seal.add_argument("--run-report", type=Path, required=True)
    seal.add_argument("--visual-review-dir", type=Path, required=True)
    seal.add_argument("--output", type=Path, required=True)
    validate = commands.add_parser("validate", help="Rebuild and validate a sealed review.")
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
