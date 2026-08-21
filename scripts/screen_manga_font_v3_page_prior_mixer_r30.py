"""Screen a structured page-prior font mixer on the sealed training labels.

Unlike the rejected R28/R29 free residuals, this model cannot invent an
independent 21-font correction for every row.  It builds one robust page prior
from row evidence and learns only how strongly each row should move toward
that prior.  Single-row pages are exact anchor no-ops.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_page_conditioned_direct_r29 as r29
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_page_conditioned_direct_r29 as r29


PRODUCTION_PARAMETERS = 74_528
PRODUCTION_MAC = 91_776


@dataclass(frozen=True)
class Cell:
    name: str
    width: int
    maximum_shift: float
    page_target_weight: float
    body_gate_weight: float
    anchor_weight: float
    learning_rate: float
    epochs: int


CELLS = (
    Cell("w24-s15-p050-g025-a010", 24, 1.5, 0.50, 0.25, 0.10, 4e-4, 8),
    Cell("w32-s20-p075-g025-a010", 32, 2.0, 0.75, 0.25, 0.10, 3e-4, 8),
)


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    result: list[Mapping[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"expected JSONL object: {path}")
            result.append(value)
    return result


def _page_map(prepared: Mapping[str, Any]) -> Mapping[str, str]:
    source = _read_jsonl(
        Path(prepared["args"].source_label_dir) / r29.r23.SOURCE_LABEL_FILE
    )
    result: dict[str, str] = {}
    for record in source:
        identity = record.get("identity")
        if not isinstance(identity, dict):
            raise ValueError("training label identity is missing")
        result[str(record["sample_id"])] = str(identity["page_id"])
    return result


def _group_ids(
    rows: Sequence[Mapping[str, Any]], page_by_sample: Mapping[str, str]
) -> tuple[np.ndarray, tuple[str, ...]]:
    pages = tuple(page_by_sample[str(row["sample_id"])] for row in rows)
    unique = tuple(dict.fromkeys(pages))
    positions = {page: index for index, page in enumerate(unique)}
    return np.asarray([positions[page] for page in pages], dtype=np.int64), unique


def _build_model(torch: Any, cell: Cell, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class PagePriorMixer(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.local = torch.nn.Linear(1024, cell.width, bias=False)
            self.anchor = torch.nn.Linear(44, cell.width)
            self.pool_gate = torch.nn.Linear(cell.width, 1)
            self.apply_gate = torch.nn.Linear(cell.width * 2, 1)
            self.page_delta = torch.nn.Linear(cell.width, 21)
            self.mix_strength = torch.nn.Parameter(torch.zeros(()))
            torch.nn.init.zeros_(self.page_delta.weight)
            torch.nn.init.zeros_(self.page_delta.bias)

        def forward(
            self,
            local_query: Any,
            anchor_family: Any,
            anchor_body: Any,
            anchor_variant: Any,
            anchor_candidate: Any,
            group_ids: Any,
        ) -> Mapping[str, Any]:
            local = torch.nn.functional.layer_norm(local_query.float(), (1024,))
            anchor_values = torch.cat(
                (
                    anchor_family.float(),
                    anchor_body.float(),
                    anchor_variant.float(),
                ),
                dim=1,
            )
            anchor_values = torch.nn.functional.layer_norm(anchor_values, (44,))
            row_hidden = torch.nn.functional.gelu(
                self.local(local) + self.anchor(anchor_values)
            )
            pool_weight = torch.sigmoid(self.pool_gate(row_hidden)).squeeze(1)
            group_count = int(group_ids.max().item()) + 1
            weight_sum = torch.zeros(
                (group_count, 1), dtype=row_hidden.dtype, device=row_hidden.device
            )
            hidden_sum = torch.zeros(
                (group_count, cell.width),
                dtype=row_hidden.dtype,
                device=row_hidden.device,
            )
            score_sum = torch.zeros(
                (group_count, 21),
                dtype=anchor_candidate.dtype,
                device=anchor_candidate.device,
            )
            weight_sum.index_add_(0, group_ids, pool_weight[:, None])
            hidden_sum.index_add_(0, group_ids, row_hidden * pool_weight[:, None])
            score_sum.index_add_(
                0, group_ids, anchor_candidate.float() * pool_weight[:, None]
            )
            denominator = weight_sum.clamp_min(1e-6)
            page_hidden = hidden_sum / denominator
            page_anchor = score_sum / denominator
            centered = self.page_delta(page_hidden)
            centered = centered - centered.mean(dim=1, keepdim=True)
            page_logits = page_anchor + cell.maximum_shift * torch.tanh(centered)
            row_page_hidden = page_hidden[group_ids]
            apply_gate = torch.sigmoid(
                self.apply_gate(torch.cat((row_hidden, row_page_hidden), dim=1))
            ).squeeze(1)
            counts = torch.bincount(group_ids, minlength=group_count)
            active = (counts[group_ids] >= 2).to(apply_gate.dtype)
            raw_shift = page_logits[group_ids] - anchor_candidate.float()
            bounded_shift = cell.maximum_shift * torch.tanh(
                raw_shift / cell.maximum_shift
            )
            mix_strength = torch.tanh(self.mix_strength)
            shift = bounded_shift * (apply_gate * active)[:, None] * mix_strength
            return {
                "apply_gate": apply_gate,
                "body_candidate_scores": anchor_body + shift,
                "candidate_scores": anchor_candidate + shift,
                "family_logits": anchor_family,
                "page_logits": page_logits,
                "pool_gate": pool_weight,
                "shift": shift,
                "variant_candidate_scores": anchor_variant + shift,
            }

    return PagePriorMixer()


def _outputs(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    *,
    device: Any,
) -> tuple[Mapping[str, Any], np.ndarray, tuple[str, ...]]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    group_ids, pages = _group_ids(rows, page_by_sample)
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    output = model(
        torch.as_tensor(prepared["local_query"][indices], device=device),
        cache["family_logits"][positions].to(device),
        cache["body_candidate_scores"][positions].to(device),
        cache["variant_candidate_scores"][positions].to(device),
        cache["candidate_scores"][positions].to(device),
        torch.as_tensor(group_ids, dtype=torch.long, device=device),
    )
    return output, group_ids, pages


def _work_family_weights(
    rows: Sequence[Mapping[str, Any]], *, device: Any, torch: Any
) -> Any:
    strata: dict[tuple[str, int], list[int]] = {}
    for index, row in enumerate(rows):
        key = (str(row["work_id"]), int(row["family_label"]))
        strata.setdefault(key, []).append(index)
    weights = np.zeros(len(rows), dtype=np.float32)
    for positions in strata.values():
        value = 1.0 / (len(strata) * len(positions))
        weights[np.asarray(positions, dtype=np.int64)] = value
    return torch.as_tensor(weights, dtype=torch.float32, device=device)


def _page_targets(
    torch: Any,
    tensors: Mapping[str, Any],
    group_ids: np.ndarray,
    output: Mapping[str, Any],
) -> tuple[Any, int]:
    losses = []
    family = tensors["family_labels"]
    safe = tensors["safe_mask"]
    preferred = tensors["preferred_mask"]
    marginal = tensors["marginal_mask"]
    unacceptable = tensors["unacceptable_mask"]
    reviewed = safe | marginal | unacceptable
    for group_index in range(int(group_ids.max()) + 1):
        positions = np.flatnonzero(group_ids == group_index)
        selected = torch.as_tensor(positions, dtype=torch.long, device=family.device)
        body_positions = selected[family[selected] == 0]
        if int(body_positions.numel()) < 2:
            continue
        body_safe = safe[body_positions].float()
        body_preferred = preferred[body_positions].float()
        body_reviewed = reviewed[body_positions].float()
        reviewed_count = body_reviewed.sum(dim=0)
        coverage = reviewed_count / float(body_positions.numel())
        support = (
            body_safe.sum(dim=0) + body_preferred.sum(dim=0)
        ) / reviewed_count.clamp_min(1.0)
        support = support * torch.sqrt(coverage.clamp_min(0.0))
        support = torch.where(reviewed_count > 0, support, torch.zeros_like(support))
        if not bool((support > 0).any()):
            continue
        target = support / support.sum().clamp_min(1e-6)
        prior_loss = -(
            target
            * torch.log_softmax(output["page_logits"][group_index].float(), dim=0)
        ).sum()
        row_loss = (
            -(
                target[None, :]
                * torch.log_softmax(
                    output["candidate_scores"][body_positions].float(), dim=1
                )
            )
            .sum(dim=1)
            .mean()
        )
        losses.append(0.5 * prior_loss + 0.5 * row_loss)
    if not losses:
        return output["candidate_scores"].sum() * 0.0, 0
    return torch.stack(losses).mean(), len(losses)


def _loss(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    cell: Cell,
    *,
    device: Any,
) -> tuple[Any, Mapping[str, float]]:
    output, group_ids, _ = _outputs(
        torch, model, prepared, rows, page_by_sample, device=device
    )
    tensors = r29.r23._tier_tensors(torch, rows, device=device)
    weights = _work_family_weights(rows, device=device, torch=torch)
    candidate, _ = r29.r23.weighted_candidate_set_loss(
        torch,
        output["candidate_scores"],
        preferred_mask=tensors["preferred_mask"],
        safe_mask=tensors["safe_mask"],
        marginal_mask=tensors["marginal_mask"],
        unacceptable_mask=tensors["unacceptable_mask"],
        single_day_safety_negative=tensors["single_day_safety_negative"],
        marginal_weight=0.25,
        row_weights=weights,
    )
    body_target = (tensors["family_labels"] == 0).float()
    pool_bce = torch.nn.functional.binary_cross_entropy(
        output["pool_gate"], body_target, reduction="none"
    )
    apply_bce = torch.nn.functional.binary_cross_entropy(
        output["apply_gate"], body_target, reduction="none"
    )
    gate = torch.sum((pool_bce + apply_bce) * weights)
    page_target, page_count = _page_targets(torch, tensors, group_ids, output)
    anchor = output["shift"].float().square().mean()
    total = (
        candidate
        + cell.page_target_weight * page_target
        + cell.body_gate_weight * gate
        + cell.anchor_weight * anchor
    )
    return total, {
        "anchor": float(anchor.detach().item()),
        "candidate": float(candidate.detach().item()),
        "gate": float(gate.detach().item()),
        "page_count": page_count,
        "page_target": float(page_target.detach().item()),
        "total": float(total.detach().item()),
    }


def _metrics(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    *,
    device: Any,
) -> Mapping[str, float]:
    output, group_ids, _ = _outputs(
        torch, model, prepared, rows, page_by_sample, device=device
    )
    tensors = r29.r23._tier_tensors(torch, rows, device=device)
    top1 = output["candidate_scores"].argmax(dim=1)
    safe = tensors["safe_mask"].gather(1, top1[:, None]).squeeze(1)
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred = tensors["preferred_mask"].gather(1, top1[:, None]).squeeze(1)
    unacceptable = tensors["unacceptable_mask"].gather(1, top1[:, None]).squeeze(1)
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    unreviewed = ~reviewed.gather(1, top1[:, None]).squeeze(1)
    body = tensors["family_labels"] == 0
    pair_agreements = []
    multi_body_safe = []
    changed = output["shift"].abs().amax(dim=1) > 1e-7
    for group_index in range(int(group_ids.max()) + 1):
        positions = np.flatnonzero(group_ids == group_index)
        selected = torch.as_tensor(positions, dtype=torch.long, device=device)
        selected = selected[body[selected]]
        count = int(selected.numel())
        if count < 2:
            continue
        values = top1[selected]
        same_pairs = (values[:, None] == values[None, :]).float()
        pair_agreements.append((same_pairs.sum() - count) / (count * (count - 1)))
        multi_body_safe.append(safe[selected].float().mean())
    return {
        "changed_row_rate": float(changed.float().mean().item()),
        "mean_apply_gate": float(output["apply_gate"].mean().item()),
        "multi_body_pair_agreement": float(
            torch.stack(pair_agreements).mean().item() if pair_agreements else 0.0
        ),
        "multi_body_safe_top1": float(
            torch.stack(multi_body_safe).mean().item() if multi_body_safe else 0.0
        ),
        "preferred_top1_accuracy": float(
            preferred[preferred_rows].float().mean().item()
        ),
        "safe_top1_accuracy": float(safe.float().mean().item()),
        "unacceptable_top1_rate": float(unacceptable.float().mean().item()),
        "unreviewed_top1_rate": float(unreviewed.float().mean().item()),
    }


def _delta(
    candidate: Mapping[str, float], anchor: Mapping[str, float]
) -> Mapping[str, float]:
    return {key: float(candidate[key] - anchor[key]) for key in anchor}


def _run_cell(
    torch: Any,
    prepared: Mapping[str, Any],
    page_by_sample: Mapping[str, str],
    cell: Cell,
    *,
    device: Any,
) -> Mapping[str, Any]:
    folds = []
    for fold in prepared["folds"]:
        fold_index = int(fold["contract"]["fold_index"])
        model = _build_model(torch, cell, seed=30_000 + fold_index).to(device)
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=cell.learning_rate, weight_decay=1e-3
        )
        anchor_train = _metrics(
            torch, model, prepared, fold["train_rows"], page_by_sample, device=device
        )
        anchor_heldout = _metrics(
            torch, model, prepared, fold["heldout_rows"], page_by_sample, device=device
        )
        history = []
        for epoch in range(1, cell.epochs + 1):
            model.train()
            optimizer.zero_grad(set_to_none=True)
            total, losses = _loss(
                torch,
                model,
                prepared,
                fold["train_rows"],
                page_by_sample,
                cell,
                device=device,
            )
            total.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            model.eval()
            train_metrics = _metrics(
                torch,
                model,
                prepared,
                fold["train_rows"],
                page_by_sample,
                device=device,
            )
            history.append(
                {
                    "epoch": epoch,
                    "losses": losses,
                    "train_delta": _delta(train_metrics, anchor_train),
                }
            )
        heldout = _metrics(
            torch, model, prepared, fold["heldout_rows"], page_by_sample, device=device
        )
        folds.append(
            {
                "anchor_heldout": anchor_heldout,
                "heldout": heldout,
                "heldout_delta": _delta(heldout, anchor_heldout),
                "heldout_work_id": str(fold["heldout_work_id"]),
                "history": history,
            }
        )
    keys = tuple(folds[0]["heldout_delta"])
    oof_delta = {
        key: float(np.mean([fold["heldout_delta"][key] for fold in folds]))
        for key in keys
    }
    worst_safe = min(fold["heldout_delta"]["safe_top1_accuracy"] for fold in folds)
    parameter_count = sum(
        int(value.numel())
        for value in _build_model(torch, cell, seed=30_000).parameters()
    )
    mac = 1024 * cell.width + 44 * cell.width + cell.width
    mac += cell.width * 2 + cell.width * 21
    return {
        "architecture": {
            "estimated_total_mac_ratio": (PRODUCTION_MAC + mac) / PRODUCTION_MAC,
            "estimated_total_parameter_ratio": (PRODUCTION_PARAMETERS + parameter_count)
            / PRODUCTION_PARAMETERS,
            "new_parameter_count": parameter_count,
        },
        "cell": cell.name,
        "folds": folds,
        "oof_delta": oof_delta,
        "worst_work_safe_delta": float(worst_safe),
    }


def screen(device_name: str) -> Mapping[str, Any]:
    import torch

    prepared = r29._prepare(torch)
    page_by_sample = _page_map(prepared)
    device = torch.device(device_name)
    results = [
        _run_cell(torch, prepared, page_by_sample, cell, device=device)
        for cell in CELLS
    ]
    return {"results": results, "status": "r30_page_prior_mixer_screen"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    print(json.dumps(screen(args.device), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
