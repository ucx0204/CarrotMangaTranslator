#!/usr/bin/env python3
"""Run a bounded cached-embedding v4 role-family expert head sweep.

This experiment reads only the sealed v3 embedding cache and its bound v2
warm-start checkpoint.  It never opens an encoder, source image, hidden test,
fresh64, or library QA record.  The v2 prototype scoring path is frozen and
kept at coefficient 1.0.  Four bias-free role-family candidate-vector experts
add a sample-dependent residual routed by the existing predicted role logits.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

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


SCHEMA = "manga-font-student-v4-role-expert-sweep-v1"
OWNER = "carrot-manga-translator/manga-font-student-v4-role-expert-sweep-v1"
MARKER = ".manga-font-student-v4-role-expert-sweep-v1-owned.json"
REPORT = "sweep-report.json"
CHECKPOINT = "best-head.safetensors"
FILES = frozenset({MARKER, REPORT, CHECKPOINT})
FAMILY_NAMES = ("ordinary", "expressive", "sfx", "sign")
TARGET_GLOBAL_PREFERRED = 0.45
TARGET_VARIANT_PREFERRED = 0.50
REFERENCE_GLOBAL_PREFERRED = 0.3939393939393939
REFERENCE_VARIANT_PREFERRED = 0.2857142857142857


class MangaFontV4SweepError(v3.MangaFontStudentV3Error):
    """Raised when the bounded role-expert experiment becomes unsafe."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV4SweepError(f"{location}: expected object")
    return value


def role_family_index(role: str) -> int:
    if role in v2.ORDINARY_ROLES:
        return FAMILY_NAMES.index("ordinary")
    if role in v2.EXPRESSIVE_ROLES:
        return FAMILY_NAMES.index("expressive")
    if role in v2.SFX_ROLES:
        return FAMILY_NAMES.index("sfx")
    if role == "sign_ui_title":
        return FAMILY_NAMES.index("sign")
    raise MangaFontV4SweepError(f"unsupported role family: {role}")


def role_family_matrix(torch: Any, *, device: Any = None) -> Any:
    matrix = torch.zeros(
        (len(base.ROLE_VALUES), len(FAMILY_NAMES)),
        dtype=torch.float32,
        device=device,
    )
    for role_index, role in enumerate(base.ROLE_VALUES):
        matrix[role_index, role_family_index(role)] = 1.0
    return matrix


