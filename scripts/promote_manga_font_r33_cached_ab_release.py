#!/usr/bin/env python3
"""Promote the fixed R33 runtime after the staged cached-page A/B review.

This is intentionally a one-model promoter, not a generic QA bypass.  It
accepts only the byte-pinned R33 QA bundle and the five byte-pinned comparison
images that were reviewed during the 1 -> 2 -> 4 staged visual check.  The
review used cached page inputs and did not rerun Gemma or inpainting; that
limitation remains explicit in the release acceptance record.
"""

from __future__ import annotations

import argparse
import hashlib
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
except ImportError:  # pragma: no cover - direct execution from scripts/
    import attach_font_matching_selection_calibration as attach  # type: ignore[no-redef]
    import package_manga_font_student_v8_qa_runtime as package  # type: ignore[no-redef]


ACCEPTANCE_SCHEMA = "font-matching-runtime-release-acceptance-v3"
ACCEPTANCE_RECORD = "font_matching_runtime_release_acceptance"
ACCEPTANCE_AUTHORITY = "explicit_user_approved_cached_page_ab_with_agent_visual_audit"
ACCEPTED_AT = "2026-08-20T21:50:16Z"
RELEASE_STATE = "sealed_r33_cached_page_ab_production_release"

EXPECTED_MODEL_VERSION = "manga-font-v9-r33-e049fc74c3ba"
EXPECTED_RANKER_SHA256 = (
    "e049fc74c3baeeee9aba179412a3b20387304b749936c167ecc753afcc78f4aa"
)
EXPECTED_CANDIDATE_ORDER_SHA256 = (
    "17343ec15ee2153e770101d0cbf707600e97a8bc2d490496efaf4da2f638437d"
)
EXPECTED_SOURCE_CONTRACT_SHA256 = (
    "c96f24268af9128d19c2b8a6ff7100c2725e8e991da9d3d6f7320b611e90b972"
)
EXPECTED_SOURCE_MARKER_SHA256 = (
    "3a794cc2f5ec75eb83f8c060138f50652d2df98ec24bc4beafe34cb1eceaa545"
)
EXPECTED_SELECTION_CALIBRATION_SHA256 = (
    "aaaaa938d5fbed6070115b2d206c6cc4a35517b3b11061fb0a4d11383caa5660"
)
EXPECTED_VISUAL_INVENTORY_SHA256 = (
    "835165dc2048c5a9a3107aa593758c22f14f0ca5940e0c7f40a896c4e4d79b42"
)
EXPECTED_SOURCE_PAGE_INVENTORY_SHA256 = (
    "2dc2352a401c7a5defa22606ac77a3e99b2a2b72c9f901a7436d4bb471d906d3"
)
EXPECTED_PAGE_CONSISTENCY_PLAN_SHA256 = (
    "099a34473124faeff0d508ae4173c8c7444904c6959558c8bf0b92dc34520352"
)
EXPECTED_PAGE_CONSISTENCY_SHARED_SHA256 = (
    "8aa94b55c963f3b236279e5f67fd9cc8aa6a4ade189bc1bbcf4760eddb427279"
)
EXPECTED_PAGE_CONSISTENCY_APPLY_SHA256 = (
    "eb30c3e7a0a0518b854b83e8ea1c8bb2414d22f1ffd073e551c2d4434b31ace4"
)

VISUAL_COMPARISONS = (
    (
        "02",
        "page02-r3h-vs-r33-semantic-labeled.png",
        2_180_096,
        "25b610fd4b61692f8f06311d233a8f95e8aff412b9d5550eb9f1f19cbf0a92d7",
        "unchanged",
    ),
    (
        "07",
        "page07-r3h-vs-r33-semantic-labeled.png",
        2_005_439,
        "f47829b25dcee8066185b74ec3482af5a13beb60272277aca2aa6e91701dd2e3",
        "improved",
    ),
    (
        "09",
        "page09-r3h-vs-r33-semantic-labeled.png",
        1_794_216,
        "b3d4336803320feec279d891f9ab53a6d39853c418856408f3627546ca33fd0b",
        "improved",
    ),
    (
        "12",
        "page12-r3h-vs-r33-semantic-labeled.png",
        3_578_732,
        "9168eb8f6ea139b3ed128c02ebaf51c1adc1b0330e504e617cc374087d898fff",
        "improved",
    ),
    (
        "17",
        "page17-r3h-vs-r33-semantic-labeled.png",
        1_732_016,
        "b3826768a04f7aa059d7231a55ae25cb2c061305d1693068119b4420c341dac0",
        "improved",
    ),
)

