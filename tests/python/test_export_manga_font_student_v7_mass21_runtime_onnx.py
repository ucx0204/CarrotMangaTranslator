from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

from scripts import build_font_matching_runtime_artifact as runtime
from scripts import attach_font_matching_selection_calibration as attach_calibration
from scripts import export_manga_font_student_runtime_onnx as base_export
from scripts import export_manga_font_student_v7_mass21_runtime_onnx as exporter


def _full22_catalog() -> dict[str, object]:
    candidates = []
    for index, candidate_id in enumerate(base_export.EXPECTED_CANDIDATE_IDS):
        candidates.append(
            {
                "assets": [
                    {
                        "byte_size": index + 1,
                        "face_id": f"{candidate_id}:face",
                        "file": f"fonts/{candidate_id}.ttf",
                        "sha256": f"{index + 1:064x}",
                    }
                ],
                "candidate_id": candidate_id,
                "disposition": {
                    "action": "prior_production_catalog",
                    "active_release_eligible": True,
                    "all_unrenderable": False,
                    "deployable_opportunity_count": None,
                    "evidence_source": "prior_production_catalog",
                    "safe_count": None,
                    "terminal": True,
                },
            }
        )
    source_records = {
        "catalog_disposition_record_sha256": "1" * 64,
        "deployment_font_face_manifest_sha256": "2" * 64,
        "deployment_render_bank_manifest_sha256": "3" * 64,
        "evidence_font_face_manifest_sha256": "4" * 64,
        "evidence_render_bank_manifest_sha256": "5" * 64,
        "final_catalog_record_sha256": "6" * 64,
    }
    record = runtime.seal_record(
        {
            "candidate_count": 22,
            "candidate_ids": list(base_export.EXPECTED_CANDIDATE_IDS),
            "candidate_order_sha256": runtime._ordered_values_sha256(  # noqa: SLF001
                base_export.EXPECTED_CANDIDATE_IDS
            ),
            "candidates": candidates,
            "catalog_version": base_export.FULL22_CATALOG_VERSION,
            "excluded_candidates": [],
            "locale": "ko",
            "record_type": runtime.ACTIVE_CATALOG_RECORD_TYPE,
            "schema_version": runtime.ACTIVE_CATALOG_SCHEMA,
            "source_records": source_records,
        }
    )
    return {"record": record}


