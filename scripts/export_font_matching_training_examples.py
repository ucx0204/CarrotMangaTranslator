#!/usr/bin/env python3
"""Export completed font-review labels into deterministic training contracts.

The exporter consumes the immutable P0 master manifest, a *completed* review
ledger workspace, and the audited production font render bank.  It never
accepts review-card pixels as model inputs.  Real samples, ranking targets,
retrieval targets, and optional generated augmentation references are emitted
as separate, hash-bound JSONL files.

Generated augmentations are an explicit exception to the real-only core: they
must declare synthetic provenance, belong to a real ``train`` parent, and are
written only to ``augmentations.jsonl`` with evaluation eligibility disabled.
They can never enter validation or test outputs.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import itertools
import json
import math
import os
import re
import shutil
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import font_matching_labels as labels  # noqa: E402
import font_matching_review_ledger as review_ledger  # noqa: E402
import build_font_matching_master as master_builder  # noqa: E402


SCHEMA_VERSION = "font-matching-training-export-v1"
SAMPLE_SCHEMA_VERSION = "font-matching-training-sample-v1"
PAIRWISE_SCHEMA_VERSION = "font-matching-pairwise-example-v1"
LISTWISE_SCHEMA_VERSION = "font-matching-listwise-example-v1"
RETRIEVAL_SCHEMA_VERSION = "font-matching-retrieval-example-v1"
PROTOTYPE_SCHEMA_VERSION = "font-matching-font-prototype-v1"
AUGMENTATION_SCHEMA_VERSION = "font-matching-generated-augmentation-v1"
EXPORTED_AUGMENTATION_SCHEMA_VERSION = "font-matching-train-only-augmentation-v1"
CHAPTER_PAIR_SCHEMA_VERSION = "font-matching-chapter-pair-v1"
REPORT_SCHEMA_VERSION = "font-matching-training-export-report-v1"
BODY_DIALOGUE_DEDUPLICATION_SCHEMA_VERSION = (
    "font-matching-body-dialogue-deduplication-v1"
)
SOURCE_STYLE_CLUSTER_ALGORITHM = "font-source-style-quarter-bin-fingerprint-v1"
BODY_DIALOGUE_CAP = 3
HIGH_VARIANT_STYLE_THRESHOLD = 0.5
CHAPTER_PAIR_FILE = "chapter-pairs.jsonl"
CHAPTER_PAIR_SELECTION_ALGORITHM = "font-matching-chapter-pair-selection-v1"
CHAPTER_PAIR_MIN_LABEL_QUALITY = 0.8
CHAPTER_PAIR_MIN_ORDINARY_POSITIVE_JACCARD = 0.5
CHAPTER_PAIR_MAX_OVERRIDE_JACCARD = 0.5
MAX_ORDINARY_CHAPTER_PAIRS_PER_GROUP = 2
MAX_LOCAL_OVERRIDE_PAIRS_PER_GROUP = 3
VARIANT_ROLES = frozenset(
    {
        "whisper",
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
    }
)
PLAIN_TREATMENT = {
    "outline": "none",
    "shadow": "none",
    "fill": "solid",
    "distortion": "none",
}
OWNER = "carrot-manga-translator/font-matching-training-export"
MARKER_FILE = ".font-matching-training-export-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
ARTIFACT_FILES = (
    "font-prototypes.jsonl",
    "samples.jsonl",
    "listwise.jsonl",
    "pairwise.jsonl",
    "retrieval.jsonl",
    "augmentations.jsonl",
)
RANKED_TIERS = ("preferred", "acceptable", "marginal", "unacceptable")
TIER_GAIN = {"preferred": 3, "acceptable": 2, "marginal": 1, "unacceptable": 0}
VALID_SPLITS = frozenset({"train", "val", "test"})
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
OVERLAY_PARTS = frozenset(
    {
        "contact-sheet",
        "contact-sheets",
        "diagnostic",
        "diagnostics",
        "overlay",
        "overlays",
        "qa-overlay",
        "qa-overlays",
        "qa_overlay",
        "qa_overlays",
    }
)
OVERLAY_KEYS = frozenset(
    {
        "contains_qa_overlay",
        "diagnostic_overlay_written",
        "is_diagnostic_overlay",
        "is_qa_overlay",
        "overlay_baked_into_asset",
        "qa_overlay",
        "qa_overlay_in_training_asset",
    }
)


class TrainingExportError(ValueError):
    """Raised when final labels cannot safely become training examples."""


@dataclass(frozen=True)
class ArtifactDescriptor:
    file: str
    record_count: int
    sha256: str
    byte_size: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "byte_size": self.byte_size,
            "file": self.file,
            "record_count": self.record_count,
            "sha256": self.sha256,
        }


@dataclass
class ExportContext:
    samples: list[dict[str, Any]]
    prototype_rows: list[dict[str, Any]]
    augmentation_rows: list[dict[str, Any]]
    candidate_ids: tuple[str, ...]
    input_hashes: dict[str, str | None]
    master_manifest_sha256: str
    render_bank_manifest_sha256: str
    render_specification_sha256: str
    font_catalog_sha256: str
    renderer_hash: str
    review_scope: dict[str, Any]
    work_split: dict[str, str]
    resolution_counts: dict[str, int]
    completed_final_count: int
    excluded_final_ids: tuple[str, ...]
    excluded_final_ids_sha256: str
    catalog_registry_sha256: str | None
    master_report_sha256: str | None
    master_split_map_sha256: str | None
    parent_workspace_projection: bool
    registry_attestation: dict[str, Any] | None
    body_dialogue_deduplication: dict[str, Any]
    chapter_pair_rows: list[dict[str, Any]]
    chapter_pair_contract: dict[str, Any]


@dataclass(frozen=True)
class RegistryContract:
    catalog_source_kinds: Mapping[str, str]
    expected_counts: Mapping[str, int]
    expected_total: int
    excluded_parent_ids: frozenset[str]
    invalidated_parent_ids: frozenset[str]
    input_attestation: Mapping[str, Any]
    parent_master_manifest_sha256: str | None
    record_sha256: str
    registry_sha256: str
    source_configuration: master_builder.SourceConfiguration


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    return (rendered + "\n").encode("utf-8")


def canonical_jsonl_record(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        + b"\n"
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise TrainingExportError(f"could not read {path}: {error}") from error
    with handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def sorted_ids_sha256(values: Iterable[str]) -> str:
    ordered = sorted(values)
    payload = ("\n".join(ordered) + ("\n" if ordered else "")).encode("utf-8")
    return sha256_bytes(payload)


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(
        json.dumps(
            output, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )
    return output


def validate_seal(record: Mapping[str, Any], *, location: str) -> None:
    declared = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    expected = sha256_bytes(
        json.dumps(
            core, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )
    if declared != expected:
        raise TrainingExportError(f"{location}: record hash binding failed")


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TrainingExportError(f"{location}: expected an object")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise TrainingExportError(f"{location}: expected a non-empty string")
    return value


def require_id(value: Any, location: str) -> str:
    output = require_text(value, location)
    if SAFE_ID_RE.fullmatch(output) is None:
        raise TrainingExportError(f"{location}: invalid identifier")
    return output


def require_sha(value: Any, location: str) -> str:
    output = require_text(value, location)
    if SHA_RE.fullmatch(output) is None:
        raise TrainingExportError(f"{location}: expected a lowercase SHA-256")
    return output


def safe_relative_path(value: Any, location: str) -> str:
    text = require_text(value, location).replace("\\", "/")
    path = PurePosixPath(text)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in {"", ".", ".."} for part in path.parts)
        or ":" in path.parts[0]
    ):
        raise TrainingExportError(f"{location}: unsafe relative path")
    if {part.casefold() for part in path.parts} & OVERLAY_PARTS:
        raise TrainingExportError(f"{location}: QA/diagnostic path is forbidden")
    return path.as_posix()


def resolve_inside(root: Path, relative: str, location: str) -> Path:
    candidate = root.joinpath(*PurePosixPath(relative).parts).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise TrainingExportError(
            f"{location}: path escaped its source root"
        ) from error
    if not candidate.is_file():
        raise TrainingExportError(f"{location}: referenced file does not exist")
    return candidate


def nested(value: Mapping[str, Any], *parts: str) -> Any:
    current: Any = value
    for part in parts:
        if not isinstance(current, Mapping):
            return None
        current = current.get(part)
    return current


def contains_overlay_flag(value: Any, *, key: str = "") -> bool:
    if key.casefold() in OVERLAY_KEYS and value is True:
        return True
    if isinstance(value, Mapping):
        return any(
            contains_overlay_flag(child, key=str(child_key))
            for child_key, child in value.items()
        )
    if isinstance(value, list):
        return any(contains_overlay_flag(child, key=key) for child in value)
    return False


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TrainingExportError(
            f"{location}: could not read JSON: {error}"
        ) from error
    return dict(require_mapping(value, location))


def read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as error:
        raise TrainingExportError(
            f"{location}: could not read JSONL: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise TrainingExportError(
                    f"{location}:{line_number}: invalid JSON: {error}"
                ) from error
            rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    return rows


def load_registry_contract(path: Path) -> RegistryContract:
    resolved = path.resolve()
    try:
        configuration = master_builder.load_catalog_registry(resolved)
    except (master_builder.MasterManifestError, OSError) as error:
        raise TrainingExportError(
            f"catalog registry is not complete and valid: {error}"
        ) from error
    attestation = require_mapping(
        configuration.input_attestation, "catalog registry attestation"
    )
    registry_binding = require_mapping(
        attestation.get("catalog_registry"),
        "catalog registry attestation.catalog_registry",
    )
    registry_sha256 = require_sha(
        registry_binding.get("sha256"),
        "catalog registry attestation.catalog_registry.sha256",
    )
    if registry_sha256 != sha256_file(resolved):
        raise TrainingExportError("catalog registry SHA binding failed")
    record_sha256 = require_sha(
        registry_binding.get("record_sha256"),
        "catalog registry attestation.catalog_registry.record_sha256",
    )
    parent_binding = attestation.get("parent_master")
    parent_master_manifest_sha256: str | None = None
    if parent_binding is not None:
        parent_master_manifest_sha256 = require_sha(
            require_mapping(
                parent_binding, "catalog registry attestation.parent_master"
            ).get("manifest_sha256"),
            "catalog registry attestation.parent_master.manifest_sha256",
        )
    excluded_parent_ids = [
        require_id(
            exclusion.parent_master_id,
            "catalog registry exclusion.parent_master_id",
        )
        for exclusion in configuration.exclusions.values()
    ]
    if len(excluded_parent_ids) != len(set(excluded_parent_ids)):
        raise TrainingExportError("catalog registry reuses an excluded parent ID")
    verified_parent_ids: set[str] = set()
    invalidated_parent_ids: set[str] = set()
    raw_ledger_bindings = attestation.get("exclusion_ledgers", [])
    if not isinstance(raw_ledger_bindings, list):
        raise TrainingExportError(
            "catalog registry attestation.exclusion_ledgers must be an array"
        )
    for ledger_index, raw_binding in enumerate(raw_ledger_bindings, 1):
        binding = require_mapping(
            raw_binding,
            f"catalog registry attestation.exclusion_ledgers[{ledger_index}]",
        )
        ledger_path = Path(
            require_text(
                binding.get("path"),
                f"catalog registry exclusion ledger[{ledger_index}].path",
            )
        ).resolve()
        expected_sha = require_sha(
            binding.get("sha256"),
            f"catalog registry exclusion ledger[{ledger_index}].sha256",
        )
        if sha256_file(ledger_path) != expected_sha:
            raise TrainingExportError(
                f"catalog registry exclusion ledger changed: {ledger_path}"
            )
        ledger_rows = read_jsonl(
            ledger_path, f"catalog registry exclusion ledger[{ledger_index}]"
        )
        if binding.get("record_count") != len(ledger_rows):
            raise TrainingExportError(
                f"catalog registry exclusion ledger[{ledger_index}] count changed"
            )
        for row_index, row in enumerate(ledger_rows, 1):
            parent_id = require_id(
                row.get("parent_master_id"),
                "catalog registry exclusion ledger"
                f"[{ledger_index}][{row_index}].parent_master_id",
            )
            if parent_id in verified_parent_ids:
                raise TrainingExportError(
                    f"catalog registry repeats excluded parent {parent_id}"
                )
            verified_parent_ids.add(parent_id)
            invalidated = row.get("prior_final_labels_invalidated")
            if not isinstance(invalidated, bool):
                raise TrainingExportError(
                    f"{parent_id}: prior_final_labels_invalidated must be boolean"
                )
            if invalidated:
                invalidated_parent_ids.add(parent_id)
    if verified_parent_ids != set(excluded_parent_ids):
        raise TrainingExportError(
            "catalog registry exclusion attestation differs from loaded exclusions"
        )
    catalog_source_kinds = {
        catalog.catalog_id: catalog.source_kind for catalog in configuration.catalogs
    }
    return RegistryContract(
        catalog_source_kinds=dict(sorted(catalog_source_kinds.items())),
        expected_counts=dict(sorted(configuration.expected_counts.items())),
        expected_total=configuration.expected_total,
        excluded_parent_ids=frozenset(excluded_parent_ids),
        invalidated_parent_ids=frozenset(invalidated_parent_ids),
        input_attestation=copy.deepcopy(dict(attestation)),
        parent_master_manifest_sha256=parent_master_manifest_sha256,
        record_sha256=record_sha256,
        registry_sha256=registry_sha256,
        source_configuration=configuration,
    )


def validate_view_descriptor(
    value: Any, *, view_name: str, location: str
) -> dict[str, Any]:
    descriptor = copy.deepcopy(dict(require_mapping(value, location)))
    if contains_overlay_flag(descriptor):
        raise TrainingExportError(f"{location}: QA overlay metadata is forbidden")
    status = require_text(descriptor.get("status"), f"{location}.status")
    require_text(descriptor.get("catalog_id"), f"{location}.catalog_id")
    if descriptor.get("expected_size_px") != [224, 224]:
        raise TrainingExportError(f"{location}: expected_size_px must be 224x224")
    if status == "available":
        safe_relative_path(descriptor.get("path"), f"{location}.path")
        require_sha(descriptor.get("file_sha256"), f"{location}.file_sha256")
    elif status == "derivable" and view_name == "raw_224":
        if (
            descriptor.get("path") is not None
            or descriptor.get("file_sha256") is not None
        ):
            raise TrainingExportError(
                f"{location}: derivable view must not fake an asset"
            )
        native = require_mapping(
            descriptor.get("source_native"), f"{location}.source_native"
        )
        safe_relative_path(native.get("path"), f"{location}.source_native.path")
        require_sha(native.get("file_sha256"), f"{location}.source_native.file_sha256")
        recipe = require_mapping(
            descriptor.get("materialization_recipe"), f"{location}.recipe"
        )
        if recipe.get("algorithm") != "fontclip-letterbox-rgb-v1":
            raise TrainingExportError(f"{location}: unsupported derivation recipe")
    else:
        raise TrainingExportError(
            f"{location}: all training views must be available or deterministically derivable"
        )
    return descriptor


def read_master_rows(
    path: Path, *, registry: RegistryContract | None = None
) -> tuple[list[dict[str, Any]], dict[str, str], str]:
    rows = read_jsonl(path, "master manifest")
    if not rows:
        raise TrainingExportError("master manifest is empty")
    output: list[dict[str, Any]] = []
    work_splits: dict[str, str] = {}
    component_splits: dict[str, str] = {}
    catalog_counts: Counter[str] = Counter()
    seen: set[str] = set()
    for index, row in enumerate(rows, 1):
        location = f"master[{index}]"
        sample_id = require_id(row.get("id"), f"{location}.id")
        if sample_id in seen:
            raise TrainingExportError(f"{location}: duplicate sample_id")
        seen.add(sample_id)
        provenance = require_mapping(row.get("provenance"), f"{location}.provenance")
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
            or contains_overlay_flag(row)
        ):
            raise TrainingExportError(
                f"{sample_id}: synthetic or QA-overlay master rows are forbidden"
            )
        source_catalog_value = provenance.get("source_catalog_id")
        source_kind_value = provenance.get("source_kind")
        source_catalog_id: str | None = None
        source_kind: str | None = None
        if source_catalog_value is not None or source_kind_value is not None:
            source_catalog_id = require_id(
                source_catalog_value, f"{location}.provenance.source_catalog_id"
            )
            source_kind = require_text(
                source_kind_value, f"{location}.provenance.source_kind"
            )
            if source_kind not in {"base", "hard"}:
                raise TrainingExportError(
                    f"{location}.provenance.source_kind must be base or hard"
                )
        if registry is not None:
            if source_catalog_id is None or source_kind is None:
                raise TrainingExportError(
                    f"{sample_id}: registry-attested master lacks source provenance"
                )
            expected_kind = registry.catalog_source_kinds.get(source_catalog_id)
            if expected_kind is None:
                raise TrainingExportError(
                    f"{sample_id}: master names catalog absent from registry: "
                    f"{source_catalog_id}"
                )
            if source_kind != expected_kind:
                raise TrainingExportError(
                    f"{sample_id}: master source_kind differs from registry"
                )
            catalog_counts[source_catalog_id] += 1
        work = require_mapping(row.get("work"), f"{location}.work")
        work_id = require_id(work.get("id"), f"{location}.work.id")
        split = require_text(row.get("split"), f"{location}.split")
        if split not in VALID_SPLITS:
            raise TrainingExportError(f"{location}.split is unsupported")
        previous = work_splits.setdefault(work_id, split)
        if previous != split:
            raise TrainingExportError(
                f"work-disjoint split violation for {work_id}: {previous}/{split}"
            )
        groups_value = row.get("groups")
        split_component: str | None = None
        if groups_value is not None:
            groups = require_mapping(groups_value, f"{location}.groups")
            split_component = require_id(
                groups.get("split_component"),
                f"{location}.groups.split_component",
            )
            component_split = component_splits.setdefault(split_component, split)
            if component_split != split:
                raise TrainingExportError(
                    "split-component leakage for "
                    f"{split_component}: {component_split}/{split}"
                )
        elif registry is not None:
            raise TrainingExportError(
                f"{sample_id}: registry-attested master lacks groups.split_component"
            )
        work_balance_value = row.get("work_balance_weight")
        work_balance_weight: float | None = None
        if work_balance_value is not None:
            if (
                not isinstance(work_balance_value, (int, float))
                or isinstance(work_balance_value, bool)
                or not math.isfinite(float(work_balance_value))
                or float(work_balance_value) <= 0.0
            ):
                raise TrainingExportError(
                    f"{location}.work_balance_weight must be finite and positive"
                )
            work_balance_weight = float(work_balance_value)
        elif registry is not None:
            raise TrainingExportError(
                f"{sample_id}: registry-attested master lacks work_balance_weight"
            )
        views_value = require_mapping(row.get("views"), f"{location}.views")
        if set(views_value) != set(VIEW_NAMES):
            raise TrainingExportError(
                f"{location}.views must contain the three model views"
            )
        views = {
            name: validate_view_descriptor(
                views_value[name], view_name=name, location=f"{location}.views.{name}"
            )
            for name in VIEW_NAMES
        }
        page = require_mapping(row.get("page"), f"{location}.page")
        chapter = require_mapping(row.get("chapter"), f"{location}.chapter")
        manual_recrop = (
            nested(row, "metadata", "cohort_signals", "manual_recrop") is True
        )
        output.append(
            {
                "chapter_id": require_id(chapter.get("id"), f"{location}.chapter.id"),
                "cohorts": copy.deepcopy(
                    nested(row, "metadata", "candidate_categories") or []
                ),
                "geometry": copy.deepcopy(row.get("geometry")),
                "manual_recrop": manual_recrop,
                "master_provenance": copy.deepcopy(dict(provenance)),
                "page_id": require_id(page.get("id"), f"{location}.page.id"),
                "sample_crop_sha256": require_sha(
                    row.get("sample_crop_sha256"),
                    f"{location}.sample_crop_sha256",
                ),
                "sample_id": sample_id,
                "source_page_sha256": require_sha(
                    page.get("source_page_sha256"),
                    f"{location}.page.source_page_sha256",
                ),
                "source_catalog_id": source_catalog_id,
                "source_kind": source_kind,
                "split": split,
                "split_component": split_component,
                "views": views,
                "work_balance_weight": work_balance_weight,
                "work_id": work_id,
            }
        )
    if registry is not None:
        expected_counts = {
            catalog_id: count
            for catalog_id, count in registry.expected_counts.items()
            if count
        }
        if dict(sorted(catalog_counts.items())) != expected_counts:
            raise TrainingExportError(
                "master catalog counts differ from the sealed registry"
            )
        if len(output) != registry.expected_total:
            raise TrainingExportError(
                "master row count differs from the sealed registry: "
                f"{len(output)} != {registry.expected_total}"
            )
        leaked_exclusions = sorted(
            registry.excluded_parent_ids & {row["sample_id"] for row in output}
        )
        if leaked_exclusions:
            raise TrainingExportError(
                "excluded parent records leaked into the registry-attested master: "
                f"{leaked_exclusions[:8]}"
            )
    output.sort(key=lambda row: row["sample_id"])
    return output, work_splits, sha256_file(path)


def validate_registry_master_report(
    master_manifest: Path,
    *,
    master_manifest_sha256: str,
    registry: RegistryContract,
) -> tuple[str, str]:
    resolved_manifest = master_manifest.resolve()
    if resolved_manifest.name != "manifest.jsonl":
        raise TrainingExportError(
            "registry-attested master manifest must be named manifest.jsonl"
        )
    report_path = resolved_manifest.with_name("report.json")
    split_map_path = resolved_manifest.with_name("split_map.json")
    report = read_json(report_path, "master report")
    if report.get("tool") != master_builder.TOOL_ID:
        raise TrainingExportError("master report ownership marker is invalid")
    if nested(report, "outputs", "master_manifest_sha256") != master_manifest_sha256:
        raise TrainingExportError("master report binds another manifest")
    split_map_sha256 = sha256_file(split_map_path)
    if nested(report, "outputs", "split_map_sha256") != split_map_sha256:
        raise TrainingExportError("master report binds another split map")
    if nested(report, "inputs", "attestation") != registry.input_attestation:
        raise TrainingExportError(
            "master report attestation differs from the sealed registry"
        )
    if nested(report, "statistics", "record_count") != registry.expected_total:
        raise TrainingExportError(
            "master report row count differs from the sealed registry"
        )
    reported_catalogs = require_mapping(
        nested(report, "inputs", "catalogs"), "master report.inputs.catalogs"
    )
    if set(reported_catalogs) != set(registry.catalog_source_kinds):
        raise TrainingExportError(
            "master report catalog inventory differs from the sealed registry"
        )
    for catalog_id, source_kind in registry.catalog_source_kinds.items():
        catalog = require_mapping(
            reported_catalogs.get(catalog_id),
            f"master report.inputs.catalogs[{catalog_id!r}]",
        )
        if catalog.get("catalog_id") != catalog_id:
            raise TrainingExportError(
                f"master report catalog identity differs for {catalog_id}"
            )
        if catalog.get("source_kind") != source_kind:
            raise TrainingExportError(
                f"master report source_kind differs for {catalog_id}"
            )
        if catalog.get("record_count") != registry.expected_counts[catalog_id]:
            raise TrainingExportError(
                f"master report record count differs for {catalog_id}"
            )
    expected_by_catalog = {
        catalog_id: count
        for catalog_id, count in registry.expected_counts.items()
        if count
    }
    if nested(report, "statistics", "by_catalog") != expected_by_catalog:
        raise TrainingExportError(
            "master report catalog statistics differ from the sealed registry"
        )
    expected_by_source_kind: Counter[str] = Counter()
    for catalog_id, count in registry.expected_counts.items():
        expected_by_source_kind[registry.catalog_source_kinds[catalog_id]] += count
    normalized_by_source_kind = {
        source_kind: count
        for source_kind, count in sorted(expected_by_source_kind.items())
        if count
    }
    if nested(report, "statistics", "by_source_kind") != normalized_by_source_kind:
        raise TrainingExportError(
            "master report source-kind statistics differ from the sealed registry"
        )
    configuration = registry.source_configuration
    try:
        validation = master_builder.validate_master(
            resolved_manifest.parent,
            configuration.catalogs,
            expected_total=configuration.expected_total,
            verify_assets=False,
            expected_counts=configuration.expected_counts,
            expected_physical_counts=configuration.expected_physical_counts,
            exclusions=configuration.exclusions,
            frozen_split_map=configuration.frozen_split_map,
            input_attestation=configuration.input_attestation,
        )
    except (master_builder.MasterManifestError, OSError) as error:
        raise TrainingExportError(
            f"registry-attested master is not reproducible: {error}"
        ) from error
    if validation.get("manifest_sha256") != master_manifest_sha256:
        raise TrainingExportError(
            "deep master validation returned another manifest hash"
        )
    return sha256_file(report_path), split_map_sha256


def _validate_render_artifact(
    render: Mapping[str, Any], *, bank_root: Path, location: str
) -> dict[str, Any]:
    artifact = require_mapping(render.get("artifact"), f"{location}.artifact")
    if artifact.get("qa_overlay") is not False or contains_overlay_flag(render):
        raise TrainingExportError(f"{location}: QA-overlay render is forbidden")
    relative = safe_relative_path(artifact.get("file"), f"{location}.artifact.file")
    expected = require_sha(artifact.get("sha256"), f"{location}.artifact.sha256")
    physical = resolve_inside(bank_root, relative, f"{location}.artifact.file")
    if sha256_file(physical) != expected:
        raise TrainingExportError(f"{location}: render artifact hash mismatch")
    readiness = require_mapping(render.get("readiness"), f"{location}.readiness")
    if readiness.get("document_fonts_ready") is not True:
        raise TrainingExportError(f"{location}: render was captured before fonts.ready")
    fallback = require_mapping(
        render.get("fallback_detection"), f"{location}.fallback_detection"
    )
    if fallback.get("status") != "passed":
        raise TrainingExportError(f"{location}: fallback detection did not pass")
    if render.get("font_weight") != 400 or render.get("font_style") != "normal":
        raise TrainingExportError(
            f"{location}: prototype must use the production 400 normal face"
        )
    writing_mode = require_text(render.get("writing_mode"), f"{location}.writing_mode")
    if writing_mode not in {"horizontal", "vertical"}:
        raise TrainingExportError(f"{location}: writing_mode is unsupported")
    return {
        "artifact_path": relative,
        "artifact_sha256": expected,
        "probe_id": require_id(render.get("probe_id"), f"{location}.probe_id"),
        "render_id": require_id(render.get("render_id"), f"{location}.render_id"),
        "writing_mode": writing_mode,
    }


def read_render_bank_rows(
    path: Path, *, expected_candidate_count: int
) -> tuple[list[dict[str, Any]], tuple[str, ...], str, str]:
    document = read_json(path, "render bank")
    if document.get("schema_version") != "font-render-bank-v1":
        raise TrainingExportError("render bank schema is unsupported")
    if nested(document, "render_spec", "qa_overlay") is not False:
        raise TrainingExportError("render bank render_spec must be overlay-free")
    specification_sha = require_sha(
        document.get("specification_sha256"), "render_bank.specification_sha256"
    )
    candidates_value = document.get("candidates")
    renders_value = document.get("renders")
    if not isinstance(candidates_value, list) or not isinstance(renders_value, list):
        raise TrainingExportError("render bank candidates/renders are invalid")
    canonical: list[dict[str, Any]] = []
    for index, raw in enumerate(candidates_value):
        candidate = require_mapping(raw, f"render_bank.candidates[{index}]")
        if candidate.get("production_400_normal_canonical") is not True:
            continue
        if contains_overlay_flag(candidate):
            raise TrainingExportError(
                "canonical candidate contains QA overlay metadata"
            )
        canonical.append(copy.deepcopy(dict(candidate)))
    if len(canonical) != expected_candidate_count:
        raise TrainingExportError(
            f"expected {expected_candidate_count} canonical candidates, got {len(canonical)}"
        )
    ids = [
        require_id(value.get("font_id"), f"canonical[{index}].font_id")
        for index, value in enumerate(canonical)
    ]
    if len(ids) != len(set(ids)):
        raise TrainingExportError("canonical font IDs are duplicated")
    by_display: dict[str, list[Mapping[str, Any]]] = {}
    for index, raw in enumerate(renders_value):
        render = require_mapping(raw, f"render_bank.renders[{index}]")
        display_id = require_text(
            render.get("candidate_display_id"),
            f"render_bank.renders[{index}].candidate_display_id",
        )
        by_display.setdefault(display_id, []).append(render)
    rows: list[dict[str, Any]] = []
    for index, candidate in enumerate(canonical):
        location = f"canonical[{index}]"
        font_id = require_id(candidate.get("font_id"), f"{location}.font_id")
        display_id = require_text(candidate.get("display_id"), f"{location}.display_id")
        status = require_mapping(
            candidate.get("production_asset_status"),
            f"{location}.production_asset_status",
        )
        if (
            candidate.get("render_style") != "normal"
            or candidate.get("render_weight") != 400
        ):
            raise TrainingExportError(
                f"{font_id}: canonical candidate must be the production 400 normal face"
            )
        compatible = status.get("chromium_ots_compatible") is True
        allowed_modes = candidate.get("allowed_writing_modes")
        if (
            not isinstance(allowed_modes, list)
            or not allowed_modes
            or any(mode not in {"horizontal", "vertical"} for mode in allowed_modes)
            or len(allowed_modes) != len(set(allowed_modes))
        ):
            raise TrainingExportError(
                f"{font_id}: allowed_writing_modes must be unique horizontal/vertical modes"
            )
        render_refs = [
            _validate_render_artifact(
                render,
                bank_root=path.parent,
                location=f"{location}.renders[{render_index}]",
            )
            for render_index, render in enumerate(
                sorted(
                    by_display.get(display_id, []),
                    key=lambda value: (
                        str(value.get("writing_mode")),
                        str(value.get("probe_id")),
                    ),
                )
            )
        ]
        if any(ref["writing_mode"] not in allowed_modes for ref in render_refs):
            raise TrainingExportError(
                f"{font_id}: render prototype uses a forbidden writing mode"
            )
        if compatible and not render_refs:
            raise TrainingExportError(
                f"{font_id}: compatible canonical candidate has no render prototypes"
            )
        rows.append(
            seal(
                {
                    "allowed_writing_modes": sorted(allowed_modes),
                    "blind_alias": require_id(
                        candidate.get("blind_alias"), f"{location}.blind_alias"
                    ),
                    "display_id": display_id,
                    "face_id": require_id(
                        candidate.get("face_id"), f"{location}.face_id"
                    ),
                    "font_id": font_id,
                    "production_400_normal_canonical": True,
                    "production_asset_status": copy.deepcopy(dict(status)),
                    "render_prototypes": render_refs,
                    "render_style": require_text(
                        candidate.get("render_style"), f"{location}.render_style"
                    ),
                    "render_weight": candidate.get("render_weight"),
                    "schema_version": PROTOTYPE_SCHEMA_VERSION,
                    "source_file": safe_relative_path(
                        candidate.get("source_file"), f"{location}.source_file"
                    ),
                    "source_font_sha256": require_sha(
                        candidate.get("source_sha256"), f"{location}.source_sha256"
                    ),
                }
            )
        )
    rows.sort(key=lambda row: row["font_id"])
    return rows, tuple(sorted(ids)), sha256_file(path), specification_sha


def _review_provenance(
    final: Mapping[str, Any],
    *,
    review_by_label: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    resolution = require_mapping(final.get("resolution"), "final.resolution")
    review_rows: list[dict[str, Any]] = []
    for label_id in resolution.get("source_label_ids", []):
        review = review_by_label.get(str(label_id))
        if review is None:
            raise TrainingExportError(
                f"final references missing review label {label_id!r}"
            )
        event = require_mapping(review.get("review"), f"review[{label_id}].review")
        review_rows.append(
            {
                "assignment_id": event["assignment_id"],
                "candidate_order_seed": event["candidate_order_seed"],
                "catalog_sha256": event["catalog_sha256"],
                "catalog_version": event["catalog_version"],
                "confidence": event["confidence"],
                "flags": copy.deepcopy(event["flags"]),
                "label_id": label_id,
                "record_sha256": review["record_sha256"],
                "renderer_hash": event["renderer_hash"],
                "review_card_sha256": event["review_card_sha256"],
                "reviewed_at": event["reviewed_at"],
                "reviewer": event["reviewer"],
                "stage": event["stage"],
            }
        )
    review_rows.sort(
        key=lambda row: (labels.REVIEW_STAGES.index(row["stage"]), row["label_id"])
    )
    return {
        "final_record_sha256": final["record_sha256"],
        "resolution": copy.deepcopy(dict(resolution)),
        "source_reviews": review_rows,
        "review_card_used_as_training_input": False,
    }


def build_sample_rows(
    master_rows: Sequence[Mapping[str, Any]],
    *,
    final_by_sample: Mapping[str, Mapping[str, Any]],
    review_by_label: Mapping[str, Mapping[str, Any]],
    candidate_ids: Sequence[str],
    master_manifest_sha256: str,
    render_bank_manifest_sha256: str,
    render_specification_sha256: str,
    font_catalog_sha256: str,
    renderer_hash: str,
    catalog_registry_sha256: str | None = None,
) -> list[dict[str, Any]]:
    candidate_set = set(candidate_ids)
    output: list[dict[str, Any]] = []
    for master in master_rows:
        sample_id = str(master["sample_id"])
        final = final_by_sample.get(sample_id)
        if final is None:
            raise TrainingExportError(f"{sample_id}: missing final label")
        try:
            labels.validate_final_record(final, candidate_ids=candidate_ids)
        except labels.LabelValidationError as error:
            raise TrainingExportError(
                f"{sample_id}: invalid final label: {error}"
            ) from error
        if final.get("work_id") != master["work_id"]:
            raise TrainingExportError(
                f"{sample_id}: final/master work binding mismatch"
            )
        if final.get("source_page_sha256") != master["source_page_sha256"]:
            raise TrainingExportError(
                f"{sample_id}: final/master page binding mismatch"
            )
        judgment = require_mapping(
            final.get("font_judgment"), f"{sample_id}.font_judgment"
        )
        partition = [
            candidate for tier in labels.FONT_TIERS for candidate in judgment[tier]
        ]
        if len(partition) != len(candidate_set) or set(partition) != candidate_set:
            raise TrainingExportError(
                f"{sample_id}: final tiers do not partition the catalog"
            )
        if judgment["not_reviewed"]:
            raise TrainingExportError(f"{sample_id}: final label is not fully reviewed")
        has_positive = bool(judgment["preferred"] or judgment["acceptable"])
        if bool(judgment["none_acceptable"]) == has_positive:
            raise TrainingExportError(f"{sample_id}: abstention semantics are invalid")
        resolution = require_mapping(final.get("resolution"), f"{sample_id}.resolution")
        if resolution.get("catalog_sha256") != font_catalog_sha256:
            raise TrainingExportError(f"{sample_id}: final uses another font catalog")
        if resolution.get("renderer_hash") != renderer_hash:
            raise TrainingExportError(f"{sample_id}: final uses another renderer")
        input_bindings = {
            "font_catalog_sha256": font_catalog_sha256,
            "master_manifest_sha256": master_manifest_sha256,
            "render_bank_manifest_sha256": render_bank_manifest_sha256,
            "render_specification_sha256": render_specification_sha256,
            "renderer_hash": renderer_hash,
        }
        if catalog_registry_sha256 is not None:
            input_bindings["catalog_registry_sha256"] = catalog_registry_sha256
        provenance = {
            "approval": "completed_human_final_label",
            "master": copy.deepcopy(master["master_provenance"]),
            "qa_overlay": False,
            "synthetic": False,
        }
        if master["source_catalog_id"] is not None:
            provenance["source_catalog_id"] = master["source_catalog_id"]
            provenance["source_kind"] = master["source_kind"]
        sample_record = {
            "chapter_id": master["chapter_id"],
            "cohorts": copy.deepcopy(master["cohorts"]),
            "consistency": copy.deepcopy(final["consistency"]),
            "example_id": "fmts-"
            + stable_hash("font-matching-training-sample-v1", sample_id)[:32],
            "font_judgment": copy.deepcopy(dict(judgment)),
            "input_bindings": input_bindings,
            "manual_recrop": bool(master["manual_recrop"]),
            "page_id": master["page_id"],
            "provenance": provenance,
            "review_provenance": _review_provenance(
                final, review_by_label=review_by_label
            ),
            "role": copy.deepcopy(final["role"]),
            "sample_id": sample_id,
            "schema_version": SAMPLE_SCHEMA_VERSION,
            "source": {
                "geometry": copy.deepcopy(master["geometry"]),
                "sample_crop_sha256": master["sample_crop_sha256"],
                "source_page_sha256": master["source_page_sha256"],
                "views": copy.deepcopy(master["views"]),
            },
            "source_style": copy.deepcopy(final["source_style"]),
            "split": master["split"],
            "treatment": copy.deepcopy(final["treatment"]),
            "work_id": master["work_id"],
        }
        if master["split_component"] is not None:
            sample_record["groups"] = {"split_component": master["split_component"]}
        if master["work_balance_weight"] is not None:
            sample_record["work_balance_weight"] = master["work_balance_weight"]
        output.append(seal(sample_record))
    if set(final_by_sample) != {row["sample_id"] for row in output}:
        extras = sorted(set(final_by_sample) - {row["sample_id"] for row in output})
        raise TrainingExportError(
            f"final ledger contains unknown samples: {extras[:8]}"
        )
    output.sort(key=lambda row: row["sample_id"])
    return output


def _source_style_cluster(source_style: Mapping[str, Any]) -> dict[str, Any]:
    """Build an identity-free, deterministic cluster from reviewed style axes."""

    unknown_fields_value = source_style.get("unknown_fields")
    unknown_fields = (
        set(unknown_fields_value) if isinstance(unknown_fields_value, list) else set()
    )
    axis_bins: dict[str, int | None] = {}
    for field in labels.STYLE_FIELDS:
        value = source_style.get(field)
        if field in unknown_fields or value is None:
            axis_bins[field] = None
            continue
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            or not 0.0 <= float(value) <= 1.0
        ):
            raise TrainingExportError(
                f"source_style.{field}: expected a finite value from 0 to 1"
            )
        axis_bins[field] = min(4, max(0, int(math.floor(float(value) * 4.0 + 0.5))))
    fingerprint = {
        "algorithm": SOURCE_STYLE_CLUSTER_ALGORITHM,
        "axis_bins": axis_bins,
    }
    fingerprint_sha256 = sha256_bytes(
        json.dumps(
            fingerprint, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )
    return {
        **fingerprint,
        "cluster_id": f"fmsc-{fingerprint_sha256[:24]}",
        "fingerprint_sha256": fingerprint_sha256,
    }


def _style_score(sample: Mapping[str, Any], field: str) -> float:
    value = nested(sample, "source_style", field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value)


def _manual_recrop(sample: Mapping[str, Any]) -> bool:
    if sample.get("manual_recrop") is True:
        return True
    flags = nested(sample, "review_provenance", "resolution", "flags")
    if isinstance(flags, list) and "manual_recrop_resolved" in flags:
        return True
    source_reviews = nested(sample, "review_provenance", "source_reviews")
    return isinstance(source_reviews, list) and any(
        isinstance(review, Mapping)
        and isinstance(review.get("flags"), list)
        and "manual_recrop" in review["flags"]
        for review in source_reviews
    )


def _body_dialogue_protection_reasons(sample: Mapping[str, Any]) -> list[str]:
    if sample.get("split") != "train":
        return ["evaluation_split_unchanged"]
    role = nested(sample, "role", "primary")
    if role != "dialogue":
        return ["variant_role" if role in VARIANT_ROLES else "non_dialogue_role"]

    reasons: list[str] = []
    if _style_score(sample, "handwritten") >= HIGH_VARIANT_STYLE_THRESHOLD:
        reasons.append("handwritten")
    if _style_score(sample, "irregularity") >= HIGH_VARIANT_STYLE_THRESHOLD:
        reasons.append("irregular")
    consistency = sample.get("consistency")
    if isinstance(consistency, Mapping) and (
        consistency.get("policy") == "intentional_override"
        or consistency.get("action") == "local_override"
    ):
        reasons.append("source_family_override")
    if _manual_recrop(sample):
        reasons.append("manual_recrop")
    treatment = sample.get("treatment")
    if isinstance(treatment, Mapping) and any(
        treatment.get(field) != value for field, value in PLAIN_TREATMENT.items()
    ):
        reasons.append("noncanonical_treatment")
    if isinstance(treatment, Mapping) and treatment.get("orientation") in {
        "mixed",
        "unknown",
    }:
        reasons.append("noncanonical_orientation")
    if nested(sample, "font_judgment", "none_acceptable") is True:
        reasons.append("catalog_gap_or_abstention")
    return sorted(set(reasons))


def _geometry_signature(sample: Mapping[str, Any]) -> tuple[int, int, int] | None:
    geometry = nested(sample, "source", "geometry")
    if not isinstance(geometry, Mapping):
        return None
    bbox: Sequence[Any] | None = None
    for field in (
        "mask_tight_bbox_px",
        "bbox_px",
        "crop_bbox_px",
        "final_bbox_px",
    ):
        candidate = geometry.get(field)
        if isinstance(candidate, list) and len(candidate) == 4:
            bbox = candidate
            break
    if bbox is None or any(
        isinstance(value, bool) or not isinstance(value, (int, float)) for value in bbox
    ):
        return None
    width = float(bbox[2]) - float(bbox[0])
    height = float(bbox[3]) - float(bbox[1])
    if width <= 0.0 or height <= 0.0:
        return None
    aspect_bucket = min(
        12, max(-12, int(math.floor(math.log2(width / height) * 2.0 + 0.5)))
    )
    page_size = geometry.get("page_size_px")
    if (
        isinstance(page_size, list)
        and len(page_size) == 2
        and all(
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and float(value) > 0.0
            for value in page_size
        )
    ):
        width_bucket = min(20, int(math.floor(width / float(page_size[0]) * 20.0)))
        height_bucket = min(20, int(math.floor(height / float(page_size[1]) * 20.0)))
    else:
        width_bucket = min(20, int(math.floor(math.log2(width + 1.0))))
        height_bucket = min(20, int(math.floor(math.log2(height + 1.0))))
    return aspect_bucket, width_bucket, height_bucket


def _quality_sort_key(
    sample: Mapping[str, Any],
) -> tuple[float, float, float, int, str]:
    declared_label_quality = nested(sample, "label_quality", "weight")
    if declared_label_quality is None:
        declared_label_quality = nested(sample, "label_quality", "confidence")
    resolution_confidence = nested(
        sample, "review_provenance", "resolution", "confidence"
    )
    role_confidence = nested(sample, "role", "confidence")
    label_quality_score = (
        float(declared_label_quality)
        if isinstance(declared_label_quality, (int, float))
        and not isinstance(declared_label_quality, bool)
        and math.isfinite(float(declared_label_quality))
        else 0.0
    )
    resolution_score = (
        float(resolution_confidence)
        if isinstance(resolution_confidence, (int, float))
        and not isinstance(resolution_confidence, bool)
        and math.isfinite(float(resolution_confidence))
        else 0.0
    )
    role_score = (
        float(role_confidence)
        if isinstance(role_confidence, (int, float))
        and not isinstance(role_confidence, bool)
        and math.isfinite(float(role_confidence))
        else 0.0
    )
    return (
        -label_quality_score,
        -resolution_score,
        -role_score,
        0 if _geometry_signature(sample) is not None else 1,
        stable_hash(
            BODY_DIALOGUE_DEDUPLICATION_SCHEMA_VERSION,
            str(sample.get("sample_id")),
        ),
    )


def _geometry_control_sort_key(
    sample: Mapping[str, Any], selected: Sequence[Mapping[str, Any]]
) -> tuple[float, float, float, float, int, str]:
    signature = _geometry_signature(sample)
    selected_signatures = [
        candidate
        for candidate in (_geometry_signature(row) for row in selected)
        if candidate is not None
    ]
    if signature is None or not selected_signatures:
        distance = 0.0
    else:
        distance = float(
            min(
                sum(abs(left - right) for left, right in zip(signature, reference))
                for reference in selected_signatures
            )
        )
    quality = _quality_sort_key(sample)
    return (-distance, *quality)


def _body_dialogue_group_key(sample: Mapping[str, Any]) -> tuple[str, ...]:
    return (
        str(sample.get("work_id")),
        str(sample.get("chapter_id")),
        str(nested(sample, "role", "primary")),
        str(nested(sample, "treatment", "orientation")),
        str(nested(sample, "source_style_cluster", "cluster_id")),
    )


def deduplicate_body_dialogue_samples(
    samples: Sequence[Mapping[str, Any]], *, cap: int = BODY_DIALOGUE_CAP
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Cap only redundant train dialogue while retaining hard/variant evidence."""

    if isinstance(cap, bool) or not isinstance(cap, int) or cap < 1:
        raise TrainingExportError("body dialogue cap must be a positive integer")
    prepared: list[dict[str, Any]] = []
    for sample in samples:
        row = copy.deepcopy(dict(sample))
        row.pop("record_sha256", None)
        row["source_style_cluster"] = _source_style_cluster(
            require_mapping(row.get("source_style"), "training sample.source_style")
        )
        prepared.append(row)

    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    retained: dict[str, tuple[str, list[str]]] = {}
    protection_counts: Counter[str] = Counter()
    for row in prepared:
        sample_id = require_id(row.get("sample_id"), "training sample.sample_id")
        reasons = _body_dialogue_protection_reasons(row)
        if reasons:
            retained[sample_id] = ("protected", reasons)
            protection_counts.update(reasons)
            continue
        groups.setdefault(_body_dialogue_group_key(row), []).append(row)

    capped_group_count = 0
    selection_slot_counts: Counter[str] = Counter()
    for group_rows in groups.values():
        ordered = sorted(group_rows, key=_quality_sort_key)
        if len(ordered) > cap:
            capped_group_count += 1
        selected: list[dict[str, Any]] = []
        if ordered:
            selected.append(ordered.pop(0))
            reason = "canonical_quality"
            retained[str(selected[-1]["sample_id"])] = (reason, [])
            selection_slot_counts[reason] += 1
        if ordered and len(selected) < cap:
            canonical_page = str(selected[0].get("page_id"))
            different_page = next(
                (
                    candidate
                    for candidate in ordered
                    if str(candidate.get("page_id")) != canonical_page
                ),
                None,
            )
            positive = different_page if different_page is not None else ordered[0]
            ordered.remove(positive)
            selected.append(positive)
            reason = (
                "chapter_consistency_positive"
                if different_page is not None
                else "same_page_diversity_fallback"
            )
            retained[str(positive["sample_id"])] = (reason, [])
            selection_slot_counts[reason] += 1
        if ordered and len(selected) < cap:
            control = sorted(
                ordered,
                key=lambda candidate: _geometry_control_sort_key(candidate, selected),
            )[0]
            ordered.remove(control)
            selected.append(control)
            reason = "geometry_treatment_control"
            retained[str(control["sample_id"])] = (reason, [])
            selection_slot_counts[reason] += 1
        while ordered and len(selected) < cap:
            fallback = ordered.pop(0)
            selected.append(fallback)
            reason = "quality_fallback"
            retained[str(fallback["sample_id"])] = (reason, [])
            selection_slot_counts[reason] += 1

    output: list[dict[str, Any]] = []
    preservation_counts: Counter[str] = Counter()
    retained_cap_counts: Counter[tuple[str, ...]] = Counter()
    for row in prepared:
        sample_id = str(row["sample_id"])
        retained_entry = retained.get(sample_id)
        if retained_entry is None:
            continue
        retention_reason, protection_reasons = retained_entry
        group_key = _body_dialogue_group_key(row)
        cap_eligible = not protection_reasons
        if cap_eligible:
            retained_cap_counts[group_key] += 1
        preservation_counts[retention_reason] += 1
        row["training_selection"] = {
            "algorithm": BODY_DIALOGUE_DEDUPLICATION_SCHEMA_VERSION,
            "cap": cap,
            "cap_eligible": cap_eligible,
            "group_key_sha256": stable_hash(
                BODY_DIALOGUE_DEDUPLICATION_SCHEMA_VERSION, *group_key
            ),
            "protection_reasons": protection_reasons,
            "retention_reason": retention_reason,
        }
        output.append(seal(row))
    output.sort(key=lambda row: row["sample_id"])

    cap_violation_count = sum(
        retained_count > cap for retained_count in retained_cap_counts.values()
    )
    if cap_violation_count:
        raise TrainingExportError("body dialogue cap invariant failed")
    before_eval_ids = {
        str(row["sample_id"]) for row in prepared if row.get("split") in {"val", "test"}
    }
    after_ids = {str(row["sample_id"]) for row in output}
    if not before_eval_ids <= after_ids:
        raise TrainingExportError("body dialogue cap removed evaluation samples")
    dropped_ids = sorted({str(row["sample_id"]) for row in prepared} - after_ids)
    before_by_split = Counter(str(row.get("split")) for row in prepared)
    after_by_split = Counter(str(row.get("split")) for row in output)
    statistics = {
        "after_by_split": dict(sorted(after_by_split.items())),
        "after_sample_count": len(output),
        "algorithm": BODY_DIALOGUE_DEDUPLICATION_SCHEMA_VERSION,
        "applied_split": "train",
        "before_by_split": dict(sorted(before_by_split.items())),
        "before_sample_count": len(prepared),
        "cap": cap,
        "canonical_quality_order": [
            "label_quality.weight_or_confidence_desc",
            "review_provenance.resolution.confidence_desc",
            "role.confidence_desc",
            "geometry_available",
            "stable_sample_hash",
        ],
        "cap_eligible_after_count": sum(retained_cap_counts.values()),
        "cap_eligible_before_count": sum(len(rows) for rows in groups.values()),
        "cap_excludes_protected_samples": True,
        "cap_violation_count": cap_violation_count,
        "capped_group_count": capped_group_count,
        "dropped_sample_count": len(dropped_ids),
        "dropped_sample_ids_sha256": sorted_ids_sha256(dropped_ids),
        "evaluation_splits_unchanged": True,
        "evaluation_sample_count_unchanged": len(before_eval_ids),
        "group_key_fields": [
            "work_id",
            "chapter_id",
            "role.primary",
            "treatment.orientation",
            "source_style_cluster.cluster_id",
        ],
        "group_count": len(groups),
        "max_cap_eligible_retained_per_group": max(
            retained_cap_counts.values(), default=0
        ),
        "preservation_reason_counts": dict(sorted(preservation_counts.items())),
        "protection_signal_counts": dict(sorted(protection_counts.items())),
        "selection_slot_counts": dict(sorted(selection_slot_counts.items())),
        "selection_slots": [
            "canonical_quality",
            "chapter_consistency_positive",
            "geometry_treatment_control",
        ],
        "source_style_cluster": {
            "algorithm": SOURCE_STYLE_CLUSTER_ALGORITHM,
            "axis_order": list(labels.STYLE_FIELDS),
            "binning": "nearest-quarter-0-through-4-with-explicit-null",
            "fingerprint": "sha256-canonical-json-v1",
        },
    }
    return output, statistics


