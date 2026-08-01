#!/usr/bin/env python3
"""Build or validate a sealed dynamic font-matching catalog registry.

The registry is the immutable input contract consumed by
``build_font_matching_master.py --catalog-registry``.  This helper derives all
catalog and exclusion counts from the current files; callers never supply a
count or digest that could silently drift from the physical inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    import build_font_matching_master as master
except ImportError:  # pragma: no cover - module import from repository root
    from scripts import build_font_matching_master as master  # type: ignore[no-redef]


MANIFEST_NAME = "manifest.jsonl"
EXCLUSION_RECORD_TYPE = "font_matching_master_parent_exclusion"


class CatalogRegistryError(ValueError):
    """Raised when registry inputs or an existing registry violate the contract."""


@dataclass(frozen=True)
class CatalogSpec:
    catalog_id: str
    source_kind: str
    root: Path

    @property
    def manifest_path(self) -> Path:
        return self.root / MANIFEST_NAME


@dataclass(frozen=True)
class SourceRowBinding:
    source_id: str
    physical_line_number: int
    source_line_sha256: str


@dataclass(frozen=True)
class CatalogSnapshot:
    spec: CatalogSpec
    manifest_sha256: str
    physical_rows: int
    rows_by_id: Mapping[str, SourceRowBinding]


@dataclass(frozen=True)
class ExclusionBinding:
    catalog_id: str
    source_id: str
    source_line_number: int
    source_line_sha256: str
    parent_master_id: str
    parent_master_record_sha256: str
    ledger_path: Path
    ledger_sha256: str
    record_sha256: str


@dataclass(frozen=True)
class ExclusionLedgerSnapshot:
    path: Path
    sha256: str
    row_count: int


@dataclass(frozen=True)
class RegistrySnapshot:
    document: Mapping[str, Any]
    payload: bytes
    catalogs: tuple[CatalogSnapshot, ...]
    ledgers: tuple[ExclusionLedgerSnapshot, ...]
    exclusions: Mapping[tuple[str, str], ExclusionBinding]
    parent_master_manifest: Path | None
    parent_master_sha256: str | None
    frozen_split_map_path: Path
    frozen_split_map_sha256: str
    frozen_split_map: Mapping[str, Any]

    @property
    def registry_sha256(self) -> str:
        return _sha256_bytes(self.payload)

    @property
    def expected_total(self) -> int:
        return sum(
            int(catalog_entry["expected_included_rows"])
            for catalog_entry in self.document["catalogs"]
        )


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise CatalogRegistryError(f"could not read {path}: {error}") from error
    return digest.hexdigest()


def _required_text(value: Any, *, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise CatalogRegistryError(f"{location}: expected a non-empty string")
    return normalized


def _valid_sha256(value: Any, *, location: str) -> str:
    try:
        return master.valid_sha256(value, location=location)
    except master.MasterManifestError as error:
        raise CatalogRegistryError(str(error)) from error


def _resolve_path(value: Path | str, *, location: str) -> Path:
    try:
        return Path(value).expanduser().resolve()
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        raise CatalogRegistryError(f"{location}: invalid path {value!r}") from error


def _paths_overlap(left: Path, right: Path) -> bool:
    try:
        left.relative_to(right)
        return True
    except ValueError:
        pass
    try:
        right.relative_to(left)
        return True
    except ValueError:
        return False


def normalize_catalog_specs(
    raw_specs: Sequence[CatalogSpec | Sequence[str]],
) -> tuple[CatalogSpec, ...]:
    if not raw_specs:
        raise CatalogRegistryError("at least one --catalog is required")
    specs: list[CatalogSpec] = []
    seen_ids: set[str] = set()
    for index, raw_spec in enumerate(raw_specs, 1):
        if isinstance(raw_spec, CatalogSpec):
            raw_catalog_id: Any = raw_spec.catalog_id
            raw_source_kind: Any = raw_spec.source_kind
            raw_root: Any = raw_spec.root
        else:
            if len(raw_spec) != 3:
                raise CatalogRegistryError(
                    f"catalog[{index}]: expected CATALOG_ID SOURCE_KIND ROOT"
                )
            raw_catalog_id, raw_source_kind, raw_root = raw_spec
        catalog_id = _required_text(
            raw_catalog_id, location=f"catalog[{index}].catalog_id"
        )
        source_kind = _required_text(
            raw_source_kind, location=f"catalog[{index}].source_kind"
        )
        if source_kind not in {"base", "hard"}:
            raise CatalogRegistryError(
                f"catalog[{index}].source_kind must be base or hard"
            )
        if catalog_id in seen_ids:
            raise CatalogRegistryError(f"duplicate catalog ID {catalog_id!r}")
        seen_ids.add(catalog_id)
        root = _resolve_path(raw_root, location=f"catalog[{index}].root")
        if not root.is_dir():
            raise CatalogRegistryError(
                f"catalog {catalog_id!r} root is not a directory: {root}"
            )
        manifest = root / MANIFEST_NAME
        if manifest.parent != root or not manifest.is_file():
            raise CatalogRegistryError(
                f"catalog {catalog_id!r} requires direct child {manifest}"
            )
        specs.append(CatalogSpec(catalog_id, source_kind, root))

    ordered = tuple(sorted(specs, key=lambda item: item.catalog_id))
    for left_index, left in enumerate(ordered):
        for right in ordered[left_index + 1 :]:
            if _paths_overlap(left.root, right.root):
                raise CatalogRegistryError(
                    "catalog roots must be separate and non-nested: "
                    f"{left.catalog_id!r}, {right.catalog_id!r}"
                )
    return ordered


def _read_catalog(spec: CatalogSpec) -> CatalogSnapshot:
    digest = hashlib.sha256()
    physical_rows = 0
    rows_by_id: dict[str, SourceRowBinding] = {}
    try:
        with spec.manifest_path.open("rb") as handle:
            for physical_line, payload in enumerate(handle, 1):
                digest.update(payload)
                stripped = payload.rstrip(b"\r\n")
                if not stripped.strip():
                    continue
                physical_rows += 1
                try:
                    row = json.loads(stripped)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise CatalogRegistryError(
                        f"{spec.catalog_id}:{physical_line}: invalid JSON: {error}"
                    ) from error
                if not isinstance(row, Mapping):
                    raise CatalogRegistryError(
                        f"{spec.catalog_id}:{physical_line}: expected an object"
                    )
                source_id = _required_text(
                    row.get("id"),
                    location=f"{spec.catalog_id}:{physical_line}.id",
                )
                if source_id in rows_by_id:
                    raise CatalogRegistryError(
                        f"{spec.catalog_id}: duplicate source ID {source_id!r}"
                    )
                rows_by_id[source_id] = SourceRowBinding(
                    source_id=source_id,
                    physical_line_number=physical_line,
                    source_line_sha256=_sha256_bytes(stripped),
                )
    except OSError as error:
        raise CatalogRegistryError(
            f"could not read catalog manifest {spec.manifest_path}: {error}"
        ) from error
    if physical_rows != len(rows_by_id):
        raise CatalogRegistryError(
            f"{spec.catalog_id}: physical row accounting is inconsistent"
        )
    return CatalogSnapshot(
        spec=spec,
        manifest_sha256=digest.hexdigest(),
        physical_rows=physical_rows,
        rows_by_id=rows_by_id,
    )


def _validate_seal(row: Mapping[str, Any], *, location: str) -> str:
    expected = _valid_sha256(
        row.get("record_sha256"), location=f"{location}.record_sha256"
    )
    core = {key: value for key, value in row.items() if key != "record_sha256"}
    actual = _sha256_bytes(master.canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise CatalogRegistryError(f"{location}: record seal mismatch")
    return expected


def _read_exclusion_ledger(
    path: Path,
) -> tuple[ExclusionLedgerSnapshot, tuple[ExclusionBinding, ...]]:
    digest = hashlib.sha256()
    provisional: list[tuple[dict[str, Any], str, int]] = []
    try:
        with path.open("rb") as handle:
            for physical_line, payload in enumerate(handle, 1):
                digest.update(payload)
                stripped = payload.rstrip(b"\r\n")
                if not stripped.strip():
                    continue
                try:
                    row = json.loads(stripped)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise CatalogRegistryError(
                        f"{path}:{physical_line}: invalid JSON: {error}"
                    ) from error
                if not isinstance(row, dict):
                    raise CatalogRegistryError(
                        f"{path}:{physical_line}: expected an object"
                    )
                logical_row = len(provisional) + 1
                record_sha = _validate_seal(row, location=f"{path.name}:{logical_row}")
                provisional.append((row, record_sha, logical_row))
    except OSError as error:
        raise CatalogRegistryError(
            f"could not read exclusion ledger {path}: {error}"
        ) from error

    ledger_sha = digest.hexdigest()
    bindings: list[ExclusionBinding] = []
    for row, record_sha, logical_row in provisional:
        location = f"{path.name}:{logical_row}"
        if row.get("record_type") != EXCLUSION_RECORD_TYPE:
            raise CatalogRegistryError(f"{location}: unsupported exclusion record")
        if (
            row.get("excluded_from_training") is not True
            or row.get("excluded_from_font_review") is not True
            or row.get("synthetic") is not False
        ):
            raise CatalogRegistryError(f"{location}: unsafe exclusion semantics")
        source_line_number = row.get("source_line_number")
        if (
            not isinstance(source_line_number, int)
            or isinstance(source_line_number, bool)
            or source_line_number < 1
        ):
            raise CatalogRegistryError(
                f"{location}.source_line_number must be a positive integer"
            )
        bindings.append(
            ExclusionBinding(
                catalog_id=_required_text(
                    row.get("source_catalog_id"),
                    location=f"{location}.source_catalog_id",
                ),
                source_id=_required_text(
                    row.get("source_id"), location=f"{location}.source_id"
                ),
                source_line_number=source_line_number,
                source_line_sha256=_valid_sha256(
                    row.get("source_line_sha256"),
                    location=f"{location}.source_line_sha256",
                ),
                parent_master_id=_required_text(
                    row.get("parent_master_id"),
                    location=f"{location}.parent_master_id",
                ),
                parent_master_record_sha256=_valid_sha256(
                    row.get("parent_master_record_sha256"),
                    location=f"{location}.parent_master_record_sha256",
                ),
                ledger_path=path,
                ledger_sha256=ledger_sha,
                record_sha256=record_sha,
            )
        )
    return (
        ExclusionLedgerSnapshot(path, ledger_sha, len(bindings)),
        tuple(bindings),
    )


def _normalize_ledger_paths(paths: Sequence[Path | str]) -> tuple[Path, ...]:
    resolved: list[Path] = []
    seen: set[Path] = set()
    for index, value in enumerate(paths, 1):
        path = _resolve_path(value, location=f"exclusion_ledger[{index}]")
        if path in seen:
            raise CatalogRegistryError(f"duplicate exclusion ledger {path}")
        seen.add(path)
        if not path.is_file():
            raise CatalogRegistryError(f"missing exclusion ledger: {path}")
        resolved.append(path)
    return tuple(sorted(resolved, key=str))


def _seal_registry(core: Mapping[str, Any]) -> dict[str, Any]:
    output = dict(core)
    output["record_sha256"] = _sha256_bytes(master.canonical_json(core).encode("utf-8"))
    return output


def build_registry_snapshot(
    *,
    catalog_specs: Sequence[CatalogSpec | Sequence[str]],
    exclusion_ledgers: Sequence[Path | str],
    parent_master_manifest: Path | str | None,
    frozen_split_map: Path | str,
) -> RegistrySnapshot:
    specs = normalize_catalog_specs(catalog_specs)
    catalogs = tuple(_read_catalog(spec) for spec in specs)
    catalog_by_id = {catalog.spec.catalog_id: catalog for catalog in catalogs}

    ledger_snapshots: list[ExclusionLedgerSnapshot] = []
    exclusions: dict[tuple[str, str], ExclusionBinding] = {}
    for ledger_path in _normalize_ledger_paths(exclusion_ledgers):
        ledger, ledger_exclusions = _read_exclusion_ledger(ledger_path)
        ledger_snapshots.append(ledger)
        for exclusion in ledger_exclusions:
            if exclusion.catalog_id not in catalog_by_id:
                raise CatalogRegistryError(
                    f"{ledger_path.name}: exclusion names unknown catalog "
                    f"{exclusion.catalog_id!r}"
                )
            key = (exclusion.catalog_id, exclusion.source_id)
            if key in exclusions:
                raise CatalogRegistryError(f"duplicate source exclusion {key}")
            exclusions[key] = exclusion

    excluded_counts = Counter(key[0] for key in exclusions)
    for catalog in catalogs:
        excluded = excluded_counts[catalog.spec.catalog_id]
        if excluded > catalog.physical_rows:
            raise CatalogRegistryError(
                f"{catalog.spec.catalog_id}: exclusion count {excluded} makes "
                f"expected_included_rows negative for {catalog.physical_rows} rows"
            )

    for key, exclusion in sorted(exclusions.items()):
        catalog = catalog_by_id[exclusion.catalog_id]
        source = catalog.rows_by_id.get(exclusion.source_id)
        if source is None:
            raise CatalogRegistryError(
                f"{key}: exclusion does not name a physical source row"
            )
        if (
            source.physical_line_number != exclusion.source_line_number
            or source.source_line_sha256 != exclusion.source_line_sha256
        ):
            raise CatalogRegistryError(
                f"{key}: exclusion source-line binding differs from manifest"
            )

    parent_path: Path | None = None
    parent_sha: str | None = None
    if exclusions:
        if parent_master_manifest is None:
            raise CatalogRegistryError("exclusions require --parent-master-manifest")
        parent_path = _resolve_path(
            parent_master_manifest, location="parent_master_manifest"
        )
        if not parent_path.is_file():
            raise CatalogRegistryError(f"missing parent master manifest: {parent_path}")
        parent_sha = _sha256_file(parent_path)
    elif parent_master_manifest is not None:
        raise CatalogRegistryError(
            "--parent-master-manifest is forbidden without exclusions"
        )

    frozen_path = _resolve_path(frozen_split_map, location="frozen_split_map")
    if not frozen_path.is_file():
        raise CatalogRegistryError(f"missing frozen split map: {frozen_path}")
    frozen_sha = _sha256_file(frozen_path)
    try:
        frozen_value = master.read_json_object(frozen_path)
    except master.MasterManifestError as error:
        raise CatalogRegistryError(str(error)) from error
    if frozen_value.get("schema_version") != master.SPLIT_MAP_SCHEMA_VERSION:
        raise CatalogRegistryError("frozen split map schema is unsupported")

    catalog_records = []
    for catalog in catalogs:
        excluded = excluded_counts[catalog.spec.catalog_id]
        included = catalog.physical_rows - excluded
        if included < 0:
            raise CatalogRegistryError(
                f"{catalog.spec.catalog_id}: expected_included_rows is negative"
            )
        catalog_records.append(
            {
                "catalog_id": catalog.spec.catalog_id,
                "source_kind": catalog.spec.source_kind,
                "root": str(catalog.spec.root),
                "manifest_name": MANIFEST_NAME,
                "manifest_sha256": catalog.manifest_sha256,
                "expected_physical_rows": catalog.physical_rows,
                "expected_included_rows": included,
            }
        )

    core: dict[str, Any] = {
        "schema_version": master.CATALOG_REGISTRY_SCHEMA_VERSION,
        "record_type": master.CATALOG_REGISTRY_RECORD_TYPE,
        "catalogs": catalog_records,
        "exclusion_ledgers": [
            {
                "path": str(ledger.path),
                "sha256": ledger.sha256,
                "expected_rows": ledger.row_count,
            }
            for ledger in ledger_snapshots
        ],
        "frozen_split_map": {"path": str(frozen_path), "sha256": frozen_sha},
    }
    if parent_path is not None:
        assert parent_sha is not None
        core["parent_master"] = {
            "manifest": str(parent_path),
            "manifest_sha256": parent_sha,
        }
    document = _seal_registry(core)
    payload = master.json_bytes(document, pretty=True)
    return RegistrySnapshot(
        document=document,
        payload=payload,
        catalogs=catalogs,
        ledgers=tuple(ledger_snapshots),
        exclusions=exclusions,
        parent_master_manifest=parent_path,
        parent_master_sha256=parent_sha,
        frozen_split_map_path=frozen_path,
        frozen_split_map_sha256=frozen_sha,
        frozen_split_map=frozen_value,
    )


def _expected_attestation(
    snapshot: RegistrySnapshot, *, registry_path: Path
) -> dict[str, Any]:
    parent_binding: dict[str, Any] | None = None
    if snapshot.parent_master_manifest is not None:
        assert snapshot.parent_master_sha256 is not None
        parent_binding = {
            "manifest": str(snapshot.parent_master_manifest),
            "manifest_sha256": snapshot.parent_master_sha256,
            "verified_exclusion_count": len(snapshot.exclusions),
        }
    return {
        "catalog_registry": {
            "path": str(registry_path),
            "sha256": snapshot.registry_sha256,
            "record_sha256": snapshot.document["record_sha256"],
        },
        "catalogs": [
            {
                "catalog_id": catalog.spec.catalog_id,
                "source_kind": catalog.spec.source_kind,
                "root": str(catalog.spec.root),
                "manifest": str(catalog.spec.manifest_path),
                "manifest_sha256": catalog.manifest_sha256,
                "expected_physical_rows": catalog.physical_rows,
                "expected_included_rows": (
                    catalog.physical_rows
                    - sum(
                        key[0] == catalog.spec.catalog_id for key in snapshot.exclusions
                    )
                ),
            }
            for catalog in snapshot.catalogs
        ],
        "exclusion_ledgers": [
            {
                "path": str(ledger.path),
                "sha256": ledger.sha256,
                "record_count": ledger.row_count,
            }
            for ledger in snapshot.ledgers
        ],
        "parent_master": parent_binding,
        "frozen_split_map": {
            "path": str(snapshot.frozen_split_map_path),
            "sha256": snapshot.frozen_split_map_sha256,
        },
    }


def _assert_loaded_configuration(
    snapshot: RegistrySnapshot,
    configuration: master.SourceConfiguration,
    *,
    registry_path: Path,
) -> None:
    expected_catalogs = [
        (
            catalog.spec.catalog_id,
            catalog.spec.source_kind,
            catalog.spec.root,
            MANIFEST_NAME,
        )
        for catalog in snapshot.catalogs
    ]
    actual_catalogs = [
        (catalog.catalog_id, catalog.source_kind, catalog.root, catalog.manifest_name)
        for catalog in configuration.catalogs
    ]
    if actual_catalogs != expected_catalogs:
        raise CatalogRegistryError("loaded catalog bindings differ from source inputs")
    expected_physical = {
        catalog.spec.catalog_id: catalog.physical_rows for catalog in snapshot.catalogs
    }
    expected_included = {
        str(row["catalog_id"]): int(row["expected_included_rows"])
        for row in snapshot.document["catalogs"]
    }
    if configuration.expected_physical_counts != expected_physical:
        raise CatalogRegistryError("loaded physical row counts differ from inputs")
    if configuration.expected_counts != expected_included:
        raise CatalogRegistryError("loaded included row counts differ from inputs")
    if configuration.expected_total != snapshot.expected_total:
        raise CatalogRegistryError("loaded expected total differs from inputs")
    if set(configuration.exclusions) != set(snapshot.exclusions):
        raise CatalogRegistryError("loaded source exclusions differ from ledgers")
    for key, expected in snapshot.exclusions.items():
        actual = configuration.exclusions[key]
        actual_tuple = (
            actual.catalog_id,
            actual.source_id,
            actual.source_line_number,
            actual.source_line_sha256,
            actual.parent_master_id,
            actual.parent_master_record_sha256,
            actual.ledger_path,
            actual.ledger_sha256,
            actual.record_sha256,
        )
        expected_tuple = (
            expected.catalog_id,
            expected.source_id,
            expected.source_line_number,
            expected.source_line_sha256,
            expected.parent_master_id,
            expected.parent_master_record_sha256,
            str(expected.ledger_path),
            expected.ledger_sha256,
            expected.record_sha256,
        )
        if actual_tuple != expected_tuple:
            raise CatalogRegistryError(f"loaded exclusion binding drifted: {key}")
    if master.canonical_json(configuration.frozen_split_map) != master.canonical_json(
        snapshot.frozen_split_map
    ):
        raise CatalogRegistryError("loaded frozen split map differs from input")
    expected_attestation = _expected_attestation(snapshot, registry_path=registry_path)
    if configuration.input_attestation != expected_attestation:
        raise CatalogRegistryError("loaded input attestation differs from inputs")


def _load_and_assert(snapshot: RegistrySnapshot, *, registry_path: Path) -> None:
    try:
        configuration = master.load_catalog_registry(registry_path)
    except master.MasterManifestError as error:
        raise CatalogRegistryError(str(error)) from error
    _assert_loaded_configuration(
        snapshot, configuration, registry_path=registry_path.resolve()
    )


def _atomic_publish(snapshot: RegistrySnapshot, *, output: Path) -> str:
    if output.exists():
        if not output.is_file():
            raise CatalogRegistryError(f"output is not a file: {output}")
        if output.read_bytes() != snapshot.payload:
            raise CatalogRegistryError(
                f"refusing to overwrite nonidentical registry: {output}"
            )
        _load_and_assert(snapshot, registry_path=output)
        return "verified"

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(snapshot.payload)
            handle.flush()
            os.fsync(handle.fileno())
        _load_and_assert(snapshot, registry_path=temporary)
        if output.exists():
            if not output.is_file() or output.read_bytes() != snapshot.payload:
                raise CatalogRegistryError(
                    f"refusing to overwrite nonidentical registry: {output}"
                )
            temporary.unlink()
            _load_and_assert(snapshot, registry_path=output)
            return "verified"
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    _load_and_assert(snapshot, registry_path=output)
    return "built"


def validate_registry(snapshot: RegistrySnapshot, *, output: Path) -> None:
    if not output.is_file():
        raise CatalogRegistryError(f"missing catalog registry: {output}")
    actual = output.read_bytes()
    try:
        configuration = master.load_catalog_registry(output)
    except master.MasterManifestError as error:
        raise CatalogRegistryError(str(error)) from error
    if actual != snapshot.payload:
        raise CatalogRegistryError(
            "catalog registry bytes differ from deterministic input rebuild"
        )
    _assert_loaded_configuration(
        snapshot, configuration, registry_path=output.resolve()
    )


def _summary(
    snapshot: RegistrySnapshot, *, output: Path, status: str
) -> dict[str, Any]:
    return {
        "status": status,
        "output": str(output),
        "catalog_count": len(snapshot.catalogs),
        "physical_rows": sum(catalog.physical_rows for catalog in snapshot.catalogs),
        "excluded_rows": len(snapshot.exclusions),
        "expected_included_rows": snapshot.expected_total,
        "registry_sha256": snapshot.registry_sha256,
        "record_sha256": snapshot.document["record_sha256"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    def add_common(command: argparse.ArgumentParser) -> None:
        command.add_argument(
            "--catalog",
            dest="catalogs",
            action="append",
            nargs=3,
            metavar=("CATALOG_ID", "SOURCE_KIND", "ROOT"),
            required=True,
        )
        command.add_argument(
            "--exclusion-ledger",
            type=Path,
            action="append",
            default=[],
        )
        command.add_argument("--parent-master-manifest", type=Path)
        command.add_argument("--frozen-split-map", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)

    add_common(commands.add_parser("build"))
    add_common(commands.add_parser("validate"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        snapshot = build_registry_snapshot(
            catalog_specs=args.catalogs,
            exclusion_ledgers=args.exclusion_ledger,
            parent_master_manifest=args.parent_master_manifest,
            frozen_split_map=args.frozen_split_map,
        )
        output = _resolve_path(args.output, location="output")
        input_paths = {
            *(catalog.spec.manifest_path for catalog in snapshot.catalogs),
            *(ledger.path for ledger in snapshot.ledgers),
            snapshot.frozen_split_map_path,
        }
        if snapshot.parent_master_manifest is not None:
            input_paths.add(snapshot.parent_master_manifest)
        if output in input_paths:
            raise CatalogRegistryError("--output must not replace an input file")
        if args.command == "build":
            status = _atomic_publish(snapshot, output=output)
        else:
            validate_registry(snapshot, output=output)
            status = "valid"
        print(master.canonical_json(_summary(snapshot, output=output, status=status)))
        return 0
    except (CatalogRegistryError, master.MasterManifestError, OSError) as error:
        print(f"error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
