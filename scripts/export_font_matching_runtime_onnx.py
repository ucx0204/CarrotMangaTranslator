#!/usr/bin/env python3
"""Export a sealed Font Matching trainer output to production ONNX assets.

This converter is the only supported bridge between the training-only
SigLIP/ranker authority and ``build_font_matching_runtime_artifact.py``.  It
loads the frozen encoder from an explicit immutable local snapshot, exports the
trained ranker, writes the cache-bound prototype bank, and proves numerical
parity in both Python CPU ORT and the app's pinned Electron WASM runtime.

No network fallback, test pixels, row identifiers, or provisional trainer
output can cross this boundary.  A missing or stale authority fails closed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    import build_font_matching_runtime_artifact as runtime
    import train_font_matching_siglip_baseline as trainer
except ImportError:  # pragma: no cover - import from repository root
    from scripts import build_font_matching_runtime_artifact as runtime  # type: ignore[no-redef]
    from scripts import train_font_matching_siglip_baseline as trainer  # type: ignore[no-redef]


SCHEMA_VERSION = "font-matching-onnx-conversion-v1"
OWNER = "carrot-manga-translator/font-matching-onnx-conversion"
MARKER_FILE = ".font-matching-onnx-conversion-owned.json"
PARITY_FILE = "onnx-parity-report.json"
ENCODER_FILE = runtime.ENCODER_FILE
RANKER_FILE = runtime.RANKER_FILE
PROTOTYPE_FILE = runtime.PROTOTYPE_FILE
FEATURE_CACHE_FILES = {
    ".font-matching-siglip-feature-cache-owned.json",
    "manifest.json",
    "prototype-features.npy",
    "sample-features.npy",
}
OUTPUT_FILES = {
    MARKER_FILE,
    PARITY_FILE,
    ENCODER_FILE,
    RANKER_FILE,
    PROTOTYPE_FILE,
}
OPSET_VERSION = 17
MIN_PARITY_SAMPLES = 32
WASM_REQUEST_SCHEMA = "font-matching-onnx-wasm-parity-request-v1"
WASM_RESPONSE_SCHEMA = "font-matching-onnx-wasm-parity-response-v1"
REPO_ROOT = Path(__file__).resolve().parent.parent
WASM_HELPER = REPO_ROOT / "scripts" / "run_font_matching_onnx_wasm_parity.cjs"


class ConversionError(ValueError):
    """Raised when an ONNX conversion cannot be proven production-safe."""


@dataclass(frozen=True)
class ConversionAuthority:
    active_catalog: Mapping[str, Any]
    training: Mapping[str, Any]
    contract: Mapping[str, Any]
    cache_manifest: Mapping[str, Any]
    cache_manifest_sha256: str
    sample_features: np.ndarray
    prototype_features: np.ndarray
    candidate_bags: tuple[dict[str, Any], ...]
    feature_cache_dir: Path
    encoder_source_dir: Path
    encoder_source_weights: Path


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ConversionError(f"{location}: expected an object")
    return value


def _require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise ConversionError(f"{location}: expected a list")
    return value


def _require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConversionError(f"{location}: expected non-empty text")
    return value.strip()


def _require_integer(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ConversionError(f"{location}: expected integer >= {minimum}")
    return value


def _read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ConversionError(f"{location}: file is missing or linked")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConversionError(f"{location}: invalid JSON: {error}") from error
    return dict(_require_mapping(value, location))


def _validate_exact_inventory(root: Path, expected: set[str], *, location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise ConversionError(f"{location}: directory is missing or linked")
    actual: set[str] = set()
    for path in root.iterdir():
        if path.is_symlink() or not path.is_file():
            raise ConversionError(f"{location}: nested or linked entries are forbidden")
        actual.add(path.name)
    if actual != expected:
        raise ConversionError(
            f"{location}: file inventory drifted; "
            f"expected={sorted(expected)} actual={sorted(actual)}"
        )


def _ensure_offline_environment() -> None:
    # These are set before Transformers is imported.  Explicit local paths and
    # local_files_only remain mandatory as a second, independent guard.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"


def _paths_overlap(left: Path, right: Path) -> bool:
    left_resolved = left.resolve()
    right_resolved = right.resolve()
    try:
        left_resolved.relative_to(right_resolved)
        return True
    except ValueError:
        pass
    try:
        right_resolved.relative_to(left_resolved)
        return True
    except ValueError:
        return False


def _assert_disjoint_output(output_dir: Path, sources: Sequence[Path]) -> Path:
    root = output_dir.expanduser().resolve()
    if root == Path(root.anchor) or not root.name:
        raise ConversionError("conversion output must not be a filesystem root")
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise ConversionError("conversion output must be a real directory path")
    for source in sources:
        if _paths_overlap(root, source.expanduser().resolve()):
            raise ConversionError(
                f"conversion output must be disjoint from authority source: {source}"
            )
    return root


def _validate_encoder_source(
    source_dir: Path, *, contract: Mapping[str, Any]
) -> tuple[Path, Mapping[str, Any]]:
    root = source_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise ConversionError("encoder source snapshot is missing or linked")
    encoder = _require_mapping(contract.get("encoder"), "model contract.encoder")
    revision = _require_text(encoder.get("revision"), "model contract.encoder.revision")
    if root.name != revision:
        raise ConversionError(
            "encoder source directory name must equal the sealed immutable revision"
        )
    required = ("config.json", "preprocessor_config.json", "model.safetensors")
    for file_name in required:
        path = root / file_name
        if path.is_symlink() or not path.is_file():
            raise ConversionError(
                f"encoder source snapshot lacks a regular {file_name} file"
            )
    config = _read_json(root / "config.json", location="encoder config")
    if config.get("model_type") not in {"siglip", "siglip2"}:
        raise ConversionError("encoder config is not a SigLIP/SigLIP2 checkpoint")
    vision = _require_mapping(
        config.get("vision_config"), "encoder config.vision_config"
    )
    architecture = _require_mapping(contract.get("architecture"), "model architecture")
    feature_dim = _require_integer(
        architecture.get("feature_dim"), "model architecture.feature_dim", minimum=1
    )
    if "hidden_size" in vision:
        explicit_hidden_size = _require_integer(
            vision.get("hidden_size"),
            "encoder config.vision_config.hidden_size",
            minimum=1,
        )
        if explicit_hidden_size != feature_dim:
            raise ConversionError(
                "explicit encoder source feature dimension differs from trainer"
            )

    _ensure_offline_environment()
    try:
        from transformers import AutoConfig
    except (ImportError, OSError) as error:  # pragma: no cover - environment setup
        raise ConversionError(
            "encoder validation requires the local Transformers config classes"
        ) from error
    try:
        resolved_config = AutoConfig.from_pretrained(
            str(root), local_files_only=True, trust_remote_code=False
        )
    except Exception as error:  # noqa: BLE001 - normalize Transformers failures
        raise ConversionError(
            f"local encoder configuration failed to resolve: {error}"
        ) from error
    resolved_vision = getattr(resolved_config, "vision_config", None)
    resolved_hidden_size = _require_integer(
        getattr(resolved_vision, "hidden_size", None),
        "resolved encoder config.vision_config.hidden_size",
        minimum=1,
    )
    if resolved_hidden_size != feature_dim:
        raise ConversionError(
            "resolved encoder source feature dimension differs from trainer"
        )
    return root / "model.safetensors", config


def candidate_bags_from_index(
    prototype_index: Sequence[Any], candidate_ids: Sequence[str]
) -> tuple[dict[str, Any], ...]:
    if not candidate_ids or len(set(candidate_ids)) != len(candidate_ids):
        raise ConversionError("candidate IDs must be non-empty and unique")
    by_candidate: dict[str, list[int]] = {
        candidate_id: [] for candidate_id in candidate_ids
    }
    for index, raw in enumerate(prototype_index):
        row = _require_mapping(raw, f"prototype_index[{index}]")
        if row.get("row_index") != index:
            raise ConversionError("prototype row indices are not canonical")
        candidate_id = _require_text(
            row.get("font_id"), f"prototype_index[{index}].font_id"
        )
        if candidate_id not in by_candidate:
            raise ConversionError("prototype cache contains a non-catalog candidate")
        by_candidate[candidate_id].append(index)
    bags: list[dict[str, Any]] = []
    next_start = 0
    for candidate_id in candidate_ids:
        indices = by_candidate[candidate_id]
        if not indices:
            raise ConversionError(f"candidate has no prototype: {candidate_id}")
        expected = list(range(next_start, next_start + len(indices)))
        if indices != expected:
            raise ConversionError(
                "prototype rows must be contiguous in sealed candidate order"
            )
        bags.append(
            {"candidate_id": candidate_id, "count": len(indices), "start": next_start}
        )
        next_start += len(indices)
    if next_start != len(prototype_index):
        raise ConversionError("prototype index has unassigned rows")
    return tuple(bags)


def _load_feature_cache(
    cache_dir: Path, *, contract: Mapping[str, Any], candidate_ids: Sequence[str]
) -> tuple[Mapping[str, Any], str, np.ndarray, np.ndarray, tuple[dict[str, Any], ...]]:
    root = cache_dir.expanduser().resolve()
    _validate_exact_inventory(root, FEATURE_CACHE_FILES, location="feature cache")
    marker = _read_json(
        root / ".font-matching-siglip-feature-cache-owned.json",
        location="feature cache marker",
    )
    if (
        marker.get("owner") != trainer.CACHE_OWNER
        or marker.get("schema_version") != trainer.CACHE_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise ConversionError("feature cache ownership marker is invalid")
    manifest_path = root / "manifest.json"
    manifest_payload = manifest_path.read_bytes()
    manifest_sha = sha256_bytes(manifest_payload)
    if marker.get("manifest_sha256") != manifest_sha:
        raise ConversionError("feature cache marker/manifest hash mismatch")
    manifest = _read_json(manifest_path, location="feature cache manifest")
    try:
        trainer.validate_record_seal(manifest, location="feature cache manifest")
    except trainer.TrainerError as error:
        raise ConversionError(str(error)) from error
    cache_contract = _require_mapping(
        manifest.get("contract"), "feature cache.contract"
    )
    try:
        cache = trainer.load_feature_cache(
            cache_dir=root, expected_contract=cache_contract
        )
    except trainer.TrainerError as error:
        raise ConversionError(f"feature cache validation failed: {error}") from error

    model_cache = _require_mapping(contract.get("feature_cache"), "model feature_cache")
    if model_cache.get("manifest_sha256") != manifest_sha or model_cache.get(
        "processor_config_sha256"
    ) != manifest.get("processor_config_sha256"):
        raise ConversionError("trainer checkpoint is bound to another feature cache")
    if cache_contract.get("preprocessing") != contract.get("preprocessing"):
        raise ConversionError("feature cache preprocessing differs from trainer")
    cache_encoder = _require_mapping(
        cache_contract.get("encoder"), "feature cache.contract.encoder"
    )
    model_encoder = _require_mapping(contract.get("encoder"), "model encoder")
    for key in ("class", "fully_frozen", "model_id", "revision"):
        if cache_encoder.get(key) != model_encoder.get(key):
            raise ConversionError(f"feature cache encoder binding drifted: {key}")
    cache_inputs = _require_mapping(
        cache_contract.get("inputs"), "feature cache.contract.inputs"
    )
    model_inputs = _require_mapping(contract.get("inputs"), "model contract.inputs")
    for key, value in cache_inputs.items():
        if key not in model_inputs or model_inputs.get(key) != value:
            raise ConversionError(f"feature cache input binding drifted: {key}")
    inventory = _require_mapping(
        cache_contract.get("inventory"), "feature cache.contract.inventory"
    )
    if inventory.get("test_pixel_count") != 0 or inventory.get("splits") != [
        "train",
        "val",
    ]:
        raise ConversionError("feature cache crossed the frozen-test boundary")

    sample_features = np.asarray(cache.sample_features, dtype=np.float32)
    prototype_features = np.asarray(cache.prototype_features, dtype=np.float32)
    architecture = _require_mapping(contract.get("architecture"), "model architecture")
    feature_dim = _require_integer(
        architecture.get("feature_dim"), "model feature_dim", minimum=1
    )
    if (
        sample_features.shape[1:] != (3, feature_dim)
        or prototype_features.ndim != 2
        or prototype_features.shape[1] != feature_dim
    ):
        raise ConversionError("feature cache arrays differ from model dimensions")
    prototype_index = _require_list(
        manifest.get("prototype_index"), "feature cache.prototype_index"
    )
    bags = candidate_bags_from_index(prototype_index, candidate_ids)
    if prototype_features.shape[0] != sum(row["count"] for row in bags):
        raise ConversionError("prototype array/index count mismatch")
    return manifest, manifest_sha, sample_features, prototype_features, bags


def load_conversion_authority(
    *,
    active_catalog_path: Path,
    trainer_output: Path,
    feature_cache: Path,
    encoder_source_dir: Path,
) -> ConversionAuthority:
    try:
        active_catalog = runtime.load_active_catalog(
            active_catalog_path.expanduser().resolve(),
            location="conversion active catalog",
        )
        training = runtime._load_training_bundle(  # noqa: SLF001 - shared contract authority
            trainer_output.expanduser().resolve(),
            expected_candidate_ids=active_catalog["candidate_ids"],
        )
    except runtime.RuntimeArtifactError as error:
        raise ConversionError(
            f"production training authority rejected: {error}"
        ) from error
    contract = _require_mapping(training.get("contract"), "training contract")
    inputs = _require_mapping(contract.get("inputs"), "training contract.inputs")
    active_sources = _require_mapping(
        active_catalog.get("source_records"), "active catalog.source_records"
    )
    if inputs.get("font_catalog_sha256") != active_sources.get(
        "deployment_font_face_manifest_sha256"
    ) or inputs.get("render_bank_manifest_sha256") != active_sources.get(
        "deployment_render_bank_manifest_sha256"
    ):
        raise ConversionError(
            "trainer catalog/render bank differs from the deployment active catalog"
        )
    candidate_ids = tuple(training["candidate_ids"])
    manifest, manifest_sha, samples, prototypes, bags = _load_feature_cache(
        feature_cache, contract=contract, candidate_ids=candidate_ids
    )
    source_weights, _ = _validate_encoder_source(encoder_source_dir, contract=contract)
    return ConversionAuthority(
        active_catalog=active_catalog,
        training=training,
        contract=contract,
        cache_manifest=manifest,
        cache_manifest_sha256=manifest_sha,
        sample_features=samples,
        prototype_features=prototypes,
        candidate_bags=bags,
        feature_cache_dir=feature_cache.expanduser().resolve(),
        encoder_source_dir=encoder_source_dir.expanduser().resolve(),
        encoder_source_weights=source_weights,
    )


def _load_torch_models(authority: ConversionAuthority) -> tuple[Any, Any]:
    _ensure_offline_environment()
    try:
        import torch
        from transformers import AutoImageProcessor, SiglipVisionModel
    except (ImportError, OSError) as error:  # pragma: no cover - environment setup
        raise ConversionError(
            "conversion requires torch, transformers, and the local SigLIP classes"
        ) from error
    contract = authority.contract
    processor_contract = _require_mapping(
        _require_mapping(contract.get("preprocessing"), "preprocessing").get(
            "processor"
        ),
        "preprocessing.processor",
    )
    if (
        processor_contract.get("class") != trainer.PROCESSOR_CLASS
        or processor_contract.get("do_resize") is not False
        or processor_contract.get("use_fast") is not False
    ):
        raise ConversionError("trainer processor contract is unsupported")
    try:
        processor = AutoImageProcessor.from_pretrained(
            str(authority.encoder_source_dir),
            local_files_only=True,
            use_fast=False,
        )
    except Exception as error:  # noqa: BLE001 - normalize Transformers failures
        raise ConversionError(
            f"local encoder processor failed to load: {error}"
        ) from error
    processor_sha = sha256_bytes(canonical_json(processor.to_dict()).encode("utf-8"))
    expected_processor_sha = _require_mapping(
        contract.get("feature_cache"), "model feature_cache"
    ).get("processor_config_sha256")
    if processor_sha != expected_processor_sha:
        raise ConversionError(
            "local processor configuration differs from feature cache"
        )
    try:
        encoder = SiglipVisionModel.from_pretrained(
            str(authority.encoder_source_dir),
            local_files_only=True,
            attn_implementation="eager",
        )
    except Exception as error:  # noqa: BLE001 - normalize Transformers failures
        raise ConversionError(
            f"local SigLIP vision tower failed to load: {error}"
        ) from error
    encoder.config._attn_implementation = "eager"  # noqa: SLF001 - export contract
    encoder.requires_grad_(False)
    encoder.eval()
    encoder.to("cpu", dtype=torch.float32)
    if any(parameter.requires_grad for parameter in encoder.parameters()):
        raise ConversionError("encoder is not fully frozen after local load")
    feature_dim = int(
        _require_mapping(contract.get("architecture"), "architecture")["feature_dim"]
    )
    if int(encoder.config.hidden_size) != feature_dim:
        raise ConversionError("loaded encoder dimension differs from trainer")

    architecture = _require_mapping(contract.get("architecture"), "architecture")
    hyperparameters = _require_mapping(
        contract.get("hyperparameters"), "hyperparameters"
    )
    try:
        ranker = trainer.build_ranker(
            feature_dim=feature_dim,
            hidden_dim=_require_integer(
                architecture.get("hidden_dim"), "architecture.hidden_dim", minimum=1
            ),
            view_dropout=float(architecture.get("view_dropout")),
            head_dropout=float(hyperparameters.get("head_dropout")),
        )
        ranker.load_state_dict(
            dict(trainer.load_checkpoint(authority.training["checkpoint_path"])),
            strict=True,
        )
    except (trainer.TrainerError, RuntimeError, TypeError, ValueError) as error:
        raise ConversionError(
            f"trained ranker failed to load exactly: {error}"
        ) from error
    ranker.requires_grad_(False)
    ranker.eval()
    ranker.to("cpu")
    return encoder, ranker


def _ranker_output_names(contract: Mapping[str, Any]) -> tuple[str, ...]:
    vocabulary = _require_mapping(contract.get("vocabulary"), "model vocabulary")
    treatments = _require_mapping(vocabulary.get("treatments"), "treatments")
    return (
        "candidate_scores",
        "none_logits",
        "role_logits",
        "style_logits",
        *(f"treatment_{field}_logits" for field in sorted(treatments)),
        "view_gate_weights",
    )


def _make_export_wrappers(
    *, encoder: Any, ranker: Any, authority: ConversionAuthority
) -> tuple[Any, Any]:
    import torch

    class EncoderWrapper(torch.nn.Module):
        def __init__(self, model: Any) -> None:
            super().__init__()
            self.model = model

        def forward(self, pixel_values: Any) -> Any:
            outputs = self.model(pixel_values=pixel_values, return_dict=False)
            return torch.nn.functional.normalize(outputs[1].float(), p=2, dim=-1)

    treatment_fields = tuple(
        sorted(
            _require_mapping(
                _require_mapping(
                    authority.contract.get("vocabulary"), "vocabulary"
                ).get("treatments"),
                "vocabulary.treatments",
            )
        )
    )
    bag_tensors = tuple(
        torch.arange(row["start"], row["start"] + row["count"], dtype=torch.long)
        for row in authority.candidate_bags
    )

    class RankerWrapper(torch.nn.Module):
        def __init__(self, model: Any) -> None:
            super().__init__()
            self.model = model
            for index, bag in enumerate(bag_tensors):
                self.register_buffer(f"candidate_bag_{index}", bag, persistent=False)

        def forward(self, views: Any, prototype_features: Any) -> tuple[Any, ...]:
            bags = tuple(
                getattr(self, f"candidate_bag_{index}")
                for index in range(len(bag_tensors))
            )
            outputs = self.model(views, prototype_features, bags)
            treatment = outputs["treatment_logits"]
            return (
                outputs["candidate_scores"],
                outputs["none_logits"],
                outputs["role_logits"],
                outputs["style_logits"],
                *(treatment[field] for field in treatment_fields),
                outputs["view_gate_weights"],
            )

    return EncoderWrapper(encoder).eval(), RankerWrapper(ranker).eval()


def _require_onnx_export_dependency() -> Any:
    try:
        import onnx
    except ImportError as error:  # pragma: no cover - release environment
        raise ConversionError(
            "ONNX export requires the `onnx` Python package; install it in the "
            "offline conversion environment before rerunning"
        ) from error
    return onnx


def _export_onnx_graphs(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    authority: ConversionAuthority,
    encoder_path: Path,
    ranker_path: Path,
    opset_version: int,
) -> None:
    if opset_version != OPSET_VERSION:
        raise ConversionError(
            f"only the WASM-qualified opset {OPSET_VERSION} is supported"
        )
    _require_onnx_export_dependency()
    import torch

    feature_dim = int(authority.prototype_features.shape[1])
    prototype_tensor = torch.from_numpy(
        np.array(authority.prototype_features, dtype=np.float32, copy=True)
    )
    output_names = _ranker_output_names(authority.contract)
    dynamic_ranker = {"views": {0: "batch"}}
    dynamic_ranker.update({name: {0: "batch"} for name in output_names})
    try:
        with torch.inference_mode():
            torch.onnx.export(
                encoder_wrapper,
                (torch.zeros((1, 3, 224, 224), dtype=torch.float32),),
                str(encoder_path),
                input_names=["pixel_values"],
                output_names=["image_features"],
                dynamic_axes={
                    "pixel_values": {0: "batch"},
                    "image_features": {0: "batch"},
                },
                opset_version=opset_version,
                dynamo=False,
                external_data=False,
                export_params=True,
                do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
            torch.onnx.export(
                ranker_wrapper,
                (
                    torch.zeros((2, 3, feature_dim), dtype=torch.float32),
                    prototype_tensor,
                ),
                str(ranker_path),
                input_names=["views", "prototype_features"],
                output_names=list(output_names),
                dynamic_axes=dynamic_ranker,
                opset_version=opset_version,
                dynamo=False,
                external_data=False,
                export_params=True,
                do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
    except Exception as error:  # noqa: BLE001 - normalize exporter failures
        raise ConversionError(f"PyTorch ONNX export failed: {error}") from error


def _inspect_graph_file(path: Path, *, expected_opset: int) -> Mapping[str, Any]:
    onnx = _require_onnx_export_dependency()
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise ConversionError(f"ONNX graph is missing or unsafe: {path.name}")
    try:
        model = onnx.load(str(path), load_external_data=False)
        onnx.checker.check_model(model)
    except Exception as error:  # noqa: BLE001 - normalize ONNX failures
        raise ConversionError(f"ONNX checker rejected {path.name}: {error}") from error
    external = [
        initializer.name
        for initializer in model.graph.initializer
        if initializer.data_location == onnx.TensorProto.EXTERNAL
        or initializer.external_data
    ]
    if external:
        raise ConversionError(f"{path.name}: external tensor data is forbidden")
    opsets = {entry.domain: int(entry.version) for entry in model.opset_import}
    if opsets.get("") != expected_opset or any(
        domain not in {"", "ai.onnx"} for domain in opsets
    ):
        raise ConversionError(f"{path.name}: unsupported ONNX domain/opset: {opsets}")
    custom_domains = sorted(
        {node.domain for node in model.graph.node if node.domain not in {"", "ai.onnx"}}
    )
    if custom_domains:
        raise ConversionError(f"{path.name}: custom operator domains are forbidden")
    return {
        "byte_size": path.stat().st_size,
        "node_count": len(model.graph.node),
        "opset": expected_opset,
        "sha256": sha256_file(path),
    }


def _write_prototype_features(path: Path, features: np.ndarray) -> None:
    values = np.asarray(features, dtype="<f4")
    if values.ndim != 2 or not np.isfinite(values).all():
        raise ConversionError("prototype features must be finite float32 rows")
    path.write_bytes(np.ascontiguousarray(values).tobytes(order="C"))


def _synthetic_encoder_inputs(sample_count: int, seed: int) -> np.ndarray:
    if sample_count < MIN_PARITY_SAMPLES:
        raise ConversionError(f"parity requires at least {MIN_PARITY_SAMPLES} samples")
    rng = np.random.default_rng(seed)
    values = np.clip(
        rng.standard_normal((sample_count, 3, 224, 224), dtype=np.float32) / 2.5,
        -1.0,
        1.0,
    ).astype(np.float32, copy=False)
    values[0].fill(-1.0)
    values[1].fill(0.0)
    values[2].fill(1.0)
    ramp = np.linspace(-1.0, 1.0, 224, dtype=np.float32)
    values[3] = np.broadcast_to(ramp[None, None, :], (3, 224, 224))
    return np.ascontiguousarray(values)


def _ranker_parity_inputs(
    authority: ConversionAuthority, *, sample_count: int, seed: int
) -> tuple[np.ndarray, Mapping[str, int]]:
    sample_index = _require_list(
        authority.cache_manifest.get("sample_index"), "feature cache.sample_index"
    )
    validation_indices = [
        index
        for index, raw in enumerate(sample_index)
        if _require_mapping(raw, f"sample_index[{index}]").get("split") == "val"
    ]
    if not validation_indices:
        raise ConversionError("feature cache contains no validation rows for parity")
    validation_count = min(len(validation_indices), max(1, sample_count // 2))
    if validation_count >= sample_count:
        validation_count = sample_count - 1
    positions = np.linspace(
        0, len(validation_indices) - 1, validation_count, dtype=np.int64
    )
    selected = [validation_indices[int(position)] for position in positions]
    validation = np.asarray(authority.sample_features[selected], dtype=np.float32)
    synthetic_count = sample_count - validation_count
    rng = np.random.default_rng(seed ^ 0x5A17)
    synthetic = rng.standard_normal(
        (synthetic_count, 3, authority.sample_features.shape[-1]), dtype=np.float32
    )
    norms = np.linalg.norm(synthetic, axis=-1, keepdims=True)
    synthetic = synthetic / np.maximum(norms, np.float32(1e-12))
    combined = np.concatenate([validation, synthetic], axis=0).astype(
        np.float32, copy=False
    )
    if combined.shape[0] != sample_count or not np.isfinite(combined).all():
        raise ConversionError("ranker parity input construction failed")
    return np.ascontiguousarray(combined), {
        "ranker_synthetic_rows": synthetic_count,
        "ranker_validation_rows": validation_count,
    }


def _batch_slices(sample_count: int, preferred: int) -> tuple[tuple[int, int], ...]:
    if sample_count < 2 or preferred < 2:
        raise ConversionError("dynamic parity batches require sample_count/batch >= 2")
    output = [(0, 1)]
    start = 1
    while start < sample_count:
        end = min(sample_count, start + preferred)
        output.append((start, end))
        start = end
    if len({end - start for start, end in output}) < 2:
        raise ConversionError("parity did not exercise two dynamic batch sizes")
    return tuple(output)


def _run_reference_models(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    encoder_inputs: np.ndarray,
    ranker_views: np.ndarray,
    prototype_features: np.ndarray,
    encoder_batch_size: int,
    ranker_batch_size: int,
    output_names: Sequence[str],
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    import torch

    encoder_rows = []
    ranker_chunks: dict[str, list[np.ndarray]] = {name: [] for name in output_names}
    prototypes = torch.from_numpy(np.array(prototype_features, copy=True))
    with torch.inference_mode():
        for start, end in _batch_slices(len(encoder_inputs), encoder_batch_size):
            output = encoder_wrapper(
                torch.from_numpy(np.array(encoder_inputs[start:end], copy=True))
            )
            encoder_rows.append(output.detach().cpu().numpy().astype(np.float32))
        for start, end in _batch_slices(len(ranker_views), ranker_batch_size):
            outputs = ranker_wrapper(
                torch.from_numpy(np.array(ranker_views[start:end], copy=True)),
                prototypes,
            )
            for name, tensor in zip(output_names, outputs, strict=True):
                ranker_chunks[name].append(
                    tensor.detach().cpu().numpy().astype(np.float32)
                )
    encoder_output = np.ascontiguousarray(np.concatenate(encoder_rows, axis=0))
    ranker_outputs = {
        name: np.ascontiguousarray(np.concatenate(chunks, axis=0))
        for name, chunks in ranker_chunks.items()
    }
    return encoder_output, ranker_outputs


def _run_cpu_ort(
    *,
    encoder_path: Path,
    ranker_path: Path,
    encoder_inputs: np.ndarray,
    ranker_views: np.ndarray,
    prototype_features: np.ndarray,
    encoder_batch_size: int,
    ranker_batch_size: int,
    output_names: Sequence[str],
) -> tuple[np.ndarray, dict[str, np.ndarray], Mapping[str, Any]]:
    try:
        import onnxruntime as ort
    except ImportError as error:  # pragma: no cover - release environment
        raise ConversionError("CPU parity requires onnxruntime") from error
    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise ConversionError("onnxruntime CPUExecutionProvider is unavailable")
    try:
        encoder_session = ort.InferenceSession(
            str(encoder_path), providers=["CPUExecutionProvider"]
        )
        ranker_session = ort.InferenceSession(
            str(ranker_path), providers=["CPUExecutionProvider"]
        )
    except Exception as error:  # noqa: BLE001 - normalize ORT failures
        raise ConversionError(
            f"CPU ORT failed to load exported graphs: {error}"
        ) from error
    encoder_chunks = []
    started = time.perf_counter()
    for start, end in _batch_slices(len(encoder_inputs), encoder_batch_size):
        output = encoder_session.run(
            ["image_features"], {"pixel_values": encoder_inputs[start:end]}
        )[0]
        encoder_chunks.append(np.asarray(output, dtype=np.float32))
    ranker_chunks: dict[str, list[np.ndarray]] = {name: [] for name in output_names}
    for start, end in _batch_slices(len(ranker_views), ranker_batch_size):
        values = ranker_session.run(
            list(output_names),
            {
                "views": ranker_views[start:end],
                "prototype_features": prototype_features,
            },
        )
        for name, value in zip(output_names, values, strict=True):
            ranker_chunks[name].append(np.asarray(value, dtype=np.float32))
    elapsed = time.perf_counter() - started
    return (
        np.ascontiguousarray(np.concatenate(encoder_chunks, axis=0)),
        {
            name: np.ascontiguousarray(np.concatenate(chunks, axis=0))
            for name, chunks in ranker_chunks.items()
        },
        {
            "package": "onnxruntime",
            "version": str(ort.__version__),
            "execution_provider": "CPUExecutionProvider",
            "runtime_milliseconds": round(elapsed * 1000.0, 3),
            "dynamic_batch_sizes": sorted(
                {
                    *(
                        end - start
                        for start, end in _batch_slices(
                            len(encoder_inputs), encoder_batch_size
                        )
                    ),
                    *(
                        end - start
                        for start, end in _batch_slices(
                            len(ranker_views), ranker_batch_size
                        )
                    ),
                }
            ),
        },
    )


def _array_descriptor(value: np.ndarray) -> dict[str, Any]:
    array = np.ascontiguousarray(np.asarray(value, dtype="<f4"))
    return {
        "dtype": "float32",
        "sha256": sha256_bytes(array.tobytes(order="C")),
        "shape": list(array.shape),
    }


def _output_set_digest(outputs: Mapping[str, np.ndarray]) -> str:
    descriptors = {
        name: _array_descriptor(value) for name, value in sorted(outputs.items())
    }
    return sha256_bytes(canonical_json(descriptors).encode("utf-8"))


def _parity_metrics(
    *,
    reference_encoder: np.ndarray,
    actual_encoder: np.ndarray,
    reference_ranker: Mapping[str, np.ndarray],
    actual_ranker: Mapping[str, np.ndarray],
    sample_count: int,
) -> dict[str, Any]:
    if reference_encoder.shape != actual_encoder.shape:
        raise ConversionError("encoder parity shapes differ")
    if set(reference_ranker) != set(actual_ranker):
        raise ConversionError("ranker parity output inventory differs")
    for name in reference_ranker:
        if reference_ranker[name].shape != actual_ranker[name].shape:
            raise ConversionError(f"ranker parity shape differs: {name}")
    if not np.isfinite(actual_encoder).all() or any(
        not np.isfinite(value).all() for value in actual_ranker.values()
    ):
        raise ConversionError("parity runtime emitted non-finite values")
    reference_norm = np.linalg.norm(reference_encoder, axis=1)
    actual_norm = np.linalg.norm(actual_encoder, axis=1)
    cosine = np.sum(reference_encoder * actual_encoder, axis=1) / np.maximum(
        reference_norm * actual_norm, np.float32(1e-12)
    )
    encoder_max_abs = float(
        np.max(np.abs(reference_encoder.astype(np.float64) - actual_encoder))
    )
    ranker_max_abs = max(
        float(
            np.max(
                np.abs(reference_ranker[name].astype(np.float64) - actual_ranker[name])
            )
        )
        for name in reference_ranker
    )
    candidate_agreement = float(
        np.mean(
            np.argmax(reference_ranker["candidate_scores"], axis=1)
            == np.argmax(actual_ranker["candidate_scores"], axis=1)
        )
    )
    none_agreement = float(
        np.mean(
            (reference_ranker["none_logits"] >= 0.0)
            == (actual_ranker["none_logits"] >= 0.0)
        )
    )
    role_agreement = float(
        np.mean(
            np.argmax(reference_ranker["role_logits"], axis=1)
            == np.argmax(actual_ranker["role_logits"], axis=1)
        )
    )
    metrics = {
        "encoder": {
            "max_abs_error": encoder_max_abs,
            "minimum_cosine_similarity": float(np.clip(np.min(cosine), 0.0, 1.0)),
        },
        "frozen_test_pixels_opened": 0,
        "frozen_test_rows_used": 0,
        "ranker": {
            "candidate_top1_agreement": candidate_agreement,
            "max_abs_error": ranker_max_abs,
            "none_decision_agreement": none_agreement,
            "role_top1_agreement": role_agreement,
        },
        "sample_count": sample_count,
        "sample_source": "synthetic_plus_validation",
        "test_identifiers_embedded": False,
    }
    try:
        runtime._validate_parity_metrics(metrics, prefix="generated parity")  # noqa: SLF001
    except runtime.RuntimeArtifactError as error:
        raise ConversionError(str(error)) from error
    return metrics


def _hardlink_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)


def _write_raw_array(path: Path, value: np.ndarray) -> Mapping[str, Any]:
    array = np.ascontiguousarray(np.asarray(value, dtype="<f4"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(array.tobytes(order="C"))
    return {
        "file": path.as_posix(),
        "sha256": sha256_file(path),
        "shape": list(array.shape),
    }


def _runtime_asset_paths() -> Mapping[str, Path]:
    dist = REPO_ROOT / "node_modules" / runtime.TARGET_ORT_PACKAGE / "dist"
    return {
        "entry": dist / "ort.node.min.js",
        "wasm_module": dist / "ort-wasm-simd-threaded.mjs",
        "wasm_binary": dist / "ort-wasm-simd-threaded.wasm",
        "package": dist.parent / "package.json",
    }


def _default_electron_path() -> Path:
    if os.name == "nt":
        return REPO_ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
    if sys.platform == "darwin":
        return (
            REPO_ROOT
            / "node_modules"
            / "electron"
            / "dist"
            / "Electron.app"
            / "Contents"
            / "MacOS"
            / "Electron"
        )
    return REPO_ROOT / "node_modules" / "electron" / "dist" / "electron"


def _pinned_electron_version() -> str:
    package = _read_json(
        REPO_ROOT / "node_modules" / "electron" / "package.json",
        location="Electron package",
    )
    if package.get("name") != "electron":
        raise ConversionError("installed Electron package identity drifted")
    return _require_text(package.get("version"), "Electron package.version")


def _relative_descriptor(
    path: Path, *, root: Path, shape: Sequence[int] | None = None
) -> dict[str, Any]:
    descriptor: dict[str, Any] = {
        "file": path.relative_to(root).as_posix(),
        "sha256": sha256_file(path),
    }
    if shape is not None:
        descriptor["shape"] = list(shape)
    return descriptor


def _absolute_descriptor(path: Path) -> dict[str, Any]:
    return {"file": str(path.resolve()), "sha256": sha256_file(path)}


def _load_wasm_outputs(
    *, response: Mapping[str, Any], workspace: Path, output_names: Sequence[str]
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    output_root = (workspace / "wasm-output").resolve()

    def load(descriptor: Any, location: str) -> np.ndarray:
        row = _require_mapping(descriptor, location)
        file_name = _require_text(row.get("file"), f"{location}.file")
        path = (output_root / file_name).resolve()
        try:
            path.relative_to(output_root)
        except ValueError as error:
            raise ConversionError(
                f"{location}: output escapes WASM workspace"
            ) from error
        shape = tuple(
            _require_integer(value, f"{location}.shape[{index}]", minimum=1)
            for index, value in enumerate(
                _require_list(row.get("shape"), f"{location}.shape")
            )
        )
        if (
            path.is_symlink()
            or not path.is_file()
            or sha256_file(path) != row.get("sha256")
        ):
            raise ConversionError(f"{location}: output hash binding failed")
        values = np.fromfile(path, dtype="<f4")
        if values.size != math.prod(shape) or not np.isfinite(values).all():
            raise ConversionError(f"{location}: output shape/value validation failed")
        return np.ascontiguousarray(values.reshape(shape))

    encoder = _require_mapping(response.get("encoder"), "WASM response.encoder")
    ranker = _require_mapping(response.get("ranker"), "WASM response.ranker")
    encoder_outputs = _require_mapping(encoder.get("outputs"), "WASM encoder.outputs")
    ranker_outputs = _require_mapping(ranker.get("outputs"), "WASM ranker.outputs")
    if (
        tuple(encoder.get("dynamic_batch_sizes", ())) == (1,)
        or len(set(encoder.get("dynamic_batch_sizes", ()))) < 2
    ):
        raise ConversionError("Electron WASM encoder did not prove dynamic batching")
    if len(set(ranker.get("dynamic_batch_sizes", ()))) < 2:
        raise ConversionError("Electron WASM ranker did not prove dynamic batching")
    if tuple(ranker.get("output_names", ())) != tuple(output_names):
        raise ConversionError("Electron WASM ranker output order drifted")
    return (
        load(encoder_outputs.get("image_features"), "WASM encoder.image_features"),
        {
            name: load(ranker_outputs.get(name), f"WASM ranker.{name}")
            for name in output_names
        },
    )


def _run_process_with_tree_cleanup(
    command: Sequence[str],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    creationflags = 0
    start_new_session = False
    if os.name == "nt":
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    else:
        start_new_session = True
    process = subprocess.Popen(
        list(command),
        cwd=cwd,
        env=dict(environment),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
        start_new_session=start_new_session,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        if process.poll() is None:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    check=False,
                    capture_output=True,
                    text=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        raise ConversionError(
            f"Electron WASM parity timed out after {timeout_seconds}s; "
            "the dedicated process tree was terminated"
        ) from error
    return subprocess.CompletedProcess(
        args=list(command),
        returncode=process.returncode,
        stdout=stdout,
        stderr=stderr,
    )


def _run_electron_wasm(
    *,
    encoder_path: Path,
    ranker_path: Path,
    encoder_inputs: np.ndarray,
    ranker_views: np.ndarray,
    prototype_features: np.ndarray,
    encoder_batch_size: int,
    ranker_batch_size: int,
    output_names: Sequence[str],
    electron_path: Path,
    timeout_seconds: int,
) -> tuple[np.ndarray, dict[str, np.ndarray], Mapping[str, Any]]:
    assets = _runtime_asset_paths()
    for label, path in {
        "Electron": electron_path,
        "WASM helper": WASM_HELPER,
        **assets,
    }.items():
        if path.is_symlink() or not path.is_file():
            raise ConversionError(f"{label} is missing or linked: {path}")
    package = _read_json(assets["package"], location="onnxruntime-web package")
    if (
        package.get("name") != runtime.TARGET_ORT_PACKAGE
        or package.get("version") != runtime.TARGET_ORT_VERSION
    ):
        raise ConversionError("installed onnxruntime-web differs from production pin")
    electron_version = _pinned_electron_version()

    with tempfile.TemporaryDirectory(prefix="font-matching-wasm-parity-") as raw_root:
        workspace = Path(raw_root).resolve()
        models = workspace / "models"
        models.mkdir()
        linked_encoder = models / ENCODER_FILE
        linked_ranker = models / RANKER_FILE
        _hardlink_or_copy(encoder_path, linked_encoder)
        _hardlink_or_copy(ranker_path, linked_ranker)
        encoder_input_path = workspace / "encoder-inputs.f32"
        views_path = workspace / "ranker-views.f32"
        prototypes_path = workspace / "prototype-features.f32"
        encoder_descriptor = _write_raw_array(encoder_input_path, encoder_inputs)
        views_descriptor = _write_raw_array(views_path, ranker_views)
        prototypes_descriptor = _write_raw_array(prototypes_path, prototype_features)
        # _write_raw_array returns an absolute POSIX path for standalone use;
        # requests are deliberately rewritten to workspace-relative paths.
        for descriptor, path in (
            (encoder_descriptor, encoder_input_path),
            (views_descriptor, views_path),
            (prototypes_descriptor, prototypes_path),
        ):
            descriptor["file"] = path.relative_to(workspace).as_posix()
        request = {
            "encoder": {
                "batch_size": encoder_batch_size,
                "input": encoder_descriptor,
                "model": _relative_descriptor(linked_encoder, root=workspace),
            },
            "output_dir": "wasm-output",
            "ranker": {
                "batch_size": ranker_batch_size,
                "model": _relative_descriptor(linked_ranker, root=workspace),
                "output_names": list(output_names),
                "prototype_features": prototypes_descriptor,
                "views": views_descriptor,
            },
            "runtime": {
                key: _absolute_descriptor(assets[key])
                for key in ("entry", "wasm_module", "wasm_binary")
            },
            "schema_version": WASM_REQUEST_SCHEMA,
        }
        request_path = workspace / "request.json"
        response_path = workspace / "response.json"
        request_path.write_bytes(json_bytes(request, pretty=True))
        command = [
            str(electron_path.resolve()),
            "--disable-gpu",
            str(WASM_HELPER),
            "--request",
            str(request_path),
            "--response",
            str(response_path),
        ]
        environment = os.environ.copy()
        environment.update(
            {
                "ELECTRON_DISABLE_SECURITY_WARNINGS": "true",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
            }
        )
        try:
            completed = _run_process_with_tree_cleanup(
                command,
                cwd=REPO_ROOT,
                environment=environment,
                timeout_seconds=timeout_seconds,
            )
        except OSError as error:
            raise ConversionError(
                f"Electron WASM parity failed to execute: {error}"
            ) from error
        if completed.returncode != 0 or not response_path.is_file():
            detail = (completed.stderr or completed.stdout).strip()[-4000:]
            raise ConversionError(
                f"Electron WASM parity failed with exit {completed.returncode}: {detail}"
            )
        response = _read_json(response_path, location="Electron WASM response")
        if (
            response.get("schema_version") != WASM_RESPONSE_SCHEMA
            or response.get("request_sha256") != sha256_file(request_path)
            or response.get("host") != "electron-main"
            or response.get("electron_version") != electron_version
            or response.get("package") != runtime.TARGET_ORT_PACKAGE
            or response.get("version") != runtime.TARGET_ORT_VERSION
            or response.get("execution_provider") != runtime.TARGET_ORT_PROVIDER
            or response.get("all_outputs_finite") is not True
        ):
            raise ConversionError("Electron WASM parity response contract failed")
        encoder_output, ranker_output = _load_wasm_outputs(
            response=response, workspace=workspace, output_names=output_names
        )
        evidence = {
            "all_outputs_finite": True,
            "electron_version": electron_version,
            "host": "electron-main",
            "package": runtime.TARGET_ORT_PACKAGE,
            "request_sha256": response["request_sha256"],
            "runtime_milliseconds": response.get("runtime_milliseconds"),
            "version": runtime.TARGET_ORT_VERSION,
            "wasm_binary_sha256": sha256_file(assets["wasm_binary"]),
            "wasm_module_sha256": sha256_file(assets["wasm_module"]),
        }
        return encoder_output, ranker_output, evidence


def _build_parity_report(
    *,
    authority: ConversionAuthority,
    encoder_path: Path,
    ranker_path: Path,
    prototype_path: Path,
    encoder_inputs: np.ndarray,
    ranker_views: np.ndarray,
    reference_encoder: np.ndarray,
    reference_ranker: Mapping[str, np.ndarray],
    cpu_encoder: np.ndarray,
    cpu_ranker: Mapping[str, np.ndarray],
    cpu_evidence: Mapping[str, Any],
    wasm_encoder: np.ndarray,
    wasm_ranker: Mapping[str, np.ndarray],
    wasm_evidence: Mapping[str, Any],
    sample_inventory: Mapping[str, int],
    sample_count: int,
    seed: int,
    opset_version: int,
) -> dict[str, Any]:
    candidate_ids = tuple(authority.training["candidate_ids"])
    expected_io = runtime._expected_onnx_io(  # noqa: SLF001 - shared contract
        contract=authority.contract,
        prototype_count=int(authority.prototype_features.shape[0]),
        candidate_count=len(candidate_ids),
    )
    cpu_metrics = _parity_metrics(
        reference_encoder=reference_encoder,
        actual_encoder=cpu_encoder,
        reference_ranker=reference_ranker,
        actual_ranker=cpu_ranker,
        sample_count=sample_count,
    )
    wasm_metrics = _parity_metrics(
        reference_encoder=reference_encoder,
        actual_encoder=wasm_encoder,
        reference_ranker=reference_ranker,
        actual_ranker=wasm_ranker,
        sample_count=sample_count,
    )
    reference_outputs = {"encoder.image_features": reference_encoder}
    reference_outputs.update(
        {f"ranker.{key}": value for key, value in reference_ranker.items()}
    )
    cpu_outputs = {"encoder.image_features": cpu_encoder}
    cpu_outputs.update({f"ranker.{key}": value for key, value in cpu_ranker.items()})
    wasm_outputs = {"encoder.image_features": wasm_encoder}
    wasm_outputs.update({f"ranker.{key}": value for key, value in wasm_ranker.items()})
    report = runtime.seal_record(
        {
            "artifacts": {
                "encoder_onnx_sha256": sha256_file(encoder_path),
                "prototype_features_sha256": sha256_file(prototype_path),
                "ranker_onnx_sha256": sha256_file(ranker_path),
            },
            "candidate_bags": [dict(row) for row in authority.candidate_bags],
            "candidate_ids": list(candidate_ids),
            "candidate_ids_sha256": runtime._ordered_values_sha256(candidate_ids),  # noqa: SLF001
            "evidence": {
                "converter_sha256": sha256_file(Path(__file__).resolve()),
                "cpu_ort": copy.deepcopy(dict(cpu_evidence)),
                "cpu_output_set_sha256": _output_set_digest(cpu_outputs),
                "encoder_input": _array_descriptor(encoder_inputs),
                "feature_cache_manifest_sha256": authority.cache_manifest_sha256,
                "feature_cache_prototype_npy_sha256": sha256_file(
                    authority.feature_cache_dir / "prototype-features.npy"
                ),
                "opset": opset_version,
                "parity_seed": seed,
                "ranker_views": _array_descriptor(ranker_views),
                "reference_output_set_sha256": _output_set_digest(reference_outputs),
                "sample_inventory": {
                    "encoder_synthetic_rows": sample_count,
                    **dict(sample_inventory),
                },
                "wasm_helper_sha256": sha256_file(WASM_HELPER),
                "wasm_output_set_sha256": _output_set_digest(wasm_outputs),
                "wasm_runtime": copy.deepcopy(dict(wasm_evidence)),
            },
            "io_contract": expected_io,
            "record_type": runtime.PARITY_RECORD_TYPE,
            "reference_parity": cpu_metrics,
            "schema_version": runtime.PARITY_SCHEMA,
            "source": {
                "checkpoint_sha256": authority.training["checkpoint_sha256"],
                "encoder_model_id": authority.contract["encoder"]["model_id"],
                "encoder_revision": authority.contract["encoder"]["revision"],
                "encoder_source_weights_sha256": sha256_file(
                    authority.encoder_source_weights
                ),
                "model_contract_sha256": authority.training["contract_sha256"],
            },
            "target_runtime": {
                "all_outputs_finite": True,
                "execution_provider": runtime.TARGET_ORT_PROVIDER,
                "io_contract_passed": True,
                "package": runtime.TARGET_ORT_PACKAGE,
                "parity": wasm_metrics,
                "smoke_case_count": sample_count,
                "version": runtime.TARGET_ORT_VERSION,
            },
            "test_data_boundary": {
                "frozen_test_pixels_opened": 0,
                "frozen_test_rows_used": 0,
                "row_identifiers_persisted": False,
                "training_pixels_packaged": False,
                "validation_pixels_packaged": False,
            },
        }
    )
    return report


def _validate_evidence_bindings(
    report: Mapping[str, Any], *, authority: ConversionAuthority, feature_cache: Path
) -> None:
    evidence = _require_mapping(report.get("evidence"), "parity report.evidence")
    if (
        evidence.get("feature_cache_manifest_sha256") != authority.cache_manifest_sha256
        or evidence.get("feature_cache_prototype_npy_sha256")
        != sha256_file(feature_cache.expanduser().resolve() / "prototype-features.npy")
        or evidence.get("converter_sha256") != sha256_file(Path(__file__).resolve())
        or evidence.get("wasm_helper_sha256") != sha256_file(WASM_HELPER)
        or evidence.get("opset") != OPSET_VERSION
    ):
        raise ConversionError("parity evidence authority/hash binding failed")
    inventory = _require_mapping(evidence.get("sample_inventory"), "sample inventory")
    if (
        _require_integer(
            inventory.get("encoder_synthetic_rows"), "encoder rows", minimum=1
        )
        < MIN_PARITY_SAMPLES
        or _require_integer(
            inventory.get("ranker_validation_rows"), "validation rows", minimum=1
        )
        < 1
        or _require_integer(
            inventory.get("ranker_synthetic_rows"), "synthetic rows", minimum=1
        )
        < 1
    ):
        raise ConversionError(
            "parity evidence lacks synthetic-plus-validation coverage"
        )
    wasm = _require_mapping(evidence.get("wasm_runtime"), "WASM evidence")
    if (
        wasm.get("host") != "electron-main"
        or wasm.get("electron_version") != _pinned_electron_version()
        or wasm.get("package") != runtime.TARGET_ORT_PACKAGE
        or wasm.get("version") != runtime.TARGET_ORT_VERSION
        or wasm.get("all_outputs_finite") is not True
    ):
        raise ConversionError(
            "parity evidence was not produced by pinned Electron WASM"
        )


def _artifact_hashes(root: Path) -> dict[str, str]:
    return {
        file_name: sha256_file(root / file_name)
        for file_name in sorted(OUTPUT_FILES - {MARKER_FILE})
    }


def _write_marker(root: Path, *, authority: ConversionAuthority) -> None:
    marker = {
        "artifacts": _artifact_hashes(root),
        "owner": OWNER,
        "safe_replace": True,
        "schema_version": SCHEMA_VERSION,
        "source": {
            "checkpoint_sha256": authority.training["checkpoint_sha256"],
            "feature_cache_manifest_sha256": authority.cache_manifest_sha256,
            "model_contract_sha256": authority.training["contract_sha256"],
        },
    }
    (root / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))


def _validate_output_marker(root: Path) -> Mapping[str, Any]:
    marker = _read_json(root / MARKER_FILE, location="conversion ownership marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise ConversionError("conversion ownership marker is invalid")
    artifacts = _require_mapping(marker.get("artifacts"), "conversion marker.artifacts")
    if dict(artifacts) != _artifact_hashes(root):
        raise ConversionError("conversion output artifact hash mismatch")
    return marker


def validate_conversion_output(
    *,
    active_catalog_path: Path,
    trainer_output: Path,
    feature_cache: Path,
    encoder_source_dir: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    authority = load_conversion_authority(
        active_catalog_path=active_catalog_path,
        trainer_output=trainer_output,
        feature_cache=feature_cache,
        encoder_source_dir=encoder_source_dir,
    )
    root = output_dir.expanduser().resolve()
    _validate_exact_inventory(root, OUTPUT_FILES, location="conversion output")
    marker = _validate_output_marker(root)
    expected_source = {
        "checkpoint_sha256": authority.training["checkpoint_sha256"],
        "feature_cache_manifest_sha256": authority.cache_manifest_sha256,
        "model_contract_sha256": authority.training["contract_sha256"],
    }
    if marker.get("source") != expected_source:
        raise ConversionError("conversion marker source binding failed")
    report = _read_json(root / PARITY_FILE, location="ONNX parity report")
    try:
        runtime.validate_record_seal(report, location="ONNX parity report")
    except runtime.RuntimeArtifactError as error:
        raise ConversionError(str(error)) from error
    _validate_evidence_bindings(
        report, authority=authority, feature_cache=feature_cache
    )
    _inspect_graph_file(root / ENCODER_FILE, expected_opset=OPSET_VERSION)
    _inspect_graph_file(root / RANKER_FILE, expected_opset=OPSET_VERSION)
    try:
        runtime._load_conversion_report(  # noqa: SLF001 - exact consumer validation
            root / PARITY_FILE,
            training=authority.training,
            encoder_onnx=root / ENCODER_FILE,
            ranker_onnx=root / RANKER_FILE,
            prototype_features=root / PROTOTYPE_FILE,
            encoder_source_weights=authority.encoder_source_weights,
        )
    except runtime.RuntimeArtifactError as error:
        raise ConversionError(
            f"runtime builder rejected conversion: {error}"
        ) from error
    return {
        "candidate_count": len(authority.training["candidate_ids"]),
        "encoder_onnx_sha256": sha256_file(root / ENCODER_FILE),
        "output_dir": str(root),
        "parity_report_sha256": sha256_file(root / PARITY_FILE),
        "prototype_count": int(authority.prototype_features.shape[0]),
        "ranker_onnx_sha256": sha256_file(root / RANKER_FILE),
        "status": "valid_runtime_conversion",
    }


def _commit_owned_directory(
    *,
    staging: Path,
    target: Path,
    validate_published: Callable[[Path], Mapping[str, Any]],
) -> Mapping[str, Any]:
    if not target.exists():
        os.replace(staging, target)
        try:
            return validate_published(target)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            raise
    _validate_output_marker(target)
    backup = target.with_name(f".{target.name}.backup-{uuid.uuid4().hex}")
    os.replace(target, backup)
    try:
        os.replace(staging, target)
        result = validate_published(target)
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        os.replace(backup, target)
        raise
    shutil.rmtree(backup)
    return result


def build_conversion_output(
    *,
    active_catalog_path: Path,
    trainer_output: Path,
    feature_cache: Path,
    encoder_source_dir: Path,
    output_dir: Path,
    electron_path: Path,
    parity_samples: int = MIN_PARITY_SAMPLES,
    encoder_batch_size: int = 2,
    ranker_batch_size: int = 16,
    parity_seed: int = 20260802,
    wasm_timeout_seconds: int = 7200,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    if parity_samples < MIN_PARITY_SAMPLES:
        raise ConversionError(f"parity_samples must be >= {MIN_PARITY_SAMPLES}")
    if encoder_batch_size < 2 or ranker_batch_size < 2:
        raise ConversionError("parity batch sizes must be >= 2")
    if wasm_timeout_seconds < 60:
        raise ConversionError("WASM timeout must be at least 60 seconds")
    authority = load_conversion_authority(
        active_catalog_path=active_catalog_path,
        trainer_output=trainer_output,
        feature_cache=feature_cache,
        encoder_source_dir=encoder_source_dir,
    )
    target = _assert_disjoint_output(
        output_dir,
        (
            active_catalog_path,
            trainer_output,
            feature_cache,
            encoder_source_dir,
        ),
    )
    if target.exists() and not replace_owned_output:
        raise ConversionError(
            "conversion output exists; pass --replace-owned-output after validation"
        )
    if target.exists():
        _validate_exact_inventory(target, OUTPUT_FILES, location="existing conversion")
        _validate_output_marker(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        encoder_path = staging / ENCODER_FILE
        ranker_path = staging / RANKER_FILE
        prototype_path = staging / PROTOTYPE_FILE
        report_path = staging / PARITY_FILE
        encoder, ranker = _load_torch_models(authority)
        encoder_wrapper, ranker_wrapper = _make_export_wrappers(
            encoder=encoder, ranker=ranker, authority=authority
        )
        _export_onnx_graphs(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=encoder_path,
            ranker_path=ranker_path,
            opset_version=OPSET_VERSION,
        )
        _write_prototype_features(prototype_path, authority.prototype_features)
        _inspect_graph_file(encoder_path, expected_opset=OPSET_VERSION)
        _inspect_graph_file(ranker_path, expected_opset=OPSET_VERSION)
        expected_io = runtime._expected_onnx_io(  # noqa: SLF001
            contract=authority.contract,
            prototype_count=int(authority.prototype_features.shape[0]),
            candidate_count=len(authority.training["candidate_ids"]),
        )
        if (
            runtime._inspect_onnx_contract(encoder_path) != expected_io[ENCODER_FILE]  # noqa: SLF001
            or runtime._inspect_onnx_contract(ranker_path) != expected_io[RANKER_FILE]  # noqa: SLF001
        ):
            raise ConversionError("exported ONNX I/O contract differs from runtime")

        encoder_inputs = _synthetic_encoder_inputs(parity_samples, parity_seed)
        ranker_views, sample_inventory = _ranker_parity_inputs(
            authority, sample_count=parity_samples, seed=parity_seed
        )
        output_names = _ranker_output_names(authority.contract)
        reference_encoder, reference_ranker = _run_reference_models(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            encoder_inputs=encoder_inputs,
            ranker_views=ranker_views,
            prototype_features=authority.prototype_features,
            encoder_batch_size=encoder_batch_size,
            ranker_batch_size=ranker_batch_size,
            output_names=output_names,
        )
        cpu_encoder, cpu_ranker, cpu_evidence = _run_cpu_ort(
            encoder_path=encoder_path,
            ranker_path=ranker_path,
            encoder_inputs=encoder_inputs,
            ranker_views=ranker_views,
            prototype_features=authority.prototype_features,
            encoder_batch_size=encoder_batch_size,
            ranker_batch_size=ranker_batch_size,
            output_names=output_names,
        )
        wasm_encoder, wasm_ranker, wasm_evidence = _run_electron_wasm(
            encoder_path=encoder_path,
            ranker_path=ranker_path,
            encoder_inputs=encoder_inputs,
            ranker_views=ranker_views,
            prototype_features=authority.prototype_features,
            encoder_batch_size=encoder_batch_size,
            ranker_batch_size=ranker_batch_size,
            output_names=output_names,
            electron_path=electron_path.expanduser().resolve(),
            timeout_seconds=wasm_timeout_seconds,
        )
        report = _build_parity_report(
            authority=authority,
            encoder_path=encoder_path,
            ranker_path=ranker_path,
            prototype_path=prototype_path,
            encoder_inputs=encoder_inputs,
            ranker_views=ranker_views,
            reference_encoder=reference_encoder,
            reference_ranker=reference_ranker,
            cpu_encoder=cpu_encoder,
            cpu_ranker=cpu_ranker,
            cpu_evidence=cpu_evidence,
            wasm_encoder=wasm_encoder,
            wasm_ranker=wasm_ranker,
            wasm_evidence=wasm_evidence,
            sample_inventory=sample_inventory,
            sample_count=parity_samples,
            seed=parity_seed,
            opset_version=OPSET_VERSION,
        )
        report_path.write_bytes(json_bytes(report, pretty=True))
        _write_marker(staging, authority=authority)
        validate_conversion_output(
            active_catalog_path=active_catalog_path,
            trainer_output=trainer_output,
            feature_cache=feature_cache,
            encoder_source_dir=encoder_source_dir,
            output_dir=staging,
        )
        return _commit_owned_directory(
            staging=staging,
            target=target,
            validate_published=lambda published: validate_conversion_output(
                active_catalog_path=active_catalog_path,
                trainer_output=trainer_output,
                feature_cache=feature_cache,
                encoder_source_dir=encoder_source_dir,
                output_dir=published,
            ),
        )
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def preflight_conversion(
    *,
    active_catalog_path: Path,
    trainer_output: Path,
    feature_cache: Path,
    encoder_source_dir: Path,
    electron_path: Path,
) -> Mapping[str, Any]:
    authority = load_conversion_authority(
        active_catalog_path=active_catalog_path,
        trainer_output=trainer_output,
        feature_cache=feature_cache,
        encoder_source_dir=encoder_source_dir,
    )
    _require_onnx_export_dependency()
    try:
        import onnxruntime as ort
        import torch
        import transformers
    except ImportError as error:  # pragma: no cover - environment setup
        raise ConversionError(f"conversion dependency is missing: {error}") from error
    assets = _runtime_asset_paths()
    for label, path in {
        "Electron": electron_path,
        "WASM helper": WASM_HELPER,
        **assets,
    }.items():
        if path.is_symlink() or not path.is_file():
            raise ConversionError(f"{label} is missing or linked: {path}")
    package = _read_json(assets["package"], location="onnxruntime-web package")
    if package.get("version") != runtime.TARGET_ORT_VERSION:
        raise ConversionError("onnxruntime-web version differs from runtime contract")
    return {
        "candidate_count": len(authority.training["candidate_ids"]),
        "checkpoint_sha256": authority.training["checkpoint_sha256"],
        "encoder_revision": authority.contract["encoder"]["revision"],
        "electron_version": _pinned_electron_version(),
        "feature_cache_manifest_sha256": authority.cache_manifest_sha256,
        "onnxruntime_version": ort.__version__,
        "opset": OPSET_VERSION,
        "prototype_count": int(authority.prototype_features.shape[0]),
        "status": "ready_for_offline_onnx_conversion",
        "torch_version": torch.__version__,
        "transformers_version": transformers.__version__,
        "wasm_runtime": f"{runtime.TARGET_ORT_PACKAGE}@{runtime.TARGET_ORT_VERSION}",
    }


def _add_authority_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--active-catalog", type=Path, required=True)
    parser.add_argument("--trainer-output", type=Path, required=True)
    parser.add_argument("--feature-cache", type=Path, required=True)
    parser.add_argument("--encoder-source-dir", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight")
    _add_authority_arguments(preflight)
    preflight.add_argument("--electron", type=Path, default=_default_electron_path())
    build = subparsers.add_parser("build")
    _add_authority_arguments(build)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--electron", type=Path, default=_default_electron_path())
    build.add_argument("--parity-samples", type=int, default=MIN_PARITY_SAMPLES)
    build.add_argument("--encoder-batch-size", type=int, default=2)
    build.add_argument("--ranker-batch-size", type=int, default=16)
    build.add_argument("--parity-seed", type=int, default=20260802)
    build.add_argument("--wasm-timeout-seconds", type=int, default=7200)
    build.add_argument("--replace-owned-output", action="store_true")
    validate = subparsers.add_parser("validate")
    _add_authority_arguments(validate)
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "preflight":
            result = preflight_conversion(
                active_catalog_path=args.active_catalog,
                trainer_output=args.trainer_output,
                feature_cache=args.feature_cache,
                encoder_source_dir=args.encoder_source_dir,
                electron_path=args.electron,
            )
        elif args.command == "build":
            result = build_conversion_output(
                active_catalog_path=args.active_catalog,
                trainer_output=args.trainer_output,
                feature_cache=args.feature_cache,
                encoder_source_dir=args.encoder_source_dir,
                output_dir=args.output_dir,
                electron_path=args.electron,
                parity_samples=args.parity_samples,
                encoder_batch_size=args.encoder_batch_size,
                ranker_batch_size=args.ranker_batch_size,
                parity_seed=args.parity_seed,
                wasm_timeout_seconds=args.wasm_timeout_seconds,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_conversion_output(
                active_catalog_path=args.active_catalog,
                trainer_output=args.trainer_output,
                feature_cache=args.feature_cache,
                encoder_source_dir=args.encoder_source_dir,
                output_dir=args.output_dir,
            )
    except (
        ConversionError,
        runtime.RuntimeArtifactError,
        trainer.TrainerError,
    ) as error:
        print(
            json.dumps({"status": "blocked", "reason": str(error)}, ensure_ascii=False)
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