def _write_completed_r3_source(
    root: Path, *, quality_gate_passed: bool
) -> dict[str, object]:
    root.mkdir(parents=True)
    prototypes = np.zeros(
        (
            len(exporter.ACTIVE_CANDIDATE_IDS),
            exporter.QUERY_COUNT,
            exporter.QUERY_DIM,
        ),
        dtype="<f4",
    )
    for index in range(len(exporter.ACTIVE_CANDIDATE_IDS)):
        prototypes[index, :, index] = 1.0
    for name in exporter.trainer_v7_r3.OUTPUT_FILES - {
        exporter.trainer_v7_r3.MARKER,
        exporter.trainer_v7.MANIFEST,
    }:
        path = root / name
        if name == exporter.trainer_v7.PROTOTYPES:
            path.write_bytes(prototypes.tobytes())
        else:
            path.write_bytes(f"sealed-{name}".encode("utf-8"))
    source_sha = runtime.sha256_file(
        Path(exporter.trainer_v7_r3.__file__).resolve()
    )
    source_fingerprint = {
        "r3_checkpoint_sha256": "a" * 64,
        "r3_report_sha256": "b" * 64,
    }
    descriptor_names = exporter.trainer_v7_r3.OUTPUT_FILES - {
        exporter.trainer_v7_r3.MARKER,
        exporter.trainer_v7.MANIFEST,
    }
    manifest = runtime.seal_record(
        {
            "architecture": {
                "candidate_bias": False,
                "encoder_trainable_blocks": 0,
                "query_count": exporter.QUERY_COUNT,
                "query_dim": exporter.QUERY_DIM,
            },
            "best_epoch": 0,
            "best_val": {
                "evaluated_positive_rows": 33,
                "preferred_at1": 0.5,
                "variant_val_rows": 28,
            },
            "candidate_ids": list(exporter.ACTIVE_CANDIDATE_IDS),
            "distillation": {
                "teacher_checkpoint_sha256": source_fingerprint[
                    "r3_checkpoint_sha256"
                ]
            },
            "files": {
                name: runtime._artifact_descriptor(  # noqa: SLF001
                    root / name, file_name=name
                )
                for name in descriptor_names
            },
            "history_epochs": 1,
            "quality_gate": {"passed": quality_gate_passed},
            "record_type": "manga_font_student_v7_mass21_r3_teacher_stable_training_manifest",
            "schema_version": exporter.trainer_v7_r3.SCHEMA,
            "source_code_sha256": source_sha,
            "source_fingerprint": source_fingerprint,
            "source_provenance": {"r3_source_code_sha256": source_sha},
        }
    )
    (root / exporter.trainer_v7.MANIFEST).write_bytes(
        runtime.json_bytes(manifest, pretty=True)
    )
    marker = {
        "artifacts": {
            name: runtime.sha256_file(root / name)
            for name in exporter.trainer_v7_r3.OUTPUT_FILES
            - {exporter.trainer_v7_r3.MARKER}
        },
        "owner": exporter.trainer_v7_r3.OWNER,
        "safe_replace": True,
        "schema_version": exporter.trainer_v7_r3.SCHEMA,
    }
    (root / exporter.trainer_v7_r3.MARKER).write_bytes(
        runtime.json_bytes(marker, pretty=True)
    )
    return manifest


def _runtime_authority_fixture(
    root: Path, *, quality_gate_passed: bool
) -> exporter.V7RuntimeAuthority:
    sources = root / "sources"
    student = sources / "student"
    catalog_dir = sources / "catalog"
    encoder = sources / "encoder"
    for directory in (student, catalog_dir, encoder):
        directory.mkdir(parents=True)
    base_checkpoint = student / exporter.trainer.CHECKPOINT_FILE
    base_checkpoint.write_bytes(b"base-checkpoint")
    base_contract_path = student / exporter.trainer.CONTRACT_FILE
    base_contract_path.write_text("{}\n", encoding="utf-8")
    active_catalog_path = catalog_dir / "active.json"
    active_catalog_path.write_text("{}\n", encoding="utf-8")
    encoder_weights = encoder / "model.safetensors"
    encoder_weights.write_bytes(b"encoder-weights")
    r3_root = sources / "r3"
    manifest = _write_completed_r3_source(
        r3_root, quality_gate_passed=quality_gate_passed
    )
    source = exporter.FontQuerySource(
        root=r3_root,
        kind="v7_mass21_r3_teacher_stable",
        schema_version=exporter.trainer_v7_r3.SCHEMA,
        manifest_name=exporter.trainer_v7.MANIFEST,
        manifest=manifest,
        checkpoint_path=r3_root / exporter.trainer_v7.BEST_HEAD,
        prototype_path=r3_root / exporter.trainer_v7.PROTOTYPES,
        prototypes=np.frombuffer(
            (r3_root / exporter.trainer_v7.PROTOTYPES).read_bytes(), dtype="<f4"
        ).reshape(
            len(exporter.ACTIVE_CANDIDATE_IDS),
            exporter.QUERY_COUNT,
            exporter.QUERY_DIM,
        ),
        candidate_ids=exporter.ACTIVE_CANDIDATE_IDS,
        fixture_only=False,
        quality_gate_passed=quality_gate_passed,
    )
    base = SimpleNamespace(
        active_catalog_path=active_catalog_path,
        candidate_bags=tuple(
            {"candidate_id": candidate_id, "count": 1, "start": index}
            for index, candidate_id in enumerate(base_export.EXPECTED_CANDIDATE_IDS)
        ),
        candidate_ids=base_export.EXPECTED_CANDIDATE_IDS,
        checkpoint_path=base_checkpoint,
        contract={
            "inputs": {
                "catalog_registry_sha256": "c" * 64,
                "human_export_manifest_sha256": "d" * 64,
            }
        },
        encoder_source_dir=encoder,
        encoder_source_weights=encoder_weights,
        student_root=student,
    )
    candidate_bags = tuple(
        {"candidate_id": candidate_id, "count": 1, "start": index}
        for index, candidate_id in enumerate(exporter.ACTIVE_CANDIDATE_IDS)
    )
    packed = np.zeros(
        (len(exporter.ACTIVE_CANDIDATE_IDS), exporter.FEATURE_DIM), dtype="<f4"
    )
    return exporter.V7RuntimeAuthority(
        base=base,
        source=source,
        candidate_ids=exporter.ACTIVE_CANDIDATE_IDS,
        candidate_bags=candidate_bags,
        active_catalog=exporter._project_active_catalog(_full22_catalog()),  # noqa: SLF001
        packed_prototypes=packed,
    )


