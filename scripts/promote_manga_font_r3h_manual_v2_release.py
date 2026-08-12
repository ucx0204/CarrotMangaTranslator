#!/usr/bin/env python3
"""Promote the reviewed r3h evaluation runtime to the explicit v2 release.

This is deliberately not a generic quality-gate bypass.  It recognizes one
fixed model, one work-disjoint fresh-Gemma run, and one sealed direct visual
review.  The legacy calibration precision gate remains recorded as failed;
the v2 acceptance states that the operator explicitly accepted the observed
page-level quality for this exact release.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import attach_font_matching_selection_calibration as attach
    from scripts import package_manga_font_student_v8_qa_runtime as package
    from scripts import seal_library_full_pipeline_v11_manual_visual_review as manual
except ImportError:  # pragma: no cover - direct execution from scripts/
    import attach_font_matching_selection_calibration as attach  # type: ignore[no-redef]
    import package_manga_font_student_v8_qa_runtime as package  # type: ignore[no-redef]
    import seal_library_full_pipeline_v11_manual_visual_review as manual  # type: ignore[no-redef]


ACCEPTANCE_SCHEMA = "font-matching-runtime-release-acceptance-v2"
ACCEPTANCE_RECORD = "font_matching_runtime_release_acceptance"
ACCEPTANCE_AUTHORITY = (
    "explicit_user_approved_work_disjoint_fresh_gemma_manual_visual_review"
)
EXPECTED_MODEL_VERSION = "manga-font-v8-active21-dfa42ae17f-ffb3285338"
EXPECTED_ADAPTER_SHA256 = (
    "ff580ef87c949d9b5cc8f4552490015cb621814d6cd5c122018def415792f3de"
)
EXPECTED_RANKER_SHA256 = (
    "dfa42ae17f340768cae30f2219973eae1ff62a4c3c1544496502621e6e710c78"
)
EXPECTED_CALIBRATION_SHA256 = (
    "501c39cd12019e4334336c486a0b8a87699ea6a5e8845232af5537e0929dc3fb"
)
EXPECTED_CANDIDATE_ORDER_SHA256 = (
    "17343ec15ee2153e770101d0cbf707600e97a8bc2d490496efaf4da2f638437d"
)
EXPECTED_MANUAL_REVIEW_SHA256 = (
    "a92a751168d0cbde436371c30e1dcfe613194b80d3eff9787df6b2375f3364eb"
)
EXPECTED_MANUAL_CONTENT_SHA256 = (
    "39e45f037d15dd42f3aa74ee987a0e272d308c13115036f182fc1a6f0dfe1157"
)
EXPECTED_RUN_REPORT_SHA256 = (
    "61570016f17039e982c05afb066c92bf649a5ac837d3e8254b847b96bb2d11cb"
)
EXPECTED_VISUAL_INDEX_SHA256 = (
    "5155436a1bf25e2e5694c4cc88d1f65092245e6bc80743484e604ef7984593ad"
)
EXPECTED_COHORT_DIGEST = (
    "9c1ddde045ab0ddbad1e86fa30c20b869a112a9405eddbe404b0d1292686f5d2"
)
RELEASE_SCOPE = f"{EXPECTED_MODEL_VERSION}/r3h-manual-v2"
RELEASE_STATE = "sealed_r3h_manual_v2_production_release"
ACCEPTED_AT = "2026-08-12T03:23:41Z"


class ManualV2PromotionError(RuntimeError):
    """Raised when the fixed release evidence cannot be reproduced."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManualV2PromotionError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise ManualV2PromotionError(f"{location}: missing, linked, or non-file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ManualV2PromotionError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _sha(value: Any, location: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(char not in "0123456789abcdef" for char in value)
    ):
        raise ManualV2PromotionError(f"{location}: expected lowercase SHA-256")
    return value


