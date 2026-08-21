"""Train the R31 replacement body/variant router as a QA-only candidate.

The production candidate branches stay frozen.  Only the two-way family router
is replaced, which directly targets the ordinary-dialogue routing failure found
in the r3h runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    from scripts import screen_manga_font_v3_page_family_router_r31 as r31
    from scripts import train_manga_font_v3_page_conditioned_direct_r29 as r29_train
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_page_family_router_r31 as r31
    import train_manga_font_v3_page_conditioned_direct_r29 as r29_train


CHECKPOINT_FILE = "family-router.safetensors"
REPORT_FILE = "report.json"
SCHEMA = "manga-font-v3-page-family-router-r31-qa-v1"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_output(path: Path) -> Path:
    resolved = path.resolve()
    if resolved.exists():
        raise RuntimeError(f"output directory already exists: {resolved}")
    if resolved == Path.cwd().resolve() or len(resolved.parts) < 3:
        raise RuntimeError(f"unsafe output directory: {resolved}")
    return resolved


def train(
    *, output_dir: Path, device_name: str, epochs: int, learning_rate: float
) -> Mapping[str, Any]:
    import torch
    from safetensors.torch import save_file

    if epochs < 1 or not math.isfinite(learning_rate) or learning_rate <= 0:
        raise RuntimeError("invalid training options")
    target = _safe_output(output_dir)
    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        raise RuntimeError(f"staging directory already exists: {staging}")

    prepared = r31.r29._prepare(torch)
    page_by_sample = r31._page_map(prepared)
    rows = tuple(prepared["ledger"]["train"])
    base_indices = r29_train._base_indices(prepared)
    generator = np.random.default_rng(31_000)
    base_indices = np.sort(
        generator.choice(base_indices, size=min(2048, len(base_indices)), replace=False)
    )
    base_local = prepared["local_query"][base_indices].astype(np.float32, copy=False)
    base_anchor = prepared["cache"]["family_logits"][base_indices]

    cell = r31.CELLS[0]
    if cell.name != "local-mlp32" or cell.context_mode != "local":
        raise RuntimeError("R31 production-screen cell drifted")
    device = torch.device(device_name)
    model = r31._build_model(torch, cell, seed=31_000).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), learning_rate, weight_decay=2e-3)
    weights = r31._balanced_weights(rows, torch=torch, device=device)
    labels = torch.as_tensor(
        [row["family_label"] for row in rows], dtype=torch.long, device=device
    )
    anchor_metrics = r31._anchor_metrics(
        torch, prepared, rows, page_by_sample, device=device
    )
    history: list[Mapping[str, Any]] = []

    for epoch in range(1, epochs + 1):
        model.train()
        logits = r31._family_logits(
            torch,
            model,
            prepared,
            rows,
            page_by_sample,
            cell.context_mode,
            device=device,
        )
        direct = torch.sum(
            torch.nn.functional.cross_entropy(logits, labels, reduction="none")
            * weights
        )
        base_output = model(
            torch.as_tensor(base_local, device=device),
            torch.as_tensor(base_local, device=device),
            base_anchor.to(device),
        )
        distill = torch.nn.functional.kl_div(
            torch.log_softmax(base_output.float(), dim=1),
            torch.softmax(base_anchor.to(device).float(), dim=1),
            reduction="batchmean",
        )
        total = direct + cell.base_distill_weight * distill
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

        if epoch in {1, 4, 8, 12, 16, 20, epochs}:
            model.eval()
            metrics = r31._metrics(
                torch,
                r31._family_logits(
                    torch,
                    model,
                    prepared,
                    rows,
                    page_by_sample,
                    cell.context_mode,
                    device=device,
                ),
                prepared,
                rows,
                page_by_sample,
            )
            history.append(
                {
                    "direct_loss": float(direct.detach().item()),
                    "distill": float(distill.detach().item()),
                    "epoch": epoch,
                    "metrics": metrics,
                }
            )

    model.eval()
    final_metrics = r31._metrics(
        torch,
        r31._family_logits(
            torch,
            model,
            prepared,
            rows,
            page_by_sample,
            cell.context_mode,
            device=device,
        ),
        prepared,
        rows,
        page_by_sample,
    )
    state = {name: value.detach().cpu() for name, value in model.state_dict().items()}
    parameter_count = sum(int(value.numel()) for value in state.values())

    staging.mkdir(parents=True)
    try:
        checkpoint = staging / CHECKPOINT_FILE
        save_file(state, str(checkpoint))
        report = {
            "architecture": {
                "context_mode": cell.context_mode,
                "estimated_total_mac_ratio": (
                    r31.PRODUCTION_MAC + 1024 * 32 + 2 * 32 + 32 * 2
                )
                / r31.PRODUCTION_MAC,
                "estimated_total_parameter_ratio": (
                    r31.PRODUCTION_PARAMETERS + parameter_count
                )
                / r31.PRODUCTION_PARAMETERS,
                "hidden_width": 32,
                "parameter_count": parameter_count,
            },
            "checkpoint": {
                "byte_size": checkpoint.stat().st_size,
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint),
            },
            "configuration": {
                "base_distill_weight": cell.base_distill_weight,
                "device": device_name,
                "epochs": epochs,
                "learning_rate": learning_rate,
            },
            "data": {
                "base_preservation_rows": int(len(base_indices)),
                "direct_training_rows": int(len(rows)),
                "direct_work_count": len({str(row["work_id"]) for row in rows}),
                "development_rows_used": 0,
            },
            "history": history,
            "metrics": {
                "anchor": anchor_metrics,
                "candidate": final_metrics,
                "delta": r31._delta(final_metrics, anchor_metrics),
            },
            "production_eligible": False,
            "schema": SCHEMA,
            "screening_evidence": {
                "method": "leave-one-work-out",
                "result": "large_family_routing_gain_with_frozen_candidate_scores",
            },
            "status": "qa_candidate_trained",
        }
        (staging / REPORT_FILE).write_text(
            json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--learning-rate", type=float, default=8e-4)
    args = parser.parse_args()
    print(
        json.dumps(
            train(
                output_dir=args.output_dir,
                device_name=args.device,
                epochs=args.epochs,
                learning_rate=args.learning_rate,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
