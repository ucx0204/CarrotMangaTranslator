#!/usr/bin/env python3
"""Promote a QA-only font runtime after sealed baseline40/holdout40 review.

The tool never performs visual judgment.  It requires two separately sealed
40-page manual verdict records, validates the existing image-only 2-up review
packs and their source runs, proves baseline/holdout isolation, checks the
selected epoch-1 R5 evidence on both E and F cohorts, and publishes only into a
new output directory.  The QA runtime remains immutable input.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Mapping, Sequence

try:
    from scripts import attach_font_matching_selection_calibration as attach
    from scripts import build_library_font_qa_visual_review as visual_pack
    from scripts import evaluate_manga_font_r5_qa_snapshots as r5_eval
    from scripts import font_decision_outline_policy as outline_policy
except ImportError:  # pragma: no cover - direct execution from scripts/
    script_dir = str(Path(__file__).resolve().parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    import attach_font_matching_selection_calibration as attach
    import build_library_font_qa_visual_review as visual_pack
    import evaluate_manga_font_r5_qa_snapshots as r5_eval
    import font_decision_outline_policy as outline_policy


PAGE_VERDICTS_SCHEMA = "font-matching-library-page-verdicts-v1"
PAGE_VERDICT_ROW_SCHEMA = "font-matching-library-page-verdict-v1"
PAGE_VERDICTS_RECORD = "font_matching_library_page_verdicts"
PAGE_VERDICT_ROW_RECORD = "font_matching_library_page_verdict"
SELECTED_MODEL_SCHEMA = "font-matching-selected-model-provenance-v1"
SELECTED_MODEL_RECORD = "font_matching_selected_model_provenance"
RELEASE_ACCEPTANCE_SCHEMA = "font-matching-runtime-release-acceptance-v1"
RELEASE_ACCEPTANCE_RECORD = "font_matching_runtime_release_acceptance"
EXPECTED_PAGES = 40
DEFAULT_RETENTION_FLOOR = 0.95
MANUAL_REVIEW_INPUT_KEYS = {
    "chapter_id",
    "notes",
    "selection_index",
    "source_page_id",
    "source_page_sha256",
    "verdict",
    "work_id",
}
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
REPO = Path(__file__).resolve().parents[1]
PREPARE_RUNTIME = REPO / "scripts" / "prepare-runtime.cjs"


class QaRuntimePromotionError(ValueError):
    """Raised when release evidence or publication safety fails closed."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise QaRuntimePromotionError(f"{location}: expected an object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise QaRuntimePromotionError(f"{location}: expected a list")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise QaRuntimePromotionError(f"{location}: expected non-empty text")
    return value.strip()


def _sha(value: Any, location: str) -> str:
    text = _text(value, location).lower()
    if not SHA_RE.fullmatch(text):
        raise QaRuntimePromotionError(f"{location}: expected lowercase SHA-256")
    return text