def build_release_acceptance(
    *,
    source_contract_sha256: str,
    accepted_at: str,
) -> dict[str, Any]:
    """Build the fixed, transparent manual-v2 acceptance envelope."""

    return attach.seal_record(
        {
            "acceptance_authority": ACCEPTANCE_AUTHORITY,
            "accepted_at": accepted_at,
            "automatic_visual_judgment": False,
            "explicit_user_acceptance": True,
            "external_release_quality_gate_passed": True,
            "evidence": {
                "adapter_checkpoint_sha256": EXPECTED_ADAPTER_SHA256,
                "candidate_order_sha256": EXPECTED_CANDIDATE_ORDER_SHA256,
                "cohort_digest": EXPECTED_COHORT_DIGEST,
                "manual_review_content_sha256": EXPECTED_MANUAL_CONTENT_SHA256,
                "manual_review_file_sha256": EXPECTED_MANUAL_REVIEW_SHA256,
                "model_version": EXPECTED_MODEL_VERSION,
                "ranker_sha256": EXPECTED_RANKER_SHA256,
                "run_report_sha256": EXPECTED_RUN_REPORT_SHA256,
                "source_evaluation_runtime_contract_sha256": source_contract_sha256,
                "source_selection_calibration_sha256": EXPECTED_CALIBRATION_SHA256,
                "visual_review_index_sha256": EXPECTED_VISUAL_INDEX_SHA256,
            },
            "publication": {
                "evaluation_only_annotations_removed": True,
                "release_marker_has_no_qa_flags": True,
                "source_evaluation_runtime_immutable": True,
                "source_model_assets_copied_exactly": True,
            },
            "quality_gate": {
                "acceptable_pages": 15,
                "bad_pages": 5,
                "calibration_gate_waiver": {
                    "approved": True,
                    "exact_scope": RELEASE_SCOPE,
                    "reason": (
                        "explicit_user_acceptance_after_fresh_work_disjoint_"
                        "manual_review"
                    ),
                    "strict_gate_failures": {
                        "global_acceptable_at1": 22 / 31,
                        "global_precision_target": 0.88,
                        "global_preferred_at1": 13 / 31,
                        "variant_acceptable_at1": 22 / 30,
                        "variant_precision_target": 0.88,
                        "variant_preferred_at1": 13 / 30,
                    },
                },
                "calibration_release_quality_gate_passed": False,
                "distinct_chapters": 40,
                "distinct_works": 10,
                "fresh_work_disjoint_pages": 40,
                "good_pages": 10,
                "judged_content_pages": 30,
                "master_work_overlap": 0,
                "minimum_usable_rate": 0.8,
                "outline_loss_count": 0,
                "single_day_body_role_count": 0,
                "structural_error_count": 0,
                "usable_pages": 25,
                "usable_rate": 25 / 30,
            },
            "record_type": ACCEPTANCE_RECORD,
            "schema_version": ACCEPTANCE_SCHEMA,
            "status": "accepted",
        }
    )


def validate_release_acceptance(
    acceptance: Mapping[str, Any], *, source_contract_sha256: str
) -> None:
    """Rebuild the expected record so added, omitted, or changed fields fail."""

    attach.validate_record_seal(acceptance, location="v2 release acceptance")
    accepted_at = acceptance.get("accepted_at")
    if not isinstance(accepted_at, str) or not accepted_at:
        raise ManualV2PromotionError("v2 release accepted_at is invalid")
    expected = build_release_acceptance(
        source_contract_sha256=source_contract_sha256,
        accepted_at=accepted_at,
    )
    if dict(acceptance) != expected:
        raise ManualV2PromotionError("v2 release acceptance envelope drifted")


