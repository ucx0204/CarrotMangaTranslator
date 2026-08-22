"""Screen a shared source-style chapter prior over the local R33 scores.

R42 mixed a local style metric and a chapter style metric at equal strength.
The first real-page render showed that the local term preserved the unwanted
font oscillation.  R44 removes only that row-specific metric: every row keeps
its complete R33 score vector, while one learned chapter prior is added to all
rows.  A strong local source exception can therefore still win, but near-tied
ordinary dialogue receives the same learned identity signal.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from scripts import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42


MAXIMUM_DELTA = 4.0


def _build_model(torch: Any, candidate_style: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class ChapterStylePrior(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.register_buffer("candidate_style", candidate_style.detach().clone())
            self.chapter_axis_logits = torch.nn.Parameter(torch.zeros(10))
            self.candidate_bias = torch.nn.Parameter(torch.zeros(21))
            self.chapter_strength = torch.nn.Parameter(torch.tensor(0.5))

        def forward(self, source_style: Any, anchor_body: Any) -> Mapping[str, Any]:
            count = int(source_style.shape[0])
            chapter_style = source_style.mean(dim=0, keepdim=True)
            chapter_distance = (
                chapter_style[:, None, :] - self.candidate_style[None, :, :]
            ).square()
            axis_weight = 10.0 * torch.softmax(self.chapter_axis_logits, dim=0)
            chapter_metric = -(chapter_distance * axis_weight).mean(dim=2)
            chapter_metric -= chapter_metric.mean(dim=1, keepdim=True)
            metric = (
                torch.nn.functional.softplus(self.chapter_strength) * chapter_metric
                + self.candidate_bias[None, :]
            )
            raw_delta = (MAXIMUM_DELTA * torch.tanh(metric)).expand(count, -1)
            delta = float(count > 1) * raw_delta
            return {
                "body_candidate_scores": anchor_body.float() + delta,
                "chapter_style": chapter_style,
                "delta": delta,
                "raw_delta": raw_delta,
            }

    return ChapterStylePrior()


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
    candidate_style = r42._candidate_style(torch, prepared, style_model, device=device)
    model = _build_model(torch, candidate_style, seed=44_000 + fold_index).to(device)
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
            output = r42._group_inputs(
                torch,
                model,
                style_model,
                prepared,
                group,
                anchor_by_sample,
                device=device,
            )
            losses = r42._group_loss(torch, output, group, device=device)
            weight = 1.0 / (len(work_counts) * work_counts[group.work_id])
            totals.append(losses["total"] * weight)
            for name in parts:
                parts[name] += float(losses[name].detach().item()) * weight
        total = torch.stack(totals).sum()
        if not bool(torch.isfinite(total)):
            raise RuntimeError(f"non-finite R44 loss at epoch {epoch}")
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        if epoch == epochs:
            history = {**parts, "total": float(total.detach().item())}
    return model.eval(), history


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
        candidate = r42._scores(
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
    r44_metrics = r42.r41.r36.r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "history": history,
        "r33": r33_metrics,
        "r44": r44_metrics,
        "r44_vs_r33": r42.r41.r36.r35.r34._delta(r44_metrics, r33_metrics),
        "train_chapter_group_count": len(groups),
        "work_id": heldout_work,
    }


def screen(
    device_name: str, *, fold_limit: int | None = None, epochs: int = 12
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
            f"completed R44 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    style_parameters = sum(
        int(value.numel())
        for value in r42.r40.r39._build_model(torch, seed=0).parameters()
    )
    return {
        "architecture": {
            "additional_parameter_count": style_parameters + 32,
            "context": "shared_chapter_source_style_prior_plus_unchanged_local_r33",
        },
        "data": {
            "style_training_rows": len(style_examples),
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "r33": r42.r41.r36.r35.r34._macro(folds, "r33"),
            "r44": r42.r41.r36.r35.r34._macro(folds, "r44"),
            "r44_vs_r33": r42.r41.r36.r35.r34._macro(folds, "r44_vs_r33"),
        },
        "production_eligible": False,
        "status": "r44_chapter_style_prior_architecture_screen",
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