def _integer(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise QaRuntimePromotionError(f"{location}: expected integer >= {minimum}")
    return value


def _number(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QaRuntimePromotionError(f"{location}: expected a number")
    result = float(value)
    if not (float("-inf") < result < float("inf")):
        raise QaRuntimePromotionError(f"{location}: expected a finite number")
    return result


def _exact_keys(value: Mapping[str, Any], expected: set[str], location: str) -> None:
    actual = set(value)
    if actual != expected:
        raise QaRuntimePromotionError(
            f"{location}: schema drifted; missing={sorted(expected - actual)} "
            f"extra={sorted(actual - expected)}"
        )


def _read_json(path: Path, location: str) -> dict[str, Any]:
    expanded = path.expanduser()
    if expanded.is_symlink():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise QaRuntimePromotionError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    expanded = path.expanduser()
    if expanded.is_symlink():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    try:
        lines = resolved.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise QaRuntimePromotionError(f"{location}: unreadable: {error}") from error
    if not lines or any(not line for line in lines):
        raise QaRuntimePromotionError(f"{location}: blank or empty JSONL record")
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        try:
            rows.append(dict(_mapping(json.loads(line), f"{location}:{line_number}")))
        except json.JSONDecodeError as error:
            raise QaRuntimePromotionError(
                f"{location}:{line_number}: invalid JSON: {error}"
            ) from error
    return rows


def _validate_seal(record: Mapping[str, Any], location: str) -> str:
    try:
        return attach.validate_record_seal(record, location=location)
    except attach.SelectionCalibrationAttachError as error:
        raise QaRuntimePromotionError(str(error)) from error


def _descriptor(path: Path, *, location: str) -> dict[str, Any]:
    expanded = path.expanduser()
    if expanded.is_symlink():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    resolved = expanded.resolve()
    if not resolved.is_file():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    sha256 = attach.sha256_file(resolved)
    try:
        logical_file = resolved.relative_to(REPO.resolve()).as_posix()
    except ValueError:
        logical_stem = re.sub(r"[^a-z0-9]+", "-", location.lower()).strip("-")
        if not logical_stem:
            logical_stem = "artifact"
        suffix = resolved.suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix):
            suffix = ""
        logical_file = f"external-evidence/{logical_stem}-{sha256[:12]}{suffix}"
    return {
        "byte_size": resolved.stat().st_size,
        "file": logical_file,
        "sha256": sha256,
    }


def _parse_time(value: Any, location: str) -> datetime:
    text = _text(value, location)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise QaRuntimePromotionError(f"{location}: invalid ISO timestamp") from error
    if parsed.tzinfo is None:
        raise QaRuntimePromotionError(f"{location}: timezone is required")
    return parsed


def _resolve_reference(base: Path, raw: Any, location: str) -> Path:
    path = Path(_text(raw, location)).expanduser()
    if not path.is_absolute():
        path = base / path
    if path.is_symlink():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    resolved = path.resolve()
    if not resolved.is_file():
        raise QaRuntimePromotionError(f"{location}: missing, linked, or non-file")
    return resolved


def _runtime_identity(runtime: Path) -> dict[str, Any]:
    if runtime.expanduser().is_symlink():
        raise QaRuntimePromotionError("QA runtime source is linked")
    try:
        attached = attach.validate_attached_runtime_bundle(
            output_dir=runtime, allow_qa_only=True
        )
    except attach.SelectionCalibrationAttachError as error:
        raise QaRuntimePromotionError(str(error)) from error
    if (
        attached.get("qa_only") is not True
        or attached.get("release_approved") is not False
    ):
        raise QaRuntimePromotionError("source runtime is not exactly QA-only")
    marker = _read_json(runtime / attach.MARKER_FILE, "QA runtime marker")
    _exact_keys(marker, set(attach.QA_ONLY_MARKER_KEYS), "QA runtime marker")
    if marker.get("qa_only") is not True or marker.get("release_approved") is not False:
        raise QaRuntimePromotionError("QA runtime marker flags are not exact")
    contract = _read_json(runtime / attach.CONTRACT_FILE, "QA runtime contract")
    _validate_seal(contract, "QA runtime contract")
    catalog = _mapping(contract.get("catalog"), "QA runtime contract.catalog")
    deployment = _mapping(contract.get("deployment"), "QA runtime contract.deployment")
    if (
        deployment.get("state") != "ready"
        or deployment.get("automatic_mutation_allowed") is not True
        or deployment.get("fail_closed") is not True
    ):
        raise QaRuntimePromotionError(
            "QA runtime deployment must already be ready, automatic, and fail-closed"
        )
    active = _read_json(
        runtime / attach.ACTIVE_CATALOG_FILE, "QA runtime active catalog"
    )
    calibration = _read_json(
        runtime / attach.SELECTION_CALIBRATION_FILE,
        "QA runtime selection calibration",
    )
    _validate_seal(active, "QA runtime active catalog")
    _validate_seal(calibration, "QA runtime selection calibration")
    candidate_ids = list(
        _text(item, f"QA runtime candidate_ids[{index}]")
        for index, item in enumerate(
            _list(catalog.get("candidate_ids"), "QA runtime candidate_ids")
        )
    )
    if candidate_ids != active.get("candidate_ids"):
        raise QaRuntimePromotionError("QA runtime catalog candidate order drifted")
    artifacts = _mapping(contract.get("artifacts"), "QA runtime artifacts")
    head = _mapping(contract.get("head"), "QA runtime contract.head")
    body_checkpoint_sha = _sha(
        head.get("body_checkpoint_sha256"), "QA runtime body checkpoint SHA"
    )
    variant_checkpoint_sha = _sha(
        head.get("variant_checkpoint_sha256"),
        "QA runtime variant checkpoint SHA",
    )
    if body_checkpoint_sha != variant_checkpoint_sha:
        raise QaRuntimePromotionError(
            "QA runtime body/variant checkpoints do not bind one selected snapshot"
        )

    def artifact_sha(name: str) -> str:
        return _sha(
            _mapping(artifacts.get(name), f"QA runtime artifact {name}").get("sha256"),
            f"QA runtime artifact {name}.sha256",
        )

    return {
        "active_catalog_record_sha256": _sha(
            active.get("record_sha256"), "active catalog record SHA"
        ),
        "active_catalog_sha256": attach.sha256_file(
            runtime / attach.ACTIVE_CATALOG_FILE
        ),
        "candidate_ids": candidate_ids,
        "candidate_order_sha256": _sha(
            catalog.get("candidate_order_sha256"), "candidate order SHA"
        ),
        "catalog_version": _text(catalog.get("catalog_version"), "catalog version"),
        "encoder_sha256": artifact_sha(attach.ENCODER_FILE),
        "model_version": _text(contract.get("model_version"), "model version"),
        "prototype_features_sha256": artifact_sha(attach.PROTOTYPE_FILE),
        "qa_marker_sha256": attach.sha256_file(runtime / attach.MARKER_FILE),
        "ranker_sha256": artifact_sha(attach.RANKER_FILE),
        "runtime_contract_record_sha256": _sha(
            contract.get("record_sha256"), "runtime contract record SHA"
        ),
        "runtime_contract_sha256": attach.sha256_file(runtime / attach.CONTRACT_FILE),
        "selected_checkpoint_sha256": body_checkpoint_sha,
        "selection_calibration_record_sha256": _sha(
            calibration.get("record_sha256"), "selection calibration record SHA"
        ),
        "selection_calibration_sha256": attach.sha256_file(
            runtime / attach.SELECTION_CALIBRATION_FILE
        ),
    }


def _cohort_manifest(
    *,
    manifest_path: Path,
    report: Mapping[str, Any],
    cohort: str,
) -> dict[str, Any]:
    rows = _read_jsonl(manifest_path, f"{cohort} cohort manifest")
    if len(rows) != EXPECTED_PAGES:
        raise QaRuntimePromotionError(f"{cohort}: cohort manifest must contain 40 rows")
    digest = attach.sha256_file(manifest_path)
    if digest != _sha(report.get("cohortDigest"), f"{cohort} cohort digest"):
        raise QaRuntimePromotionError(f"{cohort}: cohort manifest SHA drifted")
    report_pages = _list(report.get("pages"), f"{cohort} report pages")
    for index, (row, page) in enumerate(zip(rows, report_pages, strict=True)):
        page = _mapping(page, f"{cohort} report page {index}")
        manifest_page = _mapping(row.get("page"), f"{cohort} manifest page {index}")
        work = _mapping(row.get("work"), f"{cohort} manifest work {index}")
        chapter = _mapping(row.get("chapter"), f"{cohort} manifest chapter {index}")
        if (
            row.get("schemaVersion") != 1
            or row.get("cohort") != cohort
            or row.get("selectionIndex") != index
            or page.get("selectionIndex") != index
            or manifest_page.get("id") != page.get("sourcePageId")
            or manifest_page.get("imageSha256") != page.get("sourcePageSha256")
            or work.get("id") != page.get("workId")
            or chapter.get("id") != page.get("chapterId")
        ):
            raise QaRuntimePromotionError(
                f"{cohort}: cohort/report binding drift at page {index + 1}"
            )
        boundary = _mapping(
            row.get("inferenceBoundary"), f"{cohort} inference boundary {index}"
        )
        if boundary != {
            "source": "user_page",
            "datasetSplit": None,
            "qaOverlay": False,
        }:
            raise QaRuntimePromotionError(
                f"{cohort}: page {index + 1} crossed the user-page QA boundary"
            )
    return {"descriptor": _descriptor(manifest_path, location="cohort manifest")}


def _validate_runtime_trace(
    *,
    report_path: Path,
    report: Mapping[str, Any],
    runtime: Path,
    runtime_identity: Mapping[str, Any],
    cohort: str,
) -> int:
    if (
        Path(
            _text(report.get("candidateRuntimeDir"), f"{cohort} runtime dir")
        ).resolve()
        != runtime
    ):
        raise QaRuntimePromotionError(
            f"{cohort}: run used a different runtime directory"
        )
    contract = _read_json(runtime / attach.CONTRACT_FILE, "QA runtime contract")
    expected_calibration = _mapping(
        contract.get("calibration"), "QA runtime contract.calibration"
    )
    traced_blocks = 0
    for page_number, page_value in enumerate(
        _list(report.get("pages"), f"{cohort} pages"), 1
    ):
        page = _mapping(page_value, f"{cohort} page {page_number}")
        block_count = _integer(
            page.get("blockCount"), f"{cohort} page {page_number} blockCount"
        )
        if block_count == 0:
            continue
        inference_path = _resolve_reference(
            report_path.parent,
            page.get("fontInferencePath"),
            f"{cohort} page {page_number} font inference",
        )
        inference = _read_json(
            inference_path, f"{cohort} page {page_number} font inference"
        )
        status = _mapping(
            inference.get("runtimeArtifactStatus"),
            f"{cohort} page {page_number} runtime status",
        )
        if (
            status.get("state") != "ready"
            or status.get("automaticMutationAllowed") is not True
            or status.get("modelVersion") != runtime_identity["model_version"]
            or status.get("catalogVersion") != runtime_identity["catalog_version"]
            or status.get("candidateIds") != runtime_identity["candidate_ids"]
            or status.get("candidateOrderSha256")
            != runtime_identity["candidate_order_sha256"]
        ):
            raise QaRuntimePromotionError(
                f"{cohort}: runtime trace drift at page {page_number}"
            )
        trace_calibration = _mapping(
            status.get("calibration"),
            f"{cohort} page {page_number} trace calibration",
        )
        if trace_calibration.get("temperature") != expected_calibration.get(
            "temperature"
        ) or trace_calibration.get("noneThreshold") != expected_calibration.get(
            "none_threshold"
        ):
            raise QaRuntimePromotionError(
                f"{cohort}: calibration trace drift at page {page_number}"
            )
        pixel_rows = _list(
            inference.get("pixelInference"),
            f"{cohort} page {page_number} pixel inference",
        )
        if not pixel_rows:
            raise QaRuntimePromotionError(
                f"{cohort}: page {page_number} has blocks but no pixel inference"
            )
        for row_number, raw in enumerate(pixel_rows, 1):
            row = _mapping(raw, f"{cohort} page {page_number} pixel row {row_number}")
            if (
                row.get("kind") != "verified_pixel_inference"
                or row.get("modelVersion") != runtime_identity["model_version"]
                or row.get("candidateOrderSha256")
                != runtime_identity["candidate_order_sha256"]
            ):
                raise QaRuntimePromotionError(
                    f"{cohort}: pixel model trace drift at page {page_number}"
                )
        traced_blocks += len(pixel_rows)
    if traced_blocks < 1:
        raise QaRuntimePromotionError(
            f"{cohort}: no verified pixel inference was exercised"
        )
    return traced_blocks


def _validate_applied_font_decision_outlines(
    report: Mapping[str, Any], cohort: str
) -> None:
    pages = _list(report.get("pages"), f"{cohort} pages")
    for page_index, raw_page in enumerate(pages):
        page = _mapping(raw_page, f"{cohort} page {page_index + 1}")
        decisions = _list(
            page.get("fontDecisions"),
            f"{cohort} page {page_index + 1} fontDecisions",
        )
        for decision_index, raw_decision in enumerate(decisions):
            decision = _mapping(
                raw_decision,
                f"{cohort} page {page_index + 1} decision {decision_index}",
            )
            try:
                outline_policy.validate_applied_font_decision_outline(
                    decision,
                    location=(
                        f"{cohort} page {page_index + 1} decision {decision_index}"
                    ),
                )
            except outline_policy.FontDecisionOutlinePolicyError as exc:
                raise QaRuntimePromotionError(str(exc)) from exc


def _validate_run(
    *,
    report_path: Path,
    review_dir: Path,
    runtime: Path,
    runtime_identity: Mapping[str, Any],
    cohort: str,
    allow_holdout: bool,
) -> dict[str, Any]:
    if report_path.expanduser().is_symlink() or review_dir.expanduser().is_symlink():
        raise QaRuntimePromotionError(f"{cohort}: linked run evidence is forbidden")
    report_path = report_path.expanduser().resolve()
    report = _read_json(report_path, f"{cohort} run report")
    if (
        report.get("schemaVersion") != 1
        or report.get("status") != "completed"
        or report.get("cohort") != cohort
        or report.get("pageCount") != EXPECTED_PAGES
        or len(_list(report.get("pages"), f"{cohort} pages")) != EXPECTED_PAGES
    ):
        raise QaRuntimePromotionError(f"{cohort}: run is not a completed 40-page run")
    _validate_applied_font_decision_outlines(report, cohort)
    try:
        pack_validation = visual_pack.validate_review(review_dir)
    except visual_pack.ReviewError as error:
        raise QaRuntimePromotionError(str(error)) from error
    if (
        pack_validation.get("pages") != EXPECTED_PAGES
        or pack_validation.get("cohort") != cohort
    ):
        raise QaRuntimePromotionError(f"{cohort}: visual pack coverage drifted")
    index_path = review_dir.expanduser().resolve() / visual_pack.INDEX_NAME
    index = _read_json(index_path, f"{cohort} visual pack index")
    source_report = _mapping(
        _mapping(index.get("binding"), f"{cohort} pack binding").get("sourceReport"),
        f"{cohort} pack source report",
    )
    if Path(
        _text(source_report.get("path"), "pack source report path")
    ).resolve() != report_path or source_report.get("sha256") != attach.sha256_file(
        report_path
    ):
        raise QaRuntimePromotionError(f"{cohort}: visual pack binds another report")
    config_path = report_path.parent / "run-config.json"
    config = _read_json(config_path, f"{cohort} run config")
    expected_config = {
        "cohort": cohort,
        "cohortDigest": report.get("cohortDigest"),
        "candidateId": report.get("candidateId"),
    }
    if any(config.get(key) != value for key, value in expected_config.items()):
        raise QaRuntimePromotionError(f"{cohort}: run config/report identity drifted")
    if (
        Path(_text(config.get("runtimeDir"), f"{cohort} config runtime")).resolve()
        != runtime
        or config.get("execute") is not True
        or config.get("preflightOnly") is not False
        or config.get("allowQaOnlyRuntime") is not True
        or config.get("qaOnlyRuntime") is not True
        or config.get("pageLimit") is not None
        or config.get("allowHoldout") is not allow_holdout
    ):
        raise QaRuntimePromotionError(f"{cohort}: execution/holdout policy drifted")
    manifest_path = _resolve_reference(
        report_path.parent,
        config.get("manifestPath"),
        f"{cohort} cohort manifest",
    )
    manifest = _cohort_manifest(
        manifest_path=manifest_path, report=report, cohort=cohort
    )
    traced_blocks = _validate_runtime_trace(
        report_path=report_path,
        report=report,
        runtime=runtime,
        runtime_identity=runtime_identity,
        cohort=cohort,
    )
    page_ids = [
        _text(page.get("sourcePageId"), "source page id") for page in report["pages"]
    ]
    page_shas = [
        _sha(page.get("sourcePageSha256"), "source page SHA")
        for page in report["pages"]
    ]
    chapter_ids = [
        _text(page.get("chapterId"), "chapter id") for page in report["pages"]
    ]
    if (
        len(set(page_ids)) != EXPECTED_PAGES
        or len(set(page_shas)) != EXPECTED_PAGES
        or len(set(chapter_ids)) != EXPECTED_PAGES
    ):
        raise QaRuntimePromotionError(
            f"{cohort}: page/chapter identities are not unique"
        )
    return {
        "chapter_ids": chapter_ids,
        "cohort_digest": _sha(report.get("cohortDigest"), "cohort digest"),
        "config": config,
        "config_descriptor": _descriptor(config_path, location="run config"),
        "finished_at": _parse_time(report.get("finishedAt"), f"{cohort} finishedAt"),
        "manifest_descriptor": manifest["descriptor"],
        "pack_binding_sha256": _sha(
            pack_validation.get("bindingSha256"), "pack binding SHA"
        ),
        "pack_index_descriptor": _descriptor(index_path, location="visual pack index"),
        "pack_index_sha256": _sha(pack_validation.get("indexSha256"), "pack index SHA"),
        "page_ids": page_ids,
        "page_shas": page_shas,
        "report": report,
        "report_descriptor": _descriptor(report_path, location="run report"),
        "report_path": report_path,
        "started_at": _parse_time(report.get("startedAt"), f"{cohort} startedAt"),
        "structural_error_count": 0,
        "traced_pixel_rows": traced_blocks,
    }


def _validate_page_verdicts(
    *, path: Path, run: Mapping[str, Any], cohort: str
) -> dict[str, Any]:
    record = _read_json(path, f"{cohort} page verdicts")
    _exact_keys(
        record,
        {
            "automatic_visual_judgment",
            "cohort",
            "cohort_sha256",
            "page_count",
            "pages",
            "record_sha256",
            "record_type",
            "review_method",
            "reviewed_at",
            "reviewer",
            "run_report_sha256",
            "schema_version",
            "visual_review_binding_sha256",
            "visual_review_index_sha256",
        },
        f"{cohort} page verdicts",
    )
    _validate_seal(record, f"{cohort} page verdicts")
    if (
        record.get("schema_version") != PAGE_VERDICTS_SCHEMA
        or record.get("record_type") != PAGE_VERDICTS_RECORD
        or record.get("cohort") != cohort
        or record.get("cohort_sha256") != run["cohort_digest"]
        or record.get("run_report_sha256") != run["report_descriptor"]["sha256"]
        or record.get("visual_review_index_sha256") != run["pack_index_sha256"]
        or record.get("visual_review_binding_sha256") != run["pack_binding_sha256"]
        or record.get("review_method") != "manual_visual_inspection"
        or record.get("automatic_visual_judgment") is not False
        or record.get("page_count") != EXPECTED_PAGES
    ):
        raise QaRuntimePromotionError(f"{cohort}: page verdict envelope drifted")
    _text(record.get("reviewer"), f"{cohort} verdict reviewer")
    reviewed_at = _parse_time(record.get("reviewed_at"), f"{cohort} reviewed_at")
    if reviewed_at < run["finished_at"]:
        raise QaRuntimePromotionError(f"{cohort}: verdict predates completed run")
    rows = _list(record.get("pages"), f"{cohort} verdict pages")
    if len(rows) != EXPECTED_PAGES:
        raise QaRuntimePromotionError(
            f"{cohort}: exactly 40 page verdicts are required"
        )
    report_pages = run["report"]["pages"]
    for index, (raw, page) in enumerate(zip(rows, report_pages, strict=True)):
        row = _mapping(raw, f"{cohort} verdict page {index + 1}")
        _exact_keys(
            row,
            {
                "chapter_id",
                "notes",
                "record_sha256",
                "record_type",
                "schema_version",
                "selection_index",
                "source_page_id",
                "source_page_sha256",
                "verdict",
                "work_id",
            },
            f"{cohort} verdict page {index + 1}",
        )
        _validate_seal(row, f"{cohort} verdict page {index + 1}")
        if (
            row.get("schema_version") != PAGE_VERDICT_ROW_SCHEMA
            or row.get("record_type") != PAGE_VERDICT_ROW_RECORD
            or row.get("selection_index") != index
            or row.get("source_page_id") != page.get("sourcePageId")
            or row.get("source_page_sha256") != page.get("sourcePageSha256")
            or row.get("work_id") != page.get("workId")
            or row.get("chapter_id") != page.get("chapterId")
            or row.get("verdict") != "accept"
            or not isinstance(row.get("notes"), str)
        ):
            raise QaRuntimePromotionError(
                f"{cohort}: page {index + 1} is not an exact manual accept"
            )
    return {
        "descriptor": _descriptor(path, location=f"{cohort} page verdicts"),
        "record_sha256": _sha(record.get("record_sha256"), "verdict record SHA"),
        "reviewed_at": reviewed_at,
        "reviewer": record["reviewer"],
    }


def _manual_verdict_run_binding(
    *, report_path: Path, review_dir: Path
) -> dict[str, Any]:
    if report_path.expanduser().is_symlink() or review_dir.expanduser().is_symlink():
        raise QaRuntimePromotionError("linked manual-review evidence is forbidden")
    resolved_report = report_path.expanduser().resolve()
    resolved_review = review_dir.expanduser().resolve()
    try:
        report, ordered_pages = visual_pack._load_completed_report(  # noqa: SLF001
            resolved_report, EXPECTED_PAGES
        )
        pack_validation = visual_pack.validate_review(resolved_review)
    except visual_pack.ReviewError as error:
        raise QaRuntimePromotionError(str(error)) from error
    cohort = _text(report.get("cohort"), "manual-review report cohort")
    if cohort not in {"baseline40", "holdout40"}:
        raise QaRuntimePromotionError(
            "manual verdicts are limited to baseline40 or holdout40"
        )
    if report.get("pages") != ordered_pages:
        raise QaRuntimePromotionError(
            "manual-review report pages are not in exact selection order"
        )
    if (
        pack_validation.get("pages") != EXPECTED_PAGES
        or pack_validation.get("cohort") != cohort
    ):
        raise QaRuntimePromotionError("manual-review visual pack coverage drifted")
    index_path = resolved_review / visual_pack.INDEX_NAME
    index = _read_json(index_path, "manual-review visual pack index")
    source_report = _mapping(
        _mapping(index.get("binding"), "manual-review pack binding").get(
            "sourceReport"
        ),
        "manual-review pack source report",
    )
    report_sha = attach.sha256_file(resolved_report)
    if (
        Path(
            _text(
                source_report.get("path"),
                "manual-review pack source report path",
            )
        ).resolve()
        != resolved_report
        or source_report.get("sha256") != report_sha
    ):
        raise QaRuntimePromotionError(
            "manual-review visual pack binds a different run report"
        )
    page_ids: set[str] = set()
    page_shas: set[str] = set()
    for index_number, page_value in enumerate(ordered_pages):
        page = _mapping(page_value, f"manual-review report page {index_number + 1}")
        if page.get("selectionIndex") != index_number:
            raise QaRuntimePromotionError(
                "manual-review report selection order drifted"
            )
        page_id = _text(
            page.get("sourcePageId"),
            f"manual-review report page {index_number + 1} id",
        )
        page_sha = _sha(
            page.get("sourcePageSha256"),
            f"manual-review report page {index_number + 1} SHA",
        )
        _text(
            page.get("workId"),
            f"manual-review report page {index_number + 1} work id",
        )
        _text(
            page.get("chapterId"),
            f"manual-review report page {index_number + 1} chapter id",
        )
        if page_id in page_ids or page_sha in page_shas:
            raise QaRuntimePromotionError(
                "manual-review report contains duplicate page identity"
            )
        page_ids.add(page_id)
        page_shas.add(page_sha)
    return {
        "cohort_digest": _sha(
            report.get("cohortDigest"), "manual-review cohort digest"
        ),
        "finished_at": _parse_time(
            report.get("finishedAt"), "manual-review report finishedAt"
        ),
        "pack_binding_sha256": _sha(
            pack_validation.get("bindingSha256"),
            "manual-review pack binding SHA",
        ),
        "pack_index_path": index_path,
        "pack_index_sha256": _sha(
            pack_validation.get("indexSha256"),
            "manual-review pack index SHA",
        ),
        "report": report,
        "report_descriptor": _descriptor(
            resolved_report, location="manual-review run report"
        ),
        "report_path": resolved_report,
        "review_dir": resolved_review,
    }


def seal_manual_page_verdicts(
    *,
    run_report: Path,
    visual_pack_dir: Path,
    manual_review_jsonl: Path,
    reviewer: str,
    output: Path,
) -> Mapping[str, Any]:
    reviewer_name = _text(reviewer, "manual reviewer")
    run = _manual_verdict_run_binding(
        report_path=run_report, review_dir=visual_pack_dir
    )
    cohort = _text(run["report"].get("cohort"), "manual-review cohort")
    manual_path = manual_review_jsonl.expanduser()
    if manual_path.is_symlink() or not manual_path.resolve().is_file():
        raise QaRuntimePromotionError(
            "manual review JSONL is missing, linked, or non-file"
        )
    manual_before_sha = attach.sha256_file(manual_path.resolve())
    rows = _read_jsonl(manual_path, "manual review JSONL")
    manual_review_sha = attach.sha256_file(manual_path.resolve())
    if manual_review_sha != manual_before_sha:
        raise QaRuntimePromotionError(
            "manual review JSONL changed while it was being read"
        )
    if len(rows) != EXPECTED_PAGES:
        raise QaRuntimePromotionError(
            "manual review JSONL must contain exactly 40 rows"
        )
    sealed_rows: list[dict[str, Any]] = []
    seen_indexes: set[int] = set()
    report_pages = run["report"]["pages"]
    for position, (raw, page_value) in enumerate(zip(rows, report_pages, strict=True)):
        location = f"manual review row {position + 1}"
        _exact_keys(raw, MANUAL_REVIEW_INPUT_KEYS, location)
        selection_index = _integer(
            raw.get("selection_index"), f"{location}.selection_index"
        )
        if selection_index in seen_indexes:
            raise QaRuntimePromotionError(
                f"{location}: duplicate selection_index {selection_index}"
            )
        seen_indexes.add(selection_index)
        if selection_index != position:
            raise QaRuntimePromotionError(
                f"{location}: rows must be in exact 0..39 selection order"
            )
        page = _mapping(page_value, f"report page {position + 1}")
        expected_identity = {
            "chapter_id": page.get("chapterId"),
            "source_page_id": page.get("sourcePageId"),
            "source_page_sha256": page.get("sourcePageSha256"),
            "work_id": page.get("workId"),
        }
        if any(raw.get(key) != value for key, value in expected_identity.items()):
            raise QaRuntimePromotionError(
                f"{location}: page identity does not match the reviewed report"
            )
        if raw.get("verdict") != "accept":
            raise QaRuntimePromotionError(
                f"{location}: every manual verdict must explicitly be accept"
            )
        notes = raw.get("notes")
        if not isinstance(notes, str) or not notes.strip():
            raise QaRuntimePromotionError(
                f"{location}: non-empty manual notes are required"
            )
        sealed_rows.append(
            attach.seal_record(
                {
                    **expected_identity,
                    "notes": notes,
                    "record_type": PAGE_VERDICT_ROW_RECORD,
                    "schema_version": PAGE_VERDICT_ROW_SCHEMA,
                    "selection_index": selection_index,
                    "verdict": "accept",
                }
            )
        )
    if seen_indexes != set(range(EXPECTED_PAGES)):
        raise QaRuntimePromotionError(
            "manual review JSONL selection indexes are incomplete"
        )
    reviewed_at = datetime.now(timezone.utc)
    if reviewed_at <= run["finished_at"]:
        raise QaRuntimePromotionError(
            "system review timestamp does not follow run completion"
        )
    reviewed_at_text = reviewed_at.isoformat().replace("+00:00", "Z")
    record = attach.seal_record(
        {
            "automatic_visual_judgment": False,
            "cohort": cohort,
            "cohort_sha256": run["cohort_digest"],
            "page_count": EXPECTED_PAGES,
            "pages": sealed_rows,
            "record_type": PAGE_VERDICTS_RECORD,
            "review_method": "manual_visual_inspection",
            "reviewed_at": reviewed_at_text,
            "reviewer": reviewer_name,
            "run_report_sha256": run["report_descriptor"]["sha256"],
            "schema_version": PAGE_VERDICTS_SCHEMA,
            "visual_review_binding_sha256": run["pack_binding_sha256"],
            "visual_review_index_sha256": run["pack_index_sha256"],
        }
    )
    requested_destination = output.expanduser()
    if requested_destination.exists() or requested_destination.is_symlink():
        raise QaRuntimePromotionError("manual verdict output already exists")
    destination = requested_destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
        delete=False,
    ) as handle:
        temporary = Path(handle.name)
        handle.write(attach.json_bytes(record, pretty=True))
    published = False
    try:
        _validate_page_verdicts(path=temporary, run=run, cohort=cohort)
        try:
            current_pack = visual_pack.validate_review(run["review_dir"])
        except visual_pack.ReviewError as error:
            raise QaRuntimePromotionError(str(error)) from error
        if (
            attach.sha256_file(run["report_path"]) != run["report_descriptor"]["sha256"]
            or attach.sha256_file(manual_path.resolve()) != manual_review_sha
            or current_pack.get("bindingSha256") != run["pack_binding_sha256"]
            or current_pack.get("indexSha256") != run["pack_index_sha256"]
        ):
            raise QaRuntimePromotionError(
                "manual-review evidence changed while verdicts were sealed"
            )
        if destination.exists():
            raise QaRuntimePromotionError(
                "manual verdict output appeared during sealing"
            )
        os.rename(temporary, destination)
        published = True
    finally:
        if not published:
            temporary.unlink(missing_ok=True)
    return {
        "automatic_visual_judgment": False,
        "cohort": cohort,
        "output": str(destination),
        "page_count": EXPECTED_PAGES,
        "record_sha256": record["record_sha256"],
        "reviewed_at": reviewed_at_text,
        "reviewer": reviewer_name,
        "status": "sealed_manual_page_verdicts",
    }


