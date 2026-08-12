#!/usr/bin/env python3
"""Fit a precision-first pixel-only variant-to-body override above frozen r3h.

This experiment is deliberately narrower than the role/family adapter.  The
sealed r3h model remains the default, and the learned head may only turn a
pixel-predicted ``variant`` into ``body``.  It can never create a variant from
body.  Candidate selection uses:

* work-LOGO predictions for the 1,347 training-only direct visual role labels;
* the r3 work-disjoint validation rows after identity-only val33 exclusion; and
* the sealed 1,047-row visual subset of that validation fold.

Fresh QA pages and QA holdouts are not accepted as inputs.  Text, translation,
genre, work identity, Gemma output, and font names are not model features.
The output is an experiment-only adapter or a fail-closed rejection artifact;
this script has no ONNX, runtime, QA-run, or promotion path.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import augment_manga_font_student_v8_with_high_value_labels_r3_base_v2 as overlay
    from scripts import build_manga_font_student_v8_role_family_dataset as base_dataset
    from scripts import seal_manga_font_v2_high_value_supervised_labels_range_v6 as labels_v6
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import augment_manga_font_student_v8_with_high_value_labels_r3_base_v2 as overlay
    import build_manga_font_student_v8_role_family_dataset as base_dataset
    import seal_manga_font_v2_high_value_supervised_labels_range_v6 as labels_v6
    import train_manga_font_student_v8_role_family_adapter as trainer


SCHEMA_VERSION = "manga-font-r3h-high-precision-body-override-v2"
OWNER = f"carrot-manga-translator/{SCHEMA_VERSION}"
CHECKPOINT_FILE = "body-override-adapter.safetensors"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
MARKER_FILE = ".manga-font-r3h-high-precision-body-override-v2-owned.json"

DIRECT_ROWS = 1_347
DIRECT_WORKS = 13
SELECTION_ROWS = 9_000
VISUAL_SELECTION_ROWS = 1_047
VAL33_ROWS = 33
RANDOM_SEED = 8_621
SKETCH_MAX_RANK = 128
MINIMUM_OVERRIDE_ROWS = 5
MINIMUM_COVERED_WORKS = 3
MINIMUM_OVERRIDE_PRECISION = 0.90
MINIMUM_MACRO_WORK_PRECISION = 0.90
MINIMUM_HELDOUT_OVERRIDE_PRECISION = 0.90
MINIMUM_DIRECT_VARIANT_RETENTION = 0.98
MINIMUM_SELECTION_VARIANT_RETENTION = 0.995
MINIMUM_VISUAL_VARIANT_RETENTION = 0.995
VARIANT_PROBABILITY_CAPS = (0.80, 0.90, 0.95, 0.98, 0.99, 0.995, 1.0)

FORBIDDEN_PATH_TOKENS = (
    "library-full-pipeline-font-qa-v10",
    "fresh-gemma",
    "holdout40",
)


class BodyOverrideError(ValueError):
    """Raised when the precision-first experiment crosses a sealed boundary."""


@dataclass(frozen=True)
class CandidateSpec:
    candidate_id: str
    feature_kind: str
    regularization_c: float
    auxiliary_weight: float


# Small, fixed research grid.  It was chosen after the broad 54-combination
# reconnaissance; the published artifact records that reconnaissance as prior
# exploratory work and treats only this reduced grid as the reproducible build.
CANDIDATES = (
    CandidateSpec("cos-c001-a025", "cosine", 0.01, 0.25),
    CandidateSpec("sk64-c001-a010", "sketch64", 0.01, 0.10),
    CandidateSpec("sk64-c001-a025", "sketch64", 0.01, 0.25),
    CandidateSpec("sk128-c001-a025", "sketch128", 0.01, 0.25),
    CandidateSpec("sk64cos-c010-a010", "sketch64_cosine", 0.10, 0.10),
    CandidateSpec("sk64cos-c010-a050", "sketch64_cosine", 0.10, 0.50),
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    return (rendered + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = hashlib.sha256(
        canonical_json(result).encode("utf-8")
    ).hexdigest()
    return result


def validate_record_seal(value: Mapping[str, Any], location: str) -> None:
    declared = value.get("record_sha256")
    if not isinstance(declared, str) or declared != seal_record(value)["record_sha256"]:
        raise BodyOverrideError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise BodyOverrideError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise BodyOverrideError(f"{location}: missing or linked file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BodyOverrideError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise BodyOverrideError(f"unsafe output directory: {result}")
    return result


def _reject_forbidden_input_path(path: Path, location: str) -> Path:
    resolved = path.expanduser().resolve()
    folded = str(resolved).replace("\\", "/").casefold()
    if any(token in folded for token in FORBIDDEN_PATH_TOKENS):
        raise BodyOverrideError(f"{location}: fresh/holdout QA input is forbidden")
    return resolved


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise BodyOverrideError(f"missing artifact: {path.name}")
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def fixed_gaussian_projection(
    input_dim: int, output_dim: int, *, seed: int = RANDOM_SEED
) -> np.ndarray:
    """Return a deterministic label-free column-normalized Gaussian sketch."""

    if input_dim < 2 or not 1 <= output_dim <= input_dim:
        raise BodyOverrideError("invalid fixed sketch dimensions")
    generator = np.random.default_rng(seed)
    result = generator.standard_normal((input_dim, output_dim)).astype("<f4")
    norms = np.linalg.norm(result, axis=0, keepdims=True)
    if np.any(norms <= 0) or not np.isfinite(norms).all():
        raise BodyOverrideError("fixed sketch norm is invalid")
    result /= norms
    if not np.isfinite(result).all():
        raise BodyOverrideError("fixed sketch is non-finite")
    return np.ascontiguousarray(result, dtype="<f4")


def percentile_score(reference: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Calibrate fold/final decision values by their train empirical CDF."""

    reference = np.asarray(reference, dtype=np.float64).reshape(-1)
    values = np.asarray(values, dtype=np.float64).reshape(-1)
    if reference.size < 2 or not np.isfinite(reference).all() or not np.isfinite(values).all():
        raise BodyOverrideError("percentile calibration input is invalid")
    ordered = np.sort(reference, kind="stable")
    return np.searchsorted(ordered, values, side="right") / float(ordered.size)


