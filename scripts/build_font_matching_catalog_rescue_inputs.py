#!/usr/bin/env python3
"""Build sealed blind-review inputs for newly added font families.

Legacy ``build``/``validate`` retain the original none-only rescue workflow.
The v3 commands instead bind the sealed active training export, carry the full
15-family human final only as merge provenance, and create blind assignments
for the seven-family catalog delta.  Neither mode mutates its source artifacts.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import font_matching_labels as labels


SCHEMA_VERSION = "font-matching-catalog-rescue-inputs-v1"
DELTA_SCHEMA_VERSION = "font-matching-catalog-delta-review-inputs-v3"
SELECTION_RECORD_TYPE = "font_catalog_rescue_selection"
DELTA_SELECTION_RECORD_TYPE = "font_catalog_delta_review_selection"
OWNER = "carrot-manga-translator/font-matching-catalog-rescue-inputs"
MARKER_FILE = ".font-matching-catalog-rescue-inputs-owned.json"
MASTER_FILE = "master.jsonl"
SELECTION_FILE = "selection.jsonl"
ASSIGNMENTS_FILE = "assignments.jsonl"
FONT_SIGNAL_AUDIT_FILE = "font-signal-audit.jsonl"
REPORT_FILE = "report.json"
RENDER_BANK_DIR = "render-bank"
RENDER_BANK_MANIFEST = f"{RENDER_BANK_DIR}/manifest.json"

TRAINING_EXPORT_MARKER = ".font-matching-training-export-owned.json"
TRAINING_EXPORT_OWNER = "carrot-manga-translator/font-matching-training-export"
TRAINING_EXPORT_SCHEMA = "font-matching-training-export-v1"
TRAINING_SAMPLE_SCHEMA = "font-matching-training-sample-v1"
TRAINING_EXPORT_REPORT_SCHEMA = "font-matching-training-export-report-v1"
CATALOG_REGISTRY_SCHEMA = "font-matching-catalog-registry-v1"
KNOWN_FONT_SIGNAL_AUDIT_SAMPLE_IDS = frozenset({"fm_08980fe9ca80d39e6c18a32f"})
PRIOR_TIER_FIELDS = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
    "not_reviewed",
)
SFX_ROLES = frozenset(
    {
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
    }
)
VARIANT_SECONDARY_ROLES = frozenset(
    {
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "whisper",
        "sign_ui_title",
        *SFX_ROLES,
    }
)
FONT_SIGNAL_UNKNOWN_FIELD_THRESHOLD = 3
HIGH_VARIANT_STYLE_THRESHOLD = 0.5
MANDATORY_SECONDARY_MAX_PRIORITY = 1
SECONDARY_SAMPLE_RATE = 0.20
ADJUDICATION_CONFIDENCE_THRESHOLD = 0.80


class RescueInputError(ValueError):
    """Raised when a rescue input or generated artifact violates its contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any) -> bytes:
    return (canonical_json(value) + "\n").encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(json_bytes(row) for row in rows)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_record_sha256(record: Mapping[str, Any]) -> str:
    """Hash a sealed source record using the source artifacts' no-LF contract."""

    payload = copy.deepcopy(dict(record))
    payload.pop("record_sha256", None)
    return sha256_bytes(canonical_json(payload).encode("utf-8"))


def sorted_ids_sha256(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(sorted(values)) + "\n").encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RescueInputError(f"{location}: expected an object")
    return value


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise RescueInputError(f"{location}: expected non-empty text")
    return value


def require_sha(value: Any, location: str) -> str:
    text = require_text(value, location)
    if len(text) != 64 or any(
        character not in "0123456789abcdef" for character in text
    ):
        raise RescueInputError(f"{location}: expected lowercase SHA-256")
    return text