def _metric_gate(
    metrics: Mapping[str, Any], *, location: str, retention_floor: float
) -> dict[str, Any]:
    comparison = _mapping(metrics.get("comparison"), f"{location}.comparison")
    confirmed = _mapping(metrics.get("confirmed"), f"{location}.confirmed")
    improved = _integer(comparison.get("improved"), f"{location}.improved")
    worsened = _integer(comparison.get("worsened"), f"{location}.worsened")
    rows = _integer(confirmed.get("rows"), f"{location}.confirmed.rows", minimum=1)
    retention = _number(
        confirmed.get("baseline_top1_retention_rate"), f"{location}.retention"
    )
    if improved <= worsened:
        raise QaRuntimePromotionError(f"{location}: epoch 1 is not net-positive")
    if retention + 1e-12 < retention_floor:
        raise QaRuntimePromotionError(
            f"{location}: retention {retention:.8f} is below {retention_floor:.8f}"
        )
    return {
        "confirmed_rows": rows,
        "improved": improved,
        "net_improvements": improved - worsened,
        "retention_rate": retention,
        "worsened": worsened,
    }


def _validate_r5_evaluation(
    *,
    root: Path,
    label: str,
    candidate_ids: Sequence[str],
    retention_floor: float,
) -> dict[str, Any]:
    if root.expanduser().is_symlink():
        raise QaRuntimePromotionError(f"R5 {label}: linked evaluation is forbidden")
    try:
        validation = r5_eval.validate_output(root)
    except r5_eval.SnapshotEvaluationError as error:
        raise QaRuntimePromotionError(str(error)) from error
    if (
        validation.get("status")
        != "validated_r5_snapshot_visual_qa_not_independent_gold"
    ):
        raise QaRuntimePromotionError(f"R5 {label}: validation status drifted")
    report_path = root.expanduser().resolve() / r5_eval.REPORT_FILE
    manifest_path = root.expanduser().resolve() / r5_eval.MANIFEST_FILE
    metrics_path = root.expanduser().resolve() / r5_eval.METRICS_FILE
    report = _read_json(report_path, f"R5 {label} report")
    manifest = _read_json(manifest_path, f"R5 {label} manifest")
    metrics_rows = _read_jsonl(metrics_path, f"R5 {label} metrics")
    epoch1 = next(
        (
            row
            for row in metrics_rows
            if _mapping(row.get("snapshot"), f"R5 {label} snapshot").get("epoch") == 1
        ),
        None,
    )
    if epoch1 is None:
        raise QaRuntimePromotionError(f"R5 {label}: epoch 1 evidence is missing")
    snapshot = _mapping(epoch1.get("snapshot"), f"R5 {label} epoch 1 snapshot")
    if snapshot.get("candidate_ids") != list(candidate_ids):
        raise QaRuntimePromotionError(f"R5 {label}: candidate catalog drifted")
    metrics = _mapping(epoch1.get("metrics"), f"R5 {label} epoch 1 metrics")
    all_gate = _metric_gate(
        _mapping(metrics.get("all_visual_qa"), f"R5 {label} all_visual_qa"),
        location=f"R5 {label} all_visual_qa",
        retention_floor=retention_floor,
    )
    post_cutoff = _mapping(
        _mapping(
            metrics.get("by_evaluation_set"),
            f"R5 {label} by_evaluation_set",
        ).get(r5_eval.POST_CUTOFF_COHORT),
        f"R5 {label} post-cutoff",
    )
    post_gate = _metric_gate(
        post_cutoff,
        location=f"R5 {label} post-cutoff",
        retention_floor=retention_floor,
    )
    return {
        "all_visual_qa": all_gate,
        "manifest_descriptor": _descriptor(manifest_path, location="R5 manifest"),
        "manifest_record_sha256": _sha(
            manifest.get("record_sha256"), f"R5 {label} manifest record SHA"
        ),
        "metrics_descriptor": _descriptor(metrics_path, location="R5 metrics"),
        "post_cutoff": post_gate,
        "report_descriptor": _descriptor(report_path, location="R5 report"),
        "report_record_sha256": _sha(
            report.get("record_sha256"), f"R5 {label} report record SHA"
        ),
        "snapshot_sha256": _sha(
            snapshot.get("sha256"), f"R5 {label} epoch 1 snapshot SHA"
        ),
    }


