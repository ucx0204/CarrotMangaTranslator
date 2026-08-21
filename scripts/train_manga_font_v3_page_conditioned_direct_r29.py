"""Train the deployable full-data R29 page-conditioned font ranker head.

This is a QA candidate producer.  It keeps the production encoder/ranker
frozen and learns one bounded context head from the sealed training split.
The page context is computed only from anchor probabilities and visual
queries, so the same calculation is available in the runtime graph.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_page_conditioned_direct_r29 as r29
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_page_conditioned_direct_r29 as r29


SCHEMA = "manga-font-v3-page-conditioned-direct-r29-qa-v1"
CHECKPOINT_FILE = "page-context-head.safetensors"
REPORT_FILE = "report.json"


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


def _direct_schedule(
    prepared: Mapping[str, Any], rows: Sequence[Mapping[str, Any]], *, epoch: int
) -> tuple[tuple[Mapping[str, Any], ...], np.ndarray]:
    source = tuple(rows)
    indices = np.asarray([row["row_index"] for row in source], dtype=np.int64)
    works = np.asarray([row["work_id"] for row in source]).astype(str)
    labels = np.asarray([row["family_label"] for row in source], dtype=np.int64)
    weights = np.asarray(
        [row["supervision_weight"] for row in source], dtype=np.float32
    )
    seed_bytes = hashlib.sha256(
        f"manga-font-r29-full-direct\0{epoch}".encode()
    ).digest()
    seed = int.from_bytes(seed_bytes[:8], "big", signed=False)
    batches, normalized, contract = r29.r23.r1._direct_balanced_schedule(
        indices,
        works,
        labels,
        weights,
        balance_mode="work_family",
        batch_size=2048,
        seed=seed,
    )
    order = np.concatenate(batches).astype(np.int64, copy=False)
    strata = sorted(set(zip(works.tolist(), labels.tolist(), strict=True)))
    if (
        len(strata) != 20
        or int(contract["stratum_count"]) != 20
        or sorted(order.tolist()) != list(range(len(source)))
    ):
        raise RuntimeError("full direct work-family schedule drifted")
    ordered = tuple(source[int(index)] for index in order.tolist())
    return ordered, normalized[order]


def _base_indices(prepared: Mapping[str, Any]) -> np.ndarray:
    arrays = prepared["context"]["arrays"]
    direct = {int(row["row_index"]) for row in prepared["ledger"]["rows"]}
    values = np.asarray(
        [
            index
            for index, split in enumerate(arrays["split"].tolist())
            if int(split) == 0 and index not in direct
        ],
        dtype=np.int64,
    )
    if len(values) < 10_000 or set(values.tolist()) & direct:
        raise RuntimeError("base-preservation partition drifted")
    return values


def _distillation_loss(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    indices: np.ndarray,
    *,
    device: Any,
) -> Any:
    output = r29._outputs(torch, model, prepared, indices, device=device)
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    loss = 0.0
    for actual, name in (
        (output["family_logits"], "family_logits"),
        (output["body_candidate_scores"], "body_candidate_scores"),
        (output["variant_candidate_scores"], "variant_candidate_scores"),
    ):
        anchor = cache[name][positions].to(device)
        loss = loss + torch.nn.functional.kl_div(
            torch.log_softmax(actual.float(), dim=1),
            torch.softmax(anchor.float(), dim=1),
            reduction="batchmean",
        )
    return loss / 3.0


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

    prepared = r29._prepare(torch)
    rows = tuple(prepared["ledger"]["train"])
    base_indices = _base_indices(prepared)
    device = torch.device(device_name)
    model = r29._build_model(torch, seed=20260829).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=1e-4
    )
    anchor_metrics = r29._row_metrics(torch, model, prepared, rows, device=device)
    history = []
    single_day_index = tuple(prepared["context"]["candidate_ids"]).index("single-day")

    for epoch in range(1, epochs + 1):
        model.train()
        ordered_rows, weights = _direct_schedule(prepared, rows, epoch=epoch)
        indices = np.asarray([row["row_index"] for row in ordered_rows], dtype=np.int64)
        output = r29._outputs(torch, model, prepared, indices, device=device)
        tensors = r29.r23._tier_tensors(torch, ordered_rows, device=device)
        row_weights = torch.as_tensor(weights, dtype=torch.float32, device=device)
        routed = torch.where(
            tensors["family_labels"][:, None] == 0,
            output["body_candidate_scores"],
            output["variant_candidate_scores"],
        )
        candidate_loss, _ = r29.r23.weighted_candidate_set_loss(
            torch,
            routed,
            preferred_mask=tensors["preferred_mask"],
            safe_mask=tensors["safe_mask"],
            marginal_mask=tensors["marginal_mask"],
            unacceptable_mask=tensors["unacceptable_mask"],
            single_day_safety_negative=tensors["single_day_safety_negative"],
            marginal_weight=r29.MARGINAL_WEIGHT,
            row_weights=row_weights,
        )
        family_loss = torch.nn.functional.cross_entropy(
            output["family_logits"], tensors["family_labels"], reduction="none"
        )
        family_loss = torch.sum(family_loss * row_weights) / row_weights.sum()
        safety = r29.r23._single_day_safety_losses(
            torch,
            output,
            safe_mask=tensors["safe_mask"],
            family_labels=tensors["family_labels"],
            safety_negative=tensors["single_day_safety_negative"],
            row_weights=row_weights,
            single_day_index=single_day_index,
        )
        distill = _distillation_loss(
            torch, model, prepared, base_indices, device=device
        )
        total = (
            candidate_loss
            + 0.5 * family_loss
            + r29.r23.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT
            * safety["body_hard_negative"]
            + r29.r23.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
            * safety["supervised_hard_negative"]
            + 0.75 * distill
            + 0.001 * output["delta"].square().mean()
        )
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        model.eval()
        metrics = r29._row_metrics(torch, model, prepared, rows, device=device)
        history.append(
            {
                "base_kl": float(
                    _distillation_loss(
                        torch, model, prepared, base_indices, device=device
                    ).item()
                ),
                "epoch": epoch,
                "loss": float(total.detach().item()),
                "metrics": metrics,
            }
        )

    model.eval()
    final_metrics = r29._row_metrics(torch, model, prepared, rows, device=device)
    state = {name: tensor.detach().cpu() for name, tensor in model.state_dict().items()}
    parameter_count = sum(int(value.numel()) for value in state.values())
    staging.mkdir(parents=True)
    try:
        checkpoint_path = staging / CHECKPOINT_FILE
        save_file(state, str(checkpoint_path))
        report = {
            "architecture": {
                "estimated_total_mac_ratio": (
                    r29.PRODUCTION_MAC
                    + (1024 + 1024 + 44) * r29.HIDDEN_WIDTH
                    + r29.HIDDEN_WIDTH * 44
                )
                / r29.PRODUCTION_MAC,
                "estimated_total_parameter_ratio": (
                    r29.PRODUCTION_PARAMETERS + parameter_count
                )
                / r29.PRODUCTION_PARAMETERS,
                "head_hidden_width": r29.HIDDEN_WIDTH,
                "page_context": "anchor-soft-family-weighted-page-mean-v1",
                "parameter_count": parameter_count,
            },
            "checkpoint": {
                "byte_size": checkpoint_path.stat().st_size,
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint_path),
            },
            "configuration": {
                "device": device_name,
                "epochs": epochs,
                "learning_rate": learning_rate,
                "marginal_weight": r29.MARGINAL_WEIGHT,
                "maximum_delta": r29.MAXIMUM_DELTA,
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
                "delta": r29._delta(final_metrics, anchor_metrics),
            },
            "production_eligible": False,
            "schema": SCHEMA,
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
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
