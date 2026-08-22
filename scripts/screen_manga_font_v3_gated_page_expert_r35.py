"""Screen a learned page font expert with a per-row visual exception gate.

R33 predicts one page-wide additive prior but applies it equally to every row.
R34 allowed row-specific residuals and consequently retained too much freedom to
oscillate.  This screen instead learns one shared page expert distribution and a
separate visual gate per row.  Gate-positive ordinary rows mix toward the same
expert; visually distinct rows retain their frozen local candidate scores.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_contextual_set_r34 as r34
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_contextual_set_r34 as r34


PAGE_WIDTH = 24
LOCAL_WIDTH = 24
SCORER_WIDTH = 32
MAXIMUM_DELTA = 4.0


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class GatedPageExpert(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.page = torch.nn.Linear(1024, PAGE_WIDTH, bias=False)
            self.local = torch.nn.Linear(1024, LOCAL_WIDTH, bias=False)
            self.candidate_embedding = torch.nn.Embedding(21, 6)
            self.page_scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(PAGE_WIDTH + 4 + 1 + 6),
                torch.nn.Linear(PAGE_WIDTH + 4 + 1 + 6, SCORER_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(SCORER_WIDTH, 1),
            )
            gate_width = LOCAL_WIDTH + PAGE_WIDTH + LOCAL_WIDTH + 3
            self.gate = torch.nn.Sequential(
                torch.nn.LayerNorm(gate_width),
                torch.nn.Linear(gate_width, 24),
                torch.nn.GELU(),
                torch.nn.Linear(24, 1),
            )
            torch.nn.init.zeros_(self.page_scorer[-1].weight)
            torch.nn.init.zeros_(self.page_scorer[-1].bias)

        def forward(
            self,
            local_query: Any,
            anchor_family: Any,
            per_query: Any,
            anchor_body: Any,
        ) -> Mapping[str, Any]:
            local = torch.nn.functional.layer_norm(local_query.float(), (1024,))
            body_probability = torch.softmax(anchor_family.float(), dim=1)[:, 0]
            body_weight = body_probability / body_probability.sum().clamp_min(1e-6)
            page_query = (local * body_weight[:, None]).sum(dim=0, keepdim=True)
            page_query = torch.nn.functional.layer_norm(page_query, (1024,))
            page_hidden = torch.nn.functional.gelu(self.page(page_query))
            local_hidden = torch.nn.functional.gelu(self.local(local))
            page_local = page_hidden.expand(len(local), -1)
            difference = (local_hidden - page_local).abs()
            anchor_probabilities = torch.softmax(anchor_body.float(), dim=1)
            entropy = -(
                anchor_probabilities * torch.log_softmax(anchor_body.float(), dim=1)
            ).sum(dim=1, keepdim=True)
            maximum_probability = anchor_probabilities.amax(dim=1, keepdim=True)
            gate_features = torch.cat(
                (
                    local_hidden,
                    page_local,
                    difference,
                    entropy,
                    maximum_probability,
                    body_probability[:, None],
                ),
                dim=1,
            )
            trust = torch.sigmoid(self.gate(gate_features)).squeeze(1)
            page_per_query = (per_query * body_weight[:, None, None]).sum(
                dim=0, keepdim=True
            )
            page_anchor = (anchor_body.float() * body_weight[:, None]).sum(
                dim=0, keepdim=True
            )
            candidate = self.candidate_embedding(torch.arange(21, device=local.device))[
                None, :, :
            ]
            page_features = torch.cat(
                (
                    page_hidden[:, None, :].expand(-1, 21, -1),
                    page_per_query,
                    page_anchor[:, :, None],
                    candidate,
                ),
                dim=2,
            )
            page_delta = MAXIMUM_DELTA * torch.tanh(
                self.page_scorer(page_features).squeeze(2)
            )
            page_scores = page_anchor + page_delta
            support = (body_probability.sum() - 1.0).clamp(0.0, 1.0)
            applied = support * body_probability * trust
            scores = anchor_body.float() + applied[:, None] * (
                page_scores.expand(len(local), -1) - anchor_body.float()
            )
            return {
                "applied": applied,
                "anchor_body": anchor_body.float(),
                "body_candidate_scores": scores,
                "page_delta": page_delta,
                "page_scores": page_scores.squeeze(0),
                "support": support,
                "trust": trust,
            }

    return GatedPageExpert()


def _group_inputs(
    torch: Any,
    model: Any,
    family_model: Any,
    prepared: Mapping[str, Any],
    group: r34.PageGroup,
    identities: Mapping[str, Mapping[str, str]],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    family = r34.r33.r32.r31._family_logits(
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
        family,
        torch.as_tensor(r34.r33.r32._per_query(prepared, indices), device=device),
        prepared["cache"]["body_candidate_scores"][positions].to(device),
    )


def _consensus_target(
    torch: Any, tensors: Mapping[str, Any]
) -> tuple[Any, Any, Any, Any]:
    preferred = tensors["preferred_mask"]
    safe = tensors["safe_mask"]
    common_preferred = preferred.all(dim=0)
    common_safe = safe.all(dim=0)
    if bool(common_preferred.any()):
        consensus = common_preferred
    elif bool(common_safe.any()):
        consensus = common_safe
    else:
        votes = 2.0 * preferred.float().sum(dim=0) + safe.float().sum(dim=0)
        consensus = votes == votes.max()
    reviewed_union = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    ).any(dim=0)
    preferred_rows = preferred.any(dim=1)
    row_intent = torch.where(preferred_rows[:, None], preferred, safe)
    gate_target = (row_intent & consensus[None, :]).any(dim=1).float()
    return consensus, reviewed_union, gate_target, row_intent


def _group_loss(
    torch: Any,
    output: Mapping[str, Any],
    group: r34.PageGroup,
    *,
    device: Any,
) -> Mapping[str, Any]:
    body_rows = tuple(group.rows[position] for position in group.body_positions)
    positions = torch.as_tensor(group.body_positions, dtype=torch.long, device=device)
    scores = output["body_candidate_scores"][positions]
    anchor = output["anchor_body"][positions]
    tensors = r34.r33.r32.r31.r29.r23._tier_tensors(torch, body_rows, device=device)
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred_target = torch.where(
        preferred_rows[:, None], tensors["preferred_mask"], tensors["safe_mask"]
    )
    direct = 0.65 * r34._set_nll(torch, scores, preferred_target, reviewed)
    direct = direct + 0.35 * r34._set_nll(torch, scores, tensors["safe_mask"], reviewed)
    direct_loss = direct.mean()
    consensus, reviewed_union, gate_target, row_intent = _consensus_target(
        torch, tensors
    )
    page_loss = r34._set_nll(
        torch,
        output["page_scores"][None, :],
        consensus[None, :],
        reviewed_union[None, :],
    ).mean()
    positive = gate_target > 0.5
    consensus_loss = (
        r34._set_nll(
            torch,
            scores[positive],
            consensus[None, :] & row_intent[positive],
            reviewed[positive],
        ).mean()
        if bool(positive.any())
        else scores.sum() * 0.0
    )
    trust = output["trust"][positions]
    gate_loss = torch.nn.functional.binary_cross_entropy(trust, gate_target)
    exception = ~positive
    exception_loss = (
        torch.nn.functional.kl_div(
            torch.log_softmax(scores[exception].float(), dim=1),
            torch.softmax(anchor[exception].detach().float(), dim=1),
            reduction="batchmean",
        )
        if bool(exception.any())
        else scores.sum() * 0.0
    )
    delta_l2 = output["page_delta"].float().square().mean()
    total = (
        direct_loss
        + 0.55 * page_loss
        + 0.30 * consensus_loss
        + 0.30 * gate_loss
        + 1.00 * exception_loss
        + 0.002 * delta_l2
    )
    return {
        "consensus": consensus_loss,
        "direct": direct_loss,
        "exception": exception_loss,
        "gate": gate_loss,
        "page": page_loss,
        "total": total,
    }


def _train_model(
    torch: Any,
    prepared: Mapping[str, Any],
    family_model: Any,
    groups: Sequence[r34.PageGroup],
    identities: Mapping[str, Mapping[str, str]],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    model = _build_model(torch, seed=35_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=2e-4)
    work_counts: dict[str, int] = {}
    for group in groups:
        work_counts[group.work_id] = work_counts.get(group.work_id, 0) + 1
    history: dict[str, float] = {}
    for epoch in range(1, epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        weighted = []
        parts = {
            name: 0.0 for name in ("consensus", "direct", "exception", "gate", "page")
        }
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
                raise RuntimeError(f"non-finite R35 loss at page={group.page_id}")
            weight = 1.0 / (len(work_counts) * work_counts[group.work_id])
            weighted.append(losses["total"] * weight)
            for name in parts:
                parts[name] += float(losses[name].detach().item()) * weight
        total = torch.stack(weighted).sum()
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        if epoch == epochs:
            history = {**parts, "total": float(total.detach().item())}
    model.eval()
    return model, history


def _scores(
    torch: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    model: Any,
    family_model: Any,
    *,
    device: Any,
) -> Any:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    result = prepared["cache"]["body_candidate_scores"][positions].to(device).clone()
    row_position = {str(row["sample_id"]): i for i, row in enumerate(rows)}
    for group in r34._page_groups(rows, identities, require_multiple_body_rows=False):
        output = _group_inputs(
            torch,
            model,
            family_model,
            prepared,
            group,
            identities,
            device=device,
        )
        for local_position, row in enumerate(group.rows):
            result[row_position[str(row["sample_id"])]] = output[
                "body_candidate_scores"
            ][local_position]
    return result


def _fold(
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
    groups = r34._page_groups(train_rows, identities, require_multiple_body_rows=True)
    model, history = _train_model(
        torch,
        prepared,
        family_model,
        groups,
        identities,
        epochs=epochs,
        fold_index=fold_index,
        device=device,
    )
    baseline_model = r34._train_r33_baseline(
        torch,
        prepared,
        train_rows,
        identities,
        fold_index=fold_index,
        device=device,
    )
    anchor = r34._scores_for_rows(
        torch,
        prepared,
        heldout_rows,
        identities,
        context_model=None,
        family_model=family_model,
        r33_model=None,
        device=device,
    )["scores"]
    baseline = r34._scores_for_rows(
        torch,
        prepared,
        heldout_rows,
        identities,
        context_model=None,
        family_model=family_model,
        r33_model=baseline_model,
        device=device,
    )["scores"]
    candidate = _scores(
        torch,
        prepared,
        heldout_rows,
        identities,
        model,
        family_model,
        device=device,
    )
    candidate_ids = tuple(prepared["context"]["candidate_ids"])
    anchor_metrics = r34._metrics(
        torch, anchor, heldout_rows, identities, candidate_ids
    )
    baseline_metrics = r34._metrics(
        torch, baseline, heldout_rows, identities, candidate_ids
    )
    candidate_metrics = r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "anchor": anchor_metrics,
        "history": history,
        "r33": baseline_metrics,
        "r35": candidate_metrics,
        "r35_delta": r34._delta(candidate_metrics, anchor_metrics),
        "r35_vs_r33": r34._delta(candidate_metrics, baseline_metrics),
        "work_id": str(fold["heldout_work_id"]),
    }


def screen(
    device_name: str, *, fold_limit: int | None, epochs: int
) -> Mapping[str, Any]:
    import torch

    prepared = r34.r33.r32.r31.r29._prepare(torch)
    identities = r34._identity_maps(prepared)
    device = torch.device(device_name)
    family_model = r34._load_family_model(torch, device=device)
    source_folds = tuple(prepared["folds"])
    if fold_limit is not None:
        if fold_limit <= 0 or fold_limit > len(source_folds):
            raise ValueError("fold limit is outside available work folds")
        source_folds = source_folds[:fold_limit]
    folds = []
    for position, fold in enumerate(source_folds, start=1):
        folds.append(
            _fold(
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
            f"completed R35 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=35_000)
    parameter_count = sum(int(value.numel()) for value in model.parameters())
    return {
        "architecture": {
            "context": "learned_shared_page_expert",
            "learned_per_row_visual_exception_gate": True,
            "new_parameter_count": parameter_count,
        },
        "folds": folds,
        "macro": {
            "anchor": r34._macro(folds, "anchor"),
            "r33": r34._macro(folds, "r33"),
            "r35": r34._macro(folds, "r35"),
            "r35_delta": r34._macro(folds, "r35_delta"),
            "r35_vs_r33": r34._macro(folds, "r35_vs_r33"),
        },
        "production_eligible": False,
        "status": "r35_gated_page_expert_architecture_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=24)
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