def _validate_selection_evidence(
    *,
    qa_runtime: Path,
    baseline_run_report: Path,
    baseline_visual_pack: Path,
    baseline_page_verdicts: Path,
    holdout_run_report: Path,
    holdout_visual_pack: Path,
    holdout_page_verdicts: Path,
    r5_evaluation_e: Path,
    r5_evaluation_f: Path,
    minimum_epoch1_retention: float,
) -> dict[str, Any]:
    if not 0.0 <= minimum_epoch1_retention <= 1.0:
        raise QaRuntimePromotionError("minimum epoch-1 retention must be in [0,1]")
    if qa_runtime.expanduser().is_symlink():
        raise QaRuntimePromotionError("QA runtime source is linked")
    source = qa_runtime.expanduser().resolve()
    runtime_identity = _runtime_identity(source)
    baseline = _validate_run(
        report_path=baseline_run_report,
        review_dir=baseline_visual_pack,
        runtime=source,
        runtime_identity=runtime_identity,
        cohort="baseline40",
        allow_holdout=False,
    )
    baseline_verdicts = _validate_page_verdicts(
        path=baseline_page_verdicts, run=baseline, cohort="baseline40"
    )
    holdout = _validate_run(
        report_path=holdout_run_report,
        review_dir=holdout_visual_pack,
        runtime=source,
        runtime_identity=runtime_identity,
        cohort="holdout40",
        allow_holdout=True,
    )
    holdout_verdicts = _validate_page_verdicts(
        path=holdout_page_verdicts, run=holdout, cohort="holdout40"
    )
    if baseline_verdicts["reviewed_at"] > holdout["started_at"]:
        raise QaRuntimePromotionError(
            "holdout began before the baseline manual acceptance was sealed"
        )
    if baseline["cohort_digest"] == holdout["cohort_digest"]:
        raise QaRuntimePromotionError("baseline and holdout cohort SHA are equal")
    if set(baseline["page_ids"]) & set(holdout["page_ids"]):
        raise QaRuntimePromotionError("baseline/holdout sourcePageId overlap")
    if set(baseline["page_shas"]) & set(holdout["page_shas"]):
        raise QaRuntimePromotionError("baseline/holdout page-pixel SHA overlap")
    if set(baseline["chapter_ids"]) & set(holdout["chapter_ids"]):
        raise QaRuntimePromotionError("baseline/holdout chapter overlap")
    eval_e = _validate_r5_evaluation(
        root=r5_evaluation_e,
        label="E",
        candidate_ids=runtime_identity["candidate_ids"],
        retention_floor=minimum_epoch1_retention,
    )
    eval_f = _validate_r5_evaluation(
        root=r5_evaluation_f,
        label="F",
        candidate_ids=runtime_identity["candidate_ids"],
        retention_floor=minimum_epoch1_retention,
    )
    if eval_e["snapshot_sha256"] != eval_f["snapshot_sha256"]:
        raise QaRuntimePromotionError("R5 E/F selected epoch-1 snapshots differ")
    if eval_e["snapshot_sha256"] != runtime_identity["selected_checkpoint_sha256"]:
        raise QaRuntimePromotionError(
            "R5 epoch-1 snapshot does not match the QA runtime checkpoint"
        )
    return {
        "baseline": baseline,
        "baseline_verdicts": baseline_verdicts,
        "eval_e": eval_e,
        "eval_f": eval_f,
        "holdout": holdout,
        "holdout_verdicts": holdout_verdicts,
        "runtime_identity": runtime_identity,
        "source": source,
    }


