#!/usr/bin/env python3
"""Train the sealed v6 font-query r3 continuation on all160 authority rows.

The immutable r1 patch cache contributes the original strict full22 train109,
synthetic references, and adjudicated val33.  Exactly 160 completed train-only
visual judgments are encoded and appended, producing 269 real full22 rows.
Selection and early stopping use val33 only.
"""

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
    from scripts import build_manga_font_legacy_new7_expansion_review_v1 as authority
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v3 as v3
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_fontquery_r2 as r2
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_legacy_new7_expansion_review_v1 as authority
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v3 as v3
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_fontquery_r2 as r2


SCHEMA = "manga-font-student-v6-fontquery-r3-all160-v1"
OWNER = "carrot-manga-translator/manga-font-student-v6-fontquery-r3-all160-v1"
MARKER = ".manga-font-student-v6-fontquery-r3-all160-v1-owned.json"
REPORT = "report.json"
CHECKPOINT = "best-fontquery-head.safetensors"
PROTOTYPES = "candidate-query-prototypes.f32"
PREDICTIONS = "predictions-val.jsonl"
FILES = frozenset({MARKER, REPORT, CHECKPOINT, PROTOTYPES, PREDICTIONS})
AUTHORITY_ROWS = 160
ORIGINAL_FULL22_ROWS = 109
FULL22_ROWS = 269
VAL_ROWS = 33


