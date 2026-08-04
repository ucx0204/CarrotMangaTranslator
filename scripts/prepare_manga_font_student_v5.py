#!/usr/bin/env python3
"""Reproduce the strongest head and seal a fail-closed v5 continuation plan.

The v5 path starts only from the exact 109-only v3 head that scored 13/33
preferred and 21/33 acceptable on val33.  Reproduction is checked on both its
historically bound cache and the current valid legacy727 cache.  No encoder,
hidden test, fresh64, or library QA data is opened.

This module also exposes an array-level consumer for forthcoming human visual
new7 judgments.  It upgrades only explicitly validated legacy-partial train
rows to full22; it cannot infer or fabricate successor-font negatives.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import sweep_manga_font_student_v3_heads as v3_sweep
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v2 as v2
    from scripts import train_manga_font_student_v3 as v3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import sweep_manga_font_student_v3_heads as v3_sweep
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v2 as v2
    import train_manga_font_student_v3 as v3


SCHEMA = "manga-font-student-v5-readiness-v1"
OWNER = "carrot-manga-translator/manga-font-student-v5-readiness-v1"
MARKER = ".manga-font-student-v5-readiness-v1-owned.json"
REPORT = "reproduction-report.json"
PLAN = "continuation-plan.json"
HEAD = "strongest-head.safetensors"
FILES = frozenset({MARKER, REPORT, PLAN, HEAD})

STRONGEST_SWEEP_REPORT_SHA256 = (
    "ed55ae0129971e88e61cbc9a4957ac2865448faea6c7350003724372da6b4436"
)
STRONGEST_HEAD_SHA256 = (
    "a185e570fb9859afdaf8e342cf58109221cd42e24894f31c05745cbeb5f0c031"
)
HISTORICAL_CACHE_CONTRACT_SHA256 = (
    "fe2c54e09d35cebaae3d0f322632f85826c8315b6a9770ffd14dbd6a40400db5"
)
HISTORICAL_CACHE_ARRAYS_SHA256 = (
    "467cf5b8ea462bedc090df85a8eae22e8bbcea105a0be38970397f804532e4fe"
)
EXPECTED_HITS = {
    "acceptable_at1": 21,
    "preferred_at1": 13,
    "variant_acceptable_at1": 16,
    "variant_preferred_at1": 8,
}
EXPECTED_ROWS = {"global": 33, "variant": 28}
UPGRADE_STATUS = "ready_for_legacy_new7_full22_train_upgrade"


class MangaFontV5PreparationError(v3.MangaFontStudentV3Error):
    """Raised when the strongest-head or upgrade boundary drifts."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV5PreparationError(f"{location}: expected object")
    return value


def _array_sha(value: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(value).tobytes()).hexdigest()


def validate_historical_strongest_sweep(root: Path) -> dict[str, Any]:
    resolved = root.expanduser().resolve()
    expected = {
        v3_sweep.SWEEP_MARKER,
        v3_sweep.SWEEP_REPORT,
        v3_sweep.SWEEP_CHECKPOINT,
    }
    base.assert_exact_root_inventory(resolved, expected, location="strongest sweep")
    marker = base.read_json(
        resolved / v3_sweep.SWEEP_MARKER, location="strongest sweep marker"
    )
    report = base.read_json(
        resolved / v3_sweep.SWEEP_REPORT, location="strongest sweep report"
    )
    base.validate_record_seal(report, location="strongest sweep report")
    if (
        base.sha256_file(resolved / v3_sweep.SWEEP_REPORT)
        != STRONGEST_SWEEP_REPORT_SHA256
        or base.sha256_file(resolved / v3_sweep.SWEEP_CHECKPOINT)
        != STRONGEST_HEAD_SHA256
        or marker.get("owner") != v3_sweep.SWEEP_OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != v3_sweep.SWEEP_SCHEMA
    ):
        raise MangaFontV5PreparationError("strongest sweep immutable binding drifted")
    artifacts = _mapping(marker.get("artifacts"), "strongest sweep artifacts")
    if (
        artifacts.get(v3_sweep.SWEEP_REPORT) != STRONGEST_SWEEP_REPORT_SHA256
        or artifacts.get(v3_sweep.SWEEP_CHECKPOINT) != STRONGEST_HEAD_SHA256
        or report.get("global_best_trial") != 3
        or report.get("cache_contract_sha256")
        != HISTORICAL_CACHE_CONTRACT_SHA256
    ):
        raise MangaFontV5PreparationError("strongest sweep identity drifted")
    trial = _mapping(report.get("trials", [])[2], "strongest sweep trial3")
    metrics = _mapping(trial.get("best_metrics"), "strongest sweep trial3 metrics")
    _assert_expected_hits(metrics, location="sealed strongest report")
    checkpoint = _mapping(report.get("best_checkpoint"), "strongest checkpoint")
    if checkpoint.get("sha256") != STRONGEST_HEAD_SHA256:
        raise MangaFontV5PreparationError("strongest checkpoint descriptor drifted")
    return {
        "candidate_ids": tuple(str(value) for value in report["candidate_ids"]),
        "metrics": copy.deepcopy(dict(metrics)),
        "state_contract": copy.deepcopy(checkpoint.get("state_contract")),
    }


