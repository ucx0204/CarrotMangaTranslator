#!/usr/bin/env python3
"""Bounded high-confidence continuation sweep anchored to the r2 winner."""

from __future__ import annotations

import argparse
import copy
import os
import shutil
import tempfile
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v3 as v3
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_fontquery_r2 as r2
    from scripts import train_manga_font_student_v6_fontquery_r3 as r3
except ImportError:  # pragma: no cover
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v3 as v3
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_fontquery_r2 as r2
    import train_manga_font_student_v6_fontquery_r3 as r3


SCHEMA = "manga-font-student-v6-fontquery-r4-high100-bounded-v1"
OWNER = "carrot-manga-translator/manga-font-student-v6-fontquery-r4-high100-bounded-v1"
MARKER = ".manga-font-student-v6-fontquery-r4-high100-bounded-v1-owned.json"
REPORT = "report.json"
CHECKPOINT = "best-attempt-fontquery-head.safetensors"
PROTOTYPES = "best-attempt-candidate-query-prototypes.f32"
PREDICTIONS = "best-attempt-predictions-val.jsonl"
FILES = frozenset({MARKER, REPORT, CHECKPOINT, PROTOTYPES, PREDICTIONS})
ORIGINAL_ROWS = 109
FIRST40_ROWS = 40
REMAINING_HIGH_ROWS = 60
SELECTED_AUTHORITY_ROWS = 100
SELECTED_TRAIN_ROWS = 209
R2_ANCHOR_ROWS = 149


