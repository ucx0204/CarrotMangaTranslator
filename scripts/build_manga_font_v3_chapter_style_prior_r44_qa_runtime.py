"""Package the trained R44 shared chapter prior as a QA-only runtime."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping

try:
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import (
        build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export,
    )
    from scripts import (
        build_manga_font_v3_style_metric_chapter_ranker_r42_qa_runtime as r42_build,
    )
    from scripts import train_manga_font_v3_chapter_style_prior_r44 as r44_train
except ImportError:  # pragma: no cover
    import build_font_matching_runtime_artifact as runtime
    import build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export
    import build_manga_font_v3_style_metric_chapter_ranker_r42_qa_runtime as r42_build
    import train_manga_font_v3_chapter_style_prior_r44 as r44_train


HEAD_DIR = Path("artifacts/manga-font-v3-chapter-style-prior-r44-qa-v1")


def build(output_dir: Path, *, head_dir: Path = HEAD_DIR) -> Mapping[str, Any]:
    target = output_dir.resolve()
    if target.exists():
        raise RuntimeError(f"output directory already exists: {target}")
    head = head_dir.resolve()
    report = r29_export._read_json(head / r44_train.REPORT_FILE)
    if report.get("schema") != r44_train.SCHEMA:
        raise RuntimeError("R44 report schema drifted")
    checkpoint = head / r44_train.CHECKPOINT_FILE
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        for name in r29_export.FILES:
            if name in {"ranker.onnx", "runtime-contract.json", r29_export.FILES[0]}:
                continue
            source = r42_build.BASE_RUNTIME / name
            destination = staging / name
            if name not in {"encoder.onnx", "prototype-features.f32"}:
                shutil.copy2(source, destination)
                continue
            try:
                os.link(source, destination)
            except OSError:
                shutil.copy2(source, destination)
        parity = r42_build.fuse_ranker(
            r42_build.BASE_RUNTIME / "ranker.onnx",
            checkpoint,
            staging / "ranker.onnx",
        )
        contract = r29_export._read_json(
            r42_build.BASE_RUNTIME / "runtime-contract.json"
        )
        source_model_version = str(contract["model_version"])
        ranker = staging / "ranker.onnx"
        descriptor = {
            "byte_size": ranker.stat().st_size,
            "file": "ranker.onnx",
            "sha256": r29_export._sha256(ranker),
        }
        contract["artifacts"]["ranker.onnx"] = descriptor
        contract["head"] = dict(contract["head"])
        contract["head"]["onnx_sha256"] = descriptor["sha256"]
        contract["head"]["version"] = "manga-font-v10-r44-chapter-style-prior-onnx-v1"
        contract["model_version"] = f"manga-font-v10-r44-{descriptor['sha256'][:12]}"
        contract["r44_chapter_style_prior_qa"] = {
            "automatic_mutation_release_approved": False,
            "calibration_reused_without_refit": True,
            "checkpoint_sha256": r29_export._sha256(checkpoint),
            "context_boundary": "runtime_batch_mean_currently_page_scoped",
            "local_r33_scores_preserved": True,
            "parity": parity,
            "production_eligible": False,
            "source_model_version": source_model_version,
            "training_report_sha256": r29_export._sha256(head / r44_train.REPORT_FILE),
        }
        calibration = r29_export._read_json(
            r42_build.BASE_RUNTIME / "selection-calibration.json"
        )
        bindings = dict(calibration["bindings"])
        bindings["model_version"] = contract["model_version"]
        bindings["ranker_sha256"] = descriptor["sha256"]
        bindings["runtime_contract_sha256"] = (
            r29_export._source_runtime_contract_sha256(contract)
        )
        calibration["bindings"] = bindings
        calibration = runtime.seal_record(
            {key: value for key, value in calibration.items() if key != "record_sha256"}
        )
        calibration_path = staging / "selection-calibration.json"
        calibration_path.write_bytes(runtime.json_bytes(calibration, pretty=True))
        contract["artifacts"]["selection-calibration.json"] = {
            "byte_size": calibration_path.stat().st_size,
            "file": "selection-calibration.json",
            "sha256": r29_export._sha256(calibration_path),
        }
        contract = runtime.seal_record(
            {key: value for key, value in contract.items() if key != "record_sha256"}
        )
        (staging / "runtime-contract.json").write_bytes(
            runtime.json_bytes(contract, pretty=True)
        )
        marker = {
            "artifacts": {
                name: r29_export._sha256(staging / name)
                for name in r29_export.FILES
                if name != r29_export.FILES[0]
            },
            "owner": "carrot-manga-translator/font-matching-runtime-artifact-v2",
            "qa_only": True,
            "release_approved": False,
            "safe_replace": True,
            "schema_version": "font-matching-runtime-artifact-v2",
        }
        (staging / r29_export.FILES[0]).write_bytes(
            runtime.json_bytes(marker, pretty=True)
        )
        if {path.name for path in staging.iterdir()} != set(r29_export.FILES):
            raise RuntimeError("R44 runtime inventory drifted")
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {
        "model_version": contract["model_version"],
        "output_dir": str(target),
        "parity": parity,
        "qa_only": True,
        "ranker": descriptor,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--head-dir", type=Path, default=HEAD_DIR)
    args = parser.parse_args()
    print(
        json.dumps(
            build(args.output_dir, head_dir=args.head_dir),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
