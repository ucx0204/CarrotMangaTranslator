"""Screen a learned chapter expert on top of the current R33 page ranker.

R35 proved that a shared learned expert plus a visual exception gate can make
font choices more coherent inside one page.  It still lets different pages in
the same chapter settle on different ordinary-dialogue fonts.  This
non-promotable architecture screen therefore trains the same kind of neural
expert over every labelled row in a chapter, using work-disjoint folds and the
fold-trained R33 page ranker as its frozen local anchor.

The expert is not a majority-vote rule.  It predicts a chapter candidate
distribution from image embeddings and candidate features, while a learned
per-row gate preserves rows whose reviewed preferred/safe candidates do not
support the chapter expert.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_gated_page_expert_r35 as r35
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_gated_page_expert_r35 as r35


def _chapter_groups(
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, str]],
    *,
    require_multiple_body_rows: bool,
) -> tuple[r35.r34.PageGroup, ...]:
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        sample_id = str(row["sample_id"])
        grouped.setdefault(identities["chapter"][sample_id], []).append(row)
    result = []
    for chapter_id, chapter_rows in sorted(grouped.items()):
        ordered = tuple(sorted(chapter_rows, key=lambda row: int(row["row_index"])))
        body_positions = tuple(
            position
            for position, row in enumerate(ordered)
            if int(row["family_label"]) == 0
        )
        if not body_positions or (
            require_multiple_body_rows and len(body_positions) < 2
        ):
            continue
        result.append(
            r35.r34.PageGroup(
                body_positions=body_positions,
                chapter_id=chapter_id,
                page_id=chapter_id,
                rows=ordered,
                work_id=str(ordered[0]["work_id"]),
            )
        )
    return tuple(result)


def _score_map(rows: Sequence[Mapping[str, Any]], scores: Any) -> Mapping[str, Any]:
    if len(rows) != len(scores):
        raise ValueError("row/score count drifted")
    return {
        str(row["sample_id"]): scores[position].detach()
        for position, row in enumerate(rows)
    }


def _group_inputs(
    torch: Any,
    model: Any,
    family_model: Any,
    prepared: Mapping[str, Any],
    group: r35.r34.PageGroup,
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    family = r35.r34.r33.r32.r31._family_logits(
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
    return model(
        torch.as_tensor(local, device=device),
        family,
        torch.as_tensor(r35.r34.r33.r32._per_query(prepared, indices), device=device),
        anchor,
    )


def _train_model(
    torch: Any,
    prepared: Mapping[str, Any],
    family_model: Any,
    groups: Sequence[r35.r34.PageGroup],
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    model = r35._build_model(torch, seed=36_000 + fold_index).to(device)
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
                family_model,
                prepared,
                group,
                identities,
                anchor_by_sample,
                device=device,
            )
            losses = r35._group_loss(torch, output, group, device=device)
            if not bool(torch.isfinite(losses["total"])):
                raise RuntimeError(f"non-finite R36 loss at chapter={group.chapter_id}")
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
    for group in _chapter_groups(rows, identities, require_multiple_body_rows=False):
        output = _group_inputs(
            torch,
            model,
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

    r33_model = r35.r34._train_r33_baseline(
        torch,
        prepared,
        train_rows,
        identities,
        fold_index=fold_index,
        device=device,
    )
    with torch.no_grad():
        train_r33 = r35.r34._scores_for_rows(
            torch,
            prepared,
            train_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
        heldout_anchor = r35.r34._scores_for_rows(
            torch,
            prepared,
            heldout_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=None,
            device=device,
        )["scores"]
        heldout_r33 = r35.r34._scores_for_rows(
            torch,
            prepared,
            heldout_rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]

    train_anchor_by_sample = _score_map(train_rows, train_r33)
    heldout_anchor_by_sample = _score_map(heldout_rows, heldout_r33)
    train_groups = _chapter_groups(
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
        candidate = _scores(
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
    anchor_metrics = r35.r34._metrics(
        torch, heldout_anchor, heldout_rows, identities, candidate_ids
    )
    r33_metrics = r35.r34._metrics(
        torch, heldout_r33, heldout_rows, identities, candidate_ids
    )
    r36_metrics = r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "anchor": anchor_metrics,
        "history": history,
        "r33": r33_metrics,
        "r36": r36_metrics,
        "r36_delta": r35.r34._delta(r36_metrics, anchor_metrics),
        "r36_vs_r33": r35.r34._delta(r36_metrics, r33_metrics),
        "train_chapter_group_count": len(train_groups),
        "work_id": str(fold["heldout_work_id"]),
    }


def screen(
    device_name: str, *, fold_limit: int | None, epochs: int
) -> Mapping[str, Any]:
    import torch

    prepared = r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r35.r34._identity_maps(prepared)
    device = torch.device(device_name)
    family_model = r35.r34._load_family_model(torch, device=device)
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
            f"completed R36 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = r35._build_model(torch, seed=36_000)
    parameter_count = sum(int(value.numel()) for value in model.parameters())
    return {
        "architecture": {
            "anchor": "fold_trained_r33_page_ranker",
            "context": "learned_shared_chapter_expert",
            "learned_per_row_visual_exception_gate": True,
            "new_parameter_count": parameter_count,
        },
        "data": {
            "training_only": True,
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "anchor": r35.r34._macro(folds, "anchor"),
            "r33": r35.r34._macro(folds, "r33"),
            "r36": r35.r34._macro(folds, "r36"),
            "r36_delta": r35.r34._macro(folds, "r36_delta"),
            "r36_vs_r33": r35.r34._macro(folds, "r36_vs_r33"),
        },
        "production_eligible": False,
        "status": "r36_gated_chapter_expert_architecture_screen",
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
