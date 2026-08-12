#!/usr/bin/env python3
"""Train a tiny pixel-only body/variant adapter for the active21 font ranker.

The v7 query head is intentionally frozen.  This adapter consumes only its
three-view query embeddings and the same Korean candidate prototypes used by
the runtime ranker.  It learns:

* a small body-versus-variant gate;
* separate four-query mixtures for body and variant font ranking; and
* a bounded, zero-mean role-family compatibility bias per candidate; and
* a small sample-conditioned low-rank candidate residual from the source pixels.

No text, font name, genre, Gemma output, or page/chapter prior enters this
module.  Geometry may be used to build or stratify a review dataset, but it is
deliberately absent from the deployable model input so the ONNX ranker does not
need a new application-side input contract.

The command line consumes a compact, independently prepared NPZ.  It does not
promote pseudo labels to human gold.  Required arrays are documented by
``validate_training_arrays`` and are fail-closed, including work-disjoint
train/validation splits.
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
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_student_v1 as legacy
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v1 as legacy  # type: ignore[no-redef]


SCHEMA_VERSION = "manga-font-student-v8-role-family-adapter-v3"
DATASET_SCHEMA_VERSION = "manga-font-v8-role-family-training-arrays-v1"
OWNER = "carrot-manga-translator/manga-font-student-v8-role-family-adapter-v3"
CHECKPOINT_FILE = "role-family-adapter.safetensors"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-student-v8-role-family-adapter-owned.json"
OUTPUT_FILES = frozenset({CHECKPOINT_FILE, MANIFEST_FILE, MARKER_FILE})

QUERY_COUNT = 4
QUERY_DIM = 256
FAMILY_VALUES = ("body", "variant")
BODY_FAMILY_INDEX = 0
VARIANT_FAMILY_INDEX = 1
MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE = 0.75
MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN = math.log(2.0)
MAXIMUM_SINGLE_DAY_ALL_ROWS_TOP1_RATE = 0.01
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
VARIANT_ROLES = frozenset(
    {
        "whisper",
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
    }
)


class MangaFontV8RoleFamilyError(ValueError):
    """Raised when the role-family adapter contract is unsafe or incomplete."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    return (rendered + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = hashlib.sha256(
        canonical_json(result).encode("utf-8")
    ).hexdigest()
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise MangaFontV8RoleFamilyError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = hashlib.sha256(canonical_json(core).encode("utf-8")).hexdigest()
    if actual != expected:
        raise MangaFontV8RoleFamilyError(f"{location}: record seal drifted")


def adapter_architecture_contract(
    *,
    candidate_count: int,
    maximum_family_bias: float,
    candidate_residual_hidden_dim: int,
    maximum_sample_residual: float,
) -> Mapping[str, Any]:
    return {
        "candidate_bias": "bounded_zero_mean_role_family_only",
        "candidate_count": candidate_count,
        "candidate_residual_hidden_dim": candidate_residual_hidden_dim,
        "family_gate": "layernorm_linear_1024_to_2",
        "family_values": list(FAMILY_VALUES),
        "geometry_input": False,
        "maximum_family_bias": maximum_family_bias,
        "maximum_sample_residual": maximum_sample_residual,
        "query_count": QUERY_COUNT,
        "query_dim": QUERY_DIM,
        "sample_conditioned_candidate_residual": (
            "layernorm_1024_linear_gelu_linear_2x21_tanh_bounded"
        ),
        "score_branches": "separate_body_variant_query_mixtures",
        "text_or_font_name_or_gemma_input": False,
    }


def role_family_index(role: str) -> int | None:
    """Map a trusted exact role to the binary score-routing family."""

    if role in BODY_ROLES:
        return BODY_FAMILY_INDEX
    if role in VARIANT_ROLES:
        return VARIANT_FAMILY_INDEX
    return None


