#!/usr/bin/env python3
"""Package a sealed v8 graph as a calibration-gated application QA runtime.

The v8 exporter intentionally emits only four runtime assets plus its own
report and marker.  This tool provides the narrow bridge to the application's
runtime contract without treating graph parity, the old v7 release, or a
training-time validation score as release authority.

Workflow:

1. ``build-base`` verifies a v8 graph bundle, a previously released v7 runtime,
   and the separately sealed, work-disjoint visual-review validation report.
   That report is explicitly *not* human gold or an independent test.  The
   command publishes the six-file v2 base runtime.  The application still
   fails closed because the required seventh file (selection calibration) is
   absent.
2. Build a role-routed selection calibration with
   ``build_font_matching_selection_calibration.py``.  The shared-score-only
   rank-preserving v7 calibrator is deliberately incompatible with v8.
3. ``attach-qa`` invokes the canonical strict attachment path, then adds only
   the explicit QA marker flags.  No preferred/precision quality gate bypass is
   accepted.
4. ``attach-evaluation-only`` is a separate diagnostic path for running the
   failed calibration through the frozen 40-page harness.  It seals
   ``quality_gate_bypassed=true``, ``evaluation_only=true``, and
   ``non_promotable=true`` into the contract; the normal loader cannot open it
   and the release promoter rejects it even if later QA happens to look good.
5. The existing library-QA promotion tool remains the sole release path, but
   it must receive newly generated E/F evidence bound to the v8 adapter hash;
   the old v7 epoch-1 evidence is intentionally not reusable.
"""

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
    from scripts import attach_font_matching_selection_calibration as attach
    from scripts import export_manga_font_student_v8_runtime_onnx as graph_export
    from scripts import promote_font_matching_qa_runtime_release as promote
except ImportError:  # pragma: no cover - direct execution from scripts/
    import attach_font_matching_selection_calibration as attach  # type: ignore[no-redef]
    import export_manga_font_student_v8_runtime_onnx as graph_export  # type: ignore[no-redef]
    import promote_font_matching_qa_runtime_release as promote  # type: ignore[no-redef]


SCHEMA_VERSION = "manga-font-v8-qa-runtime-packaging-v2"
VISUAL_HOLDOUT_EVALUATION_SCHEMA = "manga-font-v8-visual-holdout-evaluation-v2"
VISUAL_HOLDOUT_EVALUATION_RECORD = "manga_font_v8_visual_holdout_evaluation"
VISUAL_HOLDOUT_AUTHORITY = (
    "visual_reviewed_work_disjoint_holdout_not_human_gold"
)
ADAPTER_SELECTION_AUTHORITY = "checkpoint_selection_only_not_base_independent"
V8_EVIDENCE_SCHEMA = "manga-font-v8-role-family-pixel-evidence-v1"
BASE_STATE = "sealed_v8_base_requires_selection_calibration"
QA_STATE = "sealed_v8_qa_runtime"
EVALUATION_ONLY_STATE = "sealed_v8_evaluation_only_runtime"

BASE_FILES = attach.BASE_BUNDLE_FILES
ATTACHED_FILES = attach.ATTACHED_BUNDLE_FILES
RUNTIME_ASSETS = attach.BASE_ASSET_FILES
MIN_VISUAL_HOLDOUT_ROWS = 400
EXPECTED_VISUAL_HOLDOUT_WORKS = 4
EXPECTED_ADAPTER_SELECTION_WORKS = 5
R3_DATASET_SHA256 = "901ee8a0f6e72d42ee917a6827bc76009245ebeda0c479e9e02feb4238107f83"
QUALITY_THRESHOLDS = {
    "acceptable_at1": 0.65,
    "family_accuracy": 0.75,
    "preferred_at1": 0.50,
    "single_day_body_false_top1_rate": 0.0025,
    "single_day_all_top1_rate": 0.01,
    "single_day_positive_precision": 0.80,
    "top1_max_candidate_share": 0.65,
}