def _chapter_pair_consistency_action(sample: Mapping[str, Any]) -> str:
    consistency = sample.get("consistency")
    if not isinstance(consistency, Mapping):
        return "undetermined"
    action = consistency.get("action")
    if action is None:
        action = {
            "inherit_work_anchor": "inherit_anchor",
            "intentional_override": "local_override",
        }.get(consistency.get("policy"), "undetermined")
    return str(action)


def _chapter_pair_positive_candidates(sample: Mapping[str, Any]) -> frozenset[str]:
    judgment = sample.get("font_judgment")
    if not isinstance(judgment, Mapping):
        return frozenset()
    preferred = judgment.get("preferred")
    acceptable = judgment.get("acceptable")
    if not isinstance(preferred, list) or not isinstance(acceptable, list):
        return frozenset()
    return frozenset(str(value) for value in [*preferred, *acceptable])


def _candidate_jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def _chapter_pair_priority(sample: Mapping[str, Any]) -> int:
    """Mirror the trainer's compatibility priority without importing it."""

    judgment = sample.get("font_judgment")
    source_style = sample.get("source_style")
    if not isinstance(judgment, Mapping) or not isinstance(source_style, Mapping):
        return 0
    unknown_fields = source_style.get("unknown_fields")
    if judgment.get("none_acceptable") is True or (
        isinstance(unknown_fields, list) and len(unknown_fields) >= 5
    ):
        return 0
    role = nested(sample, "role", "primary")
    handwritten = source_style.get("handwritten")
    irregularity = source_style.get("irregularity")
    if (
        role in VARIANT_ROLES
        or (
            isinstance(handwritten, (int, float))
            and not isinstance(handwritten, bool)
            and float(handwritten) >= HIGH_VARIANT_STYLE_THRESHOLD
        )
        or (
            isinstance(irregularity, (int, float))
            and not isinstance(irregularity, bool)
            and float(irregularity) >= HIGH_VARIANT_STYLE_THRESHOLD
        )
        or _manual_recrop(sample)
        or _chapter_pair_consistency_action(sample) == "local_override"
    ):
        return 1
    return 2


