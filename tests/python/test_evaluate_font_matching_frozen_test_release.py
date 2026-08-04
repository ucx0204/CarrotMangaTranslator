from __future__ import annotations

import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str, path: Path):
    specification = importlib.util.spec_from_file_location(name, path)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


RELEASE = load_script(
    "evaluate_font_matching_frozen_test_release_tested",
    SCRIPTS / "evaluate_font_matching_frozen_test_release.py",
)
RUNTIME = load_script(
    "runtime_artifact_release_consumer_tested",
    SCRIPTS / "build_font_matching_runtime_artifact.py",
)


SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64
SHA_D = "d" * 64


class FakeCorpus:
    def __init__(
        self,
        *,
        candidate_ids=("font-a", "font-b"),
        font_catalog_sha256=SHA_D,
    ) -> None:
        self.candidate_ids = candidate_ids
        self.font_catalog_sha256 = font_catalog_sha256
        self._test = (SimpleNamespace(sample_id="test-a"),)

    def examples_for_split(self, split: str):
        return self._test if split == "test" else ()


def fake_prediction_manifest_inputs():
    runtime = SimpleNamespace(
        asset_validation_report_sha256=None,
        corpus=FakeCorpus(),
        export=SimpleNamespace(manifest_sha256=SHA_A),
        render_bank=SimpleNamespace(manifest_sha256=SHA_B),
        resolver=SimpleNamespace(registry_sha256=SHA_C),
    )
    cache = SimpleNamespace(manifest_sha256=SHA_D)
    training = {
        "checkpoint_sha256": SHA_A,
        "contract_sha256": SHA_B,
        "frozen_test_manifest_sha256": SHA_C,
    }
    scan_rows = (
        {
            "sample_id": "test-a",
            "split": "test",
            "training_sample_record_sha256": SHA_A,
            "views": {name: {"source_pixel_sha256": SHA_B} for name in RELEASE.trainer.VIEW_NAMES},
        },
    )
    execution = {
        "encoder_device": "cpu",
        "encoder_precision": "fp32",
        "image_batch_size": 8,
        "inference_batch_size": 16,
        "ranker_device": "cpu",
    }
    return runtime, cache, training, scan_rows, execution


def release_metrics(value: float = 0.9):
    return {name: value for name in RELEASE.RELEASE_METRICS}


def validated_prediction_fixture():
    corpus = FakeCorpus()
    runtime = SimpleNamespace(corpus=corpus)
    training = {
        "checkpoint_sha256": SHA_A,
        "contract": {
            "calibration": {"none_threshold": 0.5},
            "inputs": {"frozen_test_manifest_sha256": SHA_B},
        },
        "contract_sha256": SHA_C,
        "frozen_test_manifest_sha256": SHA_B,
    }
    return {
        "export": object(),
        "manifest": {"record_sha256": SHA_D},
        "manifest_sha256": SHA_A,
        "prediction_set": SimpleNamespace(path_sha256=SHA_C),
        "runtime": runtime,
        "training": training,
    }