def require_nonnegative_int(value: Any, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RescueInputError(f"{location}: expected a non-negative integer")
    return value


def require_sealed_record(record: Mapping[str, Any], location: str) -> str:
    expected = require_sha(record.get("record_sha256"), f"{location}.record_sha256")
    if canonical_record_sha256(record) != expected:
        raise RescueInputError(f"{location}: record SHA-256 is invalid")
    return expected


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RescueInputError(f"{location}: could not read JSON: {error}") from error
    return dict(require_mapping(value, location))


def read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RescueInputError(
                        f"{location}:{line_number}: invalid JSON: {error}"
                    ) from error
                rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    except OSError as error:
        raise RescueInputError(f"{location}: could not read JSONL: {error}") from error
    if not rows:
        raise RescueInputError(f"{location}: JSONL is empty")
    return rows


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(json_bytes(output))
    return output


def _catalog_family_ids(document: Mapping[str, Any], location: str) -> list[str]:
    families = document.get("families")
    if not isinstance(families, list) or not families:
        raise RescueInputError(f"{location}.families must be a non-empty array")
    output = []
    for index, value in enumerate(families):
        family = require_mapping(value, f"{location}.families[{index}]")
        output.append(
            require_text(family.get("font_id"), f"{location}.families[{index}].font_id")
        )
    if len(output) != len(set(output)) or document.get("family_count") != len(output):
        raise RescueInputError(f"{location}: family IDs/count are invalid")
    return output


def _load_prior_none_labels(
    final_labels: Path,
    *,
    expected_catalog_sha256: str,
) -> tuple[dict[str, dict[str, Any]], Counter[str]]:
    selected: dict[str, dict[str, Any]] = {}
    roles: Counter[str] = Counter()
    seen: set[str] = set()
    for index, row in enumerate(read_jsonl(final_labels, "final labels"), 1):
        try:
            labels.validate_final_record(row)
        except labels.LabelValidationError as error:
            raise RescueInputError(f"final labels:{index}: {error}") from error
        sample_id = require_text(
            row.get("sample_id"), f"final labels:{index}.sample_id"
        )
        if sample_id in seen:
            raise RescueInputError(
                f"final labels:{index}: duplicate sample {sample_id}"
            )
        seen.add(sample_id)
        resolution = require_mapping(
            row.get("resolution"), f"final labels:{index}.resolution"
        )
        if (
            require_sha(
                resolution.get("catalog_sha256"),
                f"final labels:{index}.resolution.catalog_sha256",
            )
            != expected_catalog_sha256
        ):
            raise RescueInputError(
                f"final labels:{index}: source catalog does not match legacy catalog"
            )
        judgment = require_mapping(
            row.get("font_judgment"), f"final labels:{index}.font_judgment"
        )
        if judgment.get("none_acceptable") is not True:
            continue
        selected[sample_id] = row
        roles[
            require_text(
                require_mapping(row.get("role"), f"final labels:{index}.role").get(
                    "primary"
                ),
                f"final labels:{index}.role.primary",
            )
        ] += 1
    if not selected:
        raise RescueInputError("final labels contain no none_acceptable samples")
    return selected, roles


def _filter_master(
    master_manifest: Path,
    prior_by_sample: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    master_rows: list[dict[str, Any]] = []
    selection_rows: list[dict[str, Any]] = []
    found: set[str] = set()
    try:
        handle = master_manifest.open("r", encoding="utf-8")
    except OSError as error:
        raise RescueInputError(
            f"master manifest could not be opened: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RescueInputError(
                    f"master manifest:{line_number}: invalid JSON: {error}"
                ) from error
            row = dict(require_mapping(value, f"master manifest:{line_number}"))
            sample_id = require_text(row.get("id"), f"master manifest:{line_number}.id")
            prior = prior_by_sample.get(sample_id)
            if prior is None:
                continue
            if sample_id in found:
                raise RescueInputError(
                    f"master manifest repeats selected sample {sample_id}"
                )
            if (
                require_mapping(
                    row.get("provenance"), f"master[{sample_id}].provenance"
                ).get("qa_overlay")
                is not False
            ):
                raise RescueInputError(f"master[{sample_id}] contains a QA overlay")
            if (
                require_mapping(
                    row.get("provenance"), f"master[{sample_id}].provenance"
                ).get("synthetic")
                is not False
            ):
                raise RescueInputError(f"master[{sample_id}] is synthetic")
            work = require_mapping(row.get("work"), f"master[{sample_id}].work")
            page = require_mapping(row.get("page"), f"master[{sample_id}].page")
            work_id = require_text(work.get("id"), f"master[{sample_id}].work.id")
            source_page_sha256 = require_sha(
                page.get("source_page_sha256"),
                f"master[{sample_id}].page.source_page_sha256",
            )
            if prior.get("work_id") != work_id:
                raise RescueInputError(f"master[{sample_id}] work binding mismatch")
            if prior.get("source_page_sha256") != source_page_sha256:
                raise RescueInputError(
                    f"master[{sample_id}] source-page binding mismatch"
                )
            prior_role = require_mapping(prior.get("role"), f"final[{sample_id}].role")
            prior_treatment = require_mapping(
                prior.get("treatment"), f"final[{sample_id}].treatment"
            )
            prior_final_id = require_text(
                prior.get("final_id"), f"final[{sample_id}].final_id"
            )
            prior_final_sha256 = require_sha(
                prior.get("record_sha256"),
                f"final[{sample_id}].record_sha256",
            )
            prior_orientation = require_text(
                prior_treatment.get("orientation"),
                f"final[{sample_id}].treatment.orientation",
            )
            if prior_orientation not in {"horizontal", "vertical"}:
                raise RescueInputError(
                    f"final[{sample_id}]: unsupported reviewed orientation "
                    f"{prior_orientation!r}"
                )
            source_master_record_sha256 = sha256_bytes(json_bytes(row))
            corrected_master = copy.deepcopy(row)
            metadata = dict(
                require_mapping(
                    corrected_master.get("metadata", {}),
                    f"master[{sample_id}].metadata",
                )
            )
            previous_orientation = metadata.get("orientation")
            metadata["orientation"] = prior_orientation
            metadata["catalog_rescue_orientation"] = {
                "source": "prior_final_human_orientation",
                "prior_final_id": prior_final_id,
                "prior_final_record_sha256": prior_final_sha256,
                "source_master_record_sha256": source_master_record_sha256,
                "previous_orientation": previous_orientation,
                "applied_orientation": prior_orientation,
                "orientation_changed": previous_orientation != prior_orientation,
            }
            corrected_master["metadata"] = metadata
            master_rows.append(corrected_master)
            selection_rows.append(
                seal(
                    {
                        "schema_version": 1,
                        "record_type": SELECTION_RECORD_TYPE,
                        "sample_id": sample_id,
                        "work_id": work_id,
                        "source_page_sha256": source_page_sha256,
                        "source_master_line_number": line_number,
                        "source_master_record_sha256": source_master_record_sha256,
                        "prior_final_id": prior_final_id,
                        "prior_final_record_sha256": prior_final_sha256,
                        "prior_role": require_text(
                            prior_role.get("primary"),
                            f"final[{sample_id}].role.primary",
                        ),
                        "previous_master_orientation": previous_orientation,
                        "prior_orientation": prior_orientation,
                        "orientation_changed": previous_orientation
                        != prior_orientation,
                        "selection_reason": "prior_none_acceptable",
                    }
                )
            )
            found.add(sample_id)
    missing = sorted(set(prior_by_sample) - found)
    if missing:
        raise RescueInputError(
            f"selected samples are absent from master: {missing[:8]}"
        )
    order = sorted(
        range(len(master_rows)), key=lambda index: str(master_rows[index]["id"])
    )
    return [master_rows[index] for index in order], [
        selection_rows[index] for index in order
    ]


def _safe_artifact_path(value: Any) -> PurePosixPath:
    text = require_text(value, "render artifact.file")
    path = PurePosixPath(text)
    windows_path = PureWindowsPath(text)
    if (
        "\\" in text
        or path.is_absolute()
        or windows_path.is_absolute()
        or bool(windows_path.drive)
        or ".." in path.parts
        or not path.parts
    ):
        raise RescueInputError(f"unsafe render artifact path: {text}")
    return path


def _subset_render_bank(
    parent_manifest_path: Path,
    expanded_catalog_path: Path,
    new_font_ids: Sequence[str],
    *,
    specification_schema_version: str = SCHEMA_VERSION,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    parent = read_json(parent_manifest_path, "expanded render bank")
    if parent.get("schema_version") != "font-render-bank-v1":
        raise RescueInputError("expanded render bank schema is unsupported")
    source_contract = require_mapping(
        parent.get("source_contract"), "expanded render bank.source_contract"
    )
    if source_contract.get("manifest_sha256") != sha256_file(expanded_catalog_path):
        raise RescueInputError("expanded render bank does not bind expanded catalog")
    candidates_value = parent.get("candidates")
    renders_value = parent.get("renders")
    probes = parent.get("probe_bank")
    if not isinstance(candidates_value, list) or not isinstance(renders_value, list):
        raise RescueInputError(
            "expanded render bank candidate/render arrays are invalid"
        )
    if not isinstance(probes, list) or not probes:
        raise RescueInputError("expanded render bank probe bank is invalid")
    wanted = set(new_font_ids)
    candidates = [
        copy.deepcopy(dict(require_mapping(value, "expanded candidate")))
        for value in candidates_value
        if isinstance(value, Mapping)
        and value.get("font_id") in wanted
        and value.get("production_400_normal_canonical") is True
    ]
    if {str(value.get("font_id")) for value in candidates} != wanted:
        raise RescueInputError("new families do not each have one canonical candidate")
    if len(candidates) != len(new_font_ids):
        raise RescueInputError("new families have duplicate canonical candidates")
    display_id_values: list[str] = []
    blind_aliases: list[str] = []
    for index, candidate in enumerate(candidates):
        location = f"expanded candidate[{index}]"
        if (
            candidate.get("render_weight") != 400
            or candidate.get("render_style") != "normal"
        ):
            raise RescueInputError(
                f"{location}: canonical candidate is not production 400 normal"
            )
        display_id_values.append(
            require_text(candidate.get("display_id"), f"{location}.display_id")
        )
        blind_aliases.append(
            require_text(candidate.get("blind_alias"), f"{location}.blind_alias")
        )
    if len(display_id_values) != len(set(display_id_values)):
        raise RescueInputError("new canonical candidates must have unique display IDs")
    if len(blind_aliases) != len(set(blind_aliases)):
        raise RescueInputError(
            "new canonical candidates must have unique blind aliases"
        )
    display_ids = set(display_id_values)
    renders = [
        copy.deepcopy(dict(require_mapping(value, "expanded render")))
        for value in renders_value
        if isinstance(value, Mapping)
        and value.get("candidate_display_id") in display_ids
    ]
    probe_ids = [
        require_text(require_mapping(value, "probe").get("id"), "probe.id")
        for value in probes
    ]
    if len(probe_ids) != len(set(probe_ids)):
        raise RescueInputError("expanded render bank probe IDs are duplicated")
    expected_keys = {
        (display_id, probe_id, mode)
        for display_id in display_ids
        for probe_id in probe_ids
        for mode in ("horizontal", "vertical")
    }
    observed_keys: set[tuple[str, str, str]] = set()
    render_ids: set[str] = set()
    for index, render in enumerate(renders):
        location = f"expanded render[{index}]"
        key = (
            require_text(
                render.get("candidate_display_id"),
                f"{location}.candidate_display_id",
            ),
            require_text(render.get("probe_id"), f"{location}.probe_id"),
            require_text(render.get("writing_mode"), f"{location}.writing_mode"),
        )
        if key in observed_keys:
            raise RescueInputError("new candidate render matrix contains a duplicate")
        observed_keys.add(key)
        render_id = require_text(render.get("render_id"), f"{location}.render_id")
        if render_id in render_ids:
            raise RescueInputError("new candidate render IDs are duplicated")
        render_ids.add(render_id)
        if render.get("font_weight") != 400 or render.get("font_style") != "normal":
            raise RescueInputError(
                f"{location}: canonical render is not production 400 normal"
            )
    if observed_keys != expected_keys:
        raise RescueInputError(
            "new candidate render matrix is incomplete or duplicated"
        )
    artifact_bytes: dict[str, bytes] = {}
    artifact_paths: set[PurePosixPath] = set()
    for index, render in enumerate(renders):
        location = f"expanded render[{index}]"
        artifact = require_mapping(render.get("artifact"), f"{location}.artifact")
        readiness = require_mapping(render.get("readiness"), f"{location}.readiness")
        fallback = require_mapping(
            render.get("fallback_detection"), f"{location}.fallback_detection"
        )
        if (
            readiness.get("document_fonts_ready") is not True
            or readiness.get("font_check_passed") is not True
            or readiness.get("production_font_check_passed") is not True
            or readiness.get("content_fits") is not True
            or fallback.get("status") != "passed"
        ):
            raise RescueInputError(
                "new candidate render failed readiness/fallback gates"
            )
        if artifact.get("qa_overlay") is not False:
            raise RescueInputError("new candidate render contains a QA overlay")
        relative = _safe_artifact_path(artifact.get("file"))
        if relative in artifact_paths:
            raise RescueInputError("new candidate render artifact paths are duplicated")
        artifact_paths.add(relative)
        source = parent_manifest_path.parent.joinpath(*relative.parts)
        expected_sha = require_sha(
            artifact.get("sha256"), f"{location}.artifact.sha256"
        )
        if not source.is_file() or sha256_file(source) != expected_sha:
            raise RescueInputError(f"render artifact is missing or stale: {relative}")
        artifact_bytes[f"{RENDER_BANK_DIR}/{relative.as_posix()}"] = source.read_bytes()
    parent_sha = sha256_file(parent_manifest_path)
    specification_sha = stable_hash(
        specification_schema_version,
        parent_sha,
        *new_font_ids,
        *(
            require_text(value.get("render_id"), "render.render_id")
            for value in renders
        ),
    )
    manifest = {
        "schema_version": "font-render-bank-v1",
        "deterministic_specification": True,
        "specification_sha256": specification_sha,
        "inputs": [
            {
                "path": "expanded-render-bank/manifest.json",
                "sha256": parent_sha,
            },
            {
                "path": "expanded-font-catalog/manifest.json",
                "sha256": sha256_file(expanded_catalog_path),
            },
        ],
        "source_contract": copy.deepcopy(dict(source_contract)),
        "renderer": copy.deepcopy(parent.get("renderer")),
        "candidate_identity_contract": copy.deepcopy(
            parent.get("candidate_identity_contract")
        ),
        "render_spec": copy.deepcopy(parent.get("render_spec")),
        "probe_bank": copy.deepcopy(probes),
        "generation": {
            "limit": None,
            "partial": False,
            "expected_render_count": len(renders),
            "full_render_count": len(renders),
            "production_asset_omitted_render_count": 0,
            "complete_against_production_assets": True,
            "rendered_count": len(renders),
            "derived_from_manifest_sha256": parent_sha,
            "selection": "new-canonical-families-only",
        },
        "family_count": len(new_font_ids),
        "face_count": len({str(value.get("face_id")) for value in candidates}),
        "candidate_count": len(candidates),
        "rendered_candidate_count": len(display_ids),
        "candidates": candidates,
        "renders": renders,
    }
    return manifest, artifact_bytes


def _artifact_descriptor(
    document: Mapping[str, Any], name: str, location: str
) -> Mapping[str, Any]:
    artifacts = require_mapping(document.get("artifacts"), f"{location}.artifacts")
    return require_mapping(artifacts.get(name), f"{location}.artifacts[{name}]")


def _validate_file_descriptor(
    descriptor: Mapping[str, Any], path: Path, location: str
) -> int:
    if descriptor.get("file") != path.name:
        raise RescueInputError(f"{location}: unexpected artifact filename")
    expected_sha = require_sha(descriptor.get("sha256"), f"{location}.sha256")
    if not path.is_file() or sha256_file(path) != expected_sha:
        raise RescueInputError(f"{location}: artifact is missing or stale")
    byte_size = require_nonnegative_int(
        descriptor.get("byte_size"), f"{location}.byte_size"
    )
    if path.stat().st_size != byte_size:
        raise RescueInputError(f"{location}: artifact byte size is stale")
    return require_nonnegative_int(
        descriptor.get("record_count"), f"{location}.record_count"
    )


def _catalog_delta(
    legacy_catalog: Path,
    expanded_catalog: Path,
    *,
    expected_new_candidates: int,
) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    legacy_document = read_json(legacy_catalog, "legacy catalog")
    expanded_document = read_json(expanded_catalog, "expanded catalog")
    legacy_ids = _catalog_family_ids(legacy_document, "legacy catalog")
    expanded_ids = _catalog_family_ids(expanded_document, "expanded catalog")
    if len(legacy_ids) != 15 or len(expanded_ids) != 22:
        raise RescueInputError(
            "v3 delta review requires the exact sealed 15-family and 22-family catalogs"
        )
    if not set(legacy_ids) < set(expanded_ids):
        raise RescueInputError("expanded catalog is not a strict legacy superset")
    legacy_set = set(legacy_ids)
    new_ids = [font_id for font_id in expanded_ids if font_id not in legacy_set]
    if len(new_ids) != expected_new_candidates or expected_new_candidates != 7:
        raise RescueInputError(
            f"v3 delta review requires exactly 7 new candidates, got {len(new_ids)}"
        )
    return legacy_document, expanded_document, legacy_ids, new_ids


def _validate_blind_render_identity(
    render_bank_manifest: Path,
    *,
    expanded_catalog: Path,
    expanded_ids: Sequence[str],
    new_ids: Sequence[str],
) -> dict[str, str]:
    document = read_json(render_bank_manifest, "expanded render bank")
    source_contract = require_mapping(
        document.get("source_contract"), "expanded render bank.source_contract"
    )
    if source_contract.get("manifest_sha256") != sha256_file(expanded_catalog):
        raise RescueInputError("expanded render bank does not bind expanded catalog")
    identity_contract = require_mapping(
        document.get("candidate_identity_contract"),
        "expanded render bank.candidate_identity_contract",
    )
    if (
        identity_contract.get("blind_alias_field") != "blind_alias"
        or identity_contract.get("image_paths_expose_font_identity") is not False
    ):
        raise RescueInputError("expanded render bank blind identity contract is unsafe")
    candidates = document.get("candidates")
    if not isinstance(candidates, list):
        raise RescueInputError("expanded render bank candidates are invalid")
    canonical: dict[str, Mapping[str, Any]] = {}
    aliases: set[str] = set()
    for index, value in enumerate(candidates):
        candidate = require_mapping(value, f"expanded candidate[{index}]")
        if candidate.get("production_400_normal_canonical") is not True:
            continue
        font_id = require_text(
            candidate.get("font_id"), f"expanded candidate[{index}].font_id"
        )
        if font_id in canonical:
            raise RescueInputError("expanded render bank repeats a canonical family")
        alias = require_text(
            candidate.get("blind_alias"), f"expanded candidate[{index}].blind_alias"
        )
        if alias in aliases:
            raise RescueInputError("expanded render bank blind aliases are duplicated")
        if (
            font_id.casefold() in alias.casefold()
            or alias.casefold() == font_id.casefold()
        ):
            raise RescueInputError(
                "expanded render bank blind alias exposes font identity"
            )
        canonical[font_id] = candidate
        aliases.add(alias)
    if set(canonical) != set(expanded_ids):
        raise RescueInputError(
            "expanded render bank must contain exactly one canonical face per family"
        )
    return {
        font_id: require_text(canonical[font_id].get("blind_alias"), "blind_alias")
        for font_id in new_ids
    }


def _load_delta_source(
    *,
    training_export_dir: Path,
    prior_final_labels: Path,
    catalog_registry: Path,
    master_manifest: Path,
    master_report: Path,
    master_split_map: Path,
    legacy_catalog_sha256: str,
    legacy_font_ids: Sequence[str],
    expected_samples: int,
    expected_invalidated: int,
) -> dict[str, Any]:
    marker_path = training_export_dir / TRAINING_EXPORT_MARKER
    manifest_path = training_export_dir / "manifest.json"
    report_path = training_export_dir / "report.json"
    samples_path = training_export_dir / "samples.jsonl"
    marker = read_json(marker_path, "training export marker")
    manifest = read_json(manifest_path, "training export manifest")
    report = read_json(report_path, "training export report")
    if (
        marker.get("owner") != TRAINING_EXPORT_OWNER
        or marker.get("schema_version") != TRAINING_EXPORT_SCHEMA
        or marker.get("safe_replace") is not True
    ):
        raise RescueInputError("training export ownership marker is invalid")
    manifest_sha256 = sha256_file(manifest_path)
    report_sha256 = sha256_file(report_path)
    if (
        marker.get("manifest_sha256") != manifest_sha256
        or marker.get("report_sha256") != report_sha256
    ):
        raise RescueInputError("training export marker hashes are stale")
    if manifest.get("schema_version") != TRAINING_EXPORT_SCHEMA:
        raise RescueInputError("training export manifest schema is unsupported")
    if report.get("schema_version") != TRAINING_EXPORT_REPORT_SCHEMA:
        raise RescueInputError("training export report schema is unsupported")
    if report.get("manifest_sha256") != manifest_sha256:
        raise RescueInputError("training export report does not bind its manifest")
    sample_descriptor = _artifact_descriptor(
        manifest, "samples.jsonl", "training export manifest"
    )
    descriptor_count = _validate_file_descriptor(
        sample_descriptor, samples_path, "training export samples"
    )
    report_outputs = require_mapping(
        report.get("outputs"), "training export report.outputs"
    )
    if report_outputs.get("samples.jsonl") != sample_descriptor:
        raise RescueInputError("training export report samples descriptor differs")
    if descriptor_count != expected_samples:
        raise RescueInputError(
            f"expected {expected_samples} active export samples, got {descriptor_count}"
        )
    if manifest.get("real_sample_count") != expected_samples:
        raise RescueInputError("training export manifest active count is stale")
    if manifest.get("candidate_count") != len(legacy_font_ids):
        raise RescueInputError("training export legacy candidate count is stale")

    summary = require_mapping(report.get("summary"), "training export report.summary")
    checks = require_mapping(report.get("checks"), "training export report.checks")
    if summary.get("sample_count") != expected_samples:
        raise RescueInputError("training export report active count is stale")
    if summary.get("candidate_count") != len(legacy_font_ids):
        raise RescueInputError("training export report candidate count is stale")
    if (
        checks.get("successor_label_inheritance_count") != 0
        or checks.get("core_qa_overlay_count") != 0
        or checks.get("core_synthetic_count") != 0
    ):
        raise RescueInputError(
            "training export permits successor inheritance, QA overlays, or synthetic rows"
        )

    input_hashes = require_mapping(
        manifest.get("input_hashes"), "training export manifest.input_hashes"
    )
    actual_registry_sha256 = sha256_file(catalog_registry)
    actual_master_sha256 = sha256_file(master_manifest)
    actual_master_report_sha256 = sha256_file(master_report)
    actual_split_map_sha256 = sha256_file(master_split_map)
    actual_final_sha256 = sha256_file(prior_final_labels)
    required_hashes = {
        "catalog_registry_sha256": actual_registry_sha256,
        "font_catalog_sha256": legacy_catalog_sha256,
        "master_manifest_sha256": actual_master_sha256,
        "master_report_sha256": actual_master_report_sha256,
        "master_split_map_sha256": actual_split_map_sha256,
        "finals_sha256": actual_final_sha256,
    }
    for name, actual in required_hashes.items():
        if input_hashes.get(name) != actual:
            raise RescueInputError(f"training export input binding is stale: {name}")

    registry = read_json(catalog_registry, "catalog registry")
    if registry.get("schema_version") != CATALOG_REGISTRY_SCHEMA:
        raise RescueInputError("catalog registry schema is unsupported")
    registry_record_sha256 = require_sealed_record(registry, "catalog registry")
    exclusions = require_mapping(
        manifest.get("registry_exclusions"),
        "training export manifest.registry_exclusions",
    )
    if (
        exclusions.get("catalog_registry_sha256") != actual_registry_sha256
        or exclusions.get("excluded_final_count") != expected_invalidated
        or exclusions.get("ids_digest_algorithm") != "sha256-sorted-lf-utf8-v1"
    ):
        raise RescueInputError("training export invalidation binding is stale")
    if report.get("registry_exclusions") != dict(exclusions) | {
        "parent_workspace_projection": True
    }:
        raise RescueInputError("training export report invalidation binding differs")
    if summary.get("excluded_final_count") != expected_invalidated:
        raise RescueInputError("training export invalidated final count is stale")

    binding = require_mapping(
        manifest.get("master_registry_binding"),
        "training export manifest.master_registry_binding",
    )
    attestation = require_mapping(binding.get("attestation"), "master attestation")
    attested_registry = require_mapping(
        attestation.get("catalog_registry"), "master attestation.catalog_registry"
    )
    if (
        binding.get("mode") != "registry_parent_workspace_projection"
        or binding.get("successor_label_inheritance_allowed") is not False
        or binding.get("master_report_sha256") != actual_master_report_sha256
        or binding.get("master_split_map_sha256") != actual_split_map_sha256
        or attested_registry.get("sha256") != actual_registry_sha256
        or attested_registry.get("record_sha256") != registry_record_sha256
    ):
        raise RescueInputError("training export master/registry attestation is stale")

    master_report_document = read_json(master_report, "master-v2 report")
    master_outputs = require_mapping(
        master_report_document.get("outputs"), "master-v2 report.outputs"
    )
    master_inputs = require_mapping(
        master_report_document.get("inputs"), "master-v2 report.inputs"
    )
    master_attestation = require_mapping(
        master_inputs.get("attestation"), "master-v2 report.inputs.attestation"
    )
    master_attested_registry = require_mapping(
        master_attestation.get("catalog_registry"),
        "master-v2 report catalog registry",
    )
    if (
        master_outputs.get("master_manifest_sha256") != actual_master_sha256
        or master_outputs.get("split_map_sha256") != actual_split_map_sha256
        or master_attested_registry.get("sha256") != actual_registry_sha256
        or master_attested_registry.get("record_sha256") != registry_record_sha256
    ):
        raise RescueInputError("master-v2 report binding is stale")
    split_map = read_json(master_split_map, "master-v2 split map")
    work_assignments = require_mapping(
        split_map.get("work_assignments"), "master-v2 split map.work_assignments"
    )
    manifest_work_split = require_mapping(
        manifest.get("work_split"), "training export manifest.work_split"
    )
    if dict(work_assignments) != dict(manifest_work_split):
        raise RescueInputError("training export and master-v2 split maps differ")

    final_by_sample: dict[str, dict[str, Any]] = {}
    for index, final in enumerate(read_jsonl(prior_final_labels, "prior finals"), 1):
        try:
            labels.validate_final_record(final)
        except labels.LabelValidationError as error:
            raise RescueInputError(f"prior finals:{index}: {error}") from error
        sample_id = require_text(
            final.get("sample_id"), f"prior finals:{index}.sample_id"
        )
        if sample_id in final_by_sample:
            raise RescueInputError(
                f"prior finals:{index}: duplicate sample {sample_id}"
            )
        resolution = require_mapping(
            final.get("resolution"), f"prior finals:{index}.resolution"
        )
        if resolution.get("catalog_sha256") != legacy_catalog_sha256:
            raise RescueInputError("prior final does not bind the legacy catalog")
        final_by_sample[sample_id] = final

    samples: list[dict[str, Any]] = []
    sample_ids: set[str] = set()
    legacy_set = set(legacy_font_ids)
    split_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    work_counts: Counter[str] = Counter()
    for index, sample in enumerate(read_jsonl(samples_path, "training samples"), 1):
        if sample.get("schema_version") != TRAINING_SAMPLE_SCHEMA:
            raise RescueInputError(f"training samples:{index}: unsupported schema")
        sample_record_sha256 = require_sealed_record(
            sample, f"training samples:{index}"
        )
        sample_id = require_text(
            sample.get("sample_id"), f"training samples:{index}.sample_id"
        )
        if sample_id in sample_ids:
            raise RescueInputError(f"training samples:{index}: duplicate sample")
        sample_ids.add(sample_id)
        final = final_by_sample.get(sample_id)
        if final is None:
            raise RescueInputError(f"training sample lacks prior final: {sample_id}")
        review_provenance = require_mapping(
            sample.get("review_provenance"), f"training[{sample_id}].review_provenance"
        )
        if review_provenance.get("final_record_sha256") != final.get("record_sha256"):
            raise RescueInputError(f"training[{sample_id}] prior final hash mismatch")
        for field in (
            "role",
            "source_style",
            "treatment",
            "font_judgment",
            "consistency",
        ):
            if sample.get(field) != final.get(field):
                raise RescueInputError(
                    f"training[{sample_id}] differs from prior final field {field}"
                )
        if review_provenance.get("resolution") != final.get("resolution"):
            raise RescueInputError(
                f"training[{sample_id}] differs from prior final resolution"
            )
        source = require_mapping(sample.get("source"), f"training[{sample_id}].source")
        if sample.get("work_id") != final.get("work_id") or source.get(
            "source_page_sha256"
        ) != final.get("source_page_sha256"):
            raise RescueInputError(f"training[{sample_id}] prior final source mismatch")
        provenance = require_mapping(
            sample.get("provenance"), f"training[{sample_id}].provenance"
        )
        if (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise RescueInputError(f"training[{sample_id}] is QA-only or synthetic")
        bindings = require_mapping(
            sample.get("input_bindings"), f"training[{sample_id}].input_bindings"
        )
        for name, expected in (
            ("catalog_registry_sha256", actual_registry_sha256),
            ("font_catalog_sha256", legacy_catalog_sha256),
            ("master_manifest_sha256", actual_master_sha256),
        ):
            if bindings.get(name) != expected:
                raise RescueInputError(f"training[{sample_id}] stale binding {name}")
        judgment = require_mapping(
            sample.get("font_judgment"), f"training[{sample_id}].font_judgment"
        )
        judged: list[str] = []
        for tier in PRIOR_TIER_FIELDS:
            values = judgment.get(tier)
            if not isinstance(values, list) or any(
                not isinstance(value, str) for value in values
            ):
                raise RescueInputError(f"training[{sample_id}] invalid tier {tier}")
            judged.extend(values)
        if len(judged) != len(set(judged)) or set(judged) != legacy_set:
            raise RescueInputError(
                f"training[{sample_id}] does not cover the sealed 15-family catalog"
            )
        if judgment.get("not_reviewed") != []:
            raise RescueInputError(f"training[{sample_id}] has unfinished old tiers")
        work_id = require_text(sample.get("work_id"), f"training[{sample_id}].work_id")
        split = require_text(sample.get("split"), f"training[{sample_id}].split")
        if (
            split not in {"train", "val", "test"}
            or manifest_work_split.get(work_id) != split
        ):
            raise RescueInputError(f"training[{sample_id}] split binding mismatch")
        role = require_text(
            require_mapping(sample.get("role"), f"training[{sample_id}].role").get(
                "primary"
            ),
            f"training[{sample_id}].role.primary",
        )
        split_counts[split] += 1
        role_counts[role] += 1
        work_counts[work_id] += 1
        # Retain the verified SHA even if callers deep-copy the record later.
        sample["record_sha256"] = sample_record_sha256
        samples.append(sample)
    if len(samples) != descriptor_count:
        raise RescueInputError("training export samples descriptor count is stale")

    excluded_sample_ids = set(final_by_sample) - sample_ids
    if len(excluded_sample_ids) != expected_invalidated:
        raise RescueInputError(
            "active export sample set does not exclude the declared invalidated finals"
        )
    excluded_digest = sorted_ids_sha256(excluded_sample_ids)
    if exclusions.get("excluded_final_ids_sha256") != excluded_digest:
        raise RescueInputError("invalidated final ID digest is stale")
    if summary.get("completed_final_count") != len(final_by_sample):
        raise RescueInputError("training export completed final count is stale")
    report_split = require_mapping(
        summary.get("by_split"), "training export report.summary.by_split"
    )
    if dict(sorted(split_counts.items())) != dict(sorted(report_split.items())):
        raise RescueInputError("training export split aggregates are stale")

    return {
        "marker_path": marker_path,
        "manifest_path": manifest_path,
        "report_path": report_path,
        "samples_path": samples_path,
        "marker": marker,
        "manifest": manifest,
        "report": report,
        "samples": samples,
        "final_by_sample": {
            sample_id: final_by_sample[sample_id] for sample_id in sample_ids
        },
        "excluded_sample_ids": excluded_sample_ids,
        "split_counts": split_counts,
        "role_counts": role_counts,
        "work_counts": work_counts,
        "hashes": {
            "training_export_marker_sha256": sha256_file(marker_path),
            "training_export_manifest_sha256": manifest_sha256,
            "training_export_report_sha256": report_sha256,
            "training_export_samples_sha256": sha256_file(samples_path),
            "prior_final_labels_sha256": actual_final_sha256,
            "catalog_registry_sha256": actual_registry_sha256,
            "catalog_registry_record_sha256": registry_record_sha256,
            "master_manifest_sha256": actual_master_sha256,
            "master_report_sha256": actual_master_report_sha256,
            "master_split_map_sha256": actual_split_map_sha256,
        },
    }


def _filter_active_master_v3(
    master_manifest: Path,
    samples: Sequence[Mapping[str, Any]],
    final_by_sample: Mapping[str, Mapping[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    sample_by_id = {
        require_text(sample.get("sample_id"), "training sample.sample_id"): sample
        for sample in samples
    }
    masters: dict[str, dict[str, Any]] = {}
    bindings: dict[str, dict[str, Any]] = {}
    try:
        handle = master_manifest.open("r", encoding="utf-8")
    except OSError as error:
        raise RescueInputError(
            f"master-v2 manifest could not be opened: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(
                    require_mapping(
                        json.loads(line), f"master-v2 manifest:{line_number}"
                    )
                )
            except json.JSONDecodeError as error:
                raise RescueInputError(
                    f"master-v2 manifest:{line_number}: invalid JSON: {error}"
                ) from error
            sample_id = require_text(row.get("id"), f"master-v2:{line_number}.id")
            sample = sample_by_id.get(sample_id)
            if sample is None:
                continue
            if sample_id in masters:
                raise RescueInputError(f"master-v2 repeats active sample {sample_id}")
            final = final_by_sample[sample_id]
            provenance = require_mapping(
                row.get("provenance"), f"master-v2[{sample_id}].provenance"
            )
            if (
                provenance.get("qa_overlay") is not False
                or provenance.get("synthetic") is not False
            ):
                raise RescueInputError(
                    f"master-v2[{sample_id}] is QA-only or synthetic"
                )
            source = require_mapping(
                sample.get("source"), f"training[{sample_id}].source"
            )
            work = require_mapping(row.get("work"), f"master-v2[{sample_id}].work")
            chapter = require_mapping(
                row.get("chapter"), f"master-v2[{sample_id}].chapter"
            )
            page = require_mapping(row.get("page"), f"master-v2[{sample_id}].page")
            if (
                work.get("id") != sample.get("work_id")
                or chapter.get("id") != sample.get("chapter_id")
                or page.get("id") != sample.get("page_id")
                or page.get("source_page_sha256") != source.get("source_page_sha256")
                or row.get("sample_crop_sha256") != source.get("sample_crop_sha256")
                or row.get("geometry") != source.get("geometry")
                or row.get("views") != source.get("views")
                or row.get("split") != sample.get("split")
                or provenance
                != require_mapping(
                    require_mapping(
                        sample.get("provenance"), f"training[{sample_id}].provenance"
                    ).get("master"),
                    f"training[{sample_id}].provenance.master",
                )
            ):
                raise RescueInputError(
                    f"master-v2[{sample_id}] export projection mismatch"
                )
            treatment = require_mapping(
                final.get("treatment"), f"prior final[{sample_id}].treatment"
            )
            orientation = require_text(
                treatment.get("orientation"),
                f"prior final[{sample_id}].treatment.orientation",
            )
            source_master_record_sha256 = sha256_bytes(json_bytes(row))
            previous_metadata = require_mapping(
                row.get("metadata", {}), f"master-v2[{sample_id}].metadata"
            )
            review_orientation = orientation
            orientation_source = "prior_final_human_orientation"
            if review_orientation not in {"horizontal", "vertical"}:
                review_orientation = require_text(
                    previous_metadata.get("orientation"),
                    f"master-v2[{sample_id}].metadata.orientation",
                )
                orientation_source = "master_visual_orientation_fallback"
            if review_orientation not in {"horizontal", "vertical"}:
                raise RescueInputError(
                    f"master-v2[{sample_id}] lacks a renderable review orientation"
                )
            sanitized = copy.deepcopy(row)
            sanitized.pop("split", None)
            sanitized.pop("legacy_split", None)
            sanitized.pop("font_label", None)
            sanitized["metadata"] = {
                "orientation": review_orientation,
                "catalog_delta_review": {
                    "human_reviewed_orientation": True,
                    "previous_orientation": previous_metadata.get("orientation"),
                    "prior_treatment_orientation": orientation,
                    "review_orientation_source": orientation_source,
                    "prior_final_record_sha256": final.get("record_sha256"),
                    "source_master_record_sha256": source_master_record_sha256,
                    "split_hidden_from_review_surface": True,
                    "model_suggestions_visible": False,
                },
            }
            masters[sample_id] = sanitized
            bindings[sample_id] = {
                "source_master_line_number": line_number,
                "source_master_record_sha256": source_master_record_sha256,
            }
    missing = sorted(set(sample_by_id) - set(masters))
    if missing:
        raise RescueInputError(
            f"active export samples are absent from master-v2: {missing[:8]}"
        )
    return masters, bindings


def _manual_recrop(sample: Mapping[str, Any]) -> bool:
    provenance = require_mapping(sample.get("provenance"), "training sample.provenance")
    master = require_mapping(
        provenance.get("master"), "training sample.provenance.master"
    )
    source_catalog_id = str(master.get("source_catalog_id", "")).casefold()
    if (
        source_catalog_id == "fontclip-recrop-accepted-v1"
        or source_catalog_id.startswith("fontclip-recrop-")
    ):
        return True
    lineage = master.get("source_lineage")
    if isinstance(lineage, list) and any(
        isinstance(value, Mapping)
        and (
            value.get("manual_recrop") is True
            or "recrop" in str(value.get("tool", "")).casefold()
        )
        for value in lineage
    ):
        return True
    review_provenance = require_mapping(
        sample.get("review_provenance", {}), "training sample.review_provenance"
    )
    resolution = require_mapping(
        review_provenance.get("resolution", {}),
        "training sample.review_provenance.resolution",
    )
    if "manual_recrop_resolved" in resolution.get("flags", []):
        return True
    source_reviews = review_provenance.get("source_reviews", [])
    if isinstance(source_reviews, list):
        return any(
            isinstance(review, Mapping) and "manual_recrop" in review.get("flags", [])
            for review in source_reviews
        )
    return False


def _style_score(sample: Mapping[str, Any], field: str) -> float:
    style = require_mapping(sample.get("source_style"), "training sample.source_style")
    value = style.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value)


def _source_family_override(sample: Mapping[str, Any]) -> bool:
    consistency = require_mapping(
        sample.get("consistency"), "training sample.consistency"
    )
    return (
        consistency.get("policy") == "intentional_override"
        or consistency.get("action") == "local_override"
    )


def _priority_for_sample(
    sample: Mapping[str, Any],
    *,
    eligibility_risk_reasons: Sequence[str] | None = None,
) -> tuple[int, str, list[str]]:
    judgment = require_mapping(sample.get("font_judgment"), "font_judgment")
    if eligibility_risk_reasons is None:
        eligibility_risk_reasons = _font_signal_audit_reasons(sample)
    priority_0_reasons: list[str] = []
    if judgment.get("none_acceptable") is True:
        priority_0_reasons.append("prior_none_acceptable")
    if eligibility_risk_reasons:
        priority_0_reasons.append("font_signal_eligibility_risk")
    if priority_0_reasons:
        return 0, "priority_0", sorted(set(priority_0_reasons))
    role = require_text(
        require_mapping(sample.get("role"), "role").get("primary"), "role.primary"
    )
    reasons: list[str] = []
    if role in VARIANT_SECONDARY_ROLES:
        reasons.append(role)
    if _style_score(sample, "handwritten") >= HIGH_VARIANT_STYLE_THRESHOLD:
        reasons.append("handwritten")
    if _style_score(sample, "irregularity") >= HIGH_VARIANT_STYLE_THRESHOLD:
        reasons.append("irregular")
    if _manual_recrop(sample):
        reasons.append("manual_recrop")
    if _source_family_override(sample):
        reasons.append("source_family_override")
    if reasons:
        return 1, "priority_1", sorted(set(reasons))
    return 2, "priority_2", ["ordinary"]


def _font_signal_audit_reasons(sample: Mapping[str, Any]) -> list[str]:
    sample_id = require_text(sample.get("sample_id"), "training sample.sample_id")
    style = require_mapping(sample.get("source_style"), "source_style")
    unknown_fields = style.get("unknown_fields")
    if not isinstance(unknown_fields, list):
        raise RescueInputError(f"training[{sample_id}] unknown_fields is invalid")
    unknown_count = len(unknown_fields)
    judgment = require_mapping(sample.get("font_judgment"), "font_judgment")
    reasons: list[str] = []
    if unknown_count >= 5:
        reasons.append("style_unknown_fields_at_least_5")
    if judgment.get("none_acceptable") is True and unknown_count >= 3:
        reasons.append("prior_none_with_at_least_3_unknown_style_fields")
    if sample_id in KNOWN_FONT_SIGNAL_AUDIT_SAMPLE_IDS:
        reasons.append("known_punctuation_only_exclusion_signal")
    return reasons


def _interleave_by_work(
    rows: Sequence[dict[str, Any]], *, seed: str
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        work_id = require_text(row.get("work_id"), "queue row.work_id")
        grouped.setdefault(work_id, []).append(row)
    for work_id, values in grouped.items():
        values.sort(
            key=lambda row: (
                stable_hash(seed, "sample", work_id, str(row["sample_id"])),
                str(row["sample_id"]),
            )
        )
    work_order = sorted(
        grouped, key=lambda work_id: (stable_hash(seed, "work", work_id), work_id)
    )
    output: list[dict[str, Any]] = []
    round_index = 0
    while True:
        added = False
        for work_id in work_order:
            values = grouped[work_id]
            if round_index < len(values):
                output.append(values[round_index])
                added = True
        if not added:
            break
        round_index += 1
    return output


def _priority_interleaved(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for priority in (0, 1, 2):
        output.extend(
            _interleave_by_work(
                [row for row in rows if row["priority_rank"] == priority],
                seed=f"font-catalog-delta-review-v3-priority-{priority}",
            )
        )
    return output


def _secondary_sample_ids(rows: Sequence[dict[str, Any]]) -> tuple[set[str], set[str]]:
    mandatory: set[str] = set()
    remaining_by_work: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        priority_rank = require_nonnegative_int(
            row.get("priority_rank"), "queue row.priority_rank"
        )
        if priority_rank > 2:
            raise RescueInputError("queue row priority_rank is outside 0..2")
        sample_id = str(row["sample_id"])
        if priority_rank <= MANDATORY_SECONDARY_MAX_PRIORITY:
            mandatory.add(sample_id)
        else:
            remaining_by_work.setdefault(str(row["work_id"]), []).append(row)
    sampled: set[str] = set()
    for work_id, values in sorted(remaining_by_work.items()):
        ordered = sorted(
            values,
            key=lambda row: (
                stable_hash(
                    "font-catalog-delta-review-v3-secondary-20-percent",
                    work_id,
                    str(row["sample_id"]),
                ),
                str(row["sample_id"]),
            ),
        )
        count = math.ceil(len(ordered) * SECONDARY_SAMPLE_RATE)
        sampled.update(str(row["sample_id"]) for row in ordered[:count])
    return mandatory, sampled


def _candidate_order(font_ids: Sequence[str], seed: str) -> list[str]:
    return sorted(
        font_ids,
        key=lambda font_id: (
            stable_hash("manga-font-candidate-rank-v1", seed, font_id),
            font_id,
        ),
    )


def _assignment_id(assignment: Mapping[str, Any]) -> str:
    digest = stable_hash(
        "manga-font-review-assignment-v1",
        str(assignment["sample_id"]),
        str(assignment["stage"]),
        str(assignment["catalog_version"]),
        str(assignment["candidate_order_seed"]),
        *(str(value) for value in assignment["candidate_order"]),
    )
    return f"fmra-{digest[:32]}"


def build_delta_files(
    *,
    training_export_dir: Path,
    prior_final_labels: Path,
    master_manifest: Path,
    master_report: Path,
    master_split_map: Path,
    catalog_registry: Path,
    legacy_catalog: Path,
    expanded_catalog: Path,
    expanded_render_bank: Path,
    expected_samples: int,
    expected_invalidated: int,
    expected_new_candidates: int,
) -> dict[str, bytes]:
    (
        _legacy_document,
        expanded_document,
        legacy_ids,
        new_ids,
    ) = _catalog_delta(
        legacy_catalog,
        expanded_catalog,
        expected_new_candidates=expected_new_candidates,
    )
    legacy_catalog_sha256 = sha256_file(legacy_catalog)
    source = _load_delta_source(
        training_export_dir=training_export_dir,
        prior_final_labels=prior_final_labels,
        catalog_registry=catalog_registry,
        master_manifest=master_manifest,
        master_report=master_report,
        master_split_map=master_split_map,
        legacy_catalog_sha256=legacy_catalog_sha256,
        legacy_font_ids=legacy_ids,
        expected_samples=expected_samples,
        expected_invalidated=expected_invalidated,
    )
    samples = source["samples"]
    final_by_sample = source["final_by_sample"]
    masters_by_id, master_bindings = _filter_active_master_v3(
        master_manifest, samples, final_by_sample
    )
    aliases = _validate_blind_render_identity(
        expanded_render_bank,
        expanded_catalog=expanded_catalog,
        expanded_ids=[*legacy_ids, *new_ids],
        new_ids=new_ids,
    )
    delta_bank, image_files = _subset_render_bank(
        expanded_render_bank,
        expanded_catalog,
        new_ids,
        specification_schema_version=DELTA_SCHEMA_VERSION,
    )
    if len(delta_bank["renders"]) != 140:
        raise RescueInputError(
            f"v3 delta review requires exactly 140 new candidate renders, got {len(delta_bank['renders'])}"
        )

    queue_rows: list[dict[str, Any]] = []
    priority_counts: Counter[str] = Counter()
    priority_reason_counts: Counter[str] = Counter()
    audit_reason_counts: Counter[str] = Counter()
    for sample in samples:
        sample_id = str(sample["sample_id"])
        audit_reasons = _font_signal_audit_reasons(sample)
        priority_rank, priority_code, priority_reasons = _priority_for_sample(
            sample, eligibility_risk_reasons=audit_reasons
        )
        row = {
            "sample_id": sample_id,
            "work_id": str(sample["work_id"]),
            "sample": sample,
            "priority_rank": priority_rank,
            "priority_code": priority_code,
            "priority_reasons": priority_reasons,
            "audit_reasons": audit_reasons,
        }
        queue_rows.append(row)
        priority_counts[priority_code] += 1
        priority_reason_counts.update(priority_reasons)
        audit_reason_counts.update(audit_reasons)
    ordered = _priority_interleaved(queue_rows)
    if len(ordered) != expected_samples:
        raise RescueInputError("delta review queue lost active samples")
    if any(
        ordered[index]["priority_rank"] > ordered[index + 1]["priority_rank"]
        for index in range(len(ordered) - 1)
    ):
        raise RescueInputError("delta review queue priority ordering is invalid")
    mandatory_secondary, sampled_secondary = _secondary_sample_ids(ordered)
    secondary_ids = mandatory_secondary | sampled_secondary
    priority_ids = {
        priority: {
            str(row["sample_id"]) for row in ordered if row["priority_rank"] == priority
        }
        for priority in (0, 1, 2)
    }
    expected_mandatory_secondary = priority_ids[0] | priority_ids[1]
    if mandatory_secondary != expected_mandatory_secondary:
        raise RescueInputError(
            "mandatory secondary set must equal the complete priority 0/1 inventory"
        )
    missing_secondary_by_priority = {
        priority: priority_ids[priority] - secondary_ids for priority in (0, 1)
    }
    if any(missing_secondary_by_priority.values()):
        raise RescueInputError(
            "priority 0/1 samples are missing independent secondary review"
        )
    remaining_count = expected_samples - len(mandatory_secondary)
    if (
        remaining_count > 0
        and len(sampled_secondary) / remaining_count < SECONDARY_SAMPLE_RATE
    ):
        raise RescueInputError("deterministic secondary sample is below 20 percent")

    master_rows = [masters_by_id[str(row["sample_id"])] for row in ordered]
    master_payload = jsonl_bytes(master_rows)
    master_payload_sha256 = sha256_bytes(master_payload)
    selection_rows: list[dict[str, Any]] = []
    audit_rows: list[dict[str, Any]] = []
    assignment_rows: list[dict[str, Any]] = []
    ready_review_order = 0
    catalog_version = require_text(
        expanded_document.get("schema_version"), "expanded catalog.schema_version"
    )
    for review_order, queue_row in enumerate(ordered, 1):
        sample_id = str(queue_row["sample_id"])
        sample = require_mapping(queue_row["sample"], f"queue[{sample_id}].sample")
        final = final_by_sample[sample_id]
        master = masters_by_id[sample_id]
        work = require_mapping(master.get("work"), f"master[{sample_id}].work")
        page = require_mapping(master.get("page"), f"master[{sample_id}].page")
        audit_required = bool(queue_row["audit_reasons"])
        batches: dict[str, Any] = {}
        if not audit_required:
            ready_review_order += 1
            batches["pilot"] = {"review_order": ready_review_order}
        delta_judgment = {
            "preferred": [],
            "acceptable": [],
            "marginal": [],
            "unacceptable": [],
            "unrenderable": [],
            "not_reviewed": list(new_ids),
            "none_acceptable": None,
            "human_review_required": True,
            "automatic_tier_assignment_allowed": False,
        }
        selection_rows.append(
            seal(
                {
                    "schema_version": DELTA_SCHEMA_VERSION,
                    "record_type": DELTA_SELECTION_RECORD_TYPE,
                    "sample_id": sample_id,
                    "work_id": str(work["id"]),
                    "source_page_sha256": str(page["source_page_sha256"]),
                    "master_manifest_sha256": master_payload_sha256,
                    "review_order": review_order,
                    "priority": {
                        "rank": queue_row["priority_rank"],
                        "code": queue_row["priority_code"],
                        "reasons": queue_row["priority_reasons"],
                        "work_interleaved": True,
                        "split_used_for_ordering": False,
                    },
                    "batches": batches,
                    "font_signal_audit": {
                        "required": audit_required,
                        "status": (
                            "pending_human_audit" if audit_required else "not_required"
                        ),
                        "reasons": queue_row["audit_reasons"],
                        "automatic_absent_classification_allowed": False,
                    },
                    "new_7_candidate_judgment": delta_judgment,
                    "merge_provenance": {
                        "visibility": "merge_only_not_reviewer_surface",
                        "prior_catalog_candidate_count": len(legacy_ids),
                        "prior_catalog_sha256": legacy_catalog_sha256,
                        "prior_final_record_sha256": final["record_sha256"],
                        "prior_final_record": copy.deepcopy(final),
                        "training_sample_record_sha256": sample["record_sha256"],
                        **master_bindings[sample_id],
                    },
                    "provenance": {
                        "qa_overlay": False,
                        "synthetic": False,
                        "active_training_export_authoritative": True,
                    },
                    "review_surface": {
                        "font_names_visible": False,
                        "prior_tiers_visible": False,
                        "split_visible": False,
                        "model_suggestions_visible": False,
                        "candidate_identity": "blind_alias_only",
                    },
                }
            )
        )
        if audit_required:
            source_view = require_mapping(
                sample.get("source"), f"training[{sample_id}].source"
            )
            audit_rows.append(
                seal(
                    {
                        "schema_version": DELTA_SCHEMA_VERSION,
                        "record_type": "font_signal_identifiability_audit",
                        "sample_id": sample_id,
                        "work_id": str(work["id"]),
                        "chapter_id": sample.get("chapter_id"),
                        "page_id": sample.get("page_id"),
                        "source_page_sha256": page.get("source_page_sha256"),
                        "audit_order": len(audit_rows) + 1,
                        "status": "pending_human_audit",
                        "trigger_codes": queue_row["audit_reasons"],
                        "unknown_style_fields": copy.deepcopy(
                            require_mapping(
                                sample.get("source_style"), "source_style"
                            ).get("unknown_fields")
                        ),
                        "evidence": {
                            "geometry": copy.deepcopy(source_view.get("geometry")),
                            "views": copy.deepcopy(source_view.get("views")),
                            "source_page_locator": copy.deepcopy(
                                require_mapping(
                                    master.get("page"), f"master[{sample_id}].page"
                                ).get("source_locator")
                            ),
                        },
                        "decision_contract": {
                            "allowed_human_outcomes": [
                                "font_signal_present",
                                "font_signal_absent",
                                "needs_recrop",
                                "uncertain",
                            ],
                            "automatic_absent_classification_allowed": False,
                            "new_candidate_review_blocked_until_resolved": True,
                        },
                        "provenance": {
                            "qa_overlay": False,
                            "synthetic": False,
                            "training_sample_record_sha256": sample["record_sha256"],
                            "prior_final_record_sha256": final["record_sha256"],
                        },
                        "review_surface": {
                            "font_names_visible": False,
                            "prior_tiers_visible": False,
                            "split_visible": False,
                            "model_suggestions_visible": False,
                        },
                    }
                )
            )

        stages = ["primary"]
        if sample_id in secondary_ids:
            stages.append("secondary")
        for stage in stages:
            seed = stable_hash(
                "font-catalog-delta-review-v3-candidate-order",
                sample_id,
                stage,
                sha256_file(expanded_catalog),
            )
            order = _candidate_order(new_ids, seed)
            assignment: dict[str, Any] = {
                "schema_version": 1,
                "record_type": "manga_font_label_assignment",
                "sample_id": sample_id,
                "work_id": str(work["id"]),
                "source_page_sha256": str(page["source_page_sha256"]),
                "stage": stage,
                "catalog_version": catalog_version,
                "candidate_order_seed": seed,
                "candidate_order": order,
                "blind_alias_order": [aliases[font_id] for font_id in order],
                "blind_first_pass": True,
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "prior_tiers_visible": False,
                "split_visible": False,
                "candidate_initial_state": "not_reviewed",
                "candidate_count": len(new_ids),
                "review_order": review_order,
                "priority_rank": queue_row["priority_rank"],
                "release_state": (
                    "blocked_pending_font_signal_audit" if audit_required else "ready"
                ),
                "reviewer_independence": {
                    "required_for_secondary": stage == "secondary",
                    "same_reviewer_as_primary_allowed": (
                        False if stage == "secondary" else None
                    ),
                },
                "adjudication_if": [
                    "primary_secondary_disagreement",
                    "none_acceptable",
                    f"confidence_below_{ADJUDICATION_CONFIDENCE_THRESHOLD:.2f}",
                ],
            }
            assignment["assignment_id"] = _assignment_id(assignment)
            assignment_rows.append(assignment)

    if len(selection_rows) != expected_samples or len(master_rows) != expected_samples:
        raise RescueInputError("v3 selection/master does not cover every active sample")
    if (
        len({row["sample_id"] for row in assignment_rows if row["stage"] == "primary"})
        != expected_samples
    ):
        raise RescueInputError("v3 assignments do not cover every active primary")
    secondary_assignment_ids = {
        str(row["sample_id"]) for row in assignment_rows if row["stage"] == "secondary"
    }
    if secondary_assignment_ids != secondary_ids:
        raise RescueInputError("v3 secondary assignments differ from the sealed plan")
    for priority in (0, 1):
        missing_secondary_by_priority[priority] = (
            priority_ids[priority] - secondary_assignment_ids
        )
    if any(missing_secondary_by_priority.values()):
        raise RescueInputError("priority 0/1 assignment coverage is incomplete")
    known_active = KNOWN_FONT_SIGNAL_AUDIT_SAMPLE_IDS & {
        str(sample["sample_id"]) for sample in samples
    }
    audit_ids = {str(row["sample_id"]) for row in audit_rows}
    if not known_active <= audit_ids:
        raise RescueInputError(
            "known punctuation-only sample is absent from font signal audit"
        )

    selection_payload = jsonl_bytes(selection_rows)
    assignments_payload = jsonl_bytes(assignment_rows)
    audit_payload = jsonl_bytes(audit_rows)
    bank_payload = json_bytes(delta_bank)
    split_counts = source["split_counts"]
    role_counts = source["role_counts"]
    work_counts = source["work_counts"]
    planned_cells = expected_samples * len(new_ids)
    blocked_cells = len(audit_rows) * len(new_ids)
    report = seal(
        {
            "schema_version": DELTA_SCHEMA_VERSION,
            "record_type": "font_matching_catalog_delta_review_inputs_report",
            "inputs": {
                **source["hashes"],
                "builder_source_sha256": sha256_file(Path(__file__).resolve()),
                "legacy_catalog_sha256": legacy_catalog_sha256,
                "expanded_catalog_sha256": sha256_file(expanded_catalog),
                "expanded_render_bank_sha256": sha256_file(expanded_render_bank),
            },
            "outputs": {
                "master_sha256": master_payload_sha256,
                "selection_sha256": sha256_bytes(selection_payload),
                "assignments_sha256": sha256_bytes(assignments_payload),
                "font_signal_audit_sha256": sha256_bytes(audit_payload),
                "render_bank_manifest_sha256": sha256_bytes(bank_payload),
            },
            "summary": {
                "selected_sample_count": expected_samples,
                "selected_work_count": len(work_counts),
                "role_counts": dict(sorted(role_counts.items())),
                "work_counts": dict(sorted(work_counts.items())),
                "split_counts_aggregate_only": dict(sorted(split_counts.items())),
                "priority_counts": dict(sorted(priority_counts.items())),
                "priority_reason_counts": dict(sorted(priority_reason_counts.items())),
                "legacy_candidate_count": len(legacy_ids),
                "expanded_candidate_count": len(legacy_ids) + len(new_ids),
                "new_candidate_count": len(new_ids),
                "new_candidate_ids": new_ids,
                "new_candidate_cells": planned_cells,
                "review_ready_new_candidate_cells": planned_cells - blocked_cells,
                "font_signal_audit_blocked_cells": blocked_cells,
                "copied_render_count": len(delta_bank["renders"]),
                "invalidated_final_count": expected_invalidated,
                "old_label_inheritance_to_successor_count": 0,
                "qa_overlay_sample_count": 0,
                "synthetic_sample_count": 0,
                "primary_assignment_count": expected_samples,
                "secondary_assignment_count": len(secondary_ids),
                "mandatory_secondary_count": len(mandatory_secondary),
                "deterministic_20_percent_secondary_count": len(sampled_secondary),
                "priority_0_secondary_count": len(priority_ids[0]),
                "priority_1_secondary_count": len(priority_ids[1]),
                "priority_2_deterministic_secondary_count": len(sampled_secondary),
                "priority_0_missing_secondary": len(missing_secondary_by_priority[0]),
                "priority_1_missing_secondary": len(missing_secondary_by_priority[1]),
                "font_signal_audit_count": len(audit_rows),
                "font_signal_audit_reason_counts": dict(
                    sorted(audit_reason_counts.items())
                ),
                "font_signal_audit_sample_ids_sha256": sorted_ids_sha256(audit_ids),
            },
            "contracts": {
                "active_samples_authoritative_source": "sealed_training_export_samples_only",
                "prior_15_candidate_labels": {
                    "sealed_in_each_selection_row": True,
                    "use": "merge_only_after_new_7_human_review",
                    "review_surface_visible": False,
                    "successor_inheritance_allowed": False,
                },
                "new_7_candidate_review": {
                    "all_initial_tiers": "not_reviewed",
                    "automatic_tier_assignment_allowed": False,
                    "blind_alias_only_on_review_surface": True,
                    "model_suggestion_count": 0,
                },
                "queue": {
                    "order": [
                        "prior_none_or_font_signal_eligibility_risk",
                        "variant_roles_high_handwritten_irregular_manual_recrop_or_source_family_override",
                        "ordinary",
                    ],
                    "work_interleaved_within_priority": True,
                    "split_used_for_ordering": False,
                    "split_visible_on_review_surface": False,
                },
                "assignments": {
                    "all_samples_primary": True,
                    "mandatory_independent_secondary": ["priority_0", "priority_1"],
                    "mandatory_secondary_rule": "priority_rank_lte_1",
                    "priority_0_criteria": [
                        "prior_none_acceptable",
                        "font_signal_eligibility_risk",
                    ],
                    "priority_1_criteria": [
                        "aside_balloon_edge",
                        "emphasis_dialogue",
                        "shout",
                        "whisper",
                        "sfx_impact",
                        "sfx_motion",
                        "sfx_ambient",
                        "sfx_emotion",
                        "sfx_comic",
                        "sign_ui_title",
                        "handwritten_gte_0.5",
                        "irregularity_gte_0.5",
                        "manual_recrop",
                        "source_family_override",
                    ],
                    "priority_0_missing_secondary": 0,
                    "priority_1_missing_secondary": 0,
                    "remaining_secondary_minimum_rate": SECONDARY_SAMPLE_RATE,
                    "remaining_secondary_scope": "priority_2_deterministic_by_work",
                    "secondary_reviewer_independent": True,
                    "adjudication_triggers": [
                        "primary_secondary_disagreement",
                        "none_acceptable",
                        f"confidence_below_{ADJUDICATION_CONFIDENCE_THRESHOLD:.2f}",
                    ],
                },
                "font_signal_audit": {
                    "selection_rule": (
                        "unknown_fields>=5 OR (prior_none_acceptable AND unknown_fields>=3)"
                    ),
                    "must_precede_new_candidate_review": True,
                    "automatic_absent_classification_allowed": False,
                    "known_case_required": sorted(known_active),
                },
            },
        }
    )
    files = {
        MASTER_FILE: master_payload,
        SELECTION_FILE: selection_payload,
        ASSIGNMENTS_FILE: assignments_payload,
        FONT_SIGNAL_AUDIT_FILE: audit_payload,
        RENDER_BANK_MANIFEST: bank_payload,
        REPORT_FILE: json_bytes(report),
        **image_files,
    }
    marker = {
        "schema_version": DELTA_SCHEMA_VERSION,
        "owner": OWNER,
        "safe_replace": True,
        "managed_files": {
            name: sha256_bytes(payload) for name, payload in sorted(files.items())
        },
    }
    files[MARKER_FILE] = json_bytes(marker)
    return files


def build_files(
    *,
    final_labels: Path,
    master_manifest: Path,
    legacy_catalog: Path,
    expanded_catalog: Path,
    expanded_render_bank: Path,
    expected_samples: int,
    expected_new_candidates: int,
) -> dict[str, bytes]:
    legacy_document = read_json(legacy_catalog, "legacy catalog")
    expanded_document = read_json(expanded_catalog, "expanded catalog")
    legacy_catalog_sha256 = sha256_file(legacy_catalog)
    legacy_ids = _catalog_family_ids(legacy_document, "legacy catalog")
    expanded_ids = _catalog_family_ids(expanded_document, "expanded catalog")
    if not set(legacy_ids) < set(expanded_ids):
        raise RescueInputError("expanded catalog is not a strict legacy superset")
    new_ids = [font_id for font_id in expanded_ids if font_id not in set(legacy_ids)]
    if len(new_ids) != expected_new_candidates:
        raise RescueInputError(
            f"expected {expected_new_candidates} new candidates, got {len(new_ids)}"
        )
    prior_by_sample, role_counts = _load_prior_none_labels(
        final_labels, expected_catalog_sha256=legacy_catalog_sha256
    )
    if len(prior_by_sample) != expected_samples:
        raise RescueInputError(
            f"expected {expected_samples} none_acceptable samples, got {len(prior_by_sample)}"
        )
    masters, selections = _filter_master(master_manifest, prior_by_sample)
    master_payload = jsonl_bytes(masters)
    selection_payload = jsonl_bytes(selections)
    rescue_bank, image_files = _subset_render_bank(
        expanded_render_bank, expanded_catalog, new_ids
    )
    bank_payload = json_bytes(rescue_bank)
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_catalog_rescue_inputs_report",
            "inputs": {
                "final_labels_sha256": sha256_file(final_labels),
                "master_manifest_sha256": sha256_file(master_manifest),
                "legacy_catalog_sha256": legacy_catalog_sha256,
                "expanded_catalog_sha256": sha256_file(expanded_catalog),
                "expanded_render_bank_sha256": sha256_file(expanded_render_bank),
            },
            "outputs": {
                "master_sha256": sha256_bytes(master_payload),
                "selection_sha256": sha256_bytes(selection_payload),
                "render_bank_manifest_sha256": sha256_bytes(bank_payload),
            },
            "summary": {
                "selected_sample_count": len(masters),
                "selected_work_count": len(
                    {
                        require_text(
                            require_mapping(value.get("work"), "master.work").get("id"),
                            "master.work.id",
                        )
                        for value in masters
                    }
                ),
                "hard_sfx_count": sum(
                    count
                    for role, count in role_counts.items()
                    if role.startswith("sfx_")
                ),
                "role_counts": dict(sorted(role_counts.items())),
                "legacy_candidate_count": len(legacy_ids),
                "expanded_candidate_count": len(expanded_ids),
                "new_candidate_count": len(new_ids),
                "new_candidate_ids": new_ids,
                "copied_render_count": len(rescue_bank["renders"]),
                "all_selected_prior_none_acceptable": True,
                "synthetic_sample_count": 0,
                "qa_overlay_sample_count": 0,
            },
        }
    )
    files = {
        MASTER_FILE: master_payload,
        SELECTION_FILE: selection_payload,
        RENDER_BANK_MANIFEST: bank_payload,
        REPORT_FILE: json_bytes(report),
        **image_files,
    }
    marker = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "safe_replace": True,
        "managed_files": {
            name: sha256_bytes(payload) for name, payload in sorted(files.items())
        },
    }
    files[MARKER_FILE] = json_bytes(marker)
    return files


def _list_files(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }


def _assert_replaceable(output_dir: Path, *, expected_schema_version: str) -> None:
    if not output_dir.exists():
        return
    if output_dir.is_symlink() or not output_dir.is_dir():
        raise RescueInputError("output is not a replaceable directory")
    if not any(output_dir.iterdir()):
        return
    marker_path = output_dir / MARKER_FILE
    if not marker_path.is_file():
        raise RescueInputError("refusing to replace an unowned output directory")
    marker = read_json(marker_path, "ownership marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != expected_schema_version
        or marker.get("safe_replace") is not True
    ):
        raise RescueInputError("output ownership marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise RescueInputError("output ownership marker has no managed files")
    managed_names: set[str] = set()
    for name, expected_sha in managed.items():
        if not isinstance(name, str) or not name or "\\" in name:
            raise RescueInputError("output ownership marker has an unsafe file path")
        relative = PurePosixPath(name)
        windows_relative = PureWindowsPath(name)
        if (
            relative.is_absolute()
            or windows_relative.is_absolute()
            or bool(windows_relative.drive)
            or ".." in relative.parts
            or name == MARKER_FILE
        ):
            raise RescueInputError("output ownership marker has an unsafe file path")
        managed_names.add(relative.as_posix())
        require_sha(expected_sha, f"ownership marker.managed_files[{name}]")
    expected_names = {MARKER_FILE, *managed_names}
    actual_names = _list_files(output_dir)
    if actual_names != expected_names:
        raise RescueInputError("refusing to replace output with unmanaged files")
    for name, expected_sha in managed.items():
        physical = output_dir.joinpath(*PurePosixPath(name).parts)
        if not physical.is_file() or sha256_file(physical) != expected_sha:
            raise RescueInputError(f"refusing to replace tampered output: {name}")


def write_output(output_dir: Path, files: Mapping[str, bytes]) -> None:
    expected_marker = require_mapping(
        json.loads(files[MARKER_FILE]), "expected ownership marker"
    )
    expected_schema_version = require_text(
        expected_marker.get("schema_version"),
        "expected ownership marker.schema_version",
    )
    if expected_schema_version not in {SCHEMA_VERSION, DELTA_SCHEMA_VERSION}:
        raise RescueInputError("expected output ownership schema is unsupported")
    _assert_replaceable(output_dir, expected_schema_version=expected_schema_version)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    backup = (
        output_dir.parent
        / f".{output_dir.name}.backup-{stable_hash(str(output_dir), str(len(files)))[:12]}"
    )
    completed = False
    moved_old = False
    try:
        for relative, payload in files.items():
            destination = staging.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
        validate_files(staging, files)
        if backup.exists():
            raise RescueInputError(f"stale deterministic backup exists: {backup}")
        if output_dir.exists():
            output_dir.rename(backup)
            moved_old = True
        staging.rename(output_dir)
        completed = True
        if moved_old:
            shutil.rmtree(backup)
    except Exception:
        if moved_old and not output_dir.exists() and backup.exists():
            backup.rename(output_dir)
        raise
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)


def validate_files(output_dir: Path, expected: Mapping[str, bytes]) -> None:
    marker = read_json(output_dir / MARKER_FILE, "ownership marker")
    expected_marker = require_mapping(
        json.loads(expected[MARKER_FILE]), "expected ownership marker"
    )
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != expected_marker.get("schema_version")
        or marker.get("safe_replace") is not True
    ):
        raise RescueInputError("output ownership marker is invalid")
    expected_names = set(expected)
    actual_names = _list_files(output_dir)
    if actual_names != expected_names:
        raise RescueInputError(
            f"output file inventory differs; missing={sorted(expected_names - actual_names)[:8]} "
            f"unexpected={sorted(actual_names - expected_names)[:8]}"
        )
    for relative, payload in expected.items():
        if output_dir.joinpath(*PurePosixPath(relative).parts).read_bytes() != payload:
            raise RescueInputError(f"output is stale or tampered: {relative}")


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("build", "validate", "build-v3", "validate-v3")
    )
    parser.add_argument("--training-export-dir", type=Path)
    parser.add_argument("--final-labels", type=Path)
    parser.add_argument("--master-manifest", type=Path)
    parser.add_argument("--master-report", type=Path)
    parser.add_argument("--master-split-map", type=Path)
    parser.add_argument("--catalog-registry", type=Path)
    parser.add_argument("--legacy-catalog", type=Path)
    parser.add_argument("--expanded-catalog", type=Path)
    parser.add_argument("--expanded-render-bank", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-samples", type=positive_int)
    parser.add_argument("--expected-invalidated", type=positive_int)
    parser.add_argument("--expected-new-candidates", type=positive_int)
    return parser.parse_args(argv)


def _required_argument(args: argparse.Namespace, name: str) -> Any:
    value = getattr(args, name)
    if value is None:
        raise RescueInputError(f"--{name.replace('_', '-')} is required")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command in {"build-v3", "validate-v3"}:
            files = build_delta_files(
                training_export_dir=_required_argument(
                    args, "training_export_dir"
                ).resolve(),
                prior_final_labels=_required_argument(args, "final_labels").resolve(),
                master_manifest=_required_argument(args, "master_manifest").resolve(),
                master_report=_required_argument(args, "master_report").resolve(),
                master_split_map=_required_argument(args, "master_split_map").resolve(),
                catalog_registry=_required_argument(args, "catalog_registry").resolve(),
                legacy_catalog=_required_argument(args, "legacy_catalog").resolve(),
                expanded_catalog=_required_argument(args, "expanded_catalog").resolve(),
                expanded_render_bank=_required_argument(
                    args, "expanded_render_bank"
                ).resolve(),
                expected_samples=_required_argument(args, "expected_samples"),
                expected_invalidated=_required_argument(args, "expected_invalidated"),
                expected_new_candidates=_required_argument(
                    args, "expected_new_candidates"
                ),
            )
        else:
            files = build_files(
                final_labels=_required_argument(args, "final_labels").resolve(),
                master_manifest=_required_argument(args, "master_manifest").resolve(),
                legacy_catalog=_required_argument(args, "legacy_catalog").resolve(),
                expanded_catalog=_required_argument(args, "expanded_catalog").resolve(),
                expanded_render_bank=_required_argument(
                    args, "expanded_render_bank"
                ).resolve(),
                expected_samples=_required_argument(args, "expected_samples"),
                expected_new_candidates=_required_argument(
                    args, "expected_new_candidates"
                ),
            )
        output_dir = args.output_dir.resolve()
        if args.command in {"build", "build-v3"}:
            write_output(output_dir, files)
        else:
            validate_files(output_dir, files)
        report = json.loads(files[REPORT_FILE])
        print(canonical_json({"status": "valid", **report["summary"]}))
        return 0
    except RescueInputError as error:
        print(f"catalog rescue input error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