def _chapter_pair_endpoint_eligibility(
    sample: Mapping[str, Any],
) -> tuple[bool, float, str]:
    """Return whether a finalized human label is safe as pair supervision."""

    if nested(sample, "provenance", "approval") != "completed_human_final_label":
        return False, 0.0, "not_completed_human_final_label"
    review = sample.get("review_provenance")
    if not isinstance(review, Mapping):
        return False, 0.0, "missing_review_provenance"
    final_sha = review.get("final_record_sha256")
    if not isinstance(final_sha, str) or SHA_RE.fullmatch(final_sha) is None:
        return False, 0.0, "missing_final_label_binding"
    resolution = review.get("resolution")
    if not isinstance(resolution, Mapping) or resolution.get("kind") not in set(
        labels.RESOLUTION_KINDS
    ):
        return False, 0.0, "not_finalized_human_resolution"
    source_label_ids = resolution.get("source_label_ids")
    source_reviews = review.get("source_reviews")
    if (
        not isinstance(source_label_ids, list)
        or not source_label_ids
        or not isinstance(source_reviews, list)
        or not source_reviews
    ):
        return False, 0.0, "missing_human_source_reviews"
    review_by_label: dict[str, Mapping[str, Any]] = {}
    for source_review in source_reviews:
        if not isinstance(source_review, Mapping):
            return False, 0.0, "malformed_human_source_review"
        label_id = source_review.get("label_id")
        reviewer = source_review.get("reviewer")
        stage = source_review.get("stage")
        record_sha = source_review.get("record_sha256")
        if (
            not isinstance(label_id, str)
            or not isinstance(reviewer, str)
            or not reviewer
            or stage not in labels.REVIEW_STAGES
            or not isinstance(record_sha, str)
            or SHA_RE.fullmatch(record_sha) is None
        ):
            return False, 0.0, "malformed_human_source_review"
        review_by_label[label_id] = source_review
    if any(str(label_id) not in review_by_label for label_id in source_label_ids):
        return False, 0.0, "final_resolution_source_review_drift"

    role_confidence = nested(sample, "role", "confidence")
    resolution_confidence = resolution.get("confidence")
    confidences = [role_confidence, resolution_confidence]
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or not 0.0 <= float(value) <= 1.0
        for value in confidences
    ):
        return False, 0.0, "invalid_label_quality"
    legacy_quality = min(float(value) for value in confidences)
    quality = sample.get("label_quality")
    if quality is not None:
        if not isinstance(quality, Mapping):
            return False, 0.0, "invalid_label_quality"
        if quality.get("ranking_truth_eligible") is not True:
            return False, 0.0, "ranking_truth_ineligible"
        raw_quality = quality.get("weight", quality.get("confidence"))
        if (
            isinstance(raw_quality, bool)
            or not isinstance(raw_quality, (int, float))
            or not math.isfinite(float(raw_quality))
            or not 0.0 <= float(raw_quality) <= 1.0
        ):
            return False, 0.0, "invalid_label_quality"
        legacy_quality = float(raw_quality)
    if legacy_quality < CHAPTER_PAIR_MIN_LABEL_QUALITY:
        return False, legacy_quality, "label_quality_below_pair_threshold"
    if not _chapter_pair_positive_candidates(sample):
        return False, legacy_quality, "no_acceptable_font_candidate"
    return True, legacy_quality, "eligible"