class FrozenTestPredictionContractTests(unittest.TestCase):
    def test_evaluator_targets_use_exact_trainer_audit_projection(self) -> None:
        candidate_ids = ("font-a", "font-b")

        def target(sample_id: str):
            return SimpleNamespace(
                candidate_ids=candidate_ids,
                listwise_record_sha256=SHA_B,
                sample_id=sample_id,
                sample_record_sha256=SHA_A,
                split="test",
                work_id="work-test",
            )

        eligible = target("test-eligible")
        excluded = target("test-audit-excluded")
        export = RELEASE.evaluator.ExportData(
            manifest_sha256=SHA_A,
            font_catalog_sha256=SHA_B,
            targets={
                eligible.sample_id: eligible,
                excluded.sample_id: excluded,
            },
            candidate_ids=candidate_ids,
            work_split={"work-test": "test"},
            input_hashes={},
        )
        example = SimpleNamespace(
            listwise_record_sha256=SHA_B,
            sample_id=eligible.sample_id,
            sample_record_sha256=SHA_A,
            split="test",
            work_id="work-test",
        )
        corpus = SimpleNamespace(
            candidate_ids=candidate_ids,
            examples_by_id={eligible.sample_id: example},
            examples_for_split=lambda split: (example,) if split == "test" else (),
            font_signal_audit=SimpleNamespace(
                excluded_sample_ids=frozenset({excluded.sample_id})
            ),
        )

        projected = RELEASE.project_evaluator_export_to_audit_eligible_corpus(
            export=export, corpus=corpus
        )
        self.assertEqual(set(projected.targets), {eligible.sample_id})
        self.assertEqual(projected.manifest_sha256, export.manifest_sha256)

        corpus.font_signal_audit.excluded_sample_ids = frozenset()
        with self.assertRaisesRegex(
            RELEASE.FrozenTestReleaseError, "omitted without audit exclusion"
        ):
            RELEASE.project_evaluator_export_to_audit_eligible_corpus(
                export=export, corpus=corpus
            )

    def test_manifest_binds_vocabulary_model_catalog_and_test_pixels(self) -> None:
        runtime, cache, training, scan_rows, execution = (
            fake_prediction_manifest_inputs()
        )
        expected = RELEASE.build_prediction_manifest(
            runtime=runtime,
            cache=cache,
            training=training,
            scan_rows=scan_rows,
            execution=execution,
            predictions_sha256=SHA_D,
            prediction_count=1,
        )
        mutations = []
        reordered_runtime = copy.copy(runtime)
        reordered_runtime.corpus = FakeCorpus(candidate_ids=("font-b", "font-a"))
        mutations.append((reordered_runtime, cache, training, scan_rows))
        catalog_runtime = copy.copy(runtime)
        catalog_runtime.corpus = FakeCorpus(font_catalog_sha256=SHA_A)
        mutations.append((catalog_runtime, cache, training, scan_rows))
        changed_training = {**training, "checkpoint_sha256": SHA_D}
        mutations.append((runtime, cache, changed_training, scan_rows))
        changed_scan = copy.deepcopy(scan_rows)
        changed_scan[0]["views"]["raw_224"]["source_pixel_sha256"] = SHA_C
        mutations.append((runtime, cache, training, changed_scan))
        for changed_runtime, changed_cache, changed_training, changed_rows in mutations:
            actual = RELEASE.build_prediction_manifest(
                runtime=changed_runtime,
                cache=changed_cache,
                training=changed_training,
                scan_rows=changed_rows,
                execution=execution,
                predictions_sha256=SHA_D,
                prediction_count=1,
            )
            with self.assertRaisesRegex(
                RELEASE.FrozenTestReleaseError, "binding drifted"
            ):
                RELEASE.validate_prediction_manifest_binding(
                    actual, expected=expected
                )

    def test_owned_prediction_directory_rejects_row_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "frozen-predictions"
            root.mkdir()
            prediction = root / RELEASE.PREDICTION_FILE
            manifest_path = root / RELEASE.PREDICTION_MANIFEST
            prediction.write_bytes(b'{"sample_id":"test-a"}\n')
            manifest_path.write_bytes(
                RELEASE.json_bytes(
                    RELEASE.seal_record(
                        {
                            "record_type": RELEASE.PREDICTION_RECORD_TYPE,
                            "schema_version": RELEASE.PREDICTION_SCHEMA,
                        }
                    )
                )
            )
            marker = {
                "managed_files": {
                    RELEASE.PREDICTION_FILE: RELEASE.sha256_file(prediction),
                    RELEASE.PREDICTION_MANIFEST: RELEASE.sha256_file(manifest_path),
                },
                "owner": RELEASE.PREDICTION_OWNER,
                "safe_replace": True,
                "schema_version": RELEASE.PREDICTION_SCHEMA,
            }
            (root / RELEASE.PREDICTION_MARKER).write_bytes(
                RELEASE.json_bytes(marker)
            )
            RELEASE.load_prediction_directory(root)
            prediction.write_bytes(b'{"sample_id":"tampered"}\n')
            with self.assertRaisesRegex(
                RELEASE.FrozenTestReleaseError, "hash mismatch"
            ):
                RELEASE.load_prediction_directory(root)


