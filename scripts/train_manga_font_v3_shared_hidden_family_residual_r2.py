#!/usr/bin/env python3
"""Train the isolated R2 shared-hidden family-residual diagnostic.

R2 starts with a four-cell, training-only experiment over two scalar-head
architectures (`linear` and `mlp8`) and one or two direct passes.  Wider
`mlp16`/`mlp32`/`mlp64` heads are representable as explicitly staged follow-ups,
not members of the crude four-cell grid.  R2 keeps the exact r3h anchor
immutable, uses only the sealed non-direct/base and direct-train rows, disables
page gradients, accumulates each complete phase into a single optimizer step,
records nonselectable post-direct snapshots, and selects only post-base states.
It is QA-only, nonpromotable, and has no application/export contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import train_manga_font_v3_shared_hidden_family_residual_r1 as r1
except ImportError:  # pragma: no cover - direct script execution
    import train_manga_font_v3_shared_hidden_family_residual_r1 as r1


r0 = r1.r0

SCHEMA_VERSION = "manga-font-v3-shared-hidden-family-residual-r2-v1"
OWNER = "carrot-manga-translator/manga-font-v3-shared-hidden-family-residual-r2-v1"
SIDECAR_FILE = "family-margin-residual-r2.safetensors"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-shared-hidden-family-residual-r2-v1-owned.json"
OUTPUT_FILES = frozenset({SIDECAR_FILE, MANIFEST_FILE, MARKER_FILE})

MLP_WIDTHS = (8, 16, 32, 64)
HEAD_ARCHITECTURES = ("linear", *(f"mlp{width}" for width in MLP_WIDTHS))
DIRECT_PASS_CHOICES = (1, 2)
MLP_INITIALIZATION_SEED = 20260820
LOSS_ALGEBRA_ABSOLUTE_TOLERANCE = 1e-6
LOSS_ALGEBRA_RELATIVE_TOLERANCE = 1e-6
PRECOMMITTED_CONFIGURATION = {
    "anchor_kl_weight": 5.0,
    "base_family_ce_weight": 0.35,
    "batch_size": 128,
    "direct_family_ce_weight": 0.10,
    "epochs": 8,
    "evaluation_batch_size": 512,
    "gradient_clip": 1.0,
    "learning_rate": 1e-4,
    "maximum_margin": 1.0,
    "maximum_acceptable_regression": 0.005,
    "maximum_family_regression": 0.0025,
    "maximum_preferred_regression": 0.005,
    "minimum_diagnostic_work_macro_improvement": 0.02,
    "page_body_ce_weight": 0.0,
    "residual_l2_weight": 0.01,
    "seed": 20260820,
    "weight_decay": 0.0,
}
EXPECTED_REAL_COUNTS = r1.EXPECTED_REAL_COUNTS

EXPECTED_AUTHORITY = dict(r1.EXPECTED_AUTHORITY)
EXPECTED_RUNTIME_BOUNDARY = {
    **r1.EXPECTED_RUNTIME_BOUNDARY,
    "training_contract": "r2_accumulated_phase_factorial",
}
EXPECTED_CONFIGURATION_KEYS = frozenset(
    {
        *r1.EXPECTED_CONFIGURATION_KEYS,
        "direct_passes",
        "experiment_cell_id",
        "head_architecture",
    }
)
EXPECTED_MANIFEST_KEYS = frozenset(
    {
        "anchor",
        "architecture",
        "authority",
        "base_dataset",
        "base_metrics",
        "candidate_ids",
        "candidate_score_invariance",
        "configuration",
        "development_diagnostics",
        "diagnostic_worth",
        "direct_family_metrics",
        "experiment_contract",
        "family_override",
        "files",
        "history",
        "objective_contract",
        "overlay",
        "overlay_metrics",
        "partition",
        "phase_diagnostics",
        "record_sha256",
        "record_type",
        "runtime_boundary",
        "schema_version",
        "selection",
        "source_query_head",
        "trainable_parameters",
        "training_seconds",
    }
)
EXPECTED_SELECTION_KEYS = frozenset(
    {
        *r1.EXPECTED_SELECTION_KEYS,
        "base_optimizer_calls_per_epoch",
        "direct_optimizer_calls_per_epoch",
        "post_base_selectable_records",
        "post_direct_diagnostic_records",
        "post_direct_states_selectable",
    }
)
CHECKPOINT_SELECTION_INPUTS = r1.CHECKPOINT_SELECTION_INPUTS
MODEL_SELECTION_LABEL_SOURCES = r1.MODEL_SELECTION_LABEL_SOURCES
SELECTION_KEY_ORDER = r1.SELECTION_KEY_ORDER


class R2TrainingError(ValueError):
    """Raised when the sealed R2 diagnostic contract is violated."""


def canonical_json(value: Any) -> str:
    return r1.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return r1.json_bytes(value, pretty=pretty)


def sha256_file(path: Path) -> str:
    return r1.sha256_file(path)


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    return r1.seal_record(core)


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R2TrainingError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise R2TrainingError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _assert_nested_close(actual: Any, expected: Any, location: str) -> None:
    try:
        r1._assert_nested_close(actual, expected, location)
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    try:
        r1._validate_record_seal(record, location)
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _safe_new_output(path: Path) -> Path:
    try:
        return r1._safe_new_output(path)
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _mlp_width(head_architecture: str) -> int | None:
    if head_architecture == "linear":
        return None
    if head_architecture.startswith("mlp"):
        try:
            width = int(head_architecture.removeprefix("mlp"))
        except ValueError as error:  # pragma: no cover - enum validation owns this
            raise R2TrainingError("head architecture drifted") from error
        if width in MLP_WIDTHS:
            return width
    raise R2TrainingError("head architecture drifted")


def _sidecar_spec(head_architecture: str) -> Mapping[str, tuple[tuple[int, ...], str]]:
    if head_architecture == "linear":
        return {
            "family_margin_head.bias": ((1,), "float32"),
            "family_margin_head.weight": ((1, r0.EXPECTED_HIDDEN_DIM), "float32"),
        }
    width = _mlp_width(head_architecture)
    if width is not None:
        return {
            "family_margin_head.0.bias": ((width,), "float32"),
            "family_margin_head.0.weight": (
                (width, r0.EXPECTED_HIDDEN_DIM),
                "float32",
            ),
            "family_margin_head.2.bias": ((1,), "float32"),
            "family_margin_head.2.weight": ((1, width), "float32"),
        }
    raise R2TrainingError("head architecture drifted")


def _deterministic_feature_weight(width: int) -> np.ndarray:
    count = int(width) * r0.EXPECTED_HIDDEN_DIM
    words: list[np.ndarray] = []
    counter = 0
    filled = 0
    while filled < count:
        digest = hashlib.sha256(
            f"manga-font-r2-feature\0{MLP_INITIALIZATION_SEED + width}\0{counter}".encode()
        ).digest()
        values = np.frombuffer(digest, dtype="<u4").astype(np.uint64)
        words.append(values)
        filled += len(values)
        counter += 1
    integers = np.concatenate(words)[:count]
    unit = (integers.astype(np.float64) + 0.5) / float(2**32)
    scale = math.sqrt(12.0) / math.sqrt(float(r0.EXPECTED_HIDDEN_DIM))
    return (
        ((unit - 0.5) * scale).astype(np.float32).reshape(width, r0.EXPECTED_HIDDEN_DIM)
    )


def build_r2_model(
    torch: Any,
    *,
    anchor_model: Any,
    maximum_margin: float,
    head_architecture: str,
) -> Any:
    if float(maximum_margin) != 1.0:
        raise R2TrainingError("R2 maximum margin must remain 1")
    if len(anchor_model.state_dict()) != r0.EXPECTED_ANCHOR_TENSOR_COUNT:
        raise R2TrainingError("anchor tensor inventory drifted")

    class R2SharedHiddenFamilyResidual(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.anchor_model = anchor_model
            self.anchor_model.requires_grad_(False).eval()
            if head_architecture == "linear":
                head = torch.nn.Linear(r0.EXPECTED_HIDDEN_DIM, 1)
                torch.nn.init.zeros_(head.weight)
                torch.nn.init.zeros_(head.bias)
            elif (width := _mlp_width(head_architecture)) is not None:
                first = torch.nn.Linear(r0.EXPECTED_HIDDEN_DIM, width)
                last = torch.nn.Linear(width, 1)
                initial_weight = _deterministic_feature_weight(width)
                with torch.no_grad():
                    first.weight.copy_(torch.from_numpy(initial_weight))
                    first.bias.zero_()
                    last.weight.zero_()
                    last.bias.zero_()
                head = torch.nn.Sequential(first, torch.nn.GELU(), last)
            else:  # pragma: no cover - option validation owns the enum
                raise R2TrainingError("unsupported head architecture")
            self.family_margin_head = head
            self.maximum_margin = float(maximum_margin)

        def residual_from_hidden(self, hidden: Any) -> Mapping[str, Any]:
            raw = self.family_margin_head(hidden.float()).squeeze(-1)
            margin = r0.bounded_margin(torch, raw, self.maximum_margin)
            adjustment = torch.stack((margin * 0.5, margin * -0.5), dim=-1)
            return {
                "family_logit_adjustment": adjustment,
                "family_margin_delta": margin,
                "family_margin_raw": raw,
            }

        def forward(
            self, query_views: Any, candidate_prototypes: Any
        ) -> Mapping[str, Any]:
            with torch.no_grad():
                anchor_outputs = self.anchor_model(query_views, candidate_prototypes)
                hidden = r0.frozen_shared_hidden(torch, self.anchor_model, query_views)
            residual = self.residual_from_hidden(hidden)
            outputs = dict(anchor_outputs)
            outputs["family_logits"] = (
                anchor_outputs["family_logits"] + residual["family_logit_adjustment"]
            )
            outputs.update(residual)
            return outputs

    return R2SharedHiddenFamilyResidual()


def _sidecar_state(model: Any, head_architecture: str) -> Mapping[str, Any]:
    spec = _sidecar_spec(head_architecture)
    named = dict(model.named_parameters())
    if set(name for name in named if name.startswith("family_margin_head.")) != set(
        spec
    ):
        raise R2TrainingError("sidecar parameter inventory drifted")
    return {
        name: named[name].detach().cpu().float().contiguous().clone()
        for name in sorted(spec)
    }


def _state_payload(
    state: Mapping[str, Any], head_architecture: str
) -> Mapping[str, Any]:
    spec = _sidecar_spec(head_architecture)
    if set(state) != set(spec):
        raise R2TrainingError("sidecar state inventory drifted")
    result: dict[str, Any] = {}
    for name in sorted(spec):
        shape, dtype = spec[name]
        source = np.asarray(state[name].detach().cpu().numpy())
        if tuple(source.shape) != shape or source.dtype != np.dtype(dtype):
            raise R2TrainingError(f"sidecar tensor drifted: {name}")
        array = np.asarray(source, dtype="<f4")
        if (
            tuple(array.shape) != shape
            or str(array.dtype) != dtype
            or not np.isfinite(array).all()
        ):
            raise R2TrainingError(f"sidecar tensor drifted: {name}")
        result[name] = {
            "data_hex_little_endian_float32": array.tobytes(order="C").hex(),
            "dtype": dtype,
            "shape": list(shape),
        }
    return result


def _state_from_payload(
    torch: Any, payload: Mapping[str, Any], head_architecture: str
) -> Mapping[str, Any]:
    spec = _sidecar_spec(head_architecture)
    if set(payload) != set(spec):
        raise R2TrainingError("sidecar payload inventory drifted")
    state: dict[str, Any] = {}
    for name, (shape, dtype) in spec.items():
        descriptor = _mapping(payload[name], f"state payload {name}")
        if set(descriptor) != {
            "data_hex_little_endian_float32",
            "dtype",
            "shape",
        } or (descriptor.get("dtype"), descriptor.get("shape")) != (
            dtype,
            list(shape),
        ):
            raise R2TrainingError(f"state payload descriptor drifted: {name}")
        encoded = descriptor.get("data_hex_little_endian_float32")
        if not isinstance(encoded, str):
            raise R2TrainingError(f"state payload bytes missing: {name}")
        try:
            raw = bytes.fromhex(encoded)
        except ValueError as error:
            raise R2TrainingError(f"state payload bytes invalid: {name}") from error
        if len(raw) != int(np.prod(shape, dtype=np.int64)) * 4:
            raise R2TrainingError(f"state payload size drifted: {name}")
        array = np.frombuffer(raw, dtype="<f4").reshape(shape).copy()
        if not np.isfinite(array).all():
            raise R2TrainingError(f"state payload is non-finite: {name}")
        state[name] = torch.from_numpy(array)
    return state


def _apply_sidecar_state(
    model: Any, state: Mapping[str, Any], head_architecture: str
) -> None:
    spec = _sidecar_spec(head_architecture)
    if set(state) != set(spec):
        raise R2TrainingError("sidecar state inventory drifted")
    parameters = dict(model.named_parameters())
    for name in spec:
        target = parameters[name]
        value = state[name]
        if (
            tuple(target.shape) != tuple(value.shape)
            or target.dtype != value.dtype
            or str(value.dtype) != "torch.float32"
        ):
            raise R2TrainingError(f"sidecar state shape drifted: {name}")
        target.data.copy_(value.to(device=target.device, dtype=target.dtype))


def _load_sidecar_state(
    torch: Any, path: Path, head_architecture: str
) -> Mapping[str, Any]:
    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R2TrainingError("safetensors is required") from error
    try:
        arrays = load_file(str(path))
    except Exception as error:
        raise R2TrainingError("sidecar checkpoint is invalid") from error
    spec = _sidecar_spec(head_architecture)
    if set(arrays) != set(spec):
        raise R2TrainingError("sidecar checkpoint tensor inventory drifted")
    payload: dict[str, Any] = {}
    for name, value in arrays.items():
        array = np.asarray(value)
        expected_shape, expected_dtype = spec[name]
        if tuple(array.shape) != expected_shape or array.dtype != np.dtype(
            expected_dtype
        ):
            raise R2TrainingError(f"sidecar checkpoint tensor drifted: {name}")
        payload[name] = {
            "data_hex_little_endian_float32": np.asarray(array, dtype="<f4")
            .tobytes(order="C")
            .hex(),
            "dtype": expected_dtype,
            "shape": list(expected_shape),
        }
    return _state_from_payload(
        torch,
        payload,
        head_architecture,
    )


def _validate_options(args: argparse.Namespace) -> None:
    try:
        r1._validate_options(args)
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error
    if args.head_architecture not in HEAD_ARCHITECTURES:
        raise R2TrainingError("head architecture drifted")
    if getattr(args, "device", None) not in {"cpu", "cuda"}:
        raise R2TrainingError("device must be cpu or cuda")
    if (
        isinstance(args.direct_passes, bool)
        or not isinstance(args.direct_passes, int)
        or args.direct_passes not in DIRECT_PASS_CHOICES
    ):
        raise R2TrainingError("direct passes must be exactly 1 or 2")
    if args.base_supervision_mode != "non_direct_preservation":
        raise R2TrainingError("R2 requires non_direct_preservation")
    if args.direct_balance_mode != "work_family":
        raise R2TrainingError("R2 requires work_family direct balancing")
    if float(args.page_body_ce_weight) != 0.0:
        raise R2TrainingError("R2 page gradients must remain disabled")
    if float(args.maximum_margin) != 1.0:
        raise R2TrainingError("R2 maximum margin must remain 1")
    expected_cell = f"r2-{args.head_architecture}-direct-pass-{args.direct_passes}"
    if hasattr(args, "experiment_cell_id") and args.experiment_cell_id != expected_cell:
        raise R2TrainingError("R2 experiment cell ID drifted")
    for name, expected in PRECOMMITTED_CONFIGURATION.items():
        actual = getattr(args, name)
        if isinstance(expected, int):
            if (
                isinstance(actual, bool)
                or not isinstance(actual, int)
                or actual != expected
            ):
                raise R2TrainingError(f"R2 precommitted option drifted: {name}")
        elif (
            isinstance(actual, bool)
            or not isinstance(actual, (int, float))
            or not math.isfinite(float(actual))
            or float(actual) != expected
        ):
            raise R2TrainingError(f"R2 precommitted option drifted: {name}")


def _load_context(args: argparse.Namespace, torch: Any) -> Mapping[str, Any]:
    try:
        return r1._load_context(args, torch)
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _build_partition(
    context: Mapping[str, Any], args: argparse.Namespace, *, enforce_real: bool = True
) -> Mapping[str, Any]:
    try:
        return r1._build_training_partition(
            context, args, enforce_expected_counts=enforce_real
        )
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _tensor_inventory(state: Mapping[str, Any]) -> Mapping[str, Any]:
    return r0._tensor_inventory(state)


def _payload_sha256(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def _initial_state_contract(model: Any, head_architecture: str) -> Mapping[str, Any]:
    state = _sidecar_state(model, head_architecture)
    payload = _state_payload(state, head_architecture)
    final_names = (
        ("family_margin_head.bias", "family_margin_head.weight")
        if head_architecture == "linear"
        else ("family_margin_head.2.bias", "family_margin_head.2.weight")
    )
    final_is_zero = all(
        not bool(np.count_nonzero(state[name].detach().cpu().numpy()))
        for name in final_names
    )
    return {
        "deterministic_initial_state_sha256": _payload_sha256(payload),
        "final_projection_exact_zero": final_is_zero,
        "initialization_seed": (
            None
            if head_architecture == "linear"
            else MLP_INITIALIZATION_SEED + int(_mlp_width(head_architecture) or 0)
        ),
        "initialization_source": (
            "exact_zero_linear"
            if head_architecture == "linear"
            else "sha256_counter_fan_in_uniform_bound_sqrt3_over_sqrt64_first_projection_and_exact_zero_final_projection"
        ),
        "tensor_inventory": _tensor_inventory(state),
    }


def _architecture_contract(
    model: Any, *, head_architecture: str, maximum_margin: float
) -> Mapping[str, Any]:
    width = _mlp_width(head_architecture)
    trainable_count = sum(
        parameter.numel() for parameter in model.family_margin_head.parameters()
    )
    added_macs = (
        r0.EXPECTED_HIDDEN_DIM
        if width is None
        else r0.EXPECTED_HIDDEN_DIM * width + width
    )
    production_parameters = 74_528
    production_macs = 91_776
    return {
        "anchor_tensor_count": r0.EXPECTED_ANCHOR_TENSOR_COUNT,
        "cpu_benchmark_completed": False,
        "cpu_single_thread_full_runtime_relative_budget": 1.5,
        "fused_hidden_estimate_not_a_runtime_benchmark": {
            "additional_multiply_accumulates_per_row": int(added_macs),
            "additional_parameters": int(trainable_count),
            "baseline_multiply_accumulates_per_row": production_macs,
            "baseline_parameters": production_parameters,
            "estimated_multiply_accumulate_ratio": float(
                (production_macs + added_macs) / production_macs
            ),
            "estimated_parameter_ratio": float(
                (production_parameters + trainable_count) / production_parameters
            ),
            "hidden64_must_be_fused_not_recomputed": True,
            "within_static_1_5x_parameter_and_mac_budget": bool(
                production_parameters + trainable_count <= 111_792
                and production_macs + added_macs <= 137_664
            ),
        },
        "cpu_single_thread_full_runtime_benchmark_required_before_promotion": True,
        "family_logit_adjustment": "+margin/2 body, -margin/2 variant",
        "family_margin_formula": "B*tanh(raw_margin/B)",
        "head_architecture": head_architecture,
        "head_formula": (
            "Linear64x1"
            if width is None
            else f"Linear64x{width}_GELU_approximate_none_Linear{width}x1"
        ),
        "head_first_optimizer_step_zero_output_mlp_feature_gradient": (
            width is not None
        ),
        "head_hidden_width": width,
        "hidden_dimension": r0.EXPECTED_HIDDEN_DIM,
        "hidden_source": "frozen_sample_candidate_norm_then_Linear1024x64_then_GELU",
        "initial_state": _initial_state_contract(model, head_architecture),
        "maximum_margin": float(maximum_margin),
        "sidecar_parameter_count": int(trainable_count),
        "sidecar_tensor_count": len(_sidecar_spec(head_architecture)),
        "zero_output_initialization_exact_anchor": True,
    }


def _trainable_contract(model: Any, head_architecture: str) -> Mapping[str, Any]:
    spec = _sidecar_spec(head_architecture)
    trainable_names = sorted(
        name for name, parameter in model.named_parameters() if parameter.requires_grad
    )
    if trainable_names != sorted(spec):
        raise R2TrainingError("trainable parameter inventory drifted")
    return {
        "anchor_parameter_count": sum(
            value.numel() for value in model.anchor_model.parameters()
        ),
        "anchor_parameter_names": sorted(
            name for name, _value in model.anchor_model.named_parameters()
        ),
        "anchor_parameters_frozen": True,
        "sidecar_parameter_count": sum(
            value.numel() for value in model.family_margin_head.parameters()
        ),
        "sidecar_parameter_names": sorted(spec),
    }


def _configuration(args: argparse.Namespace) -> Mapping[str, Any]:
    configuration = dict(r1._configuration(args))
    configuration.update(
        {
            "direct_passes": int(args.direct_passes),
            "experiment_cell_id": (
                f"r2-{args.head_architecture}-direct-pass-{args.direct_passes}"
            ),
            "head_architecture": str(args.head_architecture),
        }
    )
    return configuration


def _candidate_invariance(cache: Mapping[str, Any]) -> Mapping[str, Any]:
    return r1._candidate_invariance(cache)


def _base_class_balance(
    partition: Mapping[str, Any],
) -> tuple[np.ndarray, float, Mapping[str, Any]]:
    indices = np.asarray(partition["base_indices"], dtype=np.int64)
    labels = np.asarray(partition["base_labels"][indices], dtype=np.int64)
    weights = np.asarray(partition["base_weights"][indices], dtype=np.float32)
    if (
        not len(indices)
        or len(set(int(value) for value in indices)) != len(indices)
        or labels.shape != indices.shape
        or weights.shape != indices.shape
        or not np.isfinite(weights).all()
        or bool((weights <= 0).any())
        or set(labels.tolist())
        != {
            r0.v8.BODY_FAMILY_INDEX,
            r0.v8.VARIANT_FAMILY_INDEX,
        }
    ):
        raise R2TrainingError("base preservation inventory drifted")
    weighted_counts = np.bincount(labels, weights=weights, minlength=2).astype(
        np.float32
    )
    class_weights = (
        np.sum(weighted_counts, dtype=np.float32)
        / np.maximum(weighted_counts, np.float32(1.0))
    ).astype(np.float32)
    class_weights = (class_weights / np.mean(class_weights, dtype=np.float32)).astype(
        np.float32
    )
    source_weight_denominator = float(np.sum(weighted_counts, dtype=np.float32))
    if (
        not np.isfinite(class_weights).all()
        or bool((class_weights <= 0).any())
        or not math.isfinite(source_weight_denominator)
        or source_weight_denominator <= 0
    ):
        raise R2TrainingError("base class balance drifted")
    digest = hashlib.sha256()
    for index, label, source_weight in zip(indices, labels, weights, strict=True):
        digest.update(np.asarray(index, dtype="<i8").tobytes())
        digest.update(np.asarray(label, dtype="<i8").tobytes())
        digest.update(np.asarray(source_weight, dtype="<f4").tobytes())
    contract = {
        "class_weight_f32_hex": [
            np.asarray(value, dtype="<f4").tobytes().hex() for value in class_weights
        ],
        "class_weight_formula": "global_weighted_count_inverse_then_mean_one",
        "family_label_source": "original_r3_non_direct_targets",
        "fixed_family_ce_denominator": source_weight_denominator,
        "fixed_family_ce_denominator_f64_hex": np.asarray(
            source_weight_denominator, dtype="<f8"
        )
        .tobytes()
        .hex(),
        "fixed_kl_denominator_rows": int(len(indices)),
        "fixed_residual_l2_denominator_rows": int(len(indices)),
        "row_count": int(len(indices)),
        "target_weight_inventory_sha256": digest.hexdigest(),
        "weighted_family_counts": [float(value) for value in weighted_counts],
        "weighted_family_count_f32_hex": [
            np.asarray(value, dtype="<f4").tobytes().hex() for value in weighted_counts
        ],
    }
    return class_weights, source_weight_denominator, contract


def _base_batches(
    partition: Mapping[str, Any], args: argparse.Namespace, *, epoch: int
) -> tuple[Sequence[np.ndarray], Mapping[str, Any]]:
    seed = int(args.seed) + int(epoch) * 10_003 + 1
    batches = tuple(
        r0._batches(
            partition["base_indices"], batch_size=int(args.batch_size), seed=seed
        )
    )
    ordered = np.concatenate(batches).astype(np.int64, copy=False)
    expected = np.asarray(partition["base_indices"], dtype=np.int64)
    if (
        len(ordered) != len(expected)
        or len(set(int(value) for value in ordered)) != len(expected)
        or set(int(value) for value in ordered) != set(int(value) for value in expected)
    ):
        raise R2TrainingError("base schedule is not an exact unique partition")
    contract = {
        "algorithm": "deterministic_unique_shuffle_global_fixed_denominator_v1",
        "batch_count": len(batches),
        "batch_sizes": [int(len(batch)) for batch in batches],
        "optimizer_calls": 1,
        "ordered_base_row_index_sha256": r1._index_sha256(ordered),
        "schedule_seed": seed,
        "unique_rows": int(len(ordered)),
    }
    return batches, contract


def _direct_pass_batches(
    partition: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    epoch: int,
    pass_index: int,
) -> tuple[Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]], Mapping[str, Any]]:
    if pass_index < 1 or pass_index > int(args.direct_passes):
        raise R2TrainingError("direct pass index drifted")
    seed = int(args.seed) + int(epoch) * 100_003 + pass_index * 10_003 + 2
    indices = partition["direct_indices"]
    labels = partition["direct_labels"]
    weights = partition["direct_weights"]
    work_ids = partition["direct_work_ids"]
    position_batches, normalized, contract = r1._direct_balanced_schedule(
        indices,
        work_ids,
        labels,
        weights,
        balance_mode="work_family",
        batch_size=int(args.batch_size),
        seed=seed,
    )
    batches = tuple(
        (indices[positions], labels[positions], normalized[positions])
        for positions in position_batches
    )
    row_digest = hashlib.sha256()
    for batch in batches:
        row_digest.update(batch[0].astype("<i8", copy=False).tobytes(order="C"))
    schedule = {
        **contract,
        "direct_pass_index": int(pass_index),
        "ordered_base_row_index_sha256": row_digest.hexdigest(),
    }
    return batches, schedule


def _objective_contract(
    args: argparse.Namespace, partition: Mapping[str, Any]
) -> Mapping[str, Any]:
    _class_weights, _denominator, balance = _base_class_balance(partition)
    return {
        "anchor_kl_scope": "base_only",
        "base_accumulation": "all_batches_backward_accumulated_then_one_optimizer_step",
        "base_anchor_kl_rows": int(len(partition["base_indices"])),
        "base_class_balance": balance,
        "base_family_ce_mode": "global_class_balanced_original_r3_non_direct",
        "base_optimizer_calls_per_epoch": 1,
        "base_phase_is_last": True,
        "base_supervision_mode": "non_direct_preservation",
        "candidate_score_parameters_frozen": True,
        "direct_anchor_kl_weight": 0.0,
        "direct_balance_mode": "work_family",
        "direct_family_ce_reduction": "fixed_epoch_work_family_stratum_denominator",
        "direct_optimizer_calls_per_epoch": int(args.direct_passes),
        "direct_passes": int(args.direct_passes),
        "direct_row_multiplicity_per_epoch": int(args.direct_passes),
        "direct_total_effective_rows_per_epoch": int(
            len(partition["direct_indices"]) * args.direct_passes
        ),
        "direct_unique_rows_per_pass": int(len(partition["direct_indices"])),
        "direct_weighted_surrogate_claim": (
            "sealed_weight_divided_by_stratum_weight_sum_then_divided_by_20"
        ),
        "optimizer_phase_order": [
            *(
                f"direct_family_pass_{index}"
                for index in range(1, args.direct_passes + 1)
            ),
            "base_preservation",
        ],
        "page_anchor_kl_weight": 0.0,
        "page_diagnostic_groups": int(partition["contract"]["page_groups"]),
        "page_diagnostic_rows": int(len(partition["page_indices"])),
        "page_optimizer_calls_per_epoch": 0,
        "page_zero_weight_behavior": "metric_only_no_schedule_no_backward_no_optimizer_step",
        "partition_record_sha256": hashlib.sha256(
            canonical_json(partition["contract"]).encode("utf-8")
        ).hexdigest(),
        "post_direct_state": "diagnostic_only_never_selectable",
        "post_base_state": "only_nonzero_epoch_selectable_boundary",
        "residual_l2_scope": "each_executed_direct_and_base_accumulated_step",
        "sealed_loss_algebra_validation": {
            "absolute_tolerance": LOSS_ALGEBRA_ABSOLUTE_TOLERANCE,
            "base_total_formula": "base_family_ce_weight*family_ce+anchor_kl_weight*anchor_kl+residual_l2_weight*residual_l2",
            "direct_total_formula": "direct_family_ce_weight*family_ce+residual_l2_weight*residual_l2",
            "relative_tolerance": LOSS_ALGEBRA_RELATIVE_TOLERANCE,
        },
        "trajectory_phase_transcript_authority": "sealed_producer_attestation_only",
        "trajectory_replayed_by_strict_validator": False,
    }


def _experiment_contract() -> Mapping[str, Any]:
    return {
        "application_integration_allowed": False,
        "cpu_benchmark": {
            "budget_relative_to_current_full_font_runtime": 1.5,
            "completed": False,
            "scope": "single_thread_full_font_runtime_not_sidecar_only",
            "required_before_any_promotion": True,
        },
        "initial_crude_grid": {
            "direct_passes": [1, 2],
            "head_architectures": ["linear", "mlp8"],
        },
        "larger_widths_are_staged_not_precommitted_winners": [
            "mlp16",
            "mlp32",
            "mlp64",
        ],
        "page_replay_performed": False,
        "promotion_authority": False,
        "real_cpu_benchmark_result": None,
        "work_level_cross_validation": {
            "completed": False,
            "final_seed_count": 5,
            "initial_seed_count": 3,
            "logo_or_equivalent_work_disjoint_folds_required": True,
            "smaller_architecture_wins_exact_ties": True,
            "variant_gate_required_per_fold": True,
        },
    }


def _base_accumulated_optimization_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    partition: Mapping[str, Any],
    batches: Sequence[np.ndarray],
    class_weights: np.ndarray,
    source_weight_denominator: float,
    family_ce_weight: float,
    anchor_kl_weight: float,
    residual_l2_weight: float,
    gradient_clip: float,
) -> Mapping[str, float]:
    expected_rows = int(len(partition["base_indices"]))
    if (
        not batches
        or sum(len(batch) for batch in batches) != expected_rows
        or tuple(class_weights.shape) != (2,)
        or not math.isfinite(float(source_weight_denominator))
        or float(source_weight_denominator) <= 0
    ):
        raise R2TrainingError("base accumulated objective inventory drifted")
    device = cache["hidden"].device
    class_weight_tensor = torch.from_numpy(
        np.asarray(class_weights, dtype=np.float32)
    ).to(device)
    optimizer.zero_grad(set_to_none=True)
    totals = {"anchor_kl": 0.0, "family_ce": 0.0, "residual_l2": 0.0, "total": 0.0}
    for indices in batches:
        outputs = r0._head_outputs_for_indices(torch, model, cache, indices)
        labels = torch.from_numpy(
            partition["base_labels"][indices].astype(np.int64, copy=False)
        ).to(device)
        weights = torch.from_numpy(
            partition["base_weights"][indices].astype(np.float32, copy=False)
        ).to(device)
        per_row_ce = torch.nn.functional.cross_entropy(
            outputs["family_logits"].float(),
            labels,
            weight=class_weight_tensor,
            reduction="none",
        )
        family_ce = (per_row_ce * weights).sum() / float(source_weight_denominator)
        anchor_probability = torch.softmax(
            outputs["anchor_family_logits"].float(), dim=1
        )
        per_row_kl = (
            anchor_probability
            * (
                torch.log_softmax(outputs["anchor_family_logits"].float(), dim=1)
                - torch.log_softmax(outputs["family_logits"].float(), dim=1)
            )
        ).sum(dim=1)
        anchor_kl = per_row_kl.sum() / float(expected_rows)
        residual_l2 = outputs["family_margin_delta"].float().square().sum() / float(
            expected_rows
        )
        loss = (
            float(family_ce_weight) * family_ce
            + float(anchor_kl_weight) * anchor_kl
            + float(residual_l2_weight) * residual_l2
        )
        if not bool(torch.isfinite(loss)):
            raise R2TrainingError("base accumulated loss became non-finite")
        loss.backward()
        values = {
            "anchor_kl": anchor_kl,
            "family_ce": family_ce,
            "residual_l2": residual_l2,
            "total": loss,
        }
        for name, value in values.items():
            totals[name] += float(value.detach().item())
    torch.nn.utils.clip_grad_norm_(
        tuple(model.family_margin_head.parameters()), float(gradient_clip)
    )
    optimizer.step()
    return totals


def _direct_accumulated_optimization_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    batches: Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]],
    fixed_denominator: int,
    family_ce_weight: float,
    residual_l2_weight: float,
    gradient_clip: float,
) -> Mapping[str, float]:
    try:
        return r1._direct_accumulated_optimization_step(
            torch,
            model,
            optimizer,
            cache=cache,
            batches=batches,
            fixed_denominator=fixed_denominator,
            family_ce_weight=family_ce_weight,
            residual_l2_weight=residual_l2_weight,
            gradient_clip=gradient_clip,
        )
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _zero_consumption() -> Mapping[str, Any]:
    return {
        "anchor_kl_base_rows": 0,
        "base_batches": 0,
        "base_optimizer_calls": 0,
        "base_rows": 0,
        "base_schedule": None,
        "development_eval_rows": 0,
        "direct_batches_per_pass": [],
        "direct_optimizer_calls": 0,
        "direct_passes_completed": 0,
        "direct_rows_per_pass": [],
        "direct_schedules": [],
        "optimizer_phase_order_completed": [],
        "page_batches": 0,
        "page_optimizer_calls": 0,
        "page_rows": 0,
        "page_schedule": None,
    }


def _epoch_consumption(
    partition: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    epoch: int,
    boundary: str,
    completed_direct_passes: int | None = None,
) -> Mapping[str, Any]:
    if epoch == 0:
        if boundary != "anchor_initialization":
            raise R2TrainingError("epoch zero boundary drifted")
        return _zero_consumption()
    if boundary not in {"after_direct_family", "after_base_preservation"}:
        raise R2TrainingError("epoch boundary drifted")
    expected_completed = (
        int(args.direct_passes)
        if boundary == "after_base_preservation"
        else completed_direct_passes
    )
    if (
        isinstance(expected_completed, bool)
        or not isinstance(expected_completed, int)
        or expected_completed < 1
        or expected_completed > int(args.direct_passes)
    ):
        raise R2TrainingError("completed direct pass count drifted")
    direct_schedules: list[Mapping[str, Any]] = []
    direct_batches_per_pass: list[int] = []
    direct_rows_per_pass: list[int] = []
    for pass_index in range(1, expected_completed + 1):
        batches, schedule = _direct_pass_batches(
            partition, args, epoch=epoch, pass_index=pass_index
        )
        direct_schedules.append(schedule)
        direct_batches_per_pass.append(len(batches))
        direct_rows_per_pass.append(sum(len(batch[0]) for batch in batches))
    phase_order = [
        f"direct_family_pass_{pass_index}"
        for pass_index in range(1, expected_completed + 1)
    ]
    result = {
        "anchor_kl_base_rows": 0,
        "base_batches": 0,
        "base_optimizer_calls": 0,
        "base_rows": 0,
        "base_schedule": None,
        "development_eval_rows": 0,
        "direct_batches_per_pass": direct_batches_per_pass,
        "direct_optimizer_calls": int(expected_completed),
        "direct_passes_completed": int(expected_completed),
        "direct_rows_per_pass": direct_rows_per_pass,
        "direct_schedules": direct_schedules,
        "optimizer_phase_order_completed": phase_order,
        "page_batches": 0,
        "page_optimizer_calls": 0,
        "page_rows": 0,
        "page_schedule": None,
    }
    if boundary == "after_base_preservation":
        batches, schedule = _base_batches(partition, args, epoch=epoch)
        result.update(
            {
                "anchor_kl_base_rows": int(len(partition["base_indices"])),
                "base_batches": len(batches),
                "base_optimizer_calls": 1,
                "base_rows": sum(len(batch) for batch in batches),
                "base_schedule": schedule,
                "optimizer_phase_order_completed": [
                    *phase_order,
                    "base_preservation",
                ],
            }
        )
    return result


def _diagnostic_checks(
    *,
    anchor_train: Mapping[str, Any],
    candidate_train: Mapping[str, Any],
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    minimum_improvement: float,
    candidate_outputs_exact: bool,
) -> Mapping[str, bool]:
    try:
        return r1._diagnostic_checks(
            anchor_train=anchor_train,
            candidate_train=candidate_train,
            base_metrics=base_metrics,
            base_regression=base_regression,
            minimum_improvement=minimum_improvement,
            candidate_outputs_exact=candidate_outputs_exact,
        )
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _selection_key(
    *,
    epoch: int,
    diagnostic_passed: bool,
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    train_metrics: Mapping[str, Any],
) -> tuple[float, ...]:
    try:
        return r1._selection_key(
            epoch=epoch,
            diagnostic_passed=diagnostic_passed,
            base_metrics=base_metrics,
            base_regression=base_regression,
            train_metrics=train_metrics,
        )
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _snapshot_record(
    torch: Any,
    model: Any,
    *,
    epoch: int,
    phase_boundary: str,
    selectable: bool,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
    anchor_base_metrics: Mapping[str, Any],
    anchor_train_metrics: Mapping[str, Any] | None,
    args: argparse.Namespace,
    losses: Mapping[str, Any] | None,
    batch_consumption: Mapping[str, Any],
) -> Mapping[str, Any]:
    base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    train_metrics = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    reference = train_metrics if anchor_train_metrics is None else anchor_train_metrics
    checks = _diagnostic_checks(
        anchor_train=reference,
        candidate_train=train_metrics,
        base_metrics=base_metrics,
        base_regression=regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        candidate_outputs_exact=True,
    )
    state_payload = _state_payload(
        _sidecar_state(model, args.head_architecture), args.head_architecture
    )
    record: dict[str, Any] = {
        "base_metrics": base_metrics,
        "base_no_material_regression": all(regression.values()),
        "base_regression_checks": regression,
        "batch_consumption": dict(batch_consumption),
        "candidate_outputs_exact_anchor": True,
        "checkpoint_selection_inputs": (
            list(CHECKPOINT_SELECTION_INPUTS) if selectable else []
        ),
        "development_eval_consulted": False,
        "diagnostic_checks": checks,
        "diagnostic_gate_passed": all(checks.values()),
        "diagnostic_worth_passed": bool(
            epoch > 0 and selectable and all(checks.values())
        ),
        "epoch": int(epoch),
        "phase_boundary": phase_boundary,
        "selectable_for_checkpoint": bool(selectable),
        "sidecar_state": state_payload,
        "sidecar_state_sha256": _payload_sha256(state_payload),
        "subgroup_margin_flip_diagnostics": r1._subgroup_margin_flip_diagnostics(
            torch,
            model,
            cache=cache,
            context=context,
            partition=partition,
        ),
        "training_only_selection_metrics": train_metrics,
    }
    if losses is not None:
        record["phase_losses"] = dict(losses)
    return record


def _metric_delta(
    candidate: Mapping[str, Any], anchor: Mapping[str, Any], key: str
) -> float:
    return float(candidate[key]) - float(anchor[key])


def _retention_ratio(post_delta: float, pre_delta: float) -> float | None:
    if abs(pre_delta) <= 1e-12:
        return None
    return float(post_delta / pre_delta)


def _phase_comparison(
    *,
    epoch: int,
    anchor_record: Mapping[str, Any],
    post_direct: Mapping[str, Any],
    post_base: Mapping[str, Any],
    minimum_improvement: float,
) -> Mapping[str, Any]:
    anchor_work = anchor_record["training_only_selection_metrics"]["direct_family"][
        "work_macro"
    ]
    direct_work = post_direct["training_only_selection_metrics"]["direct_family"][
        "work_macro"
    ]
    base_work = post_base["training_only_selection_metrics"]["direct_family"][
        "work_macro"
    ]
    pre_balanced = _metric_delta(direct_work, anchor_work, "balanced_accuracy")
    pre_body = _metric_delta(direct_work, anchor_work, "body_accuracy")
    post_balanced = _metric_delta(base_work, anchor_work, "balanced_accuracy")
    post_body = _metric_delta(base_work, anchor_work, "body_accuracy")
    pre_target_gate = (
        pre_balanced >= minimum_improvement and pre_body >= minimum_improvement
    )
    post_target_gate = (
        post_balanced >= minimum_improvement and post_body >= minimum_improvement
    )
    pre_full_gate = bool(post_direct["diagnostic_gate_passed"])
    post_full_gate = bool(post_base["diagnostic_gate_passed"])
    if pre_full_gate and post_full_gate:
        classification = "full_hard_gate_capable_and_retained"
    elif pre_full_gate:
        classification = "full_hard_gate_capable_then_gate_destroyed"
    else:
        classification = "not_full_hard_gate_capable_post_direct_at_this_epoch"
    if pre_target_gate and post_target_gate:
        target_classification = "body_balanced_target_capable_and_retained"
    elif pre_target_gate:
        target_classification = "body_balanced_target_capable_then_destroyed"
    else:
        target_classification = "not_body_balanced_target_capable_post_direct"
    return {
        "body_balanced_target_classification": target_classification,
        "classification": classification,
        "epoch": int(epoch),
        "body_balanced_target_fully_erased": bool(
            pre_target_gate and post_balanced <= 0.0 and post_body <= 0.0
        ),
        "full_hard_gate": {
            "post_base": post_full_gate,
            "post_direct": pre_full_gate,
        },
        "post_base_delta_from_anchor": {
            "balanced_accuracy": post_balanced,
            "body_accuracy": post_body,
            "variant_accuracy": _metric_delta(
                base_work, anchor_work, "variant_accuracy"
            ),
        },
        "post_direct_delta_from_anchor": {
            "balanced_accuracy": pre_balanced,
            "body_accuracy": pre_body,
            "variant_accuracy": _metric_delta(
                direct_work, anchor_work, "variant_accuracy"
            ),
        },
        "post_direct_minus_post_base_erosion": {
            "balanced_accuracy": pre_balanced - post_balanced,
            "body_accuracy": pre_body - post_body,
        },
        "retention_ratio": {
            "balanced_accuracy": _retention_ratio(post_balanced, pre_balanced),
            "body_accuracy": _retention_ratio(post_body, pre_body),
        },
    }


def _selection_contract(
    *,
    selected_epoch: int,
    partition: Mapping[str, Any],
    args: argparse.Namespace,
) -> Mapping[str, Any]:
    return {
        "anchor_fallback_selected": selected_epoch == 0,
        "base_gradient_rows": int(len(partition["base_indices"])),
        "base_optimizer_calls_per_epoch": 1,
        "best_epoch": int(selected_epoch),
        "development_eval_consulted_during_checkpoint_selection": False,
        "development_eval_gradient_rows": 0,
        "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
        "direct_family_gradient_rows": int(len(partition["direct_indices"])),
        "direct_optimizer_calls_per_epoch": int(args.direct_passes),
        "hard_diagnostic_gate_required_for_nonzero_epoch": True,
        "model_selection_label_sources": list(MODEL_SELECTION_LABEL_SOURCES),
        "page_consistency_gradient_groups": 0,
        "page_consistency_gradient_rows": 0,
        "page_consistency_metric_groups": int(partition["contract"]["page_groups"]),
        "page_consistency_metric_rows": int(len(partition["page_indices"])),
        "post_base_selectable_records": int(args.epochs),
        "post_direct_diagnostic_records": int(args.epochs * args.direct_passes),
        "post_direct_states_selectable": False,
        "selectable_state_boundary": "after_base_preservation_only",
        "selection_key_order": list(SELECTION_KEY_ORDER),
    }


def _assert_zero_output_anchor(
    torch: Any, model: Any, cache: Mapping[str, Any]
) -> None:
    all_rows = np.arange(cache["hidden"].shape[0], dtype=np.int64)
    outputs = r0._family_outputs_from_cache(model, cache, all_rows)
    if not torch.equal(outputs["family_logits"], cache["family_logits"]):
        raise R2TrainingError("zero-output initialization is not exact anchor")
    if float(outputs["family_margin_delta"].abs().max().item()) != 0.0:
        raise R2TrainingError("zero-output margin is not exact zero")


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R2TrainingError("PyTorch is required") from error
    _validate_options(args)
    context = _load_context(args, torch)
    partition = _build_partition(context, args)
    model = build_r2_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        head_architecture=args.head_architecture,
    ).cpu()
    cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
    )
    _assert_zero_output_anchor(torch, model, cache)
    anchor_inventory = r0._anchor_tensor_inventory(model.anchor_model)
    consumption = _epoch_consumption(
        partition,
        args,
        epoch=1,
        boundary="after_base_preservation",
    )
    return {
        "anchor_tensor_count": len(context["model"].state_dict()),
        "anchor_tensor_inventory": anchor_inventory,
        "architecture": _architecture_contract(
            model,
            head_architecture=args.head_architecture,
            maximum_margin=args.maximum_margin,
        ),
        "base_row_count": int(len(context["arrays"]["split"])),
        "candidate_score_invariance": _candidate_invariance(cache),
        "configuration": _configuration(args),
        "context": r0._context_contract(context, args),
        "epoch1_batch_consumption": consumption,
        "experiment_contract": _experiment_contract(),
        "family_override": partition["family_override"],
        "objective_contract": _objective_contract(args, partition),
        "partition": partition["contract"],
        "status": "ready_for_isolated_r2_accumulated_phase_training",
        "trainable_parameters": _trainable_contract(model, args.head_architecture),
        "zero_output_initialization_exact_anchor": True,
    }


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R2TrainingError("PyTorch and safetensors are required") from error
    _validate_options(args)
    output = _safe_new_output(args.output_dir)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise R2TrainingError("CUDA was requested but is unavailable")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)

    started = time.monotonic()
    context = _load_context(args, torch)
    partition = _build_partition(context, args)
    candidate_ids = tuple(context["candidate_ids"])
    model = build_r2_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        head_architecture=args.head_architecture,
    ).cpu()
    architecture = _architecture_contract(
        model,
        head_architecture=args.head_architecture,
        maximum_margin=args.maximum_margin,
    )
    trainable = _trainable_contract(model, args.head_architecture)
    anchor_tensor_inventory = r0._anchor_tensor_inventory(model.anchor_model)
    cpu_cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
    )
    _assert_zero_output_anchor(torch, model, cpu_cache)
    candidate_invariance = _candidate_invariance(cpu_cache)
    model.to(device)
    cache = {
        name: value.to(device) if device.type != "cpu" else value
        for name, value in cpu_cache.items()
    }
    optimizer = torch.optim.AdamW(
        tuple(model.family_margin_head.parameters()),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    class_weights, source_weight_denominator, _balance = _base_class_balance(partition)
    anchor_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    epoch0 = _snapshot_record(
        torch,
        model,
        epoch=0,
        phase_boundary="anchor_initialization",
        selectable=True,
        cache=cache,
        context=context,
        partition=partition,
        candidate_ids=candidate_ids,
        anchor_base_metrics=anchor_base_metrics,
        anchor_train_metrics=None,
        args=args,
        losses=None,
        batch_consumption=_zero_consumption(),
    )
    anchor_train_metrics = epoch0["training_only_selection_metrics"]
    initial_state = _sidecar_state(model, args.head_architecture)
    initial_payload = _state_payload(initial_state, args.head_architecture)
    if (
        _payload_sha256(initial_payload)
        != architecture["initial_state"]["deterministic_initial_state_sha256"]
    ):
        raise R2TrainingError("initial state contract drifted before training")
    history: list[Mapping[str, Any]] = [epoch0]
    phase_diagnostics: list[Mapping[str, Any]] = []
    best_record = epoch0
    best_state = initial_state
    best_key = _selection_key(
        epoch=0,
        diagnostic_passed=False,
        base_metrics=epoch0["base_metrics"],
        base_regression=epoch0["base_regression_checks"],
        train_metrics=anchor_train_metrics,
    )

    for epoch in range(1, args.epochs + 1):
        model.train()
        model.anchor_model.eval()
        direct_losses: list[Mapping[str, float]] = []
        post_direct_record: Mapping[str, Any] | None = None
        for pass_index in range(1, args.direct_passes + 1):
            direct_batches, direct_schedule = _direct_pass_batches(
                partition,
                args,
                epoch=epoch,
                pass_index=pass_index,
            )
            direct_losses.append(
                _direct_accumulated_optimization_step(
                    torch,
                    model,
                    optimizer,
                    cache=cache,
                    batches=direct_batches,
                    fixed_denominator=int(direct_schedule["loss_denominator"]),
                    family_ce_weight=args.direct_family_ce_weight,
                    residual_l2_weight=args.residual_l2_weight,
                    gradient_clip=args.gradient_clip,
                )
            )
            post_direct_record = _snapshot_record(
                torch,
                model,
                epoch=epoch,
                phase_boundary=f"after_direct_family_pass_{pass_index}",
                selectable=False,
                cache=cache,
                context=context,
                partition=partition,
                candidate_ids=candidate_ids,
                anchor_base_metrics=anchor_base_metrics,
                anchor_train_metrics=anchor_train_metrics,
                args=args,
                losses={
                    "base_preservation": None,
                    "direct_family_passes": list(direct_losses),
                    "page_body": None,
                },
                batch_consumption=_epoch_consumption(
                    partition,
                    args,
                    epoch=epoch,
                    boundary="after_direct_family",
                    completed_direct_passes=pass_index,
                ),
            )
            history.append(post_direct_record)
        if post_direct_record is None:  # pragma: no cover - options require >=1
            raise R2TrainingError("direct phase did not produce a snapshot")

        base_batches, _base_schedule = _base_batches(partition, args, epoch=epoch)
        base_loss = _base_accumulated_optimization_step(
            torch,
            model,
            optimizer,
            cache=cache,
            partition=partition,
            batches=base_batches,
            class_weights=class_weights,
            source_weight_denominator=source_weight_denominator,
            family_ce_weight=args.base_family_ce_weight,
            anchor_kl_weight=args.anchor_kl_weight,
            residual_l2_weight=args.residual_l2_weight,
            gradient_clip=args.gradient_clip,
        )
        post_base_record = _snapshot_record(
            torch,
            model,
            epoch=epoch,
            phase_boundary="after_base_preservation",
            selectable=True,
            cache=cache,
            context=context,
            partition=partition,
            candidate_ids=candidate_ids,
            anchor_base_metrics=anchor_base_metrics,
            anchor_train_metrics=anchor_train_metrics,
            args=args,
            losses={
                "base_preservation": base_loss,
                "direct_family_passes": list(direct_losses),
                "page_body": None,
            },
            batch_consumption=_epoch_consumption(
                partition,
                args,
                epoch=epoch,
                boundary="after_base_preservation",
            ),
        )
        history.append(post_base_record)
        phase_diagnostics.append(
            _phase_comparison(
                epoch=epoch,
                anchor_record=epoch0,
                post_direct=post_direct_record,
                post_base=post_base_record,
                minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
            )
        )
        key = _selection_key(
            epoch=epoch,
            diagnostic_passed=bool(post_base_record["diagnostic_worth_passed"]),
            base_metrics=post_base_record["base_metrics"],
            base_regression=post_base_record["base_regression_checks"],
            train_metrics=post_base_record["training_only_selection_metrics"],
        )
        if key > best_key:
            best_key = key
            best_record = post_base_record
            best_state = _sidecar_state(model, args.head_architecture)

    _apply_sidecar_state(model, best_state, args.head_architecture)
    selected_epoch = int(best_record["epoch"])
    selected_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    selected_base_regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        selected_base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    selected_train_metrics = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    selected_state = _sidecar_state(model, args.head_architecture)
    _apply_sidecar_state(model, initial_state, args.head_architecture)
    anchor_development_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    anchor_development_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, selected_state, args.head_architecture)
    selected_development_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    selected_development_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    selected_checks = _diagnostic_checks(
        anchor_train=anchor_train_metrics,
        candidate_train=selected_train_metrics,
        base_metrics=selected_base_metrics,
        base_regression=selected_base_regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        candidate_outputs_exact=True,
    )
    if r0._anchor_tensor_inventory(model.anchor_model) != anchor_tensor_inventory:
        raise R2TrainingError("frozen anchor tensor bytes drifted during training")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        sidecar_path = staging / SIDECAR_FILE
        save_file(
            {name: value.contiguous() for name, value in selected_state.items()},
            str(sidecar_path),
        )
        context_contract = r0._context_contract(context, args)
        manifest = seal_record(
            {
                "anchor": context_contract["anchor"],
                "architecture": architecture,
                "authority": dict(EXPECTED_AUTHORITY),
                "base_dataset": context_contract["base_dataset"],
                "base_metrics": {
                    "anchor": anchor_base_metrics,
                    "candidate": selected_base_metrics,
                    "regression_checks": selected_base_regression,
                },
                "candidate_ids": list(candidate_ids),
                "candidate_score_invariance": candidate_invariance,
                "configuration": _configuration(args),
                "development_diagnostics": {
                    "consulted_after_winner_selection_only": True,
                    "direct_family": {
                        "anchor": anchor_development_direct,
                        "candidate": selected_development_direct,
                    },
                    "gradient_rows": 0,
                    "page_consistency": {
                        "anchor": anchor_development_page,
                        "candidate": selected_development_page,
                    },
                    "used_for_checkpoint_selection": False,
                },
                "diagnostic_worth": {
                    "checks": selected_checks,
                    "passed": selected_epoch > 0 and all(selected_checks.values()),
                    "promotion_authority": False,
                },
                "direct_family_metrics": {
                    "anchor_train": anchor_train_metrics["direct_family"],
                    "candidate_train": selected_train_metrics["direct_family"],
                    "metrics_are_unweighted": True,
                },
                "experiment_contract": _experiment_contract(),
                "family_override": partition["family_override"],
                "files": {
                    SIDECAR_FILE: {
                        "byte_size": sidecar_path.stat().st_size,
                        "sha256": sha256_file(sidecar_path),
                        "tensor_inventory": _tensor_inventory(selected_state),
                    }
                },
                "history": history,
                "objective_contract": _objective_contract(args, partition),
                "overlay": context_contract["overlay"],
                "overlay_metrics": {
                    "anchor_train": anchor_train_metrics["page_consistency"],
                    "candidate_train": selected_train_metrics["page_consistency"],
                    "metric_only_no_gradient": True,
                },
                "partition": partition["contract"],
                "phase_diagnostics": phase_diagnostics,
                "record_type": (
                    "manga_font_v3_shared_hidden_family_residual_r2_manifest"
                ),
                "runtime_boundary": dict(EXPECTED_RUNTIME_BOUNDARY),
                "schema_version": SCHEMA_VERSION,
                "selection": _selection_contract(
                    selected_epoch=selected_epoch,
                    partition=partition,
                    args=args,
                ),
                "source_query_head": context_contract["source_query_head"],
                "trainable_parameters": trainable,
                "training_seconds": max(float(time.monotonic() - started), 1e-9),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    MANIFEST_FILE: sha256_file(manifest_path),
                    SIDECAR_FILE: sha256_file(sidecar_path),
                },
                "owner": OWNER,
                "safe_replace": False,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def _configuration_args(
    manifest: Mapping[str, Any], configuration: Mapping[str, Any]
) -> argparse.Namespace:
    try:
        return r1._configuration_args(manifest, configuration)
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error


def _validate_loss_mapping(value: Any, location: str) -> None:
    fields = _mapping(value, location)
    if set(fields) != {"anchor_kl", "family_ce", "residual_l2", "total"}:
        raise R2TrainingError(f"{location}: loss inventory drifted")
    if any(
        isinstance(number, bool)
        or not isinstance(number, (int, float))
        or not math.isfinite(float(number))
        or float(number) < 0
        for number in fields.values()
    ):
        raise R2TrainingError(f"{location}: invalid loss")


def _validate_loss_algebra(
    loss: Mapping[str, Any],
    location: str,
    *,
    family_ce_weight: float,
    anchor_kl_weight: float,
    residual_l2_weight: float,
) -> None:
    expected = (
        float(family_ce_weight) * float(loss["family_ce"])
        + float(anchor_kl_weight) * float(loss["anchor_kl"])
        + float(residual_l2_weight) * float(loss["residual_l2"])
    )
    if not math.isclose(
        float(loss["total"]),
        expected,
        rel_tol=LOSS_ALGEBRA_RELATIVE_TOLERANCE,
        abs_tol=LOSS_ALGEBRA_ABSOLUTE_TOLERANCE,
    ):
        raise R2TrainingError(f"{location}: weighted total algebra drifted")


def _validate_phase_losses(
    value: Any,
    location: str,
    *,
    completed_direct_passes: int,
    base_completed: bool,
    args: argparse.Namespace,
) -> Mapping[str, Any]:
    losses = _mapping(value, location)
    if set(losses) != {
        "base_preservation",
        "direct_family_passes",
        "page_body",
    }:
        raise R2TrainingError(f"{location}: phase loss inventory drifted")
    direct = losses["direct_family_passes"]
    if not isinstance(direct, list) or len(direct) != completed_direct_passes:
        raise R2TrainingError(f"{location}: direct pass loss inventory drifted")
    for pass_index, pass_loss in enumerate(direct, start=1):
        _validate_loss_mapping(pass_loss, f"{location}.direct[{pass_index}]")
        if float(pass_loss["anchor_kl"]) != 0.0:
            raise R2TrainingError(f"{location}: direct anchor KL is not zero")
        _validate_loss_algebra(
            pass_loss,
            f"{location}.direct[{pass_index}]",
            family_ce_weight=args.direct_family_ce_weight,
            anchor_kl_weight=0.0,
            residual_l2_weight=args.residual_l2_weight,
        )
    if base_completed:
        _validate_loss_mapping(losses["base_preservation"], f"{location}.base")
        _validate_loss_algebra(
            losses["base_preservation"],
            f"{location}.base",
            family_ce_weight=args.base_family_ce_weight,
            anchor_kl_weight=args.anchor_kl_weight,
            residual_l2_weight=args.residual_l2_weight,
        )
    elif losses["base_preservation"] is not None:
        raise R2TrainingError(f"{location}: pre-base loss must be null")
    if losses["page_body"] is not None:
        raise R2TrainingError(f"{location}: page loss must be null")
    return losses


def _record_recompute(
    torch: Any,
    *,
    record: Mapping[str, Any],
    expected_epoch: int,
    expected_boundary: str,
    expected_selectable: bool,
    expected_consumption: Mapping[str, Any],
    model: Any,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
    anchor_base_metrics: Mapping[str, Any],
    anchor_train_metrics: Mapping[str, Any] | None,
    args: argparse.Namespace,
) -> tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    expected_keys = {
        "base_metrics",
        "base_no_material_regression",
        "base_regression_checks",
        "batch_consumption",
        "candidate_outputs_exact_anchor",
        "checkpoint_selection_inputs",
        "development_eval_consulted",
        "diagnostic_checks",
        "diagnostic_gate_passed",
        "diagnostic_worth_passed",
        "epoch",
        "phase_boundary",
        "selectable_for_checkpoint",
        "sidecar_state",
        "sidecar_state_sha256",
        "subgroup_margin_flip_diagnostics",
        "training_only_selection_metrics",
    }
    if expected_epoch > 0:
        expected_keys.add("phase_losses")
    if set(record) != expected_keys:
        raise R2TrainingError(
            f"history epoch {expected_epoch} {expected_boundary}: inventory drifted"
        )
    if (
        record.get("epoch") != expected_epoch
        or record.get("phase_boundary") != expected_boundary
        or record.get("selectable_for_checkpoint") is not expected_selectable
        or record.get("development_eval_consulted") is not False
        or record.get("candidate_outputs_exact_anchor") is not True
        or record.get("checkpoint_selection_inputs")
        != (list(CHECKPOINT_SELECTION_INPUTS) if expected_selectable else [])
        or record.get("batch_consumption") != expected_consumption
    ):
        raise R2TrainingError(
            f"history epoch {expected_epoch} {expected_boundary}: boundary drifted"
        )
    state_payload = _mapping(record.get("sidecar_state"), "history sidecar state")
    if record.get("sidecar_state_sha256") != _payload_sha256(state_payload):
        raise R2TrainingError("history state hash drifted")
    state = _state_from_payload(torch, state_payload, args.head_architecture)
    _apply_sidecar_state(model, state, args.head_architecture)
    base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    train_metrics = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    reference = train_metrics if anchor_train_metrics is None else anchor_train_metrics
    checks = _diagnostic_checks(
        anchor_train=reference,
        candidate_train=train_metrics,
        base_metrics=base_metrics,
        base_regression=regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        candidate_outputs_exact=True,
    )
    expected_gate = all(checks.values())
    expected_worth = bool(expected_epoch > 0 and expected_selectable and expected_gate)
    _assert_nested_close(
        record.get("base_metrics"),
        base_metrics,
        f"history[{expected_epoch},{expected_boundary}].base_metrics",
    )
    _assert_nested_close(
        record.get("training_only_selection_metrics"),
        train_metrics,
        f"history[{expected_epoch},{expected_boundary}].training_metrics",
    )
    if (
        record.get("base_regression_checks") != regression
        or record.get("base_no_material_regression") is not all(regression.values())
        or record.get("diagnostic_checks") != checks
        or record.get("diagnostic_gate_passed") is not expected_gate
        or record.get("diagnostic_worth_passed") is not expected_worth
    ):
        raise R2TrainingError("history diagnostic contract drifted")
    try:
        subgroup = r1._subgroup_margin_flip_diagnostics(
            torch,
            model,
            cache=cache,
            context=context,
            partition=partition,
        )
    except r1.R1TrainingError as error:
        raise R2TrainingError(str(error)) from error
    _assert_nested_close(
        record.get("subgroup_margin_flip_diagnostics"),
        subgroup,
        f"history[{expected_epoch},{expected_boundary}].subgroups",
    )
    return state, base_metrics, train_metrics


def _strict_history_recompute(
    torch: Any,
    *,
    manifest: Mapping[str, Any],
    model: Any,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
    anchor_base_metrics: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[
    int,
    Mapping[str, Any],
    Mapping[str, Any],
    Mapping[str, Any],
    Sequence[Mapping[str, Any]],
]:
    history = manifest.get("history")
    expected_length = 1 + int(args.epochs) * (int(args.direct_passes) + 1)
    if not isinstance(history, list) or len(history) != expected_length:
        raise R2TrainingError("history inventory drifted")
    initial_state, _anchor_base, anchor_train = _record_recompute(
        torch,
        record=_mapping(history[0], "history[0]"),
        expected_epoch=0,
        expected_boundary="anchor_initialization",
        expected_selectable=True,
        expected_consumption=_zero_consumption(),
        model=model,
        cache=cache,
        context=context,
        partition=partition,
        candidate_ids=candidate_ids,
        anchor_base_metrics=anchor_base_metrics,
        anchor_train_metrics=None,
        args=args,
    )
    # The model currently contains the history state; rebuild the deterministic
    # initializer to compare every byte, including the MLP feature projection.
    initial_model = build_r2_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        head_architecture=args.head_architecture,
    ).cpu()
    expected_initial = _sidecar_state(initial_model, args.head_architecture)
    if _state_payload(initial_state, args.head_architecture) != _state_payload(
        expected_initial, args.head_architecture
    ):
        raise R2TrainingError("epoch zero is not the exact deterministic initializer")
    best_epoch = 0
    best_state = initial_state
    best_record = _mapping(history[0], "history[0]")
    best_key = _selection_key(
        epoch=0,
        diagnostic_passed=False,
        base_metrics=best_record["base_metrics"],
        base_regression=best_record["base_regression_checks"],
        train_metrics=anchor_train,
    )
    phase_diagnostics: list[Mapping[str, Any]] = []
    cursor = 1
    for epoch in range(1, int(args.epochs) + 1):
        direct_records: list[Mapping[str, Any]] = []
        direct_losses: list[Any] | None = None
        for pass_index in range(1, int(args.direct_passes) + 1):
            record = _mapping(history[cursor], f"history[{cursor}]")
            cursor += 1
            _state, _base, _train = _record_recompute(
                torch,
                record=record,
                expected_epoch=epoch,
                expected_boundary=f"after_direct_family_pass_{pass_index}",
                expected_selectable=False,
                expected_consumption=_epoch_consumption(
                    partition,
                    args,
                    epoch=epoch,
                    boundary="after_direct_family",
                    completed_direct_passes=pass_index,
                ),
                model=model,
                cache=cache,
                context=context,
                partition=partition,
                candidate_ids=candidate_ids,
                anchor_base_metrics=anchor_base_metrics,
                anchor_train_metrics=anchor_train,
                args=args,
            )
            losses = _validate_phase_losses(
                record.get("phase_losses"),
                f"history[{cursor - 1}].phase_losses",
                completed_direct_passes=pass_index,
                base_completed=False,
                args=args,
            )
            current_direct_losses = list(losses["direct_family_passes"])
            if (
                direct_losses is not None
                and current_direct_losses[:-1] != direct_losses
            ):
                raise R2TrainingError("direct pass loss transcript prefix drifted")
            direct_losses = current_direct_losses
            direct_records.append(record)
        post_base_record = _mapping(history[cursor], f"history[{cursor}]")
        cursor += 1
        post_base_state, _base, post_base_train = _record_recompute(
            torch,
            record=post_base_record,
            expected_epoch=epoch,
            expected_boundary="after_base_preservation",
            expected_selectable=True,
            expected_consumption=_epoch_consumption(
                partition,
                args,
                epoch=epoch,
                boundary="after_base_preservation",
            ),
            model=model,
            cache=cache,
            context=context,
            partition=partition,
            candidate_ids=candidate_ids,
            anchor_base_metrics=anchor_base_metrics,
            anchor_train_metrics=anchor_train,
            args=args,
        )
        post_base_losses = _validate_phase_losses(
            post_base_record.get("phase_losses"),
            f"history[{cursor - 1}].phase_losses",
            completed_direct_passes=int(args.direct_passes),
            base_completed=True,
            args=args,
        )
        if list(post_base_losses["direct_family_passes"]) != direct_losses:
            raise R2TrainingError("post-base direct loss transcript drifted")
        comparison = _phase_comparison(
            epoch=epoch,
            anchor_record=history[0],
            post_direct=direct_records[-1],
            post_base=post_base_record,
            minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        )
        phase_diagnostics.append(comparison)
        key = _selection_key(
            epoch=epoch,
            diagnostic_passed=bool(post_base_record["diagnostic_worth_passed"]),
            base_metrics=post_base_record["base_metrics"],
            base_regression=post_base_record["base_regression_checks"],
            train_metrics=post_base_train,
        )
        if key > best_key:
            best_key = key
            best_epoch = epoch
            best_state = post_base_state
            best_record = post_base_record
    if cursor != len(history):  # pragma: no cover - length check should own this
        raise R2TrainingError("history cursor drifted")
    _assert_nested_close(
        manifest.get("phase_diagnostics"),
        phase_diagnostics,
        "phase diagnostics",
    )
    return best_epoch, best_state, best_record, anchor_train, phase_diagnostics


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R2TrainingError("PyTorch is required") from error
    expanded = output_dir.expanduser().absolute()
    if r0.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R2TrainingError("output cannot be linked or reparsed")
    root = expanded.resolve()
    if (
        not root.is_dir()
        or r0.overlay_v3._contains_link_or_reparse(root)
        or {path.name for path in root.iterdir()} != OUTPUT_FILES
    ):
        raise R2TrainingError("output inventory drifted")
    marker_path = root / MARKER_FILE
    manifest_path = root / MANIFEST_FILE
    sidecar_path = root / SIDECAR_FILE
    marker = _read_json(marker_path, "ownership marker")
    manifest = _read_json(manifest_path, "manifest")
    _validate_record_seal(marker, "ownership marker")
    _validate_record_seal(manifest, "manifest")
    if set(marker) != {
        "artifacts",
        "owner",
        "record_sha256",
        "safe_replace",
        "schema_version",
    }:
        raise R2TrainingError("ownership marker inventory drifted")
    artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not False
        or set(artifacts) != {MANIFEST_FILE, SIDECAR_FILE}
        or artifacts.get(MANIFEST_FILE) != sha256_file(manifest_path)
        or artifacts.get(SIDECAR_FILE) != sha256_file(sidecar_path)
    ):
        raise R2TrainingError("ownership marker binding drifted")
    if (
        set(manifest) != EXPECTED_MANIFEST_KEYS
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v3_shared_hidden_family_residual_r2_manifest"
        or manifest.get("authority") != EXPECTED_AUTHORITY
        or manifest.get("runtime_boundary") != EXPECTED_RUNTIME_BOUNDARY
        or manifest.get("experiment_contract") != _experiment_contract()
    ):
        raise R2TrainingError("manifest authority or schema drifted")
    training_seconds = manifest.get("training_seconds")
    if (
        isinstance(training_seconds, bool)
        or not isinstance(training_seconds, (int, float))
        or not math.isfinite(float(training_seconds))
        or float(training_seconds) <= 0
    ):
        raise R2TrainingError("training seconds drifted")
    configuration = _mapping(manifest.get("configuration"), "configuration")
    if set(configuration) != EXPECTED_CONFIGURATION_KEYS:
        raise R2TrainingError("configuration inventory drifted")
    args = _configuration_args(manifest, configuration)
    _validate_options(args)
    if configuration.get("device") not in {"cpu", "cuda"}:
        raise R2TrainingError("training device claim drifted")

    files = _mapping(manifest.get("files"), "manifest files")
    if set(files) != {SIDECAR_FILE}:
        raise R2TrainingError("manifest file inventory drifted")
    descriptor = _mapping(files[SIDECAR_FILE], "sidecar descriptor")
    if set(descriptor) != {"byte_size", "sha256", "tensor_inventory"} or (
        descriptor.get("byte_size") != sidecar_path.stat().st_size
        or descriptor.get("sha256") != sha256_file(sidecar_path)
    ):
        raise R2TrainingError("sidecar descriptor drifted")
    checkpoint_state = _load_sidecar_state(torch, sidecar_path, args.head_architecture)
    if descriptor.get("tensor_inventory") != _tensor_inventory(checkpoint_state):
        raise R2TrainingError("sidecar tensor inventory drifted")

    context = _load_context(args, torch)
    expected_context = r0._context_contract(context, args)
    for key in ("anchor", "base_dataset", "overlay", "source_query_head"):
        if manifest.get(key) != expected_context[key]:
            raise R2TrainingError(f"{key} binding drifted")
    candidate_ids = tuple(context["candidate_ids"])
    if manifest.get("candidate_ids") != list(candidate_ids):
        raise R2TrainingError("candidate IDs drifted")
    model = build_r2_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        head_architecture=args.head_architecture,
    ).cpu()
    architecture = _architecture_contract(
        model,
        head_architecture=args.head_architecture,
        maximum_margin=args.maximum_margin,
    )
    if manifest.get("architecture") != architecture:
        raise R2TrainingError("residual architecture drifted")
    if manifest.get("trainable_parameters") != _trainable_contract(
        model, args.head_architecture
    ) or any(parameter.requires_grad for parameter in model.anchor_model.parameters()):
        raise R2TrainingError("trainable parameter boundary drifted")
    partition = _build_partition(context, args)
    if manifest.get("partition") != partition["contract"]:
        raise R2TrainingError("training partition drifted")
    if manifest.get("family_override") != partition["family_override"]:
        raise R2TrainingError("family override contract drifted")
    if manifest.get("objective_contract") != _objective_contract(args, partition):
        raise R2TrainingError("objective contract drifted")
    cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
    )
    _assert_zero_output_anchor(torch, model, cache)
    candidate_invariance = _candidate_invariance(cache)
    if manifest.get("candidate_score_invariance") != candidate_invariance:
        raise R2TrainingError("candidate score invariance drifted")
    anchor_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    best_epoch, selected_state, selected_record, anchor_train, _phase = (
        _strict_history_recompute(
            torch,
            manifest=manifest,
            model=model,
            cache=cache,
            context=context,
            partition=partition,
            candidate_ids=candidate_ids,
            anchor_base_metrics=anchor_base_metrics,
            args=args,
        )
    )
    selection = _mapping(manifest.get("selection"), "selection")
    expected_selection = _selection_contract(
        selected_epoch=best_epoch, partition=partition, args=args
    )
    if set(selection) != EXPECTED_SELECTION_KEYS or selection != expected_selection:
        raise R2TrainingError("selection claim drifted")
    if _state_payload(checkpoint_state, args.head_architecture) != _state_payload(
        selected_state, args.head_architecture
    ):
        raise R2TrainingError("exported sidecar is not the selected post-base state")
    if best_epoch == 0:
        initial_model = build_r2_model(
            torch,
            anchor_model=context["model"],
            maximum_margin=args.maximum_margin,
            head_architecture=args.head_architecture,
        ).cpu()
        expected_initial = _sidecar_state(initial_model, args.head_architecture)
        if _state_payload(checkpoint_state, args.head_architecture) != _state_payload(
            expected_initial, args.head_architecture
        ):
            raise R2TrainingError("anchor fallback is not the exact initial state")

    _apply_sidecar_state(model, selected_state, args.head_architecture)
    selected_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    selected_regression = r0.page_v3.base_regression_checks(
        anchor_base_metrics,
        selected_base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    selected_train = r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )
    initial_state = _state_from_payload(
        torch, manifest["history"][0]["sidecar_state"], args.head_architecture
    )
    _apply_sidecar_state(model, initial_state, args.head_architecture)
    anchor_dev_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    anchor_dev_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, selected_state, args.head_architecture)
    selected_dev_direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=context["groups"]["direct_family"]["development_eval"],
    )
    selected_dev_page = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=context["groups"]["development_eval"],
        candidate_ids=candidate_ids,
    )
    _assert_nested_close(
        manifest.get("base_metrics"),
        {
            "anchor": anchor_base_metrics,
            "candidate": selected_base_metrics,
            "regression_checks": selected_regression,
        },
        "base metrics",
    )
    _assert_nested_close(
        manifest.get("direct_family_metrics"),
        {
            "anchor_train": anchor_train["direct_family"],
            "candidate_train": selected_train["direct_family"],
            "metrics_are_unweighted": True,
        },
        "direct-family metrics",
    )
    _assert_nested_close(
        manifest.get("overlay_metrics"),
        {
            "anchor_train": anchor_train["page_consistency"],
            "candidate_train": selected_train["page_consistency"],
            "metric_only_no_gradient": True,
        },
        "overlay metrics",
    )
    _assert_nested_close(
        manifest.get("development_diagnostics"),
        {
            "consulted_after_winner_selection_only": True,
            "direct_family": {
                "anchor": anchor_dev_direct,
                "candidate": selected_dev_direct,
            },
            "gradient_rows": 0,
            "page_consistency": {
                "anchor": anchor_dev_page,
                "candidate": selected_dev_page,
            },
            "used_for_checkpoint_selection": False,
        },
        "development diagnostics",
    )
    selected_checks = _diagnostic_checks(
        anchor_train=anchor_train,
        candidate_train=selected_train,
        base_metrics=selected_base_metrics,
        base_regression=selected_regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        candidate_outputs_exact=True,
    )
    expected_worth = {
        "checks": selected_checks,
        "passed": best_epoch > 0 and all(selected_checks.values()),
        "promotion_authority": False,
    }
    if manifest.get("diagnostic_worth") != expected_worth:
        raise R2TrainingError("diagnostic worth claim drifted")
    if selected_record.get("diagnostic_worth_passed") is not expected_worth["passed"]:
        raise R2TrainingError("selected history worth claim drifted")
    return {
        "best_epoch": best_epoch,
        "candidate_score_sha256": candidate_invariance["three_output_sha256"],
        "diagnostic_worth": bool(expected_worth["passed"]),
        "head_architecture": args.head_architecture,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(manifest_path),
        "output_dir": str(root),
        "read_only_recomputation": True,
        "schema_version": SCHEMA_VERSION,
        "sidecar_sha256": sha256_file(sidecar_path),
        "status": "valid_nonpromotable_r2_accumulated_phase_diagnostic",
        "trajectory_replay_authority": False,
    }


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    validation = validate_output(args.output_dir)
    return {
        **validation,
        "evaluation_authority": False,
        "note": (
            "strict CPU state/metric recomputation; CUDA optimizer trajectory is "
            "producer-attested and the full-runtime CPU benchmark is still required"
        ),
    }


def _add_shared_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-npz", type=Path, default=r0.DEFAULT_BASE_NPZ)
    parser.add_argument("--overlay-dir", type=Path, default=r0.DEFAULT_OVERLAY_DIR)
    parser.add_argument(
        "--anchor-adapter-dir", type=Path, default=r0.DEFAULT_ANCHOR_DIR
    )
    parser.add_argument(
        "--source-query-head", type=Path, default=r0.DEFAULT_SOURCE_QUERY_HEAD
    )
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--evaluation-batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--base-family-ce-weight", type=float, default=0.35)
    parser.add_argument("--direct-family-ce-weight", type=float, default=0.10)
    parser.add_argument("--page-body-ce-weight", type=float, default=0.0)
    parser.add_argument("--anchor-kl-weight", type=float, default=5.0)
    parser.add_argument("--residual-l2-weight", type=float, default=0.01)
    parser.add_argument("--maximum-margin", type=float, default=1.0)
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument(
        "--minimum-diagnostic-work-macro-improvement", type=float, default=0.02
    )
    parser.add_argument("--seed", type=int, default=20260820)
    parser.add_argument(
        "--base-supervision-mode",
        choices=("non_direct_preservation",),
        default="non_direct_preservation",
    )
    parser.add_argument(
        "--direct-balance-mode", choices=("work_family",), default="work_family"
    )
    parser.add_argument(
        "--anchor-kl-scope", choices=("base_only",), default="base_only"
    )
    parser.add_argument(
        "--head-architecture", choices=HEAD_ARCHITECTURES, default="linear"
    )
    parser.add_argument(
        "--direct-passes", type=int, choices=DIRECT_PASS_CHOICES, default=1
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    _add_shared_arguments(preflight_parser)
    preflight_parser.set_defaults(device="cpu")
    train_parser = commands.add_parser("train")
    _add_shared_arguments(train_parser)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    train_parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    evaluate_parser = commands.add_parser("evaluate")
    evaluate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "preflight":
            result = preflight(args)
        elif args.command == "train":
            result = train(args)
        elif args.command == "validate":
            result = validate_output(args.output_dir)
        elif args.command == "evaluate":
            result = evaluate(args)
        else:  # pragma: no cover - argparse owns the enum
            parser.error("unsupported command")
    except R2TrainingError as error:
        parser.error(str(error))
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
