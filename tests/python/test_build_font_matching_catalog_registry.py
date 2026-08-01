from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Iterable, Mapping


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "build_font_matching_catalog_registry.py"
SPEC = importlib.util.spec_from_file_location("font_matching_catalog_registry", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
REGISTRY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = REGISTRY
SPEC.loader.exec_module(REGISTRY)
MASTER = REGISTRY.master


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def seal(core: Mapping[str, Any]) -> dict[str, Any]:
    row = dict(core)
    row["record_sha256"] = digest(canonical_json(core))
    return row


def write_jsonl(
    path: Path,
    rows: Iterable[Mapping[str, Any]],
    *,
    leading_blank: bool = False,
    between_blank: bool = False,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = [""] if leading_blank else []
    for index, row in enumerate(rows):
        if index and between_blank:
            lines.append("   ")
        lines.append(canonical_json(row))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def source_binding(manifest: Path, source_id: str) -> tuple[int, str]:
    with manifest.open("rb") as handle:
        for line_number, payload in enumerate(handle, 1):
            stripped = payload.rstrip(b"\r\n")
            if not stripped.strip():
                continue
            row = json.loads(stripped)
            if row["id"] == source_id:
                return line_number, digest(stripped)
    raise AssertionError(f"missing source row {source_id}")


class RegistryFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.catalogs: dict[str, tuple[str, Path]] = {}
        self.frozen = root / "frozen-split-map.json"
        self.frozen.write_text(
            json.dumps(
                {
                    "schema_version": MASTER.SPLIT_MAP_SCHEMA_VERSION,
                    "work_assignments": {},
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

    def add_catalog(
        self,
        catalog_id: str,
        source_kind: str,
        directory: str,
        source_ids: list[str],
        *,
        leading_blank: bool = False,
        between_blank: bool = False,
    ) -> Path:
        root = self.root / directory
        write_jsonl(
            root / "manifest.jsonl",
            ({"id": source_id} for source_id in source_ids),
            leading_blank=leading_blank,
            between_blank=between_blank,
        )
        self.catalogs[catalog_id] = (source_kind, root)
        return root

    def args(
        self,
        command: str,
        output: Path,
        *,
        catalog_order: list[str] | None = None,
        ledgers: list[Path] | None = None,
        parent: Path | None = None,
    ) -> list[str]:
        values = [command]
        order = catalog_order or list(self.catalogs)
        for catalog_id in order:
            source_kind, root = self.catalogs[catalog_id]
            values.extend(["--catalog", catalog_id, source_kind, str(root)])
        for ledger in ledgers or []:
            values.extend(["--exclusion-ledger", str(ledger)])
        if parent is not None:
            values.extend(["--parent-master-manifest", str(parent)])
        values.extend(
            [
                "--frozen-split-map",
                str(self.frozen),
                "--output",
                str(output),
            ]
        )
        return values

    def exclusions(
        self,
        entries: list[tuple[str, str]],
        *,
        name: str = "parent-exclusions.jsonl",
    ) -> tuple[Path, Path]:
        parent_rows = []
        exclusion_rows = []
        for catalog_id, source_id in entries:
            _, catalog_root = self.catalogs[catalog_id]
            line_number, line_sha = source_binding(
                catalog_root / "manifest.jsonl", source_id
            )
            parent_id = MASTER._master_id(catalog_id, source_id)
            parent = {
                "id": parent_id,
                "provenance": {
                    "source_catalog_id": catalog_id,
                    "source_id": source_id,
                    "source_line_number": line_number,
                    "source_line_sha256": line_sha,
                },
            }
            parent_rows.append(parent)
            exclusion_rows.append(
                seal(
                    {
                        "schema_version": "font-matching-recrop-promotion-v1",
                        "record_type": REGISTRY.EXCLUSION_RECORD_TYPE,
                        "parent_master_id": parent_id,
                        "parent_master_record_sha256": digest(canonical_json(parent)),
                        "source_catalog_id": catalog_id,
                        "source_id": source_id,
                        "source_line_number": line_number,
                        "source_line_sha256": line_sha,
                        "excluded_from_training": True,
                        "excluded_from_font_review": True,
                        "synthetic": False,
                    }
                )
            )
        parent = self.root / "parent-master.jsonl"
        ledger = self.root / name
        write_jsonl(parent, parent_rows)
        write_jsonl(ledger, exclusion_rows)
        return parent, ledger


def run_main(argv: list[str]) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = REGISTRY.main(argv)
    return code, output.getvalue()


class CatalogRegistryTests(unittest.TestCase):
    def test_build_validate_and_verify_three_catalog_delta(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = RegistryFixture(root)
            fixture.add_catalog(
                "fontclip-accepted-v1",
                "base",
                "base",
                ["base-a", "base-b"],
                leading_blank=True,
                between_blank=True,
            )
            fixture.add_catalog("fontclip-hard-accepted-v2", "hard", "hard", ["hard-a"])
            fixture.add_catalog(
                "fontclip-recrop-accepted-v1",
                "hard",
                "delta",
                ["delta-a", "delta-b"],
            )
            parent, ledger = fixture.exclusions([("fontclip-accepted-v1", "base-a")])
            output = root / "registry.json"
            build_args = fixture.args(
                "build",
                output,
                catalog_order=[
                    "fontclip-recrop-accepted-v1",
                    "fontclip-hard-accepted-v2",
                    "fontclip-accepted-v1",
                ],
                ledgers=[ledger],
                parent=parent,
            )
            code, printed = run_main(build_args)
            self.assertEqual(code, 0, printed)
            self.assertEqual(json.loads(printed)["status"], "built")

            registry = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                registry["schema_version"],
                MASTER.CATALOG_REGISTRY_SCHEMA_VERSION,
            )
            self.assertEqual(
                registry["record_type"], MASTER.CATALOG_REGISTRY_RECORD_TYPE
            )
            core = {
                key: value for key, value in registry.items() if key != "record_sha256"
            }
            self.assertEqual(registry["record_sha256"], digest(canonical_json(core)))
            by_id = {row["catalog_id"]: row for row in registry["catalogs"]}
            self.assertEqual(
                [row["catalog_id"] for row in registry["catalogs"]],
                sorted(by_id),
            )
            self.assertEqual(by_id["fontclip-accepted-v1"]["expected_physical_rows"], 2)
            self.assertEqual(by_id["fontclip-accepted-v1"]["expected_included_rows"], 1)
            self.assertEqual(
                by_id["fontclip-recrop-accepted-v1"]["expected_included_rows"],
                2,
            )
            configuration = MASTER.load_catalog_registry(output)
            self.assertEqual(configuration.expected_total, 4)
            self.assertEqual(len(configuration.catalogs), 3)
            self.assertEqual(len(configuration.exclusions), 1)

            original = output.read_bytes()
            validate_args = fixture.args(
                "validate",
                output,
                catalog_order=list(reversed(list(fixture.catalogs))),
                ledgers=[ledger],
                parent=parent,
            )
            code, printed = run_main(validate_args)
            self.assertEqual(code, 0, printed)
            self.assertEqual(json.loads(printed)["status"], "valid")
            code, printed = run_main(build_args)
            self.assertEqual(code, 0, printed)
            self.assertEqual(json.loads(printed)["status"], "verified")
            self.assertEqual(output.read_bytes(), original)

    def test_catalog_roots_reject_equal_nested_and_mixed_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = RegistryFixture(root)
            shared = fixture.add_catalog("base", "base", "shared", ["a"])
            with self.assertRaisesRegex(REGISTRY.CatalogRegistryError, "non-nested"):
                REGISTRY.normalize_catalog_specs(
                    [("base", "base", str(shared)), ("hard", "hard", str(shared))]
                )

            nested = shared / "nested"
            write_jsonl(nested / "manifest.jsonl", [{"id": "b"}])
            with self.assertRaisesRegex(REGISTRY.CatalogRegistryError, "non-nested"):
                REGISTRY.normalize_catalog_specs(
                    [("base", "base", str(shared)), ("hard", "hard", str(nested))]
                )
            with self.assertRaisesRegex(
                REGISTRY.CatalogRegistryError, "must be base or hard"
            ):
                REGISTRY.normalize_catalog_specs([("mixed", "base+hard", str(shared))])

    def test_parent_requirement_tracks_actual_exclusion_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = RegistryFixture(root)
            fixture.add_catalog("base", "base", "base", ["a"])
            parent, ledger = fixture.exclusions([("base", "a")])
            with self.assertRaisesRegex(REGISTRY.CatalogRegistryError, "require"):
                REGISTRY.build_registry_snapshot(
                    catalog_specs=[("base", "base", str(root / "base"))],
                    exclusion_ledgers=[ledger],
                    parent_master_manifest=None,
                    frozen_split_map=fixture.frozen,
                )

            empty = root / "empty-exclusions.jsonl"
            empty.write_bytes(b"")
            with self.assertRaisesRegex(REGISTRY.CatalogRegistryError, "forbidden"):
                REGISTRY.build_registry_snapshot(
                    catalog_specs=[("base", "base", str(root / "base"))],
                    exclusion_ledgers=[empty],
                    parent_master_manifest=parent,
                    frozen_split_map=fixture.frozen,
                )

    def test_duplicate_unknown_and_negative_exclusions_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = RegistryFixture(root)
            fixture.add_catalog("base", "base", "base", ["a"])
            _, first = fixture.exclusions([("base", "a")], name="first.jsonl")
            _, second = fixture.exclusions([("base", "a")], name="second.jsonl")
            with self.assertRaisesRegex(
                REGISTRY.CatalogRegistryError, "duplicate source exclusion"
            ):
                REGISTRY.build_registry_snapshot(
                    catalog_specs=[("base", "base", str(root / "base"))],
                    exclusion_ledgers=[first, second],
                    parent_master_manifest=None,
                    frozen_split_map=fixture.frozen,
                )

            row = json.loads(first.read_text(encoding="utf-8").strip())
            unknown_core = {
                key: value for key, value in row.items() if key != "record_sha256"
            }
            unknown_core["source_catalog_id"] = "unknown"
            write_jsonl(first, [seal(unknown_core)])
            with self.assertRaisesRegex(
                REGISTRY.CatalogRegistryError, "unknown catalog"
            ):
                REGISTRY.build_registry_snapshot(
                    catalog_specs=[("base", "base", str(root / "base"))],
                    exclusion_ledgers=[first],
                    parent_master_manifest=None,
                    frozen_split_map=fixture.frozen,
                )

            line_number, line_sha = source_binding(
                root / "base" / "manifest.jsonl", "a"
            )
            negative_rows = []
            for source_id in ("a", "b"):
                negative_rows.append(
                    seal(
                        {
                            "record_type": REGISTRY.EXCLUSION_RECORD_TYPE,
                            "parent_master_id": f"parent-{source_id}",
                            "parent_master_record_sha256": "a" * 64,
                            "source_catalog_id": "base",
                            "source_id": source_id,
                            "source_line_number": line_number,
                            "source_line_sha256": line_sha,
                            "excluded_from_training": True,
                            "excluded_from_font_review": True,
                            "synthetic": False,
                        }
                    )
                )
            write_jsonl(first, negative_rows)
            with self.assertRaisesRegex(REGISTRY.CatalogRegistryError, "negative"):
                REGISTRY.build_registry_snapshot(
                    catalog_specs=[("base", "base", str(root / "base"))],
                    exclusion_ledgers=[first],
                    parent_master_manifest=None,
                    frozen_split_map=fixture.frozen,
                )

    def test_validate_rejects_registry_and_input_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = RegistryFixture(root)
            catalog = fixture.add_catalog("base", "base", "base", ["a", "b"])
            output = root / "registry.json"
            args = fixture.args("build", output)
            code, printed = run_main(args)
            self.assertEqual(code, 0, printed)
            snapshot = REGISTRY.build_registry_snapshot(
                catalog_specs=[("base", "base", str(catalog))],
                exclusion_ledgers=[],
                parent_master_manifest=None,
                frozen_split_map=fixture.frozen,
            )

            output.write_bytes(snapshot.payload + b"\n")
            with self.assertRaisesRegex(
                REGISTRY.CatalogRegistryError, "deterministic input rebuild"
            ):
                REGISTRY.validate_registry(snapshot, output=output)

            output.write_bytes(snapshot.payload)
            manifest = catalog / "manifest.jsonl"
            manifest.write_bytes(manifest.read_bytes() + b"\n")
            code, printed = run_main(fixture.args("validate", output))
            self.assertEqual(code, 2)
            self.assertIn("changed", printed)

    def test_build_refuses_nonidentical_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = RegistryFixture(root)
            fixture.add_catalog("base", "base", "base", ["a"])
            output = root / "registry.json"
            output.write_bytes(b"do-not-overwrite\n")
            code, printed = run_main(fixture.args("build", output))
            self.assertEqual(code, 2)
            self.assertIn("refusing to overwrite", printed)
            self.assertEqual(output.read_bytes(), b"do-not-overwrite\n")


if __name__ == "__main__":
    unittest.main()