def _valid_parity_record() -> dict[str, object]:
    metrics = {
        "body_alias_max_abs_error": 0.0,
        "candidate_top1_agreement": 1.0,
        "encoder_max_abs_error": 0.0,
        "encoder_minimum_cosine_similarity": 1.0,
        "none_decision_agreement": 1.0,
        "ranker_max_abs_error": 0.0,
        "role_top1_agreement": 1.0,
        "variant_alias_max_abs_error": 0.0,
        "variant_top1_agreement": 1.0,
    }
    return {
        "cpu": {
            "evidence": {"execution_provider": "CPUExecutionProvider"},
            "metrics": metrics,
        },
        "opset": exporter.OPSET_VERSION,
        "sample_count": exporter.MIN_PARITY_SAMPLES,
        "sample_source": "deterministic_synthetic_only",
        "seed": 17,
        "test_or_fresh_or_library_qa_rows_used": 0,
        "wasm": {
            "evidence": {
                "all_outputs_finite": True,
                "host": "electron-main",
                "package": runtime.TARGET_ORT_PACKAGE,
                "version": runtime.TARGET_ORT_VERSION,
            },
            "metrics": metrics,
        },
    }


class V7Active21CatalogTests(unittest.TestCase):
    def test_active_order_removes_only_gugi(self) -> None:
        self.assertEqual(len(exporter.ACTIVE_CANDIDATE_IDS), 21)
        self.assertNotIn("gugi", exporter.ACTIVE_CANDIDATE_IDS)
        self.assertEqual(
            exporter.ACTIVE_CANDIDATE_IDS,
            tuple(
                candidate_id
                for candidate_id in base_export.EXPECTED_CANDIDATE_IDS
                if candidate_id != "gugi"
            ),
        )

    def test_projects_full22_catalog_to_sealed_active21(self) -> None:
        projected = exporter._project_active_catalog(_full22_catalog())  # noqa: SLF001
        normalized = runtime.validate_active_catalog_record(
            projected, location="test active21"
        )
        self.assertEqual(normalized["candidate_ids"], exporter.ACTIVE_CANDIDATE_IDS)
        self.assertEqual(normalized["catalog_version"], exporter.ACTIVE_CATALOG_VERSION)
        self.assertEqual(
            [row["candidate_id"] for row in normalized["excluded_candidates"]],
            ["gugi"],
        )
        self.assertEqual(
            normalized["excluded_candidates"][0]["disposition"]["action"],
            "deleted_safe_zero",
        )

    def test_packs_every_legacy_bag_but_no_gugi_rows(self) -> None:
        source_ids = base_export.EXPECTED_CANDIDATE_IDS
        bags = tuple(
            {"candidate_id": candidate_id, "start": index * 2, "count": 2}
            for index, candidate_id in enumerate(source_ids)
        )
        legacy = np.arange(44 * exporter.LEGACY_FEATURE_DIM, dtype=np.float32).reshape(
            44, exporter.LEGACY_FEATURE_DIM
        )
        queries = np.zeros((21, exporter.QUERY_COUNT, exporter.QUERY_DIM), dtype=np.float32)
        queries[:, :, 0] = 1.0

        packed, projected_bags = exporter._pack_active21_prototypes(  # noqa: SLF001
            legacy_prototypes=legacy,
            source_candidate_ids=source_ids,
            source_bags=bags,
            query_prototypes=queries,
        )

        keep_rows = np.concatenate(
            [
                np.arange(index * 2, index * 2 + 2)
                for index, candidate_id in enumerate(source_ids)
                if candidate_id != "gugi"
            ]
        )
        self.assertEqual(packed.shape, (42, exporter.FEATURE_DIM))
        np.testing.assert_array_equal(
            packed[:, : exporter.LEGACY_FEATURE_DIM], legacy[keep_rows]
        )
        self.assertEqual(len(projected_bags), 21)
        self.assertEqual(projected_bags[-1]["start"], 40)
        self.assertTrue(
            np.all(
                packed[:, exporter.LEGACY_FEATURE_DIM :]
                .reshape(42, exporter.QUERY_COUNT, exporter.QUERY_DIM)[:, :, 0]
                == 1.0
            )
        )


