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
from typing import Any, Callable, Mapping

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str, path: Path) -> Any:
    specification = importlib.util.spec_from_file_location(name, path)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


ASSETS = load_script(
    "font_matching_catalog_assets_tested",
    SCRIPTS / "font_matching_catalog_assets.py",
)
CLI = load_script(
    "validate_font_matching_training_assets_tested",
    SCRIPTS / "validate_font_matching_training_assets.py",
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def seal(core: Mapping[str, Any]) -> dict[str, Any]:
    record = dict(core)
    record["record_sha256"] = digest(canonical_json(core))
    return record


def write_json(path: Path, value: Mapping[str, Any]) -> bytes:
    payload = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return payload


def write_rgb(path: Path, size: tuple[int, int], color: tuple[int, int, int]) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", size, color)
    try:
        image.save(path, format="PNG")
    finally:
        image.close()
    return path.read_bytes()


class BundleFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.catalog_root = root / "catalog"
        self.export_root = root / "training-export"
        self.render_root = root / "render-bank"
        self.registry_path = root / "catalog-registry.json"
        self.render_manifest_path = self.render_root / "manifest.json"

        source_manifest = self.catalog_root / "manifest.jsonl"
        source_manifest.parent.mkdir(parents=True, exist_ok=True)
        source_manifest.write_bytes(b'{"id":"source-a"}\n')
        frozen = root / "frozen-split-map.json"
        write_json(
            frozen,
            {
                "schema_version": ASSETS.master.SPLIT_MAP_SCHEMA_VERSION,
                "work_assignments": {},
            },
        )
        registry_core = {
            "schema_version": ASSETS.master.CATALOG_REGISTRY_SCHEMA_VERSION,
            "record_type": ASSETS.master.CATALOG_REGISTRY_RECORD_TYPE,
            "catalogs": [
                {
                    "catalog_id": "catalog-a",
                    "source_kind": "base",
                    "root": str(self.catalog_root.resolve()),
                    "manifest_name": "manifest.jsonl",
                    "manifest_sha256": digest(source_manifest.read_bytes()),
                    "expected_physical_rows": 1,
                    "expected_included_rows": 1,
                }
            ],
            "exclusion_ledgers": [],
            "frozen_split_map": {
                "path": str(frozen.resolve()),
                "sha256": digest(frozen.read_bytes()),
            },
        }
        write_json(self.registry_path, seal(registry_core))
        self.registry_sha256 = digest(self.registry_path.read_bytes())

        prototype_path = self.render_root / "images" / "candidate-a" / "body-h.png"
        prototype_payload = write_rgb(prototype_path, (448, 224), (245, 245, 245))
        display_id = "font-a/font-a:1:111111111111/w400/normal"
        source_file = "src/renderer/src/assets/fonts/ko/font-a.ttf"
        candidate = {
            "allowed_writing_modes": ["horizontal"],
            "blind_alias": "candidate-a",
            "display_id": display_id,
            "font_id": "font-a",
            "missing_probe_codepoints": [],
            "probe_coverage_complete": True,
            "production_400_normal_canonical": True,
            "production_asset_status": {
                "chromium_ots_compatible": True,
                "code": "passed",
            },
            "render_style": "normal",
            "render_weight": 400,
            "source_file": source_file,
            "source_sha256": "1" * 64,
        }
        relative_prototype = prototype_path.relative_to(self.render_root).as_posix()
        render = {
            "artifact": {
                "byte_size": len(prototype_payload),
                "file": relative_prototype,
                "height": 224,
                "qa_overlay": False,
                "sha256": digest(prototype_payload),
                "width": 448,
            },
            "blind_alias": "candidate-a",
            "candidate_display_id": display_id,
            "canvas": {"height": 224, "width": 448},
            "fallback_detection": {"status": "passed"},
            "font_style": "normal",
            "font_weight": 400,
            "image_file": relative_prototype,
            "pixels": {"height": 224, "qa_overlay": False, "width": 448},
            "probe_id": "dialogue-body",
            "readiness": {
                "content_fits": True,
                "document_fonts_ready": True,
                "font_check_passed": True,
                "matching_face_count": 1,
                "matching_face_statuses": ["loaded"],
                "production_font_check_passed": True,
                "requested_face_loaded_count": 1,
            },
            "render_id": "render-a",
            "source_file": source_file,
            "writing_mode": "horizontal",
        }
        render_bank = {
            "candidate_count": 1,
            "candidates": [candidate],
            "deterministic_specification": True,
            "generation": {
                "complete_against_production_assets": True,
                "expected_render_count": 1,
                "full_render_count": 1,
                "partial": False,
                "production_asset_omitted_render_count": 0,
                "rendered_count": 1,
            },
            "render_spec": {
                "capture_format": "png",
                "device_scale_factor": 1,
                "qa_overlay": False,
            },
            "rendered_candidate_count": 1,
            "renders": [render],
            "schema_version": ASSETS.RENDER_BANK_SCHEMA_VERSION,
            "source_contract": {
                "manifest_sha256": "2" * 64,
                "schema_version": "font-face-manifest-v1",
            },
            "specification_sha256": "3" * 64,
        }
        write_json(self.render_manifest_path, render_bank)
        self.render_sha256 = digest(self.render_manifest_path.read_bytes())
        self.render_specification_sha256 = "3" * 64

        view_colors = {
            "raw_224": (210, 20, 30),
            "context_224": (20, 210, 30),
            "glyph_224": (20, 30, 210),
        }
        views = {}
        for view_name, color in view_colors.items():
            relative = f"views/{view_name}.png"
            payload = write_rgb(self.catalog_root / relative, (224, 224), color)
            views[view_name] = self.available_descriptor(relative, payload)
        self.sample_core: dict[str, Any] = {
            "evaluation_eligible": True,
            "example_id": "example-a",
            "input_bindings": {
                "catalog_registry_sha256": self.registry_sha256,
                "render_bank_manifest_sha256": self.render_sha256,
                "render_specification_sha256": self.render_specification_sha256,
            },
            "provenance": {
                "qa_overlay": False,
                "source_catalog_id": "catalog-a",
                "synthetic": False,
            },
            "sample_id": "sample-a",
            "schema_version": ASSETS.TRAINING_SAMPLE_SCHEMA_VERSION,
            "source": {"views": views},
            "split": "train",
        }
        self.write_export()

    @staticmethod
    def available_descriptor(relative: str, payload: bytes) -> dict[str, Any]:
        return {
            "catalog_id": "catalog-a",
            "declared_mode": "RGB",
            "expected_size_px": [224, 224],
            "file_sha256": digest(payload),
            "hash_scope": "file_bytes",
            "path": relative,
            "reason": None,
            "status": "available",
        }

    def mutate_sample(self, change: Callable[[dict[str, Any]], None]) -> None:
        change(self.sample_core)
        self.write_export()

    def write_export(self) -> None:
        self.export_root.mkdir(parents=True, exist_ok=True)
        self.sample = seal(self.sample_core)
        samples_payload = (canonical_json(self.sample) + "\n").encode("utf-8")
        (self.export_root / "samples.jsonl").write_bytes(samples_payload)
        descriptor = {
            "byte_size": len(samples_payload),
            "file": "samples.jsonl",
            "record_count": 1,
            "sha256": digest(samples_payload),
        }
        manifest = {
            "artifacts": {"samples.jsonl": descriptor},
            "candidate_count": 1,
            "contracts": {
                "augmentation_isolation": {
                    "core_files_accept_synthetic": False,
                    "evaluation_splits_accept_generated": False,
                },
                "evaluation": {
                    "generated_examples_allowed": False,
                    "qa_overlay_examples_allowed": False,
                },
                "source_inputs": {
                    "required_views": list(ASSETS.VIEW_NAMES),
                    "review_card_pixels_allowed": False,
                },
            },
            "real_sample_count": 1,
            "master_registry_binding": {"mode": "registry_current_master"},
            "registry_exclusions": {
                "catalog_registry_sha256": self.registry_sha256,
                "excluded_final_count": 0,
                "excluded_final_ids_sha256": digest(b""),
                "ids_digest_algorithm": "sha256-sorted-lf-utf8-v1",
            },
            "renderer_bindings": {
                "render_bank_manifest_sha256": self.render_sha256,
                "render_specification_sha256": self.render_specification_sha256,
            },
            "schema_version": ASSETS.TRAINING_EXPORT_SCHEMA_VERSION,
        }
        manifest_payload = write_json(self.export_root / "manifest.json", manifest)
        report = {
            "checks": {
                "core_qa_overlay_count": 0,
                "core_synthetic_count": 0,
                "generated_evaluation_count": 0,
            },
            "manifest_sha256": digest(manifest_payload),
            "outputs": {"samples.jsonl": descriptor},
            "registry_exclusions": {
                **manifest["registry_exclusions"],
                "parent_workspace_projection": False,
            },
            "schema_version": ASSETS.TRAINING_EXPORT_REPORT_SCHEMA_VERSION,
            "summary": {"migration_mode": "registry_current_master"},
        }
        report_payload = write_json(self.export_root / "report.json", report)
        marker = {
            "manifest_sha256": digest(manifest_payload),
            "owner": ASSETS.TRAINING_EXPORT_OWNER,
            "report_sha256": digest(report_payload),
            "safe_replace": True,
            "schema_version": ASSETS.TRAINING_EXPORT_SCHEMA_VERSION,
        }
        write_json(
            self.export_root / ".font-matching-training-export-owned.json",
            marker,
        )

    def validate(self) -> dict[str, Any]:
        return ASSETS.validate_training_asset_bundle(
            catalog_registry=self.registry_path,
            training_export_dir=self.export_root,
            render_bank_manifest=self.render_manifest_path,
        )


class CatalogAssetValidationTests(unittest.TestCase):
    def test_valid_bundle_resolves_rgb_views_and_seals_deterministic_report(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            first = fixture.validate()
            second = fixture.validate()
            self.assertEqual(first, second)
            ASSETS.validate_record_seal(first, location="report")
            self.assertEqual(first["counts"]["samples"], 1)
            self.assertEqual(first["counts"]["views"], 3)
            self.assertEqual(first["counts"]["render_prototypes"], 1)
            self.assertNotIn(str(fixture.root), ASSETS.canonical_json(first))

            resolver = ASSETS.CatalogAssetResolver(fixture.registry_path)
            with resolver.resolve_sample_view(fixture.sample, "glyph_224") as asset:
                self.assertEqual(asset.mode, "RGB")
                self.assertEqual(asset.size, (224, 224))
                self.assertFalse(asset.materialized)

            render_bank = ASSETS.load_render_bank(fixture.render_manifest_path)
            evidence = render_bank.prototype_evidence[0]
            self.assertEqual(evidence["image_file"], "images/candidate-a/body-h.png")
            with render_bank.resolve_prototype("render-a") as prototype:
                self.assertEqual(prototype.mode, "RGB")
                self.assertEqual(prototype.size, (448, 224))
                self.assertEqual(prototype.font_id, "font-a")

    def test_derivable_raw_is_materialized_by_exact_letterbox_recipe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            native_path = fixture.catalog_root / "native" / "raw.png"
            native_payload = write_rgb(native_path, (80, 40), (200, 10, 20))

            def use_native(sample: dict[str, Any]) -> None:
                sample["source"]["views"]["raw_224"] = {
                    "catalog_id": "catalog-a",
                    "expected_size_px": [224, 224],
                    "file_sha256": None,
                    "materialization_recipe": dict(ASSETS.RAW_224_RECIPE),
                    "path": None,
                    "reason": "raw_224_requires_letterbox",
                    "source_native": {
                        "catalog_id": "catalog-a",
                        "declared_mode": "RGB",
                        "declared_size_px": [80, 40],
                        "file_sha256": digest(native_payload),
                        "hash_scope": "file_bytes",
                        "path": "native/raw.png",
                        "status": "available",
                    },
                    "status": "derivable",
                }

            fixture.mutate_sample(use_native)
            report = fixture.validate()
            self.assertEqual(
                report["counts"]["views_by_status"],
                {"available": 2, "derivable": 1},
            )
            resolver = ASSETS.CatalogAssetResolver(fixture.registry_path)
            with resolver.resolve_sample_view(fixture.sample, "raw_224") as asset:
                self.assertTrue(asset.materialized)
                self.assertEqual(asset.mode, "RGB")
                self.assertEqual(asset.size, (224, 224))
                self.assertEqual(asset.image.getpixel((0, 0)), (255, 255, 255))
                self.assertEqual(asset.image.getpixel((0, 56)), (200, 10, 20))
                self.assertEqual(asset.image.getpixel((223, 167)), (200, 10, 20))
                self.assertEqual(asset.image.getpixel((223, 168)), (255, 255, 255))

    def test_view_path_traversal_is_rejected_before_file_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))

            def escape(sample: dict[str, Any]) -> None:
                sample["source"]["views"]["context_224"]["path"] = "../escape.png"

            fixture.mutate_sample(escape)
            with self.assertRaisesRegex(
                ASSETS.CatalogAssetError, "unsafe relative path"
            ):
                fixture.validate()

    def test_catalog_registry_tamper_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            registry = json.loads(fixture.registry_path.read_text(encoding="utf-8"))
            registry["catalogs"][0]["catalog_id"] = "tampered-catalog"
            write_json(fixture.registry_path, registry)
            with self.assertRaisesRegex(ASSETS.CatalogAssetError, "seal mismatch"):
                fixture.validate()

    def test_parent_workspace_projection_report_extension_is_interoperable(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            manifest_path = fixture.export_root / "manifest.json"
            report_path = fixture.export_root / "report.json"
            marker_path = (
                fixture.export_root / ".font-matching-training-export-owned.json"
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["master_registry_binding"][
                "mode"
            ] = "registry_parent_workspace_projection"
            manifest_payload = write_json(manifest_path, manifest)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["manifest_sha256"] = digest(manifest_payload)
            report["registry_exclusions"]["parent_workspace_projection"] = True
            report["summary"]["migration_mode"] = "registry_parent_workspace_projection"
            report_payload = write_json(report_path, report)
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["manifest_sha256"] = digest(manifest_payload)
            marker["report_sha256"] = digest(report_payload)
            write_json(marker_path, marker)
            self.assertEqual(fixture.validate()["counts"]["samples"], 1)

            report["registry_exclusions"]["parent_workspace_projection"] = False
            report_payload = write_json(report_path, report)
            marker["report_sha256"] = digest(report_payload)
            write_json(marker_path, marker)
            with self.assertRaisesRegex(
                ASSETS.CatalogAssetError, "projection mode drifted"
            ):
                fixture.validate()

    def test_missing_and_hash_mismatched_view_files_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            raw = fixture.catalog_root / "views" / "raw_224.png"
            raw.unlink()
            with self.assertRaisesRegex(ASSETS.CatalogAssetError, "does not exist"):
                fixture.validate()

        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            raw = fixture.catalog_root / "views" / "raw_224.png"
            write_rgb(raw, (224, 224), (0, 0, 0))
            with self.assertRaisesRegex(ASSETS.CatalogAssetError, "file hash mismatch"):
                fixture.validate()

    def test_available_view_mode_and_render_prototype_hash_are_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            context_path = fixture.catalog_root / "views" / "context_224.png"
            grayscale = Image.new("L", (224, 224), 127)
            try:
                grayscale.save(context_path, format="PNG")
            finally:
                grayscale.close()
            payload = context_path.read_bytes()

            def update_hash(sample: dict[str, Any]) -> None:
                view = sample["source"]["views"]["context_224"]
                view["declared_mode"] = "L"
                view["file_sha256"] = digest(payload)

            fixture.mutate_sample(update_hash)
            with self.assertRaisesRegex(ASSETS.CatalogAssetError, "mode must be RGB"):
                fixture.validate()

        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            prototype = fixture.render_root / "images" / "candidate-a" / "body-h.png"
            write_rgb(prototype, (448, 224), (0, 0, 0))
            with self.assertRaisesRegex(
                ASSETS.CatalogAssetError, "render artifact hash mismatch"
            ):
                fixture.validate()

    def test_synthetic_overlay_and_evaluation_ineligible_inputs_hard_fail(
        self,
    ) -> None:
        cases: tuple[tuple[str, Callable[[dict[str, Any]], None], str], ...] = (
            (
                "synthetic",
                lambda sample: sample["provenance"].__setitem__("synthetic", True),
                "synthetic",
            ),
            (
                "evaluation",
                lambda sample: sample.__setitem__("evaluation_eligible", False),
                "evaluation-ineligible",
            ),
            (
                "overlay",
                lambda sample: sample["source"]["views"]["glyph_224"].__setitem__(
                    "qa_overlay", True
                ),
                "overlay",
            ),
        )
        for name, mutation, expected in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                fixture = BundleFixture(Path(temporary))
                fixture.mutate_sample(mutation)
                with self.assertRaisesRegex(ASSETS.CatalogAssetError, expected):
                    fixture.validate()

    def test_cli_writes_once_then_verifies_identical_sealed_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = BundleFixture(Path(temporary))
            output_path = fixture.root / "validation.json"
            argv = [
                "--catalog-registry",
                str(fixture.registry_path),
                "--training-export-dir",
                str(fixture.export_root),
                "--render-bank-manifest",
                str(fixture.render_manifest_path),
                "--output",
                str(output_path),
            ]
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(CLI.main(argv), 0)
            self.assertEqual(json.loads(stdout.getvalue())["status"], "written")
            original = output_path.read_bytes()
            report = json.loads(original.decode("utf-8"))
            ASSETS.validate_record_seal(report, location="report")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(CLI.main(argv), 0)
            self.assertEqual(json.loads(stdout.getvalue())["status"], "verified")
            self.assertEqual(output_path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
