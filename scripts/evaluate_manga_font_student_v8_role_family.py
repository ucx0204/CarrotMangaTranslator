#!/usr/bin/env python3
"""Evaluate a v8 role-family adapter on the sealed visual-review val cohort.

This cohort is useful, sizeable, and work-disjoint from gradient training, but
it is not human gold and it was consulted for checkpoint selection.  The output
therefore uses the exact authority label
``visual_reviewed_work_disjoint_holdout_not_human_gold`` and cannot be treated
as an independent release estimate.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import augment_manga_font_student_v8_with_high_value_labels as overlay_dataset
    from scripts import build_manga_font_student_v8_role_family_dataset as dataset
    from scripts import package_manga_font_student_v8_qa_runtime as package
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import augment_manga_font_student_v8_with_high_value_labels as overlay_dataset  # type: ignore[no-redef]
    import build_manga_font_student_v8_role_family_dataset as dataset  # type: ignore[no-redef]
    import package_manga_font_student_v8_qa_runtime as package  # type: ignore[no-redef]
    import train_manga_font_student_v8_role_family_adapter as trainer  # type: ignore[no-redef]


SCHEMA = "manga-font-student-v8-role-family-visual-holdout-evaluation-v2"
OWNER = "carrot-manga-translator/manga-font-student-v8-role-family-visual-holdout-evaluation-v2"
AUTHORITY = package.VISUAL_HOLDOUT_AUTHORITY
MARKER_FILE = ".manga-font-student-v8-role-family-visual-holdout-evaluation-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
ROWS_FILE = "evaluation-rows.jsonl"
ROUTING_ROWS_FILE = "routing-audit-rows.jsonl"
OUTPUT_FILES = frozenset(
    {MARKER_FILE, MANIFEST_FILE, REPORT_FILE, ROWS_FILE, ROUTING_ROWS_FILE}
)
MIN_SUPERVISED_ROWS = 400
R3_DATASET_SHA256 = "901ee8a0f6e72d42ee917a6827bc76009245ebeda0c479e9e02feb4238107f83"
R3_VISUAL_ROWS = 1047
R3_VAL_ROWS = 9033
R3_VAL_WORKS = 5
SUPPORTED_DATASET_SCHEMAS = frozenset(
    {
        "manga-font-student-v8-role-family-dataset-v1",
        "manga-font-student-v8-role-family-dataset-v2",
        "manga-font-student-v8-role-family-dataset-v3",
    }
)
SUPPORTED_ADAPTER_SCHEMAS = frozenset(
    {
        "manga-font-student-v8-role-family-adapter-v1",
        "manga-font-student-v8-role-family-adapter-v2",
        "manga-font-student-v8-role-family-adapter-v3",
    }
)


class MangaFontV8EvaluationError(ValueError):
    """Raised when the visual holdout evaluation boundary is not reproducible."""


def _evaluation_profile(
    *, dataset_manifest: Mapping[str, Any], dataset_sha256: str
) -> Mapping[str, Any]:
    """Resolve one sealed checkpoint-selection cohort without upgrading it."""

    evaluation_base_sha256 = dataset_manifest.get(
        "evaluation_base_dataset_npz_sha256", dataset_sha256
    )
    if evaluation_base_sha256 == R3_DATASET_SHA256:
        fold = _mapping(
            dataset_manifest.get("adapter_validation_fold"),
            "r3 adapter validation fold",
        )
        if (
            dataset_manifest.get("schema_version")
            not in {
                "manga-font-student-v8-role-family-dataset-v3",
                overlay_dataset.SCHEMA,
            }
            or fold.get("row_count") != 4815
            or fold.get("optimizer_split") != "val"
            or fold.get("master_source_split") != "train"
            or len(fold.get("work_ids", ())) != 1
        ):
            raise MangaFontV8EvaluationError("r3 adapter fold contract drifted")
        return {
            "authority": package.ADAPTER_SELECTION_AUTHORITY,
            "base_dataset_npz_sha256": R3_DATASET_SHA256,
            "dataset_npz_sha256": dataset_sha256,
            "expected_visual_rows": R3_VISUAL_ROWS,
            "expected_val_rows": R3_VAL_ROWS,
            "expected_val_works": R3_VAL_WORKS,
            "profile": "r3_body_holdout_checkpoint_selection",
        }
    return {
        "authority": package.VISUAL_HOLDOUT_AUTHORITY,
        "base_dataset_npz_sha256": dataset_sha256,
        "dataset_npz_sha256": dataset_sha256,
        "expected_visual_rows": None,
        "expected_val_rows": None,
        "expected_val_works": 4,
        "profile": "legacy_four_work_checkpoint_selection",
    }


def _dataset_lineage_record(
    *,
    profile: Mapping[str, Any],
    inventory: Mapping[str, Any],
    bindings: Mapping[str, Any],
) -> dict[str, Any]:
    base_sha256 = _sha(
        profile.get("base_dataset_npz_sha256"),
        "evaluation base dataset SHA",
    )
    evaluated_sha256 = _sha(
        bindings.get("dataset_npz_sha256"), "evaluated dataset SHA"
    )
    is_overlay = evaluated_sha256 != base_sha256
    byte_identical = (
        inventory.get("validation_arrays_byte_identical_to_base") is True
        if is_overlay
        else True
    )
    if is_overlay and not byte_identical:
        raise MangaFontV8EvaluationError(
            "training overlay lacks byte-identical validation lineage"
        )
    return {
        "adapter_manifest_sha256": _sha(
            bindings.get("adapter_manifest_sha256"), "adapter manifest SHA"
        ),
        "base_dataset_npz_sha256": base_sha256,
        "dataset_manifest_sha256": _sha(
            bindings.get("dataset_manifest_sha256"), "dataset manifest SHA"
        ),
        "evaluated_dataset_npz_sha256": evaluated_sha256,
        "profile": _text(profile.get("profile"), "evaluation profile name"),
        "training_overlay": is_overlay,
        "validation_arrays_byte_identical_to_base": byte_identical,
    }


def _authority_record(authority: str) -> dict[str, Any]:
    if authority not in {
        package.VISUAL_HOLDOUT_AUTHORITY,
        package.ADAPTER_SELECTION_AUTHORITY,
    }:
        raise MangaFontV8EvaluationError("evaluation authority is unsupported")
    return {
        "authority": authority,
        "base_independent_evaluation": False,
        "checkpoint_selection_only": True,
        "human_gold": False,
        "independent_gold": False,
        "quality_gate_authority": "qa_packaging_only_not_release",
        "release_quality_gate_authority": False,
        "training_eligible": False,
    }


def _boundary_record(
    *, row_count: int, routing_row_count: int, work_count: int
) -> dict[str, Any]:
    return {
        "base_independent_evaluation": False,
        "checkpoint_selection_rows": row_count,
        "evaluation_work_count": work_count,
        "gradient_fit_rows": 0,
        "human_gold": False,
        "independent_test": False,
        "pixel_routing_audit_rows": routing_row_count,
        "pseudo_visual_review": True,
        "source_page_disjoint_from_training": True,
        "split": "val",
        "training_work_overlap_count": 0,
        "used_for_checkpoint_selection": True,
        "work_disjoint_from_gradient_training": True,
    }


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV8EvaluationError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise MangaFontV8EvaluationError(f"{location}: expected list")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise MangaFontV8EvaluationError(f"{location}: expected non-empty text")
    return value


def _sha(value: Any, location: str) -> str:
    result = _text(value, location)
    if len(result) != 64 or any(char not in "0123456789abcdef" for char in result):
        raise MangaFontV8EvaluationError(f"{location}: expected lowercase SHA-256")
    return result


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        ).encode("utf-8")
    return (_canonical_json(value) + "\n").encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _seal(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = _sha256_bytes(
        _canonical_json(result).encode("utf-8")
    )
    return result


def _validate_seal(record: Mapping[str, Any], location: str) -> str:
    declared = record.get("record_sha256")
    if not isinstance(declared, str) or len(declared) != 64:
        raise MangaFontV8EvaluationError(f"{location}: invalid record seal")
    actual = _seal(record)["record_sha256"]
    if declared != actual:
        raise MangaFontV8EvaluationError(f"{location}: record seal drifted")
    return declared


def _read_json(path: Path, location: str) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise MangaFontV8EvaluationError(f"{location}: missing or linked file")
    try:
        return dict(
            _mapping(json.loads(resolved.read_text(encoding="utf-8")), location)
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MangaFontV8EvaluationError(f"{location}: invalid JSON") from error


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    try:
        handle = path.open(encoding="utf-8")
    except OSError as error:
        raise MangaFontV8EvaluationError(f"{location}: unavailable") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise MangaFontV8EvaluationError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV8EvaluationError(f"missing evaluation artifact: {path.name}")
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": _sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontV8EvaluationError(f"unsafe output directory: {result}")
    return result


def _validate_overlay_dataset_artifact(
    root: Path, dataset_path: Path
) -> Mapping[str, Any]:
    """Validate a train-only overlay without upgrading its evidence authority."""

    try:
        overlay_dataset.validate_output(root)
    except Exception as error:  # noqa: BLE001
        raise MangaFontV8EvaluationError(
            f"overlay dataset validation failed: {error}"
        ) from error
    manifest = _read_json(root / overlay_dataset.MANIFEST_FILE, "overlay manifest")
    report = _read_json(root / overlay_dataset.REPORT_FILE, "overlay report")
    authority = _mapping(manifest.get("authority"), "overlay authority")
    declared = _mapping(manifest.get("dataset"), "overlay dataset")
    sources = _mapping(manifest.get("sources"), "overlay sources")
    base_source = _mapping(sources.get("base_dataset"), "overlay base dataset")
    declared_base_root = Path(
        _text(base_source.get("output_dir"), "overlay base dataset directory")
    ).expanduser()
    if declared_base_root.is_symlink():
        raise MangaFontV8EvaluationError("overlay base dataset directory is linked")
    base_root = declared_base_root.resolve()
    if (
        {path.name for path in base_root.iterdir()} != dataset.OUTPUT_FILES
        or any(path.is_symlink() or not path.is_file() for path in base_root.iterdir())
    ):
        raise MangaFontV8EvaluationError("overlay base dataset inventory drifted")
    try:
        base_validation = dataset.validate_output(base_root)
    except Exception as error:  # noqa: BLE001
        raise MangaFontV8EvaluationError(
            f"overlay base dataset validation failed: {error}"
        ) from error
    base_path = base_root / dataset.DATASET_FILE
    base_manifest_path = base_root / dataset.MANIFEST_FILE
    base_manifest = _read_json(base_manifest_path, "overlay base manifest")
    if (
        manifest.get("schema_version") != overlay_dataset.SCHEMA
        or manifest.get("record_type")
        != "manga_font_student_v8_high_value_overlay_manifest"
        or report.get("schema_version") != overlay_dataset.SCHEMA
        or report.get("record_type")
        != "manga_font_student_v8_high_value_overlay_report"
        or authority.get("training_eligible") is not True
        or authority.get("training_only") is not True
        or authority.get("human_gold") is not False
        or authority.get("evaluation_authority") is not False
        or authority.get("automatic_release_authority") is not False
        or authority.get("review_authority")
        != "codex_agent_direct_visual_supervision"
        or declared.get("file") != overlay_dataset.DATASET_FILE
        or declared.get("byte_size") != dataset_path.stat().st_size
        or declared.get("sha256") != _sha256_file(dataset_path)
        or base_source.get("npz_sha256") != _sha256_file(base_path)
        or base_source.get("manifest_sha256") != _sha256_file(base_manifest_path)
        or base_validation.get("work_overlap_count") != 0
        or base_validation.get("val_rows") != R3_VAL_ROWS
    ):
        raise MangaFontV8EvaluationError("overlay dataset authority/source drifted")
    base_counts = dict(_mapping(base_manifest.get("counts"), "base dataset counts"))
    overlay_counts = dict(_mapping(manifest.get("counts"), "overlay counts"))
    effective = dict(manifest)
    effective["adapter_validation_fold"] = base_manifest.get(
        "adapter_validation_fold"
    )
    effective["counts"] = {
        **base_counts,
        **overlay_counts,
        "work_overlap_count": 0,
    }
    effective["evaluation_base_dataset_npz_sha256"] = _sha256_file(base_path)
    effective["sources"] = base_manifest.get("sources")
    effective["training_overlay"] = {
        "authority": dict(authority),
        "manifest_record_sha256": manifest.get("record_sha256"),
        "manifest_sha256": _sha256_file(root / overlay_dataset.MANIFEST_FILE),
        "validation_arrays_must_match_base": True,
    }
    return {
        "base_dataset_path": base_path,
        "manifest": effective,
        "report": report,
        "schema_version": overlay_dataset.SCHEMA,
    }


def _validate_dataset_artifact(root: Path, dataset_path: Path) -> Mapping[str, Any]:
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV8EvaluationError("dataset output directory is unavailable")
    if any(path.is_symlink() or not path.is_file() for path in root.iterdir()):
        raise MangaFontV8EvaluationError("dataset output contains linked/non-file entries")
    inventory = {path.name for path in root.iterdir()}
    if inventory == overlay_dataset.OUTPUT_FILES:
        return _validate_overlay_dataset_artifact(root, dataset_path)
    marker_paths = tuple(
        path
        for path in root.iterdir()
        if path.name.startswith(".manga-font-student-v8-role-family-dataset-v")
        and path.name.endswith("-owned.json")
    )
    expected_names = {
        dataset.DATASET_FILE,
        dataset.MANIFEST_FILE,
        dataset.REPORT_FILE,
    }
    if (
        len(marker_paths) != 1
        or inventory != {*expected_names, marker_paths[0].name}
        or any(path.is_symlink() or not path.is_file() for path in root.iterdir())
    ):
        raise MangaFontV8EvaluationError("dataset output exact inventory drifted")
    marker = _read_json(marker_paths[0], "dataset marker")
    manifest = _read_json(root / dataset.MANIFEST_FILE, "dataset manifest")
    report = _read_json(root / dataset.REPORT_FILE, "dataset report")
    for location, record in (
        ("dataset marker", marker),
        ("dataset manifest", manifest),
        ("dataset report", report),
    ):
        _validate_seal(record, location)
    schema = _text(manifest.get("schema_version"), "dataset schema")
    if (
        schema not in SUPPORTED_DATASET_SCHEMAS
        or marker.get("schema_version") != schema
        or marker.get("owner") != f"carrot-manga-translator/{schema}"
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != schema
        or manifest.get("record_type")
        != "manga_font_student_v8_role_family_dataset_manifest"
        or report.get("record_type")
        != "manga_font_student_v8_role_family_dataset_report"
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
    ):
        raise MangaFontV8EvaluationError("dataset metadata/schema drifted")
    marker_artifacts = _mapping(marker.get("artifacts"), "dataset marker artifacts")
    if set(marker_artifacts) != expected_names or any(
        marker_artifacts.get(name) != _sha256_file(root / name)
        for name in expected_names
    ):
        raise MangaFontV8EvaluationError("dataset marker artifact binding drifted")
    report_artifacts = _mapping(report.get("artifacts"), "dataset report artifacts")
    if set(report_artifacts) != {dataset.DATASET_FILE, dataset.MANIFEST_FILE}:
        raise MangaFontV8EvaluationError("dataset report inventory drifted")
    for name in report_artifacts:
        descriptor = _mapping(report_artifacts.get(name), f"dataset report {name}")
        if any(
            (
                descriptor.get("file") != name,
                descriptor.get("byte_size") != (root / name).stat().st_size,
                descriptor.get("sha256") != _sha256_file(root / name),
            )
        ):
            raise MangaFontV8EvaluationError(f"dataset descriptor drifted: {name}")
    declared_dataset = _mapping(manifest.get("dataset"), "manifest dataset")
    if (
        declared_dataset.get("file") != dataset.DATASET_FILE
        or declared_dataset.get("byte_size") != dataset_path.stat().st_size
        or declared_dataset.get("sha256") != _sha256_file(dataset_path)
    ):
        raise MangaFontV8EvaluationError("manifest dataset descriptor drifted")
    _sha(manifest.get("source_code_sha256"), "dataset source code SHA")
    return {"manifest": manifest, "report": report, "schema_version": schema}


def _load_dataset(
    dataset_npz: Path,
) -> tuple[Path, dict[str, np.ndarray], Mapping[str, Any], Mapping[str, Any]]:
    path = dataset_npz.expanduser().resolve()
    root = path.parent
    if path.name != dataset.DATASET_FILE:
        raise MangaFontV8EvaluationError("dataset NPZ must be the sealed dataset file")
    artifact = _validate_dataset_artifact(root, path)
    manifest = artifact["manifest"]
    try:
        with np.load(path, allow_pickle=False) as source:
            arrays = {name: np.array(source[name], copy=True) for name in source.files}
    except (OSError, ValueError) as error:
        raise MangaFontV8EvaluationError("dataset NPZ could not be loaded") from error
    try:
        inventory = dataset.validate_dataset_arrays(arrays)
    except dataset.V8RoleFamilyDatasetError as error:
        raise MangaFontV8EvaluationError(str(error)) from error
    counts = _mapping(manifest.get("counts"), "dataset counts")
    if (
        inventory["work_overlap_count"] != 0
        or int(counts.get("work_overlap_count", -1)) != 0
        or inventory["train_rows"] != int(counts.get("train_rows", -1))
        or inventory["val_rows"] != int(counts.get("val_rows", -1))
        or manifest.get("array_contract")
        != {
            name: {"dtype": str(value.dtype), "shape": list(value.shape)}
            for name, value in sorted(arrays.items())
        }
    ):
        raise MangaFontV8EvaluationError("dataset train/val work leakage detected")
    base_path = artifact.get("base_dataset_path")
    if base_path is not None:
        resolved_base = Path(base_path).expanduser().resolve()
        try:
            with np.load(resolved_base, allow_pickle=False) as source:
                base_arrays = {
                    name: np.array(source[name], copy=True) for name in source.files
                }
            dataset.validate_dataset_arrays(base_arrays)
        except (OSError, ValueError, dataset.V8RoleFamilyDatasetError) as error:
            raise MangaFontV8EvaluationError(
                "overlay base arrays could not be validated"
            ) from error
        if set(base_arrays) != set(arrays):
            raise MangaFontV8EvaluationError("overlay/base array inventory drifted")
        split = arrays["split"].astype(np.int64, copy=False)
        base_split = base_arrays["split"].astype(np.int64, copy=False)
        if (
            not np.array_equal(split, base_split)
            or not np.array_equal(arrays["candidate_ids"], base_arrays["candidate_ids"])
            or not np.array_equal(
                arrays["prototype_queries"], base_arrays["prototype_queries"]
            )
        ):
            raise MangaFontV8EvaluationError(
                "overlay/base candidate, split, or prototype arrays drifted"
            )
        val = split == 1
        row_arrays = {
            name
            for name, value in arrays.items()
            if name not in {"candidate_ids", "prototype_queries"}
            and value.ndim >= 1
            and value.shape[0] == split.shape[0]
        }
        if any(
            not np.array_equal(arrays[name][val], base_arrays[name][val])
            for name in row_arrays
        ):
            raise MangaFontV8EvaluationError(
                "overlay validation arrays differ from the sealed r3 base"
            )
        inventory = {
            **dict(inventory),
            "evaluation_base_dataset_npz_sha256": _sha256_file(resolved_base),
            "training_overlay_npz_sha256": _sha256_file(path),
            "validation_arrays_byte_identical_to_base": True,
        }
    return path, arrays, manifest, inventory


def _load_adapter(
    adapter_dir: Path,
    *,
    candidate_ids: Sequence[str],
    dataset_sha256: str,
    device_name: str,
) -> tuple[Any, Any, Mapping[str, Any]]:
    try:
        import torch
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV8EvaluationError("torch and safetensors are required") from error
    root = adapter_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != trainer.OUTPUT_FILES
        or any(path.is_symlink() or not path.is_file() for path in root.iterdir())
    ):
        raise MangaFontV8EvaluationError("adapter exact inventory drifted")
    marker = _read_json(root / trainer.MARKER_FILE, "adapter marker")
    manifest = _read_json(root / trainer.MANIFEST_FILE, "adapter manifest")
    _validate_seal(marker, "adapter marker")
    _validate_seal(manifest, "adapter manifest")
    artifacts = _mapping(marker.get("artifacts"), "adapter marker.artifacts")
    adapter_schema = _text(manifest.get("schema_version"), "adapter schema")
    if (
        adapter_schema not in SUPPORTED_ADAPTER_SCHEMAS
        or marker.get("owner") != f"carrot-manga-translator/{adapter_schema}"
        or marker.get("schema_version") != adapter_schema
        or marker.get("safe_replace") is not True
        or set(artifacts) != {trainer.CHECKPOINT_FILE, trainer.MANIFEST_FILE}
        or any(
            artifacts.get(name) != _sha256_file(root / name)
            for name in (trainer.CHECKPOINT_FILE, trainer.MANIFEST_FILE)
        )
        or manifest.get("record_type")
        != "manga_font_student_v8_role_family_adapter_manifest"
        or tuple(manifest.get("candidate_ids", ())) != tuple(candidate_ids)
    ):
        raise MangaFontV8EvaluationError("adapter marker/manifest binding drifted")
    manifest_dataset = _mapping(manifest.get("dataset"), "adapter dataset")
    if manifest_dataset.get("sha256") != dataset_sha256:
        raise MangaFontV8EvaluationError("adapter was trained from a different dataset")
    checkpoint_path = root / trainer.CHECKPOINT_FILE
    descriptor = _mapping(
        _mapping(manifest.get("files"), "adapter files").get(trainer.CHECKPOINT_FILE),
        "adapter checkpoint descriptor",
    )
    if (
        descriptor.get("sha256") != _sha256_file(checkpoint_path)
        or descriptor.get("byte_size") != checkpoint_path.stat().st_size
    ):
        raise MangaFontV8EvaluationError("adapter checkpoint descriptor drifted")
    architecture = _mapping(manifest.get("architecture"), "adapter architecture")
    maximum_bias = float(architecture.get("maximum_family_bias", 0.0))
    model_kwargs: dict[str, Any] = {
        "candidate_count": len(candidate_ids),
        "maximum_family_bias": maximum_bias,
    }
    if adapter_schema.endswith(("-v2", "-v3")):
        model_kwargs.update(
            {
                "candidate_residual_hidden_dim": int(
                    architecture.get("candidate_residual_hidden_dim", 0)
                ),
                "maximum_sample_residual": float(
                    architecture.get("maximum_sample_residual", 0.0)
                ),
            }
        )
    model = trainer.build_role_family_adapter(
        torch,
        **model_kwargs,
    )
    try:
        state = dict(load_file(str(checkpoint_path), device="cpu"))
        incompatible = model.load_state_dict(state, strict=False)
        missing = set(incompatible.missing_keys)
        unexpected = set(incompatible.unexpected_keys)
        expected_v1_missing = {
            "sample_candidate_norm.bias",
            "sample_candidate_norm.weight",
            "sample_candidate_residual.0.bias",
            "sample_candidate_residual.0.weight",
            "sample_candidate_residual.2.bias",
            "sample_candidate_residual.2.weight",
        }
        if unexpected or (
            adapter_schema.endswith("-v1") and missing != expected_v1_missing
        ) or (adapter_schema.endswith(("-v2", "-v3")) and missing):
            raise MangaFontV8EvaluationError(
                "adapter checkpoint state schema drifted: "
                f"missing={sorted(missing)}, unexpected={sorted(unexpected)}"
            )
    except Exception as error:  # noqa: BLE001
        raise MangaFontV8EvaluationError(
            f"adapter checkpoint reconstruction failed: {error}"
        ) from error
    device = torch.device(device_name)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise MangaFontV8EvaluationError("CUDA was requested but is unavailable")
    model.requires_grad_(False)
    model.eval().to(device)
    quality_gate = _mapping(manifest.get("quality_gate"), "adapter quality gate")
    if adapter_schema.endswith("-v3") and (
        quality_gate.get("routing_authority")
        != "predicted_pixel_family_with_single_day_eligibility"
        or _mapping(
            quality_gate.get("checks"), "adapter quality gate checks"
        ).get("single_day_all_rows_top1_rate_at_most_0_01")
        is not True
    ):
        raise MangaFontV8EvaluationError(
            "v3 adapter lacks production-route Single Day quality authority"
        )
    return torch, model, {
        "checkpoint_sha256": _sha256_file(checkpoint_path),
        "manifest": manifest,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": _sha256_file(root / trainer.MANIFEST_FILE),
        "root": root,
        "training_quality_gate_passed": bool(quality_gate.get("passed")),
    }


def _load_reporting_roles(
    *,
    dataset_manifest: Mapping[str, Any],
    sample_ids: frozenset[str],
) -> tuple[dict[str, Any], Mapping[str, Any]]:
    sources = _mapping(dataset_manifest.get("sources"), "dataset sources")
    pass_source = _mapping(sources.get("pass"), "dataset pass source")
    validation = _mapping(pass_source.get("validation"), "dataset pass validation")
    pass_root = Path(_text(validation.get("output_dir"), "pass output directory"))
    try:
        rows, binding = dataset._load_pass_rows(pass_root, sample_ids)  # noqa: SLF001
    except dataset.V8RoleFamilyDatasetError as error:
        raise MangaFontV8EvaluationError(str(error)) from error
    if (
        binding.get("report_sha256") != pass_source.get("report_sha256")
        or binding.get("review_sha256") != pass_source.get("review_sha256")
    ):
        raise MangaFontV8EvaluationError("dataset/pass reporting-role binding drifted")
    return rows, binding


def _load_visual_authority(
    *,
    dataset_manifest: Mapping[str, Any],
    required_sample_ids: frozenset[str],
    authority: str,
) -> tuple[dict[str, Any], Mapping[str, Any]]:
    visual_source = _mapping(
        _mapping(dataset_manifest.get("sources"), "dataset sources").get("visual"),
        "dataset visual source",
    )
    validation = _mapping(visual_source.get("validation"), "visual validation")
    root = Path(_text(validation.get("output_dir"), "visual output directory"))
    try:
        decisions, _candidate_ids, decision_binding = dataset._load_visual_decisions(  # noqa: SLF001
            root
        )
        if authority == package.VISUAL_HOLDOUT_AUTHORITY:
            _val_ids, completed, _counts = dataset._load_val_visual_ids(  # noqa: SLF001
                root, decisions
            )
        elif authority == package.ADAPTER_SELECTION_AUTHORITY:
            completed = {}
            for sample_id in required_sample_ids:
                decision = decisions.get(sample_id)
                label = (
                    dataset._visual_font_label(decision)  # noqa: SLF001
                    if decision is not None
                    else None
                )
                if label is None:
                    raise MangaFontV8EvaluationError(
                        f"{sample_id}: r3 visual authority is absent or review-needed"
                    )
                completed[sample_id] = label
        else:
            raise MangaFontV8EvaluationError("unsupported visual authority profile")
    except dataset.V8RoleFamilyDatasetError as error:
        raise MangaFontV8EvaluationError(str(error)) from error
    if (
        decision_binding.get("manifest_sha256") != visual_source.get("manifest_sha256")
        or decision_binding.get("report_sha256") != visual_source.get("report_sha256")
    ):
        raise MangaFontV8EvaluationError("dataset/visual source binding drifted")
    if set(completed) != set(required_sample_ids):
        raise MangaFontV8EvaluationError(
            "completed visual authority does not match supervised val rows"
        )
    return completed, decision_binding


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values.astype(np.float64) - values.max(axis=1, keepdims=True)
    result = np.exp(shifted)
    return result / result.sum(axis=1, keepdims=True)


def _infer(
    *,
    torch: Any,
    model: Any,
    query_views: np.ndarray,
    prototype_queries: np.ndarray,
    device_name: str,
    batch_size: int,
) -> Mapping[str, np.ndarray]:
    device = torch.device(device_name)
    prototypes = torch.from_numpy(prototype_queries.astype(np.float32, copy=False)).to(
        device
    )
    collected: dict[str, list[np.ndarray]] = defaultdict(list)
    with torch.inference_mode():
        for start in range(0, query_views.shape[0], batch_size):
            views = torch.from_numpy(
                query_views[start : start + batch_size].astype(
                    np.float32, copy=False
                )
            ).to(device)
            outputs = model(views, prototypes)
            for name in (
                "body_candidate_scores",
                "variant_candidate_scores",
                "family_logits",
            ):
                collected[name].append(outputs[name].detach().float().cpu().numpy())
    result = {name: np.concatenate(rows, axis=0) for name, rows in collected.items()}
    if any(not np.isfinite(value).all() for value in result.values()):
        raise MangaFontV8EvaluationError("adapter inference produced non-finite values")
    return result


def _production_route(
    outputs: Mapping[str, np.ndarray], *, single_day_index: int
) -> Mapping[str, np.ndarray]:
    """Mirror the runtime family route and specialist-font eligibility."""

    family_probabilities = _softmax(outputs["family_logits"])
    predicted_family = family_probabilities.argmax(axis=1)
    raw_scores = np.where(
        (predicted_family == trainer.BODY_FAMILY_INDEX)[:, None],
        outputs["body_candidate_scores"],
        outputs["variant_candidate_scores"],
    ).astype(np.float32, copy=True)
    competitor_scores = raw_scores.copy()
    competitor_scores[:, single_day_index] = -np.inf
    raw_margin = raw_scores[:, single_day_index] - competitor_scores.max(axis=1)
    allowed = (
        (predicted_family == trainer.VARIANT_FAMILY_INDEX)
        & (
            family_probabilities[:, trainer.VARIANT_FAMILY_INDEX]
            >= trainer.MINIMUM_SINGLE_DAY_VARIANT_CONFIDENCE
        )
        & (raw_margin >= trainer.MINIMUM_SINGLE_DAY_RAW_LOGIT_MARGIN)
    )
    deployed_scores = raw_scores.copy()
    minimum_scores = raw_scores.copy()
    minimum_scores[:, single_day_index] = np.inf
    minimum_competitor = minimum_scores.min(axis=1)
    deployed_scores[~allowed, single_day_index] = (
        minimum_competitor[~allowed] - 1.0
    )
    return {
        "deployed_scores": deployed_scores,
        "family_probabilities": family_probabilities,
        "predicted_family": predicted_family,
        "raw_margin": raw_margin,
        "raw_scores": raw_scores,
        "single_day_allowed": allowed,
    }


def _build_routing_rows(
    *,
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    outputs: Mapping[str, np.ndarray],
) -> list[dict[str, Any]]:
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    single_day_index = candidate_ids.index("single-day")
    routed = _production_route(outputs, single_day_index=single_day_index)
    raw_top1 = routed["raw_scores"].argmax(axis=1)
    deployed_top1 = routed["deployed_scores"].argmax(axis=1)
    sample_ids = arrays["sample_ids"].astype(str)
    work_ids = arrays["work_ids"].astype(str)
    result: list[dict[str, Any]] = []
    for position, source_index in enumerate(indices.tolist()):
        predicted_family = int(routed["predicted_family"][position])
        result.append(
            _seal(
                {
                    "authority": "pixel_only_checkpoint_selection_routing_audit",
                    "family_confidence": float(
                        routed["family_probabilities"][position, predicted_family]
                    ),
                    "predicted_family": trainer.FAMILY_VALUES[predicted_family],
                    "record_type": "manga_font_v8_role_family_routing_audit_row",
                    "sample_id": str(sample_ids[source_index]),
                    "schema_version": SCHEMA,
                    "single_day_allowed": bool(
                        routed["single_day_allowed"][position]
                    ),
                    "single_day_deployed_top1": bool(
                        deployed_top1[position] == single_day_index
                    ),
                    "single_day_raw_margin": float(routed["raw_margin"][position]),
                    "single_day_raw_top1": bool(
                        raw_top1[position] == single_day_index
                    ),
                    "split": "val",
                    "training_eligible": False,
                    "work_id": str(work_ids[source_index]),
                }
            )
        )
    return result


def _routing_metrics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    row_count = len(rows)
    if row_count < 1:
        raise MangaFontV8EvaluationError("routing audit is empty")
    eligible_top1 = sum(bool(row["single_day_deployed_top1"]) for row in rows)
    return {
        "routing_authority": "predicted_pixel_family_with_single_day_eligibility",
        "single_day_all_rows": row_count,
        "single_day_all_top1_count": eligible_top1,
        "single_day_all_top1_rate": eligible_top1 / row_count,
        "single_day_raw_all_top1_count": sum(
            bool(row["single_day_raw_top1"]) for row in rows
        ),
        "single_day_variant_gate_allowed_rows": sum(
            bool(row["single_day_allowed"]) for row in rows
        ),
    }


def _confusion(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    family: dict[str, Counter[str]] = defaultdict(Counter)
    per_font: dict[str, dict[str, Any]] = {}
    per_role: dict[str, dict[str, Any]] = {}
    for row in rows:
        actual_family = str(row["actual_family"])
        predicted_family = str(row["predicted_family"])
        family[actual_family][predicted_family] += 1
        preferred = str(row["preferred_font_id"])
        font = per_font.setdefault(
            preferred,
            {
                "acceptable_hits": 0,
                "predicted_font_counts": Counter(),
                "preferred_hits": 0,
                "rows": 0,
            },
        )
        font["rows"] += 1
        font["preferred_hits"] += int(bool(row["preferred_hit"]))
        font["acceptable_hits"] += int(bool(row["acceptable_hit"]))
        font["predicted_font_counts"][str(row["predicted_font_id"])] += 1
        role_name = str(row["reporting_role"])
        role = per_role.setdefault(
            role_name,
            {
                "acceptable_hits": 0,
                "family_confusion": defaultdict(Counter),
                "predicted_font_counts": Counter(),
                "preferred_hits": 0,
                "rows": 0,
            },
        )
        role["rows"] += 1
        role["preferred_hits"] += int(bool(row["preferred_hit"]))
        role["acceptable_hits"] += int(bool(row["acceptable_hit"]))
        role["predicted_font_counts"][str(row["predicted_font_id"])] += 1
        role["family_confusion"][actual_family][predicted_family] += 1

    def finish(group: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, raw in sorted(group.items()):
            count = int(raw["rows"])
            value = {
                "acceptable_at1": int(raw["acceptable_hits"]) / count,
                "predicted_font_counts": dict(
                    sorted(raw["predicted_font_counts"].items())
                ),
                "preferred_at1": int(raw["preferred_hits"]) / count,
                "rows": count,
            }
            if "family_confusion" in raw:
                value["family_confusion"] = {
                    family_name: dict(sorted(counts.items()))
                    for family_name, counts in sorted(raw["family_confusion"].items())
                }
            result[key] = value
        return result

    return {
        "family": {
            key: dict(sorted(value.items())) for key, value in sorted(family.items())
        },
        "per_font": finish(per_font),
        "per_role": finish(per_role),
    }


def _metrics(
    rows: Sequence[Mapping[str, Any]],
    routing_metrics: Mapping[str, Any],
) -> dict[str, Any]:
    count = len(rows)
    body_negative = [row for row in rows if row["single_day_body_negative"]]
    oracle_acceptable = sum(bool(row["oracle_family_acceptable_hit"]) for row in rows)
    oracle_preferred = sum(bool(row["oracle_family_preferred_hit"]) for row in rows)
    top1_counts = Counter(str(row["predicted_font_id"]) for row in rows)
    single_day_predicted = [
        row for row in rows if row["predicted_font_id"] == "single-day"
    ]
    single_day_positive = [
        row for row in rows if "single-day" in row["acceptable_font_ids"]
    ]
    single_day_true_positive = [
        row
        for row in single_day_predicted
        if "single-day" in row["acceptable_font_ids"]
    ]
    return {
        "acceptable_at1": sum(bool(row["acceptable_hit"]) for row in rows) / count,
        "evaluated_positive_rows": count,
        "family_accuracy": sum(bool(row["family_correct"]) for row in rows) / count,
        "oracle_family_acceptable_at1": oracle_acceptable / count,
        "oracle_family_preferred_at1": oracle_preferred / count,
        "preferred_at1": sum(bool(row["preferred_hit"]) for row in rows) / count,
        "single_day_body_false_top1_count": sum(
            bool(row["single_day_body_false_top1"]) for row in body_negative
        ),
        "single_day_body_false_top1_rate": sum(
            bool(row["single_day_body_false_top1"]) for row in body_negative
        )
        / max(1, len(body_negative)),
        "single_day_body_negative_rows": len(body_negative),
        "single_day_positive_count": len(single_day_positive),
        "single_day_positive_precision": len(single_day_true_positive)
        / max(1, len(single_day_predicted)),
        "single_day_positive_recall": len(single_day_true_positive)
        / max(1, len(single_day_positive)),
        "single_day_predicted_count": len(single_day_predicted),
        "top1_outside_reviewed_five_rate": sum(
            not bool(row["predicted_inside_reviewed_five"]) for row in rows
        )
        / count,
        "top1_candidate_distribution": dict(sorted(top1_counts.items())),
        "top1_max_candidate_share": max(top1_counts.values()) / count,
        "top1_unique_candidate_count": len(top1_counts),
        **dict(routing_metrics),
    }


def _quality_gate(metrics: Mapping[str, Any]) -> dict[str, Any]:
    checks = package._evaluation_checks(  # noqa: SLF001
        metrics, int(metrics["evaluated_positive_rows"])
    )
    return {
        "authority": "qa_packaging_only_not_release",
        "checks": checks,
        "passed": all(checks.values()),
        "release_quality_gate_authority": False,
    }


def _build_rows(
    *,
    arrays: Mapping[str, np.ndarray],
    indices: np.ndarray,
    outputs: Mapping[str, np.ndarray],
    roles: Mapping[str, Any],
    visual_labels: Mapping[str, Any],
    authority: str = AUTHORITY,
) -> list[dict[str, Any]]:
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    sample_ids = arrays["sample_ids"].astype(str)
    work_ids = arrays["work_ids"].astype(str)
    labels = arrays["family_labels"].astype(np.int64, copy=False)[indices]
    positives = arrays["positive_mask"].astype(bool, copy=False)[indices]
    preferred = arrays["preferred_mask"].astype(bool, copy=False)[indices]
    eligible = arrays["candidate_eligible_mask"].astype(bool, copy=False)[indices]
    single_negative = arrays["single_day_body_negative"].astype(bool, copy=False)[
        indices
    ]
    single_day_index = candidate_ids.index("single-day")
    routed = _production_route(outputs, single_day_index=single_day_index)
    family_probabilities = routed["family_probabilities"]
    predicted_family = routed["predicted_family"]
    predicted_scores = routed["deployed_scores"]
    oracle_scores = np.where(
        (labels == trainer.BODY_FAMILY_INDEX)[:, None],
        outputs["body_candidate_scores"],
        outputs["variant_candidate_scores"],
    )
    top1 = predicted_scores.argmax(axis=1)
    oracle_top1 = oracle_scores.argmax(axis=1)
    rows: list[dict[str, Any]] = []
    for position, source_index in enumerate(indices.tolist()):
        sample_id = str(sample_ids[source_index])
        visual = visual_labels.get(sample_id)
        role = roles.get(sample_id)
        if visual is None or role is None:
            raise MangaFontV8EvaluationError(
                f"{sample_id}: visual or reporting-role evidence is missing"
            )
        mask_positive = tuple(
            candidate_ids[index] for index in np.flatnonzero(positives[position])
        )
        mask_preferred = tuple(
            candidate_ids[index] for index in np.flatnonzero(preferred[position])
        )
        mask_eligible = tuple(
            candidate_ids[index] for index in np.flatnonzero(eligible[position])
        )
        if (
            mask_preferred != (visual.selected_id,)
            or set(mask_positive)
            != {visual.selected_id, *visual.acceptable_ids}
            or set(mask_eligible) != set(visual.reviewed_ids)
            or dataset.role_family(role.role) != int(labels[position])
        ):
            raise MangaFontV8EvaluationError(
                f"{sample_id}: NPZ/visual/role authority binding drifted"
            )
        ranking = np.argsort(-predicted_scores[position], kind="stable")[:5]
        predicted_index = int(top1[position])
        oracle_index = int(oracle_top1[position])
        row = _seal(
            {
                "acceptable_font_ids": list(mask_positive),
                "acceptable_hit": bool(positives[position, predicted_index]),
                "actual_family": trainer.FAMILY_VALUES[int(labels[position])],
                "authority": authority,
                "family_correct": bool(predicted_family[position] == labels[position]),
                "family_probabilities": {
                    trainer.FAMILY_VALUES[index]: float(
                        family_probabilities[position, index]
                    )
                    for index in range(len(trainer.FAMILY_VALUES))
                },
                "font_supervision_weight": float(
                    arrays["font_supervision_weights"][source_index]
                ),
                "human_gold": False,
                "oracle_family_acceptable_hit": bool(
                    positives[position, oracle_index]
                ),
                "oracle_family_preferred_hit": bool(
                    preferred[position, oracle_index]
                ),
                "predicted_family": trainer.FAMILY_VALUES[
                    int(predicted_family[position])
                ],
                "predicted_font_id": candidate_ids[predicted_index],
                "predicted_inside_reviewed_five": bool(
                    eligible[position, predicted_index]
                ),
                "preferred_font_id": mask_preferred[0],
                "preferred_hit": bool(preferred[position, predicted_index]),
                "record_type": "manga_font_v8_role_family_visual_holdout_row",
                "reporting_role": role.role,
                "reporting_role_authority": (
                    "source_category_representative_not_human_role_label"
                ),
                "reviewed_font_ids": list(mask_eligible),
                "sample_id": sample_id,
                "schema_version": SCHEMA,
                "single_day_body_false_top1": bool(
                    single_negative[position] and predicted_index == single_day_index
                ),
                "single_day_body_negative": bool(single_negative[position]),
                "single_day_eligible": bool(
                    routed["single_day_allowed"][position]
                ),
                "single_day_positive": bool(
                    positives[position, single_day_index]
                ),
                "single_day_predicted": bool(predicted_index == single_day_index),
                "single_day_raw_margin": float(routed["raw_margin"][position]),
                "single_day_raw_predicted": bool(
                    int(routed["raw_scores"][position].argmax())
                    == single_day_index
                ),
                "split": "val",
                "top5": [
                    {
                        "candidate_id": candidate_ids[int(index)],
                        "score": float(predicted_scores[position, index]),
                    }
                    for index in ranking.tolist()
                ],
                "training_eligible": False,
                "work_id": str(work_ids[source_index]),
            }
        )
        rows.append(row)
    return rows


def evaluate(
    *,
    dataset_npz: Path,
    adapter_dir: Path,
    output_dir: Path,
    device: str = "cuda",
    batch_size: int = 256,
    replace_owned_output: bool = False,
) -> Mapping[str, Any]:
    if batch_size <= 0:
        raise MangaFontV8EvaluationError("batch size must be positive")
    dataset_path, arrays, dataset_manifest, inventory = _load_dataset(dataset_npz)
    dataset_sha256 = _sha256_file(dataset_path)
    profile = _evaluation_profile(
        dataset_manifest=dataset_manifest, dataset_sha256=dataset_sha256
    )
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    split = arrays["split"].astype(np.int64, copy=False)
    authorities = arrays["font_authority"].astype(str)
    font_weights = arrays["font_supervision_weights"].astype(np.float32, copy=False)
    all_val_indices = np.flatnonzero(split == 1)
    indices = np.flatnonzero((split == 1) & (authorities == "visual") & (font_weights > 0))
    train_works = set(arrays["work_ids"].astype(str)[split == 0].tolist())
    eval_works = set(arrays["work_ids"].astype(str)[all_val_indices].tolist())
    counts = _mapping(dataset_manifest.get("counts"), "dataset counts")
    expected_visual_rows = profile["expected_visual_rows"]
    if expected_visual_rows is None:
        expected_visual_rows = int(counts.get("val_visual_completed_rows", -1))
    if (
        indices.size < MIN_SUPERVISED_ROWS
        or int(expected_visual_rows) != int(indices.size)
        or len(eval_works) != int(profile["expected_val_works"])
        or (
            profile["expected_val_rows"] is not None
            and all_val_indices.size != int(profile["expected_val_rows"])
        )
        or train_works & eval_works
        or any(authorities[index] != "visual" for index in indices.tolist())
    ):
        raise MangaFontV8EvaluationError(
            "visual holdout requires >=400 completed visual rows, the sealed val "
            "work/row profile, and zero train-work overlap"
        )
    sample_ids = frozenset(arrays["sample_ids"].astype(str)[indices].tolist())
    roles, pass_binding = _load_reporting_roles(
        dataset_manifest=dataset_manifest, sample_ids=sample_ids
    )
    visual_labels, visual_binding = _load_visual_authority(
        dataset_manifest=dataset_manifest,
        required_sample_ids=sample_ids,
        authority=str(profile["authority"]),
    )
    torch, model, adapter = _load_adapter(
        adapter_dir,
        candidate_ids=candidate_ids,
        dataset_sha256=dataset_sha256,
        device_name=device,
    )
    all_val_outputs = _infer(
        torch=torch,
        model=model,
        query_views=arrays["query_views"][all_val_indices],
        prototype_queries=arrays["prototype_queries"],
        device_name=device,
        batch_size=batch_size,
    )
    visual_positions = np.flatnonzero(
        (authorities[all_val_indices] == "visual")
        & (font_weights[all_val_indices] > 0)
    )
    if not np.array_equal(all_val_indices[visual_positions], indices):
        raise MangaFontV8EvaluationError("visual/all-val index projection drifted")
    outputs = {
        name: values[visual_positions]
        for name, values in all_val_outputs.items()
    }
    rows = _build_rows(
        arrays=arrays,
        indices=indices,
        outputs=outputs,
        roles=roles,
        visual_labels=visual_labels,
        authority=str(profile["authority"]),
    )
    routing_rows = _build_routing_rows(
        arrays=arrays,
        indices=all_val_indices,
        outputs=all_val_outputs,
    )
    metrics = _metrics(rows, _routing_metrics(routing_rows))
    confusion = _confusion(rows)
    gate = _quality_gate(metrics)
    identity_sha = _sha256_bytes(
        "".join(
            f"{row['sample_id']}\0{row['work_id']}\n" for row in rows
        ).encode("utf-8")
    )
    output = _safe_output(output_dir)
    if output.exists():
        marker_path = output / MARKER_FILE
        old = _read_json(marker_path, "existing evaluation marker") if marker_path.is_file() else {}
        if (
            not replace_owned_output
            or old.get("owner") != OWNER
            or old.get("safe_replace") is not True
        ):
            raise MangaFontV8EvaluationError("refusing to replace evaluation output")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        rows_path = staging / ROWS_FILE
        with rows_path.open("wb") as handle:
            for row in rows:
                handle.write(_json_bytes(row))
        routing_path = staging / ROUTING_ROWS_FILE
        with routing_path.open("wb") as handle:
            for row in routing_rows:
                handle.write(_json_bytes(row))
        bindings = {
            "adapter_checkpoint_sha256": adapter["checkpoint_sha256"],
            "adapter_manifest_sha256": adapter["manifest_sha256"],
            "candidate_order_sha256": package.attach._ordered_values_sha256(  # noqa: SLF001
                candidate_ids
            ),
            "dataset_manifest_sha256": _sha256_file(
                dataset_path.parent / dataset.MANIFEST_FILE
            ),
            "dataset_npz_sha256": dataset_sha256,
        }
        dataset_lineage = _dataset_lineage_record(
            profile=profile,
            inventory=inventory,
            bindings=bindings,
        )
        boundary = _boundary_record(
            row_count=len(rows),
            routing_row_count=len(routing_rows),
            work_count=len(eval_works),
        )
        authority = _authority_record(str(profile["authority"]))
        manifest = _seal(
            {
                "authority": authority,
                "bindings": bindings,
                "boundary": boundary,
                "candidate_ids": list(candidate_ids),
                "dataset_lineage": dataset_lineage,
                "dataset_inventory": dict(inventory),
                "evaluation_profile": dict(profile),
                "record_type": "manga_font_v8_role_family_visual_holdout_manifest",
                "routing_row_count": len(routing_rows),
                "row_count": len(rows),
                "sample_work_order_sha256": identity_sha,
                "schema_version": SCHEMA,
                "source_code_sha256": _sha256_file(Path(__file__).resolve()),
                "source_validation": {
                    "pass_report_sha256": pass_binding["report_sha256"],
                    "pass_review_sha256": pass_binding["review_sha256"],
                    "visual_manifest_sha256": visual_binding["manifest_sha256"],
                    "visual_report_sha256": visual_binding["report_sha256"],
                },
                "training_quality_gate_passed": adapter[
                    "training_quality_gate_passed"
                ],
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(_json_bytes(manifest, pretty=True))
        report = _seal(
            {
                "artifacts": {
                    MANIFEST_FILE: _descriptor(manifest_path),
                    ROWS_FILE: _descriptor(rows_path, row_count=len(rows)),
                    ROUTING_ROWS_FILE: _descriptor(
                        routing_path, row_count=len(routing_rows)
                    ),
                },
                "authority": authority,
                "bindings": bindings,
                "boundary": boundary,
                "candidate_ids": list(candidate_ids),
                "confusion": confusion,
                "dataset_lineage": dataset_lineage,
                "evaluated_positive_rows": len(rows),
                "manifest_record_sha256": manifest["record_sha256"],
                "metrics": metrics,
                "quality_gate": gate,
                "record_type": package.VISUAL_HOLDOUT_EVALUATION_RECORD,
                "sample_work_order_sha256": identity_sha,
                "schema_version": package.VISUAL_HOLDOUT_EVALUATION_SCHEMA,
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(_json_bytes(report, pretty=True))
        marker = _seal(
            {
                "artifacts": {
                    name: _sha256_file(staging / name)
                    for name in (
                        MANIFEST_FILE,
                        REPORT_FILE,
                        ROWS_FILE,
                        ROUTING_ROWS_FILE,
                    )
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(_json_bytes(marker, pretty=True))
        validate_output(staging)
        if output.exists():
            shutil.rmtree(output)
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != OUTPUT_FILES
        or any(path.is_symlink() or not path.is_file() for path in root.iterdir())
    ):
        raise MangaFontV8EvaluationError("evaluation exact inventory drifted")
    marker = _read_json(root / MARKER_FILE, "evaluation marker")
    manifest = _read_json(root / MANIFEST_FILE, "evaluation manifest")
    report = _read_json(root / REPORT_FILE, "evaluation report")
    for location, record in (
        ("evaluation marker", marker),
        ("evaluation manifest", manifest),
        ("evaluation report", report),
    ):
        _validate_seal(record, location)
    artifacts = _mapping(marker.get("artifacts"), "evaluation marker artifacts")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or set(artifacts)
        != {MANIFEST_FILE, REPORT_FILE, ROWS_FILE, ROUTING_ROWS_FILE}
        or any(artifacts.get(name) != _sha256_file(root / name) for name in artifacts)
        or manifest.get("schema_version") != SCHEMA
        or manifest.get("record_type")
        != "manga_font_v8_role_family_visual_holdout_manifest"
        or report.get("schema_version")
        != package.VISUAL_HOLDOUT_EVALUATION_SCHEMA
        or report.get("record_type") != package.VISUAL_HOLDOUT_EVALUATION_RECORD
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or manifest.get("source_code_sha256") != _sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV8EvaluationError("evaluation identity/schema drifted")
    declared_authority = _mapping(report.get("authority"), "evaluation authority")
    authority_name = _text(
        declared_authority.get("authority"), "evaluation authority name"
    )
    authority = _authority_record(authority_name)
    if (
        dict(_mapping(report.get("authority"), "evaluation authority"))
        != authority
        or dict(_mapping(manifest.get("authority"), "manifest authority"))
        != authority
    ):
        raise MangaFontV8EvaluationError("evaluation authority was upgraded or drifted")
    bindings = dict(_mapping(report.get("bindings"), "evaluation bindings"))
    boundary = dict(_mapping(report.get("boundary"), "evaluation boundary"))
    if (
        bindings
        != dict(_mapping(manifest.get("bindings"), "manifest bindings"))
        or boundary
        != dict(_mapping(manifest.get("boundary"), "manifest boundary"))
    ):
        raise MangaFontV8EvaluationError("manifest/report boundary binding drifted")
    expected_binding_names = {
        "adapter_checkpoint_sha256",
        "adapter_manifest_sha256",
        "candidate_order_sha256",
        "dataset_manifest_sha256",
        "dataset_npz_sha256",
    }
    if set(bindings) != expected_binding_names:
        raise MangaFontV8EvaluationError("evaluation binding schema drifted")
    for name in expected_binding_names:
        _sha(bindings.get(name), f"evaluation bindings.{name}")
    evaluation_profile = _mapping(
        manifest.get("evaluation_profile"), "evaluation profile"
    )
    dataset_inventory = _mapping(
        manifest.get("dataset_inventory"), "evaluation dataset inventory"
    )
    expected_dataset_lineage = _dataset_lineage_record(
        profile=evaluation_profile,
        inventory=dataset_inventory,
        bindings=bindings,
    )
    if (
        dict(
            _mapping(manifest.get("dataset_lineage"), "manifest dataset lineage")
        )
        != expected_dataset_lineage
        or dict(_mapping(report.get("dataset_lineage"), "report dataset lineage"))
        != expected_dataset_lineage
    ):
        raise MangaFontV8EvaluationError("evaluation dataset lineage drifted")
    if authority_name == package.ADAPTER_SELECTION_AUTHORITY and (
        evaluation_profile.get("profile")
        != "r3_body_holdout_checkpoint_selection"
        or evaluation_profile.get("base_dataset_npz_sha256")
        != R3_DATASET_SHA256
        or evaluation_profile.get("dataset_npz_sha256")
        != bindings.get("dataset_npz_sha256")
        or evaluation_profile.get("expected_visual_rows") != R3_VISUAL_ROWS
        or evaluation_profile.get("expected_val_rows") != R3_VAL_ROWS
        or evaluation_profile.get("expected_val_works") != R3_VAL_WORKS
    ):
        raise MangaFontV8EvaluationError("r3 authority dataset lineage drifted")
    rows = list(_iter_jsonl(root / ROWS_FILE, "evaluation rows"))
    if len(rows) < MIN_SUPERVISED_ROWS or len(rows) != report.get(
        "evaluated_positive_rows"
    ):
        raise MangaFontV8EvaluationError("evaluation supervised row floor failed")
    seen: set[str] = set()
    works: set[str] = set()
    for index, row in enumerate(rows):
        _validate_seal(row, f"evaluation row {index}")
        sample_id = _text(row.get("sample_id"), "evaluation sample_id")
        if sample_id in seen:
            raise MangaFontV8EvaluationError("evaluation sample identity duplicated")
        seen.add(sample_id)
        works.add(_text(row.get("work_id"), "evaluation work_id"))
        if (
            row.get("authority") != authority_name
            or row.get("human_gold") is not False
            or row.get("record_type")
            != "manga_font_v8_role_family_visual_holdout_row"
            or row.get("reporting_role_authority")
            != "source_category_representative_not_human_role_label"
            or row.get("schema_version") != SCHEMA
            or row.get("training_eligible") is not False
            or row.get("split") != "val"
        ):
            raise MangaFontV8EvaluationError("evaluation row authority drifted")
    routing_rows = list(
        _iter_jsonl(root / ROUTING_ROWS_FILE, "routing audit rows")
    )
    routing_seen: set[str] = set()
    routing_works: set[str] = set()
    for index, row in enumerate(routing_rows):
        _validate_seal(row, f"routing audit row {index}")
        sample_id = _text(row.get("sample_id"), "routing sample_id")
        if sample_id in routing_seen:
            raise MangaFontV8EvaluationError("routing sample identity duplicated")
        routing_seen.add(sample_id)
        routing_works.add(_text(row.get("work_id"), "routing work_id"))
        if (
            row.get("authority")
            != "pixel_only_checkpoint_selection_routing_audit"
            or row.get("record_type")
            != "manga_font_v8_role_family_routing_audit_row"
            or row.get("schema_version") != SCHEMA
            or row.get("predicted_family") not in trainer.FAMILY_VALUES
            or not isinstance(row.get("single_day_allowed"), bool)
            or not isinstance(row.get("single_day_deployed_top1"), bool)
            or not isinstance(row.get("single_day_raw_top1"), bool)
            or row.get("training_eligible") is not False
            or row.get("split") != "val"
        ):
            raise MangaFontV8EvaluationError("routing audit authority drifted")
        if (
            row.get("predicted_family") == "body"
            and row.get("single_day_allowed") is not False
        ) or (
            row.get("single_day_deployed_top1") is True
            and row.get("single_day_allowed") is not True
        ):
            raise MangaFontV8EvaluationError("routing audit eligibility drifted")
    expected_work_count = (
        R3_VAL_WORKS
        if authority_name == package.ADAPTER_SELECTION_AUTHORITY
        else 4
    )
    required_boundary = _boundary_record(
        row_count=len(rows),
        routing_row_count=len(routing_rows),
        work_count=expected_work_count,
    )
    expected_routing_rows = (
        R3_VAL_ROWS
        if authority_name == package.ADAPTER_SELECTION_AUTHORITY
        else int(boundary.get("pixel_routing_audit_rows", -1))
    )
    if (
        len(routing_rows) != expected_routing_rows
        or len(routing_works) != expected_work_count
        or not works <= routing_works
        or boundary != required_boundary
        or manifest.get("routing_row_count") != len(routing_rows)
    ):
        raise MangaFontV8EvaluationError("evaluation work/routing count drifted")
    candidate_ids = tuple(
        _text(value, f"evaluation candidate_ids[{index}]")
        for index, value in enumerate(
            _list(report.get("candidate_ids"), "evaluation candidate_ids")
        )
    )
    if (
        len(candidate_ids) != 21
        or len(set(candidate_ids)) != len(candidate_ids)
        or "single-day" not in candidate_ids
        or tuple(manifest.get("candidate_ids", ())) != candidate_ids
        or bindings.get("candidate_order_sha256")
        != package.attach._ordered_values_sha256(candidate_ids)  # noqa: SLF001
        or report.get("sample_work_order_sha256")
        != manifest.get("sample_work_order_sha256")
        or report.get("sample_work_order_sha256")
        != _sha256_bytes(
            "".join(
                f"{row['sample_id']}\0{row['work_id']}\n" for row in rows
            ).encode("utf-8")
        )
        or manifest.get("row_count") != len(rows)
    ):
        raise MangaFontV8EvaluationError("evaluation candidate/identity binding drifted")
    candidate_set = set(candidate_ids)
    for index, row in enumerate(rows):
        acceptable = tuple(
            _text(value, f"evaluation row {index}.acceptable_font_ids")
            for value in _list(
                row.get("acceptable_font_ids"),
                f"evaluation row {index}.acceptable_font_ids",
            )
        )
        reviewed = tuple(
            _text(value, f"evaluation row {index}.reviewed_font_ids")
            for value in _list(
                row.get("reviewed_font_ids"),
                f"evaluation row {index}.reviewed_font_ids",
            )
        )
        predicted = _text(
            row.get("predicted_font_id"),
            f"evaluation row {index}.predicted_font_id",
        )
        preferred = _text(
            row.get("preferred_font_id"),
            f"evaluation row {index}.preferred_font_id",
        )
        if (
            not set(acceptable) <= candidate_set
            or not set(reviewed) <= candidate_set
            or predicted not in candidate_set
            or preferred not in candidate_set
            or row.get("actual_family") not in trainer.FAMILY_VALUES
            or row.get("predicted_family") not in trainer.FAMILY_VALUES
            or row.get("single_day_positive")
            is not ("single-day" in acceptable)
            or row.get("single_day_predicted") is not (predicted == "single-day")
            or (
                row.get("single_day_predicted") is True
                and row.get("single_day_eligible") is not True
            )
        ):
            raise MangaFontV8EvaluationError(
                f"evaluation row {index} evidence drifted"
            )
    recomputed_metrics = _metrics(rows, _routing_metrics(routing_rows))
    recomputed_confusion = _confusion(rows)
    if (
        _canonical_json(recomputed_metrics) != _canonical_json(report.get("metrics"))
        or _canonical_json(recomputed_confusion)
        != _canonical_json(report.get("confusion"))
        or _canonical_json(_quality_gate(recomputed_metrics))
        != _canonical_json(report.get("quality_gate"))
    ):
        raise MangaFontV8EvaluationError("evaluation metrics/confusion drifted")
    report_artifacts = _mapping(report.get("artifacts"), "report artifacts")
    if set(report_artifacts) != {MANIFEST_FILE, ROWS_FILE, ROUTING_ROWS_FILE}:
        raise MangaFontV8EvaluationError("evaluation report inventory drifted")
    for name in (MANIFEST_FILE, ROWS_FILE, ROUTING_ROWS_FILE):
        descriptor = _mapping(report_artifacts.get(name), f"report artifact {name}")
        row_count = (
            len(rows)
            if name == ROWS_FILE
            else len(routing_rows)
            if name == ROUTING_ROWS_FILE
            else None
        )
        actual = _descriptor(root / name, row_count=row_count)
        if dict(descriptor) != actual:
            raise MangaFontV8EvaluationError(f"evaluation descriptor drifted: {name}")
    return {
        "acceptable_at1": recomputed_metrics["acceptable_at1"],
        "authority": authority_name,
        "family_accuracy": recomputed_metrics["family_accuracy"],
        "human_gold": False,
        "output_dir": str(root),
        "preferred_at1": recomputed_metrics["preferred_at1"],
        "quality_gate_passed": bool(report["quality_gate"]["passed"]),
        "rows": len(rows),
        "single_day_body_false_top1_rate": recomputed_metrics[
            "single_day_body_false_top1_rate"
        ],
        "single_day_all_top1_rate": recomputed_metrics[
            "single_day_all_top1_rate"
        ],
        "status": "validated_checkpoint_selection_only_not_release_authority",
        "work_count": len(routing_works),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    evaluate_command = commands.add_parser("evaluate")
    evaluate_command.add_argument("--dataset-npz", type=Path, required=True)
    evaluate_command.add_argument("--adapter-dir", type=Path, required=True)
    evaluate_command.add_argument("--output-dir", type=Path, required=True)
    evaluate_command.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    evaluate_command.add_argument("--batch-size", type=int, default=256)
    evaluate_command.add_argument("--replace-owned-output", action="store_true")
    validate_command = commands.add_parser("validate")
    validate_command.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "evaluate":
            result = evaluate(
                dataset_npz=args.dataset_npz,
                adapter_dir=args.adapter_dir,
                output_dir=args.output_dir,
                device=args.device,
                batch_size=args.batch_size,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_output(args.output_dir)
    except (
        MangaFontV8EvaluationError,
        dataset.V8RoleFamilyDatasetError,
        trainer.MangaFontV8RoleFamilyError,
    ) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
