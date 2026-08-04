#!/usr/bin/env python3
"""Build a sealed direct-visual queue for uncovered v5 adjudication triggers.

The production workspace is fully validated exactly once.  Existing human
neutral rows are then matched to private primary assignments, while the frozen
ledger trigger policy identifies eligible triggered samples that remain
uncovered.  Queue consumers receive the actual released primary full card and
candidate-free source evidence, but no aliases, candidate identities, tiers, or
earlier answers.
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
    from scripts import prepare_font_matching_adjudication_neutral_v5 as prepare
    from scripts import seal_font_matching_source_annotations_v5 as source_seal
except (ImportError, ModuleNotFoundError):  # direct ``python scripts/...``
    import derive_font_matching_delta_decisions as derive
    import font_matching_catalog_delta_ledger as catalog_ledger
    import prepare_font_matching_adjudication_neutral_v5 as prepare
    import seal_font_matching_source_annotations_v5 as source_seal


QUEUE_SCHEMA_VERSION = "font-matching-adjudication-direct-visual-queue-v5"
QUEUE_RECORD_TYPE = "font_matching_adjudication_direct_visual_queue_item"
REPORT_RECORD_TYPE = "font_matching_adjudication_direct_visual_queue_report"
ORDER_CONTRACT = "canonical_primary_review_order_then_private_assignment_id"


class DirectVisualQueueError(ValueError):
    """Raised when an identity-safe exact missing-trigger queue cannot be built."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise DirectVisualQueueError(f"{location} must be an object")
    return value


def _primary_identity(
    stage_bindings: Mapping[str, Any], *, sample_id: str
) -> dict[str, Any]:
    primary = _mapping(stage_bindings.get("primary"), f"{sample_id}.primary")
    identity = prepare._binding_identity(primary, location=f"{sample_id}.primary")
    if identity["sample_id"] != sample_id:
        raise DirectVisualQueueError(
            f"{sample_id}: primary binding changed its private sample identity"
        )
    return identity


