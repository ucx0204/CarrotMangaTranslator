#!/usr/bin/env python3
"""Build a sealed, review-only rescue cohort for newly added font families.

The source pilot remains immutable.  This tool selects only its finalized
``none_acceptable`` samples, derives the families added between two audited
catalogs, and copies just those canonical Chromium renders into a separate
render bank.  The resulting master and bank can be fed to the normal blind
assignment/card/ledger tools without pretending that the old 15-family review
was performed against the expanded catalog.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import font_matching_labels as labels


SCHEMA_VERSION = "font-matching-catalog-rescue-inputs-v1"
SELECTION_RECORD_TYPE = "font_catalog_rescue_selection"
OWNER = "carrot-manga-translator/font-matching-catalog-rescue-inputs"
MARKER_FILE = ".font-matching-catalog-rescue-inputs-owned.json"
MASTER_FILE = "master.jsonl"
SELECTION_FILE = "selection.jsonl"
REPORT_FILE = "report.json"
RENDER_BANK_DIR = "render-bank"
RENDER_BANK_MANIFEST = f"{RENDER_BANK_DIR}/manifest.json"


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
    if len(text) != 64 or any(character not in "0123456789abcdef" for character in text):
        raise RescueInputError(f"{location}: expected lowercase SHA-256")
    return text


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
            require_text(
                family.get("font_id"), f"{location}.families[{index}].font_id"
            )
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
        sample_id = require_text(row.get("sample_id"), f"final labels:{index}.sample_id")
        if sample_id in seen:
            raise RescueInputError(f"final labels:{index}: duplicate sample {sample_id}")
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
        raise RescueInputError(f"master manifest could not be opened: {error}") from error
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
                raise RescueInputError(f"master manifest repeats selected sample {sample_id}")
            if require_mapping(row.get("provenance"), f"master[{sample_id}].provenance").get("qa_overlay") is not False:
                raise RescueInputError(f"master[{sample_id}] contains a QA overlay")
            if require_mapping(row.get("provenance"), f"master[{sample_id}].provenance").get("synthetic") is not False:
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
            master_rows.append(row)
            selection_rows.append(
                seal(
                    {
                        "schema_version": 1,
                        "record_type": SELECTION_RECORD_TYPE,
                        "sample_id": sample_id,
                        "work_id": work_id,
                        "source_page_sha256": source_page_sha256,
                        "source_master_line_number": line_number,
                        "source_master_record_sha256": sha256_bytes(json_bytes(row)),
                        "prior_final_id": require_text(
                            prior.get("final_id"), f"final[{sample_id}].final_id"
                        ),
                        "prior_final_record_sha256": require_sha(
                            prior.get("record_sha256"),
                            f"final[{sample_id}].record_sha256",
                        ),
                        "prior_role": require_text(
                            prior_role.get("primary"),
                            f"final[{sample_id}].role.primary",
                        ),
                        "prior_orientation": require_text(
                            prior_treatment.get("orientation"),
                            f"final[{sample_id}].treatment.orientation",
                        ),
                        "selection_reason": "prior_none_acceptable",
                    }
                )
            )
            found.add(sample_id)
    missing = sorted(set(prior_by_sample) - found)
    if missing:
        raise RescueInputError(f"selected samples are absent from master: {missing[:8]}")
    order = sorted(range(len(master_rows)), key=lambda index: str(master_rows[index]["id"]))
    return [master_rows[index] for index in order], [selection_rows[index] for index in order]


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
        raise RescueInputError("expanded render bank candidate/render arrays are invalid")
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
        raise RescueInputError("new canonical candidates must have unique blind aliases")
    display_ids = set(display_id_values)
    renders = [
        copy.deepcopy(dict(require_mapping(value, "expanded render")))
        for value in renders_value
        if isinstance(value, Mapping) and value.get("candidate_display_id") in display_ids
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
        raise RescueInputError("new candidate render matrix is incomplete or duplicated")
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
            raise RescueInputError("new candidate render failed readiness/fallback gates")
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
        SCHEMA_VERSION,
        parent_sha,
        *new_font_ids,
        *(require_text(value.get("render_id"), "render.render_id") for value in renders),
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
                    count for role, count in role_counts.items() if role.startswith("sfx_")
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
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }


def _assert_replaceable(output_dir: Path) -> None:
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
        or marker.get("schema_version") != SCHEMA_VERSION
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
    _assert_replaceable(output_dir)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    backup = output_dir.parent / f".{output_dir.name}.backup-{stable_hash(str(output_dir), str(len(files)))[:12]}"
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
    if marker.get("owner") != OWNER or marker.get("schema_version") != SCHEMA_VERSION:
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
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--final-labels", type=Path, required=True)
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument("--legacy-catalog", type=Path, required=True)
    parser.add_argument("--expanded-catalog", type=Path, required=True)
    parser.add_argument("--expanded-render-bank", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-samples", type=positive_int, required=True)
    parser.add_argument("--expected-new-candidates", type=positive_int, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        files = build_files(
            final_labels=args.final_labels.resolve(),
            master_manifest=args.master_manifest.resolve(),
            legacy_catalog=args.legacy_catalog.resolve(),
            expanded_catalog=args.expanded_catalog.resolve(),
            expanded_render_bank=args.expanded_render_bank.resolve(),
            expected_samples=args.expected_samples,
            expected_new_candidates=args.expected_new_candidates,
        )
        output_dir = args.output_dir.resolve()
        if args.command == "build":
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