def _chapter_pair_group_key(sample: Mapping[str, Any]) -> tuple[str, ...]:
    return (
        str(sample.get("split")),
        str(sample.get("work_id")),
        str(sample.get("chapter_id")),
        str(nested(sample, "role", "primary")),
    )


def _chapter_pair_quality_key(sample: Mapping[str, Any]) -> tuple[Any, ...]:
    eligible, quality, _reason = _chapter_pair_endpoint_eligibility(sample)
    return (
        0 if eligible else 1,
        -quality,
        *_quality_sort_key(sample),
    )


def _make_chapter_pair_row(
    *, kind: str, anchor: Mapping[str, Any], target: Mapping[str, Any]
) -> dict[str, Any]:
    group = _chapter_pair_group_key(anchor)
    split, _work_id, chapter_id, role = group
    anchor_id = str(anchor["sample_id"])
    target_id = str(target["sample_id"])
    pair_id = (
        "fmcp-"
        + stable_hash(
            CHAPTER_PAIR_SCHEMA_VERSION,
            CHAPTER_PAIR_SELECTION_ALGORITHM,
            kind,
            *group,
            anchor_id,
            target_id,
        )[:32]
    )
    return seal(
        {
            "anchor_label_record_sha256": nested(
                anchor, "review_provenance", "final_record_sha256"
            ),
            "anchor_sample_id": anchor_id,
            "anchor_training_sample_record_sha256": anchor["record_sha256"],
            "chapter_id": chapter_id,
            "human_confirmed": True,
            "pair_id": pair_id,
            "pair_kind": kind,
            "role": role,
            "schema_version": CHAPTER_PAIR_SCHEMA_VERSION,
            "split": split,
            "target_label_record_sha256": nested(
                target, "review_provenance", "final_record_sha256"
            ),
            "target_sample_id": target_id,
            "target_training_sample_record_sha256": target["record_sha256"],
        }
    )