SOURCE_PAGES = (
    (
        "02",
        "pages/02/source/pages/019-d665eabb-c498-4362-8f62-bd08b09189fc.png",
        2_315_034,
        "8168bdfb66e17cee04fae5def88e38422beedc31b5d8aa289dee719c7f04012e",
    ),
    (
        "07",
        "pages/07/source/pages/013-5e754c12-9f21-424e-aa7a-e8e9627799eb.jpg",
        401_427,
        "4912467ca265935cc7e71728e128b926833b378ff67284158a6d7791f86604f8",
    ),
    (
        "09",
        "pages/09/source/pages/021-c0c55164-a25e-4156-adbb-671a6c7f1c6d.jpg",
        427_232,
        "98b726641ceca761c334c95693535b528dcb605e9b984543c0d671f7f80b0e2d",
    ),
    (
        "12",
        "pages/12/source/pages/017-66381011-c6f4-4977-b33d-3b79246758c0.jpg",
        1_502_860,
        "d9e759f934b327d28097e08f0faeeb751013f9bdf40ede7027098dc7dd9b4dcb",
    ),
    (
        "17",
        "pages/17/source/pages/001-baf48682-e4e5-4f15-a9fd-d5da13a33198.jpg",
        415_652,
        "90a50244ebe454868787a63807b4f351e3839950b26de1e79c3b2d263b871924",
    ),
)