class V7SharedPixelRankerTests(unittest.TestCase):
    def _ranker(self):  # type: ignore[no-untyped-def]
        import torch

        class Vision(torch.nn.Module):
            def forward(self, pixel_values, return_dict=False):  # type: ignore[no-untyped-def]
                batch = pixel_values.shape[0]
                return (
                    torch.zeros((batch, 196, 768)),
                    torch.ones((batch, exporter.LEGACY_FEATURE_DIM)),
                )

        class Head(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.query_weight_logits = torch.nn.Parameter(torch.zeros(4))
                self.logit_scale = torch.nn.Parameter(torch.tensor(0.0))

            def encode(self, tokens):  # type: ignore[no-untyped-def]
                values = torch.zeros((tokens.shape[0], 4, 256))
                values[:, :, 0] = 1.0
                return values, torch.zeros((tokens.shape[0], 4, 196))

        authority = SimpleNamespace(
            candidate_ids=exporter.ACTIVE_CANDIDATE_IDS,
            candidate_bags=tuple(
                {"candidate_id": candidate_id, "start": index, "count": 1}
                for index, candidate_id in enumerate(exporter.ACTIVE_CANDIDATE_IDS)
            ),
        )
        legacy_student = SimpleNamespace(
            vision_encoder=Vision(), projection=torch.nn.Identity()
        )
        return exporter._make_wrappers(  # noqa: SLF001
            authority=authority,
            legacy_student=legacy_student,
            vision=Vision(),
            head=Head(),
        )[1]

    def test_candidate_body_and_variant_are_exact_shared_pixel_scores(self) -> None:
        import torch

        ranker = self._ranker()
        views = torch.zeros((2, 3, exporter.FEATURE_DIM))
        query_views = views[:, :, exporter.LEGACY_FEATURE_DIM :].reshape(
            2, 3, exporter.QUERY_COUNT, exporter.QUERY_DIM
        )
        query_views[0, :, :, 0] = 1.0
        query_views[1, :, :, 1] = 1.0
        prototypes = torch.zeros((21, exporter.FEATURE_DIM))
        query_prototypes = prototypes[:, exporter.LEGACY_FEATURE_DIM :].reshape(
            21, exporter.QUERY_COUNT, exporter.QUERY_DIM
        )
        for index in range(21):
            query_prototypes[index, :, index] = 1.0
        outputs = dict(
            zip(exporter.RANKER_OUTPUT_NAMES, ranker(views, prototypes), strict=True)
        )
        torch.testing.assert_close(
            outputs["candidate_scores"], outputs["body_candidate_scores"]
        )
        torch.testing.assert_close(
            outputs["candidate_scores"], outputs["variant_candidate_scores"]
        )
        self.assertEqual(outputs["candidate_scores"].argmax(dim=1).tolist(), [0, 1])
        self.assertTrue(bool(torch.all(outputs["role_logits"] == 0)))
        self.assertTrue(bool(torch.all(outputs["style_logits"] == 0)))
        self.assertTrue(bool(torch.all(outputs["none_logits"] == -20)))

    def test_legacy_prefix_cannot_change_font_family_scores(self) -> None:
        import torch

        ranker = self._ranker()
        views = torch.zeros((1, 3, exporter.FEATURE_DIM))
        views[:, :, exporter.LEGACY_FEATURE_DIM] = 1.0
        prototypes = torch.zeros((21, exporter.FEATURE_DIM))
        prototypes[:, exporter.LEGACY_FEATURE_DIM] = 1.0
        baseline = ranker(views, prototypes)[0]
        changed = views.clone()
        changed[:, :, : exporter.LEGACY_FEATURE_DIM] = torch.randn(
            (1, 3, exporter.LEGACY_FEATURE_DIM)
        ) * 1_000_000
        torch.testing.assert_close(baseline, ranker(changed, prototypes)[0])

    def test_parity_rejects_any_variant_alias_drift(self) -> None:
        encoder = np.ones((2, exporter.FEATURE_DIM), dtype=np.float32)
        encoder /= np.linalg.norm(encoder, axis=1, keepdims=True)
        outputs = _minimal_outputs()
        actual = copy.deepcopy(outputs)
        actual["variant_candidate_scores"][0, 0] += 1.0
        with self.assertRaisesRegex(
            exporter.MangaFontV7RuntimeExportError, "aliases drifted"
        ):
            exporter._parity_metrics(  # noqa: SLF001
                reference_encoder=encoder,
                actual_encoder=encoder.copy(),
                reference_ranker=outputs,
                actual_ranker=actual,
            )


class V7RuntimeContractTests(unittest.TestCase):
    def _build_fixture_runtime(
        self,
        *,
        authority: exporter.V7RuntimeAuthority,
        output: Path,
    ) -> dict[str, object]:
        expected_io = exporter._io_contract(authority)  # noqa: SLF001

        def fake_export(**kwargs: object) -> None:
            Path(kwargs["encoder_path"]).write_bytes(b"fixture-encoder-onnx")
            Path(kwargs["ranker_path"]).write_bytes(b"fixture-ranker-onnx")

        def fake_io(path: Path) -> object:
            return expected_io[path.name]

        patchers = (
            mock.patch.object(
                exporter, "load_v7_runtime_authority", return_value=authority
            ),
            mock.patch.object(
                exporter,
                "_load_models",
                return_value=(SimpleNamespace(), SimpleNamespace(), SimpleNamespace()),
            ),
            mock.patch.object(
                exporter, "_make_wrappers", return_value=(object(), object())
            ),
            mock.patch.object(exporter, "_export_graphs", side_effect=fake_export),
            mock.patch.object(exporter, "_run_parity", return_value=_valid_parity_record()),
            mock.patch.object(
                exporter.legacy_export, "_inspect_graph_file", return_value={}
            ),
            mock.patch.object(runtime, "_inspect_onnx_contract", side_effect=fake_io),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        return dict(
            exporter.build_runtime_output(
                student_output=authority.base.student_root,
                active_catalog_path=authority.base.active_catalog_path,
                encoder_source_dir=authority.base.encoder_source_dir,
                v7_output_dir=authority.source.root,
                allow_r3_fixture_source=False,
                output_dir=output,
                electron_path=output.parent / "electron.exe",
                parity_samples=exporter.MIN_PARITY_SAMPLES,
                parity_seed=17,
                wasm_timeout_seconds=30,
                replace_owned_output=False,
            )
        )

    def test_loader_accepts_completed_teacher_stable_r3_as_nonfixture(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "r3"
            manifest = _write_completed_r3_source(
                root, quality_gate_passed=True
            )
            with mock.patch.object(
                exporter.trainer_v7_r3,
                "validate_output",
                return_value={
                    "best_epoch": 0,
                    "candidate_count": len(exporter.ACTIVE_CANDIDATE_IDS),
                    "status": "validated_v7_mass21_r3_teacher_stable_output",
                },
            ) as validator:
                source = exporter._load_fontquery_source(  # noqa: SLF001
                    root, allow_r3_fixture_source=False
                )

        validator.assert_called_once_with(root.resolve())
        self.assertEqual(source.kind, "v7_mass21_r3_teacher_stable")
        self.assertEqual(source.schema_version, exporter.trainer_v7_r3.SCHEMA)
        self.assertFalse(source.fixture_only)
        self.assertTrue(source.quality_gate_passed)
        self.assertEqual(source.manifest["record_sha256"], manifest["record_sha256"])
        self.assertEqual(source.candidate_ids, exporter.ACTIVE_CANDIDATE_IDS)
        self.assertNotIn(exporter.mass21.RETIRED_FONT_ID, source.candidate_ids)
        self.assertEqual(
            source.prototypes.shape,
            (
                len(exporter.ACTIVE_CANDIDATE_IDS),
                exporter.QUERY_COUNT,
                exporter.QUERY_DIM,
            ),
        )

    def test_loader_rejects_r3_source_code_sha_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "r3"
            manifest = _write_completed_r3_source(
                root, quality_gate_passed=True
            )
            manifest["source_code_sha256"] = "0" * 64
            manifest.pop("record_sha256")
            manifest = runtime.seal_record(manifest)
            (root / exporter.trainer_v7.MANIFEST).write_bytes(
                runtime.json_bytes(manifest, pretty=True)
            )
            with (
                mock.patch.object(
                    exporter.trainer_v7_r3,
                    "validate_output",
                    return_value={
                        "best_epoch": 0,
                        "candidate_count": len(exporter.ACTIVE_CANDIDATE_IDS),
                        "status": "validated_v7_mass21_r3_teacher_stable_output",
                    },
                ),
                self.assertRaisesRegex(
                    exporter.MangaFontV7RuntimeExportError,
                    "marker/schema/source binding",
                ),
            ):
                exporter._load_fontquery_source(  # noqa: SLF001
                    root, allow_r3_fixture_source=False
                )

    def test_r3_preflight_remains_nonfixture_and_requires_calibration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            authority = _runtime_authority_fixture(
                root, quality_gate_passed=True
            )
            electron = root / "tools" / "electron.exe"
            wasm = root / "tools" / "wasm-helper.cjs"
            runtime_asset = root / "tools" / "runtime.js"
            electron.parent.mkdir(parents=True)
            for path in (electron, wasm, runtime_asset):
                path.write_bytes(b"fixture")
            with (
                mock.patch.object(
                    exporter, "load_v7_runtime_authority", return_value=authority
                ),
                mock.patch.object(
                    exporter.legacy_export, "_require_onnx_export_dependency"
                ),
                mock.patch.object(exporter.legacy_export, "WASM_HELPER", wasm),
                mock.patch.object(
                    exporter.legacy_export,
                    "_runtime_asset_paths",
                    return_value={"runtime": runtime_asset},
                ),
                mock.patch.object(
                    exporter.legacy_export,
                    "_pinned_electron_version",
                    return_value="fixture-electron",
                ),
                mock.patch.dict(
                    sys.modules,
                    {
                        "onnxruntime": SimpleNamespace(__version__="fixture-ort"),
                        "torch": SimpleNamespace(__version__="fixture-torch"),
                        "transformers": SimpleNamespace(
                            __version__="fixture-transformers"
                        ),
                    },
                ),
            ):
                result = exporter.preflight(
                    student_output=authority.base.student_root,
                    active_catalog_path=authority.base.active_catalog_path,
                    encoder_source_dir=authority.base.encoder_source_dir,
                    v7_output_dir=authority.source.root,
                    allow_r3_fixture_source=False,
                    electron_path=electron,
                )

        self.assertEqual(
            result["fontquery_source_kind"], "v7_mass21_r3_teacher_stable"
        )
        self.assertFalse(result["fixture_only"])
        self.assertTrue(result["quality_gate_passed"])
        self.assertFalse(result["qa_only"])
        self.assertTrue(result["selection_calibration_required"])

    def test_r3_build_and_validate_keep_attach_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            authority = _runtime_authority_fixture(
                root, quality_gate_passed=True
            )
            output = root / "publish" / "runtime"
            result = self._build_fixture_runtime(
                authority=authority, output=output
            )
            validated = exporter.validate_runtime_output(
                student_output=authority.base.student_root,
                active_catalog_path=authority.base.active_catalog_path,
                encoder_source_dir=authority.base.encoder_source_dir,
                v7_output_dir=authority.source.root,
                allow_r3_fixture_source=False,
                output_dir=output,
                inspect_onnx=False,
            )
            marker = attach_calibration._validate_marker(  # noqa: SLF001
                output,
                expected_asset_files=sorted(
                    exporter.OUTPUT_FILES
                    - {exporter.MARKER_FILE, exporter.CONTRACT_FILE}
                ),
                location="R3 runtime fixture",
            )

        self.assertFalse(result["fixture_only"])
        self.assertFalse(result["qa_only"])
        self.assertTrue(result["selection_calibration_required"])
        self.assertEqual(validated["contract_sha256"], result["contract_sha256"])
        self.assertNotIn("qa_only", marker)

    def test_failed_r3_quality_gate_is_not_fixture_but_attach_refuses_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            authority = _runtime_authority_fixture(
                root, quality_gate_passed=False
            )
            output = root / "publish" / "runtime"
            result = self._build_fixture_runtime(
                authority=authority, output=output
            )
            contract = json.loads(
                (output / exporter.CONTRACT_FILE).read_text(encoding="utf-8")
            )
            with self.assertRaisesRegex(
                attach_calibration.SelectionCalibrationAttachError,
                "requires explicit validation permission",
            ):
                attach_calibration._validate_marker(  # noqa: SLF001
                    output,
                    expected_asset_files=sorted(
                        exporter.OUTPUT_FILES
                        - {exporter.MARKER_FILE, exporter.CONTRACT_FILE}
                    ),
                    location="failed-quality R3 runtime fixture",
                )

        self.assertFalse(result["fixture_only"])
        self.assertTrue(result["qa_only"])
        self.assertFalse(result["quality_gate_passed"])
        self.assertTrue(result["selection_calibration_required"])
        self.assertEqual(
            contract["release_evaluation"]["status"],
            "v7_active21_source_quality_gate_failed",
        )

    def test_loader_accepts_sealed_round2_training_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / exporter.trainer_v7_r2.MARKER).write_text(
                "{}\n", encoding="utf-8"
            )
            prototypes = np.zeros(
                (21, exporter.QUERY_COUNT, exporter.QUERY_DIM), dtype="<f4"
            )
            for index in range(21):
                prototypes[index, :, index] = 1.0
            prototypes.tofile(root / exporter.trainer_v7.PROTOTYPES)
            (root / exporter.trainer_v7.BEST_HEAD).write_bytes(b"r2-head")
            (root / exporter.trainer_v7.MANIFEST).write_text(
                json.dumps(
                    {
                        "architecture": {
                            "candidate_bias": False,
                            "encoder_trainable_blocks": 0,
                            "query_count": exporter.QUERY_COUNT,
                            "query_dim": exporter.QUERY_DIM,
                        },
                        "candidate_ids": list(exporter.ACTIVE_CANDIDATE_IDS),
                        "quality_gate": {"passed": True},
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                exporter.trainer_v7_r2, "validate_output", return_value={}
            ):
                source = exporter._load_fontquery_source(  # noqa: SLF001
                    root, allow_r3_fixture_source=False
                )

        self.assertEqual(source.kind, "v7_mass21_r2")
        self.assertEqual(source.schema_version, exporter.trainer_v7_r2.SCHEMA)
        self.assertFalse(source.fixture_only)
        self.assertTrue(source.quality_gate_passed)
        self.assertEqual(source.candidate_ids, exporter.ACTIVE_CANDIDATE_IDS)

    def test_io_reuses_hybrid_shape_with_exact_active21_scores(self) -> None:
        authority = SimpleNamespace(
            candidate_ids=exporter.ACTIVE_CANDIDATE_IDS,
            packed_prototypes=np.zeros((336, exporter.FEATURE_DIM), dtype=np.float32),
        )
        contract = exporter._io_contract(authority)  # noqa: SLF001
        self.assertEqual(
            contract[exporter.ENCODER_FILE]["outputs"][0]["shape"], [None, 1280]
        )
        score_outputs = contract[exporter.RANKER_FILE]["outputs"][:3]
        self.assertEqual(
            [row["name"] for row in score_outputs],
            [
                "candidate_scores",
                "body_candidate_scores",
                "variant_candidate_scores",
            ],
        )
        self.assertTrue(all(row["shape"] == [None, 21] for row in score_outputs))

    def test_family_contract_forbids_gemma_genre_and_role_logits(self) -> None:
        evidence = exporter._font_family_evidence_contract()  # noqa: SLF001
        self.assertEqual(
            evidence["forbidden_family_logit_inputs"], ["gemma", "genre", "role"]
        )
        self.assertTrue(evidence["body_and_variant_share_exact_scores"])
        self.assertEqual(
            evidence["role_policy_stage"],
            "downstream_page_consistency_and_emphasis_only",
        )

    def test_cli_requires_explicit_r3_fixture_opt_in(self) -> None:
        args = exporter.build_parser().parse_args(
            [
                "preflight",
                "--student-output",
                "student",
                "--active-catalog",
                "catalog",
                "--encoder-source-dir",
                "encoder",
                "--v7-output-dir",
                "v7",
            ]
        )
        self.assertFalse(args.allow_r3_fixture_source)
        fixture = exporter.build_parser().parse_args(
            [
                "preflight",
                "--student-output",
                "student",
                "--active-catalog",
                "catalog",
                "--encoder-source-dir",
                "encoder",
                "--v7-output-dir",
                "r3",
                "--allow-r3-fixture-source",
            ]
        )
        self.assertTrue(fixture.allow_r3_fixture_source)


def _minimal_outputs() -> dict[str, np.ndarray]:
    scores = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    output = {
        "candidate_scores": scores.copy(),
        "body_candidate_scores": scores.copy(),
        "variant_candidate_scores": scores.copy(),
        "none_logits": np.full(2, -20.0, dtype=np.float32),
        "role_logits": np.zeros((2, len(exporter.trainer.ROLE_VALUES)), dtype=np.float32),
        "style_logits": np.zeros((2, len(exporter.trainer.STYLE_FIELDS)), dtype=np.float32),
        "view_gate_weights": np.full((2, 3), 1 / 3, dtype=np.float32),
    }
    for field, values in exporter.trainer.TREATMENT_VALUES.items():
        output[f"treatment_{field}_logits"] = np.zeros(
            (2, len(values)), dtype=np.float32
        )
    return output


if __name__ == "__main__":
    unittest.main()
