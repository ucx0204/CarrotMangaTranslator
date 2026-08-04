#!/usr/bin/env python3
"""Build and validate the authoritative calibration-v5 source intake.

Execution order (candidate-B/font rendering is intentionally out of scope)::

  1. python scripts/build_font_matching_calibration_intake_v5.py init ...
  2. Two different reviewers complete the source-only tasks.
  3. python scripts/build_font_matching_calibration_intake_v5.py submit \
       --reviewer-stage reviewer-a ...
  4. python scripts/build_font_matching_calibration_intake_v5.py submit \
       --reviewer-stage reviewer-b ...
  5. python scripts/build_font_matching_calibration_intake_v5.py seal-source ...
  6. python scripts/build_font_matching_calibration_intake_v5.py validate ...
  7. Run ``font_matching_calibration_preflight_v5.py feasibility`` with the
     emitted ``--sealed-intake-root``.  Only after that feasibility proof may a
     separate workflow build candidate-B cards.

``init`` accepts exactly five ``sfx_ambient`` and three ``sfx_comic`` source
proposals.  An ``existing_master`` proposal reuses a clean authoritative master
row.  A ``manual_recrop`` proposal derives raw/context/glyph pixels only from
the bound real source page and may include explicitly hash-bound keep/exclude
rectangles or polygons.  Synthetic, generative, QA-overlay, test/validation,
prior-calibration, path-escape, symlink, overwrite, and unsealed supplemental
inputs fail closed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Mapping, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts import build_font_matching_master as master_builder  # noqa: E402
from scripts import font_matching_catalog_delta_ledger as delta  # noqa: E402
from scripts import (  # noqa: E402
    promote_font_matching_font_signal_recrop_repair as promotion,
)


SCHEMA_VERSION = "font-matching-calibration-intake-v5"
OWNER = "carrot-manga-translator/font-matching-calibration-intake-v5"
MARKER_FILE = ".font-matching-calibration-intake-v5-owned.json"
CONTRACT_FILE = "contract.json"
PRIVATE_FILE = "private-bindings.jsonl"
REVIEWER_STAGES = ("reviewer-a", "reviewer-b")
CHECK_IDS = (
    "complete_text_object",
    "single_skeleton",
    "clean_glyph_isolation",
    "role_context_sufficient",
)
EXPECTED_STRATA = {"sfx_ambient": 5, "sfx_comic": 3}
EXPECTED_COUNT = sum(EXPECTED_STRATA.values())
EXPECTED_PRIOR_ROUND_IDS = (
    "delta7-fresh-rubric-v2-round-001",
    "delta7-fresh-rubric-v3-round-002",
    "delta7-fresh-rubric-v4-round-003",
)
PRIOR_HISTORY_FILE = "prior-calibration-history.json"
SUCCESSOR_BRIDGE_RECORD_TYPE = "font_matching_authority_successor_bridge"
ALLOWED_KINDS = frozenset(
    {"existing_master", "manual_recrop", "manual_fresh_page_crop"}
)
ALLOWED_ROLES = frozenset(EXPECTED_STRATA)
GENERALIZED_TARGET_STRATA = frozenset(
    {
        "ordinary_body",
        "aside_whisper_handwritten",
        "emphasis_shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
    }
)
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
CATALOG_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")


class IntakeError(ValueError):
    """Raised when an intake artifact violates a fail-closed contract."""


def _validated_expected_strata(value: Any) -> dict[str, int]:
    if value is None:
        return dict(EXPECTED_STRATA)
    if not isinstance(value, Mapping) or not value:
        raise IntakeError("expected strata must be a non-empty object")
    output: dict[str, int] = {}
    for raw_name, raw_count in value.items():
        name = _identifier(raw_name, "expected stratum")
        if name not in GENERALIZED_TARGET_STRATA:
            raise IntakeError(f"unsupported expected stratum: {name}")
        if isinstance(raw_count, bool) or not isinstance(raw_count, int) or raw_count < 1:
            raise IntakeError(f"expected stratum {name} count must be positive integer")
        output[name] = raw_count
    return dict(sorted(output.items()))


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    digest = hashlib.sha256()
    for part in parts:
        encoded = part.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    if "record_sha256" in value:
        raise IntakeError("record is already sealed")
    output = copy.deepcopy(dict(value))
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def validate_seal(value: Mapping[str, Any], location: str) -> str:
    expected = value.get("record_sha256")
    if not isinstance(expected, str) or SHA_RE.fullmatch(expected) is None:
        raise IntakeError(f"{location}: record seal is missing")
    core = {key: child for key, child in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json_bytes(core)) != expected:
        raise IntakeError(f"{location}: record seal changed")
    return expected


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise IntakeError(f"{location}: expected an object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise IntakeError(f"{location}: expected an array")
    return value


def _text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise IntakeError(f"{location}: expected non-empty text")
    return value.strip()


def _identifier(value: Any, location: str) -> str:
    result = _text(value, location)
    if ID_RE.fullmatch(result) is None:
        raise IntakeError(f"{location}: invalid identifier")
    return result


def _sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or SHA_RE.fullmatch(value) is None:
        raise IntakeError(f"{location}: expected SHA-256")
    return value


def _exact_keys(value: Mapping[str, Any], keys: set[str], location: str) -> None:
    if set(value) != keys:
        raise IntakeError(
            f"{location}: keys differ; missing={sorted(keys - set(value))}, "
            f"extra={sorted(set(value) - keys)}"
        )


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise IntakeError(f"cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise IntakeError(f"{path}: expected a JSON object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise IntakeError(f"cannot read JSONL {path}: {error}") from error
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise IntakeError(f"{path}:{line_number}: invalid JSON: {error}") from error
        if not isinstance(value, dict):
            raise IntakeError(f"{path}:{line_number}: expected an object")
        rows.append(value)
    return rows


def jsonl_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def _absolute_no_symlink(path: Path, *, location: str, must_exist: bool = True) -> Path:
    absolute = path.expanduser().absolute()
    try:
        resolved = path.expanduser().resolve(strict=must_exist)
    except OSError as error:
        raise IntakeError(f"{location}: cannot resolve path: {error}") from error
    if must_exist and not resolved.exists():
        raise IntakeError(f"{location}: path does not exist: {resolved}")
    if os.path.normcase(str(absolute)) != os.path.normcase(str(resolved)):
        raise IntakeError(f"{location}: symlinks/path aliases are forbidden")
    current = resolved
    while True:
        if current.is_symlink():
            raise IntakeError(f"{location}: symlinks are forbidden")
        if current.parent == current:
            break
        current = current.parent
    return resolved


def _safe_relative(value: Any, location: str) -> PurePosixPath:
    text = _text(value, location).replace("\\", "/")
    relative = PurePosixPath(text)
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise IntakeError(f"{location}: unsafe relative path")
    return relative


def _resolve_inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    candidate = root.joinpath(*relative.parts)
    resolved = _absolute_no_symlink(candidate, location=location)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise IntakeError(f"{location}: path escapes its root") from error
    return resolved


def _paths_overlap(first: Path, second: Path) -> bool:
    for child, parent in ((first, second), (second, first)):
        try:
            child.relative_to(parent)
        except ValueError:
            continue
        return True
    return False


def _file_binding(path: Path) -> dict[str, Any]:
    resolved = _absolute_no_symlink(path, location=str(path))
    if not resolved.is_file():
        raise IntakeError(f"expected regular file: {resolved}")
    return {
        "path": str(resolved),
        "byte_size": resolved.stat().st_size,
        "sha256": sha256_file(resolved),
    }


def _rebased_file_binding(actual: Path, final: Path) -> dict[str, Any]:
    binding = _file_binding(actual)
    binding["path"] = str(final.expanduser().absolute())
    return binding


def _validate_file_binding(binding: Mapping[str, Any], location: str) -> Path:
    _exact_keys(binding, {"path", "byte_size", "sha256"}, location)
    path = _absolute_no_symlink(
        Path(_text(binding.get("path"), f"{location}.path")), location=location
    )
    if not path.is_file():
        raise IntakeError(f"{location}: bound file disappeared")
    size = binding.get("byte_size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise IntakeError(f"{location}: invalid byte size")
    if path.stat().st_size != size or sha256_file(path) != _sha(
        binding.get("sha256"), f"{location}.sha256"
    ):
        raise IntakeError(f"{location}: bound file changed")
    return path


def _write_once(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as error:
        raise IntakeError(f"append-only output already exists: {path}") from error


@contextmanager
def _workspace_lock(root: Path) -> Iterator[None]:
    lock = root / ".intake-v5.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise IntakeError("another intake command holds the workspace lock") from error
    os.close(descriptor)
    try:
        yield
    finally:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def _record_hash(row: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json_bytes(row))


def _load_master_index(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    rows = read_jsonl(path)
    index: dict[str, dict[str, Any]] = {}
    hashes: dict[str, str] = {}
    for line_number, row in enumerate(rows, 1):
        sample_id = _identifier(row.get("id"), f"master:{line_number}.id")
        if sample_id in index:
            raise IntakeError(f"duplicate master sample {sample_id}")
        index[sample_id] = row
        hashes[sample_id] = _record_hash(row)
    return index, hashes


def _canonical_split(
    split_path: Path, *, expected_sha: str
) -> tuple[dict[str, str], dict[str, Any]]:
    if sha256_file(split_path) != expected_sha:
        raise IntakeError("authoritative master split map binding changed")
    document = read_json(split_path)
    if document.get("schema_version") != 1:
        raise IntakeError("authoritative split-map schema changed")
    raw = _mapping(document.get("work_assignments"), "split_map.work_assignments")
    assignments: dict[str, str] = {}
    for key, value in raw.items():
        work_id = _identifier(key, "split_map.work_id")
        if value not in {"train", "val", "test"}:
            raise IntakeError(f"{work_id}: invalid canonical split")
        assignments[work_id] = str(value)
    return assignments, document


def _source_report_binding(source: Mapping[str, Any], *keys: str) -> Any:
    value: Any = source["source_report"]
    for key in keys:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def _master_keys(row: Mapping[str, Any]) -> set[str]:
    try:
        return {str(value) for value in delta._master_calibration_leakage_keys(row)}
    except delta.DeltaLedgerError as error:
        raise IntakeError(str(error)) from error


def _registry_catalog_signatures(
    document: Mapping[str, Any], *, location: str
) -> list[dict[str, str]]:
    signatures: list[dict[str, str]] = []
    for index, value in enumerate(
        _list(document.get("catalogs"), f"{location}.catalogs")
    ):
        item = _mapping(value, f"{location}.catalogs[{index}]")
        catalog_id = _identifier(
            item.get("catalog_id"), f"{location}.catalogs[{index}].catalog_id"
        )
        root = _absolute_no_symlink(
            Path(_text(item.get("root"), f"{location}.{catalog_id}.root")),
            location=f"{location}.{catalog_id}.root",
        )
        signatures.append(
            {
                "catalog_id": catalog_id,
                "source_kind": _text(
                    item.get("source_kind"), f"{location}.{catalog_id}.source_kind"
                ),
                "root": str(root),
                "manifest_sha256": _sha(
                    item.get("manifest_sha256"),
                    f"{location}.{catalog_id}.manifest_sha256",
                ),
            }
        )
    if len(signatures) != len({row["catalog_id"] for row in signatures}):
        raise IntakeError(f"{location}: duplicate catalog IDs")
    return sorted(signatures, key=lambda row: row["catalog_id"])


def _registry_exclusion_signatures(
    document: Mapping[str, Any], *, location: str
) -> list[dict[str, str]]:
    signatures: list[dict[str, str]] = []
    for index, value in enumerate(
        _list(document.get("exclusion_ledgers"), f"{location}.exclusion_ledgers")
    ):
        item = _mapping(value, f"{location}.exclusion_ledgers[{index}]")
        path = _absolute_no_symlink(
            Path(_text(item.get("path"), f"{location}.exclusion[{index}].path")),
            location=f"{location}.exclusion[{index}].path",
        )
        expected_sha = _sha(item.get("sha256"), f"{location}.exclusion[{index}].sha256")
        if not path.is_file() or sha256_file(path) != expected_sha:
            raise IntakeError(f"{location}: exclusion ledger bytes changed")
        signatures.append({"path": str(path), "sha256": expected_sha})
    if len(signatures) != len({row["path"] for row in signatures}):
        raise IntakeError(f"{location}: duplicate exclusion ledgers")
    return sorted(signatures, key=lambda row: row["path"])


def _registry_parent_signature(
    document: Mapping[str, Any], *, location: str
) -> dict[str, str]:
    parent_value = document.get("parent_master")
    parent = (
        _mapping(parent_value, f"{location}.parent_master")
        if isinstance(parent_value, Mapping)
        else {
            "manifest": document.get("parent_master_manifest"),
            "manifest_sha256": document.get("parent_master_manifest_sha256"),
        }
    )
    manifest = _absolute_no_symlink(
        Path(_text(parent.get("manifest"), f"{location}.parent_master.manifest")),
        location=f"{location}.parent_master.manifest",
    )
    expected_sha = _sha(
        parent.get("manifest_sha256"),
        f"{location}.parent_master.manifest_sha256",
    )
    if not manifest.is_file() or sha256_file(manifest) != expected_sha:
        raise IntakeError(f"{location}: parent master bytes changed")
    return {"manifest": str(manifest), "manifest_sha256": expected_sha}


def _registry_frozen_split_signature(
    document: Mapping[str, Any], *, location: str
) -> dict[str, str]:
    frozen_value = document.get("frozen_split_map")
    frozen = (
        _mapping(frozen_value, f"{location}.frozen_split_map")
        if isinstance(frozen_value, Mapping)
        else {
            "path": frozen_value,
            "sha256": document.get("frozen_split_map_sha256"),
        }
    )
    path = _absolute_no_symlink(
        Path(_text(frozen.get("path"), f"{location}.frozen_split_map.path")),
        location=f"{location}.frozen_split_map.path",
    )
    expected_sha = _sha(frozen.get("sha256"), f"{location}.frozen_split_map.sha256")
    if not path.is_file() or sha256_file(path) != expected_sha:
        raise IntakeError(f"{location}: frozen split bytes changed")
    return {"path": str(path), "sha256": expected_sha}


def _stable_master_projection(
    row: Mapping[str, Any], *, catalog_source: bool = False
) -> dict[str, Any]:
    """Remove only fields deterministically recomputed by the union builder."""

    output = copy.deepcopy(dict(row))
    output.pop("work_balance_weight", None)
    if catalog_source:
        output.pop("split", None)
        groups = output.get("groups")
        if isinstance(groups, dict):
            groups.pop("split_component", None)
    return output


def validate_registry_successor_contract(
    expected: Mapping[str, Any], current: Mapping[str, Any]
) -> None:
    if (
        _registry_catalog_signatures(expected, location="registry successor input")
        != _registry_catalog_signatures(current, location="successor registry")
        or _registry_exclusion_signatures(expected, location="registry successor input")
        != _registry_exclusion_signatures(current, location="successor registry")
        or _registry_parent_signature(expected, location="registry successor input")
        != _registry_parent_signature(current, location="successor registry")
        or _registry_frozen_split_signature(
            expected, location="registry successor input"
        )
        != _registry_frozen_split_signature(current, location="successor registry")
    ):
        raise IntakeError("successor registry differs from the sealed registry input")


def validate_successor_master_delta(
    *,
    base_master: Mapping[str, Mapping[str, Any]],
    current_master: Mapping[str, Mapping[str, Any]],
    excluded_parent_ids: Iterable[str],
    successor_ids: Iterable[str],
    expected_successors: Mapping[str, Mapping[str, Any]],
    successor_split_document: Mapping[str, Any],
) -> None:
    excluded = {str(value) for value in excluded_parent_ids}
    successors = {str(value) for value in successor_ids}
    base_ids = set(base_master)
    current_ids = set(current_master)
    if base_ids - current_ids != excluded:
        raise IntakeError("successor master removed rows other than the 20 parents")
    if current_ids - base_ids != successors:
        raise IntakeError("successor master added rows other than the 18 successors")
    for sample_id in sorted(base_ids & current_ids):
        if _stable_master_projection(
            base_master[sample_id]
        ) != _stable_master_projection(current_master[sample_id]):
            raise IntakeError(f"successor master changed common row: {sample_id}")
    if set(expected_successors) != successors:
        raise IntakeError("promotion catalog forecast differs from successor IDs")
    assignments = _mapping(
        successor_split_document.get("work_assignments"),
        "successor split.work_assignments",
    )
    for sample_id in sorted(successors):
        actual = current_master[sample_id]
        if _stable_master_projection(
            expected_successors[sample_id], catalog_source=True
        ) != _stable_master_projection(actual, catalog_source=True):
            raise IntakeError(f"successor master row differs from catalog: {sample_id}")
        work_id = _identifier(
            _mapping(actual.get("work"), f"successor[{sample_id}].work").get("id"),
            f"successor[{sample_id}].work.id",
        )
        if actual.get("split") != assignments.get(work_id):
            raise IntakeError(
                f"successor row split differs from work authority: {sample_id}"
            )


def validate_authority_successor_bridge(
    successor_bridge_root: Path,
    *,
    base_master_manifest_sha256: str,
    base_master_split_map_sha256: str,
    base_catalog_registry_sha256: str,
    base_catalog_registry_record_sha256: str,
    successor_master_root: Path | None = None,
    successor_catalog_registry: Path | None = None,
    successor_split_map: Path | None = None,
) -> dict[str, Any]:
    """Validate the one approved v2 -> v3 authority succession without a bypass."""

    bridge_root = _absolute_no_symlink(
        successor_bridge_root, location="successor bridge root"
    )
    if not bridge_root.is_dir():
        raise IntakeError("successor bridge root must be a directory")
    try:
        promotion_report = promotion.validate_tree(bridge_root, verify_assets=False)
    except (promotion.FontSignalPromotionError, OSError) as error:
        raise IntakeError(f"invalid successor promotion tree: {error}") from error
    if (
        promotion_report.get("record_type")
        != "font_matching_font_signal_recrop_promotion_report"
        or promotion_report.get("completed") is not True
    ):
        raise IntakeError("successor promotion report is not final")
    counts = _mapping(promotion_report.get("counts"), "promotion report.counts")
    if (
        counts.get("parents_excluded") != 20
        or counts.get("promoted_successors") != 18
        or counts.get("human_reviewed_terminal_exclusions") != 2
    ):
        raise IntakeError("successor promotion population is not exact 20 -> 18")
    safety = _mapping(promotion_report.get("safety"), "promotion report.safety")
    if (
        safety.get("generated_or_synthetic_pixels") != 0
        or safety.get("qa_overlay_pixels") != 0
        or safety.get("glyph_pixels_source_derived_only") is not True
    ):
        raise IntakeError("successor promotion is not source-derived-only")

    base_manifest_sha = _sha(base_master_manifest_sha256, "base_master_manifest_sha256")
    base_split_sha = _sha(base_master_split_map_sha256, "base_master_split_map_sha256")
    base_registry_sha = _sha(
        base_catalog_registry_sha256, "base_catalog_registry_sha256"
    )
    base_registry_record = _sha(
        base_catalog_registry_record_sha256,
        "base_catalog_registry_record_sha256",
    )
    promotion_inputs = _mapping(
        promotion_report.get("inputs"), "promotion report.inputs"
    )
    if (
        promotion_inputs.get("source_master_manifest_sha256") != base_manifest_sha
        or promotion_inputs.get("registry_sha256") != base_registry_sha
        or promotion_inputs.get("registry_record_sha256") != base_registry_record
    ):
        raise IntakeError("promotion does not descend from the rescue v2 authority")

    base_manifest = _absolute_no_symlink(
        Path(
            _text(
                promotion_inputs.get("source_master_manifest"),
                "promotion source master manifest",
            )
        ),
        location="promotion source master manifest",
    )
    base_root = base_manifest.parent
    base_report_path = _absolute_no_symlink(
        base_root / "report.json", location="base master report"
    )
    base_split_path = _absolute_no_symlink(
        base_root / "split_map.json", location="base master split"
    )
    if (
        sha256_file(base_manifest) != base_manifest_sha
        or sha256_file(base_report_path)
        != _sha(
            promotion_inputs.get("source_master_report_sha256"),
            "promotion source master report sha256",
        )
        or sha256_file(base_split_path) != base_split_sha
    ):
        raise IntakeError("base v2 master bytes differ from the promotion authority")
    base_report = read_json(base_report_path)
    if (
        _source_report_binding(
            {"source_report": base_report}, "outputs", "master_manifest_sha256"
        )
        != base_manifest_sha
        or _source_report_binding(
            {"source_report": base_report}, "outputs", "split_map_sha256"
        )
        != base_split_sha
    ):
        raise IntakeError("base v2 report no longer binds its manifest/split")

    base_registry_path = _absolute_no_symlink(
        Path(_text(promotion_inputs.get("registry_path"), "promotion registry path")),
        location="promotion base registry",
    )
    if sha256_file(base_registry_path) != base_registry_sha:
        raise IntakeError("base v2 registry file changed")
    base_registry_document = read_json(base_registry_path)
    if (
        validate_seal(base_registry_document, "base v2 registry")
        != base_registry_record
    ):
        raise IntakeError("base v2 registry record changed")

    registry_input_path = _absolute_no_symlink(
        bridge_root / promotion.REGISTRY_INPUT_FILE,
        location="promotion registry successor input",
    )
    registry_input = read_json(registry_input_path)
    validate_seal(registry_input, "promotion registry successor input")
    current_registry_binding = _mapping(
        registry_input.get("current_registry"), "registry input.current_registry"
    )
    if (
        current_registry_binding.get("sha256") != base_registry_sha
        or current_registry_binding.get("record_sha256") != base_registry_record
        or _absolute_no_symlink(
            Path(
                _text(
                    current_registry_binding.get("path"),
                    "registry input.current_registry.path",
                )
            ),
            location="registry input current registry",
        )
        != base_registry_path
    ):
        raise IntakeError("registry successor input does not bind the base registry")

    declared_successor_registry = _absolute_no_symlink(
        Path(
            _text(
                registry_input.get("successor_registry_output"),
                "registry input.successor_registry_output",
            )
        ),
        location="declared successor registry",
    )
    declared_successor_master = _absolute_no_symlink(
        Path(
            _text(
                registry_input.get("successor_master_output"),
                "registry input.successor_master_output",
            )
        ),
        location="declared successor master",
    )
    selected_registry = (
        _absolute_no_symlink(
            successor_catalog_registry, location="selected successor registry"
        )
        if successor_catalog_registry is not None
        else declared_successor_registry
    )
    selected_master_root = (
        _absolute_no_symlink(
            successor_master_root, location="selected successor master"
        )
        if successor_master_root is not None
        else declared_successor_master
    )
    if (
        selected_registry != declared_successor_registry
        or selected_master_root != declared_successor_master
    ):
        raise IntakeError("selected v3 authority differs from the declared successor")
    if not selected_master_root.is_dir() or not selected_registry.is_file():
        raise IntakeError("declared successor registry/master is incomplete")

    current_registry_document = read_json(selected_registry)
    current_registry_record = validate_seal(
        current_registry_document, "successor catalog registry"
    )
    try:
        master_builder.load_catalog_registry(selected_registry)
    except master_builder.MasterManifestError as error:
        raise IntakeError(f"invalid successor registry: {error}") from error
    validate_registry_successor_contract(registry_input, current_registry_document)

    current_manifest = _absolute_no_symlink(
        selected_master_root / "manifest.jsonl", location="successor master manifest"
    )
    current_report_path = _absolute_no_symlink(
        selected_master_root / "report.json", location="successor master report"
    )
    current_split_path = _absolute_no_symlink(
        selected_master_root / "split_map.json", location="successor master split"
    )
    if (
        successor_split_map is not None
        and _absolute_no_symlink(
            successor_split_map, location="selected successor split"
        )
        != current_split_path
    ):
        raise IntakeError("selected split map is outside the successor master")
    current_report = read_json(current_report_path)
    current_manifest_sha = sha256_file(current_manifest)
    current_split_sha = sha256_file(current_split_path)
    registry_attestation = _mapping(
        _source_report_binding(
            {"source_report": current_report},
            "inputs",
            "attestation",
            "catalog_registry",
        ),
        "successor report catalog registry attestation",
    )
    if (
        _source_report_binding(
            {"source_report": current_report}, "outputs", "master_manifest_sha256"
        )
        != current_manifest_sha
        or _source_report_binding(
            {"source_report": current_report}, "outputs", "split_map_sha256"
        )
        != current_split_sha
        or registry_attestation.get("sha256") != sha256_file(selected_registry)
        or registry_attestation.get("record_sha256") != current_registry_record
    ):
        raise IntakeError("successor master report binding changed")

    base_split_document = read_json(base_split_path)
    current_split_document = read_json(current_split_path)
    identity = validate_successor_split_identity(
        base_split_document, current_split_document, intake_work_ids=[]
    )

    crosswalk_rows = read_jsonl(bridge_root / promotion.CROSSWALK_FILE)
    exclusion_rows = read_jsonl(bridge_root / promotion.EXCLUSIONS_FILE)
    excluded_parent_ids = sorted(
        _identifier(row.get("parent_master_id"), "promotion exclusion parent")
        for row in exclusion_rows
    )
    successor_ids = sorted(
        _identifier(row.get("successor_expected_master_id"), "promotion successor")
        for row in crosswalk_rows
    )
    if (
        len(excluded_parent_ids) != 20
        or len(set(excluded_parent_ids)) != 20
        or len(successor_ids) != 18
        or len(set(successor_ids)) != 18
    ):
        raise IntakeError("promotion parent/successor IDs are not exact")

    base_master, _ = _load_master_index(base_manifest)
    current_master, _ = _load_master_index(current_manifest)
    promotion_catalog = master_builder.read_catalog(
        master_builder.SourceCatalog(
            _identifier(
                promotion_report.get("catalog_id"), "promotion report.catalog_id"
            ),
            "hard",
            bridge_root,
        ),
        verify_assets=False,
    )
    expected_successors = {
        _identifier(row.get("id"), "promotion catalog master id"): row
        for row in promotion_catalog.records
    }
    validate_successor_master_delta(
        base_master=base_master,
        current_master=current_master,
        excluded_parent_ids=excluded_parent_ids,
        successor_ids=successor_ids,
        expected_successors=expected_successors,
        successor_split_document=current_split_document,
    )

    if set(excluded_parent_ids).intersection(successor_ids):
        raise IntakeError("promotion parent/successor IDs overlap")
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": SUCCESSOR_BRIDGE_RECORD_TYPE,
            "promotion_root": str(bridge_root),
            "promotion_report": _file_binding(bridge_root / promotion.REPORT_FILE),
            "promotion_report_record_sha256": promotion_report["record_sha256"],
            "promotion_marker": _file_binding(bridge_root / promotion.MARKER_FILE),
            "promotion_manifest": _file_binding(bridge_root / promotion.MANIFEST_FILE),
            "promotion_crosswalk": _file_binding(
                bridge_root / promotion.CROSSWALK_FILE
            ),
            "promotion_parent_exclusions": _file_binding(
                bridge_root / promotion.EXCLUSIONS_FILE
            ),
            "registry_successor_input": _file_binding(registry_input_path),
            "registry_successor_input_record_sha256": registry_input["record_sha256"],
            "base_master_manifest": _file_binding(base_manifest),
            "base_master_report": _file_binding(base_report_path),
            "base_master_split_map": _file_binding(base_split_path),
            "base_catalog_registry": _file_binding(base_registry_path),
            "base_catalog_registry_record_sha256": base_registry_record,
            "successor_master_manifest": _file_binding(current_manifest),
            "successor_master_report": _file_binding(current_report_path),
            "successor_master_split_map": _file_binding(current_split_path),
            "successor_catalog_registry": _file_binding(selected_registry),
            "successor_catalog_registry_record_sha256": current_registry_record,
            "authoritative_split_identity": identity,
            "excluded_parent_ids": excluded_parent_ids,
            "excluded_parent_count": len(excluded_parent_ids),
            "excluded_parent_ids_sha256": sha256_bytes(
                canonical_json_bytes(excluded_parent_ids)
            ),
            "successor_ids": successor_ids,
            "successor_count": len(successor_ids),
            "successor_ids_sha256": sha256_bytes(canonical_json_bytes(successor_ids)),
            "source_pool_policy": {
                "excluded_parents_removed": True,
                "successors_auto_inherited": False,
            },
        }
    )


def _load_authoritative_inputs(
    *,
    master_root: Path,
    catalog_registry: Path,
    master_split_map: Path,
    base_rescue_inputs: Path,
    font_signal_audit: Path,
    prior_calibration_subsets: Sequence[Path],
    library_root: Path,
    successor_bridge_root: Path | None = None,
) -> dict[str, Any]:
    master_root = _absolute_no_symlink(master_root, location="master_root")
    catalog_registry = _absolute_no_symlink(
        catalog_registry, location="catalog_registry"
    )
    master_split_map = _absolute_no_symlink(
        master_split_map, location="master_split_map"
    )
    base_rescue_inputs = _absolute_no_symlink(
        base_rescue_inputs, location="base_rescue_inputs"
    )
    font_signal_audit = _absolute_no_symlink(
        font_signal_audit, location="font_signal_audit"
    )
    library_root = _absolute_no_symlink(library_root, location="library_root")
    resolved_bridge_root = (
        _absolute_no_symlink(successor_bridge_root, location="successor_bridge_root")
        if successor_bridge_root is not None
        else None
    )
    resolved_prior_paths = [
        _absolute_no_symlink(path, location="prior calibration subset")
        for path in prior_calibration_subsets
    ]
    if (
        not master_root.is_dir()
        or not base_rescue_inputs.is_dir()
        or not font_signal_audit.is_dir()
        or not library_root.is_dir()
    ):
        raise IntakeError("master, rescue, and library roots must be directories")
    manifest_path = _absolute_no_symlink(
        master_root / "manifest.jsonl", location="master manifest"
    )
    report_path = _absolute_no_symlink(
        master_root / "report.json", location="master report"
    )
    if master_split_map != _absolute_no_symlink(
        master_root / "split_map.json", location="master split map in root"
    ):
        raise IntakeError(
            "--master-split-map must be the selected master root split_map.json"
        )
    master_report = read_json(report_path)
    expected_manifest_sha = _source_report_binding(
        {"source_report": master_report}, "outputs", "master_manifest_sha256"
    )
    expected_split_sha = _source_report_binding(
        {"source_report": master_report}, "outputs", "split_map_sha256"
    )
    if sha256_file(manifest_path) != expected_manifest_sha:
        raise IntakeError("master manifest differs from its report")
    if sha256_file(master_split_map) != expected_split_sha:
        raise IntakeError("master split map differs from its report")
    registry_attestation = _mapping(
        _source_report_binding(
            {"source_report": master_report},
            "inputs",
            "attestation",
            "catalog_registry",
        ),
        "master report catalog registry attestation",
    )
    if sha256_file(catalog_registry) != _sha(
        registry_attestation.get("sha256"),
        "master report catalog registry sha256",
    ):
        raise IntakeError("catalog registry differs from the selected master report")
    registry_document = read_json(catalog_registry)
    current_registry_record = validate_seal(registry_document, "catalog registry")
    if current_registry_record != _sha(
        registry_attestation.get("record_sha256"),
        "master report catalog registry record",
    ):
        raise IntakeError("catalog registry record differs from the selected master")

    try:
        source = delta._validate_source_inputs(base_rescue_inputs, font_signal_audit)
        prior = delta._load_prior_calibration_subsets(
            resolved_prior_paths, source=source
        )
    except delta.DeltaLedgerError as error:
        raise IntakeError(str(error)) from error
    if len(resolved_prior_paths) != len(EXPECTED_PRIOR_ROUND_IDS):
        raise IntakeError(
            "exactly the sealed prior calibration subsets v1/v2/v3 are required"
        )

    rescue_manifest_sha = _source_report_binding(
        source, "inputs", "master_manifest_sha256"
    )
    rescue_split_sha = _source_report_binding(
        source, "inputs", "master_split_map_sha256"
    )
    rescue_registry_sha = _source_report_binding(
        source, "inputs", "catalog_registry_sha256"
    )
    rescue_registry_record = _source_report_binding(
        source, "inputs", "catalog_registry_record_sha256"
    )
    current_manifest_sha = sha256_file(manifest_path)
    current_split_sha = sha256_file(master_split_map)
    current_registry_sha = sha256_file(catalog_registry)
    direct_authority = (
        rescue_manifest_sha == current_manifest_sha
        and rescue_split_sha == current_split_sha
        and rescue_registry_sha == current_registry_sha
        and rescue_registry_record == current_registry_record
    )
    authority_bridge: dict[str, Any] | None = None
    if direct_authority:
        if resolved_bridge_root is not None:
            raise IntakeError("successor bridge supplied for an unchanged authority")
    else:
        if resolved_bridge_root is None:
            raise IntakeError(
                "selected authority differs from rescue v2; --successor-bridge-root is required"
            )
        authority_bridge = validate_authority_successor_bridge(
            resolved_bridge_root,
            base_master_manifest_sha256=_sha(
                rescue_manifest_sha, "rescue master manifest sha256"
            ),
            base_master_split_map_sha256=_sha(
                rescue_split_sha, "rescue master split sha256"
            ),
            base_catalog_registry_sha256=_sha(
                rescue_registry_sha, "rescue catalog registry sha256"
            ),
            base_catalog_registry_record_sha256=_sha(
                rescue_registry_record, "rescue catalog registry record"
            ),
            successor_master_root=master_root,
            successor_catalog_registry=catalog_registry,
            successor_split_map=master_split_map,
        )
    try:
        registry_configuration = master_builder.load_catalog_registry(catalog_registry)
    except master_builder.MasterManifestError as error:
        raise IntakeError(str(error)) from error

    assignments, split_document = _canonical_split(
        master_split_map, expected_sha=str(current_split_sha)
    )
    work_digest = sha256_bytes(canonical_json_bytes(assignments))
    frozen_source = _mapping(
        _mapping(split_document.get("algorithm"), "split_map.algorithm").get(
            "frozen_source"
        ),
        "split_map.algorithm.frozen_source",
    )
    frozen_source_sha = _sha(
        frozen_source.get("sha256"), "split_map.algorithm.frozen_source.sha256"
    )

    authoritative_master, authoritative_hashes = _load_master_index(manifest_path)
    authority_removed_parent_ids = set(
        str(value)
        for value in (
            authority_bridge.get("excluded_parent_ids", [])
            if authority_bridge is not None
            else []
        )
    )
    for sample_id, row in source["master"].items():
        authoritative = authoritative_master.get(sample_id)
        if sample_id in authority_removed_parent_ids:
            if authoritative is not None:
                raise IntakeError(
                    f"authority-excluded parent remains in successor master: {sample_id}"
                )
            continue
        if authoritative is None:
            raise IntakeError(f"base rescue sample is absent from master: {sample_id}")
        if _master_keys(row) != _master_keys(authoritative) or any(
            row.get(field) != authoritative.get(field)
            for field in (
                "sample_crop_sha256",
                "work",
                "chapter",
                "page",
                "geometry",
                "groups",
                "provenance",
                "views",
            )
        ):
            raise IntakeError(
                f"base rescue/master source projection changed: {sample_id}"
            )

    if authority_bridge is not None:
        successor_ids = set(str(value) for value in authority_bridge["successor_ids"])
        if successor_ids.intersection(source["selection"]):
            raise IntakeError("v3 promotion successors were auto-inherited into rescue")
        for sample_id in authority_removed_parent_ids:
            source["selection"].pop(sample_id, None)
            if isinstance(source.get("inventory"), dict):
                source["inventory"].pop(sample_id, None)
            elif isinstance(source.get("inventory"), set):
                source["inventory"].discard(sample_id)
        source["authority_removed_parent_ids"] = sorted(authority_removed_parent_ids)
        source["authority_successor_ids_not_inherited"] = sorted(successor_ids)

    source["legacy_view_path_split_by_sample"] = dict(source["split_by_sample"])
    canonical_by_sample: dict[str, str] = {}
    for sample_id, row in source["selection"].items():
        work_id = _identifier(row.get("work_id"), f"selection[{sample_id}].work_id")
        split_name = assignments.get(work_id)
        if split_name is None:
            raise IntakeError(f"{sample_id}: work is absent from canonical split map")
        canonical_by_sample[sample_id] = split_name
    source["split_by_sample"] = canonical_by_sample

    prior_ids = set(str(value) for value in prior["excluded_sample_ids"])
    prior_keys: set[str] = set()
    for sample_id in prior_ids:
        row = source["master"].get(sample_id) or authoritative_master.get(sample_id)
        if row is not None:
            prior_keys.update(_master_keys(_mapping(row, f"master[{sample_id}]")))

    nontrain_keys: set[str] = set()
    for sample_id, row in authoritative_master.items():
        work = _mapping(row.get("work"), f"master[{sample_id}].work")
        work_id = _identifier(work.get("id"), f"master[{sample_id}].work.id")
        split_name = assignments.get(work_id)
        if split_name is None:
            raise IntakeError(f"{sample_id}: authoritative work lacks a split")
        if split_name != "train":
            nontrain_keys.update(_master_keys(row))

    catalog_roots: dict[str, Path] = {}
    for entry in _list(registry_document.get("catalogs"), "registry.catalogs"):
        item = _mapping(entry, "registry.catalog")
        catalog_id = _identifier(item.get("catalog_id"), "registry.catalog_id")
        root = _absolute_no_symlink(
            Path(_text(item.get("root"), f"registry[{catalog_id}].root")),
            location=f"registry[{catalog_id}].root",
        )
        catalog_roots[catalog_id] = root

    parent_master_path: Path | None = None
    parent_master: dict[str, dict[str, Any]] = {}
    parent_hashes: dict[str, str] = {}
    parent_descriptor = registry_document.get("parent_master")
    if isinstance(parent_descriptor, Mapping):
        parent_master_path = _absolute_no_symlink(
            Path(
                _text(
                    parent_descriptor.get("manifest"), "registry.parent_master.manifest"
                )
            ),
            location="registry.parent_master.manifest",
        )
        if sha256_file(parent_master_path) != _sha(
            parent_descriptor.get("manifest_sha256"),
            "registry.parent_master.manifest_sha256",
        ):
            raise IntakeError("registry parent-master manifest changed")
        parent_master, parent_hashes = _load_master_index(parent_master_path)

    prior_history = _build_prior_calibration_history(
        paths=resolved_prior_paths,
        source=source,
        authoritative_master=authoritative_master,
        assignments=assignments,
        authoritative_split_identity={
            "frozen_source_sha256": frozen_source_sha,
            "work_assignments_sha256": work_digest,
        },
    )

    return {
        "source": source,
        "prior": prior,
        "master": authoritative_master,
        "master_hashes": authoritative_hashes,
        "parent_master": parent_master,
        "parent_master_hashes": parent_hashes,
        "parent_master_path": parent_master_path,
        "assignments": assignments,
        "split_document": split_document,
        "work_assignments_sha256": work_digest,
        "frozen_source_sha256": frozen_source_sha,
        "prior_conflict_keys": prior_keys,
        "nontrain_conflict_keys": nontrain_keys,
        "catalog_roots": catalog_roots,
        "registry_document": registry_document,
        "registry_configuration": registry_configuration,
        "paths": {
            "master_root": master_root,
            "master_manifest": manifest_path,
            "master_report": report_path,
            "master_split_map": master_split_map,
            "catalog_registry": catalog_registry,
            "base_rescue_inputs": base_rescue_inputs,
            "font_signal_audit": font_signal_audit,
            "library_root": library_root,
            "prior_calibration_subsets": resolved_prior_paths,
            "successor_bridge_root": resolved_bridge_root,
        },
        "bindings": {
            "master_manifest": _file_binding(manifest_path),
            "master_report": _file_binding(report_path),
            "master_split_map": _file_binding(master_split_map),
            "catalog_registry": _file_binding(catalog_registry),
            "rescue_report_record_sha256": source["source_report_record_sha256"],
            "font_signal_audit_report_record_sha256": source[
                "audit_report_record_sha256"
            ],
            "prior_subset_bindings": copy.deepcopy(prior["bindings"]),
            "authority_successor_bridge": copy.deepcopy(authority_bridge),
        },
        "authority_successor_bridge": authority_bridge,
        "prior_history": prior_history,
    }


def _build_prior_calibration_history(
    *,
    paths: Sequence[Path],
    source: Mapping[str, Any],
    authoritative_master: Mapping[str, Mapping[str, Any]],
    assignments: Mapping[str, str],
    authoritative_split_identity: Mapping[str, str],
) -> dict[str, Any]:
    """Create the self-contained, hash-chained v1-v3 history authority."""

    if len(paths) != len(EXPECTED_PRIOR_ROUND_IDS):
        raise IntakeError("prior calibration history must contain exact v1-v3")

    def canonical_train(sample_id: str) -> bool:
        row = authoritative_master.get(sample_id) or source["master"].get(sample_id)
        if not isinstance(row, Mapping):
            raise IntakeError(
                f"prior history sample is absent from authoritative master: {sample_id}"
            )
        work = _mapping(row.get("work"), f"prior master[{sample_id}].work")
        work_id = _identifier(work.get("id"), f"prior master[{sample_id}].work.id")
        split_name = assignments.get(work_id)
        if split_name is None:
            raise IntakeError(f"prior history work lacks canonical split: {work_id}")
        return split_name == "train"

    predecessor: str | None = None
    rounds: list[dict[str, Any]] = []
    closure_union: set[str] = set()
    quarantine_union: set[str] = set()
    for sequence, (path, expected_round_id) in enumerate(
        zip(paths, EXPECTED_PRIOR_ROUND_IDS), 1
    ):
        document = read_json(path)
        subset_record_sha = validate_seal(
            document, f"prior calibration history round {sequence}"
        )
        round_id = _identifier(
            document.get("round_id"), f"prior history[{sequence}].round_id"
        )
        if round_id != expected_round_id:
            raise IntakeError(
                "prior calibration subsets are missing, reordered, or not exact v1-v3; "
                f"expected {expected_round_id}, observed {round_id}"
            )
        selected = [
            _identifier(value, f"prior history[{sequence}].sample_ids")
            for value in _list(
                document.get("sample_ids"), f"prior history[{sequence}].sample_ids"
            )
        ]
        if len(selected) != len(set(selected)):
            raise IntakeError(f"prior history[{sequence}] selected IDs are duplicated")
        try:
            closure = delta._calibration_leakage_closure(source, set(selected))
        except delta.DeltaLedgerError as error:
            raise IntakeError(str(error)) from error
        canonical_closure = sorted(
            sample_id for sample_id in closure if canonical_train(str(sample_id))
        )
        declared_quarantine = [
            _identifier(value, f"prior history[{sequence}].training_quarantine")
            for value in _list(
                document.get("training_quarantine_sample_ids", []),
                f"prior history[{sequence}].training_quarantine_sample_ids",
            )
        ]
        canonical_quarantine = sorted(
            sample_id for sample_id in declared_quarantine if canonical_train(sample_id)
        )
        closure_union.update(canonical_closure)
        quarantine_union.update(canonical_quarantine)
        round_record = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_matching_prior_calibration_history_round",
                "sequence": sequence,
                "round_id": round_id,
                "subset_file": _file_binding(path),
                "subset_record_sha256": subset_record_sha,
                "disposition": "permanently_discarded_not_calibration_or_training_evidence",
                "selected_sample_ids": selected,
                "selected_sample_count": len(selected),
                "selected_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(selected)
                ),
                "canonical_train_closure_sample_ids": canonical_closure,
                "canonical_train_closure_count": len(canonical_closure),
                "canonical_train_closure_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(canonical_closure)
                ),
                "canonical_train_quarantine_sample_ids": canonical_quarantine,
                "canonical_train_quarantine_count": len(canonical_quarantine),
                "canonical_train_quarantine_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(canonical_quarantine)
                ),
                "predecessor_record_sha256": predecessor,
            }
        )
        predecessor = str(round_record["record_sha256"])
        rounds.append(round_record)

    closure_ids = sorted(closure_union)
    quarantine_ids = sorted(quarantine_union)
    permanent_ids = sorted(closure_union | quarantine_union)
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_prior_calibration_history_registry",
            "required_round_ids": list(EXPECTED_PRIOR_ROUND_IDS),
            "round_count": len(rounds),
            "rounds": rounds,
            "head_record_sha256": predecessor,
            "all_rounds_disposition": "permanently_discarded_not_calibration_or_training_evidence",
            "canonical_train_closure_union_sample_ids": closure_ids,
            "canonical_train_closure_union_count": len(closure_ids),
            "canonical_train_closure_union_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(closure_ids)
            ),
            "canonical_train_quarantine_union_sample_ids": quarantine_ids,
            "canonical_train_quarantine_union_count": len(quarantine_ids),
            "canonical_train_quarantine_union_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(quarantine_ids)
            ),
            "permanent_exclusion_union_sample_ids": permanent_ids,
            "permanent_exclusion_union_count": len(permanent_ids),
            "permanent_exclusion_union_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(permanent_ids)
            ),
            "authoritative_split_identity": copy.deepcopy(
                dict(authoritative_split_identity)
            ),
        }
    )


def split_identity(document: Mapping[str, Any]) -> dict[str, str]:
    algorithm = _mapping(document.get("algorithm"), "split_map.algorithm")
    frozen = _mapping(algorithm.get("frozen_source"), "split_map.frozen_source")
    assignments = _mapping(
        document.get("work_assignments"), "split_map.work_assignments"
    )
    normalized: dict[str, str] = {}
    for key, value in assignments.items():
        work_id = _identifier(key, "split_map.work_id")
        if value not in {"train", "val", "test"}:
            raise IntakeError(f"{work_id}: invalid work split")
        normalized[work_id] = str(value)
    return {
        "frozen_source_sha256": _sha(
            frozen.get("sha256"), "split_map.frozen_source.sha256"
        ),
        "work_assignments_sha256": sha256_bytes(canonical_json_bytes(normalized)),
    }


def validate_successor_split_identity(
    base: Mapping[str, Any],
    successor: Mapping[str, Any],
    *,
    intake_work_ids: Iterable[str],
) -> dict[str, str]:
    """Compare frozen assignment identity, deliberately ignoring component counts."""

    base_identity = split_identity(base)
    successor_identity = split_identity(successor)
    if base_identity != successor_identity:
        raise IntakeError("successor split changed frozen source or work assignments")
    assignments = _mapping(
        successor.get("work_assignments"), "successor.work_assignments"
    )
    for work_id in intake_work_ids:
        if assignments.get(work_id) != "train":
            raise IntakeError(f"intake work is not train in successor split: {work_id}")
    return base_identity


def _image_pixel_sha(image: Any) -> str:
    rgb = image.convert("RGB")
    return sha256_bytes(
        b"RGB\0"
        + rgb.width.to_bytes(8, "big")
        + rgb.height.to_bytes(8, "big")
        + rgb.tobytes()
    )


def _png_bytes(image: Any) -> bytes:
    import io

    stream = io.BytesIO()
    image.save(stream, format="PNG", optimize=False, compress_level=9)
    return stream.getvalue()


def _open_bound_image(
    path: Path,
    *,
    expected_sha: str,
    expected_size: Sequence[int] | None,
    location: str,
) -> Any:
    from PIL import Image, UnidentifiedImageError

    path = _absolute_no_symlink(path, location=location)
    if not path.is_file() or sha256_file(path) != expected_sha:
        raise IntakeError(f"{location}: image bytes changed")
    try:
        with Image.open(path) as opened:
            opened.load()
            image = opened.convert("RGB")
    except (OSError, UnidentifiedImageError) as error:
        raise IntakeError(f"{location}: image decode failed: {error}") from error
    if expected_size is not None and tuple(expected_size) != image.size:
        raise IntakeError(f"{location}: image dimensions changed")
    return image


def _letterbox(image: Any, size: int = 224) -> Any:
    from PIL import Image

    source = image.convert("RGB")
    scale = min(size / source.width, size / source.height)
    width = max(1, round(source.width * scale))
    height = max(1, round(source.height * scale))
    resized = source.resize((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(resized, ((size - width) // 2, (size - height) // 2))
    return canvas


def _view_descriptor(
    path: Path, image: Any, *, root: Path | None = None
) -> dict[str, Any]:
    relative: str | None = None
    if root is not None:
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError as error:
            raise IntakeError("view asset escapes its declared root") from error
    return {
        "path": str(path) if relative is None else relative,
        "file_sha256": sha256_file(path),
        "pixel_sha256": _image_pixel_sha(image),
        "size_px": [image.width, image.height],
        "mode": "RGB",
    }


def _normalize_bbox(value: Any, *, size: tuple[int, int], location: str) -> list[int]:
    if not (
        isinstance(value, list)
        and len(value) == 4
        and all(isinstance(item, int) and not isinstance(item, bool) for item in value)
    ):
        raise IntakeError(f"{location}: expected integer XYXY bbox")
    x1, y1, x2, y2 = value
    if not (0 <= x1 < x2 <= size[0] and 0 <= y1 < y2 <= size[1]):
        raise IntakeError(f"{location}: bbox escapes source-page pixels")
    return [x1, y1, x2, y2]


def _normalize_mask_shape(
    value: Any,
    *,
    page_size: tuple[int, int],
    crop_bbox: Sequence[int],
    location: str,
) -> dict[str, Any]:
    row = _mapping(value, location)
    shape = row.get("shape")
    if shape == "rect":
        _exact_keys(row, {"shape", "bbox_px"}, location)
        bbox = _normalize_bbox(row.get("bbox_px"), size=page_size, location=location)
        points = [(bbox[0], bbox[1]), (bbox[2], bbox[3])]
        normalized = {"shape": "rect", "bbox_px": bbox}
    elif shape == "polygon":
        _exact_keys(row, {"shape", "points_px"}, location)
        raw_points = _list(row.get("points_px"), f"{location}.points_px")
        if len(raw_points) < 3:
            raise IntakeError(f"{location}: polygon needs at least three points")
        points = []
        for index, raw_point in enumerate(raw_points):
            if not (
                isinstance(raw_point, list)
                and len(raw_point) == 2
                and all(
                    isinstance(item, int) and not isinstance(item, bool)
                    for item in raw_point
                )
            ):
                raise IntakeError(f"{location}.points_px[{index}]: invalid point")
            x, y = raw_point
            if not (0 <= x < page_size[0] and 0 <= y < page_size[1]):
                raise IntakeError(f"{location}: polygon escapes source page")
            points.append((x, y))
        normalized = {
            "shape": "polygon",
            "points_px": [[x, y] for x, y in points],
        }
    else:
        raise IntakeError(f"{location}: mask shape must be rect or polygon")
    x1, y1, x2, y2 = crop_bbox
    for x, y in points:
        if not (x1 <= x <= x2 and y1 <= y <= y2):
            raise IntakeError(
                f"{location}: mask coordinates must stay inside crop bbox"
            )
    return normalized


def _normalize_mask_contract(
    value: Any,
    *,
    page_size: tuple[int, int],
    crop_bbox: Sequence[int],
    location: str,
) -> dict[str, Any]:
    if value is None:
        raw: Mapping[str, Any] = {
            "coordinate_space": "source_page_pixels_xyxy",
            "keep": [],
            "exclude": [],
            "exclude_components_touching_edges": [],
        }
    else:
        raw = _mapping(value, location)
        allowed = {
            "coordinate_space",
            "keep",
            "exclude",
            "exclude_components_touching_edges",
        }
        if (
            not {"coordinate_space", "keep", "exclude"}.issubset(raw)
            or set(raw) - allowed
        ):
            raise IntakeError(
                f"{location}: mask keys changed; required coordinate_space/keep/"
                "exclude and optional exclude_components_touching_edges"
            )
    if raw.get("coordinate_space") != "source_page_pixels_xyxy":
        raise IntakeError(f"{location}: mask coordinate space changed")
    result = {
        "coordinate_space": "source_page_pixels_xyxy",
        "keep": [
            _normalize_mask_shape(
                item,
                page_size=page_size,
                crop_bbox=crop_bbox,
                location=f"{location}.keep[{index}]",
            )
            for index, item in enumerate(_list(raw.get("keep"), f"{location}.keep"))
        ],
        "exclude": [
            _normalize_mask_shape(
                item,
                page_size=page_size,
                crop_bbox=crop_bbox,
                location=f"{location}.exclude[{index}]",
            )
            for index, item in enumerate(
                _list(raw.get("exclude"), f"{location}.exclude")
            )
        ],
        "exclude_components_touching_edges": [],
    }
    operations = raw.get("exclude_components_touching_edges", [])
    for index, value in enumerate(
        _list(operations, f"{location}.exclude_components_touching_edges")
    ):
        operation_location = f"{location}.exclude_components_touching_edges[{index}]"
        operation = _mapping(value, operation_location)
        _exact_keys(
            operation,
            {
                "operation",
                "edges",
                "seed_regions",
                "connectivity",
                "foreground_algorithm",
                "foreground_luma_max",
                "alpha_policy",
                "antialias_policy",
            },
            operation_location,
        )
        if operation.get("operation") != "exclude_components_touching_edges":
            raise IntakeError(f"{operation_location}: unsupported operation")
        raw_edges = _list(operation.get("edges"), f"{operation_location}.edges")
        if not raw_edges or any(
            edge not in {"top", "bottom", "left", "right"} for edge in raw_edges
        ):
            raise IntakeError(f"{operation_location}: invalid edge inventory")
        edges = sorted(set(str(edge) for edge in raw_edges))
        if len(edges) != len(raw_edges):
            raise IntakeError(f"{operation_location}: duplicate edge")
        if operation.get("connectivity") != 8:
            raise IntakeError(f"{operation_location}: connectivity must be 8")
        if operation.get("foreground_algorithm") != "bt601_integer_luma_v1":
            raise IntakeError(f"{operation_location}: foreground algorithm changed")
        luma_max = operation.get("foreground_luma_max")
        if (
            isinstance(luma_max, bool)
            or not isinstance(luma_max, int)
            or not 0 <= luma_max < 255
        ):
            raise IntakeError(f"{operation_location}: invalid luma threshold")
        if operation.get("alpha_policy") != "convert_to_rgb_before_segmentation":
            raise IntakeError(f"{operation_location}: alpha policy changed")
        if operation.get("antialias_policy") != "inclusive_luma_threshold_no_dilation":
            raise IntakeError(f"{operation_location}: antialias policy changed")
        seeds = [
            _normalize_mask_shape(
                seed,
                page_size=page_size,
                crop_bbox=crop_bbox,
                location=f"{operation_location}.seed_regions[{seed_index}]",
            )
            for seed_index, seed in enumerate(
                _list(
                    operation.get("seed_regions"),
                    f"{operation_location}.seed_regions",
                )
            )
        ]
        result["exclude_components_touching_edges"].append(
            {
                "operation": "exclude_components_touching_edges",
                "edges": edges,
                "seed_regions": seeds,
                "connectivity": 8,
                "foreground_algorithm": "bt601_integer_luma_v1",
                "foreground_luma_max": luma_max,
                "alpha_policy": "convert_to_rgb_before_segmentation",
                "antialias_policy": "inclusive_luma_threshold_no_dilation",
            }
        )
    result["mask_contract_sha256"] = sha256_bytes(canonical_json_bytes(result))
    return result


def _masked_glyph(
    raw: Any, crop_bbox: Sequence[int], mask: Mapping[str, Any]
) -> tuple[Any, dict[str, Any]]:
    from PIL import Image, ImageDraw

    x1, y1, _, _ = crop_bbox
    keep_shapes = _list(mask.get("keep"), "mask.keep")
    selection = Image.new("L", raw.size, 0 if keep_shapes else 255)
    draw = ImageDraw.Draw(selection)

    def local_shape(shape: Mapping[str, Any]) -> tuple[str, Any]:
        if shape["shape"] == "rect":
            bx1, by1, bx2, by2 = shape["bbox_px"]
            return "rect", [
                bx1 - x1,
                by1 - y1,
                bx2 - x1 - 1,
                by2 - y1 - 1,
            ]
        return "polygon", [
            (point[0] - x1, point[1] - y1) for point in shape["points_px"]
        ]

    for shape in keep_shapes:
        kind, coordinates = local_shape(_mapping(shape, "mask.keep"))
        if kind == "rect":
            draw.rectangle(coordinates, fill=255)
        else:
            draw.polygon(coordinates, fill=255)
    for shape in _list(mask.get("exclude"), "mask.exclude"):
        kind, coordinates = local_shape(_mapping(shape, "mask.exclude"))
        if kind == "rect":
            draw.rectangle(coordinates, fill=0)
        else:
            draw.polygon(coordinates, fill=0)
    operation_results: list[dict[str, Any]] = []
    rgb = raw.convert("RGB")
    pixels = rgb.load()
    selected_pixels = selection.load()
    width, height = rgb.size
    neighbors = (
        (-1, -1),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    )

    for operation_index, operation_value in enumerate(
        _list(
            mask.get("exclude_components_touching_edges"),
            "mask.exclude_components_touching_edges",
        )
    ):
        operation = _mapping(operation_value, "component operation")
        threshold = int(operation["foreground_luma_max"])
        foreground: set[tuple[int, int]] = set()
        for local_y in range(height):
            for local_x in range(width):
                if not selected_pixels[local_x, local_y]:
                    continue
                red, green, blue = pixels[local_x, local_y]
                luma = (299 * red + 587 * green + 114 * blue + 500) // 1000
                if luma <= threshold:
                    foreground.add((local_x, local_y))

        seed_masks: list[Any] = []
        for seed_value in _list(operation.get("seed_regions"), "seed regions"):
            seed = _mapping(seed_value, "seed region")
            seed_mask = Image.new("1", (width, height), 0)
            seed_draw = ImageDraw.Draw(seed_mask)
            kind, coordinates = local_shape(seed)
            if kind == "rect":
                seed_draw.rectangle(coordinates, fill=1)
            else:
                seed_draw.polygon(coordinates, fill=1)
            seed_masks.append(seed_mask.load())

        unseen = set(foreground)
        components: list[list[tuple[int, int]]] = []
        while unseen:
            start = min(unseen, key=lambda point: (point[1], point[0]))
            unseen.remove(start)
            stack = [start]
            component: list[tuple[int, int]] = []
            while stack:
                point = stack.pop()
                component.append(point)
                px, py = point
                for dx, dy in neighbors:
                    neighbor = (px + dx, py + dy)
                    if neighbor in unseen:
                        unseen.remove(neighbor)
                        stack.append(neighbor)
            components.append(component)

        required_edges = set(str(edge) for edge in operation["edges"])

        def touches_required_edge(component: Sequence[tuple[int, int]]) -> bool:
            return any(
                ("top" in required_edges and py == 0)
                or ("bottom" in required_edges and py == height - 1)
                or ("left" in required_edges and px == 0)
                or ("right" in required_edges and px == width - 1)
                for px, py in component
            )

        selected_components: list[list[tuple[int, int]]] = []
        seed_hits = [False] * len(seed_masks)
        for component in components:
            if not touches_required_edge(component):
                continue
            hits = [
                any(seed_mask[px, py] for px, py in component)
                for seed_mask in seed_masks
            ]
            if seed_masks and not any(hits):
                continue
            selected_components.append(component)
            seed_hits = [prior or hit for prior, hit in zip(seed_hits, hits)]
        if not selected_components:
            raise IntakeError(
                f"component mask operation {operation_index} selected no component"
            )
        if seed_masks and not all(seed_hits):
            missing = [index for index, hit in enumerate(seed_hits) if not hit]
            raise IntakeError(
                f"component mask operation {operation_index} seed regions missed: {missing}"
            )

        component_hashes: list[str] = []
        removed = 0
        for component in selected_components:
            ordered = sorted(component, key=lambda point: (point[1], point[0]))
            component_hashes.append(
                sha256_bytes(canonical_json_bytes([[px, py] for px, py in ordered]))
            )
            for px, py in component:
                if selected_pixels[px, py]:
                    selected_pixels[px, py] = 0
                    removed += 1
        operation_results.append(
            {
                "operation_index": operation_index,
                "operation": "exclude_components_touching_edges",
                "edges": list(operation["edges"]),
                "foreground_luma_max": threshold,
                "foreground_pixel_count": len(foreground),
                "connected_component_count": len(components),
                "selected_component_count": len(selected_components),
                "excluded_pixel_count": removed,
                "seed_region_count": len(seed_masks),
                "seed_regions_hit": seed_hits,
                "selected_component_sha256s": sorted(component_hashes),
            }
        )
    white = Image.new("RGB", raw.size, (255, 255, 255))
    output = Image.composite(rgb, white, selection)
    execution = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_calibration_intake_mask_execution",
            "mask_contract_sha256": mask["mask_contract_sha256"],
            "source_raw_pixel_sha256": _image_pixel_sha(rgb),
            "operation_results": operation_results,
            "output_glyph_pixel_sha256": _image_pixel_sha(output),
        }
    )
    return output, execution


def _context_bbox(crop: Sequence[int], page_size: tuple[int, int]) -> list[int]:
    x1, y1, x2, y2 = crop
    padding = max(16, round(max(x2 - x1, y2 - y1) * 0.75))
    return [
        max(0, x1 - padding),
        max(0, y1 - padding),
        min(page_size[0], x2 + padding),
        min(page_size[1], y2 + padding),
    ]


def _render_review_montage(raw: Any, context: Any, glyph: Any) -> Any:
    from PIL import Image

    panels = [_letterbox(raw), _letterbox(context), _letterbox(glyph)]
    canvas = Image.new("RGB", (680, 224), (224, 224, 224))
    for index, panel in enumerate(panels):
        canvas.paste(panel, (index * 228, 0))
    return canvas


def _source_stratum(inputs: Mapping[str, Any], sample_id: str) -> str | None:
    test_projection = inputs.get("stratum_by_sample")
    if isinstance(test_projection, Mapping):
        value = test_projection.get(sample_id)
        return str(value) if isinstance(value, str) else None
    try:
        return delta._variant_v4_stratum(inputs["source"], sample_id)
    except delta.DeltaLedgerError as error:
        raise IntakeError(str(error)) from error


def _catalog_asset(
    inputs: Mapping[str, Any], descriptor: Mapping[str, Any], *, location: str
) -> tuple[Path, Any, dict[str, Any]]:
    catalog_id = _identifier(descriptor.get("catalog_id"), f"{location}.catalog_id")
    root = inputs["catalog_roots"].get(catalog_id)
    if root is None:
        raise IntakeError(f"{location}: unknown catalog root {catalog_id}")
    relative = _safe_relative(descriptor.get("path"), f"{location}.path")
    path = _resolve_inside(root, relative, location)
    expected_sha = _sha(descriptor.get("file_sha256"), f"{location}.file_sha256")
    expected_size = descriptor.get("expected_size_px") or descriptor.get(
        "declared_size_px"
    )
    if expected_size is not None and not (
        isinstance(expected_size, list)
        and len(expected_size) == 2
        and all(isinstance(value, int) and value > 0 for value in expected_size)
    ):
        raise IntakeError(f"{location}: invalid image size")
    image = _open_bound_image(
        path,
        expected_sha=expected_sha,
        expected_size=expected_size,
        location=location,
    )
    return (
        path,
        image,
        {
            "catalog_id": catalog_id,
            "path": relative.as_posix(),
            "root": str(root),
            "file_sha256": expected_sha,
            "pixel_sha256": _image_pixel_sha(image),
            "size_px": [image.width, image.height],
            "mode": "RGB",
        },
    )


def _existing_source_views(
    inputs: Mapping[str, Any], sample_id: str, row: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    views = _mapping(row.get("views"), f"master[{sample_id}].views")
    loaded: dict[str, Any] = {}
    bindings: dict[str, Any] = {}
    for name in ("context_224", "glyph_224"):
        descriptor = _mapping(views.get(name), f"master[{sample_id}].views.{name}")
        if descriptor.get("status") != "available":
            raise IntakeError(f"{sample_id}: {name} is not a clean available view")
        path, image, binding = _catalog_asset(
            inputs, descriptor, location=f"master[{sample_id}].views.{name}"
        )
        loaded[name] = image
        bindings[name] = {**binding, "absolute_path": str(path)}
    raw_descriptor = _mapping(
        views.get("raw_224"), f"master[{sample_id}].views.raw_224"
    )
    if raw_descriptor.get("status") == "available":
        path, image, binding = _catalog_asset(
            inputs, raw_descriptor, location=f"master[{sample_id}].views.raw_224"
        )
        loaded["raw"] = image
        bindings["raw"] = {**binding, "absolute_path": str(path)}
    elif raw_descriptor.get("status") == "derivable":
        native = _mapping(
            raw_descriptor.get("source_native"),
            f"master[{sample_id}].views.raw_224.source_native",
        )
        path, native_image, binding = _catalog_asset(
            inputs,
            native,
            location=f"master[{sample_id}].views.raw_224.source_native",
        )
        loaded["raw"] = _letterbox(native_image)
        bindings["raw"] = {
            **binding,
            "absolute_path": str(path),
            "materialization": "fontclip-letterbox-rgb-v1",
            "materialized_pixel_sha256": _image_pixel_sha(loaded["raw"]),
        }
    else:
        raise IntakeError(f"{sample_id}: raw source view is unavailable")
    return loaded, bindings


def _categorized_keys(row: Mapping[str, Any]) -> dict[str, list[str]]:
    categories: dict[str, list[str]] = {
        "exact": [],
        "page": [],
        "root": [],
        "variant": [],
        "glyph": [],
        "source": [],
        "lineage": [],
    }
    prefix_map = {
        "crop_sha256": "exact",
        "page.id": "page",
        "page.source_page_sha256": "page",
        "groups.root": "root",
        "groups.variant": "variant",
        "groups.normalized_glyph": "glyph",
        "provenance.source_id": "source",
        "provenance.lineage_id": "lineage",
    }
    for key in sorted(_master_keys(row)):
        prefix = key.split("\0", 1)[0]
        category = prefix_map.get(prefix)
        if category is not None:
            categories[category].append(key)
    if not all(categories[name] for name in categories):
        missing = [name for name, values in categories.items() if not values]
        raise IntakeError(f"source row lacks complete closure keys: {missing}")
    return categories


def _flat_closure(closure: Mapping[str, Any]) -> set[str]:
    return {
        _text(value, "closure key")
        for name in ("exact", "page", "root", "variant", "glyph", "source", "lineage")
        for value in _list(closure.get(name), f"closure.{name}")
    }


def _source_page(
    inputs: Mapping[str, Any], row: Mapping[str, Any], *, location: str
) -> tuple[Path, Any, Mapping[str, Any]]:
    page = _mapping(row.get("page"), f"{location}.page")
    locator = _mapping(page.get("source_locator"), f"{location}.page.source_locator")
    if (
        locator.get("storage_root") != "library_root"
        or locator.get("provenance") != "real_preserved"
    ):
        raise IntakeError(f"{location}: source page is not real preserved library data")
    relative = _safe_relative(locator.get("path"), f"{location}.source_locator.path")
    path = _resolve_inside(inputs["paths"]["library_root"], relative, location)
    expected_sha = _sha(locator.get("file_sha256"), f"{location}.source_locator.sha256")
    expected_size = locator.get("size_px")
    image = _open_bound_image(
        path,
        expected_sha=expected_sha,
        expected_size=expected_size,
        location=location,
    )
    if page.get("source_page_sha256") != expected_sha:
        raise IntakeError(f"{location}: page hashes disagree")
    return path, image, locator


def _materialize_or_validate(path: Path, payload: bytes, *, materialize: bool) -> None:
    if materialize:
        _write_once(path, payload)
    elif not path.is_file() or path.is_symlink() or path.read_bytes() != payload:
        raise IntakeError(f"prepared asset changed: {path}")


def _prepare_existing(
    inputs: Mapping[str, Any],
    proposal: Mapping[str, Any],
    *,
    index: int,
    expected_strata: Mapping[str, int],
) -> dict[str, Any]:
    _exact_keys(
        proposal, {"kind", "sample_id", "expected_stratum"}, f"proposal[{index}]"
    )
    sample_id = _identifier(proposal.get("sample_id"), f"proposal[{index}].sample_id")
    expected = _text(
        proposal.get("expected_stratum"), f"proposal[{index}].expected_stratum"
    )
    if expected not in expected_strata:
        raise IntakeError(f"proposal[{index}]: unsupported target stratum")
    row = inputs["master"].get(sample_id)
    selection = inputs["source"]["selection"].get(sample_id)
    if row is None:
        raise IntakeError(f"{sample_id}: existing proposal is absent from master")
    bridge = inputs.get("authority_successor_bridge")
    if isinstance(bridge, Mapping) and sample_id in set(bridge["successor_ids"]):
        raise IntakeError(f"{sample_id}: promotion successor cannot be auto-inherited")
    work_id = _identifier(
        _mapping(row.get("work"), f"master[{sample_id}].work").get("id"),
        f"master[{sample_id}].work.id",
    )
    if inputs["assignments"].get(work_id) != "train":
        raise IntakeError(f"{sample_id}: existing proposal is not canonical train")
    if selection is not None:
        derived = _source_stratum(inputs, sample_id)
        if derived != expected:
            raise IntakeError(
                f"{sample_id}: declared stratum {expected} differs from authoritative {derived}"
            )
    images, source_views = _existing_source_views(inputs, sample_id, row)
    closure = _categorized_keys(row)
    item_id = "intake-" + stable_hash("existing", sample_id)[:24]
    return {
        "intake_item_id": item_id,
        "kind": "existing_master",
        "sample_id": sample_id,
        "parent_sample_id": None,
        "expected_stratum": expected,
        "stratum_authority": (
            "bound_rescue_projection"
            if selection is not None
            else "dual_independent_source_visual_review"
        ),
        "work_id": work_id,
        "chapter_id": _identifier(
            _mapping(row.get("chapter"), f"master[{sample_id}].chapter").get("id"),
            f"master[{sample_id}].chapter.id",
        ),
        "page_id": _identifier(
            _mapping(row.get("page"), f"master[{sample_id}].page").get("id"),
            f"master[{sample_id}].page.id",
        ),
        "source_page_sha256": _sha(
            _mapping(row.get("page"), f"master[{sample_id}].page").get(
                "source_page_sha256"
            ),
            f"master[{sample_id}].page.source_page_sha256",
        ),
        "orientation": str(
            _mapping(row.get("metadata"), f"master[{sample_id}].metadata").get(
                "orientation"
            )
            or "horizontal"
        ),
        "closure": closure,
        "source_views": source_views,
        "master_record_sha256": inputs["master_hashes"][sample_id],
        "mask_contract": None,
        "mask_execution": None,
        "recrop": None,
        "catalog_row": None,
        "parent_exclusion": None,
        "_images": images,
    }


def _asset_record(
    path: str, payload: bytes, image: Any, *, kind: str
) -> dict[str, Any]:
    return {
        "path": path,
        "file_sha256": sha256_bytes(payload),
        "pixel_sha256": _image_pixel_sha(image),
        "size_px": [image.width, image.height],
        "mode": "RGB",
        "kind": kind,
        "provenance": "real_source_page_derived",
    }


def _prepare_recrop(
    inputs: Mapping[str, Any],
    proposal: Mapping[str, Any],
    *,
    index: int,
    prepared_root: Path,
    catalog_id: str,
    materialize: bool,
    expected_strata: Mapping[str, int],
) -> dict[str, Any]:
    _exact_keys(
        proposal,
        {
            "kind",
            "parent_sample_id",
            "expected_stratum",
            "crop_bbox_px",
            "context_bbox_px",
            "mask",
            "orientation",
        },
        f"proposal[{index}]",
    )
    parent_id = _identifier(
        proposal.get("parent_sample_id"), f"proposal[{index}].parent_sample_id"
    )
    expected = _text(
        proposal.get("expected_stratum"), f"proposal[{index}].expected_stratum"
    )
    if expected not in expected_strata:
        raise IntakeError(f"proposal[{index}]: unsupported target stratum")
    orientation = _text(proposal.get("orientation"), f"proposal[{index}].orientation")
    if orientation not in {"horizontal", "vertical"}:
        raise IntakeError(
            f"proposal[{index}]: orientation must be horizontal or vertical"
        )
    parent = inputs["master"].get(parent_id)
    registry_parent = inputs["parent_master"].get(parent_id)
    if parent is None:
        raise IntakeError(f"{parent_id}: recrop parent is absent from current master")
    if registry_parent is None or inputs["parent_master_path"] is None:
        raise IntakeError(
            f"{parent_id}: current registry generation cannot bind this parent exclusion"
        )
    parent_provenance = copy.deepcopy(
        dict(_mapping(parent.get("provenance"), f"master[{parent_id}].provenance"))
    )
    registry_parent_provenance = copy.deepcopy(
        dict(
            _mapping(
                registry_parent.get("provenance"),
                f"registry parent[{parent_id}].provenance",
            )
        )
    )
    parent_provenance.pop("source_kind", None)
    registry_parent_provenance.pop("source_kind", None)
    if (
        _master_keys(parent) != _master_keys(registry_parent)
        or parent_provenance != registry_parent_provenance
        or any(
            parent.get(field) != registry_parent.get(field)
            for field in (
                "sample_crop_sha256",
                "work",
                "chapter",
                "page",
                "geometry",
                "groups",
                "views",
            )
        )
    ):
        raise IntakeError(
            f"{parent_id}: registry parent generation differs from current parent source"
        )
    work_id = _identifier(
        _mapping(parent.get("work"), f"master[{parent_id}].work").get("id"),
        f"master[{parent_id}].work.id",
    )
    if inputs["assignments"].get(work_id) != "train":
        raise IntakeError(f"{parent_id}: recrop parent is not canonical train")
    page_path, page_image, locator = _source_page(
        inputs, parent, location=f"master[{parent_id}]"
    )
    page_size = page_image.size
    crop_bbox = _normalize_bbox(
        proposal.get("crop_bbox_px"),
        size=page_size,
        location=f"proposal[{index}].crop_bbox_px",
    )
    if proposal.get("context_bbox_px") is None:
        context_bbox = _context_bbox(crop_bbox, page_size)
    else:
        context_bbox = _normalize_bbox(
            proposal.get("context_bbox_px"),
            size=page_size,
            location=f"proposal[{index}].context_bbox_px",
        )
        if not (
            context_bbox[0] <= crop_bbox[0]
            and context_bbox[1] <= crop_bbox[1]
            and context_bbox[2] >= crop_bbox[2]
            and context_bbox[3] >= crop_bbox[3]
        ):
            raise IntakeError(f"proposal[{index}]: context bbox must contain crop bbox")
    mask = _normalize_mask_contract(
        proposal.get("mask"),
        page_size=page_size,
        crop_bbox=crop_bbox,
        location=f"proposal[{index}].mask",
    )
    prior_crop = _mapping(parent.get("geometry"), f"master[{parent_id}].geometry").get(
        "crop_bbox_px"
    )
    if (
        crop_bbox == prior_crop
        and not mask["keep"]
        and not mask["exclude"]
        and not mask["exclude_components_touching_edges"]
    ):
        raise IntakeError(f"{parent_id}: manual recrop is a no-op")

    raw_native = page_image.crop(tuple(crop_bbox)).convert("RGB")
    context_native = page_image.crop(tuple(context_bbox)).convert("RGB")
    glyph_native, mask_execution = _masked_glyph(raw_native, crop_bbox, mask)
    raw_224 = _letterbox(raw_native)
    context_224 = _letterbox(context_native)
    glyph_224 = _letterbox(glyph_native)
    crop_hash = _image_pixel_sha(raw_native)
    glyph_hash = _image_pixel_sha(glyph_native)
    source_id = (
        "fmi_"
        + stable_hash(
            catalog_id,
            parent_id,
            str(crop_bbox),
            str(context_bbox),
            mask["mask_contract_sha256"],
        )[:24]
    )
    sample_id = master_builder._master_id(catalog_id, source_id)
    lineage_id = "fmil_" + stable_hash(source_id, crop_hash, glyph_hash)[:24]
    root_id = "fmir_" + stable_hash(lineage_id, "root")[:24]
    variant_id = "fmiv_" + stable_hash(lineage_id, "variant")[:24]
    item_id = "intake-" + stable_hash("recrop", source_id)[:24]
    relative_root = PurePosixPath("recrop", item_id)
    images = {
        "raw_native": raw_native,
        "raw_224": raw_224,
        "context_native": context_native,
        "context_224": context_224,
        "glyph_native": glyph_native,
        "glyph_224": glyph_224,
    }
    filenames = {
        "raw_native": "raw.png",
        "raw_224": "raw_224.png",
        "context_native": "context.png",
        "context_224": "context_224.png",
        "glyph_native": "glyph.png",
        "glyph_224": "glyph_224.png",
    }
    assets: dict[str, dict[str, Any]] = {}
    for name, image in images.items():
        relative = relative_root / filenames[name]
        payload = _png_bytes(image)
        path = prepared_root.joinpath(*relative.parts)
        _materialize_or_validate(path, payload, materialize=materialize)
        assets[name] = _asset_record(relative.as_posix(), payload, image, kind=name)

    source_page_sha = _sha(
        _mapping(parent.get("page"), f"master[{parent_id}].page").get(
            "source_page_sha256"
        ),
        f"master[{parent_id}].source_page_sha256",
    )
    closure = {
        "exact": [f"crop_sha256\0{crop_hash}"],
        "page": [
            f"page.id\0{_mapping(parent.get('page'), 'parent.page').get('id')}",
            f"page.source_page_sha256\0{source_page_sha}",
        ],
        "root": [f"groups.root\0{catalog_id}:{root_id}"],
        "variant": [f"groups.variant\0{catalog_id}:{variant_id}"],
        "glyph": [f"groups.normalized_glyph\0glyph-white-sha256:{glyph_hash}"],
        "source": [f"provenance.source_id\0{source_id}"],
        "lineage": [f"provenance.lineage_id\0{lineage_id}"],
    }
    parent_provenance = _mapping(
        registry_parent.get("provenance"), f"parent_master[{parent_id}].provenance"
    )
    source_catalog_id = _identifier(
        parent_provenance.get("source_catalog_id"), "parent.source_catalog_id"
    )
    source_parent_id = _identifier(
        parent_provenance.get("source_id"), "parent.source_id"
    )
    source_line_number = parent_provenance.get("source_line_number")
    if (
        isinstance(source_line_number, bool)
        or not isinstance(source_line_number, int)
        or source_line_number < 1
    ):
        raise IntakeError(f"{parent_id}: invalid source line number")
    source_line_sha = _sha(
        parent_provenance.get("source_line_sha256"), "parent.source_line_sha256"
    )
    chapter = _mapping(parent.get("chapter"), f"master[{parent_id}].chapter")
    page = _mapping(parent.get("page"), f"master[{parent_id}].page")
    work = _mapping(parent.get("work"), f"master[{parent_id}].work")
    catalog_assets = {
        "raw": assets["raw_native"],
        "raw_224": assets["raw_224"],
        "context": assets["context_native"],
        "context_224": assets["context_224"],
        "glyph": assets["glyph_native"],
        "glyph_224": assets["glyph_224"],
    }
    catalog_row = seal(
        {
            "schema_version": 1,
            "id": source_id,
            "synthetic": False,
            "synthetic_provenance": None,
            "provenance": "real_manual_source_page_recrop",
            "split": "train",
            "work_id": work_id,
            "work_title": work.get("title"),
            "chapter_id": chapter.get("id"),
            "chapter_title": chapter.get("title"),
            "page_id": page.get("id"),
            "page_name": page.get("name"),
            "source_page_sha256": source_page_sha,
            "source_page_content_signature": {
                "sha256": source_page_sha,
                "size": page_path.stat().st_size,
            },
            "source_page_asset": {
                "path": locator.get("path"),
                "file_sha256": source_page_sha,
                "size_px": [page_image.width, page_image.height],
                "mode": "RGB",
                "storage_root": "library_root",
                "provenance": "real_preserved",
            },
            "source_image_path": locator.get("path"),
            "page_size_px": [page_image.width, page_image.height],
            "bbox_px": crop_bbox,
            "crop_bbox_px": crop_bbox,
            "final_bbox_px": context_bbox,
            "context_bbox_px": context_bbox,
            "crop_size_px": [raw_native.width, raw_native.height],
            "crop_sha256": crop_hash,
            "glyph_white_composite_sha256": glyph_hash,
            "root_real_id": root_id,
            "variant_group_id": variant_id,
            "orientation": orientation,
            "tier": "B",
            "image_path": assets["raw_native"]["path"],
            "raw_image_path": assets["raw_native"]["path"],
            "clip_image_path": assets["raw_224"]["path"],
            "context_224_path": assets["context_224"]["path"],
            "glyph_224_path": assets["glyph_224"]["path"],
            "assets": catalog_assets,
            "asset_file_sha256": {
                "image_path": assets["raw_native"]["file_sha256"],
                "clip_image_path": assets["raw_224"]["file_sha256"],
            },
            "mask_asset_sha256": {
                "context_224": assets["context_224"]["file_sha256"],
                "glyph_224": assets["glyph_224"]["file_sha256"],
            },
            "mask_contract": mask,
            "mask_execution": mask_execution,
            "lineage": [
                {
                    "id": lineage_id,
                    "provenance": "real_manual_recrop_new_lineage",
                    "source_page_sha256": source_page_sha,
                    "crop_sha256": crop_hash,
                    "mask_contract_sha256": mask["mask_contract_sha256"],
                    "mask_execution_record_sha256": mask_execution["record_sha256"],
                    "synthetic": False,
                }
            ],
            "review": {
                "status": "accepted",
                "decision": "pass",
                "source": "sealed_dual_independent_source_review_v5",
            },
            "adjudication": {
                "exhaustive_visual_review_passed": True,
                "manual_recrop": True,
                "source_only": True,
                "candidate_b_present": False,
                "synthetic": False,
            },
            "quality": {"status": "pass", "source_seal_required": True},
            "parent_master_link": {
                "parent_master_id": parent_id,
                "parent_master_record_sha256": inputs["master_hashes"][parent_id],
                "parent_exclusion_required": True,
            },
        }
    )
    exclusion = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_master_parent_exclusion",
            "source_catalog_id": source_catalog_id,
            "source_id": source_parent_id,
            "source_line_number": source_line_number,
            "source_line_sha256": source_line_sha,
            "parent_master_id": parent_id,
            "parent_master_record_sha256": inputs["parent_master_hashes"][parent_id],
            "successor_catalog_id": catalog_id,
            "successor_source_id": source_id,
            "successor_expected_master_id": sample_id,
            "excluded_from_training": True,
            "excluded_from_font_review": True,
            "prior_final_labels_invalidated": True,
            "terminal_status": "dual_source_seal_pass",
            "synthetic": False,
        }
    )
    return {
        "intake_item_id": item_id,
        "kind": "manual_recrop",
        "sample_id": sample_id,
        "parent_sample_id": parent_id,
        "expected_stratum": expected,
        "work_id": work_id,
        "chapter_id": _identifier(chapter.get("id"), "recrop.chapter_id"),
        "page_id": _identifier(page.get("id"), "recrop.page_id"),
        "source_page_sha256": source_page_sha,
        "orientation": orientation,
        "closure": closure,
        "source_views": {
            name: {**descriptor, "prepared_root": str(prepared_root)}
            for name, descriptor in assets.items()
        },
        "master_record_sha256": None,
        "mask_contract": mask,
        "mask_execution": mask_execution,
        "recrop": {
            "crop_bbox_px": crop_bbox,
            "context_bbox_px": context_bbox,
            "source_page": _file_binding(page_path),
            "source_page_relative_path": locator.get("path"),
            "source_id": source_id,
            "successor_master_id": sample_id,
            "lineage_id": lineage_id,
        },
        "catalog_row": catalog_row,
        "parent_exclusion": exclusion,
        "_images": {
            "raw": raw_native,
            "context_224": context_224,
            "glyph_224": glyph_224,
        },
    }


def _prepare_fresh_page_crop(
    inputs: Mapping[str, Any],
    proposal: Mapping[str, Any],
    *,
    index: int,
    prepared_root: Path,
    catalog_id: str,
    materialize: bool,
    expected_strata: Mapping[str, int],
) -> dict[str, Any]:
    """Derive a new lineage from a preserved page absent from the master.

    A deterministic virtual page-authority row is used only to reuse the
    established pixel/mask derivation implementation.  It is removed before
    publication: no nonexistent parent ID or exclusion is emitted.  The final
    catalog row instead seals the work/chapter/page JSON and source-page bytes.
    """

    expected_keys = {
        "kind",
        "work_id",
        "chapter_id",
        "page_id",
        "source_page_relative_path",
        "source_page_sha256",
        "expected_stratum",
        "crop_bbox_px",
        "context_bbox_px",
        "mask",
        "orientation",
    }
    _exact_keys(proposal, expected_keys, f"proposal[{index}]")
    work_id = _identifier(proposal.get("work_id"), f"proposal[{index}].work_id")
    chapter_id = _identifier(
        proposal.get("chapter_id"), f"proposal[{index}].chapter_id"
    )
    page_id = _identifier(proposal.get("page_id"), f"proposal[{index}].page_id")
    if inputs["assignments"].get(work_id) != "train":
        raise IntakeError(f"proposal[{index}]: fresh-page work is not canonical train")
    relative = _safe_relative(
        proposal.get("source_page_relative_path"),
        f"proposal[{index}].source_page_relative_path",
    )
    expected_prefix = ("works", work_id, "chapters", chapter_id, "pages")
    if tuple(relative.parts[:5]) != expected_prefix or page_id not in relative.name:
        raise IntakeError(
            f"proposal[{index}]: source page path does not bind work/chapter/page"
        )
    page_path = _resolve_inside(
        inputs["paths"]["library_root"], relative, f"proposal[{index}].source_page"
    )
    source_page_sha = _sha(
        proposal.get("source_page_sha256"),
        f"proposal[{index}].source_page_sha256",
    )
    page_image = _open_bound_image(
        page_path,
        expected_sha=source_page_sha,
        expected_size=None,
        location=f"proposal[{index}].source_page",
    )

    work_path = inputs["paths"]["library_root"] / "works" / work_id / "work.json"
    chapter_path = (
        inputs["paths"]["library_root"]
        / "works"
        / work_id
        / "chapters"
        / chapter_id
        / "chapter.json"
    )
    work_document = read_json(
        _absolute_no_symlink(work_path, location=f"proposal[{index}].work.json")
    )
    chapter_document = read_json(
        _absolute_no_symlink(
            chapter_path, location=f"proposal[{index}].chapter.json"
        )
    )
    if (
        work_document.get("id") != work_id
        or chapter_document.get("id") != chapter_id
        or chapter_document.get("workId") != work_id
    ):
        raise IntakeError(f"proposal[{index}]: library work/chapter identity changed")
    pages = _list(chapter_document.get("pages"), f"proposal[{index}].chapter.pages")
    page_matches = [
        _mapping(value, f"proposal[{index}].chapter.page")
        for value in pages
        if isinstance(value, Mapping) and value.get("id") == page_id
    ]
    if len(page_matches) != 1:
        raise IntakeError(f"proposal[{index}]: page is absent/duplicated in chapter.json")
    page_document = page_matches[0]
    recorded_path = page_document.get("imagePath")
    if not isinstance(recorded_path, str) or Path(recorded_path).resolve() != page_path:
        raise IntakeError(f"proposal[{index}]: chapter page path differs")
    if (
        page_document.get("width") != page_image.width
        or page_document.get("height") != page_image.height
    ):
        raise IntakeError(f"proposal[{index}]: chapter page dimensions differ")

    authority_core = {
        "work_id": work_id,
        "work_title": _text(work_document.get("title"), "fresh work.title"),
        "chapter_id": chapter_id,
        "chapter_title": _text(chapter_document.get("title"), "fresh chapter.title"),
        "page_id": page_id,
        "page_name": _text(page_document.get("name"), "fresh page.name"),
        "source_page_relative_path": relative.as_posix(),
        "source_page_sha256": source_page_sha,
        "source_page_size_px": [page_image.width, page_image.height],
        "source_page_byte_size": page_path.stat().st_size,
        "work_json": _file_binding(work_path),
        "chapter_json": _file_binding(chapter_path),
    }
    authority = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_fresh_page_source_authority",
            **authority_core,
            "canonical_split": "train",
            "synthetic": False,
            "qa_overlay": False,
        }
    )
    virtual_parent_id = "fresh-page-authority-" + stable_hash(
        work_id, chapter_id, page_id, source_page_sha
    )[:24]
    virtual_row = {
        "schema_version": 1,
        "id": virtual_parent_id,
        "split": "train",
        "legacy_split": "train",
        "work": {"id": work_id, "title": authority_core["work_title"]},
        "chapter": {"id": chapter_id, "title": authority_core["chapter_title"]},
        "page": {
            "id": page_id,
            "name": authority_core["page_name"],
            "source_page_sha256": source_page_sha,
            "source_locator": {
                "path": relative.as_posix(),
                "file_sha256": source_page_sha,
                "size_px": [page_image.width, page_image.height],
                "storage_root": "library_root",
                "provenance": "real_preserved",
            },
        },
        "geometry": {"crop_bbox_px": [0, 0, 1, 1]},
        "groups": {
            "root": f"fresh-page-authority:{virtual_parent_id}",
            "variant": f"fresh-page-authority:{virtual_parent_id}",
            "normalized_glyph": f"fresh-page-authority:{virtual_parent_id}",
        },
        "views": {},
        "sample_crop_sha256": stable_hash("virtual-fresh-page", virtual_parent_id),
        "metadata": {"orientation": proposal.get("orientation")},
        "provenance": {
            "source_catalog_id": "fontclip-fresh-page-authority-v1",
            "source_id": virtual_parent_id,
            "source_line_number": 1,
            "source_line_sha256": authority["record_sha256"],
            "synthetic": False,
            "qa_overlay": False,
        },
    }
    virtual_hash = sha256_bytes(canonical_json_bytes(virtual_row))
    derived_inputs = dict(inputs)
    derived_inputs["master"] = {**inputs["master"], virtual_parent_id: virtual_row}
    derived_inputs["parent_master"] = {
        **inputs["parent_master"],
        virtual_parent_id: copy.deepcopy(virtual_row),
    }
    derived_inputs["master_hashes"] = {
        **inputs["master_hashes"],
        virtual_parent_id: virtual_hash,
    }
    derived_inputs["parent_master_hashes"] = {
        **inputs["parent_master_hashes"],
        virtual_parent_id: virtual_hash,
    }
    transformed = {
        "kind": "manual_recrop",
        "parent_sample_id": virtual_parent_id,
        "expected_stratum": proposal.get("expected_stratum"),
        "crop_bbox_px": proposal.get("crop_bbox_px"),
        "context_bbox_px": proposal.get("context_bbox_px"),
        "mask": proposal.get("mask"),
        "orientation": proposal.get("orientation"),
    }
    result = _prepare_recrop(
        derived_inputs,
        transformed,
        index=index,
        prepared_root=prepared_root,
        catalog_id=catalog_id,
        materialize=materialize,
        expected_strata=expected_strata,
    )
    catalog_core = {
        key: copy.deepcopy(value)
        for key, value in _mapping(result["catalog_row"], "fresh catalog row").items()
        if key != "record_sha256"
    }
    catalog_core.pop("parent_master_link", None)
    catalog_core["provenance"] = "real_manual_fresh_page_crop"
    catalog_core["fresh_page_source_authority"] = {
        "record_sha256": authority["record_sha256"],
        "source_page_sha256": source_page_sha,
        "work_json_sha256": authority_core["work_json"]["sha256"],
        "chapter_json_sha256": authority_core["chapter_json"]["sha256"],
        "parent_exclusion_required": False,
    }
    catalog_core["adjudication"] = {
        **dict(_mapping(catalog_core.get("adjudication"), "fresh adjudication")),
        "manual_fresh_page_crop": True,
    }
    result["catalog_row"] = seal(catalog_core)
    result["kind"] = "manual_fresh_page_crop"
    result["parent_sample_id"] = None
    result["parent_exclusion"] = None
    result["fresh_page_source_authority"] = authority
    result["recrop"] = {
        **dict(_mapping(result.get("recrop"), "fresh recrop")),
        "fresh_page_source_authority_record_sha256": authority["record_sha256"],
    }
    return result


def _serializable_item(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: copy.deepcopy(value)
        for key, value in item.items()
        if not str(key).startswith("_")
    }


def _prepare_proposals(
    inputs: Mapping[str, Any],
    *,
    proposal_path: Path,
    prepared_root: Path,
    catalog_id: str,
    materialize: bool,
    expected_strata: Mapping[str, int],
) -> list[dict[str, Any]]:
    proposals = read_jsonl(proposal_path)
    expected_count = sum(expected_strata.values())
    if len(proposals) != expected_count:
        raise IntakeError(
            f"proposal inventory must contain exactly {expected_count} rows"
        )
    counts = Counter(
        _text(row.get("expected_stratum"), f"proposal[{index}].expected_stratum")
        for index, row in enumerate(proposals)
    )
    if counts != Counter(expected_strata):
        raise IntakeError(
            f"proposal strata must be exact {dict(expected_strata)}, observed {dict(counts)}"
        )
    items: list[dict[str, Any]] = []
    sample_ids: set[str] = set()
    parent_ids: set[str] = set()
    nonpage_owner: dict[str, str] = {}
    page_groups: dict[str, list[str]] = defaultdict(list)
    for index, proposal in enumerate(proposals):
        if proposal.get("kind") not in ALLOWED_KINDS:
            raise IntakeError(
                "proposal[{index}]: only existing_master/manual_recrop/"
                "manual_fresh_page_crop are allowed".format(index=index)
            )
        if proposal["kind"] == "existing_master":
            item = _prepare_existing(
                inputs,
                proposal,
                index=index,
                expected_strata=expected_strata,
            )
        elif proposal["kind"] == "manual_recrop":
            item = _prepare_recrop(
                inputs,
                proposal,
                index=index,
                prepared_root=prepared_root,
                catalog_id=catalog_id,
                materialize=materialize,
                expected_strata=expected_strata,
            )
        else:
            item = _prepare_fresh_page_crop(
                inputs,
                proposal,
                index=index,
                prepared_root=prepared_root,
                catalog_id=catalog_id,
                materialize=materialize,
                expected_strata=expected_strata,
            )
        sample_id = str(item["sample_id"])
        if sample_id in sample_ids:
            raise IntakeError(f"duplicate intake successor/sample ID: {sample_id}")
        sample_ids.add(sample_id)
        if item["parent_sample_id"] is not None:
            parent_id = str(item["parent_sample_id"])
            if parent_id in parent_ids:
                raise IntakeError(f"multiple recrops replace one parent: {parent_id}")
            parent_ids.add(parent_id)
        closure = _mapping(item["closure"], f"{sample_id}.closure")
        closure_keys = _flat_closure(closure)
        prior_overlap = sorted(closure_keys.intersection(inputs["prior_conflict_keys"]))
        if prior_overlap:
            raise IntakeError(
                f"{sample_id}: proposal intersects prior calibration closure"
            )
        nontrain_overlap = sorted(
            closure_keys.intersection(inputs["nontrain_conflict_keys"])
        )
        if nontrain_overlap:
            raise IntakeError(f"{sample_id}: proposal intersects val/test closure")
        for category in ("exact", "root", "variant", "glyph", "source", "lineage"):
            for key in _list(closure.get(category), f"{sample_id}.closure.{category}"):
                previous = nonpage_owner.get(str(key))
                if previous is not None:
                    raise IntakeError(
                        f"{sample_id}: {category} closure duplicates current item {previous}"
                    )
                nonpage_owner[str(key)] = sample_id
        page_key = "page.source_page_sha256\0" + str(item["source_page_sha256"])
        if page_key not in _list(closure.get("page"), f"{sample_id}.closure.page"):
            raise IntakeError(f"{sample_id}: source page closure is incomplete")
        page_groups[page_key].append(str(item["intake_item_id"]))
        items.append(item)
    by_item = {str(item["intake_item_id"]): item for item in items}
    for page_key, members in sorted(page_groups.items()):
        competition_id = "competition-" + stable_hash(page_key, *sorted(members))[:24]
        for member in members:
            by_item[member]["competition_group_id"] = competition_id
            by_item[member]["same_current_page_competitor_count"] = len(members) - 1
    return items


def _task_id(round_id: str, stage: str, item_id: str) -> str:
    return "source-check-" + stable_hash(round_id, stage, item_id)[:24]


def _task_rows(
    items: Sequence[Mapping[str, Any]],
    *,
    round_id: str,
    stage: str,
    workspace: Path,
    materialize: bool,
    expected_strata: Mapping[str, int],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    tasks: list[dict[str, Any]] = []
    task_by_item: dict[str, str] = {}
    ordered = sorted(
        items,
        key=lambda item: (
            stable_hash(round_id, stage, str(item["intake_item_id"])),
            str(item["intake_item_id"]),
        ),
    )
    for review_order, item in enumerate(ordered, 1):
        item_id = str(item["intake_item_id"])
        task_id = _task_id(round_id, stage, item_id)
        images = _mapping(item.get("_images"), f"{item_id}._images")
        raw = images.get("raw") or images.get("raw_224")
        context = images.get("context_224")
        glyph = images.get("glyph_224")
        if raw is None or context is None or glyph is None:
            raise IntakeError(f"{item_id}: review panels are incomplete")
        montage = _render_review_montage(raw, context, glyph)
        relative = PurePosixPath("review-images", stage, f"{task_id}.png")
        path = workspace.joinpath(*relative.parts)
        payload = _png_bytes(montage)
        _materialize_or_validate(path, payload, materialize=materialize)
        task = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_matching_calibration_intake_source_task",
                "task_id": task_id,
                "reviewer_stage": stage,
                "review_order": review_order,
                "source_only": {
                    "path": relative.as_posix(),
                    "sha256": sha256_bytes(payload),
                    "pixel_sha256": _image_pixel_sha(montage),
                    "size_px": [montage.width, montage.height],
                    "panel_order": ["raw", "context", "glyph"],
                },
                "check_ids": list(CHECK_IDS),
                "allowed_roles": sorted(expected_strata),
                "allowed_strata": sorted(expected_strata),
                "candidate_b_present": False,
                "font_identity_present": False,
                "sample_or_work_identity_present": False,
            }
        )
        tasks.append(task)
        task_by_item[item_id] = task_id
    return tasks, task_by_item


def _public_task_safe(task: Mapping[str, Any]) -> None:
    validate_seal(task, "source task")
    if (
        task.get("record_type") != "font_matching_calibration_intake_source_task"
        or task.get("candidate_b_present") is not False
        or task.get("font_identity_present") is not False
        or task.get("sample_or_work_identity_present") is not False
    ):
        raise IntakeError("public task safety contract changed")
    forbidden_keys = {
        "candidate_only",
        "font_name",
        "sample_id",
        "work_id",
        "parent_sample_id",
        "catalog_row",
    }

    def walk(value: Any) -> None:
        if isinstance(value, Mapping):
            leaked = forbidden_keys.intersection(str(key) for key in value)
            if leaked:
                raise IntakeError(f"public task leaks private fields {sorted(leaked)}")
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(task)


def _input_paths_contract(inputs: Mapping[str, Any]) -> dict[str, Any]:
    paths = inputs["paths"]
    return {
        "master_root": str(paths["master_root"]),
        "catalog_registry": str(paths["catalog_registry"]),
        "master_split_map": str(paths["master_split_map"]),
        "base_rescue_inputs": str(paths["base_rescue_inputs"]),
        "font_signal_audit": str(paths["font_signal_audit"]),
        "library_root": str(paths["library_root"]),
        "prior_calibration_subsets": [
            str(path) for path in paths["prior_calibration_subsets"]
        ],
        "successor_bridge_root": (
            str(paths["successor_bridge_root"])
            if paths.get("successor_bridge_root") is not None
            else None
        ),
    }


def _builder_binding() -> dict[str, Any]:
    return _file_binding(Path(__file__).resolve())


def initialize_workspace(
    *,
    workspace: Path,
    master_root: Path,
    catalog_registry: Path,
    master_split_map: Path,
    base_rescue_inputs: Path,
    font_signal_audit: Path,
    prior_calibration_subsets: Sequence[Path],
    library_root: Path,
    proposals: Path,
    round_id: str,
    selection_seed: str,
    successor_bridge_root: Path | None = None,
    successor_registry_output: Path | None = None,
    successor_master_output: Path | None = None,
    expected_strata: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    requested_target = workspace.expanduser().absolute()
    target_parent = _absolute_no_symlink(
        requested_target.parent, location="workspace parent"
    )
    target = target_parent / requested_target.name
    if target.exists() or target.is_symlink():
        raise IntakeError(f"workspace must not exist: {target}")
    _identifier(round_id, "round_id")
    _text(selection_seed, "selection_seed")
    expected_strata = _validated_expected_strata(expected_strata)
    expected_count = sum(expected_strata.values())
    proposal_path = _absolute_no_symlink(proposals, location="proposals")
    inputs = _load_authoritative_inputs(
        master_root=master_root,
        catalog_registry=catalog_registry,
        master_split_map=master_split_map,
        base_rescue_inputs=base_rescue_inputs,
        font_signal_audit=font_signal_audit,
        prior_calibration_subsets=prior_calibration_subsets,
        library_root=library_root,
        successor_bridge_root=successor_bridge_root,
    )
    for source_root in (
        *[
            path
            for key, path in inputs["paths"].items()
            if key != "prior_calibration_subsets" and path is not None
        ],
        *inputs["paths"]["prior_calibration_subsets"],
        proposal_path,
    ):
        try:
            target.relative_to(Path(source_root))
        except ValueError:
            continue
        raise IntakeError("workspace must be disjoint from every input")
    catalog_id = (
        "fontclip-calibration-intake-v5-"
        + stable_hash(round_id, selection_seed, sha256_file(proposal_path))[:12]
    )
    if CATALOG_ID_RE.fullmatch(catalog_id) is None:
        raise IntakeError("derived catalog ID is invalid")
    registry_output_value = (
        successor_registry_output.expanduser().absolute()
        if successor_registry_output is not None
        else target.parent / "font-matching-catalog-registry-v4.json"
    )
    master_output_value = (
        successor_master_output.expanduser().absolute()
        if successor_master_output is not None
        else target.parent / "font-matching-master-v4"
    )
    registry_output = _absolute_no_symlink(
        registry_output_value,
        location="successor registry output",
        must_exist=False,
    )
    master_output = _absolute_no_symlink(
        master_output_value,
        location="successor master output",
        must_exist=False,
    )
    if registry_output.exists() or master_output.exists():
        raise IntakeError("successor output targets must not already exist")
    protected_inputs = [
        *[
            Path(path)
            for key, path in inputs["paths"].items()
            if key != "prior_calibration_subsets" and path is not None
        ],
        *inputs["paths"]["prior_calibration_subsets"],
        proposal_path,
    ]
    for output in (registry_output, master_output):
        if _paths_overlap(output, target) or any(
            _paths_overlap(output, source_path) for source_path in protected_inputs
        ):
            raise IntakeError(
                "successor outputs must be disjoint from workspace/inputs"
            )
    if _paths_overlap(registry_output, master_output):
        raise IntakeError("successor registry/master outputs must be disjoint")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=target.parent))
    try:
        prepared_root = temporary / "prepared"
        items = _prepare_proposals(
            inputs,
            proposal_path=proposal_path,
            prepared_root=prepared_root,
            catalog_id=catalog_id,
            materialize=True,
            expected_strata=expected_strata,
        )
        for item in items:
            if item["kind"] in {"manual_recrop", "manual_fresh_page_crop"}:
                for descriptor in item["source_views"].values():
                    descriptor["prepared_root"] = str(target / "prepared")
        tasks_by_stage: dict[str, list[dict[str, Any]]] = {}
        task_ids_by_stage: dict[str, dict[str, str]] = {}
        for stage in REVIEWER_STAGES:
            tasks, task_ids = _task_rows(
                items,
                round_id=round_id,
                stage=stage,
                workspace=temporary,
                materialize=True,
                expected_strata=expected_strata,
            )
            for task in tasks:
                _public_task_safe(task)
            tasks_by_stage[stage] = tasks
            task_ids_by_stage[stage] = task_ids
            _write_once(temporary / "tasks" / f"{stage}.jsonl", jsonl_bytes(tasks))
        private_rows = []
        for item in sorted(items, key=lambda row: str(row["intake_item_id"])):
            row = _serializable_item(item)
            row["task_ids"] = {
                stage: task_ids_by_stage[stage][str(item["intake_item_id"])]
                for stage in REVIEWER_STAGES
            }
            private_rows.append(
                seal(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "record_type": "font_matching_calibration_intake_private_binding",
                        **row,
                    }
                )
            )
        _write_once(temporary / PRIVATE_FILE, jsonl_bytes(private_rows))
        contract = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_matching_calibration_intake_workspace_contract",
                "round_id": round_id,
                "selection_seed": selection_seed,
                "catalog_id": catalog_id,
                "expected_strata": dict(expected_strata),
                "source_only_before_candidate_b": True,
                "candidate_b_generation_allowed": False,
                "synthetic_generative_qa_allowed": False,
                "same_current_page_policy": "sealed_competition_constraint_not_init_rejection",
                "inputs": _input_paths_contract(inputs),
                "input_bindings": copy.deepcopy(inputs["bindings"]),
                "proposal_file": _file_binding(proposal_path),
                "authoritative_split_identity": {
                    "frozen_source_sha256": inputs["frozen_source_sha256"],
                    "work_assignments_sha256": inputs["work_assignments_sha256"],
                },
                "prior_calibration_history_record_sha256": inputs["prior_history"][
                    "record_sha256"
                ],
                "authority_successor_bridge_record_sha256": (
                    inputs["authority_successor_bridge"]["record_sha256"]
                    if inputs["authority_successor_bridge"] is not None
                    else None
                ),
                "successor_outputs": {
                    "catalog_root": "sealed/catalog",
                    "registry_output": str(registry_output),
                    "master_output": str(master_output),
                },
                "task_files": {
                    stage: _rebased_file_binding(
                        temporary / "tasks" / f"{stage}.jsonl",
                        target / "tasks" / f"{stage}.jsonl",
                    )
                    for stage in REVIEWER_STAGES
                },
                "private_bindings": _rebased_file_binding(
                    temporary / PRIVATE_FILE, target / PRIVATE_FILE
                ),
                "builder": _builder_binding(),
            }
        )
        _write_once(
            temporary / CONTRACT_FILE, canonical_json_bytes(contract, pretty=True)
        )
        init_files = {
            path.relative_to(temporary).as_posix(): sha256_file(path)
            for path in sorted(temporary.rglob("*"))
            if path.is_file() and path.name != MARKER_FILE
        }
        marker = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_matching_calibration_intake_ownership_marker",
                "owner": OWNER,
                "safe_append_only": True,
                "contract_record_sha256": contract["record_sha256"],
                "builder_source_sha256": _builder_binding()["sha256"],
                "init_managed_files": init_files,
            }
        )
        _write_once(temporary / MARKER_FILE, canonical_json_bytes(marker, pretty=True))
        if target.exists():
            raise IntakeError("workspace appeared during initialization")
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {
        "workspace": str(target),
        "status": "initialized_source_only",
        "source_task_count_per_reviewer": expected_count,
        "expected_strata": dict(expected_strata),
        "catalog_id": catalog_id,
        "contract_record_sha256": contract["record_sha256"],
    }


def _expected_private_rows(
    items: Sequence[Mapping[str, Any]], *, round_id: str
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda row: str(row["intake_item_id"])):
        serializable = _serializable_item(item)
        serializable["task_ids"] = {
            stage: _task_id(round_id, stage, str(item["intake_item_id"]))
            for stage in REVIEWER_STAGES
        }
        rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "font_matching_calibration_intake_private_binding",
                    **serializable,
                }
            )
        )
    return rows


def _validate_workspace_inventory(root: Path, marker: Mapping[str, Any]) -> None:
    for path in root.rglob("*"):
        if path.is_symlink():
            raise IntakeError(f"workspace contains a symlink: {path}")
    expected_init = set(
        _mapping(marker.get("init_managed_files"), "marker.init_managed_files")
    )
    allowed = {MARKER_FILE, *expected_init}
    for stage in REVIEWER_STAGES:
        review_relative = f"reviews/{stage}.json"
        if (root / "reviews" / f"{stage}.json").is_file():
            allowed.add(review_relative)
    if (root / "sealed").exists():
        report = read_json(root / "sealed" / "report.json")
        validate_seal(report, "sealed report")
        managed = _mapping(report.get("managed_files"), "sealed report.managed_files")
        allowed.update(f"sealed/{relative}" for relative in managed)
        allowed.add("sealed/report.json")
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name != ".intake-v5.lock"
    }
    if actual != allowed:
        raise IntakeError(
            f"workspace file inventory changed; missing={sorted(allowed - actual)}, "
            f"extra={sorted(actual - allowed)}"
        )


def _load_reviews(
    root: Path,
    tasks: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    contract: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    expected_strata = _validated_expected_strata(contract.get("expected_strata"))
    reviews: dict[str, dict[str, Any]] = {}
    reviewer_ids: set[str] = set()
    for stage in REVIEWER_STAGES:
        path = root / "reviews" / f"{stage}.json"
        if not path.exists():
            continue
        review = read_json(path)
        validate_seal(review, f"review {stage}")
        _exact_keys(
            review,
            {
                "schema_version",
                "record_type",
                "round_id",
                "contract_record_sha256",
                "reviewer_stage",
                "reviewer_id",
                "source_only",
                "candidate_b_present",
                "font_identity_present",
                "decision_count",
                "decision_input_sha256",
                "decisions",
                "record_sha256",
            },
            f"review {stage}",
        )
        if (
            review.get("schema_version") != SCHEMA_VERSION
            or review.get("record_type")
            != "font_matching_calibration_intake_source_review"
            or review.get("reviewer_stage") != stage
            or review.get("round_id") != contract.get("round_id")
            or review.get("contract_record_sha256") != contract.get("record_sha256")
            or review.get("source_only") is not True
            or review.get("candidate_b_present") is not False
            or review.get("font_identity_present") is not False
        ):
            raise IntakeError(f"{stage}: review contract changed")
        reviewer_id = _identifier(review.get("reviewer_id"), f"{stage}.reviewer_id")
        _sha(review.get("decision_input_sha256"), f"{stage}.decision_input_sha256")
        if reviewer_id in reviewer_ids:
            raise IntakeError("primary and secondary reviewers must be different")
        reviewer_ids.add(reviewer_id)
        expected_task_ids = {str(task["task_id"]) for task in tasks[stage]}
        decisions = _list(review.get("decisions"), f"{stage}.decisions")
        observed: set[str] = set()
        for index, decision_value in enumerate(decisions):
            decision = _mapping(decision_value, f"{stage}.decisions[{index}]")
            _exact_keys(
                decision,
                {"task_id", "checks", "role", "stratum", "notes"},
                f"{stage}.decisions[{index}]",
            )
            task_id = _identifier(decision.get("task_id"), f"{stage}.task_id")
            if task_id in observed or task_id not in expected_task_ids:
                raise IntakeError(f"{stage}: decision task inventory changed")
            observed.add(task_id)
            checks = _mapping(decision.get("checks"), f"{stage}.{task_id}.checks")
            if set(checks) != set(CHECK_IDS) or any(
                not isinstance(checks.get(check), bool) for check in CHECK_IDS
            ):
                raise IntakeError(f"{stage}/{task_id}: checks are incomplete")
            if decision.get("role") not in expected_strata:
                raise IntakeError(f"{stage}/{task_id}: invalid role")
            if decision.get("stratum") not in expected_strata:
                raise IntakeError(f"{stage}/{task_id}: invalid stratum")
            notes = decision.get("notes")
            if notes is not None and not isinstance(notes, str):
                raise IntakeError(f"{stage}/{task_id}: notes must be text or null")
        if observed != expected_task_ids or review.get("decision_count") != len(
            decisions
        ):
            raise IntakeError(f"{stage}: review is not complete")
        reviews[stage] = review
    return reviews


def _load_workspace(workspace: Path) -> dict[str, Any]:
    root = _absolute_no_symlink(workspace, location="workspace")
    if not root.is_dir():
        raise IntakeError("workspace is not a directory")
    contract = read_json(root / CONTRACT_FILE)
    marker = read_json(root / MARKER_FILE)
    validate_seal(contract, "workspace contract")
    validate_seal(marker, "ownership marker")
    _exact_keys(
        contract,
        {
            "schema_version",
            "record_type",
            "round_id",
            "selection_seed",
            "catalog_id",
            "expected_strata",
            "source_only_before_candidate_b",
            "candidate_b_generation_allowed",
            "synthetic_generative_qa_allowed",
            "same_current_page_policy",
            "inputs",
            "input_bindings",
            "proposal_file",
            "authoritative_split_identity",
            "prior_calibration_history_record_sha256",
            "authority_successor_bridge_record_sha256",
            "successor_outputs",
            "task_files",
            "private_bindings",
            "builder",
            "record_sha256",
        },
        "workspace contract",
    )
    _exact_keys(
        marker,
        {
            "schema_version",
            "record_type",
            "owner",
            "safe_append_only",
            "contract_record_sha256",
            "builder_source_sha256",
            "init_managed_files",
            "record_sha256",
        },
        "ownership marker",
    )
    expected_strata = _validated_expected_strata(contract.get("expected_strata"))
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type")
        != "font_matching_calibration_intake_workspace_contract"
        or contract.get("expected_strata") != expected_strata
        or contract.get("source_only_before_candidate_b") is not True
        or contract.get("candidate_b_generation_allowed") is not False
        or contract.get("synthetic_generative_qa_allowed") is not False
        or contract.get("same_current_page_policy")
        != "sealed_competition_constraint_not_init_rejection"
    ):
        raise IntakeError("workspace contract changed")
    if (
        marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("record_type")
        != "font_matching_calibration_intake_ownership_marker"
        or marker.get("owner") != OWNER
        or marker.get("safe_append_only") is not True
        or marker.get("contract_record_sha256") != contract["record_sha256"]
        or marker.get("builder_source_sha256") != _builder_binding()["sha256"]
    ):
        raise IntakeError("ownership marker or builder source binding changed")
    _validate_workspace_inventory(root, marker)
    for relative, expected_sha in _mapping(
        marker.get("init_managed_files"), "marker.init_managed_files"
    ).items():
        path = _resolve_inside(
            root, _safe_relative(relative, "marker file"), "marker file"
        )
        if sha256_file(path) != _sha(expected_sha, f"marker[{relative}]"):
            raise IntakeError(f"immutable initialization file changed: {relative}")
    _validate_file_binding(
        _mapping(contract.get("builder"), "contract.builder"), "contract.builder"
    )
    input_paths = _mapping(contract.get("inputs"), "contract.inputs")
    prior_paths = [
        Path(_text(value, "prior path"))
        for value in _list(
            input_paths.get("prior_calibration_subsets"),
            "contract.inputs.prior_calibration_subsets",
        )
    ]
    inputs = _load_authoritative_inputs(
        master_root=Path(_text(input_paths.get("master_root"), "master_root")),
        catalog_registry=Path(
            _text(input_paths.get("catalog_registry"), "catalog_registry")
        ),
        master_split_map=Path(
            _text(input_paths.get("master_split_map"), "master_split_map")
        ),
        base_rescue_inputs=Path(
            _text(input_paths.get("base_rescue_inputs"), "base_rescue_inputs")
        ),
        font_signal_audit=Path(
            _text(input_paths.get("font_signal_audit"), "font_signal_audit")
        ),
        prior_calibration_subsets=prior_paths,
        library_root=Path(_text(input_paths.get("library_root"), "library_root")),
        successor_bridge_root=(
            Path(
                _text(
                    input_paths.get("successor_bridge_root"),
                    "successor_bridge_root",
                )
            )
            if input_paths.get("successor_bridge_root") is not None
            else None
        ),
    )
    if dict(input_paths) != _input_paths_contract(inputs):
        raise IntakeError("authoritative input path contract changed")
    if contract.get("input_bindings") != inputs["bindings"]:
        raise IntakeError("authoritative input bindings changed")
    split_identity_contract = _mapping(
        contract.get("authoritative_split_identity"),
        "contract.authoritative_split_identity",
    )
    if dict(split_identity_contract) != {
        "frozen_source_sha256": inputs["frozen_source_sha256"],
        "work_assignments_sha256": inputs["work_assignments_sha256"],
    }:
        raise IntakeError("authoritative split identity changed")
    if (
        contract.get("prior_calibration_history_record_sha256")
        != inputs["prior_history"]["record_sha256"]
    ):
        raise IntakeError("prior calibration history authority changed")
    expected_bridge_record = (
        inputs["authority_successor_bridge"]["record_sha256"]
        if inputs["authority_successor_bridge"] is not None
        else None
    )
    if (
        contract.get("authority_successor_bridge_record_sha256")
        != expected_bridge_record
    ):
        raise IntakeError("authority successor bridge changed")
    _identifier(contract.get("round_id"), "round_id")
    _text(contract.get("selection_seed"), "selection_seed")
    catalog_id = _text(contract.get("catalog_id"), "contract.catalog_id")
    if CATALOG_ID_RE.fullmatch(catalog_id) is None:
        raise IntakeError("workspace catalog ID is invalid")
    successor_outputs = _mapping(
        contract.get("successor_outputs"), "contract.successor_outputs"
    )
    _exact_keys(
        successor_outputs,
        {"catalog_root", "registry_output", "master_output"},
        "contract.successor_outputs",
    )
    if successor_outputs.get("catalog_root") != "sealed/catalog":
        raise IntakeError("successor catalog root contract changed")
    _absolute_no_symlink(
        Path(_text(successor_outputs.get("registry_output"), "registry_output")),
        location="successor registry output",
        must_exist=False,
    )
    _absolute_no_symlink(
        Path(_text(successor_outputs.get("master_output"), "master_output")),
        location="successor master output",
        must_exist=False,
    )
    proposal_path = _validate_file_binding(
        _mapping(contract.get("proposal_file"), "contract.proposal_file"),
        "contract.proposal_file",
    )
    items = _prepare_proposals(
        inputs,
        proposal_path=proposal_path,
        prepared_root=root / "prepared",
        catalog_id=catalog_id,
        materialize=False,
        expected_strata=expected_strata,
    )
    tasks: dict[str, list[dict[str, Any]]] = {}
    for stage in REVIEWER_STAGES:
        expected, _ = _task_rows(
            items,
            round_id=_identifier(contract.get("round_id"), "round_id"),
            stage=stage,
            workspace=root,
            materialize=False,
            expected_strata=expected_strata,
        )
        actual = read_jsonl(root / "tasks" / f"{stage}.jsonl")
        if actual != expected:
            raise IntakeError(f"{stage}: deterministic public tasks changed")
        for task in actual:
            _public_task_safe(task)
        tasks[stage] = actual
    expected_private = _expected_private_rows(items, round_id=str(contract["round_id"]))
    actual_private = read_jsonl(root / PRIVATE_FILE)
    if actual_private != expected_private:
        raise IntakeError("private source bindings changed")
    expected_task_bindings = {
        stage: _file_binding(root / "tasks" / f"{stage}.jsonl")
        for stage in REVIEWER_STAGES
    }
    if contract.get("task_files") != expected_task_bindings:
        raise IntakeError("public task file bindings changed")
    if contract.get("private_bindings") != _file_binding(root / PRIVATE_FILE):
        raise IntakeError("private binding file contract changed")
    reviews = _load_reviews(root, tasks, contract=contract)
    state = {
        "root": root,
        "contract": contract,
        "marker": marker,
        "inputs": inputs,
        "items": items,
        "tasks": tasks,
        "private": actual_private,
        "reviews": reviews,
    }
    if (root / "sealed").exists():
        _validate_sealed(state)
    return state


def _normalized_decisions(
    path: Path,
    *,
    stage: str,
    tasks: Sequence[Mapping[str, Any]],
    expected_strata: Mapping[str, int],
) -> list[dict[str, Any]]:
    raw = read_jsonl(path)
    expected = {str(task["task_id"]) for task in tasks}
    by_task: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(raw):
        row = _mapping(value, f"decisions[{index}]")
        _exact_keys(
            row,
            {"task_id", "checks", "role", "stratum", "notes"},
            f"decisions[{index}]",
        )
        task_id = _identifier(row.get("task_id"), f"decisions[{index}].task_id")
        if task_id in by_task or task_id not in expected:
            raise IntakeError(f"{stage}: decisions contain an unknown/duplicate task")
        checks = _mapping(row.get("checks"), f"decisions[{index}].checks")
        if set(checks) != set(CHECK_IDS) or any(
            not isinstance(checks.get(check), bool) for check in CHECK_IDS
        ):
            raise IntakeError(f"{stage}/{task_id}: all four checks must be booleans")
        role = row.get("role")
        stratum = row.get("stratum")
        if role not in expected_strata or stratum not in expected_strata:
            raise IntakeError(f"{stage}/{task_id}: role/stratum is invalid")
        notes = row.get("notes")
        if notes is not None and not isinstance(notes, str):
            raise IntakeError(f"{stage}/{task_id}: notes must be text or null")
        by_task[task_id] = {
            "task_id": task_id,
            "checks": {check: bool(checks[check]) for check in CHECK_IDS},
            "role": role,
            "stratum": stratum,
            "notes": notes,
        }
    if set(by_task) != expected:
        raise IntakeError(f"{stage}: decisions do not exactly cover its tasks")
    return [by_task[str(task["task_id"])] for task in tasks]


def submit_review(
    *,
    workspace: Path,
    reviewer_stage: str,
    reviewer_id: str,
    decisions: Path,
) -> dict[str, Any]:
    if reviewer_stage not in REVIEWER_STAGES:
        raise IntakeError("reviewer_stage is invalid")
    reviewer_id = _identifier(reviewer_id, "reviewer_id")
    state = _load_workspace(workspace)
    decisions_path = _absolute_no_symlink(decisions, location="decisions")
    with _workspace_lock(state["root"]):
        state = _load_workspace(state["root"])
        if (state["root"] / "sealed").exists():
            raise IntakeError("a source-sealed workspace cannot accept reviews")
        if reviewer_stage in state["reviews"]:
            raise IntakeError(f"{reviewer_stage}: append-only review already exists")
        if any(
            review.get("reviewer_id") == reviewer_id
            for review in state["reviews"].values()
        ):
            raise IntakeError("primary and secondary reviewers must be different")
        normalized = _normalized_decisions(
            decisions_path,
            stage=reviewer_stage,
            tasks=state["tasks"][reviewer_stage],
            expected_strata=_validated_expected_strata(
                state["contract"].get("expected_strata")
            ),
        )
        review = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_matching_calibration_intake_source_review",
                "round_id": state["contract"]["round_id"],
                "contract_record_sha256": state["contract"]["record_sha256"],
                "reviewer_stage": reviewer_stage,
                "reviewer_id": reviewer_id,
                "source_only": True,
                "candidate_b_present": False,
                "font_identity_present": False,
                "decision_count": len(normalized),
                "decision_input_sha256": sha256_file(decisions_path),
                "decisions": normalized,
            }
        )
        target = state["root"] / "reviews" / f"{reviewer_stage}.json"
        _write_once(target, canonical_json_bytes(review, pretty=True))
    verified = _load_workspace(state["root"])
    if reviewer_stage not in verified["reviews"]:
        raise IntakeError("review did not survive validation")
    return {
        "workspace": str(state["root"]),
        "status": "source_review_sealed",
        "reviewer_stage": reviewer_stage,
        "review_record_sha256": review["record_sha256"],
    }


def _review_decisions_by_task(
    state: Mapping[str, Any]
) -> dict[str, dict[str, Mapping[str, Any]]]:
    result: dict[str, dict[str, Mapping[str, Any]]] = {}
    for stage in REVIEWER_STAGES:
        review = state["reviews"].get(stage)
        if review is None:
            raise IntakeError("both independent source reviews are required")
        result[stage] = {
            str(row["task_id"]): row
            for row in _list(review.get("decisions"), f"{stage}.decisions")
        }
    return result


def _sealed_intake_rows(state: Mapping[str, Any]) -> list[dict[str, Any]]:
    expected_strata = _validated_expected_strata(
        state["contract"].get("expected_strata")
    )
    expected_count = sum(expected_strata.values())
    decisions = _review_decisions_by_task(state)
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    for item in sorted(state["items"], key=lambda row: str(row["intake_item_id"])):
        item_id = str(item["intake_item_id"])
        stage_rows = {
            stage: decisions[stage][
                _task_id(str(state["contract"]["round_id"]), stage, item_id)
            ]
            for stage in REVIEWER_STAGES
        }
        first = stage_rows["reviewer-a"]
        second = stage_rows["reviewer-b"]
        checks_pass = all(
            all(bool(row["checks"][check]) for check in CHECK_IDS)
            for row in stage_rows.values()
        )
        agreement = (
            first["role"] == second["role"]
            and first["stratum"] == second["stratum"]
            and first["role"] == item["expected_stratum"]
            and first["stratum"] == item["expected_stratum"]
        )
        if not checks_pass or not agreement:
            failures.append(item_id)
            continue
        serializable = _serializable_item(item)
        serializable.pop("catalog_row", None)
        serializable.pop("parent_exclusion", None)
        rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": "font_matching_calibration_intake_source_seal",
                    **serializable,
                    "role": first["role"],
                    "stratum": first["stratum"],
                    "source_status": "dual_independent_pass",
                    "review_record_sha256s": {
                        stage: state["reviews"][stage]["record_sha256"]
                        for stage in REVIEWER_STAGES
                    },
                    "all_four_checks_passed_twice": True,
                    "reviewers_independent": True,
                    "candidate_b_present": False,
                    "font_identity_present": False,
                    "synthetic": False,
                    "qa_overlay": False,
                    "authoritative_split_identity": copy.deepcopy(
                        state["contract"]["authoritative_split_identity"]
                    ),
                }
            )
        )
    if failures:
        raise IntakeError(f"source seal blocked by failed/disagreed items: {failures}")
    if Counter(str(row["stratum"]) for row in rows) != Counter(expected_strata):
        raise IntakeError("source-sealed intake does not have exact target strata")
    if len(rows) != expected_count:
        raise IntakeError(
            f"source-sealed intake must contain exactly {expected_count} rows"
        )
    return rows


def _final_catalog_rows(
    state: Mapping[str, Any], intake_rows: Sequence[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    intake_by_item = {str(row["intake_item_id"]): row for row in intake_rows}
    catalog_rows: list[dict[str, Any]] = []
    exclusions: list[dict[str, Any]] = []
    for item in sorted(state["items"], key=lambda row: str(row["intake_item_id"])):
        if item["kind"] not in {"manual_recrop", "manual_fresh_page_crop"}:
            continue
        source_seal = intake_by_item[str(item["intake_item_id"])]
        catalog_core = {
            key: copy.deepcopy(value)
            for key, value in _mapping(item["catalog_row"], "catalog row").items()
            if key != "record_sha256"
        }
        catalog_core["review"] = {
            "status": "accepted",
            "decision": "pass",
            "source": "sealed_dual_independent_source_review_v5",
            "source_seal_record_sha256": source_seal["record_sha256"],
            "review_record_sha256s": copy.deepcopy(
                source_seal["review_record_sha256s"]
            ),
        }
        catalog_core["adjudication"] = {
            **dict(catalog_core["adjudication"]),
            "source_seal_record_sha256": source_seal["record_sha256"],
        }
        catalog_rows.append(seal(catalog_core))
        if item.get("parent_exclusion") is not None:
            exclusion_core = {
                key: copy.deepcopy(value)
                for key, value in _mapping(
                    item["parent_exclusion"], "parent exclusion"
                ).items()
                if key != "record_sha256"
            }
            exclusion_core["source_seal_record_sha256"] = source_seal[
                "record_sha256"
            ]
            exclusions.append(seal(exclusion_core))
    return catalog_rows, exclusions


def _successor_argv(
    state: Mapping[str, Any], *, catalog_root: Path, exclusion_path: Path
) -> dict[str, Any]:
    registry = state["inputs"]["registry_document"]
    registry_args = [
        sys.executable,
        str(PROJECT_ROOT / "scripts" / "build_font_matching_catalog_registry.py"),
        "build",
    ]
    for entry_value in _list(registry.get("catalogs"), "registry.catalogs"):
        entry = _mapping(entry_value, "registry.catalog")
        registry_args.extend(
            [
                "--catalog",
                _text(entry.get("catalog_id"), "registry.catalog_id"),
                _text(entry.get("source_kind"), "registry.source_kind"),
                _text(entry.get("root"), "registry.root"),
            ]
        )
    registry_args.extend(
        [
            "--catalog",
            str(state["contract"]["catalog_id"]),
            "hard",
            str(catalog_root),
        ]
    )
    for ledger_value in _list(
        registry.get("exclusion_ledgers"), "registry.exclusion_ledgers"
    ):
        ledger = _mapping(ledger_value, "registry.exclusion_ledger")
        registry_args.extend(
            ["--exclusion-ledger", _text(ledger.get("path"), "ledger.path")]
        )
    if any(item.get("kind") == "manual_recrop" for item in state["items"]):
        registry_args.extend(["--exclusion-ledger", str(exclusion_path)])
    parent = _mapping(registry.get("parent_master"), "registry.parent_master")
    frozen_split = _mapping(
        registry.get("frozen_split_map"), "registry.frozen_split_map"
    )
    registry_args.extend(
        [
            "--parent-master-manifest",
            _text(parent.get("manifest"), "registry.parent_master.manifest"),
            "--frozen-split-map",
            _text(frozen_split.get("path"), "registry.frozen_split_map.path"),
            "--output",
            str(state["contract"]["successor_outputs"]["registry_output"]),
        ]
    )
    master_args = [
        sys.executable,
        str(PROJECT_ROOT / "scripts" / "build_font_matching_master.py"),
        "build",
        "--catalog-registry",
        str(state["contract"]["successor_outputs"]["registry_output"]),
        "--library-root",
        str(state["inputs"]["paths"]["library_root"]),
        "--verify-assets",
        "--output-dir",
        str(state["contract"]["successor_outputs"]["master_output"]),
    ]
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_calibration_intake_successor_argv",
            "execution_order": ["catalog_registry", "master_successor"],
            "catalog_registry_argv": registry_args,
            "master_successor_argv": master_args,
            "candidate_b_or_card_generation_included": False,
            "successor_split_validation": {
                "compare_frozen_source_sha256": True,
                "compare_work_assignments_canonical_digest": True,
                "compare_whole_split_map_sha256": False,
                "component_sample_counts_may_change": True,
                "every_intake_work_must_remain_train": True,
            },
        }
    )


def _copy_catalog_assets(state: Mapping[str, Any], *, catalog_root: Path) -> None:
    prepared = state["root"] / "prepared"
    for item in state["items"]:
        if item["kind"] not in {"manual_recrop", "manual_fresh_page_crop"}:
            continue
        for descriptor_value in _mapping(
            item["source_views"], "item.source_views"
        ).values():
            descriptor = _mapping(descriptor_value, "source view")
            relative = _safe_relative(descriptor.get("path"), "source view.path")
            source = _resolve_inside(prepared, relative, "prepared source view")
            target = catalog_root.joinpath(*relative.parts)
            _write_once(target, source.read_bytes())


def _publish_sealed(state: Mapping[str, Any]) -> dict[str, Any]:
    intake_rows = _sealed_intake_rows(state)
    catalog_rows, exclusions = _final_catalog_rows(state, intake_rows)
    final = state["root"] / "sealed"
    if final.exists():
        raise IntakeError("source-sealed output already exists")
    temporary = Path(tempfile.mkdtemp(prefix=".sealed.", dir=state["root"]))
    try:
        catalog_root = temporary / "catalog"
        _copy_catalog_assets(state, catalog_root=catalog_root)
        _write_once(temporary / "intake.jsonl", jsonl_bytes(intake_rows))
        _write_once(catalog_root / "manifest.jsonl", jsonl_bytes(catalog_rows))
        _write_once(catalog_root / "parent-exclusions.jsonl", jsonl_bytes(exclusions))
        _write_once(
            temporary / PRIOR_HISTORY_FILE,
            canonical_json_bytes(state["inputs"]["prior_history"], pretty=True),
        )
        final_catalog_root = final / "catalog"
        argv = _successor_argv(
            state,
            catalog_root=final_catalog_root,
            exclusion_path=final_catalog_root / "parent-exclusions.jsonl",
        )
        _write_once(
            temporary / "successor-build-argv.json",
            canonical_json_bytes(argv, pretty=True),
        )
        try:
            master_builder.read_catalog(
                master_builder.SourceCatalog(
                    str(state["contract"]["catalog_id"]), "hard", catalog_root
                ),
                verify_assets=True,
            )
        except master_builder.MasterManifestError as error:
            raise IntakeError(
                f"successor catalog is not master-buildable: {error}"
            ) from error
        managed_files = {
            path.relative_to(temporary).as_posix(): sha256_file(path)
            for path in sorted(temporary.rglob("*"))
            if path.is_file() and path.name != "report.json"
        }
        report = seal(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "font_matching_calibration_intake_source_seal_report",
                "owner": OWNER,
                "contract_record_sha256": state["contract"]["record_sha256"],
                "marker_record_sha256": state["marker"]["record_sha256"],
                "builder_source_sha256": _builder_binding()["sha256"],
                "source_sealed_count": len(intake_rows),
                "stratum_counts": dict(
                    sorted(Counter(str(row["stratum"]) for row in intake_rows).items())
                ),
                "existing_master_count": sum(
                    row["kind"] == "existing_master" for row in intake_rows
                ),
                "manual_recrop_count": len(catalog_rows),
                "test_or_val_count": 0,
                "prior_leakage_count": 0,
                "candidate_b_count": 0,
                "font_identity_count": 0,
                "synthetic_generative_qa_count": 0,
                "same_page_competition_group_count": len(
                    {
                        str(row["competition_group_id"])
                        for row in intake_rows
                        if int(row["same_current_page_competitor_count"]) > 0
                    }
                ),
                "authoritative_split_identity": copy.deepcopy(
                    state["contract"]["authoritative_split_identity"]
                ),
                "intake_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(
                        sorted(str(row["sample_id"]) for row in intake_rows)
                    )
                ),
                "intake_file_sha256": managed_files["intake.jsonl"],
                "catalog_manifest_sha256": managed_files["catalog/manifest.jsonl"],
                "parent_exclusions_sha256": managed_files[
                    "catalog/parent-exclusions.jsonl"
                ],
                "prior_calibration_history_file_sha256": managed_files[
                    PRIOR_HISTORY_FILE
                ],
                "prior_calibration_history_record_sha256": state["inputs"][
                    "prior_history"
                ]["record_sha256"],
                "prior_calibration_history_head_record_sha256": state["inputs"][
                    "prior_history"
                ]["head_record_sha256"],
                "authority_successor_bridge_record_sha256": state["contract"][
                    "authority_successor_bridge_record_sha256"
                ],
                "authority_excluded_parent_ids_sha256": (
                    state["inputs"]["authority_successor_bridge"][
                        "excluded_parent_ids_sha256"
                    ]
                    if state["inputs"]["authority_successor_bridge"] is not None
                    else None
                ),
                "authority_successor_ids_auto_inherited": False,
                "successor_argv_record_sha256": argv["record_sha256"],
                "managed_files": managed_files,
            }
        )
        _write_once(
            temporary / "report.json", canonical_json_bytes(report, pretty=True)
        )
        os.replace(temporary, final)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return report


def seal_source(*, workspace: Path) -> dict[str, Any]:
    state = _load_workspace(workspace)
    with _workspace_lock(state["root"]):
        state = _load_workspace(state["root"])
        if set(state["reviews"]) != set(REVIEWER_STAGES):
            raise IntakeError("both independent source reviews are required")
        report = _publish_sealed(state)
    verified = _load_workspace(state["root"])
    if not (verified["root"] / "sealed").exists():
        raise IntakeError("source seal did not survive validation")
    return {
        "workspace": str(state["root"]),
        "status": "source_sealed",
        "source_sealed_count": report["source_sealed_count"],
        "stratum_counts": report["stratum_counts"],
        "manual_recrop_count": report["manual_recrop_count"],
        "report_record_sha256": report["record_sha256"],
        "preflight_argument": ["--sealed-intake-root", str(state["root"])],
    }


def _validate_sealed(state: Mapping[str, Any]) -> dict[str, Any]:
    """Recompute the complete source seal from immutable source-side evidence."""

    root = Path(state["root"])
    sealed_root = root / "sealed"
    report_path = sealed_root / "report.json"
    report = read_json(report_path)
    validate_seal(report, "sealed report")
    _exact_keys(
        report,
        {
            "schema_version",
            "record_type",
            "owner",
            "contract_record_sha256",
            "marker_record_sha256",
            "builder_source_sha256",
            "source_sealed_count",
            "stratum_counts",
            "existing_master_count",
            "manual_recrop_count",
            "test_or_val_count",
            "prior_leakage_count",
            "candidate_b_count",
            "font_identity_count",
            "synthetic_generative_qa_count",
            "same_page_competition_group_count",
            "authoritative_split_identity",
            "intake_sample_ids_sha256",
            "intake_file_sha256",
            "catalog_manifest_sha256",
            "parent_exclusions_sha256",
            "prior_calibration_history_file_sha256",
            "prior_calibration_history_record_sha256",
            "prior_calibration_history_head_record_sha256",
            "authority_successor_bridge_record_sha256",
            "authority_excluded_parent_ids_sha256",
            "authority_successor_ids_auto_inherited",
            "successor_argv_record_sha256",
            "managed_files",
            "record_sha256",
        },
        "sealed report",
    )

    expected_intake = _sealed_intake_rows(state)
    intake_path = sealed_root / "intake.jsonl"
    actual_intake = read_jsonl(intake_path)
    if actual_intake != expected_intake:
        raise IntakeError("sealed intake differs from recomputed dual-review evidence")
    for index, row in enumerate(actual_intake):
        validate_seal(row, f"sealed intake[{index}]")
        if (
            row.get("source_status") != "dual_independent_pass"
            or row.get("all_four_checks_passed_twice") is not True
            or row.get("reviewers_independent") is not True
            or row.get("candidate_b_present") is not False
            or row.get("font_identity_present") is not False
            or row.get("synthetic") is not False
            or row.get("qa_overlay") is not False
        ):
            raise IntakeError(f"sealed intake[{index}]: unsafe source-seal semantics")
        work_id = _identifier(row.get("work_id"), f"sealed intake[{index}].work_id")
        if state["inputs"]["assignments"].get(work_id) != "train":
            raise IntakeError(
                f"sealed intake work is no longer canonical train: {work_id}"
            )
        _flat_closure(_mapping(row.get("closure"), f"sealed intake[{index}].closure"))

    expected_catalog, expected_exclusions = _final_catalog_rows(state, expected_intake)
    catalog_root = sealed_root / "catalog"
    manifest_path = catalog_root / "manifest.jsonl"
    exclusion_path = catalog_root / "parent-exclusions.jsonl"
    actual_catalog = read_jsonl(manifest_path)
    actual_exclusions = read_jsonl(exclusion_path)
    if actual_catalog != expected_catalog:
        raise IntakeError("sealed recrop catalog differs from source evidence")
    if actual_exclusions != expected_exclusions:
        raise IntakeError("sealed parent-exclusion ledger differs from source evidence")
    for index, row in enumerate(actual_catalog):
        validate_seal(row, f"sealed catalog[{index}]")
    for index, row in enumerate(actual_exclusions):
        validate_seal(row, f"sealed parent exclusion[{index}]")
    history_path = sealed_root / PRIOR_HISTORY_FILE
    history = read_json(history_path)
    validate_seal(history, "prior calibration history registry")
    if history != state["inputs"]["prior_history"]:
        raise IntakeError("sealed prior calibration history registry changed")

    argv_path = sealed_root / "successor-build-argv.json"
    actual_argv = read_json(argv_path)
    validate_seal(actual_argv, "successor argv")
    expected_argv = _successor_argv(
        state,
        catalog_root=catalog_root,
        exclusion_path=exclusion_path,
    )
    if actual_argv != expected_argv:
        raise IntakeError("successor build argv differs from its sealed contract")

    managed_files: dict[str, str] = {}
    for path in sorted(sealed_root.rglob("*")):
        if not path.is_file() or path == report_path:
            continue
        relative = path.relative_to(sealed_root).as_posix()
        _safe_relative(relative, "sealed managed file")
        managed_files[relative] = sha256_file(path)
    if report.get("managed_files") != managed_files:
        raise IntakeError("sealed managed-file inventory or hashes changed")

    expected_report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_calibration_intake_source_seal_report",
            "owner": OWNER,
            "contract_record_sha256": state["contract"]["record_sha256"],
            "marker_record_sha256": state["marker"]["record_sha256"],
            "builder_source_sha256": _builder_binding()["sha256"],
            "source_sealed_count": len(expected_intake),
            "stratum_counts": dict(
                sorted(Counter(str(row["stratum"]) for row in expected_intake).items())
            ),
            "existing_master_count": sum(
                row["kind"] == "existing_master" for row in expected_intake
            ),
            "manual_recrop_count": len(expected_catalog),
            "test_or_val_count": 0,
            "prior_leakage_count": 0,
            "candidate_b_count": 0,
            "font_identity_count": 0,
            "synthetic_generative_qa_count": 0,
            "same_page_competition_group_count": len(
                {
                    str(row["competition_group_id"])
                    for row in expected_intake
                    if int(row["same_current_page_competitor_count"]) > 0
                }
            ),
            "authoritative_split_identity": copy.deepcopy(
                state["contract"]["authoritative_split_identity"]
            ),
            "intake_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(
                    sorted(str(row["sample_id"]) for row in expected_intake)
                )
            ),
            "intake_file_sha256": managed_files["intake.jsonl"],
            "catalog_manifest_sha256": managed_files["catalog/manifest.jsonl"],
            "parent_exclusions_sha256": managed_files[
                "catalog/parent-exclusions.jsonl"
            ],
            "prior_calibration_history_file_sha256": managed_files[PRIOR_HISTORY_FILE],
            "prior_calibration_history_record_sha256": state["inputs"]["prior_history"][
                "record_sha256"
            ],
            "prior_calibration_history_head_record_sha256": state["inputs"][
                "prior_history"
            ]["head_record_sha256"],
            "authority_successor_bridge_record_sha256": state["contract"][
                "authority_successor_bridge_record_sha256"
            ],
            "authority_excluded_parent_ids_sha256": (
                state["inputs"]["authority_successor_bridge"][
                    "excluded_parent_ids_sha256"
                ]
                if state["inputs"]["authority_successor_bridge"] is not None
                else None
            ),
            "authority_successor_ids_auto_inherited": False,
            "successor_argv_record_sha256": expected_argv["record_sha256"],
            "managed_files": managed_files,
        }
    )
    if report != expected_report:
        raise IntakeError("sealed source report differs from recomputed evidence")

    try:
        result = master_builder.read_catalog(
            master_builder.SourceCatalog(
                str(state["contract"]["catalog_id"]), "hard", catalog_root
            ),
            verify_assets=True,
        )
    except master_builder.MasterManifestError as error:
        raise IntakeError(
            f"sealed successor catalog is not master-buildable: {error}"
        ) from error
    if result.row_count != len(expected_catalog):
        raise IntakeError("sealed successor catalog row count changed")
    return report


def validate_sealed_intake(workspace: Path) -> dict[str, Any]:
    """Return preflight-safe rows only after full workspace revalidation.

    Callers must pass the owned workspace root, never a supplemental JSON/JSONL
    path.  The returned binding is suitable for inclusion in a downstream
    deterministic fingerprint.
    """

    state = _load_workspace(workspace)
    sealed_root = state["root"] / "sealed"
    if not sealed_root.is_dir():
        raise IntakeError("intake workspace has not been source-sealed")
    report = _validate_sealed(state)
    rows = read_jsonl(sealed_root / "intake.jsonl")
    binding = {
        "workspace": str(state["root"]),
        "ownership_marker_record_sha256": state["marker"]["record_sha256"],
        "workspace_contract_record_sha256": state["contract"]["record_sha256"],
        "source_seal_report": _file_binding(sealed_root / "report.json"),
        "source_seal_report_record_sha256": report["record_sha256"],
        "intake_file": _file_binding(sealed_root / "intake.jsonl"),
        "intake_sample_ids_sha256": report["intake_sample_ids_sha256"],
        "authoritative_split_identity": copy.deepcopy(
            report["authoritative_split_identity"]
        ),
        "authoritative_input_bindings_sha256": sha256_bytes(
            canonical_json_bytes(state["inputs"]["bindings"])
        ),
        "master_manifest_sha256": state["inputs"]["bindings"]["master_manifest"][
            "sha256"
        ],
        "rescue_report_record_sha256": state["inputs"]["bindings"][
            "rescue_report_record_sha256"
        ],
        "font_signal_audit_report_record_sha256": state["inputs"]["bindings"][
            "font_signal_audit_report_record_sha256"
        ],
        "prior_subset_bindings_sha256": sha256_bytes(
            canonical_json_bytes(state["inputs"]["bindings"]["prior_subset_bindings"])
        ),
        "catalog_manifest_sha256": report["catalog_manifest_sha256"],
        "parent_exclusions_sha256": report["parent_exclusions_sha256"],
        "prior_calibration_history": _file_binding(sealed_root / PRIOR_HISTORY_FILE),
        "prior_calibration_history_record_sha256": report[
            "prior_calibration_history_record_sha256"
        ],
        "prior_calibration_history_head_record_sha256": report[
            "prior_calibration_history_head_record_sha256"
        ],
        "authority_successor_bridge_record_sha256": report[
            "authority_successor_bridge_record_sha256"
        ],
        "authority_excluded_parent_ids_sha256": report[
            "authority_excluded_parent_ids_sha256"
        ],
        "authority_successor_ids_auto_inherited": report[
            "authority_successor_ids_auto_inherited"
        ],
    }
    return {
        "workspace": str(state["root"]),
        "rows": copy.deepcopy(rows),
        "report": copy.deepcopy(report),
        "binding": binding,
    }


def validate_workspace(*, workspace: Path) -> dict[str, Any]:
    state = _load_workspace(workspace)
    sealed = (state["root"] / "sealed").is_dir()
    expected_strata = _validated_expected_strata(
        state["contract"].get("expected_strata")
    )
    expected_count = sum(expected_strata.values())
    return {
        "workspace": str(state["root"]),
        "status": "valid_source_sealed" if sealed else "valid_source_only",
        "source_task_count_per_reviewer": expected_count,
        "sealed_review_stages": sorted(state["reviews"]),
        "source_sealed": sealed,
        "source_sealed_count": expected_count if sealed else 0,
        "candidate_b_count": 0,
        "font_identity_count": 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser(
        "init", help="create immutable source-only tasks for the exact 5+3 intake"
    )
    init.add_argument("--workspace", type=Path, required=True)
    init.add_argument("--master-root", type=Path, required=True)
    init.add_argument("--catalog-registry", type=Path, required=True)
    init.add_argument("--master-split-map", type=Path, required=True)
    init.add_argument("--base-rescue-inputs", type=Path, required=True)
    init.add_argument("--font-signal-audit", type=Path, required=True)
    init.add_argument(
        "--prior-calibration-subset", type=Path, action="append", required=True
    )
    init.add_argument("--library-root", type=Path, required=True)
    init.add_argument("--proposals", type=Path, required=True)
    init.add_argument("--round-id", required=True)
    init.add_argument("--selection-seed", required=True)
    init.add_argument(
        "--expected-stratum",
        action="append",
        default=[],
        metavar="NAME=COUNT",
        help=(
            "override the legacy exact 5 ambient + 3 comic intake with a sealed "
            "generalized fresh-recrop quota; repeat once per target stratum"
        ),
    )
    init.add_argument(
        "--successor-bridge-root",
        type=Path,
        help="sealed promotion root required when rescue v2 is consumed through master v3",
    )
    init.add_argument("--successor-registry-output", type=Path)
    init.add_argument("--successor-master-output", type=Path)

    submit = subparsers.add_parser(
        "submit", help="append one independent reviewer's source-only decisions"
    )
    submit.add_argument("--workspace", type=Path, required=True)
    submit.add_argument("--reviewer-stage", choices=REVIEWER_STAGES, required=True)
    submit.add_argument("--reviewer-id", required=True)
    submit.add_argument("--decisions", type=Path, required=True)

    source_seal = subparsers.add_parser(
        "seal-source", help="seal the intake after two agreeing independent reviews"
    )
    source_seal.add_argument("--workspace", type=Path, required=True)

    validate = subparsers.add_parser(
        "validate", help="recompute every source, review, asset, and seal binding"
    )
    validate.add_argument("--workspace", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "init":
            expected_strata: dict[str, int] | None = None
            if args.expected_stratum:
                expected_strata = {}
                for index, value in enumerate(args.expected_stratum):
                    if "=" not in value:
                        raise IntakeError(
                            f"expected-stratum[{index}] must be NAME=COUNT"
                        )
                    name, count_text = value.split("=", 1)
                    try:
                        count = int(count_text)
                    except ValueError as error:
                        raise IntakeError(
                            f"expected-stratum[{index}] count is invalid"
                        ) from error
                    if name in expected_strata:
                        raise IntakeError(f"duplicate expected stratum: {name}")
                    expected_strata[name] = count
            result = initialize_workspace(
                workspace=args.workspace,
                master_root=args.master_root,
                catalog_registry=args.catalog_registry,
                master_split_map=args.master_split_map,
                base_rescue_inputs=args.base_rescue_inputs,
                font_signal_audit=args.font_signal_audit,
                prior_calibration_subsets=args.prior_calibration_subset,
                library_root=args.library_root,
                proposals=args.proposals,
                round_id=args.round_id,
                selection_seed=args.selection_seed,
                expected_strata=expected_strata,
                successor_bridge_root=args.successor_bridge_root,
                successor_registry_output=args.successor_registry_output,
                successor_master_output=args.successor_master_output,
            )
        elif args.command == "submit":
            result = submit_review(
                workspace=args.workspace,
                reviewer_stage=args.reviewer_stage,
                reviewer_id=args.reviewer_id,
                decisions=args.decisions,
            )
        elif args.command == "seal-source":
            result = seal_source(workspace=args.workspace)
        else:
            result = validate_workspace(workspace=args.workspace)
    except IntakeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