def build_role_family_adapter(
    torch: Any,
    *,
    candidate_count: int,
    initial_query_weight_logits: Any | None = None,
    initial_logit_scale: Any | None = None,
    maximum_family_bias: float = 0.35,
    candidate_residual_hidden_dim: int = 64,
    maximum_sample_residual: float = 0.75,
) -> Any:
    """Build the deployable adapter over frozen v7 query embeddings.

    The two candidate branches share the same visual similarities and differ
    only in a learned query mixture, scale, and tightly bounded family prior.
    This keeps the patch small while ensuring body and variant outputs can no
    longer be exact aliases.
    """

    if candidate_count < 2:
        raise MangaFontV8RoleFamilyError("candidate_count must be at least two")
    if not 0.0 < maximum_family_bias <= 1.0 or not math.isfinite(
        maximum_family_bias
    ):
        raise MangaFontV8RoleFamilyError("maximum_family_bias must be inside (0,1]")
    if candidate_residual_hidden_dim < 1:
        raise MangaFontV8RoleFamilyError(
            "candidate_residual_hidden_dim must be positive"
        )
    if not 0.0 < maximum_sample_residual <= 1.0 or not math.isfinite(
        maximum_sample_residual
    ):
        raise MangaFontV8RoleFamilyError(
            "maximum_sample_residual must be inside (0,1]"
        )

    class RoleFamilyAdapter(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            initial_weights = torch.zeros(QUERY_COUNT, dtype=torch.float32)
            if initial_query_weight_logits is not None:
                source = torch.as_tensor(
                    initial_query_weight_logits, dtype=torch.float32
                ).detach()
                if tuple(source.shape) != (QUERY_COUNT,):
                    raise MangaFontV8RoleFamilyError(
                        "initial query-weight shape must be [4]"
                    )
                initial_weights.copy_(source)
            initial_scale = torch.tensor(math.log(10.0), dtype=torch.float32)
            if initial_logit_scale is not None:
                source_scale = torch.as_tensor(
                    initial_logit_scale, dtype=torch.float32
                ).detach()
                if source_scale.numel() != 1 or not bool(
                    torch.isfinite(source_scale).all()
                ):
                    raise MangaFontV8RoleFamilyError(
                        "initial logit scale must be one finite scalar"
                    )
                initial_scale.copy_(source_scale.reshape(()))

            self.body_query_weight_logits = torch.nn.Parameter(
                initial_weights.clone()
            )
            self.variant_query_weight_logits = torch.nn.Parameter(
                initial_weights.clone()
            )
            self.body_logit_scale = torch.nn.Parameter(initial_scale.clone())
            self.variant_logit_scale = torch.nn.Parameter(initial_scale.clone())
            self.family_norm = torch.nn.LayerNorm(QUERY_COUNT * QUERY_DIM)
            self.family_head = torch.nn.Linear(
                QUERY_COUNT * QUERY_DIM, len(FAMILY_VALUES)
            )
            self.family_candidate_bias_logits = torch.nn.Parameter(
                torch.zeros((len(FAMILY_VALUES), candidate_count))
            )
            self.maximum_family_bias = float(maximum_family_bias)
            self.sample_candidate_norm = torch.nn.LayerNorm(
                QUERY_COUNT * QUERY_DIM
            )
            self.sample_candidate_residual = torch.nn.Sequential(
                torch.nn.Linear(
                    QUERY_COUNT * QUERY_DIM, candidate_residual_hidden_dim
                ),
                torch.nn.GELU(),
                torch.nn.Linear(
                    candidate_residual_hidden_dim,
                    len(FAMILY_VALUES) * candidate_count,
                ),
            )
            torch.nn.init.zeros_(self.sample_candidate_residual[-1].weight)
            torch.nn.init.zeros_(self.sample_candidate_residual[-1].bias)
            self.maximum_sample_residual = float(maximum_sample_residual)

        def _family_bias(self) -> Any:
            bounded = torch.tanh(self.family_candidate_bias_logits) * float(
                self.maximum_family_bias
            )
            return bounded - bounded.mean(dim=1, keepdim=True)

        def forward(self, query_views: Any, candidate_prototypes: Any) -> Mapping[str, Any]:
            if query_views.ndim == 3:
                query_views = query_views[:, None, :, :]
            if query_views.ndim != 4 or tuple(query_views.shape[-2:]) != (
                QUERY_COUNT,
                QUERY_DIM,
            ):
                raise MangaFontV8RoleFamilyError(
                    "query_views must have shape [batch,views,4,256]"
                )
            if candidate_prototypes.ndim != 3 or tuple(
                candidate_prototypes.shape[1:]
            ) != (QUERY_COUNT, QUERY_DIM):
                raise MangaFontV8RoleFamilyError(
                    "candidate_prototypes must have shape [candidate,4,256]"
                )
            if int(candidate_prototypes.shape[0]) != candidate_count:
                raise MangaFontV8RoleFamilyError("candidate prototype count drifted")

            sample = torch.nn.functional.normalize(
                query_views.float().mean(dim=1), p=2, dim=-1
            )
            prototypes = torch.nn.functional.normalize(
                candidate_prototypes.float(), p=2, dim=-1
            )
            per_query = torch.einsum("bqd,cqd->bcq", sample, prototypes)
            family_bias = self._family_bias()
            flattened = sample.reshape(sample.shape[0], -1)
            sample_residual = torch.tanh(
                self.sample_candidate_residual(
                    self.sample_candidate_norm(flattened)
                )
            ).reshape(
                sample.shape[0], len(FAMILY_VALUES), candidate_count
            ) * float(self.maximum_sample_residual)

            body_weights = torch.softmax(
                self.body_query_weight_logits.float(), dim=0
            )
            variant_weights = torch.softmax(
                self.variant_query_weight_logits.float(), dim=0
            )
            body_scores = self.body_logit_scale.float().exp().clamp(max=100.0) * (
                per_query * body_weights[None, None, :]
            ).sum(dim=-1) + family_bias[BODY_FAMILY_INDEX][None, :] + sample_residual[
                :, BODY_FAMILY_INDEX, :
            ]
            variant_scores = (
                self.variant_logit_scale.float().exp().clamp(max=100.0)
                * (per_query * variant_weights[None, None, :]).sum(dim=-1)
                + family_bias[VARIANT_FAMILY_INDEX][None, :]
                + sample_residual[:, VARIANT_FAMILY_INDEX, :]
            )
            family_logits = self.family_head(
                self.family_norm(flattened)
            )
            gate = torch.softmax(family_logits.float(), dim=-1)
            candidate_scores = (
                gate[:, BODY_FAMILY_INDEX, None] * body_scores
                + gate[:, VARIANT_FAMILY_INDEX, None] * variant_scores
            )
            return {
                "body_candidate_scores": body_scores,
                "candidate_scores": candidate_scores,
                "family_candidate_bias": family_bias,
                "family_logits": family_logits,
                "per_query_scores": per_query,
                "sample_candidate_residual": sample_residual,
                "variant_candidate_scores": variant_scores,
            }

    return RoleFamilyAdapter()


def expand_family_logits_to_role_logits(torch: Any, family_logits: Any) -> Any:
    """Project the binary gate into the unchanged 14-role runtime contract.

    The exact semantic subtype is intentionally not fabricated: body routes to
    ``dialogue`` and variant routes to ``emphasis_dialogue``.  Both are the
    canonical representatives of the two score families in the current app.
    """

    if family_logits.ndim != 2 or family_logits.shape[1] != len(FAMILY_VALUES):
        raise MangaFontV8RoleFamilyError("family_logits must have shape [batch,2]")
    body = family_logits[:, BODY_FAMILY_INDEX]
    variant = family_logits[:, VARIANT_FAMILY_INDEX]
    neutral = body * 0.0 - 20.0
    # Stacking a fixed Python tuple keeps the semantic-role dimension static in
    # ONNX shape inference.  An indexed assignment into ``torch.full`` made the
    # same dimension appear dynamic even though ROLE_VALUES is sealed.
    return torch.stack(
        tuple(
            body
            if role == "dialogue"
            else variant
            if role == "emphasis_dialogue"
            else neutral
            for role in legacy.ROLE_VALUES
        ),
        dim=1,
    )


def multi_positive_candidate_loss(
    torch: Any,
    scores: Any,
    positives: Any,
    *,
    eligible_mask: Any | None = None,
    row_weights: Any | None = None,
) -> Any:
    """Set-NLL over only candidates actually reviewed for each row."""

    if scores.ndim != 2 or positives.shape != scores.shape:
        raise MangaFontV8RoleFamilyError("candidate loss tensor shape drifted")
    positive = positives.bool()
    eligible = (
        torch.ones_like(positive)
        if eligible_mask is None
        else eligible_mask.bool()
    )
    if eligible.shape != scores.shape or not bool((positive <= eligible).all()):
        raise MangaFontV8RoleFamilyError(
            "positive candidates must be inside the reviewed candidate mask"
        )
    if not bool(positive.any(dim=1).all()) or not bool(eligible.any(dim=1).all()):
        raise MangaFontV8RoleFamilyError("every row needs one positive candidate")
    negative_infinity = torch.finfo(scores.dtype).min
    eligible_scores = scores.masked_fill(~eligible, negative_infinity)
    positive_scores = scores.masked_fill(~positive, negative_infinity)
    losses = torch.logsumexp(eligible_scores.float(), dim=1) - torch.logsumexp(
        positive_scores.float(), dim=1
    )
    if row_weights is None:
        return losses.mean()
    weights = row_weights.float()
    if weights.shape != losses.shape or not bool(
        torch.isfinite(weights).all() & (weights > 0).all()
    ):
        raise MangaFontV8RoleFamilyError(
            "supervised candidate weights must be finite and positive"
        )
    return (losses * weights).sum() / weights.sum().clamp_min(1e-6)


def role_family_training_loss(
    torch: Any,
    outputs: Mapping[str, Any],
    *,
    family_labels: Any,
    positive_mask: Any,
    preferred_mask: Any | None = None,
    candidate_eligible_mask: Any | None = None,
    font_supervision_weights: Any | None = None,
    candidate_loss_weights: Any | None = None,
    family_label_weights: Any | None = None,
    single_day_body_negative: Any | None = None,
    single_day_index: int,
    family_weight: float = 0.35,
    hard_negative_weight: float = 0.35,
    hard_negative_margin: float = 0.25,
    bias_l2_weight: float = 0.02,
    candidate_distribution_weight: float = 0.03,
    candidate_distribution_slack: float = 0.05,
    candidate_distribution_temperature: float = 0.20,
    sample_residual_l2_weight: float = 0.005,
    supervised_single_day_hard_negative_weight: float = 1.0,
) -> tuple[Any, Mapping[str, Any]]:
    """Compute balanced routing/ranking loss plus Single Day body negatives."""

    labels = family_labels.long()
    if labels.ndim != 1 or not bool(
        ((labels == BODY_FAMILY_INDEX) | (labels == VARIANT_FAMILY_INDEX)).all()
    ):
        raise MangaFontV8RoleFamilyError("family labels must be a binary vector")
    body_scores = outputs["body_candidate_scores"]
    variant_scores = outputs["variant_candidate_scores"]
    if body_scores.shape != variant_scores.shape or body_scores.shape != positive_mask.shape:
        raise MangaFontV8RoleFamilyError("role-family score/target shape drifted")
    if not 0 <= single_day_index < body_scores.shape[1]:
        raise MangaFontV8RoleFamilyError("single_day_index is out of range")

    routed_scores = torch.where(
        (labels == BODY_FAMILY_INDEX)[:, None], body_scores, variant_scores
    )
    eligible = (
        torch.ones_like(positive_mask, dtype=torch.bool)
        if candidate_eligible_mask is None
        else candidate_eligible_mask.bool()
    )
    preferred = positive_mask if preferred_mask is None else preferred_mask
    if (
        eligible.shape != positive_mask.shape
        or preferred.shape != positive_mask.shape
        or not bool((preferred.bool() <= positive_mask.bool()).all())
        or not bool((positive_mask.bool() <= eligible).all())
    ):
        raise MangaFontV8RoleFamilyError(
            "preferred/positive/eligible candidate masks are inconsistent"
        )
    font_weights = (
        torch.ones(labels.shape, device=labels.device, dtype=torch.float32)
        if font_supervision_weights is None
        else font_supervision_weights.float()
    )
    if font_weights.shape != labels.shape or not bool(
        torch.isfinite(font_weights).all() & (font_weights >= 0).all()
    ):
        raise MangaFontV8RoleFamilyError(
            "font supervision weights must be finite and nonnegative"
        )
    supervised = font_weights > 0
    candidate_weights = (
        font_weights
        if candidate_loss_weights is None
        else candidate_loss_weights.float()
    )
    if candidate_weights.shape != labels.shape or not bool(
        torch.isfinite(candidate_weights).all()
        & (candidate_weights >= 0).all()
        & ((candidate_weights > 0) == supervised).all()
    ):
        raise MangaFontV8RoleFamilyError(
            "candidate loss weights must exactly track supervised rows"
        )
    if bool(supervised.any()) and not bool(
        positive_mask.bool()[supervised].any(dim=1).all()
        & eligible[supervised].any(dim=1).all()
    ):
        raise MangaFontV8RoleFamilyError(
            "every font-supervised row needs reviewed positive candidates"
        )
    if bool(
        positive_mask.bool()[~supervised].any()
        | preferred.bool()[~supervised].any()
        | eligible[~supervised].any()
    ):
        raise MangaFontV8RoleFamilyError(
            "family-only rows cannot carry candidate supervision"
        )
    if bool(supervised.any()):
        acceptable_loss = multi_positive_candidate_loss(
            torch,
            routed_scores[supervised],
            positive_mask[supervised],
            eligible_mask=eligible[supervised],
            row_weights=candidate_weights[supervised],
        )
        preferred_supervised = supervised & preferred.bool().any(dim=1)
        if bool(preferred_supervised.any()):
            preferred_loss = multi_positive_candidate_loss(
                torch,
                routed_scores[preferred_supervised],
                preferred[preferred_supervised],
                eligible_mask=eligible[preferred_supervised],
                row_weights=candidate_weights[preferred_supervised],
            )
            candidate_loss = 0.65 * preferred_loss + 0.35 * acceptable_loss
        else:
            preferred_loss = acceptable_loss
            candidate_loss = acceptable_loss
        distribution_target = torch.where(
            preferred.bool().any(dim=1, keepdim=True),
            preferred.bool(),
            positive_mask.bool(),
        )[supervised].float()
        distribution_target = distribution_target / distribution_target.sum(
            dim=1, keepdim=True
        ).clamp_min(1.0)
        distribution_scores = routed_scores[supervised].masked_fill(
            ~eligible[supervised], torch.finfo(routed_scores.dtype).min
        )
        distribution_prediction = torch.softmax(
            distribution_scores.float() / float(candidate_distribution_temperature),
            dim=1,
        )
        distribution_weights = candidate_weights[supervised, None]
        distribution_denominator = distribution_weights.sum().clamp_min(1e-6)
        predicted_share = (
            distribution_prediction * distribution_weights
        ).sum(dim=0) / distribution_denominator
        target_share = (
            distribution_target * distribution_weights
        ).sum(dim=0) / distribution_denominator
        distribution_excess = torch.relu(
            predicted_share - target_share - float(candidate_distribution_slack)
        )
        candidate_distribution = distribution_excess.square().sum()
    else:
        candidate_loss = routed_scores.sum() * 0.0
        acceptable_loss = candidate_loss
        preferred_loss = candidate_loss
        candidate_distribution = candidate_loss
    family_weights = (
        torch.ones(labels.shape, device=labels.device, dtype=torch.float32)
        if family_label_weights is None
        else family_label_weights.float()
    )
    if family_weights.shape != labels.shape or not bool(
        torch.isfinite(family_weights).all() & (family_weights > 0).all()
    ):
        raise MangaFontV8RoleFamilyError(
            "family label weights must be finite and positive"
        )
    counts = torch.bincount(
        labels, weights=family_weights, minlength=len(FAMILY_VALUES)
    ).float()
    class_weights = counts.sum() / counts.clamp_min(1.0)
    class_weights = class_weights / class_weights.mean()
    family_losses = torch.nn.functional.cross_entropy(
        outputs["family_logits"].float(),
        labels,
        weight=class_weights,
        reduction="none",
    )
    family_loss = (family_losses * family_weights).sum() / family_weights.sum()

    body_negative = (
        (labels == BODY_FAMILY_INDEX)
        & ~positive_mask[:, single_day_index].bool()
        if single_day_body_negative is None
        else single_day_body_negative.bool()
    )
    if body_negative.shape != labels.shape or not bool(
        (~body_negative | (labels == BODY_FAMILY_INDEX)).all()
    ) or bool((body_negative & positive_mask[:, single_day_index].bool()).any()):
        raise MangaFontV8RoleFamilyError(
            "Single Day negatives must be body rows without positive Single Day evidence"
        )
    supervised_single_day_negative = supervised & ~positive_mask[
        :, single_day_index
    ].bool()
    if bool(body_negative.any() or supervised_single_day_negative.any()):
        masked_positive = routed_scores.masked_fill(
            ~positive_mask.bool(), torch.finfo(routed_scores.dtype).min
        )
        best_positive = masked_positive.max(dim=1).values
        other_mask = torch.ones_like(positive_mask, dtype=torch.bool)
        other_mask[:, single_day_index] = False
        best_other = routed_scores.masked_fill(
            ~other_mask, torch.finfo(routed_scores.dtype).min
        ).max(dim=1).values
        reference = torch.where(supervised, best_positive, best_other)
        all_negative_losses = torch.relu(
            routed_scores[:, single_day_index]
            - reference
            + float(hard_negative_margin)
        )
        body_negative_losses = all_negative_losses[body_negative]
        body_negative_weights = family_weights[body_negative]
        hard_negative = (
            body_negative_losses * body_negative_weights
        ).sum() / body_negative_weights.sum().clamp_min(1e-6)
        body_best_positive = body_scores.masked_fill(
            ~positive_mask.bool(), torch.finfo(body_scores.dtype).min
        ).max(dim=1).values
        variant_best_positive = variant_scores.masked_fill(
            ~positive_mask.bool(), torch.finfo(variant_scores.dtype).min
        ).max(dim=1).values
        supervised_negative_losses = 0.5 * (
            torch.relu(
                body_scores[:, single_day_index]
                - body_best_positive
                + float(hard_negative_margin)
            )
            + torch.relu(
                variant_scores[:, single_day_index]
                - variant_best_positive
                + float(hard_negative_margin)
            )
        )
        supervised_negative_losses = supervised_negative_losses[
            supervised_single_day_negative
        ]
        supervised_negative_weights = candidate_weights[
            supervised_single_day_negative
        ]
        supervised_hard_negative = (
            supervised_negative_losses * supervised_negative_weights
        ).sum() / supervised_negative_weights.sum().clamp_min(1e-6)
    else:
        hard_negative = routed_scores.sum() * 0.0
        supervised_hard_negative = hard_negative

    bias_l2 = outputs["family_candidate_bias"].square().mean()
    sample_residual = outputs.get("sample_candidate_residual")
    sample_residual_l2 = (
        routed_scores.sum() * 0.0
        if sample_residual is None
        else sample_residual.square().mean()
    )
    total = (
        candidate_loss
        + float(family_weight) * family_loss
        + float(hard_negative_weight) * hard_negative
        + float(supervised_single_day_hard_negative_weight)
        * supervised_hard_negative
        + float(bias_l2_weight) * bias_l2
        + float(candidate_distribution_weight) * candidate_distribution
        + float(sample_residual_l2_weight) * sample_residual_l2
    )
    return total, {
        "bias_l2": bias_l2,
        "candidate": candidate_loss,
        "candidate_acceptable": acceptable_loss,
        "candidate_distribution_excess": candidate_distribution,
        "candidate_preferred": preferred_loss,
        "family": family_loss,
        "sample_residual_l2": sample_residual_l2,
        "single_day_supervised_hard_negative_rows": supervised_single_day_negative.sum(),
        "single_day_supervised_hard_negative": supervised_hard_negative,
        "single_day_body_hard_negative": hard_negative,
    }


def role_family_auxiliary_distillation_loss(
    torch: Any,
    outputs: Mapping[str, Any],
    *,
    family_labels: Any,
    target_probabilities: Any,
    distillation_weights: Any,
    single_day_negative: Any,
    specialist_single_day_positive: Any,
    single_day_index: int,
    anchor_probabilities: Mapping[str, Any] | None = None,
    temperature: float = 1.0,
    single_day_negative_margin: float = 0.25,
) -> Mapping[str, Any]:
    """Return bounded pseudo-KL, r3h anchor, and Single Day auxiliary losses.

    Pseudo rows remain soft evidence: zero-weight rows are excluded, reviewed
    masks are not consulted or replaced, and the caller supplies the small
    global coefficient.  Anchor probabilities are detached teacher outputs,
    never label authority.
    """

    labels = family_labels.long()
    body_scores = outputs["body_candidate_scores"].float()
    variant_scores = outputs["variant_candidate_scores"].float()
    family_logits = outputs["family_logits"].float()
    targets = target_probabilities.float()
    weights = distillation_weights.float()
    negative = single_day_negative.bool()
    positive = specialist_single_day_positive.bool()
    count, candidate_count = body_scores.shape
    if (
        variant_scores.shape != body_scores.shape
        or family_logits.shape != (count, len(FAMILY_VALUES))
        or labels.shape != (count,)
        or targets.shape != body_scores.shape
        or weights.shape != (count,)
        or negative.shape != (count,)
        or positive.shape != (count,)
        or not 0 <= single_day_index < candidate_count
        or not math.isfinite(float(temperature))
        or temperature <= 0.0
        or not math.isfinite(float(single_day_negative_margin))
        or single_day_negative_margin < 0.0
    ):
        raise MangaFontV8RoleFamilyError("auxiliary distillation shapes/options drifted")
    if not bool(
        torch.isfinite(targets).all()
        & torch.isfinite(weights).all()
        & (targets >= 0.0).all()
        & (weights >= 0.0).all()
    ) or not bool(torch.allclose(targets.sum(dim=1), torch.ones_like(weights), atol=2e-5)):
        raise MangaFontV8RoleFamilyError("auxiliary distillation probability simplex drifted")
    active = weights > 0.0
    if bool(((negative | positive) & ~active).any() | (negative & positive).any()):
        raise MangaFontV8RoleFamilyError("auxiliary Single Day masks escaped pseudo rows")
    routed_scores = torch.where(
        (labels == BODY_FAMILY_INDEX)[:, None], body_scores, variant_scores
    )
    zero = routed_scores.sum() * 0.0
    if bool(active.any()):
        active_targets = targets[active]
        active_log_prediction = torch.log_softmax(
            routed_scores[active] / float(temperature), dim=1
        )
        target_log = torch.log(active_targets.clamp_min(1e-12))
        row_kl = (
            active_targets * (target_log - active_log_prediction)
        ).sum(dim=1)
        active_weights = weights[active]
        pseudo_kl = (row_kl * active_weights).sum() / active_weights.sum().clamp_min(1e-6)
    else:
        pseudo_kl = zero

    other_mask = torch.ones_like(routed_scores, dtype=torch.bool)
    other_mask[:, single_day_index] = False
    best_routed_other = routed_scores.masked_fill(
        ~other_mask, torch.finfo(routed_scores.dtype).min
    ).max(dim=1).values
    if bool(negative.any()):
        row_negative = torch.relu(
            routed_scores[:, single_day_index]
            - best_routed_other
            + float(single_day_negative_margin)
        )[negative]
        negative_weights = weights[negative]
        pseudo_single_day_negative = (
            row_negative * negative_weights
        ).sum() / negative_weights.sum().clamp_min(1e-6)
    else:
        pseudo_single_day_negative = zero

    variant_other = variant_scores.masked_fill(
        ~other_mask, torch.finfo(variant_scores.dtype).min
    ).max(dim=1).values
    if bool(positive.any()):
        candidate_margin = torch.relu(
            variant_other
            + float(MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN)
            - variant_scores[:, single_day_index]
        )
        family_margin = torch.relu(
            family_logits[:, BODY_FAMILY_INDEX]
            - family_logits[:, VARIANT_FAMILY_INDEX]
            + math.log(
                MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE
                / (1.0 - MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE)
            )
        )
        row_positive = (candidate_margin + family_margin)[positive]
        positive_weights = weights[positive]
        pseudo_single_day_positive = (
            row_positive * positive_weights
        ).sum() / positive_weights.sum().clamp_min(1e-6)
    else:
        pseudo_single_day_positive = zero

    if anchor_probabilities is None:
        anchor_output = zero
    else:
        anchor_names = {
            "body_candidate_probabilities": body_scores,
            "variant_candidate_probabilities": variant_scores,
            "family_probabilities": family_logits,
        }
        anchor_parts: list[Any] = []
        for name, current_logits in anchor_names.items():
            target = anchor_probabilities.get(name)
            if target is None or target.shape != current_logits.shape or not bool(
                torch.isfinite(target).all()
                & (target >= 0.0).all()
                & torch.allclose(
                    target.sum(dim=1),
                    torch.ones(target.shape[0], device=target.device),
                    atol=2e-5,
                )
            ):
                raise MangaFontV8RoleFamilyError(
                    f"anchor probability contract drifted: {name}"
                )
            anchor_parts.append(
                torch.nn.functional.kl_div(
                    torch.log_softmax(current_logits, dim=1),
                    target.detach(),
                    reduction="batchmean",
                )
            )
        anchor_output = sum(anchor_parts) / len(anchor_parts)
    return {
        "anchor_output": anchor_output,
        "pseudo_kl": pseudo_kl,
        "pseudo_single_day_negative": pseudo_single_day_negative,
        "pseudo_single_day_positive": pseudo_single_day_positive,
    }


def parameter_anchor_loss(
    torch: Any, model: Any, anchor_state: Mapping[str, Any]
) -> Any:
    """Mean per-tensor L2 distance to a frozen initialization/anchor state."""

    parts: list[Any] = []
    for name, parameter in model.named_parameters():
        if not parameter.requires_grad:
            continue
        reference = anchor_state.get(name)
        if reference is None or reference.shape != parameter.shape:
            raise MangaFontV8RoleFamilyError(f"parameter anchor drifted: {name}")
        parts.append((parameter - reference.detach()).square().mean())
    if not parts:
        raise MangaFontV8RoleFamilyError("parameter anchor has no trainable tensors")
    return sum(parts) / len(parts)


def compute_metrics(
    torch: Any,
    outputs: Mapping[str, Any],
    *,
    family_labels: Any,
    positive_mask: Any,
    preferred_mask: Any | None = None,
    font_supervision_weights: Any | None = None,
    single_day_body_negative: Any | None = None,
    single_day_index: int,
    candidate_ids: Sequence[str] | None = None,
) -> Mapping[str, Any]:
    labels = family_labels.long()
    oracle_scores = torch.where(
        (labels == BODY_FAMILY_INDEX)[:, None],
        outputs["body_candidate_scores"],
        outputs["variant_candidate_scores"],
    )
    family_probabilities = torch.softmax(outputs["family_logits"].float(), dim=1)
    family_top1 = family_probabilities.argmax(dim=1)
    raw_deployed_scores = torch.where(
        (family_top1 == BODY_FAMILY_INDEX)[:, None],
        outputs["body_candidate_scores"],
        outputs["variant_candidate_scores"],
    )
    other_mask = torch.ones_like(raw_deployed_scores, dtype=torch.bool)
    other_mask[:, single_day_index] = False
    best_other = raw_deployed_scores.masked_fill(
        ~other_mask, torch.finfo(raw_deployed_scores.dtype).min
    ).max(dim=1).values
    single_day_raw_margin = (
        raw_deployed_scores[:, single_day_index] - best_other
    )
    single_day_allowed = (
        (family_top1 == VARIANT_FAMILY_INDEX)
        & (
            family_probabilities[:, VARIANT_FAMILY_INDEX]
            >= MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE
        )
        & (single_day_raw_margin >= MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN)
    )
    deployed_scores = raw_deployed_scores.clone()
    deployed_scores[:, single_day_index] = deployed_scores[
        :, single_day_index
    ].masked_fill(
        ~single_day_allowed, torch.finfo(deployed_scores.dtype).min
    )
    top1 = deployed_scores.argmax(dim=1)
    oracle_top1 = oracle_scores.argmax(dim=1)
    raw_top1 = raw_deployed_scores.argmax(dim=1)
    weights = (
        torch.ones(labels.shape, device=labels.device, dtype=torch.float32)
        if font_supervision_weights is None
        else font_supervision_weights.float()
    )
    supervised = weights > 0
    if not bool(supervised.any()):
        raise MangaFontV8RoleFamilyError("metrics require font-supervised rows")
    preferred = positive_mask if preferred_mask is None else preferred_mask
    preferred_supervised = supervised & preferred.bool().any(dim=1)
    if candidate_ids is not None and len(candidate_ids) != int(
        deployed_scores.shape[1]
    ):
        raise MangaFontV8RoleFamilyError("candidate IDs drifted during metrics")
    body_negative = (
        (labels == BODY_FAMILY_INDEX) & ~positive_mask[:, single_day_index].bool()
        if single_day_body_negative is None
        else single_day_body_negative.bool()
    )
    single_day_positive = supervised & positive_mask[:, single_day_index].bool()
    single_day_positive_count = int(single_day_positive.sum().item())

    def summarize(candidate_top1: Any) -> Mapping[str, Any]:
        hit = positive_mask.bool().gather(
            1, candidate_top1[:, None]
        ).squeeze(1)
        preferred_hit = preferred.bool().gather(
            1, candidate_top1[:, None]
        ).squeeze(1)
        supervised_top1 = candidate_top1[supervised]
        top1_counts = torch.bincount(
            supervised_top1, minlength=int(deployed_scores.shape[1])
        )
        distribution = {
            str(candidate_ids[index]) if candidate_ids is not None else str(index): int(count)
            for index, count in enumerate(top1_counts.tolist())
            if count
        }
        single_day_false = body_negative & (
            candidate_top1 == single_day_index
        )
        single_day_predicted = supervised & (
            candidate_top1 == single_day_index
        )
        single_day_true_positive = single_day_predicted & single_day_positive
        predicted_count = int(single_day_predicted.sum().item())
        return {
            "acceptable_at1": float(hit[supervised].float().mean().item()),
            "preferred_at1": float(
                preferred_hit[preferred_supervised].float().mean().item()
            ),
            "single_day_body_false_top1_count": int(
                single_day_false.sum().item()
            ),
            "single_day_body_false_top1_rate": float(
                single_day_false.sum().item()
                / max(1, int(body_negative.sum().item()))
            ),
            "single_day_positive_precision": float(
                single_day_true_positive.sum().item() / max(1, predicted_count)
            ),
            "single_day_positive_recall": float(
                single_day_true_positive.sum().item()
                / max(1, single_day_positive_count)
            ),
            "single_day_predicted_count": predicted_count,
            "top1_candidate_distribution": distribution,
            "top1_max_candidate_share": float(
                top1_counts.max().item()
                / max(1, int(supervised.sum().item()))
            ),
            "top1_unique_candidate_count": int(
                (top1_counts > 0).sum().item()
            ),
        }

    deployed = dict(summarize(top1))
    oracle = summarize(oracle_top1)
    raw = summarize(raw_top1)
    return {
        **deployed,
        "family_accuracy": float((family_top1 == labels).float().mean().item()),
        "font_supervised_rows": int(supervised.sum().item()),
        "preferred_supervised_rows": int(preferred_supervised.sum().item()),
        "rows": int(labels.numel()),
        "single_day_positive_count": single_day_positive_count,
        "single_day_eligibility": {
            "body_policy": "always_mask",
            "eligible_top1_all_rows": int((top1 == single_day_index).sum().item()),
            "eligible_top1_all_rows_rate": float(
                (top1 == single_day_index).sum().item()
                / max(1, int(labels.numel()))
            ),
            "family_confidence_threshold": MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE,
            "raw_margin_threshold": MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN,
            "raw_top1_all_rows": int((raw_top1 == single_day_index).sum().item()),
            "variant_gate_allowed_rows": int(single_day_allowed.sum().item()),
        },
        "oracle_route_diagnostic": oracle,
        "predicted_route_raw_diagnostic": raw,
        "routing_authority": "predicted_pixel_family_with_single_day_eligibility",
    }


def build_quality_gate_checks(
    metrics: Mapping[str, Any], visual_metrics: Mapping[str, Any]
) -> dict[str, bool]:
    """Require both the full routing cohort and visual holdout authority."""

    def single_day_precision_passed(values: Mapping[str, Any]) -> bool:
        return int(values["single_day_predicted_count"]) == 0 or float(
            values["single_day_positive_precision"]
        ) >= 0.80

    return {
        "acceptable_at1_at_least_0_65": float(metrics["acceptable_at1"]) >= 0.65,
        "family_accuracy_at_least_0_75": float(metrics["family_accuracy"]) >= 0.75,
        "preferred_at1_at_least_0_50": float(metrics["preferred_at1"]) >= 0.50,
        "single_day_body_false_top1_at_most_0_0025": float(
            metrics["single_day_body_false_top1_rate"]
        )
        <= 0.0025,
        "single_day_precision_at_least_0_80_or_no_predictions": (
            single_day_precision_passed(metrics)
        ),
        "single_day_all_rows_top1_rate_at_most_0_01": float(
            metrics["single_day_eligibility"]["eligible_top1_all_rows_rate"]
        )
        <= MAXIMUM_SINGLE_DAY_ALL_ROWS_TOP1_RATE,
        "top1_max_candidate_share_at_most_0_65": float(
            metrics["top1_max_candidate_share"]
        )
        <= 0.65,
        "visual_acceptable_at1_at_least_0_65": float(
            visual_metrics["acceptable_at1"]
        )
        >= 0.65,
        "visual_family_accuracy_at_least_0_75": float(
            visual_metrics["family_accuracy"]
        )
        >= 0.75,
        "visual_preferred_at1_at_least_0_50": float(
            visual_metrics["preferred_at1"]
        )
        >= 0.50,
        "visual_single_day_body_false_top1_at_most_0_0025": float(
            visual_metrics["single_day_body_false_top1_rate"]
        )
        <= 0.0025,
        "visual_single_day_precision_at_least_0_80_or_no_predictions": (
            single_day_precision_passed(visual_metrics)
        ),
        "visual_top1_max_candidate_share_at_most_0_65": float(
            visual_metrics["top1_max_candidate_share"]
        )
        <= 0.65,
    }


def validate_training_arrays(
    arrays: Mapping[str, np.ndarray], *, candidate_count: int
) -> Mapping[str, Any]:
    required = {
        "candidate_eligible_mask",
        "candidate_ids",
        "family_label_weights",
        "family_labels",
        "font_authority",
        "font_supervision_weights",
        "positive_mask",
        "preferred_mask",
        "prototype_queries",
        "query_views",
        "sample_ids",
        "single_day_body_negative",
        "split",
        "work_ids",
    }
    if set(arrays) != required:
        raise MangaFontV8RoleFamilyError(
            f"training NPZ inventory drifted: {sorted(set(arrays) ^ required)}"
        )
    count = int(arrays["query_views"].shape[0])
    if count < 4:
        raise MangaFontV8RoleFamilyError("training NPZ needs at least four rows")
    if arrays["query_views"].shape[1:] != (3, QUERY_COUNT, QUERY_DIM):
        raise MangaFontV8RoleFamilyError("query_views shape must be [N,3,4,256]")
    if arrays["prototype_queries"].shape != (
        candidate_count,
        QUERY_COUNT,
        QUERY_DIM,
    ):
        raise MangaFontV8RoleFamilyError("prototype_queries shape drifted")
    for name in ("candidate_eligible_mask", "positive_mask", "preferred_mask"):
        if arrays[name].shape != (count, candidate_count):
            raise MangaFontV8RoleFamilyError(f"{name} shape drifted")
    for name in (
        "family_labels",
        "family_label_weights",
        "font_authority",
        "font_supervision_weights",
        "sample_ids",
        "single_day_body_negative",
        "split",
        "work_ids",
    ):
        if arrays[name].shape != (count,):
            raise MangaFontV8RoleFamilyError(f"{name} shape drifted")
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    if (
        len(candidate_ids) != candidate_count
        or len(set(candidate_ids)) != candidate_count
        or "single-day" not in candidate_ids
    ):
        raise MangaFontV8RoleFamilyError("candidate IDs are incomplete or duplicated")
    labels = arrays["family_labels"].astype(np.int64, copy=False)
    if not np.isin(labels, (BODY_FAMILY_INDEX, VARIANT_FAMILY_INDEX)).all():
        raise MangaFontV8RoleFamilyError("family labels must be 0 or 1")
    split = arrays["split"].astype(np.int64, copy=False)
    if not np.isin(split, (0, 1)).all() or not {0, 1} <= set(split.tolist()):
        raise MangaFontV8RoleFamilyError("split must contain train=0 and val=1")
    positives = arrays["positive_mask"].astype(bool, copy=False)
    preferred = arrays["preferred_mask"].astype(bool, copy=False)
    eligible = arrays["candidate_eligible_mask"].astype(bool, copy=False)
    family_weights = arrays["family_label_weights"].astype(np.float32, copy=False)
    font_weights = arrays["font_supervision_weights"].astype(
        np.float32, copy=False
    )
    if (
        not np.isfinite(family_weights).all()
        or np.any(family_weights <= 0.0)
        or np.any(family_weights > 1.0)
        or not np.isfinite(font_weights).all()
        or np.any(font_weights < 0.0)
        or np.any(font_weights > 1.0)
    ):
        raise MangaFontV8RoleFamilyError("supervision weights escaped [0,1]")
    supervised = font_weights > 0.0
    if not supervised.any() or not supervised[split == 0].any() or not supervised[
        split == 1
    ].any():
        raise MangaFontV8RoleFamilyError(
            "train and val each need font-supervised rows"
        )
    if (
        not positives[supervised].any(axis=1).all()
        or not eligible[supervised].any(axis=1).all()
        or positives[~supervised].any()
        or preferred[~supervised].any()
        or eligible[~supervised].any()
    ):
        raise MangaFontV8RoleFamilyError(
            "candidate masks do not match font-supervision weights"
        )
    if np.any(preferred & ~positives) or np.any(positives & ~eligible):
        raise MangaFontV8RoleFamilyError(
            "preferred/positive candidates escaped reviewed eligibility"
        )
    authorities = np.asarray(
        [str(value) for value in arrays["font_authority"].tolist()]
    )
    if not np.isin(authorities, ("none", "human", "visual")).all() or not np.array_equal(
        authorities != "none", supervised
    ):
        raise MangaFontV8RoleFamilyError(
            "font authority must exactly track supervised rows"
        )
    single_day_index = candidate_ids.index("single-day")
    single_day_negative = arrays["single_day_body_negative"].astype(
        bool, copy=False
    )
    if np.any(single_day_negative & (labels != BODY_FAMILY_INDEX)) or np.any(
        single_day_negative & positives[:, single_day_index]
    ):
        raise MangaFontV8RoleFamilyError(
            "Single Day hard negatives escaped ordinary body rows"
        )
    if not np.isfinite(arrays["query_views"]).all() or not np.isfinite(
        arrays["prototype_queries"]
    ).all():
        raise MangaFontV8RoleFamilyError("query embeddings must be finite")
    train_works = set(str(value) for value in arrays["work_ids"][split == 0])
    val_works = set(str(value) for value in arrays["work_ids"][split == 1])
    if train_works & val_works:
        raise MangaFontV8RoleFamilyError("train/val work IDs overlap")
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    if len(set(sample_ids)) != count:
        raise MangaFontV8RoleFamilyError("sample IDs are duplicated")
    return {
        "authority_counts": {
            value: int((authorities == value).sum())
            for value in ("none", "human", "visual")
        },
        "candidate_ids": candidate_ids,
        "dataset_schema_version": DATASET_SCHEMA_VERSION,
        "family_body_rows": int((labels == BODY_FAMILY_INDEX).sum()),
        "family_variant_rows": int((labels == VARIANT_FAMILY_INDEX).sum()),
        "font_supervised_rows": int(supervised.sum()),
        "row_count": count,
        "single_day_body_negative_rows": int(single_day_negative.sum()),
        "train_rows": int((split == 0).sum()),
        "val_rows": int((split == 1).sum()),
        "train_work_count": len(train_works),
        "val_work_count": len(val_works),
    }


def build_candidate_training_weights(
    arrays: Mapping[str, np.ndarray],
    *,
    rare_class_cap: float = 3.0,
    human_multiplier: float = 1.0,
    focus_candidate_ids: Sequence[str] = (),
    focus_multiplier: float = 1.0,
) -> tuple[np.ndarray, Mapping[str, Any]]:
    """Balance visual classes and optionally emphasize sealed train authority."""

    if not math.isfinite(rare_class_cap) or rare_class_cap < 1.0:
        raise MangaFontV8RoleFamilyError("rare_class_cap must be finite and >= 1")
    if not math.isfinite(human_multiplier) or human_multiplier < 1.0:
        raise MangaFontV8RoleFamilyError("human_multiplier must be finite and >= 1")
    if not math.isfinite(focus_multiplier) or focus_multiplier < 1.0:
        raise MangaFontV8RoleFamilyError("focus_multiplier must be finite and >= 1")
    base = arrays["font_supervision_weights"].astype(np.float32, copy=True)
    split = arrays["split"].astype(np.int64, copy=False)
    authorities = arrays["font_authority"].astype(str, copy=False)
    preferred = arrays["preferred_mask"].astype(bool, copy=False)
    positives = arrays["positive_mask"].astype(bool, copy=False)
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    focus_ids = tuple(dict.fromkeys(str(value) for value in focus_candidate_ids))
    unknown_focus = set(focus_ids) - set(candidate_ids)
    if unknown_focus:
        raise MangaFontV8RoleFamilyError(
            f"focus candidates are absent: {sorted(unknown_focus)}"
        )
    visual = (split == 0) & (authorities == "visual") & (base > 0)
    human = (split == 0) & (authorities == "human") & (base > 0)
    targets = np.where(preferred.any(axis=1, keepdims=True), preferred, positives)
    visual_targets = targets[visual].astype(np.float64, copy=False)
    if not visual_targets.shape[0]:
        raise MangaFontV8RoleFamilyError(
            "inverse-frequency weighting needs visual train supervision"
        )
    visual_targets /= np.maximum(1.0, visual_targets.sum(axis=1, keepdims=True))
    frequency = visual_targets.sum(axis=0)
    positive_frequency = frequency[frequency > 0]
    if not positive_frequency.size:
        raise MangaFontV8RoleFamilyError("visual preferred frequency is empty")
    maximum_frequency = float(positive_frequency.max())
    class_factor = np.ones(frequency.shape, dtype=np.float64)
    present = frequency > 0
    class_factor[present] = np.sqrt(maximum_frequency / frequency[present])
    class_factor = np.clip(class_factor, 1.0, float(rare_class_cap))
    row_factor = (visual_targets * class_factor[None, :]).sum(axis=1)
    visual_base = base[visual].astype(np.float64, copy=False)
    normalizer = float(
        (row_factor * visual_base).sum() / max(1e-9, visual_base.sum())
    )
    row_factor = np.clip(
        row_factor / max(1e-9, normalizer),
        1.0 / float(rare_class_cap),
        float(rare_class_cap),
    )
    base[visual] *= row_factor.astype(np.float32)
    base[human] *= float(human_multiplier)
    focus_rows = np.zeros(base.shape, dtype=bool)
    if focus_ids:
        focus_indices = [candidate_ids.index(value) for value in focus_ids]
        focus_rows = (
            (split == 0)
            & np.isin(authorities, ("human", "visual"))
            & targets[:, focus_indices].any(axis=1)
        )
        base[focus_rows] *= float(focus_multiplier)
    if not np.isfinite(base).all() or np.any(base < 0) or not np.array_equal(
        base > 0, arrays["font_supervision_weights"] > 0
    ):
        raise MangaFontV8RoleFamilyError("derived candidate row weights are invalid")
    return base, {
        "focus_candidate_ids": list(focus_ids),
        "focus_multiplier": float(focus_multiplier),
        "focus_train_rows": int(focus_rows.sum()),
        "human_multiplier": float(human_multiplier),
        "human_train_rows": int(human.sum()),
        "human_train_rows_unchanged": (
            int(human.sum())
            if human_multiplier == 1.0 and not bool((focus_rows & human).any())
            else 0
        ),
        "rare_class_cap": float(rare_class_cap),
        "visual_class_frequency": [float(value) for value in frequency.tolist()],
        "visual_row_factor_max": float(row_factor.max()),
        "visual_row_factor_mean": float(row_factor.mean()),
        "visual_row_factor_min": float(row_factor.min()),
        "visual_train_rows": int(visual.sum()),
    }


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontV8RoleFamilyError(f"unsafe output directory: {result}")
    return result


def _load_initial_head(path: Path) -> tuple[np.ndarray, float]:
    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV8RoleFamilyError("safetensors is required") from error
    state = load_file(str(path.expanduser().resolve()))
    if set(state) < {"query_weight_logits", "logit_scale"}:
        raise MangaFontV8RoleFamilyError("source query head lacks ranker parameters")
    weights = np.asarray(state["query_weight_logits"], dtype=np.float32)
    scale = np.asarray(state["logit_scale"], dtype=np.float32)
    if weights.shape != (QUERY_COUNT,) or scale.size != 1:
        raise MangaFontV8RoleFamilyError("source query head parameter shape drifted")
    return weights, float(scale.reshape(()))


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MangaFontV8RoleFamilyError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise MangaFontV8RoleFamilyError(f"{location}: expected object")
    return value


def load_initial_adapter_state(
    initial_adapter_dir: Path,
    *,
    candidate_ids: Sequence[str],
    source_query_head: Path,
    expected_architecture: Mapping[str, Any],
    expected_state: Mapping[str, Any],
) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    """Validate and load an adapter strictly as initialization, never authority."""

    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV8RoleFamilyError("safetensors is required") from error
    root = initial_adapter_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != OUTPUT_FILES
    ):
        raise MangaFontV8RoleFamilyError("initial adapter exact inventory drifted")
    marker_path = root / MARKER_FILE
    manifest_path = root / MANIFEST_FILE
    checkpoint_path = root / CHECKPOINT_FILE
    marker = _read_json(marker_path, "initial adapter marker")
    manifest = _read_json(manifest_path, "initial adapter manifest")
    validate_record_seal(marker, "initial adapter marker")
    validate_record_seal(manifest, "initial adapter manifest")
    artifacts = marker.get("artifacts")
    files = manifest.get("files")
    architecture = manifest.get("architecture")
    source = manifest.get("source_query_head")
    checkpoint = files.get(CHECKPOINT_FILE) if isinstance(files, Mapping) else None
    source_head = source_query_head.expanduser().resolve()
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_student_v8_role_family_adapter_manifest"
        or not isinstance(artifacts, Mapping)
        or set(artifacts) != {CHECKPOINT_FILE, MANIFEST_FILE}
        or artifacts.get(CHECKPOINT_FILE) != sha256_file(checkpoint_path)
        or artifacts.get(MANIFEST_FILE) != sha256_file(manifest_path)
        or not isinstance(checkpoint, Mapping)
        or checkpoint.get("byte_size") != checkpoint_path.stat().st_size
        or checkpoint.get("sha256") != sha256_file(checkpoint_path)
        or tuple(str(value) for value in manifest.get("candidate_ids", ()))
        != tuple(candidate_ids)
        or architecture != expected_architecture
        or not isinstance(source, Mapping)
        or source.get("sha256") != sha256_file(source_head)
        or not isinstance(manifest.get("quality_gate"), Mapping)
        or manifest["quality_gate"].get("passed") is not True
    ):
        raise MangaFontV8RoleFamilyError("initial adapter contract drifted")
    state = {
        name: np.asarray(value)
        for name, value in load_file(str(checkpoint_path)).items()
    }
    if set(state) != set(expected_state):
        raise MangaFontV8RoleFamilyError("initial adapter checkpoint keys drifted")
    for name, reference in expected_state.items():
        value = state[name]
        # Older interpolation bundles serialized scalar logit-scale tensors as
        # a one-element vector.  PyTorch loads this legacy scalar form safely;
        # normalize it explicitly while keeping every non-scalar shape strict.
        if tuple(reference.shape) == () and tuple(value.shape) == (1,):
            value = value.reshape(())
            state[name] = value
        if tuple(value.shape) != tuple(reference.shape) or not np.isfinite(value).all():
            raise MangaFontV8RoleFamilyError(
                f"initial adapter checkpoint tensor drifted: {name}"
            )
    return state, {
        "authority": {
            "calibration_authority": False,
            "evaluation_authority": False,
            "release_authority": False,
            "training_label_authority": False,
            "weight_initialization_only": True,
        },
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(manifest_path),
        "output_dir": str(root),
        "schema_version": SCHEMA_VERSION,
        "source_query_head_sha256": sha256_file(source_head),
    }