def apply_variant_to_body_override(
    family_logits: np.ndarray,
    percentile_scores: np.ndarray,
    *,
    threshold: float,
    maximum_variant_probability: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Apply the one-way override; a base-body row is immutable by construction."""

    logits = np.asarray(family_logits, dtype=np.float32)
    scores = np.asarray(percentile_scores, dtype=np.float64).reshape(-1)
    if logits.ndim != 2 or logits.shape[1] != 2 or logits.shape[0] != scores.size:
        raise BodyOverrideError("override logits/scores shape drifted")
    shifted = logits.astype(np.float64) - logits.max(axis=1, keepdims=True)
    probabilities = np.exp(shifted)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    base_family = logits.argmax(axis=1)
    override = (
        (base_family == trainer.VARIANT_FAMILY_INDEX)
        & (scores >= float(threshold))
        & (
            probabilities[:, trainer.VARIANT_FAMILY_INDEX]
            <= float(maximum_variant_probability)
        )
    )
    result = logits.copy()
    maximum = result[override].max(axis=1) + 1.0
    result[override, trainer.BODY_FAMILY_INDEX] = maximum
    result[override, trainer.VARIANT_FAMILY_INDEX] = maximum - 1.0
    if np.any(result[base_family == trainer.BODY_FAMILY_INDEX] != logits[base_family == trainer.BODY_FAMILY_INDEX]):
        raise BodyOverrideError("body-to-variant mutation became possible")
    return result, override


def _load_identity_ids(path: Path, *, expected: int) -> tuple[str, ...]:
    """Read only sample identity for exclusion; no val33 label is returned."""

    values: list[str] = []
    try:
        with path.open(encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                row = json.loads(line)
                sample_id = row.get("sample_id") if isinstance(row, Mapping) else None
                if not isinstance(sample_id, str) or not sample_id:
                    raise BodyOverrideError(
                        f"val33 identity:{line_number}: sample ID is absent"
                    )
                values.append(sample_id)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BodyOverrideError("val33 identity source is invalid") from error
    if len(values) != expected or len(set(values)) != expected:
        raise BodyOverrideError(f"expected {expected} unique val33 identities")
    return tuple(values)


def _load_direct_labels(
    labels_dir: Path,
    *,
    arrays: Mapping[str, np.ndarray],
) -> tuple[list[dict[str, Any]], np.ndarray, Mapping[str, Any]]:
    validation = labels_v6.validate_output(labels_dir)
    if (
        validation.get("training_label_rows") != DIRECT_ROWS
        or validation.get("expected_queue_row_span") != [1, 1600]
    ):
        raise BodyOverrideError("direct-label cardinality/span drifted")
    labels_path = labels_dir / labels_v6.base.LABELS_FILE
    rows: list[dict[str, Any]] = []
    with labels_path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"direct label:{line_number}"))
            except json.JSONDecodeError as error:
                raise BodyOverrideError(f"direct label:{line_number}: invalid JSON") from error
            authority = _mapping(row.get("authority"), f"direct label:{line_number} authority")
            identity = _mapping(row.get("identity"), f"direct label:{line_number} identity")
            family = row.get("family")
            role = row.get("role")
            if (
                row.get("schema_version") != labels_v6.base.SCHEMA
                or authority.get("training_only") is not True
                or authority.get("training_eligible") is not True
                or authority.get("evaluation_eligible") is not False
                or authority.get("calibration_eligible") is not False
                or authority.get("review_authority")
                != "codex_agent_direct_visual_supervision"
                or family not in trainer.FAMILY_VALUES
                or trainer.role_family_index(str(role))
                != trainer.FAMILY_VALUES.index(str(family))
                or not isinstance(identity.get("work_id"), str)
            ):
                raise BodyOverrideError(f"direct label:{line_number}: authority/role drifted")
            rows.append(row)
    if len(rows) != DIRECT_ROWS:
        raise BodyOverrideError("direct-label row count drifted")
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    positions = {sample_id: index for index, sample_id in enumerate(sample_ids)}
    if len(positions) != len(sample_ids):
        raise BodyOverrideError("dataset sample IDs are duplicated")
    direct_ids = tuple(str(row.get("sample_id")) for row in rows)
    if len(set(direct_ids)) != DIRECT_ROWS or any(value not in positions for value in direct_ids):
        raise BodyOverrideError("direct-label sample identity drifted")
    indices = np.asarray([positions[value] for value in direct_ids], dtype=np.int64)
    families = arrays["family_labels"].astype(np.int64, copy=False)
    works = arrays["work_ids"].astype(str, copy=False)
    splits = arrays["split"].astype(np.int64, copy=False)
    for row, index in zip(rows, indices.tolist(), strict=True):
        if (
            splits[index] != 0
            or trainer.FAMILY_VALUES[int(families[index])] != row["family"]
            or works[index] != row["identity"]["work_id"]
        ):
            raise BodyOverrideError("direct label escaped train/family/work binding")
    if len(set(works[indices].tolist())) != DIRECT_WORKS:
        raise BodyOverrideError("direct-label work cardinality drifted")
    return rows, indices, {
        "labels": _descriptor(labels_path, row_count=DIRECT_ROWS),
        "manifest": _descriptor(labels_dir / labels_v6.base.MANIFEST_FILE),
        "validation": dict(validation),
    }


def _load_inputs(args: argparse.Namespace) -> Mapping[str, Any]:
    dataset_dir = _reject_forbidden_input_path(args.dataset_dir, "dataset")
    base_npz = _reject_forbidden_input_path(args.base_dataset_npz, "base dataset")
    labels_dir = _reject_forbidden_input_path(args.labels_dir, "labels")
    val33_path = _reject_forbidden_input_path(args.val33_jsonl, "val33 identities")
    adapter_dir = _reject_forbidden_input_path(args.base_adapter_dir, "base adapter")
    query_head = _reject_forbidden_input_path(args.source_query_head, "query head")
    overlay_validation = overlay.validate_output(dataset_dir)
    base_validation = base_dataset.validate_output(base_npz.parent)
    dataset_npz = dataset_dir / overlay.DATASET_FILE
    if (
        dataset_npz.name != overlay.DATASET_FILE
        or base_npz.name != base_dataset.DATASET_FILE
        or overlay_validation.get("high_value_overlay_rows") != DIRECT_ROWS
        or base_validation.get("work_overlap_count") != 0
    ):
        raise BodyOverrideError("dataset artifact boundary drifted")
    _path, arrays, inventory = trainer._load_training_npz(dataset_npz)  # noqa: SLF001
    _base_path, base_arrays, base_inventory = trainer._load_training_npz(base_npz)  # noqa: SLF001
    if (
        inventory["row_count"] != 23_882
        or inventory["train_rows"] != 14_849
        or inventory["val_rows"] != 9_033
        or inventory["train_work_count"] != 14
        or inventory["val_work_count"] != 5
        or tuple(inventory["candidate_ids"]) != tuple(base_inventory["candidate_ids"])
    ):
        raise BodyOverrideError("dataset cardinality/candidate contract drifted")
    overlay_val = arrays["split"].astype(np.int64, copy=False) == 1
    base_val = base_arrays["split"].astype(np.int64, copy=False) == 1
    for name in sorted(arrays):
        if name in {"candidate_ids", "prototype_queries"}:
            if not np.array_equal(arrays[name], base_arrays[name]):
                raise BodyOverrideError(f"static dataset array drifted: {name}")
            continue
        if not np.array_equal(arrays[name][overlay_val], base_arrays[name][base_val]):
            raise BodyOverrideError(f"training overlay changed validation array: {name}")
    direct_rows, direct_indices, direct_binding = _load_direct_labels(
        labels_dir, arrays=arrays
    )
    val33_ids = _load_identity_ids(val33_path, expected=VAL33_ROWS)
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    sample_index = {value: index for index, value in enumerate(sample_ids)}
    if any(value not in sample_index for value in val33_ids):
        raise BodyOverrideError("val33 exclusion identity is absent from dataset")
    val33_indices = np.asarray([sample_index[value] for value in val33_ids], dtype=np.int64)
    if np.any(arrays["split"][val33_indices].astype(np.int64) != 1):
        raise BodyOverrideError("val33 identity escaped validation split")
    selection_mask = overlay_val.copy()
    selection_mask[val33_indices] = False
    selection_indices = np.flatnonzero(selection_mask)
    authorities = arrays["font_authority"].astype(str, copy=False)
    visual_indices = selection_indices[authorities[selection_indices] == "visual"]
    if len(selection_indices) != SELECTION_ROWS or len(visual_indices) != VISUAL_SELECTION_ROWS:
        raise BodyOverrideError("selection/visual cohort cardinality drifted")

    adapter_manifest = _read_json(adapter_dir / trainer.MANIFEST_FILE, "r3h manifest")
    architecture = _mapping(adapter_manifest.get("architecture"), "r3h architecture")
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    try:
        import torch
    except ImportError as error:  # pragma: no cover
        raise BodyOverrideError("PyTorch is required") from error
    model = trainer.build_role_family_adapter(
        torch,
        candidate_count=len(candidate_ids),
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    state, adapter_binding = trainer.load_initial_adapter_state(
        adapter_dir,
        candidate_ids=candidate_ids,
        source_query_head=query_head,
        expected_architecture=architecture,
        expected_state=model.state_dict(),
    )
    if (
        _mapping(adapter_manifest.get("dataset"), "r3h dataset").get("sha256")
        != sha256_file(base_npz)
    ):
        raise BodyOverrideError("r3h is not bound to the sealed r3 base dataset")
    converted = {
        name: torch.from_numpy(np.asarray(value)).to(model.state_dict()[name].dtype)
        for name, value in state.items()
    }
    model.load_state_dict(converted, strict=True)
    return {
        "adapter_binding": dict(adapter_binding),
        "adapter_dir": adapter_dir,
        "adapter_manifest": adapter_manifest,
        "architecture": dict(architecture),
        "arrays": arrays,
        "base_npz": base_npz,
        "candidate_ids": candidate_ids,
        "dataset_dir": dataset_dir,
        "dataset_npz": dataset_npz,
        "direct_binding": direct_binding,
        "direct_indices": direct_indices,
        "direct_rows": direct_rows,
        "inventory": inventory,
        "labels_dir": labels_dir,
        "model": model,
        "query_head": query_head,
        "selection_indices": selection_indices,
        "torch": torch,
        "val33_path": val33_path,
        "visual_indices": visual_indices,
    }


def _infer_pixel_features(
    inputs: Mapping[str, Any], *, device_name: str, batch_size: int
) -> Mapping[str, Any]:
    torch = inputs["torch"]
    device = torch.device(device_name)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise BodyOverrideError("CUDA requested but unavailable")
    model = inputs["model"].to(device).requires_grad_(False).eval()
    arrays = inputs["arrays"]
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32, copy=False)
    ).to(device)
    outputs: dict[str, list[np.ndarray]] = {
        "body_candidate_scores": [],
        "family_logits": [],
        "variant_candidate_scores": [],
    }
    normalized: list[np.ndarray] = []
    per_query: list[np.ndarray] = []
    dispersion: list[np.ndarray] = []
    with torch.inference_mode():
        for start in range(0, len(arrays["sample_ids"]), batch_size):
            query = torch.from_numpy(
                arrays["query_views"][start : start + batch_size].astype(
                    np.float32, copy=False
                )
            ).to(device)
            current = model(query, prototypes)
            sample = torch.nn.functional.normalize(query.mean(dim=1), p=2, dim=-1)
            flattened = sample.reshape(sample.shape[0], -1)
            normalized.append(model.family_norm(flattened).detach().cpu().numpy())
            per_query.append(
                current["per_query_scores"].reshape(sample.shape[0], -1).cpu().numpy()
            )
            normalized_views = torch.nn.functional.normalize(query, p=2, dim=-1)
            similarity = (normalized_views * sample[:, None]).sum(dim=-1)
            dispersion.append(
                torch.cat(
                    (
                        similarity.mean(dim=1),
                        similarity.std(dim=1, unbiased=False),
                    ),
                    dim=1,
                )
                .cpu()
                .numpy()
            )
            for name in outputs:
                outputs[name].append(current[name].detach().float().cpu().numpy())
    result_outputs = {
        name: np.concatenate(parts, axis=0).astype(np.float32, copy=False)
        for name, parts in outputs.items()
    }
    normal = np.concatenate(normalized, axis=0).astype(np.float32, copy=False)
    query_scores = np.concatenate(per_query, axis=0).astype(np.float32, copy=False)
    view_dispersion = np.concatenate(dispersion, axis=0).astype(np.float32, copy=False)
    if any(
        not np.isfinite(value).all()
        for value in (*result_outputs.values(), normal, query_scores, view_dispersion)
    ):
        raise BodyOverrideError("pixel feature inference produced non-finite values")
    projection = fixed_gaussian_projection(
        normal.shape[1], SKETCH_MAX_RANK, seed=RANDOM_SEED
    )
    sketch = normal @ projection
    logits = result_outputs["family_logits"]
    base_features = np.column_stack(
        (
            logits,
            logits[:, trainer.BODY_FAMILY_INDEX]
            - logits[:, trainer.VARIANT_FAMILY_INDEX],
            view_dispersion,
            query_scores.max(axis=1),
            query_scores.mean(axis=1),
        )
    ).astype(np.float32, copy=False)
    return {
        "base_features": base_features,
        "outputs": result_outputs,
        "projection": projection,
        "query_scores": query_scores,
        "sketch": sketch.astype(np.float32, copy=False),
    }


def _candidate_features(pixel: Mapping[str, Any], kind: str) -> np.ndarray:
    base = pixel["base_features"]
    sketch = pixel["sketch"]
    cosine = pixel["query_scores"]
    if kind == "cosine":
        parts = (base, cosine)
    elif kind == "sketch64":
        parts = (base, sketch[:, :64])
    elif kind == "sketch128":
        parts = (base, sketch[:, :128])
    elif kind == "sketch64_cosine":
        parts = (base, sketch[:, :64], cosine)
    else:
        raise BodyOverrideError(f"unsupported feature kind: {kind}")
    result = np.concatenate(parts, axis=1).astype(np.float64, copy=False)
    if not np.isfinite(result).all():
        raise BodyOverrideError("candidate features are non-finite")
    return result


def _fit_classifier(
    features: np.ndarray,
    labels: np.ndarray,
    indices: np.ndarray,
    sample_weight: np.ndarray,
    *,
    regularization_c: float,
) -> Any:
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError as error:  # pragma: no cover
        raise BodyOverrideError("scikit-learn is required") from error
    if len(indices) < 2 or len(np.unique(labels[indices])) != 2:
        raise BodyOverrideError("classifier fold lacks both role families")
    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=regularization_c,
            max_iter=500,
            random_state=RANDOM_SEED,
            solver="liblinear",
        ),
    )
    model.fit(
        features[indices],
        (labels[indices] == trainer.BODY_FAMILY_INDEX).astype(np.int64),
        logisticregression__sample_weight=sample_weight[indices],
    )
    return model


def _override_metrics(
    *,
    direct_override: np.ndarray,
    direct_actual: np.ndarray,
    direct_eligible: np.ndarray,
    direct_work_ids: np.ndarray,
) -> Mapping[str, Any]:
    true_positive = direct_override & (
        direct_actual == trainer.BODY_FAMILY_INDEX
    )
    false_positive = direct_override & (
        direct_actual == trainer.VARIANT_FAMILY_INDEX
    )
    variant_denominator = int(
        (
            direct_eligible
            & (direct_actual == trainer.VARIANT_FAMILY_INDEX)
        ).sum()
    )
    body_error_denominator = int(
        (
            direct_eligible
            & (direct_actual == trainer.BODY_FAMILY_INDEX)
        ).sum()
    )
    per_work: list[dict[str, Any]] = []
    for work_id in sorted(set(direct_work_ids.tolist())):
        mask = (direct_work_ids == work_id) & direct_override
        if not mask.any():
            continue
        work_tp = int((mask & (direct_actual == trainer.BODY_FAMILY_INDEX)).sum())
        work_fp = int((mask & (direct_actual == trainer.VARIANT_FAMILY_INDEX)).sum())
        per_work.append(
            {
                "false_positive": work_fp,
                "override_precision": work_tp / (work_tp + work_fp),
                "override_rows": work_tp + work_fp,
                "true_positive": work_tp,
                "work_id": work_id,
            }
        )
    tp = int(true_positive.sum())
    fp = int(false_positive.sum())
    predicted = tp + fp
    return {
        "body_error_rows": body_error_denominator,
        "body_override_recall": tp / max(1, body_error_denominator),
        "covered_work_count": len(per_work),
        "direct_work_count": len(set(direct_work_ids.tolist())),
        "false_positive": fp,
        "intentional_variant_retention": 1.0 - fp / max(1, variant_denominator),
        "macro_work_override_precision": float(
            np.mean([row["override_precision"] for row in per_work])
        )
        if per_work
        else 0.0,
        "override_precision": tp / max(1, predicted),
        "override_rows": predicted,
        "per_covered_work": per_work,
        "true_positive": tp,
        "variant_rows_preserved": variant_denominator - fp,
        "variant_rows_with_base_variant": variant_denominator,
    }


def _retention(
    override: np.ndarray,
    actual: np.ndarray,
    base_family: np.ndarray,
    indices: np.ndarray,
) -> float:
    eligible_variant = (
        (actual[indices] == trainer.VARIANT_FAMILY_INDEX)
        & (base_family[indices] == trainer.VARIANT_FAMILY_INDEX)
    )
    false_override = override[indices] & eligible_variant
    return 1.0 - int(false_override.sum()) / max(1, int(eligible_variant.sum()))


def _heldout_override_metrics(
    override: np.ndarray,
    actual: np.ndarray,
    indices: np.ndarray,
) -> Mapping[str, Any]:
    """Measure correction precision on a work-disjoint held-out cohort.

    Zero overrides are a neutral abstention, not a precision success.  Any
    applied override must be a base-variant row changed to the actual body
    family; changing an actual variant row is a false positive.
    """

    selected_override = np.asarray(override, dtype=np.bool_)[indices]
    selected_actual = np.asarray(actual, dtype=np.int64)[indices]
    if not np.isin(
        selected_actual, (trainer.BODY_FAMILY_INDEX, trainer.VARIANT_FAMILY_INDEX)
    ).all():
        raise BodyOverrideError("held-out family labels escaped the binary contract")
    true_positive = int(
        (
            selected_override
            & (selected_actual == trainer.BODY_FAMILY_INDEX)
        ).sum()
    )
    false_positive = int(
        (
            selected_override
            & (selected_actual == trainer.VARIANT_FAMILY_INDEX)
        ).sum()
    )
    override_rows = true_positive + false_positive
    if override_rows != int(selected_override.sum()):
        raise BodyOverrideError("held-out override accounting drifted")
    return {
        "false_positive": false_positive,
        "override_precision": (
            true_positive / override_rows if override_rows else None
        ),
        "override_rows": override_rows,
        "precision_gate_state": (
            "measured" if override_rows else "neutral_no_override"
        ),
        "true_positive": true_positive,
    }


def _heldout_precision_passed(metrics: Mapping[str, Any]) -> bool:
    override_rows = int(metrics["override_rows"])
    if override_rows == 0:
        return metrics.get("precision_gate_state") == "neutral_no_override"
    precision = metrics.get("override_precision")
    return (
        metrics.get("precision_gate_state") == "measured"
        and isinstance(precision, (int, float))
        and float(precision) >= MINIMUM_HELDOUT_OVERRIDE_PRECISION
    )


def _font_metrics(
    inputs: Mapping[str, Any],
    outputs: Mapping[str, np.ndarray],
    indices: np.ndarray,
) -> Mapping[str, Any]:
    torch = inputs["torch"]
    arrays = inputs["arrays"]
    selected = torch.from_numpy(indices)
    tensor_outputs = {
        name: torch.from_numpy(value)[selected] for name, value in outputs.items()
    }
    return trainer.compute_metrics(
        torch,
        tensor_outputs,
        family_labels=torch.from_numpy(
            arrays["family_labels"][indices].astype(np.int64, copy=False)
        ),
        positive_mask=torch.from_numpy(
            arrays["positive_mask"][indices].astype(np.bool_, copy=False)
        ),
        preferred_mask=torch.from_numpy(
            arrays["preferred_mask"][indices].astype(np.bool_, copy=False)
        ),
        font_supervision_weights=torch.from_numpy(
            arrays["font_supervision_weights"][indices].astype(np.float32, copy=False)
        ),
        single_day_body_negative=torch.from_numpy(
            arrays["single_day_body_negative"][indices].astype(np.bool_, copy=False)
        ),
        single_day_index=inputs["candidate_ids"].index("single-day"),
        candidate_ids=inputs["candidate_ids"],
    )


def _route_checks(
    baseline_all: Mapping[str, Any],
    baseline_visual: Mapping[str, Any],
    candidate_all: Mapping[str, Any],
    candidate_visual: Mapping[str, Any],
    selection_override: Mapping[str, Any],
    visual_override: Mapping[str, Any],
) -> Mapping[str, bool]:
    return {
        "all_acceptable_non_decreasing": float(candidate_all["acceptable_at1"])
        >= float(baseline_all["acceptable_at1"]),
        "all_family_accuracy_non_decreasing": float(candidate_all["family_accuracy"])
        >= float(baseline_all["family_accuracy"]),
        "all_heldout_override_precision_at_least_0_90_or_neutral": (
            _heldout_precision_passed(selection_override)
        ),
        "all_preferred_non_decreasing": float(candidate_all["preferred_at1"])
        >= float(baseline_all["preferred_at1"]),
        "all_single_day_body_false_zero": int(
            candidate_all["single_day_body_false_top1_count"]
        )
        == 0,
        "all_single_day_no_new_prediction": int(candidate_all["single_day_predicted_count"])
        <= int(baseline_all["single_day_predicted_count"]),
        "visual_acceptable_non_decreasing": float(candidate_visual["acceptable_at1"])
        >= float(baseline_visual["acceptable_at1"]),
        "visual_family_accuracy_non_decreasing": float(
            candidate_visual["family_accuracy"]
        )
        >= float(baseline_visual["family_accuracy"]),
        "visual_heldout_override_precision_at_least_0_90_or_neutral": (
            _heldout_precision_passed(visual_override)
        ),
        "visual_preferred_non_decreasing": float(candidate_visual["preferred_at1"])
        >= float(baseline_visual["preferred_at1"]),
        "visual_single_day_body_false_zero": int(
            candidate_visual["single_day_body_false_top1_count"]
        )
        == 0,
        "visual_single_day_no_new_prediction": int(
            candidate_visual["single_day_predicted_count"]
        )
        <= int(baseline_visual["single_day_predicted_count"]),
    }


def _fit_candidate(
    inputs: Mapping[str, Any],
    pixel: Mapping[str, Any],
    spec: CandidateSpec,
    *,
    baseline_all: Mapping[str, Any],
    baseline_visual: Mapping[str, Any],
) -> Mapping[str, Any]:
    arrays = inputs["arrays"]
    direct_indices = inputs["direct_indices"]
    features = _candidate_features(pixel, spec.feature_kind)
    logits = pixel["outputs"]["family_logits"]
    base_family = logits.argmax(axis=1)
    shifted = logits.astype(np.float64) - logits.max(axis=1, keepdims=True)
    family_probabilities = np.exp(shifted)
    family_probabilities /= family_probabilities.sum(axis=1, keepdims=True)
    variant_probability = family_probabilities[:, trainer.VARIANT_FAMILY_INDEX]
    labels = arrays["family_labels"].astype(np.int64, copy=False)
    split = arrays["split"].astype(np.int64, copy=False)
    authorities = arrays["font_authority"].astype(str, copy=False)
    work_ids = arrays["work_ids"].astype(str, copy=False)
    eligible = base_family == trainer.VARIANT_FAMILY_INDEX
    is_direct = np.zeros(len(labels), dtype=np.bool_)
    is_direct[direct_indices] = True
    allowed_authority = np.isin(authorities, ("human", "visual"))
    sample_weight = np.where(is_direct, 1.0, spec.auxiliary_weight).astype(np.float64)
    direct_work_ids = work_ids[direct_indices]
    oof_percentile = np.full(len(direct_indices), -1.0, dtype=np.float64)
    fold_records: list[dict[str, Any]] = []
    for work_id in sorted(set(direct_work_ids.tolist())):
        test_mask = (direct_work_ids == work_id) & eligible[direct_indices]
        train_mask = (
            (split == 0)
            & eligible
            & allowed_authority
            & (work_ids != work_id)
        )
        train_indices = np.flatnonzero(train_mask)
        model = _fit_classifier(
            features,
            labels,
            train_indices,
            sample_weight,
            regularization_c=spec.regularization_c,
        )
        raw_train = model.decision_function(features[train_indices])
        raw_test = model.decision_function(features[direct_indices[test_mask]])
        oof_percentile[test_mask] = percentile_score(raw_train, raw_test)
        fold_records.append(
            {
                "held_out_direct_rows": int((direct_work_ids == work_id).sum()),
                "held_out_eligible_rows": int(test_mask.sum()),
                "held_out_work_id": work_id,
                "train_direct_rows": int(is_direct[train_indices].sum()),
                "train_rows": len(train_indices),
                "train_work_overlap": 0,
            }
        )
    direct_eligible = eligible[direct_indices]
    if np.any(oof_percentile[direct_eligible] < 0):
        raise BodyOverrideError(f"{spec.candidate_id}: incomplete work-LOGO predictions")

    final_train_mask = (split == 0) & eligible & allowed_authority
    final_train_indices = np.flatnonzero(final_train_mask)
    final_model = _fit_classifier(
        features,
        labels,
        final_train_indices,
        sample_weight,
        regularization_c=spec.regularization_c,
    )
    final_train_raw = final_model.decision_function(features[final_train_indices])
    final_raw = final_model.decision_function(features)
    final_percentile = percentile_score(final_train_raw, final_raw)
    selection_indices = inputs["selection_indices"]
    visual_indices = inputs["visual_indices"]
    direct_actual = labels[direct_indices]
    operating_points: list[Mapping[str, Any]] = []
    for cap in VARIANT_PROBABILITY_CAPS:
        direct_cap = variant_probability[direct_indices] <= cap
        candidate_thresholds = np.unique(
            oof_percentile[direct_eligible & direct_cap]
        )
        for threshold in candidate_thresholds.tolist():
            direct_override = (
                direct_eligible
                & direct_cap
                & (oof_percentile >= threshold)
            )
            override_metrics = _override_metrics(
                direct_override=direct_override,
                direct_actual=direct_actual,
                direct_eligible=direct_eligible,
                direct_work_ids=direct_work_ids,
            )
            if (
                override_metrics["override_rows"] < MINIMUM_OVERRIDE_ROWS
                or override_metrics["covered_work_count"] < MINIMUM_COVERED_WORKS
                or override_metrics["override_precision"] < MINIMUM_OVERRIDE_PRECISION
                or override_metrics["macro_work_override_precision"]
                < MINIMUM_MACRO_WORK_PRECISION
                or override_metrics["intentional_variant_retention"]
                < MINIMUM_DIRECT_VARIANT_RETENTION
            ):
                continue
            candidate_logits, override_mask = apply_variant_to_body_override(
                logits,
                final_percentile,
                threshold=threshold,
                maximum_variant_probability=cap,
            )
            selection_retention = _retention(
                override_mask, labels, base_family, selection_indices
            )
            visual_retention = _retention(
                override_mask, labels, base_family, visual_indices
            )
            if (
                selection_retention < MINIMUM_SELECTION_VARIANT_RETENTION
                or visual_retention < MINIMUM_VISUAL_VARIANT_RETENTION
            ):
                continue
            candidate_outputs = {
                **pixel["outputs"],
                "family_logits": candidate_logits,
            }
            candidate_all = _font_metrics(
                inputs, candidate_outputs, selection_indices
            )
            candidate_visual = _font_metrics(
                inputs, candidate_outputs, visual_indices
            )
            selection_override_metrics = _heldout_override_metrics(
                override_mask, labels, selection_indices
            )
            visual_override_metrics = _heldout_override_metrics(
                override_mask, labels, visual_indices
            )
            route_checks = _route_checks(
                baseline_all,
                baseline_visual,
                candidate_all,
                candidate_visual,
                selection_override_metrics,
                visual_override_metrics,
            )
            if not all(route_checks.values()):
                continue
            operating_points.append(
                {
                    "candidate_all": candidate_all,
                    "candidate_visual": candidate_visual,
                    "maximum_base_variant_probability": cap,
                    "override_metrics": override_metrics,
                    "route_checks": route_checks,
                    "selection_override_rows": int(override_mask[selection_indices].sum()),
                    "selection_override_metrics": selection_override_metrics,
                    "selection_variant_retention": selection_retention,
                    "threshold": float(threshold),
                    "visual_override_rows": int(override_mask[visual_indices].sum()),
                    "visual_override_metrics": visual_override_metrics,
                    "visual_variant_retention": visual_retention,
                }
            )
    if not operating_points:
        return {
            "candidate_id": spec.candidate_id,
            "configuration": {
                "auxiliary_weight": spec.auxiliary_weight,
                "feature_kind": spec.feature_kind,
                "regularization_c": spec.regularization_c,
            },
            "folds": fold_records,
            "gate_passed": False,
            "rejection_reason": "no_operating_point_passed_all_precision_retention_route_gates",
        }
    # Within a fixed model, maximize useful corrections after every hard gate.
    selected = max(
        operating_points,
        key=lambda row: (
            int(row["override_metrics"]["true_positive"]),
            int(row["override_metrics"]["covered_work_count"]),
            float(row["override_metrics"]["override_precision"]),
            float(row["override_metrics"]["macro_work_override_precision"]),
            float(row["selection_variant_retention"]),
            float(row["visual_variant_retention"]),
            -int(row["selection_override_rows"]),
            float(row["threshold"]),
        ),
    )
    scaler = final_model.named_steps["standardscaler"]
    classifier = final_model.named_steps["logisticregression"]
    checkpoint = {
        "calibration_decision_scores_sorted": np.ascontiguousarray(
            np.sort(final_train_raw).astype("<f4")
        ),
        "classifier_intercept": np.ascontiguousarray(
            classifier.intercept_.astype("<f4")
        ),
        "classifier_weight": np.ascontiguousarray(classifier.coef_.astype("<f4")),
        "feature_mean": np.ascontiguousarray(scaler.mean_.astype("<f4")),
        "feature_scale": np.ascontiguousarray(scaler.scale_.astype("<f4")),
        "maximum_base_variant_probability": np.asarray(
            [selected["maximum_base_variant_probability"]], dtype="<f4"
        ),
        "operating_percentile_threshold": np.asarray(
            [selected["threshold"]], dtype="<f4"
        ),
    }
    return {
        "candidate_id": spec.candidate_id,
        "checkpoint": checkpoint,
        "configuration": {
            "auxiliary_weight": spec.auxiliary_weight,
            "feature_kind": spec.feature_kind,
            "regularization_c": spec.regularization_c,
        },
        "final_fit": {
            "auxiliary_rows": int((~is_direct[final_train_indices]).sum()),
            "direct_rows": int(is_direct[final_train_indices].sum()),
            "feature_dim": features.shape[1],
            "fit_rows": len(final_train_indices),
        },
        "folds": fold_records,
        "gate_passed": True,
        "operating_point": selected,
        "percentile_reference": np.sort(final_train_raw).astype(np.float64),
    }


def choose_precision_first_candidate(
    records: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    """Choose precision before coverage; stable candidate order is final tie-break."""

    passed = [record for record in records if record.get("gate_passed") is True]
    if not passed:
        return None
    order = {spec.candidate_id: index for index, spec in enumerate(CANDIDATES)}
    return max(
        passed,
        key=lambda row: (
            float(row["operating_point"]["override_metrics"]["override_precision"]),
            float(
                row["operating_point"]["override_metrics"][
                    "macro_work_override_precision"
                ]
            ),
            float(
                row["operating_point"]["override_metrics"][
                    "intentional_variant_retention"
                ]
            ),
            int(row["operating_point"]["override_metrics"]["covered_work_count"]),
            int(row["operating_point"]["override_metrics"]["true_positive"]),
            float(row["operating_point"]["selection_variant_retention"]),
            float(row["operating_point"]["visual_variant_retention"]),
            -order[str(row["candidate_id"])],
        ),
    )


def _publish(
    output_dir: Path,
    *,
    core: Mapping[str, Any],
    checkpoint: Mapping[str, np.ndarray] | None,
) -> Mapping[str, Any]:
    try:
        from safetensors.numpy import save_file
    except ImportError as error:  # pragma: no cover
        raise BodyOverrideError("safetensors is required") from error
    output = _safe_output(output_dir)
    if output.exists() or output.is_symlink():
        raise BodyOverrideError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        files: dict[str, Any] = {}
        if checkpoint is not None:
            checkpoint_path = staging / CHECKPOINT_FILE
            save_file(
                {
                    name: np.ascontiguousarray(value)
                    for name, value in sorted(checkpoint.items())
                },
                str(checkpoint_path),
            )
            files[CHECKPOINT_FILE] = _descriptor(checkpoint_path)
        manifest = seal_record(
            {
                **dict(core),
                "files": files,
                "record_type": "manga_font_r3h_body_override_manifest",
                "schema_version": SCHEMA_VERSION,
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "decision": copy.deepcopy(manifest["decision"]),
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_r3h_body_override_report",
                "schema_version": SCHEMA_VERSION,
                "selected_metrics": copy.deepcopy(manifest.get("selected_metrics")),
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(json_bytes(report, pretty=True))
        artifacts = {
            MANIFEST_FILE: sha256_file(manifest_path),
            REPORT_FILE: sha256_file(report_path),
        }
        if checkpoint is not None:
            artifacts[CHECKPOINT_FILE] = sha256_file(staging / CHECKPOINT_FILE)
        marker = seal_record(
            {
                "artifacts": artifacts,
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging, require_current_source=True)
        os.replace(staging, output)
        published = True
        return validate_output(output, require_current_source=True)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def build(args: argparse.Namespace) -> Mapping[str, Any]:
    if args.batch_size < 1:
        raise BodyOverrideError("batch size must be positive")
    started = time.perf_counter()
    inputs = _load_inputs(args)
    pixel = _infer_pixel_features(
        inputs, device_name=args.device, batch_size=args.batch_size
    )
    baseline_all = _font_metrics(
        inputs, pixel["outputs"], inputs["selection_indices"]
    )
    baseline_visual = _font_metrics(
        inputs, pixel["outputs"], inputs["visual_indices"]
    )
    records = [
        _fit_candidate(
            inputs,
            pixel,
            spec,
            baseline_all=baseline_all,
            baseline_visual=baseline_visual,
        )
        for spec in CANDIDATES
    ]
    selected = choose_precision_first_candidate(records)
    success = selected is not None
    checkpoint: dict[str, np.ndarray] | None = None
    selected_metrics: Mapping[str, Any] | None = None
    if selected is not None:
        checkpoint = dict(selected["checkpoint"])
        if selected["configuration"]["feature_kind"] in {
            "sketch64",
            "sketch128",
            "sketch64_cosine",
        }:
            rank = 128 if selected["configuration"]["feature_kind"] == "sketch128" else 64
            checkpoint["fixed_projection"] = np.ascontiguousarray(
                pixel["projection"][:, :rank], dtype="<f4"
            )
        selected_metrics = {
            "candidate_id": selected["candidate_id"],
            "configuration": selected["configuration"],
            "final_fit": selected["final_fit"],
            "operating_point": selected["operating_point"],
        }
    public_records: list[dict[str, Any]] = []
    for record in records:
        public = {key: value for key, value in record.items() if key not in {"checkpoint", "percentile_reference"}}
        public_records.append(copy.deepcopy(public))
    core = {
        "architecture": {
            "base_model": "frozen_r3h",
            "base_variant_probability_guard": True,
            "body_to_variant_path": False,
            "decision_calibration": "train_empirical_cdf_percentile",
            "feature_source": "frozen_r3h_pixel_query_and_prototype_cosine_only",
            "forbidden_model_inputs": [
                "font_name",
                "gemma_item_role",
                "genre",
                "page_id",
                "text",
                "translation",
                "work_id",
            ],
            "head": "standardized_l2_logistic_variant_to_body_with_abstention",
            "random_seed": RANDOM_SEED,
            "variant_to_body_only": True,
        },
        "authority": {
            "automatic_release_authority": False,
            "calibration_authority": False,
            "evaluation_authority": False,
            "experiment_only": True,
            "exporter_candidate": success,
            "fresh_qa_selection_rows": 0,
            "holdout_selection_rows": 0,
            "runtime_packaging_allowed": False,
            "training_label_authority": False,
        },
        "candidate_history": public_records,
        "decision": {
            "action": "seal_adapter" if success else "fail_closed_rejection",
            "gate_passed": success,
            "selected_candidate_id": selected["candidate_id"] if selected else None,
        },
        "gates": {
            "minimum_covered_works": MINIMUM_COVERED_WORKS,
            "minimum_direct_intentional_variant_retention": MINIMUM_DIRECT_VARIANT_RETENTION,
            "minimum_macro_work_override_precision": MINIMUM_MACRO_WORK_PRECISION,
            "minimum_override_precision": MINIMUM_OVERRIDE_PRECISION,
            "minimum_override_rows": MINIMUM_OVERRIDE_ROWS,
            "minimum_work_disjoint_heldout_override_precision_or_neutral": (
                MINIMUM_HELDOUT_OVERRIDE_PRECISION
            ),
            "require_all_family_accuracy_non_decreasing": True,
            "minimum_selection_intentional_variant_retention": MINIMUM_SELECTION_VARIANT_RETENTION,
            "require_visual_family_accuracy_non_decreasing": True,
            "minimum_visual_intentional_variant_retention": MINIMUM_VISUAL_VARIANT_RETENTION,
            "single_day_body_false_required": 0,
            "variant_probability_caps": list(VARIANT_PROBABILITY_CAPS),
        },
        "lineage": {
            "base_adapter": {
                **inputs["adapter_binding"],
                "checkpoint_sha256": sha256_file(
                    inputs["adapter_dir"] / trainer.CHECKPOINT_FILE
                ),
            },
            "base_dataset": _descriptor(inputs["base_npz"]),
            "direct_training_labels": inputs["direct_binding"],
            "overlay_dataset": _descriptor(
                inputs["dataset_npz"], row_count=inputs["inventory"]["row_count"]
            ),
            "source_query_head": _descriptor(inputs["query_head"]),
            "source_script": {
                "file": str(Path(__file__).resolve()),
                "sha256": sha256_file(Path(__file__).resolve()),
            },
            "val33_identity_exclusion": {
                **_descriptor(inputs["val33_path"], row_count=VAL33_ROWS),
                "fields_used": ["sample_id"],
                "label_fields_used": False,
                "selection_used": False,
            },
        },
        "selection_boundary": {
            "direct_training_only_rows": DIRECT_ROWS,
            "direct_work_logo_folds": DIRECT_WORKS,
            "fresh_qa_rows": 0,
            "holdout_rows": 0,
            "non_val33_rows": SELECTION_ROWS,
            "selection_inputs": [
                "work_logo_direct_training_only_role_labels",
                "r3_validation_excluding_val33_identity",
                "r3_visual_validation_subset",
            ],
            "val33_label_rows": 0,
            "visual_rows": VISUAL_SELECTION_ROWS,
        },
        "selected_metrics": selected_metrics,
        "training_seconds": time.perf_counter() - started,
    }
    return _publish(args.output_dir, core=core, checkpoint=checkpoint)


def validate_output(
    output_dir: Path, *, require_current_source: bool = False
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise BodyOverrideError("output directory is unavailable")
    inventory = {path.name for path in root.iterdir()}
    required = {MANIFEST_FILE, REPORT_FILE, MARKER_FILE}
    if not required.issubset(inventory) or inventory - {*required, CHECKPOINT_FILE}:
        raise BodyOverrideError("output exact inventory drifted")
    manifest = _read_json(root / MANIFEST_FILE, "manifest")
    report = _read_json(root / REPORT_FILE, "report")
    marker = _read_json(root / MARKER_FILE, "marker")
    for location, record in (("manifest", manifest), ("report", report), ("marker", marker)):
        validate_record_seal(record, location)
    decision = _mapping(manifest.get("decision"), "manifest decision")
    authority = _mapping(manifest.get("authority"), "manifest authority")
    boundary = _mapping(manifest.get("selection_boundary"), "selection boundary")
    source = _mapping(
        _mapping(manifest.get("lineage"), "lineage").get("source_script"),
        "source script",
    )
    success = decision.get("gate_passed") is True
    expected_inventory = {*required, CHECKPOINT_FILE} if success else required
    if (
        inventory != expected_inventory
        or manifest.get("schema_version") != SCHEMA_VERSION
        or report.get("schema_version") != SCHEMA_VERSION
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or authority.get("automatic_release_authority") is not False
        or authority.get("runtime_packaging_allowed") is not False
        or authority.get("fresh_qa_selection_rows") != 0
        or authority.get("holdout_selection_rows") != 0
        or boundary.get("direct_training_only_rows") != DIRECT_ROWS
        or boundary.get("direct_work_logo_folds") != DIRECT_WORKS
        or boundary.get("non_val33_rows") != SELECTION_ROWS
        or boundary.get("visual_rows") != VISUAL_SELECTION_ROWS
        or boundary.get("val33_label_rows") != 0
        or boundary.get("fresh_qa_rows") != 0
        or boundary.get("holdout_rows") != 0
        or (require_current_source and source.get("sha256") != sha256_file(Path(__file__).resolve()))
    ):
        raise BodyOverrideError("published authority/boundary metadata drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    expected_artifacts = inventory - {MARKER_FILE}
    if set(marker_artifacts) != expected_artifacts or any(
        marker_artifacts.get(name) != sha256_file(root / name)
        for name in expected_artifacts
    ):
        raise BodyOverrideError("marker artifact binding drifted")
    if success:
        selected = _mapping(manifest.get("selected_metrics"), "selected metrics")
        operating = _mapping(selected.get("operating_point"), "selected operating point")
        role = _mapping(operating.get("override_metrics"), "selected override metrics")
        route = _mapping(operating.get("route_checks"), "selected route checks")
        if (
            decision.get("action") != "seal_adapter"
            or decision.get("selected_candidate_id") != selected.get("candidate_id")
            or float(role.get("override_precision", -1)) < MINIMUM_OVERRIDE_PRECISION
            or float(role.get("macro_work_override_precision", -1))
            < MINIMUM_MACRO_WORK_PRECISION
            or float(role.get("intentional_variant_retention", -1))
            < MINIMUM_DIRECT_VARIANT_RETENTION
            or int(role.get("covered_work_count", -1)) < MINIMUM_COVERED_WORKS
            or float(operating.get("selection_variant_retention", -1))
            < MINIMUM_SELECTION_VARIANT_RETENTION
            or float(operating.get("visual_variant_retention", -1))
            < MINIMUM_VISUAL_VARIANT_RETENTION
            or not route
            or not all(value is True for value in route.values())
        ):
            raise BodyOverrideError("selected candidate no longer passes gates")
        try:
            from safetensors.numpy import load_file
        except ImportError as error:  # pragma: no cover
            raise BodyOverrideError("safetensors is required") from error
        tensors = load_file(str(root / CHECKPOINT_FILE))
        required_tensors = {
            "calibration_decision_scores_sorted",
            "classifier_intercept",
            "classifier_weight",
            "feature_mean",
            "feature_scale",
            "maximum_base_variant_probability",
            "operating_percentile_threshold",
        }
        feature_kind = selected.get("configuration", {}).get("feature_kind")
        if feature_kind in {"sketch64", "sketch128", "sketch64_cosine"}:
            required_tensors.add("fixed_projection")
        if set(tensors) != required_tensors or any(
            not np.isfinite(value).all() for value in tensors.values()
        ):
            raise BodyOverrideError("checkpoint tensor contract drifted")
    elif decision.get("action") != "fail_closed_rejection" or manifest.get("selected_metrics") is not None:
        raise BodyOverrideError("rejection artifact is not fail-closed")
    return {
        "checkpoint_sha256": sha256_file(root / CHECKPOINT_FILE) if success else None,
        "manifest_record_sha256": manifest["record_sha256"],
        "output_dir": str(root),
        "selected_candidate_id": decision.get("selected_candidate_id"),
        "status": "validated_body_override_adapter" if success else "validated_fail_closed_rejection",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_command = commands.add_parser("build")
    build_command.add_argument("--dataset-dir", type=Path, required=True)
    build_command.add_argument("--base-dataset-npz", type=Path, required=True)
    build_command.add_argument("--labels-dir", type=Path, required=True)
    build_command.add_argument("--val33-jsonl", type=Path, required=True)
    build_command.add_argument("--base-adapter-dir", type=Path, required=True)
    build_command.add_argument("--source-query-head", type=Path, required=True)
    build_command.add_argument("--output-dir", type=Path, required=True)
    build_command.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    build_command.add_argument("--batch-size", type=int, default=512)
    validate_command = commands.add_parser("validate")
    validate_command.add_argument("--output-dir", type=Path, required=True)
    validate_command.add_argument("--require-current-source", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build(args)
        else:
            result = validate_output(
                args.output_dir,
                require_current_source=args.require_current_source,
            )
    except (
        BodyOverrideError,
        base_dataset.V8RoleFamilyDatasetError,
        labels_v6.base.HighValueSupervisedLabelError,
        overlay.HighValueDatasetOverlayError,
        trainer.MangaFontV8RoleFamilyError,
        OSError,
        ValueError,
    ) as error:
        raise SystemExit(f"r3h body-override error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
