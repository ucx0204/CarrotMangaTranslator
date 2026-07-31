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
import json
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


SCHEMA_VERSION = "font-matching-training-export-v1"
SAMPLE_SCHEMA_VERSION = "font-matching-training-sample-v1"
PAIRWISE_SCHEMA_VERSION = "font-matching-pairwise-example-v1"
LISTWISE_SCHEMA_VERSION = "font-matching-listwise-example-v1"
RETRIEVAL_SCHEMA_VERSION = "font-matching-retrieval-example-v1"
PROTOTYPE_SCHEMA_VERSION = "font-matching-font-prototype-v1"
AUGMENTATION_SCHEMA_VERSION = "font-matching-generated-augmentation-v1"
EXPORTED_AUGMENTATION_SCHEMA_VERSION = "font-matching-train-only-augmentation-v1"
REPORT_SCHEMA_VERSION = "font-matching-training-export-report-v1"
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


def read_master_rows(path: Path) -> tuple[list[dict[str, Any]], dict[str, str], str]:
    rows = read_jsonl(path, "master manifest")
    if not rows:
        raise TrainingExportError("master manifest is empty")
    output: list[dict[str, Any]] = []
    work_splits: dict[str, str] = {}
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
        output.append(
            {
                "chapter_id": require_id(chapter.get("id"), f"{location}.chapter.id"),
                "cohorts": copy.deepcopy(
                    nested(row, "metadata", "candidate_categories") or []
                ),
                "geometry": copy.deepcopy(row.get("geometry")),
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
                "split": split,
                "views": views,
                "work_id": work_id,
            }
        )
    output.sort(key=lambda row: row["sample_id"])
    return output, work_splits, sha256_file(path)


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
        output.append(
            seal(
                {
                    "chapter_id": master["chapter_id"],
                    "cohorts": copy.deepcopy(master["cohorts"]),
                    "consistency": copy.deepcopy(final["consistency"]),
                    "example_id": "fmts-"
                    + stable_hash("font-matching-training-sample-v1", sample_id)[:32],
                    "font_judgment": copy.deepcopy(dict(judgment)),
                    "input_bindings": {
                        "font_catalog_sha256": font_catalog_sha256,
                        "master_manifest_sha256": master_manifest_sha256,
                        "render_bank_manifest_sha256": render_bank_manifest_sha256,
                        "render_specification_sha256": render_specification_sha256,
                        "renderer_hash": renderer_hash,
                    },
                    "page_id": master["page_id"],
                    "provenance": {
                        "approval": "completed_human_final_label",
                        "master": copy.deepcopy(master["master_provenance"]),
                        "qa_overlay": False,
                        "synthetic": False,
                    },
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
            )
        )
    if set(final_by_sample) != {row["sample_id"] for row in output}:
        extras = sorted(set(final_by_sample) - {row["sample_id"] for row in output})
        raise TrainingExportError(
            f"final ledger contains unknown samples: {extras[:8]}"
        )
    output.sort(key=lambda row: row["sample_id"])
    return output


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


def load_context(
    *,
    master_manifest: Path,
    review_workspace: Path,
    render_bank_manifest: Path,
    augmentation_manifest: Path | None,
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

    masters, _full_work_split, master_sha = read_master_rows(master_manifest)
    contract_inputs = require_mapping(state.contract.get("inputs"), "workspace.inputs")
    if contract_inputs.get("master_manifest_sha256") != master_sha:
        raise TrainingExportError("review ledger binds another master manifest")
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
    missing_master_ids = sorted(selected_ids - set(master_by_id))
    if missing_master_ids:
        raise TrainingExportError(
            f"review ledger references unknown master samples: {missing_master_ids[:8]}"
        )
    selected_masters = [master_by_id[sample_id] for sample_id in sorted(selected_ids)]
    work_split = {str(row["work_id"]): str(row["split"]) for row in selected_masters}
    samples = build_sample_rows(
        selected_masters,
        final_by_sample=final_by_sample,
        review_by_label=review_by_label,
        candidate_ids=candidate_ids,
        master_manifest_sha256=master_sha,
        render_bank_manifest_sha256=render_sha,
        render_specification_sha256=specification_sha,
        font_catalog_sha256=font_catalog_sha,
        renderer_hash=renderer_hash,
    )
    if len(samples) != state.contract["expected"]["primary"]:
        raise TrainingExportError("training sample count differs from completed ledger")
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
        "card_manifest_sha256": contract_inputs.get("card_manifest_sha256"),
        "claims_sha256": sha256_file(review_workspace / review_ledger.CLAIMS_FILE),
        "exporter_source_sha256": sha256_file(Path(__file__).resolve()),
        "finals_sha256": sha256_file(review_workspace / review_ledger.FINALS_FILE),
        "font_catalog_sha256": font_catalog_sha,
        "master_manifest_sha256": master_sha,
        "priority_inventory_sha256": contract_inputs.get("priority_inventory_sha256"),
        "render_bank_manifest_sha256": render_sha,
        "render_specification_sha256": specification_sha,
        "reviews_sha256": sha256_file(review_workspace / review_ledger.REVIEWS_FILE),
        "workspace_contract_sha256": sha256_file(
            review_workspace / review_ledger.WORKSPACE_FILE
        ),
    }
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
            sorted(Counter(row["resolution"]["kind"] for row in final_rows).items())
        ),
    )