def initialize_adapter_from_artifact(
    torch: Any,
    model: Any,
    initial_adapter_dir: Path | None,
    *,
    candidate_ids: Sequence[str],
    source_query_head: Path,
    expected_architecture: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    if initial_adapter_dir is None:
        return None
    expected_state = model.state_dict()
    arrays, binding = load_initial_adapter_state(
        initial_adapter_dir,
        candidate_ids=candidate_ids,
        source_query_head=source_query_head,
        expected_architecture=expected_architecture,
        expected_state=expected_state,
    )
    state = {
        name: torch.from_numpy(np.array(value, copy=True)).to(
            dtype=expected_state[name].dtype
        )
        for name, value in arrays.items()
    }
    try:
        model.load_state_dict(state, strict=True)
    except (RuntimeError, ValueError) as error:
        raise MangaFontV8RoleFamilyError(
            "initial adapter checkpoint reconstruction failed"
        ) from error
    return binding


def optimizer_parameter_groups(
    model: Any,
    *,
    learning_rate: float,
    trainable_scope: str,
    candidate_parameter_lr_multiplier: float,
) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    """Separate family routing from candidate-ranker updates."""

    if trainable_scope not in {"all", "family-head-only"}:
        raise MangaFontV8RoleFamilyError("unsupported trainable scope")
    family_prefixes = ("family_head.", "family_norm.")
    family: list[Any] = []
    candidate: list[Any] = []
    family_names: list[str] = []
    candidate_names: list[str] = []
    for name, parameter in model.named_parameters():
        is_family = name.startswith(family_prefixes)
        trainable = is_family or (
            trainable_scope == "all" and candidate_parameter_lr_multiplier > 0.0
        )
        parameter.requires_grad_(trainable)
        if not trainable:
            continue
        if is_family:
            family.append(parameter)
            family_names.append(name)
        else:
            candidate.append(parameter)
            candidate_names.append(name)
    if not family:
        raise MangaFontV8RoleFamilyError("family-head parameter group is empty")
    groups: list[dict[str, Any]] = [{"params": family, "lr": learning_rate}]
    if candidate:
        groups.append(
            {
                "params": candidate,
                "lr": learning_rate * candidate_parameter_lr_multiplier,
            }
        )
    return groups, {
        "candidate_parameter_count": sum(value.numel() for value in candidate),
        "candidate_parameter_lr_multiplier": candidate_parameter_lr_multiplier,
        "candidate_parameter_names": candidate_names,
        "family_parameter_count": sum(value.numel() for value in family),
        "family_parameter_names": family_names,
        "trainable_scope": trainable_scope,
    }


def _load_training_npz(path: Path) -> tuple[Path, dict[str, np.ndarray], Mapping[str, Any]]:
    dataset_path = path.expanduser().resolve()
    if dataset_path.is_symlink() or not dataset_path.is_file():
        raise MangaFontV8RoleFamilyError("training NPZ is missing or linked")
    try:
        with np.load(dataset_path, allow_pickle=False) as source:
            arrays = {name: np.array(source[name], copy=True) for name in source.files}
    except (OSError, ValueError) as error:
        raise MangaFontV8RoleFamilyError("training NPZ could not be loaded") from error
    candidate_count = int(arrays.get("candidate_ids", np.empty(0)).shape[0])
    inventory = validate_training_arrays(arrays, candidate_count=candidate_count)
    return dataset_path, arrays, inventory


def _load_distillation_bundle(
    root: Path,
    *,
    arrays: Mapping[str, np.ndarray],
    candidate_ids: Sequence[str],
) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    try:
        from scripts import build_manga_font_v8_r2_distillation_bundle as bundle
    except ImportError:  # pragma: no cover - direct execution from scripts/
        import build_manga_font_v8_r2_distillation_bundle as bundle

    resolved = root.expanduser().resolve()
    validation = bundle.validate_output(resolved)
    with np.load(resolved / bundle.TARGET_FILE, allow_pickle=False) as source:
        targets = {name: np.array(source[name], copy=True) for name in source.files}
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    target_ids = tuple(str(value) for value in targets["sample_ids"].tolist())
    target_candidates = tuple(
        str(value) for value in targets["candidate_ids"].tolist()
    )
    weights = targets["distillation_weights"].astype(np.float32, copy=False)
    split = arrays["split"].astype(np.int64, copy=False)
    authority = np.asarray(
        [str(value) for value in arrays["font_authority"].tolist()]
    )
    if (
        target_ids != sample_ids
        or target_candidates != tuple(candidate_ids)
        or weights.shape != (len(sample_ids),)
        or np.any((weights > 0.0) & ((split != 0) | (authority != "none")))
        or int(np.sum(weights > 0.0))
        != int(validation.get("distillation_rows", -1))
    ):
        raise MangaFontV8RoleFamilyError(
            "distillation bundle/dataset authority binding drifted"
        )
    return targets, {
        "archive_sha256": sha256_file(resolved / bundle.TARGET_FILE),
        "manifest_sha256": sha256_file(resolved / bundle.MANIFEST_FILE),
        "output_dir": str(resolved),
        "report_sha256": sha256_file(resolved / bundle.REPORT_FILE),
        "validation": dict(validation),
    }


def _anchor_probabilities(
    torch: Any,
    model: Any,
    *,
    query_views: Any,
    prototypes: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    if batch_size < 1:
        raise MangaFontV8RoleFamilyError("anchor batch size must be positive")
    collected: dict[str, list[Any]] = {
        "body_candidate_probabilities": [],
        "variant_candidate_probabilities": [],
        "family_probabilities": [],
    }
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(query_views), batch_size):
            outputs = model(query_views[start : start + batch_size], prototypes)
            collected["body_candidate_probabilities"].append(
                torch.softmax(outputs["body_candidate_scores"].float(), dim=1)
            )
            collected["variant_candidate_probabilities"].append(
                torch.softmax(outputs["variant_candidate_scores"].float(), dim=1)
            )
            collected["family_probabilities"].append(
                torch.softmax(outputs["family_logits"].float(), dim=1)
            )
    return {
        name: torch.cat(parts, dim=0).detach()
        for name, parts in collected.items()
    }


def preflight_adapter(args: argparse.Namespace) -> Mapping[str, Any]:
    """Validate the sealed array boundary and execute one CPU loss pass."""

    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV8RoleFamilyError("PyTorch is required") from error
    dataset_path, arrays, inventory = _load_training_npz(args.dataset_npz)
    candidate_ids = tuple(inventory["candidate_ids"])
    initial_weights, initial_scale = _load_initial_head(args.source_query_head)
    architecture = adapter_architecture_contract(
        candidate_count=len(candidate_ids),
        maximum_family_bias=args.maximum_family_bias,
        candidate_residual_hidden_dim=args.candidate_residual_hidden_dim,
        maximum_sample_residual=args.maximum_sample_residual,
    )
    model = build_role_family_adapter(
        torch,
        candidate_count=len(candidate_ids),
        initial_query_weight_logits=initial_weights,
        initial_logit_scale=initial_scale,
        maximum_family_bias=args.maximum_family_bias,
        candidate_residual_hidden_dim=args.candidate_residual_hidden_dim,
        maximum_sample_residual=args.maximum_sample_residual,
    ).eval()
    initialization = initialize_adapter_from_artifact(
        torch,
        model,
        args.initial_adapter_dir,
        candidate_ids=candidate_ids,
        source_query_head=args.source_query_head,
        expected_architecture=architecture,
    )
    split = arrays["split"].astype(np.int64, copy=False)
    supervised = arrays["font_supervision_weights"] > 0
    negative = arrays["single_day_body_negative"].astype(bool, copy=False)
    selected: list[int] = list(np.flatnonzero(split == 0)[:16])
    for mask in (supervised & (split == 0), supervised & (split == 1), negative):
        values = np.flatnonzero(mask)
        if values.size:
            selected.append(int(values[0]))
    indices = np.asarray(sorted(set(selected)), dtype=np.int64)
    with torch.inference_mode():
        outputs = model(
            torch.from_numpy(
                arrays["query_views"][indices].astype(np.float32, copy=False)
            ),
            torch.from_numpy(
                arrays["prototype_queries"].astype(np.float32, copy=False)
            ),
        )
        loss, parts = role_family_training_loss(
            torch,
            outputs,
            family_labels=torch.from_numpy(
                arrays["family_labels"][indices].astype(np.int64, copy=False)
            ),
            positive_mask=torch.from_numpy(
                arrays["positive_mask"][indices].astype(np.bool_, copy=False)
            ),
            preferred_mask=torch.from_numpy(
                arrays["preferred_mask"][indices].astype(np.bool_, copy=False)
            ),
            candidate_eligible_mask=torch.from_numpy(
                arrays["candidate_eligible_mask"][indices].astype(
                    np.bool_, copy=False
                )
            ),
            font_supervision_weights=torch.from_numpy(
                arrays["font_supervision_weights"][indices].astype(
                    np.float32, copy=False
                )
            ),
            family_label_weights=torch.from_numpy(
                arrays["family_label_weights"][indices].astype(
                    np.float32, copy=False
                )
            ),
            single_day_body_negative=torch.from_numpy(
                arrays["single_day_body_negative"][indices].astype(
                    np.bool_, copy=False
                )
            ),
            single_day_index=candidate_ids.index("single-day"),
        )
    if not math.isfinite(float(loss)) or any(
        not math.isfinite(float(value)) for value in parts.values()
    ):
        raise MangaFontV8RoleFamilyError("preflight loss produced non-finite values")
    return {
        **{key: value for key, value in inventory.items() if key != "candidate_ids"},
        "candidate_ids": list(candidate_ids),
        "dataset_npz": str(dataset_path),
        "dataset_sha256": sha256_file(dataset_path),
        "preflight_loss": float(loss),
        "preflight_rows": int(indices.size),
        "initialization": initialization,
        "source_query_head_sha256": sha256_file(
            args.source_query_head.expanduser().resolve()
        ),
        "status": "ready_for_v8_role_family_adapter_training",
    }


def train_adapter(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV8RoleFamilyError("torch and safetensors are required") from error

    dataset_path, arrays, inventory = _load_training_npz(args.dataset_npz)
    candidate_count = len(inventory["candidate_ids"])
    candidate_ids = inventory["candidate_ids"]
    if "single-day" not in candidate_ids:
        raise MangaFontV8RoleFamilyError("active candidate set must contain single-day")
    single_day_index = candidate_ids.index("single-day")
    focus_candidate_ids = tuple(
        value.strip()
        for value in args.focus_candidate_ids.split(",")
        if value.strip()
    )
    candidate_weight_values, candidate_weighting = build_candidate_training_weights(
        arrays,
        rare_class_cap=args.rare_class_weight_cap,
        human_multiplier=args.human_candidate_weight_multiplier,
        focus_candidate_ids=focus_candidate_ids,
        focus_multiplier=args.focus_candidate_weight_multiplier,
    )
    initial_weights, initial_scale = _load_initial_head(args.source_query_head)
    architecture = adapter_architecture_contract(
        candidate_count=candidate_count,
        maximum_family_bias=args.maximum_family_bias,
        candidate_residual_hidden_dim=args.candidate_residual_hidden_dim,
        maximum_sample_residual=args.maximum_sample_residual,
    )

    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise MangaFontV8RoleFamilyError("CUDA was requested but is unavailable")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    model = build_role_family_adapter(
        torch,
        candidate_count=candidate_count,
        initial_query_weight_logits=initial_weights,
        initial_logit_scale=initial_scale,
        maximum_family_bias=args.maximum_family_bias,
        candidate_residual_hidden_dim=args.candidate_residual_hidden_dim,
        maximum_sample_residual=args.maximum_sample_residual,
    ).to(device)
    initialization = initialize_adapter_from_artifact(
        torch,
        model,
        args.initial_adapter_dir,
        candidate_ids=candidate_ids,
        source_query_head=args.source_query_head,
        expected_architecture=architecture,
    )
    distillation_arrays: dict[str, np.ndarray] | None = None
    distillation_binding: Mapping[str, Any] | None = None
    if args.pseudo_distillation_dir is not None:
        distillation_arrays, distillation_binding = _load_distillation_bundle(
            args.pseudo_distillation_dir,
            arrays=arrays,
            candidate_ids=candidate_ids,
        )
    anchor_model: Any | None = None
    anchor_binding: Mapping[str, Any] | None = None
    if args.anchor_adapter_dir is not None:
        anchor_model = build_role_family_adapter(
            torch,
            candidate_count=candidate_count,
            initial_query_weight_logits=initial_weights,
            initial_logit_scale=initial_scale,
            maximum_family_bias=args.maximum_family_bias,
            candidate_residual_hidden_dim=args.candidate_residual_hidden_dim,
            maximum_sample_residual=args.maximum_sample_residual,
        ).to(device)
        anchor_binding = initialize_adapter_from_artifact(
            torch,
            anchor_model,
            args.anchor_adapter_dir,
            candidate_ids=candidate_ids,
            source_query_head=args.source_query_head,
            expected_architecture=architecture,
        )
        anchor_model.requires_grad_(False).eval()
    parameter_groups, trainable_parameters = optimizer_parameter_groups(
        model,
        learning_rate=args.learning_rate,
        trainable_scope=args.trainable_scope,
        candidate_parameter_lr_multiplier=args.candidate_parameter_lr_multiplier,
    )
    optimizer = torch.optim.AdamW(
        parameter_groups, weight_decay=args.weight_decay
    )
    query_views = torch.from_numpy(
        arrays["query_views"].astype(np.float32, copy=False)
    ).to(device)
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    anchor_outputs: Mapping[str, Any] | None = None
    anchor_state: Mapping[str, Any] | None = None
    if anchor_model is not None:
        anchor_outputs = _anchor_probabilities(
            torch,
            anchor_model,
            query_views=query_views,
            prototypes=prototypes,
            batch_size=args.anchor_batch_size,
        )
        anchor_state = {
            name: value.detach().clone()
            for name, value in anchor_model.state_dict().items()
        }
        del anchor_model
    positives = torch.from_numpy(
        arrays["positive_mask"].astype(np.bool_, copy=False)
    ).to(device)
    preferred = torch.from_numpy(
        arrays["preferred_mask"].astype(np.bool_, copy=False)
    ).to(device)
    eligible = torch.from_numpy(
        arrays["candidate_eligible_mask"].astype(np.bool_, copy=False)
    ).to(device)
    family_weight_values = arrays["family_label_weights"].astype(
        np.float32, copy=True
    )
    train_human_family = (
        (arrays["split"].astype(np.int64, copy=False) == 0)
        & (arrays["font_authority"].astype(str, copy=False) == "human")
    )
    family_weight_values[train_human_family] *= float(
        args.human_family_weight_multiplier
    )
    family_weights = torch.from_numpy(family_weight_values).to(device)
    font_weights = torch.from_numpy(
        arrays["font_supervision_weights"].astype(np.float32, copy=False)
    ).to(device)
    candidate_weights = torch.from_numpy(candidate_weight_values).to(device)
    single_day_negative = torch.from_numpy(
        arrays["single_day_body_negative"].astype(np.bool_, copy=False)
    ).to(device)
    labels = torch.from_numpy(
        arrays["family_labels"].astype(np.int64, copy=False)
    ).to(device)
    distillation_targets: Any | None = None
    distillation_weights: Any | None = None
    pseudo_single_day_negative: Any | None = None
    pseudo_single_day_positive: Any | None = None
    if distillation_arrays is not None:
        distillation_targets = torch.from_numpy(
            distillation_arrays["target_probabilities"].astype(
                np.float32, copy=False
            )
        ).to(device)
        distillation_weights = torch.from_numpy(
            distillation_arrays["distillation_weights"].astype(
                np.float32, copy=False
            )
        ).to(device)
        pseudo_single_day_negative = torch.from_numpy(
            distillation_arrays["single_day_negative"].astype(
                np.bool_, copy=False
            )
        ).to(device)
        pseudo_single_day_positive = torch.from_numpy(
            distillation_arrays["specialist_single_day_positive"].astype(
                np.bool_, copy=False
            )
        ).to(device)
    split = arrays["split"].astype(np.int64, copy=False)
    train_indices = np.flatnonzero(split == 0)
    val_indices = np.flatnonzero(split == 1)
    val_authorities = np.asarray(arrays["font_authority"])[val_indices]
    best_state: dict[str, Any] | None = None
    best_key: tuple[float, ...] | None = None
    best_epoch: Mapping[str, Any] | None = None
    history: list[Mapping[str, Any]] = []
    started = time.monotonic()
    generator = np.random.default_rng(args.seed)
    for epoch in range(1, args.epochs + 1):
        model.train()
        shuffled = generator.permutation(train_indices)
        epoch_losses: list[float] = []
        epoch_auxiliary: dict[str, list[float]] = {
            "anchor_output": [],
            "anchor_parameter": [],
            "pseudo_kl": [],
            "pseudo_single_day_negative": [],
            "pseudo_single_day_positive": [],
        }
        for start in range(0, len(shuffled), args.batch_size):
            indices = torch.as_tensor(
                shuffled[start : start + args.batch_size],
                dtype=torch.long,
                device=device,
            )
            optimizer.zero_grad(set_to_none=True)
            outputs = model(query_views[indices], prototypes)
            loss, _parts = role_family_training_loss(
                torch,
                outputs,
                family_labels=labels[indices],
                positive_mask=positives[indices],
                preferred_mask=preferred[indices],
                candidate_eligible_mask=eligible[indices],
                font_supervision_weights=font_weights[indices],
                candidate_loss_weights=candidate_weights[indices],
                family_label_weights=family_weights[indices],
                single_day_body_negative=single_day_negative[indices],
                single_day_index=single_day_index,
                family_weight=args.family_weight,
                hard_negative_weight=args.single_day_hard_negative_weight,
                hard_negative_margin=args.single_day_hard_negative_margin,
                bias_l2_weight=args.bias_l2_weight,
                candidate_distribution_weight=args.candidate_distribution_weight,
                candidate_distribution_slack=args.candidate_distribution_slack,
                candidate_distribution_temperature=args.candidate_distribution_temperature,
                sample_residual_l2_weight=args.sample_residual_l2_weight,
                supervised_single_day_hard_negative_weight=(
                    args.supervised_single_day_hard_negative_weight
                ),
            )
            if distillation_targets is not None:
                if (
                    distillation_weights is None
                    or pseudo_single_day_negative is None
                    or pseudo_single_day_positive is None
                ):
                    raise MangaFontV8RoleFamilyError(
                        "distillation tensors were only partially loaded"
                    )
                anchor_batch = (
                    None
                    if anchor_outputs is None
                    else {
                        name: value[indices]
                        for name, value in anchor_outputs.items()
                    }
                )
                auxiliary = role_family_auxiliary_distillation_loss(
                    torch,
                    outputs,
                    family_labels=labels[indices],
                    target_probabilities=distillation_targets[indices],
                    distillation_weights=distillation_weights[indices],
                    single_day_negative=pseudo_single_day_negative[indices],
                    specialist_single_day_positive=pseudo_single_day_positive[
                        indices
                    ],
                    single_day_index=single_day_index,
                    anchor_probabilities=anchor_batch,
                    temperature=args.pseudo_distillation_temperature,
                    single_day_negative_margin=(
                        args.pseudo_single_day_negative_margin
                    ),
                )
                if anchor_state is None:
                    raise MangaFontV8RoleFamilyError(
                        "distillation requires an anchor adapter"
                    )
                anchor_parameter = parameter_anchor_loss(
                    torch, model, anchor_state
                )
                loss = (
                    loss
                    + float(args.pseudo_distillation_weight)
                    * auxiliary["pseudo_kl"]
                    + float(args.anchor_output_weight)
                    * auxiliary["anchor_output"]
                    + float(args.anchor_parameter_weight) * anchor_parameter
                    + float(args.pseudo_single_day_negative_weight)
                    * auxiliary["pseudo_single_day_negative"]
                    + float(args.pseudo_single_day_positive_weight)
                    * auxiliary["pseudo_single_day_positive"]
                )
                for name, value in auxiliary.items():
                    epoch_auxiliary[name].append(float(value.detach().cpu()))
                epoch_auxiliary["anchor_parameter"].append(
                    float(anchor_parameter.detach().cpu())
                )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
            optimizer.step()
            epoch_losses.append(float(loss.detach().cpu()))
        model.eval()
        with torch.no_grad():
            val_tensor = torch.as_tensor(val_indices, dtype=torch.long, device=device)
            val_outputs = model(query_views[val_tensor], prototypes)
            metrics = compute_metrics(
                torch,
                val_outputs,
                family_labels=labels[val_tensor],
                positive_mask=positives[val_tensor],
                preferred_mask=preferred[val_tensor],
                font_supervision_weights=font_weights[val_tensor],
                single_day_body_negative=single_day_negative[val_tensor],
                single_day_index=single_day_index,
                candidate_ids=candidate_ids,
            )
            authority_slices: dict[str, Mapping[str, Any]] = {}
            for authority_name in ("human", "visual"):
                positions = np.flatnonzero(val_authorities == authority_name)
                if not positions.size:
                    continue
                authority_tensor = torch.as_tensor(
                    positions, dtype=torch.long, device=device
                )
                authority_slices[authority_name] = compute_metrics(
                    torch,
                    {
                        "body_candidate_scores": val_outputs[
                            "body_candidate_scores"
                        ][authority_tensor],
                        "variant_candidate_scores": val_outputs[
                            "variant_candidate_scores"
                        ][authority_tensor],
                        "family_logits": val_outputs["family_logits"][
                            authority_tensor
                        ],
                    },
                    family_labels=labels[val_tensor][authority_tensor],
                    positive_mask=positives[val_tensor][authority_tensor],
                    preferred_mask=preferred[val_tensor][authority_tensor],
                    font_supervision_weights=font_weights[val_tensor][
                        authority_tensor
                    ],
                    single_day_body_negative=single_day_negative[val_tensor][
                        authority_tensor
                    ],
                    single_day_index=single_day_index,
                    candidate_ids=candidate_ids,
                )
        safety_passed = (
            float(metrics["top1_max_candidate_share"]) <= 0.65
            and (
                int(metrics["single_day_predicted_count"]) == 0
                or float(metrics["single_day_positive_precision"]) >= 0.80
            )
            and float(metrics["single_day_body_false_top1_rate"]) <= 0.0025
            and float(
                metrics["single_day_eligibility"]["eligible_top1_all_rows_rate"]
            )
            <= MAXIMUM_SINGLE_DAY_ALL_ROWS_TOP1_RATE
        )
        human_metrics = authority_slices.get("human", metrics)
        human_selection_score = (
            float(human_metrics["acceptable_at1"])
            + 0.5 * float(human_metrics["preferred_at1"])
            + 0.25 * float(human_metrics["family_accuracy"])
        )
        blended_selection_score = float(metrics["acceptable_at1"]) + float(
            args.human_selection_weight
        ) * human_selection_score
        key = (
            float(safety_passed),
            blended_selection_score,
            float(metrics["acceptable_at1"]),
            float(human_metrics["acceptable_at1"]),
            float(human_metrics["preferred_at1"]),
            float(metrics["preferred_at1"]),
            float(metrics["family_accuracy"]),
            -float(metrics["top1_max_candidate_share"]),
        )
        epoch_record = {
            "epoch": epoch,
            "mean_train_auxiliary": {
                name: sum(values) / max(1, len(values))
                for name, values in epoch_auxiliary.items()
            },
            "mean_train_loss": sum(epoch_losses) / max(1, len(epoch_losses)),
            "selection_safety_passed": safety_passed,
            "selection_score": blended_selection_score,
            "val": dict(metrics),
            "val_by_authority": authority_slices,
        }
        history.append(epoch_record)
        if best_key is None or key > best_key:
            best_key = key
            best_epoch = epoch_record
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
    if best_state is None or best_epoch is None:
        raise MangaFontV8RoleFamilyError("training produced no checkpoint")
    model.load_state_dict(best_state, strict=True)

    output = _safe_output(args.output_dir)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        marker = output / MARKER_FILE
        if not args.replace_owned_output or not marker.is_file():
            raise MangaFontV8RoleFamilyError("refusing to replace output directory")
        old = json.loads(marker.read_text(encoding="utf-8"))
        if old.get("owner") != OWNER or old.get("safe_replace") is not True:
            raise MangaFontV8RoleFamilyError("refusing to replace unowned output")
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        checkpoint_path = staging / CHECKPOINT_FILE
        save_file(best_state, str(checkpoint_path))
        visual_quality_metrics = best_epoch["val_by_authority"].get("visual")
        if not isinstance(visual_quality_metrics, Mapping):
            raise MangaFontV8RoleFamilyError(
                "training produced no visual validation authority slice"
            )
        quality_gate = {
            "checks": build_quality_gate_checks(
                best_epoch["val"], visual_quality_metrics
            ),
            "routing_authority": (
                "predicted_pixel_family_with_single_day_eligibility"
            ),
        }
        quality_gate["passed"] = all(quality_gate["checks"].values())
        manifest = seal_record(
            {
                "architecture": dict(architecture),
                "best_epoch": best_epoch,
                "candidate_ids": list(candidate_ids),
                "dataset": {
                    "file": str(dataset_path),
                    "sha256": sha256_file(dataset_path),
                    **{key: value for key, value in inventory.items() if key != "candidate_ids"},
                },
                "files": {
                    CHECKPOINT_FILE: {
                        "byte_size": checkpoint_path.stat().st_size,
                        "sha256": sha256_file(checkpoint_path),
                    }
                },
                "history": history,
                "configuration": {
                    "anchor_batch_size": args.anchor_batch_size,
                    "anchor_output_weight": args.anchor_output_weight,
                    "anchor_parameter_weight": args.anchor_parameter_weight,
                    "bias_l2_weight": args.bias_l2_weight,
                    "candidate_distribution_slack": args.candidate_distribution_slack,
                    "candidate_distribution_temperature": args.candidate_distribution_temperature,
                    "candidate_distribution_weight": args.candidate_distribution_weight,
                    "candidate_parameter_lr_multiplier": (
                        args.candidate_parameter_lr_multiplier
                    ),
                    "family_weight": args.family_weight,
                    "focus_candidate_ids": list(focus_candidate_ids),
                    "focus_candidate_weight_multiplier": (
                        args.focus_candidate_weight_multiplier
                    ),
                    "human_candidate_weight_multiplier": (
                        args.human_candidate_weight_multiplier
                    ),
                    "human_family_weight_multiplier": (
                        args.human_family_weight_multiplier
                    ),
                    "human_selection_weight": args.human_selection_weight,
                    "learning_rate": args.learning_rate,
                    "pseudo_distillation_temperature": (
                        args.pseudo_distillation_temperature
                    ),
                    "pseudo_distillation_weight": args.pseudo_distillation_weight,
                    "pseudo_single_day_negative_margin": (
                        args.pseudo_single_day_negative_margin
                    ),
                    "pseudo_single_day_negative_weight": (
                        args.pseudo_single_day_negative_weight
                    ),
                    "pseudo_single_day_positive_weight": (
                        args.pseudo_single_day_positive_weight
                    ),
                    "rare_class_weight_cap": args.rare_class_weight_cap,
                    "sample_residual_l2_weight": args.sample_residual_l2_weight,
                    "single_day_hard_negative_margin": args.single_day_hard_negative_margin,
                    "single_day_hard_negative_weight": args.single_day_hard_negative_weight,
                    "supervised_single_day_hard_negative_weight": (
                        args.supervised_single_day_hard_negative_weight
                    ),
                    "trainable_scope": args.trainable_scope,
                    "weight_decay": args.weight_decay,
                },
                "distillation": {
                    "anchor": anchor_binding,
                    "authority": {
                        "anchor_is_label_authority": False,
                        "pseudo_is_gold": False,
                        "reviewed_masks_replaced": False,
                        "validation_rows_used_by_pseudo_loss": 0,
                    },
                    "bundle": distillation_binding,
                },
                "initialization": initialization,
                "candidate_weighting": {
                    **candidate_weighting,
                    "visual_class_frequency_by_candidate": {
                        candidate_id: candidate_weighting[
                            "visual_class_frequency"
                        ][index]
                        for index, candidate_id in enumerate(candidate_ids)
                    },
                },
                "family_weighting": {
                    "human_family_multiplier": args.human_family_weight_multiplier,
                    "human_train_rows": int(train_human_family.sum()),
                    "pseudo_or_visual_family_rows_unchanged": True,
                },
                "quality_gate": quality_gate,
                "record_type": "manga_font_student_v8_role_family_adapter_manifest",
                "schema_version": SCHEMA_VERSION,
                "source_query_head": {
                    "file": str(args.source_query_head.expanduser().resolve()),
                    "sha256": sha256_file(args.source_query_head.expanduser().resolve()),
                },
                "training_seconds": time.monotonic() - started,
                "trainable_parameters": trainable_parameters,
            }
        )
        (staging / MANIFEST_FILE).write_bytes(json_bytes(manifest, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    CHECKPOINT_FILE: sha256_file(checkpoint_path),
                    MANIFEST_FILE: sha256_file(staging / MANIFEST_FILE),
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        if output.exists():
            shutil.rmtree(output)
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {
        "best_epoch": best_epoch["epoch"],
        "output_dir": str(output),
        "quality_gate_passed": quality_gate["passed"],
        "val": best_epoch["val"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("preflight")
    preflight.add_argument("--dataset-npz", type=Path, required=True)
    preflight.add_argument("--source-query-head", type=Path, required=True)
    preflight.add_argument("--initial-adapter-dir", type=Path)
    preflight.add_argument("--maximum-family-bias", type=float, default=0.35)
    preflight.add_argument("--candidate-residual-hidden-dim", type=int, default=64)
    preflight.add_argument("--maximum-sample-residual", type=float, default=0.75)
    train = commands.add_parser("train")
    train.add_argument("--dataset-npz", type=Path, required=True)
    train.add_argument("--source-query-head", type=Path, required=True)
    train.add_argument("--initial-adapter-dir", type=Path)
    train.add_argument("--anchor-adapter-dir", type=Path)
    train.add_argument("--pseudo-distillation-dir", type=Path)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    train.add_argument("--epochs", type=int, default=24)
    train.add_argument("--batch-size", type=int, default=128)
    train.add_argument("--anchor-batch-size", type=int, default=512)
    train.add_argument("--learning-rate", type=float, default=5e-4)
    train.add_argument(
        "--candidate-parameter-lr-multiplier", type=float, default=1.0
    )
    train.add_argument(
        "--trainable-scope",
        choices=("all", "family-head-only"),
        default="all",
    )
    train.add_argument("--weight-decay", type=float, default=1e-4)
    train.add_argument("--gradient-clip", type=float, default=1.0)
    train.add_argument("--family-weight", type=float, default=0.35)
    train.add_argument("--single-day-hard-negative-weight", type=float, default=0.35)
    train.add_argument("--single-day-hard-negative-margin", type=float, default=0.25)
    train.add_argument("--bias-l2-weight", type=float, default=0.02)
    train.add_argument("--maximum-family-bias", type=float, default=0.35)
    train.add_argument("--candidate-residual-hidden-dim", type=int, default=64)
    train.add_argument("--maximum-sample-residual", type=float, default=0.75)
    train.add_argument("--candidate-distribution-weight", type=float, default=0.03)
    train.add_argument("--candidate-distribution-slack", type=float, default=0.05)
    train.add_argument(
        "--candidate-distribution-temperature", type=float, default=0.20
    )
    train.add_argument("--sample-residual-l2-weight", type=float, default=0.005)
    train.add_argument("--pseudo-distillation-weight", type=float, default=0.0)
    train.add_argument("--pseudo-distillation-temperature", type=float, default=1.0)
    train.add_argument("--anchor-output-weight", type=float, default=0.0)
    train.add_argument("--anchor-parameter-weight", type=float, default=0.0)
    train.add_argument(
        "--pseudo-single-day-negative-weight", type=float, default=0.0
    )
    train.add_argument(
        "--pseudo-single-day-positive-weight", type=float, default=0.0
    )
    train.add_argument(
        "--pseudo-single-day-negative-margin", type=float, default=0.25
    )
    train.add_argument("--rare-class-weight-cap", type=float, default=3.0)
    train.add_argument("--human-candidate-weight-multiplier", type=float, default=1.0)
    train.add_argument("--human-family-weight-multiplier", type=float, default=1.0)
    train.add_argument("--human-selection-weight", type=float, default=0.0)
    train.add_argument("--focus-candidate-ids", default="")
    train.add_argument("--focus-candidate-weight-multiplier", type=float, default=1.0)
    train.add_argument(
        "--supervised-single-day-hard-negative-weight", type=float, default=1.0
    )
    train.add_argument("--seed", type=int, default=20260811)
    train.add_argument("--replace-owned-output", action="store_true")
    return parser


def _validate_cli(args: argparse.Namespace) -> None:
    positive = (
        "epochs",
        "batch_size",
        "anchor_batch_size",
        "learning_rate",
        "gradient_clip",
        "maximum_family_bias",
        "candidate_residual_hidden_dim",
        "candidate_distribution_temperature",
        "pseudo_distillation_temperature",
        "maximum_sample_residual",
        "rare_class_weight_cap",
        "human_candidate_weight_multiplier",
        "human_family_weight_multiplier",
        "focus_candidate_weight_multiplier",
    )
    if any(not math.isfinite(float(getattr(args, name))) or getattr(args, name) <= 0 for name in positive):
        raise MangaFontV8RoleFamilyError("positive training options must be finite")
    nonnegative = (
        "weight_decay",
        "family_weight",
        "single_day_hard_negative_weight",
        "single_day_hard_negative_margin",
        "bias_l2_weight",
        "candidate_distribution_weight",
        "candidate_distribution_slack",
        "sample_residual_l2_weight",
        "supervised_single_day_hard_negative_weight",
        "human_selection_weight",
        "candidate_parameter_lr_multiplier",
        "pseudo_distillation_weight",
        "anchor_output_weight",
        "anchor_parameter_weight",
        "pseudo_single_day_negative_weight",
        "pseudo_single_day_positive_weight",
        "pseudo_single_day_negative_margin",
    )
    if any(not math.isfinite(float(getattr(args, name))) or getattr(args, name) < 0 for name in nonnegative):
        raise MangaFontV8RoleFamilyError("loss weights must be finite and nonnegative")
    if args.pseudo_distillation_dir is not None and (
        args.anchor_adapter_dir is None
        or args.initial_adapter_dir is None
        or args.pseudo_distillation_weight <= 0.0
        or args.anchor_output_weight <= 0.0
    ):
        raise MangaFontV8RoleFamilyError(
            "pseudo distillation requires explicit initialization, r3h anchor, "
            "and positive pseudo/anchor-output weights"
        )
    if args.pseudo_distillation_dir is None and any(
        value > 0.0
        for value in (
            args.pseudo_distillation_weight,
            args.anchor_output_weight,
            args.anchor_parameter_weight,
            args.pseudo_single_day_negative_weight,
            args.pseudo_single_day_positive_weight,
        )
    ):
        raise MangaFontV8RoleFamilyError(
            "distillation loss weights require --pseudo-distillation-dir"
        )


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "preflight":
        print(canonical_json(preflight_adapter(args)))
        return 0
    if args.command == "train":
        _validate_cli(args)
        print(canonical_json(train_adapter(args)))
        return 0
    raise MangaFontV8RoleFamilyError(f"unsupported command: {args.command}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