def build_role_expert_ranker(
    torch: Any,
    *,
    base_ranker: Any,
    candidate_count: int,
    expert_scale: float,
    initial_candidate_proxies: Any,
    role_temperature: float,
) -> Any:
    """Wrap v3 with a frozen prototype path and bias-free family experts."""

    if candidate_count < 2 or not 0.05 <= expert_scale <= 4.0:
        raise MangaFontV4SweepError("invalid v4 expert dimensions/scale")
    if not 0.5 <= role_temperature <= 2.0:
        raise MangaFontV4SweepError("invalid v4 role temperature")
    if tuple(initial_candidate_proxies.shape) != (
        candidate_count,
        base.PROJECTION_DIM,
    ):
        raise MangaFontV4SweepError("invalid v4 prototype-query shape")

    class RoleExpertRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.base_ranker = base_ranker
            anchors = torch.nn.functional.normalize(
                initial_candidate_proxies.detach().float(), p=2, dim=-1
            )
            self.role_expert_vectors = torch.nn.Parameter(
                anchors.unsqueeze(0).repeat(len(FAMILY_NAMES), 1, 1)
            )
            self.register_buffer(
                "candidate_proxy_anchors", anchors.clone(), persistent=True
            )
            self.expert_log_scale = torch.nn.Parameter(
                torch.tensor(math.log(expert_scale))
            )
            self.register_buffer(
                "role_family_matrix",
                role_family_matrix(torch),
                persistent=True,
            )
            self.role_temperature = float(role_temperature)
            self._freeze_prototype_path()

        def _freeze_prototype_path(self) -> None:
            for module in (
                self.base_ranker.view_norm,
                self.base_ranker.view_gate,
                self.base_ranker.sample_projection,
                self.base_ranker.prototype_projection,
            ):
                module.requires_grad_(False)
                module.eval()
            self.base_ranker.logit_scale.requires_grad_(False)

        def train(self, mode: bool = True) -> Any:
            super().train(mode)
            # Frozen dropout must stay disabled so prototype scores are byte-
            # stable before and after optimization.
            for module in (
                self.base_ranker.view_norm,
                self.base_ranker.view_gate,
                self.base_ranker.sample_projection,
                self.base_ranker.prototype_projection,
            ):
                module.eval()
            return self

        def forward(
            self, views: Any, prototypes: Any, candidate_bags: Sequence[Any]
        ) -> Mapping[str, Any]:
            base_outputs = self.base_ranker(views, prototypes, candidate_bags)
            sample_unit = torch.nn.functional.normalize(
                views.float().mean(dim=1), p=2, dim=-1
            )
            family_probability = (
                torch.softmax(
                    base_outputs["role_logits"].float() / self.role_temperature,
                    dim=-1,
                )
                @ self.role_family_matrix
            )
            proxy_unit = torch.nn.functional.normalize(
                self.role_expert_vectors.float(), p=2, dim=-1
            )
            family_scores = torch.einsum("bd,fcd->bfc", sample_unit, proxy_unit)
            expert_scores = (family_scores * family_probability.unsqueeze(-1)).sum(
                dim=1
            )
            expert_scores = expert_scores - expert_scores.mean(dim=1, keepdim=True)
            expert_scores = expert_scores * self.expert_log_scale.exp().clamp(max=20.0)
            candidate_scores = base_outputs["candidate_scores"] + expert_scores
            return {
                **base_outputs,
                "candidate_scores": candidate_scores,
                "role_expert_scores": expert_scores,
                "role_family_probability": family_probability,
            }

    ranker = RoleExpertRanker()
    if any("bias" in name for name, _ in ranker.named_parameters() if "expert" in name):
        raise MangaFontV4SweepError("role experts unexpectedly gained candidate bias")
    if getattr(ranker.base_ranker.candidate_residual, "bias", None) is not None:
        raise MangaFontV4SweepError("global candidate residual unexpectedly has bias")
    return ranker


def _trial_grid(max_trials: int) -> list[dict[str, float]]:
    grid = [
        {
            "expert_scale": expert_scale,
            "full22_fraction": full22_fraction,
            "partial_row_weight": partial_weight,
            "role_temperature": 1.0,
        }
        for expert_scale in (0.5, 1.0)
        for full22_fraction in (0.75, 0.85)
        for partial_weight in (0.10, 0.25)
    ]
    if not 4 <= max_trials <= 8:
        raise MangaFontV4SweepError("v4 role-expert trials must be 4..8")
    return grid[:max_trials]


def source_ratio_indices(
    torch: Any,
    *,
    full22_mask: Any,
    batch_size: int,
    full22_fraction: float,
    generator: Any,
) -> Any:
    """Draw a deterministic with-replacement 75:25 or 85:15 source batch."""

    if full22_fraction not in {0.75, 0.85}:
        raise MangaFontV4SweepError("v4 full22 fraction must be .75 or .85")
    full = torch.where(full22_mask)[0]
    partial = torch.where(~full22_mask)[0]
    if full.numel() < 1 or partial.numel() < 1:
        raise MangaFontV4SweepError("v4 requires both full22 and partial rows")
    full_count = round(batch_size * full22_fraction)
    full_count = min(batch_size - 1, max(1, full_count))
    partial_count = batch_size - full_count
    indices = torch.cat(
        [
            full[
                torch.randint(
                    full.numel(),
                    (full_count,),
                    generator=generator,
                    device=full.device,
                )
            ],
            partial[
                torch.randint(
                    partial.numel(),
                    (partial_count,),
                    generator=generator,
                    device=partial.device,
                )
            ],
        ]
    )
    return indices[
        torch.randperm(indices.numel(), generator=generator, device=indices.device)
    ]


