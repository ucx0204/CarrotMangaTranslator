#!/usr/bin/env python3
"""Bind pseudo-refinement r2 to the v8 adapter as train-only soft evidence.

The bundle is intentionally separate from the sealed role/family dataset.  It
never changes reviewed masks, validation labels, or split assignment.  Rows
with human/agent/visual authority receive zero pseudo weight; only optimizer
train rows whose dataset authority is ``none`` may contribute a low-weight
soft target.  Single Day hard negatives and credible specialist positives are
recorded explicitly for the distillation trainer.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import augment_manga_font_student_v8_with_high_value_labels as overlay
    from scripts import refine_manga_font_v2_pseudo_labels as refinement
    from scripts import refine_manga_font_v2_pseudo_labels_r2 as r2
except ImportError:  # pragma: no cover - direct execution from scripts/
    import augment_manga_font_student_v8_with_high_value_labels as overlay
    import refine_manga_font_v2_pseudo_labels as refinement
    import refine_manga_font_v2_pseudo_labels_r2 as r2


SCHEMA = "manga-font-v8-r2-distillation-bundle-v1"
OWNER = "carrot-manga-translator/manga-font-v8-r2-distillation-bundle-v1"
MARKER_FILE = ".manga-font-v8-r2-distillation-bundle-owned.json"
TARGET_FILE = "distillation-targets.npz"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset({MARKER_FILE, TARGET_FILE, MANIFEST_FILE, REPORT_FILE})
REQUIRED_ARRAYS = frozenset(
    {
        "candidate_ids",
        "distillation_weights",
        "r2_source_present",
        "sample_ids",
        "single_day_negative",
        "specialist_single_day_positive",
        "target_probabilities",
    }
)
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
CATEGORY_WEIGHT: Mapping[str, float] = {
    "ordinary": 0.45,
    "bubble_edge": 0.70,
    "text_free": 1.00,
    "page_sound": 1.00,
    "ocr_hard": 0.90,
    "ocr_anime_region": 0.90,
    "font_signal_present": 1.00,
}


class R2DistillationBundleError(ValueError):
    """Raised when pseudo targets cross a reviewed or held-out boundary."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result.pop("record_sha256", None)
    result["record_sha256"] = hashlib.sha256(
        canonical_json(result).encode("utf-8")
    ).hexdigest()
    return result


def validate_record_seal(value: Mapping[str, Any], location: str) -> None:
    expected = value.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise R2DistillationBundleError(f"{location}: invalid record seal")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if hashlib.sha256(canonical_json(core).encode("utf-8")).hexdigest() != expected:
        raise R2DistillationBundleError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise R2DistillationBundleError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise R2DistillationBundleError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise R2DistillationBundleError(f"{location}: missing regular file")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise R2DistillationBundleError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = int(row_count)
    return result


def _safe_new_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise R2DistillationBundleError(f"unsafe output directory: {result}")
    if result.exists():
        raise R2DistillationBundleError("output directory already exists")
    result.parent.mkdir(parents=True, exist_ok=True)
    return result


def _load_npz(path: Path) -> dict[str, np.ndarray]:
    with np.load(path.expanduser().resolve(), allow_pickle=False) as source:
        return {name: np.array(source[name], copy=True) for name in source.files}


