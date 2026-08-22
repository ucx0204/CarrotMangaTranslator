"""Train the full-data R45 prototype-aware chapter set ranker for visual QA."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Mapping

try:
    from scripts import screen_manga_font_v3_prototype_set_ranker_r45 as r45
    from scripts import train_manga_font_v3_style_metric_chapter_ranker_r42 as r42_train
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_prototype_set_ranker_r45 as r45
    import train_manga_font_v3_style_metric_chapter_ranker_r42 as r42_train


SCHEMA = "manga-font-v3-prototype-set-ranker-r45-qa-v1"
CHECKPOINT_FILE = "prototype-set-ranker.safetensors"
REPORT_FILE = "report.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def train(*, output_dir: Path, device_name: str, epochs: int) -> Mapping[str, Any]:
    import torch
    from safetensors.torch import save_file

    target = output_dir.resolve()
    if target.exists() or target == Path.cwd().resolve() or len(target.parts) < 3:
        raise RuntimeError(f"unsafe or existing output directory: {target}")
    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        raise RuntimeError(f"staging directory already exists: {staging}")
    r33_checkpoint = r42_train.R33_HEAD_DIR / r42_train.R33_CHECKPOINT_FILE
    if not r33_checkpoint.is_file():
        raise RuntimeError(f"R33 checkpoint is missing: {r33_checkpoint}")

    prepared = r45.r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    identities = r45.r41.r36.r35.r34._identity_maps(prepared)
    rows = tuple(prepared["ledger"]["train"])
    device = torch.device(device_name)
    family_model = r45.r41.r36.r35.r34._load_family_model(torch, device=device)
    r33_model = r42_train._load_r33_model(
        torch, device=device, checkpoint=r33_checkpoint
    )
    with torch.no_grad():
        r33_scores = r45.r41.r36.r35.r34._scores_for_rows(
            torch,
            prepared,
            rows,
            identities,
            context_model=None,
            family_model=family_model,
            r33_model=r33_model,
            device=device,
        )["scores"]
    anchor = r45.r41.r36._score_map(rows, r33_scores)
    groups = r45.r41.r36._chapter_groups(
        rows, identities, require_multiple_body_rows=False
    )
    model, history = r45._train_model(
        torch,
        prepared,
        groups,
        anchor,
        epochs=epochs,
        fold_index=0,
        device=device,
    )
    state = {
        name: value.detach().cpu().contiguous()
        for name, value in model.state_dict().items()
    }
    staging.mkdir(parents=True)
    try:
        checkpoint_path = staging / CHECKPOINT_FILE
        save_file(state, str(checkpoint_path))
        report = {
            "architecture": {
                "candidate_input": "actual_frozen_korean_font_prototype_queries_1024",
                "chapter_style_expert_count": r45.EXPERT_COUNT,
                "context": "prototype_aware_multi_style_deep_set",
                "parameter_count": sum(
                    int(value.numel()) for value in model.parameters()
                ),
                "scorer_width": r45.SCORER_WIDTH,
                "token_width": r45.TOKEN_WIDTH,
            },
            "candidate_ids": list(prepared["context"]["candidate_ids"]),
            "checkpoint": {
                "byte_size": checkpoint_path.stat().st_size,
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint_path),
            },
            "configuration": {"device": device_name, "epochs": epochs},
            "data": {
                "chapter_group_count": len(groups),
                "direct_training_rows": len(rows),
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
    parser.add_argument("--epochs", type=int, default=12)
    args = parser.parse_args()
    if args.epochs <= 0 or args.epochs > 80:
        raise ValueError("epochs must be between 1 and 80")
    print(
        json.dumps(
            train(
                output_dir=args.output_dir,
                device_name=args.device,
                epochs=args.epochs,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
