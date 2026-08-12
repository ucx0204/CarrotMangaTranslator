#!/usr/bin/env python3
"""Export a QA-only active21 v8 body/variant ONNX graph bundle.

This is the smallest deployment-side companion to
``train_manga_font_student_v8_role_family_adapter.py``.  It reuses the sealed
v7 encoder/query head and replaces only the neutral ranker tail:

* ``candidate_scores`` remains a compatibility alias of body scores;
* body and variant scores come from separate learned query mixtures; and
* role logits come from the pixel-only role-family gate.

The output is deliberately a graph bundle, not an application runtime release.
It cannot enable automatic mutation until the normal runtime contract,
calibration, WASM parity, fresh evaluation, and 40-page QA release steps attach
and accept it.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import export_font_matching_runtime_onnx as legacy_export
    from scripts import export_manga_font_student_v7_mass21_runtime_onnx as v7
    from scripts import train_manga_font_student_v8_role_family_adapter as adapter_trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_matching_runtime_artifact as runtime  # type: ignore[no-redef]
    import export_font_matching_runtime_onnx as legacy_export  # type: ignore[no-redef]
    import export_manga_font_student_v7_mass21_runtime_onnx as v7  # type: ignore[no-redef]
    import train_manga_font_student_v8_role_family_adapter as adapter_trainer  # type: ignore[no-redef]


SCHEMA_VERSION = "manga-font-student-v8-role-family-onnx-graph-bundle-v1"
OWNER = "carrot-manga-translator/manga-font-student-v8-role-family-onnx-graph-bundle-v1"
REPORT_FILE = "v8-graph-report.json"
MARKER_FILE = ".manga-font-student-v8-role-family-onnx-graph-owned.json"
OUTPUT_FILES = frozenset(
    {
        v7.ACTIVE_CATALOG_FILE,
        v7.ENCODER_FILE,
        v7.PROTOTYPE_FILE,
        v7.RANKER_FILE,
        REPORT_FILE,
        MARKER_FILE,
    }
)
MIN_PARITY_SAMPLES = 32


class MangaFontV8RuntimeExportError(ValueError):
    """Raised when a v8 graph bundle cannot be proven safe and reproducible."""


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MangaFontV8RuntimeExportError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise MangaFontV8RuntimeExportError(f"{location}: expected object")
    return value


def load_adapter(
    *,
    adapter_dir: Path,
    candidate_ids: Sequence[str],
    allow_failed_quality: bool,
) -> Any:
    try:
        import torch
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV8RuntimeExportError(
            "torch and safetensors are required"
        ) from error
    root = adapter_dir.expanduser().resolve()
    manifest_path = root / adapter_trainer.MANIFEST_FILE
    checkpoint_path = root / adapter_trainer.CHECKPOINT_FILE
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV8RuntimeExportError("adapter directory is missing or linked")
    manifest = _read_json(manifest_path, "adapter manifest")
    if (
        manifest.get("schema_version") != adapter_trainer.SCHEMA_VERSION
        or tuple(manifest.get("candidate_ids", ())) != tuple(candidate_ids)
    ):
        raise MangaFontV8RuntimeExportError("adapter identity contract drifted")
    core = dict(manifest)
    declared_record = core.pop("record_sha256", None)
    actual_record = adapter_trainer.seal_record(core)["record_sha256"]
    if declared_record != actual_record:
        raise MangaFontV8RuntimeExportError("adapter manifest seal drifted")
    files = manifest.get("files")
    descriptor = (
        files.get(adapter_trainer.CHECKPOINT_FILE)
        if isinstance(files, Mapping)
        else None
    )
    if (
        not isinstance(descriptor, Mapping)
        or descriptor.get("sha256") != adapter_trainer.sha256_file(checkpoint_path)
        or descriptor.get("byte_size") != checkpoint_path.stat().st_size
    ):
        raise MangaFontV8RuntimeExportError("adapter checkpoint binding drifted")
    quality = manifest.get("quality_gate")
    passed = isinstance(quality, Mapping) and quality.get("passed") is True
    if not passed and not allow_failed_quality:
        raise MangaFontV8RuntimeExportError("adapter source quality gate failed")
    architecture = manifest.get("architecture")
    maximum_bias = 0.35
    residual_hidden_dim = 64
    maximum_sample_residual = 0.75
    if isinstance(architecture, Mapping):
        # The checkpoint remains authoritative; this default only reconstructs
        # the non-parameter bound used in the forward pass.
        maximum_bias = float(architecture.get("maximum_family_bias", maximum_bias))
        residual_hidden_dim = int(
            architecture.get("candidate_residual_hidden_dim", residual_hidden_dim)
        )
        maximum_sample_residual = float(
            architecture.get("maximum_sample_residual", maximum_sample_residual)
        )
    model = adapter_trainer.build_role_family_adapter(
        torch,
        candidate_count=len(candidate_ids),
        maximum_family_bias=maximum_bias,
        candidate_residual_hidden_dim=residual_hidden_dim,
        maximum_sample_residual=maximum_sample_residual,
    )
    try:
        model.load_state_dict(
            dict(load_file(str(checkpoint_path), device="cpu")), strict=True
        )
    except Exception as error:  # noqa: BLE001
        raise MangaFontV8RuntimeExportError(
            f"adapter checkpoint reconstruction failed: {error}"
        ) from error
    model.requires_grad_(False)
    model.eval()
    model.to("cpu", dtype=torch.float32)
    return model


def make_wrappers(
    *,
    authority: v7.V7RuntimeAuthority,
    legacy_student: Any,
    vision: Any,
    head: Any,
    adapter: Any,
) -> tuple[Any, Any]:
    """Build v7-compatible encoder and v8 role-family ranker wrappers."""

    import torch

    class EncoderWrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.legacy_vision = legacy_student.vision_encoder
            self.legacy_projection = legacy_student.projection
            self.patch_vision = vision
            self.query_head = head

        def forward(self, pixel_values: Any) -> Any:
            legacy_output = self.legacy_vision(
                pixel_values=pixel_values, return_dict=False
            )
            compatibility = torch.nn.functional.normalize(
                self.legacy_projection(legacy_output[1]).float(), p=2, dim=-1
            )
            patch_output = self.patch_vision(
                pixel_values=pixel_values, return_dict=False
            )
            query_embeddings, _attention = self.query_head.encode(patch_output[0])
            return torch.cat(
                [compatibility, query_embeddings.flatten(start_dim=1)], dim=-1
            )

    treatment_fields = tuple(sorted(v7.trainer.TREATMENT_VALUES))

    class RankerWrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.adapter = adapter

        def forward(self, views: Any, prototype_features: Any) -> tuple[Any, ...]:
            query_views = views[:, :, v7.LEGACY_FEATURE_DIM :].reshape(
                views.shape[0],
                3,
                adapter_trainer.QUERY_COUNT,
                adapter_trainer.QUERY_DIM,
            )
            candidate_prototypes = []
            for bag in authority.candidate_bags:
                rows = prototype_features[
                    int(bag["start"]) : int(bag["start"]) + int(bag["count"]),
                    v7.LEGACY_FEATURE_DIM :,
                ].reshape(
                    int(bag["count"]),
                    adapter_trainer.QUERY_COUNT,
                    adapter_trainer.QUERY_DIM,
                )
                candidate_prototypes.append(rows.mean(dim=0))
            outputs = self.adapter(query_views, torch.stack(candidate_prototypes))
            body_scores = outputs["body_candidate_scores"]
            variant_scores = outputs["variant_candidate_scores"]
            role_logits = adapter_trainer.expand_family_logits_to_role_logits(
                torch, outputs["family_logits"]
            )
            neutral = body_scores[:, 0] * 0.0
            none_logits = neutral - 20.0
            style_logits = neutral[:, None].expand(
                -1, len(v7.trainer.STYLE_FIELDS)
            )
            treatments = tuple(
                neutral[:, None].expand(
                    -1, len(v7.trainer.TREATMENT_VALUES[field])
                )
                for field in treatment_fields
            )
            view_gate_weights = torch.ones_like(views[:, :, 0]) / 3.0
            return (
                body_scores,
                body_scores,
                variant_scores,
                none_logits,
                role_logits,
                style_logits,
                *treatments,
                view_gate_weights,
            )

    return EncoderWrapper().eval(), RankerWrapper().eval()


def _parity(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    authority: v7.V7RuntimeAuthority,
    encoder_path: Path,
    ranker_path: Path,
    sample_count: int,
    seed: int,
) -> Mapping[str, Any]:
    if sample_count < MIN_PARITY_SAMPLES:
        raise MangaFontV8RuntimeExportError(
            f"parity requires at least {MIN_PARITY_SAMPLES} rows"
        )
    encoder_inputs = legacy_export._synthetic_encoder_inputs(sample_count, seed)  # noqa: SLF001
    rng = np.random.default_rng(seed ^ 0x815)
    views = rng.standard_normal((sample_count, 3, v7.FEATURE_DIM), dtype=np.float32)
    views /= np.maximum(
        np.linalg.norm(views, axis=-1, keepdims=True), np.float32(1e-12)
    )
    reference_encoder, reference_ranker = legacy_export._run_reference_models(  # noqa: SLF001
        encoder_wrapper=encoder_wrapper,
        ranker_wrapper=ranker_wrapper,
        encoder_inputs=encoder_inputs,
        ranker_views=np.ascontiguousarray(views),
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=7,
        ranker_batch_size=11,
        output_names=v7.RANKER_OUTPUT_NAMES,
    )
    actual_encoder, actual_ranker, evidence = legacy_export._run_cpu_ort(  # noqa: SLF001
        encoder_path=encoder_path,
        ranker_path=ranker_path,
        encoder_inputs=encoder_inputs,
        ranker_views=np.ascontiguousarray(views),
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=7,
        ranker_batch_size=11,
        output_names=v7.RANKER_OUTPUT_NAMES,
    )
    if reference_encoder.shape != actual_encoder.shape or set(reference_ranker) != set(
        actual_ranker
    ):
        raise MangaFontV8RuntimeExportError("CPU parity shape/inventory drifted")
    encoder_error = float(np.max(np.abs(reference_encoder - actual_encoder)))
    ranker_error = max(
        float(np.max(np.abs(reference_ranker[name] - actual_ranker[name])))
        for name in reference_ranker
    )
    body_alias_error = float(
        np.max(
            np.abs(
                actual_ranker["candidate_scores"]
                - actual_ranker["body_candidate_scores"]
            )
        )
    )
    branch_delta = float(
        np.max(
            np.abs(
                actual_ranker["body_candidate_scores"]
                - actual_ranker["variant_candidate_scores"]
            )
        )
    )
    role_span = float(np.max(np.ptp(actual_ranker["role_logits"], axis=1)))
    if (
        not math.isfinite(encoder_error)
        or not math.isfinite(ranker_error)
        or encoder_error > 2e-4
        or ranker_error > 2e-4
        or body_alias_error != 0.0
        or branch_delta <= 1e-6
        or role_span <= 1e-6
    ):
        raise MangaFontV8RuntimeExportError(
            "v8 parity or non-neutral branch evidence failed"
        )
    return {
        "body_compatibility_alias_max_abs_error": body_alias_error,
        "body_variant_max_abs_delta": branch_delta,
        "cpu": evidence,
        "encoder_max_abs_error": encoder_error,
        "ranker_max_abs_error": ranker_error,
        "role_logit_max_span": role_span,
        "sample_count": sample_count,
        "sample_source": "deterministic_synthetic_only",
    }


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontV8RuntimeExportError(f"unsafe output directory: {result}")
    return result


def build_graph_bundle(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    v7_output_dir: Path,
    adapter_dir: Path,
    output_dir: Path,
    allow_r3_fixture_source: bool,
    allow_failed_adapter_quality: bool,
    parity_samples: int,
    parity_seed: int,
    replace_owned_output: bool,
) -> Mapping[str, Any]:
    authority = v7.load_v7_runtime_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
        v7_output_dir=v7_output_dir,
        allow_r3_fixture_source=allow_r3_fixture_source,
    )
    adapter = load_adapter(
        adapter_dir=adapter_dir,
        candidate_ids=authority.candidate_ids,
        allow_failed_quality=allow_failed_adapter_quality,
    )
    target = _safe_output(output_dir)
    if target.exists() and not replace_owned_output:
        raise MangaFontV8RuntimeExportError(
            "graph output exists; pass --replace-owned-output"
        )
    if target.exists():
        marker = target / MARKER_FILE
        if not marker.is_file():
            raise MangaFontV8RuntimeExportError("refusing to replace unowned output")
        old = _read_json(marker, "existing graph marker")
        if old.get("owner") != OWNER or old.get("safe_replace") is not True:
            raise MangaFontV8RuntimeExportError("refusing to replace unowned output")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        (staging / v7.ACTIVE_CATALOG_FILE).write_bytes(
            runtime.json_bytes(authority.active_catalog, pretty=True)
        )
        (staging / v7.PROTOTYPE_FILE).write_bytes(
            authority.packed_prototypes.tobytes()
        )
        legacy_student, vision, head = v7._load_models(authority)  # noqa: SLF001
        encoder_wrapper, ranker_wrapper = make_wrappers(
            authority=authority,
            legacy_student=legacy_student,
            vision=vision,
            head=head,
            adapter=adapter,
        )
        v7._export_graphs(  # noqa: SLF001
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=staging / v7.ENCODER_FILE,
            ranker_path=staging / v7.RANKER_FILE,
        )
        expected_io = v7._io_contract(authority)  # noqa: SLF001
        actual_encoder_io = runtime._inspect_onnx_contract(  # noqa: SLF001
            staging / v7.ENCODER_FILE
        )
        actual_ranker_io = runtime._inspect_onnx_contract(  # noqa: SLF001
            staging / v7.RANKER_FILE
        )
        if (
            actual_encoder_io != expected_io[v7.ENCODER_FILE]
            or actual_ranker_io != expected_io[v7.RANKER_FILE]
        ):
            raise MangaFontV8RuntimeExportError(
                "exported ONNX I/O drifted: "
                + json.dumps(
                    {
                        "actual": {
                            v7.ENCODER_FILE: actual_encoder_io,
                            v7.RANKER_FILE: actual_ranker_io,
                        },
                        "expected": expected_io,
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
        parity = _parity(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=staging / v7.ENCODER_FILE,
            ranker_path=staging / v7.RANKER_FILE,
            sample_count=parity_samples,
            seed=parity_seed,
        )
        report = adapter_trainer.seal_record(
            {
                "artifacts": {
                    name: {
                        "byte_size": (staging / name).stat().st_size,
                        "sha256": adapter_trainer.sha256_file(staging / name),
                    }
                    for name in (
                        v7.ACTIVE_CATALOG_FILE,
                        v7.ENCODER_FILE,
                        v7.PROTOTYPE_FILE,
                        v7.RANKER_FILE,
                    )
                },
                "authority": {
                    "automatic_mutation_allowed": False,
                    "quality_gate_authority": False,
                    "state": "qa_only_unattached_graph_bundle",
                },
                "candidate_ids": list(authority.candidate_ids),
                "family_score_contract": {
                    "body_and_variant_share_exact_scores": False,
                    "candidate_scores_compatibility_alias": "body_candidate_scores",
                    "role_logits": "pixel_query_role_family_adapter",
                },
                "inputs": {
                    "adapter_checkpoint_sha256": adapter_trainer.sha256_file(
                        adapter_dir.expanduser().resolve()
                        / adapter_trainer.CHECKPOINT_FILE
                    ),
                    "adapter_manifest_sha256": adapter_trainer.sha256_file(
                        adapter_dir.expanduser().resolve()
                        / adapter_trainer.MANIFEST_FILE
                    ),
                    "v7_checkpoint_sha256": adapter_trainer.sha256_file(
                        authority.source.checkpoint_path
                    ),
                },
                "parity": parity,
                "record_type": "manga_font_student_v8_role_family_onnx_graph_report",
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / REPORT_FILE).write_bytes(
            adapter_trainer.json_bytes(report, pretty=True)
        )
        marker = adapter_trainer.seal_record(
            {
                "artifacts": {
                    name: adapter_trainer.sha256_file(staging / name)
                    for name in OUTPUT_FILES - {MARKER_FILE}
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(
            adapter_trainer.json_bytes(marker, pretty=True)
        )
        if {path.name for path in staging.iterdir()} != OUTPUT_FILES:
            raise MangaFontV8RuntimeExportError("graph output inventory drifted")
        if target.exists():
            shutil.rmtree(target)
        os.replace(staging, target)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {
        "automatic_mutation_allowed": False,
        "body_variant_max_abs_delta": parity["body_variant_max_abs_delta"],
        "output_dir": str(target),
        "status": "qa_only_unattached_graph_bundle",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--student-output", type=Path, required=True)
    parser.add_argument("--active-catalog", dest="active_catalog_path", type=Path, required=True)
    parser.add_argument("--encoder-source-dir", type=Path, required=True)
    parser.add_argument("--v7-output-dir", type=Path, required=True)
    parser.add_argument("--adapter-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--allow-r3-fixture-source", action="store_true")
    parser.add_argument("--allow-failed-adapter-quality", action="store_true")
    parser.add_argument("--parity-samples", type=int, default=MIN_PARITY_SAMPLES)
    parser.add_argument("--parity-seed", type=int, default=20260811)
    parser.add_argument("--replace-owned-output", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build_graph_bundle(**vars(args))
    except (MangaFontV8RuntimeExportError, v7.MangaFontV7RuntimeExportError) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
