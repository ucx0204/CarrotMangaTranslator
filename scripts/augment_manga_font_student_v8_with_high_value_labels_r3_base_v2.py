#!/usr/bin/env python3
"""Build the immutable r3-base NPZ overlay from sealed 001..1600 labels.

The base dataset remains immutable.  Sealed train-only labels take precedence
over any existing train label for the same identity and are encoded as the
trainer's ``human`` authority class.  Validation rows are fail-closed.
Body-role Single Day positives are removed according to the production
eligibility policy and retained as explicit reviewed negatives.  This version
accepts only the range-v6 001..1600 cumulative contract and the byte-identified
r3 body-holdout base; it does not train or evaluate a model.
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
    from scripts import build_manga_font_student_v8_role_family_dataset as base_dataset
    from scripts import seal_manga_font_v2_high_value_supervised_labels as labels_artifact
    from scripts import seal_manga_font_v2_high_value_supervised_labels_range_v6 as labels_v6
    from scripts import train_manga_font_student_v8_role_family_adapter as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_student_v8_role_family_dataset as base_dataset
    import seal_manga_font_v2_high_value_supervised_labels as labels_artifact
    import seal_manga_font_v2_high_value_supervised_labels_range_v6 as labels_v6
    import train_manga_font_student_v8_role_family_adapter as trainer


SCHEMA = "manga-font-student-v8-high-value-overlay-r3-base-v2"
OWNER = "carrot-manga-translator/manga-font-student-v8-high-value-overlay-r3-base-v2"
MARKER_FILE = ".manga-font-student-v8-high-value-overlay-r3-base-v2-owned.json"
DATASET_FILE = "role-family-dataset.npz"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset({MARKER_FILE, DATASET_FILE, MANIFEST_FILE, REPORT_FILE})
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
EXPECTED_LABEL_SPAN = [1, 1600]
EXPECTED_LABEL_ROWS = 1347
EXPECTED_PREFIX_ROWS = 1036
EXPECTED_PREFIX_BYTE_SIZE = 1792860
EXPECTED_PREFIX_SHA256 = "0596b37b3cc616f339dac5946c71c0fd9624d8217e69a01c29ce7505fedac9e4"
EXPECTED_R3_BASE_MANIFEST_SHA256 = "89968a01215fdb29f14d70a86c89e2a2866b810867f979919dfd94fe64424c20"
EXPECTED_R3_BASE_NPZ_SHA256 = "901ee8a0f6e72d42ee917a6827bc76009245ebeda0c479e9e02feb4238107f83"


class HighValueDatasetOverlayError(ValueError):
    """Raised when the training overlay crosses an authority boundary."""


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


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = hashlib.sha256(
        canonical_json(result).encode("utf-8")
    ).hexdigest()
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    declared = record.get("record_sha256")
    if not isinstance(declared, str) or len(declared) != 64:
        raise HighValueDatasetOverlayError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if hashlib.sha256(canonical_json(core).encode("utf-8")).hexdigest() != declared:
        raise HighValueDatasetOverlayError(f"{location}: record seal drifted")


def mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HighValueDatasetOverlayError(f"{location}: expected object")
    return value


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HighValueDatasetOverlayError(f"{location}: invalid JSON") from error
    return dict(mapping(value, location))


def iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise HighValueDatasetOverlayError(f"{location}: missing or linked JSONL")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise HighValueDatasetOverlayError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(mapping(value, f"{location}:{line_number}"))


def descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise HighValueDatasetOverlayError(f"missing regular artifact: {path}")
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise HighValueDatasetOverlayError(f"unsafe output directory: {result}")
    return result


def array_contract(arrays: Mapping[str, np.ndarray]) -> Mapping[str, Any]:
    return {
        name: {"dtype": str(value.dtype), "shape": list(value.shape)}
        for name, value in sorted(arrays.items())
    }


def load_arrays(path: Path) -> dict[str, np.ndarray]:
    with np.load(path, allow_pickle=False) as source:
        return {name: np.array(source[name], copy=True) for name in source.files}


def apply_overlay_arrays(
    arrays: Mapping[str, np.ndarray], labels: Sequence[Mapping[str, Any]]
) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    result = {name: np.array(value, copy=True) for name, value in arrays.items()}
    candidate_ids = tuple(str(value) for value in result["candidate_ids"].tolist())
    candidate_index = {value: index for index, value in enumerate(candidate_ids)}
    sample_ids = tuple(str(value) for value in result["sample_ids"].tolist())
    sample_index = {value: index for index, value in enumerate(sample_ids)}
    if len(sample_index) != len(sample_ids):
        raise HighValueDatasetOverlayError("base dataset sample IDs are duplicated")
    single_day_index = candidate_index.get("single-day")
    if single_day_index is None:
        raise HighValueDatasetOverlayError("base dataset lacks Single Day")

    role_counts: Counter[str] = Counter()
    preferred_counts: Counter[str] = Counter()
    positive_counts: Counter[str] = Counter()
    body_single_day_removed = 0
    body_preferred_cleared = 0
    replaced_authorities: Counter[str] = Counter()
    seen: set[str] = set()

    for row in labels:
        labels_artifact.validate_record_seal(row, "high-value training label")
        sample_id = str(row.get("sample_id", ""))
        if not sample_id or sample_id in seen or sample_id not in sample_index:
            raise HighValueDatasetOverlayError("label sample identity missing or duplicated")
        seen.add(sample_id)
        position = sample_index[sample_id]
        if int(result["split"][position]) != 0:
            raise HighValueDatasetOverlayError("high-value label escaped optimizer train")
        prior_authority = str(result["font_authority"][position])
        if prior_authority not in {"none", "human", "visual"}:
            raise HighValueDatasetOverlayError("base font authority drifted")
        replaced_authorities[prior_authority] += 1
        authority = mapping(row.get("authority"), "label authority")
        if (
            authority.get("training_eligible") is not True
            or authority.get("training_only") is not True
            or authority.get("evaluation_eligible") is not False
            or authority.get("calibration_eligible") is not False
            or authority.get("human_gold") is not False
            or authority.get("automatic_release_authority") is not False
            or authority.get("review_authority")
            != "codex_agent_direct_visual_supervision"
        ):
            raise HighValueDatasetOverlayError("label authority is not training-only")
        role = str(row.get("role", ""))
        family = 0 if role in BODY_ROLES else 1
        if row.get("family") != ("body" if family == 0 else "variant"):
            raise HighValueDatasetOverlayError("label role/family drifted")
        candidates = mapping(row.get("candidate_labels"), "candidate labels")
        preferred = set(str(value) for value in candidates.get("preferred_candidate_ids", ()))
        positive = set(str(value) for value in candidates.get("positive_candidate_ids", ()))
        eligible = set(str(value) for value in candidates.get("eligible_candidate_ids", ()))
        if not preferred or not preferred <= positive <= eligible or not eligible <= candidate_index.keys():
            raise HighValueDatasetOverlayError("candidate mask nesting/inventory drifted")
        if family == 0 and "single-day" in positive:
            positive.remove("single-day")
            body_single_day_removed += 1
            if "single-day" in preferred:
                preferred.remove("single-day")
                body_preferred_cleared += 1
        if not positive:
            raise HighValueDatasetOverlayError(
                "Single Day body policy removed the only positive candidate"
            )
        preferred &= positive
        role_confidence = float(row.get("role_confidence", 0.0))
        supervision_weight = float(row.get("supervision_weight", 0.0))
        if not 0.0 < role_confidence <= 1.0 or not 0.0 < supervision_weight <= 1.0:
            raise HighValueDatasetOverlayError("label weights escaped (0,1]")

        result["family_labels"][position] = family
        result["family_label_weights"][position] = role_confidence
        result["positive_mask"][position] = False
        result["preferred_mask"][position] = False
        result["candidate_eligible_mask"][position] = False
        for candidate_id in positive:
            result["positive_mask"][position, candidate_index[candidate_id]] = True
        for candidate_id in preferred:
            result["preferred_mask"][position, candidate_index[candidate_id]] = True
        for candidate_id in eligible:
            result["candidate_eligible_mask"][position, candidate_index[candidate_id]] = True
        result["font_supervision_weights"][position] = supervision_weight
        result["font_authority"][position] = "human"
        if family == 0:
            result["single_day_body_negative"][position] = True
        else:
            result["single_day_body_negative"][position] = False
        role_counts[role] += 1
        preferred_counts.update(preferred)
        positive_counts.update(positive)

    inventory = trainer.validate_training_arrays(result, candidate_count=len(candidate_ids))
    return result, {
        "body_single_day_positive_rows_removed": body_single_day_removed,
        "body_single_day_preferred_rows_cleared": body_preferred_cleared,
        "candidate_ids": candidate_ids,
        "inventory": dict(inventory),
        "overlay_rows": len(labels),
        "positive_candidate_counts": dict(sorted(positive_counts.items())),
        "preferred_candidate_counts": dict(sorted(preferred_counts.items())),
        "replaced_authority_counts": dict(sorted(replaced_authorities.items())),
        "role_counts": dict(sorted(role_counts.items())),
    }


def build_output(args: argparse.Namespace) -> Mapping[str, Any]:
    output = safe_output(args.output_dir)
    if output.exists():
        raise HighValueDatasetOverlayError("output directory already exists")
    base_root = args.base_dataset_dir.expanduser().resolve()
    labels_root = args.labels_dir.expanduser().resolve()
    base_validation = base_dataset.validate_output(base_root)
    if (
        sha256_file(base_root / base_dataset.MANIFEST_FILE)
        != EXPECTED_R3_BASE_MANIFEST_SHA256
        or sha256_file(base_root / base_dataset.DATASET_FILE)
        != EXPECTED_R3_BASE_NPZ_SHA256
    ):
        raise HighValueDatasetOverlayError("r3 body-holdout base identity drifted")
    labels_validation = labels_v6.validate_output(
        labels_root, require_current_source=True
    )
    labels_manifest = read_json(labels_root / labels_artifact.MANIFEST_FILE, "labels manifest")
    labels = list(iter_jsonl(labels_root / labels_artifact.LABELS_FILE, "training labels"))
    label_counts = mapping(labels_manifest.get("counts"), "label counts")
    label_lineage = mapping(labels_manifest.get("lineage"), "label lineage")
    prefix = mapping(
        label_lineage.get("byte_stable_prefix"), "label byte-stable prefix"
    )
    label_overlap = mapping(labels_manifest.get("overlap"), "label overlap")
    if (
        list(label_counts.get("expected_queue_row_span", ())) != EXPECTED_LABEL_SPAN
        or len(labels) != EXPECTED_LABEL_ROWS
        or int(label_counts.get("training_label_rows", -1)) != EXPECTED_LABEL_ROWS
        or int(label_counts.get("blind_rows_consumed", -1)) != 1600
        or int(label_counts.get("recrop_ruby_split_positive_promotions", -1)) != 0
        or int(label_counts.get("recrop_ruby_split_negative_promotions", -1)) != 0
        or int(prefix.get("row_count", -1)) != EXPECTED_PREFIX_ROWS
        or int(prefix.get("byte_size", -1)) != EXPECTED_PREFIX_BYTE_SIZE
        or prefix.get("sha256") != EXPECTED_PREFIX_SHA256
        or prefix.get("exact_prefix_verified") is not True
        or set(label_overlap) != labels_v6.EXPECTED_OVERLAP_KEYS
        or any(int(value) != 0 for value in label_overlap.values())
    ):
        raise HighValueDatasetOverlayError(
            "001..1600 training-only label boundary drifted"
        )
    arrays = load_arrays(base_root / base_dataset.DATASET_FILE)
    if tuple(str(value) for value in arrays["candidate_ids"].tolist()) != tuple(
        str(value) for value in labels_manifest.get("candidate_ids", ())
    ):
        raise HighValueDatasetOverlayError("base/label active21 order drifted")
    overlaid, summary = apply_overlay_arrays(arrays, labels)

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        np.savez(staging / DATASET_FILE, **overlaid)
        manifest = seal_record(
            {
                "array_contract": array_contract(overlaid),
                "authority": {
                    "automatic_release_authority": False,
                    "calibration_authority": False,
                    "evaluation_authority": False,
                    "human_gold": False,
                    "npz_authority_encoding": (
                        "human_for_weighting_compatibility_only"
                    ),
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "training_eligible": True,
                    "training_only": True,
                    "same_identity_precedence": "new_sealed_high_value_label",
                },
                "candidate_ids": list(summary["candidate_ids"]),
                "counts": {
                    **copy.deepcopy(summary["inventory"]),
                    "high_value_overlay_rows": summary["overlay_rows"],
                },
                "dataset": descriptor(
                    staging / DATASET_FILE,
                    row_count=int(summary["inventory"]["row_count"]),
                ),
                "overlay": {
                    "body_single_day_positive_rows_removed": summary[
                        "body_single_day_positive_rows_removed"
                    ],
                    "body_single_day_preferred_rows_cleared": summary[
                        "body_single_day_preferred_rows_cleared"
                    ],
                    "positive_candidate_counts": summary["positive_candidate_counts"],
                    "preferred_candidate_counts": summary["preferred_candidate_counts"],
                    "replaced_authority_counts": summary["replaced_authority_counts"],
                    "role_counts": summary["role_counts"],
                    "single_day_body_policy": "remove_positive_keep_reviewed_negative",
                },
                "record_type": "manga_font_student_v8_high_value_overlay_manifest",
                "schema_version": SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
                "sources": {
                    "base_dataset": {
                        "manifest_sha256": sha256_file(base_root / base_dataset.MANIFEST_FILE),
                        "npz_sha256": sha256_file(base_root / base_dataset.DATASET_FILE),
                        "output_dir": str(base_root),
                        "validation": dict(base_validation),
                    },
                    "training_labels": {
                        "byte_stable_prefix": {
                            "byte_size": EXPECTED_PREFIX_BYTE_SIZE,
                            "row_count": EXPECTED_PREFIX_ROWS,
                            "sha256": EXPECTED_PREFIX_SHA256,
                        },
                        "expected_queue_row_span": EXPECTED_LABEL_SPAN,
                        "labels_sha256": sha256_file(
                            labels_root / labels_artifact.LABELS_FILE
                        ),
                        "overlap": copy.deepcopy(dict(label_overlap)),
                        "row_count": EXPECTED_LABEL_ROWS,
                        "manifest_sha256": sha256_file(
                            labels_root / labels_artifact.MANIFEST_FILE
                        ),
                        "output_dir": str(labels_root),
                        "validation": dict(labels_validation),
                    },
                },
                "split_policy": {
                    "existing_train_authority_overwrite_allowed": True,
                    "existing_train_authority_overwrite_precedence": (
                        "new_sealed_high_value_label"
                    ),
                    "test_rows_exported": 0,
                    "train_only_overlay": True,
                    "validation_rows_modified": 0,
                },
            }
        )
        (staging / MANIFEST_FILE).write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "artifacts": {
                    DATASET_FILE: descriptor(
                        staging / DATASET_FILE,
                        row_count=int(summary["inventory"]["row_count"]),
                    ),
                    MANIFEST_FILE: descriptor(staging / MANIFEST_FILE),
                },
                "counts": copy.deepcopy(manifest["counts"]),
                "manifest_record_sha256": manifest["record_sha256"],
                "overlay": copy.deepcopy(manifest["overlay"]),
                "record_type": "manga_font_student_v8_high_value_overlay_report",
                "schema_version": SCHEMA,
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    DATASET_FILE: sha256_file(staging / DATASET_FILE),
                    MANIFEST_FILE: sha256_file(staging / MANIFEST_FILE),
                    REPORT_FILE: sha256_file(staging / REPORT_FILE),
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
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


def validate_output(
    output_dir: Path, *, require_current_source: bool = False
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise HighValueDatasetOverlayError("output exact inventory drifted")
    marker = read_json(root / MARKER_FILE, "marker")
    manifest = read_json(root / MANIFEST_FILE, "manifest")
    report = read_json(root / REPORT_FILE, "report")
    for location, record in (("marker", marker), ("manifest", manifest), ("report", report)):
        validate_record_seal(record, location)
    source_code_sha256 = manifest.get("source_code_sha256")
    authority = mapping(manifest.get("authority"), "manifest authority")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or not isinstance(source_code_sha256, str)
        or len(source_code_sha256) != 64
        or any(value not in "0123456789abcdef" for value in source_code_sha256)
        or (
            require_current_source
            and source_code_sha256 != sha256_file(Path(__file__).resolve())
        )
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
    ):
        raise HighValueDatasetOverlayError("metadata/schema drifted")
    if (
        authority.get("automatic_release_authority") is not False
        or authority.get("calibration_authority") is not False
        or authority.get("evaluation_authority") is not False
        or authority.get("human_gold") is not False
        or authority.get("npz_authority_encoding")
        != "human_for_weighting_compatibility_only"
        or authority.get("review_authority")
        != "codex_agent_direct_visual_supervision"
        or authority.get("training_eligible") is not True
        or authority.get("training_only") is not True
    ):
        raise HighValueDatasetOverlayError("dataset authority drifted")
    sources = mapping(manifest.get("sources"), "manifest sources")
    base_source = mapping(sources.get("base_dataset"), "base source")
    label_source = mapping(sources.get("training_labels"), "label source")
    prefix_source = mapping(
        label_source.get("byte_stable_prefix"), "label prefix source"
    )
    source_overlap = mapping(label_source.get("overlap"), "label source overlap")
    if (
        base_source.get("manifest_sha256") != EXPECTED_R3_BASE_MANIFEST_SHA256
        or base_source.get("npz_sha256") != EXPECTED_R3_BASE_NPZ_SHA256
        or list(label_source.get("expected_queue_row_span", ()))
        != EXPECTED_LABEL_SPAN
        or int(label_source.get("row_count", -1)) != EXPECTED_LABEL_ROWS
        or int(prefix_source.get("row_count", -1)) != EXPECTED_PREFIX_ROWS
        or int(prefix_source.get("byte_size", -1)) != EXPECTED_PREFIX_BYTE_SIZE
        or prefix_source.get("sha256") != EXPECTED_PREFIX_SHA256
        or set(source_overlap) != labels_v6.EXPECTED_OVERLAP_KEYS
        or any(int(value) != 0 for value in source_overlap.values())
    ):
        raise HighValueDatasetOverlayError("sealed r3-base source contract drifted")
    marker_artifacts = mapping(marker.get("artifacts"), "marker artifacts")
    for name in (DATASET_FILE, MANIFEST_FILE, REPORT_FILE):
        if marker_artifacts.get(name) != sha256_file(root / name):
            raise HighValueDatasetOverlayError(f"marker hash drifted: {name}")
    arrays = load_arrays(root / DATASET_FILE)
    candidate_count = len(arrays["candidate_ids"])
    inventory = trainer.validate_training_arrays(arrays, candidate_count=candidate_count)
    counts = mapping(manifest.get("counts"), "manifest counts")
    dataset_binding = mapping(manifest.get("dataset"), "manifest dataset")
    if (
        array_contract(arrays) != manifest.get("array_contract")
        or dataset_binding != descriptor(root / DATASET_FILE, row_count=inventory["row_count"])
        or int(counts.get("high_value_overlay_rows", -1)) != EXPECTED_LABEL_ROWS
        or int(counts.get("row_count", -1)) != inventory["row_count"]
    ):
        raise HighValueDatasetOverlayError("dataset contract/count drifted")
    return {
        **dict(inventory),
        "dataset_file": str(root / DATASET_FILE),
        "high_value_overlay_rows": int(counts["high_value_overlay_rows"]),
        "output_dir": str(root),
        "status": "validated_v8_high_value_training_overlay",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument(
        "--base-dataset-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout"),
    )
    build.add_argument(
        "--labels-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-1600-"
            "training-only-r1"
        ),
    )
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        result = build_output(args) if args.command == "build" else validate_output(args.output_dir)
    except (
        HighValueDatasetOverlayError,
        labels_artifact.HighValueSupervisedLabelError,
        base_dataset.V8RoleFamilyDatasetError,
        trainer.MangaFontV8RoleFamilyError,
        OSError,
        KeyError,
        ValueError,
    ) as error:
        raise SystemExit(f"v8 r3-base high-value overlay-v2 error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
