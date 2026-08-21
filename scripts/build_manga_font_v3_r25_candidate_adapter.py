#!/usr/bin/env python3
"""Build a sealed QA-only v8 adapter from the frozen R2.5 candidate head.

The R2.5 experiment trains only the final 64 -> 42 candidate residual
projection.  This bridge combines those two tensors with the exact production
r3h adapter so the existing v8 ONNX exporter can evaluate the learned head on
cached page inputs.  It does not grant release, calibration, or production
authority.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import train_manga_font_student_v8_role_family_adapter as v8
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
    from scripts import train_manga_font_v3_page_context_gate_r25 as r25
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v8_role_family_adapter as v8
    import train_manga_font_v3_candidate_tristate_r23_logo as r23
    import train_manga_font_v3_page_context_gate_r25 as r25


DEFAULT_R25_DIR = Path("artifacts/manga-font-v3-page-context-gate-r25-seed20260820-v1")
DEFAULT_ANCHOR_DIR = Path(
    "artifacts/manga-font-student-v81-role-family-adapter-production-r3h"
)
DEFAULT_OUTPUT_DIR = Path("artifacts/manga-font-v3-r25-candidate-adapter-qa-only-v1")

EXPECTED_R25_PRODUCER = (
    46_144,
    "b5fca7867bbe2989399ee0df39dc72e8b36a65f6084ffa45b20dc1410ed6a36e",
)
EXPECTED_R25_MANIFEST_SHA256 = (
    "01a82a86584f6fc033bae6a61d5ec538fb8894adc40080ea76b60ccd1cea492e"
)
EXPECTED_R25_RECORD_SHA256 = (
    "eb1d967f4f57b361256d9ebc58d9d8792efa775ff2055cbf122cafc8665f79d6"
)
EXPECTED_ANCHOR_CHECKPOINT_SHA256 = r23.EXPECTED_ANCHOR_CHECKPOINT_SHA256
EXPECTED_ANCHOR_MANIFEST_SHA256 = (
    "4512537525d09443d15506af17204aff498a0bab4b803eeff6680acfeeff1bba"
)

SCHEMA_VERSION = "manga-font-v3-r25-candidate-adapter-bridge-v1"
RECORD_TYPE = "manga_font_v3_r25_candidate_adapter_bridge"
PRODUCER_FILE = "build_manga_font_v3_r25_candidate_adapter.py"


class R25CandidateAdapterError(ValueError):
    """Raised when the bridge cannot prove its complete source binding."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _read_json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise R25CandidateAdapterError(f"{label} is invalid JSON") from error
    if not isinstance(value, Mapping):
        raise R25CandidateAdapterError(f"{label} must be an object")
    return value


def _descriptor(path: Path) -> Mapping[str, Any]:
    return {"byte_size": path.stat().st_size, "sha256": _sha256(path)}


def _assert_regular(path: Path, label: str) -> Path:
    absolute = path.expanduser().absolute()
    if path.is_symlink() or absolute.is_symlink() or not absolute.is_file():
        raise R25CandidateAdapterError(f"{label} is missing or linked")
    return absolute


def _assert_directory(path: Path, label: str, expected: set[str]) -> Path:
    absolute = path.expanduser().absolute()
    if path.is_symlink() or absolute.is_symlink() or not absolute.is_dir():
        raise R25CandidateAdapterError(f"{label} is missing or linked")
    children = tuple(absolute.iterdir())
    if {child.name for child in children} != expected or any(
        child.is_symlink() or not child.is_file() for child in children
    ):
        raise R25CandidateAdapterError(f"{label} exact inventory drifted")
    return absolute


def _assert_producers() -> Mapping[str, Mapping[str, Any]]:
    current = _assert_regular(Path(__file__), "bridge producer")
    r25_path = _assert_regular(Path(r25.__file__), "R2.5 producer")
    if (
        r25_path.stat().st_size != EXPECTED_R25_PRODUCER[0]
        or _sha256(r25_path) != EXPECTED_R25_PRODUCER[1]
    ):
        raise R25CandidateAdapterError("frozen R2.5 producer drifted")
    return {
        "bridge": {
            "byte_size": current.stat().st_size,
            "file_name": PRODUCER_FILE,
            "sha256": _sha256(current),
        },
        "r25": {
            "byte_size": r25_path.stat().st_size,
            "file_name": Path(r25.__file__).name,
            "sha256": _sha256(r25_path),
        },
    }


