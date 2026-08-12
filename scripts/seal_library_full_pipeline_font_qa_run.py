#!/usr/bin/env python3
"""Strictly validate and seal one completed library full-pipeline font QA run.

The visual-review pack proves that all review images and decision rows remain
bound to a completed run.  This companion seal proves the execution mode that
produced the run:

* ``fresh-gemma-full`` requires a 40-page, uncached Gemma full-pipeline run;
* ``live-font-replay`` requires a cache-backed replay whose font inference was
  recomputed live for every page (cached font inference is forbidden); and
* both profiles bind every source, cleaned, rendered, font-input, and
  font-inference artifact while aggregating outline and Single Day diagnostics.

The resulting artifact is evaluation-only.  It explicitly forbids using the
run, its decisions, or its review metadata as training/calibration labels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from PIL import Image

try:
    from scripts import build_library_font_qa_visual_review as visual_review
    from scripts import font_decision_outline_policy as outline_policy
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_library_font_qa_visual_review as visual_review
    import font_decision_outline_policy as outline_policy


TOOL_ID = "manga-library-full-pipeline-font-qa-run-seal"
TOOL_VERSION = "1.1.0"
SCHEMA_VERSION = 1
EXPECTED_PAGES = 40
PROFILE_FRESH_GEMMA_FULL = "fresh-gemma-full"
PROFILE_LIVE_FONT_REPLAY = "live-font-replay"
PROFILES = (PROFILE_FRESH_GEMMA_FULL, PROFILE_LIVE_FONT_REPLAY)
BODY_ROLES = frozenset(("dialogue", "narration", "thought"))
VALID_FONT_ROLES = frozenset(
    (
        "dialogue",
        "narration",
        "thought",
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
        "other",
    )
)
SINGLE_DAY_FONT_ID = "single-day"
SEAL_SUFFIX = ".sha256"
SOURCE_BOUNDARY_POLICY = (
    "exclude every source page referenced by the supplied training, validation, "
    "test, calibration, or labeling manifests"
)
WORK_BOUNDARY_POLICY = (
    "exclude every library page belonging to a work referenced by a supplied "
    "work-boundary JSON or JSONL record"
)
V11_SOURCE_BOUNDARY_POLICY = (
    "exclude sealed prior-QA and labeling source page ids, normalized paths, "
    "and source-page SHA-256 values"
)
V11_WORK_BOUNDARY_POLICY = "exclude the exact master-v3 train/val/test work union"
BOUNDARY_POLICY_PAIRS = frozenset(
    (
        (SOURCE_BOUNDARY_POLICY, WORK_BOUNDARY_POLICY),
        (V11_SOURCE_BOUNDARY_POLICY, V11_WORK_BOUNDARY_POLICY),
    )
)
EVALUATION_INFERENCE_BOUNDARY = {
    "source": "user_page",
    "datasetSplit": None,
    "qaOverlay": False,
}


class RunSealError(RuntimeError):
    """Raised when the completed run cannot satisfy the requested profile."""


@dataclass(frozen=True)
class SealOptions:
    report_path: Path
    profile: str
    expected_pages: int = EXPECTED_PAGES
    expected_candidate_id: str | None = None
    expected_cache_from: Path | None = None


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise RunSealError(f"Could not hash {path}: {exc}") from exc
    return digest.hexdigest()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RunSealError(f"Invalid {label}: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise RunSealError(f"{label} must contain a JSON object: {path}")
    return value


def _read_json_records(path: Path, label: str) -> list[Any]:
    try:
        if path.suffix.lower() == ".jsonl":
            records: list[Any] = []
            with path.open("r", encoding="utf-8") as handle:
                for line_number, raw in enumerate(handle, start=1):
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError as exc:
                        raise RunSealError(
                            f"Invalid {label} JSONL line {line_number}: {path}: {exc}"
                        ) from exc
            return records
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RunSealError(f"Invalid {label}: {path}: {exc}") from exc
    return payload if isinstance(payload, list) else [payload]


def _iter_json_records(path: Path, label: str) -> Iterator[Any]:
    if path.suffix.lower() == ".jsonl":
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line_number, raw in enumerate(handle, start=1):
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise RunSealError(
                            f"Invalid {label} JSONL line {line_number}: {path}: {exc}"
                        ) from exc
        except (OSError, UnicodeError) as exc:
            raise RunSealError(f"Invalid {label}: {path}: {exc}") from exc
        return
    for record in _read_json_records(path, label):
        yield record


def _require_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise RunSealError(f"{field} must be a SHA-256 digest.")
    return value.lower()


def _resolve_directory(value: Any, field: str) -> Path:
    raw = Path(_nonempty(value, field))
    try:
        resolved = raw.resolve(strict=True)
    except OSError as exc:
        raise RunSealError(f"Missing {field}: {raw}: {exc}") from exc
    if not resolved.is_dir():
        raise RunSealError(f"{field} is not a directory: {resolved}")
    return resolved


def _normalize_relative_path(value: Any) -> str:
    text = str(value or "").replace("\\", "/")
    if text.startswith("./"):
        text = text[2:]
    text = re.sub(r"^library/", "", text, flags=re.IGNORECASE)
    return text.lower()


def _nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RunSealError(f"{field} must be a non-empty string.")
    return value


def _integer(value: Any, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RunSealError(f"{field} must be an integer >= {minimum}.")
    return value


def _resolve_file(run_dir: Path, value: Any, field: str) -> Path:
    text = _nonempty(value, field)
    raw = Path(text)
    candidate = raw if raw.is_absolute() else run_dir / raw
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise RunSealError(f"Missing {field}: {candidate}: {exc}") from exc
    if not resolved.is_file():
        raise RunSealError(f"{field} is not a regular file: {resolved}")
    return resolved


def _binding(
    path: Path, kind: str, *, expected_sha256: str | None = None
) -> dict[str, Any]:
    try:
        stat = path.stat()
    except OSError as exc:
        raise RunSealError(f"Could not stat {kind}: {path}: {exc}") from exc
    digest = _sha256_file(path)
    if expected_sha256 is not None and digest != expected_sha256:
        raise RunSealError(
            f"{kind} SHA-256 mismatch: expected {expected_sha256}, got {digest}: {path}"
        )
    return {
        "kind": kind,
        "path": str(path),
        "size": stat.st_size,
        "sha256": digest,
    }


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, dict) else None


def _collect_source_locator(
    value: Any,
    relative_paths: set[str],
    source_sha256s: set[str],
) -> None:
    locator = _as_mapping(value)
    if locator is None:
        return
    for key in ("path", "relative_path", "image_path"):
        candidate = locator.get(key)
        if isinstance(candidate, str):
            relative_paths.add(_normalize_relative_path(candidate))
    for key in ("file_sha256", "sha256", "source_page_sha256"):
        candidate = locator.get(key)
        if isinstance(candidate, str) and re.fullmatch(r"[0-9a-fA-F]{64}", candidate):
            source_sha256s.add(candidate.lower())


def _collect_source_boundary_record(
    value: Any,
    page_ids: set[str],
    relative_paths: set[str],
    source_sha256s: set[str],
) -> None:
    record = _as_mapping(value)
    if record is None:
        return
    page = _as_mapping(record.get("page"))
    page_id = page.get("id") if page is not None else None
    if isinstance(page_id, str):
        page_ids.add(page_id)
    image_relative_path = page.get("imageRelativePath") if page is not None else None
    if isinstance(image_relative_path, str):
        relative_paths.add(_normalize_relative_path(image_relative_path))
    _collect_source_locator(
        page.get("source_locator") if page is not None else None,
        relative_paths,
        source_sha256s,
    )
    _collect_source_locator(
        record.get("source_locator"), relative_paths, source_sha256s
    )
    _collect_source_locator(record.get("sourcePage"), relative_paths, source_sha256s)
    for key in (
        "source_page_sha256",
        "page_sha256",
        "sourcePageSha256",
        "imageSha256",
    ):
        candidate = record.get(key)
        if candidate is None and page is not None:
            candidate = page.get(key)
        if isinstance(candidate, str) and re.fullmatch(r"[0-9a-fA-F]{64}", candidate):
            source_sha256s.add(candidate.lower())


def _collect_work_boundary_record(value: Any, work_ids: set[str]) -> None:
    record = _as_mapping(value)
    if record is None:
        return
    work = _as_mapping(record.get("work"))
    for candidate in (
        record.get("work_id"),
        record.get("workId"),
        work.get("id") if work is not None else None,
    ):
        if isinstance(candidate, str) and candidate.strip():
            work_ids.add(candidate.strip())


def _validate_boundary_files(
    boundary: Any,
    *,
    selection_dir: Path,
    kind: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    value = _as_mapping(boundary)
    if value is None:
        raise RunSealError(f"selection.json is missing {kind}Boundary.")
    policy_index = 0 if kind == "source" else 1
    expected_policies = {pair[policy_index] for pair in BOUNDARY_POLICY_PAIRS}
    if value.get("policy") not in expected_policies:
        raise RunSealError(
            f"selection.json {kind}Boundary policy is not the sealed policy."
        )
    files = value.get("files")
    if not isinstance(files, list) or not files:
        raise RunSealError(f"selection.json {kind}Boundary.files must be non-empty.")
    if _integer(value.get("fileCount"), f"{kind}Boundary.fileCount", 1) != len(files):
        raise RunSealError(f"selection.json {kind}Boundary.fileCount is stale.")

    bindings: list[dict[str, Any]] = []
    file_summaries: list[tuple[str, str]] = []
    seen_paths: set[Path] = set()
    records_read = 0
    page_ids: set[str] = set()
    relative_paths: set[str] = set()
    source_sha256s: set[str] = set()
    work_ids: set[str] = set()
    for index, raw_file in enumerate(files):
        file_record = _as_mapping(raw_file)
        if file_record is None:
            raise RunSealError(f"{kind}Boundary.files[{index}] must be an object.")
        path = _resolve_file(
            selection_dir,
            file_record.get("path"),
            f"{kind}Boundary.files[{index}].path",
        )
        if path in seen_paths:
            raise RunSealError(f"{kind}Boundary contains a duplicate file: {path}")
        seen_paths.add(path)
        expected_sha = _require_sha256(
            file_record.get("sha256"), f"{kind}Boundary.files[{index}].sha256"
        )
        binding = _binding(path, f"{kind}_boundary_file", expected_sha256=expected_sha)
        expected_size = _integer(
            file_record.get("sizeBytes"), f"{kind}Boundary.files[{index}].sizeBytes"
        )
        if binding["size"] != expected_size:
            raise RunSealError(f"{kind}Boundary file size drifted: {path}")
        expected_records = _integer(
            file_record.get("recordsRead"), f"{kind}Boundary.files[{index}].recordsRead"
        )
        file_records = 0
        for record in _iter_json_records(path, f"{kind} boundary file"):
            file_records += 1
            if kind == "source":
                _collect_source_boundary_record(
                    record,
                    page_ids,
                    relative_paths,
                    source_sha256s,
                )
            else:
                _collect_work_boundary_record(record, work_ids)
        if file_records != expected_records:
            raise RunSealError(f"{kind}Boundary record count drifted: {path}")
        records_read += file_records
        bindings.append(binding)
        file_summaries.append((str(path), expected_sha))

    if (
        _integer(value.get("recordsRead"), f"{kind}Boundary.recordsRead")
        != records_read
    ):
        raise RunSealError(f"selection.json {kind}Boundary.recordsRead is stale.")
    actual_binding = _sha256_bytes(
        "\n".join(f"{path}:{digest}" for path, digest in file_summaries).encode("utf-8")
    )
    if (
        _require_sha256(value.get("bindingSha256"), f"{kind}Boundary.bindingSha256")
        != actual_binding
    ):
        raise RunSealError(f"selection.json {kind}Boundary.bindingSha256 is stale.")
    return bindings, {
        "recordsRead": records_read,
        "pageIds": page_ids,
        "relativePaths": relative_paths,
        "sourceSha256s": source_sha256s,
        "workIds": work_ids,
    }


def _validate_cohort_record(
    record: Any,
    *,
    index: int,
) -> tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    row = _as_mapping(record)
    if row is None:
        raise RunSealError(f"Cohort record {index + 1} must be an object.")
    if row.get("schemaVersion") != 1 or row.get("cohort") != "baseline40":
        raise RunSealError(f"Cohort record {index + 1} has an invalid schema/cohort.")
    if row.get("selectionIndex") != index:
        raise RunSealError(f"Cohort selectionIndex coverage breaks at {index}.")
    work = _as_mapping(row.get("work"))
    chapter = _as_mapping(row.get("chapter"))
    page = _as_mapping(row.get("page"))
    boundary = _as_mapping(row.get("inferenceBoundary"))
    if work is None or chapter is None or page is None or boundary is None:
        raise RunSealError(f"Cohort record {index + 1} is incomplete.")
    if dict(boundary) != EVALUATION_INFERENCE_BOUNDARY:
        raise RunSealError(
            f"Cohort record {index + 1} is not evaluation-only user_page input."
        )
    _nonempty(work.get("id"), f"cohort record {index + 1} work.id")
    _nonempty(chapter.get("id"), f"cohort record {index + 1} chapter.id")
    _nonempty(page.get("id"), f"cohort record {index + 1} page.id")
    _nonempty(page.get("name"), f"cohort record {index + 1} page.name")
    _nonempty(
        page.get("imageRelativePath"), f"cohort record {index + 1} imageRelativePath"
    )
    _require_sha256(page.get("imageSha256"), f"cohort record {index + 1} imageSha256")
    return row, work, chapter, page


def _validate_cohort_isolation(
    report: Mapping[str, Any],
    config: Mapping[str, Any],
    pages: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    output_root = _resolve_directory(config.get("outputRoot"), "run config outputRoot")
    selection_path = _resolve_file(output_root, "selection.json", "selection.json")
    selection = _read_json(selection_path, "selection")
    if selection.get("schemaVersion") != 1:
        raise RunSealError("selection.json schemaVersion must be 1.")
    cohorts = _as_mapping(selection.get("cohorts"))
    details = _as_mapping(cohorts.get("baseline40")) if cohorts is not None else None
    if details is None:
        raise RunSealError("selection.json is missing cohorts.baseline40.")
    if (
        _integer(details.get("pages"), "selection baseline40 pages", 1)
        != EXPECTED_PAGES
    ):
        raise RunSealError("selection.json baseline40 must contain exactly 40 pages.")
    manifest_path = _resolve_file(
        output_root,
        details.get("manifestPath"),
        "selection baseline40 manifestPath",
    )
    configured_manifest = _resolve_file(
        output_root,
        config.get("manifestPath"),
        "run config manifestPath",
    )
    if configured_manifest != manifest_path:
        raise RunSealError(
            "run-config.json manifestPath is not the sealed baseline40 manifest."
        )
    manifest_digest = _sha256_file(manifest_path)
    expected_digest = _require_sha256(
        details.get("manifestSha256"), "selection baseline40 manifestSha256"
    )
    if manifest_digest != expected_digest:
        raise RunSealError("The baseline40 cohort manifest digest drifted.")
    if (
        report.get("cohortDigest") != expected_digest
        or config.get("cohortDigest") != expected_digest
    ):
        raise RunSealError(
            "Run cohortDigest is not the recomputed baseline40 manifest digest."
        )
    records = _read_json_records(manifest_path, "baseline40 cohort manifest")
    if len(records) != EXPECTED_PAGES:
        raise RunSealError(
            "The sealed baseline40 manifest must contain exactly 40 records."
        )

    source_boundary = _as_mapping(selection.get("sourceBoundary"))
    work_boundary = _as_mapping(selection.get("workBoundary"))
    if source_boundary is None or work_boundary is None:
        raise RunSealError("selection.json is missing a sealed boundary object.")
    policy_pair = (source_boundary.get("policy"), work_boundary.get("policy"))
    if policy_pair not in BOUNDARY_POLICY_PAIRS:
        raise RunSealError("selection.json source/work boundary policies are incompatible.")
    source_bindings, source_inventory = _validate_boundary_files(
        source_boundary, selection_dir=output_root, kind="source"
    )
    work_bindings, work_inventory = _validate_boundary_files(
        work_boundary, selection_dir=output_root, kind="work"
    )

    excluded_page_ids = source_inventory["pageIds"]
    excluded_relative_paths = source_inventory["relativePaths"]
    excluded_source_sha256s = source_inventory["sourceSha256s"]
    source_counts = {
        "excludedPageIds": len(excluded_page_ids),
        "excludedRelativePaths": len(excluded_relative_paths),
        "excludedSourcePageSha256s": len(excluded_source_sha256s),
    }
    for field, actual in source_counts.items():
        if _integer(source_boundary.get(field), f"sourceBoundary.{field}") != actual:
            raise RunSealError(f"selection.json sourceBoundary.{field} is stale.")

    excluded_work_ids = work_inventory["workIds"]
    if _integer(
        work_boundary.get("excludedWorkCount"), "workBoundary.excludedWorkCount"
    ) != len(excluded_work_ids):
        raise RunSealError("selection.json workBoundary.excludedWorkCount is stale.")

    seen_page_ids: set[str] = set()
    overlap_counts = {"pageId": 0, "relativePath": 0, "sourceSha256": 0, "workId": 0}
    for index, (raw_record, report_page) in enumerate(zip(records, pages, strict=True)):
        _row, work, chapter, page = _validate_cohort_record(raw_record, index=index)
        page_id = str(page["id"])
        if page_id in seen_page_ids:
            raise RunSealError(f"Duplicate page.id in baseline40 manifest: {page_id}")
        seen_page_ids.add(page_id)
        page_sha = str(page["imageSha256"]).lower()
        relative_path = _normalize_relative_path(page["imageRelativePath"])
        work_id = str(work["id"])
        overlap_counts["pageId"] += int(page_id in excluded_page_ids)
        overlap_counts["relativePath"] += int(relative_path in excluded_relative_paths)
        overlap_counts["sourceSha256"] += int(page_sha in excluded_source_sha256s)
        overlap_counts["workId"] += int(work_id in excluded_work_ids)
        expected_identity = {
            "selectionIndex": index,
            "sourcePageId": page_id,
            "sourcePageName": str(page["name"]),
            "sourcePageSha256": page_sha,
            "workId": work_id,
            "chapterId": str(chapter["id"]),
        }
        actual_identity = {key: report_page.get(key) for key in expected_identity}
        if actual_identity != expected_identity:
            raise RunSealError(
                f"Run page {index + 1} does not match the sealed cohort record."
            )
    if any(overlap_counts.values()):
        raise RunSealError(
            f"baseline40 overlaps a sealed data/QA boundary: {overlap_counts}"
        )

    bindings = [
        _binding(selection_path, "selection_json"),
        _binding(
            manifest_path, "cohort_manifest_jsonl", expected_sha256=expected_digest
        ),
        *source_bindings,
        *work_bindings,
    ]
    summary = {
        "policy": (
            "evaluation-only baseline40; sealed training, validation, test, calibration, "
            "labeling, pseudo-source, prior-QA, and work boundaries must have zero overlap"
        ),
        "manifestSha256": expected_digest,
        "records": len(records),
        "sourceBoundaryFiles": len(source_bindings),
        "sourceBoundaryRecords": int(source_inventory["recordsRead"]),
        "workBoundaryFiles": len(work_bindings),
        "workBoundaryRecords": int(work_inventory["recordsRead"]),
        "overlapCounts": overlap_counts,
    }
    return bindings, summary


def _require_exact_keys_match(
    report: Mapping[str, Any], config: Mapping[str, Any]
) -> None:
    for field in ("runId", "cohort", "cohortDigest", "candidateId", "cacheFrom"):
        if report.get(field) != config.get(field):
            raise RunSealError(
                f"run-report.json and run-config.json disagree on {field}."
            )


def _validate_common_execution(
    report: Mapping[str, Any],
    config: Mapping[str, Any],
    run_dir: Path,
    options: SealOptions,
) -> None:
    if options.profile not in PROFILES:
        raise RunSealError(f"Unsupported profile: {options.profile}")
    if options.expected_pages != EXPECTED_PAGES:
        raise RunSealError("Both sealing profiles require exactly 40 pages.")
    _require_exact_keys_match(report, config)
    if report.get("cohort") != "baseline40":
        raise RunSealError(
            "This staged evaluator accepts baseline40 only; holdout40 remains sealed."
        )
    if report.get("targetLanguage") != "ko":
        raise RunSealError("Full-pipeline font QA must target Korean.")
    if "targetLanguage" in config and config.get("targetLanguage") != "ko":
        raise RunSealError(
            "run-config.json targetLanguage must be Korean when the field is present."
        )
    if config.get("execute") is not True or config.get("preflightOnly") is not False:
        raise RunSealError(
            "run-config.json must describe a real, non-preflight execution."
        )
    if config.get("pageLimit") is not None:
        raise RunSealError("A sealed 40-page run must not use pageLimit.")
    configured_run_dir = Path(_nonempty(config.get("runDir"), "run config runDir"))
    if configured_run_dir.resolve(strict=False) != run_dir:
        raise RunSealError("run-config.json is bound to a different run directory.")
    if (
        options.expected_candidate_id is not None
        and report.get("candidateId") != options.expected_candidate_id
    ):
        raise RunSealError(
            f"Expected candidateId={options.expected_candidate_id}, got {report.get('candidateId')}."
        )


def _validate_translation_attempt_result(
    path: Path,
    *,
    page: Mapping[str, Any],
    page_number: int,
    config: Mapping[str, Any],
) -> dict[str, Any]:
    result = _read_json(path, f"page {page_number} translation attempt result")
    request_summary = _as_mapping(result.get("requestSummary"))
    request_options = (
        _as_mapping(request_summary.get("options"))
        if request_summary is not None
        else None
    )
    settings = _as_mapping(result.get("settings"))
    raw_response = _as_mapping(result.get("rawResponse"))
    translation_response = (
        _as_mapping(raw_response.get("translation"))
        if raw_response is not None
        else None
    )
    if request_summary is None or request_options is None or settings is None:
        raise RunSealError(
            f"Page {page_number} translation result has no immutable request settings."
        )
    if (
        request_options.get("sourceLanguage") != "ja"
        or request_options.get("targetLanguage") != "ko"
        or request_options.get("modelProvider") != "gemma"
        or settings.get("modelProvider") != "gemma"
    ):
        raise RunSealError(
            f"Page {page_number} translation result does not prove ja->ko Gemma execution."
        )
    model = _as_mapping(config.get("model"))
    if model is None or any(
        request_options.get(request_field) != model.get(config_field)
        or settings.get(request_field) != model.get(config_field)
        for request_field, config_field in (
            ("modelSource", "source"),
            ("modelRepo", "repo"),
            ("modelFile", "file"),
        )
    ):
        raise RunSealError(
            f"Page {page_number} translation result model disagrees with run-config.json."
        )
    fixed_count = _integer(
        request_summary.get("fixedBlockCount"),
        f"page {page_number} translation fixedBlockCount",
        1,
    )
    fixed_ids = request_summary.get("fixedBlockIds")
    if (
        not isinstance(fixed_ids, list)
        or len(fixed_ids) != fixed_count
        or len({_compact_json_bytes(value) for value in fixed_ids}) != fixed_count
        or request_summary.get("noTextDetected") is not False
        or translation_response is None
        or not isinstance(result.get("outputText"), str)
    ):
        raise RunSealError(
            f"Page {page_number} translation result is not a completed fixed-block result."
        )
    expected_page_id = _nonempty(
        page.get("sourcePageId"), f"page {page_number} sourcePageId"
    )
    expected_suffix = (
        Path("run") / "pages" / expected_page_id / path.parent.name / "result.json"
    )
    if tuple(path.parts[-5:]) != tuple(expected_suffix.parts):
        raise RunSealError(
            f"Page {page_number} translation result path is not page-bound."
        )
    source_path = _resolve_file(
        path.parent,
        result.get("imagePath"),
        f"page {page_number} translation result imagePath",
    )
    staged_source = _resolve_file(
        path.parent,
        page.get("stagedOriginalImagePath"),
        f"page {page_number} staged source image",
    )
    if source_path != staged_source:
        raise RunSealError(
            f"Page {page_number} translation result references another source image."
        )
    expected_source_sha = _require_sha256(
        page.get("sourcePageSha256"), f"page {page_number} sourcePageSha256"
    )
    if _sha256_file(source_path) != expected_source_sha:
        raise RunSealError(
            f"Page {page_number} translation source image SHA-256 drifted."
        )
    return _binding(path, "translation_attempt_result_json")


def _validate_translation_target_evidence(
    run_dir: Path,
    pages: Sequence[Mapping[str, Any]],
    config: Mapping[str, Any],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    analysis_root = run_dir / "analysis"
    if not analysis_root.is_dir():
        raise RunSealError("Fresh Gemma run has no persisted translation analysis.")
    bindings_by_page: dict[str, list[dict[str, Any]]] = {}
    translated_pages = 0
    zero_block_pages = 0
    attempt_artifacts = 0
    for page_number, page in enumerate(pages, start=1):
        page_id = _nonempty(
            page.get("sourcePageId"), f"page {page_number} sourcePageId"
        )
        expected_count = _integer(
            page.get("blockCount"), f"page {page_number} blockCount"
        )
        page_roots = sorted(
            (
                entry / "run" / "pages" / page_id
                for entry in analysis_root.iterdir()
                if entry.is_dir() and (entry / "run" / "pages" / page_id).is_dir()
            ),
            key=lambda value: str(value).casefold(),
        )
        attempt_paths = sorted(
            (
                result.resolve(strict=True)
                for page_root in page_roots
                for result in page_root.glob("attempt-*/result.json")
                if result.is_file()
            ),
            key=lambda value: str(value).casefold(),
        )
        if expected_count == 0:
            if attempt_paths:
                raise RunSealError(
                    f"Page {page_number} has translation results despite blockCount=0."
                )
            bindings_by_page[page_id] = []
            zero_block_pages += 1
            continue
        if len(page_roots) != 1 or not attempt_paths:
            raise RunSealError(
                f"Page {page_number} has no unambiguous persisted translation result."
            )
        attempt_numbers: list[int] = []
        page_bindings: list[dict[str, Any]] = []
        for path in attempt_paths:
            match = re.fullmatch(r"attempt-([1-9][0-9]*)", path.parent.name)
            if match is None:
                raise RunSealError(
                    f"Page {page_number} translation attempt path is malformed."
                )
            attempt_numbers.append(int(match.group(1)))
            page_bindings.append(
                _validate_translation_attempt_result(
                    path,
                    page=page,
                    page_number=page_number,
                    config=config,
                )
            )
        if sorted(attempt_numbers) != list(range(1, max(attempt_numbers) + 1)):
            raise RunSealError(
                f"Page {page_number} translation attempt sequence is incomplete."
            )
        bindings_by_page[page_id] = page_bindings
        translated_pages += 1
        attempt_artifacts += len(page_bindings)
    config_state = (
        "explicit_ko"
        if config.get("targetLanguage") == "ko"
        else "historical_absent_bound_by_attempt_results"
    )
    if config_state != "explicit_ko" and attempt_artifacts == 0:
        raise RunSealError(
            "Historical run-config.json without targetLanguage needs bound ko translation results."
        )
    return bindings_by_page, {
        "sourceLanguage": "ja",
        "targetLanguage": "ko",
        "reportTargetLanguage": "ko",
        "configTargetLanguageState": config_state,
        "modelProvider": "gemma",
        "pageCount": len(pages),
        "translatedPages": translated_pages,
        "zeroBlockPages": zero_block_pages,
        "attemptArtifacts": attempt_artifacts,
        "allPagesProven": translated_pages + zero_block_pages == len(pages),
        "proof": "bound_translation_attempt_results_plus_zero_block_pipeline_evidence",
    }


def _normalize_expected_cache(path: Path | None) -> Path | None:
    if path is None:
        return None
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise RunSealError(
            f"Expected cache-from directory is missing: {path}: {exc}"
        ) from exc
    if not resolved.is_dir():
        raise RunSealError(f"Expected cache-from is not a directory: {resolved}")
    return resolved


def _validate_profile_execution(
    report: Mapping[str, Any],
    config: Mapping[str, Any],
    pages: Sequence[Mapping[str, Any]],
    options: SealOptions,
) -> dict[str, Any]:
    expected_cache = _normalize_expected_cache(options.expected_cache_from)
    page_ids = [str(page["sourcePageId"]) for page in pages]
    if options.profile == PROFILE_FRESH_GEMMA_FULL:
        if expected_cache is not None:
            raise RunSealError(
                "fresh-gemma-full does not accept --expected-cache-from."
            )
        if report.get("cacheFrom") is not None or config.get("cacheFrom") is not None:
            raise RunSealError("fresh-gemma-full requires cacheFrom=null.")
        if report.get("provider") != "gemma" or config.get("provider") != "gemma":
            raise RunSealError(
                "fresh-gemma-full requires provider=gemma in report and config."
            )
        model = config.get("model")
        if (
            not isinstance(model, dict)
            or model.get("remote") is True
            or any(
                not isinstance(model.get(field), str) or not model[field].strip()
                for field in (
                    "source",
                    "repo",
                    "file",
                )
            )
        ):
            raise RunSealError(
                "fresh-gemma-full requires a local Gemma model descriptor."
            )
        if config.get("fontInferenceCacheMode") != "off":
            raise RunSealError("fresh-gemma-full forbids cached font inference.")
        if (
            report.get("qaPageRelativeRoleReroute") is not False
            or config.get("qaPageRelativeRoleReroute") is not False
        ):
            raise RunSealError(
                "The fresh Gemma baseline must not enable the v2c QA reroute."
            )
        if report.get("cache") is not None:
            raise RunSealError(
                "A fresh full-pipeline run must not contain replay cache metadata."
            )
        if config.get("cacheFromSeal") is not None:
            raise RunSealError("fresh-gemma-full must not declare cacheFromSeal.")
        for number, page in enumerate(pages, start=1):
            if page.get("mode") != "full":
                raise RunSealError(
                    f"Page {number} was not produced by the live full pipeline."
                )
            if page.get("fontInferenceSource") is not None:
                raise RunSealError(
                    f"Page {number} unexpectedly declares replay font inference."
                )
        return {
            "provider": "gemma",
            "cacheFrom": None,
            "pageMode": "full",
            "fontInferenceMode": "live_full_pipeline",
            "qaPageRelativeRoleReroute": False,
        }

    if expected_cache is None:
        raise RunSealError("live-font-replay requires --expected-cache-from.")
    raw_cache = _nonempty(report.get("cacheFrom"), "run report cacheFrom")
    report_cache = Path(raw_cache).resolve(strict=False)
    config_cache = Path(
        _nonempty(config.get("cacheFrom"), "run config cacheFrom")
    ).resolve(strict=False)
    if report_cache != expected_cache or config_cache != expected_cache:
        raise RunSealError(
            "Replay cacheFrom does not match the precommitted baseline directory."
        )
    if config.get("fontInferenceCacheMode") != "off":
        raise RunSealError("live-font-replay forbids --reuse-cached-font-inference.")
    if (
        report.get("qaPageRelativeRoleReroute") is not True
        or config.get("qaPageRelativeRoleReroute") is not True
    ):
        raise RunSealError("live-font-replay requires the precommitted v2c QA reroute.")
    for number, page in enumerate(pages, start=1):
        if page.get("mode") != "font-replay-cache":
            raise RunSealError(f"Page {number} is not a cache-backed font replay.")
        if page.get("fontInferenceSource") != "live":
            raise RunSealError(f"Page {number} did not recompute font inference live.")
    cache = report.get("cache")
    source_run = cache.get("sourceRun") if isinstance(cache, dict) else None
    if (
        not isinstance(source_run, str)
        or Path(source_run).resolve(strict=False) != expected_cache
    ):
        raise RunSealError(
            "Replay cache.sourceRun does not match the precommitted baseline directory."
        )
    inference = cache.get("fontInference") if isinstance(cache, dict) else None
    if not isinstance(inference, dict) or inference.get("mode") != "off":
        raise RunSealError("Replay report does not prove fontInference.mode=off.")
    reused = inference.get("reusedPageIds")
    live = inference.get("livePageIds")
    replayed = cache.get("replayedPageIds") if isinstance(cache, dict) else None
    if reused != []:
        raise RunSealError("Replay reused cached font inference for one or more pages.")
    if not isinstance(live, list) or live != page_ids:
        raise RunSealError(
            "Replay livePageIds do not exactly cover the ordered 40-page cohort."
        )
    if not isinstance(replayed, list) or replayed != page_ids:
        raise RunSealError(
            "Replay replayedPageIds do not exactly cover the ordered 40-page cohort."
        )
    return {
        "provider": report.get("provider"),
        "cacheFrom": str(expected_cache),
        "pageMode": "font-replay-cache",
        "fontInferenceMode": "live_all_pages",
        "qaPageRelativeRoleReroute": True,
    }


def _validate_fresh_baseline_seal(
    *,
    run_dir: Path,
    expected_cache: Path,
    report: Mapping[str, Any],
    pages: Sequence[Mapping[str, Any]],
    config: Mapping[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    seal_path = _resolve_file(
        run_dir,
        config.get("cacheFromSeal"),
        "run config cacheFromSeal",
    )
    try:
        validate_audit(seal_path)
    except RunSealError as exc:
        raise RunSealError(f"Fresh baseline seal is invalid: {exc}") from exc
    baseline = _read_json(seal_path, "fresh baseline audit")
    if (
        baseline.get("schemaVersion") != SCHEMA_VERSION
        or baseline.get("tool") != {"id": TOOL_ID, "version": TOOL_VERSION}
        or baseline.get("profile") != PROFILE_FRESH_GEMMA_FULL
    ):
        raise RunSealError("cacheFromSeal is not a current fresh-gemma-full audit.")
    identity = _as_mapping(baseline.get("runIdentity"))
    if (
        identity is None
        or identity.get("cohort") != "baseline40"
        or identity.get("pageCount") != EXPECTED_PAGES
        or identity.get("cohortDigest") != report.get("cohortDigest")
    ):
        raise RunSealError("Fresh baseline seal belongs to another cohort.")
    baseline_pages = baseline.get("pages")
    if not isinstance(baseline_pages, list) or [
        row.get("sourcePageId") if isinstance(row, dict) else None
        for row in baseline_pages
    ] != [page.get("sourcePageId") for page in pages]:
        raise RunSealError(
            "Fresh baseline seal does not cover the ordered replay pages."
        )
    language_evidence = _as_mapping(baseline.get("targetLanguageEvidence"))
    if (
        language_evidence is None
        or language_evidence.get("sourceLanguage") != "ja"
        or language_evidence.get("targetLanguage") != "ko"
        or language_evidence.get("reportTargetLanguage") != "ko"
        or language_evidence.get("modelProvider") != "gemma"
        or language_evidence.get("pageCount") != EXPECTED_PAGES
        or language_evidence.get("allPagesProven") is not True
        or _integer(
            language_evidence.get("translatedPages"),
            "fresh baseline translatedPages",
        )
        + _integer(
            language_evidence.get("zeroBlockPages"),
            "fresh baseline zeroBlockPages",
        )
        != EXPECTED_PAGES
    ):
        raise RunSealError(
            "Fresh baseline seal does not prove Japanese-to-Korean translation."
        )
    bindings = baseline.get("bindings")
    report_bindings = (
        [
            row
            for row in bindings
            if isinstance(row, dict) and row.get("kind") == "run_report_json"
        ]
        if isinstance(bindings, list)
        else []
    )
    if len(report_bindings) != 1:
        raise RunSealError("Fresh baseline seal must bind exactly one run report.")
    baseline_report_path = Path(
        _nonempty(report_bindings[0].get("path"), "fresh baseline run report path")
    ).resolve(strict=True)
    if baseline_report_path.parent != expected_cache:
        raise RunSealError("Fresh baseline seal run-report parent is not cacheFrom.")
    sidecar_path = Path(f"{seal_path}{SEAL_SUFFIX}").resolve(strict=True)
    seal_identity = {
        "path": str(seal_path),
        "sha256": _sha256_file(seal_path),
        "pageCount": EXPECTED_PAGES,
        "profile": PROFILE_FRESH_GEMMA_FULL,
    }
    return seal_identity, [
        _binding(seal_path, "fresh_baseline_audit_json"),
        _binding(sidecar_path, "fresh_baseline_audit_seal"),
    ]


def _artifact_summary(bindings: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    ordered = sorted(bindings, key=lambda item: (str(item["kind"]), str(item["path"])))
    return {
        "files": len(ordered),
        "bytes": sum(int(item["size"]) for item in ordered),
        "bindingSha256": _sha256_bytes(_canonical_json_bytes(ordered)),
    }


def _ordered_block_ids(rows: Any, *, field: str, id_field: str) -> list[str]:
    if not isinstance(rows, list):
        raise RunSealError(f"{field} must be a list.")
    result: list[str] = []
    for index, raw in enumerate(rows):
        row = _as_mapping(raw)
        if row is None:
            raise RunSealError(f"{field}[{index}] must be an object.")
        block_id = _nonempty(row.get(id_field), f"{field}[{index}].{id_field}")
        if block_id in result:
            raise RunSealError(f"{field} contains duplicate blockId={block_id}.")
        result.append(block_id)
    return result


def _compact_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise RunSealError(f"Value is not canonical JSON: {exc}") from exc


def _canonical_geometry_sha256(hints: Sequence[Any]) -> str:
    rows: list[list[Any]] = []
    for hint in hints:
        value = _as_mapping(hint)
        rows.append(
            [
                value.get("id") if value is not None else None,
                value.get("x1") if value is not None else None,
                value.get("y1") if value is not None else None,
                value.get("x2") if value is not None else None,
                value.get("y2") if value is not None else None,
            ]
        )
    rows.sort(key=lambda row: _compact_json_bytes(row))
    return _sha256_bytes(_compact_json_bytes(rows))


def _validate_raw_ocr_result(
    path: Path,
    *,
    page: Mapping[str, Any],
    font_input: Mapping[str, Any],
    page_number: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    result = _read_json(path, f"page {page_number} raw OCR result")
    schema_version = result.get("schemaVersion")
    configuration = _as_mapping(result.get("configuration"))
    hints = result.get("hints")
    diagnostics = result.get("diagnostics")
    if (
        schema_version not in (9, 10)
        or result.get("sourceLanguage") != "ja"
        or configuration is None
        or configuration.get("ocrBboxMode") != "ocr"
        or configuration.get("ocrMergeMode") != "semantic"
        or not isinstance(hints, list)
        or not isinstance(diagnostics, list)
        or not all(
            isinstance(entry, dict) and isinstance(entry.get("provider"), str)
            for entry in diagnostics
        )
        or not isinstance(result.get("noTextDetected"), bool)
        or any(
            field in result for field in ("outputText", "rawResponse", "requestSummary")
        )
    ):
        raise RunSealError(
            f"Page {page_number} raw OCR result has an invalid semantic-OCR schema."
        )
    input_page = _as_mapping(font_input.get("page"))
    if input_page is None:
        raise RunSealError(f"Page {page_number} font input page is missing.")
    expected_page_id = str(page.get("sourcePageId"))
    expected_source_sha = _require_sha256(
        font_input.get("sourcePageSha256"),
        f"page {page_number} font input sourcePageSha256",
    )
    if (
        font_input.get("sourcePageId") != expected_page_id
        or input_page.get("id") != expected_page_id
    ):
        raise RunSealError(
            f"Page {page_number} raw OCR/font input page identity disagrees."
        )
    expected_image_path = _resolve_file(
        path.parent,
        input_page.get("imagePath"),
        f"page {page_number} font input source image",
    )
    actual_image_path = _resolve_file(
        path.parent,
        result.get("imagePath"),
        f"page {page_number} raw OCR source image",
    )
    if actual_image_path != expected_image_path:
        raise RunSealError(
            f"Page {page_number} raw OCR source image path conflicts with font input."
        )
    source_binding = _binding(
        actual_image_path,
        "raw_ocr_source_image",
        expected_sha256=expected_source_sha,
    )
    expected_width = _integer(
        input_page.get("width"), f"page {page_number} font input width", 1
    )
    expected_height = _integer(
        input_page.get("height"), f"page {page_number} font input height", 1
    )
    if result.get("width") != expected_width or result.get("height") != expected_height:
        raise RunSealError(
            f"Page {page_number} raw OCR dimensions conflict with font input."
        )
    try:
        with Image.open(actual_image_path) as image:
            actual_dimensions = image.size
    except (OSError, ValueError) as exc:
        raise RunSealError(
            f"Page {page_number} raw OCR source image is invalid: {exc}"
        ) from exc
    if actual_dimensions != (expected_width, expected_height):
        raise RunSealError(
            f"Page {page_number} raw OCR source image dimensions drifted."
        )
    expected_suffix = Path("ocr-hints") / expected_page_id / "result.json"
    if tuple(path.parts[-3:]) != tuple(expected_suffix.parts):
        raise RunSealError(f"Page {page_number} raw OCR result path is not page-bound.")
    providers: list[str] = []
    for entry in diagnostics:
        provider = str(entry["provider"])
        if provider not in providers:
            providers.append(provider)
    binding = _binding(path, "raw_ocr_result_json")
    artifact = {
        "path": str(path),
        "sha256": binding["sha256"],
        "artifactSource": "analysis_ocr_hints_result",
        "schemaVersion": schema_version,
        "sourceLanguage": "ja",
        "providers": providers,
        "configurationSha256": _sha256_bytes(_compact_json_bytes(dict(configuration))),
        "geometrySha256": _canonical_geometry_sha256(hints),
        "hintCount": len(hints),
        "noTextDetected": result["noTextDetected"],
        "sourceBinding": {
            "pageId": expected_page_id,
            "sourcePageSha256": expected_source_sha,
            "imagePath": str(actual_image_path),
            "width": expected_width,
            "height": expected_height,
        },
    }
    return artifact, [binding, source_binding]


def _discover_raw_ocr_results(
    font_input_path: Path,
    *,
    page: Mapping[str, Any],
    font_input: Mapping[str, Any],
    page_number: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        run_root = font_input_path.parent.parent.parent.resolve(strict=True)
    except OSError as exc:
        raise RunSealError(
            f"Page {page_number} font-input run root is missing: {exc}"
        ) from exc
    analysis_root = run_root / "analysis"
    if not analysis_root.is_dir():
        raise RunSealError(
            f"Page {page_number} has no persisted raw OCR analysis directory."
        )
    page_id = _nonempty(page.get("sourcePageId"), f"page {page_number} sourcePageId")
    result_paths = sorted(
        (
            entry / "ocr-hints" / page_id / "result.json"
            for entry in analysis_root.iterdir()
            if entry.is_dir()
        ),
        key=lambda value: str(value).casefold(),
    )
    existing = [path.resolve(strict=True) for path in result_paths if path.is_file()]
    if not existing:
        raise RunSealError(
            f"Page {page_number} requires raw OCR provenance status=ready."
        )
    artifacts: list[dict[str, Any]] = []
    bindings: list[dict[str, Any]] = []
    geometry_sha256s: set[str] = set()
    for path in existing:
        artifact, artifact_bindings = _validate_raw_ocr_result(
            path,
            page=page,
            font_input=font_input,
            page_number=page_number,
        )
        artifacts.append(artifact)
        bindings.extend(artifact_bindings)
        geometry_sha256s.add(str(artifact["geometrySha256"]))
    if len(geometry_sha256s) != 1:
        raise RunSealError(
            f"Page {page_number} raw OCR artifacts conflict on geometry."
        )
    return artifacts, bindings


def _validate_replay_geometry_audit(
    trace: Mapping[str, Any],
    page: Mapping[str, Any],
    *,
    font_input_path: Path,
    discovered_artifacts: Sequence[Mapping[str, Any]],
    fresh_baseline_identity: Mapping[str, Any],
    block_count: int,
    page_number: int,
) -> dict[str, Any]:
    audit = _as_mapping(trace.get("sourceGeometryDirectionReplay"))
    reported_audit = _as_mapping(page.get("sourceGeometryDirectionReplay"))
    if audit is None or reported_audit is None or dict(audit) != dict(reported_audit):
        raise RunSealError(
            f"Page {page_number} replay geometry audit is missing or self-inconsistent."
        )
    if (
        audit.get("contractVersion") != "font-matching-ocr-geometry-replay-v1"
        or audit.get("rawArtifactStatus") != "ready"
    ):
        raise RunSealError(f"Page {page_number} replay requires raw OCR status=ready.")
    if audit.get("freshBaselineSeal") != dict(fresh_baseline_identity):
        raise RunSealError(
            f"Page {page_number} replay does not bind the configured fresh baseline seal."
        )
    font_binding = _as_mapping(audit.get("fontInputBinding"))
    if (
        font_binding is None
        or font_binding.get("status") != "ready"
        or font_binding.get("providedBlockInventoryMatches") is not True
    ):
        raise RunSealError(
            f"Page {page_number} replay font-input binding is not ready."
        )
    audit_font_path = _resolve_file(
        font_input_path.parent,
        font_binding.get("path"),
        f"page {page_number} replay fontInputBinding.path",
    )
    if audit_font_path != font_input_path:
        raise RunSealError(
            f"Page {page_number} replay audit references another font input."
        )
    if _require_sha256(
        font_binding.get("sha256"), f"page {page_number} replay fontInputBinding.sha256"
    ) != _sha256_file(font_input_path):
        raise RunSealError(f"Page {page_number} replay font-input SHA drifted.")

    raw_artifacts = audit.get("rawArtifacts")
    if not isinstance(raw_artifacts, list) or not raw_artifacts:
        raise RunSealError(
            f"Page {page_number} replay raw OCR artifacts are incomplete."
        )
    expected_by_path = {
        str(artifact["path"]): artifact for artifact in discovered_artifacts
    }
    actual_by_path: dict[str, Mapping[str, Any]] = {}
    for index, raw in enumerate(raw_artifacts):
        artifact = _as_mapping(raw)
        if artifact is None:
            raise RunSealError(
                f"Page {page_number} replay rawArtifacts[{index}] is invalid."
            )
        artifact_path = _resolve_file(
            font_input_path.parent,
            artifact.get("path"),
            f"page {page_number} replay rawArtifacts[{index}].path",
        )
        actual_by_path[str(artifact_path)] = artifact
    if set(actual_by_path) != set(expected_by_path):
        raise RunSealError(
            f"Page {page_number} replay raw OCR inventory disagrees with disk."
        )
    for path, expected in expected_by_path.items():
        actual = actual_by_path[path]
        for field in (
            "sha256",
            "artifactSource",
            "schemaVersion",
            "sourceLanguage",
            "providers",
            "configurationSha256",
            "geometrySha256",
        ):
            if actual.get(field) != expected.get(field):
                raise RunSealError(
                    f"Page {page_number} replay raw OCR {field} disagrees with source artifact."
                )
        source_binding = _as_mapping(actual.get("sourceBinding"))
        if source_binding is None or source_binding.get("status") != "ready":
            raise RunSealError(
                f"Page {page_number} replay raw OCR source binding is not ready."
            )
        if not all(
            source_binding.get(field) is True
            for field in (
                "pageIdMatches",
                "imagePathMatches",
                "sha256Matches",
                "dimensionsMatch",
            )
        ):
            raise RunSealError(
                f"Page {page_number} replay raw OCR source binding conflicts."
            )

    counts = {
        field: _integer(audit.get(field), f"page {page_number} geometry audit {field}")
        for field in (
            "blockCount",
            "resolvedBlockCount",
            "rawResolvedBlockCount",
            "existingEvidenceResolvedBlockCount",
            "missingBlockCount",
        )
    }
    if counts["blockCount"] != block_count:
        raise RunSealError(f"Page {page_number} geometry audit blockCount is stale.")
    if counts["resolvedBlockCount"] + counts["missingBlockCount"] != block_count:
        raise RunSealError(
            f"Page {page_number} geometry audit coverage is inconsistent."
        )
    if (
        counts["rawResolvedBlockCount"] + counts["existingEvidenceResolvedBlockCount"]
        != counts["resolvedBlockCount"]
        or counts["existingEvidenceResolvedBlockCount"] != 0
    ):
        raise RunSealError(
            f"Page {page_number} replay did not derive direction only from raw OCR."
        )
    raw_hint_count = _integer(
        audit.get("rawHintCount"), f"page {page_number} geometry audit rawHintCount"
    )
    if raw_hint_count != int(discovered_artifacts[0]["hintCount"]):
        raise RunSealError(f"Page {page_number} geometry audit rawHintCount is stale.")
    return {
        "contractVersion": "font-matching-ocr-geometry-replay-v1",
        "rawArtifactStatus": "ready",
        "rawArtifactCount": len(discovered_artifacts),
        **counts,
    }


def _validate_font_trace(
    run_dir: Path,
    page: Mapping[str, Any],
    *,
    page_number: int,
    expected_reroute: bool,
    fresh_baseline_identity: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    font_input_path = _resolve_file(
        run_dir, page.get("fontInputPath"), f"page {page_number} font input"
    )
    font_input = _read_json(font_input_path, f"page {page_number} font input")
    page_value = _as_mapping(font_input.get("page"))
    if page_value is None:
        raise RunSealError(f"Page {page_number} font input page is missing.")
    input_page_ids = _ordered_block_ids(
        page_value.get("blocks"),
        field=f"page {page_number} font input page.blocks",
        id_field="id",
    )
    input_request_ids = _ordered_block_ids(
        font_input.get("requestBlocks"),
        field=f"page {page_number} font input requestBlocks",
        id_field="blockId",
    )
    decision_ids = [
        str(decision["blockId"])
        for decision in visual_review._validate_decisions(
            page, page_number
        )  # noqa: SLF001
    ]
    expected_count = _integer(page.get("blockCount"), f"page {page_number} blockCount")
    if expected_count == 0 and not expected_reroute:
        if page.get("fontInferencePath") is not None:
            raise RunSealError(
                f"Page {page_number} zero-block fresh page must not claim font inference."
            )
        if decision_ids or input_page_ids or input_request_ids:
            raise RunSealError(
                f"Page {page_number} zero-block pipeline evidence is inconsistent."
            )
        raw_artifacts, raw_bindings = _discover_raw_ocr_results(
            font_input_path,
            page=page,
            font_input=font_input,
            page_number=page_number,
        )
        if any(
            artifact.get("hintCount") != 0 or artifact.get("noTextDetected") is not True
            for artifact in raw_artifacts
        ):
            raise RunSealError(
                f"Page {page_number} skipped translation without raw no-text evidence."
            )
        if (
            page.get("blocksErased") not in (None, 0)
            or page.get("fontDecisions") != []
            or page.get("sourceGeometryDirectionReplay") is not None
        ):
            raise RunSealError(
                f"Page {page_number} zero-block fresh page contains derived font output."
            )
        return (
            {
                "cacheReuse": False,
                "qaPageRelativeRoleReroute": False,
                "requestBlocks": 0,
                "pixelInferenceBlocks": 0,
                "pixelInferenceAbstentions": 0,
                "pixelInferenceAbstainedBlockIds": [],
                "runtimeState": "not_applicable_zero_blocks",
                "rawOcrStatus": "ready_no_text",
                "rawOcrArtifacts": len(raw_artifacts),
            },
            raw_bindings,
            None,
        )
    font_inference_path = _resolve_file(
        run_dir, page.get("fontInferencePath"), f"page {page_number} font inference"
    )
    if font_input_path == font_inference_path:
        raise RunSealError(
            f"Page {page_number} font input and inference paths are identical."
        )
    trace = _read_json(font_inference_path, f"page {page_number} font inference")
    if trace.get("qaPageRelativeRoleReroute") is not expected_reroute:
        raise RunSealError(
            f"Page {page_number} font inference reroute flag does not match the profile."
        )
    if trace.get("cacheReuse") not in (None, False):
        raise RunSealError(
            f"Page {page_number} font inference was restored from cache."
        )
    elapsed = trace.get("elapsedMs")
    if (
        isinstance(elapsed, bool)
        or not isinstance(elapsed, (int, float))
        or not math.isfinite(float(elapsed))
        or float(elapsed) < 0
    ):
        raise RunSealError(f"Page {page_number} font inference elapsedMs is invalid.")
    runtime = _as_mapping(trace.get("runtimeArtifactStatus"))
    if (
        runtime is None
        or runtime.get("state") != "ready"
        or runtime.get("automaticMutationAllowed") is not True
    ):
        raise RunSealError(
            f"Page {page_number} font runtime was not ready for automatic matching."
        )

    trace_request_ids = _ordered_block_ids(
        trace.get("requestBlocks"),
        field=f"page {page_number} font inference requestBlocks",
        id_field="blockId",
    )
    pixel_ids = _ordered_block_ids(
        trace.get("pixelInference"),
        field=f"page {page_number} font inference pixelInference",
        id_field="blockId",
    )
    if not (
        len(decision_ids)
        == len(input_page_ids)
        == len(input_request_ids)
        == len(trace_request_ids)
        == expected_count
    ):
        raise RunSealError(
            f"Page {page_number} font trace block coverage is incomplete."
        )
    if not (decision_ids == input_page_ids == input_request_ids == trace_request_ids):
        raise RunSealError(
            f"Page {page_number} font trace block identities/order disagree."
        )
    pixel_id_set = set(pixel_ids)
    if pixel_ids != [
        block_id for block_id in trace_request_ids if block_id in pixel_id_set
    ]:
        raise RunSealError(
            f"Page {page_number} pixel inference is not an ordered request subset."
        )
    missing_pixel_ids = [
        block_id for block_id in trace_request_ids if block_id not in pixel_id_set
    ]
    decisions_by_id = {
        str(decision["blockId"]): decision
        for decision in visual_review._validate_decisions(
            page, page_number
        )  # noqa: SLF001
    }
    for block_id in missing_pixel_ids:
        decision = decisions_by_id[block_id]
        if (
            decision.get("applied") is not False
            or decision.get("selectedFontId") is not None
            or decision.get("source") is not None
            or decision.get("confidence") is not None
            or decision.get("selectionCalibration") is not None
            or decision.get("localConfidence") is not None
            or decision.get("noneAcceptable") is not None
            or decision.get("top5") != []
        ):
            raise RunSealError(
                f"Page {page_number} block {block_id} lacks exact pixel-abstention evidence."
            )
    pixel_rows = trace.get("pixelInference")
    assert isinstance(pixel_rows, list)
    for block_index, raw in enumerate(pixel_rows):
        row = _as_mapping(raw)
        assert row is not None
        if row.get("kind") != "verified_pixel_inference":
            raise RunSealError(
                f"Page {page_number} block {block_index} is not verified pixel inference."
            )
        if row.get("pageId") != page.get("sourcePageId"):
            raise RunSealError(
                f"Page {page_number} block {block_index} inference belongs to another page."
            )
        boundary = _as_mapping(row.get("inputBoundary"))
        if boundary is None or dict(boundary) != EVALUATION_INFERENCE_BOUNDARY:
            raise RunSealError(
                f"Page {page_number} block {block_index} crossed the evaluation boundary."
            )
    raw_artifacts, raw_bindings = _discover_raw_ocr_results(
        font_input_path,
        page=page,
        font_input=font_input,
        page_number=page_number,
    )
    geometry_summary = None
    if expected_reroute:
        if fresh_baseline_identity is None:
            raise RunSealError(
                f"Page {page_number} replay is missing fresh baseline seal identity."
            )
        geometry_summary = _validate_replay_geometry_audit(
            trace,
            page,
            font_input_path=font_input_path,
            discovered_artifacts=raw_artifacts,
            fresh_baseline_identity=fresh_baseline_identity,
            block_count=expected_count,
            page_number=page_number,
        )
    elif (
        trace.get("sourceGeometryDirectionReplay") is not None
        or page.get("sourceGeometryDirectionReplay") is not None
    ):
        raise RunSealError(
            f"Page {page_number} fresh Gemma run contains replay geometry audit."
        )
    summary = {
        "cacheReuse": False,
        "qaPageRelativeRoleReroute": expected_reroute,
        "requestBlocks": len(trace_request_ids),
        "pixelInferenceBlocks": len(pixel_ids),
        "pixelInferenceAbstentions": len(missing_pixel_ids),
        "pixelInferenceAbstainedBlockIds": missing_pixel_ids,
        "runtimeState": "ready",
        "rawOcrStatus": "ready",
        "rawOcrArtifacts": len(raw_artifacts),
    }
    return summary, raw_bindings, geometry_summary


def _counter(value: Counter[str]) -> dict[str, int]:
    return {key: value[key] for key in sorted(value)}


def _round_metric(value: float) -> float:
    return round(value, 12)


def _outline_summary(
    decisions: Sequence[tuple[int, Mapping[str, Any]]],
) -> dict[str, Any]:
    widths: list[float] = []
    contrasts: list[float] = []
    color_pairs: Counter[str] = Counter()
    for page_number, decision in decisions:
        if decision.get("applied") is not True:
            continue
        location = f"Page {page_number} block {decision.get('blockIndex')}"
        try:
            contrast = outline_policy.validate_applied_font_decision_outline(
                decision, location=location
            )
        except outline_policy.FontDecisionOutlinePolicyError as exc:
            raise RunSealError(str(exc)) from exc
        if contrast is None or not math.isfinite(contrast):
            raise RunSealError(f"{location} has no recomputable outline contrast.")
        recorded = decision.get("effectiveOutlineContrastRatio")
        if (
            isinstance(recorded, bool)
            or not isinstance(recorded, (int, float))
            or not math.isfinite(float(recorded))
            or not math.isclose(float(recorded), contrast, rel_tol=1e-9, abs_tol=1e-9)
        ):
            raise RunSealError(
                f"{location} recorded outline contrast does not match its colors."
            )
        widths.append(float(decision["effectiveOutlineWidthScale"]))
        contrasts.append(contrast)
        color_pairs[
            f"{decision['effectiveTextColor']}->{decision['effectiveOutlineColor']}"
        ] += 1
    return {
        "policy": {
            "minimumEffectiveOutlineContrastRatio": outline_policy.MIN_EFFECTIVE_OUTLINE_CONTRAST_RATIO,
            "allAppliedFontsMustKeepOutline": True,
        },
        "appliedDecisionsValidated": len(widths),
        "zeroOrMissingOutlineAppliedDecisions": 0,
        "widthScale": {
            "minimum": _round_metric(min(widths)) if widths else None,
            "maximum": _round_metric(max(widths)) if widths else None,
        },
        "contrastRatio": {
            "minimum": _round_metric(min(contrasts)) if contrasts else None,
            "maximum": _round_metric(max(contrasts)) if contrasts else None,
        },
        "textToOutlineColorPairs": _counter(color_pairs),
    }


def _decision_summary(
    decisions: Sequence[tuple[int, Mapping[str, Any]]],
    page_ids: Sequence[str],
) -> dict[str, Any]:
    applied = [(page, row) for page, row in decisions if row.get("applied") is True]
    font_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    single_day_roles: Counter[str] = Counter()
    single_day_pages: set[str] = set()
    body_single_day = 0
    for page_number, decision in applied:
        font_id = str(decision.get("selectedFontId"))
        role = decision.get("role")
        if not isinstance(role, str) or role not in VALID_FONT_ROLES:
            raise RunSealError(
                f"Page {page_number} block {decision.get('blockIndex')} has an unknown applied font role."
            )
        font_counts[font_id] += 1
        role_counts[role] += 1
        if font_id == SINGLE_DAY_FONT_ID:
            single_day_roles[role] += 1
            single_day_pages.add(page_ids[page_number - 1])
            if role in BODY_ROLES:
                body_single_day += 1
    return {
        "totalBlocks": len(decisions),
        "appliedBlocks": len(applied),
        "unappliedBlocks": len(decisions) - len(applied),
        "appliedFontCounts": _counter(font_counts),
        "appliedRoleCounts": _counter(role_counts),
        "singleDay": {
            "fontId": SINGLE_DAY_FONT_ID,
            "appliedBlocks": sum(single_day_roles.values()),
            "appliedBodyRoleBlocks": body_single_day,
            "appliedByRole": _counter(single_day_roles),
            "pageIds": sorted(single_day_pages),
        },
    }


def _summarize_geometry_replay(
    summaries: Sequence[Mapping[str, Any]], page_count: int
) -> dict[str, Any]:
    def total(field: str) -> int:
        return sum(int(summary[field]) for summary in summaries)

    return {
        "contractVersion": "font-matching-ocr-geometry-replay-summary-v1",
        "pageCount": page_count,
        "auditedPageCount": len(summaries),
        "rawReadyPageCount": len(summaries),
        "rawMissingPageCount": 0,
        "rawConflictPageCount": 0,
        "rawInvalidPageCount": 0,
        "blockCount": total("blockCount"),
        "resolvedBlockCount": total("resolvedBlockCount"),
        "rawResolvedBlockCount": total("rawResolvedBlockCount"),
        "existingEvidenceResolvedBlockCount": total(
            "existingEvidenceResolvedBlockCount"
        ),
        "missingBlockCount": total("missingBlockCount"),
    }


def build_audit(options: SealOptions) -> dict[str, Any]:
    try:
        report_path = options.report_path.resolve(strict=True)
    except OSError as exc:
        raise RunSealError(f"Missing run report: {options.report_path}: {exc}") from exc
    if not report_path.is_file():
        raise RunSealError(f"Run report is not a regular file: {report_path}")
    run_dir = report_path.parent.resolve(strict=True)
    try:
        report, pages = visual_review._load_completed_report(  # noqa: SLF001
            report_path, options.expected_pages
        )
    except visual_review.ReviewError as exc:
        raise RunSealError(str(exc)) from exc
    config_path = run_dir / "run-config.json"
    config = _read_json(config_path, "run config")
    _validate_common_execution(report, config, run_dir, options)
    execution = _validate_profile_execution(report, config, pages, options)
    cohort_bindings, cohort_isolation = _validate_cohort_isolation(
        report, config, pages
    )
    fresh_baseline_identity: dict[str, Any] | None = None
    fresh_baseline_bindings: list[dict[str, Any]] = []
    translation_bindings_by_page: dict[str, list[dict[str, Any]]] = {}
    target_language_evidence: dict[str, Any]
    if options.profile == PROFILE_LIVE_FONT_REPLAY:
        expected_cache = Path(str(execution["cacheFrom"])).resolve(strict=True)
        fresh_baseline_identity, fresh_baseline_bindings = (
            _validate_fresh_baseline_seal(
                run_dir=run_dir,
                expected_cache=expected_cache,
                report=report,
                pages=pages,
                config=config,
            )
        )
        execution = {**execution, "freshBaselineSeal": fresh_baseline_identity}
        baseline = _read_json(
            Path(str(fresh_baseline_identity["path"])), "fresh baseline audit"
        )
        baseline_language = _as_mapping(baseline.get("targetLanguageEvidence"))
        assert baseline_language is not None
        target_language_evidence = {
            **dict(baseline_language),
            "proof": "bound_fresh_baseline_seal",
            "freshBaselineAuditSha256": fresh_baseline_identity["sha256"],
        }
    else:
        translation_bindings_by_page, target_language_evidence = (
            _validate_translation_target_evidence(run_dir, pages, config)
        )

    page_rows: list[dict[str, Any]] = []
    all_bindings: list[dict[str, Any]] = [
        _binding(report_path, "run_report_json"),
        _binding(config_path, "run_config_json"),
        *cohort_bindings,
        *fresh_baseline_bindings,
    ]
    decisions: list[tuple[int, Mapping[str, Any]]] = []
    page_ids: list[str] = []
    geometry_summaries: list[dict[str, Any]] = []
    raw_ocr_artifact_count = 0
    for page_number, page in enumerate(pages, start=1):
        page_ids.append(str(page["sourcePageId"]))
        incomplete = page.get("blocksIncomplete")
        if incomplete not in (None, 0):
            raise RunSealError(
                f"Page {page_number} has incomplete inpainting blocks: {incomplete}."
            )
        try:
            loaded = visual_review._load_page(
                run_dir, page, page_number
            )  # noqa: SLF001
        except visual_review.ReviewError as exc:
            raise RunSealError(str(exc)) from exc
        try:
            trace_validation, raw_bindings, geometry_summary = _validate_font_trace(
                run_dir,
                page,
                page_number=page_number,
                expected_reroute=bool(execution["qaPageRelativeRoleReroute"]),
                fresh_baseline_identity=fresh_baseline_identity,
            )
            page_bindings = [
                dict(binding)
                for binding in loaded.input_bindings.values()
                if binding is not None
            ]
            page_bindings.extend(raw_bindings)
            page_bindings.extend(
                translation_bindings_by_page.get(str(page["sourcePageId"]), [])
            )
            raw_ocr_artifact_count += int(trace_validation["rawOcrArtifacts"])
            if geometry_summary is not None:
                geometry_summaries.append(geometry_summary)
            all_bindings.extend(page_bindings)
            page_rows.append(
                {
                    "selectionIndex": page_number - 1,
                    "sourcePageId": page["sourcePageId"],
                    "sourcePageSha256": page["sourcePageSha256"],
                    "renderedImageSha256": page["renderedImageSha256"],
                    "blockCount": page["blockCount"],
                    "mode": page["mode"],
                    "fontInferenceSource": page.get("fontInferenceSource"),
                    "fontTrace": trace_validation,
                    "artifacts": page_bindings,
                }
            )
        finally:
            loaded.original.close()
            loaded.cleaned.close()
            loaded.rendered.close()
        for decision in visual_review._validate_decisions(
            page, page_number
        ):  # noqa: SLF001
            decisions.append((page_number, decision))

    if options.profile == PROFILE_LIVE_FONT_REPLAY:
        expected_geometry_summary = _summarize_geometry_replay(
            geometry_summaries, len(pages)
        )
        cache = _as_mapping(report.get("cache"))
        reported_geometry_summary = (
            _as_mapping(cache.get("sourceGeometryDirectionReplay"))
            if cache is not None
            else None
        )
        if (
            reported_geometry_summary is None
            or dict(reported_geometry_summary) != expected_geometry_summary
        ):
            raise RunSealError(
                "Replay cache sourceGeometryDirectionReplay summary is stale."
            )
    elif geometry_summaries:
        raise RunSealError(
            "Fresh Gemma profile unexpectedly collected replay geometry audits."
        )

    by_kind: dict[str, list[dict[str, Any]]] = {}
    for binding in all_bindings:
        by_kind.setdefault(str(binding["kind"]), []).append(binding)
    artifact_stats = {
        kind: _artifact_summary(bindings) for kind, bindings in sorted(by_kind.items())
    }
    content = {
        "schemaVersion": SCHEMA_VERSION,
        "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
        "profile": options.profile,
        "runIdentity": {
            "runId": report["runId"],
            "cohort": report["cohort"],
            "cohortDigest": report["cohortDigest"],
            "candidateId": report["candidateId"],
            "pageCount": len(pages),
        },
        "execution": execution,
        "targetLanguageEvidence": target_language_evidence,
        "cohortIsolation": cohort_isolation,
        "rawOcrStats": {
            "requiredReadyPages": EXPECTED_PAGES,
            "readyPages": len(pages),
            "artifactCount": raw_ocr_artifact_count,
            "allPagesReady": True,
        },
        "dataUsePolicy": {
            "evaluationOnly": True,
            "trainingLabelsAllowed": False,
            "calibrationLabelsAllowed": False,
            "pseudoLabelsAllowed": False,
            "allowedUses": [
                "evaluation",
                "manual_visual_review",
                "candidate_comparison",
            ],
        },
        "pages": page_rows,
        "artifactStats": artifact_stats,
        "decisionStats": _decision_summary(decisions, page_ids),
        "outlineStats": _outline_summary(decisions),
        "bindings": sorted(
            all_bindings, key=lambda item: (str(item["kind"]), str(item["path"]))
        ),
    }
    content["contentSha256"] = _sha256_bytes(_canonical_json_bytes(content))
    return content


def _write_exclusive(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as exc:
        raise RunSealError(f"Refusing to overwrite existing output: {path}") from exc


def seal_audit(options: SealOptions, output_path: Path) -> dict[str, Any]:
    output = output_path.resolve(strict=False)
    run_dir = options.report_path.resolve(strict=False).parent
    try:
        output.relative_to(run_dir)
    except ValueError:
        pass
    else:
        raise RunSealError("Audit output must be outside the source run directory.")
    seal_path = Path(f"{output}{SEAL_SUFFIX}")
    if output.exists() or seal_path.exists():
        raise RunSealError(
            f"Refusing to overwrite existing output: {output} / {seal_path}"
        )
    audit = build_audit(options)
    encoded = (
        json.dumps(audit, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        + b"\n"
    )
    digest = _sha256_bytes(encoded)
    _write_exclusive(output, encoded)
    try:
        _write_exclusive(seal_path, f"{digest}  {output.name}\n".encode("ascii"))
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return {
        "ok": True,
        "auditPath": str(output),
        "sealPath": str(seal_path),
        "auditSha256": digest,
        "profile": audit["profile"],
        "pages": audit["runIdentity"]["pageCount"],
        "blocks": audit["decisionStats"]["totalBlocks"],
        "singleDayApplied": audit["decisionStats"]["singleDay"]["appliedBlocks"],
        "singleDayBodyRoleApplied": audit["decisionStats"]["singleDay"][
            "appliedBodyRoleBlocks"
        ],
    }


def validate_audit(audit_path: Path) -> dict[str, Any]:
    try:
        audit = audit_path.resolve(strict=True)
    except OSError as exc:
        raise RunSealError(f"Missing audit: {audit_path}: {exc}") from exc
    seal_path = Path(f"{audit}{SEAL_SUFFIX}")
    if not seal_path.is_file():
        raise RunSealError(f"Missing audit SHA-256 seal: {seal_path}")
    parts = seal_path.read_text(encoding="ascii").strip().split()
    if len(parts) != 2 or parts[1] != audit.name:
        raise RunSealError("Audit SHA-256 seal has invalid syntax.")
    digest = _sha256_file(audit)
    if parts[0] != digest:
        raise RunSealError("Audit JSON does not match its SHA-256 seal.")
    recorded = _read_json(audit, "run audit")
    if recorded.get("schemaVersion") != SCHEMA_VERSION or recorded.get("tool") != {
        "id": TOOL_ID,
        "version": TOOL_VERSION,
    }:
        raise RunSealError("Audit was produced by an unsupported schema/tool version.")
    content_sha = recorded.get("contentSha256")
    without_content_sha = {
        key: value for key, value in recorded.items() if key != "contentSha256"
    }
    if content_sha != _sha256_bytes(_canonical_json_bytes(without_content_sha)):
        raise RunSealError("Audit contentSha256 is invalid.")
    policy = recorded.get("dataUsePolicy")
    if not isinstance(policy, dict) or policy.get("evaluationOnly") is not True:
        raise RunSealError("Audit lost its evaluation-only policy.")
    if any(
        policy.get(field) is not False
        for field in (
            "trainingLabelsAllowed",
            "calibrationLabelsAllowed",
            "pseudoLabelsAllowed",
        )
    ):
        raise RunSealError("Audit permits prohibited label use.")
    bindings = recorded.get("bindings")
    if not isinstance(bindings, list) or not bindings:
        raise RunSealError("Audit has no artifact bindings.")
    for binding in bindings:
        if not isinstance(binding, dict):
            raise RunSealError("Audit contains an invalid artifact binding.")
        path = Path(_nonempty(binding.get("path"), "binding path"))
        actual = _binding(path, _nonempty(binding.get("kind"), "binding kind"))
        recorded_snapshot = {
            key: binding.get(key) for key in ("kind", "path", "size", "sha256")
        }
        if actual != recorded_snapshot:
            raise RunSealError(f"Sealed artifact drifted: {path}")
    report_bindings = [row for row in bindings if row.get("kind") == "run_report_json"]
    if len(report_bindings) != 1:
        raise RunSealError("Audit must bind exactly one run report.")
    profile = _nonempty(recorded.get("profile"), "profile")
    execution = recorded.get("execution")
    expected_cache = None
    if profile == PROFILE_LIVE_FONT_REPLAY:
        if not isinstance(execution, dict):
            raise RunSealError("Replay audit execution record is missing.")
        expected_cache = Path(
            _nonempty(execution.get("cacheFrom"), "execution cacheFrom")
        )
    rebuilt = build_audit(
        SealOptions(
            report_path=Path(str(report_bindings[0]["path"])),
            profile=profile,
            expected_pages=_integer(
                recorded.get("runIdentity", {}).get("pageCount"), "pageCount", 1
            ),
            expected_candidate_id=recorded.get("runIdentity", {}).get("candidateId"),
            expected_cache_from=expected_cache,
        )
    )
    if rebuilt != recorded:
        raise RunSealError("Audit no longer matches the strict run reconstruction.")
    return {
        "ok": True,
        "auditPath": str(audit),
        "auditSha256": digest,
        "profile": profile,
        "pages": rebuilt["runIdentity"]["pageCount"],
        "blocks": rebuilt["decisionStats"]["totalBlocks"],
        "singleDayApplied": rebuilt["decisionStats"]["singleDay"]["appliedBlocks"],
        "singleDayBodyRoleApplied": rebuilt["decisionStats"]["singleDay"][
            "appliedBodyRoleBlocks"
        ],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Strictly validate and seal a completed library full-pipeline font QA run."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    seal = subparsers.add_parser(
        "seal", help="Validate a completed run and write a new audit + SHA seal."
    )
    seal.add_argument("--run-report", type=Path, required=True)
    seal.add_argument("--output", type=Path, required=True)
    seal.add_argument("--profile", choices=PROFILES, required=True)
    seal.add_argument(
        "--expected-pages",
        type=int,
        choices=(EXPECTED_PAGES,),
        default=EXPECTED_PAGES,
        help="Strict profile invariant; only 40 is accepted.",
    )
    seal.add_argument("--expected-candidate-id")
    seal.add_argument("--expected-cache-from", type=Path)
    validate = subparsers.add_parser(
        "validate", help="Re-hash and reconstruct an existing audit."
    )
    validate.add_argument("--audit", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "seal":
            result = seal_audit(
                SealOptions(
                    report_path=args.run_report,
                    profile=args.profile,
                    expected_pages=args.expected_pages,
                    expected_candidate_id=args.expected_candidate_id,
                    expected_cache_from=args.expected_cache_from,
                ),
                args.output,
            )
        else:
            result = validate_audit(args.audit)
    except (RunSealError, visual_review.ReviewError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
