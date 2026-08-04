#!/usr/bin/env python3
"""Train MangaFont-22 v3 with deployment-aligned human supervision.

V1 and v2 are intentionally left untouched.  V3 warm-starts from a sealed v2
student but replaces prototype-only deployment scoring with the sum of:

* the existing three-view prototype-bag score; and
* a bias-free candidate embedding score conditioned on sample, role, and style.

Human font supervision is applied only to that deployed combined score.  The
legacy per-view ``font_head`` remains a low-weight synthetic auxiliary so an
otherwise compatible checkpoint can still be diagnosed, but it receives no
human loss.  A train-only named overlay and the adjudicated val-only overlay
are mandatory and are checked for identity overlap before any model is built.
Hidden-test rows are never JSON-deserialized or opened.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
import random
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import build_manga_font_legacy15_train_overlay_v1 as legacy15_overlay
    from scripts import build_manga_font_named_train_review_v1 as train_overlay
    from scripts import build_manga_font_student_human_overlay_v1 as val_overlay
    from scripts import finalize_manga_font_named_train_secondary_overlay_v1 as secondary_overlay
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v2 as v2
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_legacy15_train_overlay_v1 as legacy15_overlay
    import build_manga_font_named_train_review_v1 as train_overlay
    import build_manga_font_student_human_overlay_v1 as val_overlay
    import finalize_manga_font_named_train_secondary_overlay_v1 as secondary_overlay
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v2 as v2


EXTENSION_SCHEMA = "manga-font-student-training-extension-v3"
SCORER_SCHEMA = "role-style-conditioned-candidate-residual-v1"
WARM_START_SCHEMA = v2.EXTENSION_SCHEMA
PREFERRED_CODE = v2.PREFERRED_CODE
ACCEPTABLE_CODE = v2.ACCEPTABLE_CODE
DEFAULT_RESIDUAL_SCALE = 0.75
QUALITY_GATE_SCHEMA = "manga-font-student-v3-quality-gate-v1"


class MangaFontStudentV3Error(base.MangaFontStudentError):
    """Raised when v3 inputs, training, or deployment gates drift."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontStudentV3Error(f"{location}: expected object")
    return value


