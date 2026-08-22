"""Screen an explicit source-to-candidate style metric over the R33 anchor.

The current ranker compares opaque embeddings and R40 only used source style
to drive an apply/keep gate.  This screen instead predicts the same ten style
axes for source rows and Korean candidate prototypes, then learns a small
candidate metric using both local and chapter style distances.  Every row gets
its own candidate residual, so chapter consistency and expressive exceptions
are represented continuously rather than by a binary common-font switch.
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
    from scripts import screen_manga_font_v3_style_aware_chapter_expert_r40 as r40
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_chapter_candidate_ranker_r41 as r41
    import screen_manga_font_v3_style_aware_chapter_expert_r40 as r40


MAXIMUM_DELTA = 4.0


def _build_model(torch: Any, candidate_style: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class StyleMetricChapterRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.register_buffer("candidate_style", candidate_style.detach().clone())
            self.local_axis_logits = torch.nn.Parameter(torch.zeros(10))
            self.chapter_axis_logits = torch.nn.Parameter(torch.zeros(10))
            self.candidate_bias = torch.nn.Parameter(torch.zeros(21))
            self.local_strength = torch.nn.Parameter(torch.tensor(0.5))
            self.chapter_strength = torch.nn.Parameter(torch.tensor(0.5))

        def forward(self, source_style: Any, anchor_body: Any) -> Mapping[str, Any]:
            count = int(source_style.shape[0])
            chapter_style = source_style.mean(dim=0, keepdim=True)
            local_distance = (
                source_style[:, None, :] - self.candidate_style[None, :, :]
            ).square()
            chapter_distance = (
                chapter_style[:, None, :] - self.candidate_style[None, :, :]
            ).square()
            local_weight = 10.0 * torch.softmax(self.local_axis_logits, dim=0)
            chapter_weight = 10.0 * torch.softmax(self.chapter_axis_logits, dim=0)
            local_metric = -(local_distance * local_weight).mean(dim=2)
            chapter_metric = -(chapter_distance * chapter_weight).mean(dim=2)
            local_metric -= local_metric.mean(dim=1, keepdim=True)
            chapter_metric -= chapter_metric.mean(dim=1, keepdim=True)
            metric = (
                torch.nn.functional.softplus(self.local_strength) * local_metric
                + torch.nn.functional.softplus(self.chapter_strength) * chapter_metric
                + self.candidate_bias[None, :]
            )
            raw_delta = MAXIMUM_DELTA * torch.tanh(metric)
            support = float(count > 1)
            delta = support * raw_delta
            return {
                "body_candidate_scores": anchor_body.float() + delta,
                "chapter_style": chapter_style,
                "delta": delta,
                "local_metric": local_metric,
                "raw_delta": raw_delta,
            }

    return StyleMetricChapterRanker()


def _candidate_style(
    torch: Any, prepared: Mapping[str, Any], style_model: Any, *, device: Any
) -> Any:
    prototypes = prepared["context"]["arrays"]["prototype_queries"]
    query = torch.as_tensor(prototypes.reshape(len(prototypes), -1), device=device)
    with torch.no_grad():
        return style_model(query)


def _group_inputs(
    torch: Any,
    model: Any,
    style_model: Any,
    prepared: Mapping[str, Any],
    group: Any,
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
    with torch.no_grad():
        source_style = style_model(
            torch.as_tensor(prepared["local_query"][indices], device=device)
        )
    anchor = torch.stack(
        [anchor_by_sample[str(row["sample_id"])] for row in group.rows]
    ).to(device)
    return model(source_style, anchor)


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
    direct_rows = 0.65 * r41._set_nll(torch, scores, preferred, reviewed)
    direct_rows += 0.35 * r41._set_nll(torch, scores, tensors["safe_mask"], reviewed)
    direct = direct_rows.mean()
    pairs = []
    for left in range(len(body_rows)):
        for right in range(left + 1, len(body_rows)):
            shared_reviewed = reviewed[left] & reviewed[right]
            shared_preferred = preferred[left] & preferred[right]
            shared_safe = tensors["safe_mask"][left] & tensors["safe_mask"][right]
            target = shared_preferred if bool(shared_preferred.any()) else shared_safe
            if not bool(target.any()) or not bool(shared_reviewed.any()):
                continue
            pair_scores = scores[[left, right]].masked_fill(
                ~shared_reviewed[None, :], torch.finfo(scores.dtype).min
            )
            probability = torch.softmax(pair_scores.float(), dim=1)
            joint = torch.sqrt(
                probability[0].clamp_min(1e-12) * probability[1].clamp_min(1e-12)
            )
            pairs.append(-torch.log(joint[target].sum().clamp_min(1e-8)))
    pair = torch.stack(pairs).mean() if pairs else scores.sum() * 0.0
    residual = output["delta"][positions].square().mean()
    return {
        "direct": direct,
        "pair": pair,
        "residual": residual,
        "total": direct + 0.15 * pair + 0.001 * residual,
    }


def _train_metric(
    torch: Any,
    prepared: Mapping[str, Any],
    style_model: Any,
    groups: Sequence[Any],
    anchor_by_sample: Mapping[str, Any],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    candidates = _candidate_style(torch, prepared, style_model, device=device)
    model = _build_model(torch, candidates, seed=42_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-2, weight_decay=2e-4)
    work_counts: dict[str, int] = {}
    for group in groups:
        work_counts[group.work_id] = work_counts.get(group.work_id, 0) + 1
    history: dict[str, float] = {}
    for epoch in range(1, epochs + 1):
        optimizer.zero_grad(set_to_none=True)
        totals = []
        parts = {"direct": 0.0, "pair": 0.0, "residual": 0.0}
        for group in groups:
            output = _group_inputs(
                torch,
                model,
                style_model,
                prepared,
                group,
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
            raise RuntimeError(f"non-finite R42 loss at epoch {epoch}")
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
    style_model: Any,
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Any:
    result = torch.stack([anchor_by_sample[str(row["sample_id"])] for row in rows])
    result = result.to(device).clone()
    row_position = {
        str(row["sample_id"]): position for position, row in enumerate(rows)
    }
    for group in r41.r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    ):
        output = _group_inputs(
            torch,
            model,
            style_model,
            prepared,
            group,
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
    style_examples: Sequence[Mapping[str, Any]],
    family_model: Any,
    fold: Mapping[str, Any],
    identities: Mapping[str, Mapping[str, str]],
    *,
    epochs: int,
    device: Any,
) -> Mapping[str, Any]:
    fold_index = int(fold["contract"]["fold_index"])
    heldout_work = str(fold["heldout_work_id"])
    train_rows = tuple(fold["train_rows"])
    heldout_rows = tuple(fold["heldout_rows"])
    style_model = r40._train_style_model(
        torch,
        prepared,
        style_examples,
        heldout_work,
        fold_index=fold_index,
        device=device,
        epochs=160,
    )
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
    model, history = _train_metric(
        torch,
        prepared,
        style_model,
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
            style_model,
            heldout_anchor,
            device=device,
        )
    candidate_ids = tuple(prepared["context"]["candidate_ids"])
    r33_metrics = r41.r36.r35.r34._metrics(
        torch, heldout_r33, heldout_rows, identities, candidate_ids
    )
    r42_metrics = r41.r36.r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "history": history,
        "r33": r33_metrics,
        "r42": r42_metrics,
        "r42_vs_r33": r41.r36.r35.r34._delta(r42_metrics, r33_metrics),
        "train_chapter_group_count": len(groups),
        "work_id": heldout_work,
    }


def screen(
    device_name: str, *, fold_limit: int | None = None, epochs: int = 64
) -> Mapping[str, Any]:
    import torch

    prepared = r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r41.r36.r35.r34._identity_maps(prepared)
    style_examples = tuple(r40.r39._examples(prepared))
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
                style_examples,
                family_model,
                fold,
                identities,
                epochs=epochs,
                device=device,
            )
        )
        print(
            f"completed R42 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    style_parameters = sum(
        int(value.numel()) for value in r40.r39._build_model(torch, seed=0).parameters()
    )
    metric_parameters = 10 + 10 + 21 + 2
    return {
        "architecture": {
            "additional_parameter_count": style_parameters + metric_parameters,
            "anchor": "fold_trained_r33_page_ranker",
            "context": "shared_style_space_local_plus_chapter_candidate_metric",
            "estimated_total_parameter_ratio_vs_r33": (
                124_000 + style_parameters + metric_parameters
            )
            / 124_000,
        },
        "data": {
            "style_training_rows": len(style_examples),
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "r33": r41.r36.r35.r34._macro(folds, "r33"),
            "r42": r41.r36.r35.r34._macro(folds, "r42"),
            "r42_vs_r33": r41.r36.r35.r34._macro(folds, "r42_vs_r33"),
        },
        "production_eligible": False,
        "status": "r42_style_metric_chapter_ranker_architecture_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=64)
    parser.add_argument("--fold-limit", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.epochs <= 0 or args.epochs > 160:
        raise ValueError("epochs must be between 1 and 160")
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
