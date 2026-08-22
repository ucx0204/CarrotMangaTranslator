#!/usr/bin/env python3
"""Independent MangaFont GlyphVoice model.

This module intentionally does not import the production v8/R33 ranker.  It
keeps local stroke tokens, compares them to candidate tokens with a learned
bidirectional set matcher, and applies an optional learned page-set refiner.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

import torch
from torch import Tensor, nn
from torch.autograd import Function
from torch.nn import functional as F


MODEL_SCHEMA = "manga-font-glyphvoice-v4"
INPUT_SIZE = 192
TOKEN_DIM = 192
TOKEN_COUNT = 24
EMBED_DIM = 192
MATCH_DIM = 96
VOICE_DIM = 192


class ConvBnAct(nn.Sequential):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int,
        *,
        stride: int = 1,
        groups: int = 1,
        activation: bool = True,
    ) -> None:
        padding = kernel_size // 2
        layers: list[nn.Module] = [
            nn.Conv2d(
                in_channels,
                out_channels,
                kernel_size,
                stride=stride,
                padding=padding,
                groups=groups,
                bias=False,
            ),
            nn.BatchNorm2d(out_channels),
        ]
        if activation:
            layers.append(nn.SiLU(inplace=True))
        super().__init__(*layers)


class RepDepthwiseBlock(nn.Module):
    """Small MobileOne-style training block with depthwise multi-branches."""

    def __init__(self, in_channels: int, out_channels: int, *, stride: int) -> None:
        super().__init__()
        self.dw3 = ConvBnAct(
            in_channels,
            in_channels,
            3,
            stride=stride,
            groups=in_channels,
            activation=False,
        )
        self.dw1 = ConvBnAct(
            in_channels,
            in_channels,
            1,
            stride=stride,
            groups=in_channels,
            activation=False,
        )
        self.identity = nn.BatchNorm2d(in_channels) if stride == 1 else None
        self.pointwise = ConvBnAct(in_channels, out_channels, 1)
        self.use_residual = stride == 1 and in_channels == out_channels
        self.drop = nn.Dropout2d(0.03)

    def forward(self, inputs: Tensor) -> Tensor:
        hidden = self.dw3(inputs) + self.dw1(inputs)
        if self.identity is not None:
            hidden = hidden + self.identity(inputs)
        hidden = F.silu(hidden, inplace=True)
        output = self.pointwise(hidden)
        if self.use_residual:
            output = output + inputs
        return self.drop(output)


class GlyphVoiceEncoder(nn.Module):
    """Efficient multi-scale encoder returning local stroke tokens and a global."""

    def __init__(self) -> None:
        super().__init__()
        self.stem = ConvBnAct(3, 32, 3, stride=2)
        self.stage1 = nn.Sequential(
            RepDepthwiseBlock(32, 48, stride=2),
            RepDepthwiseBlock(48, 48, stride=1),
        )
        self.stage2 = nn.Sequential(
            RepDepthwiseBlock(48, 80, stride=2),
            RepDepthwiseBlock(80, 96, stride=1),
            RepDepthwiseBlock(96, 96, stride=1),
        )
        self.stage3 = nn.Sequential(
            RepDepthwiseBlock(96, 144, stride=2),
            RepDepthwiseBlock(144, 160, stride=1),
            RepDepthwiseBlock(160, 176, stride=1),
        )
        self.stage4 = nn.Sequential(
            RepDepthwiseBlock(176, 224, stride=2),
            RepDepthwiseBlock(224, 256, stride=1),
        )
        self.shallow_projection = nn.Conv2d(48, TOKEN_DIM, 1, bias=False)
        self.mid_projection = nn.Conv2d(96, TOKEN_DIM, 1, bias=False)
        self.deep_projection = nn.Conv2d(256, TOKEN_DIM, 1, bias=False)
        self.token_norm = nn.LayerNorm(TOKEN_DIM)
        self.pool_query = nn.Parameter(torch.empty(TOKEN_DIM))
        self.global_projection = nn.Sequential(
            nn.Linear(TOKEN_DIM, EMBED_DIM),
            nn.LayerNorm(EMBED_DIM),
        )
        nn.init.normal_(self.pool_query, std=0.02)

    @staticmethod
    def _tokens(feature: Tensor, projection: nn.Module) -> Tensor:
        projected = projection(feature)
        pooled = F.adaptive_avg_pool2d(projected, (2, 4))
        return pooled.flatten(2).transpose(1, 2)

    def forward(self, inputs: Tensor) -> tuple[Tensor, Tensor]:
        if inputs.ndim != 4 or inputs.shape[1] != 3:
            raise ValueError("GlyphVoice input must be [batch,3,height,width]")
        hidden = self.stem(inputs)
        shallow = self.stage1(hidden)
        mid = self.stage2(shallow)
        hidden = self.stage3(mid)
        deep = self.stage4(hidden)
        tokens = torch.cat(
            (
                self._tokens(shallow, self.shallow_projection),
                self._tokens(mid, self.mid_projection),
                self._tokens(deep, self.deep_projection),
            ),
            dim=1,
        )
        tokens = self.token_norm(tokens)
        attention = torch.softmax(
            torch.einsum("btd,d->bt", tokens, self.pool_query)
            / math.sqrt(float(TOKEN_DIM)),
            dim=1,
        )
        pooled = torch.einsum("bt,btd->bd", attention, tokens)
        global_embedding = F.normalize(self.global_projection(pooled), dim=-1)
        return tokens, global_embedding


class StrokeTransportMatcher(nn.Module):
    """Learned bidirectional soft-Chamfer relation between two token sets."""

    def __init__(self) -> None:
        super().__init__()
        self.query_projection = nn.Linear(TOKEN_DIM, MATCH_DIM, bias=False)
        self.candidate_projection = nn.Linear(TOKEN_DIM, MATCH_DIM, bias=False)
        self.relation = nn.Sequential(
            nn.Linear(8, 96),
            nn.SiLU(),
            nn.Dropout(0.05),
            nn.Linear(96, 48),
            nn.SiLU(),
            nn.Linear(48, 1),
        )
        self.temperature_logit = nn.Parameter(torch.tensor(-1.2))
        self.output_scale_logit = nn.Parameter(torch.tensor(1.5))
        self.render_temperature_logit = nn.Parameter(torch.tensor(-0.8))

    def _pair_statistics(
        self,
        query_tokens: Tensor,
        query_global: Tensor,
        candidate_tokens: Tensor,
        candidate_global: Tensor,
    ) -> Tensor:
        query = F.normalize(self.query_projection(query_tokens), dim=-1)
        candidate = F.normalize(self.candidate_projection(candidate_tokens), dim=-1)
        similarities = torch.einsum("btd,bsd->bts", query, candidate)
        temperature = 0.03 + 0.22 * torch.sigmoid(self.temperature_logit)
        q_to_c = temperature * torch.logsumexp(similarities / temperature, dim=2)
        c_to_q = temperature * torch.logsumexp(similarities / temperature, dim=1)
        global_dot = torch.sum(query_global * candidate_global, dim=-1)
        return torch.stack(
            (
                q_to_c.mean(dim=1),
                c_to_q.mean(dim=1),
                q_to_c.amax(dim=1),
                c_to_q.amax(dim=1),
                q_to_c.std(dim=1, unbiased=False),
                c_to_q.std(dim=1, unbiased=False),
                global_dot,
                torch.abs(query_global - candidate_global).mean(dim=-1),
            ),
            dim=-1,
        )

    def pair_score(
        self,
        query_tokens: Tensor,
        query_global: Tensor,
        candidate_tokens: Tensor,
        candidate_global: Tensor,
    ) -> Tensor:
        statistics = self._pair_statistics(
            query_tokens, query_global, candidate_tokens, candidate_global
        )
        scale = 1.0 + 7.0 * torch.sigmoid(self.output_scale_logit)
        return self.relation(statistics).squeeze(-1) * scale

    def forward(
        self,
        query_tokens: Tensor,
        query_global: Tensor,
        candidate_tokens: Tensor,
        candidate_global: Tensor,
    ) -> Tensor:
        """Score B queries against C prototypes.

        candidate_tokens may be [C,T,D] or [C,R,T,D].  Multiple render token
        sets are concatenated, while their global embeddings are averaged.
        """

        if candidate_tokens.ndim == 4:
            candidates, renders = candidate_tokens.shape[:2]
            batch = query_tokens.shape[0]
            query_tokens_expanded = query_tokens[:, None, None].expand(
                -1, candidates, renders, -1, -1
            )
            query_global_expanded = query_global[:, None, None].expand(
                -1, candidates, renders, -1
            )
            candidate_tokens_expanded = candidate_tokens[None].expand(
                batch, -1, -1, -1, -1
            )
            candidate_global_expanded = candidate_global[None].expand(batch, -1, -1, -1)
            render_scores = self.pair_score(
                query_tokens_expanded.flatten(0, 2),
                query_global_expanded.flatten(0, 2),
                candidate_tokens_expanded.flatten(0, 2),
                candidate_global_expanded.flatten(0, 2),
            ).reshape(batch, candidates, renders)
            temperature = 0.04 + 0.46 * torch.sigmoid(self.render_temperature_logit)
            return temperature * (
                torch.logsumexp(render_scores / temperature, dim=2)
                - math.log(float(renders))
            )
        batch, candidates = query_tokens.shape[0], candidate_tokens.shape[0]
        query_tokens_expanded = query_tokens[:, None].expand(-1, candidates, -1, -1)
        query_global_expanded = query_global[:, None].expand(-1, candidates, -1)
        candidate_tokens_expanded = candidate_tokens[None].expand(batch, -1, -1, -1)
        candidate_global_expanded = candidate_global[None].expand(batch, -1, -1)
        scores = self.pair_score(
            query_tokens_expanded.flatten(0, 1),
            query_global_expanded.flatten(0, 1),
            candidate_tokens_expanded.flatten(0, 1),
            candidate_global_expanded.flatten(0, 1),
        )
        return scores.reshape(batch, candidates)


class GlyphVoiceLocalModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.encoder = GlyphVoiceEncoder()
        self.matcher = StrokeTransportMatcher()
        self.script_classifier = nn.Sequential(
            nn.Linear(EMBED_DIM, 96), nn.SiLU(), nn.Linear(96, 2)
        )
        self.candidate_aux_classifier = nn.Linear(EMBED_DIM, 21)

    def encode(self, inputs: Tensor) -> tuple[Tensor, Tensor]:
        return self.encoder(inputs)

    def score(
        self,
        query_inputs: Tensor,
        candidate_inputs: Tensor,
    ) -> tuple[Tensor, Tensor, Tensor]:
        query_tokens, query_global = self.encode(query_inputs)
        if candidate_inputs.ndim != 5:
            raise ValueError("candidate input must be [candidate,render,3,H,W]")
        candidates, renders = candidate_inputs.shape[:2]
        candidate_tokens, candidate_global = self.encode(candidate_inputs.flatten(0, 1))
        candidate_tokens = candidate_tokens.reshape(
            candidates, renders, TOKEN_COUNT, TOKEN_DIM
        )
        candidate_global = candidate_global.reshape(candidates, renders, EMBED_DIM)
        scores = self.matcher(
            query_tokens, query_global, candidate_tokens, candidate_global
        )
        return scores, query_global, query_tokens


class PageVoiceSet(nn.Module):
    """Learned page-set residual with an explicit exception gate."""

    def __init__(self, candidate_count: int) -> None:
        super().__init__()
        self.candidate_count = candidate_count
        self.row_projection = nn.Linear(EMBED_DIM + candidate_count, VOICE_DIM)
        layer = nn.TransformerEncoderLayer(
            d_model=VOICE_DIM,
            nhead=4,
            dim_feedforward=VOICE_DIM * 3,
            dropout=0.08,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.set_encoder = nn.TransformerEncoder(layer, num_layers=2)
        self.residual_head = nn.Sequential(
            nn.LayerNorm(VOICE_DIM),
            nn.Linear(VOICE_DIM, VOICE_DIM),
            nn.GELU(),
            nn.Linear(VOICE_DIM, candidate_count),
        )
        self.exception_gate = nn.Sequential(
            nn.Linear(VOICE_DIM + 2, 48),
            nn.SiLU(),
            nn.Linear(48, 1),
        )
        self.residual_bound = nn.Parameter(torch.tensor(1.2))
        final_residual = self.residual_head[-1]
        if not isinstance(final_residual, nn.Linear):
            raise TypeError("PageVoiceSet residual head drifted")
        nn.init.zeros_(final_residual.weight)
        nn.init.zeros_(final_residual.bias)

    def forward(
        self,
        local_logits: Tensor,
        row_embeddings: Tensor,
        padding_mask: Tensor,
    ) -> tuple[Tensor, Tensor, Tensor]:
        if local_logits.ndim != 3 or row_embeddings.ndim != 3:
            raise ValueError("PageVoiceSet expects batched page sequences")
        probabilities = torch.softmax(local_logits, dim=-1)
        confidence = probabilities.amax(dim=-1, keepdim=True)
        entropy = -torch.sum(
            probabilities * torch.log(probabilities.clamp_min(1e-8)),
            dim=-1,
            keepdim=True,
        ) / math.log(float(self.candidate_count))
        rows = self.row_projection(torch.cat((row_embeddings, probabilities), dim=-1))
        context = self.set_encoder(rows, src_key_padding_mask=padding_mask)
        exception = torch.sigmoid(
            self.exception_gate(torch.cat((context, confidence, entropy), dim=-1))
        )
        voice_gate = 1.0 - exception
        bound = 0.25 + 2.75 * torch.sigmoid(self.residual_bound)
        residual = bound * torch.tanh(self.residual_head(context) / bound)
        residual = residual * voice_gate
        residual = residual.masked_fill(padding_mask[..., None], 0.0)
        return local_logits + residual, exception.squeeze(-1), residual


class _GradientReverse(Function):
    @staticmethod
    def forward(ctx: Any, inputs: Tensor, scale: float) -> Tensor:
        ctx.scale = scale
        return inputs.view_as(inputs)

    @staticmethod
    def backward(ctx: Any, gradient: Tensor) -> tuple[Tensor, None]:
        return -ctx.scale * gradient, None


def gradient_reverse(inputs: Tensor, scale: float) -> Tensor:
    return _GradientReverse.apply(inputs, float(scale))


def paired_info_nce(embeddings: Tensor, *, temperature: float = 0.08) -> Tensor:
    """InfoNCE for [a0,b0,a1,b1,...] paired examples."""

    if embeddings.ndim != 2 or embeddings.shape[0] % 2:
        raise ValueError("paired_info_nce requires an even [batch,dim] tensor")
    normalized = F.normalize(embeddings, dim=-1)
    logits = normalized @ normalized.transpose(0, 1) / temperature
    logits.fill_diagonal_(torch.finfo(logits.dtype).min)
    targets = torch.arange(logits.shape[0], device=logits.device) ^ 1
    return F.cross_entropy(logits, targets)


def partial_set_nll(
    logits: Tensor,
    eligible_mask: Tensor,
    positive_mask: Tensor,
    preferred_mask: Tensor,
    weights: Tensor,
) -> Tensor:
    """Reviewed-only hierarchical set loss; unreviewed candidates get no label loss."""

    if not (
        logits.shape
        == eligible_mask.shape
        == positive_mask.shape
        == preferred_mask.shape
    ):
        raise ValueError("partial-label shapes differ")
    minimum = torch.finfo(logits.dtype).min
    denominator = torch.logsumexp(logits.masked_fill(~eligible_mask, minimum), dim=1)
    positive = torch.logsumexp(logits.masked_fill(~positive_mask, minimum), dim=1)
    positive_loss = denominator - positive
    has_preferred = preferred_mask.any(dim=1)
    preferred = torch.logsumexp(logits.masked_fill(~preferred_mask, minimum), dim=1)
    row_loss = 0.35 * positive_loss + 0.65 * torch.where(
        has_preferred, denominator - preferred, positive_loss
    )
    normalized_weights = weights / weights.sum().clamp_min(1e-6)
    return torch.sum(row_loss * normalized_weights)


def model_inventory(model: nn.Module) -> Mapping[str, int]:
    return {
        "parameter_count": sum(value.numel() for value in model.parameters()),
        "trainable_parameter_count": sum(
            value.numel() for value in model.parameters() if value.requires_grad
        ),
    }