def _validate_manual_review(path: Path) -> dict[str, Any]:
    try:
        result = manual.validate_sealed_review(path.expanduser().resolve())
    except manual.ManualVisualReviewError as error:
        raise ManualV2PromotionError(str(error)) from error
    resolved = path.expanduser().resolve()
    review = _read_json(resolved, "manual visual review")
    if (
        attach.sha256_file(resolved) != EXPECTED_MANUAL_REVIEW_SHA256
        or review.get("contentSha256") != EXPECTED_MANUAL_CONTENT_SHA256
        or result.get("pages") != 40
        or result.get("judgedPages") != 30
        or result.get("verdictCounts")
        != {"acceptable": 15, "bad": 5, "good": 10, "notApplicable": 10}
        or result.get("outlineLoss") != 0
    ):
        raise ManualV2PromotionError("manual visual review evidence drifted")
    return review


def _validate_source_runtime(path: Path) -> dict[str, Any]:
    root = path.expanduser().resolve()
    try:
        validated = package._evaluation_only_validate_qa(root)  # noqa: SLF001
    except (package.MangaFontV8QaRuntimeError, attach.SelectionCalibrationAttachError) as error:
        raise ManualV2PromotionError(str(error)) from error
    contract = dict(_mapping(validated.get("contract"), "source runtime contract"))
    marker = _read_json(root / attach.MARKER_FILE, "source runtime marker")
    head = _mapping(contract.get("head"), "source runtime head")
    catalog = _mapping(contract.get("catalog"), "source runtime catalog")
    if (
        contract.get("model_version") != EXPECTED_MODEL_VERSION
        or head.get("body_checkpoint_sha256") != EXPECTED_ADAPTER_SHA256
        or head.get("variant_checkpoint_sha256") != EXPECTED_ADAPTER_SHA256
        or head.get("onnx_sha256") != EXPECTED_RANKER_SHA256
        or catalog.get("candidate_order_sha256") != EXPECTED_CANDIDATE_ORDER_SHA256
        or marker.get("qa_only") is not True
        or marker.get("release_approved") is not False
        or attach.sha256_file(root / attach.SELECTION_CALIBRATION_FILE)
        != EXPECTED_CALIBRATION_SHA256
    ):
        raise ManualV2PromotionError("source evaluation runtime identity drifted")
    return {"root": root, "contract": contract, "marker": marker}


def _strip_evaluation_only(contract: Mapping[str, Any]) -> dict[str, Any]:
    stripped = attach._strip_evaluation_only_contract_annotations(contract)  # noqa: SLF001
    stripped.pop("record_sha256", None)
    if (
        stripped.get("evaluation_only_runtime") is not None
        or stripped.get("release_acceptance") is not None
    ):
        raise ManualV2PromotionError("evaluation-only annotations were not removed")
    packaging = _mapping(stripped.get("v8_runtime_packaging"), "v8 packaging")
    if packaging.get("quality_gate_bypassed") is not False:
        raise ManualV2PromotionError("v8 packaging bypass was not closed")
    return stripped


def _publish_marker(root: Path, source_marker: Mapping[str, Any]) -> None:
    marker = dict(source_marker)
    marker.pop("qa_only", None)
    marker.pop("release_approved", None)
    artifacts = dict(_mapping(marker.get("artifacts"), "release marker artifacts"))
    artifacts[attach.CONTRACT_FILE] = attach.sha256_file(root / attach.CONTRACT_FILE)
    marker["artifacts"] = artifacts
    (root / attach.MARKER_FILE).write_bytes(attach.json_bytes(marker, pretty=True))


