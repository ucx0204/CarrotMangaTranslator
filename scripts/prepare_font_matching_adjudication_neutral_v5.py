#!/usr/bin/env python3
"""Filter reviewed neutral rows to the exact production v5 adjudication set.

The human visual-review files may deliberately cover more samples than the
ledger ultimately sends to adjudication.  This helper validates those files as
candidate-free source evidence, rejoins their private primary assignment IDs to
the sealed production workspace, and recomputes the trigger set with the
ledger's own frozen functions.

Both output artifacts are write-once.  Validation, identity, duplicate, and
coverage failures publish neither artifact; the error contains the complete
missing-trigger diagnostic instead.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import derive_font_matching_delta_decisions as derive
    from scripts import font_matching_catalog_delta_ledger as catalog_ledger
    from scripts import seal_font_matching_source_annotations_v5 as source_seal
except (ImportError, ModuleNotFoundError):  # direct ``python scripts/...``
    import derive_font_matching_delta_decisions as derive
    import font_matching_catalog_delta_ledger as catalog_ledger
    import seal_font_matching_source_annotations_v5 as source_seal


REPORT_SCHEMA_VERSION = "font-matching-adjudication-neutral-preparation-v5"
REPORT_RECORD_TYPE = "font_matching_adjudication_neutral_preparation_report"
ORDER_CONTRACT = "primary_review_order_then_private_assignment_id"


class AdjudicationNeutralPreparationError(ValueError):
    """Raised when no exact, identity-safe adjudication input can be emitted."""


def _require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AdjudicationNeutralPreparationError(f"{location} must be an object")
    return value


def _read_neutral_inputs(
    paths: Sequence[Path],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if not paths:
        raise AdjudicationNeutralPreparationError(
            "at least one --neutral-annotations file is required"
        )
    resolved_paths: set[Path] = set()
    by_assignment: dict[str, dict[str, Any]] = {}
    by_sample: dict[str, str] = {}
    descriptors: list[dict[str, Any]] = []
    for file_index, path_value in enumerate(paths, 1):
        path = path_value.resolve()
        if path in resolved_paths:
            raise AdjudicationNeutralPreparationError(
                f"neutral input path is repeated: {path}"
            )
        resolved_paths.add(path)
        rows = source_seal._read_jsonl(path, f"neutral_annotations[{file_index}]")
        normalized = source_seal._validated_neutral_annotations(
            rows, stage="adjudication"
        )
        descriptors.append(
            {
                "records": len(rows),
                "sha256": catalog_ledger.sha256_file(path),
            }
        )
        for assignment_id, row in normalized.items():
            sample_id = str(row["sample_id"])
            if assignment_id in by_assignment:
                raise AdjudicationNeutralPreparationError(
                    f"neutral inputs repeat private assignment {assignment_id}"
                )
            if sample_id in by_sample:
                raise AdjudicationNeutralPreparationError(
                    "neutral inputs repeat private sample "
                    f"{sample_id} under {by_sample[sample_id]} and {assignment_id}"
                )
            by_assignment[assignment_id] = copy.deepcopy(row)
            by_sample[sample_id] = assignment_id
    descriptors.sort(key=lambda row: (str(row["sha256"]), int(row["records"])))
    return by_assignment, descriptors


def _binding_identity(
    binding_value: Mapping[str, Any], *, location: str
) -> dict[str, Any]:
    binding = _require_mapping(binding_value, location)
    assignment = _require_mapping(binding.get("assignment"), f"{location}.assignment")
    card = _require_mapping(binding.get("card"), f"{location}.card")
    public_ids = _require_mapping(
        card.get("v5_public_ids"), f"{location}.card.v5_public_ids"
    )
    source_card = _require_mapping(
        card.get("v5_source_card"), f"{location}.card.v5_source_card"
    )
    try:
        review_order = int(assignment["review_order"])
        assignment_id = str(assignment["assignment_id"])
        sample_id = str(assignment["sample_id"])
        stage = str(assignment["stage"])
        public_assignment_id = str(public_ids["assignment_id"])
        public_sample_id = str(public_ids["sample_id"])
        source_sha = str(source_card["sha256"])
    except (KeyError, TypeError, ValueError) as error:
        raise AdjudicationNeutralPreparationError(
            f"{location} lacks a complete v5 identity binding"
        ) from error
    if review_order <= 0 or stage != "primary":
        raise AdjudicationNeutralPreparationError(
            f"{location} is not a valid primary identity binding"
        )
    return {
        "assignment_id": assignment_id,
        "sample_id": sample_id,
        "review_order": review_order,
        "public_assignment_id": public_assignment_id,
        "public_sample_id": public_sample_id,
        "source_only_card_sha256": source_sha,
    }


def _diagnostic_entry(
    identity: Mapping[str, Any],
    *,
    secondary_required: bool,
    trigger_reasons: Sequence[str] = (),
    eligibility_values: Sequence[str] = (),
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "private_assignment_id": str(identity["assignment_id"]),
        "private_sample_id": str(identity["sample_id"]),
        "secondary_required": secondary_required,
    }
    if trigger_reasons:
        row["trigger_reasons"] = list(trigger_reasons)
    if eligibility_values:
        row["eligibility_values"] = list(eligibility_values)
    return row


def _coverage_failure(missing: Sequence[Mapping[str, Any]]) -> None:
    diagnostic = {
        "error": "triggered_coverage_incomplete",
        "triggered_missing_count": len(missing),
        "triggered_missing_from_inputs": list(missing),
    }
    raise AdjudicationNeutralPreparationError(
        json.dumps(diagnostic, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


def build_prepared_artifacts(
    *,
    workspace: Path,
    neutral_annotations: Sequence[Path],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return the canonical neutral rows and their sealed audit report."""

    root = workspace.resolve()
    try:
        state = catalog_ledger._load_workspace(root)
    except catalog_ledger.DeltaLedgerError as error:
        raise AdjudicationNeutralPreparationError(str(error)) from error
    contract = _require_mapping(state.get("contract"), "workspace.contract")
    if contract.get("mode") != "production":
        raise AdjudicationNeutralPreparationError(
            "adjudication preparation requires a production workspace"
        )
    if contract.get("v5_derivation_required") is not True:
        raise AdjudicationNeutralPreparationError(
            "adjudication preparation requires a v5 workspace"
        )
    try:
        reviews_by_sample, _ = catalog_ledger._validate_review_records(state)
    except catalog_ledger.DeltaLedgerError as error:
        raise AdjudicationNeutralPreparationError(str(error)) from error
    if any("adjudication" in stages for stages in reviews_by_sample.values()):
        raise AdjudicationNeutralPreparationError(
            "workspace already contains an adjudication review"
        )

    bindings_by_sample = _require_mapping(
        state.get("bindings_by_sample"), "workspace.bindings_by_sample"
    )
    identities_by_assignment: dict[str, dict[str, Any]] = {}
    classification_by_assignment: dict[str, dict[str, Any]] = {}
    incomplete: list[dict[str, Any]] = []
    triggered: dict[str, dict[str, Any]] = {}
    eligibility_exceptions: dict[str, dict[str, Any]] = {}
    untriggered: dict[str, dict[str, Any]] = {}
    primary_only_count = 0

    for sample_id in sorted(str(value) for value in bindings_by_sample):
        stage_bindings = _require_mapping(
            bindings_by_sample[sample_id], f"bindings_by_sample[{sample_id}]"
        )
        primary_binding = stage_bindings.get("primary")
        if not isinstance(primary_binding, Mapping):
            raise AdjudicationNeutralPreparationError(
                f"{sample_id}: workspace has no primary binding"
            )
        identity = _binding_identity(
            primary_binding, location=f"bindings_by_sample[{sample_id}].primary"
        )
        if identity["sample_id"] != sample_id:
            raise AdjudicationNeutralPreparationError(
                f"{sample_id}: private primary binding changed its sample identity"
            )
        assignment_id = str(identity["assignment_id"])
        if assignment_id in identities_by_assignment:
            raise AdjudicationNeutralPreparationError(
                f"workspace repeats private primary assignment {assignment_id}"
            )
        identities_by_assignment[assignment_id] = identity
        secondary_required = "secondary" in stage_bindings
        if not secondary_required:
            primary_only_count += 1
        stages = reviews_by_sample.get(sample_id, {})
        if "primary" not in stages:
            incomplete.append(
                {
                    **_diagnostic_entry(
                        identity, secondary_required=secondary_required
                    ),
                    "missing_stages": ["primary"],
                }
            )
            continue

        exception = catalog_ledger._has_eligibility_exception(stages)
        if exception:
            eligibility_values = sorted(
                {
                    str(row["eligibility"])
                    for stage, row in stages.items()
                    if stage in {"primary", "secondary"}
                    and row.get("eligibility") != "font_signal_present"
                }
            )
            entry = _diagnostic_entry(
                identity,
                secondary_required=secondary_required,
                eligibility_values=eligibility_values,
            )
            eligibility_exceptions[assignment_id] = entry
            classification_by_assignment[assignment_id] = {
                "category": "eligibility_exception",
                "entry": entry,
            }
            # This mirrors validate_workspace: once an eligibility exception is
            # known, an absent secondary decision is not an adjudication blocker.
            continue
        if secondary_required and "secondary" not in stages:
            incomplete.append(
                {
                    **_diagnostic_entry(identity, secondary_required=True),
                    "missing_stages": ["secondary"],
                }
            )
            continue
        reasons = catalog_ledger._trigger_reasons(
            stages, secondary_required=secondary_required
        )
        entry = _diagnostic_entry(
            identity,
            secondary_required=secondary_required,
            trigger_reasons=reasons,
        )
        if reasons:
            triggered[assignment_id] = entry
            classification_by_assignment[assignment_id] = {
                "category": "triggered",
                "entry": entry,
            }
        else:
            untriggered[assignment_id] = entry
            classification_by_assignment[assignment_id] = {
                "category": "untriggered",
                "entry": entry,
            }

    if incomplete:
        diagnostic = {
            "error": "source_reviews_incomplete",
            "incomplete_count": len(incomplete),
            "incomplete_samples": sorted(
                incomplete,
                key=lambda row: (
                    str(row["private_sample_id"]),
                    str(row["private_assignment_id"]),
                ),
            ),
        }
        raise AdjudicationNeutralPreparationError(
            json.dumps(
                diagnostic,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    if not triggered:
        raise AdjudicationNeutralPreparationError(
            "workspace contains no eligible adjudication trigger"
        )

    neutral_by_assignment, input_descriptors = _read_neutral_inputs(
        neutral_annotations
    )
    accepted: dict[str, dict[str, Any]] = {}
    extra_exception: list[dict[str, Any]] = []
    extra_untriggered: list[dict[str, Any]] = []
    for assignment_id, row in neutral_by_assignment.items():
        identity = identities_by_assignment.get(assignment_id)
        if identity is None:
            raise AdjudicationNeutralPreparationError(
                "supplied neutral row cannot be safely categorized: unknown private "
                f"primary assignment {assignment_id}"
            )
        if row.get("sample_id") != identity["sample_id"]:
            raise AdjudicationNeutralPreparationError(
                f"{assignment_id}: neutral row changed its private sample identity"
            )
        if (
            row.get("source_only_card_sha256")
            != identity["source_only_card_sha256"]
        ):
            raise AdjudicationNeutralPreparationError(
                f"{assignment_id}: neutral row changed its source-only card identity"
            )
        classification = classification_by_assignment.get(assignment_id)
        if classification is None:
            raise AdjudicationNeutralPreparationError(
                f"{assignment_id}: supplied neutral row cannot be safely categorized"
            )
        category = classification["category"]
        if category == "triggered":
            accepted[assignment_id] = row
        elif category == "eligibility_exception":
            extra_exception.append(copy.deepcopy(classification["entry"]))
        elif category == "untriggered":
            extra_untriggered.append(copy.deepcopy(classification["entry"]))
        else:  # defensive: categories are a sealed, closed set above
            raise AdjudicationNeutralPreparationError(
                f"{assignment_id}: supplied extra has an unknown category"
            )

    missing = [
        triggered[assignment_id]
        for assignment_id in sorted(
            set(triggered) - set(accepted),
            key=lambda value: (
                int(identities_by_assignment[value]["review_order"]), value
            ),
        )
    ]
    if missing:
        _coverage_failure(missing)

    ordered_assignments = sorted(
        accepted,
        key=lambda value: (int(identities_by_assignment[value]["review_order"]), value),
    )
    output_rows: list[dict[str, Any]] = []
    for visual_index, assignment_id in enumerate(ordered_assignments, 1):
        row = copy.deepcopy(accepted[assignment_id])
        row["visual_review_index"] = visual_index
        output_rows.append(row)
    output_payload = derive.jsonl_bytes(output_rows)

    def _sort_diagnostic(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(
            rows,
            key=lambda row: (
                int(
                    identities_by_assignment[str(row["private_assignment_id"])][
                        "review_order"
                    ]
                ),
                str(row["private_assignment_id"]),
            ),
        )

    report = catalog_ledger.seal(
        {
            "schema_version": REPORT_SCHEMA_VERSION,
            "record_type": REPORT_RECORD_TYPE,
            "workspace_contract_record_sha256": contract.get("record_sha256"),
            "private_bindings_sha256": catalog_ledger.sha256_file(
                root / "private-bindings.jsonl"
            ),
            "review_ledger_sha256": catalog_ledger.sha256_file(
                root / "reviews.jsonl"
            ),
            "trigger_contract": {
                "eligibility_exception_function": "_has_eligibility_exception",
                "trigger_function": "_trigger_reasons",
                "secondary_required_from_workspace_binding": True,
                "eligibility_exception_precedes_secondary_completeness": True,
            },
            "input_artifacts": input_descriptors,
            "counts": {
                "workspace_samples": len(bindings_by_sample),
                "workspace_primary_only_samples": primary_only_count,
                "workspace_secondary_required_samples": (
                    len(bindings_by_sample) - primary_only_count
                ),
                "eligible_triggered_samples": len(triggered),
                "supplied_neutral_rows": len(neutral_by_assignment),
                "output_triggered_rows": len(output_rows),
                "supplied_extra_rows": len(extra_exception) + len(extra_untriggered),
                "eligibility_exception_extras": len(extra_exception),
                "untriggered_extras": len(extra_untriggered),
                "triggered_missing_from_inputs": 0,
            },
            "supplied_extras": {
                "eligibility_exception": _sort_diagnostic(extra_exception),
                "untriggered": _sort_diagnostic(extra_untriggered),
            },
            "triggered_missing_from_inputs": [],
            "output": {
                "records": len(output_rows),
                "sha256": derive.sha256_bytes(output_payload),
                "order": ORDER_CONTRACT,
                "visual_review_index": "canonical_contiguous_1_based",
            },
            "complete": True,
        }
    )
    return output_rows, report


def prepare_files(
    *,
    workspace: Path,
    neutral_annotations: Sequence[Path],
    output: Path,
    report: Path,
) -> dict[str, Any]:
    """Validate fully, then publish the canonical JSONL and sealed report."""

    if output.resolve() == report.resolve():
        raise AdjudicationNeutralPreparationError(
            "--output and --report must be different paths"
        )
    if output.exists() or report.exists():
        existing = [str(path) for path in (output, report) if path.exists()]
        raise AdjudicationNeutralPreparationError(
            f"refusing to overwrite existing output: {existing}"
        )
    rows, sealed_report = build_prepared_artifacts(
        workspace=workspace, neutral_annotations=neutral_annotations
    )
    output_payload = derive.jsonl_bytes(rows)
    report_payload = catalog_ledger.canonical_json_bytes(sealed_report, pretty=True)
    created_output = False
    try:
        derive._write_once(output, output_payload)
        created_output = True
        derive._write_once(report, report_payload)
    except BaseException:
        if created_output:
            output.unlink(missing_ok=True)
        raise
    return {
        "status": "prepared",
        "records": len(rows),
        "output_sha256": derive.sha256_bytes(output_payload),
        "report_record_sha256": sealed_report["record_sha256"],
        "report_sha256": derive.sha256_bytes(report_payload),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument(
        "--neutral-annotations",
        type=Path,
        action="append",
        required=True,
        help="repeat for each independently reviewed neutral JSONL",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = prepare_files(
            workspace=args.workspace,
            neutral_annotations=args.neutral_annotations,
            output=args.output,
            report=args.report,
        )
    except (
        AdjudicationNeutralPreparationError,
        source_seal.SourceAnnotationSealError,
        derive.DerivationError,
        catalog_ledger.DeltaLedgerError,
        OSError,
    ) as error:
        parser.error(str(error))
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