class R33PromotionError(RuntimeError):
    """Raised when the fixed R33 release evidence cannot be reproduced."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R33PromotionError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise R33PromotionError(f"{location}: missing, linked, or non-file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise R33PromotionError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _assert_file(path: Path, *, expected_bytes: int, expected_sha256: str) -> None:
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_size != expected_bytes
        or _sha256(path) != expected_sha256
    ):
        raise R33PromotionError(f"release evidence drifted: {path}")


def _visual_inventory() -> list[dict[str, Any]]:
    return [
        {
            "bytes": size,
            "file": file_name,
            "page": page,
            "sha256": digest,
            "verdict": verdict,
        }
        for page, file_name, size, digest, verdict in VISUAL_COMPARISONS
    ]


def _source_page_inventory() -> list[dict[str, Any]]:
    return [
        {"bytes": size, "page": page, "sha256": digest}
        for page, _relative, size, digest in SOURCE_PAGES
    ]


def _canonical_sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def _validate_visual_evidence(comparison_dir: Path, cached_run_dir: Path) -> None:
    for _page, file_name, size, digest, _verdict in VISUAL_COMPARISONS:
        _assert_file(
            comparison_dir / file_name,
            expected_bytes=size,
            expected_sha256=digest,
        )
    if _canonical_sha256(_visual_inventory()) != EXPECTED_VISUAL_INVENTORY_SHA256:
        raise R33PromotionError("visual comparison inventory contract drifted")
    for _page, relative, size, digest in SOURCE_PAGES:
        _assert_file(
            cached_run_dir / relative,
            expected_bytes=size,
            expected_sha256=digest,
        )
    if (
        _canonical_sha256(_source_page_inventory())
        != EXPECTED_SOURCE_PAGE_INVENTORY_SHA256
    ):
        raise R33PromotionError("source page inventory contract drifted")


def build_release_acceptance(*, accepted_at: str) -> dict[str, Any]:
    return attach.seal_record(
        {
            "acceptance_authority": ACCEPTANCE_AUTHORITY,
            "accepted_at": accepted_at,
            "automatic_visual_judgment": True,
            "evidence": {
                "candidate_order_sha256": EXPECTED_CANDIDATE_ORDER_SHA256,
                "model_version": EXPECTED_MODEL_VERSION,
                "page_consistency_apply_sha256": EXPECTED_PAGE_CONSISTENCY_APPLY_SHA256,
                "page_consistency_plan_sha256": EXPECTED_PAGE_CONSISTENCY_PLAN_SHA256,
                "page_consistency_shared_sha256": EXPECTED_PAGE_CONSISTENCY_SHARED_SHA256,
                "ranker_sha256": EXPECTED_RANKER_SHA256,
                "source_evaluation_runtime_contract_sha256": (
                    EXPECTED_SOURCE_CONTRACT_SHA256
                ),
                "source_marker_sha256": EXPECTED_SOURCE_MARKER_SHA256,
                "source_page_inventory_sha256": EXPECTED_SOURCE_PAGE_INVENTORY_SHA256,
                "source_selection_calibration_sha256": (
                    EXPECTED_SELECTION_CALIBRATION_SHA256
                ),
                "visual_comparison_inventory_sha256": (
                    EXPECTED_VISUAL_INVENTORY_SHA256
                ),
            },
            "explicit_user_acceptance": True,
            "external_release_quality_gate_passed": True,
            "publication": {
                "evaluation_only_annotations_removed": True,
                "release_marker_has_no_qa_flags": True,
                "source_evaluation_runtime_immutable": True,
                "source_model_assets_copied_exactly": True,
            },
            "quality_gate": {
                "cached_development_pages": 5,
                "fresh_gemma_or_inpainting_pages": 0,
                "gemma_or_inpainting_runs": 0,
                "human_gold": False,
                "improved_pages": 4,
                "independent_holdout": False,
                "judged_content_pages": 5,
                "live_font_replay_pages": 5,
                "outline_loss_count": 0,
                "ranker_cpu_batch1_median_multiplier": 1.093,
                "ranker_cpu_batch16_median_multiplier": 1.224,
                "ranker_cpu_budget_limit_multiplier": 2.0,
                "ranker_cpu_budget_passed": True,
                "regressed_pages": 0,
                "sfx_body_regression_count": 0,
                "structural_error_count": 0,
                "unchanged_pages": 1,
                "user_visual_verdict": "new_version_better",
            },
            "record_type": ACCEPTANCE_RECORD,
            "schema_version": ACCEPTANCE_SCHEMA,
            "status": "accepted",
        }
    )


def _validate_acceptance(value: Mapping[str, Any]) -> None:
    attach.validate_record_seal(value, location="R33 release acceptance")
    accepted_at = value.get("accepted_at")
    if not isinstance(accepted_at, str) or not accepted_at:
        raise R33PromotionError("R33 accepted_at is invalid")
    if dict(value) != build_release_acceptance(accepted_at=accepted_at):
        raise R33PromotionError("R33 release acceptance envelope drifted")


def _validate_source_runtime(path: Path) -> dict[str, Any]:
    root = path.expanduser().resolve()
    try:
        validated = package._evaluation_only_validate_qa(root)  # noqa: SLF001
    except (
        package.MangaFontV8QaRuntimeError,
        attach.SelectionCalibrationAttachError,
    ) as error:
        raise R33PromotionError(str(error)) from error
    contract = dict(_mapping(validated.get("contract"), "source runtime contract"))
    marker = _read_json(root / attach.MARKER_FILE, "source runtime marker")
    head = _mapping(contract.get("head"), "source runtime head")
    catalog = _mapping(contract.get("catalog"), "source runtime catalog")
    r33 = _mapping(contract.get("r33_page_common_qa"), "R33 source evidence")
    if (
        contract.get("model_version") != EXPECTED_MODEL_VERSION
        or head.get("onnx_sha256") != EXPECTED_RANKER_SHA256
        or catalog.get("candidate_order_sha256") != EXPECTED_CANDIDATE_ORDER_SHA256
        or r33.get("page_common_mode") != "soft-learned-candidate-prior-strength-1"
        or r33.get("production_eligible") is not False
        or marker.get("qa_only") is not True
        or marker.get("release_approved") is not False
        or _sha256(root / attach.CONTRACT_FILE) != EXPECTED_SOURCE_CONTRACT_SHA256
        or _sha256(root / attach.MARKER_FILE) != EXPECTED_SOURCE_MARKER_SHA256
        or _sha256(root / attach.SELECTION_CALIBRATION_FILE)
        != EXPECTED_SELECTION_CALIBRATION_SHA256
    ):
        raise R33PromotionError("source R33 runtime identity drifted")
    return {"contract": contract, "marker": marker, "root": root}


def _strip_evaluation_only(contract: Mapping[str, Any]) -> dict[str, Any]:
    stripped = attach._strip_evaluation_only_contract_annotations(contract)  # noqa: SLF001
    stripped.pop("record_sha256", None)
    if stripped.get("evaluation_only_runtime") is not None:
        raise R33PromotionError("evaluation-only annotations were not removed")
    packaging = _mapping(stripped.get("v8_runtime_packaging"), "v8 packaging")
    if packaging.get("quality_gate_bypassed") is not False:
        raise R33PromotionError("v8 packaging bypass was not closed")
    return stripped


def _publish_marker(root: Path, source_marker: Mapping[str, Any]) -> None:
    marker = dict(source_marker)
    marker.pop("qa_only", None)
    marker.pop("release_approved", None)
    artifacts = dict(_mapping(marker.get("artifacts"), "release marker artifacts"))
    artifacts[attach.CONTRACT_FILE] = _sha256(root / attach.CONTRACT_FILE)
    marker["artifacts"] = artifacts
    (root / attach.MARKER_FILE).write_bytes(attach.json_bytes(marker, pretty=True))


def _validate_release(root: Path) -> Mapping[str, Any]:
    resolved = root.expanduser().resolve()
    package._exact_inventory(resolved, attach.ATTACHED_BUNDLE_FILES, "R33 release")  # noqa: SLF001
    marker = _read_json(resolved / attach.MARKER_FILE, "R33 release marker")
    if "qa_only" in marker or "release_approved" in marker:
        raise R33PromotionError("R33 release marker retained QA flags")
    contract = _read_json(resolved / attach.CONTRACT_FILE, "R33 release contract")
    _validate_acceptance(
        _mapping(contract.get("release_acceptance"), "R33 release acceptance")
    )
    if contract.get("evaluation_only_runtime") is not None:
        raise R33PromotionError("R33 release retained evaluation-only state")
    attach.validate_record_seal(contract, location="R33 release contract")
    marker_artifacts = _mapping(marker.get("artifacts"), "R33 marker artifacts")
    for name in attach.ATTACHED_ASSET_FILES:
        if marker_artifacts.get(name) != _sha256(resolved / name):
            raise R33PromotionError(f"R33 release marker hash drifted: {name}")
    reconstructed = attach._reconstructed_source_contract_sha256(contract)  # noqa: SLF001
    try:
        attach.validate_selection_calibration(
            resolved / attach.SELECTION_CALIBRATION_FILE,
            contract=contract,
            runtime_contract_sha256=reconstructed,
            allow_failed_preferred_precision=True,
        )
    except attach.SelectionCalibrationAttachError as error:
        raise R33PromotionError(str(error)) from error
    return {
        "candidate_count": len(
            list(_mapping(contract.get("catalog"), "catalog")["candidate_ids"])
        ),
        "contract_sha256": _sha256(resolved / attach.CONTRACT_FILE),
        "marker_sha256": _sha256(resolved / attach.MARKER_FILE),
        "model_version": contract.get("model_version"),
        "output_dir": str(resolved),
        "release_acceptance_record_sha256": _mapping(
            contract.get("release_acceptance"), "R33 release acceptance"
        ).get("record_sha256"),
        "status": RELEASE_STATE,
    }


def promote(
    *,
    source_runtime: Path,
    comparison_dir: Path,
    cached_run_dir: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    source = _validate_source_runtime(source_runtime)
    _validate_visual_evidence(
        comparison_dir.expanduser().resolve(), cached_run_dir.expanduser().resolve()
    )
    output = output_dir.expanduser().resolve()
    if output.exists():
        raise R33PromotionError("output directory already exists")
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
        contract = _strip_evaluation_only(source["contract"])
        contract["release_acceptance"] = build_release_acceptance(
            accepted_at=ACCEPTED_AT
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


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    promote_command = commands.add_parser("promote")
    promote_command.add_argument("--source-runtime", type=Path, required=True)
    promote_command.add_argument("--comparison-dir", type=Path, required=True)
    promote_command.add_argument("--cached-run-dir", type=Path, required=True)
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
                comparison_dir=args.comparison_dir,
                cached_run_dir=args.cached_run_dir,
                output_dir=args.output_dir,
            )
            if args.command == "promote"
            else _validate_release(args.output_dir)
        )
    except (R33PromotionError, package.MangaFontV8QaRuntimeError) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
