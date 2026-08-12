#!/usr/bin/env python3
"""Build role-routed selection calibration for a sealed v8 base runtime.

The legacy active21 rank-preserving calibrator is intentionally limited to a
v7 graph whose body and variant outputs are exact aliases.  V8 has distinct
pixel-only branches, so it must use the generic role-routed calibration model.
This adapter adds only the sealed retired-Gugi vocabulary projection needed by
the existing 22-font human finals; all fitting, leakage checks, OOF evaluation,
record validation, and deployment quality gates remain canonical.
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_font_matching_selection_calibration as base
    from scripts import package_manga_font_student_v8_qa_runtime as package
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_matching_selection_calibration as base  # type: ignore[no-redef]
    import package_manga_font_student_v8_qa_runtime as package  # type: ignore[no-redef]


RETIRED_GUGI_ID = "gugi"
_BASE_RUNTIME_BINDINGS = base._runtime_bindings  # noqa: SLF001
_BASE_SCORE_ROUTER = base._route_hybrid_candidate_scores  # noqa: SLF001
_BASE_WINNER_ROWS = base._winner_rows  # noqa: SLF001
UNRESTRICTED_SINGLE_DAY_ROLES = frozenset(
    {
        "whisper",
        "aside_balloon_edge",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
    }
)


class MangaFontV8SelectionCalibrationError(ValueError):
    """Raised when the runtime is not the sealed distinct-branch v8 format."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV8SelectionCalibrationError(f"{location}: expected object")
    return value


def _validate_v8_evidence(runtime_dir: Path, runtime: Mapping[str, Any]) -> None:
    contract = base._read_json(  # noqa: SLF001
        runtime_dir.expanduser().resolve() / "runtime-contract.json",
        "v8 runtime contract",
    )
    evidence = _mapping(
        contract.get("v8_font_family_evidence"), "v8 font-family evidence"
    )
    packaging = _mapping(
        contract.get("v8_runtime_packaging"), "v8 runtime packaging"
    )
    expected_evidence = {
        "body_and_variant_share_exact_scores": False,
        "candidate_scores_compatibility_alias": "body_candidate_scores",
        "forbidden_model_inputs": ["font_name", "gemma", "genre", "text"],
        "role_logits": "pixel_query_role_family_adapter",
        "schema_version": package.V8_EVIDENCE_SCHEMA,
    }
    candidate_ids = tuple(runtime.get("candidate_ids", ()))
    routing = runtime.get("hybrid_score_routing")
    if (
        dict(evidence) != expected_evidence
        or packaging.get("schema_version") != package.SCHEMA_VERSION
        or packaging.get("quality_gate_bypassed") is not False
        or packaging.get("selection_calibration_required") is not True
        or len(candidate_ids) != 21
        or RETIRED_GUGI_ID in candidate_ids
        or "single-day" not in candidate_ids
        or not isinstance(routing, Mapping)
        or routing.get("family_scores_shared") is True
        or routing.get("body_output") != "body_candidate_scores"
        or routing.get("variant_output") != "variant_candidate_scores"
    ):
        raise MangaFontV8SelectionCalibrationError(
            "runtime is not the sealed active21 distinct-branch v8 contract"
        )


def _v8_runtime_bindings(
    runtime_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any], Any]:
    bindings, runtime, prototypes = _BASE_RUNTIME_BINDINGS(runtime_dir)
    _validate_v8_evidence(runtime_dir, runtime)
    projected = dict(runtime)
    projected["retired_label_candidates"] = (RETIRED_GUGI_ID,)
    return bindings, projected, prototypes


