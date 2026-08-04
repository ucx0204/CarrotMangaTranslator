#!/usr/bin/env python3
"""Build a sealed v5 calibration-only source supplement.

The supplement exists for fresh calibration samples which have authoritative
source pixels and split lineage but intentionally have no historical 15-font
label.  It may add review assignments only for the exact preflight-selected
samples missing from the rescue inventory.  The larger leakage closure is
carried solely so the delta ledger can compute and verify permanent training
quarantine; closure-only rows never receive review assignments or cards.
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
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts import build_font_matching_review_cards as card_builder  # noqa: E402
from scripts import derive_font_matching_delta_decisions as v5_deriver  # noqa: E402
from scripts import font_matching_calibration_preflight_v5 as preflight  # noqa: E402
from scripts import font_matching_catalog_delta_ledger as delta  # noqa: E402


SCHEMA_VERSION = "font-matching-calibration-supplement-v5"
MANIFEST_RECORD_TYPE = "font_matching_calibration_only_supplement_manifest"
SAMPLE_RECORD_TYPE = "font_matching_calibration_only_supplement_sample"
OBSERVATION_SCHEMA_VERSION = "font-matching-calibration-source-observations-v5"
OBSERVATION_INPUT_RECORD_TYPE = "font_matching_calibration_source_observations"
OBSERVATION_RECORD_TYPE = "font_matching_calibration_source_observation"
INVENTORY_RECORD_TYPE = "font_matching_calibration_only_review_inventory"
OWNER = "carrot-manga-translator/font-matching-calibration-supplement-v5"
MARKER_FILE = ".font-matching-calibration-supplement-v5-owned.json"
TRAINING_DISPOSITION = "permanent_quarantine_closure"
REVIEW_STAGES = ("primary", "secondary")
FORBIDDEN_BASELINE_KEYS = {
    "prior_final_record",
    "prior_final_record_sha256",
    "font_judgment",
    "prior_tiers",
    "candidate_scores",
    "candidate_ranks",
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
    "none_acceptable",
}


class SupplementError(ValueError):
    """Raised when a calibration-only supplement fails closed."""


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise SupplementError(f"cannot read {path}: {error}") from error
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    return sha256_bytes("\0".join(parts).encode("utf-8"))


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json_bytes(result))
    return result


def validate_seal(value: Mapping[str, Any], location: str) -> None:
    digest = value.get("record_sha256")
    if not isinstance(digest, str) or len(digest) != 64:
        raise SupplementError(f"{location}.record_sha256 is invalid")
    core = dict(value)
    core.pop("record_sha256", None)
    if sha256_bytes(canonical_json_bytes(core)) != digest:
        raise SupplementError(f"{location}: record seal changed")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise SupplementError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise SupplementError(f"{path}: expected an object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise SupplementError(f"cannot read {path}: {error}") from error
    for index, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise SupplementError(f"{path}:{index}: {error}") from error
        if not isinstance(value, dict):
            raise SupplementError(f"{path}:{index}: expected an object")
        rows.append(value)
    return rows


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SupplementError(f"{location}: expected an object")
    return value


def require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise SupplementError(f"{location}: expected an array")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SupplementError(f"{location}: expected non-empty text")
    return value.strip()


def file_binding(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    return {
        "path": str(resolved),
        "sha256": sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def relative_output_binding(name: str, payload: bytes) -> dict[str, Any]:
    return {"file": name, "sha256": sha256_bytes(payload), "byte_size": len(payload)}


def reject_baseline_fields(value: Any, location: str = "supplement") -> None:
    if isinstance(value, Mapping):
        collisions = sorted(FORBIDDEN_BASELINE_KEYS.intersection(map(str, value)))
        if collisions:
            raise SupplementError(
                f"{location}: calibration-only source contains baseline answer fields: {collisions}"
            )
        for key, child in value.items():
            reject_baseline_fields(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_baseline_fields(child, f"{location}[{index}]")


def _load_master_rows(path: Path, wanted: set[str]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise SupplementError(
                        f"{path}:{line_number}: invalid JSON: {error}"
                    ) from error
                if not isinstance(value, dict):
                    raise SupplementError(f"{path}:{line_number}: expected object")
                sample_id = value.get("id")
                if sample_id not in wanted:
                    continue
                if sample_id in found:
                    raise SupplementError(f"successor master repeats {sample_id}")
                found[str(sample_id)] = value
    except OSError as error:
        raise SupplementError(f"cannot stream successor master {path}: {error}") from error
    missing = sorted(wanted - set(found))
    if missing:
        raise SupplementError(f"successor master misses required rows: {missing[:8]}")
    return found


def _preflight_private_bindings(state: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    output: dict[str, Mapping[str, Any]] = {}
    for draw in state["draws"]:
        for binding in require_list(draw.get("private"), "preflight draw.private"):
            binding = require_mapping(binding, "preflight private binding")
            sample_id = require_text(
                binding.get("sample_id"), "preflight private binding.sample_id"
            )
            if sample_id in output:
                raise SupplementError(f"preflight repeats drawn sample {sample_id}")
            output[sample_id] = binding
    return output


def _observation_records(
    *,
    path: Path,
    supplement_ids: set[str],
    round_id: str,
    preflight_bindings: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    document = read_json(path)
    expected_top = {
        "schema_version",
        "record_type",
        "round_id",
        "fresh_blind_source_pass",
        "candidate_pixels_visible",
        "prior_font_scores_or_ranks_visible",
        "baseline_label_fields_present",
        "candidate_score_or_rank_fields_present",
        "training_disposition",
        "observations",
    }
    if set(document) != expected_top:
        raise SupplementError("source observations have unexpected fields")
    if (
        document.get("schema_version") != OBSERVATION_SCHEMA_VERSION
        or document.get("record_type") != OBSERVATION_INPUT_RECORD_TYPE
        or document.get("round_id") != round_id
        or document.get("fresh_blind_source_pass") is not True
        or document.get("candidate_pixels_visible") is not False
        or document.get("prior_font_scores_or_ranks_visible") is not False
        or document.get("baseline_label_fields_present") is not False
        or document.get("candidate_score_or_rank_fields_present") is not False
        or document.get("training_disposition") != TRAINING_DISPOSITION
    ):
        raise SupplementError("source observations are not a fresh candidate-free pass")
    reject_baseline_fields(document["observations"], "source observations")
    raw_rows = require_list(document.get("observations"), "observations")
    expected_row_keys = {
        "sample_id",
        "stage",
        "reviewer_id",
        "source_surface",
        "eligibility_evidence",
        "role_evidence",
        "source_family",
        "source_family_confidence",
        "serif_evidence",
        "axes",
        "hard_axes",
        "treatment",
        "rationale",
    }
    records: list[dict[str, Any]] = []
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    placeholder_batch_sha = stable_hash("calibration-only-source-observation", round_id)
    for index, raw_value in enumerate(raw_rows):
        raw = dict(require_mapping(raw_value, f"observations[{index}]"))
        if set(raw) != expected_row_keys:
            raise SupplementError(f"observations[{index}] has unexpected fields")
        sample_id = require_text(raw.get("sample_id"), f"observations[{index}].sample_id")
        stage = require_text(raw.get("stage"), f"observations[{index}].stage")
        reviewer_id = require_text(
            raw.get("reviewer_id"), f"observations[{index}].reviewer_id"
        )
        if sample_id not in supplement_ids or stage not in REVIEW_STAGES:
            raise SupplementError(f"observations[{index}] is outside exact supplement")
        key = (sample_id, stage)
        if key in by_key:
            raise SupplementError(f"duplicate source observation {key}")
        source_surface = dict(
            require_mapping(raw.get("source_surface"), f"observations[{index}].source_surface")
        )
        if set(source_surface) != {"path", "sha256", "pixel_sha256"}:
            raise SupplementError(f"observations[{index}].source_surface changed")
        surface_path = Path(
            require_text(source_surface.get("path"), f"observations[{index}].source_surface.path")
        ).resolve()
        if not surface_path.is_file() or sha256_file(surface_path) != source_surface.get(
            "sha256"
        ):
            raise SupplementError(f"observations[{index}] source surface bytes changed")
        preflight_stage = require_mapping(
            require_mapping(
                preflight_bindings[sample_id].get("source_stages"),
                f"preflight[{sample_id}].source_stages",
            ).get(stage),
            f"preflight[{sample_id}].source_stages.{stage}",
        )
        expected_surface = require_mapping(
            preflight_stage.get("source_only"),
            f"preflight[{sample_id}].source_stages.{stage}.source_only",
        )
        for field in ("sha256", "pixel_sha256"):
            if source_surface.get(field) != expected_surface.get(field):
                raise SupplementError(
                    f"observations[{index}] no longer binds the sealed preflight {field}"
                )
        record = seal(
            {
                "schema_version": OBSERVATION_SCHEMA_VERSION,
                "record_type": OBSERVATION_RECORD_TYPE,
                "round_id": round_id,
                **raw,
            }
        )
        # Reuse the production validator on the candidate-free evidence fields.
        probe = v5_deriver.seal_record(
            {
                "schema_version": v5_deriver.SOURCE_SCHEMA_VERSION,
                "record_type": v5_deriver.SOURCE_RECORD_TYPE,
                "assignment_id": f"supplement-{stage}-{stable_hash(sample_id, stage)[:24]}",
                "sample_id": sample_id,
                "stage": stage,
                "reviewer_id": reviewer_id,
                "batch_id": f"supplement-{stage}",
                "batch_size": len(supplement_ids),
                "batch_task_set_sha256": placeholder_batch_sha,
                "source_only_card_sha256": source_surface["sha256"],
                "eligibility_evidence": raw["eligibility_evidence"],
                "role_evidence": raw["role_evidence"],
                "source_family": raw["source_family"],
                "source_family_confidence": raw["source_family_confidence"],
                "serif_evidence": raw["serif_evidence"],
                "axes": raw["axes"],
                "hard_axes": raw["hard_axes"],
                "treatment": raw["treatment"],
                "rationale": raw["rationale"],
            }
        )
        try:
            normalized = v5_deriver.validate_annotation(
                probe, f"observations[{index}]"
            )
        except v5_deriver.DerivationError as error:
            raise SupplementError(str(error)) from error
        if v5_deriver.derive_eligibility(normalized) != "font_signal_present":
            raise SupplementError(f"observations[{index}] is not review-eligible")
        role, _, _ = v5_deriver.derive_role(normalized)
        if role == "unknown_needs_review" or role not in card_builder.V4_ROLE_TO_PROBE:
            raise SupplementError(f"observations[{index}] has no usable fresh role")
        record["derived_role"] = role
        # Reseal after adding the deterministic derived field.
        record = seal(record)
        by_key[key] = record
        records.append(record)
    expected_keys = {(sample_id, stage) for sample_id in supplement_ids for stage in REVIEW_STAGES}
    if set(by_key) != expected_keys:
        raise SupplementError("source observations do not cover exact7 x two stages")
    records.sort(key=lambda row: (str(row["stage"]), str(row["sample_id"])))
    return records, by_key


def _render_candidates(render_manifest: Mapping[str, Any]) -> tuple[list[str], dict[str, str], str]:
    candidates = require_list(render_manifest.get("candidates"), "render candidates")
    candidate_ids: list[str] = []
    id_to_alias: dict[str, str] = {}
    for index, value in enumerate(candidates):
        row = require_mapping(value, f"render candidates[{index}]")
        if row.get("production_400_normal_canonical") is not True:
            continue
        font_id = require_text(row.get("font_id"), f"render candidates[{index}].font_id")
        alias = require_text(
            row.get("blind_alias"), f"render candidates[{index}].blind_alias"
        )
        if font_id in id_to_alias or alias in id_to_alias.values():
            raise SupplementError("render bank repeats a canonical candidate")
        candidate_ids.append(font_id)
        id_to_alias[font_id] = alias
    if len(candidate_ids) != 7:
        raise SupplementError("supplement requires the same seven canonical candidates")
    source_contract = require_mapping(
        render_manifest.get("source_contract"), "render source_contract"
    )
    catalog_version = require_text(
        source_contract.get("schema_version"), "render source_contract.schema_version"
    )
    return candidate_ids, id_to_alias, catalog_version


def _atomic_replace_directory(output_dir: Path, staging: Path) -> None:
    target = output_dir.resolve()
    if target.exists():
        marker = target / MARKER_FILE
        if not marker.is_file():
            raise SupplementError(f"refusing to replace unowned output: {target}")
        marker_value = read_json(marker)
        if marker_value.get("owner") != OWNER or marker_value.get("safe_replace") is not True:
            raise SupplementError(f"refusing to replace output with invalid marker: {target}")
        backup = target.parent / f".{target.name}.backup-{os.getpid()}"
        if backup.exists():
            raise SupplementError(f"unexpected backup path exists: {backup}")
        os.replace(target, backup)
        try:
            os.replace(staging, target)
        except BaseException:
            os.replace(backup, target)
            raise
        shutil.rmtree(backup)
    else:
        os.replace(staging, target)


def build_supplement(
    *,
    preflight_workspace: Path,
    rescue_inputs: Path,
    font_signal_audit: Path,
    successor_master_manifest: Path,
    successor_master_report: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    rubric: Path,
    observations: Path,
    output_dir: Path,
) -> dict[str, Any]:
    paths = {
        "preflight_contract": preflight_workspace / "contract.json",
        "preflight_final_report": preflight_workspace / "final" / "report.json",
        "preflight_scored_samples": preflight_workspace / "final" / "scored-sample-ids.json",
        "preflight_quarantine_closure": preflight_workspace
        / "final"
        / "training-quarantine-closure.json",
        "base_source_report": rescue_inputs / "report.json",
        "base_ready_inventory": font_signal_audit / "review-ready-inventory.jsonl",
        "base_ready_assignments": font_signal_audit / "review-ready-assignments.jsonl",
        "successor_master_manifest": successor_master_manifest,
        "successor_master_report": successor_master_report,
        "successor_master_split_map": successor_master_report.parent
        / "split_map.json",
        "catalog_registry": catalog_registry,
        "render_bank_manifest": render_bank_manifest,
        "rubric": rubric,
        "source_observations_input": observations,
    }
    for name, path in paths.items():
        if not path.is_file():
            raise SupplementError(f"missing {name}: {path}")

    # Full preflight validation is the authority for exact selection and all
    # source-only review bindings.  No prior font score/rank artifact is read.
    try:
        preflight_state = preflight._load_workspace(preflight_workspace)
    except preflight.PreflightError as error:
        raise SupplementError(str(error)) from error
    if not (preflight_workspace / "final").is_dir():
        raise SupplementError("preflight is not finalized")
    final_report = read_json(paths["preflight_final_report"])
    scored = read_json(paths["preflight_scored_samples"])
    closure = read_json(paths["preflight_quarantine_closure"])
    for value, location in (
        (final_report, "preflight final report"),
        (scored, "preflight scored samples"),
        (closure, "preflight quarantine closure"),
    ):
        preflight.validate_seal(value, location)
    round_id = require_text(scored.get("round_id"), "scored.round_id")
    if closure.get("round_id") != round_id:
        raise SupplementError("preflight final artifacts bind different rounds")
    if (
        final_report.get("scored_sample_ids_file_sha256")
        != sha256_file(paths["preflight_scored_samples"])
        or final_report.get("training_quarantine_file_sha256")
        != sha256_file(paths["preflight_quarantine_closure"])
    ):
        raise SupplementError("preflight final report no longer binds scored/quarantine files")
    selected_ids = set(require_list(scored.get("sample_ids"), "scored.sample_ids"))
    if scored.get("sample_count") != 60 or len(selected_ids) != 60:
        raise SupplementError("preflight did not seal exact60")
    if closure.get("test_samples_present") is not False:
        raise SupplementError("preflight closure contains test samples")
    preflight_closure_ids = set(
        require_list(
            closure.get("current_round_training_quarantine_sample_ids"),
            "closure.current_round_training_quarantine_sample_ids",
        )
    )

    base_inventory_rows = read_jsonl(paths["base_ready_inventory"])
    base_inventory_ids = {str(row.get("sample_id")) for row in base_inventory_rows}
    supplement_ids = selected_ids - base_inventory_ids
    if len(supplement_ids) != 7:
        raise SupplementError(
            f"fresh supplement must be exact7 absent from base inventory, got {len(supplement_ids)}"
        )
    if len(selected_ids.intersection(base_inventory_ids)) != 53:
        raise SupplementError("base card/source coverage is not exact53")
    # Three manual-recrop successor IDs are intentionally absent from the
    # preflight's parent-master closure.  Once those real successor rows exist,
    # the scored samples themselves must also be quarantined.  This is a strict
    # union, never a replacement or relaxation of the sealed 117-row closure.
    training_quarantine_ids = preflight_closure_ids | supplement_ids
    if not selected_ids.issubset(training_quarantine_ids):
        raise SupplementError("exact60 escapes successor training quarantine")

    master_report = read_json(successor_master_report)
    master_sha = sha256_file(successor_master_manifest)
    master_outputs = require_mapping(master_report.get("outputs"), "master report.outputs")
    if (
        master_outputs.get("master_manifest_sha256") != master_sha
    ):
        raise SupplementError("successor master report no longer binds manifest")
    successor_split_sha = sha256_file(paths["successor_master_split_map"])
    if (
        master_outputs.get("split_map") != paths["successor_master_split_map"].name
        or master_outputs.get("split_map_sha256") != successor_split_sha
    ):
        raise SupplementError("successor master report no longer binds split map")
    registry_sha = sha256_file(catalog_registry)
    registry_attestation = require_mapping(
        require_mapping(master_report.get("inputs"), "master report.inputs").get(
            "attestation"
        ),
        "master report.inputs.attestation",
    ).get("catalog_registry")
    if not isinstance(registry_attestation, Mapping) or registry_attestation.get(
        "sha256"
    ) != registry_sha:
        raise SupplementError("successor master binds another catalog registry")

    master_rows = _load_master_rows(successor_master_manifest, training_quarantine_ids)
    for sample_id, row in master_rows.items():
        if row.get("split") != "train":
            raise SupplementError(f"quarantine row {sample_id} is not canonical train")
        provenance = require_mapping(row.get("provenance"), f"master[{sample_id}].provenance")
        if provenance.get("synthetic") is not False or provenance.get("qa_overlay") is not False:
            raise SupplementError(f"quarantine row {sample_id} is synthetic or QA")
    if any(
        master_rows[sample_id].get("split") == "test"
        for sample_id in training_quarantine_ids
    ):
        raise SupplementError("successor closure reaches sealed test")

    private_bindings = _preflight_private_bindings(preflight_state)
    observation_records, observations_by_key = _observation_records(
        path=observations,
        supplement_ids=supplement_ids,
        round_id=round_id,
        preflight_bindings=private_bindings,
    )
    observations_payload = jsonl_bytes(observation_records)

    render_manifest = read_json(render_bank_manifest)
    candidate_ids, id_to_alias, catalog_version = _render_candidates(render_manifest)
    base_assignment_rows = read_jsonl(paths["base_ready_assignments"])
    next_review_order = 1 + max(
        int(row.get("review_order", 0)) for row in base_assignment_rows
    )
    assignment_rows: list[dict[str, Any]] = []
    assignment_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for sample_index, sample_id in enumerate(sorted(supplement_ids)):
        master = master_rows[sample_id]
        work_id = require_text(
            require_mapping(master.get("work"), f"master[{sample_id}].work").get("id"),
            f"master[{sample_id}].work.id",
        )
        source_page_sha = require_text(
            require_mapping(master.get("page"), f"master[{sample_id}].page").get(
                "source_page_sha256"
            ),
            f"master[{sample_id}].page.source_page_sha256",
        )
        for stage_index, stage in enumerate(REVIEW_STAGES):
            seed = stable_hash(
                "font-matching-calibration-only-assignment-v5",
                round_id,
                stage,
                sample_id,
            )
            order = card_builder.expected_candidate_order(candidate_ids, seed)
            row: dict[str, Any] = {
                "schema_version": 1,
                "record_type": "manga_font_label_assignment",
                "sample_id": sample_id,
                "work_id": work_id,
                "source_page_sha256": source_page_sha,
                "stage": stage,
                "review_order": next_review_order + sample_index,
                "priority_rank": 0,
                "catalog_version": catalog_version,
                "candidate_count": 7,
                "candidate_initial_state": "not_reviewed",
                "candidate_order_seed": seed,
                "candidate_order": order,
                "blind_alias_order": [id_to_alias[candidate] for candidate in order],
                "blind_first_pass": True,
                "release_state": "ready",
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "prior_tiers_visible": False,
                "split_visible": False,
                "adjudication_if": list(delta.EXPECTED_TRIGGER_NAMES),
                "reviewer_independence": {
                    "required_for_secondary": stage == "secondary",
                    "same_reviewer_as_primary_allowed": (
                        False if stage == "secondary" else None
                    ),
                },
            }
            row["assignment_id"] = card_builder.expected_assignment_id(row)
            card_builder.validate_assignment(row, f"supplement assignment {sample_id}/{stage}")
            assignment_rows.append(row)
            assignment_by_key[(sample_id, stage)] = row
    assignment_rows.sort(
        key=lambda row: (
            0 if row["stage"] == "primary" else 1,
            int(row["review_order"]),
            str(row["assignment_id"]),
        )
    )
    assignments_payload = jsonl_bytes(assignment_rows)

    inventory_rows: list[dict[str, Any]] = []
    for sample_id in sorted(supplement_ids):
        master = master_rows[sample_id]
        inventory_rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": INVENTORY_RECORD_TYPE,
                    "sample_id": sample_id,
                    "work_id": master["work"]["id"],
                    "source_page_sha256": master["page"]["source_page_sha256"],
                    "master_manifest_sha256": master_sha,
                    "fresh_source_observation_record_sha256s": [
                        observations_by_key[(sample_id, stage)]["record_sha256"]
                        for stage in REVIEW_STAGES
                    ],
                    "provenance": {"synthetic": False, "qa_overlay": False},
                    "training_disposition": TRAINING_DISPOSITION,
                }
            )
        )
    inventory_payload = jsonl_bytes(inventory_rows)
    inventory_sha = sha256_bytes(inventory_payload)
    rubric_sha = sha256_file(rubric)
    observation_sha = sha256_bytes(observations_payload)

    source_seal_payloads: dict[str, bytes] = {}
    for stage in REVIEW_STAGES:
        samples: list[dict[str, Any]] = []
        for sample_id in sorted(supplement_ids):
            observation = observations_by_key[(sample_id, stage)]
            treatment = require_mapping(
                observation.get("treatment"), f"observation[{sample_id}/{stage}].treatment"
            )
            samples.append(
                seal(
                    {
                        "sample_id": sample_id,
                        "fresh_source_observation_record_sha256": observation[
                            "record_sha256"
                        ],
                        "sealed_role": observation["derived_role"],
                        "treatment": {
                            "outline": treatment["outline"],
                            "shadow": treatment["shadow"],
                            "inverse": treatment["inverse_fill"],
                            "distortion": treatment["distortion"],
                            "texture": treatment["texture"],
                        },
                    }
                )
            )
        source_seal = seal(
            {
                "schema_version": card_builder.CALIBRATION_ONLY_SOURCE_SEAL_SCHEMA_VERSION,
                "record_type": card_builder.CALIBRATION_ONLY_SOURCE_SEAL_RECORD_TYPE,
                "development_only": True,
                "baseline_label_fields_present": False,
                "candidate_score_or_rank_fields_present": False,
                "training_disposition": TRAINING_DISPOSITION,
                "inputs": {
                    "inventory_sha256": inventory_sha,
                    "master_manifest_sha256": master_sha,
                    "rubric_sha256": rubric_sha,
                    "fresh_source_observations_sha256": observation_sha,
                },
                "samples": samples,
            }
        )
        source_seal_payloads[stage] = canonical_json_bytes(source_seal, pretty=True)

    closure_rows = [
        master_rows[sample_id] for sample_id in sorted(training_quarantine_ids)
    ]
    closure_payload = jsonl_bytes(closure_rows)
    sample_records: list[dict[str, Any]] = []
    for sample_id in sorted(supplement_ids):
        master = master_rows[sample_id]
        conflict_keys = sorted(delta._master_calibration_leakage_keys(master))
        preflight_conflict_keys = sorted(
            require_list(
                private_bindings[sample_id].get("visual_lineage_conflict_keys"),
                f"preflight[{sample_id}].visual_lineage_conflict_keys",
            )
        )
        if conflict_keys != preflight_conflict_keys:
            raise SupplementError(f"{sample_id}: successor conflict lineage changed")
        sample_records.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": SAMPLE_RECORD_TYPE,
                    "sample_id": sample_id,
                    "work_id": master["work"]["id"],
                    "source_page_sha256": master["page"]["source_page_sha256"],
                    "sample_crop_sha256": master["sample_crop_sha256"],
                    "split": "train",
                    "successor_master_row_sha256": sha256_bytes(
                        canonical_json_bytes(master)
                    ),
                    "source_catalog_id": master["provenance"]["source_catalog_id"],
                    "visual_lineage_conflict_keys": conflict_keys,
                    "fresh_source_observation_record_sha256s": [
                        observations_by_key[(sample_id, stage)]["record_sha256"]
                        for stage in REVIEW_STAGES
                    ],
                    "assignment_ids": [
                        assignment_by_key[(sample_id, stage)]["assignment_id"]
                        for stage in REVIEW_STAGES
                    ],
                    "baseline_label_fields_present": False,
                    "candidate_score_or_rank_fields_present": False,
                    "training_disposition": TRAINING_DISPOSITION,
                }
            )
        )
    samples_payload = jsonl_bytes(sample_records)

    output_payloads = {
        "inventory.jsonl": inventory_payload,
        "assignments.jsonl": assignments_payload,
        "fresh-source-observations.jsonl": observations_payload,
        "source-seal-primary.json": source_seal_payloads["primary"],
        "source-seal-secondary.json": source_seal_payloads["secondary"],
        "closure-master.jsonl": closure_payload,
        "samples.jsonl": samples_payload,
    }
    manifest = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": MANIFEST_RECORD_TYPE,
            "owner": OWNER,
            "round_id": round_id,
            "development_only": True,
            "fresh_blind_source_pass": True,
            "baseline_label_fields_present": False,
            "candidate_score_or_rank_fields_present": False,
            "parent_font_score_or_rank_inheritance_allowed": False,
            "training_disposition": TRAINING_DISPOSITION,
            "source_split": "train",
            "test_lineage_sample_count": 0,
            "supplemental_review_sample_count": len(supplement_ids),
            "base_review_sample_count": len(selected_ids.intersection(base_inventory_ids)),
            "selected_sample_count": len(selected_ids),
            "candidate_assignment_count": len(assignment_rows),
            "preflight_closure_sample_count": len(preflight_closure_ids),
            "closure_master_row_count": len(training_quarantine_ids),
            "quarantine_validation_only_sample_count": len(
                preflight_closure_ids - supplement_ids
            ),
            "closure_card_candidate_count": 0,
            "supplemental_sample_ids": sorted(supplement_ids),
            "supplemental_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(supplement_ids))
            ),
            "selected_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(selected_ids))
            ),
            "training_quarantine_sample_ids": sorted(training_quarantine_ids),
            "training_quarantine_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(training_quarantine_ids))
            ),
            "inputs": {
                name: file_binding(path) for name, path in sorted(paths.items())
            }
            | {
                "preflight_final_report_record_sha256": final_report["record_sha256"],
                "preflight_scored_samples_record_sha256": scored["record_sha256"],
                "preflight_quarantine_record_sha256": closure["record_sha256"],
                "successor_master_manifest_sha256": master_sha,
                "successor_master_split_map_sha256": successor_split_sha,
                "successor_catalog_registry_sha256": registry_sha,
                "builder_source_sha256": sha256_file(Path(__file__).resolve()),
            },
            "outputs": {
                name: relative_output_binding(name, payload)
                for name, payload in sorted(output_payloads.items())
            },
        }
    )
    reject_baseline_fields(
        {
            "samples": sample_records,
            "observations": observation_records,
        },
        "sealed supplement source evidence",
    )
    manifest_payload = canonical_json_bytes(manifest, pretty=True)
    marker_payload = canonical_json_bytes(
        {
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
            "manifest_sha256": sha256_bytes(manifest_payload),
        },
        pretty=True,
    )

    target = output_dir.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.building-", dir=target.parent))
    completed = False
    try:
        for name, payload in output_payloads.items():
            (staging / name).write_bytes(payload)
        (staging / "manifest.json").write_bytes(manifest_payload)
        (staging / MARKER_FILE).write_bytes(marker_payload)
        _atomic_replace_directory(target, staging)
        completed = True
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)
    return {
        "status": "built",
        "output": str(target),
        "supplemental_review_samples": len(supplement_ids),
        "base_review_samples": 53,
        "selected_samples": 60,
        "preflight_closure_samples": len(preflight_closure_ids),
        "training_quarantine_samples": len(training_quarantine_ids),
        "test_lineage_samples": 0,
        "candidate_assignments": len(assignment_rows),
        "closure_card_candidates": 0,
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": sha256_bytes(manifest_payload),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight-workspace", type=Path, required=True)
    parser.add_argument("--rescue-inputs", type=Path, required=True)
    parser.add_argument("--font-signal-audit", type=Path, required=True)
    parser.add_argument("--successor-master-manifest", type=Path, required=True)
    parser.add_argument("--successor-master-report", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--rubric", type=Path, required=True)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build_supplement(
            preflight_workspace=args.preflight_workspace,
            rescue_inputs=args.rescue_inputs,
            font_signal_audit=args.font_signal_audit,
            successor_master_manifest=args.successor_master_manifest,
            successor_master_report=args.successor_master_report,
            catalog_registry=args.catalog_registry,
            render_bank_manifest=args.render_bank_manifest,
            rubric=args.rubric,
            observations=args.observations,
            output_dir=args.output_dir,
        )
    except (SupplementError, delta.DeltaLedgerError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