def _validate_release(root: Path) -> Mapping[str, Any]:
    resolved = root.expanduser().resolve()
    package._exact_inventory(resolved, attach.ATTACHED_BUNDLE_FILES, "v2 release")  # noqa: SLF001
    marker = _read_json(resolved / attach.MARKER_FILE, "v2 release marker")
    if "qa_only" in marker or "release_approved" in marker:
        raise ManualV2PromotionError("v2 release marker still contains QA flags")
    contract = _read_json(resolved / attach.CONTRACT_FILE, "v2 release contract")
    acceptance = _mapping(contract.get("release_acceptance"), "release acceptance")
    source_sha = _sha(
        _mapping(acceptance.get("evidence"), "release evidence").get(
            "source_evaluation_runtime_contract_sha256"
        ),
        "source evaluation runtime contract SHA",
    )
    validate_release_acceptance(acceptance, source_contract_sha256=source_sha)
    if contract.get("evaluation_only_runtime") is not None:
        raise ManualV2PromotionError("v2 release retained evaluation-only state")
    attach.validate_record_seal(contract, location="v2 release contract")
    marker_artifacts = _mapping(marker.get("artifacts"), "release marker artifacts")
    for name in attach.ATTACHED_ASSET_FILES:
        if marker_artifacts.get(name) != attach.sha256_file(resolved / name):
            raise ManualV2PromotionError(f"v2 release marker hash drifted: {name}")
    reconstructed = attach._reconstructed_source_contract_sha256(contract)  # noqa: SLF001
    try:
        attach.validate_selection_calibration(
            resolved / attach.SELECTION_CALIBRATION_FILE,
            contract=contract,
            runtime_contract_sha256=reconstructed,
            allow_failed_preferred_precision=True,
        )
    except attach.SelectionCalibrationAttachError as error:
        raise ManualV2PromotionError(str(error)) from error
    return {
        "candidate_count": len(
            list(_mapping(contract.get("catalog"), "catalog")["candidate_ids"])
        ),
        "contract_sha256": attach.sha256_file(resolved / attach.CONTRACT_FILE),
        "marker_sha256": attach.sha256_file(resolved / attach.MARKER_FILE),
        "model_version": contract.get("model_version"),
        "output_dir": str(resolved),
        "status": RELEASE_STATE,
    }


def promote(
    *, source_runtime: Path, manual_review: Path, output_dir: Path
) -> Mapping[str, Any]:
    source = _validate_source_runtime(source_runtime)
    _validate_manual_review(manual_review)
    output = output_dir.expanduser().resolve()
    if output.exists():
        raise ManualV2PromotionError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging_parent = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    staging = staging_parent / "release"
    published = False
    try:
        staging.mkdir()
        source_root = Path(source["root"])
        for name in attach.ATTACHED_BUNDLE_FILES:
            if name in {attach.MARKER_FILE, attach.CONTRACT_FILE}:
                continue
            shutil.copy2(source_root / name, staging / name)
        source_contract_path = source_root / attach.CONTRACT_FILE
        source_contract_sha = attach.sha256_file(source_contract_path)
        contract = _strip_evaluation_only(source["contract"])
        contract["release_acceptance"] = build_release_acceptance(
            source_contract_sha256=source_contract_sha,
            accepted_at=ACCEPTED_AT,
        )
        sealed = attach.seal_record(contract)
        (staging / attach.CONTRACT_FILE).write_bytes(
            attach.json_bytes(sealed, pretty=True)
        )
        _publish_marker(staging, source["marker"])
        _validate_release(staging)
        os.rename(staging, output)
        published = True
        return _validate_release(output)
    except BaseException:
        if published and output.exists():
            shutil.rmtree(output)
        raise
    finally:
        if staging_parent.exists():
            shutil.rmtree(staging_parent)


def validate(*, output_dir: Path) -> Mapping[str, Any]:
    return _validate_release(output_dir)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    promote_command = commands.add_parser("promote")
    promote_command.add_argument("--source-runtime", type=Path, required=True)
    promote_command.add_argument("--manual-review", type=Path, required=True)
    promote_command.add_argument("--output-dir", type=Path, required=True)
    validate_command = commands.add_parser("validate")
    validate_command.add_argument("--output-dir", type=Path, required=True)
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = (
            promote(
                source_runtime=args.source_runtime,
                manual_review=args.manual_review,
                output_dir=args.output_dir,
            )
            if args.command == "promote"
            else validate(output_dir=args.output_dir)
        )
    except (ManualV2PromotionError, package.MangaFontV8QaRuntimeError) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