def _select_chapter_pair_rows(
    samples: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], list[Mapping[str, Any]]] = {}
    for sample in samples:
        # Test relationships are hidden evaluator truth.  Even sealed test rows
        # would disclose endpoint IDs, label hashes, roles, and pair semantics to
        # development code, so this exporter must never materialize them.
        if sample.get("split") == "test":
            continue
        eligible, _quality, _reason = _chapter_pair_endpoint_eligibility(sample)
        if eligible:
            groups.setdefault(_chapter_pair_group_key(sample), []).append(sample)

    output: list[dict[str, Any]] = []
    for group_key in sorted(groups):
        members = sorted(groups[group_key], key=lambda row: str(row["sample_id"]))
        ordinary = [
            row
            for row in members
            if _chapter_pair_consistency_action(row) == "inherit_anchor"
            and _chapter_pair_priority(row) == 2
        ]
        ordinary_options: list[
            tuple[tuple[Any, ...], Mapping[str, Any], Mapping[str, Any]]
        ] = []
        for left, right in itertools.combinations(ordinary, 2):
            left_positive = _chapter_pair_positive_candidates(left)
            right_positive = _chapter_pair_positive_candidates(right)
            overlap = _candidate_jaccard(left_positive, right_positive)
            if overlap < CHAPTER_PAIR_MIN_ORDINARY_POSITIVE_JACCARD:
                continue
            anchor, target = sorted((left, right), key=_chapter_pair_quality_key)
            different_page = str(anchor.get("page_id")) != str(target.get("page_id"))
            option_key = (
                0 if different_page else 1,
                -overlap,
                _chapter_pair_quality_key(anchor),
                _chapter_pair_quality_key(target),
                stable_hash(
                    CHAPTER_PAIR_SELECTION_ALGORITHM,
                    "ordinary",
                    str(anchor["sample_id"]),
                    str(target["sample_id"]),
                ),
            )
            ordinary_options.append((option_key, anchor, target))
        used_ordinary_endpoints: set[str] = set()
        ordinary_count = 0
        for _key, anchor, target in sorted(ordinary_options, key=lambda row: row[0]):
            endpoint_ids = {str(anchor["sample_id"]), str(target["sample_id"])}
            if endpoint_ids & used_ordinary_endpoints:
                continue
            output.append(
                _make_chapter_pair_row(
                    kind="ordinary_consistency_positive",
                    anchor=anchor,
                    target=target,
                )
            )
            used_ordinary_endpoints.update(endpoint_ids)
            ordinary_count += 1
            if ordinary_count >= MAX_ORDINARY_CHAPTER_PAIRS_PER_GROUP:
                break

        anchors = [
            row
            for row in members
            if _chapter_pair_consistency_action(row) == "inherit_anchor"
        ]
        override_targets = sorted(
            (
                row
                for row in members
                if _chapter_pair_consistency_action(row) == "local_override"
            ),
            key=_chapter_pair_quality_key,
        )
        override_count = 0
        for target in override_targets:
            target_positive = _chapter_pair_positive_candidates(target)
            override_options: list[tuple[tuple[Any, ...], Mapping[str, Any]]] = []
            for anchor in anchors:
                anchor_positive = _chapter_pair_positive_candidates(anchor)
                overlap = _candidate_jaccard(anchor_positive, target_positive)
                if (
                    overlap >= CHAPTER_PAIR_MAX_OVERRIDE_JACCARD
                    or not (anchor_positive - target_positive)
                    or not (target_positive - anchor_positive)
                ):
                    continue
                different_page = str(anchor.get("page_id")) != str(
                    target.get("page_id")
                )
                option_key = (
                    0 if different_page else 1,
                    overlap,
                    _chapter_pair_quality_key(anchor),
                    stable_hash(
                        CHAPTER_PAIR_SELECTION_ALGORITHM,
                        "override",
                        str(anchor["sample_id"]),
                        str(target["sample_id"]),
                    ),
                )
                override_options.append((option_key, anchor))
            if not override_options:
                continue
            _key, anchor = sorted(override_options, key=lambda row: row[0])[0]
            output.append(
                _make_chapter_pair_row(
                    kind="local_override_margin", anchor=anchor, target=target
                )
            )
            override_count += 1
            if override_count >= MAX_LOCAL_OVERRIDE_PAIRS_PER_GROUP:
                break
    return sorted(output, key=lambda row: row["pair_id"])


def _validate_chapter_pair_rows(
    samples: Sequence[Mapping[str, Any]],
    rows: Sequence[Mapping[str, Any]],
    *,
    require_deterministic: bool,
) -> None:
    sample_by_id: dict[str, Mapping[str, Any]] = {}
    for sample in samples:
        sample_id = require_id(sample.get("sample_id"), "training sample.sample_id")
        if sample_id in sample_by_id:
            raise TrainingExportError("chapter pairs: duplicate sample endpoint")
        validate_seal(sample, location=f"training sample {sample_id}")
        sample_by_id[sample_id] = sample

    expected_keys = {
        "anchor_label_record_sha256",
        "anchor_sample_id",
        "anchor_training_sample_record_sha256",
        "chapter_id",
        "human_confirmed",
        "pair_id",
        "pair_kind",
        "record_sha256",
        "role",
        "schema_version",
        "split",
        "target_label_record_sha256",
        "target_sample_id",
        "target_training_sample_record_sha256",
    }
    pair_ids: set[str] = set()
    endpoint_pairs: set[frozenset[str]] = set()
    group_kind_counts: Counter[tuple[str, ...]] = Counter()
    for index, row in enumerate(rows):
        location = f"{CHAPTER_PAIR_FILE}[{index}]"
        if set(row) != expected_keys:
            raise TrainingExportError(f"{location}: chapter pair fields drifted")
        if row.get("schema_version") != CHAPTER_PAIR_SCHEMA_VERSION:
            raise TrainingExportError(f"{location}: unsupported schema")
        validate_seal(row, location=location)
        pair_id = require_id(row.get("pair_id"), f"{location}.pair_id")
        if pair_id in pair_ids:
            raise TrainingExportError(f"{location}: duplicate pair ID")
        pair_ids.add(pair_id)
        if row.get("human_confirmed") is not True:
            raise TrainingExportError(f"{location}: pair is not human-confirmed")
        kind = row.get("pair_kind")
        if kind not in {"ordinary_consistency_positive", "local_override_margin"}:
            raise TrainingExportError(f"{location}: unsupported pair kind")
        anchor_id = require_id(
            row.get("anchor_sample_id"), f"{location}.anchor_sample_id"
        )
        target_id = require_id(
            row.get("target_sample_id"), f"{location}.target_sample_id"
        )
        if anchor_id == target_id:
            raise TrainingExportError(f"{location}: pair endpoints must differ")
        endpoint_pair = frozenset({anchor_id, target_id})
        if endpoint_pair in endpoint_pairs:
            raise TrainingExportError(f"{location}: duplicate endpoint pair")
        endpoint_pairs.add(endpoint_pair)
        if anchor_id not in sample_by_id or target_id not in sample_by_id:
            raise TrainingExportError(f"{location}: unknown pair endpoint")
        anchor = sample_by_id[anchor_id]
        target = sample_by_id[target_id]
        anchor_group = _chapter_pair_group_key(anchor)
        target_group = _chapter_pair_group_key(target)
        if anchor_group != target_group:
            raise TrainingExportError(
                f"{location}: split/work/chapter/role leakage in chapter pair"
            )
        split, _work_id, chapter_id, role = anchor_group
        if split not in {"train", "val"}:
            raise TrainingExportError(
                f"{location}: test chapter pairs are forbidden in development export"
            )
        if (
            row.get("split") != split
            or row.get("chapter_id") != chapter_id
            or row.get("role") != role
        ):
            raise TrainingExportError(f"{location}: grouping binding drifted")
        for endpoint_name, endpoint in (("anchor", anchor), ("target", target)):
            if row.get(
                f"{endpoint_name}_training_sample_record_sha256"
            ) != endpoint.get("record_sha256") or row.get(
                f"{endpoint_name}_label_record_sha256"
            ) != nested(
                endpoint, "review_provenance", "final_record_sha256"
            ):
                raise TrainingExportError(
                    f"{location}: {endpoint_name} label/training SHA binding drifted"
                )
            eligible, _quality, reason = _chapter_pair_endpoint_eligibility(endpoint)
            if not eligible:
                raise TrainingExportError(
                    f"{location}: {endpoint_name} is nonhuman or low-quality ({reason})"
                )
        anchor_positive = _chapter_pair_positive_candidates(anchor)
        target_positive = _chapter_pair_positive_candidates(target)
        overlap = _candidate_jaccard(anchor_positive, target_positive)
        anchor_action = _chapter_pair_consistency_action(anchor)
        target_action = _chapter_pair_consistency_action(target)
        if kind == "ordinary_consistency_positive":
            if (
                anchor_action != "inherit_anchor"
                or target_action != "inherit_anchor"
                or _chapter_pair_priority(anchor) != 2
                or _chapter_pair_priority(target) != 2
            ):
                raise TrainingExportError(
                    f"{location}: variant or non-inherited ordinary pair"
                )
            if overlap < CHAPTER_PAIR_MIN_ORDINARY_POSITIVE_JACCARD:
                raise TrainingExportError(
                    f"{location}: ordinary pair candidate overlap is too low"
                )
        else:
            if anchor_action != "inherit_anchor" or target_action != "local_override":
                raise TrainingExportError(
                    f"{location}: local override direction drifted"
                )
            if (
                overlap >= CHAPTER_PAIR_MAX_OVERRIDE_JACCARD
                or not (anchor_positive - target_positive)
                or not (target_positive - anchor_positive)
            ):
                raise TrainingExportError(
                    f"{location}: local override candidate margin is not useful"
                )
        group_kind_counts[(*anchor_group, str(kind))] += 1

    for group_kind, count in group_kind_counts.items():
        limit = (
            MAX_ORDINARY_CHAPTER_PAIRS_PER_GROUP
            if group_kind[-1] == "ordinary_consistency_positive"
            else MAX_LOCAL_OVERRIDE_PAIRS_PER_GROUP
        )
        if count > limit:
            raise TrainingExportError("chapter pair per-group diversity cap exceeded")
    if require_deterministic:
        expected = _select_chapter_pair_rows(samples)
        actual_bytes = b"".join(canonical_jsonl_record(row) for row in rows)
        expected_bytes = b"".join(canonical_jsonl_record(row) for row in expected)
        if actual_bytes != expected_bytes:
            raise TrainingExportError("chapter pair deterministic selection drifted")


