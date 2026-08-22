"""Screen a learned three-style chapter mixture on top of the R33 ranker.

R36's single chapter expert sharply reduced cross-page font switching, but it
also pulled legitimate visual exceptions toward one chapter-wide font.  This
screen replaces that single expert with three learned latent style experts.
Rows with compatible reviewed candidates are trained to share an expert; rows
with reviewed-incompatible candidates are trained to separate.  A learned
visual trust gate leaves isolated rows at their frozen R33 prediction.

This remains a work-disjoint, training-only architecture screen.  No rule or
font ID is hard-coded into inference.
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
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_gated_chapter_expert_r36 as r36


EXPERT_COUNT = 3
TOKEN_WIDTH = 24
EXPERT_WIDTH = 24
SCORER_WIDTH = 24
MAXIMUM_DELTA = 4.0


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class ChapterMixture(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.local = torch.nn.Linear(1024, TOKEN_WIDTH, bias=False)
            self.anchor = torch.nn.Linear(21, TOKEN_WIDTH, bias=False)
            self.token_norm = torch.nn.LayerNorm(TOKEN_WIDTH)
            self.assignment = torch.nn.Linear(TOKEN_WIDTH, EXPERT_COUNT)
            self.expert_context = torch.nn.Linear(1024, EXPERT_WIDTH, bias=False)
            self.candidate_embedding = torch.nn.Embedding(21, 6)
            self.expert_embedding = torch.nn.Embedding(EXPERT_COUNT, 4)
            scorer_input = EXPERT_WIDTH + 4 + 1 + 6 + 4
            self.scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(scorer_input),
                torch.nn.Linear(scorer_input, SCORER_WIDTH),
                torch.nn.GELU(),
                torch.nn.Linear(SCORER_WIDTH, 1),
            )
            gate_input = TOKEN_WIDTH + EXPERT_WIDTH + TOKEN_WIDTH + 4
            self.gate = torch.nn.Sequential(
                torch.nn.LayerNorm(gate_input),
                torch.nn.Linear(gate_input, 20),
                torch.nn.GELU(),
                torch.nn.Linear(20, 1),
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
            token = self.token_norm(self.local(local) + self.anchor(centered_anchor))
            token = torch.nn.functional.gelu(token)
            assignment = torch.softmax(self.assignment(token), dim=1)
            body_probability = torch.softmax(anchor_family.float(), dim=1)[:, 0]
            weights = assignment.transpose(0, 1) * body_probability[None, :]
            weights = weights / weights.sum(dim=1, keepdim=True).clamp_min(1e-6)
            expert_query = weights @ local
            expert_hidden = torch.nn.functional.gelu(self.expert_context(expert_query))
            expert_per_query = torch.einsum("kn,ncf->kcf", weights, per_query)
            expert_anchor = weights @ anchor_body.float()
            candidate = self.candidate_embedding(torch.arange(21, device=local.device))
            expert_ids = self.expert_embedding(
                torch.arange(EXPERT_COUNT, device=local.device)
            )
            features = torch.cat(
                (
                    expert_hidden[:, None, :].expand(-1, 21, -1),
                    expert_per_query,
                    expert_anchor[:, :, None],
                    candidate[None, :, :].expand(EXPERT_COUNT, -1, -1),
                    expert_ids[:, None, :].expand(-1, 21, -1),
                ),
                dim=2,
            )
            expert_delta = MAXIMUM_DELTA * torch.tanh(self.scorer(features).squeeze(2))
            assigned_context = assignment @ expert_hidden
            token_context = torch.nn.functional.pad(
                assigned_context,
                (0, TOKEN_WIDTH - EXPERT_WIDTH),
            )
            difference = (token - token_context).abs()
            anchor_probability = torch.softmax(anchor_body.float(), dim=1)
            entropy = -(
                anchor_probability * torch.log_softmax(anchor_body.float(), dim=1)
            ).sum(dim=1, keepdim=True)
            maximum_probability = anchor_probability.amax(dim=1, keepdim=True)
            maximum_assignment = assignment.amax(dim=1, keepdim=True)
            gate_features = torch.cat(
                (
                    token,
                    assigned_context,
                    difference,
                    entropy,
                    maximum_probability,
                    maximum_assignment,
                    body_probability[:, None],
                ),
                dim=1,
            )
            trust = torch.sigmoid(self.gate(gate_features)).squeeze(1)
            support = (body_probability.sum() - 1.0).clamp(0.0, 1.0)
            applied = support * body_probability * trust
            row_delta = assignment @ expert_delta
            scores = anchor_body.float() + applied[:, None] * row_delta
            return {
                "applied": applied,
                "assignment": assignment,
                "body_candidate_scores": scores,
                "expert_delta": expert_delta,
                "row_delta": row_delta,
                "support": support,
                "trust": trust,
            }

    return ChapterMixture()


def _group_inputs(
    torch: Any,
    model: Any,
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
        torch.as_tensor(local, device=device),
        family,
        torch.as_tensor(
            r36.r35.r34.r33.r32._per_query(prepared, indices), device=device
        ),
        anchor,
    )


def _group_loss(
    torch: Any,
    output: Mapping[str, Any],
    group: r36.r35.r34.PageGroup,
    *,
    device: Any,
) -> Mapping[str, Any]:
    body_rows = tuple(group.rows[position] for position in group.body_positions)
    positions = torch.as_tensor(group.body_positions, dtype=torch.long, device=device)
    scores = output["body_candidate_scores"][positions]
    assignments = output["assignment"][positions]
    tensors = r36.r35.r34.r33.r32.r31.r29.r23._tier_tensors(
        torch, body_rows, device=device
    )
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred_target = torch.where(
        preferred_rows[:, None], tensors["preferred_mask"], tensors["safe_mask"]
    )
    direct = 0.65 * r36.r35.r34._set_nll(torch, scores, preferred_target, reviewed)
    direct = direct + 0.35 * r36.r35.r34._set_nll(
        torch, scores, tensors["safe_mask"], reviewed
    )
    direct_loss = direct.mean()

    score_pairs = []
    assignment_pairs = []
    compatible_with_any = [False] * len(body_rows)
    safe = tensors["safe_mask"]
    preferred = tensors["preferred_mask"]
    for left in range(len(body_rows)):
        for right in range(left + 1, len(body_rows)):
            shared_reviewed = reviewed[left] & reviewed[right]
            shared_preferred = preferred[left] & preferred[right]
            shared_safe = safe[left] & safe[right]
            target = shared_preferred if bool(shared_preferred.any()) else shared_safe
            similarity = (
                (assignments[left] * assignments[right]).sum().clamp(1e-6, 1.0 - 1e-6)
            )
            if bool(target.any()) and bool(shared_reviewed.any()):
                compatible_with_any[left] = True
                compatible_with_any[right] = True
                assignment_pairs.append(-torch.log(similarity))
                pair_scores = scores[[left, right]].masked_fill(
                    ~shared_reviewed[None, :], torch.finfo(scores.dtype).min
                )
                probabilities = torch.softmax(pair_scores.float(), dim=1)
                joint = torch.sqrt(
                    probabilities[0].clamp_min(1e-12)
                    * probabilities[1].clamp_min(1e-12)
                )
                score_pairs.append(-torch.log(joint[target].sum().clamp_min(1e-8)))
            elif bool(shared_reviewed.any()):
                assignment_pairs.append(-torch.log1p(-similarity))
    score_pair_loss = (
        torch.stack(score_pairs).mean() if score_pairs else scores.sum() * 0.0
    )
    assignment_loss = (
        torch.stack(assignment_pairs).mean() if assignment_pairs else scores.sum() * 0.0
    )
    gate_target = torch.as_tensor(
        [float(value) for value in compatible_with_any],
        dtype=torch.float32,
        device=device,
    )
    trust = output["trust"][positions]
    gate_loss = torch.nn.functional.binary_cross_entropy(trust, gate_target)
    exception = gate_target < 0.5
    exception_loss = (
        torch.nn.functional.kl_div(
            torch.log_softmax(scores[exception].float(), dim=1),
            torch.softmax(
                (
                    scores[exception]
                    - output["applied"][positions][exception, None]
                    * output["row_delta"][positions][exception]
                ).detach(),
                dim=1,
            ),
            reduction="batchmean",
        )
        if bool(exception.any())
        else scores.sum() * 0.0
    )
    delta_l2 = output["expert_delta"].float().square().mean()
    total = (
        direct_loss
        + 0.35 * score_pair_loss
        + 0.25 * assignment_loss
        + 0.15 * gate_loss
        + 1.00 * exception_loss
        + 0.002 * delta_l2
    )
    return {
        "assignment": assignment_loss,
        "direct": direct_loss,
        "exception": exception_loss,
        "gate": gate_loss,
        "pair": score_pair_loss,
        "total": total,
    }


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
    model = _build_model(torch, seed=37_000 + fold_index).to(device)
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
            name: 0.0 for name in ("assignment", "direct", "exception", "gate", "pair")
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
            losses = _group_loss(torch, output, group, device=device)
            if not bool(torch.isfinite(losses["total"])):
                raise RuntimeError(f"non-finite R37 loss at chapter={group.chapter_id}")
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
        "r37": candidate_metrics,
        "r37_delta": r36.r35.r34._delta(candidate_metrics, anchor_metrics),
        "r37_vs_r33": r36.r35.r34._delta(candidate_metrics, r33_metrics),
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
            f"completed R37 fold {position}/{len(source_folds)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=37_000)
    parameter_count = sum(int(value.numel()) for value in model.parameters())
    return {
        "architecture": {
            "anchor": "fold_trained_r33_page_ranker",
            "chapter_style_expert_count": EXPERT_COUNT,
            "context": "learned_chapter_mixture_with_visual_trust_gate",
            "new_parameter_count": parameter_count,
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
            "r37": r36.r35.r34._macro(folds, "r37"),
            "r37_delta": r36.r35.r34._macro(folds, "r37_delta"),
            "r37_vs_r33": r36.r35.r34._macro(folds, "r37_vs_r33"),
        },
        "production_eligible": False,
        "status": "r37_learned_chapter_mixture_architecture_screen",
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