def target_gate(metrics: Mapping[str, Any]) -> dict[str, Any]:
    global_preferred = float(metrics["preferred_at1"])
    variant_preferred = float(metrics["variant_preferred_at1"])
    checks = {
        "global_preferred_target": global_preferred >= TARGET_GLOBAL_PREFERRED,
        "variant_preferred_target": variant_preferred >= TARGET_VARIANT_PREFERRED,
        "global_beats_109_only_head": global_preferred > REFERENCE_GLOBAL_PREFERRED,
        "variant_beats_109_only_head": variant_preferred
        > REFERENCE_VARIANT_PREFERRED,
    }
    return {
        "checks": checks,
        "passed": all(checks.values()),
        "reference_109_only": {
            "preferred_at1": REFERENCE_GLOBAL_PREFERRED,
            "variant_preferred_at1": REFERENCE_VARIANT_PREFERRED,
        },
        "targets": {
            "preferred_at1": TARGET_GLOBAL_PREFERRED,
            "variant_preferred_at1": TARGET_VARIANT_PREFERRED,
        },
    }


def _selection_key(metrics: Mapping[str, Any]) -> tuple[float, ...]:
    global_preferred = float(metrics["preferred_at1"])
    variant_preferred = float(metrics["variant_preferred_at1"])
    balanced_progress = min(
        global_preferred / TARGET_GLOBAL_PREFERRED,
        variant_preferred / TARGET_VARIANT_PREFERRED,
    )
    return (
        float(target_gate(metrics)["passed"]),
        balanced_progress,
        global_preferred + variant_preferred,
        float(metrics["variant_acceptable_at1"]),
        float(metrics["acceptable_at1"]),
        -float(metrics["tiered_gold_loss"]),
    )


def _is_better(metrics: Mapping[str, Any], best: Mapping[str, Any] | None) -> bool:
    return best is None or _selection_key(metrics) > _selection_key(best)


def _expert_regularization(torch: Any, ranker: Any) -> Any:
    vectors = torch.nn.functional.normalize(
        ranker.role_expert_vectors.float(), p=2, dim=-1
    )
    anchors = ranker.candidate_proxy_anchors.unsqueeze(0)
    # Smooth proxy anchoring limits drift from synthetic font-query evidence;
    # the low-confidence partial rows therefore cannot freely rewrite proxies.
    return (1.0 - (vectors * anchors).sum(dim=-1)).mean()


def _prototype_invariance_check(
    torch: Any,
    *,
    ranker: Any,
    views: Any,
    prototypes: Any,
    bags: Sequence[Any],
    expected: Any,
) -> None:
    ranker.eval()
    with torch.inference_mode():
        actual = ranker(views, prototypes, bags)["prototype_candidate_scores"]
    torch.testing.assert_close(actual, expected, rtol=0.0, atol=0.0)


