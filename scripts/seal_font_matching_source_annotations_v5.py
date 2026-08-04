#!/usr/bin/env python3
"""Seal candidate-free neutral reviews against production v5 source tasks.

Neutral review rows intentionally retain the private assignment/sample IDs used
by the source-card split manifests.  Production source tasks expose different,
opaque public IDs.  This tool uses the sealed private ledger binding as the only
allowed bridge between those namespaces, then rebuilds and validates a complete
write-once v5 source-annotation batch.

Only candidate-free visual evidence is projected from the neutral input.  No
candidate, font-identity, or prior-answer value from the private binding can
reach the sealed output.

For adjudication A, the production review ledger is authoritative: the tool
uses the ledger's frozen trigger function, excludes eligibility exceptions,
rebinds only triggered primary public tasks, requires an independent reviewer,
and seals the exact primary-then-secondary review-record SHA chain into every
output row.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import derive_font_matching_delta_decisions as derive
    from scripts import font_matching_catalog_delta_ledger as catalog_ledger
except (ImportError, ModuleNotFoundError):  # direct ``python scripts/...``
    import derive_font_matching_delta_decisions as derive
    import font_matching_catalog_delta_ledger as catalog_ledger


NEUTRAL_SCHEMA_VERSION = "font-matching-delta-source-annotation-neutral-v5"
NEUTRAL_RECORD_TYPE = "font_matching_delta_source_annotation_neutral"
PRIVATE_BINDING_SCHEMA_VERSION = "font-matching-catalog-delta-ledger-v1"
PRIVATE_BINDING_RECORD_TYPE = "font_catalog_delta_private_binding"
PRIVATE_BINDING_VISIBILITY = "private_reveal_mapping_merge_only"

NEUTRAL_KEYS = {
    "schema_version",
    "record_type",
    "assignment_id",
    "sample_id",
    "stage",
    "source_only_card_sha256",
    "eligibility_evidence",
    "role_evidence",
    "source_family",
    "source_family_confidence",
    "serif_evidence",
    "axes",
    "hard_axes",
    "treatment",
    "rationale",
    "review_confidence",
    "visual_review_index",
}
SAFE_NEUTRAL_EVIDENCE_KEYS = (
    "eligibility_evidence",
    "role_evidence",
    "source_family",
    "source_family_confidence",
    "serif_evidence",
    "axes",
    "hard_axes",
    "treatment",
    "rationale",
)
PRIVATE_BINDING_KEYS = {
    "schema_version",
    "record_type",
    "assignment",
    "card",
    "prior_final_record_sha256",
    "record_sha256",
    "sample_id",
    "selection_record_sha256",
    "source_page_sha256",
    "visibility",
    "work_id",
}
PRIVATE_ASSIGNMENT_KEYS = {
    "assignment_id",
    "review_order",
    "sample_id",
    "source_page_sha256",
    "stage",
    "work_id",
}
PRIVATE_CARD_KEYS = {
    "assignment_id",
    "sample_id",
    "stage",
    "review_card_sha256",
    "review_card_file",
    "v5_public_ids",
    "v5_source_card",
}
V5_PUBLIC_ID_KEYS = {"assignment_id", "sample_id"}
V5_SOURCE_CARD_KEYS = {"file", "sha256", "pixel_sha256", "size_px"}
REVIEW_RECORD_KEYS = {
    "schema_version",
    "record_type",
    "review_id",
    "sample_id",
    "work_id",
    "source_page_sha256",
    "assignment_id",
    "stage",
    "reviewer",
    "reviewed_at",
    "role",
    "eligibility",
    "font_judgment",
    "confidence",
    "rationale",
    "evidence",
    "source_bindings",
    "source_review_record_sha256s",
    "derivation_evidence",
    "record_sha256",
}
REVIEW_ROLE_KEYS = {"primary", "confidence"}
REVIEW_JUDGMENT_KEYS = {*catalog_ledger.TIERS, "none_acceptable"}


class SourceAnnotationSealError(ValueError):
    """Raised when neutral reviews cannot be sealed without weakening v5."""


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SourceAnnotationSealError(f"{location} must be an object")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], location: str
) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise SourceAnnotationSealError(
            f"{location} keys mismatch; missing={missing}, extra={extra}"
        )


def _require_id(value: Any, location: str) -> str:
    if not isinstance(value, str) or derive.ID_RE.fullmatch(value) is None:
        raise SourceAnnotationSealError(f"{location} must be a stable identifier")
    return value


def _require_sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or derive.SHA_RE.fullmatch(value) is None:
        raise SourceAnnotationSealError(f"{location} must be a lowercase SHA-256")
    return value


def _require_stage(value: Any, location: str) -> str:
    if value not in {"primary", "secondary"}:
        raise SourceAnnotationSealError(f"{location} must be primary or secondary")
    return str(value)


def _require_review_order(value: Any, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SourceAnnotationSealError(
            f"{location} must be a non-negative integer"
        )
    return value


def _require_unit(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SourceAnnotationSealError(f"{location} must be a number in [0, 1]")
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise SourceAnnotationSealError(
            f"{location} must be a finite number in [0, 1]"
        )
    return result


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise SourceAnnotationSealError(f"cannot read {label}: {error}") from error
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise SourceAnnotationSealError(
                f"{label}[{line_number}] blank lines are forbidden"
            )
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise SourceAnnotationSealError(
                f"{label}[{line_number}] invalid JSON: {error}"
            ) from error
        if not isinstance(value, dict):
            raise SourceAnnotationSealError(
                f"{label}[{line_number}] must be an object"
            )
        rows.append(value)
    if not rows:
        raise SourceAnnotationSealError(f"{label} must not be empty")
    return rows


def _validate_private_record_seal(record: Mapping[str, Any], location: str) -> None:
    digest = _require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    payload = dict(record)
    payload.pop("record_sha256", None)
    if derive.sha256_bytes(derive.canonical_json_bytes(payload)) != digest:
        raise SourceAnnotationSealError(f"{location}.record_sha256 is invalid")


def _validated_source_tasks(
    rows: Sequence[Mapping[str, Any]], *, stage: str
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    normalized: list[dict[str, Any]] = []
    by_assignment: dict[str, dict[str, Any]] = {}
    sample_ids: set[str] = set()
    for index, row in enumerate(rows, 1):
        task = derive.validate_source_task(row, f"source_tasks[{index}]")
        if task["stage"] != stage:
            raise SourceAnnotationSealError(
                f"source_tasks[{index}] belongs to {task['stage']}, not {stage}"
            )
        assignment_id = str(task["assignment_id"])
        sample_id = str(task["sample_id"])
        if assignment_id in by_assignment:
            raise SourceAnnotationSealError(
                f"source tasks repeat assignment {assignment_id}"
            )
        if sample_id in sample_ids:
            raise SourceAnnotationSealError(f"source tasks repeat sample {sample_id}")
        by_assignment[assignment_id] = task
        sample_ids.add(sample_id)
        normalized.append(task)
    normalized.sort(key=lambda row: str(row["assignment_id"]))
    return normalized, by_assignment


def _private_binding_projection(
    rows: Sequence[Mapping[str, Any]],
    *,
    stage: str,
    allow_empty: bool = False,
    calibration_null_prior_by_sample: Mapping[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    by_private_assignment: dict[str, dict[str, Any]] = {}
    all_private_assignments: set[str] = set()
    all_public_assignments: set[str] = set()
    private_to_public_sample: dict[str, str] = {}
    public_to_private_sample: dict[str, str] = {}

    for index, row_value in enumerate(rows, 1):
        location = f"private_bindings[{index}]"
        row = _require_mapping(row_value, location)
        _require_exact_keys(row, PRIVATE_BINDING_KEYS, location)
        _validate_private_record_seal(row, location)
        if (
            row.get("schema_version") != PRIVATE_BINDING_SCHEMA_VERSION
            or row.get("record_type") != PRIVATE_BINDING_RECORD_TYPE
            or row.get("visibility") != PRIVATE_BINDING_VISIBILITY
        ):
            raise SourceAnnotationSealError(
                f"{location} is not a production v5 private binding"
            )

        private_sample_id = _require_id(row.get("sample_id"), f"{location}.sample_id")
        work_id = _require_id(row.get("work_id"), f"{location}.work_id")
        source_page_sha = _require_sha(
            row.get("source_page_sha256"), f"{location}.source_page_sha256"
        )
        selection_record_sha256 = _require_sha(
            row.get("selection_record_sha256"),
            f"{location}.selection_record_sha256",
        )
        # Calibration-only supplement rows intentionally have no inherited
        # final label.  Their sealed binding uses null here so the fresh pass
        # cannot acquire a synthetic or historical answer through provenance.
        prior_final_record_sha256 = row.get("prior_final_record_sha256")
        if prior_final_record_sha256 is None:
            expected_selection_sha = (
                calibration_null_prior_by_sample or {}
            ).get(private_sample_id)
            if expected_selection_sha != selection_record_sha256:
                raise SourceAnnotationSealError(
                    f"{location}.prior_final_record_sha256 may be null only for a "
                    "workspace-validated calibration supplement source record"
                )
        else:
            _require_sha(
                prior_final_record_sha256,
                f"{location}.prior_final_record_sha256",
            )

        assignment = _require_mapping(row.get("assignment"), f"{location}.assignment")
        _require_exact_keys(
            assignment, PRIVATE_ASSIGNMENT_KEYS, f"{location}.assignment"
        )
        private_assignment_id = _require_id(
            assignment.get("assignment_id"),
            f"{location}.assignment.assignment_id",
        )
        assignment_stage = _require_stage(
            assignment.get("stage"), f"{location}.assignment.stage"
        )
        review_order = _require_review_order(
            assignment.get("review_order"), f"{location}.assignment.review_order"
        )
        if (
            assignment.get("sample_id") != private_sample_id
            or assignment.get("work_id") != work_id
            or assignment.get("source_page_sha256") != source_page_sha
        ):
            raise SourceAnnotationSealError(
                f"{location}.assignment differs from its private binding"
            )

        card = _require_mapping(row.get("card"), f"{location}.card")
        _require_exact_keys(card, PRIVATE_CARD_KEYS, f"{location}.card")
        if (
            card.get("assignment_id") != private_assignment_id
            or card.get("sample_id") != private_sample_id
            or card.get("stage") != assignment_stage
        ):
            raise SourceAnnotationSealError(
                f"{location}.card differs from its private assignment"
            )
        review_card_sha = _require_sha(
            card.get("review_card_sha256"), f"{location}.card.review_card_sha256"
        )
        review_card_file = card.get("review_card_file")
        if not isinstance(review_card_file, str) or not review_card_file:
            raise SourceAnnotationSealError(
                f"{location}.card.review_card_file must be text"
            )

        public_ids = _require_mapping(
            card.get("v5_public_ids"), f"{location}.card.v5_public_ids"
        )
        _require_exact_keys(
            public_ids, V5_PUBLIC_ID_KEYS, f"{location}.card.v5_public_ids"
        )
        public_assignment_id = _require_id(
            public_ids.get("assignment_id"),
            f"{location}.card.v5_public_ids.assignment_id",
        )
        public_sample_id = _require_id(
            public_ids.get("sample_id"),
            f"{location}.card.v5_public_ids.sample_id",
        )
        if (
            public_assignment_id == private_assignment_id
            or public_sample_id == private_sample_id
        ):
            raise SourceAnnotationSealError(
                f"{location} reuses a private ID on the public A surface"
            )

        source_card = _require_mapping(
            card.get("v5_source_card"), f"{location}.card.v5_source_card"
        )
        _require_exact_keys(
            source_card, V5_SOURCE_CARD_KEYS, f"{location}.card.v5_source_card"
        )
        source_card_sha = _require_sha(
            source_card.get("sha256"), f"{location}.card.v5_source_card.sha256"
        )
        _require_sha(
            source_card.get("pixel_sha256"),
            f"{location}.card.v5_source_card.pixel_sha256",
        )
        size = source_card.get("size_px")
        if (
            not isinstance(size, list)
            or len(size) != 2
            or any(
                isinstance(value, bool) or not isinstance(value, int) or value <= 0
                for value in size
            )
        ):
            raise SourceAnnotationSealError(
                f"{location}.card.v5_source_card.size_px is invalid"
            )
        source_card_file = source_card.get("file")
        if (
            not isinstance(source_card_file, str)
            or not source_card_file
            or source_card_file != review_card_file
            or source_card_sha != review_card_sha
        ):
            raise SourceAnnotationSealError(
                f"{location}.card is not bound to one source-only A card"
            )

        if private_assignment_id in all_private_assignments:
            raise SourceAnnotationSealError(
                f"private bindings repeat assignment {private_assignment_id}"
            )
        if public_assignment_id in all_public_assignments:
            raise SourceAnnotationSealError(
                f"private bindings repeat public assignment {public_assignment_id}"
            )
        all_private_assignments.add(private_assignment_id)
        all_public_assignments.add(public_assignment_id)

        prior_public = private_to_public_sample.setdefault(
            private_sample_id, public_sample_id
        )
        if prior_public != public_sample_id:
            raise SourceAnnotationSealError(
                f"private sample {private_sample_id} maps to multiple public IDs"
            )
        prior_private = public_to_private_sample.setdefault(
            public_sample_id, private_sample_id
        )
        if prior_private != private_sample_id:
            raise SourceAnnotationSealError(
                f"public sample {public_sample_id} maps to multiple private IDs"
            )

        if assignment_stage == stage:
            by_private_assignment[private_assignment_id] = {
                "private_assignment_id": private_assignment_id,
                "private_sample_id": private_sample_id,
                "public_assignment_id": public_assignment_id,
                "public_sample_id": public_sample_id,
                "stage": assignment_stage,
                "review_order": review_order,
                "source_only_card_sha256": source_card_sha,
                "work_id": work_id,
                "source_page_sha256": source_page_sha,
                "selection_record_sha256": selection_record_sha256,
                "prior_final_record_sha256": prior_final_record_sha256,
            }
    if not by_private_assignment and not allow_empty:
        raise SourceAnnotationSealError(
            f"private bindings contain no {stage} assignments"
        )
    return by_private_assignment


def _validated_neutral_annotations(
    rows: Sequence[Mapping[str, Any]], *, stage: str
) -> dict[str, dict[str, Any]]:
    by_private_assignment: dict[str, dict[str, Any]] = {}
    private_samples: set[str] = set()
    visual_indices: set[int] = set()
    for index, row_value in enumerate(rows, 1):
        location = f"neutral_annotations[{index}]"
        row = dict(_require_mapping(row_value, location))
        _require_exact_keys(row, NEUTRAL_KEYS, location)
        derive._walk_source_only(row, location)
        if (
            row.get("schema_version") != NEUTRAL_SCHEMA_VERSION
            or row.get("record_type") != NEUTRAL_RECORD_TYPE
        ):
            raise SourceAnnotationSealError(
                f"{location} is not a neutral v5 source annotation"
            )
        if row.get("stage") != stage:
            raise SourceAnnotationSealError(
                f"{location} belongs to {row.get('stage')}, not {stage}"
            )
        private_assignment_id = _require_id(
            row.get("assignment_id"), f"{location}.assignment_id"
        )
        private_sample_id = _require_id(
            row.get("sample_id"), f"{location}.sample_id"
        )
        _require_sha(
            row.get("source_only_card_sha256"),
            f"{location}.source_only_card_sha256",
        )
        confidence = row.get("review_confidence")
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(float(confidence))
            or not 0 <= float(confidence) <= 1
        ):
            raise SourceAnnotationSealError(
                f"{location}.review_confidence must be a finite number in [0, 1]"
            )
        visual_index = row.get("visual_review_index")
        if (
            isinstance(visual_index, bool)
            or not isinstance(visual_index, int)
            or visual_index <= 0
        ):
            raise SourceAnnotationSealError(
                f"{location}.visual_review_index must be a positive integer"
            )
        if private_assignment_id in by_private_assignment:
            raise SourceAnnotationSealError(
                f"neutral annotations repeat assignment {private_assignment_id}"
            )
        if private_sample_id in private_samples:
            raise SourceAnnotationSealError(
                f"neutral annotations repeat sample {private_sample_id}"
            )
        if visual_index in visual_indices:
            raise SourceAnnotationSealError(
                f"neutral annotations repeat visual index {visual_index}"
            )
        by_private_assignment[private_assignment_id] = row
        private_samples.add(private_sample_id)
        visual_indices.add(visual_index)
    return by_private_assignment


def _coverage_error(
    label: str, expected: set[str], actual: set[str]
) -> SourceAnnotationSealError:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    return SourceAnnotationSealError(
        f"{label} coverage mismatch; missing={missing[:5]}, extra={extra[:5]}"
    )


def _validate_review_judgment(value: Any, location: str) -> dict[str, Any]:
    judgment = _require_mapping(value, location)
    _require_exact_keys(judgment, REVIEW_JUDGMENT_KEYS, location)
    normalized: dict[str, Any] = {}
    seen: set[str] = set()
    for tier in catalog_ledger.TIERS:
        aliases = judgment.get(tier)
        if not isinstance(aliases, list):
            raise SourceAnnotationSealError(f"{location}.{tier} must be an array")
        normalized_aliases: list[str] = []
        for index, alias in enumerate(aliases):
            if not isinstance(alias, str) or derive.ALIAS_RE.fullmatch(alias) is None:
                raise SourceAnnotationSealError(
                    f"{location}.{tier}[{index}] must be a sealed blind alias"
                )
            if alias in seen:
                raise SourceAnnotationSealError(
                    f"{location} repeats a blind alias across tiers"
                )
            seen.add(alias)
            normalized_aliases.append(alias)
        normalized[tier] = normalized_aliases
    if seen != set(derive.FROZEN_ALIAS_ORDER):
        raise SourceAnnotationSealError(
            f"{location} does not partition the frozen blind catalog"
        )
    none_acceptable = judgment.get("none_acceptable")
    if not isinstance(none_acceptable, bool):
        raise SourceAnnotationSealError(
            f"{location}.none_acceptable must be boolean"
        )
    normalized["none_acceptable"] = none_acceptable
    return normalized


def _explicit_review_projection(
    rows: Sequence[Mapping[str, Any]],
    *,
    primary_bindings: Mapping[str, Mapping[str, Any]],
    secondary_bindings: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Mapping[str, Any]]]:
    """Validate the sealed prior-review subset needed to reproduce triggers."""

    bindings_by_public: dict[str, Mapping[str, Any]] = {}
    for binding in (*primary_bindings.values(), *secondary_bindings.values()):
        public_assignment_id = str(binding["public_assignment_id"])
        if public_assignment_id in bindings_by_public:
            raise SourceAnnotationSealError(
                f"private bindings repeat public assignment {public_assignment_id}"
            )
        bindings_by_public[public_assignment_id] = binding

    by_sample: dict[str, dict[str, Mapping[str, Any]]] = {}
    for index, row_value in enumerate(rows, 1):
        location = f"reviews[{index}]"
        row = _require_mapping(row_value, location)
        _require_exact_keys(row, REVIEW_RECORD_KEYS, location)
        try:
            catalog_ledger.validate_seal(row, location)
        except catalog_ledger.DeltaLedgerError as error:
            raise SourceAnnotationSealError(str(error)) from error
        if (
            row.get("schema_version") != catalog_ledger.SCHEMA_VERSION
            or row.get("record_type") != "font_catalog_delta_blind_review"
        ):
            raise SourceAnnotationSealError(
                f"{location} is not a submitted production blind review"
            )
        stage = row.get("stage")
        if stage not in {"primary", "secondary"}:
            raise SourceAnnotationSealError(
                f"{location} must contain only prior primary/secondary reviews"
            )
        assignment_id = _require_id(
            row.get("assignment_id"), f"{location}.assignment_id"
        )
        binding = bindings_by_public.get(assignment_id)
        if binding is None or binding["stage"] != stage:
            raise SourceAnnotationSealError(
                f"{location} does not bind a production {stage} assignment"
            )
        private_sample_id = _require_id(
            row.get("sample_id"), f"{location}.sample_id"
        )
        if (
            private_sample_id != binding["private_sample_id"]
            or row.get("work_id") != binding["work_id"]
            or row.get("source_page_sha256") != binding["source_page_sha256"]
        ):
            raise SourceAnnotationSealError(
                f"{location} differs from its sealed private binding"
            )
        _require_id(row.get("review_id"), f"{location}.review_id")
        _require_id(row.get("reviewer"), f"{location}.reviewer")
        if not isinstance(row.get("reviewed_at"), str) or not row["reviewed_at"]:
            raise SourceAnnotationSealError(f"{location}.reviewed_at must be text")

        role = _require_mapping(row.get("role"), f"{location}.role")
        _require_exact_keys(role, REVIEW_ROLE_KEYS, f"{location}.role")
        if role.get("primary") not in catalog_ledger.ROLE_VALUES:
            raise SourceAnnotationSealError(
                f"{location}.role.primary is unsupported"
            )
        _require_unit(role.get("confidence"), f"{location}.role.confidence")
        eligibility = row.get("eligibility")
        if eligibility not in catalog_ledger.ELIGIBILITY_VALUES:
            raise SourceAnnotationSealError(
                f"{location}.eligibility is unsupported"
            )
        if eligibility == "font_signal_present":
            _validate_review_judgment(
                row.get("font_judgment"), f"{location}.font_judgment"
            )
        elif row.get("font_judgment") is not None:
            raise SourceAnnotationSealError(
                f"{location}.font_judgment must be null for an eligibility exception"
            )
        _require_unit(row.get("confidence"), f"{location}.confidence")
        if not isinstance(row.get("rationale"), str) or not row["rationale"].strip():
            raise SourceAnnotationSealError(f"{location}.rationale must be text")

        evidence = _require_mapping(row.get("evidence"), f"{location}.evidence")
        if evidence.get("public_sample_id") != binding["public_sample_id"]:
            raise SourceAnnotationSealError(
                f"{location}.evidence changed the public sample binding"
            )
        source_bindings = _require_mapping(
            row.get("source_bindings"), f"{location}.source_bindings"
        )
        if (
            source_bindings.get("selection_record_sha256")
            != binding["selection_record_sha256"]
            or source_bindings.get("prior_final_record_sha256")
            != binding["prior_final_record_sha256"]
        ):
            raise SourceAnnotationSealError(
                f"{location}.source_bindings changed merge provenance"
            )
        if row.get("source_review_record_sha256s") != []:
            raise SourceAnnotationSealError(
                f"{location}: primary/secondary review cannot cite source reviews"
            )
        if not isinstance(row.get("derivation_evidence"), Mapping):
            raise SourceAnnotationSealError(
                f"{location} lacks submitted v5 derivation evidence"
            )

        stages = by_sample.setdefault(private_sample_id, {})
        if str(stage) in stages:
            raise SourceAnnotationSealError(
                f"{private_sample_id} repeats its {stage} review"
            )
        stages[str(stage)] = row

    for private_sample_id, stages in by_sample.items():
        if (
            "primary" in stages
            and "secondary" in stages
            and stages["primary"]["reviewer"] == stages["secondary"]["reviewer"]
        ):
            raise SourceAnnotationSealError(
                f"{private_sample_id}: primary and secondary reviewers are not independent"
            )
    return by_sample


def _workspace_review_projection(
    workspace: Path,
    *,
    private_bindings: Path,
    source_tasks: Path,
    review_ledger: Path,
) -> dict[str, dict[str, Mapping[str, Any]]]:
    root = workspace.resolve()
    expected_paths = {
        "private bindings": root / "private-bindings.jsonl",
        "primary source tasks": root / "blind-tasks-primary.jsonl",
        "review ledger": root / "reviews.jsonl",
    }
    actual_paths = {
        "private bindings": private_bindings,
        "primary source tasks": source_tasks,
        "review ledger": review_ledger,
    }
    for label, expected in expected_paths.items():
        if actual_paths[label].resolve() != expected.resolve():
            raise SourceAnnotationSealError(
                f"--workspace {label} must be {expected}"
            )
    try:
        state = catalog_ledger._load_workspace(root)
        if state["contract"].get("mode") != "production":
            raise SourceAnnotationSealError(
                "adjudication A sealing requires a production workspace"
            )
        if state["contract"].get("v5_derivation_required") is not True:
            raise SourceAnnotationSealError(
                "adjudication A sealing requires a v5 workspace"
            )
        by_sample, _ = catalog_ledger._validate_review_records(state)
    except catalog_ledger.DeltaLedgerError as error:
        raise SourceAnnotationSealError(str(error)) from error
    if any("adjudication" in stages for stages in by_sample.values()):
        raise SourceAnnotationSealError(
            "review ledger already contains an adjudication decision"
        )
    return {
        sample_id: {
            stage: copy.deepcopy(record)
            for stage, record in stages.items()
            if stage in {"primary", "secondary"}
        }
        for sample_id, stages in by_sample.items()
    }


def _adjudication_task(task: Mapping[str, Any], location: str) -> dict[str, Any]:
    try:
        rebound = catalog_ledger._v5_task_for_stage(task, "adjudication")
        return derive.validate_source_task(rebound, location)
    except (catalog_ledger.DeltaLedgerError, derive.DerivationError) as error:
        raise SourceAnnotationSealError(str(error)) from error


def _build_adjudication_annotations(
    *,
    neutral_annotations: Path,
    private_bindings: Path,
    source_tasks: Path,
    review_ledger: Path,
    reviewer: str,
    batch_id: str,
    workspace: Path | None,
) -> tuple[list[dict[str, Any]], str]:
    reviewer_id = _require_id(reviewer, "--reviewer")
    normalized_batch_id = _require_id(batch_id, "--batch-id")

    raw_bindings = _read_jsonl(private_bindings, "private_bindings")
    primary_bindings = _private_binding_projection(raw_bindings, stage="primary")
    secondary_bindings = _private_binding_projection(
        raw_bindings, stage="secondary", allow_empty=True
    )
    primary_by_sample: dict[str, dict[str, Any]] = {}
    for binding in primary_bindings.values():
        sample_id = str(binding["private_sample_id"])
        if sample_id in primary_by_sample:
            raise SourceAnnotationSealError(
                f"private bindings repeat primary sample {sample_id}"
            )
        primary_by_sample[sample_id] = binding
    secondary_by_sample: dict[str, dict[str, Any]] = {}
    for binding in secondary_bindings.values():
        sample_id = str(binding["private_sample_id"])
        if sample_id in secondary_by_sample:
            raise SourceAnnotationSealError(
                f"private bindings repeat secondary sample {sample_id}"
            )
        secondary_by_sample[sample_id] = binding

    raw_primary_tasks = _read_jsonl(source_tasks, "source_tasks")
    primary_tasks, primary_tasks_by_assignment = _validated_source_tasks(
        raw_primary_tasks, stage="primary"
    )
    raw_primary_task_by_assignment = {
        str(task["assignment_id"]): task for task in raw_primary_tasks
    }
    primary_public_assignments = {
        str(binding["public_assignment_id"]) for binding in primary_bindings.values()
    }
    if set(primary_tasks_by_assignment) != primary_public_assignments:
        raise _coverage_error(
            "private primary binding/source task",
            primary_public_assignments,
            set(primary_tasks_by_assignment),
        )

    if workspace is None:
        reviews_by_sample = _explicit_review_projection(
            _read_jsonl(review_ledger, "reviews"),
            primary_bindings=primary_bindings,
            secondary_bindings=secondary_bindings,
        )
    else:
        reviews_by_sample = _workspace_review_projection(
            workspace,
            private_bindings=private_bindings,
            source_tasks=source_tasks,
            review_ledger=review_ledger,
        )

    triggered_by_private_assignment: dict[str, dict[str, Any]] = {}
    incomplete_prior_samples: list[str] = []
    for private_sample_id, primary_binding in sorted(primary_by_sample.items()):
        sample_reviews = reviews_by_sample.get(private_sample_id, {})
        if "primary" not in sample_reviews:
            incomplete_prior_samples.append(private_sample_id)
            continue
        secondary_required = private_sample_id in secondary_by_sample
        if secondary_required and "secondary" not in sample_reviews:
            incomplete_prior_samples.append(private_sample_id)
            continue
        if catalog_ledger._has_eligibility_exception(sample_reviews):
            continue
        try:
            reasons = catalog_ledger._trigger_reasons(
                sample_reviews, secondary_required=secondary_required
            )
        except catalog_ledger.DeltaLedgerError as error:
            raise SourceAnnotationSealError(str(error)) from error
        if not reasons:
            continue
        prior_reviewers = {
            str(sample_reviews[stage]["reviewer"])
            for stage in ("primary", "secondary")
            if stage in sample_reviews
        }
        if reviewer_id in prior_reviewers:
            raise SourceAnnotationSealError(
                f"{private_sample_id}: adjudicator must be independent of source reviewers"
            )
        private_assignment_id = str(primary_binding["private_assignment_id"])
        triggered_by_private_assignment[private_assignment_id] = {
            "binding": primary_binding,
            "reviews": sample_reviews,
            "trigger_reasons": reasons,
        }
    if incomplete_prior_samples:
        raise SourceAnnotationSealError(
            "whole adjudication A batch waits for every required primary/secondary "
            f"review: {sorted(incomplete_prior_samples)[:5]}"
        )
    if not triggered_by_private_assignment:
        raise SourceAnnotationSealError(
            "review ledger contains no adjudication-triggered eligible samples"
        )

    neutral_by_private = _validated_neutral_annotations(
        _read_jsonl(neutral_annotations, "neutral_annotations"),
        stage="adjudication",
    )
    triggered_private_assignments = set(triggered_by_private_assignment)
    if set(neutral_by_private) != triggered_private_assignments:
        raise _coverage_error(
            "neutral annotation/triggered adjudication",
            triggered_private_assignments,
            set(neutral_by_private),
        )

    adjudication_tasks_by_assignment: dict[str, dict[str, Any]] = {}
    primary_binding_by_public_assignment = {
        str(binding["public_assignment_id"]): binding
        for binding in primary_bindings.values()
    }
    for task in primary_tasks:
        public_assignment_id = str(task["assignment_id"])
        binding = primary_binding_by_public_assignment[public_assignment_id]
        if str(binding["private_assignment_id"]) not in triggered_private_assignments:
            continue
        adjudication_tasks_by_assignment[public_assignment_id] = _adjudication_task(
            raw_primary_task_by_assignment[public_assignment_id],
            f"adjudication_tasks[{public_assignment_id}]",
        )
    adjudication_tasks = sorted(
        adjudication_tasks_by_assignment.values(),
        key=lambda row: str(row["assignment_id"]),
    )
    if len(adjudication_tasks) != len(triggered_private_assignments):
        raise SourceAnnotationSealError(
            "triggered adjudication tasks do not exactly bind primary public assignments"
        )

    batch_size = len(adjudication_tasks)
    batch_task_set_sha256 = derive.task_batch_sha256(adjudication_tasks)
    sealed_by_public_assignment: dict[str, dict[str, Any]] = {}
    normalized_by_sample: dict[str, dict[str, Any]] = {}
    for private_assignment_id, trigger in triggered_by_private_assignment.items():
        binding = trigger["binding"]
        neutral = neutral_by_private[private_assignment_id]
        if neutral.get("sample_id") != binding["private_sample_id"]:
            raise SourceAnnotationSealError(
                f"neutral {private_assignment_id} belongs to another private sample"
            )
        public_assignment_id = str(binding["public_assignment_id"])
        public_sample_id = str(binding["public_sample_id"])
        task = adjudication_tasks_by_assignment[public_assignment_id]
        if (
            task["sample_id"] != public_sample_id
            or task["stage"] != "adjudication"
            or task["review_order"] != binding["review_order"]
            or task["source_only_card_sha256"]
            != binding["source_only_card_sha256"]
        ):
            raise SourceAnnotationSealError(
                f"primary binding {private_assignment_id} differs from its adjudication task"
            )
        sample_reviews = trigger["reviews"]
        source_review_record_sha256s = [
            _require_sha(
                sample_reviews[stage].get("record_sha256"),
                f"{private_assignment_id}.{stage}.record_sha256",
            )
            for stage in ("primary", "secondary")
            if stage in sample_reviews
        ]
        payload: dict[str, Any] = {
            "schema_version": derive.SOURCE_SCHEMA_VERSION,
            "record_type": derive.SOURCE_RECORD_TYPE,
            "assignment_id": public_assignment_id,
            "sample_id": public_sample_id,
            "stage": "adjudication",
            "reviewer_id": reviewer_id,
            "batch_id": normalized_batch_id,
            "batch_size": batch_size,
            "batch_task_set_sha256": batch_task_set_sha256,
            "source_only_card_sha256": task["source_only_card_sha256"],
            "source_review_record_sha256s": source_review_record_sha256s,
        }
        for key in SAFE_NEUTRAL_EVIDENCE_KEYS:
            payload[key] = copy.deepcopy(neutral[key])
        sealed = derive.seal_record(payload)
        normalized = derive.validate_annotation(
            sealed, f"sealed_annotations[{public_assignment_id}]"
        )
        if normalized["source_review_record_sha256s"] != (
            source_review_record_sha256s
        ):
            raise SourceAnnotationSealError(
                f"sealed adjudication {public_assignment_id} changed source reviews"
            )
        sealed_by_public_assignment[public_assignment_id] = sealed
        normalized_by_sample[public_sample_id] = normalized

    derive._validate_batch_binding(
        adjudication_tasks, normalized_by_sample, reviewer_id=reviewer_id
    )
    ordered = [
        sealed_by_public_assignment[str(task["assignment_id"])]
        for task in adjudication_tasks
    ]
    return ordered, batch_task_set_sha256


def build_sealed_annotations(
    *,
    neutral_annotations: Path,
    private_bindings: Path,
    source_tasks: Path,
    stage: str,
    reviewer: str,
    batch_id: str,
    review_ledger: Path | None = None,
    workspace: Path | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Return a complete, validated, deterministically ordered sealed A batch."""

    if stage == "adjudication":
        if review_ledger is None:
            raise SourceAnnotationSealError(
                "adjudication requires --reviews or --workspace"
            )
        return _build_adjudication_annotations(
            neutral_annotations=neutral_annotations,
            private_bindings=private_bindings,
            source_tasks=source_tasks,
            review_ledger=review_ledger,
            reviewer=reviewer,
            batch_id=batch_id,
            workspace=workspace,
        )
    if review_ledger is not None:
        raise SourceAnnotationSealError("--reviews is valid only for adjudication")

    normalized_stage = _require_stage(stage, "--stage")
    reviewer_id = _require_id(reviewer, "--reviewer")
    normalized_batch_id = _require_id(batch_id, "--batch-id")

    calibration_null_prior_by_sample: dict[str, str] = {}
    if workspace is not None:
        root = workspace.resolve()
        expected_bindings = (root / "private-bindings.jsonl").resolve()
        expected_tasks = (root / f"blind-tasks-{normalized_stage}.jsonl").resolve()
        if private_bindings.resolve() != expected_bindings:
            raise SourceAnnotationSealError(
                "--workspace source sealing must use its private-bindings.jsonl"
            )
        if source_tasks.resolve() != expected_tasks:
            raise SourceAnnotationSealError(
                f"--workspace source sealing must use blind-tasks-{normalized_stage}.jsonl"
            )
        state = catalog_ledger._load_workspace(root)
        source = _require_mapping(state.get("source"), "workspace.source")
        supplement = source.get("calibration_only_supplement")
        if supplement is not None:
            supplement_value = _require_mapping(
                supplement, "workspace.source.calibration_only_supplement"
            )
            supplemental_ids = set(
                supplement_value.get("supplemental_sample_ids", [])
            )
            selections = _require_mapping(
                source.get("selection"), "workspace.source.selection"
            )
            for sample_id in supplemental_ids:
                selection = _require_mapping(
                    selections.get(sample_id),
                    f"workspace.source.selection[{sample_id}]",
                )
                if (
                    selection.get("schema_version")
                    != catalog_ledger.CALIBRATION_SUPPLEMENT_SCHEMA_VERSION
                    or selection.get("record_type")
                    != "font_matching_calibration_only_supplement_sample"
                    or catalog_ledger._selection_prior_final_record_sha256(
                        selection,
                        location=f"workspace.source.selection[{sample_id}]",
                    )
                    is not None
                ):
                    raise SourceAnnotationSealError(
                        f"{sample_id}: invalid calibration supplement null-prior contract"
                    )
                calibration_null_prior_by_sample[str(sample_id)] = _require_sha(
                    selection.get("record_sha256"),
                    f"workspace.source.selection[{sample_id}].record_sha256",
                )

    tasks, tasks_by_assignment = _validated_source_tasks(
        _read_jsonl(source_tasks, "source_tasks"), stage=normalized_stage
    )
    bindings_by_private = _private_binding_projection(
        _read_jsonl(private_bindings, "private_bindings"),
        stage=normalized_stage,
        calibration_null_prior_by_sample=calibration_null_prior_by_sample,
    )
    bindings_by_public = {
        str(binding["public_assignment_id"]): binding
        for binding in bindings_by_private.values()
    }
    task_assignment_ids = set(tasks_by_assignment)
    binding_assignment_ids = set(bindings_by_public)
    if task_assignment_ids != binding_assignment_ids:
        raise _coverage_error(
            "private binding/source task",
            task_assignment_ids,
            binding_assignment_ids,
        )

    neutral_by_private = _validated_neutral_annotations(
        _read_jsonl(neutral_annotations, "neutral_annotations"),
        stage=normalized_stage,
    )
    private_assignment_ids = set(bindings_by_private)
    neutral_assignment_ids = set(neutral_by_private)
    if private_assignment_ids != neutral_assignment_ids:
        raise _coverage_error(
            "neutral annotation/private binding",
            private_assignment_ids,
            neutral_assignment_ids,
        )

    batch_size = len(tasks)
    batch_task_set_sha256 = derive.task_batch_sha256(tasks)
    sealed_by_public_assignment: dict[str, dict[str, Any]] = {}
    normalized_by_sample: dict[str, dict[str, Any]] = {}
    for private_assignment_id, binding in bindings_by_private.items():
        neutral = neutral_by_private[private_assignment_id]
        if neutral.get("sample_id") != binding["private_sample_id"]:
            raise SourceAnnotationSealError(
                f"neutral {private_assignment_id} belongs to another private sample"
            )
        public_assignment_id = str(binding["public_assignment_id"])
        public_sample_id = str(binding["public_sample_id"])
        task = tasks_by_assignment[public_assignment_id]
        if (
            task["sample_id"] != public_sample_id
            or task["stage"] != normalized_stage
            or task["review_order"] != binding["review_order"]
            or task["source_only_card_sha256"]
            != binding["source_only_card_sha256"]
        ):
            raise SourceAnnotationSealError(
                f"private binding {private_assignment_id} differs from its source task"
            )

        payload: dict[str, Any] = {
            "schema_version": derive.SOURCE_SCHEMA_VERSION,
            "record_type": derive.SOURCE_RECORD_TYPE,
            "assignment_id": public_assignment_id,
            "sample_id": public_sample_id,
            "stage": normalized_stage,
            "reviewer_id": reviewer_id,
            "batch_id": normalized_batch_id,
            "batch_size": batch_size,
            "batch_task_set_sha256": batch_task_set_sha256,
            # The task is authoritative.  The neutral row's SHA is deliberately
            # validated as syntax only and never copied into the sealed record.
            "source_only_card_sha256": task["source_only_card_sha256"],
        }
        for key in SAFE_NEUTRAL_EVIDENCE_KEYS:
            payload[key] = copy.deepcopy(neutral[key])
        sealed = derive.seal_record(payload)
        normalized = derive.validate_annotation(
            sealed, f"sealed_annotations[{public_assignment_id}]"
        )
        if (
            normalized["assignment_id"] != task["assignment_id"]
            or normalized["sample_id"] != task["sample_id"]
            or normalized["source_only_card_sha256"]
            != task["source_only_card_sha256"]
        ):
            raise SourceAnnotationSealError(
                f"sealed annotation {public_assignment_id} differs from its task"
            )
        if public_assignment_id in sealed_by_public_assignment:
            raise SourceAnnotationSealError(
                f"sealed annotations repeat assignment {public_assignment_id}"
            )
        if public_sample_id in normalized_by_sample:
            raise SourceAnnotationSealError(
                f"sealed annotations repeat sample {public_sample_id}"
            )
        sealed_by_public_assignment[public_assignment_id] = sealed
        normalized_by_sample[public_sample_id] = normalized

    derive._validate_batch_binding(
        tasks, normalized_by_sample, reviewer_id=reviewer_id
    )
    ordered = [
        sealed_by_public_assignment[str(task["assignment_id"])] for task in tasks
    ]
    return ordered, batch_task_set_sha256


