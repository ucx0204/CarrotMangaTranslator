#!/usr/bin/env python3
"""Deterministic, resumable execution ledger for exhaustive font review.

The label semantics live in :mod:`font_matching_labels`.  This module adds the
operational layer required to review a large immutable corpus safely:

* one primary task for every master row and an exactly stratified secondary set;
* private font IDs paired with reviewer-facing blind aliases;
* page, crop, view, card, catalog, and renderer hash bindings;
* atomic batch claim/release/submit operations guarded by an exclusive lock;
* reviewer-independent secondary work;
* deterministic adjudication queues and exactly-once final projections; and
* resumable validation/progress reports.

Review-card input contract (``manifest.json`` from the review-card builder)::

    {
      "schema_version": "font-matching-review-card-v1",
      "renderer_hash": "...",
      "training_asset": false,
      "qa_overlay": true,
      "cards": [{
        "assignment": {
          "assignment_id": "fmra-...", "sample_id": "fm_...",
          "stage": "primary", "catalog_version": "...",
          "candidate_order_seed": "...",
          "blind_candidate_order": ["ko-candidate-..."]
        },
        "source": {
          "source_page_sha256": "...", "sample_crop_sha256": "...",
          "views": {"raw_224": {
            "status": "available", "source_sha256": "...",
            "display_sha256": "..."
          }}
        },
        "artifact": {"file": "cards/...png", "sha256": "...",
                     "qa_overlay": true, "watermark": "REVIEW-ONLY"}
      }]
    }

``card_path`` is resolved relative to the card manifest.  Review cards are QA
artifacts and must be explicitly marked review-only; they are never accepted as
training inputs.  The strict adapter is intentionally small so the independent
card builder can target it without sharing mutable state with this ledger.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import font_matching_labels as labels  # noqa: E402


SCHEMA_VERSION = 1
WORKSPACE_RECORD_TYPE = "manga_font_review_workspace"
EXECUTION_ASSIGNMENT_TYPE = "manga_font_review_execution_assignment"
CARD_SCHEMA_VERSION = "font-matching-review-card-v1"
CLAIM_EVENT_TYPE = "manga_font_review_claim_event"
PUBLIC_CLAIM_TYPE = "manga_font_review_claim"
REVIEW_RESPONSE_TYPE = "manga_font_review_response"
ADJUDICATION_RESPONSE_TYPE = "manga_font_adjudication_response"

WORKSPACE_FILE = "workspace.json"
ASSIGNMENTS_FILE = "assignments.jsonl"
CLAIMS_FILE = "claims.jsonl"
REVIEWS_FILE = "reviews.jsonl"
FINALS_FILE = "finals.jsonl"
QUEUE_FILE = "adjudication-queue.jsonl"
PROGRESS_FILE = "progress.json"
LOCK_FILE = ".font-matching-review-ledger.lock"
OWNER_FILE = ".font-matching-review-ledger-owner.json"

EXPECTED_PRIMARY = 28_115
EXPECTED_SECONDARY = 5_623
EXPECTED_CANDIDATES = 15
DEFAULT_LOW_CONFIDENCE = 0.75
DEFAULT_STYLE_TOLERANCE = 0.15

SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")


class ReviewLedgerError(ValueError):
    """Raised when an execution artifact violates the frozen contract."""


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise ReviewLedgerError(f"could not read {path}: {error}") from error
    with handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def parse_timestamp(value: Any, *, location: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ReviewLedgerError(f"{location} must be an RFC3339 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReviewLedgerError(f"{location} is not a valid timestamp") from error
    if parsed.tzinfo is None:
        raise ReviewLedgerError(f"{location} must include a timezone")
    return parsed.astimezone(timezone.utc)


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ReviewLedgerError(f"{location} must be an object")
    return value


def require_exact_keys(
    value: Mapping[str, Any], required: set[str], *, location: str
) -> None:
    missing = sorted(required - set(value))
    extra = sorted(set(value) - required)
    if missing or extra:
        raise ReviewLedgerError(
            f"{location} has invalid keys: missing={missing}, unexpected={extra}"
        )


def require_text(value: Any, *, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise ReviewLedgerError(f"{location} must be a non-empty string")
    return value


def require_id(value: Any, *, location: str) -> str:
    text = require_text(value, location=location)
    if SAFE_ID_RE.fullmatch(text) is None:
        raise ReviewLedgerError(f"{location} is not a safe identifier")
    return text


def require_sha(value: Any, *, location: str) -> str:
    text = require_text(value, location=location)
    if SHA_RE.fullmatch(text) is None:
        raise ReviewLedgerError(f"{location} must be a lowercase SHA-256")
    return text


def require_bool(value: Any, *, location: str) -> bool:
    if not isinstance(value, bool):
        raise ReviewLedgerError(f"{location} must be boolean")
    return value


def require_unit(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReviewLedgerError(f"{location} must be numeric")
    output = float(value)
    if not math.isfinite(output) or not 0.0 <= output <= 1.0:
        raise ReviewLedgerError(f"{location} must be between 0 and 1")
    return output


def require_portable_path(value: Any, *, location: str) -> str:
    text = require_text(value, location=location).replace("\\", "/")
    path = PurePosixPath(text)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ReviewLedgerError(f"{location} must be a safe relative POSIX path")
    if not path.parts:
        raise ReviewLedgerError(f"{location} must not be empty")
    return path.as_posix()


def nested(value: Mapping[str, Any], *parts: str) -> Any:
    current: Any = value
    for part in parts:
        if not isinstance(current, Mapping) or part not in current:
            return None
        current = current[part]
    return current


def seal(record: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(record))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def validate_seal(record: Mapping[str, Any], *, location: str) -> None:
    declared = require_sha(
        record.get("record_sha256"), location=f"{location}.record_sha256"
    )
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    expected = sha256_bytes(canonical_json_bytes(core))
    if declared != expected:
        raise ReviewLedgerError(f"{location}.record_sha256 content binding failed")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReviewLedgerError(f"could not read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise ReviewLedgerError(f"{path} must contain a JSON object")
    return value


def read_jsonl(path: Path, *, missing_ok: bool = False) -> list[dict[str, Any]]:
    if missing_ok and not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as error:
        raise ReviewLedgerError(f"could not read {path}: {error}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ReviewLedgerError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, dict):
                raise ReviewLedgerError(f"{path}:{line_number}: expected object")
            rows.append(value)
    return rows


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


@contextmanager
def workspace_lock(workspace: Path, *, timeout_seconds: float = 10.0) -> Iterator[None]:
    """Acquire an inter-process exclusive lock using O_EXCL creation."""

    lock_path = workspace / LOCK_FILE
    deadline = time.monotonic() + timeout_seconds
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise ReviewLedgerError(
                    f"workspace is locked by another process: {lock_path}"
                )
            time.sleep(0.05)
    try:
        os.write(
            descriptor,
            canonical_json_bytes(
                {"pid": os.getpid(), "created_at": timestamp(utc_now())}, pretty=True
            ),
        )
        os.close(descriptor)
        descriptor = None
        yield
    finally:
        if descriptor is not None:
            os.close(descriptor)
        lock_path.unlink(missing_ok=True)


@dataclass(frozen=True)
class MasterBinding:
    sample: labels.ReviewSample
    chapter_id: str
    page_id: str
    split: str
    sample_crop_sha256: str
    view_sha256: Mapping[str, str | None]
    manual_recrop: bool
    cohorts: tuple[str, ...]


@dataclass(frozen=True)
class CandidateBinding:
    candidate_id: str
    blind_alias: str


@dataclass(frozen=True)
class CardBinding:
    assignment_id: str
    sample_id: str
    stage: str
    catalog_version: str
    source_page_sha256: str
    sample_crop_sha256: str
    view_sha256: Mapping[str, str]
    source_view_sha256: Mapping[str, str]
    candidate_order_seed: str
    candidate_aliases: tuple[str, ...]
    card_path: str
    review_card_sha256: str


def _master_view_hash(row: Mapping[str, Any], name: str) -> str | None:
    descriptor = require_mapping(nested(row, "views", name), location=f"views.{name}")
    direct = descriptor.get("file_sha256")
    if direct is not None:
        return require_sha(direct, location=f"views.{name}.file_sha256")
    native = descriptor.get("source_native")
    if isinstance(native, Mapping) and native.get("file_sha256") is not None:
        return require_sha(
            native.get("file_sha256"),
            location=f"views.{name}.source_native.file_sha256",
        )
    return None


def read_master_manifest(path: Path) -> tuple[list[MasterBinding], str]:
    bindings: list[MasterBinding] = []
    digest = hashlib.sha256()
    seen: set[str] = set()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise ReviewLedgerError(
            f"could not read master manifest {path}: {error}"
        ) from error
    with handle:
        for line_number, payload in enumerate(handle, 1):
            digest.update(payload)
            if not payload.strip():
                continue
            try:
                row = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ReviewLedgerError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            row = require_mapping(row, location=f"master[{line_number}]")
            sample_id = require_id(row.get("id"), location=f"master[{line_number}].id")
            if sample_id in seen:
                raise ReviewLedgerError(f"duplicate master sample_id: {sample_id}")
            seen.add(sample_id)
            if nested(row, "provenance", "qa_overlay") is not False:
                raise ReviewLedgerError(
                    f"{sample_id}: QA overlay cannot enter review input"
                )
            if nested(row, "provenance", "synthetic") is not False:
                raise ReviewLedgerError(
                    f"{sample_id}: synthetic row cannot enter review input"
                )
            work_id = require_id(
                nested(row, "work", "id"), location=f"{sample_id}.work.id"
            )
            source_page_sha = require_sha(
                nested(row, "page", "source_page_sha256"),
                location=f"{sample_id}.page.source_page_sha256",
            )
            # Candidate IDs are injected after the frozen render-bank audit.
            sample = labels.ReviewSample(
                sample_id=sample_id,
                work_id=work_id,
                source_page_sha256=source_page_sha,
                candidate_ids=(),
            )
            cohort_signals = nested(row, "metadata", "cohort_signals")
            if not isinstance(cohort_signals, Mapping):
                cohort_signals = {}
            categories = nested(row, "metadata", "candidate_categories")
            if not isinstance(categories, list):
                categories = []
            bindings.append(
                MasterBinding(
                    sample=sample,
                    chapter_id=require_id(
                        nested(row, "chapter", "id"), location=f"{sample_id}.chapter.id"
                    ),
                    page_id=require_id(
                        nested(row, "page", "id"), location=f"{sample_id}.page.id"
                    ),
                    split=require_text(row.get("split"), location=f"{sample_id}.split"),
                    sample_crop_sha256=require_sha(
                        row.get("sample_crop_sha256"),
                        location=f"{sample_id}.sample_crop_sha256",
                    ),
                    view_sha256={
                        name: _master_view_hash(row, name)
                        for name in ("raw_224", "context_224", "glyph_224")
                    },
                    manual_recrop=bool(cohort_signals.get("manual_recrop") is True),
                    cohorts=tuple(sorted(str(value) for value in categories)),
                )
            )
    if not bindings:
        raise ReviewLedgerError("master manifest is empty")
    return bindings, digest.hexdigest()


def read_render_bank(
    path: Path, *, expected_candidates: int
) -> tuple[tuple[CandidateBinding, ...], str, str]:
    manifest = read_json(path)
    manifest_sha = sha256_file(path)
    specification_sha = require_sha(
        manifest.get("specification_sha256"),
        location="render_bank.specification_sha256",
    )
    candidates_value = manifest.get("candidates")
    if not isinstance(candidates_value, list):
        raise ReviewLedgerError("render_bank.candidates must be an array")
    canonical: list[CandidateBinding] = []
    for index, raw in enumerate(candidates_value):
        candidate = require_mapping(raw, location=f"render_bank.candidates[{index}]")
        if candidate.get("production_400_normal_canonical") is not True:
            continue
        canonical.append(
            CandidateBinding(
                candidate_id=require_id(
                    candidate.get("font_id"),
                    location=f"render_bank.candidates[{index}].font_id",
                ),
                blind_alias=require_id(
                    candidate.get("blind_alias"),
                    location=f"render_bank.candidates[{index}].blind_alias",
                ),
            )
        )
    if len(canonical) != expected_candidates:
        raise ReviewLedgerError(
            f"expected {expected_candidates} canonical candidates, got {len(canonical)}"
        )
    ids = [item.candidate_id for item in canonical]
    aliases = [item.blind_alias for item in canonical]
    if len(ids) != len(set(ids)) or len(aliases) != len(set(aliases)):
        raise ReviewLedgerError("canonical candidate IDs and aliases must be unique")
    return (
        tuple(sorted(canonical, key=lambda item: item.candidate_id)),
        manifest_sha,
        specification_sha,
    )


def _card_view_hashes(value: Any, *, location: str) -> dict[str, str]:
    mapping = require_mapping(value, location=location)
    required = {"raw_224", "context_224", "glyph_224"}
    require_exact_keys(mapping, required, location=location)
    return {
        name: require_sha(mapping.get(name), location=f"{location}.{name}")
        for name in sorted(required)
    }


def _parse_public_card_views(
    value: Any, *, location: str
) -> tuple[dict[str, str], dict[str, str]]:
    views = require_mapping(value, location=location)
    required_names = {"raw_224", "context_224", "glyph_224"}
    require_exact_keys(views, required_names, location=location)
    display: dict[str, str] = {}
    source: dict[str, str] = {}
    for name in sorted(required_names):
        view = require_mapping(views.get(name), location=f"{location}.{name}")
        require_exact_keys(
            view,
            {"status", "source_sha256", "display_sha256"},
            location=f"{location}.{name}",
        )
        status = require_text(view.get("status"), location=f"{location}.{name}.status")
        if status not in {"available", "derived_for_review"}:
            raise ReviewLedgerError(
                f"{location}.{name} is not available for exhaustive review"
            )
        source[name] = require_sha(
            view.get("source_sha256"), location=f"{location}.{name}.source_sha256"
        )
        display[name] = require_sha(
            view.get("display_sha256"), location=f"{location}.{name}.display_sha256"
        )
    return display, source


def parse_card_binding(value: Mapping[str, Any], *, location: str) -> CardBinding:
    required = {
        "artifact",
        "assignment",
        "candidates",
        "card_id",
        "schema_version",
        "source",
    }
    require_exact_keys(value, required, location=location)
    if value.get("schema_version") != CARD_SCHEMA_VERSION:
        raise ReviewLedgerError(f"{location}.schema_version is invalid")
    require_id(value.get("card_id"), location=f"{location}.card_id")
    assignment = require_mapping(
        value.get("assignment"), location=f"{location}.assignment"
    )
    require_exact_keys(
        assignment,
        {
            "assignment_id",
            "blind_candidate_order",
            "candidate_order_seed",
            "catalog_version",
            "sample_id",
            "stage",
        },
        location=f"{location}.assignment",
    )
    stage = require_text(
        assignment.get("stage"), location=f"{location}.assignment.stage"
    )
    if stage not in labels.REVIEW_STAGES:
        raise ReviewLedgerError(f"{location}.assignment.stage is invalid")
    require_id(
        assignment.get("catalog_version"),
        location=f"{location}.assignment.catalog_version",
    )
    aliases = assignment.get("blind_candidate_order")
    if not isinstance(aliases, list) or not aliases:
        raise ReviewLedgerError(
            f"{location}.assignment.blind_candidate_order must be non-empty"
        )
    normalized_aliases = tuple(
        require_id(
            alias, location=f"{location}.assignment.blind_candidate_order[{index}]"
        )
        for index, alias in enumerate(aliases)
    )
    if len(normalized_aliases) != len(set(normalized_aliases)):
        raise ReviewLedgerError(f"{location} repeats a blind alias")
    candidates_value = value.get("candidates")
    if not isinstance(candidates_value, list) or len(candidates_value) != len(
        normalized_aliases
    ):
        raise ReviewLedgerError(f"{location}.candidates has wrong length")
    panel_aliases: list[str] = []
    for index, raw in enumerate(candidates_value):
        candidate = require_mapping(raw, location=f"{location}.candidates[{index}]")
        # Candidate panels intentionally contain no font identity fields.
        if (
            "font_id" in candidate
            or "font_label" in candidate
            or "candidate_id" in candidate
        ):
            raise ReviewLedgerError(
                f"{location}.candidates[{index}] leaks font identity"
            )
        panel_aliases.append(
            require_id(
                candidate.get("blind_alias"),
                location=f"{location}.candidates[{index}].blind_alias",
            )
        )
        if candidate.get("position") != index + 1:
            raise ReviewLedgerError(
                f"{location}.candidates[{index}].position is invalid"
            )
        if candidate.get("status") not in {
            "rendered",
            "production_asset_unrenderable",
            "orientation_unrenderable",
        }:
            raise ReviewLedgerError(f"{location}.candidates[{index}].status is invalid")
    if tuple(panel_aliases) != normalized_aliases:
        raise ReviewLedgerError(
            f"{location} panel order differs from blind candidate order"
        )
    source_value = require_mapping(value.get("source"), location=f"{location}.source")
    require_exact_keys(
        source_value,
        {"bbox_px", "orientation", "sample_crop_sha256", "source_page_sha256", "views"},
        location=f"{location}.source",
    )
    if source_value.get("orientation") not in {"horizontal", "vertical"}:
        raise ReviewLedgerError(f"{location}.source.orientation is invalid")
    bbox = source_value.get("bbox_px")
    if (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or any(isinstance(item, bool) or not isinstance(item, int) for item in bbox)
    ):
        raise ReviewLedgerError(f"{location}.source.bbox_px is invalid")
    display_views, source_views = _parse_public_card_views(
        source_value.get("views"), location=f"{location}.source.views"
    )
    artifact = require_mapping(value.get("artifact"), location=f"{location}.artifact")
    for key in ("file", "height", "qa_overlay", "sha256", "watermark", "width"):
        if key not in artifact:
            raise ReviewLedgerError(f"{location}.artifact is missing {key}")
    if (
        artifact.get("qa_overlay") is not True
        or artifact.get("watermark") != "REVIEW-ONLY"
    ):
        raise ReviewLedgerError(f"{location}.artifact is not review-only QA")
    return CardBinding(
        assignment_id=require_id(
            assignment.get("assignment_id"),
            location=f"{location}.assignment.assignment_id",
        ),
        sample_id=require_id(
            assignment.get("sample_id"), location=f"{location}.assignment.sample_id"
        ),
        stage=stage,
        catalog_version=require_id(
            assignment.get("catalog_version"),
            location=f"{location}.assignment.catalog_version",
        ),
        source_page_sha256=require_sha(
            source_value.get("source_page_sha256"),
            location=f"{location}.source.source_page_sha256",
        ),
        sample_crop_sha256=require_sha(
            source_value.get("sample_crop_sha256"),
            location=f"{location}.source.sample_crop_sha256",
        ),
        view_sha256=display_views,
        source_view_sha256=source_views,
        candidate_order_seed=require_sha(
            assignment.get("candidate_order_seed"),
            location=f"{location}.assignment.candidate_order_seed",
        ),
        candidate_aliases=normalized_aliases,
        card_path=require_portable_path(
            artifact.get("file"), location=f"{location}.artifact.file"
        ),
        review_card_sha256=require_sha(
            artifact.get("sha256"), location=f"{location}.artifact.sha256"
        ),
    )


def read_card_manifest(
    path: Path,
) -> tuple[dict[str, CardBinding], str, str, Mapping[str, str]]:
    manifest = read_json(path)
    if manifest.get("schema_version") != CARD_SCHEMA_VERSION:
        raise ReviewLedgerError("card manifest schema is unsupported")
    if (
        manifest.get("qa_overlay") is not True
        or manifest.get("training_asset") is not False
    ):
        raise ReviewLedgerError("card manifest must be review-only QA")
    blindness = require_mapping(
        manifest.get("blindness_contract"), location="card_manifest.blindness_contract"
    )
    if (
        blindness.get("candidate_identity_fields_present") is not False
        or blindness.get("font_names_visible") is not False
        or blindness.get("model_suggestions_visible") is not False
        or blindness.get("public_candidates_use_blind_alias_only") is not True
        or blindness.get("reveal_map_embedded") is not False
    ):
        raise ReviewLedgerError("card manifest blindness contract is invalid")
    rows = manifest.get("cards")
    if not isinstance(rows, list):
        raise ReviewLedgerError("card_manifest.cards must be an array")
    if manifest.get("card_count") != len(rows):
        raise ReviewLedgerError("card manifest count differs from cards array")
    output: dict[str, CardBinding] = {}
    for index, row in enumerate(rows, 1):
        card = parse_card_binding(
            require_mapping(row, location=f"cards[{index}]"), location=f"cards[{index}]"
        )
        if card.assignment_id in output:
            raise ReviewLedgerError(
                f"card manifest repeats assignment {card.assignment_id!r}"
            )
        output[card.assignment_id] = card
    if not output:
        raise ReviewLedgerError("card manifest is empty")
    input_hashes_value = require_mapping(
        manifest.get("input_hashes"), location="card_manifest.input_hashes"
    )
    input_hashes = {
        str(key): require_sha(value, location=f"card_manifest.input_hashes.{key}")
        for key, value in input_hashes_value.items()
    }
    renderer_hash = require_sha(
        manifest.get("renderer_hash"), location="card_manifest.renderer_hash"
    )
    return output, sha256_file(path), renderer_hash, input_hashes


def read_priority_inventory(
    path: Path | None,
) -> tuple[dict[str, Mapping[str, Any]], str | None]:
    if path is None:
        return {}, None
    output: dict[str, Mapping[str, Any]] = {}
    master_hashes: set[str] = set()
    for index, row in enumerate(read_jsonl(path), 1):
        sample_id = require_id(
            row.get("sample_id"), location=f"inventory[{index}].sample_id"
        )
        if sample_id in output:
            raise ReviewLedgerError(f"priority inventory repeats {sample_id!r}")
        batches = require_mapping(
            row.get("batches"), location=f"inventory[{index}].batches"
        )
        output[sample_id] = copy.deepcopy(dict(batches))
        master_hashes.add(
            require_sha(
                row.get("master_manifest_sha256"),
                location=f"inventory[{index}].master_manifest_sha256",
            )
        )
    if len(master_hashes) != 1:
        raise ReviewLedgerError("priority inventory must bind one master manifest")
    return output, next(iter(master_hashes))


def _review_order_key(
    assignment: labels.ReviewAssignment,
    master: MasterBinding,
    batches: Mapping[str, Any],
    *,
    allocation_seed: str,
) -> tuple[Any, ...]:
    # Calibration is the P2 warm-up and pilot remains the schema-calibration
    # subset.  Page keys keep visual context adjacent after these frozen ranks.
    calibration = batches.get("calibration")
    pilot = batches.get("pilot")
    calibration_rank = (
        int(calibration.get("review_order"))
        if isinstance(calibration, Mapping)
        and isinstance(calibration.get("review_order"), int)
        else 10**9
    )
    pilot_rank = (
        int(pilot.get("review_order"))
        if isinstance(pilot, Mapping) and isinstance(pilot.get("review_order"), int)
        else 10**9
    )
    priority = 0 if calibration_rank < 10**9 else (1 if pilot_rank < 10**9 else 2)
    return (
        0 if assignment.stage == "primary" else 1,
        priority,
        calibration_rank,
        pilot_rank,
        master.work_id if hasattr(master, "work_id") else master.sample.work_id,
        master.chapter_id,
        master.page_id,
        stable_hash(
            "font-matching-review-order-v1",
            allocation_seed,
            assignment.stage,
            assignment.sample_id,
        ),
        assignment.assignment_id,
    )


def _validate_card_against_assignment(
    card: CardBinding,
    assignment: labels.ReviewAssignment,
    master: MasterBinding,
    candidate_alias: Mapping[str, str],
    *,
    card_root: Path,
    verify_file: bool,
) -> None:
    expected_scalars = {
        "assignment_id": assignment.assignment_id,
        "sample_id": assignment.sample_id,
        "stage": assignment.stage,
        "catalog_version": assignment.catalog_version,
        "source_page_sha256": assignment.source_page_sha256,
        "sample_crop_sha256": master.sample_crop_sha256,
        "candidate_order_seed": assignment.candidate_order_seed,
    }
    for field, expected in expected_scalars.items():
        if getattr(card, field) != expected:
            raise ReviewLedgerError(
                f"card {card.assignment_id}: {field} does not match assignment"
            )
    expected_aliases = tuple(
        candidate_alias[candidate_id] for candidate_id in assignment.candidate_order
    )
    if card.candidate_aliases != expected_aliases:
        raise ReviewLedgerError(
            f"card {card.assignment_id}: candidate order/alias binding differs"
        )
    for name in ("raw_224", "context_224", "glyph_224"):
        expected = master.view_sha256[name]
        if expected is None or card.source_view_sha256[name] != expected:
            raise ReviewLedgerError(
                f"card {card.assignment_id}: {name} source hash differs from master"
            )
    if verify_file:
        resolved_root = card_root.resolve()
        resolved = (resolved_root / Path(card.card_path)).resolve()
        try:
            resolved.relative_to(resolved_root)
        except ValueError as error:
            raise ReviewLedgerError(
                f"card {card.assignment_id}: card_path escapes card root"
            ) from error
        if not resolved.is_file():
            raise ReviewLedgerError(f"card artifact is missing: {resolved}")
        if sha256_file(resolved) != card.review_card_sha256:
            raise ReviewLedgerError(
                f"card {card.assignment_id}: artifact SHA-256 mismatch"
            )


def _execution_assignment_row(
    assignment: labels.ReviewAssignment,
    master: MasterBinding,
    card: CardBinding,
    batches: Mapping[str, Any],
    *,
    review_order: int,
    catalog_sha256: str,
    renderer_hash: str,
) -> dict[str, Any]:
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": EXECUTION_ASSIGNMENT_TYPE,
            "review_order": review_order,
            "assignment": assignment.as_dict(),
            "chapter_id": master.chapter_id,
            "page_id": master.page_id,
            "split": master.split,
            "sample_crop_sha256": master.sample_crop_sha256,
            "view_sha256": dict(card.view_sha256),
            "review_card_sha256": card.review_card_sha256,
            "card_path": card.card_path,
            "catalog_sha256": catalog_sha256,
            "renderer_hash": renderer_hash,
            "candidate_alias_order": list(card.candidate_aliases),
            "manual_recrop": master.manual_recrop,
            "cohorts": list(master.cohorts),
            "priority_batches": copy.deepcopy(dict(batches)),
            "provenance": {"qa_overlay": True, "review_only": True, "synthetic": False},
        }
    )


def initialize_workspace(
    *,
    workspace: Path,
    master_manifest: Path,
    card_manifest: Path,
    font_catalog: Path,
    render_bank: Path,
    catalog_version: str,
    allocation_seed: str,
    priority_inventory: Path | None = None,
    expected_primary: int = EXPECTED_PRIMARY,
    expected_secondary: int = EXPECTED_SECONDARY,
    expected_candidates: int = EXPECTED_CANDIDATES,
    verify_card_files: bool = True,
) -> dict[str, Any]:
    """Create a fresh deterministic workspace after validating every binding."""

    require_id(catalog_version, location="catalog_version")
    require_text(allocation_seed, location="allocation_seed")
    if workspace.exists() and any(workspace.iterdir()):
        raise ReviewLedgerError(f"workspace must be empty: {workspace}")
    workspace.mkdir(parents=True, exist_ok=True)

    masters, master_sha = read_master_manifest(master_manifest)
    if len(masters) != expected_primary:
        raise ReviewLedgerError(
            f"expected {expected_primary} primary samples, got {len(masters)}"
        )
    canonical, render_bank_sha, _specification_sha = read_render_bank(
        render_bank, expected_candidates=expected_candidates
    )
    catalog_sha = sha256_file(font_catalog)
    render_document = read_json(render_bank)
    source_catalog_sha = nested(render_document, "source_contract", "manifest_sha256")
    if source_catalog_sha != catalog_sha:
        raise ReviewLedgerError(
            "render bank source contract does not bind the supplied font catalog"
        )
    candidate_ids = tuple(item.candidate_id for item in canonical)
    candidate_alias = {item.candidate_id: item.blind_alias for item in canonical}
    samples = [
        labels.ReviewSample(
            sample_id=item.sample.sample_id,
            work_id=item.sample.work_id,
            source_page_sha256=item.sample.source_page_sha256,
            candidate_ids=candidate_ids,
        )
        for item in masters
    ]
    double_fraction = expected_secondary / expected_primary if expected_primary else 0.0
    assignments = labels.build_blind_review_assignments(
        samples,
        catalog_version=catalog_version,
        allocation_seed=allocation_seed,
        double_review_fraction=double_fraction,
    )
    observed_secondary = sum(item.stage == "secondary" for item in assignments)
    if observed_secondary != expected_secondary:
        raise ReviewLedgerError(
            f"secondary allocation must be exactly {expected_secondary}, got {observed_secondary}"
        )
    if expected_secondary >= len({item.sample.work_id for item in masters}):
        secondary_works = {
            item.work_id for item in assignments if item.stage == "secondary"
        }
        all_works = {item.sample.work_id for item in masters}
        if secondary_works != all_works:
            raise ReviewLedgerError(
                "secondary allocation is not stratified across all works"
            )

    cards, card_manifest_sha, card_renderer_hash, card_input_hashes = (
        read_card_manifest(card_manifest)
    )
    if set(cards) != {item.assignment_id for item in assignments}:
        missing = sorted({item.assignment_id for item in assignments} - set(cards))
        extra = sorted(set(cards) - {item.assignment_id for item in assignments})
        raise ReviewLedgerError(
            f"cards must cover assignments exactly once: missing={missing[:8]}, extra={extra[:8]}"
        )
    priorities, priority_master_sha = read_priority_inventory(priority_inventory)
    if priority_master_sha is not None and priority_master_sha != master_sha:
        raise ReviewLedgerError("priority inventory binds a different master manifest")
    unknown_priority = sorted(
        set(priorities) - {item.sample.sample_id for item in masters}
    )
    if unknown_priority:
        raise ReviewLedgerError(
            f"priority inventory contains unknown samples: {unknown_priority[:8]}"
        )
    expected_card_inputs = {
        "master_manifest_sha256": master_sha,
        "render_bank_manifest_sha256": render_bank_sha,
        "assignments_sha256": sha256_bytes(
            jsonl_bytes(assignment.as_dict() for assignment in assignments)
        ),
    }
    if priority_inventory is not None:
        expected_card_inputs["inventory_sha256"] = sha256_file(priority_inventory)
    for key, expected_hash in expected_card_inputs.items():
        if card_input_hashes.get(key) != expected_hash:
            raise ReviewLedgerError(
                f"card manifest {key} does not bind the supplied input"
            )

    master_by_id = {item.sample.sample_id: item for item in masters}
    for assignment in assignments:
        _validate_card_against_assignment(
            cards[assignment.assignment_id],
            assignment,
            master_by_id[assignment.sample_id],
            candidate_alias,
            card_root=card_manifest.parent,
            verify_file=verify_card_files,
        )
    ordered = sorted(
        assignments,
        key=lambda item: _review_order_key(
            item,
            master_by_id[item.sample_id],
            priorities.get(item.sample_id, {}),
            allocation_seed=allocation_seed,
        ),
    )
    rows = [
        _execution_assignment_row(
            assignment,
            master_by_id[assignment.sample_id],
            cards[assignment.assignment_id],
            priorities.get(assignment.sample_id, {}),
            review_order=index,
            catalog_sha256=catalog_sha,
            renderer_hash=card_renderer_hash,
        )
        for index, assignment in enumerate(ordered, 1)
    ]
    assignment_payload = jsonl_bytes(rows)
    source_paths = {
        "master_manifest": str(master_manifest.resolve()),
        "card_manifest": str(card_manifest.resolve()),
        "font_catalog": str(font_catalog.resolve()),
        "render_bank": str(render_bank.resolve()),
        "priority_inventory": str(priority_inventory.resolve())
        if priority_inventory is not None
        else None,
    }
    workspace_record = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": WORKSPACE_RECORD_TYPE,
            "catalog_version": catalog_version,
            "allocation_seed": allocation_seed,
            "expected": {
                "primary": expected_primary,
                "secondary": expected_secondary,
                "candidates": expected_candidates,
            },
            "counts": {
                "samples": len(masters),
                "assignments": len(rows),
                "works": len({item.sample.work_id for item in masters}),
                "manual_recrops": sum(item.manual_recrop for item in masters),
            },
            "inputs": {
                "master_manifest_sha256": master_sha,
                "card_manifest_sha256": card_manifest_sha,
                "font_catalog_sha256": catalog_sha,
                "render_bank_sha256": render_bank_sha,
                "priority_inventory_sha256": sha256_file(priority_inventory)
                if priority_inventory is not None
                else None,
            },
            "source_paths": source_paths,
            "assignments_sha256": sha256_bytes(assignment_payload),
            "renderer_hash": card_renderer_hash,
            "low_confidence_threshold": DEFAULT_LOW_CONFIDENCE,
            "style_tolerance": DEFAULT_STYLE_TOLERANCE,
        }
    )
    atomic_write(workspace / ASSIGNMENTS_FILE, assignment_payload)
    atomic_write(
        workspace / WORKSPACE_FILE, canonical_json_bytes(workspace_record, pretty=True)
    )
    atomic_write(
        workspace / OWNER_FILE,
        canonical_json_bytes(
            {
                "schema_version": SCHEMA_VERSION,
                "owner": "font_matching_review_ledger.py",
                "workspace_record_sha256": workspace_record["record_sha256"],
            },
            pretty=True,
        ),
    )
    for name in (CLAIMS_FILE, REVIEWS_FILE, FINALS_FILE, QUEUE_FILE):
        atomic_write(workspace / name, b"")
    report = progress_report(workspace, verify_static_inputs=False)
    atomic_write(workspace / PROGRESS_FILE, canonical_json_bytes(report, pretty=True))
    return report


def write_assignment_plan(
    *,
    master_manifest: Path,
    render_bank: Path,
    assignments_output: Path,
    inventory_output: Path,
    report_output: Path,
    catalog_version: str,
    allocation_seed: str,
    base_priority_inventory: Path | None = None,
    expected_primary: int = EXPECTED_PRIMARY,
    expected_secondary: int = EXPECTED_SECONDARY,
    expected_candidates: int = EXPECTED_CANDIDATES,
) -> dict[str, Any]:
    """Write the canonical full-corpus inputs consumed by the card builder.

    This breaks the intentional two-phase workflow cleanly: the ledger owns
    assignment allocation first, the card builder renders those immutable
    assignments, and :func:`initialize_workspace` verifies the returned cards
    against the same deterministic plan before any reviewer can claim work.
    """

    require_id(catalog_version, location="catalog_version")
    require_text(allocation_seed, location="allocation_seed")
    masters, master_sha = read_master_manifest(master_manifest)
    if len(masters) != expected_primary:
        raise ReviewLedgerError(
            f"expected {expected_primary} primary samples, got {len(masters)}"
        )
    canonical, render_sha, _spec_sha = read_render_bank(
        render_bank, expected_candidates=expected_candidates
    )
    candidates = tuple(item.candidate_id for item in canonical)
    samples = [
        labels.ReviewSample(
            sample_id=item.sample.sample_id,
            work_id=item.sample.work_id,
            source_page_sha256=item.sample.source_page_sha256,
            candidate_ids=candidates,
        )
        for item in masters
    ]
    fraction = expected_secondary / expected_primary if expected_primary else 0.0
    assignments = labels.build_blind_review_assignments(
        samples,
        catalog_version=catalog_version,
        allocation_seed=allocation_seed,
        double_review_fraction=fraction,
    )
    secondary_count = sum(item.stage == "secondary" for item in assignments)
    if secondary_count != expected_secondary:
        raise ReviewLedgerError(
            f"secondary allocation must be exactly {expected_secondary}, got {secondary_count}"
        )
    priorities, priority_master_sha = read_priority_inventory(base_priority_inventory)
    if priority_master_sha is not None and priority_master_sha != master_sha:
        raise ReviewLedgerError("base priority inventory binds another master")
    unknown = sorted(set(priorities) - {item.sample.sample_id for item in masters})
    if unknown:
        raise ReviewLedgerError(
            f"base priority inventory contains unknown samples: {unknown[:8]}"
        )
    assignment_payload = jsonl_bytes(item.as_dict() for item in assignments)
    inventory_rows = [
        {
            "schema_version": SCHEMA_VERSION,
            "sample_id": item.sample.sample_id,
            "work_id": item.sample.work_id,
            "chapter_id": item.chapter_id,
            "page_id": item.page_id,
            "split": item.split,
            "master_manifest_sha256": master_sha,
            "batches": copy.deepcopy(dict(priorities.get(item.sample.sample_id, {}))),
            "provenance": {"qa_overlay": False, "synthetic": False},
        }
        for item in sorted(masters, key=lambda value: value.sample.sample_id)
    ]
    inventory_payload = jsonl_bytes(inventory_rows)
    report = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "manga_font_review_assignment_plan",
        "catalog_version": catalog_version,
        "allocation_seed": allocation_seed,
        "counts": {
            "samples": len(samples),
            "primary": len(samples),
            "secondary": secondary_count,
            "assignments": len(assignments),
            "candidates": len(candidates),
            "works": len({item.work_id for item in samples}),
            "manual_recrops": sum(item.manual_recrop for item in masters),
            "priority_samples": len(priorities),
        },
        "hashes": {
            "master_manifest_sha256": master_sha,
            "render_bank_manifest_sha256": render_sha,
            "assignments_sha256": sha256_bytes(assignment_payload),
            "inventory_sha256": sha256_bytes(inventory_payload),
            "base_priority_inventory_sha256": sha256_file(base_priority_inventory)
            if base_priority_inventory is not None
            else None,
        },
    }
    report = seal(report)
    atomic_write(assignments_output, assignment_payload)
    atomic_write(inventory_output, inventory_payload)
    atomic_write(report_output, canonical_json_bytes(report, pretty=True))
    return report


@dataclass(frozen=True)
class WorkspaceState:
    root: Path
    contract: Mapping[str, Any]
    rows: tuple[Mapping[str, Any], ...]
    assignments: Mapping[str, labels.ReviewAssignment]
    row_by_assignment: Mapping[str, Mapping[str, Any]]
    sample_by_id: Mapping[str, labels.ReviewSample]
    assignments_by_sample: Mapping[str, tuple[labels.ReviewAssignment, ...]]


def _validate_execution_row(
    row: Mapping[str, Any], *, location: str
) -> labels.ReviewAssignment:
    required = {
        "schema_version",
        "record_type",
        "review_order",
        "assignment",
        "chapter_id",
        "page_id",
        "split",
        "sample_crop_sha256",
        "view_sha256",
        "review_card_sha256",
        "card_path",
        "catalog_sha256",
        "renderer_hash",
        "candidate_alias_order",
        "manual_recrop",
        "cohorts",
        "priority_batches",
        "provenance",
        "record_sha256",
    }
    require_exact_keys(row, required, location=location)
    validate_seal(row, location=location)
    if (
        row.get("schema_version") != SCHEMA_VERSION
        or row.get("record_type") != EXECUTION_ASSIGNMENT_TYPE
    ):
        raise ReviewLedgerError(f"{location} has an unsupported execution schema")
    review_order = row.get("review_order")
    if (
        isinstance(review_order, bool)
        or not isinstance(review_order, int)
        or review_order < 1
    ):
        raise ReviewLedgerError(f"{location}.review_order must be a positive integer")
    assignment_value = require_mapping(
        row.get("assignment"), location=f"{location}.assignment"
    )
    try:
        assignment = labels.ReviewAssignment.from_mapping(assignment_value)
    except labels.LabelValidationError as error:
        raise ReviewLedgerError(f"{location}.assignment: {error}") from error
    require_id(row.get("chapter_id"), location=f"{location}.chapter_id")
    require_id(row.get("page_id"), location=f"{location}.page_id")
    require_text(row.get("split"), location=f"{location}.split")
    require_sha(
        row.get("sample_crop_sha256"), location=f"{location}.sample_crop_sha256"
    )
    _card_view_hashes(row.get("view_sha256"), location=f"{location}.view_sha256")
    require_sha(
        row.get("review_card_sha256"), location=f"{location}.review_card_sha256"
    )
    require_portable_path(row.get("card_path"), location=f"{location}.card_path")
    require_sha(row.get("catalog_sha256"), location=f"{location}.catalog_sha256")
    require_sha(row.get("renderer_hash"), location=f"{location}.renderer_hash")
    aliases = row.get("candidate_alias_order")
    if not isinstance(aliases, list) or len(aliases) != len(assignment.candidate_order):
        raise ReviewLedgerError(f"{location}.candidate_alias_order has wrong length")
    normalized_aliases = [
        require_id(value, location=f"{location}.candidate_alias_order[{index}]")
        for index, value in enumerate(aliases)
    ]
    if len(normalized_aliases) != len(set(normalized_aliases)):
        raise ReviewLedgerError(f"{location}.candidate_alias_order contains duplicates")
    require_bool(row.get("manual_recrop"), location=f"{location}.manual_recrop")
    cohorts = row.get("cohorts")
    if not isinstance(cohorts, list) or any(
        not isinstance(item, str) for item in cohorts
    ):
        raise ReviewLedgerError(f"{location}.cohorts must be a string array")
    require_mapping(
        row.get("priority_batches"), location=f"{location}.priority_batches"
    )
    provenance = require_mapping(
        row.get("provenance"), location=f"{location}.provenance"
    )
    require_exact_keys(
        provenance,
        {"qa_overlay", "review_only", "synthetic"},
        location=f"{location}.provenance",
    )
    if provenance != {"qa_overlay": True, "review_only": True, "synthetic": False}:
        raise ReviewLedgerError(f"{location}.provenance must be review-only QA")
    return assignment


def load_workspace(
    workspace: Path,
    *,
    verify_static_inputs: bool = False,
    verify_card_files: bool = False,
) -> WorkspaceState:
    contract = read_json(workspace / WORKSPACE_FILE)
    validate_seal(contract, location="workspace")
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type") != WORKSPACE_RECORD_TYPE
    ):
        raise ReviewLedgerError("workspace contract schema is unsupported")
    rows = read_jsonl(workspace / ASSIGNMENTS_FILE)
    payload = jsonl_bytes(rows)
    if sha256_bytes(payload) != contract.get("assignments_sha256"):
        raise ReviewLedgerError("assignments.jsonl differs from the workspace contract")
    expected = require_mapping(contract.get("expected"), location="workspace.expected")
    expected_primary = expected.get("primary")
    expected_secondary = expected.get("secondary")
    expected_candidates = expected.get("candidates")
    for key, value in (
        ("primary", expected_primary),
        ("secondary", expected_secondary),
        ("candidates", expected_candidates),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ReviewLedgerError(f"workspace.expected.{key} must be non-negative")

    assignment_by_id: dict[str, labels.ReviewAssignment] = {}
    row_by_assignment: dict[str, Mapping[str, Any]] = {}
    review_orders: set[int] = set()
    by_sample: defaultdict[str, list[labels.ReviewAssignment]] = defaultdict(list)
    sample_bindings: dict[str, tuple[str, str, tuple[str, ...]]] = {}
    for index, row in enumerate(rows, 1):
        assignment = _validate_execution_row(row, location=f"assignments[{index}]")
        if assignment.assignment_id in assignment_by_id:
            raise ReviewLedgerError(
                f"duplicate assignment_id: {assignment.assignment_id}"
            )
        order = int(row["review_order"])
        if order in review_orders:
            raise ReviewLedgerError(f"duplicate review_order: {order}")
        review_orders.add(order)
        assignment_by_id[assignment.assignment_id] = assignment
        row_by_assignment[assignment.assignment_id] = row
        by_sample[assignment.sample_id].append(assignment)
        binding = (
            assignment.work_id,
            assignment.source_page_sha256,
            tuple(sorted(assignment.candidate_order)),
        )
        if (
            assignment.sample_id in sample_bindings
            and sample_bindings[assignment.sample_id] != binding
        ):
            raise ReviewLedgerError(
                f"sample binding differs across stages: {assignment.sample_id}"
            )
        sample_bindings[assignment.sample_id] = binding
        if len(assignment.candidate_order) != expected_candidates:
            raise ReviewLedgerError(
                f"assignment {assignment.assignment_id} has wrong candidate count"
            )
    if review_orders != set(range(1, len(rows) + 1)):
        raise ReviewLedgerError("review_order must be a contiguous 1-based sequence")
    primary_count = sum(item.stage == "primary" for item in assignment_by_id.values())
    secondary_count = sum(
        item.stage == "secondary" for item in assignment_by_id.values()
    )
    if primary_count != expected_primary or secondary_count != expected_secondary:
        raise ReviewLedgerError(
            "assignment counts differ from contract: "
            f"primary={primary_count}, secondary={secondary_count}"
        )
    for sample_id, items in by_sample.items():
        stages = [item.stage for item in items]
        if stages.count("primary") != 1 or stages.count("secondary") > 1:
            raise ReviewLedgerError(f"invalid stage allocation for {sample_id}")
    sample_by_id = {
        sample_id: labels.ReviewSample(
            sample_id=sample_id,
            work_id=binding[0],
            source_page_sha256=binding[1],
            candidate_ids=binding[2],
        )
        for sample_id, binding in sample_bindings.items()
    }

    if verify_static_inputs:
        inputs = require_mapping(contract.get("inputs"), location="workspace.inputs")
        paths = require_mapping(
            contract.get("source_paths"), location="workspace.source_paths"
        )
        path_to_hash = {
            "master_manifest": "master_manifest_sha256",
            "card_manifest": "card_manifest_sha256",
            "font_catalog": "font_catalog_sha256",
            "render_bank": "render_bank_sha256",
            "priority_inventory": "priority_inventory_sha256",
        }
        for path_key, hash_key in path_to_hash.items():
            source = paths.get(path_key)
            expected_hash = inputs.get(hash_key)
            if source is None and expected_hash is None:
                continue
            source_path = Path(
                require_text(source, location=f"workspace.source_paths.{path_key}")
            )
            expected_hash = require_sha(
                expected_hash, location=f"workspace.inputs.{hash_key}"
            )
            if sha256_file(source_path) != expected_hash:
                raise ReviewLedgerError(f"static input changed: {source_path}")
        if verify_card_files:
            card_manifest_path = Path(str(paths["card_manifest"]))
            for assignment_id, row in row_by_assignment.items():
                card_path = (
                    card_manifest_path.parent / str(row["card_path"])
                ).resolve()
                if (
                    not card_path.is_file()
                    or sha256_file(card_path) != row["review_card_sha256"]
                ):
                    raise ReviewLedgerError(
                        f"review card artifact changed for {assignment_id}: {card_path}"
                    )

    return WorkspaceState(
        root=workspace,
        contract=contract,
        rows=tuple(rows),
        assignments=assignment_by_id,
        row_by_assignment=row_by_assignment,
        sample_by_id=sample_by_id,
        assignments_by_sample={
            sample_id: tuple(
                sorted(items, key=lambda item: labels.REVIEW_STAGES.index(item.stage))
            )
            for sample_id, items in by_sample.items()
        },
    )


def _validate_claim_event(row: Mapping[str, Any], *, location: str) -> None:
    required = {
        "schema_version",
        "record_type",
        "event_id",
        "action",
        "claim_id",
        "target_kind",
        "target_ids",
        "reviewer",
        "occurred_at",
        "expires_at",
        "record_sha256",
    }
    require_exact_keys(row, required, location=location)
    validate_seal(row, location=location)
    if (
        row.get("schema_version") != SCHEMA_VERSION
        or row.get("record_type") != CLAIM_EVENT_TYPE
    ):
        raise ReviewLedgerError(f"{location} has invalid claim event schema")
    require_id(row.get("event_id"), location=f"{location}.event_id")
    action = row.get("action")
    if action not in {"claim", "release"}:
        raise ReviewLedgerError(f"{location}.action is invalid")
    require_id(row.get("claim_id"), location=f"{location}.claim_id")
    if row.get("target_kind") not in {"primary", "secondary", "adjudication"}:
        raise ReviewLedgerError(f"{location}.target_kind is invalid")
    target_ids = row.get("target_ids")
    if not isinstance(target_ids, list) or not target_ids:
        raise ReviewLedgerError(f"{location}.target_ids must be non-empty")
    normalized = [
        require_id(value, location=f"{location}.target_ids") for value in target_ids
    ]
    if len(normalized) != len(set(normalized)):
        raise ReviewLedgerError(f"{location}.target_ids contains duplicates")
    require_id(row.get("reviewer"), location=f"{location}.reviewer")
    parse_timestamp(row.get("occurred_at"), location=f"{location}.occurred_at")
    expires_at = row.get("expires_at")
    if action == "claim":
        expires = parse_timestamp(expires_at, location=f"{location}.expires_at")
        occurred = parse_timestamp(
            row.get("occurred_at"), location=f"{location}.occurred_at"
        )
        if expires <= occurred:
            raise ReviewLedgerError(f"{location}.expires_at must follow occurred_at")
    elif expires_at is not None:
        raise ReviewLedgerError(f"{location}.expires_at must be null for release")


def read_claim_events(workspace: Path) -> list[dict[str, Any]]:
    rows = read_jsonl(workspace / CLAIMS_FILE, missing_ok=True)
    event_ids: set[str] = set()
    claim_rows: dict[str, Mapping[str, Any]] = {}
    released: set[str] = set()
    for index, row in enumerate(rows, 1):
        _validate_claim_event(row, location=f"claims[{index}]")
        event_id = str(row["event_id"])
        if event_id in event_ids:
            raise ReviewLedgerError(f"duplicate claim event_id: {event_id}")
        event_ids.add(event_id)
        claim_id = str(row["claim_id"])
        if row["action"] == "claim":
            if claim_id in claim_rows:
                raise ReviewLedgerError(f"duplicate claim_id: {claim_id}")
            claim_rows[claim_id] = row
        else:
            if claim_id not in claim_rows:
                raise ReviewLedgerError(f"release targets unknown claim: {claim_id}")
            if claim_id in released:
                raise ReviewLedgerError(f"claim released more than once: {claim_id}")
            original = claim_rows[claim_id]
            if (
                row["reviewer"] != original["reviewer"]
                or row["target_kind"] != original["target_kind"]
                or row["target_ids"] != original["target_ids"]
            ):
                raise ReviewLedgerError(
                    f"release binding differs for claim: {claim_id}"
                )
            released.add(claim_id)
    return rows


def active_claims(
    events: Sequence[Mapping[str, Any]], *, now: datetime
) -> dict[str, Mapping[str, Any]]:
    claims = {str(row["claim_id"]): row for row in events if row["action"] == "claim"}
    released = {str(row["claim_id"]) for row in events if row["action"] == "release"}
    return {
        claim_id: row
        for claim_id, row in claims.items()
        if claim_id not in released
        and parse_timestamp(row["expires_at"], location="claim.expires_at") > now
    }


def unfinished_active_claims(
    active: Mapping[str, Mapping[str, Any]],
    *,
    review_by_assignment: Mapping[str, Mapping[str, Any]],
    final_by_sample: Mapping[str, Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    """Treat a durably submitted batch as consumed without a second-file commit.

    Reviews/finals are the source of truth.  This avoids a fragile two-file
    transaction solely to append a ``complete`` claim event after submission.
    """

    output: dict[str, Mapping[str, Any]] = {}
    for claim_id, claim in active.items():
        targets = [str(value) for value in claim["target_ids"]]
        if claim["target_kind"] in labels.REVIEW_STAGES:
            complete = all(target in review_by_assignment for target in targets)
        else:
            complete = all(target in final_by_sample for target in targets)
        if not complete:
            output[claim_id] = claim
    return output


def _claim_event(
    *,
    action: str,
    claim_id: str,
    target_kind: str,
    target_ids: Sequence[str],
    reviewer: str,
    occurred_at: datetime,
    expires_at: datetime | None,
) -> dict[str, Any]:
    event_id = (
        "fmce-"
        + stable_hash(
            "font-matching-claim-event-v1",
            action,
            claim_id,
            timestamp(occurred_at),
            *target_ids,
        )[:32]
    )
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": CLAIM_EVENT_TYPE,
            "event_id": event_id,
            "action": action,
            "claim_id": claim_id,
            "target_kind": target_kind,
            "target_ids": list(target_ids),
            "reviewer": reviewer,
            "occurred_at": timestamp(occurred_at),
            "expires_at": timestamp(expires_at) if expires_at is not None else None,
        }
    )


def read_reviews(
    state: WorkspaceState, *, require_claim_evidence: bool = True
) -> tuple[list[dict[str, Any]], dict[str, Mapping[str, Any]]]:
    rows = read_jsonl(state.root / REVIEWS_FILE, missing_ok=True)
    by_assignment: dict[str, Mapping[str, Any]] = {}
    label_ids: set[str] = set()
    claim_evidence: set[tuple[str, str]] = set()
    if require_claim_evidence:
        for event in read_claim_events(state.root):
            if event["action"] != "claim" or event["target_kind"] == "adjudication":
                continue
            for target_id in event["target_ids"]:
                claim_evidence.add((str(target_id), str(event["reviewer"])))
    for index, row in enumerate(rows, 1):
        review = require_mapping(row.get("review"), location=f"reviews[{index}].review")
        assignment_id = require_id(
            review.get("assignment_id"),
            location=f"reviews[{index}].review.assignment_id",
        )
        assignment = state.assignments.get(assignment_id)
        if assignment is None:
            raise ReviewLedgerError(f"reviews[{index}] targets unknown assignment")
        if assignment_id in by_assignment:
            raise ReviewLedgerError(
                f"assignment reviewed more than once: {assignment_id}"
            )
        sample = state.sample_by_id[assignment.sample_id]
        try:
            labels.validate_review_record(
                row, assignment=assignment, candidate_ids=sample.candidate_ids
            )
        except labels.LabelValidationError as error:
            raise ReviewLedgerError(f"reviews[{index}]: {error}") from error
        assignment_row = state.row_by_assignment[assignment_id]
        expected_review_bindings = {
            "catalog_sha256": assignment_row["catalog_sha256"],
            "renderer_hash": assignment_row["renderer_hash"],
            "review_card_sha256": assignment_row["review_card_sha256"],
        }
        for field, expected in expected_review_bindings.items():
            if review.get(field) != expected:
                raise ReviewLedgerError(
                    f"reviews[{index}].review.{field} differs from execution assignment"
                )
        reviewer = str(review["reviewer"])
        if require_claim_evidence and (assignment_id, reviewer) not in claim_evidence:
            raise ReviewLedgerError(
                f"review {assignment_id} has no matching atomic claim evidence"
            )
        label_id = str(row["label_id"])
        if label_id in label_ids:
            raise ReviewLedgerError(f"duplicate label_id: {label_id}")
        label_ids.add(label_id)
        by_assignment[assignment_id] = row
    # Independence is enforceable before the full ledger is complete.
    for sample_id, assignments in state.assignments_by_sample.items():
        completed = {
            assignment.stage: by_assignment.get(assignment.assignment_id)
            for assignment in assignments
        }
        if (
            completed.get("primary") is not None
            and completed.get("secondary") is not None
        ):
            if (
                completed["primary"]["review"]["reviewer"]
                == completed["secondary"]["review"]["reviewer"]
            ):
                raise ReviewLedgerError(
                    f"secondary review for {sample_id} is not reviewer-independent"
                )
    return rows, by_assignment


def read_finals(
    state: WorkspaceState,
) -> tuple[list[dict[str, Any]], dict[str, Mapping[str, Any]]]:
    rows = read_jsonl(state.root / FINALS_FILE, missing_ok=True)
    by_sample: dict[str, Mapping[str, Any]] = {}
    final_ids: set[str] = set()
    for index, row in enumerate(rows, 1):
        sample_id = require_id(
            row.get("sample_id"), location=f"finals[{index}].sample_id"
        )
        sample = state.sample_by_id.get(sample_id)
        if sample is None:
            raise ReviewLedgerError(f"finals[{index}] targets unknown sample")
        if sample_id in by_sample:
            raise ReviewLedgerError(f"sample finalized more than once: {sample_id}")
        try:
            labels.validate_final_record(row, candidate_ids=sample.candidate_ids)
        except labels.LabelValidationError as error:
            raise ReviewLedgerError(f"finals[{index}]: {error}") from error
        final_id = str(row["final_id"])
        if final_id in final_ids:
            raise ReviewLedgerError(f"duplicate final_id: {final_id}")
        final_ids.add(final_id)
        by_sample[sample_id] = row
    return rows, by_sample


REASON_ORDER = {
    reason: index
    for index, reason in enumerate(
        (
            "manual_recrop",
            "crop_needs_review",
            "rendering_issue",
            "catalog_gap",
            "role_disagreement",
            "font_tier_disagreement",
            "treatment_disagreement",
            "source_style_disagreement",
            "consistency_disagreement",
            "none_acceptable",
            "role_unknown",
            "candidate_not_reviewed",
            "low_confidence",
            "role_uncertain",
            "policy_uncertain",
        )
    )
}


def _review_queue_reasons(
    record: Mapping[str, Any], *, low_confidence_threshold: float
) -> set[str]:
    reasons: set[str] = set()
    if record["font_judgment"]["none_acceptable"]:
        reasons.add("none_acceptable")
    if record["font_judgment"]["not_reviewed"]:
        reasons.add("candidate_not_reviewed")
    if record["role"]["primary"] == "unknown_needs_review":
        reasons.add("role_unknown")
    if (
        min(float(record["role"]["confidence"]), float(record["review"]["confidence"]))
        < low_confidence_threshold
    ):
        reasons.add("low_confidence")
    for flag in record["review"]["flags"]:
        if flag in {
            "low_confidence",
            "crop_needs_review",
            "catalog_gap",
            "rendering_issue",
            "role_uncertain",
            "policy_uncertain",
            "manual_recrop",
        }:
            reasons.add(str(flag))
    return reasons


def build_adjudication_queue(
    state: WorkspaceState,
    review_by_assignment: Mapping[str, Mapping[str, Any]],
    final_by_sample: Mapping[str, Mapping[str, Any]],
    *,
    active: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    low_threshold = require_unit(
        state.contract.get("low_confidence_threshold"),
        location="workspace.low_confidence_threshold",
    )
    style_tolerance = require_unit(
        state.contract.get("style_tolerance"), location="workspace.style_tolerance"
    )
    claimed_samples: set[str] = set()
    for claim in (active or {}).values():
        if claim["target_kind"] == "adjudication":
            claimed_samples.update(str(value) for value in claim["target_ids"])
    rows: list[dict[str, Any]] = []
    for sample_id in sorted(state.sample_by_id):
        assignments = state.assignments_by_sample[sample_id]
        reviews_by_stage = {
            assignment.stage: review_by_assignment.get(assignment.assignment_id)
            for assignment in assignments
        }
        completed = all(value is not None for value in reviews_by_stage.values())
        reasons: set[str] = set()
        for record in reviews_by_stage.values():
            if record is not None:
                reasons.update(
                    _review_queue_reasons(
                        record, low_confidence_threshold=low_threshold
                    )
                )
        if completed and "secondary" in reviews_by_stage:
            try:
                reasons.update(
                    labels.review_disagreements(
                        reviews_by_stage["primary"],
                        reviews_by_stage["secondary"],
                        style_tolerance=style_tolerance,
                    )
                )
            except labels.LabelValidationError as error:
                raise ReviewLedgerError(
                    f"could not compare reviews for {sample_id}: {error}"
                ) from error
        primary_assignment = next(
            assignment for assignment in assignments if assignment.stage == "primary"
        )
        assignment_row = state.row_by_assignment[primary_assignment.assignment_id]
        if assignment_row["manual_recrop"] is True:
            reasons.add("manual_recrop")
        if not reasons:
            continue
        if sample_id in final_by_sample:
            status = "resolved"
        elif not completed:
            status = "pending_reviews"
        elif sample_id in claimed_samples:
            status = "claimed"
        else:
            status = "ready"
        source_label_ids = [
            reviews_by_stage[stage]["label_id"]
            for stage in labels.REVIEW_STAGES
            if reviews_by_stage.get(stage) is not None
        ]
        ordered_reasons = sorted(
            reasons,
            key=lambda value: (REASON_ORDER.get(value, len(REASON_ORDER)), value),
        )
        queue_id = (
            "fmaq-"
            + stable_hash(
                "font-matching-adjudication-queue-v1", sample_id, *ordered_reasons
            )[:32]
        )
        rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "manga_font_adjudication_queue_item",
                    "queue_id": queue_id,
                    "sample_id": sample_id,
                    "work_id": state.sample_by_id[sample_id].work_id,
                    "reasons": ordered_reasons,
                    "source_label_ids": source_label_ids,
                    "required_review_stages": [item.stage for item in assignments],
                    "completed_review_stages": [
                        stage
                        for stage in labels.REVIEW_STAGES
                        if reviews_by_stage.get(stage) is not None
                    ],
                    "status": status,
                    "sample_crop_sha256": assignment_row["sample_crop_sha256"],
                    "source_page_sha256": primary_assignment.source_page_sha256,
                    "review_card_sha256": assignment_row["review_card_sha256"],
                }
            )
        )
    return rows


def _candidate_maps(row: Mapping[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    assignment = labels.ReviewAssignment.from_mapping(row["assignment"])
    aliases = list(row["candidate_alias_order"])
    id_to_alias = dict(zip(assignment.candidate_order, aliases, strict=True))
    alias_to_id = {alias: candidate_id for candidate_id, alias in id_to_alias.items()}
    return id_to_alias, alias_to_id


def _decision_ids_to_aliases(
    record: Mapping[str, Any], row: Mapping[str, Any]
) -> dict[str, Any]:
    id_to_alias, _ = _candidate_maps(row)
    output = {
        "role": copy.deepcopy(record["role"]),
        "source_style": copy.deepcopy(record["source_style"]),
        "treatment": copy.deepcopy(record["treatment"]),
        "font_judgment": {
            tier: [
                id_to_alias[candidate] for candidate in record["font_judgment"][tier]
            ]
            for tier in labels.FONT_TIERS
        },
        "consistency": copy.deepcopy(record["consistency"]),
    }
    output["font_judgment"]["none_acceptable"] = record["font_judgment"][
        "none_acceptable"
    ]
    return output


def _public_review_task(state: WorkspaceState, assignment_id: str) -> dict[str, Any]:
    assignment = state.assignments[assignment_id]
    row = state.row_by_assignment[assignment_id]
    card_manifest = Path(str(state.contract["source_paths"]["card_manifest"]))
    return {
        "assignment_id": assignment_id,
        "sample_id": assignment.sample_id,
        "work_id": assignment.work_id,
        "chapter_id": row["chapter_id"],
        "page_id": row["page_id"],
        "stage": assignment.stage,
        "binding": {
            "source_page_sha256": assignment.source_page_sha256,
            "sample_crop_sha256": row["sample_crop_sha256"],
            "view_sha256": copy.deepcopy(row["view_sha256"]),
            "review_card_sha256": row["review_card_sha256"],
            "candidate_order_seed": assignment.candidate_order_seed,
            "candidate_order_aliases": list(row["candidate_alias_order"]),
        },
        "card_file": str((card_manifest.parent / str(row["card_path"])).resolve()),
        "manual_recrop": row["manual_recrop"],
        "cohorts": list(row["cohorts"]),
        "priority_batches": copy.deepcopy(row["priority_batches"]),
    }


def _public_adjudication_task(
    state: WorkspaceState,
    queue_row: Mapping[str, Any],
    review_by_assignment: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    sample_id = str(queue_row["sample_id"])
    assignments = state.assignments_by_sample[sample_id]
    primary = next(item for item in assignments if item.stage == "primary")
    primary_row = state.row_by_assignment[primary.assignment_id]
    card_manifest = Path(str(state.contract["source_paths"]["card_manifest"]))
    decisions: list[dict[str, Any]] = []
    for assignment in assignments:
        record = review_by_assignment[assignment.assignment_id]
        decisions.append(
            {
                "stage": assignment.stage,
                "label_id": record["label_id"],
                "reviewer": record["review"]["reviewer"],
                "confidence": record["review"]["confidence"],
                "flags": list(record["review"]["flags"]),
                "decision": _decision_ids_to_aliases(
                    record, state.row_by_assignment[assignment.assignment_id]
                ),
            }
        )
    return {
        "sample_id": sample_id,
        "work_id": queue_row["work_id"],
        "reasons": list(queue_row["reasons"]),
        "binding": {
            "source_page_sha256": primary.source_page_sha256,
            "sample_crop_sha256": primary_row["sample_crop_sha256"],
            "review_card_sha256": primary_row["review_card_sha256"],
            "candidate_order_seed": primary.candidate_order_seed,
            "candidate_order_aliases": list(primary_row["candidate_alias_order"]),
        },
        "card_file": str(
            (card_manifest.parent / str(primary_row["card_path"])).resolve()
        ),
        "blind_reviews": decisions,
    }


def claim_batch(
    workspace: Path,
    *,
    reviewer: str,
    target_kind: str,
    count: int,
    ttl_minutes: int = 120,
    allow_partial: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    reviewer = require_id(reviewer, location="reviewer")
    if target_kind not in {"primary", "secondary", "adjudication"}:
        raise ReviewLedgerError(
            "target_kind must be primary, secondary, or adjudication"
        )
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ReviewLedgerError("count must be a positive integer")
    if (
        isinstance(ttl_minutes, bool)
        or not isinstance(ttl_minutes, int)
        or ttl_minutes < 1
    ):
        raise ReviewLedgerError("ttl_minutes must be a positive integer")
    current = (now or utc_now()).astimezone(timezone.utc)
    with workspace_lock(workspace):
        state = load_workspace(workspace)
        review_rows, review_by_assignment = read_reviews(state)
        _final_rows, final_by_sample = read_finals(state)
        events = read_claim_events(workspace)
        active = unfinished_active_claims(
            active_claims(events, now=current),
            review_by_assignment=review_by_assignment,
            final_by_sample=final_by_sample,
        )
        busy_targets = {
            str(target_id)
            for claim in active.values()
            if claim["target_kind"] == target_kind
            for target_id in claim["target_ids"]
        }
        target_ids: list[str] = []
        tasks: list[dict[str, Any]] = []
        if target_kind in labels.REVIEW_STAGES:
            primary_reviewer_by_sample: dict[str, str] = {}
            for assignment_id, record in review_by_assignment.items():
                assignment = state.assignments[assignment_id]
                if assignment.stage == "primary":
                    primary_reviewer_by_sample[assignment.sample_id] = str(
                        record["review"]["reviewer"]
                    )
            candidates = [
                row
                for row in state.rows
                if row["assignment"]["stage"] == target_kind
                and row["assignment"]["assignment_id"] not in review_by_assignment
                and row["assignment"]["assignment_id"] not in busy_targets
            ]
            candidates.sort(key=lambda row: int(row["review_order"]))
            for row in candidates:
                assignment_id = str(row["assignment"]["assignment_id"])
                assignment = state.assignments[assignment_id]
                if target_kind == "secondary":
                    primary = next(
                        item
                        for item in state.assignments_by_sample[assignment.sample_id]
                        if item.stage == "primary"
                    )
                    if primary.assignment_id not in review_by_assignment:
                        continue
                    if primary_reviewer_by_sample.get(assignment.sample_id) == reviewer:
                        continue
                target_ids.append(assignment_id)
                tasks.append(_public_review_task(state, assignment_id))
                if len(target_ids) == count:
                    break
        else:
            queue_rows = build_adjudication_queue(
                state,
                review_by_assignment,
                final_by_sample,
                active=active,
            )
            for queue_row in queue_rows:
                sample_id = str(queue_row["sample_id"])
                if queue_row["status"] != "ready" or sample_id in busy_targets:
                    continue
                # The adjudicator must be independent of both blind reviewers.
                sample_reviewers = {
                    str(review_by_assignment[item.assignment_id]["review"]["reviewer"])
                    for item in state.assignments_by_sample[sample_id]
                }
                if reviewer in sample_reviewers:
                    continue
                target_ids.append(sample_id)
                tasks.append(
                    _public_adjudication_task(state, queue_row, review_by_assignment)
                )
                if len(target_ids) == count:
                    break
        if not target_ids:
            raise ReviewLedgerError(f"no claimable {target_kind} work is available")
        if len(target_ids) < count and not allow_partial:
            raise ReviewLedgerError(
                f"only {len(target_ids)} of {count} requested {target_kind} tasks are available"
            )
        expires_at = current + timedelta(minutes=ttl_minutes)
        claim_id = (
            "fmcl-"
            + stable_hash(
                "font-matching-review-claim-v1",
                reviewer,
                target_kind,
                timestamp(current),
                *target_ids,
            )[:32]
        )
        event = _claim_event(
            action="claim",
            claim_id=claim_id,
            target_kind=target_kind,
            target_ids=target_ids,
            reviewer=reviewer,
            occurred_at=current,
            expires_at=expires_at,
        )
        atomic_write(workspace / CLAIMS_FILE, jsonl_bytes([*events, event]))
        public = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": PUBLIC_CLAIM_TYPE,
                "claim_id": claim_id,
                "target_kind": target_kind,
                "reviewer": reviewer,
                "claimed_at": timestamp(current),
                "expires_at": timestamp(expires_at),
                "task_count": len(tasks),
                "tasks": tasks,
                "blindness": {
                    "font_ids_visible": False,
                    "font_names_visible": False,
                    "model_suggestions_visible": False,
                },
            }
        )
        # Rebuild derived files inside the same lock after the claim is durable.
        _write_derived(state, review_rows, list(final_by_sample.values()), now=current)
        return public


def release_claim(
    workspace: Path,
    *,
    claim_id: str,
    reviewer: str,
    now: datetime | None = None,
) -> None:
    claim_id = require_id(claim_id, location="claim_id")
    reviewer = require_id(reviewer, location="reviewer")
    current = (now or utc_now()).astimezone(timezone.utc)
    with workspace_lock(workspace):
        state = load_workspace(workspace)
        events = read_claim_events(workspace)
        claim = next(
            (
                row
                for row in events
                if row["action"] == "claim" and row["claim_id"] == claim_id
            ),
            None,
        )
        if claim is None:
            raise ReviewLedgerError(f"unknown claim: {claim_id}")
        if claim["reviewer"] != reviewer:
            raise ReviewLedgerError("only the claiming reviewer can release this claim")
        if any(
            row["action"] == "release" and row["claim_id"] == claim_id for row in events
        ):
            raise ReviewLedgerError(f"claim is already released: {claim_id}")
        event = _claim_event(
            action="release",
            claim_id=claim_id,
            target_kind=str(claim["target_kind"]),
            target_ids=[str(value) for value in claim["target_ids"]],
            reviewer=reviewer,
            occurred_at=current,
            expires_at=None,
        )
        atomic_write(workspace / CLAIMS_FILE, jsonl_bytes([*events, event]))
        review_rows, review_by_assignment = read_reviews(state)
        final_rows, final_by_sample = read_finals(state)
        _write_derived(
            state,
            review_rows,
            final_rows,
            now=current,
            review_by_assignment=review_by_assignment,
            final_by_sample=final_by_sample,
        )


def _find_active_claim(
    events: Sequence[Mapping[str, Any]],
    *,
    claim_id: str,
    now: datetime,
    target_kind: str,
) -> Mapping[str, Any]:
    current = active_claims(events, now=now).get(claim_id)
    if current is None:
        raise ReviewLedgerError(f"claim is missing, released, or expired: {claim_id}")
    if current["target_kind"] != target_kind:
        raise ReviewLedgerError(
            f"claim kind is {current['target_kind']}, expected {target_kind}"
        )
    return current


def _alias_array(
    value: Any,
    *,
    location: str,
    alias_to_id: Mapping[str, str],
) -> list[str]:
    if not isinstance(value, list):
        raise ReviewLedgerError(f"{location} must be an array")
    output: list[str] = []
    for index, alias in enumerate(value):
        normalized = require_id(alias, location=f"{location}[{index}]")
        if normalized not in alias_to_id:
            raise ReviewLedgerError(f"{location}[{index}] is an unknown blind alias")
        output.append(alias_to_id[normalized])
    if len(output) != len(set(output)):
        raise ReviewLedgerError(f"{location} contains duplicates")
    return output


def _decision_from_aliases(
    response: Mapping[str, Any],
    *,
    row: Mapping[str, Any],
    location: str,
) -> dict[str, Any]:
    _, alias_to_id = _candidate_maps(row)
    judgment = require_mapping(
        response.get("font_judgment"), location=f"{location}.font_judgment"
    )
    require_exact_keys(
        judgment,
        {*labels.FONT_TIERS, "none_acceptable"},
        location=f"{location}.font_judgment",
    )
    converted = {
        tier: _alias_array(
            judgment.get(tier),
            location=f"{location}.font_judgment.{tier}",
            alias_to_id=alias_to_id,
        )
        for tier in labels.FONT_TIERS
    }
    converted["none_acceptable"] = require_bool(
        judgment.get("none_acceptable"),
        location=f"{location}.font_judgment.none_acceptable",
    )
    return {
        "role": copy.deepcopy(
            dict(require_mapping(response.get("role"), location=f"{location}.role"))
        ),
        "source_style": copy.deepcopy(
            dict(
                require_mapping(
                    response.get("source_style"), location=f"{location}.source_style"
                )
            )
        ),
        "treatment": copy.deepcopy(
            dict(
                require_mapping(
                    response.get("treatment"), location=f"{location}.treatment"
                )
            )
        ),
        "font_judgment": converted,
        "consistency": copy.deepcopy(
            dict(
                require_mapping(
                    response.get("consistency"), location=f"{location}.consistency"
                )
            )
        ),
    }


def _validate_response_binding(
    response: Mapping[str, Any],
    assignment: labels.ReviewAssignment,
    row: Mapping[str, Any],
    *,
    location: str,
) -> None:
    binding = require_mapping(response.get("binding"), location=f"{location}.binding")
    require_exact_keys(
        binding,
        {
            "source_page_sha256",
            "sample_crop_sha256",
            "review_card_sha256",
            "candidate_order_seed",
            "candidate_order_aliases",
        },
        location=f"{location}.binding",
    )
    expected = {
        "source_page_sha256": assignment.source_page_sha256,
        "sample_crop_sha256": row["sample_crop_sha256"],
        "review_card_sha256": row["review_card_sha256"],
        "candidate_order_seed": assignment.candidate_order_seed,
        "candidate_order_aliases": row["candidate_alias_order"],
    }
    for field, expected_value in expected.items():
        if binding.get(field) != expected_value:
            raise ReviewLedgerError(f"{location}.binding.{field} differs from claim")


def _build_review_record(
    response: Mapping[str, Any],
    *,
    claim: Mapping[str, Any],
    state: WorkspaceState,
    location: str,
) -> dict[str, Any]:
    required = {
        "schema_version",
        "record_type",
        "claim_id",
        "assignment_id",
        "binding",
        "role",
        "source_style",
        "treatment",
        "font_judgment",
        "consistency",
        "confidence",
        "flags",
        "reviewed_at",
    }
    require_exact_keys(response, required, location=location)
    if (
        response.get("schema_version") != SCHEMA_VERSION
        or response.get("record_type") != REVIEW_RESPONSE_TYPE
    ):
        raise ReviewLedgerError(f"{location} has invalid response schema")
    if response.get("claim_id") != claim["claim_id"]:
        raise ReviewLedgerError(f"{location}.claim_id differs from active claim")
    assignment_id = require_id(
        response.get("assignment_id"), location=f"{location}.assignment_id"
    )
    assignment = state.assignments.get(assignment_id)
    if assignment is None or assignment_id not in claim["target_ids"]:
        raise ReviewLedgerError(f"{location} is not part of the active claim")
    row = state.row_by_assignment[assignment_id]
    _validate_response_binding(response, assignment, row, location=location)
    decision = _decision_from_aliases(response, row=row, location=location)
    confidence = require_unit(
        response.get("confidence"), location=f"{location}.confidence"
    )
    flags = response.get("flags")
    if not isinstance(flags, list) or any(not isinstance(flag, str) for flag in flags):
        raise ReviewLedgerError(f"{location}.flags must be a string array")
    if len(flags) != len(set(flags)):
        raise ReviewLedgerError(f"{location}.flags contains duplicates")
    low_threshold = float(state.contract["low_confidence_threshold"])
    role_confidence = decision["role"].get("confidence")
    if (
        isinstance(role_confidence, (int, float))
        and not isinstance(role_confidence, bool)
        and min(float(role_confidence), confidence) < low_threshold
        and "low_confidence" not in flags
    ):
        raise ReviewLedgerError(
            f"{location}.flags must include low_confidence when role or review "
            f"confidence is below {low_threshold}"
        )
    reviewed_at = timestamp(
        parse_timestamp(response.get("reviewed_at"), location=f"{location}.reviewed_at")
    )
    label_id = (
        "fmrl-"
        + stable_hash(
            "font-matching-review-label-v1", assignment_id, str(claim["reviewer"])
        )[:32]
    )
    record = {
        "schema_version": labels.SCHEMA_VERSION,
        "record_type": labels.REVIEW_RECORD_TYPE,
        "label_id": label_id,
        "sample_id": assignment.sample_id,
        "work_id": assignment.work_id,
        "source_page_sha256": assignment.source_page_sha256,
        **decision,
        "review": {
            "stage": assignment.stage,
            "assignment_id": assignment_id,
            "reviewer": claim["reviewer"],
            "reviewed_at": reviewed_at,
            "catalog_version": assignment.catalog_version,
            "catalog_sha256": row["catalog_sha256"],
            "renderer_hash": row["renderer_hash"],
            "review_card_sha256": row["review_card_sha256"],
            "candidate_order_seed": assignment.candidate_order_seed,
            "candidate_order": list(assignment.candidate_order),
            "blind_first_pass": True,
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "confidence": confidence,
            "flags": list(flags),
        },
    }
    sealed = labels.seal_record(record)
    try:
        labels.validate_review_record(
            sealed,
            assignment=assignment,
            candidate_ids=state.sample_by_id[assignment.sample_id].candidate_ids,
        )
    except labels.LabelValidationError as error:
        raise ReviewLedgerError(f"{location}: {error}") from error
    return sealed


def submit_review_batch(
    workspace: Path,
    responses: Sequence[Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    if not responses:
        raise ReviewLedgerError("review response batch is empty")
    current = (now or utc_now()).astimezone(timezone.utc)
    claim_ids = {response.get("claim_id") for response in responses}
    if len(claim_ids) != 1:
        raise ReviewLedgerError("all responses must belong to one claim")
    claim_id = require_id(next(iter(claim_ids)), location="claim_id")
    with workspace_lock(workspace):
        state = load_workspace(workspace)
        events = read_claim_events(workspace)
        claims_by_id = active_claims(events, now=current)
        claim = claims_by_id.get(claim_id)
        if claim is None:
            raise ReviewLedgerError(
                f"claim is missing, released, or expired: {claim_id}"
            )
        target_kind = str(claim["target_kind"])
        if target_kind not in labels.REVIEW_STAGES:
            raise ReviewLedgerError("adjudication claims require submit-adjudication")
        response_targets = [response.get("assignment_id") for response in responses]
        if len(response_targets) != len(set(response_targets)):
            raise ReviewLedgerError("response batch repeats an assignment_id")
        if set(response_targets) != set(claim["target_ids"]):
            raise ReviewLedgerError(
                "response batch must cover the claimed batch exactly"
            )
        existing_rows, existing_by_assignment = read_reviews(state)
        overlap = sorted(set(response_targets) & set(existing_by_assignment))
        if overlap:
            raise ReviewLedgerError(f"assignments are already reviewed: {overlap[:8]}")
        created = [
            _build_review_record(
                response,
                claim=claim,
                state=state,
                location=f"responses[{index}]",
            )
            for index, response in enumerate(responses, 1)
        ]
        combined = [*existing_rows, *created]
        order = {
            str(row["assignment"]["assignment_id"]): int(row["review_order"])
            for row in state.rows
        }
        combined.sort(key=lambda row: order[str(row["review"]["assignment_id"])])
        atomic_write(workspace / REVIEWS_FILE, jsonl_bytes(combined))
        # Re-read with claim evidence to prove the on-disk batch is coherent.
        reviews, review_by_assignment = read_reviews(state)
        finals, final_by_sample = read_finals(state)
        _write_derived(
            state,
            reviews,
            finals,
            now=current,
            review_by_assignment=review_by_assignment,
            final_by_sample=final_by_sample,
        )
        return created


def _final_projection(
    *,
    state: WorkspaceState,
    sample_id: str,
    sample_reviews: Sequence[Mapping[str, Any]],
    resolver: str,
    resolved_at: datetime,
) -> dict[str, Any]:
    primary = next(
        record for record in sample_reviews if record["review"]["stage"] == "primary"
    )
    kind = "blind_agreement" if len(sample_reviews) == 2 else "primary"
    record = {
        key: copy.deepcopy(primary[key])
        for key in (
            "schema_version",
            "sample_id",
            "work_id",
            "source_page_sha256",
            "role",
            "source_style",
            "treatment",
            "font_judgment",
            "consistency",
        )
    }
    record.update(
        {
            "record_type": labels.FINAL_RECORD_TYPE,
            "final_id": "fmfl-" + stable_hash("font-matching-final-v1", sample_id)[:32],
            "resolution": {
                "kind": kind,
                "resolver": resolver,
                "resolved_at": timestamp(resolved_at),
                "source_label_ids": [
                    record["label_id"]
                    for record in sorted(
                        sample_reviews,
                        key=lambda item: labels.REVIEW_STAGES.index(
                            item["review"]["stage"]
                        ),
                    )
                ],
                "catalog_version": primary["review"]["catalog_version"],
                "catalog_sha256": primary["review"]["catalog_sha256"],
                "renderer_hash": primary["review"]["renderer_hash"],
                "confidence": min(
                    min(
                        float(item["review"]["confidence"]),
                        float(item["role"]["confidence"]),
                    )
                    for item in sample_reviews
                ),
                "flags": [],
                "notes": "",
                "adjudication_evidence": None,
            },
        }
    )
    sealed = labels.seal_record(record)
    try:
        labels.validate_final_record(
            sealed, candidate_ids=state.sample_by_id[sample_id].candidate_ids
        )
    except labels.LabelValidationError as error:
        raise ReviewLedgerError(f"final projection for {sample_id}: {error}") from error
    return sealed


def finalize_uncontested(
    workspace: Path,
    *,
    resolver: str,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    resolver = require_id(resolver, location="resolver")
    current = (now or utc_now()).astimezone(timezone.utc)
    with workspace_lock(workspace):
        state = load_workspace(workspace)
        review_rows, review_by_assignment = read_reviews(state)
        final_rows, final_by_sample = read_finals(state)
        queue = build_adjudication_queue(state, review_by_assignment, final_by_sample)
        queued = {str(row["sample_id"]) for row in queue}
        created: list[dict[str, Any]] = []
        for sample_id in sorted(state.sample_by_id):
            if sample_id in final_by_sample or sample_id in queued:
                continue
            assignments = state.assignments_by_sample[sample_id]
            if any(
                item.assignment_id not in review_by_assignment for item in assignments
            ):
                continue
            sample_reviews = [
                review_by_assignment[item.assignment_id] for item in assignments
            ]
            created.append(
                _final_projection(
                    state=state,
                    sample_id=sample_id,
                    sample_reviews=sample_reviews,
                    resolver=resolver,
                    resolved_at=current,
                )
            )
        combined = [*final_rows, *created]
        combined.sort(key=lambda row: str(row["sample_id"]))
        atomic_write(workspace / FINALS_FILE, jsonl_bytes(combined))
        finals, final_by_sample = read_finals(state)
        _write_derived(
            state,
            review_rows,
            finals,
            now=current,
            review_by_assignment=review_by_assignment,
            final_by_sample=final_by_sample,
        )
        return created


def _adjudication_final_flags(reasons: Sequence[str]) -> list[str]:
    flags: list[str] = []
    if "none_acceptable" in reasons:
        flags.append("none_acceptable_confirmed")
    if "catalog_gap" in reasons:
        flags.append("catalog_gap_confirmed")
    if "manual_recrop" in reasons:
        flags.append("manual_recrop_resolved")
    if "low_confidence" in reasons:
        flags.append("low_confidence_resolved")
    if any(reason.endswith("_disagreement") for reason in reasons):
        flags.append("disagreement_resolved")
    return flags


def _build_adjudicated_final(
    response: Mapping[str, Any],
    *,
    claim: Mapping[str, Any],
    state: WorkspaceState,
    queue_row: Mapping[str, Any],
    review_by_assignment: Mapping[str, Mapping[str, Any]],
    location: str,
) -> dict[str, Any]:
    required = {
        "schema_version",
        "record_type",
        "claim_id",
        "sample_id",
        "binding",
        "role",
        "source_style",
        "treatment",
        "font_judgment",
        "consistency",
        "confidence",
        "notes",
        "font_names_visible",
        "model_suggestions_visible",
        "resolved_at",
    }
    require_exact_keys(response, required, location=location)
    if (
        response.get("schema_version") != SCHEMA_VERSION
        or response.get("record_type") != ADJUDICATION_RESPONSE_TYPE
    ):
        raise ReviewLedgerError(f"{location} has invalid adjudication response schema")
    if response.get("claim_id") != claim["claim_id"]:
        raise ReviewLedgerError(f"{location}.claim_id differs from active claim")
    sample_id = require_id(response.get("sample_id"), location=f"{location}.sample_id")
    if sample_id not in claim["target_ids"] or sample_id != queue_row["sample_id"]:
        raise ReviewLedgerError(f"{location} is not part of the adjudication claim")
    assignments = state.assignments_by_sample[sample_id]
    primary = next(item for item in assignments if item.stage == "primary")
    primary_row = state.row_by_assignment[primary.assignment_id]
    _validate_response_binding(response, primary, primary_row, location=location)
    decision = _decision_from_aliases(response, row=primary_row, location=location)
    confidence = require_unit(
        response.get("confidence"), location=f"{location}.confidence"
    )
    notes = response.get("notes")
    if not isinstance(notes, str) or not notes.strip() or len(notes) > 4000:
        raise ReviewLedgerError(
            f"{location}.notes must record evidence and changes in 1..4000 chars"
        )
    font_names_visible = require_bool(
        response.get("font_names_visible"),
        location=f"{location}.font_names_visible",
    )
    model_suggestions_visible = require_bool(
        response.get("model_suggestions_visible"),
        location=f"{location}.model_suggestions_visible",
    )
    resolved_at = timestamp(
        parse_timestamp(response.get("resolved_at"), location=f"{location}.resolved_at")
    )
    source_records = [review_by_assignment[item.assignment_id] for item in assignments]
    record = {
        "schema_version": labels.SCHEMA_VERSION,
        "record_type": labels.FINAL_RECORD_TYPE,
        "final_id": "fmfl-" + stable_hash("font-matching-final-v1", sample_id)[:32],
        "sample_id": sample_id,
        "work_id": primary.work_id,
        "source_page_sha256": primary.source_page_sha256,
        **decision,
        "resolution": {
            "kind": "adjudicated",
            "resolver": claim["reviewer"],
            "resolved_at": resolved_at,
            "source_label_ids": [record["label_id"] for record in source_records],
            "catalog_version": primary.catalog_version,
            "catalog_sha256": primary_row["catalog_sha256"],
            "renderer_hash": primary_row["renderer_hash"],
            "confidence": confidence,
            "flags": _adjudication_final_flags(queue_row["reasons"]),
            "notes": notes,
            "adjudication_evidence": {
                "review_card_sha256": primary_row["review_card_sha256"],
                "candidate_order_seed": primary.candidate_order_seed,
                "candidate_order": list(primary.candidate_order),
                "font_names_visible": font_names_visible,
                "model_suggestions_visible": model_suggestions_visible,
            },
        },
    }
    sealed = labels.seal_record(record)
    try:
        labels.validate_final_record(
            sealed, candidate_ids=state.sample_by_id[sample_id].candidate_ids
        )
    except labels.LabelValidationError as error:
        raise ReviewLedgerError(f"{location}: {error}") from error
    return sealed


def submit_adjudication_batch(
    workspace: Path,
    responses: Sequence[Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    if not responses:
        raise ReviewLedgerError("adjudication response batch is empty")
    current = (now or utc_now()).astimezone(timezone.utc)
    claim_ids = {response.get("claim_id") for response in responses}
    if len(claim_ids) != 1:
        raise ReviewLedgerError("all adjudications must belong to one claim")
    claim_id = require_id(next(iter(claim_ids)), location="claim_id")
    with workspace_lock(workspace):
        state = load_workspace(workspace)
        events = read_claim_events(workspace)
        claim = _find_active_claim(
            events,
            claim_id=claim_id,
            now=current,
            target_kind="adjudication",
        )
        targets = [response.get("sample_id") for response in responses]
        if len(targets) != len(set(targets)) or set(targets) != set(
            claim["target_ids"]
        ):
            raise ReviewLedgerError("adjudication batch must cover the claim exactly")
        review_rows, review_by_assignment = read_reviews(state)
        final_rows, final_by_sample = read_finals(state)
        overlap = sorted(set(str(value) for value in targets) & set(final_by_sample))
        if overlap:
            raise ReviewLedgerError(f"samples are already finalized: {overlap[:8]}")
        queue = build_adjudication_queue(state, review_by_assignment, final_by_sample)
        queue_by_sample = {
            str(row["sample_id"]): row for row in queue if row["status"] == "ready"
        }
        if not set(str(value) for value in targets) <= set(queue_by_sample):
            raise ReviewLedgerError(
                "adjudication claim no longer targets ready queue items"
            )
        created = [
            _build_adjudicated_final(
                response,
                claim=claim,
                state=state,
                queue_row=queue_by_sample[str(response["sample_id"])],
                review_by_assignment=review_by_assignment,
                location=f"adjudications[{index}]",
            )
            for index, response in enumerate(responses, 1)
        ]
        combined = [*final_rows, *created]
        combined.sort(key=lambda row: str(row["sample_id"]))
        atomic_write(workspace / FINALS_FILE, jsonl_bytes(combined))
        finals, final_by_sample = read_finals(state)
        _write_derived(
            state,
            review_rows,
            finals,
            now=current,
            review_by_assignment=review_by_assignment,
            final_by_sample=final_by_sample,
        )
        return created


def _validate_partial_finals(
    state: WorkspaceState,
    review_by_assignment: Mapping[str, Mapping[str, Any]],
    final_by_sample: Mapping[str, Mapping[str, Any]],
) -> None:
    queue_without_final = build_adjudication_queue(state, review_by_assignment, {})
    queued = {str(row["sample_id"]): row for row in queue_without_final}
    style_tolerance = float(state.contract["style_tolerance"])
    for sample_id, final in final_by_sample.items():
        assignments = state.assignments_by_sample[sample_id]
        if any(item.assignment_id not in review_by_assignment for item in assignments):
            raise ReviewLedgerError(
                f"final {sample_id} exists before all assigned reviews are complete"
            )
        sample_reviews = [
            review_by_assignment[item.assignment_id] for item in assignments
        ]
        expected_sources = {record["label_id"] for record in sample_reviews}
        if set(final["resolution"]["source_label_ids"]) != expected_sources:
            raise ReviewLedgerError(
                f"final {sample_id} does not bind every blind review exactly once"
            )
        primary = next(
            record
            for record in sample_reviews
            if record["review"]["stage"] == "primary"
        )
        resolution = final["resolution"]
        for field in ("catalog_version", "catalog_sha256", "renderer_hash"):
            if resolution[field] != primary["review"][field]:
                raise ReviewLedgerError(
                    f"final {sample_id} mixes {field} with its reviews"
                )
        kind = resolution["kind"]
        if sample_id in queued:
            if kind != "adjudicated":
                raise ReviewLedgerError(
                    f"queued sample {sample_id} requires adjudicated resolution"
                )
        elif kind == "adjudicated":
            raise ReviewLedgerError(
                f"uncontested sample {sample_id} cannot be adjudicated"
            )
        if kind == "primary" and len(sample_reviews) != 1:
            raise ReviewLedgerError(
                f"double-reviewed sample {sample_id} cannot use primary resolution"
            )
        if kind == "blind_agreement":
            if len(sample_reviews) != 2:
                raise ReviewLedgerError(
                    f"blind agreement {sample_id} lacks a secondary review"
                )
            secondary = next(
                record
                for record in sample_reviews
                if record["review"]["stage"] == "secondary"
            )
            if labels.review_disagreements(
                primary, secondary, style_tolerance=style_tolerance
            ):
                raise ReviewLedgerError(
                    f"blind agreement {sample_id} still contains a disagreement"
                )
        if kind in {"primary", "blind_agreement"}:
            for field in (
                "role",
                "source_style",
                "treatment",
                "font_judgment",
                "consistency",
            ):
                if final[field] != primary[field]:
                    raise ReviewLedgerError(
                        f"non-adjudicated final {sample_id} does not project primary"
                    )


def _validate_claim_targets(
    state: WorkspaceState,
    events: Sequence[Mapping[str, Any]],
    *,
    now: datetime,
) -> dict[str, Mapping[str, Any]]:
    active = active_claims(events, now=now)
    seen_active: set[tuple[str, str]] = set()
    for claim_id, claim in active.items():
        kind = str(claim["target_kind"])
        for raw_target in claim["target_ids"]:
            target = str(raw_target)
            if kind in labels.REVIEW_STAGES:
                assignment = state.assignments.get(target)
                if assignment is None or assignment.stage != kind:
                    raise ReviewLedgerError(
                        f"claim {claim_id} targets an invalid {kind} assignment"
                    )
            elif target not in state.sample_by_id:
                raise ReviewLedgerError(
                    f"claim {claim_id} targets an unknown adjudication sample"
                )
            key = (kind, target)
            if key in seen_active:
                raise ReviewLedgerError(
                    f"target has overlapping active claims: {kind}/{target}"
                )
            seen_active.add(key)
    return active


def _build_progress(
    state: WorkspaceState,
    review_rows: Sequence[Mapping[str, Any]],
    review_by_assignment: Mapping[str, Mapping[str, Any]],
    final_rows: Sequence[Mapping[str, Any]],
    final_by_sample: Mapping[str, Mapping[str, Any]],
    events: Sequence[Mapping[str, Any]],
    *,
    now: datetime,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    all_time_active = _validate_claim_targets(state, events, now=now)
    active = unfinished_active_claims(
        all_time_active,
        review_by_assignment=review_by_assignment,
        final_by_sample=final_by_sample,
    )
    _validate_partial_finals(state, review_by_assignment, final_by_sample)
    queue_rows = build_adjudication_queue(
        state,
        review_by_assignment,
        final_by_sample,
        active=active,
    )
    assignment_counts = Counter(
        assignment.stage for assignment in state.assignments.values()
    )
    review_counts = Counter(str(row["review"]["stage"]) for row in review_rows)
    pending_counts = {
        stage: assignment_counts[stage] - review_counts[stage]
        for stage in labels.REVIEW_STAGES
    }
    queue_counts = Counter(str(row["status"]) for row in queue_rows)
    queue_reason_counts = Counter(
        reason for row in queue_rows for reason in row["reasons"]
    )
    active_counts = Counter(str(row["target_kind"]) for row in active.values())
    expired_claim_count = sum(
        row["action"] == "claim"
        and parse_timestamp(row["expires_at"], location="claim.expires_at") <= now
        for row in events
    )
    expected = state.contract["expected"]
    all_reviews_complete = (
        review_counts["primary"] == expected["primary"]
        and review_counts["secondary"] == expected["secondary"]
    )
    exact_report: Mapping[str, Any] | None = None
    completion_ready = False
    if all_reviews_complete:
        manual_recrops = [
            assignment.sample_id
            for assignment_id, assignment in state.assignments.items()
            if assignment.stage == "primary"
            and state.row_by_assignment[assignment_id]["manual_recrop"] is True
        ]
        try:
            validation = labels.validate_exactly_once_ledger(
                state.sample_by_id.values(),
                state.assignments.values(),
                review_rows,
                final_records=final_rows
                if len(final_rows) == len(state.sample_by_id)
                else None,
                minimum_double_review_fraction=(
                    expected["secondary"] / expected["primary"]
                    if expected["primary"]
                    else 0.0
                ),
                low_confidence_threshold=float(
                    state.contract["low_confidence_threshold"]
                ),
                style_tolerance=float(state.contract["style_tolerance"]),
                manual_recrop_ids=manual_recrops,
            )
        except labels.LabelValidationError as error:
            raise ReviewLedgerError(
                f"complete label ledger is invalid: {error}"
            ) from error
        exact_report = validation.as_dict()
        completion_ready = validation.completion_ready
    double_reviewed_samples = sum(
        all(item.assignment_id in review_by_assignment for item in assignments)
        and len(assignments) == 2
        for assignments in state.assignments_by_sample.values()
    )
    primary_by_work: Counter[str] = Counter()
    secondary_by_work: Counter[str] = Counter()
    for assignment_id in review_by_assignment:
        assignment = state.assignments[assignment_id]
        target = primary_by_work if assignment.stage == "primary" else secondary_by_work
        target[assignment.work_id] += 1
    progress = {
        "schema_version": SCHEMA_VERSION,
        "workspace_record_sha256": state.contract["record_sha256"],
        "generated_at": timestamp(now),
        "expected": copy.deepcopy(state.contract["expected"]),
        "assignments": dict(sorted(assignment_counts.items())),
        "reviews_completed": dict(sorted(review_counts.items())),
        "reviews_pending": dict(sorted(pending_counts.items())),
        "primary_completion_rate": round(
            review_counts["primary"] / max(1, expected["primary"]), 8
        ),
        "secondary_completion_rate": round(
            review_counts["secondary"] / max(1, expected["secondary"]), 8
        ),
        "double_reviewed_sample_count": double_reviewed_samples,
        "double_review_fraction": round(
            double_reviewed_samples / max(1, expected["primary"]), 8
        ),
        "reviews_by_work": {
            "primary": dict(sorted(primary_by_work.items())),
            "secondary": dict(sorted(secondary_by_work.items())),
        },
        "claims": {
            "active": dict(sorted(active_counts.items())),
            "active_batch_count": len(active),
            "submitted_batch_count": len(all_time_active) - len(active),
            "event_count": len(events),
            "expired_claim_count": expired_claim_count,
        },
        "adjudication_queue": {
            "total": len(queue_rows),
            "by_status": dict(sorted(queue_counts.items())),
            "by_reason": dict(sorted(queue_reason_counts.items())),
        },
        "finals": {
            "completed": len(final_rows),
            "pending": len(state.sample_by_id) - len(final_rows),
        },
        "all_reviews_complete": all_reviews_complete,
        "exactly_once_report": exact_report,
        "completion_ready": completion_ready,
        "integrity_errors": 0,
    }
    return progress, queue_rows


def _write_derived(
    state: WorkspaceState,
    review_rows: Sequence[Mapping[str, Any]],
    final_rows: Sequence[Mapping[str, Any]],
    *,
    now: datetime,
    review_by_assignment: Mapping[str, Mapping[str, Any]] | None = None,
    final_by_sample: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    if review_by_assignment is None:
        _, review_by_assignment = read_reviews(state)
    if final_by_sample is None:
        _, final_by_sample = read_finals(state)
    events = read_claim_events(state.root)
    progress, queue_rows = _build_progress(
        state,
        review_rows,
        review_by_assignment,
        final_rows,
        final_by_sample,
        events,
        now=now,
    )
    atomic_write(state.root / QUEUE_FILE, jsonl_bytes(queue_rows))
    atomic_write(
        state.root / PROGRESS_FILE, canonical_json_bytes(progress, pretty=True)
    )
    return progress


def progress_report(
    workspace: Path,
    *,
    verify_static_inputs: bool = False,
    verify_card_files: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = (now or utc_now()).astimezone(timezone.utc)
    state = load_workspace(
        workspace,
        verify_static_inputs=verify_static_inputs,
        verify_card_files=verify_card_files,
    )
    review_rows, review_by_assignment = read_reviews(state)
    final_rows, final_by_sample = read_finals(state)
    events = read_claim_events(workspace)
    progress, _queue = _build_progress(
        state,
        review_rows,
        review_by_assignment,
        final_rows,
        final_by_sample,
        events,
        now=current,
    )
    return progress


def validate_workspace(
    workspace: Path,
    *,
    require_complete: bool = False,
    verify_card_files: bool = True,
) -> dict[str, Any]:
    report = progress_report(
        workspace,
        verify_static_inputs=True,
        verify_card_files=verify_card_files,
    )
    if require_complete and report["completion_ready"] is not True:
        raise ReviewLedgerError(
            "workspace is valid but incomplete: "
            f"pending_primary={report['reviews_pending'].get('primary', 0)}, "
            f"pending_secondary={report['reviews_pending'].get('secondary', 0)}, "
            f"pending_finals={report['finals']['pending']}"
        )
    return report


def write_queue_snapshot(workspace: Path, output: Path | None = None) -> dict[str, Any]:
    current = utc_now()
    state = load_workspace(workspace)
    review_rows, review_by_assignment = read_reviews(state)
    final_rows, final_by_sample = read_finals(state)
    report = _write_derived(
        state,
        review_rows,
        final_rows,
        now=current,
        review_by_assignment=review_by_assignment,
        final_by_sample=final_by_sample,
    )
    if output is not None:
        atomic_write(output, (workspace / QUEUE_FILE).read_bytes())
    return report["adjudication_queue"]


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a positive integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def non_negative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a non-negative integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("expected a non-negative integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the exhaustive, blind font-matching review ledger."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    plan = commands.add_parser(
        "plan", help="write canonical assignments and a full card inventory"
    )
    plan.add_argument("--master-manifest", type=Path, required=True)
    plan.add_argument("--render-bank", type=Path, required=True)
    plan.add_argument("--assignments-output", type=Path, required=True)
    plan.add_argument("--inventory-output", type=Path, required=True)
    plan.add_argument("--report-output", type=Path, required=True)
    plan.add_argument("--base-priority-inventory", type=Path)
    plan.add_argument("--catalog-version", required=True)
    plan.add_argument("--allocation-seed", required=True)
    plan.add_argument("--expected-primary", type=positive_int, default=EXPECTED_PRIMARY)
    plan.add_argument(
        "--expected-secondary", type=non_negative_int, default=EXPECTED_SECONDARY
    )
    plan.add_argument(
        "--expected-candidates", type=positive_int, default=EXPECTED_CANDIDATES
    )

    init = commands.add_parser("init", help="create a fresh immutable workspace")
    init.add_argument("--workspace", type=Path, required=True)
    init.add_argument("--master-manifest", type=Path, required=True)
    init.add_argument("--card-manifest", type=Path, required=True)
    init.add_argument("--font-catalog", type=Path, required=True)
    init.add_argument("--render-bank", type=Path, required=True)
    init.add_argument("--priority-inventory", type=Path)
    init.add_argument("--catalog-version", required=True)
    init.add_argument("--allocation-seed", required=True)
    init.add_argument("--expected-primary", type=positive_int, default=EXPECTED_PRIMARY)
    init.add_argument(
        "--expected-secondary", type=non_negative_int, default=EXPECTED_SECONDARY
    )
    init.add_argument(
        "--expected-candidates", type=positive_int, default=EXPECTED_CANDIDATES
    )
    init.add_argument("--skip-card-files", action="store_true")

    claim = commands.add_parser("claim", help="atomically claim a blind review batch")
    claim.add_argument("--workspace", type=Path, required=True)
    claim.add_argument("--reviewer", required=True)
    claim.add_argument(
        "--kind", choices=("primary", "secondary", "adjudication"), required=True
    )
    claim.add_argument("--count", type=positive_int, required=True)
    claim.add_argument("--ttl-minutes", type=positive_int, default=120)
    claim.add_argument("--allow-partial", action="store_true")
    claim.add_argument("--output", type=Path, required=True)

    release = commands.add_parser("release", help="release an unfinished claim")
    release.add_argument("--workspace", type=Path, required=True)
    release.add_argument("--claim-id", required=True)
    release.add_argument("--reviewer", required=True)

    submit = commands.add_parser("submit", help="atomically submit one blind batch")
    submit.add_argument("--workspace", type=Path, required=True)
    submit.add_argument("--responses", type=Path, required=True)

    adjudicate = commands.add_parser(
        "submit-adjudication", help="atomically submit one adjudication batch"
    )
    adjudicate.add_argument("--workspace", type=Path, required=True)
    adjudicate.add_argument("--responses", type=Path, required=True)

    finalize = commands.add_parser(
        "finalize-uncontested", help="project completed non-queued blind decisions"
    )
    finalize.add_argument("--workspace", type=Path, required=True)
    finalize.add_argument("--resolver", required=True)

    queue = commands.add_parser("queue", help="rebuild the adjudication queue")
    queue.add_argument("--workspace", type=Path, required=True)
    queue.add_argument("--output", type=Path)

    progress = commands.add_parser("progress", help="print resumable progress")
    progress.add_argument("--workspace", type=Path, required=True)
    progress.add_argument("--output", type=Path)

    validate = commands.add_parser("validate", help="validate all ledger invariants")
    validate.add_argument("--workspace", type=Path, required=True)
    validate.add_argument("--require-complete", action="store_true")
    validate.add_argument("--skip-card-files", action="store_true")
    validate.add_argument("--output", type=Path)
    return parser


def _emit_json(value: Mapping[str, Any], output: Path | None = None) -> None:
    payload = canonical_json_bytes(value, pretty=True)
    if output is None:
        sys.stdout.buffer.write(payload)
    else:
        atomic_write(output, payload)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "plan":
            report = write_assignment_plan(
                master_manifest=args.master_manifest.resolve(),
                render_bank=args.render_bank.resolve(),
                assignments_output=args.assignments_output.resolve(),
                inventory_output=args.inventory_output.resolve(),
                report_output=args.report_output.resolve(),
                catalog_version=args.catalog_version,
                allocation_seed=args.allocation_seed,
                base_priority_inventory=args.base_priority_inventory.resolve()
                if args.base_priority_inventory is not None
                else None,
                expected_primary=args.expected_primary,
                expected_secondary=args.expected_secondary,
                expected_candidates=args.expected_candidates,
            )
            _emit_json(report)
        elif args.command == "init":
            report = initialize_workspace(
                workspace=args.workspace.resolve(),
                master_manifest=args.master_manifest.resolve(),
                card_manifest=args.card_manifest.resolve(),
                font_catalog=args.font_catalog.resolve(),
                render_bank=args.render_bank.resolve(),
                priority_inventory=args.priority_inventory.resolve()
                if args.priority_inventory is not None
                else None,
                catalog_version=args.catalog_version,
                allocation_seed=args.allocation_seed,
                expected_primary=args.expected_primary,
                expected_secondary=args.expected_secondary,
                expected_candidates=args.expected_candidates,
                verify_card_files=not args.skip_card_files,
            )
            _emit_json(report)
        elif args.command == "claim":
            claim = claim_batch(
                args.workspace.resolve(),
                reviewer=args.reviewer,
                target_kind=args.kind,
                count=args.count,
                ttl_minutes=args.ttl_minutes,
                allow_partial=args.allow_partial,
            )
            _emit_json(claim, args.output.resolve())
            _emit_json(
                {
                    "claim_id": claim["claim_id"],
                    "output": str(args.output.resolve()),
                    "task_count": claim["task_count"],
                }
            )
        elif args.command == "release":
            release_claim(
                args.workspace.resolve(),
                claim_id=args.claim_id,
                reviewer=args.reviewer,
            )
            _emit_json({"claim_id": args.claim_id, "status": "released"})
        elif args.command == "submit":
            created = submit_review_batch(
                args.workspace.resolve(), read_jsonl(args.responses.resolve())
            )
            _emit_json({"submitted": len(created), "status": "accepted"})
        elif args.command == "submit-adjudication":
            created = submit_adjudication_batch(
                args.workspace.resolve(), read_jsonl(args.responses.resolve())
            )
            _emit_json({"submitted": len(created), "status": "accepted"})
        elif args.command == "finalize-uncontested":
            created = finalize_uncontested(
                args.workspace.resolve(), resolver=args.resolver
            )
            _emit_json({"finalized": len(created), "status": "accepted"})
        elif args.command == "queue":
            summary = write_queue_snapshot(
                args.workspace.resolve(),
                args.output.resolve() if args.output is not None else None,
            )
            _emit_json(summary)
        elif args.command == "progress":
            report = progress_report(args.workspace.resolve())
            _emit_json(
                report, args.output.resolve() if args.output is not None else None
            )
        elif args.command == "validate":
            report = validate_workspace(
                args.workspace.resolve(),
                require_complete=args.require_complete,
                verify_card_files=not args.skip_card_files,
            )
            _emit_json(
                report, args.output.resolve() if args.output is not None else None
            )
        else:  # pragma: no cover - argparse owns command choices
            raise ReviewLedgerError(f"unsupported command: {args.command}")
    except (ReviewLedgerError, labels.LabelValidationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
