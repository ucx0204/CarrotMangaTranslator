#!/usr/bin/env python3
"""Export a fail-closed provisional 22-font training bundle.

This exporter is intentionally separate from the legacy review-ledger exporter.
It joins the immutable 15-font final embedded in the v4 rescue selection with
the resolved seven-font v5 delta, while retaining the exact human-source
provenance of both authorities.  It never fabricates a legacy workspace or a
preferred/top-1 label.

The v5 workspace must already have been provisionally finalized.  Eligibility
exceptions and every sample in the sealed training quarantine are excluded
before body-dialogue deduplication.  The output remains compatible with the
existing trainer and exhaustive physical-asset validator, but is explicitly
marked training-only pending the full-22 utility/redundancy audit.
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import export_font_matching_training_examples as base  # noqa: E402
import font_matching_catalog_delta_ledger as delta  # noqa: E402
import font_matching_labels as labels  # noqa: E402


AUTHORITY_SCHEMA_VERSION = "font-matching-provisional-full22-export-v1"
FONT_SIGNAL_SUCCESSOR_SCHEMA_VERSION = "font-matching-font-signal-audit-successor-v1"
FONT_SIGNAL_SUCCESSOR_RELATIONSHIP = "label_only_full22_successor"
FONT_SIGNAL_AUDIT_PROJECTION_SCHEMA_VERSION = (
    "font-matching-font-signal-audit-projection-v1"
)
FONT_SIGNAL_AUDIT_PROJECTION_RECONCILIATION = (
    "parent_equals_review_ready_union_audit_excluded"
)
MASTER_REGISTRY_PROJECTION_SCHEMA_VERSION = (
    "font-matching-full22-master-registry-projection-v1"
)
RESOLVED_LABEL_FILE = "resolved-labels-full22.jsonl"
PRIOR_TRAINING_EXPORT_MARKER = ".font-matching-training-export-owned.json"
FINALIZED_FILES = {
    "agreement_report": "agreement-report.json",
    "catalog_disposition": "catalog-disposition.json",
    "eligibility_exceptions": "eligibility-exceptions.jsonl",
    "provisional_catalog": "provisional-catalog.json",
    "provisional_report": "provisional-report.json",
    "training_quarantine": "training-quarantine.json",
}


class ProvisionalFull22ExportError(base.TrainingExportError):
    """Raised when a provisional full-22 authority is incomplete or stale."""


@dataclass
class Full22Context:
    export: base.ExportContext
    resolved_labels: list[dict[str, Any]]
    authority_contract: dict[str, Any]
    font_signal_audit_projection: dict[str, Any]
    master_registry_projection: dict[str, Any]
    eligibility_exception_ids: tuple[str, ...]
    training_quarantine_ids: tuple[str, ...]


def _require_equal(actual: Any, expected: Any, message: str) -> None:
    if actual != expected:
        raise ProvisionalFull22ExportError(message)


def _read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    return base.read_jsonl(path, location)


def _validate_file_sha(path: Path, expected: Any, location: str) -> str:
    expected_sha = base.require_sha(expected, f"{location}.sha256")
    actual_sha = base.sha256_file(path)
    if actual_sha != expected_sha:
        raise ProvisionalFull22ExportError(f"{location}: file hash changed")
    return actual_sha


def _artifact_descriptor(
    manifest: Mapping[str, Any], name: str, *, location: str
) -> Mapping[str, Any]:
    artifacts = base.require_mapping(manifest.get("artifacts"), f"{location}.artifacts")
    descriptor = base.require_mapping(
        artifacts.get(name), f"{location}.artifacts.{name}"
    )
    if descriptor.get("file") != name:
        raise ProvisionalFull22ExportError(
            f"{location}.artifacts.{name}: file name changed"
        )
    return descriptor


def _resolve_master_registry_projection(
    *,
    state_source: Mapping[str, Any],
    source_records: Mapping[str, Any],
    rescue_report_inputs: Mapping[str, Any],
    actual_master_sha256: str,
    actual_catalog_registry_sha256: str,
    formal_finalized: bool,
    allow_unfinalized_strict_consensus: bool,
) -> dict[str, Any]:
    """Authorize either the exact base authority or its sealed successor.

    A calibration-only supplement is the sole bridge to a successor master and
    registry.  The workspace loader has already revalidated the physical
    supplement manifest; this layer independently requires every derived source
    record to match that validated supplement before accepting its successor
    hashes.  No review answer or prior 15-font label is inherited for the seven
    supplemental samples.
    """

    base_master_sha = base.require_sha(
        rescue_report_inputs.get("master_manifest_sha256"),
        "rescue report.inputs.master_manifest_sha256",
    )
    base_registry_sha = base.require_sha(
        rescue_report_inputs.get("catalog_registry_sha256"),
        "rescue report.inputs.catalog_registry_sha256",
    )
    base_split_map_sha = base.require_sha(
        rescue_report_inputs.get("master_split_map_sha256"),
        "rescue report.inputs.master_split_map_sha256",
    )
    if (
        source_records.get("master_manifest_sha256") != base_master_sha
        or source_records.get("catalog_registry_sha256") != base_registry_sha
    ):
        raise ProvisionalFull22ExportError(
            "workspace base master/registry differs from the sealed rescue authority"
        )

    supplement = state_source.get("calibration_only_supplement")
    if supplement is None:
        if (
            actual_master_sha256 != base_master_sha
            or actual_catalog_registry_sha256 != base_registry_sha
            or source_records.get("master_split_map_sha256") != base_split_map_sha
        ):
            raise ProvisionalFull22ExportError(
                "master/registry must be the exact authority sealed by v4/v5"
            )
        return {
            "base_catalog_registry_sha256": base_registry_sha,
            "base_master_manifest_sha256": base_master_sha,
            "mode": "exact_base_rescue_authority",
            "schema_version": MASTER_REGISTRY_PROJECTION_SCHEMA_VERSION,
            "supplement_manifest_file_sha256": None,
            "supplement_manifest_record_sha256": None,
            "supplement_training_quarantine_sample_ids": (),
            "supplemental_sample_ids": (),
            "successor_catalog_registry_sha256": actual_catalog_registry_sha256,
            "successor_master_manifest_sha256": actual_master_sha256,
            "successor_master_split_map_sha256": base_split_map_sha,
        }
    supplement_row = base.require_mapping(
        supplement, "workspace calibration-only supplement"
    )
    if allow_unfinalized_strict_consensus or not formal_finalized:
        raise ProvisionalFull22ExportError(
            "successor master/registry projection requires formal finalized calibration"
        )
    expected_supplement_records = delta._calibration_supplement_source_records(
        supplement_row
    )
    for key, expected in expected_supplement_records.items():
        if source_records.get(key) != expected:
            raise ProvisionalFull22ExportError(
                f"workspace calibration supplement source record changed: {key}"
            )

    successor_master_sha = expected_supplement_records[
        "calibration_supplement_successor_master_manifest_sha256"
    ]
    successor_registry_sha = expected_supplement_records[
        "calibration_supplement_successor_catalog_registry_sha256"
    ]
    successor_split_map_sha = expected_supplement_records[
        "calibration_supplement_successor_master_split_map_sha256"
    ]
    if source_records.get("master_split_map_sha256") != successor_split_map_sha:
        raise ProvisionalFull22ExportError(
            "workspace successor master split-map source record changed"
        )
    if (
        actual_master_sha256 != successor_master_sha
        or actual_catalog_registry_sha256 != successor_registry_sha
    ):
        raise ProvisionalFull22ExportError(
            "master/registry is not the exact successor sealed by the calibration supplement"
        )
    supplemental_ids = tuple(
        sorted(
            delta._string_array(
                supplement_row.get("supplemental_sample_ids"),
                "calibration supplement supplemental_sample_ids",
            )
        )
    )
    quarantine_ids = tuple(
        sorted(
            delta._string_array(
                supplement_row.get("training_quarantine_sample_ids"),
                "calibration supplement training_quarantine_sample_ids",
            )
        )
    )
    if (
        len(supplemental_ids) != 7
        or len(supplemental_ids) != len(set(supplemental_ids))
        or len(quarantine_ids) != len(set(quarantine_ids))
        or not set(supplemental_ids).issubset(quarantine_ids)
    ):
        raise ProvisionalFull22ExportError(
            "calibration supplement sample/quarantine projection changed"
        )
    return {
        "base_catalog_registry_sha256": base_registry_sha,
        "base_master_manifest_sha256": base_master_sha,
        "mode": "sealed_calibration_supplement_successor",
        "schema_version": MASTER_REGISTRY_PROJECTION_SCHEMA_VERSION,
        "supplement_manifest_file_sha256": expected_supplement_records[
            "calibration_supplement_manifest_file_sha256"
        ],
        "supplement_manifest_record_sha256": expected_supplement_records[
            "calibration_supplement_manifest_record_sha256"
        ],
        "supplement_training_quarantine_sample_ids": quarantine_ids,
        "supplemental_sample_ids": supplemental_ids,
        "successor_catalog_registry_sha256": successor_registry_sha,
        "successor_master_manifest_sha256": successor_master_sha,
        "successor_master_split_map_sha256": successor_split_map_sha,
    }


def _prior_label_selection_ids(
    selection_by_sample: Mapping[str, Mapping[str, Any]],
    *,
    supplemental_sample_ids: Iterable[str],
) -> set[str]:
    supplemental_ids = set(supplemental_sample_ids)
    if not supplemental_ids.issubset(selection_by_sample):
        raise ProvisionalFull22ExportError(
            "calibration supplement samples escape the sealed source selection"
        )
    for sample_id in sorted(supplemental_ids):
        selection = base.require_mapping(
            selection_by_sample[sample_id],
            f"calibration supplement selection[{sample_id}]",
        )
        if (
            delta._selection_prior_final_record_sha256(
                selection, location=f"calibration supplement selection[{sample_id}]"
            )
            is not None
        ):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: calibration-only sample inherited a prior label"
            )
    return set(selection_by_sample) - supplemental_ids


def _validate_prior_training_export(
    *,
    prior_training_export_dir: Path,
    rescue_report: Mapping[str, Any],
    selection_by_sample: Mapping[str, Mapping[str, Any]],
    old_candidate_ids: Sequence[str],
    supplemental_sample_ids: Iterable[str] = (),
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    root = prior_training_export_dir.resolve()
    marker_path = root / PRIOR_TRAINING_EXPORT_MARKER
    manifest_path = root / base.MANIFEST_FILE
    report_path = root / base.REPORT_FILE
    samples_path = root / "samples.jsonl"
    if not all(
        path.is_file()
        for path in (marker_path, manifest_path, report_path, samples_path)
    ):
        raise ProvisionalFull22ExportError(
            "prior training export is missing marker/manifest/report/samples"
        )

    rescue_inputs = base.require_mapping(rescue_report.get("inputs"), "rescue.inputs")
    expected_hashes = {
        marker_path: rescue_inputs.get("training_export_marker_sha256"),
        manifest_path: rescue_inputs.get("training_export_manifest_sha256"),
        report_path: rescue_inputs.get("training_export_report_sha256"),
        samples_path: rescue_inputs.get("training_export_samples_sha256"),
    }
    hashes = {
        path.name: _validate_file_sha(path, expected, f"prior export {path.name}")
        for path, expected in expected_hashes.items()
    }
    marker = base.read_json(marker_path, "prior training export marker")
    manifest = base.read_json(manifest_path, "prior training export manifest")
    report = base.read_json(report_path, "prior training export report")
    if (
        marker.get("owner") != base.OWNER
        or marker.get("schema_version") != base.SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise ProvisionalFull22ExportError("prior training export ownership is invalid")
    if (
        marker.get("manifest_sha256") != hashes[base.MANIFEST_FILE]
        or marker.get("report_sha256") != hashes[base.REPORT_FILE]
        or report.get("manifest_sha256") != hashes[base.MANIFEST_FILE]
    ):
        raise ProvisionalFull22ExportError("prior training export metadata is stale")
    if (
        manifest.get("schema_version") != base.SCHEMA_VERSION
        or report.get("schema_version") != base.REPORT_SCHEMA_VERSION
        or manifest.get("candidate_count") != len(old_candidate_ids)
    ):
        raise ProvisionalFull22ExportError("prior training export contract changed")

    descriptor = _artifact_descriptor(
        manifest, "samples.jsonl", location="prior training export manifest"
    )
    if (
        descriptor.get("sha256") != hashes["samples.jsonl"]
        or descriptor.get("byte_size") != samples_path.stat().st_size
        or report.get("outputs", {}).get("samples.jsonl") != descriptor
    ):
        raise ProvisionalFull22ExportError("prior samples descriptor changed")
    rows = _read_jsonl(samples_path, "prior training samples")
    if descriptor.get("record_count") != len(rows) or manifest.get(
        "real_sample_count"
    ) != len(rows):
        raise ProvisionalFull22ExportError("prior sample count changed")

    supplemental_ids = set(supplemental_sample_ids)
    expected_ids = _prior_label_selection_ids(
        selection_by_sample,
        supplemental_sample_ids=supplemental_ids,
    )
    old_set = set(old_candidate_ids)
    by_sample: dict[str, dict[str, Any]] = {}
    work_split: dict[str, str] = {}
    for index, row in enumerate(rows, 1):
        location = f"prior training samples[{index}]"
        base.validate_seal(row, location=location)
        sample_id = base.require_id(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in by_sample:
            raise ProvisionalFull22ExportError(f"{location}: duplicate sample")
        if sample_id in supplemental_ids:
            raise ProvisionalFull22ExportError(
                f"{sample_id}: calibration-only sample leaked into prior labels"
            )
        selection = selection_by_sample.get(sample_id)
        if selection is None:
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior export is outside the sealed rescue selection"
            )
        merge = base.require_mapping(
            selection.get("merge_provenance"), f"{sample_id}.merge_provenance"
        )
        prior = base.require_mapping(
            merge.get("prior_final_record"), f"{sample_id}.prior_final_record"
        )
        try:
            labels.validate_final_record(prior, candidate_ids=old_candidate_ids)
        except labels.LabelValidationError as error:
            raise ProvisionalFull22ExportError(
                f"{sample_id}: invalid sealed prior final: {error}"
            ) from error
        if merge.get("training_sample_record_sha256") != row.get(
            "record_sha256"
        ) or merge.get("prior_final_record_sha256") != prior.get("record_sha256"):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: rescue/prior sample SHA binding changed"
            )
        for field in (
            "consistency",
            "font_judgment",
            "role",
            "source_style",
            "treatment",
        ):
            if row.get(field) != prior.get(field):
                raise ProvisionalFull22ExportError(
                    f"{sample_id}: prior export differs from sealed final field {field}"
                )
        review = base.require_mapping(
            row.get("review_provenance"), f"{sample_id}.review_provenance"
        )
        if review.get("final_record_sha256") != prior.get(
            "record_sha256"
        ) or review.get("resolution") != prior.get("resolution"):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior review provenance changed"
            )
        judgment = base.require_mapping(
            row.get("font_judgment"), f"{sample_id}.font_judgment"
        )
        partition = [
            candidate
            for tier in (*base.RANKED_TIERS, "unrenderable", "not_reviewed")
            for candidate in judgment.get(tier, [])
        ]
        if (
            len(partition) != len(old_set)
            or set(partition) != old_set
            or judgment.get("not_reviewed")
        ):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior 15-font tiers are incomplete"
            )
        source = base.require_mapping(row.get("source"), f"{sample_id}.source")
        if row.get("work_id") != selection.get("work_id") or source.get(
            "source_page_sha256"
        ) != selection.get("source_page_sha256"):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior sample source binding changed"
            )
        provenance = base.require_mapping(
            row.get("provenance"), f"{sample_id}.provenance"
        )
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: synthetic or QA-only prior sample is forbidden"
            )
        split = base.require_text(row.get("split"), f"{sample_id}.split")
        if split not in base.VALID_SPLITS:
            raise ProvisionalFull22ExportError(f"{sample_id}: invalid split")
        work_id = str(row["work_id"])
        previous = work_split.setdefault(work_id, split)
        if previous != split:
            raise ProvisionalFull22ExportError(
                f"{work_id}: prior export leaks a work across splits"
            )
        by_sample[sample_id] = copy.deepcopy(row)
    if set(by_sample) != expected_ids:
        missing = sorted(expected_ids - set(by_sample))
        extra = sorted(set(by_sample) - expected_ids)
        raise ProvisionalFull22ExportError(
            "prior export/rescue selection coverage differs; "
            f"missing={missing[:5]} extra={extra[:5]}"
        )
    return by_sample, work_split


def _validate_master_projection(
    *,
    master_by_sample: Mapping[str, Mapping[str, Any]],
    prior_by_sample: Mapping[str, Mapping[str, Any]],
    registry: base.RegistryContract,
    prior_master_manifest_sha256: str,
    prior_catalog_registry_sha256: str,
) -> tuple[str, ...]:
    prior_ids = set(prior_by_sample)
    missing_ids = prior_ids - set(master_by_sample)
    expected_missing_ids = prior_ids.intersection(registry.invalidated_parent_ids)
    if missing_ids != expected_missing_ids:
        unexpected = sorted(missing_ids - expected_missing_ids)
        still_present = sorted(expected_missing_ids - missing_ids)
        raise ProvisionalFull22ExportError(
            "successor master/prior projection differs from registry invalidations; "
            f"unexpected_missing={unexpected[:5]} invalidated_still_present="
            f"{still_present[:5]}"
        )
    for sample_id, prior in prior_by_sample.items():
        master = master_by_sample.get(sample_id)
        if master is None:
            continue
        prior_source = base.require_mapping(prior.get("source"), f"{sample_id}.source")
        prior_provenance = base.require_mapping(
            prior.get("provenance"), f"{sample_id}.provenance"
        )
        expected = {
            "chapter_id": master["chapter_id"],
            "geometry": master["geometry"],
            "page_id": master["page_id"],
            "sample_crop_sha256": master["sample_crop_sha256"],
            "source_page_sha256": master["source_page_sha256"],
            "views": master["views"],
            "work_id": master["work_id"],
        }
        actual = {
            "chapter_id": prior.get("chapter_id"),
            "geometry": prior_source.get("geometry"),
            "page_id": prior.get("page_id"),
            "sample_crop_sha256": prior_source.get("sample_crop_sha256"),
            "source_page_sha256": prior_source.get("source_page_sha256"),
            "views": prior_source.get("views"),
            "work_id": prior.get("work_id"),
        }
        if actual != expected or prior.get("split") != master.get("split"):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior training pixels/master projection changed"
            )
        if prior_provenance.get("master") != master.get("master_provenance"):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior master provenance changed"
            )
        bindings = base.require_mapping(
            prior.get("input_bindings"), f"{sample_id}.input_bindings"
        )
        if (
            bindings.get("master_manifest_sha256") != prior_master_manifest_sha256
            or bindings.get("catalog_registry_sha256") != prior_catalog_registry_sha256
        ):
            raise ProvisionalFull22ExportError(
                f"{sample_id}: prior sample escaped its sealed base master/registry"
            )
    return tuple(sorted(missing_ids))


def _authorized_training_quarantine_ids(state: Mapping[str, Any]) -> set[str]:
    source = base.require_mapping(state.get("source"), "workspace.source")
    authorized = set(
        base.require_mapping(source.get("selection"), "workspace.source.selection")
    )
    prior_calibration = base.require_mapping(
        state.get("prior_calibration"), "workspace.prior_calibration"
    )
    authorized.update(
        delta._string_array(
            prior_calibration.get("training_quarantine_sample_ids", []),
            "workspace prior calibration training quarantine",
        )
    )
    supplement = source.get("calibration_only_supplement")
    if supplement is not None:
        authorized.update(
            delta._string_array(
                base.require_mapping(
                    supplement, "workspace calibration-only supplement"
                ).get("training_quarantine_sample_ids"),
                "workspace calibration supplement training quarantine",
            )
        )
    return authorized


def _load_finalized_artifacts(
    workspace: Path,
    *,
    state: Mapping[str, Any],
    validation: Mapping[str, Any],
    stages_by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> tuple[dict[str, Any], tuple[str, ...], tuple[str, ...], dict[str, str]]:
    if validation.get("provisional_catalog_record_sha256") is None:
        raise ProvisionalFull22ExportError(
            "v5 workspace must be provisionally finalized before export"
        )
    paths = {name: workspace / filename for name, filename in FINALIZED_FILES.items()}
    if not all(path.is_file() for path in paths.values()):
        raise ProvisionalFull22ExportError(
            "v5 provisional artifact transaction is incomplete"
        )
    report = delta.read_json(paths["provisional_report"])
    disposition = delta.read_json(paths["catalog_disposition"])
    provisional_catalog = delta.read_json(paths["provisional_catalog"])
    quarantine = delta.read_json(paths["training_quarantine"])
    for name, record in (
        ("provisional report", report),
        ("catalog disposition", disposition),
        ("provisional catalog", provisional_catalog),
        ("training quarantine", quarantine),
    ):
        delta.validate_seal(record, name)
    if (
        report.get("release_state") != "provisional_not_released"
        or report.get("final_release_allowed") is not False
        or report.get("full22_utility_audit_required") is not True
        or report.get("catalog_disposition_record_sha256")
        != disposition.get("record_sha256")
        or report.get("provisional_catalog_record_sha256")
        != provisional_catalog.get("record_sha256")
    ):
        raise ProvisionalFull22ExportError(
            "v5 provisional report does not authorize a training-only utility run"
        )
    output_hashes = base.require_mapping(report.get("outputs"), "provisional.outputs")
    expected_output_hashes = {
        "agreement_report_sha256": base.sha256_file(paths["agreement_report"]),
        "catalog_disposition_sha256": base.sha256_file(paths["catalog_disposition"]),
        "eligibility_exceptions_sha256": base.sha256_file(
            paths["eligibility_exceptions"]
        ),
        "provisional_catalog_sha256": base.sha256_file(paths["provisional_catalog"]),
        "training_quarantine_sha256": base.sha256_file(paths["training_quarantine"]),
    }
    for key, expected in expected_output_hashes.items():
        if output_hashes.get(key) != expected:
            raise ProvisionalFull22ExportError(
                f"v5 provisional output binding changed: {key}"
            )

    exception_rows = _read_jsonl(
        paths["eligibility_exceptions"], "eligibility exceptions"
    )
    exception_ids: set[str] = set()
    for index, row in enumerate(exception_rows):
        delta.validate_seal(row, f"eligibility exceptions[{index}]")
        sample_id = base.require_id(
            row.get("sample_id"), f"eligibility exceptions[{index}].sample_id"
        )
        if sample_id in exception_ids:
            raise ProvisionalFull22ExportError("eligibility exception is duplicated")
        exception_ids.add(sample_id)
    expected_exception_ids = {
        sample_id
        for sample_id, stages in stages_by_sample.items()
        if delta._has_eligibility_exception(stages)
    }
    if exception_ids != expected_exception_ids:
        raise ProvisionalFull22ExportError(
            "eligibility exception artifact differs from resolved reviews"
        )

    quarantine_values = quarantine.get("sample_ids")
    if not isinstance(quarantine_values, list) or any(
        not isinstance(value, str) for value in quarantine_values
    ):
        raise ProvisionalFull22ExportError("training quarantine IDs are invalid")
    quarantine_ids = tuple(quarantine_values)
    if (
        len(quarantine_ids) != len(set(quarantine_ids))
        or quarantine.get("sample_count") != len(quarantine_ids)
        or sorted(quarantine_ids) != list(quarantine_ids)
    ):
        raise ProvisionalFull22ExportError("training quarantine is not canonical")
    authorized_quarantine_ids = _authorized_training_quarantine_ids(state)
    unknown_quarantine = sorted(set(quarantine_ids) - authorized_quarantine_ids)
    non_train_quarantine = sorted(
        sample_id
        for sample_id in quarantine_ids
        if state["source"]["split_by_sample"].get(sample_id) != "train"
    )
    if unknown_quarantine or non_train_quarantine:
        raise ProvisionalFull22ExportError(
            "training quarantine has unauthorized/non-train IDs; "
            f"unknown={unknown_quarantine[:5]} non_train={non_train_quarantine[:5]}"
        )
    return (
        disposition,
        tuple(sorted(exception_ids)),
        quarantine_ids,
        expected_output_hashes,
    )


def select_training_sample_ids(
    *,
    selected_ids: Iterable[str],
    source_ids: Iterable[str],
    eligibility_exception_ids: Iterable[str],
    training_quarantine_ids: Iterable[str],
    registry_invalidated_prior_ids: Iterable[str] = (),
    authorized_training_quarantine_ids: Iterable[str] | None = None,
    split_by_sample: Mapping[str, str],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return included/excluded IDs while enforcing the quarantine boundary."""

    selected = set(selected_ids)
    source = set(source_ids)
    exceptions = set(eligibility_exception_ids)
    quarantine = set(training_quarantine_ids)
    invalidated = set(registry_invalidated_prior_ids)
    quarantine_authority = (
        source
        if authorized_training_quarantine_ids is None
        else set(authorized_training_quarantine_ids)
    )
    if not selected <= source:
        raise ProvisionalFull22ExportError("v5 selected IDs escape source authority")
    if not exceptions <= selected:
        raise ProvisionalFull22ExportError(
            "eligibility exceptions escape the v5 selected population"
        )
    if not quarantine <= quarantine_authority:
        raise ProvisionalFull22ExportError(
            "training quarantine escapes its sealed source/closure authority"
        )
    if not invalidated <= source:
        raise ProvisionalFull22ExportError(
            "registry-invalidated prior samples escape the source population"
        )
    invalid_quarantine = sorted(
        sample_id
        for sample_id in quarantine
        if split_by_sample.get(sample_id) != "train"
    )
    if invalid_quarantine:
        raise ProvisionalFull22ExportError(
            f"training quarantine contains evaluation samples: {invalid_quarantine[:5]}"
        )
    included = tuple(sorted(selected - exceptions - quarantine - invalidated))
    if not included:
        raise ProvisionalFull22ExportError("no eligible full-22 samples remain")
    excluded = tuple(sorted(source - set(included)))
    return included, excluded