class BoundedR4Error(v6.MangaFontV6FontQueryError):
    """Raised when the bounded high-confidence sweep drifts."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise BoundedR4Error(f"{location}: expected object")
    return value


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise BoundedR4Error(f"missing r4 file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _trial_grid() -> tuple[dict[str, Any], ...]:
    return (
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "distill_weight": 2.0,
            "head_lr": 2e-5,
            "human_weight": 4.0,
            "new_high_weight": 1.0,
            "role_balanced": False,
        },
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "distill_weight": 3.0,
            "head_lr": 3e-5,
            "human_weight": 5.0,
            "new_high_weight": 2.0,
            "role_balanced": False,
        },
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "distill_weight": 2.0,
            "head_lr": 3e-5,
            "human_weight": 5.0,
            "new_high_weight": 2.0,
            "role_balanced": True,
        },
        {
            "attention_diversity_weight": 0.01,
            "consistency_weight": 0.05,
            "distill_weight": 4.0,
            "head_lr": 1e-5,
            "human_weight": 6.0,
            "new_high_weight": 3.0,
            "role_balanced": False,
        },
    )


def _selected_authority_indices(examples: Sequence[Any]) -> tuple[int, ...]:
    if len(examples) != r3.AUTHORITY_ROWS:
        raise BoundedR4Error("all160 gate count drifted")
    selected: list[int] = []
    high_remaining = 0
    for index, example in enumerate(examples):
        confidence = str(example.row.get("visual_judgment_confidence") or "")
        if index < FIRST40_ROWS or confidence == "high":
            selected.append(index)
            if index >= FIRST40_ROWS:
                high_remaining += 1
    if (
        len(selected) != SELECTED_AUTHORITY_ROWS
        or selected[:FIRST40_ROWS] != list(range(FIRST40_ROWS))
        or high_remaining != REMAINING_HIGH_ROWS
    ):
        raise BoundedR4Error("high-confidence subset is not first40+remaining-high60")
    return tuple(selected)


def _subset_arrays(
    arrays: Mapping[str, np.ndarray], selected_authority: Sequence[int]
) -> dict[str, np.ndarray]:
    keep = np.asarray(
        list(range(ORIGINAL_ROWS))
        + [ORIGINAL_ROWS + int(index) for index in selected_authority],
        dtype=np.int64,
    )
    if len(keep) != SELECTED_TRAIN_ROWS:
        raise BoundedR4Error("train209 subset index drifted")
    result = {name: np.array(value, copy=True) for name, value in arrays.items()}
    for name in (
        "human_train_tokens",
        "human_train_targets",
        "human_train_masks",
        "human_train_roles",
    ):
        result[name] = np.ascontiguousarray(result[name][keep])
        if result[name].shape[0] != SELECTED_TRAIN_ROWS:
            raise BoundedR4Error(f"{name} did not produce train209")
    return result


def _sampling_weights(
    torch: Any,
    human_roles: Any,
    *,
    new_high_weight: float,
    role_balanced: bool,
) -> Any:
    weights = torch.ones(len(human_roles), dtype=torch.float32)
    weights[R2_ANCHOR_ROWS:] *= float(new_high_weight)
    if role_balanced:
        counts = torch.bincount(human_roles.long())
        safe = counts.clamp_min(1).float()
        weights *= safe[human_roles.long()].rsqrt()
    return weights / weights.sum()


def _metric_summary(metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {
        name: copy.deepcopy(metrics[name])
        for name in (
            "acceptable_at1",
            "acceptable_hit_at3",
            "preferred_at1",
            "preferred_hit_at3",
            "tiered_gold_loss",
            "top1_candidate_distribution",
            "top1_max_candidate_share",
            "top1_unique_candidate_count",
            "variant_acceptable_at1",
            "variant_acceptable_hit_at3",
            "variant_preferred_at1",
            "variant_preferred_hit_at3",
            "variant_val_rows",
        )
    }


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise BoundedR4Error("bounded r4 output already exists")
    cache_contract = base.read_json(
        args.cache_dir.expanduser().resolve() / v6.CACHE_CONTRACT,
        location="r1 patch cache contract",
    )
    candidate_ids = tuple(str(value) for value in cache_contract["candidate_ids"])
    if len(candidate_ids) != 22:
        raise BoundedR4Error("candidate vocabulary drifted")

    # Same fail-before-pixels all160 authority gate as r3.
    gated_examples, validation = r3._authority_gate(args, candidate_ids)  # noqa: SLF001
    selected_authority = _selected_authority_indices(gated_examples)
    selected_ids = [gated_examples[index].sample_id for index in selected_authority]
    selected_confidence = Counter(
        str(gated_examples[index].row.get("visual_judgment_confidence"))
        for index in selected_authority
    )

    torch, _processor, _vision, save_file = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise BoundedR4Error("bounded r4 requires CUDA bf16")
    base._configure_reproducibility(torch, seed=args.seed)  # noqa: SLF001
    started = time.monotonic()
    full_arrays, authority_binding = r3.load_authority_and_encode(
        args=args,
        torch=torch,
        candidate_ids=candidate_ids,
        gated_examples=gated_examples,
        validation=validation,
    )
    arrays = _subset_arrays(full_arrays, selected_authority)
    del full_arrays, gated_examples
    r2_state, r2_report_sha = r3._load_r2_state(args.r2_output_dir)  # noqa: SLF001

    synthetic_tokens = torch.from_numpy(arrays["synthetic_tokens"])
    synthetic_labels = torch.from_numpy(arrays["synthetic_labels"]).long()
    human_tokens = torch.from_numpy(arrays["human_train_tokens"])
    human_targets = torch.from_numpy(arrays["human_train_targets"]).float()
    human_masks = torch.from_numpy(arrays["human_train_masks"]).bool()
    human_roles_cpu = torch.from_numpy(arrays["human_train_roles"]).long()
    val_tokens = v6._to_gpu(torch, arrays["human_val_tokens"], dtype=torch.float16)  # noqa: SLF001
    val_targets = v6._to_gpu(torch, arrays["human_val_targets"], dtype=torch.float32)  # noqa: SLF001
    val_masks = v6._to_gpu(torch, arrays["human_val_masks"], dtype=torch.bool)  # noqa: SLF001
    val_roles = v6._to_gpu(torch, arrays["human_val_roles"], dtype=torch.long)  # noqa: SLF001
    reference_tokens = v6._to_gpu(torch, arrays["reference_tokens"], dtype=torch.float16)  # noqa: SLF001
    reference_labels = v6._to_gpu(torch, arrays["reference_labels"], dtype=torch.long)  # noqa: SLF001
    del arrays

    teacher = v6.build_font_query_head(torch, query_count=4, query_dim=256).to("cuda")
    teacher.load_state_dict(r2_state, strict=True)
    teacher.eval()
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        teacher_val = teacher(val_tokens, reference_tokens, reference_labels, len(candidate_ids))
        teacher_human = teacher(
            human_tokens.to("cuda", dtype=torch.float16),
            reference_tokens,
            reference_labels,
            len(candidate_ids),
        )
    baseline_metrics, baseline_predictions = v6.compute_val_metrics(
        torch=torch,
        logits=teacher_val["candidate_scores"],
        targets=val_targets,
        masks=val_masks,
        roles=val_roles,
        candidate_ids=candidate_ids,
    )
    teacher_scores = teacher_human["candidate_scores"].detach().float()
    baseline_gate = v6.research_gate(baseline_metrics)
    del teacher, teacher_human, teacher_val

    best_metrics: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    best_state: dict[str, Any] | None = None
    best_prototypes: Any | None = None
    best_trial = 0
    best_epoch = 0
    trials: list[dict[str, Any]] = []
    for trial_index, config in enumerate(_trial_grid(), 1):
        base._configure_reproducibility(torch, seed=args.seed + trial_index)  # noqa: SLF001
        model = v6.build_font_query_head(torch, query_count=4, query_dim=256).to("cuda")
        model.load_state_dict(r2_state, strict=True)
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=float(config["head_lr"]), weight_decay=args.weight_decay
        )
        generator = torch.Generator(device="cpu").manual_seed(args.seed + trial_index)
        weights = _sampling_weights(
            torch,
            human_roles_cpu,
            new_high_weight=float(config["new_high_weight"]),
            role_balanced=bool(config["role_balanced"]),
        )
        trial_best: dict[str, Any] | None = None
        history: list[dict[str, Any]] = []
        stale = 0
        for epoch in range(1, args.epochs + 1):
            order = torch.randperm(len(synthetic_tokens), generator=generator)
            model.train(True)
            sums: Counter[str] = Counter()
            steps = 0
            for offset in range(0, len(order), args.synthetic_batch_size):
                synthetic_index = order[offset : offset + args.synthetic_batch_size]
                human_index = torch.multinomial(
                    weights,
                    args.human_batch_size,
                    replacement=True,
                    generator=generator,
                )
                batch_tokens = torch.cat(
                    (synthetic_tokens[synthetic_index], human_tokens[human_index]), dim=0
                ).to("cuda", dtype=torch.float16)
                synthetic_count = len(synthetic_index)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    result = model(
                        batch_tokens, reference_tokens, reference_labels, len(candidate_ids)
                    )
                    synthetic_loss = torch.nn.functional.cross_entropy(
                        result["candidate_scores"][:synthetic_count],
                        synthetic_labels[synthetic_index].to("cuda"),
                    )
                    current_human = result["candidate_scores"][synthetic_count:]
                    human_loss = v3.tiered_deployment_loss(
                        torch,
                        current_human,
                        human_targets[human_index].to("cuda"),
                        human_masks[human_index].to("cuda"),
                        preferred_weight=1.0,
                        acceptable_weight=0.20,
                    )
                    anchor_mask = human_index < R2_ANCHOR_ROWS
                    if bool(anchor_mask.any()):
                        anchor_index = human_index[anchor_mask]
                        distill = torch.nn.functional.kl_div(
                            torch.nn.functional.log_softmax(
                                current_human[anchor_mask].float(), dim=-1
                            ),
                            torch.nn.functional.softmax(
                                teacher_scores[anchor_index.to("cuda")], dim=-1
                            ),
                            reduction="batchmean",
                        )
                    else:
                        distill = current_human.sum() * 0.0
                    consistency = v6.view_invariance_loss(torch, result["view_embeddings"])
                    diversity = v6.attention_diversity_loss(torch, result["attention"])
                    loss = (
                        synthetic_loss
                        + float(config["human_weight"]) * human_loss
                        + float(config["distill_weight"]) * distill
                        + float(config["consistency_weight"]) * consistency
                        + float(config["attention_diversity_weight"]) * diversity
                    )
                if not bool(torch.isfinite(loss)):
                    raise BoundedR4Error("bounded r4 loss became nonfinite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
                optimizer.step()
                sums.update(
                    {
                        "consistency": float(consistency.detach().item()),
                        "distill": float(distill.detach().item()),
                        "diversity": float(diversity.detach().item()),
                        "human": float(human_loss.detach().item()),
                        "loss": float(loss.detach().item()),
                        "synthetic": float(synthetic_loss.detach().item()),
                    }
                )
                steps += 1
            model.eval()
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                val_result = model(val_tokens, reference_tokens, reference_labels, len(candidate_ids))
            metrics, predictions = v6.compute_val_metrics(
                torch=torch,
                logits=val_result["candidate_scores"],
                targets=val_targets,
                masks=val_masks,
                roles=val_roles,
                candidate_ids=candidate_ids,
            )
            history.append(
                {
                    "epoch": epoch,
                    "gate": v6.research_gate(metrics),
                    "train": {name: sums[name] / steps for name in sorted(sums)},
                    "val": _metric_summary(metrics),
                }
            )
            if trial_best is None or v6._metric_key(metrics) > v6._metric_key(trial_best):  # noqa: SLF001
                trial_best = copy.deepcopy(metrics)
                stale = 0
            else:
                stale += 1
            if best_metrics is None or v6._metric_key(metrics) > v6._metric_key(best_metrics):  # noqa: SLF001
                best_metrics = copy.deepcopy(metrics)
                best_predictions = copy.deepcopy(predictions)
                best_state = v6._state_cpu(model)  # noqa: SLF001
                best_prototypes = val_result["candidate_prototypes"].detach().float().cpu()
                best_trial = trial_index
                best_epoch = epoch
            if stale >= args.patience:
                break
        if trial_best is None:
            raise BoundedR4Error("bounded r4 trial produced no epoch")
        trials.append(
            {
                "best_val": _metric_summary(trial_best),
                "config": copy.deepcopy(config),
                "history": history,
                "trial": trial_index,
            }
        )
        del model, optimizer
        torch.cuda.empty_cache()
    if best_metrics is None or best_predictions is None or best_state is None or best_prototypes is None:
        raise BoundedR4Error("bounded r4 has no attempted model")

    attempted_gate = v6.research_gate(best_metrics)
    beats_r2 = v6._metric_key(best_metrics) > v6._metric_key(baseline_metrics)  # noqa: SLF001
    promotion_eligible = bool(attempted_gate["passed"] and beats_r2)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        save_file(
            best_state,
            str(staging / CHECKPOINT),
            metadata={"format": SCHEMA, "kind": "bounded-never-auto-stage-attempt"},
        )
        prototype_array = np.ascontiguousarray(best_prototypes.numpy(), dtype="<f4")
        (staging / PROTOTYPES).write_bytes(prototype_array.tobytes())
        with (staging / PREDICTIONS).open("wb") as handle:
            for row in best_predictions:
                handle.write(base.json_bytes(row))
        report = base.seal_record(
            {
                "authority": {
                    **authority_binding,
                    "selected_authority_count": SELECTED_AUTHORITY_ROWS,
                    "selected_confidence_counts": dict(sorted(selected_confidence.items())),
                    "selected_sample_ids_sha256": base.sha256_bytes(
                        "\n".join(selected_ids).encode("utf-8")
                    ),
                    "selection_policy": "sealed-first40-plus-remaining120-high-confidence-only",
                },
                "baseline_r2": {
                    "gate": baseline_gate,
                    "metrics": _metric_summary(baseline_metrics),
                    "report_sha256": r2_report_sha,
                },
                "best_attempt": {
                    "beats_r2_metric_order": beats_r2,
                    "epoch": best_epoch,
                    "gate": attempted_gate,
                    "metrics": _metric_summary(best_metrics),
                    "trial": best_trial,
                },
                "boundaries": {
                    "fresh64_labels_deserialized": 0,
                    "fresh64_pixels_opened": 0,
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "library_qa_labels_deserialized": 0,
                    "library_qa_pixels_opened": 0,
                    "selected_authority_rows": SELECTED_AUTHORITY_ROWS,
                    "selected_train_full22_rows": SELECTED_TRAIN_ROWS,
                    "test30_used_for_selection": False,
                    "val_rows": 33,
                    "val_used_for_early_stop": True,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(candidate_ids),
                "deployment": {
                    "approved": False,
                    "promotion_eligible": promotion_eligible,
                    "r2_remains_variant_winner": not promotion_eligible,
                    "runtime_status": (
                        "strict_gate_passed_candidate_requires_parent_qa"
                        if promotion_eligible
                        else "strict_gate_failed_never_stage"
                    ),
                },
                "files": {
                    "checkpoint": _descriptor(staging / CHECKPOINT),
                    "predictions": _descriptor(staging / PREDICTIONS),
                    "prototypes": {
                        **_descriptor(staging / PROTOTYPES),
                        "dtype": "float32",
                        "shape": list(prototype_array.shape),
                    },
                },
                "record_type": "manga_font_student_v6_fontquery_r4_high100_bounded_sweep",
                "schema_version": SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "timing_seconds": {"all160_encode_and_four_trial_sweep": time.monotonic() - started},
                "trials": trials,
            }
        )
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (CHECKPOINT, PREDICTIONS, PROTOTYPES, REPORT)
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging)
        os.rename(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    v6._assert_inventory(root, FILES, "bounded r4 output")  # noqa: SLF001
    marker = base.read_json(root / MARKER, location="bounded r4 marker")
    report = base.read_json(root / REPORT, location="bounded r4 report")
    base.validate_record_seal(report, location="bounded r4 report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256") != base.sha256_file(Path(__file__).resolve())
    ):
        raise BoundedR4Error("bounded r4 metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "bounded r4 artifacts")
    for name in FILES - {MARKER}:
        if artifacts.get(name) != base.sha256_file(root / name):
            raise BoundedR4Error(f"bounded r4 hash drifted: {name}")
    boundaries = _mapping(report.get("boundaries"), "bounded r4 boundaries")
    zero_fields = (
        "fresh64_labels_deserialized",
        "fresh64_pixels_opened",
        "human_test_labels_deserialized",
        "human_test_pixels_opened",
        "library_qa_labels_deserialized",
        "library_qa_pixels_opened",
    )
    if (
        any(int(boundaries.get(name, -1)) != 0 for name in zero_fields)
        or boundaries.get("selected_authority_rows") != SELECTED_AUTHORITY_ROWS
        or boundaries.get("selected_train_full22_rows") != SELECTED_TRAIN_ROWS
        or boundaries.get("val_rows") != 33
        or boundaries.get("test30_used_for_selection") is not False
        or boundaries.get("val_used_for_optimizer") is not False
    ):
        raise BoundedR4Error("bounded r4 leakage boundary drifted")
    baseline = _mapping(report.get("baseline_r2"), "r2 baseline")
    attempt = _mapping(report.get("best_attempt"), "best attempt")
    if baseline.get("gate") != v6.research_gate(_mapping(baseline.get("metrics"), "baseline metrics")):
        raise BoundedR4Error("bounded r4 baseline gate drifted")
    if attempt.get("gate") != v6.research_gate(_mapping(attempt.get("metrics"), "attempt metrics")):
        raise BoundedR4Error("bounded r4 attempt gate drifted")
    deployment = _mapping(report.get("deployment"), "bounded r4 deployment")
    promotion = bool(attempt["gate"]["passed"] and attempt.get("beats_r2_metric_order") is True)
    if deployment.get("approved") is not False or deployment.get("promotion_eligible") is not promotion:
        raise BoundedR4Error("bounded r4 deployment boundary drifted")
    if sum(
        bool(line.strip())
        for line in (root / PREDICTIONS).read_text(encoding="utf-8").splitlines()
    ) != 33:
        raise BoundedR4Error("bounded r4 prediction count drifted")
    metrics = _mapping(attempt.get("metrics"), "best attempt metrics")
    return {
        "acceptable_at1": metrics.get("acceptable_at1"),
        "output_dir": str(root),
        "preferred_at1": metrics.get("preferred_at1"),
        "promotion_eligible": promotion,
        "report_sha256": base.sha256_file(root / REPORT),
        "r2_remains_variant_winner": deployment.get("r2_remains_variant_winner"),
        "status": "sealed_bounded_research_only",
        "variant_acceptable_at1": metrics.get("variant_acceptable_at1"),
        "variant_preferred_at1": metrics.get("variant_preferred_at1"),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    train_parser = commands.add_parser("train")
    train_parser.add_argument("--cache-dir", type=Path, required=True)
    train_parser.add_argument("--r2-output-dir", type=Path, required=True)
    train_parser.add_argument("--authority-dir", type=Path, required=True)
    train_parser.add_argument("--review-dir", type=Path, required=True)
    train_parser.add_argument("--draft-dir", type=Path, required=True)
    train_parser.add_argument("--legacy-overlay-dir", type=Path, required=True)
    train_parser.add_argument("--catalog-registry", type=Path, required=True)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    train_parser.add_argument("--encode-batch-size", type=int, default=20)
    train_parser.add_argument("--epochs", type=int, default=10)
    train_parser.add_argument("--patience", type=int, default=3)
    train_parser.add_argument("--synthetic-batch-size", type=int, default=40)
    train_parser.add_argument("--human-batch-size", type=int, default=24)
    train_parser.add_argument("--weight-decay", type=float, default=0.01)
    train_parser.add_argument("--gradient-clip", type=float, default=1.0)
    train_parser.add_argument("--seed", type=int, default=20260803)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = train(args) if args.command == "train" else validate_output(args.output_dir)
    except (base.MangaFontStudentError, OSError) as error:
        raise SystemExit(f"bounded-r4 error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
