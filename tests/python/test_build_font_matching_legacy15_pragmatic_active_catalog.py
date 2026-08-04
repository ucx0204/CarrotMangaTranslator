from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "build_font_matching_legacy15_pragmatic_active_catalog.py"
SPEC = importlib.util.spec_from_file_location("legacy15_pragmatic_tested", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LEGACY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = LEGACY
SPEC.loader.exec_module(LEGACY)


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(LEGACY.runtime.json_bytes(value, pretty=True))


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.asset_root = root / "repository"
        self.font_manifest = root / "font-manifest.json"
        self.render_manifest = root / "render-bank" / "manifest.json"
        self.output = root / "output"
        families = []
        candidates = []
        renders = []
        for index, candidate_id in enumerate(LEGACY.PINNED_CANDIDATE_IDS):
            payload = f"font-{candidate_id}".encode("utf-8")
            relative_font = f"assets/{candidate_id}.ttf"
            font_path = self.asset_root / relative_font
            font_path.parent.mkdir(parents=True, exist_ok=True)
            font_path.write_bytes(payload)
            face_id = f"{candidate_id}:1:test"
            families.append(
                {
                    "font_id": candidate_id,
                    "faces": [
                        {
                            "byte_size": len(payload),
                            "face_id": face_id,
                            "file": relative_font,
                            "sha256": hashlib.sha256(payload).hexdigest(),
                        }
                    ],
                }
            )
            display_id = f"{candidate_id}/{face_id}/w400/normal"
            candidates.append(
                {
                    "display_id": display_id,
                    "face_id": face_id,
                    "font_id": candidate_id,
                }
            )
            render_payload = f"render-{index}-{candidate_id}".encode("utf-8")
            relative_render = f"images/{candidate_id}.png"
            render_path = self.render_manifest.parent / relative_render
            render_path.parent.mkdir(parents=True, exist_ok=True)
            render_path.write_bytes(render_payload)
            renders.append(
                {
                    "artifact": {
                        "byte_size": len(render_payload),
                        "file": relative_render,
                        "sha256": hashlib.sha256(render_payload).hexdigest(),
                    },
                    "candidate_display_id": display_id,
                }
            )
        write_json(
            self.font_manifest,
            {
                "face_count": len(families),
                "families": families,
                "family_count": len(families),
                "schema_version": "font-face-manifest-v1",
            },
        )
        write_json(
            self.render_manifest,
            {
                "candidate_count": len(candidates),
                "candidates": candidates,
                "face_count": len(candidates),
                "family_count": len(families),
                "generation": {
                    "complete_against_production_assets": True,
                    "partial": False,
                    "rendered_count": len(renders),
                },
                "renders": renders,
                "schema_version": "font-render-bank-v1",
                "source_contract": {
                    "manifest_sha256": LEGACY.runtime.sha256_file(self.font_manifest)
                },
            },
        )

    def build(self, *, acknowledge: bool = True) -> Mapping[str, Any]:
        with (
            mock.patch.object(
                LEGACY,
                "PINNED_FONT_FACE_MANIFEST_SHA256",
                LEGACY.runtime.sha256_file(self.font_manifest),
            ),
            mock.patch.object(
                LEGACY,
                "PINNED_RENDER_BANK_MANIFEST_SHA256",
                LEGACY.runtime.sha256_file(self.render_manifest),
            ),
        ):
            return LEGACY.build_legacy15_pragmatic_active_catalog(
                font_face_manifest_path=self.font_manifest,
                render_bank_manifest_path=self.render_manifest,
                asset_root=self.asset_root,
                output_dir=self.output,
                approval_id="user-directive-2026-08-02",
                acknowledge_pragmatic_limitations=acknowledge,
            )


class Legacy15PragmaticActiveCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.fixture = Fixture(Path(self.temporary.name))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_builds_exact_prior_only_catalog_with_transitive_approval(self) -> None:
        result = self.fixture.build()

        self.assertEqual(result["status"], "created")
        self.assertEqual(result["candidate_count"], 15)
        self.assertEqual(result["delta_candidate_count"], 0)
        self.assertEqual(
            {path.name for path in self.fixture.output.iterdir()}, LEGACY.OUTPUT_FILES
        )
        authority = json.loads(
            (self.fixture.output / LEGACY.AUTHORITY_FILE).read_text(encoding="utf-8")
        )
        disposition = json.loads(
            (self.fixture.output / LEGACY.DISPOSITION_FILE).read_text(
                encoding="utf-8"
            )
        )
        final_catalog = json.loads(
            (self.fixture.output / LEGACY.FINAL_CATALOG_FILE).read_text(
                encoding="utf-8"
            )
        )
        active = LEGACY.runtime.load_active_catalog(
            self.fixture.output / LEGACY.ACTIVE_CATALOG_FILE
        )
        authority_sha = authority["record_sha256"]
        self.assertEqual(authority["schema_version"], LEGACY.AUTHORITY_SCHEMA)
        self.assertTrue(
            authority["known_limitations"]["successor_catalog_work_deferred"]
        )
        self.assertEqual(disposition["candidate_count"], 0)
        self.assertEqual(disposition["entries"], [])
        self.assertEqual(final_catalog["prior_candidate_count"], 15)
        self.assertEqual(final_catalog["included_delta_candidate_count"], 0)
        self.assertEqual(final_catalog["removed_delta_candidate_count"], 0)
        self.assertEqual(
            disposition["source_records"][
                "pragmatic_release_authority_record_sha256"
            ],
            authority_sha,
        )
        self.assertEqual(
            final_catalog["workspace_contract_record_sha256"], authority_sha
        )
        self.assertEqual(active["candidate_ids"], LEGACY.PINNED_CANDIDATE_IDS)
        self.assertEqual(active["excluded_candidates"], [])
        self.assertTrue(
            all(
                candidate["disposition"]["evidence_source"]
                == "prior_production_catalog"
                for candidate in active["candidates"]
            )
        )
        self.assertEqual(
            active["source_records"]["final_catalog_record_sha256"],
            final_catalog["record_sha256"],
        )

    def test_identical_existing_output_is_idempotent(self) -> None:
        self.fixture.build()
        self.assertEqual(self.fixture.build()["status"], "unchanged")

    def test_requires_explicit_limitations_acknowledgement(self) -> None:
        with self.assertRaisesRegex(
            LEGACY.Legacy15FreezeError, "acknowledge-pragmatic-limitations"
        ):
            self.fixture.build(acknowledge=False)
        self.assertFalse(self.fixture.output.exists())

    def test_rejects_candidate_substitution_even_at_count_15(self) -> None:
        manifest = json.loads(self.fixture.font_manifest.read_text(encoding="utf-8"))
        manifest["families"][0]["font_id"] = "substitute-font"
        write_json(self.fixture.font_manifest, manifest)
        render = json.loads(self.fixture.render_manifest.read_text(encoding="utf-8"))
        render["source_contract"]["manifest_sha256"] = LEGACY.runtime.sha256_file(
            self.fixture.font_manifest
        )
        write_json(self.fixture.render_manifest, render)

        with self.assertRaisesRegex(
            LEGACY.Legacy15FreezeError, "candidate roster drifted"
        ):
            self.fixture.build()

    def test_rejects_pinned_manifest_hash_drift(self) -> None:
        with mock.patch.object(
            LEGACY, "PINNED_FONT_FACE_MANIFEST_SHA256", "0" * 64
        ):
            with self.assertRaisesRegex(
                LEGACY.Legacy15FreezeError, "font face manifest hash drifted"
            ):
                LEGACY.build_legacy15_pragmatic_active_catalog(
                    font_face_manifest_path=self.fixture.font_manifest,
                    render_bank_manifest_path=self.fixture.render_manifest,
                    asset_root=self.fixture.asset_root,
                    output_dir=self.fixture.output,
                    approval_id="user-directive-2026-08-02",
                    acknowledge_pragmatic_limitations=True,
                )

    def test_rejects_tampered_font_asset(self) -> None:
        candidate_id = LEGACY.PINNED_CANDIDATE_IDS[0]
        (self.fixture.asset_root / "assets" / f"{candidate_id}.ttf").write_bytes(
            b"tampered"
        )
        with self.assertRaisesRegex(
            LEGACY.Legacy15FreezeError, "font face asset hash/size mismatch"
        ):
            self.fixture.build()

    def test_rejects_tampered_render_asset(self) -> None:
        candidate_id = LEGACY.PINNED_CANDIDATE_IDS[0]
        (
            self.fixture.render_manifest.parent / "images" / f"{candidate_id}.png"
        ).write_bytes(b"tampered")
        with self.assertRaisesRegex(
            LEGACY.Legacy15FreezeError, "render asset hash/size mismatch"
        ):
            self.fixture.build()


if __name__ == "__main__":
    unittest.main()