def _validate_anchor(root: Path) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    from safetensors.torch import load_file

    resolved = _assert_directory(root, "production r3h adapter", set(v8.OUTPUT_FILES))
    marker_path = resolved / v8.MARKER_FILE
    manifest_path = resolved / v8.MANIFEST_FILE
    checkpoint_path = resolved / v8.CHECKPOINT_FILE
    marker = _read_json(marker_path, "production r3h marker")
    manifest = _read_json(manifest_path, "production r3h manifest")
    v8.validate_record_seal(marker, "production r3h marker")
    v8.validate_record_seal(manifest, "production r3h manifest")
    artifacts = marker.get("artifacts")
    files = manifest.get("files")
    checkpoint = files.get(v8.CHECKPOINT_FILE) if isinstance(files, Mapping) else None
    if (
        _sha256(manifest_path) != EXPECTED_ANCHOR_MANIFEST_SHA256
        or _sha256(checkpoint_path) != EXPECTED_ANCHOR_CHECKPOINT_SHA256
        or manifest.get("schema_version") != v8.SCHEMA_VERSION
        or marker.get("owner") != v8.OWNER
        or marker.get("safe_replace") is not True
        or not isinstance(artifacts, Mapping)
        or artifacts.get(v8.MANIFEST_FILE) != _sha256(manifest_path)
        or artifacts.get(v8.CHECKPOINT_FILE) != _sha256(checkpoint_path)
        or not isinstance(checkpoint, Mapping)
        or checkpoint != _descriptor(checkpoint_path)
        or not isinstance(manifest.get("quality_gate"), Mapping)
        or manifest["quality_gate"].get("passed") is not True
    ):
        raise R25CandidateAdapterError("production r3h adapter binding drifted")
    state = dict(load_file(str(checkpoint_path), device="cpu"))
    if len(state) != r23.ANCHOR_TENSOR_COUNT:
        raise R25CandidateAdapterError("production r3h tensor inventory drifted")
    return manifest, state


def _metric_delta(
    candidate: Mapping[str, Any], anchor: Mapping[str, Any]
) -> Mapping[str, float]:
    return {
        "acceptable_at1": float(candidate["acceptable_at1"] - anchor["acceptable_at1"]),
        "family_accuracy": float(
            candidate["family_accuracy"] - anchor["family_accuracy"]
        ),
        "preferred_at1": float(candidate["preferred_at1"] - anchor["preferred_at1"]),
        "single_day_body_false_top1_rate": float(
            candidate["single_day_body_false_top1_rate"]
            - anchor["single_day_body_false_top1_rate"]
        ),
        "top1_max_candidate_share": float(
            candidate["top1_max_candidate_share"] - anchor["top1_max_candidate_share"]
        ),
    }


