#!/usr/bin/env python3
"""Build deterministic, blind, review-only font-matching PNG cards.

The cards are QA artifacts, never training inputs.  They combine an immutable
master sample with its page location, three source views, and the production
400/normal canonical render for every built-in Korean font family.  Candidate
names and ``font_id`` values are deliberately absent from card pixels, paths,
and the public manifest; only the render bank's opaque blind aliases appear.

Primary and secondary assignments have independent candidate orders.  A run
therefore targets one review stage (``primary`` by default) and emits exactly
one card per selected assignment.  A separate, explicitly acknowledged
``reveal`` command writes the alias-to-font mapping outside the card directory
after blind review is complete.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

from PIL import (
    Image,
    ImageDraw,
    ImageFont,
    UnidentifiedImageError,
    __version__ as PILLOW_VERSION,
)


SCHEMA_VERSION = "font-matching-review-card-v1"
REPORT_VERSION = "font-matching-review-card-report-v1"
OWNER = "carrot-manga-translator/font-matching-review-cards"
MARKER_FILE = ".font-matching-review-cards-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
REVEAL_SCHEMA_VERSION = "font-matching-review-reveal-v1"
REVEAL_OWNER = "carrot-manga-translator/font-matching-review-reveal"
REVEAL_MARKER_FILE = ".font-matching-review-reveal-owned.json"
REVEAL_FILE = "reveal-map.json"
UNBLIND_ACKNOWLEDGEMENT = "REVIEW_COMPLETE_UNBLIND"

CARD_WIDTH = 2400
CARD_HEIGHT = 3508
CYAN = (0, 214, 255)
DARK = (22, 28, 36)
MID = (54, 65, 78)
PALE = (239, 245, 249)
WHITE = (255, 255, 255)
BLACK = (12, 16, 21)
# Three deliberately different strings are required by the frozen review
# plan: a neutral body voice, a longer prose rhythm, and a short dense SFX.
PROBE_IDS = ("dialogue-body", "narration", "sfx-impact")
MAX_CARD_CANDIDATES = 15
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")


class ReviewCardError(ValueError):
    """Raised when review-card inputs or outputs violate the contract."""


@dataclass(frozen=True)
class RunConfig:
    stage: str = "primary"
    batch: str = "all"
    limit: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"batch": self.batch, "limit": self.limit, "stage": self.stage}


@dataclass
class LoadedInputs:
    master_by_id: dict[str, dict[str, Any]]
    inventory_rows: list[dict[str, Any]]
    assignments: list[dict[str, Any]]
    bank: dict[str, Any]
    canonical_by_font_id: dict[str, dict[str, Any]]
    render_by_key: dict[tuple[str, str, str], dict[str, Any]]
    input_hashes: dict[str, str]
    renderer_hash: str
    identity_terms: tuple[str, ...]
    work_references_by_target: dict[str, dict[str, Any]]


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = True) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


_FILE_HASH_CACHE: dict[tuple[str, int, int], str] = {}


def sha256_file(path: Path) -> str:
    stat = path.stat()
    key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns)
    cached = _FILE_HASH_CACHE.get(key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    result = digest.hexdigest()
    _FILE_HASH_CACHE[key] = result
    return result


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ReviewCardError(f"{location}: expected an object")
    return value


def require_text(value: Any, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise ReviewCardError(f"{location}: expected a non-empty string")
    return normalized


def require_id(value: Any, location: str) -> str:
    normalized = require_text(value, location)
    if not SAFE_ID_RE.fullmatch(normalized):
        raise ReviewCardError(f"{location}: invalid identifier")
    return normalized


def require_sha(value: Any, location: str) -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    if not SHA256_RE.fullmatch(normalized):
        raise ReviewCardError(f"{location}: expected a lowercase SHA-256")
    return normalized


def safe_relative_path(value: Any, location: str) -> str:
    raw = require_text(value, location).replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    pure = PurePosixPath(raw)
    if (
        pure.is_absolute()
        or not pure.parts
        or any(part in {"", ".", ".."} for part in pure.parts)
        or ":" in pure.parts[0]
    ):
        raise ReviewCardError(f"{location}: unsafe relative path {value!r}")
    return pure.as_posix()


def resolve_inside(root: Path, relative: str, location: str) -> Path:
    pure = PurePosixPath(relative)
    candidate = root.joinpath(*pure.parts).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise ReviewCardError(f"{location}: path escapes its declared root") from error
    if not candidate.is_file():
        raise ReviewCardError(f"{location}: missing file {relative}")
    return candidate


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReviewCardError(f"{location}: could not read JSON: {error}") from error
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
                    raise ReviewCardError(
                        f"{location}:{line_number}: invalid JSON: {error}"
                    ) from error
                rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    except OSError as error:
        raise ReviewCardError(f"{location}: could not read JSONL: {error}") from error
    if not rows:
        raise ReviewCardError(f"{location}: no records")
    return rows


def _stable_hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def _validate_record_seal(value: Mapping[str, Any], location: str) -> None:
    expected = require_sha(value.get("record_sha256"), f"{location}.record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_json(core) != expected:
        raise ReviewCardError(f"{location}: record seal mismatch")


def _load_work_references(
    path: Path | None,
    *,
    inventory_ids: set[str],
    master_by_id: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    manifest = read_json(path, "work reference manifest")
    _validate_record_seal(manifest, "work reference manifest")
    if (
        manifest.get("schema_version") != "font-matching-work-references-v1"
        or manifest.get("record_type") != "font_matching_work_reference_manifest"
    ):
        raise ReviewCardError("work reference manifest schema is unsupported")
    safety = require_mapping(manifest.get("safety"), "work reference safety")
    if (
        safety.get("font_names_visible") is not False
        or safety.get("model_suggestions_visible") is not False
        or safety.get("work_titles_visible") is not False
        or safety.get("qa_overlay") is not True
        or safety.get("training_asset") is not False
        or safety.get("images_copied_or_modified") != 0
    ):
        raise ReviewCardError("work reference manifest violates blind QA safety")
    expected_count = manifest.get("references_per_target")
    if (
        isinstance(expected_count, bool)
        or not isinstance(expected_count, int)
        or expected_count < 3
    ):
        raise ReviewCardError("work reference count must be at least three")
    targets = manifest.get("targets")
    if not isinstance(targets, list):
        raise ReviewCardError("work reference targets must be an array")
    output: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(targets, 1):
        target = dict(require_mapping(raw, f"work references:{index}"))
        _validate_record_seal(target, f"work references:{index}")
        if (
            target.get("schema_version") != "font-matching-work-references-v1"
            or target.get("record_type") != "font_matching_work_reference_target"
        ):
            raise ReviewCardError(f"work references:{index}: unsupported schema")
        sample_id = require_id(
            target.get("target_sample_id"),
            f"work references:{index}.target_sample_id",
        )
        if sample_id not in inventory_ids:
            raise ReviewCardError(
                f"work references:{index}: target is outside review inventory"
            )
        if sample_id in output:
            raise ReviewCardError(f"work references:{index}: duplicate target")
        master = master_by_id[sample_id]
        work_id = require_id(
            require_mapping(master.get("work"), f"master[{sample_id}].work").get("id"),
            f"master[{sample_id}].work.id",
        )
        orientation = require_mapping(
            master.get("metadata"), f"master[{sample_id}].metadata"
        ).get("orientation")
        if (
            target.get("target_work_id") != work_id
            or target.get("target_orientation") != orientation
        ):
            raise ReviewCardError(
                f"work references:{index}: target work/orientation binding mismatch"
            )
        references = target.get("references")
        if not isinstance(references, list) or len(references) != expected_count:
            raise ReviewCardError(
                f"work references:{index}: expected {expected_count} references"
            )
        source_ids: set[str] = set()
        aliases: set[str] = set()
        for reference_index, raw_reference in enumerate(references, 1):
            location = f"work references:{index}.references[{reference_index}]"
            reference = require_mapping(raw_reference, location)
            source_id = require_id(
                reference.get("source_sample_id"), f"{location}.source_sample_id"
            )
            alias = require_id(reference.get("blind_alias"), f"{location}.blind_alias")
            if source_id == sample_id or source_id in source_ids or alias in aliases:
                raise ReviewCardError(f"{location}: duplicate/self reference")
            source_ids.add(source_id)
            aliases.add(alias)
            if reference.get("role") != "dialogue":
                raise ReviewCardError(f"{location}: only ordinary dialogue is valid")
            for field in ("role_confidence", "resolution_confidence"):
                confidence = reference.get(field)
                if (
                    isinstance(confidence, bool)
                    or not isinstance(confidence, (int, float))
                    or not 0 <= float(confidence) <= 1
                ):
                    raise ReviewCardError(f"{location}.{field}: invalid confidence")
            if reference.get("orientation") not in {"horizontal", "vertical"}:
                raise ReviewCardError(f"{location}: invalid orientation")
            require_sha(
                reference.get("source_final_sha256"),
                f"{location}.source_final_sha256",
            )
            require_sha(
                reference.get("sample_crop_sha256"),
                f"{location}.sample_crop_sha256",
            )
            if reference.get("source_catalog_id") not in {
                "fontclip-accepted-v1",
                "fontclip-hard-accepted-v2",
            }:
                raise ReviewCardError(f"{location}: unsupported source catalog")
            views = require_mapping(reference.get("views"), f"{location}.views")
            if set(views) != {"raw_224", "context_224", "glyph_224"}:
                raise ReviewCardError(f"{location}: incomplete reference views")
        output[sample_id] = target
    if set(output) != inventory_ids:
        missing = sorted(inventory_ids - set(output))
        extra = sorted(set(output) - inventory_ids)
        raise ReviewCardError(
            f"work references must cover every inventory target; missing={missing[:8]} extra={extra[:8]}"
        )
    return output


def expected_candidate_order(values: Iterable[str], seed: str) -> list[str]:
    return sorted(
        values,
        key=lambda value: (
            _stable_hash("manga-font-candidate-rank-v1", seed, value),
            value,
        ),
    )


def expected_assignment_id(assignment: Mapping[str, Any]) -> str:
    digest = _stable_hash(
        "manga-font-review-assignment-v1",
        str(assignment["sample_id"]),
        str(assignment["stage"]),
        str(assignment["catalog_version"]),
        str(assignment["candidate_order_seed"]),
        *(str(value) for value in assignment["candidate_order"]),
    )
    return f"fmra-{digest[:32]}"


def validate_assignment(row: dict[str, Any], location: str) -> dict[str, Any]:
    if row.get("schema_version") != 1:
        raise ReviewCardError(f"{location}: assignment schema_version must be 1")
    if row.get("record_type") != "manga_font_label_assignment":
        raise ReviewCardError(f"{location}: assignment record_type is invalid")
    for key in ("assignment_id", "sample_id", "work_id", "catalog_version"):
        require_id(row.get(key), f"{location}.{key}")
    require_sha(row.get("source_page_sha256"), f"{location}.source_page_sha256")
    seed = require_sha(
        row.get("candidate_order_seed"), f"{location}.candidate_order_seed"
    )
    if row.get("stage") not in {"primary", "secondary"}:
        raise ReviewCardError(f"{location}.stage: unsupported review stage")
    if (
        row.get("blind_first_pass") is not True
        or row.get("font_names_visible") is not False
        or row.get("model_suggestions_visible") is not False
    ):
        raise ReviewCardError(f"{location}: assignment is not a blind first pass")
    order = row.get("candidate_order")
    if (
        not isinstance(order, list)
        or not 1 <= len(order) <= MAX_CARD_CANDIDATES
    ):
        raise ReviewCardError(
            f"{location}.candidate_order: expected 1-{MAX_CARD_CANDIDATES} families"
        )
    if any(not isinstance(value, str) for value in order) or len(set(order)) != len(
        order
    ):
        raise ReviewCardError(f"{location}.candidate_order: invalid or duplicate IDs")
    if order != expected_candidate_order(order, seed):
        raise ReviewCardError(f"{location}.candidate_order: seed binding failed")
    if row["assignment_id"] != expected_assignment_id(row):
        raise ReviewCardError(f"{location}.assignment_id: content binding failed")
    return row


def _candidate_is_canonical(candidate: Mapping[str, Any]) -> bool:
    return candidate.get("production_400_normal_canonical") is True


def _validate_canonical_binding(candidate: Mapping[str, Any], location: str) -> None:
    bindings = candidate.get("production_request_bindings")
    if not isinstance(bindings, list):
        raise ReviewCardError(f"{location}: missing production request bindings")
    matching = [
        binding
        for binding in bindings
        if isinstance(binding, Mapping)
        and binding.get("requested_weight") == 400
        and binding.get("requested_style") == "normal"
    ]
    if len(matching) != 1:
        raise ReviewCardError(f"{location}: expected one 400/normal request binding")
    binding = matching[0]
    if binding.get("synthetic_style") is not False:
        raise ReviewCardError(f"{location}: canonical 400/normal must not be synthetic")


def load_inputs(
    *,
    master_manifest: Path,
    inventory: Path,
    assignments: Path,
    render_bank_manifest: Path,
    work_reference_manifest: Path | None = None,
) -> LoadedInputs:
    paths = {
        "master_manifest_sha256": master_manifest,
        "inventory_sha256": inventory,
        "assignments_sha256": assignments,
        "render_bank_manifest_sha256": render_bank_manifest,
    }
    for label, path in paths.items():
        if not path.is_file():
            raise ReviewCardError(f"{label}: input does not exist: {path}")
    input_hashes = {label: sha256_file(path) for label, path in paths.items()}
    if work_reference_manifest is not None:
        if not work_reference_manifest.is_file():
            raise ReviewCardError(
                f"work_reference_manifest_sha256: input does not exist: {work_reference_manifest}"
            )
        input_hashes["work_reference_manifest_sha256"] = sha256_file(
            work_reference_manifest
        )
    input_hashes["card_builder_source_sha256"] = sha256_file(Path(__file__).resolve())

    inventory_rows = read_jsonl(inventory, "review inventory")
    inventory_ids: set[str] = set()
    for index, row in enumerate(inventory_rows, 1):
        sample_id = require_id(row.get("sample_id"), f"inventory:{index}.sample_id")
        if sample_id in inventory_ids:
            raise ReviewCardError(f"inventory:{index}: duplicate sample id")
        declared_master_hash = row.get("master_manifest_sha256")
        if (
            declared_master_hash is not None
            and declared_master_hash != input_hashes["master_manifest_sha256"]
        ):
            raise ReviewCardError(f"inventory:{index}: stale master manifest binding")
        provenance = row.get("provenance")
        if isinstance(provenance, Mapping) and (
            provenance.get("qa_overlay") is not False
            or provenance.get("synthetic") is not False
        ):
            raise ReviewCardError(f"inventory:{index}: unsafe provenance")
        inventory_ids.add(sample_id)

    # The production master is large (28,115 rows / ~150 MB).  Parse it as a
    # stream and retain only the requested inventory rather than holding every
    # unrelated record in memory for a small pilot or QA run.
    master_by_id: dict[str, dict[str, Any]] = {}
    try:
        with master_manifest.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ReviewCardError(
                        f"master:{line_number}: invalid JSON: {error}"
                    ) from error
                row = dict(require_mapping(value, f"master:{line_number}"))
                sample_id = require_id(row.get("id"), f"master:{line_number}.id")
                if sample_id not in inventory_ids:
                    continue
                if sample_id in master_by_id:
                    raise ReviewCardError(f"master:{line_number}: duplicate sample id")
                provenance = require_mapping(
                    row.get("provenance"), f"master:{line_number}.provenance"
                )
                if (
                    provenance.get("qa_overlay") is not False
                    or provenance.get("synthetic") is not False
                ):
                    raise ReviewCardError(
                        f"master:{line_number}: review cards require real overlay-free inputs"
                    )
                require_sha(
                    row.get("sample_crop_sha256"),
                    f"master:{line_number}.sample_crop_sha256",
                )
                master_by_id[sample_id] = row
    except OSError as error:
        raise ReviewCardError(
            f"master manifest: could not read JSONL: {error}"
        ) from error
    missing_master_ids = sorted(inventory_ids - set(master_by_id))
    if missing_master_ids:
        raise ReviewCardError(
            f"inventory samples are absent from master: {missing_master_ids[:8]}"
        )

    work_references_by_target = _load_work_references(
        work_reference_manifest,
        inventory_ids=inventory_ids,
        master_by_id=master_by_id,
    )

    assignment_rows = [
        validate_assignment(row, f"assignments:{index}")
        for index, row in enumerate(read_jsonl(assignments, "assignments"), 1)
    ]
    assignment_ids: set[str] = set()
    stage_keys: set[tuple[str, str]] = set()
    primary_ids: set[str] = set()
    for index, row in enumerate(assignment_rows, 1):
        assignment_id = str(row["assignment_id"])
        key = (str(row["sample_id"]), str(row["stage"]))
        if assignment_id in assignment_ids or key in stage_keys:
            raise ReviewCardError(f"assignments:{index}: duplicate assignment")
        assignment_ids.add(assignment_id)
        stage_keys.add(key)
        sample_id = str(row["sample_id"])
        if sample_id not in inventory_ids:
            raise ReviewCardError(f"assignments:{index}: sample is outside inventory")
        master = master_by_id[sample_id]
        work = require_mapping(master.get("work"), f"master[{sample_id}].work")
        page = require_mapping(master.get("page"), f"master[{sample_id}].page")
        if row["work_id"] != work.get("id"):
            raise ReviewCardError(f"assignments:{index}: work binding mismatch")
        if row["source_page_sha256"] != page.get("source_page_sha256"):
            raise ReviewCardError(f"assignments:{index}: source-page binding mismatch")
        if row["stage"] == "primary":
            primary_ids.add(sample_id)
    if primary_ids != inventory_ids:
        missing = sorted(inventory_ids - primary_ids)
        raise ReviewCardError(
            "assignments must contain exactly one primary for every inventory sample; "
            f"missing={missing[:8]}"
        )

    bank = read_json(render_bank_manifest, "render bank manifest")
    if bank.get("schema_version") != "font-render-bank-v1":
        raise ReviewCardError("render bank manifest schema is unsupported")
    family_count = bank.get("family_count")
    if (
        isinstance(family_count, bool)
        or not isinstance(family_count, int)
        or family_count < 1
    ):
        raise ReviewCardError("render bank family_count is invalid")
    candidates = bank.get("candidates")
    renders = bank.get("renders")
    if not isinstance(candidates, list) or not isinstance(renders, list):
        raise ReviewCardError("render bank candidates/renders are invalid")

    canonical_by_font_id: dict[str, dict[str, Any]] = {}
    aliases: set[str] = set()
    identity_terms: list[str] = []
    for index, candidate_value in enumerate(candidates, 1):
        candidate = dict(require_mapping(candidate_value, f"candidate:{index}"))
        font_id = require_id(candidate.get("font_id"), f"candidate:{index}.font_id")
        alias = require_id(
            candidate.get("blind_alias"), f"candidate:{index}.blind_alias"
        )
        if alias in aliases:
            raise ReviewCardError(f"candidate:{index}: duplicate blind alias")
        aliases.add(alias)
        identity_terms.extend(
            value
            for value in (candidate.get("font_id"), candidate.get("font_label"))
            if isinstance(value, str) and value
        )
        if _candidate_is_canonical(candidate):
            _validate_canonical_binding(candidate, f"candidate:{index}")
            if font_id in canonical_by_font_id:
                raise ReviewCardError(f"candidate:{index}: duplicate canonical family")
            if (
                candidate.get("render_weight") != 400
                or candidate.get("render_style") != "normal"
            ):
                raise ReviewCardError(
                    f"candidate:{index}: canonical face is not 400 normal"
                )
            canonical_by_font_id[font_id] = candidate
    if len(canonical_by_font_id) != family_count:
        raise ReviewCardError(
            "render bank must explicitly mark one production 400/normal "
            "canonical candidate per family"
        )

    render_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for index, render_value in enumerate(renders, 1):
        render = dict(require_mapping(render_value, f"render:{index}"))
        key = (
            require_text(
                render.get("candidate_display_id"),
                f"render:{index}.candidate_display_id",
            ),
            require_id(render.get("probe_id"), f"render:{index}.probe_id"),
            require_text(render.get("writing_mode"), f"render:{index}.writing_mode"),
        )
        if key in render_by_key:
            raise ReviewCardError(f"render:{index}: duplicate render key")
        render_by_key[key] = render

    source_contract = require_mapping(
        bank.get("source_contract"), "render bank source_contract"
    )
    catalog_version = source_contract.get("schema_version")
    if any(row["catalog_version"] != catalog_version for row in assignment_rows):
        raise ReviewCardError(
            "assignments and render bank use different catalog versions"
        )
    renderer_hash = sha256_json(
        {
            "renderer": bank.get("renderer"),
            "render_spec": bank.get("render_spec"),
            "source_contract": bank.get("source_contract"),
            "specification_sha256": bank.get("specification_sha256"),
        }
    )
    return LoadedInputs(
        master_by_id=master_by_id,
        inventory_rows=inventory_rows,
        assignments=assignment_rows,
        bank=bank,
        canonical_by_font_id=canonical_by_font_id,
        render_by_key=render_by_key,
        input_hashes=input_hashes,
        renderer_hash=renderer_hash,
        identity_terms=tuple(sorted(set(identity_terms))),
        work_references_by_target=work_references_by_target,
    )


def ordered_inventory(
    rows: Sequence[dict[str, Any]], batch: str
) -> list[dict[str, Any]]:
    if batch == "all":
        return sorted(rows, key=lambda row: str(row["sample_id"]))
    selected: list[tuple[int, str, dict[str, Any]]] = []
    for index, row in enumerate(rows, 1):
        batches = row.get("batches")
        if not isinstance(batches, Mapping) or batch not in batches:
            continue
        entry = require_mapping(batches[batch], f"inventory:{index}.batches.{batch}")
        order = entry.get("review_order")
        if not isinstance(order, int) or isinstance(order, bool) or order <= 0:
            raise ReviewCardError(
                f"inventory:{index}.batches.{batch}.review_order is invalid"
            )
        selected.append((order, str(row["sample_id"]), row))
    if not selected:
        raise ReviewCardError(f"inventory contains no {batch!r} batch samples")
    orders = [item[0] for item in selected]
    if len(orders) != len(set(orders)):
        raise ReviewCardError(f"inventory {batch!r} review_order values are duplicated")
    return [item[2] for item in sorted(selected)]


def select_assignments(inputs: LoadedInputs, config: RunConfig) -> list[dict[str, Any]]:
    if config.stage not in {"primary", "secondary", "all"}:
        raise ReviewCardError("stage must be primary, secondary, or all")
    if config.batch not in {"all", "pilot", "calibration"}:
        raise ReviewCardError("batch must be all, pilot, or calibration")
    if config.limit is not None and config.limit <= 0:
        raise ReviewCardError("limit must be positive")
    by_key = {
        (str(row["sample_id"]), str(row["stage"])): row for row in inputs.assignments
    }
    selected: list[dict[str, Any]] = []
    stages = ("primary", "secondary") if config.stage == "all" else (config.stage,)
    for inventory_row in ordered_inventory(inputs.inventory_rows, config.batch):
        sample_id = str(inventory_row["sample_id"])
        for stage in stages:
            assignment = by_key.get((sample_id, stage))
            if assignment is None:
                if stage == "secondary":
                    continue
                raise ReviewCardError(f"missing {stage} assignment for {sample_id}")
            selected.append(assignment)
    if not selected:
        raise ReviewCardError("selection produced no review assignments")
    if config.limit is not None:
        selected = selected[: config.limit]
    return selected


def _assert_hash(path: Path, expected: str, location: str) -> None:
    actual = sha256_file(path)
    if actual != require_sha(expected, f"{location}.sha256"):
        raise ReviewCardError(f"{location}: file hash mismatch")


def _load_rgb(path: Path, location: str) -> Image.Image:
    try:
        with Image.open(path) as image:
            image.load()
            if image.width <= 0 or image.height <= 0:
                raise ReviewCardError(f"{location}: empty image")
            if image.mode == "RGBA":
                canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
                canvas.alpha_composite(image)
                return canvas.convert("RGB")
            return image.convert("RGB")
    except (OSError, UnidentifiedImageError) as error:
        raise ReviewCardError(f"{location}: image decode failed: {error}") from error


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()


def _letterbox_224(image: Image.Image) -> Image.Image:
    scale = min(224 / image.width, 224 / image.height)
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    resized = image.resize((width, height), Image.Resampling.LANCZOS)
    output = Image.new("RGB", (224, 224), WHITE)
    output.paste(resized, ((224 - width) // 2, (224 - height) // 2))
    return output


def load_view(
    view_name: str,
    view_value: Any,
    *,
    catalog_roots: Mapping[str, Path],
) -> tuple[Image.Image | None, dict[str, Any]]:
    view = require_mapping(view_value, f"views.{view_name}")
    status = view.get("status")
    if status == "unavailable":
        return None, {
            "display_sha256": None,
            "source_sha256": None,
            "status": "unavailable",
        }
    catalog_id = require_text(view.get("catalog_id"), f"views.{view_name}.catalog_id")
    root = catalog_roots.get(catalog_id)
    if root is None:
        raise ReviewCardError(f"views.{view_name}: unknown catalog root {catalog_id!r}")
    if status == "available":
        relative = safe_relative_path(view.get("path"), f"views.{view_name}.path")
        path = resolve_inside(root, relative, f"views.{view_name}.path")
        expected = require_sha(
            view.get("file_sha256"), f"views.{view_name}.file_sha256"
        )
        _assert_hash(path, expected, f"views.{view_name}")
        image = _load_rgb(path, f"views.{view_name}")
        if image.size != (224, 224):
            raise ReviewCardError(f"views.{view_name}: expected 224x224")
        return image, {
            "display_sha256": sha256_bytes(_png_bytes(image)),
            "source_sha256": expected,
            "status": "available",
        }
    if status == "derivable" and view_name == "raw_224":
        recipe = require_mapping(
            view.get("materialization_recipe"), "views.raw_224.recipe"
        )
        if (
            recipe.get("algorithm") != "fontclip-letterbox-rgb-v1"
            or recipe.get("operation") != "aspect_preserving_letterbox"
            or recipe.get("target_size_px") != [224, 224]
        ):
            raise ReviewCardError("views.raw_224: unsupported derivation recipe")
        source = require_mapping(
            view.get("source_native"), "views.raw_224.source_native"
        )
        relative = safe_relative_path(
            source.get("path"), "views.raw_224.source_native.path"
        )
        path = resolve_inside(root, relative, "views.raw_224.source_native.path")
        expected = require_sha(
            source.get("file_sha256"), "views.raw_224.source_native.file_sha256"
        )
        _assert_hash(path, expected, "views.raw_224.source_native")
        image = _letterbox_224(_load_rgb(path, "views.raw_224.source_native"))
        return image, {
            "display_sha256": sha256_bytes(_png_bytes(image)),
            "source_sha256": expected,
            "status": "derived_for_review",
        }
    raise ReviewCardError(f"views.{view_name}: unsupported status {status!r}")


def parse_bbox(value: Any, *, page_size: tuple[int, int]) -> tuple[int, int, int, int]:
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(not isinstance(item, int) or isinstance(item, bool) for item in value)
    ):
        raise ReviewCardError("source bbox must contain four integers")
    left, top, right, bottom = value
    if not (0 <= left < right <= page_size[0] and 0 <= top < bottom <= page_size[1]):
        raise ReviewCardError("source bbox is outside the decoded page")
    return left, top, right, bottom


def _font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def _fit_image(
    canvas: Image.Image,
    image: Image.Image,
    box: tuple[int, int, int, int],
    *,
    background: tuple[int, int, int] = WHITE,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    canvas.paste(background, box)
    scale = min((right - left) / image.width, (bottom - top) / image.height)
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    resized = image.resize((width, height), Image.Resampling.LANCZOS)
    x = left + (right - left - width) // 2
    y = top + (bottom - top - height) // 2
    canvas.paste(resized, (x, y))
    return x, y, x + width, y + height


def _draw_label(
    draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, size: int = 26
) -> None:
    draw.text(xy, text, font=_font(size), fill=DARK)


def _draw_wrapped(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    *,
    size: int = 24,
    fill: tuple[int, int, int] = MID,
) -> None:
    left, top, right, bottom = box
    font = _font(size)
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if draw.textbbox((0, 0), trial, font=font)[2] <= right - left:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    line_height = size + 8
    for index, line in enumerate(lines):
        y = top + index * line_height
        if y + line_height > bottom:
            break
        draw.text((left, y), line, font=font, fill=fill)


def _local_context(
    page: Image.Image, bbox: tuple[int, int, int, int]
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    padding_x = max(80, round(width * 1.5))
    padding_y = max(80, round(height * 1.5))
    crop = (
        max(0, left - padding_x),
        max(0, top - padding_y),
        min(page.width, right + padding_x),
        min(page.height, bottom + padding_y),
    )
    local = page.crop(crop)
    local_bbox = (left - crop[0], top - crop[1], right - crop[0], bottom - crop[1])
    return local, local_bbox


def _draw_bbox_on_fitted(
    draw: ImageDraw.ImageDraw,
    fitted: tuple[int, int, int, int],
    source_size: tuple[int, int],
    bbox: tuple[int, int, int, int],
    *,
    width: int,
) -> None:
    x1, y1, x2, y2 = fitted
    sx = (x2 - x1) / source_size[0]
    sy = (y2 - y1) / source_size[1]
    left, top, right, bottom = bbox
    draw.rectangle(
        (
            round(x1 + left * sx),
            round(y1 + top * sy),
            round(x1 + right * sx),
            round(y1 + bottom * sy),
        ),
        outline=CYAN,
        width=width,
    )


def load_render(
    render: Mapping[str, Any],
    *,
    render_bank_root: Path,
    identity_terms: Sequence[str],
) -> tuple[Image.Image, dict[str, Any]]:
    artifact = require_mapping(render.get("artifact"), "render.artifact")
    if artifact.get("qa_overlay") is not False:
        raise ReviewCardError("render artifact unexpectedly contains a QA overlay")
    if (
        require_mapping(render.get("readiness"), "render.readiness").get(
            "document_fonts_ready"
        )
        is not True
    ):
        raise ReviewCardError("render artifact was captured before fonts were ready")
    if (
        require_mapping(
            render.get("fallback_detection"), "render.fallback_detection"
        ).get("status")
        != "passed"
    ):
        raise ReviewCardError("render artifact failed fallback detection")
    relative = safe_relative_path(artifact.get("file"), "render.artifact.file")
    _assert_no_identity_leak(relative, identity_terms, "render artifact path")
    path = resolve_inside(render_bank_root, relative, "render.artifact.file")
    expected = require_sha(artifact.get("sha256"), "render.artifact.sha256")
    _assert_hash(path, expected, "render artifact")
    image = _load_rgb(path, "render artifact")
    if [image.width, image.height] != [artifact.get("width"), artifact.get("height")]:
        raise ReviewCardError("render artifact decoded dimensions disagree")
    return image, {
        "artifact_sha256": expected,
        "probe_id": require_id(render.get("probe_id"), "render.probe_id"),
        "render_id": require_id(render.get("render_id"), "render.render_id"),
        "writing_mode": require_text(render.get("writing_mode"), "render.writing_mode"),
    }


def _assert_no_identity_leak(value: str, terms: Sequence[str], location: str) -> None:
    lowered = value.casefold()
    for term in terms:
        normalized = term.strip().casefold()
        if len(normalized) >= 3 and normalized in lowered:
            raise ReviewCardError(f"{location}: font identity leaked into blind output")


def _card_id(assignment_id: str, renderer_hash: str) -> str:
    digest = _stable_hash("manga-font-review-card-v1", assignment_id, renderer_hash)
    return f"fmrc-{digest[:32]}"


def build_card(
    assignment: Mapping[str, Any],
    master: Mapping[str, Any],
    inputs: LoadedInputs,
    *,
    base_root: Path,
    hard_root: Path,
    library_root: Path,
    render_bank_root: Path,
) -> tuple[bytes, dict[str, Any]]:
    sample_id = str(assignment["sample_id"])
    page_record = require_mapping(master.get("page"), f"master[{sample_id}].page")
    locator = require_mapping(
        page_record.get("source_locator"), f"master[{sample_id}].page.source_locator"
    )
    if locator.get("storage_root") != "library_root":
        raise ReviewCardError("source page must resolve against library_root")
    page_relative = safe_relative_path(locator.get("path"), "source page path")
    page_path = resolve_inside(library_root, page_relative, "source page path")
    page_sha = require_sha(locator.get("file_sha256"), "source page file_sha256")
    if page_sha != assignment["source_page_sha256"]:
        raise ReviewCardError("source page locator and assignment hashes disagree")
    _assert_hash(page_path, page_sha, "source page")
    page_image = _load_rgb(page_path, "source page")

    geometry = require_mapping(master.get("geometry"), f"master[{sample_id}].geometry")
    bbox_value = geometry.get("final_bbox_px") or geometry.get("bbox_px")
    bbox = parse_bbox(bbox_value, page_size=page_image.size)
    metadata = require_mapping(master.get("metadata"), f"master[{sample_id}].metadata")
    orientation = metadata.get("orientation")
    if orientation not in {"horizontal", "vertical"}:
        raise ReviewCardError(f"master[{sample_id}]: unsupported orientation")

    catalog_id = require_text(
        require_mapping(
            master.get("provenance"), f"master[{sample_id}].provenance"
        ).get("source_catalog_id"),
        f"master[{sample_id}].provenance.source_catalog_id",
    )
    catalog_roots = {
        "fontclip-accepted-v1": base_root,
        "fontclip-hard-accepted-v2": hard_root,
    }
    if catalog_id not in catalog_roots:
        raise ReviewCardError(f"master[{sample_id}]: unsupported source catalog")
    views_value = require_mapping(master.get("views"), f"master[{sample_id}].views")
    views: dict[str, Image.Image | None] = {}
    public_views: dict[str, dict[str, Any]] = {}
    for view_name in ("raw_224", "context_224", "glyph_224"):
        image, public = load_view(
            view_name,
            views_value.get(view_name),
            catalog_roots=catalog_roots,
        )
        views[view_name] = image
        public_views[view_name] = public

    reference_images: list[dict[str, Any]] = []
    public_work_references: dict[str, Any] | None = None
    reference_target = inputs.work_references_by_target.get(sample_id)
    if reference_target is not None:
        public_reference_items: list[dict[str, Any]] = []
        for reference_value in reference_target["references"]:
            reference = require_mapping(reference_value, "work reference")
            reference_views = require_mapping(
                reference.get("views"), "work reference.views"
            )
            loaded_images: dict[str, Image.Image | None] = {}
            loaded_public: dict[str, dict[str, Any]] = {}
            for view_name in ("raw_224", "context_224", "glyph_224"):
                image, public = load_view(
                    view_name,
                    reference_views.get(view_name),
                    catalog_roots=catalog_roots,
                )
                loaded_images[view_name] = image
                loaded_public[view_name] = public
            reference_images.append(
                {
                    "blind_alias": reference["blind_alias"],
                    "orientation": reference["orientation"],
                    "images": loaded_images,
                }
            )
            public_reference_items.append(
                {
                    "blind_alias": reference["blind_alias"],
                    "orientation": reference["orientation"],
                    "role": "dialogue",
                    "sample_crop_sha256": reference["sample_crop_sha256"],
                    "views": loaded_public,
                }
            )
        public_work_references = {
            "anonymous": True,
            "count": len(public_reference_items),
            "evidence_policy": "high-confidence-finalized-ordinary-dialogue",
            "reference_set_sha256": reference_target["record_sha256"],
            "items": public_reference_items,
        }

    candidate_panels: list[dict[str, Any]] = []
    candidate_images: list[list[tuple[Image.Image, dict[str, Any]]]] = []
    order = assignment["candidate_order"]
    if not set(order).issubset(inputs.canonical_by_font_id):
        raise ReviewCardError(
            "assignment contains a non-canonical render family"
        )
    for position, font_id in enumerate(order, 1):
        candidate = inputs.canonical_by_font_id[font_id]
        alias = require_id(candidate.get("blind_alias"), "canonical blind_alias")
        status_value = require_mapping(
            candidate.get("production_asset_status"),
            "canonical production_asset_status",
        )
        allowed_modes = candidate.get("allowed_writing_modes")
        if not isinstance(allowed_modes, list):
            raise ReviewCardError("canonical allowed_writing_modes is invalid")
        panel_status = "rendered"
        status_code: str | None = None
        rendered_probes: list[tuple[Image.Image, dict[str, Any]]] = []
        if status_value.get("chromium_ots_compatible") is not True:
            panel_status = "production_asset_unrenderable"
            status_code = require_text(
                status_value.get("code"), "canonical status code"
            )
        elif orientation not in allowed_modes:
            panel_status = "orientation_unrenderable"
            status_code = "writing-mode-not-supported"
        else:
            display_id = require_text(
                candidate.get("display_id"), "canonical display_id"
            )
            for probe_id in PROBE_IDS:
                render = inputs.render_by_key.get((display_id, probe_id, orientation))
                if render is None:
                    raise ReviewCardError(
                        f"canonical blind candidate lacks required {probe_id}/{orientation} render"
                    )
                rendered_probes.append(
                    load_render(
                        render,
                        render_bank_root=render_bank_root,
                        identity_terms=inputs.identity_terms,
                    )
                )
        candidate_images.append(rendered_probes)
        candidate_panels.append(
            {
                "blind_alias": alias,
                "position": position,
                "probes": [metadata for _, metadata in rendered_probes],
                "status": panel_status,
                "status_code": status_code,
            }
        )

    card = Image.new("RGB", (CARD_WIDTH, CARD_HEIGHT), PALE)
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 0, CARD_WIDTH, 118), fill=CYAN)
    draw.text((48, 22), "REVIEW-ONLY / QA OVERLAY", font=_font(50), fill=BLACK)
    draw.text(
        (1370, 34),
        f"{assignment['stage'].upper()}  |  {orientation.upper()}  |  {sample_id}",
        font=_font(28),
        fill=BLACK,
    )

    # Full-page context and local zoom, both marked in cyan rather than red.
    draw.rectangle((34, 144, 826, 1116), fill=WHITE, outline=MID, width=3)
    _draw_label(draw, (52, 154), "SOURCE PAGE + CYAN BBOX", 27)
    page_fit = _fit_image(card, page_image, (52, 198, 808, 1096))
    _draw_bbox_on_fitted(draw, page_fit, page_image.size, bbox, width=8)

    local, local_bbox = _local_context(page_image, bbox)
    draw.rectangle((850, 144, 1506, 622), fill=WHITE, outline=MID, width=3)
    _draw_label(draw, (868, 154), "LOCAL CONTEXT", 27)
    local_fit = _fit_image(card, local, (868, 198, 1488, 604))
    _draw_bbox_on_fitted(draw, local_fit, local.size, local_bbox, width=8)

    view_boxes = {
        "raw_224": (850, 650, 1138, 1032),
        "context_224": (1166, 650, 1454, 1032),
        "glyph_224": (1482, 650, 1770, 1032),
    }
    for view_name, box in view_boxes.items():
        draw.rectangle(box, fill=WHITE, outline=MID, width=3)
        _draw_label(draw, (box[0] + 12, box[1] + 10), view_name.upper(), 24)
        image = views[view_name]
        if image is None:
            _draw_wrapped(
                draw,
                (box[0] + 22, box[1] + 130, box[2] - 22, box[3] - 22),
                "UNAVAILABLE",
                size=28,
            )
        else:
            _fit_image(
                card, image, (box[0] + 18, box[1] + 58, box[2] - 18, box[3] - 18)
            )

    draw.rectangle((1796, 144, 2366, 1032), fill=WHITE, outline=MID, width=3)
    if reference_images:
        _draw_label(draw, (1818, 162), "ANONYMOUS SAME-WORK DIALOGUE", 24)
        draw.text(
            (1818, 198),
            "REFERENCE EVIDENCE ONLY / FONT NAMES HIDDEN",
            font=_font(17),
            fill=MID,
        )
        for reference_index, reference in enumerate(reference_images):
            top = 228 + reference_index * 254
            bottom = top + 238
            draw.rectangle((1814, top, 2348, bottom), fill=PALE, outline=MID, width=2)
            draw.text(
                (1828, top + 10),
                f"R{reference_index + 1}  {reference['orientation'].upper()}  ORDINARY DIALOGUE",
                font=_font(20),
                fill=DARK,
            )
            for view_index, view_name in enumerate(("raw_224", "glyph_224")):
                left = 1828 + view_index * 254
                right = left + 238
                draw.text(
                    (left, top + 44),
                    "RAW" if view_name == "raw_224" else "GLYPH",
                    font=_font(16),
                    fill=MID,
                )
                image = reference["images"][view_name]
                if image is None:
                    _draw_wrapped(
                        draw,
                        (left, top + 70, right, bottom - 10),
                        "UNAVAILABLE",
                        size=20,
                    )
                else:
                    _fit_image(card, image, (left, top + 68, right, bottom - 10))
        draw.text(
            (1818, 1000),
            "Use only for work-anchor consistency; ignore for SFX overrides.",
            font=_font(16),
            fill=MID,
        )
    else:
        _draw_label(draw, (1818, 166), "BLIND REVIEW BINDING", 29)
        info_lines = (
            f"CARD: {_card_id(str(assignment['assignment_id']), inputs.renderer_hash)}",
            f"ASSIGNMENT: {assignment['assignment_id']}",
            f"STAGE: {assignment['stage']}",
            f"ORIENTATION: {orientation}",
            f"BBOX: {','.join(str(value) for value in bbox)}",
            f"PAGE SHA: {page_sha[:20]}...",
            f"ORDER SEED: {assignment['candidate_order_seed'][:20]}...",
            "FONT NAMES: HIDDEN",
            "MODEL PROPOSALS: HIDDEN",
            "CHECK ROLE / STYLE / TREATMENT",
            f"TIER ALL {len(order)}; none_acceptable IS VALID",
            "CONFIDENCE < 0.75 => low_confidence",
            "BAD SOURCE => crop_needs_review",
            "BROKEN RENDER => rendering_issue",
            "CYAN BOX: REVIEW ONLY",
            "DO NOT USE THIS CARD FOR TRAINING",
        )
        y = 218
        for line in info_lines:
            _draw_wrapped(draw, (1818, y, 2340, y + 48), line, size=21, fill=DARK)
            y += 50

    # Opaque candidates, exactly in the assignment's seeded order. The fixed
    # card geometry intentionally caps one card at MAX_CARD_CANDIDATES.
    grid_top = 1150
    cell_width = 770
    cell_height = 424
    gap_x = 18
    gap_y = 16
    for index, (panel, probes) in enumerate(zip(candidate_panels, candidate_images)):
        row = index // 3
        column = index % 3
        left = 32 + column * (cell_width + gap_x)
        top = grid_top + row * (cell_height + gap_y)
        right = left + cell_width
        bottom = top + cell_height
        draw.rectangle((left, top, right, bottom), fill=WHITE, outline=MID, width=3)
        draw.rectangle((left, top, right, top + 62), fill=(226, 239, 245))
        draw.text(
            (left + 18, top + 14),
            f"{panel['position']:02d}  {panel['blind_alias']}",
            font=_font(28),
            fill=DARK,
        )
        if panel["status"] != "rendered":
            draw.rectangle(
                (left + 24, top + 92, right - 24, bottom - 28), outline=CYAN, width=5
            )
            _draw_wrapped(
                draw,
                (left + 58, top + 160, right - 58, bottom - 60),
                f"UNRENDERABLE  {panel['status']}  {panel['status_code']}",
                size=31,
                fill=DARK,
            )
            continue
        probe_gap = 12
        probe_width = (cell_width - 36 - probe_gap * (len(probes) - 1)) // len(probes)
        for probe_index, (probe_image, probe_meta) in enumerate(probes):
            probe_left = left + 18 + probe_index * (probe_width + probe_gap)
            probe_right = probe_left + probe_width
            _draw_label(draw, (probe_left + 6, top + 78), probe_meta["probe_id"], 22)
            _fit_image(
                card, probe_image, (probe_left, top + 112, probe_right, bottom - 18)
            )

    draw.rectangle((0, CARD_HEIGHT - 110, CARD_WIDTH, CARD_HEIGHT), fill=DARK)
    draw.text(
        (42, CARD_HEIGHT - 83),
        "REVIEW-ONLY  |  qa_overlay=true  |  candidate identity withheld until explicit reveal",
        font=_font(30),
        fill=CYAN,
    )
    payload = _png_bytes(card)
    card_id = _card_id(str(assignment["assignment_id"]), inputs.renderer_hash)
    relative = f"cards/{assignment['assignment_id']}.png"
    _assert_no_identity_leak(relative, inputs.identity_terms, "card path")
    record = {
        "artifact": {
            "file": relative,
            "height": CARD_HEIGHT,
            "qa_overlay": True,
            "sha256": sha256_bytes(payload),
            "watermark": "REVIEW-ONLY",
            "width": CARD_WIDTH,
        },
        "assignment": {
            "assignment_id": assignment["assignment_id"],
            "blind_candidate_order": [
                panel["blind_alias"] for panel in candidate_panels
            ],
            "candidate_order_seed": assignment["candidate_order_seed"],
            "catalog_version": assignment["catalog_version"],
            "sample_id": sample_id,
            "stage": assignment["stage"],
        },
        "candidates": candidate_panels,
        "card_id": card_id,
        "schema_version": SCHEMA_VERSION,
        "source": {
            "bbox_px": list(bbox),
            "orientation": orientation,
            "sample_crop_sha256": require_sha(
                master.get("sample_crop_sha256"), "sample crop hash"
            ),
            "source_page_sha256": page_sha,
            "views": public_views,
        },
    }
    if public_work_references is not None:
        record["work_references"] = public_work_references
    return payload, record


def _public_manifest(
    inputs: LoadedInputs, config: RunConfig, cards: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    reference_count = sum(
        int(card.get("work_references", {}).get("count", 0)) for card in cards
    )
    return {
        "blindness_contract": {
            "candidate_identity_fields_present": False,
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "public_candidates_use_blind_alias_only": True,
            "reveal_map_embedded": False,
            "same_work_references_anonymous": True,
        },
        "card_render_contract": {
            "canvas_px": [CARD_WIDTH, CARD_HEIGHT],
            "cyan_bbox_rgb": list(CYAN),
            "engine": "Pillow",
            "pillow_version": PILLOW_VERSION,
            "probe_ids": list(PROBE_IDS),
            "watermark": "REVIEW-ONLY",
        },
        "card_count": len(cards),
        "cards": list(cards),
        "configuration": config.as_dict(),
        "input_hashes": dict(sorted(inputs.input_hashes.items())),
        "purpose": "blind_visual_review_qa_only",
        "qa_overlay": True,
        "renderer_hash": inputs.renderer_hash,
        "schema_version": SCHEMA_VERSION,
        "training_asset": False,
        "work_reference_count": reference_count,
    }


def _public_report(manifest: Mapping[str, Any], manifest_sha256: str) -> dict[str, Any]:
    cards = manifest["cards"]
    statuses: dict[str, int] = {}
    for card in cards:
        for candidate in card["candidates"]:
            status = candidate["status"]
            statuses[status] = statuses.get(status, 0) + 1
    return {
        "checks": {
            "blind_identity_leaks": 0,
            "exactly_one_card_per_selected_assignment": True,
            "qa_overlay_cards": len(cards),
            "review_only_watermark_required": True,
            "training_assets_copied_or_modified": 0,
        },
        "manifest_sha256": manifest_sha256,
        "schema_version": REPORT_VERSION,
        "summary": {
            "by_candidate_status": dict(sorted(statuses.items())),
            "card_count": len(cards),
            "unique_assignment_count": len(
                {card["assignment"]["assignment_id"] for card in cards}
            ),
            "unique_sample_count": len(
                {card["assignment"]["sample_id"] for card in cards}
            ),
            "work_reference_count": sum(
                int(card.get("work_references", {}).get("count", 0)) for card in cards
            ),
        },
    }


def _assert_safe_output_target(output_dir: Path) -> None:
    resolved = output_dir.resolve()
    if resolved == Path(resolved.anchor) or len(resolved.name) < 3:
        raise ReviewCardError(f"refusing unsafe output target: {output_dir}")
    if output_dir.exists() and output_dir.is_symlink():
        raise ReviewCardError("refusing a symlink output directory")


def _assert_disjoint_output(output_dir: Path, protected_roots: Sequence[Path]) -> None:
    output = output_dir.resolve()
    for protected_value in protected_roots:
        protected = protected_value.resolve()
        if (
            output == protected
            or protected in output.parents
            or output in protected.parents
        ):
            raise ReviewCardError(
                f"review-card output must be disjoint from protected input root: {protected}"
            )


def _assert_owned_output(output_dir: Path) -> None:
    marker_path = output_dir / MARKER_FILE
    if not marker_path.is_file():
        raise ReviewCardError(f"refusing unowned review-card output: {output_dir}")
    marker = read_json(marker_path, "review-card ownership marker")
    if marker.get("owner") != OWNER or marker.get("schema_version") != SCHEMA_VERSION:
        raise ReviewCardError("review-card ownership marker is invalid")


def _assert_replaceable(output_dir: Path) -> None:
    _assert_safe_output_target(output_dir)
    if not output_dir.exists():
        return
    if not output_dir.is_dir():
        raise ReviewCardError("review-card output exists and is not a directory")
    if any(output_dir.iterdir()):
        _assert_owned_output(output_dir)


def _atomic_replace_directory(output_dir: Path, staging: Path) -> None:
    backup = output_dir.with_name(f".{output_dir.name}.backup-{os.getpid()}")
    if backup.exists():
        raise ReviewCardError(f"refusing existing backup path: {backup}")
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
            raise ReviewCardError("internal backup escaped output parent")
        shutil.rmtree(backup)


def _expected_files(manifest: Mapping[str, Any]) -> set[str]:
    return {
        MARKER_FILE,
        MANIFEST_FILE,
        REPORT_FILE,
        *(card["artifact"]["file"] for card in manifest["cards"]),
    }


def _list_files(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }


def build_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    inventory: Path,
    assignments: Path,
    render_bank_manifest: Path,
    base_root: Path,
    hard_root: Path,
    library_root: Path,
    config: RunConfig,
    work_reference_manifest: Path | None = None,
) -> dict[str, Any]:
    render_bank_root = render_bank_manifest.parent
    protected = (
        master_manifest.parent,
        inventory.parent,
        assignments.parent,
        render_bank_root,
        base_root,
        hard_root,
        library_root,
        *((work_reference_manifest,) if work_reference_manifest else ()),
    )
    _assert_disjoint_output(output_dir, protected)
    _assert_replaceable(output_dir)
    inputs = load_inputs(
        master_manifest=master_manifest,
        inventory=inventory,
        assignments=assignments,
        render_bank_manifest=render_bank_manifest,
        work_reference_manifest=work_reference_manifest,
    )
    selected = select_assignments(inputs, config)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    completed = False
    try:
        (staging / "cards").mkdir()
        card_rows: list[dict[str, Any]] = []
        for assignment in selected:
            payload, record = build_card(
                assignment,
                inputs.master_by_id[str(assignment["sample_id"])],
                inputs,
                base_root=base_root,
                hard_root=hard_root,
                library_root=library_root,
                render_bank_root=render_bank_root,
            )
            relative = record["artifact"]["file"]
            destination = staging.joinpath(*PurePosixPath(relative).parts)
            destination.write_bytes(payload)
            card_rows.append(record)
        manifest = _public_manifest(inputs, config, card_rows)
        _assert_no_public_identity_leak(manifest, inputs.identity_terms)
        manifest_payload = json_bytes(manifest)
        report = _public_report(manifest, sha256_bytes(manifest_payload))
        report_payload = json_bytes(report)
        marker = {
            "manifest_sha256": sha256_bytes(manifest_payload),
            "owner": OWNER,
            "report_sha256": sha256_bytes(report_payload),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MANIFEST_FILE).write_bytes(manifest_payload)
        (staging / REPORT_FILE).write_bytes(report_payload)
        (staging / MARKER_FILE).write_bytes(json_bytes(marker))
        validate_output(
            output_dir=staging,
            master_manifest=master_manifest,
            inventory=inventory,
            assignments=assignments,
            render_bank_manifest=render_bank_manifest,
            base_root=base_root,
            hard_root=hard_root,
            library_root=library_root,
            expected_config=config,
            work_reference_manifest=work_reference_manifest,
        )
        _atomic_replace_directory(output_dir, staging)
        completed = True
        return report
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)


def _assert_no_public_identity_leak(
    value: Any, terms: Sequence[str], location: str = "public manifest"
) -> None:
    _assert_no_identity_leak(canonical_json(value), terms, location)


def config_from_manifest(manifest: Mapping[str, Any]) -> RunConfig:
    value = require_mapping(manifest.get("configuration"), "manifest.configuration")
    limit = value.get("limit")
    if limit is not None and (
        not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0
    ):
        raise ReviewCardError("manifest.configuration.limit is invalid")
    return RunConfig(
        stage=require_text(value.get("stage"), "manifest.configuration.stage"),
        batch=require_text(value.get("batch"), "manifest.configuration.batch"),
        limit=limit,
    )


def validate_output(
    *,
    output_dir: Path,
    master_manifest: Path,
    inventory: Path,
    assignments: Path,
    render_bank_manifest: Path,
    base_root: Path,
    hard_root: Path,
    library_root: Path,
    expected_config: RunConfig | None = None,
    work_reference_manifest: Path | None = None,
) -> dict[str, Any]:
    _assert_owned_output(output_dir)
    manifest_path = output_dir / MANIFEST_FILE
    report_path = output_dir / REPORT_FILE
    marker = read_json(output_dir / MARKER_FILE, "ownership marker")
    manifest = read_json(manifest_path, "card manifest")
    report = read_json(report_path, "card report")
    manifest_payload = manifest_path.read_bytes()
    report_payload = report_path.read_bytes()
    if (
        marker.get("manifest_sha256") != sha256_bytes(manifest_payload)
        or marker.get("report_sha256") != sha256_bytes(report_payload)
        or report.get("manifest_sha256") != sha256_bytes(manifest_payload)
    ):
        raise ReviewCardError("review-card metadata hash binding failed")
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or report.get("schema_version") != REPORT_VERSION
    ):
        raise ReviewCardError("review-card schema version is unsupported")
    config = config_from_manifest(manifest)
    if expected_config is not None and config != expected_config:
        raise ReviewCardError("review-card configuration differs from requested check")

    inputs = load_inputs(
        master_manifest=master_manifest,
        inventory=inventory,
        assignments=assignments,
        render_bank_manifest=render_bank_manifest,
        work_reference_manifest=work_reference_manifest,
    )
    if manifest.get("input_hashes") != dict(sorted(inputs.input_hashes.items())):
        raise ReviewCardError("review-card input hashes are stale")
    if manifest.get("renderer_hash") != inputs.renderer_hash:
        raise ReviewCardError("review-card renderer hash is stale")
    _assert_no_public_identity_leak(manifest, inputs.identity_terms)
    cards = manifest.get("cards")
    if not isinstance(cards, list):
        raise ReviewCardError("review-card manifest cards are invalid")
    selected = select_assignments(inputs, config)
    if len(cards) != len(selected):
        raise ReviewCardError("selected assignment/card count mismatch")
    recorded_ids = [card.get("assignment", {}).get("assignment_id") for card in cards]
    expected_ids = [row["assignment_id"] for row in selected]
    if recorded_ids != expected_ids or len(recorded_ids) != len(set(recorded_ids)):
        raise ReviewCardError("cards are not exactly-once in selected assignment order")

    expected_files = _expected_files(manifest)
    actual_files = _list_files(output_dir)
    if expected_files != actual_files:
        raise ReviewCardError(
            "review-card file inventory mismatch; "
            f"missing={sorted(expected_files - actual_files)[:8]}; "
            f"unexpected={sorted(actual_files - expected_files)[:8]}"
        )
    rebuilt_rows: list[dict[str, Any]] = []
    for assignment, recorded in zip(selected, cards):
        payload, rebuilt = build_card(
            assignment,
            inputs.master_by_id[str(assignment["sample_id"])],
            inputs,
            base_root=base_root,
            hard_root=hard_root,
            library_root=library_root,
            render_bank_root=render_bank_manifest.parent,
        )
        if rebuilt != recorded:
            raise ReviewCardError(
                f"card manifest row is stale: {assignment['assignment_id']}"
            )
        card_path = resolve_inside(
            output_dir, rebuilt["artifact"]["file"], "card artifact"
        )
        if card_path.read_bytes() != payload:
            raise ReviewCardError(
                f"card PNG is not deterministic: {assignment['assignment_id']}"
            )
        rebuilt_rows.append(rebuilt)
    rebuilt_manifest = _public_manifest(inputs, config, rebuilt_rows)
    rebuilt_payload = json_bytes(rebuilt_manifest)
    if rebuilt_payload != manifest_payload:
        raise ReviewCardError("review-card manifest is not the deterministic rebuild")
    rebuilt_report = _public_report(rebuilt_manifest, sha256_bytes(rebuilt_payload))
    if json_bytes(rebuilt_report) != report_payload:
        raise ReviewCardError("review-card report is not the deterministic rebuild")
    return {
        "card_count": len(cards),
        "manifest_sha256": sha256_bytes(manifest_payload),
        "status": "valid",
    }


def build_reveal_map(
    *,
    render_bank_manifest: Path,
    review_cards_dir: Path,
    output_dir: Path,
    acknowledgement: str,
) -> dict[str, Any]:
    if acknowledgement != UNBLIND_ACKNOWLEDGEMENT:
        raise ReviewCardError(
            f"reveal requires --acknowledge-unblind {UNBLIND_ACKNOWLEDGEMENT}"
        )
    _assert_owned_output(review_cards_dir)
    _assert_safe_output_target(output_dir)
    _assert_disjoint_output(output_dir, (review_cards_dir, render_bank_manifest.parent))
    bank = read_json(render_bank_manifest, "render bank manifest")
    card_manifest = read_json(review_cards_dir / MANIFEST_FILE, "review cards")
    input_hashes = require_mapping(
        card_manifest.get("input_hashes"), "review cards.input_hashes"
    )
    if input_hashes.get("render_bank_manifest_sha256") != sha256_file(
        render_bank_manifest
    ):
        raise ReviewCardError("reveal render bank differs from the reviewed bank")
    cards = card_manifest.get("cards")
    if not isinstance(cards, list) or not cards:
        raise ReviewCardError("review cards contain no candidate evidence")
    reviewed_aliases: set[str] = set()
    for card_index, card_value in enumerate(cards, 1):
        card = require_mapping(card_value, f"review cards.cards[{card_index}]")
        card_candidates = card.get("candidates")
        if not isinstance(card_candidates, list) or not card_candidates:
            raise ReviewCardError(
                f"review cards.cards[{card_index}].candidates is invalid"
            )
        for candidate_index, candidate_value in enumerate(card_candidates, 1):
            candidate = require_mapping(
                candidate_value,
                f"review cards.cards[{card_index}].candidates[{candidate_index}]",
            )
            reviewed_aliases.add(
                require_id(candidate.get("blind_alias"), "reviewed blind_alias")
            )
    candidates = bank.get("candidates")
    if not isinstance(candidates, list):
        raise ReviewCardError("render bank candidates are invalid")
    canonical = [
        dict(require_mapping(value, "render bank candidate"))
        for value in candidates
        if (
            isinstance(value, Mapping)
            and _candidate_is_canonical(value)
            and value.get("blind_alias") in reviewed_aliases
        )
    ]
    if {
        require_id(value.get("blind_alias"), "canonical blind_alias")
        for value in canonical
    } != reviewed_aliases:
        raise ReviewCardError("review cards reference a non-canonical blind alias")
    payload = {
        "authorization": "explicit-post-review-unblind",
        "mappings": [
            {
                "blind_alias": require_id(
                    value.get("blind_alias"), "reveal blind_alias"
                ),
                "font_id": require_id(value.get("font_id"), "reveal font_id"),
                "font_label": require_text(
                    value.get("font_label"), "reveal font_label"
                ),
            }
            for value in sorted(canonical, key=lambda item: str(item["blind_alias"]))
        ],
        "render_bank_manifest_sha256": sha256_file(render_bank_manifest),
        "review_card_manifest_sha256": sha256_file(review_cards_dir / MANIFEST_FILE),
        "schema_version": REVEAL_SCHEMA_VERSION,
    }
    reveal_bytes = json_bytes(payload)
    marker = {
        "owner": REVEAL_OWNER,
        "reveal_map_sha256": sha256_bytes(reveal_bytes),
        "safe_replace": True,
        "schema_version": REVEAL_SCHEMA_VERSION,
    }
    if output_dir.exists():
        if output_dir.is_symlink() or not output_dir.is_dir():
            raise ReviewCardError("refusing unsafe reveal-map output")
        if any(output_dir.iterdir()):
            marker_path = output_dir / REVEAL_MARKER_FILE
            if not marker_path.is_file():
                raise ReviewCardError("refusing unowned reveal-map output")
            existing = read_json(marker_path, "reveal ownership marker")
            if (
                existing.get("owner") != REVEAL_OWNER
                or existing.get("schema_version") != REVEAL_SCHEMA_VERSION
            ):
                raise ReviewCardError("reveal ownership marker is invalid")
            unknown = _list_files(output_dir) - {REVEAL_FILE, REVEAL_MARKER_FILE}
            if unknown:
                raise ReviewCardError("reveal output contains unmanaged files")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    completed = False
    try:
        (staging / REVEAL_FILE).write_bytes(reveal_bytes)
        (staging / REVEAL_MARKER_FILE).write_bytes(json_bytes(marker))
        _atomic_replace_directory(output_dir, staging)
        completed = True
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)
    return {
        "mapping_count": len(canonical),
        "reveal_map_sha256": sha256_bytes(reveal_bytes),
    }


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def add_input_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--assignments", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--base-root", type=Path, required=True)
    parser.add_argument("--hard-root", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--work-reference-manifest", type=Path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build")
    add_input_arguments(build)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument(
        "--stage", choices=("primary", "secondary", "all"), default="primary"
    )
    build.add_argument(
        "--batch", choices=("all", "pilot", "calibration"), default="all"
    )
    build.add_argument("--limit", type=positive_int)
    build.add_argument("--check", action="store_true")

    validate = subparsers.add_parser("validate")
    add_input_arguments(validate)
    validate.add_argument("--output-dir", type=Path, required=True)

    reveal = subparsers.add_parser("reveal")
    reveal.add_argument("--render-bank-manifest", type=Path, required=True)
    reveal.add_argument("--review-cards-dir", type=Path, required=True)
    reveal.add_argument("--output-dir", type=Path, required=True)
    reveal.add_argument("--acknowledge-unblind", required=True)
    return parser


def _resolved_input_kwargs(args: argparse.Namespace) -> dict[str, Path]:
    values = {
        "master_manifest": args.master_manifest.resolve(),
        "inventory": args.inventory.resolve(),
        "assignments": args.assignments.resolve(),
        "render_bank_manifest": args.render_bank_manifest.resolve(),
        "base_root": args.base_root.resolve(),
        "hard_root": args.hard_root.resolve(),
        "library_root": args.library_root.resolve(),
    }
    if args.work_reference_manifest is not None:
        values["work_reference_manifest"] = args.work_reference_manifest.resolve()
    return values


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "reveal":
            result = build_reveal_map(
                render_bank_manifest=args.render_bank_manifest.resolve(),
                review_cards_dir=args.review_cards_dir.resolve(),
                output_dir=args.output_dir.resolve(),
                acknowledgement=args.acknowledge_unblind,
            )
        elif args.command == "validate":
            result = validate_output(
                output_dir=args.output_dir.resolve(),
                **_resolved_input_kwargs(args),
            )
        else:
            config = RunConfig(stage=args.stage, batch=args.batch, limit=args.limit)
            kwargs = {
                "output_dir": args.output_dir.resolve(),
                **_resolved_input_kwargs(args),
            }
            result = (
                validate_output(expected_config=config, **kwargs)
                if args.check
                else build_output(config=config, **kwargs)
            )
        print(canonical_json(result))
        return 0
    except (ReviewCardError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