def _v8_production_score_route(
    samples: Sequence[Any],
    outputs: Mapping[str, np.ndarray],
    runtime: Mapping[str, Any],
) -> dict[str, np.ndarray]:
    """Mirror production pixel-family routing and Single Day eligibility."""

    routed = {name: np.asarray(value) for name, value in outputs.items()}
    candidate_ids = tuple(str(value) for value in runtime.get("candidate_ids", ()))
    routing = _mapping(runtime.get("hybrid_score_routing"), "hybrid score routing")
    body = np.asarray(outputs.get("body_candidate_scores"), dtype=np.float32)
    variant = np.asarray(outputs.get("variant_candidate_scores"), dtype=np.float32)
    compatibility = np.asarray(outputs.get("candidate_scores"), dtype=np.float32)
    role_logits = np.asarray(outputs.get("role_logits"), dtype=np.float32)
    expected = (len(samples), len(candidate_ids))
    if (
        body.shape != expected
        or variant.shape != expected
        or compatibility.shape != expected
        or role_logits.shape != (len(samples), len(base.ROLE_VALUES))
        or not np.isfinite(body).all()
        or not np.isfinite(variant).all()
        or not np.isfinite(role_logits).all()
        or not np.array_equal(body, compatibility)
        or routing.get("body_output") != "body_candidate_scores"
        or routing.get("variant_output") != "variant_candidate_scores"
    ):
        raise MangaFontV8SelectionCalibrationError(
            "v8 production score-route outputs drifted"
        )
    shifted = role_logits.astype(np.float64) - role_logits.max(axis=1, keepdims=True)
    role_probabilities = np.exp(shifted)
    role_probabilities /= role_probabilities.sum(axis=1, keepdims=True)
    predicted_role_indices = role_probabilities.argmax(axis=1)
    predicted_roles = tuple(
        base.ROLE_VALUES[int(index)] for index in predicted_role_indices.tolist()
    )
    body_roles = frozenset(routing.get("body_roles", ()))
    selected = np.where(
        np.asarray([role in body_roles for role in predicted_roles])[:, None],
        body,
        variant,
    ).astype(np.float32, copy=True)
    single_day_index = candidate_ids.index("single-day")
    maximum_scores = selected.copy()
    maximum_scores[:, single_day_index] = -np.inf
    raw_margin = selected[:, single_day_index] - maximum_scores.max(axis=1)
    confidence = role_probabilities[
        np.arange(len(samples)), predicted_role_indices
    ]
    single_day_allowed = (
        np.asarray(
            [role in UNRESTRICTED_SINGLE_DAY_ROLES for role in predicted_roles]
        )
        | (
            np.asarray([role not in body_roles for role in predicted_roles])
            & (confidence >= 0.75)
            & (raw_margin >= math.log(2.0))
        )
    )
    minimum_scores = selected.copy()
    minimum_scores[:, single_day_index] = np.inf
    minimum_competitor = minimum_scores.min(axis=1)
    selected[~single_day_allowed, single_day_index] = (
        minimum_competitor[~single_day_allowed] - 1.0
    )
    routed["candidate_scores"] = selected
    return routed


def _v8_production_winner_rows(
    predictions: np.ndarray,
    table: Any,
    samples: Sequence[Any],
    outputs: Mapping[str, np.ndarray],
    candidate_ids: Sequence[str],
    none_threshold: float,
) -> list[dict[str, Any]]:
    """Use the pixel-predicted family for operating-point cohorts too."""

    rows = _BASE_WINNER_ROWS(
        predictions,
        table,
        samples,
        outputs,
        candidate_ids,
        none_threshold,
    )
    role_logits = np.asarray(outputs.get("role_logits"), dtype=np.float32)
    if (
        role_logits.shape != (len(samples), len(base.ROLE_VALUES))
        or not np.isfinite(role_logits).all()
    ):
        raise MangaFontV8SelectionCalibrationError(
            "v8 winner cohort role logits drifted"
        )
    predicted_indices = role_logits.argmax(axis=1)
    predicted_families = tuple(
        base._role_family(base.ROLE_VALUES[int(index)])  # noqa: SLF001
        for index in predicted_indices.tolist()
    )
    return [
        {
            **row,
            "family": predicted_families[int(row["sample_index"])],
        }
        for row in rows
    ]


