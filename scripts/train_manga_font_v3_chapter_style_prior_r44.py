"""Train the full-data R44 shared chapter style prior for visual QA."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Mapping

try:
    from scripts import screen_manga_font_v3_chapter_style_prior_r44 as r44
    from scripts import train_manga_font_v3_style_metric_chapter_ranker_r42 as r42_train
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_chapter_style_prior_r44 as r44
    import train_manga_font_v3_style_metric_chapter_ranker_r42 as r42_train


SCHEMA = "manga-font-v3-chapter-style-prior-r44-qa-v1"
CHECKPOINT_FILE = "chapter-style-prior.safetensors"
REPORT_FILE = "report.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def train(
    *,
    output_dir: Path,
    device_name: str,
    style_epochs: int,
    prior_epochs: int,
) -> Mapping[str, Any]:
    import torch
    from safetensors.torch import save_file

    target = output_dir.resolve()
    if target.exists() or target == Path.cwd().resolve() or len(target.parts) < 3:
        raise RuntimeError(f"unsafe or existing output directory: {target}")
    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        raise RuntimeError(f"staging directory already exists: {staging}")
    r33_checkpoint = r42_train.R33_HEAD_DIR / r42_train.R33_CHECKPOINT_FILE
    prepared = r44.r42.r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r44.r42.r41.r36.r35.r34._identity_maps(prepared)
    rows = tuple(prepared["ledger"]["train"])
    style_examples = tuple(r44.r42.r40.r39._examples(prepared))
    device = torch.device(device_name)
    style_model = r42_train._train_style_model(
        torch,
        prepared,
        style_examples,
        epochs=style_epochs,
        device=device,
    )
    r33_model = r42_train._load_r33_model(
        torch, device=device, checkpoint=r33_checkpoint
    )
    with torch.no_grad():
        r33_scores = r44.r42.r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            rows,
            identities,
            context_model=None,
            family_model=None,
            r33_model=r33_model,
            device=device,
        )["scores"]
    anchor = r44.r42.r41.r36._score_map(rows, r33_scores)
    groups = r44.r42.r41.r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    )
    prior_model, history = r44._train_model(
        torch,
        prepared,
        style_model,
        groups,
        anchor,
        epochs=prior_epochs,
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
            for name, value in prior_model.state_dict().items()
        },
        # The shared R42 graph fuser consumes an explicit zero local branch.
        "metric.local_axis_logits": torch.zeros(10, dtype=torch.float32),
        "metric.local_strength": torch.tensor(-100.0, dtype=torch.float32),
    }
    staging.mkdir(parents=True)
    try:
        checkpoint_path = staging / CHECKPOINT_FILE
        save_file(state, str(checkpoint_path))
        report = {
            "architecture": {
                "chapter_context": "mean_predicted_source_style_over_runtime_batch",
                "local_style_metric": "disabled_exactly_by_contract",
                "prior_parameter_count": sum(
                    int(value.numel()) for value in prior_model.parameters()
                ),
                "style_parameter_count": sum(
                    int(value.numel()) for value in style_model.parameters()
                ),
            },
            "candidate_ids": list(prepared["context"]["candidate_ids"]),
            "checkpoint": {
                "byte_size": checkpoint_path.stat().st_size,
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint_path),
            },
            "configuration": {
                "device": device_name,
                "prior_epochs": prior_epochs,
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
            "r33_checkpoint_sha256": _sha256(r33_checkpoint),
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
    parser.add_argument("--prior-epochs", type=int, default=12)
    args = parser.parse_args()
    print(
        json.dumps(
            train(
                output_dir=args.output_dir,
                device_name=args.device,
                style_epochs=args.style_epochs,
                prior_epochs=args.prior_epochs,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