def _validate_selected_model_provenance(
    *,
    path: Path,
    runtime_identity: Mapping[str, Any],
    baseline: Mapping[str, Any],
    baseline_verdicts: Mapping[str, Any],
    holdout: Mapping[str, Any],
    holdout_verdicts: Mapping[str, Any],
    eval_e: Mapping[str, Any],
    eval_f: Mapping[str, Any],
) -> dict[str, Any]:
    record = _read_json(path, "selected model provenance")
    _exact_keys(
        record,
        {
            "automatic_model_selection",
            "evidence",
            "holdout_policy",
            "record_sha256",
            "record_type",
            "runtime",
            "schema_version",
            "selected_at",
            "selected_by",
            "selected_snapshot",
            "selection_authority",
        },
        "selected model provenance",
    )
    _validate_seal(record, "selected model provenance")
    if (
        record.get("schema_version") != SELECTED_MODEL_SCHEMA
        or record.get("record_type") != SELECTED_MODEL_RECORD
        or record.get("selection_authority") != "explicit_manual_selection"
        or record.get("automatic_model_selection") is not False
        or record.get("runtime") != runtime_identity
    ):
        raise QaRuntimePromotionError("selected model provenance envelope drifted")
    _text(record.get("selected_by"), "selected model selected_by")
    selected_at = _parse_time(record.get("selected_at"), "selected model selected_at")
    snapshot = _mapping(record.get("selected_snapshot"), "selected snapshot")
    if (
        set(snapshot) != {"epoch", "sha256"}
        or snapshot.get("epoch") != 1
        or snapshot.get("sha256") != eval_e["snapshot_sha256"]
        or snapshot.get("sha256") != eval_f["snapshot_sha256"]
        or snapshot.get("sha256") != runtime_identity["selected_checkpoint_sha256"]
    ):
        raise QaRuntimePromotionError("selected epoch-1 model binding drifted")
    expected_evidence = {
        "baseline": {
            "page_verdicts_record_sha256": baseline_verdicts["record_sha256"],
            "run_report_sha256": baseline["report_descriptor"]["sha256"],
            "visual_review_index_sha256": baseline["pack_index_sha256"],
        },
        "holdout": {
            "page_verdicts_record_sha256": holdout_verdicts["record_sha256"],
            "run_report_sha256": holdout["report_descriptor"]["sha256"],
            "visual_review_index_sha256": holdout["pack_index_sha256"],
        },
        "r5_e": {
            "report_record_sha256": eval_e["report_record_sha256"],
            "report_sha256": eval_e["report_descriptor"]["sha256"],
        },
        "r5_f": {
            "report_record_sha256": eval_f["report_record_sha256"],
            "report_sha256": eval_f["report_descriptor"]["sha256"],
        },
    }
    if record.get("evidence") != expected_evidence:
        raise QaRuntimePromotionError("selected model evidence binding drifted")
    policy = _mapping(record.get("holdout_policy"), "selected holdout policy")
    if policy != {
        "baseline_acceptance_preceded_holdout": True,
        "explicit_allow_holdout": True,
    }:
        raise QaRuntimePromotionError("selected model holdout policy is not explicit")
    if selected_at < holdout_verdicts["reviewed_at"]:
        raise QaRuntimePromotionError("model selection predates holdout acceptance")
    return {
        "descriptor": _descriptor(path, location="selected model provenance"),
        "record": record,
        "record_sha256": _sha(record.get("record_sha256"), "provenance record SHA"),
        "selected_at": selected_at,
    }


def _selected_model_record(
    *, evidence: Mapping[str, Any], selected_by: str, selected_at: datetime
) -> dict[str, Any]:
    runtime_identity = _mapping(
        evidence.get("runtime_identity"), "selection evidence runtime"
    )
    baseline = _mapping(evidence.get("baseline"), "selection evidence baseline")
    baseline_verdicts = _mapping(
        evidence.get("baseline_verdicts"), "selection evidence baseline verdicts"
    )
    holdout = _mapping(evidence.get("holdout"), "selection evidence holdout")
    holdout_verdicts = _mapping(
        evidence.get("holdout_verdicts"), "selection evidence holdout verdicts"
    )
    eval_e = _mapping(evidence.get("eval_e"), "selection evidence R5 E")
    eval_f = _mapping(evidence.get("eval_f"), "selection evidence R5 F")
    return attach.seal_record(
        {
            "automatic_model_selection": False,
            "evidence": {
                "baseline": {
                    "page_verdicts_record_sha256": baseline_verdicts["record_sha256"],
                    "run_report_sha256": baseline["report_descriptor"]["sha256"],
                    "visual_review_index_sha256": baseline["pack_index_sha256"],
                },
                "holdout": {
                    "page_verdicts_record_sha256": holdout_verdicts["record_sha256"],
                    "run_report_sha256": holdout["report_descriptor"]["sha256"],
                    "visual_review_index_sha256": holdout["pack_index_sha256"],
                },
                "r5_e": {
                    "report_record_sha256": eval_e["report_record_sha256"],
                    "report_sha256": eval_e["report_descriptor"]["sha256"],
                },
                "r5_f": {
                    "report_record_sha256": eval_f["report_record_sha256"],
                    "report_sha256": eval_f["report_descriptor"]["sha256"],
                },
            },
            "holdout_policy": {
                "baseline_acceptance_preceded_holdout": True,
                "explicit_allow_holdout": True,
            },
            "record_type": SELECTED_MODEL_RECORD,
            "runtime": copy.deepcopy(dict(runtime_identity)),
            "schema_version": SELECTED_MODEL_SCHEMA,
            "selected_at": selected_at.isoformat().replace("+00:00", "Z"),
            "selected_by": selected_by,
            "selected_snapshot": {
                "epoch": 1,
                "sha256": eval_e["snapshot_sha256"],
            },
            "selection_authority": "explicit_manual_selection",
        }
    )


def _atomic_publish_file_no_overwrite(
    temporary: Path, destination: Path, *, location: str
) -> None:
    if destination.exists() or destination.is_symlink():
        raise QaRuntimePromotionError(f"{location} output already exists")
    try:
        os.link(temporary, destination)
    except FileExistsError as error:
        raise QaRuntimePromotionError(
            f"{location} output appeared during sealing"
        ) from error
    except OSError as error:
        raise QaRuntimePromotionError(
            f"{location} could not be atomically published: {error}"
        ) from error