def _finite(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MangaFontStudentV3Error(f"{location}: expected finite number")
    result = float(value)
    if not math.isfinite(result):
        raise MangaFontStudentV3Error(f"{location}: expected finite number")
    return result


def build_runtime_ranker_v3(
    torch: Any,
    *,
    candidate_count: int,
    dropout: float,
    residual_scale: float,
) -> Any:
    """Build the exportable v3 ranker without touching the v1 implementation."""

    if candidate_count < 2 or not 0.0 <= dropout < 0.5:
        raise MangaFontStudentV3Error("invalid v3 ranker dimensions/dropout")
    if not 0.05 <= residual_scale <= 4.0 or not math.isfinite(residual_scale):
        raise MangaFontStudentV3Error("invalid v3 residual scale")

    semantic_dim = base.PROJECTION_DIM + len(base.ROLE_VALUES) + len(
        base.STYLE_FIELDS
    )

    class RuntimeSemanticResidualRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            # These names and shapes intentionally match v2 for warm-start.
            self.view_norm = torch.nn.LayerNorm(base.PROJECTION_DIM)
            self.view_gate = torch.nn.Linear(base.PROJECTION_DIM, 1)
            self.sample_projection = torch.nn.Sequential(
                torch.nn.Linear(base.PROJECTION_DIM * 4, base.PROJECTION_DIM),
                torch.nn.GELU(),
                torch.nn.Dropout(0.10),
                torch.nn.LayerNorm(base.PROJECTION_DIM),
            )
            self.prototype_projection = torch.nn.Sequential(
                torch.nn.LayerNorm(base.PROJECTION_DIM),
                torch.nn.Linear(
                    base.PROJECTION_DIM, base.PROJECTION_DIM, bias=False
                ),
            )
            self.logit_scale = torch.nn.Parameter(torch.tensor(0.0))
            self.none_head = torch.nn.Linear(base.PROJECTION_DIM, 1)
            self.role_head = torch.nn.Linear(
                base.PROJECTION_DIM, len(base.ROLE_VALUES)
            )
            self.style_head = torch.nn.Linear(
                base.PROJECTION_DIM, len(base.STYLE_FIELDS)
            )
            self.treatment_heads = torch.nn.ModuleDict(
                {
                    field: torch.nn.Linear(base.PROJECTION_DIM, len(values))
                    for field, values in base.TREATMENT_VALUES.items()
                }
            )

            # New deployment branch.  There is deliberately no per-candidate
            # bias: frequency cannot win by learning a constant intercept.
            self.semantic_projection = torch.nn.Sequential(
                torch.nn.LayerNorm(semantic_dim),
                torch.nn.Linear(semantic_dim, base.PROJECTION_DIM),
                torch.nn.GELU(),
                torch.nn.Dropout(dropout),
                torch.nn.Linear(
                    base.PROJECTION_DIM, base.PROJECTION_DIM, bias=False
                ),
            )
            self.semantic_mix_logit = torch.nn.Parameter(
                torch.tensor(math.log(0.25 / 0.75))
            )
            self.candidate_residual = torch.nn.Linear(
                base.PROJECTION_DIM, candidate_count, bias=False
            )
            self.residual_log_scale = torch.nn.Parameter(
                torch.tensor(math.log(residual_scale))
            )

        def forward(
            self, views: Any, prototypes: Any, candidate_bags: Sequence[Any]
        ) -> Mapping[str, Any]:
            if views.ndim != 3 or tuple(views.shape[1:]) != (
                len(base.VIEW_NAMES),
                base.PROJECTION_DIM,
            ):
                raise MangaFontStudentV3Error("v3 runtime view shape drifted")
            if prototypes.ndim != 2 or prototypes.shape[1] != base.PROJECTION_DIM:
                raise MangaFontStudentV3Error("v3 prototype shape drifted")
            if len(candidate_bags) != candidate_count or any(
                int(bag.numel()) < 1 for bag in candidate_bags
            ):
                raise MangaFontStudentV3Error("v3 candidate bags are incomplete")

            normalized_views = self.view_norm(views.float())
            gate_logits = self.view_gate(normalized_views).squeeze(-1)
            gate_weights = torch.softmax(gate_logits, dim=1)
            gated = (normalized_views * gate_weights.unsqueeze(-1)).sum(dim=1)
            concatenated = normalized_views.reshape(views.shape[0], -1)
            sample_hidden = self.sample_projection(
                torch.cat([gated, concatenated], dim=-1)
            )

            prototype_hidden = self.prototype_projection(prototypes.float())
            sample_unit = torch.nn.functional.normalize(
                sample_hidden, p=2, dim=-1
            )
            prototype_unit = torch.nn.functional.normalize(
                prototype_hidden, p=2, dim=-1
            )
            prototype_scores = (
                sample_unit @ prototype_unit.transpose(0, 1)
            ) * self.logit_scale.exp().clamp(max=100.0)
            prototype_candidate_scores = torch.stack(
                [
                    torch.logsumexp(prototype_scores[:, bag], dim=1)
                    - math.log(int(bag.numel()))
                    for bag in candidate_bags
                ],
                dim=1,
            )

            role_logits = self.role_head(sample_hidden)
            style_logits = self.style_head(sample_hidden)
            semantic_delta = self.semantic_projection(
                torch.cat(
                    [
                        sample_hidden,
                        torch.softmax(role_logits.float(), dim=-1),
                        torch.sigmoid(style_logits.float()),
                    ],
                    dim=-1,
                )
            )
            semantic_hidden = sample_hidden + (
                torch.sigmoid(self.semantic_mix_logit) * semantic_delta
            )
            semantic_unit = torch.nn.functional.normalize(
                semantic_hidden.float(), p=2, dim=-1
            )
            candidate_unit = torch.nn.functional.normalize(
                self.candidate_residual.weight.float(), p=2, dim=-1
            )
            residual_scores = semantic_unit @ candidate_unit.transpose(0, 1)
            residual_scores = residual_scores - residual_scores.mean(
                dim=1, keepdim=True
            )
            residual_scores = residual_scores * self.residual_log_scale.exp().clamp(
                max=20.0
            )
            candidate_scores = prototype_candidate_scores + residual_scores
            return {
                "candidate_scores": candidate_scores,
                "none_logits": self.none_head(sample_hidden).squeeze(-1),
                "role_logits": role_logits,
                "style_logits": style_logits,
                "treatment_logits": {
                    field: head(sample_hidden)
                    for field, head in self.treatment_heads.items()
                },
                "view_gate_weights": gate_weights,
                # Training diagnostics only.  The ONNX wrapper keeps the exact
                # v1 output tuple, so the TypeScript runtime needs no new input
                # or output and consumes the combined score transparently.
                "prototype_candidate_scores": prototype_candidate_scores,
                "candidate_residual_scores": residual_scores,
            }

    return RuntimeSemanticResidualRanker()


def build_student_model_v3(
    torch: Any,
    *,
    vision_encoder: Any,
    candidate_count: int,
    dropout: float = 0.10,
    residual_scale: float = DEFAULT_RESIDUAL_SCALE,
) -> tuple[Any, tuple[int, ...]]:
    """Build a v3 student while preserving v2-compatible parameter names."""

    trainable_blocks = base.configure_last_vision_blocks(
        vision_encoder, block_count=base.TRAINABLE_VISION_BLOCKS
    )
    hidden_size = int(getattr(vision_encoder.config, "hidden_size", 0))
    if hidden_size < 1:
        raise MangaFontStudentV3Error("SigLIP2 hidden size is invalid")

    ranker = build_runtime_ranker_v3(
        torch,
        candidate_count=candidate_count,
        dropout=dropout,
        residual_scale=residual_scale,
    )

    class MangaFontStudentV3(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.vision_encoder = vision_encoder
            self.projection = torch.nn.Sequential(
                torch.nn.Linear(hidden_size, base.PROJECTION_DIM),
                torch.nn.GELU(),
                torch.nn.LayerNorm(base.PROJECTION_DIM),
            )
            self.font_head = torch.nn.Linear(base.PROJECTION_DIM, candidate_count)
            self.runtime_ranker = ranker
            self._trainable_block_indices = trainable_blocks

        def train(self, mode: bool = True) -> Any:
            super().train(mode)
            self.vision_encoder.eval()
            if mode:
                layers = self.vision_encoder.vision_model.encoder.layers
                for index in self._trainable_block_indices:
                    layers[index].train(True)
                self.projection.train(True)
                self.font_head.train(True)
                self.runtime_ranker.train(True)
            return self

        def forward(self, pixel_values: Any) -> tuple[Any, Any]:
            output = self.vision_encoder(pixel_values=pixel_values)
            projected = self.projection(output.pooler_output)
            embedding = torch.nn.functional.normalize(
                projected.float(), p=2, dim=-1
            )
            return embedding, self.font_head(embedding)

        def runtime_forward(
            self, views: Any, prototypes: Any, candidate_bags: Sequence[Any]
        ) -> Mapping[str, Any]:
            return self.runtime_ranker(views, prototypes, candidate_bags)

    student = MangaFontStudentV3()
    if any(
        parameter.requires_grad
        for index, layer in enumerate(
            vision_encoder.vision_model.encoder.layers
        )
        if index not in trainable_blocks
        for parameter in layer.parameters()
    ):
        raise MangaFontStudentV3Error("a frozen SigLIP2 block remains trainable")
    return student, trainable_blocks


def tiered_deployment_loss(
    torch: Any,
    logits: Any,
    targets: Any,
    masks: Any,
    *,
    preferred_weight: float,
    acceptable_weight: float,
    row_weights: Any | None = None,
) -> Any:
    """Set-NLL on the exact score exported as ``candidate_scores``."""

    if logits.shape != targets.shape or masks.shape != logits.shape:
        raise MangaFontStudentV3Error("v3 tiered loss tensor shape drifted")
    preferred = targets == PREFERRED_CODE
    acceptable = targets >= ACCEPTABLE_CODE
    active = preferred.any(dim=-1)
    if not bool(active.any()):
        return logits.sum() * 0.0
    eligible_logits = logits.float().masked_fill(~masks, -torch.inf)
    denominator = torch.logsumexp(eligible_logits, dim=-1)

    def set_nll(set_mask: Any) -> Any:
        numerator = torch.logsumexp(
            eligible_logits.masked_fill(~set_mask, -torch.inf), dim=-1
        )
        return denominator - numerator

    losses = preferred_weight * set_nll(preferred)
    total_weight = preferred_weight
    if acceptable_weight > 0.0:
        losses = losses + acceptable_weight * set_nll(acceptable)
        total_weight += acceptable_weight
    losses = losses[active] / total_weight
    if row_weights is not None:
        if row_weights.ndim != 1 or row_weights.shape[0] != logits.shape[0]:
            raise MangaFontStudentV3Error("v3 row-weight shape drifted")
        weights = row_weights[active].float()
        return (losses * weights).sum() / weights.sum().clamp(min=1e-6)
    return losses.mean()


def candidate_supervision_scope(
    example: base.HumanExample, candidate_ids: tuple[str, ...]
) -> dict[str, Any]:
    """Validate and describe complete or candidate-partial human supervision.

    Legacy-15 finals may supervise only the candidates that were actually
    shown to the reviewers.  Their seven successor candidates are represented
    by ``font_judgment.not_reviewed`` and must be absent from the listwise
    denominator.  This helper deliberately reads only an already-authorized
    train/val ``HumanExample``; hidden-test rows never reach it.
    """

    judgment = _mapping(
        example.row.get("font_judgment"),
        f"{example.sample_id}.font_judgment",
    )

    def tier(name: str) -> tuple[str, ...]:
        raw = judgment.get(name, ())
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
            raise MangaFontStudentV3Error(
                f"{example.sample_id}: invalid font_judgment.{name}"
            )
        values = tuple(str(value) for value in raw)
        if len(values) != len(set(values)):
            raise MangaFontStudentV3Error(
                f"{example.sample_id}: duplicate font in {name}"
            )
        return values

    preferred = tier("preferred")
    acceptable = tier("acceptable")
    unrenderable = tier("unrenderable")
    not_reviewed = tier("not_reviewed")
    candidate_set = set(candidate_ids)
    for name, values in (
        ("preferred", preferred),
        ("acceptable", acceptable),
        ("unrenderable", unrenderable),
        ("not_reviewed", not_reviewed),
    ):
        unknown = set(values) - candidate_set
        if unknown:
            raise MangaFontStudentV3Error(
                f"{example.sample_id}: {name} escaped candidate vocabulary"
            )
    if set(preferred) & set(acceptable):
        raise MangaFontStudentV3Error(
            f"{example.sample_id}: preferred/acceptable tiers overlap"
        )
    if (set(preferred) | set(acceptable)) & (
        set(unrenderable) | set(not_reviewed)
    ):
        raise MangaFontStudentV3Error(
            f"{example.sample_id}: positive font is unsupervised or unrenderable"
        )
    candidate_index = {value: index for index, value in enumerate(candidate_ids)}
    expected_eligible = {
        candidate_index[value]
        for value in candidate_ids
        if value not in set(unrenderable) | set(not_reviewed)
    }
    actual_eligible = set(example.eligible_indices)
    if actual_eligible != expected_eligible:
        raise MangaFontStudentV3Error(
            f"{example.sample_id}: candidate loss mask differs from reviewed scope"
        )
    if not actual_eligible:
        raise MangaFontStudentV3Error(
            f"{example.sample_id}: no reviewed renderable candidate remains"
        )
    expected_positive = {
        candidate_index[value] for value in (*preferred, *acceptable)
    }
    if set(example.positive_indices) != expected_positive:
        raise MangaFontStudentV3Error(
            f"{example.sample_id}: positive indices differ from reviewed tiers"
        )
    return {
        "none_auxiliary_supervised": not not_reviewed,
        "not_reviewed_candidate_ids": list(not_reviewed),
        "partial_candidate_supervision": bool(not_reviewed),
        "reviewed_candidate_count": len(candidate_ids) - len(not_reviewed),
    }


def validate_candidate_supervision_scopes(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> dict[str, Any]:
    """Fail closed on partial-label mask drift and summarize train authority."""

    scopes = [candidate_supervision_scope(example, candidate_ids) for example in examples]
    partial = [scope for scope in scopes if scope["partial_candidate_supervision"]]
    signatures = {
        tuple(scope["not_reviewed_candidate_ids"])
        for scope in partial
    }
    if len(signatures) > 1:
        raise MangaFontStudentV3Error(
            "partial human rows disagree on the not-reviewed candidate vocabulary"
        )
    return {
        "fully_reviewed_22_row_count": len(scopes) - len(partial),
        "none_auxiliary_masked_row_count": len(partial),
        "not_reviewed_candidate_ids": list(next(iter(signatures), ())),
        "partial_candidate_row_count": len(partial),
        "partial_rows_called_full22": False,
    }


def rebalance_epoch_human_batches(
    batches: Sequence[base.EpochBatch],
    examples: Sequence[base.HumanExample],
    candidate_ids: tuple[str, ...],
    *,
    partial_fraction: float,
    seed: int,
) -> tuple[base.EpochBatch, ...]:
    """Deterministically prevent legacy-partial rows from swamping full22 gold."""

    if not 0.25 <= partial_fraction <= 0.75:
        raise MangaFontStudentV3Error("partial human batch fraction must be .25..75")
    partial_indices = [
        index
        for index, example in enumerate(examples)
        if candidate_supervision_scope(example, candidate_ids)[
            "partial_candidate_supervision"
        ]
    ]
    partial_set = set(partial_indices)
    full_indices = [
        index for index in range(len(examples)) if index not in partial_set
    ]
    if not partial_indices:
        return tuple(batches)
    if not full_indices:
        raise MangaFontStudentV3Error(
            "partial human supervision requires a full22 anchor pool"
        )
    rng = random.Random(seed)

    def cycle(pool: Sequence[int]) -> Any:
        while True:
            order = list(pool)
            rng.shuffle(order)
            yield from order

    partial_stream = cycle(partial_indices)
    full_stream = cycle(full_indices)
    output: list[base.EpochBatch] = []
    for batch in batches:
        count = len(batch.human_indices)
        partial_count = min(count - 1, max(1, round(count * partial_fraction)))
        full_count = count - partial_count
        indices = [next(partial_stream) for _ in range(partial_count)]
        indices.extend(next(full_stream) for _ in range(full_count))
        rng.shuffle(indices)
        output.append(base.EpochBatch(batch.synthetic_indices, tuple(indices)))
    return tuple(output)


def human_none_supervision_mask(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> tuple[bool, ...]:
    """Return false for rows whose candidate vocabulary was only partly reviewed."""

    return tuple(
        bool(candidate_supervision_scope(example, candidate_ids)["none_auxiliary_supervised"])
        for example in examples
    )


def masked_human_auxiliary_loss(
    *,
    torch: Any,
    outputs: Mapping[str, Any],
    none_targets: Any,
    none_masks: Any,
    role_targets: Any,
    style_targets: Any,
    style_masks: Any,
    treatment_targets: Any,
) -> tuple[Any, Mapping[str, Any]]:
    """Human auxiliary loss with candidate-partial ``none`` supervision masked.

    Role, style, and treatment labels remain valid for a legacy-15 final.  The
    ``none_acceptable`` bit does not: it only means none of the *reviewed 15*
    worked, so it cannot supervise the all-22 none head.
    """

    if none_masks.ndim != 1 or none_masks.shape != none_targets.shape:
        raise MangaFontStudentV3Error("human none supervision mask shape drifted")
    active_none = none_masks.bool()
    if bool(active_none.any()):
        none_loss = torch.nn.functional.binary_cross_entropy_with_logits(
            outputs["none_logits"][active_none].float(),
            none_targets[active_none],
        )
    else:
        none_loss = outputs["none_logits"].sum() * 0.0
    role_loss = torch.nn.functional.cross_entropy(
        outputs["role_logits"].float(), role_targets
    )
    raw_style = torch.nn.functional.smooth_l1_loss(
        torch.sigmoid(outputs["style_logits"].float()),
        style_targets,
        reduction="none",
    )
    style_loss = (raw_style * style_masks).sum() / style_masks.sum().clamp(min=1)
    treatment_parts = [
        torch.nn.functional.cross_entropy(
            outputs["treatment_logits"][field].float(),
            treatment_targets[:, field_index],
        )
        for field_index, field in enumerate(base.TREATMENT_VALUES)
    ]
    treatment_loss = torch.stack(treatment_parts).mean()
    components = [role_loss, style_loss, treatment_loss]
    if bool(active_none.any()):
        components.insert(0, none_loss)
    total = torch.stack(components).mean()
    return total, {
        "none": none_loss,
        "none_supervised_rows": int(active_none.sum().item()),
        "role": role_loss,
        "style": style_loss,
        "treatment": treatment_loss,
    }


def candidate_weight_diversity_loss(torch: Any, ranker: Any) -> Any:
    """Discourage all candidate residual vectors from collapsing together."""

    weights = torch.nn.functional.normalize(
        ranker.candidate_residual.weight.float(), p=2, dim=-1
    )
    gram = weights @ weights.transpose(0, 1)
    identity = torch.eye(gram.shape[0], dtype=gram.dtype, device=gram.device)
    return ((gram - identity) ** 2).sum() / (
        gram.shape[0] * max(1, gram.shape[0] - 1)
    )


def human_frequency_row_weights(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> tuple[float, ...]:
    """Bounded inverse-sqrt weights based only on train preferred labels."""

    index = {candidate_id: offset for offset, candidate_id in enumerate(candidate_ids)}
    counts = [0.0] * len(candidate_ids)
    row_candidates: list[tuple[int, ...]] = []
    for example in examples:
        preferred, acceptable = v2._tier_ids(example)  # noqa: SLF001
        chosen = preferred or acceptable
        offsets = tuple(index[value] for value in chosen)
        row_candidates.append(offsets)
        if offsets:
            share = 1.0 / len(offsets)
            for offset in offsets:
                counts[offset] += share
    raw = []
    for offsets in row_candidates:
        if not offsets:
            raw.append(1.0)
            continue
        value = sum(1.0 / math.sqrt(counts[offset] + 1.0) for offset in offsets)
        raw.append(value / len(offsets))
    mean = sum(raw) / len(raw) if raw else 1.0
    return tuple(min(2.0, max(0.5, value / mean)) for value in raw)


def variant_aware_human_row_weights(
    examples: Sequence[base.HumanExample],
    candidate_ids: tuple[str, ...],
    *,
    variant_weight: float,
    full22_weight: float = 1.0,
) -> tuple[float, ...]:
    """Combine frequency balancing with explicit train-only variant emphasis."""

    if not 1.0 <= variant_weight <= 4.0 or not math.isfinite(variant_weight):
        raise MangaFontStudentV3Error("variant human weight must be 1..4")
    if not 1.0 <= full22_weight <= 3.0 or not math.isfinite(full22_weight):
        raise MangaFontStudentV3Error("full22 human weight must be 1..3")
    frequency = human_frequency_row_weights(examples, candidate_ids)
    raw = [
        value
        * (
            variant_weight
            if base.ROLE_VALUES[example.role_index] not in v2.ORDINARY_ROLES
            else 1.0
        )
        * (
            full22_weight
            if not candidate_supervision_scope(example, candidate_ids)[
                "partial_candidate_supervision"
            ]
            else 1.0
        )
        for value, example in zip(frequency, examples, strict=True)
    ]
    mean = sum(raw) / len(raw) if raw else 1.0
    return tuple(min(3.0, max(0.35, value / mean)) for value in raw)


def constant_candidate_baseline(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> dict[str, Any]:
    """Best constant-font baselines computed from val labels, never pixels."""

    candidate_index = {value: index for index, value in enumerate(candidate_ids)}
    positive_rows: list[tuple[set[int], set[int], bool]] = []
    ordinary = v2.ORDINARY_ROLES
    for example in examples:
        preferred_ids, acceptable_only = v2._tier_ids(example)  # noqa: SLF001
        preferred_ids = preferred_ids or acceptable_only
        preferred = {candidate_index[value] for value in preferred_ids}
        acceptable = preferred | {
            candidate_index[value] for value in acceptable_only
        }
        if acceptable:
            role = base.ROLE_VALUES[example.role_index]
            positive_rows.append((preferred, acceptable, role not in ordinary))
    if not positive_rows:
        raise MangaFontStudentV3Error("val has no positive font rows")

    def best(kind: int, *, variant: bool) -> dict[str, Any]:
        rows = [row for row in positive_rows if row[2]] if variant else positive_rows
        if not rows:
            raise MangaFontStudentV3Error("val has no positive variant rows")
        hits = [sum(offset in row[kind] for row in rows) for offset in range(len(candidate_ids))]
        best_hits = max(hits)
        best_index = hits.index(best_hits)
        return {
            "candidate_id": candidate_ids[best_index],
            "rate": best_hits / len(rows),
            "row_count": len(rows),
        }

    return {
        "acceptable_at1": best(1, variant=False),
        "preferred_at1": best(0, variant=False),
        "variant_acceptable_at1": best(1, variant=True),
        "variant_preferred_at1": best(0, variant=True),
    }


def evaluate_quality_gate(
    metrics: Mapping[str, Any],
    baseline: Mapping[str, Any],
    *,
    minimum_preferred_gain: float,
    minimum_acceptable_gain: float,
    maximum_top1_share: float,
    minimum_unique_top1: int,
) -> dict[str, Any]:
    """Fail closed when v3 merely reproduces a constant-font strategy."""

    checks = {
        "acceptable_beats_constant": _finite(
            metrics.get("acceptable_at1"), "metrics.acceptable_at1"
        )
        >= _finite(
            _mapping(baseline["acceptable_at1"], "baseline acceptable").get(
                "rate"
            ),
            "baseline.acceptable_at1.rate",
        )
        + minimum_acceptable_gain,
        "preferred_beats_constant": _finite(
            metrics.get("preferred_at1"), "metrics.preferred_at1"
        )
        >= _finite(
            _mapping(baseline["preferred_at1"], "baseline preferred").get(
                "rate"
            ),
            "baseline.preferred_at1.rate",
        )
        + minimum_preferred_gain,
        "variant_preferred_beats_constant": _finite(
            metrics.get("variant_preferred_at1"),
            "metrics.variant_preferred_at1",
        )
        >= _finite(
            _mapping(
                baseline["variant_preferred_at1"], "baseline variant preferred"
            ).get("rate"),
            "baseline.variant_preferred_at1.rate",
        )
        + minimum_preferred_gain,
        "top1_distribution_not_collapsed": (
            int(metrics.get("top1_unique_candidate_count", 0))
            >= minimum_unique_top1
            and _finite(
                metrics.get("top1_max_candidate_share"),
                "metrics.top1_max_candidate_share",
            )
            <= maximum_top1_share
        ),
    }
    return {
        "checks": checks,
        "passed": all(checks.values()),
        "policy": {
            "maximum_top1_share": maximum_top1_share,
            "minimum_acceptable_gain_over_constant": minimum_acceptable_gain,
            "minimum_preferred_gain_over_constant": minimum_preferred_gain,
            "minimum_unique_top1": minimum_unique_top1,
            "schema_version": QUALITY_GATE_SCHEMA,
        },
    }


def _load_inputs(args: argparse.Namespace) -> tuple[Any, Any, Any, dict[str, Any]]:
    registry_path = args.catalog_registry.expanduser().resolve()
    registry = base.read_json(registry_path, location="catalog registry")
    registry_sha = base.sha256_file(registry_path)
    synthetic = base.validate_synthetic_input(
        args.synthetic_dir, catalog_registry_sha256=registry_sha
    )
    base.validate_human_input(
        args.human_export_dir,
        candidate_ids=synthetic.candidate_ids,
        catalog_registry_sha256=registry_sha,
    )
    human, val_validation = val_overlay.apply_overlay(
        overlay_dir=args.human_val_overlay_dir,
        base_export_dir=args.human_export_dir,
        finals_dir=args.human_val_finals_dir,
        catalog_registry=registry_path,
        candidate_ids=synthetic.candidate_ids,
    )
    human, train_validation = secondary_overlay.apply_secondary_overlay(
        human,
        base_overlay_dir=args.human_train_overlay_dir,
        secondary_overlay_dir=args.human_train_secondary_overlay_dir,
        corrections_path=args.human_train_secondary_corrections,
        catalog_registry=registry_path,
        candidate_ids=synthetic.candidate_ids,
    )
    legacy_validation: Mapping[str, Any] = {
        "partial_candidate_row_count": 0,
        "status": "legacy15_train_overlay_not_requested",
    }
    if args.human_train_legacy15_overlay_dir is not None:
        human, legacy_validation = legacy15_overlay.apply_legacy15_train_overlay(
            human,
            overlay_dir=args.human_train_legacy15_overlay_dir,
            candidate_ids=synthetic.candidate_ids,
            catalog_registry_sha256=registry_sha,
        )
    train_ids = {example.sample_id for example in human.train_examples}
    val_ids = {example.sample_id for example in human.val_examples}
    if train_ids & val_ids:
        raise MangaFontStudentV3Error("train and val identities overlap after overlays")
    if human.skipped_test_rows < 1:
        raise MangaFontStudentV3Error("hidden-test skip audit is missing")
    train_scope = validate_candidate_supervision_scopes(
        human.train_examples, synthetic.candidate_ids
    )
    val_scope = validate_candidate_supervision_scopes(
        human.val_examples, synthetic.candidate_ids
    )
    if val_scope["partial_candidate_row_count"] != 0:
        raise MangaFontStudentV3Error(
            "validation rows must retain complete 22-candidate supervision"
        )
    if args.human_train_legacy15_overlay_dir is not None and (
        train_scope["partial_candidate_row_count"] < 1
        or train_scope["partial_candidate_row_count"]
        != int(legacy_validation.get("partial_candidate_row_count", -1))
    ):
        raise MangaFontStudentV3Error(
            "legacy15 overlay count differs from effective candidate masks"
        )
    bindings = {
        "human_train_candidate_supervision": train_scope,
        "human_train_legacy15_overlay": dict(legacy_validation),
        "human_train_overlay": dict(train_validation),
        "human_val_overlay": dict(val_validation),
        "human_val_candidate_supervision": val_scope,
    }
    return registry, synthetic, human, bindings


def _validate_warm_start(
    path: Path, *, candidate_ids: tuple[str, ...]
) -> dict[str, Any]:
    root = path.expanduser().resolve()
    # Validate the immutable v2 artifact with its own sealed contract instead
    # of retroactively imposing inputs (such as the later named-train overlay)
    # that did not exist when that warm start was trained.
    result = dict(base.validate_output(root))
    contract = base.read_json(root / base.CONTRACT_FILE, location="v2 warm start")
    vocabulary = _mapping(contract.get("vocabulary"), "v2 warm vocabulary")
    if tuple(vocabulary.get("candidate_ids", ())) != candidate_ids:
        raise MangaFontStudentV3Error("v2 warm-start candidate order drifted")
    extension = _mapping(contract.get("trainer_extension"), "v2 warm extension")
    val_binding = _mapping(
        extension.get("human_val_overlay"), "v2 warm val overlay"
    )
    if (
        extension.get("schema_version") != WARM_START_SCHEMA
        or val_binding.get("status") != "ready_for_val_only_merge"
        or int(val_binding.get("val_record_count", 0)) < 1
    ):
        raise MangaFontStudentV3Error("warm start is not a sealed v2 student")
    return {
        **result,
        "checkpoint_sha256": base.sha256_file(root / base.CHECKPOINT_FILE),
        "contract_sha256": base.sha256_file(root / base.CONTRACT_FILE),
        "output_dir": str(root),
        "schema_version": WARM_START_SCHEMA,
    }


def _apply_warm_start(torch: Any, student: Any, warm_start_dir: Path) -> dict[str, Any]:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover - dependency setup
        raise MangaFontStudentV3Error("safetensors is required for warm start") from error
    state = dict(
        load_file(
            str(warm_start_dir.expanduser().resolve() / base.CHECKPOINT_FILE),
            device="cpu",
        )
    )
    parameters = dict(student.named_parameters())
    copied: list[str] = []
    unexpected: list[str] = []
    with torch.no_grad():
        for name, value in state.items():
            parameter = parameters.get(name)
            if parameter is None or tuple(parameter.shape) != tuple(value.shape):
                unexpected.append(name)
                continue
            parameter.copy_(value.to(device=parameter.device, dtype=parameter.dtype))
            copied.append(name)
        # Start the deployed residual from the already-trained direct v2 font
        # vectors, but intentionally drop its class bias.  The semantic delta
        # starts at zero, so the initial residual is a stable sample-hidden
        # classifier before role/style conditioning is learned.
        student.runtime_ranker.candidate_residual.weight.copy_(
            state["font_head.weight"].to(
                device=student.runtime_ranker.candidate_residual.weight.device,
                dtype=student.runtime_ranker.candidate_residual.weight.dtype,
            )
        )
        student.runtime_ranker.semantic_projection[-1].weight.zero_()
    required_prefixes = (
        "vision_encoder.",
        "projection.",
        "font_head.",
        "runtime_ranker.sample_projection.",
        "runtime_ranker.prototype_projection.",
        "runtime_ranker.role_head.",
        "runtime_ranker.style_head.",
    )
    if unexpected or any(
        not any(name.startswith(prefix) for name in copied)
        for prefix in required_prefixes
    ):
        raise MangaFontStudentV3Error("v2 warm-start parameter contract drifted")
    new_names = sorted(
        name
        for name, parameter in parameters.items()
        if parameter.requires_grad and name not in copied
    )
    expected_new = (
        "runtime_ranker.semantic_projection.",
        "runtime_ranker.semantic_mix_logit",
        "runtime_ranker.candidate_residual.",
        "runtime_ranker.residual_log_scale",
    )
    if any(not name.startswith(expected_new) for name in new_names):
        raise MangaFontStudentV3Error("v3 has an unaccounted warm-start parameter")
    return {
        "copied_parameter_count": len(copied),
        "new_parameter_count": len(new_names),
        "new_parameter_names": new_names,
    }


def _tiered_materialize(
    *,
    torch: Any,
    processor: Any,
    resolver: Any,
    synthetic_examples: Sequence[base.SyntheticExample],
    human_examples: Sequence[base.HumanExample],
    candidate_ids: tuple[str, ...],
    base_materialize: Any | None = None,
) -> dict[str, Any]:
    materialize = base_materialize or base._materialize_batch  # noqa: SLF001
    result = dict(
        materialize(
            torch=torch,
            processor=processor,
            resolver=resolver,
            synthetic_examples=synthetic_examples,
            human_examples=human_examples,
            candidate_count=len(candidate_ids),
        )
    )
    result["human_targets"] = torch.tensor(
        [v2.tier_code_target(example, candidate_ids) for example in human_examples],
        dtype=torch.float32,
    )
    result["human_none_masks"] = torch.tensor(
        human_none_supervision_mask(human_examples, candidate_ids),
        dtype=torch.bool,
    )
    return result


def _evaluate_v3(
    *,
    torch: Any,
    student: Any,
    processor: Any,
    resolver: Any,
    examples: Sequence[base.HumanExample],
    candidate_ids: tuple[str, ...],
    prototype_tensor: Any,
    candidate_bags: Sequence[Any],
    batch_size: int,
    preferred_weight: float,
    acceptable_weight: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    original = base._materialize_batch  # noqa: SLF001

    def materialize(**kwargs: Any) -> Mapping[str, Any]:
        return _tiered_materialize(
            candidate_ids=candidate_ids,
            base_materialize=original,
            **{key: value for key, value in kwargs.items() if key != "candidate_count"},
        )

    try:
        base._materialize_batch = materialize  # type: ignore[assignment]  # noqa: SLF001
        metrics, predictions = v2._evaluate_human_val_v2(  # noqa: SLF001
            torch=torch,
            student=student,
            processor=processor,
            resolver=resolver,
            examples=examples,
            candidate_ids=candidate_ids,
            prototype_tensor=prototype_tensor,
            candidate_bags=candidate_bags,
            batch_size=batch_size,
            preferred_weight=preferred_weight,
            acceptable_weight=acceptable_weight,
        )
    finally:
        base._materialize_batch = original  # type: ignore[assignment]  # noqa: SLF001
    distribution = Counter(row["ranked_candidate_ids"][0] for row in predictions)
    total = sum(distribution.values())
    metrics.update(
        {
            "top1_candidate_distribution": dict(sorted(distribution.items())),
            "top1_max_candidate_share": max(distribution.values()) / total,
            "top1_unique_candidate_count": len(distribution),
        }
    )
    return metrics, predictions


def _metric_key(
    metrics: Mapping[str, Any], gate: Mapping[str, Any]
) -> tuple[float, ...]:
    return (
        float(bool(gate.get("passed"))),
        _finite(metrics.get("variant_preferred_at1"), "variant preferred"),
        _finite(metrics.get("preferred_at1"), "preferred"),
        _finite(metrics.get("variant_acceptable_at1"), "variant acceptable"),
        _finite(metrics.get("acceptable_at1"), "acceptable"),
        _finite(metrics.get("acceptable_hit_at3"), "acceptable hit3"),
        -_finite(metrics.get("tiered_gold_loss"), "tiered loss"),
    )


def _is_better(
    candidate: Mapping[str, Any],
    candidate_gate: Mapping[str, Any],
    best: Mapping[str, Any] | None,
    best_gate: Mapping[str, Any] | None,
    *,
    min_delta: float,
) -> bool:
    if best is None or best_gate is None:
        return True
    for left, right in zip(
        _metric_key(candidate, candidate_gate),
        _metric_key(best, best_gate),
        strict=True,
    ):
        if left > right + min_delta:
            return True
        if left < right - min_delta:
            return False
    return False


def _train_student_v3(
    *,
    args: argparse.Namespace,
    synthetic: base.SyntheticSnapshot,
    human: base.HumanSnapshot,
    catalog_registry: Path,
    warm_binding: Mapping[str, Any],
    baseline: Mapping[str, Any],
) -> dict[str, Any]:
    torch, processor_class, vision_class, save_file = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise MangaFontStudentV3Error("v3 training requires CUDA bf16")
    base._configure_reproducibility(torch, seed=args.seed)  # noqa: SLF001
    try:
        from font_matching_catalog_assets import CatalogAssetResolver
    except ImportError:  # pragma: no cover - repository-root import
        from scripts.font_matching_catalog_assets import CatalogAssetResolver

    resolver = CatalogAssetResolver(catalog_registry)
    processor = processor_class.from_pretrained(
        base.MODEL_ID,
        revision=base.MODEL_REVISION,
        use_fast=base.PROCESSOR_USE_FAST,
        local_files_only=True,
    )
    vision_encoder = vision_class.from_pretrained(
        base.MODEL_ID,
        revision=base.MODEL_REVISION,
        local_files_only=True,
    )
    student, trainable_blocks = build_student_model_v3(
        torch,
        vision_encoder=vision_encoder,
        candidate_count=len(synthetic.candidate_ids),
        dropout=args.residual_dropout,
        residual_scale=args.residual_scale,
    )
    student.to("cuda")
    warm_copy = _apply_warm_start(torch, student, args.warm_start_student_dir)
    head_sweep_binding: Mapping[str, Any] | None = None
    if args.head_sweep_dir is not None:
        try:
            from scripts import sweep_manga_font_student_v3_heads as head_sweep
        except ImportError:  # pragma: no cover - direct execution from scripts/
            import sweep_manga_font_student_v3_heads as head_sweep
        head_sweep_binding = head_sweep.load_best_head_into_student(
            student=student,
            sweep_dir=args.head_sweep_dir,
            warm_start_dir=args.warm_start_student_dir,
            # A failed head-only gate may still be useful initialization; the
            # final encoder fine-tune has its own mandatory deployment gate.
            require_quality_gate=False,
        )

    encoder_parameters = [
        parameter for parameter in vision_encoder.parameters() if parameter.requires_grad
    ]
    head_parameters = [
        *student.projection.parameters(),
        *student.font_head.parameters(),
        *student.runtime_ranker.parameters(),
    ]
    if {id(value) for value in encoder_parameters} & {
        id(value) for value in head_parameters
    }:
        raise MangaFontStudentV3Error("v3 optimizer parameter groups overlap")
    optimizer = torch.optim.AdamW(
        [
            {"params": encoder_parameters, "lr": args.encoder_lr},
            {"params": head_parameters, "lr": args.head_lr},
        ],
        weight_decay=args.weight_decay,
        betas=(0.9, 0.999),
        eps=1e-8,
        foreach=False,
    )

    metadata = v2.load_synthetic_train_metadata(synthetic)
    prototype_examples, candidate_bag_records = v2.select_stratified_prototypes(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        per_font=args.prototypes_per_font,
        metadata=metadata,
    )
    candidate_bags = tuple(
        torch.arange(
            record["start"],
            record["start"] + record["count"],
            dtype=torch.long,
            device="cuda",
        )
        for record in candidate_bag_records
    )
    prototype_tensor = base._encode_prototype_bank(  # noqa: SLF001
        torch=torch,
        student=student,
        processor=processor,
        examples=prototype_examples,
        batch_size=args.eval_batch_size,
    )
    human_train = tuple(human.train_examples)
    if not human_train:
        raise MangaFontStudentV3Error("human train is empty")
    row_weight_by_id = dict(
        zip(
            (example.sample_id for example in human_train),
            variant_aware_human_row_weights(
                human_train,
                synthetic.candidate_ids,
                variant_weight=args.variant_human_weight,
                full22_weight=args.full22_human_weight,
            ),
            strict=True,
        )
    )

    history: list[dict[str, Any]] = []
    best_metrics: dict[str, Any] | None = None
    best_gate: dict[str, Any] | None = None
    best_epoch = 0
    best_state: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    epochs_without_improvement = 0
    realized_synthetic = 0
    realized_human = 0

    for epoch in range(1, args.epochs + 1):
        batches = base.build_epoch_batches(
            synthetic_count=len(synthetic.train_examples),
            human_count=len(human_train),
            batch_size=args.batch_size,
            human_fraction=args.human_fraction,
            seed=args.seed + epoch,
        )
        batches = rebalance_epoch_human_batches(
            batches,
            human_train,
            synthetic.candidate_ids,
            partial_fraction=args.partial_human_batch_fraction,
            seed=args.seed + 100_000 + epoch,
        )
        student.train(True)
        sums: Counter[str] = Counter()
        for batch in batches:
            synthetic_rows = [
                synthetic.train_examples[index] for index in batch.synthetic_indices
            ]
            human_rows = [human_train[index] for index in batch.human_indices]
            materialized = _tiered_materialize(
                torch=torch,
                processor=processor,
                resolver=resolver,
                synthetic_examples=synthetic_rows,
                human_examples=human_rows,
                candidate_ids=synthetic.candidate_ids,
            )
            pixels = materialized["pixel_values"].to("cuda", non_blocking=False)
            synthetic_labels = materialized["synthetic_labels"].to("cuda")
            human_targets = materialized["human_targets"].to("cuda")
            human_masks = materialized["human_masks"].to("cuda")
            none_targets = materialized["human_none_targets"].to("cuda")
            none_masks = materialized["human_none_masks"].to("cuda")
            role_targets = materialized["human_role_targets"].to("cuda")
            style_targets = materialized["human_style_targets"].to("cuda")
            style_masks = materialized["human_style_masks"].to("cuda")
            treatment_targets = materialized["human_treatment_targets"].to("cuda")
            synthetic_count = len(synthetic_rows)
            human_count = len(human_rows)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                flat_embedding, flat_direct_logits = student(pixels)
                embeddings = flat_embedding.reshape(
                    synthetic_count + human_count, len(base.VIEW_NAMES), -1
                )
                direct_logits = flat_direct_logits.reshape(
                    synthetic_count + human_count, len(base.VIEW_NAMES), -1
                )
                runtime_outputs = student.runtime_forward(
                    embeddings, prototype_tensor, candidate_bags
                )
                runtime_synthetic_ce = torch.nn.functional.cross_entropy(
                    runtime_outputs["candidate_scores"][:synthetic_count],
                    synthetic_labels,
                )
                direct_synthetic_ce = torch.nn.functional.cross_entropy(
                    direct_logits[:synthetic_count].reshape(
                        -1, len(synthetic.candidate_ids)
                    ),
                    synthetic_labels.repeat_interleave(len(base.VIEW_NAMES)),
                )
                synthetic_loss = runtime_synthetic_ce + (
                    args.direct_synthetic_weight * direct_synthetic_ce
                )
                runtime_human = {
                    "candidate_scores": runtime_outputs["candidate_scores"][
                        synthetic_count:
                    ],
                    "none_logits": runtime_outputs["none_logits"][synthetic_count:],
                    "role_logits": runtime_outputs["role_logits"][synthetic_count:],
                    "style_logits": runtime_outputs["style_logits"][synthetic_count:],
                    "treatment_logits": {
                        field: values[synthetic_count:]
                        for field, values in runtime_outputs[
                            "treatment_logits"
                        ].items()
                    },
                }
                row_weights = torch.tensor(
                    [row_weight_by_id[row.sample_id] for row in human_rows],
                    dtype=torch.float32,
                    device="cuda",
                )
                human_loss = tiered_deployment_loss(
                    torch,
                    runtime_human["candidate_scores"],
                    human_targets,
                    human_masks,
                    preferred_weight=args.preferred_loss_weight,
                    acceptable_weight=args.acceptable_loss_weight,
                    row_weights=row_weights,
                )
                auxiliary_loss, _ = masked_human_auxiliary_loss(
                    torch=torch,
                    outputs=runtime_human,
                    none_targets=none_targets,
                    none_masks=none_masks,
                    role_targets=role_targets,
                    style_targets=style_targets,
                    style_masks=style_masks,
                    treatment_targets=treatment_targets,
                )
                consistency = base._three_view_consistency(  # noqa: SLF001
                    torch, embeddings[:synthetic_count]
                )
                diversity = candidate_weight_diversity_loss(
                    torch, student.runtime_ranker
                )
                classification = (
                    synthetic_loss * synthetic_count
                    + human_loss * human_count * args.human_loss_scale
                ) / (synthetic_count + human_count * args.human_loss_scale)
                loss = (
                    classification
                    + args.consistency_weight * consistency
                    + args.auxiliary_weight * auxiliary_loss
                    + args.diversity_weight * diversity
                )
            if not bool(torch.isfinite(loss)):
                raise MangaFontStudentV3Error("v3 training loss became non-finite")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                [*encoder_parameters, *head_parameters], args.gradient_clip
            )
            optimizer.step()
            sums["loss"] += float(loss.detach().item())
            sums["synthetic"] += float(synthetic_loss.detach().item())
            sums["human"] += float(human_loss.detach().item())
            sums["auxiliary"] += float(auxiliary_loss.detach().item())
            sums["consistency"] += float(consistency.detach().item())
            sums["diversity"] += float(diversity.detach().item())
            realized_synthetic += synthetic_count
            realized_human += human_count

        prototype_tensor = base._encode_prototype_bank(  # noqa: SLF001
            torch=torch,
            student=student,
            processor=processor,
            examples=prototype_examples,
            batch_size=args.eval_batch_size,
        )
        metrics, predictions = _evaluate_v3(
            torch=torch,
            student=student,
            processor=processor,
            resolver=resolver,
            examples=human.val_examples,
            candidate_ids=synthetic.candidate_ids,
            prototype_tensor=prototype_tensor,
            candidate_bags=candidate_bags,
            batch_size=args.eval_batch_size,
            preferred_weight=args.preferred_loss_weight,
            acceptable_weight=args.acceptable_loss_weight,
        )
        gate = evaluate_quality_gate(
            metrics,
            baseline,
            minimum_preferred_gain=args.minimum_preferred_gain,
            minimum_acceptable_gain=args.minimum_acceptable_gain,
            maximum_top1_share=args.maximum_top1_share,
            minimum_unique_top1=args.minimum_unique_top1,
        )
        epoch_record = {
            "epoch": epoch,
            "quality_gate": copy.deepcopy(gate),
            "train": {
                key: sums[key] / len(batches)
                for key in (
                    "auxiliary",
                    "consistency",
                    "diversity",
                    "human",
                    "loss",
                    "synthetic",
                )
            },
            "val": copy.deepcopy(metrics),
        }
        history.append(epoch_record)
        print(
            base.canonical_json(
                {
                    "event": "v3_epoch_complete",
                    "epoch": epoch,
                    "quality_gate_passed": gate["passed"],
                    "val": metrics,
                }
            ),
            flush=True,
        )
        if _is_better(
            metrics,
            gate,
            best_metrics,
            best_gate,
            min_delta=args.min_delta,
        ):
            best_metrics = copy.deepcopy(metrics)
            best_gate = copy.deepcopy(gate)
            best_epoch = epoch
            best_state = {
                name: parameter.detach().cpu().clone()
                for name, parameter in student.named_parameters()
                if parameter.requires_grad
            }
            best_predictions = copy.deepcopy(predictions)
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= args.patience:
                break

    if (
        best_state is None
        or best_metrics is None
        or best_gate is None
        or best_predictions is None
    ):
        raise MangaFontStudentV3Error("v3 training produced no checkpoint")
    if not best_gate["passed"] and not args.allow_research_output:
        raise MangaFontStudentV3Error(
            "v3 quality gate failed; refusing to publish a deployment candidate"
        )
    parameters = dict(student.named_parameters())
    with torch.no_grad():
        for name, value in best_state.items():
            parameters[name].copy_(value.to("cuda"))
    prototype_tensor = base._encode_prototype_bank(  # noqa: SLF001
        torch=torch,
        student=student,
        processor=processor,
        examples=prototype_examples,
        batch_size=args.eval_batch_size,
    )
    restored_metrics, restored_predictions = _evaluate_v3(
        torch=torch,
        student=student,
        processor=processor,
        resolver=resolver,
        examples=human.val_examples,
        candidate_ids=synthetic.candidate_ids,
        prototype_tensor=prototype_tensor,
        candidate_bags=candidate_bags,
        batch_size=args.eval_batch_size,
        preferred_weight=args.preferred_loss_weight,
        acceptable_weight=args.acceptable_loss_weight,
    )
    restored_gate = evaluate_quality_gate(
        restored_metrics,
        baseline,
        minimum_preferred_gain=args.minimum_preferred_gain,
        minimum_acceptable_gain=args.minimum_acceptable_gain,
        maximum_top1_share=args.maximum_top1_share,
        minimum_unique_top1=args.minimum_unique_top1,
    )
    if _metric_key(restored_metrics, restored_gate) != _metric_key(
        best_metrics, best_gate
    ):
        raise MangaFontStudentV3Error("restored v3 checkpoint metrics drifted")
    if [row["record_sha256"] for row in restored_predictions] != [
        row["record_sha256"] for row in best_predictions
    ]:
        raise MangaFontStudentV3Error("restored v3 predictions drifted")

    state = {
        name: parameter.detach().cpu().contiguous()
        for name, parameter in student.named_parameters()
        if parameter.requires_grad
    }
    return {
        "best_epoch": best_epoch,
        "best_metrics": best_metrics,
        "candidate_ids": synthetic.candidate_ids,
        "checkpoint_metadata": {
            "base_model_id": base.MODEL_ID,
            "base_model_revision": base.MODEL_REVISION,
            "format": base.OUTPUT_SCHEMA,
            "kind": "trainable_delta_against_pinned_local_base",
            "trainer_extension": EXTENSION_SCHEMA,
        },
        "history": history,
        "head_sweep": copy.deepcopy(head_sweep_binding),
        "optimizer": {
            "class": "AdamW",
            "encoder_lr": args.encoder_lr,
            "head_lr": args.head_lr,
            "weight_decay": args.weight_decay,
            "betas": [0.9, 0.999],
            "eps": 1e-8,
        },
        "parameter_counts": {
            "encoder_trainable": base._count_parameters(encoder_parameters),  # noqa: SLF001
            "projection_and_head_trainable": base._count_parameters(  # noqa: SLF001
                head_parameters
            ),
            "saved_trainable": sum(int(value.numel()) for value in state.values()),
        },
        "prototype_bags": candidate_bag_records,
        "prototype_features": prototype_tensor.detach()
        .cpu()
        .float()
        .contiguous(),
        "prototype_sample_ids": tuple(
            value.sample_id for value in prototype_examples
        ),
        "predictions": restored_predictions,
        "processor_config_sha256": base.sha256_bytes(
            base.canonical_json(processor.to_dict()).encode("utf-8")
        ),
        "quality_gate": best_gate,
        "quality_gate_baseline": copy.deepcopy(dict(baseline)),
        "realized_batch_counts": {
            "human": realized_human,
            "synthetic": realized_synthetic,
            "human_fraction": realized_human
            / (realized_human + realized_synthetic),
        },
        "save_file": save_file,
        "state": state,
        "trainable_blocks": trainable_blocks,
        "total_vision_blocks": len(vision_encoder.vision_model.encoder.layers),
        "warm_start": {**dict(warm_binding), **warm_copy},
    }


def _rewrite_v3_contract(
    output: Path,
    *,
    args: argparse.Namespace,
    bindings: Mapping[str, Any],
    training: Mapping[str, Any],
) -> None:
    contract_path = output / base.CONTRACT_FILE
    report_path = output / base.REPORT_FILE
    marker_path = output / base.OUTPUT_MARKER
    contract = base.read_json(contract_path, location="v3 student contract")
    contract.pop("record_sha256", None)
    architecture = dict(_mapping(contract.get("architecture"), "v3 architecture"))
    architecture["runtime_candidate_scoring"] = (
        "prototype-logmeanexp-plus-role-style-conditioned-"
        "bias-free-candidate-residual-v3"
    )
    architecture["runtime_candidate_scorer_schema"] = SCORER_SCHEMA
    contract["architecture"] = architecture
    objectives = dict(_mapping(contract.get("objectives"), "v3 objectives"))
    objectives.update(
        {
            "direct_head_human_loss_weight": 0.0,
            "direct_head_synthetic_auxiliary_weight": args.direct_synthetic_weight,
            "human": "tiered_set_nll_on_exported_combined_candidate_scores",
            "human_frequency_weighting": "bounded_inverse_sqrt_train_only",
            "human_loss_scale": args.human_loss_scale,
            "human_supervision_deployment_aligned": True,
            "human_variant_row_weight": args.variant_human_weight,
            "human_full22_anchor_weight": args.full22_human_weight,
            "human_partial_batch_fraction": args.partial_human_batch_fraction,
            "human_source_balanced_batches": True,
            "residual_candidate_diversity_weight": args.diversity_weight,
        }
    )
    contract["objectives"] = objectives
    contract["trainer_extension"] = {
        "base_trainer_source_code_sha256": contract["source_code_sha256"],
        "human_train_overlay": copy.deepcopy(bindings["human_train_overlay"]),
        "human_train_legacy15_overlay": copy.deepcopy(
            bindings["human_train_legacy15_overlay"]
        ),
        "human_train_candidate_supervision": copy.deepcopy(
            bindings["human_train_candidate_supervision"]
        ),
        "human_val_overlay": copy.deepcopy(bindings["human_val_overlay"]),
        "human_val_candidate_supervision": copy.deepcopy(
            bindings["human_val_candidate_supervision"]
        ),
        "head_sweep_initialization": copy.deepcopy(training["head_sweep"]),
        "quality_gate": copy.deepcopy(training["quality_gate"]),
        "quality_gate_baseline": copy.deepcopy(training["quality_gate_baseline"]),
        "runtime_io_change_required": False,
        "runtime_ranker_reconstruction_required": True,
        "runtime_ranker_hyperparameters": {
            "candidate_count": base.CANDIDATE_COUNT,
            "residual_dropout": args.residual_dropout,
            "residual_initial_scale": args.residual_scale,
            "scorer_schema": SCORER_SCHEMA,
            "semantic_mix_initial": 0.25,
        },
        "schema_version": EXTENSION_SCHEMA,
        "scorer_schema": SCORER_SCHEMA,
        "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
        "warm_start": copy.deepcopy(training["warm_start"]),
    }
    contract = base.seal_record(contract)
    contract_path.write_bytes(base.json_bytes(contract, pretty=True))

    report = base.read_json(report_path, location="v3 training report")
    report.pop("record_sha256", None)
    checks = dict(_mapping(report.get("checks"), "v3 report checks"))
    checks.update(
        {
            "human_direct_head_loss_applied": False,
            "human_test_labels_deserialized": 0,
            "human_test_pixels_opened": 0,
            "human_train_named_overlay_applied": True,
            "human_train_legacy15_partial_rows": int(
                bindings["human_train_candidate_supervision"][
                    "partial_candidate_row_count"
                ]
            ),
            "legacy15_successor_candidates_loss_masked": True,
            "legacy15_none_auxiliary_masked": True,
            "partial_rows_called_full22": False,
            "human_val_adjudicated_overlay_applied": True,
            "train_val_identity_overlap": 0,
            "v3_quality_gate_passed": bool(training["quality_gate"]["passed"]),
        }
    )
    report["checks"] = checks
    report["early_stopping"] = {
        "metric_priority": [
            "quality_gate_passed",
            "variant_preferred_at1",
            "preferred_at1",
            "variant_acceptable_at1",
            "acceptable_at1",
            "acceptable_hit_at3",
            "negative_tiered_gold_loss",
        ],
        "min_delta": args.min_delta,
        "patience": args.patience,
    }
    report["model_contract_sha256"] = base.sha256_file(contract_path)
    report["quality_gate"] = copy.deepcopy(training["quality_gate"])
    report["quality_gate_baseline"] = copy.deepcopy(
        training["quality_gate_baseline"]
    )
    report["training_extension"] = EXTENSION_SCHEMA
    report = base.seal_record(report)
    report_path.write_bytes(base.json_bytes(report, pretty=True))
    marker = {
        "artifacts": {
            name: base.sha256_file(output / name) for name in base.OUTPUT_ARTIFACTS
        },
        "owner": base.OUTPUT_OWNER,
        "safe_replace": True,
        "schema_version": base.OUTPUT_SCHEMA,
    }
    marker_path.write_bytes(base.json_bytes(marker, pretty=True))


def _validate_v3_output(
    output_dir: Path, *, require_quality_gate: bool
) -> Mapping[str, Any]:
    result = dict(base.validate_output(output_dir))
    root = output_dir.expanduser().resolve()
    contract = base.read_json(root / base.CONTRACT_FILE, location="v3 contract")
    report = base.read_json(root / base.REPORT_FILE, location="v3 report")
    extension = _mapping(contract.get("trainer_extension"), "v3 extension")
    gate = _mapping(extension.get("quality_gate"), "v3 quality gate")
    hyperparameters = _mapping(
        extension.get("runtime_ranker_hyperparameters"),
        "v3 runtime ranker hyperparameters",
    )
    architecture = _mapping(contract.get("architecture"), "v3 architecture")
    train_scope = _mapping(
        extension.get("human_train_candidate_supervision"),
        "v3 train candidate supervision",
    )
    val_scope = _mapping(
        extension.get("human_val_candidate_supervision"),
        "v3 val candidate supervision",
    )
    legacy_binding = _mapping(
        extension.get("human_train_legacy15_overlay"),
        "v3 legacy15 train overlay",
    )
    if (
        extension.get("schema_version") != EXTENSION_SCHEMA
        or extension.get("scorer_schema") != SCORER_SCHEMA
        or extension.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
        or extension.get("runtime_io_change_required") is not False
        or extension.get("runtime_ranker_reconstruction_required") is not True
        or architecture.get("runtime_candidate_scorer_schema") != SCORER_SCHEMA
        or set(hyperparameters)
        != {
            "candidate_count",
            "residual_dropout",
            "residual_initial_scale",
            "scorer_schema",
            "semantic_mix_initial",
        }
        or hyperparameters.get("candidate_count") != base.CANDIDATE_COUNT
        or hyperparameters.get("scorer_schema") != SCORER_SCHEMA
        or hyperparameters.get("semantic_mix_initial") != 0.25
        or not 0.0
        <= _finite(
            hyperparameters.get("residual_dropout"), "v3 residual dropout"
        )
        < 0.5
        or not 0.05
        <= _finite(
            hyperparameters.get("residual_initial_scale"),
            "v3 residual initial scale",
        )
        <= 4.0
        or train_scope.get("partial_rows_called_full22") is not False
        or val_scope.get("partial_candidate_row_count") != 0
        or val_scope.get("partial_rows_called_full22") is not False
        or int(train_scope.get("partial_candidate_row_count", -1))
        != int(legacy_binding.get("partial_candidate_row_count", -2))
    ):
        raise MangaFontStudentV3Error("v3 extension/scorer binding drifted")
    if require_quality_gate and gate.get("passed") is not True:
        raise MangaFontStudentV3Error("v3 output is research-only; deployment gate failed")
    checks = _mapping(report.get("checks"), "v3 report checks")
    if (
        checks.get("human_direct_head_loss_applied") is not False
        or checks.get("human_test_labels_deserialized") != 0
        or checks.get("human_test_pixels_opened") != 0
        or checks.get("train_val_identity_overlap") != 0
        or checks.get("partial_rows_called_full22") is not False
        or checks.get("legacy15_successor_candidates_loss_masked") is not True
        or checks.get("legacy15_none_auxiliary_masked") is not True
        or checks.get("human_train_legacy15_partial_rows")
        != train_scope.get("partial_candidate_row_count")
    ):
        raise MangaFontStudentV3Error("v3 leakage/deployment checks failed")
    if checks.get("v3_quality_gate_passed") is not (gate.get("passed") is True):
        raise MangaFontStudentV3Error("v3 report/contract gate status drifted")
    result.update(
        {
            "quality_gate_passed": gate.get("passed") is True,
            "runtime_scorer": SCORER_SCHEMA,
            "status": (
                "ready"
                if gate.get("passed") is True
                else "research_only_quality_gate_failed"
            ),
            "training_extension": EXTENSION_SCHEMA,
        }
    )
    return result


def validate_v3_output(output_dir: Path) -> Mapping[str, Any]:
    """Validate only deployment-eligible v3 outputs."""

    return _validate_v3_output(output_dir, require_quality_gate=True)


def validate_v3_research_output(output_dir: Path) -> Mapping[str, Any]:
    """Validate a sealed diagnostic output without authorizing deployment."""

    return _validate_v3_output(output_dir, require_quality_gate=False)


def preflight_command(args: argparse.Namespace) -> Mapping[str, Any]:
    _registry, synthetic, human, bindings = _load_inputs(args)
    warm = _validate_warm_start(
        args.warm_start_student_dir, candidate_ids=synthetic.candidate_ids
    )
    metadata = v2.load_synthetic_train_metadata(synthetic)
    prototypes, bags = v2.select_stratified_prototypes(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        per_font=args.prototypes_per_font,
        metadata=metadata,
    )
    baseline = constant_candidate_baseline(human.val_examples, synthetic.candidate_ids)
    head_sweep_validation = None
    if args.head_sweep_dir is not None:
        try:
            from scripts import sweep_manga_font_student_v3_heads as head_sweep
        except ImportError:  # pragma: no cover - direct execution from scripts/
            import sweep_manga_font_student_v3_heads as head_sweep
        head_sweep_validation = head_sweep.validate_sweep(
            args.head_sweep_dir,
            warm_start_dir=args.warm_start_student_dir,
            require_quality_gate=False,
        )
    return {
        "candidate_count": len(synthetic.candidate_ids),
        "human_test_labels_deserialized": 0,
        "human_test_pixels_opened": 0,
        "human_train_record_count": len(human.train_examples),
        "human_val_record_count": len(human.val_examples),
        "head_sweep_initialization": head_sweep_validation,
        "named_train_overlay": bindings["human_train_overlay"],
        "legacy15_train_overlay": bindings["human_train_legacy15_overlay"],
        "train_candidate_supervision": bindings[
            "human_train_candidate_supervision"
        ],
        "prototype_bag_count": len(bags),
        "prototype_count": len(prototypes),
        "quality_gate_constant_baseline": baseline,
        "recommended_head_only_sweep": {
            "diversity_weight": [0.01, 0.03],
            "head_lr": [0.0001, 0.0002],
            "maximum_trials": 4,
            "partial_row_weight": [0.75, 1.0],
            "residual_scale": [0.5, 1.0],
            "source_balanced_human_batches": True,
            "selection_uses_val_only": True,
            "test_data_used": False,
        },
        "runtime_change": {
            "onnx_io_change_required": False,
            "python_exporter_reconstruction_change_required": True,
            "typescript_inference_change_required": False,
        },
        "status": "ready_for_v3_head_sweep_then_short_finetune",
        "train_val_identity_overlap": 0,
        "val_overlay": bindings["human_val_overlay"],
        "val_used_for_optimizer": False,
        "warm_start": warm,
    }


def _validate_args(args: argparse.Namespace) -> None:
    finite = (
        args.acceptable_loss_weight,
        args.auxiliary_weight,
        args.consistency_weight,
        args.direct_synthetic_weight,
        args.diversity_weight,
        args.encoder_lr,
        args.gradient_clip,
        args.head_lr,
        args.full22_human_weight,
        args.human_loss_scale,
        args.human_fraction,
        args.maximum_top1_share,
        args.minimum_acceptable_gain,
        args.minimum_preferred_gain,
        args.min_delta,
        args.preferred_loss_weight,
        args.partial_human_batch_fraction,
        args.residual_dropout,
        args.residual_scale,
        args.variant_human_weight,
        args.weight_decay,
    )
    if (
        args.epochs < 1
        or args.patience < 1
        or args.batch_size < 4
        or args.eval_batch_size < 1
        or not 12 <= args.prototypes_per_font <= 16
        or not 0.05 <= args.human_fraction <= 0.5
        or args.encoder_lr <= 0.0
        or args.head_lr <= 0.0
        or not 0.25 <= args.human_loss_scale <= 8.0
        or args.weight_decay < 0.0
        or args.preferred_loss_weight <= 0.0
        or args.acceptable_loss_weight < 0.0
        or args.direct_synthetic_weight < 0.0
        or args.auxiliary_weight < 0.0
        or args.consistency_weight < 0.0
        or args.diversity_weight < 0.0
        or args.gradient_clip <= 0.0
        or not 0.0 <= args.residual_dropout < 0.5
        or not 0.05 <= args.residual_scale <= 4.0
        or not 1.0 <= args.variant_human_weight <= 4.0
        or not 1.0 <= args.full22_human_weight <= 3.0
        or not 0.25 <= args.partial_human_batch_fraction <= 0.75
        or not 0.0 <= args.minimum_preferred_gain <= 0.5
        or not 0.0 <= args.minimum_acceptable_gain <= 0.5
        or not 0.2 <= args.maximum_top1_share <= 1.0
        or not 2 <= args.minimum_unique_top1 <= base.CANDIDATE_COUNT
        or not all(math.isfinite(value) for value in finite)
    ):
        raise MangaFontStudentV3Error("v3 optimizer/loss/gate configuration is invalid")


def train_command(args: argparse.Namespace) -> Mapping[str, Any]:
    _validate_args(args)
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontStudentV3Error("v3 output directory already exists")
    registry, synthetic, human, bindings = _load_inputs(args)
    registry_path = args.catalog_registry.expanduser().resolve()
    registry_sha = base.sha256_file(registry_path)
    registry_record_sha = base.validate_record_seal(
        registry, location="catalog registry"
    )
    warm = _validate_warm_start(
        args.warm_start_student_dir, candidate_ids=synthetic.candidate_ids
    )
    baseline = constant_candidate_baseline(human.val_examples, synthetic.candidate_ids)
    training = _train_student_v3(
        args=args,
        synthetic=synthetic,
        human=human,
        catalog_registry=registry_path,
        warm_binding=warm,
        baseline=baseline,
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.v3-publish-", dir=output.parent)
    )
    temporary.rmdir()
    published = False
    try:
        base._write_owned_output(  # noqa: SLF001
            output_dir=temporary,
            args=args,
            training=training,
            synthetic=synthetic,
            human=human,
            catalog_registry_sha256=registry_sha,
            catalog_registry_record_sha256=registry_record_sha,
        )
        _rewrite_v3_contract(
            temporary, args=args, bindings=bindings, training=training
        )
        validator = (
            validate_v3_research_output
            if args.allow_research_output
            else validate_v3_output
        )
        validator(temporary)
        if output.exists():
            raise MangaFontStudentV3Error("v3 output appeared during training")
        os.rename(temporary, output)
        try:
            result = validator(output)
        except BaseException:
            shutil.rmtree(output)
            raise
        published = True
        return result
    finally:
        if not published and temporary.exists():
            shutil.rmtree(temporary)


def _add_input_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--synthetic-dir", type=Path, required=True)
    parser.add_argument("--human-export-dir", type=Path, required=True)
    parser.add_argument("--human-val-overlay-dir", type=Path, required=True)
    parser.add_argument("--human-val-finals-dir", type=Path, required=True)
    parser.add_argument("--human-train-overlay-dir", type=Path, required=True)
    parser.add_argument(
        "--human-train-secondary-overlay-dir", type=Path, required=True
    )
    parser.add_argument(
        "--human-train-secondary-corrections", type=Path, required=True
    )
    parser.add_argument("--human-train-legacy15-overlay-dir", type=Path)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--warm-start-student-dir", type=Path, required=True)
    parser.add_argument("--head-sweep-dir", type=Path)
    parser.add_argument("--prototypes-per-font", type=int, default=16)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight")
    _add_input_arguments(preflight)
    train = subparsers.add_parser("train")
    _add_input_arguments(train)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--epochs", type=int, default=6)
    train.add_argument("--patience", type=int, default=3)
    train.add_argument("--batch-size", type=int, default=16)
    train.add_argument("--eval-batch-size", type=int, default=16)
    train.add_argument("--human-fraction", type=float, default=0.45)
    train.add_argument("--human-loss-scale", type=float, default=2.0)
    train.add_argument("--variant-human-weight", type=float, default=1.75)
    train.add_argument("--full22-human-weight", type=float, default=1.25)
    train.add_argument("--partial-human-batch-fraction", type=float, default=0.50)
    train.add_argument("--encoder-lr", type=float, default=5e-6)
    train.add_argument("--head-lr", type=float, default=1e-4)
    train.add_argument("--weight-decay", type=float, default=0.01)
    train.add_argument("--consistency-weight", type=float, default=0.02)
    train.add_argument("--auxiliary-weight", type=float, default=0.10)
    train.add_argument("--direct-synthetic-weight", type=float, default=0.15)
    train.add_argument("--diversity-weight", type=float, default=0.02)
    train.add_argument("--preferred-loss-weight", type=float, default=1.0)
    train.add_argument("--acceptable-loss-weight", type=float, default=0.20)
    train.add_argument("--residual-dropout", type=float, default=0.10)
    train.add_argument("--residual-scale", type=float, default=0.75)
    train.add_argument("--gradient-clip", type=float, default=1.0)
    train.add_argument("--min-delta", type=float, default=1e-4)
    train.add_argument("--minimum-preferred-gain", type=float, default=0.03)
    train.add_argument("--minimum-acceptable-gain", type=float, default=0.02)
    train.add_argument("--maximum-top1-share", type=float, default=0.55)
    train.add_argument("--minimum-unique-top1", type=int, default=4)
    train.add_argument("--allow-research-output", action="store_true")
    train.add_argument("--seed", type=int, default=20260803)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "preflight":
            result = preflight_command(args)
        elif args.command == "train":
            result = train_command(args)
        else:
            result = validate_v3_output(args.output_dir)
    except (
        base.MangaFontStudentError,
        legacy15_overlay.Legacy15TrainOverlayError,
        train_overlay.NamedTrainReviewError,
        secondary_overlay.SecondaryNamedTrainOverlayError,
        val_overlay.HumanValOverlayError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-student-v3 error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
