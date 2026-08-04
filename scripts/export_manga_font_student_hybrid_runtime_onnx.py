#!/usr/bin/env python3
"""Export the exact v3-body/v6-variant MangaFont runtime successor.

The two students do not share an interchangeable SigLIP2 tower: v3 consumes
the v2 fine-tuned pooler/projection while v6-r2 was trained against the pinned
base tower's patch tokens.  This exporter therefore keeps both branches in a
single ``encoder.onnx`` and emits one 1280-D row per view:

* [0:256]       exact legacy v3 embedding
* [256:1280]    exact v6 4 x 256 query embeddings

``ranker.onnx`` retains ``candidate_scores`` as a v3-compatible body alias and
adds explicit ``body_candidate_scores`` and ``variant_candidate_scores``.
The application chooses between the latter two only after combining the OCR
item role with the v3 pixel-role head.  No test/fresh/library-QA pixels or
labels are read by this exporter; parity uses deterministic synthetic arrays.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import analyze_manga_font_student_v6_hybrid as hybrid_analysis
    import build_font_matching_runtime_artifact as runtime
    import export_font_matching_runtime_onnx as legacy_export
    import export_manga_font_student_runtime_onnx as base_export
    import sweep_manga_font_student_v3_heads as v3_sweep
    import train_manga_font_student_v1 as trainer
    import train_manga_font_student_v3 as trainer_v3
    import train_manga_font_student_v6_fontquery as trainer_v6
    import train_manga_font_student_v6_fontquery_r2 as trainer_v6_r2
except ImportError:  # pragma: no cover - repository-root import
    from scripts import analyze_manga_font_student_v6_hybrid as hybrid_analysis
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import export_font_matching_runtime_onnx as legacy_export
    from scripts import export_manga_font_student_runtime_onnx as base_export
    from scripts import sweep_manga_font_student_v3_heads as v3_sweep
    from scripts import train_manga_font_student_v1 as trainer
    from scripts import train_manga_font_student_v3 as trainer_v3
    from scripts import train_manga_font_student_v6_fontquery as trainer_v6
    from scripts import train_manga_font_student_v6_fontquery_r2 as trainer_v6_r2


SCHEMA_VERSION = "font-matching-runtime-artifact-v2"
RECORD_TYPE = runtime.RECORD_TYPE
OWNER = "carrot-manga-translator/font-matching-runtime-artifact-v2"
MARKER_FILE = runtime.MARKER_FILE
CONTRACT_FILE = runtime.CONTRACT_FILE
ENCODER_FILE = runtime.ENCODER_FILE
RANKER_FILE = runtime.RANKER_FILE
PROTOTYPE_FILE = runtime.PROTOTYPE_FILE
ACTIVE_CATALOG_FILE = runtime.ACTIVE_CATALOG_FILE
OUTPUT_FILES = frozenset(
    {
        MARKER_FILE,
        CONTRACT_FILE,
        ENCODER_FILE,
        RANKER_FILE,
        PROTOTYPE_FILE,
        ACTIVE_CATALOG_FILE,
    }
)
OPSET_VERSION = legacy_export.OPSET_VERSION
MIN_PARITY_SAMPLES = 32
ENCODER_BATCH_SIZE = 2
RANKER_BATCH_SIZE = 16
LEGACY_FEATURE_DIM = trainer.PROJECTION_DIM
VARIANT_QUERY_COUNT = 4
VARIANT_QUERY_DIM = 256
VARIANT_FEATURE_DIM = VARIANT_QUERY_COUNT * VARIANT_QUERY_DIM
FEATURE_DIM = LEGACY_FEATURE_DIM + VARIANT_FEATURE_DIM
BODY_ROLES = ("dialogue", "narration", "thought")
VARIANT_ROLES = tuple(role for role in trainer.ROLE_VALUES if role not in BODY_ROLES)
RANKER_OUTPUT_NAMES = (
    "candidate_scores",
    "body_candidate_scores",
    "variant_candidate_scores",
    "none_logits",
    "role_logits",
    "style_logits",
    *(f"treatment_{field}_logits" for field in sorted(trainer.TREATMENT_VALUES)),
    "view_gate_weights",
)


class HybridRuntimeExportError(ValueError):
    """Raised when the hybrid runtime cannot be proven reproducible."""


@dataclass(frozen=True)
class HybridAuthority:
    base: base_export.StudentAuthority
    v3_cache_dir: Path
    v3_cache_contract: Mapping[str, Any]
    v3_head_path: Path
    v3_readiness_dir: Path
    v3_readiness_report: Mapping[str, Any]
    v6_dir: Path
    v6_report: Mapping[str, Any]
    v6_checkpoint_path: Path
    v6_prototype_path: Path
    v6_prototypes: np.ndarray
    diagnostic_dir: Path
    diagnostic_report: Mapping[str, Any]
    diagnostic_policy: Mapping[str, Any]
    packed_prototypes: np.ndarray


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HybridRuntimeExportError(f"{location}: expected an object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise HybridRuntimeExportError(f"{location}: expected a list")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HybridRuntimeExportError(f"{location}: expected non-empty text")
    return value.strip()


def _read_json(path: Path, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise HybridRuntimeExportError(f"{location}: missing or linked file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HybridRuntimeExportError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _exact_inventory(root: Path, expected: set[str], location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise HybridRuntimeExportError(f"{location}: missing or linked directory")
    entries = tuple(root.iterdir())
    if any(path.is_symlink() or not path.is_file() for path in entries):
        raise HybridRuntimeExportError(f"{location}: nested/linked entries forbidden")
    actual = {path.name for path in entries}
    if actual != expected:
        raise HybridRuntimeExportError(
            f"{location}: inventory drifted; expected={sorted(expected)} actual={sorted(actual)}"
        )


def _safe_output(path: Path) -> Path:
    try:
        return base_export._safe_output(path)  # noqa: SLF001
    except base_export.StudentRuntimeExportError as error:
        raise HybridRuntimeExportError(str(error)) from error


def _validate_readiness(root: Path, head_path: Path) -> Mapping[str, Any]:
    expected = {
        ".manga-font-student-v5-readiness-v1-owned.json",
        "continuation-plan.json",
        "reproduction-report.json",
        "strongest-head.safetensors",
    }
    _exact_inventory(root, expected, "v3 readiness")
    marker = _read_json(
        root / ".manga-font-student-v5-readiness-v1-owned.json", "v3 readiness marker"
    )
    report = _read_json(root / "reproduction-report.json", "v3 reproduction report")
    trainer.validate_record_seal(report, location="v3 reproduction report")
    if (
        marker.get("owner")
        != "carrot-manga-translator/manga-font-student-v5-readiness-v1"
        or marker.get("schema_version") != "manga-font-student-v5-readiness-v1"
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != "manga-font-student-v5-readiness-v1"
    ):
        raise HybridRuntimeExportError("v3 readiness metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v3 readiness artifacts")
    for name in expected - {".manga-font-student-v5-readiness-v1-owned.json"}:
        if artifacts.get(name) != runtime.sha256_file(root / name):
            raise HybridRuntimeExportError(f"v3 readiness hash drifted: {name}")
    exact = _mapping(report.get("exact_head"), "v3 readiness exact head")
    boundaries = _mapping(report.get("boundaries"), "v3 readiness boundaries")
    reproduction = _mapping(report.get("reproduction"), "v3 readiness reproduction")
    if (
        head_path.resolve() != (root / "strongest-head.safetensors").resolve()
        or exact.get("sha256") != runtime.sha256_file(head_path)
        or exact.get("source_checkpoint_sha256") != runtime.sha256_file(head_path)
        or boundaries.get("hidden_test_labels_deserialized") != 0
        or boundaries.get("hidden_test_pixels_opened") != 0
        or boundaries.get("fresh64_accessed") is not False
        or boundaries.get("library_40qa_accessed") is not False
        or reproduction.get("current_cache_top1_decisions_match") is not True
    ):
        raise HybridRuntimeExportError("v3 readiness/head binding drifted")
    return report


def _pack_prototypes(
    legacy_prototypes: np.ndarray, variant_prototypes: np.ndarray
) -> np.ndarray:
    legacy = np.asarray(legacy_prototypes, dtype=np.float32)
    variant = np.asarray(variant_prototypes, dtype=np.float32)
    if legacy.ndim != 2 or legacy.shape[1] != LEGACY_FEATURE_DIM:
        raise HybridRuntimeExportError("legacy prototype shape drifted")
    if variant.shape != (
        len(base_export.EXPECTED_CANDIDATE_IDS),
        VARIANT_QUERY_COUNT,
        VARIANT_QUERY_DIM,
    ):
        raise HybridRuntimeExportError("v6 candidate-query prototype shape drifted")
    if not np.isfinite(legacy).all() or not np.isfinite(variant).all():
        raise HybridRuntimeExportError("prototype bank contains non-finite values")
    variant_norms = np.linalg.norm(variant, axis=-1)
    if np.max(np.abs(variant_norms - 1.0)) > 1e-4:
        raise HybridRuntimeExportError("v6 candidate-query prototypes are not L2 normalized")
    packed = np.zeros((legacy.shape[0], FEATURE_DIM), dtype=np.float32)
    packed[:, :LEGACY_FEATURE_DIM] = legacy
    packed[: variant.shape[0], LEGACY_FEATURE_DIM:] = variant.reshape(
        variant.shape[0], VARIANT_FEATURE_DIM
    )
    return np.ascontiguousarray(packed, dtype="<f4")


def load_hybrid_authority(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    v3_cache_dir: Path,
    v3_readiness_dir: Path,
    v3_head_path: Path,
    v6_output_dir: Path,
    hybrid_diagnostic_dir: Path,
) -> HybridAuthority:
    try:
        base = base_export.load_student_authority(
            student_output=student_output,
            active_catalog_path=active_catalog_path,
            encoder_source_dir=encoder_source_dir,
        )
        v3_sweep.validate_cache(v3_cache_dir)
        trainer_v6_r2.validate_output(v6_output_dir)
        hybrid_analysis.validate_output(hybrid_diagnostic_dir)
    except (
        base_export.StudentRuntimeExportError,
        trainer.MangaFontStudentError,
        trainer_v6.MangaFontV6FontQueryError,
        hybrid_analysis.MangaFontV6HybridError,
    ) as error:
        raise HybridRuntimeExportError(str(error)) from error
    cache_root = v3_cache_dir.expanduser().resolve()
    readiness_root = v3_readiness_dir.expanduser().resolve()
    head_path = v3_head_path.expanduser().resolve()
    v6_root = v6_output_dir.expanduser().resolve()
    diagnostic_root = hybrid_diagnostic_dir.expanduser().resolve()
    readiness = _validate_readiness(readiness_root, head_path)
    cache = _read_json(cache_root / v3_sweep.CACHE_CONTRACT, "v3 cache contract")
    sources = _mapping(cache.get("sources"), "v3 cache sources")
    if (
        tuple(cache.get("candidate_ids", ())) != base.candidate_ids
        or sources.get("warm_start_checkpoint_sha256")
        != runtime.sha256_file(base.checkpoint_path)
        or sources.get("warm_start_contract_sha256")
        != runtime.sha256_file(base.student_root / trainer.CONTRACT_FILE)
        or _mapping(readiness.get("current_cache"), "current cache").get(
            "contract_sha256"
        )
        != runtime.sha256_file(cache_root / v3_sweep.CACHE_CONTRACT)
    ):
        raise HybridRuntimeExportError("v3 cache/base/readiness binding drifted")

    v6_report = _read_json(v6_root / trainer_v6_r2.REPORT, "v6 r2 report")
    if tuple(v6_report.get("candidate_ids", ())) != base.candidate_ids:
        raise HybridRuntimeExportError("v6/base candidate order drifted")
    v6_checkpoint = v6_root / trainer_v6_r2.CHECKPOINT
    v6_prototype_path = v6_root / trainer_v6_r2.PROTOTYPES
    prototype_descriptor = _mapping(
        _mapping(v6_report.get("files"), "v6 files").get("prototypes"),
        "v6 prototype descriptor",
    )
    if prototype_descriptor.get("shape") != [
        len(base.candidate_ids),
        VARIANT_QUERY_COUNT,
        VARIANT_QUERY_DIM,
    ]:
        raise HybridRuntimeExportError("v6 prototype descriptor drifted")
    variant_prototypes = np.frombuffer(
        v6_prototype_path.read_bytes(), dtype="<f4"
    ).reshape(len(base.candidate_ids), VARIANT_QUERY_COUNT, VARIANT_QUERY_DIM)

    diagnostic_report = _read_json(diagnostic_root / "report.json", "hybrid report")
    diagnostic_policy = _read_json(
        diagnostic_root / "hybrid-policy.json", "hybrid policy"
    )
    diagnostic_sources = _mapping(
        diagnostic_report.get("sources"), "hybrid diagnostic sources"
    )
    if (
        tuple(diagnostic_report.get("candidate_ids", ())) != base.candidate_ids
        or diagnostic_sources.get("v6_r2_report_sha256")
        != runtime.sha256_file(v6_root / trainer_v6_r2.REPORT)
        or _mapping(diagnostic_policy.get("role_route"), "hybrid role route").get(
            "source"
        )
        != "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)"
    ):
        raise HybridRuntimeExportError("hybrid diagnostic source/policy drifted")
    return HybridAuthority(
        base=base,
        v3_cache_dir=cache_root,
        v3_cache_contract=cache,
        v3_head_path=head_path,
        v3_readiness_dir=readiness_root,
        v3_readiness_report=readiness,
        v6_dir=v6_root,
        v6_report=v6_report,
        v6_checkpoint_path=v6_checkpoint,
        v6_prototype_path=v6_prototype_path,
        v6_prototypes=variant_prototypes,
        diagnostic_dir=diagnostic_root,
        diagnostic_report=diagnostic_report,
        diagnostic_policy=diagnostic_policy,
        packed_prototypes=_pack_prototypes(base.prototypes, variant_prototypes),
    )


def _load_models(authority: HybridAuthority) -> tuple[Any, Any, Any, Any]:
    legacy_export._ensure_offline_environment()  # noqa: SLF001
    try:
        import torch
        from safetensors.torch import load_file
        from transformers import SiglipVisionModel
    except (ImportError, OSError) as error:  # pragma: no cover
        raise HybridRuntimeExportError(
            "export requires torch, transformers, and safetensors"
        ) from error
    legacy_student, _processor = base_export._load_models(authority.base)  # noqa: SLF001
    try:
        variant_vision = SiglipVisionModel.from_pretrained(
            str(authority.base.encoder_source_dir),
            local_files_only=True,
            attn_implementation="eager",
        )
        variant_vision.config._attn_implementation = "eager"  # noqa: SLF001
        variant_head = trainer_v6.build_font_query_head(
            torch,
            query_count=VARIANT_QUERY_COUNT,
            query_dim=VARIANT_QUERY_DIM,
            hidden_size=int(variant_vision.config.hidden_size),
        )
        variant_head.load_state_dict(
            dict(load_file(str(authority.v6_checkpoint_path), device="cpu")),
            strict=True,
        )
        body_ranker = trainer_v3.build_runtime_ranker_v3(
            torch,
            candidate_count=len(authority.base.candidate_ids),
            dropout=0.10,
            residual_scale=1.0,
        )
        body_state = dict(load_file(str(authority.v3_head_path), device="cpu"))
        if any(not name.startswith("runtime_ranker.") for name in body_state):
            raise HybridRuntimeExportError("v3 head contains a foreign tensor")
        body_ranker.load_state_dict(
            {
                name.removeprefix("runtime_ranker."): value
                for name, value in body_state.items()
            },
            strict=True,
        )
    except HybridRuntimeExportError:
        raise
    except Exception as error:  # noqa: BLE001
        raise HybridRuntimeExportError(f"hybrid model reconstruction failed: {error}") from error
    for model in (legacy_student, variant_vision, variant_head, body_ranker):
        model.requires_grad_(False)
        model.eval()
        model.to("cpu", dtype=torch.float32)
    return legacy_student, variant_vision, variant_head, body_ranker


def _make_wrappers(
    *,
    authority: HybridAuthority,
    legacy_student: Any,
    variant_vision: Any,
    variant_head: Any,
    body_ranker: Any,
) -> tuple[Any, Any]:
    import torch

    class EncoderWrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.legacy_vision = legacy_student.vision_encoder
            self.legacy_projection = legacy_student.projection
            self.variant_vision = variant_vision
            self.variant_head = variant_head

        def forward(self, pixel_values: Any) -> Any:
            legacy_output = self.legacy_vision(
                pixel_values=pixel_values, return_dict=False
            )
            legacy = torch.nn.functional.normalize(
                self.legacy_projection(legacy_output[1]).float(), p=2, dim=-1
            )
            variant_output = self.variant_vision(
                pixel_values=pixel_values, return_dict=False
            )
            query_embeddings, _attention = self.variant_head.encode(variant_output[0])
            return torch.cat(
                [legacy, query_embeddings.flatten(start_dim=1)], dim=-1
            )

    bag_tensors = tuple(
        torch.arange(row["start"], row["start"] + row["count"], dtype=torch.long)
        for row in authority.base.candidate_bags
    )
    treatment_fields = tuple(sorted(trainer.TREATMENT_VALUES))

    class RankerWrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.body_ranker = body_ranker
            self.register_buffer(
                "variant_query_weight_logits",
                variant_head.query_weight_logits.detach().float().clone(),
            )
            self.register_buffer(
                "variant_logit_scale", variant_head.logit_scale.detach().float().clone()
            )
            for index, bag in enumerate(bag_tensors):
                self.register_buffer(f"candidate_bag_{index}", bag, persistent=False)

        def forward(self, views: Any, prototype_features: Any) -> tuple[Any, ...]:
            bags = tuple(
                getattr(self, f"candidate_bag_{index}")
                for index in range(len(bag_tensors))
            )
            body = self.body_ranker(
                views[:, :, :LEGACY_FEATURE_DIM],
                prototype_features[:, :LEGACY_FEATURE_DIM],
                bags,
            )
            variant_views = views[:, :, LEGACY_FEATURE_DIM:].reshape(
                views.shape[0], 3, VARIANT_QUERY_COUNT, VARIANT_QUERY_DIM
            )
            variant_sample = torch.nn.functional.normalize(
                variant_views.mean(dim=1), p=2, dim=-1
            )
            variant_prototypes = prototype_features[
                : len(authority.base.candidate_ids), LEGACY_FEATURE_DIM:
            ].reshape(
                len(authority.base.candidate_ids),
                VARIANT_QUERY_COUNT,
                VARIANT_QUERY_DIM,
            )
            per_query = torch.einsum(
                "bqd,cqd->bcq", variant_sample, variant_prototypes
            )
            query_weights = torch.softmax(self.variant_query_weight_logits, dim=0)
            variant_scores = self.variant_logit_scale.exp().clamp(max=100.0) * (
                per_query * query_weights[None, None, :]
            ).sum(dim=-1)
            treatments = body["treatment_logits"]
            body_scores = body["candidate_scores"]
            return (
                body_scores,
                body_scores,
                variant_scores,
                body["none_logits"],
                body["role_logits"],
                body["style_logits"],
                *(treatments[field] for field in treatment_fields),
                body["view_gate_weights"],
            )

    return EncoderWrapper().eval(), RankerWrapper().eval()


def _io_contract(authority: HybridAuthority) -> dict[str, Any]:
    candidate_count = len(authority.base.candidate_ids)
    prototype_count = int(authority.packed_prototypes.shape[0])
    outputs = [
        {"name": "candidate_scores", "shape": [None, candidate_count], "type": "tensor(float)"},
        {"name": "body_candidate_scores", "shape": [None, candidate_count], "type": "tensor(float)"},
        {"name": "variant_candidate_scores", "shape": [None, candidate_count], "type": "tensor(float)"},
        {"name": "none_logits", "shape": [None], "type": "tensor(float)"},
        {"name": "role_logits", "shape": [None, len(trainer.ROLE_VALUES)], "type": "tensor(float)"},
        {"name": "style_logits", "shape": [None, len(trainer.STYLE_FIELDS)], "type": "tensor(float)"},
    ]
    outputs.extend(
        {
            "name": f"treatment_{field}_logits",
            "shape": [None, len(trainer.TREATMENT_VALUES[field])],
            "type": "tensor(float)",
        }
        for field in sorted(trainer.TREATMENT_VALUES)
    )
    outputs.append(
        {"name": "view_gate_weights", "shape": [None, 3], "type": "tensor(float)"}
    )
    return {
        ENCODER_FILE: {
            "inputs": [
                {"name": "pixel_values", "shape": [None, 3, 224, 224], "type": "tensor(float)"}
            ],
            "outputs": [
                {"name": "image_features", "shape": [None, FEATURE_DIM], "type": "tensor(float)"}
            ],
        },
        RANKER_FILE: {
            "inputs": [
                {"name": "views", "shape": [None, 3, FEATURE_DIM], "type": "tensor(float)"},
                {
                    "name": "prototype_features",
                    "shape": [prototype_count, FEATURE_DIM],
                    "type": "tensor(float)",
                },
            ],
            "outputs": outputs,
        },
    }


def _export_graphs(
    *, encoder_wrapper: Any, ranker_wrapper: Any, authority: HybridAuthority,
    encoder_path: Path, ranker_path: Path
) -> None:
    legacy_export._require_onnx_export_dependency()  # noqa: SLF001
    import torch

    prototypes = torch.from_numpy(np.array(authority.packed_prototypes, copy=True))
    dynamic_ranker = {"views": {0: "batch"}}
    dynamic_ranker.update({name: {0: "batch"} for name in RANKER_OUTPUT_NAMES})
    try:
        with torch.inference_mode():
            torch.onnx.export(
                encoder_wrapper,
                (torch.zeros((1, 3, 224, 224), dtype=torch.float32),),
                str(encoder_path),
                input_names=["pixel_values"], output_names=["image_features"],
                dynamic_axes={"pixel_values": {0: "batch"}, "image_features": {0: "batch"}},
                opset_version=OPSET_VERSION, dynamo=False, external_data=False,
                export_params=True, do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
            torch.onnx.export(
                ranker_wrapper,
                (torch.zeros((2, 3, FEATURE_DIM), dtype=torch.float32), prototypes),
                str(ranker_path),
                input_names=["views", "prototype_features"],
                output_names=list(RANKER_OUTPUT_NAMES), dynamic_axes=dynamic_ranker,
                opset_version=OPSET_VERSION, dynamo=False, external_data=False,
                export_params=True, do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
    except Exception as error:  # noqa: BLE001
        raise HybridRuntimeExportError(f"PyTorch ONNX export failed: {error}") from error


def _parity_metrics(
    *, reference_encoder: np.ndarray, actual_encoder: np.ndarray,
    reference_ranker: Mapping[str, np.ndarray], actual_ranker: Mapping[str, np.ndarray]
) -> dict[str, Any]:
    try:
        metrics = base_export._parity_metrics(  # noqa: SLF001
            reference_encoder=reference_encoder,
            actual_encoder=actual_encoder,
            reference_ranker=reference_ranker,
            actual_ranker=actual_ranker,
        )
    except base_export.StudentRuntimeExportError as error:
        raise HybridRuntimeExportError(str(error)) from error
    alias_error = float(
        np.max(np.abs(actual_ranker["candidate_scores"] - actual_ranker["body_candidate_scores"]))
    )
    variant_agreement = float(
        np.mean(
            np.argmax(reference_ranker["variant_candidate_scores"], axis=1)
            == np.argmax(actual_ranker["variant_candidate_scores"], axis=1)
        )
    )
    if alias_error != 0.0 or variant_agreement != 1.0:
        raise HybridRuntimeExportError("hybrid alias/variant decision parity failed")
    return {**metrics, "body_alias_max_abs_error": alias_error,
            "variant_top1_agreement": variant_agreement}


def _run_parity(
    *, encoder_wrapper: Any, ranker_wrapper: Any, authority: HybridAuthority,
    encoder_path: Path, ranker_path: Path, electron_path: Path,
    sample_count: int, seed: int, wasm_timeout_seconds: int
) -> Mapping[str, Any]:
    if sample_count < MIN_PARITY_SAMPLES:
        raise HybridRuntimeExportError(
            f"parity requires at least {MIN_PARITY_SAMPLES} synthetic rows"
        )
    encoder_inputs = legacy_export._synthetic_encoder_inputs(sample_count, seed)  # noqa: SLF001
    rng = np.random.default_rng(seed ^ 0x6A22)
    ranker_views = rng.standard_normal((sample_count, 3, FEATURE_DIM), dtype=np.float32)
    legacy = ranker_views[:, :, :LEGACY_FEATURE_DIM]
    legacy /= np.maximum(np.linalg.norm(legacy, axis=-1, keepdims=True), np.float32(1e-12))
    queries = ranker_views[:, :, LEGACY_FEATURE_DIM:].reshape(
        sample_count, 3, VARIANT_QUERY_COUNT, VARIANT_QUERY_DIM
    )
    queries /= np.maximum(np.linalg.norm(queries, axis=-1, keepdims=True), np.float32(1e-12))
    ranker_views = np.ascontiguousarray(ranker_views)
    reference_encoder, reference_ranker = legacy_export._run_reference_models(  # noqa: SLF001
        encoder_wrapper=encoder_wrapper, ranker_wrapper=ranker_wrapper,
        encoder_inputs=encoder_inputs, ranker_views=ranker_views,
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=ENCODER_BATCH_SIZE, ranker_batch_size=RANKER_BATCH_SIZE,
        output_names=RANKER_OUTPUT_NAMES,
    )
    cpu_encoder, cpu_ranker, cpu_evidence = legacy_export._run_cpu_ort(  # noqa: SLF001
        encoder_path=encoder_path, ranker_path=ranker_path,
        encoder_inputs=encoder_inputs, ranker_views=ranker_views,
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=ENCODER_BATCH_SIZE, ranker_batch_size=RANKER_BATCH_SIZE,
        output_names=RANKER_OUTPUT_NAMES,
    )
    wasm_encoder, wasm_ranker, wasm_evidence = legacy_export._run_electron_wasm(  # noqa: SLF001
        encoder_path=encoder_path, ranker_path=ranker_path,
        encoder_inputs=encoder_inputs, ranker_views=ranker_views,
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=ENCODER_BATCH_SIZE, ranker_batch_size=RANKER_BATCH_SIZE,
        output_names=RANKER_OUTPUT_NAMES,
        electron_path=electron_path, timeout_seconds=wasm_timeout_seconds,
    )
    return {
        "cpu": {"evidence": dict(cpu_evidence), "metrics": _parity_metrics(
            reference_encoder=reference_encoder, actual_encoder=cpu_encoder,
            reference_ranker=reference_ranker, actual_ranker=cpu_ranker)},
        "wasm": {"evidence": dict(wasm_evidence), "metrics": _parity_metrics(
            reference_encoder=reference_encoder, actual_encoder=wasm_encoder,
            reference_ranker=reference_ranker, actual_ranker=wasm_ranker)},
        "opset": OPSET_VERSION, "sample_count": sample_count,
        "sample_source": "deterministic_synthetic_only",
        "seed": seed, "test_or_fresh_or_library_qa_rows_used": 0,
    }


def _routing_contract() -> dict[str, Any]:
    return {
        "schema_version": "font-matching-hybrid-score-routing-v1",
        "candidate_scores_compatibility_alias": "body_candidate_scores",
        "body_candidate_output": "body_candidate_scores",
        "variant_candidate_output": "variant_candidate_scores",
        "body_roles": list(BODY_ROLES),
        "variant_roles": list(VARIANT_ROLES),
        "unknown_role_fallback": "variant_candidate_scores",
        "role_source": "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
        "selection_feature_source": "selected_candidate_scores_with_legacy256_visual_features",
        "selection_feature_dim": LEGACY_FEATURE_DIM,
        "row_specific_rules": False,
    }


def _validate_parity_record(value: Any) -> None:
    parity = _mapping(value, "hybrid export parity")
    if (
        parity.get("opset") != OPSET_VERSION
        or not isinstance(parity.get("sample_count"), int)
        or int(parity["sample_count"]) < MIN_PARITY_SAMPLES
        or parity.get("sample_source") != "deterministic_synthetic_only"
        or parity.get("test_or_fresh_or_library_qa_rows_used") != 0
    ):
        raise HybridRuntimeExportError("hybrid parity boundary drifted")
    for target in ("cpu", "wasm"):
        row = _mapping(parity.get(target), f"hybrid parity {target}")
        evidence = _mapping(row.get("evidence"), f"hybrid parity {target} evidence")
        metrics = _mapping(row.get("metrics"), f"hybrid parity {target} metrics")
        if (
            metrics.get("candidate_top1_agreement") != 1.0
            or metrics.get("variant_top1_agreement") != 1.0
            or metrics.get("none_decision_agreement") != 1.0
            or metrics.get("role_top1_agreement") != 1.0
            or metrics.get("body_alias_max_abs_error") != 0.0
            or not isinstance(metrics.get("encoder_max_abs_error"), (int, float))
            or float(metrics["encoder_max_abs_error"]) > 2e-4
            or not isinstance(metrics.get("ranker_max_abs_error"), (int, float))
            or float(metrics["ranker_max_abs_error"]) > 2e-4
            or not isinstance(
                metrics.get("encoder_minimum_cosine_similarity"), (int, float)
            )
            or float(metrics["encoder_minimum_cosine_similarity"]) < 0.999
        ):
            raise HybridRuntimeExportError(f"hybrid {target} parity gate drifted")
        if target == "cpu":
            if evidence.get("execution_provider") != "CPUExecutionProvider":
                raise HybridRuntimeExportError("hybrid CPU parity provider drifted")
        elif (
            evidence.get("package") != runtime.TARGET_ORT_PACKAGE
            or evidence.get("version") != runtime.TARGET_ORT_VERSION
            or evidence.get("host") != "electron-main"
            or evidence.get("all_outputs_finite") is not True
        ):
            raise HybridRuntimeExportError("hybrid WASM parity runtime drifted")


def _expected_test_boundary() -> dict[str, Any]:
    return {
        "aggregate_metrics_only": True,
        "frozen_test_pixels_opened_by_exporter": 0,
        "row_level_predictions_packaged": False,
        "sample_identifiers_packaged": False,
        "training_or_validation_pixels_packaged": False,
        "fresh64_rows_accessed": 0,
        "library_qa_rows_accessed": 0,
    }


def _runtime_batching_contract() -> dict[str, Any]:
    return {
        "encoder_batch_size": ENCODER_BATCH_SIZE,
        "ranker_batch_size": RANKER_BATCH_SIZE,
        "parity_qualified": True,
    }


def _build_contract(
    authority: HybridAuthority, staging: Path, parity: Mapping[str, Any]
) -> dict[str, Any]:
    base = authority.base
    artifacts = {
        name: runtime._artifact_descriptor(staging / name, file_name=name)  # noqa: SLF001
        for name in (ACTIVE_CATALOG_FILE, ENCODER_FILE, RANKER_FILE, PROTOTYPE_FILE)
    }
    active_sources = _mapping(base.active_catalog.get("source_records"), "active sources")
    inputs = _mapping(base.contract.get("inputs"), "base inputs")
    candidate_order_sha = runtime._ordered_values_sha256(base.candidate_ids)  # noqa: SLF001
    diagnostic_metrics = _mapping(
        authority.diagnostic_report.get("predicted_role_route"), "predicted route"
    )
    frozen_manifest = _text(inputs.get("human_export_manifest_sha256"), "human manifest")
    return runtime.seal_record(
        {
            "artifacts": artifacts,
            "calibration": {
                "calibration_split": "val", "none_threshold": 0.5,
                "none_threshold_selection_metric": "neutral_base_before_supervised_attachment",
                "temperature": 1.0,
                "temperature_selection_metric": "neutral_base_before_supervised_attachment",
            },
            "catalog": {
                "active_catalog_record_sha256": base.active_catalog["record_sha256"],
                "candidate_count": len(base.candidate_ids),
                "candidate_ids": list(base.candidate_ids),
                "candidate_order_sha256": candidate_order_sha,
                "candidate_parameterization": "prototype-bag-only-no-id-embedding-or-bias",
                "catalog_disposition_record_sha256": active_sources["catalog_disposition_record_sha256"],
                "catalog_registry_sha256": inputs["catalog_registry_sha256"],
                "catalog_version": base.active_catalog["catalog_version"],
                "final_catalog_record_sha256": active_sources["final_catalog_record_sha256"],
                "font_catalog_sha256": active_sources["deployment_font_face_manifest_sha256"],
                "font_prototypes_sha256": runtime.sha256_file(staging / PROTOTYPE_FILE),
                "prototype_bags": [dict(row) for row in base.candidate_bags],
                "prototype_count": int(authority.packed_prototypes.shape[0]),
                "render_bank_manifest_sha256": active_sources["deployment_render_bank_manifest_sha256"],
                "variant_prototype_layout": {
                    "candidate_count": len(base.candidate_ids),
                    "candidate_rows": [0, len(base.candidate_ids)],
                    "feature_offset": LEGACY_FEATURE_DIM,
                    "query_count": VARIANT_QUERY_COUNT,
                    "query_dim": VARIANT_QUERY_DIM,
                },
            },
            "deployment": {
                "automatic_mutation_allowed": True, "fail_closed": True,
                "fallback_policy": copy.deepcopy(base_export.FALLBACK_POLICY),
                "state": "ready",
            },
            "encoder": {
                "class": "DualSiglipVisionModel",
                "fully_frozen": True,
                "model_id": trainer.MODEL_ID,
                "onnx_sha256": artifacts[ENCODER_FILE]["sha256"],
                "revision": trainer.MODEL_REVISION,
                "source_weights_sha256": runtime.sha256_file(base.encoder_source_weights),
                "version": "dual-siglip-vision-body-pooler-variant-patch-query-onnx-v1",
                "branches": {
                    "body": "v2_finetuned_pooler_projection256",
                    "variant": "pinned_base_patch_tokens_four_query_embeddings1024",
                    "shared_weights_assumed": False,
                },
            },
            "head": {
                "architecture": {
                    "candidate_count": len(base.candidate_ids),
                    "feature_dim": FEATURE_DIM,
                    "legacy_feature_dim": LEGACY_FEATURE_DIM,
                    "variant_feature_dim": VARIANT_FEATURE_DIM,
                    "variant_query_count": VARIANT_QUERY_COUNT,
                    "variant_query_dim": VARIANT_QUERY_DIM,
                },
                "body_checkpoint_sha256": runtime.sha256_file(authority.v3_head_path),
                "variant_checkpoint_sha256": runtime.sha256_file(authority.v6_checkpoint_path),
                "onnx_sha256": artifacts[RANKER_FILE]["sha256"],
                "version": "manga-font-v3-v6-dual-score-ranker-onnx-v1",
            },
            "hybrid_score_routing": _routing_contract(),
            "model_version": (
                f"manga-font-hybrid-runtime-v2-{runtime.sha256_file(authority.v3_head_path)[:10]}-"
                f"{runtime.sha256_file(authority.v6_checkpoint_path)[:10]}-{candidate_order_sha[:10]}"
            ),
            "onnx_io_contract": _io_contract(authority),
            "policy": base_export._runtime_policy(),  # noqa: SLF001
            "preprocessing": {
                "input_mode": "RGB", "input_size_px": [224, 224],
                "processor": {"class": "AutoImageProcessor", "do_resize": False, "use_fast": False},
                "prototype_to_encoder_input": {
                    "algorithm": "fontclip-letterbox-rgb-v1", "canvas_color_rgb": [255, 255, 255],
                    "convert_mode": "RGB", "operation": "aspect_preserving_letterbox",
                    "placement": "center_floor", "resize_filter": "lanczos",
                    "rounding": "python_round_then_minimum_1px", "target_size_px": [224, 224],
                },
                "sample_views": "verified-rgb-224-passthrough-v1",
            },
            "provenance": {
                "export_validation": copy.deepcopy(dict(parity)),
                "exporter_sha256": runtime.sha256_file(Path(__file__).resolve()),
                "frozen_test_manifest_sha256": frozen_manifest,
                "base_model_contract_sha256": runtime.sha256_file(base.student_root / trainer.CONTRACT_FILE),
                "base_checkpoint_sha256": runtime.sha256_file(base.checkpoint_path),
                "v3_cache_contract_sha256": runtime.sha256_file(authority.v3_cache_dir / v3_sweep.CACHE_CONTRACT),
                "v3_readiness_report_sha256": runtime.sha256_file(authority.v3_readiness_dir / "reproduction-report.json"),
                "v6_report_sha256": runtime.sha256_file(authority.v6_dir / trainer_v6_r2.REPORT),
                "hybrid_diagnostic_report_sha256": runtime.sha256_file(authority.diagnostic_dir / "report.json"),
            },
            "record_type": RECORD_TYPE,
            "release_evaluation": {
                "evaluated_row_count": 33,
                "evaluation_report_sha256": runtime.sha256_file(authority.diagnostic_dir / "report.json"),
                "metrics": copy.deepcopy(_mapping(diagnostic_metrics.get("metrics"), "predicted metrics")),
                "test_manifest_sha256": frozen_manifest,
                "thresholds": {},
                "status": "research_candidate_requires_hybrid_selection_calibration_and_library_qa",
            },
            "runtime": {
                "execution_provider": runtime.TARGET_ORT_PROVIDER,
                "package": runtime.TARGET_ORT_PACKAGE,
                "version": runtime.TARGET_ORT_VERSION,
            },
            "runtime_batching": _runtime_batching_contract(),
            "schema_version": SCHEMA_VERSION,
            "test_data_boundary": _expected_test_boundary(),
        }
    )


def _validate_marker(root: Path) -> Mapping[str, Any]:
    marker = _read_json(root / MARKER_FILE, "hybrid runtime marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise HybridRuntimeExportError("hybrid runtime marker is invalid")
    artifacts = _mapping(marker.get("artifacts"), "hybrid marker artifacts")
    if set(artifacts) != set(OUTPUT_FILES - {MARKER_FILE}):
        raise HybridRuntimeExportError("hybrid marker inventory drifted")
    for name in OUTPUT_FILES - {MARKER_FILE}:
        if artifacts.get(name) != runtime.sha256_file(root / name):
            raise HybridRuntimeExportError(f"hybrid runtime hash drifted: {name}")
    return marker


def validate_runtime_output(
    *, student_output: Path, active_catalog_path: Path, encoder_source_dir: Path,
    v3_cache_dir: Path, v3_readiness_dir: Path, v3_head_path: Path,
    v6_output_dir: Path, hybrid_diagnostic_dir: Path, output_dir: Path,
    inspect_onnx: bool = True,
) -> Mapping[str, Any]:
    authority = load_hybrid_authority(
        student_output=student_output, active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir, v3_cache_dir=v3_cache_dir,
        v3_readiness_dir=v3_readiness_dir, v3_head_path=v3_head_path,
        v6_output_dir=v6_output_dir, hybrid_diagnostic_dir=hybrid_diagnostic_dir,
    )
    root = _safe_output(output_dir)
    _exact_inventory(root, set(OUTPUT_FILES), "hybrid runtime output")
    _validate_marker(root)
    if (root / PROTOTYPE_FILE).read_bytes() != authority.packed_prototypes.tobytes():
        raise HybridRuntimeExportError("published hybrid prototype bank drifted")
    contract = _read_json(root / CONTRACT_FILE, "hybrid runtime contract")
    runtime.validate_record_seal(contract, location="hybrid runtime contract")
    routing = _mapping(contract.get("hybrid_score_routing"), "hybrid routing")
    provenance = _mapping(contract.get("provenance"), "hybrid provenance")
    boundary = _mapping(contract.get("test_data_boundary"), "hybrid boundary")
    deployment = _mapping(contract.get("deployment"), "hybrid deployment")
    fallback = _mapping(deployment.get("fallback_policy"), "hybrid fallback")
    catalog = _mapping(contract.get("catalog"), "hybrid catalog")
    encoder = _mapping(contract.get("encoder"), "hybrid encoder")
    branches = _mapping(encoder.get("branches"), "hybrid encoder branches")
    head = _mapping(contract.get("head"), "hybrid head")
    architecture = _mapping(head.get("architecture"), "hybrid architecture")
    runtime_row = _mapping(contract.get("runtime"), "hybrid runtime")
    runtime_batching = _mapping(
        contract.get("runtime_batching"), "hybrid runtime batching"
    )
    release = _mapping(contract.get("release_evaluation"), "hybrid release")
    active_sources = _mapping(
        authority.base.active_catalog.get("source_records"), "active catalog sources"
    )
    expected_bags = [dict(row) for row in authority.base.candidate_bags]
    expected_variant_layout = {
        "candidate_count": len(authority.base.candidate_ids),
        "candidate_rows": [0, len(authority.base.candidate_ids)],
        "feature_offset": LEGACY_FEATURE_DIM,
        "query_count": VARIANT_QUERY_COUNT,
        "query_dim": VARIANT_QUERY_DIM,
    }
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type") != RECORD_TYPE
        or routing != _routing_contract()
        or deployment.get("state") != "ready"
        or deployment.get("automatic_mutation_allowed") is not True
        or deployment.get("fail_closed") is not True
        or dict(fallback) != base_export.FALLBACK_POLICY
        or tuple(catalog.get("candidate_ids", ())) != authority.base.candidate_ids
        or catalog.get("candidate_count") != len(authority.base.candidate_ids)
        or catalog.get("candidate_order_sha256")
        != runtime._ordered_values_sha256(authority.base.candidate_ids)  # noqa: SLF001
        or catalog.get("candidate_parameterization")
        != "prototype-bag-only-no-id-embedding-or-bias"
        or catalog.get("prototype_count") != int(authority.packed_prototypes.shape[0])
        or catalog.get("prototype_bags") != expected_bags
        or catalog.get("variant_prototype_layout") != expected_variant_layout
        or catalog.get("font_prototypes_sha256")
        != runtime.sha256_file(root / PROTOTYPE_FILE)
        or catalog.get("active_catalog_record_sha256")
        != authority.base.active_catalog["record_sha256"]
        or catalog.get("catalog_disposition_record_sha256")
        != active_sources["catalog_disposition_record_sha256"]
        or catalog.get("final_catalog_record_sha256")
        != active_sources["final_catalog_record_sha256"]
        or catalog.get("font_catalog_sha256")
        != active_sources["deployment_font_face_manifest_sha256"]
        or catalog.get("render_bank_manifest_sha256")
        != active_sources["deployment_render_bank_manifest_sha256"]
        or encoder.get("class") != "DualSiglipVisionModel"
        or encoder.get("fully_frozen") is not True
        or encoder.get("model_id") != trainer.MODEL_ID
        or encoder.get("revision") != trainer.MODEL_REVISION
        or encoder.get("source_weights_sha256")
        != runtime.sha256_file(authority.base.encoder_source_weights)
        or dict(branches)
        != {
            "body": "v2_finetuned_pooler_projection256",
            "variant": "pinned_base_patch_tokens_four_query_embeddings1024",
            "shared_weights_assumed": False,
        }
        or dict(architecture)
        != {
            "candidate_count": len(authority.base.candidate_ids),
            "feature_dim": FEATURE_DIM,
            "legacy_feature_dim": LEGACY_FEATURE_DIM,
            "variant_feature_dim": VARIANT_FEATURE_DIM,
            "variant_query_count": VARIANT_QUERY_COUNT,
            "variant_query_dim": VARIANT_QUERY_DIM,
        }
        or head.get("body_checkpoint_sha256")
        != runtime.sha256_file(authority.v3_head_path)
        or head.get("variant_checkpoint_sha256")
        != runtime.sha256_file(authority.v6_checkpoint_path)
        or runtime_row.get("package") != runtime.TARGET_ORT_PACKAGE
        or runtime_row.get("version") != runtime.TARGET_ORT_VERSION
        or runtime_row.get("execution_provider") != runtime.TARGET_ORT_PROVIDER
        or dict(runtime_batching) != _runtime_batching_contract()
        or dict(boundary) != _expected_test_boundary()
        or provenance.get("exporter_sha256")
        != runtime.sha256_file(Path(__file__).resolve())
        or provenance.get("base_checkpoint_sha256") != runtime.sha256_file(authority.base.checkpoint_path)
        or provenance.get("v3_readiness_report_sha256")
        != runtime.sha256_file(authority.v3_readiness_dir / "reproduction-report.json")
        or provenance.get("v6_report_sha256")
        != runtime.sha256_file(authority.v6_dir / trainer_v6_r2.REPORT)
        or release.get("test_manifest_sha256")
        != provenance.get("frozen_test_manifest_sha256")
        or release.get("status")
        != "research_candidate_requires_hybrid_selection_calibration_and_library_qa"
        or contract.get("onnx_io_contract") != _io_contract(authority)
    ):
        raise HybridRuntimeExportError("hybrid contract/source boundary drifted")
    _validate_parity_record(provenance.get("export_validation"))
    active = runtime.load_active_catalog(root / ACTIVE_CATALOG_FILE, location="runtime active catalog")
    if (
        tuple(active["candidate_ids"]) != authority.base.candidate_ids
        or (root / ACTIVE_CATALOG_FILE).read_bytes()
        != authority.base.active_catalog_path.read_bytes()
    ):
        raise HybridRuntimeExportError("hybrid runtime catalog order drifted")
    artifacts = _mapping(contract.get("artifacts"), "hybrid contract artifacts")
    for name in (ACTIVE_CATALOG_FILE, ENCODER_FILE, RANKER_FILE, PROTOTYPE_FILE):
        if artifacts.get(name) != runtime._artifact_descriptor(root / name, file_name=name):  # noqa: SLF001
            raise HybridRuntimeExportError(f"hybrid artifact descriptor drifted: {name}")
    if inspect_onnx:
        expected_io = _io_contract(authority)
        legacy_export._inspect_graph_file(  # noqa: SLF001
            root / ENCODER_FILE, expected_opset=OPSET_VERSION
        )
        legacy_export._inspect_graph_file(  # noqa: SLF001
            root / RANKER_FILE, expected_opset=OPSET_VERSION
        )
        if runtime._inspect_onnx_contract(root / ENCODER_FILE) != expected_io[ENCODER_FILE]:  # noqa: SLF001
            raise HybridRuntimeExportError("hybrid encoder ONNX I/O drifted")
        if runtime._inspect_onnx_contract(root / RANKER_FILE) != expected_io[RANKER_FILE]:  # noqa: SLF001
            raise HybridRuntimeExportError("hybrid ranker ONNX I/O drifted")
    return {
        "automatic_mutation_allowed_without_calibration": False,
        "candidate_count": len(authority.base.candidate_ids),
        "contract_sha256": runtime.sha256_file(root / CONTRACT_FILE),
        "feature_dim": FEATURE_DIM,
        "model_version": contract["model_version"],
        "output_dir": str(root),
        "selection_calibration_required": True,
        "status": "sealed_hybrid_base_runtime_ready_for_exact_hybrid_calibration",
    }


def _commit(staging: Path, target: Path, validate: Any, replace: bool) -> Mapping[str, Any]:
    if not target.exists():
        os.replace(staging, target)
        try:
            return validate(target)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            raise
    if not replace:
        raise HybridRuntimeExportError("runtime output exists; pass --replace-owned-output")
    _validate_marker(target)
    backup = target.with_name(f".{target.name}.backup-{uuid.uuid4().hex}")
    os.replace(target, backup)
    try:
        os.replace(staging, target)
        result = validate(target)
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        os.replace(backup, target)
        raise
    shutil.rmtree(backup)
    return result


def build_runtime_output(
    *, student_output: Path, active_catalog_path: Path, encoder_source_dir: Path,
    v3_cache_dir: Path, v3_readiness_dir: Path, v3_head_path: Path,
    v6_output_dir: Path, hybrid_diagnostic_dir: Path, output_dir: Path,
    electron_path: Path, parity_samples: int = MIN_PARITY_SAMPLES,
    parity_seed: int = 20260803, wasm_timeout_seconds: int = 7200,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    if parity_samples < MIN_PARITY_SAMPLES:
        raise HybridRuntimeExportError(f"parity_samples must be >= {MIN_PARITY_SAMPLES}")
    authority = load_hybrid_authority(
        student_output=student_output, active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir, v3_cache_dir=v3_cache_dir,
        v3_readiness_dir=v3_readiness_dir, v3_head_path=v3_head_path,
        v6_output_dir=v6_output_dir, hybrid_diagnostic_dir=hybrid_diagnostic_dir,
    )
    target = _safe_output(output_dir)
    immutable = (
        authority.base.student_root, authority.base.active_catalog_path,
        authority.base.encoder_source_dir, authority.v3_cache_dir,
        authority.v3_readiness_dir, authority.v6_dir, authority.diagnostic_dir,
    )
    if any(base_export._paths_overlap(target, source) for source in immutable):  # noqa: SLF001
        raise HybridRuntimeExportError("runtime output overlaps an immutable source")
    if target.exists() and not replace_owned_output:
        raise HybridRuntimeExportError("runtime output exists; pass --replace-owned-output")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    try:
        shutil.copyfile(authority.base.active_catalog_path, staging / ACTIVE_CATALOG_FILE)
        (staging / PROTOTYPE_FILE).write_bytes(authority.packed_prototypes.tobytes())
        legacy_student, variant_vision, variant_head, body_ranker = _load_models(authority)
        encoder_wrapper, ranker_wrapper = _make_wrappers(
            authority=authority, legacy_student=legacy_student,
            variant_vision=variant_vision, variant_head=variant_head,
            body_ranker=body_ranker,
        )
        _export_graphs(
            encoder_wrapper=encoder_wrapper, ranker_wrapper=ranker_wrapper,
            authority=authority, encoder_path=staging / ENCODER_FILE,
            ranker_path=staging / RANKER_FILE,
        )
        legacy_export._inspect_graph_file(staging / ENCODER_FILE, expected_opset=OPSET_VERSION)  # noqa: SLF001
        legacy_export._inspect_graph_file(staging / RANKER_FILE, expected_opset=OPSET_VERSION)  # noqa: SLF001
        expected_io = _io_contract(authority)
        actual_encoder_io = runtime._inspect_onnx_contract(staging / ENCODER_FILE)  # noqa: SLF001
        actual_ranker_io = runtime._inspect_onnx_contract(staging / RANKER_FILE)  # noqa: SLF001
        if (
            actual_encoder_io != expected_io[ENCODER_FILE]
            or actual_ranker_io != expected_io[RANKER_FILE]
        ):
            raise HybridRuntimeExportError(
                "exported hybrid ONNX I/O drifted: "
                f"encoder={actual_encoder_io!r} ranker={actual_ranker_io!r}"
            )
        parity = _run_parity(
            encoder_wrapper=encoder_wrapper, ranker_wrapper=ranker_wrapper,
            authority=authority, encoder_path=staging / ENCODER_FILE,
            ranker_path=staging / RANKER_FILE,
            electron_path=electron_path.expanduser().resolve(),
            sample_count=parity_samples, seed=parity_seed,
            wasm_timeout_seconds=wasm_timeout_seconds,
        )
        contract = _build_contract(authority, staging, parity)
        (staging / CONTRACT_FILE).write_bytes(runtime.json_bytes(contract, pretty=True))
        marker = {
            "artifacts": {
                name: runtime.sha256_file(staging / name)
                for name in sorted(OUTPUT_FILES - {MARKER_FILE})
            },
            "owner": OWNER, "safe_replace": True, "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(runtime.json_bytes(marker, pretty=True))
        validate = lambda root: validate_runtime_output(  # noqa: E731
            student_output=student_output, active_catalog_path=active_catalog_path,
            encoder_source_dir=encoder_source_dir, v3_cache_dir=v3_cache_dir,
            v3_readiness_dir=v3_readiness_dir, v3_head_path=v3_head_path,
            v6_output_dir=v6_output_dir, hybrid_diagnostic_dir=hybrid_diagnostic_dir,
            output_dir=root,
        )
        validate(staging)
        return _commit(staging, target, validate, replace_owned_output)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def preflight(**kwargs: Any) -> Mapping[str, Any]:
    electron_path = kwargs.pop("electron_path").expanduser().resolve()
    authority = load_hybrid_authority(**kwargs)
    legacy_export._require_onnx_export_dependency()  # noqa: SLF001
    try:
        import onnxruntime as ort
        import torch
        import transformers
    except ImportError as error:  # pragma: no cover
        raise HybridRuntimeExportError(f"export dependency missing: {error}") from error
    if electron_path.is_symlink() or not electron_path.is_file():
        raise HybridRuntimeExportError("pinned Electron executable is unavailable")
    for label, path in {
        "WASM helper": legacy_export.WASM_HELPER,
        **legacy_export._runtime_asset_paths(),  # noqa: SLF001
    }.items():
        if path.is_symlink() or not path.is_file():
            raise HybridRuntimeExportError(f"{label} is unavailable: {path}")
    return {
        "body_checkpoint_sha256": runtime.sha256_file(authority.v3_head_path),
        "candidate_count": len(authority.base.candidate_ids),
        "electron_version": legacy_export._pinned_electron_version(),  # noqa: SLF001
        "feature_dim": FEATURE_DIM,
        "onnxruntime_version": ort.__version__, "opset": OPSET_VERSION,
        "prototype_count": int(authority.packed_prototypes.shape[0]),
        "status": "ready_for_exact_dual_branch_hybrid_export",
        "torch_version": torch.__version__, "transformers_version": transformers.__version__,
        "variant_checkpoint_sha256": runtime.sha256_file(authority.v6_checkpoint_path),
    }


def _add_source_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--student-output", type=Path, required=True)
    parser.add_argument("--active-catalog", dest="active_catalog_path", type=Path, required=True)
    parser.add_argument("--encoder-source-dir", type=Path, required=True)
    parser.add_argument("--v3-cache-dir", type=Path, required=True)
    parser.add_argument("--v3-readiness-dir", type=Path, required=True)
    parser.add_argument("--v3-head", dest="v3_head_path", type=Path, required=True)
    parser.add_argument("--v6-output-dir", type=Path, required=True)
    parser.add_argument("--hybrid-diagnostic-dir", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "build", "validate"):
        sub = commands.add_parser(name)
        _add_source_args(sub)
        if name in {"build", "validate"}:
            sub.add_argument("--output-dir", type=Path, required=True)
        if name in {"preflight", "build"}:
            sub.add_argument(
                "--electron-path", type=Path,
                default=legacy_export._default_electron_path(),  # noqa: SLF001
            )
        if name == "build":
            sub.add_argument("--parity-samples", type=int, default=MIN_PARITY_SAMPLES)
            sub.add_argument("--parity-seed", type=int, default=20260803)
            sub.add_argument("--wasm-timeout-seconds", type=int, default=7200)
            sub.add_argument("--replace-owned-output", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    values = vars(args).copy()
    command = values.pop("command")
    try:
        if command == "preflight":
            result = preflight(**values)
        elif command == "build":
            result = build_runtime_output(**values)
        else:
            result = validate_runtime_output(**values)
    except HybridRuntimeExportError as error:
        print(json.dumps({"error": str(error), "status": "blocked"}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