def validate_historical_cache(root: Path) -> dict[str, Any]:
    resolved = root.expanduser().resolve()
    if (
        base.sha256_file(resolved / v3_sweep.CACHE_CONTRACT)
        != HISTORICAL_CACHE_CONTRACT_SHA256
        or base.sha256_file(resolved / v3_sweep.CACHE_ARRAYS)
        != HISTORICAL_CACHE_ARRAYS_SHA256
    ):
        raise MangaFontV5PreparationError("historical cache immutable binding drifted")
    contract = base.read_json(
        resolved / v3_sweep.CACHE_CONTRACT, location="historical cache contract"
    )
    base.validate_record_seal(contract, location="historical cache contract")
    boundaries = _mapping(contract.get("boundaries"), "historical cache boundaries")
    if (
        boundaries.get("human_test_labels_deserialized") != 0
        or boundaries.get("human_test_pixels_opened") != 0
        or boundaries.get("synthetic_test_pixels_opened") != 0
        or boundaries.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV5PreparationError("historical cache leakage boundary drifted")
    with np.load(resolved / v3_sweep.CACHE_ARRAYS, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    return {"arrays": arrays, "contract": contract}


def _assert_expected_hits(metrics: Mapping[str, Any], *, location: str) -> None:
    if int(metrics.get("evaluated_positive_rows", -1)) != EXPECTED_ROWS["global"]:
        raise MangaFontV5PreparationError(f"{location}: global row count drifted")
    if int(metrics.get("variant_val_rows", -1)) != EXPECTED_ROWS["variant"]:
        raise MangaFontV5PreparationError(f"{location}: variant row count drifted")
    for name, expected in EXPECTED_HITS.items():
        rows = EXPECTED_ROWS["variant"] if name.startswith("variant_") else EXPECTED_ROWS["global"]
        actual = round(float(metrics.get(name, math.nan)) * rows)
        if actual != expected:
            raise MangaFontV5PreparationError(
                f"{location}: {name} expected {expected} hits, got {actual}"
            )


def _load_exact_ranker(
    torch: Any,
    *,
    checkpoint_path: Path,
    candidate_count: int,
    state_contract: Any,
) -> Any:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV5PreparationError("safetensors is required") from error
    state = dict(load_file(str(checkpoint_path.expanduser().resolve()), device="cpu"))
    expected_names = {
        str(_mapping(row, "strongest state contract row").get("name"))
        for row in state_contract
    }
    if set(state) != expected_names:
        raise MangaFontV5PreparationError("strongest head tensor inventory drifted")
    ranker = v3.build_runtime_ranker_v3(
        torch,
        candidate_count=candidate_count,
        dropout=0.10,
        residual_scale=0.50,
    ).to("cuda")
    stripped = {
        name.removeprefix("runtime_ranker."): value for name, value in state.items()
    }
    if any(not name.startswith("runtime_ranker.") for name in state):
        raise MangaFontV5PreparationError("strongest head prefix drifted")
    ranker.load_state_dict(stripped, strict=True)
    if ranker.candidate_residual.bias is not None:
        raise MangaFontV5PreparationError("strongest head has candidate bias")
    return ranker


def evaluate_cached_val(
    torch: Any,
    *,
    ranker: Any,
    contract: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    candidate_ids: tuple[str, ...],
) -> dict[str, Any]:
    bags = tuple(
        torch.arange(
            int(record["start"]),
            int(record["start"]) + int(record["count"]),
            dtype=torch.long,
            device="cuda",
        )
        for record in contract["prototype_bags"]
    )
    return v3_sweep._cached_val_metrics(  # noqa: SLF001
        torch=torch,
        ranker=ranker,
        embeddings=torch.from_numpy(arrays["human_val_embeddings"]).to("cuda"),
        prototypes=torch.from_numpy(arrays["prototype_features"]).to("cuda"),
        bags=bags,
        targets=torch.from_numpy(arrays["human_val_targets"]).to("cuda"),
        masks=torch.from_numpy(arrays["human_val_masks"]).to("cuda"),
        roles=torch.from_numpy(arrays["human_val_role"]).to("cuda"),
        candidate_ids=candidate_ids,
    )


def validate_upgrade_authority(
    validation: Mapping[str, Any],
    *,
    expected_new7: tuple[str, ...],
) -> int:
    """Validate builder attestation before any cached target is replaced."""

    required_zero = (
        "fabricated_new7_negative_count",
        "fresh64_overlap_count",
        "old15_membership_mutation_count",
        "qa40_overlap_count",
        "test_overlap_count",
        "val_overlap_count",
    )
    if (
        validation.get("status") != UPGRADE_STATUS
        or validation.get("split") != "train"
        or validation.get("completed_human_visual_provenance") is not True
        or tuple(validation.get("new7_candidate_ids", ())) != expected_new7
        or any(int(validation.get(name, -1)) != 0 for name in required_zero)
    ):
        raise MangaFontV5PreparationError("full22 upgrade authority is unsafe")
    count = int(validation.get("upgraded_record_count", 0))
    if count < 1 or int(validation.get("new7_visual_judgment_record_count", 0)) != count:
        raise MangaFontV5PreparationError("full22 upgrade visual judgment count drifted")
    for name in ("base_partial_record_sha256", "legacy15_membership_sha256"):
        value = str(validation.get(name, ""))
        if len(value) != 64 or set(value) - base.SHA_CHARS:
            raise MangaFontV5PreparationError(f"full22 upgrade {name} drifted")
    return count


def apply_full22_upgrade_examples_to_cache(
    *,
    contract: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    examples: Sequence[base.HumanExample],
    candidate_ids: tuple[str, ...],
    authority_validation: Mapping[str, Any],
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Replace cached targets only for visually completed train full22 rows."""

    metadata = contract.get("human_train")
    if not isinstance(metadata, list):
        raise MangaFontV5PreparationError("cache human train metadata drifted")
    by_id = {
        str(_mapping(row, "cache human train row").get("sample_id")): index
        for index, row in enumerate(metadata)
    }
    if len(by_id) != len(metadata):
        raise MangaFontV5PreparationError("cache human train identities duplicate")
    partial_not_reviewed = {
        tuple(
            _mapping(
                _mapping(row, "cache human train row").get("supervision"),
                "cache human train supervision",
            ).get("not_reviewed_candidate_ids", ())
        )
        for row in metadata
        if _mapping(
            _mapping(row, "cache human train row").get("supervision"),
            "cache human train supervision",
        ).get("partial_candidate_supervision")
    }
    if len(partial_not_reviewed) != 1:
        raise MangaFontV5PreparationError("cache partial candidate scope drifted")
    expected_new7 = next(iter(partial_not_reviewed))
    expected_count = validate_upgrade_authority(
        authority_validation, expected_new7=expected_new7
    )
    if len(examples) != expected_count:
        raise MangaFontV5PreparationError("full22 upgrade row count drifted")
    result = {name: np.array(value, copy=True) for name, value in arrays.items()}
    seen: set[str] = set()
    old15_indices = [
        index for index, candidate_id in enumerate(candidate_ids) if candidate_id not in expected_new7
    ]
    for example in examples:
        if example.sample_id in seen or example.sample_id not in by_id:
            raise MangaFontV5PreparationError("full22 upgrade identity escaped cache")
        seen.add(example.sample_id)
        offset = by_id[example.sample_id]
        if example.split != "train" or bool(result["human_train_full22"][offset]):
            raise MangaFontV5PreparationError("full22 upgrade did not target a partial train row")
        scope = v3.candidate_supervision_scope(example, candidate_ids)
        if scope["partial_candidate_supervision"] or scope["reviewed_candidate_count"] != len(candidate_ids):
            raise MangaFontV5PreparationError("upgrade row is not complete full22")
        provenance = _mapping(example.row.get("provenance"), "upgrade provenance")
        review = _mapping(example.row.get("review_provenance"), "upgrade review provenance")
        if (
            provenance.get("approval") != "completed_human_final_label"
            or _mapping(review.get("authority"), "upgrade review authority").get(
                "new7_visual_judgment_completed"
            )
            is not True
        ):
            raise MangaFontV5PreparationError("upgrade lacks completed new7 visual provenance")
        new_target = np.asarray(v2.tier_code_target(example, candidate_ids), dtype="<f4")
        # The old15 positive tier membership is immutable; full22 promotion may
        # only add visually judged successor information.
        if not np.array_equal(
            new_target[old15_indices],
            result["human_train_targets"][offset, old15_indices],
        ):
            raise MangaFontV5PreparationError("upgrade mutated old15 positive tiers")
        if example.role_index != int(result["human_train_role"][offset]):
            raise MangaFontV5PreparationError("upgrade role drifted")
        if not np.array_equal(
            np.asarray(example.style_values, dtype="<f4"),
            result["human_train_style"][offset],
        ) or not np.array_equal(
            np.asarray(example.treatment_indices, dtype="<i8"),
            result["human_train_treatment"][offset],
        ):
            raise MangaFontV5PreparationError("upgrade style/treatment drifted")
        mask = np.zeros(len(candidate_ids), dtype=np.bool_)
        mask[list(example.eligible_indices)] = True
        result["human_train_targets"][offset] = new_target
        result["human_train_masks"][offset] = mask
        result["human_train_none"][offset] = example.none_target
        result["human_train_none_mask"][offset] = True
        result["human_train_full22"][offset] = True
    return result, {
        "fabricated_new7_negative_count": 0,
        "old15_positive_tier_mutation_count": 0,
        "upgraded_record_count": len(seen),
        "upgraded_sample_ids_sha256": base.sha256_bytes(
            "\n".join(sorted(seen)).encode("utf-8")
        ),
    }


def _continuation_plan() -> dict[str, Any]:
    return base.seal_record(
        {
            "encoder_policy": {
                "initial_phase": "frozen_cached_embeddings_only",
                "initial_phase_encoder_executions": 0,
                "unfreeze_allowed": False,
            },
            "entry_gate": {
                "acceptable_hits": EXPECTED_HITS["acceptable_at1"],
                "preferred_hits": EXPECTED_HITS["preferred_at1"],
                "variant_acceptable_hits": EXPECTED_HITS["variant_acceptable_at1"],
                "variant_preferred_hits": EXPECTED_HITS["variant_preferred_at1"],
            },
            "maximum_trials": 4,
            "phase1": {
                "candidate_bias_allowed": False,
                "early_stopping_patience": 2,
                "epochs_per_trial": 4,
                "head_learning_rates": [0.000025, 0.00005],
                "legacy_partial_loss_weights": [0.0, 0.10],
                "prototype_score_coefficient": 1.0,
                "start_checkpoint": HEAD,
                "upgraded_full22_row_weight": 1.5,
            },
            "promotion_gate": {
                "acceptable_hits_minimum": 21,
                "preferred_hits_minimum": 14,
                "variant_acceptable_hits_minimum": 16,
                "variant_preferred_hits_minimum": 9,
                "top1_max_candidate_share_maximum": 0.55,
                "top1_unique_candidate_count_minimum": 4,
            },
            "record_type": "manga_font_student_v5_continuation_plan",
            "schema_version": SCHEMA,
            "selection_boundary": {
                "fresh64_accessed": False,
                "hidden_test_accessed": False,
                "library_40qa_accessed": False,
                "optimizer_uses_val33": False,
                "selection_uses_val33": True,
            },
            "status": "blocked_until_completed_new7_visual_upgrade_overlay",
        }
    )


def reproduce(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontV5PreparationError("v5 readiness output already exists")
    strongest = validate_historical_strongest_sweep(args.strongest_sweep_dir)
    historical = validate_historical_cache(args.historical_cache_dir)
    v3_sweep.validate_cache(args.current_cache_dir)
    current_contract, current_arrays = v3_sweep._load_cache_arrays(  # noqa: SLF001
        args.current_cache_dir
    )
    candidate_ids = strongest["candidate_ids"]
    if tuple(historical["contract"]["candidate_ids"]) != candidate_ids or tuple(
        current_contract["candidate_ids"]
    ) != candidate_ids:
        raise MangaFontV5PreparationError("v5 candidate order drifted")
    try:
        import torch
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV5PreparationError("torch is required") from error
    if not torch.cuda.is_available():
        raise MangaFontV5PreparationError("v5 reproduction requires CUDA")
    checkpoint_path = (
        args.strongest_sweep_dir.expanduser().resolve() / v3_sweep.SWEEP_CHECKPOINT
    )
    ranker = _load_exact_ranker(
        torch,
        checkpoint_path=checkpoint_path,
        candidate_count=len(candidate_ids),
        state_contract=strongest["state_contract"],
    )
    historical_metrics = evaluate_cached_val(
        torch,
        ranker=ranker,
        contract=historical["contract"],
        arrays=historical["arrays"],
        candidate_ids=candidate_ids,
    )
    current_metrics = evaluate_cached_val(
        torch,
        ranker=ranker,
        contract=current_contract,
        arrays=current_arrays,
        candidate_ids=candidate_ids,
    )
    _assert_expected_hits(historical_metrics, location="historical reproduction")
    _assert_expected_hits(current_metrics, location="current-cache reproduction")
    metric_keys = (
        "acceptable_at1",
        "preferred_at1",
        "variant_acceptable_at1",
        "variant_preferred_at1",
        "top1_candidate_distribution",
    )
    if any(historical_metrics[key] != current_metrics[key] for key in metric_keys):
        raise MangaFontV5PreparationError("current cache changed strongest top1 decisions")
    for key in ("human_val_targets", "human_val_masks", "human_val_role", "prototype_features"):
        if _array_sha(historical["arrays"][key]) != _array_sha(current_arrays[key]):
            raise MangaFontV5PreparationError(f"current cache changed {key}")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        shutil.copyfile(checkpoint_path, staging / HEAD)
        plan = _continuation_plan()
        (staging / PLAN).write_bytes(base.json_bytes(plan, pretty=True))
        report = base.seal_record(
            {
                "boundaries": {
                    "encoder_executions": 0,
                    "fresh64_accessed": False,
                    "hidden_test_labels_deserialized": 0,
                    "hidden_test_pixels_opened": 0,
                    "library_40qa_accessed": False,
                    "optimizer_executions": 0,
                    "val33_used_for_reproduction_only": True,
                },
                "continuation_plan_sha256": base.sha256_file(staging / PLAN),
                "current_cache": {
                    "arrays_sha256": base.sha256_file(
                        args.current_cache_dir.expanduser().resolve()
                        / v3_sweep.CACHE_ARRAYS
                    ),
                    "contract_sha256": base.sha256_file(
                        args.current_cache_dir.expanduser().resolve()
                        / v3_sweep.CACHE_CONTRACT
                    ),
                    "metrics": current_metrics,
                    "val_embedding_sha256": _array_sha(
                        current_arrays["human_val_embeddings"]
                    ),
                },
                "exact_head": {
                    "file": HEAD,
                    "sha256": base.sha256_file(staging / HEAD),
                    "source_checkpoint_sha256": STRONGEST_HEAD_SHA256,
                },
                "historical_cache": {
                    "arrays_sha256": HISTORICAL_CACHE_ARRAYS_SHA256,
                    "contract_sha256": HISTORICAL_CACHE_CONTRACT_SHA256,
                    "metrics": historical_metrics,
                    "val_embedding_sha256": _array_sha(
                        historical["arrays"]["human_val_embeddings"]
                    ),
                },
                "record_type": "manga_font_student_v5_reproduction_report",
                "reproduction": {
                    "current_cache_top1_decisions_match": True,
                    "expected_hits": EXPECTED_HITS,
                    "historical_metrics_exact_match": historical_metrics
                    == strongest["metrics"],
                    "status": "exact_strongest_head_reproduced_ready_for_overlay",
                },
                "schema_version": SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
            }
        )
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (REPORT, PLAN, HEAD)
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate(staging)
        os.rename(staging, output)
        published = True
        return validate(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    base.assert_exact_root_inventory(root, FILES, location="v5 readiness")
    marker = base.read_json(root / MARKER, location="v5 marker")
    report = base.read_json(root / REPORT, location="v5 report")
    plan = base.read_json(root / PLAN, location="v5 plan")
    base.validate_record_seal(report, location="v5 report")
    base.validate_record_seal(plan, location="v5 plan")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or plan.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV5PreparationError("v5 readiness metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v5 artifacts")
    for name in (REPORT, PLAN, HEAD):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV5PreparationError(f"v5 artifact hash drifted: {name}")
    if (
        base.sha256_file(root / HEAD) != STRONGEST_HEAD_SHA256
        or report.get("continuation_plan_sha256") != base.sha256_file(root / PLAN)
    ):
        raise MangaFontV5PreparationError("v5 strongest head/plan binding drifted")
    boundaries = _mapping(report.get("boundaries"), "v5 boundaries")
    if (
        boundaries.get("encoder_executions") != 0
        or boundaries.get("fresh64_accessed") is not False
        or boundaries.get("hidden_test_labels_deserialized") != 0
        or boundaries.get("hidden_test_pixels_opened") != 0
        or boundaries.get("library_40qa_accessed") is not False
        or boundaries.get("optimizer_executions") != 0
    ):
        raise MangaFontV5PreparationError("v5 readiness boundary drifted")
    reproduction = _mapping(report.get("reproduction"), "v5 reproduction")
    if (
        reproduction.get("historical_metrics_exact_match") is not True
        or reproduction.get("current_cache_top1_decisions_match") is not True
    ):
        raise MangaFontV5PreparationError("v5 strongest-head reproduction failed")
    current = _mapping(report.get("current_cache"), "v5 current cache")
    metrics = _mapping(current.get("metrics"), "v5 current metrics")
    _assert_expected_hits(metrics, location="sealed v5 current reproduction")
    return {
        "acceptable_hits": EXPECTED_HITS["acceptable_at1"],
        "output_dir": str(root),
        "preferred_hits": EXPECTED_HITS["preferred_at1"],
        "status": reproduction.get("status"),
        "variant_acceptable_hits": EXPECTED_HITS["variant_acceptable_at1"],
        "variant_preferred_hits": EXPECTED_HITS["variant_preferred_at1"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    reproduce_parser = subparsers.add_parser("reproduce")
    reproduce_parser.add_argument("--strongest-sweep-dir", type=Path, required=True)
    reproduce_parser.add_argument("--historical-cache-dir", type=Path, required=True)
    reproduce_parser.add_argument("--current-cache-dir", type=Path, required=True)
    reproduce_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = reproduce(args) if args.command == "reproduce" else validate(args.output_dir)
    except (
        MangaFontV5PreparationError,
        base.MangaFontStudentError,
        OSError,
        json.JSONDecodeError,
    ) as error:
        raise SystemExit(f"manga-font-v5-preparation error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