def strict_consensus_sample_ids(
    *,
    state: Mapping[str, Any],
    stages_by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]],
    validation: Mapping[str, Any],
) -> tuple[str, ...]:
    """Select only complete, independent, exact primary/secondary agreements."""

    if validation.get("missing_primary_count") or validation.get(
        "missing_secondary_count"
    ):
        raise ProvisionalFull22ExportError(
            "staging strict-consensus export waits for every assigned primary/secondary review"
        )
    selected: list[str] = []
    for sample_id in sorted(state["bindings_by_sample"]):
        stages = stages_by_sample.get(sample_id, {})
        primary = stages.get("primary")
        secondary = stages.get("secondary")
        # Primary-only rows and every disagreement are intentionally excluded.
        if primary is None or secondary is None or "adjudication" in stages:
            continue
        if delta._has_eligibility_exception(stages):
            continue
        if delta._judgments_disagree(primary, secondary):
            continue
        if any(
            float(review.get("confidence", 0.0)) < 0.80
            or float(base.nested(review, "role", "confidence") or 0.0) < 0.75
            or base.nested(review, "role", "primary") == "unknown_needs_review"
            or bool(base.nested(review, "font_judgment", "none_acceptable"))
            for review in (primary, secondary)
        ):
            continue
        if delta._trigger_reasons(stages, secondary_required=True):
            continue
        selected.append(sample_id)
    if not selected:
        raise ProvisionalFull22ExportError(
            "no strict independent primary/secondary consensus samples remain"
        )
    return tuple(selected)