def _materialize(
    *, r25_dir: Path, anchor_dir: Path
) -> tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    import torch

    producer = _assert_producers()
    r25_root = r25_dir.expanduser().absolute()
    r25_result = r25.validate_output(r25_root)
    if (
        r25_result.get("manifest_sha256") != EXPECTED_R25_MANIFEST_SHA256
        or r25_result.get("manifest_record_sha256") != EXPECTED_R25_RECORD_SHA256
        or r25_result.get("development_page_gate_passed") is not False
        or r25_result.get("nonpromotable") is not True
    ):
        raise R25CandidateAdapterError("R2.5 source artifact binding drifted")
    r25_manifest = _read_json(r25_root / r25.MANIFEST_FILE, "R2.5 manifest")
    anchor_manifest, anchor_state = _validate_anchor(anchor_dir)
    prepared = r25._prepare("cpu")
    model = r23.build_candidate_model(prepared["context"], torch.device("cpu"))
    sidecar = r23._load_sidecar_state(torch, r25_root / r25.SIDECAR_FILE)
    if set(sidecar) != set(r23.TRAINABLE_NAMES):
        raise R25CandidateAdapterError("R2.5 sidecar tensor inventory drifted")
    r23._apply_sidecar_state(model, sidecar)
    candidate_state = {
        name: value.detach().cpu().contiguous()
        for name, value in model.state_dict().items()
    }
    if set(candidate_state) != set(anchor_state):
        raise R25CandidateAdapterError("combined adapter tensor inventory drifted")
    for name, anchor in anchor_state.items():
        candidate = candidate_state[name]
        if (
            tuple(candidate.shape) != tuple(anchor.shape)
            or candidate.dtype != anchor.dtype
            or not torch.isfinite(candidate).all()
        ):
            raise R25CandidateAdapterError(f"combined adapter tensor drifted: {name}")
        if name not in r23.TRAINABLE_NAMES and not torch.equal(candidate, anchor):
            raise R25CandidateAdapterError(f"frozen r3h tensor changed: {name}")
    if all(
        torch.equal(candidate_state[name], anchor_state[name])
        for name in r23.TRAINABLE_NAMES
    ):
        raise R25CandidateAdapterError("R2.5 candidate head is an anchor no-op")
    anchor_model = r23.build_candidate_model(prepared["context"], torch.device("cpu"))
    candidate_metrics = r23.evaluate_base_metrics(
        torch,
        model,
        cache=prepared["cache"],
        arrays=prepared["context"]["arrays"],
        candidate_ids=prepared["context"]["candidate_ids"],
    )
    anchor_metrics = r23.evaluate_base_metrics(
        torch,
        anchor_model,
        cache=prepared["cache"],
        arrays=prepared["context"]["arrays"],
        candidate_ids=prepared["context"]["candidate_ids"],
    )
    if candidate_metrics.get("quality_gate_passed") is not True:
        raise R25CandidateAdapterError(
            "combined adapter failed the v8 exporter quality gate"
        )
    direct = _read_json(
        r25_root.parent
        / "manga-font-v3-candidate-tristate-r23-logo-marginal-weak-negative-0-25-seed20260820-v1"
        / r23.MANIFEST_FILE,
        "R2.3 weak-negative manifest",
    )
    r23.v8.validate_record_seal(direct, "R2.3 weak-negative manifest")
    direct_logo = direct.get("logo_aggregate")
    if not isinstance(direct_logo, Mapping):
        raise R25CandidateAdapterError("R2.3 LOGO evidence is missing")
    context = {
        "anchor_manifest": anchor_manifest,
        "anchor_metrics": anchor_metrics,
        "candidate_metrics": candidate_metrics,
        "candidate_state": candidate_state,
        "direct_logo": direct_logo,
        "producer": producer,
        "r25_manifest": r25_manifest,
    }
    return context, anchor_state, candidate_state