def artifact_iterators(
    context: ExportContext,
) -> dict[str, Callable[[], Iterable[dict[str, Any]]]]:
    return {
        "augmentations.jsonl": lambda: iter(context.augmentation_rows),
        "font-prototypes.jsonl": lambda: iter(context.prototype_rows),
        "listwise.jsonl": lambda: iter_listwise(context),
        "pairwise.jsonl": lambda: iter_pairwise(context),
        "retrieval.jsonl": lambda: iter_retrieval(context),
        "samples.jsonl": lambda: iter(context.samples),
    }


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
            "examples": {
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
                "group_key": "work_id",
                "work_disjoint": True,
            },
            "work_consistency": {
                "policy_field": "consistency.policy",
                "work_key": "work_id",
            },
        },
        "input_hashes": dict(sorted(context.input_hashes.items())),
        "real_sample_count": len(context.samples),
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
            "complete_final_labels": True,
            "core_qa_overlay_count": 0,
            "core_synthetic_count": 0,
            "generated_evaluation_count": 0,
            "not_reviewed_candidate_count": 0,
            "unresolved_adjudication_count": 0,
            "work_split_leakage_count": 0,
        },
        "manifest_sha256": manifest_sha256,
        "outputs": {name: descriptors[name].as_dict() for name in sorted(descriptors)},
        "schema_version": REPORT_SCHEMA_VERSION,
        "summary": {
            "abstain_sample_count": abstain,
            "augmentation_count": len(context.augmentation_rows),
            "by_split": dict(sorted(by_split.items())),
            "candidate_count": len(context.candidate_ids),
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
    output_dir: Path, *, review_workspace: Path, render_bank_manifest: Path
) -> None:
    output = output_dir.resolve()
    protected_roots = (
        review_workspace.resolve(),
        render_bank_manifest.parent.resolve(),
    )
    for protected in protected_roots:
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
) -> dict[str, Any]:
    assert_disjoint_output(
        output_dir,
        review_workspace=review_workspace,
        render_bank_manifest=render_bank_manifest,
    )
    assert_replaceable_output(output_dir)
    context = load_context(
        master_manifest=master_manifest,
        review_workspace=review_workspace,
        render_bank_manifest=render_bank_manifest,
        augmentation_manifest=augmentation_manifest,
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
        validate_output(
            output_dir=staging,
            master_manifest=master_manifest,
            review_workspace=review_workspace,
            render_bank_manifest=render_bank_manifest,
            augmentation_manifest=augmentation_manifest,
        )
        atomic_replace_directory(output_dir, staging)
        completed = True
        return report
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)


def validate_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    review_workspace: Path,
    render_bank_manifest: Path,
    augmentation_manifest: Path | None = None,
) -> dict[str, Any]:
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

    context = load_context(
        master_manifest=master_manifest,
        review_workspace=review_workspace,
        render_bank_manifest=render_bank_manifest,
        augmentation_manifest=augmentation_manifest,
    )
    if manifest.get("input_hashes") != dict(sorted(context.input_hashes.items())):
        raise TrainingExportError("training export input hashes are stale")
    expected_files = {MARKER_FILE, MANIFEST_FILE, REPORT_FILE, *ARTIFACT_FILES}
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


def add_input_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--master-manifest", type=Path, required=True)
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
        "augmentation_manifest": args.augmentation_manifest.resolve()
        if args.augmentation_manifest is not None
        else None,
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