def _classification(
    state: Mapping[str, Any],
    reviews_by_sample: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> tuple[
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
]:
    bindings_by_sample = _mapping(
        state.get("bindings_by_sample"), "workspace.bindings_by_sample"
    )
    identities: dict[str, dict[str, Any]] = {}
    triggered: dict[str, dict[str, Any]] = {}
    exceptions: dict[str, dict[str, Any]] = {}
    untriggered: dict[str, dict[str, Any]] = {}
    incomplete: list[dict[str, Any]] = []
    for sample_id in sorted(str(value) for value in bindings_by_sample):
        stage_bindings = _mapping(
            bindings_by_sample[sample_id], f"bindings_by_sample[{sample_id}]"
        )
        identity = _primary_identity(stage_bindings, sample_id=sample_id)
        assignment_id = str(identity["assignment_id"])
        if assignment_id in identities:
            raise DirectVisualQueueError(
                f"workspace repeats private primary assignment {assignment_id}"
            )
        identities[assignment_id] = identity
        secondary_required = "secondary" in stage_bindings
        stages = reviews_by_sample.get(sample_id, {})
        if "primary" not in stages:
            incomplete.append(
                {
                    "private_assignment_id": assignment_id,
                    "private_sample_id": sample_id,
                    "missing_stages": ["primary"],
                }
            )
            continue
        if catalog_ledger._has_eligibility_exception(stages):
            eligibility_values = sorted(
                {
                    str(row["eligibility"])
                    for stage, row in stages.items()
                    if stage in {"primary", "secondary"}
                    and row.get("eligibility") != "font_signal_present"
                }
            )
            exceptions[assignment_id] = {
                "private_assignment_id": assignment_id,
                "private_sample_id": sample_id,
                "secondary_required": secondary_required,
                "eligibility_values": eligibility_values,
            }
            # Match the production ledger: a known eligibility exception is
            # excluded before a missing secondary decision becomes relevant.
            continue
        if secondary_required and "secondary" not in stages:
            incomplete.append(
                {
                    "private_assignment_id": assignment_id,
                    "private_sample_id": sample_id,
                    "missing_stages": ["secondary"],
                }
            )
            continue
        reasons = catalog_ledger._trigger_reasons(
            stages, secondary_required=secondary_required
        )
        entry = {
            "private_assignment_id": assignment_id,
            "private_sample_id": sample_id,
            "secondary_required": secondary_required,
            "trigger_reasons": list(reasons),
        }
        if reasons:
            triggered[assignment_id] = entry
        else:
            entry.pop("trigger_reasons")
            untriggered[assignment_id] = entry
    if incomplete:
        raise DirectVisualQueueError(
            json.dumps(
                {
                    "error": "source_reviews_incomplete",
                    "incomplete_samples": incomplete,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    return identities, triggered, exceptions, untriggered


def _validate_existing_neutral(
    paths: Sequence[Path],
    *,
    identities: Mapping[str, Mapping[str, Any]],
    triggered: Mapping[str, Mapping[str, Any]],
    exceptions: Mapping[str, Mapping[str, Any]],
    untriggered: Mapping[str, Mapping[str, Any]],
) -> tuple[
    dict[str, dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    neutral, descriptors = prepare._read_neutral_inputs(paths)
    covered: dict[str, dict[str, Any]] = {}
    supplied_exceptions: list[dict[str, Any]] = []
    supplied_untriggered: list[dict[str, Any]] = []
    for assignment_id, row in neutral.items():
        identity = identities.get(assignment_id)
        if identity is None:
            raise DirectVisualQueueError(
                f"existing neutral uses unknown primary assignment {assignment_id}"
            )
        if (
            row.get("sample_id") != identity["sample_id"]
            or row.get("source_only_card_sha256")
            != identity["source_only_card_sha256"]
        ):
            raise DirectVisualQueueError(
                f"{assignment_id}: existing neutral changed its sealed source identity"
            )
        if assignment_id in triggered:
            covered[assignment_id] = row
        elif assignment_id in exceptions:
            supplied_exceptions.append(copy.deepcopy(exceptions[assignment_id]))
        elif assignment_id in untriggered:
            supplied_untriggered.append(copy.deepcopy(untriggered[assignment_id]))
        else:
            raise DirectVisualQueueError(
                f"{assignment_id}: existing neutral cannot be safely classified"
            )
    return covered, descriptors, supplied_exceptions, supplied_untriggered


def _primary_release_surface(
    state: Mapping[str, Any],
) -> tuple[Mapping[str, Any], Mapping[str, Any], dict[str, Mapping[str, Any]]]:
    releases = [
        _mapping(value, f"candidate_releases[{index}]")
        for index, value in enumerate(state.get("candidate_releases", []))
        if isinstance(value, Mapping) and value.get("stage") == "primary"
    ]
    if len(releases) != 1:
        raise DirectVisualQueueError(
            f"workspace must contain exactly one primary release, found {len(releases)}"
        )
    release = releases[0]
    release_id = str(release["release_id"])
    manifest_path = (
        Path(str(state["root"]))
        / "candidate-surfaces"
        / release_id
        / "manifest.json"
    ).resolve()
    manifest = catalog_ledger.read_json(manifest_path)
    catalog_ledger.validate_seal(manifest, "primary candidate surface manifest")
    if (
        manifest.get("candidate_release_id") != release_id
        or manifest.get("candidate_release_record_sha256")
        != release.get("record_sha256")
    ):
        raise DirectVisualQueueError(
            "primary surface manifest changed its release binding"
        )
    rows = manifest.get("entries")
    if not isinstance(rows, list) or manifest.get("batch_size") != len(rows):
        raise DirectVisualQueueError("primary surface manifest count changed")
    by_assignment: dict[str, Mapping[str, Any]] = {}
    for index, row_value in enumerate(rows):
        row = _mapping(row_value, f"primary_surface.entries[{index}]")
        assignment_id = str(row.get("assignment_id"))
        if assignment_id in by_assignment:
            raise DirectVisualQueueError(
                f"primary surface repeats assignment {assignment_id}"
            )
        by_assignment[assignment_id] = row
    tasks = state.get("v5_candidate_tasks_by_release_id", {}).get(release_id, [])
    if set(by_assignment) != {
        str(_mapping(row, "primary release task")["assignment_id"]) for row in tasks
    }:
        raise DirectVisualQueueError(
            "primary surface descriptors differ from validated release tasks"
        )
    return release, manifest, by_assignment


def _descriptor(
    value: Any,
    *,
    location: str,
    allowed_root: Path,
    expected_sha256: str,
) -> dict[str, Any]:
    descriptor = _mapping(value, location)
    if set(descriptor) != {"file", "sha256", "pixel_sha256", "size_px"}:
        raise DirectVisualQueueError(f"{location} descriptor keys changed")
    path = Path(str(descriptor.get("file"))).resolve()
    try:
        path.relative_to(allowed_root.resolve())
    except ValueError as error:
        raise DirectVisualQueueError(f"{location} escapes its sealed root") from error
    sha256 = str(descriptor.get("sha256"))
    pixel_sha256 = str(descriptor.get("pixel_sha256"))
    size = descriptor.get("size_px")
    if (
        derive.SHA_RE.fullmatch(sha256) is None
        or derive.SHA_RE.fullmatch(pixel_sha256) is None
        or sha256 != expected_sha256
        or not path.is_file()
        or catalog_ledger.sha256_file(path) != sha256
        or not isinstance(size, list)
        or len(size) != 2
        or any(
            isinstance(item, bool) or not isinstance(item, int) or item <= 0
            for item in size
        )
    ):
        raise DirectVisualQueueError(f"{location} bytes or descriptor changed")
    canonical = {
        "file": str(path),
        "sha256": sha256,
        "pixel_sha256": pixel_sha256,
        "size_px": list(size),
    }
    return {
        **canonical,
        "descriptor_sha256": derive.sha256_bytes(
            derive.canonical_json_bytes(canonical)
        ),
    }


def _safe_source_projection(
    state: Mapping[str, Any],
    *,
    binding: Mapping[str, Any],
    stage: str,
) -> dict[str, Any]:
    card = _mapping(binding.get("card"), f"{stage}.binding.card")
    public_ids = _mapping(card.get("v5_public_ids"), f"{stage}.v5_public_ids")
    assignment_id = str(public_ids["assignment_id"])
    sample_id = str(public_ids["sample_id"])
    commit = state.get("v5_commit_by_assignment_stage", {}).get(
        (assignment_id, stage)
    )
    if not isinstance(commit, Mapping):
        raise DirectVisualQueueError(
            f"{assignment_id}: no validated {stage} source commit"
        )
    annotation = _mapping(
        _mapping(commit.get("annotations"), f"{stage}.commit.annotations").get(
            sample_id
        ),
        f"{stage}.annotation[{sample_id}]",
    )
    projection: dict[str, Any] = {
        "stage": stage,
        "source_annotation_record_sha256": str(annotation["record_sha256"]),
        "source_only_card_sha256": str(annotation["source_only_card_sha256"]),
    }
    for key in source_seal.SAFE_NEUTRAL_EVIDENCE_KEYS:
        projection[key] = copy.deepcopy(annotation[key])
    derive._walk_source_only(projection, f"{stage}_source_projection")
    return projection


def _neutral_template(
    *,
    identity: Mapping[str, Any],
    primary_projection: Mapping[str, Any],
    visual_index: int,
) -> dict[str, Any]:
    template: dict[str, Any] = {
        "schema_version": source_seal.NEUTRAL_SCHEMA_VERSION,
        "record_type": source_seal.NEUTRAL_RECORD_TYPE,
        "assignment_id": str(identity["assignment_id"]),
        "sample_id": str(identity["sample_id"]),
        "stage": "adjudication",
        "source_only_card_sha256": str(identity["source_only_card_sha256"]),
        # Zero is an explicit pending-review sentinel.  A direct reviewer must
        # adopt/edit the evidence and replace this with an honest confidence.
        "review_confidence": 0.0,
        "visual_review_index": visual_index,
    }
    for key in source_seal.SAFE_NEUTRAL_EVIDENCE_KEYS:
        template[key] = copy.deepcopy(primary_projection[key])
    source_seal._validated_neutral_annotations([template], stage="adjudication")
    return template


def _sort_entries(
    rows: Sequence[Mapping[str, Any]],
    identities: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    return [
        copy.deepcopy(dict(row))
        for row in sorted(
            rows,
            key=lambda row: (
                int(
                    identities[str(row["private_assignment_id"])]["review_order"]
                ),
                str(row["private_assignment_id"]),
            ),
        )
    ]


def build_queue_artifacts(
    *, workspace: Path, existing_neutral: Sequence[Path]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load the workspace once and return the sealed missing-trigger queue."""

    root = workspace.resolve()
    try:
        # Deliberately the only workspace load in this producer.  It validates
        # source commits, releases, tasks, every descriptor, image pixels, and
        # the append-only review ledger before we project any queue data.
        state = catalog_ledger._load_workspace(root)
        reviews_by_sample, _ = catalog_ledger._validate_review_records(state)
    except catalog_ledger.DeltaLedgerError as error:
        raise DirectVisualQueueError(str(error)) from error
    contract = _mapping(state.get("contract"), "workspace.contract")
    if (
        contract.get("mode") != "production"
        or contract.get("v5_derivation_required") is not True
    ):
        raise DirectVisualQueueError("queue requires a production v5 workspace")
    if any("adjudication" in stages for stages in reviews_by_sample.values()):
        raise DirectVisualQueueError(
            "workspace already contains adjudication reviews"
        )

    identities, triggered, exceptions, untriggered = _classification(
        state, reviews_by_sample
    )
    covered, input_descriptors, supplied_exceptions, supplied_untriggered = (
        _validate_existing_neutral(
            existing_neutral,
            identities=identities,
            triggered=triggered,
            exceptions=exceptions,
            untriggered=untriggered,
        )
    )
    missing_assignments = sorted(
        set(triggered) - set(covered),
        key=lambda value: (int(identities[value]["review_order"]), value),
    )
    if not missing_assignments:
        raise DirectVisualQueueError("existing neutral inputs cover every trigger")

    release, surface_manifest, surfaces = _primary_release_surface(state)
    release_id = str(release["release_id"])
    release_root = root / "candidate-surfaces" / release_id
    source_root = root / "source-cards"
    task_by_assignment = {
        str(row["assignment_id"]): row
        for row in state["v5_candidate_tasks_by_release_id"][release_id]
    }

    queue_rows: list[dict[str, Any]] = []
    for queue_index, private_assignment_id in enumerate(missing_assignments, 1):
        identity = identities[private_assignment_id]
        private_sample_id = str(identity["sample_id"])
        stage_bindings = _mapping(
            state["bindings_by_sample"][private_sample_id],
            f"bindings_by_sample[{private_sample_id}]",
        )
        primary_binding = _mapping(
            stage_bindings["primary"], f"{private_sample_id}.primary"
        )
        primary_card = _mapping(
            primary_binding.get("card"), f"{private_sample_id}.primary.card"
        )
        public_ids = _mapping(
            primary_card.get("v5_public_ids"),
            f"{private_sample_id}.primary.v5_public_ids",
        )
        public_assignment_id = str(public_ids["assignment_id"])
        public_sample_id = str(public_ids["sample_id"])
        surface = surfaces.get(public_assignment_id)
        task = task_by_assignment.get(public_assignment_id)
        if (
            surface is None
            or task is None
            or surface.get("sample_id") != public_sample_id
            or task.get("sample_id") != public_sample_id
        ):
            raise DirectVisualQueueError(
                f"{private_assignment_id}: primary released card binding changed"
            )
        source_card = _descriptor(
            surface.get("source_only"),
            location=f"{private_assignment_id}.source_only",
            allowed_root=source_root,
            expected_sha256=str(task["source_only_card_sha256"]),
        )
        full_card = _descriptor(
            surface.get("full_card"),
            location=f"{private_assignment_id}.full_card",
            allowed_root=release_root,
            expected_sha256=str(task["full_card_sha256"]),
        )
        if (
            source_card["sha256"] != identity["source_only_card_sha256"]
            or Path(source_card["file"]).resolve()
            != Path(str(primary_card["v5_source_card"]["file"])).resolve()
        ):
            raise DirectVisualQueueError(
                f"{private_assignment_id}: source descriptor differs from private binding"
            )
        primary_projection = _safe_source_projection(
            state, binding=primary_binding, stage="primary"
        )
        secondary_projection = (
            _safe_source_projection(
                state,
                binding=_mapping(
                    stage_bindings["secondary"], f"{private_sample_id}.secondary"
                ),
                stage="secondary",
            )
            if "secondary" in stage_bindings
            else None
        )
        template = _neutral_template(
            identity=identity,
            primary_projection=primary_projection,
            visual_index=queue_index,
        )
        payload = {
            "schema_version": QUEUE_SCHEMA_VERSION,
            "record_type": QUEUE_RECORD_TYPE,
            "queue_index": queue_index,
            "private_assignment_id": private_assignment_id,
            "private_sample_id": private_sample_id,
            "primary_review_order": int(identity["review_order"]),
            "secondary_required": bool(triggered[private_assignment_id]["secondary_required"]),
            "trigger_reasons": copy.deepcopy(
                triggered[private_assignment_id]["trigger_reasons"]
            ),
            "inspection_contract": {
                "open_only_field": "actual_primary_full_card.file",
                "actual_released_primary_full_card_required": True,
                "candidate_names_visible": False,
                "earlier_answers_visible": False,
                "source_only_descriptor_is_provenance_only": True,
                "template_pending_direct_visual_adoption": True,
            },
            "source_only_card": source_card,
            "actual_primary_full_card": full_card,
            "source_annotation_safe_projections": {
                "primary": primary_projection,
                "secondary": secondary_projection,
            },
            "adoptable_neutral_template": template,
        }
        derive._walk_source_only(payload, f"queue[{queue_index}]")
        queue_rows.append(catalog_ledger.seal(payload))

    queue_payload = derive.jsonl_bytes(queue_rows)
    excluded_exceptions = _sort_entries(list(exceptions.values()), identities)
    excluded_untriggered = _sort_entries(list(untriggered.values()), identities)
    supplied_exceptions = _sort_entries(supplied_exceptions, identities)
    supplied_untriggered = _sort_entries(supplied_untriggered, identities)
    report = catalog_ledger.seal(
        {
            "schema_version": QUEUE_SCHEMA_VERSION,
            "record_type": REPORT_RECORD_TYPE,
            "workspace_contract_record_sha256": contract.get("record_sha256"),
            "review_ledger_sha256": catalog_ledger.sha256_file(
                root / "reviews.jsonl"
            ),
            "primary_release_record_sha256": release.get("record_sha256"),
            "primary_surface_manifest_record_sha256": surface_manifest.get(
                "record_sha256"
            ),
            "primary_surface_manifest_sha256": catalog_ledger.sha256_file(
                root
                / "candidate-surfaces"
                / release_id
                / "manifest.json"
            ),
            "existing_neutral_inputs": input_descriptors,
            "trigger_contract": {
                "eligibility_exception_function": "_has_eligibility_exception",
                "trigger_function": "_trigger_reasons",
                "workspace_validated_load_count": 1,
                "eligibility_exception_precedes_secondary_completeness": True,
            },
            "inspection_contract": {
                "actual_released_primary_full_card_only": True,
                "candidate_names_emitted": False,
                "blind_aliases_emitted": False,
                "earlier_answers_emitted": False,
                "source_annotations_candidate_free_projection_only": True,
            },
            "counts": {
                "workspace_samples": len(identities),
                "eligible_triggered_samples": len(triggered),
                "existing_triggered_coverage": len(covered),
                "missing_trigger_queue_rows": len(queue_rows),
                "excluded_eligibility_exception_samples": len(exceptions),
                "excluded_untriggered_samples": len(untriggered),
                "supplied_eligibility_exception_extras": len(supplied_exceptions),
                "supplied_untriggered_extras": len(supplied_untriggered),
            },
            "explicitly_excluded_from_queue": {
                "eligibility_exception": excluded_exceptions,
                "untriggered": excluded_untriggered,
            },
            "supplied_neutral_extras": {
                "eligibility_exception": supplied_exceptions,
                "untriggered": supplied_untriggered,
            },
            "queue": {
                "records": len(queue_rows),
                "sha256": derive.sha256_bytes(queue_payload),
                "order": ORDER_CONTRACT,
                "first_primary_review_order": queue_rows[0]["primary_review_order"],
                "last_primary_review_order": queue_rows[-1]["primary_review_order"],
            },
            "complete": True,
        }
    )
    derive._walk_source_only(report, "queue_report")
    return queue_rows, report


def write_queue(
    *,
    workspace: Path,
    existing_neutral: Sequence[Path],
    output: Path,
    report: Path,
) -> dict[str, Any]:
    if output.resolve() == report.resolve():
        raise DirectVisualQueueError("--output and --report must differ")
    if output.exists() or report.exists():
        raise DirectVisualQueueError("refusing to overwrite queue output")
    rows, sealed_report = build_queue_artifacts(
        workspace=workspace, existing_neutral=existing_neutral
    )
    queue_payload = derive.jsonl_bytes(rows)
    report_payload = catalog_ledger.canonical_json_bytes(sealed_report, pretty=True)
    created_output = False
    try:
        derive._write_once(output, queue_payload)
        created_output = True
        derive._write_once(report, report_payload)
    except BaseException:
        if created_output:
            output.unlink(missing_ok=True)
        raise
    return {
        "status": "built",
        "records": len(rows),
        "output_sha256": derive.sha256_bytes(queue_payload),
        "report_record_sha256": sealed_report["record_sha256"],
        "report_sha256": derive.sha256_bytes(report_payload),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument(
        "--existing-neutral", type=Path, action="append", required=True
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = write_queue(
            workspace=args.workspace,
            existing_neutral=args.existing_neutral,
            output=args.output,
            report=args.report,
        )
    except (
        DirectVisualQueueError,
        prepare.AdjudicationNeutralPreparationError,
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
