from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

from scripts import build_font_matching_runtime_artifact as runtime
from scripts import export_manga_font_student_runtime_onnx as exporter
from scripts import train_manga_font_student_v1 as trainer


CANDIDATE_IDS = exporter.EXPECTED_CANDIDATE_IDS
SHA = "a" * 64


def runtime_adapter(*, encoder_name: str = "image_features") -> dict[str, object]:
    return {
        "candidate_bags_source": "prototype_bank.candidate_bags",
        "candidate_scores_authority": "runtime_ranker",
        "checkpoint_prefixes": dict(exporter.EXPECTED_PREFIXES),
        "encoder_onnx_output": {
            "name": encoder_name,
            "normalization": "l2",
            "shape": [None, trainer.PROJECTION_DIM],
        },
        "ranker_onnx_inputs": [
            {"name": "views", "shape": [None, 3, trainer.PROJECTION_DIM]},
            {
                "name": "prototype_features",
                "shape": [None, trainer.PROJECTION_DIM],
            },
        ],
        "ranker_onnx_outputs": [
            "candidate_scores",
            "none_logits",
            "role_logits",
            "style_logits",
            "treatment_distortion_logits",
            "treatment_fill_logits",
            "treatment_orientation_logits",
            "treatment_outline_logits",
            "treatment_shadow_logits",
            "view_gate_weights",
        ],
        "schema_version": "manga-font-student-onnx-adapter-v1",
    }


def student_contract(*, encoder_name: str = "image_features") -> dict[str, object]:
    state_contract = [
        {"dtype": "float32", "name": "vision_encoder.block.weight", "shape": [1]},
        {"dtype": "float32", "name": "projection.0.weight", "shape": [1]},
        {"dtype": "float32", "name": "font_head.weight", "shape": [1]},
        {"dtype": "float32", "name": "runtime_ranker.view_gate.weight", "shape": [1]},
    ]
    return {
        "architecture": {
            "candidate_count": 22,
            "projection_dim": trainer.PROJECTION_DIM,
        },
        "checkpoint": {
            "metadata": {"format": trainer.OUTPUT_SCHEMA},
            "state_contract": state_contract,
        },
        "encoder": {
            "class": "SiglipVisionModel",
            "model_id": trainer.MODEL_ID,
            "revision": trainer.MODEL_REVISION,
        },
        "inputs": {
            "catalog_registry_sha256": SHA,
            "human_export_manifest_sha256": SHA,
        },
        "prototype_bank": {
            "candidate_bags": [
                {"candidate_id": value, "count": 1, "start": index}
                for index, value in enumerate(CANDIDATE_IDS)
            ],
            "feature_dim": trainer.PROJECTION_DIM,
            "prototype_count": len(CANDIDATE_IDS),
        },
        "runtime_export_adapter": runtime_adapter(encoder_name=encoder_name),
        "source_code_sha256": SHA,
        "vocabulary": {
            "candidate_ids": list(CANDIDATE_IDS),
            "roles": list(trainer.ROLE_VALUES),
            "style_fields": list(trainer.STYLE_FIELDS),
            "treatments": {
                field: list(values)
                for field, values in trainer.TREATMENT_VALUES.items()
            },
        },
    }


def v3_student_contract() -> dict[str, object]:
    contract = student_contract()
    contract["architecture"]["runtime_candidate_scorer_schema"] = (  # type: ignore[index]
        exporter.V3_SCORER_SCHEMA
    )
    contract["checkpoint"]["metadata"]["trainer_extension"] = (  # type: ignore[index]
        exporter.V3_EXTENSION_SCHEMA
    )
    contract["trainer_extension"] = {
        "quality_gate": {"passed": True},
        "runtime_io_change_required": False,
        "runtime_ranker_hyperparameters": {
            "candidate_count": len(CANDIDATE_IDS),
            "residual_dropout": 0.125,
            "residual_initial_scale": 0.75,
            "scorer_schema": exporter.V3_SCORER_SCHEMA,
            "semantic_mix_initial": 0.25,
        },
        "runtime_ranker_reconstruction_required": True,
        "schema_version": exporter.V3_EXTENSION_SCHEMA,
        "scorer_schema": exporter.V3_SCORER_SCHEMA,
    }
    return contract