class FrozenTestReleaseRecordTests(unittest.TestCase):
    def test_release_is_aggregate_only_and_runtime_consumer_compatible(self) -> None:
        validated = validated_prediction_fixture()
        thresholds = release_metrics(0.8)
        with mock.patch.object(
            RELEASE,
            "compute_release_metrics",
            return_value=(
                release_metrics(0.9),
                {
                    "evaluated_row_count": 24,
                    "local_override_count": 4,
                    "none_p0_p1_count": 12,
                    "ordinary_p2_count": 12,
                    "p1_variant_role_count": 3,
                    "p1_variant_row_count": 8,
                },
            ),
        ):
            record = RELEASE.build_release_record(
                validated_predictions=validated, thresholds=thresholds
            )
        RELEASE.validate_release_record_shape(record)
        rendered = RELEASE.canonical_json(record)
        self.assertNotIn("test-a", rendered)
        self.assertNotIn('"sample_id"', rendered)
        self.assertNotIn('"ranked_candidate_ids"', rendered)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "release.json"
            path.write_bytes(RELEASE.json_bytes(record))
            training = {
                "candidate_ids": list(validated["runtime"].corpus.candidate_ids),
                "checkpoint_sha256": SHA_A,
                "contract": {
                    "inputs": {"frozen_test_manifest_sha256": SHA_B}
                },
                "contract_sha256": SHA_C,
            }
            self.assertEqual(
                RUNTIME._load_release_evaluation(path, training=training), record
            )

    def test_resealed_source_drift_leakage_and_failed_gate_are_rejected(self) -> None:
        validated = validated_prediction_fixture()
        with mock.patch.object(
            RELEASE,
            "compute_release_metrics",
            return_value=(
                release_metrics(0.9),
                {
                    "evaluated_row_count": 12,
                    "local_override_count": 2,
                    "none_p0_p1_count": 6,
                    "ordinary_p2_count": 6,
                    "p1_variant_role_count": 2,
                    "p1_variant_row_count": 4,
                },
            ),
        ):
            record = RELEASE.build_release_record(
                validated_predictions=validated, thresholds=release_metrics(0.8)
            )
        leaked = copy.deepcopy(record)
        leaked["evaluation_provenance"]["sample_id"] = "secret-test-row"
        leaked = RELEASE.seal_record(leaked)
        with self.assertRaisesRegex(
            RELEASE.FrozenTestReleaseError, "row-level test data leaked"
        ):
            RELEASE.validate_release_record_shape(leaked)

        failed = copy.deepcopy(record)
        failed["thresholds"]["overall_acceptable_at_1"] = 0.95
        failed["gate"] = {
            "failed_checks": ["overall_acceptable_at_1"],
            "passed": False,
        }
        failed = RELEASE.seal_record(failed)
        with self.assertRaisesRegex(RELEASE.FrozenTestReleaseError, "did not pass"):
            RELEASE.validate_release_record_shape(failed)

        drifted = copy.deepcopy(record)
        drifted["source"]["checkpoint_sha256"] = SHA_D
        drifted = RELEASE.seal_record(drifted)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "release.json"
            path.write_bytes(RELEASE.json_bytes(drifted))
            training = {
                "candidate_ids": list(validated["runtime"].corpus.candidate_ids),
                "checkpoint_sha256": SHA_A,
                "contract": {
                    "inputs": {"frozen_test_manifest_sha256": SHA_B}
                },
                "contract_sha256": SHA_C,
            }
            with self.assertRaisesRegex(
                RUNTIME.RuntimeArtifactError, "source binding failed"
            ):
                RUNTIME._load_release_evaluation(path, training=training)


if __name__ == "__main__":
    unittest.main()