class MangaFontV6R3Error(v6.MangaFontV6FontQueryError):
    """Raised when the all160 continuation boundary drifts."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV6R3Error(f"{location}: expected object")
    return value


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV6R3Error(f"missing r3 file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _trial_grid() -> tuple[dict[str, Any], ...]:
    """Bounded 4x256 grid centered on the r2 winning hyperparameters."""

    return (
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "head_lr": 5e-5,
            "human_weight": 6.0,
            "query_count": 4,
            "query_dim": 256,
            "warm_r2": True,
        },
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "head_lr": 1e-4,
            "human_weight": 5.0,
            "query_count": 4,
            "query_dim": 256,
            "warm_r2": False,
        },
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "head_lr": 1e-4,
            "human_weight": 7.0,
            "query_count": 4,
            "query_dim": 256,
            "warm_r2": False,
        },
    )


def _authority_gate(
    args: argparse.Namespace, candidate_ids: tuple[str, ...]
) -> tuple[tuple[Any, ...], dict[str, Any]]:
    """Fail before loading the vision model or opening a single image."""

    examples, validation = authority.load_authority_examples(
        args.authority_dir,
        review_dir=args.review_dir,
        draft_dir=args.draft_dir,
        legacy_overlay_dir=args.legacy_overlay_dir,
        catalog_registry=args.catalog_registry,
    )
    required_zero = (
        "old15_membership_mutation_count",
        "fabricated_new7_negative_count",
        "test_overlap_count",
        "val_overlap_count",
        "fresh64_overlap_count",
        "qa40_overlap_count",
    )
    if (
        len(examples) != AUTHORITY_ROWS
        or int(validation.get("upgraded_record_count", 0)) != AUTHORITY_ROWS
        or int(validation.get("new7_visual_judgment_record_count", 0)) != AUTHORITY_ROWS
        or int(validation.get("full22_train_rows_after_apply", 0)) != FULL22_ROWS
        or validation.get("status") != "ready_for_legacy_new7_full22_train_upgrade"
        or validation.get("completed_human_visual_provenance") is not True
        or any(int(validation.get(name, -1)) != 0 for name in required_zero)
    ):
        raise MangaFontV6R3Error("all160 authority is unsafe")
    if any(
        v3.candidate_supervision_scope(row, candidate_ids)[
            "partial_candidate_supervision"
        ]
        for row in examples
    ):
        raise MangaFontV6R3Error("all160 authority contains partial supervision")
    return examples, copy.deepcopy(validation)


def load_authority_and_encode(
    *,
    args: argparse.Namespace,
    torch: Any,
    candidate_ids: tuple[str, ...],
    gated_examples: tuple[Any, ...],
    validation: Mapping[str, Any],
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    cache_contract, arrays = v6._load_cache(args.cache_dir)  # noqa: SLF001
    cached_ids = {
        str(_mapping(row, "cached train row").get("sample_id"))
        for row in cache_contract.get("human_train", ())
    }
    authority_ids = {row.sample_id for row in gated_examples}
    if (
        len(cached_ids) != ORIGINAL_FULL22_ROWS
        or len(authority_ids) != AUTHORITY_ROWS
        or cached_ids & authority_ids
        or len(cached_ids | authority_ids) != FULL22_ROWS
    ):
        raise MangaFontV6R3Error("all160/original109 identity boundary drifted")

    _torch, processor_class, vision_class, _save_file = (
        base._load_training_dependencies()
    )  # noqa: SLF001
    processor = processor_class.from_pretrained(
        base.MODEL_ID,
        revision=base.MODEL_REVISION,
        use_fast=base.PROCESSOR_USE_FAST,
        local_files_only=True,
    )
    encoder = (
        vision_class.from_pretrained(
            base.MODEL_ID,
            revision=base.MODEL_REVISION,
            local_files_only=True,
        )
        .eval()
        .requires_grad_(False)
        .to("cuda")
    )
    try:
        from font_matching_catalog_assets import CatalogAssetResolver
    except ImportError:  # pragma: no cover
        from scripts.font_matching_catalog_assets import CatalogAssetResolver
    resolver = CatalogAssetResolver(args.catalog_registry.expanduser().resolve())
    tokens = v6._encode_image_groups(  # noqa: SLF001
        torch=torch,
        encoder=encoder,
        processor=processor,
        examples=gated_examples,
        opener=lambda row: base._open_human_views(row, resolver),  # noqa: SLF001
        view_count=len(base.VIEW_NAMES),
        batch_size=args.encode_batch_size,
    )
    new_arrays = v6._human_arrays(gated_examples, candidate_ids)  # noqa: SLF001
    result = {name: np.array(value, copy=True) for name, value in arrays.items()}
    result["human_train_tokens"] = np.concatenate(
        (result["human_train_tokens"], tokens), axis=0
    )
    result["human_train_targets"] = np.concatenate(
        (result["human_train_targets"], new_arrays["targets"]), axis=0
    )
    result["human_train_masks"] = np.concatenate(
        (result["human_train_masks"], new_arrays["masks"]), axis=0
    )
    result["human_train_roles"] = np.concatenate(
        (result["human_train_roles"], new_arrays["roles"]), axis=0
    )
    if (
        result["human_train_tokens"].shape[0] != FULL22_ROWS
        or result["human_train_targets"].shape[0] != FULL22_ROWS
        or result["human_train_masks"].shape[0] != FULL22_ROWS
    ):
        raise MangaFontV6R3Error("all160 append did not produce train269")
    del encoder
    torch.cuda.empty_cache()
    return result, {
        "authority_file_sha256": base.sha256_file(
            args.authority_dir.expanduser().resolve() / authority.AUTHORITY_FILE
        ),
        "authority_report_sha256": base.sha256_file(
            args.authority_dir.expanduser().resolve() / authority.REPORT_FILE
        ),
        "cache_contract_sha256": base.sha256_file(
            args.cache_dir.expanduser().resolve() / v6.CACHE_CONTRACT
        ),
        "validation": copy.deepcopy(dict(validation)),
    }


def _load_r2_state(path: Path) -> tuple[dict[str, Any], str]:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV6R3Error("safetensors is required") from error
    root = path.expanduser().resolve()
    r2.validate_output(root)
    return (
        dict(load_file(str(root / r2.CHECKPOINT), device="cpu")),
        base.sha256_file(root / r2.REPORT),
    )


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontV6R3Error("r3 output already exists")

    # Read only the cache contract to establish the vocabulary; the authority
    # gate below runs before CUDA dependencies, SigLIP2, or any pixels are opened.
    cache_contract = base.read_json(
        args.cache_dir.expanduser().resolve() / v6.CACHE_CONTRACT,
        location="r1 patch cache contract",
    )
    candidate_ids = tuple(str(value) for value in cache_contract["candidate_ids"])
    if len(candidate_ids) != 22:
        raise MangaFontV6R3Error("r3 candidate vocabulary drifted")
    gated_examples, validation = _authority_gate(args, candidate_ids)

    torch, _processor, _vision, save_file = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise MangaFontV6R3Error("r3 requires CUDA bf16")
    base._configure_reproducibility(torch, seed=args.seed)  # noqa: SLF001
    started = time.monotonic()
    arrays, authority_binding = load_authority_and_encode(
        args=args,
        torch=torch,
        candidate_ids=candidate_ids,
        gated_examples=gated_examples,
        validation=validation,
    )
    r2_state, r2_report_sha = _load_r2_state(args.r2_output_dir)

    synthetic_tokens = torch.from_numpy(arrays["synthetic_tokens"])
    synthetic_labels = torch.from_numpy(arrays["synthetic_labels"]).long()
    human_tokens = torch.from_numpy(arrays["human_train_tokens"])
    human_targets = torch.from_numpy(arrays["human_train_targets"]).float()
    human_masks = torch.from_numpy(arrays["human_train_masks"]).bool()
    val_tokens = v6._to_gpu(torch, arrays["human_val_tokens"], dtype=torch.float16)  # noqa: SLF001
    val_targets = v6._to_gpu(torch, arrays["human_val_targets"], dtype=torch.float32)  # noqa: SLF001
    val_masks = v6._to_gpu(torch, arrays["human_val_masks"], dtype=torch.bool)  # noqa: SLF001
    val_roles = v6._to_gpu(torch, arrays["human_val_roles"], dtype=torch.long)  # noqa: SLF001
    reference_tokens = v6._to_gpu(  # noqa: SLF001
        torch, arrays["reference_tokens"], dtype=torch.float16
    )
    reference_labels = v6._to_gpu(  # noqa: SLF001
        torch, arrays["reference_labels"], dtype=torch.long
    )
    del arrays, gated_examples

    best_metrics: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    best_state: dict[str, Any] | None = None
    best_prototypes: Any | None = None
    best_trial = 0
    best_epoch = 0
    trials: list[dict[str, Any]] = []
    for trial_index, config in enumerate(_trial_grid(), 1):
        base._configure_reproducibility(torch, seed=args.seed + trial_index)  # noqa: SLF001
        model = v6.build_font_query_head(
            torch,
            query_count=int(config["query_count"]),
            query_dim=int(config["query_dim"]),
        ).to("cuda")
        if config["warm_r2"]:
            model.load_state_dict(r2_state, strict=True)
        optimizer = torch.optim.AdamW(
            model.parameters(),
            lr=float(config["head_lr"]),
            weight_decay=args.weight_decay,
        )
        generator = torch.Generator(device="cpu").manual_seed(args.seed + trial_index)
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
                human_index = torch.randint(
                    0,
                    len(human_tokens),
                    (args.human_batch_size,),
                    generator=generator,
                )
                batch_tokens = torch.cat(
                    (synthetic_tokens[synthetic_index], human_tokens[human_index]), dim=0
                ).to("cuda", dtype=torch.float16, non_blocking=False)
                synthetic_count = len(synthetic_index)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    result = model(
                        batch_tokens,
                        reference_tokens,
                        reference_labels,
                        len(candidate_ids),
                    )
                    synthetic_loss = torch.nn.functional.cross_entropy(
                        result["candidate_scores"][:synthetic_count],
                        synthetic_labels[synthetic_index].to("cuda"),
                    )
                    human_loss = v3.tiered_deployment_loss(
                        torch,
                        result["candidate_scores"][synthetic_count:],
                        human_targets[human_index].to("cuda"),
                        human_masks[human_index].to("cuda"),
                        preferred_weight=1.0,
                        acceptable_weight=0.20,
                    )
                    consistency = v6.view_invariance_loss(
                        torch, result["view_embeddings"]
                    )
                    diversity = v6.attention_diversity_loss(torch, result["attention"])
                    loss = (
                        synthetic_loss
                        + float(config["human_weight"]) * human_loss
                        + float(config["consistency_weight"]) * consistency
                        + float(config["attention_diversity_weight"]) * diversity
                    )
                if not bool(torch.isfinite(loss)):
                    raise MangaFontV6R3Error("r3 loss became nonfinite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
                optimizer.step()
                sums["loss"] += float(loss.detach().item())
                sums["synthetic"] += float(synthetic_loss.detach().item())
                sums["human"] += float(human_loss.detach().item())
                sums["consistency"] += float(consistency.detach().item())
                sums["diversity"] += float(diversity.detach().item())
                steps += 1
            model.eval()
            with (
                torch.inference_mode(),
                torch.autocast(device_type="cuda", dtype=torch.bfloat16),
            ):
                val_result = model(
                    val_tokens,
                    reference_tokens,
                    reference_labels,
                    len(candidate_ids),
                )
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
                    "train": {
                        name: sums[name] / steps
                        for name in ("consistency", "diversity", "human", "loss", "synthetic")
                    },
                    "val": metrics,
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
            raise MangaFontV6R3Error("r3 trial produced no epoch")
        trials.append(
            {
                "best_val": trial_best,
                "config": copy.deepcopy(config),
                "history": history,
                "trial": trial_index,
            }
        )
        del model, optimizer
        torch.cuda.empty_cache()
    if (
        best_metrics is None
        or best_predictions is None
        or best_state is None
        or best_prototypes is None
    ):
        raise MangaFontV6R3Error("r3 has no best model")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        save_file(
            best_state,
            str(staging / CHECKPOINT),
            metadata={"format": SCHEMA, "kind": "frozen-siglip2-patch-query-head"},
        )
        prototype_array = np.ascontiguousarray(best_prototypes.numpy(), dtype="<f4")
        (staging / PROTOTYPES).write_bytes(prototype_array.tobytes())
        with (staging / PREDICTIONS).open("wb") as handle:
            for row in best_predictions:
                handle.write(base.json_bytes(row))
        gate = v6.research_gate(best_metrics)
        report = base.seal_record(
            {
                "architecture": {
                    "candidate_bias": False,
                    "candidate_scoring": "query-wise-cosine-to-synthetic-reference-prototypes",
                    "encoder_trainable_blocks": 0,
                    "input_representation": "last_hidden_state_patch_tokens",
                    "pooler_output_used": False,
                    "query_count": 4,
                    "query_dim": 256,
                },
                "authority": authority_binding,
                "best_epoch": best_epoch,
                "best_trial": best_trial,
                "best_val": best_metrics,
                "boundaries": {
                    "fresh64_labels_deserialized": 0,
                    "fresh64_pixels_opened": 0,
                    "human_partial_train_rows_used": 0,
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "human_train_full22_count": FULL22_ROWS,
                    "human_val_count": VAL_ROWS,
                    "library_qa_labels_deserialized": 0,
                    "library_qa_pixels_opened": 0,
                    "synthetic_test_pixels_opened": 0,
                    "test30_used_for_selection": False,
                    "val_used_for_early_stop": True,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(candidate_ids),
                "checks": {
                    "all160_authority_validated": True,
                    "fabricated_new7_negative_count": 0,
                    "old15_membership_mutation_count": 0,
                    "research_gate_passed": gate["passed"],
                    "r1_artifact_overwritten": False,
                    "r2_artifact_overwritten": False,
                },
                "deployment": {
                    "approved": False,
                    "promotion_eligible": gate["passed"],
                    "runtime_status": (
                        "research_gate_passed_not_deployed"
                        if gate["passed"]
                        else "research_gate_failed_never_stage"
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
                "quality_gate": gate,
                "record_type": "manga_font_student_v6_fontquery_r3_all160",
                "r2_warm_start_report_sha256": r2_report_sha,
                "schema_version": SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "timing_seconds": {
                    "authority_encode_and_head_sweep": time.monotonic() - started
                },
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
    v6._assert_inventory(root, FILES, "v6 r3 output")  # noqa: SLF001
    marker = base.read_json(root / MARKER, location="v6 r3 marker")
    report = base.read_json(root / REPORT, location="v6 r3 report")
    base.validate_record_seal(report, location="v6 r3 report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256") != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV6R3Error("v6 r3 metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v6 r3 artifacts")
    for name in FILES - {MARKER}:
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV6R3Error(f"v6 r3 hash drifted: {name}")
    boundaries = _mapping(report.get("boundaries"), "v6 r3 boundaries")
    required_zero = (
        "fresh64_labels_deserialized",
        "fresh64_pixels_opened",
        "human_partial_train_rows_used",
        "human_test_labels_deserialized",
        "human_test_pixels_opened",
        "library_qa_labels_deserialized",
        "library_qa_pixels_opened",
        "synthetic_test_pixels_opened",
    )
    if (
        any(int(boundaries.get(name, -1)) != 0 for name in required_zero)
        or int(boundaries.get("human_train_full22_count", 0)) != FULL22_ROWS
        or int(boundaries.get("human_val_count", 0)) != VAL_ROWS
        or boundaries.get("test30_used_for_selection") is not False
        or boundaries.get("val_used_for_early_stop") is not True
        or boundaries.get("val_used_for_optimizer") is not False
    ):
        raise MangaFontV6R3Error("v6 r3 leakage boundary drifted")
    authority_binding = _mapping(report.get("authority"), "v6 r3 authority")
    validation = _mapping(authority_binding.get("validation"), "v6 r3 validation")
    if (
        int(validation.get("upgraded_record_count", 0)) != AUTHORITY_ROWS
        or int(validation.get("new7_visual_judgment_record_count", 0)) != AUTHORITY_ROWS
        or int(validation.get("full22_train_rows_after_apply", 0)) != FULL22_ROWS
        or int(validation.get("old15_membership_mutation_count", -1)) != 0
        or int(validation.get("fabricated_new7_negative_count", -1)) != 0
        or validation.get("completed_human_visual_provenance") is not True
    ):
        raise MangaFontV6R3Error("v6 r3 authority binding drifted")
    if sum(
        bool(line.strip())
        for line in (root / PREDICTIONS).read_text(encoding="utf-8").splitlines()
    ) != VAL_ROWS:
        raise MangaFontV6R3Error("v6 r3 prediction count drifted")
    metrics = _mapping(report.get("best_val"), "v6 r3 metrics")
    expected_gate = v6.research_gate(metrics)
    if report.get("quality_gate") != expected_gate:
        raise MangaFontV6R3Error("v6 r3 quality gate drifted")
    deployment = _mapping(report.get("deployment"), "v6 r3 deployment")
    if deployment.get("approved") is not False or deployment.get("promotion_eligible") is not expected_gate["passed"]:
        raise MangaFontV6R3Error("v6 r3 deployment boundary drifted")
    return {
        "acceptable_at1": metrics.get("acceptable_at1"),
        "acceptable_hit_at3": metrics.get("acceptable_hit_at3"),
        "output_dir": str(root),
        "preferred_at1": metrics.get("preferred_at1"),
        "quality_gate_passed": expected_gate["passed"],
        "report_sha256": base.sha256_file(root / REPORT),
        "status": "sealed_research_only",
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
    train_parser.add_argument("--epochs", type=int, default=14)
    train_parser.add_argument("--patience", type=int, default=4)
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
    except (
        base.MangaFontStudentError,
        authority.LegacyNew7ReviewError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-student-v6-r3 error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
