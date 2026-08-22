"""Screen a wider prototype-aware multi-style chapter set ranker.

Earlier chapter models learned candidate IDs from only ten training works.
R45 instead embeds the actual 1024-dimensional Korean font prototypes and the
source rows into a shared 128-dimensional matching space.  Four learned set
experts summarize the chapter, while every row retains its local token and R33
scores.  This is the first screen in this line that spends the user's expanded
CPU budget on a materially larger matching model rather than another scalar
gate or prior tweak.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_chapter_candidate_ranker_r41 as r41
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_chapter_candidate_ranker_r41 as r41


TOKEN_WIDTH = 128
EXPERT_COUNT = 4
SCORER_WIDTH = 96
MAXIMUM_DELTA = 4.0


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class PrototypeSetRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.source_encoder = torch.nn.Sequential(
                torch.nn.LayerNorm(1024),
                torch.nn.Linear(1024, TOKEN_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(TOKEN_WIDTH, TOKEN_WIDTH),
                torch.nn.LayerNorm(TOKEN_WIDTH),
            )
            self.candidate_encoder = torch.nn.Sequential(
                torch.nn.LayerNorm(1024),
                torch.nn.Linear(1024, TOKEN_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(TOKEN_WIDTH, TOKEN_WIDTH),
                torch.nn.LayerNorm(TOKEN_WIDTH),
            )
            self.assignment = torch.nn.Linear(TOKEN_WIDTH, EXPERT_COUNT)
            self.route = torch.nn.Linear(TOKEN_WIDTH, EXPERT_COUNT)
            feature_width = TOKEN_WIDTH * 4 + 4 + 1 + 1
            self.scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(feature_width),
                torch.nn.Linear(feature_width, SCORER_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(SCORER_WIDTH, 1),
            )
            torch.nn.init.zeros_(self.scorer[-1].weight)
            torch.nn.init.zeros_(self.scorer[-1].bias)

        def forward(
            self,
            local_query: Any,
            candidate_query: Any,
            per_query: Any,
            anchor_body: Any,
        ) -> Mapping[str, Any]:
            source = self.source_encoder(local_query.float())
            candidate = self.candidate_encoder(candidate_query.float())
            assignment = torch.softmax(self.assignment(source), dim=1)
            weights = assignment.transpose(0, 1)
            weights = weights / weights.sum(dim=1, keepdim=True).clamp_min(1e-6)
            experts = weights @ source
            route = torch.softmax(self.route(source), dim=1)
            context = route @ experts
            count = int(source.shape[0])
            local_expanded = source[:, None, :].expand(-1, 21, -1)
            context_expanded = context[:, None, :].expand(-1, 21, -1)
            candidate_expanded = candidate[None, :, :].expand(count, -1, -1)
            features = torch.cat(
                (
                    local_expanded * candidate_expanded,
                    context_expanded * candidate_expanded,
                    (local_expanded - candidate_expanded).abs(),
                    (context_expanded - candidate_expanded).abs(),
                    per_query.float(),
                    anchor_body.float()[:, :, None],
                    anchor_body.float()
                    .mean(dim=0)[None, :, None]
                    .expand(count, -1, -1),
                ),
                dim=2,
            )
            raw_delta = MAXIMUM_DELTA * torch.tanh(self.scorer(features).squeeze(2))
            delta = float(count > 1) * raw_delta
            return {
                "assignment": assignment,
                "body_candidate_scores": anchor_body.float() + delta,
                "context": context,
                "delta": delta,
                "route": route,
                "source": source,
            }

    return PrototypeSetRanker()


def _candidate_query(torch: Any, prepared: Mapping[str, Any], *, device: Any) -> Any:
    values = prepared["context"]["arrays"]["prototype_queries"].astype(
        np.float32, copy=True
    )
    values = values.reshape(len(values), -1)
    values /= np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-6)
    return torch.as_tensor(values, device=device)


def _group_inputs(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    group: Any,
    candidate_query: Any,
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
    anchor = torch.stack(
        [anchor_by_sample[str(row["sample_id"])] for row in group.rows]
    ).to(device)
    return model(
        torch.as_tensor(prepared["local_query"][indices], device=device),
        candidate_query,
        torch.as_tensor(
            r41.r36.r35.r34.r33.r32._per_query(prepared, indices), device=device
        ),
        anchor,
    )


def _group_loss(
    torch: Any,
    output: Mapping[str, Any],
    group: Any,
    *,
    device: Any,
) -> Mapping[str, Any]:
    body_rows = tuple(group.rows[position] for position in group.body_positions)
    positions = torch.as_tensor(group.body_positions, dtype=torch.long, device=device)
    scores = output["body_candidate_scores"][positions]
    assignments = output["assignment"][positions]
    tensors = r41.r36.r35.r34.r33.r32.r31.r29.r23._tier_tensors(
        torch, body_rows, device=device
    )
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    preferred = torch.where(
        tensors["preferred_mask"].any(dim=1, keepdim=True),
        tensors["preferred_mask"],
        tensors["safe_mask"],
    )
    direct = 0.65 * r41._set_nll(torch, scores, preferred, reviewed)
    direct += 0.35 * r41._set_nll(torch, scores, tensors["safe_mask"], reviewed)
    pair_losses = []
    assignment_losses = []
    for left in range(len(body_rows)):
        for right in range(left + 1, len(body_rows)):
            shared_reviewed = reviewed[left] & reviewed[right]
            shared_preferred = preferred[left] & preferred[right]
            shared_safe = tensors["safe_mask"][left] & tensors["safe_mask"][right]
            target = shared_preferred if bool(shared_preferred.any()) else shared_safe
            similarity = (
                (assignments[left] * assignments[right]).sum().clamp(1e-6, 1.0 - 1e-6)
            )
            if bool(target.any()) and bool(shared_reviewed.any()):
                assignment_losses.append(-torch.log(similarity))
                pair_scores = scores[[left, right]].masked_fill(
                    ~shared_reviewed[None, :], torch.finfo(scores.dtype).min
                )
                probability = torch.softmax(pair_scores.float(), dim=1)
                joint = torch.sqrt(
                    probability[0].clamp_min(1e-12) * probability[1].clamp_min(1e-12)
                )
                pair_losses.append(-torch.log(joint[target].sum().clamp_min(1e-8)))
            elif bool(shared_reviewed.any()):
                assignment_losses.append(-torch.log1p(-similarity))
    pair = torch.stack(pair_losses).mean() if pair_losses else scores.sum() * 0.0
    assignment = (
        torch.stack(assignment_losses).mean()
        if assignment_losses
        else scores.sum() * 0.0
    )
    residual = output["delta"][positions].square().mean()
    total = direct.mean() + 0.2 * pair + 0.08 * assignment + 0.001 * residual
    return {
        "assignment": assignment,
        "direct": direct.mean(),
        "pair": pair,
        "residual": residual,
        "total": total,
    }


def _train_model(
    torch: Any,
    prepared: Mapping[str, Any],
    groups: Sequence[Any],
    anchor_by_sample: Mapping[str, Any],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    model = _build_model(torch, seed=45_000 + fold_index).to(device)
    candidates = _candidate_query(torch, prepared, device=device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=4e-4, weight_decay=5e-4)
    work_counts: dict[str, int] = {}
    for group in groups:
        work_counts[group.work_id] = work_counts.get(group.work_id, 0) + 1
    history: dict[str, float] = {}
    for epoch in range(1, epochs + 1):
        optimizer.zero_grad(set_to_none=True)
        totals = []
        parts = {"assignment": 0.0, "direct": 0.0, "pair": 0.0, "residual": 0.0}
        for group in groups:
            output = _group_inputs(
                torch,
                model,
                prepared,
                group,
                candidates,
                anchor_by_sample,
                device=device,
            )
            losses = _group_loss(torch, output, group, device=device)
            weight = 1.0 / (len(work_counts) * work_counts[group.work_id])
            totals.append(losses["total"] * weight)
            for name in parts:
                parts[name] += float(losses[name].detach().item()) * weight
        total = torch.stack(totals).sum()
        if not bool(torch.isfinite(total)):
            raise RuntimeError(f"non-finite R45 loss at epoch {epoch}")
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        if epoch == epochs:
            history = {**parts, "total": float(total.detach().item())}
    return model.eval(), history


def _scores(
    torch: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    model: Any,
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Any:
    result = torch.stack([anchor_by_sample[str(row["sample_id"])] for row in rows])
    result = result.to(device).clone()
    row_position = {
        str(row["sample_id"]): position for position, row in enumerate(rows)
    }
    candidates = _candidate_query(torch, prepared, device=device)
    for group in r41.r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    ):
        output = _group_inputs(
            torch,
            model,
            prepared,
            group,
            candidates,
            anchor_by_sample,
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
    r33_model = r41.r36.r35.r34._train_r33_baseline(
        torch,
        prepared,
        train_rows,
        identities,
        fold_index=fold_index,
        device=device,
    )
    with torch.no_grad():
        train_r33 = r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            train_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
        heldout_r33 = r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            heldout_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
    train_anchor = r41.r36._score_map(train_rows, train_r33)
    heldout_anchor = r41.r36._score_map(heldout_rows, heldout_r33)
    groups = r41.r36._chapter_groups(
        train_rows, identities, require_multiple_body_rows=False
    )
    model, history = _train_model(
        torch,
        prepared,
        groups,
        train_anchor,
        epochs=epochs,
        fold_index=fold_index,
        device=device,
    )
    with torch.no_grad():
        candidate = _scores(
            torch,
            prepared,
            heldout_rows,
            identities,
            model,
            heldout_anchor,
            device=device,
        )
    candidate_ids = tuple(prepared["context"]["candidate_ids"])
    r33_metrics = r41.r36.r35.r34._metrics(
        torch, heldout_r33, heldout_rows, identities, candidate_ids
    )
    r45_metrics = r41.r36.r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "history": history,
        "r33": r33_metrics,
        "r45": r45_metrics,
        "r45_vs_r33": r41.r36.r35.r34._delta(r45_metrics, r33_metrics),
        "train_chapter_group_count": len(groups),
        "work_id": str(fold["heldout_work_id"]),
    }


def screen(
    device_name: str, *, fold_limit: int | None = None, epochs: int = 12
) -> Mapping[str, Any]:
    import torch

    prepared = r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r41.r36.r35.r34._identity_maps(prepared)
    device = torch.device(device_name)
    family_model = r41.r36.r35.r34._load_family_model(torch, device=device)
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
            f"completed R45 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=0)
    return {
        "architecture": {
            "additional_parameter_count": sum(
                int(value.numel()) for value in model.parameters()
            ),
            "candidate_input": "actual_frozen_korean_font_prototype_queries_1024",
            "chapter_style_expert_count": EXPERT_COUNT,
            "context": "prototype_aware_multi_style_deep_set",
        },
        "data": {
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "r33": r41.r36.r35.r34._macro(folds, "r33"),
            "r45": r41.r36.r35.r34._macro(folds, "r45"),
            "r45_vs_r33": r41.r36.r35.r34._macro(folds, "r45_vs_r33"),
        },
        "production_eligible": False,
        "status": "r45_prototype_set_ranker_architecture_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=12)
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
