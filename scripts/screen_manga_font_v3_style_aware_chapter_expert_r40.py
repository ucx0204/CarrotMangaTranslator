"""Screen a source-style-aware hard-routed chapter expert on R33.

R39 establishes that a small head can recover the source-style axes discarded
by the v8/R33 runtime on unseen works.  This screen trains that style head only
on non-heldout works, freezes it, and feeds its predictions to the R38 learned
chapter gate.  The chapter expert still selects fonts from pixels; the explicit
style delta helps the gate distinguish ordinary continuity from a real visual
typography change.  Gate-negative rows retain their R33 scores exactly.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_hard_routed_chapter_expert_r38 as r38
    from scripts import screen_manga_font_v3_source_style_head_r39 as r39
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_hard_routed_chapter_expert_r38 as r38
    import screen_manga_font_v3_source_style_head_r39 as r39
r36 = r38.r36


def _train_style_model(
    torch: Any,
    prepared: Mapping[str, Any],
    examples: Sequence[Mapping[str, Any]],
    heldout_work: str,
    *,
    fold_index: int,
    device: Any,
    epochs: int = 160,
) -> Any:
    train = tuple(row for row in examples if row["work_id"] != heldout_work)
    indices = np.asarray([row["row_index"] for row in train], dtype=np.int64)
    query = torch.as_tensor(prepared["local_query"][indices], device=device)
    target = torch.as_tensor(np.stack([row["target"] for row in train]), device=device)
    mask = torch.as_tensor(np.stack([row["mask"] for row in train]), device=device)
    work_counts: dict[str, int] = {}
    for row in train:
        work_counts[row["work_id"]] = work_counts.get(row["work_id"], 0) + 1
    weights = torch.as_tensor(
        [1.0 / (len(work_counts) * work_counts[row["work_id"]]) for row in train],
        dtype=torch.float32,
        device=device,
    )
    model = r39._build_model(torch, seed=40_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=5e-3)
    for _ in range(epochs):
        prediction = model(query)
        squared = (prediction - target).square() * mask
        per_row = squared.sum(dim=1) / mask.sum(dim=1).clamp_min(1)
        loss = torch.sum(per_row * weights)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
    model.requires_grad_(False).eval()
    return model


def _build_model(torch: Any, *, seed: int) -> Any:
    class StyleAwareChapterExpert(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.base = r36.r35._build_model(torch, seed=seed)
            self.style_gate = torch.nn.Sequential(
                torch.nn.LayerNorm(len(r39.STYLE_FIELDS) * 3),
                torch.nn.Linear(len(r39.STYLE_FIELDS) * 3, 16),
                torch.nn.GELU(),
                torch.nn.Linear(16, 1),
            )
            torch.nn.init.zeros_(self.style_gate[-1].weight)
            torch.nn.init.zeros_(self.style_gate[-1].bias)

        def forward(
            self,
            local_query: Any,
            anchor_family: Any,
            per_query: Any,
            anchor_body: Any,
            source_style: Any,
        ) -> Mapping[str, Any]:
            output = dict(self.base(local_query, anchor_family, per_query, anchor_body))
            body_probability = torch.softmax(anchor_family.float(), dim=1)[:, 0]
            body_weight = body_probability / body_probability.sum().clamp_min(1e-6)
            chapter_style = (source_style.float() * body_weight[:, None]).sum(
                dim=0, keepdim=True
            )
            chapter_rows = chapter_style.expand(len(source_style), -1)
            style_features = torch.cat(
                (
                    source_style.float(),
                    chapter_rows,
                    (source_style.float() - chapter_rows).abs(),
                ),
                dim=1,
            )
            base_trust = output["trust"].clamp(1e-5, 1.0 - 1e-5)
            trust = torch.sigmoid(
                torch.logit(base_trust) + self.style_gate(style_features).squeeze(1)
            )
            hard_route = (trust >= 0.5).to(trust.dtype)
            route = hard_route + trust - trust.detach() if self.training else hard_route
            applied = output["support"] * body_probability * route
            scores = output["anchor_body"] + applied[:, None] * (
                output["page_scores"][None, :] - output["anchor_body"]
            )
            output.update(
                {
                    "applied": applied,
                    "body_candidate_scores": scores,
                    "chapter_style": chapter_style.squeeze(0),
                    "hard_route": hard_route,
                    "route": route,
                    "source_style": source_style,
                    "trust": trust,
                }
            )
            return output

    return StyleAwareChapterExpert()


def _group_inputs(
    torch: Any,
    model: Any,
    style_model: Any,
    family_model: Any,
    prepared: Mapping[str, Any],
    group: r36.r35.r34.PageGroup,
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    local_tensor = torch.as_tensor(local, device=device)
    family = r36.r35.r34.r33.r32.r31._family_logits(
        torch,
        family_model,
        prepared,
        group.rows,
        identities["page"],
        "local",
        device=device,
    )
    anchor = torch.stack(
        [anchor_by_sample[str(row["sample_id"])] for row in group.rows]
    ).to(device)
    with torch.no_grad():
        style = style_model(local_tensor)
    return model(
        local_tensor,
        family,
        torch.as_tensor(
            r36.r35.r34.r33.r32._per_query(prepared, indices), device=device
        ),
        anchor,
        style,
    )


def _train_model(
    torch: Any,
    prepared: Mapping[str, Any],
    style_model: Any,
    family_model: Any,
    groups: Sequence[r36.r35.r34.PageGroup],
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    model = _build_model(torch, seed=40_000 + fold_index).to(device)
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
            output = _group_inputs(
                torch,
                model,
                style_model,
                family_model,
                prepared,
                group,
                identities,
                anchor_by_sample,
                device=device,
            )
            losses = r36.r35._group_loss(torch, output, group, device=device)
            if not bool(torch.isfinite(losses["total"])):
                raise RuntimeError(f"non-finite R40 loss at chapter={group.chapter_id}")
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
    style_model: Any,
    family_model: Any,
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Any:
    result = torch.stack([anchor_by_sample[str(row["sample_id"])] for row in rows]).to(
        device
    )
    result = result.clone()
    row_position = {
        str(row["sample_id"]): position for position, row in enumerate(rows)
    }
    for group in r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    ):
        output = _group_inputs(
            torch,
            model,
            style_model,
            family_model,
            prepared,
            group,
            identities,
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
    style_model = _train_style_model(
        torch,
        prepared,
        style_examples,
        heldout_work,
        fold_index=fold_index,
        device=device,
    )
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
        style_model,
        family_model,
        train_groups,
        identities,
        train_anchor_by_sample,
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
        "r40": candidate_metrics,
        "r40_delta": r36.r35.r34._delta(candidate_metrics, anchor_metrics),
        "r40_vs_r33": r36.r35.r34._delta(candidate_metrics, r33_metrics),
        "train_chapter_group_count": len(train_groups),
        "work_id": heldout_work,
    }


def screen(
    device_name: str, *, fold_limit: int | None, epochs: int
) -> Mapping[str, Any]:
    import torch

    prepared = r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    style_examples = r39._examples(prepared)
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
                style_examples,
                family_model,
                fold,
                identities,
                epochs=epochs,
                device=device,
            )
        )
        print(
            f"completed R40 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    chapter_model = _build_model(torch, seed=40_000)
    style_model = r39._build_model(torch, seed=40_000)
    return {
        "architecture": {
            "anchor": "fold_trained_r33_page_ranker",
            "chapter_parameter_count": sum(
                int(value.numel()) for value in chapter_model.parameters()
            ),
            "context": "source_style_aware_hard_routed_chapter_expert",
            "style_parameter_count": sum(
                int(value.numel()) for value in style_model.parameters()
            ),
        },
        "data": {
            "style_training_rows": len(style_examples),
            "training_only": True,
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "anchor": r36.r35.r34._macro(folds, "anchor"),
            "r33": r36.r35.r34._macro(folds, "r33"),
            "r40": r36.r35.r34._macro(folds, "r40"),
            "r40_delta": r36.r35.r34._macro(folds, "r40_delta"),
            "r40_vs_r33": r36.r35.r34._macro(folds, "r40_vs_r33"),
        },
        "production_eligible": False,
        "status": "r40_style_aware_chapter_expert_architecture_screen",
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
