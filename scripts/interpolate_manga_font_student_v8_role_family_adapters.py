#!/usr/bin/env python3
"""Select and seal a weight interpolation of two compatible v8 adapters.

The alpha sweep is selected only on the work-disjoint r3 validation arrays:
all 9,033 rows, the 1,047 visually supervised rows, and the production
Single-Day safety gates.  The adjudicated val33 and the new train-only 181
labels are deliberately loaded only after alpha selection and are diagnostics,
never selection authority.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import augment_manga_font_student_v8_with_high_value_labels as overlay
    from scripts import build_manga_font_student_v8_role_family_dataset as base_dataset
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import augment_manga_font_student_v8_with_high_value_labels as overlay
    import build_manga_font_student_v8_role_family_dataset as base_dataset
    import train_manga_font_student_v8_role_family_adapter as trainer


DEFAULT_BASE_ADAPTER = Path(
    "artifacts/manga-font-student-v81-role-family-adapter-production-r3h"
)
DEFAULT_TARGET_ADAPTER = Path(
    "artifacts/manga-font-student-v81-role-family-adapter-production-r4h-high-value-181"
)
DEFAULT_BASE_DATASET = Path(
    "artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout/"
    "role-family-dataset.npz"
)
DEFAULT_DATASET = Path(
    "artifacts/manga-font-student-v8-role-family-dataset-r4-high-value-181-"
    "authority-v3/role-family-dataset.npz"
)
DEFAULT_SOURCE_HEAD = Path(
    "artifacts/manga-font-student-v7-mass21-r5-epoch1-qa-v1/"
    "best-fontquery-head.safetensors"
)
DEFAULT_VAL33 = Path(
    "artifacts/manga-font-student-human-overlay-adjudicated-val33-v1/"
    "val-samples-adjudicated.jsonl"
)
DEFAULT_NEW181 = Path(
    "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-200-"
    "training-only-authority-v2/training-labels.jsonl"
)
DEFAULT_OUTPUT = Path(
    "artifacts/manga-font-student-v81-role-family-adapter-interpolated-"
    "r3h-r4h-alpha-grid-v1"
)
DEFAULT_ALPHA_GRID = ",".join(f"{value / 100:.2f}" for value in range(0, 51, 5))

SELECTION_METRIC_NAME = "mean_all_visual_acceptable_preferred_at1"
SELECTION_METRIC_FORMULA = (
    "mean(all.acceptable_at1,all.preferred_at1,"
    "visual.acceptable_at1,visual.preferred_at1)"
)
SELECTION_ROUTING_AUTHORITY = "predicted_pixel_family_with_single_day_eligibility"
ROW_ARRAYS = frozenset(
    {
        "candidate_eligible_mask",
        "family_label_weights",
        "family_labels",
        "font_authority",
        "font_supervision_weights",
        "positive_mask",
        "preferred_mask",
        "query_views",
        "sample_ids",
        "single_day_body_negative",
        "split",
        "work_ids",
    }
)


class MangaFontAdapterInterpolationError(ValueError):
    """Raised when interpolation would cross a sealed authority boundary."""


def _read_json(path: Path, location: str) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise MangaFontAdapterInterpolationError(f"{location}: missing regular file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MangaFontAdapterInterpolationError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise MangaFontAdapterInterpolationError(f"{location}: expected object")
    return dict(value)


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise MangaFontAdapterInterpolationError(f"{location}: missing regular file")
    with resolved.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise MangaFontAdapterInterpolationError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            if not isinstance(value, Mapping):
                raise MangaFontAdapterInterpolationError(
                    f"{location}:{line_number}: expected object"
                )
            yield dict(value)


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontAdapterInterpolationError(f"unsafe output directory: {result}")
    return result


def _array_digest(value: np.ndarray) -> str:
    contiguous = np.ascontiguousarray(value)
    digest = hashlib.sha256()
    digest.update(str(contiguous.dtype).encode("utf-8"))
    digest.update(b"\0")
    digest.update(json.dumps(list(contiguous.shape), separators=(",", ":")).encode("ascii"))
    digest.update(b"\0")
    digest.update(contiguous.tobytes(order="C"))
    return digest.hexdigest()


def _array_bundle_digest(arrays: Mapping[str, np.ndarray]) -> str:
    digest = hashlib.sha256()
    for name in sorted(arrays):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(_array_digest(arrays[name]).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def parse_alpha_grid(value: str) -> tuple[float, ...]:
    try:
        alphas = tuple(float(part.strip()) for part in value.split(",") if part.strip())
    except ValueError as error:
        raise MangaFontAdapterInterpolationError("alpha grid contains non-numeric values") from error
    if (
        not alphas
        or any(not math.isfinite(alpha) or alpha < 0.0 or alpha > 1.0 for alpha in alphas)
        or tuple(sorted(set(alphas))) != alphas
    ):
        raise MangaFontAdapterInterpolationError(
            "alpha grid must be unique, ascending, finite, and inside [0,1]"
        )
    return alphas


def interpolate_states(
    base_state: Mapping[str, np.ndarray],
    target_state: Mapping[str, np.ndarray],
    alpha: float,
) -> dict[str, np.ndarray]:
    if not math.isfinite(alpha) or alpha < 0.0 or alpha > 1.0:
        raise MangaFontAdapterInterpolationError("alpha must be finite and inside [0,1]")
    if set(base_state) != set(target_state):
        raise MangaFontAdapterInterpolationError("parent checkpoint state keys drifted")
    result: dict[str, np.ndarray] = {}
    for name in sorted(base_state):
        base = np.asarray(base_state[name])
        target = np.asarray(target_state[name])
        if base.shape != target.shape or base.dtype != target.dtype:
            raise MangaFontAdapterInterpolationError(
                f"parent checkpoint tensor contract drifted: {name}"
            )
        if not np.issubdtype(base.dtype, np.floating):
            raise MangaFontAdapterInterpolationError(
                f"checkpoint tensor is not floating point: {name}"
            )
        if not np.isfinite(base).all() or not np.isfinite(target).all():
            raise MangaFontAdapterInterpolationError(
                f"parent checkpoint tensor is non-finite: {name}"
            )
        value = (
            base.astype(np.float64) * (1.0 - alpha)
            + target.astype(np.float64) * alpha
        ).astype(base.dtype)
        if not np.isfinite(value).all():
            raise MangaFontAdapterInterpolationError(
                f"interpolated checkpoint tensor is non-finite: {name}"
            )
        result[name] = np.ascontiguousarray(value)
    return result


def selection_score(
    all_metrics: Mapping[str, Any], visual_metrics: Mapping[str, Any]
) -> float:
    values = (
        float(all_metrics["acceptable_at1"]),
        float(all_metrics["preferred_at1"]),
        float(visual_metrics["acceptable_at1"]),
        float(visual_metrics["preferred_at1"]),
    )
    if any(not math.isfinite(value) for value in values):
        raise MangaFontAdapterInterpolationError("selection metric is non-finite")
    return float(sum(values) / len(values))


def choose_alpha(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    safe = [row for row in rows if row.get("quality_gate_passed") is True]
    if not safe:
        raise MangaFontAdapterInterpolationError(
            "no alpha passed the all/visual/Single-Day selection quality gate"
        )
    return max(
        safe,
        key=lambda row: (
            float(row["selection_score"]),
            float(row["all_metrics"]["acceptable_at1"]),
            float(row["visual_metrics"]["acceptable_at1"]),
            -float(row["alpha"]),
        ),
    )


def _load_sample_ids(path: Path, *, expected_rows: int, location: str) -> tuple[str, ...]:
    values: list[str] = []
    for row in _iter_jsonl(path, location):
        sample_id = row.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id:
            raise MangaFontAdapterInterpolationError(f"{location}: sample ID is absent")
        values.append(sample_id)
    if len(values) != expected_rows or len(set(values)) != len(values):
        raise MangaFontAdapterInterpolationError(
            f"{location}: expected exactly {expected_rows} unique sample IDs"
        )
    return tuple(values)


def _indices_for_ids(
    arrays: Mapping[str, np.ndarray],
    sample_ids: Sequence[str],
    *,
    expected_split: int,
    location: str,
) -> np.ndarray:
    dataset_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    index = {value: position for position, value in enumerate(dataset_ids)}
    if len(index) != len(dataset_ids) or any(value not in index for value in sample_ids):
        raise MangaFontAdapterInterpolationError(f"{location}: sample identity drifted")
    result = np.asarray([index[value] for value in sample_ids], dtype=np.int64)
    split = arrays["split"].astype(np.int64, copy=False)
    if not bool((split[result] == expected_split).all()):
        raise MangaFontAdapterInterpolationError(f"{location}: split boundary drifted")
    if not bool((arrays["font_supervision_weights"][result] > 0).all()):
        raise MangaFontAdapterInterpolationError(f"{location}: unsupervised row leaked in")
    return result


def _validate_parent_dataset_descriptor(
    manifest: Mapping[str, Any], location: str
) -> Mapping[str, Any]:
    descriptor = manifest.get("dataset")
    if not isinstance(descriptor, Mapping):
        raise MangaFontAdapterInterpolationError(f"{location}: dataset binding absent")
    path_value = descriptor.get("file")
    if not isinstance(path_value, str) or not path_value:
        raise MangaFontAdapterInterpolationError(f"{location}: dataset file absent")
    path = Path(path_value).expanduser().resolve()
    if path.is_symlink() or not path.is_file():
        raise MangaFontAdapterInterpolationError(f"{location}: bound dataset unavailable")
    if (
        descriptor.get("sha256") != trainer.sha256_file(path)
        or descriptor.get("row_count") != 23882
    ):
        raise MangaFontAdapterInterpolationError(f"{location}: dataset descriptor drifted")
    return {"file": str(path), "sha256": descriptor["sha256"]}


def _build_expected_model(
    torch: Any, architecture: Mapping[str, Any], candidate_count: int
) -> Any:
    return trainer.build_role_family_adapter(
        torch,
        candidate_count=candidate_count,
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )


def _load_parents(
    *, base_adapter_dir: Path, target_adapter_dir: Path, source_query_head: Path
) -> tuple[
    tuple[str, ...],
    Mapping[str, Any],
    Mapping[str, np.ndarray],
    Mapping[str, np.ndarray],
    Mapping[str, Any],
    Mapping[str, Any],
    Mapping[str, Any],
]:
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontAdapterInterpolationError("PyTorch is required") from error
    base_root = base_adapter_dir.expanduser().resolve()
    target_root = target_adapter_dir.expanduser().resolve()
    base_manifest = _read_json(base_root / trainer.MANIFEST_FILE, "base adapter manifest")
    target_manifest = _read_json(
        target_root / trainer.MANIFEST_FILE, "target adapter manifest"
    )
    candidate_ids = tuple(str(value) for value in base_manifest.get("candidate_ids", ()))
    architecture = base_manifest.get("architecture")
    if (
        len(candidate_ids) != 21
        or not isinstance(architecture, Mapping)
        or tuple(str(value) for value in target_manifest.get("candidate_ids", ()))
        != candidate_ids
        or target_manifest.get("architecture") != architecture
        or target_manifest.get("source_query_head") != base_manifest.get("source_query_head")
    ):
        raise MangaFontAdapterInterpolationError(
            "parent candidate order/source head/architecture drifted"
        )
    source = base_manifest.get("source_query_head")
    source_path = source_query_head.expanduser().resolve()
    if (
        not isinstance(source, Mapping)
        or source.get("sha256") != trainer.sha256_file(source_path)
    ):
        raise MangaFontAdapterInterpolationError("source query-head binding drifted")
    expected_model = _build_expected_model(torch, architecture, len(candidate_ids))
    expected_state = {
        name: value.detach().cpu().numpy()
        for name, value in expected_model.state_dict().items()
    }
    base_state, _base_initialization = trainer.load_initial_adapter_state(
        base_root,
        candidate_ids=candidate_ids,
        source_query_head=source_path,
        expected_architecture=architecture,
        expected_state=expected_state,
    )
    target_state, _target_initialization = trainer.load_initial_adapter_state(
        target_root,
        candidate_ids=candidate_ids,
        source_query_head=source_path,
        expected_architecture=architecture,
        expected_state=expected_state,
    )
    base_dataset_binding = _validate_parent_dataset_descriptor(
        base_manifest, "base adapter"
    )
    target_dataset_binding = _validate_parent_dataset_descriptor(
        target_manifest, "target adapter"
    )
    return (
        candidate_ids,
        architecture,
        base_state,
        target_state,
        base_manifest,
        target_manifest,
        {
            "base": base_dataset_binding,
            "target": target_dataset_binding,
            "expected_state": expected_state,
        },
    )


def _validate_datasets(
    *,
    base_dataset_npz: Path,
    dataset_npz: Path,
    candidate_ids: Sequence[str],
    parent_dataset_bindings: Mapping[str, Any],
) -> tuple[Path, dict[str, np.ndarray], Mapping[str, Any], Mapping[str, Any]]:
    base_path = base_dataset_npz.expanduser().resolve()
    current_path = dataset_npz.expanduser().resolve()
    try:
        # Two later-stage adapters may share the same sealed high-value overlay
        # dataset.  In that case the base is the overlay itself rather than the
        # earlier role/family dataset; validation arrays remain byte-identical.
        base_validation = (
            overlay.validate_output(base_path.parent)
            if base_path == current_path
            else base_dataset.validate_output(base_path.parent)
        )
        overlay_validation = overlay.validate_output(current_path.parent)
        _base_loaded, base_arrays, base_inventory = trainer._load_training_npz(base_path)  # noqa: SLF001
        _current_loaded, arrays, inventory = trainer._load_training_npz(current_path)  # noqa: SLF001
    except Exception as error:  # noqa: BLE001
        raise MangaFontAdapterInterpolationError(
            f"sealed dataset validation failed: {error}"
        ) from error
    if (
        tuple(base_inventory["candidate_ids"]) != tuple(candidate_ids)
        or tuple(inventory["candidate_ids"]) != tuple(candidate_ids)
        or parent_dataset_bindings["base"]["sha256"] != trainer.sha256_file(base_path)
        or parent_dataset_bindings["target"]["sha256"] != trainer.sha256_file(current_path)
        or base_validation.get("val_rows") != 9033
        or overlay_validation.get("val_rows") != 9033
    ):
        raise MangaFontAdapterInterpolationError("parent/dataset binding drifted")
    current_manifest = _read_json(current_path.parent / overlay.MANIFEST_FILE, "overlay manifest")
    authority = current_manifest.get("authority")
    if (
        not isinstance(authority, Mapping)
        or authority.get("training_eligible") is not True
        or authority.get("training_only") is not True
        or authority.get("human_gold") is not False
        or authority.get("review_authority")
        != "codex_agent_direct_visual_supervision"
        or authority.get("evaluation_authority") is not False
    ):
        raise MangaFontAdapterInterpolationError("overlay training authority drifted")
    if set(base_arrays) != set(arrays) or set(arrays) != {
        *ROW_ARRAYS,
        "candidate_ids",
        "prototype_queries",
    }:
        raise MangaFontAdapterInterpolationError("dataset array inventory drifted")
    if not np.array_equal(base_arrays["candidate_ids"], arrays["candidate_ids"]):
        raise MangaFontAdapterInterpolationError("dataset candidate order drifted")
    if not np.array_equal(base_arrays["prototype_queries"], arrays["prototype_queries"]):
        raise MangaFontAdapterInterpolationError("candidate prototype arrays drifted")
    if not np.array_equal(base_arrays["split"], arrays["split"]):
        raise MangaFontAdapterInterpolationError("dataset split rows drifted")
    val = arrays["split"].astype(np.int64, copy=False) == 1
    base_val = base_arrays["split"].astype(np.int64, copy=False) == 1
    if not np.array_equal(val, base_val):
        raise MangaFontAdapterInterpolationError("validation membership drifted")
    validation_arrays: dict[str, np.ndarray] = {}
    for name in sorted(ROW_ARRAYS):
        left = base_arrays[name][base_val]
        right = arrays[name][val]
        if not np.array_equal(left, right):
            raise MangaFontAdapterInterpolationError(
                f"r3/overlay validation arrays differ: {name}"
            )
        validation_arrays[name] = right
    validation_digest = _array_bundle_digest(validation_arrays)
    return current_path, arrays, inventory, {
        "base_dataset_npz_sha256": trainer.sha256_file(base_path),
        "overlay_dataset_npz_sha256": trainer.sha256_file(current_path),
        "validation_array_bundle_sha256": validation_digest,
        "validation_arrays_byte_identical": True,
        "validation_row_count": int(val.sum()),
    }


def _load_state_into_model(torch: Any, model: Any, state: Mapping[str, np.ndarray]) -> None:
    converted = {name: torch.from_numpy(np.asarray(value)) for name, value in state.items()}
    incompatible = model.load_state_dict(converted, strict=True)
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise MangaFontAdapterInterpolationError("checkpoint reconstruction drifted")
    model.requires_grad_(False)
    model.eval()


def _infer(
    *,
    torch: Any,
    model: Any,
    query_views: np.ndarray,
    prototype_queries: np.ndarray,
    device: Any,
    batch_size: int,
) -> Mapping[str, Any]:
    prototypes = torch.from_numpy(prototype_queries.astype(np.float32, copy=False)).to(device)
    outputs: dict[str, list[Any]] = {
        "body_candidate_scores": [],
        "variant_candidate_scores": [],
        "family_logits": [],
    }
    with torch.inference_mode():
        for start in range(0, len(query_views), batch_size):
            batch = torch.from_numpy(
                query_views[start : start + batch_size].astype(np.float32, copy=False)
            ).to(device)
            values = model(batch, prototypes)
            for name in outputs:
                outputs[name].append(values[name].detach().cpu())
    return {name: torch.cat(parts, dim=0) for name, parts in outputs.items()}


def _metrics(
    *,
    torch: Any,
    outputs: Mapping[str, Any],
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    single_day_index = tuple(candidate_ids).index("single-day")
    return trainer.compute_metrics(
        torch,
        outputs,
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
        single_day_index=single_day_index,
        candidate_ids=candidate_ids,
    )


def _subset_outputs(
    outputs: Mapping[str, Any], positions: np.ndarray
) -> Mapping[str, Any]:
    return {name: value[positions] for name, value in outputs.items()}


def _parent_lineage(
    root: Path, manifest: Mapping[str, Any], *, role: str
) -> Mapping[str, Any]:
    checkpoint = root.expanduser().resolve() / trainer.CHECKPOINT_FILE
    manifest_path = root.expanduser().resolve() / trainer.MANIFEST_FILE
    return {
        "adapter_dir": str(root.expanduser().resolve()),
        "checkpoint_sha256": trainer.sha256_file(checkpoint),
        "dataset": dict(manifest["dataset"]),
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": trainer.sha256_file(manifest_path),
        "role": role,
        "training_label_authority": False,
        "weight_source_only": True,
        "automatic_release_authority": False,
    }


def _descriptor(path: Path) -> Mapping[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "sha256": trainer.sha256_file(path),
    }


def _dataset_manifest_record(
    path: Path, inventory: Mapping[str, Any]
) -> Mapping[str, Any]:
    return {
        "authority_counts": dict(inventory["authority_counts"]),
        "dataset_schema_version": inventory["dataset_schema_version"],
        "family_body_rows": inventory["family_body_rows"],
        "family_variant_rows": inventory["family_variant_rows"],
        "file": str(path),
        "font_supervised_rows": inventory["font_supervised_rows"],
        "row_count": inventory["row_count"],
        "sha256": trainer.sha256_file(path),
        "single_day_body_negative_rows": inventory["single_day_body_negative_rows"],
        "train_rows": inventory["train_rows"],
        "train_work_count": inventory["train_work_count"],
        "val_rows": inventory["val_rows"],
        "val_work_count": inventory["val_work_count"],
    }


def _publish(
    *,
    output_dir: Path,
    state: Mapping[str, np.ndarray],
    manifest_core: Mapping[str, Any],
) -> Path:
    try:
        from safetensors.numpy import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontAdapterInterpolationError("safetensors is required") from error
    output = _safe_output(output_dir)
    if output.exists():
        raise MangaFontAdapterInterpolationError(
            "refusing to overwrite an existing interpolation artifact"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        checkpoint_path = staging / trainer.CHECKPOINT_FILE
        save_file(dict(state), str(checkpoint_path))
        manifest = trainer.seal_record(
            {
                **dict(manifest_core),
                "files": {trainer.CHECKPOINT_FILE: _descriptor(checkpoint_path)},
                "record_type": "manga_font_student_v8_role_family_adapter_manifest",
                "schema_version": trainer.SCHEMA_VERSION,
            }
        )
        manifest_path = staging / trainer.MANIFEST_FILE
        manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
        marker = trainer.seal_record(
            {
                "artifacts": {
                    trainer.CHECKPOINT_FILE: trainer.sha256_file(checkpoint_path),
                    trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path),
                },
                "owner": trainer.OWNER,
                "safe_replace": True,
                "schema_version": trainer.SCHEMA_VERSION,
            }
        )
        (staging / trainer.MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return output


def _validate_published(
    *,
    output_dir: Path,
    expected_state: Mapping[str, np.ndarray],
    candidate_ids: Sequence[str],
    source_query_head: Path,
    architecture: Mapping[str, Any],
    dataset_sha256: str,
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    loaded, _initialization_binding = trainer.load_initial_adapter_state(
        root,
        candidate_ids=candidate_ids,
        source_query_head=source_query_head,
        expected_architecture=architecture,
        expected_state=expected_state,
    )
    manifest = _read_json(root / trainer.MANIFEST_FILE, "published adapter manifest")
    trainer.validate_record_seal(manifest, "published adapter manifest")
    if set(loaded) != set(expected_state) or any(
        not np.array_equal(loaded[name], expected_state[name]) for name in loaded
    ):
        raise MangaFontAdapterInterpolationError("published interpolation state drifted")
    diagnostics = manifest.get("post_selection_diagnostics")
    selection = manifest.get("interpolation_selection")
    authority = manifest.get("authority")
    new_diagnostic_keys = tuple(
        name for name in diagnostics if str(name).startswith("new_high_value_")
    ) if isinstance(diagnostics, Mapping) else ()
    if (
        not isinstance(diagnostics, Mapping)
        or len(new_diagnostic_keys) != 1
        or not isinstance(diagnostics.get("adjudicated_val33"), Mapping)
        or diagnostics["adjudicated_val33"].get("selection_used") is not False
        or not isinstance(diagnostics.get(new_diagnostic_keys[0]), Mapping)
        or diagnostics[new_diagnostic_keys[0]].get("selection_used") is not False
        or not isinstance(selection, Mapping)
        or selection.get("selection_metric_name") != SELECTION_METRIC_NAME
        or selection.get("routing_authority") != SELECTION_ROUTING_AUTHORITY
        or not isinstance(authority, Mapping)
        or authority.get("automatic_release_authority") is not False
        or authority.get("exporter_candidate") is not True
        or manifest.get("dataset", {}).get("sha256") != dataset_sha256
    ):
        raise MangaFontAdapterInterpolationError("published authority/selection seal drifted")
    return {
        "alpha": float(selection["selected_alpha"]),
        "checkpoint_sha256": trainer.sha256_file(root / trainer.CHECKPOINT_FILE),
        "manifest_sha256": trainer.sha256_file(root / trainer.MANIFEST_FILE),
        "output_dir": str(root),
        "quality_gate_passed": True,
        "status": "validated_interpolated_adapter_exporter_candidate",
    }


def build(args: argparse.Namespace) -> Mapping[str, Any]:
    if (
        args.batch_size <= 0
        or args.new_label_count <= 0
        or args.new_label_diagnostic_key
        != f"new_high_value_{args.new_label_count}"
    ):
        raise MangaFontAdapterInterpolationError(
            "batch size/count must be positive and diagnostic key must match the count"
        )
    alphas = parse_alpha_grid(args.alpha_grid)
    (
        candidate_ids,
        architecture,
        base_state,
        target_state,
        base_manifest,
        target_manifest,
        parent_bindings,
    ) = _load_parents(
        base_adapter_dir=args.base_adapter_dir,
        target_adapter_dir=args.target_adapter_dir,
        source_query_head=args.source_query_head,
    )
    dataset_path, arrays, inventory, validation_binding = _validate_datasets(
        base_dataset_npz=args.base_dataset_npz,
        dataset_npz=args.dataset_npz,
        candidate_ids=candidate_ids,
        parent_dataset_bindings=parent_bindings,
    )
    try:
        import torch
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontAdapterInterpolationError("PyTorch is required") from error
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise MangaFontAdapterInterpolationError("CUDA was requested but is unavailable")
    split = arrays["split"].astype(np.int64, copy=False)
    authorities = arrays["font_authority"].astype(str, copy=False)
    weights = arrays["font_supervision_weights"].astype(np.float32, copy=False)
    val_indices = np.flatnonzero(split == 1)
    visual_indices = np.flatnonzero((split == 1) & (authorities == "visual") & (weights > 0))
    if val_indices.size != 9033 or visual_indices.size != 1047:
        raise MangaFontAdapterInterpolationError("r3 selection cohort cardinality drifted")
    visual_positions = np.flatnonzero(
        (authorities[val_indices] == "visual") & (weights[val_indices] > 0)
    )
    if not np.array_equal(val_indices[visual_positions], visual_indices):
        raise MangaFontAdapterInterpolationError("visual cohort projection drifted")

    model = _build_expected_model(torch, architecture, len(candidate_ids)).to(device)
    history: list[Mapping[str, Any]] = []
    states: dict[float, Mapping[str, np.ndarray]] = {}
    for alpha in alphas:
        state = interpolate_states(base_state, target_state, alpha)
        states[alpha] = state
        _load_state_into_model(torch, model, state)
        outputs = _infer(
            torch=torch,
            model=model,
            query_views=arrays["query_views"][val_indices],
            prototype_queries=arrays["prototype_queries"],
            device=device,
            batch_size=args.batch_size,
        )
        all_metrics = _metrics(
            torch=torch,
            outputs=outputs,
            arrays=arrays,
            indices=val_indices,
            candidate_ids=candidate_ids,
        )
        visual_metrics = _metrics(
            torch=torch,
            outputs=_subset_outputs(outputs, visual_positions),
            arrays=arrays,
            indices=visual_indices,
            candidate_ids=candidate_ids,
        )
        checks = trainer.build_quality_gate_checks(all_metrics, visual_metrics)
        history.append(
            {
                "all_metrics": all_metrics,
                "alpha": alpha,
                "quality_gate_checks": checks,
                "quality_gate_passed": all(checks.values()),
                "selection_score": selection_score(all_metrics, visual_metrics),
                "visual_metrics": visual_metrics,
            }
        )
    selected = choose_alpha(history)
    selected_alpha = float(selected["alpha"])
    selected_state = states[selected_alpha]

    # These cohorts are intentionally unavailable until selection is complete.
    val33_ids = _load_sample_ids(
        args.val33_jsonl, expected_rows=33, location="adjudicated val33"
    )
    new_label_ids = _load_sample_ids(
        args.new_labels_jsonl,
        expected_rows=args.new_label_count,
        location=f"new high-value {args.new_label_count}",
    )
    val33_indices = _indices_for_ids(
        arrays, val33_ids, expected_split=1, location="adjudicated val33"
    )
    new_label_indices = _indices_for_ids(
        arrays,
        new_label_ids,
        expected_split=0,
        location=f"new high-value {args.new_label_count}",
    )
    _load_state_into_model(torch, model, selected_state)

    def diagnostic(indices: np.ndarray) -> Mapping[str, Any]:
        outputs = _infer(
            torch=torch,
            model=model,
            query_views=arrays["query_views"][indices],
            prototype_queries=arrays["prototype_queries"],
            device=device,
            batch_size=args.batch_size,
        )
        return _metrics(
            torch=torch,
            outputs=outputs,
            arrays=arrays,
            indices=indices,
            candidate_ids=candidate_ids,
        )

    val33_metrics = diagnostic(val33_indices)
    new_label_metrics = diagnostic(new_label_indices)
    quality_checks = dict(selected["quality_gate_checks"])
    if not all(quality_checks.values()):
        raise MangaFontAdapterInterpolationError("selected interpolation failed quality gate")
    dataset_record = _dataset_manifest_record(dataset_path, inventory)
    output = _publish(
        output_dir=args.output_dir,
        state=selected_state,
        manifest_core={
            "architecture": dict(architecture),
            "authority": {
                "automatic_release_authority": False,
                "calibration_authority": False,
                "evaluation_authority": False,
                "exporter_candidate": True,
                "selection_authority": "r3_work_disjoint_all9033_visual1047_and_sd_safety",
                "training_label_authority": False,
            },
            "best_epoch": {
                "epoch": 0,
                "interpolation_alpha": selected_alpha,
                "selection_score": selected["selection_score"],
                "val": selected["all_metrics"],
                "val_by_authority": {"visual": selected["visual_metrics"]},
            },
            "candidate_ids": list(candidate_ids),
            "dataset": dataset_record,
            "dataset_validation": dict(validation_binding),
            "history": history,
            "interpolation_parents": {
                "base": _parent_lineage(
                    args.base_adapter_dir, base_manifest, role="r3h_anchor"
                ),
                "target": _parent_lineage(
                    args.target_adapter_dir, target_manifest, role="r4h_high_value_restart"
                ),
            },
            "interpolation_selection": {
                "alpha_grid": list(alphas),
                "diagnostic_cohorts_excluded": [
                    "adjudicated_val33",
                    args.new_label_diagnostic_key,
                ],
                "routing_authority": SELECTION_ROUTING_AUTHORITY,
                "selected_alpha": selected_alpha,
                "selected_score": selected["selection_score"],
                "selection_cohorts": {
                    "all_r3_validation_rows": int(val_indices.size),
                    "visual_r3_validation_rows": int(visual_indices.size),
                },
                "selection_metric_formula": SELECTION_METRIC_FORMULA,
                "selection_metric_name": SELECTION_METRIC_NAME,
                "single_day_safety_mandatory": True,
            },
            "post_selection_diagnostics": {
                "adjudicated_val33": {
                    "metrics": val33_metrics,
                    "row_count": 33,
                    "sample_ids_sha256": hashlib.sha256(
                        "\n".join(val33_ids).encode("utf-8")
                    ).hexdigest(),
                    "selection_used": False,
                },
                args.new_label_diagnostic_key: {
                    "human_gold": False,
                    "metrics": new_label_metrics,
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "row_count": args.new_label_count,
                    "sample_ids_sha256": hashlib.sha256(
                        "\n".join(new_label_ids).encode("utf-8")
                    ).hexdigest(),
                    "selection_used": False,
                },
            },
            "quality_gate": {
                "checks": quality_checks,
                "passed": True,
                "routing_authority": SELECTION_ROUTING_AUTHORITY,
                "selection_only": True,
            },
            "source_code_sha256": trainer.sha256_file(Path(__file__).resolve()),
            "source_query_head": {
                "file": str(args.source_query_head.expanduser().resolve()),
                "sha256": trainer.sha256_file(args.source_query_head.expanduser().resolve()),
            },
            "training_seconds": 0.0,
        },
    )
    validation = _validate_published(
        output_dir=output,
        expected_state=selected_state,
        candidate_ids=candidate_ids,
        source_query_head=args.source_query_head,
        architecture=architecture,
        dataset_sha256=trainer.sha256_file(dataset_path),
    )
    return {
        **dict(validation),
        "all_metrics": selected["all_metrics"],
        "new_label_diagnostic_key": args.new_label_diagnostic_key,
        "new_label_metrics": new_label_metrics,
        "selection_score": selected["selection_score"],
        "val33_metrics": val33_metrics,
        "visual_metrics": selected["visual_metrics"],
    }


def validate(args: argparse.Namespace) -> Mapping[str, Any]:
    (
        candidate_ids,
        architecture,
        base_state,
        target_state,
        _base_manifest,
        _target_manifest,
        parent_bindings,
    ) = _load_parents(
        base_adapter_dir=args.base_adapter_dir,
        target_adapter_dir=args.target_adapter_dir,
        source_query_head=args.source_query_head,
    )
    dataset_path, _arrays, _inventory, _binding = _validate_datasets(
        base_dataset_npz=args.base_dataset_npz,
        dataset_npz=args.dataset_npz,
        candidate_ids=candidate_ids,
        parent_dataset_bindings=parent_bindings,
    )
    manifest = _read_json(
        args.output_dir.expanduser().resolve() / trainer.MANIFEST_FILE,
        "interpolation manifest",
    )
    selection = manifest.get("interpolation_selection")
    if not isinstance(selection, Mapping):
        raise MangaFontAdapterInterpolationError("interpolation selection is absent")
    alpha = float(selection.get("selected_alpha", float("nan")))
    expected_state = interpolate_states(base_state, target_state, alpha)
    return _validate_published(
        output_dir=args.output_dir,
        expected_state=expected_state,
        candidate_ids=candidate_ids,
        source_query_head=args.source_query_head,
        architecture=architecture,
        dataset_sha256=trainer.sha256_file(dataset_path),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "validate"):
        command = commands.add_parser(name)
        command.add_argument("--base-adapter-dir", type=Path, default=DEFAULT_BASE_ADAPTER)
        command.add_argument("--target-adapter-dir", type=Path, default=DEFAULT_TARGET_ADAPTER)
        command.add_argument("--base-dataset-npz", type=Path, default=DEFAULT_BASE_DATASET)
        command.add_argument("--dataset-npz", type=Path, default=DEFAULT_DATASET)
        command.add_argument("--source-query-head", type=Path, default=DEFAULT_SOURCE_HEAD)
        command.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
        if name == "build":
            command.add_argument("--alpha-grid", default=DEFAULT_ALPHA_GRID)
            command.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
            command.add_argument("--batch-size", type=int, default=512)
            command.add_argument("--val33-jsonl", type=Path, default=DEFAULT_VAL33)
            command.add_argument("--new-labels-jsonl", type=Path, default=DEFAULT_NEW181)
            command.add_argument("--new-label-count", type=int, default=181)
            command.add_argument(
                "--new-label-diagnostic-key", default="new_high_value_181"
            )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = build(args) if args.command == "build" else validate(args)
    except (
        MangaFontAdapterInterpolationError,
        trainer.MangaFontV8RoleFamilyError,
        OSError,
        KeyError,
        TypeError,
        ValueError,
    ) as error:
        raise SystemExit(f"adapter interpolation error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