def require_trainer_splits(samples: Sequence[Mapping[str, Any]]) -> None:
    available = {str(sample.get("split")) for sample in samples}
    missing = sorted({"train", "val"} - available)
    if missing:
        raise ProvisionalFull22ExportError(
            "provisional export is not trainer-compatible; missing split(s): "
            + ", ".join(missing)
        )


def _v5_source_review_projection(review: Mapping[str, Any]) -> dict[str, Any]:
    evidence = base.require_mapping(review.get("evidence"), "v5 review.evidence")
    return {
        "assignment_id": base.require_id(
            review.get("assignment_id"), "v5 review.assignment_id"
        ),
        "candidate_order_seed": evidence.get("candidate_order_seed"),
        "confidence": review.get("confidence"),
        "flags": [],
        "label_id": base.require_id(review.get("review_id"), "v5 review.review_id"),
        "record_sha256": base.require_sha(
            review.get("record_sha256"), "v5 review.record_sha256"
        ),
        "review_card_sha256": evidence.get("review_card_sha256"),
        "reviewed_at": base.require_text(
            review.get("reviewed_at"), "v5 review.reviewed_at"
        ),
        "reviewer": base.require_id(review.get("reviewer"), "v5 review.reviewer"),
        "stage": base.require_text(review.get("stage"), "v5 review.stage"),
    }