def build_chapter_pair_rows(
    samples: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    rows = _select_chapter_pair_rows(samples)
    _validate_chapter_pair_rows(samples, rows, require_deterministic=False)
    return rows


def validate_chapter_pair_rows(
    samples: Sequence[Mapping[str, Any]], rows: Sequence[Mapping[str, Any]]
) -> None:
    _validate_chapter_pair_rows(samples, rows, require_deterministic=True)


def build_chapter_pair_contract(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    by_kind = Counter(str(row["pair_kind"]) for row in rows)
    by_split = Counter(str(row["split"]) for row in rows)
    status = "enabled" if rows else "disabled_no_safe_human_confirmed_pairs"
    return {
        "algorithm": CHAPTER_PAIR_SELECTION_ALGORITHM,
        "artifact_file": CHAPTER_PAIR_FILE if rows else None,
        "by_kind": dict(sorted(by_kind.items())),
        "by_split": dict(sorted(by_split.items())),
        "development_pair_count": len(rows),
        "human_confirmed_only": True,
        "label_quality_minimum": CHAPTER_PAIR_MIN_LABEL_QUALITY,
        "limits_per_split_work_chapter_role": {
            "local_override_margin": MAX_LOCAL_OVERRIDE_PAIRS_PER_GROUP,
            "ordinary_consistency_positive": MAX_ORDINARY_CHAPTER_PAIRS_PER_GROUP,
        },
        "pair_count": len(rows),
        "schema_version": CHAPTER_PAIR_SCHEMA_VERSION,
        "status": status,
        "test_pair_generation": "separate_hidden_evaluator_only",
        "test_pair_rows_emitted": 0,
        "test_pair_rows_used": 0,
        "test_rows_available_to_development": False,
    }


def _tier_by_candidate(judgment: Mapping[str, Any]) -> dict[str, str]:
    return {
        str(candidate): tier
        for tier in labels.FONT_TIERS
        for candidate in judgment[tier]
    }


def iter_listwise(context: ExportContext) -> Iterator[dict[str, Any]]:
    for sample in context.samples:
        judgment = sample["font_judgment"]
        tier_by_candidate = _tier_by_candidate(judgment)
        targets = []
        for candidate_id in context.candidate_ids:
            tier = tier_by_candidate[candidate_id]
            loss_eligible = tier in RANKED_TIERS
            targets.append(
                {
                    "candidate_id": candidate_id,
                    "loss_eligible": loss_eligible,
                    "relevance_gain": TIER_GAIN[tier] if loss_eligible else None,
                    "tier": tier,
                }
            )
        yield seal(
            {
                "abstain_target": bool(judgment["none_acceptable"]),
                "candidate_targets": targets,
                "example_id": "fmlw-"
                + stable_hash("font-matching-listwise-v1", sample["sample_id"])[:32],
                "sample_id": sample["sample_id"],
                "schema_version": LISTWISE_SCHEMA_VERSION,
                "split": sample["split"],
                "training_sample_record_sha256": sample["record_sha256"],
                "work_id": sample["work_id"],
            }
        )


def iter_pairwise(context: ExportContext) -> Iterator[dict[str, Any]]:
    for sample in context.samples:
        judgment = sample["font_judgment"]
        for better_index, better_tier in enumerate(RANKED_TIERS):
            for worse_tier in RANKED_TIERS[better_index + 1 :]:
                for better in sorted(judgment[better_tier]):
                    for worse in sorted(judgment[worse_tier]):
                        yield seal(
                            {
                                "better_candidate_id": better,
                                "better_tier": better_tier,
                                "example_id": "fmpw-"
                                + stable_hash(
                                    "font-matching-pairwise-v1",
                                    sample["sample_id"],
                                    better,
                                    worse,
                                )[:32],
                                "sample_id": sample["sample_id"],
                                "schema_version": PAIRWISE_SCHEMA_VERSION,
                                "split": sample["split"],
                                "tier_distance": RANKED_TIERS.index(worse_tier)
                                - RANKED_TIERS.index(better_tier),
                                "training_sample_record_sha256": sample[
                                    "record_sha256"
                                ],
                                "work_id": sample["work_id"],
                                "worse_candidate_id": worse,
                                "worse_tier": worse_tier,
                            }
                        )


def iter_retrieval(context: ExportContext) -> Iterator[dict[str, Any]]:
    for sample in context.samples:
        judgment = sample["font_judgment"]
        positives = sorted([*judgment["preferred"], *judgment["acceptable"]])
        abstain = bool(judgment["none_acceptable"])
        if abstain != (not positives):
            raise TrainingExportError(
                f"{sample['sample_id']}: retrieval abstention binding failed"
            )
        yield seal(
            {
                "abstain_target": abstain,
                "eligible_for_contrastive_loss": not abstain,
                "example_id": "fmrt-"
                + stable_hash("font-matching-retrieval-v1", sample["sample_id"])[:32],
                "excluded_unrenderable_candidate_ids": sorted(judgment["unrenderable"]),
                "negative_candidate_ids": sorted(
                    [*judgment["marginal"], *judgment["unacceptable"]]
                ),
                "positive_candidate_ids": positives,
                "sample_id": sample["sample_id"],
                "schema_version": RETRIEVAL_SCHEMA_VERSION,
                "split": sample["split"],
                "training_sample_record_sha256": sample["record_sha256"],
                "work_id": sample["work_id"],
            }
        )


def read_augmentations(
    path: Path | None,
    *,
    sample_by_id: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], str | None]:
    if path is None:
        return [], None
    rows = read_jsonl(path, "augmentation manifest")
    if not rows:
        raise TrainingExportError("augmentation manifest is empty")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    manifest_sha = sha256_file(path)
    for index, row in enumerate(rows, 1):
        location = f"augmentations[{index}]"
        if row.get("schema_version") != AUGMENTATION_SCHEMA_VERSION:
            raise TrainingExportError(f"{location}: unsupported schema")
        validate_seal(row, location=location)
        augmentation_id = require_id(
            row.get("augmentation_id"), f"{location}.augmentation_id"
        )
        if augmentation_id in seen:
            raise TrainingExportError(f"{location}: duplicate augmentation_id")
        seen.add(augmentation_id)
        parent_id = require_id(
            row.get("parent_sample_id"), f"{location}.parent_sample_id"
        )
        parent = sample_by_id.get(parent_id)
        if parent is None:
            raise TrainingExportError(f"{location}: unknown parent sample")
        if row.get("split") != "train" or parent.get("split") != "train":
            raise TrainingExportError(
                f"{location}: generated augmentation is train-only and cannot derive from val/test"
            )
        provenance = require_mapping(row.get("provenance"), f"{location}.provenance")
        if (
            provenance.get("generated") is not True
            or provenance.get("synthetic") is not True
            or provenance.get("qa_overlay") is not False
            or provenance.get("train_only") is not True
            or provenance.get("allowed_splits") != ["train"]
            or contains_overlay_flag(row)
        ):
            raise TrainingExportError(f"{location}: invalid train-only provenance")
        require_id(provenance.get("generator_id"), f"{location}.generator_id")
        require_text(
            provenance.get("generator_version"), f"{location}.generator_version"
        )
        require_sha(
            provenance.get("generator_config_sha256"),
            f"{location}.generator_config_sha256",
        )
        if provenance.get("parent_sample_crop_sha256") != nested(
            parent, "source", "sample_crop_sha256"
        ):
            raise TrainingExportError(f"{location}: parent crop hash mismatch")
        views_value = require_mapping(row.get("views"), f"{location}.views")
        if set(views_value) != set(VIEW_NAMES):
            raise TrainingExportError(f"{location}: augmentation needs all three views")
        views: dict[str, dict[str, Any]] = {}
        for view_name in VIEW_NAMES:
            view = copy.deepcopy(
                dict(
                    require_mapping(
                        views_value[view_name], f"{location}.views.{view_name}"
                    )
                )
            )
            if view.get("qa_overlay") is not False:
                raise TrainingExportError(
                    f"{location}.views.{view_name}: QA overlay is forbidden"
                )
            relative = safe_relative_path(
                view.get("path"), f"{location}.views.{view_name}.path"
            )
            expected = require_sha(
                view.get("file_sha256"),
                f"{location}.views.{view_name}.file_sha256",
            )
            physical = resolve_inside(
                path.parent, relative, f"{location}.views.{view_name}.path"
            )
            if sha256_file(physical) != expected:
                raise TrainingExportError(
                    f"{location}.views.{view_name}: asset hash mismatch"
                )
            views[view_name] = view
        output.append(
            seal(
                {
                    "augmentation_id": augmentation_id,
                    "evaluation_eligible": False,
                    "parent_sample_id": parent_id,
                    "parent_training_sample_record_sha256": parent["record_sha256"],
                    "provenance": copy.deepcopy(dict(provenance)),
                    "schema_version": EXPORTED_AUGMENTATION_SCHEMA_VERSION,
                    "source_augmentation_manifest_sha256": manifest_sha,
                    "split": "train",
                    "transform": copy.deepcopy(row.get("transform")),
                    "views": views,
                }
            )
        )
    output.sort(key=lambda row: row["augmentation_id"])
    return output, manifest_sha


def reconcile_review_scope(
    *,
    selected_ids: set[str],
    final_by_sample: Mapping[str, Mapping[str, Any]],
    master_ids: set[str],
    registry: RegistryContract | None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    final_ids = set(final_by_sample)
    missing_finals = sorted(selected_ids - final_ids)
    unknown_finals = sorted(final_ids - selected_ids)
    if missing_finals:
        raise TrainingExportError(
            f"completed review scope lacks final labels: {missing_finals[:8]}"
        )
    if unknown_finals:
        raise TrainingExportError(
            f"final ledger contains unknown samples: {unknown_finals[:8]}"
        )
    excluded_final_ids = (
        selected_ids & registry.invalidated_parent_ids
        if registry is not None
        else set()
    )
    leaked = sorted(excluded_final_ids & master_ids)
    if leaked:
        raise TrainingExportError(
            "registry-excluded parent finals still exist in the current master: "
            f"{leaked[:8]}"
        )
    missing_master_ids = selected_ids - master_ids
    unknown_missing = sorted(missing_master_ids - excluded_final_ids)
    if unknown_missing:
        raise TrainingExportError(
            "review ledger references samples missing from the current master for an "
            f"unapproved reason: {unknown_missing[:8]}"
        )
    if missing_master_ids != excluded_final_ids:
        raise TrainingExportError(
            "registry exclusions and missing reviewed master samples disagree"
        )
    active_ids = selected_ids - excluded_final_ids
    return tuple(sorted(active_ids)), tuple(sorted(excluded_final_ids))


def _training_view_source_sha256(view: Mapping[str, Any]) -> str:
    direct = view.get("file_sha256")
    if direct is not None:
        return require_sha(direct, "master view.file_sha256")
    native = require_mapping(view.get("source_native"), "master view.source_native")
    return require_sha(
        native.get("file_sha256"), "master view.source_native.file_sha256"
    )


def validate_review_projection(
    active_ids: Sequence[str],
    *,
    master_by_id: Mapping[str, Mapping[str, Any]],
    state: review_ledger.WorkspaceState,
    card_by_assignment: Mapping[str, review_ledger.CardBinding],
) -> None:
    for sample_id in active_ids:
        master = master_by_id[sample_id]
        assignments = state.assignments_by_sample.get(sample_id)
        if not assignments:
            raise TrainingExportError(
                f"{sample_id}: completed review has no bound assignments"
            )
        for assignment in assignments:
            row = state.row_by_assignment[assignment.assignment_id]
            card = card_by_assignment.get(assignment.assignment_id)
            if card is None:
                raise TrainingExportError(
                    f"{sample_id}: review card binding is missing"
                )
            scalar_bindings = (
                ("work_id", assignment.work_id, master["work_id"]),
                (
                    "source_page_sha256",
                    assignment.source_page_sha256,
                    master["source_page_sha256"],
                ),
                ("chapter_id", row.get("chapter_id"), master["chapter_id"]),
                ("page_id", row.get("page_id"), master["page_id"]),
                ("split", row.get("split"), master["split"]),
                (
                    "sample_crop_sha256",
                    row.get("sample_crop_sha256"),
                    master["sample_crop_sha256"],
                ),
                (
                    "card_sample_crop_sha256",
                    card.sample_crop_sha256,
                    master["sample_crop_sha256"],
                ),
            )
            for field, reviewed, current in scalar_bindings:
                if reviewed != current:
                    raise TrainingExportError(
                        f"{sample_id}: parent/current master {field} differs"
                    )
            for view_name in VIEW_NAMES:
                current_view_sha = _training_view_source_sha256(
                    require_mapping(
                        master["views"].get(view_name),
                        f"{sample_id}.views.{view_name}",
                    )
                )
                if card.source_view_sha256.get(view_name) != current_view_sha:
                    raise TrainingExportError(
                        f"{sample_id}: parent/current master {view_name} view differs"
                    )


def load_context(
    *,
    master_manifest: Path,
    review_workspace: Path,
    render_bank_manifest: Path,
    augmentation_manifest: Path | None,
    catalog_registry: Path | None = None,
) -> ExportContext:
    try:
        report = review_ledger.validate_workspace(
            review_workspace, require_complete=True, verify_card_files=True
        )
        state = review_ledger.load_workspace(
            review_workspace,
            verify_static_inputs=True,
            verify_card_files=True,
        )
        review_rows, _review_by_assignment = review_ledger.read_reviews(state)
        final_rows, final_by_sample = review_ledger.read_finals(state)
    except (review_ledger.ReviewLedgerError, labels.LabelValidationError) as error:
        raise TrainingExportError(
            f"review ledger is not complete and valid: {error}"
        ) from error
    if report.get("completion_ready") is not True:
        raise TrainingExportError(
            "review ledger has unresolved reviews or adjudications"
        )

    registry = (
        load_registry_contract(catalog_registry)
        if catalog_registry is not None
        else None
    )
    masters, _full_work_split, master_sha = read_master_rows(
        master_manifest, registry=registry
    )
    master_report_sha: str | None = None
    master_split_map_sha: str | None = None
    if registry is not None:
        master_report_sha, master_split_map_sha = validate_registry_master_report(
            master_manifest,
            master_manifest_sha256=master_sha,
            registry=registry,
        )
    contract_inputs = require_mapping(state.contract.get("inputs"), "workspace.inputs")
    source_paths = require_mapping(
        state.contract.get("source_paths"), "workspace.source_paths"
    )
    card_manifest_path = Path(
        require_text(
            source_paths.get("card_manifest"),
            "workspace.source_paths.card_manifest",
        )
    )
    try:
        (
            card_by_assignment,
            bound_card_manifest_sha,
            _card_renderer_hash,
            card_input_hashes,
        ) = review_ledger.read_card_manifest(card_manifest_path)
    except review_ledger.ReviewLedgerError as error:
        raise TrainingExportError(
            f"review card manifest is not complete and valid: {error}"
        ) from error
    if bound_card_manifest_sha != contract_inputs.get("card_manifest_sha256"):
        raise TrainingExportError("workspace/card-manifest hash binding failed")
    card_registry_sha = card_input_hashes.get("catalog_registry_sha256")
    if card_registry_sha is not None:
        if registry is None:
            raise TrainingExportError(
                "review cards require their sealed catalog registry"
            )
        if card_registry_sha != registry.registry_sha256:
            raise TrainingExportError("review cards bind another catalog registry")
    workspace_master_sha = require_sha(
        contract_inputs.get("master_manifest_sha256"),
        "workspace.inputs.master_manifest_sha256",
    )
    allowed_workspace_master_hashes = {master_sha}
    if registry is not None and registry.parent_master_manifest_sha256 is not None:
        allowed_workspace_master_hashes.add(registry.parent_master_manifest_sha256)
    if workspace_master_sha not in allowed_workspace_master_hashes:
        raise TrainingExportError(
            "review ledger binds neither the current master nor the registry's "
            "verified parent master"
        )
    parent_workspace_projection = workspace_master_sha != master_sha
    if parent_workspace_projection and (
        registry is None
        or workspace_master_sha != registry.parent_master_manifest_sha256
    ):
        raise TrainingExportError(
            "parent workspace projection lacks an exact registry parent binding"
        )
    render_sha = sha256_file(render_bank_manifest)
    if contract_inputs.get("render_bank_sha256") != render_sha:
        raise TrainingExportError("review ledger binds another render bank")
    expected_candidate_count = int(state.contract["expected"]["candidates"])
    prototypes, candidate_ids, _render_sha, specification_sha = read_render_bank_rows(
        render_bank_manifest, expected_candidate_count=expected_candidate_count
    )
    if set(candidate_ids) != {
        candidate
        for sample in state.sample_by_id.values()
        for candidate in sample.candidate_ids
    }:
        raise TrainingExportError(
            "render bank candidates differ from review assignments"
        )
    font_catalog_sha = require_sha(
        contract_inputs.get("font_catalog_sha256"),
        "workspace.inputs.font_catalog_sha256",
    )
    renderer_hash = require_sha(
        state.contract.get("renderer_hash"), "workspace.renderer_hash"
    )
    review_by_label = {
        require_id(row.get("label_id"), "review.label_id"): row for row in review_rows
    }
    master_by_id = {str(row["sample_id"]): row for row in masters}
    selected_ids = set(state.sample_by_id)
    active_ids, excluded_final_ids = reconcile_review_scope(
        selected_ids=selected_ids,
        final_by_sample=final_by_sample,
        master_ids=set(master_by_id),
        registry=registry,
    )
    validate_review_projection(
        active_ids,
        master_by_id=master_by_id,
        state=state,
        card_by_assignment=card_by_assignment,
    )
    selected_masters = [master_by_id[sample_id] for sample_id in active_ids]
    active_final_by_sample = {
        sample_id: final_by_sample[sample_id] for sample_id in active_ids
    }
    work_split = {str(row["work_id"]): str(row["split"]) for row in selected_masters}
    uncapped_samples = build_sample_rows(
        selected_masters,
        final_by_sample=active_final_by_sample,
        review_by_label=review_by_label,
        candidate_ids=candidate_ids,
        master_manifest_sha256=master_sha,
        render_bank_manifest_sha256=render_sha,
        render_specification_sha256=specification_sha,
        font_catalog_sha256=font_catalog_sha,
        renderer_hash=renderer_hash,
        catalog_registry_sha256=(
            registry.registry_sha256 if registry is not None else None
        ),
    )
    expected_primary = int(state.contract["expected"]["primary"])
    if len(uncapped_samples) + len(excluded_final_ids) != expected_primary:
        raise TrainingExportError("training sample count differs from completed ledger")
    samples, body_dialogue_deduplication = deduplicate_body_dialogue_samples(
        uncapped_samples
    )
    chapter_pair_rows = build_chapter_pair_rows(samples)
    chapter_pair_contract = build_chapter_pair_contract(chapter_pair_rows)
    sample_by_id = {str(row["sample_id"]): row for row in samples}
    augmentations, augmentation_sha = read_augmentations(
        augmentation_manifest, sample_by_id=sample_by_id
    )
    input_hashes: dict[str, str | None] = {
        "assignments_sha256": sha256_file(
            review_workspace / review_ledger.ASSIGNMENTS_FILE
        ),
        "augmentation_manifest_sha256": augmentation_sha,
        "canonical_assignments_sha256": contract_inputs.get(
            "canonical_assignments_sha256"
        ),
        "catalog_registry_sha256": (
            registry.registry_sha256 if registry is not None else None
        ),
        "card_manifest_sha256": contract_inputs.get("card_manifest_sha256"),
        "claims_sha256": sha256_file(review_workspace / review_ledger.CLAIMS_FILE),
        "exporter_source_sha256": sha256_file(Path(__file__).resolve()),
        "finals_sha256": sha256_file(review_workspace / review_ledger.FINALS_FILE),
        "font_catalog_sha256": font_catalog_sha,
        "master_manifest_sha256": master_sha,
        "master_report_sha256": master_report_sha,
        "master_split_map_sha256": master_split_map_sha,
        "priority_inventory_sha256": contract_inputs.get("priority_inventory_sha256"),
        "render_bank_manifest_sha256": render_sha,
        "render_specification_sha256": specification_sha,
        "reviews_sha256": sha256_file(review_workspace / review_ledger.REVIEWS_FILE),
        "workspace_contract_sha256": sha256_file(
            review_workspace / review_ledger.WORKSPACE_FILE
        ),
        "excluded_final_ids_sha256": sorted_ids_sha256(excluded_final_ids),
    }
    active_final_ids = set(active_ids)
    return ExportContext(
        samples=samples,
        prototype_rows=prototypes,
        augmentation_rows=augmentations,
        candidate_ids=candidate_ids,
        input_hashes=input_hashes,
        master_manifest_sha256=master_sha,
        render_bank_manifest_sha256=render_sha,
        render_specification_sha256=specification_sha,
        font_catalog_sha256=font_catalog_sha,
        renderer_hash=renderer_hash,
        review_scope=copy.deepcopy(
            dict(state.contract.get("scope") or {"batch": "all"})
        ),
        work_split=work_split,
        resolution_counts=dict(
            sorted(
                Counter(
                    row["resolution"]["kind"]
                    for row in final_rows
                    if row.get("sample_id") in active_final_ids
                ).items()
            )
        ),
        completed_final_count=len(final_rows),
        excluded_final_ids=excluded_final_ids,
        excluded_final_ids_sha256=sorted_ids_sha256(excluded_final_ids),
        catalog_registry_sha256=(
            registry.registry_sha256 if registry is not None else None
        ),
        master_report_sha256=master_report_sha,
        master_split_map_sha256=master_split_map_sha,
        parent_workspace_projection=parent_workspace_projection,
        registry_attestation=(
            copy.deepcopy(dict(registry.input_attestation))
            if registry is not None
            else None
        ),
        body_dialogue_deduplication=body_dialogue_deduplication,
        chapter_pair_rows=chapter_pair_rows,
        chapter_pair_contract=chapter_pair_contract,
    )


def artifact_iterators(
    context: ExportContext,
) -> dict[str, Callable[[], Iterable[dict[str, Any]]]]:
    output: dict[str, Callable[[], Iterable[dict[str, Any]]]] = {
        "augmentations.jsonl": lambda: iter(context.augmentation_rows),
        "font-prototypes.jsonl": lambda: iter(context.prototype_rows),
        "listwise.jsonl": lambda: iter_listwise(context),
        "pairwise.jsonl": lambda: iter_pairwise(context),
        "retrieval.jsonl": lambda: iter_retrieval(context),
        "samples.jsonl": lambda: iter(context.samples),
    }
    if context.chapter_pair_rows:
        output[CHAPTER_PAIR_FILE] = lambda: iter(context.chapter_pair_rows)
    return output


def write_jsonl_artifact(
    path: Path, records: Iterable[Mapping[str, Any]]
) -> ArtifactDescriptor:
    digest = hashlib.sha256()
    count = 0
    byte_size = 0
    with path.open("wb") as handle:
        for record in records:
            payload = canonical_jsonl_record(record)
            handle.write(payload)
            digest.update(payload)
            byte_size += len(payload)
            count += 1
        handle.flush()
        os.fsync(handle.fileno())
    return ArtifactDescriptor(path.name, count, digest.hexdigest(), byte_size)


def digest_records(
    file_name: str, records: Iterable[Mapping[str, Any]]
) -> ArtifactDescriptor:
    digest = hashlib.sha256()
    count = 0
    byte_size = 0
    for record in records:
        payload = canonical_jsonl_record(record)
        digest.update(payload)
        byte_size += len(payload)
        count += 1
    return ArtifactDescriptor(file_name, count, digest.hexdigest(), byte_size)


def build_manifest(
    context: ExportContext, descriptors: Mapping[str, ArtifactDescriptor]
) -> dict[str, Any]:
    return {
        "artifacts": {
            name: descriptors[name].as_dict() for name in sorted(descriptors)
        },
        "candidate_count": len(context.candidate_ids),
        "contracts": {
            "augmentation_isolation": {
                "core_files_accept_synthetic": False,
                "evaluation_splits_accept_generated": False,
                "generated_output_file": "augmentations.jsonl",
                "generated_parent_split": "train",
            },
            "body_dialogue_deduplication": copy.deepcopy(
                context.body_dialogue_deduplication
            ),
            "chapter_pairs": copy.deepcopy(context.chapter_pair_contract),
            "examples": {
                "chapter_pairs": {
                    "file": (CHAPTER_PAIR_FILE if context.chapter_pair_rows else None),
                    "schema_version": CHAPTER_PAIR_SCHEMA_VERSION,
                    "status": context.chapter_pair_contract["status"],
                },
                "font_prototypes": {
                    "file": "font-prototypes.jsonl",
                    "schema_version": PROTOTYPE_SCHEMA_VERSION,
                },
                "listwise": {
                    "file": "listwise.jsonl",
                    "schema_version": LISTWISE_SCHEMA_VERSION,
                },
                "pairwise": {
                    "file": "pairwise.jsonl",
                    "schema_version": PAIRWISE_SCHEMA_VERSION,
                },
                "real_samples": {
                    "file": "samples.jsonl",
                    "schema_version": SAMPLE_SCHEMA_VERSION,
                },
                "retrieval": {
                    "file": "retrieval.jsonl",
                    "schema_version": RETRIEVAL_SCHEMA_VERSION,
                },
            },
            "evaluation": {
                "allowed_splits": ["val", "test"],
                "generated_examples_allowed": False,
                "group_macro_key": "work_id",
                "qa_overlay_examples_allowed": False,
            },
            "ranking": {
                "excluded_tiers": ["unrenderable", "not_reviewed"],
                "order": list(RANKED_TIERS),
                "same_tier_is_tie": True,
            },
            "retrieval": {
                "abstain_when_none_acceptable": True,
                "multi_positive_tiers": ["preferred", "acceptable"],
            },
            "source_inputs": {
                "review_card_pixels_allowed": False,
                "required_views": list(VIEW_NAMES),
            },
            "split": {
                "development_component_key": "groups.split_component",
                "group_key": "work_id",
                "work_disjoint": True,
            },
            "work_consistency": {
                "policy_field": "consistency.policy",
                "work_key": "work_id",
            },
        },
        "input_hashes": dict(sorted(context.input_hashes.items())),
        "master_registry_binding": {
            "attestation": copy.deepcopy(context.registry_attestation),
            "master_report_sha256": context.master_report_sha256,
            "master_split_map_sha256": context.master_split_map_sha256,
            "mode": (
                "registry_parent_workspace_projection"
                if context.parent_workspace_projection
                else (
                    "registry_current_master"
                    if context.catalog_registry_sha256 is not None
                    else "legacy_no_registry"
                )
            ),
            "successor_label_inheritance_allowed": False,
        },
        "real_sample_count": len(context.samples),
        "registry_exclusions": {
            "catalog_registry_sha256": context.catalog_registry_sha256,
            "excluded_final_count": len(context.excluded_final_ids),
            "excluded_final_ids_sha256": context.excluded_final_ids_sha256,
            "ids_digest_algorithm": "sha256-sorted-lf-utf8-v1",
        },
        "review_scope": copy.deepcopy(context.review_scope),
        "renderer_bindings": {
            "font_catalog_sha256": context.font_catalog_sha256,
            "render_bank_manifest_sha256": context.render_bank_manifest_sha256,
            "render_specification_sha256": context.render_specification_sha256,
            "renderer_hash": context.renderer_hash,
        },
        "schema_version": SCHEMA_VERSION,
        "work_split": dict(sorted(context.work_split.items())),
    }


def build_report(
    context: ExportContext,
    descriptors: Mapping[str, ArtifactDescriptor],
    manifest_sha256: str,
) -> dict[str, Any]:
    by_split = Counter(row["split"] for row in context.samples)
    abstain = sum(row["font_judgment"]["none_acceptable"] for row in context.samples)
    return {
        "checks": {
            "body_dialogue_cap_violation_count": context.body_dialogue_deduplication[
                "cap_violation_count"
            ],
            "chapter_pair_duplicate_endpoint_count": 0,
            "chapter_pair_label_binding_drift_count": 0,
            "chapter_pair_leakage_count": 0,
            "chapter_pair_low_quality_or_nonhuman_count": 0,
            "complete_final_labels": True,
            "core_qa_overlay_count": 0,
            "core_synthetic_count": 0,
            "generated_evaluation_count": 0,
            "not_reviewed_candidate_count": 0,
            "successor_label_inheritance_count": 0,
            "unresolved_adjudication_count": 0,
            "work_split_leakage_count": 0,
        },
        "manifest_sha256": manifest_sha256,
        "body_dialogue_deduplication": copy.deepcopy(
            context.body_dialogue_deduplication
        ),
        "chapter_pairs": copy.deepcopy(context.chapter_pair_contract),
        "registry_exclusions": {
            "catalog_registry_sha256": context.catalog_registry_sha256,
            "excluded_final_count": len(context.excluded_final_ids),
            "excluded_final_ids_sha256": context.excluded_final_ids_sha256,
            "ids_digest_algorithm": "sha256-sorted-lf-utf8-v1",
            "parent_workspace_projection": context.parent_workspace_projection,
        },
        "outputs": {name: descriptors[name].as_dict() for name in sorted(descriptors)},
        "schema_version": REPORT_SCHEMA_VERSION,
        "summary": {
            "abstain_sample_count": abstain,
            "augmentation_count": len(context.augmentation_rows),
            "by_split": dict(sorted(by_split.items())),
            "candidate_count": len(context.candidate_ids),
            "chapter_pair_count": len(context.chapter_pair_rows),
            "chapter_pair_development_count": context.chapter_pair_contract[
                "development_pair_count"
            ],
            "completed_final_count": context.completed_final_count,
            "excluded_final_count": len(context.excluded_final_ids),
            "migration_mode": (
                "registry_parent_workspace_projection"
                if context.parent_workspace_projection
                else (
                    "registry_current_master"
                    if context.catalog_registry_sha256 is not None
                    else "legacy_no_registry"
                )
            ),
            "resolution_kind": context.resolution_counts,
            "sample_count": len(context.samples),
            "work_count": len(context.work_split),
        },
    }


def assert_safe_output(output_dir: Path) -> None:
    resolved = output_dir.resolve()
    if resolved == Path(resolved.anchor) or len(resolved.name) < 3:
        raise TrainingExportError(f"refusing unsafe output target: {output_dir}")
    if output_dir.exists() and output_dir.is_symlink():
        raise TrainingExportError("refusing symlink output")


def assert_disjoint_output(
    output_dir: Path,
    *,
    review_workspace: Path,
    render_bank_manifest: Path,
    master_manifest: Path,
    catalog_registry: Path | None,
) -> None:
    output = output_dir.resolve()
    protected_inputs = [
        review_workspace.resolve(),
        render_bank_manifest.parent.resolve(),
        master_manifest.resolve(),
    ]
    if catalog_registry is not None:
        protected_inputs.append(catalog_registry.resolve())
    for protected in protected_inputs:
        if (
            output == protected
            or protected in output.parents
            or output in protected.parents
        ):
            raise TrainingExportError(
                f"training export must be disjoint from input root: {protected}"
            )


def assert_owned_output(output_dir: Path) -> None:
    marker_path = output_dir / MARKER_FILE
    if not marker_path.is_file():
        raise TrainingExportError(f"refusing unowned training export: {output_dir}")
    marker = read_json(marker_path, "ownership marker")
    if marker.get("owner") != OWNER or marker.get("schema_version") != SCHEMA_VERSION:
        raise TrainingExportError("training export ownership marker is invalid")


def assert_replaceable_output(output_dir: Path) -> None:
    assert_safe_output(output_dir)
    if not output_dir.exists():
        return
    if not output_dir.is_dir():
        raise TrainingExportError("output exists and is not a directory")
    if any(output_dir.iterdir()):
        assert_owned_output(output_dir)


def atomic_replace_directory(output_dir: Path, staging: Path) -> None:
    backup = output_dir.with_name(f".{output_dir.name}.backup-{os.getpid()}")
    if backup.exists():
        raise TrainingExportError(f"refusing existing backup path: {backup}")
    moved_old = False
    try:
        if output_dir.exists():
            output_dir.rename(backup)
            moved_old = True
        staging.rename(output_dir)
    except Exception:
        if moved_old and not output_dir.exists():
            backup.rename(output_dir)
        raise
    if moved_old:
        if backup.parent.resolve() != output_dir.parent.resolve():
            raise TrainingExportError("internal backup escaped output parent")
        shutil.rmtree(backup)


def list_files(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }


def count_jsonl_records(path: Path) -> int:
    try:
        handle = path.open("rb")
    except OSError as error:
        raise TrainingExportError(f"could not read {path}: {error}") from error
    with handle:
        return sum(1 for line in handle if line.strip())


def build_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    review_workspace: Path,
    render_bank_manifest: Path,
    augmentation_manifest: Path | None = None,
    catalog_registry: Path | None = None,
) -> dict[str, Any]:
    assert_disjoint_output(
        output_dir,
        review_workspace=review_workspace,
        render_bank_manifest=render_bank_manifest,
        master_manifest=master_manifest,
        catalog_registry=catalog_registry,
    )
    assert_replaceable_output(output_dir)
    context = load_context(
        master_manifest=master_manifest,
        review_workspace=review_workspace,
        render_bank_manifest=render_bank_manifest,
        augmentation_manifest=augmentation_manifest,
        catalog_registry=catalog_registry,
    )
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    completed = False
    try:
        descriptors = {
            name: write_jsonl_artifact(staging / name, factory())
            for name, factory in artifact_iterators(context).items()
        }
        manifest = build_manifest(context, descriptors)
        manifest_payload = canonical_json_bytes(manifest, pretty=True)
        report = build_report(context, descriptors, sha256_bytes(manifest_payload))
        report_payload = canonical_json_bytes(report, pretty=True)
        marker = {
            "manifest_sha256": sha256_bytes(manifest_payload),
            "owner": OWNER,
            "report_sha256": sha256_bytes(report_payload),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MANIFEST_FILE).write_bytes(manifest_payload)
        (staging / REPORT_FILE).write_bytes(report_payload)
        (staging / MARKER_FILE).write_bytes(canonical_json_bytes(marker, pretty=True))
        _validate_output_with_context(output_dir=staging, context=context)
        atomic_replace_directory(output_dir, staging)
        completed = True
        return report
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)


