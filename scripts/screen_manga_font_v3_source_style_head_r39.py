"""Work-disjoint screen for restoring the source-style signal removed in v8.

The current R33 runtime emits neutral source-style logits even though its
SigLIP2 query embeddings still contain the source pixels.  This script trains a
small 1024->32->10 style head only on the existing reviewed training split and
compares held-out-work error with a train-work mean baseline.  It is an
architecture screen, not an export or promotion producer.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    from scripts import screen_manga_font_v3_contextual_set_r34 as r34
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_contextual_set_r34 as r34


STYLE_FILE = Path(
    "artifacts/font-matching-training-export-full22-strict-v1/samples.jsonl"
)
STYLE_FIELDS = (
    "angularity",
    "energy",
    "handwritten",
    "irregularity",
    "roundness",
    "serifness",
    "slant",
    "stroke_contrast",
    "weight",
    "width",
)


def _examples(prepared: Mapping[str, Any]) -> tuple[Mapping[str, Any], ...]:
    sample_ids = tuple(
        str(value) for value in prepared["context"]["arrays"]["sample_ids"]
    )
    row_by_sample = {
        sample_id: position for position, sample_id in enumerate(sample_ids)
    }
    result = []
    with STYLE_FILE.open("r", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if row.get("split") != "train":
                continue
            sample_id = str(row["sample_id"])
            if sample_id not in row_by_sample:
                raise RuntimeError(
                    f"style sample is absent from R33 input: {sample_id}"
                )
            style = row.get("source_style")
            if not isinstance(style, dict):
                raise RuntimeError(f"style target is missing: {sample_id}")
            values = []
            mask = []
            for field in STYLE_FIELDS:
                value = style.get(field)
                values.append(0.0 if value is None else float(value))
                mask.append(value is not None)
            result.append(
                {
                    "mask": np.asarray(mask, dtype=np.bool_),
                    "row_index": row_by_sample[sample_id],
                    "sample_id": sample_id,
                    "target": np.asarray(values, dtype=np.float32),
                    "work_id": str(row["work_id"]),
                }
            )
    return tuple(result)


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class SourceStyleHead(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.network = torch.nn.Sequential(
                torch.nn.LayerNorm(1024),
                torch.nn.Linear(1024, 32),
                torch.nn.GELU(),
                torch.nn.Linear(32, len(STYLE_FIELDS)),
            )

        def forward(self, query: Any) -> Any:
            return torch.sigmoid(self.network(query.float()))

    return SourceStyleHead()


def _fold(
    torch: Any,
    prepared: Mapping[str, Any],
    examples: tuple[Mapping[str, Any], ...],
    heldout_work: str,
    *,
    epochs: int,
    fold_index: int,
    device: Any,
) -> Mapping[str, Any]:
    train = tuple(row for row in examples if row["work_id"] != heldout_work)
    heldout = tuple(row for row in examples if row["work_id"] == heldout_work)
    if not train or not heldout:
        raise RuntimeError("style work fold is empty")
    train_indices = np.asarray([row["row_index"] for row in train], dtype=np.int64)
    heldout_indices = np.asarray([row["row_index"] for row in heldout], dtype=np.int64)
    train_query = torch.as_tensor(prepared["local_query"][train_indices], device=device)
    heldout_query = torch.as_tensor(
        prepared["local_query"][heldout_indices], device=device
    )
    train_target = torch.as_tensor(
        np.stack([row["target"] for row in train]), device=device
    )
    train_mask = torch.as_tensor(
        np.stack([row["mask"] for row in train]), device=device
    )
    heldout_target = torch.as_tensor(
        np.stack([row["target"] for row in heldout]), device=device
    )
    heldout_mask = torch.as_tensor(
        np.stack([row["mask"] for row in heldout]), device=device
    )
    work_counts: dict[str, int] = {}
    for row in train:
        work_counts[row["work_id"]] = work_counts.get(row["work_id"], 0) + 1
    weights = torch.as_tensor(
        [1.0 / (len(work_counts) * work_counts[row["work_id"]]) for row in train],
        dtype=torch.float32,
        device=device,
    )
    model = _build_model(torch, seed=39_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=5e-3)
    for _ in range(epochs):
        prediction = model(train_query)
        squared = (prediction - train_target).square() * train_mask
        per_row = squared.sum(dim=1) / train_mask.sum(dim=1).clamp_min(1)
        loss = torch.sum(per_row * weights)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
    model.eval()
    with torch.no_grad():
        prediction = model(heldout_query)
        axis_weight = train_mask.float() * weights[:, None]
        baseline = (train_target * axis_weight).sum(dim=0) / axis_weight.sum(
            dim=0
        ).clamp_min(1e-6)
        model_error = (prediction - heldout_target).abs()
        baseline_error = (baseline[None, :] - heldout_target).abs()
    model_values = model_error[heldout_mask]
    baseline_values = baseline_error[heldout_mask]
    axis_model = {}
    axis_baseline = {}
    for position, field in enumerate(STYLE_FIELDS):
        active = heldout_mask[:, position]
        if bool(active.any()):
            axis_model[field] = float(model_error[active, position].mean().item())
            axis_baseline[field] = float(baseline_error[active, position].mean().item())
    return {
        "baseline_mae": float(baseline_values.mean().item()),
        "heldout_rows": len(heldout),
        "model_mae": float(model_values.mean().item()),
        "model_vs_baseline": float(
            model_values.mean().item() - baseline_values.mean().item()
        ),
        "per_axis_baseline_mae": axis_baseline,
        "per_axis_model_mae": axis_model,
        "work_id": heldout_work,
    }


def screen(device_name: str, *, epochs: int) -> Mapping[str, Any]:
    import torch

    prepared = r34.r33.r32.r31.r29._prepare(torch)
    examples = _examples(prepared)
    works = tuple(sorted({row["work_id"] for row in examples}))
    device = torch.device(device_name)
    folds = []
    for fold_index, work_id in enumerate(works):
        folds.append(
            _fold(
                torch,
                prepared,
                examples,
                work_id,
                epochs=epochs,
                fold_index=fold_index,
                device=device,
            )
        )
        print(
            f"completed R39 style fold {fold_index + 1}/{len(works)}",
            file=sys.stderr,
            flush=True,
        )
    model = _build_model(torch, seed=39_000)
    axis_model = {
        field: float(
            np.mean(
                [
                    fold["per_axis_model_mae"][field]
                    for fold in folds
                    if field in fold["per_axis_model_mae"]
                ]
            )
        )
        for field in STYLE_FIELDS
    }
    axis_baseline = {
        field: float(
            np.mean(
                [
                    fold["per_axis_baseline_mae"][field]
                    for fold in folds
                    if field in fold["per_axis_baseline_mae"]
                ]
            )
        )
        for field in STYLE_FIELDS
    }
    return {
        "architecture": {
            "input": "frozen_siglip2_local_query_1024",
            "new_parameter_count": sum(
                int(value.numel()) for value in model.parameters()
            ),
            "output": list(STYLE_FIELDS),
        },
        "folds": folds,
        "macro": {
            "baseline_mae": float(np.mean([fold["baseline_mae"] for fold in folds])),
            "model_mae": float(np.mean([fold["model_mae"] for fold in folds])),
            "model_vs_baseline": float(
                np.mean([fold["model_vs_baseline"] for fold in folds])
            ),
            "per_axis_baseline_mae": axis_baseline,
            "per_axis_model_mae": axis_model,
        },
        "production_eligible": False,
        "reviewed_training_rows": len(examples),
        "status": "r39_source_style_head_architecture_screen",
        "work_disjoint_folds": len(folds),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=160)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.epochs <= 0 or args.epochs > 500:
        raise ValueError("epochs must be between 1 and 500")
    result = screen(args.device, epochs=args.epochs)
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
