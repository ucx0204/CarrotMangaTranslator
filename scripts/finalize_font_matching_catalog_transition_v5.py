#!/usr/bin/env python3
"""Finalize a provisional v5 font catalog from formal full-22 utility evidence.

This is deliberately a separate, fail-closed transaction.  The provisional
review workspace remains immutable, while this command binds its sealed
catalog records to a recomputed formal utility audit and emits the exact font
and render inventories that may enter the runtime bundle.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import build_font_matching_runtime_artifact as runtime  # noqa: E402
import evaluate_font_matching_catalog_utility as utility  # noqa: E402
import font_matching_catalog_delta_ledger as ledger  # noqa: E402


SCHEMA_VERSION = "font-matching-catalog-transition-v1"
RECORD_TYPE = "font_matching_catalog_transition_report"
OWNER = "carrot-manga-translator/font-matching-catalog-transition"
MARKER_FILE = ".font-matching-catalog-transition-owned.json"
DISPOSITION_FILE = "catalog-disposition.json"
FINAL_CATALOG_FILE = "final-catalog.json"
DEPLOYMENT_FONT_FILE = "deployment-font-face-manifest.json"
DEPLOYMENT_RENDER_DIR = "deployment-render-bank"
DEPLOYMENT_RENDER_FILE = f"{DEPLOYMENT_RENDER_DIR}/manifest.json"
REPORT_FILE = "report.json"
RESOLUTION_SCHEMA = "font-matching-catalog-transition-resolutions-v1"
RESOLUTION_RECORD_TYPE = "font_matching_catalog_transition_resolutions"
EXPECTED_CANDIDATE_COUNT = 22
EXPECTED_PRIOR_COUNT = 15
EXPECTED_DELTA_COUNT = 7
RETAIN_ACTION = "retained_unique_p1"
SAFE_ZERO_ACTION = "deleted_safe_zero"
REDUNDANT_ACTION = "deleted_redundant"
TERMINAL_ACTIONS = {RETAIN_ACTION, SAFE_ZERO_ACTION, REDUNDANT_ACTION}


class CatalogTransitionError(ValueError):
    """Raised when formal evidence cannot authorize a terminal catalog."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal(core: Mapping[str, Any]) -> dict[str, Any]:
    record = copy.deepcopy(dict(core))
    record.pop("record_sha256", None)
    record["record_sha256"] = sha256_bytes(canonical_json(record).encode("utf-8"))
    return record


def validate_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise CatalogTransitionError(f"{location}: record seal mismatch")
    return actual


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CatalogTransitionError(f"{location}: expected an object")
    return value


def require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise CatalogTransitionError(f"{location}: expected an array")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CatalogTransitionError(f"{location}: expected non-empty text")
    return value


def require_sha(value: Any, location: str) -> str:
    output = require_text(value, location)
    if len(output) != 64 or any(char not in "0123456789abcdef" for char in output):
        raise CatalogTransitionError(f"{location}: expected lowercase SHA-256")
    return output