def _validate_output_with_context(
    *, output_dir: Path, context: ExportContext
) -> dict[str, Any]:
    validate_chapter_pair_rows(context.samples, context.chapter_pair_rows)
    assert_owned_output(output_dir)
    marker = read_json(output_dir / MARKER_FILE, "ownership marker")
    manifest_path = output_dir / MANIFEST_FILE
    report_path = output_dir / REPORT_FILE
    manifest = read_json(manifest_path, "training export manifest")
    report = read_json(report_path, "training export report")
    manifest_payload = manifest_path.read_bytes()
    report_payload = report_path.read_bytes()
    if (
        marker.get("manifest_sha256") != sha256_bytes(manifest_payload)
        or marker.get("report_sha256") != sha256_bytes(report_payload)
        or report.get("manifest_sha256") != sha256_bytes(manifest_payload)
    ):
        raise TrainingExportError("metadata hash binding failed")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise TrainingExportError("training export manifest schema is unsupported")
    if report.get("schema_version") != REPORT_SCHEMA_VERSION:
        raise TrainingExportError("training export report schema is unsupported")
    if manifest.get("input_hashes") != dict(sorted(context.input_hashes.items())):
        raise TrainingExportError("training export input hashes are stale")
    expected_files = {
        MARKER_FILE,
        MANIFEST_FILE,
        REPORT_FILE,
        *artifact_iterators(context),
    }
    actual_files = list_files(output_dir)
    if expected_files != actual_files:
        raise TrainingExportError(
            "training export file inventory mismatch; "
            f"missing={sorted(expected_files - actual_files)}; "
            f"unexpected={sorted(actual_files - expected_files)}"
        )
    descriptors: dict[str, ArtifactDescriptor] = {}
    for name, factory in artifact_iterators(context).items():
        expected = digest_records(name, factory())
        physical = output_dir / name
        actual = ArtifactDescriptor(
            name,
            count_jsonl_records(physical),
            sha256_file(physical),
            physical.stat().st_size,
        )
        if expected != actual:
            raise TrainingExportError(f"{name}: deterministic artifact mismatch")
        descriptors[name] = expected
    rebuilt_manifest = build_manifest(context, descriptors)
    rebuilt_manifest_payload = canonical_json_bytes(rebuilt_manifest, pretty=True)
    if rebuilt_manifest_payload != manifest_payload:
        raise TrainingExportError("manifest is not the deterministic rebuild")
    rebuilt_report = build_report(
        context, descriptors, sha256_bytes(rebuilt_manifest_payload)
    )
    if canonical_json_bytes(rebuilt_report, pretty=True) != report_payload:
        raise TrainingExportError("report is not the deterministic rebuild")
    return {
        "manifest_sha256": sha256_bytes(manifest_payload),
        "sample_count": len(context.samples),
        "status": "valid",
    }


