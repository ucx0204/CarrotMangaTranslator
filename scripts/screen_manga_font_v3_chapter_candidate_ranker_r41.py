"""Screen a style-supervised chapter candidate ranker against production R33.

R36-R40 showed that a single chapter-wide font expert can remove oscillation,
but a scalar apply/keep gate collapses legitimate local typography changes.
This non-promotable screen removes that bottleneck: it predicts a separate
candidate residual for every row from local source appearance, a learned
chapter set summary, the local/chapter difference, and the frozen R33 scores.
The row representation is also supervised by the source-style axes recovered
in R39.  Evaluation is leave-one-work-out and never trains on the held-out work.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_gated_chapter_expert_r36 as r36
    from scripts import screen_manga_font_v3_source_style_head_r39 as r39
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_gated_chapter_expert_r36 as r36
    import screen_manga_font_v3_source_style_head_r39 as r39


ROW_WIDTH = 48
CANDIDATE_WIDTH = 32
MAXIMUM_DELTA = 4.0


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class ChapterCandidateRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.input_norm = torch.nn.LayerNorm(1024)
            self.row_projection = torch.nn.Linear(1024, ROW_WIDTH)
            self.family_projection = torch.nn.Linear(2, ROW_WIDTH, bias=False)
            self.row_refine = torch.nn.Linear(ROW_WIDTH, ROW_WIDTH)
            self.row_norm = torch.nn.LayerNorm(ROW_WIDTH)
            self.candidate_embedding = torch.nn.Embedding(21, 8)
            candidate_input = ROW_WIDTH * 3 + 4 + 1 + 1 + 8
            self.scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(candidate_input),
                torch.nn.Linear(candidate_input, CANDIDATE_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(CANDIDATE_WIDTH, 1),
            )
            self.style_head = torch.nn.Linear(ROW_WIDTH, len(r39.STYLE_FIELDS))
            torch.nn.init.zeros_(self.scorer[-1].weight)
            torch.nn.init.zeros_(self.scorer[-1].bias)

        def encode(self, local_query: Any, family_logits: Any) -> Any:
            local = self.input_norm(local_query.float())
            family = torch.softmax(family_logits.float(), dim=1)
            token = torch.nn.functional.gelu(
                self.row_projection(local) + self.family_projection(family)
            )
            return self.row_norm(
                token + torch.nn.functional.gelu(self.row_refine(token))
            )

        def forward(
            self,
            local_query: Any,
            family_logits: Any,
            per_query: Any,
            anchor_body: Any,
        ) -> Mapping[str, Any]:
            token = self.encode(local_query, family_logits)
            count = int(token.shape[0])
            chapter = token.mean(dim=0, keepdim=True).expand(count, -1)
            difference = (token - chapter).abs()
            chapter_anchor = anchor_body.float().mean(dim=0)
            candidate_ids = torch.arange(21, device=token.device)
            candidate = self.candidate_embedding(candidate_ids)
            pieces = (
                token[:, None, :].expand(-1, 21, -1),
                chapter[:, None, :].expand(-1, 21, -1),
                difference[:, None, :].expand(-1, 21, -1),
                per_query.float(),
                anchor_body.float()[:, :, None],
                chapter_anchor[None, :, None].expand(count, -1, -1),
                candidate[None, :, :].expand(count, -1, -1),
            )
            raw_delta = MAXIMUM_DELTA * torch.tanh(
                self.scorer(torch.cat(pieces, dim=2)).squeeze(2)
            )
            support = float(count > 1)
            delta = support * raw_delta
            return {
                "body_candidate_scores": anchor_body.float() + delta,
                "chapter": chapter,
                "delta": delta,
                "raw_delta": raw_delta,
                "style": torch.sigmoid(self.style_head(token)),
                "token": token,
            }

    return ChapterCandidateRanker()


def _group_inputs(
    torch: Any,
    model: Any,
    family_model: Any,
    prepared: Mapping[str, Any],
    group: Any,
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in group.rows], dtype=np.int64)
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
    return model(
        torch.as_tensor(prepared["local_query"][indices], device=device),
        family,
        torch.as_tensor(
            r36.r35.r34.r33.r32._per_query(prepared, indices), device=device
        ),
        anchor,
    )


def _set_nll(torch: Any, scores: Any, numerator: Any, denominator: Any) -> Any:
    negative = torch.finfo(scores.dtype).min
    top = torch.logsumexp(scores.masked_fill(~numerator, negative), dim=1)
    bottom = torch.logsumexp(scores.masked_fill(~denominator, negative), dim=1)
    return bottom - top


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
    tensors = r36.r35.r34.r33.r32.r31.r29.r23._tier_tensors(
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
    direct_rows = 0.65 * _set_nll(torch, scores, preferred, reviewed)
    direct_rows += 0.35 * _set_nll(torch, scores, tensors["safe_mask"], reviewed)
    direct = direct_rows.mean()

    pairs = []
    safe = tensors["safe_mask"]
    for left in range(len(body_rows)):
        for right in range(left + 1, len(body_rows)):
            shared_reviewed = reviewed[left] & reviewed[right]
            shared_preferred = preferred[left] & preferred[right]
            shared_safe = safe[left] & safe[right]
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
    residual = output["delta"][positions].float().square().mean()
    return {
        "direct": direct,
        "pair": pair,
        "residual": residual,
        "total": direct + 0.2 * pair + 0.001 * residual,
    }


def _style_loss(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    examples: Sequence[Mapping[str, Any]],
    *,
    device: Any,
) -> Any:
    indices = np.asarray([row["row_index"] for row in examples], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    family = prepared["cache"]["family_logits"][positions].to(device)
    token = model.encode(
        torch.as_tensor(prepared["local_query"][indices], device=device), family
    )
    prediction = torch.sigmoid(model.style_head(token))
    target = torch.as_tensor(
        np.stack([row["target"] for row in examples]), device=device
    )
    mask = torch.as_tensor(np.stack([row["mask"] for row in examples]), device=device)
    work_counts: dict[str, int] = {}
    for row in examples:
        work_counts[str(row["work_id"])] = work_counts.get(str(row["work_id"]), 0) + 1
    weights = torch.as_tensor(
        [
            1.0 / (len(work_counts) * work_counts[str(row["work_id"])])
            for row in examples
        ],
        device=device,
    )
    row_loss = ((prediction - target).square() * mask).sum(dim=1)
    row_loss /= mask.sum(dim=1).clamp_min(1)
    return torch.sum(row_loss * weights)


def _train_model(
    torch: Any,
    prepared: Mapping[str, Any],
    family_model: Any,
    groups: Sequence[Any],
    identities: Mapping[str, Mapping[str, str]],
    anchor_by_sample: Mapping[str, Any],
    style_examples: Sequence[Mapping[str, Any]],
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    model = _build_model(torch, seed=41_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=5e-4, weight_decay=3e-4)
    work_counts: dict[str, int] = {}
    for group in groups:
        work_counts[group.work_id] = work_counts.get(group.work_id, 0) + 1
    history: dict[str, float] = {}
    for epoch in range(1, epochs + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        totals = []
        parts = {"direct": 0.0, "pair": 0.0, "residual": 0.0}
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
            losses = _group_loss(torch, output, group, device=device)
            weight = 1.0 / (len(work_counts) * work_counts[group.work_id])
            totals.append(losses["total"] * weight)
            for name in parts:
                parts[name] += float(losses[name].detach().item()) * weight
        style = _style_loss(
            torch,
            model,
            prepared,
            style_examples,
            device=device,
        )
        total = torch.stack(totals).sum() + 0.25 * style
        if not bool(torch.isfinite(total)):
            raise RuntimeError(f"non-finite R41 loss at epoch {epoch}")
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        if epoch == epochs:
            history = {
                **parts,
                "style": float(style.detach().item()),
                "total": float(total.detach().item()),
            }
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
    result = torch.stack([anchor_by_sample[str(row["sample_id"])] for row in rows])
    result = result.to(device).clone()
    row_position = {
        str(row["sample_id"]): position for position, row in enumerate(rows)
    }
    for group in r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    ):
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
    train_anchor = r36._score_map(train_rows, train_r33)
    heldout_anchor = r36._score_map(heldout_rows, heldout_r33)
    groups = r36._chapter_groups(
        train_rows, identities, require_multiple_body_rows=False
    )
    fold_style = tuple(
        example for example in style_examples if example["work_id"] != heldout_work
    )
    model, history = _train_model(
        torch,
        prepared,
        family_model,
        groups,
        identities,
        train_anchor,
        fold_style,
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
            heldout_anchor,
            device=device,
        )
    candidate_ids = tuple(prepared["context"]["candidate_ids"])
    r33_metrics = r36.r35.r34._metrics(
        torch, heldout_r33, heldout_rows, identities, candidate_ids
    )
    r41_metrics = r36.r35.r34._metrics(
        torch, candidate, heldout_rows, identities, candidate_ids
    )
    return {
        "history": history,
        "r33": r33_metrics,
        "r41": r41_metrics,
        "r41_vs_r33": r36.r35.r34._delta(r41_metrics, r33_metrics),
        "train_chapter_group_count": len(groups),
        "work_id": heldout_work,
    }


def screen(
    device_name: str, *, fold_limit: int | None = None, epochs: int = 28
) -> Mapping[str, Any]:
    import torch

    prepared = r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r36.r35.r34._identity_maps(prepared)
    style_examples = tuple(r39._examples(prepared))
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
            f"completed R41 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=41_000)
    parameters = sum(int(value.numel()) for value in model.parameters())
    return {
        "architecture": {
            "additional_parameter_count": parameters,
            "anchor": "fold_trained_r33_page_ranker",
            "context": "style_supervised_row_specific_chapter_candidate_ranker",
            "estimated_total_parameter_ratio_vs_r33": (124_000 + parameters) / 124_000,
        },
        "data": {
            "style_training_rows": len(style_examples),
            "work_disjoint_fold_count": len(folds),
            "work_disjoint_fold_total": len(prepared["folds"]),
        },
        "folds": folds,
        "macro": {
            "r33": r36.r35.r34._macro(folds, "r33"),
            "r41": r36.r35.r34._macro(folds, "r41"),
            "r41_vs_r33": r36.r35.r34._macro(folds, "r41_vs_r33"),
        },
        "production_eligible": False,
        "status": "r41_chapter_candidate_ranker_architecture_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=28)
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