def _manifest_core(context: Mapping[str, Any]) -> Mapping[str, Any]:
    anchor = context["anchor_manifest"]
    candidate_metrics = context["candidate_metrics"]
    anchor_metrics = context["anchor_metrics"]
    r25_manifest = context["r25_manifest"]
    direct_logo = context["direct_logo"]
    direct_delta = direct_logo["heldout_work_macro_delta"]
    return {
        "architecture": copy.deepcopy(anchor["architecture"]),
        "authority": {
            "automatic_release_authority": False,
            "calibration_authority": False,
            "evaluation_authority": False,
            "exporter_candidate": True,
            "human_gold": False,
            "nonpromotable": True,
            "production_integration_authorized": False,
            "training_label_authority": "codex_agent_training_only",
        },
        "best_epoch": {
            "epoch": int(r25_manifest["candidate_head_refit"]["epochs"]),
            "selection": "fixed_r23_logo_epoch_policy_then_r25_full_refit",
            "val": copy.deepcopy(candidate_metrics["all"]),
            "val_by_authority": {"visual": copy.deepcopy(candidate_metrics["visual"])},
        },
        "candidate_ids": list(anchor["candidate_ids"]),
        "candidate_weighting": copy.deepcopy(anchor["candidate_weighting"]),
        "configuration": {
            "candidate_head_refit": copy.deepcopy(r25_manifest["candidate_head_refit"]),
            "r25": copy.deepcopy(r25_manifest["configuration"]),
        },
        "dataset": copy.deepcopy(anchor["dataset"]),
        "history": copy.deepcopy(r25_manifest["candidate_head_refit"]["history"]),
        "quality_gate": {
            "checks": copy.deepcopy(candidate_metrics["quality_checks"]),
            "passed": True,
            "routing_authority": "predicted_pixel_family_with_single_day_eligibility",
            "scope": "broad_export_sanity_only_not_release_or_promotion",
        },
        "source_query_head": copy.deepcopy(anchor["source_query_head"]),
        "training_seconds": float(r25_manifest["training_seconds"]),
        "v3_candidate_bridge": {
            "anchor_checkpoint_sha256": EXPECTED_ANCHOR_CHECKPOINT_SHA256,
            "anchor_manifest_sha256": EXPECTED_ANCHOR_MANIFEST_SHA256,
            "base_metric_delta": {
                "all": _metric_delta(candidate_metrics["all"], anchor_metrics["all"]),
                "visual": _metric_delta(
                    candidate_metrics["visual"], anchor_metrics["visual"]
                ),
            },
            "changed_tensor_names": list(r23.TRAINABLE_NAMES),
            "direct_logo_delta": {
                "preferred_top1_accuracy": float(
                    direct_delta["preferred_top1_accuracy"]
                ),
                "safe_top1_accuracy": float(direct_delta["safe_top1_accuracy"]),
                "single_day_unsafe_top1_rate": float(
                    direct_delta["single_day_unsafe_top1_rate"]
                ),
                "unacceptable_top1_rate": float(direct_delta["unacceptable_top1_rate"]),
            },
            "r25_manifest_record_sha256": EXPECTED_R25_RECORD_SHA256,
            "r25_manifest_sha256": EXPECTED_R25_MANIFEST_SHA256,
            "runtime_parameter_or_mac_delta": 0,
            "source_sidecar_file": r25.SIDECAR_FILE,
            "source_sidecar_sha256": r25_manifest["assets"][r25.SIDECAR_FILE]["sha256"],
        },
        "v3_producer": copy.deepcopy(context["producer"]),
    }


def _safe_new_output(path: Path) -> Path:
    absolute = path.expanduser().absolute()
    if path.is_symlink() or absolute.exists() or len(absolute.name) < 3:
        raise R25CandidateAdapterError("output must be a new non-linked directory")
    return absolute


