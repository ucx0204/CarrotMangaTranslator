"""Screen a learned row-aware page context ranker against production R33.

This is deliberately a fast, non-promotable architecture screen.  It keeps the
frozen encoder, candidate branches, and R31 family router, then replaces R33's
single page-wide candidate delta with a small permutation-equivariant set head.
The head sees all rows on a page, softly downweights rows that the family router
considers non-body, and predicts both a per-row candidate residual and a learned
context-trust gate.  The training objective only rewards agreement for row pairs
whose reviewed candidate sets actually overlap.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_page_common_ranker_r33 as r33
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_page_common_ranker_r33 as r33


R31_HEAD = Path("artifacts/manga-font-v3-page-family-router-r31-local-mlp32-qa-v1")
LABEL_FILE = "training-labels.jsonl"
MAXIMUM_DELTA = 4.0
ROW_WIDTH = 32
ATTENTION_WIDTH = 32
CANDIDATE_WIDTH = 32
CHECKPOINT_EPOCHS = (8, 16, 24, 32, 40)
TRIAD_IDS = ("ridi-batang", "nanum-barun-gothic", "nanum-myeongjo")


@dataclass(frozen=True)
class PageGroup:
    body_positions: tuple[int, ...]
    chapter_id: str
    page_id: str
    rows: tuple[Mapping[str, Any], ...]
    work_id: str


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"expected JSONL object: {path}")
            rows.append(value)
    return rows


def _identity_maps(prepared: Mapping[str, Any]) -> Mapping[str, Mapping[str, str]]:
    labels = _read_jsonl(Path(prepared["args"].source_label_dir) / LABEL_FILE)
    page: dict[str, str] = {}
    chapter: dict[str, str] = {}
    role: dict[str, str] = {}
    for label in labels:
        identity = label.get("identity")
        if not isinstance(identity, dict):
            raise ValueError("training label identity is missing")
        sample_id = str(label["sample_id"])
        page[sample_id] = str(identity["page_id"])
        chapter[sample_id] = str(identity["chapter_id"])
        role[sample_id] = str(label["role"])
    return {"chapter": chapter, "page": page, "role": role}


def _page_groups(
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    *,
    require_multiple_body_rows: bool,
) -> tuple[PageGroup, ...]:
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        sample_id = str(row["sample_id"])
        grouped.setdefault(identities["page"][sample_id], []).append(row)
    result = []
    for page_id, page_rows in sorted(grouped.items()):
        ordered = tuple(sorted(page_rows, key=lambda row: int(row["row_index"])))
        body_positions = tuple(
            position
            for position, row in enumerate(ordered)
            if int(row["family_label"]) == 0
        )
        if not body_positions or (
            require_multiple_body_rows and len(body_positions) < 2
        ):
            continue
        sample_id = str(ordered[0]["sample_id"])
        result.append(
            PageGroup(
                body_positions=body_positions,
                chapter_id=identities["chapter"][sample_id],
                page_id=page_id,
                rows=ordered,
                work_id=str(ordered[0]["work_id"]),
            )
        )
    return tuple(result)


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class ContextualSetRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.row = torch.nn.Linear(1024, ROW_WIDTH, bias=False)
            self.anchor = torch.nn.Linear(21, ROW_WIDTH, bias=False)
            self.token_norm = torch.nn.LayerNorm(ROW_WIDTH)
            self.query = torch.nn.Linear(ROW_WIDTH, ATTENTION_WIDTH, bias=False)
            self.key = torch.nn.Linear(ROW_WIDTH, ATTENTION_WIDTH, bias=False)
            self.value = torch.nn.Linear(ROW_WIDTH, ATTENTION_WIDTH, bias=False)
            self.candidate_embedding = torch.nn.Embedding(21, 6)
            candidate_input = ROW_WIDTH + ATTENTION_WIDTH + ROW_WIDTH + 4 + 1 + 1 + 6
            self.scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(candidate_input),
                torch.nn.Linear(candidate_input, CANDIDATE_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(CANDIDATE_WIDTH, 1),
            )
            gate_input = ROW_WIDTH + ATTENTION_WIDTH + ROW_WIDTH + 3
            self.gate = torch.nn.Sequential(
                torch.nn.LayerNorm(gate_input),
                torch.nn.Linear(gate_input, 16),
                torch.nn.GELU(),
                torch.nn.Linear(16, 1),
            )
            torch.nn.init.zeros_(self.scorer[-1].weight)
            torch.nn.init.zeros_(self.scorer[-1].bias)

        def forward(
            self,
            local_query: Any,
            anchor_family: Any,
            per_query: Any,
            anchor_body: Any,
        ) -> Mapping[str, Any]:
            local = torch.nn.functional.layer_norm(local_query.float(), (1024,))
            centered_anchor = anchor_body.float() - anchor_body.float().mean(
                dim=1, keepdim=True
            )
            token = self.token_norm(self.row(local) + self.anchor(centered_anchor))
            token = torch.nn.functional.gelu(token)
            body_probability = torch.softmax(anchor_family.float(), dim=1)[:, 0]
            count = len(token)
            if count > 1:
                similarity = self.query(token) @ self.key(token).transpose(0, 1)
                similarity = similarity / math.sqrt(float(ATTENTION_WIDTH))
                similarity = (
                    similarity + body_probability.clamp_min(1e-4).log()[None, :]
                )
                similarity = similarity.masked_fill(
                    torch.eye(count, dtype=torch.bool, device=token.device),
                    torch.finfo(similarity.dtype).min,
                )
                attention = torch.softmax(similarity, dim=1)
                context = attention @ self.value(token)
                support = (body_probability.sum() - 1.0).clamp(0.0, 1.0)
            else:
                attention = token.new_zeros((count, count))
                context = token.new_zeros((count, ATTENTION_WIDTH))
                support = token.new_zeros(())
            difference = (token - context).abs()
            entropy = -(
                torch.softmax(anchor_body.float(), dim=1)
                * torch.log_softmax(anchor_body.float(), dim=1)
            ).sum(dim=1, keepdim=True)
            maximum_probability = torch.softmax(anchor_body.float(), dim=1).amax(
                dim=1, keepdim=True
            )
            gate_features = torch.cat(
                (
                    token,
                    context,
                    difference,
                    entropy,
                    maximum_probability,
                    body_probability[:, None],
                ),
                dim=1,
            )
            trust = torch.sigmoid(self.gate(gate_features)).squeeze(1)
            body_weights = body_probability / body_probability.sum().clamp_min(1e-6)
            page_anchor = (anchor_body.float() * body_weights[:, None]).sum(dim=0)
            candidate_ids = torch.arange(21, device=token.device)
            candidate = self.candidate_embedding(candidate_ids)
            pieces = (
                token[:, None, :].expand(-1, 21, -1),
                context[:, None, :].expand(-1, 21, -1),
                difference[:, None, :].expand(-1, 21, -1),
                per_query,
                anchor_body.float()[:, :, None],
                page_anchor[None, :, None].expand(count, -1, -1),
                candidate[None, :, :].expand(count, -1, -1),
            )
            raw_delta = MAXIMUM_DELTA * torch.tanh(
                self.scorer(torch.cat(pieces, dim=2)).squeeze(2)
            )
            applied = support * body_probability * trust
            delta = applied[:, None] * raw_delta
            return {
                "attention": attention,
                "body_candidate_scores": anchor_body + delta,
                "delta": delta,
                "raw_delta": raw_delta,
                "support": support,
                "token": token,
                "trust": trust,
            }

    return ContextualSetRanker()


def _load_family_model(torch: Any, *, device: Any) -> Any:
    from safetensors.torch import load_file

    model = r33.r32.r31._build_model(torch, r33.r32.r31.CELLS[0], seed=0).to(device)
    state = load_file(str(R31_HEAD / "family-router.safetensors"), device="cpu")
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def _group_inputs(
    torch: Any,
    model: Any,
    family_model: Any,
    prepared: Mapping[str, Any],
    group: PageGroup,
    identities: Mapping[str, Mapping[str, str]],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    anchor_family = r33.r32.r31._family_logits(
        torch,
        family_model,
        prepared,
        group.rows,
        identities["page"],
        "local",
        device=device,
    )
    return model(
        torch.as_tensor(local, device=device),
        anchor_family,
        torch.as_tensor(r33.r32._per_query(prepared, indices), device=device),
        prepared["cache"]["body_candidate_scores"][positions].to(device),
    )


def _set_nll(torch: Any, scores: Any, numerator: Any, denominator: Any) -> Any:
    negative = torch.finfo(scores.dtype).min
    top = torch.logsumexp(scores.masked_fill(~numerator, negative), dim=1)
    bottom = torch.logsumexp(scores.masked_fill(~denominator, negative), dim=1)
    return bottom - top


def _group_loss(
    torch: Any,
    output: Mapping[str, Any],
    group: PageGroup,
    *,
    device: Any,
) -> Mapping[str, Any]:
    body_rows = tuple(group.rows[position] for position in group.body_positions)
    body_positions = torch.as_tensor(
        group.body_positions, dtype=torch.long, device=device
    )
    scores = output["body_candidate_scores"][body_positions]
    tensors = r33.r32.r31.r29.r23._tier_tensors(torch, body_rows, device=device)
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred_target = torch.where(
        preferred_rows[:, None], tensors["preferred_mask"], tensors["safe_mask"]
    )
    direct = 0.65 * _set_nll(torch, scores, preferred_target, reviewed)
    direct = direct + 0.35 * _set_nll(torch, scores, tensors["safe_mask"], reviewed)
    direct_loss = direct.mean()

    pair_losses = []
    compatible = 0
    incompatible = 0
    compatible_with_any = [False] * len(body_rows)
    trust_values = output["trust"][body_positions]
    safe = tensors["safe_mask"]
    preferred = tensors["preferred_mask"]
    for left in range(len(body_rows)):
        for right in range(left + 1, len(body_rows)):
            shared_reviewed = reviewed[left] & reviewed[right]
            shared_preferred = preferred[left] & preferred[right]
            shared_safe = safe[left] & safe[right]
            target = shared_preferred if bool(shared_preferred.any()) else shared_safe
            if not bool(target.any()) or not bool(shared_reviewed.any()):
                incompatible += 1
                continue
            compatible += 1
            compatible_with_any[left] = True
            compatible_with_any[right] = True
            pair_scores = scores[[left, right]].masked_fill(
                ~shared_reviewed[None, :], torch.finfo(scores.dtype).min
            )
            probabilities = torch.softmax(pair_scores.float(), dim=1)
            # A masked softmax may underflow to an exact zero.  sqrt(0) has an
            # infinite derivative, so keep the Bhattacharyya-style agreement
            # objective while flooring only its numerical differentiation path.
            joint = torch.sqrt(
                probabilities[0].clamp_min(1e-12) * probabilities[1].clamp_min(1e-12)
            )
            pair_losses.append(-torch.log(joint[target].sum().clamp_min(1e-8)))
    pair_loss = torch.stack(pair_losses).mean() if pair_losses else scores.sum() * 0.0
    target_tensor = torch.as_tensor(
        [float(value) for value in compatible_with_any],
        dtype=torch.float32,
        device=device,
    )
    gate_loss = torch.nn.functional.binary_cross_entropy(trust_values, target_tensor)
    delta_l2 = output["delta"][body_positions].float().square().mean()
    total = direct_loss + 0.45 * pair_loss + 0.05 * gate_loss + 0.002 * delta_l2
    return {
        "compatible_pairs": compatible,
        "direct": direct_loss,
        "gate": gate_loss,
        "incompatible_pairs": incompatible,
        "pair": pair_loss,
        "total": total,
    }


def _train_context_model(
    torch: Any,
    prepared: Mapping[str, Any],
    family_model: Any,
    groups: Sequence[PageGroup],
    identities: Mapping[str, Mapping[str, str]],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[int, Mapping[str, float]]]:
    model = _build_model(torch, seed=34_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=6e-4, weight_decay=2e-4)
    work_counts: dict[str, int] = {}
    for group in groups:
        work_counts[group.work_id] = work_counts.get(group.work_id, 0) + 1
    work_count = len(work_counts)
    history: dict[int, Mapping[str, float]] = {}
    for epoch in range(1, epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        totals = []
        direct = []
        pairs = []
        gates = []
        for group in groups:
            output = _group_inputs(
                torch,
                model,
                family_model,
                prepared,
                group,
                identities,
                device=device,
            )
            losses = _group_loss(torch, output, group, device=device)
            if not bool(torch.isfinite(losses["total"])):
                raise RuntimeError(
                    f"non-finite R34 loss at epoch={epoch} page={group.page_id}"
                )
            weight = 1.0 / (work_count * work_counts[group.work_id])
            totals.append(losses["total"] * weight)
            direct.append(float(losses["direct"].detach().item()) * weight)
            pairs.append(float(losses["pair"].detach().item()) * weight)
            gates.append(float(losses["gate"].detach().item()) * weight)
        total = torch.stack(totals).sum()
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        if epoch in CHECKPOINT_EPOCHS or epoch == epochs:
            history[epoch] = {
                "direct_loss": float(sum(direct)),
                "gate_loss": float(sum(gates)),
                "pair_loss": float(sum(pairs)),
                "total_loss": float(total.detach().item()),
            }
    model.eval()
    return model, history


def _train_r33_baseline(
    torch: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    *,
    fold_index: int,
    device: Any,
) -> Any:
    groups = r33._group_rows(rows, identities["page"])
    features = r33._group_features(torch, prepared, groups, device=device)
    weights = r33._group_weights(features["groups"], torch=torch, device=device)
    model = r33._build_page_model(torch, seed=33_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=1e-4)
    for _ in range(32):
        output = model(
            features["page_query"], features["per_query"], features["anchor_body"]
        )
        preferred = r33._set_loss(
            torch, output["page_scores"], features["common_preferred"]
        )
        safe = r33._set_loss(torch, output["page_scores"], features["common_safe"])
        loss = torch.sum((0.65 * preferred + 0.35 * safe) * weights)
        total = loss + 0.01 * output["delta"].square().mean()
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
    model.eval()
    return model


def _scores_for_rows(
    torch: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    *,
    context_model: Any | None,
    family_model: Any,
    r33_model: Any | None,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    anchor = prepared["cache"]["body_candidate_scores"][positions].to(device)
    result = anchor.clone()
    row_position = {str(row["sample_id"]): i for i, row in enumerate(rows)}
    if r33_model is not None:
        deltas = r33._page_deltas(
            torch,
            r33_model,
            prepared,
            rows,
            identities["page"],
            device=device,
        )
        for position, row in enumerate(rows):
            delta = deltas.get(identities["page"][str(row["sample_id"])])
            if delta is not None:
                result[position] += delta
    if context_model is not None:
        groups = _page_groups(rows, identities, require_multiple_body_rows=False)
        for group in groups:
            output = _group_inputs(
                torch,
                context_model,
                family_model,
                prepared,
                group,
                identities,
                device=device,
            )
            for local_position, row in enumerate(group.rows):
                global_position = row_position[str(row["sample_id"])]
                result[global_position] = output["body_candidate_scores"][
                    local_position
                ]
    return {"scores": result, "anchor": anchor}


def _metrics(
    torch: Any,
    scores: Any,
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    candidate_ids: Sequence[str],
) -> Mapping[str, float]:
    device = scores.device
    body_positions = [
        position for position, row in enumerate(rows) if int(row["family_label"]) == 0
    ]
    body_rows = tuple(rows[position] for position in body_positions)
    selected = torch.as_tensor(body_positions, dtype=torch.long, device=device)
    body_scores = scores[selected]
    top1 = body_scores.argmax(dim=1)
    tensors = r33.r32.r31.r29.r23._tier_tensors(torch, body_rows, device=device)
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred = tensors["preferred_mask"].gather(1, top1[:, None]).squeeze(1)
    safe = tensors["safe_mask"].gather(1, top1[:, None]).squeeze(1)
    unacceptable = tensors["unacceptable_mask"].gather(1, top1[:, None]).squeeze(1)
    triad = {tuple(candidate_ids).index(name) for name in TRIAD_IDS}

    def grouped_pairs(key: str) -> Mapping[str, float]:
        grouped: dict[str, list[int]] = {}
        for position, row in enumerate(body_rows):
            grouped.setdefault(identities[key][str(row["sample_id"])], []).append(
                position
            )
        agreements = []
        compatible_success = []
        incompatible_preserved = []
        triad_switch = []
        for positions in grouped.values():
            if len(positions) < 2:
                continue
            values = [int(top1[position].item()) for position in positions]
            triad_values = {value for value in values if value in triad}
            triad_switch.append(float(len(triad_values) > 1))
            for left_index, left in enumerate(positions):
                for right in positions[left_index + 1 :]:
                    agreements.append(
                        float(values[left_index] == int(top1[right].item()))
                    )
                    overlap = tensors["safe_mask"][left] & tensors["safe_mask"][right]
                    if bool(overlap.any()):
                        compatible_success.append(
                            float(
                                int(top1[left].item()) == int(top1[right].item())
                                and bool(overlap[int(top1[left].item())])
                            )
                        )
                    else:
                        incompatible_preserved.append(
                            float(int(top1[left].item()) != int(top1[right].item()))
                        )
        return {
            f"{key}_compatible_pair_success": float(
                np.mean(compatible_success) if compatible_success else 0.0
            ),
            f"{key}_incompatible_pair_preservation": float(
                np.mean(incompatible_preserved) if incompatible_preserved else 1.0
            ),
            f"{key}_pair_agreement": float(np.mean(agreements) if agreements else 0.0),
            f"{key}_triad_switch_group_rate": float(
                np.mean(triad_switch) if triad_switch else 0.0
            ),
        }

    values: dict[str, float] = {
        "preferred_top1_accuracy": float(
            preferred[preferred_rows].float().mean().item()
        ),
        "safe_top1_accuracy": float(safe.float().mean().item()),
        "unacceptable_top1_rate": float(unacceptable.float().mean().item()),
    }
    values.update(grouped_pairs("page"))
    values.update(grouped_pairs("chapter"))
    return values


def _delta(
    candidate: Mapping[str, float], anchor: Mapping[str, float]
) -> Mapping[str, float]:
    return {key: float(candidate[key] - anchor[key]) for key in anchor}


def _screen_fold(
    torch: Any,
    prepared: Mapping[str, Any],
    family_model: Any,
    fold: Mapping[str, Any],
    identities: Mapping[str, Mapping[str, str]],
    *,
    epochs: int,
    device: Any,
) -> Mapping[str, Any]:
    fold_index = int(fold["contract"]["fold_index"])
    train_rows = tuple(fold["train_rows"])
    heldout_rows = tuple(fold["heldout_rows"])
    train_groups = _page_groups(train_rows, identities, require_multiple_body_rows=True)
    context_model, history = _train_context_model(
        torch,
        prepared,
        family_model,
        train_groups,
        identities,
        epochs=epochs,
        fold_index=fold_index,
        device=device,
    )
    r33_model = _train_r33_baseline(
        torch,
        prepared,
        train_rows,
        identities,
        fold_index=fold_index,
        device=device,
    )
    anchor_scores = _scores_for_rows(
        torch,
        prepared,
        heldout_rows,
        identities,
        context_model=None,
        family_model=family_model,
        r33_model=None,
        device=device,
    )["scores"]
    r33_scores = _scores_for_rows(
        torch,
        prepared,
        heldout_rows,
        identities,
        context_model=None,
        family_model=family_model,
        r33_model=r33_model,
        device=device,
    )["scores"]
    r34_scores = _scores_for_rows(
        torch,
        prepared,
        heldout_rows,
        identities,
        context_model=context_model,
        family_model=family_model,
        r33_model=None,
        device=device,
    )["scores"]
    candidate_ids = tuple(prepared["context"]["candidate_ids"])
    anchor = _metrics(torch, anchor_scores, heldout_rows, identities, candidate_ids)
    baseline = _metrics(torch, r33_scores, heldout_rows, identities, candidate_ids)
    candidate = _metrics(torch, r34_scores, heldout_rows, identities, candidate_ids)
    return {
        "anchor": anchor,
        "history": history,
        "r33": baseline,
        "r33_delta": _delta(baseline, anchor),
        "r34": candidate,
        "r34_delta": _delta(candidate, anchor),
        "r34_vs_r33": _delta(candidate, baseline),
        "train_page_group_count": len(train_groups),
        "work_id": str(fold["heldout_work_id"]),
    }


def _macro(folds: Sequence[Mapping[str, Any]], key: str) -> Mapping[str, float]:
    names = tuple(folds[0][key])
    return {
        name: float(np.mean([float(fold[key][name]) for fold in folds]))
        for name in names
    }


def screen(
    device_name: str, *, fold_limit: int | None = None, epochs: int = 40
) -> Mapping[str, Any]:
    import torch

    prepared = r33.r32.r31.r29._prepare(torch)
    identities = _identity_maps(prepared)
    device = torch.device(device_name)
    family_model = _load_family_model(torch, device=device)
    source_folds = tuple(prepared["folds"])
    if fold_limit is not None:
        if fold_limit <= 0 or fold_limit > len(source_folds):
            raise ValueError("fold limit is outside the available work folds")
        source_folds = source_folds[:fold_limit]
    folds = []
    for position, fold in enumerate(source_folds, start=1):
        folds.append(
            _screen_fold(
                torch,
                prepared,
                family_model,
                fold,
                identities,
                epochs=epochs,
                device=device,
            )
        )
        print(
            f"completed R34 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=34_000)
    parameter_count = sum(int(value.numel()) for value in model.parameters())
    # Dense operations only; B^2 attention is reported separately because page B varies.
    approximate_row_mac = (
        1024 * ROW_WIDTH
        + 21 * ROW_WIDTH
        + 3 * ROW_WIDTH * ATTENTION_WIDTH
        + 21
        * (ROW_WIDTH + ATTENTION_WIDTH + ROW_WIDTH + 4 + 1 + 1 + 6)
        * CANDIDATE_WIDTH
        + 21 * CANDIDATE_WIDTH
    )
    return {
        "architecture": {
            "attention_width": ATTENTION_WIDTH,
            "context_mode": "row_aware_soft_body_weighted_set_attention",
            "learned_per_row_deviation_gate": True,
            "new_parameter_count": parameter_count,
            "page_attention_mac_per_row_at_batch16": 2 * 16 * ATTENTION_WIDTH,
            "row_mac_estimate": approximate_row_mac,
        },
        "data": {
            "chapter_count": len(set(identities["chapter"].values())),
            "page_count": len(set(identities["page"].values())),
            "training_only": True,
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "anchor": _macro(folds, "anchor"),
            "r33": _macro(folds, "r33"),
            "r33_delta": _macro(folds, "r33_delta"),
            "r34": _macro(folds, "r34"),
            "r34_delta": _macro(folds, "r34_delta"),
            "r34_vs_r33": _macro(folds, "r34_vs_r33"),
        },
        "production_eligible": False,
        "status": "r34_contextual_set_architecture_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--fold-limit", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.epochs <= 0 or args.epochs > 80:
        raise ValueError("epochs must be between 1 and 80")
    result = screen(args.device, fold_limit=args.fold_limit, epochs=args.epochs)
    payload = json.dumps(
        result, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    if args.output is not None:
        target = args.output.resolve()
        if target.exists():
            raise RuntimeError(f"refusing to overwrite output: {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