def seal_annotation_file(
    *,
    neutral_annotations: Path,
    private_bindings: Path,
    source_tasks: Path,
    stage: str,
    reviewer: str,
    batch_id: str,
    output: Path,
    review_ledger: Path | None = None,
    workspace: Path | None = None,
) -> dict[str, Any]:
    rows, batch_task_set_sha256 = build_sealed_annotations(
        neutral_annotations=neutral_annotations,
        private_bindings=private_bindings,
        source_tasks=source_tasks,
        stage=stage,
        reviewer=reviewer,
        batch_id=batch_id,
        review_ledger=review_ledger,
        workspace=workspace,
    )
    payload = derive.jsonl_bytes(rows)
    derive._write_once(output, payload)
    return {
        "status": "sealed",
        "stage": stage,
        "reviewer_id": reviewer,
        "batch_id": batch_id,
        "records": len(rows),
        "batch_task_set_sha256": batch_task_set_sha256,
        "output_sha256": derive.sha256_bytes(payload),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--neutral-annotations", type=Path, required=True)
    parser.add_argument("--private-bindings", type=Path)
    parser.add_argument("--source-tasks", type=Path)
    parser.add_argument("--reviews", type=Path)
    parser.add_argument(
        "--workspace",
        type=Path,
        help=(
            "v5 workspace; resolves stage bindings/tasks and validates calibration "
            "supplement null-prior source-record hashes; adjudication also resolves reviews"
        ),
    )
    parser.add_argument(
        "--stage", choices=("primary", "secondary", "adjudication"), required=True
    )
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    private_bindings = args.private_bindings
    source_tasks = args.source_tasks
    review_ledger = args.reviews
    workspace = args.workspace
    if workspace is not None:
        if any(value is not None for value in (private_bindings, source_tasks, review_ledger)):
            parser.error(
                "--workspace cannot be combined with explicit "
                "--private-bindings/--source-tasks/--reviews"
            )
        private_bindings = workspace / "private-bindings.jsonl"
        source_tasks = workspace / (
            "blind-tasks-primary.jsonl"
            if args.stage == "adjudication"
            else f"blind-tasks-{args.stage}.jsonl"
        )
        review_ledger = workspace / "reviews.jsonl" if args.stage == "adjudication" else None
    elif args.stage == "adjudication":
        if any(value is None for value in (private_bindings, source_tasks, review_ledger)):
            parser.error(
                "adjudication requires either --workspace or all of "
                "--private-bindings, --source-tasks, and --reviews"
            )
    else:
        if review_ledger is not None:
            parser.error("--reviews is valid only for adjudication")
        if private_bindings is None or source_tasks is None:
            parser.error("primary/secondary require --private-bindings and --source-tasks")
    assert private_bindings is not None and source_tasks is not None
    try:
        summary = seal_annotation_file(
            neutral_annotations=args.neutral_annotations,
            private_bindings=private_bindings,
            source_tasks=source_tasks,
            stage=args.stage,
            reviewer=args.reviewer,
            batch_id=args.batch_id,
            output=args.output,
            review_ledger=review_ledger,
            workspace=workspace,
        )
    except (
        SourceAnnotationSealError,
        derive.DerivationError,
        catalog_ledger.DeltaLedgerError,
        OSError,
    ) as error:
        parser.error(str(error))
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