class AdapterContractTests(unittest.TestCase):
    def test_adapter_is_exactly_the_application_onnx_contract(self) -> None:
        outputs = exporter._validate_runtime_adapter(student_contract())
        self.assertEqual(outputs[0], "candidate_scores")
        self.assertEqual(outputs[-1], "view_gate_weights")
        self.assertEqual(len(outputs), 10)

    def test_old_view_features_name_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError, "differs from app runtime"
        ):
            exporter._validate_runtime_adapter(
                student_contract(encoder_name="view_features")
            )

    def test_unknown_checkpoint_prefix_fails_closed(self) -> None:
        contract = student_contract()
        contract["checkpoint"]["state_contract"].append(  # type: ignore[index]
            {"dtype": "float32", "name": "unsealed.weight", "shape": [1]}
        )
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError, "unknown parameter prefix"
        ):
            exporter._validate_runtime_adapter(contract)

    def test_missing_checkpoint_prefix_fails_closed(self) -> None:
        contract = student_contract()
        contract["checkpoint"]["state_contract"] = [  # type: ignore[index]
            row
            for row in contract["checkpoint"]["state_contract"]  # type: ignore[index]
            if not row["name"].startswith("font_head.")
        ]
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError, "omits an export-required"
        ):
            exporter._validate_runtime_adapter(contract)

    def test_v3_keeps_exact_v1_onnx_io_and_binds_checkpoint_extension(self) -> None:
        contract = v3_student_contract()
        self.assertEqual(
            exporter._validate_runtime_adapter(contract),
            tuple(runtime_adapter()["ranker_onnx_outputs"]),
        )
        del contract["checkpoint"]["metadata"]["trainer_extension"]  # type: ignore[index]
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError,
            "checkpoint metadata is not bound",
        ):
            exporter._validate_runtime_adapter(contract)

    def test_v3_reconstruction_values_require_exact_sealed_inventory(self) -> None:
        contract = v3_student_contract()
        self.assertEqual(
            exporter._v3_ranker_reconstruction_values(
                contract, candidate_count=len(CANDIDATE_IDS)
            ),
            (0.125, 0.75),
        )
        parameters = contract["trainer_extension"][  # type: ignore[index]
            "runtime_ranker_hyperparameters"
        ]
        parameters["unsealed"] = True
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError,
            "hyperparameter inventory drifted",
        ):
            exporter._v3_ranker_reconstruction_values(
                contract, candidate_count=len(CANDIDATE_IDS)
            )

    def test_v3_reconstruction_uses_sealed_dropout_and_residual_scale(self) -> None:
        torch_token = object()
        vision_token = object()
        builder = mock.Mock(return_value=("v3-student", (10, 11)))
        with mock.patch.object(
            exporter,
            "_load_v3_trainer",
            return_value=SimpleNamespace(build_student_model_v3=builder),
        ):
            result = exporter._build_student_for_export(
                torch_token,
                vision_encoder=vision_token,
                contract=v3_student_contract(),
                candidate_count=len(CANDIDATE_IDS),
            )
        self.assertEqual(result, ("v3-student", (10, 11)))
        builder.assert_called_once_with(
            torch_token,
            vision_encoder=vision_token,
            candidate_count=len(CANDIDATE_IDS),
            dropout=0.125,
            residual_scale=0.75,
        )

    def test_v1_and_v2_reconstruction_still_use_the_base_model(self) -> None:
        for extension in (None, {"schema_version": exporter.V2_EXTENSION_SCHEMA}):
            with self.subTest(extension=extension):
                contract = student_contract()
                if extension is not None:
                    contract["trainer_extension"] = extension
                with mock.patch.object(
                    trainer,
                    "build_student_model",
                    return_value=("legacy-student", (10, 11)),
                ) as builder:
                    result = exporter._build_student_for_export(
                        "torch",
                        vision_encoder="vision",
                        contract=contract,
                        candidate_count=len(CANDIDATE_IDS),
                    )
                self.assertEqual(result, ("legacy-student", (10, 11)))
                builder.assert_called_once_with(
                    "torch",
                    vision_encoder="vision",
                    candidate_count=len(CANDIDATE_IDS),
                )

    def test_v2_and_v3_extensions_dispatch_to_their_sealed_validators(self) -> None:
        cases = (
            (
                exporter.V2_EXTENSION_SCHEMA,
                "validate_v2_output",
                exporter._load_v2_trainer,
            ),
            (
                exporter.V3_EXTENSION_SCHEMA,
                "validate_v3_output",
                exporter._load_v3_trainer,
            ),
        )
        for schema, method_name, loader in cases:
            with (
                self.subTest(schema=schema),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                contract = student_contract()
                contract["trainer_extension"] = {"schema_version": schema}
                (root / trainer.CONTRACT_FILE).write_bytes(
                    exporter.json_bytes(contract, pretty=True)
                )
                validator = mock.Mock(return_value={"training_extension": schema})
                extension_module = SimpleNamespace(**{method_name: validator})
                with (
                    mock.patch.object(
                        trainer, "validate_output", return_value={"status": "ready"}
                    ),
                    mock.patch.object(
                        exporter, loader.__name__, return_value=extension_module
                    ),
                ):
                    result = exporter._validate_student_output_for_export(root)
                self.assertEqual(result["training_extension"], schema)
                validator.assert_called_once_with(root)

    def test_v1_without_extension_returns_base_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / trainer.CONTRACT_FILE).write_bytes(
                exporter.json_bytes(student_contract(), pretty=True)
            )
            with mock.patch.object(
                trainer,
                "validate_output",
                return_value={"status": "v1-ready"},
            ) as validator:
                result = exporter._validate_student_output_for_export(root)
        self.assertEqual(result, {"status": "v1-ready"})
        validator.assert_called_once_with(root)

    def test_v3_quality_gate_failure_is_export_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            contract = v3_student_contract()
            contract["trainer_extension"]["quality_gate"] = {  # type: ignore[index]
                "passed": False
            }
            (root / trainer.CONTRACT_FILE).write_bytes(
                exporter.json_bytes(contract, pretty=True)
            )
            validator = mock.Mock(
                side_effect=trainer.MangaFontStudentError(
                    "v3 output is research-only; deployment gate failed"
                )
            )
            with (
                mock.patch.object(
                    trainer, "validate_output", return_value={"status": "ready"}
                ),
                mock.patch.object(
                    exporter,
                    "_load_v3_trainer",
                    return_value=SimpleNamespace(validate_v3_output=validator),
                ),
                self.assertRaisesRegex(
                    exporter.StudentRuntimeExportError, "deployment gate failed"
                ),
            ):
                exporter._validate_student_output_for_export(root)

    def test_unknown_student_trainer_extension_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            contract = student_contract()
            contract["trainer_extension"] = {"schema_version": "future-v99"}
            (root / trainer.CONTRACT_FILE).write_bytes(
                exporter.json_bytes(contract, pretty=True)
            )
            with (
                mock.patch.object(
                    trainer, "validate_output", return_value={"status": "ready"}
                ),
                self.assertRaisesRegex(
                    exporter.StudentRuntimeExportError,
                    "unsupported MangaFont student trainer extension",
                ),
            ):
                exporter._validate_student_output_for_export(root)

    def test_repository_v2_assets_and_render_bank_cover_all_22_fonts(self) -> None:
        font_sha, render_sha = exporter._validate_full22_catalog_sources(
            font_face_manifest_path=Path(
                "datasets/fontclip-font-catalog-v2/manifest.json"
            ),
            render_bank_manifest_path=Path(
                "datasets/fontclip-font-render-bank-v2/manifest.json"
            ),
            asset_root=Path("."),
            candidate_ids=exporter.EXPECTED_CANDIDATE_IDS,
        )
        self.assertEqual(font_sha, exporter.FULL22_FONT_MANIFEST_SHA256)
        self.assertEqual(render_sha, exporter.FULL22_RENDER_MANIFEST_SHA256)

    def test_managed_full22_bundle_must_belong_to_current_student(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            student = root / "student"
            student.mkdir()
            (student / trainer.CONTRACT_FILE).write_bytes(
                exporter.json_bytes(student_contract(), pretty=True)
            )
            (student / trainer.CHECKPOINT_FILE).write_bytes(b"student-v2-checkpoint")
            bundle = root / "full22-active"
            bundle.mkdir()
            for name, payload in (
                (exporter.ACTIVE_CATALOG_FILE, b'{"active":true}\n'),
                (exporter.FULL22_DISPOSITION_FILE, b'{"disposition":true}\n'),
                (exporter.FULL22_FINAL_CATALOG_FILE, b'{"final":true}\n'),
            ):
                (bundle / name).write_bytes(payload)
            source = {
                "font_face_manifest_sha256": exporter.FULL22_FONT_MANIFEST_SHA256,
                "manga_font_student_checkpoint_sha256": exporter.sha256_file(
                    student / trainer.CHECKPOINT_FILE
                ),
                "manga_font_student_contract_sha256": exporter.sha256_file(
                    student / trainer.CONTRACT_FILE
                ),
                "render_bank_manifest_sha256": exporter.FULL22_RENDER_MANIFEST_SHA256,
            }
            authority = runtime.seal_record(
                {
                    "candidate_ids": list(CANDIDATE_IDS),
                    "record_type": "manga_font_full22_release_authority",
                    "schema_version": "manga-font-full22-release-authority-v1",
                    "sources": dict(source),
                }
            )
            (bundle / exporter.FULL22_AUTHORITY_FILE).write_bytes(
                exporter.json_bytes(authority, pretty=True)
            )
            marker = {
                "artifacts": {
                    name: exporter.sha256_file(bundle / name)
                    for name in exporter.FULL22_ACTIVE_FILES
                    if name != exporter.FULL22_ACTIVE_MARKER
                },
                "owner": exporter.FULL22_ACTIVE_OWNER,
                "safe_replace": True,
                "schema_version": exporter.FULL22_ACTIVE_SCHEMA,
                "source": dict(source),
            }
            marker_path = bundle / exporter.FULL22_ACTIVE_MARKER
            marker_path.write_bytes(exporter.json_bytes(marker, pretty=True))
            active_catalog = bundle / exporter.ACTIVE_CATALOG_FILE

            exporter._validate_student_bound_active_catalog_bundle(
                student_root=student,
                active_catalog_path=active_catalog,
            )

            marker["source"]["manga_font_student_checkpoint_sha256"] = "b" * 64
            marker_path.write_bytes(exporter.json_bytes(marker, pretty=True))
            with self.assertRaisesRegex(
                exporter.StudentRuntimeExportError,
                "belongs to a different student checkpoint",
            ):
                exporter._validate_student_bound_active_catalog_bundle(
                    student_root=student,
                    active_catalog_path=active_catalog,
                )


class RuntimeFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.student = root / "student"
        self.student.mkdir()
        self.active_catalog = root / "all22-active.json"
        self.active_catalog.write_text('{"fixture":true}\n', encoding="utf-8")
        self.encoder_source = root / trainer.MODEL_REVISION
        self.encoder_source.mkdir()
        self.checkpoint = self.student / trainer.CHECKPOINT_FILE
        self.checkpoint.write_bytes(b"checkpoint-delta")
        self.prototype = self.student / trainer.PROTOTYPE_FILE
        prototypes = np.arange(
            len(CANDIDATE_IDS) * trainer.PROJECTION_DIM, dtype="<f4"
        ).reshape(len(CANDIDATE_IDS), trainer.PROJECTION_DIM)
        self.prototype.write_bytes(prototypes.tobytes(order="C"))
        self.contract_path = self.student / trainer.CONTRACT_FILE
        self.contract_path.write_bytes(
            exporter.json_bytes(student_contract(), pretty=True)
        )
        self.report_path = self.student / trainer.REPORT_FILE
        self.report_path.write_bytes(
            exporter.json_bytes(
                {
                    "best_human_val": {"acceptable_at1": 0.8, "recall_at3": 0.95},
                    "human_boundary": {"val_row_count": 204},
                },
                pretty=True,
            )
        )
        self.output = root / "runtime-full22"
        sources = {
            "catalog_disposition_record_sha256": "1" * 64,
            "deployment_font_face_manifest_sha256": "2" * 64,
            "deployment_render_bank_manifest_sha256": "3" * 64,
            "evidence_font_face_manifest_sha256": "4" * 64,
            "evidence_render_bank_manifest_sha256": "5" * 64,
            "final_catalog_record_sha256": "6" * 64,
        }
        self.active_record = {
            "candidate_ids": CANDIDATE_IDS,
            "catalog_version": exporter.FULL22_CATALOG_VERSION,
            "record_sha256": "7" * 64,
            "source_records": {
                **sources,
                "deployment_font_face_manifest_sha256": (
                    exporter.FULL22_FONT_MANIFEST_SHA256
                ),
                "deployment_render_bank_manifest_sha256": (
                    exporter.FULL22_RENDER_MANIFEST_SHA256
                ),
            },
        }
        contract = student_contract()
        contract["prototype_bank"]["sha256"] = exporter.sha256_file(  # type: ignore[index]
            self.prototype
        )
        self.authority = exporter.StudentAuthority(
            student_root=self.student,
            active_catalog_path=self.active_catalog,
            active_catalog=self.active_record,
            contract=contract,
            report={
                "best_human_val": {"acceptable_at1": 0.8, "recall_at3": 0.95},
                "human_boundary": {"val_row_count": 204},
            },
            checkpoint_path=self.checkpoint,
            prototype_path=self.prototype,
            prototypes=prototypes,
            candidate_ids=CANDIDATE_IDS,
            candidate_bags=tuple(
                {"candidate_id": value, "count": 1, "start": index}
                for index, value in enumerate(CANDIDATE_IDS)
            ),
            encoder_source_dir=self.encoder_source,
            encoder_source_weights=self.checkpoint,
        )


class OwnedRuntimeBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = RuntimeFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def patches(self) -> list[mock._patch]:
        fixture = self.fixture
        expected_io = exporter._io_contract(fixture.authority)

        def fake_export(**kwargs: object) -> None:
            Path(kwargs["encoder_path"]).write_bytes(b"student-encoder-onnx")
            Path(kwargs["ranker_path"]).write_bytes(b"student-ranker-onnx")

        def fake_io(path: Path) -> object:
            return expected_io[path.name]

        return [
            mock.patch.object(
                exporter, "load_student_authority", return_value=fixture.authority
            ),
            mock.patch.object(
                exporter, "_load_models", return_value=(SimpleNamespace(), object())
            ),
            mock.patch.object(
                exporter, "_make_wrappers", return_value=(object(), object())
            ),
            mock.patch.object(exporter, "_export_graphs", side_effect=fake_export),
            mock.patch.object(
                exporter,
                "inspect_graph",
                return_value={"opset": exporter.OPSET_VERSION},
            ),
            mock.patch.object(runtime, "_inspect_onnx_contract", side_effect=fake_io),
            mock.patch.object(
                exporter,
                "_run_parity",
                return_value={
                    "cpu": {"metrics": {"candidate_top1_agreement": 1.0}},
                    "frozen_test_pixels_opened": 0,
                    "frozen_test_rows_used": 0,
                    "opset": exporter.OPSET_VERSION,
                    "sample_count": 32,
                    "sample_source": "deterministic_synthetic_only",
                    "wasm": {"metrics": {"candidate_top1_agreement": 1.0}},
                },
            ),
            mock.patch.object(
                runtime,
                "_validate_runtime_artifact",
                return_value={
                    "candidate_count": 22,
                    "model_version": "fixture",
                    "status": "ready",
                },
            ),
        ]

    def build(self) -> dict[str, object]:
        patchers = self.patches()
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        return dict(
            exporter.build_runtime_output(
                student_output=self.fixture.student,
                active_catalog_path=self.fixture.active_catalog,
                encoder_source_dir=self.fixture.encoder_source,
                output_dir=self.fixture.output,
                electron_path=self.fixture.root / "electron.exe",
            )
        )

    def test_build_atomically_emits_the_exact_base_runtime_inventory(self) -> None:
        result = self.build()
        self.assertEqual(
            result["status"],
            "base_runtime_ready_for_supervised_calibration_attachment",
        )
        self.assertTrue(result["selection_calibration_required"])
        self.assertEqual(
            {path.name for path in self.fixture.output.iterdir()},
            exporter.OUTPUT_FILES,
        )
        contract = json.loads(
            (self.fixture.output / exporter.CONTRACT_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(contract["head"]["architecture"]["feature_dim"], 256)
        self.assertEqual(contract["catalog"]["candidate_count"], 22)
        self.assertEqual(
            contract["onnx_io_contract"]["encoder.onnx"]["outputs"][0]["name"],
            "image_features",
        )
        self.assertEqual(
            contract["onnx_io_contract"]["ranker.onnx"]["outputs"][0]["name"],
            "candidate_scores",
        )

    def test_failure_before_publish_leaves_no_output_or_staging_directory(self) -> None:
        patchers = self.patches()
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(mock.patch.stopall)
        exporter._run_parity.side_effect = exporter.StudentRuntimeExportError(  # type: ignore[attr-defined]
            "parity failed"
        )
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError, "parity failed"
        ):
            exporter.build_runtime_output(
                student_output=self.fixture.student,
                active_catalog_path=self.fixture.active_catalog,
                encoder_source_dir=self.fixture.encoder_source,
                output_dir=self.fixture.output,
                electron_path=self.fixture.root / "electron.exe",
            )
        self.assertFalse(self.fixture.output.exists())
        self.assertEqual(
            list(self.fixture.root.glob(f".{self.fixture.output.name}.staging-*")), []
        )

    def test_tampered_published_asset_fails_closed(self) -> None:
        self.build()
        (self.fixture.output / exporter.RANKER_FILE).write_bytes(b"tampered")
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError, "artifact hash mismatch"
        ):
            exporter.validate_runtime_output(
                student_output=self.fixture.student,
                active_catalog_path=self.fixture.active_catalog,
                encoder_source_dir=self.fixture.encoder_source,
                output_dir=self.fixture.output,
                inspect_onnx=False,
            )


class Full22ActiveCatalogBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = RuntimeFixture(Path(self.temp.name))
        self.font_manifest = self.fixture.root / "font-manifest.json"
        self.render_manifest = self.fixture.root / "render-manifest.json"
        self.font_manifest.write_text("{}\n", encoding="utf-8")
        self.render_manifest.write_text("{}\n", encoding="utf-8")
        self.output = self.fixture.root / "full22-active-bundle"
        self.active_record = {
            "candidate_ids": exporter.EXPECTED_CANDIDATE_IDS,
            "catalog_version": exporter.FULL22_CATALOG_VERSION,
            "excluded_candidates": [],
            "record_sha256": "8" * 64,
            "source_records": {
                "catalog_disposition_record_sha256": "9" * 64,
                "deployment_font_face_manifest_sha256": (
                    exporter.FULL22_FONT_MANIFEST_SHA256
                ),
                "deployment_render_bank_manifest_sha256": (
                    exporter.FULL22_RENDER_MANIFEST_SHA256
                ),
                "evidence_font_face_manifest_sha256": "a" * 64,
                "evidence_render_bank_manifest_sha256": "b" * 64,
                "final_catalog_record_sha256": "c" * 64,
            },
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def patches(self, *, fail_build: bool = False) -> list[mock._patch]:
        def fake_active_catalog_build(**kwargs: object) -> object:
            if fail_build:
                raise runtime.RuntimeArtifactError("render coverage failed")
            output = Path(kwargs["output_path"])
            output.write_text('{"sealed":"active"}\n', encoding="utf-8")
            return {"candidate_count": 22, "status": "ready"}

        def fake_load_active_catalog(path: Path, **_kwargs: object) -> object:
            root = Path(path).parent
            disposition = json.loads(
                (root / exporter.FULL22_DISPOSITION_FILE).read_text("utf-8")
            )
            final_catalog = json.loads(
                (root / exporter.FULL22_FINAL_CATALOG_FILE).read_text("utf-8")
            )
            record = dict(self.active_record)
            record["source_records"] = {
                **self.active_record["source_records"],
                "catalog_disposition_record_sha256": disposition["record_sha256"],
                "final_catalog_record_sha256": final_catalog["record_sha256"],
            }
            return record

        return [
            mock.patch.object(
                trainer, "validate_output", return_value={"status": "ready"}
            ),
            mock.patch.object(
                exporter,
                "_validate_full22_catalog_sources",
                return_value=(
                    exporter.FULL22_FONT_MANIFEST_SHA256,
                    exporter.FULL22_RENDER_MANIFEST_SHA256,
                ),
            ),
            mock.patch.object(
                runtime, "build_active_catalog", side_effect=fake_active_catalog_build
            ),
            mock.patch.object(
                runtime, "load_active_catalog", side_effect=fake_load_active_catalog
            ),
        ]

    def test_builder_seals_sorted_v5_set_and_student_runtime_order(self) -> None:
        patchers = self.patches()
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        result = exporter.build_full22_active_catalog_output(
            student_output=self.fixture.student,
            font_face_manifest_path=self.font_manifest,
            render_bank_manifest_path=self.render_manifest,
            asset_root=self.fixture.root,
            output_dir=self.output,
        )
        self.assertEqual(result["candidate_count"], 22)
        self.assertEqual(
            {path.name for path in self.output.iterdir()},
            exporter.FULL22_ACTIVE_FILES,
        )
        final_catalog = json.loads(
            (self.output / exporter.FULL22_FINAL_CATALOG_FILE).read_text("utf-8")
        )
        self.assertEqual(
            tuple(final_catalog["candidate_ids"]),
            tuple(sorted(exporter.EXPECTED_CANDIDATE_IDS)),
        )
        authority = json.loads(
            (self.output / exporter.FULL22_AUTHORITY_FILE).read_text("utf-8")
        )
        self.assertEqual(
            tuple(authority["candidate_ids"]), exporter.EXPECTED_CANDIDATE_IDS
        )
        self.assertEqual(final_catalog["included_delta_candidate_count"], 0)
        self.assertEqual(final_catalog["prior_candidate_count"], 22)
        marker = json.loads(
            (self.output / exporter.FULL22_ACTIVE_MARKER).read_text("utf-8")
        )
        self.assertEqual(
            marker["source"]["manga_font_student_checkpoint_sha256"],
            exporter.sha256_file(self.fixture.checkpoint),
        )

    def test_render_validation_failure_is_atomic(self) -> None:
        patchers = self.patches(fail_build=True)
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        with self.assertRaisesRegex(
            exporter.StudentRuntimeExportError, "render coverage failed"
        ):
            exporter.build_full22_active_catalog_output(
                student_output=self.fixture.student,
                font_face_manifest_path=self.font_manifest,
                render_bank_manifest_path=self.render_manifest,
                asset_root=self.fixture.root,
                output_dir=self.output,
            )
        self.assertFalse(self.output.exists())
        self.assertEqual(
            list(self.fixture.root.glob(".full22-active-bundle.staging-*")), []
        )


@unittest.skipUnless(
    importlib.util.find_spec("onnx") is not None, "requires the ONNX checker"
)
class OnnxCheckerTests(unittest.TestCase):
    def test_checker_accepts_a_self_contained_opset17_graph(self) -> None:
        import onnx
        from onnx import TensorProto, helper

        graph = helper.make_graph(
            [helper.make_node("Identity", ["input"], ["output"])],
            "identity",
            [helper.make_tensor_value_info("input", TensorProto.FLOAT, [None, 2])],
            [helper.make_tensor_value_info("output", TensorProto.FLOAT, [None, 2])],
        )
        model = helper.make_model(
            graph, opset_imports=[helper.make_opsetid("", exporter.OPSET_VERSION)]
        )
        with tempfile.TemporaryDirectory() as raw_root:
            path = Path(raw_root) / "identity.onnx"
            onnx.save(model, path)
            result = exporter.inspect_graph(path)
        self.assertEqual(result["opset"], exporter.OPSET_VERSION)
        self.assertEqual(result["node_count"], 1)


if __name__ == "__main__":
    unittest.main()
