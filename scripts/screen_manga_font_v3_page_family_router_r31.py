"""Screen a replacement body/variant router while freezing all font scores."""

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
    context_mode: str
    width: int = 32
    epochs: int = 24
    learning_rate: float = 8e-4
    base_distill_weight: float = 0.20


CELLS = (
    Cell("local-mlp32", "local"),
    Cell("page-mean-mlp32", "page_mean"),
    Cell("page-soft-family-mlp32", "page_soft_family"),
)


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"expected JSONL object: {path}")
            rows.append(value)
    return rows


def _page_map(prepared: Mapping[str, Any]) -> Mapping[str, str]:
    labels = _read_jsonl(
        Path(prepared["args"].source_label_dir) / r29.r23.SOURCE_LABEL_FILE
    )
    result: dict[str, str] = {}
    for label in labels:
        identity = label.get("identity")
        if not isinstance(identity, dict):
            raise ValueError("training label identity is missing")
        result[str(label["sample_id"])] = str(identity["page_id"])
    return result


def _page_mean_queries(
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
) -> np.ndarray:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    pages = tuple(page_by_sample[str(row["sample_id"])] for row in rows)
    result = np.empty_like(local)
    grouped: dict[str, list[int]] = {}
    for position, page in enumerate(pages):
        grouped.setdefault(page, []).append(position)
    for positions in grouped.values():
        selected = np.asarray(positions, dtype=np.int64)
        mean = np.mean(local[selected], axis=0, keepdims=True)
        mean /= np.maximum(np.linalg.norm(mean, axis=1, keepdims=True), 1e-6)
        result[selected] = mean
    return result


