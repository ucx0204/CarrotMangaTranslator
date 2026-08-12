#!/usr/bin/env python3
"""Select safe v8.2 residual scales on the r3 work holdout.

The token checkpoint is frozen.  Candidate and family residual strengths are
searched independently on the 9,033-row r3 adapter holdout, with the 1,047-row
visual-authority slice acting as the font-quality gate.  The repeatedly seen
human val33 cohort is not read until every scale winner has been selected.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import tempfile
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import ablate_manga_font_v2_candidate_score_ensembles as ensemble
    from scripts import build_manga_font_master_v3_siglip2_hidden_cache as hidden
    from scripts import train_manga_font_student_v82_token_attention_adapter as v82
    from scripts import train_manga_font_student_v8_role_family_adapter as base
except ImportError:  # pragma: no cover - direct execution from scripts/
    import ablate_manga_font_v2_candidate_score_ensembles as ensemble
    import build_manga_font_master_v3_siglip2_hidden_cache as hidden
    import train_manga_font_student_v82_token_attention_adapter as v82
    import train_manga_font_student_v8_role_family_adapter as base


SCHEMA = "manga-font-student-v82-residual-scale-ablation-v1"
OWNER = "carrot-manga-translator/manga-font-student-v82-residual-scale-ablation-v1"
REPORT = "report.json"
MARKER = ".manga-font-student-v82-residual-scale-ablation-owned.json"
OUTPUT_FILES = frozenset({REPORT, MARKER})
DEFAULT_ALPHAS = (0.0, 0.25, 0.5, 0.75, 1.0, 1.25)
BASE_MODES = ("r3h", "r3h_v7_probability_blend_0.15")


class ResidualScaleAblationError(ValueError):
    """Raised when an ablation boundary or artifact binding is invalid."""


def parse_alpha_grid(value: str) -> tuple[float, ...]:
    try:
        result = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise ResidualScaleAblationError("residual alpha grid is invalid") from error
    if (
        not result
        or len(set(result)) != len(result)
        or any(not math.isfinite(item) or item < 0.0 or item > 1.25 for item in result)
    ):
        raise ResidualScaleAblationError("residual alpha grid escaped [0, 1.25]")
    return result


def scaled_outputs(
    *,
    body_scores: np.ndarray,
    variant_scores: np.ndarray,
    family_logits: np.ndarray,
    candidate_residual: np.ndarray,
    family_residual: np.ndarray,
    candidate_alpha: float,
    family_alpha: float,
) -> dict[str, np.ndarray]:
    row_count, candidate_count = body_scores.shape
    if (
        variant_scores.shape != (row_count, candidate_count)
        or family_logits.shape != (row_count, 2)
        or candidate_residual.shape != (row_count, 2, candidate_count)
        or family_residual.shape != (row_count, 2)
        or not 0.0 <= candidate_alpha <= 1.25
        or not 0.0 <= family_alpha <= 1.25
    ):
        raise ResidualScaleAblationError("scaled output tensor contract drifted")
    return {
        "body_candidate_scores": (
            body_scores + float(candidate_alpha) * candidate_residual[:, 0]
        ).astype(np.float32),
        "variant_candidate_scores": (
            variant_scores + float(candidate_alpha) * candidate_residual[:, 1]
        ).astype(np.float32),
        "family_logits": (
            family_logits + float(family_alpha) * family_residual
        ).astype(np.float32),
    }


def compact_metrics(metrics: Mapping[str, Any]) -> dict[str, Any]:
    eligibility = metrics["single_day_eligibility"]
    return {
        "acceptable_at1": float(metrics["acceptable_at1"]),
        "family_accuracy": float(metrics["family_accuracy"]),
        "font_supervised_rows": int(metrics["font_supervised_rows"]),
        "preferred_at1": float(metrics["preferred_at1"]),
        "preferred_supervised_rows": int(metrics["preferred_supervised_rows"]),
        "rows": int(metrics["rows"]),
        "single_day_all_top1_count": int(eligibility["eligible_top1_all_rows"]),
        "single_day_all_top1_rate": float(eligibility["eligible_top1_all_rows_rate"]),
        "single_day_body_false_top1_count": int(
            metrics["single_day_body_false_top1_count"]
        ),
        "single_day_body_false_top1_rate": float(
            metrics["single_day_body_false_top1_rate"]
        ),
        "single_day_positive_count": int(metrics["single_day_positive_count"]),
        "single_day_positive_precision": float(
            metrics["single_day_positive_precision"]
        ),
        "single_day_positive_recall": float(metrics["single_day_positive_recall"]),
        "single_day_predicted_count": int(metrics["single_day_predicted_count"]),
        "top1_max_candidate_share": float(metrics["top1_max_candidate_share"]),
        "top1_unique_candidate_count": int(metrics["top1_unique_candidate_count"]),
    }


def selection_key(record: Mapping[str, Any]) -> tuple[float, ...]:
    visual = record["visual_metrics"]
    all_rows = record["r3_holdout_metrics"]
    return (
        float(bool(record["quality_passed"])),
        float(visual["acceptable_at1"]),
        float(visual["preferred_at1"]),
        float(all_rows["family_accuracy"]),
        -float(all_rows["single_day_all_top1_rate"]),
        -float(visual["top1_max_candidate_share"]),
        -float(record["candidate_residual_alpha"]),
        -float(record["family_residual_alpha"]),
    )


def select_r3_winner(records: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    if not records or any("val33" in key for record in records for key in record):
        raise ResidualScaleAblationError(
            "selection records must be nonempty and val33-blind"
        )
    passing = [record for record in records if record.get("quality_passed") is True]
    if not passing:
        raise ResidualScaleAblationError("no residual scale passed the r3 gates")
    return max(passing, key=selection_key)


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ResidualScaleAblationError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise ResidualScaleAblationError(f"{location}: expected object")
    return value


def _validate_sealed_record(value: Mapping[str, Any], location: str) -> None:
    core = dict(value)
    expected = core.pop("record_sha256", None)
    if expected != base.seal_record(core)["record_sha256"]:
        raise ResidualScaleAblationError(f"{location}: record seal drifted")


def _load_score_archive(
    path: Path, expected_sample_ids: np.ndarray, candidate_count: int
) -> dict[str, np.ndarray]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise ResidualScaleAblationError("score archive is missing or linked")
    expected_names = {
        "family_logits",
        "sample_ids",
        "v6_r2_scores",
        "v7_r5_scores",
        "r3h_body_scores",
        "r3h_variant_scores",
    }
    with np.load(resolved, allow_pickle=False) as source:
        if set(source.files) != expected_names:
            raise ResidualScaleAblationError("score archive inventory drifted")
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    rows = len(expected_sample_ids)
    if not np.array_equal(arrays["sample_ids"].astype(str), expected_sample_ids.astype(str)):
        raise ResidualScaleAblationError("score archive sample order drifted")
    if arrays["family_logits"].shape != (rows, 2):
        raise ResidualScaleAblationError("score archive family shape drifted")
    for name in (
        "v6_r2_scores",
        "v7_r5_scores",
        "r3h_body_scores",
        "r3h_variant_scores",
    ):
        if arrays[name].shape != (rows, candidate_count):
            raise ResidualScaleAblationError(f"score archive shape drifted: {name}")
    if any(
        not np.isfinite(arrays[name]).all()
        for name in expected_names
        if name != "sample_ids"
    ):
        raise ResidualScaleAblationError("score archive contains non-finite values")
    return arrays


def _load_token_model(
    *, torch: Any, adapter_dir: Path, candidate_ids: Sequence[str], device: Any
) -> tuple[Any, Mapping[str, Any]]:
    from safetensors.torch import load_file

    root = adapter_dir.expanduser().resolve()
    validation = v82.validate_output(root)
    if validation.get("quality_gate_passed") is not True:
        raise ResidualScaleAblationError("token adapter quality gate failed")
    manifest = _read_json(root / v82.OUTPUT_MANIFEST, "token adapter manifest")
    if (
        manifest.get("schema_version") != v82.OUTPUT_SCHEMA
        or tuple(manifest.get("candidate_ids", ())) != tuple(candidate_ids)
    ):
        raise ResidualScaleAblationError("token adapter identity drifted")
    architecture = manifest.get("architecture")
    if not isinstance(architecture, Mapping) or architecture.get("input_mode") != "trainable_raw":
        raise ResidualScaleAblationError("scale ablation requires trainable_raw tokens")
    model = v82.build_token_attention_residual(
        torch,
        candidate_count=len(candidate_ids),
        input_mode="trainable_raw",
        rank=int(architecture["rank"]),
        attention_queries=int(architecture["attention_queries"]),
        hidden_dim=int(architecture["hidden_dim"]),
        dropout=float(architecture["dropout"]),
        maximum_candidate_residual=float(
            architecture["maximum_candidate_residual"]
        ),
        maximum_family_residual=float(architecture["maximum_family_residual"]),
    )
    checkpoint = root / v82.OUTPUT_CHECKPOINT
    try:
        model.load_state_dict(dict(load_file(str(checkpoint), device="cpu")), strict=True)
    except Exception as error:  # noqa: BLE001
        raise ResidualScaleAblationError(
            f"token checkpoint reconstruction failed: {error}"
        ) from error
    return model.to(device).eval().requires_grad_(False), manifest


def _metric_pair(
    *,
    torch: Any,
    outputs: Mapping[str, np.ndarray],
    arrays: Mapping[str, np.ndarray],
    val_positions: np.ndarray,
    visual_local: np.ndarray,
    candidate_ids: Sequence[str],
    device: Any,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    visual_positions = val_positions[visual_local]
    visual_mask = np.zeros(len(val_positions), dtype=bool)
    visual_mask[visual_local] = True
    all_weights = np.where(
        visual_mask,
        arrays["font_supervision_weights"][val_positions],
        0.0,
    ).astype(np.float32)
    holdout = v82._metrics(  # noqa: SLF001 - shared sealed metric contract
        torch=torch,
        outputs=outputs,
        arrays=arrays,
        positions=val_positions,
        font_weights=all_weights,
        candidate_ids=candidate_ids,
        device=device,
    )
    visual_outputs = {name: value[visual_local] for name, value in outputs.items()}
    visual = v82._metrics(  # noqa: SLF001
        torch=torch,
        outputs=visual_outputs,
        arrays=arrays,
        positions=visual_positions,
        font_weights=arrays["font_supervision_weights"][visual_positions],
        candidate_ids=candidate_ids,
        device=device,
    )
    return holdout, visual


def _base_score_sets(score_arrays: Mapping[str, np.ndarray]) -> Mapping[str, tuple[np.ndarray, np.ndarray]]:
    r3h_body = score_arrays["r3h_body_scores"]
    r3h_variant = score_arrays["r3h_variant_scores"]
    v7 = score_arrays["v7_r5_scores"]
    return {
        "r3h": (r3h_body, r3h_variant),
        "r3h_v7_probability_blend_0.15": (
            ensemble.convex_probability_blend(r3h_body, v7, 0.15),
            ensemble.convex_probability_blend(r3h_variant, v7, 0.15),
        ),
    }


def _record_for_configuration(
    *,
    torch: Any,
    base_mode: str,
    body_scores: np.ndarray,
    variant_scores: np.ndarray,
    family_logits: np.ndarray,
    residuals: Mapping[str, np.ndarray],
    candidate_alpha: float,
    family_alpha: float,
    arrays: Mapping[str, np.ndarray],
    val_positions: np.ndarray,
    visual_local: np.ndarray,
    candidate_ids: Sequence[str],
    device: Any,
) -> Mapping[str, Any]:
    outputs = scaled_outputs(
        body_scores=body_scores,
        variant_scores=variant_scores,
        family_logits=family_logits,
        candidate_residual=residuals["candidate_residual"],
        family_residual=residuals["family_residual"],
        candidate_alpha=candidate_alpha,
        family_alpha=family_alpha,
    )
    holdout, visual = _metric_pair(
        torch=torch,
        outputs=outputs,
        arrays=arrays,
        val_positions=val_positions,
        visual_local=visual_local,
        candidate_ids=candidate_ids,
        device=device,
    )
    checks = base.build_quality_gate_checks(holdout, visual)
    return {
        "base_mode": base_mode,
        "candidate_residual_alpha": candidate_alpha,
        "family_residual_alpha": family_alpha,
        "quality_checks": checks,
        "quality_passed": all(checks.values()),
        "r3_holdout_metrics": compact_metrics(holdout),
        "visual_metrics": compact_metrics(visual),
    }


def run(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    output = v82._safe_output(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise ResidualScaleAblationError("ablation output already exists")
    dataset_path, arrays = v82._load_dataset_arrays(args.dataset_npz)  # noqa: SLF001
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    val_positions = np.flatnonzero(arrays["split"] == 1)
    authorities = arrays["font_authority"].astype(str)
    visual_local = np.flatnonzero(authorities[val_positions] == "visual")
    if len(val_positions) != 9033 or len(visual_local) != 1047:
        raise ResidualScaleAblationError("r3 selection boundary drifted")
    expected_val_ids = arrays["sample_ids"][val_positions]
    score_arrays = _load_score_archive(
        args.score_archive, expected_val_ids, len(candidate_ids)
    )
    if not np.allclose(
        score_arrays["family_logits"],
        score_arrays["family_logits"].astype(np.float32),
    ):
        raise ResidualScaleAblationError("family logits precision drifted")

    import torch

    if args.device == "cuda" and not torch.cuda.is_available():
        raise ResidualScaleAblationError("CUDA requested but unavailable")
    device = torch.device(args.device)
    token_model, token_manifest = _load_token_model(
        torch=torch,
        adapter_dir=args.token_adapter_dir,
        candidate_ids=candidate_ids,
        device=device,
    )
    cache_root = args.hidden_cache_dir.expanduser().resolve()
    cache_manifest = v82._read_json(  # noqa: SLF001
        cache_root / hidden.MANIFEST, "hidden manifest"
    )
    cache_indices = v82._cache_indices_for_samples(  # noqa: SLF001
        cache_root, tuple(str(value) for value in arrays["sample_ids"].tolist())
    )
    residuals = v82._infer_residuals_raw_streaming(  # noqa: SLF001
        torch=torch,
        model=token_model,
        cache_root=cache_root,
        cache_manifest=cache_manifest,
        cache_indices=cache_indices,
        positions=val_positions,
        device=device,
        batch_size=args.hidden_batch_size,
    )
    del token_model
    if device.type == "cuda":
        torch.cuda.empty_cache()

    candidate_alphas = parse_alpha_grid(args.candidate_alphas)
    family_alphas = parse_alpha_grid(args.family_alphas)
    score_sets = _base_score_sets(score_arrays)
    records: list[Mapping[str, Any]] = []
    winners: dict[str, Mapping[str, Any]] = {}
    for base_mode, (body_scores, variant_scores) in score_sets.items():
        base_records: list[Mapping[str, Any]] = []
        for candidate_alpha in candidate_alphas:
            for family_alpha in family_alphas:
                record = _record_for_configuration(
                    torch=torch,
                    base_mode=base_mode,
                    body_scores=body_scores,
                    variant_scores=variant_scores,
                    family_logits=score_arrays["family_logits"],
                    residuals=residuals,
                    candidate_alpha=candidate_alpha,
                    family_alpha=family_alpha,
                    arrays=arrays,
                    val_positions=val_positions,
                    visual_local=visual_local,
                    candidate_ids=candidate_ids,
                    device=device,
                )
                records.append(record)
                base_records.append(record)
        winners[base_mode] = select_r3_winner(base_records)

    global_winner = select_r3_winner(tuple(winners.values()))

    # The human diagnostic is intentionally opened only after every r3-only
    # winner above has been selected.
    val33_positions = v82._val33_positions(  # noqa: SLF001
        arrays["sample_ids"], args.val33_finals.expanduser().resolve()
    )
    val_lookup = {int(position): index for index, position in enumerate(val_positions)}
    if any(int(position) not in val_lookup for position in val33_positions):
        raise ResidualScaleAblationError("val33 escaped the r3 validation split")
    val33_local = np.asarray(
        [val_lookup[int(position)] for position in val33_positions], dtype=np.int64
    )
    winner_reports: dict[str, Mapping[str, Any]] = {}
    for base_mode, winner in winners.items():
        body_scores, variant_scores = score_sets[base_mode]
        outputs = scaled_outputs(
            body_scores=body_scores,
            variant_scores=variant_scores,
            family_logits=score_arrays["family_logits"],
            candidate_residual=residuals["candidate_residual"],
            family_residual=residuals["family_residual"],
            candidate_alpha=float(winner["candidate_residual_alpha"]),
            family_alpha=float(winner["family_residual_alpha"]),
        )
        val33_outputs = {name: value[val33_local] for name, value in outputs.items()}
        val33_metrics = v82._metrics(  # noqa: SLF001
            torch=torch,
            outputs=val33_outputs,
            arrays=arrays,
            positions=val33_positions,
            font_weights=arrays["font_supervision_weights"][val33_positions],
            candidate_ids=candidate_ids,
            device=device,
        )
        winner_reports[base_mode] = {
            **winner,
            "val33_diagnostic_after_selection": compact_metrics(val33_metrics),
        }

    report = base.seal_record(
        {
            "base_modes": list(BASE_MODES),
            "boundaries": {
                "candidate_or_family_parameters_updated": 0,
                "checkpoint_selection_authority": "r3_work_holdout_visual1047_plus_all9033_family_and_single_day",
                "production_route": "predicted_pixel_family_with_single_day_eligibility",
                "test_split_rows_read": 0,
                "token_checkpoint_frozen": True,
                "val33_read_after_all_r3_winners_selected": True,
                "val33_used_for_checkpoint_or_scale_selection": False,
                "val33_used_for_gradient": False,
            },
            "candidate_alphas": list(candidate_alphas),
            "elapsed_seconds": time.perf_counter() - started,
            "family_alphas": list(family_alphas),
            "global_r3_winner_base_mode": global_winner["base_mode"],
            "grid": records,
            "record_type": "manga_font_student_v82_residual_scale_ablation",
            "schema_version": SCHEMA,
            "selection_policy": [
                "quality_gate_pass",
                "visual_acceptable_at1",
                "visual_preferred_at1",
                "all9033_family_accuracy",
                "lower_all9033_single_day_rate",
                "lower_visual_max_candidate_share",
                "lower_candidate_alpha_tiebreak",
                "lower_family_alpha_tiebreak",
            ],
            "sources": {
                "dataset_npz_sha256": base.sha256_file(dataset_path),
                "hidden_manifest_sha256": base.sha256_file(
                    cache_root / hidden.MANIFEST
                ),
                "score_archive_sha256": base.sha256_file(
                    args.score_archive.expanduser().resolve()
                ),
                "token_adapter_checkpoint_sha256": base.sha256_file(
                    args.token_adapter_dir.expanduser().resolve()
                    / v82.OUTPUT_CHECKPOINT
                ),
                "token_adapter_manifest_record_sha256": token_manifest[
                    "record_sha256"
                ],
                "val33_finals_sha256": base.sha256_file(
                    args.val33_finals.expanduser().resolve()
                ),
            },
            "winner_reports": winner_reports,
        }
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = base.seal_record(
            {
                "artifacts": {REPORT: base.sha256_file(staging / REPORT)},
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging)
        v82._publish_directory(staging, output)  # noqa: SLF001
        published = True
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or {p.name for p in root.iterdir()} != OUTPUT_FILES:
        raise ResidualScaleAblationError("ablation output inventory drifted")
    report = _read_json(root / REPORT, "ablation report")
    marker = _read_json(root / MARKER, "ablation marker")
    _validate_sealed_record(report, "ablation report")
    _validate_sealed_record(marker, "ablation marker")
    if (
        report.get("schema_version") != SCHEMA
        or marker.get("schema_version") != SCHEMA
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("artifacts", {}).get(REPORT) != base.sha256_file(root / REPORT)
    ):
        raise ResidualScaleAblationError("ablation metadata drifted")
    boundaries = report.get("boundaries")
    if not isinstance(boundaries, Mapping) or (
        boundaries.get("val33_used_for_checkpoint_or_scale_selection") is not False
        or boundaries.get("val33_used_for_gradient") is not False
        or boundaries.get("val33_read_after_all_r3_winners_selected") is not True
        or boundaries.get("test_split_rows_read") != 0
    ):
        raise ResidualScaleAblationError("ablation leakage boundary drifted")
    grid = report.get("grid")
    if not isinstance(grid, list) or any(
        "val33_diagnostic_after_selection" in row
        for row in grid
        if isinstance(row, Mapping)
    ):
        raise ResidualScaleAblationError("val33 leaked into selection grid")
    winners = report.get("winner_reports")
    if not isinstance(winners, Mapping) or set(winners) != set(BASE_MODES):
        raise ResidualScaleAblationError("ablation winner inventory drifted")
    if any(
        not isinstance(value, Mapping)
        or value.get("quality_passed") is not True
        or "val33_diagnostic_after_selection" not in value
        for value in winners.values()
    ):
        raise ResidualScaleAblationError("ablation winner failed its gate")
    selected = winners[str(report["global_r3_winner_base_mode"])]
    return {
        "candidate_residual_alpha": selected["candidate_residual_alpha"],
        "family_residual_alpha": selected["family_residual_alpha"],
        "global_r3_winner_base_mode": selected["base_mode"],
        "output_dir": str(root),
        "report_sha256": base.sha256_file(root / REPORT),
        "status": "validated_v82_residual_scale_ablation",
        "val33_acceptable_at1": selected["val33_diagnostic_after_selection"][
            "acceptable_at1"
        ],
        "val33_preferred_at1": selected["val33_diagnostic_after_selection"][
            "preferred_at1"
        ],
        "visual_acceptable_at1": selected["visual_metrics"]["acceptable_at1"],
        "visual_preferred_at1": selected["visual_metrics"]["preferred_at1"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--dataset-npz", type=Path, required=True)
    run_parser.add_argument("--hidden-cache-dir", type=Path, required=True)
    run_parser.add_argument("--token-adapter-dir", type=Path, required=True)
    run_parser.add_argument("--score-archive", type=Path, required=True)
    run_parser.add_argument("--val33-finals", type=Path, required=True)
    run_parser.add_argument("--output-dir", type=Path, required=True)
    default_grid = ",".join(str(value) for value in DEFAULT_ALPHAS)
    run_parser.add_argument("--candidate-alphas", default=default_grid)
    run_parser.add_argument("--family-alphas", default=default_grid)
    run_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    run_parser.add_argument("--hidden-batch-size", type=int, default=64)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "run":
            if args.hidden_batch_size < 1:
                raise ResidualScaleAblationError("hidden batch size must be positive")
            result = run(args)
        else:
            result = validate_output(args.output_dir)
    except (
        OSError,
        RuntimeError,
        ResidualScaleAblationError,
        v82.TokenAttentionAdapterError,
        base.MangaFontV8RoleFamilyError,
    ) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