def build_calibration(
    *,
    finals_path: Path,
    master_manifest_path: Path,
    catalog_registry_path: Path,
    runtime_dir: Path,
    coverage_target: float,
    precision_target: float,
) -> dict[str, Any]:
    original = base._runtime_bindings  # noqa: SLF001
    original_router = base._route_hybrid_candidate_scores  # noqa: SLF001
    original_winner_rows = base._winner_rows  # noqa: SLF001
    if (
        original is not _BASE_RUNTIME_BINDINGS
        or original_router is not _BASE_SCORE_ROUTER
        or original_winner_rows is not _BASE_WINNER_ROWS
    ):
        raise MangaFontV8SelectionCalibrationError(
            "selection-calibration runtime hook is already modified"
        )
    base._runtime_bindings = _v8_runtime_bindings  # type: ignore[assignment]  # noqa: SLF001
    base._route_hybrid_candidate_scores = _v8_production_score_route  # type: ignore[assignment]  # noqa: SLF001
    base._winner_rows = _v8_production_winner_rows  # type: ignore[assignment]  # noqa: SLF001
    try:
        record = base.build_calibration(
            finals_path=finals_path,
            master_manifest_path=master_manifest_path,
            catalog_registry_path=catalog_registry_path,
            runtime_dir=runtime_dir,
            coverage_target=coverage_target,
            precision_target=precision_target,
        )
        if "leakage_audit" in record:
            record = dict(record)
            record.pop("record_sha256", None)
            audit = dict(_mapping(record.get("leakage_audit"), "leakage audit"))
            audit["hybrid_score_route_source"] = (
                "predicted_pixel_family_with_single_day_eligibility"
            )
            record["leakage_audit"] = audit
            return base.seal_record(record)
        return record
    except base.SelectionCalibrationError as error:
        raise MangaFontV8SelectionCalibrationError(str(error)) from error
    finally:
        base._runtime_bindings = original  # type: ignore[assignment]  # noqa: SLF001
        base._route_hybrid_candidate_scores = original_router  # type: ignore[assignment]  # noqa: SLF001
        base._winner_rows = original_winner_rows  # type: ignore[assignment]  # noqa: SLF001


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--finals", type=Path, required=True)
    build.add_argument("--master-manifest", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--runtime-dir", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--replace-existing", action="store_true")
    build.add_argument("--coverage-target", type=float, default=0.90)
    build.add_argument("--precision-target", type=float, default=0.88)
    validate = sub.add_parser("validate")
    validate.add_argument("--artifact", type=Path, required=True)
    quality = sub.add_parser("quality-gate")
    quality.add_argument("--artifact", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            record = base.validate_calibration(
                base._read_json(args.artifact, "selection calibration")  # noqa: SLF001
            )
            result: Mapping[str, Any] = {
                "record_sha256": record["record_sha256"],
                "status": "valid",
            }
        elif args.command == "quality-gate":
            result = base.require_deployment_quality(
                base._read_json(args.artifact, "selection calibration")  # noqa: SLF001
            )
        else:
            coverage = base._probability(args.coverage_target, "coverage target")  # noqa: SLF001
            precision = base._probability(args.precision_target, "precision target")  # noqa: SLF001
            record = build_calibration(
                finals_path=args.finals,
                master_manifest_path=args.master_manifest,
                catalog_registry_path=args.catalog_registry,
                runtime_dir=args.runtime_dir,
                coverage_target=coverage,
                precision_target=precision,
            )
            base.write_record(
                args.output, record, replace_existing=args.replace_existing
            )
            base.validate_calibration(
                base._read_json(args.output, "selection calibration")  # noqa: SLF001
            )
            result = {
                "quality_gate_bypassed": False,
                "record_sha256": record["record_sha256"],
                "status": "valid_requires_quality_gate_before_attachment",
            }
    except (base.SelectionCalibrationError, MangaFontV8SelectionCalibrationError) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