def seal_selected_model_provenance(
    *,
    qa_runtime: Path,
    baseline_run_report: Path,
    baseline_visual_pack: Path,
    baseline_page_verdicts: Path,
    holdout_run_report: Path,
    holdout_visual_pack: Path,
    holdout_page_verdicts: Path,
    r5_evaluation_e: Path,
    r5_evaluation_f: Path,
    selected_by: str,
    output: Path,
    minimum_epoch1_retention: float = DEFAULT_RETENTION_FLOOR,
) -> Mapping[str, Any]:
    selector = _text(selected_by, "selected model selected_by")
    requested_destination = output.expanduser()
    if requested_destination.exists() or requested_destination.is_symlink():
        raise QaRuntimePromotionError("selected model provenance output already exists")
    destination = requested_destination.resolve()

    def validate_evidence() -> dict[str, Any]:
        return _validate_selection_evidence(
            qa_runtime=qa_runtime,
            baseline_run_report=baseline_run_report,
            baseline_visual_pack=baseline_visual_pack,
            baseline_page_verdicts=baseline_page_verdicts,
            holdout_run_report=holdout_run_report,
            holdout_visual_pack=holdout_visual_pack,
            holdout_page_verdicts=holdout_page_verdicts,
            r5_evaluation_e=r5_evaluation_e,
            r5_evaluation_f=r5_evaluation_f,
            minimum_epoch1_retention=minimum_epoch1_retention,
        )

    evidence = validate_evidence()
    selected_at = datetime.now(timezone.utc)
    if selected_at < evidence["holdout_verdicts"]["reviewed_at"]:
        raise QaRuntimePromotionError("model selection predates holdout acceptance")
    record = _selected_model_record(
        evidence=evidence, selected_by=selector, selected_at=selected_at
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
        delete=False,
    ) as handle:
        temporary = Path(handle.name)
        handle.write(attach.json_bytes(record, pretty=True))
        handle.flush()
        os.fsync(handle.fileno())
    published = False
    try:
        _validate_selected_model_provenance(
            path=temporary,
            runtime_identity=evidence["runtime_identity"],
            baseline=evidence["baseline"],
            baseline_verdicts=evidence["baseline_verdicts"],
            holdout=evidence["holdout"],
            holdout_verdicts=evidence["holdout_verdicts"],
            eval_e=evidence["eval_e"],
            eval_f=evidence["eval_f"],
        )
        refreshed = validate_evidence()
        _validate_selected_model_provenance(
            path=temporary,
            runtime_identity=refreshed["runtime_identity"],
            baseline=refreshed["baseline"],
            baseline_verdicts=refreshed["baseline_verdicts"],
            holdout=refreshed["holdout"],
            holdout_verdicts=refreshed["holdout_verdicts"],
            eval_e=refreshed["eval_e"],
            eval_f=refreshed["eval_f"],
        )
        _atomic_publish_file_no_overwrite(
            temporary, destination, location="selected model provenance"
        )
        published = True
        temporary.unlink(missing_ok=True)
    finally:
        if not published:
            temporary.unlink(missing_ok=True)
    return {
        "automatic_model_selection": False,
        "output": str(destination),
        "record_sha256": record["record_sha256"],
        "selected_at": record["selected_at"],
        "selected_by": selector,
        "selected_snapshot": record["selected_snapshot"],
        "status": "sealed_selected_model_provenance",
    }


def _release_acceptance(
    *,
    runtime_identity: Mapping[str, Any],
    baseline: Mapping[str, Any],
    baseline_verdicts: Mapping[str, Any],
    holdout: Mapping[str, Any],
    holdout_verdicts: Mapping[str, Any],
    eval_e: Mapping[str, Any],
    eval_f: Mapping[str, Any],
    selected: Mapping[str, Any],
    retention_floor: float,
) -> dict[str, Any]:
    return attach.seal_record(
        {
            "acceptance_authority": "sealed_manual_library_qa_and_r5_snapshot_gate",
            "accepted_at": selected["record"]["selected_at"],
            "automatic_visual_judgment": False,
            "external_release_quality_gate_passed": True,
            "publication": {
                "descriptors_and_hashes_regenerated": True,
                "release_marker_has_no_qa_flags": True,
                "source_bytes_copied_exactly": True,
                "source_runtime_immutable": True,
            },
            "quality_gate": {
                "baseline_pages": EXPECTED_PAGES,
                "cohort_chapter_overlap": 0,
                "cohort_page_overlap": 0,
                "holdout_pages": EXPECTED_PAGES,
                "manual_page_verdicts": {"accepted": 80, "total": 80},
                "minimum_epoch1_retention": retention_floor,
                "r5_e_epoch1": {
                    "all_visual_qa": eval_e["all_visual_qa"],
                    "post_cutoff": eval_e["post_cutoff"],
                },
                "r5_f_epoch1": {
                    "all_visual_qa": eval_f["all_visual_qa"],
                    "post_cutoff": eval_f["post_cutoff"],
                },
                "structural_error_count": 0,
            },
            "qa_runs": {
                "baseline": {
                    "cohort_manifest": baseline["manifest_descriptor"],
                    "page_verdicts": baseline_verdicts["descriptor"],
                    "page_verdicts_record_sha256": baseline_verdicts["record_sha256"],
                    "run_config": baseline["config_descriptor"],
                    "run_report": baseline["report_descriptor"],
                    "visual_review_binding_sha256": baseline["pack_binding_sha256"],
                    "visual_review_index": baseline["pack_index_descriptor"],
                },
                "holdout": {
                    "cohort_manifest": holdout["manifest_descriptor"],
                    "page_verdicts": holdout_verdicts["descriptor"],
                    "page_verdicts_record_sha256": holdout_verdicts["record_sha256"],
                    "run_config": holdout["config_descriptor"],
                    "run_report": holdout["report_descriptor"],
                    "visual_review_binding_sha256": holdout["pack_binding_sha256"],
                    "visual_review_index": holdout["pack_index_descriptor"],
                },
            },
            "r5_snapshot_evaluations": {
                "e": {
                    "manifest": eval_e["manifest_descriptor"],
                    "manifest_record_sha256": eval_e["manifest_record_sha256"],
                    "metrics": eval_e["metrics_descriptor"],
                    "report": eval_e["report_descriptor"],
                    "report_record_sha256": eval_e["report_record_sha256"],
                    "selected_epoch": 1,
                    "selected_snapshot_sha256": eval_e["snapshot_sha256"],
                },
                "f": {
                    "manifest": eval_f["manifest_descriptor"],
                    "manifest_record_sha256": eval_f["manifest_record_sha256"],
                    "metrics": eval_f["metrics_descriptor"],
                    "report": eval_f["report_descriptor"],
                    "report_record_sha256": eval_f["report_record_sha256"],
                    "selected_epoch": 1,
                    "selected_snapshot_sha256": eval_f["snapshot_sha256"],
                },
            },
            "record_type": RELEASE_ACCEPTANCE_RECORD,
            "schema_version": RELEASE_ACCEPTANCE_SCHEMA,
            "selected_model_provenance": {
                "artifact": selected["descriptor"],
                "record_sha256": selected["record_sha256"],
            },
            "source_qa_runtime": copy.deepcopy(dict(runtime_identity)),
            "status": "accepted",
        }
    )


def _assert_safe_paths(source: Path, output: Path) -> None:
    source = source.expanduser().resolve()
    output = output.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}
    if source.is_symlink() or not source.is_dir():
        raise QaRuntimePromotionError("QA runtime source is missing or linked")
    if output in forbidden or len(output.parts) < 3 or len(output.name) < 3:
        raise QaRuntimePromotionError(f"unsafe output directory: {output}")
    if output.exists():
        raise QaRuntimePromotionError("output directory already exists")
    if source == output or source in output.parents or output in source.parents:
        raise QaRuntimePromotionError("source and output directories must be disjoint")


