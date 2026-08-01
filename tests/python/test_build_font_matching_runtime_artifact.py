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
        self.candidate_ids = ("font-a", "font-b")
        self.frozen_test_manifest_sha = hashlib.sha256(
            b"fixture-frozen-test-manifest"
        ).hexdigest()
        self.feature_dim = 4
        self.hidden_dim = 3
        self.prototype_count = 3
        self._write_trainer()
        self._write_runtime_inputs()

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
                trainer_output=self.trainer,
                encoder_onnx=self.encoder,
                ranker_onnx=self.ranker,
                prototype_features=self.prototype,
                encoder_source_weights=self.encoder_weights,
                conversion_report=self.parity,
                release_evaluation=self.release,
                policy_path=self.policy,
                output_dir=self.output,
                expected_candidate_ids=self.candidate_ids,
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

    def test_builds_minimal_ready_bundle_without_row_level_data(self) -> None:
        result = self.fixture.build()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(
            {path.name for path in self.fixture.output.iterdir()},
            {
                RUNTIME.MARKER_FILE,
                RUNTIME.CONTRACT_FILE,
                RUNTIME.ENCODER_FILE,
                RUNTIME.RANKER_FILE,
                RUNTIME.PROTOTYPE_FILE,
            },
        )
        contract = json.loads(
            (self.fixture.output / RUNTIME.CONTRACT_FILE).read_text(encoding="utf-8")
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

    def test_production_candidate_order_is_fixed_and_cli_cannot_override_it(
        self,
    ) -> None:
        self.assertEqual(len(RUNTIME.PRODUCTION_CANDIDATE_IDS), 22)
        self.assertEqual(
            RUNTIME._ordered_values_sha256(RUNTIME.PRODUCTION_CANDIDATE_IDS),
            RUNTIME.PRODUCTION_CANDIDATE_ORDER_SHA256,
        )
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

    def test_nonproduction_or_wrong_candidate_trainer_is_not_deployable(self) -> None:
        with self.assertRaisesRegex(RUNTIME.RuntimeArtifactError, "authoritative"):
            RUNTIME.preflight_trainer_output(
                trainer_output=self.fixture.trainer,
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
