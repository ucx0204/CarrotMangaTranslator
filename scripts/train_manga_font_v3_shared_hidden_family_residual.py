#!/usr/bin/env python3
"""Train a sealed, QA-only family residual over the frozen production r3h adapter.

This experiment deliberately leaves the production v8 adapter and every font
candidate score untouched.  It reuses the frozen 64-dimensional hidden vector
that already feeds ``sample_candidate_residual.2`` and trains only one scalar
linear projection.  The projection is bounded in *family-margin* units and is
added antisymmetrically to the body/variant logits.

The output is a two-tensor sidecar plus a strict diagnostic manifest.  It is not
a runtime artifact, has no promotion authority, and must not be consumed by the
application or existing exporters.
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
    from scripts import build_manga_font_v3_page_consistency_overlay as overlay_v3
    from scripts import train_manga_font_student_v8_role_family_adapter as v8
    from scripts import train_manga_font_v3_page_consistency_adapter as page_v3
except ImportError:  # pragma: no cover - direct script execution
    import build_manga_font_v3_page_consistency_overlay as overlay_v3
    import train_manga_font_student_v8_role_family_adapter as v8
    import train_manga_font_v3_page_consistency_adapter as page_v3


SCHEMA_VERSION = "manga-font-v3-shared-hidden-family-residual-v1"
OWNER = "carrot-manga-translator/manga-font-v3-shared-hidden-family-residual-v1"
SIDECAR_FILE = "family-margin-residual.safetensors"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-shared-hidden-family-residual-v1-owned.json"
OUTPUT_FILES = frozenset({SIDECAR_FILE, MANIFEST_FILE, MARKER_FILE})

DEFAULT_BASE_NPZ = page_v3.DEFAULT_BASE_NPZ
DEFAULT_OVERLAY_DIR = Path(
    "artifacts/manga-font-v3-page-consistency-overlay-training-only-v1-r2"
)
DEFAULT_ANCHOR_DIR = page_v3.DEFAULT_ANCHOR_DIR
DEFAULT_SOURCE_QUERY_HEAD = page_v3.DEFAULT_SOURCE_QUERY_HEAD

EXPECTED_ANCHOR_TENSOR_COUNT = 15
EXPECTED_HIDDEN_DIM = 64
EXPECTED_SIDECAR_TENSORS = {
    "family_margin_head.bias": ((1,), "float32"),
    "family_margin_head.weight": ((1, EXPECTED_HIDDEN_DIM), "float32"),
}
EXPECTED_TRAINABLE_PARAMETER_COUNT = EXPECTED_HIDDEN_DIM + 1
MAX_MARGIN_CHOICES = (1.0, 2.0, 4.0)
CHECKPOINT_SELECTION_INPUTS = (
    "base_r3_validation",
    "direct_family_train_balanced_accuracy",
    "direct_family_train_body_accuracy",
    "page_consistency_train_runtime_metrics",
)
MODEL_SELECTION_LABEL_SOURCES = (
    "base_r3_validation",
    "direct_family_train_only_balanced_and_body_accuracy",
    "page_consistency_train_only_runtime_metrics",
)

EXPECTED_AUTHORITY = {
    "automatic_release_authority": False,
    "calibration_authority": False,
    "development_eval_is_locked_holdout": False,
    "development_eval_is_post_selection_diagnostic_only": True,
    "evaluation_authority": False,
    "experimental_qa_only": True,
    "human_gold": False,
    "production_integration_allowed": False,
    "training_label_authority": "training_only_non_human_visual",
}
EXPECTED_RUNTIME_BOUNDARY = {
    "application_consumption_allowed": False,
    "candidate_scores_are_exact_anchor": True,
    "existing_exporters_supported": False,
    "internal_candidate_scores_semantics": (
        "frozen_anchor_soft_gate_mixture_compatibility_only_not_evaluated"
    ),
    "onnx_input_output_contract_change_required": False,
    "public_onnx_candidate_scores_semantics": "body_candidate_scores_alias",
    "production_files_modified": False,
    "promotion_state": "nonpromotable_diagnostic_sidecar",
    "sidecar_requires_new_explicit_exporter_bridge": True,
    "strict_metric_score_route": "hard_family_argmax_then_body_or_variant_branch",
}
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
        "family_override",
        "files",
        "history",
        "overlay",
        "overlay_metrics",
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
EXPECTED_CONFIGURATION_KEYS = frozenset(
    {
        "anchor_kl_weight",
        "base_family_ce_weight",
        "batch_size",
        "device",
        "direct_family_ce_weight",
        "epochs",
        "evaluation_batch_size",
        "gradient_clip",
        "learning_rate",
        "maximum_acceptable_regression",
        "maximum_family_regression",
        "maximum_margin",
        "maximum_preferred_regression",
        "minimum_diagnostic_work_macro_improvement",
        "page_body_ce_weight",
        "residual_l2_weight",
        "seed",
        "weight_decay",
    }
)
EXPECTED_SELECTION_KEYS = frozenset(
    {
        "anchor_fallback_selected",
        "base_gradient_rows",
        "best_epoch",
        "development_eval_consulted_during_checkpoint_selection",
        "development_eval_gradient_rows",
        "development_eval_label_rows_consulted_during_checkpoint_selection",
        "direct_family_gradient_rows",
        "model_selection_label_sources",
        "page_consistency_gradient_groups",
        "page_consistency_gradient_rows",
        "selection_key_order",
    }
)


class SharedHiddenFamilyResidualError(ValueError):
    """Raised when the isolated residual experiment violates its boundary."""


def canonical_json(value: Any) -> str:
    return page_v3.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return page_v3.json_bytes(value, pretty=pretty)


def sha256_file(path: Path) -> str:
    return page_v3.sha256_file(path)


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    return page_v3.seal_record(core)


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    try:
        page_v3.validate_record_seal(record, location)
    except page_v3.PageConsistencyTrainingError as error:
        raise SharedHiddenFamilyResidualError(str(error)) from error


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SharedHiddenFamilyResidualError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SharedHiddenFamilyResidualError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _json_contract(value: Any) -> Any:
    return json.loads(canonical_json(value))


def _assert_nested_close(actual: Any, expected: Any, location: str) -> None:
    try:
        page_v3._assert_nested_close(actual, expected, location)
    except page_v3.PageConsistencyTrainingError as error:
        raise SharedHiddenFamilyResidualError(str(error)) from error


def _safe_new_output(path: Path) -> Path:
    try:
        return page_v3._safe_new_output(path)
    except page_v3.PageConsistencyTrainingError as error:
        raise SharedHiddenFamilyResidualError(str(error)) from error


def bounded_margin(torch: Any, raw_margin: Any, maximum_margin: float) -> Any:
    """Bound a margin while keeping derivative one at zero for every budget."""

    budget = float(maximum_margin)
    if budget not in MAX_MARGIN_CHOICES:
        raise SharedHiddenFamilyResidualError("maximum margin must be one of 1, 2, 4")
    return budget * torch.tanh(raw_margin.float() / budget)


def frozen_shared_hidden(torch: Any, anchor_model: Any, query_views: Any) -> Any:
    """Replay the exact frozen hidden already computed by the r3h residual MLP."""

    if query_views.ndim == 3:
        query_views = query_views[:, None, :, :]
    if query_views.ndim != 4 or tuple(query_views.shape[-2:]) != (
        v8.QUERY_COUNT,
        v8.QUERY_DIM,
    ):
        raise SharedHiddenFamilyResidualError(
            "query views must have shape [batch,views,4,256]"
        )
    sample = torch.nn.functional.normalize(query_views.float().mean(dim=1), p=2, dim=-1)
    flattened = sample.reshape(sample.shape[0], -1)
    normalized = anchor_model.sample_candidate_norm(flattened)
    hidden = anchor_model.sample_candidate_residual[1](
        anchor_model.sample_candidate_residual[0](normalized)
    )
    if hidden.ndim != 2 or hidden.shape[1] != EXPECTED_HIDDEN_DIM:
        raise SharedHiddenFamilyResidualError("frozen shared hidden shape drifted")
    return hidden


def build_shared_hidden_family_residual(
    torch: Any, *, anchor_model: Any, maximum_margin: float
) -> Any:
    """Wrap an immutable r3h adapter with one zero-initialized scalar head."""

    if float(maximum_margin) not in MAX_MARGIN_CHOICES:
        raise SharedHiddenFamilyResidualError("unsupported maximum margin")
    anchor_state = anchor_model.state_dict()
    if len(anchor_state) != EXPECTED_ANCHOR_TENSOR_COUNT:
        raise SharedHiddenFamilyResidualError("anchor tensor inventory drifted")

    class SharedHiddenFamilyResidual(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.anchor_model = anchor_model
            self.anchor_model.requires_grad_(False).eval()
            self.family_margin_head = torch.nn.Linear(EXPECTED_HIDDEN_DIM, 1)
            torch.nn.init.zeros_(self.family_margin_head.weight)
            torch.nn.init.zeros_(self.family_margin_head.bias)
            self.maximum_margin = float(maximum_margin)

        def residual_from_hidden(self, hidden: Any) -> Mapping[str, Any]:
            raw = self.family_margin_head(hidden.float()).squeeze(-1)
            margin = bounded_margin(torch, raw, self.maximum_margin)
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
                hidden = frozen_shared_hidden(torch, self.anchor_model, query_views)
            residual = self.residual_from_hidden(hidden)
            outputs = dict(anchor_outputs)
            outputs["family_logits"] = (
                anchor_outputs["family_logits"] + residual["family_logit_adjustment"]
            )
            outputs.update(residual)
            return outputs

    return SharedHiddenFamilyResidual()


def _sidecar_state(model: Any) -> Mapping[str, Any]:
    return {
        "family_margin_head.bias": model.family_margin_head.bias.detach()
        .cpu()
        .float()
        .contiguous()
        .clone(),
        "family_margin_head.weight": model.family_margin_head.weight.detach()
        .cpu()
        .float()
        .contiguous()
        .clone(),
    }


def _state_payload(state: Mapping[str, Any]) -> Mapping[str, Any]:
    if set(state) != set(EXPECTED_SIDECAR_TENSORS):
        raise SharedHiddenFamilyResidualError("sidecar state inventory drifted")
    result: dict[str, Any] = {}
    for name in sorted(state):
        value = state[name]
        array = np.asarray(value.detach().cpu().numpy(), dtype="<f4")
        expected_shape, expected_dtype = EXPECTED_SIDECAR_TENSORS[name]
        if (
            tuple(array.shape) != expected_shape
            or str(array.dtype) != expected_dtype
            or not np.isfinite(array).all()
        ):
            raise SharedHiddenFamilyResidualError(f"sidecar tensor drifted: {name}")
        result[name] = {
            "data_hex_little_endian_float32": array.tobytes(order="C").hex(),
            "dtype": expected_dtype,
            "shape": list(expected_shape),
        }
    return result


def _state_from_payload(torch: Any, payload: Mapping[str, Any]) -> Mapping[str, Any]:
    if set(payload) != set(EXPECTED_SIDECAR_TENSORS):
        raise SharedHiddenFamilyResidualError("sidecar payload inventory drifted")
    state: dict[str, Any] = {}
    for name, (shape, dtype) in EXPECTED_SIDECAR_TENSORS.items():
        descriptor = _mapping(payload.get(name), f"state payload {name}")
        if (
            set(descriptor)
            != {
                "data_hex_little_endian_float32",
                "dtype",
                "shape",
            }
            or descriptor.get("dtype") != dtype
            or descriptor.get("shape") != list(shape)
        ):
            raise SharedHiddenFamilyResidualError(
                f"state payload descriptor drifted: {name}"
            )
        encoded = descriptor.get("data_hex_little_endian_float32")
        if not isinstance(encoded, str):
            raise SharedHiddenFamilyResidualError(
                f"state payload bytes missing: {name}"
            )
        try:
            raw = bytes.fromhex(encoded)
        except ValueError as error:
            raise SharedHiddenFamilyResidualError(
                f"state payload bytes invalid: {name}"
            ) from error
        expected_bytes = int(np.prod(shape, dtype=np.int64)) * 4
        if len(raw) != expected_bytes:
            raise SharedHiddenFamilyResidualError(f"state payload size drifted: {name}")
        array = np.frombuffer(raw, dtype="<f4").reshape(shape).copy()
        if not np.isfinite(array).all():
            raise SharedHiddenFamilyResidualError(
                f"state payload is non-finite: {name}"
            )
        state[name] = torch.from_numpy(array)
    return state


def _load_sidecar_state(torch: Any, path: Path) -> Mapping[str, Any]:
    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise SharedHiddenFamilyResidualError("safetensors is required") from error
    try:
        arrays = load_file(str(path))
    except Exception as error:  # noqa: BLE001
        raise SharedHiddenFamilyResidualError(
            "sidecar checkpoint is unreadable"
        ) from error
    if set(arrays) != set(EXPECTED_SIDECAR_TENSORS):
        raise SharedHiddenFamilyResidualError("sidecar checkpoint inventory drifted")
    state: dict[str, Any] = {}
    for name, (shape, dtype) in EXPECTED_SIDECAR_TENSORS.items():
        value = np.asarray(arrays[name])
        if (
            tuple(value.shape) != shape
            or str(value.dtype) != dtype
            or not np.isfinite(value).all()
        ):
            raise SharedHiddenFamilyResidualError(f"sidecar tensor drifted: {name}")
        state[name] = torch.from_numpy(np.array(value, copy=True))
    return state


def _apply_sidecar_state(model: Any, state: Mapping[str, Any]) -> None:
    if set(state) != set(EXPECTED_SIDECAR_TENSORS):
        raise SharedHiddenFamilyResidualError("sidecar state inventory drifted")
    weight = state["family_margin_head.weight"].to(
        device=model.family_margin_head.weight.device,
        dtype=model.family_margin_head.weight.dtype,
    )
    bias = state["family_margin_head.bias"].to(
        device=model.family_margin_head.bias.device,
        dtype=model.family_margin_head.bias.dtype,
    )
    if tuple(weight.shape) != tuple(model.family_margin_head.weight.shape) or tuple(
        bias.shape
    ) != tuple(model.family_margin_head.bias.shape):
        raise SharedHiddenFamilyResidualError("sidecar state shape drifted")
    model.family_margin_head.weight.detach().copy_(weight)
    model.family_margin_head.bias.detach().copy_(bias)


def _anchor_tensor_inventory(model: Any) -> Mapping[str, Any]:
    state = model.state_dict()
    if len(state) != EXPECTED_ANCHOR_TENSOR_COUNT:
        raise SharedHiddenFamilyResidualError("anchor tensor inventory drifted")
    result: dict[str, Any] = {}
    for name, value in sorted(state.items()):
        array = value.detach().cpu().contiguous().numpy()
        result[name] = {
            "dtype": str(array.dtype),
            "sha256": hashlib.sha256(array.tobytes(order="C")).hexdigest(),
            "shape": list(array.shape),
        }
    return result


def _tensor_inventory(state: Mapping[str, Any]) -> Mapping[str, Any]:
    result: dict[str, Any] = {}
    for name, value in sorted(state.items()):
        array = value.detach().cpu().float().contiguous().numpy()
        result[name] = {
            "dtype": str(array.dtype),
            "sha256": hashlib.sha256(array.tobytes(order="C")).hexdigest(),
            "shape": list(array.shape),
        }
    return result


def _candidate_score_sha256(cache: Mapping[str, Any]) -> str:
    digest = hashlib.sha256()
    for name in (
        "body_candidate_scores",
        "candidate_scores",
        "variant_candidate_scores",
    ):
        value = cache[name].detach().cpu().float().contiguous().numpy()
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(canonical_json(list(value.shape)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(value.tobytes(order="C"))
    return digest.hexdigest()


def _load_context(args: argparse.Namespace, torch: Any) -> Mapping[str, Any]:
    try:
        context = page_v3._load_context(args, torch)
    except (
        page_v3.PageConsistencyTrainingError,
        v8.MangaFontV8RoleFamilyError,
    ) as error:
        raise SharedHiddenFamilyResidualError(str(error)) from error
    architecture = _mapping(context["architecture"], "anchor architecture")
    if (
        int(architecture.get("candidate_residual_hidden_dim", -1))
        != EXPECTED_HIDDEN_DIM
    ):
        raise SharedHiddenFamilyResidualError("anchor hidden dimension drifted")
    if tuple(context["candidate_ids"]) != page_v3.EXPECTED_CANDIDATE_IDS:
        raise SharedHiddenFamilyResidualError("candidate inventory drifted")
    return context


def _build_frozen_cache(
    torch: Any,
    *,
    context: Mapping[str, Any],
    device: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    arrays = context["arrays"]
    anchor_model = context["model"].to(device)
    anchor_model.requires_grad_(False).eval()
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    collected: dict[str, list[Any]] = {
        "body_candidate_scores": [],
        "candidate_scores": [],
        "family_logits": [],
        "hidden": [],
        "variant_candidate_scores": [],
    }
    with torch.inference_mode():
        for start in range(0, len(arrays["query_views"]), batch_size):
            query_views = torch.from_numpy(
                arrays["query_views"][start : start + batch_size].astype(
                    np.float32, copy=False
                )
            ).to(device)
            outputs = anchor_model(query_views, prototypes)
            collected["hidden"].append(
                frozen_shared_hidden(torch, anchor_model, query_views).detach()
            )
            for name in (
                "body_candidate_scores",
                "candidate_scores",
                "family_logits",
                "variant_candidate_scores",
            ):
                collected[name].append(outputs[name].detach())
    cache = {name: torch.cat(parts, dim=0) for name, parts in collected.items()}
    expected_rows = int(len(arrays["query_views"]))
    if any(value.shape[0] != expected_rows for value in cache.values()):
        raise SharedHiddenFamilyResidualError("frozen cache row inventory drifted")
    return cache


def _family_outputs_from_cache(
    model: Any, cache: Mapping[str, Any], indices: np.ndarray
) -> Mapping[str, Any]:
    import torch

    positions = torch.as_tensor(
        indices, dtype=torch.long, device=cache["hidden"].device
    )
    residual = model.residual_from_hidden(cache["hidden"][positions])
    return {
        "body_candidate_scores": cache["body_candidate_scores"][positions],
        "candidate_scores": cache["candidate_scores"][positions],
        "family_logits": cache["family_logits"][positions]
        + residual["family_logit_adjustment"],
        "family_margin_delta": residual["family_margin_delta"],
        "variant_candidate_scores": cache["variant_candidate_scores"][positions],
    }


def _all_family_logits(model: Any, cache: Mapping[str, Any]) -> Mapping[str, Any]:
    residual = model.residual_from_hidden(cache["hidden"])
    return {
        "family_logits": cache["family_logits"] + residual["family_logit_adjustment"],
        "family_margin_delta": residual["family_margin_delta"],
    }


def _evaluate_base_from_cache(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    val_indices = np.flatnonzero(arrays["split"].astype(np.int64, copy=False) == 1)
    outputs = _family_outputs_from_cache(model, cache, val_indices)
    device = cache["hidden"].device
    labels = torch.from_numpy(arrays["family_labels"][val_indices].astype(np.int64)).to(
        device
    )
    positives = torch.from_numpy(arrays["positive_mask"][val_indices]).to(device)
    preferred = torch.from_numpy(arrays["preferred_mask"][val_indices]).to(device)
    weights = torch.from_numpy(
        arrays["font_supervision_weights"][val_indices].astype(np.float32)
    ).to(device)
    negative = torch.from_numpy(arrays["single_day_body_negative"][val_indices]).to(
        device
    )
    metric_outputs = {
        name: outputs[name]
        for name in (
            "body_candidate_scores",
            "family_logits",
            "variant_candidate_scores",
        )
    }
    metrics = v8.compute_metrics(
        torch,
        metric_outputs,
        family_labels=labels,
        positive_mask=positives,
        preferred_mask=preferred,
        font_supervision_weights=weights,
        single_day_body_negative=negative,
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )
    authorities = arrays["font_authority"][val_indices].astype(str)
    visual_positions = np.flatnonzero(authorities == "visual")
    visual_tensor = torch.as_tensor(visual_positions, dtype=torch.long, device=device)
    visual_outputs = {
        name: value[visual_tensor] for name, value in metric_outputs.items()
    }
    visual = v8.compute_metrics(
        torch,
        visual_outputs,
        family_labels=labels[visual_tensor],
        positive_mask=positives[visual_tensor],
        preferred_mask=preferred[visual_tensor],
        font_supervision_weights=weights[visual_tensor],
        single_day_body_negative=negative[visual_tensor],
        single_day_index=tuple(candidate_ids).index("single-day"),
        candidate_ids=candidate_ids,
    )
    quality_checks = v8.build_quality_gate_checks(metrics, visual)
    return {
        "all": dict(metrics),
        "quality_checks": quality_checks,
        "quality_gate_passed": all(quality_checks.values()),
        "visual": dict(visual),
    }


def _direct_family_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    direct_rows: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    indices = np.asarray([int(row["row_index"]) for row in direct_rows], dtype=np.int64)
    outputs = _family_outputs_from_cache(model, cache, indices)
    row_metrics = page_v3.direct_family_metrics(
        torch, outputs["family_logits"], direct_rows=direct_rows
    )
    works: dict[str, list[int]] = {}
    for position, row in enumerate(direct_rows):
        works.setdefault(str(row["work_id"]), []).append(position)
    per_work: dict[str, Mapping[str, Any]] = {}
    for work_id, positions in sorted(works.items()):
        selected_rows = [direct_rows[position] for position in positions]
        selected = torch.as_tensor(
            positions, dtype=torch.long, device=outputs["family_logits"].device
        )
        metrics = page_v3.direct_family_metrics(
            torch,
            outputs["family_logits"][selected],
            direct_rows=selected_rows,
        )
        if int(metrics["body_rows"]) < 1 or int(metrics["variant_rows"]) < 1:
            raise SharedHiddenFamilyResidualError(
                "direct-family work lacks one family class"
            )
        per_work[work_id] = metrics
    macro_keys = (
        "accuracy",
        "balanced_accuracy",
        "body_accuracy",
        "mean_body_probability",
        "predicted_body_rate",
        "variant_accuracy",
    )
    work_macro = {
        key: sum(float(metrics[key]) for metrics in per_work.values()) / len(per_work)
        for key in macro_keys
    }
    work_macro.update({"per_work": per_work, "work_count": len(per_work)})
    return {"row": row_metrics, "work_macro": work_macro}


def _overlay_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    groups: Sequence[Mapping[str, Any]],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    indices = np.concatenate([group["row_indices"] for group in groups])
    outputs = _family_outputs_from_cache(model, cache, indices)
    return page_v3.overlay_metrics(
        torch,
        {
            name: outputs[name]
            for name in (
                "body_candidate_scores",
                "family_logits",
                "variant_candidate_scores",
            )
        },
        groups=groups,
        candidate_ids=candidate_ids,
    )


def _margin_diagnostics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    indices: np.ndarray,
) -> Mapping[str, Any]:
    positions = torch.as_tensor(
        indices, dtype=torch.long, device=cache["hidden"].device
    )
    residual = model.residual_from_hidden(cache["hidden"][positions])
    values = residual["family_margin_delta"].detach().float().cpu().numpy()
    absolute = np.abs(values)
    budget = float(model.maximum_margin)
    return {
        "maximum_absolute_margin": float(absolute.max(initial=0.0)),
        "mean_absolute_margin": float(absolute.mean()) if len(absolute) else 0.0,
        "quantiles": {
            label: float(value)
            for label, value in zip(
                ("p00", "p10", "p25", "p50", "p75", "p90", "p100"),
                np.quantile(values, (0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0))
                if len(values)
                else np.zeros(7),
                strict=True,
            )
        },
        "row_count": int(len(values)),
        "saturation_rate_at_95pct_budget": float(np.mean(absolute >= budget * 0.95))
        if len(absolute)
        else 0.0,
    }


def _training_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    groups: Mapping[str, Any],
    candidate_ids: Sequence[str],
    margin_indices: np.ndarray,
) -> Mapping[str, Any]:
    direct = _direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=groups["direct_family"]["train"],
    )
    page = _overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=groups["train"],
        candidate_ids=candidate_ids,
    )
    return {
        "direct_family": direct,
        "margin": _margin_diagnostics(
            torch, model, cache=cache, indices=margin_indices
        ),
        "page_consistency": {
            key: page[key]
            for key in (
                "all_rows_top1_in_common_positive_rate",
                "group_count",
                "mean_body_probability",
                "mean_common_positive_mass",
                "mean_js",
                "predicted_body_rate",
                "row_count",
                "top1_all_agree_rate",
            )
        },
    }


def _selection_key(
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    train_metrics: Mapping[str, Any],
) -> tuple[float, ...]:
    direct = _mapping(train_metrics["direct_family"], "direct train metrics")
    row = _mapping(direct["row"], "direct row metrics")
    work = _mapping(direct["work_macro"], "direct work-macro metrics")
    page = _mapping(train_metrics["page_consistency"], "page train metrics")
    margin = _mapping(train_metrics["margin"], "margin diagnostics")
    return (
        float(base_metrics["quality_gate_passed"]),
        float(all(base_regression.values())),
        float(work["balanced_accuracy"]),
        float(work["body_accuracy"]),
        float(row["balanced_accuracy"]),
        float(row["body_accuracy"]),
        float(page["all_rows_top1_in_common_positive_rate"]),
        float(page["top1_all_agree_rate"]),
        -float(page["mean_js"]),
        float(page["mean_common_positive_mass"]),
        -float(margin["mean_absolute_margin"]),
        -float(margin["saturation_rate_at_95pct_budget"]),
        page_v3._base_selection_score(base_metrics),
    )


SELECTION_KEY_ORDER = (
    "base_v8_quality_gate",
    "base_no_material_regression",
    "direct_family_train_work_macro_balanced_accuracy",
    "direct_family_train_work_macro_body_accuracy",
    "direct_family_train_row_balanced_accuracy",
    "direct_family_train_row_body_accuracy",
    "page_train_all_rows_top1_in_common_positive_rate",
    "page_train_top1_all_agree_rate",
    "page_train_negative_mean_js",
    "page_train_mean_common_positive_mass",
    "negative_mean_absolute_family_margin",
    "negative_family_margin_saturation_rate",
    "base_r3_validation_score",
)


def _validate_options(args: argparse.Namespace) -> None:
    for name in ("epochs", "batch_size", "evaluation_batch_size", "seed"):
        value = getattr(args, name)
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or (name != "seed" and value < 1)
            or (name == "seed" and value < 0)
        ):
            requirement = (
                "a nonnegative integer" if name == "seed" else "a positive integer"
            )
            raise SharedHiddenFamilyResidualError(f"{name} must be {requirement}")
    positive_names = ("learning_rate", "gradient_clip")
    nonnegative_names = (
        "anchor_kl_weight",
        "base_family_ce_weight",
        "direct_family_ce_weight",
        "page_body_ce_weight",
        "residual_l2_weight",
        "weight_decay",
        "maximum_acceptable_regression",
        "maximum_preferred_regression",
        "maximum_family_regression",
        "minimum_diagnostic_work_macro_improvement",
    )
    for name in (*positive_names, *nonnegative_names, "maximum_margin"):
        value = getattr(args, name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise SharedHiddenFamilyResidualError(f"{name} must be numeric")
        if not math.isfinite(float(value)):
            raise SharedHiddenFamilyResidualError(f"{name} must be finite")
    for name in positive_names:
        if float(getattr(args, name)) <= 0:
            raise SharedHiddenFamilyResidualError(f"{name} must be finite and positive")
    for name in nonnegative_names:
        if float(getattr(args, name)) < 0:
            raise SharedHiddenFamilyResidualError(
                f"{name} must be finite and nonnegative"
            )
    if float(args.maximum_margin) not in MAX_MARGIN_CHOICES:
        raise SharedHiddenFamilyResidualError("maximum_margin must be one of 1, 2, 4")
    if args.base_family_ce_weight <= 0 or args.anchor_kl_weight <= 0:
        raise SharedHiddenFamilyResidualError(
            "base family CE and anchor KL must remain enabled"
        )
    if (
        args.base_family_ce_weight + args.anchor_kl_weight
        <= args.direct_family_ce_weight + args.page_body_ce_weight
    ):
        raise SharedHiddenFamilyResidualError(
            "combined base preservation must dominate direct/page auxiliary CE"
        )
    if (
        args.maximum_acceptable_regression > 0.005
        or args.maximum_preferred_regression > 0.005
        or args.maximum_family_regression > 0.0025
    ):
        raise SharedHiddenFamilyResidualError(
            "base regression thresholds may only match or tighten precommit gates"
        )
    if args.minimum_diagnostic_work_macro_improvement < 0.02:
        raise SharedHiddenFamilyResidualError(
            "diagnostic-worth improvement threshold cannot be weakened"
        )


def _base_train_indices(
    arrays: Mapping[str, np.ndarray], development_eval_work_ids: Sequence[str]
) -> np.ndarray:
    split = arrays["split"].astype(np.int64, copy=False)
    work_ids = arrays["work_ids"].astype(str)
    mask = (split == 0) & ~np.isin(work_ids, list(development_eval_work_ids))
    indices = np.flatnonzero(mask)
    if int(indices.size) != page_v3.EXPECTED_FAMILY_OVERRIDE_COUNTS["base_train_rows"]:
        raise SharedHiddenFamilyResidualError("base-train row inventory drifted")
    return indices


def _family_kl(torch: Any, candidate_logits: Any, anchor_logits: Any) -> Any:
    return torch.nn.functional.kl_div(
        torch.log_softmax(candidate_logits.float(), dim=1),
        torch.softmax(anchor_logits.float(), dim=1),
        reduction="batchmean",
    )


def _head_outputs_for_indices(
    torch: Any,
    model: Any,
    cache: Mapping[str, Any],
    indices: np.ndarray,
) -> Mapping[str, Any]:
    positions = torch.as_tensor(
        indices, dtype=torch.long, device=cache["hidden"].device
    )
    residual = model.residual_from_hidden(cache["hidden"][positions])
    return {
        "anchor_family_logits": cache["family_logits"][positions],
        "family_logits": cache["family_logits"][positions]
        + residual["family_logit_adjustment"],
        "family_margin_delta": residual["family_margin_delta"],
    }


def _optimization_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    indices: np.ndarray,
    labels: np.ndarray,
    row_weights: np.ndarray,
    family_ce_weight: float,
    anchor_kl_weight: float,
    residual_l2_weight: float,
    class_balanced: bool,
    gradient_clip: float,
) -> Mapping[str, float]:
    outputs = _head_outputs_for_indices(torch, model, cache, indices)
    device = cache["hidden"].device
    label_tensor = torch.from_numpy(labels.astype(np.int64, copy=False)).to(device)
    weight_tensor = torch.from_numpy(row_weights.astype(np.float32, copy=False)).to(
        device
    )
    if class_balanced:
        family_ce = page_v3.base_family_training_loss(
            torch,
            outputs["family_logits"],
            family_labels=label_tensor,
            family_label_weights=weight_tensor,
        )
    else:
        family_ce = page_v3.direct_family_loss(
            torch,
            outputs["family_logits"],
            family_labels=label_tensor,
            row_weights=weight_tensor,
        )
    anchor_kl = _family_kl(
        torch, outputs["family_logits"], outputs["anchor_family_logits"]
    )
    residual_l2 = outputs["family_margin_delta"].float().square().mean()
    loss = (
        float(family_ce_weight) * family_ce
        + float(anchor_kl_weight) * anchor_kl
        + float(residual_l2_weight) * residual_l2
    )
    if not bool(torch.isfinite(loss)):
        raise SharedHiddenFamilyResidualError("training loss became non-finite")
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(
        tuple(model.family_margin_head.parameters()), float(gradient_clip)
    )
    optimizer.step()
    return {
        "anchor_kl": float(anchor_kl.detach().item()),
        "family_ce": float(family_ce.detach().item()),
        "residual_l2": float(residual_l2.detach().item()),
        "total": float(loss.detach().item()),
    }


def _mean_losses(values: Sequence[Mapping[str, float]]) -> Mapping[str, float]:
    if not values:
        return {"anchor_kl": 0.0, "family_ce": 0.0, "residual_l2": 0.0, "total": 0.0}
    return {
        key: sum(float(row[key]) for row in values) / len(values)
        for key in ("anchor_kl", "family_ce", "residual_l2", "total")
    }


def _epoch_record(
    torch: Any,
    model: Any,
    *,
    epoch: int,
    cache: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    groups: Mapping[str, Any],
    candidate_ids: Sequence[str],
    margin_indices: np.ndarray,
    anchor_base_metrics: Mapping[str, Any],
    args: argparse.Namespace,
    mean_train_losses: Mapping[str, Any] | None,
    batch_consumption: Mapping[str, int],
) -> Mapping[str, Any]:
    base_metrics = _evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=arrays,
        candidate_ids=candidate_ids,
    )
    regression = page_v3.base_regression_checks(
        anchor_base_metrics,
        base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    train_metrics = _training_metrics(
        torch,
        model,
        cache=cache,
        groups=groups,
        candidate_ids=candidate_ids,
        margin_indices=margin_indices,
    )
    state_payload = _state_payload(_sidecar_state(model))
    record: dict[str, Any] = {
        "base_metrics": base_metrics,
        "base_no_material_regression": all(regression.values()),
        "base_regression_checks": regression,
        "batch_consumption": dict(batch_consumption),
        "checkpoint_selection_inputs": list(CHECKPOINT_SELECTION_INPUTS),
        "development_eval_consulted": False,
        "epoch": int(epoch),
        "sidecar_state": state_payload,
        "sidecar_state_sha256": hashlib.sha256(
            canonical_json(state_payload).encode("utf-8")
        ).hexdigest(),
        "training_only_selection_metrics": train_metrics,
    }
    if mean_train_losses is not None:
        record["mean_train_losses"] = dict(mean_train_losses)
    return record


def _context_contract(
    context: Mapping[str, Any], args: argparse.Namespace
) -> Mapping[str, Any]:
    anchor_dir = args.anchor_adapter_dir.expanduser().absolute().resolve()
    return {
        "anchor": {
            "checkpoint_sha256": page_v3.EXPECTED_ANCHOR_CHECKPOINT_SHA256,
            "directory": str(anchor_dir),
            "frozen": True,
            "initialization": _json_contract(context["initialization"]),
            "manifest_record_sha256": page_v3.EXPECTED_ANCHOR_MANIFEST_RECORD_SHA256,
            "manifest_sha256": page_v3.EXPECTED_ANCHOR_MANIFEST_SHA256,
            "tensor_count": EXPECTED_ANCHOR_TENSOR_COUNT,
            "tensor_inventory": _anchor_tensor_inventory(context["model"]),
        },
        "base_dataset": {
            "file": str(context["dataset_path"]),
            "sha256": page_v3.EXPECTED_BASE_NPZ_SHA256,
            "validation": _json_contract(context["inventory"]),
        },
        "overlay": {
            "directory": str(args.overlay_dir.expanduser().absolute().resolve()),
            "binding": _json_contract(context["overlay_binding"]),
        },
        "source_query_head": {
            "file": str(context["source_head"]),
            "sha256": page_v3.EXPECTED_SOURCE_QUERY_HEAD_SHA256,
        },
    }


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise SharedHiddenFamilyResidualError("PyTorch is required") from error
    _validate_options(args)
    context = _load_context(args, torch)
    device = torch.device("cpu")
    model = build_shared_hidden_family_residual(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
    ).to(device)
    cache = _build_frozen_cache(
        torch,
        context=context,
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    all_rows = np.arange(cache["hidden"].shape[0], dtype=np.int64)
    outputs = _family_outputs_from_cache(model, cache, all_rows)
    if not torch.equal(outputs["family_logits"], cache["family_logits"]):
        raise SharedHiddenFamilyResidualError(
            "zero-init family logits are not exact anchor"
        )
    if float(outputs["family_margin_delta"].abs().max().item()) != 0.0:
        raise SharedHiddenFamilyResidualError("zero-init residual is not exact zero")
    groups = context["groups"]
    direct_work_ids = _direct_work_ids(groups["direct_family"]["train"])
    page_work_ids = _page_work_ids(groups["train"])
    _, direct_schedule = _work_balanced_batches(
        direct_work_ids,
        batch_size=args.batch_size,
        seed=args.seed + 10_003 + 2,
    )
    _, page_schedule = _work_balanced_batches(
        page_work_ids,
        batch_size=args.batch_size,
        seed=args.seed + 10_003 + 3,
    )
    _, _, override = page_v3.build_family_override_contract(
        context["arrays"],
        groups["direct_family"],
        development_eval_work_ids=context["overlay_binding"][
            "development_eval_work_ids"
        ],
    )
    return {
        "anchor_tensor_count": len(context["model"].state_dict()),
        "base_row_count": int(len(context["arrays"]["split"])),
        "candidate_score_sha256": _candidate_score_sha256(cache),
        "context": _context_contract(context, args),
        "family_override": override,
        "maximum_margin": float(args.maximum_margin),
        "page_train_groups": len(groups["train"]),
        "page_work_balanced_epoch1_schedule": page_schedule,
        "sidecar_parameter_count": EXPECTED_TRAINABLE_PARAMETER_COUNT,
        "status": "ready_for_isolated_shared_hidden_family_residual_training",
        "train_direct_rows": len(groups["direct_family"]["train"]),
        "direct_work_balanced_epoch1_schedule": direct_schedule,
        "zero_init_exact_anchor": True,
    }


def _batches(
    indices: np.ndarray, *, batch_size: int, seed: int
) -> Sequence[np.ndarray]:
    generator = np.random.default_rng(seed)
    shuffled = np.array(indices, dtype=np.int64, copy=True)
    generator.shuffle(shuffled)
    return tuple(
        shuffled[start : start + batch_size]
        for start in range(0, len(shuffled), batch_size)
    )


def _direct_work_ids(rows: Sequence[Mapping[str, Any]]) -> np.ndarray:
    work_ids = np.asarray([str(row["work_id"]) for row in rows])
    if not len(work_ids) or any(not value for value in work_ids.tolist()):
        raise SharedHiddenFamilyResidualError("direct-family work inventory drifted")
    return work_ids


def _page_work_ids(groups: Sequence[Mapping[str, Any]]) -> np.ndarray:
    if not groups:
        raise SharedHiddenFamilyResidualError("page work inventory is empty")
    work_ids = np.concatenate(
        [np.full(len(group["row_indices"]), str(group["work_id"])) for group in groups]
    )
    if not len(work_ids) or any(not value for value in work_ids.tolist()):
        raise SharedHiddenFamilyResidualError("page work inventory drifted")
    return work_ids


def _direct_arrays(
    rows: Sequence[Mapping[str, Any]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    return (
        np.asarray([int(row["row_index"]) for row in rows], dtype=np.int64),
        np.asarray([int(row["family_label"]) for row in rows], dtype=np.int64),
        np.asarray(
            [float(row["supervision_weight"]) for row in rows], dtype=np.float32
        ),
        _direct_work_ids(rows),
    )


def _page_body_arrays(
    groups: Sequence[Mapping[str, Any]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    indices = np.concatenate([group["row_indices"] for group in groups]).astype(
        np.int64, copy=False
    )
    weights = np.concatenate([group["row_weights"] for group in groups]).astype(
        np.float32, copy=False
    )
    if len(indices) != len(set(int(value) for value in indices)):
        raise SharedHiddenFamilyResidualError("page-train rows are not unique")
    labels = np.full(len(indices), v8.BODY_FAMILY_INDEX, dtype=np.int64)
    work_ids = _page_work_ids(groups)
    return indices, labels, weights, work_ids


def _stable_schedule_seed(seed: int, work_id: str, cycle: int) -> int:
    digest = hashlib.sha256(f"{seed}\0{work_id}\0{cycle}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=False)


def _work_balanced_batches(
    work_ids: np.ndarray, *, batch_size: int, seed: int
) -> tuple[Sequence[np.ndarray], Mapping[str, Any]]:
    values = np.asarray(work_ids).astype(str)
    works = tuple(sorted(set(values.tolist())))
    if not works or batch_size < len(works):
        raise SharedHiddenFamilyResidualError(
            "work-balanced batch size must cover every training work"
        )
    rows_per_work_per_batch = max(1, batch_size // len(works))
    positions_by_work = {
        work_id: np.flatnonzero(values == work_id).astype(np.int64, copy=False)
        for work_id in works
    }
    if any(len(positions) < 1 for positions in positions_by_work.values()):
        raise SharedHiddenFamilyResidualError(
            "work-balanced schedule has an empty work"
        )
    maximum_rows = max(len(positions) for positions in positions_by_work.values())
    batch_count = math.ceil(maximum_rows / rows_per_work_per_batch)
    effective_rows_per_work = batch_count * rows_per_work_per_batch
    expanded: dict[str, np.ndarray] = {}
    for work_id, positions in positions_by_work.items():
        chunks: list[np.ndarray] = []
        consumed = 0
        cycle = 0
        while consumed < effective_rows_per_work:
            permutation = np.array(positions, copy=True)
            np.random.default_rng(_stable_schedule_seed(seed, work_id, cycle)).shuffle(
                permutation
            )
            take = min(len(permutation), effective_rows_per_work - consumed)
            chunks.append(permutation[:take])
            consumed += take
            cycle += 1
        expanded[work_id] = np.concatenate(chunks)
    batches: list[np.ndarray] = []
    for batch_index in range(batch_count):
        start = batch_index * rows_per_work_per_batch
        stop = start + rows_per_work_per_batch
        batch = np.concatenate([expanded[work][start:stop] for work in works])
        np.random.default_rng(seed + batch_index * 7_919).shuffle(batch)
        batches.append(batch)
    effective_rows = effective_rows_per_work * len(works)
    return tuple(batches), {
        "algorithm": "equal_rows_per_work_deterministic_cycle_v1",
        "batch_count": batch_count,
        "effective_rows": effective_rows,
        "effective_rows_per_work": effective_rows_per_work,
        "oversampled_rows": effective_rows - len(values),
        "rows_per_work_per_batch": rows_per_work_per_batch,
        "supervision_weight_normalization": "each_work_sum_one_per_batch",
        "unique_rows": int(len(values)),
        "work_count": len(works),
        "work_ids": list(works),
    }


def _normalize_work_weights(weights: np.ndarray, work_ids: np.ndarray) -> np.ndarray:
    result = np.asarray(weights, dtype=np.float32).copy()
    works = np.asarray(work_ids).astype(str)
    for work_id in sorted(set(works.tolist())):
        mask = works == work_id
        total = float(result[mask].sum())
        if not math.isfinite(total) or total <= 0:
            raise SharedHiddenFamilyResidualError(
                "work-balanced supervision weights drifted"
            )
        result[mask] /= total
    return result


def _batch_from_positions(
    indices: np.ndarray,
    labels: np.ndarray,
    weights: np.ndarray,
    work_ids: np.ndarray,
    positions: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    selected_work_ids = work_ids[positions]
    return (
        indices[positions],
        labels[positions],
        _normalize_work_weights(weights[positions], selected_work_ids),
    )


def _diagnostic_worth_checks(
    *,
    anchor_train: Mapping[str, Any],
    candidate_train: Mapping[str, Any],
    base_no_material_regression: bool,
    minimum_improvement: float,
) -> Mapping[str, bool]:
    anchor_work = anchor_train["direct_family"]["work_macro"]
    candidate_work = candidate_train["direct_family"]["work_macro"]
    return {
        "base_no_material_regression": bool(base_no_material_regression),
        "train_work_macro_balanced_accuracy_improved_by_required_margin": (
            float(candidate_work["balanced_accuracy"])
            >= float(anchor_work["balanced_accuracy"]) + float(minimum_improvement)
        ),
        "train_work_macro_body_accuracy_improved_by_required_margin": (
            float(candidate_work["body_accuracy"])
            >= float(anchor_work["body_accuracy"]) + float(minimum_improvement)
        ),
    }


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise SharedHiddenFamilyResidualError(
            "PyTorch and safetensors are required"
        ) from error
    _validate_options(args)
    output = _safe_new_output(args.output_dir)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise SharedHiddenFamilyResidualError("CUDA was requested but is unavailable")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)

    started = time.monotonic()
    context = _load_context(args, torch)
    arrays = context["arrays"]
    groups = context["groups"]
    candidate_ids = tuple(context["candidate_ids"])
    model = build_shared_hidden_family_residual(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
    ).to("cpu")
    # Compute the immutable anchor cache on CPU for a device-independent sealed
    # input boundary, then copy those exact bytes to the requested optimizer
    # device.  Only the 65-parameter sidecar performs device-specific math.
    cpu_cache = _build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
    )
    candidate_score_sha256 = _candidate_score_sha256(cpu_cache)
    model.to(device)
    cache = {
        name: value.to(device) if device.type != "cpu" else value
        for name, value in cpu_cache.items()
    }
    development_eval_work_ids = tuple(
        context["overlay_binding"]["development_eval_work_ids"]
    )
    family_labels, family_weights, family_override = (
        page_v3.build_family_override_contract(
            arrays,
            groups["direct_family"],
            development_eval_work_ids=development_eval_work_ids,
        )
    )
    base_indices = _base_train_indices(arrays, development_eval_work_ids)
    direct_indices, direct_labels, direct_weights, direct_work_ids = _direct_arrays(
        groups["direct_family"]["train"]
    )
    page_indices, page_labels, page_weights, page_work_ids = _page_body_arrays(
        groups["train"]
    )
    if set(int(value) for value in direct_indices) - set(
        int(value) for value in base_indices
    ) or set(int(value) for value in page_indices) - set(
        int(value) for value in direct_indices
    ):
        raise SharedHiddenFamilyResidualError(
            "training overlay escaped base-train rows"
        )

    optimizer = torch.optim.AdamW(
        tuple(model.family_margin_head.parameters()),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    anchor_base_metrics = _evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=arrays,
        candidate_ids=candidate_ids,
    )
    zero_batch_consumption = {
        "base_batches": 0,
        "base_rows": 0,
        "development_eval_rows": 0,
        "direct_batches": 0,
        "direct_rows": 0,
        "direct_schedule": None,
        "page_batches": 0,
        "page_rows": 0,
        "page_schedule": None,
    }
    history: list[Mapping[str, Any]] = [
        _epoch_record(
            torch,
            model,
            epoch=0,
            cache=cache,
            arrays=arrays,
            groups=groups,
            candidate_ids=candidate_ids,
            margin_indices=base_indices,
            anchor_base_metrics=anchor_base_metrics,
            args=args,
            mean_train_losses=None,
            batch_consumption=zero_batch_consumption,
        )
    ]
    best_record = history[0]
    best_key = _selection_key(
        best_record["base_metrics"],
        best_record["base_regression_checks"],
        best_record["training_only_selection_metrics"],
    )
    best_state = _sidecar_state(model)

    for epoch in range(1, args.epochs + 1):
        model.train()
        model.anchor_model.eval()
        base_losses: list[Mapping[str, float]] = []
        direct_losses: list[Mapping[str, float]] = []
        page_losses: list[Mapping[str, float]] = []
        base_batches = _batches(
            base_indices,
            batch_size=args.batch_size,
            seed=args.seed + epoch * 10_003 + 1,
        )
        for batch in base_batches:
            base_losses.append(
                _optimization_step(
                    torch,
                    model,
                    optimizer,
                    cache=cache,
                    indices=batch,
                    labels=family_labels[batch],
                    row_weights=family_weights[batch],
                    family_ce_weight=args.base_family_ce_weight,
                    anchor_kl_weight=args.anchor_kl_weight,
                    residual_l2_weight=args.residual_l2_weight,
                    class_balanced=True,
                    gradient_clip=args.gradient_clip,
                )
            )
        direct_batches, direct_schedule = _work_balanced_batches(
            direct_work_ids,
            batch_size=args.batch_size,
            seed=args.seed + epoch * 10_003 + 2,
        )
        for positions in direct_batches:
            batch_indices, batch_labels, batch_weights = _batch_from_positions(
                direct_indices,
                direct_labels,
                direct_weights,
                direct_work_ids,
                positions,
            )
            direct_losses.append(
                _optimization_step(
                    torch,
                    model,
                    optimizer,
                    cache=cache,
                    indices=batch_indices,
                    labels=batch_labels,
                    row_weights=batch_weights,
                    family_ce_weight=args.direct_family_ce_weight,
                    anchor_kl_weight=args.anchor_kl_weight,
                    residual_l2_weight=args.residual_l2_weight,
                    class_balanced=False,
                    gradient_clip=args.gradient_clip,
                )
            )
        page_batches, page_schedule = _work_balanced_batches(
            page_work_ids,
            batch_size=args.batch_size,
            seed=args.seed + epoch * 10_003 + 3,
        )
        for positions in page_batches:
            batch_indices, batch_labels, batch_weights = _batch_from_positions(
                page_indices,
                page_labels,
                page_weights,
                page_work_ids,
                positions,
            )
            page_losses.append(
                _optimization_step(
                    torch,
                    model,
                    optimizer,
                    cache=cache,
                    indices=batch_indices,
                    labels=batch_labels,
                    row_weights=batch_weights,
                    family_ce_weight=args.page_body_ce_weight,
                    anchor_kl_weight=args.anchor_kl_weight,
                    residual_l2_weight=args.residual_l2_weight,
                    class_balanced=False,
                    gradient_clip=args.gradient_clip,
                )
            )
        mean_losses = {
            "base": _mean_losses(base_losses),
            "direct_family": _mean_losses(direct_losses),
            "page_body": _mean_losses(page_losses),
        }
        consumption = {
            "base_batches": len(base_batches),
            "base_rows": int(sum(len(batch) for batch in base_batches)),
            "development_eval_rows": 0,
            "direct_batches": len(direct_batches),
            "direct_rows": int(sum(len(batch) for batch in direct_batches)),
            "direct_schedule": direct_schedule,
            "page_batches": len(page_batches),
            "page_rows": int(sum(len(batch) for batch in page_batches)),
            "page_schedule": page_schedule,
        }
        record = _epoch_record(
            torch,
            model,
            epoch=epoch,
            cache=cache,
            arrays=arrays,
            groups=groups,
            candidate_ids=candidate_ids,
            margin_indices=base_indices,
            anchor_base_metrics=anchor_base_metrics,
            args=args,
            mean_train_losses=mean_losses,
            batch_consumption=consumption,
        )
        history.append(record)
        key = _selection_key(
            record["base_metrics"],
            record["base_regression_checks"],
            record["training_only_selection_metrics"],
        )
        if key > best_key:
            best_key = key
            best_record = record
            best_state = _sidecar_state(model)

    _apply_sidecar_state(model, best_state)
    selected_epoch = int(best_record["epoch"])
    selected_base_metrics = _evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=arrays,
        candidate_ids=candidate_ids,
    )
    selected_base_regression = page_v3.base_regression_checks(
        anchor_base_metrics,
        selected_base_metrics,
        maximum_acceptable_regression=args.maximum_acceptable_regression,
        maximum_preferred_regression=args.maximum_preferred_regression,
        maximum_family_regression=args.maximum_family_regression,
    )
    selected_train_metrics = _training_metrics(
        torch,
        model,
        cache=cache,
        groups=groups,
        candidate_ids=candidate_ids,
        margin_indices=base_indices,
    )
    development_direct = _direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=groups["direct_family"]["development_eval"],
    )
    development_page = _overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=groups["development_eval"],
        candidate_ids=candidate_ids,
    )
    anchor_state = _state_from_payload(torch, history[0]["sidecar_state"])
    selected_state = _sidecar_state(model)
    _apply_sidecar_state(model, anchor_state)
    anchor_train_metrics = _training_metrics(
        torch,
        model,
        cache=cache,
        groups=groups,
        candidate_ids=candidate_ids,
        margin_indices=base_indices,
    )
    anchor_development_direct = _direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=groups["direct_family"]["development_eval"],
    )
    anchor_development_page = _overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=groups["development_eval"],
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, selected_state)
    diagnostic_checks = _diagnostic_worth_checks(
        anchor_train=anchor_train_metrics,
        candidate_train=selected_train_metrics,
        base_no_material_regression=all(selected_base_regression.values()),
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
    )

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
        context_contract = _context_contract(context, args)
        configuration = {
            "anchor_kl_weight": float(args.anchor_kl_weight),
            "base_family_ce_weight": float(args.base_family_ce_weight),
            "batch_size": int(args.batch_size),
            "device": str(args.device),
            "direct_family_ce_weight": float(args.direct_family_ce_weight),
            "epochs": int(args.epochs),
            "evaluation_batch_size": int(args.evaluation_batch_size),
            "gradient_clip": float(args.gradient_clip),
            "learning_rate": float(args.learning_rate),
            "maximum_acceptable_regression": float(args.maximum_acceptable_regression),
            "maximum_family_regression": float(args.maximum_family_regression),
            "maximum_margin": float(args.maximum_margin),
            "maximum_preferred_regression": float(args.maximum_preferred_regression),
            "minimum_diagnostic_work_macro_improvement": float(
                args.minimum_diagnostic_work_macro_improvement
            ),
            "page_body_ce_weight": float(args.page_body_ce_weight),
            "residual_l2_weight": float(args.residual_l2_weight),
            "seed": int(args.seed),
            "weight_decay": float(args.weight_decay),
        }
        manifest = seal_record(
            {
                "anchor": context_contract["anchor"],
                "architecture": {
                    "anchor_tensor_count": EXPECTED_ANCHOR_TENSOR_COUNT,
                    "family_logit_adjustment": "+margin/2 body, -margin/2 variant",
                    "family_margin_formula": "B*tanh(raw_margin/B)",
                    "hidden_dimension": EXPECTED_HIDDEN_DIM,
                    "hidden_source": (
                        "frozen_sample_candidate_norm_then_Linear1024x64_then_GELU"
                    ),
                    "maximum_margin": float(args.maximum_margin),
                    "sidecar_parameter_count": EXPECTED_TRAINABLE_PARAMETER_COUNT,
                    "sidecar_tensor_count": len(EXPECTED_SIDECAR_TENSORS),
                    "zero_initialization_exact_anchor": True,
                },
                "authority": dict(EXPECTED_AUTHORITY),
                "base_dataset": context_contract["base_dataset"],
                "base_metrics": {
                    "anchor": anchor_base_metrics,
                    "candidate": selected_base_metrics,
                    "regression_checks": selected_base_regression,
                },
                "candidate_ids": list(candidate_ids),
                "candidate_score_invariance": {
                    "anchor_three_output_sha256": candidate_score_sha256,
                    "body_candidate_scores_byte_exact": True,
                    "internal_soft_gate_candidate_scores_byte_exact": True,
                    "internal_soft_gate_candidate_scores_evaluated": False,
                    "public_onnx_candidate_scores_contract": (
                        "candidate_scores_is_body_candidate_scores_alias"
                    ),
                    "strict_metrics_use_hard_family_route": True,
                    "three_output_sha256": candidate_score_sha256,
                    "variant_candidate_scores_byte_exact": True,
                },
                "configuration": configuration,
                "development_diagnostics": {
                    "consulted_after_winner_selection_only": True,
                    "direct_family": {
                        "anchor": anchor_development_direct,
                        "candidate": development_direct,
                    },
                    "gradient_rows": 0,
                    "page_consistency": {
                        "anchor": anchor_development_page,
                        "candidate": development_page,
                    },
                    "used_for_checkpoint_selection": False,
                },
                "diagnostic_worth": {
                    "checks": diagnostic_checks,
                    "passed": all(diagnostic_checks.values()),
                    "promotion_authority": False,
                },
                "direct_family_metrics": {
                    "anchor_train": anchor_train_metrics["direct_family"],
                    "candidate_train": selected_train_metrics["direct_family"],
                },
                "family_override": family_override,
                "files": {
                    SIDECAR_FILE: {
                        "byte_size": sidecar_path.stat().st_size,
                        "sha256": sha256_file(sidecar_path),
                        "tensor_inventory": _tensor_inventory(selected_state),
                    }
                },
                "history": history,
                "overlay": context_contract["overlay"],
                "overlay_metrics": {
                    "anchor_train": anchor_train_metrics["page_consistency"],
                    "candidate_train": selected_train_metrics["page_consistency"],
                },
                "record_type": "manga_font_v3_shared_hidden_family_residual_manifest",
                "runtime_boundary": dict(EXPECTED_RUNTIME_BOUNDARY),
                "schema_version": SCHEMA_VERSION,
                "selection": {
                    "anchor_fallback_selected": selected_epoch == 0,
                    "base_gradient_rows": int(len(base_indices)),
                    "best_epoch": selected_epoch,
                    "development_eval_consulted_during_checkpoint_selection": False,
                    "development_eval_gradient_rows": 0,
                    "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
                    "direct_family_gradient_rows": int(len(direct_indices)),
                    "model_selection_label_sources": list(
                        MODEL_SELECTION_LABEL_SOURCES
                    ),
                    "page_consistency_gradient_groups": int(len(groups["train"])),
                    "page_consistency_gradient_rows": int(len(page_indices)),
                    "selection_key_order": list(SELECTION_KEY_ORDER),
                },
                "source_query_head": context_contract["source_query_head"],
                "trainable_parameters": {
                    "anchor_parameter_count": sum(
                        value.numel() for value in model.anchor_model.parameters()
                    ),
                    "anchor_parameter_names": sorted(
                        name for name, _value in model.anchor_model.named_parameters()
                    ),
                    "anchor_parameters_frozen": True,
                    "sidecar_parameter_count": EXPECTED_TRAINABLE_PARAMETER_COUNT,
                    "sidecar_parameter_names": sorted(EXPECTED_SIDECAR_TENSORS),
                },
                # Windows' monotonic clock can legitimately return the same tick
                # for a tiny synthetic run.  Keep the producer inside the strict
                # positive-duration contract without relaxing the validator.
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
    anchor = _mapping(manifest["anchor"], "manifest anchor")
    base = _mapping(manifest["base_dataset"], "manifest base dataset")
    overlay = _mapping(manifest["overlay"], "manifest overlay")
    source = _mapping(manifest["source_query_head"], "manifest source query head")
    values = dict(configuration)
    values.update(
        {
            "anchor_adapter_dir": Path(str(anchor["directory"])),
            "base_npz": Path(str(base["file"])),
            "overlay_dir": Path(str(overlay["directory"])),
            "source_query_head": Path(str(source["file"])),
        }
    )
    return argparse.Namespace(**values)


def _validate_mean_losses(value: Any, location: str) -> None:
    losses = _mapping(value, location)
    if set(losses) != {"base", "direct_family", "page_body"}:
        raise SharedHiddenFamilyResidualError(
            f"{location}: objective inventory drifted"
        )
    for objective, raw in losses.items():
        fields = _mapping(raw, f"{location}.{objective}")
        if set(fields) != {"anchor_kl", "family_ce", "residual_l2", "total"}:
            raise SharedHiddenFamilyResidualError(
                f"{location}.{objective}: loss inventory drifted"
            )
        if any(
            isinstance(number, bool)
            or not isinstance(number, (int, float))
            or not math.isfinite(float(number))
            or float(number) < 0
            for number in fields.values()
        ):
            raise SharedHiddenFamilyResidualError(
                f"{location}.{objective}: invalid loss"
            )


def _expected_batch_consumption(
    *,
    epoch: int,
    base_rows: int,
    direct_work_ids: np.ndarray,
    page_work_ids: np.ndarray,
    batch_size: int,
    seed: int,
) -> Mapping[str, Any]:
    if epoch == 0:
        return {
            "base_batches": 0,
            "base_rows": 0,
            "development_eval_rows": 0,
            "direct_batches": 0,
            "direct_rows": 0,
            "direct_schedule": None,
            "page_batches": 0,
            "page_rows": 0,
            "page_schedule": None,
        }
    direct_batches, direct_schedule = _work_balanced_batches(
        direct_work_ids,
        batch_size=batch_size,
        seed=seed + epoch * 10_003 + 2,
    )
    page_batches, page_schedule = _work_balanced_batches(
        page_work_ids,
        batch_size=batch_size,
        seed=seed + epoch * 10_003 + 3,
    )
    return {
        "base_batches": math.ceil(base_rows / batch_size),
        "base_rows": base_rows,
        "development_eval_rows": 0,
        "direct_batches": len(direct_batches),
        "direct_rows": sum(len(batch) for batch in direct_batches),
        "direct_schedule": direct_schedule,
        "page_batches": len(page_batches),
        "page_rows": sum(len(batch) for batch in page_batches),
        "page_schedule": page_schedule,
    }


def _strict_history_recompute(
    torch: Any,
    *,
    manifest: Mapping[str, Any],
    configuration: Mapping[str, Any],
    model: Any,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    base_indices: np.ndarray,
    anchor_base_metrics: Mapping[str, Any],
) -> tuple[int, Mapping[str, Any], Mapping[str, Any]]:
    history = manifest.get("history")
    epochs = int(configuration["epochs"])
    if (
        not isinstance(history, Sequence)
        or isinstance(history, (str, bytes))
        or len(history) != epochs + 1
    ):
        raise SharedHiddenFamilyResidualError("history inventory drifted")
    groups = context["groups"]
    candidate_ids = tuple(context["candidate_ids"])
    direct_work_ids = _direct_work_ids(groups["direct_family"]["train"])
    page_work_ids = _page_work_ids(groups["train"])
    best_index = 0
    best_key: tuple[float, ...] | None = None
    selected_state: Mapping[str, Any] | None = None
    selected_record: Mapping[str, Any] | None = None
    for expected_epoch, raw_record in enumerate(history):
        record = _mapping(raw_record, f"history[{expected_epoch}]")
        expected_keys = {
            "base_metrics",
            "base_no_material_regression",
            "base_regression_checks",
            "batch_consumption",
            "checkpoint_selection_inputs",
            "development_eval_consulted",
            "epoch",
            "sidecar_state",
            "sidecar_state_sha256",
            "training_only_selection_metrics",
        }
        if expected_epoch > 0:
            expected_keys.add("mean_train_losses")
        if set(record) != expected_keys or record.get("epoch") != expected_epoch:
            raise SharedHiddenFamilyResidualError(
                f"history[{expected_epoch}] inventory drifted"
            )
        if (
            record.get("checkpoint_selection_inputs")
            != list(CHECKPOINT_SELECTION_INPUTS)
            or record.get("development_eval_consulted") is not False
        ):
            raise SharedHiddenFamilyResidualError(
                f"history[{expected_epoch}] consulted forbidden diagnostics"
            )
        expected_consumption = _expected_batch_consumption(
            epoch=expected_epoch,
            base_rows=len(base_indices),
            direct_work_ids=direct_work_ids,
            page_work_ids=page_work_ids,
            batch_size=int(configuration["batch_size"]),
            seed=int(configuration["seed"]),
        )
        if record.get("batch_consumption") != expected_consumption:
            raise SharedHiddenFamilyResidualError(
                f"history[{expected_epoch}] batch consumption drifted"
            )
        if expected_epoch > 0:
            _validate_mean_losses(
                record.get("mean_train_losses"),
                f"history[{expected_epoch}].mean_train_losses",
            )
        payload = _mapping(
            record.get("sidecar_state"), f"history[{expected_epoch}].sidecar_state"
        )
        state_sha256 = hashlib.sha256(
            canonical_json(payload).encode("utf-8")
        ).hexdigest()
        if record.get("sidecar_state_sha256") != state_sha256:
            raise SharedHiddenFamilyResidualError(
                f"history[{expected_epoch}] sidecar state seal drifted"
            )
        state = _state_from_payload(torch, payload)
        if expected_epoch == 0 and any(
            bool(torch.count_nonzero(value)) for value in state.values()
        ):
            raise SharedHiddenFamilyResidualError(
                "epoch zero sidecar is not exact zero"
            )
        _apply_sidecar_state(model, state)
        base_metrics = _evaluate_base_from_cache(
            torch,
            model,
            cache=cache,
            arrays=context["arrays"],
            candidate_ids=candidate_ids,
        )
        regression = page_v3.base_regression_checks(
            anchor_base_metrics,
            base_metrics,
            maximum_acceptable_regression=float(
                configuration["maximum_acceptable_regression"]
            ),
            maximum_preferred_regression=float(
                configuration["maximum_preferred_regression"]
            ),
            maximum_family_regression=float(configuration["maximum_family_regression"]),
        )
        train_metrics = _training_metrics(
            torch,
            model,
            cache=cache,
            groups=groups,
            candidate_ids=candidate_ids,
            margin_indices=base_indices,
        )
        _assert_nested_close(
            record.get("base_metrics"),
            base_metrics,
            f"history[{expected_epoch}].base_metrics",
        )
        if record.get("base_regression_checks") != regression or record.get(
            "base_no_material_regression"
        ) is not all(regression.values()):
            raise SharedHiddenFamilyResidualError(
                f"history[{expected_epoch}] base regression claim drifted"
            )
        _assert_nested_close(
            record.get("training_only_selection_metrics"),
            train_metrics,
            f"history[{expected_epoch}].training_only_selection_metrics",
        )
        key = _selection_key(base_metrics, regression, train_metrics)
        if best_key is None or key > best_key:
            best_key = key
            best_index = expected_epoch
            selected_state = state
            selected_record = record
    if selected_state is None or selected_record is None:
        raise SharedHiddenFamilyResidualError("history selection failed")
    return best_index, selected_state, selected_record


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise SharedHiddenFamilyResidualError("PyTorch is required") from error
    expanded = output_dir.expanduser().absolute()
    if overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise SharedHiddenFamilyResidualError("output cannot be linked or reparsed")
    root = expanded.resolve()
    if (
        not root.is_dir()
        or overlay_v3._contains_link_or_reparse(root)
        or {path.name for path in root.iterdir()} != OUTPUT_FILES
    ):
        raise SharedHiddenFamilyResidualError("output inventory drifted")
    marker_path = root / MARKER_FILE
    manifest_path = root / MANIFEST_FILE
    sidecar_path = root / SIDECAR_FILE
    marker = _read_json(marker_path, "ownership marker")
    manifest = _read_json(manifest_path, "manifest")
    validate_record_seal(marker, "ownership marker")
    validate_record_seal(manifest, "manifest")
    if set(marker) != {
        "artifacts",
        "owner",
        "record_sha256",
        "safe_replace",
        "schema_version",
    }:
        raise SharedHiddenFamilyResidualError("ownership marker inventory drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not False
        or set(marker_artifacts) != {MANIFEST_FILE, SIDECAR_FILE}
        or marker_artifacts.get(MANIFEST_FILE) != sha256_file(manifest_path)
        or marker_artifacts.get(SIDECAR_FILE) != sha256_file(sidecar_path)
    ):
        raise SharedHiddenFamilyResidualError("ownership marker binding drifted")
    if (
        set(manifest) != EXPECTED_MANIFEST_KEYS
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v3_shared_hidden_family_residual_manifest"
        or manifest.get("authority") != EXPECTED_AUTHORITY
        or manifest.get("runtime_boundary") != EXPECTED_RUNTIME_BOUNDARY
    ):
        raise SharedHiddenFamilyResidualError("manifest authority or schema drifted")
    training_seconds = manifest.get("training_seconds")
    if (
        isinstance(training_seconds, bool)
        or not isinstance(training_seconds, (int, float))
        or not math.isfinite(float(training_seconds))
        or float(training_seconds) <= 0
    ):
        raise SharedHiddenFamilyResidualError("training seconds drifted")
    configuration = _mapping(manifest.get("configuration"), "configuration")
    if set(configuration) != EXPECTED_CONFIGURATION_KEYS:
        raise SharedHiddenFamilyResidualError("configuration inventory drifted")
    args = _configuration_args(manifest, configuration)
    _validate_options(args)
    if configuration.get("device") not in {"cpu", "cuda"}:
        raise SharedHiddenFamilyResidualError("training device claim drifted")

    files = _mapping(manifest.get("files"), "manifest files")
    if set(files) != {SIDECAR_FILE}:
        raise SharedHiddenFamilyResidualError("manifest file inventory drifted")
    descriptor = _mapping(files[SIDECAR_FILE], "sidecar descriptor")
    if set(descriptor) != {"byte_size", "sha256", "tensor_inventory"} or (
        descriptor.get("byte_size") != sidecar_path.stat().st_size
        or descriptor.get("sha256") != sha256_file(sidecar_path)
    ):
        raise SharedHiddenFamilyResidualError("sidecar descriptor drifted")
    checkpoint_state = _load_sidecar_state(torch, sidecar_path)
    if descriptor.get("tensor_inventory") != _tensor_inventory(checkpoint_state):
        raise SharedHiddenFamilyResidualError("sidecar tensor inventory drifted")

    context = _load_context(args, torch)
    expected_context = _context_contract(context, args)
    for key in ("anchor", "base_dataset", "overlay", "source_query_head"):
        if manifest.get(key) != expected_context[key]:
            raise SharedHiddenFamilyResidualError(f"{key} binding drifted")
    candidate_ids = tuple(context["candidate_ids"])
    if manifest.get("candidate_ids") != list(candidate_ids):
        raise SharedHiddenFamilyResidualError("candidate IDs drifted")
    architecture = {
        "anchor_tensor_count": EXPECTED_ANCHOR_TENSOR_COUNT,
        "family_logit_adjustment": "+margin/2 body, -margin/2 variant",
        "family_margin_formula": "B*tanh(raw_margin/B)",
        "hidden_dimension": EXPECTED_HIDDEN_DIM,
        "hidden_source": "frozen_sample_candidate_norm_then_Linear1024x64_then_GELU",
        "maximum_margin": float(configuration["maximum_margin"]),
        "sidecar_parameter_count": EXPECTED_TRAINABLE_PARAMETER_COUNT,
        "sidecar_tensor_count": len(EXPECTED_SIDECAR_TENSORS),
        "zero_initialization_exact_anchor": True,
    }
    if manifest.get("architecture") != architecture:
        raise SharedHiddenFamilyResidualError("residual architecture drifted")

    model = build_shared_hidden_family_residual(
        torch,
        anchor_model=context["model"],
        maximum_margin=float(configuration["maximum_margin"]),
    ).to("cpu")
    expected_trainable = {
        "anchor_parameter_count": sum(
            value.numel() for value in model.anchor_model.parameters()
        ),
        "anchor_parameter_names": sorted(
            name for name, _value in model.anchor_model.named_parameters()
        ),
        "anchor_parameters_frozen": True,
        "sidecar_parameter_count": EXPECTED_TRAINABLE_PARAMETER_COUNT,
        "sidecar_parameter_names": sorted(EXPECTED_SIDECAR_TENSORS),
    }
    if manifest.get("trainable_parameters") != expected_trainable or any(
        parameter.requires_grad for parameter in model.anchor_model.parameters()
    ):
        raise SharedHiddenFamilyResidualError("trainable parameter boundary drifted")
    cache = _build_frozen_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(configuration["evaluation_batch_size"]),
    )
    candidate_sha256 = _candidate_score_sha256(cache)
    expected_candidate_invariance = {
        "anchor_three_output_sha256": candidate_sha256,
        "body_candidate_scores_byte_exact": True,
        "internal_soft_gate_candidate_scores_byte_exact": True,
        "internal_soft_gate_candidate_scores_evaluated": False,
        "public_onnx_candidate_scores_contract": (
            "candidate_scores_is_body_candidate_scores_alias"
        ),
        "strict_metrics_use_hard_family_route": True,
        "three_output_sha256": candidate_sha256,
        "variant_candidate_scores_byte_exact": True,
    }
    if manifest.get("candidate_score_invariance") != expected_candidate_invariance:
        raise SharedHiddenFamilyResidualError("candidate score invariance drifted")
    groups = context["groups"]
    _, _, family_override = page_v3.build_family_override_contract(
        context["arrays"],
        groups["direct_family"],
        development_eval_work_ids=context["overlay_binding"][
            "development_eval_work_ids"
        ],
    )
    if manifest.get("family_override") != family_override:
        raise SharedHiddenFamilyResidualError("family override contract drifted")
    base_indices = _base_train_indices(
        context["arrays"], context["overlay_binding"]["development_eval_work_ids"]
    )
    anchor_base_metrics = _evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    best_epoch, selected_state, selected_record = _strict_history_recompute(
        torch,
        manifest=manifest,
        configuration=configuration,
        model=model,
        cache=cache,
        context=context,
        base_indices=base_indices,
        anchor_base_metrics=anchor_base_metrics,
    )
    selection = _mapping(manifest.get("selection"), "selection")
    if set(selection) != EXPECTED_SELECTION_KEYS:
        raise SharedHiddenFamilyResidualError("selection inventory drifted")
    page_rows = sum(len(group["row_indices"]) for group in groups["train"])
    expected_selection = {
        "anchor_fallback_selected": best_epoch == 0,
        "base_gradient_rows": int(len(base_indices)),
        "best_epoch": best_epoch,
        "development_eval_consulted_during_checkpoint_selection": False,
        "development_eval_gradient_rows": 0,
        "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
        "direct_family_gradient_rows": len(groups["direct_family"]["train"]),
        "model_selection_label_sources": list(MODEL_SELECTION_LABEL_SOURCES),
        "page_consistency_gradient_groups": len(groups["train"]),
        "page_consistency_gradient_rows": page_rows,
        "selection_key_order": list(SELECTION_KEY_ORDER),
    }
    if selection != expected_selection:
        raise SharedHiddenFamilyResidualError("selection claim drifted")
    checkpoint_payload = _state_payload(checkpoint_state)
    selected_payload = _state_payload(selected_state)
    if checkpoint_payload != selected_payload:
        raise SharedHiddenFamilyResidualError(
            "exported sidecar is not the selected history state"
        )
    if best_epoch == 0 and any(
        bool(torch.count_nonzero(value)) for value in checkpoint_state.values()
    ):
        raise SharedHiddenFamilyResidualError(
            "anchor fallback sidecar is not exact zero"
        )

    _apply_sidecar_state(model, selected_state)
    selected_base_metrics = _evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    selected_regression = page_v3.base_regression_checks(
        anchor_base_metrics,
        selected_base_metrics,
        maximum_acceptable_regression=float(
            configuration["maximum_acceptable_regression"]
        ),
        maximum_preferred_regression=float(
            configuration["maximum_preferred_regression"]
        ),
        maximum_family_regression=float(configuration["maximum_family_regression"]),
    )
    selected_train = _training_metrics(
        torch,
        model,
        cache=cache,
        groups=groups,
        candidate_ids=candidate_ids,
        margin_indices=base_indices,
    )
    zero_state = _state_from_payload(torch, manifest["history"][0]["sidecar_state"])
    _apply_sidecar_state(model, zero_state)
    anchor_train = _training_metrics(
        torch,
        model,
        cache=cache,
        groups=groups,
        candidate_ids=candidate_ids,
        margin_indices=base_indices,
    )
    anchor_dev_direct = _direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=groups["direct_family"]["development_eval"],
    )
    anchor_dev_page = _overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=groups["development_eval"],
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, selected_state)
    selected_dev_direct = _direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=groups["direct_family"]["development_eval"],
    )
    selected_dev_page = _overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=groups["development_eval"],
        candidate_ids=candidate_ids,
    )
    expected_base = {
        "anchor": anchor_base_metrics,
        "candidate": selected_base_metrics,
        "regression_checks": selected_regression,
    }
    _assert_nested_close(manifest.get("base_metrics"), expected_base, "base metrics")
    _assert_nested_close(
        manifest.get("direct_family_metrics"),
        {
            "anchor_train": anchor_train["direct_family"],
            "candidate_train": selected_train["direct_family"],
        },
        "direct-family metrics",
    )
    _assert_nested_close(
        manifest.get("overlay_metrics"),
        {
            "anchor_train": anchor_train["page_consistency"],
            "candidate_train": selected_train["page_consistency"],
        },
        "overlay metrics",
    )
    expected_development = {
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
    }
    _assert_nested_close(
        manifest.get("development_diagnostics"),
        expected_development,
        "development diagnostics",
    )
    checks = _diagnostic_worth_checks(
        anchor_train=anchor_train,
        candidate_train=selected_train,
        base_no_material_regression=all(selected_regression.values()),
        minimum_improvement=float(
            configuration["minimum_diagnostic_work_macro_improvement"]
        ),
    )
    expected_worth = {
        "checks": checks,
        "passed": all(checks.values()),
        "promotion_authority": False,
    }
    if manifest.get("diagnostic_worth") != expected_worth:
        raise SharedHiddenFamilyResidualError("diagnostic-worth claim drifted")
    return {
        "best_epoch": best_epoch,
        "candidate_score_sha256": candidate_sha256,
        "diagnostic_worth": all(checks.values()),
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(manifest_path),
        "output_dir": str(root),
        "read_only_recomputation": True,
        "schema_version": SCHEMA_VERSION,
        "sidecar_sha256": sha256_file(sidecar_path),
        "status": "valid_nonpromotable_shared_hidden_family_residual",
    }


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    validation = validate_output(args.output_dir)
    return {
        **validation,
        "evaluation_authority": False,
        "note": "strict CPU recomputation only; development labels remain diagnostic-only",
    }


def _add_shared_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-npz", type=Path, default=DEFAULT_BASE_NPZ)
    parser.add_argument("--overlay-dir", type=Path, default=DEFAULT_OVERLAY_DIR)
    parser.add_argument("--anchor-adapter-dir", type=Path, default=DEFAULT_ANCHOR_DIR)
    parser.add_argument(
        "--source-query-head", type=Path, default=DEFAULT_SOURCE_QUERY_HEAD
    )
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--evaluation-batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--base-family-ce-weight", type=float, default=0.35)
    parser.add_argument("--direct-family-ce-weight", type=float, default=0.10)
    parser.add_argument("--page-body-ce-weight", type=float, default=0.10)
    parser.add_argument("--anchor-kl-weight", type=float, default=0.50)
    parser.add_argument("--residual-l2-weight", type=float, default=0.01)
    parser.add_argument(
        "--maximum-margin", type=float, choices=MAX_MARGIN_CHOICES, default=2.0
    )
    parser.add_argument("--maximum-acceptable-regression", type=float, default=0.005)
    parser.add_argument("--maximum-preferred-regression", type=float, default=0.005)
    parser.add_argument("--maximum-family-regression", type=float, default=0.0025)
    parser.add_argument(
        "--minimum-diagnostic-work-macro-improvement", type=float, default=0.02
    )
    parser.add_argument("--seed", type=int, default=20260820)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    _add_shared_arguments(preflight_parser)
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
    args = build_parser().parse_args()
    if args.command == "preflight":
        result = preflight(args)
    elif args.command == "train":
        result = train(args)
    elif args.command == "validate":
        result = validate_output(args.output_dir)
    elif args.command == "evaluate":
        result = evaluate(args)
    else:  # pragma: no cover - argparse owns choices
        raise SharedHiddenFamilyResidualError(f"unsupported command: {args.command}")
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
