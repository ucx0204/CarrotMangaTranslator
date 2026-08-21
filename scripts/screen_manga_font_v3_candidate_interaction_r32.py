"""Screen a candidate-interaction font ranker with the R31 family router.

Unlike the earlier free 42-way correction heads, this model scores every font
through one shared network using query/prototype similarities.  The page cell
adds a soft page feature but never forces consensus.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_page_family_router_r31 as r31
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_page_family_router_r31 as r31


PRODUCTION_PARAMETERS = 74_528
PRODUCTION_MAC = 91_776
MAXIMUM_DELTA = 4.0
CHECKPOINT_EPOCHS = (4, 8, 12)


@dataclass(frozen=True)
class Cell:
    name: str
    page_context: bool
    row_width: int = 12
    candidate_width: int = 12
    learning_rate: float = 5e-4
    epochs: int = 12


CELLS = (
    Cell("local-candidate-interaction", False),
    Cell("soft-page-candidate-interaction", True),
)


def _build_model(torch: Any, cell: Cell, *, seed: int) -> Any:
    torch.manual_seed(seed)
    family_cell = r31.CELLS[0]

    class CandidateInteraction(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.family_router = r31._build_model(torch, family_cell, seed=seed)
            self.row = torch.nn.Linear(1024, cell.row_width, bias=False)
            self.page = (
                torch.nn.Linear(1024, cell.row_width, bias=False)
                if cell.page_context
                else None
            )
            self.candidate_embedding = torch.nn.Embedding(21, 4)
            self.branch_embedding = torch.nn.Embedding(2, 2)
            input_width = cell.row_width + 4 + 1 + 4 + 2
            if self.page is not None:
                input_width += cell.row_width
            self.scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(input_width),
                torch.nn.Linear(input_width, cell.candidate_width),
                torch.nn.GELU(),
                torch.nn.Linear(cell.candidate_width, 1),
            )
            torch.nn.init.zeros_(self.scorer[-1].weight)
            torch.nn.init.zeros_(self.scorer[-1].bias)

        def forward(
            self,
            local_query: Any,
            page_query: Any,
            anchor_family: Any,
            per_query: Any,
            anchor_body: Any,
            anchor_variant: Any,
        ) -> Mapping[str, Any]:
            family = self.family_router(local_query, local_query, anchor_family)
            local = torch.nn.functional.layer_norm(local_query.float(), (1024,))
            row_hidden = self.row(local)
            pieces = [row_hidden[:, None, None, :].expand(-1, 2, 21, -1)]
            if self.page is not None:
                page = torch.nn.functional.layer_norm(page_query.float(), (1024,))
                page_hidden = self.page(page)
                pieces.append(page_hidden[:, None, None, :].expand(-1, 2, 21, -1))
            pieces.append(per_query[:, None, :, :].expand(-1, 2, -1, -1))
            anchors = torch.stack((anchor_body, anchor_variant), dim=1)
            pieces.append(anchors[:, :, :, None])
            candidate_ids = torch.arange(21, device=local_query.device)
            candidate = self.candidate_embedding(candidate_ids)
            pieces.append(candidate[None, None, :, :].expand(len(local), 2, -1, -1))
            branch_ids = torch.arange(2, device=local_query.device)
            branch = self.branch_embedding(branch_ids)
            pieces.append(branch[None, :, None, :].expand(len(local), -1, 21, -1))
            delta = MAXIMUM_DELTA * torch.tanh(
                self.scorer(torch.cat(pieces, dim=-1)).squeeze(-1)
            )
            return {
                "body_candidate_scores": anchor_body + delta[:, 0],
                "delta": delta,
                "family_logits": family,
                "variant_candidate_scores": anchor_variant + delta[:, 1],
            }

    return CandidateInteraction()


def _page_queries(
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
) -> np.ndarray:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    result = np.empty_like(local)
    groups: dict[str, list[int]] = {}
    for position, row in enumerate(rows):
        groups.setdefault(page_by_sample[str(row["sample_id"])], []).append(position)
    for positions in groups.values():
        selected = np.asarray(positions, dtype=np.int64)
        mean = np.mean(local[selected], axis=0, keepdims=True)
        mean /= np.maximum(np.linalg.norm(mean, axis=1, keepdims=True), 1e-6)
        result[selected] = mean
    return result


def _per_query(prepared: Mapping[str, Any], indices: np.ndarray) -> np.ndarray:
    arrays = prepared["context"]["arrays"]
    sample = arrays["query_views"][indices].astype(np.float32).mean(axis=1)
    sample /= np.maximum(np.linalg.norm(sample, axis=-1, keepdims=True), 1e-6)
    prototypes = arrays["prototype_queries"].astype(np.float32, copy=True)
    prototypes /= np.maximum(np.linalg.norm(prototypes, axis=-1, keepdims=True), 1e-6)
    return np.einsum("bqd,cqd->bcq", sample, prototypes, optimize=True).astype(
        np.float32
    )


def _outputs(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    *,
    device: Any,
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    return model(
        torch.as_tensor(local, device=device),
        torch.as_tensor(_page_queries(prepared, rows, page_by_sample), device=device),
        cache["family_logits"][positions].to(device),
        torch.as_tensor(_per_query(prepared, indices), device=device),
        cache["body_candidate_scores"][positions].to(device),
        cache["variant_candidate_scores"][positions].to(device),
    )


def _base_outputs(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    indices: np.ndarray,
    *,
    device: Any,
) -> Mapping[str, Any]:
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    local_tensor = torch.as_tensor(local, device=device)
    return model(
        local_tensor,
        local_tensor,
        cache["family_logits"][positions].to(device),
        torch.as_tensor(_per_query(prepared, indices), device=device),
        cache["body_candidate_scores"][positions].to(device),
        cache["variant_candidate_scores"][positions].to(device),
    )


def _metrics(
    torch: Any,
    output: Mapping[str, Any],
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
) -> Mapping[str, float]:
    device = output["family_logits"].device
    tensors = r31.r29.r23._tier_tensors(torch, rows, device=device)
    family = tensors["family_labels"]
    predicted = output["family_logits"].argmax(dim=1)
    scores = torch.where(
        predicted[:, None] == 0,
        output["body_candidate_scores"],
        output["variant_candidate_scores"],
    )
    top1 = scores.argmax(dim=1)
    safe = tensors["safe_mask"].gather(1, top1[:, None]).squeeze(1)
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred = tensors["preferred_mask"].gather(1, top1[:, None]).squeeze(1)
    unacceptable = tensors["unacceptable_mask"].gather(1, top1[:, None]).squeeze(1)
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    unreviewed = ~reviewed.gather(1, top1[:, None]).squeeze(1)
    single_day = tuple(prepared["context"]["candidate_ids"]).index("single-day")
    unsafe_sd = tensors["single_day_safety_negative"] & (top1 == single_day)
    unsafe_count = int(tensors["single_day_safety_negative"].sum().item())
    body = family == 0
    variant = family == 1
    agreements = []
    groups: dict[str, list[int]] = {}
    for position, row in enumerate(rows):
        if int(row["family_label"]) == 0:
            groups.setdefault(page_by_sample[str(row["sample_id"])], []).append(
                position
            )
    for positions in groups.values():
        if len(positions) < 2:
            continue
        selected = torch.as_tensor(positions, dtype=torch.long, device=device)
        values = top1[selected]
        count = len(positions)
        pairs = (values[:, None] == values[None, :]).float()
        agreements.append((pairs.sum() - count) / (count * (count - 1)))
    body_recall = float((predicted[body] == 0).float().mean().item())
    variant_recall = float((predicted[variant] == 1).float().mean().item())
    return {
        "balanced_family_accuracy": (body_recall + variant_recall) / 2,
        "body_recall": body_recall,
        "family_accuracy": float((predicted == family).float().mean().item()),
        "multi_body_pair_agreement": float(
            torch.stack(agreements).mean().item() if agreements else 0.0
        ),
        "preferred_top1_accuracy": float(
            preferred[preferred_rows].float().mean().item()
        ),
        "safe_top1_accuracy": float(safe.float().mean().item()),
        "single_day_unsafe_top1_rate": float(
            unsafe_sd.sum().item() / max(1, unsafe_count)
        ),
        "unacceptable_top1_rate": float(unacceptable.float().mean().item()),
        "unreviewed_top1_rate": float(unreviewed.float().mean().item()),
        "variant_recall": variant_recall,
    }


def _anchor_output(
    prepared: Mapping[str, Any], rows: Sequence[Mapping[str, Any]], *, device: Any
) -> Mapping[str, Any]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    positions = __import__("torch").as_tensor(indices, dtype=__import__("torch").long)
    cache = prepared["cache"]
    return {
        name: cache[name][positions].to(device)
        for name in (
            "body_candidate_scores",
            "family_logits",
            "variant_candidate_scores",
        )
    }


def _delta(
    candidate: Mapping[str, float], anchor: Mapping[str, float]
) -> dict[str, float]:
    return {key: float(candidate[key] - anchor[key]) for key in anchor}


def _distill(
    torch: Any,
    output: Mapping[str, Any],
    prepared: Mapping[str, Any],
    indices: np.ndarray,
    *,
    device: Any,
) -> Any:
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    loss = 0.0
    for name in ("body_candidate_scores", "variant_candidate_scores"):
        anchor = cache[name][positions].to(device)
        loss = loss + torch.nn.functional.kl_div(
            torch.log_softmax(output[name].float(), dim=1),
            torch.softmax(anchor.float(), dim=1),
            reduction="batchmean",
        )
    return loss / 2.0


def _page_consistency_loss(
    torch: Any,
    output: Mapping[str, Any],
    tensors: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
) -> Any:
    groups: dict[str, list[int]] = {}
    for position, row in enumerate(rows):
        if int(row["family_label"]) == 0:
            groups.setdefault(page_by_sample[str(row["sample_id"])], []).append(
                position
            )
    probabilities = torch.softmax(output["body_candidate_scores"].float(), dim=1)
    mass_losses = []
    js_losses = []
    for positions in groups.values():
        if len(positions) < 2:
            continue
        selected = torch.as_tensor(
            positions, dtype=torch.long, device=probabilities.device
        )
        common = tensors["safe_mask"][selected].all(dim=0)
        if not bool(common.any()):
            continue
        group = probabilities[selected]
        mass_losses.append(
            -torch.log(group[:, common].sum(dim=1).clamp_min(1e-8)).mean()
        )
        mean = group.mean(dim=0, keepdim=True).clamp_min(1e-8)
        js_losses.append(
            (group * (group.clamp_min(1e-8).log() - mean.log())).sum(dim=1).mean()
        )
    if not mass_losses:
        return output["body_candidate_scores"].sum() * 0.0
    return torch.stack(mass_losses).mean() + 0.1 * torch.stack(js_losses).mean()


def _train_fold(
    torch: Any,
    prepared: Mapping[str, Any],
    page_by_sample: Mapping[str, str],
    fold: Mapping[str, Any],
    cell: Cell,
    *,
    device: Any,
) -> Mapping[int, Mapping[str, Any]]:
    fold_index = int(fold["contract"]["fold_index"])
    model = _build_model(torch, cell, seed=32_000 + fold_index).to(device)
    train_rows = tuple(fold["train_rows"])
    heldout_rows = tuple(fold["heldout_rows"])
    row_weights = r31._balanced_weights(train_rows, torch=torch, device=device)
    train_tensors = r31.r29.r23._tier_tensors(torch, train_rows, device=device)
    base_indices = np.asarray(fold["base_indices"], dtype=np.int64)
    rng = np.random.default_rng(32_000 + fold_index)
    base_indices = np.sort(
        rng.choice(base_indices, size=min(2048, len(base_indices)), replace=False)
    )
    anchor_heldout = _metrics(
        torch,
        _anchor_output(prepared, heldout_rows, device=device),
        prepared,
        heldout_rows,
        page_by_sample,
    )
    snapshots: dict[int, Mapping[str, Any]] = {}
    single_day = tuple(prepared["context"]["candidate_ids"]).index("single-day")

    family_optimizer = torch.optim.AdamW(
        model.family_router.parameters(), lr=8e-4, weight_decay=2e-3
    )
    for _ in range(24):
        model.train()
        output = _outputs(
            torch,
            model,
            prepared,
            train_rows,
            page_by_sample,
            device=device,
        )
        family_loss = torch.sum(
            torch.nn.functional.cross_entropy(
                output["family_logits"],
                train_tensors["family_labels"],
                reduction="none",
            )
            * row_weights
        )
        base_output = _base_outputs(torch, model, prepared, base_indices, device=device)
        positions = torch.as_tensor(base_indices, dtype=torch.long)
        base_anchor = prepared["cache"]["family_logits"][positions].to(device)
        family_distill = torch.nn.functional.kl_div(
            torch.log_softmax(base_output["family_logits"].float(), dim=1),
            torch.softmax(base_anchor.float(), dim=1),
            reduction="batchmean",
        )
        family_total = family_loss + 0.2 * family_distill
        family_optimizer.zero_grad(set_to_none=True)
        family_total.backward()
        torch.nn.utils.clip_grad_norm_(model.family_router.parameters(), 1.0)
        family_optimizer.step()

    for parameter in model.family_router.parameters():
        parameter.requires_grad_(False)
    candidate_parameters = [
        parameter for parameter in model.parameters() if parameter.requires_grad
    ]
    optimizer = torch.optim.AdamW(
        candidate_parameters, lr=cell.learning_rate, weight_decay=1e-4
    )
    for epoch in range(1, cell.epochs + 1):
        model.train()
        output = _outputs(
            torch,
            model,
            prepared,
            train_rows,
            page_by_sample,
            device=device,
        )
        routed = torch.where(
            train_tensors["family_labels"][:, None] == 0,
            output["body_candidate_scores"],
            output["variant_candidate_scores"],
        )
        candidate_loss, _ = r31.r29.r23.weighted_candidate_set_loss(
            torch,
            routed,
            preferred_mask=train_tensors["preferred_mask"],
            safe_mask=train_tensors["safe_mask"],
            marginal_mask=train_tensors["marginal_mask"],
            unacceptable_mask=train_tensors["unacceptable_mask"],
            single_day_safety_negative=train_tensors["single_day_safety_negative"],
            marginal_weight=r31.r29.MARGINAL_WEIGHT,
            row_weights=row_weights,
        )
        safety = r31.r29.r23._single_day_safety_losses(
            torch,
            output,
            safe_mask=train_tensors["safe_mask"],
            family_labels=train_tensors["family_labels"],
            safety_negative=train_tensors["single_day_safety_negative"],
            row_weights=row_weights,
            single_day_index=single_day,
        )
        base_output = _base_outputs(torch, model, prepared, base_indices, device=device)
        distill = _distill(torch, base_output, prepared, base_indices, device=device)
        page_consistency = (
            _page_consistency_loss(
                torch, output, train_tensors, train_rows, page_by_sample
            )
            if cell.page_context
            else output["delta"].sum() * 0.0
        )
        total = (
            candidate_loss
            + r31.r29.r23.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT
            * safety["body_hard_negative"]
            + r31.r29.r23.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
            * safety["supervised_hard_negative"]
            + 0.75 * distill
            + 0.001 * output["delta"].square().mean()
            + 0.30 * page_consistency
        )
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(candidate_parameters, 2.0)
        optimizer.step()
        if epoch in CHECKPOINT_EPOCHS:
            model.eval()
            heldout = _metrics(
                torch,
                _outputs(
                    torch,
                    model,
                    prepared,
                    heldout_rows,
                    page_by_sample,
                    device=device,
                ),
                prepared,
                heldout_rows,
                page_by_sample,
            )
            snapshots[epoch] = {
                "delta": _delta(heldout, anchor_heldout),
                "work_id": str(fold["heldout_work_id"]),
            }
    return snapshots


def _run_cell(
    torch: Any,
    prepared: Mapping[str, Any],
    page_by_sample: Mapping[str, str],
    cell: Cell,
    *,
    device: Any,
) -> Mapping[str, Any]:
    folds = [
        _train_fold(torch, prepared, page_by_sample, fold, cell, device=device)
        for fold in prepared["folds"]
    ]
    epochs: dict[str, Any] = {}
    for epoch in CHECKPOINT_EPOCHS:
        keys = tuple(folds[0][epoch]["delta"])
        delta = {
            key: float(np.mean([fold[epoch]["delta"][key] for fold in folds]))
            for key in keys
        }
        epochs[str(epoch)] = {
            "oof_delta": delta,
            "worst_work_preferred_delta": min(
                fold[epoch]["delta"]["preferred_top1_accuracy"] for fold in folds
            ),
            "worst_work_safe_delta": min(
                fold[epoch]["delta"]["safe_top1_accuracy"] for fold in folds
            ),
        }
    model = _build_model(torch, cell, seed=32_000)
    parameters = sum(int(value.numel()) for value in model.parameters())
    candidate_input = cell.row_width + 4 + 1 + 4 + 2
    new_mac = 1024 * 32 + 2 * 32 + 32 * 2
    new_mac += 1024 * cell.row_width
    if cell.page_context:
        candidate_input += cell.row_width
        new_mac += 1024 * cell.row_width
    new_mac += 2 * 21 * (candidate_input * cell.candidate_width + cell.candidate_width)
    return {
        "architecture": {
            "estimated_total_mac_ratio": (PRODUCTION_MAC + new_mac) / PRODUCTION_MAC,
            "estimated_total_parameter_ratio": (PRODUCTION_PARAMETERS + parameters)
            / PRODUCTION_PARAMETERS,
            "new_parameter_count": parameters,
        },
        "cell": cell.name,
        "epochs": epochs,
    }


def screen(device_name: str) -> Mapping[str, Any]:
    import torch

    prepared = r31.r29._prepare(torch)
    page_by_sample = r31._page_map(prepared)
    device = torch.device(device_name)
    return {
        "results": [
            _run_cell(torch, prepared, page_by_sample, cell, device=device)
            for cell in CELLS
        ],
        "status": "r32_candidate_interaction_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    print(json.dumps(screen(args.device), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