def _features(
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    mode: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    local = prepared["local_query"][indices].astype(np.float32, copy=False)
    if mode == "local":
        page = local
    elif mode == "page_mean":
        page = _page_mean_queries(prepared, rows, page_by_sample)
    elif mode == "page_soft_family":
        page = prepared["page_query"][indices].astype(np.float32, copy=False)
    else:  # pragma: no cover
        raise ValueError(f"unknown context mode: {mode}")
    anchor = prepared["cache"]["family_logits"][indices].numpy().astype(np.float32)
    return local, page, anchor


def _build_model(torch: Any, cell: Cell, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class PageFamilyRouter(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.local = torch.nn.Linear(1024, cell.width, bias=False)
            self.anchor = torch.nn.Linear(2, cell.width, bias=False)
            self.page = (
                torch.nn.Linear(1024, cell.width, bias=False)
                if cell.context_mode != "local"
                else None
            )
            self.hidden_norm = torch.nn.LayerNorm(cell.width)
            self.output = torch.nn.Linear(cell.width, 2)

        def forward(self, local: Any, page: Any, anchor: Any) -> Any:
            local = torch.nn.functional.layer_norm(local.float(), (1024,))
            anchor = torch.nn.functional.layer_norm(anchor.float(), (2,))
            hidden = self.local(local) + self.anchor(anchor)
            if self.page is not None:
                page = torch.nn.functional.layer_norm(page.float(), (1024,))
                hidden = hidden + self.page(page)
            return self.output(torch.nn.functional.gelu(self.hidden_norm(hidden)))

    return PageFamilyRouter()


def _balanced_weights(
    rows: Sequence[Mapping[str, Any]], *, torch: Any, device: Any
) -> Any:
    strata: dict[tuple[str, int], list[int]] = {}
    for position, row in enumerate(rows):
        key = (str(row["work_id"]), int(row["family_label"]))
        strata.setdefault(key, []).append(position)
    values = np.zeros(len(rows), dtype=np.float32)
    for positions in strata.values():
        values[np.asarray(positions, dtype=np.int64)] = 1.0 / (
            len(strata) * len(positions)
        )
    return torch.as_tensor(values, dtype=torch.float32, device=device)


def _family_logits(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    mode: str,
    *,
    device: Any,
) -> Any:
    local, page, anchor = _features(prepared, rows, page_by_sample, mode)
    return model(
        torch.as_tensor(local, device=device),
        torch.as_tensor(page, device=device),
        torch.as_tensor(anchor, device=device),
    )


def _metrics(
    torch: Any,
    family_logits: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
) -> Mapping[str, float]:
    device = family_logits.device
    labels = torch.as_tensor(
        [row["family_label"] for row in rows], dtype=torch.long, device=device
    )
    predicted = family_logits.argmax(dim=1)
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    body_scores = cache["body_candidate_scores"][positions].to(device)
    variant_scores = cache["variant_candidate_scores"][positions].to(device)
    scores = torch.where(predicted[:, None] == 0, body_scores, variant_scores)
    top1 = scores.argmax(dim=1)
    tensors = r29.r23._tier_tensors(torch, rows, device=device)
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
    body = labels == 0
    variant = labels == 1
    pages = tuple(page_by_sample[str(row["sample_id"])] for row in rows)
    grouped: dict[str, list[int]] = {}
    for position, page in enumerate(pages):
        if bool(body[position]):
            grouped.setdefault(page, []).append(position)
    agreements = []
    for positions_in_page in grouped.values():
        if len(positions_in_page) < 2:
            continue
        selected = torch.as_tensor(positions_in_page, dtype=torch.long, device=device)
        values = top1[selected]
        count = len(positions_in_page)
        pairwise = (values[:, None] == values[None, :]).float()
        agreements.append((pairwise.sum() - count) / (count * (count - 1)))
    body_recall = float((predicted[body] == 0).float().mean().item())
    variant_recall = float((predicted[variant] == 1).float().mean().item())
    return {
        "balanced_family_accuracy": (body_recall + variant_recall) / 2.0,
        "body_recall": body_recall,
        "family_accuracy": float((predicted == labels).float().mean().item()),
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


def _anchor_metrics(
    torch: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    *,
    device: Any,
) -> Mapping[str, float]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    logits = prepared["cache"]["family_logits"][indices].to(device)
    return _metrics(torch, logits, prepared, rows, page_by_sample)


def _delta(
    candidate: Mapping[str, float], anchor: Mapping[str, float]
) -> Mapping[str, float]:
    return {key: float(candidate[key] - anchor[key]) for key in anchor}


def _train_fold(
    torch: Any,
    prepared: Mapping[str, Any],
    page_by_sample: Mapping[str, str],
    fold: Mapping[str, Any],
    cell: Cell,
    *,
    device: Any,
) -> Mapping[str, Any]:
    fold_index = int(fold["contract"]["fold_index"])
    model = _build_model(torch, cell, seed=31_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=cell.learning_rate, weight_decay=2e-3
    )
    train_rows = tuple(fold["train_rows"])
    weights = _balanced_weights(train_rows, torch=torch, device=device)
    labels = torch.as_tensor(
        [row["family_label"] for row in train_rows], dtype=torch.long, device=device
    )
    base_indices = np.asarray(fold["base_indices"], dtype=np.int64)
    generator = np.random.default_rng(31_000 + fold_index)
    base_indices = np.sort(
        generator.choice(base_indices, size=min(2048, len(base_indices)), replace=False)
    )
    base_local = prepared["local_query"][base_indices].astype(np.float32, copy=False)
    base_anchor = prepared["cache"]["family_logits"][base_indices].to(device)
    anchor_train = _anchor_metrics(
        torch, prepared, train_rows, page_by_sample, device=device
    )
    history = []
    for epoch in range(1, cell.epochs + 1):
        model.train()
        logits = _family_logits(
            torch,
            model,
            prepared,
            train_rows,
            page_by_sample,
            cell.context_mode,
            device=device,
        )
        direct_losses = torch.nn.functional.cross_entropy(
            logits, labels, reduction="none"
        )
        direct = torch.sum(direct_losses * weights)
        base_output = model(
            torch.as_tensor(base_local, device=device),
            torch.as_tensor(base_local, device=device),
            base_anchor,
        )
        distill = torch.nn.functional.kl_div(
            torch.log_softmax(base_output.float(), dim=1),
            torch.softmax(base_anchor.float(), dim=1),
            reduction="batchmean",
        )
        total = direct + cell.base_distill_weight * distill
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        if epoch in {1, 4, 8, 12, 16, 20, cell.epochs}:
            model.eval()
            train_logits = _family_logits(
                torch,
                model,
                prepared,
                train_rows,
                page_by_sample,
                cell.context_mode,
                device=device,
            )
            train_metrics = _metrics(
                torch, train_logits, prepared, train_rows, page_by_sample
            )
            history.append(
                {
                    "direct_loss": float(direct.detach().item()),
                    "distill": float(distill.detach().item()),
                    "epoch": epoch,
                    "train_delta": _delta(train_metrics, anchor_train),
                }
            )
    model.eval()
    heldout_rows = tuple(fold["heldout_rows"])
    anchor_heldout = _anchor_metrics(
        torch, prepared, heldout_rows, page_by_sample, device=device
    )
    heldout_logits = _family_logits(
        torch,
        model,
        prepared,
        heldout_rows,
        page_by_sample,
        cell.context_mode,
        device=device,
    )
    heldout = _metrics(torch, heldout_logits, prepared, heldout_rows, page_by_sample)
    return {
        "anchor_heldout": anchor_heldout,
        "heldout": heldout,
        "heldout_delta": _delta(heldout, anchor_heldout),
        "heldout_work_id": str(fold["heldout_work_id"]),
        "history": history,
    }


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
    keys = tuple(folds[0]["heldout_delta"])
    oof_delta = {
        key: float(np.mean([fold["heldout_delta"][key] for fold in folds]))
        for key in keys
    }
    model = _build_model(torch, cell, seed=31_000)
    parameter_count = sum(int(value.numel()) for value in model.parameters())
    mac = 1024 * cell.width + 2 * cell.width + cell.width * 2
    if cell.context_mode != "local":
        mac += 1024 * cell.width
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
        "worst_work_balanced_family_delta": min(
            fold["heldout_delta"]["balanced_family_accuracy"] for fold in folds
        ),
        "worst_work_safe_delta": min(
            fold["heldout_delta"]["safe_top1_accuracy"] for fold in folds
        ),
    }


def screen(device_name: str) -> Mapping[str, Any]:
    import torch

    prepared = r29._prepare(torch)
    page_by_sample = _page_map(prepared)
    device = torch.device(device_name)
    return {
        "results": [
            _run_cell(torch, prepared, page_by_sample, cell, device=device)
            for cell in CELLS
        ],
        "status": "r31_page_family_router_screen",
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