def validate_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    review_workspace: Path,
    render_bank_manifest: Path,
    augmentation_manifest: Path | None = None,
    catalog_registry: Path | None = None,
) -> dict[str, Any]:
    assert_owned_output(output_dir)
    manifest = read_json(output_dir / MANIFEST_FILE, "training export manifest")
    sealed_registry_sha = nested(manifest, "input_hashes", "catalog_registry_sha256")
    if sealed_registry_sha is not None and catalog_registry is None:
        raise TrainingExportError(
            "registry-attested training export requires --catalog-registry"
        )
    context = load_context(
        master_manifest=master_manifest,
        review_workspace=review_workspace,
        render_bank_manifest=render_bank_manifest,
        augmentation_manifest=augmentation_manifest,
        catalog_registry=catalog_registry,
    )
    return _validate_output_with_context(output_dir=output_dir, context=context)


def add_input_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument(
        "--catalog-registry",
        type=Path,
        help="Optional sealed dynamic catalog/exclusion registry for master v2.",
    )
    parser.add_argument("--review-workspace", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--augmentation-manifest", type=Path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    add_input_arguments(build)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--check", action="store_true")
    validate = commands.add_parser("validate")
    add_input_arguments(validate)
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    kwargs = {
        "augmentation_manifest": (
            args.augmentation_manifest.resolve()
            if args.augmentation_manifest is not None
            else None
        ),
        "catalog_registry": (
            args.catalog_registry.resolve()
            if args.catalog_registry is not None
            else None
        ),
        "master_manifest": args.master_manifest.resolve(),
        "output_dir": args.output_dir.resolve(),
        "render_bank_manifest": args.render_bank_manifest.resolve(),
        "review_workspace": args.review_workspace.resolve(),
    }
    try:
        if args.command == "validate" or args.check:
            result = validate_output(**kwargs)
        else:
            result = build_output(**kwargs)
        print(
            json.dumps(
                result, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
        )
        return 0
    except (TrainingExportError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
