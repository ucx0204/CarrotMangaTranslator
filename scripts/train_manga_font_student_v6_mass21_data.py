#!/usr/bin/env python3
"""Build the leakage-safe MangaFont v6 mass-training input contract.

This module is intentionally the data/loss boundary, not another label
generator.  It projects the sealed v6/r3 22-font inputs to the active 21-font
catalog (``gugi`` is retired), restores all reviewed human train rows, indexes
only the 19,664 unlabeled master-v3 *train* rows, and optionally attaches
weighted pseudo soft targets.  Master validation/test rows are classified by a
byte-level top-level split scanner and are never JSON-deserialized.

The exported helpers are designed for a successor trainer to import.  The CLI
provides metadata-only preflight and a bounded pixel-resolution smoke; neither
command starts SigLIP2 or performs training.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, BinaryIO, Mapping, Sequence

import numpy as np

try:
    from scripts import build_font_matching_master as master
    from scripts import build_manga_font_legacy15_train_overlay_v1 as legacy15
    from scripts import build_manga_font_legacy_new7_expansion_review_v1 as authority
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v3 as v3
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_fontquery_r3 as r3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_matching_master as master
    import build_manga_font_legacy15_train_overlay_v1 as legacy15
    import build_manga_font_legacy_new7_expansion_review_v1 as authority
    import font_matching_catalog_assets as catalog_assets
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v3 as v3
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_fontquery_r3 as r3


SCHEMA = "manga-font-student-v6-mass21-data-v1"
PSEUDO_SCHEMA = "manga-font-student-v6-mass21-pseudo-v1"
RETIRED_FONT_ID = "gugi"
SOURCE_CANDIDATE_COUNT = 22
ACTIVE_CANDIDATE_COUNT = 21
MASTER_TOTAL_ROWS = 28_094
MASTER_TRAIN_ROWS = 19_664
MASTER_VAL_ROWS = 4_218
MASTER_TEST_ROWS = 4_212
ORIGINAL_FULL_ROWS = 109
UPGRADED_FULL_ROWS = 160
REVIEWED_FULL_ROWS = 269
REVIEWED_PARTIAL15_ROWS = 458
HUMAN_TRAIN_ROWS = 727
RETIRED_ONLY_FULL_ROWS = 3
RETIRED_ONLY_PARTIAL_ROWS = 49
RETIRED_ONLY_HUMAN_ROWS = RETIRED_ONLY_FULL_ROWS + RETIRED_ONLY_PARTIAL_ROWS
SUPERVISED_FULL21_ROWS = REVIEWED_FULL_ROWS - RETIRED_ONLY_FULL_ROWS
SUPERVISED_PARTIAL15_ROWS = REVIEWED_PARTIAL15_ROWS - RETIRED_ONLY_PARTIAL_ROWS
SUPERVISED_HUMAN_ROWS = SUPERVISED_FULL21_ROWS + SUPERVISED_PARTIAL15_ROWS
HUMAN_MASTER_OVERLAP_ROWS = 712
HUMAN_STANDALONE_ROWS = 15
SYNTHETIC_PER_FONT = 48
REFERENCE_PER_FONT = 16
SYNTHETIC21_ROWS = ACTIVE_CANDIDATE_COUNT * SYNTHETIC_PER_FONT
REFERENCE21_ROWS = ACTIVE_CANDIDATE_COUNT * REFERENCE_PER_FONT
DEFAULT_REAL_BATCH = 16
DEFAULT_FULL_HUMAN_BATCH = 4
DEFAULT_PARTIAL_HUMAN_BATCH = 4
DEFAULT_SYNTHETIC_BATCH = 16


class MangaFontMass21DataError(base.MangaFontStudentError):
    """Raised when a mass-training input escapes its sealed boundary."""


@dataclass(frozen=True)
class CandidateProjection:
    source_ids: tuple[str, ...]
    active_ids: tuple[str, ...]
    keep_indices: tuple[int, ...]
    retired_index: int


@dataclass(frozen=True)
class RealTrainIndexEntry:
    row_index: int
    line_number: int
    byte_offset: int
    byte_length: int
    line_sha256: str
    sample_id: str
    work_id: str
    work_weight: float
    source_catalog_id: str


@dataclass(frozen=True)
class RealTrainIndex:
    master_dir: Path
    manifest_path: Path
    manifest_sha256: str
    split_map_sha256: str
    entries: tuple[RealTrainIndexEntry, ...]
    skipped_val_rows: int
    skipped_test_rows: int


@dataclass(frozen=True)
class PseudoTarget:
    sample_id: str
    probabilities: tuple[float, ...]
    weight: float


@dataclass(frozen=True)
class PseudoTargetSet:
    source_path: Path | None
    source_sha256: str | None
    targets: Mapping[str, PseudoTarget]
    excluded_human_gold_rows: int


@dataclass(frozen=True)
class HumanSupervision:
    original_full_count: int
    upgraded_full_examples: tuple[base.HumanExample, ...]
    partial_examples: tuple[base.HumanExample, ...]
    retired_only_examples: tuple[base.HumanExample, ...]
    addition_examples: tuple[base.HumanExample, ...]
    addition_targets: np.ndarray
    addition_masks: np.ndarray
    addition_roles: np.ndarray
    all_sample_ids: frozenset[str]
    authority_validation: Mapping[str, Any]


@dataclass(frozen=True)
class HumanBatchSource:
    source: str
    source_index: int


@dataclass(frozen=True)
class Mass21EpochBatch:
    real_indices: tuple[int, ...]
    full_human_indices: tuple[int, ...]
    partial_human_indices: tuple[int, ...]
    synthetic_indices: tuple[int, ...]


@dataclass(frozen=True)
class Mass21TrainingInputs:
    projection: CandidateProjection
    cache_contract: Mapping[str, Any]
    human: HumanSupervision
    real: RealTrainIndex
    pseudo: PseudoTargetSet
    epoch_batches: tuple[Mass21EpochBatch, ...]
    summary: Mapping[str, Any]
    cached_arrays: Mapping[str, np.ndarray] | None


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontMass21DataError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise MangaFontMass21DataError(f"{location}: expected array")
    return value


def _contains_gemma_binding(value: Any) -> bool:
    if isinstance(value, str):
        return "gemma" in value.casefold()
    if isinstance(value, Mapping):
        return any(
            _contains_gemma_binding(key) or _contains_gemma_binding(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return any(_contains_gemma_binding(item) for item in value)
    return False


def candidate_projection(source_ids: Sequence[str]) -> CandidateProjection:
    normalized = tuple(str(value) for value in source_ids)
    if (
        len(normalized) != SOURCE_CANDIDATE_COUNT
        or normalized != legacy15.FULL22_CANDIDATE_IDS
        or normalized.count(RETIRED_FONT_ID) != 1
    ):
        raise MangaFontMass21DataError("source candidate vocabulary is not sealed full22")
    retired_index = normalized.index(RETIRED_FONT_ID)
    keep = tuple(index for index in range(len(normalized)) if index != retired_index)
    active = tuple(normalized[index] for index in keep)
    if len(active) != ACTIVE_CANDIDATE_COUNT or RETIRED_FONT_ID in active:
        raise MangaFontMass21DataError("active21 projection retained the retired font")
    return CandidateProjection(normalized, active, keep, retired_index)


def project_candidate_matrix(
    values: np.ndarray, projection: CandidateProjection
) -> np.ndarray:
    if values.ndim != 2 or values.shape[1] != len(projection.source_ids):
        raise MangaFontMass21DataError("candidate matrix shape drifted")
    return np.ascontiguousarray(values[:, projection.keep_indices])


def remap_source_labels(
    labels: np.ndarray, projection: CandidateProjection
) -> tuple[np.ndarray, np.ndarray]:
    if labels.ndim != 1 or labels.dtype.kind not in {"i", "u"}:
        raise MangaFontMass21DataError("candidate label array shape drifted")
    keep_rows = labels != projection.retired_index
    remapped = labels[keep_rows].astype(np.int64, copy=True)
    remapped[remapped > projection.retired_index] -= 1
    if (
        remapped.size < 1
        or int(remapped.min()) < 0
        or int(remapped.max()) >= len(projection.active_ids)
    ):
        raise MangaFontMass21DataError("candidate labels escaped active21")
    return keep_rows, np.ascontiguousarray(remapped, dtype="<i8")


def project_cached_arrays_to_active21(
    arrays: Mapping[str, np.ndarray], projection: CandidateProjection
) -> dict[str, np.ndarray]:
    """Project the sealed v6 cache without fabricating a Gugi replacement."""

    required = {
        "human_train_masks",
        "human_train_roles",
        "human_train_targets",
        "human_train_tokens",
        "human_val_masks",
        "human_val_roles",
        "human_val_targets",
        "human_val_tokens",
        "reference_labels",
        "reference_tokens",
        "synthetic_labels",
        "synthetic_tokens",
    }
    if set(arrays) != required:
        raise MangaFontMass21DataError("v6 cache array inventory drifted")
    output: dict[str, np.ndarray] = {}
    for split in ("train", "val"):
        output[f"human_{split}_targets"] = project_candidate_matrix(
            arrays[f"human_{split}_targets"], projection
        )
        output[f"human_{split}_masks"] = project_candidate_matrix(
            arrays[f"human_{split}_masks"], projection
        ).astype(np.bool_, copy=False)
        output[f"human_{split}_roles"] = np.array(
            arrays[f"human_{split}_roles"], copy=True
        )
        output[f"human_{split}_tokens"] = np.array(
            arrays[f"human_{split}_tokens"], copy=True
        )
        targets = output[f"human_{split}_targets"]
        if np.any(np.sum(targets == v3.PREFERRED_CODE, axis=1) < 1):
            raise MangaFontMass21DataError(
                f"human {split} row lost every preferred font after retirement"
            )
    for prefix, expected_per_font in (
        ("synthetic", SYNTHETIC_PER_FONT),
        ("reference", REFERENCE_PER_FONT),
    ):
        keep_rows, labels = remap_source_labels(
            arrays[f"{prefix}_labels"], projection
        )
        output[f"{prefix}_labels"] = labels
        output[f"{prefix}_tokens"] = np.ascontiguousarray(
            arrays[f"{prefix}_tokens"][keep_rows]
        )
        counts = np.bincount(labels, minlength=len(projection.active_ids))
        if not np.all(counts == expected_per_font):
            raise MangaFontMass21DataError(
                f"{prefix} active21 balance drifted: {counts.tolist()}"
            )
    return output


def _load_partial_examples(
    overlay_dir: Path,
    *,
    catalog_registry_sha256: str,
    source_candidate_ids: tuple[str, ...],
) -> tuple[base.HumanExample, ...]:
    validation = legacy15.validate_overlay(
        overlay_dir,
        candidate_ids=source_candidate_ids,
        catalog_registry_sha256=catalog_registry_sha256,
    )
    if int(validation.get("record_count", -1)) != 618:
        raise MangaFontMass21DataError("legacy partial overlay count drifted")
    root = overlay_dir.expanduser().resolve()
    manifest = base.read_json(root / legacy15.MANIFEST_FILE, location="legacy overlay")
    bindings = _mapping(manifest.get("bindings"), "legacy overlay.bindings")
    legacy_binding = _mapping(bindings.get("legacy_export"), "legacy overlay.legacy")
    source_sha = str(legacy_binding.get("samples_sha256"))
    result: list[base.HumanExample] = []
    seen: set[str] = set()
    with (root / legacy15.OVERLAY_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = _mapping(json.loads(line), f"legacy partial row {line_number}")
            except json.JSONDecodeError as error:
                raise MangaFontMass21DataError(
                    f"legacy partial row {line_number}: invalid JSON"
                ) from error
            example = legacy15.validate_partial_human_row(
                row,
                candidate_ids=source_candidate_ids,
                catalog_registry_sha256=catalog_registry_sha256,
                location=f"legacy partial row {line_number}",
                legacy_samples_sha256=source_sha,
            )
            if example.sample_id in seen:
                raise MangaFontMass21DataError("duplicate partial human identity")
            seen.add(example.sample_id)
            result.append(example)
    if len(result) != 618:
        raise MangaFontMass21DataError("legacy partial rows drifted while loading")
    return tuple(result)


def load_human_supervision(
    *,
    cache_contract: Mapping[str, Any],
    authority_dir: Path,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
    projection: CandidateProjection,
) -> HumanSupervision:
    registry_path = catalog_registry.expanduser().resolve()
    registry_sha = base.sha256_file(registry_path)
    partial = _load_partial_examples(
        legacy_overlay_dir,
        catalog_registry_sha256=registry_sha,
        source_candidate_ids=projection.source_ids,
    )
    upgraded, validation = authority.load_authority_examples(
        authority_dir,
        review_dir=review_dir,
        draft_dir=draft_dir,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=registry_path,
    )
    if (
        len(upgraded) != UPGRADED_FULL_ROWS
        or int(validation.get("full22_train_rows_after_apply", -1))
        != REVIEWED_FULL_ROWS
        or validation.get("completed_human_visual_provenance") is not True
        or int(validation.get("fabricated_new7_negative_count", -1)) != 0
        or int(validation.get("old15_membership_mutation_count", -1)) != 0
    ):
        raise MangaFontMass21DataError("all160 authority is unsafe")
    upgraded_by_id = {example.sample_id: example for example in upgraded}
    partial_ids = {example.sample_id for example in partial}
    if (
        len(upgraded_by_id) != UPGRADED_FULL_ROWS
        or not set(upgraded_by_id) < partial_ids
    ):
        raise MangaFontMass21DataError("authority identities escaped partial618")

    original_rows = _sequence(cache_contract.get("human_train"), "cache human_train")
    original_ids = {
        str(_mapping(row, "cached human row").get("sample_id"))
        for row in original_rows
    }
    if (
        len(original_ids) != ORIGINAL_FULL_ROWS
        or original_ids & partial_ids
        or any(
            _mapping(_mapping(row, "cached human row").get("supervision"), "supervision").get(
                "partial_candidate_supervision"
            )
            is not False
            for row in original_rows
        )
    ):
        raise MangaFontMass21DataError("cached full-human identity boundary drifted")

    reviewed_additions = tuple(
        upgraded_by_id.get(example.sample_id, example) for example in partial
    )
    source_arrays = v6._human_arrays(  # noqa: SLF001
        reviewed_additions, projection.source_ids
    )
    projected_targets = project_candidate_matrix(
        source_arrays["targets"], projection
    ).astype("<f4", copy=False)
    projected_masks = project_candidate_matrix(
        source_arrays["masks"], projection
    ).astype(np.bool_, copy=False)
    full_examples: list[base.HumanExample] = []
    partial_examples: list[base.HumanExample] = []
    retired_only_examples: list[base.HumanExample] = []
    supervised_indices: list[int] = []
    retired_full = 0
    retired_partial = 0
    for index, example in enumerate(reviewed_additions):
        scope = v3.candidate_supervision_scope(example, projection.source_ids)
        if not np.any(projected_targets[index] == v3.PREFERRED_CODE):
            retired_only_examples.append(example)
            if scope["partial_candidate_supervision"]:
                retired_partial += 1
            else:
                retired_full += 1
            continue
        supervised_indices.append(index)
        if scope["partial_candidate_supervision"]:
            partial_examples.append(example)
        else:
            full_examples.append(example)
    if (
        len(full_examples) != UPGRADED_FULL_ROWS - RETIRED_ONLY_FULL_ROWS
        or len(partial_examples) != SUPERVISED_PARTIAL15_ROWS
        or retired_full != RETIRED_ONLY_FULL_ROWS
        or retired_partial != RETIRED_ONLY_PARTIAL_ROWS
    ):
        raise MangaFontMass21DataError("effective full/partial human counts drifted")
    indices = np.asarray(supervised_indices, dtype=np.int64)
    additions = tuple(reviewed_additions[index] for index in supervised_indices)
    targets = np.ascontiguousarray(projected_targets[indices])
    masks = np.ascontiguousarray(projected_masks[indices])
    all_ids = frozenset(original_ids | partial_ids)
    if len(all_ids) != HUMAN_TRAIN_ROWS:
        raise MangaFontMass21DataError("human train identity count drifted")
    return HumanSupervision(
        original_full_count=ORIGINAL_FULL_ROWS,
        upgraded_full_examples=tuple(full_examples),
        partial_examples=tuple(partial_examples),
        retired_only_examples=tuple(retired_only_examples),
        addition_examples=additions,
        addition_targets=np.ascontiguousarray(targets),
        addition_masks=np.ascontiguousarray(masks),
        addition_roles=np.ascontiguousarray(
            source_arrays["roles"][indices], dtype="<i8"
        ),
        all_sample_ids=all_ids,
        authority_validation=MappingProxyType(copy.deepcopy(dict(validation))),
    )


def _validate_master_train_row(
    row: Mapping[str, Any],
    *,
    line_number: int,
    catalogs: Mapping[str, master.SourceCatalog],
    assignments: Mapping[str, Any],
) -> tuple[str, str, float, str]:
    location = f"master train row {line_number}"
    sample_id = str(row.get("id", ""))
    provenance = _mapping(row.get("provenance"), f"{location}.provenance")
    if (
        not sample_id
        or row.get("schema_version") != master.MASTER_SCHEMA_VERSION
        or row.get("catalog_version") != master.CATALOG_SCHEMA_VERSION
        or row.get("split") != "train"
        or row.get("label_status") != "unlabeled"
        or row.get("font_label") is not None
        or provenance.get("synthetic") is not False
        or provenance.get("qa_overlay") is not False
    ):
        raise MangaFontMass21DataError(f"{location}: unsafe real-train row")
    work = _mapping(row.get("work"), f"{location}.work")
    work_id = str(work.get("id", ""))
    if not work_id or assignments.get(work_id) != "train":
        raise MangaFontMass21DataError(f"{location}: work split drifted")
    weight = row.get("work_balance_weight")
    if (
        isinstance(weight, bool)
        or not isinstance(weight, (int, float))
        or not math.isfinite(float(weight))
        or float(weight) <= 0.0
    ):
        raise MangaFontMass21DataError(f"{location}: invalid work weight")
    catalog_id = str(provenance.get("source_catalog_id", ""))
    if catalog_id not in catalogs:
        raise MangaFontMass21DataError(f"{location}: unknown source catalog")
    views = _mapping(row.get("views"), f"{location}.views")
    if set(views) != set(base.VIEW_NAMES):
        raise MangaFontMass21DataError(f"{location}: three-view contract drifted")
    for view_name in base.VIEW_NAMES:
        master.validate_view_contract(
            views[view_name],
            view_name=view_name,
            item_id=sample_id,
            catalogs=catalogs,
            verify_assets=False,
        )
    master.validate_source_page_locator(row, item_id=sample_id)
    return sample_id, work_id, float(weight), catalog_id


def load_real_train_index(
    master_dir: Path, *, catalog_registry: Path
) -> RealTrainIndex:
    root = master_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()}
        != {"manifest.jsonl", "report.json", "split_map.json"}
    ):
        raise MangaFontMass21DataError("master-v3 inventory drifted")
    manifest_path = root / "manifest.jsonl"
    report = base.read_json(root / "report.json", location="master-v3 report")
    split_map = base.read_json(root / "split_map.json", location="master-v3 split")
    outputs = _mapping(report.get("outputs"), "master-v3 report.outputs")
    statistics = _mapping(report.get("statistics"), "master-v3 statistics")
    by_split = _mapping(statistics.get("by_split"), "master-v3 by_split")
    if (
        int(statistics.get("record_count", -1)) != MASTER_TOTAL_ROWS
        or dict(by_split)
        != {
            "test": MASTER_TEST_ROWS,
            "train": MASTER_TRAIN_ROWS,
            "val": MASTER_VAL_ROWS,
        }
        or report.get("tool") != master.TOOL_ID
    ):
        raise MangaFontMass21DataError("master-v3 reported counts drifted")
    registry_path = catalog_registry.expanduser().resolve()
    configuration = master.load_catalog_registry(registry_path)
    catalogs = {catalog.catalog_id: catalog for catalog in configuration.catalogs}
    attestation = _mapping(
        _mapping(report.get("inputs"), "master-v3 inputs").get("attestation"),
        "master-v3 attestation",
    )
    registry_binding = _mapping(
        attestation.get("catalog_registry"), "master-v3 catalog registry"
    )
    if registry_binding.get("sha256") != base.sha256_file(registry_path):
        raise MangaFontMass21DataError("master-v3 catalog registry drifted")
    assignments = _mapping(split_map.get("work_assignments"), "master-v3 assignments")
    split_map_sha = base.sha256_file(root / "split_map.json")
    if outputs.get("split_map_sha256") != split_map_sha:
        raise MangaFontMass21DataError("master-v3 split-map hash drifted")

    digest = hashlib.sha256()
    entries: list[RealTrainIndexEntry] = []
    seen: set[str] = set()
    counts = {"train": 0, "val": 0, "test": 0}
    physical_rows = 0
    with manifest_path.open("rb") as handle:
        while True:
            offset = handle.tell()
            raw_line = handle.readline()
            if not raw_line:
                break
            digest.update(raw_line)
            if not raw_line.strip():
                continue
            physical_rows += 1
            split = base.top_level_string_field_without_deserializing(
                raw_line, "split"
            )
            if split not in counts:
                raise MangaFontMass21DataError(
                    f"master row {physical_rows}: unsupported split {split!r}"
                )
            counts[split] += 1
            if split != "train":
                continue
            try:
                row = _mapping(
                    json.loads(raw_line), f"master train row {physical_rows}"
                )
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise MangaFontMass21DataError(
                    f"master train row {physical_rows}: invalid JSON"
                ) from error
            sample_id, work_id, weight, catalog_id = _validate_master_train_row(
                row,
                line_number=physical_rows,
                catalogs=catalogs,
                assignments=assignments,
            )
            if sample_id in seen:
                raise MangaFontMass21DataError("duplicate master train identity")
            seen.add(sample_id)
            entries.append(
                RealTrainIndexEntry(
                    row_index=len(entries),
                    line_number=physical_rows,
                    byte_offset=offset,
                    byte_length=len(raw_line),
                    line_sha256=base.sha256_bytes(raw_line),
                    sample_id=sample_id,
                    work_id=work_id,
                    work_weight=weight,
                    source_catalog_id=catalog_id,
                )
            )
    manifest_sha = digest.hexdigest()
    if (
        physical_rows != MASTER_TOTAL_ROWS
        or counts
        != {
            "train": MASTER_TRAIN_ROWS,
            "val": MASTER_VAL_ROWS,
            "test": MASTER_TEST_ROWS,
        }
        or len(entries) != MASTER_TRAIN_ROWS
        or outputs.get("master_manifest_sha256") != manifest_sha
    ):
        raise MangaFontMass21DataError("master-v3 manifest/count binding drifted")
    return RealTrainIndex(
        master_dir=root,
        manifest_path=manifest_path,
        manifest_sha256=manifest_sha,
        split_map_sha256=split_map_sha,
        entries=tuple(entries),
        skipped_val_rows=MASTER_VAL_ROWS,
        skipped_test_rows=MASTER_TEST_ROWS,
    )


def read_real_train_row(
    index: RealTrainIndex,
    entry: RealTrainIndexEntry,
    *,
    handle: BinaryIO | None = None,
) -> Mapping[str, Any]:
    owned = handle is None
    stream = index.manifest_path.open("rb") if handle is None else handle
    try:
        stream.seek(entry.byte_offset)
        raw_line = stream.read(entry.byte_length)
    finally:
        if owned:
            stream.close()
    if (
        len(raw_line) != entry.byte_length
        or base.sha256_bytes(raw_line) != entry.line_sha256
    ):
        raise MangaFontMass21DataError("indexed real-train row changed after preflight")
    try:
        row = _mapping(json.loads(raw_line), f"real train {entry.sample_id}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MangaFontMass21DataError("indexed real-train row is invalid") from error
    if row.get("id") != entry.sample_id or row.get("split") != "train":
        raise MangaFontMass21DataError("indexed real-train identity drifted")
    return row


def open_real_train_views(
    row: Mapping[str, Any], resolver: catalog_assets.CatalogAssetResolver
) -> list[Any]:
    sample_id = str(row.get("id", ""))
    views = _mapping(row.get("views"), f"real train {sample_id}.views")
    images: list[Any] = []
    try:
        for view_name in base.VIEW_NAMES:
            with resolver.resolve_view_descriptor(
                views[view_name],
                sample_id=sample_id,
                view_name=view_name,
                location=f"real train {sample_id}.views.{view_name}",
            ) as resolved:
                if resolved.image.mode != "RGB" or resolved.image.size != (224, 224):
                    raise MangaFontMass21DataError(
                        f"real train {sample_id}/{view_name}: invalid pixels"
                    )
                images.append(resolved.image.copy())
        return images
    except BaseException:
        for image in images:
            image.close()
        raise


def _pseudo_probabilities(
    row: Mapping[str, Any], candidate_ids: tuple[str, ...], location: str
) -> tuple[float, ...]:
    if "soft_labels" in row:
        raise MangaFontMass21DataError(f"{location}: sparse pseudo labels are forbidden")
    declared = tuple(
        str(value)
        for value in _sequence(row.get("candidate_ids"), f"{location}.candidate_ids")
    )
    if declared != candidate_ids:
        raise MangaFontMass21DataError(f"{location}: candidate order drifted")
    raw_values = _sequence(row.get("probabilities"), f"{location}.probabilities")
    if len(raw_values) != len(candidate_ids):
        raise MangaFontMass21DataError(f"{location}: probability count drifted")
    try:
        values = tuple(float(value) for value in raw_values)
    except (TypeError, ValueError) as error:
        raise MangaFontMass21DataError(
            f"{location}: probability values must be numeric"
        ) from error
    if (
        any(not math.isfinite(value) or value < 0.0 for value in values)
        or not math.isclose(sum(values), 1.0, rel_tol=0.0, abs_tol=1e-5)
    ):
        raise MangaFontMass21DataError(f"{location}: invalid probability simplex")
    return values


def load_pseudo_targets(
    path: Path | None,
    *,
    candidate_ids: tuple[str, ...],
    real_train_ids: frozenset[str],
    human_gold_ids: frozenset[str],
) -> PseudoTargetSet:
    if path is None:
        return PseudoTargetSet(None, None, MappingProxyType({}), 0)
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise MangaFontMass21DataError("pseudo-label input is missing or linked")
    targets: dict[str, PseudoTarget] = {}
    seen: set[str] = set()
    excluded_gold = 0
    with source.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            location = f"pseudo row {line_number}"
            try:
                row = _mapping(json.loads(line), location)
            except json.JSONDecodeError as error:
                raise MangaFontMass21DataError(f"{location}: invalid JSON") from error
            if row.get("schema_version") != PSEUDO_SCHEMA or row.get("split") != "train":
                raise MangaFontMass21DataError(f"{location}: schema/split drifted")
            if (
                row.get("label_authority") != "pseudo_soft_not_gold"
                or row.get("training_eligible") is not False
            ):
                raise MangaFontMass21DataError(
                    f"{location}: pseudo authority boundary drifted"
                )
            teacher_bindings = _mapping(
                row.get("teacher_bindings"), f"{location}.teacher_bindings"
            )
            if not teacher_bindings:
                raise MangaFontMass21DataError(
                    f"{location}: teacher bindings are required"
                )
            if _contains_gemma_binding(teacher_bindings):
                raise MangaFontMass21DataError(
                    f"{location}: Gemma-derived pseudo supervision is forbidden"
                )
            pseudo_round = row.get("round")
            if (
                isinstance(pseudo_round, bool)
                or not isinstance(pseudo_round, int)
                or pseudo_round < 1
            ):
                raise MangaFontMass21DataError(f"{location}: invalid pseudo round")
            sample_id = str(row.get("sample_id", ""))
            if not sample_id or sample_id not in real_train_ids:
                raise MangaFontMass21DataError(
                    f"{location}: pseudo identity escaped master train"
                )
            if sample_id in seen:
                raise MangaFontMass21DataError(f"{location}: duplicate pseudo identity")
            seen.add(sample_id)
            values = _pseudo_probabilities(row, candidate_ids, location)
            raw_weight = row.get("weight")
            if (
                isinstance(raw_weight, bool)
                or not isinstance(raw_weight, (int, float))
                or not math.isfinite(float(raw_weight))
                or not 0.0 <= float(raw_weight) <= 1.0
            ):
                raise MangaFontMass21DataError(f"{location}: invalid pseudo weight")
            if sample_id in human_gold_ids:
                excluded_gold += 1
                continue
            targets[sample_id] = PseudoTarget(sample_id, values, float(raw_weight))
    return PseudoTargetSet(
        source,
        base.sha256_file(source),
        MappingProxyType(targets),
        excluded_gold,
    )


def resolve_full_human_index(index: int) -> HumanBatchSource:
    """Map the supervised-full scheduler to cached109 or upgraded157 pixels."""

    if isinstance(index, bool) or not 0 <= index < SUPERVISED_FULL21_ROWS:
        raise MangaFontMass21DataError("full-human scheduler index escaped full266")
    if index < ORIGINAL_FULL_ROWS:
        return HumanBatchSource("cached_original_full21", index)
    return HumanBatchSource("upgraded_full21_pixels", index - ORIGINAL_FULL_ROWS)


def _cycled_indices(
    *, count: int, needed: int, seed: int
) -> tuple[int, ...]:
    if count < 1 or needed < count:
        raise MangaFontMass21DataError("epoch schedule cannot cover a training source")
    rng = random.Random(seed)
    result: list[int] = []
    while len(result) < needed:
        cycle = list(range(count))
        rng.shuffle(cycle)
        result.extend(cycle)
    return tuple(result[:needed])


def build_epoch_batches(
    *,
    real_count: int,
    full_human_count: int,
    partial_human_count: int,
    synthetic_count: int,
    real_batch_size: int = DEFAULT_REAL_BATCH,
    full_human_batch_size: int = DEFAULT_FULL_HUMAN_BATCH,
    partial_human_batch_size: int = DEFAULT_PARTIAL_HUMAN_BATCH,
    synthetic_batch_size: int = DEFAULT_SYNTHETIC_BATCH,
    seed: int,
) -> tuple[Mass21EpochBatch, ...]:
    sizes = (
        real_batch_size,
        full_human_batch_size,
        partial_human_batch_size,
        synthetic_batch_size,
    )
    if any(value < 1 for value in sizes):
        raise MangaFontMass21DataError("all mass21 batch components must be positive")
    steps = math.ceil(real_count / real_batch_size)
    real_order = list(range(real_count))
    random.Random(seed).shuffle(real_order)
    full = _cycled_indices(
        count=full_human_count,
        needed=steps * full_human_batch_size,
        seed=seed + 1,
    )
    partial = _cycled_indices(
        count=partial_human_count,
        needed=steps * partial_human_batch_size,
        seed=seed + 2,
    )
    synthetic = _cycled_indices(
        count=synthetic_count,
        needed=steps * synthetic_batch_size,
        seed=seed + 3,
    )
    batches: list[Mass21EpochBatch] = []
    for step in range(steps):
        real_start = step * real_batch_size
        full_start = step * full_human_batch_size
        partial_start = step * partial_human_batch_size
        synthetic_start = step * synthetic_batch_size
        batches.append(
            Mass21EpochBatch(
                real_indices=tuple(real_order[real_start : real_start + real_batch_size]),
                full_human_indices=full[
                    full_start : full_start + full_human_batch_size
                ],
                partial_human_indices=partial[
                    partial_start : partial_start + partial_human_batch_size
                ],
                synthetic_indices=synthetic[
                    synthetic_start : synthetic_start + synthetic_batch_size
                ],
            )
        )
    flattened = [index for batch in batches for index in batch.real_indices]
    if len(flattened) != real_count or set(flattened) != set(range(real_count)):
        raise MangaFontMass21DataError("real train epoch coverage drifted")
    return tuple(batches)


def three_view_consistency_loss(torch: Any, view_embeddings: Any) -> Any:
    """Apply the v6 invariance loss to every unlabeled real three-view row."""

    return v6.view_invariance_loss(torch, view_embeddings)


def domain_moment_loss(
    torch: Any,
    real_view_embeddings: Any,
    synthetic_view_embeddings: Any,
    *,
    real_weights: Any | None = None,
) -> Any:
    """CORAL-lite mean/variance alignment between real and synthetic domains."""

    if (
        real_view_embeddings.ndim != 4
        or synthetic_view_embeddings.ndim != 4
        or real_view_embeddings.shape[1:] != synthetic_view_embeddings.shape[1:]
        or real_view_embeddings.shape[1] != len(base.VIEW_NAMES)
    ):
        raise MangaFontMass21DataError("domain embedding shape drifted")
    real = torch.nn.functional.normalize(
        real_view_embeddings.float().mean(dim=1), p=2, dim=-1
    )
    synthetic = torch.nn.functional.normalize(
        synthetic_view_embeddings.float().mean(dim=1), p=2, dim=-1
    )
    if real_weights is None:
        weights = torch.full(
            (real.shape[0],),
            1.0 / real.shape[0],
            device=real.device,
            dtype=real.dtype,
        )
    else:
        if real_weights.ndim != 1 or real_weights.shape[0] != real.shape[0]:
            raise MangaFontMass21DataError("real domain weight shape drifted")
        weights = real_weights.float().clamp(min=0.0)
        weights = weights / weights.sum().clamp(min=1e-6)
    real_mean = torch.einsum("b,bqd->qd", weights, real)
    synthetic_mean = synthetic.mean(dim=0)
    real_variance = torch.einsum(
        "b,bqd->qd", weights, (real - real_mean) ** 2
    )
    synthetic_variance = ((synthetic - synthetic_mean) ** 2).mean(dim=0)
    return torch.nn.functional.mse_loss(
        real_mean, synthetic_mean
    ) + torch.nn.functional.mse_loss(real_variance, synthetic_variance)


def pseudo_soft_target_loss(
    torch: Any, logits: Any, targets: Any, weights: Any
) -> Any:
    if (
        logits.ndim != 2
        or logits.shape != targets.shape
        or weights.ndim != 1
        or weights.shape[0] != logits.shape[0]
        or logits.shape[1] != ACTIVE_CANDIDATE_COUNT
    ):
        raise MangaFontMass21DataError("pseudo loss tensor shape drifted")
    target_values = targets.float()
    if not bool(torch.isfinite(target_values).all()) or not bool(
        torch.allclose(
            target_values.sum(dim=-1),
            torch.ones(logits.shape[0], device=logits.device),
            atol=1e-5,
            rtol=0.0,
        )
    ):
        raise MangaFontMass21DataError("pseudo targets are not probability rows")
    row_weights = weights.float().clamp(min=0.0)
    per_row = -(target_values * torch.log_softmax(logits.float(), dim=-1)).sum(
        dim=-1
    )
    return (per_row * row_weights).sum() / row_weights.sum().clamp(min=1e-6)


def masked_human_loss(
    torch: Any,
    logits: Any,
    targets: Any,
    masks: Any,
    *,
    row_weights: Any | None = None,
) -> Any:
    return v3.tiered_deployment_loss(
        torch,
        logits,
        targets,
        masks,
        preferred_weight=1.0,
        acceptable_weight=0.20,
        row_weights=row_weights,
    )


def build_training_inputs(
    *,
    cache_dir: Path,
    r3_output_dir: Path,
    authority_dir: Path,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    human_catalog_registry: Path,
    master_dir: Path,
    master_catalog_registry: Path,
    pseudo_labels: Path | None,
    real_batch_size: int = DEFAULT_REAL_BATCH,
    full_human_batch_size: int = DEFAULT_FULL_HUMAN_BATCH,
    partial_human_batch_size: int = DEFAULT_PARTIAL_HUMAN_BATCH,
    synthetic_batch_size: int = DEFAULT_SYNTHETIC_BATCH,
    seed: int = 20260803,
    load_cached_arrays: bool = False,
) -> Mass21TrainingInputs:
    v6.validate_patch_cache(cache_dir)
    r3.validate_output(r3_output_dir)
    cache_contract = base.read_json(
        cache_dir.expanduser().resolve() / v6.CACHE_CONTRACT,
        location="v6 mass21 cache contract",
    )
    projection = candidate_projection(cache_contract.get("candidate_ids", ()))
    selection = _mapping(cache_contract.get("selection"), "v6 cache selection")
    boundaries = _mapping(cache_contract.get("boundaries"), "v6 cache boundaries")
    if (
        int(selection.get("synthetic_per_font", -1)) != SYNTHETIC_PER_FONT
        or int(selection.get("references_per_font", -1)) != REFERENCE_PER_FONT
        or int(boundaries.get("human_train_full22_count", -1))
        != ORIGINAL_FULL_ROWS
    ):
        raise MangaFontMass21DataError("v6 source-cache counts drifted")
    human = load_human_supervision(
        cache_contract=cache_contract,
        authority_dir=authority_dir,
        review_dir=review_dir,
        draft_dir=draft_dir,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=human_catalog_registry,
        projection=projection,
    )
    real = load_real_train_index(
        master_dir, catalog_registry=master_catalog_registry
    )
    real_ids = frozenset(entry.sample_id for entry in real.entries)
    human_overlap = len(real_ids & human.all_sample_ids)
    if (
        human_overlap != HUMAN_MASTER_OVERLAP_ROWS
        or len(human.all_sample_ids - real_ids) != HUMAN_STANDALONE_ROWS
    ):
        raise MangaFontMass21DataError("human/master-v3 identity boundary drifted")
    pseudo = load_pseudo_targets(
        pseudo_labels,
        candidate_ids=projection.active_ids,
        real_train_ids=real_ids,
        human_gold_ids=human.all_sample_ids,
    )
    epoch_batches = build_epoch_batches(
        real_count=len(real.entries),
        full_human_count=SUPERVISED_FULL21_ROWS,
        partial_human_count=SUPERVISED_PARTIAL15_ROWS,
        synthetic_count=SYNTHETIC21_ROWS,
        real_batch_size=real_batch_size,
        full_human_batch_size=full_human_batch_size,
        partial_human_batch_size=partial_human_batch_size,
        synthetic_batch_size=synthetic_batch_size,
        seed=seed,
    )
    arrays = None
    if load_cached_arrays:
        loaded_contract, source_arrays = v6._load_cache(cache_dir)  # noqa: SLF001
        if loaded_contract.get("record_sha256") != cache_contract.get("record_sha256"):
            raise MangaFontMass21DataError("cache contract changed during load")
        arrays = MappingProxyType(
            project_cached_arrays_to_active21(source_arrays, projection)
        )
    summary = MappingProxyType(
        {
            "active_candidate_count": len(projection.active_ids),
            "active_candidate_ids": list(projection.active_ids),
            "epoch_steps": len(epoch_batches),
            "human_reviewed_full_rows": REVIEWED_FULL_ROWS,
            "human_reviewed_partial15_rows": REVIEWED_PARTIAL15_ROWS,
            "human_master_overlap_rows": human_overlap,
            "human_retired_only_full_rows": RETIRED_ONLY_FULL_ROWS,
            "human_retired_only_partial_rows": RETIRED_ONLY_PARTIAL_ROWS,
            "human_retired_only_rows": RETIRED_ONLY_HUMAN_ROWS,
            "human_standalone_rows": HUMAN_STANDALONE_ROWS,
            "human_supervised_full21_rows": SUPERVISED_FULL21_ROWS,
            "human_supervised_partial15_rows": SUPERVISED_PARTIAL15_ROWS,
            "human_supervised_rows": SUPERVISED_HUMAN_ROWS,
            "human_total_rows": HUMAN_TRAIN_ROWS,
            "master_manifest_sha256": real.manifest_sha256,
            "master_test_rows_json_deserialized": 0,
            "master_test_rows_skipped": real.skipped_test_rows,
            "master_train_rows": len(real.entries),
            "master_val_rows_json_deserialized": 0,
            "master_val_rows_skipped": real.skipped_val_rows,
            "pseudo_gold_rows_excluded": pseudo.excluded_human_gold_rows,
            "pseudo_rows": len(pseudo.targets),
            "reference21_rows": REFERENCE21_ROWS,
            "retired_candidate_id": RETIRED_FONT_ID,
            "schema_version": SCHEMA,
            "synthetic21_rows": SYNTHETIC21_ROWS,
            "unlabeled_real_epoch_coverage": "exactly_once",
        }
    )
    return Mass21TrainingInputs(
        projection=projection,
        cache_contract=MappingProxyType(cache_contract),
        human=human,
        real=real,
        pseudo=pseudo,
        epoch_batches=epoch_batches,
        summary=summary,
        cached_arrays=arrays,
    )


def smoke_pixels(
    inputs: Mass21TrainingInputs,
    *,
    master_catalog_registry: Path,
    human_catalog_registry: Path,
    row_count: int,
) -> Mapping[str, Any]:
    if row_count < 1 or row_count > 16:
        raise MangaFontMass21DataError("smoke row count must be 1..16")
    master_resolver = catalog_assets.CatalogAssetResolver(master_catalog_registry)
    human_resolver = catalog_assets.CatalogAssetResolver(human_catalog_registry)
    opened_real = 0
    with inputs.real.manifest_path.open("rb") as handle:
        for entry in inputs.real.entries[:row_count]:
            row = read_real_train_row(inputs.real, entry, handle=handle)
            images = open_real_train_views(row, master_resolver)
            for image in images:
                image.close()
            opened_real += 1
    opened_human = 0
    for example in inputs.human.addition_examples[:row_count]:
        images = base._open_human_views(example, human_resolver)  # noqa: SLF001
        for image in images:
            image.close()
        opened_human += 1
    return {
        **dict(inputs.summary),
        "human_three_view_rows_opened": opened_human,
        "master_three_view_rows_opened": opened_real,
        "pixels_per_row": len(base.VIEW_NAMES),
        "smoke_status": "three_view_pixels_verified_no_training_started",
    }


def _add_common_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-patch-cache-v1"),
    )
    parser.add_argument(
        "--r3-output-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-fontquery-r3-all160-v1"),
    )
    parser.add_argument(
        "--authority-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1"
        ),
    )
    parser.add_argument(
        "--review-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"),
    )
    parser.add_argument(
        "--draft-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1"),
    )
    parser.add_argument(
        "--legacy-overlay-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy15-train-overlay-v1"),
    )
    parser.add_argument(
        "--human-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v2.json"),
    )
    parser.add_argument(
        "--master-dir",
        type=Path,
        default=Path("datasets/font-matching-master-v3"),
    )
    parser.add_argument(
        "--master-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    parser.add_argument("--pseudo-labels", type=Path)
    parser.add_argument("--real-batch-size", type=int, default=DEFAULT_REAL_BATCH)
    parser.add_argument(
        "--full-human-batch-size", type=int, default=DEFAULT_FULL_HUMAN_BATCH
    )
    parser.add_argument(
        "--partial-human-batch-size",
        type=int,
        default=DEFAULT_PARTIAL_HUMAN_BATCH,
    )
    parser.add_argument(
        "--synthetic-batch-size", type=int, default=DEFAULT_SYNTHETIC_BATCH
    )
    parser.add_argument("--seed", type=int, default=20260803)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("preflight")
    _add_common_inputs(preflight)
    smoke = commands.add_parser("smoke")
    _add_common_inputs(smoke)
    smoke.add_argument("--smoke-rows", type=int, default=3)
    return parser


def _inputs_from_args(args: argparse.Namespace) -> Mass21TrainingInputs:
    return build_training_inputs(
        cache_dir=args.cache_dir,
        r3_output_dir=args.r3_output_dir,
        authority_dir=args.authority_dir,
        review_dir=args.review_dir,
        draft_dir=args.draft_dir,
        legacy_overlay_dir=args.legacy_overlay_dir,
        human_catalog_registry=args.human_catalog_registry,
        master_dir=args.master_dir,
        master_catalog_registry=args.master_catalog_registry,
        pseudo_labels=args.pseudo_labels,
        real_batch_size=args.real_batch_size,
        full_human_batch_size=args.full_human_batch_size,
        partial_human_batch_size=args.partial_human_batch_size,
        synthetic_batch_size=args.synthetic_batch_size,
        seed=args.seed,
        load_cached_arrays=False,
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        inputs = _inputs_from_args(args)
        result: Mapping[str, Any] = inputs.summary
        if args.command == "smoke":
            result = smoke_pixels(
                inputs,
                master_catalog_registry=args.master_catalog_registry,
                human_catalog_registry=args.human_catalog_registry,
                row_count=args.smoke_rows,
            )
    except (
        MangaFontMass21DataError,
        authority.LegacyNew7ReviewError,
        legacy15.Legacy15TrainOverlayError,
        catalog_assets.CatalogAssetError,
        master.MasterManifestError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-mass21 data error: {error}") from error
    print(base.canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