def _prepare_runtime_validate(root: Path) -> None:
    code = (
        "const p=require(process.argv[1]);"
        "p.validateFontMatchingRuntimeBundle(process.argv[2]);"
    )
    result = subprocess.run(
        ["node", "-e", code, str(PREPARE_RUNTIME), str(root)],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise QaRuntimePromotionError(
            f"prepare-runtime rejected release bundle: {details}"
        )


def _validate_embedded_descriptor(value: Any, location: str) -> None:
    descriptor = _mapping(value, location)
    _exact_keys(descriptor, {"byte_size", "file", "sha256"}, location)
    _integer(descriptor.get("byte_size"), f"{location}.byte_size", minimum=1)
    logical_file = _text(descriptor.get("file"), f"{location}.file")
    posix_path = PurePosixPath(logical_file.replace("\\", "/"))
    windows_path = PureWindowsPath(logical_file)
    if (
        posix_path.is_absolute()
        or windows_path.is_absolute()
        or windows_path.drive
        or ".." in posix_path.parts
        or logical_file.startswith(("~", "\\\\"))
    ):
        raise QaRuntimePromotionError(
            f"{location}.file: expected a non-sensitive logical path"
        )
    _sha(descriptor.get("sha256"), f"{location}.sha256")


def _validate_embedded_metric_gate(
    value: Any, *, location: str, retention_floor: float
) -> None:
    gate = _mapping(value, location)
    _exact_keys(
        gate,
        {
            "confirmed_rows",
            "improved",
            "net_improvements",
            "retention_rate",
            "worsened",
        },
        location,
    )
    confirmed = _integer(
        gate.get("confirmed_rows"), f"{location}.confirmed_rows", minimum=1
    )
    improved = _integer(gate.get("improved"), f"{location}.improved")
    worsened = _integer(gate.get("worsened"), f"{location}.worsened")
    net = _integer(gate.get("net_improvements"), f"{location}.net", minimum=1)
    retention = _number(gate.get("retention_rate"), f"{location}.retention")
    if confirmed < 1 or net != improved - worsened or improved <= worsened:
        raise QaRuntimePromotionError(f"{location}: net-positive evidence drifted")
    if not 0.0 <= retention <= 1.0 or retention + 1e-12 < retention_floor:
        raise QaRuntimePromotionError(f"{location}: retention evidence drifted")


def _validate_release_acceptance(
    record: Mapping[str, Any], *, contract: Mapping[str, Any], root: Path
) -> None:
    _validate_seal(record, "runtime release_acceptance")
    _exact_keys(
        record,
        {
            "acceptance_authority",
            "accepted_at",
            "automatic_visual_judgment",
            "external_release_quality_gate_passed",
            "publication",
            "quality_gate",
            "qa_runs",
            "r5_snapshot_evaluations",
            "record_sha256",
            "record_type",
            "schema_version",
            "selected_model_provenance",
            "source_qa_runtime",
            "status",
        },
        "runtime release_acceptance",
    )
    gate = _mapping(record.get("quality_gate"), "release_acceptance quality_gate")
    _exact_keys(
        gate,
        {
            "baseline_pages",
            "cohort_chapter_overlap",
            "cohort_page_overlap",
            "holdout_pages",
            "manual_page_verdicts",
            "minimum_epoch1_retention",
            "r5_e_epoch1",
            "r5_f_epoch1",
            "structural_error_count",
        },
        "release_acceptance quality_gate",
    )
    manual = _mapping(
        gate.get("manual_page_verdicts"),
        "release_acceptance manual_page_verdicts",
    )
    retention_floor = _number(
        gate.get("minimum_epoch1_retention"),
        "release_acceptance minimum_epoch1_retention",
    )
    if (
        record.get("schema_version") != RELEASE_ACCEPTANCE_SCHEMA
        or record.get("record_type") != RELEASE_ACCEPTANCE_RECORD
        or record.get("status") != "accepted"
        or record.get("acceptance_authority")
        != "sealed_manual_library_qa_and_r5_snapshot_gate"
        or record.get("external_release_quality_gate_passed") is not True
        or record.get("automatic_visual_judgment") is not False
        or gate.get("baseline_pages") != EXPECTED_PAGES
        or gate.get("holdout_pages") != EXPECTED_PAGES
        or gate.get("cohort_chapter_overlap") != 0
        or gate.get("cohort_page_overlap") != 0
        or gate.get("structural_error_count") != 0
        or manual != {"accepted": 80, "total": 80}
        or not 0.0 <= retention_floor <= 1.0
    ):
        raise QaRuntimePromotionError("runtime release_acceptance envelope drifted")
    _parse_time(record.get("accepted_at"), "release_acceptance accepted_at")
    publication = _mapping(record.get("publication"), "release_acceptance publication")
    if publication != {
        "descriptors_and_hashes_regenerated": True,
        "release_marker_has_no_qa_flags": True,
        "source_bytes_copied_exactly": True,
        "source_runtime_immutable": True,
    }:
        raise QaRuntimePromotionError("release_acceptance publication proof drifted")
    for evaluation in ("r5_e_epoch1", "r5_f_epoch1"):
        evidence = _mapping(gate.get(evaluation), f"release_acceptance {evaluation}")
        _exact_keys(
            evidence,
            {"all_visual_qa", "post_cutoff"},
            f"release_acceptance {evaluation}",
        )
        for cohort in ("all_visual_qa", "post_cutoff"):
            _validate_embedded_metric_gate(
                evidence.get(cohort),
                location=f"release_acceptance {evaluation}.{cohort}",
                retention_floor=retention_floor,
            )

    qa_runs = _mapping(record.get("qa_runs"), "release_acceptance qa_runs")
    _exact_keys(qa_runs, {"baseline", "holdout"}, "release_acceptance qa_runs")
    for cohort in ("baseline", "holdout"):
        run = _mapping(qa_runs.get(cohort), f"release_acceptance qa_runs.{cohort}")
        _exact_keys(
            run,
            {
                "cohort_manifest",
                "page_verdicts",
                "page_verdicts_record_sha256",
                "run_config",
                "run_report",
                "visual_review_binding_sha256",
                "visual_review_index",
            },
            f"release_acceptance qa_runs.{cohort}",
        )
        for descriptor in (
            "cohort_manifest",
            "page_verdicts",
            "run_config",
            "run_report",
            "visual_review_index",
        ):
            _validate_embedded_descriptor(
                run.get(descriptor),
                f"release_acceptance qa_runs.{cohort}.{descriptor}",
            )
        _sha(
            run.get("page_verdicts_record_sha256"),
            f"release_acceptance qa_runs.{cohort}.page verdict seal",
        )
        _sha(
            run.get("visual_review_binding_sha256"),
            f"release_acceptance qa_runs.{cohort}.visual binding",
        )

    evaluations = _mapping(
        record.get("r5_snapshot_evaluations"),
        "release_acceptance r5_snapshot_evaluations",
    )
    _exact_keys(
        evaluations,
        {"e", "f"},
        "release_acceptance r5_snapshot_evaluations",
    )
    selected_snapshot_shas: set[str] = set()
    for label in ("e", "f"):
        evaluation = _mapping(
            evaluations.get(label),
            f"release_acceptance r5_snapshot_evaluations.{label}",
        )
        _exact_keys(
            evaluation,
            {
                "manifest",
                "manifest_record_sha256",
                "metrics",
                "report",
                "report_record_sha256",
                "selected_epoch",
                "selected_snapshot_sha256",
            },
            f"release_acceptance r5_snapshot_evaluations.{label}",
        )
        for descriptor in ("manifest", "metrics", "report"):
            _validate_embedded_descriptor(
                evaluation.get(descriptor),
                f"release_acceptance r5_snapshot_evaluations.{label}.{descriptor}",
            )
        if evaluation.get("selected_epoch") != 1:
            raise QaRuntimePromotionError("release_acceptance selected epoch drifted")
        _sha(
            evaluation.get("manifest_record_sha256"),
            f"release_acceptance R5 {label} manifest seal",
        )
        _sha(
            evaluation.get("report_record_sha256"),
            f"release_acceptance R5 {label} report seal",
        )
        selected_snapshot_shas.add(
            _sha(
                evaluation.get("selected_snapshot_sha256"),
                f"release_acceptance R5 {label} snapshot",
            )
        )
    if len(selected_snapshot_shas) != 1:
        raise QaRuntimePromotionError("release_acceptance R5 E/F snapshot drifted")

    selected = _mapping(
        record.get("selected_model_provenance"),
        "release_acceptance selected_model_provenance",
    )
    _exact_keys(
        selected,
        {"artifact", "record_sha256"},
        "release_acceptance selected_model_provenance",
    )
    _validate_embedded_descriptor(
        selected.get("artifact"), "release_acceptance selected provenance artifact"
    )
    _sha(
        selected.get("record_sha256"),
        "release_acceptance selected provenance seal",
    )

    source = _mapping(
        record.get("source_qa_runtime"), "release_acceptance source_qa_runtime"
    )
    _exact_keys(
        source,
        {
            "active_catalog_record_sha256",
            "active_catalog_sha256",
            "candidate_ids",
            "candidate_order_sha256",
            "catalog_version",
            "encoder_sha256",
            "model_version",
            "prototype_features_sha256",
            "qa_marker_sha256",
            "ranker_sha256",
            "runtime_contract_record_sha256",
            "runtime_contract_sha256",
            "selected_checkpoint_sha256",
            "selection_calibration_record_sha256",
            "selection_calibration_sha256",
        },
        "release_acceptance source_qa_runtime",
    )
    source_candidates = [
        _text(value, f"release_acceptance source candidate {index}")
        for index, value in enumerate(
            _list(source.get("candidate_ids"), "release_acceptance source candidates")
        )
    ]
    catalog = _mapping(contract.get("catalog"), "release contract.catalog")
    catalog_candidates = [
        _text(value, f"release contract candidate {index}")
        for index, value in enumerate(
            _list(catalog.get("candidate_ids"), "release contract candidates")
        )
    ]
    artifacts = _mapping(contract.get("artifacts"), "release contract.artifacts")
    active_catalog = _read_json(
        root / attach.ACTIVE_CATALOG_FILE, "release active catalog"
    )
    calibration = _read_json(
        root / attach.SELECTION_CALIBRATION_FILE, "release selection calibration"
    )
    if active_catalog.get("candidate_ids") != catalog_candidates:
        raise QaRuntimePromotionError("release active-catalog candidate order drifted")
    if source_candidates != catalog_candidates:
        raise QaRuntimePromotionError("release source candidate order drifted")
    qa_contract = copy.deepcopy(dict(contract))
    qa_contract.pop("record_sha256", None)
    qa_contract.pop("release_acceptance", None)
    sealed_qa_contract = attach.seal_record(qa_contract)
    release_head = _mapping(contract.get("head"), "release contract.head")
    release_body_checkpoint = _sha(
        release_head.get("body_checkpoint_sha256"),
        "release body checkpoint SHA",
    )
    release_variant_checkpoint = _sha(
        release_head.get("variant_checkpoint_sha256"),
        "release variant checkpoint SHA",
    )
    if release_body_checkpoint != release_variant_checkpoint:
        raise QaRuntimePromotionError("release checkpoint identity drifted")
    expected_source = {
        "active_catalog_record_sha256": active_catalog.get("record_sha256"),
        "active_catalog_sha256": attach.sha256_file(root / attach.ACTIVE_CATALOG_FILE),
        "candidate_ids": source_candidates,
        "candidate_order_sha256": catalog.get("candidate_order_sha256"),
        "catalog_version": catalog.get("catalog_version"),
        "encoder_sha256": _mapping(
            artifacts.get(attach.ENCODER_FILE), "release encoder descriptor"
        ).get("sha256"),
        "model_version": contract.get("model_version"),
        "prototype_features_sha256": _mapping(
            artifacts.get(attach.PROTOTYPE_FILE), "release prototype descriptor"
        ).get("sha256"),
        "ranker_sha256": _mapping(
            artifacts.get(attach.RANKER_FILE), "release ranker descriptor"
        ).get("sha256"),
        "runtime_contract_record_sha256": sealed_qa_contract.get("record_sha256"),
        "runtime_contract_sha256": attach.sha256_bytes(
            attach.json_bytes(sealed_qa_contract, pretty=True)
        ),
        "selected_checkpoint_sha256": release_body_checkpoint,
        "selection_calibration_record_sha256": calibration.get("record_sha256"),
        "selection_calibration_sha256": attach.sha256_file(
            root / attach.SELECTION_CALIBRATION_FILE
        ),
    }
    for key, expected in expected_source.items():
        if source.get(key) != expected:
            raise QaRuntimePromotionError(
                f"release_acceptance source runtime binding drifted: {key}"
            )
    _sha(source.get("qa_marker_sha256"), "release_acceptance QA marker SHA")


def validate_release_bundle(output_dir: Path) -> Mapping[str, Any]:
    if output_dir.expanduser().is_symlink():
        raise QaRuntimePromotionError("release runtime directory is linked")
    root = output_dir.expanduser().resolve()
    try:
        result = attach.validate_attached_runtime_bundle(
            output_dir=root, allow_qa_only=False
        )
    except attach.SelectionCalibrationAttachError as error:
        raise QaRuntimePromotionError(str(error)) from error
    marker = _read_json(root / attach.MARKER_FILE, "release runtime marker")
    _exact_keys(marker, set(attach.MARKER_KEYS), "release runtime marker")
    if "qa_only" in marker or "release_approved" in marker:
        raise QaRuntimePromotionError("release marker retained QA-only flags")
    contract = _read_json(root / attach.CONTRACT_FILE, "release runtime contract")
    _validate_seal(contract, "release runtime contract")
    acceptance = _mapping(
        contract.get("release_acceptance"), "runtime release_acceptance"
    )
    _validate_release_acceptance(acceptance, contract=contract, root=root)
    if result.get("external_release_acceptance") is not True:
        raise QaRuntimePromotionError(
            "release calibration did not recognize external acceptance"
        )
    deployment = _mapping(contract.get("deployment"), "release deployment")
    if (
        deployment.get("state") != "ready"
        or deployment.get("automatic_mutation_allowed") is not True
        or deployment.get("fail_closed") is not True
    ):
        raise QaRuntimePromotionError("release deployment is not ready/fail-closed")
    _prepare_runtime_validate(root)
    return {
        "automatic_mutation_allowed": True,
        "contract_sha256": attach.sha256_file(root / attach.CONTRACT_FILE),
        "external_release_acceptance": result.get("external_release_acceptance"),
        "model_version": result.get("model_version"),
        "output_dir": str(root),
        "qa_only": False,
        "release_acceptance_record_sha256": acceptance.get("record_sha256"),
        "release_approved": True,
        "status": "ready",
    }


def promote_runtime(
    *,
    qa_runtime: Path,
    baseline_run_report: Path,
    baseline_visual_pack: Path,
    baseline_page_verdicts: Path,
    holdout_run_report: Path,
    holdout_visual_pack: Path,
    holdout_page_verdicts: Path,
    r5_evaluation_e: Path,
    r5_evaluation_f: Path,
    selected_model_provenance: Path,
    output_dir: Path,
    minimum_epoch1_retention: float = DEFAULT_RETENTION_FLOOR,
) -> Mapping[str, Any]:
    source = qa_runtime.expanduser().resolve()
    output = output_dir.expanduser().resolve()
    _assert_safe_paths(source, output)
    evidence = _validate_selection_evidence(
        qa_runtime=qa_runtime,
        baseline_run_report=baseline_run_report,
        baseline_visual_pack=baseline_visual_pack,
        baseline_page_verdicts=baseline_page_verdicts,
        holdout_run_report=holdout_run_report,
        holdout_visual_pack=holdout_visual_pack,
        holdout_page_verdicts=holdout_page_verdicts,
        r5_evaluation_e=r5_evaluation_e,
        r5_evaluation_f=r5_evaluation_f,
        minimum_epoch1_retention=minimum_epoch1_retention,
    )
    runtime_identity = evidence["runtime_identity"]
    baseline = evidence["baseline"]
    baseline_verdicts = evidence["baseline_verdicts"]
    holdout = evidence["holdout"]
    holdout_verdicts = evidence["holdout_verdicts"]
    eval_e = evidence["eval_e"]
    eval_f = evidence["eval_f"]
    source_hashes = {
        name: attach.sha256_file(source / name) for name in attach.ATTACHED_BUNDLE_FILES
    }
    selected = _validate_selected_model_provenance(
        path=selected_model_provenance,
        runtime_identity=runtime_identity,
        baseline=baseline,
        baseline_verdicts=baseline_verdicts,
        holdout=holdout,
        holdout_verdicts=holdout_verdicts,
        eval_e=eval_e,
        eval_f=eval_f,
    )
    acceptance = _release_acceptance(
        runtime_identity=runtime_identity,
        baseline=baseline,
        baseline_verdicts=baseline_verdicts,
        holdout=holdout,
        holdout_verdicts=holdout_verdicts,
        eval_e=eval_e,
        eval_f=eval_f,
        selected=selected,
        retention_floor=minimum_epoch1_retention,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        for name in attach.ATTACHED_ASSET_FILES:
            attach._copy_verified_file(  # noqa: SLF001
                source / name,
                staging / name,
                expected_sha256=source_hashes[name],
            )
        source_contract = _read_json(
            source / attach.CONTRACT_FILE, "QA runtime contract"
        )
        updated = copy.deepcopy(source_contract)
        updated.pop("record_sha256", None)
        updated["release_acceptance"] = acceptance
        deployment = dict(_mapping(updated.get("deployment"), "QA runtime deployment"))
        deployment.update(
            {
                "automatic_mutation_allowed": True,
                "fail_closed": True,
                "state": "ready",
            }
        )
        updated["deployment"] = deployment
        updated["artifacts"] = {
            name: attach._artifact_descriptor(  # noqa: SLF001
                staging / name, file_name=name
            )
            for name in attach.ATTACHED_ASSET_FILES
        }
        updated_contract = attach.seal_record(updated)
        (staging / attach.CONTRACT_FILE).write_bytes(
            attach.json_bytes(updated_contract, pretty=True)
        )
        marker = {
            "artifacts": {
                name: attach.sha256_file(staging / name)
                for name in (attach.CONTRACT_FILE, *attach.ATTACHED_ASSET_FILES)
            },
            "owner": attach._runtime_owner(updated_contract["schema_version"]),  # noqa: SLF001
            "safe_replace": True,
            "schema_version": updated_contract["schema_version"],
        }
        (staging / attach.MARKER_FILE).write_bytes(
            attach.json_bytes(marker, pretty=True)
        )
        validate_release_bundle(staging)
        _runtime_identity(source)
        if any(
            attach.sha256_file(source / name) != expected
            for name, expected in source_hashes.items()
        ):
            raise QaRuntimePromotionError("QA runtime source changed during promotion")
        if output.exists():
            raise QaRuntimePromotionError("output appeared during promotion")
        os.rename(staging, output)
        published = True
        return validate_release_bundle(output)
    except BaseException:
        if not published and staging.exists():
            shutil.rmtree(staging)
        elif published and output.exists():
            shutil.rmtree(output)
        raise


def _add_selection_evidence_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument("--qa-runtime", type=Path, required=True)
    command.add_argument("--baseline-run-report", type=Path, required=True)
    command.add_argument("--baseline-visual-pack", type=Path, required=True)
    command.add_argument("--baseline-page-verdicts", type=Path, required=True)
    command.add_argument("--holdout-run-report", type=Path, required=True)
    command.add_argument("--holdout-visual-pack", type=Path, required=True)
    command.add_argument("--holdout-page-verdicts", type=Path, required=True)
    command.add_argument("--r5-evaluation-e", type=Path, required=True)
    command.add_argument("--r5-evaluation-f", type=Path, required=True)
    command.add_argument(
        "--minimum-epoch1-retention",
        type=float,
        default=DEFAULT_RETENTION_FLOOR,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    seal_verdicts = commands.add_parser(
        "seal-verdicts",
        help="seal 40 explicit human page accepts for one validated review pack",
        description=(
            "Seal an explicitly authored 40-row manual review JSONL. Every row "
            "must contain selection_index, verdict, notes, source_page_id, "
            "source_page_sha256, work_id, and chapter_id bound to the report."
        ),
    )
    seal_verdicts.add_argument("--run-report", type=Path, required=True)
    seal_verdicts.add_argument("--visual-pack", type=Path, required=True)
    seal_verdicts.add_argument("--manual-review-jsonl", type=Path, required=True)
    seal_verdicts.add_argument("--reviewer", required=True)
    seal_verdicts.add_argument("--output", type=Path, required=True)
    seal_selection = commands.add_parser(
        "seal-selection",
        help=(
            "validate all release evidence and seal explicit epoch-1 model "
            "selection provenance"
        ),
    )
    _add_selection_evidence_arguments(seal_selection)
    seal_selection.add_argument("--selected-by", required=True)
    seal_selection.add_argument("--output", type=Path, required=True)
    promote = commands.add_parser("promote")
    _add_selection_evidence_arguments(promote)
    promote.add_argument("--selected-model-provenance", type=Path, required=True)
    promote.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_release_bundle(args.output_dir)
        elif args.command == "seal-verdicts":
            result = seal_manual_page_verdicts(
                run_report=args.run_report,
                visual_pack_dir=args.visual_pack,
                manual_review_jsonl=args.manual_review_jsonl,
                reviewer=args.reviewer,
                output=args.output,
            )
        elif args.command == "seal-selection":
            result = seal_selected_model_provenance(
                qa_runtime=args.qa_runtime,
                baseline_run_report=args.baseline_run_report,
                baseline_visual_pack=args.baseline_visual_pack,
                baseline_page_verdicts=args.baseline_page_verdicts,
                holdout_run_report=args.holdout_run_report,
                holdout_visual_pack=args.holdout_visual_pack,
                holdout_page_verdicts=args.holdout_page_verdicts,
                r5_evaluation_e=args.r5_evaluation_e,
                r5_evaluation_f=args.r5_evaluation_f,
                selected_by=args.selected_by,
                output=args.output,
                minimum_epoch1_retention=args.minimum_epoch1_retention,
            )
        else:
            result = promote_runtime(
                qa_runtime=args.qa_runtime,
                baseline_run_report=args.baseline_run_report,
                baseline_visual_pack=args.baseline_visual_pack,
                baseline_page_verdicts=args.baseline_page_verdicts,
                holdout_run_report=args.holdout_run_report,
                holdout_visual_pack=args.holdout_visual_pack,
                holdout_page_verdicts=args.holdout_page_verdicts,
                r5_evaluation_e=args.r5_evaluation_e,
                r5_evaluation_f=args.r5_evaluation_f,
                selected_model_provenance=args.selected_model_provenance,
                output_dir=args.output_dir,
                minimum_epoch1_retention=args.minimum_epoch1_retention,
            )
    except QaRuntimePromotionError as error:
        raise SystemExit(str(error)) from error
    print(attach.canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
