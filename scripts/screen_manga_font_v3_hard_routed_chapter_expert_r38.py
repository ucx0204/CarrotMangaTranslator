"""Screen a hard-routed learned chapter expert on top of R33.

The single learned chapter expert in R36 substantially reduced chapter font
switching, but its soft gate leaked a fraction of the common expert into rows
the gate considered visual exceptions.  This screen keeps the same learned
expert and learned gate, then uses a straight-through binary route during
training and an exact binary route at evaluation.  Gate-negative rows retain
their frozen R33 candidate scores byte-for-byte; gate-positive rows use the
learned chapter expert.  The route is model-predicted, not a font rule.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from scripts import screen_manga_font_v3_gated_chapter_expert_r36 as r36
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_gated_chapter_expert_r36 as r36


def _build_model(torch: Any, *, seed: int) -> Any:
    class HardRoutedChapterExpert(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.base = r36.r35._build_model(torch, seed=seed)

        def forward(
            self,
            local_query: Any,
            anchor_family: Any,
            per_query: Any,
            anchor_body: Any,
        ) -> Mapping[str, Any]:
            output = dict(self.base(local_query, anchor_family, per_query, anchor_body))
            trust = output["trust"]
            hard_route = (trust >= 0.5).to(trust.dtype)
            route = hard_route + trust - trust.detach() if self.training else hard_route
            body_probability = torch.softmax(anchor_family.float(), dim=1)[:, 0]
            applied = output["support"] * body_probability * route
            scores = output["anchor_body"] + applied[:, None] * (
                output["page_scores"][None, :] - output["anchor_body"]
            )
            output.update(
                {
                    "applied": applied,
                    "body_candidate_scores": scores,
                    "hard_route": hard_route,
                    "route": route,
                }
            )
            return output

    return HardRoutedChapterExpert()


def _train_model(
    torch: Any,
    prepared: Mapping[str, Any],
    family_model: Any,
    groups: Sequence[r36.r35.r34.PageGroup],
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    model = _build_model(torch, seed=38_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=7e-4, weight_decay=2e-4)
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
            output = r36._group_inputs(
                torch,
                model,
                family_model,
                prepared,
                group,
                identities,
                anchor_by_sample,
                device=device,
            )
            losses = r36.r35._group_loss(torch, output, group, device=device)
            if not bool(torch.isfinite(losses["total"])):
                raise RuntimeError(f"non-finite R38 loss at chapter={group.chapter_id}")
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
    r33_model = r36.r35.r34._train_r33_baseline(
        torch,
        prepared,
        train_rows,
        identities,
        fold_index=fold_index,
        device=device,
    )
    with torch.no_grad():
        train_r33 = r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            train_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
        heldout_anchor = r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            heldout_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=None,
            device=device,
        )["scores"]
        heldout_r33 = r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            heldout_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
    train_anchor_by_sample = r36._score_map(train_rows, train_r33)
    heldout_anchor_by_sample = r36._score_map(heldout_rows, heldout_r33)
    train_groups = r36._chapter_groups(
        train_rows, identities, require_multiple_body_rows=True
    )
    model, history = _train_model(
        torch,
        prepared,
        family_model,
        train_groups,
        identities,
        train_anchor_by_sample,
        epochs=epochs,
        fold_index=fold_index,
        device=device,
    )
    with torch.no_grad():
        candidate = r36._scores(
            torch,
            prepared,
            heldout_rows,
            identities,
            model,
            family_model,
            heldout_anchor_by_sample,
            device=device,
        )
    candidate_ids = tuple(prepared["context"]["candidate_ids"])
    anchor_metrics = r36.r35.r34._metrics(
        torch, heldout_anchor, heldout_rows, identities, candidate_ids
    )
    r33_metrics = r36.r35.r34._metrics(
        torch, heldout_r33, heldout_rows, identities, candidate_ids
    )
    candidate_metrics = r36.r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "anchor": anchor_metrics,
        "history": history,
        "r33": r33_metrics,
        "r38": candidate_metrics,
        "r38_delta": r36.r35.r34._delta(candidate_metrics, anchor_metrics),
        "r38_vs_r33": r36.r35.r34._delta(candidate_metrics, r33_metrics),
        "train_chapter_group_count": len(train_groups),
        "work_id": str(fold["heldout_work_id"]),
    }


def screen(
    device_name: str, *, fold_limit: int | None, epochs: int
) -> Mapping[str, Any]:
    import torch

    prepared = r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r36.r35.r34._identity_maps(prepared)
    device = torch.device(device_name)
    family_model = r36.r35.r34._load_family_model(torch, device=device)
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
            f"completed R38 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=38_000)
    parameter_count = sum(int(value.numel()) for value in model.parameters())
    return {
        "architecture": {
            "anchor": "fold_trained_r33_page_ranker",
            "context": "learned_shared_chapter_expert",
            "evaluation_route": "hard_binary_neural_gate",
            "new_parameter_count": parameter_count,
            "training_route": "straight_through_binary_neural_gate",
        },
        "data": {
            "training_only": True,
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "anchor": r36.r35.r34._macro(folds, "anchor"),
            "r33": r36.r35.r34._macro(folds, "r33"),
            "r38": r36.r35.r34._macro(folds, "r38"),
            "r38_delta": r36.r35.r34._macro(folds, "r38_delta"),
            "r38_vs_r33": r36.r35.r34._macro(folds, "r38_vs_r33"),
        },
        "production_eligible": False,
        "status": "r38_hard_routed_chapter_expert_architecture_screen",
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
