"""Screen a learned chapter-identity blend with source-style exceptions.

R42 directly adds local and chapter style metrics, which improves style
matching but does not make ordinary dialogue share a stable chapter identity.
R43 instead forms one chapter candidate distribution from the mean R33 scores
and predicted source style, then learns a per-row trust gate.  The gate is
trained from reviewed candidate compatibility and source-style deviation, so a
real visual exception can keep its local R33 decision rather than being forced
into the chapter font.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42


STYLE_DELTA_LIMIT = 3.0


def _build_model(torch: Any, candidate_style: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class StyleGatedChapterBlend(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.register_buffer("candidate_style", candidate_style.detach().clone())
            self.axis_logits = torch.nn.Parameter(torch.zeros(10))
            self.style_strength = torch.nn.Parameter(torch.tensor(0.25))
            self.gate = torch.nn.Sequential(
                torch.nn.LayerNorm(35),
                torch.nn.Linear(35, 16),
                torch.nn.GELU(),
                torch.nn.Linear(16, 1),
            )
            torch.nn.init.constant_(self.gate[-1].bias, -0.75)

        def forward(self, source_style: Any, anchor_body: Any) -> Mapping[str, Any]:
            count = int(source_style.shape[0])
            chapter_style = source_style.mean(dim=0, keepdim=True)
            chapter_anchor = anchor_body.float().mean(dim=0, keepdim=True)
            distance = (
                chapter_style[:, None, :] - self.candidate_style[None, :, :]
            ).square()
            axis_weight = 10.0 * torch.softmax(self.axis_logits, dim=0)
            style_metric = -(distance * axis_weight).mean(dim=2)
            style_metric -= style_metric.mean(dim=1, keepdim=True)
            style_delta = STYLE_DELTA_LIMIT * torch.tanh(
                torch.nn.functional.softplus(self.style_strength) * style_metric
            )
            common_scores = chapter_anchor + style_delta

            probability = torch.softmax(anchor_body.float(), dim=1)
            chapter_probability = probability.mean(dim=0, keepdim=True)
            entropy = -(probability * torch.log(probability.clamp_min(1e-8))).sum(
                dim=1, keepdim=True
            )
            maximum = probability.amax(dim=1, keepdim=True)
            distribution_distance = (
                (probability - chapter_probability).abs().mean(dim=1, keepdim=True)
            )
            same_top = (
                probability.argmax(dim=1, keepdim=True)
                == chapter_probability.argmax(dim=1, keepdim=True)
            ).float()
            repeated_chapter = chapter_style.expand(count, -1)
            gate_features = torch.cat(
                (
                    source_style,
                    repeated_chapter,
                    (source_style - repeated_chapter).abs(),
                    entropy,
                    maximum,
                    distribution_distance,
                    same_top,
                    torch.full_like(maximum, float(count > 1)),
                ),
                dim=1,
            )
            trust = torch.sigmoid(self.gate(gate_features)).squeeze(1)
            trust = trust * float(count > 1)
            delta = trust[:, None] * (common_scores - anchor_body.float())
            return {
                "body_candidate_scores": anchor_body.float() + delta,
                "chapter_style": chapter_style,
                "common_scores": common_scores,
                "delta": delta,
                "style_delta": style_delta,
                "trust": trust,
            }

    return StyleGatedChapterBlend()


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
    trust = output["trust"][positions]
    tensors = r42.r41.r36.r35.r34.r33.r32.r31.r29.r23._tier_tensors(
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
    direct = 0.65 * r42.r41._set_nll(torch, scores, preferred, reviewed)
    direct += 0.35 * r42.r41._set_nll(torch, scores, tensors["safe_mask"], reviewed)
    compatible = [False] * len(body_rows)
    pairs = []
    for left in range(len(body_rows)):
        for right in range(left + 1, len(body_rows)):
            shared_reviewed = reviewed[left] & reviewed[right]
            shared_preferred = preferred[left] & preferred[right]
            shared_safe = tensors["safe_mask"][left] & tensors["safe_mask"][right]
            target = shared_preferred if bool(shared_preferred.any()) else shared_safe
            if not bool(target.any()) or not bool(shared_reviewed.any()):
                continue
            compatible[left] = True
            compatible[right] = True
            pair_scores = scores[[left, right]].masked_fill(
                ~shared_reviewed[None, :], torch.finfo(scores.dtype).min
            )
            probability = torch.softmax(pair_scores.float(), dim=1)
            joint = torch.sqrt(
                probability[0].clamp_min(1e-12) * probability[1].clamp_min(1e-12)
            )
            pairs.append(-torch.log(joint[target].sum().clamp_min(1e-8)))
    pair = torch.stack(pairs).mean() if pairs else scores.sum() * 0.0
    gate_target = torch.as_tensor([float(value) for value in compatible], device=device)
    gate = torch.nn.functional.binary_cross_entropy(trust, gate_target)
    residual = output["delta"][positions].square().mean()
    total = direct.mean() + 0.2 * pair + 0.12 * gate + 0.001 * residual
    return {
        "direct": direct.mean(),
        "gate": gate,
        "pair": pair,
        "residual": residual,
        "total": total,
    }


def _train_model(
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
    candidates = r42._candidate_style(torch, prepared, style_model, device=device)
    model = _build_model(torch, candidates, seed=43_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=5e-4)
    work_counts: dict[str, int] = {}
    for group in groups:
        work_counts[group.work_id] = work_counts.get(group.work_id, 0) + 1
    history: dict[str, float] = {}
    for epoch in range(1, epochs + 1):
        optimizer.zero_grad(set_to_none=True)
        totals = []
        parts = {"direct": 0.0, "gate": 0.0, "pair": 0.0, "residual": 0.0}
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
            raise RuntimeError(f"non-finite R43 loss at epoch {epoch}")
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
    for group in r42.r41.r36._chapter_groups(
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
    style_model = r42.r40._train_style_model(
        torch,
        prepared,
        style_examples,
        heldout_work,
        fold_index=fold_index,
        device=device,
        epochs=160,
    )
    r33_model = r42.r41.r36.r35.r34._train_r33_baseline(
        torch,
        prepared,
        train_rows,
        identities,
        fold_index=fold_index,
        device=device,
    )
    with torch.no_grad():
        train_r33 = r42.r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            train_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
        heldout_r33 = r42.r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            heldout_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
    train_anchor = r42.r41.r36._score_map(train_rows, train_r33)
    heldout_anchor = r42.r41.r36._score_map(heldout_rows, heldout_r33)
    groups = r42.r41.r36._chapter_groups(
        train_rows, identities, require_multiple_body_rows=False
    )
    model, history = _train_model(
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
    r33_metrics = r42.r41.r36.r35.r34._metrics(
        torch, heldout_r33, heldout_rows, identities, candidate_ids
    )
    r43_metrics = r42.r41.r36.r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "history": history,
        "r33": r33_metrics,
        "r43": r43_metrics,
        "r43_vs_r33": r42.r41.r36.r35.r34._delta(r43_metrics, r33_metrics),
        "train_chapter_group_count": len(groups),
        "work_id": heldout_work,
    }


def screen(
    device_name: str, *, fold_limit: int | None = None, epochs: int = 24
) -> Mapping[str, Any]:
    import torch

    prepared = r42.r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r42.r41.r36.r35.r34._identity_maps(prepared)
    style_examples = tuple(r42.r40.r39._examples(prepared))
    device = torch.device(device_name)
    family_model = r42.r41.r36.r35.r34._load_family_model(torch, device=device)
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
            f"completed R43 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    probe = _build_model(
        torch,
        torch.zeros((21, 10), dtype=torch.float32),
        seed=0,
    )
    return {
        "architecture": {
            "additional_parameter_count": sum(
                int(value.numel()) for value in probe.parameters()
            )
            + sum(
                int(value.numel())
                for value in r42.r40.r39._build_model(torch, seed=0).parameters()
            ),
            "context": "chapter_mean_anchor_plus_style_with_learned_row_exception_gate",
        },
        "data": {
            "style_training_rows": len(style_examples),
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "r33": r42.r41.r36.r35.r34._macro(folds, "r33"),
            "r43": r42.r41.r36.r35.r34._macro(folds, "r43"),
            "r43_vs_r33": r42.r41.r36.r35.r34._macro(folds, "r43_vs_r33"),
        },
        "production_eligible": False,
        "status": "r43_style_gated_chapter_blend_architecture_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--fold-limit", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.epochs <= 0 or args.epochs > 100:
        raise ValueError("epochs must be between 1 and 100")
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