def build_target_arrays(
    dataset_arrays: Mapping[str, np.ndarray],
    pseudo_rows: Mapping[str, Mapping[str, Any]],
    inference_arrays: Mapping[str, np.ndarray],
) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    candidate_ids = tuple(str(value) for value in dataset_arrays["candidate_ids"].tolist())
    sample_ids = tuple(str(value) for value in dataset_arrays["sample_ids"].tolist())
    count = len(sample_ids)
    candidate_count = len(candidate_ids)
    if len(set(sample_ids)) != count or candidate_count < 2 or "single-day" not in candidate_ids:
        raise R2DistillationBundleError("dataset sample/candidate inventory drifted")
    inference_ids = tuple(str(value) for value in inference_arrays["sample_ids"].tolist())
    inference_index = {value: index for index, value in enumerate(inference_ids)}
    if len(inference_index) != len(inference_ids) or not set(sample_ids) <= inference_index.keys():
        raise R2DistillationBundleError("inference identity coverage drifted")

    targets = np.full((count, candidate_count), 1.0 / candidate_count, dtype=np.float32)
    weights = np.zeros(count, dtype=np.float32)
    source_present = np.zeros(count, dtype=np.bool_)
    single_day_negative = np.zeros(count, dtype=np.bool_)
    specialist_positive = np.zeros(count, dtype=np.bool_)
    split = dataset_arrays["split"].astype(np.int64, copy=False)
    authority = np.asarray([str(value) for value in dataset_arrays["font_authority"].tolist()])
    sd_index = candidate_ids.index("single-day")
    counts: Counter[str] = Counter()
    weight_by_category: Counter[str] = Counter()
    source_weight_total = 0.0
    protected_source_ids: set[str] = set()

    for position, sample_id in enumerate(sample_ids):
        source = pseudo_rows.get(sample_id)
        if source is None:
            continue
        source_present[position] = True
        probabilities = np.asarray(source.get("probabilities", ()), dtype=np.float64)
        if (
            probabilities.shape != (candidate_count,)
            or tuple(source.get("candidate_ids", ())) != candidate_ids
            or not np.isfinite(probabilities).all()
            or np.any(probabilities < 0.0)
            or not np.isclose(probabilities.sum(), 1.0, atol=2e-6)
        ):
            raise R2DistillationBundleError(f"{sample_id}: pseudo target drifted")
        targets[position] = probabilities.astype(np.float32)
        inference_position = inference_index[sample_id]
        category = str(inference_arrays["source_categories"][inference_position])
        role = str(inference_arrays["roles"][inference_position])
        if source.get("source_category") != category:
            raise R2DistillationBundleError(f"{sample_id}: category binding drifted")
        if authority[position] != "none":
            protected_source_ids.add(sample_id)
            counts[f"protected_{authority[position]}"] += 1
            continue
        if split[position] != 0:
            counts["heldout_pseudo_zero_weight"] += 1
            continue
        category_multiplier = CATEGORY_WEIGHT.get(category)
        if category_multiplier is None:
            raise R2DistillationBundleError(f"unsupported category: {category}")
        source_weight = float(source.get("weight", 0.0))
        if not 0.0 < source_weight <= 1.0:
            raise R2DistillationBundleError(f"{sample_id}: pseudo weight drifted")
        weight = source_weight * category_multiplier
        weights[position] = weight
        source_weight_total += weight
        weight_by_category[category] += weight
        counts[f"optimizer_{category}"] += 1
        hard_negative = role in BODY_ROLES or category in {"ordinary", "bubble_edge"}
        if hard_negative:
            if int(probabilities.argmax()) == sd_index:
                raise R2DistillationBundleError(
                    f"{sample_id}: unreviewed hard-negative target selected Single Day"
                )
            single_day_negative[position] = True
        elif int(probabilities.argmax()) == sd_index:
            specialist_positive[position] = True

    optimizer = weights > 0.0
    if (
        np.any(optimizer & (split != 0))
        or np.any(optimizer & (authority != "none"))
        or np.any(single_day_negative & ~optimizer)
        or np.any(specialist_positive & ~optimizer)
        or np.any(single_day_negative & specialist_positive)
        or not np.allclose(targets.sum(axis=1), 1.0, atol=2e-6)
    ):
        raise R2DistillationBundleError("distillation authority/mask boundary drifted")
    result = {
        "candidate_ids": np.asarray(candidate_ids, dtype="<U32"),
        "distillation_weights": weights,
        "r2_source_present": source_present,
        "sample_ids": np.asarray(sample_ids, dtype="<U40"),
        "single_day_negative": single_day_negative,
        "specialist_single_day_positive": specialist_positive,
        "target_probabilities": targets,
    }
    summary = {
        "authority_counts": dict(counts),
        "candidate_ids": list(candidate_ids),
        "distillation_effective_weight_sum": source_weight_total,
        "distillation_rows": int(optimizer.sum()),
        "distillation_weight_by_category": {
            key: float(value) for key, value in sorted(weight_by_category.items())
        },
        "heldout_or_reviewed_weight_nonzero": int(
            np.sum(optimizer & ((split != 0) | (authority != "none")))
        ),
        "protected_r2_source_rows": len(protected_source_ids),
        "r2_source_rows": int(source_present.sum()),
        "single_day_negative_rows": int(single_day_negative.sum()),
        "specialist_single_day_positive_rows": int(specialist_positive.sum()),
    }
    return result, summary


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != OUTPUT_FILES
    ):
        raise R2DistillationBundleError("bundle exact inventory drifted")
    marker = _read_json(root / MARKER_FILE, "marker")
    manifest = _read_json(root / MANIFEST_FILE, "manifest")
    report = _read_json(root / REPORT_FILE, "report")
    for location, value in (("marker", marker), ("manifest", manifest), ("report", report)):
        validate_record_seal(value, location)
    artifacts = _mapping(marker.get("artifacts"), "marker artifacts")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or artifacts.get(TARGET_FILE) != sha256_file(root / TARGET_FILE)
        or artifacts.get(MANIFEST_FILE) != sha256_file(root / MANIFEST_FILE)
        or artifacts.get(REPORT_FILE) != sha256_file(root / REPORT_FILE)
    ):
        raise R2DistillationBundleError("bundle metadata/hash drifted")
    with np.load(root / TARGET_FILE, allow_pickle=False) as source:
        if set(source.files) != REQUIRED_ARRAYS:
            raise R2DistillationBundleError("bundle array inventory drifted")
        candidate_ids = source["candidate_ids"]
        sample_ids = source["sample_ids"]
        targets = source["target_probabilities"]
        weights = source["distillation_weights"]
        negative = source["single_day_negative"].astype(bool)
        positive = source["specialist_single_day_positive"].astype(bool)
        if (
            candidate_ids.shape != (21,)
            or sample_ids.ndim != 1
            or len(set(str(value) for value in sample_ids.tolist())) != len(sample_ids)
            or targets.shape != (len(sample_ids), 21)
            or weights.shape != (len(sample_ids),)
            or not np.isfinite(targets).all()
            or not np.isfinite(weights).all()
            or np.any(targets < 0.0)
            or np.any(weights < 0.0)
            or not np.allclose(targets.sum(axis=1), 1.0, atol=2e-6)
            or np.any((negative | positive) & (weights <= 0.0))
            or np.any(negative & positive)
        ):
            raise R2DistillationBundleError("bundle tensor contract drifted")
        row_count = len(sample_ids)
        distillation_rows = int(np.sum(weights > 0.0))
    descriptor = _mapping(manifest.get("targets"), "target descriptor")
    if descriptor != _descriptor(root / TARGET_FILE, row_count=row_count):
        raise R2DistillationBundleError("target descriptor drifted")
    counts = _mapping(manifest.get("counts"), "manifest counts")
    if (
        counts.get("row_count") != row_count
        or counts.get("distillation_rows") != distillation_rows
        or counts.get("heldout_or_reviewed_weight_nonzero") != 0
    ):
        raise R2DistillationBundleError("bundle counts/authority drifted")
    return {
        "distillation_rows": distillation_rows,
        "output_dir": str(root),
        "row_count": row_count,
        "status": "validated_train_only_low_authority_r2_distillation_bundle",
    }


