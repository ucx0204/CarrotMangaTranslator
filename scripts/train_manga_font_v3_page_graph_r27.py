"""Train a tiny learned page-group residual on existing font labels only."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
    from scripts import train_manga_font_v3_page_context_gate_r25 as r25
    from scripts import train_manga_font_v3_page_context_gate_r26 as r26
except ImportError:  # pragma: no cover
    import train_manga_font_v3_candidate_tristate_r23_logo as r23
    import train_manga_font_v3_page_context_gate_r25 as r25
    import train_manga_font_v3_page_context_gate_r26 as r26


@dataclass(frozen=True)
class Cell:
    name: str
    hidden: int
    maximum_delta: float
    common_weight: float
    js_weight: float
    anchor_weight: float
    learning_rate: float
    epochs: int


CELLS = (
    Cell("h16-d05-c025-js005-a1", 16, 0.5, 0.25, 0.05, 1.0, 1e-3, 30),
    Cell("h32-d05-c050-js010-a1", 32, 0.5, 0.50, 0.10, 1.0, 1e-3, 30),
    Cell("h32-d10-c050-js010-a2", 32, 1.0, 0.50, 0.10, 2.0, 1e-3, 30),
    Cell("h64-d10-c100-js020-a2", 64, 1.0, 1.00, 0.20, 2.0, 7e-4, 30),
)


class PageResidualError(ValueError):
    pass


def _group_input(scores: np.ndarray) -> np.ndarray:
    values = scores.astype(np.float32)
    row_mean = np.mean(values, axis=1, keepdims=True)
    row_std = np.maximum(np.std(values, axis=1, keepdims=True), 1e-4)
    row_norm = (values - row_mean) / row_std
    group_mean = np.mean(row_norm, axis=0, keepdims=True)
    group_std = np.std(row_norm, axis=0, keepdims=True)
    size = np.full((len(values), 1), np.log1p(len(values)), dtype=np.float32)
    return np.concatenate(
        (
            row_norm,
            np.repeat(group_mean, len(values), axis=0),
            np.repeat(group_std, len(values), axis=0),
            size,
        ),
        axis=1,
    )


def _model(torch: Any, cell: Cell, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class PageResidual(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.hidden = torch.nn.Linear(64, cell.hidden)
            self.output = torch.nn.Linear(cell.hidden, 21)
            torch.nn.init.zeros_(self.output.weight)
            torch.nn.init.zeros_(self.output.bias)

        def forward(self, features: Any, scores: Any) -> Any:
            residual = cell.maximum_delta * torch.tanh(
                self.output(torch.nn.functional.gelu(self.hidden(features)))
            )
            return scores + residual

    return PageResidual()


def _batch(
    torch: Any,
    records: Sequence[Mapping[str, Any]],
    *,
    device: Any,
) -> Mapping[str, Any]:
    features = []
    scores = []
    preferred = []
    safe = []
    marginal = []
    unacceptable = []
    safety_negative = []
    row_weights = []
    groups = []
    work_group_counts: dict[str, int] = {}
    work_row_counts: dict[str, int] = {}
    for record in records:
        work = str(record["work_id"])
        work_group_counts[work] = work_group_counts.get(work, 0) + 1
        work_row_counts[work] = work_row_counts.get(work, 0) + len(record["rows"])
    offset = 0
    for record in records:
        group_scores = np.asarray(record["scores"], dtype=np.float32)
        count = len(group_scores)
        work = str(record["work_id"])
        features.append(_group_input(group_scores))
        scores.append(group_scores)
        preferred.extend(
            np.asarray(row["preferred_mask"], dtype=np.bool_) for row in record["rows"]
        )
        safe.extend(
            np.asarray(row["safe_mask"], dtype=np.bool_) for row in record["rows"]
        )
        marginal.extend(
            np.asarray(row["marginal_mask"], dtype=np.bool_) for row in record["rows"]
        )
        unacceptable.extend(
            np.asarray(row["unacceptable_mask"], dtype=np.bool_)
            for row in record["rows"]
        )
        safety_negative.extend(
            bool(row["single_day_safety_negative"]) for row in record["rows"]
        )
        row_weights.extend([1.0 / work_row_counts[work]] * count)
        groups.append(
            {
                "common": torch.as_tensor(
                    record["group"]["common_positive_mask"],
                    dtype=torch.bool,
                    device=device,
                ),
                "end": offset + count,
                "start": offset,
                "weight": 1.0 / (len(work_group_counts) * work_group_counts[work]),
            }
        )
        offset += count
    return {
        "features": torch.as_tensor(np.concatenate(features), device=device),
        "groups": groups,
        "marginal": torch.as_tensor(
            np.stack(marginal), dtype=torch.bool, device=device
        ),
        "preferred": torch.as_tensor(
            np.stack(preferred), dtype=torch.bool, device=device
        ),
        "row_weights": torch.as_tensor(row_weights, dtype=torch.float32, device=device),
        "safe": torch.as_tensor(np.stack(safe), dtype=torch.bool, device=device),
        "safety_negative": torch.as_tensor(
            safety_negative, dtype=torch.bool, device=device
        ),
        "scores": torch.as_tensor(np.concatenate(scores), device=device),
        "unacceptable": torch.as_tensor(
            np.stack(unacceptable), dtype=torch.bool, device=device
        ),
    }


def _loss(
    torch: Any, model: Any, batch: Mapping[str, Any], cell: Cell
) -> tuple[Any, Mapping[str, float]]:
    output = model(batch["features"], batch["scores"])
    candidate, _ = r23.weighted_candidate_set_loss(
        torch,
        output,
        preferred_mask=batch["preferred"],
        safe_mask=batch["safe"],
        marginal_mask=batch["marginal"],
        unacceptable_mask=batch["unacceptable"],
        single_day_safety_negative=batch["safety_negative"],
        marginal_weight=0.25,
        row_weights=batch["row_weights"],
    )
    probabilities = torch.softmax(output.float(), dim=1)
    anchor_probabilities = torch.softmax(batch["scores"].float(), dim=1)
    anchor = torch.nn.functional.kl_div(
        torch.log_softmax(output.float(), dim=1),
        anchor_probabilities,
        reduction="batchmean",
    ).clamp_min(0.0)
    common = output.sum() * 0.0
    js = output.sum() * 0.0
    for group in batch["groups"]:
        selected = probabilities[group["start"] : group["end"]]
        mass = selected[:, group["common"]].sum(dim=1).clamp_min(1e-12)
        common = common + float(group["weight"]) * (-torch.log(mass)).mean()
        mean = selected.mean(dim=0, keepdim=True).clamp_min(1e-12)
        group_js = (
            (selected * (torch.log(selected.clamp_min(1e-12)) - torch.log(mean)))
            .sum(dim=1)
            .mean()
        )
        js = js + float(group["weight"]) * group_js
    total = (
        candidate
        + cell.common_weight * common
        + cell.js_weight * js
        + cell.anchor_weight * anchor
    )
    return total, {
        "anchor": float(anchor.detach().item()),
        "candidate": float(candidate.detach().item()),
        "common": float(common.detach().item()),
        "js": float(js.detach().item()),
        "total": float(total.detach().item()),
    }


def _predict(
    torch: Any, model: Any, records: Sequence[Mapping[str, Any]], device: Any
) -> list[np.ndarray]:
    result = []
    model.eval()
    with torch.inference_mode():
        for record in records:
            scores = np.asarray(record["scores"], dtype=np.float32)
            output = model(
                torch.as_tensor(_group_input(scores), device=device),
                torch.as_tensor(scores, device=device),
            )
            result.append(output.cpu().numpy().astype(np.float64))
    return result


def _evaluate(
    records: Sequence[Mapping[str, Any]], outputs: Sequence[np.ndarray]
) -> Mapping[str, Any]:
    transformed = [
        {**record, "scores": output}
        for record, output in zip(records, outputs, strict=True)
    ]
    base = r25._absolute_group_metrics(records, [False] * len(records))
    candidate = r25._absolute_group_metrics(transformed, [False] * len(records))
    delta = r25._metric_delta(candidate, base)
    per_work_delta = {
        work: {
            key: candidate["per_work"][work][key] - base["per_work"][work][key]
            for key in base["per_work"][work]
        }
        for work in base["per_work"]
    }
    return {
        "delta": delta,
        "per_work_delta": per_work_delta,
        "worst_safe_delta": min(value["safe"] for value in per_work_delta.values()),
    }


def _run_cell(
    torch: Any, records: Sequence[Mapping[str, Any]], cell: Cell, device: Any
) -> Mapping[str, Any]:
    works = sorted({str(record["work_id"]) for record in records})
    outputs: dict[int, np.ndarray] = {}
    fold_losses = []
    for fold_index, heldout in enumerate(works):
        train = [record for record in records if str(record["work_id"]) != heldout]
        test_positions = [
            index
            for index, record in enumerate(records)
            if str(record["work_id"]) == heldout
        ]
        test = [records[index] for index in test_positions]
        batch = _batch(torch, train, device=device)
        model = _model(torch, cell, seed=17_291 + fold_index).to(device)
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=cell.learning_rate, weight_decay=1e-3
        )
        last = None
        model.train()
        for _ in range(cell.epochs):
            optimizer.zero_grad(set_to_none=True)
            total, last = _loss(torch, model, batch, cell)
            total.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        fold_losses.append(last)
        for position, output in zip(
            test_positions, _predict(torch, model, test, device), strict=True
        ):
            outputs[position] = output
    ordered = [outputs[index] for index in range(len(records))]
    metrics = _evaluate(records, ordered)
    parameter_count = sum(value.numel() for value in model.parameters())
    return {
        "cell": cell.name,
        "fold_final_loss_mean": {
            key: float(np.mean([value[key] for value in fold_losses]))
            for key in fold_losses[0]
        },
        "metrics": metrics,
        "parameter_count": int(parameter_count),
    }


def screen(device_name: str) -> Mapping[str, Any]:
    import torch

    records = r26._records()
    device = torch.device(device_name)
    results = [_run_cell(torch, records, cell, device) for cell in CELLS]
    results.sort(
        key=lambda value: (
            min(
                value["metrics"]["delta"]["top1_all_agree"],
                value["metrics"]["delta"]["top1_in_common"],
            ),
            value["metrics"]["delta"]["preferred"],
            value["metrics"]["delta"]["safe"],
        ),
        reverse=True,
    )
    return {
        "group_count": len(records),
        "results": results,
        "status": "r27_page_graph_screen",
        "work_count": 13,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("screen",))
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    result = screen(args.device)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