class MangaFontV8QaRuntimeError(ValueError):
    """Raised when a v8 QA runtime cannot be proven safe and reproducible."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV8QaRuntimeError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise MangaFontV8QaRuntimeError(f"{location}: expected list")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise MangaFontV8QaRuntimeError(f"{location}: expected non-empty text")
    return value


def _sha(value: Any, location: str) -> str:
    result = _text(value, location)
    if len(result) != 64 or any(char not in "0123456789abcdef" for char in result):
        raise MangaFontV8QaRuntimeError(f"{location}: expected lowercase SHA-256")
    return result


def _number(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MangaFontV8QaRuntimeError(f"{location}: expected number")
    result = float(value)
    if not (result == result and abs(result) != float("inf")):
        raise MangaFontV8QaRuntimeError(f"{location}: expected finite number")
    return result


def _integer(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise MangaFontV8QaRuntimeError(
            f"{location}: expected integer >= {minimum}"
        )
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise MangaFontV8QaRuntimeError(f"{location}: missing, linked, or non-file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MangaFontV8QaRuntimeError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _validate_seal(record: Mapping[str, Any], location: str) -> str:
    declared = _sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = dict(record)
    core.pop("record_sha256", None)
    actual = attach.seal_record(core)["record_sha256"]
    if declared != actual:
        raise MangaFontV8QaRuntimeError(f"{location}: record seal mismatch")
    return declared


def _safe_directory(path: Path, location: str) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontV8QaRuntimeError(f"unsafe {location}: {result}")
    return result


def _exact_inventory(root: Path, expected: frozenset[str], location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV8QaRuntimeError(f"{location}: missing or linked directory")
    entries = list(root.iterdir())
    if (
        {entry.name for entry in entries} != set(expected)
        or any(entry.is_symlink() or not entry.is_file() for entry in entries)
    ):
        raise MangaFontV8QaRuntimeError(f"{location}: exact inventory drifted")


def _descriptor(path: Path, *, logical_file: str | None = None) -> dict[str, Any]:
    return attach._artifact_descriptor(  # noqa: SLF001
        path, file_name=logical_file or path.name
    )


def _validate_graph_bundle(root: Path) -> dict[str, Any]:
    graph = _safe_directory(root, "graph bundle")
    _exact_inventory(graph, graph_export.OUTPUT_FILES, "graph bundle")
    marker = _read_json(graph / graph_export.MARKER_FILE, "graph marker")
    report = _read_json(graph / graph_export.REPORT_FILE, "graph report")
    _validate_seal(marker, "graph marker")
    report_record_sha = _validate_seal(report, "graph report")
    if (
        marker.get("owner") != graph_export.OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != graph_export.SCHEMA_VERSION
        or report.get("schema_version") != graph_export.SCHEMA_VERSION
        or report.get("record_type")
        != "manga_font_student_v8_role_family_onnx_graph_report"
    ):
        raise MangaFontV8QaRuntimeError("graph marker/report identity drifted")
    artifacts = _mapping(marker.get("artifacts"), "graph marker.artifacts")
    expected_marker_names = graph_export.OUTPUT_FILES - {graph_export.MARKER_FILE}
    if set(artifacts) != set(expected_marker_names):
        raise MangaFontV8QaRuntimeError("graph marker artifact inventory drifted")
    for name in expected_marker_names:
        if artifacts.get(name) != attach.sha256_file(graph / name):
            raise MangaFontV8QaRuntimeError(f"graph artifact hash drifted: {name}")
    report_artifacts = _mapping(report.get("artifacts"), "graph report.artifacts")
    if set(report_artifacts) != set(RUNTIME_ASSETS):
        raise MangaFontV8QaRuntimeError("graph report runtime inventory drifted")
    for name in RUNTIME_ASSETS:
        declared = _mapping(report_artifacts.get(name), f"graph report.{name}")
        path = graph / name
        if (
            declared.get("sha256") != attach.sha256_file(path)
            or declared.get("byte_size") != path.stat().st_size
        ):
            raise MangaFontV8QaRuntimeError(
                f"graph report descriptor drifted: {name}"
            )
    authority = _mapping(report.get("authority"), "graph report.authority")
    family = _mapping(
        report.get("family_score_contract"), "graph report.family_score_contract"
    )
    parity = _mapping(report.get("parity"), "graph report.parity")
    if (
        authority.get("automatic_mutation_allowed") is not False
        or authority.get("quality_gate_authority") is not False
        or authority.get("state") != "qa_only_unattached_graph_bundle"
        or family.get("body_and_variant_share_exact_scores") is not False
        or family.get("candidate_scores_compatibility_alias")
        != "body_candidate_scores"
        or family.get("role_logits") != "pixel_query_role_family_adapter"
        or _number(parity.get("body_variant_max_abs_delta"), "graph branch delta")
        <= 1e-6
        or _number(parity.get("role_logit_max_span"), "graph role span") <= 1e-6
    ):
        raise MangaFontV8QaRuntimeError("graph safety/branch evidence failed")
    candidate_ids = tuple(
        _text(value, f"graph candidate_ids[{index}]")
        for index, value in enumerate(
            _list(report.get("candidate_ids"), "graph candidate_ids")
        )
    )
    if len(candidate_ids) != 21 or len(set(candidate_ids)) != len(candidate_ids):
        raise MangaFontV8QaRuntimeError("graph candidate inventory drifted")
    inputs = _mapping(report.get("inputs"), "graph report.inputs")
    return {
        "root": graph,
        "report": report,
        "report_record_sha256": report_record_sha,
        "report_sha256": attach.sha256_file(graph / graph_export.REPORT_FILE),
        "candidate_ids": candidate_ids,
        "adapter_checkpoint_sha256": _sha(
            inputs.get("adapter_checkpoint_sha256"), "adapter checkpoint SHA"
        ),
        "adapter_manifest_sha256": _sha(
            inputs.get("adapter_manifest_sha256"), "adapter manifest SHA"
        ),
    }


def _validate_v7_release(root: Path) -> dict[str, Any]:
    release = _safe_directory(root, "v7 release")
    try:
        result = promote.validate_release_bundle(release)
    except (promote.QaRuntimePromotionError, attach.SelectionCalibrationAttachError) as error:
        raise MangaFontV8QaRuntimeError(f"v7 release validation failed: {error}") from error
    contract = _read_json(release / attach.CONTRACT_FILE, "v7 release contract")
    active = _read_json(
        release / attach.ACTIVE_CATALOG_FILE, "v7 release active catalog"
    )
    if not str(contract.get("model_version", "")).startswith("manga-font-v7-"):
        raise MangaFontV8QaRuntimeError("template is not a v7 manga-font release")
    return {
        "root": release,
        "contract": contract,
        "active": active,
        "validation": dict(result),
        "contract_sha256": attach.sha256_file(release / attach.CONTRACT_FILE),
        "marker_sha256": attach.sha256_file(release / attach.MARKER_FILE),
    }


def _evaluation_checks(metrics: Mapping[str, Any], row_count: int) -> dict[str, bool]:
    return {
        "acceptable_at1_at_least_0_65": _number(
            metrics.get("acceptable_at1"), "evaluation acceptable_at1"
        )
        >= QUALITY_THRESHOLDS["acceptable_at1"],
        "evaluated_positive_rows_at_least_400": (
            row_count >= MIN_VISUAL_HOLDOUT_ROWS
        ),
        "family_accuracy_at_least_0_75": _number(
            metrics.get("family_accuracy"), "evaluation family_accuracy"
        )
        >= QUALITY_THRESHOLDS["family_accuracy"],
        "preferred_at1_at_least_0_50": _number(
            metrics.get("preferred_at1"), "evaluation preferred_at1"
        )
        >= QUALITY_THRESHOLDS["preferred_at1"],
        "single_day_body_false_top1_at_most_0_0025": _number(
            metrics.get("single_day_body_false_top1_rate"),
            "evaluation single-day body false top1",
        )
        <= QUALITY_THRESHOLDS["single_day_body_false_top1_rate"],
        "single_day_all_top1_rate_at_most_0_01": _number(
            metrics.get("single_day_all_top1_rate"),
            "evaluation single-day all-row top1 rate",
        )
        <= QUALITY_THRESHOLDS["single_day_all_top1_rate"],
        "single_day_positive_precision_at_least_0_80_or_predicted_zero": (
            _integer(
                metrics.get("single_day_predicted_count"),
                "evaluation single-day predicted count",
            )
            == 0
            or _number(
                metrics.get("single_day_positive_precision"),
                "evaluation single-day positive precision",
            )
            >= QUALITY_THRESHOLDS["single_day_positive_precision"]
        ),
        "top1_max_candidate_share_at_most_0_65": _number(
            metrics.get("top1_max_candidate_share"),
            "evaluation top1 maximum candidate share",
        )
        <= QUALITY_THRESHOLDS["top1_max_candidate_share"],
    }


def _evaluation_authority_record(authority: str) -> dict[str, Any]:
    if authority not in {VISUAL_HOLDOUT_AUTHORITY, ADAPTER_SELECTION_AUTHORITY}:
        raise MangaFontV8QaRuntimeError("visual holdout authority is unsupported")
    return {
        "authority": authority,
        "base_independent_evaluation": False,
        "checkpoint_selection_only": True,
        "human_gold": False,
        "independent_gold": False,
        "quality_gate_authority": "qa_packaging_only_not_release",
        "release_quality_gate_authority": False,
        "training_eligible": False,
    }


def _evaluation_boundary_record(
    *, row_count: int, routing_row_count: int, work_count: int
) -> dict[str, Any]:
    return {
        "base_independent_evaluation": False,
        "checkpoint_selection_rows": row_count,
        "evaluation_work_count": work_count,
        "gradient_fit_rows": 0,
        "human_gold": False,
        "independent_test": False,
        "pixel_routing_audit_rows": routing_row_count,
        "pseudo_visual_review": True,
        "source_page_disjoint_from_training": True,
        "split": "val",
        "training_work_overlap_count": 0,
        "used_for_checkpoint_selection": True,
        "work_disjoint_from_gradient_training": True,
    }


def _evaluation_dataset_lineage(
    *,
    record: Mapping[str, Any],
    bindings: Mapping[str, Any],
    authority_name: str,
) -> dict[str, Any]:
    evaluated_sha256 = _sha(
        bindings.get("dataset_npz_sha256"), "evaluation dataset NPZ SHA"
    )
    base_sha256 = (
        R3_DATASET_SHA256
        if authority_name == ADAPTER_SELECTION_AUTHORITY
        else evaluated_sha256
    )
    training_overlay = evaluated_sha256 != base_sha256
    expected = {
        "adapter_manifest_sha256": _sha(
            bindings.get("adapter_manifest_sha256"), "adapter manifest SHA"
        ),
        "base_dataset_npz_sha256": base_sha256,
        "dataset_manifest_sha256": _sha(
            bindings.get("dataset_manifest_sha256"), "dataset manifest SHA"
        ),
        "evaluated_dataset_npz_sha256": evaluated_sha256,
        "profile": (
            "r3_body_holdout_checkpoint_selection"
            if authority_name == ADAPTER_SELECTION_AUTHORITY
            else "legacy_four_work_checkpoint_selection"
        ),
        "training_overlay": training_overlay,
        "validation_arrays_byte_identical_to_base": True,
    }
    declared = record.get("dataset_lineage")
    # Existing direct-base evaluations predate the explicit lineage record.  An
    # overlay is never grandfathered: it must carry the full sealed two-SHA
    # lineage and byte-identical validation assertion.
    if declared is None and not training_overlay:
        return expected
    if dict(_mapping(declared, "evaluation.dataset_lineage")) != expected:
        raise MangaFontV8QaRuntimeError(
            "adapter-selection evaluation dataset lineage failed"
        )
    return expected


def _validate_visual_holdout_evaluation(
    path: Path, *, graph: Mapping[str, Any]
) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    record = _read_json(resolved, "visual holdout evaluation")
    record_sha = _validate_seal(record, "visual holdout evaluation")
    if (
        record.get("schema_version") != VISUAL_HOLDOUT_EVALUATION_SCHEMA
        or record.get("record_type") != VISUAL_HOLDOUT_EVALUATION_RECORD
    ):
        raise MangaFontV8QaRuntimeError("visual holdout evaluation schema drifted")
    candidate_ids = tuple(
        _text(value, f"evaluation candidate_ids[{index}]")
        for index, value in enumerate(
            _list(record.get("candidate_ids"), "evaluation candidate_ids")
        )
    )
    if candidate_ids != graph["candidate_ids"]:
        raise MangaFontV8QaRuntimeError("evaluation candidate order drifted")
    authority = _mapping(record.get("authority"), "evaluation.authority")
    authority_name = _text(
        authority.get("authority"), "evaluation.authority.authority"
    )
    required_authority = _evaluation_authority_record(authority_name)
    if dict(authority) != required_authority:
        raise MangaFontV8QaRuntimeError(
            "visual holdout authority was upgraded or drifted"
        )
    bindings = _mapping(record.get("bindings"), "evaluation.bindings")
    expected_bindings = {
        "adapter_checkpoint_sha256",
        "adapter_manifest_sha256",
        "candidate_order_sha256",
        "dataset_manifest_sha256",
        "dataset_npz_sha256",
    }
    if set(bindings) != expected_bindings:
        raise MangaFontV8QaRuntimeError("visual holdout binding schema drifted")
    for key in expected_bindings:
        _sha(bindings.get(key), f"evaluation.bindings.{key}")
    if (
        bindings.get("candidate_order_sha256")
        != attach._ordered_values_sha256(candidate_ids)  # noqa: SLF001
        or bindings.get("adapter_manifest_sha256")
        != graph["adapter_manifest_sha256"]
        or bindings.get("adapter_checkpoint_sha256")
        != graph["adapter_checkpoint_sha256"]
    ):
        raise MangaFontV8QaRuntimeError(
            "visual holdout evaluation adapter/candidate binding failed"
        )
    dataset_lineage = _evaluation_dataset_lineage(
        record=record,
        bindings=bindings,
        authority_name=authority_name,
    )
    boundary = _mapping(record.get("boundary"), "evaluation.boundary")
    row_count = _integer(
        record.get("evaluated_positive_rows"),
        "evaluation.evaluated_positive_rows",
        minimum=1,
    )
    expected_works = (
        EXPECTED_ADAPTER_SELECTION_WORKS
        if authority_name == ADAPTER_SELECTION_AUTHORITY
        else EXPECTED_VISUAL_HOLDOUT_WORKS
    )
    routing_rows = _integer(
        boundary.get("pixel_routing_audit_rows"),
        "evaluation pixel routing audit rows",
        minimum=1,
    )
    required_boundary = _evaluation_boundary_record(
        row_count=row_count,
        routing_row_count=routing_rows,
        work_count=expected_works,
    )
    if dict(boundary) != required_boundary or row_count < MIN_VISUAL_HOLDOUT_ROWS:
        raise MangaFontV8QaRuntimeError("visual holdout evaluation boundary failed")
    metrics = _mapping(record.get("metrics"), "evaluation.metrics")
    checks = _evaluation_checks(metrics, row_count)
    gate = _mapping(record.get("quality_gate"), "evaluation.quality_gate")
    declared_checks = _mapping(gate.get("checks"), "evaluation quality checks")
    if (
        set(gate)
        != {
            "authority",
            "checks",
            "passed",
            "release_quality_gate_authority",
        }
        or gate.get("authority") != "qa_packaging_only_not_release"
        or gate.get("release_quality_gate_authority") is not False
        or set(declared_checks) != set(checks)
        or any(declared_checks.get(key) is not expected for key, expected in checks.items())
        or gate.get("passed") is not True
        or not all(checks.values())
    ):
        raise MangaFontV8QaRuntimeError("visual holdout evaluation quality gate failed")
    sample_work_order_sha = _sha(
        record.get("sample_work_order_sha256"),
        "evaluation sample/work order SHA",
    )
    return {
        "path": resolved,
        "record": record,
        "record_sha256": record_sha,
        "sha256": attach.sha256_file(resolved),
        "metrics": dict(metrics),
        "authority": authority_name,
        "dataset_lineage": dataset_lineage,
        "row_count": row_count,
        "sample_work_order_sha256": sample_work_order_sha,
    }


def _validate_source_alignment(
    graph: Mapping[str, Any], template: Mapping[str, Any]
) -> None:
    graph_root = graph["root"]
    active = _read_json(graph_root / attach.ACTIVE_CATALOG_FILE, "graph active catalog")
    template_active = template["active"]
    graph_candidates = tuple(active.get("candidate_ids", ()))
    if (
        graph_candidates != graph["candidate_ids"]
        or graph_candidates != tuple(template_active.get("candidate_ids", ()))
        or active.get("candidate_order_sha256")
        != template_active.get("candidate_order_sha256")
        or active.get("catalog_version") != template_active.get("catalog_version")
        or active.get("record_sha256") != template_active.get("record_sha256")
        or attach.sha256_file(graph_root / attach.ACTIVE_CATALOG_FILE)
        != attach.sha256_file(template["root"] / attach.ACTIVE_CATALOG_FILE)
    ):
        raise MangaFontV8QaRuntimeError("graph/v7 release catalog binding drifted")


def _v8_contract(
    *,
    staging: Path,
    graph: Mapping[str, Any],
    template: Mapping[str, Any],
    evaluation: Mapping[str, Any],
) -> dict[str, Any]:
    source = copy.deepcopy(template["contract"])
    source.pop("record_sha256", None)
    source.pop("release_acceptance", None)
    source.pop("font_family_evidence", None)
    source["artifacts"] = {
        name: _descriptor(staging / name, logical_file=name) for name in RUNTIME_ASSETS
    }
    catalog = dict(_mapping(source.get("catalog"), "template catalog"))
    catalog["font_prototypes_sha256"] = attach.sha256_file(
        staging / attach.PROTOTYPE_FILE
    )
    source["catalog"] = catalog
    source["calibration"] = {
        "calibration_split": "val",
        "none_threshold": 0.5,
        "none_threshold_selection_metric": "neutral_compatibility_output",
        "temperature": 1.0,
        "temperature_selection_metric": "requires_v8_role_routed_calibration",
    }
    # The six-file bundle cannot pass application runtime validation because the
    # selection-calibration descriptor/file is absent.  Keeping the activation-
    # ready deployment envelope unchanged is required by the canonical
    # calibration contract reconstruction used by both Python and TypeScript.
    source["deployment"] = {
        "automatic_mutation_allowed": True,
        "fail_closed": True,
        "fallback_policy": copy.deepcopy(
            _mapping(
                _mapping(template["contract"].get("deployment"), "deployment").get(
                    "fallback_policy"
                ),
                "fallback policy",
            )
        ),
        "state": "ready",
    }
    graph_root = graph["root"]
    ranker_sha = attach.sha256_file(graph_root / attach.RANKER_FILE)
    adapter_manifest_sha = graph["adapter_manifest_sha256"]
    adapter_checkpoint_sha = graph["adapter_checkpoint_sha256"]
    head = dict(_mapping(source.get("head"), "template head"))
    architecture = dict(_mapping(head.get("architecture"), "template architecture"))
    architecture["role_family_adapter"] = {
        "candidate_bias": "bounded_zero_mean_role_family_only",
        "family_count": 2,
        "geometry_input": False,
        "score_branches": "separate_body_variant_query_mixtures",
        "text_or_font_name_or_gemma_input": False,
    }
    head.update(
        {
            "architecture": architecture,
            "body_checkpoint_sha256": adapter_checkpoint_sha,
            "family_score_sharing": "separate_body_variant_pixel_scores",
            "onnx_sha256": ranker_sha,
            "variant_checkpoint_sha256": adapter_checkpoint_sha,
            "version": "manga-font-v8-role-family-adapter-ranker-onnx-v1",
        }
    )
    source["head"] = head
    encoder = dict(_mapping(source.get("encoder"), "template encoder"))
    encoder["onnx_sha256"] = attach.sha256_file(graph_root / attach.ENCODER_FILE)
    source["encoder"] = encoder
    source["model_version"] = (
        f"manga-font-v8-active21-{ranker_sha[:10]}-"
        f"{evaluation['record_sha256'][:10]}"
    )
    source["v8_font_family_evidence"] = {
        "body_and_variant_share_exact_scores": False,
        "candidate_scores_compatibility_alias": "body_candidate_scores",
        "forbidden_model_inputs": ["font_name", "gemma", "genre", "text"],
        "role_logits": "pixel_query_role_family_adapter",
        "schema_version": V8_EVIDENCE_SCHEMA,
    }
    source["v8_runtime_packaging"] = {
        "automatic_mutation_before_selection_calibration": False,
        "graph_report_record_sha256": graph["report_record_sha256"],
        "graph_report_sha256": graph["report_sha256"],
        "quality_gate_bypassed": False,
        "schema_version": SCHEMA_VERSION,
        "selection_calibration_required": True,
        "v7_release_contract_sha256": template["contract_sha256"],
        "v7_release_marker_sha256": template["marker_sha256"],
        "visual_holdout_authority": evaluation["authority"],
        "visual_holdout_evaluation_record_sha256": evaluation[
            "record_sha256"
        ],
        "visual_holdout_evaluation_sha256": evaluation["sha256"],
        "visual_holdout_dataset_lineage": copy.deepcopy(
            evaluation["dataset_lineage"]
        ),
    }
    source["release_evaluation"] = {
        "authority": evaluation["authority"],
        "base_independent_evaluation": False,
        "dataset_lineage": copy.deepcopy(evaluation["dataset_lineage"]),
        "evaluated_row_count": evaluation["row_count"],
        "evaluation_report_sha256": evaluation["sha256"],
        "human_gold": False,
        "independent_test": False,
        "metrics": copy.deepcopy(evaluation["metrics"]),
        "quality_gate_authority": "qa_packaging_only_not_release",
        "sample_work_order_sha256": evaluation["sample_work_order_sha256"],
        "status": (
            "v8_checkpoint_selection_qa_gate_passed_"
            "not_base_independent_not_human_gold"
        ),
        "thresholds": copy.deepcopy(QUALITY_THRESHOLDS),
    }
    provenance = dict(_mapping(source.get("provenance"), "template provenance"))
    provenance.update(
        {
            "export_validation": copy.deepcopy(graph["report"]["parity"]),
            "v8_adapter_manifest_sha256": adapter_manifest_sha,
            "v8_adapter_checkpoint_sha256": adapter_checkpoint_sha,
            "v8_graph_report_sha256": graph["report_sha256"],
            "v8_visual_holdout_evaluation_sha256": evaluation["sha256"],
            "v8_visual_holdout_base_dataset_npz_sha256": evaluation[
                "dataset_lineage"
            ]["base_dataset_npz_sha256"],
            "v8_visual_holdout_evaluated_dataset_npz_sha256": evaluation[
                "dataset_lineage"
            ]["evaluated_dataset_npz_sha256"],
            "v7_release_template_contract_sha256": template["contract_sha256"],
        }
    )
    source["provenance"] = provenance
    return attach.seal_record(source)


def _base_marker(staging: Path, contract: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "artifacts": {
            name: attach.sha256_file(staging / name)
            for name in (attach.CONTRACT_FILE, *RUNTIME_ASSETS)
        },
        "owner": attach._runtime_owner(contract["schema_version"]),  # noqa: SLF001
        "safe_replace": True,
        "schema_version": contract["schema_version"],
    }


def _source_context(
    *, graph_bundle: Path, v7_release: Path, visual_holdout_evaluation: Path
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    graph = _validate_graph_bundle(graph_bundle)
    template = _validate_v7_release(v7_release)
    _validate_source_alignment(graph, template)
    evaluation = _validate_visual_holdout_evaluation(
        visual_holdout_evaluation, graph=graph
    )
    return graph, template, evaluation


def _validate_base_with_context(
    *,
    output_dir: Path,
    graph: Mapping[str, Any],
    template: Mapping[str, Any],
    evaluation: Mapping[str, Any],
) -> Mapping[str, Any]:
    root = _safe_directory(output_dir, "base runtime")
    _exact_inventory(root, BASE_FILES, "v8 base runtime")
    try:
        snapshot = attach._validate_base_bundle(root)  # noqa: SLF001
    except attach.SelectionCalibrationAttachError as error:
        raise MangaFontV8QaRuntimeError(str(error)) from error
    contract = snapshot["contract"]
    packaging = _mapping(contract.get("v8_runtime_packaging"), "v8 packaging")
    evidence = _mapping(
        contract.get("v8_font_family_evidence"), "v8 family evidence"
    )
    release_evaluation = _mapping(
        contract.get("release_evaluation"), "release evaluation"
    )
    provenance = _mapping(contract.get("provenance"), "runtime provenance")
    if contract.get("font_family_evidence") is not None:
        raise MangaFontV8QaRuntimeError(
            "v8 base falsely declares the v7 shared-score evidence contract"
        )
    if (
        packaging.get("schema_version") != SCHEMA_VERSION
        or packaging.get("automatic_mutation_before_selection_calibration") is not False
        or packaging.get("selection_calibration_required") is not True
        or packaging.get("quality_gate_bypassed") is not False
        or packaging.get("graph_report_sha256") != graph["report_sha256"]
        or packaging.get("visual_holdout_authority") != evaluation["authority"]
        or packaging.get("visual_holdout_evaluation_sha256")
        != evaluation["sha256"]
        or dict(
            _mapping(
                packaging.get("visual_holdout_dataset_lineage"),
                "packaged dataset lineage",
            )
        )
        != evaluation["dataset_lineage"]
        or dict(
            _mapping(
                release_evaluation.get("dataset_lineage"),
                "release evaluation dataset lineage",
            )
        )
        != evaluation["dataset_lineage"]
        or provenance.get("v8_visual_holdout_base_dataset_npz_sha256")
        != evaluation["dataset_lineage"]["base_dataset_npz_sha256"]
        or provenance.get("v8_visual_holdout_evaluated_dataset_npz_sha256")
        != evaluation["dataset_lineage"]["evaluated_dataset_npz_sha256"]
        or packaging.get("v7_release_contract_sha256")
        != template["contract_sha256"]
        or evidence.get("schema_version") != V8_EVIDENCE_SCHEMA
        or evidence.get("body_and_variant_share_exact_scores") is not False
    ):
        raise MangaFontV8QaRuntimeError("v8 base source/evidence binding drifted")
    for name in RUNTIME_ASSETS:
        if attach.sha256_file(root / name) != attach.sha256_file(graph["root"] / name):
            raise MangaFontV8QaRuntimeError(f"base graph byte drifted: {name}")
    return {
        "automatic_mutation_allowed_before_calibration": False,
        "candidate_count": len(graph["candidate_ids"]),
        "contract_sha256": attach.sha256_file(root / attach.CONTRACT_FILE),
        "model_version": contract["model_version"],
        "output_dir": str(root),
        "quality_gate_bypassed": False,
        "selection_calibration_required": True,
        "status": BASE_STATE,
    }


def build_base(
    *,
    graph_bundle: Path,
    v7_release: Path,
    visual_holdout_evaluation: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    graph, template, evaluation = _source_context(
        graph_bundle=graph_bundle,
        v7_release=v7_release,
        visual_holdout_evaluation=visual_holdout_evaluation,
    )
    output = _safe_directory(output_dir, "output directory")
    if output.exists():
        raise MangaFontV8QaRuntimeError("output directory already exists")
    for source in (graph["root"], template["root"]):
        if source == output or source in output.parents or output in source.parents:
            raise MangaFontV8QaRuntimeError("output overlaps an immutable input")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        for name in RUNTIME_ASSETS:
            source = graph["root"] / name
            attach._copy_verified_file(  # noqa: SLF001
                source,
                staging / name,
                expected_sha256=attach.sha256_file(source),
            )
        contract = _v8_contract(
            staging=staging,
            graph=graph,
            template=template,
            evaluation=evaluation,
        )
        (staging / attach.CONTRACT_FILE).write_bytes(
            attach.json_bytes(contract, pretty=True)
        )
        (staging / attach.MARKER_FILE).write_bytes(
            attach.json_bytes(_base_marker(staging, contract), pretty=True)
        )
        _validate_base_with_context(
            output_dir=staging,
            graph=graph,
            template=template,
            evaluation=evaluation,
        )
        os.rename(staging, output)
        published = True
        return _validate_base_with_context(
            output_dir=output,
            graph=graph,
            template=template,
            evaluation=evaluation,
        )
    except BaseException:
        if not published and staging.exists():
            shutil.rmtree(staging)
        elif published and output.exists():
            shutil.rmtree(output)
        raise


def validate_base(
    *,
    graph_bundle: Path,
    v7_release: Path,
    visual_holdout_evaluation: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    graph, template, evaluation = _source_context(
        graph_bundle=graph_bundle,
        v7_release=v7_release,
        visual_holdout_evaluation=visual_holdout_evaluation,
    )
    return _validate_base_with_context(
        output_dir=output_dir,
        graph=graph,
        template=template,
        evaluation=evaluation,
    )


def _strict_validate_qa(root: Path) -> Mapping[str, Any]:
    try:
        attached = attach.validate_attached_runtime_bundle(
            output_dir=root, allow_qa_only=True
        )
        contract = _read_json(root / attach.CONTRACT_FILE, "QA runtime contract")
        reconstructed = attach._reconstructed_source_contract_sha256(contract)  # noqa: SLF001
        attach.validate_selection_calibration(
            root / attach.SELECTION_CALIBRATION_FILE,
            contract=contract,
            runtime_contract_sha256=reconstructed,
            allow_failed_preferred_precision=False,
        )
        identity = promote._runtime_identity(root)  # noqa: SLF001
    except (
        attach.SelectionCalibrationAttachError,
        promote.QaRuntimePromotionError,
    ) as error:
        raise MangaFontV8QaRuntimeError(str(error)) from error
    if (
        attached.get("qa_only") is not True
        or attached.get("release_approved") is not False
        or attached.get("evaluation_only") is not False
        or attached.get("quality_gate_bypassed") is not False
        or attached.get("non_promotable") is not False
    ):
        raise MangaFontV8QaRuntimeError("attached runtime is not exactly QA-only")
    return {"attached": attached, "identity": identity, "contract": contract}


def _annotate_evaluation_only_runtime(root: Path) -> None:
    contract_path = root / attach.CONTRACT_FILE
    marker_path = root / attach.MARKER_FILE
    contract = _read_json(contract_path, "evaluation-only runtime contract")
    contract.pop("record_sha256", None)
    annotated = attach._annotate_evaluation_only_contract(contract)  # noqa: SLF001
    annotated = attach.seal_record(annotated)
    contract_path.write_bytes(attach.json_bytes(annotated, pretty=True))
    marker = _read_json(marker_path, "evaluation-only runtime marker")
    if marker.get("qa_only") is not True or marker.get("release_approved") is not False:
        raise MangaFontV8QaRuntimeError(
            "evaluation-only attachment lacks the exact QA marker"
        )
    artifacts = dict(_mapping(marker.get("artifacts"), "evaluation marker artifacts"))
    artifacts[attach.CONTRACT_FILE] = attach.sha256_file(contract_path)
    marker["artifacts"] = artifacts
    marker_path.write_bytes(attach.json_bytes(marker, pretty=True))


def _evaluation_only_validate_qa(root: Path) -> Mapping[str, Any]:
    try:
        attached = attach.validate_attached_runtime_bundle(
            output_dir=root, allow_qa_only=True
        )
        contract = _read_json(root / attach.CONTRACT_FILE, "evaluation-only contract")
        reconstructed = attach._reconstructed_source_contract_sha256(contract)  # noqa: SLF001
        attach.validate_selection_calibration(
            root / attach.SELECTION_CALIBRATION_FILE,
            contract=contract,
            runtime_contract_sha256=reconstructed,
            allow_failed_preferred_precision=True,
        )
    except attach.SelectionCalibrationAttachError as error:
        raise MangaFontV8QaRuntimeError(str(error)) from error
    if (
        attached.get("qa_only") is not True
        or attached.get("release_approved") is not False
        or attached.get("evaluation_only") is not True
        or attached.get("quality_gate_bypassed") is not True
        or attached.get("non_promotable") is not True
        or contract.get("release_acceptance") is not None
    ):
        raise MangaFontV8QaRuntimeError(
            "attached runtime is not exactly evaluation-only/non-promotable"
        )
    packaging = _mapping(contract.get("v8_runtime_packaging"), "v8 packaging")
    if (
        packaging.get("evaluation_only") is not True
        or packaging.get("quality_gate_bypassed") is not True
        or packaging.get("non_promotable") is not True
        or packaging.get("loader_opt_in_required") != "allowQaOnlyRuntime"
    ):
        raise MangaFontV8QaRuntimeError(
            "evaluation-only v8 packaging boundary drifted"
        )
    catalog = _mapping(contract.get("catalog"), "evaluation-only catalog")
    candidate_ids = _list(catalog.get("candidate_ids"), "candidate ids")
    return {"attached": attached, "candidate_ids": candidate_ids, "contract": contract}


def attach_qa(
    *,
    graph_bundle: Path,
    v7_release: Path,
    visual_holdout_evaluation: Path,
    runtime_dir: Path,
    selection_calibration: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    validate_base(
        graph_bundle=graph_bundle,
        v7_release=v7_release,
        visual_holdout_evaluation=visual_holdout_evaluation,
        output_dir=runtime_dir,
    )
    output = _safe_directory(output_dir, "QA output")
    if output.exists():
        raise MangaFontV8QaRuntimeError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging_parent = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.qa-staging-", dir=output.parent)
    )
    attached_root = staging_parent / "attached"
    published = False
    try:
        # This is intentionally the strict path.  The QA bypass flag is never
        # forwarded, even though the final marker identifies the bundle as QA.
        attach.attach_selection_calibration(
            runtime_dir=runtime_dir,
            selection_calibration=selection_calibration,
            output_dir=attached_root,
            qa_only_allow_failed_quality_gate=False,
        )
        marker_path = attached_root / attach.MARKER_FILE
        marker = _read_json(marker_path, "strict attached marker")
        marker.update({"qa_only": True, "release_approved": False})
        marker_path.write_bytes(attach.json_bytes(marker, pretty=True))
        strict = _strict_validate_qa(attached_root)
        os.rename(attached_root, output)
        published = True
        strict = _strict_validate_qa(output)
        return {
            "automatic_mutation_allowed": True,
            "calibration_quality_gate_bypassed": False,
            "candidate_count": len(strict["identity"]["candidate_ids"]),
            "model_version": strict["identity"]["model_version"],
            "output_dir": str(output),
            "qa_only": True,
            "release_approved": False,
            "status": QA_STATE,
        }
    except BaseException:
        if published and output.exists():
            shutil.rmtree(output)
        raise
    finally:
        if staging_parent.exists():
            shutil.rmtree(staging_parent)


def validate_qa(
    *,
    graph_bundle: Path,
    v7_release: Path,
    visual_holdout_evaluation: Path,
    runtime_dir: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    validate_base(
        graph_bundle=graph_bundle,
        v7_release=v7_release,
        visual_holdout_evaluation=visual_holdout_evaluation,
        output_dir=runtime_dir,
    )
    root = _safe_directory(output_dir, "QA runtime")
    _exact_inventory(root, ATTACHED_FILES, "v8 QA runtime")
    strict = _strict_validate_qa(root)
    for name in RUNTIME_ASSETS:
        if attach.sha256_file(root / name) != attach.sha256_file(
            runtime_dir.expanduser().resolve() / name
        ):
            raise MangaFontV8QaRuntimeError(f"QA runtime base byte drifted: {name}")
    return {
        "automatic_mutation_allowed": True,
        "calibration_quality_gate_bypassed": False,
        "candidate_count": len(strict["identity"]["candidate_ids"]),
        "model_version": strict["identity"]["model_version"],
        "output_dir": str(root),
        "qa_only": True,
        "release_approved": False,
        "status": QA_STATE,
    }


def attach_evaluation_only(
    *,
    graph_bundle: Path,
    v7_release: Path,
    visual_holdout_evaluation: Path,
    runtime_dir: Path,
    selection_calibration: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    """Attach failed calibration solely for an explicit frozen QA harness."""

    validate_base(
        graph_bundle=graph_bundle,
        v7_release=v7_release,
        visual_holdout_evaluation=visual_holdout_evaluation,
        output_dir=runtime_dir,
    )
    output = _safe_directory(output_dir, "evaluation-only output")
    if output.exists():
        raise MangaFontV8QaRuntimeError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging_parent = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.evaluation-staging-", dir=output.parent)
    )
    attached_root = staging_parent / "attached"
    published = False
    try:
        attach.attach_selection_calibration(
            runtime_dir=runtime_dir,
            selection_calibration=selection_calibration,
            output_dir=attached_root,
            qa_only_allow_failed_quality_gate=True,
        )
        _annotate_evaluation_only_runtime(attached_root)
        validated = _evaluation_only_validate_qa(attached_root)
        os.rename(attached_root, output)
        published = True
        validated = _evaluation_only_validate_qa(output)
        return {
            "automatic_mutation_allowed_only_with_qa_harness_opt_in": True,
            "calibration_quality_gate_bypassed": True,
            "candidate_count": len(validated["candidate_ids"]),
            "evaluation_only": True,
            "loader_opt_in_required": "allowQaOnlyRuntime",
            "model_version": validated["contract"]["model_version"],
            "non_promotable": True,
            "output_dir": str(output),
            "qa_only": True,
            "release_approved": False,
            "status": EVALUATION_ONLY_STATE,
        }
    except BaseException:
        if published and output.exists():
            shutil.rmtree(output)
        raise
    finally:
        if staging_parent.exists():
            shutil.rmtree(staging_parent)


def validate_evaluation_only(
    *,
    graph_bundle: Path,
    v7_release: Path,
    visual_holdout_evaluation: Path,
    runtime_dir: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    validate_base(
        graph_bundle=graph_bundle,
        v7_release=v7_release,
        visual_holdout_evaluation=visual_holdout_evaluation,
        output_dir=runtime_dir,
    )
    root = _safe_directory(output_dir, "evaluation-only runtime")
    _exact_inventory(root, ATTACHED_FILES, "v8 evaluation-only runtime")
    validated = _evaluation_only_validate_qa(root)
    for name in RUNTIME_ASSETS:
        if attach.sha256_file(root / name) != attach.sha256_file(
            runtime_dir.expanduser().resolve() / name
        ):
            raise MangaFontV8QaRuntimeError(
                f"evaluation-only runtime base byte drifted: {name}"
            )
    return {
        "automatic_mutation_allowed_only_with_qa_harness_opt_in": True,
        "calibration_quality_gate_bypassed": True,
        "candidate_count": len(validated["candidate_ids"]),
        "evaluation_only": True,
        "loader_opt_in_required": "allowQaOnlyRuntime",
        "model_version": validated["contract"]["model_version"],
        "non_promotable": True,
        "output_dir": str(root),
        "qa_only": True,
        "release_approved": False,
        "status": EVALUATION_ONLY_STATE,
    }


def _add_source_args(command: argparse.ArgumentParser) -> None:
    command.add_argument("--graph-bundle", type=Path, required=True)
    command.add_argument("--v7-release", type=Path, required=True)
    command.add_argument("--visual-holdout-evaluation", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("build-base", "validate-base"):
        command = commands.add_parser(name)
        _add_source_args(command)
        command.add_argument("--output-dir", type=Path, required=True)
    attach_command = commands.add_parser("attach-qa")
    _add_source_args(attach_command)
    attach_command.add_argument("--runtime-dir", type=Path, required=True)
    attach_command.add_argument("--selection-calibration", type=Path, required=True)
    attach_command.add_argument("--output-dir", type=Path, required=True)
    validate_command = commands.add_parser("validate-qa")
    _add_source_args(validate_command)
    validate_command.add_argument("--runtime-dir", type=Path, required=True)
    validate_command.add_argument("--output-dir", type=Path, required=True)
    evaluation_command = commands.add_parser("attach-evaluation-only")
    _add_source_args(evaluation_command)
    evaluation_command.add_argument("--runtime-dir", type=Path, required=True)
    evaluation_command.add_argument(
        "--selection-calibration", type=Path, required=True
    )
    evaluation_command.add_argument("--output-dir", type=Path, required=True)
    validate_evaluation = commands.add_parser("validate-evaluation-only")
    _add_source_args(validate_evaluation)
    validate_evaluation.add_argument("--runtime-dir", type=Path, required=True)
    validate_evaluation.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    values = vars(args).copy()
    command = values.pop("command")
    try:
        if command == "build-base":
            result = build_base(**values)
        elif command == "validate-base":
            result = validate_base(**values)
        elif command == "attach-qa":
            result = attach_qa(**values)
        elif command == "validate-qa":
            result = validate_qa(**values)
        elif command == "attach-evaluation-only":
            result = attach_evaluation_only(**values)
        else:
            result = validate_evaluation_only(**values)
    except MangaFontV8QaRuntimeError as error:
        print(
            json.dumps(
                {"error": str(error), "status": "blocked"}, ensure_ascii=False
            )
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