def require_int(value: Any, location: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise CatalogTransitionError(f"{location}: expected integer >= {minimum}")
    return value


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    resolved = path.resolve()
    if path.is_symlink() or not resolved.is_file():
        raise CatalogTransitionError(f"{location}: file is missing or linked")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogTransitionError(f"{location}: invalid JSON: {error}") from error
    return dict(require_mapping(value, location))


def _candidate_set_sha256(candidate_ids: Sequence[str]) -> str:
    return sha256_bytes(canonical_json(list(candidate_ids)).encode("utf-8"))


def _safe_relative_path(value: str, *, location: str) -> Path:
    path = Path(value)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise CatalogTransitionError(f"{location}: unsafe relative path")
    return path


def _load_provisional_workspace(workspace: Path) -> dict[str, Any]:
    resolved = workspace.resolve()
    validation = ledger.validate_workspace(resolved, require_complete=True)
    if validation.get("complete") is not True:
        raise CatalogTransitionError("provisional v5 workspace is incomplete")
    paths = {
        "disposition": resolved / "catalog-disposition.json",
        "catalog": resolved / "provisional-catalog.json",
        "report": resolved / "provisional-report.json",
    }
    records = {
        name: read_json(path, location=f"provisional {name}")
        for name, path in paths.items()
    }
    for name, record in records.items():
        validate_seal(record, location=f"provisional {name}")
    disposition = records["disposition"]
    catalog = records["catalog"]
    report = records["report"]
    if (
        disposition.get("schema_version")
        != ledger.V5_CATALOG_DISPOSITION_SCHEMA_VERSION
        or disposition.get("record_type") != ledger.V5_CATALOG_DISPOSITION_RECORD_TYPE
        or catalog.get("schema_version") != ledger.V5_PROVISIONAL_CATALOG_SCHEMA_VERSION
        or catalog.get("record_type") != ledger.V5_PROVISIONAL_CATALOG_RECORD_TYPE
        or report.get("record_type") != ledger.V5_PROVISIONAL_REPORT_RECORD_TYPE
    ):
        raise CatalogTransitionError("provisional records use another v5 schema")
    if any(
        record.get("release_state") != "provisional_not_released"
        or record.get("final_release_allowed") is not False
        for record in (disposition, catalog, report)
    ):
        raise CatalogTransitionError("provisional records already claim a release")
    if (
        report.get("catalog_disposition_record_sha256")
        != disposition.get("record_sha256")
        or report.get("provisional_catalog_record_sha256")
        != catalog.get("record_sha256")
        or validation.get("provisional_catalog_record_sha256")
        != catalog.get("record_sha256")
    ):
        raise CatalogTransitionError("provisional workspace catalog binding changed")
    return {
        "validation": validation,
        "disposition": disposition,
        "catalog": catalog,
        "report": report,
    }


def _load_formal_utility(path: Path) -> dict[str, Any]:
    report = read_json(path, location="formal utility audit")
    utility._validate_output_shape(report)
    if (
        report.get("audit_mode") != "formal_utility_evidence"
        or report.get("candidate_count") != EXPECTED_CANDIDATE_COUNT
        or report.get("decision_boundary")
        != {
            "catalog_disposition_emitted": False,
            "deletion_allowed": False,
            "reason": "evidence_requires_separate_catalog_transition",
            "status": "formal_evidence_only",
        }
    ):
        raise CatalogTransitionError("utility audit is not formal evidence-only output")
    authority = require_mapping(report.get("authority"), "utility.authority")
    if (
        authority.get("formal_calibration_gate_passed") is not True
        or authority.get("selection_mode") != utility.FORMAL_SELECTION_MODE
        or authority.get("candidate_count") != EXPECTED_CANDIDATE_COUNT
    ):
        raise CatalogTransitionError("utility authority did not pass the formal gate")
    return report


def _validate_authority_bindings(
    *,
    provisional: Mapping[str, Any],
    utility_report: Mapping[str, Any],
    font_manifest_path: Path,
    render_manifest_path: Path,
) -> None:
    disposition = require_mapping(provisional.get("disposition"), "disposition")
    catalog = require_mapping(provisional.get("catalog"), "provisional catalog")
    authority = require_mapping(utility_report.get("authority"), "utility.authority")
    input_hashes = require_mapping(
        utility_report.get("input_hashes"), "utility.input_hashes"
    )
    font_sha = sha256_file(font_manifest_path)
    render_sha = sha256_file(render_manifest_path)
    if authority.get("catalog_disposition_record_sha256") != disposition.get(
        "record_sha256"
    ) or authority.get("provisional_catalog_record_sha256") != catalog.get(
        "record_sha256"
    ):
        raise CatalogTransitionError("utility audit binds another provisional catalog")
    if (
        disposition.get("source_catalog_sha256") != font_sha
        or disposition.get("source_render_bank_sha256") != render_sha
        or input_hashes.get("render_bank_manifest_sha256") != render_sha
    ):
        raise CatalogTransitionError(
            "formal evidence font/render source binding changed"
        )


def _candidate_rows_by_id(
    utility_report: Mapping[str, Any],
) -> tuple[dict[str, Mapping[str, Any]], tuple[str, ...], tuple[str, ...]]:
    rows: dict[str, Mapping[str, Any]] = {}
    prior: list[str] = []
    delta: list[str] = []
    for index, value in enumerate(
        require_list(utility_report.get("candidates"), "utility.candidates")
    ):
        row = require_mapping(value, f"utility.candidates[{index}]")
        candidate_id = require_text(
            row.get("candidate_id"), f"utility.candidates[{index}].candidate_id"
        )
        if candidate_id in rows:
            raise CatalogTransitionError("utility candidate identity is duplicated")
        rows[candidate_id] = row
        kind = row.get("candidate_kind")
        if kind == "legacy_15":
            prior.append(candidate_id)
        elif kind == "challenger_7":
            delta.append(candidate_id)
        else:
            raise CatalogTransitionError("utility candidate kind is unsupported")
    if len(prior) != EXPECTED_PRIOR_COUNT or len(delta) != EXPECTED_DELTA_COUNT:
        raise CatalogTransitionError("formal utility 15+7 inventory changed")
    return rows, tuple(sorted(prior)), tuple(sorted(delta))


def _load_resolutions(
    path: Path | None,
    *,
    ambiguous_ids: set[str],
    utility_report: Mapping[str, Any],
    provisional: Mapping[str, Any],
) -> tuple[dict[str, Mapping[str, Any]], str | None]:
    if path is None:
        if ambiguous_ids:
            raise CatalogTransitionError(
                "formal utility leaves safe-but-redundant candidates unresolved: "
                + ", ".join(sorted(ambiguous_ids))
            )
        return {}, None
    record = read_json(path, location="catalog transition resolutions")
    validate_seal(record, location="catalog transition resolutions")
    if (
        record.get("schema_version") != RESOLUTION_SCHEMA
        or record.get("record_type") != RESOLUTION_RECORD_TYPE
        or record.get("utility_record_sha256") != utility_report.get("record_sha256")
        or record.get("provisional_catalog_record_sha256")
        != require_mapping(provisional.get("catalog"), "catalog").get("record_sha256")
    ):
        raise CatalogTransitionError("catalog resolution authority binding changed")
    decisions: dict[str, Mapping[str, Any]] = {}
    for index, value in enumerate(require_list(record.get("decisions"), "decisions")):
        row = require_mapping(value, f"decisions[{index}]")
        if set(row) != {"action", "candidate_id", "rationale"}:
            raise CatalogTransitionError("catalog resolution decision fields changed")
        candidate_id = require_text(
            row.get("candidate_id"), f"decisions[{index}].candidate_id"
        )
        action = row.get("action")
        rationale = require_text(row.get("rationale"), f"decisions[{index}].rationale")
        if (
            candidate_id in decisions
            or action not in {RETAIN_ACTION, REDUNDANT_ACTION}
            or len(rationale.strip()) < 20
        ):
            raise CatalogTransitionError("catalog resolution decision is invalid")
        decisions[candidate_id] = row
    if set(decisions) != ambiguous_ids:
        raise CatalogTransitionError(
            "catalog resolutions must cover exactly the ambiguous candidates"
        )
    return decisions, require_sha(record.get("record_sha256"), "resolution seal")


def _derive_terminal_records(
    *,
    provisional: Mapping[str, Any],
    utility_report: Mapping[str, Any],
    resolution_path: Path | None,
) -> tuple[dict[str, Any], dict[str, Any], tuple[str, ...], tuple[str, ...]]:
    utility_rows, utility_prior_ids, utility_delta_ids = _candidate_rows_by_id(
        utility_report
    )
    provisional_catalog = require_mapping(provisional.get("catalog"), "catalog")
    provisional_disposition = require_mapping(
        provisional.get("disposition"), "disposition"
    )
    prior_ids = tuple(
        sorted(
            require_text(value, f"prior_candidate_ids[{index}]")
            for index, value in enumerate(
                require_list(
                    provisional_catalog.get("prior_candidate_ids"),
                    "prior_candidate_ids",
                )
            )
        )
    )
    if prior_ids != utility_prior_ids:
        raise CatalogTransitionError("provisional and utility prior catalogs differ")
    provisional_entries: dict[str, Mapping[str, Any]] = {}
    for index, value in enumerate(
        require_list(provisional_disposition.get("entries"), "disposition.entries")
    ):
        entry = require_mapping(value, f"disposition.entries[{index}]")
        candidate_id = require_text(
            entry.get("candidate_id"), f"disposition.entries[{index}].candidate_id"
        )
        if candidate_id in provisional_entries:
            raise CatalogTransitionError("provisional disposition is duplicated")
        provisional_entries[candidate_id] = entry
    if set(provisional_entries) != set(utility_delta_ids):
        raise CatalogTransitionError("provisional and utility challenger sets differ")

    evidence: dict[str, dict[str, int]] = {}
    ambiguous_ids: set[str] = set()
    for candidate_id in utility_delta_ids:
        entry = provisional_entries[candidate_id]
        human = require_mapping(
            require_mapping(utility_rows[candidate_id].get("metrics"), "metrics").get(
                "human"
            ),
            f"{candidate_id}.metrics.human",
        )
        metrics = {
            key: require_int(human.get(key), f"{candidate_id}.human.{key}")
            for key in (
                "deployable_opportunity_count",
                "legacy_gap_p1_rescue_count",
                "preferred_count",
                "safe_count",
                "unique_p1_safe_count",
                "unrenderable_count",
            )
        }
        safe_count = require_int(entry.get("safe_count"), f"{candidate_id}.safe_count")
        preferred_count = require_int(
            entry.get("preferred_count"), f"{candidate_id}.preferred_count"
        )
        opportunity_count = require_int(
            entry.get("deployable_opportunity_count"),
            f"{candidate_id}.deployable_opportunity_count",
        )
        unrenderable_count = require_int(
            entry.get("unrenderable_count"), f"{candidate_id}.unrenderable_count"
        )
        if (
            safe_count != metrics["safe_count"]
            or preferred_count != metrics["preferred_count"]
            or opportunity_count != metrics["deployable_opportunity_count"]
            or unrenderable_count != metrics["unrenderable_count"]
            or safe_count
            != preferred_count
            + require_int(entry.get("acceptable_count"), f"{candidate_id}.acceptable")
        ):
            raise CatalogTransitionError(
                f"{candidate_id}: provisional and formal human evidence differ"
            )
        if opportunity_count == 0 or entry.get("all_unrenderable") is True:
            raise CatalogTransitionError(
                f"{candidate_id}: no deployable opportunity; repair is required"
            )
        if safe_count > 0 and not (
            metrics["unique_p1_safe_count"] > 0
            or metrics["legacy_gap_p1_rescue_count"] > 0
        ):
            ambiguous_ids.add(candidate_id)
        evidence[candidate_id] = metrics

    resolutions, resolution_sha = _load_resolutions(
        resolution_path,
        ambiguous_ids=ambiguous_ids,
        utility_report=utility_report,
        provisional=provisional,
    )
    entries: list[dict[str, Any]] = []
    retained_ids: list[str] = []
    removed_ids: list[str] = []
    for candidate_id in utility_delta_ids:
        source = provisional_entries[candidate_id]
        metrics = evidence[candidate_id]
        resolution = resolutions.get(candidate_id)
        if metrics["safe_count"] == 0:
            action = SAFE_ZERO_ACTION
            reason_code = "formal_safe_zero_with_deployable_opportunity"
            rationale = None
        elif metrics["unique_p1_safe_count"] > 0:
            action = RETAIN_ACTION
            reason_code = "formal_unique_p1_safe_utility"
            rationale = None
        elif metrics["legacy_gap_p1_rescue_count"] > 0:
            action = RETAIN_ACTION
            reason_code = "formal_p1_legacy_gap_rescue_utility"
            rationale = None
        else:
            assert resolution is not None
            action = str(resolution["action"])
            reason_code = "sealed_human_redundancy_resolution"
            rationale = str(resolution["rationale"])
        if action not in TERMINAL_ACTIONS:
            raise CatalogTransitionError(f"{candidate_id}: non-terminal action")
        active = action == RETAIN_ACTION
        (retained_ids if active else removed_ids).append(candidate_id)
        entries.append(
            {
                **copy.deepcopy(dict(source)),
                "action": action,
                "active_release_eligible": active,
                "all_unrenderable": False,
                "formal_utility_evidence": copy.deepcopy(metrics),
                "formal_utility_record_sha256": utility_report["record_sha256"],
                "reason_code": reason_code,
                "replacement_state": (
                    "active_in_final_catalog"
                    if active
                    else "excluded_from_final_catalog"
                ),
                "resolution_rationale": rationale,
                "terminal": True,
            }
        )
    entries.sort(key=lambda row: str(row["candidate_id"]))
    retained_ids.sort()
    removed_ids.sort()
    disposition = seal(
        {
            "schema_version": ledger.V5_CATALOG_DISPOSITION_SCHEMA_VERSION,
            "record_type": ledger.V5_CATALOG_DISPOSITION_RECORD_TYPE,
            "workspace_contract_record_sha256": provisional_disposition[
                "workspace_contract_record_sha256"
            ],
            "calibration_report_record_sha256": provisional_disposition[
                "calibration_report_record_sha256"
            ],
            "provisional_catalog_disposition_record_sha256": provisional_disposition[
                "record_sha256"
            ],
            "provisional_catalog_record_sha256": provisional_catalog["record_sha256"],
            "formal_utility_record_sha256": utility_report["record_sha256"],
            "resolution_record_sha256": resolution_sha,
            "source_catalog_sha256": provisional_disposition["source_catalog_sha256"],
            "source_render_bank_sha256": provisional_disposition[
                "source_render_bank_sha256"
            ],
            "release_state": "final_released",
            "final_release_allowed": True,
            "full22_utility_audit_required": False,
            "candidate_count": len(entries),
            "included_candidate_count": len(retained_ids),
            "removed_candidate_count": len(removed_ids),
            "safe_zero_candidate_count": sum(
                row["action"] == SAFE_ZERO_ACTION for row in entries
            ),
            "redundant_candidate_count": sum(
                row["action"] == REDUNDANT_ACTION for row in entries
            ),
            "terminal_candidate_count": len(entries),
            "deployment_failure_candidate_count": 0,
            "included_candidate_ids": retained_ids,
            "removed_candidate_ids": removed_ids,
            "entries": entries,
        }
    )
    active_ids = tuple(sorted((*prior_ids, *retained_ids)))
    candidate_set_sha = _candidate_set_sha256(active_ids)
    final_catalog = seal(
        {
            "schema_version": ledger.V5_FINAL_CATALOG_SCHEMA_VERSION,
            "record_type": ledger.V5_FINAL_CATALOG_RECORD_TYPE,
            "workspace_contract_record_sha256": provisional_disposition[
                "workspace_contract_record_sha256"
            ],
            "catalog_disposition_record_sha256": disposition["record_sha256"],
            "source_catalog_sha256": provisional_disposition["source_catalog_sha256"],
            "catalog_version": f"font-matching-ko-v5-{candidate_set_sha[:16]}",
            "candidate_count": len(active_ids),
            "candidate_ids": list(active_ids),
            "candidate_set_sha256": candidate_set_sha,
            "prior_candidate_count": len(prior_ids),
            "prior_candidate_ids": list(prior_ids),
            "included_delta_candidate_count": len(retained_ids),
            "included_delta_candidates": [
                {"candidate_id": candidate_id} for candidate_id in retained_ids
            ],
            "removed_delta_candidate_count": len(removed_ids),
            "removed_delta_candidates": [
                {"candidate_id": candidate_id} for candidate_id in removed_ids
            ],
        }
    )
    return disposition, final_catalog, active_ids, tuple(removed_ids)


def _deployment_manifests(
    *,
    source_font_manifest: Mapping[str, Any],
    source_font_sha256: str,
    source_render_manifest: Mapping[str, Any],
    source_render_sha256: str,
    final_catalog: Mapping[str, Any],
    active_ids: Sequence[str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    active_set = set(active_ids)
    font_manifest = copy.deepcopy(dict(source_font_manifest))
    families = [
        copy.deepcopy(dict(require_mapping(value, "font family")))
        for value in require_list(font_manifest.get("families"), "font families")
        if require_mapping(value, "font family").get("font_id") in active_set
    ]
    if {str(row["font_id"]) for row in families} != active_set:
        raise CatalogTransitionError("font manifest does not cover the final catalog")
    font_manifest["families"] = families
    font_manifest["family_count"] = len(families)
    font_manifest["face_count"] = sum(
        len(require_list(family.get("faces"), "font family.faces"))
        for family in families
    )
    font_manifest["deployment_subset_contract"] = {
        "active_candidate_set_sha256": final_catalog["candidate_set_sha256"],
        "final_catalog_record_sha256": final_catalog["record_sha256"],
        "source_font_face_manifest_sha256": source_font_sha256,
    }
    deployment_font_sha = sha256_bytes(json_bytes(font_manifest, pretty=True))

    render_manifest = copy.deepcopy(dict(source_render_manifest))
    candidates = [
        copy.deepcopy(dict(require_mapping(value, "render candidate")))
        for value in require_list(
            render_manifest.get("candidates"), "render candidates"
        )
        if require_mapping(value, "render candidate").get("font_id") in active_set
    ]
    display_ids = {str(row["display_id"]) for row in candidates}
    renders = [
        copy.deepcopy(dict(require_mapping(value, "render")))
        for value in require_list(render_manifest.get("renders"), "renders")
        if require_mapping(value, "render").get("candidate_display_id") in display_ids
    ]
    if not candidates or not renders:
        raise CatalogTransitionError("deployment render subset is empty")
    rendered_ids = {str(row["candidate_display_id"]) for row in renders}
    if rendered_ids != display_ids:
        raise CatalogTransitionError(
            "an active render candidate has no prototype image"
        )
    render_manifest["candidates"] = candidates
    render_manifest["renders"] = renders
    render_manifest["family_count"] = len(active_set)
    render_manifest["face_count"] = len({str(row["face_id"]) for row in candidates})
    render_manifest["candidate_count"] = len(candidates)
    render_manifest["rendered_candidate_count"] = len(rendered_ids)
    source_contract = copy.deepcopy(
        dict(require_mapping(render_manifest.get("source_contract"), "source contract"))
    )
    source_contract["manifest_sha256"] = deployment_font_sha
    render_manifest["source_contract"] = source_contract
    generation = copy.deepcopy(
        dict(require_mapping(render_manifest.get("generation"), "generation"))
    )
    generation.update(
        {
            "limit": None,
            "partial": False,
            "expected_render_count": len(renders),
            "full_render_count": len(renders),
            "production_asset_omitted_render_count": 0,
            "complete_against_production_assets": True,
            "rendered_count": len(renders),
        }
    )
    render_manifest["generation"] = generation
    inputs = copy.deepcopy(require_list(render_manifest.get("inputs"), "inputs"))
    if inputs:
        first = dict(require_mapping(inputs[0], "inputs[0]"))
        first["path"] = f"{DEPLOYMENT_FONT_FILE} (derived subset)"
        first["sha256"] = deployment_font_sha
        inputs[0] = first
        render_manifest["inputs"] = inputs
    subset_contract = {
        "active_candidate_set_sha256": final_catalog["candidate_set_sha256"],
        "candidate_display_ids": sorted(display_ids),
        "final_catalog_record_sha256": final_catalog["record_sha256"],
        "render_ids": sorted(str(row["render_id"]) for row in renders),
        "source_render_bank_manifest_sha256": source_render_sha256,
    }
    render_manifest["deployment_subset_contract"] = subset_contract
    render_manifest["source_specification_sha256"] = require_sha(
        source_render_manifest.get("specification_sha256"),
        "source render specification",
    )
    render_manifest["specification_sha256"] = sha256_bytes(
        canonical_json(subset_contract).encode("utf-8")
    )
    return font_manifest, render_manifest


def derive_transition(
    *,
    provisional: Mapping[str, Any],
    utility_report: Mapping[str, Any],
    source_font_manifest: Mapping[str, Any],
    source_font_sha256: str,
    source_render_manifest: Mapping[str, Any],
    source_render_sha256: str,
    resolution_path: Path | None,
) -> dict[str, Any]:
    disposition, final_catalog, active_ids, removed_ids = _derive_terminal_records(
        provisional=provisional,
        utility_report=utility_report,
        resolution_path=resolution_path,
    )
    font_manifest, render_manifest = _deployment_manifests(
        source_font_manifest=source_font_manifest,
        source_font_sha256=source_font_sha256,
        source_render_manifest=source_render_manifest,
        source_render_sha256=source_render_sha256,
        final_catalog=final_catalog,
        active_ids=active_ids,
    )
    return {
        "disposition": disposition,
        "final_catalog": final_catalog,
        "font_manifest": font_manifest,
        "render_manifest": render_manifest,
        "active_ids": tuple(active_ids),
        "removed_ids": tuple(removed_ids),
    }


def _load_and_derive(
    *,
    provisional_workspace: Path,
    utility_audit: Path,
    source_font_face_manifest: Path,
    source_render_bank_manifest: Path,
    asset_root: Path,
    resolution_file: Path | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    provisional = _load_provisional_workspace(provisional_workspace)
    utility_report = _load_formal_utility(utility_audit)
    font_path = source_font_face_manifest.resolve()
    render_path = source_render_bank_manifest.resolve()
    _validate_authority_bindings(
        provisional=provisional,
        utility_report=utility_report,
        font_manifest_path=font_path,
        render_manifest_path=render_path,
    )
    source_font = read_json(font_path, location="source font face manifest")
    source_render = read_json(render_path, location="source render bank manifest")
    candidate_ids = tuple(
        require_text(value, f"utility.candidate_ids[{index}]")
        for index, value in enumerate(
            require_list(utility_report.get("candidate_ids"), "utility.candidate_ids")
        )
    )
    runtime._font_face_inventory(
        source_font,
        asset_root=asset_root.resolve(),
        expected_candidate_ids=candidate_ids,
    )
    runtime._validate_deployment_render_bank(
        source_render,
        manifest_path=render_path,
        font_face_manifest_sha256=sha256_file(font_path),
        expected_candidate_ids=candidate_ids,
    )
    derived = derive_transition(
        provisional=provisional,
        utility_report=utility_report,
        source_font_manifest=source_font,
        source_font_sha256=sha256_file(font_path),
        source_render_manifest=source_render,
        source_render_sha256=sha256_file(render_path),
        resolution_path=resolution_file,
    )
    context = {
        "provisional": provisional,
        "utility": utility_report,
        "source_font_path": font_path,
        "source_render_path": render_path,
    }
    return derived, context


def _artifact_descriptor(path: Path) -> dict[str, Any]:
    return {
        "byte_size": path.stat().st_size,
        "file": path.as_posix(),
        "sha256": sha256_file(path),
    }


def _render_asset_source(
    source_root: Path, relative_file: str, *, expected_sha: str, expected_size: int
) -> Path:
    relative = _safe_relative_path(relative_file, location="render artifact.file")
    root = source_root.resolve()
    source = (root / relative).resolve()
    try:
        source.relative_to(root)
    except ValueError as error:
        raise CatalogTransitionError(
            "render artifact escapes its source bank"
        ) from error
    if source.is_symlink() or not source.is_file():
        raise CatalogTransitionError(
            f"render artifact is missing or linked: {relative_file}"
        )
    if source.stat().st_size != expected_size or sha256_file(source) != expected_sha:
        raise CatalogTransitionError(f"render artifact changed: {relative_file}")
    return source


def _write_derived_files(
    staging: Path,
    *,
    derived: Mapping[str, Any],
    source_render_path: Path,
) -> None:
    values = {
        DISPOSITION_FILE: derived["disposition"],
        FINAL_CATALOG_FILE: derived["final_catalog"],
        DEPLOYMENT_FONT_FILE: derived["font_manifest"],
        DEPLOYMENT_RENDER_FILE: derived["render_manifest"],
    }
    for relative, value in values.items():
        path = staging / Path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(json_bytes(value, pretty=True))
    for value in require_list(
        require_mapping(derived.get("render_manifest"), "render manifest").get(
            "renders"
        ),
        "render manifest.renders",
    ):
        render = require_mapping(value, "render")
        artifact = require_mapping(render.get("artifact"), "render.artifact")
        relative_file = require_text(artifact.get("file"), "render.artifact.file")
        expected_sha = require_sha(artifact.get("sha256"), "render.artifact.sha256")
        expected_size = require_int(
            artifact.get("byte_size"), "render.artifact.byte_size", minimum=1
        )
        source = _render_asset_source(
            source_render_path.parent,
            relative_file,
            expected_sha=expected_sha,
            expected_size=expected_size,
        )
        target = (
            staging
            / DEPLOYMENT_RENDER_DIR
            / _safe_relative_path(relative_file, location="render target")
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def _build_report(
    root: Path,
    *,
    derived: Mapping[str, Any],
    context: Mapping[str, Any],
) -> dict[str, Any]:
    render_manifest = require_mapping(derived.get("render_manifest"), "render manifest")
    image_rows = []
    for value in require_list(render_manifest.get("renders"), "renders"):
        artifact = require_mapping(
            require_mapping(value, "render").get("artifact"), "artifact"
        )
        relative_file = require_text(artifact.get("file"), "artifact.file")
        image_rows.append(
            {
                "file": f"{DEPLOYMENT_RENDER_DIR}/{Path(relative_file).as_posix()}",
                "sha256": require_sha(artifact.get("sha256"), "artifact.sha256"),
            }
        )
    image_rows.sort(key=lambda row: row["file"])
    provisional = require_mapping(context.get("provisional"), "provisional")
    utility_report = require_mapping(context.get("utility"), "utility")
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": RECORD_TYPE,
            "owner": OWNER,
            "release_state": "final_released",
            "source_records": {
                "formal_utility_record_sha256": utility_report["record_sha256"],
                "provisional_catalog_disposition_record_sha256": require_mapping(
                    provisional.get("disposition"), "disposition"
                )["record_sha256"],
                "provisional_catalog_record_sha256": require_mapping(
                    provisional.get("catalog"), "catalog"
                )["record_sha256"],
                "provisional_report_record_sha256": require_mapping(
                    provisional.get("report"), "report"
                )["record_sha256"],
                "source_font_face_manifest_sha256": sha256_file(
                    Path(context["source_font_path"])
                ),
                "source_render_bank_manifest_sha256": sha256_file(
                    Path(context["source_render_path"])
                ),
            },
            "outputs": {
                name: _artifact_descriptor(root / name)
                for name in (
                    DISPOSITION_FILE,
                    FINAL_CATALOG_FILE,
                    DEPLOYMENT_FONT_FILE,
                    DEPLOYMENT_RENDER_FILE,
                )
            },
            "render_asset_count": len(image_rows),
            "render_asset_inventory_sha256": sha256_bytes(
                canonical_json(image_rows).encode("utf-8")
            ),
            "summary": {
                "active_candidate_count": len(derived["active_ids"]),
                "removed_delta_candidate_count": len(derived["removed_ids"]),
                "retained_delta_candidate_count": len(derived["active_ids"])
                - EXPECTED_PRIOR_COUNT,
            },
        }
    )


def _expected_file_set(derived: Mapping[str, Any]) -> set[str]:
    files = {
        DISPOSITION_FILE,
        FINAL_CATALOG_FILE,
        DEPLOYMENT_FONT_FILE,
        DEPLOYMENT_RENDER_FILE,
        REPORT_FILE,
        MARKER_FILE,
    }
    render_manifest = require_mapping(derived.get("render_manifest"), "render manifest")
    for value in require_list(render_manifest.get("renders"), "renders"):
        artifact = require_mapping(
            require_mapping(value, "render").get("artifact"), "artifact"
        )
        relative = _safe_relative_path(
            require_text(artifact.get("file"), "artifact.file"),
            location="artifact.file",
        )
        files.add((Path(DEPLOYMENT_RENDER_DIR) / relative).as_posix())
    return files


def _actual_file_set(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }


def build_output(*, output_dir: Path, **kwargs: Any) -> Mapping[str, Any]:
    output = output_dir.resolve()
    if output.exists():
        raise CatalogTransitionError("output directory already exists; use validate")
    derived, context = _load_and_derive(**kwargs)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        _write_derived_files(
            staging,
            derived=derived,
            source_render_path=Path(context["source_render_path"]),
        )
        report = _build_report(staging, derived=derived, context=context)
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = {
            "owner": OWNER,
            "schema_version": SCHEMA_VERSION,
            "report_sha256": sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        expected_files = _expected_file_set(derived)
        if _actual_file_set(staging) != expected_files:
            raise CatalogTransitionError("staged transition file inventory differs")
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {
        "active_candidate_count": len(derived["active_ids"]),
        "output_dir": str(output),
        "removed_delta_candidate_count": len(derived["removed_ids"]),
        "status": "built",
    }


def validate_output(*, output_dir: Path, **kwargs: Any) -> Mapping[str, Any]:
    output = output_dir.resolve()
    if output.is_symlink() or not output.is_dir():
        raise CatalogTransitionError("transition output directory is missing or linked")
    derived, context = _load_and_derive(**kwargs)
    expected_values = {
        DISPOSITION_FILE: derived["disposition"],
        FINAL_CATALOG_FILE: derived["final_catalog"],
        DEPLOYMENT_FONT_FILE: derived["font_manifest"],
        DEPLOYMENT_RENDER_FILE: derived["render_manifest"],
    }
    for relative, expected in expected_values.items():
        actual = read_json(output / relative, location=relative)
        if actual != expected:
            raise CatalogTransitionError(f"{relative}: differs from bound evidence")
    expected_report = _build_report(output, derived=derived, context=context)
    report = read_json(output / REPORT_FILE, location="transition report")
    validate_seal(report, location="transition report")
    if report != expected_report:
        raise CatalogTransitionError("transition report differs from bound evidence")
    marker = read_json(output / MARKER_FILE, location="transition marker")
    if marker != {
        "owner": OWNER,
        "schema_version": SCHEMA_VERSION,
        "report_sha256": sha256_file(output / REPORT_FILE),
        "safe_replace": True,
    }:
        raise CatalogTransitionError("transition ownership marker changed")
    render_manifest = require_mapping(derived.get("render_manifest"), "render manifest")
    for value in require_list(render_manifest.get("renders"), "renders"):
        artifact = require_mapping(
            require_mapping(value, "render").get("artifact"), "artifact"
        )
        relative_file = require_text(artifact.get("file"), "artifact.file")
        path = (
            output
            / DEPLOYMENT_RENDER_DIR
            / _safe_relative_path(relative_file, location="artifact.file")
        )
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size
            != require_int(artifact.get("byte_size"), "artifact.byte_size", minimum=1)
            or sha256_file(path)
            != require_sha(artifact.get("sha256"), "artifact.sha256")
        ):
            raise CatalogTransitionError(
                f"deployment render asset changed: {relative_file}"
            )
    if _actual_file_set(output) != _expected_file_set(derived):
        raise CatalogTransitionError("transition output file inventory differs")
    validation_artifact = output / ".validation-active-catalog.json"
    try:
        runtime.build_active_catalog(
            final_catalog_path=output / FINAL_CATALOG_FILE,
            catalog_disposition_path=output / DISPOSITION_FILE,
            deployment_font_face_manifest_path=output / DEPLOYMENT_FONT_FILE,
            deployment_render_bank_manifest_path=output / DEPLOYMENT_RENDER_FILE,
            asset_root=Path(kwargs["asset_root"]).resolve(),
            output_path=validation_artifact,
        )
    finally:
        if validation_artifact.exists():
            validation_artifact.unlink()
        if validation_artifact.exists():
            raise CatalogTransitionError("temporary active catalog validation remained")
    return {
        "active_candidate_count": len(derived["active_ids"]),
        "output_dir": str(output),
        "removed_delta_candidate_count": len(derived["removed_ids"]),
        "status": "valid",
    }


def _add_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--provisional-workspace", type=Path, required=True)
    parser.add_argument("--utility-audit", type=Path, required=True)
    parser.add_argument("--source-font-face-manifest", type=Path, required=True)
    parser.add_argument("--source-render-bank-manifest", type=Path, required=True)
    parser.add_argument("--asset-root", type=Path, required=True)
    parser.add_argument("--resolution-file", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="build a terminal catalog transition")
    validate = commands.add_parser("validate", help="recompute and validate it")
    _add_inputs(build)
    _add_inputs(validate)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    kwargs = {
        "provisional_workspace": args.provisional_workspace,
        "utility_audit": args.utility_audit,
        "source_font_face_manifest": args.source_font_face_manifest,
        "source_render_bank_manifest": args.source_render_bank_manifest,
        "asset_root": args.asset_root,
        "resolution_file": args.resolution_file,
        "output_dir": args.output_dir,
    }
    try:
        result = (
            build_output(**kwargs)
            if args.command == "build"
            else validate_output(**kwargs)
        )
    except (
        CatalogTransitionError,
        ledger.DeltaLedgerError,
        utility.UtilityEvaluationError,
        runtime.RuntimeArtifactError,
        OSError,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    sys.stdout.buffer.write(json_bytes(result, pretty=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
