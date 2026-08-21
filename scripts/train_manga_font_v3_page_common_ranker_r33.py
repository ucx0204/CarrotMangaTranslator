"""Train the R33 soft page-common candidate prior as a QA-only artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Mapping

try:
    from scripts import screen_manga_font_v3_page_common_ranker_r33 as r33
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_page_common_ranker_r33 as r33


CHECKPOINT_FILE = "page-common-ranker.safetensors"
REPORT_FILE = "report.json"
SCHEMA = "manga-font-v3-page-common-ranker-r33-qa-v1"
R31_HEAD = Path("artifacts/manga-font-v3-page-family-router-r31-local-mlp32-qa-v1")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def train(*, output_dir: Path, device_name: str) -> Mapping[str, Any]:
    import torch
    from safetensors.torch import load_file, save_file

    target = output_dir.resolve()
    if target.exists() or target == Path.cwd().resolve() or len(target.parts) < 3:
        raise RuntimeError(f"unsafe or existing output directory: {target}")
    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        raise RuntimeError(f"staging directory already exists: {staging}")

    prepared = r33.r32.r31.r29._prepare(torch)
    page_by_sample = r33.r32.r31._page_map(prepared)
    rows = tuple(prepared["ledger"]["train"])
    groups = r33._group_rows(rows, page_by_sample)
    device = torch.device(device_name)
    features = r33._group_features(torch, prepared, groups, device=device)
    groups = tuple(features["groups"])
    weights = r33._group_weights(groups, torch=torch, device=device)
    model = r33._build_page_model(torch, seed=33_000).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=1e-4)
    history = []
    for epoch in range(1, 33):
        model.train()
        output = model(
            features["page_query"], features["per_query"], features["anchor_body"]
        )
        preferred = r33._set_loss(
            torch, output["page_scores"], features["common_preferred"]
        )
        safe = r33._set_loss(torch, output["page_scores"], features["common_safe"])
        set_loss = torch.sum((0.65 * preferred + 0.35 * safe) * weights)
        total = set_loss + 0.01 * output["delta"].square().mean()
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        if epoch in {1, 4, 8, 16, 24, 32}:
            history.append(
                {
                    "epoch": epoch,
                    "maximum_absolute_delta": float(
                        output["delta"].detach().abs().max().item()
                    ),
                    "set_loss": float(set_loss.detach().item()),
                }
            )
    model.eval()

    family_model = r33.r32.r31._build_model(torch, r33.r32.r31.CELLS[0], seed=0).to(
        device
    )
    family_state = load_file(str(R31_HEAD / "family-router.safetensors"), device="cpu")
    family_model.load_state_dict(family_state, strict=True)
    family_model.eval()
    anchor = r33.r32._metrics(
        torch,
        r33.r32._anchor_output(prepared, rows, device=device),
        prepared,
        rows,
        page_by_sample,
    )
    candidate = r33._evaluate(
        torch,
        family_model,
        model,
        prepared,
        rows,
        page_by_sample,
        1.0,
        device=device,
    )
    state = {name: value.detach().cpu() for name, value in model.state_dict().items()}
    parameter_count = sum(int(value.numel()) for value in state.values())

    staging.mkdir(parents=True)
    try:
        checkpoint = staging / CHECKPOINT_FILE
        save_file(state, str(checkpoint))
        report = {
            "architecture": {
                "estimated_total_mac_ratio": 1.8664578996687565,
                "estimated_total_parameter_ratio": (
                    r33.PRODUCTION_PARAMETERS + 32_962 + parameter_count
                )
                / r33.PRODUCTION_PARAMETERS,
                "fixed_candidate_prototype_dot_mac": 21 * 1024,
                "page_ranker_parameter_count": parameter_count,
                "total_new_trainable_parameters": 32_962 + parameter_count,
            },
            "checkpoint": {
                "byte_size": checkpoint.stat().st_size,
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint),
            },
            "configuration": {
                "device": device_name,
                "epochs": 32,
                "learning_rate": 8e-4,
                "page_delta_strength": 1.0,
            },
            "data": {
                "development_rows_used": 0,
                "direct_training_rows": len(rows),
                "page_common_group_count": len(groups),
                "work_count": len({str(group["work_id"]) for group in groups}),
            },
            "history": history,
            "metrics": {
                "anchor": anchor,
                "candidate": candidate,
                "delta": r33.r32._delta(candidate, anchor),
            },
            "production_eligible": False,
            "r31_family_router_checkpoint_sha256": _sha256(
                R31_HEAD / "family-router.safetensors"
            ),
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    print(
        json.dumps(
            train(output_dir=args.output_dir, device_name=args.device),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
