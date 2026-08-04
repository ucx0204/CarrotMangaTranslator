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
from typing import Any, Mapping
from unittest import mock

import numpy as np
from safetensors.numpy import save_file


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_runtime_artifact.py"
SPEC = importlib.util.spec_from_file_location(
    "build_font_matching_runtime_artifact_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
RUNTIME = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNTIME
SPEC.loader.exec_module(RUNTIME)


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(RUNTIME.json_bytes(value, pretty=True))


def digest(path: Path) -> str:
    return RUNTIME.sha256_file(path)


def parity_metrics() -> dict[str, Any]:
    return {
        "encoder": {
            "max_abs_error": 0.00001,
            "minimum_cosine_similarity": 0.99999,
        },
        "frozen_test_pixels_opened": 0,
        "frozen_test_rows_used": 0,
        "ranker": {
            "candidate_top1_agreement": 1.0,
            "max_abs_error": 0.00001,
            "none_decision_agreement": 1.0,
            "role_top1_agreement": 1.0,
        },
        "sample_count": 40,
        "sample_source": "synthetic_plus_validation",
        "test_identifiers_embedded": False,
    }


def write_active_catalog_sources(root: Path) -> dict[str, Path]:
    asset_root = root / "repository"
    assets: dict[str, bytes] = {
        "font-a": b"font-a-bytes",
        "font-b": b"font-b-bytes",
    }
    families = []
    for candidate_id, payload in assets.items():
        asset_path = asset_root / "assets" / f"{candidate_id}.ttf"
        asset_path.parent.mkdir(parents=True, exist_ok=True)
        asset_path.write_bytes(payload)
        families.append(
            {
                "font_id": candidate_id,
                "faces": [
                    {
                        "byte_size": len(payload),
                        "face_id": f"{candidate_id}:1:test",
                        "file": f"assets/{candidate_id}.ttf",
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                ],
            }
        )
    manifest_path = root / "font-face-manifest.json"
    write_json(
        manifest_path,
        {
            "schema_version": "font-face-manifest-v1",
            "family_count": len(families),
            "face_count": len(families),
            "families": families,
        },
    )
    render_path = root / "render-bank-manifest.json"
    render_candidates = []
    renders = []
    for candidate_id in assets:
        display_id = f"{candidate_id}/face/normal"
        render_candidates.append(
            {
                "display_id": display_id,
                "face_id": f"{candidate_id}:1:test",
                "font_id": candidate_id,
            }
        )
        image_path = root / "images" / f"{candidate_id}.png"
        image_path.parent.mkdir(parents=True, exist_ok=True)
        image_bytes = f"render-{candidate_id}".encode("utf-8")
        image_path.write_bytes(image_bytes)
        renders.append(
            {
                "candidate_display_id": display_id,
                "artifact": {
                    "byte_size": len(image_bytes),
                    "file": f"images/{candidate_id}.png",
                    "sha256": hashlib.sha256(image_bytes).hexdigest(),
                },
            }
        )
    write_json(
        render_path,
        {
            "schema_version": "font-render-bank-v1",
            "source_contract": {"manifest_sha256": digest(manifest_path)},
            "family_count": len(assets),
            "face_count": len(assets),
            "candidate_count": len(render_candidates),
            "candidates": render_candidates,
            "generation": {
                "complete_against_production_assets": True,
                "partial": False,
                "rendered_count": len(renders),
            },
            "renders": renders,
        },
    )
    disposition_path = root / "catalog-disposition.json"
    disposition = RUNTIME.seal_record(
        {
            "candidate_count": 2,
            "entries": [
                {
                    "action": "retained_unique_p1",
                    "active_release_eligible": True,
                    "all_unrenderable": False,
                    "candidate_id": "font-b",
                    "deployable_opportunity_count": 4,
                    "safe_count": 2,
                    "terminal": True,
                },
                {
                    "action": "deleted_safe_zero",
                    "active_release_eligible": False,
                    "all_unrenderable": False,
                    "candidate_id": "font-c",
                    "deployable_opportunity_count": 4,
                    "safe_count": 0,
                    "terminal": True,
                },
            ],
            "final_release_allowed": True,
            "record_type": RUNTIME.CATALOG_DISPOSITION_RECORD_TYPE,
            "release_state": "final_released",
            "schema_version": RUNTIME.CATALOG_DISPOSITION_SCHEMA,
            "source_catalog_sha256": "9" * 64,
            "source_render_bank_sha256": "8" * 64,
            "workspace_contract_record_sha256": "a" * 64,
        }
    )
    write_json(disposition_path, disposition)
    final_catalog_path = root / "final-catalog.json"
    candidate_ids = ["font-a", "font-b"]
    final_catalog = RUNTIME.seal_record(
        {
            "candidate_count": len(candidate_ids),
            "candidate_ids": candidate_ids,
            "candidate_set_sha256": RUNTIME._candidate_set_sha256(candidate_ids),
            "catalog_disposition_record_sha256": disposition["record_sha256"],
            "catalog_version": "font-face-manifest-pruned-v5",
            "included_delta_candidate_count": 1,
            "included_delta_candidates": [{"candidate_id": "font-b"}],
            "prior_candidate_count": 1,
            "prior_candidate_ids": ["font-a"],
            "record_type": RUNTIME.FINAL_CATALOG_RECORD_TYPE,
            "removed_delta_candidate_count": 1,
            "removed_delta_candidates": [{"candidate_id": "font-c"}],
            "schema_version": RUNTIME.FINAL_CATALOG_SCHEMA,
            "source_catalog_sha256": "9" * 64,
            "workspace_contract_record_sha256": "a" * 64,
        }
    )
    write_json(final_catalog_path, final_catalog)
    return {
        "asset_root": asset_root,
        "disposition": disposition_path,
        "final_catalog": final_catalog_path,
        "font_manifest": manifest_path,
        "render_manifest": render_path,
        "output": root / RUNTIME.ACTIVE_CATALOG_FILE,
    }


class RuntimeFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.trainer = root / "trainer"
        self.output = root / "runtime"
        self.encoder = root / "inputs" / RUNTIME.ENCODER_FILE
        self.ranker = root / "inputs" / RUNTIME.RANKER_FILE
        self.prototype = root / "inputs" / RUNTIME.PROTOTYPE_FILE
        self.encoder_weights = root / "inputs" / "model.safetensors"
        self.parity = root / "inputs" / "parity.json"
        self.release = root / "inputs" / "release.json"
        self.policy = root / "inputs" / "policy.json"
        self.active_catalog = root / "inputs" / RUNTIME.ACTIVE_CATALOG_FILE
        self.candidate_ids = ("font-a", "font-b")
        self.font_catalog_sha = hashlib.sha256(b"fixture-font-catalog").hexdigest()
        self.render_bank_sha = hashlib.sha256(b"fixture-render-bank").hexdigest()
        self.frozen_test_manifest_sha = hashlib.sha256(
            b"fixture-frozen-test-manifest"
        ).hexdigest()
        self.feature_dim = 4
        self.hidden_dim = 3
        self.prototype_count = 3
        self._write_active_catalog()
        self._write_trainer()
        self._write_runtime_inputs()

    def _write_active_catalog(self) -> None:
        candidates = []
        for candidate_id in self.candidate_ids:
            payload = f"asset-{candidate_id}".encode("utf-8")
            candidates.append(
                {
                    "assets": [
                        {
                            "byte_size": len(payload),
                            "face_id": f"{candidate_id}:1:test",
                            "file": f"fonts/{candidate_id}.ttf",
                            "sha256": hashlib.sha256(payload).hexdigest(),
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
        record = RUNTIME.seal_record(
            {
                "candidate_count": len(self.candidate_ids),
                "candidate_ids": list(self.candidate_ids),
                "candidate_order_sha256": RUNTIME._ordered_values_sha256(
                    self.candidate_ids
                ),
                "candidates": candidates,
                "catalog_version": "fixture-active-v1",
                "excluded_candidates": [],
                "locale": "ko",
                "record_type": RUNTIME.ACTIVE_CATALOG_RECORD_TYPE,
                "schema_version": RUNTIME.ACTIVE_CATALOG_SCHEMA,
                "source_records": {
                    "catalog_disposition_record_sha256": "d" * 64,
                    "deployment_font_face_manifest_sha256": self.font_catalog_sha,
                    "deployment_render_bank_manifest_sha256": self.render_bank_sha,
                    "evidence_font_face_manifest_sha256": "1" * 64,
                    "evidence_render_bank_manifest_sha256": "2" * 64,
                    "final_catalog_record_sha256": "e" * 64,
                },
            }
        )
        write_json(self.active_catalog, record)

    def _state_shapes(self) -> dict[str, list[int]]:
        shapes = {
            "logit_scale": [],
            "none_head.bias": [1],
            "none_head.weight": [1, self.hidden_dim],
            "prototype_projection.0.bias": [self.feature_dim],
            "prototype_projection.0.weight": [self.feature_dim],
            "prototype_projection.1.weight": [self.hidden_dim, self.feature_dim],
            "role_head.bias": [len(RUNTIME.EXPECTED_ROLES)],
            "role_head.weight": [len(RUNTIME.EXPECTED_ROLES), self.hidden_dim],
            "sample_projection.0.bias": [self.hidden_dim],
            "sample_projection.0.weight": [self.hidden_dim, self.feature_dim * 4],
            "sample_projection.3.bias": [self.hidden_dim],
            "sample_projection.3.weight": [self.hidden_dim],
            "style_head.bias": [len(RUNTIME.EXPECTED_STYLE_FIELDS)],
            "style_head.weight": [len(RUNTIME.EXPECTED_STYLE_FIELDS), self.hidden_dim],
            "view_gate.bias": [1],
            "view_gate.weight": [1, self.feature_dim],
            "view_norm.bias": [self.feature_dim],
            "view_norm.weight": [self.feature_dim],
        }
        for field, values in RUNTIME.EXPECTED_TREATMENTS.items():
            shapes[f"treatment_heads.{field}.bias"] = [len(values)]
            shapes[f"treatment_heads.{field}.weight"] = [
                len(values),
                self.hidden_dim,
            ]
        return shapes

    def _write_trainer(self) -> None:
        self.trainer.mkdir(parents=True)
        metadata = {
            "encoder": "google/siglip2-base-patch16-224",
            "encoder_revision": "7" * 40,
            "font_signal_audit_ledger_sha256": "1" * 64,
            "font_signal_audit_report_sha256": "2" * 64,
            "format": RUNTIME.TRAINER_SCHEMA_VERSION,
        }
        arrays = {
            name: np.zeros(shape, dtype=np.float32)
            for name, shape in self._state_shapes().items()
        }
        checkpoint_path = self.trainer / "checkpoint.safetensors"
        save_file(arrays, checkpoint_path, metadata=metadata)
        state_contract = [
            {"dtype": "float32", "name": name, "shape": shape}
            for name, shape in sorted(self._state_shapes().items())
        ]
        inputs = {
            key: hashlib.sha256(key.encode("utf-8")).hexdigest()
            for key in (
                "catalog_registry_sha256",
                "font_catalog_sha256",
                "font_prototypes_sha256",
                "frozen_test_manifest_sha256",
                "listwise_sha256",
                "pairwise_sha256",
                "render_bank_manifest_sha256",
                "render_specification_sha256",
                "retrieval_sha256",
                "samples_sha256",
                "training_export_manifest_sha256",
            )
        }
        inputs["frozen_test_manifest_sha256"] = self.frozen_test_manifest_sha
        inputs["font_catalog_sha256"] = self.font_catalog_sha
        inputs["render_bank_manifest_sha256"] = self.render_bank_sha
        contract = RUNTIME.seal_record(
            {
                "architecture": {
                    "candidate_scoring": RUNTIME.EXPECTED_CANDIDATE_SCORING,
                    "feature_dim": self.feature_dim,
                    "hidden_dim": self.hidden_dim,
                    "semantic_heads": {},
                    "view_dropout": 0.15,
                },
                "calibration": {
                    "calibration_split": "val",
                    "none_threshold": 0.2,
                    "none_threshold_selection_metric": "val_none_f1_then_accuracy",
                    "temperature": 0.75,
                    "temperature_selection_metric": "val_listwise_cross_entropy",
                },
                "checkpoint": {
                    "file": "checkpoint.safetensors",
                    "metadata": metadata,
                    "sha256": digest(checkpoint_path),
                    "state_contract": state_contract,
                },
                "code_sha256": "a" * 64,
                "encoder": {
                    "class": "SiglipVisionModel",
                    "fully_frozen": True,
                    "model_id": "google/siglip2-base-patch16-224",
                    "optimizer_parameter_overlap": 0,
                    "revision": "7" * 40,
                    "use_fast": False,
                },
                "inputs": inputs,
                "ordinary_regression_safety": {
                    "baseline_status": "production_same_input_resume_reference",
                    "best_ordinary_regression_gate": {"passed": True},
                    "optimizer_seeded_from_ordinary_reference": False,
                    "ordinary_reference_argument_seeded_optimizer": False,
                },
                "preprocessing": {
                    "input_mode": "RGB",
                    "input_size_px": [224, 224],
                    "processor": {
                        "class": "AutoImageProcessor",
                        "do_resize": False,
                        "use_fast": False,
                    },
                },
                "record_type": "font_matching_siglip_model_contract",
                "schema_version": RUNTIME.MODEL_CONTRACT_SCHEMA,
                "vocabulary": {
                    "candidate_ids": list(self.candidate_ids),
                    "candidate_parameterization": (
                        "prototype-bag-only-no-id-embedding-or-bias"
                    ),
                    "roles": list(RUNTIME.EXPECTED_ROLES),
                    "style_fields": list(RUNTIME.EXPECTED_STYLE_FIELDS),
                    "treatments": {
                        key: list(values)
                        for key, values in RUNTIME.EXPECTED_TREATMENTS.items()
                    },
                },
            }
        )
        contract_path = self.trainer / "model-contract.json"
        write_json(contract_path, contract)
        predictions_path = self.trainer / "predictions-val.jsonl"
        predictions_path.write_text("", encoding="utf-8")
        report = RUNTIME.seal_record(
            {
                "checks": {
                    "candidate_id_classifier_parameters": 0,
                    "chapter_pair_test_rows_used": 0,
                    "encoder_fully_frozen": True,
                    "prediction_semantics_from_model_heads": True,
                    "synthetic_or_qa_inputs": 0,
                    "test_pixels_opened_or_cached": 0,
                    "test_rows_used_for_optimizer_calibration_prototypes_or_hard_negatives": 0,
                    "train_split_used_for_optimizer": True,
                    "val_split_used_for_calibration_and_early_stop": True,
                },
                "model_contract_sha256": digest(contract_path),
                "record_type": "font_matching_siglip_training_report",
                "schema_version": RUNTIME.TRAINING_REPORT_SCHEMA,
            }
        )
        report_path = self.trainer / "report.json"
        write_json(report_path, report)
        marker = {
            "artifacts": {
                "checkpoint.safetensors": digest(checkpoint_path),
                "model-contract.json": digest(contract_path),
                "predictions-val.jsonl": digest(predictions_path),
                "report.json": digest(report_path),
            },
            "owner": RUNTIME.TRAINER_OWNER,
            "safe_replace": True,
            "schema_version": RUNTIME.TRAINER_SCHEMA_VERSION,
        }
        write_json(self.trainer / RUNTIME.TRAINER_MARKER, marker)

    def _write_runtime_inputs(self) -> None:
        self.encoder.parent.mkdir(parents=True, exist_ok=True)
        self.encoder.write_bytes(b"encoder-onnx-fixture")
        self.ranker.write_bytes(b"ranker-onnx-fixture")
        self.encoder_weights.write_bytes(b"encoder-source-weights")
        prototype = np.arange(self.prototype_count * self.feature_dim, dtype="<f4")
        self.prototype.write_bytes(prototype.tobytes())
        training_contract_path = self.trainer / "model-contract.json"
        checkpoint_path = self.trainer / "checkpoint.safetensors"
        training_contract = json.loads(
            training_contract_path.read_text(encoding="utf-8")
        )
        self.bags = [
            {"candidate_id": "font-a", "count": 2, "start": 0},
            {"candidate_id": "font-b", "count": 1, "start": 2},
        ]
        self.io_contract = RUNTIME._expected_onnx_io(
            contract=training_contract,
            prototype_count=self.prototype_count,
            candidate_count=len(self.candidate_ids),
        )
        parity = RUNTIME.seal_record(
            {
                "artifacts": {
                    "encoder_onnx_sha256": digest(self.encoder),
                    "prototype_features_sha256": digest(self.prototype),
                    "ranker_onnx_sha256": digest(self.ranker),
                },
                "candidate_bags": self.bags,
                "candidate_ids": list(self.candidate_ids),
                "candidate_ids_sha256": RUNTIME._ordered_values_sha256(
                    self.candidate_ids
                ),
                "io_contract": self.io_contract,
                "record_type": RUNTIME.PARITY_RECORD_TYPE,
                "reference_parity": parity_metrics(),
                "schema_version": RUNTIME.PARITY_SCHEMA,
                "source": {
                    "checkpoint_sha256": digest(checkpoint_path),
                    "encoder_model_id": "google/siglip2-base-patch16-224",
                    "encoder_revision": "7" * 40,
                    "encoder_source_weights_sha256": digest(self.encoder_weights),
                    "model_contract_sha256": digest(training_contract_path),
                },
                "target_runtime": {
                    "all_outputs_finite": True,
                    "execution_provider": RUNTIME.TARGET_ORT_PROVIDER,
                    "io_contract_passed": True,
                    "package": RUNTIME.TARGET_ORT_PACKAGE,
                    "parity": parity_metrics(),
                    "smoke_case_count": 40,
                    "version": RUNTIME.TARGET_ORT_VERSION,
                },
            }
        )
        write_json(self.parity, parity)
        metrics = {key: 0.9 for key in RUNTIME.RELEASE_METRICS}
        thresholds = {key: 0.8 for key in RUNTIME.RELEASE_METRICS}
        release = RUNTIME.seal_record(
            {
                "gate": {"failed_checks": [], "passed": True},
                "metrics": metrics,
                "record_type": RUNTIME.RELEASE_RECORD_TYPE,
                "schema_version": RUNTIME.RELEASE_SCHEMA,
                "source": {
                    "candidate_ids_sha256": RUNTIME._ordered_values_sha256(
                        self.candidate_ids
                    ),
                    "checkpoint_sha256": digest(checkpoint_path),
                    "frozen_test_manifest_sha256": self.frozen_test_manifest_sha,
                    "model_contract_sha256": digest(training_contract_path),
                },
                "test_data_boundary": {
                    "evaluated_row_count": 80,
                    "frozen_before_training": True,
                    "pixels_opened_by_runtime_exporter": 0,
                    "row_level_predictions_embedded": False,
                    "rows_used_for_optimizer_calibration_prototypes_or_hard_negatives": 0,
                    "sample_identifiers_embedded": False,
                    "split": "frozen_test",
                    "test_manifest_sha256": self.frozen_test_manifest_sha,
                    "work_disjoint": True,
                },
                "thresholds": thresholds,
            }
        )
        write_json(self.release, release)
        policy = RUNTIME.seal_record(
            {
                "automatic_mutation": {
                    "intentional_override_minimum_score_margin": 0.1,
                    "minimum_calibrated_confidence": 0.86,
                    "minimum_intentional_override_confidence": 0.86,
                    "minimum_role_confidence": 0.82,
                    "require_none_acceptable_false": True,
                    "require_runtime_artifact_ready": True,
                    "require_translation_glyph_coverage": True,
                },
                "chapter_prior": {
                    "local_override_minimum_score_margin": 0.1,
                    "maximum_score_contribution": 0.08,
                    "minimum_anchor_evidence_count": 20,
                    "mode": "weak_prior_never_hard_constraint",
                    "real_local_change_overrides_prior": True,
                    "scope": "chapter",
                },
                "fallback": {
                    "automatic_profile_without_pixel_model": "forbidden",
                    "invalid_artifact": "explicit_disabled",
                    "manual_user_lock": "allowed",
                    "missing_artifact": "explicit_disabled",
                    "semantic_bootstrap": "forbidden",
                },
                "record_type": RUNTIME.POLICY_RECORD_TYPE,
                "schema_version": RUNTIME.POLICY_SCHEMA,
            }
        )
        write_json(self.policy, policy)

    def build(self) -> Mapping[str, Any]:
        with mock.patch.object(
            RUNTIME,
            "_inspect_onnx_contract",
            side_effect=lambda path: self.io_contract[path.name],
        ):
            return RUNTIME._build_runtime_artifact(
                active_catalog_path=self.active_catalog,
                trainer_output=self.trainer,
                encoder_onnx=self.encoder,
                ranker_onnx=self.ranker,
                prototype_features=self.prototype,
                encoder_source_weights=self.encoder_weights,
                conversion_report=self.parity,
                release_evaluation=self.release,
                policy_path=self.policy,
                output_dir=self.output,
            )

    def reseal(self, path: Path, mutation: Any) -> None:
        value = json.loads(path.read_text(encoding="utf-8"))
        value.pop("record_sha256", None)
        mutation(value)
        write_json(path, RUNTIME.seal_record(value))


class RuntimeArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = RuntimeFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def build_active_catalog(self, sources: Mapping[str, Path]) -> Mapping[str, Any]:
        return RUNTIME.build_active_catalog(
            final_catalog_path=sources["final_catalog"],
            catalog_disposition_path=sources["disposition"],
            deployment_font_face_manifest_path=sources["font_manifest"],
            deployment_render_bank_manifest_path=sources["render_manifest"],
            asset_root=sources["asset_root"],
            output_path=sources["output"],
        )

    def test_builds_terminal_active_catalog_and_keeps_deleted_font_as_evidence(
        self,
    ) -> None:
        sources = write_active_catalog_sources(self.fixture.root / "active-sources")
        result = self.build_active_catalog(sources)
        record = RUNTIME.load_active_catalog(sources["output"])

        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(record["candidate_ids"], ("font-a", "font-b"))
        self.assertEqual(
            [entry["candidate_id"] for entry in record["excluded_candidates"]],
            ["font-c"],
        )
        self.assertEqual(
            record["excluded_candidates"][0]["disposition"]["action"],
            "deleted_safe_zero",
        )
        self.assertEqual(record["excluded_candidates"][0]["assets"], [])
        self.assertFalse(
            (sources["asset_root"] / "assets" / "font-c.ttf").exists()
        )
        self.assertNotEqual(
            record["source_records"]["evidence_font_face_manifest_sha256"],
            record["source_records"]["deployment_font_face_manifest_sha256"],
        )

    def test_explicit_deployment_order_preserves_model_tensor_alignment(self) -> None:
        sources = write_active_catalog_sources(self.fixture.root / "active-order")
        RUNTIME.build_active_catalog(
            final_catalog_path=sources["final_catalog"],
            catalog_disposition_path=sources["disposition"],
            deployment_font_face_manifest_path=sources["font_manifest"],
            deployment_render_bank_manifest_path=sources["render_manifest"],
            asset_root=sources["asset_root"],
            output_path=sources["output"],
            deployment_candidate_order=("font-b", "font-a"),
        )
        record = RUNTIME.load_active_catalog(sources["output"])
        final_catalog = json.loads(
            sources["final_catalog"].read_text(encoding="utf-8")
        )

        self.assertEqual(final_catalog["candidate_ids"], ["font-a", "font-b"])
        self.assertEqual(record["candidate_ids"], ("font-b", "font-a"))
        self.assertEqual(
            [candidate["candidate_id"] for candidate in record["candidates"]],
            ["font-b", "font-a"],
        )

    def test_explicit_deployment_order_must_be_exact_catalog_permutation(self) -> None:
        sources = write_active_catalog_sources(self.fixture.root / "bad-active-order")
        with self.assertRaisesRegex(
            RUNTIME.RuntimeArtifactError, "exact final-catalog permutation"
        ):
            RUNTIME.build_active_catalog(
                final_catalog_path=sources["final_catalog"],
                catalog_disposition_path=sources["disposition"],
                deployment_font_face_manifest_path=sources["font_manifest"],
                deployment_render_bank_manifest_path=sources["render_manifest"],
                asset_root=sources["asset_root"],
                output_path=sources["output"],
                deployment_candidate_order=("font-b", "font-b"),
            )

    def test_active_catalog_rejects_pending_or_deployment_failure(self) -> None:
        for action in ("pending_full22_utility_audit", "deployment_failure"):
            with self.subTest(action=action):
                sources = write_active_catalog_sources(
                    self.fixture.root / f"active-{action}"
                )
                disposition = json.loads(
                    sources["disposition"].read_text(encoding="utf-8")
                )
                disposition.pop("record_sha256")
                disposition["entries"][0].update(
                    {
                        "action": action,
                        "active_release_eligible": False,
                        "all_unrenderable": action == "deployment_failure",
                        "terminal": False,
                    }
                )
                disposition = RUNTIME.seal_record(disposition)
                write_json(sources["disposition"], disposition)
                final_catalog = json.loads(
                    sources["final_catalog"].read_text(encoding="utf-8")
                )
                final_catalog.pop("record_sha256")
                final_catalog["catalog_disposition_record_sha256"] = disposition[
                    "record_sha256"
                ]
                write_json(sources["final_catalog"], RUNTIME.seal_record(final_catalog))

                with self.assertRaisesRegex(
                    RUNTIME.RuntimeArtifactError,
                    "pending, failed, or not release-eligible",
                ):
                    self.build_active_catalog(sources)

    def test_active_catalog_generation_hashes_actual_font_asset_bytes(self) -> None:
        sources = write_active_catalog_sources(self.fixture.root / "active-tamper")
        (sources["asset_root"] / "assets" / "font-b.ttf").write_bytes(b"tampered")

        with self.assertRaisesRegex(
            RUNTIME.RuntimeArtifactError, "font face asset hash/size mismatch"
        ):
            self.build_active_catalog(sources)

    def test_builds_minimal_ready_bundle_without_row_level_data(self) -> None:
        result = self.fixture.build()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(
            {path.name for path in self.fixture.output.iterdir()},
            {
                RUNTIME.MARKER_FILE,
                RUNTIME.ACTIVE_CATALOG_FILE,
                RUNTIME.CONTRACT_FILE,
                RUNTIME.ENCODER_FILE,
                RUNTIME.RANKER_FILE,
                RUNTIME.PROTOTYPE_FILE,
            },
        )
        contract = json.loads(
            (self.fixture.output / RUNTIME.CONTRACT_FILE).read_text(encoding="utf-8")
        )
        active_catalog = json.loads(
            self.fixture.active_catalog.read_text(encoding="utf-8")
        )
        self.assertEqual(
            contract["catalog"]["catalog_version"],
            active_catalog["catalog_version"],
        )
        self.assertEqual(
            contract["deployment"]["fallback_policy"]["semantic_bootstrap"],
            "forbidden",
        )
        self.assertFalse(
            contract["test_data_boundary"]["row_level_predictions_packaged"]
        )

    def test_tampered_runtime_asset_fails_closed(self) -> None:
        self.fixture.build()
        (self.fixture.output / RUNTIME.PROTOTYPE_FILE).write_bytes(b"tampered")
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "hash mismatch"):
            RUNTIME.validate_runtime_artifact(
                output_dir=self.fixture.output,
            )

    def test_runtime_catalog_version_mismatch_fails_closed(self) -> None:
        self.fixture.build()
        contract_path = self.fixture.output / RUNTIME.CONTRACT_FILE
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract.pop("record_sha256")
        contract["catalog"]["catalog_version"] = "stale-active-catalog"
        write_json(contract_path, RUNTIME.seal_record(contract))
        marker_path = self.fixture.output / RUNTIME.MARKER_FILE
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["artifacts"][RUNTIME.CONTRACT_FILE] = digest(contract_path)
        write_json(marker_path, marker)

        with self.assertRaisesRegex(
            RUNTIME.RuntimeArtifactError, "active-catalog binding"
        ):
            RUNTIME.validate_runtime_artifact(output_dir=self.fixture.output)

    def test_candidate_reordering_is_rejected(self) -> None:
        self.fixture.reseal(
            self.fixture.parity,
            lambda value: value.update(
                {
                    "candidate_ids": ["font-b", "font-a"],
                    "candidate_ids_sha256": RUNTIME._ordered_values_sha256(
                        ("font-b", "font-a")
                    ),
                }
            ),
        )
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "candidate order"):
            self.fixture.build()

    def test_conversion_cannot_touch_frozen_test_rows(self) -> None:
        self.fixture.reseal(
            self.fixture.parity,
            lambda value: value["reference_parity"].update(
                {"frozen_test_rows_used": 1}
            ),
        )
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "frozen test"):
            self.fixture.build()

    def test_runtime_policy_forbids_semantic_bootstrap(self) -> None:
        self.fixture.reseal(
            self.fixture.policy,
            lambda value: value["fallback"].update(
                {"semantic_bootstrap": "shadow_suggestion"}
            ),
        )
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "silent heuristic"):
            self.fixture.build()

    def test_release_metric_below_threshold_is_rejected(self) -> None:
        self.fixture.reseal(
            self.fixture.release,
            lambda value: value["metrics"].update(
                {"p1_variant_role_macro_acceptable_at_1": 0.5}
            ),
        )
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "failed threshold"):
            self.fixture.build()

    def test_release_manifest_must_equal_the_upstream_frozen_manifest(self) -> None:
        self.fixture.reseal(
            self.fixture.release,
            lambda value: value["test_data_boundary"].update(
                {"test_manifest_sha256": "c" * 64}
            ),
        )
        with self.assertRaisesRegex(
            RUNTIME.RuntimeArtifactError, "frozen-test manifest"
        ):
            self.fixture.build()

    def test_staging_validation_failure_never_publishes_output(self) -> None:
        with mock.patch.object(
            RUNTIME,
            "_validate_runtime_artifact",
            side_effect=RUNTIME.RuntimeArtifactError("staging invalid"),
        ):
            with self.assertRaisesRegex(
                RUNTIME.RuntimeArtifactError, "staging invalid"
            ):
                self.fixture.build()
        self.assertFalse(self.fixture.output.exists())

    def test_post_publish_failure_restores_the_previous_owned_bundle(self) -> None:
        self.fixture.build()
        previous_contract = (self.fixture.output / RUNTIME.CONTRACT_FILE).read_bytes()
        staging = self.fixture.root / "replacement-staging"
        staging.mkdir()
        (staging / "invalid.txt").write_text("invalid", encoding="utf-8")

        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "post publish"):
            RUNTIME._commit_managed_directory(
                staging,
                self.fixture.output,
                validate_published=mock.Mock(
                    side_effect=RUNTIME.RuntimeArtifactError("post publish invalid")
                ),
            )

        self.assertEqual(
            (self.fixture.output / RUNTIME.CONTRACT_FILE).read_bytes(),
            previous_contract,
        )

    def test_active_catalog_is_required_and_cli_cannot_override_its_count(
        self,
    ) -> None:
        parser = RUNTIME.build_parser()
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    [
                        "preflight",
                        "--trainer-output",
                        str(self.fixture.trainer),
                        "--expected-candidate-count",
                        "2",
                    ]
                )

    def test_active_catalog_exact_order_is_the_trainer_authority(self) -> None:
        active = json.loads(self.fixture.active_catalog.read_text(encoding="utf-8"))
        active.pop("record_sha256")
        active["candidate_ids"].reverse()
        active["candidates"].reverse()
        active["candidate_order_sha256"] = RUNTIME._ordered_values_sha256(
            active["candidate_ids"]
        )
        write_json(self.fixture.active_catalog, RUNTIME.seal_record(active))

        with self.assertRaisesRegex(
            RUNTIME.RuntimeArtifactError, "candidate ids/order"
        ):
            RUNTIME.preflight_trainer_output(
                trainer_output=self.fixture.trainer,
                active_catalog_path=self.fixture.active_catalog,
            )

    def test_nonproduction_trainer_is_not_deployable(self) -> None:
        self.assertEqual(
            RUNTIME.preflight_trainer_output(
                trainer_output=self.fixture.trainer,
                active_catalog_path=self.fixture.active_catalog,
            )["candidate_count"],
            2,
        )
        contract_path = self.fixture.trainer / "model-contract.json"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract.pop("record_sha256")
        contract["ordinary_regression_safety"][
            "baseline_status"
        ] = "non_production_safety_baseline"
        write_json(contract_path, RUNTIME.seal_record(contract))
        report_path = self.fixture.trainer / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report.pop("record_sha256")
        report["model_contract_sha256"] = digest(contract_path)
        write_json(report_path, RUNTIME.seal_record(report))
        marker_path = self.fixture.trainer / RUNTIME.TRAINER_MARKER
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["artifacts"]["model-contract.json"] = digest(contract_path)
        marker["artifacts"]["report.json"] = digest(report_path)
        write_json(marker_path, marker)
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "non-production"):
            RUNTIME._load_training_bundle(
                self.fixture.trainer,
                expected_candidate_ids=self.fixture.candidate_ids,
            )

    def test_unowned_existing_output_is_never_replaced(self) -> None:
        self.fixture.output.mkdir()
        (self.fixture.output / "user-file.txt").write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "exists"):
            self.fixture.build()
        self.assertEqual(
            (self.fixture.output / "user-file.txt").read_text(encoding="utf-8"),
            "keep",
        )


if __name__ == "__main__":
    unittest.main()
