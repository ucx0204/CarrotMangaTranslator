"""Screen a 1.5x-budget visual page-context residual using existing labels."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
    from scripts import train_manga_font_v3_page_context_gate_r25 as r25
    from scripts import train_manga_font_v3_page_graph_r27 as r27
except ImportError:  # pragma: no cover
    import train_manga_font_v3_candidate_tristate_r23_logo as r23
    import train_manga_font_v3_page_context_gate_r25 as r25
    import train_manga_font_v3_page_graph_r27 as r27


CELLS = (
    r27.Cell("v32-d05-c050-js010-a1", 32, 0.5, 0.5, 0.1, 1.0, 1e-3, 40),
    r27.Cell("v32-d05-c100-js020-a1", 32, 0.5, 1.0, 0.2, 1.0, 1e-3, 40),
    r27.Cell("v32-d10-c100-js020-a2", 32, 1.0, 1.0, 0.2, 2.0, 1e-3, 40),
    r27.Cell("v32-d10-c200-js040-a3", 32, 1.0, 2.0, 0.4, 3.0, 7e-4, 40),
)
PRODUCTION_PARAMETERS = 74_528
PRODUCTION_MAC = 91_776


def _records_and_context(
    torch: Any,
) -> tuple[tuple[Mapping[str, Any], ...], Mapping[str, Any]]:
    prepared = r25._prepare("cpu")
    records = list(prepared["oof_records"])
    state = r23._load_sidecar_state(
        torch,
        Path("artifacts/manga-font-v3-page-context-gate-r25-seed20260820-v1")
        / r25.SIDECAR_FILE,
    )
    model = r23.build_candidate_model(prepared["context"], torch.device("cpu"))
    r23._apply_sidecar_state(model, state)
    development = r25._attach_scores(
        torch,
        model=model,
        cache=prepared["cache"],
        groups=r23._discriminative_groups(
            prepared["context"]["groups"]["development_eval"]
        ),
        rows=prepared["ledger"]["development_eval"],
    )
    records.extend(development)
    if len(records) != 91:
        raise ValueError("R2.8 group inventory drifted")
    return tuple(records), prepared


def _visual_features(
    records: Sequence[Mapping[str, Any]], prepared: Mapping[str, Any]
) -> Mapping[int, Mapping[str, np.ndarray]]:
    hidden = prepared["cache"]["hidden"].detach().cpu().numpy().astype(np.float32)
    views = prepared["context"]["arrays"]["query_views"].astype(np.float32)
    result = {}
    for record in records:
        indices = np.asarray(record["row_indices"], dtype=np.int64)
        query = np.mean(views[indices], axis=1).reshape(len(indices), -1)
        query /= np.maximum(np.linalg.norm(query, axis=1, keepdims=True), 1e-6)
        group = np.mean(query, axis=0, keepdims=True)
        group /= np.maximum(np.linalg.norm(group, axis=1, keepdims=True), 1e-6)
        result[id(record)] = {
            "group_query": np.repeat(group, len(indices), axis=0).astype(np.float32),
            "local_hidden": hidden[indices],
        }
    return result


def _model(torch: Any, cell: r27.Cell, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class VisualPageResidual(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.group = torch.nn.Linear(1024, 32)
            self.local = torch.nn.Linear(64, 32)
            self.output = torch.nn.Linear(32, 21)
            torch.nn.init.zeros_(self.output.weight)
            torch.nn.init.zeros_(self.output.bias)

        def forward(self, features: Mapping[str, Any], scores: Any) -> Any:
            local = torch.nn.functional.layer_norm(features["local_hidden"], (64,))
            group = torch.nn.functional.layer_norm(features["group_query"], (1024,))
            hidden = torch.nn.functional.gelu(self.local(local) + self.group(group))
            delta = cell.maximum_delta * torch.tanh(self.output(hidden))
            return scores + delta

    return VisualPageResidual()


def _batch(
    torch: Any,
    records: Sequence[Mapping[str, Any]],
    visual: Mapping[int, Mapping[str, np.ndarray]],
    *,
    device: Any,
) -> Mapping[str, Any]:
    batch = dict(r27._batch(torch, records, device=device))
    batch["features"] = {
        name: torch.as_tensor(
            np.concatenate([visual[id(record)][name] for record in records]),
            device=device,
        )
        for name in ("group_query", "local_hidden")
    }
    return batch


def _predict(
    torch: Any,
    model: Any,
    records: Sequence[Mapping[str, Any]],
    visual: Mapping[int, Mapping[str, np.ndarray]],
    device: Any,
) -> list[np.ndarray]:
    output = []
    model.eval()
    with torch.inference_mode():
        for record in records:
            scores = np.asarray(record["scores"], dtype=np.float32)
            features = {
                name: torch.as_tensor(visual[id(record)][name], device=device)
                for name in ("group_query", "local_hidden")
            }
            transformed = model(features, torch.as_tensor(scores, device=device))
            output.append(transformed.cpu().numpy().astype(np.float64))
    return output


def _run_cell(
    torch: Any,
    records: Sequence[Mapping[str, Any]],
    visual: Mapping[int, Mapping[str, np.ndarray]],
    cell: r27.Cell,
    device: Any,
) -> Mapping[str, Any]:
    works = sorted({str(record["work_id"]) for record in records})
    outputs: dict[int, np.ndarray] = {}
    losses = []
    for fold_index, heldout in enumerate(works):
        train = [record for record in records if str(record["work_id"]) != heldout]
        test_positions = [
            index
            for index, record in enumerate(records)
            if str(record["work_id"]) == heldout
        ]
        test = [records[index] for index in test_positions]
        batch = _batch(torch, train, visual, device=device)
        model = _model(torch, cell, seed=31_337 + fold_index).to(device)
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=cell.learning_rate, weight_decay=1e-3
        )
        last = None
        model.train()
        for _ in range(cell.epochs):
            optimizer.zero_grad(set_to_none=True)
            total, last = r27._loss(torch, model, batch, cell)
            total.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        losses.append(last)
        predicted = _predict(torch, model, test, visual, device)
        for position, values in zip(test_positions, predicted, strict=True):
            outputs[position] = values
    metrics = r27._evaluate(records, [outputs[index] for index in range(len(records))])
    parameters = sum(value.numel() for value in model.parameters())
    mac = 1024 * 32 + 64 * 32 + 32 * 21
    return {
        "cell": cell.name,
        "estimated_full_mac_ratio": (PRODUCTION_MAC + mac) / PRODUCTION_MAC,
        "estimated_full_parameter_ratio": (PRODUCTION_PARAMETERS + parameters)
        / PRODUCTION_PARAMETERS,
        "fold_final_loss_mean": {
            key: float(np.mean([value[key] for value in losses])) for key in losses[0]
        },
        "metrics": metrics,
        "parameter_count": int(parameters),
    }


def screen(device_name: str) -> Mapping[str, Any]:
    import torch

    records, prepared = _records_and_context(torch)
    visual = _visual_features(records, prepared)
    device = torch.device(device_name)
    results = [_run_cell(torch, records, visual, cell, device) for cell in CELLS]
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
    return {"results": results, "status": "r28_visual_page_screen"}


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