def build_output(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_new_output(args.output_dir)
    dataset_root = args.dataset_dir.expanduser().resolve()
    r2_root = args.refined_r2_dir.expanduser().resolve()
    inference_root = args.inference_dir.expanduser().resolve()
    dataset_validation = overlay.validate_output(dataset_root)
    refinement_validation = refinement.validate_output(r2_root)
    inference_validation = r2.validate_inference_output(inference_root)
    dataset_arrays = _load_npz(dataset_root / overlay.DATASET_FILE)
    inference_arrays, _ = r2._load_inference_arrays(inference_root)  # noqa: SLF001
    pseudo_rows = {
        str(row["sample_id"]): row
        for row in _iter_jsonl(r2_root / refinement.PSEUDO_FILE, "r2 pseudo")
    }
    if len(pseudo_rows) != r2.EXPECTED_PSEUDO_ROWS:
        raise R2DistillationBundleError("r2 pseudo identity count drifted")
    arrays, summary = build_target_arrays(dataset_arrays, pseudo_rows, inference_arrays)
    if summary["protected_r2_source_rows"] != 2_763:
        raise R2DistillationBundleError("reviewed r2 protection count drifted")

    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        np.savez_compressed(staging / TARGET_FILE, **arrays)
        manifest = seal_record(
            {
                "authority": {
                    "automatic_promotion": False,
                    "evaluation_authority": False,
                    "label_authority": "pseudo_soft_not_gold",
                    "reviewed_rows_overwritten": 0,
                    "training_only": True,
                    "validation_selection_authority": False,
                },
                "category_weight_multipliers": dict(CATEGORY_WEIGHT),
                "counts": {
                    **dict(summary),
                    "row_count": len(arrays["sample_ids"]),
                },
                "record_type": "manga_font_v8_r2_distillation_bundle_manifest",
                "schema_version": SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
                "sources": {
                    "dataset": {
                        "manifest_sha256": sha256_file(dataset_root / overlay.MANIFEST_FILE),
                        "npz_sha256": sha256_file(dataset_root / overlay.DATASET_FILE),
                        "validation": dict(dataset_validation),
                    },
                    "inference": {
                        "archive_sha256": sha256_file(inference_root / r2.INFERENCE_ARCHIVE),
                        "manifest_sha256": sha256_file(inference_root / r2.INFERENCE_MANIFEST),
                        "validation": dict(inference_validation),
                    },
                    "refined_r2": {
                        "manifest_sha256": sha256_file(r2_root / refinement.MANIFEST_FILE),
                        "pseudo_sha256": sha256_file(r2_root / refinement.PSEUDO_FILE),
                        "validation": dict(refinement_validation),
                    },
                },
                "targets": _descriptor(staging / TARGET_FILE, row_count=len(arrays["sample_ids"])),
            }
        )
        (staging / MANIFEST_FILE).write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "candidate_ids": summary["candidate_ids"],
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_v8_r2_distillation_bundle_report",
                "schema_version": SCHEMA,
                "summary": dict(summary),
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    TARGET_FILE: sha256_file(staging / TARGET_FILE),
                    MANIFEST_FILE: sha256_file(staging / MANIFEST_FILE),
                    REPORT_FILE: sha256_file(staging / REPORT_FILE),
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
        return validate_output(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument(
        "--dataset-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v8-role-family-dataset-r7-high-value-"
            "agent-001-800-training-only-r1"
        ),
    )
    build.add_argument(
        "--refined-r2-dir",
        type=Path,
        default=Path("artifacts/manga-font-v2-pseudo-refinement-r2-r7a35-20260811-r1"),
    )
    build.add_argument(
        "--inference-dir",
        type=Path,
        default=Path("artifacts/manga-font-v2-r7a35-master-v3-all-inference-20260811-r1"),
    )
    build.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build_output(args) if args.command == "build" else validate_output(args.output_dir)
    except (R2DistillationBundleError, OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