def rebind_merged_final_to_human_sources(
    *,
    merged_final: Mapping[str, Any],
    prior_sample: Mapping[str, Any],
    prior_judgment: Mapping[str, Any],
    delta_resolution: Mapping[str, Any],
    v5_reviews_by_id: Mapping[str, Mapping[str, Any]],
    candidate_ids: Sequence[str],
    resolver: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Replace merge-layer IDs with the exact underlying human-source IDs."""

    old_candidates = {
        str(candidate)
        for tier in (*base.RANKED_TIERS, "unrenderable", "not_reviewed")
        for candidate in prior_judgment.get(tier, [])
    }
    delta_judgment = base.require_mapping(
        delta_resolution.get("font_judgment"), "delta.font_judgment"
    )
    for tier in (*base.RANKED_TIERS, "unrenderable", "not_reviewed"):
        expected = [
            *prior_judgment.get(tier, []),
            *delta_judgment.get(tier, []),
        ]
        if merged_final.get("font_judgment", {}).get(tier) != expected:
            raise ProvisionalFull22ExportError(
                f"merged final mutated or reordered the sealed {tier} tier"
            )
    merged_partition = [
        candidate
        for tier in (*base.RANKED_TIERS, "unrenderable", "not_reviewed")
        for candidate in merged_final.get("font_judgment", {}).get(tier, [])
    ]
    if len(merged_partition) != len(candidate_ids) or set(merged_partition) != set(
        candidate_ids
    ):
        raise ProvisionalFull22ExportError(
            "merged final does not exactly partition the 22-font render bank"
        )
    if old_candidates & {
        str(candidate)
        for tier in (*base.RANKED_TIERS, "unrenderable", "not_reviewed")
        for candidate in delta_judgment.get(tier, [])
    }:
        raise ProvisionalFull22ExportError("old/new candidate identities overlap")

    prior_review = base.require_mapping(
        prior_sample.get("review_provenance"), "prior sample.review_provenance"
    )
    prior_resolution = base.require_mapping(
        prior_review.get("resolution"), "prior sample.review_provenance.resolution"
    )
    prior_source_ids = list(
        base.require_text(value, "prior source label ID")
        for value in prior_resolution.get("source_label_ids", [])
    )
    prior_source_reviews_value = prior_review.get("source_reviews")
    if not isinstance(prior_source_reviews_value, list):
        raise ProvisionalFull22ExportError("prior human source reviews are missing")
    prior_source_reviews = [
        copy.deepcopy(dict(base.require_mapping(row, "prior human source review")))
        for row in prior_source_reviews_value
    ]
    if {str(row.get("label_id")) for row in prior_source_reviews} != set(
        prior_source_ids
    ):
        raise ProvisionalFull22ExportError(
            "prior final/source-review provenance is incomplete"
        )

    delta_source_ids = [
        base.require_id(value, "delta source review ID")
        for value in delta_resolution.get("source_review_ids", [])
    ]
    if not delta_source_ids or len(delta_source_ids) != len(set(delta_source_ids)):
        raise ProvisionalFull22ExportError(
            "delta resolution lacks unique human source reviews"
        )
    try:
        delta_source_reviews = [
            _v5_source_review_projection(v5_reviews_by_id[review_id])
            for review_id in delta_source_ids
        ]
    except KeyError as error:
        raise ProvisionalFull22ExportError(
            f"delta resolution references unknown review {error.args[0]!r}"
        ) from error
    human_source_ids = [*prior_source_ids, *delta_source_ids]
    if len(human_source_ids) != len(set(human_source_ids)):
        raise ProvisionalFull22ExportError(
            "prior and delta human-source IDs unexpectedly overlap"
        )

    final = copy.deepcopy(dict(merged_final))
    final.pop("record_sha256", None)
    final["final_id"] = (
        "fmfl-"
        + base.stable_hash(
            AUTHORITY_SCHEMA_VERSION,
            str(merged_final.get("record_sha256")),
            *human_source_ids,
        )[:32]
    )
    resolution = copy.deepcopy(
        dict(base.require_mapping(final.get("resolution"), "merged resolution"))
    )
    resolution["resolver"] = base.require_id(resolver, "resolver")
    resolution["source_label_ids"] = human_source_ids
    final["resolution"] = resolution
    final = base.seal(final)
    try:
        labels.validate_final_record(final, candidate_ids=candidate_ids)
    except labels.LabelValidationError as error:
        raise ProvisionalFull22ExportError(
            f"provisional full-22 final is invalid: {error}"
        ) from error
    return final, [*prior_source_reviews, *delta_source_reviews]


def _build_training_sample(
    *,
    prior_sample: Mapping[str, Any],
    final: Mapping[str, Any],
    source_reviews: Sequence[Mapping[str, Any]],
    input_bindings: Mapping[str, Any],
    authority: Mapping[str, Any],
) -> dict[str, Any]:
    base.validate_seal(prior_sample, location="prior training sample")
    prior_source = base.require_mapping(
        prior_sample.get("source"), "prior training sample.source"
    )
    parent_identity = {
        "chapter_id": base.require_id(
            prior_sample.get("chapter_id"), "prior training sample.chapter_id"
        ),
        "page_id": base.require_id(
            prior_sample.get("page_id"), "prior training sample.page_id"
        ),
        "sample_id": base.require_id(
            prior_sample.get("sample_id"), "prior training sample.sample_id"
        ),
        "source_page_sha256": base.require_sha(
            prior_source.get("source_page_sha256"),
            "prior training sample.source.source_page_sha256",
        ),
        "work_id": base.require_id(
            prior_sample.get("work_id"), "prior training sample.work_id"
        ),
    }
    successor_binding = {
        "parent_identity": parent_identity,
        "parent_training_sample_record_sha256": base.require_sha(
            prior_sample.get("record_sha256"),
            "prior training sample.record_sha256",
        ),
        "relationship": FONT_SIGNAL_SUCCESSOR_RELATIONSHIP,
        "schema_version": FONT_SIGNAL_SUCCESSOR_SCHEMA_VERSION,
    }
    row = copy.deepcopy(dict(prior_sample))
    row.pop("record_sha256", None)
    row.pop("source_style_cluster", None)
    row.pop("training_selection", None)
    for field in (
        "consistency",
        "font_judgment",
        "role",
        "source_style",
        "treatment",
    ):
        row[field] = copy.deepcopy(final[field])
    row["input_bindings"] = copy.deepcopy(dict(input_bindings))
    provenance = copy.deepcopy(
        dict(base.require_mapping(row.get("provenance"), "sample.provenance"))
    )
    provenance["approval"] = "completed_human_final_label"
    provenance["full22_release_state"] = "provisional_training_only"
    provenance["font_signal_audit_successor"] = copy.deepcopy(successor_binding)
    row["provenance"] = provenance
    review_authority = copy.deepcopy(dict(authority))
    review_authority["font_signal_audit_successor"] = copy.deepcopy(successor_binding)
    row["review_provenance"] = {
        "authority": review_authority,
        "final_record_sha256": final["record_sha256"],
        "resolution": copy.deepcopy(final["resolution"]),
        "review_card_used_as_training_input": False,
        "source_reviews": [copy.deepcopy(dict(review)) for review in source_reviews],
    }
    return base.seal(row)


def _validate_rescue_binding(
    *, rescue_inputs: Path, state: Mapping[str, Any]
) -> Mapping[str, Any]:
    root = rescue_inputs.resolve()
    source_files = base.require_mapping(
        state["contract"].get("source_files"), "workspace.source_files"
    )
    expected_names = {
        "source_assignments": "assignments.jsonl",
        "source_master": "master.jsonl",
        "source_report": "report.json",
        "source_selection": "selection.jsonl",
    }
    for name, filename in expected_names.items():
        binding = base.require_mapping(
            source_files.get(name), f"workspace.source_files.{name}"
        )
        path = Path(base.require_text(binding.get("path"), f"{name}.path")).resolve()
        if path != root / filename:
            raise ProvisionalFull22ExportError(
                f"workspace is bound to another rescue input root: {name}"
            )
        _validate_file_sha(path, binding.get("sha256"), f"workspace {name}")
    marker_path = root / ".font-matching-catalog-rescue-inputs-owned.json"
    marker = base.read_json(marker_path, "rescue ownership marker")
    managed = base.require_mapping(marker.get("managed_files"), "rescue.managed_files")
    for filename in expected_names.values():
        _validate_file_sha(root / filename, managed.get(filename), f"rescue {filename}")
    report = delta.read_json(root / "report.json")
    delta.validate_seal(report, "rescue report", trailing_lf=True)
    if report.get("record_sha256") != state["contract"]["source_records"].get(
        "rescue_report_record_sha256"
    ):
        raise ProvisionalFull22ExportError("workspace rescue report binding changed")
    return report


def load_context(
    *,
    master_manifest: Path,
    catalog_registry: Path,
    rescue_inputs: Path,
    delta_workspace: Path,
    prior_training_export_dir: Path,
    render_bank_manifest: Path,
    resolver: str,
    allow_unfinalized_strict_consensus: bool = False,
) -> Full22Context:
    try:
        state = delta._load_workspace(delta_workspace)
        validation = delta._validate_workspace_state(
            state,
            require_complete=not allow_unfinalized_strict_consensus,
        )
        stages_by_sample, _ = delta._validate_review_records(state)
    except delta.DeltaLedgerError as error:
        raise ProvisionalFull22ExportError(
            f"v5 workspace is invalid: {error}"
        ) from error
    if (
        state["contract"].get("mode") != "production"
        or state["contract"].get("v5_derivation_required") is not True
    ):
        raise ProvisionalFull22ExportError(
            "full-22 export requires a production v5 workspace"
        )
    if (
        not allow_unfinalized_strict_consensus
        and validation.get("complete") is not True
    ):
        raise ProvisionalFull22ExportError(
            "finalized full-22 export requires a complete v5 workspace"
        )
    formal_finalized = validation.get("provisional_catalog_record_sha256") is not None
    rescue_report = _validate_rescue_binding(rescue_inputs=rescue_inputs, state=state)
    rescue_report_inputs = base.require_mapping(
        rescue_report.get("inputs"), "rescue report.inputs"
    )

    registry = base.load_registry_contract(catalog_registry)
    actual_registry_sha = base.sha256_file(catalog_registry)
    actual_master_sha = base.sha256_file(master_manifest)
    source_records = base.require_mapping(
        state["contract"].get("source_records"), "workspace.source_records"
    )
    master_registry_projection = _resolve_master_registry_projection(
        state_source=state["source"],
        source_records=source_records,
        rescue_report_inputs=rescue_report_inputs,
        actual_master_sha256=actual_master_sha,
        actual_catalog_registry_sha256=actual_registry_sha,
        formal_finalized=formal_finalized,
        allow_unfinalized_strict_consensus=allow_unfinalized_strict_consensus,
    )
    masters, full_work_split, master_sha = base.read_master_rows(
        master_manifest, registry=registry
    )
    master_report_sha, master_split_map_sha = base.validate_registry_master_report(
        master_manifest,
        master_manifest_sha256=master_sha,
        registry=registry,
    )
    if (
        master_split_map_sha
        != master_registry_projection["successor_master_split_map_sha256"]
    ):
        raise ProvisionalFull22ExportError("master report/split authority changed")
    if (
        master_registry_projection["mode"] == "exact_base_rescue_authority"
        and master_report_sha != rescue_report_inputs.get("master_report_sha256")
    ):
        raise ProvisionalFull22ExportError("base master report authority changed")
    master_by_sample = {str(row["sample_id"]): row for row in masters}
    missing_supplement_master_ids = sorted(
        set(master_registry_projection["supplement_training_quarantine_sample_ids"])
        - set(master_by_sample)
    )
    if missing_supplement_master_ids:
        raise ProvisionalFull22ExportError(
            "successor master omits sealed calibration supplement closure: "
            f"{missing_supplement_master_ids[:5]}"
        )

    old_candidate_ids = tuple(sorted(state["source"]["old_candidates"]))
    new_candidate_ids = tuple(sorted(state["source"]["alias_to_id"].values()))
    if len(old_candidate_ids) != 15 or len(new_candidate_ids) != 7:
        raise ProvisionalFull22ExportError("v5 workspace is not an exact 15+7 delta")
    selection_by_sample = state["source"]["selection"]
    prior_by_sample, prior_work_split = _validate_prior_training_export(
        prior_training_export_dir=prior_training_export_dir,
        rescue_report=rescue_report,
        selection_by_sample=selection_by_sample,
        old_candidate_ids=old_candidate_ids,
        supplemental_sample_ids=master_registry_projection["supplemental_sample_ids"],
    )
    registry_invalidated_prior_ids = _validate_master_projection(
        master_by_sample=master_by_sample,
        prior_by_sample=prior_by_sample,
        registry=registry,
        prior_master_manifest_sha256=master_registry_projection[
            "base_master_manifest_sha256"
        ],
        prior_catalog_registry_sha256=master_registry_projection[
            "base_catalog_registry_sha256"
        ],
    )
    for work_id, split in prior_work_split.items():
        if full_work_split.get(work_id) != split:
            raise ProvisionalFull22ExportError(
                f"{work_id}: authoritative work split changed"
            )

    prototypes, candidate_ids, render_sha, specification_sha = (
        base.read_render_bank_rows(render_bank_manifest, expected_candidate_count=22)
    )
    expected_candidates = set(old_candidate_ids) | set(new_candidate_ids)
    render_document = base.read_json(render_bank_manifest, "full-22 render bank")
    if (
        set(candidate_ids) != expected_candidates
        or render_sha != source_records.get("expanded_render_bank_sha256")
        or base.nested(render_document, "source_contract", "manifest_sha256")
        != source_records.get("expanded_catalog_sha256")
    ):
        raise ProvisionalFull22ExportError(
            "render bank is not the exact sealed 22-font catalog"
        )

    if allow_unfinalized_strict_consensus:
        if formal_finalized:
            raise ProvisionalFull22ExportError(
                "strict-consensus staging mode is forbidden after formal provisional finalize"
            )
        strict_ids = strict_consensus_sample_ids(
            state=state,
            stages_by_sample=stages_by_sample,
            validation=validation,
        )
        exception_ids = tuple(
            sorted(
                sample_id
                for sample_id, stages in stages_by_sample.items()
                if delta._has_eligibility_exception(stages)
            )
        )
        quarantine_ids = tuple(
            sorted(state["prior_calibration"]["training_quarantine_sample_ids"])
        )
        finalized_hashes: dict[str, str | None] = {
            "catalog_disposition_sha256": None,
            "eligibility_exceptions_sha256": None,
            "provisional_catalog_sha256": None,
            "training_quarantine_sha256": None,
        }
        disposition: dict[str, Any] | None = None
    else:
        disposition, exception_ids, quarantine_ids, strict_hashes = (
            _load_finalized_artifacts(
                delta_workspace,
                state=state,
                validation=validation,
                stages_by_sample=stages_by_sample,
            )
        )
        finalized_hashes = dict(strict_hashes)
        strict_ids = tuple(sorted(state["bindings_by_sample"]))
    required_supplement_quarantine = set(
        master_registry_projection["supplement_training_quarantine_sample_ids"]
    )
    if not required_supplement_quarantine.issubset(quarantine_ids):
        missing = sorted(required_supplement_quarantine - set(quarantine_ids))
        raise ProvisionalFull22ExportError(
            "formal training quarantine omits calibration supplement closure: "
            f"{missing[:5]}"
        )
    scoped_ids, _initial_excluded_ids = select_training_sample_ids(
        selected_ids=state["bindings_by_sample"],
        source_ids=selection_by_sample,
        eligibility_exception_ids=exception_ids,
        training_quarantine_ids=quarantine_ids,
        registry_invalidated_prior_ids=registry_invalidated_prior_ids,
        authorized_training_quarantine_ids=_authorized_training_quarantine_ids(state),
        split_by_sample=state["source"]["split_by_sample"],
    )
    active_prior_ids = set(prior_by_sample) - set(registry_invalidated_prior_ids)
    included_ids = tuple(
        sorted(set(scoped_ids).intersection(strict_ids, active_prior_ids))
    )
    if not included_ids:
        raise ProvisionalFull22ExportError("no eligible full-22 samples remain")
    excluded_ids = tuple(sorted(set(selection_by_sample) - set(included_ids)))
    if set(master_registry_projection["supplemental_sample_ids"]).intersection(
        included_ids
    ):
        raise ProvisionalFull22ExportError(
            "calibration-only supplement leaked into training"
        )

    review_by_id = {
        base.require_id(row.get("review_id"), "v5 review.review_id"): row
        for row in state["reviews"]
    }
    resolved_rows: list[dict[str, Any]] = []
    uncapped_samples: list[dict[str, Any]] = []
    resolution_counts: Counter[str] = Counter()
    disposition_sha = (
        base.require_sha(
            disposition.get("record_sha256"), "catalog disposition.record_sha256"
        )
        if disposition is not None
        else None
    )
    per_sample_bindings = {
        "catalog_registry_sha256": actual_registry_sha,
        "font_catalog_sha256": source_records["expanded_catalog_sha256"],
        "master_manifest_sha256": master_sha,
        "render_bank_manifest_sha256": render_sha,
        "render_specification_sha256": specification_sha,
        "renderer_hash": render_sha,
    }
    authority = {
        "all_22_candidates_retained_for_utility_audit": True,
        "candidate_count": 22,
        "catalog_disposition_record_sha256": disposition_sha,
        "eligibility_exceptions_excluded": True,
        "formal_calibration_gate_passed": formal_finalized,
        "old_tier_mutation_allowed": False,
        "provisional_catalog_record_sha256": validation.get(
            "provisional_catalog_record_sha256"
        ),
        "resolved_label_file": RESOLVED_LABEL_FILE,
        "schema_version": AUTHORITY_SCHEMA_VERSION,
        "selection_mode": (
            "formal_finalized_all_resolved"
            if formal_finalized
            else "unfinalized_exact_independent_consensus_only"
        ),
        "tier_merge": "immutable_prior15_plus_exact_resolved_delta7",
        "top1_synthesis_allowed": False,
        "training_only": True,
        "training_quarantine_excluded": True,
    }
    for sample_id in included_ids:
        stages = stages_by_sample[sample_id]
        secondary_required = "secondary" in state["bindings_by_sample"][sample_id]
        final_review, kind, reasons, source_reviews = delta._resolved_review(
            sample_id, stages, secondary_required=secondary_required
        )
        delta_resolution = delta._delta_resolution(
            state=state,
            sample_id=sample_id,
            final_review=final_review,
            resolution_kind=kind,
            reasons=reasons,
            source_reviews=source_reviews,
            catalog_disposition_record_sha256=disposition_sha,
        )
        merged = delta._merge_final_record(
            state=state,
            sample_id=sample_id,
            delta=delta_resolution,
            resolver=resolver,
        )
        selection = selection_by_sample[sample_id]
        prior_final = base.require_mapping(
            base.nested(selection, "merge_provenance", "prior_final_record"),
            f"{sample_id}.prior_final_record",
        )
        final, human_source_reviews = rebind_merged_final_to_human_sources(
            merged_final=merged,
            prior_sample=prior_by_sample[sample_id],
            prior_judgment=base.require_mapping(
                prior_final.get("font_judgment"), f"{sample_id}.prior_judgment"
            ),
            delta_resolution=delta_resolution,
            v5_reviews_by_id=review_by_id,
            candidate_ids=candidate_ids,
            resolver=resolver,
        )
        resolved_rows.append(final)
        uncapped_samples.append(
            _build_training_sample(
                prior_sample=prior_by_sample[sample_id],
                final=final,
                source_reviews=human_source_reviews,
                input_bindings=per_sample_bindings,
                authority=authority,
            )
        )
        resolution_counts[kind] += 1
    resolved_rows.sort(key=lambda row: str(row["sample_id"]))
    uncapped_samples.sort(key=lambda row: str(row["sample_id"]))
    samples, deduplication = base.deduplicate_body_dialogue_samples(uncapped_samples)
    require_trainer_splits(samples)
    chapter_pairs = base.build_chapter_pair_rows(samples)
    chapter_pair_contract = base.build_chapter_pair_contract(chapter_pairs)

    supplemental_sample_ids = tuple(
        master_registry_projection["supplemental_sample_ids"]
    )
    supplement_quarantine_ids = tuple(
        master_registry_projection["supplement_training_quarantine_sample_ids"]
    )
    master_registry_projection_contract = {
        "active_prior_sample_count": len(prior_by_sample)
        - len(registry_invalidated_prior_ids),
        "active_prior_sample_projection_exact": True,
        "base_catalog_registry_sha256": master_registry_projection[
            "base_catalog_registry_sha256"
        ],
        "base_master_manifest_sha256": master_registry_projection[
            "base_master_manifest_sha256"
        ],
        "invalidated_prior_sample_count": len(registry_invalidated_prior_ids),
        "invalidated_prior_sample_ids_sha256": base.sorted_ids_sha256(
            registry_invalidated_prior_ids
        ),
        "mode": master_registry_projection["mode"],
        "prior_sample_count": len(prior_by_sample),
        "replacement_prior_label_inheritance_allowed": False,
        "schema_version": MASTER_REGISTRY_PROJECTION_SCHEMA_VERSION,
        "supplement_manifest_file_sha256": master_registry_projection[
            "supplement_manifest_file_sha256"
        ],
        "supplement_manifest_record_sha256": master_registry_projection[
            "supplement_manifest_record_sha256"
        ],
        "supplement_training_quarantine_sample_count": len(supplement_quarantine_ids),
        "supplement_training_quarantine_sample_ids_sha256": (
            base.sorted_ids_sha256(supplement_quarantine_ids)
        ),
        "supplemental_prior_label_inheritance_allowed": False,
        "supplemental_sample_count": len(supplemental_sample_ids),
        "supplemental_sample_ids_sha256": base.sorted_ids_sha256(
            supplemental_sample_ids
        ),
        "successor_catalog_registry_sha256": actual_registry_sha,
        "successor_master_manifest_sha256": master_sha,
        "successor_master_split_map_sha256": master_split_map_sha,
    }

    input_hashes: dict[str, str | None] = {
        "augmentation_manifest_sha256": None,
        "catalog_disposition_sha256": finalized_hashes.get(
            "catalog_disposition_sha256"
        ),
        "catalog_registry_sha256": actual_registry_sha,
        "calibration_supplement_manifest_file_sha256": (
            master_registry_projection["supplement_manifest_file_sha256"]
        ),
        "calibration_supplement_manifest_record_sha256": (
            master_registry_projection["supplement_manifest_record_sha256"]
        ),
        "delta_reviews_sha256": base.sha256_file(delta_workspace / "reviews.jsonl"),
        "delta_workspace_contract_sha256": base.sha256_file(
            delta_workspace / "contract.json"
        ),
        "eligibility_exceptions_sha256": finalized_hashes.get(
            "eligibility_exceptions_sha256"
        ),
        "eligibility_exception_ids_sha256": base.sorted_ids_sha256(exception_ids),
        "excluded_final_ids_sha256": base.sorted_ids_sha256(excluded_ids),
        "exporter_source_sha256": base.sha256_file(Path(base.__file__).resolve()),
        "font_catalog_sha256": source_records["expanded_catalog_sha256"],
        "full22_exporter_source_sha256": base.sha256_file(Path(__file__).resolve()),
        "master_manifest_sha256": master_sha,
        "master_report_sha256": master_report_sha,
        "master_split_map_sha256": master_split_map_sha,
        "registry_invalidated_prior_ids_sha256": base.sorted_ids_sha256(
            registry_invalidated_prior_ids
        ),
        "prior_training_export_manifest_sha256": rescue_report_inputs[
            "training_export_manifest_sha256"
        ],
        "prior_training_export_samples_sha256": rescue_report_inputs[
            "training_export_samples_sha256"
        ],
        "provisional_catalog_sha256": finalized_hashes.get(
            "provisional_catalog_sha256"
        ),
        "provisional_report_sha256": (
            base.sha256_file(delta_workspace / "provisional-report.json")
            if formal_finalized
            else None
        ),
        "render_bank_manifest_sha256": render_sha,
        "render_specification_sha256": specification_sha,
        "rescue_report_sha256": base.sha256_file(rescue_inputs / "report.json"),
        "rescue_selection_sha256": base.sha256_file(rescue_inputs / "selection.jsonl"),
        "training_quarantine_ids_sha256": base.sorted_ids_sha256(quarantine_ids),
        "training_quarantine_sha256": finalized_hashes.get(
            "training_quarantine_sha256"
        ),
    }
    active_work_split = {str(row["work_id"]): str(row["split"]) for row in samples}
    export_context = base.ExportContext(
        samples=samples,
        prototype_rows=prototypes,
        augmentation_rows=[],
        candidate_ids=candidate_ids,
        input_hashes=input_hashes,
        master_manifest_sha256=master_sha,
        render_bank_manifest_sha256=render_sha,
        render_specification_sha256=specification_sha,
        font_catalog_sha256=source_records["expanded_catalog_sha256"],
        renderer_hash=render_sha,
        review_scope={
            "authority": AUTHORITY_SCHEMA_VERSION,
            "batch": "v5_provisional_full22_utility",
            "eligibility_exception_count": len(exception_ids),
            "source_selected_count": len(selection_by_sample),
            "training_quarantine_count": len(quarantine_ids),
            "v5_resolved_count": len(resolved_rows),
            "formal_calibration_gate_passed": formal_finalized,
        },
        work_split=active_work_split,
        resolution_counts=dict(sorted(resolution_counts.items())),
        completed_final_count=len(resolved_rows),
        excluded_final_ids=excluded_ids,
        excluded_final_ids_sha256=base.sorted_ids_sha256(excluded_ids),
        catalog_registry_sha256=actual_registry_sha,
        master_report_sha256=master_report_sha,
        master_split_map_sha256=master_split_map_sha,
        parent_workspace_projection=False,
        registry_attestation=copy.deepcopy(dict(registry.input_attestation)),
        body_dialogue_deduplication=deduplication,
        chapter_pair_rows=chapter_pairs,
        chapter_pair_contract=chapter_pair_contract,
    )
    authority_contract = copy.deepcopy(authority)
    selected_sample_ids = tuple(sorted(str(row["sample_id"]) for row in samples))
    parent_sample_ids = tuple(sorted(prior_by_sample))
    omitted_parent_sample_ids = tuple(
        sorted(set(parent_sample_ids) - set(selected_sample_ids))
    )
    font_signal_audit_projection = {
        "audit_inventory_reconciliation": (FONT_SIGNAL_AUDIT_PROJECTION_RECONCILIATION),
        "excluded_audit_outcomes_must_be_absent": True,
        "omitted_parent_sample_count": len(omitted_parent_sample_ids),
        "omitted_parent_sample_ids_sha256": base.sorted_ids_sha256(
            omitted_parent_sample_ids
        ),
        "parent_training_sample_count": len(parent_sample_ids),
        "parent_training_sample_ids_sha256": base.sorted_ids_sha256(parent_sample_ids),
        "review_ready_subset_required": True,
        "schema_version": FONT_SIGNAL_AUDIT_PROJECTION_SCHEMA_VERSION,
        "selected_training_sample_count": len(selected_sample_ids),
        "selected_training_sample_ids_sha256": base.sorted_ids_sha256(
            selected_sample_ids
        ),
        "selection_authority_schema_version": AUTHORITY_SCHEMA_VERSION,
        "selection_mode": authority["selection_mode"],
    }
    return Full22Context(
        export=export_context,
        resolved_labels=resolved_rows,
        authority_contract=authority_contract,
        font_signal_audit_projection=font_signal_audit_projection,
        master_registry_projection=master_registry_projection_contract,
        eligibility_exception_ids=exception_ids,
        training_quarantine_ids=quarantine_ids,
    )


def _artifact_iterators(
    context: Full22Context,
) -> dict[str, Callable[[], Iterable[dict[str, Any]]]]:
    output = base.artifact_iterators(context.export)
    output[RESOLVED_LABEL_FILE] = lambda: iter(context.resolved_labels)
    return output


def _build_manifest(
    context: Full22Context, descriptors: Mapping[str, base.ArtifactDescriptor]
) -> dict[str, Any]:
    manifest = base.build_manifest(context.export, descriptors)
    contracts = dict(manifest["contracts"])
    contracts["provisional_full22"] = copy.deepcopy(context.authority_contract)
    contracts["font_signal_audit_projection"] = copy.deepcopy(
        context.font_signal_audit_projection
    )
    contracts["master_registry_projection"] = copy.deepcopy(
        context.master_registry_projection
    )
    manifest["contracts"] = contracts
    return manifest


def _build_report(
    context: Full22Context,
    descriptors: Mapping[str, base.ArtifactDescriptor],
    manifest_sha256: str,
) -> dict[str, Any]:
    report = base.build_report(context.export, descriptors, manifest_sha256)
    report["checks"].update(
        {
            "eligibility_exception_leakage_count": 0,
            "old_tier_mutation_count": 0,
            "synthetic_top1_tie_count": 0,
            "training_quarantine_leakage_count": 0,
            "unresolved_included_v5_record_count": 0,
        }
    )
    report["provisional_full22"] = copy.deepcopy(context.authority_contract)
    report["master_registry_projection"] = copy.deepcopy(
        context.master_registry_projection
    )
    report["summary"].update(
        {
            "eligibility_exception_excluded_count": len(
                context.eligibility_exception_ids
            ),
            "resolved_full22_label_count": len(context.resolved_labels),
            "training_quarantine_excluded_count": len(context.training_quarantine_ids),
        }
    )
    return report


def _assert_disjoint_output(output_dir: Path, inputs: Sequence[Path]) -> None:
    output = output_dir.resolve()
    for raw in inputs:
        protected = raw.resolve()
        if protected.is_file():
            protected = protected.parent
        if (
            output == protected
            or protected in output.parents
            or output in protected.parents
        ):
            raise ProvisionalFull22ExportError(
                f"training export must be disjoint from input root: {protected}"
            )


def _validate_output_with_context(
    *, output_dir: Path, context: Full22Context
) -> dict[str, Any]:
    base.validate_chapter_pair_rows(
        context.export.samples, context.export.chapter_pair_rows
    )
    base.assert_owned_output(output_dir)
    marker_path = output_dir / base.MARKER_FILE
    manifest_path = output_dir / base.MANIFEST_FILE
    report_path = output_dir / base.REPORT_FILE
    marker = base.read_json(marker_path, "ownership marker")
    manifest_payload = manifest_path.read_bytes()
    report_payload = report_path.read_bytes()
    if marker.get("manifest_sha256") != base.sha256_bytes(
        manifest_payload
    ) or marker.get("report_sha256") != base.sha256_bytes(report_payload):
        raise ProvisionalFull22ExportError("output metadata hash binding failed")
    iterators = _artifact_iterators(context)
    expected_files = {
        base.MARKER_FILE,
        base.MANIFEST_FILE,
        base.REPORT_FILE,
        *iterators,
    }
    if base.list_files(output_dir) != expected_files:
        raise ProvisionalFull22ExportError("output file inventory changed")
    descriptors: dict[str, base.ArtifactDescriptor] = {}
    for name, factory in iterators.items():
        expected = base.digest_records(name, factory())
        path = output_dir / name
        actual = base.ArtifactDescriptor(
            name,
            base.count_jsonl_records(path),
            base.sha256_file(path),
            path.stat().st_size,
        )
        if actual != expected:
            raise ProvisionalFull22ExportError(
                f"{name}: deterministic artifact changed"
            )
        descriptors[name] = expected
    rebuilt_manifest = _build_manifest(context, descriptors)
    expected_manifest_payload = base.canonical_json_bytes(rebuilt_manifest, pretty=True)
    if expected_manifest_payload != manifest_payload:
        raise ProvisionalFull22ExportError("manifest is not deterministic")
    rebuilt_report = _build_report(
        context,
        descriptors,
        base.sha256_bytes(expected_manifest_payload),
    )
    if base.canonical_json_bytes(rebuilt_report, pretty=True) != report_payload:
        raise ProvisionalFull22ExportError("report is not deterministic")
    return {
        "candidate_count": len(context.export.candidate_ids),
        "manifest_sha256": base.sha256_bytes(manifest_payload),
        "resolved_label_count": len(context.resolved_labels),
        "sample_count": len(context.export.samples),
        "status": "valid_provisional_full22",
    }


def build_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    catalog_registry: Path,
    rescue_inputs: Path,
    delta_workspace: Path,
    prior_training_export_dir: Path,
    render_bank_manifest: Path,
    resolver: str,
    allow_unfinalized_strict_consensus: bool = False,
) -> dict[str, Any]:
    _assert_disjoint_output(
        output_dir,
        (
            master_manifest,
            catalog_registry,
            rescue_inputs,
            delta_workspace,
            prior_training_export_dir,
            render_bank_manifest,
        ),
    )
    base.assert_replaceable_output(output_dir)
    context = load_context(
        master_manifest=master_manifest,
        catalog_registry=catalog_registry,
        rescue_inputs=rescue_inputs,
        delta_workspace=delta_workspace,
        prior_training_export_dir=prior_training_export_dir,
        render_bank_manifest=render_bank_manifest,
        resolver=resolver,
        allow_unfinalized_strict_consensus=allow_unfinalized_strict_consensus,
    )
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    completed = False
    try:
        descriptors = {
            name: base.write_jsonl_artifact(staging / name, factory())
            for name, factory in _artifact_iterators(context).items()
        }
        manifest = _build_manifest(context, descriptors)
        manifest_payload = base.canonical_json_bytes(manifest, pretty=True)
        report = _build_report(
            context, descriptors, base.sha256_bytes(manifest_payload)
        )
        report_payload = base.canonical_json_bytes(report, pretty=True)
        marker = {
            "manifest_sha256": base.sha256_bytes(manifest_payload),
            "owner": base.OWNER,
            "report_sha256": base.sha256_bytes(report_payload),
            "safe_replace": True,
            "schema_version": base.SCHEMA_VERSION,
        }
        (staging / base.MANIFEST_FILE).write_bytes(manifest_payload)
        (staging / base.REPORT_FILE).write_bytes(report_payload)
        (staging / base.MARKER_FILE).write_bytes(
            base.canonical_json_bytes(marker, pretty=True)
        )
        result = _validate_output_with_context(output_dir=staging, context=context)
        base.atomic_replace_directory(output_dir, staging)
        completed = True
        return result
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)


def validate_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    catalog_registry: Path,
    rescue_inputs: Path,
    delta_workspace: Path,
    prior_training_export_dir: Path,
    render_bank_manifest: Path,
    resolver: str,
    allow_unfinalized_strict_consensus: bool = False,
) -> dict[str, Any]:
    context = load_context(
        master_manifest=master_manifest,
        catalog_registry=catalog_registry,
        rescue_inputs=rescue_inputs,
        delta_workspace=delta_workspace,
        prior_training_export_dir=prior_training_export_dir,
        render_bank_manifest=render_bank_manifest,
        resolver=resolver,
        allow_unfinalized_strict_consensus=allow_unfinalized_strict_consensus,
    )
    return _validate_output_with_context(output_dir=output_dir, context=context)


def _add_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--rescue-inputs", type=Path, required=True)
    parser.add_argument("--delta-workspace", type=Path, required=True)
    parser.add_argument("--prior-training-export-dir", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--resolver", required=True)
    parser.add_argument(
        "--allow-unfinalized-strict-consensus",
        action="store_true",
        help=(
            "Training-only emergency path: require complete assigned primary/secondary "
            "reviews and export only exact independent consensus; never a release authority."
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    _add_inputs(build)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--check", action="store_true")
    validate = commands.add_parser("validate")
    _add_inputs(validate)
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    kwargs = {
        "catalog_registry": args.catalog_registry.resolve(),
        "delta_workspace": args.delta_workspace.resolve(),
        "master_manifest": args.master_manifest.resolve(),
        "output_dir": args.output_dir.resolve(),
        "prior_training_export_dir": args.prior_training_export_dir.resolve(),
        "render_bank_manifest": args.render_bank_manifest.resolve(),
        "rescue_inputs": args.rescue_inputs.resolve(),
        "resolver": args.resolver,
        "allow_unfinalized_strict_consensus": (args.allow_unfinalized_strict_consensus),
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
    except (ProvisionalFull22ExportError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
