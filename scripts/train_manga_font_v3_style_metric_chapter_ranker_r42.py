"""Train the full-data R42 style-metric ranker as a QA-only artifact.

This is the renderable companion to the work-disjoint R42 architecture screen.
It keeps the released R33 page head frozen, learns the source-style head from
the reviewed style rows, then learns only the small local/chapter metric on the
training-only direct labels.  The artifact is deliberately non-promotable; it
exists so real manga pages can be rendered and inspected before more training.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    from scripts import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42


SCHEMA = "manga-font-v3-style-metric-chapter-ranker-r42-qa-v1"
CHECKPOINT_FILE = "style-metric-ranker.safetensors"
REPORT_FILE = "report.json"
R33_HEAD_DIR = Path("artifacts/manga-font-v3-page-common-ranker-r33-qa-v1")
R33_CHECKPOINT_FILE = "page-common-ranker.safetensors"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _train_style_model(
    torch: Any,
    prepared: Mapping[str, Any],
    examples: tuple[Mapping[str, Any], ...],
    *,
    epochs: int,
    device: Any,
) -> Any:
    indices = np.asarray([row["row_index"] for row in examples], dtype=np.int64)
    query = torch.as_tensor(prepared["local_query"][indices], device=device)
    target = torch.as_tensor(
        np.stack([row["target"] for row in examples]), device=device
    )
    mask = torch.as_tensor(np.stack([row["mask"] for row in examples]), device=device)
    work_counts: dict[str, int] = {}
    for row in examples:
        work_id = str(row["work_id"])
        work_counts[work_id] = work_counts.get(work_id, 0) + 1
    weights = torch.as_tensor(
        [
            1.0 / (len(work_counts) * work_counts[str(row["work_id"])])
            for row in examples
        ],
        dtype=torch.float32,
        device=device,
    )
    model = r42.r40.r39._build_model(torch, seed=42_390).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=5e-3)
    for _ in range(epochs):
        prediction = model(query)
        squared = (prediction - target).square() * mask
        per_row = squared.sum(dim=1) / mask.sum(dim=1).clamp_min(1)
        loss = torch.sum(per_row * weights)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
    return model.requires_grad_(False).eval()


def _load_r33_model(torch: Any, *, device: Any, checkpoint: Path) -> Any:
    from safetensors.torch import load_file

    model = r42.r41.r36.r35.r34.r33._build_page_model(torch, seed=0).to(device)
    model.load_state_dict(load_file(str(checkpoint), device="cpu"), strict=True)
    return model.requires_grad_(False).eval()


def train(
    *,
    output_dir: Path,
    device_name: str,
    style_epochs: int,
    metric_epochs: int,
) -> Mapping[str, Any]:
    import torch
    from safetensors.torch import save_file

    target = output_dir.resolve()
    if target.exists() or target == Path.cwd().resolve() or len(target.parts) < 3:
        raise RuntimeError(f"unsafe or existing output directory: {target}")
    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        raise RuntimeError(f"staging directory already exists: {staging}")
    checkpoint = R33_HEAD_DIR / R33_CHECKPOINT_FILE
    if not checkpoint.is_file():
        raise RuntimeError(f"R33 checkpoint is missing: {checkpoint}")

    prepared = r42.r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r42.r41.r36.r35.r34._identity_maps(prepared)
    rows = tuple(prepared["ledger"]["train"])
    style_examples = tuple(r42.r40.r39._examples(prepared))
    device = torch.device(device_name)
    style_model = _train_style_model(
        torch,
        prepared,
        style_examples,
        epochs=style_epochs,
        device=device,
    )
    r33_model = _load_r33_model(torch, device=device, checkpoint=checkpoint)
    with torch.no_grad():
        r33_scores = r42.r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            rows,
            identities,
            context_model=None,
            family_model=None,
            r33_model=r33_model,
            device=device,
        )["scores"]
    anchor = r42.r41.r36._score_map(rows, r33_scores)
    groups = r42.r41.r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    )
    metric_model, history = r42._train_metric(
        torch,
        prepared,
        style_model,
        groups,
        anchor,
        epochs=metric_epochs,
        fold_index=0,
        device=device,
    )

    state = {
        **{
            f"style.{name}": value.detach().cpu().contiguous()
            for name, value in style_model.state_dict().items()
        },
        **{
            f"metric.{name}": value.detach().cpu().contiguous()
            for name, value in metric_model.state_dict().items()
        },
    }
    staging.mkdir(parents=True)
    try:
        checkpoint_path = staging / CHECKPOINT_FILE
        save_file(state, str(checkpoint_path))
        candidate_ids = tuple(prepared["context"]["candidate_ids"])
        report = {
            "architecture": {
                "chapter_context": "mean_predicted_source_style_over_runtime_batch",
                "metric_parameter_count": sum(
                    int(value.numel()) for value in metric_model.parameters()
                ),
                "style_fields": list(r42.r40.r39.STYLE_FIELDS),
                "style_parameter_count": sum(
                    int(value.numel()) for value in style_model.parameters()
                ),
            },
            "candidate_ids": list(candidate_ids),
            "checkpoint": {
                "byte_size": checkpoint_path.stat().st_size,
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint_path),
            },
            "configuration": {
                "device": device_name,
                "metric_epochs": metric_epochs,
                "style_epochs": style_epochs,
            },
            "data": {
                "chapter_group_count": len(groups),
                "direct_training_rows": len(rows),
                "style_training_rows": len(style_examples),
                "work_count": len({str(row["work_id"]) for row in rows}),
            },
            "history": history,
            "production_eligible": False,
            "r33_checkpoint_sha256": _sha256(checkpoint),
            "schema": SCHEMA,
            "status": "qa_candidate_trained_for_visual_rendering",
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
    parser.add_argument("--style-epochs", type=int, default=160)
    parser.add_argument("--metric-epochs", type=int, default=12)
    args = parser.parse_args()
    if args.style_epochs <= 0 or args.metric_epochs <= 0:
        raise ValueError("epoch counts must be positive")
    print(
        json.dumps(
            train(
                output_dir=args.output_dir,
                device_name=args.device,
                style_epochs=args.style_epochs,
                metric_epochs=args.metric_epochs,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