def run(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontV4SweepError("v4 output directory already exists")
    cache, arrays = v3_sweep._load_cache_arrays(args.cache_dir)  # noqa: SLF001
    sources = _mapping(cache.get("sources"), "v4 cache sources")
    warm = v3._validate_warm_start(  # noqa: SLF001
        args.warm_start_student_dir,
        candidate_ids=tuple(str(value) for value in cache["candidate_ids"]),
    )
    if (
        sources.get("warm_start_checkpoint_sha256") != warm["checkpoint_sha256"]
        or sources.get("warm_start_contract_sha256") != warm["contract_sha256"]
    ):
        raise MangaFontV4SweepError("v4 cache/warm-start binding drifted")
    try:
        import torch
        from safetensors.torch import save_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV4SweepError("torch/safetensors are required") from error
    if not torch.cuda.is_available():
        raise MangaFontV4SweepError("v4 head sweep requires CUDA")

    candidate_ids = tuple(str(value) for value in cache["candidate_ids"])
    prototypes = torch.from_numpy(arrays["prototype_features"]).to("cuda")
    bags = v3_sweep._candidate_bags(torch, cache["prototype_bags"])  # noqa: SLF001
    initial_candidate_proxies = torch.stack(
        [prototypes[bag].mean(dim=0) for bag in bags], dim=0
    )
    syn_embeddings = torch.from_numpy(arrays["synthetic_embeddings"]).to("cuda")
    syn_labels = torch.from_numpy(arrays["synthetic_labels"]).to("cuda")
    train_embeddings = torch.from_numpy(arrays["human_train_embeddings"]).to("cuda")
    val_embeddings = torch.from_numpy(arrays["human_val_embeddings"]).to("cuda")
    train = {
        key: torch.from_numpy(arrays[f"human_train_{key}"]).to("cuda")
        for key in (
            "targets",
            "masks",
            "none",
            "none_mask",
            "full22",
            "role",
            "style",
            "style_mask",
            "treatment",
        )
    }
    val = {
        key: torch.from_numpy(arrays[f"human_val_{key}"]).to("cuda")
        for key in ("targets", "masks", "role")
    }
    baseline = _mapping(
        cache.get("quality_gate_constant_baseline"), "v4 constant baseline"
    )
    trials: list[dict[str, Any]] = []
    global_best: dict[str, Any] | None = None
    global_state: dict[str, Any] | None = None

    for trial_index, config in enumerate(_trial_grid(args.trials), 1):
        seed = args.seed + trial_index
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        base_ranker = v3_sweep._initialize_ranker(  # noqa: SLF001
            torch,
            warm_start_dir=args.warm_start_student_dir,
            candidate_count=len(candidate_ids),
            dropout=0.0,
            residual_scale=args.global_residual_scale,
        )
        ranker = build_role_expert_ranker(
            torch,
            base_ranker=base_ranker,
            candidate_count=len(candidate_ids),
            expert_scale=config["expert_scale"],
            initial_candidate_proxies=initial_candidate_proxies,
            role_temperature=config["role_temperature"],
        ).to("cuda")
        trainable = [value for value in ranker.parameters() if value.requires_grad]
        optimizer = torch.optim.AdamW(
            trainable,
            lr=args.head_lr,
            weight_decay=args.weight_decay,
            foreach=False,
        )
        ranker.eval()
        with torch.inference_mode():
            prototype_anchor = ranker(
                val_embeddings, prototypes, bags
            )["prototype_candidate_scores"].clone()
        best_metrics: dict[str, Any] | None = None
        best_state: dict[str, Any] | None = None
        best_epoch = 0
        stale = 0
        history: list[dict[str, Any]] = []
        steps = math.ceil(syn_embeddings.shape[0] / args.synthetic_batch_size)

        for epoch in range(1, args.epochs + 1):
            ranker.train(True)
            generator = torch.Generator(device="cuda")
            generator.manual_seed(seed + epoch)
            syn_order = torch.randperm(
                syn_embeddings.shape[0], generator=generator, device="cuda"
            )
            sums: Counter[str] = Counter()
            for step in range(steps):
                syn_index = syn_order[
                    step
                    * args.synthetic_batch_size : (step + 1)
                    * args.synthetic_batch_size
                ]
                human_index = source_ratio_indices(
                    torch,
                    full22_mask=train["full22"],
                    batch_size=args.human_batch_size,
                    full22_fraction=config["full22_fraction"],
                    generator=generator,
                )
                combined = torch.cat(
                    [syn_embeddings[syn_index], train_embeddings[human_index]], dim=0
                )
                optimizer.zero_grad(set_to_none=True)
                outputs = ranker(combined, prototypes, bags)
                synthetic_loss = torch.nn.functional.cross_entropy(
                    outputs["candidate_scores"][: len(syn_index)],
                    syn_labels[syn_index],
                )
                human_outputs = {
                    "candidate_scores": outputs["candidate_scores"][len(syn_index) :],
                    "none_logits": outputs["none_logits"][len(syn_index) :],
                    "role_logits": outputs["role_logits"][len(syn_index) :],
                    "style_logits": outputs["style_logits"][len(syn_index) :],
                    "treatment_logits": {
                        field: value[len(syn_index) :]
                        for field, value in outputs["treatment_logits"].items()
                    },
                }
                human_loss = v3.tiered_deployment_loss(
                    torch,
                    human_outputs["candidate_scores"],
                    train["targets"][human_index],
                    train["masks"][human_index],
                    preferred_weight=1.0,
                    acceptable_weight=0.20,
                    row_weights=torch.where(
                        train["full22"][human_index],
                        torch.ones_like(train["none"][human_index]),
                        torch.full_like(
                            train["none"][human_index],
                            config["partial_row_weight"],
                        ),
                    ),
                )
                auxiliary = v3_sweep._auxiliary_from_arrays(  # noqa: SLF001
                    torch=torch,
                    outputs=human_outputs,
                    arrays={
                        key: value[human_index]
                        for key, value in train.items()
                        if key not in {"targets", "masks", "full22"}
                    },
                )
                diversity = v3.candidate_weight_diversity_loss(
                    torch, ranker.base_ranker
                )
                expert_regularization = _expert_regularization(torch, ranker)
                loss = (
                    synthetic_loss
                    + args.human_weight * human_loss
                    + args.auxiliary_weight * auxiliary
                    + args.diversity_weight * diversity
                    + args.expert_regularization_weight * expert_regularization
                )
                if not bool(torch.isfinite(loss)):
                    raise MangaFontV4SweepError("v4 loss became non-finite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(trainable, 1.0)
                optimizer.step()
                sums["loss"] += float(loss.detach().item())
                sums["synthetic"] += float(synthetic_loss.detach().item())
                sums["human"] += float(human_loss.detach().item())

            metrics = v3_sweep._cached_val_metrics(  # noqa: SLF001
                torch=torch,
                ranker=ranker,
                embeddings=val_embeddings,
                prototypes=prototypes,
                bags=bags,
                targets=val["targets"],
                masks=val["masks"],
                roles=val["role"],
                candidate_ids=candidate_ids,
            )
            collapse_gate = v3.evaluate_quality_gate(
                metrics,
                baseline,
                minimum_preferred_gain=args.minimum_preferred_gain,
                minimum_acceptable_gain=args.minimum_acceptable_gain,
                maximum_top1_share=args.maximum_top1_share,
                minimum_unique_top1=args.minimum_unique_top1,
            )
            record = {
                "epoch": epoch,
                "quality_gate": collapse_gate,
                "target_gate": target_gate(metrics),
                "train_human_loss": sums["human"] / steps,
                "train_loss": sums["loss"] / steps,
                "train_synthetic_loss": sums["synthetic"] / steps,
                "val": metrics,
            }
            history.append(record)
            if _is_better(metrics, best_metrics):
                best_metrics = copy.deepcopy(metrics)
                best_epoch = epoch
                best_state = {
                    name: value.detach().cpu().contiguous().clone()
                    for name, value in ranker.state_dict().items()
                }
                stale = 0
            else:
                stale += 1
            if stale >= args.patience:
                break

        if best_metrics is None or best_state is None:
            raise MangaFontV4SweepError("v4 trial did not produce a checkpoint")
        ranker.load_state_dict(best_state, strict=True)
        _prototype_invariance_check(
            torch,
            ranker=ranker,
            views=val_embeddings,
            prototypes=prototypes,
            bags=bags,
            expected=prototype_anchor,
        )
        trial = {
            "best_epoch": best_epoch,
            "best_metrics": best_metrics,
            "config": config,
            "history": history,
            "prototype_score_exactly_preserved": True,
            "quality_gate": v3.evaluate_quality_gate(
                best_metrics,
                baseline,
                minimum_preferred_gain=args.minimum_preferred_gain,
                minimum_acceptable_gain=args.minimum_acceptable_gain,
                maximum_top1_share=args.maximum_top1_share,
                minimum_unique_top1=args.minimum_unique_top1,
            ),
            "seed": seed,
            "target_gate": target_gate(best_metrics),
            "trial": trial_index,
        }
        trials.append(trial)
        if global_best is None or _selection_key(best_metrics) > _selection_key(
            global_best["best_metrics"]
        ):
            global_best = copy.deepcopy(trial)
            global_state = best_state

    if global_best is None or global_state is None:
        raise MangaFontV4SweepError("v4 sweep produced no global best")
    research_gate = target_gate(global_best["best_metrics"])
    clearly_beats_reference = (
        research_gate["checks"]["global_beats_109_only_head"]
        and research_gate["checks"]["variant_beats_109_only_head"]
    )
    status = (
        "target_reached_exporter_work_required"
        if research_gate["passed"]
        else "failed_to_clearly_beat_109_only_head"
        if not clearly_beats_reference
        else "research_only_better_than_109_head_but_below_target"
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        save_file(global_state, str(staging / CHECKPOINT))
        report = base.seal_record(
            {
                "best_checkpoint": {
                    "byte_size": (staging / CHECKPOINT).stat().st_size,
                    "file": CHECKPOINT,
                    "sha256": base.sha256_file(staging / CHECKPOINT),
                },
                "boundaries": {
                    "encoder_executions": 0,
                    "fresh64_accessed": False,
                    "hidden_test_labels_deserialized": 0,
                    "hidden_test_pixels_opened": 0,
                    "library_40qa_accessed": False,
                    "optimizer_uses_human_val": False,
                    "selection_uses_human_val_only": True,
                },
                "candidate_ids": list(candidate_ids),
                "global_best_trial": global_best,
                "onnx_compatibility": {
                    "candidate_bias_added": False,
                    "exporter_change_required": True,
                    "input_output_schema_change_required": False,
                    "memo": (
                        "Reconstruct the internal four-family expert vectors and "
                        "routing buffer inside the ranker; existing views/prototypes "
                        "inputs and candidate/auxiliary outputs remain unchanged."
                    ),
                    "prototype_coefficient": 1.0,
                    "role_expert_kind": (
                        "normalized-prototype-query-proxy-with-smooth-anchor"
                    ),
                },
                "record_type": "manga_font_student_v4_role_expert_sweep",
                "reference_gate": research_gate,
                "schema_version": SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "sources": {
                    "cache_arrays_sha256": base.sha256_file(
                        args.cache_dir.expanduser().resolve() / v3_sweep.CACHE_ARRAYS
                    ),
                    "cache_contract_sha256": base.sha256_file(
                        args.cache_dir.expanduser().resolve() / v3_sweep.CACHE_CONTRACT
                    ),
                    "warm_start_checkpoint_sha256": warm["checkpoint_sha256"],
                    "warm_start_contract_sha256": warm["contract_sha256"],
                },
                "status": status,
                "trial_count": len(trials),
                "trials": trials,
            }
        )
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                CHECKPOINT: base.sha256_file(staging / CHECKPOINT),
                REPORT: base.sha256_file(staging / REPORT),
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
    base.assert_exact_root_inventory(root, FILES, location="v4 role-expert sweep")
    marker = base.read_json(root / MARKER, location="v4 marker")
    report = base.read_json(root / REPORT, location="v4 report")
    base.validate_record_seal(report, location="v4 report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV4SweepError("v4 metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v4 artifacts")
    for name in (CHECKPOINT, REPORT):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV4SweepError(f"v4 artifact hash drifted: {name}")
    boundaries = _mapping(report.get("boundaries"), "v4 boundaries")
    if (
        boundaries.get("encoder_executions") != 0
        or boundaries.get("fresh64_accessed") is not False
        or boundaries.get("hidden_test_labels_deserialized") != 0
        or boundaries.get("hidden_test_pixels_opened") != 0
        or boundaries.get("library_40qa_accessed") is not False
        or boundaries.get("optimizer_uses_human_val") is not False
        or boundaries.get("selection_uses_human_val_only") is not True
    ):
        raise MangaFontV4SweepError("v4 leakage boundary drifted")
    onnx = _mapping(report.get("onnx_compatibility"), "v4 ONNX memo")
    if (
        onnx.get("candidate_bias_added") is not False
        or onnx.get("input_output_schema_change_required") is not False
        or onnx.get("prototype_coefficient") != 1.0
    ):
        raise MangaFontV4SweepError("v4 runtime contract drifted")
    best = _mapping(report.get("global_best_trial"), "v4 global best")
    metrics = _mapping(best.get("best_metrics"), "v4 global best metrics")
    return {
        "best_preferred_at1": metrics.get("preferred_at1"),
        "best_variant_preferred_at1": metrics.get("variant_preferred_at1"),
        "output_dir": str(root),
        "status": report.get("status"),
        "target_gate_passed": _mapping(
            report.get("reference_gate"), "v4 reference gate"
        ).get("passed"),
        "trial_count": report.get("trial_count"),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    sweep = subparsers.add_parser("sweep")
    sweep.add_argument("--cache-dir", type=Path, required=True)
    sweep.add_argument("--warm-start-student-dir", type=Path, required=True)
    sweep.add_argument("--output-dir", type=Path, required=True)
    sweep.add_argument("--trials", type=int, default=8)
    sweep.add_argument("--epochs", type=int, default=20)
    sweep.add_argument("--patience", type=int, default=5)
    sweep.add_argument("--synthetic-batch-size", type=int, default=32)
    sweep.add_argument("--human-batch-size", type=int, default=32)
    sweep.add_argument("--human-weight", type=float, default=2.0)
    sweep.add_argument("--auxiliary-weight", type=float, default=0.10)
    sweep.add_argument("--diversity-weight", type=float, default=0.02)
    sweep.add_argument("--expert-regularization-weight", type=float, default=0.01)
    sweep.add_argument("--head-lr", type=float, default=0.0001)
    sweep.add_argument("--weight-decay", type=float, default=0.01)
    sweep.add_argument("--global-residual-scale", type=float, default=0.75)
    sweep.add_argument("--minimum-preferred-gain", type=float, default=0.03)
    sweep.add_argument("--minimum-acceptable-gain", type=float, default=0.02)
    sweep.add_argument("--maximum-top1-share", type=float, default=0.55)
    sweep.add_argument("--minimum-unique-top1", type=int, default=4)
    sweep.add_argument("--seed", type=int, default=20260820)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def _validate_args(args: argparse.Namespace) -> None:
    values = (
        args.human_weight,
        args.auxiliary_weight,
        args.diversity_weight,
        args.expert_regularization_weight,
        args.head_lr,
        args.weight_decay,
        args.global_residual_scale,
        args.minimum_preferred_gain,
        args.minimum_acceptable_gain,
        args.maximum_top1_share,
    )
    if (
        not 4 <= args.trials <= 8
        or args.epochs < 1
        or args.patience < 1
        or args.synthetic_batch_size < 4
        or args.human_batch_size < 4
        or args.human_weight <= 0.0
        or args.auxiliary_weight < 0.0
        or args.diversity_weight < 0.0
        or args.expert_regularization_weight < 0.0
        or args.head_lr <= 0.0
        or args.weight_decay < 0.0
        or not 0.05 <= args.global_residual_scale <= 4.0
        or not 0.0 <= args.minimum_preferred_gain <= 0.5
        or not 0.0 <= args.minimum_acceptable_gain <= 0.5
        or not 0.2 <= args.maximum_top1_share <= 1.0
        or not 2 <= args.minimum_unique_top1 <= base.CANDIDATE_COUNT
        or not all(math.isfinite(value) for value in values)
    ):
        raise MangaFontV4SweepError("invalid v4 sweep configuration")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "sweep":
            _validate_args(args)
            result = run(args)
        else:
            result = validate(args.output_dir)
    except (MangaFontV4SweepError, base.MangaFontStudentError, OSError) as error:
        raise SystemExit(f"manga-font-v4-role-expert error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
