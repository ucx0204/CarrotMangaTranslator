#!/usr/bin/env python3
"""Train the isolated R2.1 work-LOGO family-residual diagnostic.

R2.1 is a nonpromotable, training-only four-cell experiment.  It compares a
zero-initialized scalar residual over either the frozen shared 64-dimensional
candidate hidden or the frozen 1024-dimensional ``family_norm`` output, using
either the existing work-family CE or a precommitted gamma-one hard-example CE.
Each artifact contains ten leave-one-work-out folds for one cell and one seed.
The held-out work is excluded from every gradient and from epoch selection;
metrics for the three development works remain sealed and unconsulted.  Page labels are metric-only and
no page rendering, optimizer step, production integration, or export occurs.
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
    from scripts import train_manga_font_v3_shared_hidden_family_residual_r2 as r2
except ImportError:  # pragma: no cover - direct script execution
    import train_manga_font_v3_shared_hidden_family_residual_r2 as r2


r1 = r2.r1
r0 = r2.r0

SCHEMA_VERSION = "manga-font-v3-family-residual-r21-logo-v2"
OWNER = "carrot-manga-translator/manga-font-v3-family-residual-r21-logo-v2"
MANIFEST_FILE = "manifest.json"
MARKER_FILE = ".manga-font-v3-family-residual-r21-logo-v2-owned.json"
PRODUCER_FILE_NAME = "train_manga_font_v3_family_residual_r21_logo.py"
FOLD_COUNT = 10
SIDECAR_TEMPLATE = "fold-{fold_index:02d}-family-margin-r21.safetensors"

FEATURE_SOURCES = ("shared_hidden64", "family_norm1024")
DIRECT_OBJECTIVES = ("work_family_ce", "work_family_hard_ce_gamma1")
INITIAL_SEEDS = (20260820, 20260821, 20260822)
FINAL_SEEDS = (*INITIAL_SEEDS, 20260823, 20260824)
HARD_GAMMA = 1.0
HARD_EPSILON = 1e-12
LOSS_ABSOLUTE_TOLERANCE = 1e-6
LOSS_RELATIVE_TOLERANCE = 1e-6
METRIC_GATE_ABSOLUTE_TOLERANCE = 1e-12

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
    "weight_decay": 0.0,
}

EXPECTED_AUTHORITY = {
    **r2.EXPECTED_AUTHORITY,
    "cross_validation_authority": "training_only_work_logo_diagnostic",
    "development_evaluation_opened": False,
}
EXPECTED_RUNTIME_BOUNDARY = {
    **r2.EXPECTED_RUNTIME_BOUNDARY,
    "training_contract": "r21_ten_fold_logo_one_direct_one_base",
}
EXPECTED_MANIFEST_KEYS = frozenset(
    {
        "anchor",
        "anchor_tensor_inventory",
        "architecture",
        "authority",
        "base_dataset",
        "candidate_ids",
        "candidate_score_invariance",
        "configuration",
        "development_boundary",
        "experiment_contract",
        "files",
        "folds",
        "global_partition",
        "logo_aggregate",
        "objective_contract",
        "overlay",
        "producer",
        "record_sha256",
        "record_type",
        "runtime_boundary",
        "schema_version",
        "source_query_head",
        "trainable_parameters",
        "training_seconds",
        "work_universe",
    }
)
EXPECTED_CONFIGURATION_KEYS = frozenset(
    {
        "anchor_kl_scope",
        "anchor_kl_weight",
        "base_family_ce_weight",
        "base_supervision_mode",
        "batch_size",
        "device",
        "direct_balance_mode",
        "direct_family_ce_weight",
        "direct_objective",
        "epochs",
        "evaluation_batch_size",
        "experiment_cell_id",
        "feature_source",
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


class R21TrainingError(ValueError):
    """Raised when the sealed R2.1 diagnostic contract is violated."""


def canonical_json(value: Any) -> str:
    return r2.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return r2.json_bytes(value, pretty=pretty)


def sha256_file(path: Path) -> str:
    return r2.sha256_file(path)


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    return r2.seal_record(core)


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R21TrainingError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise R21TrainingError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    try:
        r2._validate_record_seal(record, location)
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _assert_nested_close(actual: Any, expected: Any, location: str) -> None:
    try:
        r2._assert_nested_close(actual, expected, location)
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _safe_new_output(path: Path) -> Path:
    try:
        return r2._safe_new_output(path)
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _producer_binding() -> Mapping[str, Any]:
    source = Path(__file__).expanduser().absolute()
    if (
        source.name != PRODUCER_FILE_NAME
        or r0.overlay_v3._path_or_ancestor_is_link_or_reparse(source)
    ):
        raise R21TrainingError("producer path is linked or reparsed or renamed")
    resolved = source.resolve()
    if not resolved.is_file():
        raise R21TrainingError("producer file is missing")
    return {
        "byte_size": int(resolved.stat().st_size),
        "file_name": PRODUCER_FILE_NAME,
        "sha256": sha256_file(resolved),
    }


def _sidecar_name(fold_index: int) -> str:
    if isinstance(fold_index, bool) or not isinstance(fold_index, int):
        raise R21TrainingError("fold index must be an integer")
    if fold_index < 0 or fold_index >= FOLD_COUNT:
        raise R21TrainingError("fold index drifted")
    return SIDECAR_TEMPLATE.format(fold_index=fold_index)


def _output_files() -> frozenset[str]:
    return frozenset(
        {MANIFEST_FILE, MARKER_FILE, *(_sidecar_name(i) for i in range(FOLD_COUNT))}
    )


def _feature_dimension(feature_source: str) -> int:
    if feature_source == "shared_hidden64":
        return r0.EXPECTED_HIDDEN_DIM
    if feature_source == "family_norm1024":
        return r0.v8.QUERY_COUNT * r0.v8.QUERY_DIM
    raise R21TrainingError("feature source drifted")


def _sidecar_spec(feature_source: str) -> Mapping[str, tuple[tuple[int, ...], str]]:
    return {
        "family_margin_head.bias": ((1,), "float32"),
        "family_margin_head.weight": (
            (1, _feature_dimension(feature_source)),
            "float32",
        ),
    }


def _payload_sha256(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def _index_sha256(values: np.ndarray) -> str:
    array = np.asarray(values, dtype="<i8")
    return hashlib.sha256(array.tobytes(order="C")).hexdigest()


def _string_sha256(values: Sequence[str]) -> str:
    digest = hashlib.sha256()
    for value in values:
        digest.update(str(value).encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def frozen_family_norm(torch: Any, anchor_model: Any, query_views: Any) -> Any:
    """Replay the exact frozen 1024-vector already consumed by family_head."""

    if query_views.ndim == 3:
        query_views = query_views[:, None, :, :]
    if query_views.ndim != 4 or tuple(query_views.shape[-2:]) != (
        r0.v8.QUERY_COUNT,
        r0.v8.QUERY_DIM,
    ):
        raise R21TrainingError("query views must have shape [batch,views,4,256]")
    sample = torch.nn.functional.normalize(query_views.float().mean(dim=1), p=2, dim=-1)
    flattened = sample.reshape(sample.shape[0], -1)
    feature = anchor_model.family_norm(flattened)
    if feature.ndim != 2 or feature.shape[1] != _feature_dimension("family_norm1024"):
        raise R21TrainingError("frozen family_norm feature shape drifted")
    return feature


def _feature_from_queries(
    torch: Any, anchor_model: Any, query_views: Any, feature_source: str
) -> Any:
    if feature_source == "shared_hidden64":
        return r0.frozen_shared_hidden(torch, anchor_model, query_views)
    if feature_source == "family_norm1024":
        return frozen_family_norm(torch, anchor_model, query_views)
    raise R21TrainingError("feature source drifted")


def _build_r21_model(
    torch: Any,
    *,
    anchor_model: Any,
    maximum_margin: float,
    feature_source: str,
) -> Any:
    if float(maximum_margin) != 1.0:
        raise R21TrainingError("R2.1 maximum margin must remain 1")
    if len(anchor_model.state_dict()) != r0.EXPECTED_ANCHOR_TENSOR_COUNT:
        raise R21TrainingError("anchor tensor inventory drifted")
    feature_dimension = _feature_dimension(feature_source)

    class R21FamilyResidual(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.anchor_model = anchor_model
            self.anchor_model.requires_grad_(False).eval()
            self.family_margin_head = torch.nn.Linear(feature_dimension, 1)
            torch.nn.init.zeros_(self.family_margin_head.weight)
            torch.nn.init.zeros_(self.family_margin_head.bias)
            self.maximum_margin = float(maximum_margin)
            self.feature_source = feature_source

        def residual_from_hidden(self, hidden: Any) -> Mapping[str, Any]:
            if hidden.ndim != 2 or hidden.shape[1] != feature_dimension:
                raise R21TrainingError("residual feature shape drifted")
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
                feature = _feature_from_queries(
                    torch, self.anchor_model, query_views, self.feature_source
                )
            residual = self.residual_from_hidden(feature)
            outputs = dict(anchor_outputs)
            outputs["family_logits"] = (
                anchor_outputs["family_logits"] + residual["family_logit_adjustment"]
            )
            outputs.update(residual)
            return outputs

    return R21FamilyResidual()


def _sidecar_state(model: Any, feature_source: str) -> Mapping[str, Any]:
    spec = _sidecar_spec(feature_source)
    named = dict(model.named_parameters())
    trainable = {name for name, value in named.items() if value.requires_grad}
    if trainable != set(spec):
        raise R21TrainingError("sidecar trainable inventory drifted")
    return {
        name: named[name].detach().cpu().float().contiguous().clone()
        for name in sorted(spec)
    }


def _state_payload(state: Mapping[str, Any], feature_source: str) -> Mapping[str, Any]:
    spec = _sidecar_spec(feature_source)
    if set(state) != set(spec):
        raise R21TrainingError("sidecar state inventory drifted")
    result: dict[str, Any] = {}
    for name, (shape, dtype) in sorted(spec.items()):
        source = np.asarray(state[name].detach().cpu().numpy())
        if tuple(source.shape) != shape or source.dtype != np.dtype(dtype):
            raise R21TrainingError(f"sidecar tensor drifted: {name}")
        array = np.asarray(source, dtype="<f4")
        if not np.isfinite(array).all():
            raise R21TrainingError(f"sidecar tensor non-finite: {name}")
        result[name] = {
            "data_hex_little_endian_float32": array.tobytes(order="C").hex(),
            "dtype": dtype,
            "shape": list(shape),
        }
    return result


def _state_from_payload(
    torch: Any, payload: Mapping[str, Any], feature_source: str
) -> Mapping[str, Any]:
    spec = _sidecar_spec(feature_source)
    if set(payload) != set(spec):
        raise R21TrainingError("sidecar payload inventory drifted")
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
            raise R21TrainingError(f"state payload descriptor drifted: {name}")
        encoded = descriptor.get("data_hex_little_endian_float32")
        if not isinstance(encoded, str):
            raise R21TrainingError(f"state payload bytes missing: {name}")
        try:
            raw = bytes.fromhex(encoded)
        except ValueError as error:
            raise R21TrainingError(f"state payload bytes invalid: {name}") from error
        if len(raw) != int(np.prod(shape, dtype=np.int64)) * 4:
            raise R21TrainingError(f"state payload size drifted: {name}")
        array = np.frombuffer(raw, dtype="<f4").reshape(shape).copy()
        if not np.isfinite(array).all():
            raise R21TrainingError(f"state payload non-finite: {name}")
        state[name] = torch.from_numpy(array)
    return state


def _apply_sidecar_state(
    model: Any, state: Mapping[str, Any], feature_source: str
) -> None:
    spec = _sidecar_spec(feature_source)
    if set(state) != set(spec):
        raise R21TrainingError("sidecar state inventory drifted")
    named = dict(model.named_parameters())
    with __import__("torch").no_grad():
        for name, (shape, _dtype) in spec.items():
            value = state[name].to(device=named[name].device, dtype=named[name].dtype)
            if tuple(value.shape) != shape:
                raise R21TrainingError(f"sidecar state shape drifted: {name}")
            named[name].copy_(value)


def _load_sidecar_state(
    torch: Any, path: Path, feature_source: str
) -> Mapping[str, Any]:
    try:
        from safetensors.numpy import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R21TrainingError("safetensors is required") from error
    try:
        arrays = load_file(str(path))
    except Exception as error:  # noqa: BLE001
        raise R21TrainingError("sidecar checkpoint is unreadable") from error
    spec = _sidecar_spec(feature_source)
    if set(arrays) != set(spec):
        raise R21TrainingError("sidecar checkpoint inventory drifted")
    state: dict[str, Any] = {}
    for name, (shape, dtype) in spec.items():
        value = np.asarray(arrays[name])
        if (
            tuple(value.shape) != shape
            or str(value.dtype) != dtype
            or not np.isfinite(value).all()
        ):
            raise R21TrainingError(f"sidecar checkpoint tensor drifted: {name}")
        state[name] = torch.from_numpy(np.array(value, copy=True))
    return state


def _build_feature_cache(
    torch: Any,
    *,
    context: Mapping[str, Any],
    device: Any,
    batch_size: int,
    feature_source: str,
) -> Mapping[str, Any]:
    base_cache = r0._build_frozen_cache(
        torch,
        context=context,
        device=device,
        batch_size=batch_size,
    )
    if feature_source == "shared_hidden64":
        return base_cache
    if feature_source != "family_norm1024":
        raise R21TrainingError("feature source drifted")
    arrays = context["arrays"]
    anchor_model = context["model"].to(device)
    features: list[Any] = []
    with torch.inference_mode():
        for start in range(0, len(arrays["query_views"]), int(batch_size)):
            query_views = torch.from_numpy(
                arrays["query_views"][start : start + int(batch_size)].astype(
                    np.float32, copy=False
                )
            ).to(device)
            features.append(
                frozen_family_norm(torch, anchor_model, query_views).detach()
            )
    feature = torch.cat(features, dim=0)
    if tuple(feature.shape) != (
        len(arrays["query_views"]),
        _feature_dimension(feature_source),
    ):
        raise R21TrainingError("family_norm cache inventory drifted")
    with torch.inference_mode():
        replayed_family_logits = anchor_model.family_head(feature)
    if not torch.equal(replayed_family_logits, base_cache["family_logits"]):
        raise R21TrainingError("family_norm replay is not bit-exact family logits")
    return {**base_cache, "hidden": feature}


def _assert_zero_output_anchor(
    torch: Any, model: Any, cache: Mapping[str, Any]
) -> None:
    indices = np.arange(cache["hidden"].shape[0], dtype=np.int64)
    outputs = r0._family_outputs_from_cache(model, cache, indices)
    if not torch.equal(outputs["family_logits"], cache["family_logits"]):
        raise R21TrainingError("zero output is not the exact anchor")
    if float(outputs["family_margin_delta"].abs().max().item()) != 0.0:
        raise R21TrainingError("zero output margin drifted")


def _load_context(args: argparse.Namespace, torch: Any) -> Mapping[str, Any]:
    try:
        return r2._load_context(args, torch)
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _global_partition(
    context: Mapping[str, Any], args: argparse.Namespace, *, enforce_real: bool
) -> Mapping[str, Any]:
    try:
        return r2._build_partition(context, args, enforce_real=enforce_real)
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _fold_partition_contract(
    *,
    arrays: Mapping[str, np.ndarray],
    global_partition: Mapping[str, Any],
    fold_index: int,
    heldout_work_id: str,
    base_indices: np.ndarray,
    direct_indices: np.ndarray,
    direct_labels: np.ndarray,
    direct_weights: np.ndarray,
    direct_work_ids: np.ndarray,
    all_gradient_indices: np.ndarray,
    heldout_all_base_indices: np.ndarray,
    heldout_direct_indices: np.ndarray,
    page_indices: np.ndarray,
    page_group_count: int,
    train_work_ids: Sequence[str],
) -> Mapping[str, Any]:
    base_set = set(int(value) for value in base_indices)
    direct_set = set(int(value) for value in direct_indices)
    all_set = set(int(value) for value in all_gradient_indices)
    heldout_set = set(int(value) for value in heldout_all_base_indices)
    page_set = set(int(value) for value in page_indices)
    full_all_set = set(int(value) for value in global_partition["all_base_indices"])
    strata = tuple(
        sorted(
            {
                (str(work_id), int(label))
                for work_id, label in zip(
                    direct_work_ids.tolist(), direct_labels.tolist(), strict=True
                )
            }
        )
    )
    original_labels = arrays["family_labels"].astype(np.int64, copy=False)
    original_weights = arrays["family_label_weights"].astype(np.float32, copy=False)
    if (
        base_set & direct_set
        or base_set | direct_set != all_set
        or all_set & heldout_set
        or all_set | heldout_set != full_all_set
        or not page_set <= direct_set
        or heldout_work_id in set(str(value) for value in train_work_ids)
    ):
        raise R21TrainingError("LOGO fold set algebra drifted")
    return {
        "active_work_family_strata": [
            {"family_label": label, "work_id": work_id} for work_id, label in strata
        ],
        "active_work_family_strata_count": int(len(strata)),
        "all_gradient_index_sha256": _index_sha256(all_gradient_indices),
        "all_gradient_rows": int(len(all_gradient_indices)),
        "base_index_sha256": _index_sha256(base_indices),
        "base_inventory_sha256": r1._inventory_sha256(
            arrays, base_indices, original_labels, original_weights
        ),
        "base_rows": int(len(base_indices)),
        "base_target_source": "original_r3_non_direct_excluding_heldout_work",
        "direct_body_rows": int(np.sum(direct_labels == r0.v8.BODY_FAMILY_INDEX)),
        "direct_index_sha256": _index_sha256(direct_indices),
        "direct_inventory_sha256": r1._aligned_inventory_sha256(
            arrays, direct_indices, direct_labels, direct_weights
        ),
        "direct_rows": int(len(direct_indices)),
        "direct_variant_rows": int(np.sum(direct_labels == r0.v8.VARIANT_FAMILY_INDEX)),
        "fold_index": int(fold_index),
        "full_work_family_strata_count": int(
            len(global_partition["contract"]["work_family_strata"])
        ),
        "global_partition_record_sha256": hashlib.sha256(
            canonical_json(global_partition["contract"]).encode("utf-8")
        ).hexdigest(),
        "gradient_heldout_row_intersection_count": 0,
        "gradient_heldout_work_intersection_count": 0,
        "heldout_all_base_index_sha256": _index_sha256(heldout_all_base_indices),
        "heldout_all_base_rows": int(len(heldout_all_base_indices)),
        "heldout_direct_index_sha256": _index_sha256(heldout_direct_indices),
        "heldout_direct_rows": int(len(heldout_direct_indices)),
        "heldout_work_id": heldout_work_id,
        "page_index_sha256": _index_sha256(page_indices),
        "page_is_direct_subset": True,
        "page_metric_groups": int(page_group_count),
        "page_metric_rows": int(len(page_indices)),
        "page_optimizer_calls": 0,
        "train_work_ids": list(train_work_ids),
        "train_work_ids_sha256": _string_sha256(train_work_ids),
        "union_with_heldout_equals_global_all_base": True,
    }


def _build_logo_folds(
    context: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    enforce_real: bool = True,
) -> Sequence[Mapping[str, Any]]:
    global_partition = _global_partition(context, args, enforce_real=enforce_real)
    arrays = context["arrays"]
    groups = context["groups"]
    array_work_ids = arrays["work_ids"].astype(str, copy=False)
    universe = tuple(
        sorted(set(global_partition["direct_work_ids"].astype(str).tolist()))
    )
    if enforce_real and len(universe) != FOLD_COUNT:
        raise R21TrainingError("LOGO work universe drifted")
    if len(universe) < 2:
        raise R21TrainingError("LOGO requires at least two works")
    direct_rows_all = tuple(groups["direct_family"]["train"])
    page_groups_all = tuple(groups["train"])
    folds: list[Mapping[str, Any]] = []
    for fold_index, heldout_work_id in enumerate(universe):
        direct_mask = global_partition["direct_work_ids"].astype(str) != heldout_work_id
        direct_indices = global_partition["direct_indices"][direct_mask]
        direct_labels = global_partition["direct_labels"][direct_mask]
        direct_weights = global_partition["direct_weights"][direct_mask]
        direct_work_ids = global_partition["direct_work_ids"][direct_mask].astype(str)
        heldout_direct_indices = global_partition["direct_indices"][~direct_mask]
        base_indices = global_partition["base_indices"][
            array_work_ids[global_partition["base_indices"]] != heldout_work_id
        ]
        all_gradient_indices = global_partition["all_base_indices"][
            array_work_ids[global_partition["all_base_indices"]] != heldout_work_id
        ]
        heldout_all_base_indices = global_partition["all_base_indices"][
            array_work_ids[global_partition["all_base_indices"]] == heldout_work_id
        ]
        train_direct_rows = tuple(
            row for row in direct_rows_all if str(row["work_id"]) != heldout_work_id
        )
        heldout_direct_rows = tuple(
            row for row in direct_rows_all if str(row["work_id"]) == heldout_work_id
        )
        train_page_groups = tuple(
            group
            for group in page_groups_all
            if str(group["work_id"]) != heldout_work_id
        )
        heldout_page_groups = tuple(
            group
            for group in page_groups_all
            if str(group["work_id"]) == heldout_work_id
        )
        page_indices = np.concatenate(
            [group["row_indices"] for group in train_page_groups]
        ).astype(np.int64, copy=False)
        train_work_ids = tuple(sorted(set(direct_work_ids.tolist())))
        contract = _fold_partition_contract(
            arrays=arrays,
            global_partition=global_partition,
            fold_index=fold_index,
            heldout_work_id=heldout_work_id,
            base_indices=base_indices,
            direct_indices=direct_indices,
            direct_labels=direct_labels,
            direct_weights=direct_weights,
            direct_work_ids=direct_work_ids,
            all_gradient_indices=all_gradient_indices,
            heldout_all_base_indices=heldout_all_base_indices,
            heldout_direct_indices=heldout_direct_indices,
            page_indices=page_indices,
            page_group_count=len(train_page_groups),
            train_work_ids=train_work_ids,
        )
        if enforce_real and (
            len(train_work_ids) != FOLD_COUNT - 1
            or contract["active_work_family_strata_count"] != 18
            or not heldout_direct_rows
            or not heldout_page_groups
        ):
            raise R21TrainingError("real LOGO fold inventory drifted")
        folds.append(
            {
                "all_base_indices": all_gradient_indices,
                "base_indices": base_indices,
                "base_labels": global_partition["base_labels"],
                "base_weights": global_partition["base_weights"],
                "contract": contract,
                "direct_indices": direct_indices,
                "direct_labels": direct_labels,
                "direct_weights": direct_weights,
                "direct_work_ids": direct_work_ids,
                "family_override": global_partition["family_override"],
                "heldout_direct_rows": heldout_direct_rows,
                "heldout_page_groups": heldout_page_groups,
                "heldout_work_id": heldout_work_id,
                "non_direct_indices": base_indices,
                "page_indices": page_indices,
                "selection_groups": {
                    "direct_family": {"train": train_direct_rows},
                    "train": train_page_groups,
                },
            }
        )
    if tuple(fold["heldout_work_id"] for fold in folds) != universe:
        raise R21TrainingError("LOGO fold order drifted")
    return tuple(folds)


def _schedule_seed(*, seed: int, heldout_work_id: str, epoch: int, phase: str) -> int:
    digest = hashlib.sha256(
        f"manga-font-r21-logo\0{seed}\0{heldout_work_id}\0{epoch}\0{phase}".encode(
            "utf-8"
        )
    ).digest()
    return int.from_bytes(digest[:8], "big", signed=False)


def _row_weight_sha256(indices: np.ndarray, weights: np.ndarray) -> str:
    rows = np.asarray(indices, dtype=np.int64)
    values = np.asarray(weights, dtype=np.float32)
    if rows.shape != values.shape or not np.isfinite(values).all():
        raise R21TrainingError("row weight inventory drifted")
    digest = hashlib.sha256()
    for position in np.argsort(rows, kind="stable"):
        digest.update(np.asarray(rows[position], dtype="<i8").tobytes())
        digest.update(np.asarray(values[position], dtype="<f4").tobytes())
    return digest.hexdigest()


def _correct_hard_example_float32_sum_to_one(
    values: np.ndarray, *, base_rows: np.ndarray
) -> tuple[np.ndarray, int, int]:
    normalized = np.asarray(values, dtype=np.float32)
    rows = np.asarray(base_rows, dtype=np.int64)
    if (
        not len(normalized)
        or normalized.shape != rows.shape
        or len(set(rows.tolist())) != len(rows)
        or not np.isfinite(normalized).all()
        or bool((normalized <= 0).any())
    ):
        raise R21TrainingError("hard-example correction inventory drifted")
    # Phase-dependent hard factors can make the highest-base-row element tiny.
    # A largest element has a useful ULP, but its ULP can also skip over the
    # exact pairwise-reduction target. Try deterministic candidates in weight
    # order and keep the first one accepted by the inherited exact f32 helper.
    candidate_order = np.lexsort((-rows, -normalized))
    for correction_rank, correction_offset_value in enumerate(candidate_order):
        correction_offset = int(correction_offset_value)
        try:
            corrected = r1._correct_float32_sum_to_one(
                normalized, correction_offset=correction_offset
            )
        except r1.R1TrainingError:
            continue
        return corrected, correction_offset, int(correction_rank)
    raise R21TrainingError("hard-example float32 sum has no exact correction offset")


def _hard_example_weights(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    indices: np.ndarray,
    labels: np.ndarray,
    work_ids: np.ndarray,
    sealed_normalized_weights: np.ndarray,
    gamma: float = HARD_GAMMA,
) -> tuple[np.ndarray, Mapping[str, Any]]:
    if float(gamma) != HARD_GAMMA:
        raise R21TrainingError("hard-example gamma drifted")
    rows = np.asarray(indices, dtype=np.int64)
    targets = np.asarray(labels, dtype=np.int64)
    works = np.asarray(work_ids).astype(str)
    sealed = np.asarray(sealed_normalized_weights, dtype=np.float32)
    if (
        not len(rows)
        or rows.shape != targets.shape
        or rows.shape != works.shape
        or rows.shape != sealed.shape
        or not np.isfinite(sealed).all()
        or bool((sealed <= 0).any())
    ):
        raise R21TrainingError("hard-example source inventory drifted")
    positions = torch.from_numpy(rows.astype(np.int64, copy=False)).long()
    device_positions = positions.to(device=cache["hidden"].device)
    state = _sidecar_state(model, model.feature_source)
    hidden = cache["hidden"][device_positions].detach().cpu().float()
    anchor_logits = cache["family_logits"][device_positions].detach().cpu().float()
    weight = state["family_margin_head.weight"].float()
    bias = state["family_margin_head.bias"].float()
    target_tensor = torch.from_numpy(targets).long()
    with torch.no_grad():
        raw = torch.nn.functional.linear(hidden, weight, bias).squeeze(-1)
        margin = r0.bounded_margin(torch, raw, float(model.maximum_margin))
        adjusted_logits = anchor_logits + torch.stack(
            (margin * 0.5, margin * -0.5), dim=-1
        )
        probability = torch.softmax(adjusted_logits, dim=1)
        p_t = probability.gather(1, target_tensor[:, None]).squeeze(1)
        hard = (1.0 - p_t).pow(float(gamma))
    p_t_values = p_t.detach().cpu().float().numpy().astype(np.float32, copy=False)
    hard_values = hard.detach().cpu().float().numpy().astype(np.float32, copy=False)
    if (
        not np.isfinite(p_t_values).all()
        or not np.isfinite(hard_values).all()
        or bool((p_t_values <= 0).any())
        or bool((p_t_values >= 1).any())
        or bool((hard_values <= 0).any())
    ):
        raise R21TrainingError("hard-example probability inventory drifted")
    result = np.empty_like(sealed)
    strata = tuple(sorted(set(zip(works.tolist(), targets.tolist(), strict=True))))
    descriptors: list[Mapping[str, Any]] = []
    for work_id, family_label in strata:
        positions = np.flatnonzero((works == work_id) & (targets == int(family_label)))
        numerator = (sealed[positions] * hard_values[positions]).astype(np.float32)
        denominator = float(np.sum(numerator, dtype=np.float32))
        if not math.isfinite(denominator) or denominator <= HARD_EPSILON:
            raise R21TrainingError("hard-example stratum denominator drifted")
        normalized = (numerator / np.float32(denominator)).astype(np.float32)
        pre_correction_sum = float(np.sum(normalized, dtype=np.float32))
        normalized, correction_offset, correction_rank = (
            _correct_hard_example_float32_sum_to_one(
                normalized, base_rows=rows[positions]
            )
        )
        result[positions] = normalized
        descriptors.append(
            {
                "family_label": int(family_label),
                "hard_factor_max": float(np.max(hard_values[positions])),
                "hard_factor_min": float(np.min(hard_values[positions])),
                "normalization_denominator": denominator,
                "normalization_correction_base_row_index": int(
                    rows[positions][correction_offset]
                ),
                "normalization_correction_candidate_rank": correction_rank,
                "normalization_correction_rule": (
                    "descending_pre_correction_weight_then_highest_base_row_first_exact"
                ),
                "normalization_correction_weight_f32_hex": np.asarray(
                    normalized[correction_offset], dtype="<f4"
                )
                .tobytes()
                .hex(),
                "pre_correction_weight_sum": pre_correction_sum,
                "normalized_weight_sum": float(np.sum(normalized, dtype=np.float32)),
                "row_count": int(len(positions)),
                "work_id": str(work_id),
            }
        )
    if (
        not np.isfinite(result).all()
        or bool((result <= 0).any())
        or any(row["normalized_weight_sum"] != 1.0 for row in descriptors)
    ):
        raise R21TrainingError("hard-example normalized weights drifted")
    contract = {
        "detached_phase_start_probability": True,
        "effective_row_weight_sha256": _row_weight_sha256(rows, result),
        "formula": "q_i=(sealed_stratum_weight_i*(1-p_t_i)^1)/stratum_sum_then_f32_correction",
        "gamma": float(gamma),
        "hard_factor_max": float(np.max(hard_values)),
        "hard_factor_min": float(np.min(hard_values)),
        "p_t_max": float(np.max(p_t_values)),
        "p_t_min": float(np.min(p_t_values)),
        "strata": descriptors,
        "stratum_count": int(len(strata)),
        "stratum_equal_total_weight": True,
    }
    return result, contract


def _direct_batches(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    partition: Mapping[str, Any],
    args: argparse.Namespace,
    epoch: int,
) -> tuple[Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]], Mapping[str, Any]]:
    seed = _schedule_seed(
        seed=int(args.seed),
        heldout_work_id=str(partition["heldout_work_id"]),
        epoch=int(epoch),
        phase="direct",
    )
    try:
        position_batches, sealed_normalized, source_contract = (
            r1._direct_balanced_schedule(
                partition["direct_indices"],
                partition["direct_work_ids"],
                partition["direct_labels"],
                partition["direct_weights"],
                balance_mode="work_family",
                batch_size=int(args.batch_size),
                seed=seed,
            )
        )
    except r1.R1TrainingError as error:
        raise R21TrainingError(str(error)) from error
    if args.direct_objective == "work_family_ce":
        effective = sealed_normalized
        objective_contract: Mapping[str, Any] = {
            "detached_phase_start_probability": False,
            "effective_row_weight_sha256": _row_weight_sha256(
                partition["direct_indices"], effective
            ),
            "formula": "sealed_work_family_normalized_weight",
            "gamma": None,
            "stratum_count": int(source_contract["stratum_count"]),
            "stratum_equal_total_weight": True,
        }
    elif args.direct_objective == "work_family_hard_ce_gamma1":
        effective, objective_contract = _hard_example_weights(
            torch,
            model,
            cache=cache,
            indices=partition["direct_indices"],
            labels=partition["direct_labels"],
            work_ids=partition["direct_work_ids"],
            sealed_normalized_weights=sealed_normalized,
        )
    else:  # pragma: no cover - option validation owns enum
        raise R21TrainingError("direct objective drifted")
    batches = tuple(
        (
            partition["direct_indices"][positions],
            partition["direct_labels"][positions],
            effective[positions],
        )
        for positions in position_batches
    )
    ordered = np.concatenate([batch[0] for batch in batches]).astype(
        np.int64, copy=False
    )
    contract = {
        **source_contract,
        "active_fold_denominator": int(source_contract["stratum_count"]),
        "direct_objective": str(args.direct_objective),
        "full_data_refit_denominator_not_used": 20,
        "hard_example": objective_contract,
        "ordered_base_row_index_sha256": _index_sha256(ordered),
        "schedule_seed": int(seed),
    }
    expected_denominator = int(partition["contract"]["active_work_family_strata_count"])
    if (
        int(source_contract["stratum_count"]) != expected_denominator
        or int(source_contract["loss_denominator"]) != expected_denominator
    ):
        raise R21TrainingError("fold direct denominator drifted")
    return batches, contract


def _base_batches(
    partition: Mapping[str, Any], args: argparse.Namespace, *, epoch: int
) -> tuple[Sequence[np.ndarray], Mapping[str, Any]]:
    seed = _schedule_seed(
        seed=int(args.seed),
        heldout_work_id=str(partition["heldout_work_id"]),
        epoch=int(epoch),
        phase="base",
    )
    rows = np.asarray(partition["base_indices"], dtype=np.int64)
    ordered = np.array(rows, copy=True)
    np.random.default_rng(seed).shuffle(ordered)
    batches = tuple(
        ordered[start : start + int(args.batch_size)]
        for start in range(0, len(ordered), int(args.batch_size))
    )
    if set(ordered.tolist()) != set(rows.tolist()) or len(ordered) != len(rows):
        raise R21TrainingError("fold base schedule drifted")
    return batches, {
        "algorithm": "logo_excluding_heldout_unique_shuffle_fixed_denominator_v1",
        "batch_count": int(len(batches)),
        "batch_sizes": [int(len(batch)) for batch in batches],
        "optimizer_calls": 1,
        "ordered_base_row_index_sha256": _index_sha256(ordered),
        "schedule_seed": int(seed),
        "unique_rows": int(len(ordered)),
    }


def _direct_accumulated_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    batches: Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]],
    fixed_denominator: int,
    args: argparse.Namespace,
) -> Mapping[str, float]:
    try:
        return r1._direct_accumulated_optimization_step(
            torch,
            model,
            optimizer,
            cache=cache,
            batches=batches,
            fixed_denominator=fixed_denominator,
            family_ce_weight=float(args.direct_family_ce_weight),
            residual_l2_weight=float(args.residual_l2_weight),
            gradient_clip=float(args.gradient_clip),
        )
    except r1.R1TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _base_accumulated_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    partition: Mapping[str, Any],
    batches: Sequence[np.ndarray],
    class_weights: np.ndarray,
    source_weight_denominator: float,
    args: argparse.Namespace,
) -> Mapping[str, float]:
    try:
        return r2._base_accumulated_optimization_step(
            torch,
            model,
            optimizer,
            cache=cache,
            partition=partition,
            batches=batches,
            class_weights=class_weights,
            source_weight_denominator=source_weight_denominator,
            family_ce_weight=float(args.base_family_ce_weight),
            anchor_kl_weight=float(args.anchor_kl_weight),
            residual_l2_weight=float(args.residual_l2_weight),
            gradient_clip=float(args.gradient_clip),
        )
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _validate_options(args: argparse.Namespace) -> None:
    try:
        r0._validate_options(args)
    except r0.SharedHiddenFamilyResidualError as error:
        raise R21TrainingError(str(error)) from error
    if args.feature_source not in FEATURE_SOURCES:
        raise R21TrainingError("feature source drifted")
    if args.direct_objective not in DIRECT_OBJECTIVES:
        raise R21TrainingError("direct objective drifted")
    if getattr(args, "device", None) not in {"cpu", "cuda"}:
        raise R21TrainingError("device must be cpu or cuda")
    if args.base_supervision_mode != "non_direct_preservation":
        raise R21TrainingError("R2.1 requires non_direct_preservation")
    if args.direct_balance_mode != "work_family":
        raise R21TrainingError("R2.1 requires work_family balancing")
    if args.anchor_kl_scope != "base_only":
        raise R21TrainingError("R2.1 requires base_only anchor KL")
    if int(args.seed) not in INITIAL_SEEDS:
        raise R21TrainingError(
            "R2.1 initial-grid seed must be one of the precommitted first three"
        )
    for name, expected in PRECOMMITTED_CONFIGURATION.items():
        actual = getattr(args, name)
        if isinstance(expected, int):
            if (
                isinstance(actual, bool)
                or not isinstance(actual, int)
                or actual != expected
            ):
                raise R21TrainingError(f"R2.1 precommitted option drifted: {name}")
        elif (
            isinstance(actual, bool)
            or not isinstance(actual, (int, float))
            or not math.isfinite(float(actual))
            or float(actual) != float(expected)
        ):
            raise R21TrainingError(f"R2.1 precommitted option drifted: {name}")
    expected_cell = f"r21-{args.feature_source}-{args.direct_objective}"
    if hasattr(args, "experiment_cell_id") and args.experiment_cell_id != expected_cell:
        raise R21TrainingError("experiment cell ID drifted")


def _configuration(args: argparse.Namespace) -> Mapping[str, Any]:
    return {
        "anchor_kl_scope": "base_only",
        "anchor_kl_weight": float(args.anchor_kl_weight),
        "base_family_ce_weight": float(args.base_family_ce_weight),
        "base_supervision_mode": "non_direct_preservation",
        "batch_size": int(args.batch_size),
        "device": str(args.device),
        "direct_balance_mode": "work_family",
        "direct_family_ce_weight": float(args.direct_family_ce_weight),
        "direct_objective": str(args.direct_objective),
        "epochs": int(args.epochs),
        "evaluation_batch_size": int(args.evaluation_batch_size),
        "experiment_cell_id": f"r21-{args.feature_source}-{args.direct_objective}",
        "feature_source": str(args.feature_source),
        "gradient_clip": float(args.gradient_clip),
        "learning_rate": float(args.learning_rate),
        "maximum_acceptable_regression": float(args.maximum_acceptable_regression),
        "maximum_family_regression": float(args.maximum_family_regression),
        "maximum_margin": float(args.maximum_margin),
        "maximum_preferred_regression": float(args.maximum_preferred_regression),
        "minimum_diagnostic_work_macro_improvement": float(
            args.minimum_diagnostic_work_macro_improvement
        ),
        "page_body_ce_weight": 0.0,
        "residual_l2_weight": float(args.residual_l2_weight),
        "seed": int(args.seed),
        "weight_decay": float(args.weight_decay),
    }


def _configuration_args(
    manifest: Mapping[str, Any], configuration: Mapping[str, Any]
) -> argparse.Namespace:
    try:
        return r1._configuration_args(manifest, configuration)
    except r1.R1TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _initial_state_contract(model: Any, feature_source: str) -> Mapping[str, Any]:
    state = _sidecar_state(model, feature_source)
    payload = _state_payload(state, feature_source)
    exact_zero = all(
        not bool(np.count_nonzero(value.detach().cpu().numpy()))
        for value in state.values()
    )
    if not exact_zero:
        raise R21TrainingError("R2.1 initializer is not exact zero")
    return {
        "deterministic_initial_state_sha256": _payload_sha256(payload),
        "head_initialization_seed": None,
        "initialization_source": "exact_zero_linear_all_seeds",
        "seed_changes_initialization": False,
        "tensor_inventory": r0._tensor_inventory(state),
    }


def _architecture_contract(
    model: Any, *, feature_source: str, maximum_margin: float
) -> Mapping[str, Any]:
    feature_dimension = _feature_dimension(feature_source)
    trainable_count = feature_dimension + 1
    production_parameters = 74_528
    production_macs = 91_776
    return {
        "anchor_tensor_count": r0.EXPECTED_ANCHOR_TENSOR_COUNT,
        "cpu_benchmark_completed": False,
        "cpu_single_thread_full_runtime_relative_budget": 1.5,
        "cpu_single_thread_full_runtime_benchmark_required_before_promotion": True,
        "family_logit_adjustment": "+margin/2 body, -margin/2 variant",
        "family_margin_formula": "B*tanh(raw_margin/B)",
        "feature_dimension": int(feature_dimension),
        "feature_source": str(feature_source),
        "feature_source_formula": (
            "frozen_sample_candidate_norm_then_Linear1024x64_then_GELU"
            if feature_source == "shared_hidden64"
            else "mean_views_then_per_query_l2_normalize_then_flatten_then_frozen_family_norm"
        ),
        "head_formula": f"Linear{feature_dimension}x1_exact_zero",
        "initial_state": _initial_state_contract(model, feature_source),
        "maximum_margin": float(maximum_margin),
        "reuse_existing_runtime_feature_required": True,
        "sidecar_parameter_count": int(trainable_count),
        "sidecar_tensor_count": 2,
        "static_reuse_estimate_not_runtime_benchmark": {
            "additional_multiply_accumulates_per_row": int(feature_dimension),
            "additional_parameters": int(trainable_count),
            "baseline_multiply_accumulates_per_row": production_macs,
            "baseline_parameters": production_parameters,
            "estimated_multiply_accumulate_ratio": float(
                (production_macs + feature_dimension) / production_macs
            ),
            "estimated_parameter_ratio": float(
                (production_parameters + trainable_count) / production_parameters
            ),
            "within_static_1_5x_parameter_and_mac_budget": bool(
                production_parameters + trainable_count <= 111_792
                and production_macs + feature_dimension <= 137_664
            ),
        },
        "zero_output_initialization_exact_anchor": True,
    }


def _trainable_contract(model: Any, feature_source: str) -> Mapping[str, Any]:
    spec = _sidecar_spec(feature_source)
    trainable_names = sorted(
        name for name, value in model.named_parameters() if value.requires_grad
    )
    if trainable_names != sorted(spec):
        raise R21TrainingError("trainable parameter inventory drifted")
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


def _experiment_contract() -> Mapping[str, Any]:
    return {
        "application_integration_allowed": False,
        "cpu_benchmark": {
            "budget_relative_to_current_full_font_runtime": 1.5,
            "completed": False,
            "required_before_any_promotion": True,
            "scope": "single_thread_full_font_runtime_not_sidecar_only",
        },
        "development_diagnostics": {
            "consulted": False,
            "gradient_rows": 0,
            "opened_only_after_grid_winner": True,
            "three_development_works_remain_sealed": True,
        },
        "four_cell_grid": {
            "direct_objectives": list(DIRECT_OBJECTIVES),
            "feature_sources": list(FEATURE_SOURCES),
        },
        "logo_scope_limitation": (
            "residual_supervision_logo_only_frozen_r3h_anchor_was_pretrained_on_base_npz_and_is_not_work_unseen"
        ),
        "page_optimizer_calls": 0,
        "page_render_or_replay_performed": False,
        "promotion_authority": False,
        "seed_contract": {
            "final_five": list(FINAL_SEEDS),
            "initial_three": list(INITIAL_SEEDS),
            "seeds_four_and_five_require_a_later_shortlist_binding_artifact": True,
            "seed_changes_only_schedule_and_float_accumulation_order": True,
            "seed_does_not_change_exact_zero_head_initialization": True,
        },
        "trajectory_authenticity_keyed": False,
        "trajectory_phase_transcript_authority": "sealed_producer_attestation_only",
        "trajectory_replayed_by_strict_validator": False,
        "work_logo": {
            "fold_count": FOLD_COUNT,
            "fold_epoch_selection_uses_heldout": False,
            "heldout_excluded_from_all_new_gradients_and_training_side_metrics": True,
            "heldout_metrics_are_post_selection_only": True,
            "not_end_to_end_new_work_generalization_authority": True,
        },
    }


def _objective_contract(
    args: argparse.Namespace, folds: Sequence[Mapping[str, Any]]
) -> Mapping[str, Any]:
    balances: list[Mapping[str, Any]] = []
    for fold in folds:
        try:
            _weights, _denominator, balance = r2._base_class_balance(fold)
        except r2.R2TrainingError as error:
            raise R21TrainingError(str(error)) from error
        balances.append(
            {
                "base_class_balance": balance,
                "fold_index": int(fold["contract"]["fold_index"]),
                "heldout_work_id": str(fold["heldout_work_id"]),
            }
        )
    return {
        "anchor_kl_scope": "base_only",
        "base_accumulation": "fold_all_batches_backward_then_one_optimizer_step",
        "base_class_balance_by_fold": balances,
        "base_optimizer_calls_per_epoch_per_fold": 1,
        "base_phase_is_last": True,
        "candidate_score_parameters_frozen": True,
        "direct_accumulation": "fold_unique_rows_backward_then_one_optimizer_step",
        "direct_anchor_kl_weight": 0.0,
        "direct_fixed_denominator": "active_train_work_family_strata_18_not_full_data_20",
        "direct_objective": str(args.direct_objective),
        "direct_optimizer_calls_per_epoch_per_fold": 1,
        "hard_example_contract": (
            None
            if args.direct_objective == "work_family_ce"
            else {
                "factor": "(1-p_t)^1",
                "factor_is_detached_at_phase_start": True,
                "gamma": HARD_GAMMA,
                "no_alpha": True,
                "renormalization": "within_each_active_work_family_stratum_sum_one",
            }
        ),
        "heldout_work_enters_gradient_or_epoch_selection": False,
        "optimizer_phase_order": ["direct_family", "base_preservation"],
        "page_optimizer_calls": 0,
        "page_selection_metrics_exclude_heldout_work": True,
        "post_base_state_only_selectable": True,
        "post_direct_state_diagnostic_only": True,
        "residual_l2_scope": "direct_and_base_steps",
        "trajectory_replay_authority": False,
    }


def _candidate_invariance(cache: Mapping[str, Any]) -> Mapping[str, Any]:
    return r2._candidate_invariance(cache)


def _fold_training_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    return r0._training_metrics(
        torch,
        model,
        cache=cache,
        groups=partition["selection_groups"],
        candidate_ids=candidate_ids,
        margin_indices=partition["all_base_indices"],
    )


def _fold_diagnostic_checks(
    *,
    anchor_train: Mapping[str, Any],
    candidate_train: Mapping[str, Any],
    base_metrics: Mapping[str, Any],
    base_regression: Mapping[str, bool],
    minimum_improvement: float,
) -> Mapping[str, bool]:
    try:
        return r1._diagnostic_checks(
            anchor_train=anchor_train,
            candidate_train=candidate_train,
            base_metrics=base_metrics,
            base_regression=base_regression,
            minimum_improvement=minimum_improvement,
            candidate_outputs_exact=True,
        )
    except r1.R1TrainingError as error:
        raise R21TrainingError(str(error)) from error


def _fold_selection_key(
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
        raise R21TrainingError(str(error)) from error


def _zero_consumption() -> Mapping[str, Any]:
    return {
        "base_batches": 0,
        "base_optimizer_calls": 0,
        "base_rows": 0,
        "base_schedule": None,
        "development_rows": 0,
        "direct_batches": 0,
        "direct_optimizer_calls": 0,
        "direct_rows": 0,
        "direct_schedule": None,
        "heldout_rows_consulted": 0,
        "optimizer_phase_order_completed": [],
        "page_optimizer_calls": 0,
        "page_rows": 0,
    }


def _phase_consumption(
    partition: Mapping[str, Any],
    *,
    direct_schedule: Mapping[str, Any],
    direct_batches: Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]],
    base_schedule: Mapping[str, Any] | None = None,
    base_batches: Sequence[np.ndarray] | None = None,
) -> Mapping[str, Any]:
    base_complete = base_schedule is not None and base_batches is not None
    return {
        "base_batches": int(len(base_batches or ())),
        "base_optimizer_calls": int(base_complete),
        "base_rows": int(sum(len(batch) for batch in (base_batches or ()))),
        "base_schedule": dict(base_schedule) if base_complete else None,
        "development_rows": 0,
        "direct_batches": int(len(direct_batches)),
        "direct_optimizer_calls": 1,
        "direct_rows": int(sum(len(batch[0]) for batch in direct_batches)),
        "direct_schedule": dict(direct_schedule),
        "heldout_rows_consulted": 0,
        "optimizer_phase_order_completed": (
            ["direct_family", "base_preservation"]
            if base_complete
            else ["direct_family"]
        ),
        "page_optimizer_calls": 0,
        "page_rows": 0,
        "train_work_count": len(partition["contract"]["train_work_ids"]),
    }


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
    consumption: Mapping[str, Any],
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
    train_metrics = _fold_training_metrics(
        torch,
        model,
        cache=cache,
        context=context,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    reference = train_metrics if anchor_train_metrics is None else anchor_train_metrics
    checks = _fold_diagnostic_checks(
        anchor_train=reference,
        candidate_train=train_metrics,
        base_metrics=base_metrics,
        base_regression=regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
    )
    state_payload = _state_payload(
        _sidecar_state(model, args.feature_source), args.feature_source
    )
    record: dict[str, Any] = {
        "base_metrics": base_metrics,
        "base_no_material_regression": bool(all(regression.values())),
        "base_regression_checks": regression,
        "batch_consumption": dict(consumption),
        "candidate_outputs_exact_anchor": True,
        "checkpoint_selection_inputs": (
            [
                "fold_train_direct_family_labels",
                "fold_train_page_metric_safety",
                "external_r3_base_validation",
            ]
            if selectable
            else []
        ),
        "development_eval_consulted": False,
        "diagnostic_checks": checks,
        "diagnostic_gate_passed": bool(all(checks.values())),
        "diagnostic_worth_passed": bool(
            epoch > 0 and selectable and all(checks.values())
        ),
        "epoch": int(epoch),
        "heldout_work_consulted": False,
        "phase_boundary": str(phase_boundary),
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


def _postselection_heldout_metrics(
    torch: Any,
    model: Any,
    *,
    cache: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    direct = r0._direct_family_metrics(
        torch,
        model,
        cache=cache,
        direct_rows=partition["heldout_direct_rows"],
    )
    page_full = r0._overlay_metrics(
        torch,
        model,
        cache=cache,
        groups=partition["heldout_page_groups"],
        candidate_ids=candidate_ids,
    )
    page = {
        key: page_full[key]
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
    }
    return {"direct_family": direct, "page_consistency": page}


def _fold_heldout_report(
    *,
    fold_index: int,
    heldout_work_id: str,
    selected_epoch: int,
    anchor: Mapping[str, Any],
    candidate: Mapping[str, Any],
    selected_record: Mapping[str, Any],
) -> Mapping[str, Any]:
    anchor_work = anchor["direct_family"]["work_macro"]
    candidate_work = candidate["direct_family"]["work_macro"]
    anchor_page = anchor["page_consistency"]
    candidate_page = candidate["page_consistency"]
    deltas = {
        key: float(candidate_work[key]) - float(anchor_work[key])
        for key in ("balanced_accuracy", "body_accuracy", "variant_accuracy")
    }
    checks = {
        "base_no_material_regression": bool(
            selected_record["base_no_material_regression"]
        ),
        "base_quality_gate_passed": bool(
            selected_record["base_metrics"]["quality_gate_passed"]
        ),
        "candidate_outputs_exact_anchor": bool(
            selected_record["candidate_outputs_exact_anchor"]
        ),
        "heldout_page_common_positive_nonregression": float(
            candidate_page["all_rows_top1_in_common_positive_rate"]
        )
        >= float(anchor_page["all_rows_top1_in_common_positive_rate"]),
        "heldout_page_top1_all_agree_nonregression": float(
            candidate_page["top1_all_agree_rate"]
        )
        >= float(anchor_page["top1_all_agree_rate"]),
        "heldout_variant_delta_at_least_negative_0_005": deltas["variant_accuracy"]
        > -0.005
        or math.isclose(
            deltas["variant_accuracy"],
            -0.005,
            rel_tol=0.0,
            abs_tol=METRIC_GATE_ABSOLUTE_TOLERANCE,
        ),
        "training_side_page_common_positive_nonregression": bool(
            selected_record["diagnostic_checks"][
                "page_common_positive_top1_nonregression"
            ]
        ),
        "training_side_page_top1_all_agree_nonregression": bool(
            selected_record["diagnostic_checks"]["page_top1_all_agree_nonregression"]
        ),
    }
    return {
        "anchor": anchor,
        "candidate": candidate,
        "checks": checks,
        "deltas": deltas,
        "fold_index": int(fold_index),
        "heldout_consulted_after_fold_winner_only": True,
        "heldout_used_for_fold_epoch_selection": False,
        "heldout_work_id": str(heldout_work_id),
        "selected_epoch": int(selected_epoch),
    }


def _metric_at_least(value: float, threshold: float) -> bool:
    return float(value) > float(threshold) or math.isclose(
        float(value),
        float(threshold),
        rel_tol=0.0,
        abs_tol=METRIC_GATE_ABSOLUTE_TOLERANCE,
    )


def _aggregate_logo_metrics(
    fold_reports: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    if not fold_reports:
        raise R21TrainingError("LOGO fold reports are empty")
    ordered = sorted(fold_reports, key=lambda value: int(value["fold_index"]))
    if [int(value["fold_index"]) for value in ordered] != list(range(len(ordered))):
        raise R21TrainingError("LOGO fold report order drifted")
    delta_keys = ("balanced_accuracy", "body_accuracy", "variant_accuracy")
    macro_delta = {
        key: float(np.mean([float(report["deltas"][key]) for report in ordered]))
        for key in delta_keys
    }
    worst_balanced = min(
        float(report["deltas"]["balanced_accuracy"]) for report in ordered
    )
    balanced_passed = _metric_at_least(macro_delta["balanced_accuracy"], 0.02)
    body_passed = _metric_at_least(macro_delta["body_accuracy"], 0.02)
    checks = {
        "all_fold_base_and_page_and_candidate_checks_passed": all(
            all(bool(value) for value in report["checks"].values())
            for report in ordered
        ),
        "all_fold_variant_deltas_at_least_negative_0_005": all(
            _metric_at_least(float(report["deltas"]["variant_accuracy"]), -0.005)
            for report in ordered
        ),
        "heldout_work_macro_balanced_accuracy_improved_by_0_02": balanced_passed,
        "heldout_work_macro_body_accuracy_improved_by_0_02": body_passed,
        "worst_heldout_work_balanced_accuracy_delta_at_least_negative_0_05": (
            _metric_at_least(worst_balanced, -0.05)
        ),
    }
    return {
        "checks": checks,
        "fold_count": int(len(ordered)),
        "gate_absolute_tolerance": METRIC_GATE_ABSOLUTE_TOLERANCE,
        "heldout_work_macro_delta": macro_delta,
        "passed": bool(all(checks.values())),
        "promotion_authority": False,
        "seed_is_schedule_order_not_independent_initializer": True,
        "worst_heldout_work_balanced_accuracy_delta": float(worst_balanced),
    }


def _selection_contract(
    *, selected_epoch: int, partition: Mapping[str, Any], args: argparse.Namespace
) -> Mapping[str, Any]:
    return {
        "anchor_fallback_selected": int(selected_epoch) == 0,
        "base_gradient_rows": int(len(partition["base_indices"])),
        "base_optimizer_calls_per_epoch": 1,
        "best_epoch": int(selected_epoch),
        "development_eval_consulted": False,
        "development_eval_gradient_rows": 0,
        "direct_family_gradient_rows": int(len(partition["direct_indices"])),
        "direct_optimizer_calls_per_epoch": 1,
        "heldout_direct_label_rows_consulted_during_epoch_selection": 0,
        "heldout_gradient_rows": 0,
        "heldout_page_label_rows_consulted_during_epoch_selection": 0,
        "heldout_work_id": str(partition["heldout_work_id"]),
        "hard_training_side_gate_required_for_nonzero_epoch": True,
        "page_gradient_rows": 0,
        "post_base_selectable_records": int(args.epochs),
        "post_direct_diagnostic_records": int(args.epochs),
        "post_direct_states_selectable": False,
        "selectable_state_boundary": "after_base_preservation_only",
        "selection_key_order": list(r1.SELECTION_KEY_ORDER),
        "selection_label_sources": [
            "fold_train_direct_family_labels",
            "fold_train_page_metric_safety",
            "external_r3_base_validation",
        ],
    }


def _train_one_fold(
    torch: Any,
    *,
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    cache: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    candidate_ids = tuple(context["candidate_ids"])
    model = _build_r21_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        feature_source=args.feature_source,
    ).to(cache["hidden"].device)
    model.anchor_model.eval()
    _assert_zero_output_anchor(torch, model, cache)
    optimizer = torch.optim.AdamW(
        tuple(model.family_margin_head.parameters()),
        lr=float(args.learning_rate),
        weight_decay=float(args.weight_decay),
    )
    try:
        class_weights, source_weight_denominator, base_balance = r2._base_class_balance(
            partition
        )
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error
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
        consumption=_zero_consumption(),
    )
    anchor_train = epoch0["training_only_selection_metrics"]
    initial_state = _sidecar_state(model, args.feature_source)
    history: list[Mapping[str, Any]] = [epoch0]
    phase_diagnostics: list[Mapping[str, Any]] = []
    best_record = epoch0
    best_state = initial_state
    best_key = _fold_selection_key(
        epoch=0,
        diagnostic_passed=False,
        base_metrics=epoch0["base_metrics"],
        base_regression=epoch0["base_regression_checks"],
        train_metrics=anchor_train,
    )
    for epoch in range(1, int(args.epochs) + 1):
        model.train()
        model.anchor_model.eval()
        direct_batches, direct_schedule = _direct_batches(
            torch,
            model,
            cache=cache,
            partition=partition,
            args=args,
            epoch=epoch,
        )
        direct_loss = _direct_accumulated_step(
            torch,
            model,
            optimizer,
            cache=cache,
            batches=direct_batches,
            fixed_denominator=int(direct_schedule["active_fold_denominator"]),
            args=args,
        )
        post_direct = _snapshot_record(
            torch,
            model,
            epoch=epoch,
            phase_boundary="after_direct_family",
            selectable=False,
            cache=cache,
            context=context,
            partition=partition,
            candidate_ids=candidate_ids,
            anchor_base_metrics=anchor_base_metrics,
            anchor_train_metrics=anchor_train,
            args=args,
            losses={
                "base_preservation": None,
                "direct_family": direct_loss,
                "page_body": None,
            },
            consumption=_phase_consumption(
                partition,
                direct_schedule=direct_schedule,
                direct_batches=direct_batches,
            ),
        )
        history.append(post_direct)
        base_batches, base_schedule = _base_batches(partition, args, epoch=epoch)
        base_loss = _base_accumulated_step(
            torch,
            model,
            optimizer,
            cache=cache,
            partition=partition,
            batches=base_batches,
            class_weights=class_weights,
            source_weight_denominator=source_weight_denominator,
            args=args,
        )
        post_base = _snapshot_record(
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
            anchor_train_metrics=anchor_train,
            args=args,
            losses={
                "base_preservation": base_loss,
                "direct_family": direct_loss,
                "page_body": None,
            },
            consumption=_phase_consumption(
                partition,
                direct_schedule=direct_schedule,
                direct_batches=direct_batches,
                base_schedule=base_schedule,
                base_batches=base_batches,
            ),
        )
        history.append(post_base)
        phase_diagnostics.append(
            r2._phase_comparison(
                epoch=epoch,
                anchor_record=epoch0,
                post_direct=post_direct,
                post_base=post_base,
                minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
            )
        )
        key = _fold_selection_key(
            epoch=epoch,
            diagnostic_passed=bool(post_base["diagnostic_worth_passed"]),
            base_metrics=post_base["base_metrics"],
            base_regression=post_base["base_regression_checks"],
            train_metrics=post_base["training_only_selection_metrics"],
        )
        if key > best_key:
            best_key = key
            best_record = post_base
            best_state = _sidecar_state(model, args.feature_source)
    _apply_sidecar_state(model, best_state, args.feature_source)
    selected_epoch = int(best_record["epoch"])
    selected_train = _fold_training_metrics(
        torch,
        model,
        cache=cache,
        context=context,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, initial_state, args.feature_source)
    anchor_heldout = _postselection_heldout_metrics(
        torch,
        model,
        cache=cache,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, best_state, args.feature_source)
    selected_heldout = _postselection_heldout_metrics(
        torch,
        model,
        cache=cache,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    heldout_report = _fold_heldout_report(
        fold_index=int(partition["contract"]["fold_index"]),
        heldout_work_id=str(partition["heldout_work_id"]),
        selected_epoch=selected_epoch,
        anchor=anchor_heldout,
        candidate=selected_heldout,
        selected_record=best_record,
    )
    result = {
        "anchor_base_metrics": anchor_base_metrics,
        "anchor_training_metrics": anchor_train,
        "base_class_balance": base_balance,
        "history": history,
        "heldout_postselection": heldout_report,
        "partition": partition["contract"],
        "phase_diagnostics": phase_diagnostics,
        "selected_base_metrics": best_record["base_metrics"],
        "selected_epoch": selected_epoch,
        "selected_training_metrics": selected_train,
        "selection": _selection_contract(
            selected_epoch=selected_epoch, partition=partition, args=args
        ),
        "sidecar_file": _sidecar_name(int(partition["contract"]["fold_index"])),
        "trajectory_replayed_by_strict_validator": False,
    }
    return result, best_state


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R21TrainingError("PyTorch is required") from error
    _validate_options(args)
    context = _load_context(args, torch)
    folds = _build_logo_folds(context, args, enforce_real=True)
    model = _build_r21_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        feature_source=args.feature_source,
    ).cpu()
    cache = _build_feature_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
        feature_source=args.feature_source,
    )
    _assert_zero_output_anchor(torch, model, cache)
    sample_batches, sample_schedule = _direct_batches(
        torch,
        model,
        cache=cache,
        partition=folds[0],
        args=args,
        epoch=1,
    )
    return {
        "architecture": _architecture_contract(
            model,
            feature_source=args.feature_source,
            maximum_margin=args.maximum_margin,
        ),
        "candidate_score_invariance": _candidate_invariance(cache),
        "configuration": _configuration(args),
        "development_work_count_sealed": len(
            context["overlay_binding"]["development_eval_work_ids"]
        ),
        "experiment_contract": _experiment_contract(),
        "fold_partitions": [fold["contract"] for fold in folds],
        "fold_work_order": [str(fold["heldout_work_id"]) for fold in folds],
        "objective_contract": _objective_contract(args, folds),
        "producer": _producer_binding(),
        "sample_fold_epoch1_direct_batch_count": len(sample_batches),
        "sample_fold_epoch1_direct_schedule": sample_schedule,
        "status": "ready_for_nonpromotable_r21_logo_training",
        "trainable_parameters": _trainable_contract(model, args.feature_source),
        "zero_output_initialization_exact_anchor": True,
    }


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    try:
        import torch
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R21TrainingError("PyTorch and safetensors are required") from error
    _validate_options(args)
    producer = _producer_binding()
    output = _safe_new_output(args.output_dir)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise R21TrainingError("CUDA was requested but is unavailable")
    torch.manual_seed(int(args.seed))
    np.random.seed(int(args.seed))
    if device.type == "cuda":
        torch.cuda.manual_seed_all(int(args.seed))
    started = time.monotonic()
    context = _load_context(args, torch)
    folds = _build_logo_folds(context, args, enforce_real=True)
    candidate_ids = tuple(context["candidate_ids"])
    cpu_cache = _build_feature_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
        feature_source=args.feature_source,
    )
    cache = {
        name: value.to(device) if device.type != "cpu" else value
        for name, value in cpu_cache.items()
    }
    probe_model = _build_r21_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        feature_source=args.feature_source,
    ).cpu()
    architecture = _architecture_contract(
        probe_model,
        feature_source=args.feature_source,
        maximum_margin=args.maximum_margin,
    )
    trainable = _trainable_contract(probe_model, args.feature_source)
    anchor_inventory = r0._anchor_tensor_inventory(probe_model.anchor_model)
    candidate_invariance = _candidate_invariance(cpu_cache)
    fold_records: list[Mapping[str, Any]] = []
    fold_states: list[Mapping[str, Any]] = []
    for fold in folds:
        record, state = _train_one_fold(
            torch,
            context=context,
            partition=fold,
            cache=cache,
            args=args,
        )
        fold_records.append(record)
        fold_states.append(state)
    if r0._anchor_tensor_inventory(context["model"]) != anchor_inventory:
        raise R21TrainingError("frozen anchor tensor bytes drifted")
    logo_aggregate = _aggregate_logo_metrics(
        [record["heldout_postselection"] for record in fold_records]
    )
    if _producer_binding() != producer:
        raise R21TrainingError("producer bytes changed during training")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        file_descriptors: dict[str, Any] = {}
        for fold_index, state in enumerate(fold_states):
            name = _sidecar_name(fold_index)
            path = staging / name
            save_file(
                {key: value.contiguous() for key, value in state.items()}, str(path)
            )
            file_descriptors[name] = {
                "byte_size": path.stat().st_size,
                "sha256": sha256_file(path),
                "tensor_inventory": r0._tensor_inventory(state),
            }
        context_contract = r0._context_contract(context, args)
        global_partition = _global_partition(context, args, enforce_real=True)
        manifest = seal_record(
            {
                "anchor": context_contract["anchor"],
                "anchor_tensor_inventory": anchor_inventory,
                "architecture": architecture,
                "authority": dict(EXPECTED_AUTHORITY),
                "base_dataset": context_contract["base_dataset"],
                "candidate_ids": list(candidate_ids),
                "candidate_score_invariance": candidate_invariance,
                "configuration": _configuration(args),
                "development_boundary": {
                    "consulted": False,
                    "gradient_rows": 0,
                    "work_ids": sorted(
                        str(value)
                        for value in context["overlay_binding"][
                            "development_eval_work_ids"
                        ]
                    ),
                },
                "experiment_contract": _experiment_contract(),
                "files": file_descriptors,
                "folds": fold_records,
                "global_partition": global_partition["contract"],
                "logo_aggregate": logo_aggregate,
                "objective_contract": _objective_contract(args, folds),
                "overlay": context_contract["overlay"],
                "producer": producer,
                "record_type": "manga_font_v3_family_residual_r21_logo_manifest",
                "runtime_boundary": dict(EXPECTED_RUNTIME_BOUNDARY),
                "schema_version": SCHEMA_VERSION,
                "source_query_head": context_contract["source_query_head"],
                "trainable_parameters": trainable,
                "training_seconds": max(float(time.monotonic() - started), 1e-9),
                "work_universe": [str(fold["heldout_work_id"]) for fold in folds],
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        artifacts = {
            MANIFEST_FILE: sha256_file(manifest_path),
            **{
                _sidecar_name(index): sha256_file(staging / _sidecar_name(index))
                for index in range(FOLD_COUNT)
            },
        }
        marker = seal_record(
            {
                "artifacts": artifacts,
                "owner": OWNER,
                "producer": producer,
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


def _validate_loss_mapping(value: Any, location: str) -> Mapping[str, Any]:
    loss = _mapping(value, location)
    if set(loss) != {"anchor_kl", "family_ce", "residual_l2", "total"}:
        raise R21TrainingError(f"{location}: loss inventory drifted")
    if any(
        isinstance(number, bool)
        or not isinstance(number, (int, float))
        or not math.isfinite(float(number))
        or float(number) < 0
        for number in loss.values()
    ):
        raise R21TrainingError(f"{location}: loss value drifted")
    return loss


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
        rel_tol=LOSS_RELATIVE_TOLERANCE,
        abs_tol=LOSS_ABSOLUTE_TOLERANCE,
    ):
        raise R21TrainingError(f"{location}: weighted total algebra drifted")


def _validate_phase_losses(
    value: Any,
    location: str,
    *,
    base_completed: bool,
    args: argparse.Namespace,
) -> Mapping[str, Any]:
    losses = _mapping(value, location)
    if set(losses) != {"base_preservation", "direct_family", "page_body"}:
        raise R21TrainingError(f"{location}: phase loss inventory drifted")
    direct = _validate_loss_mapping(losses["direct_family"], f"{location}.direct")
    if float(direct["anchor_kl"]) != 0.0:
        raise R21TrainingError(f"{location}: direct anchor KL drifted")
    _validate_loss_algebra(
        direct,
        f"{location}.direct",
        family_ce_weight=args.direct_family_ce_weight,
        anchor_kl_weight=0.0,
        residual_l2_weight=args.residual_l2_weight,
    )
    if base_completed:
        base = _validate_loss_mapping(losses["base_preservation"], f"{location}.base")
        _validate_loss_algebra(
            base,
            f"{location}.base",
            family_ce_weight=args.base_family_ce_weight,
            anchor_kl_weight=args.anchor_kl_weight,
            residual_l2_weight=args.residual_l2_weight,
        )
    elif losses["base_preservation"] is not None:
        raise R21TrainingError(f"{location}: pre-base loss must be null")
    if losses["page_body"] is not None:
        raise R21TrainingError(f"{location}: page loss must be null")
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
        "heldout_work_consulted",
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
        raise R21TrainingError(
            f"history[{expected_epoch},{expected_boundary}] inventory drifted"
        )
    if (
        record.get("epoch") != expected_epoch
        or record.get("phase_boundary") != expected_boundary
        or record.get("selectable_for_checkpoint") is not expected_selectable
        or record.get("development_eval_consulted") is not False
        or record.get("heldout_work_consulted") is not False
        or record.get("candidate_outputs_exact_anchor") is not True
        or record.get("batch_consumption") != expected_consumption
    ):
        raise R21TrainingError(
            f"history[{expected_epoch},{expected_boundary}] boundary drifted"
        )
    expected_inputs = (
        [
            "fold_train_direct_family_labels",
            "fold_train_page_metric_safety",
            "external_r3_base_validation",
        ]
        if expected_selectable
        else []
    )
    if record.get("checkpoint_selection_inputs") != expected_inputs:
        raise R21TrainingError(
            f"history[{expected_epoch},{expected_boundary}] selection input drifted"
        )
    payload = _mapping(record.get("sidecar_state"), "history sidecar state")
    if record.get("sidecar_state_sha256") != _payload_sha256(payload):
        raise R21TrainingError("history sidecar state seal drifted")
    state = _state_from_payload(torch, payload, args.feature_source)
    _apply_sidecar_state(model, state, args.feature_source)
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
    train_metrics = _fold_training_metrics(
        torch,
        model,
        cache=cache,
        context=context,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    reference = train_metrics if anchor_train_metrics is None else anchor_train_metrics
    checks = _fold_diagnostic_checks(
        anchor_train=reference,
        candidate_train=train_metrics,
        base_metrics=base_metrics,
        base_regression=regression,
        minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
    )
    _assert_nested_close(
        record.get("base_metrics"), base_metrics, "history base metrics"
    )
    if record.get("base_regression_checks") != regression or record.get(
        "base_no_material_regression"
    ) is not all(regression.values()):
        raise R21TrainingError("history base regression drifted")
    _assert_nested_close(
        record.get("training_only_selection_metrics"),
        train_metrics,
        "history training metrics",
    )
    if (
        record.get("diagnostic_checks") != checks
        or record.get("diagnostic_gate_passed") is not all(checks.values())
        or record.get("diagnostic_worth_passed")
        is not bool(expected_epoch > 0 and expected_selectable and all(checks.values()))
    ):
        raise R21TrainingError("history diagnostic gate drifted")
    subgroup = r1._subgroup_margin_flip_diagnostics(
        torch,
        model,
        cache=cache,
        context=context,
        partition=partition,
    )
    _assert_nested_close(
        record.get("subgroup_margin_flip_diagnostics"),
        subgroup,
        "history subgroup diagnostics",
    )
    return state, base_metrics, train_metrics


def _strict_fold_recompute(
    torch: Any,
    *,
    fold_record: Mapping[str, Any],
    model: Any,
    cache: Mapping[str, Any],
    context: Mapping[str, Any],
    partition: Mapping[str, Any],
    candidate_ids: Sequence[str],
    args: argparse.Namespace,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    expected_fold_keys = {
        "anchor_base_metrics",
        "anchor_training_metrics",
        "base_class_balance",
        "heldout_postselection",
        "history",
        "partition",
        "phase_diagnostics",
        "selected_base_metrics",
        "selected_epoch",
        "selected_training_metrics",
        "selection",
        "sidecar_file",
        "trajectory_replayed_by_strict_validator",
    }
    if set(fold_record) != expected_fold_keys:
        raise R21TrainingError("fold record inventory drifted")
    if (
        fold_record.get("partition") != partition["contract"]
        or fold_record.get("sidecar_file")
        != _sidecar_name(int(partition["contract"]["fold_index"]))
        or fold_record.get("trajectory_replayed_by_strict_validator") is not False
    ):
        raise R21TrainingError("fold record binding drifted")
    history = fold_record.get("history")
    if not isinstance(history, list) or len(history) != 1 + int(args.epochs) * 2:
        raise R21TrainingError("fold history inventory drifted")
    initial_model = _build_r21_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        feature_source=args.feature_source,
    ).cpu()
    initial_state_expected = _sidecar_state(initial_model, args.feature_source)
    _apply_sidecar_state(model, initial_state_expected, args.feature_source)
    candidate_ids = tuple(candidate_ids)
    anchor_base_metrics = r0._evaluate_base_from_cache(
        torch,
        model,
        cache=cache,
        arrays=context["arrays"],
        candidate_ids=candidate_ids,
    )
    initial_state, _base, anchor_train = _record_recompute(
        torch,
        record=_mapping(history[0], "fold history[0]"),
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
    if _state_payload(initial_state, args.feature_source) != _state_payload(
        initial_state_expected, args.feature_source
    ):
        raise R21TrainingError("fold epoch0 is not exact zero initializer")
    _assert_nested_close(
        fold_record.get("anchor_base_metrics"),
        anchor_base_metrics,
        "fold anchor base metrics",
    )
    _assert_nested_close(
        fold_record.get("anchor_training_metrics"),
        anchor_train,
        "fold anchor training metrics",
    )
    try:
        _class_weights, _denominator, base_balance = r2._base_class_balance(partition)
    except r2.R2TrainingError as error:
        raise R21TrainingError(str(error)) from error
    if fold_record.get("base_class_balance") != base_balance:
        raise R21TrainingError("fold base balance drifted")
    best_epoch = 0
    best_state = initial_state
    best_record = _mapping(history[0], "fold history[0]")
    best_key = _fold_selection_key(
        epoch=0,
        diagnostic_passed=False,
        base_metrics=best_record["base_metrics"],
        base_regression=best_record["base_regression_checks"],
        train_metrics=anchor_train,
    )
    phase_diagnostics: list[Mapping[str, Any]] = []
    previous_state = initial_state
    cursor = 1
    for epoch in range(1, int(args.epochs) + 1):
        _apply_sidecar_state(model, previous_state, args.feature_source)
        direct_batches, direct_schedule = _direct_batches(
            torch,
            model,
            cache=cache,
            partition=partition,
            args=args,
            epoch=epoch,
        )
        direct_record = _mapping(history[cursor], f"fold history[{cursor}]")
        cursor += 1
        direct_state, _direct_base, _direct_train = _record_recompute(
            torch,
            record=direct_record,
            expected_epoch=epoch,
            expected_boundary="after_direct_family",
            expected_selectable=False,
            expected_consumption=_phase_consumption(
                partition,
                direct_schedule=direct_schedule,
                direct_batches=direct_batches,
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
        direct_losses = _validate_phase_losses(
            direct_record.get("phase_losses"),
            f"fold history[{cursor - 1}].phase_losses",
            base_completed=False,
            args=args,
        )
        base_batches, base_schedule = _base_batches(partition, args, epoch=epoch)
        post_base_record = _mapping(history[cursor], f"fold history[{cursor}]")
        cursor += 1
        post_base_state, _post_base, post_base_train = _record_recompute(
            torch,
            record=post_base_record,
            expected_epoch=epoch,
            expected_boundary="after_base_preservation",
            expected_selectable=True,
            expected_consumption=_phase_consumption(
                partition,
                direct_schedule=direct_schedule,
                direct_batches=direct_batches,
                base_schedule=base_schedule,
                base_batches=base_batches,
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
            f"fold history[{cursor - 1}].phase_losses",
            base_completed=True,
            args=args,
        )
        if post_base_losses["direct_family"] != direct_losses["direct_family"]:
            raise R21TrainingError("fold direct loss transcript drifted")
        comparison = r2._phase_comparison(
            epoch=epoch,
            anchor_record=history[0],
            post_direct=direct_record,
            post_base=post_base_record,
            minimum_improvement=args.minimum_diagnostic_work_macro_improvement,
        )
        phase_diagnostics.append(comparison)
        key = _fold_selection_key(
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
        previous_state = post_base_state
        _ = direct_state
    if cursor != len(history):
        raise R21TrainingError("fold history cursor drifted")
    _assert_nested_close(
        fold_record.get("phase_diagnostics"),
        phase_diagnostics,
        "fold phase diagnostics",
    )
    if fold_record.get("selected_epoch") != best_epoch or fold_record.get(
        "selection"
    ) != _selection_contract(selected_epoch=best_epoch, partition=partition, args=args):
        raise R21TrainingError("fold selection drifted")
    _assert_nested_close(
        fold_record.get("selected_base_metrics"),
        best_record["base_metrics"],
        "fold selected base metrics",
    )
    _assert_nested_close(
        fold_record.get("selected_training_metrics"),
        best_record["training_only_selection_metrics"],
        "fold selected training metrics",
    )
    _apply_sidecar_state(model, initial_state, args.feature_source)
    anchor_heldout = _postselection_heldout_metrics(
        torch,
        model,
        cache=cache,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    _apply_sidecar_state(model, best_state, args.feature_source)
    candidate_heldout = _postselection_heldout_metrics(
        torch,
        model,
        cache=cache,
        partition=partition,
        candidate_ids=candidate_ids,
    )
    heldout_report = _fold_heldout_report(
        fold_index=int(partition["contract"]["fold_index"]),
        heldout_work_id=str(partition["heldout_work_id"]),
        selected_epoch=best_epoch,
        anchor=anchor_heldout,
        candidate=candidate_heldout,
        selected_record=best_record,
    )
    _assert_nested_close(
        fold_record.get("heldout_postselection"),
        heldout_report,
        "fold heldout postselection",
    )
    return best_state, heldout_report


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise R21TrainingError("PyTorch is required") from error
    producer = _producer_binding()
    expanded = output_dir.expanduser().absolute()
    if r0.overlay_v3._path_or_ancestor_is_link_or_reparse(expanded):
        raise R21TrainingError("output cannot be linked or reparsed")
    root = expanded.resolve()
    if (
        not root.is_dir()
        or r0.overlay_v3._contains_link_or_reparse(root)
        or {path.name for path in root.iterdir()} != _output_files()
    ):
        raise R21TrainingError("output inventory drifted")
    marker_path = root / MARKER_FILE
    manifest_path = root / MANIFEST_FILE
    marker = _read_json(marker_path, "ownership marker")
    manifest = _read_json(manifest_path, "manifest")
    _validate_record_seal(marker, "ownership marker")
    _validate_record_seal(manifest, "manifest")
    expected_artifact_names = {MANIFEST_FILE} | {
        _sidecar_name(index) for index in range(FOLD_COUNT)
    }
    marker_artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    if (
        set(marker)
        != {
            "artifacts",
            "owner",
            "record_sha256",
            "safe_replace",
            "schema_version",
            "producer",
        }
        or marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not False
        or set(marker_artifacts) != expected_artifact_names
        or marker_artifacts.get(MANIFEST_FILE) != sha256_file(manifest_path)
        or any(
            marker_artifacts.get(name) != sha256_file(root / name)
            for name in expected_artifact_names - {MANIFEST_FILE}
        )
    ):
        raise R21TrainingError("ownership marker binding drifted")
    if marker.get("producer") != producer:
        raise R21TrainingError("ownership marker producer binding drifted")
    if (
        set(manifest) != EXPECTED_MANIFEST_KEYS
        or manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type")
        != "manga_font_v3_family_residual_r21_logo_manifest"
        or manifest.get("authority") != EXPECTED_AUTHORITY
        or manifest.get("runtime_boundary") != EXPECTED_RUNTIME_BOUNDARY
        or manifest.get("experiment_contract") != _experiment_contract()
    ):
        raise R21TrainingError("manifest authority or schema drifted")
    if manifest.get("producer") != producer or manifest.get("producer") != marker.get(
        "producer"
    ):
        raise R21TrainingError("manifest producer binding drifted")
    training_seconds = manifest.get("training_seconds")
    if (
        isinstance(training_seconds, bool)
        or not isinstance(training_seconds, (int, float))
        or not math.isfinite(float(training_seconds))
        or float(training_seconds) <= 0
    ):
        raise R21TrainingError("training seconds drifted")
    configuration = _mapping(manifest.get("configuration"), "configuration")
    if set(configuration) != EXPECTED_CONFIGURATION_KEYS:
        raise R21TrainingError("configuration inventory drifted")
    args = _configuration_args(manifest, configuration)
    _validate_options(args)
    if configuration.get("device") not in {"cpu", "cuda"}:
        raise R21TrainingError("training device claim drifted")
    files = _mapping(manifest.get("files"), "manifest files")
    sidecar_names = {_sidecar_name(index) for index in range(FOLD_COUNT)}
    if set(files) != sidecar_names:
        raise R21TrainingError("manifest sidecar inventory drifted")
    checkpoint_states: list[Mapping[str, Any]] = []
    for fold_index in range(FOLD_COUNT):
        name = _sidecar_name(fold_index)
        path = root / name
        descriptor = _mapping(files[name], f"files.{name}")
        if set(descriptor) != {"byte_size", "sha256", "tensor_inventory"} or (
            descriptor.get("byte_size") != path.stat().st_size
            or descriptor.get("sha256") != sha256_file(path)
        ):
            raise R21TrainingError(f"sidecar descriptor drifted: {name}")
        state = _load_sidecar_state(torch, path, args.feature_source)
        if descriptor.get("tensor_inventory") != r0._tensor_inventory(state):
            raise R21TrainingError(f"sidecar tensor inventory drifted: {name}")
        checkpoint_states.append(state)
    context = _load_context(args, torch)
    expected_context = r0._context_contract(context, args)
    for key in ("anchor", "base_dataset", "overlay", "source_query_head"):
        if manifest.get(key) != expected_context[key]:
            raise R21TrainingError(f"{key} binding drifted")
    candidate_ids = tuple(context["candidate_ids"])
    if manifest.get("candidate_ids") != list(candidate_ids):
        raise R21TrainingError("candidate ID inventory drifted")
    folds = _build_logo_folds(context, args, enforce_real=True)
    expected_work_universe = [str(fold["heldout_work_id"]) for fold in folds]
    if manifest.get("work_universe") != expected_work_universe:
        raise R21TrainingError("work universe drifted")
    global_partition = _global_partition(context, args, enforce_real=True)
    if manifest.get("global_partition") != global_partition["contract"]:
        raise R21TrainingError("global partition drifted")
    if manifest.get("objective_contract") != _objective_contract(args, folds):
        raise R21TrainingError("objective contract drifted")
    development_boundary = {
        "consulted": False,
        "gradient_rows": 0,
        "work_ids": sorted(
            str(value)
            for value in context["overlay_binding"]["development_eval_work_ids"]
        ),
    }
    if manifest.get("development_boundary") != development_boundary:
        raise R21TrainingError("development boundary drifted")
    model = _build_r21_model(
        torch,
        anchor_model=context["model"],
        maximum_margin=args.maximum_margin,
        feature_source=args.feature_source,
    ).cpu()
    cache = _build_feature_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=args.evaluation_batch_size,
        feature_source=args.feature_source,
    )
    _assert_zero_output_anchor(torch, model, cache)
    architecture = _architecture_contract(
        model,
        feature_source=args.feature_source,
        maximum_margin=args.maximum_margin,
    )
    if manifest.get("architecture") != architecture:
        raise R21TrainingError("architecture contract drifted")
    trainable = _trainable_contract(model, args.feature_source)
    if manifest.get("trainable_parameters") != trainable:
        raise R21TrainingError("trainable parameter contract drifted")
    anchor_inventory = r0._anchor_tensor_inventory(model.anchor_model)
    if manifest.get("anchor_tensor_inventory") != anchor_inventory:
        raise R21TrainingError("anchor tensor inventory drifted")
    candidate_invariance = _candidate_invariance(cache)
    if manifest.get("candidate_score_invariance") != candidate_invariance:
        raise R21TrainingError("candidate score invariance drifted")
    fold_records = manifest.get("folds")
    if not isinstance(fold_records, list) or len(fold_records) != FOLD_COUNT:
        raise R21TrainingError("manifest fold inventory drifted")
    heldout_reports: list[Mapping[str, Any]] = []
    for fold_index, (fold_record_value, partition, checkpoint_state) in enumerate(
        zip(fold_records, folds, checkpoint_states, strict=True)
    ):
        fold_record = _mapping(fold_record_value, f"folds[{fold_index}]")
        selected_state, heldout_report = _strict_fold_recompute(
            torch,
            fold_record=fold_record,
            model=model,
            cache=cache,
            context=context,
            partition=partition,
            candidate_ids=candidate_ids,
            args=args,
        )
        if _state_payload(checkpoint_state, args.feature_source) != _state_payload(
            selected_state, args.feature_source
        ):
            raise R21TrainingError(
                f"fold {fold_index} sidecar is not selected post-base state"
            )
        if int(fold_record["selected_epoch"]) == 0:
            exact_zero_model = _build_r21_model(
                torch,
                anchor_model=context["model"],
                maximum_margin=args.maximum_margin,
                feature_source=args.feature_source,
            ).cpu()
            exact_zero = _sidecar_state(exact_zero_model, args.feature_source)
            if _state_payload(checkpoint_state, args.feature_source) != _state_payload(
                exact_zero, args.feature_source
            ):
                raise R21TrainingError(
                    f"fold {fold_index} fallback is not exact zero initializer"
                )
        heldout_reports.append(heldout_report)
    aggregate = _aggregate_logo_metrics(heldout_reports)
    if manifest.get("logo_aggregate") != aggregate:
        raise R21TrainingError("LOGO aggregate drifted")
    return {
        "candidate_score_sha256": candidate_invariance["three_output_sha256"],
        "direct_objective": args.direct_objective,
        "feature_source": args.feature_source,
        "fold_count": FOLD_COUNT,
        "logo_diagnostic_worth": bool(aggregate["passed"]),
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_file(manifest_path),
        "output_dir": str(root),
        "producer": producer,
        "read_only_recomputation": True,
        "schema_version": SCHEMA_VERSION,
        "seed": int(args.seed),
        "status": "valid_nonpromotable_r21_residual_supervision_logo_diagnostic",
        "trajectory_replay_authority": False,
    }


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    validation = validate_output(args.output_dir)
    return {
        **validation,
        "development_evaluation_opened": False,
        "evaluation_authority": False,
        "note": (
            "strict CPU source/state/metric recomputation; optimizer trajectory is producer-attested, "
            "the frozen anchor is not work-unseen, and development works remain sealed"
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
    parser.add_argument(
        "--feature-source", choices=FEATURE_SOURCES, default="shared_hidden64"
    )
    parser.add_argument(
        "--direct-objective", choices=DIRECT_OBJECTIVES, default="work_family_ce"
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
    parser.add_argument("--seed", type=int, choices=INITIAL_SEEDS, default=20260820)
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
        else:  # pragma: no cover - argparse owns enum
            parser.error("unsupported command")
    except R21TrainingError as error:
        parser.error(str(error))
    print(canonical_json(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