def build(*, r25_dir: Path, anchor_dir: Path, output_dir: Path) -> Mapping[str, Any]:
    from safetensors.torch import save_file

    output = _safe_new_output(output_dir)
    context, _anchor_state, candidate_state = _materialize(
        r25_dir=r25_dir, anchor_dir=anchor_dir
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        checkpoint = staging / v8.CHECKPOINT_FILE
        save_file(dict(candidate_state), str(checkpoint))
        manifest = v8.seal_record(
            {
                **dict(_manifest_core(context)),
                "files": {v8.CHECKPOINT_FILE: _descriptor(checkpoint)},
                "record_type": "manga_font_student_v8_role_family_adapter_manifest",
                "schema_version": v8.SCHEMA_VERSION,
            }
        )
        manifest_path = staging / v8.MANIFEST_FILE
        manifest_path.write_bytes(v8.json_bytes(manifest, pretty=True))
        marker = v8.seal_record(
            {
                "artifacts": {
                    v8.CHECKPOINT_FILE: _sha256(checkpoint),
                    v8.MANIFEST_FILE: _sha256(manifest_path),
                },
                "owner": v8.OWNER,
                "safe_replace": True,
                "schema_version": v8.SCHEMA_VERSION,
                "v3_bridge_schema_version": SCHEMA_VERSION,
            }
        )
        (staging / v8.MARKER_FILE).write_bytes(v8.json_bytes(marker, pretty=True))
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate(r25_dir=r25_dir, anchor_dir=anchor_dir, output_dir=output)


def validate(*, r25_dir: Path, anchor_dir: Path, output_dir: Path) -> Mapping[str, Any]:
    from safetensors.torch import load_file

    root = _assert_directory(output_dir, "R2.5 adapter bridge", set(v8.OUTPUT_FILES))
    marker = _read_json(root / v8.MARKER_FILE, "R2.5 adapter marker")
    manifest = _read_json(root / v8.MANIFEST_FILE, "R2.5 adapter manifest")
    v8.validate_record_seal(marker, "R2.5 adapter marker")
    v8.validate_record_seal(manifest, "R2.5 adapter manifest")
    context, _anchor_state, candidate_state = _materialize(
        r25_dir=r25_dir, anchor_dir=anchor_dir
    )
    checkpoint = root / v8.CHECKPOINT_FILE
    files = manifest.get("files")
    descriptor = files.get(v8.CHECKPOINT_FILE) if isinstance(files, Mapping) else None
    artifacts = marker.get("artifacts")
    expected_core = {
        **dict(_manifest_core(context)),
        "files": {v8.CHECKPOINT_FILE: _descriptor(checkpoint)},
        "record_type": "manga_font_student_v8_role_family_adapter_manifest",
        "schema_version": v8.SCHEMA_VERSION,
    }
    actual_core = dict(manifest)
    actual_record = actual_core.pop("record_sha256", None)
    expected_manifest = v8.seal_record(expected_core)
    if (
        marker.get("owner") != v8.OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != v8.SCHEMA_VERSION
        or marker.get("v3_bridge_schema_version") != SCHEMA_VERSION
        or not isinstance(artifacts, Mapping)
        or set(artifacts) != {v8.CHECKPOINT_FILE, v8.MANIFEST_FILE}
        or artifacts.get(v8.CHECKPOINT_FILE) != _sha256(checkpoint)
        or artifacts.get(v8.MANIFEST_FILE) != _sha256(root / v8.MANIFEST_FILE)
        or descriptor != _descriptor(checkpoint)
        or actual_core != expected_core
        or actual_record != expected_manifest["record_sha256"]
    ):
        raise R25CandidateAdapterError("R2.5 adapter bridge manifest drifted")
    loaded = dict(load_file(str(checkpoint), device="cpu"))
    if set(loaded) != set(candidate_state) or any(
        not __import__("torch").equal(loaded[name], candidate_state[name])
        for name in loaded
    ):
        raise R25CandidateAdapterError("R2.5 adapter bridge checkpoint drifted")
    return {
        "base_all_acceptable_delta": manifest["v3_candidate_bridge"][
            "base_metric_delta"
        ]["all"]["acceptable_at1"],
        "base_all_preferred_delta": manifest["v3_candidate_bridge"][
            "base_metric_delta"
        ]["all"]["preferred_at1"],
        "checkpoint_sha256": _sha256(checkpoint),
        "direct_logo_joint_delta": min(
            manifest["v3_candidate_bridge"]["direct_logo_delta"]["safe_top1_accuracy"],
            manifest["v3_candidate_bridge"]["direct_logo_delta"][
                "preferred_top1_accuracy"
            ],
        ),
        "manifest_sha256": _sha256(root / v8.MANIFEST_FILE),
        "nonpromotable": True,
        "output_dir": str(root),
        "status": "validated_qa_only_r25_candidate_adapter_bridge",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "validate"):
        command = commands.add_parser(name)
        command.add_argument("--r25-dir", type=Path, default=DEFAULT_R25_DIR)
        command.add_argument("--anchor-dir", type=Path, default=DEFAULT_ANCHOR_DIR)
        command.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build(
                r25_dir=args.r25_dir,
                anchor_dir=args.anchor_dir,
                output_dir=args.output_dir,
            )
        else:
            result = validate(
                r25_dir=args.r25_dir,
                anchor_dir=args.anchor_dir,
                output_dir=args.output_dir,
            )
    except (
        R25CandidateAdapterError,
        r25.R25TrainingError,
        r23.R23TrainingError,
    ) as error:
        raise SystemExit(str(error)) from error
    print(_canonical(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
